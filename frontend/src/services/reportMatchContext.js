import { resolveV6TotalFromAnalysis } from './scoreV6.js'
import { decisionReportIdOf, normalizeDecisionReportId } from './decisionTrust.js'
import { strictNonNegativeNumberOrNull } from '../utils/strictNumber.js'

const MATCH_REPORT_CONTEXT_KEY = 'report_match_context'
const MATCH_REPORT_CONTEXT_TTL_MS = 30 * 60 * 1000

const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== '')
const objectValue = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const dateOnly = (value) => {
	if (typeof value !== 'string') return ''
	const raw = value.trim()
	const match = raw.match(/^(20\d{2})[-/.年](0?[1-9]|1[0-2])[-/.月](3[01]|[12]\d|0?[1-9])(?:\D|$)/)
	if (!match) return ''
	const year = Number(match[1])
	const month = Number(match[2])
	const day = Number(match[3])
	const parsed = new Date(Date.UTC(year, month - 1, day))
	return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
		? `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`
		: ''
}
const analysisDateOf = (report = {}) => {
	const analysis = objectValue(report.analysisData || report.analysisResult)
	const cv2 = objectValue(analysis.creditReportV2 || analysis.credit_report_full || analysis.credit_report_v2)
	const derivation = objectValue(analysis.derivation_meta || analysis.derivationMeta || cv2.derivation_meta || cv2.derivationMeta)
	const meta = objectValue(cv2.meta || analysis.meta)
	const basic = objectValue(analysis.basic_info || analysis.basicInfo || cv2.basic_info || cv2.basicInfo)
	for (const value of [
		report.reportDate, report.report_date,
		derivation.anchor_date, derivation.anchorDate,
		basic.report_date, basic.reportDate, basic.report_time, basic.reportTime,
		meta.report_date, meta.reportDate, meta.query_date, meta.queryDate,
		analysis.reportDate, analysis.report_date
	]) {
		const date = dateOnly(value)
		if (date) return date
	}
	return ''
}
const uploadDateOf = (report = {}) => {
	for (const value of [report.uploadDate, report.upload_date, report.uploadTime, report.upload_time, report.createdAt, report.created_at]) {
		const date = dateOnly(value)
		if (date) return date
	}
	return ''
}
const parseStored = (value) => {
  if (!value) return null
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch (e) { return null }
  }
  return value && typeof value === 'object' ? value : null
}
export const normalizeMatchMessageContext = (value = {}) => {
  const raw = parseStored(value, {}) || {}
  const messageId = String(first(raw.messageId, raw.sourceMessageId, raw.id, '') || '')
  if (!messageId) return null
  return {
    messageId,
    sourceMessageId: messageId,
    sourceTitle: String(first(raw.sourceTitle, raw.title, '') || ''),
    sourceCategory: String(first(raw.sourceCategory, raw.category, '') || ''),
    sourceFocus: String(first(raw.sourceFocus, raw.focus, '') || ''),
		reportId: normalizeDecisionReportId(raw.reportId),
    actionUrl: String(first(raw.actionUrl, raw.url, '') || '')
  }
}

const scoreOf = (report) => {
  const analysis = report && (report.analysisData || report.analysisResult)
  const resolved = resolveV6TotalFromAnalysis(analysis, report?.decisionTrust || null, decisionReportIdOf(report))
  const raw = resolved
	const n = strictNonNegativeNumberOrNull(raw)
	return n != null && n <= 100 ? String(Math.round(n)) : ''
}

export const saveMatchReportContext = (report, source = 'detail', extra = {}) => {
	const reportId = normalizeDecisionReportId(report && report.id)
  if (!reportId) return false
  const messageContext = normalizeMatchMessageContext(extra && extra.messageContext)
  try {
    uni.setStorageSync(MATCH_REPORT_CONTEXT_KEY, JSON.stringify({
      reportId,
      source,
      fileName: first(report.fileName, ''),
      reportType: first(report.reportType, report.analysisData && report.analysisData.reportFormat && report.analysisData.reportFormat.source, '信用报告'),
		reportDate: analysisDateOf(report),
		uploadDate: uploadDateOf(report),
      // Compatibility key remains report-date only. Upload time must never fill it.
		date: analysisDateOf(report),
      scoreText: scoreOf(report),
      messageContext,
      savedAt: Date.now()
    }))
    return true
  } catch (e) { return false }
}

export const readMatchReportContext = () => {
  try {
    const context = parseStored(uni.getStorageSync(MATCH_REPORT_CONTEXT_KEY))
		const reportId = normalizeDecisionReportId(context && context.reportId)
		if (!context || !reportId || !context.savedAt) return null
    if (Date.now() - context.savedAt > MATCH_REPORT_CONTEXT_TTL_MS) {
      clearMatchReportContext()
      return null
    }
		return { ...context, reportId }
  } catch (e) { return null }
}

// Distinguish "no pinned entry" from a pinned entry that expired or became
// unreadable. Matching must not silently replace the latter with another report.
export const inspectMatchReportContext = () => {
  let raw = null
  try { raw = uni.getStorageSync(MATCH_REPORT_CONTEXT_KEY) } catch (e) {
    return { present: true, invalid: true, reason: 'storage', context: null }
  }
  if (!raw) return { present: false, invalid: false, reason: '', context: null }
	const context = parseStored(raw)
	const reportId = normalizeDecisionReportId(context && context.reportId)
	if (!context || !reportId || !context.savedAt) {
    return { present: true, invalid: true, reason: 'malformed', context: null }
  }
  if (Date.now() - context.savedAt > MATCH_REPORT_CONTEXT_TTL_MS) {
    return { present: true, invalid: true, reason: 'expired', context }
  }
	return { present: true, invalid: false, reason: '', context: { ...context, reportId } }
}

export const clearMatchReportContext = () => {
  try { uni.removeStorageSync(MATCH_REPORT_CONTEXT_KEY) } catch (e) { /* ignore */ }
}

export default {
  normalizeMatchMessageContext,
  saveMatchReportContext,
  readMatchReportContext,
  inspectMatchReportContext,
  clearMatchReportContext
}
