'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const sharp = require('sharp')

const {
	extractPdfStructuredText,
	iteratePdfPagesToPngBase64,
	renderPdfPageToPngBase64,
	renderPdfToPngBase64,
} = require('../pdfVision')

async function createPdf(pageWidths) {
	const imported = await import('mupdf')
	const mupdf = imported.default || imported
	const doc = new mupdf.PDFDocument()
	let saved = null

	try {
		for (const width of pageWidths) {
			const page = doc.addPage(
				[0, 0, width, 72],
				0,
				{},
				'q 0.1 0.4 0.8 rg 0 0 72 72 re f Q'
			)
			doc.insertPage(-1, page)
		}
		saved = doc.saveToBuffer()
		return Buffer.from(saved.asUint8Array())
	} finally {
		if (saved && typeof saved.destroy === 'function') saved.destroy()
		doc.destroy()
	}
}

async function createStructuredTextPdf() {
	const imported = await import('mupdf')
	const mupdf = imported.default || imported
	const doc = new mupdf.PDFDocument()
	let font = null
	let saved = null

	try {
		font = new mupdf.Font('Helvetica')
		const fontRef = doc.addSimpleFont(font)
		const resources = { Font: { F1: fontRef } }
		const pages = [
			{
				bounds: [0, 0, 300, 200],
				contents: 'BT /F1 12 Tf 14 TL 20 160 Td (Line one) Tj T* (Line two) Tj ET',
			},
			{
				bounds: [0, 0, 420, 240],
				contents: 'q 0.1 0.4 0.8 rg 0 0 72 72 re f Q',
			},
			{
				bounds: [0, 0, 360, 180],
				contents: 'BT /F1 10 Tf 20 140 Td (Third page) Tj ET',
			},
		]

		for (const pageSpec of pages) {
			const page = doc.addPage(pageSpec.bounds, 0, resources, pageSpec.contents)
			doc.insertPage(-1, page)
		}

		saved = doc.saveToBuffer()
		return Buffer.from(saved.asUint8Array())
	} finally {
		if (saved && typeof saved.destroy === 'function') saved.destroy()
		if (font && typeof font.destroy === 'function') font.destroy()
		doc.destroy()
	}
}

async function pngSize(base64) {
	const metadata = await sharp(Buffer.from(base64, 'base64')).metadata()
	return { width: metadata.width, height: metadata.height }
}

test('page iterator lazily returns every page in order with per-page metadata', async () => {
	const pdf = await createPdf([72, 144, 216])
	const iterator = iteratePdfPagesToPngBase64(pdf, { maxPages: 3, scale: 1 })
	const sizes = []
	const pageNumbers = []

	for await (const page of iterator) {
		assert.equal(page.total, 3)
		assert.match(page.base64, /^[A-Za-z0-9+/]+=*$/)
		pageNumbers.push(page.pageNumber)
		sizes.push(await pngSize(page.base64))
	}

	assert.deepEqual(pageNumbers, [1, 2, 3])
	assert.deepEqual(sizes, [
		{ width: 72, height: 72 },
		{ width: 144, height: 72 },
		{ width: 216, height: 72 },
	])
})

test('structured text extraction preserves real pages, geometry, and page-local offsets', async () => {
	const pdf = await createStructuredTextPdf()
	const result = await extractPdfStructuredText(pdf, { maxPages: 3 })

	assert.equal(result.total, 3)
	assert.deepEqual(result.pages.map((page) => page.pageNumber), [1, 2, 3])
	assert.deepEqual(result.pages.map((page) => page.bounds), [
		[0, 0, 300, 200],
		[0, 0, 420, 240],
		[0, 0, 360, 180],
	])

	const firstPage = result.pages[0]
	assert.equal(firstPage.text, 'Line one\nLine two')
	assert.equal(firstPage.blocks.length, 1)
	assert.equal(firstPage.blocks[0].text, firstPage.text)
	assert.deepEqual(
		firstPage.blocks[0].lines.map(({ text, charStart, charEnd }) => ({ text, charStart, charEnd })),
		[
			{ text: 'Line one', charStart: 0, charEnd: 8 },
			{ text: 'Line two', charStart: 9, charEnd: 17 },
		]
	)
	assert.equal(firstPage.blocks[0].charStart, 0)
	assert.equal(firstPage.blocks[0].charEnd, 17)
	assert.deepEqual(firstPage.blocks[0].bbox.length, 4)
	assert.ok(firstPage.blocks[0].lines.every((line) => line.bbox.length === 4))
	for (const line of firstPage.blocks[0].lines) {
		assert.equal(firstPage.text.slice(line.charStart, line.charEnd), line.text)
	}

	assert.deepEqual(result.pages[1].blocks, [])
	assert.equal(result.pages[1].text, '')
	assert.equal(result.pages[2].text, 'Third page')
	assert.equal(
		result.text,
		'【第1页】\nLine one\nLine two\n\n【第2页】\n\n【第3页】\nThird page'
	)
})

test('structured text extraction enforces the shared page limit', async () => {
	const pdf = await createStructuredTextPdf()

	await assert.rejects(
		extractPdfStructuredText(pdf, { maxPages: 2 }),
		(error) => error.code === 'PDF_PAGE_LIMIT_EXCEEDED'
			&& error.total === 3
			&& error.maxPages === 2
	)
})

test('single-page renderer renders the requested one-based page only', async () => {
	const pdf = await createPdf([72, 144, 216])
	const page = await renderPdfPageToPngBase64(pdf, 2, { maxPages: 3, scale: 1 })

	assert.equal(page.total, 3)
	assert.equal(page.pageNumber, 2)
	assert.deepEqual(await pngSize(page.base64), { width: 144, height: 72 })

	await assert.rejects(
		renderPdfPageToPngBase64(pdf, 4, { maxPages: 3, scale: 1 }),
		(error) => error.code === 'PDF_PAGE_OUT_OF_RANGE'
			&& error.pageNumber === 4
			&& error.total === 3
	)
})

test('compatibility renderer reuses the iterator result contract', async () => {
	const pdf = await createPdf([72, 144])
	const streamed = []
	for await (const page of iteratePdfPagesToPngBase64(pdf, { maxPages: 2, scale: 1 })) {
		streamed.push(page.base64)
	}

	const compatible = await renderPdfToPngBase64(pdf, { maxPages: 2, scale: 1 })
	assert.equal(compatible.total, 2)
	assert.deepEqual(compatible.images, streamed)
})

test('all render APIs reject an oversized PDF before returning any image', async () => {
	const pdf = await createPdf([72, 72, 72])
	const matchesLimitError = (error) => {
		assert.equal(error.code, 'PDF_PAGE_LIMIT_EXCEEDED')
		assert.equal(error.total, 3)
		assert.equal(error.maxPages, 2)
		assert.equal(error.message, 'PDF page count exceeds the configured limit')
		return true
	}

	const iterator = iteratePdfPagesToPngBase64(pdf, { maxPages: 2, scale: 1 })
	await assert.rejects(iterator.next(), matchesLimitError)
	await assert.rejects(
		renderPdfPageToPngBase64(pdf, 1, { maxPages: 2, scale: 1 }),
		matchesLimitError
	)
	await assert.rejects(
		renderPdfToPngBase64(pdf, { maxPages: 2, scale: 1 }),
		matchesLimitError
	)
})
