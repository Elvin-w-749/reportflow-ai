'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const PROCESS_LOCAL_SECRET = crypto.randomBytes(32)
const MIN_ANALYSIS_SECRET_BYTES = 32
const PROJECT_ROOT = path.join(__dirname, '..', '..')

function hashSourceFiles(label, relativePaths) {
	const hash = crypto.createHash('sha256')
	hash.update(label)
	hash.update('\0')
	for (const relativePath of relativePaths) {
		hash.update(relativePath)
		hash.update('\0')
		try {
			hash.update(fs.readFileSync(path.join(PROJECT_ROOT, relativePath)))
		} catch (_) {
			hash.update('missing')
		}
		hash.update('\0')
	}
	return hash.digest('hex')
}

// 绑定实际实现而不只依赖人工版本号。prompt/schema 所在服务文件、规则源或
// OCR 模型身份任一变化，analysisKey 都会自动变化。
const IMPLEMENTATION_HASHES = Object.freeze({
	promptHash: hashSourceFiles('credit-prompt-v1', [
		'backend/services/creditAnalysisService.js',
		'package-lock.json'
	]),
	schemaHash: hashSourceFiles('credit-schema-v1', [
		'backend/services/creditAnalysisService.js'
	]),
	ruleHash: hashSourceFiles('credit-rule-v1', [
		'creditRuleEngine.js',
		'backend/scoringAlgorithms.cjs',
		'backend/services/creditCardUtilization.js',
		'backend/services/queryWindowPolicy.js'
	]),
	ocrHash: hashSourceFiles('credit-ocr-v1', [
		'ocr/models.sha256',
		'ocr/rapidocr_identity.py',
		'ocr/requirements.lock.txt',
		'rapidOcrIdentity.js',
		'localOcr.js',
		'moonshotVision.js',
		'pdfVision.js',
		'server.js',
		'package-lock.json'
	]),
	evidenceHash: hashSourceFiles('credit-evidence-v7-global-card-binding-currency-closed', [
		'backend/services/analysisIdentity.js',
		'backend/services/analysisCoordinator.js',
		'backend/services/analysisTaskService.js',
		'backend/services/creditEvidenceLedger.js',
		'backend/services/creditAnalysisService.js',
		'backend/services/creditCardUtilization.js',
		'backend/scoringAlgorithms.cjs',
		'creditRuleEngine.js',
		'pdfVision.js',
		'server.js'
	])
})

function configuredSecret() {
	const candidates = [
		process.env.ANALYSIS_KEY_SECRET,
		process.env.ANALYSIS_CACHE_SECRET
	]
	for (const candidate of candidates) {
		const value = String(candidate || '').trim()
		if (Buffer.byteLength(value, 'utf8') >= MIN_ANALYSIS_SECRET_BYTES) return value
	}
	return ''
}

function secretBuffer() {
	const value = configuredSecret()
	return value ? Buffer.from(value, 'utf8') : PROCESS_LOCAL_SECRET
}

function hmac(label, value) {
	const digest = crypto.createHmac('sha256', secretBuffer())
	digest.update(String(label))
	digest.update('\0')
	if (Buffer.isBuffer(value)) digest.update(value)
	else digest.update(String(value))
	return digest.digest('hex')
}

function buildAnalysisScopeHmac(scope) {
	const scopeValue = String(scope || '').trim()
	if (!scopeValue || /(^|:)anonymous($|:)/i.test(scopeValue)) {
		const error = new Error('a stable tenant/user analysis scope is required')
		error.code = 'ANALYSIS_SCOPE_REQUIRED'
		throw error
	}
	return `sh_${hmac('analysis-scope-v1', scopeValue)}`
}

function lengthFrame(value) {
	const out = Buffer.allocUnsafe(8)
	out.writeBigUInt64BE(BigInt(value))
	return out
}

function contentPart(value) {
	if (Buffer.isBuffer(value)) return { label: 'buffer', bytes: value }
	if (typeof value === 'string') return { label: 'utf8', bytes: Buffer.from(value, 'utf8') }
	if (value && typeof value === 'object' && Buffer.isBuffer(value.buffer)) {
		return {
			label: String(value.label || value.mimeType || value.mimetype || 'buffer').slice(0, 128),
			bytes: value.buffer
		}
	}
	throw new TypeError('analysis content part must be a Buffer, string, or { buffer }')
}

/**
 * 按顺序、带长度边界地 HMAC 输入。多图不需要 Buffer.concat，因此不会为了生成键
 * 再复制一份大文件；页序、MIME 标签或任一字节改变都会生成不同的 analysisKey。
 */
function contentHmac(content) {
	const values = Array.isArray(content) ? content : [content]
	if (values.length === 0) throw new TypeError('analysis content must not be empty')
	const digest = crypto.createHmac('sha256', secretBuffer())
	digest.update('analysis-content-framed-v2')
	digest.update('\0')
	digest.update(lengthFrame(values.length))
	for (const value of values) {
		const part = contentPart(value)
		const label = Buffer.from(part.label, 'utf8')
		digest.update(lengthFrame(label.length))
		digest.update(label)
		digest.update(lengthFrame(part.bytes.length))
		digest.update(part.bytes)
	}
	return digest.digest('hex')
}

