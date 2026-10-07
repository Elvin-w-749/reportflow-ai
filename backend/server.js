'use strict'

const path = require('path')
// 必须从 server.js 同目录读 .env；PM2 的 cwd 若不是 ai-proxy，默认 dotenv 会读不到 Key
require('dotenv').config({ path: path.join(__dirname, '.env') })

/**
 * AI 代理（示例/可合并部署）
 *
 * 征信文本分析：DeepSeek 语义提取（10 模块 JSON）→ creditRuleEngine 数值校验/风控命中/图表组装 → 返回客户端。
 *
 * POST /api/parse-pdf
 *   body: { base64 } → { success, text }
 * POST /api/analyze-image
 *   body: { base64, mimeType } → { success, data }  // 视觉分析（当前实现兼容 Moonshot/Kimi 视觉）
 * POST /api/ai/analyze
 *   body: { text } → { success, data }               // DeepSeek 文本结构化分析
 * POST /api/analyze-text
 *   body: { text } → { success, data }               // 兼容旧版路径
 */

const express = require('express')
const cors = require('cors')
const multer = require('multer')
const rateLimit = require('express-rate-limit')
const logger = require('./backend/utils/logger')
const { isProductionRuntime: _isProductionRuntime } = require('./backend/utils/env')
const { resolveApiReleaseIdentity } = require('./backend/utils/releaseIdentity')
const { currentRuntimeSnapshot } = require('./backend/utils/trustedAnalysisEvent')
const {
	runCoordinatedAnalysis,
	cacheRuntimeStatus
} = require('./backend/services/analysisCoordinator')
const store = require('./backend/db/store')
const analysisTaskService = require('./backend/services/analysisTaskService')

// 默认只绑回环并监听 3200：与 README/backend/.env.example 的默认值、前端固定开发代理保持一致。
// 需要对外暴露时显式设置 HOST/PORT（例如容器内 HOST=0.0.0.0），不要用默认值扩大监听面。
const PORT = Number(process.env.PORT || 3200)
const HOST = String(process.env.HOST || '127.0.0.1').trim() || '127.0.0.1'
const isProductionRuntime = _isProductionRuntime()
const configuredReleaseId = String(process.env.RPT_RELEASE_ID || '').trim()
const configuredGitCommit = String(process.env.RPT_GIT_COMMIT || '').trim().toLowerCase()
const releaseIdentity = Object.freeze(resolveApiReleaseIdentity(configuredReleaseId, configuredGitCommit))
const releaseRuntimeDeclared = Boolean(configuredReleaseId || configuredGitCommit)
const MIN_TEXT_LEN = Number(process.env.PDF_MIN_TEXT_LEN || 30)
// ───── 扫描件/图片型 PDF（无文字层）OCR 兜底配置 ─────
// pdf-parse 取不到文字时，渲染每页为图片走视觉 OCR → 拼接文本 → 复用文本 LLM 流水线。
const SCANNED_PDF_OCR_ENABLED = String(process.env.SCANNED_PDF_OCR_ENABLED || 'true').toLowerCase() !== 'false'
const SCANNED_PDF_MAX_PAGES = Number(process.env.SCANNED_PDF_MAX_PAGES || 80)
const SCANNED_PDF_RENDER_SCALE = Number(process.env.SCANNED_PDF_RENDER_SCALE || 2)
const SCANNED_PDF_OCR_CONCURRENCY = Math.max(1, Number(process.env.SCANNED_PDF_OCR_CONCURRENCY || 2))
const OCR_RETRY_ATTEMPTS = Math.max(1, Number(process.env.OCR_RETRY_ATTEMPTS || process.env.SCANNED_PDF_OCR_RETRIES || 3))
const OCR_RETRY_DELAY_MS = Math.max(0, Number(process.env.OCR_RETRY_DELAY_MS || process.env.SCANNED_PDF_OCR_RETRY_DELAY_MS || 700))

function safeErrorCode(error, fallback = 'INTERNAL_ERROR') {
	const raw = String(error && error.code || '')
	return /^[A-Z0-9_]{1,64}$/.test(raw) ? raw : fallback
}

// 生产 fail-closed：关键安全配置缺失时拒绝启动，避免误配置导致网关裸奔。
function ensureProductionSecurityConfigured() {
	// A release identity is an explicit deployment marker. dotenv intentionally
	// does not override an existing PM2/shell NODE_ENV, so refuse to run a
	// release-shaped process under test/development even if the .env file says
	// production. Ordinary local development has no release marker and remains
	// unaffected.
	if (releaseRuntimeDeclared && !isProductionRuntime) {
		throw new Error('[发布门禁] 配置 RPT_RELEASE_ID/RPT_GIT_COMMIT 时 NODE_ENV 必须为 production')
	}
	if (!isProductionRuntime) return
	if (!releaseIdentity.id || !releaseIdentity.gitCommit) {
		throw new Error('[发布门禁] NODE_ENV=production 时必须配置有效的 RPT_RELEASE_ID 与 RPT_GIT_COMMIT')
	}
	const trustedRuntime = currentRuntimeSnapshot()
	if (
		!trustedRuntime.release.id || !trustedRuntime.release.gitCommit ||
		Object.values(trustedRuntime.versions).some((value) => value === null)
	) {
		throw new Error('[发布门禁] trusted terminal release/version identity is invalid')
	}
	const required = String(process.env.DEV_ANALYZE_BEARER || '').trim()
	if (!required) {
		throw new Error('[安全门禁] NODE_ENV=production 时必须配置 DEV_ANALYZE_BEARER，拒绝以无鉴权模式启动')
	}
	const smsProvider = String(process.env.SMS_PROVIDER || '').trim().toLowerCase()
	if (!smsProvider || smsProvider === 'dev') {
		throw new Error('[安全门禁] NODE_ENV=production 时必须配置 SMS_PROVIDER=aliyun/custom，禁止 dev 短信模式')
	}
	if (!['aliyun', 'custom'].includes(smsProvider)) {
		throw new Error(`[安全门禁] 不支持的 SMS_PROVIDER=${smsProvider}；生产环境仅允许 aliyun/custom`)
	}
	const hasStrongAnalysisSecret = [
		process.env.ANALYSIS_CACHE_SECRET,
		process.env.ANALYSIS_KEY_SECRET
	].some((value) => Buffer.byteLength(String(value || '').trim(), 'utf8') >= 32)
	if (!hasStrongAnalysisSecret) {
		throw new Error('[安全门禁] 生产环境必须配置至少32字节的 ANALYSIS_CACHE_SECRET/ANALYSIS_KEY_SECRET')
	}
	const staticTenantId = String(process.env.ANALYSIS_STATIC_TENANT_ID || '').trim()
	if (!/^[A-Za-z0-9._:-]{3,64}$/.test(staticTenantId)) {
		throw new Error('[安全门禁] 使用静态分析 Bearer 时必须配置稳定的 ANALYSIS_STATIC_TENANT_ID')
	}
}
ensureProductionSecurityConfigured()

// 预加载数据存储（触发 SQLite 迁移 + 构建内存索引），避免首次请求时 authRequired 找不到用户
require('./backend/db/store').load()

