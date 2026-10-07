import { buildProxyApiUrl, getProxyBaseMisconfigReason } from '@/config/proxy.js'
import { resolveAuthToken } from './authService.js'
import { ANALYZE_UPLOAD_TIMEOUT, request } from './apiClient.js'
import { markServerAnalysisResponse } from './authoritativeAnalysis.js'
import {
	captureLocalSessionState,
	isLocalSessionStateCurrent
} from './sensitiveLocalState.js'
import { sanitizeAnalysisDiagnostic } from './analysisFailureDiagnostic.js'
import { installTrustedAnalysisJobReader } from './analysisTerminalTrustBridge.js'
import { validTerminalFailureEnvelope } from './analysisTerminalPolicy.js'

export const ACTIVE_ANALYSIS_TASK_KEY = 'currentTaskId'
const TRUSTED_SERVER_JOB_CONTEXTS = new WeakMap()

installTrustedAnalysisJobReader((value) => TRUSTED_SERVER_JOB_CONTEXTS.get(value) || null)

const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'expired'])

const asObject = (value) => (
	value && typeof value === 'object' && !Array.isArray(value) ? value : null
)

const parseStored = (value) => {
	if (value == null || value === '') return null
	if (typeof value === 'string') {
		try { return JSON.parse(value) } catch { return { jobId: value } }
	}
	return asObject(value)
}

const stableJobId = (value) => {
	if (typeof value !== 'string') return ''
	const id = value.trim()
	return /^[A-Za-z0-9_-]{16,160}$/.test(id) ? id : ''
}

const stableSupportRef = (value) => (
	typeof value === 'string' && /^sr_[A-Za-z0-9_-]{24}$/.test(value) ? value : ''
)

const canonicalIsoTime = (value) => {
	if (value === null || value === undefined || value === '') return null
	if (
		typeof value !== 'string' ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
		Number.isNaN(Date.parse(value)) ||
		new Date(value).toISOString() !== value
	) return null
	return value
}

const REPORT_FORMAT_SOURCES = new Set(['人行信用报告', '百行信用报告', '商业银行代查', '未知信用机构'])

const normalizedReportFormat = (value) => {
	const row = asObject(value)
	if (!row) return null
	const type = String(row.type || '').trim().toUpperCase()
	const source = String(row.source || '').trim()
	const version = String(row.version || '').trim()
	if (!['PDF', 'IMAGE'].includes(type) || !REPORT_FORMAT_SOURCES.has(source)) return null
	if (!version || version.length > 40 || !/^[A-Za-z0-9._-]+$/.test(version)) return null
	return { type, source, version }
}

const analysisTaskProtocolError = (message = '分析任务响应与请求任务不一致') => {
	const error = new Error(message)
	error.code = 'ANALYSIS_TASK_RESPONSE_MISMATCH'
	error.backendCode = error.code
	return error
}

const PUBLIC_ERROR_CLASSES = new Set([
	'upstream_transient',
	'transport_transient',
	'evidence_permanent',
	'schema_permanent',
	'input_permanent',
	'configuration_permanent',
	'internal_permanent',
	'unknown_permanent'
])

