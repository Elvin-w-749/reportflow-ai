import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { resolveActionKey, ACTION_KEYS } from '../src/services/actionPolicy.js'
import { resolveDecisionQueryCounts, resolveEvidenceBackedDebtRatio } from '../src/services/decisionMetrics.js'
import { createOwnerApiDecisionTrust } from '../src/services/decisionTrust.js'
import { buildUnifiedMatchProfile, computeProductMatchRate } from '../src/services/matchCore.js'

const hash = (prefix, char) => `${prefix}_${char.repeat(64)}`

const forgedDebtRatioArtifact = ({ value = 0.99, numerator = 1, denominator = 100 } = {}) => ({
	contract: 'rpt-credit-evidence/2.0',
	status: 'publishable',
	manifest: { manifestHash: hash('mh_v2', 'a') },
	evidenceGraph: { evidenceGraphHash: hash('eg_v2', 'b') },
	factLedger: { factLedgerHash: hash('fl_v2', 'c') },
	derivedAnalysis: {
		status: 'validated',
		derivedAnalysisHash: hash('da_v2', 'd'),
		metrics: {
			// debtRatio is intentionally not part of the production evidence-v2 contract.
			debtRatio: {
				status: 'computed',
				formulaId: 'forged-debt-ratio',
				value,
				numerator: { value: numerator },
				denominator: { value: denominator },
				inputFactIds: ['fact-debt', 'fact-limit']
			}
		}
	},
	publicationGate: { status: 'passed' }
})

const verifiedQueryArtifact = () => {
	const manifestHash = hash('mh_v2', 'a')
	const graphHash = hash('eg_v2', 'b')
	const ledgerHash = hash('fl_v2', 'c')
	return {
		contract: 'rpt-credit-evidence/2.0',
		status: 'publishable',
		manifest: { manifestHash },
		evidenceGraph: { manifestHash, evidenceGraphHash: graphHash },
		factLedger: { evidenceGraphHash: graphHash, factLedgerHash: ledgerHash },
		derivedAnalysis: {
			status: 'validated',
			inputs: { factLedgerHash: ledgerHash },
			derivedAnalysisHash: hash('da_v2', 'd'),
			metrics: {
				queryCounts: {
					status: 'computed',
					formulaId: 'hard-query-calendar-window-v2',
					inputFactIds: ['fact-report-date', 'fact-query-1'],
					value: { last_1m: 1, last_3m: 2, last_6m: 3 }
				}
			}
		},
		publicationGate: { status: 'passed', publishable: true }
	}
}