// ─── 非生产模式安全警告 ───
// 运维如果将 development .env 误部署到线上，所有鉴权门禁会被绕过（P0）。
// 启动时对缺失的关键安全配置打出醒目告警，让运维在日志中一眼看到。
if (!isProductionRuntime) {
	const warnings = []
	if (!String(process.env.JWT_SECRET || '').trim()) {
		warnings.push('JWT_SECRET 为空：Token 密钥改为进程内随机生成，不落盘、重启即失效；生产环境未配置会直接拒绝启动')
	}
	if (!String(process.env.DEV_ANALYZE_BEARER || '').trim()) {
		warnings.push('DEV_ANALYZE_BEARER 为空：AI 分析端点完全无鉴权')
	}
	const smsProvider = String(process.env.SMS_PROVIDER || 'dev').toLowerCase()
	if (smsProvider === 'dev') {
		warnings.push('SMS_PROVIDER=dev：短信验证码将通过响应体回传 devCode')
	}
	if (warnings.length > 0) {
		const sep = '═'.repeat(72)
		console.warn(`\n${sep}\n⚠  安全警告：当前运行在 NODE_ENV=${process.env.NODE_ENV || 'development'}（非生产模式）\n${sep}`)
		for (const w of warnings) console.warn(`  ‼  ${w}`)
		console.warn(`${sep}\n  以上配置若用于线上服务器即为 P0 安全事故。\n  部署到生产环境前请确认：\n    1) NODE_ENV=production\n    2) JWT_SECRET 设为强随机值\n    3) DEV_ANALYZE_BEARER 设为强随机值\n    4) SMS_PROVIDER=aliyun/custom（不保留 dev）\n${sep}\n`)
	}
}

const app = express()

// 反向代理 / 容器环境下 X-Forwarded-For 才能拿到真实 IP，否则限流会按网关 IP 一锅端
app.set('trust proxy', 1)

/**
 * CORS 白名单
 * - 客户端请求不带 Origin 时 cors 会直接放行（无 origin 即可）
 * - H5 / 浏览器请求必须命中 ALLOWED_ORIGINS 才放行
 * - 默认只放开本机开发与预览地址（前端 5173 / vite preview 8910 / 后端自身 3200），
 *   clone 后不填配置即可跑通本地联调。
 * - 部署到公网必须显式设置 ALLOWED_ORIGINS=逗号分隔 origin。未显式配置时白名单里
 *   没有任何公网 origin，任何非本机来源都会被下面的逻辑拒绝（fail-closed 不变）。
 */
const LOCAL_DEFAULT_ORIGINS = [
	'http://localhost',
	'https://localhost',
	'http://localhost:5173',
	'http://127.0.0.1:5173',
	'http://localhost:8910',
	'http://127.0.0.1:8910',
	'http://localhost:3200',
	'http://127.0.0.1:3200'
].join(',')

const ALLOWED_ORIGINS = String(
	process.env.ALLOWED_ORIGINS || LOCAL_DEFAULT_ORIGINS
)
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean)

app.use(
	cors({
		origin: (origin, cb) => {
			if (!origin) return cb(null, true)
			// 精确匹配，禁止 startsWith 前缀匹配：否则 https://api.example.com.evil.com
			// 会被 https://api.example.com 误放行。同源判定按完整 origin 字符串比较。
			const allowed = ALLOWED_ORIGINS.includes(origin)
			if (allowed) return cb(null, true)
			logger.warn({ origin }, 'CORS blocked origin')
			return cb(new Error('CORS not allowed'), false)
		},
		credentials: false
	})
)
// body 体积上限：80mb 会被超大 JSON 打满内存（DoS）。默认收紧到 30mb（足够 base64 图片/PDF），
// 可通过 JSON_BODY_LIMIT 覆盖；PDF 推荐走 multipart /api/parse-pdf-upload（独立上限见 PDF_UPLOAD_MAX_MB）。
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '50mb' }))

// PDF multipart 上传上限（MB）：与客户端 MAX_UPLOAD_SIZE(50MB) 对齐，避免「客户端放行、服务端 413」。
// 线上反向代理也必须同步放行：Nginx client_max_body_size 建议 >= 60m，CDN/隧道入口也需不低于该值。
// 可通过 PDF_UPLOAD_MAX_MB 覆盖；memoryStorage 下单文件占用约等于该值，按服务器内存酌情调整。
const PDF_UPLOAD_MAX_MB = Number(process.env.PDF_UPLOAD_MAX_MB || 50)
const PDF_UPLOAD_LIMIT_BYTES = PDF_UPLOAD_MAX_MB * 1024 * 1024
// 多图上传（征信报告多页截图）：最多张数与单张大小上限。内存存储，总占用约等于张数×单张上限，按服务器内存酌情调整。
const IMAGE_UPLOAD_MAX_COUNT = Number(process.env.IMAGE_UPLOAD_MAX_COUNT || 30)
const IMAGE_UPLOAD_MAX_MB = Number(process.env.IMAGE_UPLOAD_MAX_MB || 40)
const IMAGE_UPLOAD_LIMIT_BYTES = IMAGE_UPLOAD_MAX_MB * 1024 * 1024
// 单请求最长处理时长（毫秒）：与客户端 ANALYZE_UPLOAD_TIMEOUT(900000) 对齐，可用 REQUEST_TIMEOUT_MS 覆盖。
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 900000)
// 旧版独立服务身份。批量一致性门禁必须验证该响应头，避免域名路由
// 错配时把征信报告发送到最新版服务。此标识只描述服务线，不含凭据。
const LEGACY_SERVICE_LINE = 'legacy-isolated-v20260722'
const SAFE_SCANNED_OWNERSHIP_EVIDENCE = Object.freeze({
	version: 1,
	source: 'scanned-pdf-first-page',
	nameRecognized: true,
	identityRecognized: true,
	identityChecksumValid: true,
	verified: true
})

function attachSafeScannedOwnershipEvidence(data, verified) {
	if (!verified || !data || typeof data !== 'object' || Array.isArray(data)) return data
	return {
		...data,
		// Only boolean provenance crosses the API boundary. Raw OCR name and
		// full identity remain local to the ownership gate and are never returned.
		_ownership_evidence: { ...SAFE_SCANNED_OWNERSHIP_EVIDENCE }
	}
}

// 安全响应头（轻量替代 helmet，避免引入额外依赖）。
app.disable('x-powered-by')
app.use((_req, res, next) => {
	res.setHeader('X-Content-Type-Options', 'nosniff')
	res.setHeader('X-Frame-Options', 'DENY')
	res.setHeader('Referrer-Policy', 'no-referrer')
	res.setHeader('X-DNS-Prefetch-Control', 'off')
	res.setHeader('X-RPT-Service-Line', LEGACY_SERVICE_LINE)
	next()
})
// /uploads 静态资源强制下载，避免上传的 HTML/SVG 在同域被当页面渲染造成 XSS。
app.use(
	'/uploads',
	(_req, res, next) => {
		res.setHeader('Content-Disposition', 'attachment')
		next()
	},
	express.static(path.join(__dirname, 'uploads'))
)

const { authRequired, verifyAuthToken } = require('./backend/middlewares/auth.js')
const { requireRoles } = require('./backend/middlewares/roles.js')

function isMissingRequestedModule(err, request) {
	return err && err.code === 'MODULE_NOT_FOUND' && String(err.message || '').includes(request)
}

function loadOptionalLocalModule(request, fallback) {
	try {
		return require(request)
	} catch (err) {
		if (isMissingRequestedModule(err, request)) {
			logger.warn({ adapter: request }, 'ai-proxy optional adapter missing')
			return fallback
		}
		logger.warn(
			{ adapter: request, code: safeErrorCode(err, 'OPTIONAL_ADAPTER_LOAD_FAILED') },
			'ai-proxy optional adapter failed to load'
		)
		return fallback
	}
}

function unavailableAdapter(name) {
	return async () => {
		throw new Error(`${name} adapter is not available`)
	}
}

const { ocrImageToText, splitImageForOcr } = loadOptionalLocalModule('./moonshotVision.js', {
	ocrImageToText: unavailableAdapter('moonshotVision.ocrImageToText'),
	splitImageForOcr: unavailableAdapter('moonshotVision.splitImageForOcr')
})

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runOcrWithRetry(fn, context = {}) {
	let lastErr = null
	for (let attempt = 1; attempt <= OCR_RETRY_ATTEMPTS; attempt++) {
		try {
			return await fn()
		} catch (err) {
			lastErr = err
			if (attempt >= OCR_RETRY_ATTEMPTS) break
			logger.warn({
				code: safeErrorCode(err, 'OCR_UPSTREAM_FAILED'),
				attempt,
				maxAttempts: OCR_RETRY_ATTEMPTS,
				label: context.label,
				index: context.index
			}, 'ocr: upstream failed, retrying')
			await sleep(OCR_RETRY_DELAY_MS * attempt)
		}
	}
	throw lastErr || new Error('OCR failed')
}

