'use strict'

/**
 * 征信 LLM 分析服务（从 server.js 提取）
 *
 * 职责：DeepSeek 文本分析全部流程 —— 完整输入门禁 → 流式 SSE 调用 → 严格 JSON/Schema 校验 → 规则引擎校验
 * 纯 Node.js CJS，无 Express 依赖，可独立单测。
 */

const pdfParse = require('pdf-parse')
const { looksLikeTokenLimitErr, compressCreditText } = require('./creditTextUtils')
const { summarizeCreditCardUtilization, isNotActivatedCardStatus } = require('./creditCardUtilization')
const creditEvidenceLedger = require('./creditEvidenceLedger')
const {
	buildEvidenceFirstCreditAnalysis,
	applyControlledSourceCardInstallments,
	stableCanonicalize
} = creditEvidenceLedger
const {
	analysisVersions,
	buildArtifactHash
} = require('./analysisIdentity')
const {
	WINDOW_MONTHS,
	isHardCreditQuery,
	countQueriesByWindow,
	classifyInstitution,
	classifyLoanInstitution
} = require('./queryWindowPolicy')
const logger = require('../utils/logger')

function safeErrorCode(error, fallback = 'INTERNAL_ERROR') {
	const raw = String(error && error.code || '')
	return /^[A-Z0-9_]{1,64}$/.test(raw) ? raw : fallback
}

function isMissingRequestedModule(err, request) {
	return err && err.code === 'MODULE_NOT_FOUND' && String(err.message || '').includes(request)
}

function loadOptionalLocalModule(request, fallback) {
	try {
		return require(request)
	} catch (err) {
		if (isMissingRequestedModule(err, request)) {
			logger.warn({ adapter: request }, 'credit-analysis optional adapter missing')
			return fallback
		}
		logger.warn(
			{ adapter: request, code: safeErrorCode(err, 'OPTIONAL_ADAPTER_LOAD_FAILED') },
			'credit-analysis optional adapter failed to load'
		)
		return fallback
	}
}

function unavailableAdapter(name) {
	return async () => {
		throw new Error(`${name} adapter is not available`)
	}
}

const { runCreditRuleEngine } = loadOptionalLocalModule('../../creditRuleEngine.js', {
	runCreditRuleEngine: (data) => {
		logger.warn('credit-analysis: creditRuleEngine adapter missing, returning LLM payload without rule enrichment')
		return data
	}
})
const pdfVisionAdapter = loadOptionalLocalModule('../../pdfVision.js', {
	extractPdfStructuredText: unavailableAdapter('pdfVision.extractPdfStructuredText'),
	renderPdfToPngBase64: unavailableAdapter('pdfVision.renderPdfToPngBase64'),
	iteratePdfPagesToPngBase64: null,
	renderPdfPageToPngBase64: null
})
const {
	extractPdfStructuredText,
	renderPdfToPngBase64,
	iteratePdfPagesToPngBase64,
	renderPdfPageToPngBase64
} = pdfVisionAdapter
const { ocrImageToText, splitImageForOcr } = loadOptionalLocalModule('../../moonshotVision.js', {
	ocrImageToText: unavailableAdapter('moonshotVision.ocrImageToText'),
	splitImageForOcr: unavailableAdapter('moonshotVision.splitImageForOcr')
})
const { recognizeFirstPageOwnership } = loadOptionalLocalModule('../../rapidOcrIdentity.js', {
	recognizeFirstPageOwnership: unavailableAdapter('rapidOcrIdentity.recognizeFirstPageOwnership')
})

const DEEPSEEK_URL =
	process.env.DEEPSEEK_CHAT_URL || 'https://api.deepseek.com/v1/chat/completions'
const TEXT_MODEL = process.env.DEEPSEEK_TEXT_MODEL || 'deepseek-v4-flash'
const MIN_TEXT_LEN = Number(process.env.PDF_MIN_TEXT_LEN || 30)
const SCANNED_PDF_MAX_PAGES = Number(process.env.SCANNED_PDF_MAX_PAGES || 80)
const SCANNED_PDF_RENDER_SCALE = Number(process.env.SCANNED_PDF_RENDER_SCALE || 2)
const SCANNED_PDF_OCR_CONCURRENCY = Math.max(1, Number(process.env.SCANNED_PDF_OCR_CONCURRENCY || 3))
const SCANNED_PDF_OCR_RETRIES = Math.max(1, Number(process.env.SCANNED_PDF_OCR_RETRIES || process.env.OCR_RETRY_ATTEMPTS || 3))
const SCANNED_PDF_OCR_RETRY_DELAY_MS = Math.max(0, Number(process.env.SCANNED_PDF_OCR_RETRY_DELAY_MS || 700))
const SCANNED_PDF_QUERY_RESCUE_ATTEMPTS = Math.max(0, Number(process.env.SCANNED_PDF_QUERY_RESCUE_ATTEMPTS || 2))
const SCANNED_PDF_QUERY_RESCUE_TILE_OFFSET = Math.max(
	1,
	Number(process.env.SCANNED_PDF_QUERY_RESCUE_TILE_OFFSET || 450)
)
// DeepSeek-V4-Flash supports a much larger context/output window than the
// historical limits used by this service. Keep conservative service-side
// ceilings so ordinary long credit reports are complete without allowing a
// runaway response to occupy the synchronous upload request indefinitely.
const DEFAULT_DEEPSEEK_INPUT_MAX_CHARS = 240000
const DEFAULT_DEEPSEEK_OUTPUT_MAX_TOKENS = 131072
const DEFAULT_CREDIT_DOCUMENT_MAX_CHARS = 1000000
const DEFAULT_CREDIT_CHUNK_TRIGGER_CHARS = 60000
const DEFAULT_CREDIT_CHUNK_TRIGGER_PAGES = 8
const DEFAULT_CREDIT_CHUNK_MAX_CHARS = 40000
const DEFAULT_CREDIT_CHUNK_MAX_PAGES = 3
const DEFAULT_CREDIT_CHUNK_CONCURRENCY = 3
const DEFAULT_CREDIT_CHUNK_OUTPUT_MAX_TOKENS = 32768
const TEXT_SCHEMA_PROMPT = `你是个人征信报告的“原始事实提取器”。输入为征信报告文本，只输出一个完整合法的 JSON 对象，不要 markdown，不要解释。

【绝对边界】
1. 只抄录原文明示事实，不做计算、推断、评级或建议。
2. 禁止输出：信用卡整体使用率、共享额度组、查询窗口汇总、总负债、负债率、风险标签、评分、六维/四维分、优缺点、建议、产品推荐、疑似放款等派生字段。
3. 金额统一为“元”；只在原文明示金额单位时做单位换算。贷款 balance 只能取原文明示的“余额/当前余额”，不得把发放金额、授信额度当作余额；未给余额填 null。
4. 日期统一 YYYY-MM-DD。无法确认的字段填 null，不得编造。
5. 信用卡和贷款的 currency 仅在原文可识别时填写；信用卡 card_tail 同样只抄录原文。纯外币贷款不得换算成人民币。不得输出 shared_credit_group、utilization_group 或任何共享额度结论。
6. 明细逐条提取，每个数组最多 500 条。_coverage.counts 必须填写原文总条数 total 与实际输出条数 listed；即使都是 0 也不可省略。若 total != listed，服务端会拒绝评分，不会把残缺结果发布为完整报告。不要输出由模型自行计算的 subtotal/total/summary。
7. 下方数组中的对象只是字段示例；原文没有对应条目时必须输出 []，不得复制一条全 null 的占位对象。
8. 为避免长报告输出被截断，每条明细只输出原文能够确认的字段；值为 null 的明细字段必须省略。顶层对象、固定子对象、明细数组和 _coverage.counts 仍必须完整保留。
9. 输出紧凑 JSON：不要缩进、不要换行、不要重复原文或写冗长 notes，不要在 JSON 外输出任何字符。

【唯一允许的顶层结构】
{
  "meta": {
    "report_type": null,
    "report_date": null,
    "query_date": null,
    "report_valid": null
  },
  "basic_info": {
    "name": null,
    "age": null,
    "gender": null,
    "id_last4": null,
    "marriage": null,
    "phone_last4": null,
    "address_city": null,
    "occupation": null,
    "employer": null
  },
  "loan_details": {
    "bank_loans": [{
      "seq": null,
      "institution": null,
      "credit_limit": null,
      "balance": null,
	  "currency": null,
      "type": null,
      "start_date": null,
      "end_date": null,
      "status": null,
      "monthly_payment": null
    }],
    "non_bank_loans": [],
    "settled_loans": [],
    "historical_overdue_loans": []
  },
  "credit_card_details": [{
    "seq": null,
    "institution": null,
    "credit_limit": null,
    "used_limit": null,
    "installment": null,
    "status": null,
    "start_date": null,
    "end_date": null,
    "overdue_days": null,
    "type": null,
    "account_type": null,
    "currency": null,
    "card_tail": null
  }],
  "credit_card_details_cancelled": [],
  "query_analysis": {
    "query_details": [{"institution": null, "date": null, "reason": null}],
    "self_queries": [{"date": null, "channel": null}]
  },
  "overdue_info": {
    "has_overdue": null,
    "total_overdue_accounts": null,
    "total_overdue_months": null,
    "overdue_30_days": null,
    "overdue_60_days": null,
    "overdue_90_days": null,
    "has_lian_san": null,
    "has_lei_liu": null,
    "details": [{
      "seq": null,
      "institution": null,
      "account": null,
      "bank": null,
      "type": null,
      "account_type": null,
      "date": null,
      "overdue_date": null,
      "amount": null,
      "overdue_amount": null,
      "days": null,
      "overdue_days": null,
      "months": null,
      "overdue_months": null,
      "level": null,
      "desc": null,
      "remark": null,
      "status": null
    }]
  },
  "public_records": {
    "has_record": null,
    "items": [{"type": null, "date": null, "detail": null}]
  },
  "guarantee_records": {
    "total_amount": null,
    "items": [{"guarantee_for": null, "amount": null, "start_date": null, "status": null}]
  },
  "loan_history": {
    "title": null,
    "unit": null,
    "trend_data": [{"period": null, "amount": null}]
  },
  "_coverage": {
    "source_text_length": null,
    "has_basic_info": false,
    "has_loans": false,
    "has_cards": false,
    "has_queries": false,
    "has_overdue": false,
    "has_public_records": false,
    "has_guarantee": false,
    "truncated": false,
    "counts": {
      "bank_loans": {"total": 0, "listed": 0},
      "non_bank_loans": {"total": 0, "listed": 0},
      "settled_loans": {"total": 0, "listed": 0},
      "historical_overdue_loans": {"total": 0, "listed": 0},
      "credit_card_details": {"total": 0, "listed": 0},
      "credit_card_details_cancelled": {"total": 0, "listed": 0},
      "query_details": {"total": 0, "listed": 0},
      "self_queries": {"total": 0, "listed": 0},
      "overdue_details": {"total": 0, "listed": 0},
      "public_records": {"total": 0, "listed": 0},
      "guarantee_records": {"total": 0, "listed": 0},
      "loan_history": {"total": 0, "listed": 0}
    },
    "notes": ""
  }
}`

const CHUNK_TEXT_SCHEMA_PROMPT = `${TEXT_SCHEMA_PROMPT}

【分块处理规则】
1. 你只会看到完整报告中的一个不重叠片段。只提取“本片段正文”实际出现的明细，不得补写其他片段的记录。
2. _coverage.counts 的 total 与 listed 都只统计本片段正文中逐条出现且已输出的明细；不得把信息概要中的全报告账户总数当成本片段 total。
3. 报告日期由服务端从报告头确定；正文未重复出现日期时，meta.report_date 可以填服务端给出的固定日期。
4. seq 只允许抄录原文明示的序号；原文没有序号时必须省略，不得从 1 重新编号。
5. 每个固定对象和12组 counts 仍必须完整输出。任何不确定字段省略或填 null，不得猜测。`

const CHUNK_QUERY_EVIDENCE_PROMPT = `${CHUNK_TEXT_SCHEMA_PROMPT}

【机构查询明细由服务端独立处理】
机构查询记录不属于模型任务。query_analysis.query_details 必须为 []，
_coverage.counts.query_details 必须为 {"total":0,"listed":0}；不要在其他字段复述、补全或统计机构查询行。`

const QUERY_EVIDENCE_PROMPT = `${TEXT_SCHEMA_PROMPT}

【机构查询明细由服务端独立处理】
机构查询记录不属于模型任务。为避免在长报告中重复生成大表，
query_analysis.query_details 必须为 []，_coverage.counts.query_details 必须为 {"total":0,"listed":0}；
不要在其他字段复述、补全或统计机构查询行。服务端只会在完整性校验前恢复已被独立证明的原始事实。`

function boundedPositiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
	const number = Number(value)
	if (!Number.isFinite(number)) return fallback
	return Math.min(max, Math.max(min, Math.trunc(number)))
}

function preferredChunkBoundary(text, start, hardEnd) {
	if (hardEnd >= text.length) return text.length
	const minimum = start + Math.floor((hardEnd - start) * 0.6)
	const candidates = ['\n\n', '\n', '。', '；', ';']
	for (const token of candidates) {
		// lastIndexOf 的 fromIndex 表示“起始位置”，多字符边界若从 hardEnd
		// 开始搜索可能让 token 末端越过硬上限。
		const at = text.lastIndexOf(token, Math.max(start, hardEnd - token.length))
		if (at >= minimum) return at + token.length
	}
	return hardEnd
}

function splitTextRange(text, start, end, maxChars, pageNo = null) {
	const ranges = []
	let cursor = start
	while (cursor < end) {
		const hardEnd = Math.min(end, cursor + maxChars)
		const next = hardEnd < end
			? Math.max(cursor + 1, preferredChunkBoundary(text, cursor, hardEnd))
			: end
		ranges.push({ start: cursor, end: next, pageStart: pageNo, pageEnd: pageNo })
		cursor = next
	}
	return ranges
}

/**
 * Split facts into deterministic, non-overlapping source ranges. OCR text has
 * explicit page markers; text-layer PDFs fall back to paragraph/newline
 * boundaries. Concatenating every chunk.text always reconstructs the source.
 */
function buildDeterministicCreditChunks(sourceText, options = {}) {
	const text = String(sourceText || '')
	const triggerChars = boundedPositiveInt(
		options.triggerChars,
		DEFAULT_CREDIT_CHUNK_TRIGGER_CHARS,
		1000,
		DEFAULT_CREDIT_DOCUMENT_MAX_CHARS
	)
	const triggerPages = boundedPositiveInt(
		options.triggerPages,
		DEFAULT_CREDIT_CHUNK_TRIGGER_PAGES,
		2,
		SCANNED_PDF_MAX_PAGES
	)
	const maxChars = boundedPositiveInt(
		options.maxChars,
		DEFAULT_CREDIT_CHUNK_MAX_CHARS,
		1000,
		DEFAULT_DEEPSEEK_INPUT_MAX_CHARS
	)
	const maxPages = boundedPositiveInt(
		options.maxPages,
		DEFAULT_CREDIT_CHUNK_MAX_PAGES,
		1,
		SCANNED_PDF_MAX_PAGES
	)
	const markers = []
	const markerPattern = /【第(\d+)页】/g
	let marker
	while ((marker = markerPattern.exec(text)) !== null) {
		markers.push({ index: marker.index, page: Number(marker[1]) })
	}

	let ranges = []
	if (markers.length >= triggerPages) {
		const pages = markers.map((item, index) => ({
			start: index === 0 ? 0 : item.index,
			end: index + 1 < markers.length ? markers[index + 1].index : text.length,
			page: item.page
		}))
		let current = null
		for (const page of pages) {
			if (page.end - page.start > maxChars) {
				if (current) {
					ranges.push(current)
					current = null
				}
				ranges.push(...splitTextRange(text, page.start, page.end, maxChars, page.page))
				continue
			}
			const projectedChars = current ? page.end - current.start : page.end - page.start
			const projectedPages = current ? current.pageCount + 1 : 1
			if (current && (projectedChars > maxChars || projectedPages > maxPages)) {
				ranges.push(current)
				current = null
			}
			if (!current) {
				current = {
					start: page.start,
					end: page.end,
					pageStart: page.page,
					pageEnd: page.page,
					pageCount: 1
				}
			} else {
				current.end = page.end
				current.pageEnd = page.page
				current.pageCount += 1
			}
		}
		if (current) ranges.push(current)
	} else if (text.length > triggerChars) {
		ranges = splitTextRange(text, 0, text.length, maxChars)
	}

	if (!ranges.length) ranges = [{ start: 0, end: text.length, pageStart: null, pageEnd: null }]
	return ranges.map((range, index) => ({
		index,
		total: ranges.length,
		start: range.start,
		end: range.end,
		pageStart: range.pageStart ?? null,
		pageEnd: range.pageEnd ?? null,
		text: text.slice(range.start, range.end)
	}))
}

function buildChunkUserText(chunk, reportDate) {
	const fixedDate = String(reportDate || '').trim() || '未能从报告头确定'
	return [
		`这是完整征信报告的第 ${chunk.index + 1}/${chunk.total} 个不重叠片段。`,
		`服务端确定的报告日期：${fixedDate}。`,
		'只统计并输出下方本片段正文实际出现的逐条明细；忽略概要中的全报告账户总数。',
		'【本片段正文开始】',
		chunk.text,
		'【本片段正文结束】'
	].join('\n')
}


/**
 * 在缓冲区前 1024 字节内查找 %PDF- 文件头偏移量。
 * 兼容带 UTF-8 BOM / 前导空白或少量垃圾字节的 PDF（PDF 规范与 Acrobat 均允许
 * 文件头出现在前 1024 字节内）。找不到返回 -1。
 */
function findPdfHeaderOffset(buf) {
	if (!buf || buf.length < 5) return -1
	const SIG = Buffer.from('%PDF-', 'ascii')
	const scanEnd = Math.min(buf.length - SIG.length, 1024)
	for (let i = 0; i <= scanEnd; i++) {
		if (buf[i] === 0x25 && buf.slice(i, i + SIG.length).equals(SIG)) {
			return i
		}
	}
	return -1
}

/**
 * PDF Buffer → 与 parsePdfHandler 一致的 JSON 结果（供 JSON 与 multipart 两路复用）
 * @returns {{ status: number, body: object }}
 */
async function buildPdfParseResult(buf) {
	if (!buf || buf.length < 24) {
		return { status: 400, body: { success: false, errMsg: 'PDF 二进制过短' } }
	}

	const pdfOffset = findPdfHeaderOffset(buf)
	if (pdfOffset < 0) {
		return { status: 400, body: { success: false, errMsg: '不是有效的 PDF 文件头' } }
	}
	// 剥离 %PDF- 之前的 BOM/前导垃圾字节，确保 pdf-parse 能正确定位文件头。
	// 注意必须用 Buffer.from(subarray) 生成独立副本：buf.slice 只是共享底层
	// ArrayBuffer 的视图，pdf-parse(pdf.js) 会读到含 BOM 的原始内存导致 xref 偏移错乱。
	const pdfBuf = pdfOffset > 0 ? Buffer.from(buf.subarray(pdfOffset)) : buf

	let structured = null
	try {
		structured = await extractPdfStructuredText(pdfBuf, {
			maxPages: Math.max(1, Number(process.env.CREDIT_PDF_MAX_PAGES || 500))
		})
		const nativeTextLength = Array.isArray(structured && structured.pages)
			? structured.pages.reduce((total, page) => total + String(page && page.text || '').length, 0)
			: 0
		if (nativeTextLength >= MIN_TEXT_LEN) {
			return {
				status: 200,
				body: { success: true, text: String(structured.text || '') },
				evidenceContext: {
					version: 'pdf-structured-v1',
					sourceMode: 'pdf-text',
					expectedPageCount: Number(structured.total || 0),
					complete: true,
					pages: structured.pages
				}
			}
		}
	} catch (error) {
		logger.warn({
			code: safeErrorCode(error, 'PDF_STRUCTURED_TEXT_FAILED')
		}, 'parse-pdf: structured text unavailable, trying legacy parser')
	}

	try {
		const result = await pdfParse(pdfBuf)
		const rawText = (result && typeof result.text === 'string' ? result.text : '').replace(/\0/g, '')
		const totalPages = Number(result && result.numpages)
		const text = addDeterministicPdfPageMarkers(rawText, totalPages)
		const fallbackContext = {
			version: 'pdf-parse-legacy-v1',
			sourceMode: 'pdf-parse-legacy',
			expectedPageCount: Number.isInteger(totalPages) && totalPages > 0 ? totalPages : 0,
			complete: false,
			pages: Array.isArray(structured && structured.pages) ? structured.pages : []
		}

		if (text.length < MIN_TEXT_LEN) {
			return {
				status: 200,
				evidenceContext: fallbackContext,
				body: {
					success: false,
					errMsg: `PDF 可提取文字过少（${text.length} 字符），可能为扫描件，请使用图片上传走 /api/analyze-image`,
					text
				}
			}
		}

		return {
			status: 200,
			body: { success: true, text },
			evidenceContext: fallbackContext
		}
	} catch (e) {
		logger.error({ code: safeErrorCode(e, 'PDF_PARSE_FAILED') }, 'parse-pdf failed')
		return {
			status: 500,
			body: { success: false, errMsg: e && e.message ? e.message : 'PDF 解析异常' }
		}
	}
}

function addDeterministicPdfPageMarkers(rawText, totalPages) {
	const source = String(rawText || '')
	const total = Number(totalPages)
	if (!Number.isInteger(total) || total <= 0) return source.trim()
	const pages = source.split('\n\n')
	if (pages.length && !pages[0].trim()) pages.shift()
	if (pages.length !== total) return source.trim()
	return pages
		.map((page, index) => `【第${index + 1}页】\n${String(page || '').trim()}`)
		.join('\n\n')
		.trim()
}

/**
 * 扫描件/图片型 PDF → 纯文本：逐页渲染为 PNG，经视觉 OCR 识别后按页序拼接。
 * 仅在 pdf-parse 无文字层（success:false）时调用。返回拼接文本与页数统计。
 * 征信报告用于金额和评分决策，任何一页失败都不能继续分析，否则会把少页数据当完整报告。
 * @param {Buffer} buf
 * @returns {Promise<{ text: string, total: number, rendered: number, ownershipVerified: boolean }>}
 */
async function scannedPdfToText(buf, dependencies = {}) {
	const ocrPage = dependencies.ocrRenderedPdfPageToText || ocrRenderedPdfPageToText
	const ocrQueryRescuePage =
		dependencies.ocrRenderedPdfQueryRescuePageToText ||
		(dependencies.ocrRenderedPdfPageToText
			? dependencies.ocrRenderedPdfPageToText
			: ocrRenderedPdfQueryRescuePageToText)
	const recognizeOwnership = dependencies.recognizeFirstPageOwnership || recognizeFirstPageOwnership
	const explicitlyInjectedLegacyRenderer =
		Object.prototype.hasOwnProperty.call(dependencies, 'renderPdfToPngBase64') &&
		typeof dependencies.renderPdfToPngBase64 === 'function'
	const iteratePages = dependencies.iteratePdfPagesToPngBase64 ||
		(explicitlyInjectedLegacyRenderer ? null : iteratePdfPagesToPngBase64)
	const renderSinglePage = dependencies.renderPdfPageToPngBase64 || renderPdfPageToPngBase64
	const renderOptions = {
		maxPages: SCANNED_PDF_MAX_PAGES,
		scale: SCANNED_PDF_RENDER_SCALE
	}
	let total = 0
	let firstPageImage = ''
	let legacyImages = null
	let pageTexts = []
	const failedPages = []
	const pendingOcr = new Set()
	const streamedPageNumbers = new Set()

	const processRenderedPage = async (base64, pageNumber, pageTotal) => {
		const idx = pageNumber - 1
		if (!pageTexts.length) pageTexts = new Array(pageTotal).fill('')
		if (idx === 0) firstPageImage = base64
		try {
			const text = await ocrPage(base64, pageNumber)
			pageTexts[idx] = String(text || '').trim()
			if (!pageTexts[idx]) throw new Error('OCR 返回空文本')
		} catch (e) {
			logger.error(
				{ code: safeErrorCode(e, 'OCR_PAGE_FAILED'), page: pageNumber, total: pageTotal },
				'scanned-pdf: OCR page failed after retries'
			)
			failedPages.push(pageNumber)
		}
	}

	try {
		if (typeof iteratePages === 'function') {
			// 生产路径按页渲染并维持有限数量的在途 OCR。每个 PNG 在该页 OCR
			// 完成后即可释放，避免长报告把全部页面及 base64 副本同时留在堆中。
			for await (const page of iteratePages(buf, renderOptions)) {
				const pageTotal = Number(page && page.total)
				const pageNumber = Number(page && page.pageNumber)
				if (!Number.isInteger(pageTotal) || pageTotal < 1) {
					throw buildIncompleteOcrError('pages', {
						total,
						failedPages: [],
						message: 'PDF 渲染器返回的页面总数无效，已停止分析以避免生成不完整结果。'
					})
				}
				if (total === 0) {
					total = pageTotal
					pageTexts = new Array(total).fill('')
				} else if (pageTotal !== total) {
					throw buildIncompleteOcrError('pages', {
						total,
						failedPages: [],
						message: 'PDF 渲染过程中页面总数发生变化，已停止分析以避免页序错乱。'
					})
				}
				if (
					!Number.isInteger(pageNumber) ||
					pageNumber < 1 ||
					pageNumber > total ||
					streamedPageNumbers.has(pageNumber)
				) {
					throw buildIncompleteOcrError('pages', {
						total,
						failedPages: Number.isInteger(pageNumber) ? [pageNumber] : [],
						message: 'PDF 渲染器返回了无效或重复页码，已停止分析以避免页序错乱。'
					})
				}
				streamedPageNumbers.add(pageNumber)
				const promise = processRenderedPage(
					String(page.base64 || ''),
					pageNumber,
					total
				).finally(() => pendingOcr.delete(promise))
				pendingOcr.add(promise)
				if (pendingOcr.size >= SCANNED_PDF_OCR_CONCURRENCY) {
					await Promise.race(pendingOcr)
				}
			}
			await Promise.all(pendingOcr)
			if (streamedPageNumbers.size !== total) {
				const missingPages = Array.from(
					{ length: total },
					(_value, index) => index + 1
				).filter((pageNumber) => !streamedPageNumbers.has(pageNumber))
				throw buildIncompleteOcrError('pages', {
					total,
					failedPages: missingPages,
					message: `第 ${missingPages.join('、')} 页未被渲染。为避免漏页导致评分和负债错误，已停止分析。`
				})
			}
		} else {
			// 保留依赖注入与旧适配器兼容路径，现有测试和外部调用不受影响。
			const renderPdf = dependencies.renderPdfToPngBase64 || renderPdfToPngBase64
			const rendered = await renderPdf(buf, renderOptions)
			total = Number(rendered && rendered.total || 0)
			legacyImages = Array.isArray(rendered && rendered.images) ? rendered.images : []
			if (Number(total) > legacyImages.length) {
				throw buildIncompleteOcrError('page-limit', {
					total,
					failedPages: [],
					message: `征信报告共 ${total} 页，当前最多可完整识别 ${legacyImages.length} 页。为避免漏页导致评分和负债错误，已停止分析，请联系管理员提高识别页数上限后重试。`
				})
			}
			pageTexts = new Array(legacyImages.length).fill('')
			let cursor = 0
			const worker = async () => {
				while (true) {
					const idx = cursor++
					if (idx >= legacyImages.length) break
					await processRenderedPage(legacyImages[idx], idx + 1, total)
				}
			}
			await Promise.all(Array.from(
				{ length: Math.min(SCANNED_PDF_OCR_CONCURRENCY, legacyImages.length) },
				() => worker()
			))
		}
	} catch (error) {
		// 迭代器可能在已有页面 OCR 尚未结束时抛出渲染异常。返回错误前等待
		// 所有在途任务收敛，避免请求结束后仍持有页面图片或继续占用 OCR 进程。
		await Promise.allSettled(pendingOcr)
		if (error && error.code === 'PDF_PAGE_LIMIT_EXCEEDED') {
			const pageTotal = Number(error.total || 0)
			const maxPages = Number(error.maxPages || SCANNED_PDF_MAX_PAGES)
			throw buildIncompleteOcrError('page-limit', {
				total: pageTotal,
				failedPages: [],
				message: `征信报告共 ${pageTotal} 页，当前最多可完整识别 ${maxPages} 页。为避免漏页导致评分和负债错误，已停止分析，请联系管理员提高识别页数上限后重试。`
			})
		}
		throw error
	}

	if (!pageTexts.length) return { text: '', total, rendered: 0 }
	if (pageTexts.length !== total) {
		throw buildIncompleteOcrError('pages', {
			total,
			failedPages: [],
			message: 'PDF 页面渲染数量与报告页数不一致，已停止分析以避免生成不完整结果。'
		})
	}
	if (failedPages.length > 0) {
		failedPages.sort((a, b) => a - b)
		throw buildIncompleteOcrError('pages', {
			total,
			failedPages,
			message: `第 ${failedPages.join('、')} 页识别失败。为避免债务总额和评分出错，系统已停止分析；请重新上传原 PDF，或按页截图后重新选择全部页面上传。`
		})
	}

	if (!firstPageImage && legacyImages && legacyImages.length) firstPageImage = legacyImages[0]
	const ownership = await secureScannedFirstPageOwnership({
		firstPageText: pageTexts[0],
		firstPageImageBase64: firstPageImage,
		recognizeOwnership
	})
	pageTexts[0] = ownership.text

	const loadPageImage = typeof renderSinglePage === 'function'
		? async (pageIndex) => {
			const page = await renderSinglePage(buf, pageIndex + 1, renderOptions)
			return String(page && page.base64 || '')
		}
		: null
	const queryEvidence = await rescueIncompleteInstitutionQueryOcr({
		pageTexts,
		images: legacyImages,
		loadPageImage,
		ocrPage: ocrQueryRescuePage
	})

	const text = pageTexts
		.map((t, i) => (t ? `【第${i + 1}页】\n${t}` : ''))
		.filter(Boolean)
		.join('\n\n')
		.trim()
	return {
		text,
		total,
		rendered: pageTexts.filter(Boolean).length,
		ownershipRescued: ownership.rescued,
		queryEvidence,
		evidenceContext: {
			version: 'ocr-page-span-v1',
			sourceMode: 'ocr',
			expectedPageCount: total,
			complete: true,
			geometryState: 'unavailable'
		},
		// secureScannedFirstPageOwnership only returns after a labelled name and
		// checksum-valid full identity were proved on page 1. Expose only this
		// boolean fact to callers; never expose the underlying identity values.
		ownershipVerified: true
	}
}

