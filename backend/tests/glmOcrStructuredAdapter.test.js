'use strict'

const { after, before, test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const https = require('node:https')
const path = require('node:path')
const Ajv2020 = require('ajv/dist/2020')
const sharp = require('sharp')

const originalHttpsRequest = https.request
let realHttpsRequestCalls = 0
https.request = () => {
	realHttpsRequestCalls += 1
	throw new Error('real HTTPS is forbidden in OCR structured adapter tests')
}

after(() => {
	https.request = originalHttpsRequest
	assert.equal(realHttpsRequestCalls, 0)
})

const { createOcrStructuredV1Adapter } = require('../glmOcrStructuredAdapter')
const { createGlmOcrClient } = require('../glmOcrClient')
const { parseJpegSofDimensions } = require('../backend/utils/jpegSofDimensions')

const WIDTH = 30
const HEIGHT = 20
let jpegDataUri
let jpegBytes
let whiteBaselineDataUri
let whiteProgressiveDataUri
let blackDataUri
let warningOnlyCorruptBytes
let warningOnlyCorruptDataUri

const validateOcrSchema = new Ajv2020({ strict: true }).compile(JSON.parse(fs.readFileSync(
	path.resolve(__dirname, '../../docs/contracts/ocr-structured-v1.schema.json'), 'utf8'
)))

before(async () => {
	jpegBytes = await sharp({
		create: { width: WIDTH, height: HEIGHT, channels: 3, background: '#f7f7f7' },
	}).jpeg({ quality: 92, progressive: false }).toBuffer()
	jpegDataUri = `data:image/jpeg;base64,${jpegBytes.toString('base64')}`
	const whiteBaseline = await sharp({
		create: { width: WIDTH, height: HEIGHT, channels: 3, background: '#ffffff' },
	}).jpeg({ quality: 92, progressive: false }).toBuffer()
	const whiteProgressive = await sharp({
		create: { width: WIDTH, height: HEIGHT, channels: 3, background: '#ffffff' },
	}).jpeg({ quality: 92, progressive: true }).toBuffer()
	const black = await sharp({
		create: { width: WIDTH, height: HEIGHT, channels: 3, background: '#000000' },
	}).jpeg({ quality: 92, progressive: false }).toBuffer()
	whiteBaselineDataUri = `data:image/jpeg;base64,${whiteBaseline.toString('base64')}`
	whiteProgressiveDataUri = `data:image/jpeg;base64,${whiteProgressive.toString('base64')}`
	blackDataUri = `data:image/jpeg;base64,${black.toString('base64')}`
	const sos = whiteBaseline.indexOf(Buffer.from([0xff, 0xda]))
	assert.notEqual(sos, -1)
	const entropyStart = sos + 2 + whiteBaseline.readUInt16BE(sos + 2)
	const eoi = whiteBaseline.lastIndexOf(Buffer.from([0xff, 0xd9]))
	assert.ok(entropyStart + 1 < eoi)
	warningOnlyCorruptBytes = Buffer.concat([
		whiteBaseline.subarray(0, entropyStart),
		whiteBaseline.subarray(entropyStart + 1),
	])
	assert.deepEqual(parseJpegSofDimensions(warningOnlyCorruptBytes),
		{ frameType: 'SOF0', width: WIDTH, height: HEIGHT, pixels: WIDTH * HEIGHT })
	warningOnlyCorruptDataUri = `data:image/jpeg;base64,${warningOnlyCorruptBytes.toString('base64')}`
})

function batch(overrides = {}) {
	return {
		expectedPageCount: 1,
		render: { engine: 'sharp', dpi: 200, format: 'jpeg', quality: 92 },
		pages: [{
			pageNumber: 1,
			jpegDataUri,
			renderedWidth: WIDTH,
			renderedHeight: HEIGHT,
		}],
		...overrides,
	}
}

function region(index, label, content, bbox = [0.1, 0.1, 0.9, 0.4], dimensions = {}) {
	return {
		index,
		label,
		bbox_2d: bbox,
		content,
		height: dimensions.height ?? HEIGHT,
		width: dimensions.width ?? WIDTH,
	}
}

function envelope(regions = [region(1, 'text', '正文')], dimensions = {}) {
	const width = dimensions.width ?? WIDTH
	const height = dimensions.height ?? HEIGHT
	return {
		schemaVersion: 'glm-ocr-client-v1',
		provider: 'zhipu-layout-parsing',
		model: 'glm-ocr',
		pages: [{
			pageNumber: 1,
			layoutDetails: [regions],
			dataInfo: { num_pages: 1, pages: [{ width, height }] },
		}],
	}
}

function batchWithPageCount(pageCount, dataUris = Array.from({ length: pageCount }, () => jpegDataUri)) {
	return {
		expectedPageCount: pageCount,
		render: { engine: 'sharp', dpi: 200, format: 'jpeg', quality: 92 },
		pages: Array.from({ length: pageCount }, (_, index) => ({
			pageNumber: index + 1,
			jpegDataUri: dataUris[index],
			renderedWidth: WIDTH,
			renderedHeight: HEIGHT,
		})),
	}
}

function envelopeWithPages(regionPages) {
	return {
		schemaVersion: 'glm-ocr-client-v1',
		provider: 'zhipu-layout-parsing',
		model: 'glm-ocr',
		pages: regionPages.map((regions, index) => ({
			pageNumber: index + 1,
			layoutDetails: [regions],
			dataInfo: { num_pages: 1, pages: [{ width: WIDTH, height: HEIGHT }] },
		})),
	}
}

function glmProviderEnvelope() {
	return {
		id: 'unit-provider-response',
		created: 1,
		model: 'GLM-OCR',
		layout_details: [[{
			index: 1,
			label: 'text',
			bbox_2d: [0.1, 0.1, 0.9, 0.9],
			content: '真实集成',
			height: HEIGHT,
			width: WIDTH,
		}]],
		data_info: { num_pages: 1, pages: [{ width: WIDTH, height: HEIGHT }] },
	}
}

function client(parsePages) {
	return Object.freeze({ parsePages })
}

function adapterWith(parsePages) {
	return createOcrStructuredV1Adapter({ glmClient: client(parsePages) })
}

function createAdapterWithIsolatedSharp(fakeSharp, parsePages) {
	const adapterPath = require.resolve('../glmOcrStructuredAdapter')
	const sharpPath = require.resolve('sharp')
	const originalAdapterEntry = require.cache[adapterPath]
	const originalSharp = require.cache[sharpPath].exports
	delete require.cache[adapterPath]
	require.cache[sharpPath].exports = fakeSharp
	try {
		const isolated = require('../glmOcrStructuredAdapter')
		return isolated.createOcrStructuredV1Adapter({ glmClient: client(parsePages) })
	} finally {
		require.cache[sharpPath].exports = originalSharp
		delete require.cache[adapterPath]
		if (originalAdapterEntry) require.cache[adapterPath] = originalAdapterEntry
	}
}

function controlledSharp() {
	const state = { active: 0, activeMax: 0, destroyCalls: 0, options: [], pipelines: [] }
	function fakeSharp(input, options) {
		assert.equal(Buffer.isBuffer(input), true)
		state.options.push(options)
		let settle
		const pipeline = {
			toColourspace(space) {
				assert.equal(space, 'srgb')
				return this
			},
			raw() { return this },
			toBuffer(optionsValue) {
				assert.deepEqual(optionsValue, { resolveWithObject: true })
				state.active += 1
				state.activeMax = Math.max(state.activeMax, state.active)
				return new Promise((resolve, reject) => {
					let done = false
					settle = (callback, value) => {
						if (done) return
						done = true
						state.active -= 1
						callback(value)
					}
					pipeline.resolve = (value) => settle(resolve, value)
					pipeline.reject = (error) => settle(reject, error)
				})
			},
			destroy() {
				state.destroyCalls += 1
				if (settle) pipeline.reject(new Error('destroyed-sharp-pipeline'))
			},
		}
		state.pipelines.push(pipeline)
		return pipeline
	}
	return { fakeSharp, state }
}

function whiteRawOutput(info = { width: WIDTH, height: HEIGHT, channels: 3 }) {
	return { data: Buffer.alloc(WIDTH * HEIGHT * 3, 255), info }
}

async function waitFor(predicate) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return
		await new Promise((resolve) => setImmediate(resolve))
	}
	assert.fail('timed out waiting for controlled Sharp state')
}

