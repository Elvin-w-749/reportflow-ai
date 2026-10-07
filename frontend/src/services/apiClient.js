import PROXY_BASE, { getProxyBaseMisconfigReason, DEV_ANALYZE_BEARER_TOKEN, buildProxyApiUrl } from '@/config/proxy.js'
import { reportError } from './errorReporter.js'
import { resolveAuthToken } from './authService.js'
import {
  captureLocalSessionState,
  clearLocalSessionState,
  isLocalSessionStateCurrent
} from './sensitiveLocalState.js'

const DEFAULT_TIMEOUT = 65000
/**
 * 信用 PDF 上传至 /api/analyze 的客户端超时——按"允许超长等待，直到完整分析"策略。
 *
 * ⚠️ 部署同步要求（必须）：
 *   线上接口代理层是 Node/Express 服务，需配套 REQUEST_TIMEOUT_MS=900000，
 *   同时把 Nginx proxy_read_timeout / proxy_send_timeout 调到不低于 900s。
 *   PM2 重启示例（部署目录按实际填写）：
 *     cd <api-proxy 部署目录>
 *     REQUEST_TIMEOUT_MS=900000 pm2 restart ecosystem.config.js --env production
 *
 * ⚠️ 浏览器上传超时由 XHR 兼容层控制，此处设置 900000ms（15 分钟）作为客户端上限。
 */
export const ANALYZE_UPLOAD_TIMEOUT = 900000
const LARGE_UPLOAD_HINT_BYTES = 8 * 1024 * 1024

const directProxyApiUrl = (path = '') => {
  const base = String(PROXY_BASE || '').replace(/\/+$/, '')
  let p = String(path || '').trim()
  if (!p.startsWith('/')) p = `/${p}`
  if (!/^\/api(\/|$)/i.test(p)) p = `/api${p}`
  return base ? base + p : p
}

