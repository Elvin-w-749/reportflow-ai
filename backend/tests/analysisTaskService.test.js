'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const Database = require('better-sqlite3')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-analysis-task-'))
process.env.DATA_DIR = dataDir
process.env.ANALYSIS_CACHE_SECRET = 'analysis-task-test-secret-at-least-32-bytes'
process.env.NODE_ENV = 'test'

const store = require('../backend/db/store')
const analysisCoordinator = require('../backend/services/analysisCoordinator')
const {
	analysisVersions,
	buildAnalysisScopeHmac,
	buildAnalysisIdentity,
	buildResultHash
} = require('../backend/services/analysisIdentity')
const taskService = require('../backend/services/analysisTaskService')
const { attachEvidenceV2 } = require('./evidenceCanonicalFixture')

function canonical(marker, identity) {
	return attachEvidenceV2({
		derivation_meta: {
			mode: 'deterministic-v1',
			anchor_date: '2026-06-30',
			model_role: 'raw-facts-only',
			rules_version: 'credit-deterministic-v1'
		},
		_coverage: {
			truncated: false,
			salvaged_truncated: false,
			llm_output_truncated: false,
			llm_finish_reason: 'stop'
		},
		deterministic_dimensions: {
			totalAccountCount: 0,
			activeAccountCount: 0,
			settledAccountCount: 0,
			creditCardCount: 0,
			loanCount: 0,
			nonBankLoanCount: 0,
			totalDebt: 0,
			totalLoanBalance: 0,
			usedCardLimit: 0,
			cardUtilizationUsed: 0,
			debtRatio: 0,
			cardUtilizationRate: 0,
			q1: 0,
			q3: 0,
			q6: 0,
			q12: 0,
			loanQueryCount: 0,
			cardQueryCount: 0,
			overdueCount: 0,
			m1Count: 0,
			m2Count: 0,
			m3Count: 0
		},
		credit_debt: {
			total_debt: 0,
			debt_ratio: 0,
			credit_loans: { total_balance: 0 },
			credit_cards: { total_limit: 0, total_used: 0, utilization_used: 0, usage_rate: 0, shared_group_count: 0 }
		},
		query_analysis: {
			summary: {
				last_1m: { total: 0 },
				last_3m: { total: 0 },
				last_6m: { total: 0 },
				last_12m: { total: 0 }
			}
		},
		primary_rule_score: {
			score: 100,
			metrics: {
				totalAccounts: 0,
				activeNonBankLoanCount: 0,
				cardUsageRate: 0,
				bigInstallmentTotal: 0,
				q6: 0,
				sameDayTriggered: false
			}
		},
		six_dimensions: {
			credit_history: 80,
			query_frequency: 90,
			account_structure: 70,
			repayment_record: 100
		},
		marker
	}, identity)
}

function encryptAnalysisCachePayload(payload) {
	const key = crypto
		.createHash('sha256')
		.update('reportflow-analysis-cache-aes256gcm-v1\0')
		.update(process.env.ANALYSIS_CACHE_SECRET)
		.digest()
	const iv = crypto.randomBytes(12)
	const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
	const ciphertext = Buffer.concat([
		cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
		cipher.final()
	])
	return [iv, cipher.getAuthTag(), ciphertext]
		.map((part) => part.toString('base64url'))
		.join('.')
}

async function waitFor(check, timeoutMs = 3000) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const value = check()
		if (value) return value
		await new Promise((resolve) => setTimeout(resolve, 20))
	}
	throw new Error('condition timed out')
}

