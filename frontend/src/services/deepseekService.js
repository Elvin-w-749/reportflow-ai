import { getProxyBaseMisconfigReason, buildProxyApiUrl, DEV_ANALYZE_BEARER_TOKEN } from '@/config/proxy.js'
import {
  normalizeAIResult,
  buildParsedFromAINormalized,
  aiToInternalDimensions,
  aiToScores
} from './aiSchemaAdapter.js'
import { reportError } from './errorReporter.js'
import { resolveAuthToken } from './authService.js'
import { request } from './apiClient.js'
import { normalizeDecisionReportId } from './decisionTrust.js'

const AI_ANALYSIS_URL = buildProxyApiUrl('/api/ai/analyze')
const TIMEOUT_MS = 65000
const MAX_RETRY = 2

/**
 * 征信文本压缩（与 ai-proxy/server.js compressCreditText 同逻辑，保证前后端分析质量一致）。
 * DeepSeek context window ≥ 32K tokens（≈ 40K~60K 中文字符），默认 maxChars=40000 让多数中长报告整体送入。
 * 仅超出上限时才走「头部 + 关键行 + 尾部」裁切，关键行命中规则与后端完全对齐。
 */
const compressCreditTextForAI = (rawText, maxChars = 40000) => {
  const text = String(rawText || '').replace(/\0/g, '')
  if (text.length <= maxChars) return text
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  // 与后端 server.js compressCreditText 的 keyRe 完全一致
  const keyRe = /(姓名|证件|身份证|报告(编号|时间|日期)|手机|住址|工作|户籍|账户|贷款|信用卡|贷记卡|准贷记卡|余额|已使用|授信|额度|逾期|连三|累六|M[1-7]|当前逾期|查询|机构|分期|担保|被担保|公共记录|强制执行|欠税|民事判决|行政处罚|结清|到期|月还款|月供|负债|审批|发卡|放款|首付|按揭|经营贷|消费贷|车贷|房贷)/i
  const picked = []
  for (const line of lines) {
    if (keyRe.test(line)) picked.push(line)
    if (picked.join('\n').length >= Math.floor(maxChars * 0.7)) break
  }
  const head = text.slice(0, Math.floor(maxChars * 0.2))
  const tail = text.slice(-Math.floor(maxChars * 0.1))
  let merged = `【信用文本-头部】\n${head}\n\n【信用关键片段（命中 ${picked.length} 行）】\n${picked.join('\n')}\n\n【信用文本-尾部】\n${tail}\n\n【注意】原文长度 ${text.length} 字符，已按规则裁切。`
  if (merged.length > maxChars) merged = merged.slice(0, maxChars)
  return merged
}

const callDeepSeekAPI = (rawText) => {
  return new Promise((resolve, reject) => {
    const cfgErr = getProxyBaseMisconfigReason()
    if (cfgErr) {
      reject(new Error(cfgErr))
      return
    }
    // 已登录优先发登录态 JWT；未登录仅在本地显式配置静态 Bearer 时回退（默认关闭）
    let bearer = resolveAuthToken()
    if (!bearer) bearer = String(DEV_ANALYZE_BEARER_TOKEN || '').trim()
    if (!bearer) {
      reject(new Error('缺少分析凭证：请先登录后再进行 AI 分析'))
      return
    }
    uni.request({
      url: AI_ANALYSIS_URL,
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {})
      },
      data: JSON.stringify({ text: rawText, provider: 'deepseek', model: 'deepseek-v4-flash' }),
      timeout: TIMEOUT_MS,
      success: (res) => {
        const body = res.data || {}
        const okBySuccess = body.success === true
        const okByCode = typeof body.code === 'number' && body.code === 0
        if (res.statusCode >= 200 && res.statusCode < 300 && (okBySuccess || okByCode)) {
          resolve(normalizeAIResult(body.data || {}))
          return
        }
        const em = body.errMsg || body.message || body.msg || JSON.stringify(body)
        reject(new Error('服务器分析失败：' + em))
      },
      fail: (err) => {
        if (err.errMsg && err.errMsg.includes('timeout')) {
          reject(new Error('网络请求超时，请检查网络连接'))
        } else {
          reject(new Error('网络请求失败: ' + (err.errMsg || JSON.stringify(err))))
        }
      }
    })
  })
}

