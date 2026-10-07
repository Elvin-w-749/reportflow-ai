'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const test = require('node:test')
const Database = require('better-sqlite3')

const storePath = path.resolve(__dirname, '../backend/db/store.js')

function seedLegacyDatabase(dataDir, {
	invalidTime = false,
	includeTrustedColumns = false,
	partialCurrentDelivery = false,
	status = 'failed'
} = {}) {
	if (!['succeeded', 'failed'].includes(status)) throw new TypeError('unsupported legacy status')
	const succeeded = status === 'succeeded'
	fs.mkdirSync(dataDir, { recursive: true })
	const sqliteFile = path.join(dataDir, 'db.sqlite')
	const database = new Database(sqliteFile)
	database.exec(`CREATE TABLE analysis_jobs (
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
		${includeTrustedColumns ? 'support_ref TEXT, trace_id TEXT,' : ''}
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
	database.exec(`CREATE TABLE analysis_job_deliveries (
		scope_hmac TEXT NOT NULL,
		job_id TEXT NOT NULL PRIMARY KEY,
		analysis_key TEXT NOT NULL,
		${includeTrustedColumns ? 'support_ref TEXT, trace_id TEXT,' : ''}
		created_at TEXT NOT NULL,
		acknowledged_at TEXT,
		updated_at TEXT NOT NULL
	)`)
	const terminalTime = invalidTime ? 'not-a-time' : '2026-08-17T10:11:12.013Z'
	const scopeHmac = `sh_${'a'.repeat(64)}`
	const analysisKey = 'ak_legacy_support_migration'
	const jobId = `aj_${'b'.repeat(24)}`
	const trustedValues = includeTrustedColumns
		? [`sr_${'c'.repeat(24)}`, `tr_${'d'.repeat(24)}`]
		: []
	const jobColumns = [
		'scope_hmac', 'analysis_key', 'status', 'attempt_count', 'error_code',
		'error_class', 'error_stage', 'diagnostic_json',
		...(includeTrustedColumns ? ['support_ref', 'trace_id'] : []),
		'job_id', 'input_kind', 'stage', 'progress', 'created_at', 'finished_at', 'updated_at'
	]
	database.prepare(
		`INSERT INTO analysis_jobs (${jobColumns.join(', ')})
		 VALUES (${jobColumns.map(() => '?').join(', ')})`
	).run(
		scopeHmac,
		analysisKey,
		status,
		1,
		succeeded ? null : 'FACT_SCHEMA_INVALID',
		succeeded ? null : 'schema_permanent',
		succeeded ? null : 'fact_extraction',
		JSON.stringify(succeeded
			? { version: 1, extra: 'LEGACY_SUCCESS_DIAGNOSTIC_MUST_BE_REMOVED' }
			: { version: 1, failedCheckCount: 1 }),
		...trustedValues,
		jobId,
		'credit-report-pdf',
		status,
		succeeded ? 100 : 80,
		terminalTime,
		terminalTime,
		terminalTime
	)
	const deliveryColumns = [
		'scope_hmac', 'job_id', 'analysis_key',
		...(includeTrustedColumns ? ['support_ref', 'trace_id'] : []),
		'created_at', 'acknowledged_at', 'updated_at'
	]
	const deliveryTrusted = includeTrustedColumns
		? partialCurrentDelivery
			? [trustedValues[0], null]
			: [`sr_${'e'.repeat(24)}`, `tr_${'f'.repeat(24)}`]
		: []
	database.prepare(
		`INSERT INTO analysis_job_deliveries (${deliveryColumns.join(', ')})
		 VALUES (${deliveryColumns.map(() => '?').join(', ')})`
	).run(scopeHmac, jobId, analysisKey, ...deliveryTrusted, terminalTime, null, terminalTime)
	database.close()
	return { sqliteFile, scopeHmac, analysisKey, jobId }
}

function startStoreProcess(dataDir, source = '') {
	const script = [
		`process.env.DATA_DIR = ${JSON.stringify(dataDir)}`,
		`process.env.NODE_ENV = 'test'`,
		source,
		`const store = require(${JSON.stringify(storePath)})`,
		`process.stdout.write(JSON.stringify(store.storageRuntimeStatus()))`
	].filter(Boolean).join(';')
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ['-e', script], {
			encoding: 'utf8',
			env: { ...process.env, DATA_DIR: dataDir, NODE_ENV: 'test' }
		})
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', (chunk) => { stdout += chunk })
		child.stderr.on('data', (chunk) => { stderr += chunk })
		child.on('close', (status) => resolve({ status, stdout, stderr }))
	})
}

function startConcurrentEnqueue(dataDir, label, byte) {
	const script = [
		`process.env.DATA_DIR = ${JSON.stringify(dataDir)}`,
		`process.env.NODE_ENV = 'test'`,
		`let calls = 0`,
		`require('crypto').randomBytes = (size) => { calls += 1; return Buffer.alloc(size, 6 + calls) }`,
		`const store = require(${JSON.stringify(storePath)})`,
		`const outcome = store.enqueueAnalysisJob({ scopeHmac: 'sh_' + ${JSON.stringify(label)}.repeat(64), analysisKey: ${JSON.stringify(`ak_concurrent_${label}`)}, jobId: 'aj_' + ${JSON.stringify(label)}.repeat(24), documentId: 'doc_v2_' + ${JSON.stringify(label)}.repeat(64), inputKind: 'credit-report-pdf', inputPath: '/tmp/${label}.bin', inputSize: ${byte}, scopeCiphertext: 'scope' })`,
		`process.stdout.write(JSON.stringify({ supportRef: outcome.job.support_ref, traceId: outcome.job.trace_id }))`
	].join(';')
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ['-e', script], {
			env: { ...process.env, DATA_DIR: dataDir, NODE_ENV: 'test' }
		})
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', (chunk) => { stdout += chunk })
		child.stderr.on('data', (chunk) => { stderr += chunk })
		child.on('close', (status) => resolve({ status, stdout, stderr }))
	})
}

function startPhase2Terminal(dataDir, label, status) {
	const script = [
		`process.env.DATA_DIR = ${JSON.stringify(dataDir)}`,
		`process.env.NODE_ENV = 'test'`,
		`const store = require(${JSON.stringify(storePath)})`,
		`const scopeHmac = 'sh_' + ${JSON.stringify(label)}.repeat(64)`,
		`const analysisKey = ${JSON.stringify(`ak_rollback_${label}`)}`,
		`const jobId = 'aj_' + ${JSON.stringify(label)}.repeat(24)`,
		`const outcome = store.enqueueAnalysisJob({ scopeHmac, analysisKey, jobId, documentId: 'doc_v2_' + ${JSON.stringify(label)}.repeat(64), inputKind: 'credit-report-pdf', inputPath: '/tmp/${label}.bin', inputSize: 10, scopeCiphertext: 'scope' })`,
		status === 'succeeded'
			? `const claim = store.claimAnalysisJob(scopeHmac, analysisKey, 'worker-${label}', 120000); store.completeAnalysisJob({ scopeHmac, analysisKey, leaseOwner: 'worker-${label}', encryptedPayload: 'payload-${label}', resultHash: 'hash-${label}', versionsJson: '{}', expiresAt: '9999-12-31T23:59:59.999Z' })`
			: `store.failQueuedAnalysisJob(scopeHmac, analysisKey, 'FACT_SCHEMA_INVALID', { errorClass: 'schema_permanent', diagnostic: { version: 1 } })`,
		`const job = store.getAnalysisJob(scopeHmac, analysisKey)`,
		`process.stdout.write(JSON.stringify({ scopeHmac, analysisKey, jobId, supportRef: job.support_ref, traceId: job.trace_id }))`
	].join(';')
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ['-e', script], {
			env: { ...process.env, DATA_DIR: dataDir, NODE_ENV: 'test' }
		})
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', (chunk) => { stdout += chunk })
		child.stderr.on('data', (chunk) => { stderr += chunk })
		child.on('close', (code) => resolve({ code, stdout, stderr }))
	})
}

test('legacy support migration is concurrent-safe, idempotent and unattributed', async (t) => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-support-migration-concurrent-'))
	t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
	const seeded = seedLegacyDatabase(dataDir)
	const [first, second] = await Promise.all([
		startStoreProcess(dataDir),
		startStoreProcess(dataDir)
	])
	for (const child of [first, second]) {
		assert.equal(child.status, 0, child.stderr)
		assert.deepEqual(JSON.parse(child.stdout), { ready: true, mode: 'sqlite' })
	}
	const rerun = await startStoreProcess(dataDir)
	assert.equal(rerun.status, 0, rerun.stderr)
	assert.deepEqual(JSON.parse(rerun.stdout), { ready: true, mode: 'sqlite' })

	const database = new Database(seeded.sqliteFile, { readonly: true })
	const job = database.prepare(
		'SELECT support_ref, trace_id FROM analysis_jobs WHERE scope_hmac = ? AND analysis_key = ?'
	).get(seeded.scopeHmac, seeded.analysisKey)
	const delivery = database.prepare(
		'SELECT support_ref, trace_id FROM analysis_job_deliveries WHERE job_id = ?'
	).get(seeded.jobId)
	assert.match(job.support_ref, /^sr_[A-Za-z0-9_-]{24}$/)
	assert.match(job.trace_id, /^tr_[A-Za-z0-9_-]{24}$/)
	assert.deepEqual(delivery, job)
	const events = database.prepare('SELECT * FROM analysis_terminal_events').all()
	assert.equal(events.length, 1)
	assert.equal(events[0].support_ref, job.support_ref)
	assert.equal(events[0].trace_id, job.trace_id)
	assert.deepEqual(JSON.parse(events[0].release_json), { id: null, gitCommit: null })
	const versions = JSON.parse(events[0].versions_json)
	assert.equal(versions.event, 'analysis-terminal-event-v1')
	for (const [key, value] of Object.entries(versions)) {
		if (key !== 'event') assert.equal(value, null, key)
	}
	assert.equal(events[0].server_time, '2026-08-17T10:11:12.013Z')
	assert.equal(database.pragma("index_list('analysis_terminal_events')").length >= 2, true)
	database.close()
})

test('legacy succeeded migration removes stale diagnostics and stores JSON null', async (t) => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-support-migration-success-'))
	t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
	const seeded = seedLegacyDatabase(dataDir, { status: 'succeeded' })
	const migrated = await startStoreProcess(dataDir)
	assert.equal(migrated.status, 0, migrated.stderr)
	assert.deepEqual(JSON.parse(migrated.stdout), { ready: true, mode: 'sqlite' })
	const database = new Database(seeded.sqliteFile, { readonly: true })
	const job = database.prepare(
		'SELECT diagnostic_json, support_ref FROM analysis_jobs WHERE scope_hmac = ? AND analysis_key = ?'
	).get(seeded.scopeHmac, seeded.analysisKey)
	assert.equal(job.diagnostic_json, null)
	const event = database.prepare(
		'SELECT status, code, error_class, retryable, safe_message_key, diagnostic_json FROM analysis_terminal_events WHERE support_ref = ?'
	).get(job.support_ref)
	assert.deepEqual(event, {
		status: 'succeeded',
		code: null,
		error_class: null,
		retryable: null,
		safe_message_key: null,
		diagnostic_json: 'null'
	})
	assert.doesNotMatch(JSON.stringify({ job, event }), /LEGACY_SUCCESS_DIAGNOSTIC|extra/)
	database.close()
})

test('legacy invalid terminal time fails closed without writing trusted identity', async (t) => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-support-migration-time-'))
	t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
	const seeded = seedLegacyDatabase(dataDir, { invalidTime: true })
	const child = await startStoreProcess(dataDir)
	assert.equal(child.status, 0, child.stderr)
	assert.deepEqual(JSON.parse(child.stdout), {
		ready: false,
		mode: 'sqlite',
		reason: 'STORE_MIGRATION_FAILED'
	})
	const database = new Database(seeded.sqliteFile, { readonly: true })
	const row = database.prepare('SELECT support_ref, trace_id FROM analysis_jobs').get()
	assert.deepEqual(row, { support_ref: null, trace_id: null })
	assert.equal(database.prepare('SELECT COUNT(*) AS total FROM analysis_terminal_events').get().total, 0)
	database.close()
})

test('legacy raw code, stage and diagnostic PII are rewritten to the closed job/event schema', async (t) => {
	for (const status of ['failed', 'processing']) {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `rpt-support-pii-${status}-`))
		t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
		const seeded = seedLegacyDatabase(dataDir)
		const database = new Database(seeded.sqliteFile)
		database.prepare(
			`UPDATE analysis_jobs
			 SET status = ?, error_code = 'PRIVATE_CUSTOMER_13800138000',
			     error_class = 'schema_permanent', error_stage = 'private_customer_20260818',
			     diagnostic_json = ?, stage = 'private_customer_20260818',
			     finished_at = ?`
		).run(
			status,
			JSON.stringify({ version: 1, extra: 'PRIVATE_REPORT_AMOUNT', unknownCount: 9 }),
			status === 'failed' ? '2026-08-17T10:11:12.013Z' : null
		)
		database.close()
		const child = await startStoreProcess(dataDir)
		assert.equal(child.status, 0, child.stderr)
		assert.deepEqual(JSON.parse(child.stdout), { ready: true, mode: 'sqlite' })
		const verify = new Database(seeded.sqliteFile, { readonly: true })
		const job = verify.prepare(
			'SELECT error_code, error_class, error_stage, diagnostic_json, stage FROM analysis_jobs'
		).get()
		if (status === 'failed') {
			assert.deepEqual(job, {
				error_code: 'ANALYSIS_FAILED',
				error_class: 'unknown_permanent',
				error_stage: 'unknown',
				diagnostic_json: '{"version":1}',
				stage: 'failed'
			})
		} else {
			assert.deepEqual(job, {
				error_code: null,
				error_class: null,
				error_stage: null,
				diagnostic_json: null,
				stage: 'processing'
			})
		}
		const serialized = JSON.stringify({
			job,
			events: verify.prepare('SELECT * FROM analysis_terminal_events').all()
		})
		assert.doesNotMatch(serialized, /PRIVATE_CUSTOMER|13800138000|private_customer|PRIVATE_REPORT_AMOUNT|unknownCount/)
		verify.close()
	}
})

test('partially migrated delivery identity mismatch fails closed', async (t) => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-support-migration-mismatch-'))
	t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
	seedLegacyDatabase(dataDir, { includeTrustedColumns: true })
	const child = await startStoreProcess(dataDir)
	assert.equal(child.status, 0, child.stderr)
	assert.deepEqual(JSON.parse(child.stdout), {
		ready: false,
		mode: 'sqlite',
		reason: 'STORE_MIGRATION_FAILED'
	})
})

test('weak binding constraints and same-name no-op triggers fail closed at startup', async (t) => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-support-weak-binding-schema-'))
	t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
	const seeded = seedLegacyDatabase(dataDir)
	const database = new Database(seeded.sqliteFile)
	database.exec(`CREATE TABLE analysis_support_bindings (
		support_ref TEXT,
		trace_id TEXT,
		scope_hmac TEXT,
		analysis_key TEXT,
		created_at TEXT
	)`)
	database.exec(`CREATE TRIGGER trg_analysis_support_no_update
		BEFORE UPDATE ON analysis_support_bindings BEGIN SELECT 1; END`)
	database.exec(`CREATE TRIGGER trg_analysis_delivery_binding_insert
		BEFORE INSERT ON analysis_job_deliveries BEGIN SELECT 1; END`)
	database.exec(`CREATE TRIGGER trg_analysis_delivery_binding_update
		BEFORE UPDATE ON analysis_job_deliveries BEGIN SELECT 1; END`)
	database.close()
	const child = await startStoreProcess(dataDir)
	assert.equal(child.status, 0, child.stderr)
	assert.deepEqual(JSON.parse(child.stdout), {
		ready: false,
		mode: 'sqlite',
		reason: 'STORE_MIGRATION_FAILED'
	})
})

test('weak terminal constraints and same-name no-op triggers fail closed at startup', async (t) => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-support-weak-terminal-schema-'))
	t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
	const seeded = seedLegacyDatabase(dataDir)
	const database = new Database(seeded.sqliteFile)
	database.exec(`CREATE TABLE analysis_terminal_events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		schema_version TEXT,
		support_ref TEXT,
		trace_id TEXT,
		status TEXT,
		code TEXT,
		error_class TEXT,
		stage TEXT,
		retryable INTEGER,
		safe_message_key TEXT,
		diagnostic_json TEXT,
		release_json TEXT,
		versions_json TEXT,
		server_time TEXT,
		created_at TEXT
	)`)
	for (const [name, action] of [
		['trg_analysis_terminal_no_update', 'UPDATE'],
		['trg_analysis_terminal_no_delete', 'DELETE'],
		['trg_analysis_terminal_ref_trace_binding', 'INSERT'],
		['trg_analysis_terminal_transition', 'INSERT']
	]) database.exec(`CREATE TRIGGER ${name} BEFORE ${action} ON analysis_terminal_events BEGIN SELECT 1; END`)
	database.close()
	const child = await startStoreProcess(dataDir)
	assert.equal(child.status, 0, child.stderr)
	assert.deepEqual(JSON.parse(child.stdout), {
		ready: false,
		mode: 'sqlite',
		reason: 'STORE_MIGRATION_FAILED'
	})
})

test('partial current-attempt delivery identity is repaired without rotating the attempt', async (t) => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-support-migration-partial-current-'))
	t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
	const seeded = seedLegacyDatabase(dataDir, {
		includeTrustedColumns: true,
		partialCurrentDelivery: true
	})
	const child = await startStoreProcess(dataDir)
	assert.equal(child.status, 0, child.stderr)
	assert.deepEqual(JSON.parse(child.stdout), { ready: true, mode: 'sqlite' })
	const database = new Database(seeded.sqliteFile, { readonly: true })
	const job = database.prepare('SELECT support_ref, trace_id FROM analysis_jobs').get()
	const delivery = database.prepare('SELECT support_ref, trace_id FROM analysis_job_deliveries').get()
	assert.deepEqual(delivery, job)
	database.close()
})

test('sixteen forced CSPRNG collisions fail without partial trusted writes', async (t) => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-support-collision-'))
	t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
	const seeded = seedLegacyDatabase(dataDir)
	const database = new Database(seeded.sqliteFile)
	database.exec(`CREATE TABLE analysis_terminal_events (
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
	const collisionRef = `sr_${Buffer.alloc(18, 7).toString('base64url')}`
	database.prepare(
		`INSERT INTO analysis_terminal_events
		 (schema_version, support_ref, trace_id, status, code, error_class, stage,
		  retryable, safe_message_key, diagnostic_json, release_json, versions_json,
		  server_time, created_at)
		 VALUES (?, ?, ?, 'failed', 'ANALYSIS_FAILED', 'unknown_permanent', 'failed',
		         0, 'analysis.failed', '{"version":1}', '{"id":null,"gitCommit":null}',
		         ?, '2026-08-17T10:11:12.013Z', '2026-08-17T10:11:12.013Z')`
	).run(
		'analysis-terminal-event-v1',
		collisionRef,
		`tr_${'x'.repeat(24)}`,
		JSON.stringify({
			event: 'analysis-terminal-event-v1',
			pipeline: null,
			model: null,
			prompt: null,
			schema: null,
			evidenceContract: null,
			evidenceBinder: null,
			derivedTrace: null,
			rule: null,
			ocr: null
		})
	)
	database.close()
	const patchCrypto = `require('crypto').randomBytes = (size) => Buffer.alloc(size, 7)`
	const child = await startStoreProcess(dataDir, patchCrypto)
	assert.equal(child.status, 0, child.stderr)
	assert.deepEqual(JSON.parse(child.stdout), {
		ready: false,
		mode: 'sqlite',
		reason: 'STORE_READ_FAILED'
	})
	const verify = new Database(seeded.sqliteFile, { readonly: true })
	assert.deepEqual(verify.prepare('SELECT support_ref, trace_id FROM analysis_jobs').get(), {
		support_ref: null,
		trace_id: null
	})
	assert.equal(verify.prepare('SELECT COUNT(*) AS total FROM analysis_terminal_events').get().total, 1)
	verify.close()
})

