/**
 * aiAnalysis 内部：主流程编排
 *
 * 数据流：
 *   文件 → pdfParser → extractCreditInfoFromText → DeepSeek（语义/弱信号救援）
 *        → enrichDimensions → [弱信号 ? mergeResults : fuseDeterministicCoreWithAISemantics]
 *        → buildAlgorithmReport → scoreFourDimensions → analyzeBehavior / simulateDebtEvolution → generateReport
 */

import * as pdfParser from '../pdfParser.js'
import * as aiService from '../deepseekService.js'
import { uploadCreditAnalyzeImages } from '../apiClient.js'
import {
	createAnalysisJob,
	getAnalysisJobResult,
	saveActiveAnalysisTask,
	waitForAnalysisJob
} from '../analysisTaskService.js'
import { mapServerAnalyzeDataToClientAnalysis } from '../serverAnalyzeMapper.js'
import { buildAnalysisExecutionViews } from '../analysisExecution.js'
import { hasMeaningfulAnalysisData } from '../analysisValidity.js'
import { assertFastPdfOwnershipEvidence, isFastPdfOwnershipEvidenceFailure } from '../analysisOwnershipEvidence.js'
import {
	assertAuthoritativeServerAnalysis,
	executeAuthoritativeAnalysisPath,
	markServerAnalysisResponse
} from '../authoritativeAnalysis.js'
import { buildAlgorithmReport } from '../creditAlgorithmCore.js'
import { REQUIRE_AI_FOR_REPORT } from '@/config/proxy.js'
import { reportError } from '../errorReporter.js'
import { createTerminalAnalysisFailure } from '../uploadFailure.js'

import { AnalysisStatus, dlog } from './constants.js'
import {
	enrichDimensions,
	applyVisionAIAccountOverview,
	isWeakStructuredSignal,
	mergeResults,
	fuseDeterministicCoreWithAISemantics,
	isDimensionSparse
} from './dimensions.js'
import { scoreFourDimensions, normalizeAdvisoryScores } from './scoring.js'
import { analyzeBehavior, simulateDebtEvolution } from './behavior.js'
import { generateTimeline, generateReport } from './report.js'

// 步骤定义（进度 payloads 的 steps 字段，与上传页的解析步骤渲染一一对应）
const STEPS = [
	{ name: '版式识别',      detail: '判断信用报告类型（人行/百行/朴道）' },
	{ name: 'OCR 文字提取',  detail: '提取文字、表格、还款状态矩阵' },
	{ name: '结构化解析',    detail: '识别账户、逾期记录、查询明细、公共记录' },
	{ name: 'AI 语义增强',  detail: 'DeepSeek 语义分析（必过）；主数值以信用解析为准，极弱文本时由 AI 补全' },
	{ name: '20+ 维度计算',  detail: '确定性核心 + 查询保守融合 / 弱信号时 AI 数值救援' },
	{ name: '智能分析报告', detail: '主评分框架（规则扣分制）：账户数/信用卡使用率/大额分期/查询密度' },
	{ name: '生成分析报告',  detail: '以信用为核心输出风控结论与匹配预估（资质为可选项）' }
]

// ─────────────────────────────────────────────
// 生成任务 ID
// ─────────────────────────────────────────────
const generateTaskId = () => 'TASK_' + Date.now() + '_' + Math.random().toString(36).substring(2, 11)

// ─────────────────────────────────────────────
// 步骤进度工具
// ─────────────────────────────────────────────
const makeProgress = (stepIndex, totalSteps, stepProgress = 100) => {
	const base = (stepIndex / totalSteps) * 100
	const inc  = (1 / totalSteps) * stepProgress
	return Math.round(base + inc)
}

const updateStepDetail = (task, index, detail) => {
	if (task && task.steps && task.steps[index] && detail) task.steps[index].detail = detail
}

const analysisExecutionOf = (value) => (
	value && value.analysisExecution && typeof value.analysisExecution === 'object'
		? value.analysisExecution
		: value && value.analysis_meta && typeof value.analysis_meta === 'object'
			? value.analysis_meta
			: null
)