const responseJob = (value, expectedJobId = '', expectedSupportRef = '') => {
	const row = asObject(value) || {}
	const providedIds = ['jobId', 'taskId', 'id']
		.filter((key) => Object.prototype.hasOwnProperty.call(row, key) && row[key] !== null && row[key] !== '')
		.map((key) => stableJobId(row[key]))
	if (!providedIds.length || providedIds.some((id) => !id) || new Set(providedIds).size !== 1) {
		throw analysisTaskProtocolError('分析任务响应缺少有效任务 ID')
	}
	const jobId = providedIds[0]
	if (!jobId) throw analysisTaskProtocolError('分析任务响应缺少有效任务 ID')
	const expected = stableJobId(expectedJobId)
	if (expectedJobId && !expected) throw new Error('分析任务 ID 无效')
	if (expected && jobId !== expected) throw analysisTaskProtocolError()
	const supportRef = stableSupportRef(row.supportRef)
	if (!supportRef) throw analysisTaskProtocolError('分析任务响应缺少有效支持编号')
	const expectedRef = stableSupportRef(expectedSupportRef)
	if (expectedSupportRef && !expectedRef) throw analysisTaskProtocolError('分析任务支持编号无效')
	if (expectedRef && supportRef !== expectedRef) throw analysisTaskProtocolError('分析任务支持编号与请求不一致')
	if (typeof row.status !== 'string' || !['queued', 'processing', 'succeeded', 'failed'].includes(row.status)) {
		throw analysisTaskProtocolError('分析任务状态无效')
	}
	if (typeof row.stage !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(row.stage)) {
		throw analysisTaskProtocolError('分析任务阶段无效')
	}
	if (typeof row.progress !== 'number' || !Number.isFinite(row.progress)) {
		throw analysisTaskProtocolError('分析任务进度无效')
	}
	const status = row.status
	const serverTime = canonicalIsoTime(row.serverTime)
	if (['succeeded', 'failed'].includes(status) && !serverTime) {
		throw analysisTaskProtocolError('分析任务终态缺少有效服务端时间')
	}
	const errorCode = status === 'failed' && typeof row.errorCode === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(row.errorCode)
		? row.errorCode
		: null
	const errorClass = status === 'failed' && typeof row.errorClass === 'string' && PUBLIC_ERROR_CLASSES.has(row.errorClass)
		? row.errorClass
		: null
	const failureStage = status === 'failed' && typeof row.failureStage === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(row.failureStage)
		? row.failureStage
		: null
	const safeMessageKey = status === 'failed' && typeof row.safeMessageKey === 'string'
		? row.safeMessageKey
		: null
	if (status === 'failed' && !validTerminalFailureEnvelope({
		code: errorCode,
		errorClass,
		stage: failureStage,
		retryable: row.retryable,
		safeMessageKey
	})) {
		throw analysisTaskProtocolError('分析任务失败终态不完整')
	}
	const projected = {
		jobId,
		supportRef,
		status,
		stage: row.stage,
		progress: Math.max(0, Math.min(100, row.progress)),
		resultReady: status === 'succeeded',
		errorCode,
		errorClass,
		failureStage,
		safeMessageKey,
		diagnostic: status === 'failed' ? sanitizeAnalysisDiagnostic(row.diagnostic) : null,
		retryable: status === 'failed' ? row.retryable : false,
		attemptCount: typeof row.attemptCount === 'number' && Number.isInteger(row.attemptCount) && row.attemptCount >= 0
			? row.attemptCount
			: 0,
		createdAt: canonicalIsoTime(row.createdAt),
		updatedAt: canonicalIsoTime(row.updatedAt),
		finishedAt: canonicalIsoTime(row.finishedAt),
		serverTime,
		...(typeof row.cacheHit === 'boolean' ? { cacheHit: row.cacheHit } : {}),
		...(typeof row.reused === 'boolean' ? { reused: row.reused } : {}),
		supportRefTrusted: true
	}
	if (['succeeded', 'failed'].includes(status)) {
		TRUSTED_SERVER_JOB_CONTEXTS.set(projected, Object.freeze({
			jobId,
			supportRef,
			status,
			errorCode,
			errorClass,
			failureStage,
			safeMessageKey,
			diagnostic: projected.diagnostic,
			retryable: projected.retryable,
			serverTime
		}))
	}
	return projected
}

const uploadResponse = (res) => {
	const httpStatus = Number(res && res.statusCode) || 0
	let payload = res && res.data
	if (typeof payload === 'string') {
		try { payload = JSON.parse(payload) } catch {
			const error = new Error(`分析任务服务响应不是合法 JSON（HTTP ${httpStatus || '?'}）`)
			error.httpStatus = httpStatus
			error.statusCode = httpStatus
			error.transportKind = 'http'
			throw error
		}
	}
	const ok = httpStatus >= 200 && httpStatus < 300 && payload && Number(payload.code) === 0
	if (!ok) {
		const error = new Error(String(payload && (payload.msg || payload.message || payload.errMsg) || '创建分析任务失败'))
		error.httpStatus = httpStatus
		error.statusCode = httpStatus
		error.transportKind = 'http'
		error.code = payload && (payload.errCode || payload.code)
		error.backendCode = payload && payload.errCode
		throw error
	}
	return responseJob(payload.data || payload)
}

/**
 * 创建持久异步分析任务。返回值是 Promise；上传字节进度来自 XHR upload progress，
 * 服务端分析进度随后由 status 接口提供，二者不会按时间伪造。
 */
