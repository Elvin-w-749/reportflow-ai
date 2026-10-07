'use strict'

const crypto = require('crypto')
const { analysisVersions } = require('../services/analysisIdentity')
const { sanitizeAnalysisFailureDiagnostic } = require('./analysisFailureDiagnostic')
const { resolveApiReleaseIdentity } = require('./releaseIdentity')

// supportRef is the only identifier intended to be copied by a user. traceId
// correlates the execution across the coordinator and PM2 logs. Both are
// random and deliberately contain no tenant, user, document, result or time
// material.
const SUPPORT_REF_RE = /^sr_[A-Za-z0-9_-]{24}$/
const TRACE_ID_RE = /^tr_[A-Za-z0-9_-]{24}$/
const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const EVENT_CONTRACT_VERSION = 'analysis-terminal-event-v1'

const ERROR_CLASSES = new Set([
	'upstream_transient',
	'transport_transient',
	'evidence_permanent',
	'schema_permanent',
	'input_permanent',
	'configuration_permanent',
	'internal_permanent',
	'unknown_permanent'
])
const SAFE_MESSAGE_KEYS = new Set([
	'provider-configuration-unavailable',
	'provider-connection-interrupted',
	'provider-timeout',
	'provider-temporarily-unavailable',
	'analysis-input-rejected',
	'provider-response-invalid',
	'evidence-structure-unproven',
	'analysis-deadline-exceeded',
	'analysis-publication-blocked'
])

const definition = (errorClass, stage, retryable, safeMessageKey) => Object.freeze({
	errorClass,
	stage,
	retryable,
	safeMessageKey
})
const variants = (...values) => Object.freeze(values)

