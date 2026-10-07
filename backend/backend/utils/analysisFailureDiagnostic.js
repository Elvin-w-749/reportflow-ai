'use strict'

// Analysis failures can cross process, database and HTTP trust boundaries.
// Keep one closed diagnostic schema for all three boundaries. Never copy
// arbitrary keys or free-form values: upstream objects may contain report
// text, dates, amounts, institutions, identifiers, hashes or file paths.

const MAX_COUNT = 1000000

const COUNT_KEYS = Object.freeze([
	'expectedCount',
	'actualCount',
	'failedCheckCount',
	'evidenceIssueCount',
	'coverageIssueCount',
	'failedPageCount',
	'totalPageCount'
])

const FAILED_CHECKS = Object.freeze([
	'MANIFEST_COMPLETE',
	'EVIDENCE_COMPLETE',
	'LEDGER_READY',
	'DERIVED_VALIDATED',
	'HASH_INTEGRITY_VALID',
	'HASH_CHAIN_LINKED'
])

const UNRESOLVED_REASONS = Object.freeze([
	'AMBIGUOUS_CARD_SOURCE_BUNDLE',
	'AMBIGUOUS_SOURCE_LOAN_CURRENCY_SIGNAL',
	'AMBIGUOUS_SOURCE_CARD_CURRENCY_SIGNAL',
	'ENTITY_SOURCE_ROW_MISMATCH',
	'INVALID_TYPED_VALUE',
	'SOURCE_MATCH_MISSING',
	'SOURCE_ROW_ALREADY_ASSIGNED',
	'SOURCE_VALUE_OMITTED_BY_MODEL',
	'UNSUPPORTED_CARD_ACTIVATION_STATE',
	'SOURCE_LOAN_CURRENCY_OMITTED',
	'UNCLAIMED_SOURCE_INSTALLMENT_SIGNAL',
	'UNCLAIMED_SOURCE_SHARED_CREDIT_SIGNAL',
	'OTHER'
])

const TARGET_CLASSES = Object.freeze([
	'report.report_date',
	'loan.balance',
	'loan.currency',
	'loan.institution_identity',
	'card.credit_limit',
	'card.used_limit',
	'card.currency',
	'card.installment',
	'card.institution_identity',
	'card.start_date_identity',
	'card.tail_identity',
	'card.shared_group_identity',
	'query.date',
	'query.reason',
	'source.installment',
	'source.shared_group_identity',
	'source.currency',
	'OTHER'
])

const SECTION_NAMES = Object.freeze([
	'active_loans',
	'credit_card_details',
	'query_details'
])

const SECTION_BASES = Object.freeze([
	'missing-source-verification',
	'source-account-overview-pdf-geometry-v2',
	'source-account-overview-text-v1',
	'source-query-table-v1',
	'other-source-basis'
])

const CONFLICT_CODES = Object.freeze([
	'CARD_FACILITY_RELATION_UNRESOLVED',
	'SINGLE_MEMBER_SHARED_GROUP_UNRESOLVED',
	'OTHER'
])

const BLOCKED_REASONS = Object.freeze([
	'DETERMINISTIC_SCORE_PROJECTION_MISMATCH',
	'FACT_LEDGER_BLOCKED',
	'MONEY_CURRENCY_MISMATCH',
	'OTHER'
])

const BLOCKED_FORMULAS = Object.freeze([
	'card-outstanding-cny-v1',
	'card-utilization-cny-v2',
	'hard-query-calendar-window-v2',
	'loan-balance-sum-v2',
	'primary-score-deterministic-v2',
	'primary-score-deterministic-v3',
	'total-debt-v2',
	'OTHER'
])

