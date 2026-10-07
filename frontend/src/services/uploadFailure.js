import {
	analysisDiagnosticHttpStatus,
	sanitizeAnalysisDiagnostic
} from './analysisFailureDiagnostic.js'
import { readTrustedAnalysisJobContext } from './analysisTerminalTrustBridge.js'
import { KNOWN_TERMINAL_CODES } from './analysisTerminalPolicy.js'

export { sanitizeAnalysisDiagnostic } from './analysisFailureDiagnostic.js'

const DEFAULT_TITLE = '分析未完成'
const DEFAULT_MESSAGE = '分析失败，请稍后重试'
const TRUSTED_TERMINAL_ERRORS = new WeakSet()
const PUBLIC_UPLOAD_ERROR_CODES = new Set([
	...KNOWN_TERMINAL_CODES,
	'ANALYSIS_JOB_FAILED', 'ANALYSIS_TASK_RESPONSE_MISMATCH',
	'ANALYZE_CONNECTION_INTERRUPTED', 'EMPTY_ANALYSIS_RESULT', 'EMPTY_FILE',
	'NO_FILE', 'NOT_PDF', 'OCR_OWNERSHIP_EVIDENCE_MISSING',
	'RAPIDOCR_OUTPUT_LIMIT', 'RAPIDOCR_PROCESS_ERROR', 'RAPIDOCR_TIMEOUT',
	'REPORT_CLOUD_PERSIST_FAILED', 'REPORT_LOCAL_PERSIST_FAILED',
	'REPORT_OWNER_POLICY', 'REQUEST_ABORTED', 'REQUEST_NETWORK_ERROR',
	'REQUEST_TIMEOUT', 'UPLOAD_ABORTED', 'UPLOAD_NETWORK_ERROR', 'UPLOAD_TIMEOUT'
])

const PUBLIC_ANALYSIS_ERROR_CLASSES = new Set([
	'upstream_transient',
	'transport_transient',
	'evidence_permanent',
	'schema_permanent',
	'input_permanent',
	'configuration_permanent',
	'internal_permanent',
	'unknown_permanent'
])

function rawMessage(error) {
	if (!error) return ''
	if (typeof error === 'string') return error
	return String(error.message || error.errMsg || error.msg || error.error || '')
}

function statusOf(error) {
	const n = Number(error && (error.statusCode ?? error.status ?? error.code))
	return Number.isFinite(n) ? n : null
}

function rawHttpStatusOf(error) {
	if (!error || error.transportKind !== 'http') return null
	const n = Number(error.httpStatus)
	return Number.isFinite(n) ? n : null
}

function businessCodeOf(error) {
	const raw = error && error.businessCode
	if (raw === undefined || raw === null || raw === '') return null
	const n = Number(raw)
	return Number.isFinite(n) ? n : null
}

function stableCodeOf(error) {
	const raw = String(
		(error && (error.backendCode || error.code || error.data?.payload?.errCode || error.data?.payload?.errorCode)) || ''
	).trim().toUpperCase()
	return PUBLIC_UPLOAD_ERROR_CODES.has(raw) ? raw : ''
}

function stableAnalysisJobId(value) {
	if (typeof value !== 'string') return ''
	const id = value.trim()
	return /^[A-Za-z0-9_-]{16,160}$/.test(id) ? id : ''
}

function buildFailure(category, title, message, advice, overrides = {}) {
	return {
		category,
		title,
		message,
		advice,
		actionLabel: '重新上传',
		canRetry: true,
		errorCode: '',
		reportKind: `upload-${category}`,
		...overrides
	}
}

export function createUploadError(code, message, extra = {}) {
	const err = new Error(message || DEFAULT_MESSAGE)
	err.code = code
	Object.assign(err, extra)
	return err
}

/**
 * 将服务端持久任务的终态失败转换为上传页统一错误协议。
 *
 * status 接口本身通常返回 HTTP 200；真正的分析失败状态只存在于
 * diagnostic.httpStatus，不能把缺失值伪造成 HTTP 500。
 */
