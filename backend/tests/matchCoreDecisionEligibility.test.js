'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const apiMatch = require('../backend/services/matchCore.js')
const { attachEvidenceV2, rehashEvidenceV2 } = require('./evidenceCanonicalFixture.js')

const publishableEvidenceMeta = (scope = ['primary_rule_score.score']) => ({
	version: 'evidence-v2',
	status: 'publishable',
	publication_gate: 'passed',
	authoritative_scope: scope,
	manifest_hash: `mh_v2_${'a'.repeat(64)}`,
	evidence_hash: `eg_v2_${'b'.repeat(64)}`,
	fact_hash: `fl_v2_${'c'.repeat(64)}`,
	metric_hash: `da_v2_${'d'.repeat(64)}`
})

// 真断言夹具（修前是死断言）：合同常量必须取生产真值 `rpt.credit/evidence-first-analysis/2.0`
// （matchCore.js 首关），并且走 evidenceCanonicalFixture 的正规构建 + rehash，
// 让 publication gate 真的判定通过。修前这里写的是一个生产码里根本不存在的
// 旧前缀变体，inspectEvidenceV2 首关即 fail('ARTIFACT_CONTRACT_INVALID')，
// 于是 debtRatio 为 null 是靠错误路径凑出来的，断言并没有检验它声称的东西。
const debtRatioArtifacts = ({ numerator = 1, denominator = 100, value = 0.01 } = {}) => {
	const payload = verifiedEvidencePayload()
	payload.evidence_v2.derivedAnalysis.metrics.debtRatio = {
		status: 'computed',
		formulaId: 'debt-ratio-client-supplied-v1',
		numerator: { type: 'money', minor: numerator },
		denominator: { type: 'money', minor: denominator },
		value: { type: 'rate', value },
		inputFactIds: ['fact-a', 'fact-b']
	}
	return rehashEvidenceV2(payload)
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
		documentId: `doc_v2_${'e'.repeat(64)}`,
		inputKind: 'credit-report-pdf'
	})
}

function verifiedComputedEvidencePayload() {
	const payload = verifiedEvidencePayload()
	const metrics = payload.evidence_v2.derivedAnalysis.metrics
	metrics.totalLoanBalance = {
		...metrics.totalLoanBalance,
		status: 'computed',
		formulaId: 'loan-balance-sum-v2',
		value: { type: 'money', currency: 'CNY', minor: 45095700, scale: 2 }
	}
	metrics.totalDebt = {
		...metrics.totalDebt,
		status: 'computed',
		formulaId: 'total-debt-v2',
		value: { type: 'money', currency: 'CNY', minor: 48882500, scale: 2 }
	}
	metrics.cardUtilization = {
		...metrics.cardUtilization,
		status: 'computed',
		formulaId: 'card-utilization-cny-v2',
		numerator: { type: 'money', currency: 'CNY', minor: 3786800, scale: 2 },
		denominator: { type: 'money', currency: 'CNY', minor: 4000000, scale: 2 },
		value: { type: 'rate-bps', value: 9467 },
		facilityTrace: [
			{ facilityId: 'shared-1', memberEntityIds: ['card-1', 'card-2'] },
			{ facilityId: 'single-1', memberEntityIds: ['card-3'] }
		]
	}
	metrics.cardOutstanding = {
		...metrics.cardOutstanding,
		status: 'computed',
		formulaId: 'card-outstanding-cny-v1',
		value: { type: 'money', currency: 'CNY', minor: 3786800, scale: 2 },
		facilityTrace: [
			{ facilityId: 'shared-1', memberEntityIds: ['card-1', 'card-2'] },
			{ facilityId: 'single-1', memberEntityIds: ['card-3'] }
		]
	}
	metrics.queryCounts = {
		...metrics.queryCounts,
		status: 'computed',
		formulaId: 'hard-query-calendar-window-v2',
		value: { last_1m: 1, last_3m: 3, last_6m: 6, last_12m: 28 }
	}
	payload.credit_debt = {
		total_debt: 488825,
		credit_loans: { total_balance: 450957 },
		credit_cards: {
			total_limit: 40000,
			total_used: 37868,
			utilization_used: 37868,
			usage_rate: 0.9467,
			shared_group_count: 1
		}
	}
	payload.query_analysis = {
		summary: {
			last_1m: { total: 1 },
			last_3m: { total: 3 },
			last_6m: { total: 6 },
			last_12m: { total: 28 }
		}
	}
	return rehashEvidenceV2(payload)
}