export const analyzeWithDeepSeek = async (rawText) => {
  if (!rawText || rawText.trim().length < 50) {
    throw new Error('信用报告文本过短，无法进行AI分析')
  }

  // 与后端 server.js PRIMARY_CHARS 对齐：默认 40000 字符，让多数中长报告可整体送入 DeepSeek
  const compactText = compressCreditTextForAI(rawText)
  let lastError = null
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    try {
      return await callDeepSeekAPI(compactText)
    } catch (err) {
      lastError = err
      reportError({ kind: 'deepseek-retry', message: `第${attempt + 1}次调用失败: ${err.message || 'unknown'}`, page: 'deepseekService.analyzeWithDeepSeek' })
      if (attempt < MAX_RETRY) {
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)))
      }
    }
  }
  throw new Error(`DeepSeek AI 分析失败（重试${MAX_RETRY}次）：${lastError?.message || '未知错误'}`)
}

export const normalizeDeepSeekResult = normalizeAIResult
export const buildParsedFromDeepSeekNormalized = buildParsedFromAINormalized
export { aiToInternalDimensions, aiToScores }

const MATCH_FORBIDDEN_BODY_KEYS = new Set([
  'reportData',
  'analysisData',
  'analysisResult',
  'creditReportV2',
  'credit_report_v2',
  'credit_report_full'
])

export const buildMatchProductsRequest = (input, supplementArg) => {
  const source = typeof input === 'string'
    ? { reportId: input, supplement: supplementArg }
    : (input && typeof input === 'object' && !Array.isArray(input) ? input : {})
	const reportId = normalizeDecisionReportId(source.reportId)
  if (!reportId) {
    const error = new Error('产品匹配必须提供明确的 reportId，禁止上传报告正文')
    error.code = 'MATCH_REPORT_ID_REQUIRED'
    throw error
  }
  for (const key of MATCH_FORBIDDEN_BODY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const error = new Error('产品匹配请求不得包含报告正文')
      error.code = 'MATCH_REPORT_BODY_FORBIDDEN'
      throw error
    }
  }
  const supplement = source.supplement == null ? {} : source.supplement
  if (!supplement || typeof supplement !== 'object' || Array.isArray(supplement)) {
    const error = new Error('产品匹配 supplement 必须是对象')
    error.code = 'MATCH_SUPPLEMENT_INVALID'
    throw error
  }
  for (const key of MATCH_FORBIDDEN_BODY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(supplement, key)) {
      const error = new Error('产品匹配补充资料不得嵌入报告正文')
      error.code = 'MATCH_REPORT_BODY_FORBIDDEN'
      throw error
    }
  }
  return { reportId, supplement }
}

export const matchProducts = async (input, supplementArg) => {
  const requestBody = buildMatchProductsRequest(input, supplementArg)
  // Reuse the authenticated API client so a response from an old account is
  // rejected after logout/login instead of entering the new session UI.
  const data = await request({
    url: '/api/match-products',
    method: 'POST',
    data: requestBody,
    timeout: 65000
  })
  if (!data || data.success !== true) {
    const error = new Error(String(data?.errMsg || '产品匹配失败'))
    error.code = String(data?.errCode || 'MATCH_PRODUCTS_FAILED')
    throw error
  }
  return normalizeMatchProductsResponse(data, requestBody.reportId)
}

const objectValue = (value) => (
  value && typeof value === 'object' && !Array.isArray(value) ? value : {}
)

/**
 * Keep the complete server decision envelope.  Returning only `products`
 * would discard the owner/canonical evidence gate and let a page accidentally
 * fall back to browser-side matching.
 */
export const normalizeMatchProductsResponse = (value, expectedReportId = '') => {
  const data = objectValue(value)
	const reportId = normalizeDecisionReportId(data.reportId)
	const expected = normalizeDecisionReportId(expectedReportId)
  const reportMatches = Boolean(reportId && expected && reportId === expected)
  const evidenceVerified = reportMatches && data.evidenceVerified === true
  const decisionEligible = evidenceVerified && data.decisionEligible === true
  const locked = data.locked === true
  return Object.freeze({
    reportId: reportMatches ? reportId : '',
    evidenceVerified,
    decisionEligible,
    locked,
    materialGate: Object.freeze({ ...objectValue(data.materialGate) }),
    notice: Object.freeze({ ...objectValue(data.notice) }),
    products: Object.freeze(
      decisionEligible && !locked && Array.isArray(data.products)
        ? data.products.filter((item) => item && typeof item === 'object').map((item) => Object.freeze({ ...item }))
        : []
    )
  })
}

export default {
  analyzeWithDeepSeek,
  normalizeDeepSeekResult,
  buildParsedFromDeepSeekNormalized,
  buildMatchProductsRequest,
  normalizeMatchProductsResponse,
  aiToInternalDimensions,
  aiToScores,
  matchProducts
}