export function createTerminalAnalysisFailure(terminal, analysisJobId = '') {
	const trustedContext = readTrustedAnalysisJobContext(terminal)
	if (!trustedContext) {
		throw createUploadError('ANALYSIS_TASK_RESPONSE_MISMATCH', '分析任务响应与请求任务不一致')
	}
	const row = trustedContext
	const rawCodeValue = row.errorCode ?? row.errCode
	if (rawCodeValue !== undefined && rawCodeValue !== null && typeof rawCodeValue !== 'string') {
		throw createUploadError('ANALYSIS_TASK_RESPONSE_MISMATCH', '分析任务响应与请求任务不一致')
	}
	const rawCode = typeof rawCodeValue === 'string' ? rawCodeValue.trim().toUpperCase() : ''
	const code = /^[A-Z][A-Z0-9_]{1,63}$/.test(rawCode) ? rawCode : 'ANALYSIS_JOB_FAILED'
	const expectedJobId = stableAnalysisJobId(analysisJobId)
	const responseJobIdValue = row.jobId ?? row.taskId ?? row.id
	const responseJobId = stableAnalysisJobId(responseJobIdValue)
	if (analysisJobId && !expectedJobId) {
		throw createUploadError('ANALYSIS_TASK_RESPONSE_MISMATCH', '分析任务响应与请求任务不一致')
	}
	if (responseJobIdValue && !responseJobId) {
		throw createUploadError('ANALYSIS_TASK_RESPONSE_MISMATCH', '分析任务响应与请求任务不一致')
	}
	if (expectedJobId && responseJobId && responseJobId !== expectedJobId) {
		throw createUploadError('ANALYSIS_TASK_RESPONSE_MISMATCH', '分析任务响应与请求任务不一致')
	}
	const supportRef = typeof row.supportRef === 'string' && /^sr_[A-Za-z0-9_-]{24}$/.test(row.supportRef)
		? row.supportRef
		: ''
	const serverTime = typeof row.serverTime === 'string' &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.serverTime) &&
		!Number.isNaN(Date.parse(row.serverTime)) &&
		new Date(row.serverTime).toISOString() === row.serverTime
		? row.serverTime
		: ''
	if (!supportRef || !serverTime) {
		throw createUploadError('ANALYSIS_TASK_RESPONSE_MISMATCH', '分析任务响应与请求任务不一致')
	}
	if (row.errorClass !== undefined && row.errorClass !== null && typeof row.errorClass !== 'string') {
		throw createUploadError('ANALYSIS_TASK_RESPONSE_MISMATCH', '分析任务响应与请求任务不一致')
	}
	if (row.failureStage !== undefined && row.failureStage !== null && typeof row.failureStage !== 'string') {
		throw createUploadError('ANALYSIS_TASK_RESPONSE_MISMATCH', '分析任务响应与请求任务不一致')
	}
	if (row.retryable !== undefined && row.retryable !== null && typeof row.retryable !== 'boolean') {
		throw createUploadError('ANALYSIS_TASK_RESPONSE_MISMATCH', '分析任务响应与请求任务不一致')
	}
	const error = createUploadError(code, '服务端分析任务未完成')
	error.backendCode = code
	error.terminalAnalysisFailure = true
	error.authoritativeAnalysisFailure = true
	error.analysisJobId = expectedJobId || responseJobId
	error.supportRef = supportRef
	error.serverTime = serverTime
	error.errorClass = typeof row.errorClass === 'string' && PUBLIC_ANALYSIS_ERROR_CLASSES.has(row.errorClass)
		? row.errorClass
		: null
	error.retryable = typeof row.retryable === 'boolean' ? row.retryable : null
	error.failureStage = typeof row.failureStage === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(row.failureStage)
		? row.failureStage
		: null
	error.safeMessageKey = typeof row.safeMessageKey === 'string' ? row.safeMessageKey : null
	error.diagnostic = sanitizeAnalysisDiagnostic(row.diagnostic)
	const statusCode = analysisDiagnosticHttpStatus(error.diagnostic)
	if (statusCode !== null) error.statusCode = statusCode
	TRUSTED_TERMINAL_ERRORS.add(error)
	return error
}