export const createAnalysisJob = (fileInput, options = {}) => {
	const cfgError = getProxyBaseMisconfigReason()
	if (cfgError) return Promise.reject(new Error(cfgError))
	const token = resolveAuthToken()
	if (!token) return Promise.reject(new Error('缺少分析凭证：请先登录后再上传信用报告'))
	const session = captureLocalSessionState()
	const isBlob = fileInput && typeof Blob !== 'undefined' && fileInput instanceof Blob

	return new Promise((resolve, reject) => {
		let settled = false
		let task = null
		let abortListener = null
		const finish = (fn, value) => {
			if (settled) return
			settled = true
			if (abortListener && options.signal && typeof options.signal.removeEventListener === 'function') {
				options.signal.removeEventListener('abort', abortListener)
			}
			fn(value)
		}
		task = uni.uploadFile({
			url: buildProxyApiUrl('/api/analysis/jobs'),
			name: 'file',
			...(isBlob ? { file: fileInput } : { filePath: fileInput }),
			header: { Authorization: `Bearer ${token}` },
			timeout: Number(options.uploadTimeout) > 0
				? Number(options.uploadTimeout)
				: ANALYZE_UPLOAD_TIMEOUT,
			success: (res) => {
				try {
					if (!isLocalSessionStateCurrent(session)) {
						const stale = new Error('登录账号已切换，已忽略旧账号的分析任务响应')
						stale.code = 'STALE_SESSION_RESPONSE'
						throw stale
					}
					finish(resolve, uploadResponse(res))
				} catch (error) {
					finish(reject, error)
				}
			},
			fail: (rawError) => {
				const raw = String(rawError && (rawError.errMsg || rawError.message) || '上传连接中断')
				const error = rawError instanceof Error ? rawError : new Error(raw)
				error.httpStatus = Number(rawError && rawError.httpStatus) || 0
				error.transportKind = /abort|cancel/i.test(raw)
					? 'abort'
					: /timeout|timed\s*out/i.test(raw)
						? 'timeout'
						: 'network'
				error.code = String(rawError && rawError.code || (
					error.transportKind === 'abort'
						? 'UPLOAD_ABORTED'
						: error.transportKind === 'timeout'
							? 'UPLOAD_TIMEOUT'
							: 'UPLOAD_NETWORK_ERROR'
				))
				error.aborted = error.transportKind === 'abort'
				finish(reject, error)
			}
		})
		if (options.signal && typeof options.signal.addEventListener === 'function') {
			abortListener = () => {
				try { task?.abort?.() } catch (_) {}
			}
			if (options.signal.aborted) abortListener()
			else options.signal.addEventListener('abort', abortListener, { once: true })
		}
		if (task && typeof task.onProgressUpdate === 'function' && typeof options.onUploadProgress === 'function') {
			task.onProgressUpdate((event = {}) => {
				const progress = Number(event.progress)
				if (Number.isFinite(progress)) options.onUploadProgress(Math.max(0, Math.min(100, progress)), event)
			})
		}
		if (typeof options.onUploadTask === 'function') options.onUploadTask(task)
	})
}

export const getAnalysisJobStatus = async (jobId, expectedSupportRef = '') => {
	const id = stableJobId(jobId)
	if (!id) throw new Error('分析任务 ID 无效')
	return responseJob(await request({
		url: `/api/analysis/jobs/${encodeURIComponent(id)}`,
		method: 'GET'
	}), id, expectedSupportRef)
}

export const getLatestAnalysisJob = async () => {
	try {
		const value = await request({ url: '/api/analysis/jobs/latest', method: 'GET' })
		return value ? responseJob(value) : null
	} catch (error) {
		if (Number(error && error.statusCode) === 404 || Number(error && error.code) === 2001) return null
		throw error
	}
}

export const getAnalysisJobResult = async (jobId, expectedSupportRef = '') => {
	const id = stableJobId(jobId)
	if (!id) throw new Error('分析任务 ID 无效')
	const payload = await request({
		url: `/api/analysis/jobs/${encodeURIComponent(id)}/result`,
		method: 'GET',
		timeout: 65000
	})
	const row = asObject(payload)
	if (!row || !row.job) throw analysisTaskProtocolError('分析结果响应缺少任务绑定')
	const job = responseJob(row.job, id, expectedSupportRef)
	return markServerAnalysisResponse({
		result: row.result,
		analysis: asObject(row.analysis),
		job
	})
}

export const acknowledgeAnalysisJob = async (jobId, expectedSupportRef = '') => {
	const id = stableJobId(jobId)
	if (!id) return false
	const response = await request({
		url: `/api/analysis/jobs/${encodeURIComponent(id)}/ack`,
		method: 'POST',
		data: {}
	})
	const row = asObject(response)
	const responseIdValue = row && (row.jobId || row.taskId || row.id)
	if (responseIdValue !== undefined && responseIdValue !== null && responseIdValue !== '') {
		const responseId = stableJobId(responseIdValue)
		if (!responseId || responseId !== id) throw analysisTaskProtocolError('分析任务确认响应与请求任务不一致')
	}
	const supportRef = stableSupportRef(row && row.supportRef)
	const expectedRef = stableSupportRef(expectedSupportRef)
	if (!supportRef || (expectedSupportRef && !expectedRef) || (expectedRef && supportRef !== expectedRef)) {
		throw analysisTaskProtocolError('分析任务确认响应的支持编号不一致')
	}
	if (!canonicalIsoTime(row && row.serverTime)) {
		throw analysisTaskProtocolError('分析任务确认响应缺少服务端时间')
	}
	return true
}