const applyAnalysisExecutionToTask = (task, data) => {
	const execution = analysisExecutionOf(data)
	if (!task || !execution) return
	task.analysisExecution = { ...execution }
	if (execution.cacheHit !== true) return
	updateStepDetail(task, 1, '已复用同文件、同版本的已验证分析结果（未重复 OCR）')
	updateStepDetail(task, 2, '复用服务端已验证的账户、逾期、查询和公共记录')
	updateStepDetail(task, 3, '复用同一分析键下的已验证结构化结果')
	updateStepDetail(task, 4, '复用同规则版本的确定性维度结果')
	updateStepDetail(task, 5, '复用同规则版本的评分与风险命中')
	updateStepDetail(task, 6, '已标记为缓存复用结果并整理展示')
}

const startWaitingProgress = (task, onProgress, ceiling) => {
	let current = Number(task && task.progress) || 0
	const timer = setInterval(() => {
		current = Math.min(ceiling, current + Math.max(1, Math.round((ceiling - current) * 0.16)))
		if (task) task.progress = current
		onProgress?.(task)
	}, 2500)
	return () => clearInterval(timer)
}

const SERVER_STAGE_UI = Object.freeze({
	queued: { step: 1, status: AnalysisStatus.FILE_PARSING, name: '等待服务端处理', detail: '文件已完整接收，正在等待分析资源' },
	uploaded: { step: 1, status: AnalysisStatus.FILE_PARSING, name: '文件上传完成', detail: '服务端已完整接收 PDF' },
	pdf_extract: { step: 1, status: AnalysisStatus.OCR_PROCESSING, name: '读取 PDF 结构', detail: '正在提取报告文字层与页面结构' },
	ocr: { step: 1, status: AnalysisStatus.OCR_PROCESSING, name: 'OCR 文字提取', detail: '正在按页识别扫描报告文字' },
	query_evidence: { step: 2, status: AnalysisStatus.EXTRACTING, name: '核验查询明细', detail: '正在按页码与连续序号确定性核验查询记录' },
	fact_extraction: { step: 3, status: AnalysisStatus.EXTRACTING, name: '结构化事实提取', detail: '正在提取账户、逾期和公共记录' },
	rule_validation: { step: 4, status: AnalysisStatus.DIMENSION_CALC, name: '规则校验与评分', detail: '正在执行确定性规则、完整性门禁与评分' },
	persisting: { step: 6, status: AnalysisStatus.SCORING, name: '保存分析结果', detail: '正在安全保存已验证的分析结果' },
	succeeded: { step: 6, status: AnalysisStatus.COMPLETED, name: '分析完成', detail: '服务端已完成分析并保存结果' }
})

const applyServerJobProgress = (task, serverJob, onProgress) => {
	if (!task || !serverJob) return
	const stage = String(serverJob.stage || serverJob.status || 'queued').toLowerCase()
	const meta = SERVER_STAGE_UI[stage] || SERVER_STAGE_UI.queued
	const activeIndex = Math.max(0, Math.min(task.steps.length - 1, meta.step))
	for (let index = 0; index < task.steps.length; index++) {
		if (index < activeIndex) {
			task.steps[index].status = 'completed'
			task.steps[index].progress = 100
		} else if (index === activeIndex) {
			task.steps[index].status = stage === 'succeeded' ? 'completed' : 'processing'
			// 服务端只在真实阶段事件发生时推进 progress；不要再用固定 50%
			// 或定时器伪造步骤内部进度。
			task.steps[index].progress = stage === 'succeeded'
				? 100
				: Math.max(0, Math.min(99, Number(serverJob.progress) || 0))
		} else {
			task.steps[index].status = 'pending'
			task.steps[index].progress = 0
		}
	}
	task.steps[activeIndex].name = meta.name
	task.steps[activeIndex].detail = String(serverJob.detail || meta.detail)
	task.status = meta.status
	task.progress = Math.max(task.progress || 0, Math.min(100, Number(serverJob.progress) || 0))
	task.remoteJobId = String(serverJob.jobId || task.remoteJobId || '')
	task.supportRef = typeof serverJob.supportRef === 'string' ? serverJob.supportRef : task.supportRef || ''
	onProgress?.(task)
}

