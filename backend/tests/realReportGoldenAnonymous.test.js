'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
	createHmacHashFn,
	buildEvidenceFirstCreditAnalysis,
	assertPublicationGate
} = require('../backend/services/creditEvidenceLedger')

const HASH_FN = createHmacHashFn('anonymous-golden-evidence-secret-32-bytes')
const sourceCount = (count) => ({ count, basis: 'source-test-fixture-v1' })

const bankLoans = [151233, 50000].map((balance, index) => ({
	institution: `匿名银行${index + 1}`,
	institution_type: 'bank',
	account_id: `bank-loan-${index + 1}`,
	currency: 'CNY',
	status: '正常',
	balance
}))

const nonBankLoans = [130541, 0, 0, 20621, 85292, 13270].map((balance, index) => ({
	institution: `匿名消费金融${index + 1}`,
	institution_type: 'non_bank',
	account_id: `nonbank-loan-${index + 1}`,
	currency: 'CNY',
	status: '正常',
	balance
}))

const cards = [
	{ institution: '匿名发卡行1', account_id: 'card-1', card_tail: '1001', currency: 'CNY', credit_limit: 30000, used_limit: 28224 },
	{ institution: '匿名发卡行2', account_id: 'card-2', card_tail: '1002', currency: 'CNY', credit_limit: 10000, used_limit: 9644 },
	{ institution: '匿名发卡行2', account_id: 'card-3', card_tail: '1003', currency: 'USD', credit_limit: 10000, used_limit: 0 }
].map((card, index) => ({
	...card,
	start_date: `202${index + 1}-01-01`,
	status: '正常'
}))

const queryDates = [
	'2026-03-01',
	'2026-02-01',
	'2025-12-24',
	'2025-11-20',
	'2025-10-20',
	'2025-09-23',
	'2025-09-22',
	'2025-09-21',
	'2025-09-19',
	'2025-09-15',
	'2025-09-10',
	'2025-09-05',
	'2025-08-28',
	'2025-08-20',
	'2025-08-15',
	'2025-08-01',
	'2025-07-20',
	'2025-07-05',
	'2025-06-25',
	'2025-06-10',
	'2025-05-28',
	'2025-05-15',
	'2025-05-01',
	'2025-04-25',
	'2025-04-15',
	'2025-04-05',
	'2025-03-30',
	'2025-03-23'
]

const queries = queryDates.map((date, index) => ({
	date,
	institution: index < 4 || (index >= 6 && index < 19) ? `匿名银行查询${index + 1}` : `匿名非银查询${index + 1}`,
	institution_type: index < 4 || (index >= 6 && index < 19) ? 'bank' : 'non_bank',
	reason: '贷款审批'
}))

const facts = {
	meta: { report_date: '2026-03-23' },
	loan_details: {
		bank_loans: bankLoans,
		non_bank_loans: nonBankLoans,
		unknown_loans: []
	},
	credit_card_details: cards,
	overdue_info: { total_overdue_accounts: 0, details: [] },
	query_analysis: { query_details: queries },
	primary_rule_score: { score: 40, deductions: [] }
}

const sourceText = [
	'【第1页】个人信用报告 报告日期：2026年3月23日 当前未逾期。',
	...bankLoans.map((row) => `${row.institution} ${row.account_id} 人民币 贷款余额：${row.balance}元 状态：正常`),
	...nonBankLoans.map((row) => `${row.institution} ${row.account_id} 人民币 贷款余额：${row.balance}元 状态：正常`),
	...cards.map((row) => `${row.institution} ${row.start_date} 尾号${row.card_tail} ${row.currency === 'USD' ? '美元' : '人民币'} 授信额度：${row.credit_limit}元 已用额度：${row.used_limit}元 状态：正常`),
	...queries.map((row) => `${row.institution} ${row.date} ${row.reason}`)
].join('\n')

const build = () => buildEvidenceFirstCreditAnalysis({
	sourceText,
	evidenceContext: {
		facts,
		sourceVerifiedCounts: {
			active_loans: sourceCount(8),
			credit_card_details: sourceCount(3),
			query_details: sourceCount(28)
		}
	},
	hashFn: HASH_FN,
	requirePublishable: true
})

test('anonymous official-report golden facts stay exact and stable across five fresh runs', () => {
	const results = Array.from({ length: 5 }, build)
	for (const result of results) {
		const metrics = result.derivedAnalysis.metrics
		assert.equal(result.status, 'publishable')
		assert.equal(metrics.totalLoanBalance.value.minor, 45095700)
		assert.equal(metrics.cardUtilization.numerator.minor, 3786800)
		assert.equal(metrics.cardUtilization.denominator.minor, 4000000)
		assert.equal(metrics.cardUtilization.value.value, 9467)
		assert.equal(metrics.totalDebt.value.minor, 48882500)
		const loanEntities = result.factLedger.entities.filter((entity) => entity.kind === 'loan')
		assert.equal(loanEntities.filter((entity) => entity.subtype === 'bank_loan').length, 2)
		assert.equal(loanEntities.filter((entity) => entity.subtype === 'non_bank_loan').length, 6)
		assert.equal(facts.overdue_info.total_overdue_accounts, 0)
		assert.equal(result.factLedger.facts.some((fact) => (
			fact.status === 'accepted' && fact.field === 'overdue_days' && Number(fact.value && fact.value.value) > 0
		)), false)
		assert.deepEqual(metrics.queryCounts.value, {
			type: 'query-window-counts',
			last_1m: 1,
			last_3m: 3,
			last_6m: 6,
			last_12m: 28,
			by_window: {
				last_1m: { total: 1, bank: 1, non_bank: 0, unknown: 0 },
				last_3m: { total: 3, bank: 3, non_bank: 0, unknown: 0 },
				last_6m: { total: 6, bank: 4, non_bank: 2, unknown: 0 },
				last_12m: { total: 28, bank: 17, non_bank: 11, unknown: 0 }
			}
		})
		assert.equal(metrics.primaryScore.inputMetrics.nonBankLoanCount, 6)
		assert.equal(metrics.primaryScore.value.value, 40)
		assert.equal(metrics.cardUtilization.facilityTrace.length, 2)
		assert.equal(metrics.cardUtilization.facilityTrace.every((facility) => (
			facility.policy === 'single-account-v1' && facility.inputRelationIds.length === 0
		)), true)
		assert.equal(assertPublicationGate(result, { hashFn: HASH_FN }), true)
	}

	const hashSets = results.map((result) => [
		result.manifest.manifestHash,
		result.evidenceGraph.evidenceGraphHash,
		result.factLedger.factLedgerHash,
		result.derivedAnalysis.derivedAnalysisHash
	])
	assert.equal(new Set(hashSets.map(JSON.stringify)).size, 1)
})
