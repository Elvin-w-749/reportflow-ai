'use strict'

/**
 * 后端持久化层（SQLite 存储）
 *
 * - 单文件 SQLite 数据库（WAL 模式），目录可通过 DATA_DIR 环境变量覆盖
 * - 分析任务表使用 SQLite 事务/lease；通用业务集合仍是进程内快照
 * - ACID 事务：所有写操作在事务内完成，防止半写损坏
 * - 首次启动自动从旧 db.json 迁移数据
 * - SIGINT/SIGTERM/beforeExit 时强制同步落盘，确保 PM2 优雅重启数据不丢
 *
 * 当前必须以单实例 PM2 fork 运行；通用集合迁移为行级存储前禁止 cluster。
 */

const fs = require('fs')
const path = require('path')
const Database = require('better-sqlite3')
const { isProductionRuntime } = require('../utils/env')
const { sanitizeAnalysisFailureDiagnostic } = require('../utils/analysisFailureDiagnostic')
const {
	SUPPORT_REF_RE,
	TRACE_ID_RE,
	EVENT_CONTRACT_VERSION,
	createSupportRef,
	createTraceId,
	normalizeTerminalCode,
	terminalCodeDefinition,
	normalizeProgressStage,
	currentRuntimeSnapshot,
	unknownRuntimeSnapshot,
	createTerminalEventSnapshot,
	parseTrustedTerminalEventRow
} = require('../utils/trustedAnalysisEvent')

const DATA_DIR = process.env.DATA_DIR
	? path.resolve(process.env.DATA_DIR)
	: path.join(__dirname, '..', '..', 'data')
const JSON_FILE = path.join(DATA_DIR, 'db.json')
const SQLITE_FILE = path.join(DATA_DIR, 'db.sqlite')
// 保留向后兼容引用（旧代码可能读取 DATA_FILE 用作提示）
const DATA_FILE = SQLITE_FILE

function defaultState() {
	return {
		users: [],
		reports: [],
		advisorContacts: [],
		debtExecutionRecords: [],
		bankCards: [],
		contracts: [],
		feedbacks: [],
		disputes: [],
		messages: [],
		messageActionReceipts: [],
		pushBindings: {},
		smsCodes: {},
		optimizePlans: [
			{
				id: 'plan_1',
				title: '按时还款优化',
				description: '设置还款日历与自动扣款，减少逾期风险。',
				expected: '连续 6 个月无逾期，评分可回升',
				difficulty: '简单',
				difficultyKey: 'easy',
				emoji: '✅',
				steps: ['设置提醒', '优先处理临近到期账单']
			}
		]
	}
}

let state = null
let saveTimer = null
let dirty = false
let _writing = false // 写锁：防止定时器 + persistSync 并发 writeSync
let db = null
let storageWriteFault = null
let productionEmptyStoreBootstrapPending = false

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'binary')
const CRITICAL_COLLECTIONS = Object.freeze(['users', 'reports'])
const STORAGE_STARTUP_FAILURE_CODES = new Set([
	'STORE_BOOTSTRAP_REQUIRED',
	'STORE_DATABASE_INVALID',
	'STORE_MIGRATION_FAILED'
])

function emptyStoreBootstrapRequested() {
	return String(process.env.ALLOW_EMPTY_STORE_BOOTSTRAP || '').trim().toLowerCase() === 'true'
}

function storageStartupError(code, message, cause = null) {
	const error = new Error(message)
	error.code = code
	if (cause) error.cause = cause
	return error
}

function storageFailureReason(error) {
	return STORAGE_STARTUP_FAILURE_CODES.has(String(error && error.code || ''))
		? error.code
		: 'STORE_READ_FAILED'
}

function assertProductionStoreSource(jsonExists, sqliteExists) {
	if (!isProductionRuntime()) return false
	if (!jsonExists && !sqliteExists) {
		if (emptyStoreBootstrapRequested()) return true
		throw storageStartupError(
			'STORE_BOOTSTRAP_REQUIRED',
			'production data store is missing; empty bootstrap requires explicit authorization'
		)
	}
	if (!sqliteExists) return false

	try {
		const stat = fs.statSync(SQLITE_FILE)
		if (!stat.isFile() || stat.size < SQLITE_HEADER.length) {
			throw new Error('SQLite file is empty or not a regular file')
		}
		const handle = fs.openSync(SQLITE_FILE, 'r')
		try {
			const header = Buffer.alloc(SQLITE_HEADER.length)
			const bytesRead = fs.readSync(handle, header, 0, header.length, 0)
			if (bytesRead !== header.length || !header.equals(SQLITE_HEADER)) {
				throw new Error('SQLite header is invalid')
			}
		} finally {
			fs.closeSync(handle)
		}
	} catch (error) {
		throw storageStartupError(
			'STORE_DATABASE_INVALID',
			'production SQLite database is not a valid existing database',
			error
		)
	}
	return false
}

// ── 内存索引：消除 O(n) 用户查找 ──
let _userByPhone = null // Map<phone, user>
let _userById = null    // Map<uid, user>

function _buildUserIndexes() {
	_userByPhone = new Map()
	_userById = new Map()
	const users = state ? state.users : null
	if (Array.isArray(users)) {
		for (const u of users) {
			if (u && u.phone) _userByPhone.set(u.phone, u)
			if (u && u.id) _userById.set(u.id, u)
		}
	}
}

function _ensureUserIndexes() {
	if (!_userByPhone || !_userById) _buildUserIndexes()
	return { byPhone: _userByPhone, byId: _userById }
}

function _invalidateUserIndexes() {
	_userByPhone = null
	_userById = null
}

function ensureDir() {
	if (!fs.existsSync(DATA_DIR)) {
		fs.mkdirSync(DATA_DIR, { recursive: true })
	}
}

function nextUniqueSupportRef(database) {
	for (let attempt = 0; attempt < 16; attempt += 1) {
		const value = createSupportRef()
		const collision = database.prepare(
			`SELECT 1 FROM analysis_jobs WHERE support_ref = ?
			 UNION ALL
			 SELECT 1 FROM analysis_support_bindings WHERE support_ref = ?
			 UNION ALL
			 SELECT 1 FROM analysis_terminal_events WHERE support_ref = ? LIMIT 1`
		).get(value, value, value)
		if (!collision) return value
	}
	throw Object.assign(new Error('unable to allocate a unique support reference'), {
		code: 'ANALYSIS_SUPPORT_REF_UNAVAILABLE'
	})
}

function nextUniqueTraceId(database) {
	for (let attempt = 0; attempt < 16; attempt += 1) {
		const value = createTraceId()
		const collision = database.prepare(
			`SELECT 1 FROM analysis_jobs WHERE trace_id = ?
			 UNION ALL
			 SELECT 1 FROM analysis_support_bindings WHERE trace_id = ?
			 UNION ALL
			 SELECT 1 FROM analysis_terminal_events WHERE trace_id = ? LIMIT 1`
		).get(value, value, value)
		if (!collision) return value
	}
	throw Object.assign(new Error('unable to allocate a unique analysis trace'), {
		code: 'ANALYSIS_TRACE_ID_UNAVAILABLE'
	})
}

function canonicalStoredTime(value) {
	if (typeof value !== 'string' || !value.trim()) {
		throw Object.assign(new Error('legacy analysis terminal time is unavailable'), {
			code: 'STORE_MIGRATION_FAILED'
		})
	}
	try { return new Date(value).toISOString() } catch (_) {
		throw Object.assign(new Error('legacy analysis terminal time is invalid'), {
			code: 'STORE_MIGRATION_FAILED'
		})
	}
}

function bindSupportIdentity(database, scopeHmac, analysisKey, supportRef, traceId, createdAt) {
	if (
		!/^sh_[a-f0-9]{64}$/.test(String(scopeHmac || '')) ||
		typeof analysisKey !== 'string' || !analysisKey ||
		!SUPPORT_REF_RE.test(String(supportRef || '')) ||
		!TRACE_ID_RE.test(String(traceId || ''))
	) {
		throw Object.assign(new Error('analysis support binding is invalid'), {
			code: 'TRUSTED_ANALYSIS_EVENT_INVALID'
		})
	}
	const existing = database.prepare(
		`SELECT support_ref, trace_id, scope_hmac, analysis_key FROM analysis_support_bindings
		 WHERE support_ref = ? OR trace_id = ?`
	).all(supportRef, traceId)
	if (existing.length) {
		if (
			existing.length !== 1 || existing[0].support_ref !== supportRef ||
			existing[0].trace_id !== traceId || existing[0].scope_hmac !== scopeHmac ||
			existing[0].analysis_key !== analysisKey
		) {
			throw Object.assign(new Error('analysis support binding conflicts with another scope'), {
				code: 'TRUSTED_ANALYSIS_EVENT_CONFLICT'
			})
		}
		return false
	}
	const historicalTerminal = database.prepare(
		`SELECT 1 FROM analysis_terminal_events
		 WHERE support_ref = ? OR trace_id = ? LIMIT 1`
	).get(supportRef, traceId)
	if (historicalTerminal) {
		throw Object.assign(new Error('historical terminal identity cannot be rebound'), {
			code: 'TRUSTED_ANALYSIS_EVENT_CONFLICT'
		})
	}
	database.prepare(
		`INSERT INTO analysis_support_bindings
		 (support_ref, trace_id, scope_hmac, analysis_key, created_at)
		 VALUES (?, ?, ?, ?, ?)`
	).run(supportRef, traceId, scopeHmac, analysisKey, canonicalStoredTime(createdAt))
	return true
}