const isUsableServerAnalysis = (data) =>
	data && typeof data === 'object' &&
	data.report && typeof data.report === 'object' &&
	data.dimensions && typeof data.dimensions === 'object' &&
	hasMeaningfulAnalysisData(data)

const buildFastServerPdfData = (serverData, reportFormat) => {
	markServerAnalysisResponse(serverData)
	assertAuthoritativeServerAnalysis(serverData)
	const mapped = mapServerAnalyzeDataToClientAnalysis(serverData)
	const analysisExecution = analysisExecutionOf(serverData)
	if (!isUsableServerAnalysis(mapped)) {
		throw new Error('服务端分析结果结构不完整')
	}
	return {
		...mapped,
		reportFormat: mapped.reportFormat || reportFormat,
		analysisPipelineVersion: `${mapped.analysisPipelineVersion || 'server-api'}+pdf-fast`,
		aiInsight: mapped.aiInsight || mapped.kimiInsight || serverData,
		kimiInsight: mapped.kimiInsight || mapped.aiInsight || serverData,
		...(analysisExecution ? { analysisExecution } : {})
	}
}

const isAuthAnalyzeFailure = (err) => {
	const status = Number(err && (err.statusCode ?? err.status ?? err.code))
	const message = String(err && (err.message || err.errMsg || err.msg || err.error) || '')
	return status === 401 || /缺少分析凭证|鉴权失败|unauthorized|登录态|请先登录/i.test(message)
}

const finishFastServerPdfJob = async ({ remoteJob, task, onProgress, emit, totalSteps, reportFormat, signal }) => {
	task.remoteJobId = remoteJob.jobId
	applyServerJobProgress(task, remoteJob, onProgress)
	const terminal = await waitForAnalysisJob(remoteJob.jobId, {
		signal,
		supportRef: remoteJob.supportRefTrusted === false ? '' : remoteJob.supportRef,
		onStatus: (status) => applyServerJobProgress(task, status, onProgress)
	})
	if (terminal.status !== 'succeeded') {
		throw createTerminalAnalysisFailure(terminal, remoteJob.jobId)
	}
	const resultPayload = await getAnalysisJobResult(remoteJob.jobId, terminal.supportRef)
	if (resultPayload?.job?.status === 'failed') {
		throw createTerminalAnalysisFailure(resultPayload.job, remoteJob.jobId)
	}
	const serverData = resultPayload && (resultPayload.result || resultPayload.data)
		? (resultPayload.result || resultPayload.data)
		: resultPayload
	const resultExecution = {
		...(analysisExecutionOf(serverData) || {}),
		...(resultPayload && resultPayload.analysis && typeof resultPayload.analysis === 'object'
			? resultPayload.analysis
			: {})
	}
	const executionViews = buildAnalysisExecutionViews(resultExecution, remoteJob)
	const data = buildFastServerPdfData({
		...serverData,
		...(Object.keys(executionViews.persisted).length ? { analysisExecution: executionViews.persisted } : {})
	}, reportFormat)
	assertFastPdfOwnershipEvidence(data)
	// cacheHit/cacheSource are transport/UI state only. Persisting them changes the
	// report fingerprint when the exact same completed job is resumed from cache.
	applyAnalysisExecutionToTask(task, { analysisExecution: executionViews.ui })
	for (let i = 1; i < totalSteps; i++) emit(i, 'completed', makeProgress(i + 1, totalSteps))
	task.status = AnalysisStatus.COMPLETED
	task.progress = 100
	task.data = data
	task.supportRef = terminal.supportRef
	task.serverTime = terminal.serverTime
	onProgress?.(task)
	return task
}

