/**
 * Ephemeral decision trust projected from the authenticated owner report API.
 *
 * The browser cannot verify the private evidence ledger.  A report body,
 * localStorage row, hash-looking evidence_meta object, or deterministic marker
 * therefore cannot manufacture this projection.  reportStorage creates it
 * only while mapping a current owner list/detail response whose analysis-job
 * link was reverified by the server; the module-private WeakSet deliberately
 * makes JSON round-trips archival again.
 */

import { getSessionCleanupRevision } from './sensitiveLocalState.js'
import { strictNonNegativeIntegerOrNull, strictNonNegativeNumberOrNull } from '../utils/strictNumber.js'

const ownerApiProjections = new WeakSet()

const classifyOpaqueId = (value) => {
	if (value === undefined || value === null) return { absent: true, valid: false, text: '' }
	if (typeof value === 'string') {
		const text = value.trim()
		return text ? { absent: false, valid: true, text } : { absent: true, valid: false, text: '' }
	}
	if (typeof value === 'number' && Number.isFinite(value) && value !== 0) {
		return { absent: false, valid: true, text: String(value) }
	}
	return { absent: false, valid: false, text: '' }
}

export const normalizeDecisionReportId = (value) => {
	const classified = classifyOpaqueId(value)
	return classified.valid ? classified.text : ''
}

export const isAbsentDecisionReportId = (value) => classifyOpaqueId(value).absent

/**
 * Validate a list of scalar report-id aliases without flattening/coercing any
 * individual field.  `null` means at least one explicitly supplied alias was
 * malformed (or, when requested, the aliases disagreed); an empty array means
 * every alias was genuinely absent.
 */
export const resolveDecisionReportIdAliases = (values, { requireMatch = false } = {}) => {
	if (!Array.isArray(values)) return null
	const ids = []
	for (const value of values) {
		const classified = classifyOpaqueId(value)
		if (classified.absent) continue
		if (!classified.valid) return null
		ids.push(classified.text)
	}
	if (requireMatch && ids.some((id) => id !== ids[0])) return null
	return Object.freeze(ids)
}

/** A match request may use only the canonical server aliases, never a local id. */
export const decisionServerReportIdOf = (report) => {
	const row = objectValue(report)
	let syncMeta = {}
	if (Object.prototype.hasOwnProperty.call(row, 'syncMeta')) {
		const rawSyncMeta = row.syncMeta
		if (rawSyncMeta !== undefined && rawSyncMeta !== null && rawSyncMeta !== '') {
			if (!rawSyncMeta || typeof rawSyncMeta !== 'object' || Array.isArray(rawSyncMeta)) return ''
			syncMeta = rawSyncMeta
		}
	}
	const ids = resolveDecisionReportIdAliases([
		row.cloudReportId,
		row.serverReportId,
		syncMeta.cloudReportId
	], { requireMatch: true })
	return ids && ids.length ? ids[0] : ''
}

const objectValue = (value) => (
	value && typeof value === 'object' && !Array.isArray(value) ? value : {}
)

const firstOwn = (source, aliases) => {
	const root = objectValue(source)
	for (const key of aliases) {
		if (!Object.prototype.hasOwnProperty.call(root, key)) continue
		const value = root[key]
		if (value === undefined || value === null) continue
		if (typeof value === 'string' && value.trim() === '') continue
		return value
	}
	return null
}

const VALUE_ALIASES = Object.freeze({
	score: ['score'],
	riskLevel: ['riskLevel'],
	accountCount: ['accountCount'],
	totalDebt: ['totalDebt'],
	query1mCount: ['query1mCount'],
	query3mCount: ['query3mCount'],
	query6mCount: ['query6mCount'],
	query12mCount: ['query12mCount'],
	totalLoanBalance: ['totalLoanBalance'],
	cardTotalLimit: ['cardTotalLimit'],
	cardTotalUsed: ['cardTotalUsed'],
	cardUtilizationUsed: ['cardUtilizationUsed'],
	cardUtilizationRate: ['cardUtilizationRate'],
	cardUtilizationPct: ['cardUtilizationPct'],
	sharedCreditGroupCount: ['sharedCreditGroupCount'],
	debtRatio: ['debtRatio'],
	nonBankLoanRatio: ['nonBankLoanRatio'],
	institutionCount: ['institutionCount'],
	overdueCount: ['overdueCount'],
	hasOverdue: ['hasOverdue'],
	hasLianSan: ['hasLianSan'],
	hasLeiLiu: ['hasLeiLiu'],
	highRiskCount: ['highRiskCount'],
	advice: ['advice'],
	suggestions: ['suggestions'],
	riskTags: ['riskTags']
})

const COUNT_VALUE_KEYS = new Set([
	'accountCount', 'query1mCount', 'query3mCount', 'query6mCount', 'query12mCount',
	'sharedCreditGroupCount', 'institutionCount', 'overdueCount', 'highRiskCount'
])
const NUMBER_VALUE_KEYS = new Set([
	'totalDebt', 'totalLoanBalance', 'cardTotalLimit', 'cardTotalUsed',
	'cardUtilizationUsed', 'cardUtilizationRate', 'cardUtilizationPct',
	'debtRatio', 'nonBankLoanRatio'
])
const BOOLEAN_VALUE_KEYS = new Set(['hasOverdue', 'hasLianSan', 'hasLeiLiu'])
const ARRAY_VALUE_KEYS = new Set(['suggestions', 'riskTags'])

