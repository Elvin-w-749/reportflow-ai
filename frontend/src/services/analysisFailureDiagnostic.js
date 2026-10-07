const COUNT_KEYS = Object.freeze([
	'expectedCount',
	'actualCount',
	'failedCheckCount',
	'evidenceIssueCount',
	'coverageIssueCount',
	'failedPageCount',
	'totalPageCount'
])

const FAILED_CHECKS = new Set([
	'MANIFEST_COMPLETE',
	'EVIDENCE_COMPLETE',
	'LEDGER_READY',
	'DERIVED_VALIDATED',
	'HASH_INTEGRITY_VALID',
	'HASH_CHAIN_LINKED'
])

export function analysisDiagnosticHttpStatus(diagnostic) {
	const value = diagnostic && typeof diagnostic.httpStatus === 'number'
		? diagnostic.httpStatus
		: Number.NaN
	return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null
}

export function sanitizeAnalysisDiagnostic(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const result = { version: 1 }
	const httpStatus = analysisDiagnosticHttpStatus(value)
	if (httpStatus !== null) result.httpStatus = httpStatus
	for (const key of COUNT_KEYS) {
		const number = typeof value[key] === 'number' ? value[key] : Number.NaN
		if (!Number.isFinite(number)) continue
		result[key] = Math.min(1000000, Math.max(0, Math.trunc(number)))
	}
	if (Array.isArray(value.failedChecks)) {
		result.failedChecks = value.failedChecks
			.filter((item) => typeof item === 'string')
			.filter((item, index, items) => FAILED_CHECKS.has(item) && items.indexOf(item) === index)
		if (Object.prototype.hasOwnProperty.call(value, 'failedCheckCount')) {
			result.failedCheckCount = result.failedChecks.length
		}
	}
	return result
}