function assertSafe(error, code) {
	assert.equal(error.code, code)
	assert.deepEqual(Object.keys(error), ['code', 'class', 'stage', 'retryable', 'safeMessageKey'])
	assert.equal(Object.isFrozen(error), true)
	assert.doesNotMatch(error.message, /(?:token|request|https?:|正文|Cafe)/i)
	return true
}

function assertDeepFrozen(value, seen = new Set()) {
	if (!value || typeof value !== 'object' || seen.has(value)) return
	seen.add(value)
	assert.equal(Object.isFrozen(value), true)
	for (const key of Reflect.ownKeys(value)) assertDeepFrozen(value[key], seen)
}

function strictProviderAbort() {
	const error = new Error('operation-aborted')
	Object.defineProperty(error, 'name', { value: 'AbortError', enumerable: false })
	Object.defineProperty(error, 'stack', {
		value: 'AbortError: operation-aborted', enumerable: false, writable: false, configurable: false,
	})
	Object.defineProperty(error, 'code', { value: 'ABORT_ERR', enumerable: true })
	return Object.freeze(error)
}

test('normalizes text/formula lines, NFC, UTF-16 spans, geometry, metadata and canonical hash', async () => {
	const calls = []
	const raw = envelope([
		region(1, 'text', 'Cafe\u0301\r\n\ud83d\ude00\u91d1\u989d', [0.1, 0.2, 0.5, 0.6]),
		region(2, 'formula', 'x=1', [0.1, 0.65, 0.8, 0.9]),
	])
	const adapter = adapterWith(async (...args) => {
		calls.push(args)
		return raw
	})

	const result = await adapter.parseRenderedBatch(batch())

	assert.equal(calls.length, 1)
	assert.deepEqual(calls[0], [[{ pageNumber: 1, jpegDataUri }], undefined])
	assert.deepEqual(Object.keys(result), ['evidence', 'canonicalJson', 'canonicalSha256'])
	assert.equal(result.evidence.version, 'ocr-structured-v1')
	assert.equal(result.evidence.sourceMode, 'ocr-structured')
	assert.equal(result.evidence.provider, 'zhipu-layout-parsing')
	assert.equal(result.evidence.model, 'glm-ocr')
	assert.equal(result.evidence.complete, true)
	assert.equal(result.evidence.expectedPageCount, 1)
	assert.deepEqual(result.evidence.metadata.render,
		{ engine: 'sharp', dpi: 200, format: 'jpeg', quality: 92 })
	assert.deepEqual(result.evidence.pages[0].bounds, [0, 0, WIDTH, HEIGHT])
	assert.equal(result.evidence.pages[0].verifiedBlank, false)
	assert.equal(result.evidence.pages[0].text, 'Caf\u00e9\n\ud83d\ude00\u91d1\u989d\nx=1')
	assert.deepEqual(result.evidence.pages[0].blocks.map((block) => ({
		text: block.text,
		charStart: block.charStart,
		charEnd: block.charEnd,
		bbox: block.bbox,
		regionLabel: block.regionLabel,
		recordMembership: block.recordMembership,
		sourceBlockOrdinal: block.sourceBlockOrdinal,
		sourceLineOrdinal: block.sourceLineOrdinal,
		sourceLineCount: block.sourceLineCount,
	})), [
		{ text: 'Caf\u00e9', charStart: 0, charEnd: 4, bbox: [3, 4, 15, 12], regionLabel: 'paragraph', recordMembership: 'non-record', sourceBlockOrdinal: 1, sourceLineOrdinal: 1, sourceLineCount: 2 },
		{ text: '\ud83d\ude00\u91d1\u989d', charStart: 5, charEnd: 9, bbox: [3, 4, 15, 12], regionLabel: 'paragraph', recordMembership: 'non-record', sourceBlockOrdinal: 1, sourceLineOrdinal: 2, sourceLineCount: 2 },
		{ text: 'x=1', charStart: 10, charEnd: 13, bbox: [3, 13, 24, 18], regionLabel: 'formula', recordMembership: 'non-record', sourceBlockOrdinal: 2, sourceLineOrdinal: 1, sourceLineCount: 1 },
	])
	assert.equal(result.canonicalJson, JSON.stringify(JSON.parse(result.canonicalJson)))
	assert.equal(result.canonicalSha256,
		crypto.createHash('sha256').update(Buffer.from(result.canonicalJson, 'utf8')).digest('hex'))
	assert.match(result.canonicalSha256, /^[0-9a-f]{64}$/)
	assert.doesNotMatch(result.canonicalJson, /(?:request[_-]?id|task[_-]?id|created)/i)
	assert.doesNotMatch(result.canonicalJson, /(?:data:image|jpegDataUri|renderedWidth|renderedHeight)/)
	assertDeepFrozen(result)
})