export const saveActiveAnalysisTask = (task) => {
	const normalized = responseJob(task)
	const reportFormat = normalizedReportFormat(task?.reportFormat)
	const stored = {
		jobId: normalized.jobId,
		supportRef: normalized.supportRef,
		status: normalized.status,
		stage: normalized.stage,
		progress: normalized.progress,
		...(typeof task?.cacheHit === 'boolean' ? { cacheHit: task.cacheHit } : {}),
		...(typeof task?.reused === 'boolean' ? { reused: task.reused } : {}),
		fileType: String(task && task.fileType || 'pdf'),
		fileName: String(task && task.fileName || '信用报告.pdf').slice(0, 180),
		...(reportFormat ? { reportFormat } : {}),
		startedAt: String(task && task.startedAt || new Date().toISOString())
	}
	uni.setStorageSync(ACTIVE_ANALYSIS_TASK_KEY, JSON.stringify(stored))
	const verified = parseStored(uni.getStorageSync(ACTIVE_ANALYSIS_TASK_KEY))
	if (!verified || stableJobId(verified.jobId) !== stored.jobId) {
		const error = new Error('分析任务恢复信息写入后校验失败')
		error.code = 'ANALYSIS_TASK_LOCAL_PERSIST_FAILED'
		throw error
	}
	return stored
}

export const loadActiveAnalysisTask = () => {
	const row = parseStored(uni.getStorageSync(ACTIVE_ANALYSIS_TASK_KEY))
	if (!row) return null
	const providedIds = ['jobId', 'taskId', 'id']
		.filter((key) => Object.prototype.hasOwnProperty.call(row, key) && row[key] !== null && row[key] !== '')
		.map((key) => stableJobId(row[key]))
	if (!providedIds.length || providedIds.some((id) => !id) || new Set(providedIds).size !== 1) return null
	const jobId = providedIds[0]
	const supportRef = stableSupportRef(row.supportRef)
	const reportFormat = normalizedReportFormat(row.reportFormat)
	return {
		jobId,
		supportRef,
		supportRefTrusted: false,
		status: typeof row.status === 'string' ? row.status : 'queued',
		stage: typeof row.stage === 'string' ? row.stage : 'queued',
		progress: typeof row.progress === 'number' && Number.isFinite(row.progress)
			? Math.max(0, Math.min(100, row.progress))
			: 0,
		...(typeof row.cacheHit === 'boolean' ? { cacheHit: row.cacheHit } : {}),
		...(typeof row.reused === 'boolean' ? { reused: row.reused } : {}),
		fileType: ['pdf', 'image'].includes(row.fileType) ? row.fileType : 'pdf',
		fileName: typeof row.fileName === 'string' ? row.fileName.slice(0, 180) : '信用报告.pdf',
		startedAt: canonicalIsoTime(row.startedAt),
		...(reportFormat ? { reportFormat } : {})
	}
}

export const clearActiveAnalysisTask = (expectedJobId = '') => {
	const current = loadActiveAnalysisTask()
	if (expectedJobId && current && current.jobId !== stableJobId(expectedJobId)) return false
	uni.removeStorageSync(ACTIVE_ANALYSIS_TASK_KEY)
	return !loadActiveAnalysisTask()
}

export const waitForAnalysisJob = async (jobId, options = {}) => {
	const id = stableJobId(jobId)
	if (!id) throw new Error('分析任务 ID 无效')
	const intervalMs = Math.max(600, Math.min(10000, Number(options.intervalMs) || 1800))
	let boundSupportRef = stableSupportRef(options.supportRef)
	for (;;) {
		if (options.signal && options.signal.aborted) {
			const error = new Error('分析状态查询已取消')
			error.code = 'ANALYSIS_POLL_ABORTED'
			throw error
		}
		const status = await getAnalysisJobStatus(id, boundSupportRef)
		if (!boundSupportRef) boundSupportRef = status.supportRef
		if (typeof options.onStatus === 'function') options.onStatus(status)
		if (TERMINAL_STATES.has(status.status)) return status
		await new Promise((resolve) => setTimeout(resolve, intervalMs))
	}
}

export const isTerminalAnalysisJob = (status) => TERMINAL_STATES.has(String(status || '').toLowerCase())
