export const DETERMINISTIC_ANALYSIS_MODE = 'deterministic-v1'

// Evidence v2 grants authority to individual fields, never to the whole
// analysis object. Keep this registry aligned with the backend publication
// contract; serverAnalyzeMapper imports the same list so filtering cannot
// silently narrow (or broaden) the declared scope.
export const AUTHORITATIVE_EVIDENCE_PATHS = Object.freeze([
	'credit_debt.total_debt',
	'credit_debt.credit_loans.total_balance',
	'credit_debt.credit_cards.total_limit',
	'credit_debt.credit_cards.total_used',
	'credit_debt.credit_cards.utilization_used',
	'credit_debt.credit_cards.usage_rate',
	'credit_debt.credit_cards.shared_group_count',
	'query_analysis.summary.last_1m.total',
	'query_analysis.summary.last_3m.total',
	'query_analysis.summary.last_6m.total',
	'query_analysis.summary.last_12m.total',
	'primary_rule_score.score'
])

const objectValue = (value) => (
	value && typeof value === 'object' && !Array.isArray(value) ? value : {}
)

const ANALYSIS_ROOT_KEYS = [
	'analysisResult',
	'analysis_result',
	'result',
	'analysis',
	'payload',
	'data',
	'credit_report_full',
	'creditReportV2',
	'credit_report_v2'
]

const analysisRoots = (value) => {
	const pending = [objectValue(value)]
	const roots = []
	const seen = new Set()

	while (pending.length) {
		const root = objectValue(pending.shift())
		if (!Object.keys(root).length || seen.has(root)) continue
		seen.add(root)
		roots.push(root)
		for (const key of ANALYSIS_ROOT_KEYS) pending.push(objectValue(root[key]))
	}

	return roots
}

// A JSON object cannot prove that it came from the authenticated API merely
// by copying `authority: server-deterministic`. Network adapters brand the
// in-memory response object here. JSON round-trips, localStorage copies and
// caller-created objects deliberately lose this brand and become archival.
const serverAnalysisResponses = new WeakSet()
const mappedServerAnalyses = new WeakSet()

export const markServerAnalysisResponse = (value) => {
	for (const root of analysisRoots(value)) serverAnalysisResponses.add(root)
	return value
}

// Mapper output contains archival aliases that may repeat the canonical root.
// Brand only the normalized outer projection so those aliases cannot create a
// second competing authority root.
export const markMappedServerAnalysis = (value) => {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		serverAnalysisResponses.add(value)
		mappedServerAnalyses.add(value)
	}
	return value
}

const derivationMetaOf = (root) => objectValue(root.derivation_meta || root.derivationMeta)

const analysisAuditOf = (root) => {
	const meta = derivationMetaOf(root)
	const analysisMeta = objectValue(root.analysis_meta || root.analysisMeta)
	const cachePolicy = objectValue(
		analysisMeta.cachePolicy ||
		analysisMeta.cache_policy ||
		root.cachePolicy ||
		root.cache_policy
	)
	return {
		analysisKey: String(
			root.analysisKey ||
			root.analysis_key ||
			analysisMeta.analysisKey ||
			analysisMeta.analysis_key ||
			meta.analysis_key ||
			meta.analysisKey ||
			''
		).trim(),
		resultHash: String(
			root.resultHash ||
			root.result_hash ||
			analysisMeta.resultHash ||
			analysisMeta.result_hash ||
			meta.result_hash ||
			meta.resultHash ||
			''
		).trim(),
		serverAuthoritative: analysisMeta.authoritative === true,
		authority: String(analysisMeta.authority || '').trim().toLowerCase(),
		cachePolicy: {
			persistent: cachePolicy.persistent === true,
			stableAcrossRestart:
				cachePolicy.stableAcrossRestart === true ||
				cachePolicy.stable_across_restart === true
		}
	}
}

const deterministicMarkerRoots = (value) => analysisRoots(value).filter((root) => {
	const meta = derivationMetaOf(root)
	const authority = objectValue(root.authority)
	return String(meta.mode || authority.mode || '').trim().toLowerCase() === DETERMINISTIC_ANALYSIS_MODE
})

const safeAuthoritativeScope = (...values) => {
	for (const value of values) {
		const fields = Array.isArray(value)
			? value
			: Array.isArray(objectValue(value).fields) ? objectValue(value).fields : null
		if (!fields) continue
		const declared = new Set(fields.filter((field) => typeof field === 'string'))
		return AUTHORITATIVE_EVIDENCE_PATHS.filter((field) => declared.has(field))
	}
	return []
}

