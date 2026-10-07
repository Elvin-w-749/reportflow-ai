'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { CreditRuleEngine, runCreditRuleEngine } = require('../creditRuleEngine')

function baseFixture(overrides = {}) {
	return {
		meta: { report_date: '2026-06-30' },
		basic_info: { name: '匿名测试用户' },
		credit_debt: {
			total_debt: 45138,
			debt_ratio: 4.5138,
			credit_loans: { total_balance: 45138 },
			credit_cards: { total_limit: 10000, total_used: 0, usage_rate: 0 },
			upcoming_6m: { total_balance: 180000, items: [] }
		},
		loan_details: { bank_loans: [], non_bank_loans: [], unknown_loans: [] },
		credit_card_details: [],
		query_analysis: { summary: {}, query_details: [] },
		overdue_info: { total_overdue_accounts: 0, details: [] },
		risk_analysis: { risk_hits: [] },
		assessment: {},
		...overrides
	}
}

test('debt ratio remains an unscaled archival ratio and cannot create formal risk hits', () => {
	const out = runCreditRuleEngine(baseFixture({
		derivation_meta: { mode: 'deterministic-v1' }
	}))
	const rules = out.risk_analysis.risk_hits.map((hit) => hit.rule_name)

	assert.equal(out.credit_debt.debt_ratio, 4.5138)
	assert.equal(rules.includes('DEBT_RATIO_HIGH'), false)
	assert.equal(rules.includes('DEBT_RATIO_CRITICAL'), false)
	assert.equal(rules.includes('MONTHLY_BURDEN'), false)
	assert.deepEqual(out.credit_debt.debt_ratio_policy, {
		metric: 'credit-line-utilization',
		formula: 'totalDebt/totalLine',
		unit: 'ratio',
		status: 'denominator-evidence-pending',
		decision_eligible: false,
		risk_rule_status: 'disabled'
	})
	assert.equal(out.frontend_payload.summary.debt_ratio, '待核对')
	assert.equal(out.frontend_payload.summary.credit_line_utilization.ratio, 4.5138)
	assert.equal(out.frontend_payload.summary.credit_line_utilization.decision_eligible, false)
	assert.equal(out.peer_comparison.some((row) => row.metric === '负债率'), false)
	assert.equal(out.peer_comparison_meta.decision_eligible, false)
	assert.equal(out.data_completeness.decision_eligible, false)
})

test('legacy ratio-derived hits are removed and monthly burden stays diagnostic-only', () => {
	const out = new CreditRuleEngine(baseFixture({
		risk_analysis: {
			risk_hits: [
				{ rule_name: 'DEBT_RATIO_HIGH', title: '旧负债率命中', severity: 4 },
				{ rule_name: 'MONTHLY_BURDEN', title: '旧月供压力命中', severity: 3 },
				{ rule_name: 'LEGACY_OTHER', title: '其他兼容提示', severity: 2 }
			]
		}
	})).runAll()
	const rules = out.risk_analysis.risk_hits.map((hit) => hit.rule_name)

	assert.deepEqual(rules, ['LEGACY_OTHER'])
	assert.equal(out.credit_debt.monthly_burden_diagnostic.monthly_due_average, 30000)
	assert.equal(out.credit_debt.monthly_burden_diagnostic.decision_eligible, false)
})

test('consistency correction cannot retroactively turn debt ratio into a risk input', () => {
	const fixture = baseFixture({
		derivation_meta: { mode: 'deterministic-v1' },
		credit_debt: {
			total_debt: 1000,
			debt_ratio: 0.1,
			credit_loans: { total_balance: 1000 },
			credit_cards: { total_limit: 10000, total_used: 0, usage_rate: 0 },
			upcoming_6m: { items: [] }
		},
		loan_details: {
			total: { credit_limit: 0, balance: 45138 },
			bank_loans: [{ institution: '匿名银行', balance: 45138, status: '正常', currency: 'CNY' }],
			non_bank_loans: [],
			unknown_loans: []
		}
	})
	const out = new CreditRuleEngine(fixture).runAll()
	const rules = out.risk_analysis.risk_hits.map((hit) => hit.rule_name)

	assert.equal(out.credit_debt.debt_ratio, 4.5138)
	assert.equal(rules.some((rule) => /^DEBT_RATIO_|^MONTHLY_BURDEN$/.test(rule)), false)
})
