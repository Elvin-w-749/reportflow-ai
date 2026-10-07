/**
 * PDF / 图片信用报告解析服务
 *
 * 设计原则：
 *  1. parsePDF(filePath)           → 通过自建后端 /api/parse-pdf 解析
 *  2. extractCreditInfoFromText()  → 正则 + 结构化解析 → 标准数据结构
 *  3. 兼容"人行信用报告"两种账户版式：
 *       A. 贷记卡（信用卡）：含"已使用额度"字段
 *       B. 贷款（消费贷/房贷/车贷等）：含"贷款余额"字段
 *  4. 逾期天数、连三累六、M1/M2/M3 等级均从文本动态解析
 *  5. 与 creditAlgorithmCore：机构分类、贷款类型、大额分期标记写入账户对象
 *
 * 解析失败（读文件、网络、后端返回非 success）一律抛错，不再降级为演示文本。
 */

import PROXY_BASE, { getProxyBaseMisconfigReason, buildProxyApiUrl, DEV_ANALYZE_BEARER_TOKEN } from '@/config/proxy.js'
import { reportError } from './errorReporter.js'
import { resolveAuthToken } from './authService.js'

/**
 * 与 ai-proxy optionalAnalyzeBearer 对齐：AI/解析端点的 Authorization。
 * 已登录优先用登录态 JWT；未登录仅在本地显式配置静态 Bearer 时回退（默认关闭）。
 */
const resolveAnalyzeBearer = () => {
	let token = resolveAuthToken()
	if (!token) token = String(DEV_ANALYZE_BEARER_TOKEN || '').trim()
	return token
}

const buildAnalyzeAuthHeaderOrThrow = () => {
	const token = resolveAnalyzeBearer()
	if (!token) {
		throw new Error('缺少分析凭证：请先登录后再上传信用报告')
	}
	return { Authorization: `Bearer ${token}` }
}
import { classifyInstitution, classifyLoanType, extractBigInstallmentInfo } from './creditAlgorithmCore.js'
import { statusIndicatesOverdue, stripNegatedOverduePhrases } from '../utils/creditStatus.js'

// ─────────────────────────────────────────────
// 后端服务地址
// ─────────────────────────────────────────────
const PDF_EXTRACT_API = buildProxyApiUrl('/api/parse-pdf')
/** 与 ai-proxy POST /api/parse-pdf-upload 对应：multipart file，避免大 PDF base64 JSON 导致连接重置 */
const PDF_UPLOAD_EXTRACT_API = buildProxyApiUrl('/api/parse-pdf-upload')
const OCR_API = buildProxyApiUrl('/api/analyze-image')
const IMAGE_TEXT_OCR_API = buildProxyApiUrl('/api/ocr-image-text')
const LARGE_PDF_BASE64_FALLBACK_LIMIT = 8 * 1024 * 1024
const PDF_UPLOAD_EXTRACT_TIMEOUT = 600000

const knownFileSize = (value) => {
	const n = Number(value)
	return Number.isFinite(n) && n > 0 ? n : null
}

const fileSizeOf = (filePath, opts = {}) =>
	knownFileSize(opts.fileSize) ||
	knownFileSize(filePath && filePath.size) ||
	null

const formatMb = (bytes) => `${(Number(bytes || 0) / 1024 / 1024).toFixed(1)}MB`

const isAuthFailureMessage = (message) =>
	/缺少分析凭证|鉴权失败|unauthorized|登录态|请先登录/i.test(String(message || ''))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 对瞬时网络失败重试（连接重置、超时等）
 */
const retryAsync = async (fn, { attempts = 3, delayMs = 500 } = {}) => {
	let last
	for (let i = 0; i < attempts; i++) {
		try {
			return await fn()
		} catch (e) {
			last = e
			const msg = formatErr(e)
			const retryable = /fail|timeout|reset|ECONN|ECONNRESET|abort|connection|网络/i.test(msg)
			if (i < attempts - 1 && retryable) {
				await sleep(delayMs * (i + 1))
				continue
			}
			throw e
		}
	}
	throw last
}

const parseHostFromUrl = (rawUrl) => {
	try {
		const clean = String(rawUrl || '')
		const noHash = clean.split('#')[0]
		const noQuery = noHash.split('?')[0]
		const m = noQuery.match(/^https?:\/\/([^/]+)/i)
		return m ? String(m[1]).toLowerCase() : ''
	} catch {
		return ''
	}
}

const PROXY_HOST = parseHostFromUrl(PROXY_BASE)
const TRUSTED_REMOTE_HOSTS = [PROXY_HOST].filter(Boolean)
/** 公网可下载 URL；排除微信 http(s)://tmp/ 本地沙箱路径 */
const isRemoteUrl = (p) => /^https?:\/\//i.test(String(p || ''))
const isTrustedRemoteUrl = (url) => {
	const host = parseHostFromUrl(url)
	return !!host && TRUSTED_REMOTE_HOSTS.includes(host)
}

//** fail 回调常为 { errMsg }，无 message；供本模块与 aiAnalysis 统一展示错误 */
export const formatErr = (err) => {
	if (err == null) return '未知错误'
	if (typeof err === 'string') return err
	if (err instanceof Error) return err.message || String(err)
	if (typeof err.message === 'string' && err.message) return err.message
	if (typeof err.errMsg === 'string' && err.errMsg) return err.errMsg
	try {
		return JSON.stringify(err)
	} catch {
		return String(err)
	}
}

// ─────────────────────────────────────────────
// 工具：从 ArrayBuffer magic bytes 判断图片 MIME 类型
// 临时路径可能不含扩展名，使用 magic bytes 判断
// ─────────────────────────────────────────────
const detectImageMimeType = (buffer) => {
	const bytes = new Uint8Array(buffer)
	// PNG: 89 50 4E 47
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
		return 'image/png'
	}
	// JPEG: FF D8 FF
	if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
		return 'image/jpeg'
	}
	// GIF: 47 49 46 38
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
		return 'image/gif'
	}
	// WEBP: 52 49 46 46 ?? ?? ?? ?? 57 45 42 50
	if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
		bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
		return 'image/webp'
	}
	// 兜底：尝试从路径扩展名推断
	return null
}
const arrayBufferToBase64 = (buffer) => {
	// 优先使用 uni 内置 API（typeof 守卫：非 uni 环境下 uni 未声明，直接 `uni &&` 会抛 ReferenceError，
	// 导致下方手动降级分支永远不可达）
	if (typeof uni !== 'undefined' && uni && typeof uni.arrayBufferToBase64 === 'function') {
		return uni.arrayBufferToBase64(buffer)
	}
	// 降级：手动转换（兼容其他环境）
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
	const bytes = new Uint8Array(buffer)
	let base64 = ''
	for (let i = 0; i < bytes.length; i += 3) {
		const b0 = bytes[i]
		const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
		const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
		base64 += chars[b0 >> 2]
		base64 += chars[((b0 & 3) << 4) | (b1 >> 4)]
		base64 += i + 1 < bytes.length ? chars[((b1 & 15) << 2) | (b2 >> 6)] : '='
		base64 += i + 2 < bytes.length ? chars[b2 & 63] : '='
	}
	return base64
}

// ─────────────────────────────────────────────
// 公共工具：下载网络文件到本地临时路径
// ─────────────────────────────────────────────
const downloadFile = (url) => {
	return new Promise((resolve, reject) => {
		uni.downloadFile({
			url,
			success: (res) => {
				if (res.statusCode === 200) resolve(res.tempFilePath)
				else reject(new Error('下载失败，状态码：' + res.statusCode))
			},
			fail: (e) => reject(new Error(formatErr(e)))
		})
	})
}

// ─────────────────────────────────────────────
// 公共工具：读取本地文件为 ArrayBuffer
// ─────────────────────────────────────────────
/**
 * 在 ArrayBuffer 前 1024 字节内查找 %PDF- 文件头偏移量。
 * 兼容带 UTF-8 BOM / 前导空白或少量垃圾字节的 PDF；找不到返回 -1。
 */
const findPdfHeaderOffset = (buffer) => {
	const u8 = new Uint8Array(buffer)
	const n = u8.length
	if (n < 5) return -1
	// %PDF- = 0x25 0x50 0x44 0x46 0x2D
	const scanEnd = Math.min(n - 5, 1024)
	for (let i = 0; i <= scanEnd; i++) {
		if (
			u8[i] === 0x25 &&
			u8[i + 1] === 0x50 &&
			u8[i + 2] === 0x44 &&
			u8[i + 3] === 0x46 &&
			u8[i + 4] === 0x2d
		) {
			return i
		}
	}
	return -1
}