test('fifteen support collisions retry and bind the sixteenth random candidate', async (t) => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-support-collision-retry-'))
	t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
	const seeded = seedLegacyDatabase(dataDir)
	const database = new Database(seeded.sqliteFile)
	database.exec(`CREATE TABLE analysis_terminal_events (
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
	const collisionRef = `sr_${Buffer.alloc(18, 7).toString('base64url')}`
	const legacyVersions = JSON.stringify({
		event: 'analysis-terminal-event-v1',
		pipeline: null,
		model: null,
		prompt: null,
		schema: null,
		evidenceContract: null,
		evidenceBinder: null,
		derivedTrace: null,
		rule: null,
		ocr: null
	})
	database.prepare(
		`INSERT INTO analysis_terminal_events
		 (schema_version, support_ref, trace_id, status, code, error_class, stage,
		  retryable, safe_message_key, diagnostic_json, release_json, versions_json,
		  server_time, created_at)
		 VALUES ('analysis-terminal-event-v1', ?, ?, 'failed', 'ANALYSIS_FAILED',
		         'unknown_permanent', 'failed', 0, 'analysis.failed', '{"version":1}',
		         '{"id":null,"gitCommit":null}', ?,
		         '2026-08-17T10:11:12.013Z', '2026-08-17T10:11:12.013Z')`
	).run(collisionRef, `tr_${'x'.repeat(24)}`, legacyVersions)
	database.close()
	const patchCrypto = [
		`let calls = 0`,
		`require('crypto').randomBytes = (size) => { calls += 1; return Buffer.alloc(size, calls <= 15 ? 7 : calls === 16 ? 8 : 9) }`
	].join(';')
	const child = await startStoreProcess(dataDir, patchCrypto)
	assert.equal(child.status, 0, child.stderr)
	assert.deepEqual(JSON.parse(child.stdout), { ready: true, mode: 'sqlite' })
	const verify = new Database(seeded.sqliteFile, { readonly: true })
	const row = verify.prepare('SELECT support_ref, trace_id FROM analysis_jobs').get()
	assert.equal(row.support_ref, `sr_${Buffer.alloc(18, 8).toString('base64url')}`)
	assert.equal(row.trace_id, `tr_${Buffer.alloc(18, 9).toString('base64url')}`)
	verify.close()
})

test('concurrent processes with the same random sequence retry to distinct bindings', async (t) => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-support-concurrent-allocation-'))
	t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
	const initialized = await startStoreProcess(dataDir)
	assert.equal(initialized.status, 0, initialized.stderr)
	const [left, right] = await Promise.all([
		startConcurrentEnqueue(dataDir, 'a', 10),
		startConcurrentEnqueue(dataDir, 'b', 11)
	])
	for (const child of [left, right]) assert.equal(child.status, 0, child.stderr)
	const first = JSON.parse(left.stdout)
	const second = JSON.parse(right.stdout)
	assert.notEqual(first.supportRef, second.supportRef)
	assert.notEqual(first.traceId, second.traceId)
	const database = new Database(path.join(dataDir, 'db.sqlite'), { readonly: true })
	assert.equal(database.prepare('SELECT COUNT(*) AS total FROM analysis_jobs').get().total, 2)
	assert.equal(database.prepare('SELECT COUNT(DISTINCT support_ref) AS total FROM analysis_jobs').get().total, 2)
	assert.equal(database.prepare('SELECT COUNT(DISTINCT trace_id) AS total FROM analysis_jobs').get().total, 2)
	database.close()
})

test('rollback explicit retries rotate attempt identity on re-forward while preserving old delivery/event', async (t) => {
	const cases = [
		{ label: 'a', status: 'queued', offset: 1000 },
		{ label: 'b', status: 'processing', offset: 1000 },
		{ label: 'c', status: 'succeeded', offset: 1000 },
		{ label: 'd', status: 'failed', offset: 1000 },
		{ label: 'e', status: 'failed', offset: 0 },
		{ label: 'f', status: 'failed', offset: -1000 }
	]
	for (const fixture of cases) {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `rpt-rollback-${fixture.status}-`))
		t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
		const seeded = await startPhase2Terminal(dataDir, fixture.label, 'failed')
		assert.equal(seeded.code, 0, seeded.stderr)
		const original = JSON.parse(seeded.stdout)
		const database = new Database(path.join(dataDir, 'db.sqlite'))
		const oldEvent = database.prepare(
			'SELECT server_time FROM analysis_terminal_events WHERE support_ref = ? ORDER BY id DESC LIMIT 1'
		).get(original.supportRef)
		const retryTime = new Date(new Date(oldEvent.server_time).getTime() + fixture.offset).toISOString()
		database.prepare(
			`UPDATE analysis_job_deliveries SET acknowledged_at = ?, updated_at = ?
			 WHERE scope_hmac = ? AND analysis_key = ? AND acknowledged_at IS NULL`
		).run(retryTime, retryTime, original.scopeHmac, original.analysisKey)
		const values = {
			queued: { errorCode: null, errorClass: null, errorStage: null, stage: 'queued', progress: 5, finishedAt: null },
			processing: { errorCode: null, errorClass: null, errorStage: null, stage: 'processing', progress: 8, finishedAt: null },
			succeeded: { errorCode: null, errorClass: null, errorStage: null, stage: 'succeeded', progress: 100, finishedAt: retryTime },
			failed: { errorCode: 'FACT_SCHEMA_INVALID', errorClass: 'schema_permanent', errorStage: 'fact_extraction', stage: 'failed', progress: 80, finishedAt: retryTime }
		}[fixture.status]
		const newJobId = `aj_${'z'.repeat(24)}`
		database.prepare(
			`UPDATE analysis_jobs
			 SET status = ?, error_code = ?, error_class = ?, error_stage = ?,
			     diagnostic_json = '{"version":1}', job_id = ?, stage = ?, progress = ?,
			     created_at = ?, finished_at = ?, updated_at = ?
			 WHERE scope_hmac = ? AND analysis_key = ?`
		).run(
			fixture.status,
			values.errorCode,
			values.errorClass,
			values.errorStage,
			newJobId,
			values.stage,
			values.progress,
			retryTime,
			values.finishedAt,
			retryTime,
			original.scopeHmac,
			original.analysisKey
		)
		database.prepare(
			`INSERT INTO analysis_job_deliveries
			 (scope_hmac, job_id, analysis_key, created_at, acknowledged_at, updated_at)
			 VALUES (?, ?, ?, ?, NULL, ?)`
		).run(original.scopeHmac, newJobId, original.analysisKey, retryTime, retryTime)
		database.close()

		const forward = await startStoreProcess(dataDir)
		assert.equal(forward.status, 0, forward.stderr)
		assert.deepEqual(JSON.parse(forward.stdout), { ready: true, mode: 'sqlite' })
		const verify = new Database(path.join(dataDir, 'db.sqlite'), { readonly: true })
		const current = verify.prepare('SELECT support_ref, trace_id FROM analysis_jobs').get()
		assert.notEqual(current.support_ref, original.supportRef, fixture.status)
		assert.notEqual(current.trace_id, original.traceId, fixture.status)
		const deliveries = verify.prepare(
			'SELECT job_id, support_ref, trace_id FROM analysis_job_deliveries'
		).all()
		assert.equal(deliveries.find((row) => row.job_id === original.jobId).support_ref, original.supportRef)
		assert.equal(deliveries.find((row) => row.job_id === newJobId).support_ref, current.support_ref)
		assert.equal(
			verify.prepare('SELECT COUNT(*) AS total FROM analysis_terminal_events').get().total,
			['succeeded', 'failed'].includes(fixture.status) ? 2 : 1
		)
		assert.equal(verify.prepare('SELECT COUNT(*) AS total FROM analysis_support_bindings').get().total, 2)
		verify.close()
	}
})

test('rollback cache hit keeps the original attempt while old cache invalidation appends its allowed revision', async (t) => {
	for (const fixture of [
		{ label: 'e', mode: 'cache-hit' },
		{ label: 'f', mode: 'cache-invalid' }
	]) {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `rpt-rollback-${fixture.mode}-`))
		t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
		const seeded = await startPhase2Terminal(dataDir, fixture.label, 'succeeded')
		assert.equal(seeded.code, 0, seeded.stderr)
		const original = JSON.parse(seeded.stdout)
		const database = new Database(path.join(dataDir, 'db.sqlite'))
		const job = database.prepare('SELECT created_at, finished_at FROM analysis_jobs').get()
		const later = new Date(new Date(job.finished_at).getTime() + 1000).toISOString()
		if (fixture.mode === 'cache-hit') {
			const newJobId = `aj_${'y'.repeat(24)}`
			database.prepare(
				`UPDATE analysis_jobs SET job_id = ?, updated_at = ?
				 WHERE scope_hmac = ? AND analysis_key = ?`
			).run(newJobId, later, original.scopeHmac, original.analysisKey)
			database.prepare(
				`INSERT INTO analysis_job_deliveries
				 (scope_hmac, job_id, analysis_key, created_at, acknowledged_at, updated_at)
				 VALUES (?, ?, ?, ?, NULL, ?)`
			).run(original.scopeHmac, newJobId, original.analysisKey, later, later)
		} else {
			database.prepare('DELETE FROM analysis_results').run()
			database.prepare(
				`UPDATE analysis_jobs
				 SET status = 'failed', error_code = 'CACHE_INTEGRITY_FAILED',
				     error_class = 'internal_permanent', error_stage = 'cache',
				     diagnostic_json = '{"version":1}', stage = 'failed', progress = 99,
				     updated_at = ?`
			).run(later)
		}
		database.close()
		const forward = await startStoreProcess(dataDir)
		assert.equal(forward.status, 0, forward.stderr)
		assert.deepEqual(JSON.parse(forward.stdout), { ready: true, mode: 'sqlite' })
		const verify = new Database(path.join(dataDir, 'db.sqlite'), { readonly: true })
		const current = verify.prepare('SELECT support_ref, trace_id FROM analysis_jobs').get()
		assert.deepEqual(current, { support_ref: original.supportRef, trace_id: original.traceId })
		const events = verify.prepare(
			'SELECT status, code FROM analysis_terminal_events WHERE support_ref = ? ORDER BY id'
		).all(original.supportRef)
		assert.deepEqual(events, fixture.mode === 'cache-hit'
			? [{ status: 'succeeded', code: null }]
			: [
				{ status: 'succeeded', code: null },
				{ status: 'failed', code: 'CACHE_INTEGRITY_FAILED' }
			])
		verify.close()
	}
})

test('legacy exact ACK cutoff never revives an older response-lost delivery', async (t) => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-rollback-ack-cutoff-'))
	t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
	const seeded = await startPhase2Terminal(dataDir, 'a', 'succeeded')
	assert.equal(seeded.code, 0, seeded.stderr)
	const original = JSON.parse(seeded.stdout)
	const database = new Database(path.join(dataDir, 'db.sqlite'))
	const first = database.prepare('SELECT created_at FROM analysis_job_deliveries WHERE job_id = ?').get(original.jobId)
	const secondTime = new Date(new Date(first.created_at).getTime() + 1000).toISOString()
	const secondJobId = `aj_${'k'.repeat(24)}`
	database.prepare(
		`INSERT INTO analysis_job_deliveries
		 (scope_hmac, job_id, analysis_key, support_ref, trace_id,
		  created_at, acknowledged_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		original.scopeHmac,
		secondJobId,
		original.analysisKey,
		original.supportRef,
		original.traceId,
		secondTime,
		secondTime,
		secondTime
	)
	database.close()
	const migrated = await startStoreProcess(dataDir)
	assert.equal(migrated.status, 0, migrated.stderr)
	let verify = new Database(path.join(dataDir, 'db.sqlite'), { readonly: true })
	assert.equal(verify.prepare(
		'SELECT COUNT(*) AS total FROM analysis_job_deliveries WHERE acknowledged_at IS NULL'
	).get().total, 0)
	verify.close()

	const writable = new Database(path.join(dataDir, 'db.sqlite'))
	const earlier = new Date(new Date(first.created_at).getTime() - 1000).toISOString()
	const later = new Date(new Date(secondTime).getTime() + 1000).toISOString()
	const backfilledOldId = `aj_${'m'.repeat(24)}`
	const newerId = `aj_${'n'.repeat(24)}`
	const insert = writable.prepare(
		`INSERT INTO analysis_job_deliveries
		 (scope_hmac, job_id, analysis_key, support_ref, trace_id,
		  created_at, acknowledged_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`
	)
	insert.run(original.scopeHmac, backfilledOldId, original.analysisKey, original.supportRef, original.traceId, earlier, later)
	insert.run(original.scopeHmac, newerId, original.analysisKey, original.supportRef, original.traceId, later, later)
	writable.close()
	const acknowledgeScript = [
		`process.env.DATA_DIR = ${JSON.stringify(dataDir)}`,
		`process.env.NODE_ENV = 'test'`,
		`const store = require(${JSON.stringify(storePath)})`,
		`const ok = store.acknowledgeAnalysisJob(${JSON.stringify(original.scopeHmac)}, ${JSON.stringify(secondJobId)})`,
		`const latest = store.getLatestPublicAnalysisJob(${JSON.stringify(original.scopeHmac)})`,
		`process.stdout.write(JSON.stringify({ ok, latest: latest && latest.job_id }))`
	].join(';')
	const acknowledged = await new Promise((resolve) => {
		const child = spawn(process.execPath, ['-e', acknowledgeScript], {
			env: { ...process.env, DATA_DIR: dataDir, NODE_ENV: 'test' }
		})
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', (chunk) => { stdout += chunk })
		child.stderr.on('data', (chunk) => { stderr += chunk })
		child.on('close', (code) => resolve({ code, stdout, stderr }))
	})
	assert.equal(acknowledged.code, 0, acknowledged.stderr)
	assert.deepEqual(JSON.parse(acknowledged.stdout), { ok: true, latest: newerId })
	verify = new Database(path.join(dataDir, 'db.sqlite'), { readonly: true })
	assert.ok(verify.prepare('SELECT acknowledged_at FROM analysis_job_deliveries WHERE job_id = ?').get(backfilledOldId).acknowledged_at)
	assert.equal(verify.prepare('SELECT acknowledged_at FROM analysis_job_deliveries WHERE job_id = ?').get(newerId).acknowledged_at, null)
	verify.close()
})