const tryFastServerPdfAnalyze = async ({ filePath, fileSize, fileName, task, onProgress, emit, totalSteps, reportFormat, signal }) => {
	if (task && task.steps && task.steps[1]) task.steps[1].name = '服务端分析中'
	updateStepDetail(task, 1, '正在上传 PDF；完成后可离开页面，服务端会继续分析')
	updateStepDetail(task, 2, '服务端按原文确定性输出账户、逾期、查询和公共记录')
	updateStepDetail(task, 3, 'AI 已在服务端完成结构化增强')
	updateStepDetail(task, 4, '服务端规则引擎计算 20+ 维度')
	updateStepDetail(task, 5, '服务端生成四维评分与风险命中')
	updateStepDetail(task, 6, '整理为手机端可展示的信用画像')

	task.status = AnalysisStatus.OCR_PROCESSING
	emit(1, 'processing', 1)
	try {
		const remoteJob = await createAnalysisJob(filePath, {
			signal,
			onUploadProgress: (uploadProgress) => {
				task.progress = Math.max(task.progress || 0, Math.min(10, Math.round(uploadProgress / 10)))
				updateStepDetail(task, 1, `正在上传 PDF（${Math.round(uploadProgress)}%）`)
				onProgress?.(task)
			}
		})
		saveActiveAnalysisTask({
			...remoteJob,
			fileType: 'pdf',
			fileName: fileName || '信用报告.pdf',
			reportFormat
		})
		return await finishFastServerPdfJob({ remoteJob, task, onProgress, emit, totalSteps, reportFormat, signal })
	} catch (e) {
		if (isFastPdfOwnershipEvidenceFailure(e)) throw e
		if (isAuthAnalyzeFailure(e)) {
			throw e
		}
		const error = e instanceof Error ? e : new Error(String(e || '服务端权威分析失败'))
		error.authoritativeAnalysisFailure = true
		reportError({
			kind: 'pdf-authoritative-analyze-failed',
			message: error.message || 'PDF 服务端权威分析失败',
			page: 'aiAnalysis.pipeline'
		})
		throw error
	}
}

/** 手机重新进入上传页后，继续查看已经由服务端接管的 PDF 任务。 */
export const resumeCreditAnalysisJob = async (remoteTask, onProgress, options = {}) => {
	if (!remoteTask || !remoteTask.jobId) throw new Error('没有可恢复的分析任务')
	const totalSteps = STEPS.length
	const task = {
		taskId: generateTaskId(),
		remoteJobId: String(remoteTask.jobId),
		supportRef: typeof remoteTask.supportRef === 'string' ? remoteTask.supportRef : '',
		status: AnalysisStatus.PENDING,
		progress: Math.max(0, Math.min(100, Number(remoteTask.progress) || 0)),
		steps: STEPS.map((step) => ({ ...step, status: 'pending', progress: 0 })),
		data: null,
		analysisExecution: null,
		error: null
	}
	const emit = (stepIndex, stepStatus, overallProgress) => {
		task.steps[stepIndex].status = stepStatus
		task.steps[stepIndex].progress = stepStatus === 'completed' ? 100 : 50
		task.progress = overallProgress
		onProgress?.(task)
	}
	return await finishFastServerPdfJob({
		remoteJob: remoteTask,
		task,
		onProgress,
		emit,
		totalSteps,
		reportFormat: remoteTask.reportFormat && typeof remoteTask.reportFormat === 'object'
			? remoteTask.reportFormat
			: detectReportFormat('pdf'),
		signal: options.signal
	})
}

const normalizeImageInputs = (filePath, opts = {}) => {
	const raw = Array.isArray(filePath)
		? filePath
		: Array.isArray(opts.files)
			? opts.files
			: [filePath]
	return raw.filter(Boolean)
}