async function ocrRenderedPdfPageToTextWithSplitOptions(base64, pageNo, splitOptions = {}, label = 'page') {
	const tiles = await splitImageForOcr(base64, 'image/png', splitOptions)
	if (!tiles.length) throw new Error(`第 ${pageNo} 页渲染图片为空`)
	if (tiles.length <= 1) {
		return await runOcrWithRetry(() => ocrImageToText(tiles[0].base64, tiles[0].mimeType), {
			label: `scanned-pdf-${label}-${pageNo}`,
			index: pageNo
		})
	}

	const parts = []
	for (let i = 0; i < tiles.length; i++) {
		const text = await runOcrWithRetry(() => ocrImageToText(tiles[i].base64, tiles[i].mimeType), {
			label: `scanned-pdf-${label}-${pageNo}-tile-${i + 1}`,
			index: `${pageNo}.${i + 1}`
		})
		const cleaned = String(text || '').trim()
		if (!cleaned) throw new Error(`第 ${pageNo} 页第 ${i + 1} 段 OCR 返回空文本`)
		parts.push(cleaned)
	}
	return parts.join('\n')
}

async function ocrRenderedPdfPageToText(base64, pageNo) {
	return ocrRenderedPdfPageToTextWithSplitOptions(base64, pageNo)
}