// Phase 0 froze the provider mappings below. Existing V7 task failures use the
// same nine public message keys and a closed safe stage vocabulary. Any raw
// code not listed here becomes ANALYSIS_FAILED; no regex-shaped upstream value
// is ever persisted, logged or returned as a trusted code/stage.
const TERMINAL_CODE_DEFINITIONS = Object.freeze({
	GLM_OCR_NOT_CONFIGURED: definition('configuration_permanent', 'ocr-config', false, 'provider-configuration-unavailable'),
	GLM_OCR_NETWORK_ERROR: definition('transport_transient', 'ocr-provider', true, 'provider-connection-interrupted'),
	GLM_OCR_CONNECT_TIMEOUT: definition('transport_transient', 'ocr-provider', true, 'provider-timeout'),
	GLM_OCR_PAGE_TIMEOUT: definition('transport_transient', 'ocr-provider', true, 'provider-timeout'),
	GLM_OCR_HTTP_408: definition('upstream_transient', 'ocr-provider', true, 'provider-timeout'),
	GLM_OCR_RATE_LIMITED: definition('upstream_transient', 'ocr-provider', true, 'provider-temporarily-unavailable'),
	GLM_OCR_PROVIDER_UNAVAILABLE: definition('upstream_transient', 'ocr-provider', true, 'provider-temporarily-unavailable'),
	GLM_OCR_PROVIDER_ERROR: definition('upstream_transient', 'ocr-provider', true, 'provider-temporarily-unavailable'),
	GLM_OCR_BAD_REQUEST: definition('input_permanent', 'ocr-provider', false, 'analysis-input-rejected'),
	GLM_OCR_CLIENT_ERROR: definition('configuration_permanent', 'ocr-provider', false, 'provider-configuration-unavailable'),
	GLM_OCR_AUTH_FAILED: definition('configuration_permanent', 'ocr-provider', false, 'provider-configuration-unavailable'),
	GLM_OCR_FORBIDDEN: definition('configuration_permanent', 'ocr-provider', false, 'provider-configuration-unavailable'),
	GLM_OCR_INPUT_TOO_LARGE: definition('input_permanent', 'ocr-preflight', false, 'analysis-input-rejected'),
	GLM_OCR_RESPONSE_INVALID: definition('schema_permanent', 'ocr-normalize', false, 'provider-response-invalid'),
	GLM_OCR_PAGE_COVERAGE_MISMATCH: definition('evidence_permanent', 'ocr-normalize', false, 'evidence-structure-unproven'),
	OCR_RECORD_MEMBERSHIP_UNPROVEN: definition('evidence_permanent', 'ocr-normalize', false, 'evidence-structure-unproven'),
	OCR_READING_ORDER_CONFLICT: definition('evidence_permanent', 'ocr-normalize', false, 'evidence-structure-unproven'),
	OCR_STAGE_DEADLINE_EXCEEDED: definition('transport_transient', 'ocr-provider', true, 'analysis-deadline-exceeded'),
	DEEPSEEK_NOT_CONFIGURED: definition('configuration_permanent', 'fact-extraction-config', false, 'provider-configuration-unavailable'),
	DEEPSEEK_NETWORK_ERROR: definition('transport_transient', 'fact-extraction', true, 'provider-connection-interrupted'),
	DEEPSEEK_TIMEOUT: definition('transport_transient', 'fact-extraction', true, 'provider-timeout'),
	DEEPSEEK_HTTP_408: definition('upstream_transient', 'fact-extraction', true, 'provider-timeout'),
	DEEPSEEK_HTTP_409: definition('upstream_transient', 'fact-extraction', true, 'provider-temporarily-unavailable'),
	DEEPSEEK_HTTP_425: definition('upstream_transient', 'fact-extraction', true, 'provider-temporarily-unavailable'),
	DEEPSEEK_RATE_LIMITED: definition('upstream_transient', 'fact-extraction', true, 'provider-temporarily-unavailable'),
	DEEPSEEK_PROVIDER_UNAVAILABLE: definition('upstream_transient', 'fact-extraction', true, 'provider-temporarily-unavailable'),
	DEEPSEEK_BAD_REQUEST: definition('configuration_permanent', 'fact-extraction', false, 'provider-configuration-unavailable'),
	DEEPSEEK_CLIENT_ERROR: definition('configuration_permanent', 'fact-extraction', false, 'provider-configuration-unavailable'),
	DEEPSEEK_AUTH_FAILED: definition('configuration_permanent', 'fact-extraction', false, 'provider-configuration-unavailable'),
	DEEPSEEK_FORBIDDEN: definition('configuration_permanent', 'fact-extraction', false, 'provider-configuration-unavailable'),
	DEEPSEEK_INPUT_TOO_LARGE: definition('input_permanent', 'fact-extraction-preflight', false, 'analysis-input-rejected'),
	DEEPSEEK_CONTEXT_LIMIT: definition('input_permanent', 'fact-extraction', false, 'analysis-input-rejected'),
	DEEPSEEK_RESPONSE_INVALID: definition('schema_permanent', 'fact-extraction', false, 'provider-response-invalid'),
	DEEPSEEK_OUTPUT_TRUNCATED: definition('upstream_transient', 'fact-extraction', true, 'provider-response-invalid'),
	EVIDENCE_PUBLICATION_BLOCKED: definition('evidence_permanent', 'publication-gate', false, 'analysis-publication-blocked'),

	ANALYSIS_OUTPUT_TRUNCATED: definition('upstream_transient', 'fact-extraction', true, 'provider-response-invalid'),
	ANALYSIS_NON_JSON_OUTPUT: definition('upstream_transient', 'fact-extraction', true, 'provider-response-invalid'),
	ANALYSIS_UPSTREAM_FAILED: variants(
		definition('upstream_transient', 'fact-extraction', true, 'provider-temporarily-unavailable'),
		definition('configuration_permanent', 'fact-extraction', false, 'provider-configuration-unavailable')
	),
	OCR_UPSTREAM_FAILED: variants(
		definition('upstream_transient', 'ocr-provider', true, 'provider-temporarily-unavailable'),
		definition('configuration_permanent', 'ocr-provider', false, 'provider-configuration-unavailable')
	),
	ANALYSIS_IN_PROGRESS_TIMEOUT: definition('transport_transient', 'processing', true, 'analysis-deadline-exceeded'),
	ANALYSIS_LEASE_LOST: definition('transport_transient', 'processing', true, 'provider-connection-interrupted'),
	ECONNRESET: definition('transport_transient', 'processing', true, 'provider-connection-interrupted'),
	ECONNREFUSED: definition('transport_transient', 'processing', true, 'provider-connection-interrupted'),
	ETIMEDOUT: definition('transport_transient', 'processing', true, 'provider-timeout'),
	EAI_AGAIN: definition('transport_transient', 'processing', true, 'provider-connection-interrupted'),
	ENETUNREACH: definition('transport_transient', 'processing', true, 'provider-connection-interrupted'),
	EPIPE: definition('transport_transient', 'processing', true, 'provider-connection-interrupted'),
	UND_ERR_CONNECT_TIMEOUT: definition('transport_transient', 'processing', true, 'provider-timeout'),
	UND_ERR_HEADERS_TIMEOUT: definition('transport_transient', 'processing', true, 'provider-timeout'),
	UND_ERR_SOCKET: definition('transport_transient', 'processing', true, 'provider-connection-interrupted'),
	ANALYSIS_TASK_PERSISTENCE_UNAVAILABLE: definition('configuration_permanent', 'queued', false, 'provider-configuration-unavailable'),
	ANALYSIS_SCOPE_REQUIRED: definition('configuration_permanent', 'queued', false, 'provider-configuration-unavailable'),
	ANALYSIS_STABLE_SECRET_REQUIRED: definition('configuration_permanent', 'queued', false, 'provider-configuration-unavailable'),
	EVIDENCE_HASH_KEY_REQUIRED: definition('configuration_permanent', 'evidence-gate', false, 'provider-configuration-unavailable'),
	EVIDENCE_IDENTITY_MISMATCH: definition('evidence_permanent', 'evidence-gate', false, 'evidence-structure-unproven'),
	EVIDENCE_CLOSURE_INVALID: definition('evidence_permanent', 'evidence-gate', false, 'evidence-structure-unproven'),
	EVIDENCE_DERIVATION_INVALID: definition('evidence_permanent', 'evidence-gate', false, 'evidence-structure-unproven'),
	EVIDENCE_SCOPE_INVALID: definition('evidence_permanent', 'evidence-gate', false, 'evidence-structure-unproven'),
	EVIDENCE_HASH_CHAIN_INVALID: definition('evidence_permanent', 'evidence-gate', false, 'evidence-structure-unproven'),
	EVIDENCE_DERIVATION_MISMATCH: definition('evidence_permanent', 'evidence-gate', false, 'evidence-structure-unproven'),
	EVIDENCE_META_INVALID: definition('evidence_permanent', 'evidence-gate', false, 'evidence-structure-unproven'),
	EVIDENCE_NOT_SERVER_TRUSTED: definition('evidence_permanent', 'evidence-gate', false, 'evidence-structure-unproven'),
	SOURCE_EVIDENCE_MISSING: definition('evidence_permanent', 'evidence-gate', false, 'evidence-structure-unproven'),
	QUERY_EVIDENCE_INCOMPLETE: definition('evidence_permanent', 'evidence-gate', false, 'evidence-structure-unproven'),
	FACT_SCHEMA_INVALID: definition('schema_permanent', 'fact-extraction', false, 'provider-response-invalid'),
	CHUNK_COVERAGE_MISMATCH: definition('schema_permanent', 'fact-extraction', false, 'provider-response-invalid'),
	CHUNK_FACT_CONFLICT: definition('schema_permanent', 'fact-extraction', false, 'provider-response-invalid'),
	CHUNK_FACTS_MISSING: definition('schema_permanent', 'fact-extraction', false, 'provider-response-invalid'),
	CHUNK_QUERY_EVIDENCE_MISMATCH: definition('schema_permanent', 'fact-extraction', false, 'provider-response-invalid'),
	CHUNK_SCALAR_CONFLICT: definition('schema_permanent', 'fact-extraction', false, 'provider-response-invalid'),
	CHUNK_SOURCE_OVERVIEW_MISMATCH: definition('schema_permanent', 'fact-extraction', false, 'provider-response-invalid'),
	DETERMINISTIC_COVERAGE_MISSING: definition('schema_permanent', 'rule-validation', false, 'provider-response-invalid'),
	DETERMINISTIC_FACTS_INCOMPLETE: definition('schema_permanent', 'rule-validation', false, 'provider-response-invalid'),
	DETERMINISTIC_INPUT_INCOMPLETE: definition('schema_permanent', 'rule-validation', false, 'provider-response-invalid'),
	DETERMINISTIC_OUTPUT_INCOMPLETE: definition('schema_permanent', 'rule-validation', false, 'provider-response-invalid'),
	DETERMINISTIC_REPORT_DATE_MISSING: definition('schema_permanent', 'rule-validation', false, 'provider-response-invalid'),
	DETERMINISTIC_SCORE_PROJECTION_MISMATCH: definition('schema_permanent', 'rule-validation', false, 'provider-response-invalid'),
	DETERMINISTIC_RULE_ENGINE_FAILED: definition('internal_permanent', 'rule-validation', false, 'provider-response-invalid'),
	DERIVED_METRIC_INVALID: definition('schema_permanent', 'rule-validation', false, 'provider-response-invalid'),
	DERIVED_PROJECTION_MISMATCH: definition('schema_permanent', 'rule-validation', false, 'provider-response-invalid'),
	ANALYSIS_INPUT_TOO_LARGE: definition('input_permanent', 'input-preflight', false, 'analysis-input-rejected'),
	ANALYSIS_CONTEXT_LIMIT: definition('input_permanent', 'input-preflight', false, 'analysis-input-rejected'),
	INVALID_PDF: definition('input_permanent', 'input-preflight', false, 'analysis-input-rejected'),
	PDF_TEXT_LAYER_MISSING: definition('input_permanent', 'pdf-extract', false, 'analysis-input-rejected'),
	PDF_EVIDENCE_SOURCE_UNVERIFIED: definition('input_permanent', 'pdf-extract', false, 'evidence-structure-unproven'),
	OCR_STRUCTURED_EVIDENCE_UNAVAILABLE: definition('input_permanent', 'ocr', false, 'evidence-structure-unproven'),
	OCR_TEXT_TOO_SHORT: definition('input_permanent', 'ocr', false, 'analysis-input-rejected'),
	OCR_FAILED: definition('input_permanent', 'ocr', false, 'provider-response-invalid'),
	OCR_PAGE_FAILED: definition('input_permanent', 'ocr', false, 'provider-response-invalid'),
	OCR_QUERY_PAGE_RENDER_FAILED: definition('input_permanent', 'ocr', false, 'provider-response-invalid'),
	OCR_QUERY_PAGE_RESCUE_FAILED: definition('input_permanent', 'ocr', false, 'provider-response-invalid'),
	OCR_INCOMPLETE: definition('input_permanent', 'ocr', false, 'evidence-structure-unproven'),
	RAPIDOCR_FAILED: definition('input_permanent', 'ocr', false, 'provider-response-invalid'),
	IMAGE_OCR_FAILED: definition('input_permanent', 'ocr', false, 'provider-response-invalid'),
	IMAGE_OCR_INCOMPLETE: definition('input_permanent', 'ocr', false, 'evidence-structure-unproven'),
	IMAGE_TEXT_TOO_SHORT: definition('input_permanent', 'ocr', false, 'analysis-input-rejected'),
	ANALYSIS_TASK_INPUT_INVALID: definition('input_permanent', 'queued', false, 'analysis-input-rejected'),
	ANALYSIS_TASK_SCOPE_INVALID: definition('input_permanent', 'queued', false, 'analysis-input-rejected'),
	PDF_PAGE_LIMIT_EXCEEDED: definition('input_permanent', 'pdf-extract', false, 'analysis-input-rejected'),
	PDF_PAGE_OUT_OF_RANGE: definition('input_permanent', 'pdf-extract', false, 'analysis-input-rejected'),
	PDF_STRUCTURED_TEXT_FAILED: definition('input_permanent', 'pdf-extract', false, 'provider-response-invalid'),
	UNSUPPORTED_FILE_TYPE: definition('input_permanent', 'input-preflight', false, 'analysis-input-rejected'),
	RAPIDOCR_CONFIG_ERROR: definition('configuration_permanent', 'ocr-config', false, 'provider-configuration-unavailable'),
	RAPIDOCR_DISABLED: definition('configuration_permanent', 'ocr-config', false, 'provider-configuration-unavailable'),
	RAPIDOCR_INVALID_INPUT: definition('input_permanent', 'ocr-preflight', false, 'analysis-input-rejected'),
	RAPIDOCR_INVALID_RESULT: definition('schema_permanent', 'ocr-normalize', false, 'provider-response-invalid'),
	RAPIDOCR_MODEL_INTEGRITY_ERROR: definition('configuration_permanent', 'ocr-config', false, 'provider-configuration-unavailable'),
	RAPIDOCR_QUEUE_TIMEOUT: definition('transport_transient', 'ocr-provider', true, 'analysis-deadline-exceeded'),
	ANALYSIS_RESULT_UNAVAILABLE: definition('internal_permanent', 'cache', false, 'provider-response-invalid'),
	ANALYSIS_EXECUTION_FAILED: definition('internal_permanent', 'processing', false, 'provider-response-invalid'),
	ARTIFACT_CONTRACT_INVALID: definition('internal_permanent', 'evidence-gate', false, 'provider-response-invalid'),
	ARTIFACT_HASH_INVALID: definition('internal_permanent', 'evidence-gate', false, 'provider-response-invalid'),
	INVALID_CANONICAL_RESULT: definition('internal_permanent', 'persisting', false, 'provider-response-invalid'),
	NON_AUTHORITATIVE_RESULT: definition('internal_permanent', 'publication-gate', false, 'analysis-publication-blocked'),
	INCOMPLETE_CANONICAL_RESULT: definition('internal_permanent', 'publication-gate', false, 'analysis-publication-blocked'),
	CANONICAL_RESULT_TOO_LARGE: definition('internal_permanent', 'persisting', false, 'analysis-input-rejected'),
	CACHE_INTEGRITY_FAILED: definition('internal_permanent', 'cache', false, 'provider-response-invalid'),
	ANALYSIS_FAILED: definition('unknown_permanent', 'unknown', false, 'provider-response-invalid')
})