const tryFastServerImageAnalyze = async ({ filePath, task, onProgress, emit, totalSteps, reportFormat, opts = {} }) => {
	const imageFiles = normalizeImageInputs(filePath, opts)
	if (!imageFiles.length) return null
	updateStepDetail(task, 1, imageFiles.length > 1 ? `上传 ${imageFiles.length} 张报告截图，按顺序合并识别` : '上传报告截图，服务端完成 OCR 与 AI 分析')
	updateStepDetail(task, 2, '服务端同步输出账户、逾期、查询和公共记录')
	updateStepDetail(task, 3, 'AI 已在服务端完成结构化增强')
	updateStepDetail(task, 4, '服务端规则引擎计算 20+ 维度')
	updateStepDetail(task, 5, '服务端生成四维评分与风险命中')
	updateStepDetail(task, 6, '整理为手机端可展示的信用画像')

	task.status = AnalysisStatus.OCR_PROCESSING
	emit(1, 'processing', makeProgress(1, totalSteps, 50))
	const stopWaiting = startWaitingProgress(task, onProgress, makeProgress(5, totalSteps, 65))
	try {
		const serverData = await uploadCreditAnalyzeImages(imageFiles, { maxAttempts: 1 })
		const data = buildFastServerPdfData(serverData, reportFormat)
		applyAnalysisExecutionToTask(task, data)
		stopWaiting()
		for (let i = 1; i < totalSteps; i++) {
			emit(i, 'completed', makeProgress(i + 1, totalSteps))
		}
		task.status = AnalysisStatus.COMPLETED
		task.progress = 100
		task.data = data
		onProgress?.(task)
		return task
	} catch (e) {
		stopWaiting()
		if (isAuthAnalyzeFailure(e)) throw e
		const error = e instanceof Error ? e : new Error(String(e || '服务端权威分析失败'))
		error.authoritativeAnalysisFailure = true
		reportError({
			kind: 'image-authoritative-analyze-failed',
			message: error.message || '截图服务端权威分析失败',
			page: 'aiAnalysis.pipeline'
		})
		throw error
	}
}

// ─────────────────────────────────────────────
// 版式识别
// ─────────────────────────────────────────────

/**
 * 信用报告来源特征词库。
 * 按优先级排列：命中第一个匹配的来源即返回。
 * 仅匹配 OCR 文本前 2000 字符（报告头部的发行机构标识）。
 */
const REPORT_SOURCE_SIGNATURES = [
	{ source: '人行信用报告', version: 'v2015', keys: ['个人信用报告', '中国人民银行征信中心', '报告时间'] },
	{ source: '人行信用报告', version: 'v2020', keys: ['个人信用报告', '征信中心', '二代征信'] },
	{ source: '百行信用报告',             version: 'v2019', keys: ['百行征信', '个人征信报告', '百行'] },
	{ source: '商业银行代查',         version: 'unknown', keys: ['授权查询', '个人征信查询授权', '信贷记录'] },
]

const detectReportFormat = (fileType, ocrText = '') => {
	const type = fileType === 'pdf' ? 'PDF' : 'IMAGE'
	const headText = String(ocrText || '').slice(0, 2000)

	// 按特征词匹配来源
	for (const sig of REPORT_SOURCE_SIGNATURES) {
		if (sig.keys.every((k) => headText.includes(k))) {
			return { type, source: sig.source, version: sig.version }
		}
	}

	// 兜底：有文本但无法识别来源
	if (headText.trim().length > 0) {
		return { type, source: '未知信用机构', version: 'unknown' }
	}

	// 无文本时的初始猜测（PDF 提取成功后会被 refineReportFormat 更新）
	return { type, source: '人行信用报告', version: 'v2015' }
}

/** OCR 完成后用实际文本更新格式信息 */
const refineReportFormat = (current, ocrText) => {
	if (!ocrText || String(ocrText).trim().length < 50) return current
	return detectReportFormat(current?.type || 'PDF', ocrText)
}

