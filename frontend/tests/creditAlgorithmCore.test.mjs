import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const originalWarn = console.warn
console.warn = () => {}
const core = await import('../src/services/creditAlgorithmCore.js')
const overdue = await import('../src/services/overdueScore.js')
const scoreV6 = await import('../src/services/scoreV6.js')
console.warn = originalWarn

const {
	INSTITUTION_TYPE,
	analyzeQueryWindows,
	analyzeOverdueSummary,
	applyOverdueTotalCap,
	buildAlgorithmReport,
	calculateIntegratedRiskScore,
	calculatePrimaryRuleScore,
	classifyInstitution,
	composeFourDimTotal,
	scoreFourDimensions
} = core

const {
	overdueScoreFromDimensions,
	overdueScoreFromRecords
} = overdue

const { resolveV6ScoreDetails, resolveV6TotalFromAnalysis } = scoreV6

const publishableEvidenceMeta = () => ({
	version: 'evidence-v2',
	status: 'publishable',
	publication_gate: 'passed',
	manifest_hash: `mh_v2_${'1'.repeat(64)}`,
	evidence_hash: `eg_v2_${'2'.repeat(64)}`,
	fact_hash: `fl_v2_${'3'.repeat(64)}`,
	metric_hash: `da_v2_${'4'.repeat(64)}`,
	authoritative_scope: ['primary_rule_score.score']
})

