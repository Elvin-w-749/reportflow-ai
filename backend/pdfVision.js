'use strict'

let mupdfLoader = null

async function loadMupdf() {
	if (!mupdfLoader) {
		mupdfLoader = import('mupdf').then((mod) => mod.default || mod)
	}
	return mupdfLoader
}

function positiveNumber(value, fallback) {
	const n = Number(value)
	return Number.isFinite(n) && n > 0 ? n : fallback
}

function normalizePdfBuffer(input) {
	if (Buffer.isBuffer(input)) return input
	if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
	if (input instanceof ArrayBuffer) return Buffer.from(input)
	throw new Error('PDF 渲染失败：输入不是有效二进制')
}

function pageLimitError(total, maxPages) {
	const error = new Error('PDF page count exceeds the configured limit')
	error.code = 'PDF_PAGE_LIMIT_EXCEEDED'
	error.total = total
	error.maxPages = maxPages
	return error
}

function pageOutOfRangeError(pageNumber, total) {
	const error = new RangeError('PDF page number is out of range')
	error.code = 'PDF_PAGE_OUT_OF_RANGE'
	error.pageNumber = pageNumber
	error.total = total
	return error
}

function normalizeOptions(opts = {}) {
	return {
		maxPages: Math.max(1, Math.floor(positiveNumber(opts.maxPages, 20))),
		scale: Math.max(0.5, Math.min(4, positiveNumber(opts.scale, 2))),
	}
}

async function openPdfForRendering(pdfBuffer, opts) {
	const mupdf = await loadMupdf()
	const buf = normalizePdfBuffer(pdfBuffer)
	const { maxPages, scale } = normalizeOptions(opts)
	let doc = null

	try {
		doc = mupdf.Document.openDocument(buf, 'application/pdf')
		const total = Number(doc.countPages() || 0)
		if (total > maxPages) throw pageLimitError(total, maxPages)

		return {
			doc,
			mupdf,
			total,
			matrix: mupdf.Matrix.scale(scale, scale),
		}
	} catch (error) {
		if (doc && typeof doc.destroy === 'function') doc.destroy()
		throw error
	}
}

function renderOpenDocumentPage({ doc, mupdf, matrix }, pageIndex) {
	let page = null
	let pixmap = null
	try {
		page = doc.loadPage(pageIndex)
		pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false)
		return Buffer.from(pixmap.asPNG()).toString('base64')
	} finally {
		if (pixmap && typeof pixmap.destroy === 'function') pixmap.destroy()
		if (page && typeof page.destroy === 'function') page.destroy()
	}
}

function copyRect(rect) {
	if (!rect || typeof rect.length !== 'number' || rect.length < 4) return null
	return [Number(rect[0]), Number(rect[1]), Number(rect[2]), Number(rect[3])]
}

function collectStructuredPageText(page, structuredTextOptions) {
	let structuredText = null
	const draftBlocks = []
	let currentBlock = null
	let currentLine = null

	const finishLine = () => {
		if (!currentLine) return
		if (!currentBlock) currentBlock = { bbox: null, lines: [] }
		currentBlock.lines.push({
			bbox: currentLine.bbox,
			text: currentLine.characters.join(''),
		})
		currentLine = null
	}

	const finishBlock = () => {
		finishLine()
		if (!currentBlock) return
		draftBlocks.push(currentBlock)
		currentBlock = null
	}

	try {
		structuredText = typeof structuredTextOptions === 'string'
			? page.toStructuredText(structuredTextOptions)
			: page.toStructuredText()

		structuredText.walk({
			beginTextBlock(bbox) {
				finishBlock()
				currentBlock = { bbox: copyRect(bbox), lines: [] }
			},
			beginLine(bbox) {
				finishLine()
				if (!currentBlock) currentBlock = { bbox: null, lines: [] }
				currentLine = { bbox: copyRect(bbox), characters: [] }
			},
			onChar(character) {
				if (!currentBlock) currentBlock = { bbox: null, lines: [] }
				if (!currentLine) currentLine = { bbox: null, characters: [] }
				currentLine.characters.push(String(character || ''))
			},
			endLine() {
				finishLine()
			},
			endTextBlock() {
				finishBlock()
			},
		})
		finishBlock()

		let text = ''
		const blocks = draftBlocks.map((block, blockIndex) => {
			if (blockIndex > 0) text += '\n\n'
			const charStart = text.length
			const lines = block.lines.map((line, lineIndex) => {
				if (lineIndex > 0) text += '\n'
				const lineStart = text.length
				text += line.text
				return {
					text: line.text,
					charStart: lineStart,
					charEnd: text.length,
					bbox: line.bbox,
				}
			})

			return {
				text: text.slice(charStart),
				charStart,
				charEnd: text.length,
				bbox: block.bbox,
				lines,
			}
		})

		return { text, blocks }
	} finally {
		if (structuredText && typeof structuredText.destroy === 'function') structuredText.destroy()
	}
}

