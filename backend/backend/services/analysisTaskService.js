'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const store = require('../db/store')
const logger = require('../utils/logger')
const {
	buildAnalysisIdentity,
	buildAnalysisScopeHmac
} = require('./analysisIdentity')
const analysisCoordinator = require('./analysisCoordinator')
const { sanitizeAnalysisFailureDiagnostic } = require('../utils/analysisFailureDiagnostic')
const {
	SUPPORT_REF_RE,
	TRACE_ID_RE,
	normalizeTerminalCode,
	parseTrustedTerminalEventRow
} = require('../utils/trustedAnalysisEvent')

const JOB_ID_RE = /^aj_[A-Za-z0-9_-]{24}$/
const SPOOL_ROOT = path.join(path.dirname(store.DATA_FILE), 'analysis-inputs')
const SCAN_INTERVAL_MS = 5000
const SPOOL_RECONCILE_INTERVAL_MS = 60 * 60 * 1000
const SPOOL_ORPHAN_TTL_MS = Math.min(
	30 * 86400000,
	Math.max(60 * 60 * 1000, Number(process.env.ANALYSIS_SPOOL_ORPHAN_TTL_MS) || 24 * 60 * 60 * 1000)
)
const SPOOL_TEMP_TTL_MS = 60 * 60 * 1000
let executor = null
let scanTimer = null
let scanScheduled = false
let scanRunning = false
let lastSpoolReconcileAt = 0
let processLocalSecret = null

function configuredSecret() {
	for (const candidate of [process.env.ANALYSIS_CACHE_SECRET, process.env.ANALYSIS_KEY_SECRET]) {
		const value = String(candidate || '').trim()
		if (Buffer.byteLength(value, 'utf8') >= 32) return value
	}
	if (!processLocalSecret) processLocalSecret = crypto.randomBytes(32).toString('base64url')
	return processLocalSecret
}

function scopeEncryptionKey() {
	return crypto
		.createHash('sha256')
		.update('reportflow-analysis-task-scope-aes256gcm-v1\0')
		.update(configuredSecret())
		.digest()
}

function cacheEncryptionKey() {
	return crypto
		.createHash('sha256')
		.update('reportflow-analysis-cache-aes256gcm-v1\0')
		.update(configuredSecret())
		.digest()
}

function spoolEncryptionKey() {
	return crypto
		.createHash('sha256')
		.update('reportflow-analysis-task-spool-aes256gcm-v1\0')
		.update(configuredSecret())
		.digest()
}

function encryptValue(value, key) {
	const iv = crypto.randomBytes(12)
	const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
	const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
	return [iv, cipher.getAuthTag(), ciphertext]
		.map((part) => part.toString('base64url'))
		.join('.')
}

function decryptValue(value, key) {
	const parts = String(value || '').split('.')
	if (parts.length !== 3) throw Object.assign(new Error('invalid encrypted value'), { code: 'ANALYSIS_TASK_SCOPE_INVALID' })
	const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, 'base64url'))
	const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
	decipher.setAuthTag(tag)
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

function newJobId() {
	return `aj_${crypto.randomBytes(18).toString('base64url')}`
}

function ensureSpoolRoot() {
	fs.mkdirSync(SPOOL_ROOT, { recursive: true, mode: 0o700 })
	try { fs.chmodSync(SPOOL_ROOT, 0o700) } catch (_) {}
}

function expectedSpoolPath(jobId) {
	if (!JOB_ID_RE.test(String(jobId || ''))) throw new TypeError('invalid analysis job id')
	return path.join(SPOOL_ROOT, `${jobId}.bin`)
}

function assertExpectedSpoolPath(jobId, candidate) {
	const expected = path.resolve(expectedSpoolPath(jobId))
	const actual = path.resolve(String(candidate || ''))
	if (actual !== expected) {
		const error = new Error('analysis task input path escaped spool root')
		error.code = 'ANALYSIS_TASK_INPUT_INVALID'
		throw error
	}
	return expected
}