function assertAnalysisSupportBindingSchema(database) {
	const fail = () => {
		throw Object.assign(new Error('analysis support binding schema is invalid'), {
			code: 'STORE_MIGRATION_FAILED'
		})
	}
	const columns = new Map(
		database.prepare('PRAGMA table_info(analysis_support_bindings)').all().map((row) => [row.name, row])
	)
	for (const name of ['support_ref', 'trace_id', 'scope_hmac', 'analysis_key', 'created_at']) {
		if (!columns.has(name) || columns.get(name).notnull !== 1) fail()
	}
	if (columns.get('support_ref').pk !== 1) fail()
	const indexes = database.prepare('PRAGMA index_list(analysis_support_bindings)').all()
	const traceUnique = indexes.some((index) => (
		index.unique === 1 &&
		JSON.stringify(database.prepare(`PRAGMA index_info('${index.name}')`).all().map((row) => row.name)) ===
			JSON.stringify(['trace_id'])
	))
	if (!traceUnique) fail()
	const scopeColumns = database.prepare("PRAGMA index_info('idx_analysis_support_scope')").all().map((row) => row.name)
	if (JSON.stringify(scopeColumns) !== JSON.stringify(['scope_hmac', 'analysis_key', 'created_at'])) fail()
	const triggers = new Map(database.prepare(
		`SELECT name, sql FROM sqlite_master WHERE type = 'trigger'
		 AND name IN (
		  'trg_analysis_support_no_update',
		  'trg_analysis_delivery_binding_insert',
		  'trg_analysis_delivery_binding_update'
		)`
	).all().map((row) => [row.name, String(row.sql || '')]))
	if (!/RAISE\s*\(\s*ABORT/i.test(triggers.get('trg_analysis_support_no_update') || '')) fail()
	for (const name of ['trg_analysis_delivery_binding_insert', 'trg_analysis_delivery_binding_update']) {
		const sql = triggers.get(name) || ''
		if (!/analysis_support_bindings/i.test(sql) || !/NEW\.analysis_key/i.test(sql) || !/NEW\.scope_hmac/i.test(sql)) fail()
	}
	if (!/UPDATE\s+OF[\s\S]*analysis_key/i.test(triggers.get('trg_analysis_delivery_binding_update') || '')) fail()
}

function assertAnalysisTerminalSchema(database) {
	const fail = () => {
		throw Object.assign(new Error('analysis terminal event schema is invalid'), {
			code: 'STORE_MIGRATION_FAILED'
		})
	}
	const columns = new Map(
		database.prepare('PRAGMA table_info(analysis_terminal_events)').all().map((row) => [row.name, row])
	)
	for (const name of [
		'schema_version', 'support_ref', 'trace_id', 'status', 'stage',
		'diagnostic_json', 'release_json', 'versions_json', 'server_time', 'created_at'
	]) if (!columns.has(name) || columns.get(name).notnull !== 1) fail()
	if (columns.get('id')?.pk !== 1) fail()
	for (const [name, expected] of [
		['idx_analysis_terminal_support', ['support_ref', 'id']],
		['idx_analysis_terminal_trace', ['trace_id', 'id']]
	]) {
		const actual = database.prepare(`PRAGMA index_info('${name}')`).all().map((row) => row.name)
		if (JSON.stringify(actual) !== JSON.stringify(expected)) fail()
	}
	const triggers = new Map(database.prepare(
		`SELECT name, sql FROM sqlite_master WHERE type = 'trigger'
		 AND tbl_name = 'analysis_terminal_events'`
	).all().map((row) => [row.name, String(row.sql || '')]))
	if (!/BEFORE\s+UPDATE[\s\S]*RAISE\s*\(\s*ABORT/i.test(triggers.get('trg_analysis_terminal_no_update') || '')) fail()
	if (!/BEFORE\s+DELETE[\s\S]*RAISE\s*\(\s*ABORT/i.test(triggers.get('trg_analysis_terminal_no_delete') || '')) fail()
	const binding = triggers.get('trg_analysis_terminal_ref_trace_binding') || ''
	if (!/support_ref/i.test(binding) || !/trace_id/i.test(binding) || !/RAISE\s*\(\s*ABORT/i.test(binding)) fail()
	const transition = triggers.get('trg_analysis_terminal_transition') || ''
	if (
		!/CACHE_INTEGRITY_FAILED/.test(transition) || !/e\.status\s*=\s*'failed'/.test(transition) ||
		!/RAISE\s*\(\s*ABORT/i.test(transition)
	) fail()
}

function insertTrustedTerminalSnapshot(database, input, runtime = currentRuntimeSnapshot()) {
	const event = createTerminalEventSnapshot(input, runtime)
	const existingRow = database.prepare(
		`SELECT schema_version, support_ref, trace_id, status, code, error_class,
		        stage, retryable, safe_message_key, diagnostic_json, release_json,
		        versions_json, server_time
		 FROM analysis_terminal_events
		 WHERE support_ref = ? ORDER BY id DESC LIMIT 1`
	).get(event.supportRef)
	if (existingRow) {
		const existing = parseTrustedTerminalEventRow(existingRow)
		if (!existing) {
			throw Object.assign(new Error('persisted trusted terminal event is invalid'), {
				code: 'TRUSTED_ANALYSIS_EVENT_INVALID'
			})
		}
		if (existing.traceId !== event.traceId) {
			throw Object.assign(new Error('support reference is bound to another trace'), {
				code: 'TRUSTED_ANALYSIS_EVENT_CONFLICT'
			})
		}
		// Repeated calls never mutate the first terminal snapshot. In particular,
		// a coordinator failure followed by the task catch path must not create a
		// second event just because a later diagnostic object differs.
		if (
			existing.status === event.status &&
			existing.code === event.code &&
			existing.errorClass === event.errorClass &&
			existing.stage === event.stage &&
			existing.retryable === event.retryable &&
			existing.safeMessageKey === event.safeMessageKey
		) return existing
		if (existing.status === 'failed') {
			throw Object.assign(new Error('failed terminal snapshot cannot transition'), {
				code: 'TRUSTED_ANALYSIS_EVENT_CONFLICT'
			})
		}
		const allowedCacheInvalidation =
			existing.status === 'succeeded' &&
			event.status === 'failed' &&
			event.code === 'CACHE_INTEGRITY_FAILED' &&
			event.errorClass === 'internal_permanent' &&
			event.stage === 'cache'
		if (!allowedCacheInvalidation) {
			throw Object.assign(new Error('trusted terminal transition is invalid'), {
				code: 'TRUSTED_ANALYSIS_EVENT_CONFLICT'
			})
		}
	}
	const reverseBinding = database.prepare(
		`SELECT support_ref FROM analysis_terminal_events
		 WHERE trace_id = ? ORDER BY id DESC LIMIT 1`
	).get(event.traceId)
	if (reverseBinding && reverseBinding.support_ref !== event.supportRef) {
		throw Object.assign(new Error('trace id is bound to another support reference'), {
			code: 'TRUSTED_ANALYSIS_EVENT_CONFLICT'
		})
	}
	database.prepare(
		`INSERT INTO analysis_terminal_events
		 (schema_version, support_ref, trace_id, status, code, error_class, stage,
		  retryable, safe_message_key, diagnostic_json, release_json, versions_json,
		  server_time, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		event.schemaVersion,
		event.supportRef,
		event.traceId,
		event.status,
		event.code,
		event.errorClass,
		event.stage,
		event.retryable === null ? null : event.retryable ? 1 : 0,
		event.safeMessageKey,
		JSON.stringify(event.diagnostic),
		JSON.stringify(event.release),
		JSON.stringify(event.versions),
		event.serverTime,
		new Date().toISOString()
	)
	return event
}

function recordTrustedTerminalForJob(database, scopeHmac, analysisKey, terminal, runtime) {
	const job = database.prepare(
		`SELECT support_ref, trace_id FROM analysis_jobs
		 WHERE scope_hmac = ? AND analysis_key = ?`
	).get(scopeHmac, analysisKey)
	if (!job || !SUPPORT_REF_RE.test(String(job.support_ref || '')) || !TRACE_ID_RE.test(String(job.trace_id || ''))) {
		throw Object.assign(new Error('analysis attempt is missing trusted identifiers'), {
			code: 'TRUSTED_ANALYSIS_EVENT_INVALID'
		})
	}
	const bound = database.prepare(
		`SELECT 1 FROM analysis_support_bindings
		 WHERE support_ref = ? AND trace_id = ? AND scope_hmac = ? AND analysis_key = ?`
	).get(job.support_ref, job.trace_id, scopeHmac, analysisKey)
	if (!bound) {
		throw Object.assign(new Error('analysis attempt support binding is missing'), {
			code: 'TRUSTED_ANALYSIS_EVENT_INVALID'
		})
	}
	return insertTrustedTerminalSnapshot(database, {
		...terminal,
		supportRef: job.support_ref,
		traceId: job.trace_id
	}, runtime)
}

// ── SQLite 连接管理 ──

function getDb() {
	if (db) return db

	// 首次迁移：db.json 存在但 db.sqlite 不存在 → 自动导入
	const jsonExists = fs.existsSync(JSON_FILE)
	const sqliteExists = fs.existsSync(SQLITE_FILE)
	// A production path typo or an unmounted persistent volume must not be
	// converted into a healthy empty database. Existing SQLite/JSON stores may
	// migrate normally; a genuinely new production store needs a one-time,
	// explicit ALLOW_EMPTY_STORE_BOOTSTRAP=true authorization.
	const productionBootstrapAuthorized = assertProductionStoreSource(jsonExists, sqliteExists)
	ensureDir()

	db = new Database(SQLITE_FILE)
	try {
	db.pragma('journal_mode = WAL')
	db.pragma('busy_timeout = 5000')
	db.pragma('foreign_keys = ON')
	db.exec(`CREATE TABLE IF NOT EXISTS collections (
		name TEXT PRIMARY KEY,
		data TEXT NOT NULL
	)`)
	db.exec(`CREATE TABLE IF NOT EXISTS monitor_snapshots (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		timestamp TEXT NOT NULL,
		source TEXT NOT NULL DEFAULT 'dev-terminal',
		data TEXT NOT NULL,
		db_mtime TEXT,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`)
	db.exec(`CREATE INDEX IF NOT EXISTS idx_monitor_snapshots_timestamp ON monitor_snapshots(timestamp)`)
	db.exec(`CREATE INDEX IF NOT EXISTS idx_monitor_snapshots_source ON monitor_snapshots(source)`)
	db.exec(`CREATE TABLE IF NOT EXISTS monitor_report_details (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		report_id TEXT NOT NULL,
		user_id TEXT,
		snapshot_id INTEGER,
		timestamp TEXT NOT NULL,
		score REAL,
		risk_level TEXT,
		risk_tags TEXT,
		has_overdue INTEGER DEFAULT 0,
		total_debt REAL,
		card_usage_rate REAL,
		query_6m INTEGER,
		four_dimensions TEXT,
		risk_hits TEXT,
		debt_summary TEXT,
		ai_assessment TEXT,
		overdue TEXT,
		queries TEXT,
		coverage TEXT,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		FOREIGN KEY (snapshot_id) REFERENCES monitor_snapshots(id) ON DELETE CASCADE
	)`)
	db.exec(`CREATE INDEX IF NOT EXISTS idx_mrd_report_id ON monitor_report_details(report_id)`)
	db.exec(`CREATE INDEX IF NOT EXISTS idx_mrd_user_id ON monitor_report_details(user_id)`)
	db.exec(`CREATE INDEX IF NOT EXISTS idx_mrd_timestamp ON monitor_report_details(timestamp)`)
	db.exec(`CREATE INDEX IF NOT EXISTS idx_mrd_score ON monitor_report_details(score)`)
	db.exec(`CREATE INDEX IF NOT EXISTS idx_mrd_risk_level ON monitor_report_details(risk_level)`)
	db.exec(`CREATE INDEX IF NOT EXISTS idx_mrd_snapshot_id ON monitor_report_details(snapshot_id)`)
	db.exec(`CREATE INDEX IF NOT EXISTS idx_mrd_has_overdue ON monitor_report_details(has_overdue)`)
	db.exec(`CREATE INDEX IF NOT EXISTS idx_mrd_query_6m ON monitor_report_details(query_6m)`)
	db.exec(`CREATE INDEX IF NOT EXISTS idx_mrd_card_usage ON monitor_report_details(card_usage_rate)`)
	// 分析缓存只保存加密后的 canonical 结果；键和 scope 都是 HMAC，
	// 不保存 PDF/OCR 原文、裸文件哈希、用户 ID、手机号或身份证号。
	db.exec(`CREATE TABLE IF NOT EXISTS analysis_results (
		scope_hmac TEXT NOT NULL,
		analysis_key TEXT NOT NULL,
		encrypted_payload TEXT NOT NULL,
		result_hash TEXT NOT NULL,
		versions_json TEXT NOT NULL,
		created_at TEXT NOT NULL,
		expires_at TEXT NOT NULL,
		PRIMARY KEY (scope_hmac, analysis_key)
	)`)
	db.exec(`CREATE INDEX IF NOT EXISTS idx_analysis_results_expires
		ON analysis_results(expires_at)`)
	// processing lease 用于 PM2/多进程 single-flight。完成结果与 job 状态在同一事务提交，
	// 不会出现 job=succeeded 但没有可复用结果的中间状态。
	db.exec(`CREATE TABLE IF NOT EXISTS analysis_jobs (
		scope_hmac TEXT NOT NULL,
		analysis_key TEXT NOT NULL,
		status TEXT NOT NULL,
		lease_owner TEXT,
		lease_expires_at TEXT,
		attempt_count INTEGER NOT NULL DEFAULT 0,
		error_code TEXT,
		error_class TEXT,
		error_stage TEXT,
		diagnostic_json TEXT,
		support_ref TEXT,
		trace_id TEXT,
		job_id TEXT,
		input_kind TEXT,
		input_path TEXT,
		input_size INTEGER,
		scope_ciphertext TEXT,
		document_id TEXT,
		stage TEXT,
		progress INTEGER NOT NULL DEFAULT 0,
		created_at TEXT,
		finished_at TEXT,
		acknowledged_at TEXT,
		updated_at TEXT NOT NULL,
		PRIMARY KEY (scope_hmac, analysis_key)
	)`)
	// SQLite does not support `ADD COLUMN IF NOT EXISTS` on all deployed
	// versions. Upgrade legacy databases by inspecting the table first. Extra
	// columns are backward-compatible with the previous coordinator.
	// Serialize schema upgrades. A PRAGMA-then-ALTER loop outside a write
	// transaction lets two starting processes both observe a missing column and
	// race into duplicate-column failures.
	const upgradeAnalysisJobs = db.transaction(() => {
		const analysisJobColumns = new Map(
			db.prepare('PRAGMA table_info(analysis_jobs)').all().map((row) => [row.name, row])
		)
		const ensureAnalysisJobColumn = (name, definition) => {
			if (!analysisJobColumns.has(name)) {
				db.exec(`ALTER TABLE analysis_jobs ADD COLUMN ${name} ${definition}`)
				analysisJobColumns.set(name, { name })
			}
		}
		ensureAnalysisJobColumn('job_id', 'TEXT')
		ensureAnalysisJobColumn('input_kind', 'TEXT')
		ensureAnalysisJobColumn('input_path', 'TEXT')
		ensureAnalysisJobColumn('input_size', 'INTEGER')
		ensureAnalysisJobColumn('scope_ciphertext', 'TEXT')
		ensureAnalysisJobColumn('document_id', 'TEXT')
		ensureAnalysisJobColumn('stage', 'TEXT')
		ensureAnalysisJobColumn('progress', 'INTEGER NOT NULL DEFAULT 0')
		ensureAnalysisJobColumn('created_at', 'TEXT')
		ensureAnalysisJobColumn('finished_at', 'TEXT')
		ensureAnalysisJobColumn('acknowledged_at', 'TEXT')
		ensureAnalysisJobColumn('error_class', 'TEXT')
		ensureAnalysisJobColumn('error_stage', 'TEXT')
		ensureAnalysisJobColumn('diagnostic_json', 'TEXT')
		ensureAnalysisJobColumn('support_ref', 'TEXT')
		ensureAnalysisJobColumn('trace_id', 'TEXT')
	})
	upgradeAnalysisJobs.immediate()
	db.exec(`CREATE INDEX IF NOT EXISTS idx_analysis_jobs_lease
		ON analysis_jobs(status, lease_expires_at)`)
	db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_jobs_public_id
		ON analysis_jobs(job_id) WHERE job_id IS NOT NULL`)
	db.exec(`CREATE INDEX IF NOT EXISTS idx_analysis_jobs_scope_updated
		ON analysis_jobs(scope_hmac, updated_at DESC)`)
	db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_jobs_support_ref
		ON analysis_jobs(support_ref) WHERE support_ref IS NOT NULL`)
	db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_jobs_trace_id
		ON analysis_jobs(trace_id) WHERE trace_id IS NOT NULL`)
	db.exec(`CREATE TABLE IF NOT EXISTS analysis_support_bindings (
		support_ref TEXT NOT NULL PRIMARY KEY,
		trace_id TEXT NOT NULL UNIQUE,
		scope_hmac TEXT NOT NULL,
		analysis_key TEXT NOT NULL,
		created_at TEXT NOT NULL
	)`)
	db.exec(`CREATE INDEX IF NOT EXISTS idx_analysis_support_scope
		ON analysis_support_bindings(scope_hmac, analysis_key, created_at)`)
	db.exec(`CREATE TRIGGER IF NOT EXISTS trg_analysis_support_no_update
		BEFORE UPDATE ON analysis_support_bindings
		BEGIN SELECT RAISE(ABORT, 'analysis support bindings are immutable'); END`)
	// Public task delivery is separate from the single-flight execution row.
	// Each upload/retry receives its own acknowledgement identity, so an older
	// page cannot acknowledge (and hide) a newer response-lost delivery.
	db.exec(`CREATE TABLE IF NOT EXISTS analysis_job_deliveries (
		scope_hmac TEXT NOT NULL,
		job_id TEXT NOT NULL PRIMARY KEY,
		analysis_key TEXT NOT NULL,
		support_ref TEXT,
		trace_id TEXT,
		created_at TEXT NOT NULL,
		acknowledged_at TEXT,
		updated_at TEXT NOT NULL,
		FOREIGN KEY (scope_hmac, analysis_key)
			REFERENCES analysis_jobs(scope_hmac, analysis_key) ON DELETE CASCADE
	)`)
	db.exec(`CREATE INDEX IF NOT EXISTS idx_analysis_deliveries_scope_updated
		ON analysis_job_deliveries(scope_hmac, updated_at DESC)`)
	db.exec(`CREATE INDEX IF NOT EXISTS idx_analysis_deliveries_analysis
		ON analysis_job_deliveries(scope_hmac, analysis_key)`)
	const upgradeAnalysisDeliveries = db.transaction(() => {
		const columns = new Map(
			db.prepare('PRAGMA table_info(analysis_job_deliveries)').all().map((row) => [row.name, row])
		)
		if (!columns.has('support_ref')) db.exec('ALTER TABLE analysis_job_deliveries ADD COLUMN support_ref TEXT')
		if (!columns.has('trace_id')) db.exec('ALTER TABLE analysis_job_deliveries ADD COLUMN trace_id TEXT')
	})
	upgradeAnalysisDeliveries.immediate()
	db.exec(`CREATE INDEX IF NOT EXISTS idx_analysis_deliveries_support_ref
		ON analysis_job_deliveries(support_ref)`)
	db.exec(`CREATE INDEX IF NOT EXISTS idx_analysis_deliveries_trace_id
		ON analysis_job_deliveries(trace_id)`)
	db.exec(`CREATE TRIGGER IF NOT EXISTS trg_analysis_delivery_binding_insert
		BEFORE INSERT ON analysis_job_deliveries
		WHEN NEW.support_ref IS NOT NULL OR NEW.trace_id IS NOT NULL
		BEGIN
		 SELECT CASE WHEN NOT EXISTS (
		  SELECT 1 FROM analysis_support_bindings b
		  WHERE b.support_ref = NEW.support_ref AND b.trace_id = NEW.trace_id
		    AND b.scope_hmac = NEW.scope_hmac AND b.analysis_key = NEW.analysis_key
		 ) THEN RAISE(ABORT, 'analysis delivery binding conflict') END;
		 SELECT CASE WHEN EXISTS (
		  SELECT 1 FROM analysis_job_deliveries d
		  WHERE d.support_ref = NEW.support_ref AND d.trace_id = NEW.trace_id
		    AND d.scope_hmac = NEW.scope_hmac AND d.analysis_key <> NEW.analysis_key
		 ) THEN RAISE(ABORT, 'analysis delivery attempt conflict') END;
		END`)
	db.exec(`CREATE TRIGGER IF NOT EXISTS trg_analysis_delivery_binding_update
		BEFORE UPDATE OF support_ref, trace_id, scope_hmac, analysis_key ON analysis_job_deliveries
		WHEN NEW.support_ref IS NOT NULL OR NEW.trace_id IS NOT NULL
		BEGIN
		 SELECT CASE WHEN NOT EXISTS (
		  SELECT 1 FROM analysis_support_bindings b
		  WHERE b.support_ref = NEW.support_ref AND b.trace_id = NEW.trace_id
		    AND b.scope_hmac = NEW.scope_hmac AND b.analysis_key = NEW.analysis_key
		 ) THEN RAISE(ABORT, 'analysis delivery binding conflict') END;
		 SELECT CASE WHEN EXISTS (
		  SELECT 1 FROM analysis_job_deliveries d
		  WHERE d.rowid <> OLD.rowid
		    AND d.support_ref = NEW.support_ref AND d.trace_id = NEW.trace_id
		    AND d.scope_hmac = NEW.scope_hmac AND d.analysis_key <> NEW.analysis_key
		 ) THEN RAISE(ABORT, 'analysis delivery attempt conflict') END;
		 END`)
	assertAnalysisSupportBindingSchema(db)
	db.exec(`CREATE TABLE IF NOT EXISTS analysis_terminal_events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		schema_version TEXT NOT NULL,
		support_ref TEXT NOT NULL,
		trace_id TEXT NOT NULL,
		status TEXT NOT NULL,
		code TEXT,
		error_class TEXT,
		stage TEXT NOT NULL,
		retryable INTEGER,
		safe_message_key TEXT,
		diagnostic_json TEXT NOT NULL,
		release_json TEXT NOT NULL,
		versions_json TEXT NOT NULL,
		server_time TEXT NOT NULL,
		created_at TEXT NOT NULL
	)`)
	db.exec(`CREATE INDEX IF NOT EXISTS idx_analysis_terminal_support
		ON analysis_terminal_events(support_ref, id DESC)`)
	db.exec(`CREATE INDEX IF NOT EXISTS idx_analysis_terminal_trace
		ON analysis_terminal_events(trace_id, id DESC)`)
	// Trusted terminal snapshots are append-only. A later cache-integrity
	// failure may append a second terminal snapshot for the same attempt, but
	// ACK, cleanup and account deletion cannot rewrite or erase prior evidence.
	db.exec(`CREATE TRIGGER IF NOT EXISTS trg_analysis_terminal_no_update
		BEFORE UPDATE ON analysis_terminal_events
		BEGIN SELECT RAISE(ABORT, 'analysis terminal events are immutable'); END`)
	db.exec(`CREATE TRIGGER IF NOT EXISTS trg_analysis_terminal_no_delete
		BEFORE DELETE ON analysis_terminal_events
		BEGIN SELECT RAISE(ABORT, 'analysis terminal events are immutable'); END`)
	db.exec(`CREATE TRIGGER IF NOT EXISTS trg_analysis_terminal_ref_trace_binding
		BEFORE INSERT ON analysis_terminal_events
		WHEN EXISTS (
		 SELECT 1 FROM analysis_terminal_events e
		 WHERE (e.support_ref = NEW.support_ref AND e.trace_id <> NEW.trace_id)
		    OR (e.trace_id = NEW.trace_id AND e.support_ref <> NEW.support_ref)
		)
		BEGIN SELECT RAISE(ABORT, 'analysis support/trace binding conflict'); END`)
	db.exec(`CREATE TRIGGER IF NOT EXISTS trg_analysis_terminal_transition
		BEFORE INSERT ON analysis_terminal_events
		WHEN EXISTS (
		 SELECT 1 FROM analysis_terminal_events e
		 WHERE e.id = (
		  SELECT latest.id FROM analysis_terminal_events latest
		  WHERE latest.support_ref = NEW.support_ref ORDER BY latest.id DESC LIMIT 1
		 ) AND (
		  e.status = 'failed' OR
		  NOT (
		   e.status = 'succeeded' AND NEW.status = 'failed'
		   AND NEW.code = 'CACHE_INTEGRITY_FAILED'
		   AND NEW.error_class = 'internal_permanent'
		   AND NEW.stage = 'cache'
		  )
		 )
		)
		BEGIN SELECT RAISE(ABORT, 'analysis terminal transition conflict'); END`)
	assertAnalysisTerminalSchema(db)
	// Backfill the one legacy public id per execution row. INSERT OR IGNORE keeps
	// startup idempotent and preserves any already-separated deliveries.
	db.exec(`INSERT OR IGNORE INTO analysis_job_deliveries
		(scope_hmac, job_id, analysis_key, created_at, acknowledged_at, updated_at)
		SELECT scope_hmac, job_id, analysis_key,
		       COALESCE(created_at, updated_at), acknowledged_at, updated_at
		FROM analysis_jobs WHERE job_id IS NOT NULL`)
	const backfillTrustedAnalysisIdentity = db.transaction(() => {
		const jobs = db.prepare(
			`SELECT scope_hmac, analysis_key, status, error_code, error_class,
			        error_stage, diagnostic_json, created_at, finished_at, updated_at,
			        support_ref, trace_id
			 FROM analysis_jobs`
		).all()
		for (const row of jobs) {
			if (!['queued', 'processing', 'succeeded', 'failed'].includes(String(row.status || ''))) {
				throw Object.assign(new Error('analysis job status is invalid during migration'), {
					code: 'STORE_MIGRATION_FAILED'
				})
			}
			let supportRef = SUPPORT_REF_RE.test(String(row.support_ref || ''))
				? row.support_ref
				: nextUniqueSupportRef(db)
			let traceId = TRACE_ID_RE.test(String(row.trace_id || ''))
				? row.trace_id
				: nextUniqueTraceId(db)
			const existingTerminal = SUPPORT_REF_RE.test(String(row.support_ref || ''))
				? parseTrustedTerminalEventRow(trustedTerminalEventRow(db, row.support_ref))
				: null
			if (existingTerminal) {
				const hasUnboundDelivery = Boolean(db.prepare(
					`SELECT 1 FROM analysis_job_deliveries
					 WHERE scope_hmac = ? AND analysis_key = ?
					   AND support_ref IS NULL AND trace_id IS NULL LIMIT 1`
				).get(row.scope_hmac, row.analysis_key))
				let sameTerminal = false
				const createdAfterTerminal = row.created_at
					? canonicalStoredTime(row.created_at) > existingTerminal.serverTime
					: false
				if (row.status === 'succeeded') sameTerminal = existingTerminal.status === 'succeeded'
				if (row.status === 'failed') {
					const failure = terminalCodeDefinition(row.error_code, row.error_class)
					sameTerminal =
						existingTerminal.status === 'failed' &&
						existingTerminal.code === failure.code &&
						existingTerminal.errorClass === failure.errorClass
					if (
						existingTerminal.status === 'succeeded' &&
						failure.code === 'CACHE_INTEGRITY_FAILED' && !createdAfterTerminal
					) sameTerminal = true
				}
				if (
					!sameTerminal || createdAfterTerminal ||
					(existingTerminal.status === 'failed' && hasUnboundDelivery)
				) {
					supportRef = nextUniqueSupportRef(db)
					traceId = nextUniqueTraceId(db)
				}
			}
			const normalizedFailure = row.status === 'failed'
				? terminalCodeDefinition(row.error_code, row.error_class)
				: null
			let parsedDiagnostic = { version: 1 }
			try { parsedDiagnostic = JSON.parse(String(row.diagnostic_json || '{"version":1}')) } catch (_) {}
			const safeDiagnostic = sanitizeAnalysisFailureDiagnostic(parsedDiagnostic)
			const normalizedStage = row.status === 'failed'
				? 'failed'
				: row.status === 'succeeded'
					? 'succeeded'
					: row.status === 'queued' ? 'queued' : normalizeProgressStage(row.stage)
			db.prepare(
				`UPDATE analysis_jobs
				 SET support_ref = ?, trace_id = ?, error_code = ?, error_class = ?,
				     error_stage = ?, diagnostic_json = ?, stage = ?
				 WHERE scope_hmac = ? AND analysis_key = ?`
			).run(
				supportRef,
				traceId,
				normalizedFailure ? normalizedFailure.code : null,
				normalizedFailure ? normalizedFailure.errorClass : null,
				normalizedFailure ? normalizedFailure.stage : null,
				normalizedFailure ? JSON.stringify(safeDiagnostic) : null,
				normalizedStage,
				row.scope_hmac,
				row.analysis_key
			)
			bindSupportIdentity(
				db,
				row.scope_hmac,
				row.analysis_key,
				supportRef,
				traceId,
				row.created_at || row.updated_at
			)
			const deliveries = db.prepare(
				`SELECT rowid AS delivery_rowid, support_ref, trace_id, created_at
				 FROM analysis_job_deliveries
				 WHERE scope_hmac = ? AND analysis_key = ?`
			).all(row.scope_hmac, row.analysis_key)
			for (const delivery of deliveries) {
				const deliveryCreatedAt = canonicalStoredTime(delivery.created_at)
				let deliverySupportRef = delivery.support_ref
				let deliveryTraceId = delivery.trace_id
				if (deliverySupportRef === null && deliveryTraceId === null) {
					deliverySupportRef = supportRef
					deliveryTraceId = traceId
				} else if (deliverySupportRef === null && TRACE_ID_RE.test(String(deliveryTraceId || ''))) {
					const historical = db.prepare(
						`SELECT support_ref FROM analysis_terminal_events
						 WHERE trace_id = ? ORDER BY id DESC LIMIT 1`
					).get(deliveryTraceId)
					deliverySupportRef = deliveryTraceId === traceId
						? supportRef
						: historical && historical.support_ref
				} else if (deliveryTraceId === null && SUPPORT_REF_RE.test(String(deliverySupportRef || ''))) {
					const historical = parseTrustedTerminalEventRow(
						trustedTerminalEventRow(db, deliverySupportRef)
					)
					deliveryTraceId = deliverySupportRef === supportRef
						? traceId
						: historical && historical.traceId
				}
				if (
					!SUPPORT_REF_RE.test(String(deliverySupportRef || '')) ||
					!TRACE_ID_RE.test(String(deliveryTraceId || ''))
				) {
					throw Object.assign(new Error('analysis delivery trusted identity is incomplete'), {
						code: 'STORE_MIGRATION_FAILED'
					})
				}
				bindSupportIdentity(
					db,
					row.scope_hmac,
					row.analysis_key,
					deliverySupportRef,
					deliveryTraceId,
					deliveryCreatedAt
				)
				const attemptConflict = db.prepare(
					`SELECT 1 FROM analysis_job_deliveries
					 WHERE support_ref = ? AND trace_id = ? AND scope_hmac = ?
					   AND analysis_key <> ? LIMIT 1`
				).get(
					deliverySupportRef,
					deliveryTraceId,
					row.scope_hmac,
					row.analysis_key
				)
				if (attemptConflict) {
					throw Object.assign(new Error('analysis delivery is bound to another attempt'), {
						code: 'STORE_MIGRATION_FAILED'
					})
				}
				if (
					deliverySupportRef !== delivery.support_ref ||
					deliveryTraceId !== delivery.trace_id ||
					deliveryCreatedAt !== delivery.created_at
				) {
					db.prepare(
						`UPDATE analysis_job_deliveries
						 SET support_ref = ?, trace_id = ?, created_at = ?
						 WHERE rowid = ?`
					).run(deliverySupportRef, deliveryTraceId, deliveryCreatedAt, delivery.delivery_rowid)
				}
				if (deliverySupportRef === supportRef && deliveryTraceId === traceId) continue
				const historical = parseTrustedTerminalEventRow(
					trustedTerminalEventRow(db, deliverySupportRef)
				)
				if (!historical || historical.traceId !== deliveryTraceId) {
					throw Object.assign(new Error('analysis delivery trusted identity is inconsistent'), {
						code: 'STORE_MIGRATION_FAILED'
					})
				}
			}

			if (!['succeeded', 'failed'].includes(String(row.status || ''))) continue
			recordTrustedTerminalForJob(db, row.scope_hmac, row.analysis_key, {
				status: row.status,
				code: normalizedFailure ? normalizedFailure.code : null,
				errorClass: normalizedFailure ? normalizedFailure.errorClass : null,
				stage: normalizedFailure ? normalizedFailure.stage : 'succeeded',
				diagnostic: normalizedFailure ? safeDiagnostic : null,
				serverTime: canonicalStoredTime(row.finished_at || row.updated_at)
			}, unknownRuntimeSnapshot())
		}
		db.exec(`UPDATE analysis_job_deliveries AS older
		 SET acknowledged_at = (
		  SELECT MAX(newer.acknowledged_at) FROM analysis_job_deliveries newer
		  WHERE newer.scope_hmac = older.scope_hmac
		    AND newer.analysis_key = older.analysis_key
		    AND newer.support_ref = older.support_ref
		    AND newer.trace_id = older.trace_id
		    AND (newer.created_at > older.created_at OR
		         (newer.created_at = older.created_at AND newer.rowid >= older.rowid))
		    AND newer.acknowledged_at IS NOT NULL
		 ), updated_at = COALESCE((
		  SELECT MAX(newer.acknowledged_at) FROM analysis_job_deliveries newer
		  WHERE newer.scope_hmac = older.scope_hmac
		    AND newer.analysis_key = older.analysis_key
		    AND newer.support_ref = older.support_ref
		    AND newer.trace_id = older.trace_id
		    AND (newer.created_at > older.created_at OR
		         (newer.created_at = older.created_at AND newer.rowid >= older.rowid))
		    AND newer.acknowledged_at IS NOT NULL
		 ), older.updated_at)
		 WHERE older.acknowledged_at IS NULL AND EXISTS (
		  SELECT 1 FROM analysis_job_deliveries newer
		  WHERE newer.scope_hmac = older.scope_hmac
		    AND newer.analysis_key = older.analysis_key
		    AND newer.support_ref = older.support_ref
		    AND newer.trace_id = older.trace_id
		    AND (newer.created_at > older.created_at OR
		         (newer.created_at = older.created_at AND newer.rowid >= older.rowid))
		    AND newer.acknowledged_at IS NOT NULL
		 )`)
		const incompleteDelivery = db.prepare(
			`SELECT 1 FROM analysis_job_deliveries
			 WHERE support_ref IS NULL OR trace_id IS NULL LIMIT 1`
		).get()
		if (incompleteDelivery) {
			throw Object.assign(new Error('analysis delivery migration is incomplete'), {
				code: 'STORE_MIGRATION_FAILED'
			})
		}
	})
	backfillTrustedAnalysisIdentity.immediate()

	if (jsonExists && !sqliteExists) {
		migrateFromJson()
	}

	productionEmptyStoreBootstrapPending = productionBootstrapAuthorized
	return db
	} catch (error) {
		// Never retain a half-initialized handle: a later readiness probe must
		// retry the full initialization sequence, not report a cached false-ready.
		try { db.close() } catch (_) {}
		db = null
		productionEmptyStoreBootstrapPending = false
		throw error
	}
}

function migrateFromJson() {
	try {
		const raw = fs.readFileSync(JSON_FILE, 'utf8')
		const parsed = raw && raw.trim() ? JSON.parse(raw) : {}
		const insert = db.prepare('INSERT OR REPLACE INTO collections (name, data) VALUES (?, ?)')
		const txn = db.transaction(() => {
			for (const [key, value] of Object.entries(parsed)) {
				insert.run(key, JSON.stringify(value))
			}
		})
		txn()
		console.error('[store] 已从 db.json 迁移数据到 SQLite')
	} catch (e) {
		console.error('[store] db.json 迁移失败，已停止业务读写：', e.message)
		throw storageStartupError('STORE_MIGRATION_FAILED', 'legacy JSON migration failed', e)
	}
}

// ── 数据加载 ──

function parseCollectionRows(rows) {
	const parsed = {}
	const expected = defaultState()
	for (const row of rows) {
		const value = JSON.parse(row.data)
		if (Object.prototype.hasOwnProperty.call(expected, row.name)) {
			const expectedArray = Array.isArray(expected[row.name])
			const validShape = expectedArray
				? Array.isArray(value)
				: value && typeof value === 'object' && !Array.isArray(value)
			if (!validShape) throw new TypeError(`invalid collection shape: ${row.name}`)
		}
		parsed[row.name] = value
	}
	if (isProductionRuntime()) {
		for (const name of CRITICAL_COLLECTIONS) {
			if (!Object.prototype.hasOwnProperty.call(parsed, name)) {
				throw storageStartupError(
					'STORE_BOOTSTRAP_REQUIRED',
					`production data store is missing critical collection: ${name}`
				)
			}
		}
	}
	return parsed
}

function load() {
	if (state) return state
	const database = getDb() // 确保 SQLite 已初始化（含可能的迁移）

	try {
		let rows = database.prepare('SELECT name, data FROM collections').all()
		if (rows.length > 0) {
			const parsed = parseCollectionRows(rows)
			state = Object.assign(defaultState(), parsed)
		} else {
			// 全新数据库：尝试从 JSON 文件兜底
			if (fs.existsSync(JSON_FILE)) {
				migrateFromJson()
				rows = database.prepare('SELECT name, data FROM collections').all()
				if (rows.length > 0) {
					const parsed = parseCollectionRows(rows)
					state = Object.assign(defaultState(), parsed)
					return state
				}
			}
			if (isProductionRuntime() && !productionEmptyStoreBootstrapPending) {
				throw storageStartupError(
					'STORE_BOOTSTRAP_REQUIRED',
					'production data store contains no business collections'
				)
			}
			state = defaultState()
			writeSync()
			productionEmptyStoreBootstrapPending = false
		}
	} catch (e) {
		// A read error is not the same as an empty database. Falling back to a new
		// in-memory state can later overwrite valid collections with empty arrays.
		// Keep state unset and fail closed so readiness/startup can surface the
		// storage fault without mutating the database.
		state = null
		const reason = storageFailureReason(e)
		const error = reason === 'STORE_READ_FAILED'
			? storageStartupError(reason, 'SQLite collections read failed', e)
			: e
		console.error('[store] SQLite 读取失败，已停止业务读写：', e.message)
		throw error
	}

	return state
}

// ── 持久化 ──

function writeSync() {
	if (!state) return
	if (_writing) return
	_writing = true
	try {
		const database = getDb()
		const insert = database.prepare('INSERT OR REPLACE INTO collections (name, data) VALUES (?, ?)')
		const txn = database.transaction(() => {
			for (const [key, value] of Object.entries(state)) {
				insert.run(key, JSON.stringify(value))
			}
		})
		txn()
		dirty = false
		storageWriteFault = null
	} catch (error) {
		storageWriteFault = 'STORE_WRITE_FAILED'
		throw error
	} finally {
		_writing = false
	}
}

function persist() {
	dirty = true
	_invalidateUserIndexes()
	if (saveTimer) return
	saveTimer = setTimeout(() => {
		saveTimer = null
		try {
			writeSync()
		} catch (e) {
			storageWriteFault = 'STORE_WRITE_FAILED'
			console.error('[store] 持久化失败：', e.message)
		}
	}, 200)
}

function flushSync(options = {}) {
	if (saveTimer) {
		clearTimeout(saveTimer)
		saveTimer = null
	}
	if (dirty && !_writing) {
		try {
			writeSync()
		} catch (e) {
			storageWriteFault = 'STORE_WRITE_FAILED'
			console.error('[store] 强制落盘失败：', e.message)
			if (options.throwOnError === true) throw e
		}
	}
}

// 关键写入：标记脏并立即同步落盘（绕过 200ms 防抖），用于账户创建/报告上传等高价值写。
function persistSync() {
	dirty = true
	_invalidateUserIndexes()
	return flushSync({ throwOnError: true })
}

function state_() {
	return load()
}

function get(key) {
	return load()[key]
}

function storageRuntimeStatus() {
	try {
		if (storageWriteFault) return { ready: false, mode: 'sqlite', reason: storageWriteFault }
		const database = getDb()
		// Readiness remains side-effect free for every existing store. The only
		// exception is an explicitly authorized, genuinely new production path:
		// consume that one-time bootstrap here so a health-first startup can create
		// and then validate the critical collections.
		if (productionEmptyStoreBootstrapPending) load()
		const rows = database.prepare('SELECT name, data FROM collections').all()
		// Readiness includes decodability. Silently skipping one damaged collection
		// can fabricate an empty users/reports array which is later persisted over
		// the original row.
		parseCollectionRows(rows)
		return { ready: true, mode: 'sqlite' }
	} catch (error) {
		return { ready: false, mode: 'sqlite', reason: storageFailureReason(error) }
	}
}

// ── 确定性分析缓存 / 跨进程 lease ──

function getAnalysisResult(scopeHmac, analysisKey) {
	const database = getDb()
	const now = new Date().toISOString()
	const row = database.prepare(
		`SELECT encrypted_payload, result_hash, versions_json, created_at, expires_at
		 FROM analysis_results
		 WHERE scope_hmac = ? AND analysis_key = ?`
	).get(scopeHmac, analysisKey)
	if (!row) return null
	if (row.expires_at <= now) {
		const removeExpired = database.transaction(() => {
			database.prepare(
				'DELETE FROM analysis_results WHERE scope_hmac = ? AND analysis_key = ? AND expires_at <= ?'
			).run(scopeHmac, analysisKey, now)
			database.prepare(
				'DELETE FROM analysis_jobs WHERE scope_hmac = ? AND analysis_key = ? AND status = ?'
			).run(scopeHmac, analysisKey, 'succeeded')
		})
		removeExpired.immediate()
		return null
	}
	return row
}

function getAnalysisJob(scopeHmac, analysisKey) {
	return getDb().prepare(
		`SELECT status, lease_owner, lease_expires_at, attempt_count, error_code,
		        error_class, error_stage, diagnostic_json, support_ref, trace_id,
		        job_id, document_id, input_kind, input_path, input_size, scope_ciphertext,
		        stage, progress, created_at, finished_at, acknowledged_at, updated_at
		 FROM analysis_jobs
		 WHERE scope_hmac = ? AND analysis_key = ?`
	).get(scopeHmac, analysisKey) || null
}

function enqueueAnalysisJob({
	scopeHmac,
	analysisKey,
	jobId,
	documentId,
	inputKind,
	inputPath,
	inputSize,
	scopeCiphertext
}) {
	const database = getDb()
	const tx = database.transaction(() => {
		const now = new Date().toISOString()
		const insertDelivery = (supportRef, traceId) => database.prepare(
			`INSERT INTO analysis_job_deliveries
			 (scope_hmac, job_id, analysis_key, support_ref, trace_id,
			  created_at, acknowledged_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`
		).run(scopeHmac, jobId, analysisKey, supportRef, traceId, now, now)
		const cached = database.prepare(
			`SELECT created_at FROM analysis_results
			 WHERE scope_hmac = ? AND analysis_key = ? AND expires_at > ?`
		).get(scopeHmac, analysisKey, now)
		const existing = database.prepare(
			`SELECT status, job_id, document_id, input_path, stage, progress, created_at,
			        finished_at, acknowledged_at, updated_at, support_ref, trace_id
			 FROM analysis_jobs WHERE scope_hmac = ? AND analysis_key = ?`
		).get(scopeHmac, analysisKey)

		if (cached) {
			const supportRef = existing ? existing.support_ref : nextUniqueSupportRef(database)
			const traceId = existing ? existing.trace_id : nextUniqueTraceId(database)
			if (!SUPPORT_REF_RE.test(String(supportRef || '')) || !TRACE_ID_RE.test(String(traceId || ''))) {
				throw Object.assign(new Error('cached analysis attempt has invalid trusted identifiers'), {
					code: 'TRUSTED_ANALYSIS_EVENT_INVALID'
				})
			}
			if (!existing) {
				database.prepare(
					`INSERT INTO analysis_jobs
					 (scope_hmac, analysis_key, status, lease_owner, lease_expires_at,
					  attempt_count, error_code, error_class, error_stage, diagnostic_json,
					  support_ref, trace_id, job_id, document_id, input_kind, input_path, input_size,
					  scope_ciphertext, stage, progress, created_at, finished_at,
					  acknowledged_at, updated_at)
					 VALUES (?, ?, 'succeeded', NULL, NULL, 0, NULL, NULL, NULL, NULL,
					         ?, ?, ?, ?, ?, NULL, ?, ?,
					         'succeeded', 100, ?, ?, NULL, ?)`
				).run(
					scopeHmac,
					analysisKey,
					supportRef,
					traceId,
					jobId,
					documentId,
					inputKind,
					Number(inputSize) || 0,
					scopeCiphertext,
					now,
					now,
					now
				)
			} else {
				database.prepare(
					`UPDATE analysis_jobs
					 SET status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
					     error_code = NULL, error_class = NULL, error_stage = NULL,
					     diagnostic_json = NULL, job_id = COALESCE(job_id, ?),
					     document_id = COALESCE(document_id, ?),
					     input_kind = COALESCE(input_kind, ?), input_path = NULL,
					     input_size = COALESCE(input_size, ?),
					     scope_ciphertext = COALESCE(scope_ciphertext, ?),
					     stage = 'succeeded', progress = 100,
					     created_at = COALESCE(created_at, ?),
					     finished_at = COALESCE(finished_at, ?), acknowledged_at = NULL,
					     updated_at = ?
					 WHERE scope_hmac = ? AND analysis_key = ?`
				).run(
					jobId,
					documentId,
					inputKind,
					Number(inputSize) || 0,
					scopeCiphertext,
					now,
					now,
					now,
					scopeHmac,
					analysisKey
				)
			}
			bindSupportIdentity(database, scopeHmac, analysisKey, supportRef, traceId, existing?.created_at || now)
			insertDelivery(supportRef, traceId)
			recordTrustedTerminalForJob(database, scopeHmac, analysisKey, {
				status: 'succeeded',
				code: null,
				errorClass: null,
				stage: 'succeeded',
				diagnostic: null,
				serverTime: canonicalStoredTime(
					existing && existing.finished_at ? existing.finished_at : cached.created_at
				)
			}, existing ? undefined : unknownRuntimeSnapshot())
			return {
				reused: true,
				cacheHit: true,
				publicJobId: jobId,
				replacedJobId: existing && existing.input_path ? existing.job_id : null,
				replacedInputPath: existing && existing.input_path
			}
		}

		if (existing && ['queued', 'processing'].includes(existing.status) && existing.job_id && existing.input_path) {
			if (!SUPPORT_REF_RE.test(String(existing.support_ref || '')) || !TRACE_ID_RE.test(String(existing.trace_id || ''))) {
				throw Object.assign(new Error('live analysis attempt has invalid trusted identifiers'), {
					code: 'TRUSTED_ANALYSIS_EVENT_INVALID'
				})
			}
			bindSupportIdentity(
				database,
				scopeHmac,
				analysisKey,
				existing.support_ref,
				existing.trace_id,
				existing.created_at || now
			)
			insertDelivery(existing.support_ref, existing.trace_id)
			return {
				reused: true,
				cacheHit: false,
				publicJobId: jobId,
				existingInputPath: existing.input_path || null
			}
		}

		if (!existing) {
			const supportRef = nextUniqueSupportRef(database)
			const traceId = nextUniqueTraceId(database)
			database.prepare(
				`INSERT INTO analysis_jobs
				 (scope_hmac, analysis_key, status, lease_owner, lease_expires_at,
				  attempt_count, error_code, error_class, error_stage, diagnostic_json,
				  support_ref, trace_id, job_id, document_id, input_kind, input_path, input_size,
				  scope_ciphertext, stage, progress, created_at, finished_at,
				  acknowledged_at, updated_at)
				 VALUES (?, ?, 'queued', NULL, NULL, 0, NULL, NULL, NULL, NULL,
				         ?, ?, ?, ?, ?, ?, ?, ?,
				         'queued', 5, ?, NULL, NULL, ?)`
			).run(
				scopeHmac,
				analysisKey,
				supportRef,
				traceId,
				jobId,
				documentId,
				inputKind,
				inputPath,
				Number(inputSize) || 0,
				scopeCiphertext,
				now,
				now
			)
			bindSupportIdentity(database, scopeHmac, analysisKey, supportRef, traceId, now)
			insertDelivery(supportRef, traceId)
		} else {
			// This is a new execution attempt (for example an explicit retry after a
			// failure), not another delivery of the same live/cached attempt. Close
			// older unacknowledged deliveries so they cannot reappear after the new
			// attempt is acknowledged.
			database.prepare(
				`UPDATE analysis_job_deliveries
				 SET acknowledged_at = COALESCE(acknowledged_at, ?), updated_at = ?
				 WHERE scope_hmac = ? AND analysis_key = ? AND acknowledged_at IS NULL`
			).run(now, now, scopeHmac, analysisKey)
			database.prepare(
				`UPDATE analysis_jobs
				 SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
				     attempt_count = 0, error_code = NULL, error_class = NULL,
				     error_stage = NULL, diagnostic_json = NULL,
				     support_ref = ?, trace_id = ?,
				     job_id = ?, document_id = ?, input_kind = ?,
				     input_path = ?, input_size = ?, scope_ciphertext = ?,
				     stage = 'queued', progress = 5, finished_at = NULL,
				     acknowledged_at = NULL, created_at = ?, updated_at = ?
				 WHERE scope_hmac = ? AND analysis_key = ?`
			).run(
				nextUniqueSupportRef(database),
				nextUniqueTraceId(database),
				jobId,
				documentId,
				inputKind,
				inputPath,
				Number(inputSize) || 0,
				scopeCiphertext,
				now,
				now,
				scopeHmac,
				analysisKey
			)
			const retried = database.prepare(
				`SELECT support_ref, trace_id FROM analysis_jobs
				 WHERE scope_hmac = ? AND analysis_key = ?`
			).get(scopeHmac, analysisKey)
			bindSupportIdentity(database, scopeHmac, analysisKey, retried.support_ref, retried.trace_id, now)
			insertDelivery(retried.support_ref, retried.trace_id)
		}
		return {
			reused: false,
			cacheHit: false,
			publicJobId: jobId,
			replacedJobId: existing && existing.input_path ? existing.job_id : null,
			replacedInputPath: existing && existing.input_path
		}
	})
	const outcome = tx.immediate()
	return { ...outcome, job: getAnalysisJobByPublicId(scopeHmac, outcome.publicJobId) }
}

function getAnalysisJobByPublicId(scopeHmac, jobId) {
	return getDb().prepare(
		`SELECT j.scope_hmac, j.analysis_key, j.status, j.error_code,
		        j.error_class, j.error_stage, j.diagnostic_json,
		        d.support_ref, d.trace_id, d.job_id,
		        j.support_ref AS current_support_ref, j.trace_id AS current_trace_id,
		        j.document_id, j.input_kind, j.input_path, j.input_size,
		        j.scope_ciphertext, j.stage, j.progress, j.attempt_count,
		        d.created_at, j.finished_at, d.acknowledged_at,
		        e.schema_version AS terminal_schema_version,
		        e.status AS terminal_status, e.code AS terminal_code,
		        e.error_class AS terminal_error_class, e.stage AS terminal_stage,
		        e.retryable AS terminal_retryable,
		        e.safe_message_key AS terminal_safe_message_key,
		        e.diagnostic_json AS terminal_diagnostic_json,
		        e.release_json AS terminal_release_json,
		        e.versions_json AS terminal_versions_json,
		        e.server_time AS terminal_server_time,
		        CASE WHEN d.updated_at > j.updated_at THEN d.updated_at ELSE j.updated_at END AS updated_at,
		        j.lease_owner, j.lease_expires_at
		 FROM analysis_job_deliveries d
		 JOIN analysis_jobs j
		   ON j.scope_hmac = d.scope_hmac AND j.analysis_key = d.analysis_key
		 LEFT JOIN analysis_terminal_events e ON e.id = (
		  SELECT latest.id FROM analysis_terminal_events latest
		  WHERE latest.support_ref = d.support_ref ORDER BY latest.id DESC LIMIT 1
		 )
		 WHERE d.scope_hmac = ? AND d.job_id = ?`
	).get(scopeHmac, jobId) || null
}

function getLatestPublicAnalysisJob(scopeHmac) {
	return getDb().prepare(
		`SELECT j.scope_hmac, j.analysis_key, j.status, j.error_code,
		        j.error_class, j.error_stage, j.diagnostic_json,
		        d.support_ref, d.trace_id, d.job_id,
		        j.support_ref AS current_support_ref, j.trace_id AS current_trace_id,
		        j.document_id, j.input_kind, j.input_path, j.input_size,
		        j.scope_ciphertext, j.stage, j.progress, j.attempt_count,
		        d.created_at, j.finished_at, d.acknowledged_at,
		        e.schema_version AS terminal_schema_version,
		        e.status AS terminal_status, e.code AS terminal_code,
		        e.error_class AS terminal_error_class, e.stage AS terminal_stage,
		        e.retryable AS terminal_retryable,
		        e.safe_message_key AS terminal_safe_message_key,
		        e.diagnostic_json AS terminal_diagnostic_json,
		        e.release_json AS terminal_release_json,
		        e.versions_json AS terminal_versions_json,
		        e.server_time AS terminal_server_time,
		        CASE WHEN d.updated_at > j.updated_at THEN d.updated_at ELSE j.updated_at END AS updated_at,
		        j.lease_owner, j.lease_expires_at
		 FROM analysis_job_deliveries d
		 JOIN analysis_jobs j
		   ON j.scope_hmac = d.scope_hmac AND j.analysis_key = d.analysis_key
		 LEFT JOIN analysis_terminal_events e ON e.id = (
		  SELECT latest.id FROM analysis_terminal_events latest
		  WHERE latest.support_ref = d.support_ref ORDER BY latest.id DESC LIMIT 1
		 )
		 WHERE d.scope_hmac = ? AND d.acknowledged_at IS NULL
		   AND NOT EXISTS (
		    SELECT 1 FROM analysis_job_deliveries newer
		    WHERE newer.scope_hmac = d.scope_hmac
		      AND newer.analysis_key = d.analysis_key
		      AND newer.support_ref = d.support_ref
		      AND newer.trace_id = d.trace_id
		      AND (newer.created_at > d.created_at OR
		           (newer.created_at = d.created_at AND newer.rowid >= d.rowid))
		      AND newer.acknowledged_at IS NOT NULL
		   )
		   AND j.status IN ('queued', 'processing', 'succeeded', 'failed')
		 ORDER BY d.rowid DESC LIMIT 1`
	).get(scopeHmac) || null
}

function trustedTerminalEventRow(database, supportRef) {
	return database.prepare(
		`SELECT schema_version, support_ref, trace_id, status, code, error_class,
		        stage, retryable, safe_message_key, diagnostic_json, release_json,
		        versions_json, server_time
		 FROM analysis_terminal_events
		 WHERE support_ref = ? ORDER BY id DESC LIMIT 1`
	).get(supportRef) || null
}

function getTrustedAnalysisEventBySupportRef(supportRef) {
	if (typeof supportRef !== 'string') return null
	const normalized = supportRef
	if (!SUPPORT_REF_RE.test(normalized)) return null
	return parseTrustedTerminalEventRow(trustedTerminalEventRow(getDb(), normalized))
}

function getScopedTrustedAnalysisEvent(scopeHmac, supportRef) {
	if (typeof scopeHmac !== 'string' || typeof supportRef !== 'string') return null
	const normalizedScope = scopeHmac
	const normalizedRef = supportRef
	if (!/^sh_[a-f0-9]{64}$/.test(normalizedScope) || !SUPPORT_REF_RE.test(normalizedRef)) return null
	const database = getDb()
	const owned = database.prepare(
		`SELECT 1 FROM analysis_support_bindings
		 WHERE scope_hmac = ? AND support_ref = ? LIMIT 1`
	).get(normalizedScope, normalizedRef)
	if (!owned) return null
	return parseTrustedTerminalEventRow(trustedTerminalEventRow(database, normalizedRef))
}

function listRecoverableAnalysisJobs(limit = 2) {
	const now = new Date().toISOString()
	const safeLimit = Math.min(16, Math.max(1, Math.trunc(Number(limit) || 2)))
	return getDb().prepare(
		`SELECT scope_hmac, analysis_key, status, error_code,
		        error_class, error_stage, diagnostic_json, support_ref, trace_id,
		        job_id, document_id, input_kind,
		        input_path, input_size, scope_ciphertext, stage, progress,
		        attempt_count, created_at, finished_at, acknowledged_at, updated_at,
		        lease_owner, lease_expires_at
		 FROM analysis_jobs
		 WHERE job_id IS NOT NULL AND input_path IS NOT NULL
		   AND (status = 'queued' OR (
		    status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
		   ))
		 ORDER BY updated_at ASC LIMIT ?`
	).all(now, safeLimit)
}

function listTerminalAnalysisInputs(limit = 16) {
	const safeLimit = Math.min(256, Math.max(1, Math.trunc(Number(limit) || 16)))
	return getDb().prepare(
		`SELECT scope_hmac, analysis_key, job_id, input_path
		 FROM analysis_jobs
		 WHERE input_path IS NOT NULL AND status IN ('succeeded', 'failed')
		 ORDER BY updated_at ASC LIMIT ?`
	).all(safeLimit)
}

function listAnalysisInputReferences() {
	return getDb().prepare(
		`SELECT job_id, input_path FROM analysis_jobs
		 WHERE job_id IS NOT NULL AND input_path IS NOT NULL`
	).all()
}

function updateAnalysisJobProgress(scopeHmac, analysisKey, leaseOwner, stage, progress) {
	const safeStage = normalizeProgressStage(stage)
	const safeProgress = Math.min(99, Math.max(0, Math.trunc(Number(progress) || 0)))
	const result = getDb().prepare(
		`UPDATE analysis_jobs
		 SET stage = ?, progress = MAX(progress, ?), updated_at = ?
		 WHERE scope_hmac = ? AND analysis_key = ?
		   AND status = 'processing' AND lease_owner = ?`
	).run(
		safeStage,
		safeProgress,
		new Date().toISOString(),
		scopeHmac,
		analysisKey,
		leaseOwner
	)
	return result.changes === 1
}

function clearAnalysisJobInput(scopeHmac, analysisKey, expectedPath) {
	const result = getDb().prepare(
		`UPDATE analysis_jobs SET input_path = NULL, updated_at = ?
		 WHERE scope_hmac = ? AND analysis_key = ? AND input_path = ?`
	).run(new Date().toISOString(), scopeHmac, analysisKey, expectedPath)
	return result.changes === 1
}

function acknowledgeAnalysisJob(scopeHmac, jobId) {
	const database = getDb()
	const tx = database.transaction(() => {
		const target = database.prepare(
			`SELECT rowid AS delivery_rowid, analysis_key, support_ref, trace_id,
			        created_at, acknowledged_at
			 FROM analysis_job_deliveries
			 WHERE scope_hmac = ? AND job_id = ?`
		).get(scopeHmac, jobId)
		if (!target) return false
		const terminal = trustedTerminalEventRow(database, target.support_ref)
		if (!parseTrustedTerminalEventRow(terminal) || terminal.trace_id !== target.trace_id) return false
		const now = new Date().toISOString()
		// The exact jobId selects a monotonic cutoff. ACK of a newer response-lost
		// delivery also closes older deliveries for the same attempt; ACK of an
		// older page can never hide a newer delivery.
		const result = database.prepare(
			`UPDATE analysis_job_deliveries
			 SET acknowledged_at = ?, updated_at = ?
			 WHERE scope_hmac = ? AND support_ref = ? AND trace_id = ?
			   AND analysis_key = ?
			   AND (created_at < ? OR (created_at = ? AND rowid <= ?))
			   AND acknowledged_at IS NULL`
		).run(
			now,
			now,
			scopeHmac,
			target.support_ref,
			target.trace_id,
			target.analysis_key,
			target.created_at,
			target.created_at,
			target.delivery_rowid
		)
		return target.acknowledged_at ? true : result.changes >= 1
	})
	return tx.immediate()
}

/**
 * 原子申请一次分析。只有 claimed=true 的进程可以调用外部模型。
 */
function claimAnalysisJob(scopeHmac, analysisKey, leaseOwner, leaseMs, options = {}) {
	const database = getDb()
	const tx = database.transaction(() => {
		const nowMs = Date.now()
		const now = new Date(nowMs).toISOString()
		const leaseExpiresAt = new Date(nowMs + leaseMs).toISOString()
		const cached = database.prepare(
			`SELECT 1 FROM analysis_results
			 WHERE scope_hmac = ? AND analysis_key = ? AND expires_at > ?`
		).get(scopeHmac, analysisKey, now)
		if (cached) return { claimed: false, state: 'succeeded' }

		const job = database.prepare(
			`SELECT status, lease_owner, lease_expires_at, attempt_count,
			        error_code, error_class, error_stage, diagnostic_json,
			        support_ref, trace_id
			 FROM analysis_jobs WHERE scope_hmac = ? AND analysis_key = ?`
		).get(scopeHmac, analysisKey)
		// A failed attempt is terminal for every waiter. Only an explicit enqueue
		// may reset it to queued; otherwise a second worker would blindly rerun the
		// same permanent schema/evidence failure as soon as the first lease ends.
		if (job && job.status === 'failed' && options.allowFailedRetry !== true) {
			return {
				claimed: false,
				state: 'failed',
				supportRef: job.support_ref,
				traceId: job.trace_id,
				errorCode: job.error_code,
				errorClass: job.error_class,
				errorStage: job.error_stage,
				diagnosticJson: job.diagnostic_json
			}
		}
		if (
			job &&
			job.status === 'processing' &&
			job.lease_owner !== leaseOwner &&
			String(job.lease_expires_at || '') > now
		) {
			return {
				claimed: false,
				state: 'processing',
				supportRef: job.support_ref,
				traceId: job.trace_id,
				leaseExpiresAt: job.lease_expires_at
			}
		}

		if (!job) {
			const supportRef = nextUniqueSupportRef(database)
			const traceId = nextUniqueTraceId(database)
			database.prepare(
				`INSERT INTO analysis_jobs
				 (scope_hmac, analysis_key, status, lease_owner, lease_expires_at,
				  attempt_count, error_code, support_ref, trace_id, updated_at)
				 VALUES (?, ?, 'processing', ?, ?, 1, NULL, ?, ?, ?)`
			).run(scopeHmac, analysisKey, leaseOwner, leaseExpiresAt, supportRef, traceId, now)
			bindSupportIdentity(database, scopeHmac, analysisKey, supportRef, traceId, now)
			return {
				claimed: true,
				state: 'processing',
				leaseExpiresAt,
				supportRef,
				traceId
			}
		} else {
			const rotatesAttempt = job.status === 'failed' && options.allowFailedRetry === true
			const supportRef = rotatesAttempt ? nextUniqueSupportRef(database) : job.support_ref
			const traceId = rotatesAttempt ? nextUniqueTraceId(database) : job.trace_id
			if (!SUPPORT_REF_RE.test(String(supportRef || '')) || !TRACE_ID_RE.test(String(traceId || ''))) {
				throw Object.assign(new Error('analysis attempt has invalid trusted identifiers'), {
					code: 'TRUSTED_ANALYSIS_EVENT_INVALID'
				})
			}
			database.prepare(
				`UPDATE analysis_jobs
				 SET status = 'processing', lease_owner = ?, lease_expires_at = ?,
				     attempt_count = attempt_count + 1, error_code = NULL,
				     error_class = NULL, error_stage = NULL, diagnostic_json = NULL,
				     support_ref = ?, trace_id = ?,
				     stage = CASE WHEN job_id IS NULL THEN stage ELSE 'processing' END,
				     progress = CASE WHEN job_id IS NULL THEN progress ELSE MAX(progress, 8) END,
				     finished_at = NULL, updated_at = ?
				 WHERE scope_hmac = ? AND analysis_key = ?`
			).run(leaseOwner, leaseExpiresAt, supportRef, traceId, now, scopeHmac, analysisKey)
			bindSupportIdentity(database, scopeHmac, analysisKey, supportRef, traceId, now)
			return {
				claimed: true,
				state: 'processing',
				leaseExpiresAt,
				supportRef,
				traceId
			}
		}
	})
	return tx.immediate()
}

function renewAnalysisJobLease(scopeHmac, analysisKey, leaseOwner, leaseMs) {
	const nowMs = Date.now()
	const result = getDb().prepare(
		`UPDATE analysis_jobs
		 SET lease_expires_at = ?, updated_at = ?
		 WHERE scope_hmac = ? AND analysis_key = ?
		   AND status = 'processing' AND lease_owner = ?`
	).run(
		new Date(nowMs + leaseMs).toISOString(),
		new Date(nowMs).toISOString(),
		scopeHmac,
		analysisKey,
		leaseOwner
	)
	return result.changes === 1
}

function completeAnalysisJob({
	scopeHmac,
	analysisKey,
	leaseOwner,
	encryptedPayload,
	resultHash,
	versionsJson,
	expiresAt
}) {
	const database = getDb()
	const tx = database.transaction(() => {
		const now = new Date().toISOString()
		const job = database.prepare(
			`SELECT status, lease_owner FROM analysis_jobs
			 WHERE scope_hmac = ? AND analysis_key = ?`
		).get(scopeHmac, analysisKey)
		if (!job || job.status !== 'processing' || job.lease_owner !== leaseOwner) {
			const error = new Error('analysis job lease lost before completion')
			error.code = 'ANALYSIS_LEASE_LOST'
			throw error
		}
		database.prepare(
			`INSERT INTO analysis_results
			 (scope_hmac, analysis_key, encrypted_payload, result_hash,
			  versions_json, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(scope_hmac, analysis_key) DO UPDATE SET
			  encrypted_payload = excluded.encrypted_payload,
			  result_hash = excluded.result_hash,
			  versions_json = excluded.versions_json,
			  created_at = excluded.created_at,
			  expires_at = excluded.expires_at`
		).run(
			scopeHmac,
			analysisKey,
			encryptedPayload,
			resultHash,
			versionsJson,
			now,
			expiresAt
		)
		database.prepare(
			`UPDATE analysis_jobs
			 SET status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
			     error_code = NULL, error_class = NULL, error_stage = NULL,
			     diagnostic_json = NULL,
			     stage = CASE WHEN job_id IS NULL THEN stage ELSE 'succeeded' END,
			     progress = CASE WHEN job_id IS NULL THEN progress ELSE 100 END,
			     finished_at = CASE WHEN job_id IS NULL THEN finished_at ELSE ? END,
			     updated_at = ?
			 WHERE scope_hmac = ? AND analysis_key = ?`
		).run(now, now, scopeHmac, analysisKey)
		return recordTrustedTerminalForJob(database, scopeHmac, analysisKey, {
			status: 'succeeded',
			code: null,
			errorClass: null,
			stage: 'succeeded',
			diagnostic: null,
			serverTime: now
		})
	})
	return tx.immediate()
}

function failAnalysisJob(scopeHmac, analysisKey, leaseOwner, errorCode, failure = {}) {
	const terminal = terminalCodeDefinition(errorCode, failure.errorClass)
	const safeCode = terminal.code
	const database = getDb()
	const tx = database.transaction(() => {
		const now = new Date().toISOString()
		const current = database.prepare(
			`SELECT job_id, stage FROM analysis_jobs
			 WHERE scope_hmac = ? AND analysis_key = ?
			   AND status = 'processing' AND lease_owner = ?`
		).get(scopeHmac, analysisKey, leaseOwner)
		if (!current) return false
		const failureStage = terminal.stage
		const errorClass = terminal.errorClass
		const diagnostic = sanitizeAnalysisFailureDiagnostic(failure.diagnostic)
		const result = database.prepare(
			`UPDATE analysis_jobs
			 SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
			     error_code = ?, error_class = ?, error_stage = ?, diagnostic_json = ?,
			     stage = CASE WHEN job_id IS NULL THEN stage ELSE 'failed' END,
			     finished_at = CASE WHEN job_id IS NULL THEN finished_at ELSE ? END,
			     updated_at = ?
			 WHERE scope_hmac = ? AND analysis_key = ?
			   AND status = 'processing' AND lease_owner = ?`
		).run(
			safeCode,
			errorClass,
			failureStage,
			JSON.stringify(diagnostic),
			now,
			now,
			scopeHmac,
			analysisKey,
			leaseOwner
		)
		if (result.changes !== 1) return false
		recordTrustedTerminalForJob(database, scopeHmac, analysisKey, {
			status: 'failed',
			code: safeCode,
			errorClass,
			stage: failureStage,
			diagnostic,
			serverTime: now
		})
		return true
	})
	return tx.immediate()
}

function failQueuedAnalysisJob(scopeHmac, analysisKey, errorCode, failure = {}) {
	const terminal = terminalCodeDefinition(errorCode, failure.errorClass)
	const safeCode = terminal.code
	const database = getDb()
	const tx = database.transaction(() => {
		const now = new Date().toISOString()
		const current = database.prepare(
			`SELECT stage FROM analysis_jobs
			 WHERE scope_hmac = ? AND analysis_key = ? AND status = 'queued'`
		).get(scopeHmac, analysisKey)
		if (!current) return false
		const failureStage = terminal.stage
		const errorClass = terminal.errorClass
		const diagnostic = sanitizeAnalysisFailureDiagnostic(failure.diagnostic)
		const result = database.prepare(
			`UPDATE analysis_jobs
			 SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
			     error_code = ?, error_class = ?, error_stage = ?,
			     diagnostic_json = ?, stage = 'failed', finished_at = ?, updated_at = ?
			 WHERE scope_hmac = ? AND analysis_key = ? AND status = 'queued'`
		).run(
			safeCode,
			errorClass,
			failureStage,
			JSON.stringify(diagnostic),
			now,
			now,
			scopeHmac,
			analysisKey
		)
		if (result.changes !== 1) return false
		recordTrustedTerminalForJob(database, scopeHmac, analysisKey, {
			status: 'failed',
			code: safeCode,
			errorClass,
			stage: failureStage,
			diagnostic,
			serverTime: now
		})
		return true
	})
	return tx.immediate()
}

function invalidateAnalysisResult(scopeHmac, analysisKey, errorCode = 'CACHE_INTEGRITY_FAILED') {
	const terminal = terminalCodeDefinition(errorCode, 'internal_permanent')
	const safeCode = terminal.code
	const database = getDb()
	const tx = database.transaction(() => {
		const current = database.prepare(
			`SELECT status, error_code FROM analysis_jobs
			 WHERE scope_hmac = ? AND analysis_key = ?`
		).get(scopeHmac, analysisKey)
		database.prepare(
			'DELETE FROM analysis_results WHERE scope_hmac = ? AND analysis_key = ?'
		).run(scopeHmac, analysisKey)
		if (!current || current.status === 'processing') return null
		if (current.status === 'failed' && current.error_code === safeCode) return null
		const now = new Date().toISOString()
		const result = database.prepare(
			`UPDATE analysis_jobs
			 SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
			     error_code = ?, error_class = ?,
			     error_stage = ?,
			     diagnostic_json = '{"version":1}', stage = 'failed',
			     progress = MIN(progress, 99), finished_at = COALESCE(finished_at, ?),
			     updated_at = ?
			 WHERE scope_hmac = ? AND analysis_key = ?
			   AND status <> 'processing'`
		).run(safeCode, terminal.errorClass, terminal.stage, now, now, scopeHmac, analysisKey)
		if (result.changes !== 1) return null
		return recordTrustedTerminalForJob(database, scopeHmac, analysisKey, {
			status: 'failed',
			code: safeCode,
			errorClass: terminal.errorClass,
			stage: terminal.stage,
			diagnostic: { version: 1 },
			serverTime: now
		})
	})
	return tx.immediate()
}

/**
 * 删除一个租户/用户 scope 下的全部分析结果和任务。
 * 调用方只传不可逆 scope HMAC，数据库中不会出现裸用户 ID。
 */
function deleteAnalysisScope(scopeHmac) {
	const normalizedScope = String(scopeHmac || '').trim()
	if (!/^sh_[a-f0-9]{64}$/.test(normalizedScope)) {
		throw new TypeError('a valid analysis scope HMAC is required')
	}
	const database = getDb()
	const tx = database.transaction(() => {
		const inputFiles = database.prepare(
			`SELECT job_id AS jobId, input_path AS inputPath
			 FROM analysis_jobs
			 WHERE scope_hmac = ? AND job_id IS NOT NULL AND input_path IS NOT NULL`
		).all(normalizedScope)
		const bindings = database.prepare(
			'DELETE FROM analysis_support_bindings WHERE scope_hmac = ?'
		).run(normalizedScope)
		const jobs = database.prepare(
			'DELETE FROM analysis_jobs WHERE scope_hmac = ?'
		).run(normalizedScope)
		const results = database.prepare(
			'DELETE FROM analysis_results WHERE scope_hmac = ?'
		).run(normalizedScope)
		return {
			bindingsDeleted: bindings.changes,
			jobsDeleted: jobs.changes,
			resultsDeleted: results.changes,
			inputFiles
		}
	})
	return tx.immediate()
}

function cleanupAnalysisCache() {
	const database = getDb()
	const now = new Date().toISOString()
	const tx = database.transaction(() => {
		database.prepare('DELETE FROM analysis_results WHERE expires_at <= ?').run(now)
		database.prepare(
			`DELETE FROM analysis_jobs
			 WHERE (status = 'succeeded' AND NOT EXISTS (
			  SELECT 1 FROM analysis_results r
			  WHERE r.scope_hmac = analysis_jobs.scope_hmac
			    AND r.analysis_key = analysis_jobs.analysis_key
			 ))
			 OR (status = 'failed' AND input_path IS NULL AND updated_at < ?)`
		).run(new Date(Date.now() - 7 * 86400000).toISOString())
	})
	tx.immediate()
}

// ── 优雅退出 ──

let shutdownBound = false
function bindShutdown() {
	if (shutdownBound) return
	shutdownBound = true
	const handler = (sig) => {
		try {
			flushSync()
			// 关闭 SQLite 连接（WAL 会自动 checkpoint）
			if (db) {
				try { db.close() } catch (_) {}
				db = null
			}
		} finally {
			if (sig === 'SIGINT' || sig === 'SIGTERM') process.exit(0)
		}
	}
	process.on('SIGINT', () => handler('SIGINT'))
	process.on('SIGTERM', () => handler('SIGTERM'))
	process.on('beforeExit', () => handler('beforeExit'))
}
bindShutdown()

/** O(1) 按手机号查找用户（基于内存索引，首次调用或写操作后惰性重建） */
function findUserByPhone(phone) {
	const { byPhone } = _ensureUserIndexes()
	return byPhone.get(String(phone || '')) || null
}

/** O(1) 按 uid 查找用户 */
function findUserById(uid) {
	const { byId } = _ensureUserIndexes()
	return byId.get(String(uid || '')) || null
}

// ── 监控快照存储（供 dev-terminal 云端同步使用） ──

/**
 * 存储一条监控快照
 * @param {object} payload - dev-terminal POST 过来的负载
 * @returns {{ id: number, timestamp: string }}
 */
function insertMonitorSnapshot(payload) {
	const database = getDb()
	const stmt = database.prepare(
		`INSERT INTO monitor_snapshots (timestamp, source, data, db_mtime)
		 VALUES (?, ?, ?, ?)`
	)
	const result = stmt.run(
		payload.snapshotTime || new Date().toISOString(),
		payload.source || 'dev-terminal',
		JSON.stringify(payload),
		payload.dbMtime || null
	)
	const snapshotId = result.lastInsertRowid

	// 存储报告详情（从 payload.reportDetails 提取）
	const reportDetails = payload.reportDetails
	if (Array.isArray(reportDetails) && reportDetails.length > 0) {
		const insertReport = database.prepare(
			`INSERT OR REPLACE INTO monitor_report_details
			 (report_id, user_id, snapshot_id, timestamp, score, risk_level, risk_tags,
			  has_overdue, total_debt, card_usage_rate, query_6m,
			  four_dimensions, risk_hits, debt_summary, ai_assessment, overdue, queries, coverage)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		const txn = database.transaction(() => {
			for (const rd of reportDetails) {
				if (!rd || !rd._id) continue
				insertReport.run(
					rd._id,
					rd.userId || null,
					snapshotId,
					payload.snapshotTime || new Date().toISOString(),
					typeof rd.score === 'number' ? rd.score : null,
					rd.risk_level || null,
					Array.isArray(rd.risk_tags) ? JSON.stringify(rd.risk_tags) : null,
					rd.overdue && rd.overdue.has_overdue ? 1 : 0,
					rd.debt_summary && typeof rd.debt_summary.total_debt === 'number' ? rd.debt_summary.total_debt : null,
					rd.debt_summary && typeof rd.debt_summary.card_usage_rate === 'number' ? rd.debt_summary.card_usage_rate : null,
					rd.queries && typeof rd.queries.last_6m === 'number' ? rd.queries.last_6m : null,
					rd.four_dimensions ? JSON.stringify(rd.four_dimensions) : null,
					Array.isArray(rd.risk_hits) ? JSON.stringify(rd.risk_hits) : null,
					rd.debt_summary ? JSON.stringify(rd.debt_summary) : null,
					rd.ai_assessment ? JSON.stringify(rd.ai_assessment) : null,
					rd.overdue ? JSON.stringify(rd.overdue) : null,
					rd.queries ? JSON.stringify(rd.queries) : null,
					rd.coverage ? JSON.stringify(rd.coverage) : null
				)
			}
		})
		txn()
	}

	return { id: snapshotId, timestamp: payload.snapshotTime }
}

/**
 * 获取最新一条监控快照
 * @returns {object|null}
 */
function getLatestMonitorSnapshot() {
	const database = getDb()
	const row = database.prepare(
		`SELECT * FROM monitor_snapshots ORDER BY id DESC LIMIT 1`
	).get()
	if (!row) return null
	try { row.data = JSON.parse(row.data) } catch (_) { /* 保留原始字符串 */ }
	return row
}

/**
 * 获取历史快照列表
 * @param {number} hours - 时间窗口（小时）
 * @param {number} limit - 最大条数
 * @returns {Array<object>}
 */
function getMonitorSnapshotHistory(hours = 24, limit = 500) {
	const database = getDb()
	const since = new Date(Date.now() - hours * 3600000).toISOString()
	const rows = database.prepare(
		`SELECT id, timestamp, source, db_mtime, created_at
		 FROM monitor_snapshots
		 WHERE timestamp >= ?
		 ORDER BY id DESC
		 LIMIT ?`
	).all(since, limit)
	return rows
}

/**
 * 清理旧快照：
 *   - 30 天以上：删除
 *   - 7-30 天：每自然小时保留第一条（降采样）
 *   - 最近 7 天：全部保留
 */
function cleanupMonitorSnapshots() {
	const database = getDb()
	const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString()
	const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString()

	// 删除 30 天以前的
	database.prepare(
		`DELETE FROM monitor_snapshots WHERE timestamp < ?`
	).run(thirtyDaysAgo)

	// 7-30 天降采样：每自然小时保留 id 最小的一条
	database.prepare(`
		DELETE FROM monitor_snapshots WHERE id IN (
			SELECT id FROM monitor_snapshots
			WHERE timestamp >= ? AND timestamp < ?
				AND id NOT IN (
					SELECT MIN(id) FROM monitor_snapshots
					WHERE timestamp >= ? AND timestamp < ?
					GROUP BY strftime('%Y-%m-%d %H', timestamp)
				)
		)
	`).run(thirtyDaysAgo, sevenDaysAgo, thirtyDaysAgo, sevenDaysAgo)
}

// ── 监控报告详情查询 ──

/**
 * 按报告 ID 获取最新一条报告详情。
 */
function getMonitorReportDetail(reportId) {
	const database = getDb()
	const row = database.prepare(
		`SELECT * FROM monitor_report_details WHERE report_id = ? ORDER BY id DESC LIMIT 1`
	).get(reportId)
	if (!row) return null
	return _parseReportDetailRow(row)
}

/**
 * 按用户 ID 获取该用户的所有报告详情（最新 100 条）。
 */
function getMonitorReportsByUser(userId) {
	const database = getDb()
	const rows = database.prepare(
		`SELECT * FROM monitor_report_details WHERE user_id = ? ORDER BY id DESC LIMIT 100`
	).all(userId)
	return rows.map(_parseReportDetailRow)
}

/**
 * 获取最新一批报告详情。
 */
function getLatestMonitorReportDetails(limit = 50, minScore, riskLevel) {
	const database = getDb()
	let sql = `SELECT * FROM monitor_report_details WHERE 1=1`
	const params = []
	if (typeof minScore === 'number') {
		sql += ` AND score >= ?`
		params.push(minScore)
	}
	if (riskLevel) {
		sql += ` AND risk_level = ?`
		params.push(riskLevel)
	}
	sql += ` ORDER BY id DESC LIMIT ?`
	params.push(limit)
	const rows = database.prepare(sql).all(...params)
	return rows.map(_parseReportDetailRow)
}

/**
 * 统计摘要：风险等级分布、评分分布、逾期比例。
 */
function getMonitorReportStats(hours = 24) {
	const database = getDb()
	const since = new Date(Date.now() - hours * 3600000).toISOString()

	const total = database.prepare(
		`SELECT COUNT(*) as cnt FROM monitor_report_details WHERE timestamp >= ?`
	).get(since)?.cnt || 0

	const byRisk = {}
	const riskRows = database.prepare(
		`SELECT risk_level, COUNT(*) as cnt FROM monitor_report_details WHERE timestamp >= ? GROUP BY risk_level`
	).all(since)
	for (const r of riskRows) {
		if (r.risk_level) byRisk[r.risk_level] = r.cnt
	}

	const avgScore = database.prepare(
		`SELECT AVG(score) as avg FROM monitor_report_details WHERE timestamp >= ? AND score IS NOT NULL`
	).get(since)?.avg || null

	const overdueCount = database.prepare(
		`SELECT COUNT(*) as cnt FROM monitor_report_details WHERE timestamp >= ? AND has_overdue = 1`
	).get(since)?.cnt || 0

	const highQueryCount = database.prepare(
		`SELECT COUNT(*) as cnt FROM monitor_report_details WHERE timestamp >= ? AND query_6m >= 6`
	).get(since)?.cnt || 0

	const highCardUsage = database.prepare(
		`SELECT COUNT(*) as cnt FROM monitor_report_details WHERE timestamp >= ? AND card_usage_rate >= 0.7`
	).get(since)?.cnt || 0

	return {
		total,
		hours,
		avgScore: avgScore ? Math.round(avgScore * 100) / 100 : null,
		byRiskLevel: byRisk,
		overdueRatio: total > 0 ? (overdueCount / total) : 0,
		highQueryRatio: total > 0 ? (highQueryCount / total) : 0,
		highCardUsageRatio: total > 0 ? (highCardUsage / total) : 0
	}
}

function cleanupMonitorReportDetails() {
	const database = getDb()
	const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString()
	database.prepare(
		`DELETE FROM monitor_report_details WHERE timestamp < ?`
	).run(thirtyDaysAgo)
}

function _parseReportDetailRow(row) {
	if (!row) return null
	const jsonFields = ['risk_tags', 'four_dimensions', 'risk_hits', 'debt_summary', 'ai_assessment', 'overdue', 'queries', 'coverage']
	for (const field of jsonFields) {
		if (row[field] && typeof row[field] === 'string') {
			try { row[field] = JSON.parse(row[field]) } catch (_) {}
		}
	}
	return row
}

module.exports = {
	DATA_FILE,
	load,
	state: state_,
	get,
	storageRuntimeStatus,
	persist,
	persistSync,
	flushSync,
	findUserByPhone,
	findUserById,
	getAnalysisResult,
	getAnalysisJob,
	enqueueAnalysisJob,
	getAnalysisJobByPublicId,
	getLatestPublicAnalysisJob,
	getTrustedAnalysisEventBySupportRef,
	getScopedTrustedAnalysisEvent,
	listRecoverableAnalysisJobs,
	listTerminalAnalysisInputs,
	listAnalysisInputReferences,
	updateAnalysisJobProgress,
	clearAnalysisJobInput,
	acknowledgeAnalysisJob,
	claimAnalysisJob,
	renewAnalysisJobLease,
	completeAnalysisJob,
	failAnalysisJob,
	failQueuedAnalysisJob,
	invalidateAnalysisResult,
	deleteAnalysisScope,
	cleanupAnalysisCache,
	insertMonitorSnapshot,
	getLatestMonitorSnapshot,
	getMonitorSnapshotHistory,
	cleanupMonitorSnapshots,
	getMonitorReportDetail,
	getMonitorReportsByUser,
	getLatestMonitorReportDetails,
	getMonitorReportStats,
	cleanupMonitorReportDetails
}