const normalizeTrustedValue = (key, value) => {
	if (key === 'score') {
		const parsed = strictNonNegativeNumberOrNull(value)
		return parsed != null && parsed <= 100 ? parsed : null
	}
	if (COUNT_VALUE_KEYS.has(key)) return strictNonNegativeIntegerOrNull(value)
	if (NUMBER_VALUE_KEYS.has(key)) return strictNonNegativeNumberOrNull(value)
	if (BOOLEAN_VALUE_KEYS.has(key)) return typeof value === 'boolean' ? value : null
	if (ARRAY_VALUE_KEYS.has(key)) return Array.isArray(value) ? Object.freeze([...value]) : null
	if (key === 'riskLevel' || key === 'advice') {
		return typeof value === 'string' && value.trim() ? value.trim() : null
	}
	return null
}

const canonicalEnvelopeReportId = (envelope) => {
	const ids = resolveDecisionReportIdAliases(
		['reportId', 'id', '_id'].map((key) => (
			Object.prototype.hasOwnProperty.call(envelope, key) ? envelope[key] : undefined
		)),
		{ requireMatch: true }
	)
	return ids && ids.length ? ids[0] : ''
}

const frozenFlags = (value) => {
	const flags = {}
	for (const [key, enabled] of Object.entries(objectValue(value))) {
		if (typeof enabled === 'boolean') flags[key] = enabled === true
	}
	return Object.freeze(flags)
}

/** Internal production caller: reportStorage owner list/detail response mapper. */
export const createOwnerApiDecisionTrust = (ownerEnvelope) => {
	const envelope = objectValue(ownerEnvelope)
	const reportId = canonicalEnvelopeReportId(envelope)
	const values = {}
	for (const [key, aliases] of Object.entries(VALUE_ALIASES)) {
		values[key] = normalizeTrustedValue(key, firstOwn(envelope, aliases))
	}
	const decisionEvidenceLinked = Boolean(reportId) && envelope.decisionEvidenceLinked === true
	const projection = Object.freeze({
		source: 'owner-report-api',
		reportId,
		sessionRevision: getSessionCleanupRevision(),
		decisionEvidenceLinked,
		evidenceVerified: decisionEvidenceLinked && envelope.evidenceVerified === true,
		decisionFlags: frozenFlags(envelope.decisionFlags),
		values: Object.freeze(values)
	})
	ownerApiProjections.add(projection)
	return projection
}

export const readOwnerApiDecisionTrust = (projection) => (
	projection &&
	ownerApiProjections.has(projection) &&
	projection.sessionRevision === getSessionCleanupRevision()
		? projection
		: null
)

/** Resolve the canonical server report id represented by a page/storage row. */
export const decisionReportIdOf = (report) => {
	const row = objectValue(report)
	let syncMeta = {}
	if (Object.prototype.hasOwnProperty.call(row, 'syncMeta')) {
		const rawSyncMeta = row.syncMeta
		if (rawSyncMeta !== undefined && rawSyncMeta !== null && rawSyncMeta !== '') {
			if (!rawSyncMeta || typeof rawSyncMeta !== 'object' || Array.isArray(rawSyncMeta)) return ''
			syncMeta = rawSyncMeta
		}
	}
	const strongIds = resolveDecisionReportIdAliases([
		...['cloudReportId', 'serverReportId', 'reportId', 'report_id', '_id'].map((key) => (
			Object.prototype.hasOwnProperty.call(row, key) ? row[key] : undefined
		)),
		Object.prototype.hasOwnProperty.call(syncMeta, 'cloudReportId') ? syncMeta.cloudReportId : undefined
	], { requireMatch: true })
	if (!strongIds) return ''
	const fallback = Object.prototype.hasOwnProperty.call(row, 'id')
		? classifyOpaqueId(row.id)
		: { absent: true, valid: false, text: '' }
	if (!fallback.absent && !fallback.valid) return ''
	if (strongIds.length) return strongIds[0]
	return fallback.valid ? fallback.text : ''
}

const matchesExpectedReport = (trusted, expectedReportId) => {
	const expected = normalizeDecisionReportId(expectedReportId)
	return Boolean(trusted && expected && trusted.reportId === expected)
}

export const isOwnerApiDecisionTrust = (projection, expectedReportId = '') => {
	const trusted = readOwnerApiDecisionTrust(projection)
	return matchesExpectedReport(trusted, expectedReportId)
}

export const isOwnerApiEvidenceVerified = (projection, expectedReportId = '') => {
	const trusted = readOwnerApiDecisionTrust(projection)
	return matchesExpectedReport(trusted, expectedReportId) && trusted.evidenceVerified === true
}

/** A value is decision eligible only when both outer gates are true. */
export const trustedDecisionValue = (projection, flagKey, valueKey = flagKey, expectedReportId = '') => {
	const trusted = readOwnerApiDecisionTrust(projection)
	const expected = normalizeDecisionReportId(expectedReportId)
	if (
		!trusted ||
		!expected ||
		trusted.reportId !== expected ||
		trusted.decisionEvidenceLinked !== true ||
		trusted.evidenceVerified !== true ||
		trusted.decisionFlags?.[flagKey] !== true
	) return null
	const value = trusted.values?.[valueKey]
	if (value === undefined || value === null) return null
	if (typeof value === 'string' && value.trim() === '') return null
	return value
}

export default {
	createOwnerApiDecisionTrust,
	readOwnerApiDecisionTrust,
	normalizeDecisionReportId,
	isAbsentDecisionReportId,
	resolveDecisionReportIdAliases,
	decisionServerReportIdOf,
	decisionReportIdOf,
	isOwnerApiDecisionTrust,
	isOwnerApiEvidenceVerified,
	trustedDecisionValue
}
