/**
 * 信用报告存储服务
 * 管理分析报告的存储、读取和列表
 *
 * 支持云端同步：登录后自动同步到自建服务端，本地存储作为离线缓存。
 * 未登录时退化为纯本地存储模式。
 */
import { request } from './apiClient.js'
import { resolveV6TotalFromAnalysis } from './scoreV6.js'
import { desensitizeAnalysisForLocal } from '../utils/privacy.js'
import { reportError } from './errorReporter.js'
import { isLoggedIn } from './authService.js'
import { getSessionCleanupRevision } from './sensitiveLocalState.js'
import { isAuthoritativeServerAnalysis, markServerAnalysisResponse } from './authoritativeAnalysis.js'
import { mapServerAnalyzeDataToClientAnalysis } from './serverAnalyzeMapper.js'
import { isEvidenceOverdueRecord } from './decisionMetrics.js'
import {
	strictFiniteNumberOrNull,
	strictNonNegativeIntegerOrNull,
	strictNonNegativeNumberOrNull
} from '../utils/strictNumber.js'
import {
	createOwnerApiDecisionTrust,
	decisionReportIdOf,
	isOwnerApiDecisionTrust,
	normalizeDecisionReportId,
	readOwnerApiDecisionTrust,
	resolveDecisionReportIdAliases,
	trustedDecisionValue
} from './decisionTrust.js'
export { hasMeaningfulAnalysisData } from './analysisValidity.js'

export const REPORT_SYNC_UPDATED_EVENT = 'rpt:report-sync-updated'
const REPORT_CLOUD_PERSIST_TIMEOUT = 120000

const _emitReportSyncUpdated = (reportId, syncMeta = {}) => {
	try {
		const normalizedReportId = normalizeDecisionReportId(reportId)
		if (!normalizedReportId) return
		if (typeof uni !== 'undefined' && typeof uni.$emit === 'function') {
			uni.$emit(REPORT_SYNC_UPDATED_EVENT, { reportId: normalizedReportId, syncMeta })
		}
	} catch (e) { /* 页面状态通知失败不影响报告落盘 */ }
}

function _v6ScoreFromAnalysis(analysisData, trustedProjection = null, expectedReportId = '') {
	const s = resolveV6TotalFromAnalysis(analysisData, trustedProjection, expectedReportId)
	const n = strictNonNegativeNumberOrNull(s)
	return n != null && n <= 100 ? Math.round(n) : null
}

function _resolvedScoreFromAnalysis(analysisData, trustedProjection = null, expectedReportId = '') {
	return _v6ScoreFromAnalysis(analysisData, trustedProjection, expectedReportId)
}

/**
 * 统计口径统一：只接受通过 v6 可审计、可决策门禁的分数。
 * 历史原值仍保留在 analysisData 中，但不得进入首页统计、风险或匹配。
 */
function _statScoreOf(analysisData) {
	return _resolvedScoreFromAnalysis(analysisData)
}

const _first = (...values) => values.find((value) => value !== undefined && value !== null && value !== '')
const _obj = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const _reportIdentityError = (message = '报告 ID 格式无效，已停止保存') => {
	const error = new Error(message)
	error.code = 'REPORT_ID_INVALID'
	error.reportIdentityFailure = true
	return error
}
const _localReportIdentity = (value, { allowMissing = false } = {}) => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw _reportIdentityError()
	const hasPrimary = Object.prototype.hasOwnProperty.call(value, 'id')
	const rawPrimary = hasPrimary ? value.id : undefined
	let reportId = ''
	if (rawPrimary !== undefined && rawPrimary !== null) {
		// Preserve the existing absence contract: blank strings request automatic
		// generation, while non-string invalid scalars must fail closed.
		if (!(typeof rawPrimary === 'string' && rawPrimary.trim() === '')) {
			reportId = normalizeDecisionReportId(rawPrimary)
			if (!reportId) throw _reportIdentityError()
		}
	}
	const aliases = resolveDecisionReportIdAliases([
		Object.prototype.hasOwnProperty.call(value, 'clientReportId') ? value.clientReportId : undefined,
		Object.prototype.hasOwnProperty.call(value, 'localReportId') ? value.localReportId : undefined
	], { requireMatch: true })
	if (!aliases) throw _reportIdentityError('本地报告 ID alias 格式无效或冲突，已停止保存')
	const aliasId = aliases[0] || ''
	if (reportId && aliasId && reportId !== aliasId) {
		throw _reportIdentityError('本地报告 ID alias 冲突，已停止保存')
	}
	const resolved = reportId || aliasId
	if (!resolved && !allowMissing) throw _reportIdentityError('报告缺少稳定 ID，无法保存摘要')
	return Object.freeze({ reportId: resolved, clientReportId: aliasId || resolved })
}
const _serverReportIdFrom = (value) => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw _reportIdentityError()
	let syncMeta = {}
	if (Object.prototype.hasOwnProperty.call(value, 'syncMeta')) {
		const rawSyncMeta = value.syncMeta
		if (rawSyncMeta !== undefined && rawSyncMeta !== null && rawSyncMeta !== '') {
			if (!rawSyncMeta || typeof rawSyncMeta !== 'object' || Array.isArray(rawSyncMeta)) {
				throw _reportIdentityError('云端报告 ID metadata 格式无效，已停止保存')
			}
			syncMeta = rawSyncMeta
		}
	}
	const ids = resolveDecisionReportIdAliases([
		value.cloudReportId,
		value.serverReportId,
		value.reportId,
		value.report_id,
		value._id,
		syncMeta.cloudReportId
	], { requireMatch: true })
	if (!ids) throw _reportIdentityError('云端报告 ID alias 格式无效或冲突，已停止保存')
	return ids[0] || ''
}

/**
 * Validate a stored/cache body against the exact local key used to request it.
 * Local aliases must resolve to that key; canonical server aliases may differ
 * from the local id, but must be well-formed and mutually consistent.
 */
export const validateStoredReportIdentity = (report, requestedId) => {
	const expectedId = normalizeDecisionReportId(requestedId)
	if (!expectedId || !report || typeof report !== 'object' || Array.isArray(report)) return null
	try {
		const localIdentity = _localReportIdentity(report)
		if (localIdentity.reportId !== expectedId) return null
		const serverReportId = _serverReportIdFrom(report)
		const normalized = {
			...report,
			id: expectedId,
			clientReportId: localIdentity.clientReportId,
			cloudReportId: serverReportId
		}
		if (Object.prototype.hasOwnProperty.call(report, 'localReportId')) {
			normalized.localReportId = localIdentity.clientReportId
		}
		for (const key of ['serverReportId', 'reportId', 'report_id', '_id']) {
			if (Object.prototype.hasOwnProperty.call(report, key)) normalized[key] = serverReportId
		}
		if (
			report.syncMeta &&
			typeof report.syncMeta === 'object' &&
			!Array.isArray(report.syncMeta) &&
			Object.prototype.hasOwnProperty.call(report.syncMeta, 'cloudReportId')
		) {
			normalized.syncMeta = { ...report.syncMeta, cloudReportId: serverReportId }
		}
		return normalized
	} catch (_) {
		return null
	}
}
const _validatedUnkeyedStoredReport = (report) => {
	try {
		const localId = _localReportIdentity(report).reportId
		return validateStoredReportIdentity(report, localId)
	} catch (_) {
		return null
	}
}
const _mergeCompatObjects = (fallbackValue, preferredValue) => {
	const fallback = _obj(fallbackValue)
	const preferred = _obj(preferredValue)
	const merged = { ...fallback }
	for (const [key, value] of Object.entries(preferred)) {
		const previous = merged[key]
		if (value && typeof value === 'object' && !Array.isArray(value) && previous && typeof previous === 'object' && !Array.isArray(previous)) {
			merged[key] = _mergeCompatObjects(previous, value)
			continue
		}
		if (Array.isArray(value) && value.length === 0 && Array.isArray(previous) && previous.length > 0) continue
		if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0 && previous && typeof previous === 'object') continue
		if ((value === '' || value == null) && previous !== '' && previous != null) continue
		merged[key] = value
	}
	return merged
}
const _firstArray = (...values) =>
	values.find((value) => Array.isArray(value) && value.length > 0) ||
	values.find((value) => Array.isArray(value)) ||
	[]
export const resolveCloudReportIdentity = (row, fallbackId = '') => {
	if (!row || typeof row !== 'object' || Array.isArray(row)) return null
	let syncMeta = {}
	if (Object.prototype.hasOwnProperty.call(row, 'syncMeta')) {
		const rawSyncMeta = row.syncMeta
		if (rawSyncMeta !== undefined && rawSyncMeta !== null && rawSyncMeta !== '') {
			if (!rawSyncMeta || typeof rawSyncMeta !== 'object' || Array.isArray(rawSyncMeta)) return null
			syncMeta = rawSyncMeta
		}
	}
	const responseIds = resolveDecisionReportIdAliases([
		row.cloudReportId,
		row.serverReportId,
		row.reportId,
		row.report_id,
		row._id,
		row.id,
		syncMeta.cloudReportId
	], { requireMatch: true })
	const fallbackIds = resolveDecisionReportIdAliases([fallbackId], { requireMatch: true })
	const clientIds = resolveDecisionReportIdAliases([
		row.clientReportId,
		row.client_report_id,
		row.localId,
		row.local_id
	], { requireMatch: true })
	if (!responseIds || !fallbackIds || !clientIds) return null
	const responseId = responseIds[0] || ''
	const fallback = fallbackIds[0] || ''
	const clientReportId = clientIds[0] || ''
	if (responseId && fallback && responseId !== fallback && clientReportId !== fallback) return null
	const reportId = responseId || fallback
	if (!reportId) return null
	return Object.freeze({ reportId, clientReportId })
}
const _cloudReportIdOf = (row) => resolveCloudReportIdentity(row)?.reportId || ''
const _unwrapCloudReportPayload = (data) => {
	if (!data || typeof data !== 'object') return data
	return data.report || data.detail || data.item || data.record || data.payload || data.data || data
}
const _analysisOfCloudReport = (row) => {
	if (!row || typeof row !== 'object') return null
	return row.analysisData || row.analysisResult || row.analysis_result || row.result || row.analysis || row.report?.analysisData || row.report?.analysisResult || null
}
const _hasClientAnalysisProjection = (analysis) => Boolean(
	analysis &&
	typeof analysis === 'object' &&
	!Array.isArray(analysis) &&
	analysis.report &&
	typeof analysis.report === 'object' &&
	!Array.isArray(analysis.report) &&
	analysis.dimensions &&
	typeof analysis.dimensions === 'object' &&
	!Array.isArray(analysis.dimensions) &&
	Array.isArray(analysis.accounts)
)
const _analysisForCloudDetail = (analysis) => (
	isAuthoritativeServerAnalysis(analysis) && !_hasClientAnalysisProjection(analysis)
		? mapServerAnalyzeDataToClientAnalysis(analysis)
		: analysis
)
const _withOwnerApiDecisionTrust = (row) => {
	if (!row || typeof row !== 'object' || Array.isArray(row)) return row
	const analysis = _analysisOfCloudReport(row)
	// The owner API authenticates who may read the row, but older/unlinked rows
	// can still contain analysis JSON originally supplied by that same client.
	// Only a server-owned analysis-job link proves that the body was rehydrated
	// from the validated canonical cache rather than merely returned by the API.
	if (
		analysis &&
		row.decisionEvidenceLinked === true &&
		row.evidenceVerified === true
	) markServerAnalysisResponse(analysis)
	return {
		...row,
		decisionTrust: createOwnerApiDecisionTrust(row)
	}
}