const CLOSED_PROGRESS_STAGES = new Set([
	'queued', 'processing', 'uploaded', 'pdf_extract', 'ocr', 'query_evidence',
	'fact_extraction', 'rule_validation', 'persisting', 'succeeded', 'failed'
])

const VERSION_FIELDS = Object.freeze([
	'event',
	'pipeline',
	'model',
	'prompt',
	'schema',
	'evidenceContract',
	'evidenceBinder',
	'derivedTrace',
	'rule',
	'ocr'
])
const EXPECTED_VERSIONS = Object.freeze({
	event: EVENT_CONTRACT_VERSION,
	pipeline: 'credit-analysis-v14-global-card-binding-currency-closed',
	model: 'deepseek-v4-flash',
	prompt: 'credit-facts-v8-query-source',
	schema: 'credit-facts-schema-v6-evidence-closure',
	evidenceContract: 'evidence-ledger-v2.1',
	evidenceBinder: 'deterministic-global-card-binding-v8-notactivated-closed-state',
	derivedTrace: 'derived-analysis-provenance-v4',
	rule: 'credit-rules-deterministic-v3',
	ocr: 'rapidocr-v1'
})

// Persisted terminal events are immutable and carry the version strings of the
// release that produced them. Newer releases must keep parsing rows written by
// earlier releases, so each field accepts the closed set below: the current
// expected string plus every string a shipped release has ever persisted.
// Anything outside this closed set is still treated as corruption and rejected.
// New events can never be written with a historical string: the write path
// (runtimeVersionSnapshot) coerces every non-current value to null first.
const ACCEPTED_PERSISTED_VERSIONS = Object.freeze(Object.fromEntries(
	VERSION_FIELDS.map((field) => {
		const history = {
			evidenceBinder: ['deterministic-global-card-binding-v7']
		}[field] || []
		return [field, Object.freeze([EXPECTED_VERSIONS[field], ...history])]
	})
))

