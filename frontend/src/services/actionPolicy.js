import { statusExplicitlyDeniesOverdue, statusIndicatesOverdue } from '../utils/creditStatus.js'
import {
	resolveDecisionHighRiskCount,
	resolveDecisionOverdue,
	resolveDecisionQueryCounts
} from './decisionMetrics.js'
import { strictNonNegativeIntegerOrNull, strictNonNegativeNumberOrNull } from '../utils/strictNumber.js'

export const ACTION_THRESHOLDS = {
	SCORE_ADVISOR: 70,
	QUERY6M_ADVISOR: 8
}

export const ACTION_KEYS = {
	UPLOAD: 'upload',
	RISK_FIX: 'risk-fix',
	ADVISOR: 'advisor',
	MATCH: 'match'
}

export const toSafeNumber = (val, def = 0) => {
	const parsed = strictNonNegativeNumberOrNull(val)
	return parsed == null ? def : parsed
}

const objectValue = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const firstFiniteValue = (...values) => {
	for (const value of values) {
		if (value === '' || value == null) continue
		const number = Number(value)
		if (Number.isFinite(number)) return number
	}
	return null
}
const maxFiniteNonNegative = (...values) => {
	const numbers = []
	const visit = (value) => {
		if (Array.isArray(value)) {
			value.forEach(visit)
			return
		}
		if (value === '' || value == null) return
		const number = Number(value)
		if (Number.isFinite(number) && number >= 0) numbers.push(number)
	}
	values.forEach(visit)
	return numbers.length ? Math.max(...numbers) : null
}

const isEffectiveOverdueRecord = (record) => {
	if (!record || typeof record !== 'object' || Array.isArray(record)) return false
	const days = Number(record.days ?? record.overdueDays ?? record.overdue_days)
	if (Number.isFinite(days) && days > 0) return true
	if (record.current === true || record.isOverdue === true || record.has_overdue === true) return true
	const status = String(record.status || record.account_status || '')
	if (statusIndicatesOverdue(status)) return true
	const level = String(record.level ?? record.overdueLevel ?? record.overdue_level ?? '').trim().toUpperCase()
	if (level === 'NONE' || level === '正常') return false
	if (/^M[1-9]\+?$/.test(level) || statusIndicatesOverdue(level)) return true
	if (statusExplicitlyDeniesOverdue(status)) return false
	return [
		'date', 'overdueDate', 'overdue_date', 'bank', 'institution',
		'amount', 'overdueAmount', 'overdue_amount', 'accountType', 'account_type'
	].some((key) => record[key] !== undefined && record[key] !== null && String(record[key]).trim() !== '')
}

export const resolveHighRiskCount = (analysisData) => {
	const frontends = [
		objectValue(analysisData?.frontendPayload),
		objectValue(analysisData?.frontend_payload)
	]
	const summaryCounts = frontends
		.map((fp) => firstFiniteValue(fp.risk_summary?.high, fp.riskSummary?.high))
		.filter((value) => value != null)
	const hitCandidates = [
		analysisData?.creditReportV2?.risk_analysis?.risk_hits,
		analysisData?.credit_report_full?.risk_analysis?.risk_hits,
		analysisData?.credit_report_v2?.risk_analysis?.risk_hits,
		...frontends.map((fp) => fp.risk_cards)
	]
	const hitCounts = hitCandidates
		.filter((items) => Array.isArray(items) && items.length > 0)
		.map((hits) => hits.reduce((high, hit) => {
			const level = String(hit?.level || '')
			const sev = toSafeNumber(hit?.severity, level === '风险' ? 4 : 1)
			return high + ((level === '风险' || sev >= 4) ? 1 : 0)
		}, 0))
	return Math.max(0, Math.round(maxFiniteNonNegative(summaryCounts, hitCounts) ?? 0))
}

export const resolveQuery6mCount = (analysisData) => {
	// 主数据路径（按优先级）：
	//   1. dimensions.q6 — 本地 enrichDimensions 计算的权威近6月查询数
	//   2. queryRecords.recent6Month — 旧版兼容
	//   3. creditReportV2.query_analysis.summary.recent_6_month — 服务端 V2
	//   4. frontendPayload.dimensions.q6 — 前端负载
	const val = maxFiniteNonNegative(
		analysisData?.dimensions?.q6,
		analysisData?.dimensionSnapshot?.q6,
		analysisData?.report?.dimensions?.q6,
		analysisData?.report?.dimensionSnapshot?.q6,
		analysisData?.queryRecords?.recent6Month,
		analysisData?.report?.queryStats?.recent_6_month,
		analysisData?.creditReportV2?.query_analysis?.summary?.recent_6_month,
		analysisData?.creditReportV2?.query_records?.summary?.recent_6_month,
		analysisData?.credit_report_full?.query_analysis?.summary?.recent_6_month,
		analysisData?.credit_report_v2?.query_analysis?.summary?.recent_6_month,
		analysisData?.frontendPayload?.dimensions?.q6,
		analysisData?.frontendPayload?.query_summary?.q6,
		analysisData?.frontend_payload?.dimensions?.q6,
		analysisData?.frontend_payload?.query_summary?.q6
	)
	return Math.max(0, Math.round(toSafeNumber(val)))
}