function incompleteOcrError(message, extra = {}) {
	const err = new Error(message || 'OCR 识别不完整，已停止分析')
	err.code = 'OCR_INCOMPLETE'
	Object.assign(err, extra)
	return err
}

/**
 * 单张图片缓冲 → OCR 纯文本。长图先竖向切片（splitImageForOcr）逐片识别再拼接，
 * 解决「27MB 长截图整图发给视觉模型被降采样糊成一团 → 识别全 0」的问题。
 * @param {Buffer} buffer 图片字节
 * @param {string} mimeType
 * @param {number} concurrency 切片并发；多图链路传 1 避免与外层并发叠乘打满上游限流
 */
async function ocrImageBufferToText(buffer, mimeType, concurrency) {
	const tiles = await splitImageForOcr(buffer, mimeType)
	if (tiles.length <= 1) {
		const text = await runOcrWithRetry(
			() => ocrImageToText(tiles[0].base64, tiles[0].mimeType),
			{ label: 'image-ocr', index: 1 }
		)
		const cleaned = String(text || '').trim()
		if (!cleaned) throw incompleteOcrError('图片识别为空，请重新上传清晰截图')
		return cleaned
	}
	const out = new Array(tiles.length).fill('')
	const failedTiles = []
	let cursor = 0
	const worker = async () => {
		while (true) {
			const i = cursor++
			if (i >= tiles.length) break
			try {
				const text = await runOcrWithRetry(
					() => ocrImageToText(tiles[i].base64, tiles[i].mimeType),
					{ label: `image-tile-${i + 1}`, index: i + 1 }
				)
				out[i] = String(text || '').trim()
				if (!out[i]) throw new Error('OCR 返回空文本')
			} catch (e) {
				logger.error(
					{ code: safeErrorCode(e, 'OCR_TILE_FAILED'), tile: i + 1, total: tiles.length },
					'ocr-tile: OCR failed after retries'
				)
				failedTiles.push(i + 1)
			}
		}
	}
	const n = Math.max(1, Math.min(concurrency || SCANNED_PDF_OCR_CONCURRENCY, tiles.length))
	await Promise.all(Array.from({ length: n }, () => worker()))
	if (failedTiles.length > 0) {
		failedTiles.sort((a, b) => a - b)
		throw incompleteOcrError(`长截图第 ${failedTiles.join('、')} 段识别失败。为避免漏读导致评分错误，请重新上传清晰截图或拆成多张页面截图。`, {
			failedTiles
		})
	}
	const text = out.filter(Boolean).join('\n').trim()
	logger.info({ tiles: tiles.length, okTiles: out.filter(Boolean).length, chars: text.length }, 'ocr-tile: long image split OCR complete')
	return text
}
const businessRoutes = require('./backend/routes/business.js')
const userRoutes = require('./backend/routes/user.js')
const matchRoutes = require('./backend/routes/match.js')
const logRoutes = require('./backend/routes/log.js')
const teacherRoutes = require('./backend/routes/teacher.js')
const monitorRoutes = require('./backend/routes/monitor.js')

/** 北京时间（供客户端联网校时；不限流） */
function beijingTimePayload() {
	const ts = Date.now()
	let iso_beijing = ''
	try {
		iso_beijing =
			new Date(ts).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(' ', 'T') + '+08:00'
	} catch {
		iso_beijing = new Date(ts + 8 * 3600000).toISOString().replace('Z', '+08:00')
	}
	return {
		ok: true,
		timezone: 'Asia/Shanghai',
		timestamp_ms: ts,
		iso_beijing,
		date_beijing: iso_beijing.slice(0, 10)
	}
}

app.get('/health', (_req, res) => {
	const analysisCache = cacheRuntimeStatus()
	const storage = store.storageRuntimeStatus()
	const cacheReady = !isProductionRuntime || analysisCache.persistent === true
	const runtime = {
		production: isProductionRuntime,
		releaseConfigured: releaseRuntimeDeclared
	}
	const runtimeReady = !releaseRuntimeDeclared || runtime.production === true
	const ready = runtimeReady && cacheReady && storage.ready === true
	res.status(ready ? 200 : 503).json({
		ok: ready,
		service: 'rpt-api-proxy',
		release: releaseIdentity,
		runtime,
		analysisCache,
		storage,
		routes: [
			'/api/time',
			'/api/parse-pdf',
			'/api/parse-pdf-upload',
			'/api/analyze',
			'/api/analysis/jobs',
			'/api/analysis/support/:supportRef',
			'/api/ops/analysis/support/:supportRef',
			'/api/analyze-image',
			'/api/ocr-image-text',
			'/api/analyze-images',
			'/api/ai/analyze',
			'/api/analyze-text',
			'/api/user/*',
			'/api/match-products',
			'/api/log/error',
			'/api/report/*',
			'/api/advisor/*',
			'/api/profile/*',
			'/api/message/*',
			'/api/content/*',
			'/api/optimize/*',
			'/api/upload',
			'/api/monitor/sync',
			'/api/monitor/latest',
			'/api/monitor/history',
			'/api/monitor/reports',
			'/api/monitor/reports/stats'
		]
	})
})

app.get('/api/time', (_req, res) => {
	res.json(beijingTimePayload())
})

/**
 * 限流：AI 端点（消耗外部 DeepSeek/Moonshot 额度）窗口更小、阈值更低；
 *      用户/异议等业务端点采用较宽松的全局限流，避免误伤。
 */
const aiLimiter = rateLimit({
	windowMs: 60 * 60 * 1000,
	max: Number(process.env.AI_RATE_LIMIT_PER_HOUR || 30),
	standardHeaders: true,
	legacyHeaders: false,
	message: { code: 4029, msg: 'AI 端点限流：每小时上限已达，请稍后再试' }
})
const authLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	max: Number(process.env.AUTH_RATE_LIMIT_PER_15MIN || 30),
	standardHeaders: true,
	legacyHeaders: false,
	message: { code: 4029, msg: '登录/注册请求过于频繁，请稍后再试' }
})
const globalLimiter = rateLimit({
	windowMs: 60 * 1000,
	max: Number(process.env.GLOBAL_RATE_LIMIT_PER_MIN || 240),
	standardHeaders: true,
	legacyHeaders: false,
	message: { code: 4029, msg: '请求过于频繁，请稍后再试' }
})
// 产品匹配（公开端点，供登录前离线预览）：比全局更紧，限制批量探测算法。
const matchLimiter = rateLimit({
	windowMs: 60 * 1000,
	max: Number(process.env.MATCH_RATE_LIMIT_PER_MIN || 30),
	standardHeaders: true,
	legacyHeaders: false,
	message: { code: 4029, msg: '匹配请求过于频繁，请稍后再试' }
})
// 客户端错误上报（公开端点）：严格限流，避免被刷写满磁盘。
const logLimiter = rateLimit({
	windowMs: 60 * 1000,
	max: Number(process.env.LOG_RATE_LIMIT_PER_MIN || 20),
	standardHeaders: true,
	legacyHeaders: false,
	message: { code: 4029, msg: '上报过于频繁' }
})
app.use('/api/', globalLimiter)
app.use(['/api/user/login', '/api/user/register', '/api/user/send-login-sms-code', '/api/user/sms-login', '/api/user/send-sms-code'], authLimiter)
app.use('/api/match-products', matchLimiter)
app.use('/api/log/error', logLimiter)