function exactObject(value, allowedKeys, label) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw invalidEvent(`${label} must be an object`)
	}
	const allowed = new Set(allowedKeys)
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw invalidEvent(`${label} contains an unknown field`)
	}
	return value
}

function invalidEvent(message) {
	const error = new Error(message || 'trusted analysis event is invalid')
	error.code = 'TRUSTED_ANALYSIS_EVENT_INVALID'
	return error
}

function createSupportRef() {
	return `sr_${crypto.randomBytes(18).toString('base64url')}`
}

function createTraceId() {
	return `tr_${crypto.randomBytes(18).toString('base64url')}`
}

function normalizeTerminalCode(value) {
	return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TERMINAL_CODE_DEFINITIONS, value)
		? value
		: 'ANALYSIS_FAILED'
}

function terminalCodeDefinition(value, classifiedErrorClass = null) {
	const code = normalizeTerminalCode(value)
	const configured = TERMINAL_CODE_DEFINITIONS[code]
	const choices = Array.isArray(configured) ? configured : [configured]
	const selected = choices.find((item) => item.errorClass === classifiedErrorClass) ||
		choices.find((item) => item.errorClass === 'configuration_permanent') ||
		choices[0]
	return { code, ...selected }
}

function normalizeProgressStage(value) {
	return typeof value === 'string' && CLOSED_PROGRESS_STAGES.has(value)
		? value
		: 'processing'
}