const legacyPayload = (score, debtRatio, riskLevel) => ({
	report: {
		totalScore: score,
		adjustedTotalScore: 99,
		riskLevel,
		scores: {
			credit_history: 99,
			query_frequency: 99,
			account_structure: 99,
			repayment_record: 99
		}
	},
	dimensions: { debtRatio, overdueCount: 0 },
	algorithmReport: { integratedRisk: { score: 1 } },
	compositeMeta: { hasBaseScore: false, adjustedTotalScore: 99 }
})

test('server matching ignores archival score, risk and untraced debt ratio', () => {
	const product = {
		rules: {
			minScore: 90,
			maxDebtRatio: 0.3,
			preferLowScore: true,
			preferLowDebt: true,
			preferGoodHistory: true
		}
	}
	const firstProfile = apiMatch.buildUnifiedMatchProfile(legacyPayload(1, 0.99, 'high'))
	const secondProfile = apiMatch.buildUnifiedMatchProfile(legacyPayload(99, 0.01, 'low'))
	const firstResult = apiMatch.computeProductMatchRate(product, firstProfile)
	const secondResult = apiMatch.computeProductMatchRate(product, secondProfile)

	for (const profile of [firstProfile, secondProfile]) {
		assert.equal(profile.totalScore, null)
		assert.equal(profile.hasDecisionScore, false)
		assert.equal(profile.debtRatio, null)
		assert.equal(profile.hasDecisionDebtRatio, false)
		assert.equal(profile.riskLevel, 'unknown')
		assert.equal(profile.integratedRiskScore, null)
	}
	assert.equal(firstResult.matchRate, secondResult.matchRate)
	assert.deepEqual(firstResult.matchReasons, secondResult.matchReasons)
	assert.equal(firstResult.matchReasons.some((reason) => /低于|偏高/.test(reason)), false)
})

test('server matching accepts only cryptographically verified evidence-v2 primary scores', () => {
	const archived = apiMatch.buildUnifiedMatchProfile({ primary_rule_score: { score: 61 } })
	assert.equal(archived.totalScore, null)

	const forgedMetaOnly = apiMatch.buildUnifiedMatchProfile({
		primary_rule_score: { score: 61 },
		evidence_meta: publishableEvidenceMeta()
	})
	assert.equal(forgedMetaOnly.totalScore, null)
	assert.equal(forgedMetaOnly.hasDecisionScore, false)
	assert.equal(forgedMetaOnly.hasVerifiedEvidenceV2, false)

	const attested = apiMatch.buildUnifiedMatchProfile(verifiedEvidencePayload())
	assert.equal(attested.totalScore, 100)
	assert.equal(attested.hasDecisionScore, true)
	assert.equal(attested.hasVerifiedEvidenceV2, true)

	const reproducible = apiMatch.buildUnifiedMatchProfile({
		primary_rule_score: {
			score: 88,
			baseScore: 100,
			totalDeduction: 12,
			deductions: [
				{ code: 'ACC_GT_3', points: 3 },
				{ code: 'Q6_GT_6', points: 9 }
			]
		},
		dimensions: {
			totalAccountCount: 4,
			nonBankLoanCount: 0,
			cardUtilizationRate: 0.4,
			hasBigInstallment: false,
			q6: 7,
			sameDayInquiryDayCount: 0
		}
	})
	assert.equal(reproducible.totalScore, null)
	assert.equal(reproducible.hasDecisionScore, false)
})