test('verifies exact-white SOF0 and SOF2 zero-region pages as schema-valid blank evidence', async () => {
	for (const dataUri of [whiteBaselineDataUri, whiteProgressiveDataUri]) {
		const input = batch()
		input.pages[0].jpegDataUri = dataUri
		const result = await adapterWith(async () => envelope([])).parseRenderedBatch(input)
		assert.deepEqual(result.evidence.pages[0], {
			pageNumber: 1,
			bounds: [0, 0, WIDTH, HEIGHT],
			verifiedBlank: true,
			text: '',
			blocks: [],
		})
		assert.equal(validateOcrSchema(result.evidence), true, JSON.stringify(validateOcrSchema.errors))
		assert.equal(result.canonicalSha256,
			crypto.createHash('sha256').update(Buffer.from(result.canonicalJson, 'utf8')).digest('hex'))
		assert.doesNotMatch(result.canonicalJson,
			/(?:data:image|jpegDataUri|jpegBytes|pixelBytes|renderedWidth|renderedHeight)/i)
		assertDeepFrozen(result)
	}
})

test('rejects black and non-white zero-region pages as coverage mismatches', async () => {
	for (const dataUri of [blackDataUri, jpegDataUri]) {
		const input = batch()
		input.pages[0].jpegDataUri = dataUri
		await assert.rejects(
			adapterWith(async () => envelope([])).parseRenderedBatch(input),
			(error) => assertSafe(error, 'GLM_OCR_PAGE_COVERAGE_MISMATCH')
		)
	}
})

test('rejects a structurally accepted warning-only corrupt white JPEG', async () => {
	await sharp(warningOnlyCorruptBytes, { failOn: 'error' }).raw().toBuffer()
	await assert.rejects(sharp(warningOnlyCorruptBytes, { failOn: 'warning' }).raw().toBuffer())
	const input = batch()
	input.pages[0].jpegDataUri = warningOnlyCorruptDataUri
	await assert.rejects(
		adapterWith(async () => envelope([])).parseRenderedBatch(input),
		(error) => assertSafe(error, 'GLM_OCR_PAGE_COVERAGE_MISMATCH')
	)
})

test('keeps multiple verified blank pages in provider order with canonical frozen output', async () => {
	const result = await adapterWith(async () => envelopeWithPages([[], []])).parseRenderedBatch(
		batchWithPageCount(2, [whiteBaselineDataUri, whiteProgressiveDataUri])
	)
	assert.deepEqual(result.evidence.pages.map((page) => page.pageNumber), [1, 2])
	assert.deepEqual(result.evidence.pages.map((page) => page.verifiedBlank), [true, true])
	assert.deepEqual(result.evidence.pages.map((page) => page.blocks), [[], []])
	assert.equal(validateOcrSchema(result.evidence), true, JSON.stringify(validateOcrSchema.errors))
	assert.equal(result.canonicalJson, JSON.stringify(JSON.parse(result.canonicalJson)))
	assertDeepFrozen(result)
})

test('maps Sharp blank decoding failures to the closed coverage error', async () => {
	const originalToBuffer = sharp.prototype.toBuffer
	sharp.prototype.toBuffer = function rejectBlankDecode() {
		return Promise.reject(new Error('synthetic-sharp-failure'))
	}
	try {
		const input = batch()
		input.pages[0].jpegDataUri = whiteBaselineDataUri
		await assert.rejects(
			adapterWith(async () => envelope([])).parseRenderedBatch(input),
			(error) => assertSafe(error, 'GLM_OCR_PAGE_COVERAGE_MISMATCH')
		)
	} finally {
		sharp.prototype.toBuffer = originalToBuffer
	}
})

test('destroys an active blank pipeline on abort and removes the listener after success', async () => {
	const active = controlledSharp()
	const activeAdapter = createAdapterWithIsolatedSharp(active.fakeSharp, async () => envelope([]))
	const activeController = new AbortController()
	const activeInput = batch()
	activeInput.pages[0].jpegDataUri = whiteBaselineDataUri
	const aborted = activeAdapter.parseRenderedBatch(activeInput, { signal: activeController.signal })
	await waitFor(() => active.state.pipelines[0]?.resolve)
	activeController.abort()
	await assert.rejects(aborted, (error) => {
		assert.equal(error.name, 'AbortError')
		assert.equal(error.code, 'ABORT_ERR')
		assert.deepEqual(Object.keys(error), ['code'])
		return true
	})
	assert.equal(active.state.destroyCalls, 1)
	assert.equal(active.state.active, 0)

	const completed = controlledSharp()
	const completedAdapter = createAdapterWithIsolatedSharp(completed.fakeSharp, async () => envelope([]))
	const completedController = new AbortController()
	const completedInput = batch()
	completedInput.pages[0].jpegDataUri = whiteBaselineDataUri
	const resultPending = completedAdapter.parseRenderedBatch(completedInput,
		{ signal: completedController.signal })
	await waitFor(() => completed.state.pipelines[0]?.resolve)
	completed.state.pipelines[0].resolve(whiteRawOutput())
	const result = await resultPending
	assert.equal(result.evidence.pages[0].verifiedBlank, true)
	completedController.abort()
	await new Promise((resolve) => setImmediate(resolve))
	assert.equal(completed.state.destroyCalls, 0)
	assert.deepEqual(completed.state.options[0], {
		limitInputPixels: 25_000_000,
		limitInputChannels: 3,
		unlimited: false,
		sequentialRead: true,
		failOn: 'warning',
	})
})