const {
	runCreditLLMAnalysis,
	findPdfHeaderOffset,
	buildPdfParseResult,
	scannedPdfToText,
	preflightCreditEvidenceSource
} = require('./backend/services/creditAnalysisService')

const PUBLIC_ANALYSIS_ERRORS = Object.freeze({
	ANALYSIS_INPUT_TOO_LARGE: '报告原文超过当前完整分析上限，已停止评分',
	ANALYSIS_CONTEXT_LIMIT: '报告超出模型完整上下文，已停止评分',
	ANALYSIS_OUTPUT_TRUNCATED: '模型输出不完整，已停止评分，请重试',
	ANALYSIS_NON_JSON_OUTPUT: '模型未返回完整结构化结果，请重试',
	FACT_SCHEMA_INVALID: '模型事实结构不完整，已停止评分，请重试',
	CHUNK_SOURCE_OVERVIEW_MISMATCH: '报告概要与账户明细无法一致核验，已安全停止评分',
	QUERY_EVIDENCE_INCOMPLETE: '机构查询明细无法完整核验，已停止评分',
	DETERMINISTIC_REPORT_DATE_MISSING: '报告日期缺失，无法按统一时间口径评分',
	DETERMINISTIC_COVERAGE_MISSING: '报告明细完整性无法确认，已停止评分',
	DETERMINISTIC_FACTS_INCOMPLETE: '报告明细不完整，已停止评分',
	EVIDENCE_PUBLICATION_BLOCKED: '报告证据链不足或存在冲突，已停止发布评分',
	EVIDENCE_DERIVATION_MISMATCH: '报告事实与确定性计算不一致，已停止发布评分',
	PDF_TEXT_LAYER_MISSING: 'PDF 无可验证文字层，请上传征信中心下载、可复制文字的原始 PDF',
	OCR_TEXT_TOO_SHORT: '扫描件 PDF 识别文字过少，请确保图像清晰',
	OCR_INCOMPLETE: '扫描件存在未识别页面，已停止评分',
	OCR_STRUCTURED_EVIDENCE_UNAVAILABLE: '扫描件暂不能生成可验证分析，请上传征信中心下载、可复制文字的原始 PDF',
	PDF_EVIDENCE_SOURCE_UNVERIFIED: '该 PDF 的文字层无法完整验证，请重新下载官方原始 PDF',
	OCR_FAILED: 'PDF 识别失败，请重新上传清晰文件',
	IMAGE_TEXT_TOO_SHORT: '图片可识别文字过少，请确保图片清晰',
	IMAGE_OCR_INCOMPLETE: '部分图片识别失败，已停止评分',
	ANALYSIS_IN_PROGRESS_TIMEOUT: '同一报告正在分析，请稍后重试'
})

function analysisExecutionError(out, fallbackMessage = '分析服务异常') {
	const rawCode = String(out && out.errCode || '')
	const code = /^[A-Z0-9_]{1,64}$/.test(rawCode)
		? rawCode
		: 'ANALYSIS_EXECUTION_FAILED'
	const error = new Error(code)
	error.code = code
	error.httpStatus = Number(out && out.httpStatus) || 502
	error.publicMessage = PUBLIC_ANALYSIS_ERRORS[code] || fallbackMessage
	// Keep rich diagnostics in memory only. The task coordinator/store apply a
	// strict enum/count allowlist before anything is persisted or returned.
	if (Array.isArray(out && out.failedChecks)) error.failedChecks = out.failedChecks
	if (Array.isArray(out && out.coverageIssues)) error.coverageIssues = out.coverageIssues
	if (Array.isArray(out && out.failedPages)) error.failedPages = out.failedPages
	if (Number.isFinite(Number(out && out.totalPages))) error.totalPages = Number(out.totalPages)
	if (out && out.evidenceDiagnostic && typeof out.evidenceDiagnostic === 'object') {
		error.diagnostic = out.evidenceDiagnostic
	} else if (out && out.diagnostic && typeof out.diagnostic === 'object') {
		error.diagnostic = out.diagnostic
	}
	return error
}

function assertCreditEvidenceSourceSupported(evidenceContext) {
	const blocked = preflightCreditEvidenceSource({
		evidenceRequired: true,
		evidenceContext
	})
	if (blocked) throw analysisExecutionError(blocked)
}

async function executeCreditTextAnalysis(text, options = {}) {
	const out = await runCreditLLMAnalysis(text, options)
	if (!out.ok) throw analysisExecutionError(out)
	return out.data
}

/**
 * One authoritative PDF execution path shared by the legacy synchronous
 * endpoint and persisted async jobs. Stage notifications are event-driven:
 * they are emitted only when the corresponding operation actually starts or
 * completes, never from a timer.
 */
async function executePdfAnalysisBuffer(buf, options = {}) {
	const onStage = typeof options.onStage === 'function' ? options.onStage : () => {}
	if (!Buffer.isBuffer(buf) || !buf.length || findPdfHeaderOffset(buf) < 0) {
		throw analysisExecutionError({
			httpStatus: 400,
			errCode: 'INVALID_PDF',
			errMsg: '不是有效的 PDF 文件'
		})
	}

	onStage('pdf_extract', 15)
	const parseR = await buildPdfParseResult(buf)
	let text = (parseR.body && parseR.body.text) || ''
	let evidenceContext = parseR.evidenceContext || null
	let scannedOwnershipVerified = false
	let queryEvidence = null
	const needOcr = parseR.status >= 400 || !parseR.body || !parseR.body.success
	if (needOcr) {
		assertCreditEvidenceSourceSupported({
			version: 'ocr-page-span-v1',
			sourceMode: 'ocr',
			complete: true
		})
		if (!SCANNED_PDF_OCR_ENABLED) {
			throw analysisExecutionError({
				httpStatus: 400,
				errCode: 'PDF_TEXT_LAYER_MISSING',
				errMsg: (parseR.body && parseR.body.errMsg) || 'PDF 无可提取文字，请改用图片上传'
			})
		}
		onStage('ocr', 25)
		try {
			const ocr = await scannedPdfToText(buf)
			if (!ocr.text || ocr.text.trim().length < MIN_TEXT_LEN) {
				throw analysisExecutionError({
					httpStatus: 400,
					errCode: 'OCR_TEXT_TOO_SHORT',
					errMsg: '扫描件 PDF 识别文字过少，请确保图像清晰'
				})
			}
			text = ocr.text
			evidenceContext = ocr.evidenceContext || {
				version: 'ocr-page-span-v1',
				sourceMode: 'ocr',
				expectedPageCount: Number(ocr.total || 0),
				complete: Number(ocr.rendered || 0) === Number(ocr.total || 0),
				geometryState: 'unavailable'
			}
			scannedOwnershipVerified = ocr.ownershipVerified === true
			queryEvidence = ocr.queryEvidence || null
			logger.info(
				{ rendered: ocr.rendered, total: ocr.total, chars: text.length },
				'api/analyze: scanned PDF OCR fallback complete'
			)
		} catch (error) {
			if (error && error.publicMessage) throw error
			throw analysisExecutionError({
				httpStatus: 400,
				errCode: error && error.code === 'OCR_INCOMPLETE'
					? 'OCR_INCOMPLETE'
					: 'OCR_FAILED',
				failedPages: error && error.failedPages,
				totalPages: error && error.totalPages,
				errMsg: error && error.code === 'OCR_INCOMPLETE'
					? error.message
					: 'PDF 识别失败，请重新上传清晰文件'
			})
		}
	}

	const data = await executeCreditTextAnalysis(text, {
		queryEvidence,
		onStage,
		evidenceRequired: true,
		evidenceContext,
		documentId: options.documentId
	})
	onStage('persisting', 95)
	return attachSafeScannedOwnershipEvidence(data, scannedOwnershipVerified)
}

analysisTaskService.configureAnalysisTaskExecutor(({ content, onStage, documentId }) =>
	executePdfAnalysisBuffer(content, { onStage, documentId })
)