async function ocrRenderedPdfQueryRescuePageToText(base64, pageNo) {
	return ocrRenderedPdfPageToTextWithSplitOptions(
		base64,
		pageNo,
		{ tileOffset: SCANNED_PDF_QUERY_RESCUE_TILE_OFFSET },
		'query-rescue-page'
	)
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runOcrWithRetry(fn, context = {}) {
	let lastErr = null
	for (let attempt = 1; attempt <= SCANNED_PDF_OCR_RETRIES; attempt++) {
		try {
			return await fn()
		} catch (err) {
			lastErr = err
			if (attempt >= SCANNED_PDF_OCR_RETRIES) break
			logger.warn({
				code: safeErrorCode(err, 'OCR_UPSTREAM_FAILED'),
				attempt,
				maxAttempts: SCANNED_PDF_OCR_RETRIES,
				label: context.label,
				index: context.index
			}, 'ocr: upstream failed, retrying')
			await sleep(SCANNED_PDF_OCR_RETRY_DELAY_MS * attempt)
		}
	}
	throw lastErr || new Error('OCR failed')
}

function buildIncompleteOcrError(reason, opts = {}) {
	const err = new Error(opts.message || 'OCR 识别不完整，已停止分析')
	err.code = 'OCR_INCOMPLETE'
	err.reason = reason
	err.failedPages = Array.isArray(opts.failedPages) ? opts.failedPages : []
	err.totalPages = Number(opts.total || 0)
	return err
}

/**
 * 征信长文本 → DeepSeek 结构化 JSON（与 /api/analyze-text 共用）
 * @returns {Promise<{ ok: true, data: object } | { ok: false, httpStatus: number, errMsg: string }>}
 */
/**
 * 以「流式(SSE)」方式请求 Chat Completions，累积 delta.content。
 *
 * 为什么必须流式：非流式请求要等模型把整段 JSON 全部生成完才返回响应头，而 Node 内置
 * fetch(undici) 的 headersTimeout 默认 300s——长报告/大输出一旦生成超过 5 分钟，
 * 服务端就会抛 "fetch failed"。流式下响应头立即返回、token 持续流入，规避该硬上限。
 *
 * @returns {Promise<{ ok: boolean, status: number, content: string, finishReason: string|null, errMsg?: string }>}
 */
async function callCreditChatStreamOnce(apiKey, body) {
	const r = await fetch(DEEPSEEK_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`
		},
		body: JSON.stringify({ ...body, stream: true })
	})
	if (!r.ok || !r.body) {
		let errMsg = `HTTP ${r.status}`
		try {
			const j = await r.json()
			errMsg = j && j.error && j.error.message ? j.error.message : JSON.stringify(j)
		} catch (_) {}
		return { ok: false, status: r.status || 502, content: '', finishReason: null, errMsg }
	}
	let content = ''
	let finishReason = null
	const decoder = new TextDecoder()
	let buffer = ''
	try {
		for await (const chunk of r.body) {
			buffer += decoder.decode(chunk, { stream: true })
			let nl
			while ((nl = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, nl).trim()
				buffer = buffer.slice(nl + 1)
				if (!line.startsWith('data:')) continue
				const payload = line.slice(5).trim()
				if (!payload || payload === '[DONE]') continue
				try {
					const obj = JSON.parse(payload)
					const choice = obj.choices && obj.choices[0]
					if (choice) {
						if (choice.delta && typeof choice.delta.content === 'string') content += choice.delta.content
						if (choice.finish_reason) finishReason = choice.finish_reason
					}
				} catch (_) {
					// 单行 SSE 解析失败忽略，继续累积
				}
			}
		}
	} catch (streamErr) {
		// 流式生成中途连接被重置（ECONNRESET / socket terminated 等）：标记为可重试网络错误，
		// 交由 callCreditChatStream 包装层重试整次生成（大报告/长输出时偶发，单次失败会让整单报错）。
		return {
			ok: false,
			status: 0,
			content,
			finishReason,
			errMsg: (streamErr && streamErr.message) ? streamErr.message : 'stream interrupted',
			_network: true
		}
	}
	return { ok: true, status: 200, content, finishReason }
}

/**
 * callCreditChatStreamOnce 的重试包装：对网络抖动（ECONNRESET、fetch failed、流中断）
 * 与上游 429/5xx 做退避重试。大报告长输出时上游连接易被中途重置，单次失败会导致整单报错，
 * 这里最多重试 DEEPSEEK_MAX_ATTEMPTS 次（默认 3），仅对可重试错误重试；业务 4xx 立即返回。
 */
async function callCreditChatStream(apiKey, body) {
	const configuredAttempts = Number(process.env.DEEPSEEK_MAX_ATTEMPTS)
	const maxAttempts = Number.isFinite(configuredAttempts)
		? Math.min(5, Math.max(1, Math.trunc(configuredAttempts)))
		: 3
	let last = null
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		let resp
		try {
			resp = await callCreditChatStreamOnce(apiKey, body)
		} catch (e) {
			resp = {
				ok: false,
				status: 0,
				content: '',
				finishReason: null,
				errMsg: (e && e.message) ? e.message : 'fetch failed',
				_network: true
			}
		}
		if (resp.ok) return resp
		last = resp
		const retriable =
			resp._network === true ||
			resp.status === 429 ||
			resp.status >= 500 ||
			/ECONNRESET|fetch failed|terminated|socket|network|EPIPE|ETIMEDOUT|aborted/i.test(resp.errMsg || '')
		if (retriable && attempt < maxAttempts) {
			logger.warn({ attempt, status: resp.status || 0, network: resp._network === true }, 'analyze-text: DeepSeek call failed, retrying')
			await new Promise((r) => setTimeout(r, 800 * attempt))
			continue
		}
		// 流中断时即使已有大段内容也不能补括号后发布：缺失的末尾条目会改变
		// 债务、查询和评分。失败请求不进入成功缓存，用户可安全重试。
		return resp
	}
	return last
}

function safeNum(value, def = 0) {
	if (typeof value === 'number') return Number.isFinite(value) ? value : def
	const raw = String(value == null ? '' : value).trim()
	if (!raw) return def
	const cleaned = raw
		.replace(/[,，]/g, '')
		.replace(/[人民币元\s]/g, '')
		.replace(/[（）()]/g, '')
	const m = cleaned.match(/-?\d+(?:\.\d+)?/)
	if (!m) return def
	const n = Number(m[0])
	if (!Number.isFinite(n)) return def
	return /万/.test(raw) ? n * 10000 : n
}

function roundMoney(value) {
	const n = safeNum(value)
	return Math.round(n * 100) / 100
}

function roundRate(value) {
	const n = safeNum(value)
	if (!Number.isFinite(n)) return 0
	return Math.round(n * 10000) / 10000
}

function asArray(value) {
	return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : []
}

function ensureObject(parent, key) {
	if (!parent[key] || typeof parent[key] !== 'object' || Array.isArray(parent[key])) parent[key] = {}
	return parent[key]
}

function pickFactFields(value, fields) {
	const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
	const out = {}
	for (const field of fields) {
		if (Object.prototype.hasOwnProperty.call(source, field)) out[field] = source[field]
	}
	return out
}

function isMeaningfulFactValue(value) {
	return value !== null && value !== undefined && String(value).trim() !== ''
}

function hasMeaningfulFactRow(row) {
	if (!row || typeof row !== 'object' || Array.isArray(row)) return false
	// `seq` is only a display/order marker.  A model must not be able to turn an
	// empty placeholder into a "fact" merely by numbering it.
	return Object.entries(row).some(([key, value]) =>
		key !== 'seq' && isMeaningfulFactValue(value)
	)
}

function hasDuplicateRepairRows(name, rows) {
	const seenSeq = new Set()
	const seenStrongCardIdentity = new Set()
	for (const row of rows) {
		if (isMeaningfulFactValue(row.seq)) {
			const seqKey = String(normalizeFactScalar(row.seq))
			if (seenSeq.has(seqKey)) return true
			seenSeq.add(seqKey)
		}
		if (
			(name === 'credit_card_details' || name === 'credit_card_details_cancelled') &&
			isMeaningfulFactValue(row.card_tail)
		) {
			const cardKey = JSON.stringify([
				normalizeFactScalar(row.institution || ''),
				normalizeFactScalar(row.card_tail),
				normalizeFactScalar(row.currency || ''),
				normalizeFactScalar(row.account_type || row.type || ''),
				normalizeFactScalar(row.start_date || '')
			])
			if (seenStrongCardIdentity.has(cardKey)) return true
			seenStrongCardIdentity.add(cardKey)
		}
	}
	return false
}

function pickFactRows(value, fields) {
	return asArray(value)
		.map((row) => pickFactFields(row, fields))
		.filter(hasMeaningfulFactRow)
}

const FACT_COVERAGE_ARRAYS = Object.freeze({
	bank_loans: (source) => source?.loan_details?.bank_loans,
	non_bank_loans: (source) => source?.loan_details?.non_bank_loans,
	settled_loans: (source) => source?.loan_details?.settled_loans,
	historical_overdue_loans: (source) => source?.loan_details?.historical_overdue_loans,
	credit_card_details: (source) => source?.credit_card_details,
	credit_card_details_cancelled: (source) => source?.credit_card_details_cancelled,
	query_details: (source) => source?.query_analysis?.query_details,
	self_queries: (source) => source?.query_analysis?.self_queries,
	overdue_details: (source) => source?.overdue_info?.details,
	public_records: (source) => source?.public_records?.items,
	guarantee_records: (source) => source?.guarantee_records?.items,
	loan_history: (source) => source?.loan_history?.trend_data
})

const FACT_COVERAGE_REPAIR_DEFS = Object.freeze({
	bank_loans: {
		label: '尚未结清的银行贷款明细',
		fields: ['seq', 'institution', 'credit_limit', 'balance', 'currency', 'type', 'start_date', 'end_date', 'status', 'monthly_payment', 'overdue_months', 'overdue_90_days']
	},
	non_bank_loans: {
		label: '尚未结清的非银行贷款明细',
		fields: ['seq', 'institution', 'credit_limit', 'balance', 'currency', 'type', 'start_date', 'end_date', 'status', 'monthly_payment', 'overdue_months', 'overdue_90_days']
	},
	settled_loans: {
		label: '已结清或已还清的贷款明细（不含销户信用卡）',
		fields: ['seq', 'institution', 'credit_limit', 'balance', 'currency', 'type', 'start_date', 'end_date', 'status', 'monthly_payment', 'overdue_months', 'overdue_90_days']
	},
	historical_overdue_loans: {
		label: '报告原文单独列出的历史逾期贷款明细',
		fields: ['seq', 'institution', 'credit_limit', 'balance', 'currency', 'type', 'start_date', 'end_date', 'status', 'monthly_payment', 'overdue_months', 'overdue_90_days']
	},
	credit_card_details: {
		label: '未销户信用卡或贷记卡账户明细',
		fields: ['seq', 'institution', 'credit_limit', 'used_limit', 'installment', 'status', 'start_date', 'end_date', 'overdue_days', 'type', 'account_type', 'currency', 'card_tail']
	},
	credit_card_details_cancelled: {
		label: '已销户信用卡或贷记卡账户明细',
		fields: ['seq', 'institution', 'credit_limit', 'used_limit', 'installment', 'status', 'start_date', 'end_date', 'overdue_days', 'type', 'account_type', 'currency', 'card_tail']
	},
	query_details: {
		label: '机构查询记录明细',
		fields: ['institution', 'date', 'reason']
	},
	self_queries: {
		label: '本人查询记录明细',
		fields: ['date', 'channel']
	},
	overdue_details: {
		label: '逾期事实明细',
		fields: ['seq', 'institution', 'account', 'bank', 'type', 'account_type', 'date', 'overdue_date', 'amount', 'overdue_amount', 'days', 'overdue_days', 'months', 'overdue_months', 'level', 'desc', 'remark', 'status']
	},
	public_records: {
		label: '公共记录明细',
		fields: ['type', 'date', 'detail']
	},
	guarantee_records: {
		label: '对外担保记录明细',
		fields: ['guarantee_for', 'amount', 'start_date', 'status']
	},
	loan_history: {
		label: '贷款历史趋势数据点',
		fields: ['period', 'amount']
	}
})

function replaceCoverageRows(source, name, rows) {
	switch (name) {
		case 'bank_loans': source.loan_details.bank_loans = rows; break
		case 'non_bank_loans': source.loan_details.non_bank_loans = rows; break
		case 'settled_loans': source.loan_details.settled_loans = rows; break
		case 'historical_overdue_loans': source.loan_details.historical_overdue_loans = rows; break
		case 'credit_card_details': source.credit_card_details = rows; break
		case 'credit_card_details_cancelled': source.credit_card_details_cancelled = rows; break
		case 'query_details': source.query_analysis.query_details = rows; break
		case 'self_queries': source.query_analysis.self_queries = rows; break
		case 'overdue_details': source.overdue_info.details = rows; break
		case 'public_records': source.public_records.items = rows; break
		case 'guarantee_records': source.guarantee_records.items = rows; break
		case 'loan_history': source.loan_history.trend_data = rows; break
		default: throw factSchemaError(`$._coverage.counts.${name}`, 'unsupported repair target')
	}
}

/**
 * JSON Schema 验证时数组长度不能把 `{}` 或全 null 对象当成一条事实。
 * 这些占位行在 sanitizeExtractedCreditFacts 中本来也会被丢弃；如果等到
 * sanitize 之后才丢弃，就会出现 raw 40/40 通过、清洗后只剩 4/40 的假完整。
 *
 * 只校正 listed 和实际非空行，永远不降低 total。如果 total 更大，后续定向补全
 * 必须恰好补齐原 total，否则仍然 fail closed。
 */
function pruneEmptyCoverageRows(source) {
	const counts = source?._coverage?.counts
	if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return source
	for (const [name, selectRows] of Object.entries(FACT_COVERAGE_ARRAYS)) {
		const rows = selectRows(source)
		if (!Array.isArray(rows)) continue
		const factualRows = rows.filter(hasMeaningfulFactRow)
		if (factualRows.length === rows.length) continue
		replaceCoverageRows(source, name, factualRows)
		const count = counts[name]
		if (count && typeof count === 'object' && !Array.isArray(count)) {
			count.listed = factualRows.length
		}
		logger.warn({
			array: name,
			removedPlaceholders: rows.length - factualRows.length,
			factualRows: factualRows.length,
			declaredTotal: Number(count && count.total)
		}, 'analyze-text: removed empty fact placeholders before coverage validation')
	}
	return source
}

function normalizeSelfConsistentCoverageCounts(source) {
	const counts = source?._coverage?.counts
	if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return []
	const missing = []
	for (const [name, selectRows] of Object.entries(FACT_COVERAGE_ARRAYS)) {
		// Institution-query rows are never repaired by a generative model. They
		// are supplied only by the independently verified source-evidence path.
		if (name === 'query_details') continue
		const count = counts[name]
		const rows = selectRows(source)
		if (!count || typeof count !== 'object' || !Array.isArray(rows)) continue
		const total = Number(count.total)
		const listed = Number(count.listed)
		const actual = rows.length
		if (!Number.isInteger(total) || total < 0) continue
		// The array itself is authoritative for `listed`; correcting only this
		// arithmetic field cannot hide a missing row when total===actual.
		if (total === actual) {
			if (listed !== actual) count.listed = actual
			continue
		}
		// A first pass that independently declares more rows than it emitted is
		// repairable. Never discard rows or lower total when actual > total.
		if (total > actual && total <= 500) {
			missing.push({ name, expectedTotal: total, actual })
		}
	}
	return missing
}

function buildCoverageRepairRequest(name, expectedTotal, sourceText, maxTokens) {
	const def = FACT_COVERAGE_REPAIR_DEFS[name]
	return {
		model: TEXT_MODEL,
		temperature: 0,
		max_tokens: Math.min(maxTokens, 65536),
		response_format: { type: 'json_object' },
		thinking: { type: 'disabled' },
		messages: [
			{
				role: 'system',
				content: `你是个人征信报告的定向原始事实补全器。只输出紧凑合法 JSON，不要 markdown、解释、派生计算或评分。目标是原文中的“${def.label}”。只允许输出 {"complete":true|false,"total":整数,"rows":[]} 三个键。rows 每行只允许字段：${def.fields.join(',')}。只写原文能确认的非 null 字段，不得编造、重复或混入其他类别。只有找齐所有明细时 complete=true；无法找齐时 complete=false，不得为了凑数据伪造行。`
			},
			{
				role: 'user',
				content: `首次完整抽取独立声明该类别 total=${expectedTotal}，但明细未全部输出。请重新遍历下方完整报告；仅当恰好输出 ${expectedTotal} 条且每条有原文依据时设 complete=true。\n\n${String(sourceText || '')}`
			}
		]
	}
}

async function repairIncompleteFactCoverage(source, sourceText, apiKey, maxTokens) {
	const missing = normalizeSelfConsistentCoverageCounts(source)
	if (!missing.length) return source
	const repairs = await Promise.all(missing.map(async ({ name, expectedTotal, actual }) => {
		const def = FACT_COVERAGE_REPAIR_DEFS[name]
		if (!def) return { name, ok: false, expectedTotal, actual, reason: 'unsupported' }
		const response = await callCreditChatStream(
			apiKey,
			buildCoverageRepairRequest(name, expectedTotal, sourceText, maxTokens)
		)
		if (!response.ok || response.finishReason !== 'stop') {
			return { name, ok: false, expectedTotal, actual, reason: 'incomplete_response' }
		}
		let payload = null
		try { payload = JSON.parse(String(response.content || '').trim()) } catch (_) {}
		if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
			return { name, ok: false, expectedTotal, actual, reason: 'invalid_json' }
		}
		const keys = Object.keys(payload)
		if (keys.some((key) => !['complete', 'total', 'rows'].includes(key))) {
			return { name, ok: false, expectedTotal, actual, reason: 'unexpected_key' }
		}
		const rows = payload.rows
		if (
			payload.complete !== true ||
			Number(payload.total) !== expectedTotal ||
			!Array.isArray(rows) ||
			rows.length !== expectedTotal ||
			!rows.every(hasMeaningfulFactRow) ||
			hasDuplicateRepairRows(name, rows) ||
			(name === 'credit_card_details' && rows.some((row) => isCancelledCardStatus(row.status)))
		) {
			return { name, ok: false, expectedTotal, actual, reason: 'count_mismatch' }
		}
		try { assertFactRows(rows, def.fields, `$.coverage_repair.${name}`) } catch (_) {
			return { name, ok: false, expectedTotal, actual, reason: 'row_schema_invalid' }
		}
		return { name, ok: true, expectedTotal, actual, rows }
	}))

	for (const repair of repairs) {
		if (!repair.ok) {
			logger.warn({
				array: repair.name,
				expectedTotal: repair.expectedTotal,
				firstPassRows: repair.actual,
				reason: repair.reason
			}, 'analyze-text: targeted coverage repair rejected')
			continue
		}
		replaceCoverageRows(source, repair.name, repair.rows)
		source._coverage.counts[repair.name] = {
			total: repair.expectedTotal,
			listed: repair.expectedTotal
		}
		logger.info({
			array: repair.name,
			total: repair.expectedTotal,
			firstPassRows: repair.actual
		}, 'analyze-text: targeted coverage repair completed')
	}
	return source
}

function factSchemaError(path, reason) {
	const error = new Error(`credit fact schema invalid at ${path}: ${reason}`)
	error.code = 'FACT_SCHEMA_INVALID'
	error.schemaPath = String(path || 'unknown').slice(0, 160)
	const reasonText = String(reason || 'unknown')
	const unexpectedKey = reasonText.match(/^unexpected key ([A-Za-z0-9_]+)$/)
	const rowLimit = reasonText.match(/^more than (\d+) rows$/)
	error.schemaReason = unexpectedKey
		? `unexpected_key:${unexpectedKey[1]}`
		: rowLimit
			? `more_than_${rowLimit[1]}_rows`
		: (
			[
				'object required',
				'array required',
				'required',
				'valid report date required',
				'total/listed mismatch',
				'partial input/output is not publishable'
			].includes(reasonText)
				? reasonText.replace(/\s+/g, '_')
				: 'redacted'
		)
	return error
}

function assertPlainObject(value, path) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw factSchemaError(path, 'object required')
	}
}

function assertAllowedKeys(value, allowed, path) {
	assertPlainObject(value, path)
	const allowedSet = new Set(allowed)
	for (const key of Object.keys(value)) {
		if (!allowedSet.has(key)) throw factSchemaError(path, `unexpected key ${key}`)
	}
}

function assertFactRows(value, fields, path, maxRows = 500) {
	if (!Array.isArray(value)) throw factSchemaError(path, 'array required')
	if (value.length > maxRows) throw factSchemaError(path, `more than ${maxRows} rows`)
	for (let index = 0; index < value.length; index++) {
		assertAllowedKeys(value[index], fields, `${path}[${index}]`)
		if (!hasMeaningfulFactRow(value[index])) {
			throw factSchemaError(`${path}[${index}]`, 'meaningful fact required')
		}
	}
}

/**
 * JSON Output 只保证语法合法；这里再执行严格结构门禁。
 * 任何越界派生字段、缺失数组或不完整 coverage 都必须失败，不能进入评分/缓存。
 */
function validateExtractedCreditFactsSchema(raw) {
	const source = raw
	assertAllowedKeys(source, [
		'meta', 'basic_info', 'loan_details', 'credit_card_details',
		'credit_card_details_cancelled', 'query_analysis', 'overdue_info',
		'public_records', 'guarantee_records', 'loan_history', '_coverage'
	], '$')
	for (const key of [
		'meta', 'basic_info', 'loan_details', 'query_analysis', 'overdue_info',
		'public_records', 'guarantee_records', 'loan_history', '_coverage'
	]) {
		if (!Object.prototype.hasOwnProperty.call(source, key)) {
			throw factSchemaError(`$.${key}`, 'required')
		}
		assertPlainObject(source[key], `$.${key}`)
	}
	for (const key of ['credit_card_details', 'credit_card_details_cancelled']) {
		if (!Object.prototype.hasOwnProperty.call(source, key)) {
			throw factSchemaError(`$.${key}`, 'required')
		}
	}

	assertAllowedKeys(source.meta, [
		'report_type', 'report_date', 'query_date', 'report_valid', 'report_no'
	], '$.meta')
	assertAllowedKeys(source.basic_info, [
		'name', 'age', 'gender', 'id_last4', 'marriage', 'phone_last4',
		'address_city', 'occupation', 'employer', 'report_date'
	], '$.basic_info')
	if (!parseDateMs(source.meta.report_date || source.basic_info.report_date)) {
		throw factSchemaError('$.meta.report_date', 'valid report date required')
	}
	assertAllowedKeys(source.loan_details, [
		'bank_loans', 'non_bank_loans', 'settled_loans', 'historical_overdue_loans'
	], '$.loan_details')

	const loanFields = [
		'seq', 'institution', 'credit_limit', 'balance', 'type', 'start_date',
		'end_date', 'status', 'monthly_payment', 'overdue_months', 'overdue_90_days', 'currency'
	]
	for (const name of [
		'bank_loans', 'non_bank_loans', 'settled_loans', 'historical_overdue_loans'
	]) {
		assertFactRows(source.loan_details[name], loanFields, `$.loan_details.${name}`)
	}
	const cardFields = [
		'seq', 'institution', 'credit_limit', 'used_limit', 'installment', 'status',
		'start_date', 'end_date', 'overdue_days', 'type', 'account_type', 'currency', 'card_tail'
	]
	assertFactRows(source.credit_card_details, cardFields, '$.credit_card_details')
	assertFactRows(
		source.credit_card_details_cancelled,
		cardFields,
		'$.credit_card_details_cancelled'
	)

	assertAllowedKeys(source.query_analysis, ['query_details', 'self_queries'], '$.query_analysis')
	assertFactRows(
		source.query_analysis.query_details,
		['institution', 'date', 'reason'],
		'$.query_analysis.query_details'
	)
	assertFactRows(
		source.query_analysis.self_queries,
		['date', 'channel'],
		'$.query_analysis.self_queries'
	)
	assertAllowedKeys(source.overdue_info, [
		'has_overdue', 'total_overdue_accounts', 'total_overdue_months',
		'overdue_30_days', 'overdue_60_days', 'overdue_90_days',
		'm1_count', 'm2_count', 'm3_count', 'max_overdue_days',
		'has_lian_san', 'has_lei_liu', 'details'
	], '$.overdue_info')
	assertFactRows(source.overdue_info.details, [
		'seq', 'institution', 'account', 'bank', 'type', 'account_type', 'date',
		'overdue_date', 'amount', 'overdue_amount', 'days', 'overdue_days',
		'months', 'overdue_months', 'level', 'desc', 'remark', 'status'
	], '$.overdue_info.details')
	assertAllowedKeys(source.public_records, ['has_record', 'items'], '$.public_records')
	assertFactRows(source.public_records.items, ['type', 'date', 'detail'], '$.public_records.items')
	assertAllowedKeys(source.guarantee_records, ['total_amount', 'items'], '$.guarantee_records')
	assertFactRows(
		source.guarantee_records.items,
		['guarantee_for', 'amount', 'start_date', 'status'],
		'$.guarantee_records.items'
	)
	assertAllowedKeys(source.loan_history, ['title', 'unit', 'trend_data'], '$.loan_history')
	assertFactRows(source.loan_history.trend_data, ['period', 'amount'], '$.loan_history.trend_data')

	assertAllowedKeys(source._coverage, [
		'source_text_length', 'sent_text_length', 'has_basic_info', 'has_loans',
		'has_cards', 'has_queries', 'has_overdue', 'has_public_records',
		'has_guarantee', 'truncated', 'notes', 'counts'
	], '$._coverage')
	assertPlainObject(source._coverage.counts, '$._coverage.counts')
	assertAllowedKeys(
		source._coverage.counts,
		Object.keys(FACT_COVERAGE_ARRAYS),
		'$._coverage.counts'
	)
	for (const [name, selectRows] of Object.entries(FACT_COVERAGE_ARRAYS)) {
		const count = source._coverage.counts[name]
		assertAllowedKeys(count, ['total', 'listed'], `$._coverage.counts.${name}`)
		const total = Number(count.total)
		const listed = Number(count.listed)
		const rows = selectRows(source)
		if (
			!Number.isInteger(total) ||
			!Number.isInteger(listed) ||
			total < 0 ||
			listed < 0 ||
			!Array.isArray(rows) ||
			listed !== rows.length ||
			total !== listed
		) {
			throw factSchemaError(`$._coverage.counts.${name}`, 'total/listed mismatch')
		}
	}
	if (source._coverage.truncated === true) {
		throw factSchemaError('$._coverage.truncated', 'partial input/output is not publishable')
	}
	return true
}

function normalizeCoverageCounts(value) {
	const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
	const out = {}
	for (const name of Object.keys(FACT_COVERAGE_ARRAYS)) {
		const count = source[name] && typeof source[name] === 'object' ? source[name] : {}
		out[name] = {
			total: Math.max(0, Math.trunc(Number(count.total) || 0)),
			listed: Math.max(0, Math.trunc(Number(count.listed) || 0))
		}
	}
	return out
}

function normalizeFactScalar(value) {
	return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value
}

function stableFactRows(rows) {
	const normalized = asArray(rows).map((row) => {
		const out = {}
		for (const key of Object.keys(row).sort()) out[key] = normalizeFactScalar(row[key])
		return out
	})
	return normalized
		.sort((a, b) => {
			const aKey = JSON.stringify(a)
			const bKey = JSON.stringify(b)
			return aKey.localeCompare(bKey, 'zh-CN')
		})
}

function canonicalizeExtractedCreditFacts(data) {
	const ld = data.loan_details || {}
	for (const key of [
		'bank_loans', 'non_bank_loans', 'settled_loans', 'historical_overdue_loans'
	]) {
		ld[key] = stableFactRows(ld[key])
	}
	data.credit_card_details = stableFactRows(data.credit_card_details)
	data.credit_card_details_cancelled = stableFactRows(data.credit_card_details_cancelled)
	data.query_analysis.query_details = stableFactRows(data.query_analysis.query_details)
	data.query_analysis.self_queries = stableFactRows(data.query_analysis.self_queries)
	data.overdue_info.details = stableFactRows(data.overdue_info.details)
	data.public_records.items = stableFactRows(data.public_records.items)
	data.guarantee_records.items = stableFactRows(data.guarantee_records.items)
	data.loan_history.trend_data = stableFactRows(data.loan_history.trend_data)
	const notes = String(data._coverage.notes || '')
		.split(/[；;]/)
		.map((item) => item.trim())
		.filter(Boolean)
		.sort((a, b) => a.localeCompare(b, 'zh-CN'))
	data._coverage.notes = [...new Set(notes)].join('；')
	return data
}

function chunkMergeError(code, path) {
	const error = new Error(code)
	error.code = code
	error.schemaPath = path
	return error
}

function mergeChunkScalarObjects(chunks, select, path, policies = {}) {
	const merged = {}
	for (const chunk of chunks) {
		const source = select(chunk)
		if (!source || typeof source !== 'object' || Array.isArray(source)) continue
		for (const [key, value] of Object.entries(source)) {
			if (!isMeaningfulFactValue(value)) continue
			if (!Object.prototype.hasOwnProperty.call(merged, key)) {
				merged[key] = value
				continue
			}
			const previous = normalizeFactScalar(merged[key])
			const next = normalizeFactScalar(value)
			if (JSON.stringify(previous) !== JSON.stringify(next)) {
				if (policies[key] === 'boolean-or' && typeof previous === 'boolean' && typeof next === 'boolean') {
					merged[key] = previous || next
					continue
				}
				throw chunkMergeError('CHUNK_SCALAR_CONFLICT', `${path}.${key}`)
			}
		}
	}
	return merged
}

function chunkNumericMaximum(chunks, select, fallback = null) {
	const values = chunks
		.map((chunk) => Number(select(chunk)))
		.filter((value) => Number.isFinite(value) && value >= 0)
	if (Number.isFinite(fallback) && fallback >= 0) values.push(fallback)
	return values.length ? Math.max(...values) : null
}

/**
 * Merge already-validated, non-overlapping chunk facts. Query rows are never
 * content-deduplicated because identical institution/date/reason rows can be
 * separate legitimate queries. Coverage totals are the sum of every complete
 * chunk and must equal the merged row count.
 */
function mergeExtractedCreditFactChunks(chunks) {
	if (!Array.isArray(chunks) || !chunks.length) {
		throw chunkMergeError('CHUNK_FACTS_MISSING', '$')
	}
	for (const chunk of chunks) validateExtractedCreditFactsSchema(chunk)

	const merged = {
		meta: mergeChunkScalarObjects(chunks, (chunk) => chunk.meta, '$.meta', {
			report_valid: 'boolean-or'
		}),
		basic_info: mergeChunkScalarObjects(chunks, (chunk) => chunk.basic_info, '$.basic_info'),
		loan_details: {
			bank_loans: [],
			non_bank_loans: [],
			settled_loans: [],
			historical_overdue_loans: []
		},
		credit_card_details: [],
		credit_card_details_cancelled: [],
		query_analysis: { query_details: [], self_queries: [] },
		// 分块中的“有无/合计”是片段级判断，不能像报告级标量一样要求每块相等。
		// 先只合并原始明细，下面再以明细和各块显式值生成保守的报告级汇总。
		overdue_info: { details: [] },
		public_records: { items: [] },
		guarantee_records: { items: [] },
		loan_history: {
			...mergeChunkScalarObjects(
				chunks,
				(chunk) => {
					const { trend_data: trendData, ...values } = chunk.loan_history || {}
					return values
				},
				'$.loan_history'
			),
			trend_data: []
		},
		_coverage: {
			has_basic_info: chunks.some((chunk) => chunk._coverage?.has_basic_info === true),
			has_loans: chunks.some((chunk) => chunk._coverage?.has_loans === true),
			has_cards: chunks.some((chunk) => chunk._coverage?.has_cards === true),
			has_queries: chunks.some((chunk) => chunk._coverage?.has_queries === true),
			has_overdue: chunks.some((chunk) => chunk._coverage?.has_overdue === true),
			has_public_records: chunks.some((chunk) => chunk._coverage?.has_public_records === true),
			has_guarantee: chunks.some((chunk) => chunk._coverage?.has_guarantee === true),
			truncated: false,
			counts: {},
			notes: [...new Set(
				chunks.flatMap((chunk) => String(chunk._coverage?.notes || '').split(/[；;]/))
					.map((item) => item.trim())
					.filter(Boolean)
			)].sort((a, b) => a.localeCompare(b, 'zh-CN')).join('；')
		}
	}

	for (const [name, selectRows] of Object.entries(FACT_COVERAGE_ARRAYS)) {
		const rows = chunks.flatMap((chunk) => asArray(selectRows(chunk)))
		const expected = chunks.reduce(
			(total, chunk) => total + Number(chunk._coverage?.counts?.[name]?.total || 0),
			0
		)
		if (expected !== rows.length) {
			throw chunkMergeError('CHUNK_COVERAGE_MISMATCH', `$._coverage.counts.${name}`)
		}
		if (hasDuplicateRepairRows(name, rows)) {
			throw chunkMergeError('CHUNK_FACT_CONFLICT', `$.${name}`)
		}
		replaceCoverageRows(merged, name, rows)
		merged._coverage.counts[name] = { total: expected, listed: rows.length }
	}

	const overdueDetails = merged.overdue_info.details
	const overdueMonthSum = overdueDetails.reduce(
		(total, row) => total + Math.max(0, Number(row.overdue_months ?? row.months) || 0),
		0
	)
	const overdueDayMax = overdueDetails.reduce(
		(maximum, row) => Math.max(maximum, Number(row.overdue_days ?? row.days) || 0),
		0
	)
	merged.overdue_info.has_overdue = overdueDetails.length > 0 ||
		chunks.some((chunk) => chunk.overdue_info?.has_overdue === true)
	merged.overdue_info.has_lian_san = chunks.some((chunk) => chunk.overdue_info?.has_lian_san === true)
	merged.overdue_info.has_lei_liu = chunks.some((chunk) => chunk.overdue_info?.has_lei_liu === true)
	const overdueNumericFallbacks = {
		total_overdue_accounts: overdueDetails.length,
		total_overdue_months: overdueMonthSum,
		max_overdue_days: overdueDayMax
	}
	for (const key of [
		'total_overdue_accounts', 'total_overdue_months', 'overdue_30_days',
		'overdue_60_days', 'overdue_90_days', 'm1_count', 'm2_count', 'm3_count',
		'max_overdue_days'
	]) {
		const value = chunkNumericMaximum(
			chunks,
			(chunk) => chunk.overdue_info?.[key],
			overdueNumericFallbacks[key]
		)
		if (value !== null) merged.overdue_info[key] = value
	}

	merged.public_records.has_record = merged.public_records.items.length > 0 ||
		chunks.some((chunk) => chunk.public_records?.has_record === true)
	const guaranteeItemTotal = merged.guarantee_records.items.reduce(
		(total, row) => total + Math.max(0, Number(row.amount) || 0),
		0
	)
	const guaranteeTotal = chunkNumericMaximum(
		chunks,
		(chunk) => chunk.guarantee_records?.total_amount,
		guaranteeItemTotal
	)
	if (guaranteeTotal !== null) merged.guarantee_records.total_amount = guaranteeTotal

	validateExtractedCreditFactsSchema(merged)
	return merged
}

/**
 * DeepSeek 输出边界：只允许原始事实进入规则引擎。
 * 即使模型越界返回汇总、共享额度、风险或评分字段，也会在这里被丢弃。
 */
function sanitizeExtractedCreditFacts(raw) {
	const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
	const meta = pickFactFields(source.meta, [
		'report_type', 'report_date', 'query_date', 'report_valid', 'report_no'
	])
	const basicInfo = pickFactFields(source.basic_info, [
		'name', 'age', 'gender', 'id_last4', 'marriage', 'phone_last4',
		'address_city', 'occupation', 'employer', 'report_date'
	])
	const loanFields = [
		'seq', 'institution', 'credit_limit', 'balance', 'type', 'start_date',
		'end_date', 'status', 'monthly_payment', 'overdue_months', 'overdue_90_days', 'currency'
	]
	const cardFields = [
		'seq', 'institution', 'credit_limit', 'used_limit', 'installment', 'status',
		'start_date', 'end_date', 'overdue_days', 'type', 'account_type', 'currency', 'card_tail'
	]
	const queryFields = ['institution', 'date', 'reason']
	const overdueDetailFields = [
		'seq', 'institution', 'account', 'bank', 'type', 'account_type', 'date',
		'overdue_date', 'amount', 'overdue_amount', 'days', 'overdue_days',
		'months', 'overdue_months', 'level', 'desc', 'remark', 'status'
	]
	const ld = source.loan_details && typeof source.loan_details === 'object'
		? source.loan_details
		: {}
	const qa = source.query_analysis && typeof source.query_analysis === 'object'
		? source.query_analysis
		: {}
	const overdue = source.overdue_info && typeof source.overdue_info === 'object'
		? source.overdue_info
		: {}
	const publicRecords = source.public_records && typeof source.public_records === 'object'
		? source.public_records
		: {}
	const guarantees = source.guarantee_records && typeof source.guarantee_records === 'object'
		? source.guarantee_records
		: {}
	const history = source.loan_history && typeof source.loan_history === 'object'
		? source.loan_history
		: {}

	const result = {
		meta,
		basic_info: basicInfo,
		loan_details: {
			bank_loans: pickFactRows(ld.bank_loans, loanFields),
			non_bank_loans: pickFactRows(ld.non_bank_loans, loanFields),
			settled_loans: pickFactRows(ld.settled_loans, loanFields),
			historical_overdue_loans: pickFactRows(ld.historical_overdue_loans, loanFields)
		},
		credit_card_details: pickFactRows(source.credit_card_details, cardFields),
		credit_card_details_cancelled: pickFactRows(source.credit_card_details_cancelled, cardFields),
		query_analysis: {
			query_details: pickFactRows(qa.query_details, queryFields),
			self_queries: pickFactRows(qa.self_queries, ['date', 'channel'])
		},
		overdue_info: {
			...pickFactFields(overdue, [
				'has_overdue', 'total_overdue_accounts', 'total_overdue_months',
				'overdue_30_days', 'overdue_60_days', 'overdue_90_days',
				'm1_count', 'm2_count', 'm3_count', 'max_overdue_days',
				'has_lian_san', 'has_lei_liu'
			]),
			details: pickFactRows(overdue.details, overdueDetailFields)
		},
		public_records: {
			...pickFactFields(publicRecords, ['has_record']),
			items: pickFactRows(publicRecords.items, ['type', 'date', 'detail'])
		},
		guarantee_records: {
			...pickFactFields(guarantees, ['total_amount']),
			items: pickFactRows(guarantees.items, [
				'guarantee_for', 'amount', 'start_date', 'status'
			])
		},
		loan_history: {
			...pickFactFields(history, ['title', 'unit']),
			trend_data: pickFactRows(history.trend_data, ['period', 'amount'])
		},
		_coverage: pickFactFields(source._coverage, [
			'source_text_length', 'sent_text_length', 'has_basic_info', 'has_loans',
			'has_cards', 'has_queries', 'has_overdue', 'has_public_records',
			'has_guarantee', 'truncated', 'notes', 'salvaged_truncated',
			'llm_finish_reason', 'llm_output_truncated'
		])
	}
	result._coverage.counts = normalizeCoverageCounts(source._coverage && source._coverage.counts)
	result._coverage.counts_declared = !!(
		source._coverage &&
		source._coverage.counts &&
		typeof source._coverage.counts === 'object' &&
		!Array.isArray(source._coverage.counts)
	)
	return canonicalizeExtractedCreditFacts(result)
}

function appendCoverageNote(data, note) {
	if (!data || typeof data !== 'object' || !note) return
	const cov = ensureObject(data, '_coverage')
	const prev = String(cov.notes || '').trim()
	if (prev.split(/[；;]/).map((item) => item.trim()).includes(note)) return
	cov.notes = prev ? `${prev}；${note}` : note
}

function removeCoverageNotes(data, matcher) {
	if (!data || typeof data !== 'object' || typeof matcher !== 'function') return
	const cov = ensureObject(data, '_coverage')
	const notes = String(cov.notes || '').split(/[；;]/).map((item) => item.trim()).filter(Boolean)
	if (!notes.length) return
	cov.notes = notes.filter((note) => !matcher(note)).join('；')
}

// 否定盲区修复：`未结清`/`尚未销户` 等否定短语包含闭户关键词，
// 简单包含匹配会把活跃账户误判为已关闭并清零其余额。任何出现
// 否定闭户短语的状态一律按未关闭处理（保守方向：保留余额交由
// 证据绑定层核验，而不是静默清零）。
function hasNegatedClosedStatusPhrase(status) {
	return /(?:未|尚未|非)\s*(?:结清|还清|销户|注销|关闭|销卡|作废|终止|结转|解除|失效)/u.test(String(status || ''))
}

function isCancelledCardStatus(status) {
	const text = String(status || '')
	if (hasNegatedClosedStatusPhrase(text)) return false
	return /销户|注销|关闭|销卡|作废|已结清|结清/.test(text)
}

function isClosedLoanStatus(status) {
	const text = String(status || '')
	if (hasNegatedClosedStatusPhrase(text)) return false
	return /已?结清|销户|注销|关闭|作废|终止|结转/.test(text)
}

function loanCurrencyCode(value) {
	const text = String(value == null ? '' : value).normalize('NFKC').trim().toUpperCase()
	if (!text || /人民币|\bCNY\b|\bRMB\b/.test(text)) return 'CNY'
	if (/美元|美金|\bUSD\b/.test(text)) return 'USD'
	if (/欧元|\bEUR\b/.test(text)) return 'EUR'
	if (/日元|\bJPY\b/.test(text)) return 'JPY'
	if (/港币|港元|\bHKD\b/.test(text)) return 'HKD'
	return text.slice(0, 12)
}

function isCnyLoanRow(row) {
	return loanCurrencyCode(row && (row.currency || row.currency_code)) === 'CNY'
}

function isDebtBearingLoanRow(row) {
	if (!row || typeof row !== 'object') return false
	if (isClosedLoanStatus(row.status)) return false
	if (!isCnyLoanRow(row)) return false
	return safeNum(row.balance ?? row.remaining_balance) > 0
}

function deterministicLoanInstitutionType(row) {
	// The model-provided array name and institution_type are extraction hints,
	// not authoritative risk facts.  Classify from the source institution name
	// only so moving an identical row between model arrays cannot change score.
	return classifyLoanInstitution(row)
}

function normalizeLoanRowsForDebt(rows) {
	return asArray(rows).map((row) => {
		const next = {
			...row,
			institution_type: deterministicLoanInstitutionType(row)
		}
		if (isClosedLoanStatus(next.status)) {
			next.balance = 0
			next.remaining_balance = 0
			next.is_settled = true
			next.debt_excluded_reason = '已结清/已关闭，不计入当前负债'
			return next
		}
		if (!isCnyLoanRow(next)) {
			next.debt_excluded_reason = '纯外币贷款无人民币等值，不计入人民币负债'
			return next
		}
		const balance = safeNum(next.balance ?? next.remaining_balance)
		if (balance <= 0) {
			next.balance = 0
			next.remaining_balance = 0
			next.debt_excluded_reason = '余额为0，不计入当前负债'
		}
		return next
	})
}

function uniqueRows(rows) {
	const seen = new Set()
	const out = []
	for (const row of rows) {
		const key = [
			row.seq,
			row.institution || row.bank || '',
			row.start_date || row.open_date || '',
			row.end_date || '',
			safeNum(row.credit_limit ?? row.limit),
			safeNum(row.used_limit ?? row.used_amount),
			row.status || ''
		].join('|')
		if (seen.has(key)) continue
		seen.add(key)
		out.push(row)
	}
	return out
}

function institutionKind(rowOrInstitution, fallbackType = '') {
	return classifyInstitution(rowOrInstitution, { fallbackType })
}

function institutionIdentityKey(value) {
	return String(value || '').normalize('NFKC').replace(/\s+/g, '').trim()
}

function normalizeCreditSourceText(text) {
	return String(text || '')
		.replace(/第\s*\d+\s*页\s*[，,\/]?\s*共\s*\d+\s*页/g, '')
		.replace(/\s+/g, '')
		.trim()
}

function parseCreditSourceAmount(amount, unit = '') {
	const raw = `${amount || ''}${unit || ''}`
	const n = safeNum(raw)
	return roundMoney(n)
}

function normalizeDateText(value) {
	const raw = String(value || '').replace(/\s+/g, '').trim()
	const m = raw.match(/(\d{4})[年\-/.](\d{1,2})(?:[月\-/.](\d{1,2}))?/)
	if (!m) return ''
	const yyyy = m[1]
	const mm = String(Number(m[2])).padStart(2, '0')
	const dd = String(Number(m[3] || 1)).padStart(2, '0')
	return `${yyyy}-${mm}-${dd}`
}

function maskReportName(name) {
	const clean = String(name || '').replace(/[^\u4e00-\u9fa5·]/g, '').trim()
	if (!clean) return ''
	if (clean.length === 1) return clean
	return `${clean[0]}${'*'.repeat(Math.min(2, clean.length - 1))}`
}

function ageFromIdentity(idCard, reportDate) {
	const id = String(idCard || '').trim()
	const m = id.match(/^(\d{6})(\d{4})(\d{2})(\d{2})\d{3}[\dXx]$/)
	if (!m) return null
	const y = Number(m[2])
	const mo = Number(m[3])
	const d = Number(m[4])
	const anchor = reportDate ? new Date(`${reportDate}T00:00:00Z`) : null
	if (!y || !mo || !d || !anchor || Number.isNaN(anchor.getTime())) return null
	let age = anchor.getUTCFullYear() - y
	const anchorMonth = anchor.getUTCMonth() + 1
	const anchorDay = anchor.getUTCDate()
	if (anchorMonth < mo || (anchorMonth === mo && anchorDay < d)) age -= 1
	return age >= 18 && age <= 100 ? age : null
}

function isValidChineseIdentity(value) {
	const id = String(value || '').replace(/\s+/g, '').toUpperCase()
	if (!/^\d{17}[\dX]$/.test(id)) return false
	const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
	const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2']
	let sum = 0
	for (let index = 0; index < 17; index += 1) sum += Number(id[index]) * weights[index]
	return checks[sum % 11] === id[17]
}

function extractRawOwnershipProof(sourceText) {
	const raw = String(sourceText || '')
	const secondPageIndex = raw.indexOf('【第2页】')
	const firstPageRegion = secondPageIndex >= 0 ? raw.slice(0, secondPageIndex) : raw.slice(0, 6000)
	const compact = normalizeCreditSourceText(firstPageRegion)
	if (!compact) return { rawName: '', fullId: '', complete: false }

	const names = new Set()
	const identities = new Set()
	const namePattern = /姓名[：:]?([\u3400-\u9fff·]{2,8})(?=证件类型|证件号码|身份证|婚姻|未婚|已婚|报告|$)/gu
	const identityPattern = /(?:证件号码|身份证号码|公民身份号码)[：:]?([1-9]\d{16}[0-9Xx])/g
	let match
	while ((match = namePattern.exec(compact)) !== null) names.add(match[1])
	while ((match = identityPattern.exec(compact)) !== null) {
		const identity = match[1].toUpperCase()
		if (isValidChineseIdentity(identity)) identities.add(identity)
	}

	const rawName = names.size === 1 ? [...names][0] : ''
	const fullId = identities.size === 1 ? [...identities][0] : ''
	return { rawName, fullId, complete: Boolean(rawName && fullId) }
}

function extractSourceBasicInfo(sourceText) {
	const compact = normalizeCreditSourceText(sourceText)
	if (!compact) return {}
	const reportDate = (() => {
		const m =
			compact.match(/报告时间[：:]?(\d{4}-\d{1,2}-\d{1,2})/) ||
			compact.match(/查询日期[：:]?(\d{4}[年\-/.]\d{1,2}[月\-/.]\d{1,2})/) ||
			compact.match(/报告生成时间[：:]?(\d{4}-\d{1,2}-\d{1,2})/)
		return m ? normalizeDateText(m[1]) : ''
	})()
	const idCard = (() => {
		const m = compact.match(/证件号码[：:]?([0-9]{17}[0-9Xx])/)
		return m ? m[1] : ''
	})()
	const rawName = (() => {
		const m = compact.match(/姓名[：:]?([\u4e00-\u9fa5·]{1,8})(?=证件类型|证件号码|婚姻|未婚|已婚|报告|$)/)
		if (m) return m[1]
		const fallback = compact.match(/姓名[：:]?([\u4e00-\u9fa5·]{1,4})/)
		return fallback ? fallback[1] : ''
	})()
	const explicitAge = (() => {
		const m = compact.match(/年龄[：:]?(\d{1,3})/)
		const n = m ? Number(m[1]) : null
		return n && n >= 18 && n <= 100 ? n : null
	})()
	const derivedAge = ageFromIdentity(idCard, reportDate)
	return {
		name: maskReportName(rawName),
		id_last4: idCard ? idCard.slice(-4) : '',
		age: derivedAge || explicitAge || null,
		report_date: reportDate
	}
}

function normalizeOwnershipCandidate(candidateValue) {
	const value = candidateValue && typeof candidateValue === 'object' ? candidateValue : {}
	const name = String(value.name || '').replace(/\s+/g, '').trim()
	const fullId = String(value.fullId || value.full_id || '').replace(/\s+/g, '').toUpperCase()
	const nameConfidence = Number(value.nameConfidence ?? value.name_confidence)
	const identityConfidence = Number(value.identityConfidence ?? value.identity_confidence)
	const valid =
		/^[\u3400-\u9fff·]{2,8}$/u.test(name) &&
		isValidChineseIdentity(fullId) &&
		Number.isFinite(nameConfidence) && nameConfidence >= 0.9 &&
		Number.isFinite(identityConfidence) && identityConfidence >= 0.9
	return { name, fullId, nameConfidence, identityConfidence, valid }
}

function resolveFirstPageOwnershipEvidence(firstPageText, candidateValue = null, options = {}) {
	const source = String(firstPageText || '').trim()
	const initial = extractRawOwnershipProof(source)
	const candidate = normalizeOwnershipCandidate(candidateValue)
	const forceCandidateCheck = options.forceCandidateCheck === true

	if (initial.complete && !forceCandidateCheck) {
		return { text: source, proof: initial, rescued: false, reason: 'already-complete' }
	}
	if (!initial.fullId) {
		return { text: source, proof: initial, rescued: false, reason: 'first-page-identity-missing' }
	}
	if (!candidate.valid) {
		return { text: source, proof: initial, rescued: false, reason: 'candidate-incomplete' }
	}
	if (candidate.fullId !== initial.fullId) {
		return { text: source, proof: initial, rescued: false, reason: 'identity-mismatch' }
	}
	if (initial.rawName && candidate.name !== initial.rawName) {
		return { text: source, proof: initial, rescued: false, reason: 'name-mismatch' }
	}
	if (initial.complete) {
		return { text: source, proof: initial, rescued: false, reason: 'candidate-confirmed' }
	}

	const merged = `姓名：${candidate.name}\n证件号码：${candidate.fullId}\n${source}`.trim()
	const proof = extractRawOwnershipProof(merged)
	if (!proof.complete || proof.fullId !== initial.fullId) {
		return { text: source, proof: initial, rescued: false, reason: 'candidate-incomplete' }
	}
	return { text: merged, proof, rescued: true, reason: 'secondary-header' }
}

function assertReportOwnershipEvidence(sourceText) {
	const proof = extractRawOwnershipProof(sourceText)
	if (proof.complete) return proof
	throw buildIncompleteOcrError('ownership', {
		message: '扫描件首页身份信息识别不完整，已停止分析。请重新上传原始 PDF，或改用清晰的首页及完整报告截图。'
	})
}

async function secureScannedFirstPageOwnership({ firstPageText, firstPageImageBase64, recognizeOwnership }) {
	const initial = resolveFirstPageOwnershipEvidence(firstPageText)
	if (initial.proof.complete) return initial
	if (!initial.proof.fullId) assertReportOwnershipEvidence(initial.text)

	let candidate = null
	try {
		const image = Buffer.from(String(firstPageImageBase64 || ''), 'base64')
		candidate = await recognizeOwnership(image)
	} catch (err) {
		logger.warn(
			{ code: safeErrorCode(err, 'RAPIDOCR_FAILED') },
			'scanned-pdf: first-page ownership rescue unavailable'
		)
		assertReportOwnershipEvidence(initial.text)
	}

	const resolved = resolveFirstPageOwnershipEvidence(firstPageText, candidate)
	if (!resolved.proof.complete) assertReportOwnershipEvidence(resolved.text)
	logger.info({ rescued: true }, 'scanned-pdf: first-page ownership evidence rescued')
	return resolved
}

function sourceLines(sourceText) {
	return String(sourceText || '')
		.split(/\r?\n/)
		.map((line) => line.replace(/[|｜]/g, ' ').replace(/\s+/g, ' ').trim())
		.filter(Boolean)
}

const TEXT_ACCOUNT_OVERVIEW_ROW_ORDER = Object.freeze([
	'total',
	'open',
	'overdue',
	'overdue90'
])

const TEXT_ACCOUNT_OVERVIEW_ROW_PATTERNS = Object.freeze([
	['overdue90', /^发生过90天以上逾期的账户数\s+((?:\d{1,3}|-{1,2}|—))\s+((?:\d{1,3}|-{1,2}|—))\s+((?:\d{1,3}|-{1,2}|—))\s+((?:\d{1,3}|-{1,2}|—))$/u],
	['overdue', /^发生过逾期的账户数\s+((?:\d{1,3}|-{1,2}|—))\s+((?:\d{1,3}|-{1,2}|—))\s+((?:\d{1,3}|-{1,2}|—))\s+((?:\d{1,3}|-{1,2}|—))$/u],
	['open', /^未结清\s*\/\s*未销户账户数\s+((?:\d{1,3}|-{1,2}|—))\s+((?:\d{1,3}|-{1,2}|—))\s+((?:\d{1,3}|-{1,2}|—))\s+((?:\d{1,3}|-{1,2}|—))$/u],
	['total', /^账户数\s+((?:\d{1,3}|-{1,2}|—))\s+((?:\d{1,3}|-{1,2}|—))\s+((?:\d{1,3}|-{1,2}|—))\s+((?:\d{1,3}|-{1,2}|—))$/u]
])

function parseTextAccountOverviewRow(line) {
	const text = String(line || '')
		.replace(/[|｜]/gu, ' ')
		.replace(/\s+/gu, ' ')
		.trim()
	for (const [key, pattern] of TEXT_ACCOUNT_OVERVIEW_ROW_PATTERNS) {
		const match = text.match(pattern)
		if (!match) continue
		return {
			key,
			values: match.slice(1, 5).map((value) => /^\d+$/u.test(value) ? Number(value) : 0)
		}
	}
	return null
}

function textAccountOverviewHeaderSpans(lines) {
	const spans = []
	for (let start = 0; start < lines.length; start += 1) {
		let compact = ''
		for (let end = start; end < Math.min(lines.length, start + 4); end += 1) {
			compact += String(lines[end] || '').replace(/[|｜\s]/gu, '')
			if (/^信用卡(?:购房|住房)贷款其他贷款其他(?:业务)?$/u.test(compact)) {
				spans.push({ start, end })
				break
			}
		}
	}
	return spans
}

function textAccountOverviewEvidence(sourceText) {
	const source = String(sourceText || '')
	const overviewStart = source.indexOf('信息概要')
	const detailStart = source.indexOf('信贷交易信息明细')
	const overviewSection = overviewStart >= 0
		? source.slice(overviewStart, detailStart > overviewStart ? detailStart : undefined)
		: ''
	const lines = sourceLines(overviewSection)
	// 账户概要只能作为补充完整性门禁。每个候选必须位于已证明的官方
	// 四列表头之后，并且四行标签按固定顺序完整出现。这样同一概要页中
	// 更早的无关“账户数”行不能劫持后面的官方表。
	const headerSpans = textAccountOverviewHeaderSpans(lines)
	const candidates = []
	for (const [headerIndex, header] of headerSpans.entries()) {
		const nextHeaderStart = headerSpans[headerIndex + 1]?.start ?? lines.length
		const rows = lines
			.slice(header.end + 1, nextHeaderStart)
			.map(parseTextAccountOverviewRow)
			.filter(Boolean)
		for (let index = 0; index <= rows.length - TEXT_ACCOUNT_OVERVIEW_ROW_ORDER.length; index += 1) {
			const candidateRows = rows.slice(index, index + TEXT_ACCOUNT_OVERVIEW_ROW_ORDER.length)
			if (candidateRows.some((row, rowIndex) => row.key !== TEXT_ACCOUNT_OVERVIEW_ROW_ORDER[rowIndex])) continue
			candidates.push(Object.fromEntries(candidateRows.map((row) => [row.key, row.values])))
		}
	}
	if (candidates.length === 0) return null
	if (candidates.length > 1) {
		const error = chunkMergeError('CHUNK_SOURCE_OVERVIEW_MISMATCH', '$.source.account_overview')
		error.expectedCount = 1
		error.actualCount = candidates.length
		throw error
	}
	const { total: totalNums, open: openNums, overdue: overdueNums, overdue90: overdue90Nums } = candidates[0]
	const at = (arr, index) => arr[index]
	return { overview: {
		credit_card: {
			total_count: at(totalNums, 0),
			open_count: at(openNums, 0),
			overdue_count: at(overdueNums, 0),
			overdue_90_count: at(overdue90Nums, 0)
		},
		mortgage_loan: {
			total_count: at(totalNums, 1),
			open_count: at(openNums, 1),
			overdue_count: at(overdueNums, 1),
			overdue_90_count: at(overdue90Nums, 1)
		},
		other_loan: {
			total_count: at(totalNums, 2),
			open_count: at(openNums, 2),
			overdue_count: at(overdueNums, 2),
			overdue_90_count: at(overdue90Nums, 2)
		},
		other_business: {
			total_count: at(totalNums, 3),
			open_count: at(openNums, 3),
			overdue_count: at(overdueNums, 3),
			overdue_90_count: at(overdue90Nums, 3)
		}
	}, basis: 'source-account-overview-text-v1' }
}

function overviewRect(value) {
	if (!Array.isArray(value) || value.length < 4) return null
	const rect = value.slice(0, 4).map(Number)
	return rect.every(Number.isFinite) && rect[2] > rect[0] && rect[3] > rect[1] ? rect : null
}

function overviewVerticalOverlap(left, right) {
	const a = overviewRect(left)
	const b = overviewRect(right)
	if (!a || !b) return 0
	const overlap = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
	return overlap / Math.max(1e-9, Math.min(a[3] - a[1], b[3] - b[1]))
}

function geometryAccountOverviewEvidence(documentMeta) {
	const pages = Array.isArray(documentMeta?.pages) ? documentMeta.pages : []
	const candidates = []
	for (const page of pages) {
		if (!/信息\s*概\s*要/u.test(String(page?.text || ''))) continue
		const lines = []
		for (const block of Array.isArray(page?.blocks) ? page.blocks : []) {
			const sourceLines = Array.isArray(block?.lines) && block.lines.length ? block.lines : [block]
			for (const line of sourceLines) {
				const text = String(line?.text || '').replace(/\s+/gu, '').trim()
				const bbox = overviewRect(line?.bbox)
				if (text && bbox) lines.push({ text, bbox })
			}
		}
		const rowLabels = [
			['total', '账户数'],
			['open', '未结清/未销户账户数'],
			['overdue', '发生过逾期的账户数'],
			['overdue90', '发生过90天以上逾期的账户数']
		]
		// Some official layouts contain an earlier, unrelated `账户数` row on
		// the same page. Build candidates around each total row, then require one
		// and only one complete four-row table with the official column headers.
		for (const totalLabel of lines.filter((line) => line.text === '账户数')) {
			const tableTop = totalLabel.bbox[1]
			const tableBottom = tableTop + 100
			const rows = {}
			let invalid = false
			for (const [key, label] of rowLabels) {
				const labelLines = key === 'total'
					? [totalLabel]
					: lines.filter((line) =>
						line.text === label && line.bbox[1] >= tableTop && line.bbox[1] <= tableBottom
					)
				if (labelLines.length !== 1) {
					invalid = true
					break
				}
				const labelLine = labelLines[0]
				const cells = lines.filter((line) =>
					/^(?:\d{1,3}|--|—)$/u.test(line.text) &&
					line.bbox[0] > labelLine.bbox[2] &&
					overviewVerticalOverlap(line.bbox, labelLine.bbox) >= 0.8
				).sort((left, right) => left.bbox[0] - right.bbox[0])
				if (cells.length !== 4) {
					invalid = true
					break
				}
				rows[key] = {
					label: labelLine,
					centers: cells.map((cell) => (cell.bbox[0] + cell.bbox[2]) / 2),
					values: cells.map((cell) => /^\d+$/u.test(cell.text) ? Number(cell.text) : 0)
				}
			}
			if (invalid) continue
			const columns = rows.total.centers
			if (Object.values(rows).some((row) => row.centers.some((center, index) => Math.abs(center - columns[index]) > 12))) continue
			const headers = lines.filter((line) => line.bbox[3] < tableTop && line.bbox[1] >= tableTop - 120)
			const nearColumn = (texts, center, tolerance = 26) => headers.some((line) =>
				texts.includes(line.text) && Math.abs(((line.bbox[0] + line.bbox[2]) / 2) - center) <= tolerance
			)
			const cardHeader = nearColumn(['信用卡'], columns[0])
			const otherBusinessHeader = nearColumn(['其他业务'], columns[3])
			const directLoanHeaders =
				nearColumn(['购房贷款', '住房贷款'], columns[1]) && nearColumn(['其他贷款'], columns[2])
			const nestedLoanHeaders =
				nearColumn(['贷款'], (columns[1] + columns[2]) / 2, 32) &&
				nearColumn(['购房', '住房'], columns[1]) && nearColumn(['其他'], columns[2])
			if (!cardHeader || !otherBusinessHeader || (!directLoanHeaders && !nestedLoanHeaders)) continue
			const at = (name, index) => rows[name].values[index]
			candidates.push({
				overview: {
					credit_card: { total_count: at('total', 0), open_count: at('open', 0), overdue_count: at('overdue', 0), overdue_90_count: at('overdue90', 0) },
					mortgage_loan: { total_count: at('total', 1), open_count: at('open', 1), overdue_count: at('overdue', 1), overdue_90_count: at('overdue90', 1) },
					other_loan: { total_count: at('total', 2), open_count: at('open', 2), overdue_count: at('overdue', 2), overdue_90_count: at('overdue90', 2) },
					other_business: { total_count: at('total', 3), open_count: at('open', 3), overdue_count: at('overdue', 3), overdue_90_count: at('overdue90', 3) }
				},
				basis: 'source-account-overview-pdf-geometry-v2'
			})
		}
	}
	return candidates.length === 1 ? candidates[0] : null
}

function extractSourceAccountOverviewEvidence(sourceText, documentMeta = null) {
	return geometryAccountOverviewEvidence(documentMeta) || textAccountOverviewEvidence(sourceText)
}

function extractSourceAccountOverview(sourceText, documentMeta = null) {
	return extractSourceAccountOverviewEvidence(sourceText, documentMeta)?.overview || null
}

function assertSourceAccountOverviewCoverage(data, sourceText, documentMeta = null) {
	const overview = extractSourceAccountOverview(sourceText, documentMeta)
	if (!overview) return true
	const cardRows = asArray(data?.credit_card_details)
	const activeCards = cardRows.filter((row) => !isCancelledCardStatus(row.status)).length
	const cancelledCards = asArray(data?.credit_card_details_cancelled).length
	const bankLoanRows = asArray(data?.loan_details?.bank_loans)
	const nonBankLoanRows = asArray(data?.loan_details?.non_bank_loans)
	const bankLoans = bankLoanRows.length
	const nonBankLoans = nonBankLoanRows.length
	const activeLoans = [...bankLoanRows, ...nonBankLoanRows]
		.filter((row) => !isClosedLoanStatus(row.status)).length
	const settledLoans = asArray(data?.loan_details?.settled_loans).length
	const sumKnown = (...values) => values.every(Number.isInteger)
		? values.reduce((total, value) => total + value, 0)
		: null
	const checks = [
		{
			path: '$.credit_card_details',
			expected: overview.credit_card?.total_count,
			actual: cardRows.length + cancelledCards
		},
		{
			path: '$.credit_card_details.active',
			expected: overview.credit_card?.open_count,
			actual: activeCards
		},
		{
			path: '$.loan_details',
			expected: sumKnown(
				overview.mortgage_loan?.total_count,
				overview.other_loan?.total_count
			),
			actual: bankLoans + nonBankLoans + settledLoans
		},
		{
			path: '$.loan_details.active',
			expected: sumKnown(
				overview.mortgage_loan?.open_count,
				overview.other_loan?.open_count
			),
			actual: activeLoans
		}
	]
	for (const check of checks) {
		if (!Number.isInteger(check.expected) || check.expected < 0 || check.expected > 500) continue
		if (check.actual === check.expected) continue
		const error = chunkMergeError('CHUNK_SOURCE_OVERVIEW_MISMATCH', check.path)
		error.expectedCount = check.expected
		error.actualCount = check.actual
		throw error
	}
	return true
}

function buildEvidenceSourceVerifiedCounts(sourceText, queryEvidence = null, documentMeta = null) {
	const verified = {}
	const overviewEvidence = extractSourceAccountOverviewEvidence(sourceText, documentMeta)
	const overview = overviewEvidence?.overview || null
	const activeLoanCounts = [
		overview?.mortgage_loan?.open_count,
		overview?.other_loan?.open_count
	]
	if (activeLoanCounts.every((value) => Number.isInteger(value) && value >= 0)) {
		verified.active_loans = {
			count: activeLoanCounts.reduce((total, value) => total + value, 0),
			basis: overviewEvidence.basis
		}
	}
	const activeCards = overview?.credit_card?.open_count
	if (Number.isInteger(activeCards) && activeCards >= 0) {
		verified.credit_card_details = {
			count: activeCards,
			basis: overviewEvidence.basis
		}
	}
	const queryTotal = Number(queryEvidence?.query_details_total)
	if (queryEvidence?.complete === true && Number.isInteger(queryTotal) && queryTotal >= 0) {
		verified.query_details = {
			count: queryTotal,
			basis: 'source-query-table-v1'
		}
	}
	return verified
}

const INSTITUTION_QUERY_HEADING = '机构查询记录明细'
const SELF_QUERY_HEADINGS = ['本人查询记录明细', '个人查询记录明细']
const QUERY_DATE_TOKEN_SOURCE = [
	'20\\d{2}\\s*年\\s*\\d{1,2}\\s*月\\s*\\d{1,2}\\s*日',
	'20\\d{2}\\s*\\.\\s*\\d{1,2}\\s*\\.\\s*\\d{1,2}',
	'20\\d{2}\\s*-\\s*\\d{1,2}\\s*-\\s*\\d{1,2}',
	'20\\d{2}\\s*\\/\\s*\\d{1,2}\\s*\\/\\s*\\d{1,2}'
].join('|')

function whitespaceTolerantLiteralPattern(value) {
	return [...String(value || '')].map((char) => escapeRegExp(char)).join('\\s*')
}

function findWhitespaceTolerantHeading(sourceText, headings, fromIndex = 0) {
	const source = String(sourceText || '')
	let earliest = null
	for (const heading of headings) {
		const re = new RegExp(whitespaceTolerantLiteralPattern(heading), 'g')
		re.lastIndex = Math.max(0, Number(fromIndex) || 0)
		const match = re.exec(source)
		if (!match) continue
		const candidate = {
			start: match.index,
			end: match.index + match[0].length,
			heading
		}
		if (!earliest || candidate.start < earliest.start) earliest = candidate
	}
	return earliest
}

function institutionQueryHeadingMatch(sourceText, fromIndex = 0) {
	return findWhitespaceTolerantHeading(sourceText, [INSTITUTION_QUERY_HEADING], fromIndex)
}

function selfQueryHeadingMatch(sourceText, fromIndex = 0) {
	return findWhitespaceTolerantHeading(sourceText, SELF_QUERY_HEADINGS, fromIndex)
}

function queryRecordStartRegex() {
	// 部分文字层会把序号和日期拼成“12026年…”；日期锚点迫使序号
	// 捕获在年份前结束，同时只接受列出的四种受控日期写法。
	return new RegExp(`(?:^|\\s)(\\d{1,4})\\s*(${QUERY_DATE_TOKEN_SOURCE})\\s*`, 'g')
}

function maxNumberedQueryRecord(sectionText) {
	const section = String(sectionText || '').replace(/\s+/g, ' ')
	let max = 0
	const re = queryRecordStartRegex()
	let m
	while ((m = re.exec(section)) !== null) {
		const n = Number(m[1])
		if (Number.isFinite(n)) max = Math.max(max, n)
	}
	return max
}

const QUERY_REASON_TEXTS = [
	'法人代表、负责人、高管等资信审查',
	'担保资格审查',
	'信用卡审批',
	'贷记卡审批',
	'贷款审批',
	'融资审批',
	'授信审批',
	'贷后管理',
	'保后管理',
	'保前审查',
	'担保审查',
	'特约商户实名审查',
	'客户准入资格审查',
	'资信审查'
]

const QUERY_REASON_BY_COMPACT_TEXT = new Map(
	QUERY_REASON_TEXTS.map((reason) => [reason.replace(/\s+/g, ''), reason])
)

function normalizeQueryReasonText(value) {
	return QUERY_REASON_BY_COMPACT_TEXT.get(String(value || '').replace(/\s+/g, '')) || ''
}

function parseSourceInstitutionQueryRecords(sectionText) {
	const section = String(sectionText || '').replace(/\s+/g, ' ')
	const reasonRe = [...QUERY_REASON_TEXTS]
		.sort((a, b) => b.length - a.length)
		.map(whitespaceTolerantLiteralPattern)
		.join('|')
	const recordStartRe = queryRecordStartRegex()
	// PDF 表格文字层也可能把机构名与查询原因直接拼接；原因枚举本身是
	// 固定词表，因此以词尾锚点识别，不要求两列之间存在空格。
	const reasonAtEndRe = new RegExp(`(${reasonRe})(?=\\s|$)`, 'g')
	const starts = []
	let startMatch
	while ((startMatch = recordStartRe.exec(section)) !== null) {
		starts.push({
			seq: Number(startMatch[1]),
			date: normalizeDateText(startMatch[2]),
			contentStart: recordStartRe.lastIndex,
			recordStart: startMatch.index
		})
	}
	const rows = []
	for (let index = 0; index < starts.length; index++) {
		const start = starts[index]
		const contentEnd = index + 1 < starts.length ? starts[index + 1].recordStart : section.length
		const content = section.slice(start.contentStart, contentEnd).trim()
		let reasonMatch = null
		reasonAtEndRe.lastIndex = 0
		let candidate
		while ((candidate = reasonAtEndRe.exec(content)) !== null) reasonMatch = candidate
		if (!reasonMatch) continue
		const institution = String(content.slice(0, reasonMatch.index) || '').replace(/[|`]/g, '').trim()
		if (!institution || institution === '查询机构') continue
		rows.push({
			seq: start.seq,
			date: start.date,
			institution,
			reason: normalizeQueryReasonText(reasonMatch[1]),
			source: 'source-text'
		})
	}
	return rows
}