test('decodes blank pages sequentially and observes abort before the next page', async () => {
	const sequential = controlledSharp()
	const sequentialAdapter = createAdapterWithIsolatedSharp(sequential.fakeSharp,
		async () => envelopeWithPages([[], []]))
	const sequentialPending = sequentialAdapter.parseRenderedBatch(
		batchWithPageCount(2, [whiteBaselineDataUri, whiteProgressiveDataUri])
	)
	await waitFor(() => sequential.state.pipelines[0]?.resolve)
	assert.equal(sequential.state.pipelines.length, 1)
	sequential.state.pipelines[0].resolve(whiteRawOutput())
	await waitFor(() => sequential.state.pipelines[1]?.resolve)
	assert.equal(sequential.state.activeMax, 1)
	sequential.state.pipelines[1].resolve(whiteRawOutput())
	const sequentialResult = await sequentialPending
	assert.deepEqual(sequentialResult.evidence.pages.map((page) => page.pageNumber), [1, 2])

	const beforeNext = controlledSharp()
	const controller = new AbortController()
	const beforeNextAdapter = createAdapterWithIsolatedSharp(beforeNext.fakeSharp,
		async () => envelopeWithPages([[], []]))
	const beforeNextPending = beforeNextAdapter.parseRenderedBatch(
		batchWithPageCount(2, [whiteBaselineDataUri, whiteProgressiveDataUri]),
		{ signal: controller.signal }
	)
	await waitFor(() => beforeNext.state.pipelines[0]?.resolve)
	const info = { height: HEIGHT, channels: 3 }
	Object.defineProperty(info, 'width', {
		enumerable: true,
		get() {
			controller.abort()
			return WIDTH
		},
	})
	beforeNext.state.pipelines[0].resolve(whiteRawOutput(info))
	await assert.rejects(beforeNextPending, (error) => {
		assert.equal(error.name, 'AbortError')
		assert.equal(error.code, 'ABORT_ERR')
		return true
	})
	assert.equal(beforeNext.state.pipelines.length, 1)
	assert.equal(beforeNext.state.destroyCalls, 0)
})

test('snapshots hostile input synchronously and invokes the client zero times', async () => {
	let calls = 0
	const adapter = adapterWith(async () => {
		calls += 1
		return envelope()
	})

	assert.throws(() => adapter.parseRenderedBatch(new Proxy(batch(), {})),
		(error) => assertSafe(error, 'GLM_OCR_BAD_REQUEST'))
	assert.throws(() => adapter.parseRenderedBatch({ ...batch(), extra: true }),
		(error) => assertSafe(error, 'GLM_OCR_BAD_REQUEST'))
	const getterBatch = batch()
	Object.defineProperty(getterBatch, 'render', { enumerable: true, get() { throw new Error('getter-ran') } })
	assert.throws(() => adapter.parseRenderedBatch(getterBatch),
		(error) => assertSafe(error, 'GLM_OCR_BAD_REQUEST'))
	const sparse = batch()
	sparse.pages = new Array(1)
	assert.throws(() => adapter.parseRenderedBatch(sparse),
		(error) => assertSafe(error, 'GLM_OCR_BAD_REQUEST'))
	const proxyRender = batch()
	proxyRender.render = new Proxy(proxyRender.render, {})
	assert.throws(() => adapter.parseRenderedBatch(proxyRender),
		(error) => assertSafe(error, 'GLM_OCR_BAD_REQUEST'))
	const getterPage = batch()
	Object.defineProperty(getterPage.pages[0], 'renderedWidth', {
		enumerable: true, get() { throw new Error('nested-getter-ran') },
	})
	assert.throws(() => adapter.parseRenderedBatch(getterPage),
		(error) => assertSafe(error, 'GLM_OCR_BAD_REQUEST'))
	const symbolPage = batch()
	symbolPage.pages[0][Symbol('hostile')] = true
	assert.throws(() => adapter.parseRenderedBatch(symbolPage),
		(error) => assertSafe(error, 'GLM_OCR_BAD_REQUEST'))
	assert.throws(() => adapter.parseRenderedBatch(batch(), { extra: true }),
		(error) => assertSafe(error, 'GLM_OCR_BAD_REQUEST'))
	const controller = new AbortController()
	assert.throws(() => adapter.parseRenderedBatch(batch(), { signal: new Proxy(controller.signal, {}) }),
		(error) => assertSafe(error, 'GLM_OCR_BAD_REQUEST'))
	assert.equal(calls, 0)
})

test('locks the captured parsePages function and never exposes the mutable client as receiver', async () => {
	let originalCalls = 0
	let replacementCalls = 0
	let observedThis = 'not-called'
	const glmClient = {
		parsePages: function parsePages() {
			originalCalls += 1
			observedThis = this
			return Promise.resolve(envelope())
		},
	}
	const adapter = createOcrStructuredV1Adapter({ glmClient })
	glmClient.parsePages = async () => {
		replacementCalls += 1
		return envelope()
	}
	await adapter.parseRenderedBatch(batch())
	assert.equal(originalCalls, 1)
	assert.equal(replacementCalls, 0)
	assert.equal(observedThis, undefined)
})

test('accepts only exact native promises without reading then, constructor or species getters', async () => {
	let thenGetterCalls = 0
	const thenable = {}
	Object.defineProperty(thenable, 'then', {
		enumerable: true,
		get() {
			thenGetterCalls += 1
			throw new Error('then-getter-ran')
		},
	})
	assert.throws(
		() => adapterWith(() => thenable).parseRenderedBatch(batch()),
		(error) => assertSafe(error, 'GLM_OCR_CLIENT_ERROR')
	)
	assert.equal(thenGetterCalls, 0)

	const native = Promise.resolve(envelope())
	Object.defineProperty(native, 'then', {
		enumerable: false,
		get() {
			thenGetterCalls += 1
			throw new Error('native-then-getter-ran')
		},
	})
	const ownThenResult = await adapterWith(() => native).parseRenderedBatch(batch())
	assert.equal(ownThenResult.evidence.pages[0].text, '正文')
	assert.equal(thenGetterCalls, 0)

	let constructorGetterCalls = 0
	const ownConstructor = Promise.resolve(envelope())
	Object.defineProperty(ownConstructor, 'constructor', {
		enumerable: false,
		get() {
			constructorGetterCalls += 1
			throw new Error('constructor-getter-ran')
		},
	})
	assert.throws(
		() => adapterWith(() => ownConstructor).parseRenderedBatch(batch()),
		(error) => assertSafe(error, 'GLM_OCR_CLIENT_ERROR')
	)
	assert.equal(constructorGetterCalls, 0)

	let speciesGetterCalls = 0
	class SpeciesPromise extends Promise {
		static get [Symbol.species]() {
			speciesGetterCalls += 1
			throw new Error('species-getter-ran')
		}
	}
	const subclass = new SpeciesPromise((resolve) => resolve(envelope()))
	assert.throws(
		() => adapterWith(() => subclass).parseRenderedBatch(batch()),
		(error) => assertSafe(error, 'GLM_OCR_CLIENT_ERROR')
	)
	assert.equal(speciesGetterCalls, 0)

	const result = await adapterWith(() => Promise.resolve(envelope())).parseRenderedBatch(batch())
	assert.equal(result.evidence.pages[0].text, '正文')
})

