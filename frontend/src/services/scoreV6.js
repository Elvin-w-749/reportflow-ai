/**
 * 综合分解析：与 detail.uvue / serverAnalyzeMapper 同口径。
 * 优先由四维分加权 + 逾期上限计算；否则回退 report / aiInsight 等已存总分。
 */
import {
	scoreFourDimensions,
	composeFourDimTotal,
	calculatePrimaryRuleScore
} from './creditAlgorithmCore.js'
import { resolveOverdueScore } from './overdueScore.js'
import { isAuthoritativeServerAnalysis } from './authoritativeAnalysis.js'
import { trustedDecisionValue } from './decisionTrust.js'
import { strictFiniteNumberOrNull } from '../utils/strictNumber.js'

function num(v) {
	return strictFiniteNumberOrNull(v)
}

function boundedScore(v) {
	const n = num(v)
	return n != null && n >= 0 && n <= 100 ? Math.round(n) : null
}

function resolvedScore({
	score = null,
	source = 'unavailable',
	result = null,
	dimensions = null,
	four = null,
	asOf = null,
	auditable = false,
	decisionEligible = false
} = {}) {
	return {
		score,
		source,
		result,
		dimensions,
		four,
		asOf,
		auditable: auditable === true,
		decisionEligible: auditable === true && decisionEligible === true,
		archivalOnly: score != null && !(auditable === true && decisionEligible === true)
	}
}

function obj(v) {
	return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
}

function mergeCompatObjects(fallbackValue, preferredValue) {
	const fallback = obj(fallbackValue)
	const preferred = obj(preferredValue)
	const merged = { ...fallback }
	for (const [key, value] of Object.entries(preferred)) {
		const previous = merged[key]
		if (value && typeof value === 'object' && !Array.isArray(value) && previous && typeof previous === 'object' && !Array.isArray(previous)) {
			merged[key] = mergeCompatObjects(previous, value)
			continue
		}
		if (Array.isArray(value) && value.length === 0 && Array.isArray(previous) && previous.length > 0) continue
		if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0 && previous && typeof previous === 'object') continue
		if ((value === '' || value == null) && previous !== '' && previous != null) continue
		merged[key] = value
	}
	return merged
}

function pickDimScore(scores, key) {
	if (!scores || typeof scores !== 'object') return null
	const zh = {
		credit_history: '信用历史',
		query_frequency: '查询频率',
		account_structure: '账户结构',
		repayment_record: '还款记录'
	}[key]
	const raw = scores[key] ?? scores[zh]
	return boundedScore(raw)
}

function fourFromScores(scores) {
	if (!scores) return null
	const four = {
		credit_history: pickDimScore(scores, 'credit_history'),
		query_frequency: pickDimScore(scores, 'query_frequency'),
		account_structure: pickDimScore(scores, 'account_structure'),
		repayment_record: pickDimScore(scores, 'repayment_record')
	}
	const isComplete = Object.values(four).every((v) => v != null)
	return isComplete ? four : null
}

function composedFromBreakdown(rows, dim) {
	if (!Array.isArray(rows) || !rows.length) return null
	const four = {}
	for (const r of rows) {
		const v = boundedScore(r?.value)
		if (v == null || !r?.key) continue
		four[r.key] = v
	}
	if (!['credit_history', 'query_frequency', 'account_structure', 'repayment_record'].every((key) => four[key] != null)) return null
	return composeFourDimTotal(four, dim)
}

function hasScorableDimensions(dim) {
	if (!dim) return false
	const numericSignal = [
		dim.totalAccountCount, dim.q1, dim.q3, dim.q6, dim.q12,
		dim.overdueCount, dim.m1Count, dim.m2Count, dim.m3Count
	].some((value) => {
		const parsed = strictFiniteNumberOrNull(value)
		return parsed != null && parsed > 0
	})
	return numericSignal || dim.hasLianSan === true || dim.hasLeiLiu === true
}

function hasReadableFourDimensions(dim) {
	if (!dim || typeof dim !== 'object' || Array.isArray(dim)) return false
	return [
		'credit_history',
		'query_frequency',
		'account_structure',
		'repayment_record',
		'信用历史',
		'查询频率',
		'账户结构',
		'还款记录'
	].some((key) => num(dim[key]) != null)
}