function safeVersion(value, expected) {
	if (value === null) return null
	if (typeof value !== 'string') return null
	const normalized = value.trim()
	return normalized === expected ? normalized : null
}

function acceptedPersistedVersion(field, value) {
	if (value === null) return null
	if (typeof value !== 'string') return undefined
	const normalized = value.trim()
	return ACCEPTED_PERSISTED_VERSIONS[field].includes(normalized) ? normalized : undefined
}

function runtimeReleaseSnapshot() {
	return resolveApiReleaseIdentity(
		process.env.RPT_RELEASE_ID,
		process.env.RPT_GIT_COMMIT
	)
}

function runtimeVersionSnapshot() {
	const source = analysisVersions()
	return {
		event: EVENT_CONTRACT_VERSION,
		pipeline: safeVersion(source.pipeline, EXPECTED_VERSIONS.pipeline),
		model: safeVersion(source.model, EXPECTED_VERSIONS.model),
		prompt: safeVersion(source.prompt, EXPECTED_VERSIONS.prompt),
		schema: safeVersion(source.schema, EXPECTED_VERSIONS.schema),
		evidenceContract: safeVersion(source.evidenceContract, EXPECTED_VERSIONS.evidenceContract),
		evidenceBinder: safeVersion(source.evidenceBinder, EXPECTED_VERSIONS.evidenceBinder),
		derivedTrace: safeVersion(source.derivedTrace, EXPECTED_VERSIONS.derivedTrace),
		rule: safeVersion(source.rule, EXPECTED_VERSIONS.rule),
		ocr: safeVersion(source.ocr, EXPECTED_VERSIONS.ocr)
	}
}