describe('creditAlgorithmCore', () => {
	it('anchors report query and maturity windows to the report date', () => {
		const report = buildAlgorithmReport({
			basicInfo: { reportDate: '2026-06-30' },
			creditAccounts: [{
				isLoan: true,
				isSettled: false,
				bank: '测试银行',
				balance: 20000,
				loanAmount: 50000,
				endDate: '2026-10-01'
			}],
			queryRecords: {
				queryItems: [
					{ date: '2026-06-20', institution: '测试银行', reason: '贷款审批' },
					{ date: '2026-07-01', institution: '未来银行', reason: '贷款审批' }
				]
			}
		}, {
			totalDebt: 20000,
			usedCardLimit: 0,
			cardUtilizationRate: 0,
			q3: 1
		})

		assert.equal(report.reportBenchmarkDate, '2026-06-30')
		assert.equal(report.queryBenchmarkLiveAt, '2026-06-30')
		assert.equal(report.queryWindows['近一个月'].总次数, 1)
		assert.equal(report.upcomingDue.笔数, 1)
	})

	it('classifies bank, non-bank, central-bank and unknown institutions deterministically', () => {
		assert.equal(classifyInstitution('招商银行股份有限公司'), INSTITUTION_TYPE.BANK)
		assert.equal(classifyInstitution('兴业消费金融股份公司'), INSTITUTION_TYPE.NON_BANK)
		assert.equal(classifyInstitution('平安普惠融资担保有限公司'), INSTITUTION_TYPE.NON_BANK)
		assert.equal(classifyInstitution('中国人民银行征信中心'), 'CENTRAL_BANK')
		assert.equal(classifyInstitution('某某科技有限公司'), INSTITUTION_TYPE.OTHER)
	})

	it('counts only effective approval queries and supports org fallback', () => {
		const result = analyzeQueryWindows([
			{ date: '2026-06-20', org: '招商银行', reason: '贷款审批' },
			{ date: '2026-05-01', org: '兴业消费金融', reason: '贷款审批' },
			{ date: '2025-12-30', institution: '建设银行', reason: '信用卡审批' },
			{ date: '2026-06-15', org: '本人查询', reason: '本人查询' },
			{ date: '2026-06-10', org: '工商银行', reason: '贷后管理' }
		], new Date('2026-06-30T12:00:00+08:00'))

		assert.deepEqual(result['近一个月'], { 总次数: 1, 银行: 1, 非银: 0 })
		assert.deepEqual(result['近三个月'], { 总次数: 2, 银行: 1, 非银: 1 })
		assert.deepEqual(result['近十二个月'], { 总次数: 3, 银行: 2, 非银: 1 })
	})

	it('applies primary-rule deductions as highest matching buckets', () => {
		const result = calculatePrimaryRuleScore({
			totalAccountCount: 8,
			nonBankLoanCount: 6,
			cardUtilizationRate: 0.75,
			hasBigInstallment: true,
			q6: 8,
			sameDayInquiryDayCount: 1
		})

		assert.equal(result.totalDeduction, 93)
		assert.equal(result.score, 7)
		assert.deepEqual(result.deductions.map((x) => x.code), [
			'ACC_GT_6',
			'NONBANK_GE_5',
			'CARD_UTIL_GT_70',
			'CARD_BIG_INSTALLMENT',
			'Q6_GT_6',
			'SAME_DAY_QUERY_GT_3'
		])
	})

	it('keeps primary-rule scoring stable for invalid numeric inputs', () => {
		const result = calculatePrimaryRuleScore({
			totalAccountCount: Number.POSITIVE_INFINITY,
			nonBankLoanCount: Number.NaN,
			cardUtilizationRate: Number.POSITIVE_INFINITY,
			q6: -8,
			sameDayInquiryDayCount: 'not-a-number'
		})

		assert.equal(result.score, 100)
		assert.equal(result.totalDeduction, 0)
		assert.deepEqual(result.deductions, [])
	})

	it('composes four dimensions and caps totals for serious overdue signals', () => {
		const four = {
			repayment_record: 100,
			credit_history: 80,
			account_structure: 60,
			query_frequency: 70
		}

		assert.equal(composeFourDimTotal(four, {}), 80)
		assert.equal(composeFourDimTotal(four, { m2Count: 1 }), 45)
		assert.equal(applyOverdueTotalCap(88, { hasLianSan: true }), 33)
		assert.equal(applyOverdueTotalCap(88, { hasLeiLiu: true }), 27)
	})

	it('keeps blank credit histories at zero instead of assigning a baseline score', () => {
		const four = scoreFourDimensions({})

		assert.equal(four.credit_history, 0)
		assert.equal(four.account_structure, 0)
		assert.equal(four.query_frequency, 100)
		assert.equal(four.repayment_record, null)
	})

	it('returns low confidence risk score when all risk signals are absent', () => {
		assert.deepEqual(calculateIntegratedRiskScore({}), {
			score: null,
			risk_level: '未知',
			factors: ['数据不足，无法计算综合风险分'],
			confidence: 'low'
		})
	})

	it('counts only numeric matrix codes as overdue months', () => {
		const summary = analyzeOverdueSummary([
			{ isOverdue: true, status: '正常', repayMatrix: ['N', 'C', 'G', 'D', 'Z', '/', '*', '0', '1', '2', '3', 'N'] }
		])

		assert.equal(summary.近5年逾期笔数, 1)
		assert.equal(summary.累计逾期月数, 3)
	})

	it('does not count a negated overdue status as currently overdue', () => {
		const summary = analyzeOverdueSummary([
			{ isOverdue: true, status: '当前无逾期', repayMatrix: ['1'] }
		])

		assert.equal(summary.近5年逾期笔数, 1)
		assert.equal(summary.当前逾期账户, 0)
	})
})