export const cleanReportCustomerName = (value) => {
	let s = String(value || '').replace(/\s+/g, '').trim()
	if (!s) return ''
	s = s.replace(/^姓名[:：]?/, '')
	s = s.split(/证件类型|证件号码|身份证|证件|出生|婚姻|手机|电话|报告/)[0]
	s = s.replace(/[0-9Xx]{4,}/g, '')
	const masked = s.match(/[\u4e00-\u9fa5·][*＊×Xx]{1,4}[\u4e00-\u9fa5·]{0,3}/)
	if (masked) return masked[0].replace(/[＊×Xx]/g, '*').slice(0, 6)
	const match = s.match(/[\u4e00-\u9fa5·]{2,8}/)
	return match ? match[0].slice(0, 4) : ''
}

export const getReportCustomerName = (report = {}) => {
	const ad = _obj(report.analysisData || report.analysisResult || report.rawAnalysis || report.data)
	const cv2 = _obj(ad.creditReportV2 || ad.credit_report_full || ad.credit_report_v2 || ad.cv2)
	const fp = _obj(ad.frontendPayload || ad.frontend_payload)
	const basicCandidates = [
		_obj(report.basic_info),
		_obj(report.basicInfo),
		_obj(report.report && report.report.basicInfo),
		_obj(report.report && report.report.basic_info),
		_obj(report.personalInfo),
		_obj(report.personal_info),
		_obj(ad.basic_info),
		_obj(ad.basicInfo),
		_obj(ad.report && ad.report.basicInfo),
		_obj(ad.report && ad.report.basic_info),
		_obj(ad.personalInfo),
		_obj(ad.personal_info),
		_obj(cv2.basic_info),
		_obj(cv2.basicInfo),
		_obj(fp.basic_info),
		_obj(fp.basicInfo)
	]
	const candidates = [
		report.customerName,
		report.customer_name,
		report.reportCustomerName,
		report.clientName,
		report.userName,
		report.name,
		ad.customerName,
		ad.customer_name,
		ad.clientName,
		ad.userName,
		ad.name,
		...basicCandidates.flatMap((info) => [info.name, info.customer_name, info.customerName, info.user_name, info.clientName, info['姓名']])
	]
	for (const item of candidates) {
		const cleaned = cleanReportCustomerName(item)
		if (cleaned) return cleaned
	}
	return ''
}

const _normalizeReportIdCard = (value) => {
	const s = String(value || '').replace(/[^\dXx]/g, '').toUpperCase()
	if (/^\d{17}[\dX]$/.test(s) || /^\d{15}$/.test(s)) return s
	return ''
}

const _cleanReportIdLast4 = (value) => {
	const full = _normalizeReportIdCard(value)
	if (full) return full.slice(-4)
	const s = String(value || '').replace(/[^\dXx]/g, '').toUpperCase()
	return s.length >= 4 ? s.slice(-4) : ''
}

export const getReportIdentityInfo = (report = {}) => {
	const ad = _obj(report.analysisData || report.analysisResult || report.rawAnalysis || report.data)
	const cv2 = _obj(ad.creditReportV2 || ad.credit_report_full || ad.credit_report_v2 || ad.cv2)
	const fp = _obj(ad.frontendPayload || ad.frontend_payload)
	const basicCandidates = [
		_obj(report.basic_info),
		_obj(report.basicInfo),
		_obj(report.report && report.report.basicInfo),
		_obj(report.report && report.report.basic_info),
		_obj(report.personalInfo),
		_obj(report.personal_info),
		_obj(ad.basic_info),
		_obj(ad.basicInfo),
		_obj(ad.report && ad.report.basicInfo),
		_obj(ad.report && ad.report.basic_info),
		_obj(ad.personalInfo),
		_obj(ad.personal_info),
		_obj(cv2.basic_info),
		_obj(cv2.basicInfo),
		_obj(fp.basic_info),
		_obj(fp.basicInfo)
	]
	const fullCandidates = [
		report.idCard,
		report.id_card,
		report.idNo,
		report.id_no,
		report.idNumber,
		report.id_number,
		report.identityNo,
		report.identity_no,
		report.certificateNo,
		report.certificate_no,
		report.certNo,
		report.cert_no,
		report.credentialNo,
		report.credential_no,
		report['身份证号'],
		report['证件号码'],
		ad.idCard,
		ad.id_card,
		ad.idNo,
		ad.id_no,
		ad.idNumber,
		ad.id_number,
		ad.identityNo,
		ad.identity_no,
		ad.certificateNo,
		ad.certificate_no,
		ad.certNo,
		ad.cert_no,
		ad.credentialNo,
		ad.credential_no,
		ad['身份证号'],
		ad['证件号码'],
		...basicCandidates.flatMap((info) => [
			info.idCard,
			info.id_card,
			info.idNo,
			info.id_no,
			info.idNumber,
			info.id_number,
			info.identityNo,
			info.identity_no,
			info.certificateNo,
			info.certificate_no,
			info.certNo,
			info.cert_no,
			info.credentialNo,
			info.credential_no,
			info['身份证号'],
			info['证件号码']
		])
	]
	for (const item of fullCandidates) {
		const full = _normalizeReportIdCard(item)
		if (full) return { key: `full:${full}`, full, last4: full.slice(-4), precise: true }
	}
	const last4Candidates = [
		report.reportIdentityLast4,
		report.idLast4,
		report.id_last4,
		report.reportIdentity && report.reportIdentity.last4,
		ad.idLast4,
		ad.id_last4,
		...fullCandidates,
		...basicCandidates.flatMap((info) => [info.idLast4, info.id_last4])
	]
	for (const item of last4Candidates) {
		const last4 = _cleanReportIdLast4(item)
		if (last4) return { key: `last4:${last4}`, last4, precise: false }
	}
	return { key: '', last4: '', precise: false }
}

const _sameReportIdentity = (a = {}, b = {}) => Boolean(a.key && b.key && a.last4 && b.last4 && a.last4 === b.last4)

const _reportIdentityLabel = (info = {}) => info.last4 ? `身份证尾号${info.last4}` : '身份证信息'

const _cleanReportMonth = (value) => {
	if (typeof value !== 'string') return ''
	const s = value.trim()
	if (!s) return ''
	let m = s.match(/(20\d{2})[-/.年](0?[1-9]|1[0-2])(?:[-/.月]|$)/)
	if (!m) m = s.match(/(20\d{2})(0[1-9]|1[0-2])(?:\d{2})?/)
	if (!m) return ''
	return `${m[1]}-${String(m[2]).padStart(2, '0')}`
}