export function buildUploadTelemetryExtra({
	category = '',
	fileType = '',
	fileName = '',
	fileSize = 0,
	stage = '',
	error = null
} = {}) {
	const extensionMatch = String(fileName || '').toLowerCase().match(/\.([a-z0-9]{1,10})$/)
	const extra = {
		category,
		fileType,
		fileExtension: extensionMatch ? extensionMatch[1] : '',
		fileSize: Math.max(0, Number(fileSize) || 0),
		stage
	}
	const transportKind = String(error && error.transportKind || '')
	if (['http', 'timeout', 'abort', 'network'].includes(transportKind)) extra.transportKind = transportKind
	const httpStatus = rawHttpStatusOf(error)
	if (httpStatus !== null) extra.httpStatus = httpStatus
	const businessCode = businessCodeOf(error)
	if (businessCode !== null) extra.businessCode = businessCode
	const errorCode = stableCodeOf(error)
	if (errorCode) extra.errorCode = errorCode
	const causeCode = String(error && error.cloudCauseCode || '').trim().toUpperCase()
	if (PUBLIC_UPLOAD_ERROR_CODES.has(causeCode)) extra.causeCode = causeCode
	if (error && typeof error === 'object' && TRUSTED_TERMINAL_ERRORS.has(error)) {
		extra.clientSupportRef = error.supportRef
		extra.terminalServerTime = error.serverTime
	}
	return extra
}

export function validatePickedFile(file, fileType) {
	if (!file || !file.path) {
		throw createUploadError('NO_FILE', '未获取到文件路径，请重新选择')
	}
	if (file.size === 0) {
		throw createUploadError('EMPTY_FILE', '文件为空，无法解析')
	}
	if (fileType === 'pdf') {
		const visibleName = String(file.name || '').trim()
		if (visibleName && !/\.pdf$/i.test(visibleName)) {
			throw createUploadError('NOT_PDF', '所选文件不是 PDF，请选择信用中心导出的 PDF 文件')
		}
	}
}