describe('overdue and v6 score resolution', () => {
	it('scores overdue records by recency and severity', () => {
		const score = overdueScoreFromRecords([
			{ date: '2026-06-01', level: 'M1', bank: '招商银行' },
			{ date: '2026-01-01', level: 'M2', bank: '建设银行' },
			{ date: '2024-01-01', days: 120, bank: '兴业消费金融' }
		], new Date('2026-06-30T12:00:00+08:00'))

		assert.equal(score.base, 70)
		assert.equal(score.totalDeduction, 128)
		assert.equal(score.score, 0)
		assert.deepEqual(score.deductions.map((x) => [x.level, x.bucket, x.points]), [
			['M1', 'within6m', 50],
			['M2', 'within6m', 70],
			['M3+', 'older', 8]
		])
	})

	it('falls back to dimension-level overdue scoring when detailed records are absent', () => {
		const score = overdueScoreFromDimensions({ m1Count: 1, m2Count: 1, m3Count: 1, maxOverdueDays: 181 })

		assert.equal(score.totalDeduction, 100)
		assert.equal(score.score, 0)
		assert.deepEqual(score.deductions.map((x) => [x.level, x.points]), [
			['M1', 10],
			['M2', 20],
			['M3+', 70]
		])
	})

	it('keeps an arithmetic-only legacy overdue score archival without provenance', () => {
		const analysis = {
			primary_rule_score: { score: 90 },
			overdueRecords: [
				{ date: '2026-06-01', level: 'M1', bank: '招商银行' }
			]
		}
		const resolved = resolveV6ScoreDetails(analysis)
		const total = resolveV6TotalFromAnalysis(analysis)

		assert.equal(resolved.score, 20)
		assert.equal(resolved.source, 'overdue-special')
		assert.equal(total, null)
		assert.equal(resolved.auditable, false)
		assert.equal(resolved.decisionEligible, false)
		assert.equal(resolved.archivalOnly, true)
	})

	it('keeps a locally reproducible primary score archival without owner API trust', () => {
		const analysis = {
			dimensions: {
				totalAccountCount: 8,
				nonBankLoanCount: 0,
				cardUtilizationRate: 0.4,
				hasBigInstallment: false,
				q6: 2,
				sameDayInquiryDayCount: 0
			}
		}
		const resolved = resolveV6ScoreDetails(analysis)

		assert.equal(resolved.score, 91)
		assert.equal(resolved.auditable, true)
		assert.equal(resolved.decisionEligible, false)
		assert.equal(resolveV6TotalFromAnalysis(analysis), null)
	})

	it('does not turn an empty dimensions object into an unsupported 100 score', () => {
		assert.equal(resolveV6TotalFromAnalysis({ dimensions: {} }), null)
		const archived = resolveV6ScoreDetails({
			dimensions: {},
			report: { totalScore: 68 }
		})
		assert.equal(archived.score, 68)
		assert.equal(archived.source, 'legacy-explicit')
		assert.equal(archived.auditable, false)
		assert.equal(archived.decisionEligible, false)
		assert.equal(archived.archivalOnly, true)
		assert.equal(resolveV6TotalFromAnalysis({ dimensions: {}, report: { totalScore: 68 } }), null)
	})

	it('does not treat an all-zero dimension shell as a supported clean 100 score', () => {
		assert.equal(resolveV6TotalFromAnalysis({
			dimensions: {
				totalAccountCount: 0,
				nonBankLoanCount: 0,
				cardUtilizationRate: 0,
				hasBigInstallment: false,
				q6: 0,
				sameDayInquiryDayCount: 0
			}
		}), null)
	})

	it('keeps a complete clean local report score archival until API confirmation', () => {
		const analysis = {
			dimensions: {
				totalAccountCount: 2,
				nonBankLoanCount: 0,
				cardUtilizationRate: 0,
				hasBigInstallment: false,
				q6: 0,
				sameDayInquiryDayCount: 0
			}
		}
		assert.equal(resolveV6ScoreDetails(analysis).score, 100)
		assert.equal(resolveV6ScoreDetails(analysis).decisionEligible, false)
		assert.equal(resolveV6TotalFromAnalysis(analysis), null)
	})

	it('rejects sparse, null, undefined, and negative primary evidence', () => {
		assert.equal(resolveV6TotalFromAnalysis({ dimensions: { q6: null } }), null)
		assert.equal(resolveV6TotalFromAnalysis({ dimensions: { cardUtilizationRate: undefined } }), null)
		assert.equal(resolveV6TotalFromAnalysis({ dimensions: { hasBigInstallment: false } }), null)
		assert.equal(resolveV6TotalFromAnalysis({ dimensions: { totalAccountCount: -1, q6: -2 } }), null)
		assert.equal(resolveV6TotalFromAnalysis({ dimensions: { totalAccountCount: 0, q6: 0 } }), null)
	})

	it('prefers a meaningful legacy dimension snapshot for archival explanation only', () => {
		const analysis = {
			dimensions: {},
			report: {
				dimensions: {
					totalAccountCount: 8,
					nonBankLoanCount: 0,
					cardUtilizationRate: 0.4,
					hasBigInstallment: false,
					q6: 2,
					sameDayInquiryDayCount: 0
				}
			}
		}
		assert.equal(resolveV6ScoreDetails(analysis).score, 91)
		assert.equal(resolveV6ScoreDetails(analysis).decisionEligible, false)
		assert.equal(resolveV6TotalFromAnalysis(analysis), null)
	})

	it('does not let an empty top-level shell hide legacy overdue dimensions', () => {
		const resolved = resolveV6ScoreDetails({
			dimensions: {},
			report: {
				dimensions: {
					totalAccountCount: 8,
					nonBankLoanCount: 0,
					q6: 2,
					m3Count: 1,
					overdueCount: 1
				}
			}
		})
		assert.equal(resolved.score, 30)
		assert.equal(resolved.source, 'overdue-special')
	})

	it('does not let empty overdue arrays or info objects hide legacy overdue records', () => {
		const resolved = resolveV6ScoreDetails({
			reportDate: '2026-06-30',
			overdueRecords: [],
			overdue_info: { has_overdue: false },
			report: {
				totalScore: 70,
				overdue_info: { overdue_90_days: true },
				overdueRecords: [
					{ date: '2026-06-01', level: 'M1', bank: '测试银行' }
				]
			}
		})
		assert.equal(resolved.score, 0)
		assert.equal(resolved.source, 'overdue-special')
		assert.equal(resolved.result.deductions[0].level, 'M3+')
	})

	it('does not let placeholder overdue rows hide later legacy records', () => {
		for (const placeholder of [[{}], [{ level: 'none' }]]) {
			const resolved = resolveV6ScoreDetails({
				reportDate: '2025-01-01',
				overdueRecords: placeholder,
				report: {
					totalScore: 88,
					overdueRecords: [{ date: '2024-12-20', level: 'M1' }]
				}
			})
			assert.equal(resolved.score, 20)
			assert.equal(resolved.source, 'overdue-special')
		}
	})

	it('reads overdue record and summary aliases without duplicating aggregate severity', () => {
		for (const analysis of [
			{ overdue_records: [{ overdue_date: '2024-12-20', overdue_level: 'M1' }] },
			{ credit_report_full: { overdue_info: { records: [{ overdue_date: '2024-12-20', overdue_level: 'M1' }] } } },
			{ credit_report_full: { overdue_info: { details: [{ overdue_date: '2024-12-20', overdue_level: 'M1' }] } } }
		]) {
			const resolved = resolveV6ScoreDetails({
				reportDate: '2025-01-01',
				report: { totalScore: 88 },
				...analysis
			})
			assert.equal(resolved.score, 20)
			assert.equal(resolved.source, 'overdue-special')
		}

		for (const summaryOwner of [
			{ report: { overdueSummary: { current_overdue_count: 1 } } },
			{ aiInsight: { overdue_summary: { current_overdue_count: 1 } } },
			{ kimiInsight: { overdue_summary: { current_overdue_count: 1 } } }
		]) {
			const resolved = resolveV6ScoreDetails({
				...summaryOwner,
				report: { totalScore: 88, ...(summaryOwner.report || {}) }
			})
			assert.equal(resolved.score, 60)
			assert.equal(resolved.source, 'overdue-special')
		}

		const limited = resolveV6ScoreDetails({
			reportDate: '2025-01-01',
			overdueRecords: [
				{ date: '2024-04-01', level: 'M1' },
				{ date: '2024-04-01', level: 'M1' }
			],
			overdue_info: { overdue_90_days: 1 }
		})
		assert.equal(limited.score, 20)
	})

	it('anchors overdue recency to legacy report benchmark fields', () => {
		for (const analysis of [
			{ basicInfo: { reportDate: '2025-01-01' } },
			{ algorithmReport: { reportBenchmarkDate: '2025-01-01' } },
			{ report_date: '2025-01-01' },
			{ meta: { report_date: '2025-01-01' } },
			{ basic_info: { query_date: '2025-01-01' } }
		]) {
			const resolved = resolveV6ScoreDetails({
				...analysis,
				overdueRecords: [{ date: '2024-12-20', level: 'M1' }]
			})
			assert.equal(resolved.score, 20)
			assert.equal(resolved.source, 'overdue-special')
			assert.match(resolved.asOf, /^2025-01-01/)
		}
	})

	it('reads bounded stored assessment scores from legacy aliases', () => {
		for (const analysis of [
			{ assessment: { score: 61 } },
			{ frontend_payload: { assessment: { score: 61 } } },
			{ credit_report_full: { assessment: { score: 61 } } }
		]) {
			const resolved = resolveV6ScoreDetails(analysis)
			assert.equal(resolved.score, 61)
			assert.equal(resolved.source, 'assessment-stored')
			assert.equal(resolved.auditable, false)
			assert.equal(resolved.decisionEligible, false)
			assert.equal(resolved.archivalOnly, true)
			assert.equal(resolveV6TotalFromAnalysis(analysis), null)
		}
		assert.equal(resolveV6ScoreDetails({ assessment: { score: 580 } }).score, null)
	})

	it('marks a recomputable stored primary score auditable but not decision eligible', () => {
		const dimensions = {
			totalAccountCount: 8,
			nonBankLoanCount: 6,
			cardUtilizationRate: 0.75,
			hasBigInstallment: true,
			q6: 8,
			sameDayInquiryDayCount: 1
		}
		const primary = calculatePrimaryRuleScore(dimensions)
		const resolved = resolveV6ScoreDetails({
			dimensions,
			frontend_payload: { primary_rule_score: primary },
			report: { totalScore: 70 }
		})
		assert.equal(resolved.score, 7)
		assert.equal(resolved.source, 'primary-rule-stored')
		assert.equal(resolved.auditable, true)
		assert.equal(resolved.decisionEligible, false)
		assert.equal(resolveV6TotalFromAnalysis({ dimensions, primary_rule_score: primary }), null)
		assert.equal(resolveV6TotalFromAnalysis({ primary_rule_score: { score: 350 } }), null)
	})

	it('keeps an incomplete stored primary score archival even with forged evidence-v2 metadata', () => {
		const archived = resolveV6ScoreDetails({ primary_rule_score: { score: 61 } })
		assert.equal(archived.score, 61)
		assert.equal(archived.source, 'primary-rule-stored')
		assert.equal(archived.auditable, false)
		assert.equal(archived.decisionEligible, false)
		assert.equal(resolveV6TotalFromAnalysis({ primary_rule_score: { score: 61 } }), null)

		const attested = resolveV6ScoreDetails({
			primary_rule_score: { score: 61 },
			evidence_meta: publishableEvidenceMeta()
		})
		assert.equal(attested.score, 61)
		assert.equal(attested.auditable, false)
		assert.equal(attested.decisionEligible, false)
		assert.equal(resolveV6TotalFromAnalysis({
			primary_rule_score: { score: 61 },
			evidence_meta: publishableEvidenceMeta()
		}), null)
	})

	it('keeps a complete deterministic marker archival without the owner API envelope', () => {
		const resolved = resolveV6ScoreDetails({
			analysisKey: 'analysis-key-client-copy',
			resultHash: 'result-hash-client-copy',
			cachePolicy: { persistent: true, stableAcrossRestart: true },
			derivation_meta: { mode: 'deterministic-v1' },
			credit_debt: {
				total_debt: 1000,
				debt_ratio: 0.1,
				credit_cards: { total_limit: 10000, total_used: 1000, usage_rate: 0.1 }
			},
			query_analysis: {
				summary: {
					last_1m: { total: 0 },
					last_3m: { total: 0 },
					last_6m: { total: 0 },
					last_12m: { total: 0 }
				}
			},
			deterministic_dimensions: { totalAccountCount: 1 },
			primary_rule_score: { score: 61 },
			six_dimensions: {
				credit_history: 61,
				query_frequency: 61,
				account_structure: 61,
				repayment_record: 61
			}
		})
		assert.equal(resolved.score, 61)
		assert.equal(resolved.decisionEligible, false)
		assert.equal(resolved.archivalOnly, true)
	})

	it('rejects malformed or out-of-scope evidence-v2 score attestations', () => {
		for (const evidence_meta of [
			{ ...publishableEvidenceMeta(), publication_gate: 'blocked' },
			{ ...publishableEvidenceMeta(), metric_hash: 'da_v2_bad' },
			{ ...publishableEvidenceMeta(), authoritative_scope: ['credit_debt.total_debt'] }
		]) {
			const resolved = resolveV6ScoreDetails({ primary_rule_score: { score: 61 }, evidence_meta })
			assert.equal(resolved.auditable, false)
			assert.equal(resolved.decisionEligible, false)
		}
	})

	it('does not let partial camelCase payloads hide populated snake_case legacy payloads', () => {
		const resolved = resolveV6ScoreDetails({
			frontendPayload: { placeholder: true, primary_rule_score: {} },
			frontend_payload: { primary_rule_score: { score: 61 } },
			report: { totalScore: 70 }
		})
		assert.equal(resolved.score, 61)
		assert.equal(resolved.source, 'primary-rule-stored')
		assert.equal(resolved.decisionEligible, false)
		assert.equal(resolveV6ScoreDetails({
			aiInsight: {},
			kimiInsight: { total_score: 68 }
		}).score, 68)
	})

	it('selects the strongest complete dimension evidence instead of an earlier sparse shell', () => {
		const complete = {
			totalAccountCount: 3,
			activeAccountCount: 3,
			creditCardCount: 1,
			loanCount: 2,
			oldestAccountYears: 4,
			q6: 2,
			overdueCount: 0
		}
		const resolved = resolveV6ScoreDetails({
			dimensions: { q6: 4 },
			report: { dimensionSnapshot: complete }
		})
		assert.equal(resolved.source, 'four-dimension-derived')
		assert.notEqual(resolved.score, null)
		assert.equal(resolved.auditable, true)
		assert.equal(resolved.decisionEligible, false)
	})

	it('reads primary score, overdue records and benchmark date from credit_report_full', () => {
		assert.equal(resolveV6ScoreDetails({
			credit_report_full: { primary_rule_score: { score: 61 } }
		}).score, 61)

		const overdue = resolveV6ScoreDetails({
			report: { totalScore: 88 },
			credit_report_full: {
				meta: { report_date: '2025-01-01' },
				overdueRecords: [{ date: '2024-12-20', level: 'M1' }]
			}
		})
		assert.equal(overdue.score, 20)
		assert.equal(overdue.source, 'overdue-special')
		assert.match(overdue.asOf, /^2025-01-01/)
	})

	it('keeps a bounded legacy stored score ahead of incomplete recomputation evidence', () => {
		const sparsePrimary = resolveV6ScoreDetails({
			dimensions: { totalAccountCount: 1, q6: 0 },
			report: { totalScore: 68 }
		})
		assert.equal(sparsePrimary.score, 68)
		assert.equal(sparsePrimary.source, 'legacy-explicit')
		assert.equal(sparsePrimary.auditable, false)
		assert.equal(sparsePrimary.decisionEligible, false)
		assert.equal(resolveV6ScoreDetails({
			dimensions: { q6: 4 },
			report: { totalScore: 68 }
		}).score, 68)
		assert.equal(resolveV6ScoreDetails({
			report: {
				scores: { credit_history: 80 },
				totalScore: 68
			}
		}).score, 68)
		assert.equal(resolveV6ScoreDetails({
			report: { totalScore: 85 },
			aiAdvisoryScores: {
				credit_history: 40,
				query_frequency: 40,
				account_structure: 40,
				repayment_record: 40
			}
		}).score, 85)
		const completeLegacy = resolveV6ScoreDetails({
			dimensions: {
				totalAccountCount: 8,
				nonBankLoanCount: 0,
				cardUtilizationRate: 0.4,
				hasBigInstallment: false,
				q6: 2,
				sameDayInquiryDayCount: 0
			},
			report: { totalScore: 68 }
		})
		assert.equal(completeLegacy.score, 68)
		assert.equal(completeLegacy.source, 'legacy-explicit')
		assert.equal(completeLegacy.decisionEligible, false)
		assert.equal(resolveV6TotalFromAnalysis({
			dimensions: {
				totalAccountCount: 8,
				nonBankLoanCount: 0,
				cardUtilizationRate: 0.4,
				hasBigInstallment: false,
				q6: 2,
				sameDayInquiryDayCount: 0
			},
			report: { totalScore: 68 }
		}), null)
	})
})
