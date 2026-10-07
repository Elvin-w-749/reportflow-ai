'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-report-api-'))
process.env.DATA_DIR = dataDir
process.env.JWT_SECRET = 'report-api-summary-test-secret'
process.env.NODE_ENV = 'test'

const jwt = require('jsonwebtoken')
const store = require('../backend/db/store')
const analysisTaskService = require('../backend/services/analysisTaskService')
const { attachEvidenceV2 } = require('./evidenceCanonicalFixture.js')
const { app } = require('../server')

function tokenFor(user) {
	return jwt.sign(
		{ uid: user.id, phone: user.phone, tokenVersion: Number(user.tokenVersion || 0) },
		process.env.JWT_SECRET,
		{ algorithm: 'HS256', expiresIn: '1h' }
	)
}

async function call(baseUrl, token, method, pathname, body) {
	const response = await fetch(`${baseUrl}${pathname}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			...(body === undefined ? {} : { 'Content-Type': 'application/json' })
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) })
	})
	return { response, payload: await response.json() }
}

function reportPayload(score = 88) {
	const analysisKey = `ak_v3_${'a'.repeat(64)}`
	const resultHash = `rh_v1_${(Math.abs(Number(score)) % 16).toString(16).repeat(64)}`
	return {
		reportType: '人行信用报告',
		fileName: 'long-report.pdf',
		clientReportId: 'REPORT_local_stable_1',
		analysisResult: {
			analysisKey,
			resultHash,
			analysis_meta: {
				analysisKey,
				resultHash,
				cacheHit: false,
				cacheSource: 'async-job'
			},
			analysisExecution: {
				analysisKey,
				resultHash,
				cacheHit: false,
				cacheSource: 'async-job'
			},
			reportFormat: { type: 'PDF', version: '2015' },
			basic_info: { name: '测试客户', id_card: 'REDACTED_TEST_ID' },
			report: { totalScore: score, riskLevel: 'low', debtCount: 3 },
			credit_debt: { total_debt: 123456 },
			query_analysis: { summary: { last_6m: { total: 9 } } },
			deterministic_dimensions: { totalAccountCount: 3 },
			largeRawSentinel: 'must-only-appear-in-detail'
		}
	}
}

function verifiedJobResult(identity) {
	const result = attachEvidenceV2({
		derivation_meta: { rules_version: 'credit-rules-deterministic-v3' },
		primary_rule_score: { score: 100 },
		serverCanonicalMarker: 'must-persist-from-job-result',
		serverTransportEnvelope: {
			requestId: 'must-not-persist',
			cacheHit: true,
			publicValue: 'kept'
		},
		basic_info: { name: '测试客户', id_card: 'REDACTED_TEST_ID' },
		credit_debt: {
			total_debt: 0,
			credit_loans: { total_balance: 0 },
			credit_cards: {
				total_limit: 0,
				total_used: 0,
				usage_rate: 0,
				shared_group_count: 0
			}
		},
		query_analysis: {
			summary: {
				last_1m: { total: 0 },
				last_3m: { total: 0 },
				last_6m: { total: 0 },
				last_12m: { total: 0 }
			}
		}
	}, {
		documentId: `doc_v2_${'6'.repeat(64)}`,
		inputKind: 'credit-report-pdf'
	})
	return {
		...result,
		...identity,
		analysis_meta: {
			...identity,
			authoritative: true,
			cachePolicy: {
				persistent: true,
				stableAcrossRestart: true
			},
			cacheHit: false,
			cacheSource: 'async-job',
			requestId: 'must-not-persist'
		}
	}
}

test('report upload is user-scoped idempotent and list responses are summaries', async (t) => {
	const owner = {
		id: 'u_report_owner',
		phone: '19600001001',
		role: 'user',
		roles: ['user'],
		nickname: 'Owner',
		tokenVersion: 0,
		reportUploadUnlimited: true
	}
	const other = {
		id: 'u_report_other',
		phone: '19600001002',
		role: 'user',
		roles: ['user'],
		nickname: 'Other',
		tokenVersion: 0,
		reportUploadUnlimited: true
	}
	const admin = {
		id: 'u_report_admin',
		phone: '19600001003',
		role: 'admin',
		roles: ['admin'],
		nickname: 'Admin',
		tokenVersion: 0
	}
	store.state().users = [owner, other, admin]
	store.state().reports = []
	store.persistSync()

	const server = app.listen(0, '127.0.0.1')
	await new Promise((resolve, reject) => {
		server.once('listening', resolve)
		server.once('error', reject)
	})
	t.after(() => new Promise((resolve) => server.close(resolve)))
	const baseUrl = `http://127.0.0.1:${server.address().port}`
	const ownerToken = tokenFor(owner)
	const otherToken = tokenFor(other)
	const adminToken = tokenFor(admin)

	const first = await call(baseUrl, ownerToken, 'POST', '/api/report/upload', reportPayload())
	assert.equal(first.response.status, 200)
	assert.equal(first.payload.code, 0)
	assert.equal(first.payload.data.reused, false)
	assert.equal(first.payload.data.clientReportId, 'REPORT_local_stable_1')
	const reportId = first.payload.data.reportId
	assert.equal(store.state().reports.length, 1)
	assert.ok(store.state().reports[0].analysisData)
	assert.equal(Object.hasOwn(store.state().reports[0], 'analysisResult'), false)

	// Simulate a report-content-v1 row, then retry the same authoritative result
	// after the response changed from a fresh job to a cache hit. Transport-only
	// metadata and display-format fallback must not turn one result into a 409.
	store.state().reports[0].contentFingerprintVersion = 'report-content-v1'
	store.state().reports[0].contentFingerprint = `rcf_v1_${'f'.repeat(64)}`
	store.persistSync()
	const recoveryPayload = reportPayload()
	recoveryPayload.fileName = '信用报告.pdf'
	recoveryPayload.reportType = '信用报告'
	recoveryPayload.analysisResult.analysis_meta.cacheHit = true
	recoveryPayload.analysisResult.analysis_meta.cacheSource = 'async-cache'
	recoveryPayload.analysisResult.analysisExecution.cacheHit = true
	recoveryPayload.analysisResult.analysisExecution.cacheSource = 'async-cache'
	recoveryPayload.analysisResult.reportFormat.version = 'unknown'
	const retry = await call(baseUrl, ownerToken, 'POST', '/api/report/upload', recoveryPayload)
	assert.equal(retry.response.status, 200)
	assert.equal(retry.payload.code, 0)
	assert.equal(retry.payload.data.reused, true)
	assert.equal(retry.payload.data.reportId, reportId)
	assert.equal(store.state().reports.length, 1)
	assert.equal(store.state().reports[0].fileName, 'long-report.pdf')
	assert.equal(store.state().reports[0].reportType, '人行信用报告')
	assert.equal(store.state().reports[0].contentFingerprintVersion, 'report-content-v2')
	assert.match(store.state().reports[0].contentFingerprint, /^rcf_v2_[a-f0-9]{64}$/)

	const conflict = await call(baseUrl, ownerToken, 'POST', '/api/report/upload', reportPayload(67))
	assert.equal(conflict.response.status, 409)

	const contradictoryIdentity = reportPayload()
	contradictoryIdentity.analysisResult.analysisExecution.resultHash = `rh_v1_${'c'.repeat(64)}`
	const contradictoryConflict = await call(baseUrl, ownerToken, 'POST', '/api/report/upload', contradictoryIdentity)
	assert.equal(contradictoryConflict.response.status, 409)
	assert.match(contradictoryConflict.payload.message || contradictoryConflict.payload.msg, /不同报告内容/)
	assert.equal(conflict.payload.code, 1001)
	assert.match(conflict.payload.message || conflict.payload.msg, /不同报告内容/)
	assert.equal(store.state().reports.length, 1)

	// clientReportId is idempotent only within its authenticated owner scope.
	// Another user may use the same local ID for unrelated content.
	const otherPayload = reportPayload(67)
	otherPayload.fileName = 'other-display-name.pdf'
	const otherUpload = await call(baseUrl, otherToken, 'POST', '/api/report/upload', otherPayload)
	assert.equal(otherUpload.response.status, 200)
	assert.equal(otherUpload.payload.code, 0)
	assert.equal(otherUpload.payload.data.reused, false)
	assert.notEqual(otherUpload.payload.data.reportId, reportId)
	assert.equal(store.state().reports.length, 2)

	const list = await call(baseUrl, ownerToken, 'POST', '/api/report/list', { page: 1, pageSize: 20 })
	assert.equal(list.payload.code, 0)
	assert.equal(list.payload.data.list.length, 1)
	const summary = list.payload.data.list[0]
	assert.equal(summary.id, reportId)
	assert.equal(summary._score, null)
	assert.equal(summary.score, null)
	assert.equal(summary._riskLevel, null)
	assert.equal(summary.riskLevel, null)
	assert.equal(summary._accountCount, null)
	assert.equal(summary.accountCount, null)
	assert.equal(summary.archivalScore, 88)
	assert.equal(summary.archivalRiskLevel, 'low')
	assert.equal(summary.archivalAccountCount, 3)
	assert.equal(summary.archivalTotalDebt, 123456)
	assert.equal(summary.archivalQuery6mCount, 9)
	assert.equal(summary.decisionState, 'archival')
	assert.equal(summary.decisionEvidenceLinked, false)
	assert.deepEqual(summary.decisionFlags, {
		score: false,
		riskLevel: false,
		accountCount: false,
		totalDebt: false,
		totalLoanBalance: false,
		cardTotalLimit: false,
		cardTotalUsed: false,
		cardUtilizationUsed: false,
		cardUtilizationRate: false,
		cardUtilizationPct: false,
		sharedCreditGroupCount: false,
		query1mCount: false,
		query3mCount: false,
		query6mCount: false,
		query12mCount: false
	})
	for (const field of [
		'totalLoanBalance',
		'cardTotalLimit',
		'cardTotalUsed',
		'cardUtilizationUsed',
		'cardUtilizationRate',
		'cardUtilizationPct',
		'sharedCreditGroupCount',
		'query1mCount',
		'query3mCount',
		'query12mCount'
	]) assert.equal(summary[field], null, `${field} must stay unknown for an unlinked report`)
	assert.equal(summary.detailAvailable, true)
	for (const forbidden of ['analysisData', 'analysisResult', 'rawAnalysis', 'raw', 'data']) {
		assert.equal(Object.hasOwn(summary, forbidden), false, `summary leaked ${forbidden}`)
	}
	assert.doesNotMatch(JSON.stringify(list.payload), /must-only-appear-in-detail/)

	const stats = await call(baseUrl, ownerToken, 'GET', '/api/report/stats')
	assert.equal(stats.payload.code, 0)
	assert.equal(stats.payload.data.totalCount, 1)
	assert.equal(stats.payload.data.latestScore, null)
	assert.equal(stats.payload.data.averageScore, null)
	assert.equal(stats.payload.data.knownScoreCount, 0)
	assert.equal(stats.payload.data.unknownScoreCount, 1)
	assert.equal(stats.payload.data.archivalLatestScore, 88)

	const overview = await call(baseUrl, adminToken, 'GET', '/api/admin/overview')
	assert.equal(overview.payload.code, 0)
	const ownerDocument = overview.payload.data.customerDocuments.find((item) => item.userId === owner.id)
	assert.ok(ownerDocument)
	assert.ok(ownerDocument.latestReport)
	assert.equal(ownerDocument.latestReport.score, null)
	assert.equal(ownerDocument.latestReport.riskLevel, null)
	assert.equal(ownerDocument.latestReport.totalDebt, null)
	assert.equal(ownerDocument.latestReport.totalLoanBalance, null)
	assert.equal(ownerDocument.latestReport.cardTotalLimit, null)
	assert.equal(ownerDocument.latestReport.cardTotalUsed, null)
	assert.equal(ownerDocument.latestReport.cardUtilizationRate, null)
	assert.equal(ownerDocument.latestReport.cardUtilizationPct, null)
	assert.equal(ownerDocument.latestReport.sharedCreditGroupCount, null)
	assert.equal(ownerDocument.latestReport.query1mCount, null)
	assert.equal(ownerDocument.latestReport.query3mCount, null)
	assert.equal(ownerDocument.latestReport.query6mCount, null)
	assert.equal(ownerDocument.latestReport.query12mCount, null)
	assert.equal(ownerDocument.latestReport.archivalScore, 88)
	assert.equal(ownerDocument.latestReport.archivalRiskLevel, 'low')
	assert.equal(ownerDocument.latestReport.archivalTotalDebt, 123456)
	assert.equal(ownerDocument.latestReport.archivalQuery6mCount, 9)
	assert.equal(ownerDocument.latestReport.decisionState, 'archival')

	const detail = await call(baseUrl, ownerToken, 'GET', `/api/report/${encodeURIComponent(reportId)}`)
	assert.equal(detail.payload.code, 0)
	assert.ok(detail.payload.data.analysisResult)
	assert.equal(detail.payload.data.analysisResult.largeRawSentinel, 'must-only-appear-in-detail')
	assert.equal(detail.payload.data.decisionEvidenceLinked, false)
	assert.equal(Object.hasOwn(detail.payload.data, 'analysisData'), false)
	assert.equal(Object.hasOwn(detail.payload.data, 'userId'), false)
	assert.equal(Object.hasOwn(detail.payload.data, 'phone'), false)

	const foreign = await call(baseUrl, otherToken, 'GET', `/api/report/${encodeURIComponent(reportId)}`)
	assert.equal(foreign.payload.code, 2001)

	// Historical rows may contain both aliases. The owner detail serializer
	// chooses one canonical result and never sends both copies.
	const legacy = {
		id: 'r_legacy_double',
		_id: 'r_legacy_double',
		userId: owner.id,
		reportType: '人行信用报告',
		fileName: 'legacy.pdf',
		analysisData: { report: { totalScore: 91 }, marker: 'canonical' },
		analysisResult: { report: { totalScore: 10 }, marker: 'stale-alias' },
		createdAt: new Date().toISOString()
	}
	store.state().reports.unshift(legacy)
	store.persistSync()
	const legacyDetail = await call(baseUrl, ownerToken, 'POST', '/api/report/detail', { reportId: legacy.id })
	assert.equal(legacyDetail.payload.code, 0)
	assert.equal(legacyDetail.payload.data.analysisResult.marker, 'canonical')
	assert.equal(Object.hasOwn(legacyDetail.payload.data, 'analysisData'), false)

	// Legacy/non-authoritative results have no strict analysisKey+resultHash
	// anchor. They still ignore explicit cache response state, while a real
	// business-content change remains a conflict.
	const fallbackPayload = reportPayload(82)
	fallbackPayload.clientReportId = 'REPORT_legacy_fallback_1'
	delete fallbackPayload.analysisResult.analysisKey
	delete fallbackPayload.analysisResult.resultHash
	delete fallbackPayload.analysisResult.analysis_meta.analysisKey
	delete fallbackPayload.analysisResult.analysis_meta.resultHash
	delete fallbackPayload.analysisResult.analysisExecution.analysisKey
	delete fallbackPayload.analysisResult.analysisExecution.resultHash
	const fallbackFirst = await call(baseUrl, ownerToken, 'POST', '/api/report/upload', fallbackPayload)
	assert.equal(fallbackFirst.response.status, 200)
	assert.equal(fallbackFirst.payload.data.reused, false)

	const fallbackRetryPayload = JSON.parse(JSON.stringify(fallbackPayload))
	fallbackRetryPayload.analysisResult.analysis_meta.cacheHit = true
	fallbackRetryPayload.analysisResult.analysis_meta.cacheSource = 'async-cache'
	fallbackRetryPayload.analysisResult.analysisExecution.cacheHit = true
	fallbackRetryPayload.analysisResult.analysisExecution.cacheSource = 'async-cache'
	const fallbackRetry = await call(baseUrl, ownerToken, 'POST', '/api/report/upload', fallbackRetryPayload)
	assert.equal(fallbackRetry.response.status, 200)
	assert.equal(fallbackRetry.payload.data.reused, true)

	const fallbackConflictPayload = JSON.parse(JSON.stringify(fallbackRetryPayload))
	fallbackConflictPayload.analysisResult.report.totalScore = 81
	const fallbackConflict = await call(baseUrl, ownerToken, 'POST', '/api/report/upload', fallbackConflictPayload)
	assert.equal(fallbackConflict.response.status, 409)
	assert.match(fallbackConflict.payload.message || fallbackConflict.payload.msg, /不同报告内容/)

	// New Web uploads bind the ordinary report row to an owner-scoped analysis
	// task. The full evidence ledger remains encrypted in analysis_results and is
	// never copied into the reports collection.
	const jobId = `aj_${'z'.repeat(24)}`
	const identity = {
		analysisKey: `ak_v3_${'1'.repeat(64)}`,
		resultHash: `rh_v1_${'2'.repeat(64)}`
	}
	const canonical = verifiedJobResult(identity)
	const originalGetAnalysisTaskResult = analysisTaskService.getAnalysisTaskResult
	analysisTaskService.getAnalysisTaskResult = (scope, requestedJobId) => {
		if (scope !== `user:${owner.id}` || requestedJobId !== jobId) return null
		return {
			job: { jobId, status: 'succeeded' },
			result: canonical,
			analysis: { ...identity, cacheHit: false, cacheSource: 'async-job' }
		}
	}
	t.after(() => { analysisTaskService.getAnalysisTaskResult = originalGetAnalysisTaskResult })
	const mappedClientAnalysis = {
		...identity,
		analysis_meta: { ...identity, authoritative: true },
		basic_info: { name: '测试客户', id_card: 'REDACTED_TEST_ID' },
		report: { totalScore: 1, riskLevel: 'forged-client-risk' },
		clientOnlyMarker: 'must-never-persist',
		// A malicious/old client may still submit private artifacts. The server
		// validates against the task result and strips these from the report row.
		evidence_v2: canonical.evidence_v2,
		evidence_meta: canonical.evidence_meta
	}
	const linkedUpload = await call(baseUrl, ownerToken, 'POST', '/api/report/upload', {
		reportType: '人行信用报告',
		fileName: 'linked-report.pdf',
		clientReportId: 'REPORT_linked_job_1',
		analysisJobId: jobId,
		analysisResult: mappedClientAnalysis
	})
	assert.equal(linkedUpload.response.status, 200)
	assert.equal(linkedUpload.payload.code, 0)
	assert.equal(linkedUpload.payload.data.analysisJobId, jobId)
	assert.equal(linkedUpload.payload.data.decisionEvidenceLinked, true)
	const linkedRow = store.state().reports.find((item) => item.id === linkedUpload.payload.data.reportId)
	assert.ok(linkedRow)
	assert.equal(linkedRow.analysisJobId, jobId)
	assert.deepEqual(linkedRow.analysisAuthority, { version: 'analysis-job-link-v1', ...identity })
	assert.equal(linkedRow.analysisData.serverCanonicalMarker, 'must-persist-from-job-result')
	assert.equal(Object.hasOwn(linkedRow.analysisData, 'clientOnlyMarker'), false)
	assert.equal(linkedRow.analysisData.serverTransportEnvelope.publicValue, 'kept')
	assert.equal(Object.hasOwn(linkedRow.analysisData.serverTransportEnvelope, 'requestId'), false)
	assert.equal(Object.hasOwn(linkedRow.analysisData.serverTransportEnvelope, 'cacheHit'), false)
	assert.equal(Object.hasOwn(linkedRow.analysisData.analysis_meta, 'cacheHit'), false)
	assert.equal(Object.hasOwn(linkedRow.analysisData.analysis_meta, 'cacheSource'), false)
	assert.equal(Object.hasOwn(linkedRow.analysisData.analysis_meta, 'requestId'), false)
	assert.deepEqual(linkedRow.analysisData.analysis_meta.cachePolicy, {
		persistent: true,
		stableAcrossRestart: true
	})
	assert.equal(Object.hasOwn(linkedRow.analysisData, 'evidence_v2'), false)
	assert.doesNotMatch(JSON.stringify(linkedRow.analysisData), /factLedger|derivedAnalysis|sourceText/)
	const linkedList = await call(baseUrl, ownerToken, 'POST', '/api/report/list', { page: 1, pageSize: 50 })
	const linkedSummary = linkedList.payload.data.list.find((item) => item.id === linkedRow.id)
	assert.ok(linkedSummary)
	assert.equal(linkedSummary.score, 100)
	assert.equal(linkedSummary.totalDebt, 0)
	assert.equal(linkedSummary.totalLoanBalance, 0)
	assert.equal(linkedSummary.cardTotalLimit, 0)
	assert.equal(linkedSummary.cardTotalUsed, 0)
	assert.equal(linkedSummary.cardUtilizationRate, 0)
	assert.equal(linkedSummary.cardUtilizationPct, 0)
	assert.equal(linkedSummary.sharedCreditGroupCount, 0)
	assert.equal(linkedSummary.query1mCount, 0)
	assert.equal(linkedSummary.query3mCount, 0)
	assert.equal(linkedSummary.query6mCount, 0)
	assert.equal(linkedSummary.query12mCount, 0)
	assert.equal(linkedSummary.evidenceVerified, true)
	assert.equal(linkedSummary.decisionEvidenceLinked, true)
	for (const field of [
		'score',
		'totalDebt',
		'totalLoanBalance',
		'cardTotalLimit',
		'cardTotalUsed',
		'cardUtilizationRate',
		'cardUtilizationPct',
		'sharedCreditGroupCount',
		'query1mCount',
		'query3mCount',
		'query6mCount',
		'query12mCount'
	]) assert.equal(linkedSummary.decisionFlags[field], true, `${field} should be verified`)

	// Simulate a row saved by the previous release, which recursively stripped
	// the stable cache policy. Owner detail must repair only its response from
	// the still-verified linked job; it must not rewrite the stored row.
	delete linkedRow.analysisData.analysis_meta.cachePolicy
	const linkedDetail = await call(baseUrl, ownerToken, 'GET', `/api/report/${encodeURIComponent(linkedRow.id)}`)
	assert.equal(linkedDetail.payload.code, 0)
	assert.equal(linkedDetail.payload.data.cardUtilizationRate, 0)
	assert.equal(linkedDetail.payload.data.cardUtilizationPct, 0)
	assert.equal(linkedDetail.payload.data.query12mCount, 0)
	assert.equal(linkedDetail.payload.data.decisionEvidenceLinked, true)
	assert.deepEqual(linkedDetail.payload.data.analysisResult.analysis_meta.cachePolicy, {
		persistent: true,
		stableAcrossRestart: true
	})
	assert.equal(Object.hasOwn(linkedRow.analysisData.analysis_meta, 'cachePolicy'), false)
	assert.equal(Object.hasOwn(linkedDetail.payload.data.analysisResult, 'evidence_v2'), false)
	assert.doesNotMatch(JSON.stringify(linkedDetail.payload.data.analysisResult), /factLedger|derivedAnalysis|sourceText/)

	const expiredLinkedId = 'r_expired_linked_job'
	store.state().reports.unshift({
		id: expiredLinkedId,
		_id: expiredLinkedId,
		reportId: expiredLinkedId,
		clientReportId: 'REPORT_expired_linked_job',
		userId: owner.id,
		reportType: '人行信用报告',
		fileName: 'expired-linked-report.pdf',
		createdAt: new Date().toISOString(),
		analysisJobId: `aj_${'y'.repeat(24)}`,
		analysisAuthority: { version: 'analysis-job-link-v1', ...identity },
		analysisData: JSON.parse(JSON.stringify(linkedRow.analysisData))
	})
	const expiredLinkedDetail = await call(baseUrl, ownerToken, 'GET', `/api/report/${expiredLinkedId}`)
	assert.equal(expiredLinkedDetail.payload.code, 0)
	assert.equal(expiredLinkedDetail.payload.data.evidenceVerified, false)
	assert.equal(Object.hasOwn(expiredLinkedDetail.payload.data.analysisResult.analysis_meta, 'cachePolicy'), false)
	assert.equal(Object.hasOwn(expiredLinkedDetail.payload.data.analysisResult, 'evidence_v2'), false)

	const linkedOverview = await call(baseUrl, adminToken, 'GET', '/api/admin/overview')
	const linkedAdminReport = linkedOverview.payload.data.customerDocuments
		.find((item) => item.userId === owner.id)
		.reports.find((item) => item.id === linkedRow.id)
	assert.ok(linkedAdminReport)
	assert.equal(linkedAdminReport.totalLoanBalance, 0)
	assert.equal(linkedAdminReport.cardTotalLimit, 0)
	assert.equal(linkedAdminReport.cardTotalUsed, 0)
	assert.equal(linkedAdminReport.cardUtilizationRate, 0)
	assert.equal(linkedAdminReport.cardUtilizationPct, 0)
	assert.equal(linkedAdminReport.sharedCreditGroupCount, 0)
	assert.equal(linkedAdminReport.query1mCount, 0)
	assert.equal(linkedAdminReport.query3mCount, 0)
	assert.equal(linkedAdminReport.query6mCount, 0)
	assert.equal(linkedAdminReport.query12mCount, 0)

	// A historical report may contain a complete signed evidence object copied
	// into its row, but without an owner-scoped job link it is archival only.
	const historicalEmbeddedId = 'r_historical_embedded_evidence'
	store.state().reports.unshift({
		id: historicalEmbeddedId,
		_id: historicalEmbeddedId,
		caseId: historicalEmbeddedId,
		userId: owner.id,
		reportType: '人行信用报告',
		fileName: 'historical-embedded.pdf',
		analysisData: canonical,
		createdAt: '2099-01-01T00:00:00.000Z',
		updatedAt: '2099-01-01T00:00:00.000Z'
	})
	store.persistSync()
	const archivalList = await call(baseUrl, ownerToken, 'POST', '/api/report/list', { page: 1, pageSize: 50 })
	const archivalEmbeddedSummary = archivalList.payload.data.list.find((item) => item.id === historicalEmbeddedId)
	assert.ok(archivalEmbeddedSummary)
	assert.equal(archivalEmbeddedSummary.score, null)
	assert.equal(archivalEmbeddedSummary.totalDebt, null)
	assert.equal(archivalEmbeddedSummary.totalLoanBalance, null)
	assert.equal(archivalEmbeddedSummary.cardTotalLimit, null)
	assert.equal(archivalEmbeddedSummary.cardTotalUsed, null)
	assert.equal(archivalEmbeddedSummary.cardUtilizationRate, null)
	assert.equal(archivalEmbeddedSummary.cardUtilizationPct, null)
	assert.equal(archivalEmbeddedSummary.sharedCreditGroupCount, null)
	assert.equal(archivalEmbeddedSummary.query1mCount, null)
	assert.equal(archivalEmbeddedSummary.query3mCount, null)
	assert.equal(archivalEmbeddedSummary.query6mCount, null)
	assert.equal(archivalEmbeddedSummary.query12mCount, null)
	assert.equal(archivalEmbeddedSummary.evidenceVerified, false)
	assert.equal(archivalEmbeddedSummary.decisionState, 'archival')
	assert.equal(archivalEmbeddedSummary.archivalScore, 100)
	const archivalEmbeddedDetail = await call(baseUrl, ownerToken, 'GET', `/api/report/${historicalEmbeddedId}`)
	assert.equal(archivalEmbeddedDetail.payload.code, 0)
	assert.equal(archivalEmbeddedDetail.payload.data.evidenceVerified, false)
	assert.equal(Object.hasOwn(archivalEmbeddedDetail.payload.data.analysisResult, 'evidence_v2'), false)
	assert.doesNotMatch(JSON.stringify(archivalEmbeddedDetail.payload.data.analysisResult), /factLedger|derivedAnalysis|sourceText/)
	const archivalStats = await call(baseUrl, ownerToken, 'GET', '/api/report/stats')
	assert.equal(archivalStats.payload.data.knownScoreCount, 1)
	assert.equal(archivalStats.payload.data.latestScore, null)
	const archivalOverview = await call(baseUrl, adminToken, 'GET', '/api/admin/overview')
	const archivalAdminReport = archivalOverview.payload.data.customerDocuments
		.find((item) => item.userId === owner.id)
		.reports.find((item) => item.id === historicalEmbeddedId)
	assert.ok(archivalAdminReport)
	assert.equal(archivalAdminReport.score, null)
	assert.equal(archivalAdminReport.totalDebt, null)
	assert.equal(archivalAdminReport.totalLoanBalance, null)
	assert.equal(archivalAdminReport.cardTotalLimit, null)
	assert.equal(archivalAdminReport.cardTotalUsed, null)
	assert.equal(archivalAdminReport.cardUtilizationRate, null)
	assert.equal(archivalAdminReport.cardUtilizationPct, null)
	assert.equal(archivalAdminReport.sharedCreditGroupCount, null)
	assert.equal(archivalAdminReport.query1mCount, null)
	assert.equal(archivalAdminReport.query3mCount, null)
	assert.equal(archivalAdminReport.query6mCount, null)
	assert.equal(archivalAdminReport.query12mCount, null)
	assert.equal(archivalAdminReport.evidenceVerified, false)
	assert.equal(archivalAdminReport.archivalScore, 100)

	const wrongIdentityUpload = await call(baseUrl, ownerToken, 'POST', '/api/report/upload', {
		reportType: '人行信用报告',
		fileName: 'wrong-identity.pdf',
		clientReportId: 'REPORT_wrong_identity_1',
		analysisJobId: jobId,
		analysisResult: {
			...mappedClientAnalysis,
			analysisKey: `ak_v3_${'3'.repeat(64)}`,
			analysis_meta: { ...identity, analysisKey: `ak_v3_${'3'.repeat(64)}` }
		}
	})
	assert.equal(wrongIdentityUpload.response.status, 422)
	assert.match(wrongIdentityUpload.payload.message || '', /不一致|失效|重新分析/)
})