const uniqueUrls = (urls) => {
  const seen = new Set()
  return urls.filter((url) => {
    const key = String(url || '').trim()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const analyzeUploadUrls = () =>
  uniqueUrls([
    buildProxyApiUrl('/api/analyze'),
    directProxyApiUrl('/api/analyze')
  ])

const analyzeImagesUploadUrls = () =>
  uniqueUrls([
    buildProxyApiUrl('/api/analyze-images'),
    directProxyApiUrl('/api/analyze-images')
  ])

const knownFileSize = (value) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

const formatMb = (bytes) => `${(Number(bytes || 0) / 1024 / 1024).toFixed(1)}MB`

const safeAnalysisMetaString = (value, pattern, maxLength = 256) => {
  const text = typeof value === 'string' ? value.trim() : ''
  return text && text.length <= maxLength && pattern.test(text) ? text : ''
}

/**
 * `/api/analyze` 顶层 analysis 含缓存命中等传输态信息，不能直接并入服务端
 * canonical 结果。这里只透传 UI/审计需要的非敏感字段，避免将未来新增字段、
 * 内部诊断或原始内容意外保存到本机报告。
 */
const sanitizeAnalysisExecution = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const out = {}
  if (typeof value.cacheHit === 'boolean') out.cacheHit = value.cacheHit
  const cacheSource = safeAnalysisMetaString(value.cacheSource, /^[a-z0-9_-]+$/i, 64)
  const analysisKey = safeAnalysisMetaString(value.analysisKey, /^[a-z0-9_-]+$/i)
  const resultHash = safeAnalysisMetaString(value.resultHash, /^[a-z0-9_-]+$/i)
  if (cacheSource) out.cacheSource = cacheSource
  if (analysisKey) out.analysisKey = analysisKey
  if (resultHash) out.resultHash = resultHash
  return Object.keys(out).length ? out : null
}

const attachAnalysisExecution = (inner, payload) => {
  const analysisExecution = sanitizeAnalysisExecution(payload && payload.analysis)
  if (!analysisExecution || !inner || typeof inner !== 'object' || Array.isArray(inner)) return inner
  return { ...inner, analysisExecution }
}

const stableAnalyzeErrorCode = (payload) => {
  const raw = String(payload && (payload.errCode || payload.errorCode) || '').trim().toUpperCase()
  return /^[A-Z][A-Z0-9_]{1,63}$/.test(raw) ? raw : ''
}

const effectiveAnalyzeStatus = (httpStatus, businessCode) => {
  const status = Number(httpStatus)
  const code = Number(businessCode)
  if (Number.isFinite(status) && status >= 400) return status
  if (Number.isFinite(code) && code >= 400 && code <= 599) return code
  return Number.isFinite(status) ? status : 0
}

const markHttpTransport = (error, status) => {
  if (!error || typeof error !== 'object') return error
  const rawStatus = Number(status)
  error.httpStatus = Number.isFinite(rawStatus) ? rawStatus : 0
  error.transportKind = 'http'
  return error
}

const requestTransportError = (cause) => {
  const raw = String(cause && (cause.errMsg || cause.message) || cause || '')
  const sourceCode = String(cause && cause.code || '').trim().toUpperCase()
  const sourceName = String(cause && cause.name || '').trim()
  let error
  if (sourceCode === 'REQUEST_TIMEOUT' || /timeout|timed\s*out|timedout|超时/i.test(raw)) {
    error = new Error('请求超时，请稍后重试')
    error.code = 'REQUEST_TIMEOUT'
    error.transportKind = 'timeout'
    error.timedOut = true
  } else if (
    sourceCode === 'REQUEST_ABORTED' ||
    cause?.aborted === true ||
    sourceName === 'AbortError' ||
    /\b(?:abort(?:ed)?|cancel(?:led)?)\b/i.test(raw)
  ) {
    error = new Error('请求已取消或连接已中断')
    error.code = 'REQUEST_ABORTED'
    error.transportKind = 'abort'
    error.aborted = true
  } else {
    error = new Error('网络请求失败，请检查连接后重试')
    error.code = 'REQUEST_NETWORK_ERROR'
    error.transportKind = 'network'
    error.networkFailure = true
  }
  if (sourceName) error.transportErrorName = sourceName.slice(0, 80)
  return error
}

// 文件过大只能由真实 HTTP 413 证明。文件大小、网关文案、业务 code=413
// 都不能证明请求曾被传输层以 413 拒绝，否则普通断网会被误报成上传上限。
const isUploadLimitOrGatewayError = (err) =>
  !!err && err.transportKind === 'http' && Number(err.httpStatus) === 413

const isPreviewUploadRetryable = (err) => {
  const m = String(err && (err.message || err.errMsg) ? (err.message || err.errMsg) : '')
  const code = Number(err && (err.statusCode ?? err.status ?? err.code))
  if (isUploadLimitOrGatewayError(err)) return true
  if (code === 502 || code === 503 || code === 504) return true
  return /uploadFile:fail|request:fail|网络|连接|abort|ECONN|timeout|CORS|跨域/i.test(m)
}

const isAnalyzeRequestTimeout = (err) => {
  const m = String(err && (err.message || err.errMsg) ? (err.message || err.errMsg) : '')
  const code = Number(err && (err.statusCode ?? err.status ?? err.code))
  const rawCode = String(err && err.code ? err.code : '')
  return !!(err && err.analyzeRequestTimedOut) ||
    [408, 504, 524, 598, 599].includes(code) ||
    /timeout|timed\s*out|timedout|超时/i.test(`${rawCode} ${m}`)
}

/**
 * 同步分析超时不能证明服务端已停止处理。此时切换备用 URL 会再次 POST 同一 PDF，
 * 可能造成同一报告并行分析；只保留非超时的本地预览连通性回退。
 */
const canTryAlternateAnalyzeUrl = (err) =>
  isPreviewUploadRetryable(err) && !isAnalyzeRequestTimeout(err)

/**
 * AI 分析端点 Bearer：
 * - 已登录优先使用登录态 JWT（默认路径）
 * - 未登录仅在本地显式配置 DEV_ANALYZE_BEARER_TOKEN 时才回退静态 Token（默认关闭）
 */
const resolveAnalyzeBearer = () => {
	let token = resolveAuthToken()
	if (!token) token = String(DEV_ANALYZE_BEARER_TOKEN || '').trim()
	return token
}

const responseBodyLooksLikeHtml = (raw) =>
	typeof raw === 'string' && /^\s*(?:<!doctype|<html|<head|<body|<\?xml)/i.test(raw)

/** 线上旧版 ai-proxy 未注册 POST /api/analyze 时 Express 返回 Cannot POST /api/analyze + 404 HTML */
const isAnalyzeRouteMissing = (status, rawStr) => {
	if (status === 404) return true
	return !!(rawStr && /Cannot POST \/api\/analyze/i.test(rawStr))
}

const normalizeResponse = (payload, statusCode) => {
  // 网关返回 HTML 错误页（Nginx/CDN/登录跳转）：直接转成可读错误，避免吞为“服务响应格式异常”
  if (typeof payload === 'string' && /^\s*(?:<!doctype|<html|<head|<body|<\?xml)/i.test(payload)) {
    return {
      code: -1,
      message: `服务异常（HTTP ${statusCode || '?'}，网关返回了 HTML 页面），请稍后重试`,
      data: null
    }
  }
  if (payload && typeof payload === 'object') {
    if (typeof payload.code === 'number') {
      return payload
    }
    if (typeof payload.errCode === 'number') {
      return {
        code: payload.errCode,
        message: payload.errMsg || '',
        data: payload.data ?? payload
      }
    }
    if (statusCode >= 200 && statusCode < 300) {
      return { code: 0, data: payload, message: '' }
    }
  }
  return {
    code: statusCode >= 200 && statusCode < 300 ? 0 : -1,
    message: '服务响应格式异常',
    data: payload
  }
}

/**
 * 本地上传文件到自建网关（需登录，与 /api/profile/feedback 等共用）
 * @param {{ filePath: string, file?: Blob, folder?: string }} opts
 * @returns {Promise<string>} 可访问的 URL
 */
/**
 * 上传信用文件到服务端实时分析（multipart，字段名 file）
 * @param {string} filePath 本地临时文件路径
 * @param {{ timeout?: number }} [opts]
 * @returns {Promise<any>} 业务层 data（HTTP 成功且 code===0 时）
 */

export const uploadCreditAnalyze = (filePath, opts = {}) => {
  const cfgErr = getProxyBaseMisconfigReason()
  if (cfgErr) return Promise.reject(new Error(cfgErr))
  let uploadSession = captureLocalSessionState()
  let bearer = resolveAnalyzeBearer()
  if (!bearer) {
    return Promise.reject(new Error('缺少分析凭证：请先登录后再上传信用报告'))
  }
  const timeout = typeof opts.timeout === 'number' && opts.timeout > 0 ? opts.timeout : ANALYZE_UPLOAD_TIMEOUT
  const onAttempt = typeof opts.onAttempt === 'function' ? opts.onAttempt : null
  const fileSize = knownFileSize(opts.fileSize) || knownFileSize(filePath && filePath.size)
  const isLargeUpload = !!fileSize && fileSize >= LARGE_UPLOAD_HINT_BYTES
  const sendOnce = (url) => new Promise((resolve, reject) => {
    const isBlobFile = filePath && typeof Blob !== 'undefined' && filePath instanceof Blob
    const uploadArgs = {
      url,
      name: 'file',
      header: { Authorization: `Bearer ${bearer}` },
      timeout,
      success: (res) => {
        try {
          const raw = res.data
          const status = typeof res.statusCode === 'number' ? res.statusCode : 0
          const rawStr = typeof raw === 'string' ? raw : ''
          const looksLikeHtml = responseBodyLooksLikeHtml(rawStr)
          // 1) /api/analyze 未部署（旧版 ai-proxy）→ 标记缺失，由上层抛「分析服务未部署」明确错误
          //    （注：历史上的 analyze-text 抽字回退链路已下线，pdfParser.parsePDFWithCloudFallback 现无调用方）
          if (looksLikeHtml && isAnalyzeRouteMissing(status, rawStr)) {
            const e = new Error('__ANALYZE_ROUTE_MISSING__')
            e.analyzeRouteMissing = true
            e.statusCode = status
            markHttpTransport(e, status)
            reject(e)
            return
          }
          // 2) 其它 HTML 网关错误页
          if (looksLikeHtml) {
            const is413 = status === 413
            const e = new Error(is413
              ? 'PDF 上传被网关拦截（HTTP 413）：当前入口上传上限过小。请把 Nginx client_max_body_size 调到 60m 以上，并确认 PDF_UPLOAD_MAX_MB 不低于 50。'
              : `分析服务异常（HTTP ${status || '?'}，网关返回了 HTML 页面），请稍后重试或改用图片上传`)
            e.statusCode = status
            e.code = is413 ? 413 : -1
            markHttpTransport(e, status)
            reject(e)
            return
          }
          // 2) 优先尝试解析 JSON 响应（即使是 4xx/5xx；后端业务错误可能带 raw、msg、detail 等关键诊断字段）
          let payload = null
          let parseErr = null
          if (rawStr) {
            try { payload = JSON.parse(rawStr) } catch (pe) { parseErr = pe }
          } else if (raw && typeof raw === 'object') {
            payload = raw
          }
          // 3) JSON 解析失败 + HTTP 错误：当作网关非预期响应
          if (!payload && (status < 200 || status >= 300)) {
            const e = new Error(status === 413
              ? 'PDF 上传被网关拦截（HTTP 413）：当前入口上传上限过小。请把 Nginx client_max_body_size 调到 60m 以上，并确认 PDF_UPLOAD_MAX_MB 不低于 50。'
              : `分析服务异常（HTTP ${status || '?'}），请稍后重试`)
            e.statusCode = status
            e.code = status === 413 ? 413 : -1
            markHttpTransport(e, status)
            reject(e)
            return
          }
          // 4) JSON 解析失败 + 2xx：极少见的"非 JSON 200"，按非法响应处理
          if (!payload) {
            const e = new Error('分析服务异常（响应不是合法 JSON），请稍后重试')
            e.statusCode = status
            e.code = -1
            markHttpTransport(e, status)
            if (parseErr && parseErr.message) e.parseErr = parseErr.message
            reject(e)
            return
          }
          // 4.5) 鉴权失败（401 / msg=unauthorized）：给出可操作文案，区别于普通业务失败。
          //      常见于 DEV_ANALYZE_BEARER 轮换时「前端已换、服务端 .env 未同步」或登录态 JWT 失效。
          const msgRaw = String(payload.msg || payload.message || payload.errMsg || payload.error || '')
          if (status === 401 || payload.code === 401 || /unauthorized/i.test(msgRaw)) {
            const e = new Error('分析服务鉴权失败（401 unauthorized）：请先确认当前账号已登录且登录态有效；若仍失败，请运维检查 ai-proxy/.env 的 DEV_ANALYZE_BEARER/JWT_SECRET 配置并确认服务已 reload。')
            e.statusCode = 401
            e.code = 401
            markHttpTransport(e, status)
            reject(e)
            return
          }
          // 5) 解析出 JSON：按 code/success 判定成功；失败时把 msg / raw / detail 全部带出
          const okByCode = typeof payload.code === 'number' && payload.code === 0
          const okBySuccess = payload && payload.success === true
          const code = typeof payload.code === 'number' ? payload.code : (okBySuccess ? 0 : -1)
          const baseMsg = payload.msg || payload.message || payload.errMsg || '分析失败'
          const msg = status === 413
            ? `${baseMsg}。如果文件小于 50MB 仍失败，请检查 Nginx client_max_body_size、CDN/代理上传上限和 PDF_UPLOAD_MAX_MB。`
            : baseMsg
          if (okByCode || okBySuccess || code === 0) {
            let inner = payload.data
            if (typeof inner === 'string') {
              try { inner = JSON.parse(inner) } catch { inner = { rawText: inner } }
            }
            inner = attachAnalysisExecution(inner, payload)
            ensureSessionResponseIsCurrent(uploadSession, uploadSession.token)
            resolve(inner)
            return
          }
          const e = new Error(msg)
          const backendCode = stableAnalyzeErrorCode(payload)
          e.statusCode = effectiveAnalyzeStatus(status, code)
          e.code = backendCode || code
          e.backendCode = backendCode
          markHttpTransport(e, status)
          // ↓ Python 后端 `/api/analyze` 失败时常带 raw（DeepSeek 真实返回前 300 字），用于精确定位
          //    AI 是"返回空 / markdown / 拒答 / token 截断 / 限流"哪一种问题
          e.data = {
            raw: typeof payload.raw === 'string' ? payload.raw : '',
            detail: payload.detail || payload.error || null,
            payload
          }
          reject(e)
        } catch (e) {
          const m = e && e.message ? String(e.message) : ''
          if (/Unexpected token|JSON/i.test(m)) {
            const wrapped = new Error('分析服务异常（响应不是合法 JSON），请稍后重试或改用图片上传')
            wrapped.statusCode = res && res.statusCode
            wrapped.code = -1
            markHttpTransport(wrapped, res && res.statusCode)
            reject(wrapped)
            return
          }
          reject(e)
        }
      },
      fail: (err) => {
        const raw = err && (err.errMsg || err.message) ? String(err.errMsg || err.message) : String(err || '')
        const uploadCode = String(err && err.code || '').toUpperCase()
        if (uploadCode === 'UPLOAD_TIMEOUT' || /timeout|timed\s*out|timedout|超时/i.test(raw)) {
          const base = String(PROXY_BASE || '')
          const loopback =
            /localhost|127\.0\.0\.1/i.test(base) ? '（当前 PROXY_BASE 指向本机，真机/模拟器无法访问，请改为局域网 IP 或已配置HTTPS）' : ''
          const ops =
            loopback
              ? ''
              : '；若网络正常仍反复超时，请让运维检查 ai-proxy 的 REQUEST_TIMEOUT_MS 与 Nginx proxy_read_timeout 是否≥900s'
          const timeoutError = new Error('上传分析超时，请检查网络与微信 request 合法域名' + loopback + ops)
          timeoutError.analyzeRequestTimedOut = true
          timeoutError.code = 'UPLOAD_TIMEOUT'
          reject(timeoutError)
          return
        }
        if (uploadCode === 'UPLOAD_ABORTED' || err?.aborted === true || /\babort(?:ed)?\b/i.test(raw)) {
          const abortedError = new Error('上传已取消，服务端未返回分析结果')
          abortedError.code = 'UPLOAD_ABORTED'
          abortedError.aborted = true
          reject(abortedError)
          return
        }
        if (isLargeUpload && /uploadFile:fail|request:fail|网络|连接|ECONN/i.test(raw)) {
          const networkError = new Error(`PDF 文件约 ${formatMb(fileSize)}，上传连接中断，请检查手机网络后重新上传。`)
          networkError.code = 'UPLOAD_NETWORK_ERROR'
          reject(networkError)
          return
        }
        if (err instanceof Error) {
          reject(err)
          return
        }
        const networkError = new Error(raw || '上传连接失败')
        networkError.code = uploadCode || 'UPLOAD_NETWORK_ERROR'
        reject(networkError)
      }
    }
    if (isBlobFile) uploadArgs.file = filePath
    else uploadArgs.filePath = filePath
    uni.uploadFile(uploadArgs)
  })

  const isTransient = (err) => {
    const m = String(err && err.message ? err.message : '')
    if (err && (err.statusCode === 502 || err.statusCode === 503 || err.statusCode === 504)) return true
    return /分析服务异常|服务异常|服务繁忙|temporar|busy/i.test(m)
  }
  /**
   * 默认 1 次：服务端或上游网关超时通常是结构性失败，重试只会让用户多等几十秒。
   * 调用方可显式传 maxAttempts 强制重试。
   */
  const maxAttempts = typeof opts.maxAttempts === 'number' && opts.maxAttempts > 0 ? opts.maxAttempts : 1
  return (async () => {
    let lastErr
    let firstGatewayErr = null
    let triedRefresh = false
    const uploadUrls = analyzeUploadUrls()
    for (let i = 0; i < maxAttempts; i++) {
      if (onAttempt) {
        try { onAttempt(i + 1, maxAttempts) } catch {}
      }
      for (let u = 0; u < uploadUrls.length; u++) {
        try {
          return await sendOnce(uploadUrls[u])
        } catch (e) {
          if (e && e.analyzeRouteMissing) {
            const err = new Error('分析服务未部署（缺少 /api/analyze）。请先完成服务端发布后再进行信用实时分析')
            err.statusCode = e.statusCode || 404
            err.code = 404
            throw err
          }
          // 登录态 JWT 过期（401）：长连接分析期间 token 可能到期。单飞刷新一次后用新 token 重发一次；
          // 刷新失败或重发仍 401 才抛出，避免「上传几分钟后白等一次 401」。
          const is401 = !!e && (e.statusCode === 401 || e.code === 401)
          if (is401) {
            if (!triedRefresh) {
              triedRefresh = true
              const refreshResult = await _refreshAuthToken(uploadSession).catch(() => ({
                status: 'failed',
                sessionSnapshot: uploadSession
              }))
              if (refreshMatchesSession(refreshResult, uploadSession)) {
                bearer = String(refreshResult.token || resolveAnalyzeBearer() || '').trim()
                uploadSession = captureLocalSessionState()
                if (bearer) {
                  try {
                    return await sendOnce(uploadUrls[u])
                  } catch (retryError) {
                    if (retryError && (retryError.statusCode === 401 || retryError.code === 401)) {
                      throw buildAuthExpiredError({}, 401, uploadSession)
                    }
                    throw retryError
                  }
                }
              }
            }
            throw buildAuthExpiredError({}, 401, uploadSession)
          }
          lastErr = e
          if (!firstGatewayErr && isUploadLimitOrGatewayError(e)) firstGatewayErr = e
          if (u < uploadUrls.length - 1 && canTryAlternateAnalyzeUrl(e)) {
            continue
          }
          if (i < maxAttempts - 1 && isTransient(e) && !isAnalyzeRequestTimeout(e)) {
            await new Promise((r) => setTimeout(r, 1500 * (i + 1)))
            break
          }
          throw e
        }
      }
      if (i < maxAttempts - 1 && isTransient(lastErr) && !isAnalyzeRequestTimeout(lastErr)) {
        continue
      }
      if (lastErr) {
        if (firstGatewayErr && isPreviewUploadRetryable(lastErr)) {
          throw firstGatewayErr
        }
        throw lastErr
      }
    }
    if (firstGatewayErr && isPreviewUploadRetryable(lastErr)) {
      throw firstGatewayErr
    }
    throw lastErr || new Error('分析失败')
  })()
}

const parseAnalyzeUploadResponse = (payload, statusCode, rawText = '') => {
  const status = typeof statusCode === 'number' ? statusCode : 0
  const rawStr = typeof rawText === 'string' ? rawText : ''
  if (responseBodyLooksLikeHtml(rawStr)) {
    const e = new Error(`分析服务异常（HTTP ${status || '?'}，网关返回了 HTML 页面），请稍后重试`)
    e.statusCode = status
    markHttpTransport(e, status)
    e.code = status
    throw e
  }
  let data = payload
  if (!data && rawStr) {
    try { data = JSON.parse(rawStr) } catch {
      const e = new Error('分析服务异常（响应不是合法 JSON），请稍后重试')
      e.statusCode = status
      markHttpTransport(e, status)
      e.code = -1
      throw e
    }
  }
  const msgRaw = String(data && (data.msg || data.message || data.errMsg || data.error) || '')
  if (status === 401 || (data && data.code === 401) || /unauthorized/i.test(msgRaw)) {
    const e = new Error('当前登录状态已过期，请重新登录后再上传信用报告。')
    e.statusCode = 401
    e.code = 401
    markHttpTransport(e, status)
    throw e
  }
  const okByCode = data && typeof data.code === 'number' && data.code === 0
  const okBySuccess = data && data.success === true
  if (status >= 200 && status < 300 && (okByCode || okBySuccess)) {
    let inner = data.data
    if (typeof inner === 'string') {
      try { inner = JSON.parse(inner) } catch { inner = { rawText: inner } }
    }
    return attachAnalysisExecution(inner, data)
  }
  const e = new Error(msgRaw || `分析失败（HTTP ${status || '?'}）`)
  const businessCode = data && typeof data.code === 'number' ? data.code : status || -1
  const backendCode = stableAnalyzeErrorCode(data)
  e.statusCode = effectiveAnalyzeStatus(status, businessCode)
  e.code = backendCode || businessCode
  e.backendCode = backendCode
  markHttpTransport(e, status)
  e.data = { payload: data || null }
  throw e
}

export const uploadCreditAnalyzeImages = (files = [], opts = {}) => {
  const cfgErr = getProxyBaseMisconfigReason()
  if (cfgErr) return Promise.reject(new Error(cfgErr))
  let uploadSession = captureLocalSessionState()
  let bearer = resolveAnalyzeBearer()
  if (!bearer) {
    return Promise.reject(new Error('缺少分析凭证：请先登录后再上传信用报告截图'))
  }
  const normalized = (Array.isArray(files) ? files : [files])
    .map((item, index) => {
      if (!item) return null
      if (typeof item === 'string') return { path: item, name: `report-${index + 1}.jpg` }
      return {
        path: item.path || item.filePath || item.uri || '',
        file: item.file || (typeof Blob !== 'undefined' && item instanceof Blob ? item : null),
        name: item.name || `report-${index + 1}.jpg`,
        size: item.size
      }
    })
    .filter((item) => item && (item.path || item.file))
  if (!normalized.length) return Promise.reject(new Error('未选择信用报告截图'))

  const timeout = typeof opts.timeout === 'number' && opts.timeout > 0 ? opts.timeout : ANALYZE_UPLOAD_TIMEOUT
  const onAttempt = typeof opts.onAttempt === 'function' ? opts.onAttempt : null
  const maxAttempts = typeof opts.maxAttempts === 'number' && opts.maxAttempts > 0 ? opts.maxAttempts : 1

  const sendFetchFormData = async (url) => {
    const form = new FormData()
    normalized.forEach((item, index) => {
      form.append(`file${index}`, item.file, item.name || `report-${index + 1}.jpg`)
    })
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}` },
      body: form
    })
    const raw = await res.text()
    let payload = null
    if (raw) {
      try { payload = JSON.parse(raw) } catch {}
    }
    const parsed = parseAnalyzeUploadResponse(payload, res.status, raw)
    ensureSessionResponseIsCurrent(uploadSession, uploadSession.token)
    return parsed
  }

  const sendUniUpload = (url) => new Promise((resolve, reject) => {
    const uploadArgs = {
      url,
      header: { Authorization: `Bearer ${bearer}` },
      timeout,
      success: (res) => {
        try {
          const raw = typeof res.data === 'string' ? res.data : ''
          const payload = raw ? JSON.parse(raw) : (res.data && typeof res.data === 'object' ? res.data : null)
          const parsed = parseAnalyzeUploadResponse(payload, res.statusCode, raw)
          ensureSessionResponseIsCurrent(uploadSession, uploadSession.token)
          resolve(parsed)
        } catch (e) {
          reject(e)
        }
      },
      fail: (err) => reject(err instanceof Error ? err : new Error(err && (err.errMsg || err.message) || '图片上传失败'))
    }
    if (normalized.length === 1) {
      const item = normalized[0]
      uploadArgs.name = 'file0'
      if (item.file && typeof Blob !== 'undefined' && item.file instanceof Blob) uploadArgs.file = item.file
      else uploadArgs.filePath = item.path
    } else {
      uploadArgs.files = normalized.map((item, index) => {
        if (item.file && typeof Blob !== 'undefined' && item.file instanceof Blob) {
          return { name: `file${index}`, file: item.file }
        }
        return { name: `file${index}`, uri: item.path }
      })
    }
    uni.uploadFile(uploadArgs)
  })

  const canUseFetchFormData =
    typeof fetch === 'function' &&
    typeof FormData !== 'undefined' &&
    typeof Blob !== 'undefined' &&
    normalized.every((item) => item.file && item.file instanceof Blob)

  return (async () => {
    let lastErr = null
    let triedRefresh = false
    const uploadUrls = analyzeImagesUploadUrls()
    for (let i = 0; i < maxAttempts; i++) {
      if (onAttempt) {
        try { onAttempt(i + 1, maxAttempts) } catch {}
      }
      for (let u = 0; u < uploadUrls.length; u++) {
        try {
          return canUseFetchFormData ? await sendFetchFormData(uploadUrls[u]) : await sendUniUpload(uploadUrls[u])
        } catch (e) {
          const is401 = !!e && (e.statusCode === 401 || e.code === 401)
          if (is401) {
            if (!triedRefresh) {
              triedRefresh = true
              const refreshResult = await _refreshAuthToken(uploadSession).catch(() => ({
                status: 'failed',
                sessionSnapshot: uploadSession
              }))
              if (refreshMatchesSession(refreshResult, uploadSession)) {
                bearer = String(refreshResult.token || resolveAnalyzeBearer() || '').trim()
                uploadSession = captureLocalSessionState()
                if (bearer) {
                  try {
                    return canUseFetchFormData ? await sendFetchFormData(uploadUrls[u]) : await sendUniUpload(uploadUrls[u])
                  } catch (retryError) {
                    if (retryError && (retryError.statusCode === 401 || retryError.code === 401)) {
                      throw buildAuthExpiredError({}, 401, uploadSession)
                    }
                    throw retryError
                  }
                }
              }
            }
            throw buildAuthExpiredError({}, 401, uploadSession)
          }
          lastErr = e
          if (u < uploadUrls.length - 1 && isPreviewUploadRetryable(e)) continue
          throw e
        }
      }
    }
    throw lastErr || new Error('图片分析失败')
  })()
}

export const uploadLocalFile = ({ filePath, file = null, folder = 'upload' }) => {
  const cfgErr = getProxyBaseMisconfigReason()
  if (cfgErr) return Promise.reject(new Error(cfgErr))
  let uploadSession = captureLocalSessionState()
  const uploadPath = file && typeof Blob !== 'undefined' && file instanceof Blob ? file : filePath
  const sendOnce = (token) => new Promise((resolve, reject) => {
    const isBlobFile = uploadPath && typeof Blob !== 'undefined' && uploadPath instanceof Blob
    const uploadArgs = {
      url: buildProxyApiUrl('/api/upload'),
      name: 'file',
      header: token ? { Authorization: `Bearer ${token}` } : {},
      formData: { folder },
      timeout: DEFAULT_TIMEOUT,
      success: (res) => {
        try {
          const raw = res.data
          const status = typeof res.statusCode === 'number' ? res.statusCode : 0
          const rawStr = typeof raw === 'string' ? raw : ''
          const looksLikeHtml = !!rawStr && /^\s*(?:<!doctype|<html|<head|<body|<\?xml)/i.test(rawStr)
          let payload = null
          if (rawStr && !looksLikeHtml) {
            try { payload = JSON.parse(rawStr) } catch {}
          } else if (raw && typeof raw === 'object') {
            payload = raw
          }
          if (status === 401 || (payload && Number(payload.code) === 401)) {
            const e = new Error(AUTH_EXPIRED_MESSAGE)
            e.statusCode = 401
            e.code = 401
            reject(e)
            return
          }
          if (looksLikeHtml || status >= 400) {
            const httpHint = status ? `HTTP ${status}` : '响应异常'
            const e = new Error(`上传服务异常（${httpHint}），请稍后重试`)
            e.statusCode = status
            e.code = status || -1
            reject(e)
            return
          }
          if (!payload) payload = rawStr ? JSON.parse(rawStr) : {}
          if (payload.code === 0 && payload.data && payload.data.url) {
            ensureSessionResponseIsCurrent(uploadSession, token)
            resolve(String(payload.data.url))
            return
          }
          const e = new Error(payload.message || '上传失败')
          e.statusCode = status
          e.code = typeof payload.code === 'number' ? payload.code : -1
          reject(e)
        } catch (e) {
          const m = e && e.message ? String(e.message) : ''
          if (/Unexpected token|JSON/i.test(m)) {
            reject(new Error('上传服务异常（响应不是合法 JSON），请稍后重试'))
            return
          }
          reject(e)
        }
      },
      fail: (err) => reject(err)
    }
    if (isBlobFile) uploadArgs.file = uploadPath
    else uploadArgs.filePath = uploadPath
    uni.uploadFile(uploadArgs)
  })
  return (async () => {
    const initialToken = resolveAuthToken()
    try {
      return await sendOnce(initialToken)
    } catch (error) {
      const is401 = !!error && (error.statusCode === 401 || error.code === 401)
      if (!is401) throw error
      const refreshResult = await _refreshAuthToken(uploadSession).catch(() => ({
        status: 'failed',
        sessionSnapshot: uploadSession
      }))
      if (refreshMatchesSession(refreshResult, uploadSession)) {
        const refreshedToken = String(refreshResult.token || resolveAuthToken() || '').trim()
        uploadSession = captureLocalSessionState()
        if (refreshedToken) {
          try {
            return await sendOnce(refreshedToken)
          } catch (retryError) {
            if (retryError && (retryError.statusCode === 401 || retryError.code === 401)) {
              throw buildAuthExpiredError({}, 401, uploadSession)
            }
            throw retryError
          }
        }
      }
      throw buildAuthExpiredError({}, 401, uploadSession)
    }
  })()
}

/** 不触发自动刷新的端点（登录/注册/刷新本身），避免递归与无意义重试 */
const _NO_REFRESH_RE = /\/api\/user\/(login|register|refresh-token)/
const AUTH_EXPIRED_MESSAGE = '登录状态已失效，请重新登录'

const isAuthExpiredResponse = (statusCode, normalized = {}) => {
  const code = Number(normalized && normalized.code)
  const msg = String(normalized && (normalized.message || normalized.msg || normalized.errMsg || '') || '')
  return statusCode === 401 || code === 401 || /invalid token|unauthorized|stale token|登录.*过期|登录状态.*失效/i.test(msg)
}

const clearStoredAuthCredential = (sessionSnapshot = null) => {
  if (sessionSnapshot && (!sessionSnapshot.token || !isLocalSessionStateCurrent(sessionSnapshot))) return false
  try {
    clearLocalSessionState()
    return true
  } catch (_) {}
  return false
}

const buildAuthExpiredError = (normalized = {}, statusCode = 401, sessionSnapshot = null) => {
  const cleared = clearStoredAuthCredential(sessionSnapshot)
  const e = new Error(AUTH_EXPIRED_MESSAGE)
  e.statusCode = statusCode || 401
  e.code = normalized && typeof normalized.code === 'number' ? normalized.code : 401
  e.data = normalized ? normalized.data : null
  e.staleSession = !!sessionSnapshot && !cleared
  return markHttpTransport(e, statusCode || 401)
}

const sameSessionSnapshot = (left = null, right = null) =>
  !!left &&
  !!right &&
  String(left.token || '') === String(right.token || '') &&
  Number(left.revision) === Number(right.revision)

const buildStaleSessionError = () => {
  const e = new Error('账号已切换，本次旧会话请求结果已忽略')
  e.statusCode = 409
  e.code = 'STALE_SESSION_RESPONSE'
  e.staleSession = true
  return e
}

const ensureSessionResponseIsCurrent = (sessionSnapshot = null, requestToken = '') => {
  if (requestToken && sessionSnapshot && !isLocalSessionStateCurrent(sessionSnapshot)) {
    throw buildStaleSessionError()
  }
}

/**
 * 同一会话单飞刷新：同一 token/会话世代的并发 401 只发一次 refresh-token。
 * 不同账号或不同会话世代绝不复用同一个刷新任务，避免旧账号 A 的刷新结果清理/覆盖新账号 B。
 * 不依赖 authService（其反向依赖本模块），直接打 /api/user/refresh-token。
 * @returns {Promise<{status: 'refreshed'|'failed'|'stale', sessionSnapshot: object, token?: string}>}
 */
const _refreshFlights = new Map()
const refreshFlightKey = (snapshot = {}) => `${Number(snapshot.revision)}:${String(snapshot.token || '')}`
const _refreshAuthToken = (requestedSnapshot = null) => {
  const sessionSnapshot = requestedSnapshot || captureLocalSessionState()
  if (!sessionSnapshot.token) {
    return Promise.resolve({ status: 'failed', sessionSnapshot })
  }
  if (!isLocalSessionStateCurrent(sessionSnapshot)) {
    return Promise.resolve({ status: 'stale', sessionSnapshot })
  }
  const key = refreshFlightKey(sessionSnapshot)
  if (_refreshFlights.has(key)) return _refreshFlights.get(key)
  const token = sessionSnapshot.token
  const refreshPromise = new Promise((resolve) => {
    uni.request({
      url: buildProxyApiUrl('/api/user/refresh-token'),
      method: 'POST',
      timeout: DEFAULT_TIMEOUT,
      header: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      success: (res) => {
        const normalized = normalizeResponse(res.data, res.statusCode)
        const ok = res.statusCode >= 200 && res.statusCode < 300 && normalized.code === 0
        const d = ok && normalized.data ? normalized.data : null
        const newToken = d && (d.token || d.accessToken)
        if (!isLocalSessionStateCurrent(sessionSnapshot)) {
          resolve({ status: 'stale', sessionSnapshot })
          return
        }
        if (newToken) {
          uni.setStorageSync('auth_token', newToken)
          uni.setStorageSync('uni_id_token', newToken)
          if (d.tokenExpired) uni.setStorageSync('uni_id_token_expired', d.tokenExpired)
          resolve({ status: 'refreshed', sessionSnapshot, token: String(newToken) })
        } else {
          resolve({ status: 'failed', sessionSnapshot })
        }
      },
      fail: () => resolve({
        status: isLocalSessionStateCurrent(sessionSnapshot) ? 'failed' : 'stale',
        sessionSnapshot
      })
    })
  }).then(
    (value) => value,
    () => ({
      status: isLocalSessionStateCurrent(sessionSnapshot) ? 'failed' : 'stale',
      sessionSnapshot
    })
  ).finally(() => {
    if (_refreshFlights.get(key) === refreshPromise) _refreshFlights.delete(key)
  })
  _refreshFlights.set(key, refreshPromise)
  return refreshPromise
}

const refreshMatchesSession = (refreshResult, sessionSnapshot) =>
  !!refreshResult &&
  refreshResult.status === 'refreshed' &&
  sameSessionSnapshot(refreshResult.sessionSnapshot, sessionSnapshot)

export const request = ({ url, method = 'GET', data = {}, header = {}, timeout = DEFAULT_TIMEOUT }) => {
  const cfgErr = getProxyBaseMisconfigReason()
  if (cfgErr) return Promise.reject(new Error(cfgErr))
  const canRefresh = !_NO_REFRESH_RE.test(String(url || ''))
  const fire = (allowRefresh) => new Promise((resolve, reject) => {
    const requestSession = captureLocalSessionState()
    const token = resolveAuthToken()
    uni.request({
      url: buildProxyApiUrl(url),
      method,
      data,
      timeout,
      header: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...header
      },
      success: (res) => {
        const normalized = normalizeResponse(res.data, res.statusCode)
        if (res.statusCode >= 200 && res.statusCode < 300 && normalized.code === 0) {
          try {
            ensureSessionResponseIsCurrent(requestSession, token)
            resolve(normalized.data)
          } catch (error) {
            reject(error)
          }
          return
        }
        // 401：尝试刷新一次后重放（仅一次，且非登录/刷新端点）。
        // 刷新严格绑定本请求开始时的会话，旧账号的刷新不得影响新账号。
        if (res.statusCode === 401 && allowRefresh && canRefresh) {
          _refreshAuthToken(requestSession).then((refreshResult) => {
            if (refreshMatchesSession(refreshResult, requestSession)) {
              fire(false).then(resolve, reject)
            } else {
              reject(buildAuthExpiredError(normalized, res.statusCode, requestSession))
            }
          })
          return
        }
        if (isAuthExpiredResponse(res.statusCode, normalized)) {
          reject(buildAuthExpiredError(normalized, res.statusCode, requestSession))
          return
        }
        const e = new Error(normalized.message || '请求失败')
        e.statusCode = res.statusCode
        e.code = normalized.code
        const businessCode = Number(normalized.code)
        if (Number.isFinite(businessCode)) e.businessCode = businessCode
        const backendCode = stableAnalyzeErrorCode(res.data)
        if (backendCode) e.backendCode = backendCode
        e.data = normalized.data
        reject(markHttpTransport(e, res.statusCode))
      },
      fail: (err) => reject(requestTransportError(err))
    })
  })
  return fire(true)
}

export default { request, uploadLocalFile, uploadCreditAnalyze }