test('accepts a real Phase3 GLM client promise under node:test without real HTTPS', async () => {
	let transportCalls = 0
	const glmClient = createGlmOcrClient({
		__testing: {
			apiKey: 'unit-token',
			transport: async () => {
				transportCalls += 1
				return { status: 200, json: async () => glmProviderEnvelope() }
			},
		},
	})
	const adapter = createOcrStructuredV1Adapter({ glmClient })
	const result = await adapter.parseRenderedBatch(batch())
	assert.equal(transportCalls, 1)
	assert.equal(result.evidence.pages[0].text, '真实集成')
	assert.equal(realHttpsRequestCalls, 0)
})

test('uses the synchronous snapshot even when caller mutates the batch while the client is pending', async () => {
	let resolveProvider
	let received
	const pending = new Promise((resolve) => { resolveProvider = resolve })
	const adapter = adapterWith((pages) => {
		received = pages
		return pending
	})
	const input = batch()
	const promise = adapter.parseRenderedBatch(input)
	input.expectedPageCount = 99
	input.render.engine = 'mupdf'
	input.pages[0].pageNumber = 9
	input.pages[0].renderedWidth = 999
	input.pages[0].jpegDataUri = 'mutated'
	assert.deepEqual(received, [{ pageNumber: 1, jpegDataUri }])
	resolveProvider(envelope())
	const result = await promise
	assert.equal(result.evidence.expectedPageCount, 1)
	assert.deepEqual(result.evidence.metadata.render,
		{ engine: 'sharp', dpi: 200, format: 'jpeg', quality: 92 })
})

test('rejects local/SOF and provider page/region dimension mismatches with the locked taxonomy', async () => {
	let calls = 0
	const adapter = adapterWith(async () => {
		calls += 1
		return envelope()
	})
	const localMismatch = batch()
	localMismatch.pages[0].renderedWidth = WIDTH + 1
	assert.throws(() => adapter.parseRenderedBatch(localMismatch),
		(error) => assertSafe(error, 'GLM_OCR_BAD_REQUEST'))
	assert.equal(calls, 0)

	await assert.rejects(
		adapterWith(async () => envelope(undefined, { width: WIDTH + 1 })).parseRenderedBatch(batch()),
		(error) => assertSafe(error, 'GLM_OCR_PAGE_COVERAGE_MISMATCH')
	)
	await assert.rejects(
		adapterWith(async () => envelope([
			region(1, 'text', '正文', undefined, { width: WIDTH + 1 }),
		])).parseRenderedBatch(batch()),
		(error) => assertSafe(error, 'GLM_OCR_PAGE_COVERAGE_MISMATCH')
	)
})

test('rejects malformed data URIs, noncanonical padding, unsupported SOF and page coverage before client calls', () => {
	let calls = 0
	const adapter = adapterWith(async () => {
		calls += 1
		return envelope()
	})
	for (const data of [
		'data:image/png;base64,/9j/2Q==',
		'data:image/jpeg;base64,/x==',
		'data:image/jpeg;base64,/9j/ 2Q==',
	]) {
		const input = batch()
		input.pages[0].jpegDataUri = data
		assert.throws(() => adapter.parseRenderedBatch(input),
			(error) => assertSafe(error, 'GLM_OCR_BAD_REQUEST'))
	}
	const sof = jpegBytes.indexOf(Buffer.from([0xff, 0xc0]))
	assert.notEqual(sof, -1)
	const unsupported = Buffer.from(jpegBytes)
	unsupported[sof + 1] = 0xc1
	const unsupportedInput = batch()
	unsupportedInput.pages[0].jpegDataUri = `data:image/jpeg;base64,${unsupported.toString('base64')}`
	assert.throws(() => adapter.parseRenderedBatch(unsupportedInput),
		(error) => assertSafe(error, 'GLM_OCR_BAD_REQUEST'))

	assert.throws(() => adapter.parseRenderedBatch({ ...batch(), expectedPageCount: 101 }),
		(error) => assertSafe(error, 'GLM_OCR_INPUT_TOO_LARGE'))
	const wrongLength = batch()
	wrongLength.pages = []
	assert.throws(() => adapter.parseRenderedBatch(wrongLength),
		(error) => assertSafe(error, 'GLM_OCR_BAD_REQUEST'))
	const wrongOrder = batch()
	wrongOrder.pages[0].pageNumber = 2
	assert.throws(() => adapter.parseRenderedBatch(wrongOrder),
		(error) => assertSafe(error, 'GLM_OCR_BAD_REQUEST'))
	assert.equal(calls, 0)
})

test('requires continuous unique indexes, normalized bboxes and supported labels', async () => {
	await assert.rejects(
		adapterWith(async () => envelope([
			region(1, 'text', 'a', [0, 0, 1, 0.4]),
			region(1, 'text', 'b', [0, 0.5, 1, 1]),
		])).parseRenderedBatch(batch()),
		(error) => assertSafe(error, 'GLM_OCR_RESPONSE_INVALID')
	)
	await assert.rejects(
		adapterWith(async () => envelope([region(1, 'text', 'a', [-0.1, 0, 1, 1])]))
			.parseRenderedBatch(batch()),
		(error) => assertSafe(error, 'GLM_OCR_RESPONSE_INVALID')
	)
	await assert.rejects(
		adapterWith(async () => envelope([region(1, 'heading', 'a')])).parseRenderedBatch(batch()),
		(error) => assertSafe(error, 'GLM_OCR_RESPONSE_INVALID')
	)
})

test('rejects hostile provider envelope/page/dataInfo/layout/region shapes and unsafe mixed-case text', async () => {
	const hostile = []
	hostile.push(new Proxy(envelope(), {}))
	const rootExtra = envelope()
	rootExtra.extra = true
	hostile.push(rootExtra)
	const pageSymbol = envelope()
	pageSymbol.pages[0][Symbol('hostile')] = true
	hostile.push(pageSymbol)
	const dataInfoGetter = envelope()
	Object.defineProperty(dataInfoGetter.pages[0].dataInfo, 'pages', {
		enumerable: true, get() { throw new Error('provider-getter-ran') },
	})
	hostile.push(dataInfoGetter)
	const sparseLayouts = envelope()
	sparseLayouts.pages[0].layoutDetails = new Array(1)
	hostile.push(sparseLayouts)
	const proxyLayout = envelope()
	proxyLayout.pages[0].layoutDetails[0] = new Proxy(proxyLayout.pages[0].layoutDetails[0], {})
	hostile.push(proxyLayout)
	const regionExtra = envelope()
	regionExtra.pages[0].layoutDetails[0][0].extra = true
	hostile.push(regionExtra)
	const regionGetter = envelope()
	Object.defineProperty(regionGetter.pages[0].layoutDetails[0][0], 'content', {
		enumerable: true, get() { throw new Error('region-getter-ran') },
	})
	hostile.push(regionGetter)
	hostile.push(envelope([region(1, 'text', 'safe ONCLICK=steal')]))

	for (const raw of hostile) {
		await assert.rejects(
			adapterWith(async () => raw).parseRenderedBatch(batch()),
			(error) => assertSafe(error, 'GLM_OCR_RESPONSE_INVALID')
		)
	}
})