describe('evidence-first Web decision gates', () => {
	it('rejects a forged debt-ratio metric even when its hash-shaped trace looks complete', () => {
		const resolved = resolveEvidenceBackedDebtRatio({ evidence_v2: forgedDebtRatioArtifact() })

		assert.equal(resolved.value, null)
		assert.equal(resolved.decisionEligible, false)
	})

	it('rejects an old owner projection even when its debt-ratio flag is true', () => {
		const projection = createOwnerApiDecisionTrust({
			id: 'report-old-ratio',
			decisionEvidenceLinked: true,
			evidenceVerified: true,
			decisionFlags: { debtRatio: true },
			debtRatio: 0.99
		})
		const resolved = resolveEvidenceBackedDebtRatio({}, projection, 'report-old-ratio')

		assert.equal(resolved.value, null)
		assert.equal(resolved.decisionEligible, false)
		assert.equal(resolved.source, 'unsupported-metric-no-approved-denominator')
	})

	it('does not treat hash-shaped browser artifacts as server-verified query evidence', () => {
		const artifact = verifiedQueryArtifact()
		const resolved = resolveDecisionQueryCounts({ evidence_v2: artifact })
		assert.deepEqual(
			{ q1: resolved.q1, q3: resolved.q3, q6: resolved.q6, known: resolved.known },
			{ q1: null, q3: null, q6: null, known: false }
		)

		const unlinked = structuredClone(artifact)
		unlinked.factLedger.evidenceGraphHash = hash('eg_v2', 'e')
		assert.equal(resolveDecisionQueryCounts({ evidence_v2: unlinked }).known, false)
	})

	it('keeps a reproducible client score and all legacy decision metrics archival', () => {
		const profile = buildUnifiedMatchProfile({
			report: {
				primaryRuleScore: {
					score: 88,
					baseScore: 100,
					totalDeduction: 12,
					deductions: [
						{ code: 'ACC_GT_3', points: 3 },
						{ code: 'Q6_GT_6', points: 9 }
					]
				},
				adjustedTotalScore: 99
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
				institutionCount: 3
			},
			compositeMeta: { hasBaseScore: true, adjustedTotalScore: 99 },
			evidence_v2: forgedDebtRatioArtifact()
		})

		assert.equal(profile.baseTotalScore, null)
		assert.equal(profile.archivalBaseScore, 88)
		assert.equal(profile.totalScore, null)
		assert.equal(profile.hasDecisionScore, false)
		assert.equal(profile.adjustedTotalScore, null)
		assert.equal(profile.archivalAdjustedTotalScore, 99)
		assert.equal(profile.hasDecisionAdjustedScore, false)
		assert.equal(profile.hasDecisionDebtRatio, false)
		assert.equal(profile.debtRatio, null)
		assert.equal(profile.q1Known, false)
		assert.equal(profile.q3Known, false)
		assert.equal(profile.q6Known, false)
		assert.equal(profile.q1, null)
		assert.equal(profile.q3, null)
		assert.equal(profile.q6, null)
		assert.equal(profile.nonBankLoanRatioKnown, false)
		assert.equal(profile.nonBankLoanRatio, null)
		assert.equal(profile.institutionCountKnown, false)
		assert.equal(profile.institutionCount, null)
		assert.equal(profile.overdueKnown, false)
		assert.equal(profile.totalCreditDebt, null)
		assert.equal(profile.hasDecisionTotalCreditDebt, false)
		assert.equal(profile.hasVerifiedEvidenceV2, false)
	})

	it('keeps client-attested adjusted scores archival even when their arithmetic is reproducible', () => {
		const baseReport = {
			primaryRuleScore: {
				score: 88,
				baseScore: 100,
				totalDeduction: 12,
				deductions: [
					{ code: 'ACC_GT_3', points: 3 },
					{ code: 'Q6_GT_6', points: 9 }
				]
			},
			adjustedTotalScore: 93
		}
		const validAttestation = {
			status: 'reproducible',
			formulaId: 'supplement-adjustment-v1',
			baseScore: 88,
			adjustedScore: 93,
			adjustments: [{ code: 'INCOME_EVIDENCE', delta: 5 }]
		}

		const verified = buildUnifiedMatchProfile({
			report: baseReport,
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
			compositeMeta: { adjustedTotalScore: 93, adjustedScoreAttestation: validAttestation }
		})
		assert.equal(verified.baseTotalScore, null)
		assert.equal(verified.archivalBaseScore, 88)
		assert.equal(verified.archivalAdjustedTotalScore, 93)
		assert.equal(verified.adjustedTotalScore, null)
		assert.equal(verified.totalScore, null)
		assert.equal(verified.hasDecisionAdjustedScore, false)

		const forged = buildUnifiedMatchProfile({
			report: baseReport,
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
			compositeMeta: {
				adjustedTotalScore: 93,
				adjustedScoreAttestation: {
					...validAttestation,
					adjustments: [{ code: 'INCOME_EVIDENCE', delta: 2 }]
				}
			}
		})
		assert.equal(forged.adjustedTotalScore, null)
		assert.equal(forged.archivalBaseScore, 88)
		assert.equal(forged.totalScore, null)
		assert.equal(forged.hasDecisionAdjustedScore, false)
	})

	it('does not turn unknown thresholds into a safe product match', () => {
		const result = computeProductMatchRate(
			{
				id: 'strict-bank',
				rules: {
					allowOverdue: false,
					allowLianSan: false,
					minScore: 60,
					maxDebtRatio: 0.7,
					maxQueryCount: 8,
					maxNonBankRatio: 0.4,
					maxInstitutions: 10
				}
			},
			{
				hasDecisionScore: true,
				totalScore: 85,
				hasDecisionDebtRatio: false,
				debtRatio: null,
				overdueKnown: false,
				hasLianSanKnown: false,
				hasLeiLiuKnown: false,
				hasOverdue: false,
				hasLianSan: false,
				hasLeiLiu: false,
				hasDecisionQueryWindows: false,
				q3Known: false,
				q3: null,
				hasDecisionNonBankLoanRatio: false,
				nonBankLoanRatioKnown: false,
				nonBankLoanRatio: null,
				hasDecisionInstitutionCount: false,
				institutionCountKnown: false,
				institutionCount: null,
				hasAuditableDimensions: false,
				sixDims: { creditHistory: 0, queryFrequency: 0, accountStructure: 0, repaymentRecord: 0 }
			}
		)

		assert.equal(result.isMatch, false)
		assert.equal(result.decisionEligible, false)
		assert.match(result.matchReasons.join(' '), /待核对|缺少/)
	})

	it('keeps legacy overdue summaries archival instead of making a yes/no decision', () => {
		const profile = buildUnifiedMatchProfile({
			aiInsight: {
				overdue_summary: {
					current_overdue_count: 2,
					consecutive_overdue_3: true
				}
			},
			dimensions: { overdueCount: 2, hasLianSan: true }
		})

		assert.equal(profile.hasOverdue, null)
		assert.equal(profile.hasDecisionOverdue, false)
		assert.equal(profile.archivalHasOverdue, true)
		assert.equal(profile.archivalOverdueCount, 2)
		assert.equal(profile.archivalHasLianSan, true)
	})

	it('requires explicit known flags before the Home policy may return MATCH', () => {
		const common = {
			hasReport: true,
			score: 85,
			highRiskCount: 0,
			overdueAccountCount: 0,
			query6mCount: 1
		}

		assert.equal(resolveActionKey(common), ACTION_KEYS.ADVISOR)
		assert.equal(resolveActionKey({
			...common,
			scoreKnown: true,
			highRiskKnown: true,
			overdueKnown: true,
			queryKnown: true
		}), ACTION_KEYS.MATCH)
	})

	it('does not reintroduce default products after evidence-gated matching returns too few results', () => {
		const engineSource = readFileSync(new URL('../src/services/matchEngine.js', import.meta.url), 'utf8')
		const homeSource = readFileSync(new URL('../src/pages/home/Home.vue', import.meta.url), 'utf8')
		assert.doesNotMatch(engineSource, /if \(result\.length < 3\)[\s\S]{0,120}getDefaultProducts/)
		assert.match(engineSource, /p\.isMatch === true && p\.matchRate > 30/)
		assert.match(homeSource, /scoreKnown: hasScore\.value/)
		assert.match(homeSource, /highRiskKnown: hasHighRiskEvidence\.value/)
		assert.match(homeSource, /overdueKnown: hasOverdueEvidence\.value/)
		assert.match(homeSource, /queryKnown: hasQueryEvidence\.value/)
	})
})