const PRIMARY_RULE_NUMERIC_KEYS = [
	'totalAccountCount',
	'nonBankLoanCount',
	'cardUtilizationRate',
	'q6',
	'sameDayInquiryDayCount'
]

export function hasPrimaryRuleEvidence(dim) {
	if (!dim || typeof dim !== 'object' || Array.isArray(dim)) return false
	const numericEvidence = PRIMARY_RULE_NUMERIC_KEYS
		.filter((key) => Object.prototype.hasOwnProperty.call(dim, key) && dim[key] !== '')
		.map((key) => ({ key, value: num(dim[key]) }))
		.filter((item) => item.value != null && item.value >= 0)
	const hasInvalidNumeric = PRIMARY_RULE_NUMERIC_KEYS.some((key) => {
		if (!Object.prototype.hasOwnProperty.call(dim, key) || dim[key] === '') return false
		const value = num(dim[key])
		return value == null || value < 0
	})
	if (hasInvalidNumeric) return false
	const hasMeaningfulSignal = numericEvidence.some((item) => item.value > 0)
	// 主评分是“六组规则未命中即按 0 处理”的扣减制。只有五个数值口径和
	// 大额分期布尔口径全部明确时，才能安全把某项缺失解释为“未命中”。
	return (
		numericEvidence.length === PRIMARY_RULE_NUMERIC_KEYS.length &&
		typeof dim.hasBigInstallment === 'boolean' &&
		(hasMeaningfulSignal || dim.hasBigInstallment === true)
	)
}

function primaryMetricsAsDimensions(primary, fallbackDimensions) {
	const metrics = obj(primary?.metrics)
	const totalAccountCount = num(metrics.totalAccountCount ?? metrics.totalAccounts)
	const nonBankLoanCount = num(metrics.nonBankLoanCount ?? metrics.activeNonBankLoanCount)
	const cardUtilizationRate = num(metrics.cardUtilizationRate ?? metrics.cardUsageRate)
	const q6 = num(metrics.q6 ?? metrics.query6m)
	const sameDayInquiryDayCount = num(metrics.sameDayInquiryDayCount) ?? (
		typeof metrics.sameDayTriggered === 'boolean' ? (metrics.sameDayTriggered ? 1 : 0) : null
	)
	const hasBigInstallment = typeof metrics.hasBigInstallment === 'boolean'
		? metrics.hasBigInstallment
		: (num(metrics.bigInstallmentTotal) != null ? num(metrics.bigInstallmentTotal) > 0 : null)
	const fromMetrics = {
		totalAccountCount,
		nonBankLoanCount,
		cardUtilizationRate,
		hasBigInstallment,
		q6,
		sameDayInquiryDayCount
	}
	return hasPrimaryRuleEvidence(fromMetrics) ? fromMetrics : fallbackDimensions
}

function hasAuditablePrimaryResult(primary, fallbackDimensions) {
	const score = boundedScore(primary?.score)
	const baseScore = boundedScore(primary?.baseScore ?? primary?.base_score)
	const totalDeduction = num(primary?.totalDeduction ?? primary?.total_deduction)
	const deductions = Array.isArray(primary?.deductions) ? primary.deductions : null
	const dimensions = primaryMetricsAsDimensions(primary, fallbackDimensions)
	if (
		score == null ||
		baseScore == null ||
		totalDeduction == null ||
		totalDeduction < 0 ||
		!deductions ||
		!hasPrimaryRuleEvidence(dimensions)
	) return false
	const recalculated = calculatePrimaryRuleScore(dimensions)
	if (
		boundedScore(recalculated.score) !== score ||
		boundedScore(recalculated.baseScore) !== baseScore ||
		Math.round(num(recalculated.totalDeduction) ?? -1) !== Math.round(totalDeduction)
	) return false
	const expectedTrace = recalculated.deductions.map((item) => `${item.code}:${Number(item.points)}`)
	const storedTrace = deductions.map((item) => `${String(item?.code || '')}:${Number(item?.points)}`)
	return expectedTrace.length === storedTrace.length && expectedTrace.every((item, index) => item === storedTrace[index])
}