function parseSourceSelfQueryRecords(sectionText) {
	const section = String(sectionText || '').replace(/\s+/g, ' ')
	const re = new RegExp(
		`(?:^|\\s)(\\d{1,4})\\s*(${QUERY_DATE_TOKEN_SOURCE})\\s*本人\\s*(本人查询（[^）]+）)`,
		'g'
	)
	const rows = []
	let m
	while ((m = re.exec(section)) !== null) {
		rows.push({
			seq: Number(m[1]) || rows.length + 1,
			date: normalizeDateText(m[2]),
			institution: '本人',
			reason: m[3],
			source: 'source-text'
		})
	}
	return rows
}

function extractSourceQueryRecordCounts(sourceText) {
	const text = String(sourceText || '')
	const bounds = institutionQuerySectionBounds(text)
	const selfHeading = selfQueryHeadingMatch(text)
	const out = {}
	if (bounds.present) {
		const orgSection = text.slice(
			bounds.institutionStart,
			bounds.bounded ? bounds.selfStart : text.length
		)
		const total = maxNumberedQueryRecord(orgSection)
		if (total > 0) out.query_details_total = total
		else if (hasExplicitEmptyInstitutionQueryTable(text, bounds)) out.query_details_total = 0
	}
	if (selfHeading) {
		const selfSection = text.slice(selfHeading.start)
		const total = maxNumberedQueryRecord(selfSection)
		if (total > 0) out.self_queries_total = total
	}
	return Object.keys(out).length ? out : null
}

function extractSourceQueryRecords(sourceText) {
	const text = String(sourceText || '')
	const bounds = institutionQuerySectionBounds(text)
	const selfHeading = selfQueryHeadingMatch(text)
	const orgSection = bounds.present
		? text.slice(bounds.institutionStart, bounds.bounded ? bounds.selfStart : text.length)
		: ''
	const selfSection = selfHeading ? text.slice(selfHeading.start) : ''
	return {
		query_details: parseSourceInstitutionQueryRecords(orgSection),
		self_queries: parseSourceSelfQueryRecords(selfSection)
	}
}

function isValidSourceQueryRow(row, kind) {
	if (!row || typeof row !== 'object' || !parseDateMs(row.date)) return false
	if (kind === 'query_details') {
		const institution = String(row.institution || '').trim()
		const compactInstitution = institution.replace(/\s+/g, '')
		const reason = normalizeQueryReasonText(row.reason)
		return Boolean(
			institution &&
			/[\p{L}\p{N}]/u.test(institution) &&
			!/【第\d+页】|机构查询记录明细|查询机构|查询原因/.test(compactInstitution) &&
			QUERY_REASON_TEXTS.includes(reason)
		)
	}
	return /^本人查询（[^）]+）$/.test(String(row.reason || '').trim())
}

/**
 * 查询总数不能依赖模型心算。只有 OCR 原文解析器得到唯一、连续的 1..N
 * 编号，且每行关键字段有效时，才使用原文行重建数组并修复 coverage。
 * 任何编号断裂、重复、页眉污染或字段缺失都保持原样，让严格门禁 fail-closed。
 */
function completeSourceQueryRows(rows, sourceTotal, kind) {
	const sourceRows = asArray(rows)
	if (sourceRows.length !== sourceTotal) return []
	const sorted = [...sourceRows].sort((a, b) => Number(a.seq) - Number(b.seq))
	const seen = new Set()
	for (let index = 0; index < sorted.length; index++) {
		const row = sorted[index]
		const seq = Number(row.seq)
		if (!Number.isInteger(seq) || seq !== index + 1 || seen.has(seq)) return []
		seen.add(seq)
		if (!isValidSourceQueryRow(row, kind)) return []
	}
	return sorted
}

function joinScannedPageTexts(pageTexts) {
	return (Array.isArray(pageTexts) ? pageTexts : [])
		.map((text, index) => (String(text || '').trim() ? `【第${index + 1}页】\n${String(text).trim()}` : ''))
		.filter(Boolean)
		.join('\n\n')
		.trim()
}

function institutionQuerySectionBounds(sourceText) {
	const text = String(sourceText || '')
	const institutionHeading = institutionQueryHeadingMatch(text)
	const selfHeading = institutionHeading
		? selfQueryHeadingMatch(text, institutionHeading.end)
		: null
	const institutionStart = institutionHeading ? institutionHeading.start : -1
	const institutionEnd = institutionHeading ? institutionHeading.end : -1
	const selfStart = selfHeading ? selfHeading.start : -1
	return {
		institutionStart,
		institutionEnd,
		selfStart,
		selfEnd: selfHeading ? selfHeading.end : -1,
		selfHeading: selfHeading ? selfHeading.heading : '',
		present: institutionStart >= 0,
		bounded: institutionStart >= 0 && selfStart > institutionStart
	}
}

function compactInstitutionQueryLayoutText(value) {
	return String(value || '').replace(/\s+/g, '')
}

function hasInstitutionQueryTableHeaderSignal(sourceText) {
	return /(?:编号|序号)?查询日期查询机构查询原因/.test(
		compactInstitutionQueryLayoutText(sourceText)
	)
}

function hasExplicitEmptyInstitutionQueryTable(sourceText, providedBounds = null) {
	const source = String(sourceText || '')
	const bounds = providedBounds || institutionQuerySectionBounds(source)
	if (!bounds.bounded) return false
	const body = source.slice(bounds.institutionEnd, bounds.selfStart)
	let compact = compactInstitutionQueryLayoutText(body)
	const hasColumnHeader = /(?:编号|序号)?查询日期查询机构查询原因/.test(compact)
	compact = compact
		.replace(/【第\d+页】/g, '')
		.replace(/第\d+页[，,]?共\d+页/g, '')
		.replace(/机构查询记录明细/g, '')
		.replace(/(?:编号|序号)?查询日期查询机构查询原因/g, '')
		.replace(/[|｜:：,，;；\-—_。.]/g, '')
	const explicitNoRows = new Set([
		'无机构查询记录',
		'暂无机构查询记录',
		'未发生机构查询记录',
		'机构查询记录为0条',
		'机构查询记录0条'
	])
	return (hasColumnHeader && compact === '') || explicitNoRows.has(compact)
}

/**
 * 剥离机构查询区段内允许出现的版式样板（章节标题、表头、页码页脚，
 * 以及人行报告末尾的「说明 1.除查询记录外…」标准收尾条款），返回剩余
 * 内容的紧凑形式。返回非空即代表存在未识别残留。收尾条款必须以
 * 「说明1.除查询记录外」强锚定起始，措辞不符的结尾内容不会被剥离，
 * 让终止表证明保持 fail-closed。
 */
function institutionQueryTailResidue(value) {
	return compactInstitutionQueryLayoutText(value)
		.replace(/【第\d+页】/g, '')
		.replace(/第\d+页[，,/]?共\d+页/g, '')
		.replace(/机构查询记录明细/g, '')
		.replace(/(?:编号|序号)?查询日期查询机构查询原因/g, '')
		.replace(/说明1\.除查询记录外[^]*$/, '')
}

/**
 * 机构查询记录明细作为文档最后一节（其后不存在本人/个人查询标题）时的
 * 完整性证明：区段延伸到文档末尾，且除章节标题、表头、页码页脚与
 * 已解析查询行本体外不允许存在任何未识别内容。行切分与
 * parseSourceInstitutionQueryRecords 保持同一语义（序号+受控日期锚点起始、
 * 封闭原因词表末位锚点），任何残留或缺失原因都拒绝，让上游 fail-closed。
 */
function institutionQueryTerminalSectionProof(sourceText, providedBounds = null) {
	const source = String(sourceText || '')
	const bounds = providedBounds || institutionQuerySectionBounds(source)
	if (!bounds.present || bounds.bounded) return false
	const section = source.slice(bounds.institutionStart).replace(/\s+/g, ' ')
	const recordStartRe = queryRecordStartRegex()
	const starts = []
	let startMatch
	while ((startMatch = recordStartRe.exec(section)) !== null) {
		starts.push({ recordStart: startMatch.index, contentStart: recordStartRe.lastIndex })
	}
	if (!starts.length) return false
	const reasonAtEndRe = new RegExp(
		`(${[...QUERY_REASON_TEXTS]
			.sort((a, b) => b.length - a.length)
			.map(whitespaceTolerantLiteralPattern)
			.join('|')})(?=\\s|$)`,
		'g'
	)
	const residues = [section.slice(0, starts[0].recordStart)]
	for (let index = 0; index < starts.length; index++) {
		const start = starts[index]
		const contentEnd = index + 1 < starts.length ? starts[index + 1].recordStart : section.length
		const content = section.slice(start.contentStart, contentEnd)
		reasonAtEndRe.lastIndex = 0
		let reasonMatch = null
		let candidate
		while ((candidate = reasonAtEndRe.exec(content)) !== null) reasonMatch = candidate
		if (!reasonMatch) return false
		residues.push(content.slice(reasonMatch.index + reasonMatch[0].length))
	}
	return residues.every((residue) => !institutionQueryTailResidue(residue))
}

function hasInstitutionQuerySectionSignal(sourceText, providedBounds = null) {
	const source = String(sourceText || '')
	const bounds = providedBounds || institutionQuerySectionBounds(source)
	if (bounds.present || hasInstitutionQueryTableHeaderSignal(source)) return true
	const compact = compactInstitutionQueryLayoutText(source)
	return /(?:暂无|无|未发生)机构查询记录/.test(compact) || /机构查询记录(?:为)?0条/.test(compact)
}

function institutionQueryOcrState(pageTexts) {
	const text = joinScannedPageTexts(pageTexts)
	const bounds = institutionQuerySectionBounds(text)
	if (!bounds.bounded) {
		return {
			eligible: false,
			complete: false,
			total: 0,
			rows: [],
			missingSequences: [],
			invalidSequences: [],
			duplicateSequences: [],
			defectSequences: [],
			invalidRowCount: 0,
			duplicateRowCount: 0,
			extraSequenceCount: 0,
			defectCount: Number.POSITIVE_INFINITY
		}
	}
	const sourceCounts = extractSourceQueryRecordCounts(text) || {}
	const rows = extractSourceQueryRecords(text).query_details
	const declaredTotal = Number(sourceCounts.query_details_total)
	const total = Number.isInteger(declaredTotal)
		? declaredTotal
		: (rows.length === 0 && hasExplicitEmptyInstitutionQueryTable(text, bounds)
			? 0
			: Number.NaN)
	if (!Number.isInteger(total) || total < 0 || total > 500) {
		return {
			eligible: false,
			complete: false,
			total: 0,
			rows,
			missingSequences: [],
			invalidSequences: [],
			duplicateSequences: [],
			defectSequences: [],
			invalidRowCount: 0,
			duplicateRowCount: 0,
			extraSequenceCount: 0,
			defectCount: Number.POSITIVE_INFINITY
		}
	}
	if (total === 0 && rows.length === 0) {
		return {
			eligible: true,
			complete: true,
			total: 0,
			rows: [],
			missingSequences: [],
			invalidSequences: [],
			duplicateSequences: [],
			defectSequences: [],
			invalidRowCount: 0,
			duplicateRowCount: 0,
			extraSequenceCount: 0,
			defectCount: 0
		}
	}
	const rawSequenceCounts = new Map()
	for (const seq of numberedQuerySequences(
		text.slice(bounds.institutionStart, bounds.selfStart)
	)) {
		rawSequenceCounts.set(seq, (rawSequenceCounts.get(seq) || 0) + 1)
	}
	const sequenceCounts = new Map()
	const validSequenceCounts = new Map()
	let invalidRowCount = 0
	let extraSequenceCount = 0
	for (const row of rows) {
		const seq = Number(row && row.seq)
		if (!Number.isInteger(seq) || seq < 1 || seq > total) {
			extraSequenceCount += 1
			continue
		}
		sequenceCounts.set(seq, (sequenceCounts.get(seq) || 0) + 1)
		if (!isValidSourceQueryRow(row, 'query_details')) {
			invalidRowCount += 1
		} else {
			validSequenceCounts.set(seq, (validSequenceCounts.get(seq) || 0) + 1)
		}
	}
	const missingSequences = []
	const invalidSequences = []
	for (let seq = 1; seq <= total; seq++) {
		if (!rawSequenceCounts.has(seq)) missingSequences.push(seq)
		else if (validSequenceCounts.get(seq) !== 1) invalidSequences.push(seq)
	}
	const duplicateSequences = [...new Set([
		...[...rawSequenceCounts.entries()].filter(([, count]) => count > 1).map(([seq]) => seq),
		...[...sequenceCounts.entries()].filter(([, count]) => count > 1).map(([seq]) => seq)
	])]
	const duplicateRowCount = [...rawSequenceCounts.values()]
		.reduce((sum, count) => sum + Math.max(0, count - 1), 0)
	const defectSequences = [...new Set([
		...missingSequences,
		...invalidSequences,
		...duplicateSequences
	])].sort((a, b) => a - b)
	const complete = completeSourceQueryRows(rows, total, 'query_details').length === total
	return {
		eligible: true,
		complete,
		total,
		rows,
		missingSequences,
		invalidSequences,
		duplicateSequences,
		defectSequences,
		invalidRowCount,
		duplicateRowCount,
		extraSequenceCount,
		defectCount:
			defectSequences.length +
			duplicateRowCount +
			extraSequenceCount
	}
}