const readFileAsBuffer = (filePath) => {
	return new Promise((resolve, reject) => {
		if (filePath && typeof Blob !== 'undefined' && filePath instanceof Blob && typeof filePath.arrayBuffer === 'function') {
			filePath.arrayBuffer().then(resolve, reject)
			return
		}

		const path = String(filePath || '')
		if (typeof fetch === 'function' && /^(blob:|data:|https?:\/\/|\/)/i.test(path)) {
			fetch(path).then((res) => {
				if (!res.ok && res.status !== 0) {
					throw new Error('文件读取失败，状态码：' + res.status)
				}
				return res.arrayBuffer()
			}).then(resolve, reject)
			return
		}

		const fs = typeof uni !== 'undefined' && typeof uni.getFileSystemManager === 'function'
			? uni.getFileSystemManager()
			: null
		if (fs && typeof fs.readFile === 'function') {
			fs.readFile({
				filePath: path,
				success: (res) => resolve(res.data),
				fail: reject
			})
			return
		}

		reject(new Error('文件读取方式不兼容'))
	})
}

/**
 * 仅读取文件头部 length 字节（默认 1KB），用于 PDF 魔数校验。
 *
 * 大文件场景关键优化：%PDF- 文件头只需前 1KB，不应把整份大 PDF 读进内存。
 * 微信 readFile 自基础库 2.10.0 起支持 position/length 分段读取；旧版本或非
 * 微信端不支持分段时，降级为整文件读取（仍能正确取头部，只是多占用内存）。
 */
const readFileHeadAsBuffer = (filePath, length = 1024) => {
	if (filePath && typeof Blob !== 'undefined' && filePath instanceof Blob && typeof filePath.slice === 'function') {
		const head = filePath.slice(0, length)
		if (head && typeof head.arrayBuffer === 'function') return head.arrayBuffer()
	}
	return new Promise((resolve, reject) => {
		const path = String(filePath || '')
		const fs = typeof uni !== 'undefined' && typeof uni.getFileSystemManager === 'function'
			? uni.getFileSystemManager()
			: null
		if (fs && typeof fs.readFile === 'function' && path && !/^(blob:|data:|https?:\/\/)/i.test(path)) {
			fs.readFile({
				filePath: path,
				position: 0,
				length,
				success: (res) => resolve(res.data),
				fail: () => {
					readFileAsBuffer(filePath).then((buffer) => {
						resolve(buffer.slice ? buffer.slice(0, length) : buffer)
					}, reject)
				}
			})
			return
		}
		readFileAsBuffer(filePath).then((buffer) => {
			resolve(buffer.slice ? buffer.slice(0, length) : buffer)
		}, reject)
	})
}

// ─────────────────────────────────────────────
// 图片 → AI 视觉分析（自建后端）
// ─────────────────────────────────────────────
const callOCRHTTP = (base64Data, mimeType = 'image/jpeg') => {
	return new Promise((resolve, reject) => {
		const cfgErr = getProxyBaseMisconfigReason()
		if (cfgErr) {
			reject(new Error(cfgErr))
			return
		}
		let authHeader
		try {
			authHeader = buildAnalyzeAuthHeaderOrThrow()
		} catch (e) {
			reject(e)
			return
		}
		uni.request({
			url: OCR_API,
			method: 'POST',
			header: { 'Content-Type': 'application/json', ...authHeader },
			data: JSON.stringify({ base64: base64Data, mimeType }),
			timeout: 65000,
			success: (res) => {
				const body = res.data || {}
				const okBySuccess = body.success === true
				const okByCode = typeof body.code === 'number' && body.code === 0
				if (res.statusCode >= 200 && res.statusCode < 300 && (okBySuccess || okByCode)) {
					resolve({ __aiDirect: true, aiResult: body.data || {} })
					return
				}
				const code = res.statusCode != null ? `HTTP ${res.statusCode}` : '无状态码'
				const text = body.errMsg || body.message || body.msg || JSON.stringify(body)
				reject(new Error(`图片分析失败 [${code}]：${text}`))
			},
			fail: (err) => {
				reportError({ kind: 'pdf-ocr-request', message: 'OCR请求失败: ' + ((err && (err.errMsg || err.message)) || 'unknown'), page: 'pdfParser.callOCRHTTP' })
				reject(new Error('网络请求失败: ' + (err.errMsg || JSON.stringify(err))))
			}
		})
	})
}

const callOCRAPI = async (base64Data, mimeType = 'image/jpeg') => {
	if (!base64Data || base64Data.length < 100) {
		throw new Error('base64数据为空或过短，图片读取失败')
	}
	return await callOCRHTTP(base64Data, mimeType)
}

const callImageTextOCRHTTP = (base64Data, mimeType = 'image/jpeg') => {
	return new Promise((resolve, reject) => {
		const cfgErr = getProxyBaseMisconfigReason()
		if (cfgErr) {
			reject(new Error(cfgErr))
			return
		}
		let authHeader
		try {
			authHeader = buildAnalyzeAuthHeaderOrThrow()
		} catch (e) {
			reject(e)
			return
		}
		uni.request({
			url: IMAGE_TEXT_OCR_API,
			method: 'POST',
			header: { 'Content-Type': 'application/json', ...authHeader },
			data: JSON.stringify({ base64: base64Data, mimeType }),
			timeout: 65000,
			success: (res) => {
				const body = res.data || {}
				const text = body && body.data && typeof body.data.text === 'string' ? body.data.text : ''
				if (res.statusCode >= 200 && res.statusCode < 300 && (body.success === true || body.code === 0)) {
					resolve(text)
					return
				}
				const code = res.statusCode != null ? `HTTP ${res.statusCode}` : '无状态码'
				const msg = body.errMsg || body.message || body.msg || JSON.stringify(body)
				reject(new Error(`图片文字识别失败 [${code}]：${msg}`))
			},
			fail: (err) => reject(new Error('图片文字识别网络请求失败: ' + formatErr(err)))
		})
	})
}

// ─────────────────────────────────────────────
// PDF → 纯文本（自建后端）
// ─────────────────────────────────────────────
/** 网关未部署 PDF 抽字或返回了 HTML 错误页 */
export const PDF_TEXT_EXTRACT_UNAVAILABLE =
	'当前服务器未提供 PDF 文本抽取（需 /api/parse-pdf）。请用「拍照/相册」上传信用截图；或在网关部署本仓库 ai-proxy（含 /api/parse-pdf 与 /api/parse-pdf-upload）。'

const responseBodyLooksLikeHtml = (data) => {
	if (typeof data !== 'string') return false
	const t = data.trim()
	return t.length > 0 && t[0] === '<'
}

const callPDFParseHTTP = (base64Data) => {
	return new Promise((resolve, reject) => {
		const cfgErr = getProxyBaseMisconfigReason()
		if (cfgErr) {
			reject(new Error(cfgErr))
			return
		}
		let authHeader
		try {
			authHeader = buildAnalyzeAuthHeaderOrThrow()
		} catch (e) {
			reject(e)
			return
		}
		uni.request({
			url: PDF_EXTRACT_API,
			method: 'POST',
			header: { 'Content-Type': 'application/json', ...authHeader },
			data: JSON.stringify({ base64: base64Data }),
			timeout: 180000,
			success: (res) => {
				const sc = res.statusCode || 0
				if (sc === 404) {
					reject(new Error(PDF_TEXT_EXTRACT_UNAVAILABLE))
					return
				}
				if (typeof res.data === 'string' && responseBodyLooksLikeHtml(res.data)) {
					reject(new Error(PDF_TEXT_EXTRACT_UNAVAILABLE))
					return
				}
				const body = res.data || {}
				const textFromLegacy = body && typeof body.text === 'string' ? body.text : ''
				const textFromCodeData = body && body.data && typeof body.data.text === 'string' ? body.data.text : ''
				const okBySuccess = body.success === true && textFromLegacy
				const okByCode = typeof body.code === 'number' && body.code === 0 && textFromCodeData
				if (res.statusCode === 200 && (okBySuccess || okByCode)) {
					resolve(textFromLegacy || textFromCodeData)
					return
				}
				const code = res.statusCode != null ? `HTTP ${res.statusCode}` : '无状态码'
				const bodyText = res.data !== undefined && res.data !== null
					? (typeof res.data === 'string' ? res.data.slice(0, 200) : JSON.stringify(res.data))
					: '(响应体为空)'
				reject(new Error(`PDF 解析失败 [${code}]：${bodyText}`))
			},
			fail: (err) => {
				reportError({ kind: 'pdf-parse-request', message: 'PDF 解析请求失败: ' + (err && (err.errMsg || err.message) || 'unknown'), page: 'pdfParser.callPDFParseHTTP' })
				reject(new Error('PDF 解析网络请求失败: ' + (err.errMsg || JSON.stringify(err))))
			}
		})
	})
}