test('rejects missing, extra and out-of-order provider pages as coverage failures', async () => {
	const missing = envelope()
	missing.pages = []
	await assert.rejects(
		adapterWith(async () => missing).parseRenderedBatch(batch()),
		(error) => assertSafe(error, 'GLM_OCR_PAGE_COVERAGE_MISMATCH')
	)
	const extra = envelope()
	extra.pages.push({ ...envelope().pages[0], pageNumber: 2 })
	await assert.rejects(
		adapterWith(async () => extra).parseRenderedBatch(batch()),
		(error) => assertSafe(error, 'GLM_OCR_PAGE_COVERAGE_MISMATCH')
	)
	const wrongNumber = envelope()
	wrongNumber.pages[0].pageNumber = 2
	await assert.rejects(
		adapterWith(async () => wrongNumber).parseRenderedBatch(batch()),
		(error) => assertSafe(error, 'GLM_OCR_PAGE_COVERAGE_MISMATCH')
	)
	const inconsistentDataInfo = envelope()
	inconsistentDataInfo.pages[0].dataInfo.num_pages = 2
	await assert.rejects(
		adapterWith(async () => inconsistentDataInfo).parseRenderedBatch(batch()),
		(error) => assertSafe(error, 'GLM_OCR_PAGE_COVERAGE_MISMATCH')
	)
})

test('normalizes strict HTML and Markdown tables into deterministic logical rows and cells', async () => {
	const html = '<table><thead><tr><th colspan="1">Name</th><th>Amount</th></tr></thead>'
		+ '<tbody><tr><td rowspan="1">Alpha</td><td>10</td></tr>'
		+ '<tr><td>Beta</td><td>20</td></tr></tbody></table>'
	const markdown = '|Status|Note|\r\n|---|---|\r\n|Open|Cafe\u0301|\r\n|\ud83d\ude00|x|'
	const result = await adapterWith(async () => envelope([
		region(1, 'table', html, [0.05, 0.05, 0.95, 0.45]),
		region(2, 'table', markdown, [0.05, 0.55, 0.95, 0.95]),
	])).parseRenderedBatch(batch())
	const page = result.evidence.pages[0]
	assert.equal(page.text, 'Name\tAmount\nAlpha\t10\nBeta\t20\nStatus\tNote\nOpen\tCaf\u00e9\n\ud83d\ude00\tx')
	assert.deepEqual(page.blocks.map((block) => block.regionLabel),
		['header', 'table_row', 'table_row', 'header', 'table_row', 'table_row'])
	assert.deepEqual(page.blocks.map((block) => block.sourceBlockOrdinal), [1, 1, 1, 2, 2, 2])
	assert.deepEqual(page.blocks.map((block) => [block.sourceLineOrdinal, block.sourceLineCount]),
		[[1, 3], [2, 3], [3, 3], [1, 3], [2, 3], [3, 3]])
	assert.deepEqual(page.blocks.filter((block) => block.regionLabel === 'header')
		.map((block) => [block.recordMembership, block.logicalTable]),
		[['non-record', null], ['non-record', null]])
	const rows = page.blocks.filter((block) => block.regionLabel === 'table_row')
	assert.deepEqual(rows.map((block) => [block.logicalTable.tableOrdinal,
		block.logicalTable.rowOrdinal, block.logicalTable.rowCount]),
		[[1, 1, 2], [1, 2, 2], [2, 1, 2], [2, 2, 2]])
	assert.deepEqual(rows[0].logicalTable.cells, [
		{ text: 'Alpha', charStart: 12, charEnd: 17, cellOrdinal: 1, cellCount: 2, columnRole: 'other' },
		{ text: '10', charStart: 18, charEnd: 20, cellOrdinal: 2, cellCount: 2, columnRole: 'other' },
	])
	assert.deepEqual(rows[3].logicalTable.cells, [
		{ text: '\ud83d\ude00', charStart: 51, charEnd: 53, cellOrdinal: 1, cellCount: 2, columnRole: 'other' },
		{ text: 'x', charStart: 54, charEnd: 55, cellOrdinal: 2, cellCount: 2, columnRole: 'other' },
	])
	assert.equal(validateOcrSchema(result.evidence), true, JSON.stringify(validateOcrSchema.errors))
	assert.equal(result.canonicalSha256,
		crypto.createHash('sha256').update(Buffer.from(result.canonicalJson, 'utf8')).digest('hex'))
	assert.doesNotMatch(result.canonicalJson, /(?:<table|<td|rowspan|\|---\||bbox_2d|"label":"table")/i)
	assertDeepFrozen(result)
})