function requireJwtAnalysisTask(req, res, next) {
	const uid = String(req.user && req.user.uid || '')
	if (!uid || req.analysisScope !== `user:${uid}`) {
		return res.status(401).json({ code: 401, msg: '登录态无效，请重新登录' })
	}
	return next()
}

const analyzeTextHandler = async (req, res) => {
	try {
		const text = String(req.body && req.body.text || '')
		const coordinated = await runCoordinatedAnalysis({
			content: text,
			scope: req.analysisScope,
			inputKind: 'credit-report-text',
			// The compatibility text endpoint remains available, but its output is
			// authoritative/cacheable only after the same evidence-v2 gate as PDF.
			// Line blocks provide exact spans; geometry is explicitly unavailable.
			execute: (identity) => executeCreditTextAnalysis(text, {
				evidenceRequired: true,
				inputKind: 'credit-report-text',
				documentId: identity.documentId,
				evidenceContext: {
					version: 'caller-text-span-v1',
					sourceMode: 'caller-text',
					expectedPageCount: 1,
					complete: true,
					geometryState: 'unavailable',
					pages: [{ pageNumber: 1, text, blocks: [] }]
				}
			})
		})
		return res.json({ success: true, data: coordinated.data, analysis: coordinated.analysis })
	} catch (e) {
		logger.error({ code: e && e.code ? e.code : 'ANALYZE_TEXT_FAILED' }, 'analyze-text failed')
		return res.status(Number(e && e.httpStatus) || 500).json({
			success: false,
			errMsg: (e && e.publicMessage) || PUBLIC_ANALYSIS_ERRORS[e && e.code] || '分析服务异常',
			errCode: e && e.code ? e.code : 'ANALYZE_TEXT_FAILED'
		})
	}
}

/**
 * PDF → 纯文本（仅文字层；扫描件无文字层时会 success: false）
 */
async function parsePdfHandler(req, res) {
	try {
		const base64 = req.body && req.body.base64
		if (typeof base64 !== 'string' || base64.length < 80) {
			return res.status(400).json({
				success: false,
				errMsg: '缺少 base64 或数据过短'
			})
		}

		let buf
		try {
			buf = Buffer.from(base64, 'base64')
		} catch {
			return res.status(400).json({ success: false, errMsg: 'base64 解码失败' })
		}

		const r = await buildPdfParseResult(buf)
		return res.status(r.status).json(r.body)
	} catch (e) {
		logger.error({ code: safeErrorCode(e, 'PDF_PARSE_FAILED') }, 'parse-pdf failed')
		return res.status(500).json({
			success: false,
			errMsg: e && e.message ? e.message : 'PDF 解析异常'
		})
	}
}

/**
 * AI / 解析端点鉴权（与客户端 uploadCreditAnalyze 对齐）。
 * 同时接受三类凭证（向后兼容 + 平滑迁移 + 零停机轮换）：
 *   1) 静态 Bearer = DEV_ANALYZE_BEARER（服务端可选兜底；客户端默认不内置明文 Token）
 *   2) 轮换过渡期旧 Bearer = DEV_ANALYZE_BEARER_FALLBACK（轮换期间同时认新旧值，避免 401 风暴；轮换完成后删除）
 *   3) 登录态 JWT（推荐路径；前端登录后可改发 JWT，后续即可轮换/弃用静态 Bearer）
 * 未配置 DEV_ANALYZE_BEARER 时仅允许非生产联调；生产环境 fail-closed（503）。
 */
function optionalAnalyzeBearer(req, res, next) {
	const required = String(process.env.DEV_ANALYZE_BEARER || '').trim()
	const staticTenantId = String(process.env.ANALYSIS_STATIC_TENANT_ID || 'local-service').trim()
	const serviceScope = `service:${staticTenantId}`
	if (!required) {
		if (isProductionRuntime) {
			return res.status(503).json({ code: 503, msg: 'analyze auth misconfigured' })
		}
		const auth = String(req.headers.authorization || '').trim()
		if (auth.startsWith('Bearer ')) {
			try {
				req.user = verifyAuthToken(auth.slice(7).trim())
				req.analysisScope = `user:${req.user.uid}`
			} catch (_) {
				req.analysisScope = 'development:process-local'
			}
		} else {
			req.analysisScope = 'development:process-local'
		}
		return next()
	}
	const fallback = String(process.env.DEV_ANALYZE_BEARER_FALLBACK || '').trim()
	const auth = String(req.headers.authorization || '').trim()
	if (!auth.startsWith('Bearer ')) {
		return res.status(401).json({ code: 401, msg: 'unauthorized' })
	}
	const token = auth.slice(7).trim()
	if (token === required) {
		req.analysisScope = serviceScope
		return next()
	}
	if (fallback && token === fallback) {
		req.analysisScope = serviceScope
		return next()
	}
	try {
		req.user = verifyAuthToken(token)
		req.analysisScope = `user:${req.user.uid}`
		return next()
	} catch (_) {
		return res.status(401).json({ code: 401, msg: 'unauthorized' })
	}
}

app.post('/api/parse-pdf', aiLimiter, optionalAnalyzeBearer, parsePdfHandler)

/** 推荐：multipart 上传 PDF，避免超大 JSON base64 触发连接重置 */
const pdfMemUpload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: PDF_UPLOAD_LIMIT_BYTES }
})
/**
 * 同 /api/analyze：multer 错误显式接住，统一 JSON 响应。
 */
const parsePdfUploadMw = (req, res, next) => {
	pdfMemUpload.single('file')(req, res, (err) => {
		if (!err) return next()
		logger.error(
			{ code: safeErrorCode(err, 'PDF_UPLOAD_FAILED') },
			'parse-pdf-upload: multer error'
		)
		const status = err && err.code === 'LIMIT_FILE_SIZE' ? 413 : 400
		const errMsg =
			err && err.code === 'LIMIT_FILE_SIZE'
				? `PDF 超过 ${PDF_UPLOAD_MAX_MB}MB 上限，请压缩后重试`
				: err && err.message
					? err.message
					: '上传解析失败'
		return res.status(status).json({ success: false, errMsg })
	})
}
app.post('/api/parse-pdf-upload', aiLimiter, optionalAnalyzeBearer, parsePdfUploadMw, async (req, res) => {
	try {
		const buf = req.file && req.file.buffer
		if (!buf || !buf.length) {
			return res.status(400).json({ success: false, errMsg: '缺少 file 或内容为空' })
		}
		const r = await buildPdfParseResult(buf)
		return res.status(r.status).json(r.body)
	} catch (e) {
		logger.error(
			{ code: safeErrorCode(e, 'PDF_UPLOAD_PARSE_FAILED') },
			'parse-pdf-upload failed'
		)
		return res.status(500).json({
			success: false,
			errMsg: e && e.message ? e.message : 'parse-pdf-upload failed'
		})
	}
})