test('persisted task encrypts input, is scope-isolated, and retrieves coordinator cache compatibly', async (t) => {
	t.after(() => taskService.stopAnalysisTaskWorkerForTests())
	let releaseExecution
	const executionGate = new Promise((resolve) => { releaseExecution = resolve })
	let executions = 0
	let observedDocumentId = ''
	taskService.configureAnalysisTaskExecutor(async ({ onStage, documentId }) => {
		executions += 1
		observedDocumentId = documentId
		onStage('pdf_extract', 15)
		await executionGate
		onStage('fact_extraction', 80)
		onStage('persisting', 95)
		return canonical(321, { documentId, inputKind: 'credit-report-pdf' })
	})

	const source = Buffer.from('%PDF-1.7\nSENSITIVE_PDF_CONTENT_SENTINEL\n%%EOF')
	const task = taskService.enqueueAnalysisTask({
		content: source,
		scope: 'user:task-owner-A',
		inputKind: 'credit-report-pdf'
	})
	assert.match(task.jobId, /^aj_[A-Za-z0-9_-]{24}$/)
	const spoolPath = path.join(taskService.SPOOL_ROOT, `${task.jobId}.bin`)
	const encrypted = fs.readFileSync(spoolPath)
	assert.equal(encrypted.subarray(0, 6).toString('ascii'), 'RPTAJ1')
	assert.equal(encrypted.includes(Buffer.from('%PDF-')), false)
	assert.equal(encrypted.includes(Buffer.from('SENSITIVE_PDF_CONTENT_SENTINEL')), false)

	assert.equal(taskService.getAnalysisTask('user:task-owner-B', task.jobId), null)
	releaseExecution()
	const succeeded = await waitFor(() => {
		const current = taskService.getAnalysisTask('user:task-owner-A', task.jobId)
		return current && current.status === 'succeeded' ? current : null
	})
	assert.equal(succeeded.progress, 100)
	assert.equal(executions, 1)
	assert.equal(observedDocumentId, buildAnalysisIdentity({
		content: source,
		scope: 'user:task-owner-A',
		inputKind: 'credit-report-pdf'
	}).documentId)
	assert.equal(fs.existsSync(spoolPath), false)

	const result = taskService.getAnalysisTaskResult('user:task-owner-A', task.jobId)
	assert.equal(result.result.marker, 321)
	assert.match(result.result.analysisKey, /^ak_v3_/)
	assert.match(result.result.resultHash, /^rh_v1_/)
	assert.equal(result.result.analysis_meta.cachePolicy.persistent, true)
	assert.equal(result.result.analysis_meta.cachePolicy.stableAcrossRestart, true)
	assert.deepEqual(
		result.result.analysis_meta.authoritativeScope,
		result.result.evidence_meta.authoritative_scope
	)
	const completedIdentity = buildAnalysisIdentity({
		content: source,
		scope: 'user:task-owner-A',
		inputKind: 'credit-report-pdf'
	})
	const persistedBinding = JSON.parse(
		store.getAnalysisResult(completedIdentity.scopeHmac, completedIdentity.analysisKey).versions_json
	)
	assert.equal(persistedBinding.schema, 'rpt.analysis-cache-binding/1.0')
	assert.equal(persistedBinding.documentId, completedIdentity.documentId)
	assert.equal(taskService.getLatestAnalysisTask('user:task-owner-A').jobId, task.jobId)
	assert.equal(taskService.acknowledgeAnalysisTask('user:task-owner-B', task.jobId), false)
	assert.equal(taskService.acknowledgeAnalysisTask('user:task-owner-A', task.jobId), true)
	assert.equal(taskService.getLatestAnalysisTask('user:task-owner-A'), null)

	const reused = taskService.enqueueAnalysisTask({
		content: source,
		scope: 'user:task-owner-A',
		inputKind: 'credit-report-pdf'
	})
	// An acknowledged cache delivery is closed. A new submission must expose a
	// fresh, unacknowledged public job even though no analysis executes again.
	assert.notEqual(reused.jobId, task.jobId)
	assert.equal(reused.status, 'succeeded')
	assert.equal(reused.cacheHit, true)
	assert.equal(executions, 1)
	assert.equal(fs.existsSync(path.join(taskService.SPOOL_ROOT, `${reused.jobId}.bin`)), false)
	assert.equal(taskService.getLatestAnalysisTask('user:task-owner-A').jobId, reused.jobId)
	const responseLostRetry = taskService.enqueueAnalysisTask({
		content: source,
		scope: 'user:task-owner-A',
		inputKind: 'credit-report-pdf'
	})
	assert.notEqual(responseLostRetry.jobId, reused.jobId)
	assert.equal(responseLostRetry.cacheHit, true)
	assert.equal(executions, 1)
	assert.equal(taskService.getLatestAnalysisTask('user:task-owner-A').jobId, responseLostRetry.jobId)
	// An older page can only acknowledge its own delivery. It cannot hide the
	// newer upload whose response may have been lost.
	assert.equal(taskService.acknowledgeAnalysisTask('user:task-owner-A', reused.jobId), true)
	assert.equal(taskService.getLatestAnalysisTask('user:task-owner-A').jobId, responseLostRetry.jobId)
	assert.equal(taskService.getAnalysisTaskResult('user:task-owner-A', reused.jobId).result.marker, 321)
	assert.equal(taskService.acknowledgeAnalysisTask('user:task-owner-A', responseLostRetry.jobId), true)
	assert.equal(taskService.getLatestAnalysisTask('user:task-owner-A'), null)

	const retrySource = Buffer.from('%PDF-1.7\nRETRY_AFTER_FAILURE\n%%EOF')
	taskService.configureAnalysisTaskExecutor(async () => {
		const error = new Error('schema details containing customer data must never persist')
		error.code = 'FACT_SCHEMA_INVALID'
		throw error
	})
	const failedAttempt = taskService.enqueueAnalysisTask({
		content: retrySource,
		scope: 'user:task-owner-A',
		inputKind: 'credit-report-pdf'
	})
	const failedPublic = await waitFor(() => {
		const current = taskService.getAnalysisTask('user:task-owner-A', failedAttempt.jobId)
		return current?.status === 'failed' ? current : null
	})
	assert.equal(failedPublic.retryable, false)
	assert.equal(failedPublic.errorClass, 'schema_permanent')
	assert.equal(failedPublic.failureStage, 'fact-extraction')
	assert.deepEqual(failedPublic.diagnostic, { version: 1 })
	assert.equal(fs.existsSync(path.join(taskService.SPOOL_ROOT, `${failedAttempt.jobId}.bin`)), false)
	const latestFailed = taskService.getLatestAnalysisTask('user:task-owner-A')
	assert.equal(latestFailed.jobId, failedAttempt.jobId)
	assert.equal(latestFailed.status, 'failed')
	assert.equal(latestFailed.errorCode, 'FACT_SCHEMA_INVALID')
	assert.equal(latestFailed.retryable, false)
	assert.equal(taskService.getLatestAnalysisTask('user:task-owner-B'), null)
	assert.equal(taskService.acknowledgeAnalysisTask('user:task-owner-B', failedAttempt.jobId), false)
	assert.equal(taskService.acknowledgeAnalysisTask('user:task-owner-A', failedAttempt.jobId), true)
	assert.equal(taskService.getLatestAnalysisTask('user:task-owner-A'), null)

	taskService.configureAnalysisTaskExecutor(async ({ documentId }) => canonical(654, {
		documentId,
		inputKind: 'credit-report-pdf'
	}))
	const retry = taskService.enqueueAnalysisTask({
		content: retrySource,
		scope: 'user:task-owner-A',
		inputKind: 'credit-report-pdf'
	})
	assert.notEqual(retry.jobId, failedAttempt.jobId)
	await waitFor(() => taskService.getAnalysisTask('user:task-owner-A', retry.jobId)?.status === 'succeeded')
	assert.equal(taskService.getAnalysisTaskResult('user:task-owner-A', retry.jobId).result.marker, 654)
	assert.equal(taskService.acknowledgeAnalysisTask('user:task-owner-A', retry.jobId), true)

	const transientSource = Buffer.from('%PDF-1.7\nTRANSIENT_UPSTREAM_FAILURE\n%%EOF')
	taskService.configureAnalysisTaskExecutor(async ({ onStage }) => {
		onStage('fact_extraction', 80, {
			expectedCount: 10,
			actualCount: 7,
			rawText: 'CUSTOMER_PII_MUST_NOT_PERSIST'
		})
		const error = new Error('UPSTREAM_MESSAGE_WITH_PII_MUST_NOT_PERSIST')
		error.code = 'ANALYSIS_UPSTREAM_FAILED'
		error.httpStatus = 503
		error.failedChecks = ['LEDGER_READY', 'PRIVATE_CHECK_DETAIL']
		error.diagnostic = {
			customerName: 'PRIVATE_CUSTOMER_NAME',
			graph: { criticalUnresolvedCount: 2 },
			ledger: { criticalFailureCount: 1 },
			derived: { blockedMetricCount: 3 }
		}
		throw error
	})
	const transientAttempt = taskService.enqueueAnalysisTask({
		content: transientSource,
		scope: 'user:task-owner-A',
		inputKind: 'credit-report-pdf'
	})
	const transientFailed = await waitFor(() => {
		const current = taskService.getAnalysisTask('user:task-owner-A', transientAttempt.jobId)
		return current?.status === 'failed' ? current : null
	})
	assert.equal(transientFailed.retryable, true)
	assert.equal(transientFailed.errorClass, 'upstream_transient')
	assert.equal(transientFailed.failureStage, 'fact-extraction')
	assert.equal(transientFailed.diagnostic.httpStatus, 503)
	assert.equal(transientFailed.diagnostic.expectedCount, 10)
	assert.equal(transientFailed.diagnostic.actualCount, 7)
	assert.equal(transientFailed.diagnostic.failedCheckCount, 1)
	assert.deepEqual(transientFailed.diagnostic.failedChecks, ['LEDGER_READY'])
	assert.equal(transientFailed.diagnostic.evidenceIssueCount, 6)
	const transientSpoolPath = path.join(taskService.SPOOL_ROOT, `${transientAttempt.jobId}.bin`)
	assert.equal(fs.existsSync(transientSpoolPath), false)
	const transientIdentity = buildAnalysisIdentity({
		content: transientSource,
		scope: 'user:task-owner-A',
		inputKind: 'credit-report-pdf'
	})
	const persistedTransient = store.getAnalysisJob(
		transientIdentity.scopeHmac,
		transientIdentity.analysisKey
	)
	assert.doesNotMatch(persistedTransient.diagnostic_json, /CUSTOMER|PRIVATE|PII|MESSAGE/)

	taskService.configureAnalysisTaskExecutor(async ({ documentId }) => canonical(655, {
		documentId,
		inputKind: 'credit-report-pdf'
	}))
	const transientRetry = taskService.enqueueAnalysisTask({
		content: transientSource,
		scope: 'user:task-owner-A',
		inputKind: 'credit-report-pdf'
	})
	assert.notEqual(transientRetry.jobId, transientAttempt.jobId)
	assert.equal(fs.existsSync(transientSpoolPath), false)
	await waitFor(() => taskService.getAnalysisTask('user:task-owner-A', transientRetry.jobId)?.status === 'succeeded')
	assert.equal(taskService.getAnalysisTaskResult('user:task-owner-A', transientRetry.jobId).result.marker, 655)
	assert.equal(taskService.acknowledgeAnalysisTask('user:task-owner-A', transientRetry.jobId), true)

	const evidenceSource = Buffer.from('%PDF-1.7\nEVIDENCE_DIAGNOSTIC_ROUNDTRIP\n%%EOF')
	const privateEvidenceSentinel = 'PRIVATE_CUSTOMER_INSTITUTION_AMOUNT_2026_08_17'
	taskService.configureAnalysisTaskExecutor(async () => {
		const error = new Error(`publication blocked for ${privateEvidenceSentinel}`)
		error.code = 'EVIDENCE_PUBLICATION_BLOCKED'
		error.httpStatus = 422
		error.failedChecks = [
			'EVIDENCE_COMPLETE',
			'LEDGER_READY',
			'DERIVED_VALIDATED',
			privateEvidenceSentinel
		]
		error.diagnostic = {
			failedChecks: error.failedChecks,
			manifest: {
				status: 'complete',
				declaredPageCount: 12,
				processedPageCount: 12,
				completePageCount: 12,
				rejectedPageCount: 0,
				missingPageCount: 0,
				duplicatePageCount: 0,
				reportText: privateEvidenceSentinel
			},
			graph: {
				status: 'rejected',
				nodeCount: 91,
				criticalUnresolvedCount: 5,
				unresolvedReasons: [
					{ value: 'AMBIGUOUS_CARD_SOURCE_BUNDLE', count: 4 },
					{ value: 'UNCLAIMED_SOURCE_INSTALLMENT_SIGNAL', count: 1 },
					{ value: privateEvidenceSentinel, count: 99 }
				],
				unresolvedByTarget: [
					{
						name: 'card.credit_limit',
						count: 4,
						reasons: [{ value: 'AMBIGUOUS_CARD_SOURCE_BUNDLE', count: 4 }]
					},
					{
						name: 'source.installment',
						count: 1,
						reasons: [{ value: 'UNCLAIMED_SOURCE_INSTALLMENT_SIGNAL', count: 1 }]
					}
				],
				documentId: privateEvidenceSentinel
			},
			ledger: {
				status: 'blocked',
				criticalFailureCount: 4,
				sections: [{
					name: 'credit_card_details',
					expectedCount: 5,
					acceptedCount: 4,
					declaredCount: 5,
					status: 'incomplete',
					basis: 'source-account-overview-pdf-geometry-v2',
					institution: privateEvidenceSentinel
				}],
				conflictCodes: [{ value: 'CARD_FACILITY_RELATION_UNRESOLVED', count: 1 }],
				amount: 888888
			},
			derived: {
				status: 'blocked',
				blockedMetricCount: 6,
				blockedReasons: [{ value: 'FACT_LEDGER_BLOCKED', count: 6 }],
				blockedFormulas: [{ value: 'total-debt-v2', count: 1 }],
				privateModelOutput: privateEvidenceSentinel
			},
			privatePath: `C:/reports/${privateEvidenceSentinel}.pdf`
		}
		throw error
	})
	const evidenceAttempt = taskService.enqueueAnalysisTask({
		content: evidenceSource,
		scope: 'user:task-owner-A',
		inputKind: 'credit-report-pdf'
	})
	const evidenceFailed = await waitFor(() => {
		const current = taskService.getAnalysisTask('user:task-owner-A', evidenceAttempt.jobId)
		return current?.status === 'failed' ? current : null
	})
	assert.equal(evidenceFailed.errorClass, 'evidence_permanent')
	assert.equal(evidenceFailed.retryable, false)
	assert.equal(evidenceFailed.diagnostic.httpStatus, 422)
	assert.equal(evidenceFailed.diagnostic.failedCheckCount, 3)
	assert.equal(evidenceFailed.diagnostic.evidenceIssueCount, 15)
	assert.equal(evidenceFailed.diagnostic.graph.criticalUnresolvedCount, 5)
	assert.equal(evidenceFailed.diagnostic.ledger.sections[0].expectedCount, 5)
	assert.equal(evidenceFailed.diagnostic.ledger.sections[0].acceptedCount, 4)
	assert.equal(evidenceFailed.diagnostic.derived.blockedMetricCount, 6)
	assert.doesNotMatch(JSON.stringify(evidenceFailed.diagnostic), /PRIVATE|2026_08_17|institution|amount|documentId|privatePath/)
	const evidenceIdentity = buildAnalysisIdentity({
		content: evidenceSource,
		scope: 'user:task-owner-A',
		inputKind: 'credit-report-pdf'
	})
	const persistedEvidence = store.getAnalysisJob(
		evidenceIdentity.scopeHmac,
		evidenceIdentity.analysisKey
	)
	assert.deepEqual(JSON.parse(persistedEvidence.diagnostic_json), evidenceFailed.diagnostic)
	assert.deepEqual(
		taskService.getLatestAnalysisTask('user:task-owner-A').diagnostic,
		evidenceFailed.diagnostic
	)
	assert.deepEqual(
		taskService.getAnalysisTaskResult('user:task-owner-A', evidenceAttempt.jobId).job.diagnostic,
		evidenceFailed.diagnostic
	)

	const diagnosticDb = new Database(store.DATA_FILE)
	diagnosticDb.prepare('UPDATE analysis_jobs SET diagnostic_json = ? WHERE job_id = ?')
		.run('not-json', evidenceAttempt.jobId)
	assert.deepEqual(
		taskService.getAnalysisTask('user:task-owner-A', evidenceAttempt.jobId).diagnostic,
		evidenceFailed.diagnostic
	)
	diagnosticDb.prepare('UPDATE analysis_jobs SET diagnostic_json = NULL WHERE job_id = ?')
		.run(evidenceAttempt.jobId)
	diagnosticDb.close()
	assert.deepEqual(
		taskService.getAnalysisTask('user:task-owner-A', evidenceAttempt.jobId).diagnostic,
		evidenceFailed.diagnostic
	)
	assert.equal(taskService.acknowledgeAnalysisTask('user:task-owner-A', evidenceAttempt.jobId), true)

	const unsupportedOcrSource = Buffer.from('%PDF-1.7\nUNSUPPORTED_OCR_EVIDENCE\n%%EOF')
	taskService.configureAnalysisTaskExecutor(async () => {
		const error = new Error('unsupported authoritative OCR evidence')
		error.code = 'OCR_STRUCTURED_EVIDENCE_UNAVAILABLE'
		throw error
	})
	const unsupportedOcr = taskService.enqueueAnalysisTask({
		content: unsupportedOcrSource,
		scope: 'user:task-owner-A',
		inputKind: 'credit-report-pdf'
	})
	const unsupportedOcrFailed = await waitFor(() => {
		const current = taskService.getAnalysisTask('user:task-owner-A', unsupportedOcr.jobId)
		return current?.status === 'failed' ? current : null
	})
	assert.equal(unsupportedOcrFailed.errorCode, 'OCR_STRUCTURED_EVIDENCE_UNAVAILABLE')
	assert.equal(unsupportedOcrFailed.retryable, false)
	assert.equal(taskService.getAnalysisTaskResult('user:task-owner-A', unsupportedOcr.jobId).result, null)
})