function hasAuditableOverdueResult(result) {
	const score = boundedScore(result?.score)
	const base = boundedScore(result?.base)
	const totalDeduction = num(result?.totalDeduction ?? result?.total_deduction)
	const deductions = Array.isArray(result?.deductions) ? result.deductions : null
	if (score == null || base == null || totalDeduction == null || totalDeduction < 0 || !deductions?.length) return false
	let tracedDeduction = 0
	for (const item of deductions) {
		const points = num(item?.points)
		const count = num(item?.count) ?? 1
		if (
			points == null ||
			points < 0 ||
			count <= 0 ||
			!String(item?.level || '').trim() ||
			!String(item?.bucket || '').trim()
		) return false
		tracedDeduction += points * count
	}
	return (
		Math.round(tracedDeduction) === Math.round(totalDeduction) &&
		Math.max(0, Math.min(100, Math.round(base - totalDeduction))) === score
	)
}

function hasFourDimensionInputEvidence(dim) {
	if (!dim || typeof dim !== 'object' || Array.isArray(dim)) return false
	const nonNegativeOwnNumber = (key) => (
		Object.prototype.hasOwnProperty.call(dim, key) &&
		num(dim[key]) != null &&
		num(dim[key]) >= 0
	)
	const hasAccountContext = nonNegativeOwnNumber('totalAccountCount')
	const hasQueryContext = ['q1', 'q3', 'q6', 'q12'].some(nonNegativeOwnNumber)
	const hasRepaymentContext = ['overdueCount', 'm1Count', 'm2Count', 'm3Count'].some(nonNegativeOwnNumber)
	const hasStructureContext = [
		'creditCardCount',
		'loanCount',
		'loanAccountCount',
		'nonBankLoanCount',
		'activeAccountCount'
	].some(nonNegativeOwnNumber)
	const hasHistoryContext = [
		'oldestAccountYears',
		'avgAccountYears',
		'activeAccountCount',
		'settledAccountCount'
	].some(nonNegativeOwnNumber)
	return hasAccountContext && hasQueryContext && hasRepaymentContext && hasStructureContext && hasHistoryContext
}

function selectDimensions(analysisData, frontend, cv2) {
	const candidates = [
		analysisData.dimensions,
		analysisData.dimensionSnapshot,
		analysisData.report?.dimensions,
		analysisData.report?.dimensionSnapshot,
		cv2.dimensions,
		cv2.dimensionSnapshot,
		frontend.dimensions,
		frontend.dimensionSnapshot
	].filter((item) => item && typeof item === 'object' && !Array.isArray(item))
	const evidenceRank = (item) => {
		if (hasPrimaryRuleEvidence(item)) return 5
		if (hasFourDimensionInputEvidence(item)) return 4
		if (hasReadableFourDimensions(item)) return 3
		if (hasScorableDimensions(item)) return 2
		return Object.keys(item).length > 0 ? 1 : 0
	}
	let selected = null
	let selectedRank = 0
	for (const item of candidates) {
		const rank = evidenceRank(item)
		if (rank > selectedRank) {
			selected = item
			selectedRank = rank
		}
	}
	return selected
}

function evaluationAnchor(analysisData, frontend, cv2) {
	const values = [
		analysisData.reportDate,
		analysisData.report_date,
		analysisData.queryDate,
		analysisData.query_date,
		analysisData.meta?.reportDate,
		analysisData.meta?.report_date,
		analysisData.meta?.queryDate,
		analysisData.meta?.query_date,
		analysisData.basicInfo?.reportDate,
		analysisData.basicInfo?.queryDate,
		analysisData.basic_info?.report_date,
		analysisData.basic_info?.query_date,
		analysisData.algorithmReport?.reportBenchmarkDate,
		analysisData.algorithmReport?.report_benchmark_date,
		analysisData.report?.reportDate,
		analysisData.report?.report_date,
		analysisData.report?.queryDate,
		analysisData.report?.query_date,
		analysisData.report?.date,
		analysisData.report?.basicInfo?.reportDate,
		analysisData.report?.basic_info?.report_date,
		cv2.meta?.report_date,
		cv2.meta?.query_date,
		cv2.basicInfo?.reportDate,
		cv2.basic_info?.report_date,
		frontend.basicInfo?.reportDate,
		frontend.basic_info?.report_date,
		analysisData.evaluationTime,
		analysisData.evaluatedAt,
		analysisData.analysisCompletedAt,
		analysisData.completedAt,
		analysisData.report?.evaluationTime,
		analysisData.report?.evaluatedAt,
		analysisData.createdAt
	]
	for (const value of values) {
		if (!value) continue
		const date = value instanceof Date ? value : new Date(value)
		if (!Number.isNaN(date.getTime())) return date
	}
	return null
}