function stableStringify(value) {
	if (value === null || typeof value !== 'object') return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
	const keys = Object.keys(value).sort()
	return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function buildArtifactHash(prefix, value) {
	const normalizedPrefix = String(prefix || '').trim().toLowerCase()
	if (!/^[a-z][a-z0-9]{1,15}_v\d+$/.test(normalizedPrefix)) {
		throw new TypeError('artifact hash prefix is invalid')
	}
	return `${normalizedPrefix}_${hmac(
		`credit-artifact:${normalizedPrefix}`,
		stableStringify(value)
	)}`
}

function finiteNumber(value, fallback) {
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : fallback
}

function positiveInt(value, fallback) {
	const parsed = Number(value)
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function hashedConfiguration(label, value) {
	return crypto
		.createHash('sha256')
		.update(label)
		.update('\0')
		.update(String(value || ''))
		.digest('hex')
}

function analysisVersions() {
	const model = String(process.env.DEEPSEEK_TEXT_MODEL || 'deepseek-v4-flash').trim() || 'deepseek-v4-flash'
	const endpoint = String(
		process.env.DEEPSEEK_CHAT_URL || 'https://api.deepseek.com/v1/chat/completions'
	).trim()
	const visionKeyConfigured = Boolean(
		String(process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY || '').trim()
	)
	const configuredOcrProvider = String(process.env.OCR_PROVIDER || '').trim().toLowerCase()
	const ocrProvider = configuredOcrProvider === 'tesseract'
		? 'local'
		: configuredOcrProvider || (visionKeyConfigured ? 'moonshot' : 'local')
	const ocrVisionEndpoint = String(
		process.env.MOONSHOT_CHAT_URL ||
		process.env.KIMI_CHAT_URL ||
		'https://api.moonshot.cn/v1/chat/completions'
	).trim()
	const ocrVisionModel = String(
		process.env.KIMI_VISION_MODEL ||
		process.env.MOONSHOT_VISION_MODEL ||
		'moonshot-v1-8k-vision-preview'
	).trim()
	const localPsm = Math.min(13, positiveInt(process.env.TESSERACT_PSM, 6))
	const rapidConfidence = Math.max(
		0.9,
		Math.min(1, finiteNumber(process.env.RAPIDOCR_IDENTITY_MIN_CONFIDENCE, 0.9))
	)
	return Object.freeze({
		pipeline: String(process.env.CREDIT_ANALYSIS_PIPELINE_VERSION || 'credit-analysis-v14-global-card-binding-currency-closed'),
		ocr: String(process.env.CREDIT_OCR_VERSION || 'rapidocr-v1'),
		prompt: String(process.env.CREDIT_PROMPT_VERSION || 'credit-facts-v8-query-source'),
		schema: String(process.env.CREDIT_SCHEMA_VERSION || 'credit-facts-schema-v6-evidence-closure'),
		evidenceContract: 'evidence-ledger-v2.1',
		evidenceBinder: 'deterministic-global-card-binding-v8-notactivated-closed-state',
		sharedCreditPolicy: 'explicit-source-token-only-v3',
		derivedTrace: 'derived-analysis-provenance-v4',
		factExtractionStrategy: 'deterministic-nonoverlap-chunks-v1',
		queryExtractionStrategy: 'deterministic-source-rows-controlled-layout-v4-terminal-section',
		verifiedQueryInputStrategy: 'strip-verified-institution-query-section-v4-terminal-or-bounded',
		textPdfPageStrategy: 'deterministic-page-markers-v1',
		model,
		thinking: 'disabled',
		temperature: 0,
		responseFormat: 'json_object',
		inputMaxChars: Number(process.env.DEEPSEEK_INPUT_MAX_CHARS || 240000),
		outputMaxTokens: Number(process.env.DEEPSEEK_OUTPUT_MAX_TOKENS || 131072),
		documentMaxChars: positiveInt(process.env.CREDIT_DOCUMENT_MAX_CHARS, 1000000),
		chunkTriggerChars: positiveInt(process.env.DEEPSEEK_CHUNK_TRIGGER_CHARS, 60000),
		chunkTriggerPages: positiveInt(process.env.DEEPSEEK_CHUNK_TRIGGER_PAGES, 8),
		chunkMaxChars: positiveInt(process.env.DEEPSEEK_CHUNK_MAX_CHARS, 40000),
		chunkMaxPages: positiveInt(process.env.DEEPSEEK_CHUNK_MAX_PAGES, 3),
		chunkConcurrency: Math.min(4, positiveInt(process.env.DEEPSEEK_CHUNK_CONCURRENCY, 3)),
		chunkOutputMaxTokens: positiveInt(process.env.DEEPSEEK_CHUNK_OUTPUT_MAX_TOKENS, 32768),
		endpointHash: crypto.createHash('sha256').update(endpoint).digest('hex'),
		ocrMaxPages: Number(process.env.SCANNED_PDF_MAX_PAGES || 80),
		ocrRenderScale: Number(process.env.SCANNED_PDF_RENDER_SCALE || 2),
		ocrConcurrency: positiveInt(process.env.SCANNED_PDF_OCR_CONCURRENCY, 3),
		ocrQueryRescueAttempts: Math.max(
			0,
			finiteNumber(process.env.SCANNED_PDF_QUERY_RESCUE_ATTEMPTS, 2)
		),
		ocrQueryRescueTileOffset: Math.max(
			1,
			finiteNumber(process.env.SCANNED_PDF_QUERY_RESCUE_TILE_OFFSET, 450)
		),
		ocrQueryRescueStrategy: 'full-query-pages-controlled-layout-two-pass-consensus-v4',
		ocrPdfRenderStrategy: 'bounded-streaming-pages-v1',
		ocrProvider,
		ocrVisionModel,
		ocrVisionTemperature: finiteNumber(
			process.env.KIMI_VISION_TEMPERATURE || process.env.MOONSHOT_VISION_TEMPERATURE,
			0
		),
		ocrVisionEndpointHash: hashedConfiguration('ocr-vision-endpoint-v1', ocrVisionEndpoint),
		ocrTileMaxHeight: Math.max(600, finiteNumber(process.env.OCR_TILE_MAX_HEIGHT, 900)),
		localOcrTileMaxHeight: Math.max(
			1200,
			finiteNumber(process.env.LOCAL_OCR_TILE_MAX_HEIGHT, 4000)
		),
		ocrTileMaxWidth: Math.max(800, finiteNumber(process.env.OCR_TILE_MAX_WIDTH, 1400)),
		localOcrLanguage: String(process.env.TESSERACT_LANG || 'chi_sim+eng').trim() || 'chi_sim+eng',
		localOcrPsm: localPsm,
		localOcrThreads: String(process.env.OCR_TESSERACT_THREADS || '1'),
		localOcrBinaryHash: hashedConfiguration(
			'local-ocr-binary-v1',
			String(process.env.TESSERACT_BIN || 'tesseract').trim() || 'tesseract'
		),
		rapidOcrIdentityEnabled: String(
			process.env.RAPIDOCR_IDENTITY_ENABLED || 'false'
		).toLowerCase() === 'true',
		rapidOcrIdentityMinConfidence: rapidConfidence,
		rapidOcrPythonHash: hashedConfiguration(
			'rapidocr-python-v1',
			String(process.env.RAPIDOCR_PYTHON || '').trim()
		),
		rule: String(process.env.CREDIT_RULE_VERSION || 'credit-rules-deterministic-v3'),
		...IMPLEMENTATION_HASHES
	})
}

/**
 * 生成不可逆的分析身份。
 *
 * contentDigest 是 HMAC，不是裸 SHA-256；它只在本函数内参与 analysisKey 计算，
 * 不返回、不落库、不进日志。scope 也先 HMAC，避免用户 ID 或服务凭证进入数据库。
 */
function buildAnalysisIdentity({ content, scope, inputKind }) {
	const versions = analysisVersions()
	const scopeHmac = buildAnalysisScopeHmac(scope)
	const contentDigest = contentHmac(content)
	const normalizedInputKind = String(inputKind || 'unknown')
	// Tenant-scoped, irreversible document identity derived from the original
	// uploaded bytes (or ordered image/text input), not from model/OCR output.
	// This lets the evidence manifest stay bound to the coordinator's exact
	// content while avoiding cross-tenant correlation and raw digest exposure.
	const documentId = `doc_v2_${hmac('document-id-v2', stableStringify({
		scopeHmac,
		contentDigest,
		inputKind: normalizedInputKind
	}))}`
	const material = stableStringify({
		scopeHmac,
		contentDigest,
		inputKind: normalizedInputKind,
		versions
	})
	const analysisKey = `ak_v3_${hmac('analysis-key-v3', material)}`
	return { analysisKey, scopeHmac, documentId, versions, inputKind: normalizedInputKind }
}

/**
 * 只覆盖 canonical 业务结果。调用方必须在加入 cacheHit/requestId/耗时/createdAt
 * 等传输元数据之前计算。
 */
function buildResultHash(canonicalResult) {
	return `rh_v1_${hmac('analysis-result-v1', stableStringify(canonicalResult))}`
}

function identityRuntimeStatus() {
	const stable = configuredSecret().length > 0
	return {
		stableAcrossRestart: stable,
		keySource: stable ? 'configured-secret' : 'process-local-secret',
		minSecretBytes: MIN_ANALYSIS_SECRET_BYTES
	}
}

module.exports = {
	analysisVersions,
	buildAnalysisScopeHmac,
	buildAnalysisIdentity,
	buildArtifactHash,
	buildResultHash,
	identityRuntimeStatus,
	stableStringify
}
