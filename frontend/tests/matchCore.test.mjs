import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
	buildUnifiedMatchProfile,
	computeProductMatchRate,
	explainMatchGaps,
	rankProductsByMatch,
	scoreProductsByMatch
} from '../src/services/matchCore.js'

describe('matchCore', () => {
	const evidenceV2DebtRatio = (value = 0.42) => ({
		contract: 'rpt-credit-evidence/2.0',
		status: 'publishable',
		manifest: { manifestHash: `mh_v2_${'a'.repeat(64)}` },
		evidenceGraph: { evidenceGraphHash: `eg_v2_${'b'.repeat(64)}` },
		factLedger: { factLedgerHash: `fl_v2_${'c'.repeat(64)}` },
		derivedAnalysis: {
			status: 'validated',
			derivedAnalysisHash: `da_v2_${'d'.repeat(64)}`,
			metrics: {
				debtRatio: {
					status: 'computed',
					formulaId: 'debt-ratio-v2',
					value,
					numerator: { value: 4200 },
					denominator: { value: 10000 },
					inputFactIds: ['fact-debt', 'fact-limit']
				}
			}
		},
		publicationGate: { status: 'passed' }
	})

	it('builds a normalized profile without overwriting real zero scores', () => {
		const profile = buildUnifiedMatchProfile({
			report: {
				scores: {
					credit_history: 0,
					query_frequency: 80,
					account_structure: 70,
					repayment_record: 90
				},
				primaryRuleScore: {
					score: 88,
					baseScore: 100,
					totalDeduction: 12,
					deductions: [
						{ code: 'ACC_GT_3', points: 3 },
						{ code: 'Q6_GT_6', points: 9 }
					]
				},
				adjustedTotalScore: 89,
				riskLevel: 'medium'
			},
			dimensions: {
				totalAccountCount: 4,
				nonBankLoanCount: 0,
				cardUtilizationRate: 0.42,
				hasBigInstallment: false,
				sameDayInquiryDayCount: 0,
				q1: 1,
				q3: 4,
				q6: 7,
				overdueCount: 0
			},
			algorithmReport: {
				breakdown: { nonBankLoanRatio: 0.2 },
				institutionCount: 3,
				integratedRisk: { score: 74 },
				creditDebt: { total: 120000 }
			},
			compositeMeta: {
				hasBaseScore: true,
				stabilityScore: 80,
				incomeTierScore: 90,
				assetStrengthPoints: 12
			},
			evidence_v2: evidenceV2DebtRatio()
		})

		assert.equal(profile.sixDims.creditHistory, 0)
		assert.equal(profile.totalScore, null)
		assert.equal(profile.baseTotalScore, null)
		assert.equal(profile.archivalBaseScore, 88)
		assert.equal(profile.adjustedTotalScore, null)
		assert.equal(profile.hasDecisionScore, false)
		assert.equal(profile.debtRatioPct, null)
		assert.equal(profile.hasDecisionDebtRatio, false)
		assert.equal(profile.q3, null)
		assert.equal(profile.q3Known, false)
		assert.equal(profile.nonBankLoanRatio, null)
		assert.equal(profile.nonBankLoanRatioKnown, false)
		assert.equal(profile.institutionCount, null)
		assert.equal(profile.institutionCountKnown, false)
		assert.equal(profile.hasOverdue, null)
		assert.equal(profile.hasDecisionOverdue, false)
		assert.equal(profile.integratedRiskScore, null)
		assert.equal(profile.totalCreditDebt, null)
		assert.equal(profile.hasDecisionTotalCreditDebt, false)
		assert.equal(profile.isHighRisk, false)
	})

	it('hard rejects products that do not allow consecutive serious overdue records', () => {
		const result = computeProductMatchRate(
			{ rules: { allowLianSan: false } },
			{
				hasDecisionOverdue: true,
				hasLianSan: true,
				hasLeiLiu: false,
				hasOverdue: true,
				sixDims: {
					creditHistory: 80,
					queryFrequency: 80,
					accountStructure: 80,
					repaymentRecord: 40
				},
				totalScore: 70,
				debtRatio: 0.4,
				debtRatioPct: 40,
				q3: 2,
				nonBankLoanRatio: 0.1,
				institutionCount: 3
			}
		)

		assert.equal(result.matchRate, 5)
		assert.equal(result.isMatch, false)
		assert.match(result.matchReasons.join(' '), /连三/)
	})

	it('hard rejects products that explicitly disallow any overdue records', () => {
		const result = computeProductMatchRate(
			{ rules: { allowOverdue: false, minScore: 60 } },
			{
				hasDecisionOverdue: true,
				hasLianSan: false,
				hasLeiLiu: false,
				hasOverdue: true,
				sixDims: {
					creditHistory: 90,
					queryFrequency: 90,
					accountStructure: 90,
					repaymentRecord: 70
				},
				totalScore: 88,
				debtRatio: 0.25,
				debtRatioPct: 25,
				q3: 1,
				nonBankLoanRatio: 0,
				institutionCount: 2
			}
		)

		assert.equal(result.matchRate, 5)
		assert.equal(result.isMatch, false)
		assert.match(result.matchReasons.join(' '), /逾期记录/)
	})

	it('filters, sorts and limits ranked products by match rate', () => {
		const profile = {
			hasDecisionScore: true,
			hasDecisionDebtRatio: true,
			hasDecisionOverdue: true,
			overdueKnown: true,
			hasLianSanKnown: true,
			hasLeiLiuKnown: true,
			hasAuditableDimensions: true,
			hasLianSan: false,
			hasLeiLiu: false,
			hasOverdue: false,
			sixDims: {
				creditHistory: 100,
				queryFrequency: 100,
				accountStructure: 100,
				repaymentRecord: 100
			},
			totalScore: 75,
			debtRatio: 0.3,
			debtRatioPct: 30,
			q3: 0,
			hasDecisionQueryWindows: true,
			q3Known: true,
			nonBankLoanRatio: 0,
			hasDecisionNonBankLoanRatio: true,
			nonBankLoanRatioKnown: true,
			institutionCount: 1,
			hasDecisionInstitutionCount: true,
			institutionCountKnown: true
		}
		const products = [
			{ id: 'baseline', rules: {} },
			{ id: 'strict-score', rules: { minScore: 90 } },
			{ id: 'too-strict', rules: { minScore: 200 } }
		]

		const ranked = rankProductsByMatch(products, profile, { minRate: 80, limit: 2 })

		assert.deepEqual(ranked.map((p) => p.id), ['baseline', 'strict-score'])
		assert.ok(ranked[0].matchRate >= ranked[1].matchRate)
		assert.equal(ranked.length, 2)
	})

	it('scores every product before filtering ranked results', () => {
		const profile = {
			hasDecisionScore: true,
			hasDecisionDebtRatio: true,
			hasDecisionOverdue: true,
			overdueKnown: true,
			hasLianSanKnown: true,
			hasLeiLiuKnown: true,
			hasAuditableDimensions: true,
			hasLianSan: false,
			hasLeiLiu: false,
			hasOverdue: false,
			sixDims: {
				creditHistory: 80,
				queryFrequency: 80,
				accountStructure: 80,
				repaymentRecord: 80
			},
			totalScore: 68,
			debtRatio: 0.45,
			debtRatioPct: 45,
			q3: 2,
			hasDecisionQueryWindows: true,
			q3Known: true,
			nonBankLoanRatio: 0.1,
			hasDecisionNonBankLoanRatio: true,
			nonBankLoanRatioKnown: true,
			institutionCount: 2,
			hasDecisionInstitutionCount: true,
			institutionCountKnown: true
		}
		const scored = scoreProductsByMatch([
			{ id: 'strict', rules: { minScore: 85 } },
			{ id: 'baseline', rules: {} }
		], profile)

		assert.equal(scored.length, 2)
		assert.deepEqual(scored.map((p) => p.id), ['baseline', 'strict'])
		assert.ok(scored.every((p) => typeof p.matchRate === 'number'))
	})

	it('explains severe blockers when visible matches are weak', () => {
		const profile = {
			hasDecisionScore: true,
			hasDecisionDebtRatio: true,
			hasDecisionOverdue: true,
			overdueKnown: true,
			hasLianSanKnown: true,
			hasLeiLiuKnown: true,
			hasAuditableDimensions: true,
			hasLianSan: true,
			hasLeiLiu: true,
			hasOverdue: true,
			sixDims: {
				creditHistory: 20,
				queryFrequency: 20,
				accountStructure: 20,
				repaymentRecord: 10
			},
			totalScore: 42,
			debtRatio: 0.96,
			debtRatioPct: 96,
			q3: 14,
			hasDecisionQueryWindows: true,
			q3Known: true,
			nonBankLoanRatio: 0.7,
			hasDecisionNonBankLoanRatio: true,
			nonBankLoanRatioKnown: true,
			institutionCount: 16,
			hasDecisionInstitutionCount: true,
			institutionCountKnown: true,
			integratedRiskScore: 45
		}
		const scored = scoreProductsByMatch([
			{ id: 'bank', rules: { allowLianSan: false, minScore: 70, maxDebtRatio: 0.6, maxQueryCount: 5 } },
			{ id: 'relief', rules: { allowLianSan: true, allowOverdue: true, minScore: 0, maxDebtRatio: 3, preferHighDebt: true } }
		], profile)
		const visible = scored.filter((p) => p.matchRate > 30)
		const explanation = explainMatchGaps(profile, scored, visible)

		assert.equal(explanation.severity, 'warning')
		assert.match(explanation.title, /匹配度偏低/)
		assert.ok(explanation.reasons.some((r) => /连三|累六/.test(r)))
		assert.ok(explanation.reasons.some((r) => /负债率/.test(r)))
	})

	it('keeps archival score, risk, debt ratio and dimensions out of matching decisions', () => {
		const product = {
			id: 'legacy-sensitive',
			rules: {
				minScore: 90,
				maxDebtRatio: 0.3,
				preferLowScore: true,
				preferLowDebt: true,
				preferGoodHistory: true
			}
		}
		const build = (totalScore, debtRatio, riskLevel) => buildUnifiedMatchProfile({
			report: {
				totalScore,
				riskLevel,
				scores: {
					credit_history: 99,
					query_frequency: 99,
					account_structure: 99,
					repayment_record: 99
				},
				adjustedTotalScore: 98
			},
			dimensions: { debtRatio, overdueCount: 0 },
			algorithmReport: { integratedRisk: { score: 1 } },
			compositeMeta: { hasBaseScore: false, adjustedTotalScore: 98 }
		})
		const lowLegacy = build(1, 0.99, 'high')
		const highLegacy = build(99, 0.01, 'low')
		const first = computeProductMatchRate(product, lowLegacy)
		const second = computeProductMatchRate(product, highLegacy)

		for (const profile of [lowLegacy, highLegacy]) {
			assert.equal(profile.totalScore, null)
			assert.equal(profile.debtRatio, null)
			assert.equal(profile.riskLevel, 'unknown')
			assert.equal(profile.integratedRiskScore, null)
			assert.equal(profile.hasDecisionScore, false)
			assert.equal(profile.hasDecisionDebtRatio, false)
		}
		assert.equal(first.matchRate, second.matchRate)
		assert.deepEqual(first.matchReasons, second.matchReasons)
		assert.equal(first.matchReasons.some((reason) => /低于|偏高/.test(reason)), false)
	})
})
