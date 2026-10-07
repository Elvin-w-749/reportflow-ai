import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { mapServerAnalyzeDataToClientAnalysis } from '../src/services/serverAnalyzeMapper.js'
import {
	AUTHORITATIVE_EVIDENCE_PATHS,
	markServerAnalysisResponse
} from '../src/services/authoritativeAnalysis.js'
import { resolveV6ScoreDetails } from '../src/services/scoreV6.js'
import { hasMeaningfulAnalysisData } from '../src/services/analysisValidity.js'

const ANALYSIS_KEY = `ak_v3_${'a'.repeat(64)}`
const RESULT_HASH = `rh_v1_${'b'.repeat(64)}`
const MANIFEST_HASH = `mh_v2_${'1'.repeat(64)}`
const EVIDENCE_HASH = `eg_v2_${'2'.repeat(64)}`
const FACT_HASH = `fl_v2_${'3'.repeat(64)}`
const METRIC_HASH = `da_v2_${'4'.repeat(64)}`

const trustedCanonical = (value) => markServerAnalysisResponse({
	...value,
	derivation_meta: {
		...(value.derivation_meta || {}),
		evidence_mode: 'evidence-v2',
		evidence_hash: EVIDENCE_HASH,
		fact_hash: FACT_HASH,
		metric_hash: METRIC_HASH
	},
	analysis_meta: {
		...(value.analysis_meta || {}),
		analysisKey: ANALYSIS_KEY,
		resultHash: RESULT_HASH,
		authoritative: true,
		authority: 'server-deterministic',
		authoritativeScope: [...AUTHORITATIVE_EVIDENCE_PATHS],
		cachePolicy: { persistent: true, stableAcrossRestart: true }
	},
	evidence_meta: {
		version: 'evidence-v2',
		status: 'publishable',
		publication_gate: 'passed',
		manifest_hash: MANIFEST_HASH,
		evidence_hash: EVIDENCE_HASH,
		fact_hash: FACT_HASH,
		metric_hash: METRIC_HASH,
		fact_count: 1,
		supported_fact_count: 1,
		authoritative_scope: [...AUTHORITATIVE_EVIDENCE_PATHS]
	}
})

