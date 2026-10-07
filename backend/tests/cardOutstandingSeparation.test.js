'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { summarizeCreditCardUtilization } = require('../backend/services/creditCardUtilization')
const { finalizeExtractedCreditFacts } = require('../backend/services/creditAnalysisService')
const { buildDecisionSummary, inspectEvidenceV2 } = require('../backend/services/matchCore')

function completeCoverage() {
	const counts = {
		bank_loans: 0,
		non_bank_loans: 0,
		settled_loans: 0,
		historical_overdue_loans: 0,
		credit_card_details: 2,
		credit_card_details_cancelled: 0,
		query_details: 0,
		self_queries: 0,
		overdue_details: 0,
		public_records: 0,
		guarantee_records: 0,
		loan_history: 0
	}
	return Object.fromEntries(
		Object.entries(counts).map(([name, total]) => [name, { total, listed: total }])
	)
}

function zeroLimitFacts() {
	return {
		meta: { report_date: '2026-06-30' },
		basic_info: {},
		loan_details: {
			bank_loans: [],
			non_bank_loans: [],
			settled_loans: [],
			historical_overdue_loans: []
		},
		credit_card_details: [
			{
				institution: '甲银行',
				start_date: '2024-01-01',
				card_tail: '1111',
				currency: 'CNY',
				credit_limit: 0,
				used_limit: 150385,
				installment: 150385,
				status: '正常'
			},
			{
				institution: '乙银行',
				start_date: '2025-02-01',
				card_tail: '2222',
				currency: 'CNY',
				credit_limit: 23280,
				used_limit: 4717,
				status: '正常'
			}
		],
		credit_card_details_cancelled: [],
		query_analysis: { query_details: [], self_queries: [] },
		overdue_info: { has_overdue: false, total_overdue_accounts: 0, details: [] },
		public_records: { has_record: false, items: [] },
		guarantee_records: { total_amount: 0, items: [] },
		loan_history: { trend_data: [] },
		_coverage: { truncated: false, counts: completeCoverage() }
	}
}

function nativePdfEvidenceContext(lines) {
	let pageText = ''
	const structuredLines = lines.map((text, index) => {
		if (index > 0) pageText += '\n'
		const charStart = pageText.length
		pageText += text
		return {
			text,
			charStart,
			charEnd: pageText.length,
			bbox: [10, 10 + index * 20, 590, 25 + index * 20]
		}
	})
	return {
		version: 'pdf-structured-v1',
		sourceMode: 'pdf-text',
		expectedPageCount: 1,
		complete: true,
		pages: [{
			pageNumber: 1,
			bounds: [0, 0, 600, 800],
			text: pageText,
			blocks: structuredLines.map((line) => ({ ...line, lines: [line] }))
		}]
	}
}

test('zero-limit CNY balance is outstanding debt but never utilization numerator', () => {
	const cards = zeroLimitFacts().credit_card_details
	const result = summarizeCreditCardUtilization(cards, {
		trustExplicitSharedGroup: true,
		allowHeuristicSharedCredit: false
	})

	assert.equal(result.totalLimit, 23280)
	assert.equal(result.totalUsed, 4717)
	assert.equal(result.cardOutstanding, 155102)
	assert.equal(Math.round(result.usageRate * 10000), 2026)
	assert.equal(result.utilizationGroupCount, 1)
	assert.equal(result.outstandingGroupCount, 2)
})