test('support bindings reject cross-scope and same-scope cross-analysis delivery borrowing', async (t) => {
	for (const fixture of [
		{ name: 'cross-scope', scopeLabel: 'b' },
		{ name: 'same-scope-cross-analysis', scopeLabel: 'a' }
	]) {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `rpt-binding-${fixture.name}-`))
		t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
		const seeded = await startPhase2Terminal(dataDir, 'a', 'failed')
		assert.equal(seeded.code, 0, seeded.stderr)
		const original = JSON.parse(seeded.stdout)
		const database = new Database(path.join(dataDir, 'db.sqlite'))
		database.exec('DROP TRIGGER trg_analysis_delivery_binding_insert')
		database.exec('DROP TRIGGER trg_analysis_delivery_binding_update')
		const scopeHmac = `sh_${fixture.scopeLabel.repeat(64)}`
		const analysisKey = `ak_borrowed_${fixture.name}`
		const ownSupport = `sr_${'q'.repeat(24)}`
		const ownTrace = `tr_${'r'.repeat(24)}`
		const jobId = `aj_${'s'.repeat(24)}`
		const now = new Date().toISOString()
		database.prepare(
			`INSERT INTO analysis_jobs
			 (scope_hmac, analysis_key, status, attempt_count, support_ref, trace_id,
			  job_id, stage, progress, created_at, updated_at)
			 VALUES (?, ?, 'queued', 0, ?, ?, ?, 'queued', 5, ?, ?)`
		).run(scopeHmac, analysisKey, ownSupport, ownTrace, jobId, now, now)
		database.prepare(
			`INSERT INTO analysis_job_deliveries
			 (scope_hmac, job_id, analysis_key, support_ref, trace_id,
			  created_at, acknowledged_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`
		).run(scopeHmac, jobId, analysisKey, original.supportRef, original.traceId, now, now)
		database.close()
		const child = await startStoreProcess(dataDir)
		assert.equal(child.status, 0, child.stderr)
		assert.notDeepEqual(JSON.parse(child.stdout), { ready: true, mode: 'sqlite' }, fixture.name)
	}
})

