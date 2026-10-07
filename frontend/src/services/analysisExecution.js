const objectValue = (value) => (
	value && typeof value === 'object' && !Array.isArray(value) ? value : {}
)

const ANALYSIS_KEY_RE = /^ak_v3_[a-f0-9]{64}$/
const RESULT_HASH_RE = /^rh_v1_[a-f0-9]{64}$/

const stableAuditIdentity = (value, pattern) => {
	const text = String(value || '').trim()
	return pattern.test(text) ? text : ''
}

/**
 * Split async-job execution metadata into two views:
 * - ui: may contain cacheHit/cacheSource so the progress page can explain reuse;
 * - persisted: contains only stable audit identities, so retrying the same job cannot
 *   change the report content fingerprint merely because the job was cache-backed.
 */
export const buildAnalysisExecutionViews = (serverExecution, remoteJob = {}) => {
	const source = objectValue(serverExecution)
	const ui = { ...source }
	if (typeof remoteJob?.cacheHit === 'boolean') ui.cacheHit = remoteJob.cacheHit
	if (remoteJob?.cacheHit === true && !String(ui.cacheSource || '').trim()) {
		ui.cacheSource = 'async-cache'
	}

	const persisted = {}
	const analysisKey = stableAuditIdentity(source.analysisKey || source.analysis_key, ANALYSIS_KEY_RE)
	const resultHash = stableAuditIdentity(source.resultHash || source.result_hash, RESULT_HASH_RE)
	if (analysisKey) persisted.analysisKey = analysisKey
	if (resultHash) persisted.resultHash = resultHash

	return { ui, persisted }
}

export default { buildAnalysisExecutionViews }