function objectAt(value) {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function hasOwn(source, key) {
	return Boolean(source) && Object.prototype.hasOwnProperty.call(source, key)
}

function hasAnyOwn(source, keys) {
	return keys.some((key) => hasOwn(source, key))
}

function safeCount(value) {
	const number = typeof value === 'number' ? value : Number.NaN
	if (!Number.isFinite(number)) return undefined
	return Math.min(MAX_COUNT, Math.max(0, Math.trunc(number)))
}

function safeHttpStatus(value) {
	const number = typeof value === 'number' ? value : Number.NaN
	return Number.isInteger(number) && number >= 100 && number <= 599 ? number : undefined
}

function safeEnum(value, allowed, fallback = 'unknown') {
	const normalized = typeof value === 'string' ? value : ''
	return allowed.includes(normalized) ? normalized : fallback
}

function safeEnumCounts(value, allowed) {
	if (!Array.isArray(value)) return []
	const counts = new Map(allowed.map((item) => [item, 0]))
	for (const raw of value) {
		const item = objectAt(raw)
		if (!item) continue
		const enumValue = typeof item.value === 'string' ? item.value : ''
		const count = safeCount(item.count)
		if (!counts.has(enumValue) || count === undefined || count === 0) continue
		counts.set(enumValue, Math.min(MAX_COUNT, counts.get(enumValue) + count))
	}
	return allowed
		.filter((item) => counts.get(item) > 0)
		.map((item) => ({ value: item, count: counts.get(item) }))
}

function safeManifest(value) {
	const source = objectAt(value)
	if (!source || !hasAnyOwn(source, [
		'status', 'declaredPageCount', 'processedPageCount', 'completePageCount',
		'rejectedPageCount', 'missingPageCount', 'duplicatePageCount'
	])) return null
	return {
		status: safeEnum(source.status, ['complete', 'rejected', 'unknown']),
		declaredPageCount: safeCount(source.declaredPageCount) || 0,
		processedPageCount: safeCount(source.processedPageCount) || 0,
		completePageCount: safeCount(source.completePageCount) || 0,
		rejectedPageCount: safeCount(source.rejectedPageCount) || 0,
		missingPageCount: safeCount(source.missingPageCount) || 0,
		duplicatePageCount: safeCount(source.duplicatePageCount) || 0
	}
}

function safeUnresolvedByTarget(value) {
	if (!Array.isArray(value)) return []
	const grouped = new Map(TARGET_CLASSES.map((name) => [name, null]))
	for (const raw of value) {
		const item = objectAt(raw)
		if (!item) continue
		const name = typeof item.name === 'string' ? item.name : ''
		const count = safeCount(item.count)
		if (!grouped.has(name) || count === undefined) continue
		const existing = grouped.get(name)
		if (existing) continue
		grouped.set(name, {
			name,
			count,
			reasons: safeEnumCounts(item.reasons, UNRESOLVED_REASONS)
		})
	}
	return TARGET_CLASSES.map((name) => grouped.get(name)).filter(Boolean)
}

function safeGraph(value) {
	const source = objectAt(value)
	if (!source || !hasAnyOwn(source, [
		'status', 'nodeCount', 'criticalUnresolvedCount',
		'unresolvedReasons', 'unresolvedByTarget'
	])) return null
	return {
		status: safeEnum(source.status, ['complete', 'rejected', 'unknown']),
		nodeCount: safeCount(source.nodeCount) || 0,
		criticalUnresolvedCount: safeCount(source.criticalUnresolvedCount) || 0,
		unresolvedReasons: safeEnumCounts(source.unresolvedReasons, UNRESOLVED_REASONS),
		unresolvedByTarget: safeUnresolvedByTarget(source.unresolvedByTarget)
	}
}

function safeSections(value) {
	if (!Array.isArray(value)) return []
	const byName = new Map(SECTION_NAMES.map((name) => [name, null]))
	for (const raw of value) {
		const section = objectAt(raw)
		if (!section) continue
		const name = typeof section.name === 'string' ? section.name : ''
		if (!byName.has(name) || byName.get(name)) continue
		const expectedCount = section.expectedCount === null
			? null
			: safeCount(section.expectedCount)
		byName.set(name, {
			name,
			expectedCount: expectedCount === undefined ? null : expectedCount,
			acceptedCount: safeCount(section.acceptedCount) || 0,
			declaredCount: safeCount(section.declaredCount) || 0,
			status: safeEnum(section.status, ['complete', 'empty-proven', 'incomplete', 'unknown']),
			basis: safeEnum(section.basis, SECTION_BASES, 'other-source-basis')
		})
	}
	return SECTION_NAMES.map((name) => byName.get(name)).filter(Boolean)
}

function safeLedger(value) {
	const source = objectAt(value)
	if (!source || !hasAnyOwn(source, [
		'status', 'criticalFailureCount', 'sections', 'conflictCodes'
	])) return null
	return {
		status: safeEnum(source.status, ['ready', 'blocked', 'unknown']),
		criticalFailureCount: safeCount(source.criticalFailureCount) || 0,
		sections: safeSections(source.sections),
		conflictCodes: safeEnumCounts(source.conflictCodes, CONFLICT_CODES)
	}
}

function safeDerived(value) {
	const source = objectAt(value)
	if (!source || !hasAnyOwn(source, [
		'status', 'blockedMetricCount', 'blockedReasons', 'blockedFormulas'
	])) return null
	return {
		status: safeEnum(source.status, ['validated', 'blocked', 'unknown']),
		blockedMetricCount: safeCount(source.blockedMetricCount) || 0,
		blockedReasons: safeEnumCounts(source.blockedReasons, BLOCKED_REASONS),
		blockedFormulas: safeEnumCounts(source.blockedFormulas, BLOCKED_FORMULAS)
	}
}

function parseSource(value) {
	if (typeof value !== 'string') return objectAt(value)
	try { return objectAt(JSON.parse(value)) } catch (_) { return null }
}

function sanitizeAnalysisFailureDiagnostic(value) {
	const source = parseSource(value)
	const diagnostic = { version: 1 }
	if (!source) return diagnostic
	const httpStatus = safeHttpStatus(source.httpStatus)
	if (httpStatus !== undefined) diagnostic.httpStatus = httpStatus

	for (const key of COUNT_KEYS) {
		if (!hasOwn(source, key)) continue
		const count = safeCount(source[key])
		if (count !== undefined) diagnostic[key] = count
	}

	if (Array.isArray(source.failedChecks)) {
		const sourceChecks = new Set(source.failedChecks.filter((item) => typeof item === 'string'))
		const failedChecks = FAILED_CHECKS.filter((item) => sourceChecks.has(item))
		if (failedChecks.length) diagnostic.failedChecks = failedChecks
		if (hasOwn(source, 'failedCheckCount')) diagnostic.failedCheckCount = failedChecks.length
	}

	for (const [key, sanitizer] of [
		['manifest', safeManifest],
		['graph', safeGraph],
		['ledger', safeLedger],
		['derived', safeDerived]
	]) {
		const nested = sanitizer(source[key])
		if (nested) diagnostic[key] = nested
	}

	return diagnostic
}

module.exports = {
	sanitizeAnalysisFailureDiagnostic
}