app.post('/api/analyze-image', aiLimiter, optionalAnalyzeBearer, async (req, res) => {
	try {
		const base64 = req.body && req.body.base64
		const mimeType = (req.body && req.body.mimeType) || 'image/jpeg'
		if (typeof base64 !== 'string' || base64.length < 100) {
			return res.status(400).json({
				success: false,
				errMsg: '缺少 base64 或过短'
			})
		}
		if (!SCANNED_PDF_OCR_ENABLED) {
			return res.status(400).json({ success: false, errMsg: '当前未启用图像识别' })
		}
		const buf = Buffer.from(String(base64).replace(/\s/g, ''), 'base64')
		if (!buf.length) {
			return res.status(400).json({ success: false, errMsg: '图片 base64 解码失败' })
		}
		assertCreditEvidenceSourceSupported({
			version: 'ocr-image-span-v1',
			sourceMode: 'ocr-image',
			complete: true
		})
		// 单图只保留「文件字节 → OCR → 原始事实 → 确定性规则」这一条权威链路。
		// 不再因瞬时 OCR 异常切换到另一套视觉分析口径。
		const coordinated = await runCoordinatedAnalysis({
			content: { buffer: buf, label: mimeType },
			scope: req.analysisScope,
			inputKind: 'credit-report-image',
			execute: async (identity) => {
				let text = ''
				try {
					text = await ocrImageBufferToText(buf, mimeType, SCANNED_PDF_OCR_CONCURRENCY)
				} catch (_) {
					throw analysisExecutionError({
						httpStatus: 422,
						errCode: 'IMAGE_OCR_INCOMPLETE'
					})
				}
				if (!text || text.length < MIN_TEXT_LEN) {
					throw analysisExecutionError({
						httpStatus: 422,
						errCode: 'IMAGE_TEXT_TOO_SHORT'
					})
				}
				return executeCreditTextAnalysis(text, {
					evidenceRequired: true,
					documentId: identity.documentId,
					inputKind: 'credit-report-image',
					evidenceContext: {
						version: 'ocr-image-span-v1',
						sourceMode: 'ocr-image',
						expectedPageCount: 1,
						complete: true,
						geometryState: 'unavailable',
						pages: [{ pageNumber: 1, text, blocks: [] }]
					}
				})
			}
		})
		return res.json({
			success: true,
			data: coordinated.data,
			analysis: coordinated.analysis
		})
	} catch (e) {
		const code = e && e.code ? e.code : 'ANALYZE_IMAGE_FAILED'
		logger.error({ code }, 'analyze-image failed')
		return res.status(Number(e && e.httpStatus) || 500).json({
			success: false,
			errCode: code,
			errMsg: (e && e.publicMessage) || PUBLIC_ANALYSIS_ERRORS[code] || '图像分析失败，请稍后重试'
		})
	}
})

app.post('/api/ocr-image-text', aiLimiter, optionalAnalyzeBearer, async (req, res) => {
	try {
		const base64 = req.body && req.body.base64
		const mimeType = (req.body && req.body.mimeType) || 'image/jpeg'
		if (typeof base64 !== 'string' || base64.length < 100) {
			return res.status(400).json({ success: false, errMsg: '缺少 base64 或过短' })
		}
		const buf = Buffer.from(String(base64).replace(/\s/g, ''), 'base64')
		const text = await ocrImageBufferToText(buf, mimeType, SCANNED_PDF_OCR_CONCURRENCY)
		return res.json({ success: true, data: { text } })
	} catch (e) {
		logger.error({ code: safeErrorCode(e, 'OCR_IMAGE_FAILED') }, 'ocr-image-text failed')
		return res.status(500).json({
			success: false,
			errMsg: isProductionRuntime ? '图片文字识别失败，请稍后重试' : (e && e.message ? e.message : 'ocr-image-text failed')
		})
	}
})

const analyzePdfMem = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: PDF_UPLOAD_LIMIT_BYTES }
})

/**
 * 把 multer middleware 的同步/异步错误显式接住，避免落到 Express 默认错误处理（会返回 HTML）。
 * 命中 multer 错误时统一返回 { code: 4xx/500, msg }，并打日志便于排查。
 */
function wrapMulter(mw) {
	return (req, res, next) => {
		mw(req, res, (err) => {
			if (!err) return next()
			logger.error(
				{ code: safeErrorCode(err, 'ANALYZE_UPLOAD_FAILED') },
				'api/analyze: multer error'
			)
			const code = err && err.code === 'LIMIT_FILE_SIZE' ? 413 : 400
			const msg =
				err && err.code === 'LIMIT_FILE_SIZE'
					? `PDF 超过 ${PDF_UPLOAD_MAX_MB}MB 上限，请压缩后重试或改用图片上传`
					: err && err.code === 'LIMIT_UNEXPECTED_FILE'
						? '上传字段名错误，请使用 file 字段'
						: err && err.message
							? err.message
							: '上传解析失败'
			return res.status(code).json({ code, msg })
		})
	}
}

/**
 * POST /api/analyze — multipart 字段 file（PDF）；响应 { code: 0, data } 与客户端 apiClient 一致
 */
app.post('/api/analyze', aiLimiter, optionalAnalyzeBearer, wrapMulter(analyzePdfMem.single('file')), async (req, res) => {
	try {
		const buf = req.file && req.file.buffer
		if (!buf || !buf.length) {
			return res.json({ code: 400, msg: '缺少文件或 file 字段' })
		}
		if (findPdfHeaderOffset(buf) < 0) {
			return res.json({ code: 400, msg: '不是有效的 PDF 文件' })
		}
		// analysisKey/cache 命中发生在任何 PDF 解析、OCR 或 AI 调用之前。
		const coordinated = await runCoordinatedAnalysis({
			content: buf,
			scope: req.analysisScope,
			inputKind: 'credit-report-pdf',
			execute: (identity) => executePdfAnalysisBuffer(buf, {
				documentId: identity.documentId
			})
		})
		return res.json({
			code: 0,
			data: coordinated.data,
			analysis: coordinated.analysis
		})
	} catch (e) {
		logger.error({ code: e && e.code ? e.code : 'ANALYZE_FAILED' }, 'api/analyze failed')
		const status = Number(e && e.httpStatus) || 500
		return res.json({
			code: status >= 500 ? 500 : status,
			msg: (e && e.publicMessage) || PUBLIC_ANALYSIS_ERRORS[e && e.code] || '分析服务异常',
			errCode: e && e.code ? e.code : 'ANALYZE_FAILED'
		})
	}
})

// Persisted async PDF analysis. The legacy synchronous /api/analyze remains
// available for old clients; new clients upload once, keep the opaque jobId,
// and can resume status/result retrieval after navigation or reconnect.
app.post(
	'/api/analysis/jobs',
	aiLimiter,
	optionalAnalyzeBearer,
	requireJwtAnalysisTask,
	wrapMulter(analyzePdfMem.single('file')),
	(req, res) => {
		try {
			const buf = req.file && req.file.buffer
			if (!buf || !buf.length) return res.status(400).json({ code: 400, msg: '缺少文件或 file 字段' })
			if (findPdfHeaderOffset(buf) < 0) return res.status(400).json({ code: 400, msg: '不是有效的 PDF 文件' })
			const job = analysisTaskService.enqueueAnalysisTask({
				content: buf,
				scope: req.analysisScope,
				inputKind: 'credit-report-pdf'
			})
			return res.status(202).json({ code: 0, data: job })
		} catch (error) {
			logger.error({ code: safeErrorCode(error, 'ANALYSIS_TASK_CREATE_FAILED') }, 'analysis task create failed')
			const runtimeUnavailable = error && error.code === 'ANALYSIS_TASK_PERSISTENCE_UNAVAILABLE'
			return res.status(runtimeUnavailable ? 503 : 500).json({
				code: runtimeUnavailable ? 503 : 500,
				msg: runtimeUnavailable ? '分析任务持久化配置不可用，请联系运维' : '创建分析任务失败',
				errCode: runtimeUnavailable ? error.code : 'ANALYSIS_TASK_CREATE_FAILED'
			})
		}
	}
)

app.get('/api/analysis/jobs/latest', optionalAnalyzeBearer, requireJwtAnalysisTask, (req, res) => {
	try {
		return res.json({ code: 0, data: analysisTaskService.getLatestAnalysisTask(req.analysisScope) })
	} catch (error) {
		logger.error({ code: safeErrorCode(error, 'ANALYSIS_TASK_STATUS_FAILED') }, 'latest analysis task failed')
		return res.status(500).json({ code: 500, msg: '获取分析任务失败' })
	}
})

function ownerSupportEvent(event) {
	if (!event) return null
	return {
		schemaVersion: event.schemaVersion,
		supportRef: event.supportRef,
		status: event.status,
		code: event.code,
		errorClass: event.errorClass,
		stage: event.stage,
		retryable: event.retryable,
		safeMessageKey: event.safeMessageKey,
		diagnostic: event.diagnostic,
		serverTime: event.serverTime,
		release: event.release,
		versions: event.versions
	}
}