function unknownRuntimeSnapshot() {
	return {
		release: { id: null, gitCommit: null },
		versions: Object.fromEntries(VERSION_FIELDS.map((field) => [
			field,
			field === 'event' ? EVENT_CONTRACT_VERSION : null
		]))
	}
}

function currentRuntimeSnapshot() {
	return {
		release: runtimeReleaseSnapshot(),
		versions: runtimeVersionSnapshot()
	}
}

function createTerminalEventSnapshot(value, runtime = currentRuntimeSnapshot()) {
	const source = exactObject(value, [
		'supportRef', 'traceId', 'status', 'code', 'errorClass', 'stage',
		'diagnostic', 'serverTime'
	], 'terminal event input')
	if (typeof source.status !== 'string') throw invalidEvent('terminal status must be a string')
	if (source.status === 'failed' && typeof source.code !== 'string') {
		throw invalidEvent('failure code must be a string')
	}
	if (source.status === 'failed' && typeof source.errorClass !== 'string') {
		throw invalidEvent('failure class must be a string')
	}
	if (typeof source.stage !== 'string') throw invalidEvent('failure stage must be a string')
	const status = source.status
	const failure = status === 'failed' ? terminalCodeDefinition(source.code, source.errorClass) : null
	return buildTrustedTerminalEvent({
		schemaVersion: EVENT_CONTRACT_VERSION,
		supportRef: source.supportRef,
		traceId: source.traceId,
		status,
		code: failure ? failure.code : null,
		errorClass: failure ? failure.errorClass : null,
		stage: failure ? failure.stage : 'succeeded',
		retryable: failure ? failure.retryable : null,
		safeMessageKey: failure ? failure.safeMessageKey : null,
		diagnostic: failure ? source.diagnostic : null,
		release: runtime.release,
		versions: runtime.versions,
		serverTime: source.serverTime
	})
}