const callPDFParseAPI = async (base64Data) => {
	if (!base64Data || base64Data.length < 50) {
		throw new Error('PDF 读取后数据过短')
	}
	return await callPDFParseHTTP(base64Data)
}

/** 404 时回退到 JSON /api/parse-pdf（旧部署无 upload 路由） */
const MARK_PARSE_PDF_UPLOAD_404 = '__PARSE_PDF_UPLOAD_404__'

const pdfUploadHttpError = (message, status) => {
	const httpStatus = Number(status) || 0
	const error = new Error(message)
	error.httpStatus = httpStatus
	error.statusCode = httpStatus
	error.transportKind = 'http'
	return error
}

const callPDFParseUploadHTTP = (filePath) => {
	return new Promise((resolve, reject) => {
		const cfgErr = getProxyBaseMisconfigReason()
		if (cfgErr) {
			reject(new Error(cfgErr))
			return
		}
		let authHeader
		try {
			authHeader = buildAnalyzeAuthHeaderOrThrow()
		} catch (e) {
			reject(e)
			return
		}
		const isBlobFile = filePath && typeof Blob !== 'undefined' && filePath instanceof Blob
		const uploadArgs = {
			url: PDF_UPLOAD_EXTRACT_API,
			name: 'file',
			header: authHeader,
			timeout: PDF_UPLOAD_EXTRACT_TIMEOUT,
			success: (res) => {
				const sc = res.statusCode || 0
				const rawStr = typeof res.data === 'string' ? res.data : ''
				if (sc === 413) {
					reject(pdfUploadHttpError('PDF 上传被网关拦截（HTTP 413）：当前入口上传上限过小，请把 Nginx client_max_body_size 调到 60m 以上。', sc))
					return
				}
				// 仅 404 视为「旧部署无 upload 路由」→ 回退 JSON /api/parse-pdf；
				// 5xx 是真实服务端错误，保留原始信息，不再伪装成「路由缺失」误导日志。
				if (sc === 404) {
					reject(new Error(MARK_PARSE_PDF_UPLOAD_404))
					return
				}
				if (responseBodyLooksLikeHtml(rawStr)) {
					// HTML 正文可能由 CDN/WAF 改写，不能据文案猜测 413；只有响应状态码
					// 本身为 413 才能显示“文件过大”。
					// 5xx 的 HTML 多为网关错误页（502/503 Bad Gateway 等），属真实故障，
					// 不伪装成「路由缺失」触发 base64 回退（否则会再发一次大 payload 仍失败、并掩盖真实错误）。
					if (sc >= 500) {
						reject(pdfUploadHttpError(`PDF 解析服务异常（HTTP ${sc}），请稍后重试`, sc))
						return
					}
					// 404 / 2xx 的 HTML（旧部署无该 multipart 路由，或 SPA 兜底页）→ 回退 JSON /api/parse-pdf
					reject(new Error(MARK_PARSE_PDF_UPLOAD_404))
					return
				}
				let data = {}
				try {
					if (rawStr) {
						data = JSON.parse(rawStr)
					} else if (res.data && typeof res.data === 'object') {
						data = res.data
					} else {
						reject(new Error(MARK_PARSE_PDF_UPLOAD_404))
						return
					}
				} catch {
					reject(new Error(MARK_PARSE_PDF_UPLOAD_404))
					return
				}
				const textFromLegacy = typeof data.text === 'string' ? data.text : ''
				const textFromCodeData = data && data.data && typeof data.data.text === 'string' ? data.data.text : ''
				const okBySuccess = data.success === true && textFromLegacy
				const okByCode = typeof data.code === 'number' && data.code === 0 && textFromCodeData
				if (sc === 200 && (okBySuccess || okByCode)) {
					resolve(textFromLegacy || textFromCodeData)
					return
				}
				const errMsg = (data && (data.errMsg || data.message || data.msg))
					? String(data.errMsg || data.message || data.msg)
					: `HTTP ${sc}`
				reject(sc >= 400 ? pdfUploadHttpError(errMsg, sc) : new Error(errMsg))
			},
			fail: (err) => {
				const raw = formatErr(err)
				reject(new Error('PDF multipart 上传失败: ' + raw))
			}
		}
		if (isBlobFile) uploadArgs.file = filePath
		else uploadArgs.filePath = filePath
		uni.uploadFile(uploadArgs)
	})
}

/**
 * 上传前校验本地文件是否为 PDF 魔数（与网关 pdf-parse 校验一致）
 */
export const assertLocalPdfMagicBytes = async (filePath) => {
	let localPath = filePath
	if (isRemoteUrl(filePath)) {
		if (!isTrustedRemoteUrl(filePath)) {
			throw new Error('仅支持本地临时文件，或来自受信任域名的文件地址，请重新选择上传文件')
		}
		localPath = await downloadFile(filePath)
	}
	let buffer
	try {
		// 仅读头部 1KB 做魔数校验：避免把大 PDF 整份读进内存（后续 multipart 上传按路径流式传输）
		buffer = await readFileHeadAsBuffer(localPath, 1024)
	} catch (e) {
		// 本地预校验读取失败时不阻断上传：部分基础库/开发者工具下 readFile 无法解析
		// http://tmp/ 沙箱路径（报 readFile:fail ... not found），但 uni.uploadFile 仍可正常上传该路径。
		// 服务端 /api/analyze 会再次校验 PDF 魔数，这里降级跳过即可，避免误杀合法 PDF。
		console.warn('[pdfParser] 本地 PDF 预校验读取失败，跳过本地魔数校验，交由服务端校验：', formatErr(e))
		return
	}
	const n = buffer.byteLength || 0
	if (n < 5) {
		throw new Error('文件过短，无法作为 PDF 解析')
	}
	if (findPdfHeaderOffset(buffer) < 0) {
		throw new Error('所选文件不是标准 PDF（缺少 %PDF- 文件头）。请使用信用中心/银行导出的 PDF，或使用「拍照上传」。')
	}
}

// ─────────────────────────────────────────────
// 对外：解析 PDF 文件 → 纯文本（失败抛错）
// ─────────────────────────────────────────────
export const parsePDF = async (filePath, opts = {}) => {
	let localPath = filePath
	if (isRemoteUrl(filePath)) {
		if (!isTrustedRemoteUrl(filePath)) {
			throw new Error('仅支持本地临时文件，或来自受信任域名的文件地址，请重新选择上传文件')
		}
		localPath = await downloadFile(filePath)
	}
	const fileSize = fileSizeOf(filePath, opts) || fileSizeOf(localPath, opts)
	const isLargePdf = !!fileSize && fileSize >= LARGE_PDF_BASE64_FALLBACK_LIMIT
	// 仅读头部做魔数校验：主链路走 multipart（按路径流式上传），无需把大 PDF 整份读进内存。
	const headBuffer = await readFileHeadAsBuffer(localPath, 1024)
	const n = headBuffer.byteLength || 0
	if (n < 5) {
		throw new Error('PDF 文件过短')
	}
	if (findPdfHeaderOffset(headBuffer) < 0) {
		throw new Error('所选文件不是标准 PDF（缺少 %PDF- 文件头）。请使用信用中心/银行导出的 PDF，或使用「拍照上传」。')
	}

	try {
		return await retryAsync(() => callPDFParseUploadHTTP(localPath), { attempts: 2, delayMs: 600 })
	} catch (e1) {
		const m1 = formatErr(e1)
		if (isAuthFailureMessage(m1)) {
			throw e1
		}
		// 真实 HTTP 错误已经由服务器/网关给出结论，不再改走 base64 重传。
		// 这既避免 413 后重复上传，也防止 HTML 502 因正文含“大文件”字样而被误报。
		if (e1?.transportKind === 'http' && Number(e1.httpStatus) >= 400) {
			throw e1
		}
		if (isLargePdf) {
			if (m1.includes(MARK_PARSE_PDF_UPLOAD_404)) {
				throw new Error(`PDF 文件约 ${formatMb(fileSize)}，当前服务器缺少 /api/parse-pdf-upload。大文件不会再走 base64 回退，请先发布 multipart 解析接口。`)
			}
			throw new Error(`PDF 文件约 ${formatMb(fileSize)}，multipart 解析失败，已停止 base64 回退以避免文件膨胀导致手机端读取失败。${m1}`)
		}
		if (m1.includes(MARK_PARSE_PDF_UPLOAD_404)) {
			console.warn('[pdfParser] /api/parse-pdf-upload 不可用（404/HTML/非 JSON），回退 JSON /api/parse-pdf')
		} else {
			console.warn('[pdfParser] multipart 抽字失败，回退 JSON base64:', m1)
		}
		// 仅在确需 base64 回退时才整份读入并编码（峰值内存约 2.3× 文件大小）；
		// 主链路成功时完全不触发，保障大文件可用性。
		const buffer = await readFileAsBuffer(localPath)
		const base64 = arrayBufferToBase64(buffer)
		try {
			return await retryAsync(() => callPDFParseAPI(base64), { attempts: 2, delayMs: 800 })
		} catch (e2) {
			const m2 = formatErr(e2)
			if (m2.includes(PDF_TEXT_EXTRACT_UNAVAILABLE) || /404|代理未找到|parse-pdf/i.test(m2)) {
				throw new Error(PDF_TEXT_EXTRACT_UNAVAILABLE)
			}
			throw e2
		}
	}
}