// An owner can re-read only the trusted snapshot already bound to one of that
// account's deliveries. A forged, malformed or foreign ref is deliberately
// indistinguishable from a missing ref. Request body/query values never select
// the scope.
app.get('/api/analysis/support/:supportRef', optionalAnalyzeBearer, requireJwtAnalysisTask, (req, res) => {
	try {
		const event = analysisTaskService.getAnalysisSupportEvent(
			req.analysisScope,
			req.params.supportRef
		)
		if (!event) return res.status(404).json({ code: 404, msg: '支持编号不存在' })
		return res.json({ code: 0, data: ownerSupportEvent(event) })
	} catch (error) {
		logger.error({ code: safeErrorCode(error, 'ANALYSIS_SUPPORT_LOOKUP_FAILED') }, 'analysis support lookup failed')
		return res.status(500).json({ code: 500, msg: '支持信息暂不可用' })
	}
})

// Operations lookup is authenticated and read-only. traceId is exposed only
// here so an authorized monitor/admin can correlate the immutable terminal
// snapshot with safe PM2 log envelopes.
app.get(
	'/api/ops/analysis/support/:supportRef',
	authRequired,
	requireRoles(['monitor'], '仅运维账号可查询分析支持信息'),
	(req, res) => {
		try {
			const event = analysisTaskService.getAnalysisSupportEventForOps(req.params.supportRef)
			if (!event) return res.status(404).json({ code: 404, msg: '支持编号不存在' })
			return res.json({ code: 0, data: event })
		} catch (error) {
			logger.error({ code: safeErrorCode(error, 'ANALYSIS_SUPPORT_LOOKUP_FAILED') }, 'ops analysis support lookup failed')
			return res.status(500).json({ code: 500, msg: '支持信息暂不可用' })
		}
	}
)

app.get('/api/analysis/jobs/:jobId/result', optionalAnalyzeBearer, requireJwtAnalysisTask, (req, res) => {
	try {
		const payload = analysisTaskService.getAnalysisTaskResult(req.analysisScope, req.params.jobId)
		if (!payload) return res.status(404).json({ code: 404, msg: '分析任务不存在' })
		if (!payload.result) return res.status(202).json({ code: 202, data: { job: payload.job } })
		return res.json({
			code: 0,
			data: {
				result: payload.result,
				analysis: payload.analysis,
				job: payload.job
			}
		})
	} catch (error) {
		logger.error({ code: safeErrorCode(error, 'ANALYSIS_RESULT_UNAVAILABLE') }, 'analysis task result failed')
		if (error && error.code === 'ANALYSIS_RESULT_UNAVAILABLE') {
			const terminal = analysisTaskService.getAnalysisTask(req.analysisScope, req.params.jobId)
			if (terminal && terminal.status === 'failed') {
				return res.json({
					code: 0,
					data: { result: null, analysis: null, job: terminal }
				})
			}
		}
		return res.status(500).json({ code: 500, msg: '分析结果暂不可用', errCode: 'ANALYSIS_RESULT_UNAVAILABLE' })
	}
})

app.post('/api/analysis/jobs/:jobId/ack', optionalAnalyzeBearer, requireJwtAnalysisTask, (req, res) => {
	try {
		const job = analysisTaskService.getAnalysisTask(req.analysisScope, req.params.jobId)
		if (!job) return res.status(404).json({ code: 404, msg: '分析任务不存在' })
		if (!['succeeded', 'failed'].includes(job.status)) {
			return res.status(409).json({ code: 409, msg: '分析任务尚未进入可确认终态' })
		}
		if (!analysisTaskService.acknowledgeAnalysisTask(req.analysisScope, req.params.jobId)) {
			return res.status(409).json({ code: 409, msg: '分析任务确认失败' })
		}
		return res.json({
			code: 0,
			data: {
				acknowledged: true,
				jobId: req.params.jobId,
				supportRef: job.supportRef,
				serverTime: job.serverTime
			}
		})
	} catch (error) {
		logger.error({ code: safeErrorCode(error, 'ANALYSIS_TASK_ACK_FAILED') }, 'analysis task acknowledgement failed')
		return res.status(500).json({ code: 500, msg: '确认分析任务失败' })
	}
})

app.get('/api/analysis/jobs/:jobId', optionalAnalyzeBearer, requireJwtAnalysisTask, (req, res) => {
	try {
		const job = analysisTaskService.getAnalysisTask(req.analysisScope, req.params.jobId)
		if (!job) return res.status(404).json({ code: 404, msg: '分析任务不存在' })
		const errorMessage = job.status === 'failed'
			? (PUBLIC_ANALYSIS_ERRORS[job.errorCode] || '分析任务失败，请重新上传')
			: null
		return res.json({ code: 0, data: { ...job, errorMessage } })
	} catch (error) {
		logger.error({ code: safeErrorCode(error, 'ANALYSIS_TASK_STATUS_FAILED') }, 'analysis task status failed')
		return res.status(500).json({ code: 500, msg: '获取分析任务失败' })
	}
})

// 多图上传：multer 内存存储，接收任意字段名（前端每张图用唯一 name 以兼容 H5/多文件上传），
// 限制单张大小与最大张数。
const analyzeImagesMem = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: IMAGE_UPLOAD_LIMIT_BYTES, files: IMAGE_UPLOAD_MAX_COUNT }
})

/** 多图上传专用 multer 错误包装：命中限制时返回可读 JSON，避免 Express 默认 HTML 错误页 */
function wrapMulterImages(mw) {
	return (req, res, next) => {
		mw(req, res, (err) => {
			if (!err) return next()
			logger.error(
				{ code: safeErrorCode(err, 'ANALYZE_IMAGES_UPLOAD_FAILED') },
				'api/analyze-images: multer error'
			)
			let msg = '上传解析失败'
			if (err && err.code === 'LIMIT_FILE_SIZE') msg = `单张图片超过 ${IMAGE_UPLOAD_MAX_MB}MB 上限，请压缩后重试`
			else if (err && err.code === 'LIMIT_FILE_COUNT') msg = `最多上传 ${IMAGE_UPLOAD_MAX_COUNT} 张图片`
			else if (err && err.code === 'LIMIT_UNEXPECTED_FILE') msg = '上传字段名错误，请使用 files 字段'
			else if (err && err.message) msg = err.message
			const code = err && err.code === 'LIMIT_FILE_SIZE' ? 413 : 400
			return res.status(code).json({ code, msg })
		})
	}
}

/**
 * POST /api/analyze-images — multipart 多张征信报告截图（每张唯一字段名，最多 IMAGE_UPLOAD_MAX_COUNT 张）。
 * 逐张视觉 OCR（限并发，复用 SCANNED_PDF_OCR_CONCURRENCY）→ 按序拼接文本 → 复用 runCreditLLMAnalysis，
 * 响应 { code: 0, data } 与 /api/analyze 完全一致，前端可走同一套 serverAnalyzeMapper。
 */