/**
 * Extract native PDF text while preserving the document's real page boundary
 * and MuPDF text block/line geometry. Character offsets are zero-based UTF-16
 * offsets into each page's `text` value; `charEnd` is exclusive.
 *
 * Pages without a native text layer are retained with empty `text` and
 * `blocks`, allowing callers to select OCR fallback without losing page order.
 *
 * @param {Buffer|Uint8Array|ArrayBuffer} pdfBuffer
 * @param {{ maxPages?: number, structuredTextOptions?: string }} opts
 * @returns {Promise<{
 *   total: number,
 *   pages: Array<{
 *     pageNumber: number,
 *     bounds: number[]|null,
 *     text: string,
 *     blocks: Array<{
 *       text: string,
 *       charStart: number,
 *       charEnd: number,
 *       bbox: number[]|null,
 *       lines: Array<{
 *         text: string,
 *         charStart: number,
 *         charEnd: number,
 *         bbox: number[]|null
 *       }>
 *     }>
 *   }>,
 *   text: string
 * }>}
 */
async function extractPdfStructuredText(pdfBuffer, opts = {}) {
	const context = await openPdfForRendering(pdfBuffer, opts)
	const pages = []

	try {
		for (let pageIndex = 0; pageIndex < context.total; pageIndex += 1) {
			let page = null
			try {
				page = context.doc.loadPage(pageIndex)
				const structured = collectStructuredPageText(page, opts.structuredTextOptions)
				pages.push({
					pageNumber: pageIndex + 1,
					bounds: copyRect(page.getBounds()),
					text: structured.text,
					blocks: structured.blocks,
				})
			} finally {
				if (page && typeof page.destroy === 'function') page.destroy()
			}
		}

		return {
			total: context.total,
			pages,
			text: pages
				.map((page) => `【第${page.pageNumber}页】${page.text ? `\n${page.text}` : ''}`)
				.join('\n\n'),
		}
	} finally {
		if (context.doc && typeof context.doc.destroy === 'function') context.doc.destroy()
	}
}

/**
 * Lazily render PDF pages one at a time. Native page and pixmap resources are
 * released before control is yielded to the consumer.
 *
 * @param {Buffer|Uint8Array|ArrayBuffer} pdfBuffer
 * @param {{ maxPages?: number, scale?: number }} opts
 * @returns {AsyncGenerator<{ total: number, pageNumber: number, base64: string }>}
 */
async function* iteratePdfPagesToPngBase64(pdfBuffer, opts = {}) {
	const context = await openPdfForRendering(pdfBuffer, opts)

	try {
		for (let pageIndex = 0; pageIndex < context.total; pageIndex += 1) {
			const base64 = renderOpenDocumentPage(context, pageIndex)
			yield { total: context.total, pageNumber: pageIndex + 1, base64 }
		}
	} finally {
		if (context.doc && typeof context.doc.destroy === 'function') context.doc.destroy()
	}
}

/**
 * Render one specified PDF page without rendering preceding pages.
 * Page numbers are one-based.
 *
 * @param {Buffer|Uint8Array|ArrayBuffer} pdfBuffer
 * @param {number} pageNumber
 * @param {{ maxPages?: number, scale?: number }} opts
 * @returns {Promise<{ total: number, pageNumber: number, base64: string }>}
 */
async function renderPdfPageToPngBase64(pdfBuffer, pageNumber, opts = {}) {
	const normalizedPageNumber = Number(pageNumber)
	const context = await openPdfForRendering(pdfBuffer, opts)

	try {
		if (!Number.isInteger(normalizedPageNumber)
			|| normalizedPageNumber < 1
			|| normalizedPageNumber > context.total) {
			throw pageOutOfRangeError(normalizedPageNumber, context.total)
		}

		return {
			total: context.total,
			pageNumber: normalizedPageNumber,
			base64: renderOpenDocumentPage(context, normalizedPageNumber - 1),
		}
	} finally {
		if (context.doc && typeof context.doc.destroy === 'function') context.doc.destroy()
	}
}

/**
 * Render PDF pages into PNG base64 strings for scanned-PDF OCR fallback.
 *
 * @param {Buffer|Uint8Array|ArrayBuffer} pdfBuffer
 * @param {{ maxPages?: number, scale?: number }} opts
 * @returns {Promise<{ total: number, images: string[] }>}
 */
async function renderPdfToPngBase64(pdfBuffer, opts = {}) {
	const images = []
	let total = 0

	for await (const page of iteratePdfPagesToPngBase64(pdfBuffer, opts)) {
		total = page.total
		images.push(page.base64)
	}

	return { total, images }
}

module.exports = {
	extractPdfStructuredText,
	iteratePdfPagesToPngBase64,
	renderPdfPageToPngBase64,
	renderPdfToPngBase64,
}