// 注：历史上的「云端解析兜底」链路（网关无 /api/analyze 时改走第三方云函数的解析接口）
// 已整体下线——本项目不使用任何外部云函数，二者均无调用方（parsePDF 主链路走
// /api/parse-pdf-upload → /api/parse-pdf），属死代码，故移除。
// 如未来需恢复某种远端解析兜底，可在 git 历史中找回。

// ─────────────────────────────────────────────
// 对外：解析图片 → AI 视觉 JSON 或失败抛错
// ─────────────────────────────────────────────
export const parseImage = async (filePath) => {
	let localPath = filePath
	if (isRemoteUrl(filePath)) {
		if (!isTrustedRemoteUrl(filePath)) {
			throw new Error('仅支持本地临时文件，或来自受信任域名的文件地址，请重新选择上传图片')
		}
		localPath = await downloadFile(filePath)
	}
	const buffer = await readFileAsBuffer(localPath)
	const base64 = arrayBufferToBase64(buffer)

	let mimeType = detectImageMimeType(buffer)
	if (!mimeType) {
		const lower = localPath.toLowerCase()
		if (lower.endsWith('.png')) mimeType = 'image/png'
		else if (lower.endsWith('.gif')) mimeType = 'image/gif'
		else if (lower.endsWith('.webp')) mimeType = 'image/webp'
		else mimeType = 'image/jpeg'
	}

	return await callOCRAPI(base64, mimeType)
}

export const parseImageText = async (filePath) => {
	let localPath = filePath
	if (isRemoteUrl(filePath)) {
		if (!isTrustedRemoteUrl(filePath)) {
			throw new Error('仅支持本地临时文件，或来自受信任域名的文件地址，请重新选择上传图片')
		}
		localPath = await downloadFile(filePath)
	}
	const buffer = await readFileAsBuffer(localPath)
	const base64 = arrayBufferToBase64(buffer)
	let mimeType = detectImageMimeType(buffer)
	if (!mimeType) {
		const lower = String(localPath || '').toLowerCase()
		if (lower.endsWith('.png')) mimeType = 'image/png'
		else if (lower.endsWith('.gif')) mimeType = 'image/gif'
		else if (lower.endsWith('.webp')) mimeType = 'image/webp'
		else mimeType = 'image/jpeg'
	}
	return await callImageTextOCRHTTP(base64, mimeType)
}

// ─────────────────────────────────────────────
// 核心：从信用报告文本中结构化提取所有字段
// 支持版式：
//   · 人行信用中心标准报告
//   · 各大银行 APP 导出报告
//   · 百行信用 / 朴道信用
// ─────────────────────────────────────────────
export const extractCreditInfoFromText = (text) => {
	if (!text || typeof text !== 'string') return buildEmptyResult()
	const normalizedText = normalizePaperCreditText(text)

	const result = {
		basicInfo:      extractBasicInfo(normalizedText),
		creditAccounts: extractAllAccounts(normalizedText),
		overdueRecords: [],          // 将在 buildOverdueRecords 中填充
		queryRecords:   extractQueryRecords(normalizedText),
		publicRecords:  extractPublicRecords(normalizedText),
		creditSummary:  extractCreditSummary(normalizedText),
		parseMeta:      buildParseMeta(text, normalizedText),
		rawText:        text          // 保留原文供深度分析
	}

	// 汇总逾期记录（从账户中归集）
	result.overdueRecords = buildOverdueRecords(result.creditAccounts)

	// 衍生：连三累六判断
	result.consecutiveOverdue = detectConsecutiveOverdue(result.creditAccounts)

	return result
}

const PAPER_PAGE_RE = /第\s*(\d+)\s*页\s*[，,\/]?\s*共\s*(\d+)\s*页/g

const countPaperPages = (text) => {
	const source = String(text || '')
	let maxPage = 0
	let maxTotal = 0
	let m
	while ((m = PAPER_PAGE_RE.exec(source)) !== null) {
		maxPage = Math.max(maxPage, parseInt(m[1]) || 0)
		maxTotal = Math.max(maxTotal, parseInt(m[2]) || 0)
	}
	PAPER_PAGE_RE.lastIndex = 0
	return Math.max(maxPage, maxTotal)
}

const normalizePaperCreditText = (text) => String(text || '')
	.replace(/\r/g, '\n')
	.replace(PAPER_PAGE_RE, '\n')
	.replace(/[ \t]+\n/g, '\n')
	.replace(/\n{3,}/g, '\n\n')
	.trim()

const buildParseMeta = (rawText, normalizedText) => ({
	sourceType: countPaperPages(rawText) > 0 ? 'pboc-paper-or-scan' : 'text',
	pageCountHint: countPaperPages(rawText),
	rawLength: String(rawText || '').length,
	normalizedLength: String(normalizedText || '').length
})

// ─────────────────────────────────────────────
// 提取基本信息
// ─────────────────────────────────────────────
const extractBasicInfo = (text) => {
	const info = {}

	const match = (pattern) => { const m = text.match(pattern); return m ? m[1].trim() : '' }

	info.name       = match(/姓\s*名[：:]\s*(\S+)/)
	info.idCard     = match(/证件号码[：:]\s*(\S+)/)
	info.phone      = match(/手机号[码]?[：:]\s*(\S+)/)
	info.reportDate = normalizeDate(match(/查询日期[：:]\s*([\d年\s月日]+)/))
	if (!info.reportDate) {
		const rt = text.match(/报告时间[：:\s]*(\d{4}-\d{2}-\d{2})/)
		if (rt) info.reportDate = rt[1]
	}
	if (!info.reportDate) {
		const rg = text.match(/报告生成时间[：:\s]*(\d{4}-\d{2}-\d{2})/)
		if (rg) info.reportDate = rg[1]
	}
	info.reportNo   = match(/报告编号[：:]\s*(\S+)/)
	info.birthDate  = normalizeDate(match(/出生日期[：:]\s*([\d年\s月日]+)/))
	info.address    = match(/居住地址[：:]\s*([^\n]+)/)

	return info
}

// ─────────────────────────────────────────────
// 提取所有信贷账户（兼容两种版式）
// ─────────────────────────────────────────────
const extractAllAccounts = (text) => {
	const accounts = []

	// 按账户段分割（以编号+机构名起始）
	// 匹配形如：1. 招商银行信用卡  /  2. 微粒贷  等
	const segments = splitIntoAccountSegments(text)

	for (const seg of segments) {
		const acc = parseAccountSegment(seg)
		if (acc) accounts.push(acc)
	}

	// 人行 PDF 抽字常是叙述式账户行：
	// 「YYYY年MM月DD日某机构发放的贷记卡/贷款……截至YYYY年MM月，信用额度/余额……」
	// 这类真实报告没有「账户类型：」字段块，需走叙述式补充解析。
	return dedupeAccounts([...accounts, ...extractNarrativeAccounts(text)])
}