app.post('/api/analyze-images', aiLimiter, optionalAnalyzeBearer, wrapMulterImages(analyzeImagesMem.any()), async (req, res) => {
	try {
		const files = Array.isArray(req.files) ? req.files : []
		if (!files.length) {
			return res.json({ code: 400, msg: '缺少图片文件或 files 字段' })
		}
		if (!SCANNED_PDF_OCR_ENABLED) {
			return res.json({ code: 400, msg: '当前未启用图像识别，请改用文字版 PDF 上传' })
		}
		assertCreditEvidenceSourceSupported({
			version: 'ocr-images-span-v1',
			sourceMode: 'ocr-image',
			complete: true
		})
		const coordinated = await runCoordinatedAnalysis({
			content: files.map((file) => ({
				buffer: file.buffer,
				label: file.mimetype || 'image/jpeg'
			})),
			scope: req.analysisScope,
			inputKind: 'credit-report-images-ordered',
			execute: async (identity) => {
				// 逐张 OCR → 文本，限并发，结果按页序回填；任意一张失败都不能继续评分。
				const pageTexts = new Array(files.length).fill('')
				const failedImages = []
				let cursor = 0
				const outerN = Math.max(1, Math.min(SCANNED_PDF_OCR_CONCURRENCY, files.length))
				const tileConc = Math.max(1, Math.floor(SCANNED_PDF_OCR_CONCURRENCY / outerN))
				const worker = async () => {
					while (true) {
						const idx = cursor++
						if (idx >= files.length) break
						try {
							const mt = files[idx].mimetype || 'image/jpeg'
							const text = await ocrImageBufferToText(files[idx].buffer, mt, tileConc)
							pageTexts[idx] = String(text || '').trim()
							if (!pageTexts[idx]) throw new Error('empty OCR response')
						} catch (_) {
							logger.error({ image: idx + 1, code: 'IMAGE_OCR_FAILED' }, 'api/analyze-images: OCR image failed after retries')
							failedImages.push(idx + 1)
						}
					}
				}
				const workers = []
				for (let i = 0; i < outerN; i++) workers.push(worker())
				await Promise.all(workers)
				if (failedImages.length > 0) {
					failedImages.sort((a, b) => a - b)
					const error = analysisExecutionError({
						httpStatus: 422,
						errCode: 'IMAGE_OCR_INCOMPLETE',
						failedPages: failedImages,
						totalPages: files.length
					})
					error.publicMessage = `第 ${failedImages.join('、')} 张截图识别失败，已停止评分`
					throw error
				}

				const text = pageTexts
					.map((value, index) => `【第${index + 1}张图片】\n${value}`)
					.join('\n\n')
					.trim()
				logger.info(
					{ total: files.length, ok: pageTexts.length, chars: text.length },
					'api/analyze-images: multi-image OCR complete'
				)
				if (!text || text.length < MIN_TEXT_LEN) {
					throw analysisExecutionError({
						httpStatus: 422,
						errCode: 'IMAGE_TEXT_TOO_SHORT'
					})
				}
				return executeCreditTextAnalysis(text, {
					evidenceRequired: true,
					documentId: identity.documentId,
					inputKind: 'credit-report-images-ordered',
					evidenceContext: {
						version: 'ocr-images-span-v1',
						sourceMode: 'ocr-image',
						expectedPageCount: pageTexts.length,
						complete: true,
						geometryState: 'unavailable',
						pages: pageTexts.map((pageText, index) => ({
							pageNumber: index + 1,
							text: pageText,
							blocks: []
						}))
					}
				})
			}
		})
		return res.json({
			code: 0,
			data: coordinated.data,
			analysis: coordinated.analysis
		})
	} catch (e) {
		const code = e && e.code ? e.code : 'ANALYZE_IMAGES_FAILED'
		const status = Number(e && e.httpStatus) || 500
		logger.error({ code }, 'api/analyze-images failed')
		return res.json({
			code: status >= 500 ? 500 : status,
			msg: (e && e.publicMessage) || PUBLIC_ANALYSIS_ERRORS[code] || '分析服务异常',
			errCode: code
		})
	}
})

app.post('/api/ai/analyze', aiLimiter, optionalAnalyzeBearer, analyzeTextHandler)
app.post('/api/analyze-text', aiLimiter, optionalAnalyzeBearer, analyzeTextHandler)

app.use(userRoutes)
app.use(matchRoutes)
app.use(logRoutes)
app.use(businessRoutes)
app.use(teacherRoutes)
app.use(monitorRoutes)

app.use((req, res) => {
	res.status(404).json({ success: false, errMsg: 'not found', path: req.path })
})

// 统一 JSON 错误处理：无论中间件抛什么，客户端永远拿到 JSON，不再出现 "Unexpected token '<'" 的歧义错误。
// 必须保留 4 个参数（err, req, res, next），Express 才能识别为错误处理 middleware。
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
	logger.error({
		code: safeErrorCode(err),
		method: req && req.method,
		path: req && req.path
	}, 'ai-proxy: unhandled error')
	const status =
		(err && typeof err.status === 'number' && err.status) ||
		(err && typeof err.statusCode === 'number' && err.statusCode) ||
		500
	// 生产环境不回显原始 message（可能含 CORS origin、内部细节、堆栈片段）；细节只进服务端日志。
	const msg = isProductionRuntime
		? (status >= 500 ? 'internal server error' : 'request error')
		: (err && err.message ? err.message : 'internal server error')
	res.status(status).json({
		success: false,
		code: status,
		msg
	})
})

// 防止单个未捕获异常 / Promise rejection 让 Node 进程退出（PM2 重启期间网关会回 502/HTML）。
// 仍然打印堆栈方便排查；进程级问题（OOM 等）应配 PM2 自动重启。
process.on('uncaughtException', (e) => {
	logger.error({ code: safeErrorCode(e, 'UNCAUGHT_EXCEPTION') }, 'uncaughtException')
	// 进程在未捕获异常后可能处于不一致状态：生产环境记录后退出，交由 PM2 拉起干净实例；
	// 非生产保持存活以便本地调试。可用 EXIT_ON_UNCAUGHT=0 关闭。
	if (isProductionRuntime && process.env.EXIT_ON_UNCAUGHT !== '0') {
		setTimeout(() => process.exit(1), 100)
	}
})
process.on('unhandledRejection', (e) => {
	logger.error({ code: safeErrorCode(e, 'UNHANDLED_REJECTION') }, 'unhandledRejection')
})

if (require.main === module) {
	// 启动时快速校验 CJS FOUR_DIM_WEIGHTS 权重和=1（严格双端一致性由 strict-gate 保证）
	const weights = require('./backend/scoringAlgorithms.cjs').FOUR_DIM_WEIGHTS
	const sum = Object.values(weights).reduce((a, b) => a + b, 0)
	if (Math.abs(sum - 1) > 1e-9) {
		console.error('[启动门禁] FOUR_DIM_WEIGHTS 权重和≠1！请检查 backend/scoringAlgorithms.cjs')
		process.exit(1)
	}

	const server = app.listen(PORT, HOST, () => {
		logger.info(
			{
				host: HOST,
				port: PORT,
				pdfUploadMaxMb: PDF_UPLOAD_MAX_MB,
				requestTimeoutMs: REQUEST_TIMEOUT_MS,
				routes: ['/api/parse-pdf', '/api/parse-pdf-upload', '/api/analyze', '/api/analysis/jobs', '/api/analysis/support/:supportRef', '/api/ops/analysis/support/:supportRef', '/api/analyze-image', '/api/ocr-image-text', '/api/analyze-images', '/api/ai/analyze', '/api/analyze-text', '/api/user/*', '/api/match-products', '/api/log/error', '/api/report/*', '/api/advisor/*', '/api/profile/*', '/api/message/*', '/api/optimize/*', '/api/upload', '/api/monitor/sync', '/api/monitor/latest', '/api/monitor/history', '/api/monitor/reports', '/api/monitor/reports/stats']
			},
			'ai-proxy listening'
		)
	})
	analysisTaskService.startAnalysisTaskWorker()
	// 大文件 PDF 深度分析耗时可达数分钟：与客户端 900s 上传超时对齐，避免 Node 默认 requestTimeout 中途断连。
	// headersTimeout 需略大于 requestTimeout；keepAliveTimeout 略大于上游 Nginx，规避连接复用竞态。
	server.requestTimeout = REQUEST_TIMEOUT_MS
	server.headersTimeout = REQUEST_TIMEOUT_MS + 10000
	server.keepAliveTimeout = 75000
}

module.exports = { app, attachSafeScannedOwnershipEvidence }