test('classifies unsupported table structure as membership-unproven and unsafe markup as response-invalid', async () => {
	const membershipCases = [
		'a|b',
		'<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody>'
			+ '<tr><td></td><td>x</td></tr></tbody></table>',
		'<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody>'
			+ '<tr><td colspan="2">x</td><td>y</td></tr></tbody></table>',
		'<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody>'
			+ '<tr><td>x</td></tr></tbody></table>',
		'|A|B|\n|---|---|\n|x|',
		'<table><thead><tr><th>Cafe\u0301</th><th>Caf\u00e9</th></tr></thead><tbody>'
			+ '<tr><td>x</td><td>y</td></tr></tbody></table>',
		'|Cafe\u0301|Caf\u00e9|\n|---|---|\n|x|y|',
		'unknown-table-format',
	]
	for (const content of membershipCases) {
		await assert.rejects(
			adapterWith(async () => envelope([region(1, 'table', content)])).parseRenderedBatch(batch()),
			(error) => assertSafe(error, 'OCR_RECORD_MEMBERSHIP_UNPROVEN')
		)
	}
	const unsafeCases = [
		'<table><thead><tr><th>A</th></tr></thead><tbody>'
			+ '<tr><td onclick="x">value</td></tr></tbody></table>',
		'<table><thead><tr><th>A</th></tr></thead><tbody>'
			+ '<tr><td>&amp;</td></tr></tbody></table>',
		'|A|\n|---|\n|[unsafe](https://example.invalid)|',
		'<table><thead><tr><th>A</th></tr></thead><tbody>'
			+ '<tr><td><script>x</script></td></tr></tbody></table>',
		'<table onclick="x"><thead><tr><th>A</th></tr></thead><tbody>'
			+ '<tr><td>x</td></tr></tbody></table>',
		'<script><table><thead><tr><th>A</th></tr></thead><tbody>'
			+ '<tr><td>x</td></tr></tbody></table></script>',
		'<?xml?><table><thead><tr><th>A</th></tr></thead><tbody>'
			+ '<tr><td>x</td></tr></tbody></table>',
		'<table><thead><tr class="x"><th>A</th></tr></thead><tbody>'
			+ '<tr><td>x</td></tr></tbody></table>',
		'<table><thead><tr><th>A</th></tr></thead><tbody>'
			+ '<tr><td rowspan="2" class="x">x</td></tr></tbody></table>',
		'<table><thead><tr><th>A</th></tr></thead><tbody>'
			+ '<tr><td>&copy</td></tr></tbody></table>',
		'<table><thead><tr><th>A</th></tr></thead><tbody>'
			+ '<tr><td>&copy;</td></tr></tbody></table>',
		'|A|\n|---|\n|[x][id]|',
		'|A|\n|---|\n|partial <a|',
	]
	for (const content of unsafeCases) {
		await assert.rejects(
			adapterWith(async () => envelope([region(1, 'table', content)])).parseRenderedBatch(batch()),
			(error) => assertSafe(error, 'GLM_OCR_RESPONSE_INVALID')
		)
	}
})

test('rejects bounded 4K and near-200K late active-markup mutants without fallback', async () => {
	const fourK = `|A|\n|---|\n|${'x'.repeat(4096)}[x][id]|`
	const nearLimit = `${'x'.repeat(199900)}<?xml?>`
	for (const content of [fourK, nearLimit]) {
		await assert.rejects(
			adapterWith(async () => envelope([region(1, 'table', content)])).parseRenderedBatch(batch()),
			(error) => assertSafe(error, 'GLM_OCR_RESPONSE_INVALID')
		)
	}
})

test('rejects table cell and emitted-block limit plus one before materializing evidence', async () => {
	const tooManyCells = `|${Array.from({ length: 257 }, (_, index) => `H${index}`).join('|')}|\n`
		+ `|${Array.from({ length: 257 }, () => '---').join('|')}|\n`
		+ `|${Array.from({ length: 257 }, () => 'x').join('|')}|`
	await assert.rejects(
		adapterWith(async () => envelope([region(1, 'table', tooManyCells)])).parseRenderedBatch(batch()),
		(error) => assertSafe(error, 'GLM_OCR_RESPONSE_INVALID')
	)
	const tooManyRows = `|H|\n|---|\n${Array.from({ length: 5000 }, () => '|x|').join('\n')}`
	await assert.rejects(
		adapterWith(async () => envelope([region(1, 'table', tooManyRows)])).parseRenderedBatch(batch()),
		(error) => assertSafe(error, 'GLM_OCR_RESPONSE_INVALID')
	)
})

test('fails closed for unsupported table syntax, image-only, empty text and contradictory provider reading order', async () => {
	await assert.rejects(
		adapterWith(async () => envelope([region(1, 'table', 'a|b')])).parseRenderedBatch(batch()),
		(error) => assertSafe(error, 'OCR_RECORD_MEMBERSHIP_UNPROVEN')
	)
	await assert.rejects(
		adapterWith(async () => envelope([region(1, 'image', '')])).parseRenderedBatch(batch()),
		(error) => assertSafe(error, 'GLM_OCR_PAGE_COVERAGE_MISMATCH')
	)
	await assert.rejects(
		adapterWith(async () => envelope([
			region(1, 'text', 'visible', [0.1, 0.1, 0.9, 0.4]),
			region(2, 'image', 'opaque-provider-payload', [0.1, 0.6, 0.9, 0.9]),
		])).parseRenderedBatch(batch()),
		(error) => assertSafe(error, 'GLM_OCR_RESPONSE_INVALID')
	)
	await assert.rejects(
		adapterWith(async () => envelope([region(1, 'text', ' \r\n\t')])).parseRenderedBatch(batch()),
		(error) => assertSafe(error, 'GLM_OCR_PAGE_COVERAGE_MISMATCH')
	)
	await assert.rejects(
		adapterWith(async () => envelope([
			region(1, 'text', 'lower', [0.1, 0.6, 0.9, 0.9]),
			region(2, 'text', 'upper', [0.1, 0.1, 0.9, 0.4]),
		])).parseRenderedBatch(batch()),
		(error) => assertSafe(error, 'OCR_READING_ORDER_CONFLICT')
	)
	await assert.rejects(
		adapterWith(async () => envelope([
			region(1, 'text', 'right', [0.6, 0.1, 0.9, 0.9]),
			region(2, 'text', 'left', [0.1, 0.1, 0.4, 0.9]),
		])).parseRenderedBatch(batch()),
		(error) => assertSafe(error, 'OCR_READING_ORDER_CONFLICT')
	)
})

test('skips exact-empty image regions beside text/formula without leaking provider image data', async () => {
	const result = await adapterWith(async () => envelope([
		region(1, 'text', 'visible', [0.1, 0.05, 0.9, 0.25]),
		region(2, 'formula', 'x=1', [0.1, 0.35, 0.9, 0.55]),
		region(3, 'image', '', [0.1, 0.65, 0.9, 0.95]),
	])).parseRenderedBatch(batch())
	assert.equal(result.evidence.pages[0].text, 'visible\nx=1')
	assert.deepEqual(result.evidence.pages[0].blocks.map((block) => block.sourceBlockOrdinal), [1, 2])
	assert.doesNotMatch(result.canonicalJson, /"regionLabel":"image"|"bbox_2d"|"content"/)
})