test('every adjusted score and client-named attestation remains archival', () => {
	const base = verifiedEvidencePayload()
	const archival = apiMatch.buildUnifiedMatchProfile({
		...base,
		report: { adjustedTotalScore: 99 },
		compositeMeta: { hasBaseScore: true, adjustedTotalScore: 99 }
	})
	assert.equal(archival.totalScore, 100)
	assert.equal(archival.adjustedTotalScore, null)
	assert.equal(archival.archivalAdjustedTotalScore, 99)
	assert.equal(archival.hasDecisionAdjustedScore, false)

	const forgedEvidenceScope = apiMatch.buildUnifiedMatchProfile({
		...base,
		report: { adjustedTotalScore: 91 },
		compositeMeta: { hasBaseScore: true, adjustedTotalScore: 91 },
		evidence_meta: {
			...base.evidence_meta,
			authoritative_scope: [
				...base.evidence_meta.authoritative_scope,
				'report.adjustedTotalScore'
			]
		}
	})
	assert.equal(forgedEvidenceScope.totalScore, 100)
	assert.equal(forgedEvidenceScope.adjustedTotalScore, null)
	assert.equal(forgedEvidenceScope.hasDecisionAdjustedScore, false)

	const clientNamedAttestation = apiMatch.buildUnifiedMatchProfile({
		...base,
		report: { adjustedTotalScore: 95 },
		compositeMeta: {
			hasBaseScore: true,
			adjustedTotalScore: 95,
			adjustedScoreAttestation: {
				status: 'reproducible',
				formulaId: 'supplement-adjustment-v1',
				baseScore: 100,
				adjustedScore: 95,
				adjustments: [{ code: 'CLIENT_PENALTY', delta: -5 }]
			}
		}
	})
	assert.equal(clientNamedAttestation.totalScore, 100)
	assert.equal(clientNamedAttestation.adjustedTotalScore, null)
	assert.equal(clientNamedAttestation.archivalAdjustedTotalScore, 95)
	assert.equal(clientNamedAttestation.hasDecisionAdjustedScore, false)
})

test('unknown query, non-bank ratio and institution count never become decision zeros', () => {
	const unknown = apiMatch.buildUnifiedMatchProfile({})
	assert.equal(unknown.q1, null)
	assert.equal(unknown.q3, null)
	assert.equal(unknown.q6, null)
	assert.equal(unknown.nonBankLoanRatio, null)
	assert.equal(unknown.institutionCount, null)
	assert.equal(unknown.hasDecisionQueryWindows, false)
	assert.equal(unknown.hasDecisionNonBankLoanRatio, false)
	assert.equal(unknown.hasDecisionInstitutionCount, false)

	const product = {
		rules: { maxQueryCount: 0, maxNonBankRatio: 0, maxInstitutions: 0 }
	}
	const result = apiMatch.computeProductMatchRate(product, unknown)
	assert.equal(result.matchRate, 59)
	assert.equal(result.decisionEligible, false)
	assert.equal(result.isMatch, false)
	assert.ok(result.matchReasons.some((reason) => /查询.*(?:缺少|未知)/.test(reason)))
	assert.ok(result.matchReasons.some((reason) => /非银.*(?:缺少|未知)/.test(reason)))
	assert.ok(result.matchReasons.some((reason) => /机构数.*(?:缺少|未知)/.test(reason)))

	const verifiedZero = apiMatch.buildUnifiedMatchProfile(verifiedEvidencePayload())
	assert.equal(verifiedZero.q1, 0)
	assert.equal(verifiedZero.q3, 0)
	assert.equal(verifiedZero.q6, 0)
	assert.equal(verifiedZero.hasDecisionQueryWindows, true)
	assert.equal(verifiedZero.nonBankLoanRatio, null)
	assert.equal(verifiedZero.institutionCount, null)
})