// ─────────────────────────────────────────────
// 主入口：执行完整 AI 分析
// ─────────────────────────────────────────────
export const analyzeCreditReport = async (filePath, fileType, onProgress, opts = {}) => {
	const TOTAL_STEPS = STEPS.length

	const task = {
		taskId:  generateTaskId(),
		status:  AnalysisStatus.PENDING,
		progress: 0,
		steps:   STEPS.map(s => ({ ...s, status: 'pending', progress: 0 })),
		data:    null,
		analysisExecution: null,
		error:   null
	}

	const emit = (stepIdx, stepStatus, overallProgress) => {
		task.steps[stepIdx].status   = stepStatus
		task.steps[stepIdx].progress = stepStatus === 'completed' ? 100 : 50
		task.progress = overallProgress
		onProgress?.(task)
	}

		try {
			// ── Step 0：初始类型识别（来源/版本在 OCR 后精化） ──
			task.status = AnalysisStatus.FILE_PARSING
			emit(0, 'processing', makeProgress(0, TOTAL_STEPS, 50))
			let reportFormat = detectReportFormat(fileType)
			emit(0, 'completed', makeProgress(1, TOTAL_STEPS))

			const authoritativeTask = await executeAuthoritativeAnalysisPath({
				fileType,
				runPdfServer: () => tryFastServerPdfAnalyze({
					filePath,
					fileSize: opts.fileSize,
					fileName: opts.fileName,
					task,
					onProgress,
					emit,
					totalSteps: TOTAL_STEPS,
					reportFormat,
					signal: opts.signal
				}),
				runImageServer: () => tryFastServerImageAnalyze({
					filePath,
					task,
					onProgress,
					emit,
					totalSteps: TOTAL_STEPS,
					reportFormat,
					opts
				})
			})
			return authoritativeTask

			// ── Step 1：OCR / PDF 提取 ──────────────
			task.status = AnalysisStatus.OCR_PROCESSING
			emit(1, 'processing', makeProgress(1, TOTAL_STEPS, 50))

		let rawText = ''
		let directAIResult = null  // 服务器直接返回 AI JSON（图片走视觉分析）
		let visionAINormalized = null // 视觉路径下规范化后的 AI 结果，供结构化重建与维度融合

		if (fileType === 'pdf') {
			const pdfRes = await pdfParser.parsePDF(filePath, { fileSize: opts.fileSize })
			rawText = typeof pdfRes === 'string' ? pdfRes : (pdfRes?.text || '')
		} else {
			const imageResult = await pdfParser.parseImage(Array.isArray(filePath) ? filePath[0] : filePath)
			if (imageResult && imageResult.__aiDirect) {
				// 图片通过服务器视觉分析，直接得到结构化结果，跳过文本解析
				directAIResult = imageResult.aiResult
				visionAINormalized = aiService.normalizeDeepSeekResult(directAIResult)
				rawText = '[图片已由AI视觉直接分析]'
				dlog('[aiAnalysis] 图片AI视觉分析结果已获取，跳过文本解析')
			} else {
				rawText = typeof imageResult === 'string' ? imageResult : (imageResult?.text || '')
			}
		}

			const rawTextLen = typeof rawText === 'string' ? rawText.length : 0
			// OCR 后根据实际文本内容精化来源/版本识别
			reportFormat = refineReportFormat(reportFormat, rawText)
		dlog('[aiAnalysis] Step1完成，rawText长度:', rawTextLen, '直接AI结果:', !!directAIResult, '报告格式:', reportFormat)
		emit(1, 'completed', makeProgress(2, TOTAL_STEPS))

		// ── Step 2：结构化解析（正则层）──────────
		task.status = AnalysisStatus.EXTRACTING
		emit(2, 'processing', makeProgress(2, TOTAL_STEPS, 50))

		// 视觉路径：用 AI 结构化结果重建 parsed（避免空解析导致弱信号全量 merge AI、账户列表为空）
		const parsed = visionAINormalized
			? aiService.buildParsedFromDeepSeekNormalized(visionAINormalized)
			: pdfParser.extractCreditInfoFromText(rawText)
		dlog('[aiAnalysis] 结构化解析完成:', {
			accounts:     parsed.creditAccounts.length,
			overdue:      parsed.overdueRecords.length,
			queryRecords: parsed.queryRecords
		})
		emit(2, 'completed', makeProgress(3, TOTAL_STEPS))

		// ── Step 3：DeepSeek AI 增强 ─────────────
		emit(3, 'processing', makeProgress(3, TOTAL_STEPS, 50))

		let aiResult   = null
		let aiError    = null
		let aiDimensions = null
		let aiScores     = null

		try {
			if (visionAINormalized) {
				// 与文本链路一致：使用规范化后的结构，避免缺字段/NaN
				aiResult = visionAINormalized
				dlog('[aiAnalysis] 使用服务器AI视觉分析结果（已规范化）')
			} else {
				// 文本走服务器文本分析接口
				aiResult = await aiService.analyzeWithDeepSeek(rawText)
				dlog('[aiAnalysis] 文本AI分析成功')
			}
			aiDimensions = aiService.aiToInternalDimensions(aiResult)
			aiScores     = aiService.aiToScores(aiResult)
			dlog('[aiAnalysis] AI 增强成功:', aiResult.risk_level)
		} catch (kErr) {
			aiError = kErr.message
			if (REQUIRE_AI_FOR_REPORT) {
				reportError({ kind: 'ai-analysis-fail-blocking', message: kErr.message || 'AI 增强失败（将中止报告）', page: 'aiAnalysis.pipeline' })
			} else {
				reportError({ kind: 'ai-analysis-fail-degrade', message: kErr.message || 'AI 增强失败，降级使用正则结果', page: 'aiAnalysis.pipeline' })
			}
		}

		if (REQUIRE_AI_FOR_REPORT && !aiResult) {
			emit(3, 'error', makeProgress(3, TOTAL_STEPS, 50))
			let userMsg = 'AI 信用分析未完成，无法生成报告。'
			if (aiError) {
				if (/DEEPSEEK_API_KEY|not configured|服务器分析失败/i.test(aiError)) {
					userMsg = '分析服务未就绪，请稍后再试或联系管理员。'
				} else if (/超时|timeout/i.test(aiError)) {
					userMsg = '分析超时，请检查网络后重试。'
				} else if (/过短|无法进行AI分析/.test(aiError)) {
					userMsg = '报告文字过少或无法识别，请上传清晰完整的信用文件。'
				} else {
					const short = aiError.length > 100 ? aiError.slice(0, 100) + '…' : aiError
					userMsg = '分析失败：' + short
				}
			}
			onProgress?.(task)
			throw new Error(userMsg)
		}

		emit(3, 'completed', makeProgress(4, TOTAL_STEPS))

		// ── Step 4：20+ 维度计算 ─────────────────
		task.status = AnalysisStatus.DIMENSION_CALC
		emit(4, 'processing', makeProgress(4, TOTAL_STEPS, 50))

		let regexDimensions = enrichDimensions(parsed)
		// 视觉汇总账户仅 2 条占位时，账户数/账龄等以 AI account_overview 为准，与报告摘要一致
		if (visionAINormalized) {
			regexDimensions = applyVisionAIAccountOverview(regexDimensions, visionAINormalized)
		}
		const weakSignal = isWeakStructuredSignal(parsed, regexDimensions)
		const dimensions =
			weakSignal && aiDimensions
				? mergeResults(regexDimensions, aiDimensions)
				: fuseDeterministicCoreWithAISemantics(regexDimensions, aiDimensions)
		const rawTextForAlgo = typeof rawText === 'string' ? rawText : ''
		const algorithmReport = buildAlgorithmReport(parsed, dimensions, rawTextForAlgo)
		// 管线警告收集（供前端展示降级提示）
		const pipelineWarnings = []
		if (weakSignal && !aiResult) {
			pipelineWarnings.push({
				code: 'LOW_CONFIDENCE_DUAL_FAIL',
				level: 'warning',
				msg: '报告可读信息较少且 AI 分析未完成，评分仅供参考，建议上传清晰完整的原始文件'
			})
		} else if (weakSignal && aiResult) {
			pipelineWarnings.push({
				code: 'LOW_CONFIDENCE_REGEX_WEAK',
				level: 'info',
				msg: '报告结构化信息较少，已综合 AI 语义识别补充'
			})
		}
		const dimSource = !aiResult
			? (weakSignal ? 'regex-only-weak' : 'regex-only')
			: weakSignal
				? 'v5-weak-mergeResults'
				: 'v5-deterministic+fuse-queries'
		dlog('[aiAnalysis] 维度计算完成 [' + dimSource + ']:', dimensions)
		emit(4, 'completed', makeProgress(5, TOTAL_STEPS))

		// ── Step 5：四维评分（v5：信用历史/查询频率/账户结构/还款记录）──
		task.status = AnalysisStatus.SCORING
		emit(5, 'processing', makeProgress(5, TOTAL_STEPS, 50))

		// 默认基于合并后 dimensions 评分；当结构化极弱且维度接近全空时，回退到 AI 四维，确保用户能看到 AI 分析结果
		let scores = scoreFourDimensions(dimensions)
		if (weakSignal && isDimensionSparse(dimensions) && aiScores) {
			scores = normalizeAdvisoryScores(aiScores)
			reportError({ kind: 'ai-analysis-weak-signal', message: '结构化信号弱，采用 AI 四维评分作为展示主分', page: 'aiAnalysis.pipeline' })
		}
		dlog('[aiAnalysis] 评分完成（含 AI 弱信号兜底）:', scores)
		emit(5, 'completed', makeProgress(6, TOTAL_STEPS))

		// ── Step 6：生成分析报告 ─────────────────
		emit(6, 'processing', makeProgress(6, TOTAL_STEPS, 50))

		// 行为画像分析
		const behaviorProfile = analyzeBehavior(dimensions, aiResult)
		// 债务演化推演（马尔可夫链三场景）
		const debtEvolution  = simulateDebtEvolution(dimensions)

		const timeline = generateTimeline(scores, dimensions)
		const report   = generateReport(scores, dimensions, aiResult, behaviorProfile, debtEvolution, algorithmReport)
		emit(6, 'completed', 100)

		// ── 最终输出 ─────────────────────────────
		task.status   = AnalysisStatus.COMPLETED
		task.progress = 100
		task.data = {
			basicInfo:          parsed.basicInfo,
			accounts:           parsed.creditAccounts,
			overdueRecords:     parsed.overdueRecords,
			queryRecords:       parsed.queryRecords,
			publicRecords:      parsed.publicRecords,
			consecutiveOverdue: parsed.consecutiveOverdue,
			dimensions,              // v5 最终 20+ 维度（确定性核心 + 保守融合 / 弱信号 AI 救援）
			scores,                  // 四维评分（仅来自 scoreFourDimensions(dimensions)）
			analysisPipelineVersion: 'v5-hybrid-core',
			aiAdvisoryScores:        aiScores || null, // AI 四维，仅对照展示
			kimiAdvisoryScores:      aiScores || null, // 兼容旧字段
			timeline,
			algorithmReport,         // v3：分层流水线 / 负债拆解 / 查询窗 / 综合风险分 / 叙事
			// report 对象额外挂载 creditAccounts，供 normalizeReportData 直接读取
			report: {
				...report,
				creditAccounts: parsed.creditAccounts,
				algorithmReport,
			},
			reportFormat,
			behaviorProfile,         // 行为画像标签
			debtEvolution,           // 债务推演三场景
			aiInsight:   aiResult, // 原始 AI 输出（含 risk_tags、suggestion、product_accessibility）
			kimiInsight: aiResult, // 兼容旧字段
			kimiError: aiError,    // 兼容旧字段
			aiError,                // AI 失败时的错误信息（null=成功）
			// 征信 V2：10 模块全文 + 规则引擎图表/表（与产品 UI 对齐）
			creditReportV2: aiResult?.credit_report_full ?? null,
			frontendPayload: aiResult?.frontend_payload ?? null,
			ruleEngineWarnings: aiResult?.rule_engine_warnings ?? null,
			pipelineWarnings: pipelineWarnings.length > 0 ? pipelineWarnings : null,
			// 数据完整性诊断（10 模块覆盖率 + 原文裁切状态 + 模型输出截断标志）
			dataCompleteness:
				aiResult?.data_completeness ??
				aiResult?.credit_report_full?.data_completeness ??
				aiResult?.frontend_payload?.data_completeness ??
				null
		}

		onProgress?.(task)
		return task

	} catch (err) {
		reportError({ kind: 'ai-analysis-fatal', message: (err && (err.message || err.errMsg)) || '分析失败', stack: (err && err.stack) || '', page: 'aiAnalysis.pipeline' })
		task.status = AnalysisStatus.ERROR
		task.error  = pdfParser.formatErr(err)
		onProgress?.(task)
		throw err
	}
}