test('async result rejects a re-encrypted foreign-document cache before adding authoritative metadata', async (t) => {
	t.after(() => taskService.stopAnalysisTaskWorkerForTests())
	const scope = 'user:task-forged-cache'
	const source = Buffer.from('%PDF-1.7\nFORGED_LEGACY_CACHE\n%%EOF')
	taskService.configureAnalysisTaskExecutor(async ({ documentId }) => canonical(656, {
		documentId,
		inputKind: 'credit-report-pdf'
	}))
	const task = taskService.enqueueAnalysisTask({
		content: source,
		scope,
		inputKind: 'credit-report-pdf'
	})
	await waitFor(() => taskService.getAnalysisTask(scope, task.jobId)?.status === 'succeeded')

	const identity = buildAnalysisIdentity({
		content: source,
		scope,
		inputKind: 'credit-report-pdf'
	})
	const foreignIdentity = buildAnalysisIdentity({
		content: Buffer.from('%PDF-1.7\nA_DIFFERENT_DOCUMENT\n%%EOF'),
		scope,
		inputKind: 'credit-report-pdf'
	})
	const forged = canonical(999, foreignIdentity)
	const resultHash = buildResultHash(forged)
	const encryptedPayload = encryptAnalysisCachePayload({
		analysisKey: identity.analysisKey,
		versions: analysisVersions(),
		resultHash,
		canonicalResult: forged
	})
	const database = new Database(store.DATA_FILE)
	const storedBinding = JSON.parse(database.prepare(
		`SELECT versions_json FROM analysis_results
		 WHERE scope_hmac = ? AND analysis_key = ?`
	).get(identity.scopeHmac, identity.analysisKey).versions_json)
	storedBinding.documentId = foreignIdentity.documentId
	database.prepare(
		`UPDATE analysis_results
		 SET encrypted_payload = ?, result_hash = ?, versions_json = ?
		 WHERE scope_hmac = ? AND analysis_key = ?`
	).run(
		encryptedPayload,
		resultHash,
		JSON.stringify(storedBinding),
		identity.scopeHmac,
		identity.analysisKey
	)
	database.close()

	assert.throws(
		() => taskService.getAnalysisTaskResult(scope, task.jobId),
		(error) => error && error.code === 'ANALYSIS_RESULT_UNAVAILABLE'
	)
	assert.equal(store.getAnalysisResult(identity.scopeHmac, identity.analysisKey), null)
	assert.equal(taskService.getAnalysisTask(scope, task.jobId).status, 'failed')
})

test('async result rejects legacy cache rows without a persisted document binding', async (t) => {
	t.after(() => taskService.stopAnalysisTaskWorkerForTests())
	const scope = 'user:task-unbound-cache'
	const source = Buffer.from('%PDF-1.7\nUNBOUND_CACHE_ROW\n%%EOF')
	taskService.configureAnalysisTaskExecutor(async ({ documentId }) => canonical(657, {
		documentId,
		inputKind: 'credit-report-pdf'
	}))
	const task = taskService.enqueueAnalysisTask({
		content: source,
		scope,
		inputKind: 'credit-report-pdf'
	})
	await waitFor(() => taskService.getAnalysisTask(scope, task.jobId)?.status === 'succeeded')
	const identity = buildAnalysisIdentity({
		content: source,
		scope,
		inputKind: 'credit-report-pdf'
	})

	const database = new Database(store.DATA_FILE)
	database.prepare(
		`UPDATE analysis_results
		 SET versions_json = ?
		 WHERE scope_hmac = ? AND analysis_key = ?`
	).run(JSON.stringify(analysisVersions()), identity.scopeHmac, identity.analysisKey)
	database.close()

	assert.throws(
		() => taskService.getAnalysisTaskResult(scope, task.jobId),
		(error) => error && error.code === 'ANALYSIS_RESULT_UNAVAILABLE'
	)
	assert.equal(store.getAnalysisResult(identity.scopeHmac, identity.analysisKey), null)
	assert.equal(taskService.getAnalysisTask(scope, task.jobId).status, 'failed')
})

test('analysis retry classification is explicit and deny-by-default', () => {
	for (const code of [
		'EVIDENCE_PUBLICATION_BLOCKED',
		'QUERY_EVIDENCE_INCOMPLETE',
		'FACT_SCHEMA_INVALID',
		'CHUNK_QUERY_EVIDENCE_MISMATCH',
		'DETERMINISTIC_FACTS_INCOMPLETE',
		'UNRECOGNIZED_ANALYSIS_FAILURE'
	]) {
		assert.equal(analysisCoordinator.classifyAnalysisError(code).retryable, false, code)
	}
	for (const code of [
		'ANALYSIS_OUTPUT_TRUNCATED',
		'ANALYSIS_IN_PROGRESS_TIMEOUT',
		'ECONNRESET'
	]) {
		assert.equal(analysisCoordinator.classifyAnalysisError(code).retryable, true, code)
	}
	assert.equal(analysisCoordinator.classifyAnalysisError('ANALYSIS_UPSTREAM_FAILED').retryable, false)
	assert.equal(analysisCoordinator.classifyAnalysisError({
		code: 'ANALYSIS_UPSTREAM_FAILED',
		httpStatus: 401
	}).retryable, false)
	assert.equal(analysisCoordinator.classifyAnalysisError({
		code: 'ANALYSIS_UPSTREAM_FAILED',
		httpStatus: 503
	}).retryable, true)
	assert.equal(analysisCoordinator.classifyAnalysisError('OCR_INCOMPLETE').retryable, false)
})

test('status-aware upstream terminal events preserve deny-by-default 4xx and transient 429/5xx semantics', () => {
	for (const [index, httpStatus] of [401, 403, 422, 429, 503].entries()) {
		const content = Buffer.from(`%PDF-1.7\nSTATUS_AWARE_${httpStatus}\n%%EOF`)
		const scope = `user:status-aware-${httpStatus}`
		const identity = buildAnalysisIdentity({ content, scope, inputKind: 'credit-report-pdf' })
		const jobId = `aj_${Buffer.alloc(18, 40 + index).toString('base64url')}`
		store.enqueueAnalysisJob({
			scopeHmac: identity.scopeHmac,
			analysisKey: identity.analysisKey,
			jobId,
			documentId: identity.documentId,
			inputKind: 'credit-report-pdf',
			inputPath: path.join(taskService.SPOOL_ROOT, `${jobId}.bin`),
			inputSize: content.length,
			scopeCiphertext: 'status-aware-scope'
		})
		const claim = store.claimAnalysisJob(identity.scopeHmac, identity.analysisKey, `status-worker-${index}`, 120000)
		const error = new Error('safe upstream classification')
		error.code = 'ANALYSIS_UPSTREAM_FAILED'
		error.httpStatus = httpStatus
		const failure = analysisCoordinator.describeAnalysisFailure(error)
		assert.equal(store.failAnalysisJob(
			identity.scopeHmac,
			identity.analysisKey,
			`status-worker-${index}`,
			failure.code,
			failure
		), true)
		const event = store.getTrustedAnalysisEventBySupportRef(claim.supportRef)
		const transient = httpStatus === 429 || httpStatus >= 500
		assert.equal(event.code, 'ANALYSIS_UPSTREAM_FAILED')
		assert.equal(event.errorClass, transient ? 'upstream_transient' : 'configuration_permanent')
		assert.equal(event.retryable, transient)
		assert.equal(event.safeMessageKey, transient
			? 'provider-temporarily-unavailable'
			: 'provider-configuration-unavailable')
	}
})

