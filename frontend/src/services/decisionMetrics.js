import { statusExplicitlyDeniesOverdue, statusIndicatesOverdue } from '../utils/creditStatus.js'
import { trustedDecisionValue } from './decisionTrust.js'
import {
	strictFiniteNumberOrNull,
	strictNonNegativeIntegerOrNull,
	strictNonNegativeNumberOrNull
} from '../utils/strictNumber.js'

const objectValue = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== '')
const numberOrNull = strictFiniteNumberOrNull
const nonNegativeOrNull = strictNonNegativeNumberOrNull
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(objectValue(value), key)

const unavailable = (source = 'unavailable') => ({
	value: null,
	decisionEligible: false,
	known: false,
	source
})

/**
 * `debtRatio` is not a metric in the production evidence-v2 contract. The
 * signed ledger currently publishes totalDebt and cardUtilization, but no
 * approved denominator for a generic debt ratio. Hash-looking compact meta,
 * legacy dimensions, and caller-injected metrics therefore stay archival.
 */
const trustedNonNegative = (projection, flagKey, valueKey = flagKey, expectedReportId = '') => (
	nonNegativeOrNull(trustedDecisionValue(projection, flagKey, valueKey, expectedReportId))
)
const trustedNonNegativeInteger = (projection, flagKey, valueKey = flagKey, expectedReportId = '') => (
	strictNonNegativeIntegerOrNull(trustedDecisionValue(projection, flagKey, valueKey, expectedReportId))
)

export const resolveDecisionTotalDebt = (analysisData, trustedProjection = null, expectedReportId = '') => {
	void analysisData
	const value = trustedNonNegative(trustedProjection, 'totalDebt', 'totalDebt', expectedReportId)
	return value == null
		? unavailable('owner-api-total-debt-unverified')
		: { value, decisionEligible: true, known: true, source: 'owner-report-api' }
}

export const resolveDecisionAccountCount = (analysisData, trustedProjection = null, expectedReportId = '') => {
	void analysisData
	const value = trustedNonNegativeInteger(trustedProjection, 'accountCount', 'accountCount', expectedReportId)
	return value == null
		? unavailable('owner-api-account-count-unverified')
		: { value, decisionEligible: true, known: true, source: 'owner-report-api' }
}

export const resolveDecisionRiskLevel = (analysisData, trustedProjection = null, expectedReportId = '') => {
	void analysisData
	const raw = trustedDecisionValue(trustedProjection, 'riskLevel', 'riskLevel', expectedReportId)
	const value = typeof raw === 'string' ? raw.trim() : ''
	return ['low', 'medium-low', 'medium', 'high'].includes(value)
		? { value, decisionEligible: true, known: true, source: 'owner-report-api' }
		: unavailable('owner-api-risk-level-unverified')
}

export const resolveEvidenceBackedDebtRatio = (analysisData, trustedProjection = null, expectedReportId = '') => {
	void analysisData
	void trustedProjection
	void expectedReportId
	// Fail closed at the shared matching boundary. Older owner projections may
	// still carry `debtRatio: true`, but evidence-v2 has no approved denominator,
	// so no page or legacy cache can promote this archival metric into a rule.
	return unavailable('unsupported-metric-no-approved-denominator')
}

export const resolveDecisionQueryCounts = (analysisData, trustedProjection = null, expectedReportId = '') => {
	// Web cannot verify the private HMAC chain. Hash-shaped artifacts supplied by
	// a client are not evidence; owner-scoped matching is resolved by the API
	// from reportId -> analysisJobId -> canonical ledger.
	void analysisData
	const q1 = trustedNonNegativeInteger(trustedProjection, 'query1mCount', 'query1mCount', expectedReportId)
	const q3 = trustedNonNegativeInteger(trustedProjection, 'query3mCount', 'query3mCount', expectedReportId)
	const q6 = trustedNonNegativeInteger(trustedProjection, 'query6mCount', 'query6mCount', expectedReportId)
	const q12 = trustedNonNegativeInteger(trustedProjection, 'query12mCount', 'query12mCount', expectedReportId)
	const q1Known = q1 != null
	const q3Known = q3 != null
	const q6Known = q6 != null
	const q12Known = q12 != null
	return {
		q1,
		q3,
		q6,
		q12,
		q1Known,
		q3Known,
		q6Known,
		q12Known,
		known: q1Known && q3Known && q6Known && q12Known,
		source: q1Known || q3Known || q6Known || q12Known ? 'owner-report-api' : 'server-canonical-ledger-required'
	}
}

export const isEvidenceOverdueRecord = (record) => {
	if (!record || typeof record !== 'object' || Array.isArray(record)) return false
	const days = numberOrNull(first(record.days, record.overdueDays, record.overdue_days))
	if (days != null && days > 0) return true
	if (record.current === true || record.isOverdue === true || record.is_overdue === true || record.has_overdue === true) return true
	const status = String(first(record.status, record.account_status, record.accountStatus, ''))
	if (statusIndicatesOverdue(status)) return true
	if (statusExplicitlyDeniesOverdue(status)) return false
	const level = String(first(record.level, record.overdueLevel, record.overdue_level, '')).trim().toUpperCase()
	return /^M[1-9]\+?$/.test(level) || statusIndicatesOverdue(level)
}

const explicitBoolean = (source, ...keys) => {
	for (const key of keys) {
		if (hasOwn(source, key) && typeof source[key] === 'boolean') return source[key]
	}
	return null
}