function canonicalTime(value, label) {
	if (typeof value !== 'string') throw invalidEvent(`${label} must be a string`)
	const normalized = value
	if (!ISO_TIME_RE.test(normalized) || new Date(normalized).toISOString() !== normalized) {
		throw invalidEvent(`${label} must be a canonical UTC time`)
	}
	return normalized
}

function normalizeRelease(value) {
	const source = exactObject(value, ['id', 'gitCommit'], 'release')
	if (source.id !== null && typeof source.id !== 'string') throw invalidEvent('release id must be a string')
	if (source.gitCommit !== null && typeof source.gitCommit !== 'string') {
		throw invalidEvent('release git commit must be a string')
	}
	const id = source.id
	const gitCommit = source.gitCommit === null ? null : source.gitCommit.toLowerCase()
	if (id === null && gitCommit === null) return { id: null, gitCommit: null }
	const resolved = resolveApiReleaseIdentity(id, gitCommit)
	if (!resolved.id || !resolved.gitCommit) throw invalidEvent('release identity is invalid')
	return resolved
}

function normalizeVersions(value) {
	const source = exactObject(value, VERSION_FIELDS, 'versions')
	for (const field of VERSION_FIELDS) {
		if (!Object.prototype.hasOwnProperty.call(source, field)) {
			throw invalidEvent('versions is incomplete')
		}
	}
	for (const field of VERSION_FIELDS) {
		if (source[field] !== null && typeof source[field] !== 'string') {
			throw invalidEvent('analysis version value must be a string')
		}
	}
	const versions = Object.fromEntries(VERSION_FIELDS.map((field) => [
		field,
		acceptedPersistedVersion(field, source[field])
	]))
	if (versions.event !== EVENT_CONTRACT_VERSION) {
		throw invalidEvent('trusted event contract version is invalid')
	}
	for (const field of VERSION_FIELDS) {
		if (versions[field] === undefined) {
			throw invalidEvent('analysis version value is invalid')
		}
	}
	return versions
}

