'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const sharp = require('sharp')
const { parseJpegSofDimensions } = require('../backend/utils/jpegSofDimensions')

const marker = (code) => Buffer.from([0xff, code])
const segment = (code, payload = Buffer.alloc(0)) => {
	const length = payload.length + 2
	return Buffer.concat([marker(code), Buffer.from([length >> 8, length & 0xff]), payload])
}
const quantTable = (id = 0, precision = 0, value = 1) => Buffer.concat([
	Buffer.from([(precision << 4) | id]),
	precision === 0
		? Buffer.alloc(64, value)
		: Buffer.concat(Array.from({ length: 64 }, () => Buffer.from([value >> 8, value & 0xff]))),
])
const dqt = (tables = [quantTable(0), quantTable(1)]) => segment(0xdb, Buffer.concat(tables))
const huffmanTable = (tableClass, id) => Buffer.concat([
	Buffer.from([(tableClass << 4) | id, 1]), Buffer.alloc(15), Buffer.from([0]),
])
const rawHuffmanTable = (tableClass, id, counts, symbols) => Buffer.concat([
	Buffer.from([(tableClass << 4) | id]), Buffer.from(counts), Buffer.from(symbols),
])
const dht = (tables = [
	huffmanTable(0, 0), huffmanTable(1, 0),
	huffmanTable(0, 1), huffmanTable(1, 1),
]) => segment(0xc4, Buffer.concat(tables))
const sof = (code = 0xc0, width = 64, height = 48, components = [
	[1, 0x11, 0], [2, 0x11, 1], [3, 0x11, 1],
]) => segment(code, Buffer.from([
	8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, ...components.flat(),
]))
const sos = (components = [[1, 0], [2, 0x11], [3, 0x11]], params = [0, 63, 0]) => segment(0xda, Buffer.from([
	components.length, ...components.flat(), ...params,
]))
const jpeg = ({ frame = sof(), preFrame = [dqt()], postFrame = [dht()], scans, tail = [] } = {}) => Buffer.concat([
	marker(0xd8), ...preFrame, frame, ...postFrame,
	...(scans || [sos(), Buffer.from([0x11, 0xff, 0x00, 0x22])]),
	marker(0xd9), ...tail,
])

function moveDqtAfterSof(value) {
	const segments = []
	let offset = 2
	while (offset + 4 <= value.length) {
		const start = offset
		assert.equal(value[offset], 0xff)
		const code = value[offset + 1]
		if (code === 0xda) {
			const dqtSegments = segments.filter((item) => item.code === 0xdb)
			const retained = segments.filter((item) => item.code !== 0xdb)
			const frameIndex = retained.findIndex((item) => item.code === 0xc0 || item.code === 0xc2)
			assert.notEqual(frameIndex, -1)
			retained.splice(frameIndex + 1, 0, ...dqtSegments)
			return Buffer.concat([marker(0xd8), ...retained.map((item) => item.bytes), value.subarray(start)])
		}
		const length = value.readUInt16BE(offset + 2)
		offset += length + 2
		segments.push({ code, bytes: value.subarray(start, offset) })
	}
	throw new Error('missing SOS')
}

function assertCode(code) {
	return (error) => {
		assert.equal(error instanceof TypeError, true)
		assert.equal(error.code, code)
		assert.equal(error.message, code)
		assert.equal(Object.isFrozen(error), true)
		return true
	}
}

test('accepts synthetic SOF0 and multi-scan SOF2 with stuffed entropy', () => {
	assert.deepEqual(parseJpegSofDimensions(jpeg()), {
		frameType: 'SOF0', width: 64, height: 48, pixels: 3072,
	})
	const result = parseJpegSofDimensions(jpeg({
		frame: sof(0xc2, 80, 50),
		scans: [
			sos([[1, 0], [2, 0x10], [3, 0x10]], [0, 0, 0]), Buffer.from([0x10, 0xff, 0x00]),
			sos([[1, 0]], [1, 5, 0]), Buffer.from([0x30]),
		],
	}))
	assert.deepEqual(result, { frameType: 'SOF2', width: 80, height: 50, pixels: 4000 })
	assert.equal(Object.isFrozen(result), true)
})