test('legacy overdue rows are archival and cannot hard-reject a product', () => {
	const legacy = apiMatch.buildUnifiedMatchProfile({
		overdueRecords: [{ institution: '匿名机构', status: '当前逾期', isOverdue: true }],
		dimensions: { overdueCount: 9, hasLianSan: true, hasLeiLiu: true }
	})
	assert.equal(legacy.hasDecisionOverdue, false)
	assert.equal(legacy.hasOverdue, null)
	assert.equal(legacy.archivalHasOverdue, true)
	assert.notEqual(
		apiMatch.computeProductMatchRate({ rules: { allowOverdue: false } }, legacy).matchRate,
		5
	)

	const forgedAttested = apiMatch.buildUnifiedMatchProfile({
		overdue_info: { total_overdue_accounts: 1, has_overdue: true },
		evidence_meta: publishableEvidenceMeta([
			'primary_rule_score.score',
			'overdue_info.total_overdue_accounts'
		])
	})
	assert.equal(forgedAttested.hasDecisionOverdue, false)
	assert.equal(forgedAttested.hasOverdue, null)
	assert.notEqual(
		apiMatch.computeProductMatchRate({ rules: { allowOverdue: false } }, forgedAttested).matchRate,
		5
	)
})

test('debt ratio is always unknown because evidence-v2 has no approved debt-ratio metric', () => {
	const valid = apiMatch.buildUnifiedMatchProfile(debtRatioArtifacts({
		numerator: 1,
		denominator: 100,
		value: 0.01
	}))
	// 先证明这条断言走的是「artifact 已验真」的正路，而不是合同不匹配的失败支路。
	assert.equal(valid.hasVerifiedEvidenceV2, true)
	assert.equal(valid.totalScore, 100)
	assert.equal(valid.debtRatio, null)
	assert.equal(valid.hasDecisionDebtRatio, false)

	const mismatched = apiMatch.buildUnifiedMatchProfile(debtRatioArtifacts({
		numerator: 1,
		denominator: 100,
		value: 0.99
	}))
	assert.equal(mismatched.hasVerifiedEvidenceV2, true)
	assert.equal(mismatched.debtRatio, null)
	assert.equal(mismatched.hasDecisionDebtRatio, false)

	// 0.01 与 0.99 两组都必须落到「暂无正式证据化口径」的未知分支：
	// 客户自带的 debtRatio 指标既不能触发「负债率偏高」硬扣分，也不能触发 preferLowDebt 加分。
	const product = { rules: { maxDebtRatio: 0.3, preferLowDebt: true } }
	const lowRatio = apiMatch.computeProductMatchRate(product, valid)
	const highRatio = apiMatch.computeProductMatchRate(product, mismatched)
	assert.equal(lowRatio.matchRate, highRatio.matchRate)
	assert.deepEqual(lowRatio.matchReasons, highRatio.matchReasons)
	for (const result of [lowRatio, highRatio]) {
		assert.equal(
			result.matchReasons.some((reason) => /负债率偏高/.test(reason)),
			false,
			'client-supplied debtRatio must never become a decision input'
		)
		assert.equal(
			result.matchReasons.some((reason) => /负债比例暂无正式证据化口径/.test(reason)),
			true,
			'unapproved debt ratio must stay an explicit unknown'
		)
	}
})