const parseAmountText = (value) => {
	const raw = String(value || '')
	const n = parseFloat(raw.replace(/,/g, '').replace(/[元人民币万（）()]/g, ''))
	if (!Number.isFinite(n)) return 0
	return /万/.test(raw) ? n * 10000 : n
}

const parseAmountWithUnit = (amount, unit = '') => parseAmountText(`${amount || ''}${unit || ''}`)

const emptyCreditSummary = () => ({
	loanInstitutionCount: 0,
	loanAccountCount: 0,
	loanOpenCount: 0,
	loanBalance: 0,
	cardInstitutionCount: 0,
	cardAccountCount: 0,
	cardOpenCount: 0,
	totalCreditLine: 0,
	usedCredit: 0,
	guaranteeBalance: 0,
	rawHints: []
})

const extractCreditSummary = (text) => {
	const summary = emptyCreditSummary()
	const compact = String(text || '').replace(/\s+/g, '')

	const loan = compact.match(/贷款(?:法人)?机构数(\d+)账户数(\d+)(?:未结清|未销户)账户数(\d+)余额([\d,.]+)(万)?元?/)
	if (loan) {
		summary.loanInstitutionCount = parseInt(loan[1]) || 0
		summary.loanAccountCount = parseInt(loan[2]) || 0
		summary.loanOpenCount = parseInt(loan[3]) || 0
		summary.loanBalance = parseAmountWithUnit(loan[4], loan[5])
		summary.rawHints.push('loan-summary')
	}

	const card = compact.match(/信用卡(?:发卡)?机构数(\d+)账户数(\d+)(?:未销户|未结清)账户数(\d+)(?:授信总额|信用额度)([\d,.]+)(万)?元?(?:已用额度|已使用额度)([\d,.]+)(万)?元?/)
	if (card) {
		summary.cardInstitutionCount = parseInt(card[1]) || 0
		summary.cardAccountCount = parseInt(card[2]) || 0
		summary.cardOpenCount = parseInt(card[3]) || 0
		summary.totalCreditLine = parseAmountWithUnit(card[4], card[5])
		summary.usedCredit = parseAmountWithUnit(card[6], card[7])
		summary.rawHints.push('card-summary')
	}

	const guarantee = compact.match(/对外担保(?:余额|金额)([\d,.]+)(万)?元?/)
	if (guarantee) {
		summary.guaranteeBalance = parseAmountWithUnit(guarantee[1], guarantee[2])
		summary.rawHints.push('guarantee-summary')
	}

	return summary
}

const normalizeNarrativeText = (text) => String(text || '')
	.replace(PAPER_PAGE_RE, '')
	.replace(/\s+/g, '')

const OVERDUE_MATRIX_CODE_RE = /^[1-7]$/