const authoritativeScopeOf = (root) => {
	const analysisMeta = objectValue(root.analysis_meta || root.analysisMeta)
	const evidenceMeta = objectValue(root.evidence_meta || root.evidenceMeta)
	return safeAuthoritativeScope(
		analysisMeta.authoritativeScope,
		analysisMeta.authoritative_scope,
		root.authoritativeScope,
		root.authoritative_scope,
		evidenceMeta.authoritative_scope,
		evidenceMeta.authoritativeScope
	)
}

const hasCompleteAuthoritativeScope = (scope) => (
	Array.isArray(scope) &&
	scope.length === AUTHORITATIVE_EVIDENCE_PATHS.length &&
	AUTHORITATIVE_EVIDENCE_PATHS.every((field) => scope.includes(field))
)

export const getServerAnalysisAuthority = (value) => {
	const markerRoots = deterministicMarkerRoots(value)
	const validRoots = markerRoots.filter(isValidAuthoritativeRoot)
	const markerRoot = validRoots.length === 1 ? validRoots[0] : markerRoots[0]
	if (markerRoot) {
		const root = markerRoot
		const meta = derivationMetaOf(root)
		const authority = objectValue(root.authority)
		const audit = analysisAuditOf(root)
		const authoritativeScope = authoritativeScopeOf(root)
		const envelopeValid = hasCurrentDeterministicEnvelope(root)
		const evidenceComplete = hasPublishableEvidenceMeta(root)
		const responseTrusted = serverAnalysisResponses.has(root)
		const scopeComplete = hasCompleteAuthoritativeScope(authoritativeScope)
		const scopeValuesComplete = hasAuthoritativeScopeValues(root, authoritativeScope)
		const contractComplete = hasCompleteLegacyDeterministicContract(value)
		const unambiguousRoot = validRoots.length === 1
		const authoritative = responseTrusted && evidenceComplete && envelopeValid &&
			scopeComplete && scopeValuesComplete && unambiguousRoot
		return {
			authoritative,
			compatibility: !authoritative,
			mode: authoritative ? DETERMINISTIC_ANALYSIS_MODE : 'deterministic-incomplete',
			serverMode: DETERMINISTIC_ANALYSIS_MODE,
			// `authoritative` means the deterministic server envelope and its
			// declared field scope are valid. It must not be interpreted as
			// whole-object authority.
			wholeObjectAuthoritative: false,
			fieldScoped: authoritativeScope.length > 0,
			envelopeValid,
			evidenceComplete,
			responseTrusted,
			unambiguousRoot,
			scopeComplete,
			scopeValuesComplete,
			// Compatibility diagnostic only. Non-scope fields must never affect
			// `authoritative` or an individual field-authority decision.
			contractComplete,
			authoritativeScope,
			anchorDate: String(meta.anchor_date || meta.anchorDate || authority.anchor_date || authority.anchorDate || '').trim(),
			modelRole: String(meta.model_role || meta.modelRole || authority.model_role || authority.modelRole || '').trim(),
			...audit
		}
	}

	const declaredMode = analysisRoots(value)
		.map((root) => {
			const meta = derivationMetaOf(root)
			return String(meta.mode || objectValue(root.authority).mode || '').trim().toLowerCase()
		})
		.find(Boolean)

	return {
		authoritative: false,
		compatibility: true,
		mode: 'legacy-compatible',
		serverMode: declaredMode || null,
		wholeObjectAuthoritative: false,
		fieldScoped: false,
		envelopeValid: false,
		evidenceComplete: false,
		responseTrusted: false,
		unambiguousRoot: false,
		scopeComplete: false,
		scopeValuesComplete: false,
		contractComplete: false,
		authoritativeScope: [],
		anchorDate: '',
		modelRole: '',
		analysisKey: '',
		resultHash: '',
		cachePolicy: {
			persistent: false,
			stableAcrossRestart: false
		}
	}
}

export const resolveAuthoritativeServerRoot = (value) => {
	const validRoots = deterministicMarkerRoots(value).filter(isValidAuthoritativeRoot)
	return validRoots.length === 1 ? validRoots[0] : null
}

export const isAuthoritativeServerAnalysis = (value) =>
	getServerAnalysisAuthority(value).authoritative

