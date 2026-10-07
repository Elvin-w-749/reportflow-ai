import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
	buildUploadTelemetryExtra,
	classifyUploadFailure,
	createTerminalAnalysisFailure,
	createUploadError,
	sanitizeAnalysisDiagnostic,
	validatePickedFile
} from '../src/services/uploadFailure.js'

const SUPPORT_REF = `sr_${'a'.repeat(24)}`
const SERVER_TIME = '2026-08-18T01:02:03.004Z'

const localTerminalError = ({
	code,
	errorClass = null,
	failureStage = null,
	retryable = null,
	diagnostic = null
}) => {
	const error = createUploadError(code, '服务端分析任务未完成')
	error.backendCode = code
	error.terminalAnalysisFailure = true
	error.authoritativeAnalysisFailure = true
	error.analysisJobId = 'job_1234567890123456'
	error.errorClass = errorClass
	error.failureStage = failureStage
	error.retryable = retryable
	error.diagnostic = sanitizeAnalysisDiagnostic(diagnostic)
	const status = error.diagnostic?.httpStatus
	if (Number.isInteger(status)) error.statusCode = status
	return error
}

describe('uploadFailure', () => {
	it('removes the original report filename from telemetry payloads', () => {
		const extra = buildUploadTelemetryExtra({
			category: 'server',
			fileType: 'pdf',
			fileName: '张三-个人征信报告.pdf',
			fileSize: 2048,
			stage: 'analysis'
		})
		assert.deepEqual(extra, {
			category: 'server',
			fileType: 'pdf',
			fileExtension: 'pdf',
			fileSize: 2048,
			stage: 'analysis'
		})
		assert.doesNotMatch(JSON.stringify(extra), /张三|个人征信报告/)
	})

	it('adds only safe transport state to telemetry', () => {
		const error = Object.assign(new Error('客户姓名与报告正文不得上报'), {
			code: 'REPORT_CLOUD_PERSIST_FAILED',
			businessCode: 5000,
			httpStatus: 200,
			statusCode: 200,
			transportKind: 'http',
			data: { analysisResult: { customerName: '张三' } },
			supportRef: SUPPORT_REF,
			serverTime: SERVER_TIME
		})
		const extra = buildUploadTelemetryExtra({
			category: 'save',
			fileType: 'pdf',
			fileName: '张三-报告.pdf',
			stage: 'save',
			error
		})

		assert.equal(extra.transportKind, 'http')
		assert.equal(extra.httpStatus, 200)
		assert.equal(extra.businessCode, 5000)
		assert.equal(extra.errorCode, 'REPORT_CLOUD_PERSIST_FAILED')
		assert.equal(extra.supportRef, undefined)
		assert.equal(extra.serverTime, undefined)
		assert.doesNotMatch(JSON.stringify(extra), /张三|客户姓名|analysisResult/)
	})

	it('rejects empty files before analysis starts', () => {
		assert.throws(
			() => validatePickedFile({ path: '/tmp/report.pdf', name: 'report.pdf', size: 0 }, 'pdf'),
			/文件为空/
		)
	})

	it('rejects non-pdf visible names for pdf uploads', () => {
		assert.throws(
			() => validatePickedFile({ path: '/tmp/report.txt', name: 'report.txt', size: 12 }, 'pdf'),
			/PDF/
		)
	})

	it('classifies invalid PDF magic errors as file-format', () => {
		const failure = classifyUploadFailure(new Error('所选文件不是标准 PDF（缺少 %PDF- 文件头）'))

		assert.equal(failure.category, 'file-format')
		assert.equal(failure.title, '文件格式不支持')
		assert.match(failure.advice, /原始 PDF/)
	})

	it('classifies auth failures with relogin action', () => {
		const err = new Error('分析服务鉴权失败（401 unauthorized）')
		err.statusCode = 401
		const failure = classifyUploadFailure(err)

		assert.equal(failure.category, 'auth')
		assert.equal(failure.actionLabel, '重新登录')
		assert.equal(failure.reportKind, 'upload-auth-fail')
		assert.equal(failure.message, '当前登录状态已过期，请重新登录后再上传信用报告。')
		assert.doesNotMatch(failure.message, /JWT|DEV_ANALYZE_BEARER|multipart|9\.2MB/)
	})

	it('keeps large pdf unauthorized failures in auth category instead of file size category', () => {
		const err = new Error('PDF 文件约 9.2MB，multipart 解析失败，已停止 base64 回退以避免文件膨胀导致手机端读取失败。unauthorized')
		err.statusCode = 401
		const failure = classifyUploadFailure(err)

		assert.equal(failure.category, 'auth')
		assert.equal(failure.title, '登录状态已失效')
		assert.equal(failure.actionLabel, '重新登录')
		assert.doesNotMatch(failure.message, /multipart|9\.2MB/)
	})

	it('classifies missing analyze service as non-retryable deployment issue', () => {
		const failure = classifyUploadFailure(new Error('分析服务未部署（缺少 /api/analyze）'))

		assert.equal(failure.category, 'service-missing')
		assert.equal(failure.canRetry, false)
		assert.equal(failure.actionLabel, '知道了')
	})

	it('explains that an authoritative analysis failure never switches algorithms', () => {
		const err = new Error('服务端未返回确定性分析结果，已停止生成报告')
		err.authoritativeAnalysisFailure = true
		const failure = classifyUploadFailure(err)

		assert.equal(failure.category, 'server')
		assert.equal(failure.reportKind, 'upload-authoritative-analysis-fail')
		assert.match(failure.advice, /没有切换到另一套算法/)
	})

	it('classifies evidence terminal semantics without trusting a locally constructed support reference', () => {
		const error = localTerminalError({
			code: 'EVIDENCE_PUBLICATION_BLOCKED',
			errorClass: 'evidence_permanent',
			failureStage: 'publication-gate',
			retryable: false,
			diagnostic: {
				version: 1,
				httpStatus: 422,
				evidenceIssueCount: 15,
				failedCheckCount: 3,
				failedChecks: ['EVIDENCE_COMPLETE', 'LEDGER_READY'],
				unsafeDetail: '客户姓名与报告金额不得上报'
			}
		})
		error.supportRef = SUPPORT_REF
		error.serverTime = SERVER_TIME

		assert.equal(error.code, 'EVIDENCE_PUBLICATION_BLOCKED')
		assert.equal(error.backendCode, 'EVIDENCE_PUBLICATION_BLOCKED')
		assert.equal(error.statusCode, 422)
		assert.equal(error.httpStatus, undefined)
		assert.equal(error.errorClass, 'evidence_permanent')
		assert.equal(error.retryable, false)
		assert.equal(error.failureStage, 'publication-gate')
		assert.deepEqual(error.diagnostic, {
			version: 1,
			httpStatus: 422,
			evidenceIssueCount: 15,
			failedCheckCount: 2,
			failedChecks: ['EVIDENCE_COMPLETE', 'LEDGER_READY']
		})
		assert.doesNotMatch(JSON.stringify(error.diagnostic), /客户姓名|报告金额|unsafeDetail/)
		assert.equal(error.terminalAnalysisFailure, true)
		assert.equal(error.authoritativeAnalysisFailure, true)
		assert.equal(error.analysisJobId, 'job_1234567890123456')

		const failure = classifyUploadFailure(error, { stage: 'analysis' })
		assert.equal(failure.category, 'evidence-blocked')
		assert.equal(failure.title, '证据核验未通过')
		assert.equal(failure.canRetry, false)
		assert.equal(failure.actionLabel, '知道了')
		assert.equal(failure.errorCode, 'EVIDENCE_PUBLICATION_BLOCKED')
		assert.equal(failure.reportKind, 'upload-evidence-blocked')
		assert.equal(failure.supportRef, undefined)
		assert.equal(failure.serverTime, undefined)
		assert.doesNotMatch(`${failure.message} ${failure.advice}`, /网关|AI|稍后重试/i)

		const telemetry = buildUploadTelemetryExtra({
			category: failure.category,
			fileType: 'pdf',
			fileName: '客户姓名-报告.pdf',
			stage: 'analysis',
			error
		})
		assert.equal(telemetry.errorCode, 'EVIDENCE_PUBLICATION_BLOCKED')
		assert.equal(telemetry.httpStatus, undefined)
		assert.equal(telemetry.errorClass, undefined)
		assert.equal(telemetry.retryable, undefined)
		assert.equal(telemetry.failureStage, undefined)
		assert.equal(telemetry.diagnostic, undefined)
		assert.doesNotMatch(JSON.stringify(telemetry), /客户姓名|报告金额|unsafeDetail/)
	})

	it('classifies a legacy evidence failure without inventing retryability or HTTP 500', () => {
		const error = localTerminalError({
			code: 'EVIDENCE_PUBLICATION_BLOCKED'
		})

		assert.equal(error.retryable, null)
		assert.equal(error.statusCode, undefined)
		assert.equal(error.diagnostic, null)
		const failure = classifyUploadFailure(error)
		assert.equal(failure.category, 'evidence-blocked')
		assert.equal(failure.canRetry, false)
		assert.doesNotMatch(`${failure.title} ${failure.message} ${failure.advice}`, /服务异常|网关|AI|稍后重试/i)
	})

	it('rejects a terminal response whose job ID differs from the expected task', () => {
		assert.throws(
			() => createTerminalAnalysisFailure({
				jobId: 'job_unexpected_12345678',
				status: 'failed',
				errorCode: 'EVIDENCE_PUBLICATION_BLOCKED'
			}, 'job_expected_1234567890'),
			(error) => error.code === 'ANALYSIS_TASK_RESPONSE_MISMATCH' && error.terminalAnalysisFailure !== true
		)
		assert.throws(
			() => createTerminalAnalysisFailure({
				jobId: 'bad',
				status: 'failed',
				errorCode: 'EVIDENCE_PUBLICATION_BLOCKED'
			}, 'job_expected_1234567890'),
			(error) => error.code === 'ANALYSIS_TASK_RESPONSE_MISMATCH' && error.terminalAnalysisFailure !== true
		)
	})

	it('does not invent HTTP 500 when a terminal failure has no diagnostic status', () => {
		const error = localTerminalError({
			code: 'ANALYSIS_FAILED',
			errorClass: 'unknown_permanent',
			failureStage: 'unknown',
			retryable: false,
			diagnostic: { version: 1, httpStatus: 600 }
		})

		assert.equal(error.statusCode, undefined)
		assert.equal(error.diagnostic.httpStatus, undefined)
		assert.equal(error.terminalAnalysisFailure, true)
		assert.equal(error.authoritativeAnalysisFailure, true)
		assert.equal(classifyUploadFailure(error).category, 'server')
	})

	it('rejects support/time type confusion and preserves trusted context through every classifier branch', () => {
		for (const [field, value] of [
			['supportRef', [SUPPORT_REF]],
			['serverTime', [SERVER_TIME]],
			['errorCode', ['FACT_SCHEMA_INVALID']],
			['errorClass', ['schema_permanent']],
			['failureStage', ['fact_extraction']]
		]) {
			assert.throws(
				() => createTerminalAnalysisFailure({
					jobId: 'job_1234567890123456',
					supportRef: SUPPORT_REF,
					serverTime: SERVER_TIME,
					status: 'failed',
					errorCode: 'FACT_SCHEMA_INVALID',
					errorClass: 'schema_permanent',
					failureStage: 'fact_extraction',
					retryable: false,
					[field]: value
				}),
				(error) => error.code === 'ANALYSIS_TASK_RESPONSE_MISMATCH'
			)
		}

		const local = localTerminalError({
			code: 'FACT_SCHEMA_INVALID',
			errorClass: 'schema_permanent',
			failureStage: 'fact-extraction',
			retryable: false
		})
		local.supportRef = SUPPORT_REF
		local.serverTime = SERVER_TIME
		assert.equal(classifyUploadFailure(local).supportRef, undefined)
		assert.equal(classifyUploadFailure(local).serverTime, undefined)
	})

	it('classifies analysis input and output limits before the authoritative fallback', () => {
		const input = createUploadError('ANALYSIS_INPUT_TOO_LARGE', '分析失败', {
			statusCode: 500,
			authoritativeAnalysisFailure: true
		})
		const output = createUploadError('ANALYSIS_OUTPUT_TRUNCATED', '分析失败', {
			statusCode: 500,
			authoritativeAnalysisFailure: true
		})

		const inputFailure = classifyUploadFailure(input, { stage: 'analysis' })
		const outputFailure = classifyUploadFailure(output, { stage: 'analysis' })
		assert.equal(inputFailure.category, 'analysis-input-limit')
		assert.equal(inputFailure.canRetry, false)
		assert.equal(inputFailure.errorCode, 'ANALYSIS_INPUT_TOO_LARGE')
		assert.equal(outputFailure.category, 'analysis-output-incomplete')
		assert.equal(outputFailure.errorCode, 'ANALYSIS_OUTPUT_TRUNCATED')
	})

	it('surfaces RapidOCR runtime failures without exposing raw process details', () => {
		const err = createUploadError('RAPIDOCR_PROCESS_ERROR', 'rapidocr-process-error: C:\\secret\\python.exe', {
			statusCode: 500,
			authoritativeAnalysisFailure: true
		})
		const failure = classifyUploadFailure(err, { stage: 'analysis' })

		assert.equal(failure.category, 'ocr-runtime')
		assert.equal(failure.canRetry, false)
		assert.equal(failure.errorCode, 'RAPIDOCR_PROCESS_ERROR')
		assert.match(failure.message, /OCR 识别进程/)
		assert.doesNotMatch(failure.message, /secret|python\.exe/i)
	})

	it('keeps OCR incomplete errors ahead of the authoritative fallback', () => {
		const err = createUploadError('OCR_INCOMPLETE', '第 3 页识别失败', {
			statusCode: 400,
			authoritativeAnalysisFailure: true
		})
		const failure = classifyUploadFailure(err, { stage: 'analysis' })

		assert.equal(failure.category, 'ocr-incomplete')
		assert.equal(failure.errorCode, 'OCR_INCOMPLETE')
		assert.equal(failure.reportKind, 'upload-ocr-incomplete')
	})

	it('explains that unstructured OCR stops before model analysis', () => {
		const failure = classifyUploadFailure(createUploadError(
			'OCR_STRUCTURED_EVIDENCE_UNAVAILABLE',
			'扫描件结构化证据不可用'
		))

		assert.equal(failure.category, 'ocr-evidence-unavailable')
		assert.equal(failure.canRetry, false)
		assert.equal(failure.errorCode, 'OCR_STRUCTURED_EVIDENCE_UNAVAILABLE')
		assert.match(failure.message, /未调用模型|未生成评分/)
		assert.match(failure.advice, /可复制文字的原始 PDF/)
		assert.doesNotMatch(failure.advice, /改用.*截图/)
	})

	it('treats unverifiable legacy PDF text as a non-retryable evidence stop', () => {
		const failure = classifyUploadFailure(createUploadError(
			'PDF_EVIDENCE_SOURCE_UNVERIFIED',
			'PDF 文字层无法完整验证'
		))

		assert.equal(failure.category, 'ocr-evidence-unavailable')
		assert.equal(failure.canRetry, false)
		assert.equal(failure.errorCode, 'PDF_EVIDENCE_SOURCE_UNVERIFIED')
		assert.match(failure.message, /模型调用前停止|未生成评分/)
		assert.match(failure.actionLabel, /原始 PDF/)
	})

	it('turns browser upload process errors into an actionable interrupted-connection error', () => {
		const err = new Error('uploadFile:fail process error')
		err.authoritativeAnalysisFailure = true
		const failure = classifyUploadFailure(err, { stage: 'analysis' })

		assert.equal(failure.category, 'analysis-connection')
		assert.equal(failure.errorCode, 'ANALYZE_CONNECTION_INTERRUPTED')
		assert.match(failure.advice, /81%|PM2|Nginx/)
	})

	it('classifies missing fast-analysis ownership evidence as retryable OCR output', () => {
		const err = createUploadError(
			'OCR_OWNERSHIP_EVIDENCE_MISSING',
			'分析服务未完整返回报告归属识别结果'
		)
		const failure = classifyUploadFailure(err, { stage: 'analysis' })

		assert.equal(failure.category, 'ocr-incomplete')
		assert.equal(failure.canRetry, true)
		assert.equal(failure.actionLabel, '重新上传')
		assert.equal(failure.reportKind, 'upload-ocr-incomplete')
		assert.match(failure.message, /本次分析|识别结果/)
		assert.doesNotMatch(failure.message, /报告.*没有姓名|文件.*没有姓名|未识别到征信报告姓名/)
	})

	it('classifies timeout and network failures separately', () => {
		assert.equal(classifyUploadFailure(new Error('上传分析超时，请检查网络')).category, 'timeout')
		assert.equal(classifyUploadFailure(new Error('uploadFile:fail ETIMEDOUT')).category, 'timeout')
		const disconnected = classifyUploadFailure(new Error('uploadFile:fail ECONNRESET'))
		assert.equal(disconnected.category, 'network')
		assert.equal(disconnected.title, '连接中断')
	})

	it('classifies only a raw HTTP 413 response as file-too-large', () => {
		const err = new Error('PDF 上传被网关拦截（HTTP 413）：client_max_body_size 过小')
		err.statusCode = 413
		err.httpStatus = 413
		err.transportKind = 'http'
		const failure = classifyUploadFailure(err)

		assert.equal(failure.category, 'file-too-large')
		assert.equal(failure.reportKind, 'upload-file-too-large')
		assert.match(failure.advice, /client_max_body_size/)
	})

	it('does not infer file-too-large from size, gateway wording, or a business code', () => {
		const disconnected = new Error('PDF 文件约 9.2MB，上传连接失败，请确认网关上传上限')
		disconnected.code = 'UPLOAD_NETWORK_ERROR'
		const business413 = new Error('业务校验失败')
		business413.statusCode = 413
		business413.code = 413
		business413.httpStatus = 200
		business413.transportKind = 'http'

		assert.equal(classifyUploadFailure(disconnected).category, 'network')
		assert.notEqual(classifyUploadFailure(business413).category, 'file-too-large')
	})

	it('distinguishes an explicit upload abort from network and timeout failures', () => {
		const aborted = createUploadError('UPLOAD_ABORTED', '上传已取消', { aborted: true })
		const failure = classifyUploadFailure(aborted)
		assert.equal(failure.category, 'aborted')
		assert.equal(failure.title, '连接中断')
		assert.equal(failure.errorCode, 'UPLOAD_ABORTED')
		assert.equal(failure.reportKind, 'upload-aborted')
		assert.equal(classifyUploadFailure(new Error('cancel')).title, '连接中断')
	})

	it('surfaces incomplete query evidence as a retryable safe-scoring stop', () => {
		const failure = classifyUploadFailure(createUploadError('QUERY_EVIDENCE_INCOMPLETE', '查询明细不足'))
		assert.equal(failure.category, 'query-evidence-incomplete')
		assert.equal(failure.canRetry, true)
		assert.equal(failure.errorCode, 'QUERY_EVIDENCE_INCOMPLETE')
	})

	it('uses save stage to surface storage failures', () => {
		const failure = classifyUploadFailure(new Error('setStorage failed'), { stage: 'save' })

		assert.equal(failure.category, 'save')
		assert.equal(failure.reportKind, 'upload-save-local')
		assert.equal(failure.actionLabel, '重试保存')
	})

	it('classifies save transport failures without asking for another upload', () => {
		const cases = [
			{
				error: Object.assign(new Error('云端保存失败'), {
					code: 'REPORT_CLOUD_PERSIST_FAILED',
					cloudCauseCode: 'REQUEST_ABORTED',
					transportKind: 'abort',
					aborted: true
				}),
				reportKind: 'upload-save-aborted'
			},
			{
				error: Object.assign(new Error('云端保存失败'), {
					code: 'REPORT_CLOUD_PERSIST_FAILED',
					cloudCauseCode: 'REQUEST_TIMEOUT',
					transportKind: 'timeout',
					timedOut: true
				}),
				reportKind: 'upload-save-timeout'
			},
			{
				error: Object.assign(new Error('云端保存失败'), {
					code: 'REPORT_CLOUD_PERSIST_FAILED',
					cloudCauseCode: 'REQUEST_NETWORK_ERROR',
					transportKind: 'network',
					networkFailure: true
				}),
				reportKind: 'upload-save-network'
			},
			{
				error: Object.assign(new Error('云端保存失败'), {
					code: 'REPORT_CLOUD_PERSIST_FAILED',
					statusCode: 502,
					httpStatus: 502,
					transportKind: 'http'
				}),
				reportKind: 'upload-save-server'
			}
		]

		for (const entry of cases) {
			const failure = classifyUploadFailure(entry.error, { stage: 'save' })
			assert.equal(failure.category, 'save')
			assert.equal(failure.reportKind, entry.reportKind)
			assert.equal(failure.actionLabel, '重试保存')
			assert.match(failure.advice, /重试保存/)
		}
	})

	it('uses the save-capacity message only for a real HTTP 413', () => {
		const real413 = Object.assign(new Error('报告云端保存失败'), {
			code: 'REPORT_CLOUD_PERSIST_FAILED',
			statusCode: 413,
			httpStatus: 413,
			transportKind: 'http'
		})
		const disconnected = Object.assign(new Error('报告云端保存失败'), {
			code: 'REPORT_CLOUD_PERSIST_FAILED',
			statusCode: 413,
			transportKind: 'network',
			networkFailure: true
		})

		assert.equal(classifyUploadFailure(real413, { stage: 'save' }).reportKind, 'upload-save-too-large')
		assert.equal(classifyUploadFailure(disconnected, { stage: 'save' }).reportKind, 'upload-save-network')
	})

	it('preserves a server permission message during save classification', () => {
		const error = Object.assign(new Error('当前角色无权保存该报告'), {
			code: 'REPORT_CLOUD_PERSIST_FAILED',
			statusCode: 403,
			httpStatus: 403,
			transportKind: 'http'
		})
		const failure = classifyUploadFailure(error, { stage: 'save' })

		assert.equal(failure.category, 'save')
		assert.equal(failure.reportKind, 'upload-save-permission')
		assert.equal(failure.message, '当前角色无权保存该报告')
		assert.equal(failure.actionLabel, '重试保存')
	})

	it('classifies HTTP 409 as a save content conflict', () => {
		const error = Object.assign(new Error('clientReportId 已绑定到不同报告内容'), {
			code: 'REPORT_CLOUD_PERSIST_FAILED',
			businessCode: 1001,
			statusCode: 409,
			httpStatus: 409,
			transportKind: 'http'
		})
		const failure = classifyUploadFailure(error, { stage: 'save' })

		assert.equal(failure.category, 'save')
		assert.equal(failure.reportKind, 'upload-save-conflict')
		assert.equal(failure.actionLabel, '重试保存')
		assert.match(failure.message, /不同报告内容/)
	})

	it('classifies HTTP-200 business code 5000 as a server save failure', () => {
		const error = Object.assign(new Error('报告正文未能保存到云端，请检查网络后重试'), {
			code: 'REPORT_CLOUD_PERSIST_FAILED',
			businessCode: 5000,
			statusCode: 200,
			httpStatus: 200,
			transportKind: 'http'
		})
		const failure = classifyUploadFailure(error, { stage: 'save' })

		assert.equal(failure.category, 'save')
		assert.equal(failure.reportKind, 'upload-save-server')
		assert.equal(failure.title, '报告保存服务异常')
	})

	it('keeps report ownership policy ahead of a generic save-stage 403', () => {
		const error = Object.assign(new Error('当前手机号已绑定其他客户的征信档案，不能上传其他人的征信报告。'), {
			code: 'REPORT_CLOUD_PERSIST_FAILED',
			statusCode: 403,
			httpStatus: 403,
			transportKind: 'http'
		})
		const failure = classifyUploadFailure(error, { stage: 'save' })

		assert.equal(failure.category, 'report-policy')
		assert.equal(failure.reportKind, 'upload-report-policy')
		assert.equal(failure.actionLabel, '知道了')
		assert.equal(failure.canRetry, false)
	})

	it('creates coded upload errors for callers', () => {
		const err = createUploadError('EMPTY_ANALYSIS_RESULT', '分析结果为空，请重试')
		const failure = classifyUploadFailure(err)

		assert.equal(err.code, 'EMPTY_ANALYSIS_RESULT')
		assert.equal(failure.category, 'empty-result')
	})
})