test('regex-shaped PII code/stage are normalized before job, terminal, public and PM2 boundaries', async (t) => {
	taskService.stopAnalysisTaskWorkerForTests()
	t.after(() => taskService.stopAnalysisTaskWorkerForTests())
	const privateCode = 'PRIVATE_CUSTOMER_13800138000'
	const privateStage = 'private_customer_20260818'
	taskService.configureAnalysisTaskExecutor(async ({ onStage }) => {
		onStage(privateStage, 55, { extra: 'PRIVATE_REPORT_AMOUNT' })
		const error = new Error('PRIVATE_REPORT_AMOUNT')
		error.code = privateCode
		throw error
	})
	const source = Buffer.from('%PDF-1.7\nPII_CODE_STAGE_SENTINEL\n%%EOF')
	const scope = 'user:pii-code-stage-owner'
	const task = taskService.enqueueAnalysisTask({ content: source, scope, inputKind: 'credit-report-pdf' })
	const terminal = await waitFor(() => {
		const value = taskService.getAnalysisTask(scope, task.jobId)
		return value && value.status === 'failed' ? value : null
	})
	assert.equal(terminal.errorCode, 'ANALYSIS_FAILED')
	assert.equal(terminal.errorClass, 'unknown_permanent')
	assert.equal(terminal.failureStage, 'unknown')
	const identity = buildAnalysisIdentity({ content: source, scope, inputKind: 'credit-report-pdf' })
	const rawJob = store.getAnalysisJob(identity.scopeHmac, identity.analysisKey)
	assert.equal(rawJob.error_code, 'ANALYSIS_FAILED')
	assert.equal(rawJob.error_stage, 'unknown')
	assert.equal(rawJob.stage, 'failed')
	const event = store.getTrustedAnalysisEventBySupportRef(task.supportRef)
	assert.equal(event.code, 'ANALYSIS_FAILED')
	assert.equal(event.stage, 'unknown')
	const database = new Database(store.DATA_FILE, { readonly: true })
	const raw = JSON.stringify({
		job: database.prepare(
			'SELECT error_code, error_class, error_stage, diagnostic_json, stage FROM analysis_jobs WHERE scope_hmac = ? AND analysis_key = ?'
		).get(identity.scopeHmac, identity.analysisKey),
		event: database.prepare('SELECT * FROM analysis_terminal_events WHERE support_ref = ?').all(task.supportRef)
	})
	database.close()
	assert.doesNotMatch(raw, /PRIVATE_CUSTOMER|13800138000|private_customer|PRIVATE_REPORT_AMOUNT/)
	assert.doesNotMatch(JSON.stringify(terminal), /PRIVATE_CUSTOMER|13800138000|private_customer|PRIVATE_REPORT_AMOUNT/)

	const originalWrite = process.stderr.write
	let logOutput = ''
	process.stderr.write = function capture(chunk) {
		logOutput += String(chunk)
		return true
	}
	try { analysisCoordinator.logTrustedTerminalEvent(event, 'error') } finally { process.stderr.write = originalWrite }
	assert.doesNotMatch(logOutput, /PRIVATE_CUSTOMER|13800138000|private_customer|PRIVATE_REPORT_AMOUNT/)
})