export const isAuthoritativeAnalysisField = (value, field) => {
	const path = String(field || '').trim()
	if (!path) return false
	const authority = value && value.authoritativeScope && typeof value.authoritative === 'boolean'
		? value
		: getServerAnalysisAuthority(value)
	return authority.authoritative === true && authority.authoritativeScope.includes(path)
}

export const getDeterministicDimensions = (value) => {
	for (const root of analysisRoots(value)) {
		const dimensions = objectValue(root.deterministic_dimensions || root.deterministicDimensions)
		if (Object.keys(dimensions).length) return dimensions
	}
	return {}
}

const isStrictFinite = (value) => (
	value !== null &&
	value !== undefined &&
	typeof value !== 'boolean' &&
	(typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
	Number.isFinite(Number(value))
)

const valueAtPath = (root, path) => String(path || '').split('.').reduce(
	(current, key) => objectValue(current)[key],
	root
)

const hasCurrentDeterministicEnvelope = (root) => {
	const meta = derivationMetaOf(root)
	if (String(meta.mode || '').trim().toLowerCase() !== DETERMINISTIC_ANALYSIS_MODE) return false
	const audit = analysisAuditOf(root)
	return (
		/^ak_v3_[a-f0-9]{64}$/.test(audit.analysisKey) &&
		/^rh_v1_[a-f0-9]{64}$/.test(audit.resultHash) &&
		audit.serverAuthoritative === true &&
		audit.authority === 'server-deterministic' &&
		audit.cachePolicy.persistent === true &&
		audit.cachePolicy.stableAcrossRestart === true
	)
}

const evidenceHashValid = (value, prefix) => (
	new RegExp(`^${prefix}_[a-f0-9]{64}$`).test(String(value || '').trim())
)

const hasPublishableEvidenceMeta = (root) => {
	const evidence = objectValue(root.evidence_meta || root.evidenceMeta)
	const derivation = derivationMetaOf(root)
	const factCount = evidence.fact_count
	const supportedFactCount = evidence.supported_fact_count
	const derivationMatches = mappedServerAnalyses.has(root) || (
		String(derivation.evidence_mode || derivation.evidenceMode || '').trim().toLowerCase() === 'evidence-v2' &&
		String(derivation.evidence_hash || derivation.evidenceHash || '') === String(evidence.evidence_hash || evidence.evidenceHash || '') &&
		String(derivation.fact_hash || derivation.factHash || '') === String(evidence.fact_hash || evidence.factHash || '') &&
		String(derivation.metric_hash || derivation.metricHash || '') === String(evidence.metric_hash || evidence.metricHash || '')
	)
	return (
		String(evidence.version || '').trim().toLowerCase() === 'evidence-v2' &&
		String(evidence.status || '').trim().toLowerCase() === 'publishable' &&
		String(evidence.publication_gate || evidence.publicationGate || '').trim().toLowerCase() === 'passed' &&
		evidenceHashValid(evidence.manifest_hash || evidence.manifestHash, 'mh_v2') &&
		evidenceHashValid(evidence.evidence_hash || evidence.evidenceHash, 'eg_v2') &&
		evidenceHashValid(evidence.fact_hash || evidence.factHash, 'fl_v2') &&
		evidenceHashValid(evidence.metric_hash || evidence.metricHash, 'da_v2') &&
		Number.isInteger(factCount) && factCount >= 0 &&
		Number.isInteger(supportedFactCount) && supportedFactCount >= 0 && supportedFactCount <= factCount &&
		derivationMatches
	)
}

const authoritativeValueValid = (path, value) => {
	if (typeof value !== 'number' || !Number.isFinite(value)) return false
	if (path === 'primary_rule_score.score') return value >= 0 && value <= 100
	if (path === 'credit_debt.credit_cards.shared_group_count' || path.includes('query_analysis.summary.')) {
		return Number.isInteger(value) && value >= 0
	}
	return value >= 0
}

const hasAuthoritativeScopeValues = (root, scope) => {
	if (!Array.isArray(scope) || scope.length === 0) return false
	if (!scope.every((path) => authoritativeValueValid(path, valueAtPath(root, path)))) return false
	const summary = objectValue(objectValue(root.query_analysis).summary)
	const windows = ['last_1m', 'last_3m', 'last_6m', 'last_12m']
		.map((key) => objectValue(summary[key]).total)
	return windows.every((value, index) => index === 0 || value >= windows[index - 1])
}

const isValidAuthoritativeRoot = (root) => {
	const scope = authoritativeScopeOf(root)
	return serverAnalysisResponses.has(root) &&
		hasCurrentDeterministicEnvelope(root) &&
		hasPublishableEvidenceMeta(root) &&
		hasCompleteAuthoritativeScope(scope) &&
		hasAuthoritativeScopeValues(root, scope)
}

const hasCompleteLegacyDeterministicContract = (value) => analysisRoots(value).some((root) => {
	const meta = derivationMetaOf(root)
	if (String(meta.mode || '').trim().toLowerCase() !== DETERMINISTIC_ANALYSIS_MODE) return false
	const audit = analysisAuditOf(root)
	const debt = objectValue(root.credit_debt)
	const loans = objectValue(debt.credit_loans)
	const cards = objectValue(debt.credit_cards)
	const query = objectValue(root.query_analysis)
	const summary = objectValue(query.summary)
	const dimensions = objectValue(root.deterministic_dimensions || root.deterministicDimensions)
	const primary = objectValue(root.primary_rule_score)
	const scores = objectValue(root.six_dimensions)
	return (
		Boolean(audit.analysisKey) &&
		Boolean(audit.resultHash) &&
		audit.cachePolicy.persistent === true &&
		audit.cachePolicy.stableAcrossRestart === true &&
		Object.keys(dimensions).length > 0 &&
		isStrictFinite(debt.total_debt) &&
		isStrictFinite(debt.debt_ratio) &&
		isStrictFinite(loans.total_balance) &&
		isStrictFinite(cards.total_limit) &&
		isStrictFinite(cards.total_used) &&
		isStrictFinite(cards.utilization_used) &&
		isStrictFinite(cards.usage_rate) &&
		isStrictFinite(cards.shared_group_count) &&
		isStrictFinite(objectValue(summary.last_1m).total) &&
		isStrictFinite(objectValue(summary.last_3m).total) &&
		isStrictFinite(objectValue(summary.last_6m).total) &&
		isStrictFinite(objectValue(summary.last_12m).total) &&
		isStrictFinite(primary.score) &&
		isStrictFinite(scores.credit_history) &&
		isStrictFinite(scores.query_frequency) &&
		isStrictFinite(scores.account_structure) &&
		isStrictFinite(scores.repayment_record)
	)
})

export const assertAuthoritativeServerAnalysis = (value) => {
	if (getServerAnalysisAuthority(value).authoritative) return value
	const declaredDeterministic = deterministicMarkerRoots(value).length > 0
	const error = new Error(declaredDeterministic
		? '服务端确定性分析结果结构不完整，已停止生成报告'
		: '服务端未返回确定性分析结果，已停止生成报告')
	error.code = declaredDeterministic
		? 'INCOMPLETE_AUTHORITATIVE_ANALYSIS_RESULT'
		: 'NON_AUTHORITATIVE_ANALYSIS_RESULT'
	error.authoritativeAnalysisFailure = true
	throw error
}

const requireAnalysisResult = async (runner) => {
	const result = await runner()
	if (result == null) {
		const error = new Error('服务端权威分析未返回结果，已停止生成报告')
		error.code = 'EMPTY_AUTHORITATIVE_ANALYSIS_RESULT'
		error.authoritativeAnalysisFailure = true
		throw error
	}
	return assertAuthoritativeServerAnalysis(result)
}

/**
 * Supported report files must stay on one authoritative server path.
 * A rejected server call is intentionally propagated and must never invoke
 * the legacy OCR + /api/ai/analyze + client-side scoring path.
 */
export const executeAuthoritativeAnalysisPath = async ({
	fileType,
	runPdfServer,
	runImageServer
}) => {
	if (fileType === 'pdf') return requireAnalysisResult(runPdfServer)
	if (fileType === 'image') return requireAnalysisResult(runImageServer)
	const error = new Error(`不支持的报告文件类型：${String(fileType || 'unknown')}`)
	error.code = 'UNSUPPORTED_REPORT_FILE_TYPE'
	error.authoritativeAnalysisFailure = true
	throw error
}

export default {
	DETERMINISTIC_ANALYSIS_MODE,
	AUTHORITATIVE_EVIDENCE_PATHS,
	getServerAnalysisAuthority,
	markMappedServerAnalysis,
	markServerAnalysisResponse,
	resolveAuthoritativeServerRoot,
	isAuthoritativeServerAnalysis,
	isAuthoritativeAnalysisField,
	getDeterministicDimensions,
	assertAuthoritativeServerAnalysis,
	executeAuthoritativeAnalysisPath
}