test('a terminal identity retained after binding deletion can never be claimed by another scope', async (t) => {
	for (const status of ['queued', 'failed']) {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `rpt-binding-deleted-${status}-`))
		t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
		const seeded = await startPhase2Terminal(dataDir, 'a', 'failed')
		assert.equal(seeded.code, 0, seeded.stderr)
		const original = JSON.parse(seeded.stdout)
		const database = new Database(path.join(dataDir, 'db.sqlite'))
		const oldEvent = database.prepare(
			'SELECT * FROM analysis_terminal_events WHERE support_ref = ? ORDER BY id DESC LIMIT 1'
		).get(original.supportRef)
		database.prepare('DELETE FROM analysis_support_bindings WHERE scope_hmac = ?').run(original.scopeHmac)
		database.prepare('DELETE FROM analysis_jobs WHERE scope_hmac = ?').run(original.scopeHmac)
		const scopeHmac = `sh_${'b'.repeat(64)}`
		const analysisKey = `ak_reclaim_deleted_terminal_${status}`
		const jobId = `aj_${'t'.repeat(24)}`
		const createdAt = status === 'failed' ? oldEvent.server_time : new Date().toISOString()
		database.prepare(
			`INSERT INTO analysis_jobs
			 (scope_hmac, analysis_key, status, attempt_count, error_code, error_class,
			  error_stage, diagnostic_json, support_ref, trace_id, job_id, stage,
			  progress, created_at, finished_at, updated_at)
			 VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			scopeHmac,
			analysisKey,
			status,
			status === 'failed' ? 'FACT_SCHEMA_INVALID' : null,
			status === 'failed' ? 'schema_permanent' : null,
			status === 'failed' ? 'fact-extraction' : null,
			status === 'failed' ? '{"version":1}' : null,
			original.supportRef,
			original.traceId,
			jobId,
			status === 'failed' ? 'failed' : 'queued',
			status === 'failed' ? 80 : 5,
			createdAt,
			status === 'failed' ? oldEvent.server_time : null,
			createdAt
		)
		database.close()
		const child = await startStoreProcess(dataDir)
		assert.equal(child.status, 0, child.stderr)
		const readiness = JSON.parse(child.stdout)
		if (readiness.ready === true) {
			const verify = new Database(path.join(dataDir, 'db.sqlite'), { readonly: true })
			const current = verify.prepare('SELECT support_ref, trace_id FROM analysis_jobs').get()
			assert.notEqual(current.support_ref, original.supportRef)
			assert.notEqual(current.trace_id, original.traceId)
			assert.deepEqual(
				verify.prepare('SELECT * FROM analysis_terminal_events WHERE support_ref = ? ORDER BY id DESC LIMIT 1').get(original.supportRef),
				oldEvent
			)
			assert.equal(verify.prepare('SELECT COUNT(*) AS total FROM analysis_support_bindings WHERE support_ref = ?').get(original.supportRef).total, 0)
			verify.close()
		}
	}
})

test('terminal events persisted by the previous release keep the store bootable and readable', async (t) => {
	// Production incident 2026-08-21: the binder v8 release crash-looped at boot
	// because store.load() re-validated terminal events written by the v7
	// release and rejected their (legitimate) historical version strings.
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-support-prev-release-versions-'))
	t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
	const seeded = await startPhase2Terminal(dataDir, 'a', 'failed')
	assert.equal(seeded.code, 0, seeded.stderr)
	const original = JSON.parse(seeded.stdout)

	// Rewrite the persisted versions to the exact snapshot the previous release
	// wrote in production (only evidenceBinder differs from the current one).
	// The immutability trigger guards the application; the test suspends and
	// restores it to simulate a database inherited from the older release.
	const database = new Database(path.join(dataDir, 'db.sqlite'))
	const trigger = database.prepare(
		"SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_analysis_terminal_no_update'"
	).get().sql
	database.exec('DROP TRIGGER trg_analysis_terminal_no_update')
	database.prepare(
		'UPDATE analysis_terminal_events SET versions_json = ? WHERE support_ref = ?'
	).run(JSON.stringify({
		event: 'analysis-terminal-event-v1',
		pipeline: 'credit-analysis-v14-global-card-binding-currency-closed',
		model: 'deepseek-v4-flash',
		prompt: 'credit-facts-v8-query-source',
		schema: 'credit-facts-schema-v6-evidence-closure',
		evidenceContract: 'evidence-ledger-v2.1',
		evidenceBinder: 'deterministic-global-card-binding-v7',
		derivedTrace: 'derived-analysis-provenance-v4',
		rule: 'credit-rules-deterministic-v3',
		ocr: 'rapidocr-v1'
	}), original.supportRef)
	database.exec(trigger)
	database.close()

	const reboot = await startStoreProcess(dataDir)
	assert.equal(reboot.status, 0, reboot.stderr)
	assert.deepEqual(JSON.parse(reboot.stdout), { ready: true, mode: 'sqlite' })

	// Support lookups must keep resolving the historical event, preserving the
	// original version string instead of nulling or rejecting it.
	const lookupScript = [
		`process.env.DATA_DIR = ${JSON.stringify(dataDir)}`,
		`process.env.NODE_ENV = 'test'`,
		`const store = require(${JSON.stringify(storePath)})`,
		`const event = store.getTrustedAnalysisEventBySupportRef(${JSON.stringify(original.supportRef)})`,
		`process.stdout.write(JSON.stringify(event && { status: event.status, evidenceBinder: event.versions.evidenceBinder }))`
	].join(';')
	const lookup = await new Promise((resolve) => {
		const child = spawn(process.execPath, ['-e', lookupScript], {
			env: { ...process.env, DATA_DIR: dataDir, NODE_ENV: 'test' }
		})
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', (chunk) => { stdout += chunk })
		child.stderr.on('data', (chunk) => { stderr += chunk })
		child.on('close', (code) => resolve({ code, stdout, stderr }))
	})
	assert.equal(lookup.code, 0, lookup.stderr)
	assert.deepEqual(JSON.parse(lookup.stdout), {
		status: 'failed',
		evidenceBinder: 'deterministic-global-card-binding-v7'
	})

	// A version string never shipped by any release still fails the boot closed.
	const forged = new Database(path.join(dataDir, 'db.sqlite'))
	forged.exec('DROP TRIGGER trg_analysis_terminal_no_update')
	forged.prepare(
		'UPDATE analysis_terminal_events SET versions_json = ? WHERE support_ref = ?'
	).run(JSON.stringify({
		event: 'analysis-terminal-event-v1',
		pipeline: null,
		model: null,
		prompt: null,
		schema: null,
		evidenceContract: null,
		evidenceBinder: 'deterministic-global-card-binding-v999-forged',
		derivedTrace: null,
		rule: null,
		ocr: null
	}), original.supportRef)
	forged.exec(trigger)
	forged.close()
	const forgedBoot = await startStoreProcess(dataDir)
	assert.equal(forgedBoot.status, 0, forgedBoot.stderr)
	assert.notDeepEqual(JSON.parse(forgedBoot.stdout), { ready: true, mode: 'sqlite' })
})
