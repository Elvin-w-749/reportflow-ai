'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-match-route-'))
process.env.DATA_DIR = dataDir
process.env.JWT_SECRET = 'match-route-authorization-test-secret'
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

async function call(baseUrl, token, body) {
	const response = await fetch(`${baseUrl}/api/match-products`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(token ? { Authorization: `Bearer ${token}` } : {})
		},
		body: JSON.stringify(body)
	})
	return { response, payload: await response.json() }
}

function verifiedEvidencePayload() {
	return attachEvidenceV2({
		derivation_meta: { rules_version: 'credit-rules-deterministic-v3' },
		primary_rule_score: { score: 100 },
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
		documentId: `doc_v2_${'9'.repeat(64)}`,
		inputKind: 'credit-report-pdf'
	})
}

test('match route only consumes an owner-scoped server report with verified evidence', async (t) => {
	const owner = {
		id: 'u_match_owner',
		phone: '19600002001',
		role: 'user',
		roles: ['user'],
		tokenVersion: 0
	}
	const other = {
		id: 'u_match_other',
		phone: '19600002002',
		role: 'user',
		roles: ['user'],
		tokenVersion: 0
	}
	const verified = verifiedEvidencePayload()
	const analysisIdentity = {
		analysisKey: `ak_v3_${'7'.repeat(64)}`,
		resultHash: `rh_v1_${'8'.repeat(64)}`
	}
	Object.assign(verified, analysisIdentity, {
		analysis_meta: { ...analysisIdentity, authoritative: true }
	})
	const tampered = JSON.parse(JSON.stringify(verified))
	tampered.evidence_v2.derivedAnalysis.metrics.primaryScore.value.value = 1
	const canonicalIdentityMismatch = JSON.parse(JSON.stringify(verified))
	canonicalIdentityMismatch.analysisKey = `ak_v3_${'4'.repeat(64)}`
	canonicalIdentityMismatch.analysis_meta.analysisKey = canonicalIdentityMismatch.analysisKey
	const forgedMetaOnly = {
		primary_rule_score: { score: 99 },
		evidence_meta: verified.evidence_meta
	}
	store.state().users = [owner, other]
	const jobIds = {
		verified: `aj_${'a'.repeat(24)}`,
		tampered: `aj_${'b'.repeat(24)}`,
		forged: `aj_${'c'.repeat(24)}`,
		foreign: `aj_${'d'.repeat(24)}`,
		identityMismatch: `aj_${'e'.repeat(24)}`
	}
	const authority = { version: 'analysis-job-link-v1', ...analysisIdentity }
	store.state().reports = [
		{ id: 'r_match_verified', userId: owner.id, analysisJobId: jobIds.verified, analysisAuthority: authority, analysisData: { report: { totalScore: 100 } }, createdAt: new Date().toISOString() },
		{ id: 'r_match_legacy', userId: owner.id, analysisData: { report: { totalScore: 99 } }, createdAt: new Date().toISOString() },
		{ id: 'r_match_tampered', userId: owner.id, analysisJobId: jobIds.tampered, analysisAuthority: authority, analysisData: {}, createdAt: new Date().toISOString() },
		{ id: 'r_match_forged', userId: owner.id, analysisJobId: jobIds.forged, analysisAuthority: authority, analysisData: {}, createdAt: new Date().toISOString() },
		{ id: 'r_match_identity_mismatch', userId: owner.id, analysisJobId: jobIds.identityMismatch, analysisAuthority: authority, analysisData: {}, createdAt: new Date().toISOString() },
		{ id: 'r_match_foreign', userId: other.id, analysisJobId: jobIds.foreign, analysisAuthority: authority, analysisData: {}, createdAt: new Date().toISOString() }
	]
	store.state().supplementMaterials = []
	store.persistSync()
	const originalGetAnalysisTaskResult = analysisTaskService.getAnalysisTaskResult
	analysisTaskService.getAnalysisTaskResult = (scope, jobId) => {
		const result = jobId === jobIds.verified || jobId === jobIds.foreign
			? verified
			: (jobId === jobIds.tampered
				? tampered
				: (jobId === jobIds.forged
					? forgedMetaOnly
					: (jobId === jobIds.identityMismatch ? canonicalIdentityMismatch : null)))
		if (!result) return null
		return {
			job: { jobId, status: 'succeeded' },
			result,
			analysis: { ...analysisIdentity, cacheHit: false, cacheSource: 'async-job' },
			scope
		}
	}
	t.after(() => { analysisTaskService.getAnalysisTaskResult = originalGetAnalysisTaskResult })

	const server = app.listen(0, '127.0.0.1')
	await new Promise((resolve, reject) => {
		server.once('listening', resolve)
		server.once('error', reject)
	})
	t.after(() => new Promise((resolve) => server.close(resolve)))
	const baseUrl = `http://127.0.0.1:${server.address().port}`
	const ownerToken = tokenFor(owner)

	const unauthorized = await call(baseUrl, '', { reportId: 'r_match_verified', supplement: {} })
	assert.equal(unauthorized.response.status, 401)

	const clientOnly = await call(baseUrl, ownerToken, { reportData: verified })
	assert.equal(clientOnly.response.status, 400)
	assert.equal(clientOnly.payload.success, false)
	assert.equal(clientOnly.payload.errCode, 'CLIENT_REPORT_DATA_REJECTED')

	const foreign = await call(baseUrl, ownerToken, { reportId: 'r_match_foreign', supplement: {} })
	assert.equal(foreign.response.status, 404)
	assert.equal(foreign.payload.errCode, 'REPORT_NOT_FOUND')

	for (const reportId of ['r_match_legacy', 'r_match_tampered', 'r_match_forged', 'r_match_identity_mismatch']) {
		const closed = await call(baseUrl, ownerToken, { reportId, supplement: {} })
		assert.equal(closed.response.status, 422, reportId)
		assert.equal(closed.payload.success, false, reportId)
		assert.equal(closed.payload.errCode, 'REPORT_EVIDENCE_NOT_VERIFIED', reportId)
		assert.equal(closed.payload.decisionEligible, false, reportId)
	}

	const forgedEnvelope = await call(baseUrl, ownerToken, {
		reportId: 'r_match_verified',
		evidence_meta: verified.evidence_meta,
		supplement: {}
	})
	assert.equal(forgedEnvelope.response.status, 400)
	assert.equal(forgedEnvelope.payload.errCode, 'SERVER_OWNED_MATCH_INPUT')

	const forgedSupplement = await call(baseUrl, ownerToken, {
		reportId: 'r_match_verified',
		supplement: {
			productMatchUnlocked: true,
			evidence_v2: verified.evidence_v2
		}
	})
	assert.equal(forgedSupplement.response.status, 400)
	assert.equal(forgedSupplement.payload.errCode, 'SERVER_OWNED_MATCH_INPUT')

	const forgedUnlock = await call(baseUrl, ownerToken, {
		reportId: 'r_match_verified',
		supplement: {
			productMatchUnlocked: true,
			productUnlockMissing: [],
			hasStableIncomeEvidence: true,
			hasAssetEvidence: true,
			hasBusinessEvidence: true,
			stableMonths: 120,
			monthlyIncome: 999999999
		}
	})
	const emptySupplement = await call(baseUrl, ownerToken, {
		reportId: 'r_match_verified',
		supplement: {}
	})
	for (const result of [forgedUnlock, emptySupplement]) {
		assert.equal(result.response.status, 200)
		assert.equal(result.payload.success, true)
		assert.equal(result.payload.locked, true)
		assert.deepEqual(result.payload.materialGate, {
			version: 'server-reviewed-materials-v1',
			unlocked: false,
			completedGroups: [],
			missing: ['学历信息', '社保或公积金', '工资流水或个税', '房产或车辆资产'],
			evidence: { stableIncome: false, asset: false, business: false }
		})
	}
	assert.deepEqual(forgedUnlock.payload.materialGate, emptySupplement.payload.materialGate)

	store.state().supplementMaterials = [
		// Wrong owner/case and unscoped aliases never participate.
		{ id: 'foreign-income', userId: other.id, reportId: 'r_match_verified', materialType: 'payroll', status: 'confirmed', fileUrl: 'https://files.example/foreign.pdf' },
		{ id: 'wrong-case-asset', userId: owner.id, caseId: 'r_other_case', materialType: 'vehicle', status: 'confirmed', fileUrl: 'https://files.example/car.pdf' },
		{ id: 'wrong-report-asset', userId: owner.id, caseId: 'r_match_verified', reportId: 'r_other_report', materialType: 'vehicle', status: 'confirmed', fileUrl: 'https://files.example/other-car.pdf' },
		{ id: 'legacy-alias', userId: owner.id, clientReportId: 'r_match_verified', materialType: 'property', status: 'confirmed', fileUrl: 'https://files.example/legacy.pdf' },
		// Final review answers education; an explicit unavailable row answers a
		// group but never creates positive evidence.
		{ id: 'education', userId: owner.id, caseId: 'r_match_verified', reportId: 'r_match_verified', materialType: 'education', status: 'confirmed' },
		{ id: 'fund-none', userId: owner.id, caseId: 'r_match_verified', reportId: 'r_match_verified', materialType: 'housing_fund', status: 'unavailable', unavailable: true },
		{ id: 'payroll-reviewed', userId: owner.id, caseId: 'r_match_verified', reportId: 'r_match_verified', materialType: 'payroll', status: 'verified', attachments: [{ fileUrl: 'https://files.example/payroll.pdf' }] },
		{ id: 'property-none', userId: owner.id, caseId: 'r_match_verified', reportId: 'r_match_verified', materialType: 'property', status: 'unavailable', unavailable: true },
		// A remote file without a final staff review cannot assert asset evidence.
		{ id: 'vehicle-pending', userId: owner.id, caseId: 'r_match_verified', reportId: 'r_match_verified', materialType: 'vehicle', status: 'uploaded', fileUrl: 'https://files.example/vehicle.pdf' },
		{ id: 'business-reviewed', userId: owner.id, caseId: 'r_match_verified', reportId: 'r_match_verified', materialType: 'business_operation', status: 'approved', uploadUrl: '/uploads/business-proof.pdf' }
	]

	const success = await call(baseUrl, ownerToken, {
		reportId: 'r_match_verified',
		supplement: {
			productMatchUnlocked: false,
			hasStableIncomeEvidence: false,
			hasAssetEvidence: true,
			hasBusinessEvidence: false
		}
	})
	assert.equal(success.response.status, 200)
	assert.equal(success.payload.success, true)
	assert.equal(success.payload.locked, false)
	assert.equal(success.payload.reportId, 'r_match_verified')
	assert.equal(success.payload.evidenceVerified, true)
	assert.equal(success.payload.decisionEligible, true)
	assert.deepEqual(success.payload.materialGate, {
		version: 'server-reviewed-materials-v1',
		unlocked: true,
		completedGroups: ['education', 'social_or_fund', 'payroll_or_tax', 'property_or_vehicle'],
		missing: [],
		evidence: { stableIncome: false, asset: false, business: false }
	})
	assert.ok(Array.isArray(success.payload.products))
})