test('decision summary exposes raw legacy values only as archival and verified metrics as decisions', () => {
	const archival = apiMatch.buildDecisionSummary({
		report: { totalScore: 88, riskLevel: 'low', debtCount: 3 },
		credit_debt: { total_debt: 123456 },
		query_analysis: { summary: { last_6m: { total: 9 } } }
	})
	assert.deepEqual(
		{
			score: archival.score,
			riskLevel: archival.riskLevel,
			accountCount: archival.accountCount,
			totalDebt: archival.totalDebt,
			query6mCount: archival.query6mCount
		},
		{ score: null, riskLevel: null, accountCount: null, totalDebt: null, query6mCount: null }
	)
	assert.deepEqual(archival.archival, {
		score: 88,
		riskLevel: 'low',
		accountCount: 3,
		totalDebt: 123456,
		query6mCount: 9
	})
	assert.equal(archival.decisionState, 'archival')

	const embeddedButUntrusted = apiMatch.buildDecisionSummary(verifiedEvidencePayload())
	assert.equal(embeddedButUntrusted.score, null)
	assert.equal(embeddedButUntrusted.totalDebt, null)
	assert.equal(embeddedButUntrusted.totalLoanBalance, null)
	assert.equal(embeddedButUntrusted.cardTotalLimit, null)
	assert.equal(embeddedButUntrusted.cardTotalUsed, null)
	assert.equal(embeddedButUntrusted.cardUtilizationRate, null)
	assert.equal(embeddedButUntrusted.cardUtilizationPct, null)
	assert.equal(embeddedButUntrusted.sharedCreditGroupCount, null)
	assert.equal(embeddedButUntrusted.query1mCount, null)
	assert.equal(embeddedButUntrusted.query3mCount, null)
	assert.equal(embeddedButUntrusted.query6mCount, null)
	assert.equal(embeddedButUntrusted.query12mCount, null)
	assert.equal(embeddedButUntrusted.evidenceVerified, false)
	assert.equal(embeddedButUntrusted.evidenceReason, 'EVIDENCE_NOT_SERVER_TRUSTED')

	const verified = apiMatch.buildDecisionSummary(
		verifiedEvidencePayload(),
		{ evidenceTrusted: true }
	)
	assert.equal(verified.score, 100)
	assert.equal(verified.totalDebt, 0)
	assert.equal(verified.totalLoanBalance, 0)
	assert.equal(verified.cardTotalLimit, 0)
	assert.equal(verified.cardTotalUsed, 0)
	assert.equal(verified.cardUtilizationRate, 0)
	assert.equal(verified.cardUtilizationPct, 0)
	assert.equal(verified.sharedCreditGroupCount, 0)
	assert.equal(verified.query1mCount, 0)
	assert.equal(verified.query3mCount, 0)
	assert.equal(verified.query6mCount, 0)
	assert.equal(verified.query12mCount, 0)
	assert.equal(verified.decisionFlags.score, true)
	assert.equal(verified.decisionFlags.totalDebt, true)
	assert.equal(verified.decisionFlags.totalLoanBalance, true)
	assert.equal(verified.decisionFlags.cardTotalLimit, true)
	assert.equal(verified.decisionFlags.cardTotalUsed, true)
	assert.equal(verified.decisionFlags.cardUtilizationRate, true)
	assert.equal(verified.decisionFlags.cardUtilizationPct, true)
	assert.equal(verified.decisionFlags.sharedCreditGroupCount, true)
	assert.equal(verified.decisionFlags.query1mCount, true)
	assert.equal(verified.decisionFlags.query3mCount, true)
	assert.equal(verified.decisionFlags.query6mCount, true)
	assert.equal(verified.decisionFlags.query12mCount, true)
	assert.equal(verified.decisionFlags.riskLevel, false)
	assert.equal(verified.decisionFlags.accountCount, false)

	const computed = apiMatch.buildDecisionSummary(
		verifiedComputedEvidencePayload(),
		{ evidenceTrusted: true }
	)
	assert.equal(computed.totalDebt, 488825)
	assert.equal(computed.totalLoanBalance, 450957)
	assert.equal(computed.cardTotalLimit, 40000)
	assert.equal(computed.cardTotalUsed, 37868)
	assert.equal(computed.cardUtilizationRate, 0.9467)
	assert.equal(computed.cardUtilizationPct, 94.67)
	assert.equal(computed.sharedCreditGroupCount, 1)
	assert.equal(computed.query1mCount, 1)
	assert.equal(computed.query3mCount, 3)
	assert.equal(computed.query6mCount, 6)
	assert.equal(computed.query12mCount, 28)
	for (const field of [
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
	]) assert.equal(computed.decisionFlags[field], true, `${field} should be decision eligible`)

	const tampered = verifiedComputedEvidencePayload()
	tampered.evidence_v2.derivedAnalysis.metrics.cardUtilization.value.value = 100
	const rejected = apiMatch.buildDecisionSummary(tampered, { evidenceTrusted: true })
	assert.equal(rejected.evidenceVerified, false)
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
	]) {
		assert.equal(rejected[field], null, `${field} must fail closed after evidence tampering`)
		assert.equal(rejected.decisionFlags[field], false, `${field} flag must fail closed after evidence tampering`)
	}
})