export const resolveOverdueAccountCount = (analysisData) => {
	const overdueSums = [
		analysisData?.report?.overdueSummary,
		analysisData?.report?.overdue_summary,
		analysisData?.aiInsight?.overdue_summary,
		analysisData?.kimiInsight?.overdue_summary,
		analysisData?.frontendPayload?.overdue_summary,
		analysisData?.frontend_payload?.overdue_summary
	].map(objectValue)
	const overdueRecords = [
		analysisData?.overdueRecords,
		analysisData?.overdue_records,
		analysisData?.report?.overdueRecords,
		analysisData?.report?.overdue_records,
		analysisData?.creditReportV2?.overdueRecords,
		analysisData?.creditReportV2?.overdue_records,
		analysisData?.creditReportV2?.overdue_info?.records,
		analysisData?.creditReportV2?.overdue_info?.details,
		analysisData?.credit_report_full?.overdueRecords,
		analysisData?.credit_report_full?.overdue_records,
		analysisData?.credit_report_full?.overdue_info?.records,
		analysisData?.credit_report_full?.overdue_info?.details,
		analysisData?.credit_report_v2?.overdueRecords,
		analysisData?.credit_report_v2?.overdue_records,
		analysisData?.credit_report_v2?.overdue_info?.records,
		analysisData?.credit_report_v2?.overdue_info?.details,
		analysisData?.frontendPayload?.overdueRecords,
		analysisData?.frontendPayload?.overdue_records,
		analysisData?.frontend_payload?.overdueRecords,
		analysisData?.frontend_payload?.overdue_records,
		analysisData?.aiInsight?.overdue_records,
		analysisData?.kimiInsight?.overdue_records
	]
	const recordCounts = overdueRecords
		.filter((items) => Array.isArray(items) && items.length > 0)
		.map((items) => items.filter(isEffectiveOverdueRecord).length)
	const count = maxFiniteNonNegative(
		...overdueSums.flatMap((summary) => [
			summary.total_overdue_count,
			summary.current_overdue_count,
			summary.overdueCount
		]),
		analysisData?.dimensions?.overdueCount,
		analysisData?.report?.dimensions?.overdueCount,
		recordCounts,
		analysisData?.algorithmReport?.dimensions?.overdueCount
	)
	return Math.max(0, Math.round(toSafeNumber(count)))
}

/** Decision consumers must use these wrappers instead of interpreting a
 * compatibility number as proof that a zero is complete and trustworthy. */
export const resolveQuery6mMetric = (analysisData, trustedProjection = null, expectedReportId = '') => {
	const resolved = resolveDecisionQueryCounts(analysisData, trustedProjection, expectedReportId)
	return {
		value: resolved.q6Known === true ? resolved.q6 : null,
		known: resolved.q6Known === true,
		source: resolved.source
	}
}

export const resolveOverdueAccountMetric = (analysisData, trustedProjection = null, expectedReportId = '') => {
	const resolved = resolveDecisionOverdue(analysisData, trustedProjection, expectedReportId)
	return {
		value: resolved.overdueKnown === true ? resolved.overdueCount : null,
		known: resolved.overdueKnown === true,
		source: resolved.source
	}
}

export const resolveHighRiskMetric = (analysisData, trustedProjection = null, expectedReportId = '') => {
	const resolved = resolveDecisionHighRiskCount(analysisData, trustedProjection, expectedReportId)
	return {
		value: resolved.known === true ? resolved.value : null,
		known: resolved.known === true,
		source: resolved.source
	}
}

export const resolveActionKey = ({
	hasReport,
	score,
	highRiskCount,
	overdueAccountCount,
	query6mCount,
	scoreKnown = false,
	highRiskKnown = false,
	overdueKnown = false,
	queryKnown = false
}) => {
	if (!hasReport) return ACTION_KEYS.UPLOAD
	const parsedScore = strictNonNegativeNumberOrNull(score)
	const parsedHighRisk = strictNonNegativeIntegerOrNull(highRiskCount)
	const parsedOverdue = strictNonNegativeIntegerOrNull(overdueAccountCount)
	const parsedQuery = strictNonNegativeIntegerOrNull(query6mCount)
	if (parsedHighRisk > 0 || parsedOverdue > 0) return ACTION_KEYS.RISK_FIX
	if (
		scoreKnown !== true || highRiskKnown !== true || overdueKnown !== true || queryKnown !== true ||
		parsedScore == null || parsedScore > 100 || parsedHighRisk == null || parsedOverdue == null || parsedQuery == null
	) {
		return ACTION_KEYS.ADVISOR
	}
	if (
		parsedScore < ACTION_THRESHOLDS.SCORE_ADVISOR ||
		parsedQuery > ACTION_THRESHOLDS.QUERY6M_ADVISOR
	) {
		return ACTION_KEYS.ADVISOR
	}
	return ACTION_KEYS.MATCH
}