const _cleanReportDay = (value) => {
	if (typeof value !== 'string') return ''
	const raw = value.trim()
	if (!raw) return ''
	const validDay = (year, month, day) => {
		const y = Number(year)
		const m = Number(month)
		const d = Number(day)
		const parsed = new Date(Date.UTC(y, m - 1, d))
		return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d
	}
	const match = raw.match(/^(20\d{2})[-/.年](0?[1-9]|1[0-2])[-/.月](3[01]|[12]\d|0?[1-9])(?:\D|$)/)
	if (match && validDay(match[1], match[2], match[3])) return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`
	const compact = raw.match(/^(20\d{2})(0[1-9]|1[0-2])([0-2]\d|3[01])(?:\D|$)/)
	if (compact && validDay(compact[1], compact[2], compact[3])) return `${compact[1]}-${compact[2]}-${compact[3]}`
	return ''
}

/** 报告日只读取明确的报告/查询日期字段，绝不读取 createdAt、uploadTime 或兼容 evaluationTime。 */
export const getReportAnalysisDate = (report = {}) => {
	const ad = _obj(report.analysisData || report.analysisResult || report.rawAnalysis || report.data)
	const cv2 = _obj(ad.creditReportV2 || ad.credit_report_full || ad.credit_report_v2 || ad.cv2)
	const fp = _obj(ad.frontendPayload || ad.frontend_payload)
	const derivation = _obj(ad.derivation_meta || ad.derivationMeta || cv2.derivation_meta || cv2.derivationMeta)
	const meta = _obj(cv2.meta || ad.meta || fp.meta)
	const basic = _obj(ad.basic_info || ad.basicInfo || cv2.basic_info || cv2.basicInfo || fp.basic_info || fp.basicInfo)
	const candidates = [
		report.reportDate,
		report.report_date,
		derivation.anchor_date,
		derivation.anchorDate,
		basic.report_date,
		basic.reportDate,
		basic.report_time,
		basic.reportTime,
		meta.report_date,
		meta.reportDate,
		meta.query_date,
		meta.queryDate,
		ad.reportDate,
		ad.report_date
	]
	for (const candidate of candidates) {
		const day = _cleanReportDay(candidate)
		if (day) return day
	}
	return ''
}

/** 上传/保存时间始终单独标注；语义不明的旧 `date` 不得冒充上传或报告日期。 */
export const getReportUploadDate = (report = {}) => {
	for (const candidate of [
		report.uploadDate,
		report.upload_date,
		report.uploadedAt,
		report.uploaded_at,
		report.uploadTime,
		report.upload_time,
		report.createdAt,
		report.created_at
	]) {
		const day = _cleanReportDay(candidate)
		if (day) return day
	}
	return ''
}

export const getReportDateDisplayMeta = (report = {}) => {
	const reportDate = getReportAnalysisDate(report)
	const uploadDate = getReportUploadDate(report)
	return {
		reportDate,
		uploadDate,
		reportDateText: reportDate ? `报告日 ${reportDate}` : '报告日待核对',
		uploadDateText: uploadDate ? `上传 ${uploadDate}` : '上传时间待核对'
	}
}

export const getReportMonth = (report = {}) => {
	const ad = _obj(report.analysisData || report.analysisResult || report.rawAnalysis || report.data)
	const cv2 = _obj(ad.creditReportV2 || ad.credit_report_full || ad.credit_report_v2 || ad.cv2)
	const fp = _obj(ad.frontendPayload || ad.frontend_payload)
	const meta = _obj(ad.meta || cv2.meta || fp.meta)
	const basic = _obj(ad.basic_info || ad.basicInfo || cv2.basic_info || cv2.basicInfo || fp.basic_info || fp.basicInfo)
	const candidates = [
		report.reportMonth,
		report.reportPeriod,
		report.reportDate,
		report.report_date,
		report.fileName,
		report.name,
		ad.reportMonth,
		ad.reportPeriod,
		ad.reportDate,
		ad.report_date,
		meta.report_month,
		meta.reportMonth,
		meta.report_date,
		meta.reportDate,
		meta.query_date,
		meta.queryDate,
		basic.report_month,
		basic.reportMonth,
		basic.report_date,
		basic.reportDate,
		basic.query_date,
		basic.queryDate
	]
	for (const item of candidates) {
		const month = _cleanReportMonth(item)
		if (month) return month
	}
	return ''
}

export const validateReportArchivePolicy = (nextReport = {}, existingReports = [], unlimited = false) => {
	if (unlimited) return { allowed: true, mode: 'franchise' }
	const nextName = getReportCustomerName(nextReport)
	if (!nextName) return { allowed: false, message: '未识别到征信报告姓名，请上传清晰完整的本人征信报告。' }
	const nextIdentity = getReportIdentityInfo(nextReport)
	if (!nextIdentity.key) return { allowed: false, message: '未识别到征信报告身份证信息，请上传清晰完整的本人征信报告。' }
	const existing = Array.isArray(existingReports) ? existingReports.filter(Boolean) : []
	const nextMonth = getReportMonth(nextReport)
	if (!existing.length) return { allowed: true, mode: 'first', customerName: nextName, reportMonth: nextMonth, reportIdentityLast4: nextIdentity.last4 }
	const existingNames = existing.map(getReportCustomerName).filter(Boolean)
	if (existingNames.length && !existingNames.some((name) => name === nextName)) {
		return { allowed: false, message: `当前手机号已绑定${existingNames[0]}的征信档案，不能上传其他人的征信报告。` }
	}
	if (!existingNames.length) return { allowed: false, message: '当前账号已有历史征信报告但缺少姓名，需管理员核验后再上传更新报告。' }
	const existingIdentities = existing
		.map((report) => ({ name: getReportCustomerName(report), identity: getReportIdentityInfo(report) }))
		.filter((item) => item.name && item.identity && item.identity.key)
	if (!existingIdentities.length) return { allowed: false, message: '当前账号已有历史征信报告但缺少身份证信息，需管理员核验后再上传更新报告。' }
	const sameHolder = existingIdentities.some((item) => item.name === nextName && _sameReportIdentity(item.identity, nextIdentity))
	if (!sameHolder) {
		const bound = existingIdentities.find((item) => item.name === nextName) || existingIdentities[0]
		return { allowed: false, message: `当前手机号已绑定${bound.name}${_reportIdentityLabel(bound.identity)}的征信档案，不能上传其他人的征信报告。` }
	}
	return { allowed: true, mode: 'same-person-update', customerName: nextName, reportMonth: nextMonth, reportIdentityLast4: nextIdentity.last4 }
}

const _cloudReportToLocalPayload = (payload, fallbackId = '') => {
	const row = _unwrapCloudReportPayload(payload)
	if (!row || typeof row !== 'object') return null
	const identity = resolveCloudReportIdentity(row, fallbackId)
	if (!identity) return null
	const sourceAnalysis = _analysisOfCloudReport(row)
	if (!sourceAnalysis) return null
	// Linked report rows deliberately store the raw, server-owned canonical result.
	// Rebuild the same bounded client projection used immediately after analysis
	// when a later session hydrates that row from owner detail. Already-mapped and
	// legacy bodies stay untouched, so this cannot repeatedly remap local data.
	const analysisData = _analysisForCloudDetail(sourceAnalysis)
	const cloudReportId = identity.reportId
	const networkTrust = readOwnerApiDecisionTrust(row.decisionTrust)
	const decisionTrust = networkTrust && networkTrust.reportId === cloudReportId
		? networkTrust
		: null
	const reportDate = getReportAnalysisDate({ ...row, analysisData })
	const uploadDate = getReportUploadDate(row)
	return {
		id: identity.clientReportId || cloudReportId,
		clientReportId: identity.clientReportId,
		analysisData,
		decisionTrust,
		fileName: _first(row.fileName, row.file_name, row.name, row.title, '云端信用报告'),
		filePath: _first(row.filePath, row.file_path, ''),
			reportType: _first(row.reportType, row.report_type, analysisData.reportFormat?.source, '信用报告'),
			customerName: getReportCustomerName({ ...row, analysisData }),
			reportCustomerName: getReportCustomerName({ ...row, analysisData }),
			reportMonth: getReportMonth({ ...row, analysisData }),
			reportIdentityLast4: getReportIdentityInfo({ ...row, analysisData }).last4,
			reportDate,
			uploadDate,
			date: reportDate,
			createdAt: _first(row.createdAt, row.created_at, row.uploadTime, row.upload_time, ''),
		cloudReportId,
		analysisJobId: _first(row.analysisJobId, row.analysis_job_id, row.remoteJobId, row.remote_job_id, ''),
		decisionEvidenceLinked: row.decisionEvidenceLinked === true,
		syncStatus: 'synced',
		syncMeta: { status: 'synced', cloudReportId, restoredAt: new Date().toISOString() }
	}
}

const PRIVATE_EVIDENCE_ARTIFACT_KEYS = new Set([
	'evidence_v2',
	'evidenceV2',
	'documentManifest',
	'document_manifest',
	'evidenceGraph',
	'evidence_graph',
	'factLedger',
	'fact_ledger',
	'derivedAnalysis',
	'derived_analysis',
	'publicationGate',
	'publication_gate'
])

/** Keep the compatibility projection but never duplicate the private ledger
 * into /api/report/upload. The server links the canonical artifacts by job id. */
export const compactAnalysisForCloudUpload = (value, seen = new WeakMap()) => {
	if (Array.isArray(value)) return value.map((item) => compactAnalysisForCloudUpload(item, seen))
	if (!value || typeof value !== 'object') return value
	if (seen.has(value)) return seen.get(value)
	const copy = {}
	seen.set(value, copy)
	for (const [key, item] of Object.entries(value)) {
		if (PRIVATE_EVIDENCE_ARTIFACT_KEYS.has(key)) continue
		copy[key] = compactAnalysisForCloudUpload(item, seen)
	}
	return copy
}
/**
 * 云端同步：上传报告到云端（登录后自动调用）
 */
export const syncReportToCloud = async (reportData, options = {}) => {
	if (!isLoggedIn()) {
		if (options.throwOnError) throw _cloudPersistError('当前登录状态已失效，无法保存报告正文')
		return null
	}
	try {
		const ar = compactAnalysisForCloudUpload(reportData.analysisData || reportData.analysisResult || {})
		const analysisJobId = String(_first(reportData.analysisJobId, reportData.remoteJobId, '') || '')
		// 本地报告 ID 是同一次上传在断网重试时保持稳定的幂等键。
		// 服务端仍生成自己的 reportId，并把该值仅作为当前用户范围内的别名使用。
		const clientIds = resolveDecisionReportIdAliases([
			reportData.clientReportId,
			reportData.localReportId,
			reportData.id
		], { requireMatch: true })
		if (!clientIds) throw _cloudPersistError('本地报告 ID 格式无效，已停止云端保存')
		const clientReportId = clientIds[0] || ''
		const data = await request({
			url: '/api/report/upload',
			method: 'POST',
			timeout: REPORT_CLOUD_PERSIST_TIMEOUT,
			data: {
			reportType: reportData.reportType || '人行信用报告',
			filePath: reportData.filePath || '',
			fileName: reportData.fileName || '',
			analysisJobId,
			analysisResult: ar,
			financialSupplement: reportData.financialSupplement || ar.financialSupplement,
			clientReportId
			}
		})
		const responseIds = resolveDecisionReportIdAliases([data?.reportId, data?.id], { requireMatch: true })
		const responseClientIds = resolveDecisionReportIdAliases([
			data?.clientReportId,
			data?.client_report_id
		], { requireMatch: true })
		if (
			!responseIds ||
			!responseClientIds ||
			(responseClientIds[0] && responseClientIds[0] !== clientReportId)
		) throw _reportIdentityError('云端保存响应身份无效或冲突')
		return responseIds && responseIds.length ? responseIds[0] : null
	} catch (e) {
		reportError({ kind: 'report-sync-cloud', message: (e && (e.message || e.errMsg)) || '云端同步报告失败', extra: { action: 'syncReportToCloud' } })
		if (options.throwOnError) throw e
		return null
	}
}

export const syncReportToServer = syncReportToCloud

/**
 * 从云端获取报告列表
 */
export const getCloudReportList = async (page, pageSize) => {
	if (!isLoggedIn()) return []
	try {
		const data = await request({
			url: '/api/report/list',
			method: 'POST',
			data: { page: page || 1, pageSize: pageSize || 50 }
		})
		const rows = data?.list || data?.data || data || []
		return Array.isArray(rows)
			? rows.filter((row) => resolveCloudReportIdentity(row)).map(_withOwnerApiDecisionTrust)
			: []
	} catch (e) {
		reportError({ kind: 'report-cloud-list', message: (e && (e.message || e.errMsg)) || '云端获取报告列表失败', extra: { action: 'getCloudReportList' } })
		return []
	}
}

/**
 * 从云端获取报告统计
 */
export const getCloudReportStats = async () => {
	if (!isLoggedIn()) return null
	try {
		return await request({ url: '/api/report/stats', method: 'GET' })
	} catch (e) {
		reportError({ kind: 'report-cloud-stats', message: (e && (e.message || e.errMsg)) || '云端获取报告统计失败', extra: { action: 'getCloudReportStats' } })
		return null
	}
}

/**
 * 从云端获取单份报告详情。
 */
export const getCloudReportDetail = async (reportId) => {
	const normalizedReportId = normalizeDecisionReportId(reportId)
	if (!isLoggedIn() || !normalizedReportId) return null
	const id = encodeURIComponent(normalizedReportId)
	const attempts = [
		() => request({ url: `/api/report/${id}`, method: 'GET' }),
		() => request({ url: '/api/report/detail', method: 'POST', data: { reportId: normalizedReportId } }),
		() => request({ url: '/api/report/detail', method: 'GET', data: { reportId: normalizedReportId } })
	]
	let lastError = null
	for (const run of attempts) {
		try {
			const data = await run()
			const row = _unwrapCloudReportPayload(data)
			if (_analysisOfCloudReport(row) && resolveCloudReportIdentity(row, normalizedReportId)) {
				return _withOwnerApiDecisionTrust(row)
			}
			lastError = new Error(_analysisOfCloudReport(row) ? '云端详情报告 ID 不一致' : '云端详情缺少分析数据')
		} catch (e) {
			lastError = e
		}
	}
	reportError({ kind: 'report-cloud-detail', message: (lastError && (lastError.message || lastError.errMsg)) || '云端获取报告详情失败', extra: { action: 'getCloudReportDetail', reportId } })
	return null
}

export const restoreCloudReportToLocal = async (cloudReportOrId) => {
	if (!isLoggedIn() || !cloudReportOrId) return null
	const reportId = typeof cloudReportOrId === 'string'
		? normalizeDecisionReportId(cloudReportOrId)
		: _cloudReportIdOf(cloudReportOrId)
	if (!reportId) return null
	const source = _analysisOfCloudReport(cloudReportOrId) ? cloudReportOrId : await getCloudReportDetail(reportId)
	const localPayload = _cloudReportToLocalPayload(source, reportId)
	if (!localPayload) return null
	const localId = normalizeDecisionReportId(localPayload.clientReportId) || normalizeDecisionReportId(localPayload.id)
	const canonicalCloudId = normalizeDecisionReportId(localPayload.cloudReportId)
	const adoption = _resolveClientAliasAdoption(localId, canonicalCloudId)
	if (!adoption.allowed || !adoption.cloudReportId) return null
	return saveReport({
		...localPayload,
		id: adoption.localId,
		clientReportId: adoption.localId,
		createdAt: adoption.existing?.createdAt || localPayload.createdAt,
		cloudReportId: adoption.cloudReportId,
		syncStatus: 'synced',
		syncMeta: {
			...(adoption.existing?.syncMeta || localPayload.syncMeta || {}),
			status: 'synced',
			cloudReportId: adoption.cloudReportId
		}
	}, { skipCloudSync: true })
}
/**
 * 云端删除报告
 */
export const deleteCloudReport = async (reportId) => {
	const normalizedReportId = normalizeDecisionReportId(reportId)
	if (!isLoggedIn() || !normalizedReportId) return false
	try {
		const id = encodeURIComponent(normalizedReportId)
		await request({ url: `/api/report/${id}`, method: 'DELETE' })
		return true
	} catch (e) {
		reportError({ kind: 'report-cloud-delete', message: (e && (e.message || e.errMsg)) || '云端删除报告失败', extra: { action: 'deleteCloudReport', reportId } })
		return false
	}
}

/**
 * 统一规范化报告数据格式
 * 消除 rd.report.* 与 rd.aiInsight/rd.kimiInsight 双路字段读取的重复代码
 * 所有页面统一使用此函数取字段，不再各自写双路兼容逻辑
 * @param {Object} analysisData - report.analysisData
 * @param {Object|null} trustedProjection - 当前 owner API 外层信任投影
 * @returns {Object} 规范化后的字段集合
 */
export const normalizeReportData = (analysisData, trustedProjection = null, expectedReportId = '') => {
	if (!analysisData) {
		return {
			totalScore: null,
			riskLevel: 'unknown',
			creditAccounts: [],
			overdueSummary: null,
			overdueCount: null,
			suggestions: [],
			riskTags: [],
			aiSuggestion: '',
			debtCount: null,
			queryCount: null,
			sixDimensions: null,
			scores: null,
			aiAdvisoryScores: null,
			kimiAdvisoryScores: null,
			algorithmReport: null,
			analysisPipelineVersion: null,
		}
	}
	const r  = analysisData.report || {}
	const ai = _mergeCompatObjects(analysisData.kimiInsight, analysisData.aiInsight)
	const cv2 = _mergeCompatObjects(
		_mergeCompatObjects(
			_mergeCompatObjects(analysisData.credit_report_full, analysisData.credit_report_v2),
			analysisData.creditReportV2
		),
		analysisData.cv2
	)

	const totalScore = _resolvedScoreFromAnalysis(analysisData, trustedProjection, expectedReportId)
	const trustedRiskLevel = trustedDecisionValue(trustedProjection, 'riskLevel', 'riskLevel', expectedReportId)
	const riskLevel = typeof trustedRiskLevel === 'string' && trustedRiskLevel.trim()
		? trustedRiskLevel.trim()
		: 'unknown'

	// creditAccounts：优先从 report.creditAccounts（由 aiAnalysis 写入），
	// 其次从 task.data 顶层 accounts（旧版兼容），最后从 aiInsight
	const cv2Accounts = [
		...(Array.isArray(cv2.credit_card_details) ? cv2.credit_card_details : []),
		...(Array.isArray(cv2.loan_details?.bank_loans) ? cv2.loan_details.bank_loans : []),
		...(Array.isArray(cv2.loan_details?.non_bank_loans) ? cv2.loan_details.non_bank_loans : [])
	]
	const creditAccounts = _firstArray(
		r.creditAccounts,
		analysisData.accounts,
		ai.credit_accounts,
		cv2.accounts,
		cv2.credit_accounts,
		cv2Accounts.length ? cv2Accounts : null
	)

	const overdueSummaryMerged = _mergeCompatObjects(
		_mergeCompatObjects(ai.overdue_summary, r.overdue_summary),
		r.overdueSummary
	)
	const overdueSummary = Object.keys(overdueSummaryMerged).length ? overdueSummaryMerged : null
	// 逾期笔数字段名在不同来源不一致：AI/schema 用 current_overdue_count，旧字段为 total_overdue_count；
	// 再回退到 dimensions.overdueCount 与 overdueRecords 长度，避免有逾期却显示 0。
	const overdueCandidates = [
		overdueSummary?.total_overdue_count,
		overdueSummary?.current_overdue_count,
		overdueSummary?.overdueCount,
		analysisData.dimensions?.overdueCount,
		r.dimensions?.overdueCount,
		Array.isArray(analysisData.overdueRecords) && analysisData.overdueRecords.length > 0
			? analysisData.overdueRecords.filter(isEvidenceOverdueRecord).length || null
			: null
	].map(strictNonNegativeIntegerOrNull).filter((value) => value != null)
	const overdueCount = overdueCandidates.length ? Math.max(...overdueCandidates) : null
	const trustedSuggestions = trustedDecisionValue(trustedProjection, 'suggestions', 'suggestions', expectedReportId)
	const trustedRiskTags = trustedDecisionValue(trustedProjection, 'riskTags', 'riskTags', expectedReportId)
	const trustedAdvice = trustedDecisionValue(trustedProjection, 'advice', 'advice', expectedReportId)
	const suggestions = Array.isArray(trustedSuggestions) ? trustedSuggestions : []
	const riskTags = Array.isArray(trustedRiskTags) ? trustedRiskTags : []
	const aiSuggestion = typeof trustedAdvice === 'string' ? trustedAdvice : ''
	const debtCount = creditAccounts.length > 0
		? creditAccounts.length
		: (() => {
			return strictNonNegativeIntegerOrNull(_first(r.debtCount, r.debt_count))
		})()
	const queryCandidates = [r.queryCount, r.query_count, ai.query_count]
		.map(strictNonNegativeIntegerOrNull)
		.filter((value) => value != null)
	const queryCount = queryCandidates.length ? Math.max(...queryCandidates) : null
	const sixDimensionsMerged = _mergeCompatObjects(ai.six_dimensions, r.sixDimensions)
	const sixDimensions = Object.keys(sixDimensionsMerged).length ? sixDimensionsMerged : null

	// 四维评分快照：优先 report.scores / 顶层 scores（v5 为确定性公式分），兼容旧字段兜底
	const scoreFallback = _mergeCompatObjects(ai.six_dimensions, analysisData.scores)
	const scoreMerged = _mergeCompatObjects(scoreFallback, r.scores)
	const scores = Object.keys(scoreMerged).length ? scoreMerged : null
	const aiAdvisoryScores = analysisData.aiAdvisoryScores || analysisData.kimiAdvisoryScores || null
	const kimiAdvisoryScores = aiAdvisoryScores
	const algorithmReport = analysisData.algorithmReport || r.algorithmReport || null

	return {
		totalScore,
		riskLevel,
		creditAccounts,
		overdueSummary,
		overdueCount,
		suggestions,
		riskTags,
		aiSuggestion,
		debtCount,
		queryCount,
		sixDimensions,
		scores,                 // v5：与 totalScore 一致的公式四维
		aiAdvisoryScores,       // AI 四维对照（可为 null）
		kimiAdvisoryScores,     // 旧字段兼容（可为 null）
		algorithmReport,        // v3：分层流水线、负债拆解、查询窗、综合风险分
		analysisPipelineVersion: analysisData.analysisPipelineVersion || null,
	}
}

/**
 * 提取「列表用」轻量摘要。
 * 关键性能点：report_list 历史上整份存了 analysisData，导致 getReportList() 每次
 * onShow 都要同步 JSON.parse 一个会无限膨胀的大 blob（首页/匹配页切换卡顿主因）。
 * 现在本地只存摘要 + 预算好的统计字段；完整分析正文以云端为权威，
 * 仅在当前页面会话的内存缓存或兼容读取的旧 localStorage 数据中存在。
 * @param {Object} report - 完整报告对象（含 analysisData）
 * @returns {Object} 轻量摘要
 */
const _summaryOf = (report) => {
	if (!report || typeof report !== 'object' || Array.isArray(report)) throw _reportIdentityError()
	const identity = _localReportIdentity(report)
	const serverReportId = _serverReportIdFrom(report)
	report = { ...report, id: identity.reportId, clientReportId: identity.clientReportId }
	report = _withStableAnalysisAnchor(report)
	const ad = report.analysisData || report.analysisResult || null
	const n = normalizeReportData(ad)
	const reportDate = getReportAnalysisDate(report)
	const uploadDate = getReportUploadDate(report)
	return {
		id: identity.reportId,
		clientReportId: identity.clientReportId,
		createdAt: report.createdAt || '',
		updatedAt: report.updatedAt || '',
		fileName: report.fileName || '',
		filePath: report.filePath || '',
		reportType: report.reportType || '',
			customerName: report.customerName || getReportCustomerName(report),
			reportCustomerName: report.reportCustomerName || report.customerName || getReportCustomerName(report),
			reportMonth: report.reportMonth || getReportMonth(report),
			reportPeriod: report.reportPeriod || report.reportMonth || getReportMonth(report),
			reportIdentityLast4: report.reportIdentityLast4 || getReportIdentityInfo(report).last4,
			reportDate,
			uploadDate,
			date: reportDate,
		// 预算统计字段：isValidReport / getReportStats / my-report 列表无需再读 analysisData
		_summary: true,
		// JSON-persisted summaries are never an owner-API trust source.  A fresh
		// detail/list response can reattach an ephemeral decisionTrust in memory.
		_score: null,
		_scoreDecisionEligible: false,
		_riskLevel: 'unknown',
		_riskTags: [],
		_aiSuggestion: '',
		_accountCount: ad && Array.isArray(n.creditAccounts) && n.creditAccounts.length > 0
			? n.creditAccounts.length
			: strictNonNegativeIntegerOrNull(report._accountCount),
		syncStatus: report.syncStatus || report.syncMeta?.status || '',
		syncMeta: report.syncMeta || null,
		cloudReportId: serverReportId,
		analysisJobId: report.analysisJobId || report.remoteJobId || ''
	}
}

/**
 * 保存分析报告
 * @param {Object} reportData - 报告数据
 * @returns {string} 报告 ID
 */
// ── session 级缓存：避免 getLatestReport / getReportList 每次 onShow 都重复读 storage + JSON.parse ──
let _latestCache = null  // { id, report, ts }
let _listCache = null    // { list, ts }
const _detailCache = new Map() // 完整正文只保留在当前登录会话内存中
const CACHE_TTL_MS = 3000 // Tab 快速切换窗口内复用

function _invalidateLatestCache() {
	_latestCache = null
	_listCache = null
}

const _hasReportDetail = (report) => !!(
	report && typeof report === 'object' &&
	((report.analysisData && typeof report.analysisData === 'object') ||
	 (report.analysisResult && typeof report.analysisResult === 'object'))
)

const _cacheReportDetail = (report, requestedId = report && report.id) => {
	if (!_hasReportDetail(report)) return report
	const expectedId = normalizeDecisionReportId(requestedId)
	const validated = validateStoredReportIdentity(report, expectedId)
	if (!validated) {
		if (expectedId) _detailCache.delete(expectedId)
		return null
	}
	_detailCache.set(expectedId, {
		report: _withStableAnalysisAnchor(validated),
		sessionRevision: getSessionCleanupRevision()
	})
	return validated
}

const _cachedReportDetail = (reportId) => {
	const key = normalizeDecisionReportId(reportId)
	if (!key) return null
	const cached = _detailCache.get(key)
	if (!cached) return null
	if (cached.sessionRevision !== getSessionCleanupRevision()) {
		_detailCache.delete(key)
		return null
	}
	const validated = validateStoredReportIdentity(cached.report, key)
	if (!validated) {
		_detailCache.delete(key)
		return null
	}
	if (validated !== cached.report) {
		_detailCache.set(key, { ...cached, report: validated })
	}
	return validated
}

const _inspectLocalReportBinding = (reportId) => {
	const id = normalizeDecisionReportId(reportId)
	if (!id) return { present: false, invalid: true, report: null, cloudReportId: '' }
	const candidates = []
	let invalid = false
	const addCandidate = (value, tiedToId = false) => {
		if (!value) return
		const validated = validateStoredReportIdentity(value, id)
		if (!validated) {
			if (tiedToId) invalid = true
			return
		}
		candidates.push(validated)
	}
	const addUnkeyedCandidate = (item) => {
		if (!item || typeof item !== 'object' || Array.isArray(item)) return
		const aliases = [item.id, item.clientReportId, item.localReportId]
			.map(normalizeDecisionReportId)
			.filter(Boolean)
		if (aliases.includes(id)) addCandidate(item, true)
	}
	try {
		const cached = _detailCache.get(id)
		if (cached && cached.sessionRevision === getSessionCleanupRevision()) addCandidate(cached.report, true)
		if (_latestCache && _latestCache.sessionRevision === getSessionCleanupRevision()) {
			if (normalizeDecisionReportId(_latestCache.id) === id) addCandidate(_latestCache.report, true)
			else addUnkeyedCandidate(_latestCache.report)
		}
		if (_listCache && _listCache.sessionRevision === getSessionCleanupRevision() && Array.isArray(_listCache.list)) {
			_listCache.list.forEach(addUnkeyedCandidate)
		}

		const rawStored = _parseStored(uni.getStorageSync(`report_${id}`))
		if (rawStored) addCandidate(rawStored, true)

		const rawList = _parseStored(uni.getStorageSync('report_list'))
		if (Array.isArray(rawList)) {
			rawList.forEach(addUnkeyedCandidate)
		}
	} catch (_) {
		return { present: true, invalid: true, report: null, cloudReportId: '' }
	}
	const cloudIds = [...new Set(candidates.map((item) => normalizeDecisionReportId(item.cloudReportId)).filter(Boolean))]
	if (invalid || cloudIds.length > 1) {
		return { present: candidates.length > 0, invalid: true, report: null, cloudReportId: '' }
	}
	return {
		present: candidates.length > 0,
		invalid: false,
		report: candidates.find(_hasReportDetail) || candidates[0] || null,
		cloudReportId: cloudIds[0] || ''
	}
}

const _resolveClientAliasAdoption = (localReportId, canonicalCloudId) => {
	const localId = normalizeDecisionReportId(localReportId)
	const cloudId = normalizeDecisionReportId(canonicalCloudId)
	if (!localId) return { allowed: false, localId: '', cloudReportId: '', existing: null }
	const binding = _inspectLocalReportBinding(localId)
	const allowed = !binding.invalid && (
		!cloudId || !binding.cloudReportId || binding.cloudReportId === cloudId
	)
	return {
		allowed,
		localId,
		cloudReportId: cloudId || binding.cloudReportId || '',
		existing: binding.report
	}
}

/**
 * 容错读取已落盘数据。
 *
 * 历史存储可能返回 JSON 字符串，需要再次 JSON.parse。
 * 当前浏览器兼容层（compat/uni.js）会自动解析，直接返回对象或数组。
 *
 * 若此处对兼容垫片返回的对象再次 JSON.parse，会抛错 → 报告读不出来（持久化整体失效）。
 * 因此统一在此判定：字符串才解析，已是对象/数组则直接返回。
 */
function _parseStored(data) {
	if (data == null || data === '') return null
	if (typeof data === 'string') {
		try { return JSON.parse(data) } catch { return null }
	}
	return data
}

function _withStableAnalysisAnchor(report) {
	if (!report || typeof report !== 'object') return report
	const analysis = report.analysisData || report.analysisResult
	if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) return report
	if (isAuthoritativeServerAnalysis(analysis)) return report
	const fallbackAnchor = _first(report.date, report.createdAt, report.updatedAt)
	const anchored = !analysis.evaluationTime && fallbackAnchor
		? { ...analysis, evaluationTime: fallbackAnchor }
		: analysis
	if (report.analysisData === anchored) return report
	return { ...report, analysisData: anchored }
}

const _newReportId = () => {
	try {
		if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
			return `REPORT_${crypto.randomUUID()}`
		}
	} catch (_) {}
	return `REPORT_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

const _prepareReport = (reportData = {}) => {
	const identity = _localReportIdentity(reportData, { allowMissing: true })
	const serverReportId = _serverReportIdFrom(reportData)
	const reportId = identity.reportId || _newReportId()
	const clientReportId = identity.clientReportId || reportId
	// 即便正文只驻留内存，也继续沿用本地脱敏基线，避免同源脚本意外取得完整证件号。
	const safeData = reportData.analysisData
		? { ...reportData, analysisData: desensitizeAnalysisForLocal(reportData.analysisData) }
		: reportData.analysisResult
			? { ...reportData, analysisResult: desensitizeAnalysisForLocal(reportData.analysisResult) }
			: reportData
	const now = new Date().toISOString()
	let report = {
		...safeData,
		id: reportId,
		clientReportId,
		cloudReportId: serverReportId,
		customerName: getReportCustomerName(safeData),
		reportCustomerName: getReportCustomerName(safeData),
		reportMonth: getReportMonth(safeData),
		reportPeriod: getReportMonth(safeData),
		reportIdentityLast4: getReportIdentityInfo(safeData).last4,
		createdAt: safeData.createdAt || now,
		updatedAt: now
	}
	report = {
		...report,
		reportDate: getReportAnalysisDate(report),
		uploadDate: getReportUploadDate(report) || _cleanReportDay(now)
	}
	return _withStableAnalysisAnchor(report)
}

const _reportPersistError = (message, cause, extra = {}) => {
	const err = new Error(message || '本地报告摘要保存失败')
	err.code = 'REPORT_LOCAL_PERSIST_FAILED'
	err.storageFailure = true
	if (cause && cause.name) err.storageErrorName = String(cause.name)
	Object.assign(err, extra)
	return err
}

const _finiteTransportNumber = (value) => {
	return strictFiniteNumberOrNull(value)
}

const _safeStableErrorCode = (value) => {
	const raw = String(value || '').trim().toUpperCase()
	return /^[A-Z][A-Z0-9_]{1,63}$/.test(raw) ? raw : ''
}

const _publicHttp4xxCauseMessage = (cause) => {
	if (String(cause && cause.transportKind || '') !== 'http') return ''
	const httpStatus = _finiteTransportNumber(cause && (cause.httpStatus ?? cause.statusCode))
	if (httpStatus === null || httpStatus < 400 || httpStatus >= 500) return ''
	return String(cause && (cause.message || cause.errMsg) || '')
		.replace(/[\r\n\t]+/g, ' ')
		.trim()
		.slice(0, 300)
}

const _cloudPersistError = (message, cause) => {
	const err = new Error(_publicHttp4xxCauseMessage(cause) || message || '报告云端保存失败')
	err.code = 'REPORT_CLOUD_PERSIST_FAILED'
	err.cloudPersistenceFailure = true
	if (cause && cause.name) err.cloudErrorName = String(cause.name)
	const transportKind = String(cause && cause.transportKind || '')
	if (['http', 'timeout', 'abort', 'network'].includes(transportKind)) err.transportKind = transportKind
	const httpStatus = _finiteTransportNumber(cause && cause.httpStatus)
	const statusCode = _finiteTransportNumber(cause && cause.statusCode)
	if (httpStatus !== null) err.httpStatus = httpStatus
	if (statusCode !== null) err.statusCode = statusCode
	const businessCode = _finiteTransportNumber(cause && (cause.businessCode ?? (
		Number.isFinite(Number(cause.code)) ? cause.code : undefined
	)))
	if (businessCode !== null) err.businessCode = businessCode
	const backendCode = _safeStableErrorCode(cause && cause.backendCode)
	if (backendCode) err.backendCode = backendCode
	const causeCode = String(cause && cause.code || '').trim().slice(0, 80)
	if (causeCode) err.cloudCauseCode = causeCode
	if (cause && cause.timedOut === true) err.timedOut = true
	if (cause && cause.aborted === true) err.aborted = true
	if (cause && cause.networkFailure === true) err.networkFailure = true
	return err
}

const _assertPersistedSummary = (value, reportId, source) => {
	const summary = _parseStored(value)
	let summaryIdentity = null
	try { summaryIdentity = _localReportIdentity(summary) } catch (_) {}
	const expectedId = normalizeDecisionReportId(reportId)
	if (!summaryIdentity || !expectedId || summaryIdentity.reportId !== expectedId || summary._summary !== true) {
		throw _reportPersistError(`${source || '报告摘要'}写入后读回校验失败`)
	}
	if (_hasReportDetail(summary) || Object.prototype.hasOwnProperty.call(summary, 'rawAnalysis')) {
		throw _reportPersistError(`${source || '报告摘要'}意外包含完整分析正文`)
	}
	return summary
}

const _restoreStorageValue = (key, previous) => {
	if (previous == null || previous === '') uni.removeStorageSync(key)
	else uni.setStorageSync(key, typeof previous === 'string' ? previous : JSON.stringify(previous))
}

const _writeReportListSummary = (summary) => {
	const listKey = 'report_list'
	const rawList = _parseStored(uni.getStorageSync(listKey))
	// 未经云端核验的历史胖列表项保持原样，避免迁移时静默丢失唯一正文；
	// 新写入和本次更新的目标始终只写摘要。
	const next = Array.isArray(rawList) ? [...rawList] : []
	const summaryId = _localReportIdentity(summary).reportId
	const storedIdOf = (item) => {
		try { return _localReportIdentity(item).reportId } catch (_) { return '' }
	}
	const index = next.findIndex((item) => storedIdOf(item) === summaryId)
	if (index >= 0) next[index] = summary
	else next.unshift(summary)
	uni.setStorageSync(listKey, JSON.stringify(next))
	const readBack = _parseStored(uni.getStorageSync(listKey))
	const persisted = Array.isArray(readBack)
		? readBack.find((item) => storedIdOf(item) === summaryId)
		: null
	_assertPersistedSummary(persisted, summary.id, '报告列表摘要')
	return summary
}

const _persistLocalSummary = (report) => {
	const reportId = _localReportIdentity(report).reportId
	const incomingCloudId = _serverReportIdFrom(report)
	const adoption = _resolveClientAliasAdoption(reportId, incomingCloudId)
	if (!adoption.allowed) {
		throw _reportIdentityError('本地报告已绑定其他云端身份，已停止覆盖')
	}
	if (!incomingCloudId && adoption.cloudReportId) {
		report.cloudReportId = adoption.cloudReportId
		report.syncStatus = report.syncStatus || adoption.existing?.syncStatus || 'synced'
		report.syncMeta = {
			...(report.syncMeta || adoption.existing?.syncMeta || {}),
			status: report.syncMeta?.status || adoption.existing?.syncMeta?.status || 'synced',
			cloudReportId: adoption.cloudReportId
		}
	}
	const key = `report_${reportId}`
	const listKey = 'report_list'
	let previousDetail = ''
	let previousList = ''
	try {
		previousDetail = uni.getStorageSync(key)
		previousList = uni.getStorageSync(listKey)
		const summary = _summaryOf(report)
		uni.setStorageSync(key, JSON.stringify(summary))
		_assertPersistedSummary(uni.getStorageSync(key), reportId, '报告摘要')
		_writeReportListSummary(summary)
		_invalidateLatestCache()
		return summary
	} catch (cause) {
		try { _restoreStorageValue(key, previousDetail) } catch (_) {}
		try { _restoreStorageValue(listKey, previousList) } catch (_) {}
		_invalidateLatestCache()
		if (cause && cause.code === 'REPORT_LOCAL_PERSIST_FAILED') throw cause
		throw _reportPersistError('本地报告摘要保存失败，请检查浏览器存储空间', cause)
	}
}

export const saveReport = (reportData, options = {}) => {
	_invalidateLatestCache()
	try {
		const report = _prepareReport(reportData)
		_persistLocalSummary(report)
		_cacheReportDetail(report)
		if (!options.skipCloudSync) queueReportCloudSync(report.id, report)
		return report.id
	} catch (e) {
		reportError({ kind: 'report-save-local', message: (e && (e.message || e.errMsg)) || '保存报告失败', stack: (e && e.stack) || '' })
		throw e
	}
}

/**
 * 耐久保存：先确认云端正文落盘，再保存并读回本地摘要。
 * 新上传流程应使用本接口；旧 saveReport 仅保留兼容。
 */
export const saveReportDurable = async (reportData, options = {}) => {
	const report = _prepareReport(reportData)
	let cloudReportId = ''
	try {
		cloudReportId = await syncReportToCloud(report, { throwOnError: true })
		if (!cloudReportId) throw _cloudPersistError('云端未返回报告 ID')
	} catch (cause) {
		if (cause && cause.code === 'REPORT_CLOUD_PERSIST_FAILED') throw cause
		throw _cloudPersistError('报告正文未能保存到云端，请检查网络后重试', cause)
	}
	const now = new Date().toISOString()
	const durableReport = {
		...report,
		cloudReportId,
		syncStatus: 'synced',
		syncMeta: {
			...(report.syncMeta || {}),
			status: 'synced',
			cloudReportId,
			syncedAt: now,
			error: ''
		},
		updatedAt: now
	}
	try {
		_persistLocalSummary(durableReport)
		_cacheReportDetail(durableReport)
		return durableReport.id
	} catch (cause) {
		if (cause && typeof cause === 'object') cause.cloudReportId = cloudReportId
		throw cause
	}
}

/**
 * 获取报告详情
 * @param {string} reportId - 报告 ID
 * @returns {Object|null}
 */
export const getReport = (reportId) => {
	try {
		const id = normalizeDecisionReportId(reportId)
		if (!id) return null
		const cached = _cachedReportDetail(id)
		if (cached) return cached
		const key = `report_${id}`
		const data = uni.getStorageSync(key)
		const parsed = _parseStored(data)
		const validated = validateStoredReportIdentity(parsed, id)
		if (!validated) {
			_detailCache.delete(id)
			return null
		}
		const report = _withStableAnalysisAnchor(validated)
		if (_hasReportDetail(report)) return _cacheReportDetail(report, id) // 兼容旧 localStorage 正文
		return report
	} catch (e) {
		reportError({ kind: 'report-get-local', message: (e && (e.message || e.errMsg)) || '获取报告失败', stack: (e && e.stack) || '' })
		return null
	}
}

/**
 * 异步取得完整报告：会话/旧本地正文优先，否则按摘要 cloudReportId 回源云端详情。
 * 成功回源后只更新本地摘要，正文仅进入当前会话内存缓存。
 */
export const getReportAsync = async (reportId, options = {}) => {
	const id = normalizeDecisionReportId(reportId)
	if (!id) return null
	const local = getReport(id)
	// A local/cached body is useful for archival display, but it cannot carry a
	// decision unless it still has the module-branded projection from a current
	// owner API response.  Logged-in synced reports therefore refresh detail
	// before any page treats score/risk/advice as decision eligible.
	if (_hasReportDetail(local) && isOwnerApiDecisionTrust(local?.decisionTrust, decisionReportIdOf(local))) return local
	if (options.cloudFallback === false || !isLoggedIn()) return local
	let localSyncMeta = {}
	if (local && Object.prototype.hasOwnProperty.call(local, 'syncMeta')) {
		const rawSyncMeta = local.syncMeta
		if (rawSyncMeta !== undefined && rawSyncMeta !== null && rawSyncMeta !== '') {
			if (!rawSyncMeta || typeof rawSyncMeta !== 'object' || Array.isArray(rawSyncMeta)) return local
			localSyncMeta = rawSyncMeta
		}
	}
	const localCloudIds = resolveDecisionReportIdAliases([
		local?.cloudReportId,
		local?.serverReportId,
		localSyncMeta.cloudReportId
	], { requireMatch: true })
	if (!localCloudIds) return local
	const candidates = [...new Set([...localCloudIds, id])]
	for (const cloudId of candidates) {
		const source = await getCloudReportDetail(cloudId)
		const payload = _cloudReportToLocalPayload(source, cloudId)
		if (!payload || !_hasReportDetail(payload)) continue
		const payloadClientId = normalizeDecisionReportId(payload.clientReportId)
		const payloadLocalId = normalizeDecisionReportId(payload.id)
		const localId = local ? id : (payloadClientId || payloadLocalId)
		// When a local key already exists, a refreshed owner response may use a
		// distinct canonical cloud id, but its client alias must still name that
		// exact local asset.  A cloud-direct read without a local row instead adopts
		// the validated client alias as its local id.
		if (!localId || (local && payloadClientId && payloadClientId !== id)) continue
		const canonicalCloudId = normalizeDecisionReportId(payload.cloudReportId)
		if (!canonicalCloudId) continue
		let adoptedLocal = local
		if (!local) {
			const adoption = _resolveClientAliasAdoption(localId, canonicalCloudId)
			if (!adoption.allowed) continue
			adoptedLocal = adoption.existing
		}
		const hydrated = _prepareReport({
			...payload,
			id: localId,
			clientReportId: localId,
			createdAt: adoptedLocal?.createdAt || payload.createdAt,
			cloudReportId: canonicalCloudId,
			syncStatus: 'synced',
			syncMeta: {
				...(adoptedLocal?.syncMeta || payload.syncMeta || {}),
				status: 'synced',
				cloudReportId: canonicalCloudId
			}
		})
		_persistLocalSummary(hydrated)
		_cacheReportDetail(hydrated)
		return hydrated
	}
	return local
}

let _legacyBodyMigrationFlight = null

/**
 * 将旧版本遗留在 localStorage 的完整报告正文安全迁移到云端。
 * 只有云端按 clientReportId 幂等保存成功后，才用已读回校验的摘要覆盖本地正文；
 * 断网、鉴权或配额失败时保留原正文，避免为了“瘦身”造成数据丢失。
 */
export const migrateLegacyReportBodiesToCloud = (options = {}) => {
	if (_legacyBodyMigrationFlight) return _legacyBodyMigrationFlight
	_legacyBodyMigrationFlight = (async () => {
		if (!isLoggedIn()) return { migrated: 0, retained: 0 }
		const limit = Math.max(1, Math.min(10, Math.trunc(Number(options.limit) || 2)))
		const candidates = new Map()
		const remember = (value, requestedId = '') => {
			if (!_hasReportDetail(value)) return
			let localId = normalizeDecisionReportId(requestedId)
			if (!localId) {
				try { localId = _localReportIdentity(value).reportId } catch (_) { return }
			}
			const validated = validateStoredReportIdentity(value, localId)
			if (!validated) return
			candidates.set(localId, validated)
		}

		const rawList = _parseStored(uni.getStorageSync('report_list'))
		if (Array.isArray(rawList)) rawList.forEach(remember)
		let keys = []
		try {
			const info = uni.getStorageInfoSync()
			keys = info && Array.isArray(info.keys) ? info.keys : []
		} catch (_) {}
		for (const key of keys) {
			if (typeof key !== 'string' || key === 'report_list' || !key.startsWith('report_')) continue
			remember(_parseStored(uni.getStorageSync(key)), key.slice('report_'.length))
		}

		let migrated = 0
		let retained = 0
		for (const legacy of [...candidates.values()].slice(0, limit)) {
			try {
				const report = _prepareReport(legacy)
				const cloudReportId = await syncReportToCloud(report, { throwOnError: true })
				if (!cloudReportId) throw _cloudPersistError('旧报告云端迁移未返回报告 ID')
				const now = new Date().toISOString()
				const durable = {
					...report,
					cloudReportId,
					syncStatus: 'synced',
					syncMeta: {
						...(report.syncMeta || {}),
						status: 'synced',
						cloudReportId,
						syncedAt: now,
						error: ''
					},
					updatedAt: now
				}
				_persistLocalSummary(durable)
				_cacheReportDetail(durable)
				migrated += 1
			} catch (error) {
				retained += 1
				reportError({
					kind: 'report-legacy-body-migration',
					message: (error && (error.message || error.errMsg)) || '旧报告正文迁移失败',
					extra: { action: 'migrateLegacyReportBodiesToCloud' }
				})
			}
		}
		return { migrated, retained }
	})().finally(() => {
		_legacyBodyMigrationFlight = null
	})
	return _legacyBodyMigrationFlight
}

/**
 * 获取所有报告列表
 * @returns {Array}
 */
export const getReportList = () => {
	// session 缓存：列表为轻量摘要，但 Tab 密集切换时仍可省去重复 JSON.parse + sort。
	// 任一写入路径（save/delete/clear）都会 _invalidateLatestCache 失效本缓存。
	if (_listCache && _listCache.sessionRevision === getSessionCleanupRevision() && (Date.now() - _listCache.ts) < CACHE_TTL_MS) {
		const validated = _listCache.list.map(_validatedUnkeyedStoredReport).filter(Boolean)
		if (validated.length === _listCache.list.length) {
			_listCache = { ..._listCache, list: validated }
			return validated
		}
		_listCache = null
	}
	try {
		const listKey = 'report_list'
		const data = uni.getStorageSync(listKey)
		const parsed = _parseStored(data)
		const list = Array.isArray(parsed) ? parsed : []
		const summaries = list.flatMap((item) => {
			try {
				if (!item || item._summary !== true) {
					const summary = _summaryOf(item)
					if (_hasReportDetail(item)) _cacheReportDetail(item) // 旧胖列表仅兼容读取，不再新增
					return [summary]
				}
				const identity = _localReportIdentity(item)
				const serverReportId = _serverReportIdFrom(item)
				return [{
					...item,
					id: identity.reportId,
					clientReportId: identity.clientReportId,
					cloudReportId: serverReportId
				}]
			} catch (error) {
				if (error?.code === 'REPORT_ID_INVALID') return []
				throw error
			}
		})

		// 按创建时间倒序排序（拷贝后再排，避免原地 sort 改动被 _listCache 引用泄漏）
		const sorted = [...summaries].sort((a, b) => {
			return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
		})
		_listCache = { list: sorted, ts: Date.now(), sessionRevision: getSessionCleanupRevision() }
		return sorted
	} catch (e) {
		reportError({ kind: 'report-list-local', message: (e && (e.message || e.errMsg)) || '获取报告列表失败', stack: (e && e.stack) || '' })
		return []
	}
}

/**
 * 更新报告列表
 * @param {Object} report - 报告
 */
const updateReportList = (report) => {
	const summary = _summaryOf({ ...report, updatedAt: new Date().toISOString() })
	_writeReportListSummary(summary)
	_invalidateLatestCache()
	return summary
}

const patchReportSyncMeta = (reportId, syncMeta) => {
	const id = normalizeDecisionReportId(reportId)
	if (!id || !syncMeta || typeof syncMeta !== 'object' || Array.isArray(syncMeta)) return false
	const patchCloudIds = resolveDecisionReportIdAliases([
		Object.prototype.hasOwnProperty.call(syncMeta, 'cloudReportId') ? syncMeta.cloudReportId : undefined
	], { requireMatch: true })
	if (!patchCloudIds) return false
	const patchCloudId = patchCloudIds[0] || ''
	if (patchCloudId && !_resolveClientAliasAdoption(id, patchCloudId).allowed) return false
	_invalidateLatestCache()
	try {
		const key = `report_${id}`
		const rawStored = _parseStored(uni.getStorageSync(key))
		const stored = rawStored ? validateStoredReportIdentity(rawStored, id) : null
		if (rawStored && !stored) return false
		const now = new Date().toISOString()
		const cached = _cachedReportDetail(id)
		if (cached) {
			const nextCached = validateStoredReportIdentity({
				...cached,
				syncStatus: syncMeta.status,
				syncMeta: { ...(cached.syncMeta || {}), ...syncMeta },
				cloudReportId: syncMeta.cloudReportId || cached.cloudReportId || '',
				updatedAt: now
			}, id)
			if (!nextCached) return false
			_cacheReportDetail(nextCached, id)
		}
		if (stored) {
			const next = validateStoredReportIdentity({
				...stored,
				syncStatus: syncMeta.status,
				syncMeta: { ...(stored.syncMeta || {}), ...syncMeta },
				cloudReportId: syncMeta.cloudReportId || stored.cloudReportId || '',
				updatedAt: now
			}, id)
			if (!next) return false
			uni.setStorageSync(key, JSON.stringify(next))
			_assertPersistedSummary(uni.getStorageSync(key), id, '同步状态摘要')
			updateReportList(next)
			_emitReportSyncUpdated(id, next.syncMeta)
			return true
		}
		const list = getReportList()
		const index = list.findIndex((item) => item && item.id === id)
		if (index >= 0) {
			const current = list[index]
			const next = validateStoredReportIdentity({
				...current,
				syncStatus: syncMeta.status,
				syncMeta: { ...(current.syncMeta || {}), ...syncMeta },
				cloudReportId: syncMeta.cloudReportId || current.cloudReportId || '',
				updatedAt: now
			}, id)
			if (!next) return false
			updateReportList(next)
			_emitReportSyncUpdated(id, next.syncMeta)
			return true
		}
		return false
	} catch (e) {
		reportError({ kind: 'report-sync-meta', message: (e && (e.message || e.errMsg)) || '更新报告同步状态失败', extra: { action: 'patchReportSyncMeta', reportId: id } })
		return false
	}
}

const queueReportCloudSync = (reportId, report) => {
	const id = normalizeDecisionReportId(reportId)
	const validatedReport = validateStoredReportIdentity(report, id)
	if (!id || !validatedReport || !isLoggedIn()) return
	syncReportToCloud(validatedReport, { throwOnError: true }).then((cloudReportId) => {
		if (!cloudReportId) {
			patchReportSyncMeta(id, { status: 'failed', failedAt: new Date().toISOString(), error: '云端未返回报告 ID' })
			return
		}
		patchReportSyncMeta(id, { status: 'synced', cloudReportId, syncedAt: new Date().toISOString(), error: '' })
	}).catch((e) => {
		if (e?.code === 'REPORT_ID_INVALID') return
		patchReportSyncMeta(id, { status: 'failed', failedAt: new Date().toISOString(), error: (e && (e.message || e.errMsg)) || '云端同步失败' })
	})
}

export const retryReportCloudSync = async (reportId) => {
	const id = normalizeDecisionReportId(reportId)
	if (!isLoggedIn() || !id) return false
	const report = await getReportAsync(id)
	if (!report || !report.analysisData) {
		patchReportSyncMeta(id, { status: 'failed', failedAt: new Date().toISOString(), error: '本地报告详情缺失，请重新上传' })
		return false
	}
	let cloudReportId = null
	try {
		cloudReportId = await syncReportToCloud(report, { throwOnError: true })
	} catch (error) {
		if (error?.code !== 'REPORT_ID_INVALID') {
			patchReportSyncMeta(id, { status: 'failed', failedAt: new Date().toISOString(), error: (error && (error.message || error.errMsg)) || '云端同步失败' })
		}
		return false
	}
	if (!cloudReportId) {
		patchReportSyncMeta(id, { status: 'failed', failedAt: new Date().toISOString(), error: '云端未返回报告 ID' })
		return false
	}
	return patchReportSyncMeta(id, { status: 'synced', cloudReportId, syncedAt: new Date().toISOString(), error: '' }) === true
}
export const unlinkCloudReportFromLocal = (reportId, extra = {}) => {
	const id = normalizeDecisionReportId(reportId)
	if (!id) return false
	_invalidateLatestCache()
	_detailCache.delete(id)
	try {
		const now = new Date().toISOString()
		const nextMeta = (meta) => ({ ...(meta || {}), status: 'local', cloudReportId: '', unlinkedAt: now, ...extra })
		const key = `report_${id}`
		const rawStored = _parseStored(uni.getStorageSync(key))
		const stored = rawStored ? validateStoredReportIdentity(rawStored, id) : null
		if (rawStored && !stored) return false
		if (stored) {
			const next = validateStoredReportIdentity({
				...stored,
				syncStatus: 'local',
				syncMeta: nextMeta(stored.syncMeta),
				cloudReportId: '',
				serverReportId: '',
				remoteId: '',
				updatedAt: now
			}, id)
			if (!next) return false
			uni.setStorageSync(key, JSON.stringify(next))
			updateReportList(next)
			return true
		}
		const list = getReportList()
		const index = list.findIndex((item) => item && item.id === id)
		if (index < 0) return false
		const next = validateStoredReportIdentity({
			...list[index],
			syncStatus: 'local',
			syncMeta: nextMeta(list[index].syncMeta),
			cloudReportId: '',
			serverReportId: '',
			remoteId: '',
			updatedAt: now
		}, id)
		if (!next) return false
		list[index] = next
		uni.setStorageSync('report_list', JSON.stringify(list))
		_invalidateLatestCache()
		return true
	} catch (e) {
		reportError({ kind: 'report-cloud-unlink-local', message: (e && (e.message || e.errMsg)) || '解绑本机云端报告失败', extra: { action: 'unlinkCloudReportFromLocal', reportId: id } })
		return false
	}
}

/**
 * 删除报告
 * @param {string} reportId - 报告 ID
 * @returns {boolean}
 */
export const deleteReport = (reportId) => {
	const id = normalizeDecisionReportId(reportId)
	if (!id) return false
	_invalidateLatestCache()
	_detailCache.delete(id)
	try {
		// 删除单个报告
		const key = `report_${id}`
		uni.removeStorageSync(key)

		// 从列表中移除
		const rawList = _parseStored(uni.getStorageSync('report_list'))
		const list = Array.isArray(rawList) ? rawList : []
		const filteredList = list.filter((item) => {
			try { return _localReportIdentity(item).reportId !== id } catch (_) { return true }
		})
		uni.setStorageSync('report_list', JSON.stringify(filteredList))
		_invalidateLatestCache() // 写后失效，清除上面 getReportList 回填的删前列表

		return true
	} catch (e) {
		reportError({ kind: 'report-delete-local', message: (e && (e.message || e.errMsg)) || '删除报告失败', stack: (e && e.stack) || '' })
		return false
	}
}

/**
 * 清空本地所有报告缓存（含逐份 report_* 明细、列表与当前任务态）。
 * 隐私基线：退出登录时调用，避免在共享设备上把上一位用户的信用报告（明文）残留在本地。
 * @returns {number} 清理掉的 storage key 数量
 */
export const clearLocalReportCache = () => {
	_invalidateLatestCache()
	_detailCache.clear()
	let removed = 0
	const removeKey = (k) => {
		try { uni.removeStorageSync(k); removed++ } catch (_) { /* ignore */ }
	}
	try {
		let keys = []
		try {
			const info = uni.getStorageInfoSync()
			keys = info && Array.isArray(info.keys) ? info.keys : []
		} catch (_) { /* getStorageInfoSync 不可用时退化为固定键清理 */ }
		keys.forEach((k) => {
			if (typeof k === 'string' && (k === 'report_list' || k.startsWith('report_'))) {
				removeKey(k)
			}
		})
	} catch (e) {
		reportError({ kind: 'report-cache-enum', message: (e && e.message) || '枚举本地缓存失败', page: 'reportStorage.clearLocalReportCache' })
	}
	// 兜底清理已知固定键（即便枚举失败也确保敏感态被清除）
	;['report_list', 'currentTaskId', 'analysisResult'].forEach(removeKey)
	return removed
}

/**
 * 判断报告资产是否有效。
 * 报告是否存在与“当前能否解析出可信评分”是两个独立状态：文件元信息和稳定 id
 * 足以证明这是一份用户报告资产；无分、待分析或旧格式报告必须保留，交给页面提示重试。
 * @param {Object} report
 * @returns {boolean}
 */
export const isValidReport = (report) => {
	if (!report || typeof report !== 'object' || Array.isArray(report)) return false
	// 必须具备文件元信息，避免旧演示/脏缓存在首页被当作真实报告展示
	const hasFileMeta = !!(report.fileName || report.filePath)
	let identity = null
	try {
		identity = _localReportIdentity(report)
		_serverReportIdFrom(report)
	} catch (_) { return false }
	return hasFileMeta && Boolean(identity.reportId)
}

/**
 * 清理没有文件身份的演示/损坏条目；无可信评分的真实报告仍保留。
 * @returns {number} 清理掉的数量
 */
export const cleanInvalidReports = () => {
	try {
		const listKey = 'report_list'
		const list = getReportList()
		// 单次遍历分区：避免两个 filter 各扫描全量
		const valid = []
		const invalid = []
		for (const r of list) {
			if (isValidReport(r)) valid.push(r)
			else invalid.push(r)
		}
		const removed = invalid.length

		// 删除无效报告的 storage key
		if (removed > 0) {
			for (const r of invalid) {
				try { uni.removeStorageSync(`report_${r.id}`) } catch (e) { /* ignore */ }
			}
		}

		// 一次性迁移：把历史上内嵌 analysisData 的「胖列表项」压成轻量摘要，
		// 让后续每次切换的 JSON.parse 量从「全量」降到「几百字节」。
		const needMigrate = valid.some(r => r && r._summary !== true)
		if (removed > 0 || needMigrate) {
			const slim = valid.map(r => {
				if (!r || r._summary === true) return r
				// 摘要化前确保明细仍可按 id 取到（旧数据 saveReport 已写过，这里仅兜底）
				if (r.id && (r.analysisData || r.analysisResult)) {
					try {
						if (!uni.getStorageSync(`report_${r.id}`)) {
							uni.setStorageSync(`report_${r.id}`, JSON.stringify(r))
						}
					} catch (e) { /* ignore */ }
				}
				return _summaryOf(r)
			})
			uni.setStorageSync(listKey, JSON.stringify(slim))
		}
		return removed
	} catch (e) {
		reportError({ kind: 'report-clean-invalid', message: (e && (e.message || e.errMsg)) || '清理无效报告失败', stack: (e && e.stack) || '' })
		return 0
	}
}

/**
 * 获取最新报告（仅返回有效报告）
 * @returns {Object|null}
 */
export const getLatestReport = () => {
	// session 缓存：Tab 快速切换（onShow 密集触发）时避免重复读 storage + JSON.parse
	if (_latestCache && _latestCache.sessionRevision === getSessionCleanupRevision() && _latestCache.report && (Date.now() - _latestCache.ts) < CACHE_TTL_MS) {
		const cachedId = normalizeDecisionReportId(_latestCache.id)
		const cachedReport = validateStoredReportIdentity(_latestCache.report, cachedId)
		if (cachedReport) return cachedReport
		_latestCache = null
	}
	const list = getReportList()
	const valid = list.find(r => isValidReport(r))
	if (!valid) {
		_latestCache = null
		return null
	}
	let report
	if (valid.analysisData || valid.analysisResult) {
		report = _withStableAnalysisAnchor(valid)
	} else {
		report = valid.id ? getReport(valid.id) : null
		if (!report) report = valid
	}
	report = _withStableAnalysisAnchor(report)
	const latestId = normalizeDecisionReportId(report?.id) || normalizeDecisionReportId(valid.id)
	const validated = validateStoredReportIdentity(report, latestId)
	if (!validated) {
		_latestCache = null
		return null
	}
	_latestCache = { id: latestId, report: validated, ts: Date.now(), sessionRevision: getSessionCleanupRevision() }
	return validated
}

export const getLatestReportAsync = async (options = {}) => {
	const list = getReportList()
	const latest = list.find((report) => isValidReport(report))
	if (!latest || !latest.id) return null
	return getReportAsync(latest.id, options)
}

/**
 * 获取报告统计信息
 * @returns {Object}
 */
export const getReportStats = () => {
	const list = getReportList()

	if (list.length === 0) {
		return {
			totalCount:       0,
			latestScore:      null,
			daysSinceLast:    null,
			averageScore:     null,
			latestRiskLevel:  null,
			latestRiskTags:   [],
			latestAiSuggestion: ''
		}
	}

	// 修复：统一使用 isValidReport 过滤，与 getLatestReport 保持一致
	const validList = list.filter(r => isValidReport(r))
	if (validList.length === 0) {
		return {
			totalCount:       list.length,
			latestScore:      null,
			daysSinceLast:    null,
			averageScore:     null,
			latestRiskLevel:  null,
			latestRiskTags:   [],
			latestAiSuggestion: ''
		}
	}

	// 优先用列表摘要里预算好的字段；迁移前的旧项再回退到 analysisData
	const _score = (r) => (
		r._summary === true
			? (r._scoreDecisionEligible === true ? r._score : null)
			: _statScoreOf(r.analysisData)
	)
	const latestReport = validList[0]
	const scores = validList.map(_score).filter(s => s != null)
	const latestScore = _score(latestReport)
	const ad = latestReport.analysisData
	const latestNormalizedRisk = latestScore != null && ad
		? normalizeReportData(ad).riskLevel
		: null

	return {
		totalCount:    validList.length,
		latestScore:   latestScore != null ? latestScore : null,
		daysSinceLast: Math.floor(
			(new Date().getTime() - new Date(latestReport.createdAt).getTime()) / (1000 * 60 * 60 * 24)
		),
		averageScore:  scores.length > 0 ? Math.round(scores.reduce((sum, s) => sum + s, 0) / scores.length) : null,
		latestRiskLevel: latestScore != null
			? (latestReport._scoreDecisionEligible === true ? latestReport._riskLevel : latestNormalizedRisk)
			: null,
		latestRiskTags: Array.isArray(latestReport._riskTags) ? latestReport._riskTags : [],
		latestAiSuggestion: latestReport._aiSuggestion || ''
	}
}

/**
 * 清空所有报告
 * @returns {boolean}
 */
export const clearAllReports = () => {
	_invalidateLatestCache()
	_detailCache.clear()
	try {
		const list = getReportList()

		// 删除所有报告文件
		list.forEach(report => {
			const key = `report_${report.id}`
			uni.removeStorageSync(key)
		})

		// 清空列表
		uni.setStorageSync('report_list', JSON.stringify([]))
		_invalidateLatestCache() // 写后失效，清除上面 getReportList 回填的清空前列表

		return true
	} catch (e) {
		reportError({ kind: 'report-clear-all', message: (e && (e.message || e.errMsg)) || '清空报告失败', stack: (e && e.stack) || '' })
		return false
	}
}

export default {
	saveReport,
	saveReportDurable,
	getReport,
	getReportAsync,
	migrateLegacyReportBodiesToCloud,
	getReportList,
	deleteReport,
	getLatestReport,
	getLatestReportAsync,
	getReportStats,
	clearAllReports,
	isValidReport,
	cleanInvalidReports,
		cleanReportCustomerName,
		getReportCustomerName,
		getReportIdentityInfo,
		getReportMonth,
	validateReportArchivePolicy,
	normalizeReportData,
	syncReportToCloud,
	syncReportToServer,
	retryReportCloudSync,
	getCloudReportList,
	getCloudReportDetail,
	restoreCloudReportToLocal,
	getCloudReportStats,
	deleteCloudReport,
	unlinkCloudReportFromLocal
}