/**
 * 从 analysisData 解析综合分与单一来源元数据。
 * Detail 等解释界面必须复用此结果，避免总分与“分数来源”各自走一套字段判断。
 * @param {Object|null|undefined} analysisData
 * @returns {{score:number|null, source:string, result:object|null, dimensions:object|null, four:object|null, auditable:boolean, decisionEligible:boolean, archivalOnly:boolean}}
 */
function resolveArchivalV6ScoreDetails(analysisData) {
	if (!analysisData) return resolvedScore()

	const frontend = mergeCompatObjects(analysisData.frontend_payload, analysisData.frontendPayload)
	const cv2 = mergeCompatObjects(
		mergeCompatObjects(
			mergeCompatObjects(analysisData.credit_report_full, analysisData.credit_report_v2),
			analysisData.creditReportV2
		),
		analysisData.cv2
	)
	const dim = selectDimensions(analysisData, frontend, cv2)
	const anchorDate = evaluationAnchor(analysisData, frontend, cv2)

	if (isAuthoritativeServerAnalysis(analysisData)) {
		const authoritativePrimary = [
			analysisData.primary_rule_score,
			cv2.primary_rule_score,
			frontend.primary_rule_score,
			analysisData.assessment?.primary_rule_score
		].map(obj).filter((item) => Object.keys(item).length > 0)
		for (const primary of authoritativePrimary) {
			const score = boundedScore(primary.score)
			if (score != null) {
				const auditable = hasAuditablePrimaryResult(primary, dim)
				return resolvedScore({
					score,
					source: 'authoritative-primary-rule',
					result: primary,
					dimensions: dim,
					four: null,
					asOf: anchorDate ? anchorDate.toISOString() : null,
					auditable
				})
			}
		}
		return resolvedScore({
			score: null,
			source: 'authoritative-incomplete',
			result: null,
			dimensions: dim,
			four: null,
			asOf: anchorDate ? anchorDate.toISOString() : null
		})
	}

	// 最高优先级：逾期专项规则（默认基准 70 分，按 recency+等级扣分）。
	// 只要存在逾期信号即作为综合分权威值，覆盖四维加权 / 主评分框架结果。
	const overdue = resolveOverdueScore(analysisData, anchorDate || undefined)
	const overdueScore = boundedScore(overdue && overdue.score)
	if (overdueScore != null) {
		// Arithmetic consistency only proves that the stored deductions add up;
		// it does not prove the overdue rows came from the official report. Legacy
		// aiInsight/kimiInsight/dimensions therefore remain archival unless the
		// complete server deterministic contract is present.
		const auditable = hasAuditableOverdueResult(overdue) && isAuthoritativeServerAnalysis(analysisData)
		return resolvedScore({
			score: overdueScore,
			source: 'overdue-special',
			result: overdue,
			dimensions: dim,
			four: null,
			asOf: anchorDate ? anchorDate.toISOString() : null,
			auditable
		})
	}

	const assessments = [
		cv2.assessment,
		obj(frontend.cv2).assessment,
		frontend.assessment,
		analysisData.assessment
	].map(obj).filter((item) => Object.keys(item).length > 0)

	// A. 主评分框架：优先读取已算主分
	const primaryCandidates = [
		analysisData.primary_rule_score,
		analysisData.report?.primaryRuleScore,
		analysisData.report?.primary_rule_score,
		cv2.primary_rule_score,
		frontend.primary_rule_score,
		...assessments.map((item) => item.primary_rule_score)
	].map(obj).filter((item) => Object.keys(item).length > 0)
	for (const primary of primaryCandidates) {
		const score = boundedScore(primary.score)
		if (score != null) {
			const auditable = hasAuditablePrimaryResult(primary, dim)
			return resolvedScore({ score, source: 'primary-rule-stored', result: primary, dimensions: dim, four: null, auditable })
		}
	}

	// B. 服务端旧版 assessment.score 是已保存的明确综合分；必须先于本地复算读取。
	for (const assessment of assessments) {
		const score = boundedScore(assessment.score)
		if (score != null) return resolvedScore({ score, source: 'assessment-stored', result: assessment, dimensions: dim, four: null })
	}

	// C. 旧版报告已经保存的综合分必须稳定复现，不能被当前客户端规则重算改写。
	const r = analysisData.report || {}
	const ai = mergeCompatObjects(analysisData.kimiInsight, analysisData.aiInsight)
	const explicit = [
		r.totalScore,
		r.adjustedTotalScore,
		ai.total_score,
		analysisData.totalScore
	].map(boundedScore).find((score) => score != null) ?? null
	if (explicit != null) return resolvedScore({ score: explicit, source: 'legacy-explicit', result: null, dimensions: dim, four: null })

	// D. 仅当报告没有保存总分、且完整保存了全部主评分口径时，才允许本地重算。
	if (hasPrimaryRuleEvidence(dim)) {
		const calc = calculatePrimaryRuleScore(dim)
		const score = boundedScore(calc && calc.score)
		if (score != null) {
			const result = {
				...calc,
				metrics: {
					totalAccounts: num(dim.totalAccountCount),
					activeNonBankLoanCount: num(dim.nonBankLoanCount),
					cardUsageRate: num(dim.cardUtilizationRate),
					bigInstallmentTotal: dim.hasBigInstallment ? 1 : 0,
					q6: num(dim.q6),
					sameDayTriggered: !!num(dim.sameDayInquiryDayCount)
				}
			}
			return resolvedScore({ score, source: 'primary-rule-local', result, dimensions: dim, four: null, auditable: true })
		}
	}

	// E. 仅在没有保存最终综合分时读取完整四维构成。
	for (const assessment of assessments) {
		const breakdown = assessment.score_breakdown || assessment.scoreBreakdown
		const fromBreakdown = composedFromBreakdown(breakdown, dim)
		const score = boundedScore(fromBreakdown)
		if (score != null) {
			const four = {}
			for (const row of Array.isArray(breakdown) ? breakdown : []) {
				const value = boundedScore(row?.value)
				if (row?.key && value != null) four[row.key] = value
			}
			return resolvedScore({ score, source: 'four-dimension-breakdown', result: assessment, dimensions: dim, four })
		}
	}

	const scoreSources = [
		analysisData.report?.scores,
		analysisData.scores,
		analysisData.aiInsight?.six_dimensions,
		analysisData.kimiInsight?.six_dimensions,
		frontend.scores,
		frontend.six_dimensions
	]

	for (const src of scoreSources) {
		const four = fourFromScores(src)
		if (four) {
			const composed = composeFourDimTotal(four, dim)
			const score = boundedScore(composed)
			if (score != null) return resolvedScore({ score, source: 'four-dimension-scores', result: obj(src), dimensions: dim, four })
		}
	}

	if (hasScorableDimensions(dim) && hasFourDimensionInputEvidence(dim)) {
		const four = scoreFourDimensions(dim)
		const composed = composeFourDimTotal(four, dim)
		const score = boundedScore(composed)
		if (score != null) return resolvedScore({ score, source: 'four-dimension-derived', result: null, dimensions: dim, four, auditable: true })
	}

	for (const assessment of assessments) {
		const score = boundedScore(assessment.composed_score ?? assessment.composedScore)
		if (score != null) return resolvedScore({ score, source: 'four-dimension-composed', result: assessment, dimensions: dim, four: null })
	}

	return resolvedScore({ dimensions: dim })
}

/**
 * Resolve the archival score candidate and, separately, the owner-API decision
 * score.  Arithmetic consistency can make an archival result explainable, but
 * only reportStorage's ephemeral outer trust projection can make it eligible.
 */
export function resolveV6ScoreDetails(analysisData, trustedProjection = null, expectedReportId = '') {
	const archival = resolveArchivalV6ScoreDetails(analysisData)
	const trustedScore = boundedScore(trustedDecisionValue(trustedProjection, 'score', 'score', expectedReportId))
	if (trustedScore == null) return archival
	return resolvedScore({
		score: trustedScore,
		source: 'owner-api-decision-score',
		result: archival.result,
		dimensions: archival.dimensions,
		four: archival.four,
		asOf: archival.asOf,
		auditable: true,
		decisionEligible: true
	})
}

/**
 * 从 analysisData 解析综合分（0–100）；无可信分数时返回 null。
 */
export function resolveV6TotalFromAnalysis(analysisData, trustedProjection = null, expectedReportId = '') {
	const resolved = resolveV6ScoreDetails(analysisData, trustedProjection, expectedReportId)
	return resolved.decisionEligible ? resolved.score : null
}
