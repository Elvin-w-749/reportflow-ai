import { normalizeDecisionReportId, trustedDecisionValue } from './decisionTrust.js'

const finiteNumber = (value, { min = 0, max = Number.POSITIVE_INFINITY, integer = false } = {}) => {
	if (value === '' || value == null || typeof value === 'boolean') return null
	const number = Number(value)
	if (!Number.isFinite(number) || number < min || number > max) return null
	if (integer && !Number.isInteger(number)) return null
	return number
}

const trustedNumber = (decisionTrust, reportId, flagKey, options = {}) => finiteNumber(
	trustedDecisionValue(decisionTrust, flagKey, flagKey, reportId),
	options
)

const trustedBoolean = (decisionTrust, reportId, flagKey) => {
	const value = trustedDecisionValue(decisionTrust, flagKey, flagKey, reportId)
	return typeof value === 'boolean' ? value : null
}

const trustedText = (decisionTrust, reportId, flagKey) => {
	const value = trustedDecisionValue(decisionTrust, flagKey, flagKey, reportId)
	return typeof value === 'string' && value.trim() ? value.trim() : null
}

const normalizedPercent = (rate, pct) => {
	const pctValue = finiteNumber(pct, { min: 0, max: 10000 })
	const rateValue = finiteNumber(rate, { min: 0, max: 100 })
	if (pctValue != null && rateValue != null && Math.abs(pctValue - rateValue * 100) > 0.01) return null
	if (pctValue != null) return pctValue
	return rateValue == null ? null : Math.round(rateValue * 10000) / 100
}

/**
 * Build the only decision inputs that DebtManage may consume.
 *
 * `trustedDecisionValue` enforces all three boundaries: the projection must be
 * branded by the current owner API session, evidenceVerified must be true, and
 * the individual field flag must be true.  Requiring a non-empty expected
 * report id here also prevents an otherwise valid projection from being reused
 * for a different report or for an unscoped legacy route.
 */
export const resolveDebtDecisionPolicy = (decisionTrust, expectedReportId) => {
	const reportId = normalizeDecisionReportId(expectedReportId)
	if (!reportId) {
		return {
			reportId: '',
			totalDebt: null,
			cardUtilizationPct: null,
			debtRatioPct: null,
			overdueCount: null,
			hasOverdue: null,
			accountCount: null,
			highRiskCount: null,
			riskLevel: null,
			fields: Object.freeze({})
		}
	}

	const totalDebt = trustedNumber(decisionTrust, reportId, 'totalDebt')
	const cardRate = trustedNumber(decisionTrust, reportId, 'cardUtilizationRate', { max: 100 })
	const cardPct = trustedNumber(decisionTrust, reportId, 'cardUtilizationPct', { max: 10000 })
	const cardUtilizationPct = normalizedPercent(cardRate, cardPct)
	// `debtRatio` currently means totalDebt / totalLine. Its denominator is not
	// yet part of the approved evidence contract, so even a legacy owner API
	// flag cannot promote it into DebtManage decisions. This also removes the
	// former magnitude-based ratio/percent guess for values above 1.
	const debtRatioPct = null
	let overdueCount = trustedNumber(decisionTrust, reportId, 'overdueCount', { integer: true })
	let hasOverdue = trustedBoolean(decisionTrust, reportId, 'hasOverdue')
	if (overdueCount != null && hasOverdue != null && hasOverdue !== (overdueCount > 0)) {
		overdueCount = null
		hasOverdue = null
	} else if (overdueCount != null && hasOverdue == null) {
		hasOverdue = overdueCount > 0
	} else if (hasOverdue != null && overdueCount == null && hasOverdue === false) {
		overdueCount = 0
	}
	const accountCount = trustedNumber(decisionTrust, reportId, 'accountCount', { integer: true })
	const highRiskCount = trustedNumber(decisionTrust, reportId, 'highRiskCount', { integer: true })
	const riskLevel = trustedText(decisionTrust, reportId, 'riskLevel')

	return {
		reportId,
		totalDebt,
		cardUtilizationPct,
		debtRatioPct,
		overdueCount,
		hasOverdue,
		accountCount,
		highRiskCount,
		riskLevel,
		fields: Object.freeze({
			totalDebt: totalDebt != null,
			cardUtilization: cardUtilizationPct != null,
			debtRatio: debtRatioPct != null,
			overdue: overdueCount != null || hasOverdue != null,
			accountCount: accountCount != null,
			highRiskCount: highRiskCount != null,
			riskLevel: riskLevel != null
		})
	}
}

export default { resolveDebtDecisionPolicy }