export const resolveDecisionOverdue = (analysisData, trustedProjection = null, expectedReportId = '') => {
	const root = objectValue(analysisData)
	const recordGroups = [
		root.overdueRecords,
		root.overdue_records,
		root.report?.overdueRecords,
		root.report?.overdue_records,
		root.creditReportV2?.overdue_info?.details,
		root.credit_report_v2?.overdue_info?.details,
		root.credit_report_full?.overdue_info?.details
	].filter(Array.isArray)
	const positiveRows = recordGroups.flat().filter(isEvidenceOverdueRecord)
	const summaries = [
		root.aiInsight?.overdue_summary,
		root.kimiInsight?.overdue_summary,
		root.report?.overdueSummary,
		root.report?.overdue_summary
	].map(objectValue)
	const dimensions = [root.dimensions, root.report?.dimensions, root.report?.dimensionSnapshot].map(objectValue)
	const summaryCounts = summaries.flatMap((summary) => [
		summary.current_overdue_count,
		summary.total_overdue_count,
		summary.overdueCount
	]).map(nonNegativeOrNull).filter((value) => value != null)
	const dimensionCounts = dimensions.flatMap((dimension) => [
		dimension.overdueCount,
		dimension.m1Count,
		dimension.m2Count,
		dimension.m3Count
	]).map(nonNegativeOrNull).filter((value) => value != null)
	const archivalCount = Math.max(0, positiveRows.length, ...summaryCounts, ...dimensionCounts)
	const archivalHasLianSan = dimensions.some((dimension) => explicitBoolean(dimension, 'hasLianSan', 'has_lian_san') === true) ||
		summaries.some((summary) => explicitBoolean(summary, 'consecutive_overdue_3', 'consecutiveOverdue3') === true)
	const archivalHasLeiLiu = dimensions.some((dimension) => explicitBoolean(dimension, 'hasLeiLiu', 'has_lei_liu') === true) ||
		summaries.some((summary) => explicitBoolean(summary, 'cumulative_overdue_6', 'cumulativeOverdue6') === true)
	const hasArchivalData = positiveRows.length > 0 || summaryCounts.length > 0 || dimensionCounts.length > 0 ||
		dimensions.some((dimension) => ['hasLianSan', 'has_lian_san', 'hasLeiLiu', 'has_lei_liu'].some((key) => hasOwn(dimension, key)))
	const trustedCount = trustedNonNegativeInteger(trustedProjection, 'overdueCount', 'overdueCount', expectedReportId)
	const trustedHasOverdue = trustedDecisionValue(trustedProjection, 'hasOverdue', 'hasOverdue', expectedReportId)
	const trustedLianSan = trustedDecisionValue(trustedProjection, 'hasLianSan', 'hasLianSan', expectedReportId)
	const trustedLeiLiu = trustedDecisionValue(trustedProjection, 'hasLeiLiu', 'hasLeiLiu', expectedReportId)
	const overdueKnown = trustedCount != null || typeof trustedHasOverdue === 'boolean'
	const hasOverdue = typeof trustedHasOverdue === 'boolean'
		? trustedHasOverdue
		: (trustedCount != null ? trustedCount > 0 : null)
	const overdueCount = trustedCount != null
		? trustedCount
		: (hasOverdue === false ? 0 : null)
	return {
		hasOverdue,
		overdueCount,
		hasDecisionOverdue: overdueKnown,
		overdueKnown,
		hasLianSan: typeof trustedLianSan === 'boolean' ? trustedLianSan : null,
		hasLeiLiu: typeof trustedLeiLiu === 'boolean' ? trustedLeiLiu : null,
		hasLianSanKnown: typeof trustedLianSan === 'boolean',
		hasLeiLiuKnown: typeof trustedLeiLiu === 'boolean',
		archivalHasOverdue: hasArchivalData ? archivalCount > 0 : null,
		archivalOverdueCount: hasArchivalData ? archivalCount : null,
		archivalHasLianSan: hasArchivalData ? archivalHasLianSan : null,
		archivalHasLeiLiu: hasArchivalData ? archivalHasLeiLiu : null,
		source: overdueKnown ? 'owner-report-api' : 'unavailable'
	}
}

export const resolveDecisionNonBankLoanRatio = (analysisData, trustedProjection = null, expectedReportId = '') => {
	void analysisData
	const value = trustedNonNegative(trustedProjection, 'nonBankLoanRatio', 'nonBankLoanRatio', expectedReportId)
	return value == null
		? unavailable('owner-api-non-bank-ratio-unverified')
		: { value, decisionEligible: true, known: true, source: 'owner-report-api' }
}

export const resolveDecisionInstitutionCount = (analysisData, trustedProjection = null, expectedReportId = '') => {
	void analysisData
	const value = trustedNonNegativeInteger(trustedProjection, 'institutionCount', 'institutionCount', expectedReportId)
	return value == null
		? unavailable('owner-api-institution-count-unverified')
		: { value, decisionEligible: true, known: true, source: 'owner-report-api' }
}

export const resolveDecisionHighRiskCount = (analysisData, trustedProjection = null, expectedReportId = '') => {
	void analysisData
	const value = trustedNonNegativeInteger(trustedProjection, 'highRiskCount', 'highRiskCount', expectedReportId)
	return value == null
		? unavailable('owner-api-high-risk-count-unverified')
		: { value, decisionEligible: true, known: true, source: 'owner-report-api' }
}

export default {
	resolveDecisionTotalDebt,
	resolveDecisionAccountCount,
	resolveDecisionRiskLevel,
	resolveEvidenceBackedDebtRatio,
	resolveDecisionQueryCounts,
	resolveDecisionOverdue,
	resolveDecisionNonBankLoanRatio,
	resolveDecisionInstitutionCount,
	resolveDecisionHighRiskCount,
	isEvidenceOverdueRecord
}