function buildTrustedTerminalEvent(value) {
	const source = exactObject(value, [
		'schemaVersion', 'supportRef', 'traceId', 'status', 'code', 'errorClass',
		'stage', 'retryable', 'safeMessageKey', 'diagnostic', 'release',
		'versions', 'serverTime'
	], 'trusted event')
	if (source.schemaVersion !== EVENT_CONTRACT_VERSION) {
		throw invalidEvent('trusted event schema version is invalid')
	}
	if (typeof source.supportRef !== 'string' || typeof source.traceId !== 'string') {
		throw invalidEvent('trusted identifiers must be strings')
	}
	const supportRef = source.supportRef
	const traceId = source.traceId
	if (!SUPPORT_REF_RE.test(supportRef)) throw invalidEvent('support reference is invalid')
	if (!TRACE_ID_RE.test(traceId)) throw invalidEvent('trace id is invalid')

	if (typeof source.status !== 'string') throw invalidEvent('terminal status must be a string')
	const status = source.status
	if (!['succeeded', 'failed'].includes(status)) throw invalidEvent('terminal status is invalid')
	if (source.code !== null && typeof source.code !== 'string') throw invalidEvent('terminal code must be a string')
	const rawCode = source.code
	const code = rawCode !== null && /^[A-Z][A-Z0-9_]{1,63}$/.test(rawCode) ? rawCode : null
	if (typeof source.stage !== 'string') throw invalidEvent('terminal stage must be a string')
	const stage = source.stage
	if (!/^[a-z][a-z0-9_-]{0,63}$/.test(stage)) throw invalidEvent('terminal stage is invalid')
	if (source.errorClass !== null && typeof source.errorClass !== 'string') {
		throw invalidEvent('failure class must be a string')
	}
	const errorClass = source.errorClass
	const retryable = source.retryable === null ? null : source.retryable
	if (source.safeMessageKey !== null && typeof source.safeMessageKey !== 'string') {
		throw invalidEvent('failure message key must be a string')
	}
	const safeMessageKey = source.safeMessageKey
	if (status === 'succeeded') {
		if (
			code !== null || errorClass !== null || retryable !== null ||
			safeMessageKey !== null || stage !== 'succeeded' || source.diagnostic !== null
		) {
			throw invalidEvent('success terminal semantics are invalid')
		}
	} else {
		if (!code || !Object.prototype.hasOwnProperty.call(TERMINAL_CODE_DEFINITIONS, code)) {
			throw invalidEvent('failure code is invalid')
		}
		if (!ERROR_CLASSES.has(errorClass)) throw invalidEvent('failure class is invalid')
		const configured = TERMINAL_CODE_DEFINITIONS[code]
		const choices = Array.isArray(configured) ? configured : [configured]
		const expected = choices.find((item) => (
			item.errorClass === errorClass && item.stage === stage &&
			item.retryable === retryable && item.safeMessageKey === safeMessageKey
		))
		if (!expected) {
			throw invalidEvent('failure code classification is inconsistent')
		}
		if (!SAFE_MESSAGE_KEYS.has(safeMessageKey)) {
			throw invalidEvent('failure message key is invalid')
		}
	}

	return {
		schemaVersion: EVENT_CONTRACT_VERSION,
		supportRef,
		traceId,
		status,
		code,
		errorClass,
		stage,
		retryable,
		safeMessageKey,
		diagnostic: status === 'failed'
			? sanitizeAnalysisFailureDiagnostic(source.diagnostic)
			: null,
		release: normalizeRelease(source.release),
		versions: normalizeVersions(source.versions),
		serverTime: canonicalTime(source.serverTime, 'serverTime')
	}
}

function parseTrustedTerminalEventRow(row) {
	if (!row) return null
	try {
		return buildTrustedTerminalEvent({
			schemaVersion: row.schema_version,
			supportRef: row.support_ref,
			traceId: row.trace_id,
			status: row.status,
			code: row.code === null ? null : row.code,
			errorClass: row.error_class === null ? null : row.error_class,
			stage: row.stage,
			retryable: row.retryable === null ? null : row.retryable === 1,
			safeMessageKey: row.safe_message_key === null ? null : row.safe_message_key,
			diagnostic: JSON.parse(String(row.diagnostic_json || '')),
			release: JSON.parse(String(row.release_json || '')),
			versions: JSON.parse(String(row.versions_json || '')),
			serverTime: row.server_time
		})
	} catch (_) {
		return null
	}
}

module.exports = {
	SUPPORT_REF_RE,
	TRACE_ID_RE,
	EVENT_CONTRACT_VERSION,
	VERSION_FIELDS,
	SAFE_MESSAGE_KEYS,
	TERMINAL_CODE_DEFINITIONS,
	createSupportRef,
	createTraceId,
	normalizeTerminalCode,
	terminalCodeDefinition,
	normalizeProgressStage,
	currentRuntimeSnapshot,
	unknownRuntimeSnapshot,
	createTerminalEventSnapshot,
	buildTrustedTerminalEvent,
	parseTrustedTerminalEventRow
}