test('accepts real Sharp/MuPDF output and a real JPEG with DQT after SOF', async () => {
	const source = { create: { width: 64, height: 48, channels: 3, background: { r: 255, g: 255, b: 255 } } }
	const baseline = await sharp(source).jpeg({ quality: 92 }).toBuffer()
	const progressive = await sharp(source).jpeg({ quality: 92, progressive: true }).toBuffer()
	assert.equal(parseJpegSofDimensions(baseline).frameType, 'SOF0')
	assert.equal(parseJpegSofDimensions(progressive).frameType, 'SOF2')
	assert.equal(parseJpegSofDimensions(moveDqtAfterSof(baseline)).frameType, 'SOF0')

	const imported = await import('mupdf')
	const mupdf = imported.default || imported
	const doc = new mupdf.PDFDocument()
	let page = null
	let pixmap = null
	try {
		const created = doc.addPage([0, 0, 64, 48], 0, {}, 'q 1 1 1 rg 0 0 64 48 re f Q')
		doc.insertPage(-1, created)
		created.destroy()
		page = doc.loadPage(0)
		pixmap = page.toPixmap([1, 0, 0, 1, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true)
		assert.equal(parseJpegSofDimensions(Buffer.from(pixmap.asJPEG(92))).frameType, 'SOF2')
	} finally {
		if (pixmap) pixmap.destroy()
		if (page) page.destroy()
		doc.destroy()
	}
})

test('hostile buffers and options fail without invoking traps or instance methods', () => {
	const value = jpeg()
	let calls = 0
	const getterOptions = {}
	Object.defineProperty(getterOptions, 'maxPixels', { get() { calls += 1; throw new Error('leak') } })
	assert.throws(() => parseJpegSofDimensions(value, getterOptions), assertCode('JPEG_SOF_INVALID'))
	assert.equal(calls, 0)
	for (const options of [Object.create({ maxPixels: 3072 }), { extra: 1 }, { [Symbol('x')]: 1 }, new Proxy({}, {})]) {
		assert.throws(() => parseJpegSofDimensions(value, options), assertCode('JPEG_SOF_INVALID'))
	}
	assert.throws(() => parseJpegSofDimensions(new Proxy(value, {})), assertCode('JPEG_SOF_INVALID'))
	const methodTrap = Buffer.from(value)
	Object.defineProperty(methodTrap, 'readUInt16BE', { get() { calls += 1; throw new Error('leak') } })
	assert.equal(parseJpegSofDimensions(methodTrap).width, 64)
	assert.equal(calls, 0)
	if (typeof SharedArrayBuffer === 'function') {
		const shared = new SharedArrayBuffer(value.length)
		new Uint8Array(shared).set(value)
		assert.throws(() => parseJpegSofDimensions(Buffer.from(shared)), assertCode('JPEG_SOF_INVALID'))
	}
})

test('rejects unsupported, missing, duplicate, late and malformed frames', () => {
	assert.throws(() => parseJpegSofDimensions(jpeg({ frame: sof(0xc1) })), assertCode('JPEG_SOF_UNSUPPORTED'))
	assert.throws(() => parseJpegSofDimensions(Buffer.concat([marker(0xd8), dqt(), sos(), Buffer.from([1]), marker(0xd9)])), assertCode('JPEG_SOF_INVALID'))
	assert.throws(() => parseJpegSofDimensions(jpeg({ preFrame: [dqt(), sof()] })), assertCode('JPEG_SOF_INVALID'))
	assert.throws(() => parseJpegSofDimensions(jpeg({ scans: [sos(), Buffer.from([1]), sof(0xc2), sos(), Buffer.from([2])] })), assertCode('JPEG_SOF_INVALID'))
	assert.throws(() => parseJpegSofDimensions(jpeg({
		frame: sof(0xc0, 64, 48, [[1, 0x11, 0], [1, 0x11, 1], [3, 0x11, 1]]),
	})), assertCode('JPEG_SOF_INVALID'))
})

test('validates SOF sampling and quantization table definitions/references', () => {
	assert.equal(parseJpegSofDimensions(jpeg({ preFrame: [], postFrame: [dqt(), dht()] })).width, 64)
	assert.equal(parseJpegSofDimensions(jpeg({
		preFrame: [],
		postFrame: [dqt([quantTable(0)]), dht()],
		scans: [
			sos([[1, 0]]), Buffer.from([1]),
			dqt([quantTable(1)]),
			sos([[2, 0x11], [3, 0x11]]), Buffer.from([2]),
		],
	})).width, 64)
	assert.equal(parseJpegSofDimensions(jpeg({
		frame: sof(0xc0, 64, 48, [[1, 0x11, 2], [2, 0x11, 2], [3, 0x11, 2]]),
		preFrame: [dqt([quantTable(2)])],
	})).height, 48)
	assert.throws(() => parseJpegSofDimensions(jpeg({
		preFrame: [dqt([quantTable(0, 1), quantTable(1)])],
	})), assertCode('JPEG_SOF_INVALID'))
	assert.equal(parseJpegSofDimensions(jpeg({
		frame: sof(0xc2, 64, 48, [[1, 0x11, 2], [2, 0x11, 2], [3, 0x11, 2]]),
		preFrame: [dqt([quantTable(2, 1)])],
		scans: [sos([[1, 0], [2, 0x10], [3, 0x10]], [0, 0, 0]), Buffer.from([1])],
	})).frameType, 'SOF2')
	assert.throws(() => parseJpegSofDimensions(jpeg({
		frame: sof(0xc0, 64, 48, [[1, 0x01, 0], [2, 0x11, 1], [3, 0x11, 1]]),
	})), assertCode('JPEG_SOF_INVALID'))
	assert.throws(() => parseJpegSofDimensions(jpeg({
		frame: sof(0xc0, 64, 48, [[1, 0x44, 0], [2, 0x44, 1], [3, 0x11, 1]]),
	})), assertCode('JPEG_SOF_INVALID'))
	assert.throws(() => parseJpegSofDimensions(jpeg({ preFrame: [dqt([quantTable(0)])] })), assertCode('JPEG_SOF_INVALID'))
	assert.throws(() => parseJpegSofDimensions(jpeg({ preFrame: [dqt([quantTable(0, 0, 0), quantTable(1)])] })), assertCode('JPEG_SOF_INVALID'))
	assert.throws(() => parseJpegSofDimensions(jpeg({ preFrame: [dqt([quantTable(4)])] })), assertCode('JPEG_SOF_INVALID'))
})

test('validates DHT tables, SOS selectors, spectral rules and component coverage', () => {
	assert.throws(() => parseJpegSofDimensions(jpeg({ postFrame: [] })), assertCode('JPEG_SOF_INVALID'))
	assert.throws(() => parseJpegSofDimensions(jpeg({ postFrame: [dht([huffmanTable(0, 0), huffmanTable(1, 0)])] })), assertCode('JPEG_SOF_INVALID'))
	assert.throws(() => parseJpegSofDimensions(jpeg({ postFrame: [segment(0xc4, Buffer.from([0, ...Buffer.alloc(16)]))] })), assertCode('JPEG_SOF_INVALID'))
	const oversubscribed = rawHuffmanTable(0, 0, [3, ...Buffer.alloc(15)], [0, 1, 2])
	assert.throws(() => parseJpegSofDimensions(jpeg({ postFrame: [dht([oversubscribed])] })), assertCode('JPEG_SOF_INVALID'))
	const allOnesUnsafe = rawHuffmanTable(0, 0, [2, ...Buffer.alloc(15)], [0, 1])
	assert.throws(() => parseJpegSofDimensions(jpeg({ postFrame: [dht([allOnesUnsafe])] })), assertCode('JPEG_SOF_INVALID'))
	const invalidDcCategory = rawHuffmanTable(0, 0, [1, ...Buffer.alloc(15)], [12])
	assert.throws(() => parseJpegSofDimensions(jpeg({ postFrame: [dht([invalidDcCategory])] })), assertCode('JPEG_SOF_INVALID'))
	const invalidAcSize = rawHuffmanTable(1, 0, [1, ...Buffer.alloc(15)], [0x0b])
	assert.throws(() => parseJpegSofDimensions(jpeg({ postFrame: [dht([invalidAcSize])] })), assertCode('JPEG_SOF_INVALID'))
	const progressiveEob = rawHuffmanTable(1, 0, [1, ...Buffer.alloc(15)], [0x50])
	const contextualTables = dht([
		huffmanTable(0, 0), progressiveEob,
		huffmanTable(0, 1), huffmanTable(1, 1),
	])
	assert.throws(() => parseJpegSofDimensions(jpeg({ postFrame: [contextualTables] })), assertCode('JPEG_SOF_INVALID'))
	assert.equal(parseJpegSofDimensions(jpeg({
		frame: sof(0xc2),
		postFrame: [contextualTables],
		scans: [
			sos([[1, 0], [2, 0x10], [3, 0x10]], [0, 0, 0]), Buffer.from([1]),
			sos([[1, 0]], [1, 5, 0]), Buffer.from([2]),
		],
	})).frameType, 'SOF2')
	const duplicateSymbols = rawHuffmanTable(0, 0, [2, ...Buffer.alloc(15)], [1, 1])
	assert.throws(() => parseJpegSofDimensions(jpeg({ postFrame: [dht([duplicateSymbols])] })), assertCode('JPEG_SOF_INVALID'))
	assert.throws(() => parseJpegSofDimensions(jpeg({ scans: [sos([[1, 0x40], [2, 0x11], [3, 0x11]]), Buffer.from([1])] })), assertCode('JPEG_SOF_INVALID'))
	assert.throws(() => parseJpegSofDimensions(jpeg({ scans: [sos(undefined, [0, 62, 0]), Buffer.from([1])] })), assertCode('JPEG_SOF_INVALID'))
	assert.throws(() => parseJpegSofDimensions(jpeg({ frame: sof(0xc2), scans: [sos([[1, 0], [2, 0x10]], [1, 5, 0]), Buffer.from([1])] })), assertCode('JPEG_SOF_INVALID'))
	assert.throws(() => parseJpegSofDimensions(jpeg({ scans: [sos([[1, 0]]), Buffer.from([1])] })), assertCode('JPEG_SOF_INVALID'))
})

test('baseline scans are unique and progressive coefficient chains are closed', () => {
	assert.throws(() => parseJpegSofDimensions(jpeg({ scans: [
		sos(), Buffer.from([1]), sos([[1, 0]]), Buffer.from([2]),
	] })), assertCode('JPEG_SOF_INVALID'))
	assert.throws(() => parseJpegSofDimensions(jpeg({ frame: sof(0xc2), scans: [
		sos([[1, 0], [2, 0x10], [3, 0x10]], [0, 0, 0x10]), Buffer.from([1]),
	] })), assertCode('JPEG_SOF_INVALID'))
	assert.throws(() => parseJpegSofDimensions(jpeg({ frame: sof(0xc2), scans: [
		sos([[1, 0], [2, 0x10], [3, 0x10]], [0, 0, 0]), Buffer.from([1]),
		sos([[1, 0]], [0, 0, 0]), Buffer.from([2]),
	] })), assertCode('JPEG_SOF_INVALID'))
	assert.throws(() => parseJpegSofDimensions(jpeg({ frame: sof(0xc2), scans: [
		sos([[1, 0], [2, 0x10], [3, 0x10]], [0, 0, 0]), Buffer.from([1]),
		sos([[1, 0]], [1, 5, 0]), Buffer.from([2]),
		sos([[1, 0]], [5, 10, 0]), Buffer.from([3]),
	] })), assertCode('JPEG_SOF_INVALID'))
	assert.throws(() => parseJpegSofDimensions(jpeg({ frame: sof(0xc2), scans: [
		sos([[1, 0], [2, 0x10], [3, 0x10]], [0, 0, 2]), Buffer.from([1]),
		sos([[1, 0]], [0, 0, 0x10]), Buffer.from([2]),
	] })), assertCode('JPEG_SOF_INVALID'))
	assert.throws(() => parseJpegSofDimensions(jpeg({ frame: sof(0xc2), scans: [
		sos([[1, 0]], [1, 5, 0]), Buffer.from([1]),
		sos([[1, 0], [2, 0x10], [3, 0x10]], [0, 0, 0]), Buffer.from([2]),
	] })), assertCode('JPEG_SOF_INVALID'))
})

test('requires entropy bytes and valid DRI restart sequence', () => {
	assert.equal(parseJpegSofDimensions(jpeg({
		scans: [sos(), Buffer.from([1, 0xff, 0x00, 2, 0xff])],
	})).width, 64)
	assert.throws(() => parseJpegSofDimensions(jpeg({
		scans: [sos(), Buffer.from([1, 0xff, 0xff, 0x00, 2])],
	})), assertCode('JPEG_SOF_INVALID'))
	assert.throws(() => parseJpegSofDimensions(jpeg({ scans: [sos()] })), assertCode('JPEG_SOF_INVALID'))
	assert.throws(() => parseJpegSofDimensions(jpeg({ scans: [sos(), Buffer.from([1, 0xff, 0xd0, 2])] })), assertCode('JPEG_SOF_INVALID'))
	const dri = segment(0xdd, Buffer.from([0, 1]))
	assert.equal(parseJpegSofDimensions(jpeg({ postFrame: [dht(), dri], scans: [sos(), Buffer.from([1, 0xff, 0xd0, 2, 0xff, 0xd1, 3])] })).width, 64)
	assert.throws(() => parseJpegSofDimensions(jpeg({ postFrame: [dht(), dri], scans: [
		sos(), Buffer.from([0xff, 0xd0, 1]),
	] })), assertCode('JPEG_SOF_INVALID'))
	assert.throws(() => parseJpegSofDimensions(jpeg({ postFrame: [dht(), dri], scans: [
		sos(), Buffer.from([1, 0xff, 0xd0, 0xff, 0xd1, 2]),
	] })), assertCode('JPEG_SOF_INVALID'))
	assert.throws(() => parseJpegSofDimensions(jpeg({ postFrame: [dht(), dri], scans: [
		sos(), Buffer.from([1, 0xff, 0xd0]),
	] })), assertCode('JPEG_SOF_INVALID'))
	assert.throws(() => parseJpegSofDimensions(jpeg({ postFrame: [dht(), dri], scans: [sos(), Buffer.from([1, 0xff, 0xd1, 2])] })), assertCode('JPEG_SOF_INVALID'))
	assert.throws(() => parseJpegSofDimensions(jpeg({ postFrame: [dht(), segment(0xdd, Buffer.from([1]))] })), assertCode('JPEG_SOF_INVALID'))
})

test('rejects DNL/DAC, malformed scans, missing EOI, trailing and concatenated bytes', () => {
	assert.throws(() => parseJpegSofDimensions(jpeg({ preFrame: [dqt(), segment(0xdc, Buffer.from([0, 48]))] })), assertCode('JPEG_SOF_UNSUPPORTED'))
	assert.throws(() => parseJpegSofDimensions(jpeg({ preFrame: [dqt(), segment(0xcc)] })), assertCode('JPEG_SOF_UNSUPPORTED'))
	assert.throws(() => parseJpegSofDimensions(jpeg({ scans: [Buffer.from([0xff, 0xda, 0, 12, 4])] })), assertCode('JPEG_SOF_INVALID'))
	const valid = jpeg()
	assert.throws(() => parseJpegSofDimensions(valid.subarray(0, valid.length - 2)), assertCode('JPEG_SOF_INVALID'))
	assert.throws(() => parseJpegSofDimensions(Buffer.concat([valid, Buffer.from([0])])), assertCode('JPEG_SOF_INVALID'))
	assert.throws(() => parseJpegSofDimensions(Buffer.concat([valid, valid])), assertCode('JPEG_SOF_INVALID'))
})

function paddingSegments(totalBytes) {
	const parts = []
	let remaining = totalBytes
	while (remaining > 0) {
		let size = Math.min(65_537, remaining)
		if (remaining - size > 0 && remaining - size < 4) size -= 4 - (remaining - size)
		if (size < 4) throw new Error('padding cannot be represented')
		parts.push(segment(0xfe, Buffer.alloc(size - 4)))
		remaining -= size
	}
	return parts
}

test('header and all-marker caps accept exact limits and reject plus one', () => {
	const fixedHeader = 2 + dqt().length + sof().length + dht().length + sos().length
	assert.equal(parseJpegSofDimensions(jpeg({ preFrame: [...paddingSegments(1_048_576 - fixedHeader), dqt()] })).width, 64)
	assert.throws(() => parseJpegSofDimensions(jpeg({ preFrame: [...paddingSegments(1_048_577 - fixedHeader), dqt()] })), assertCode('JPEG_SOF_LIMIT_EXCEEDED'))
	const scans = [sos(), Buffer.from([0x11])]
	assert.equal(parseJpegSofDimensions(jpeg({ preFrame: [dqt(), ...Array.from({ length: 4090 }, () => segment(0xfe))], scans })).height, 48)
	assert.throws(() => parseJpegSofDimensions(jpeg({ preFrame: [dqt(), ...Array.from({ length: 4091 }, () => segment(0xfe))], scans })), assertCode('JPEG_SOF_LIMIT_EXCEEDED'))
})

test('pixel, byte and dimension defaults accept exact limits and reject plus one', () => {
	assert.equal(parseJpegSofDimensions(jpeg({ frame: sof(0xc0, 5000, 5000) })).pixels, 25_000_000)
	assert.throws(() => parseJpegSofDimensions(jpeg({ frame: sof(0xc0, 5001, 5000) })), assertCode('JPEG_SOF_LIMIT_EXCEEDED'))
	assert.equal(parseJpegSofDimensions(jpeg({ frame: sof(0xc0, 20_000, 1) })).width, 20_000)
	assert.throws(() => parseJpegSofDimensions(jpeg({ frame: sof(0xc0, 20_001, 1) })), assertCode('JPEG_SOF_LIMIT_EXCEEDED'))
	const maxBytes = (9 * 1024 * 1024) - 1
	const prefix = Buffer.concat([marker(0xd8), dqt(), sof(), dht(), sos()])
	const exact = Buffer.concat([prefix, Buffer.alloc(maxBytes - prefix.length - 2, 1), marker(0xd9)])
	assert.equal(parseJpegSofDimensions(exact).width, 64)
	const plusOne = Buffer.concat([prefix, Buffer.alloc(maxBytes - prefix.length - 1, 1), marker(0xd9)])
	assert.throws(() => parseJpegSofDimensions(plusOne), assertCode('JPEG_SOF_LIMIT_EXCEEDED'))
})

test('custom limits and option values are fail-closed', () => {
	const value = jpeg()
	assert.equal(parseJpegSofDimensions(value, {
		maxPixels: 3072, maxHeaderBytes: value.length, maxMarkers: 7,
		maxBytes: value.length, maxDimension: 64,
	}).width, 64)
	assert.throws(() => parseJpegSofDimensions(value, { maxPixels: 3071 }), assertCode('JPEG_SOF_LIMIT_EXCEEDED'))
	assert.throws(() => parseJpegSofDimensions(value, { maxBytes: value.length - 1 }), assertCode('JPEG_SOF_LIMIT_EXCEEDED'))
	assert.throws(() => parseJpegSofDimensions(value, { maxDimension: 63 }), assertCode('JPEG_SOF_LIMIT_EXCEEDED'))
	assert.throws(() => parseJpegSofDimensions(value, { maxMarkers: 0 }), assertCode('JPEG_SOF_INVALID'))
	for (const options of [
		{ maxPixels: 25_000_001 },
		{ maxHeaderBytes: 1_048_577 },
		{ maxMarkers: 4097 },
		{ maxBytes: 9 * 1024 * 1024 },
		{ maxDimension: 20_001 },
		{ maxPixels: null },
		{ maxPixels: undefined },
	]) {
		assert.throws(() => parseJpegSofDimensions(value, options), assertCode('JPEG_SOF_INVALID'))
	}
})