function numberedQuerySequences(pageText) {
	const text = String(pageText || '').replace(/\s+/g, ' ')
	const sequences = []
	const re = queryRecordStartRegex()
	let match
	while ((match = re.exec(text)) !== null) {
		const seq = Number(match[1])
		if (Number.isInteger(seq)) sequences.push(seq)
	}
	return sequences
}

function queryRescueCandidatePages(pageTexts) {
	const pages = Array.isArray(pageTexts) ? pageTexts : []
	let startPage = -1
	let endPage = -1
	for (let index = 0; index < pages.length; index++) {
		const pageText = String(pages[index] || '')
		if (startPage < 0 && institutionQueryHeadingMatch(pageText)) startPage = index
		if (startPage >= 0 && selfQueryHeadingMatch(pageText)) {
			endPage = index
			break
		}
	}
	if (startPage < 0 || endPage < startPage) return []
	// Verify every page in the institution-query interval. This deliberately
	// has no four-page cap: a cap can turn a long table into silently partial
	// evidence. Page-level OCR remains bounded by the global PDF page limit and
	// the existing OCR concurrency.
	return Array.from({ length: endPage - startPage + 1 }, (_value, offset) => startPage + offset)
}

function queryRowTuple(row) {
	return [
		Number(row && row.seq),
		normalizeDateText(row && row.date),
		String(row && row.institution || '').replace(/\s+/g, ''),
		String(row && row.reason || '').replace(/\s+/g, '')
	].join('\u0000')
}

function incompleteQueryEvidence(reason, state = null) {
	return {
		complete: false,
		reason: String(reason || 'unverified').slice(0, 64),
		query_details_total: state && Number.isInteger(Number(state.total))
			? Number(state.total)
			: null,
		query_details: []
	}
}

async function rescueIncompleteInstitutionQueryOcr({ pageTexts, images, loadPageImage, ocrPage }) {
	if (
		SCANNED_PDF_QUERY_RESCUE_ATTEMPTS < 2 ||
		!Array.isArray(pageTexts) ||
		(!Array.isArray(images) && typeof loadPageImage !== 'function') ||
		typeof ocrPage !== 'function'
	) {
		return incompleteQueryEvidence('two-pass-consensus-unavailable')
	}
	const workingTexts = [...pageTexts]
	const initialState = institutionQueryOcrState(workingTexts)
	if (!initialState.eligible) return incompleteQueryEvidence('query-section-unbounded', initialState)

	const candidatePages = queryRescueCandidatePages(workingTexts)
	if (!candidatePages.length) return incompleteQueryEvidence('query-pages-unavailable', initialState)
	const passTexts = [[...workingTexts], [...workingTexts]]
	const failedPages = new Set()
	const verifyPage = async (pageIndex) => {
		let pageImage = Array.isArray(images) ? images[pageIndex] : ''
		if (!pageImage && typeof loadPageImage === 'function') {
			try {
				pageImage = await loadPageImage(pageIndex)
			} catch (error) {
				logger.warn({
					code: safeErrorCode(error, 'OCR_QUERY_PAGE_RENDER_FAILED'),
					page: pageIndex + 1
				}, 'scanned-pdf: query page render for OCR rescue failed')
				failedPages.add(pageIndex + 1)
				return
			}
		}
		if (!pageImage) {
			failedPages.add(pageIndex + 1)
			return
		}
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const retriedText = String(await ocrPage(pageImage, pageIndex + 1) || '').trim()
				if (!retriedText) throw new Error('query page OCR returned empty text')
				passTexts[attempt][pageIndex] = retriedText
			} catch (error) {
				logger.warn({
					code: safeErrorCode(error, 'OCR_QUERY_PAGE_RESCUE_FAILED'),
					page: pageIndex + 1,
					attempt: attempt + 1
				}, 'scanned-pdf: query page OCR rescue attempt failed')
				failedPages.add(pageIndex + 1)
			}
		}
	}
	let rescueCursor = 0
	const rescueWorker = async () => {
		while (true) {
			const index = rescueCursor++
			if (index >= candidatePages.length) return
			await verifyPage(candidatePages[index])
		}
	}
	await Promise.all(Array.from(
		{ length: Math.min(SCANNED_PDF_OCR_CONCURRENCY, candidatePages.length) },
		() => rescueWorker()
	))
	if (failedPages.size > 0) {
		return incompleteQueryEvidence('query-page-ocr-failed', initialState)
	}

	const firstState = institutionQueryOcrState(passTexts[0])
	const secondState = institutionQueryOcrState(passTexts[1])
	const firstRows = firstState.eligible
		? completeSourceQueryRows(firstState.rows, firstState.total, 'query_details')
		: []
	const secondRows = secondState.eligible
		? completeSourceQueryRows(secondState.rows, secondState.total, 'query_details')
		: []
	const firstTuples = firstRows.map(queryRowTuple)
	const secondTuples = secondRows.map(queryRowTuple)
	const consensus =
		firstState.complete === true &&
		secondState.complete === true &&
		firstState.total === secondState.total &&
		firstRows.length === firstState.total &&
		secondRows.length === secondState.total &&
		firstTuples.length === secondTuples.length &&
		firstTuples.every((tuple, index) => tuple === secondTuples[index])
	if (consensus) {
		logger.info({
			pagesRetried: candidatePages.length,
			attemptsPerPage: 2,
			total: firstState.total,
			initialDefectCount: Number.isFinite(initialState.defectCount)
				? initialState.defectCount
				: undefined,
			strategy: 'two_pass_full_query_section_consensus'
		}, 'scanned-pdf: accepted full two-pass query-row evidence')
		return {
			complete: true,
			query_details_total: firstState.total,
			query_details: firstRows
		}
	}
	return incompleteQueryEvidence('two-pass-query-consensus-mismatch', initialState)
}

function reconcileSourceQueryCoverage(raw, sourceText, supplementalEvidence = null) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
	const queryAnalysis = raw.query_analysis
	const coverage = raw._coverage
	if (
		!queryAnalysis ||
		typeof queryAnalysis !== 'object' ||
		Array.isArray(queryAnalysis) ||
		!coverage ||
		typeof coverage !== 'object' ||
		Array.isArray(coverage) ||
		!coverage.counts ||
		typeof coverage.counts !== 'object' ||
		Array.isArray(coverage.counts)
	) {
		return raw
	}

	const sourceCounts = extractSourceQueryRecordCounts(sourceText) || {}
	const sourceRecords = extractSourceQueryRecords(sourceText)
	const evidenceTotal = Number(supplementalEvidence && supplementalEvidence.query_details_total)
	const evidenceRows = asArray(supplementalEvidence && supplementalEvidence.query_details)
	if (supplementalEvidence != null) {
		if (!supplementalQueryEvidenceMatchesSourceSubset(sourceText, supplementalEvidence)) {
			throw factSchemaError(
				'$._coverage.counts.query_details',
				'supplemental query evidence conflicts with source'
			)
		}
		sourceCounts.query_details_total = evidenceTotal
		sourceRecords.query_details = completeSourceQueryRows(
			evidenceRows,
			evidenceTotal,
			'query_details'
		)
	}
	const source = String(sourceText || '')
	const queryBounds = institutionQuerySectionBounds(source)
	const selfHeading = selfQueryHeadingMatch(source)
	const institutionSectionStart = queryBounds.institutionStart
	const selfSectionStart = selfHeading ? selfHeading.start : -1
	const specs = [
		{
			name: 'query_details',
			totalKey: 'query_details_total',
			fields: ['institution', 'date', 'reason']
		},
		{
			name: 'self_queries',
			totalKey: 'self_queries_total',
			fields: ['date', 'channel']
		}
	]

	for (const spec of specs) {
		if (
			(spec.name === 'query_details' &&
				(institutionSectionStart < 0 ||
					(selfSectionStart <= institutionSectionStart &&
						!institutionQueryTerminalSectionProof(source, queryBounds)))) ||
			(spec.name === 'self_queries' && selfSectionStart < 0)
		) {
			continue
		}
		const sourceTotal = Number(sourceCounts[spec.totalKey])
		if (!Number.isInteger(sourceTotal) || sourceTotal <= 0 || sourceTotal > 500) continue
		const modelRows = asArray(queryAnalysis[spec.name])
		const completeRows = completeSourceQueryRows(
			sourceRecords[spec.name],
			sourceTotal,
			spec.name
		)
		if (!completeRows.length) {
			const sourceRows = asArray(sourceRecords[spec.name])
			const sequenceCounts = new Map()
			for (const row of sourceRows) {
				const seq = Number(row && row.seq)
				if (Number.isInteger(seq)) sequenceCounts.set(seq, (sequenceCounts.get(seq) || 0) + 1)
			}
			const missingSequences = []
			for (let seq = 1; seq <= sourceTotal; seq++) {
				if (!sequenceCounts.has(seq)) missingSequences.push(seq)
			}
			const duplicateSequences = [...sequenceCounts.entries()]
				.filter(([, count]) => count > 1)
				.map(([seq]) => seq)
			logger.warn({
				array: spec.name,
				total: sourceTotal,
				modelRows: modelRows.length,
				sourceRows: sourceRows.length,
				missingSequenceCount: missingSequences.length,
				duplicateSequenceCount: duplicateSequences.length,
				strategy: 'fail_closed'
			}, 'analyze-text: source query rows are not provably complete')
			continue
		}
		const parsedRows = spec.name === 'self_queries'
			? completeRows.map((row) => ({
				date: row.date,
				channel: row.reason
			}))
			: pickFactRows(completeRows, spec.fields)
		queryAnalysis[spec.name] = parsedRows
		coverage.counts[spec.name] = {
			total: sourceTotal,
			listed: sourceTotal
		}
		logger.info({
			array: spec.name,
			total: sourceTotal,
			modelRows: modelRows.length,
			sourceRows: parsedRows.length,
			strategy: 'source_rows_rebuilt'
		}, 'analyze-text: query coverage reconciled from source evidence')
	}
	coverage.has_queries = asArray(queryAnalysis.query_details).length > 0 ||
		asArray(queryAnalysis.self_queries).length > 0
	return raw
}

function extractCoverageArrayCounts(notes) {
	const out = {}
	const text = String(notes || '')
	const re = /([A-Za-z0-9_]+)数组共(\d+)条(?:，已列出前(\d+)条|，已全部列出)?/g
	let m
	while ((m = re.exec(text)) !== null) {
		out[m[1]] = {
			total: Number(m[2]) || 0,
			listed: m[3] ? Number(m[3]) || 0 : Number(m[2]) || 0
		}
	}
	return out
}

function compactInstitutionName(name) {
	return String(name || '').replace(/^第?\d+[.、．]?/, '').trim()
}

function dedupeSourceRows(rows, kind) {
	const seen = new Set()
	const out = []
	for (const row of rows) {
		const key = [
			kind,
			row.institution,
			row.type,
			row.start_date,
			row.end_date,
			Math.round(safeNum(row.credit_limit)),
			Math.round(safeNum(row.balance ?? row.used_limit)),
			row.status || ''
		].join('|')
		if (seen.has(key)) continue
		seen.add(key)
		out.push(row)
	}
	return out
}

function extractSourceCreditFacts(sourceText, documentMeta = null) {
	const source = normalizeCreditSourceText(sourceText)
	const facts = {
		basic_info: extractSourceBasicInfo(sourceText),
		account_overview: extractSourceAccountOverview(sourceText, documentMeta),
		query_counts: extractSourceQueryRecordCounts(sourceText),
		query_records: extractSourceQueryRecords(sourceText),
		loans: [],
		settled_loans: [],
		historical_overdue_loans: [],
		cards: [],
		cancelled_cards: []
	}
	if (!source) return facts
	let m

	const cardActiveRe = /(\d{4}年\d{1,2}月\d{1,2}日)([^。；，]{2,90}?)发放的((?:贷记卡|准贷记卡|信用卡)(?:（[^）]*）)?)[。；，]?截至(\d{4}年\d{1,2}月)，信用额度([\d,.]+)(万)?，(?:已使用额度|已用额度|余额)([\d,.]+)(万)?/g
	while ((m = cardActiveRe.exec(source)) !== null) {
		facts.cards.push({
			institution: compactInstitutionName(m[2]),
			type: m[3],
			credit_limit: parseCreditSourceAmount(m[5], m[6]),
			used_limit: parseCreditSourceAmount(m[7], m[8]),
			status: '正常',
			start_date: normalizeDateText(m[1]),
			end_date: '',
			source: 'source-text'
		})
	}

	const cardInactiveRe = /(\d{4}年\d{1,2}月\d{1,2}日)([^。；，]{2,90}?)发放的((?:贷记卡|准贷记卡|信用卡)(?:（[^）]*）)?)[。；，]?截至(\d{4}年\d{1,2}月)尚未激活/g
	while ((m = cardInactiveRe.exec(source)) !== null) {
		facts.cards.push({
			institution: compactInstitutionName(m[2]),
			type: m[3],
			credit_limit: 0,
			used_limit: 0,
			status: '尚未激活',
			start_date: normalizeDateText(m[1]),
			end_date: normalizeDateText(m[4]),
			source: 'source-text'
		})
	}

	const cardClosedRe = /(\d{4}年\d{1,2}月\d{1,2}日)([^。；，]{2,90}?)发放的((?:贷记卡|准贷记卡|信用卡)(?:（[^）]*）)?)[，,](\d{4}年\d{1,2}月)(?:销户|注销|关闭)/g
	while ((m = cardClosedRe.exec(source)) !== null) {
		facts.cancelled_cards.push({
			institution: compactInstitutionName(m[2]),
			type: m[3],
			credit_limit: 0,
			used_limit: 0,
			status: '已销户',
			start_date: normalizeDateText(m[1]),
			end_date: normalizeDateText(m[4]),
			source: 'source-text'
		})
	}

	const historicalOverdueLoanRe = /(\d{4}年\d{1,2}月\d{1,2}日)([^。；，]{2,90}?)发放的([\d,.]+)(万)?元（人民币）([^。；，]{2,50}?贷款)[。；，]?最近5年内有(\d+)个月处于逾期状态(?:，?(没有发生过90天以上的逾期))?/g
	while ((m = historicalOverdueLoanRe.exec(source)) !== null) {
		const overdueMonths = Number(m[6])
		// 官方报告会用同一模板明确写“有0个月处于逾期状态”。
		// 0 是明确的否定事实，不能因为命中“逾期”模板就创建历史逾期实体。
		if (!Number.isInteger(overdueMonths) || overdueMonths <= 0) continue
		facts.historical_overdue_loans.push({
			institution: compactInstitutionName(m[2]),
			type: m[5],
			credit_limit: parseCreditSourceAmount(m[3], m[4]),
			balance: 0,
			status: '历史逾期',
			start_date: normalizeDateText(m[1]),
			overdue_months: overdueMonths,
			overdue_90_days: m[7] ? 0 : null,
			debt_excluded_reason: '历史逾期记录，原文未给当前余额，不计入当前负债',
			source: 'source-text'
		})
	}

	const loanActiveRe = /(\d{4}年\d{1,2}月\d{1,2}日)([^。；，]{2,90}?)发放的([\d,.]+)(万)?元（人民币）([^。；，]{2,50}?贷款)[，,](\d{4}年\d{1,2}月\d{1,2}日)到期[。；，]?截至(\d{4}年\d{1,2}月)，余额(?:为)?([\d,.]+)(万)?/g
	while ((m = loanActiveRe.exec(source)) !== null) {
		facts.loans.push({
			institution: compactInstitutionName(m[2]),
			type: m[5],
			credit_limit: parseCreditSourceAmount(m[3], m[4]),
			balance: parseCreditSourceAmount(m[8], m[9]),
			status: '正常',
			start_date: normalizeDateText(m[1]),
			end_date: normalizeDateText(m[6]),
			source: 'source-text'
		})
	}

	const revolvingLoanRe = /(\d{4}年\d{1,2}月\d{1,2}日)([^。；，]{2,90}?)为([^。；，]{2,50}?贷款)授信[，,]额度(?:有效期至(\d{4}年\d{1,2}月\d{1,2}日)|长期有效)[，,]可循环使用[。；，]?截至(\d{4}年\d{1,2}月)，信用额度([\d,.]+)(万)?元（人民币），余额为([\d,.]+)(万)?[，,]当前([^。；，]+)/g
	while ((m = revolvingLoanRe.exec(source)) !== null) {
		const statusText = String(m[10] || '').replace(/\s+/g, '')
		const explicitNoOverdue = /(?:未|无|从未|没有|并无|不存在|不曾)逾期|逾期(?:账户|记录|次数|月份|月数|天数)?(?:为|是|共计|合计|:|：)?0(?:个|次|月|天)?|0个月处于逾期状态/.test(statusText)
		const overdue = /逾期/.test(statusText) && !explicitNoOverdue
		facts.loans.push({
			institution: compactInstitutionName(m[2]),
			type: `${m[3]}授信`,
			credit_limit: parseCreditSourceAmount(m[6], m[7]),
			balance: parseCreditSourceAmount(m[8], m[9]),
			status: overdue ? '逾期' : '正常',
			start_date: normalizeDateText(m[1]),
			end_date: normalizeDateText(m[4]),
			source: 'source-text'
		})
	}

	const loanClosedRe = /(\d{4}年\d{1,2}月\d{1,2}日)([^。；，]{2,90}?)发放的([\d,.]+)(万)?元（人民币）([^。；，]{2,50}?贷款)[，,](\d{4}年\d{1,2}月)(?:已)?结清/g
	while ((m = loanClosedRe.exec(source)) !== null) {
		facts.settled_loans.push({
			institution: compactInstitutionName(m[2]),
			type: m[5],
			credit_limit: parseCreditSourceAmount(m[3], m[4]),
			balance: 0,
			status: '已结清',
			start_date: normalizeDateText(m[1]),
			end_date: normalizeDateText(m[6]),
			source: 'source-text'
		})
	}

	facts.loans = dedupeSourceRows(facts.loans, 'loan')
	facts.settled_loans = dedupeSourceRows(facts.settled_loans, 'settled-loan')
	facts.historical_overdue_loans = dedupeSourceRows(facts.historical_overdue_loans, 'historical-overdue-loan')
	facts.cards = dedupeSourceRows(facts.cards, 'card')
	facts.cancelled_cards = dedupeSourceRows(facts.cancelled_cards, 'cancelled-card')
	return facts
}

function applySourceFactsToAnalysis(data, sourceText, options = {}) {
	const facts = extractSourceCreditFacts(sourceText, options.documentMeta)
	if (!facts || !data || typeof data !== 'object') return facts
	const factsOnly = options.factsOnly === true
	const hasRebuiltCreditFacts =
		facts.loans.length > 0 ||
		facts.settled_loans.length > 0 ||
		facts.historical_overdue_loans.length > 0 ||
		facts.cards.length > 0 ||
		facts.cancelled_cards.length > 0
	if (hasRebuiltCreditFacts) {
		removeCoverageNotes(data, (note) => /输入文本被截断|无法提取.*明细|缺失大量中间内容/.test(note))
		const cov = ensureObject(data, '_coverage')
		if (cov.truncated === true && String(cov.notes || '').trim() === '') cov.truncated = false
	}
	if (facts.account_overview) {
		data.report_overview = facts.account_overview
		const cd = ensureObject(data, 'credit_debt')
		cd.account_overview = facts.account_overview
		appendCoverageNote(data, '系统已按报告首页总表校准账户数量')
	}
	const basic = facts.basic_info || {}
	if (basic.name || basic.age || basic.id_last4 || basic.report_date) {
		const info = ensureObject(data, 'basic_info')
		if (basic.name) info.name = basic.name
		if (basic.age) info.age = basic.age
		if (basic.id_last4) info.id_last4 = basic.id_last4
		if (basic.report_date) {
			const meta = ensureObject(data, 'meta')
			meta.report_date = meta.report_date || basic.report_date
		}
		appendCoverageNote(data, '系统已按报告原文校准姓名/身份证后4位/年龄')
	}
	if (!factsOnly && (facts.loans.length > 0 || facts.settled_loans.length > 0)) {
		const ld = ensureObject(data, 'loan_details')
		const activeLoans = facts.loans.map((row, idx) => ({ seq: idx + 1, ...row }))
		// 模型/上游数组分组是显式分类，名称规则只用于没有既有分类的来源重建行。
		const knownKinds = new Map()
		for (const row of asArray(ld.bank_loans)) {
			const key = institutionIdentityKey(row.institution)
			if (key) knownKinds.set(key, 'bank')
		}
		for (const row of asArray(ld.non_bank_loans)) {
			const key = institutionIdentityKey(row.institution)
			if (key) knownKinds.set(key, 'non_bank')
		}
		for (const row of asArray(ld.unknown_loans)) {
			const key = institutionIdentityKey(row.institution)
			if (key) knownKinds.set(key, 'unknown')
		}
		const classified = activeLoans.map((row) => {
			const key = institutionIdentityKey(row.institution)
			const institution_type = knownKinds.get(key) || institutionKind(row)
			return { ...row, institution_type }
		})
		ld.bank_loans = classified.filter((row) => row.institution_type === 'bank')
		ld.non_bank_loans = classified.filter((row) => row.institution_type === 'non_bank')
		ld.unknown_loans = classified.filter((row) => row.institution_type === 'unknown')
		if (facts.settled_loans.length > 0) {
			ld.settled_loans = facts.settled_loans.map((row, idx) => ({ seq: idx + 1, ...row }))
			}
			appendCoverageNote(data, '系统已按原文贷款明细重建负债，已结清和余额0不计入当前负债')
		}
		if (!factsOnly && facts.historical_overdue_loans.length > 0) {
			const ld = ensureObject(data, 'loan_details')
			ld.historical_overdue_loans = facts.historical_overdue_loans.map((row, idx) => ({ seq: idx + 1, ...row }))
			const overdue = ensureObject(data, 'overdue_info')
			const details = asArray(overdue.details)
			for (const row of ld.historical_overdue_loans) {
				const exists = details.some((item) =>
					String(item.institution || '') === String(row.institution || '') &&
					Math.round(safeNum(item.amount)) === Math.round(safeNum(row.credit_limit))
				)
				if (!exists) {
					details.push({
						seq: details.length + 1,
						institution: row.institution,
						desc: row.type,
						amount: row.credit_limit,
						date: row.start_date || '—',
						months: row.overdue_months,
						overdue_90_days: row.overdue_90_days
					})
				}
			}
			overdue.details = details
			overdue.has_overdue = true
			overdue.total_overdue_accounts = Math.max(safeNum(overdue.total_overdue_accounts), details.length || 1)
			overdue.total_overdue_months = Math.max(
				safeNum(overdue.total_overdue_months),
				ld.historical_overdue_loans.reduce((sum, row) => sum + safeNum(row.overdue_months), 0)
			)
			if (ld.historical_overdue_loans.every((row) => row.overdue_90_days === 0)) overdue.overdue_90_days = 0
			const risk = ensureObject(data, 'risk_analysis')
			if (!Array.isArray(risk.risk_hits)) risk.risk_hits = []
			for (const row of ld.historical_overdue_loans) {
				const exists = risk.risk_hits.some((hit) => hit && hit.rule_name === 'HISTORICAL_LARGE_OVERDUE')
				if (!exists) {
					risk.risk_hits.push({
						level: '风险',
						rule_name: 'HISTORICAL_LARGE_OVERDUE',
						title: '历史大额贷款逾期',
						detail: `${row.institution || '贷款机构'} ${moneyWithCommas(row.credit_limit)}元${row.type || '贷款'}曾出现${safeNum(row.overdue_months)}个月逾期；当前未见余额，不计入当前负债。`,
						severity: 5
					})
				}
			}
			appendCoverageNote(data, '系统已将历史大额逾期单列为风险，不计入当前负债')
		}
		if (!factsOnly && (facts.cards.length > 0 || facts.cancelled_cards.length > 0)) {
			data.credit_card_details = facts.cards.map((row, idx) => ({ seq: idx + 1, ...row }))
			if (facts.cancelled_cards.length > 0) data.credit_card_details_cancelled = facts.cancelled_cards
			appendCoverageNote(data, '系统已按原文信用卡明细重建已用额度，已用0不计入负债')
		}
	const coverageCounts = extractCoverageArrayCounts(data._coverage && data._coverage.notes)
	const sourceQueryDetails = facts.query_records && Array.isArray(facts.query_records.query_details) ? facts.query_records.query_details : []
	const sourceSelfQueries = facts.query_records && Array.isArray(facts.query_records.self_queries) ? facts.query_records.self_queries : []
	if (!factsOnly && sourceQueryDetails.length > asArray(data.query_analysis && data.query_analysis.query_details).length) {
		const qa = ensureObject(data, 'query_analysis')
		qa.query_details = sourceQueryDetails
		appendCoverageNote(data, '系统已按原文查询记录编号重建机构查询明细')
	}
	if (!factsOnly && sourceSelfQueries.length > asArray(data.query_analysis && data.query_analysis.self_queries).length) {
		const qa = ensureObject(data, 'query_analysis')
		qa.self_queries = sourceSelfQueries
		appendCoverageNote(data, '系统已按原文查询记录编号重建本人查询明细')
	}
	if (Object.keys(coverageCounts).length > 0 || facts.query_counts || sourceQueryDetails.length > 0 || sourceSelfQueries.length > 0) {
		const qa = ensureObject(data, 'query_analysis')
		qa.coverage_counts = {
			...(qa.coverage_counts || {}),
			query_details_total: coverageCounts.query_details ? coverageCounts.query_details.total : (sourceQueryDetails.length || undefined),
			query_details_listed: coverageCounts.query_details ? coverageCounts.query_details.listed : (sourceQueryDetails.length || undefined),
			self_queries_total: coverageCounts.self_queries ? coverageCounts.self_queries.total : (sourceSelfQueries.length || undefined),
			self_queries_listed: coverageCounts.self_queries ? coverageCounts.self_queries.listed : (sourceSelfQueries.length || undefined),
			credit_card_details_total: coverageCounts.credit_card_details ? coverageCounts.credit_card_details.total : undefined,
			bank_loans_total: coverageCounts.bank_loans ? coverageCounts.bank_loans.total : undefined,
			non_bank_loans_total: coverageCounts.non_bank_loans ? coverageCounts.non_bank_loans.total : undefined,
			...(facts.query_counts || {})
		}
		appendCoverageNote(data, '系统已按查询记录原文编号校准查询总数')
	}
	return facts
}

function parseDateMs(value) {
	const raw = String(value || '').replace(/\s+/g, '').trim()
	if (!raw) return 0
	const normalized = raw
		.replace(/[年月.]/g, '-')
		.replace(/[日]/g, '')
		.replace(/\//g, '-')
	const m = normalized.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/)
	if (!m) return 0
	const y = Number(m[1])
	const mo = Number(m[2])
	const d = Number(m[3] || 1)
	if (!y || !mo || mo < 1 || mo > 12 || d < 1 || d > 31) return 0
	const timestamp = Date.UTC(y, mo - 1, d)
	const parsed = new Date(timestamp)
	if (
		parsed.getUTCFullYear() !== y ||
		parsed.getUTCMonth() !== mo - 1 ||
		parsed.getUTCDate() !== d
	) {
		return 0
	}
	return timestamp
}

function queryAnchorMs(data, rows) {
	const meta = data && data.meta && typeof data.meta === 'object' ? data.meta : {}
	// 唯一口径：只以报告日为锚点。不能回退到“上传当天”或查询明细最大日期，
	// 否则同一旧报告跨日期重传会改变评分。
	return parseDateMs(meta.report_date || meta.reportDate)
}