function writeSpoolFile(jobId, content) {
	ensureSpoolRoot()
	const finalPath = expectedSpoolPath(jobId)
	const tempPath = path.join(
		SPOOL_ROOT,
		`.${jobId}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
	)
	let fd = null
	try {
		const iv = crypto.randomBytes(12)
		const cipher = crypto.createCipheriv('aes-256-gcm', spoolEncryptionKey(), iv)
		const ciphertext = Buffer.concat([cipher.update(content), cipher.final()])
		const encrypted = Buffer.concat([
			Buffer.from('RPTAJ1', 'ascii'),
			iv,
			cipher.getAuthTag(),
			ciphertext
		])
		fd = fs.openSync(tempPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600)
		fs.writeFileSync(fd, encrypted)
		fs.fsyncSync(fd)
		fs.closeSync(fd)
		fd = null
		fs.renameSync(tempPath, finalPath)
		try { fs.chmodSync(finalPath, 0o600) } catch (_) {}
		return finalPath
	} catch (error) {
		if (fd !== null) try { fs.closeSync(fd) } catch (_) {}
		try { fs.unlinkSync(tempPath) } catch (_) {}
		throw error
	}
}

function removeSpoolFile(jobId, candidate) {
	let inputPath
	try { inputPath = assertExpectedSpoolPath(jobId, candidate) } catch (_) { return false }
	try {
		fs.unlinkSync(inputPath)
		return true
	} catch (error) {
		if (error && error.code === 'ENOENT') return true
		logger.warn({ code: 'ANALYSIS_TASK_INPUT_DELETE_FAILED' }, 'analysis task input cleanup failed')
		return false
	}
}

function removeAnalysisSpoolFiles(files) {
	let removed = 0
	for (const item of Array.isArray(files) ? files : []) {
		if (removeSpoolFile(item && (item.jobId || item.job_id), item && (item.inputPath || item.input_path))) {
			removed += 1
		}
	}
	return removed
}

function cleanupTerminalSpoolFiles() {
	for (const row of store.listTerminalAnalysisInputs(64)) {
		if (removeSpoolFile(row.job_id, row.input_path)) {
			store.clearAnalysisJobInput(row.scope_hmac, row.analysis_key, row.input_path)
		}
	}
}

function reconcileOrphanSpoolFiles(nowMs = Date.now()) {
	ensureSpoolRoot()
	const referenced = new Set()
	for (const row of store.listAnalysisInputReferences()) {
		try { referenced.add(assertExpectedSpoolPath(row.job_id, row.input_path)) } catch (_) {}
	}
	let removed = 0
	for (const entry of fs.readdirSync(SPOOL_ROOT, { withFileTypes: true })) {
		const isFinal = /^aj_[A-Za-z0-9_-]{24}\.bin$/.test(entry.name)
		const isTemporary = /^\.aj_[A-Za-z0-9_-]{24}\.[0-9]+\.[a-f0-9]{16}\.tmp$/.test(entry.name)
		if (!isFinal && !isTemporary) continue
		const candidate = path.resolve(SPOOL_ROOT, entry.name)
		let stat
		try { stat = fs.lstatSync(candidate) } catch (_) { continue }
		const ageMs = Math.max(0, nowMs - Number(stat.mtimeMs || 0))
		const expired = isTemporary
			? ageMs >= SPOOL_TEMP_TTL_MS
			: !referenced.has(candidate) && ageMs >= SPOOL_ORPHAN_TTL_MS
		if (!expired) continue
		try {
			fs.unlinkSync(candidate)
			removed += 1
		} catch (_) {
			logger.warn({ code: 'ANALYSIS_TASK_ORPHAN_DELETE_FAILED' }, 'analysis task orphan cleanup failed')
		}
	}
	return removed
}

function readSpoolFile(row) {
	const inputPath = assertExpectedSpoolPath(row.job_id, row.input_path)
	const stat = fs.lstatSync(inputPath)
	if (!stat.isFile() || stat.isSymbolicLink()) {
		const error = new Error('analysis task input is not a regular file')
		error.code = 'ANALYSIS_TASK_INPUT_INVALID'
		throw error
	}
	if (stat.size < 6 + 12 + 16 + 1) {
		const error = new Error('analysis task input size changed')
		error.code = 'ANALYSIS_TASK_INPUT_INVALID'
		throw error
	}
	const encrypted = fs.readFileSync(inputPath)
	if (!encrypted.subarray(0, 6).equals(Buffer.from('RPTAJ1', 'ascii'))) {
		throw Object.assign(new Error('analysis task input format is invalid'), { code: 'ANALYSIS_TASK_INPUT_INVALID' })
	}
	try {
		const iv = encrypted.subarray(6, 18)
		const tag = encrypted.subarray(18, 34)
		const ciphertext = encrypted.subarray(34)
		const decipher = crypto.createDecipheriv('aes-256-gcm', spoolEncryptionKey(), iv)
		decipher.setAuthTag(tag)
		const content = Buffer.concat([decipher.update(ciphertext), decipher.final()])
		if (Number(row.input_size) > 0 && content.length !== Number(row.input_size)) {
			throw Object.assign(new Error('analysis task input size changed'), { code: 'ANALYSIS_TASK_INPUT_INVALID' })
		}
		return content
	} catch (error) {
		if (error && error.code === 'ANALYSIS_TASK_INPUT_INVALID') throw error
		throw Object.assign(new Error('analysis task input authentication failed'), { code: 'ANALYSIS_TASK_INPUT_INVALID' })
	}
}

const PUBLIC_ERROR_CLASSES = new Set([
	'upstream_transient',
	'transport_transient',
	'evidence_permanent',
	'schema_permanent',
	'input_permanent',
	'configuration_permanent',
	'internal_permanent',
	'unknown_permanent'
])
const RETRYABLE_ERROR_CLASSES = new Set(['upstream_transient', 'transport_transient'])
function persistedFailureClassification(row, errorCode) {
	const errorClass = String(row && row.error_class || '')
	if (PUBLIC_ERROR_CLASSES.has(errorClass)) {
		return { errorClass, retryable: RETRYABLE_ERROR_CLASSES.has(errorClass) }
	}
	return analysisCoordinator.classifyAnalysisError(errorCode)
}

function publicDiagnostic(row) {
	const serialized = String(row && row.diagnostic_json || '')
	if (!serialized) return null
	let parsed = null
	try { parsed = JSON.parse(serialized) } catch (_) { return null }
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
	return sanitizeAnalysisFailureDiagnostic(parsed)
}

function publicJob(row) {
	if (!row) return null
	const terminalEvent = row.terminal_schema_version
		? parseTrustedTerminalEventRow({
			schema_version: row.terminal_schema_version,
			support_ref: row.support_ref,
			trace_id: row.trace_id,
			status: row.terminal_status,
			code: row.terminal_code,
			error_class: row.terminal_error_class,
			stage: row.terminal_stage,
			retryable: row.terminal_retryable,
			safe_message_key: row.terminal_safe_message_key,
			diagnostic_json: row.terminal_diagnostic_json,
			release_json: row.terminal_release_json,
			versions_json: row.terminal_versions_json,
			server_time: row.terminal_server_time
		})
		: null
	if (row.terminal_schema_version && !terminalEvent) {
		throw Object.assign(new Error('analysis task terminal snapshot is invalid'), {
			code: 'TRUSTED_ANALYSIS_EVENT_INVALID'
		})
	}
	const status = terminalEvent ? terminalEvent.status : String(row.status || 'queued')
	const errorCode = status === 'failed'
		? String(terminalEvent ? terminalEvent.code : row.error_code || 'ANALYSIS_FAILED')
		: null
	const failure = status === 'failed'
		? terminalEvent
			? { errorClass: terminalEvent.errorClass, retryable: terminalEvent.retryable }
			: persistedFailureClassification(row, errorCode)
		: null
	const failureStageSource = terminalEvent ? terminalEvent.stage : row.error_stage
	const failureStage = status === 'failed' && /^[a-z][a-z0-9_-]{0,63}$/.test(String(failureStageSource || ''))
		? String(failureStageSource)
		: null
	const supportRef = SUPPORT_REF_RE.test(String(row.support_ref || '')) ? String(row.support_ref) : null
	const traceIdIsValid = TRACE_ID_RE.test(String(row.trace_id || ''))
	const terminalServerTime = terminalEvent ? terminalEvent.serverTime : null
	if (!supportRef || !traceIdIsValid) {
		throw Object.assign(new Error('analysis task is missing trusted identifiers'), {
			code: 'TRUSTED_ANALYSIS_EVENT_INVALID'
		})
	}
	if (['succeeded', 'failed'].includes(status) && !terminalEvent) {
		throw Object.assign(new Error('analysis task terminal snapshot is unavailable'), {
			code: 'TRUSTED_ANALYSIS_EVENT_INVALID'
		})
	}
	return {
		jobId: row.job_id,
		supportRef,
		status,
		stage: terminalEvent ? status : String(row.stage || status),
		progress: status === 'succeeded'
			? 100
			: Math.min(99, Math.max(0, Math.trunc(Number(row.progress) || 0))),
		resultReady: status === 'succeeded',
		errorCode,
		errorClass: failure ? failure.errorClass : null,
		failureStage,
		safeMessageKey: status === 'failed' && terminalEvent ? terminalEvent.safeMessageKey : null,
		diagnostic: status === 'failed'
			? terminalEvent ? terminalEvent.diagnostic : publicDiagnostic(row)
			: null,
		retryable: failure ? failure.retryable : false,
		attemptCount: Math.max(0, Math.trunc(Number(row.attempt_count) || 0)),
		createdAt: row.created_at || row.updated_at || null,
		updatedAt: row.updated_at || null,
		finishedAt: terminalServerTime || row.finished_at || null,
		serverTime: terminalServerTime
	}
}

function configureAnalysisTaskExecutor(nextExecutor) {
	if (typeof nextExecutor !== 'function') throw new TypeError('analysis task executor must be a function')
	executor = nextExecutor
}

function safeErrorCode(error) {
	return normalizeTerminalCode(error && error.code)
}

async function runTask(row) {
	if (!executor || !row || !row.input_path) return
	let content = null
	let lastStageDiagnostic = null
	// Only the process whose coordinator actually invoked `execute` owns the
	// lease. A second PM2 worker may have selected the same queued row just
	// before the first worker claimed it, then wait on that foreign lease. Such
	// an observer must never fail the owner or delete the only recoverable input.
	let ownedLeaseOwner = null
	try {
		const scope = decryptValue(row.scope_ciphertext, scopeEncryptionKey())
		if (buildAnalysisScopeHmac(scope) !== row.scope_hmac) {
			throw Object.assign(new Error('analysis task scope mismatch'), { code: 'ANALYSIS_TASK_SCOPE_INVALID' })
		}
		content = readSpoolFile(row)
		const identity = buildAnalysisIdentity({
			content,
			scope,
			inputKind: row.input_kind
		})
		if (identity.analysisKey !== row.analysis_key || identity.scopeHmac !== row.scope_hmac) {
			throw Object.assign(new Error('analysis task identity mismatch'), { code: 'ANALYSIS_TASK_INPUT_INVALID' })
		}

		await analysisCoordinator.runCoordinatedAnalysis({
			content,
			scope,
			inputKind: row.input_kind,
			execute: async (coordinatorIdentity) => {
				const claimed = store.getAnalysisJob(row.scope_hmac, row.analysis_key)
				const leaseOwner = claimed && claimed.lease_owner
				if (!leaseOwner || claimed.status !== 'processing') {
					throw Object.assign(new Error('analysis task lease is missing'), { code: 'ANALYSIS_LEASE_LOST' })
				}
				ownedLeaseOwner = leaseOwner
				const onStage = (stage, progress, detail) => {
					lastStageDiagnostic = analysisCoordinator.buildSafeAnalysisFailureDiagnostic({
						analysisDiagnostic: detail
					})
					store.updateAnalysisJobProgress(
						row.scope_hmac,
						row.analysis_key,
						leaseOwner,
						stage,
						progress
					)
				}
				try {
					return await executor({
						content,
						onStage,
						documentId: coordinatorIdentity.documentId
					})
				} catch (error) {
					if (error && typeof error === 'object' && lastStageDiagnostic) {
						try { error.analysisDiagnostic = lastStageDiagnostic } catch (_) {}
					}
					throw error
				}
			}
		})
	} catch (error) {
		const failure = analysisCoordinator.describeAnalysisFailure(error)
		let terminalTransitioned = false
		// runCoordinatedAnalysis normally marks the leased row failed. Failures
		// before a lease is claimed still need a terminal, non-recovering state.
		// Never copy a lease owner out of the current row: that lease may belong to
		// another worker which this invocation only waited for.
		const current = store.getAnalysisJob(row.scope_hmac, row.analysis_key)
		if (
			ownedLeaseOwner &&
			current &&
			current.status === 'processing' &&
			current.lease_owner === ownedLeaseOwner
		) {
			terminalTransitioned = store.failAnalysisJob(
				row.scope_hmac,
				row.analysis_key,
				ownedLeaseOwner,
				failure.code,
				failure
			)
		} else if (!ownedLeaseOwner && current && current.status === 'queued') {
			terminalTransitioned = store.failQueuedAnalysisJob(
				row.scope_hmac,
				row.analysis_key,
				failure.code,
				failure
			)
		}
		if (terminalTransitioned) {
			const terminal = store.getAnalysisJob(row.scope_hmac, row.analysis_key) || {}
			analysisCoordinator.logTrustedTerminalEvent(
				store.getTrustedAnalysisEventBySupportRef(terminal.support_ref),
				'error'
			)
		}
	} finally {
		content = null
		const current = store.getAnalysisJob(row.scope_hmac, row.analysis_key)
		const cleanupEligible = current && ['succeeded', 'failed'].includes(current.status)
		// There is no automatic retry consumer for failed rows. Retaining a credit
		// report after a terminal failure would therefore add privacy exposure
		// without improving recovery; an explicit retry uploads a fresh copy.
		// While another lease is processing (including observer timeout), keep the
		// recoverable input so the owning/next worker can finish it.
		if (cleanupEligible && removeSpoolFile(row.job_id, row.input_path)) {
			store.clearAnalysisJobInput(row.scope_hmac, row.analysis_key, row.input_path)
		}
	}
}

async function scanAnalysisTasks() {
	if (scanRunning || !executor) return
	scanRunning = true
	try {
		cleanupTerminalSpoolFiles()
		if (Date.now() - lastSpoolReconcileAt >= SPOOL_RECONCILE_INTERVAL_MS) {
			reconcileOrphanSpoolFiles()
			lastSpoolReconcileAt = Date.now()
		}
		const jobs = store.listRecoverableAnalysisJobs(2)
		for (const row of jobs) await runTask(row)
	} finally {
		scanRunning = false
	}
}

function scheduleAnalysisTaskScan() {
	if (scanScheduled) return
	scanScheduled = true
	setImmediate(() => {
		scanScheduled = false
		scanAnalysisTasks().catch((error) => {
			logger.error({ code: safeErrorCode(error) }, 'analysis task scan failed')
		})
	})
}

function startAnalysisTaskWorker() {
	if (scanTimer) return
	ensureSpoolRoot()
	scheduleAnalysisTaskScan()
	scanTimer = setInterval(scheduleAnalysisTaskScan, SCAN_INTERVAL_MS)
	if (typeof scanTimer.unref === 'function') scanTimer.unref()
}

function stopAnalysisTaskWorkerForTests() {
	if (scanTimer) clearInterval(scanTimer)
	scanTimer = null
	scanScheduled = false
	lastSpoolReconcileAt = 0
}

function enqueueAnalysisTask({ content, scope, inputKind = 'credit-report-pdf' }) {
	if (!Buffer.isBuffer(content) || content.length < 1) throw new TypeError('analysis task content is required')
	// 持久异步任务的结果由加密 SQLite 缓存承载。没有进程稳定密钥时，
	// coordinator 只能使用进程内缓存，无法保证重启后恢复或由 result 接口读取，
	// 因此必须在接收 PDF 前明确拒绝，不能创建一个注定失败的“可恢复”任务。
	if (!analysisCoordinator.cacheRuntimeStatus().persistent) {
		const error = new Error('persistent analysis task runtime is unavailable')
		error.code = 'ANALYSIS_TASK_PERSISTENCE_UNAVAILABLE'
		throw error
	}
	const identity = buildAnalysisIdentity({ content, scope, inputKind })
	const jobId = newJobId()
	const inputPath = writeSpoolFile(jobId, content)
	let outcome
	try {
		outcome = store.enqueueAnalysisJob({
			scopeHmac: identity.scopeHmac,
			analysisKey: identity.analysisKey,
			documentId: identity.documentId,
			jobId,
			inputKind,
			inputPath,
			inputSize: content.length,
			scopeCiphertext: encryptValue(scope, scopeEncryptionKey())
		})
	} catch (error) {
		removeSpoolFile(jobId, inputPath)
		throw error
	}
	if (outcome.reused) {
		removeSpoolFile(jobId, inputPath)
	}
	else scheduleAnalysisTaskScan()
	// A new explicit submission replaces any retained input from an earlier
	// transient failure. Cached completion can also make an old spool obsolete.
	if (outcome.replacedJobId && outcome.replacedInputPath) {
		removeSpoolFile(outcome.replacedJobId, outcome.replacedInputPath)
	}
	return {
		...publicJob(outcome.job),
		reused: outcome.reused === true,
		cacheHit: outcome.cacheHit === true
	}
}

function getAnalysisTask(scope, jobId) {
	if (!JOB_ID_RE.test(String(jobId || ''))) return null
	return publicJob(store.getAnalysisJobByPublicId(buildAnalysisScopeHmac(scope), jobId))
}

function getLatestAnalysisTask(scope) {
	return publicJob(store.getLatestPublicAnalysisJob(buildAnalysisScopeHmac(scope)))
}

function getAnalysisSupportEvent(scope, supportRef) {
	return store.getScopedTrustedAnalysisEvent(buildAnalysisScopeHmac(scope), supportRef)
}

function getAnalysisSupportEventForOps(supportRef) {
	return store.getTrustedAnalysisEventBySupportRef(supportRef)
}

function decryptCachedAnalysis(row, job) {
	if (!row || !row.encrypted_payload) return null
	try {
		const plaintext = decryptValue(row.encrypted_payload, cacheEncryptionKey())
		const payload = JSON.parse(plaintext)
		return analysisCoordinator.validateTaskCanonicalRecord(
			job,
			payload,
			row.result_hash,
			row.versions_json
		)
	} catch (_) {
		// Do not expose ciphertext, parsed business data or validation details.
		return null
	}
}

function getAnalysisTaskResult(scope, jobId) {
	if (!JOB_ID_RE.test(String(jobId || ''))) return null
	const scopeHmac = buildAnalysisScopeHmac(scope)
	const job = store.getAnalysisJobByPublicId(scopeHmac, jobId)
	if (!job) return null
	const projectedJob = publicJob(job)
	if (projectedJob.status !== 'succeeded') return { job: projectedJob, result: null }
	const record = decryptCachedAnalysis(
		store.getAnalysisResult(scopeHmac, job.analysis_key),
		job
	)
	if (!record) {
		const terminalEvent = store.invalidateAnalysisResult(
			scopeHmac,
			job.analysis_key,
			'CACHE_INTEGRITY_FAILED'
		)
		if (terminalEvent) analysisCoordinator.logTrustedTerminalEvent(terminalEvent, 'error')
		const error = new Error('analysis task result is unavailable')
		error.code = 'ANALYSIS_RESULT_UNAVAILABLE'
		throw error
	}
	const runtime = analysisCoordinator.cacheRuntimeStatus()
	const data = JSON.parse(JSON.stringify(record.canonicalResult))
	data.analysisKey = job.analysis_key
	data.resultHash = record.resultHash
	data.derivation_meta = {
		...(data.derivation_meta || {}),
		analysis_key: job.analysis_key,
		result_hash: record.resultHash,
		versions: record.versions
	}
	data.analysis_meta = {
		analysisKey: job.analysis_key,
		resultHash: record.resultHash,
		versions: record.versions,
		inputKind: job.input_kind,
		authoritative: true,
		authority: 'server-deterministic',
		authoritativeScope: Array.isArray(data.evidence_meta && data.evidence_meta.authoritative_scope)
			? data.evidence_meta.authoritative_scope.filter((field) => typeof field === 'string')
			: [],
		cachePolicy: {
			mode: runtime.mode,
			persistent: runtime.persistent,
			stableAcrossRestart: runtime.stableAcrossRestart
		},
		cacheHit: false,
		cacheSource: 'async-job'
	}
	return {
		job: projectedJob,
		result: data,
		analysis: {
			analysisKey: job.analysis_key,
			resultHash: record.resultHash,
			cacheHit: false,
			cacheSource: 'async-job'
		}
	}
}

function acknowledgeAnalysisTask(scope, jobId) {
	if (!JOB_ID_RE.test(String(jobId || ''))) return false
	return store.acknowledgeAnalysisJob(buildAnalysisScopeHmac(scope), jobId)
}

module.exports = {
	JOB_ID_RE,
	SPOOL_ROOT,
	configureAnalysisTaskExecutor,
	startAnalysisTaskWorker,
	stopAnalysisTaskWorkerForTests,
	removeAnalysisSpoolFiles,
	reconcileOrphanSpoolFiles,
	enqueueAnalysisTask,
	getAnalysisTask,
	getLatestAnalysisTask,
	getAnalysisSupportEvent,
	getAnalysisSupportEventForOps,
	getAnalysisTaskResult,
	acknowledgeAnalysisTask,
	scanAnalysisTasks
}