function classifyUploadFailureBase(error, context = {}) {
	const message = rawMessage(error)
	const status = statusOf(error)
	const httpStatus = rawHttpStatusOf(error)
	const businessCode = businessCodeOf(error)
	const code = stableCodeOf(error)
	const stage = context.stage || ''

	// 服务端稳定错误码优先于可能冲突的自由文本。该码表示证据门禁永久拒绝，
	// 不能被“鉴权失败”“网关”等附带文案误归为可重试故障。
	if (code === 'EVIDENCE_PUBLICATION_BLOCKED') {
		return buildFailure(
			'evidence-blocked',
			'证据核验未通过',
			'报告关键证据未能完整核对，系统已停止发布评分。',
			'同一文件重复上传通常无法解决该问题。请记录发生时间和错误码，提交给运维进行证据门禁复核。',
			{
				actionLabel: '知道了',
				canRetry: false,
				errorCode: code,
				reportKind: 'upload-evidence-blocked'
			}
		)
	}

	if (code === 'NO_FILE') {
		return buildFailure('file-select', '未选择到文件', message || '未获取到文件路径，请重新选择', '请重新打开文件选择器，确认授权访问相册或文件。')
	}

	if (code === 'EMPTY_FILE' || /文件为空|文件过短|PDF 文件过短|base64数据为空/i.test(message)) {
		return buildFailure('file-empty', '文件内容为空', message || '文件为空，无法解析', '请重新导出完整信用报告，或改用清晰截图上传。')
	}

	if (code === 'NOT_PDF' || /不是标准 PDF|缺少 %PDF|不是 PDF|非 PDF/i.test(message)) {
		return buildFailure('file-format', '文件格式不支持', message || '所选文件不是标准 PDF', '请上传信用中心或银行导出的原始 PDF；如果只有图片，请选择“上传报告截图”。')
	}

	if (/仅支持本地临时文件|受信任域名|文件读取失败|readFile/i.test(message)) {
		return buildFailure('file-access', '无法读取文件', message || '无法读取所选文件', '请把文件保存到本机后重新选择，并确认应用拥有文件访问权限。')
	}

	if (status === 401 || /缺少分析凭证|鉴权失败|unauthorized|登录态|请先登录/i.test(message)) {
		const cleanMessage = /unauthorized|401|鉴权失败|登录态|登录状态|请先登录/i.test(message)
			? '当前登录状态已过期，请重新登录后再上传信用报告。'
			: (message || '当前登录状态已过期，请重新登录后再上传信用报告。')
		return buildFailure('auth', '登录状态已失效', cleanMessage, '重新登录后会直接走服务端大文件分析，不需要压缩 9MB 左右的 PDF。', {
			actionLabel: '重新登录',
			reportKind: 'upload-auth-fail'
		})
	}

	if (/分析服务未部署|缺少 \/api\/analyze|当前服务器未提供 PDF 文本抽取|parse-pdf|parse-pdf-upload/i.test(message)) {
		return buildFailure('service-missing', '分析服务未部署', message || '分析服务未部署', '请先发布 ai-proxy 分析接口，或临时改用截图上传路径验证 OCR 服务。', {
			actionLabel: '知道了',
			canRetry: false,
			reportKind: 'upload-service-missing'
		})
	}

	if (code === 'ANALYSIS_INPUT_TOO_LARGE' || code === 'ANALYSIS_CONTEXT_LIMIT') {
		return buildFailure(
			'analysis-input-limit',
			'报告超过完整分析上限',
			code === 'ANALYSIS_CONTEXT_LIMIT'
				? '报告超出模型可完整处理的上下文范围，本次已停止评分。'
				: '报告原文超过当前完整分析上限，本次已停止评分。',
			'原文件在当前配置下重复上传仍会失败。请联系运维提高完整分析上限或调整分段分析能力。',
			{
				actionLabel: '知道了',
				canRetry: false,
				errorCode: code,
				reportKind: 'upload-analysis-input-limit'
			}
		)
	}

	if ([
		'ANALYSIS_OUTPUT_TRUNCATED',
		'ANALYSIS_NON_JSON_OUTPUT',
		'FACT_SCHEMA_INVALID',
		'DETERMINISTIC_COVERAGE_MISSING',
		'DETERMINISTIC_FACTS_INCOMPLETE',
		'INCOMPLETE_CANONICAL_RESULT',
		'INVALID_CANONICAL_RESULT'
	].includes(code)) {
		return buildFailure(
			'analysis-output-incomplete',
			'模型分析结果不完整',
			'服务端没有得到可安全评分的完整结构化结果，本次已停止生成报告。',
			'请稍后重新上传；若重复出现，请把错误码和发生时间提供给运维检查模型输出与完整性门禁。',
			{ errorCode: code, reportKind: 'upload-analysis-output-incomplete' }
		)
	}

	if (code === 'QUERY_EVIDENCE_INCOMPLETE') {
		return buildFailure(
			'query-evidence-incomplete',
			'查询明细识别不完整',
			'服务端未能完整核对征信查询汇总与逐条明细，本次已停止评分。',
			'请重新上传原始 PDF；如重复出现，请把错误码和发生时间提供给运维检查分段查询提取。',
			{
				errorCode: code,
				reportKind: 'upload-query-evidence-incomplete'
			}
		)
	}

	if (code === 'ANALYSIS_IN_PROGRESS_TIMEOUT') {
		return buildFailure(
			'analysis-in-progress',
			'同一报告仍在分析',
			'服务端等待同一报告的分析任务超时，本次没有生成另一份结果。',
			'请稍后重新进入报告列表查看；如未生成结果，再重新上传。',
			{ errorCode: code, reportKind: 'upload-analysis-in-progress' }
		)
	}

	if ([
		'RAPIDOCR_CONFIG_ERROR',
		'RAPIDOCR_MODEL_INTEGRITY_ERROR',
		'RAPIDOCR_PROCESS_ERROR',
		'RAPIDOCR_DISABLED'
	].includes(code)) {
		const codeMessages = {
			RAPIDOCR_CONFIG_ERROR: '服务器 OCR 运行环境配置不完整，本次无法启动识别。',
			RAPIDOCR_MODEL_INTEGRITY_ERROR: '服务器 OCR 模型文件校验失败，本次无法安全识别。',
			RAPIDOCR_PROCESS_ERROR: '服务器 OCR 识别进程未能正常启动或意外退出。',
			RAPIDOCR_DISABLED: '服务器 OCR 识别能力当前未启用。'
		}
		return buildFailure(
			'ocr-runtime',
			'OCR 服务运行异常',
			codeMessages[code],
			'重复上传通常无法解决该问题，请联系运维检查 RapidOCR 的 Python、模型文件和进程日志。',
			{
				actionLabel: '知道了',
				canRetry: false,
				errorCode: code,
				reportKind: 'upload-ocr-runtime'
			}
		)
	}

	if ([
		'RAPIDOCR_TIMEOUT',
		'RAPIDOCR_QUEUE_TIMEOUT',
		'RAPIDOCR_OUTPUT_LIMIT',
		'RAPIDOCR_INVALID_RESULT'
	].includes(code)) {
		return buildFailure(
			'ocr-runtime-timeout',
			'OCR 处理未完成',
			'服务器 OCR 任务超时或没有返回有效的完整结果，本次已停止评分。',
			'请稍后重新上传；若重复出现，请联系运维检查 OCR 队列、超时和输出限制。',
			{ errorCode: code, reportKind: 'upload-ocr-runtime-timeout' }
		)
	}

	if (code === 'OCR_OWNERSHIP_EVIDENCE_MISSING') {
		return buildFailure(
			'ocr-incomplete',
			'报告归属信息识别不完整',
			'本次分析未能完整返回姓名和身份证识别结果，已停止保存。',
			'请重新上传原始 PDF；如再次出现，可改用清晰完整的报告截图，或联系管理员检查 OCR/分析服务。',
			{ errorCode: code, reportKind: 'upload-ocr-incomplete' }
		)
	}

	if (code === 'OCR_INCOMPLETE' || code === 'IMAGE_OCR_INCOMPLETE') {
		return buildFailure(
			'ocr-incomplete',
			'报告识别不完整',
			code === 'IMAGE_OCR_INCOMPLETE'
				? '部分报告图片没有识别成功，本次已停止评分。'
				: '扫描件存在未识别页面，本次已停止评分。',
			'请重新上传原始 PDF；如果是截图，请按报告页顺序选择全部页面并确保文字清晰。',
			{ errorCode: code, reportKind: 'upload-ocr-incomplete' }
		)
	}

	if (code === 'OCR_STRUCTURED_EVIDENCE_UNAVAILABLE' || code === 'PDF_EVIDENCE_SOURCE_UNVERIFIED') {
		const isOcr = code === 'OCR_STRUCTURED_EVIDENCE_UNAVAILABLE'
		return buildFailure(
			'ocr-evidence-unavailable',
			isOcr ? '扫描件暂不支持可信分析' : 'PDF 证据暂不可完整核验',
			isOcr
				? '系统无法把扫描文字中的每个字段可靠绑定到对应账户，已在模型调用前停止，本次未生成评分。'
				: '系统无法从该 PDF 形成完整的逐项证据，已在模型调用前停止，本次未生成评分。',
			'请上传征信中心下载、可复制文字的原始 PDF，不要上传截图、扫描件或二次打印文件。',
			{
				actionLabel: '重新选择原始 PDF',
				canRetry: false,
				errorCode: code,
				reportKind: 'upload-ocr-evidence-unavailable'
			}
		)
	}

	if ([
		'OCR_FAILED',
		'PDF_TEXT_LAYER_MISSING',
		'OCR_TEXT_TOO_SHORT',
		'IMAGE_TEXT_TOO_SHORT'
	].includes(code)) {
		return buildFailure(
			'ocr-failed',
			'报告文字识别失败',
			message && !/rapidocr|process|python|model/i.test(message)
				? message
				: '服务器没有取得足够且可信的报告文字，本次已停止评分。',
			'请上传征信中心下载、可复制文字的原始 PDF；截图和扫描件暂不能生成可信评分。',
			{ errorCode: code, reportKind: 'upload-ocr-failed' }
		)
	}

	if (/uploadFile:fail[^\n]*process error|分析进程.*中断|进程错误/i.test(message)) {
		return buildFailure(
			'analysis-connection',
			'分析连接意外中断',
			'报告已送达分析阶段，但连接在服务端返回完整结果前中断。',
			'请稍后重试；若总在81%附近中断，请让运维检查 OCR 进程、PM2 内存重启以及 Nginx 502/504 日志。',
			{ errorCode: code || 'ANALYZE_CONNECTION_INTERRUPTED', reportKind: 'upload-analysis-connection' }
		)
	}

	if (/识别失败|识别不完整|漏页|漏读|已停止分析|OCR|第\s*[\d、]+\s*(页|张|段)/i.test(message)) {
		return buildFailure('ocr-incomplete', '报告识别不完整', message || '报告有页面未识别成功，已停止分析', '请重新上传原始 PDF；如果是截图，请按报告页顺序选择全部页面，确保每页文字清晰完整。', {
			errorCode: code,
			reportKind: 'upload-ocr-incomplete'
		})
	}

	if (code === 'REPORT_OWNER_POLICY' || /当前手机号已绑定|不能上传其他人的征信|重复上传同月报告|未识别到征信报告姓名|未识别到征信报告身份证信息|未识别到征信报告月份|加盟商权限/i.test(message)) {
		return buildFailure('report-policy', '报告归属校验未通过', message || '当前账号不能继续上传该征信报告', '个人账号只能上传同一客户、不同月份的征信更新；如需批量上传，请让管理员在监测端开通加盟商权限。', {
			actionLabel: '知道了',
			canRetry: false,
			reportKind: 'upload-report-policy'
		})
	}

	const saveStage = stage === 'save' || ['REPORT_LOCAL_PERSIST_FAILED', 'REPORT_CLOUD_PERSIST_FAILED'].includes(code)
	if (saveStage) {
		const transportKind = String(error && error.transportKind || '')
		const cloudCauseCode = String(error && error.cloudCauseCode || '').trim().toUpperCase()
		const retrySave = { actionLabel: '重试保存', errorCode: code, reportKind: 'upload-save-fail' }
		if (httpStatus === 403 || status === 403) {
			return buildFailure('save', '报告保存权限受限', message || '当前账号没有保存该报告的权限', '请确认账号权限后重试保存；如权限刚由管理员调整，请重新登录后再试。', {
				...retrySave,
				reportKind: 'upload-save-permission'
			})
		}
		if (httpStatus === 409 || status === 409) {
			return buildFailure('save', '报告保存内容冲突', message || '同一分析任务对应的报告内容与云端记录不一致。', '无需重新上传或重新分析；请直接重试保存，若持续出现请联系运维检查同一任务的内容指纹。', {
				...retrySave,
				reportKind: 'upload-save-conflict'
			})
		}
		if (httpStatus === 413) {
			return buildFailure('save', '报告保存容量超限', '报告分析已完成，但完整报告数据超过了云端保存接口的接收上限。', '请让运维检查 /api/report/upload 的 JSON 请求体与网关上限；修复后可直接重试保存，无需重新分析。', {
				...retrySave,
				reportKind: 'upload-save-too-large'
			})
		}
		if (
			transportKind === 'abort' ||
			['REQUEST_ABORTED', 'UPLOAD_ABORTED'].includes(cloudCauseCode) ||
			error?.aborted === true
		) {
			return buildFailure('save', '保存连接已中断', '报告分析已完成，但本次云端保存请求被取消或中断。', '请直接重试保存；系统会复用已完成的分析结果。', {
				...retrySave,
				reportKind: 'upload-save-aborted'
			})
		}
		if (
			transportKind === 'timeout' ||
			['REQUEST_TIMEOUT', 'UPLOAD_TIMEOUT'].includes(cloudCauseCode) ||
			error?.timedOut === true
		) {
			return buildFailure('save', '报告保存超时', '报告分析已完成，但云端保存请求在规定时间内没有返回。', '请直接重试保存；若持续超时，请让运维检查 /api/report/upload 与网关超时。', {
				...retrySave,
				reportKind: 'upload-save-timeout'
			})
		}
		if (
			transportKind === 'network' ||
			cloudCauseCode === 'REQUEST_NETWORK_ERROR' ||
			error?.networkFailure === true
		) {
			return buildFailure('save', '保存连接中断', '报告分析已完成，但保存报告正文时网络连接中断。', '请确认网络恢复后直接重试保存，无需重新上传或重新分析。', {
				...retrySave,
				reportKind: 'upload-save-network'
			})
		}
		if ((httpStatus && httpStatus >= 500) || (status && status >= 500) || (businessCode !== null && businessCode >= 5000)) {
			return buildFailure('save', '报告保存服务异常', '报告分析已完成，但云端保存服务暂时未能完成写入。', '请稍后直接重试保存；若持续失败，请把发生时间提供给运维排查。', {
				...retrySave,
				reportKind: 'upload-save-server'
			})
		}
		if (code === 'REPORT_LOCAL_PERSIST_FAILED' || /setStorage|storage|存储空间/i.test(message)) {
			return buildFailure('save', '本地报告摘要保存失败', message || '报告已保存到云端，但本地摘要未能写入', '请释放设备存储空间后直接重试保存；系统不会重新分析报告。', {
				...retrySave,
				reportKind: 'upload-save-local'
			})
		}
		return buildFailure('save', '报告保存失败', message || '报告已分析但保存失败', '请直接重试保存；如持续失败，请联系运维检查云端报告存储服务。', retrySave)
	}

	if (httpStatus === 413) {
		return buildFailure('file-too-large', '上传上限过小', message || '文件超过当前上传上限', '大文件需要走直传解析。请把 Nginx client_max_body_size 调到 60m 以上，并确认 PDF_UPLOAD_MAX_MB 不低于 50；临时可压缩 PDF 或改用清晰截图上传。', {
			reportKind: 'upload-file-too-large'
		})
	}

	if (code === 'UPLOAD_ABORTED' || code === 'REQUEST_ABORTED' || error?.transportKind === 'abort' || error?.aborted === true || /\b(?:abort(?:ed)?|cancel(?:led)?)\b/i.test(message)) {
		return buildFailure('aborted', '连接中断', '本次上传连接已取消或中断，尚未取得完整分析结果。', '请确认网络稳定后重新选择报告上传。', {
			errorCode: code || 'UPLOAD_ABORTED',
			reportKind: 'upload-aborted'
		})
	}

	if (code === 'UPLOAD_TIMEOUT' || code === 'REQUEST_TIMEOUT' || error?.transportKind === 'timeout' || error?.timedOut === true || /超时|timeout|timed\s*out|timedout/i.test(message)) {
		return buildFailure('timeout', '分析超时', message || '上传分析超时', '请检查网络后重试；若一直超时，请让运维确认 ai-proxy 与网关超时配置不低于 900 秒。')
	}

	if (code === 'UPLOAD_NETWORK_ERROR' || code === 'REQUEST_NETWORK_ERROR' || error?.transportKind === 'network' || error?.networkFailure === true || /网络|request:fail|uploadFile:fail|ECONN|连接|合法域名|无法访问/i.test(message)) {
		return buildFailure('network', '连接中断', message || '上传连接已中断', '请确认浏览器网络、反向代理和 legacy-api 配置后重试。')
	}

	if (code === 'EMPTY_ANALYSIS_RESULT' || /分析结果为空|结果为空/i.test(message)) {
		return buildFailure('empty-result', '分析结果为空', message || '分析结果为空，请重试', '请确认报告完整清晰；如果重复出现，请记录文件类型并联系运维查看分析日志。')
	}

	if (error && (error.authoritativeAnalysisFailure === true || error.terminalAnalysisFailure === true)) {
		return buildFailure(
			'server',
			'服务端分析未完成',
			message || '服务端权威分析未完成',
			'本次已停止生成报告，没有切换到另一套算法。请稍后重新上传；若持续失败，请联系运维检查分析服务。',
			{ errorCode: code, reportKind: 'upload-authoritative-analysis-fail' }
		)
	}

	if ((status && status >= 500) || /HTTP 5\d\d|服务异常|网关|响应不是合法 JSON|服务器分析失败|DeepSeek|AI .*失败/i.test(message)) {
		return buildFailure('server', '分析服务异常', message || '分析服务异常，请稍后重试', '请稍后重试；若持续失败，请把错误时间、错误码和文件类型发给运维排查网关/AI 服务。', {
			errorCode: code
		})
	}

	const fallbackMessage = message || DEFAULT_MESSAGE
	return buildFailure('unknown', DEFAULT_TITLE, fallbackMessage, '请重新上传；若多次失败，请更换文件格式或联系顾问协助处理。')
}

export function classifyUploadFailure(error, context = {}) {
	const failure = classifyUploadFailureBase(error, context)
	const trustedTerminal = Boolean(
		error && typeof error === 'object' && TRUSTED_TERMINAL_ERRORS.has(error) &&
		error.terminalAnalysisFailure === true && error.authoritativeAnalysisFailure === true
	)
	const supportRef = trustedTerminal && typeof error.supportRef === 'string' && /^sr_[A-Za-z0-9_-]{24}$/.test(error.supportRef)
		? error.supportRef
		: ''
	const serverTime = trustedTerminal && typeof error.serverTime === 'string' &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(error.serverTime) &&
		!Number.isNaN(Date.parse(error.serverTime)) &&
		new Date(error.serverTime).toISOString() === error.serverTime
		? error.serverTime
		: ''
	return {
		...failure,
		...(supportRef ? { supportRef } : {}),
		...(serverTime ? { serverTime } : {})
	}
}

export default {
	classifyUploadFailure,
	createUploadError,
	validatePickedFile
}