function isoDateFromMs(value) {
	return Number.isFinite(value) && value > 0
		? new Date(value).toISOString().slice(0, 10)
		: null
}

function buildQueryMonthlyTrend(rows) {
	const map = new Map()
	for (const row of rows) {
		const raw = String(row.date || row.query_date || '')
		const m = raw.replace(/[年月.]/g, '-').match(/(\d{4})-(\d{1,2})/)
		if (!m) continue
		const month = `${m[1]}-${String(Number(m[2])).padStart(2, '0')}`
		map.set(month, (map.get(month) || 0) + 1)
	}
	return [...map.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.slice(-24)
		.map(([month, query_count]) => ({ month, query_count, new_loan_amount: 0 }))
}

function moneyWithCommas(n) {
	const num = Math.round(Number(n) || 0)
	return String(num).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function wanText(n) {
	const num = safeNum(n)
	if (!num) return '0'
	return `${(num / 10000).toFixed(num >= 100000 ? 1 : 2)}万`
}

function pctText(rate) {
	const n = safeNum(rate)
	return `${(n * 100).toFixed(1)}%`
}

function isOpenLoanRow(row) {
	return row && typeof row === 'object' && !isClosedLoanStatus(row.status)
}

function buildStructuredReportInterpretation(data) {
	if (!data || typeof data !== 'object') return null
	const cd = ensureObject(data, 'credit_debt')
	const cc = ensureObject(cd, 'credit_cards')
	const cl = ensureObject(cd, 'credit_loans')
	const ld = ensureObject(data, 'loan_details')
	const qa = data.query_analysis && typeof data.query_analysis === 'object' ? data.query_analysis : {}
	const overview = data.report_overview || cd.account_overview || {}
	const sourceActiveCards = asArray(data.credit_card_details).filter((row) => !isCancelledCardStatus(row.status))
	const activeCards = data.derivation_meta?.mode === 'deterministic-v1'
		? sourceActiveCards
		: uniqueRows(sourceActiveCards)
	const hasEvidenceV2SharedRelations = data.derivation_meta?.evidence_mode === 'evidence-v2'
	const cardUtilization = summarizeCreditCardUtilization(activeCards, {
		trustExplicitSharedGroup: hasEvidenceV2SharedRelations,
		allowHeuristicSharedCredit: false
	})
	const utilizationCards = cardUtilization.groups.filter((group) => group.included)
	const loanRows = [
		...asArray(ld.bank_loans),
		...asArray(ld.non_bank_loans),
		...asArray(ld.unknown_loans)
	]
	const debtLoans = loanRows.filter(isDebtBearingLoanRow)
	const openLoanRows = loanRows.filter(isOpenLoanRow)
	const zeroBalanceOpenLoans = openLoanRows.filter((row) => !isDebtBearingLoanRow(row))
	const historicalOverdueLoans = asArray(ld.historical_overdue_loans)
	const cardTotalCount = safeNum(overview.credit_card && overview.credit_card.total_count)
	const existingOpenCardCount = safeNum(cc.open_account_count || cc.card_count)
	const cardOpenCount = safeNum(overview.credit_card && overview.credit_card.open_count) || existingOpenCardCount || activeCards.length
	const otherLoanTotalCount = safeNum(overview.other_loan && overview.other_loan.total_count)
	const otherLoanOpenCount = safeNum(overview.other_loan && overview.other_loan.open_count) || openLoanRows.length
	const mortgageTotalCount = safeNum(overview.mortgage_loan && overview.mortgage_loan.total_count)
	const mortgageOpenCount = safeNum(overview.mortgage_loan && overview.mortgage_loan.open_count)
	const otherBusinessTotalCount = safeNum(overview.other_business && overview.other_business.total_count)
	const otherBusinessOpenCount = safeNum(overview.other_business && overview.other_business.open_count)
	const cardUsed = safeNum(cc.total_used)
	const cardLimit = safeNum(cc.total_limit)
	const cardUtilizationUsed = Object.prototype.hasOwnProperty.call(cc, 'utilization_used')
		? safeNum(cc.utilization_used)
		: cardUsed
	const cardUsage = Object.prototype.hasOwnProperty.call(cc, 'usage_rate')
		? roundRate(cc.usage_rate)
		: (cardLimit > 0 ? roundRate(cardUtilizationUsed / cardLimit) : 0)
	const loanBalance = safeNum(cl.total_amount || ld.total && ld.total.balance)
	const totalDebt = safeNum(cd.total_debt) || roundMoney(cardUsed + loanBalance)
	const debtDenominator = totalDebt > 0 ? totalDebt : 1
	const overLimitCards = utilizationCards
		.filter((group) => safeNum(group.limit) > 0 && safeNum(group.used) > safeNum(group.limit))
		.map((group) => ({
			institution: group.institution || '信用卡',
			credit_limit: safeNum(group.limit),
			used_limit: safeNum(group.used),
			usage_rate: safeNum(group.limit) > 0 ? roundRate(safeNum(group.used) / safeNum(group.limit)) : 0
		}))
	const highUsageCards = utilizationCards
		.filter((group) => safeNum(group.limit) > 0 && safeNum(group.used) / safeNum(group.limit) >= 0.9)
		.map((group) => ({
			institution: group.institution || '信用卡',
			credit_limit: safeNum(group.limit),
			used_limit: safeNum(group.used),
			usage_rate: roundRate(safeNum(group.used) / safeNum(group.limit))
		}))

	cc.total_limit = roundMoney(cardLimit)
	cc.total_used = roundMoney(cardUsed)
	cc.usage_rate = cardUsage
	cc.card_count = cardOpenCount || activeCards.length
	cc.total_account_count = cardTotalCount || cc.total_account_count || activeCards.length
	cc.open_account_count = cardOpenCount || cc.open_account_count || activeCards.length
	cc.parsed_detail_count = activeCards.length
	cc.utilization_group_count = cc.utilization_group_count || cardUtilization.utilizationGroupCount
	cc.used_account_count = utilizationCards.filter((group) => safeNum(group.used) > 0).length
	cc.over_limit_count = overLimitCards.length
	cc.high_usage_count = highUsageCards.length
	cc.over_limit_cards = overLimitCards.slice(0, 12)
	cc.high_usage_cards = highUsageCards.slice(0, 12)
	ld.open_count = otherLoanOpenCount || openLoanRows.length
	ld.total_count = otherLoanTotalCount || loanRows.length
	ld.debt_bearing_count = debtLoans.length
	ld.zero_balance_open_count = zeroBalanceOpenLoans.length

	const coverageCounts = qa.coverage_counts || {}
	const queryTotal = safeNum(coverageCounts.query_details_total) || asArray(qa.query_details).length
	const hardQueryTotal = asArray(qa.query_details).filter(isHardCreditQuery).length
	const selfQueryTotal = safeNum(coverageCounts.self_queries_total) || asArray(qa.self_queries).length
	const riskPoints = []
	if (historicalOverdueLoans.length > 0) {
		for (const row of historicalOverdueLoans.slice(0, 2)) {
			const overdueMonths = safeNum(row.overdue_months)
			const overdueDuration = overdueMonths > 0 ? `${overdueMonths}个月` : ''
			riskPoints.push({
				level: 'high',
				title: '历史大额贷款逾期',
				detail: `${row.institution || '贷款机构'} ${wanText(row.credit_limit)}${row.type || '贷款'}曾出现${overdueDuration}逾期；当前不计入负债，但影响准入。`
			})
		}
	}
	if (overLimitCards.length > 0) {
		riskPoints.push({
			level: 'high',
			title: '信用卡超额或接近满额',
			detail: `${overLimitCards.length}张卡已超过授信额度，${highUsageCards.length}张卡使用率超过90%。`
		})
	} else if (highUsageCards.length > 0) {
		riskPoints.push({
			level: 'warn',
			title: '信用卡使用率偏高',
			detail: `${highUsageCards.length}张卡使用率超过90%，建议先压降至70%以下。`
		})
	}
	if (hardQueryTotal >= 60 || safeNum(qa.summary && qa.summary.last_6m && qa.summary.last_6m.total) >= 12) {
		riskPoints.push({
			level: 'warn',
			title: '查询记录偏密',
			detail: `报告列示硬查询${hardQueryTotal}次，本人查询${selfQueryTotal}次；短期内应停止新增申请。`
		})
	}
	if (riskPoints.length === 0) {
		riskPoints.push({ level: 'info', title: '未见红色风险集中项', detail: '继续保持按时还款并控制新增查询。' })
	}

	return {
		version: '2026-07-08-structured-v1',
		title: '征信报告结构化解读',
		headline: totalDebt > 0
			? `当前负债约${wanText(totalDebt)}，其中信用卡${wanText(cardUsed)}、贷款${wanText(loanBalance)}。`
			: '已完成征信读取，当前未识别到有效负债金额。',
		overview: {
			credit_card: { total_count: cardTotalCount || null, open_count: cardOpenCount || activeCards.length },
			mortgage_loan: { total_count: mortgageTotalCount || null, open_count: mortgageOpenCount || 0 },
			other_loan: { total_count: otherLoanTotalCount || null, open_count: otherLoanOpenCount || openLoanRows.length },
			other_business: { total_count: otherBusinessTotalCount || null, open_count: otherBusinessOpenCount || 0 }
		},
		debt_summary: {
			total_debt: roundMoney(totalDebt),
			credit_card_used: roundMoney(cardUsed),
			loan_balance: roundMoney(loanBalance),
			credit_card_share: roundRate(cardUsed / debtDenominator),
			loan_share: roundRate(loanBalance / debtDenominator)
		},
		credit_cards: {
			total_limit: roundMoney(cardLimit),
			total_used: roundMoney(cardUsed),
			utilization_used: roundMoney(cardUtilizationUsed),
			usage_rate: cardUsage,
			card_count: cardOpenCount || activeCards.length,
			used_account_count: cc.used_account_count,
			high_usage_count: highUsageCards.length,
			over_limit_count: overLimitCards.length,
			high_usage_cards: highUsageCards.slice(0, 8),
			over_limit_cards: overLimitCards.slice(0, 8)
		},
		loans: {
			current_balance: roundMoney(loanBalance),
			debt_bearing_count: debtLoans.length,
			open_count: otherLoanOpenCount || openLoanRows.length,
			zero_balance_open_count: zeroBalanceOpenLoans.length,
			bank_amount: safeNum(cl.bank_amount),
			non_bank_amount: safeNum(cl.non_bank_amount),
			unknown_amount: safeNum(cl.unknown_amount),
			unknown_count: safeNum(cl.unknown_count),
			historical_overdue_loans: historicalOverdueLoans
		},
		queries: {
			query_details_total: queryTotal,
			hard_query_details_total: hardQueryTotal,
			query_details_listed: safeNum(coverageCounts.query_details_listed) || asArray(qa.query_details).length,
			self_queries_total: selfQueryTotal,
			windows: qa.summary || {}
		},
		sections: [
			{
				key: 'overview',
				title: '负债总览',
				rows: [
					{ label: '信用卡', value: `${cardTotalCount || activeCards.length}张`, sub: `未销户/未结清 ${cardOpenCount || activeCards.length}张` },
					{ label: '购房贷款', value: `${mortgageTotalCount || 0}笔`, sub: `未结清 ${mortgageOpenCount || 0}笔` },
					{ label: '其他贷款', value: `${otherLoanTotalCount || loanRows.length}笔`, sub: `未结清 ${otherLoanOpenCount || openLoanRows.length}笔` }
				]
			},
			{
				key: 'debt',
				title: '当前负债结构',
				rows: [
					{ label: '信用卡已使用', value: wanText(cardUsed), sub: `${pctText(cardUsed / debtDenominator)} 占比` },
					{ label: '贷款余额', value: wanText(loanBalance), sub: `${pctText(loanBalance / debtDenominator)} 占比` },
					{ label: '当前负债合计', value: wanText(totalDebt), sub: '已结清/余额0不计入' }
				]
			},
			{
				key: 'risk',
				title: '关键风险点',
				rows: riskPoints.map((item) => ({ label: item.title, value: item.level === 'high' ? '高' : item.level === 'warn' ? '警' : '稳', sub: item.detail }))
			}
		],
		key_points: riskPoints,
		action_items: [
			overLimitCards.length > 0 ? '优先偿还超额和接近满额信用卡，先降到70%以下。' : '',
			historicalOverdueLoans.length > 0 ? '历史大额逾期需要在申请前主动解释并准备还款/结清证明。' : '',
			hardQueryTotal >= 60 ? '至少30天内暂停贷款和信用卡申请，避免新增硬查询。' : '',
			'后续产品匹配必须结合三金、个税、工资流水和资产材料，不只看征信。'
		].filter(Boolean)
	}
}

function moneyVariants(n) {
	const num = Math.round(Number(n) || 0)
	if (!num) return []
	const raw = String(num)
	const comma = moneyWithCommas(num)
	return [...new Set([raw, comma, `${raw}.00`, `${comma}.00`])]
}

function escapeRegExp(s) {
	return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function compactDateVariants(value) {
	const raw = String(value || '').trim()
	const m = raw.match(/(\d{4})[-年./](\d{1,2})[-月./](\d{1,2})/)
	if (!m) return raw ? [raw] : []
	const yyyy = m[1]
	const mm = String(Number(m[2])).padStart(2, '0')
	const dd = String(Number(m[3])).padStart(2, '0')
	return [...new Set([
		`${yyyy}-${mm}-${dd}`,
		`${yyyy}年${Number(mm)}月${Number(dd)}日`,
		`${yyyy}年${mm}月${dd}日`
	])]
}

function textWindowsAroundMarkers(sourceText, markers, radius = 180) {
	const text = String(sourceText || '')
	if (!text || !markers.length) return []
	const windows = []
	for (const marker of markers) {
		const needle = String(marker || '').trim()
		if (!needle) continue
		let from = 0
		while (from < text.length) {
			const idx = text.indexOf(needle, from)
			if (idx < 0) break
			windows.push(text.slice(Math.max(0, idx - radius), Math.min(text.length, idx + needle.length + radius)))
			from = idx + Math.max(needle.length, 1)
		}
	}
	return windows
}

function sourceHasExplicitLoanBalance(row, sourceText, balance) {
	const variants = moneyVariants(balance)
	if (!variants.length || !sourceText) return false
	const institution = String(row && row.institution || '').trim()
	const shortInstitution = institution.replace(/股份有限公司|有限责任公司|有限公司|上海市分行|上海分行|信用卡中心/g, '').slice(0, 8)
	const markers = [
		institution,
		shortInstitution,
		...compactDateVariants(row && row.start_date)
	].filter((item, idx, arr) => item && arr.indexOf(item) === idx)
	const windows = textWindowsAroundMarkers(sourceText, markers.length ? markers : variants, 260)
	const balanceWord = '(?:余额|当前余额|贷款余额)'
	for (const window of windows) {
		const normalized = String(window || '').replace(/\s+/g, '')
		for (const v of variants) {
			const amount = escapeRegExp(v)
			const reBefore = new RegExp(`${balanceWord}(?:为|：|:)?[^\\d]{0,8}${amount}`)
			const reAfter = new RegExp(`${amount}[^\\d]{0,8}${balanceWord}`)
			if (reBefore.test(normalized) || reAfter.test(normalized)) return true
		}
	}
	return false
}

function removePrincipalOnlyLoanBalances(data, loanRows, sourceText) {
	if (!sourceText || !Array.isArray(loanRows) || loanRows.length === 0) return
	let changed = false
	for (const row of loanRows) {
		if (!row || typeof row !== 'object') continue
		const balance = safeNum(row.balance ?? row.remaining_balance)
		const principal = safeNum(row.credit_limit ?? row.amount ?? row.loan_amount)
		if (!(balance > 0 && principal > 0 && Math.abs(balance - principal) <= 1)) continue
		if (sourceHasExplicitLoanBalance(row, sourceText, balance)) continue
		row.balance = null
		row.balance_review_required = true
		row.balance_note = '原文未识别到明确余额，未将发放/授信金额计入当前负债'
		changed = true
	}
	if (changed) appendCoverageNote(data, '系统已剔除仅有发放/授信金额、未见余额字段的贷款余额')
}

function deterministicDebtCategory(row) {
	const text = `${row && row.type || ''} ${row && row.account_type || ''} ${row && row.product || ''}`
	if (/住房|房贷|按揭|公积金|购房/.test(text)) return 'mortgage'
	if (/汽车|车辆|购车|车贷/.test(text)) return 'car_loan'
	if (/经营|创业|商户|企业|生产/.test(text)) return 'business_loan'
	return 'credit_loan'
}

function rebuildDeterministicOtherDebts(data, debtLoanRows) {
	const buckets = {
		mortgage: { amount: 0, count: 0 },
		car_loan: { amount: 0, count: 0 },
		credit_loan: { amount: 0, count: 0 },
		business_loan: { amount: 0, count: 0 }
	}
	for (const row of Array.isArray(debtLoanRows) ? debtLoanRows : []) {
		const key = deterministicDebtCategory(row)
		buckets[key].amount += safeNum(row.balance ?? row.remaining_balance)
		buckets[key].count += 1
	}
	for (const bucket of Object.values(buckets)) bucket.amount = roundMoney(bucket.amount)

	const guaranteeFacts = data.guarantee_records && typeof data.guarantee_records === 'object'
		? data.guarantee_records
		: {}
	const guaranteeRows = asArray(guaranteeFacts.items).filter(
		(row) => hasNegatedClosedStatusPhrase(row.status) ||
			!/解除|结清|终止|失效|关闭/.test(String(row.status || ''))
	)
	const guaranteeItemAmount = guaranteeRows.reduce((sum, row) => sum + safeNum(row.amount), 0)
	const guarantee = {
		amount: roundMoney(Math.max(guaranteeItemAmount, safeNum(guaranteeFacts.total_amount))),
		count: guaranteeRows.length || (safeNum(guaranteeFacts.total_amount) > 0 ? 1 : 0)
	}
	const total = roundMoney(
		Object.values(buckets).reduce((sum, bucket) => sum + bucket.amount, 0) + guarantee.amount
	)
	const withPercentage = (bucket) => ({
		...bucket,
		percentage: total > 0 ? roundRate(bucket.amount / total) : 0
	})
	data.other_debts = {
		total,
		mortgage: withPercentage(buckets.mortgage),
		car_loan: withPercentage(buckets.car_loan),
		credit_loan: withPercentage(buckets.credit_loan),
		business_loan: withPercentage(buckets.business_loan),
		guarantee: withPercentage(guarantee),
		chart_data: [
			{ name: '房贷', value: buckets.mortgage.amount, color: '#8B5CF6' },
			{ name: '车贷', value: buckets.car_loan.amount, color: '#EC4899' },
			{ name: '信用贷款', value: buckets.credit_loan.amount, color: '#3B82F6' },
			{ name: '经营贷', value: buckets.business_loan.amount, color: '#06B6D4' },
			{ name: '对外担保', value: guarantee.amount, color: '#F97316' }
		]
	}
}

function normalizeCreditAnalysisAggregates(data, sourceText = '', options = {}) {
	if (!data || typeof data !== 'object') return data
	const factsOnly =
		options.factsOnly === true ||
		data.derivation_meta?.mode === 'deterministic-v1'
	// deterministic-v1 已由严格 Schema 和 coverage 门禁确认模型事实数组完整。
	// 旧正则解析器只能作为补充信息，不能用“解析到的部分行”覆盖这些数组，
	// 否则会让实际行数与已验证的 coverage 失配。
	applySourceFactsToAnalysis(data, sourceText, {
		factsOnly,
		documentMeta: options.documentMeta
	})
	const declaredCounts = data._coverage && data._coverage.counts
	if (declaredCounts && typeof declaredCounts === 'object') {
		const qa = ensureObject(data, 'query_analysis')
		qa.coverage_counts = qa.coverage_counts || {}
		for (const [name, count] of Object.entries(declaredCounts)) {
			qa.coverage_counts[`${name}_total`] = safeNum(count && count.total)
			qa.coverage_counts[`${name}_listed`] = safeNum(count && count.listed)
		}
	}

	const cd = ensureObject(data, 'credit_debt')
	const cl = ensureObject(cd, 'credit_loans')
	const cc = ensureObject(cd, 'credit_cards')
	const ld = ensureObject(data, 'loan_details')
	const normalizedLoans = [
		...normalizeLoanRowsForDebt(ld.bank_loans),
		...normalizeLoanRowsForDebt(ld.non_bank_loans),
		...normalizeLoanRowsForDebt(ld.unknown_loans)
	]
	const bankLoans = normalizedLoans.filter((row) => row.institution_type === 'bank')
	const nonBankLoans = normalizedLoans.filter((row) => row.institution_type === 'non_bank')
	const unknownLoans = normalizedLoans.filter((row) => row.institution_type === 'unknown')
	ld.bank_loans = bankLoans
	ld.non_bank_loans = nonBankLoans
	ld.unknown_loans = unknownLoans
	const loanRows = [...bankLoans, ...nonBankLoans, ...unknownLoans]
	removePrincipalOnlyLoanBalances(data, loanRows, sourceText)
	const debtLoanRows = loanRows.filter(isDebtBearingLoanRow)
	const debtBankLoans = bankLoans.filter(isDebtBearingLoanRow)
	const debtNonBankLoans = nonBankLoans.filter(isDebtBearingLoanRow)
	const debtUnknownLoans = unknownLoans.filter(isDebtBearingLoanRow)

	if (loanRows.length > 0 || factsOnly) {
		const bankBalance = debtBankLoans.reduce((sum, row) => sum + safeNum(row.balance ?? row.remaining_balance), 0)
		const nonBankBalance = debtNonBankLoans.reduce((sum, row) => sum + safeNum(row.balance ?? row.remaining_balance), 0)
		const bankLimit = debtBankLoans.reduce((sum, row) => sum + safeNum(row.credit_limit ?? row.amount ?? row.loan_amount), 0)
		const nonBankLimit = debtNonBankLoans.reduce((sum, row) => sum + safeNum(row.credit_limit ?? row.amount ?? row.loan_amount), 0)
		const unknownBalance = debtUnknownLoans.reduce((sum, row) => sum + safeNum(row.balance ?? row.remaining_balance), 0)
		const unknownLimit = debtUnknownLoans.reduce((sum, row) => sum + safeNum(row.credit_limit ?? row.amount ?? row.loan_amount), 0)
		ld.subtotal_bank = { balance: roundMoney(bankBalance), credit_limit: roundMoney(bankLimit) }
		ld.subtotal_non_bank = { balance: roundMoney(nonBankBalance), credit_limit: roundMoney(nonBankLimit) }
		ld.subtotal_unknown = { balance: roundMoney(unknownBalance), credit_limit: roundMoney(unknownLimit) }
		ld.total = {
			balance: roundMoney(bankBalance + nonBankBalance + unknownBalance),
			credit_limit: roundMoney(bankLimit + nonBankLimit + unknownLimit),
			count: debtLoanRows.length
		}
		cl.total_amount = ld.total.balance
		cl.total_balance = ld.total.balance
		cl.total_count = debtLoanRows.length
		cl.bank_amount = ld.subtotal_bank.balance
		cl.bank_count = bankLoans.filter((row) => !isClosedLoanStatus(row.status)).length
		cl.non_bank_amount = ld.subtotal_non_bank.balance
		cl.non_bank_count = nonBankLoans.filter((row) => !isClosedLoanStatus(row.status)).length
		cl.unknown_amount = ld.subtotal_unknown.balance
		cl.unknown_count = unknownLoans.filter((row) => !isClosedLoanStatus(row.status)).length
		cl.total_count = cl.bank_count + cl.non_bank_count + cl.unknown_count
		cl.chart_data = [
			{ name: '银行贷款', value: cl.bank_amount, color: '#3B82F6' },
			{ name: '非银贷款', value: cl.non_bank_amount, color: '#F59E0B' },
			...(cl.unknown_count > 0
				? [{ name: '未分类贷款', value: cl.unknown_amount, color: '#94A3B8' }]
				: [])
		]
		appendCoverageNote(data, '系统已按贷款明细复核贷款余额/笔数')
	}

	const sourceActiveCards = asArray(data.credit_card_details).filter((row) => !isCancelledCardStatus(row.status))
	const activeCards = factsOnly ? sourceActiveCards : uniqueRows(sourceActiveCards)
	if (activeCards.length > 0) {
		const hasEvidenceV2SharedRelations = data.derivation_meta?.evidence_mode === 'evidence-v2'
		const utilization = summarizeCreditCardUtilization(activeCards, {
			trustExplicitSharedGroup: hasEvidenceV2SharedRelations,
			allowHeuristicSharedCredit: false
		})
		const detailCardLimit = utilization.totalLimit
		const detailCardUtilizationUsed = utilization.totalUsed
		const detailCardOutstanding = utilization.cardOutstanding
		const existingCardLimit = safeNum(cc.total_limit)
		const existingCardUsed = safeNum(cc.total_used)
		const existingCardCount = safeNum(cc.card_count)
		const useExistingCardSummary =
			!factsOnly &&
			existingCardCount > activeCards.length &&
			existingCardLimit > 0 &&
			existingCardUsed >= 0 &&
			existingCardUsed <= existingCardLimit * 1.5 &&
			!utilization.hasSharedGroups &&
			!utilization.hasForeignCurrency
		const cardLimit = useExistingCardSummary ? existingCardLimit : detailCardLimit
		const cardOutstanding = useExistingCardSummary ? existingCardUsed : detailCardOutstanding
		const cardUtilizationUsed = useExistingCardSummary ? existingCardUsed : detailCardUtilizationUsed
		// `activeCards` may be filtered/deduplicated for derived utilization only.
		// Never write it back over the strictly validated fact array: doing so can
		// silently change N/N coverage into M/N after validation.
		cc.total_limit = roundMoney(cardLimit)
		cc.total_used = roundMoney(cardOutstanding)
		cc.utilization_used = roundMoney(cardUtilizationUsed)
		cc.usage_rate = cardLimit > 0 ? roundRate(cardUtilizationUsed / cardLimit) : 0
		cc.raw_total_limit = roundMoney(utilization.rawTotalLimit)
		cc.raw_total_used = roundMoney(utilization.rawTotalUsed)
		cc.utilization_group_count = useExistingCardSummary ? existingCardCount : utilization.utilizationGroupCount
		cc.shared_group_count = utilization.sharedGroupCount
		cc.inferred_shared_group_count = utilization.inferredSharedGroupCount
		cc.foreign_currency_account_count = utilization.foreignAccountCount
		cc.foreign_only_group_count = utilization.foreignOnlyGroupCount
		cc.utilization_basis = useExistingCardSummary
			? '完整汇总优先（已列明细不足）'
			: '人民币主账户优先；仅明确共享额度去重；外币不直接与人民币相加'
		cc.card_count = !factsOnly && existingCardCount > 0 && existingCardCount <= activeCards.length * 2
			? existingCardCount
			: activeCards.length
		// PRD-DECISION-001：未激活卡计入账户数，但不参与大额分期/使用率口径。
		const installmentEligibleCards = activeCards.filter((row) => !isNotActivatedCardStatus(row?.status))
		const installmentCards = hasEvidenceV2SharedRelations
			? installmentEligibleCards.filter((row) => {
				const currency = creditEvidenceLedger.resolveCurrencyFields(row?.currency, row?.currency_code)
				return currency.valid && currency.code === 'CNY'
			})
			: installmentEligibleCards
		cc.large_installment = roundMoney(
			installmentCards.reduce((sum, row) => sum + safeNum(row.installment ?? row.large_installment), 0)
		)
		cc.not_activated_count = utilization.notActivatedAccountCount
		if (utilization.notActivatedAccountCount > 0) {
			appendCoverageNote(data, '未激活信用卡已计入账户数，不计入使用率与当前负债')
		}
		cc.chart_basis = 'positive-limit-utilization'
		cc.chart_data = [
			{ name: '已使用', value: cc.utilization_used, color: '#EF4444' },
			{ name: '剩余额度', value: Math.max(roundMoney(cc.total_limit - cc.utilization_used), 0), color: '#10B981' }
		]
		appendCoverageNote(data, utilization.hasSharedGroups || utilization.hasForeignCurrency
			? '系统已按人民币主账户/明确共享额度组复核信用卡使用率，外币额度未与人民币直接相加'
			: '系统已按存续信用卡明细复核额度/已用/张数')
	} else if (factsOnly) {
		Object.assign(cc, {
			total_limit: 0,
			total_used: 0,
			usage_rate: 0,
			utilization_used: 0,
			card_count: 0,
			large_installment: 0,
			raw_total_limit: 0,
			raw_total_used: 0,
			utilization_group_count: 0,
			shared_group_count: 0,
			inferred_shared_group_count: 0,
			foreign_currency_account_count: 0,
			foreign_only_group_count: 0,
			utilization_basis: '无存续信用卡明细',
			chart_basis: 'positive-limit-utilization',
			chart_data: [
				{ name: '已使用', value: 0, color: '#EF4444' },
				{ name: '剩余额度', value: 0, color: '#10B981' }
			]
		})
	}

	const loanBalance = loanRows.length > 0 ? safeNum(ld.total && ld.total.balance) : safeNum(cl.total_amount)
	const loanLimit = loanRows.length > 0 ? safeNum(ld.total && ld.total.credit_limit) : safeNum(cl.total_credit_limit)
	const cardUsed = activeCards.length > 0 ? safeNum(cc.total_used) : safeNum(cc.total_used)
	const cardLimit = activeCards.length > 0 ? safeNum(cc.total_limit) : safeNum(cc.total_limit)
	if (loanRows.length > 0 || activeCards.length > 0 || factsOnly) {
		const totalDebt = roundMoney(loanBalance + cardUsed)
		const totalLine = loanLimit + cardLimit
		cd.total_debt = totalDebt
		cd.debt_ratio = totalLine > 0 ? roundRate(totalDebt / totalLine) : roundRate(cd.debt_ratio)
	}

	const qa = data.query_analysis && typeof data.query_analysis === 'object' ? data.query_analysis : null
	const queryRows = qa ? asArray(qa.query_details) : []
	if (qa && (queryRows.length > 0 || factsOnly)) {
		const anchor = queryAnchorMs(data, queryRows)
		qa.summary = {}
		qa.all_query_summary = {}
		for (const months of WINDOW_MONTHS) {
			qa.summary[`last_${months}m`] = countQueriesByWindow(queryRows, anchor, months)
			qa.all_query_summary[`last_${months}m`] = countQueriesByWindow(
				queryRows,
				anchor,
				months,
				{ hardOnly: false }
			)
		}
		qa.window_policy = {
			anchor: 'report_date',
			boundary: 'calendar-month-inclusive',
			counted: 'hard-credit-inquiries-only',
			excluded: ['本人/自查', '贷后管理', '异议/账户管理'],
			institution_types: ['bank', 'non_bank', 'unknown'],
			unknown_policy: 'never-default-to-non-bank'
		}
		qa.monthly_trend = buildQueryMonthlyTrend(queryRows)
		appendCoverageNote(data, '系统已按报告日和日历月边界重算硬查询；本人查询、贷后管理不计入评分')
	}

	if (factsOnly) {
		rebuildDeterministicOtherDebts(data, debtLoanRows)
		const anchor = queryAnchorMs(data, queryRows)
		const evidenceMode = data.derivation_meta?.evidence_mode === 'evidence-v2'
			? 'evidence-v2'
			: ''
		data.derivation_meta = {
			mode: 'deterministic-v1',
			...(evidenceMode ? { evidence_mode: evidenceMode } : {}),
			anchor_date: isoDateFromMs(anchor),
			facts_source: 'deepseek+source-text',
			model_role: 'raw-facts-only'
		}
		appendCoverageNote(data, 'DeepSeek仅提取原始事实；使用率、共享额度、查询、负债、风险与评分均由规则引擎生成')
	}

	data.report_interpretation = buildStructuredReportInterpretation(data)
	return data
}

function assertDeterministicFactCoverage(data, options = {}) {
	const coverage = data && data._coverage && typeof data._coverage === 'object'
		? data._coverage
		: null
	if (!coverage || coverage.counts_declared !== true || !coverage.counts) {
		const error = new Error('deterministic fact coverage declaration missing')
		error.code = 'DETERMINISTIC_COVERAGE_MISSING'
		throw error
	}
	if (
		coverage.truncated === true ||
		coverage.salvaged_truncated === true ||
		coverage.llm_output_truncated === true
	) {
		const error = new Error('partial analysis cannot be scored or cached')
		error.code = 'DETERMINISTIC_INPUT_INCOMPLETE'
		throw error
	}
	if (
		options.requireLlmFinishReason === true &&
		String(coverage.llm_finish_reason || '') !== 'stop'
	) {
		const error = new Error('model output did not finish with stop')
		error.code = 'DETERMINISTIC_OUTPUT_INCOMPLETE'
		throw error
	}
	if (!queryAnchorMs(data, [])) {
		const error = new Error('report date is required as query window anchor')
		error.code = 'DETERMINISTIC_REPORT_DATE_MISSING'
		throw error
	}
	const incomplete = []
	for (const [name, selectRows] of Object.entries(FACT_COVERAGE_ARRAYS)) {
		const count = coverage.counts[name]
		const total = Number(count && count.total)
		const listed = Number(count && count.listed)
		const actual = asArray(selectRows(data)).length
		if (
			!Number.isInteger(total) ||
			!Number.isInteger(listed) ||
			total < 0 ||
			listed < 0 ||
			total !== listed ||
			listed !== actual
		) {
			incomplete.push(`${name}:${actual}/${listed}/${total}`)
		}
	}
	if (incomplete.length > 0) {
		const error = new Error(`deterministic facts incomplete: ${incomplete.join(',')}`)
		error.code = 'DETERMINISTIC_FACTS_INCOMPLETE'
		error.coverageIssues = incomplete
			.map((item) => {
				const match = String(item).match(/^([a-z_]+):(\d+)\/(\d+)\/(\d+)$/)
				if (!match) return null
				return {
					array: match[1],
					actual: Number(match[2]),
					listed: Number(match[3]),
					total: Number(match[4])
				}
			})
			.filter(Boolean)
		throw error
	}
}

function attachAuthoritativeDeterministicDimensions(data) {
	const debt = data && data.credit_debt && typeof data.credit_debt === 'object'
		? data.credit_debt
		: {}
	const cards = debt.credit_cards && typeof debt.credit_cards === 'object'
		? debt.credit_cards
		: {}
	const loans = debt.credit_loans && typeof debt.credit_loans === 'object'
		? debt.credit_loans
		: {}
	const query = data && data.query_analysis && typeof data.query_analysis === 'object'
		? data.query_analysis
		: {}
	const engineDimensions = data && data.deterministic_dimensions &&
		typeof data.deterministic_dimensions === 'object'
		? data.deterministic_dimensions
		: {}
	const loanDetails = data && data.loan_details && typeof data.loan_details === 'object'
		? data.loan_details
		: {}
	const bankLoans = asArray(loanDetails.bank_loans)
	const nonBankLoans = asArray(loanDetails.non_bank_loans)
	const unknownLoans = asArray(loanDetails.unknown_loans)
	const settledLoans = asArray(loanDetails.settled_loans)
	const activeLoans = [...bankLoans, ...nonBankLoans, ...unknownLoans]
		.filter((row) => !isClosedLoanStatus(row.status))
	const activeCards = asArray(data && data.credit_card_details)
		.filter((row) => !isCancelledCardStatus(row.status))
	const cancelledCards = asArray(data && data.credit_card_details_cancelled)
	const queryRows = asArray(query.query_details).filter(isHardCreditQuery)
	const overdue = data && data.overdue_info && typeof data.overdue_info === 'object'
		? data.overdue_info
		: {}
	const anchor = queryAnchorMs(data, queryRows)
	const accountYears = [...activeLoans, ...settledLoans, ...activeCards, ...cancelledCards]
		.map((row) => parseDateMs(row.start_date || row.open_date))
		.filter((started) => started > 0 && started <= anchor)
		.map((started) => (anchor - started) / (365.2425 * 86400000))
	const totalLoanBalance = safeNum(
		loans.total_balance ??
		loans.total_amount ??
		loanDetails.total?.balance
	)
	const totalLoanCredit = safeNum(
		loans.total_credit_limit ??
		loans.total_credit ??
		loanDetails.total?.credit_limit
	)
	const totalCreditLine = safeNum(cards.total_limit) + totalLoanCredit
	const totalDebt = safeNum(debt.total_debt)
	const overdueDetails = asArray(overdue.details)
	const loanQueryCount = queryRows.filter((row) =>
		/贷款审批|担保(?:资格)?审查|融资审批|授信审批/.test(String(row.reason || ''))
	).length
	const cardQueryCount = queryRows.filter((row) =>
		/信用卡审批/.test(String(row.reason || ''))
	).length
	data.deterministic_dimensions = {
		version: 'deterministic-dimensions-v1',
		authority: 'server',
		anchorDate: isoDateFromMs(anchor),
		totalCreditLine,
		usedCardLimit: safeNum(cards.total_used),
		cardUtilizationUsed: safeNum(cards.utilization_used),
		totalLoanBalance,
		availableCredit: Math.max(0, roundMoney(totalCreditLine - totalDebt)),
		totalDebt,
		totalOverdueAmt: roundMoney(
			overdueDetails.reduce(
				(sum, row) => sum + safeNum(row.overdue_amount ?? row.amount),
				0
			)
		),
		debtRatio: roundRate(debt.debt_ratio),
		cardUtilizationRate: roundRate(cards.usage_rate),
		cardRawTotalLimit: safeNum(cards.raw_total_limit ?? cards.total_limit),
		cardRawTotalUsed: safeNum(cards.raw_total_used ?? cards.total_used),
		cardUtilizationGroupCount: safeNum(cards.utilization_group_count),
		cardSharedGroupCount: safeNum(cards.shared_group_count),
		cardForeignCurrencyAccountCount: safeNum(cards.foreign_currency_account_count),
		overdueCount: safeNum(overdue.total_overdue_accounts) || overdueDetails.length,
		maxOverdueDays: safeNum(overdue.max_overdue_days),
		m1Count: safeNum(overdue.m1_count ?? overdue.overdue_30_days),
		m2Count: safeNum(overdue.m2_count ?? overdue.overdue_60_days),
		m3Count: safeNum(overdue.m3_count ?? overdue.overdue_90_days),
		q1: safeNum(query.summary?.last_1m?.total),
		q3: safeNum(query.summary?.last_3m?.total),
		q6: safeNum(query.summary?.last_6m?.total),
		q12: safeNum(query.summary?.last_12m?.total),
		loanQueryCount,
		cardQueryCount,
		totalAccountCount: activeLoans.length + settledLoans.length + activeCards.length + cancelledCards.length,
		activeAccountCount: activeLoans.length + activeCards.length,
		settledAccountCount: settledLoans.length + cancelledCards.length,
		creditCardCount: activeCards.length,
		loanCount: activeLoans.length,
		nonBankLoanCount: nonBankLoans.filter((row) => !isClosedLoanStatus(row.status)).length,
		unknownLoanCount: unknownLoans.filter((row) => !isClosedLoanStatus(row.status)).length,
		oldestAccountYears: accountYears.length
			? roundRate(Math.max(...accountYears))
			: 0,
		avgAccountYears: accountYears.length
			? roundRate(accountYears.reduce((sum, value) => sum + value, 0) / accountYears.length)
			: 0,
		monthlyPaymentTotal: roundMoney(
			activeLoans.reduce((sum, row) => sum + safeNum(row.monthly_payment), 0)
		),
		monthlyIncomeRatio: 0,
		hasOverdue: overdue.has_overdue === true || overdueDetails.length > 0,
		hasM3Plus: safeNum(overdue.m3_count ?? overdue.overdue_90_days) > 0,
		hasLianSan: overdue.has_lian_san === true,
		hasLeiLiu: overdue.has_lei_liu === true,
		hasPublicRecord: data?.public_records?.has_record === true,
		isHighRisk: /high|高/.test(String(data?.assessment?.risk_level || data?.risk_level || '')),
		debtRatioExceeds70: roundRate(debt.debt_ratio) >= 0.7,
		// 规则引擎是账户数、逾期和评分维度的权威实现；上述字段仅补齐
		// 其未输出的债务/卡片审计项，不能反向用前端明细重算覆盖。
		...engineDimensions,
		queryPolicy: query.window_policy || null,
		allQueryWindows: query.all_query_summary || {},
		coverageCounts: data?._coverage?.counts || {}
	}
	return data
}

function evidenceArtifactHash(prefix, canonicalPayload) {
	return buildArtifactHash(prefix, canonicalPayload)
}

const EXPLICIT_SHARED_CREDIT_LABEL = '(?:共享额度组|共享授信组|额度组|授信协议编号|信用协议编号)'
const EXPLICIT_SHARED_CREDIT_TOKEN = '[A-Za-z0-9\\u3400-\\u9FFF][A-Za-z0-9\\u3400-\\u9FFF._\\/-]{0,63}'
const EXPLICIT_SHARED_CREDIT_RELATION_RE = new RegExp(
	`(?:^|[\\s|｜,，;；])${EXPLICIT_SHARED_CREDIT_LABEL}\\s*[：:=#]?\\s*(${EXPLICIT_SHARED_CREDIT_TOKEN})(?![A-Za-z0-9\\u3400-\\u9FFF._-])`,
	'gu'
)

function normalizeSharedCreditSourceToken(value) {
	return String(value == null ? '' : value)
		.normalize('NFC')
		.trim()
}

function buildTrustedSourceSharedGroupId(rawToken, documentId) {
	const normalized = normalizeSharedCreditSourceToken(rawToken)
	const scopedDocumentId = String(documentId || '').trim()
	const isExplicitNoRelation = typeof creditEvidenceLedger.isExplicitNoSharedCreditToken === 'function'
		? creditEvidenceLedger.isExplicitNoSharedCreditToken(normalized)
		: /^(?:(?:无|未|不|否|没有|暂无)(?:共享|设置|提供|适用|关联|授信|额度)?|N\/?A|NONE|NULL|NO|NOTSET|UNSET)$/iu.test(normalized.replace(/\s+/gu, ''))
	const hasStableIdentifierShape = /[A-Z0-9]/iu.test(normalized)
	if (
		!normalized || normalized.length > 64 || isExplicitNoRelation || !hasStableIdentifierShape ||
		!/^doc_v2_[a-f0-9]{64}$/.test(scopedDocumentId)
	) return ''
	const helper = creditEvidenceLedger.buildSourceSharedGroupId
	const groupId = typeof helper === 'function'
		? helper(normalized, evidenceArtifactHash, scopedDocumentId)
		// Compatibility while the evidence-ledger helper is loaded from an older
		// local checkout. This is byte-for-byte the ledger artifact-hash contract;
		// neither branch retains or exposes the source token.
		: evidenceArtifactHash('grp_v2', stableCanonicalize({
			documentId: scopedDocumentId,
			token: normalized
		}))
	return /^grp_v2_[a-f0-9]{64}$/.test(String(groupId || '')) ? groupId : ''
}

function validNativePdfSourceLines(documentMeta) {
	if (!documentMeta || documentMeta.sourceMode !== 'pdf-text') return []
	const pages = Array.isArray(documentMeta.pages) ? documentMeta.pages : []
	const lines = []
	for (const [pageIndex, page] of pages.entries()) {
		const pageText = String(page && page.text || '')
		const pageNo = Number(page && (page.pageNumber || page.pageNo)) || pageIndex + 1
		for (const [blockIndex, block] of (Array.isArray(page && page.blocks) ? page.blocks : []).entries()) {
			for (const [lineIndex, line] of (Array.isArray(block && block.lines) ? block.lines : []).entries()) {
				const text = String(line && line.text || '')
				const charStart = Number(line && line.charStart)
				const charEnd = Number(line && line.charEnd)
				if (
					!text.trim() ||
					!Number.isInteger(charStart) ||
					!Number.isInteger(charEnd) ||
					charStart < 0 ||
					charEnd <= charStart ||
					charEnd > pageText.length ||
					pageText.slice(charStart, charEnd) !== text
				) continue
				lines.push({
					pageNo,
					charStart,
					charEnd,
					text,
					sourceBlockOrdinal: blockIndex + 1,
					sourceLineOrdinal: lineIndex + 1
				})
			}
		}
	}
	return lines.sort((a, b) =>
		a.pageNo - b.pageNo || a.charStart - b.charStart || a.charEnd - b.charEnd
	)
}

function explicitSharedGroupIdFromSourceLine(lineText, documentId) {
	const text = String(lineText || '')
	const groupIds = new Set()
	EXPLICIT_SHARED_CREDIT_RELATION_RE.lastIndex = 0
	let match
	while ((match = EXPLICIT_SHARED_CREDIT_RELATION_RE.exec(text)) !== null) {
		const groupId = buildTrustedSourceSharedGroupId(match[1], documentId)
		if (groupId) groupIds.add(groupId)
	}
	return groupIds.size === 1 ? [...groupIds][0] : ''
}

function compactSharedCreditAnchor(value) {
	return String(value == null ? '' : value)
		.normalize('NFKC')
		.replace(/\s+/g, '')
		.toUpperCase()
}

function lineContainsExactCardTail(lineText, tail) {
	const source = String(lineText || '')
	const needle = String(tail || '').replace(/\D/g, '').slice(-4)
	if (needle.length !== 4) return false
	let at = source.indexOf(needle)
	while (at >= 0) {
		const before = at > 0 ? source[at - 1] : ''
		const after = source[at + needle.length] || ''
		if (!/\d/.test(before) && !/\d/.test(after)) return true
		at = source.indexOf(needle, at + needle.length)
	}
	return false
}

function sourceLineMatchesCard(lineText, card) {
	const compactLine = compactSharedCreditAnchor(lineText)
	const institution = compactSharedCreditAnchor(card && card.institution)
	if (!institution || !compactLine.includes(institution)) return false
	const tail = String(card && card.card_tail || '').replace(/\D/g, '').slice(-4)
	if (tail.length === 4) return lineContainsExactCardTail(lineText, tail)
	const dateVariants = compactDateVariants(card && card.start_date)
	return dateVariants.length > 0 && dateVariants.some(
		(value) => compactLine.includes(compactSharedCreditAnchor(value))
	)
}

function controlledSplitSharedCreditRecords(sourceLines, documentId) {
	const labels = ['授信协议编号', '信用协议编号', '共享额度组', '共享授信组', '额度组']
	const records = []
	const consecutive = (left, right) => Boolean(
		left && right &&
		left.pageNo === right.pageNo &&
		left.sourceBlockOrdinal === right.sourceBlockOrdinal &&
		right.sourceLineOrdinal === left.sourceLineOrdinal + 1
	)
	for (let index = 0; index < sourceLines.length; index += 1) {
		const left = sourceLines[index]
		const right = sourceLines[index + 1]
		for (const label of labels) {
			const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
			if (
				new RegExp(`${escapedLabel}[：:=#]?$`, 'u').test(left.text) &&
				consecutive(left, right)
			) {
				const combined = `${left.text}${right.text}`
				if (explicitSharedGroupIdFromSourceLine(combined, documentId)) records.push({ ...left, text: combined })
			}
			for (let split = 1; split <= label.length; split += 1) {
				const prefix = label.slice(0, split)
				const suffix = label.slice(split)
				if (!left.text.endsWith(prefix) || !consecutive(left, right) || !right.text.startsWith(suffix)) continue
				let combined = `${left.text}${right.text}`
				if (!explicitSharedGroupIdFromSourceLine(combined, documentId)) {
					const third = sourceLines[index + 2]
					const remainder = right.text.slice(suffix.length)
					if (!consecutive(right, third) || !/^[：:=#\s]*$/u.test(remainder)) continue
					combined += third.text
				}
				if (!explicitSharedGroupIdFromSourceLine(combined, documentId)) continue
				records.push({ ...left, text: combined })
			}
		}
	}
	return records
}

/**
 * Only native PDF line evidence may introduce an explicit shared-credit
 * relation. Model-provided group fields have already been removed by
 * sanitizeExtractedCreditFacts. A line must bind to exactly one card, a card
 * must claim exactly one relation, and a relation needs at least two distinct
 * cards before the opaque group id is injected for deterministic aggregation.
 */
function applyTrustedSourceSharedCreditGroups(data, options = {}) {
	if (options.evidenceRequired !== true) return data
	const cards = Array.isArray(data && data.credit_card_details)
		? data.credit_card_details
		: []
	if (cards.length < 2) return data
	const sourceLines = validNativePdfSourceLines(options.evidenceContext)
	const sourceRecords = [
		...sourceLines,
		...controlledSplitSharedCreditRecords(sourceLines, options.documentId)
	]
	const claimsByCard = new Map()
	for (const line of sourceRecords) {
		const groupId = explicitSharedGroupIdFromSourceLine(line.text, options.documentId)
		if (!groupId) continue
		const candidateIndexes = []
		for (let index = 0; index < cards.length; index += 1) {
			if (sourceLineMatchesCard(line.text, cards[index])) candidateIndexes.push(index)
		}
		if (candidateIndexes.length !== 1) continue
		const cardIndex = candidateIndexes[0]
		if (!claimsByCard.has(cardIndex)) claimsByCard.set(cardIndex, new Set())
		claimsByCard.get(cardIndex).add(groupId)
	}

	const membersByGroup = new Map()
	for (const [cardIndex, groupIds] of claimsByCard.entries()) {
		if (groupIds.size !== 1) continue
		const groupId = [...groupIds][0]
		if (!membersByGroup.has(groupId)) membersByGroup.set(groupId, [])
		membersByGroup.get(groupId).push(cardIndex)
	}
	for (const [groupId, memberIndexes] of membersByGroup.entries()) {
		const uniqueMembers = [...new Set(memberIndexes)].sort((a, b) => a - b)
		if (uniqueMembers.length < 2) continue
		for (const cardIndex of uniqueMembers) cards[cardIndex].shared_credit_group = groupId
	}
	return data
}

function assertEvidenceDerivedProjection(data, artifacts) {
	const metrics = artifacts?.derivedAnalysis?.metrics || {}
	const mismatch = (path, expected, actual) => {
		const error = new Error(`evidence derived projection mismatch at ${path}`)
		error.code = 'EVIDENCE_DERIVATION_MISMATCH'
		error.metricPath = path
		error.expected = expected
		error.actual = actual
		throw error
	}
	const moneyYuan = (metric) => Number(metric?.value?.minor) / 100
	const totalDebt = moneyYuan(metrics.totalDebt)
	if (!Number.isFinite(totalDebt) || Math.abs(totalDebt - Number(data?.credit_debt?.total_debt)) > 0.001) {
		mismatch('credit_debt.total_debt', totalDebt, data?.credit_debt?.total_debt)
	}
	const totalLoanBalance = moneyYuan(metrics.totalLoanBalance)
	const actualLoanBalance = Number(data?.credit_debt?.credit_loans?.total_balance)
	if (
		!Number.isFinite(totalLoanBalance) ||
		!Number.isFinite(actualLoanBalance) ||
		Math.abs(totalLoanBalance - actualLoanBalance) > 0.001
	) {
		mismatch(
			'credit_debt.credit_loans.total_balance',
			totalLoanBalance,
			data?.credit_debt?.credit_loans?.total_balance
		)
	}
	const utilization = metrics.cardUtilization
	const outstanding = metrics.cardOutstanding
	const utilizationHasNoPositiveLimit = utilization?.status === 'not_applicable'
	const expectedTotalLimit = utilization?.status === 'computed'
		? moneyYuan({ value: utilization.denominator })
		: (utilizationHasNoPositiveLimit ? 0 : Number.NaN)
	const actualTotalLimit = Number(data?.credit_debt?.credit_cards?.total_limit)
	if (!Number.isFinite(expectedTotalLimit) || expectedTotalLimit !== actualTotalLimit) {
		mismatch('credit_debt.credit_cards.total_limit', expectedTotalLimit, actualTotalLimit)
	}
	const expectedUtilizationUsed = utilization?.status === 'computed'
		? moneyYuan({ value: utilization.numerator })
		: (utilizationHasNoPositiveLimit ? 0 : Number.NaN)
	const actualUtilizationUsed = Number(data?.credit_debt?.credit_cards?.utilization_used)
	if (!Number.isFinite(expectedUtilizationUsed) || expectedUtilizationUsed !== actualUtilizationUsed) {
		mismatch('credit_debt.credit_cards.utilization_used', expectedUtilizationUsed, actualUtilizationUsed)
	}
	const expectedTotalUsed = moneyYuan(outstanding)
	const actualTotalUsed = Number(data?.credit_debt?.credit_cards?.total_used)
	if (!Number.isFinite(expectedTotalUsed) || expectedTotalUsed !== actualTotalUsed) {
		mismatch('credit_debt.credit_cards.total_used', expectedTotalUsed, actualTotalUsed)
	}
	const expectedRate = utilization?.status === 'computed'
		? Number(utilization?.value?.value) / 10000
		: 0
	if (Math.abs(expectedRate - Number(data?.credit_debt?.credit_cards?.usage_rate || 0)) > 0.0001) {
		mismatch('credit_debt.credit_cards.usage_rate', expectedRate, data?.credit_debt?.credit_cards?.usage_rate)
	}
	const facilityTrace = Array.isArray(outstanding?.facilityTrace)
		? outstanding.facilityTrace
		: null
	const expectedSharedGroupCount = facilityTrace
		? facilityTrace.filter((facility) =>
			Array.isArray(facility?.memberEntityIds) && facility.memberEntityIds.length > 1
		).length
		: Number.NaN
	const actualSharedGroupCount = Number(data?.credit_debt?.credit_cards?.shared_group_count)
	if (
		!Number.isFinite(expectedSharedGroupCount) ||
		expectedSharedGroupCount !== actualSharedGroupCount
	) {
		mismatch(
			'credit_debt.credit_cards.shared_group_count',
			expectedSharedGroupCount,
			actualSharedGroupCount
		)
	}
	const windows = metrics.queryCounts?.value || {}
	for (const months of [1, 3, 6, 12]) {
		const key = `last_${months}m`
		const expected = Number(windows[key])
		const actual = Number(data?.query_analysis?.summary?.[key]?.total)
		if (!Number.isFinite(expected) || expected !== actual) {
			mismatch(`query_analysis.summary.${key}.total`, expected, actual)
		}
	}
	const score = Number(metrics.primaryScore?.value?.value)
	const actualScore = Number(data?.primary_rule_score?.score)
	if (!Number.isFinite(score) || score !== actualScore) {
		mismatch('primary_rule_score.score', score, actualScore)
	}
	return true
}

function attachEvidenceFirstCreditAnalysis(data, sourceText, options = {}) {
	if (options.evidenceRequired !== true) return data
	const documentMeta = options.evidenceContext && typeof options.evidenceContext === 'object'
		? options.evidenceContext
		: {}
	const sourceVerifiedCounts = options.sourceVerifiedCounts ||
		buildEvidenceSourceVerifiedCounts(sourceText, options.queryEvidence, documentMeta)
	const versions = analysisVersions()
	const artifacts = buildEvidenceFirstCreditAnalysis({
		sourceText,
		documentId: options.documentId,
		evidenceContext: {
			facts: data,
			sourceVerifiedCounts,
			documentMeta
		},
		inputKind: options.inputKind || 'credit-report-pdf',
		declaredPageCount: Number(documentMeta.expectedPageCount || 0) || undefined,
		versions: { ...versions },
		ruleVersion: data?.derivation_meta?.rules_version || versions.rule,
		hashFn: evidenceArtifactHash,
		requirePublishable: true
	})
	assertEvidenceDerivedProjection(data, artifacts)
	data.evidence_v2 = artifacts
	data.evidence_meta = {
		version: 'evidence-v2',
		status: artifacts.status,
		authoritative_scope: [
			'credit_debt.total_debt',
			'credit_debt.credit_loans.total_balance',
			'credit_debt.credit_cards.total_limit',
			'credit_debt.credit_cards.total_used',
			'credit_debt.credit_cards.utilization_used',
			'credit_debt.credit_cards.usage_rate',
			'credit_debt.credit_cards.shared_group_count',
			'query_analysis.summary.last_1m.total',
			'query_analysis.summary.last_3m.total',
			'query_analysis.summary.last_6m.total',
			'query_analysis.summary.last_12m.total',
			'primary_rule_score.score'
		],
		manifest_hash: artifacts.manifest.manifestHash,
		evidence_hash: artifacts.evidenceGraph.evidenceGraphHash,
		fact_hash: artifacts.factLedger.factLedgerHash,
		metric_hash: artifacts.derivedAnalysis.derivedAnalysisHash,
		publication_gate: artifacts.publicationGate.status,
		fact_count: artifacts.factLedger.facts.length,
		supported_fact_count: artifacts.factLedger.facts.filter(
			(fact) => fact.status === 'accepted'
		).length
	}
	data.derivation_meta = {
		...(data.derivation_meta || {}),
		evidence_mode: 'evidence-v2',
		evidence_hash: data.evidence_meta.evidence_hash,
		fact_hash: data.evidence_meta.fact_hash,
		metric_hash: data.evidence_meta.metric_hash
	}
	return data
}

function finalizeExtractedCreditFacts(rawFacts, sourceText = '', options = {}) {
	let data = sanitizeExtractedCreditFacts(rawFacts)
	data = applyTrustedSourceSharedCreditGroups(data, options)
	if (options.evidenceRequired === true) {
		data = applyControlledSourceCardInstallments(data, sourceText, {
			documentId: options.documentId,
			declaredPageCount: Number(options.evidenceContext?.expectedPageCount || 0) || undefined,
			documentMeta: options.evidenceContext,
			hashFn: evidenceArtifactHash
		})
	}
	data.derivation_meta = {
		mode: 'deterministic-v1',
		...(options.evidenceRequired === true ? { evidence_mode: 'evidence-v2' } : {})
	}
	// Prove the model returned every declared extraction row before deterministic
	// reclassification changes the transport buckets.
	assertDeterministicFactCoverage(data)
	data = normalizeCreditAnalysisAggregates(data, sourceText, {
		documentMeta: options.evidenceContext
	})
	data = runCreditRuleEngine(data)
	if (
		!data ||
		data.derivation_meta?.mode !== 'deterministic-v1' ||
		!data.credit_debt ||
		!data.query_analysis ||
		!data.primary_rule_score
	) {
		throw new Error('deterministic credit rule engine did not produce a complete result')
	}
	data = attachAuthoritativeDeterministicDimensions(data)
	data.report_interpretation = buildStructuredReportInterpretation(data)
	if (data.frontend_payload && typeof data.frontend_payload === 'object') {
		data.frontend_payload.report_interpretation = data.report_interpretation
	}
	return attachEvidenceFirstCreditAnalysis(data, sourceText, options)
}

function buildCreditChatRequest(
	userText,
	maxTokens = Number(process.env.DEEPSEEK_OUTPUT_MAX_TOKENS || DEFAULT_DEEPSEEK_OUTPUT_MAX_TOKENS),
	systemPrompt = TEXT_SCHEMA_PROMPT
) {
	return {
		model: TEXT_MODEL,
		temperature: 0,
		max_tokens: maxTokens,
		response_format: { type: 'json_object' },
		thinking: { type: 'disabled' },
		messages: [
			{ role: 'system', content: String(systemPrompt || TEXT_SCHEMA_PROMPT) },
			{ role: 'user', content: String(userText || '') }
		]
	}
}

function applyReportDateFallback(data, reportDate) {
	if (!data || typeof data !== 'object' || Array.isArray(data)) return data
	if (!data.meta || typeof data.meta !== 'object' || Array.isArray(data.meta)) return data
	if (!parseDateMs(data.meta.report_date) && parseDateMs(reportDate)) {
		data.meta.report_date = reportDate
	}
	return data
}

function hasCompleteSupplementalQueryEvidence(evidence) {
	const total = Number(evidence && evidence.query_details_total)
	const rows = asArray(evidence && evidence.query_details)
	return evidence?.complete !== false &&
		Number.isInteger(total) &&
		total >= 0 &&
		total <= 500 &&
		completeSourceQueryRows(rows, total, 'query_details').length === total
}

function supplementalQueryEvidenceMatchesSourceSubset(sourceText, evidence) {
	if (!hasCompleteSupplementalQueryEvidence(evidence)) return false
	const source = String(sourceText || '')
	const bounds = institutionQuerySectionBounds(source)
	const total = Number(evidence.query_details_total)
	const evidenceRows = completeSourceQueryRows(
		asArray(evidence.query_details),
		total,
		'query_details'
	)
	if (evidenceRows.length !== total) return false
	if (!bounds.bounded && !institutionQueryTerminalSectionProof(source, bounds)) {
		return total === 0 && !hasInstitutionQuerySectionSignal(source, bounds)
	}
	if (total === 0 && !hasExplicitEmptyInstitutionQueryTable(source, bounds)) return false
	const evidenceBySequence = new Map(evidenceRows.map((row) => [Number(row.seq), row]))
	const rawSequences = numberedQuerySequences(
		source.slice(bounds.institutionStart, bounds.bounded ? bounds.selfStart : source.length)
	)
	if (rawSequences.some((seq) => !Number.isInteger(seq) || seq < 1 || seq > total)) {
		return false
	}
	// A complete two-pass OCR result may legitimately contain a terminal row
	// that the first pass omitted (for example first-pass 1..141 vs consensus
	// 1..142). Every valid row that *was* visible in the first pass must still
	// agree byte-for-byte after normalization; otherwise fail closed.
	for (const row of extractSourceQueryRecords(source).query_details) {
		const seq = Number(row && row.seq)
		if (!Number.isInteger(seq) || seq < 1 || seq > total) return false
		if (!isValidSourceQueryRow(row, 'query_details')) continue
		const verified = evidenceBySequence.get(seq)
		if (!verified || queryRowTuple(row) !== queryRowTuple(verified)) return false
	}
	return true
}

function resolveCompleteQueryEvidence(sourceText, supplementalEvidence = null) {
	const bounds = institutionQuerySectionBounds(sourceText)
	if (!bounds.bounded && !institutionQueryTerminalSectionProof(sourceText, bounds)) return null
	if (supplementalEvidence != null) {
		if (!supplementalQueryEvidenceMatchesSourceSubset(sourceText, supplementalEvidence)) return null
		const supplementalTotal = Number(supplementalEvidence.query_details_total)
		return {
			complete: true,
			query_details_total: supplementalTotal,
			query_details: completeSourceQueryRows(
				asArray(supplementalEvidence.query_details),
				supplementalTotal,
				'query_details'
			)
		}
	}
	const counts = extractSourceQueryRecordCounts(sourceText) || {}
	const sourceRecords = extractSourceQueryRecords(sourceText).query_details
	const declaredTotal = Number(counts.query_details_total)
	const total = Number.isInteger(declaredTotal)
		? declaredTotal
		: (sourceRecords.length === 0 && hasExplicitEmptyInstitutionQueryTable(sourceText, bounds)
			? 0
			: Number.NaN)
	if (!Number.isInteger(total) || total < 0 || total > 500) return null
	const sourceRows = completeSourceQueryRows(
		sourceRecords,
		total,
		'query_details'
	)
	if (sourceRows.length !== total) return null
	return { complete: true, query_details_total: total, query_details: sourceRows }
}

function stripVerifiedQuerySectionForModel(sourceText, queryEvidence) {
	const source = String(sourceText || '')
	if (!hasCompleteSupplementalQueryEvidence(queryEvidence)) return source
	const bounds = institutionQuerySectionBounds(source)
	if (bounds.bounded) {
		return [
			source.slice(0, bounds.institutionStart).trimEnd(),
			'【机构查询明细由服务端独立核验，此处不交给模型生成】',
			source.slice(bounds.selfStart).trimStart()
		].filter(Boolean).join('\n\n')
	}
	if (!institutionQueryTerminalSectionProof(source, bounds)) return source
	return [
		source.slice(0, bounds.institutionStart).trimEnd(),
		'【机构查询明细由服务端独立核验，此处不交给模型生成】'
	].filter(Boolean).join('\n\n')
}

function deferVerifiedInstitutionQueries(data) {
	if (!data || typeof data !== 'object' || Array.isArray(data)) return data
	if (!data.query_analysis || typeof data.query_analysis !== 'object' || Array.isArray(data.query_analysis)) {
		return data
	}
	if (!data._coverage || typeof data._coverage !== 'object' || Array.isArray(data._coverage)) {
		return data
	}
	if (!data._coverage.counts || typeof data._coverage.counts !== 'object' || Array.isArray(data._coverage.counts)) {
		return data
	}
	data.query_analysis.query_details = []
	data._coverage.counts.query_details = { total: 0, listed: 0 }
	data._coverage.has_queries = asArray(data.query_analysis.self_queries).length > 0
	return data
}

async function extractRawCreditFactsOnce(sourceText, options) {
	const body = buildCreditChatRequest(
		options.userText || sourceText,
		options.maxTokens,
		options.systemPrompt || TEXT_SCHEMA_PROMPT
	)
	const resp = await callCreditChatStream(options.apiKey, body)
	const diagnostic = options.chunk
		? { chunk: options.chunk.index + 1, chunks: options.chunk.total }
		: {}
	if (!resp.ok) {
		const tokenLimit = looksLikeTokenLimitErr(resp.errMsg)
		return {
			ok: false,
			httpStatus: tokenLimit ? 422 : (resp.status || 502),
			errCode: tokenLimit ? 'ANALYSIS_CONTEXT_LIMIT' : 'ANALYSIS_UPSTREAM_FAILED',
			errMsg: tokenLimit
				? '报告分块仍超出模型完整上下文，已停止评分'
				: (resp.errMsg || '分析服务异常')
		}
	}
	const content = resp.content || ''
	const finishReason = resp.finishReason
	if (finishReason !== 'stop') {
		logger.warn({
			...diagnostic,
			finishReason: String(finishReason || 'unknown').slice(0, 32),
			contentLen: String(content).length,
			maxTokens: options.maxTokens
		}, 'analyze-text: incomplete model output')
		return {
			ok: false,
			httpStatus: 502,
			errCode: 'ANALYSIS_OUTPUT_TRUNCATED',
			errMsg: '模型输出不完整，已停止评分，请重试'
		}
	}
	let data = null
	try {
		data = JSON.parse(String(content).trim())
	} catch {
		data = null
	}
	if (!data) {
		logger.error({
			...diagnostic,
			finishReason: String(finishReason || 'unknown').slice(0, 32),
			contentLen: String(content || '').length
		}, 'analyze-text: non-json response')
		return {
			ok: false,
			httpStatus: 502,
			errCode: 'ANALYSIS_NON_JSON_OUTPUT',
			errMsg: 'DeepSeek 返回非 JSON'
		}
	}
	data = applyReportDateFallback(data, options.reportDate)
	data = pruneEmptyCoverageRows(data)
	if (options.deferQueryDetails === true) data = deferVerifiedInstitutionQueries(data)
	if (options.reconcileQueries === true) {
		data = reconcileSourceQueryCoverage(
			data,
			options.reconcileSourceText || sourceText,
			options.queryEvidence
		)
	}
	data = await repairIncompleteFactCoverage(data, sourceText, options.apiKey, options.maxTokens)
	try {
		validateExtractedCreditFactsSchema(data)
	} catch (error) {
		logger.warn({
			...diagnostic,
			code: error && error.code ? error.code : 'FACT_SCHEMA_INVALID',
			schemaPath: error && error.schemaPath ? error.schemaPath : 'unknown',
			schemaReason: error && error.schemaReason ? error.schemaReason : 'unknown'
		}, 'analyze-text: strict fact schema rejected model output')
		return {
			ok: false,
			httpStatus: 502,
			errCode: 'FACT_SCHEMA_INVALID',
			errMsg: '模型事实结构不完整，已停止评分，请重试'
		}
	}
	return { ok: true, data, finishReason }
}

async function mapCreditChunks(items, concurrency, task) {
	const results = new Array(items.length)
	let cursor = 0
	let failure = null
	const worker = async () => {
		while (!failure) {
			const index = cursor++
			if (index >= items.length) return
			const result = await task(items[index], index)
			if (!result.ok) {
				failure = result
				return
			}
			results[index] = result
		}
	}
	await Promise.all(Array.from(
		{ length: Math.min(concurrency, items.length) },
		() => worker()
	))
	return failure ? { ok: false, failure } : { ok: true, results }
}

function finalizeCreditFacts(data, sourceText, sourceLength, sentLength, finishReason, options = {}) {
	const cov = data._coverage && typeof data._coverage === 'object' ? data._coverage : {}
	cov.source_text_length = sourceLength
	cov.sent_text_length = sentLength
	cov.truncated = false
	cov.llm_finish_reason = finishReason || cov.llm_finish_reason || null
	cov.llm_output_truncated = false
	data._coverage = cov

	data = sanitizeExtractedCreditFacts(data)
	data = applyTrustedSourceSharedCreditGroups(data, options)
	if (options.evidenceRequired === true) {
		data = applyControlledSourceCardInstallments(data, sourceText, {
			documentId: options.documentId,
			declaredPageCount: Number(options.evidenceContext?.expectedPageCount || 0) || undefined,
			documentMeta: options.evidenceContext,
			hashFn: evidenceArtifactHash
		})
	}
	data.derivation_meta = {
		mode: 'deterministic-v1',
		...(options.evidenceRequired === true ? { evidence_mode: 'evidence-v2' } : {})
	}
	// Coverage belongs to the extracted transport arrays.  Verify it before the
	// server deterministically repartitions loans by institution name.
	assertDeterministicFactCoverage(data, { requireLlmFinishReason: true })
	data = normalizeCreditAnalysisAggregates(data, sourceText, {
		documentMeta: options.evidenceContext
	})
	data = runCreditRuleEngine(data)
	if (
		!data ||
		data.derivation_meta?.mode !== 'deterministic-v1' ||
		!data.credit_debt ||
		!data.query_analysis ||
		!data.primary_rule_score
	) {
		throw new Error('deterministic credit rule engine did not produce a complete result')
	}
	data = attachAuthoritativeDeterministicDimensions(data)
	data.report_interpretation = buildStructuredReportInterpretation(data)
	if (data.frontend_payload && typeof data.frontend_payload === 'object') {
		data.frontend_payload.report_interpretation = data.report_interpretation
	}
	return attachEvidenceFirstCreditAnalysis(data, sourceText, options)
}

async function notifyAnalysisStage(options, stage, progress, detail = {}) {
	if (!options || typeof options.onStage !== 'function') return
	try {
		await options.onStage(
			String(stage || ''),
			Math.max(0, Math.min(100, Math.trunc(Number(progress) || 0))),
			{ ...detail }
		)
	} catch (error) {
		logger.warn({
			code: safeErrorCode(error, 'ANALYSIS_STAGE_CALLBACK_FAILED'),
			stage: String(stage || '').slice(0, 64)
		}, 'analyze-text: stage callback failed without affecting analysis')
	}
}

function incompleteQueryEvidenceResult(reason) {
	logger.warn({
		reason: String(reason || 'unverified').slice(0, 64)
	}, 'analyze-text: institution query evidence is incomplete')
	return {
		ok: false,
		httpStatus: 422,
		errCode: 'QUERY_EVIDENCE_INCOMPLETE',
		errMsg: '机构查询明细无法完整核验，已停止评分'
	}
}

const UNSUPPORTED_AUTHORITATIVE_EVIDENCE_MODES = new Set(['ocr', 'ocr-image'])

/**
 * Authoritative scoring may start only when the source can prove every field's
 * record membership. OCR currently exposes page text, but not trustworthy
 * record-level spans/bounds; treating that text as ordinary lines can join two
 * accounts or queries. Fail before credentials, stages, OCR-derived facts, or
 * model traffic instead of publishing an unverifiable score.
 */
function preflightCreditEvidenceSource(options = {}) {
	if (options.evidenceRequired !== true) return null
	const evidenceContext = options.evidenceContext && typeof options.evidenceContext === 'object'
		? options.evidenceContext
		: {}
	const sourceMode = String(evidenceContext.sourceMode || '').trim().toLowerCase()

	if (UNSUPPORTED_AUTHORITATIVE_EVIDENCE_MODES.has(sourceMode)) {
		return {
			ok: false,
			httpStatus: 422,
			errCode: 'OCR_STRUCTURED_EVIDENCE_UNAVAILABLE',
			errMsg: '扫描件逐条证据绑定尚未通过验证，已在模型调用前停止；请上传征信中心下载的原始文字版 PDF'
		}
	}

	if (sourceMode === 'pdf-parse-legacy' || (sourceMode === 'pdf-text' && evidenceContext.complete !== true)) {
		return {
			ok: false,
			httpStatus: 422,
			errCode: 'PDF_EVIDENCE_SOURCE_UNVERIFIED',
			errMsg: 'PDF 文字层无法形成完整逐项证据，已在模型调用前停止；请重新下载官方原始 PDF'
		}
	}

	return null
}

async function runCreditLLMAnalysis(text, options = {}) {
	if (typeof text !== 'string' || text.trim().length < 50) {
		return { ok: false, httpStatus: 400, errMsg: 'text 缺失或过短' }
	}
	const evidenceSourceBlocked = preflightCreditEvidenceSource(options)
	if (evidenceSourceBlocked) return evidenceSourceBlocked
	const apiKey =
		process.env.DEEPSEEK_API_KEY ||
		process.env.KIMI_API_KEY ||
		process.env.MOONSHOT_API_KEY
	if (!apiKey) {
		return { ok: false, httpStatus: 500, errMsg: 'DEEPSEEK_API_KEY not configured' }
	}
	const PRIMARY_CHARS = boundedPositiveInt(
		process.env.DEEPSEEK_INPUT_MAX_CHARS,
		DEFAULT_DEEPSEEK_INPUT_MAX_CHARS,
		1000,
		DEFAULT_CREDIT_DOCUMENT_MAX_CHARS
	)
	const MAX_OUT = boundedPositiveInt(
		process.env.DEEPSEEK_OUTPUT_MAX_TOKENS,
		DEFAULT_DEEPSEEK_OUTPUT_MAX_TOKENS,
		1024,
		DEFAULT_DEEPSEEK_OUTPUT_MAX_TOKENS
	)
	const documentMaxChars = boundedPositiveInt(
		process.env.CREDIT_DOCUMENT_MAX_CHARS,
		DEFAULT_CREDIT_DOCUMENT_MAX_CHARS,
		PRIMARY_CHARS,
		5000000
	)
	if (text.length > documentMaxChars) {
		logger.warn({ originalChars: text.length, documentMaxChars }, 'analyze-text: document exceeds hard limit')
		return {
			ok: false,
			httpStatus: 422,
			errCode: 'ANALYSIS_INPUT_TOO_LARGE',
			errMsg: `报告原文超过分块分析硬上限（${documentMaxChars} 字符），已停止评分`
		}
	}

	await notifyAnalysisStage(options, 'query_evidence', 40, { status: 'started' })
	// 范围界定：文末终止表证明（institutionQueryTerminalSectionProof）只服务
	// 文字层 PDF。扫描件 OCR 补充证据在上游 rescue 阶段仍要求有界区段，
	// complete:false 会在此处 fail-closed——是有意保留的口径（扫描件属
	// 阶段 5-6 专项），不是遗漏。
	if (options.queryEvidence && options.queryEvidence.complete === false) {
		return incompleteQueryEvidenceResult(options.queryEvidence.reason)
	}
	const queryBounds = institutionQuerySectionBounds(text)
	const hasQuerySectionSignal = hasInstitutionQuerySectionSignal(text, queryBounds)
	let queryEvidence = resolveCompleteQueryEvidence(text, options.queryEvidence)
	if (!queryEvidence && hasQuerySectionSignal) {
		return incompleteQueryEvidenceResult(
			queryBounds.bounded ? 'query-rows-not-provably-complete' : 'query-section-unbounded'
		)
	}
	if (!queryEvidence) {
		// A source with no institution-query section cannot ask the model to
		// invent one. Treat the independently observed absence as an empty table;
		// any partial/header signal above remains fail-closed.
		queryEvidence = { complete: true, query_details_total: 0, query_details: [] }
	}
	await notifyAnalysisStage(options, 'query_evidence', 50, {
		status: 'verified',
		total: Number(queryEvidence.query_details_total) || 0
	})
	const modelText = stripVerifiedQuerySectionForModel(text, queryEvidence)
	const chunks = buildDeterministicCreditChunks(modelText, {
		triggerChars: process.env.DEEPSEEK_CHUNK_TRIGGER_CHARS,
		triggerPages: process.env.DEEPSEEK_CHUNK_TRIGGER_PAGES,
		maxChars: process.env.DEEPSEEK_CHUNK_MAX_CHARS,
		maxPages: process.env.DEEPSEEK_CHUNK_MAX_PAGES
	})
	await notifyAnalysisStage(options, 'fact_extraction', 55, {
		status: 'started',
		completed: 0,
		total: chunks.length
	})
	const sourceBasic = extractSourceBasicInfo(text)
	const deterministicReportDate = sourceBasic.report_date || ''
	let extracted = null
	let finishReason = 'stop'
	let sentLength = modelText.length

	if (chunks.length === 1) {
		const compressed = compressCreditText(modelText, PRIMARY_CHARS)
		if (compressed.truncated) {
			return {
				ok: false,
				httpStatus: 422,
				errCode: 'ANALYSIS_INPUT_TOO_LARGE',
				errMsg: '报告需要分块分析，但当前分块配置未产生安全分块'
			}
		}
		const result = await extractRawCreditFactsOnce(compressed.text, {
			apiKey,
			maxTokens: MAX_OUT,
			systemPrompt: QUERY_EVIDENCE_PROMPT,
			reportDate: deterministicReportDate,
			deferQueryDetails: true,
			reconcileQueries: true,
			reconcileSourceText: text,
			queryEvidence
		})
		if (!result.ok) return result
		await notifyAnalysisStage(options, 'fact_extraction', 82, {
			status: 'progress',
			completed: 1,
			total: 1
		})
		extracted = result.data
		finishReason = result.finishReason
		sentLength = compressed.text.length
	} else {
		const chunkMaxTokens = boundedPositiveInt(
			process.env.DEEPSEEK_CHUNK_OUTPUT_MAX_TOKENS,
			DEFAULT_CREDIT_CHUNK_OUTPUT_MAX_TOKENS,
			4096,
			Math.min(MAX_OUT, 65536)
		)
		const concurrency = boundedPositiveInt(
			process.env.DEEPSEEK_CHUNK_CONCURRENCY,
			DEFAULT_CREDIT_CHUNK_CONCURRENCY,
			1,
			4
		)
		const deferQueryDetails = true
		const chunkSystemPrompt = CHUNK_QUERY_EVIDENCE_PROMPT
		let completedChunks = 0
		const extractChunk = async (chunk, reportDate) => {
			const result = await extractRawCreditFactsOnce(chunk.text, {
				apiKey,
				maxTokens: chunkMaxTokens,
				systemPrompt: chunkSystemPrompt,
			userText: buildChunkUserText(chunk, reportDate),
			reportDate,
			chunk,
			deferQueryDetails
			})
			completedChunks += 1
			await notifyAnalysisStage(
				options,
				'fact_extraction',
				55 + Math.floor((27 * completedChunks) / chunks.length),
				{
				status: 'progress',
				completed: completedChunks,
				total: chunks.length,
				chunk: chunk.index + 1
				}
			)
			return result
		}
		let chunkResults = []
		if (deterministicReportDate) {
			// 报告日期已由原文确定时，所有不重叠片段可以直接进入同一有界并发池；
			// 不再让第 1 块单独占用一个完整模型生成周期。
			const batch = await mapCreditChunks(
				chunks,
				concurrency,
				(chunk) => extractChunk(chunk, deterministicReportDate)
			)
			if (!batch.ok) return batch.failure
			chunkResults = batch.results
		} else {
			// 无法从原文稳定读取报告日时，先仅用首页块取得锚点，再并行其余块。
			const first = await extractChunk(chunks[0], '')
			if (!first.ok) return first
			const reportDate = first.data.meta.report_date || ''
			const remaining = await mapCreditChunks(
				chunks.slice(1),
				concurrency,
				(chunk) => extractChunk(chunk, reportDate)
			)
			if (!remaining.ok) return remaining.failure
			chunkResults = [first, ...remaining.results]
		}
		try {
			extracted = mergeExtractedCreditFactChunks(chunkResults.map((result) => result.data))
			extracted = reconcileSourceQueryCoverage(extracted, text, queryEvidence)
			const expectedQueries = Number(queryEvidence.query_details_total)
			const actualQueries = asArray(extracted.query_analysis?.query_details).length
			const coverageQueries = Number(extracted._coverage?.counts?.query_details?.total)
			if (actualQueries !== expectedQueries || coverageQueries !== expectedQueries) {
				throw chunkMergeError(
					'CHUNK_QUERY_EVIDENCE_MISMATCH',
					'$._coverage.counts.query_details'
				)
			}
			assertSourceAccountOverviewCoverage(extracted, text, options.evidenceContext)
			validateExtractedCreditFactsSchema(extracted)
		} catch (error) {
			const safeCode = /^CHUNK_[A-Z0-9_]{1,56}$/.test(String(error && error.code || ''))
				? String(error.code)
				: 'FACT_SCHEMA_INVALID'
			const overviewMismatch = safeCode === 'CHUNK_SOURCE_OVERVIEW_MISMATCH'
			const expectedCount = typeof (error && error.expectedCount) === 'number' &&
				Number.isSafeInteger(error.expectedCount) &&
				error.expectedCount >= 0 && error.expectedCount <= 1000000
				? error.expectedCount
				: undefined
			const actualCount = typeof (error && error.actualCount) === 'number' &&
				Number.isSafeInteger(error.actualCount) &&
				error.actualCount >= 0 && error.actualCount <= 1000000
				? error.actualCount
				: undefined
			const diagnostic = overviewMismatch && expectedCount !== undefined && actualCount !== undefined
				? Object.freeze({ version: 1, expectedCount, actualCount })
				: undefined
			logger.warn(overviewMismatch
				? { code: safeCode, diagnostic }
				: {
					code: safeCode,
					schemaPath: error && error.schemaPath ? error.schemaPath : 'unknown',
					expectedCount,
					actualCount,
					chunks: chunks.length
				}, 'analyze-text: chunk merge rejected')
			return {
				ok: false,
				httpStatus: overviewMismatch ? 422 : 502,
				errCode: safeCode,
				...(diagnostic ? { diagnostic } : {}),
				errMsg: overviewMismatch
					? '报告概要与账户明细无法一致核验，已安全停止评分'
					: '分块事实合并不完整，已停止评分，请重试'
			}
		}
		logger.info({
			chunks: chunks.length,
			sourceChars: text.length,
			maxChunkChars: Math.max(...chunks.map((chunk) => chunk.text.length)),
			concurrency
		}, 'analyze-text: deterministic chunk extraction complete')
	}

	try {
		await notifyAnalysisStage(options, 'rule_validation', 86, { status: 'started' })
		const data = finalizeCreditFacts(
			extracted,
			text,
			text.length,
			sentLength,
			finishReason,
			{
				evidenceRequired: options.evidenceRequired === true,
				evidenceContext: options.evidenceContext,
				sourceVerifiedCounts: options.sourceVerifiedCounts,
				queryEvidence,
				inputKind: options.inputKind || 'credit-report-pdf',
				documentId: options.documentId
			}
		)
		return { ok: true, data }
	} catch (e) {
		const safeCode = /^[A-Z0-9_]{1,64}$/.test(String(e && e.code || ''))
			? String(e.code)
			: 'DETERMINISTIC_RULE_ENGINE_FAILED'
		logger.error({
			code: safeCode,
			failedChecks: Array.isArray(e && e.failedChecks)
				? e.failedChecks.slice(0, 8)
				: undefined,
			evidenceDiagnostic: safeCode === 'EVIDENCE_PUBLICATION_BLOCKED' &&
				e && e.diagnostic && typeof e.diagnostic === 'object'
				? e.diagnostic
				: undefined,
			coverageIssues: Array.isArray(e && e.coverageIssues)
				? e.coverageIssues.slice(0, Object.keys(FACT_COVERAGE_ARRAYS).length)
				: undefined
		}, 'analyze-text: authoritative analysis gate failed')
		const evidenceBlocked = /^EVIDENCE_[A-Z0-9_]+$/.test(safeCode)
		return {
			ok: false,
			httpStatus: evidenceBlocked ? 422 : 500,
			errCode: safeCode,
			failedChecks: Array.isArray(e && e.failedChecks) ? e.failedChecks : undefined,
			evidenceDiagnostic: safeCode === 'EVIDENCE_PUBLICATION_BLOCKED' &&
				e && e.diagnostic && typeof e.diagnostic === 'object'
				? e.diagnostic
				: undefined,
			coverageIssues: Array.isArray(e && e.coverageIssues) ? e.coverageIssues : undefined,
			errMsg: evidenceBlocked
				? '报告证据链不足或存在冲突，已停止发布评分'
				: '确定性规则计算失败，请稍后重试'
		}
	}
}

module.exports = {
	findPdfHeaderOffset,
	buildPdfParseResult,
	scannedPdfToText,
	preflightCreditEvidenceSource,
	runCreditLLMAnalysis,
	buildCreditChatRequest,
	buildDeterministicCreditChunks,
	buildChunkUserText,
	mergeExtractedCreditFactChunks,
	assertSourceAccountOverviewCoverage,
	resolveCompleteQueryEvidence,
	stripVerifiedQuerySectionForModel,
	addDeterministicPdfPageMarkers,
	callCreditChatStream,
	callCreditChatStreamOnce,
	reconcileSourceQueryCoverage,
	extractSourceQueryRecordCounts,
	extractSourceQueryRecords,
	normalizeCreditAnalysisAggregates,
	sanitizeExtractedCreditFacts,
	validateExtractedCreditFactsSchema,
	canonicalizeExtractedCreditFacts,
	finalizeExtractedCreditFacts,
	assertDeterministicFactCoverage,
	attachAuthoritativeDeterministicDimensions,
	applyTrustedSourceSharedCreditGroups,
	attachEvidenceFirstCreditAnalysis,
	buildEvidenceSourceVerifiedCounts,
	runOcrWithRetry,
	buildIncompleteOcrError,
	extractSourceBasicInfo,
	extractRawOwnershipProof,
	resolveFirstPageOwnershipEvidence,
	assertReportOwnershipEvidence,
	secureScannedFirstPageOwnership
}