test('evidence, canonical Web fields, debt and match summary keep outstanding separate', () => {
	const evidenceContext = nativePdfEvidenceContext([
		'个人信用报告 报告日期：2026年6月30日',
		'甲银行 2024年1月1日 尾号1111 人民币 授信额度：0.00元 已用额度：150,385.00元 未出单大额专项分期余额：150,385.00元',
		'乙银行 2025年2月1日 尾号2222 人民币 授信额度：23,280.00元 已用额度：4,717.00元'
	])
	const result = finalizeExtractedCreditFacts(
		zeroLimitFacts(),
		evidenceContext.pages[0].text,
		{
			evidenceRequired: true,
			inputKind: 'credit-report-pdf',
			documentId: `doc_v2_${'9'.repeat(64)}`,
			evidenceContext,
			sourceVerifiedCounts: {
				active_loans: { count: 0, basis: 'source-test-v1' },
				credit_card_details: { count: 2, basis: 'source-test-v1' },
				query_details: { count: 0, basis: 'source-test-v1' }
			}
		}
	)

	const cards = result.credit_debt.credit_cards
	assert.equal(cards.total_limit, 23280)
	assert.equal(cards.utilization_used, 4717)
	assert.equal(cards.total_used, 155102)
	assert.equal(cards.usage_rate, 0.2026)
	assert.equal(result.credit_debt.total_debt, 155102)
	assert.equal(result.deterministic_dimensions.usedCardLimit, 155102)
	assert.equal(result.deterministic_dimensions.cardUtilizationUsed, 4717)

	const metrics = result.evidence_v2.derivedAnalysis.metrics
	assert.equal(metrics.cardUtilization.numerator.minor, 471700)
	assert.equal(metrics.cardUtilization.denominator.minor, 2328000)
	assert.equal(metrics.cardUtilization.value.value, 2026)
	assert.equal(metrics.cardOutstanding.value.minor, 15510200)
	assert.equal(metrics.totalDebt.value.minor, 15510200)
	assert.equal(metrics.cardUtilization.exclusions.some((item) => item.reason === 'NO_POSITIVE_CNY_LIMIT'), true)
	// The installment is already part of the reported card balance and must not
	// be added a second time to card outstanding or total debt.
	assert.equal(result.credit_debt.total_debt, cards.total_used)

	const inspection = inspectEvidenceV2(result)
	assert.equal(inspection.verified, true)
	const decision = buildDecisionSummary(result, { evidenceTrusted: true })
	assert.equal(decision.evidenceVerified, true)
	assert.equal(decision.totalDebt, 155102)
	assert.equal(decision.cardTotalUsed, 155102)
	assert.equal(decision.cardUtilizationUsed, 4717)
	assert.equal(decision.cardTotalLimit, 23280)
	assert.equal(decision.cardUtilizationRate, 0.2026)
})

test('evidence-backed over-limit utilization remains above 100 percent', () => {
	const facts = zeroLimitFacts()
	facts.credit_card_details[0].used_limit = 0
	facts.credit_card_details[0].installment = 0
	facts.credit_card_details[1].credit_limit = 25200
	facts.credit_card_details[1].used_limit = 25988
	const evidenceContext = nativePdfEvidenceContext([
		'个人信用报告 报告日期：2026年6月30日',
		'甲银行 2024年1月1日 尾号1111 人民币 授信额度：0.00元 已用额度：0.00元 未出单大额专项分期余额：0.00元',
		'乙银行 2025年2月1日 尾号2222 人民币 授信额度：25,200.00元 已用额度：25,988.00元'
	])
	const result = finalizeExtractedCreditFacts(
		facts,
		evidenceContext.pages[0].text,
		{
			evidenceRequired: true,
			inputKind: 'credit-report-pdf',
			documentId: `doc_v2_${'8'.repeat(64)}`,
			evidenceContext,
			sourceVerifiedCounts: {
				active_loans: { count: 0, basis: 'source-test-v1' },
				credit_card_details: { count: 2, basis: 'source-test-v1' },
				query_details: { count: 0, basis: 'source-test-v1' }
			}
		}
	)

	assert.equal(result.credit_debt.credit_cards.usage_rate, 1.0313)
	const decision = buildDecisionSummary(result, { evidenceTrusted: true })
	assert.equal(decision.cardUtilizationRate, 1.0313)
	assert.equal(decision.cardUtilizationPct, 103.13)
})