test('normalizes raw negative zero bboxes and rejects coordinates above one', async () => {
	const result = await adapterWith(async () => envelope([
		region(1, 'text', 'zero', [-0, -0, 0.5, 0.5]),
	])).parseRenderedBatch(batch())
	assert.deepEqual(result.evidence.pages[0].blocks[0].bbox, [0, 0, 15, 10])
	assert.equal(Object.is(result.evidence.pages[0].blocks[0].bbox[0], -0), false)

	await assert.rejects(
		adapterWith(async () => envelope([region(1, 'text', 'overflow', [0, 0, 1.001, 1])]))
			.parseRenderedBatch(batch()),
		(error) => assertSafe(error, 'GLM_OCR_RESPONSE_INVALID')
	)
})

test('accepts exactly 5000 emitted blocks and rejects before emitting block 5001', async () => {
	const exactContent = Array.from({ length: 5000 }, () => 'x').join('\n')
	const exact = await adapterWith(async () => envelope([
		region(1, 'text', exactContent, [0, 0, 1, 1]),
	])).parseRenderedBatch(batch())
	assert.equal(exact.evidence.pages[0].blocks.length, 5000)
	assert.equal(exact.evidence.pages[0].text.length, 9999)
	assert.equal(exact.evidence.pages[0].blocks[4999].sourceLineOrdinal, 5000)
	assert.equal(exact.evidence.pages[0].blocks[4999].sourceLineCount, 5000)

	const overContent = `${exactContent}\nx`
	await assert.rejects(
		adapterWith(async () => envelope([
			region(1, 'text', overContent, [0, 0, 1, 1]),
		])).parseRenderedBatch(batch()),
		(error) => assertSafe(error, 'GLM_OCR_RESPONSE_INVALID')
	)
})

test('counts synthetic LF spans in the exact 1,000,000 document cap and rejects +1', async () => {
	function halfDocument(lastLength) {
		return [
			region(1, 'text', 'a'.repeat(200000), [0, 0, 1, 0.3]),
			region(2, 'text', 'b'.repeat(200000), [0, 0.35, 1, 0.65]),
			region(3, 'text', 'c'.repeat(lastLength), [0, 0.7, 1, 1]),
		]
	}
	const exact = await adapterWith(async () => envelopeWithPages([
		halfDocument(99998), halfDocument(99998),
	])).parseRenderedBatch(batchWithPageCount(2))
	assert.deepEqual(exact.evidence.pages.map((page) => page.text.length), [500000, 500000])
	assert.equal(exact.evidence.pages.reduce((total, page) => total + page.text.length, 0), 1000000)
	assert.equal(exact.evidence.pages[0].text[200000], '\n')
	assert.equal(exact.evidence.pages[0].text[400001], '\n')

	await assert.rejects(
		adapterWith(async () => envelopeWithPages([
			halfDocument(99998), halfDocument(99999),
		])).parseRenderedBatch(batchWithPageCount(2)),
		(error) => assertSafe(error, 'GLM_OCR_RESPONSE_INVALID')
	)
})

test('rejects provider array permutation instead of sorting it into canonical order', async () => {
	const one = region(1, 'text', 'first', [0.1, 0.1, 0.9, 0.4])
	const two = region(2, 'formula', 'second', [0.1, 0.6, 0.9, 0.9])
	await adapterWith(async () => envelope([one, two])).parseRenderedBatch(batch())
	await assert.rejects(
		adapterWith(async () => envelope([two, one])).parseRenderedBatch(batch()),
		(error) => assertSafe(error, 'GLM_OCR_RESPONSE_INVALID')
	)
})

test('reconstructs trusted provider tuples, maps unknown failures, and preserves AbortError control flow', async () => {
	const trusted = new Error('provider-connection-interrupted')
	Object.defineProperty(trusted, 'name', { value: 'GlmOcrClientError' })
	Object.assign(trusted, {
		code: 'GLM_OCR_NETWORK_ERROR',
		class: 'transport_transient',
		stage: 'ocr-provider',
		retryable: true,
		safeMessageKey: 'provider-connection-interrupted',
	})
	Object.freeze(trusted)
	let rejectTrusted
	const trustedController = new AbortController()
	const trustedPromise = adapterWith(() => new Promise((resolve, reject) => {
		rejectTrusted = reject
	})).parseRenderedBatch(batch(), { signal: trustedController.signal })
	trustedController.abort()
	rejectTrusted(trusted)
	await assert.rejects(
		trustedPromise,
		(error) => assertSafe(error, 'GLM_OCR_NETWORK_ERROR')
	)

	let rejectUnknown
	const unknownController = new AbortController()
	const unknownPromise = adapterWith(() => new Promise((resolve, reject) => {
		rejectUnknown = reject
	})).parseRenderedBatch(batch(), { signal: unknownController.signal })
	unknownController.abort()
	rejectUnknown(new Error('secret-token-value'))
	await assert.rejects(
		unknownPromise,
		(error) => assertSafe(error, 'GLM_OCR_CLIENT_ERROR')
	)

	let rejectSpoof
	const spoofController = new AbortController()
	const spoofPromise = adapterWith(() => new Promise((resolve, reject) => {
		rejectSpoof = reject
	})).parseRenderedBatch(batch(), { signal: spoofController.signal })
	spoofController.abort()
	rejectSpoof(Object.freeze({ name: 'AbortError', code: 'ABORT_ERR' }))
	await assert.rejects(spoofPromise, (error) => assertSafe(error, 'GLM_OCR_CLIENT_ERROR'))

	await assert.rejects(
		adapterWith(async () => { throw strictProviderAbort() }).parseRenderedBatch(batch()),
		(error) => assertSafe(error, 'GLM_OCR_CLIENT_ERROR')
	)

	let rejectAbort
	const activeController = new AbortController()
	const abortPromise = adapterWith(() => new Promise((resolve, reject) => {
		rejectAbort = reject
	})).parseRenderedBatch(batch(), { signal: activeController.signal })
	activeController.abort()
	rejectAbort(strictProviderAbort())
	await assert.rejects(abortPromise, (error) => {
		assert.equal(error.name, 'AbortError')
		assert.equal(error.code, 'ABORT_ERR')
		assert.deepEqual(Object.keys(error), ['code'])
		return true
	})

	const controller = new AbortController()
	controller.abort()
	let calls = 0
	const adapter = adapterWith(async () => {
		calls += 1
		return envelope()
	})
	assert.throws(() => adapter.parseRenderedBatch(batch(), { signal: controller.signal }), (error) => {
		assert.equal(error.name, 'AbortError')
		assert.equal(error.code, 'ABORT_ERR')
		assert.deepEqual(Object.keys(error), ['code'])
		return true
	})
	assert.equal(calls, 0)
})