const normalizeMatrixToken = (token) => {
	const t = String(token || '').trim()
	if (!t) return ''
	const half = t.replace(/[０-７]/g, (c) => String(c.charCodeAt(0) - 0xff10)).replace(/／/g, '/')
	const code = half.toUpperCase()
	return /^[NCDGZ0-7*#/]$/.test(code) ? code : ''
}

const parseRepayMatrixTokens = (raw) => {
	const source = String(raw || '').trim()
	if (!source) return []
	if (/[\s|、,，]/.test(source)) {
		return source
			.split(/[\s|、,，]+/)
			.map(normalizeMatrixToken)
			.filter(Boolean)
	}
	return (source.match(/[NnCcGgDdZz０-７0-7*#／/]/g) || [])
		.map(normalizeMatrixToken)
		.filter(Boolean)
}

const isOverdueMatrixCode = (code) => OVERDUE_MATRIX_CODE_RE.test(normalizeMatrixToken(code))

const extractPaperOverdueSummary = (text) => {
	const source = String(text || '')
	const overdueMonths = (() => {
		const m = source.match(/最近(?:5|五)年内(?:有)?(\d+)个月处于逾期状态/)
		return m ? parseInt(m[1]) || 0 : 0
	})()
	const over90Months = (() => {
		const m = source.match(/逾期超过\s*90\s*天的月份数(?:为)?(\d+)/)
		return m ? parseInt(m[1]) || 0 : 0
	})()
	const maxOverdueMonths = (() => {
		const m = source.match(/最长逾期(?:为)?(\d+)个?月/)
		return m ? parseInt(m[1]) || 0 : 0
	})()
	const overdueDays = Math.max(
		over90Months > 0 ? 91 : 0,
		maxOverdueMonths * 30,
		overdueMonths > 0 ? 30 : 0
	)
	return { overdueMonths, over90Months, maxOverdueMonths, overdueDays }
}

const extractNarrativeRiskFields = (context) => {
	const source = String(context || '')
	const fiveCategory = (() => {
		const m = source.match(/五级分类(?:为|是|：|:)?(正常|关注|次级|可疑|损失)/)
		return m ? m[1] : ''
	})()
	const repayMatrix = extractRepayMatrix(source)
	const overdueSummary = extractPaperOverdueSummary(source)
	const overdueAmount = (() => {
		const m = source.match(/逾期金额(?:为|：|:)?([\d,.]+)(万)?元?/)
		return m ? parseAmountWithUnit(m[1], m[2]) : 0
	})()
	const overdueEvidenceText = stripNegatedOverduePhrases(source)
	const currentOverdue = /当前[^。；，]*逾期|处于逾期状态|逾期超过\s*90\s*天|最长逾期/.test(overdueEvidenceText)
	const abnormal = fiveCategory && fiveCategory !== '正常'
	return {
		fiveCategory,
		repayMatrix,
		overdueDays: overdueSummary.overdueDays,
		overdueAmount,
		overdueSummary,
		status: currentOverdue ? '逾期' : (abnormal ? fiveCategory : ''),
		overdue: currentOverdue || abnormal || repayMatrix.some(isOverdueMatrixCode)
	}
}

const makeNarrativeAccount = ({
	bank,
	accountType,
	isLoan,
	openDate,
	endDate = '',
	limit = 0,
	balance = 0,
	loanAmount = 0,
	status = '正常',
	settled = false,
	overdue = false,
	repayRecord = '',
	repayMatrix = [],
	overdueDays = 0,
	overdueAmount = 0,
	overdueDate = '',
	overdueSummary = null,
	fiveCategory = '',
	guaranteeType = '',
	sharedResponsibility = false,
	sourceType = 'narrative'
}) => {
	const bi = extractBigInstallmentInfo(`${bank}${accountType}`)
	const statusText = [status, fiveCategory].filter(Boolean).join(' ')
	const finalRepayMatrix = Array.isArray(repayMatrix) ? repayMatrix : []
	const finalOverdueDays = Number(overdueDays) || parseOverdueDaysFromRecord(repayRecord)
	const matrixHasOverdue = finalRepayMatrix.some(isOverdueMatrixCode)
	const finalOverdueLevel = classifyOverdueLevel(finalOverdueDays, statusText)
	const finalIsOverdue = overdue || finalOverdueDays > 0 || matrixHasOverdue || statusIndicatesOverdue(statusText)
	return {
		bank,
		accountType,
		isLoan,
		institutionCategory: classifyInstitution(bank),
		loanTypeCategory: classifyLoanType(`${accountType} ${bank}`),
		hasBigInstallment: bi.is_big_installment,
		bigInstallmentAmount: bi.installment_amount,
		limit,
		balance,
		loanAmount: isLoan ? (loanAmount || limit) : 0,
		status,
		openDate: normalizeDate(openDate),
		endDate: normalizeDate(endDate),
		isSettled: settled || /结清|销户|注销/.test(status),
		repayRecord,
		repayMethod: '',
		monthlyPayment: 0,
		guaranteeType,
		sharedResponsibility,
		sourceType,
		fiveCategory,
		overdueSummary,
		repayMatrix: finalRepayMatrix,
		overdueDays: finalOverdueDays,
		overdueAmount,
		overdueDate,
		overdueLevel: finalOverdueLevel,
		isOverdue: finalIsOverdue
	}
}

const dedupeAccounts = (accounts) => {
	const seen = new Set()
	const out = []
	for (const acc of accounts) {
		if (!acc) continue
		const key = [acc.bank, acc.accountType, acc.openDate, acc.endDate, Math.round(Number(acc.limit) || 0), Math.round(Number(acc.balance) || 0), acc.isSettled ? 'settled' : 'active'].join('|')
		if (seen.has(key)) continue
		seen.add(key)
		out.push(acc)
	}
	return out
}

const extractNarrativeAccounts = (text) => {
	const source = normalizeNarrativeText(text)
	const accounts = []
	const contextFor = (startIndex) => {
		const chunk = source.slice(Math.max(0, startIndex), startIndex + 700)
		const next = chunk.slice(30).search(/[。；][^。；]{0,18}\d{4}年\d{1,2}月\d{1,2}日/)
		return next >= 0 ? chunk.slice(0, next + 31) : chunk
	}
	const push = (row, context = '') => {
		if (!row || !row.bank || !row.accountType) return
		const risk = extractNarrativeRiskFields(context)
		const status = risk.status || row.status || '正常'
		accounts.push(makeNarrativeAccount({
			...row,
			...risk,
			status,
			overdue: !!row.overdue || !!risk.overdue,
			repayMatrix: risk.repayMatrix && risk.repayMatrix.length ? risk.repayMatrix : (row.repayMatrix || [])
		}))
	}

	// 当前信用卡：发放的贷记卡……截至某月，信用额度X，已使用额度/余额Y。
	const cardActiveRe = /(\d{4}年\d{1,2}月\d{1,2}日)([^。；，]{2,90}?)发放的((?:贷记卡|准贷记卡|信用卡)(?:（[^）]*）)?)[。；，]?截至(\d{4}年\d{1,2}月)，信用额度([\d,]+)，(?:已使用额度|余额)([\d,]+)/g
	let m
	while ((m = cardActiveRe.exec(source)) !== null) {
		push({ openDate: m[1], bank: m[2], accountType: m[3], isLoan: false, limit: parseAmountText(m[5]), balance: parseAmountText(m[6]), status: '正常' }, contextFor(m.index))
	}

	// 已销户信用卡。
	const cardSettledRe = /(\d{4}年\d{1,2}月\d{1,2}日)([^。；，]{2,90}?)发放的((?:贷记卡|准贷记卡|信用卡)(?:（[^）]*）)?)[，,](\d{4}年\d{1,2}月)销户/g
	while ((m = cardSettledRe.exec(source)) !== null) {
		push({ openDate: m[1], bank: m[2], accountType: m[3], isLoan: false, endDate: m[4], status: '已销户', settled: true }, contextFor(m.index))
	}

	// 当前贷款：发放的X元贷款，到期。截至某月，余额Y。
	const loanActiveRe = /(\d{4}年\d{1,2}月\d{1,2}日)([^。；，]{2,90}?)发放的([\d,]+)元（人民币）([^。；，]{2,40}?贷款)[，,](\d{4}年\d{1,2}月\d{1,2}日)到期[。；，]?截至(\d{4}年\d{1,2}月)，余额(?:为)?([\d,]+)/g
	while ((m = loanActiveRe.exec(source)) !== null) {
		push({ openDate: m[1], bank: m[2], accountType: m[4], isLoan: true, endDate: m[5], limit: parseAmountText(m[3]), loanAmount: parseAmountText(m[3]), balance: parseAmountText(m[7]), status: '正常' }, contextFor(m.index))
	}

	// 循环贷款授信：为某类贷款授信，额度有效/长期有效，可循环使用。截至某月，信用额度X，余额为Y，当前无逾期。
	const revolvingLoanRe = /(\d{4}年\d{1,2}月\d{1,2}日)([^。；，]{2,90}?)为([^。；，]{2,40}?贷款)授信[，,]额度(?:有效期至(\d{4}年\d{1,2}月\d{1,2}日)|长期有效)[，,]可循环使用[。；，]?截至(\d{4}年\d{1,2}月)，信用额度([\d,]+)元（人民币），余额为([\d,]+)[，,]当前([^。；，]+)/g
	while ((m = revolvingLoanRe.exec(source)) !== null) {
		const overdue = statusIndicatesOverdue(m[8])
		push({ openDate: m[1], bank: m[2], accountType: `${m[3]}授信`, isLoan: true, endDate: m[4] || '', limit: parseAmountText(m[6]), loanAmount: parseAmountText(m[6]), balance: parseAmountText(m[7]), status: overdue ? '逾期' : '正常', overdue }, contextFor(m.index))
	}

	// 已结清贷款。
	const loanSettledRe = /(\d{4}年\d{1,2}月\d{1,2}日)([^。；，]{2,90}?)发放的([\d,]+)元（人民币）([^。；，]{2,40}?贷款)[，,](\d{4}年\d{1,2}月)已结清/g
	while ((m = loanSettledRe.exec(source)) !== null) {
		push({ openDate: m[1], bank: m[2], accountType: m[4], isLoan: true, endDate: m[5], limit: parseAmountText(m[3]), loanAmount: parseAmountText(m[3]), balance: 0, status: '已结清', settled: true }, contextFor(m.index))
	}

	// 对外担保责任：纸质报告会单列为「为他人担保」或「相关还款责任」。
	const guaranteeRe = /(\d{4}年\d{1,2}月\d{1,2}日)([^。；，]{2,90}?)为他人担保的([^。；，]{2,40}?贷款)[。；，]?截至(\d{4}年\d{1,2}月)，担保余额(?:为)?([\d,]+)(?:元)?/g
	while ((m = guaranteeRe.exec(source)) !== null) {
		push({
			openDate: m[1],
			bank: m[2],
			accountType: m[3],
			isLoan: true,
			endDate: m[4],
			balance: parseAmountText(m[5]),
			status: '担保责任',
			guaranteeType: '为他人担保',
			sourceType: 'guarantee'
		}, contextFor(m.index))
	}

	const sharedResponsibilityRe = /(\d{4}年\d{1,2}月\d{1,2}日)([^。；，]{2,90}?)(?:作为共同借款人|作为共同还款人|承担相关还款责任)(?:承担相关还款责任)?的([^。；，]{2,40}?贷款)[。；，]?截至(\d{4}年\d{1,2}月)，余额(?:为)?([\d,]+)(?:元)?/g
	while ((m = sharedResponsibilityRe.exec(source)) !== null) {
		push({
			openDate: m[1],
			bank: m[2],
			accountType: m[3],
			isLoan: true,
			endDate: m[4],
			balance: parseAmountText(m[5]),
			status: '相关还款责任',
			sharedResponsibility: true,
			sourceType: 'shared-responsibility'
		}, contextFor(m.index))
	}

	return dedupeAccounts(accounts)
}
/**
 * 将文本按账户块切分
 * 策略：找到所有"数字. 机构名"起始位置，逐段切割
 */
const splitIntoAccountSegments = (text) => {
	// 匹配账户段起始：行首数字序号 + 机构/产品名称
	const segStartRe = /(?:^|\n)(\d+)[.、．]\s*([^\n]{2,30})\n账户类型/g
	const positions = []
	let m
	while ((m = segStartRe.exec(text)) !== null) {
		positions.push(m.index)
	}

	if (positions.length === 0) return []

	const segments = []
	for (let i = 0; i < positions.length; i++) {
		const start = positions[i]
		const end   = i + 1 < positions.length ? positions[i + 1] : text.length
		segments.push(text.slice(start, end))
	}
	return segments
}

/**
 * 解析单个账户段文本 → 标准账户对象
 */
const parseAccountSegment = (seg) => {
	if (!seg) return null

	const get = (pattern, defaultVal = '') => {
		const m = seg.match(pattern)
		return m ? m[1].trim() : defaultVal
	}
	const getNum = (pattern, defaultVal = 0) => {
		const m = seg.match(pattern)
		if (!m) return defaultVal
		const n = parseFloat(m[1].replace(/,/g, ''))
		return Number.isFinite(n) ? n : defaultVal
	}

	// 机构名
	const bankMatch = seg.match(/\d+[.、．]\s*([^\n]+)/)
	const bank = bankMatch ? bankMatch[1].trim() : ''
	if (!bank) return null

	const accountType = get(/账户类型[：:]\s*([^\n]+)/)
	const fiveCategory = get(/五级分类[：:\s]*(正常|关注|次级|可疑|损失)/)
	const status      = get(/账户状态[：:]\s*([^\n]+)/) || fiveCategory || '正常'
	const openDate    = normalizeDate(get(/开户日期[：:]\s*([\d年\s月日]+)/))
	const repayRecord = get(/还款记录[：:]\s*([^\n]+)/)

	// ── 版式 A：贷记卡（信用卡）──
	const creditLimit = getNum(/授信额度[：:]\s*([\d,]+\.?\d*)\s*元/)
	const usedCredit  = getNum(/已使用额度[：:]\s*([\d,]+\.?\d*)\s*元/)

	// ── 版式 B：贷款 ──
	const loanBalance = getNum(/贷款余额[：:]\s*([\d,]+\.?\d*)\s*元/)
	const loanAmount  = getNum(/贷款金额[：:]\s*([\d,]+\.?\d*)\s*元/)
	// 版式 B 也可能用"授信额度"表示贷款总额
	const loanLimit   = creditLimit || getNum(/授信额度[：:]\s*([\d,]+\.?\d*)\s*元/)

	// 到期/结清日期
	const endDate     = normalizeDate(get(/到期日期[：:]\s*([\d年\s月日]+)/))
	const settleDate  = normalizeDate(get(/结清日期[：:]\s*([\d年\s月日]+)/))

	// ── 逾期信息 ──
	const overdueDaysRaw  = get(/逾期\s*(\d+)\s*天/)
	const overdueSummary  = extractPaperOverdueSummary(seg)
	const overdueDays     = overdueDaysRaw ? parseInt(overdueDaysRaw) : Math.max(parseOverdueDaysFromRecord(repayRecord), overdueSummary.overdueDays)
	const overdueAmount   = getNum(/逾期金额[：:]\s*([\d,]+\.?\d*)\s*元/)
	const overdueDate     = normalizeDate(get(/逾期日期[：:]\s*([\d年\s月日]+)/))

	// 月还款额（部分版式有此字段）
	const monthlyPayment  = getNum(/月还款额[：:]\s*([\d,]+\.?\d*)\s*元/)
	// 还款方式
	const repayMethod     = get(/还款方式[：:]\s*([^\n]+)/)
	// 担保方式
	const guaranteeType   = get(/担保方式[：:]\s*([^\n]+)/)

	// ── 24期还款状态矩阵（人行报告格式）──
	const repayMatrix     = extractRepayMatrix(seg)

	// ── M1/M2/M3 逾期等级 ──
	const overdueLevel    = classifyOverdueLevel(overdueDays, `${status}${fiveCategory}`)

	// ── 判断是信用卡还是贷款 ──
	// 先排除卡类：贷记卡/信用卡/准贷记卡 即使含「分期」（如「贷记卡大额专项分期」）也属卡，
	// 否则会被当贷款，导致额度/余额映射到 loanLimit/loanBalance 而非 creditLimit/usedCredit。
	const isCard = /贷记卡|信用卡|准贷记卡/.test(accountType)
	const isLoan = !isCard && /贷款|借贷|分期|消费贷|房贷|车贷|经营贷|装修贷/.test(accountType)

	const bi = extractBigInstallmentInfo(seg)

	const account = {
		bank,
		accountType,
		isLoan,
		institutionCategory: classifyInstitution(bank),
		loanTypeCategory:    classifyLoanType(`${accountType} ${bank}`),
		hasBigInstallment:   bi.is_big_installment,
		bigInstallmentAmount: bi.installment_amount,
		// 额度/余额（统一字段名方便后续计算）
		limit:        isLoan ? loanLimit  : creditLimit,
		balance:      isLoan ? loanBalance : usedCredit,
		loanAmount:   isLoan ? (loanAmount || loanLimit) : 0,
		status,
		openDate,
		endDate:      endDate || settleDate,
		isSettled:    !!settleDate || status === '已结清',
		// 还款相关
		repayRecord,
		repayMethod,
		monthlyPayment,
		guaranteeType,
		sharedResponsibility: /共同借款|共同还款|相关还款责任/.test(seg),
		sourceType: 'field-block',
		fiveCategory,
		overdueSummary,
		repayMatrix,
		// 逾期相关
		overdueDays,
		overdueAmount,
		overdueDate,
		overdueLevel,   // 'none' | 'M1' | 'M2' | 'M3+'
		isOverdue:      overdueDays > 0 || repayMatrix.some(isOverdueMatrixCode) || statusIndicatesOverdue(`${status}${fiveCategory}`)
	}

	return account
}

/**
 * 从"还款记录"字段文本中解析逾期天数
 * 例：
 *   "逾期 15 天" → 15
 *   "逾期1个月" → 30
 *   "正常" → 0
 */
const parseOverdueDaysFromRecord = (record) => {
	if (!record) return 0
	const dayMatch = record.match(/逾期\s*(\d+)\s*天/)
	if (dayMatch) return parseInt(dayMatch[1])
	const monthMatch = record.match(/逾期\s*(\d+)\s*个?月/)
	if (monthMatch) return parseInt(monthMatch[1]) * 30
	const over90Match = record.match(/逾期超过\s*90\s*天/)
	if (over90Match) return 91
	return 0
}

/**
 * 提取 24 期还款状态矩阵（人行信用报告特有）
 * 格式示例：
 *   还款状态：正正正正正正逾逾逾正正正
 *   或：N N N N N 1 1 2 3 N N N
 * 返回数组，每元素为单月状态码：'N'正常 '1'逾期1月 '2'逾期2月 等
 */
const extractRepayMatrix = (seg) => {
	// 尝试匹配数字矩阵形式（1=逾期1期，2=逾期2期，N=正常，C/G/D/Z 等为结清/结束/担保类非逾期状态）
	const matrixMatch = seg.match(/(?:最近(?:5|五)年(?:内)?还款状态|还款状态)[：:\s]*([NnCcGgDdZz０-７0-7\*#\/／\s\|、,，]{6,})/)
	if (matrixMatch) {
		return parseRepayMatrixTokens(matrixMatch[1])
	}
	// 尝试匹配文字形式（"正正逾逾逾正"）
	const textMatch = seg.match(/还款记录[：:]\s*([正逾\*未]{3,})/)
	if (textMatch) {
		return textMatch[1].split('').map(c => c === '正' ? 'N' : c === '逾' ? '1' : '*')
	}
	return []
}

/**
 * 根据逾期天数 & 账户状态 → 分级 M1/M2/M3+
 * 银行业标准：
 *   M1 = 逾期 1~30 天（含）
 *   M2 = 逾期 31~60 天
 *   M3+ = 逾期 61 天以上 / 呆账 / 核销
 */
const classifyOverdueLevel = (days, status) => {
	const s = status || ''
	if (/呆账|核销|次级|可疑|损失/.test(s)) return 'M3+'
	const d = Number(days) || 0
	if (d > 60) return 'M3+'
	if (d > 30) return 'M2'
	if (d > 0)  return 'M1'
	// 有「逾期」字样但无天数：按最低逾期档 M1 兜底，避免出现「isOverdue=true 却 level=none」的不一致
	if (statusIndicatesOverdue(s)) return 'M1'
	return 'none'
}

// ─────────────────────────────────────────────
// 从账户列表中汇总逾期记录
// ─────────────────────────────────────────────
const buildOverdueRecords = (accounts) => {
	return accounts
		.filter(acc => acc.isOverdue)
		.map(acc => ({
			bank:          acc.bank,
			accountType:   acc.accountType,
			amount:        acc.overdueAmount || acc.balance || 0,
			days:          acc.overdueDays || 0,
			level:         acc.overdueLevel,
			date:          acc.overdueDate || '',
			repayMatrix:   acc.repayMatrix
		}))
}

// ─────────────────────────────────────────────
// 连三累六检测
// 检测规则：
//   · 连三：同一账户连续逾期 3 期（月）
//   · 累六：同一账户累计逾期 6 期（月）
// 基于 repayMatrix 数组
// ─────────────────────────────────────────────
const detectConsecutiveOverdue = (accounts) => {
	let hasLianSan = false   // 连续逾期3期
	let hasLeiLiu  = false   // 累计逾期6期
	const details  = []

	for (const acc of accounts) {
		const matrix = acc.repayMatrix || []
		if (matrix.length === 0) {
			// 无矩阵时，以逾期天数粗略推算（>60天≈连续2+月）
			if (acc.overdueDays >= 90)  hasLianSan = true
			if (acc.overdueDays >= 180) hasLeiLiu  = true
			continue
		}

		// 累计逾期期数
		const overdueMonths = matrix.filter(isOverdueMatrixCode).length
		if (overdueMonths >= 6) {
			hasLeiLiu = true
			details.push({ bank: acc.bank, type: '累六', overdueMonths })
		}

		// 连续逾期期数（最大连续段）
		let maxConsec = 0, cur = 0
		for (const s of matrix) {
			if (isOverdueMatrixCode(s)) {
				cur++
				maxConsec = Math.max(maxConsec, cur)
			} else {
				cur = 0
			}
		}
		if (maxConsec >= 3) {
			hasLianSan = true
			details.push({ bank: acc.bank, type: '连三', maxConsecutive: maxConsec })
		}
	}

	return {
		hasLianSan,   // 触发连三
		hasLeiLiu,    // 触发累六
		triggered: hasLianSan || hasLeiLiu,
		details
	}
}

// ─────────────────────────────────────────────
// 全文扫描查询明细行（用于 1/2/3/6/12/18 月窗口 + 银行/非银统计）
// ─────────────────────────────────────────────
const QUERY_REASON_RE = /(贷款审批|信用卡审批|贷记卡审批|担保资格审查|担保审查|保前审查|贷后管理|本人查询|异议查询)$/

const normalizeQueryLine = (line) => String(line || '').replace(/\s+/g, '').trim()

const isQueryNoiseLine = (line) => {
	const s = normalizeQueryLine(line)
	return !s || /^第\d+页/.test(s) || /^\d+页$/.test(s) || /^编号查询日期查询机构查询原因$/.test(s) || /^查询记录$/.test(s) || /^机构查询记录明细$/.test(s)
}

const buildQueryItemFromParts = (date, parts) => {
	const body = parts.map(normalizeQueryLine).filter(Boolean).join('')
	const m = body.match(QUERY_REASON_RE)
	if (!m) return null
	const reason = m[1]
	const institution = body.slice(0, -reason.length).trim()
	if (!institution) return null
	return { date: normalizeDate(date), institution, reason }
}

const extractPBOCQueryTableItems = (text) => {
	const lines = String(text || '').split(/\r?\n/)
	const items = []
	let current = null
	const flush = () => {
		if (!current) return
		const item = buildQueryItemFromParts(current.date, current.parts)
		if (item) items.push(item)
		current = null
	}
	for (const rawLine of lines) {
		const line = String(rawLine || '').trim()
		const row = line.match(/^\s*\d+\s+(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)\s+(.+)$/)
		if (row) {
			flush()
			current = { date: row[1], parts: [row[2]] }
			continue
		}
		if (!current || isQueryNoiseLine(line)) continue
		if (/^说明$/.test(normalizeQueryLine(line))) {
			flush()
			break
		}
		current.parts.push(line)
	}
	flush()
	return items
}

const dedupeQueryItems = (items) => {
	const seen = new Set()
	return items.filter((i) => {
		const k = `${i.date}|${i.institution}|${i.reason}`
		if (seen.has(k)) return false
		seen.add(k)
		return true
	})
}

const extractAllQueryItemsFromText = (text) => {
	const tableItems = extractPBOCQueryTableItems(text)
	if (tableItems.length) return dedupeQueryItems(tableItems)
	const lineRe = /(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)\s+(\S+)\s+(\S+)/g
	const items = []
	let m
	while ((m = lineRe.exec(text)) !== null) {
		items.push({ date: normalizeDate(m[1]), institution: m[2], reason: m[3] })
	}
	return dedupeQueryItems(items)
}
// ─────────────────────────────────────────────
// 提取查询记录
// 兼容两种格式：
//   A. "最近 X 个月查询记录：N 次"（直接给数字）
//   B. "最近 X 个月查询记录：\n日期 机构 原因\n..."（枚举条目）
// ─────────────────────────────────────────────
const extractQueryRecords = (text) => {
	const records = {
		recent1Month:  0,
		recent3Month:  0,
		recent6Month:  0,
		recent12Month: 0,
		details:       [],
		queryItems:    []
	}

	// 格式 A：直接数字
	const a1  = text.match(/最近\s*1\s*个月查询记录[：:]\s*(\d+)\s*次/)
	const a3  = text.match(/最近\s*3\s*个月查询记录[：:]\s*(\d+)\s*次/)
	const a6  = text.match(/最近\s*6\s*个月查询记录[：:]\s*(\d+)\s*次/)
	const a12 = text.match(/最近\s*12\s*个月查询记录[：:]\s*(\d+)\s*次/)

	// 格式 B：按条目计数
	// 提取每个时间段的条目列表
	const countItemsInSection = (sectionText) => {
		// 每条记录格式：日期 机构 查询原因
		const lineRe = /(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)\s+(\S+)\s+(\S+)/g
		const items = []
		let m
		while ((m = lineRe.exec(sectionText)) !== null) {
			items.push({ date: normalizeDate(m[1]), institution: m[2], reason: m[3] })
		}
		return items
	}

	// 切割文本，提取各段
	const sect1Match  = text.match(/最近\s*1\s*个月查询记录[：:][^\n]*\n([\s\S]*?)(?=最近\s*\d+\s*个月查询|$)/)
	const sect3Match  = text.match(/最近\s*3\s*个月查询记录[：:][^\n]*\n([\s\S]*?)(?=最近\s*\d+\s*个月查询|$)/)

	const items1 = sect1Match  ? countItemsInSection(sect1Match[1])  : []
	const items3 = sect3Match  ? countItemsInSection(sect3Match[1])  : []

	records.recent1Month  = a1  ? parseInt(a1[1])  : items1.length
	records.recent3Month  = a3  ? parseInt(a3[1])  : items3.length
	records.recent6Month  = a6  ? parseInt(a6[1])  : (records.recent3Month > 0 ? records.recent3Month : 0)
	records.recent12Month = a12 ? parseInt(a12[1]) : 0

	// 合并所有条目（去重）
	const allItems = [...items1, ...items3.filter(i => !items1.some(j => j.date === i.date && j.institution === i.institution))]
	records.details = allItems

	// 补全：6月/12月至少不小于3月数
	if (records.recent6Month  < records.recent3Month)  records.recent6Month  = records.recent3Month
	if (records.recent12Month < records.recent6Month)  records.recent12Month = records.recent6Month

	const fromFull = extractAllQueryItemsFromText(text)
	records.queryItems = fromFull.length > 0 ? fromFull : records.details

	return records
}

// ─────────────────────────────────────────────
// 提取公共记录（法院判决、行政处罚、欠税等）
// ─────────────────────────────────────────────
const extractPublicRecords = (text) => {
	const records = {
		hasRecord: false,
		items: []
	}

	// 判断是否有公共记录
	if (/暂无公共信息记录|无公共记录/.test(text)) {
		return records
	}

	// 尝试提取具体条目（人行报告五部分格式）
	const sectionMatch = text.match(/[三四五六]、\s*公共信息[^\n]*\n([\s\S]*?)(?=[二三四五六]、|$)/)
	if (sectionMatch) {
		const sectionText = sectionMatch[1]
		if (sectionText.trim() && !/暂无/.test(sectionText)) {
			records.hasRecord = true
			// 粗提取：每行一条记录
			sectionText.split('\n').filter(l => l.trim().length > 5).forEach(line => {
				records.items.push({ desc: line.trim() })
			})
		}
	}

	return records
}

// ─────────────────────────────────────────────
// 工具：日期字符串规范化 "2025 年 03 月 20 日" → "2025-03-20"
// ─────────────────────────────────────────────
const normalizeDate = (raw) => {
	if (!raw) return ''
	const clean = String(raw).replace(/\s/g, '')
	const m = clean.match(/(\d{4})年(\d{1,2})月(\d{1,2})日?/)
	if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`
	const ym = clean.match(/(\d{4})年(\d{1,2})月/)
	if (ym) return `${ym[1]}-${ym[2].padStart(2,'0')}`
	// 已经是 2025-03-20 / 2025-03 格式
	if (/^\d{4}-\d{2}(?:-\d{2})?$/.test(clean)) return clean
	return raw
}

// ─────────────────────────────────────────────
// 返回空结构（解析失败时用）
// ─────────────────────────────────────────────
const buildEmptyResult = () => ({
	basicInfo:         {},
	creditAccounts:    [],
	overdueRecords:    [],
	queryRecords:      { recent1Month:0, recent3Month:0, recent6Month:0, recent12Month:0, details:[], queryItems:[] },
	publicRecords:     { hasRecord: false, items: [] },
	creditSummary:     emptyCreditSummary(),
	parseMeta:         { sourceType: 'empty', pageCountHint: 0, rawLength: 0, normalizedLength: 0 },
	consecutiveOverdue:{ hasLianSan:false, hasLeiLiu:false, triggered:false, details:[] },
	rawText:           ''
})

export default {
	parsePDF,
	parseImage,
	extractCreditInfoFromText,
	assertLocalPdfMagicBytes,
	PDF_TEXT_EXTRACT_UNAVAILABLE
}