describe('server analyze mapper', () => {
	it('does not turn an empty server response into a trusted zero score', () => {
		const out = mapServerAnalyzeDataToClientAnalysis({})
		const resolved = resolveV6ScoreDetails(out)
		assert.equal(out.report.totalScore, null)
		assert.equal(out.report.riskLevel, 'unknown')
		assert.equal(resolved.score, null)
		assert.equal(resolved.source, 'unavailable')
		assert.equal(hasMeaningfulAnalysisData(out), false)
	})

	it('preserves an explicit evidence-backed zero score', () => {
		const out = mapServerAnalyzeDataToClientAnalysis({
			primary_rule_score: { score: 0, baseScore: 100, totalDeduction: 100 },
			risk_level: 'high'
		})
		const resolved = resolveV6ScoreDetails(out)
		assert.equal(out.report.totalScore, 0)
		assert.equal(out.report.riskLevel, 'high')
		assert.equal(resolved.score, 0)
		assert.equal(resolved.source, 'primary-rule-stored')
	})

	it('normalizes report ownership aliases from trusted basic-info paths', () => {
		const fromReport = mapServerAnalyzeDataToClientAnalysis({
			report: { totalScore: 72 },
			dimensions: { totalAccountCount: 1 },
			basic_info: { real_name: '测试甲', id_last4: '2718' }
		})

		assert.equal(fromReport.basicInfo.name, '测试甲')
		assert.equal(fromReport.basicInfo.idLast4, '2718')
		assert.equal(fromReport.basicInfo.id_last4, '2718')

		const fromNestedReport = mapServerAnalyzeDataToClientAnalysis({
			report: {
				totalScore: 72,
				basic_info: { '姓名': '测试乙', id_card: '000000000000002718' }
			},
			dimensions: { totalAccountCount: 1 }
		})

		assert.equal(fromNestedReport.basicInfo.name, '测试乙')
		assert.equal(fromNestedReport.basicInfo.idCard, '000000000000002718')
		assert.equal(fromNestedReport.basicInfo.idLast4, '2718')
	})

	it('normalizes customer-name and identity aliases in V2 basic info', () => {
		const out = mapServerAnalyzeDataToClientAnalysis({
			basic_info: { customer_name: '测试丙', id_no: '000000000000003141' },
			credit_debt: {
				total_debt: 100,
				credit_loans: {},
				credit_cards: { total_limit: 1000, total_used: 100, card_count: 1 }
			},
			credit_card_details: [{ institution: '测试机构', credit_limit: 1000, used_limit: 100 }],
			loan_details: { bank_loans: [], non_bank_loans: [] },
			query_analysis: { summary: {} }
		})

		assert.equal(out.basicInfo.name, '测试丙')
		assert.equal(out.basicInfo.idCard, '000000000000003141')
		assert.equal(out.basicInfo.idLast4, '3141')
	})

	it('reads ownership evidence from the trusted V2 frontend header', () => {
		const out = mapServerAnalyzeDataToClientAnalysis({
			frontend_payload: {
				header: { real_name: '测试丁', id_last4: '1618' }
			},
			credit_debt: {
				credit_loans: {},
				credit_cards: { total_limit: 1000, total_used: 0, card_count: 1 }
			},
			credit_card_details: [{ institution: '测试机构', credit_limit: 1000, used_limit: 0 }],
			loan_details: { bank_loans: [], non_bank_loans: [] },
			query_analysis: { summary: {} }
		})

		assert.equal(out.basicInfo.name, '测试丁')
		assert.equal(out.basicInfo.idLast4, '1618')
	})

	it('preserves LLM overdue and non-bank loan signals for client readback', () => {
		const out = mapServerAnalyzeDataToClientAnalysis({
			debt_summary: { total_debt: 100000, total_credit_line: 200000 },
			overdue_summary: { current_overdue_count: 0, total_overdue_count: 0 },
			credit_cards: { count: 1, overdue_count: 1 },
			loan_accounts: { count: 6, total_balance: 80000, non_bank_count: 6 },
			hidden_debt_analysis: { consumer_finance_count: 6 },
			account_overview: { total_count: 7, active_count: 7 },
			query_records: {},
			public_records: { has_record: false }
		})

		assert.equal(out.dimensions.overdueCount, 1)
		assert.equal(out.dimensions.hasOverdue, true)
		assert.equal(out.dimensions.nonBankLoanCount, 6)
		assert.equal(out.report.dimensionSnapshot.nonBankLoanCount, 6)
	})

	it('does not expose out-of-range raw LLM assessment scores as display score', () => {
		const out = mapServerAnalyzeDataToClientAnalysis({
			basic_info: { name: '张*', id_last4: '1246' },
			assessment: { score: 580, risk_level: 'medium' },
			credit_debt: {
				total_debt: 120000,
				credit_loans: { total_count: 2, non_bank_count: 1, bank_count: 1 },
				credit_cards: { total_limit: 100000, total_used: 30000, card_count: 2 }
			},
			overdue_info: { has_overdue: false, total_overdue_accounts: 0 },
			query_analysis: { summary: { last_1m: { total: 0 }, last_3m: { total: 1 }, last_6m: { total: 2 }, last_12m: { total: 3 } } }
		})

		assert.ok(out.report.totalScore >= 0)
		assert.ok(out.report.totalScore <= 100)
	})

	it('recalculates V2 aggregate debt from recognized details instead of trusting inconsistent LLM totals', () => {
		const out = mapServerAnalyzeDataToClientAnalysis({
			basic_info: { name: '徐*', id_last4: '1246' },
			credit_debt: {
				total_debt: 1000,
				debt_ratio: 0.01,
				credit_loans: { total_amount: 1 },
				credit_cards: { total_limit: 50000, total_used: 30000, usage_rate: 0.01, card_count: 1 }
			},
			loan_details: {
				bank_loans: [{ institution: '中国银行', credit_limit: 100000, balance: 40000 }],
				non_bank_loans: [{ institution: '兴业消费金融', credit_limit: 30000, balance: 20000 }]
			},
			credit_card_details: [
				{ institution: '招商银行', currency: 'CNY', credit_limit: 50000, used_limit: 30000, status: '正常' },
				{ institution: '浦发银行', credit_limit: 90000, used_limit: 90000, status: '销户' }
			],
			overdue_info: { has_overdue: false, total_overdue_accounts: 0 },
			query_analysis: { summary: {} }
		})

		assert.equal(out.dimensions.totalLoanBalance, 60000)
		assert.equal(out.dimensions.usedCardLimit, 30000)
		assert.equal(out.dimensions.totalDebt, 90000)
		assert.equal(out.dimensions.creditCardCount, 1)
		assert.equal(out.dimensions.cardUtilizationRate, 0.6)
	})

	it('recalculates legacy V2 utilization only when the report explicitly marks a shared card group', () => {
		const out = mapServerAnalyzeDataToClientAnalysis({
			credit_debt: {
				total_debt: 44975,
				credit_loans: {},
				credit_cards: { total_limit: 141306, total_used: 44975, usage_rate: 0.3183, card_count: 3 }
			},
			credit_card_details: [
				{ institution: '测试银行', start_date: '2020-01-01', type: '贷记卡（人民币账户，尾号8744）', shared_credit_group: 'facility-8744', utilization_included: true, credit_limit: 48000, used_limit: 44975, status: '正常' },
				{ institution: '测试银行', start_date: '2020-01-01', type: '贷记卡（美元账户，尾号8744）', shared_credit_group: 'facility-8744', utilization_included: false, credit_limit: 58993, used_limit: 0, status: '正常' },
				{ institution: '测试银行', start_date: '2020-01-01', type: '贷记卡（日元账户，尾号8744）', shared_credit_group: 'facility-8744', utilization_included: false, credit_limit: 34313, used_limit: 0, status: '正常' }
			],
			loan_details: { bank_loans: [], non_bank_loans: [] },
			query_analysis: { summary: {} }
		})

		assert.equal(out.dimensions.totalCreditLine, 48000)
		assert.equal(out.dimensions.usedCardLimit, 44975)
		assert.equal(Math.round(out.dimensions.cardUtilizationRate * 100), 94)
		assert.equal(out.dimensions.cardUtilizationStatus, 'computed')
		assert.equal(out.dimensions.cardUtilizationDecisionEligible, true)
		assert.equal(out.dimensions.cardSharedGroupCount, 1)
		assert.equal(out.dimensions.cardForeignCurrencyAccountCount, 2)
	})

	it('keeps heuristic multi-currency rows archival and marks utilization unknown', () => {
		const out = mapServerAnalyzeDataToClientAnalysis({
			credit_debt: {
				total_debt: 44975,
				credit_loans: {},
				credit_cards: { total_limit: 141306, total_used: 44975, usage_rate: 0.3183, card_count: 3 }
			},
			credit_card_details: [
				{ institution: '测试银行', start_date: '2020-01-01', type: '贷记卡（人民币账户，尾号8744）', credit_limit: 48000, used_limit: 44975, status: '正常' },
				{ institution: '测试银行', start_date: '2020-01-01', type: '贷记卡（美元账户，尾号8744）', credit_limit: 58993, used_limit: 0, status: '正常' },
				{ institution: '测试银行', start_date: '2020-01-01', type: '贷记卡（日元账户，尾号8744）', credit_limit: 34313, used_limit: 0, status: '正常' }
			],
			loan_details: { bank_loans: [], non_bank_loans: [] },
			query_analysis: { summary: {} }
		})

		assert.equal(out.dimensions.totalCreditLine, 141306)
		assert.equal(out.dimensions.usedCardLimit, 44975)
		assert.equal(out.dimensions.cardUtilizationRate, null)
		assert.equal(out.dimensions.cardUtilizationStatus, 'unknown')
		assert.equal(out.dimensions.cardUtilizationDecisionEligible, false)
		assert.equal(out.dimensions.cardSharedGroupCount, 0)
		assert.equal(out.dimensions.cardUnknownUtilizationAccountCount, 2)
	})

	it('keeps deterministic-v1 server summaries authoritative over conflicting details', () => {
		const canonical = trustedCanonical({
			derivation_meta: {
				mode: 'deterministic-v1',
				anchor_date: '2025-06-30',
				model_role: 'raw-facts-only'
			},
			analysis_meta: {
				analysisKey: 'report-key',
				resultHash: 'result-hash',
				authoritative: true,
				authority: 'server-deterministic',
				authoritativeScope: [...AUTHORITATIVE_EVIDENCE_PATHS],
				cachePolicy: {
					persistent: true,
					stableAcrossRestart: true
				}
			},
			deterministic_dimensions: {
				totalCreditLine: 320000,
				usedCardLimit: 50000,
				totalLoanBalance: 30000,
				totalDebt: 80000,
				debtRatio: 0.61,
				cardUtilizationRate: 0.25,
				creditCardCount: 4,
				loanCount: 2,
				nonBankLoanCount: 1,
				overdueCount: 0,
				m1Count: 0,
				m2Count: 0,
				m3Count: 0,
				q1: 2,
				q3: 4,
				q6: 6,
				q12: 8,
				loanQueryCount: 1,
				cardQueryCount: 1
			},
			basic_info: { name: '确定性样本', id_last4: '2468', report_date: '2025-06-29' },
			credit_debt: {
				total_debt: 80000,
				debt_ratio: 0.61,
				credit_loans: {
					total_amount: 30000,
					total_balance: 30000,
					total_count: 2,
					non_bank_count: 1
				},
				credit_cards: {
					total_limit: 200000,
					total_used: 50000,
					utilization_used: 50000,
					usage_rate: 0.25,
					shared_group_count: 0,
					card_count: 4
				}
			},
			loan_details: {
				total: { credit_limit: 120000, balance: 30000 },
				bank_loans: [{ institution: '明细银行', credit_limit: 5000, balance: 5000 }],
				non_bank_loans: []
			},
			credit_card_details: [
				{ institution: '明细银行', credit_limit: 10000, used_limit: 9000, status: '正常' }
			],
			query_analysis: {
				summary: {
					last_1m: { total: 2, loan_approval: 1, credit_card_approval: 1 },
					last_3m: { total: 4 },
					last_6m: { total: 6 },
					last_12m: { total: 8 }
				},
				query_details: [
					{ date: '2026-07-28', institution: '明细银行', reason: '贷款审批' }
				]
			},
			overdue_info: {
				total_overdue_accounts: 0,
				total_overdue_amount: 0,
				max_overdue_days: 0,
				m1_count: 0,
				m2_count: 0,
				m3_count: 0,
				details: [{ institution: '冲突明细', overdue_days: 90, overdue_amount: 9999 }]
			},
			primary_rule_score: { score: 77 },
			six_dimensions: {
				credit_history: 81,
				query_frequency: 73,
				account_structure: 69,
				repayment_record: 88
			},
			risk_analysis: { overall_level: '中风险', risk_hits: [] }
		})
		const out = mapServerAnalyzeDataToClientAnalysis({
			data: { result: { credit_report_full: canonical } }
		})

		assert.equal(out.dimensions.totalCreditLine, null)
		assert.equal(out.dimensions.totalLoanBalance, 30000)
		assert.equal(out.dimensions.usedCardLimit, 50000)
		assert.equal(out.dimensions.totalDebt, 80000)
		assert.equal(out.dimensions.debtRatio, 0.61)
		assert.equal(out.dimensions.cardUtilizationRate, 0.25)
		assert.equal(out.dimensions.creditCardCount, null)
		assert.equal(out.dimensions.loanCount, null)
		assert.equal(out.dimensions.overdueCount, null)
		assert.equal(out.dimensions.maxOverdueDays, null)
		assert.equal(out.dimensions.q1, 2)
		assert.equal(out.dimensions.q3, 4)
		assert.equal(out.dimensions.q6, 6)
		assert.equal(out.dimensions.q12, 8)
		assert.equal(out.dimensions.loanQueryCount, null)
		assert.equal(out.dimensions.cardQueryCount, null)
		assert.equal(out.basicInfo.reportDate, '2025-06-30')
		assert.equal(out.report.totalScore, 77)
		assert.equal(out.report.riskLevel, 'unknown')
		assert.equal(out.report.summary, '综合评分 77 分；整体风险等级待核对。')
		assert.equal(out.authoritativeAnalysis, false)
		assert.equal(out.analysisAuthority.authoritative, true)
		assert.deepEqual(out.authoritativeScope, AUTHORITATIVE_EVIDENCE_PATHS)
		assert.equal(out.analysisAuthority.mode, 'deterministic-v1')
		assert.equal(out.analysisAuthority.analysisKey, ANALYSIS_KEY)
		assert.equal(out.analysisAuthority.resultHash, RESULT_HASH)
		assert.equal(out.analysisPipelineVersion, 'server-deterministic-v1')
		const resolvedScore = resolveV6ScoreDetails(out)
		assert.equal(resolvedScore.score, 77)
		assert.equal(resolvedScore.source, 'authoritative-primary-rule')
	})

	it('maps a field-scoped envelope without requiring non-scope ratio or display dimensions', () => {
		const out = mapServerAnalyzeDataToClientAnalysis(trustedCanonical({
			derivation_meta: { mode: 'deterministic-v1', anchor_date: '2026-06-30' },
			analysis_meta: {
				analysisKey: 'scope-only-key',
				resultHash: 'scope-only-hash',
				authoritative: true,
				authority: 'server-deterministic',
				authoritativeScope: [...AUTHORITATIVE_EVIDENCE_PATHS],
				cachePolicy: { persistent: true, stableAcrossRestart: true }
			},
			credit_debt: {
				total_debt: 50000,
				credit_loans: { total_balance: 30000 },
				credit_cards: {
					total_limit: 100000,
					total_used: 20000,
					utilization_used: 20000,
					usage_rate: 0.2,
					shared_group_count: 0
				}
			},
			loan_details: { bank_loans: [], non_bank_loans: [] },
			query_analysis: {
				summary: {
					last_1m: { total: 1 },
					last_3m: { total: 2 },
					last_6m: { total: 3 },
					last_12m: { total: 4 }
				}
			},
			primary_rule_score: { score: 88 }
		}))

		assert.equal(out.analysisAuthority.authoritative, true)
		assert.equal(out.analysisAuthority.contractComplete, false)
		assert.equal(out.report.totalScore, 88)
		assert.equal(out.report.riskLevel, 'unknown')
		assert.equal(out.report.summary, '综合评分 88 分；整体风险等级待核对。')
		assert.equal(out.dimensions.debtRatio, null)
		assert.equal(out.dimensions.overdueCount, null)
		assert.equal(out.dimensions.totalAccountCount, null)
		assert.equal(out.dimensions.hasOverdue, null)
		assert.equal(out.report.dimensionSnapshot.debtRatioPct, null)
		assert.equal(out.report.dimensionSnapshot.debtRatioDecisionEligible, false)
		assert.equal(out.report.dimensionSnapshot.debtRatioStatus, 'denominator-evidence-pending')
	})

	it('binds authority and mapped values to one root instead of wrapper merge order', () => {
		const trusted = trustedCanonical({
			derivation_meta: { mode: 'deterministic-v1', anchor_date: '2026-06-30' },
			credit_debt: {
				total_debt: 50000,
				credit_loans: { total_balance: 30000 },
				credit_cards: {
					total_limit: 100000,
					total_used: 20000,
					utilization_used: 20000,
					usage_rate: 0.2,
					shared_group_count: 0
				}
			},
			loan_details: { bank_loans: [], non_bank_loans: [] },
			query_analysis: {
				summary: {
					last_1m: { total: 1 },
					last_3m: { total: 2 },
					last_6m: { total: 3 },
					last_12m: { total: 4 }
				}
			},
			primary_rule_score: { score: 88 }
		})
		const poisoned = JSON.parse(JSON.stringify(trusted))
		poisoned.credit_debt.total_debt = -999
		poisoned.credit_debt.credit_loans.total_balance = -888
		poisoned.credit_debt.credit_cards.usage_rate = -4
		poisoned.query_analysis.summary.last_1m.total = 9
		poisoned.query_analysis.summary.last_3m.total = 1
		poisoned.primary_rule_score.score = 999
		trusted.data = poisoned
		markServerAnalysisResponse(trusted)

		const out = mapServerAnalyzeDataToClientAnalysis(trusted)
		assert.equal(out.analysisAuthority.authoritative, true)
		assert.equal(out.dimensions.totalDebt, 50000)
		assert.equal(out.dimensions.totalLoanBalance, 30000)
		assert.equal(out.dimensions.cardUtilizationRate, 0.2)
		assert.equal(out.dimensions.q1, 1)
		assert.equal(out.dimensions.q3, 2)
		assert.equal(out.report.totalScore, 88)
	})

	it('keeps legacy ratio units and camelCase debt-risk hits out of report conclusions', () => {
		const out = mapServerAnalyzeDataToClientAnalysis({
			credit_debt: {
				total_debt: 65000,
				debt_ratio: 65,
				credit_loans: { total_balance: 65000 },
				credit_cards: { total_limit: 100000, total_used: 0, usage_rate: 0 }
			},
			loan_details: { bank_loans: [], non_bank_loans: [] },
			query_analysis: { summary: {} },
			primary_rule_score: { score: 90 },
			risk_analysis: {
				overall_level: '高风险',
				risk_hits: [{ ruleName: 'DEBT_RATIO_CRITICAL', title: '旧负债率命中' }]
			}
		})

		assert.equal(out.dimensions.debtRatio, null)
		assert.equal(out.report.dimensionSnapshot.debtRatioPct, null)
		assert.equal(out.report.riskLevel, 'unknown')
		assert.doesNotMatch(out.report.summary, /high|高风险|6500/)
	})

	it('preserves an authoritative over-limit card utilization ratio above one', () => {
		const out = mapServerAnalyzeDataToClientAnalysis(trustedCanonical({
			derivation_meta: { mode: 'deterministic-v1', anchor_date: '2026-07-27' },
			analysis_meta: {
				analysisKey: 'over-limit-key',
				resultHash: 'over-limit-hash',
				authoritative: true,
				authority: 'server-deterministic',
				authoritativeScope: [...AUTHORITATIVE_EVIDENCE_PATHS],
				cachePolicy: { persistent: true, stableAcrossRestart: true }
			},
			deterministic_dimensions: {
				totalDebt: 25988,
				cardUtilizationRate: 1.0313
			},
			credit_debt: {
				total_debt: 25988,
				debt_ratio: 4.5138,
				credit_loans: { total_balance: 0, total_count: 0 },
				credit_cards: {
					total_limit: 25200,
					total_used: 25988,
					utilization_used: 25988,
					usage_rate: 1.0313,
					shared_group_count: 0,
					card_count: 1
				}
			},
			loan_details: { bank_loans: [], non_bank_loans: [] },
			credit_card_details: [],
			query_analysis: {
				summary: {
					last_1m: { total: 0 },
					last_3m: { total: 0 },
					last_6m: { total: 0 },
					last_12m: { total: 0 }
				}
			},
			primary_rule_score: { score: 40 },
			six_dimensions: {
				credit_history: 50,
				query_frequency: 50,
				account_structure: 50,
				repayment_record: 50
			},
			risk_analysis: {
				overall_level: '低风险',
				risk_hits: [
					{ rule_name: 'DEBT_RATIO_CRITICAL', title: '旧负债率命中', severity: 5 }
				]
			}
		}))

		assert.equal(out.authoritativeAnalysis, false)
		assert.equal(out.analysisAuthority.authoritative, true)
		assert.equal(out.dimensions.cardUtilizationRate, 1.0313)
		assert.equal(out.dimensions.debtRatio, 4.5138)
		assert.equal(out.report.dimensionSnapshot.debtRatioPct, 451.38)
		assert.notEqual(out.report.dimensionSnapshot.debtRatioPct, 5)
		assert.equal(out.dimensions.debtRatioDecisionEligible, false)
		assert.equal(out.dimensions.debtRatioExceeds70, false)
		assert.equal(out.report.riskLevel, 'unknown')
		assert.equal(out.report.riskTags.includes('旧负债率命中'), false)
	})

	it('anchors legacy V2 query compatibility calculations to the report date', () => {
		const out = mapServerAnalyzeDataToClientAnalysis({
			basic_info: { name: '历史样本', report_date: '2025-06-30' },
			credit_debt: {
				total_debt: 1000,
				debt_ratio: 0.1,
				credit_loans: {},
				credit_cards: { total_limit: 10000, total_used: 1000, usage_rate: 0.1, card_count: 1 }
			},
			query_analysis: {
				summary: {
					last_1m: { total: 0 },
					last_3m: { total: 0 },
					last_6m: { total: 0 },
					last_12m: { total: 0 }
				},
				query_details: [
					{ date: '2025-06-20', institution: '中国银行', reason: '贷款审批' },
					{ date: '2025-05-15', institution: '招商银行', reason: '信用卡审批' },
					{ date: '2025-02-01', institution: '工商银行', reason: '贷款审批' },
					{ date: '2024-10-01', institution: '建设银行', reason: '贷记卡审批' },
					{ date: '2024-01-01', institution: '农业银行', reason: '贷款审批' }
				]
			},
			loan_details: { bank_loans: [], non_bank_loans: [] },
			credit_card_details: []
		})

		assert.equal(out.dimensions.q1, 1)
		assert.equal(out.dimensions.q3, 2)
		assert.equal(out.dimensions.q6, 3)
		assert.equal(out.dimensions.q12, 4)
		assert.equal(out.dimensions.loanQueryCount, 1)
		assert.equal(out.dimensions.cardQueryCount, 0)
		assert.equal(out.authoritativeAnalysis, false)
		assert.equal(out.analysisAuthority.compatibility, true)
		assert.equal(out.analysisAuthority.mode, 'legacy-compatible')
		assert.equal(out.analysisPipelineVersion, 'server-credit-v2-legacy-compatible')
	})

	it('uses inclusive calendar-month query boundaries in legacy V2 compatibility mode', () => {
		const out = mapServerAnalyzeDataToClientAnalysis({
			basic_info: { report_date: '2026-06-30' },
			credit_debt: {
				total_debt: 0,
				credit_loans: {},
				credit_cards: { total_limit: 0, total_used: 0, card_count: 0 }
			},
			loan_details: { bank_loans: [], non_bank_loans: [] },
			credit_card_details: [],
			query_analysis: {
				summary: {},
				query_details: [
					{ query_date: '2026-05-30', query_org: '甲银行', query_reason: '贷款审批' },
					{ date: '2026-05-29', institution: '乙银行', reason: '贷款审批' },
					{ date: '2026-06-30', institution: '丙银行', reason: '信用卡审批' },
					{ date: '2026-07-01', institution: '未来银行', reason: '贷款审批' },
					{ date: '2026-06-20', institution: '甲银行', reason: '异议处理' }
				]
			}
		})

		assert.equal(out.dimensions.q1, 2)
		assert.equal(out.dimensions.loanQueryCount, 1)
		assert.equal(out.dimensions.cardQueryCount, 1)
		assert.deepEqual(out.queryRecords.windowSummaries.last_1m, {
			total: 2,
			bank: 2,
			nonBank: 0,
			non_bank: 0,
			unknown: 0,
			breakdownAvailable: true,
			classificationComplete: true
		})
	})

	it('preserves canonical institution kinds and negated overdue semantics in mapped V2 accounts', () => {
		const out = mapServerAnalyzeDataToClientAnalysis({
			basic_info: { report_date: '2026-06-30' },
			credit_debt: {
				total_debt: 300,
				credit_loans: { total_balance: 200, total_count: 2 },
				credit_cards: { total_limit: 1000, total_used: 100, card_count: 2 }
			},
			loan_details: {
				bank_loans: [{ institution: '名称为消费金融', institution_type: 'bank', status: '未逾期', balance: 100 }],
				non_bank_loans: [{ institution: '名称含银行', institutionKind: 'nonbank', status: '无逾期', overdue_days: 5, balance: 100 }]
			},
			credit_card_details: [
				{ institution: '某数据服务公司', status: '从未逾期', credit_limit: 500, used_limit: 50 },
				{ institution: '另一机构', status: '从未逾期', is_overdue: true, credit_limit: 500, used_limit: 50 }
			],
			overdue_info: { total_overdue_accounts: 1, details: [] },
			query_analysis: { summary: {} }
		})

		assert.deepEqual(out.accounts.map((account) => account.institutionKind), ['bank', 'non_bank', 'unknown', 'unknown'])
		assert.deepEqual(out.accounts.map((account) => account.institution_type), ['bank', 'non_bank', 'unknown', 'unknown'])
		assert.deepEqual(out.accounts.map((account) => account.isOverdue), [false, true, false, true])
	})

	it('keeps missing query institution breakdown unknown instead of publishing false zeros', () => {
		const out = mapServerAnalyzeDataToClientAnalysis({
			basic_info: { report_date: '2026-06-30' },
			credit_debt: {
				total_debt: 0,
				credit_loans: {},
				credit_cards: { total_limit: 0, total_used: 0, card_count: 0 }
			},
			loan_details: { bank_loans: [], non_bank_loans: [] },
			credit_card_details: [],
			query_analysis: {
				summary: {
					last_1m: { total: 2 },
					last_3m: { total: 2 },
					last_6m: { total: 2, bank: 1, non_bank: 1 },
					last_12m: { total: 2 }
				},
				query_details: []
			}
		})

		assert.deepEqual(out.queryRecords.windowSummaries.last_1m, {
			total: 2,
			bank: null,
			nonBank: null,
			non_bank: null,
			unknown: 2,
			breakdownAvailable: false,
			classificationComplete: false
		})
		assert.deepEqual(out.queryRecords.windowSummaries.last_6m, {
			total: 2,
			bank: 1,
			nonBank: 1,
			non_bank: 1,
			unknown: 0,
			breakdownAvailable: true,
			classificationComplete: true
		})
	})

	it('does not let non-scoped deterministic aliases override authoritative evidence fields', () => {
		const out = mapServerAnalyzeDataToClientAnalysis(trustedCanonical({
			derivation_meta: { mode: 'deterministic-v1', anchor_date: '2025-06-30' },
			analysis_meta: {
				analysisKey: 'optional-dimensions-key',
				resultHash: 'optional-dimensions-hash',
				authoritative: true,
				authority: 'server-deterministic',
				authoritativeScope: [...AUTHORITATIVE_EVIDENCE_PATHS],
				cachePolicy: {
					persistent: true,
					stableAcrossRestart: true
				}
			},
			deterministic_dimensions: {
				total_debt: 81000,
				card_utilization_rate: 0.27,
				query_1m: 9,
				has_overdue: false
			},
			basic_info: { report_date: '2025-06-30' },
			credit_debt: {
				total_debt: 80000,
				debt_ratio: 0.4,
				credit_loans: { total_balance: 30000, total_credit_limit: 100000 },
				credit_cards: {
					total_limit: 100000,
					total_used: 50000,
					utilization_used: 50000,
					usage_rate: 0.5,
					shared_group_count: 0
				}
			},
			query_analysis: {
				summary: {
					last_1m: { total: 1 },
					last_3m: { total: 2 },
					last_6m: { total: 3 },
					last_12m: { total: 4 }
				}
			},
			overdue_info: { total_overdue_accounts: 0 },
			primary_rule_score: { score: 76 },
			six_dimensions: {
				credit_history: 80,
				query_frequency: 70,
				account_structure: 75,
				repayment_record: 90
			}
		}))

		assert.equal(out.dimensions.totalDebt, 80000)
		assert.equal(out.dimensions.cardUtilizationRate, 0.5)
		assert.equal(out.dimensions.q1, 1)
		assert.equal(out.dimensions.hasOverdue, null)
	})

	it('keeps only compact evidence metadata in the persisted Web mapping', () => {
		const hashes = {
			manifest: `mh_v2_${'a'.repeat(64)}`,
			evidence: `eg_v2_${'b'.repeat(64)}`,
			fact: `fl_v2_${'c'.repeat(64)}`,
			metric: `da_v2_${'d'.repeat(64)}`
		}
		const privateSentinel = 'PRIVATE_EVIDENCE_BLOCK_MUST_NOT_REACH_WEB_STORAGE'
		const out = mapServerAnalyzeDataToClientAnalysis({
			basic_info: { name: '脱敏测试用户', id_last4: '2468' },
			credit_debt: {
				total_debt: 24000,
				debt_ratio: 0.24,
				credit_loans: { total_balance: 4000 },
				credit_cards: { total_limit: 100000, total_used: 20000, utilization_used: 20000, usage_rate: 0.2, card_count: 1 }
			},
			loan_details: { bank_loans: [], non_bank_loans: [] },
			credit_card_details: [
				{ institution: '测试银行', credit_limit: 100000, used_limit: 20000, status: '正常' }
			],
			query_analysis: { summary: { last_1m: { total: 1 } } },
			risk_analysis: { overall_level: '低风险', risk_hits: ['兼容业务字段'] },
			derivation_meta: {
				mode: 'deterministic-incomplete',
				evidence_mode: 'evidence-v2',
				evidence_hash: hashes.evidence,
				fact_hash: hashes.fact,
				metric_hash: hashes.metric
			},
			evidence_meta: {
				version: 'evidence-v2',
				status: 'publishable',
				authoritative_scope: [
					'primary_rule_score.score',
					privateSentinel,
					'credit_debt.total_debt',
					'credit_debt.credit_cards.utilization_used'
				],
				manifest_hash: hashes.manifest,
				evidence_hash: hashes.evidence,
				fact_hash: hashes.fact,
				metric_hash: hashes.metric,
				publication_gate: 'passed',
				fact_count: 2,
				supported_fact_count: 1,
				private_note: privateSentinel
			},
			evidence_v2: {
				contract: 'rpt.credit/evidence-first-analysis/2.0',
				status: 'publishable',
				manifest: {
					manifestHash: hashes.manifest,
					pages: [{ pageNumber: 1, sourceText: privateSentinel }]
				},
				evidenceGraph: {
					evidenceGraphHash: hashes.evidence,
					evidenceBlocks: [{ rawText: privateSentinel }]
				},
				factLedger: {
					factLedgerHash: hashes.fact,
					facts: [
						{ id: 'fact-1', status: 'accepted', matchedQuotes: [privateSentinel] },
						{ id: 'fact-2', status: 'candidate', matchedQuotes: [privateSentinel] }
					]
				},
				derivedAnalysis: {
					derivedAnalysisHash: hashes.metric,
					inputs: { factLedgerHash: hashes.fact }
				},
				publicationGate: { status: 'passed', checks: [{ detail: privateSentinel }] }
			},
			raw_evidence_blocks: [{ ocr_text: privateSentinel }]
		})

		assert.deepEqual(out.evidence_meta, {
			version: 'evidence-v2',
			status: 'publishable',
			authoritative_scope: [
				'credit_debt.total_debt',
				'credit_debt.credit_cards.utilization_used',
				'primary_rule_score.score'
			],
			manifest_hash: hashes.manifest,
			evidence_hash: hashes.evidence,
			fact_hash: hashes.fact,
			metric_hash: hashes.metric,
			publication_gate: 'passed',
			fact_count: 2,
			supported_fact_count: 1
		})
		assert.equal(out.evidence_v2, undefined)
		assert.equal(out.evidenceMeta, undefined)
		assert.equal(out.raw_evidence_blocks, undefined)
		assert.equal(out.derivation_meta.evidence_mode, 'evidence-v2')
		assert.equal(out.derivation_meta.evidence_hash, undefined)

		for (const compatibilityView of [out.aiInsight, out.kimiInsight, out.creditReportV2]) {
			assert.equal(compatibilityView.evidence_v2, undefined)
			assert.equal(compatibilityView.evidence_meta, undefined)
			assert.equal(compatibilityView.factLedger, undefined)
			assert.equal(compatibilityView.credit_debt.total_debt, 24000)
			assert.equal(compatibilityView.credit_debt.credit_cards.utilization_used, 20000)
			assert.deepEqual(compatibilityView.risk_analysis.risk_hits, ['兼容业务字段'])
		}

		const serialized = JSON.stringify(out)
		assert.equal(serialized.includes(privateSentinel), false)
		for (const hash of Object.values(hashes)) {
			assert.equal(serialized.split(hash).length - 1, 1)
		}
	})

	it('derives compact evidence metadata when only evidence_v2 is returned', () => {
		const hashes = {
			manifest: `mh_v2_${'1'.repeat(64)}`,
			evidence: `eg_v2_${'2'.repeat(64)}`,
			fact: `fl_v2_${'3'.repeat(64)}`,
			metric: `da_v2_${'4'.repeat(64)}`
		}
		const out = mapServerAnalyzeDataToClientAnalysis({
			credit_debt: {
				total_debt: 0,
				credit_loans: {},
				credit_cards: { total_limit: 0, total_used: 0, card_count: 0 }
			},
			loan_details: { bank_loans: [], non_bank_loans: [] },
			query_analysis: { summary: {} },
			evidence_v2: {
				contract: 'rpt.credit/evidence-first-analysis/2.0',
				status: 'blocked',
				manifest: { manifestHash: hashes.manifest },
				evidenceGraph: { evidenceGraphHash: hashes.evidence },
				factLedger: {
					factLedgerHash: hashes.fact,
					facts: [{ status: 'accepted' }, { status: 'candidate' }]
				},
				derivedAnalysis: { derivedAnalysisHash: hashes.metric },
				publicationGate: { status: 'blocked' }
			}
		})

		assert.deepEqual(out.evidence_meta, {
			version: 'evidence-v2',
			status: 'blocked',
			manifest_hash: hashes.manifest,
			evidence_hash: hashes.evidence,
			fact_hash: hashes.fact,
			metric_hash: hashes.metric,
			publication_gate: 'blocked',
			fact_count: 2,
			supported_fact_count: 1
		})
		assert.equal(out.evidence_v2, undefined)
		assert.equal(out.creditReportV2.evidence_v2, undefined)
	})

	it('drops compact evidence metadata when declared values conflict with hashed artifacts', () => {
		const hashes = {
			manifest: `mh_v2_${'1'.repeat(64)}`,
			evidence: `eg_v2_${'2'.repeat(64)}`,
			fact: `fl_v2_${'3'.repeat(64)}`,
			metric: `da_v2_${'4'.repeat(64)}`
		}
		const out = mapServerAnalyzeDataToClientAnalysis({
			credit_debt: {
				total_debt: 0,
				credit_loans: {},
				credit_cards: { total_limit: 0, total_used: 0, card_count: 0 }
			},
			loan_details: { bank_loans: [], non_bank_loans: [] },
			query_analysis: { summary: {} },
			evidence_meta: {
				version: 'evidence-v2',
				status: 'publishable',
				manifest_hash: hashes.manifest,
				evidence_hash: hashes.evidence,
				fact_hash: hashes.fact,
				metric_hash: hashes.metric,
				publication_gate: 'passed',
				fact_count: 0,
				supported_fact_count: 0
			},
			evidence_v2: {
				contract: 'rpt.credit/evidence-first-analysis/2.0',
				status: 'blocked',
				manifest: { manifestHash: hashes.manifest },
				evidenceGraph: { evidenceGraphHash: hashes.evidence },
				factLedger: { factLedgerHash: hashes.fact, facts: [] },
				derivedAnalysis: { derivedAnalysisHash: hashes.metric },
				publicationGate: { status: 'blocked' }
			}
		})

		assert.equal(out.evidence_meta, undefined)
		assert.equal(out.evidence_v2, undefined)
	})

	it('drops malformed evidence metadata instead of persisting arbitrary identifier-like text', () => {
		const sentinel = 'CUSTOMER_IDENTIFIER_MUST_NOT_BECOME_EVIDENCE_METADATA'
		const out = mapServerAnalyzeDataToClientAnalysis({
			credit_debt: {
				total_debt: 0,
				credit_loans: {},
				credit_cards: { total_limit: 0, total_used: 0, card_count: 0 }
			},
			loan_details: { bank_loans: [], non_bank_loans: [] },
			query_analysis: { summary: {} },
			evidence_meta: {
				version: sentinel,
				status: sentinel,
				manifest_hash: sentinel,
				evidence_hash: sentinel,
				fact_hash: sentinel,
				metric_hash: sentinel,
				publication_gate: sentinel
			}
		})

		assert.equal(out.evidence_meta, undefined)
		assert.equal(JSON.stringify(out).includes(sentinel), false)
	})
})
