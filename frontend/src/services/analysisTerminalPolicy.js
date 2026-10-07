const POLICIES = new Map()

const add = (codes, errorClass, stage, retryable, safeMessageKey) => {
	const signature = `${errorClass}\0${stage}\0${retryable ? '1' : '0'}\0${safeMessageKey}`
	for (const code of codes) {
		const existing = POLICIES.get(code) || new Set()
		existing.add(signature)
		POLICIES.set(code, existing)
	}
}

add(['GLM_OCR_NOT_CONFIGURED', 'RAPIDOCR_CONFIG_ERROR', 'RAPIDOCR_DISABLED', 'RAPIDOCR_MODEL_INTEGRITY_ERROR'], 'configuration_permanent', 'ocr-config', false, 'provider-configuration-unavailable')
add(['GLM_OCR_NETWORK_ERROR'], 'transport_transient', 'ocr-provider', true, 'provider-connection-interrupted')
add(['GLM_OCR_CONNECT_TIMEOUT', 'GLM_OCR_PAGE_TIMEOUT'], 'transport_transient', 'ocr-provider', true, 'provider-timeout')
add(['GLM_OCR_HTTP_408'], 'upstream_transient', 'ocr-provider', true, 'provider-timeout')
add(['GLM_OCR_RATE_LIMITED', 'GLM_OCR_PROVIDER_UNAVAILABLE', 'GLM_OCR_PROVIDER_ERROR', 'OCR_UPSTREAM_FAILED'], 'upstream_transient', 'ocr-provider', true, 'provider-temporarily-unavailable')
add(['GLM_OCR_BAD_REQUEST'], 'input_permanent', 'ocr-provider', false, 'analysis-input-rejected')
add(['GLM_OCR_CLIENT_ERROR', 'GLM_OCR_AUTH_FAILED', 'GLM_OCR_FORBIDDEN', 'OCR_UPSTREAM_FAILED'], 'configuration_permanent', 'ocr-provider', false, 'provider-configuration-unavailable')
add(['GLM_OCR_INPUT_TOO_LARGE', 'RAPIDOCR_INVALID_INPUT'], 'input_permanent', 'ocr-preflight', false, 'analysis-input-rejected')
add(['GLM_OCR_RESPONSE_INVALID', 'RAPIDOCR_INVALID_RESULT'], 'schema_permanent', 'ocr-normalize', false, 'provider-response-invalid')
add(['GLM_OCR_PAGE_COVERAGE_MISMATCH', 'OCR_RECORD_MEMBERSHIP_UNPROVEN', 'OCR_READING_ORDER_CONFLICT'], 'evidence_permanent', 'ocr-normalize', false, 'evidence-structure-unproven')
add(['OCR_STAGE_DEADLINE_EXCEEDED', 'RAPIDOCR_QUEUE_TIMEOUT'], 'transport_transient', 'ocr-provider', true, 'analysis-deadline-exceeded')
add(['DEEPSEEK_NOT_CONFIGURED'], 'configuration_permanent', 'fact-extraction-config', false, 'provider-configuration-unavailable')
add(['DEEPSEEK_NETWORK_ERROR'], 'transport_transient', 'fact-extraction', true, 'provider-connection-interrupted')
add(['DEEPSEEK_TIMEOUT'], 'transport_transient', 'fact-extraction', true, 'provider-timeout')
add(['DEEPSEEK_HTTP_408'], 'upstream_transient', 'fact-extraction', true, 'provider-timeout')
add(['DEEPSEEK_HTTP_409', 'DEEPSEEK_HTTP_425', 'DEEPSEEK_RATE_LIMITED', 'DEEPSEEK_PROVIDER_UNAVAILABLE', 'ANALYSIS_UPSTREAM_FAILED'], 'upstream_transient', 'fact-extraction', true, 'provider-temporarily-unavailable')
add(['DEEPSEEK_BAD_REQUEST', 'DEEPSEEK_CLIENT_ERROR', 'DEEPSEEK_AUTH_FAILED', 'DEEPSEEK_FORBIDDEN', 'ANALYSIS_UPSTREAM_FAILED'], 'configuration_permanent', 'fact-extraction', false, 'provider-configuration-unavailable')
add(['DEEPSEEK_INPUT_TOO_LARGE'], 'input_permanent', 'fact-extraction-preflight', false, 'analysis-input-rejected')
add(['DEEPSEEK_CONTEXT_LIMIT'], 'input_permanent', 'fact-extraction', false, 'analysis-input-rejected')
add(['DEEPSEEK_RESPONSE_INVALID', 'FACT_SCHEMA_INVALID', 'CHUNK_COVERAGE_MISMATCH', 'CHUNK_FACT_CONFLICT', 'CHUNK_FACTS_MISSING', 'CHUNK_QUERY_EVIDENCE_MISMATCH', 'CHUNK_SCALAR_CONFLICT', 'CHUNK_SOURCE_OVERVIEW_MISMATCH'], 'schema_permanent', 'fact-extraction', false, 'provider-response-invalid')
add(['DEEPSEEK_OUTPUT_TRUNCATED', 'ANALYSIS_OUTPUT_TRUNCATED', 'ANALYSIS_NON_JSON_OUTPUT'], 'upstream_transient', 'fact-extraction', true, 'provider-response-invalid')
add(['EVIDENCE_PUBLICATION_BLOCKED'], 'evidence_permanent', 'publication-gate', false, 'analysis-publication-blocked')
add(['ANALYSIS_IN_PROGRESS_TIMEOUT'], 'transport_transient', 'processing', true, 'analysis-deadline-exceeded')
add(['ANALYSIS_LEASE_LOST', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'EPIPE', 'UND_ERR_SOCKET'], 'transport_transient', 'processing', true, 'provider-connection-interrupted')
add(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'], 'transport_transient', 'processing', true, 'provider-timeout')
add(['ANALYSIS_TASK_PERSISTENCE_UNAVAILABLE', 'ANALYSIS_SCOPE_REQUIRED', 'ANALYSIS_STABLE_SECRET_REQUIRED'], 'configuration_permanent', 'queued', false, 'provider-configuration-unavailable')
add(['EVIDENCE_HASH_KEY_REQUIRED'], 'configuration_permanent', 'evidence-gate', false, 'provider-configuration-unavailable')
add(['EVIDENCE_IDENTITY_MISMATCH', 'EVIDENCE_CLOSURE_INVALID', 'EVIDENCE_DERIVATION_INVALID', 'EVIDENCE_SCOPE_INVALID', 'EVIDENCE_HASH_CHAIN_INVALID', 'EVIDENCE_DERIVATION_MISMATCH', 'EVIDENCE_META_INVALID', 'EVIDENCE_NOT_SERVER_TRUSTED', 'SOURCE_EVIDENCE_MISSING', 'QUERY_EVIDENCE_INCOMPLETE'], 'evidence_permanent', 'evidence-gate', false, 'evidence-structure-unproven')
add(['DETERMINISTIC_COVERAGE_MISSING', 'DETERMINISTIC_FACTS_INCOMPLETE', 'DETERMINISTIC_INPUT_INCOMPLETE', 'DETERMINISTIC_OUTPUT_INCOMPLETE', 'DETERMINISTIC_REPORT_DATE_MISSING', 'DETERMINISTIC_SCORE_PROJECTION_MISMATCH', 'DERIVED_METRIC_INVALID', 'DERIVED_PROJECTION_MISMATCH'], 'schema_permanent', 'rule-validation', false, 'provider-response-invalid')
add(['DETERMINISTIC_RULE_ENGINE_FAILED'], 'internal_permanent', 'rule-validation', false, 'provider-response-invalid')
add(['ANALYSIS_INPUT_TOO_LARGE', 'ANALYSIS_CONTEXT_LIMIT', 'INVALID_PDF', 'UNSUPPORTED_FILE_TYPE'], 'input_permanent', 'input-preflight', false, 'analysis-input-rejected')
add(['PDF_TEXT_LAYER_MISSING', 'PDF_PAGE_LIMIT_EXCEEDED', 'PDF_PAGE_OUT_OF_RANGE'], 'input_permanent', 'pdf-extract', false, 'analysis-input-rejected')
add(['PDF_EVIDENCE_SOURCE_UNVERIFIED'], 'input_permanent', 'pdf-extract', false, 'evidence-structure-unproven')
add(['OCR_STRUCTURED_EVIDENCE_UNAVAILABLE', 'OCR_INCOMPLETE', 'IMAGE_OCR_INCOMPLETE'], 'input_permanent', 'ocr', false, 'evidence-structure-unproven')
add(['OCR_TEXT_TOO_SHORT', 'IMAGE_TEXT_TOO_SHORT'], 'input_permanent', 'ocr', false, 'analysis-input-rejected')
add(['OCR_FAILED', 'OCR_PAGE_FAILED', 'OCR_QUERY_PAGE_RENDER_FAILED', 'OCR_QUERY_PAGE_RESCUE_FAILED', 'RAPIDOCR_FAILED', 'IMAGE_OCR_FAILED'], 'input_permanent', 'ocr', false, 'provider-response-invalid')
add(['ANALYSIS_TASK_INPUT_INVALID', 'ANALYSIS_TASK_SCOPE_INVALID'], 'input_permanent', 'queued', false, 'analysis-input-rejected')
add(['PDF_STRUCTURED_TEXT_FAILED'], 'input_permanent', 'pdf-extract', false, 'provider-response-invalid')
add(['ANALYSIS_RESULT_UNAVAILABLE', 'CACHE_INTEGRITY_FAILED'], 'internal_permanent', 'cache', false, 'provider-response-invalid')
add(['ANALYSIS_EXECUTION_FAILED'], 'internal_permanent', 'processing', false, 'provider-response-invalid')
add(['ARTIFACT_CONTRACT_INVALID', 'ARTIFACT_HASH_INVALID'], 'internal_permanent', 'evidence-gate', false, 'provider-response-invalid')
add(['INVALID_CANONICAL_RESULT'], 'internal_permanent', 'persisting', false, 'provider-response-invalid')
add(['NON_AUTHORITATIVE_RESULT', 'INCOMPLETE_CANONICAL_RESULT'], 'internal_permanent', 'publication-gate', false, 'analysis-publication-blocked')
add(['CANONICAL_RESULT_TOO_LARGE'], 'internal_permanent', 'persisting', false, 'analysis-input-rejected')
add(['ANALYSIS_FAILED'], 'unknown_permanent', 'unknown', false, 'provider-response-invalid')

export const KNOWN_TERMINAL_CODES = Object.freeze([...POLICIES.keys()])

export function terminalPolicySignatures() {
	return Object.fromEntries(
		[...POLICIES.entries()].map(([code, signatures]) => [code, [...signatures].sort()])
	)
}

export function validTerminalFailureEnvelope(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const { code, errorClass, stage, retryable, safeMessageKey } = value
	if (
		typeof code !== 'string' || typeof errorClass !== 'string' ||
		typeof stage !== 'string' || typeof retryable !== 'boolean' ||
		typeof safeMessageKey !== 'string'
	) return false
	const signature = `${errorClass}\0${stage}\0${retryable ? '1' : '0'}\0${safeMessageKey}`
	return POLICIES.get(code)?.has(signature) === true
}