test('a result-only legacy cache creates a success snapshot with a strict null diagnostic', () => {
	const source = Buffer.from('%PDF-1.7\nRESULT_ONLY_LEGACY_CACHE\n%%EOF')
	const scope = 'user:result-only-legacy-cache-owner'
	const identity = buildAnalysisIdentity({ content: source, scope, inputKind: 'credit-report-pdf' })
	const now = '2026-08-18T02:03:04.005Z'
	const database = new Database(store.DATA_FILE)
	database.prepare(
		`INSERT INTO analysis_results
		 (scope_hmac, analysis_key, encrypted_payload, result_hash, versions_json, created_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	).run(
		identity.scopeHmac,
		identity.analysisKey,
		'legacy-result-only-ciphertext',
		'rh_v1_legacy_result_only',
		'{}',
		now,
		'9999-12-31T23:59:59.999Z'
	)
	const jobId = `aj_${Buffer.alloc(18, 35).toString('base64url')}`
	const outcome = store.enqueueAnalysisJob({
		scopeHmac: identity.scopeHmac,
		analysisKey: identity.analysisKey,
		jobId,
		documentId: identity.documentId,
		inputKind: 'credit-report-pdf',
		inputPath: path.join(taskService.SPOOL_ROOT, `${jobId}.bin`),
		inputSize: source.length,
		scopeCiphertext: 'result-only-legacy-scope'
	})
	assert.equal(outcome.reused, true)
	assert.equal(outcome.cacheHit, true)
	assert.equal(outcome.job.status, 'succeeded')
	assert.equal(taskService.getAnalysisTask(scope, jobId).diagnostic, null)
	const raw = database.prepare(
		'SELECT status, diagnostic_json FROM analysis_terminal_events WHERE support_ref = ?'
	).get(outcome.job.support_ref)
	assert.deepEqual(raw, { status: 'succeeded', diagnostic_json: 'null' })
	assert.equal(store.getTrustedAnalysisEventBySupportRef(outcome.job.support_ref).diagnostic, null)
	database.close()
})

test('same execution deliveries share support identity and newer ACK closes only older deliveries', async (t) => {
	taskService.stopAnalysisTaskWorkerForTests()
	t.after(() => taskService.stopAnalysisTaskWorkerForTests())
	let releaseExecution
	const executionGate = new Promise((resolve) => { releaseExecution = resolve })
	let executions = 0
	taskService.configureAnalysisTaskExecutor(async ({ documentId }) => {
		executions += 1
		await executionGate
		return canonical(880, { documentId, inputKind: 'credit-report-pdf' })
	})
	const source = Buffer.from('%PDF-1.7\nRESPONSE_LOSS_NEW_DELIVERY\n%%EOF')
	const scope = 'user:task-support-delivery-owner'
	const first = taskService.enqueueAnalysisTask({ content: source, scope, inputKind: 'credit-report-pdf' })
	const second = taskService.enqueueAnalysisTask({ content: source, scope, inputKind: 'credit-report-pdf' })
	assert.match(first.supportRef, /^sr_[A-Za-z0-9_-]{24}$/)
	assert.equal(second.supportRef, first.supportRef)
	const identity = buildAnalysisIdentity({ content: source, scope, inputKind: 'credit-report-pdf' })
	const rawAttempt = store.getAnalysisJob(identity.scopeHmac, identity.analysisKey)
	assert.match(rawAttempt.trace_id, /^tr_[A-Za-z0-9_-]{24}$/)

	releaseExecution()
	const terminal = await waitFor(() => {
		const value = taskService.getAnalysisTask(scope, second.jobId)
		return value && value.status === 'succeeded' ? value : null
	})
	assert.equal(terminal.supportRef, first.supportRef)
	assert.match(terminal.serverTime, /^\d{4}-\d{2}-\d{2}T/)
	assert.equal(store.getTrustedAnalysisEventBySupportRef(first.supportRef).diagnostic, null)
	assert.equal(executions, 1)
	assert.equal(taskService.acknowledgeAnalysisTask(scope, second.jobId), true)
	assert.equal(taskService.getLatestAnalysisTask(scope), null)
	assert.equal(taskService.acknowledgeAnalysisTask(scope, first.jobId), true)

	const cachedDelivery = taskService.enqueueAnalysisTask({ content: source, scope, inputKind: 'credit-report-pdf' })
	assert.equal(cachedDelivery.cacheHit, true)
	assert.equal(cachedDelivery.supportRef, first.supportRef)
	assert.equal(executions, 1)
	const database = new Database(store.DATA_FILE, { readonly: true })
	const successSnapshots = database.prepare(
		'SELECT status, diagnostic_json FROM analysis_terminal_events WHERE support_ref = ? ORDER BY id'
	).all(first.supportRef)
	assert.deepEqual(successSnapshots, [{ status: 'succeeded', diagnostic_json: 'null' }])
	database.close()
	assert.equal(taskService.acknowledgeAnalysisTask(scope, cachedDelivery.jobId), true)
	taskService.stopAnalysisTaskWorkerForTests()
})

test('explicit retry rotates support/trace and old failed delivery never reads the new success', async (t) => {
	taskService.stopAnalysisTaskWorkerForTests()
	t.after(() => taskService.stopAnalysisTaskWorkerForTests())
	let execution = 0
	taskService.configureAnalysisTaskExecutor(async ({ documentId }) => {
		execution += 1
		if (execution === 1) {
			const error = new Error('PRIVATE_NAME_AMOUNT_PATH_MUST_NOT_PERSIST')
			error.code = 'FACT_SCHEMA_INVALID'
			error.analysisDiagnostic = {
				version: 1,
				failedCheckCount: 1,
				unknownCount: 77,
				extra: 'PRIVATE_NAME_AMOUNT_PATH_MUST_NOT_PERSIST'
			}
			throw error
		}
		return canonical(881, { documentId, inputKind: 'credit-report-pdf' })
	})
	const source = Buffer.from('%PDF-1.7\nEXPLICIT_RETRY_ATTEMPT_BINDING\n%%EOF')
	const scope = 'user:task-explicit-retry-owner'
	const first = taskService.enqueueAnalysisTask({ content: source, scope, inputKind: 'credit-report-pdf' })
	const firstFailed = await waitFor(() => {
		const value = taskService.getAnalysisTask(scope, first.jobId)
		return value && value.status === 'failed' ? value : null
	})
	const identity = buildAnalysisIdentity({ content: source, scope, inputKind: 'credit-report-pdf' })
	const firstTrace = store.getAnalysisJob(identity.scopeHmac, identity.analysisKey).trace_id
	assert.equal(firstFailed.errorCode, 'FACT_SCHEMA_INVALID')
	assert.doesNotMatch(JSON.stringify(firstFailed), /PRIVATE_NAME|unknownCount|"extra":/)

	const retry = taskService.enqueueAnalysisTask({ content: source, scope, inputKind: 'credit-report-pdf' })
	const retryTrace = store.getAnalysisJob(identity.scopeHmac, identity.analysisKey).trace_id
	assert.notEqual(retry.supportRef, first.supportRef)
	assert.notEqual(retryTrace, firstTrace)
	const retrySucceeded = await waitFor(() => {
		const value = taskService.getAnalysisTask(scope, retry.jobId)
		return value && value.status === 'succeeded' ? value : null
	})
	assert.equal(retrySucceeded.supportRef, retry.supportRef)
	assert.equal(execution, 2)

	const oldStatus = taskService.getAnalysisTask(scope, first.jobId)
	assert.equal(oldStatus.status, 'failed')
	assert.equal(oldStatus.supportRef, first.supportRef)
	const oldResult = taskService.getAnalysisTaskResult(scope, first.jobId)
	assert.equal(oldResult.job.status, 'failed')
	assert.equal(oldResult.result, null)
	assert.equal(taskService.getAnalysisTaskResult(scope, retry.jobId).result.marker, 881)
	assert.equal(
		store.getScopedTrustedAnalysisEvent(buildAnalysisScopeHmac('user:another-owner'), first.supportRef),
		null
	)
	assert.equal(
		store.getScopedTrustedAnalysisEvent(buildAnalysisScopeHmac(scope), first.supportRef).status,
		'failed'
	)
	const storePath = path.resolve(__dirname, '../backend/db/store.js')
	const restart = spawnSync(process.execPath, ['-e', [
		`process.env.DATA_DIR = ${JSON.stringify(dataDir)}`,
		`process.env.NODE_ENV = 'test'`,
		`const store = require(${JSON.stringify(storePath)})`,
		`process.stdout.write(JSON.stringify(store.storageRuntimeStatus()))`
	].join(';')], { encoding: 'utf8', env: { ...process.env, DATA_DIR: dataDir, NODE_ENV: 'test' } })
	assert.equal(restart.status, 0, restart.stderr)
	assert.deepEqual(JSON.parse(restart.stdout), { ready: true, mode: 'sqlite' })

	assert.equal(taskService.acknowledgeAnalysisTask(scope, first.jobId), true)
	assert.equal(taskService.getLatestAnalysisTask(scope).jobId, retry.jobId)
	assert.equal(taskService.acknowledgeAnalysisTask(scope, retry.jobId), true)
	assert.equal(taskService.getLatestAnalysisTask(scope), null)
	taskService.stopAnalysisTaskWorkerForTests()
})

test('terminal event insertion failure atomically rolls back every terminal entry point', () => {
	taskService.stopAnalysisTaskWorkerForTests()
	const database = new Database(store.DATA_FILE)
	const installBlock = () => database.exec(`CREATE TRIGGER test_block_terminal_insert
		BEFORE INSERT ON analysis_terminal_events
		BEGIN SELECT RAISE(ABORT, 'blocked terminal insert'); END`)
	const removeBlock = () => database.exec('DROP TRIGGER IF EXISTS test_block_terminal_insert')
	const directAttempt = (label, byte) => {
		const content = Buffer.from(`%PDF-1.7\n${label}\n%%EOF`)
		const scope = `user:atomic-${label}`
		const identity = buildAnalysisIdentity({ content, scope, inputKind: 'credit-report-pdf' })
		const jobId = `aj_${Buffer.alloc(18, byte).toString('base64url')}`
		store.enqueueAnalysisJob({
			scopeHmac: identity.scopeHmac,
			analysisKey: identity.analysisKey,
			jobId,
			documentId: identity.documentId,
			inputKind: 'credit-report-pdf',
			inputPath: path.join(taskService.SPOOL_ROOT, `${jobId}.bin`),
			inputSize: content.length,
			scopeCiphertext: 'atomic-test-scope'
		})
		return { identity, jobId }
	}

	try {
		const complete = directAttempt('COMPLETE_ROLLBACK', 21)
		const completeClaim = store.claimAnalysisJob(
			complete.identity.scopeHmac,
			complete.identity.analysisKey,
			'atomic-complete-worker',
			120000
		)
		installBlock()
		assert.throws(() => store.completeAnalysisJob({
			scopeHmac: complete.identity.scopeHmac,
			analysisKey: complete.identity.analysisKey,
			leaseOwner: 'atomic-complete-worker',
			encryptedPayload: 'atomic-encrypted-result',
			resultHash: 'atomic-result-hash',
			versionsJson: '{}',
			expiresAt: '9999-12-31T23:59:59.999Z'
		}), /blocked terminal insert/)
		assert.equal(store.getAnalysisJob(complete.identity.scopeHmac, complete.identity.analysisKey).status, 'processing')
		assert.equal(store.getAnalysisResult(complete.identity.scopeHmac, complete.identity.analysisKey), null)
		assert.equal(store.getTrustedAnalysisEventBySupportRef(completeClaim.supportRef), null)
		removeBlock()
		assert.equal(store.failAnalysisJob(
			complete.identity.scopeHmac,
			complete.identity.analysisKey,
			'atomic-complete-worker',
			'TEST_CLEANUP'
		), true)

		const failed = directAttempt('FAIL_ROLLBACK', 22)
		const failedClaim = store.claimAnalysisJob(
			failed.identity.scopeHmac,
			failed.identity.analysisKey,
			'atomic-fail-worker',
			120000
		)
		installBlock()
		assert.throws(() => store.failAnalysisJob(
			failed.identity.scopeHmac,
			failed.identity.analysisKey,
			'atomic-fail-worker',
			'FACT_SCHEMA_INVALID',
			{ errorClass: 'schema_permanent', diagnostic: { version: 1 } }
		), /blocked terminal insert/)
		assert.equal(store.getAnalysisJob(failed.identity.scopeHmac, failed.identity.analysisKey).status, 'processing')
		assert.equal(store.getTrustedAnalysisEventBySupportRef(failedClaim.supportRef), null)
		removeBlock()
		assert.equal(store.failAnalysisJob(
			failed.identity.scopeHmac,
			failed.identity.analysisKey,
			'atomic-fail-worker',
			'FACT_SCHEMA_INVALID',
			{ errorClass: 'schema_permanent', diagnostic: { version: 1 } }
		), true)

		const queued = directAttempt('QUEUED_FAIL_ROLLBACK', 23)
		const queuedRaw = store.getAnalysisJob(queued.identity.scopeHmac, queued.identity.analysisKey)
		installBlock()
		assert.throws(() => store.failQueuedAnalysisJob(
			queued.identity.scopeHmac,
			queued.identity.analysisKey,
			'ANALYSIS_TASK_INPUT_INVALID',
			{ errorClass: 'input_permanent', diagnostic: { version: 1 } }
		), /blocked terminal insert/)
		assert.equal(store.getAnalysisJob(queued.identity.scopeHmac, queued.identity.analysisKey).status, 'queued')
		assert.equal(store.getTrustedAnalysisEventBySupportRef(queuedRaw.support_ref), null)
		removeBlock()
		assert.equal(store.failQueuedAnalysisJob(
			queued.identity.scopeHmac,
			queued.identity.analysisKey,
			'ANALYSIS_TASK_INPUT_INVALID',
			{ errorClass: 'input_permanent', diagnostic: { version: 1 } }
		), true)

		const cache = directAttempt('CACHE_INVALID_ROLLBACK', 24)
		const cacheClaim = store.claimAnalysisJob(
			cache.identity.scopeHmac,
			cache.identity.analysisKey,
			'atomic-cache-worker',
			120000
		)
		store.completeAnalysisJob({
			scopeHmac: cache.identity.scopeHmac,
			analysisKey: cache.identity.analysisKey,
			leaseOwner: 'atomic-cache-worker',
			encryptedPayload: 'atomic-cache-result',
			resultHash: 'atomic-cache-hash',
			versionsJson: '{}',
			expiresAt: '9999-12-31T23:59:59.999Z'
		})
		assert.equal(
			database.prepare(
				'SELECT diagnostic_json FROM analysis_terminal_events WHERE support_ref = ? ORDER BY id'
			).get(cacheClaim.supportRef).diagnostic_json,
			'null'
		)
		installBlock()
		assert.throws(() => store.invalidateAnalysisResult(
			cache.identity.scopeHmac,
			cache.identity.analysisKey,
			'CACHE_INTEGRITY_FAILED'
		), /blocked terminal insert/)
		assert.equal(store.getAnalysisJob(cache.identity.scopeHmac, cache.identity.analysisKey).status, 'succeeded')
		assert.ok(store.getAnalysisResult(cache.identity.scopeHmac, cache.identity.analysisKey))
		assert.equal(store.getTrustedAnalysisEventBySupportRef(cacheClaim.supportRef).status, 'succeeded')
		removeBlock()
		assert.equal(
			store.invalidateAnalysisResult(
				cache.identity.scopeHmac,
				cache.identity.analysisKey,
				'CACHE_INTEGRITY_FAILED'
			).status,
			'failed'
		)
		assert.equal(store.getTrustedAnalysisEventBySupportRef(cacheClaim.supportRef).code, 'CACHE_INTEGRITY_FAILED')
		assert.deepEqual(
			database.prepare(
				'SELECT status, diagnostic_json FROM analysis_terminal_events WHERE support_ref = ? ORDER BY id'
			).all(cacheClaim.supportRef).map((row) => ({
				status: row.status,
				diagnostic: JSON.parse(row.diagnostic_json)
			})),
			[
				{ status: 'succeeded', diagnostic: null },
				{ status: 'failed', diagnostic: { version: 1 } }
			]
		)
		const persisted = database.prepare(
			`SELECT schema_version, support_ref, trace_id, status, code, error_class,
			        stage, retryable, safe_message_key, diagnostic_json, release_json,
			        versions_json, server_time, created_at
			 FROM analysis_terminal_events WHERE support_ref = ? ORDER BY id DESC LIMIT 1`
		).get(cacheClaim.supportRef)
		const insertSnapshot = database.prepare(
			`INSERT INTO analysis_terminal_events
			 (schema_version, support_ref, trace_id, status, code, error_class, stage,
			  retryable, safe_message_key, diagnostic_json, release_json, versions_json,
			  server_time, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		const values = (row) => [
			row.schema_version, row.support_ref, row.trace_id, row.status, row.code,
			row.error_class, row.stage, row.retryable, row.safe_message_key,
			row.diagnostic_json, row.release_json, row.versions_json,
			row.server_time, row.created_at
		]
		const beforeConflicts = database.prepare(
			'SELECT COUNT(*) AS total FROM analysis_terminal_events'
		).get().total
		assert.throws(
			() => insertSnapshot.run(...values({ ...persisted, trace_id: `tr_${'x'.repeat(24)}` })),
			/conflict/
		)
		assert.throws(
			() => insertSnapshot.run(...values({ ...persisted, support_ref: `sr_${'y'.repeat(24)}` })),
			/conflict/
		)
		assert.throws(
			() => insertSnapshot.run(...values(persisted)),
			/terminal transition conflict/
		)
		assert.throws(
			() => database.prepare(
				'UPDATE analysis_terminal_events SET stage = ? WHERE support_ref = ?'
			).run('unknown', cacheClaim.supportRef),
			/terminal events are immutable/
		)
		assert.throws(
			() => database.prepare(
				'DELETE FROM analysis_terminal_events WHERE support_ref = ?'
			).run(cacheClaim.supportRef),
			/terminal events are immutable/
		)
		assert.equal(
			database.prepare('SELECT COUNT(*) AS total FROM analysis_terminal_events').get().total,
			beforeConflicts
		)
		assert.deepEqual(
			database.prepare(
				`SELECT schema_version, support_ref, trace_id, status, code, error_class,
				        stage, retryable, safe_message_key, diagnostic_json, release_json,
				        versions_json, server_time, created_at
				 FROM analysis_terminal_events WHERE support_ref = ? ORDER BY id DESC LIMIT 1`
			).get(cacheClaim.supportRef),
			persisted
		)
	} finally {
		removeBlock()
		database.close()
	}
})

test('terminal release/version/time are frozen at transition and never relabeled on lookup', () => {
	const previousRelease = process.env.RPT_RELEASE_ID
	const previousCommit = process.env.RPT_GIT_COMMIT
	try {
		process.env.RPT_RELEASE_ID = '20260818-010203-phase2-aaaaaaa-api'
		process.env.RPT_GIT_COMMIT = 'a'.repeat(40)
		const content = Buffer.from('%PDF-1.7\nRELEASE_SNAPSHOT_FREEZE\n%%EOF')
		const scope = 'user:release-snapshot-owner'
		const identity = buildAnalysisIdentity({ content, scope, inputKind: 'credit-report-pdf' })
		const jobId = `aj_${Buffer.alloc(18, 32).toString('base64url')}`
		const outcome = store.enqueueAnalysisJob({
			scopeHmac: identity.scopeHmac,
			analysisKey: identity.analysisKey,
			jobId,
			documentId: identity.documentId,
			inputKind: 'credit-report-pdf',
			inputPath: path.join(taskService.SPOOL_ROOT, `${jobId}.bin`),
			inputSize: content.length,
			scopeCiphertext: 'release-snapshot-scope'
		})
		assert.equal(store.failQueuedAnalysisJob(
			identity.scopeHmac,
			identity.analysisKey,
			'FACT_SCHEMA_INVALID',
			{ errorClass: 'schema_permanent', diagnostic: { version: 1 } }
		), true)
		const original = store.getTrustedAnalysisEventBySupportRef(outcome.job.support_ref)
		assert.deepEqual(original.release, {
			id: '20260818-010203-phase2-aaaaaaa-api',
			gitCommit: 'a'.repeat(40)
		})
		assert.equal(original.versions.pipeline, 'credit-analysis-v14-global-card-binding-currency-closed')
		process.env.RPT_RELEASE_ID = '20260818-020304-phase2-bbbbbbb-api'
		process.env.RPT_GIT_COMMIT = 'b'.repeat(40)
		const reread = store.getTrustedAnalysisEventBySupportRef(outcome.job.support_ref)
		assert.deepEqual(reread, original)
		assert.equal(reread.serverTime, original.serverTime)
	} finally {
		if (previousRelease === undefined) delete process.env.RPT_RELEASE_ID
		else process.env.RPT_RELEASE_ID = previousRelease
		if (previousCommit === undefined) delete process.env.RPT_GIT_COMMIT
		else process.env.RPT_GIT_COMMIT = previousCommit
	}
})

test('a permanent failed lease cannot be reclaimed without an explicit enqueue', () => {
	const source = Buffer.from('%PDF-1.7\nPERMANENT_LEASE_FAILURE\n%%EOF')
	const scope = 'user:task-permanent-lease'
	const identity = buildAnalysisIdentity({ content: source, scope, inputKind: 'credit-report-pdf' })
	const jobId = `aj_${Buffer.alloc(18, 7).toString('base64url')}`
	const inputPath = path.join(taskService.SPOOL_ROOT, `${jobId}.bin`)
	store.enqueueAnalysisJob({
		scopeHmac: identity.scopeHmac,
		analysisKey: identity.analysisKey,
		jobId,
		inputKind: 'credit-report-pdf',
		inputPath,
		inputSize: source.length,
		scopeCiphertext: 'test-scope-ciphertext'
	})
	const first = store.claimAnalysisJob(identity.scopeHmac, identity.analysisKey, 'worker-A', 120000)
	assert.equal(first.claimed, true)
	assert.equal(store.failAnalysisJob(
		identity.scopeHmac,
		identity.analysisKey,
		'worker-A',
		'FACT_SCHEMA_INVALID',
		{ errorClass: 'schema_permanent', diagnostic: { version: 1 } }
	), true)
	const second = store.claimAnalysisJob(identity.scopeHmac, identity.analysisKey, 'worker-B', 120000)
	assert.equal(second.claimed, false)
	assert.equal(second.state, 'failed')
	assert.equal(second.errorCode, 'FACT_SCHEMA_INVALID')
	assert.equal(store.getAnalysisJob(identity.scopeHmac, identity.analysisKey).attempt_count, 1)
})

test('expired lease takeover preserves the same execution support identity', () => {
	const source = Buffer.from('%PDF-1.7\nLEASE_TAKEOVER_SUPPORT_IDENTITY\n%%EOF')
	const scope = 'user:task-lease-takeover'
	const identity = buildAnalysisIdentity({ content: source, scope, inputKind: 'credit-report-pdf' })
	const jobId = `aj_${Buffer.alloc(18, 33).toString('base64url')}`
	store.enqueueAnalysisJob({
		scopeHmac: identity.scopeHmac,
		analysisKey: identity.analysisKey,
		jobId,
		documentId: identity.documentId,
		inputKind: 'credit-report-pdf',
		inputPath: path.join(taskService.SPOOL_ROOT, `${jobId}.bin`),
		inputSize: source.length,
		scopeCiphertext: 'lease-takeover-scope'
	})
	const first = store.claimAnalysisJob(identity.scopeHmac, identity.analysisKey, 'lease-worker-a', 120000)
	assert.equal(first.claimed, true)
	const database = new Database(store.DATA_FILE)
	database.prepare(
		`UPDATE analysis_jobs SET lease_expires_at = ?
		 WHERE scope_hmac = ? AND analysis_key = ?`
	).run('2000-01-01T00:00:00.000Z', identity.scopeHmac, identity.analysisKey)
	database.close()
	const takeover = store.claimAnalysisJob(identity.scopeHmac, identity.analysisKey, 'lease-worker-b', 120000)
	assert.equal(takeover.claimed, true)
	assert.equal(takeover.supportRef, first.supportRef)
	assert.equal(takeover.traceId, first.traceId)
	assert.equal(store.getAnalysisJob(identity.scopeHmac, identity.analysisKey).attempt_count, 2)
	assert.equal(store.failAnalysisJob(
		identity.scopeHmac,
		identity.analysisKey,
		'lease-worker-b',
		'TEST_CLEANUP'
	), true)
})

test('a concurrent observer timeout cannot fail a foreign lease or delete its recoverable spool', async (t) => {
	taskService.stopAnalysisTaskWorkerForTests()
	taskService.configureAnalysisTaskExecutor(async ({ documentId }) => canonical(777, {
		documentId,
		inputKind: 'credit-report-pdf'
	}))

	const source = Buffer.from('%PDF-1.7\nCONCURRENT_FOREIGN_LEASE\n%%EOF')
	const scope = 'user:task-concurrent-owner'
	const identity = buildAnalysisIdentity({
		content: source,
		scope,
		inputKind: 'credit-report-pdf'
	})
	const task = taskService.enqueueAnalysisTask({
		content: source,
		scope,
		inputKind: 'credit-report-pdf'
	})
	const spoolPath = path.join(taskService.SPOOL_ROOT, `${task.jobId}.bin`)
	const staleQueuedRow = {
		scope_hmac: identity.scopeHmac,
		analysis_key: identity.analysisKey,
		...store.getAnalysisJob(identity.scopeHmac, identity.analysisKey)
	}
	const foreignLeaseOwner = 'foreign-worker-lease-owner'
	assert.equal(
		store.claimAnalysisJob(identity.scopeHmac, identity.analysisKey, foreignLeaseOwner, 120000).claimed,
		true
	)

	const originalListRecoverable = store.listRecoverableAnalysisJobs
	const originalRunCoordinated = analysisCoordinator.runCoordinatedAnalysis
	t.after(() => {
		store.listRecoverableAnalysisJobs = originalListRecoverable
		analysisCoordinator.runCoordinatedAnalysis = originalRunCoordinated
		const current = store.getAnalysisJob(identity.scopeHmac, identity.analysisKey)
		if (current && current.status === 'processing' && current.lease_owner === foreignLeaseOwner) {
			store.failAnalysisJob(
				identity.scopeHmac,
				identity.analysisKey,
				foreignLeaseOwner,
				'TEST_CLEANUP'
			)
		}
		try { fs.unlinkSync(spoolPath) } catch (_) {}
		store.clearAnalysisJobInput(identity.scopeHmac, identity.analysisKey, spoolPath)
		taskService.stopAnalysisTaskWorkerForTests()
	})

	store.listRecoverableAnalysisJobs = () => [staleQueuedRow]
	analysisCoordinator.runCoordinatedAnalysis = async () => {
		const error = new Error('foreign analysis is still running')
		error.code = 'ANALYSIS_IN_PROGRESS_TIMEOUT'
		throw error
	}

	await taskService.scanAnalysisTasks()

	const current = store.getAnalysisJob(identity.scopeHmac, identity.analysisKey)
	assert.equal(current.status, 'processing')
	assert.equal(current.lease_owner, foreignLeaseOwner)
	assert.equal(current.error_code, null)
	assert.equal(current.input_path, spoolPath)
	assert.equal(fs.existsSync(spoolPath), true)
})

test('collection read errors fail closed instead of fabricating an empty business state', () => {
	const brokenDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-store-fail-closed-'))
	const sqliteFile = path.join(brokenDataDir, 'db.sqlite')
	const database = new Database(sqliteFile)
	// Preserve the table name while making the deployed schema unreadable by
	// load(). CREATE TABLE IF NOT EXISTS will not repair this shape.
	database.exec('CREATE TABLE collections (unexpected_column TEXT)')
	database.close()

	const storePath = path.resolve(__dirname, '../backend/db/store.js')
	const script = [
		`process.env.DATA_DIR = ${JSON.stringify(brokenDataDir)}`,
		`process.env.NODE_ENV = 'test'`,
		`const store = require(${JSON.stringify(storePath)})`,
		`const readiness = store.storageRuntimeStatus()`,
		`let observed = null`,
		`try { store.get('users') } catch (error) { observed = { code: error.code, message: error.message, cause: error.cause && error.cause.message } }`,
		`process.stdout.write(JSON.stringify({ readiness, observed }))`
	].join(';')
	const child = spawnSync(process.execPath, ['-e', script], {
		encoding: 'utf8',
		env: { ...process.env, DATA_DIR: brokenDataDir, NODE_ENV: 'test' }
	})
	assert.equal(child.status, 0, child.stderr)
	assert.deepEqual(JSON.parse(child.stdout), {
		readiness: { ready: false, mode: 'sqlite', reason: 'STORE_READ_FAILED' },
		observed: {
			code: 'STORE_READ_FAILED',
			message: 'SQLite collections read failed',
			cause: 'no such column: name'
		}
	})

	const verify = new Database(sqliteFile, { readonly: true })
	assert.equal(verify.prepare('SELECT COUNT(*) AS total FROM collections').get().total, 0)
	verify.close()
})

test('malformed collection JSON is not replaced by an empty default collection', () => {
	const brokenDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-store-invalid-json-'))
	const sqliteFile = path.join(brokenDataDir, 'db.sqlite')
	const database = new Database(sqliteFile)
	database.exec('CREATE TABLE collections (name TEXT PRIMARY KEY, data TEXT NOT NULL)')
	database.prepare('INSERT INTO collections (name, data) VALUES (?, ?)').run('users', '{not-json')
	database.close()

	const storePath = path.resolve(__dirname, '../backend/db/store.js')
	const script = [
		`process.env.DATA_DIR = ${JSON.stringify(brokenDataDir)}`,
		`process.env.NODE_ENV = 'test'`,
		`const store = require(${JSON.stringify(storePath)})`,
		`const readiness = store.storageRuntimeStatus()`,
		`let code = null`,
		`try { store.get('users') } catch (error) { code = error.code }`,
		`process.stdout.write(JSON.stringify({ readiness, code }))`
	].join(';')
	const child = spawnSync(process.execPath, ['-e', script], {
		encoding: 'utf8',
		env: { ...process.env, DATA_DIR: brokenDataDir, NODE_ENV: 'test' }
	})
	assert.equal(child.status, 0, child.stderr)
	assert.deepEqual(JSON.parse(child.stdout), {
		readiness: { ready: false, mode: 'sqlite', reason: 'STORE_READ_FAILED' },
		code: 'STORE_READ_FAILED'
	})

	const verify = new Database(sqliteFile, { readonly: true })
	assert.equal(verify.prepare('SELECT data FROM collections WHERE name = ?').get('users').data, '{not-json')
	verify.close()
})

test('production refuses to create a healthy empty store when the data volume is missing', (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-store-bootstrap-guard-'))
	const missingDataDir = path.join(root, 'missing-volume')
	t.after(() => fs.rmSync(root, { recursive: true, force: true }))

	const storePath = path.resolve(__dirname, '../backend/db/store.js')
	const script = [
		`process.env.DATA_DIR = ${JSON.stringify(missingDataDir)}`,
		`process.env.NODE_ENV = 'production'`,
		`delete process.env.ALLOW_EMPTY_STORE_BOOTSTRAP`,
		`const store = require(${JSON.stringify(storePath)})`,
		`const readiness = store.storageRuntimeStatus()`,
		`process.stdout.write(JSON.stringify({ readiness, dataDirExists: require('fs').existsSync(process.env.DATA_DIR) }))`
	].join(';')
	const child = spawnSync(process.execPath, ['-e', script], {
		encoding: 'utf8',
		env: {
			...process.env,
			DATA_DIR: missingDataDir,
			NODE_ENV: 'production',
			ALLOW_EMPTY_STORE_BOOTSTRAP: ''
		}
	})

	assert.equal(child.status, 0, child.stderr)
	assert.deepEqual(JSON.parse(child.stdout), {
		readiness: { ready: false, mode: 'sqlite', reason: 'STORE_BOOTSTRAP_REQUIRED' },
		dataDirExists: false
	})
})

test('production empty-store bootstrap requires an explicit one-time authorization', (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-store-bootstrap-explicit-'))
	const newDataDir = path.join(root, 'authorized-volume')
	t.after(() => fs.rmSync(root, { recursive: true, force: true }))

	const storePath = path.resolve(__dirname, '../backend/db/store.js')
	const script = [
		`process.env.DATA_DIR = ${JSON.stringify(newDataDir)}`,
		`process.env.NODE_ENV = 'production'`,
		`process.env.ALLOW_EMPTY_STORE_BOOTSTRAP = 'true'`,
		`const store = require(${JSON.stringify(storePath)})`,
		`process.stdout.write(JSON.stringify({ readiness: store.storageRuntimeStatus(), databaseExists: require('fs').existsSync(${JSON.stringify(path.join(newDataDir, 'db.sqlite'))}) }))`
	].join(';')
	const child = spawnSync(process.execPath, ['-e', script], {
		encoding: 'utf8',
		env: {
			...process.env,
			DATA_DIR: newDataDir,
			NODE_ENV: 'production',
			ALLOW_EMPTY_STORE_BOOTSTRAP: 'true'
		}
	})

	assert.equal(child.status, 0, child.stderr)
	assert.deepEqual(JSON.parse(child.stdout), {
		readiness: { ready: true, mode: 'sqlite' },
		databaseExists: true
	})
	const verify = new Database(path.join(newDataDir, 'db.sqlite'), { readonly: true })
	assert.equal(
		verify.prepare("SELECT COUNT(*) AS total FROM collections WHERE name IN ('users', 'reports')").get().total,
		2
	)
	verify.close()
})

test('production rejects an empty file masquerading as an existing SQLite store', (t) => {
	const brokenDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-store-empty-sqlite-'))
	t.after(() => fs.rmSync(brokenDataDir, { recursive: true, force: true }))
	const sqliteFile = path.join(brokenDataDir, 'db.sqlite')
	fs.writeFileSync(sqliteFile, '')

	const storePath = path.resolve(__dirname, '../backend/db/store.js')
	const script = [
		`process.env.DATA_DIR = ${JSON.stringify(brokenDataDir)}`,
		`process.env.NODE_ENV = 'production'`,
		`delete process.env.ALLOW_EMPTY_STORE_BOOTSTRAP`,
		`const store = require(${JSON.stringify(storePath)})`,
		`process.stdout.write(JSON.stringify(store.storageRuntimeStatus()))`
	].join(';')
	const child = spawnSync(process.execPath, ['-e', script], {
		encoding: 'utf8',
		env: {
			...process.env,
			DATA_DIR: brokenDataDir,
			NODE_ENV: 'production',
			ALLOW_EMPTY_STORE_BOOTSTRAP: ''
		}
	})

	assert.equal(child.status, 0, child.stderr)
	assert.deepEqual(JSON.parse(child.stdout), {
		ready: false,
		mode: 'sqlite',
		reason: 'STORE_DATABASE_INVALID'
	})
	assert.equal(fs.statSync(sqliteFile).size, 0)
})

test('production bootstrap authorization cannot repair an existing invalid SQLite file', (t) => {
	const brokenDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-store-bootstrap-invalid-sqlite-'))
	t.after(() => fs.rmSync(brokenDataDir, { recursive: true, force: true }))
	const sqliteFile = path.join(brokenDataDir, 'db.sqlite')
	fs.writeFileSync(sqliteFile, '')

	const storePath = path.resolve(__dirname, '../backend/db/store.js')
	const script = [
		`process.env.DATA_DIR = ${JSON.stringify(brokenDataDir)}`,
		`process.env.NODE_ENV = 'production'`,
		`process.env.ALLOW_EMPTY_STORE_BOOTSTRAP = 'true'`,
		`const store = require(${JSON.stringify(storePath)})`,
		`process.stdout.write(JSON.stringify(store.storageRuntimeStatus()))`
	].join(';')
	const child = spawnSync(process.execPath, ['-e', script], {
		encoding: 'utf8',
		env: {
			...process.env,
			DATA_DIR: brokenDataDir,
			NODE_ENV: 'production',
			ALLOW_EMPTY_STORE_BOOTSTRAP: 'true'
		}
	})

	assert.equal(child.status, 0, child.stderr)
	assert.deepEqual(JSON.parse(child.stdout), {
		ready: false,
		mode: 'sqlite',
		reason: 'STORE_DATABASE_INVALID'
	})
	assert.equal(fs.statSync(sqliteFile).size, 0)
})

test('production bootstrap authorization cannot bypass critical collections in an existing SQLite store', (t) => {
	const existingDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-store-bootstrap-partial-sqlite-'))
	t.after(() => fs.rmSync(existingDataDir, { recursive: true, force: true }))
	const sqliteFile = path.join(existingDataDir, 'db.sqlite')
	const database = new Database(sqliteFile)
	database.exec('CREATE TABLE collections (name TEXT PRIMARY KEY, data TEXT NOT NULL)')
	database.prepare('INSERT INTO collections (name, data) VALUES (?, ?)').run('users', '[]')
	database.close()

	const storePath = path.resolve(__dirname, '../backend/db/store.js')
	const script = [
		`process.env.DATA_DIR = ${JSON.stringify(existingDataDir)}`,
		`process.env.NODE_ENV = 'production'`,
		`process.env.ALLOW_EMPTY_STORE_BOOTSTRAP = 'true'`,
		`const store = require(${JSON.stringify(storePath)})`,
		`process.stdout.write(JSON.stringify(store.storageRuntimeStatus()))`
	].join(';')
	const child = spawnSync(process.execPath, ['-e', script], {
		encoding: 'utf8',
		env: {
			...process.env,
			DATA_DIR: existingDataDir,
			NODE_ENV: 'production',
			ALLOW_EMPTY_STORE_BOOTSTRAP: 'true'
		}
	})

	assert.equal(child.status, 0, child.stderr)
	assert.deepEqual(JSON.parse(child.stdout), {
		ready: false,
		mode: 'sqlite',
		reason: 'STORE_BOOTSTRAP_REQUIRED'
	})
	const verify = new Database(sqliteFile, { readonly: true })
	assert.deepEqual(verify.prepare('SELECT name, data FROM collections ORDER BY name').all(), [
		{ name: 'users', data: '[]' }
	])
	verify.close()
})

test('production bootstrap authorization cannot bypass critical collections in an existing JSON store', (t) => {
	const existingDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-store-bootstrap-partial-json-'))
	t.after(() => fs.rmSync(existingDataDir, { recursive: true, force: true }))
	fs.writeFileSync(path.join(existingDataDir, 'db.json'), JSON.stringify({ users: [] }))

	const storePath = path.resolve(__dirname, '../backend/db/store.js')
	const script = [
		`process.env.DATA_DIR = ${JSON.stringify(existingDataDir)}`,
		`process.env.NODE_ENV = 'production'`,
		`process.env.ALLOW_EMPTY_STORE_BOOTSTRAP = 'true'`,
		`const store = require(${JSON.stringify(storePath)})`,
		`process.stdout.write(JSON.stringify(store.storageRuntimeStatus()))`
	].join(';')
	const child = spawnSync(process.execPath, ['-e', script], {
		encoding: 'utf8',
		env: {
			...process.env,
			DATA_DIR: existingDataDir,
			NODE_ENV: 'production',
			ALLOW_EMPTY_STORE_BOOTSTRAP: 'true'
		}
	})

	assert.equal(child.status, 0, child.stderr)
	assert.deepEqual(JSON.parse(child.stdout), {
		ready: false,
		mode: 'sqlite',
		reason: 'STORE_BOOTSTRAP_REQUIRED'
	})
	const verify = new Database(path.join(existingDataDir, 'db.sqlite'), { readonly: true })
	assert.deepEqual(verify.prepare('SELECT name, data FROM collections ORDER BY name').all(), [
		{ name: 'users', data: '[]' }
	])
	verify.close()
})

test('analysis_jobs migration adds document_id and retry persists the new document binding', (t) => {
	const legacyDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-store-document-id-migration-'))
	t.after(() => fs.rmSync(legacyDataDir, { recursive: true, force: true }))
	const sqliteFile = path.join(legacyDataDir, 'db.sqlite')
	const database = new Database(sqliteFile)
	database.exec(`CREATE TABLE analysis_jobs (
		scope_hmac TEXT NOT NULL,
		analysis_key TEXT NOT NULL,
		status TEXT NOT NULL,
		lease_owner TEXT,
		lease_expires_at TEXT,
		attempt_count INTEGER NOT NULL DEFAULT 0,
		error_code TEXT,
		updated_at TEXT NOT NULL,
		PRIMARY KEY (scope_hmac, analysis_key)
	)`)
	database.close()

	const storePath = path.resolve(__dirname, '../backend/db/store.js')
	const script = [
		`process.env.DATA_DIR = ${JSON.stringify(legacyDataDir)}`,
		`process.env.NODE_ENV = 'test'`,
		`const store = require(${JSON.stringify(storePath)})`,
		`const scopeHmac = 'sh_' + 'a'.repeat(64)`,
		`const analysisKey = 'ak_document_binding_migration'`,
		`const enqueue = (jobId, documentId) => store.enqueueAnalysisJob({ scopeHmac, analysisKey, jobId, documentId, inputKind: 'credit-report-pdf', inputPath: '/tmp/input.bin', inputSize: 10, scopeCiphertext: 'scope' })`,
		`enqueue('job-old', 'doc-old')`,
		`store.failQueuedAnalysisJob(scopeHmac, analysisKey, 'INPUT_FAILED')`,
		`const retried = enqueue('job-new', 'doc-new')`,
		`process.stdout.write(JSON.stringify({ direct: store.getAnalysisJob(scopeHmac, analysisKey).document_id, public: retried.job.document_id }))`
	].join(';')
	const child = spawnSync(process.execPath, ['-e', script], {
		encoding: 'utf8',
		env: { ...process.env, DATA_DIR: legacyDataDir, NODE_ENV: 'test' }
	})

	assert.equal(child.status, 0, child.stderr)
	assert.deepEqual(JSON.parse(child.stdout), { direct: 'doc-new', public: 'doc-new' })
	const verify = new Database(sqliteFile, { readonly: true })
	assert.equal(
		verify.prepare("SELECT COUNT(*) AS total FROM pragma_table_info('analysis_jobs') WHERE name = 'document_id'").get().total,
		1
	)
	verify.close()
})

test('spool reconciliation removes only expired unreferenced files', () => {
	const oldJobId = `aj_${Buffer.alloc(18, 8).toString('base64url')}`
	const freshJobId = `aj_${Buffer.alloc(18, 9).toString('base64url')}`
	const oldPath = path.join(taskService.SPOOL_ROOT, `${oldJobId}.bin`)
	const freshPath = path.join(taskService.SPOOL_ROOT, `${freshJobId}.bin`)
	const tempPath = path.join(taskService.SPOOL_ROOT, `.${oldJobId}.123.0123456789abcdef.tmp`)
	fs.mkdirSync(taskService.SPOOL_ROOT, { recursive: true })
	fs.writeFileSync(oldPath, 'old-orphan')
	fs.writeFileSync(freshPath, 'fresh-orphan')
	fs.writeFileSync(tempPath, 'old-temp')
	const oldDate = new Date(Date.now() - 2 * 86400000)
	fs.utimesSync(oldPath, oldDate, oldDate)
	fs.utimesSync(tempPath, oldDate, oldDate)

	const removed = taskService.reconcileOrphanSpoolFiles(Date.now())
	assert.equal(removed, 2)
	assert.equal(fs.existsSync(oldPath), false)
	assert.equal(fs.existsSync(tempPath), false)
	assert.equal(fs.existsSync(freshPath), true)
	fs.unlinkSync(freshPath)
})
