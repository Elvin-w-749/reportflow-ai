'use strict'

const { after, test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const https = require('node:https')
const { inspect } = require('node:util')
const zlib = require('node:zlib')

const originalHttpsRequest = https.request
let realHttpsRequestCalls = 0
https.request = () => {
	realHttpsRequestCalls += 1
	throw new Error('real HTTPS is forbidden in GLM-OCR tests')
}
after(() => {
	https.request = originalHttpsRequest
	assert.equal(realHttpsRequestCalls, 0)
})

const { createGlmOcrClient } = require('../glmOcrClient')
const {
	parseStrictJsonBytes,
	STRICT_JSON_LIMITS,
} = require('../backend/utils/glmOcrStrictJson')

const ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/layout_parsing'
const PAGE_BYTE_CAP = 9 * 1024 * 1024
const PREFIX = 'data:image/jpeg;base64,'
const FAKE_TOKEN = ['unit', 'token'].join('-')

function jpegDataUri(bytes = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9])) {
	return `${PREFIX}${bytes.toString('base64')}`
}

function page(pageNumber, data = jpegDataUri()) {
	return { pageNumber, jpegDataUri: data }
}

function markedPage(pageNumber, marker) {
	return page(
		pageNumber,
		jpegDataUri(Buffer.from([0xff, 0xd8, marker & 0xff, (marker >> 8) & 0xff, 0xff, 0xd9]))
	)
}

function successEnvelope(label = 'text') {
	return {
		id: 'discarded-task-id',
		created: 1727156815,
		model: 'GLM-OCR',
		md_results: 'discarded-markdown',
		layout_details: [[{
			index: 1,
			label,
			bbox_2d: [0.1, 0.1, 0.5, 0.3],
			content: 'candidate-content',
			height: 800,
			width: 600,
		}]],
		layout_visualization: ['discarded-visualization'],
		data_info: {
			num_pages: 1,
			pages: [{ width: 600, height: 800 }],
		},
		usage: {
			prompt_tokens: 1,
			completion_tokens: 2,
			prompt_tokens_details: { cached_tokens: 0 },
			total_tokens: 3,
		},
		request_id: 'discarded-request-id',
	}
}

function jsonResponse(raw = successEnvelope()) {
	return { status: 200, json: async () => raw }
}

function clientWithTransport(transport, clock = null, pageConcurrency = undefined) {
	const testing = { apiKey: FAKE_TOKEN, transport }
	if (clock) testing.clock = clock.hooks || clock
	if (pageConcurrency !== undefined) testing.pageConcurrency = pageConcurrency
	return createGlmOcrClient({ __testing: testing })
}

class FakeClock {
	constructor() {
		this.time = 0
		this.wallTime = Date.UTC(2026, 0, 1, 0, 0, 0)
		this.nextTimerId = 1
		this.timers = new Map()
		this.nowCalls = 0
		this.wallNowCalls = 0
		this.jumpAtNowCall = null
		this.hooks = Object.freeze({
			now: () => {
				this.nowCalls += 1
				if (this.jumpAtNowCall && this.nowCalls >= this.jumpAtNowCall.call) {
					this.time = Math.max(this.time, this.jumpAtNowCall.time)
					this.jumpAtNowCall = null
				}
				return this.time
			},
			wallNow: () => {
				this.wallNowCalls += 1
				return this.wallTime
			},
			setTimeout: (callback, delay) => {
				const id = this.nextTimerId
				this.nextTimerId += 1
				this.timers.set(id, { callback, due: this.time + delay })
				return id
			},
			clearTimeout: (id) => {
				this.timers.delete(id)
			},
		})
	}

	setTime(time) {
		assert.ok(time >= this.time)
		this.time = time
	}

	setWallTime(time) {
		this.wallTime = time
	}

	advance(milliseconds) {
		const target = this.time + milliseconds
		while (true) {
			const due = [...this.timers.entries()]
				.filter(([, timer]) => timer.due <= target)
				.sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0]
			if (!due) break
			this.timers.delete(due[0])
			this.time = due[1].due
			due[1].callback()
		}
		this.time = target
	}

	jumpOnNextChecks(afterCalls, time) {
		this.jumpAtNowCall = { call: this.nowCalls + afterCalls, time }
	}

	get activeTimers() {
		return this.timers.size
	}
}

function createImmediateBackoffClock() {
	let nextId = 1
	const timers = new Map()
	const hooks = Object.freeze({
		now: () => 0,
		wallNow: () => Date.UTC(2026, 0, 1),
		setTimeout: (callback, delay) => {
			const id = nextId
			nextId += 1
			timers.set(id, { callback, delay })
			if (delay <= 30000) {
				queueMicrotask(() => {
					if (!timers.has(id)) return
					timers.delete(id)
					callback()
				})
			}
			return id
		},
		clearTimeout: (id) => timers.delete(id),
	})
	return { hooks, get activeTimers() { return timers.size } }
}

class MockRequest extends EventEmitter {
	constructor() {
		super()
		this.reusedSocket = false
		this.destroyed = false
		this.destroyCalls = 0
		this.endCalls = 0
		this.body = null
	}

	end(body) {
		this.endCalls += 1
		this.body = body
	}

	destroy() {
		this.destroyed = true
		this.destroyCalls += 1
	}
}

class MockSocket extends EventEmitter {
	constructor() {
		super()
		this.destroyed = false
		this.destroyCalls = 0
	}

	destroy() {
		this.destroyed = true
		this.destroyCalls += 1
	}
}

class MockResponse extends EventEmitter {
	constructor(statusCode, rawHeaders) {
		super()
		this.statusCode = statusCode
		this.rawHeaders = rawHeaders
		this.destroyed = false
		this.destroyCalls = 0
		this.complete = false
		this.pauseCalls = 0
		this.resumeCalls = 0
	}

	destroy() {
		this.destroyed = true
		this.destroyCalls += 1
	}

	pause() {
		this.pauseCalls += 1
	}

	resume() {
		this.resumeCalls += 1
	}
}

function jsonRawHeaders(bodyLength, overrides = {}) {
	const headers = [
		'Content-Type', overrides.contentType || 'application/json; charset=utf-8',
	]
	if (overrides.contentLength !== null) {
		headers.push('Content-Length', String(overrides.contentLength === undefined ? bodyLength : overrides.contentLength))
	}
	if (overrides.contentEncoding) headers.push('Content-Encoding', overrides.contentEncoding)
	if (overrides.transferEncoding) headers.push('Transfer-Encoding', overrides.transferEncoding)
	if (overrides.extra) headers.push(...overrides.extra)
	return headers
}

function createHttpsHarness({ decompressorFactory, pageConcurrency } = {}) {
	const clock = new FakeClock()
	let request = null
	const requests = []
	let requestOptions = null
	let responseCallback = null
	let requestFactoryCalls = 0
	const requestFactory = (options, callback) => {
		requestFactoryCalls += 1
		request = new MockRequest()
		requests.push(request)
		requestOptions = options
		responseCallback = callback
		return request
	}
	const testing = { apiKey: FAKE_TOKEN, requestFactory, clock: clock.hooks }
	if (decompressorFactory) testing.decompressorFactory = decompressorFactory
	if (pageConcurrency !== undefined) testing.pageConcurrency = pageConcurrency
	const client = createGlmOcrClient({ __testing: testing })
	return {
		clock,
		client,
		get request() { return request },
		get requests() { return requests },
		get requestOptions() { return requestOptions },
		get requestFactoryCalls() { return requestFactoryCalls },
		freshSocket() {
			const socket = new MockSocket()
			request.emit('socket', socket)
			return socket
		},
		reusedSocket() {
			request.reusedSocket = true
			const socket = new MockSocket()
			request.emit('socket', socket)
			return socket
		},
		respond(response) {
			assert.equal(typeof responseCallback, 'function')
			responseCallback(response)
		},
	}
}

function clientWithRequestFactory(requestFactory, clock = new FakeClock()) {
	return {
		clock,
		client: createGlmOcrClient({
			__testing: { apiKey: FAKE_TOKEN, requestFactory, clock: clock.hooks },
		}),
	}
}

function emitCompleteResponse(response, chunks) {
	for (const chunk of chunks) response.emit('data', chunk)
	response.complete = true
	response.emit('end')
}

async function flushMicrotasks(rounds = 8) {
	for (let index = 0; index < rounds; index += 1) await Promise.resolve()
}

async function flushUntil(predicate, rounds = 200) {
	for (let index = 0; index < rounds; index += 1) {
		if (predicate()) return
		await Promise.resolve()
	}
	assert.fail('condition did not become true within bounded microtasks')
}

function beginMockHttpsResponse({
	body,
	rawHeaders = jsonRawHeaders(body.length),
	status = 200,
	chunks = [body],
	complete = true,
	reused = false,
	signal,
} = {}) {
	const harness = createHttpsHarness()
	const pending = harness.client.parsePages([page(1)], signal ? { signal } : undefined)
	const socket = reused ? harness.reusedSocket() : harness.freshSocket()
	if (!reused) socket.emit('secureConnect')
	const response = new MockResponse(status, rawHeaders)
	harness.respond(response)
	for (const chunk of chunks) response.emit('data', chunk)
	response.complete = complete
	response.emit('end')
	return { harness, pending, response, socket }
}

function assertErrorTuple(error, expected) {
	assert.equal(error.name, 'GlmOcrClientError')
	assert.equal(error.message, expected.publicMessageKey)
	assert.equal(error.code, expected.code)
	assert.equal(error.stage, expected.stage)
	assert.equal(error.class, expected.taskErrorClass)
	assert.equal(error.retryable, expected.retryable)
	assert.equal(error.safeMessageKey, expected.publicMessageKey)
	assert.deepEqual(Object.keys(error), ['code', 'class', 'stage', 'retryable', 'safeMessageKey'])
	assert.deepEqual(
		Reflect.ownKeys(error).sort(),
		['class', 'code', 'message', 'name', 'retryable', 'safeMessageKey', 'stack', 'stage'].sort()
	)
	assert.equal(error.stack, `GlmOcrClientError: ${expected.publicMessageKey}`)
	assert.equal(error.stack.includes('\\'), false)
	assert.equal(error.stack.includes('/'), false)
	for (const forbidden of ['cause', 'reason', 'provider', 'taskErrorClass', 'errorClass', 'terminalStatus', 'publicMessageKey', 'automaticRetrySameJob', 'sameInputNewJobCanRetry']) {
		assert.equal(forbidden in error, false)
	}
	assert.equal(Object.isFrozen(error), true)
	return true
}

function parseStrictDirect(source, checkDeadline = () => {}) {
	return parseStrictJsonBytes(Buffer.from(source), checkDeadline)
}

test('uses only the fixed endpoint, Bearer auth, and exact closed request body', async () => {
	let calls = 0
	const image = jpegDataUri()
	const client = clientWithTransport(async (endpoint, request) => {
		calls += 1
		assert.equal(endpoint, ENDPOINT)
		assert.equal(request.method, 'POST')
		assert.equal(request.redirect, 'error')
		assert.deepEqual(request.headers, {
			authorization: `Bearer ${FAKE_TOKEN}`,
			'content-type': 'application/json',
		})
		assert.deepEqual(JSON.parse(request.body), {
			model: 'glm-ocr',
			file: image,
			return_crop_images: false,
			need_layout_visualization: false,
		})
		assert.equal(request.signal instanceof AbortSignal, true)
		assert.equal(request.signal.aborted, false)
		return jsonResponse()
	})

	const result = await client.parsePages([page(1, image)])
	assert.equal(calls, 1)
	assert.deepEqual(Reflect.ownKeys(result), ['schemaVersion', 'provider', 'model', 'pages'])
	assert.equal(result.schemaVersion, 'glm-ocr-client-v1')
	assert.equal(result.provider, 'zhipu-layout-parsing')
	assert.equal(result.model, 'glm-ocr')
	assert.deepEqual(Reflect.ownKeys(result.pages[0]), ['pageNumber', 'layoutDetails', 'dataInfo'])
})

test('default HTTPS path uses fixed TLS options and streams one strict JSON success', async () => {
	const harness = createHttpsHarness()
	const image = jpegDataUri()
	const pending = harness.client.parsePages([page(1, image)])

	assert.equal(harness.requestFactoryCalls, 1)
	assert.equal(harness.request.endCalls, 1)
	assert.equal(harness.requestOptions.protocol, 'https:')
	assert.equal(harness.requestOptions.hostname, 'open.bigmodel.cn')
	assert.equal(harness.requestOptions.port, 443)
	assert.equal(harness.requestOptions.path, '/api/paas/v4/layout_parsing')
	assert.equal(harness.requestOptions.method, 'POST')
	assert.equal(harness.requestOptions.rejectUnauthorized, true)
	assert.equal(harness.requestOptions.servername, 'open.bigmodel.cn')
	assert.deepEqual(Reflect.ownKeys(harness.requestOptions), [
		'protocol',
		'hostname',
		'port',
		'method',
		'path',
		'rejectUnauthorized',
		'servername',
		'headers',
	])
	assert.equal(Object.isFrozen(harness.requestOptions), true)
	assert.equal(Object.isFrozen(harness.requestOptions.headers), true)
	assert.deepEqual(harness.requestOptions.headers, {
		authorization: `Bearer ${FAKE_TOKEN}`,
		'content-type': 'application/json',
		'content-length': Buffer.byteLength(harness.request.body),
	})
	assert.deepEqual(JSON.parse(harness.request.body), {
		model: 'glm-ocr',
		file: image,
		return_crop_images: false,
		need_layout_visualization: false,
	})

	const socket = harness.freshSocket()
	socket.emit('secureConnect')
	const rawBody = Buffer.from(JSON.stringify(successEnvelope()))
	const response = new MockResponse(200, jsonRawHeaders(rawBody.length))
	harness.respond(response)
	emitCompleteResponse(response, [rawBody.subarray(0, 17), rawBody.subarray(17)])
	const result = await pending

	assert.equal(result.provider, 'zhipu-layout-parsing')
	assert.equal(result.pages[0].layoutDetails[0][0].content, 'candidate-content')
	assert.equal(harness.clock.activeTimers, 0)
	assert.equal(harness.request.destroyed, false)
	assert.equal(response.destroyed, false)
	assert.equal(socket.destroyed, false)
	assert.equal(harness.request.listenerCount('error'), 0)
	assert.equal(response.listenerCount('error'), 0)
	assert.equal(socket.listenerCount('error'), 0)
	assert.equal(realHttpsRequestCalls, 0)
})

test('reused HTTPS socket is immediately connected without waiting for secureConnect', async () => {
	const harness = createHttpsHarness()
	const pending = harness.client.parsePages([page(1)])
	const socket = harness.reusedSocket()
	const rawBody = Buffer.from(JSON.stringify(successEnvelope()))
	const response = new MockResponse(200, jsonRawHeaders(rawBody.length))
	harness.respond(response)
	emitCompleteResponse(response, [rawBody])
	const result = await pending

	assert.equal(result.pages.length, 1)
	assert.equal(harness.clock.activeTimers, 0)
	assert.equal(socket.listenerCount('error'), 0)
	assert.equal(socket.destroyed, false)
})

test('twenty successful requests on one reused socket do not accumulate error listeners', async () => {
	const clock = new FakeClock()
	const socket = new MockSocket()
	let currentRequest = null
	let currentCallback = null
	const requestFactory = (_options, callback) => {
		currentRequest = new MockRequest()
		currentRequest.reusedSocket = true
		currentCallback = callback
		return currentRequest
	}
	const client = createGlmOcrClient({
		__testing: { apiKey: FAKE_TOKEN, requestFactory, clock: clock.hooks },
	})
	for (let iteration = 0; iteration < 20; iteration += 1) {
		const pending = client.parsePages([page(1)])
		currentRequest.emit('socket', socket)
		const body = Buffer.from(JSON.stringify(successEnvelope()))
		const response = new MockResponse(200, jsonRawHeaders(body.length))
		currentCallback(response)
		emitCompleteResponse(response, [body])
		assert.equal((await pending).pages.length, 1)
		assert.equal(socket.listenerCount('error'), 0)
		assert.equal(clock.activeTimers, 0)
	}
	assert.equal(socket.destroyed, false)
})

test('connect timeout trusts only fresh secureConnect and enforces the 15000ms boundary', async () => {
	for (const mode of ['no-socket', 'tcp-only', 'tls-stall']) {
		const harness = createHttpsHarness()
		const pending = harness.client.parsePages([page(1)])
		const sockets = []
		for (let attempt = 0; attempt < 2; attempt += 1) {
			if (mode !== 'no-socket') {
				const socket = harness.freshSocket()
				sockets.push(socket)
				if (mode === 'tcp-only') socket.emit('connect')
			}
			harness.clock.advance(15000)
			if (attempt === 0) {
				await flushMicrotasks()
				harness.clock.advance(1000)
				await flushMicrotasks()
				assert.equal(harness.requestFactoryCalls, 2)
			}
		}
		await assert.rejects(
			pending,
			(error) => error.code === 'GLM_OCR_CONNECT_TIMEOUT'
				&& error.class === 'transport_transient'
				&& error.retryable === true
		)
		assert.equal(harness.clock.activeTimers, 0)
		assert.equal(harness.requestFactoryCalls, 2)
		assert.ok(harness.requests.every((request) => request.destroyed))
		assert.ok(sockets.every((socket) => socket.destroyed))
	}

	const beforeBoundary = createHttpsHarness()
	const beforePending = beforeBoundary.client.parsePages([page(1)])
	const beforeSocket = beforeBoundary.freshSocket()
	beforeBoundary.clock.setTime(14999)
	beforeSocket.emit('secureConnect')
	beforeBoundary.clock.setTime(16000)
	const body = Buffer.from(JSON.stringify(successEnvelope()))
	const beforeResponse = new MockResponse(200, jsonRawHeaders(body.length))
	beforeBoundary.respond(beforeResponse)
	emitCompleteResponse(beforeResponse, [body])
	await beforePending

	const exactBoundary = createHttpsHarness()
	const exactPending = exactBoundary.client.parsePages([page(1)])
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const exactSocket = exactBoundary.freshSocket()
		exactBoundary.clock.setTime(attempt === 0 ? 15000 : 16000 + 15000)
		exactSocket.emit('secureConnect')
		if (attempt === 0) {
			await flushMicrotasks()
			exactBoundary.clock.advance(1000)
			await flushMicrotasks()
		}
	}
	await assert.rejects(exactPending, (error) => error.code === 'GLM_OCR_CONNECT_TIMEOUT')
})

test('page timeout covers slow headers and slow response bodies after secureConnect', async () => {
	const slowHeaders = createHttpsHarness()
	const headersPending = slowHeaders.client.parsePages([page(1)])
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const headersSocket = slowHeaders.freshSocket()
		headersSocket.emit('secureConnect')
		slowHeaders.clock.advance(120000)
		if (attempt === 0) {
			await flushMicrotasks()
			slowHeaders.clock.advance(1000)
			await flushMicrotasks()
		}
	}
	await assert.rejects(headersPending, (error) => error.code === 'GLM_OCR_PAGE_TIMEOUT')
	assert.equal(slowHeaders.clock.activeTimers, 0)

	const slowBody = createHttpsHarness()
	const bodyPending = slowBody.client.parsePages([page(1)])
	const rawBody = Buffer.from(JSON.stringify(successEnvelope()))
	const responses = []
	const bodySockets = []
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const bodySocket = slowBody.freshSocket()
		bodySockets.push(bodySocket)
		bodySocket.emit('secureConnect')
		const response = new MockResponse(200, jsonRawHeaders(rawBody.length))
		responses.push(response)
		slowBody.respond(response)
		response.emit('data', rawBody.subarray(0, 10))
		slowBody.clock.advance(120000)
		if (attempt === 0) {
			await flushMicrotasks()
			slowBody.clock.advance(1000)
			await flushMicrotasks()
		}
	}
	await assert.rejects(bodyPending, (error) => error.code === 'GLM_OCR_PAGE_TIMEOUT')
	assert.ok(responses.every((response) => response.destroyed))
	assert.ok(slowBody.requests.every((request) => request.destroyed))
	assert.ok(bodySockets.every((socket) => socket.destroyed))
	assert.equal(slowBody.clock.activeTimers, 0)
})

test('non-200 HTTPS responses are destroyed without attaching body or decompression readers', async () => {
	for (const [status, code] of [
		[302, 'GLM_OCR_CLIENT_ERROR'],
		[401, 'GLM_OCR_AUTH_FAILED'],
		[429, 'GLM_OCR_RATE_LIMITED'],
		[503, 'GLM_OCR_PROVIDER_UNAVAILABLE'],
	]) {
		const harness = createHttpsHarness()
		const pending = harness.client.parsePages([page(1)])
		const attempts = [429, 503].includes(status) ? 2 : 1
		const responses = []
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			const socket = harness.freshSocket()
			socket.emit('secureConnect')
			const response = new MockResponse(status, [
				'Retry-After', status === 429 ? '0' : '3',
				'Content-Encoding', 'gzip',
				'Content-Length', '9'.repeat(9),
			])
			responses.push(response)
			harness.respond(response)
			assert.equal(response.destroyed, true)
			assert.equal(response.listenerCount('data'), 0)
			assert.equal(response.listenerCount('end'), 0)
			if (attempt === 0 && attempts === 2) {
				await flushMicrotasks()
				if (status !== 429) harness.clock.advance(1000)
				await flushMicrotasks()
			}
		}
		await assert.rejects(pending, (error) => error.code === code)
		assert.equal(harness.requestFactoryCalls, attempts)
		assert.equal(harness.clock.activeTimers, 0)
		for (const response of responses) {
			assert.doesNotThrow(() => response.emit('error', new Error('late-non-200-error')))
		}
	}
})

test('HTTP upgrade or CONNECT protocol switch is rejected immediately without body parsing', async () => {
	for (const event of ['upgrade', 'connect']) {
		const harness = createHttpsHarness()
		const pending = harness.client.parsePages([page(1)])
		const socket = harness.freshSocket()
		socket.emit('secureConnect')
		const response = new MockResponse(event === 'upgrade' ? 101 : 200, [])
		const upgradedSocket = new MockSocket()
		harness.request.emit(event, response, upgradedSocket, Buffer.from('private-upgrade-head'))
		await assert.rejects(
			pending,
			(error) => error.code === 'GLM_OCR_RESPONSE_INVALID'
				&& error.retryable === false
				&& !`${JSON.stringify(error)} ${error.stack}`.includes('private-upgrade-head')
		)
		assert.equal(response.listenerCount('data'), 0)
		assert.equal(response.destroyed, true)
		assert.equal(upgradedSocket.destroyed, true)
		assert.equal(harness.clock.activeTimers, 0)
		assert.doesNotThrow(() => {
			response.emit('error', new Error('late-upgrade-response'))
			upgradedSocket.emit('error', new Error('late-upgrade-socket'))
		})
	}
})

test('strict response headers reject ambiguous content framing and accept controlled chunking', async () => {
	const body = Buffer.from(JSON.stringify(successEnvelope()))
	const invalidHeaders = [
		['Content-Length', String(body.length)],
		['Content-Type', 'text/plain', 'Content-Length', String(body.length)],
		['Content-Type', 'application/json; charset=gbk', 'Content-Length', String(body.length)],
		['Content-Type', 'application/json; charset=utf-8; charset=utf-8', 'Content-Length', String(body.length)],
		['Content-Type', 'application/json; charset=utf-8; version=1', 'Content-Length', String(body.length)],
		['Content-Type', 'application/json', 'Content-Type', 'application/json', 'Content-Length', String(body.length)],
		['Content-Type', 'application/json', 'Content-Length', String(body.length), 'Content-Length', String(body.length)],
		['Content-Type', 'application/json', 'Content-Length', '+1'],
		['Content-Type', 'application/json', 'Content-Length', '-1'],
		['Content-Type', 'application/json', 'Content-Length', '01'],
		['Content-Type', 'application/json', 'Content-Length', '1e2'],
		['Content-Type', 'application/json', 'Content-Length', '1,2'],
		['Content-Type', 'application/json', 'Content-Length', '9'.repeat(17)],
		['Content-Type', 'application/json', 'Content-Length', ` ${body.length}`],
		['Content-Type', 'application/json', 'Content-Length', String(body.length), 'Transfer-Encoding', 'chunked'],
		['Content-Type', 'application/json', 'Transfer-Encoding', 'gzip'],
		['Content-Type', 'application/json', 'Content-Encoding', 'gzip, br', 'Transfer-Encoding', 'chunked'],
		['Content-Type', 'application/json', 'Content-Encoding', 'compress', 'Transfer-Encoding', 'chunked'],
		['Content-Type', 'application/json', 'X-Oversized', 'x'.repeat(8193), 'Transfer-Encoding', 'chunked'],
		[
			'Content-Type', 'application/json',
			...Array.from({ length: 5 }, (_, index) => [`X-Large-${index}`, 'x'.repeat(7000)]).flat(),
			'Transfer-Encoding', 'chunked',
		],
	]
	for (const rawHeaders of invalidHeaders) {
		const run = beginMockHttpsResponse({ body, rawHeaders })
		await assert.rejects(run.pending, (error) => error.code === 'GLM_OCR_RESPONSE_INVALID')
		assert.equal(run.response.destroyed, true)
		assert.equal(run.harness.clock.activeTimers, 0)
	}

	for (const contentType of [
		'application/json',
		'Application/JSON ; charset = UTF-8',
		'application/json;charset="utf-8"',
	]) {
		const run = beginMockHttpsResponse({
			body,
			rawHeaders: [
				'Content-Type', contentType,
				'Transfer-Encoding', 'chunked',
			],
		})
		const result = await run.pending
		assert.equal(result.pages.length, 1)
	}
})

test('Content-Length is an exact encoded hint and never weakens streamed byte limits', async () => {
	const body = Buffer.from(JSON.stringify(successEnvelope()))
	for (const declared of [body.length - 1, body.length + 1]) {
		const run = beginMockHttpsResponse({
			body,
			rawHeaders: jsonRawHeaders(body.length, { contentLength: declared }),
		})
		await assert.rejects(run.pending, (error) => error.code === 'GLM_OCR_RESPONSE_INVALID')
	}

	const noLength = beginMockHttpsResponse({
		body,
		rawHeaders: jsonRawHeaders(body.length, {
			contentLength: null,
			transferEncoding: 'chunked',
		}),
	})
	assert.equal((await noLength.pending).pages.length, 1)

	const preflightHarness = createHttpsHarness()
	const preflightPending = preflightHarness.client.parsePages([page(1)])
	const preflightSocket = preflightHarness.freshSocket()
	preflightSocket.emit('secureConnect')
	const preflightResponse = new MockResponse(200, [
		'Content-Type', 'application/json',
		'Content-Length', String((16 * 1024 * 1024) + 1),
	])
	preflightHarness.respond(preflightResponse)
	assert.equal(preflightResponse.listenerCount('data'), 0)
	assert.equal(preflightResponse.destroyed, true)
	await assert.rejects(preflightPending, (error) => error.code === 'GLM_OCR_RESPONSE_INVALID')

	const overCap = Buffer.alloc((16 * 1024 * 1024) + 1, 0x20)
	const streamedOverCap = beginMockHttpsResponse({
		body: overCap,
		rawHeaders: [
			'Content-Type', 'application/json',
			'Transfer-Encoding', 'chunked',
		],
	})
	await assert.rejects(
		streamedOverCap.pending,
		(error) => error.code === 'GLM_OCR_RESPONSE_INVALID'
	)
	assert.equal(streamedOverCap.response.destroyed, true)
})

test('identity, gzip, deflate, and br enforce independent encoded and decoded caps', async () => {
	const plain = Buffer.from(JSON.stringify(successEnvelope()))
	const encodings = [
		['identity', plain],
		['gzip', zlib.gzipSync(plain)],
		['deflate', zlib.deflateSync(plain)],
		['br', zlib.brotliCompressSync(plain)],
	]
	for (const [encoding, wire] of encodings) {
		const run = beginMockHttpsResponse({
			body: wire,
			rawHeaders: jsonRawHeaders(wire.length, {
				contentEncoding: encoding === 'identity' ? undefined : encoding,
			}),
		})
		const result = await run.pending
		assert.equal(result.model, 'glm-ocr')
		assert.equal(run.harness.clock.activeTimers, 0)
	}
	for (const explicitIdentity of ['identity', ' identity ']) {
		const run = beginMockHttpsResponse({
			body: plain,
			rawHeaders: jsonRawHeaders(plain.length, { contentEncoding: explicitIdentity }),
		})
		assert.equal((await run.pending).pages.length, 1)
	}

	const decodedBomb = Buffer.alloc((16 * 1024 * 1024) + 1, 0x20)
	const compressedBomb = zlib.gzipSync(decodedBomb)
	const bombRun = beginMockHttpsResponse({
		body: compressedBomb,
		rawHeaders: jsonRawHeaders(compressedBomb.length, { contentEncoding: 'gzip' }),
	})
	await assert.rejects(bombRun.pending, (error) => error.code === 'GLM_OCR_RESPONSE_INVALID')
	assert.equal(bombRun.response.destroyed, true)

	const encodedOverCap = Buffer.alloc((16 * 1024 * 1024) + 1, 0x61)
	const encodedRun = beginMockHttpsResponse({
		body: encodedOverCap,
		rawHeaders: [
			'Content-Type', 'application/json',
			'Content-Encoding', 'gzip',
			'Transfer-Encoding', 'chunked',
		],
	})
	await assert.rejects(encodedRun.pending, (error) => error.code === 'GLM_OCR_RESPONSE_INVALID')

	const exactJson = Buffer.from(JSON.stringify(successEnvelope()))
	const exactCap = Buffer.alloc(16 * 1024 * 1024, 0x20)
	exactJson.copy(exactCap)
	const exactRun = beginMockHttpsResponse({ body: exactCap })
	assert.equal((await exactRun.pending).pages.length, 1)
	const exactCompressed = zlib.gzipSync(exactCap)
	const exactDecodedRun = beginMockHttpsResponse({
		body: exactCompressed,
		rawHeaders: jsonRawHeaders(exactCompressed.length, { contentEncoding: 'gzip' }),
	})
	assert.equal((await exactDecodedRun.pending).pages.length, 1)
})

test('bounded collector survives one-byte and zero-byte fragmentation and owns emitted bytes', async () => {
	const fixture = successEnvelope()
	fixture.md_results = 'x'.repeat(100000)
	const body = Buffer.from(`${JSON.stringify(fixture)}${' '.repeat(10000)}`)
	const harness = createHttpsHarness()
	const pending = harness.client.parsePages([page(1)])
	const socket = harness.freshSocket()
	socket.emit('secureConnect')
	const response = new MockResponse(200, jsonRawHeaders(body.length))
	harness.respond(response)
	for (let index = 0; index < body.length; index += 1) {
		response.emit('data', Uint8Array.of(body[index]))
		if (index < 10000) response.emit('data', Buffer.alloc(0))
	}
	response.complete = true
	response.emit('end')
	assert.equal((await pending).pages.length, 1)

	const ownedHarness = createHttpsHarness()
	const ownedPending = ownedHarness.client.parsePages([page(1)])
	const ownedSocket = ownedHarness.freshSocket()
	ownedSocket.emit('secureConnect')
	const ownedResponse = new MockResponse(200, jsonRawHeaders(body.length))
	ownedHarness.respond(ownedResponse)
	const mutable = new Uint8Array(body)
	ownedResponse.emit('data', mutable)
	mutable.fill(0)
	ownedResponse.complete = true
	ownedResponse.emit('end')
	assert.equal((await ownedPending).pages.length, 1)
})

test('strict parser rejects decoded duplicate and prototype keys before schema normalization', async () => {
	const canonical = JSON.stringify(successEnvelope())
	const invalidSources = [
		canonical.replace(
			'"id":"discarded-task-id"',
			'"id":"discarded-task-id","\\u0069d":"second-id"'
		),
		canonical.replace(
			'{',
			'{"\\u005f\\u005fproto\\u005f\\u005f":{},'
		),
		canonical.replace('{', '{"constructor":{},'),
		canonical.replace('{', '{"prototype":{},'),
	]
	for (const source of invalidSources) {
		const run = beginMockHttpsResponse({ body: Buffer.from(source) })
		await assert.rejects(run.pending, (error) => error.code === 'GLM_OCR_RESPONSE_INVALID')
		assert.equal(String((await run.pending.catch((error) => error)).stack).includes('second-id'), false)
	}
})

test('strict UTF-8 and JSON reject BOM, invalid encoding, trailing roots, NUL, surrogates, and nonfinite numbers', async () => {
	const canonical = JSON.stringify(successEnvelope())
	const [beforeId, afterId] = canonical.split('discarded-task-id')
	const embeddedInvalidUtf8 = Buffer.concat([
		Buffer.from(beforeId),
		Buffer.from([0xc3, 0x28]),
		Buffer.from(afterId),
	])
	const invalidBodies = [
		Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(canonical)]),
		Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(canonical)]),
		Buffer.from([0xc3, 0x28]),
		embeddedInvalidUtf8,
		Buffer.from(`${canonical} false`),
		Buffer.from(`${canonical} trailing`),
		Buffer.from(canonical.replace('"discarded-task-id"', '"bad\\u0000id"')),
		Buffer.from(canonical.replace('"discarded-task-id"', '"bad\\ud800"')),
		Buffer.from(canonical.replace('"discarded-task-id"', '"bad\\udfff"')),
		Buffer.from(canonical.replace('1727156815', '1e400')),
		Buffer.from(canonical.replace('1727156815', '01')),
		Buffer.from(canonical.replace('{', '{/*comment*/')),
	]
	for (const body of invalidBodies) {
		const run = beginMockHttpsResponse({ body })
		await assert.rejects(run.pending, (error) => error.code === 'GLM_OCR_RESPONSE_INVALID')
	}
})

test('strict parser enforces depth, nodes, key, object-key, and array-item resource ceilings', async () => {
	const canonicalTail = JSON.stringify(successEnvelope()).slice(1)
	const deep = `${'['.repeat(33)}0${']'.repeat(33)}`
	const longKey = 'k'.repeat(129)
	const manyKeys = Array.from({ length: 65 }, (_, index) => `"k${index}":0`).join(',')
	const tooManyItems = Array.from({ length: 5001 }, () => '0').join(',')
	const nodeRows = Array.from(
		{ length: 41 },
		() => `[${Array.from({ length: 5000 }, () => '0').join(',')}]`
	).join(',')
	const invalidSources = [
		`{"bomb":${deep},${canonicalTail}`,
		`{"${longKey}":0,${canonicalTail}`,
		`{"bomb":{${manyKeys}},${canonicalTail}`,
		`{"bomb":[${tooManyItems}],${canonicalTail}`,
		`{"bomb":[${nodeRows}],${canonicalTail}`,
	]
	for (const source of invalidSources) {
		const run = beginMockHttpsResponse({ body: Buffer.from(source) })
		await assert.rejects(run.pending, (error) => error.code === 'GLM_OCR_RESPONSE_INVALID')
	}
})

test('internal strict parser exposes mutation-sensitive inclusive resource boundaries', () => {
	assert.deepEqual(STRICT_JSON_LIMITS, {
		rawBytes: 16 * 1024 * 1024,
		rootDepth: 1,
		maxDepth: 32,
		maxNodes: 200000,
		maxKeyChars: 128,
		maxObjectKeys: 64,
		maxArrayItems: 5000,
		nodeAccounting: 'container+decoded-key+primitive',
	})
	const nestedEmpty = (depth) => `${'['.repeat(depth)}${']'.repeat(depth)}`
	assert.ok(Array.isArray(parseStrictDirect(nestedEmpty(32))))
	assert.throws(() => parseStrictDirect(nestedEmpty(33)), /strict-json-invalid/)

	const key128 = 'k'.repeat(128)
	assert.equal(parseStrictDirect(`{"${key128}":1}`)[key128], 1)
	assert.throws(() => parseStrictDirect(`{"${'k'.repeat(129)}":1}`), /strict-json-invalid/)

	const object64 = `{${Array.from({ length: 64 }, (_, index) => `"k${index}":0`).join(',')}}`
	const object65 = `{${Array.from({ length: 65 }, (_, index) => `"k${index}":0`).join(',')}}`
	assert.equal(Object.keys(parseStrictDirect(object64)).length, 64)
	assert.throws(() => parseStrictDirect(object65), /strict-json-invalid/)

	const array5000 = `[${Array.from({ length: 5000 }, () => '0').join(',')}]`
	const array5001 = `[${Array.from({ length: 5001 }, () => '0').join(',')}]`
	assert.equal(parseStrictDirect(array5000).length, 5000)
	assert.throws(() => parseStrictDirect(array5001), /strict-json-invalid/)

	const exactNodeRows = [
		...Array.from({ length: 39 }, () => `[${Array.from({ length: 5000 }, () => '0').join(',')}]`),
		`[${Array.from({ length: 4959 }, () => '0').join(',')}]`,
	]
	const overNodeRows = [...exactNodeRows]
	overNodeRows[overNodeRows.length - 1] = `[${Array.from({ length: 4960 }, () => '0').join(',')}]`
	assert.equal(parseStrictDirect(`[${exactNodeRows.join(',')}]`).length, 40)
	assert.throws(() => parseStrictDirect(`[${overNodeRows.join(',')}]`), /strict-json-invalid/)

	const region = {
		index: 1,
		label: 'text',
		bbox_2d: [0.1, 0.1, 0.5, 0.3],
		content: 'x',
		height: 800,
		width: 600,
	}
	const raw5000 = successEnvelope()
	raw5000.layout_details[0] = Array.from({ length: 5000 }, (_, index) => ({ ...region, index: index + 1 }))
	const body5000 = Buffer.from(JSON.stringify(raw5000))
	assert.ok(body5000.length < 16 * 1024 * 1024)
})

test('client accepts exactly 5000 provider regions and rejects 5001', async () => {
	const region = {
		index: 1,
		label: 'text',
		bbox_2d: [0.1, 0.1, 0.5, 0.3],
		content: 'x',
		height: 800,
		width: 600,
	}
	const exact = successEnvelope()
	exact.layout_details[0] = Array.from({ length: 5000 }, (_, index) => ({
		...region,
		index: index + 1,
	}))
	const exactBody = Buffer.from(JSON.stringify(exact))
	const exactRun = beginMockHttpsResponse({ body: exactBody })
	assert.equal((await exactRun.pending).pages[0].layoutDetails[0].length, 5000)

	const over = successEnvelope()
	over.layout_details[0] = Array.from({ length: 5001 }, (_, index) => ({
		...region,
		index: index + 1,
	}))
	const overBody = Buffer.from(JSON.stringify(over))
	const overRun = beginMockHttpsResponse({ body: overBody })
	await assert.rejects(overRun.pending, (error) => error.code === 'GLM_OCR_RESPONSE_INVALID')
})

test('escape-dense strings stay bounded and parser deadline wins after synchronous work crosses 120s', async () => {
	const fixture = successEnvelope()
	fixture.md_results = '\n'.repeat(400000)
	const body = Buffer.from(JSON.stringify(fixture))
	const successRun = beginMockHttpsResponse({ body })
	assert.equal((await successRun.pending).pages.length, 1)

	const harness = createHttpsHarness()
	const pending = harness.client.parsePages([page(1)])
	const socket = harness.freshSocket()
	socket.emit('secureConnect')
	const response = new MockResponse(200, jsonRawHeaders(body.length))
	harness.respond(response)
	response.emit('data', body)
	harness.clock.jumpOnNextChecks(2, 120000)
	response.complete = true
	response.emit('end')
	await flushMicrotasks()
	harness.clock.advance(1000)
	await flushMicrotasks()
	const secondSocket = harness.freshSocket()
	secondSocket.emit('secureConnect')
	const secondResponse = new MockResponse(200, jsonRawHeaders(body.length))
	harness.respond(secondResponse)
	secondResponse.emit('data', body)
	harness.clock.setTime(harness.clock.time + 120000)
	secondResponse.complete = true
	secondResponse.emit('end')
	await assert.rejects(pending, (error) => error.code === 'GLM_OCR_PAGE_TIMEOUT')
	assert.equal(harness.clock.activeTimers, 0)

	const nearCapEscapes = '\\n'.repeat(7000000)
	const canonicalTail = JSON.stringify(successEnvelope()).slice(1)
	const nearCapBody = Buffer.from(`{"bomb":"${nearCapEscapes}",${canonicalTail}`)
	assert.ok(nearCapBody.length < 16 * 1024 * 1024)
	const nearCapRun = beginMockHttpsResponse({ body: nearCapBody })
	await assert.rejects(nearCapRun.pending, (error) => error.code === 'GLM_OCR_RESPONSE_INVALID')
})

test('page deadline is checked again after synchronous request upload work', async () => {
	const clock = new FakeClock()
	const requests = []
	const requestFactory = () => {
		const request = new MockRequest()
		request.end = function end(body) {
			this.endCalls += 1
			this.body = body
			const socket = new MockSocket()
			this.emit('socket', socket)
			socket.emit('secureConnect')
			clock.setTime(clock.time + 120000)
		}
		requests.push(request)
		return request
	}
	const client = createGlmOcrClient({
		__testing: {
			apiKey: FAKE_TOKEN,
			requestFactory,
			clock: clock.hooks,
		},
	})
	const pending = client.parsePages([page(1)])
	await flushMicrotasks()
	clock.advance(1000)
	await flushMicrotasks()
	await assert.rejects(pending, (error) => error.code === 'GLM_OCR_PAGE_TIMEOUT')
	assert.equal(requests.length, 2)
	assert.ok(requests.every((request) => request.endCalls === 1 && request.destroyed))
	assert.equal(clock.activeTimers, 0)
})

test('requestFactory synchronous time is checked before any request end or body write', async () => {
	for (const elapsed of [15000, 119999, 120000]) {
		const clock = new FakeClock()
		const requests = []
		const client = createGlmOcrClient({
			__testing: {
				apiKey: FAKE_TOKEN,
				requestFactory: () => {
					clock.setTime(clock.time + elapsed)
					const request = new MockRequest()
					requests.push(request)
					return request
				},
				clock: clock.hooks,
			},
		})
		const pending = client.parsePages([page(1)])
		await flushMicrotasks()
		clock.advance(1000)
		await flushMicrotasks()
		await assert.rejects(
			pending,
			(error) => error.code === 'GLM_OCR_CONNECT_TIMEOUT'
		)
		assert.equal(requests.length, 2)
		assert.ok(requests.every((request) => request.endCalls === 0 && request.destroyed))
		assert.equal(clock.activeTimers, 0)
	}

	const before = new FakeClock()
	const beforeRequest = new MockRequest()
	const beforeController = new AbortController()
	const beforeClient = createGlmOcrClient({
		__testing: {
			apiKey: FAKE_TOKEN,
			requestFactory: () => {
				before.setTime(14999)
				return beforeRequest
			},
			clock: before.hooks,
		},
	})
	const beforePending = beforeClient.parsePages([page(1)], { signal: beforeController.signal })
	assert.equal(beforeRequest.endCalls, 1)
	beforeController.abort()
	await assert.rejects(beforePending, (error) => error.code === 'ABORT_ERR')
})

test('local body and request-option construction do not consume the 15s connect budget', async () => {
	const harness = createHttpsHarness()
	harness.clock.jumpOnNextChecks(2, 16000)
	const pending = harness.client.parsePages([page(1)])
	assert.equal(harness.request.endCalls, 1)
	const socket = harness.freshSocket()
	socket.emit('secureConnect')
	const body = Buffer.from(JSON.stringify(successEnvelope()))
	const response = new MockResponse(200, jsonRawHeaders(body.length))
	harness.respond(response)
	emitCompleteResponse(response, [body])
	assert.equal((await pending).pages.length, 1)
})

test('caller abort, timeout, and success use one first-settlement lifecycle in both race orders', async () => {
	const timeoutFirst = createHttpsHarness()
	const timeoutController = new AbortController()
	const timeoutPending = timeoutFirst.client.parsePages(
		[page(1)],
		{ signal: timeoutController.signal }
	)
	timeoutFirst.clock.advance(15000)
	await flushMicrotasks()
	timeoutFirst.clock.advance(1000)
	await flushMicrotasks()
	timeoutFirst.clock.advance(15000)
	timeoutController.abort('late-private-reason')
	await assert.rejects(
		timeoutPending,
		(error) => error.code === 'GLM_OCR_CONNECT_TIMEOUT'
			&& !`${JSON.stringify(error)} ${error.stack}`.includes('late-private-reason')
	)

	const abortFirst = createHttpsHarness()
	const abortController = new AbortController()
	const abortPending = abortFirst.client.parsePages([page(1)], { signal: abortController.signal })
	abortController.abort('first-private-reason')
	abortFirst.clock.advance(15000)
	await assert.rejects(
		abortPending,
		(error) => error.name === 'AbortError'
			&& error.code === 'ABORT_ERR'
			&& !`${JSON.stringify(error)} ${error.stack}`.includes('first-private-reason')
	)

	const successFirst = createHttpsHarness()
	const successController = new AbortController()
	const successPending = successFirst.client.parsePages([page(1)], { signal: successController.signal })
	const successSocket = successFirst.freshSocket()
	successSocket.emit('secureConnect')
	const body = Buffer.from(JSON.stringify(successEnvelope()))
	const response = new MockResponse(200, jsonRawHeaders(body.length))
	successFirst.respond(response)
	emitCompleteResponse(response, [body])
	successController.abort('late-after-success')
	assert.equal((await successPending).pages.length, 1)
	assert.equal(successFirst.clock.activeTimers, 0)
})

test('synchronous abort or timer settlement prevents request end and all outbound body writes', async () => {
	const controller = new AbortController()
	const request = new MockRequest()
	const clock = new FakeClock()
	const requestFactory = () => {
		controller.abort('abort-inside-request-factory')
		return request
	}
	const client = createGlmOcrClient({
		__testing: { apiKey: FAKE_TOKEN, requestFactory, clock: clock.hooks },
	})
	await assert.rejects(
		client.parsePages([page(1)], { signal: controller.signal }),
		(error) => error.name === 'AbortError' && error.code === 'ABORT_ERR'
	)
	assert.equal(request.endCalls, 0)
	assert.equal(request.destroyed, true)
	assert.equal(clock.activeTimers, 0)

	const immediateRequest = new MockRequest()
	let timerId = 0
	const synchronousClock = {
		now: () => 0,
		wallNow: () => Date.UTC(2026, 0, 1),
		setTimeout: (callback) => {
			timerId += 1
			callback()
			return timerId
		},
		clearTimeout: () => {},
	}
	const immediateClient = createGlmOcrClient({
		__testing: {
			apiKey: FAKE_TOKEN,
			requestFactory: () => immediateRequest,
			clock: synchronousClock,
		},
	})
	assert.throws(
		() => immediateClient.parsePages([page(1)]),
		(error) => error.code === 'OCR_STAGE_DEADLINE_EXCEEDED'
	)
	assert.equal(immediateRequest.endCalls, 0)
})

test('transport interruption is retryable network failure while clean-end framing errors are schema failures', async () => {
	for (const event of ['error', 'aborted', 'close']) {
		const harness = createHttpsHarness()
		const pending = harness.client.parsePages([page(1)])
		const body = Buffer.from(JSON.stringify(successEnvelope()))
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const socket = harness.freshSocket()
			socket.emit('secureConnect')
			const response = new MockResponse(200, jsonRawHeaders(body.length))
			harness.respond(response)
			response.emit('data', body.subarray(0, 10))
			if (event === 'error') response.emit('error', new Error('private-reset-detail'))
			else response.emit(event)
			if (attempt === 0) {
				await flushMicrotasks()
				harness.clock.advance(1000)
				await flushMicrotasks()
			}
		}
		await assert.rejects(
			pending,
			(error) => error.code === 'GLM_OCR_NETWORK_ERROR'
				&& error.retryable === true
				&& !`${JSON.stringify(error)} ${error.stack}`.includes('private-reset-detail')
		)
		assert.equal(harness.clock.activeTimers, 0)
	}

	const shortBody = Buffer.from(JSON.stringify(successEnvelope()))
	const cleanShort = beginMockHttpsResponse({
		body: shortBody,
		rawHeaders: jsonRawHeaders(shortBody.length, { contentLength: shortBody.length + 1 }),
		complete: true,
	})
	await assert.rejects(cleanShort.pending, (error) => error.code === 'GLM_OCR_RESPONSE_INVALID')

	const incompleteHarness = createHttpsHarness()
	const incompletePending = incompleteHarness.client.parsePages([page(1)])
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const socket = incompleteHarness.freshSocket()
		socket.emit('secureConnect')
		const response = new MockResponse(200, jsonRawHeaders(shortBody.length))
		incompleteHarness.respond(response)
		response.emit('data', shortBody)
		response.complete = false
		response.emit('end')
		if (attempt === 0) {
			await flushMicrotasks()
			incompleteHarness.clock.advance(1000)
			await flushMicrotasks()
		}
	}
	await assert.rejects(incompletePending, (error) => error.code === 'GLM_OCR_NETWORK_ERROR')
})

test('failure cleanup drains late errors, destroys resources, clears timers, and never resettles', async () => {
	const harness = createHttpsHarness()
	const pending = harness.client.parsePages([page(1)])
	const socket = harness.freshSocket()
	const body = Buffer.from(JSON.stringify(successEnvelope()))
	const response = new MockResponse(200, jsonRawHeaders(body.length))
	socket.emit('secureConnect')
	harness.respond(response)
	response.emit('data', body.subarray(0, 5))
	harness.clock.advance(120000)
	await flushMicrotasks()
	harness.clock.advance(1000)
	await flushMicrotasks()
	const secondSocket = harness.freshSocket()
	secondSocket.emit('secureConnect')
	const secondResponse = new MockResponse(200, jsonRawHeaders(body.length))
	harness.respond(secondResponse)
	secondResponse.emit('data', body.subarray(0, 5))
	harness.clock.advance(120000)
	await assert.rejects(pending, (error) => error.code === 'GLM_OCR_PAGE_TIMEOUT')

	assert.ok(harness.requests.every((request) => request.destroyed))
	assert.equal(secondResponse.destroyed, true)
	assert.equal(secondSocket.destroyed, true)
	assert.equal(harness.clock.activeTimers, 0)
	assert.doesNotThrow(() => {
		harness.request.emit('error', new Error('late-request-error'))
		secondResponse.emit('error', new Error('late-response-error'))
		secondSocket.emit('error', new Error('late-socket-error'))
		secondResponse.emit('data', body)
		secondResponse.emit('end')
		secondSocket.emit('secureConnect')
	})
})

test('requestFactory synchronous failure is safe network error with complete timer cleanup', async () => {
	const secret = 'request-factory-private-detail'
	const { client, clock } = clientWithRequestFactory(() => { throw new Error(secret) })
	const pending = client.parsePages([page(1)])
	await flushMicrotasks()
	clock.advance(1000)
	await flushMicrotasks()
	await assert.rejects(pending, (error) => {
		assert.equal(error.code, 'GLM_OCR_NETWORK_ERROR')
		assert.equal(`${JSON.stringify(error)} ${error.stack}`.includes(secret), false)
		return true
	})
	assert.equal(clock.activeTimers, 0)
})

test('compressed body honors backpressure and reentrant decoded-cap failure cannot revive listeners', async () => {
	class FakeDecoder extends EventEmitter {
		constructor(decoded) {
			super()
			this.decoded = decoded
			this.destroyed = false
			this.bytesWritten = 0
		}

		write(chunk) {
			this.bytesWritten += chunk.byteLength
			this.emit('data', this.decoded)
			return false
		}

		end() {
			this.emit('end')
		}

		destroy() {
			this.destroyed = true
			this.emit('close')
		}
	}

	const decoded = Buffer.from(JSON.stringify(successEnvelope()))
	let decoder = null
	const harness = createHttpsHarness({
		decompressorFactory: () => {
			decoder = new FakeDecoder(decoded)
			return decoder
		},
	})
		const pending = harness.client.parsePages([page(1)])
		const socket = harness.freshSocket()
		socket.emit('secureConnect')
		const wire = Buffer.from('bounded-wire')
		const response = new MockResponse(200, jsonRawHeaders(wire.length, { contentEncoding: 'gzip' }))
		harness.respond(response)
		response.emit('data', wire)
		assert.equal(response.pauseCalls, 1)
		decoder.emit('drain')
		assert.equal(response.resumeCalls, 1)
		response.complete = true
		response.emit('end')
		assert.equal((await pending).pages.length, 1)

	const overCapDecoder = new FakeDecoder(Buffer.alloc((16 * 1024 * 1024) + 1, 0x20))
	const failingHarness = createHttpsHarness({
		decompressorFactory: () => overCapDecoder,
	})
		const failingPending = failingHarness.client.parsePages([page(1)])
		const failingSocket = failingHarness.freshSocket()
		failingSocket.emit('secureConnect')
		const failingResponse = new MockResponse(200, jsonRawHeaders(wire.length, { contentEncoding: 'gzip' }))
		failingHarness.respond(failingResponse)
		failingResponse.emit('data', wire)
		await assert.rejects(
			failingPending,
			(error) => error.code === 'GLM_OCR_RESPONSE_INVALID'
		)
		assert.equal(failingResponse.pauseCalls, 0)
		assert.equal(overCapDecoder.listenerCount('drain'), 0)
	assert.equal(failingHarness.clock.activeTimers, 0)
})

test('encoded cap is checked before decompressor copy/write and exact cap reaches the decoder', async () => {
	class CountingDecoder extends EventEmitter {
		constructor(decoded) {
			super()
			this.decoded = decoded
			this.writeCalls = 0
			this.bytesWritten = 0
		}

		write(chunk) {
			this.writeCalls += 1
			this.bytesWritten += chunk.byteLength
			this.emit('data', this.decoded)
			return true
		}

		end() { this.emit('end') }
		destroy() { this.emit('close') }
	}

	const decoded = Buffer.from(JSON.stringify(successEnvelope()))
	const rejectingDecoder = new CountingDecoder(decoded)
	const rejectingHarness = createHttpsHarness({ decompressorFactory: () => rejectingDecoder })
	const rejectingPending = rejectingHarness.client.parsePages([page(1)])
	const rejectingSocket = rejectingHarness.freshSocket()
	rejectingSocket.emit('secureConnect')
	const overCapWire = Buffer.alloc((16 * 1024 * 1024) + 1, 0x61)
	const rejectingResponse = new MockResponse(200, [
		'Content-Type', 'application/json',
		'Content-Encoding', 'gzip',
		'Transfer-Encoding', 'chunked',
	])
	rejectingHarness.respond(rejectingResponse)
	rejectingResponse.emit('data', overCapWire)
	await assert.rejects(rejectingPending, (error) => error.code === 'GLM_OCR_RESPONSE_INVALID')
	assert.equal(rejectingDecoder.writeCalls, 0)

	const acceptingDecoder = new CountingDecoder(decoded)
	const acceptingHarness = createHttpsHarness({ decompressorFactory: () => acceptingDecoder })
	const acceptingPending = acceptingHarness.client.parsePages([page(1)])
	const acceptingSocket = acceptingHarness.freshSocket()
	acceptingSocket.emit('secureConnect')
	const exactWire = Buffer.alloc(16 * 1024 * 1024, 0x61)
	const acceptingResponse = new MockResponse(200, [
		'Content-Type', 'application/json',
		'Content-Encoding', 'gzip',
		'Content-Length', String(exactWire.length),
	])
	acceptingHarness.respond(acceptingResponse)
	acceptingResponse.emit('data', exactWire)
	acceptingResponse.complete = true
	acceptingResponse.emit('end')
	assert.equal((await acceptingPending).pages.length, 1)
	assert.equal(acceptingDecoder.writeCalls, 1)
})

test('malformed and truncated compressed streams are response-invalid, never page timeouts', async () => {
	const plain = Buffer.from(JSON.stringify(successEnvelope()))
	const cases = [
		['gzip', Buffer.from('not-gzip')],
		['deflate', Buffer.from('not-deflate')],
		['br', Buffer.from('not-brotli')],
		['gzip', zlib.gzipSync(plain).subarray(0, -5)],
		['deflate', zlib.deflateSync(plain).subarray(0, -3)],
		['br', zlib.brotliCompressSync(plain).subarray(0, -2)],
		['gzip', Buffer.concat([zlib.gzipSync(plain), Buffer.from('private-tail')])],
		['deflate', Buffer.concat([zlib.deflateSync(plain), Buffer.from('private-tail')])],
		['br', Buffer.concat([zlib.brotliCompressSync(plain), Buffer.from('private-tail')])],
	]
	for (const [encoding, wire] of cases) {
		const run = beginMockHttpsResponse({
			body: wire,
			rawHeaders: jsonRawHeaders(wire.length, { contentEncoding: encoding }),
		})
		await assert.rejects(
			run.pending,
			(error) => error.code === 'GLM_OCR_RESPONSE_INVALID'
				&& !`${JSON.stringify(error)} ${error.stack}`.includes('private-tail')
		)
		assert.equal(run.harness.clock.activeTimers, 0)
	}
})

test('gzip concatenated members must be fully consumed and decode to one strict JSON root', async () => {
	const plain = Buffer.from(JSON.stringify(successEnvelope()))
	const whitespaceMember = Buffer.concat([
		zlib.gzipSync(plain),
		zlib.gzipSync(Buffer.from(' \n\t')),
	])
	const accepted = beginMockHttpsResponse({
		body: whitespaceMember,
		rawHeaders: jsonRawHeaders(whitespaceMember.length, { contentEncoding: 'gzip' }),
	})
	assert.equal((await accepted.pending).pages.length, 1)

	const secondRootMember = Buffer.concat([
		zlib.gzipSync(plain),
		zlib.gzipSync(Buffer.from('false')),
	])
	const rejected = beginMockHttpsResponse({
		body: secondRootMember,
		rawHeaders: jsonRawHeaders(secondRootMember.length, { contentEncoding: 'gzip' }),
	})
	await assert.rejects(rejected.pending, (error) => error.code === 'GLM_OCR_RESPONSE_INVALID')
})

test('compressed decoder consumed-byte getter must be a safe exact integer', async () => {
	class GetterDecoder extends EventEmitter {
		constructor(mode, decoded) {
			super()
			this.mode = mode
			this.decoded = decoded
			this.consumed = 0
		}

		get bytesWritten() {
			if (this.mode === 'throw') throw new Error('private-consumed-getter')
			if (this.mode === 'fraction') return 0.5
			return this.consumed - 1
		}

		write(chunk) {
			this.consumed += chunk.byteLength
			this.emit('data', this.decoded)
			return true
		}

		end() { this.emit('end') }
		destroy() { this.emit('close') }
	}

	const decoded = Buffer.from(JSON.stringify(successEnvelope()))
	for (const mode of ['throw', 'fraction', 'short']) {
		const decoder = new GetterDecoder(mode, decoded)
		const harness = createHttpsHarness({ decompressorFactory: () => decoder })
		const pending = harness.client.parsePages([page(1)])
		const socket = harness.freshSocket()
		socket.emit('secureConnect')
		const wire = Buffer.from('compressed-wire')
		const response = new MockResponse(200, jsonRawHeaders(wire.length, { contentEncoding: 'gzip' }))
		harness.respond(response)
		emitCompleteResponse(response, [wire])
		await assert.rejects(
			pending,
			(error) => error.code === 'GLM_OCR_RESPONSE_INVALID'
				&& !`${JSON.stringify(error)} ${error.stack}`.includes('private-consumed-getter')
		)
	}
})

test('automatic retry uses two total attempts and only the private eligibility tuple', async () => {
	for (const firstFailure of [
		{ type: 'status', status: 408 },
		{ type: 'status', status: 429 },
		{ type: 'status', status: 500 },
		{ type: 'status', status: 502 },
		{ type: 'status', status: 503 },
		{ type: 'status', status: 504 },
		{ type: 'network' },
	]) {
		const clock = createImmediateBackoffClock()
		let calls = 0
		const client = clientWithTransport(async () => {
			calls += 1
			if (calls === 1) {
				if (firstFailure.type === 'network') throw new Error('private-network-detail')
				return {
					status: firstFailure.status,
					rawHeaders: firstFailure.status === 429 ? ['Retry-After', '0'] : [],
					json: async () => { throw new Error('non-200-body-read') },
				}
			}
			return jsonResponse()
		}, clock)
		assert.equal((await client.parsePages([page(1)])).pages.length, 1)
		assert.equal(calls, 2)
		assert.equal(clock.activeTimers, 0)
	}

	for (const status of [300, 400, 401, 403, 413, 418, 501, 505, 599]) {
		let calls = 0
		const client = clientWithTransport(async () => {
			calls += 1
			return { status, rawHeaders: [], json: async () => successEnvelope() }
		})
		await assert.rejects(client.parsePages([page(1)]))
		assert.equal(calls, 1)
	}

	const exhaustedClock = createImmediateBackoffClock()
	let exhaustedCalls = 0
	const exhausted = clientWithTransport(async () => {
		exhaustedCalls += 1
		return { status: 503, rawHeaders: [], json: async () => successEnvelope() }
	}, exhaustedClock)
	await assert.rejects(exhausted.parsePages([page(1)]), (error) => {
		assert.equal(error.code, 'GLM_OCR_PROVIDER_UNAVAILABLE')
		assert.equal(error.retryable, true)
		assert.deepEqual(Object.keys(error), ['code', 'class', 'stage', 'retryable', 'safeMessageKey'])
		return true
	})
	assert.equal(exhaustedCalls, 2)

	const finalHintClock = createImmediateBackoffClock()
	const finalHint = clientWithTransport(async () => ({
		status: 429,
		rawHeaders: ['Retry-After', 'private-hint-sentinel'],
		json: async () => null,
	}), finalHintClock)
	await assert.rejects(finalHint.parsePages([page(1)]), (error) => {
		const visible = `${JSON.stringify(error)} ${error.stack}`
		assert.equal(visible.includes('private-hint-sentinel'), false)
		assert.deepEqual(Object.keys(error), ['code', 'class', 'stage', 'retryable', 'safeMessageKey'])
		assert.equal('attempt' in error, false)
		assert.equal('delay' in error, false)
		return true
	})
})

test('429 Retry-After delta and IMF-fixdate variants choose one bounded cancellable delay', async () => {
	const wall = Date.UTC(2026, 0, 1, 0, 0, 0)
	const future = new Date(wall + 5000).toUTCString()
	const farFuture = new Date(wall + 60000).toUTCString()
	const past = new Date(wall - 5000).toUTCString()
	const cases = [
		['0', 0, 0],
		['000', 0, 0],
		['1', 1000, 0],
		['00030', 30000, 0],
		['9'.repeat(128), 30000, 0],
		['9'.repeat(129), 30000, 0],
		['0'.repeat(8190) + '30', 30000, 0],
		['9'.repeat(8193), 1000, 0],
		[` \t${future}\t `, 5000, 1],
		[farFuture, 30000, 1],
		[past, 0, 1],
		[future.replace(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)/, 'Mon'), 1000, 0],
		['+1', 1000, 0],
		['-1', 1000, 0],
		['1.0', 1000, 0],
		['1e2', 1000, 0],
		['1\t0', 1000, 0],
		['', 1000, 0],
		[null, 1000, 0],
	]
	for (const [hint, expectedDelay, expectedWallCalls] of cases) {
		const clock = new FakeClock()
		clock.setWallTime(wall)
		let calls = 0
		const client = clientWithTransport(async () => {
			calls += 1
			if (calls === 1) {
				return {
					status: 429,
					rawHeaders: hint === null ? [] : ['Retry-After', hint],
					json: async () => { throw new Error('429-body-must-not-be-read') },
				}
			}
			return jsonResponse()
		}, clock)
		const pending = client.parsePages([page(1)])
		await flushMicrotasks()
		if (expectedDelay > 0) {
			clock.advance(expectedDelay - 1)
			await flushMicrotasks()
			assert.equal(calls, 1)
			clock.setWallTime(wall + 86400000)
			clock.advance(1)
		}
		await flushMicrotasks()
		assert.equal((await pending).pages.length, 1)
		assert.equal(calls, 2)
		assert.equal(clock.activeTimers, 0)
		assert.equal(clock.wallNowCalls, expectedWallCalls)
	}

	const duplicateClock = new FakeClock()
	let duplicateCalls = 0
	const duplicate = clientWithTransport(async () => {
		duplicateCalls += 1
		if (duplicateCalls === 1) {
			return {
				status: 429,
				rawHeaders: ['Retry-After', '0', 'Retry-After', '30'],
				json: async () => null,
			}
		}
		return jsonResponse()
	}, duplicateClock)
	const duplicatePending = duplicate.parsePages([page(1)])
	await flushMicrotasks()
	duplicateClock.advance(1000)
	await flushMicrotasks()
	await duplicatePending
	assert.equal(duplicateCalls, 2)
})

test('Retry-After wall clock failure is safe client error and never becomes a transport retry', async () => {
	const clock = new FakeClock()
	const hooks = {
		...clock.hooks,
		wallNow: () => { throw new Error('private-wall-clock-detail') },
	}
	let calls = 0
	const client = clientWithTransport(async () => {
		calls += 1
		return {
			status: 429,
			rawHeaders: ['Retry-After', new Date(clock.wallTime + 5000).toUTCString()],
			json: async () => null,
		}
	}, hooks)
	await assert.rejects(client.parsePages([page(1)]), (error) => {
		assert.equal(error.code, 'GLM_OCR_CLIENT_ERROR')
		assert.equal(`${JSON.stringify(error)} ${error.stack}`.includes('private-wall-clock-detail'), false)
		return true
	})
	assert.equal(calls, 1)
})

test('420s stage deadline covers valid preflight, ignored transport, backoff, and the whole page batch', async () => {
	const nearCapBytes = Buffer.alloc(PAGE_BYTE_CAP - 1)
	nearCapBytes[0] = 0xff
	nearCapBytes[1] = 0xd8
	nearCapBytes[nearCapBytes.length - 2] = 0xff
	nearCapBytes[nearCapBytes.length - 1] = 0xd9
	const nearCap = jpegDataUri(nearCapBytes)

	const beforeClock = new FakeClock()
	beforeClock.jumpOnNextChecks(6, 419999)
	const beforeClient = clientWithTransport(async () => jsonResponse(), beforeClock)
	assert.equal((await beforeClient.parsePages([page(1, nearCap)])).pages.length, 1)

	const atClock = new FakeClock()
	atClock.jumpOnNextChecks(6, 420000)
	let preflightCalls = 0
	const atClient = clientWithTransport(async () => {
		preflightCalls += 1
		return jsonResponse()
	}, atClock)
	assert.throws(
		() => atClient.parsePages([page(1, nearCap)]),
		(error) => error.code === 'OCR_STAGE_DEADLINE_EXCEEDED'
	)
	assert.equal(preflightCalls, 0)
	assert.equal(atClock.activeTimers, 0)

	const manyClock = new FakeClock()
	manyClock.jumpOnNextChecks(20, 420000)
	let manyCalls = 0
	const manyClient = clientWithTransport(async () => {
		manyCalls += 1
		return jsonResponse()
	}, manyClock)
	assert.throws(
		() => manyClient.parsePages(Array.from({ length: 100 }, (_, index) => page(index + 1))),
		(error) => error.code === 'OCR_STAGE_DEADLINE_EXCEEDED'
	)
	assert.equal(manyCalls, 0)

	const ignoredClock = new FakeClock()
	let lateResolve
	let observedSignal = null
	let ignoredCalls = 0
	const ignoredClient = clientWithTransport((_endpoint, request) => {
		ignoredCalls += 1
		if (ignoredCalls <= 3) {
			ignoredClock.setTime(ignoredClock.time + 119000)
			return Promise.resolve(jsonResponse())
		}
		observedSignal = request.signal
		return new Promise((resolve) => { lateResolve = resolve })
	}, ignoredClock, 1)
	const ignoredPending = ignoredClient.parsePages([page(1), page(2), page(3), page(4)])
	await flushUntil(() => ignoredCalls === 4)
	ignoredClock.advance(420000 - ignoredClock.time)
	await assert.rejects(ignoredPending, (error) => {
		assert.equal(error.code, 'OCR_STAGE_DEADLINE_EXCEEDED')
		assert.equal(error.retryable, true)
		assert.equal(error.class, 'transport_transient')
		assert.deepEqual(Object.keys(error), ['code', 'class', 'stage', 'retryable', 'safeMessageKey'])
		assert.equal('pages' in error, false)
		assert.equal('results' in error, false)
		return true
	})
	assert.equal(observedSignal.aborted, true)
	lateResolve(jsonResponse())
	await flushMicrotasks()
	assert.equal(ignoredClock.activeTimers, 0)

	const backoffClock = new FakeClock()
	let backoffCalls = 0
	const backoffClient = clientWithTransport(async () => {
		backoffCalls += 1
		if (backoffCalls <= 3) {
			backoffClock.setTime(backoffClock.time + 119000)
			return jsonResponse()
		}
		if (backoffCalls === 4) {
			backoffClock.setTime(backoffClock.time + 62000)
			return jsonResponse()
		}
		return { status: 503, rawHeaders: [], json: async () => null }
	}, backoffClock, 1)
	const backoffPending = backoffClient.parsePages([
		page(1), page(2), page(3), page(4), page(5),
	])
	await flushUntil(() => backoffCalls === 5)
	backoffClock.advance(1000)
	await assert.rejects(backoffPending, (error) => error.code === 'OCR_STAGE_DEADLINE_EXCEEDED')
	assert.equal(backoffCalls, 5)

	const batchClock = new FakeClock()
	let batchCalls = 0
	let pageTwoResolve
	const batchClient = clientWithTransport(async () => {
		batchCalls += 1
		if (batchCalls <= 3) {
			batchClock.setTime(batchClock.time + 119000)
			return jsonResponse()
		}
		return new Promise((resolve) => { pageTwoResolve = resolve })
	}, batchClock, 1)
	const batchPending = batchClient.parsePages([page(1), page(2), page(3), page(4)])
	await flushUntil(() => batchCalls === 4)
	assert.equal(batchCalls, 4)
	batchClock.advance(420000 - batchClock.time)
	await assert.rejects(batchPending, (error) => error.code === 'OCR_STAGE_DEADLINE_EXCEEDED')
	pageTwoResolve(jsonResponse())
	await flushMicrotasks()
})

test('caller abort and stage deadline keep first-event ordering during ignored transport', async () => {
	for (const first of ['caller', 'stage']) {
		const clock = new FakeClock()
		const controller = new AbortController()
		let calls = 0
		const client = clientWithTransport(() => {
			calls += 1
			if (calls <= 3) {
				clock.setTime(clock.time + 119000)
				return Promise.resolve(jsonResponse())
			}
			return new Promise(() => {})
		}, clock, 1)
		const pending = client.parsePages(
			[page(1), page(2), page(3), page(4)],
			{ signal: controller.signal }
		)
		await flushUntil(() => calls === 4)
		if (first === 'caller') {
			controller.abort('private-caller-first')
			clock.advance(420000 - clock.time)
			await assert.rejects(pending, (error) => error.code === 'ABORT_ERR')
		} else {
			clock.advance(420000 - clock.time)
			controller.abort('private-caller-late')
			await assert.rejects(pending, (error) => error.code === 'OCR_STAGE_DEADLINE_EXCEEDED')
		}
		assert.equal(clock.activeTimers, 0)
	}
})

test('final controlled attempt outcome is marked before abort cleanup can trigger late caller control', async () => {
	const pageClock = new FakeClock()
	const pageController = new AbortController()
	let pageCalls = 0
	const pageClient = clientWithTransport((_endpoint, request) => {
		pageCalls += 1
		if (pageCalls === 2) {
			EventTarget.prototype.addEventListener.call(request.signal, 'abort', () => {
				pageController.abort('caller-from-attempt-cleanup')
			}, { once: true })
		}
		return new Promise(() => {})
	}, pageClock)
	const pagePending = pageClient.parsePages([page(1)], { signal: pageController.signal })
	pageClock.advance(120000)
	await flushMicrotasks()
	pageClock.advance(1000)
	await flushMicrotasks()
	pageClock.advance(120000)
	await assert.rejects(pagePending, (error) => error.code === 'GLM_OCR_PAGE_TIMEOUT')
	assert.equal(pageController.signal.aborted, true)

	const httpClock = new FakeClock()
	const httpController = new AbortController()
	const httpClient = clientWithTransport(async (_endpoint, request) => {
		EventTarget.prototype.addEventListener.call(request.signal, 'abort', () => {
			httpController.abort('caller-after-http')
		}, { once: true })
		return { status: 400, rawHeaders: [], json: async () => null }
	}, httpClock)
	await assert.rejects(
		httpClient.parsePages([page(1)], { signal: httpController.signal }),
		(error) => error.code === 'GLM_OCR_BAD_REQUEST'
	)
	assert.equal(httpController.signal.aborted, true)
})

test('single ignored transport exhausts two page-timeout attempts before the 420s stage deadline', async () => {
	const clock = new FakeClock()
	let calls = 0
	const lateRejects = []
	const client = clientWithTransport(() => {
		calls += 1
		return new Promise((_resolve, reject) => lateRejects.push(reject))
	}, clock, 1)
	const pending = client.parsePages([page(1)])
	clock.advance(120000)
	await flushMicrotasks()
	clock.advance(1000)
	await flushMicrotasks()
	assert.equal(calls, 2)
	clock.advance(120000)
	await assert.rejects(pending, (error) => error.code === 'GLM_OCR_PAGE_TIMEOUT')
	for (const reject of lateRejects) reject(new Error('late-ignored-rejection'))
	await flushMicrotasks()
	assert.equal(clock.activeTimers, 0)
})

test('default HTTPS in-flight work is destroyed when a later-page stage deadline wins', async () => {
	const harness = createHttpsHarness({ pageConcurrency: 1 })
	const pending = harness.client.parsePages([page(1), page(2), page(3), page(4)])
	for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
		const socket = harness.freshSocket()
		socket.emit('secureConnect')
		harness.clock.setTime(harness.clock.time + 119000)
		const body = Buffer.from(JSON.stringify(successEnvelope()))
		const response = new MockResponse(200, jsonRawHeaders(body.length))
		harness.respond(response)
		emitCompleteResponse(response, [body])
		await flushMicrotasks()
	}
	assert.equal(harness.requestFactoryCalls, 4)
	const finalRequest = harness.request
	const finalSocket = harness.freshSocket()
	finalSocket.emit('secureConnect')
	const body = Buffer.from(JSON.stringify(successEnvelope()))
	const finalResponse = new MockResponse(200, jsonRawHeaders(body.length))
	harness.respond(finalResponse)
	finalResponse.emit('data', body.subarray(0, 10))
	harness.clock.advance(420000 - harness.clock.time)
	await assert.rejects(pending, (error) => error.code === 'OCR_STAGE_DEADLINE_EXCEEDED')
	assert.equal(finalRequest.destroyed, true)
	assert.equal(finalSocket.destroyed, true)
	assert.equal(finalResponse.destroyed, true)
	assert.equal(harness.clock.activeTimers, 0)
})

test('caller abort during retry backoff cancels the delay and prevents attempt two', async () => {
	const clock = new FakeClock()
	const controller = new AbortController()
	let calls = 0
	const client = clientWithTransport(async () => {
		calls += 1
		return { status: 503, rawHeaders: [], json: async () => null }
	}, clock, 1)
	const pending = client.parsePages([page(1)], { signal: controller.signal })
	await flushMicrotasks()
	assert.equal(calls, 1)
	controller.abort('private-backoff-abort')
	await assert.rejects(pending, (error) => {
		assert.equal(error.code, 'ABORT_ERR')
		assert.equal(`${JSON.stringify(error)} ${error.stack}`.includes('private-backoff-abort'), false)
		return true
	})
	assert.equal(calls, 1)
	assert.equal(clock.activeTimers, 0)
})

test('permanent failure on a later page returns no partial envelope and never starts following pages', async () => {
	const clock = createImmediateBackoffClock()
	let calls = 0
	const client = clientWithTransport(async () => {
		calls += 1
		if (calls === 1) return jsonResponse()
		return { status: 400, rawHeaders: [], json: async () => null }
	}, clock, 1)
	await assert.rejects(
		client.parsePages([page(1), page(2), page(3)]),
		(error) => {
			assert.equal(error.code, 'GLM_OCR_BAD_REQUEST')
			assert.equal('pages' in error, false)
			assert.equal('results' in error, false)
			return true
		}
	)
	assert.equal(calls, 2)
})

test('one client shares a default FIFO pool and bounds a 100-page batch to three workers', async () => {
	const clock = new FakeClock()
	const controller = new AbortController()
	const batchAPages = Array.from({ length: 100 }, (_, index) => markedPage(index + 1, index + 1))
	const batchBPage = markedPage(1, 1000)
	const batchAFiles = new Set(batchAPages.map((entry) => entry.jpegDataUri))
	const records = []
	const deferred = []
	let active = 0
	let peak = 0
	const transport = (_endpoint, request) => {
		const file = JSON.parse(request.body).file
		const batch = batchAFiles.has(file) ? 'A' : 'B'
		records.push(batch)
		active += 1
		peak = Math.max(peak, active)
		return new Promise((resolve, reject) => {
			let done = false
			const finish = (callback, value) => {
				if (done) return
				done = true
				active -= 1
				callback(value)
			}
			EventTarget.prototype.addEventListener.call(request.signal, 'abort', () => {
				finish(reject, new Error('bounded-worker-cancelled'))
			}, { once: true })
			if (batch === 'B') {
				queueMicrotask(() => finish(resolve, jsonResponse()))
			} else {
				deferred.push({ resolve: () => finish(resolve, jsonResponse()) })
			}
		})
	}
	const client = clientWithTransport(transport, clock)
	const batchA = client.parsePages(batchAPages, { signal: controller.signal })
	await flushUntil(() => records.length === 3)
	const batchB = client.parsePages([batchBPage])
	await flushMicrotasks()
	assert.deepEqual(records, ['A', 'A', 'A'])

	deferred[0].resolve()
	await flushUntil(() => records.includes('B'))
	assert.equal(records[3], 'B')
	assert.equal((await batchB).pages[0].pageNumber, 1)
	assert.ok(peak <= 3)

	controller.abort('stop-bounded-batch')
	await assert.rejects(batchA, (error) => error.code === 'ABORT_ERR')
	assert.ok(records.filter((entry) => entry === 'A').length <= 4)
	assert.equal(active, 0)
	assert.equal(clock.activeTimers, 0)
})

test('a complete 100-page batch preserves order, peak three, and restores all permits', async () => {
	const clock = new FakeClock()
	let calls = 0
	let active = 0
	let peak = 0
	const client = clientWithTransport(() => {
		calls += 1
		active += 1
		peak = Math.max(peak, active)
		return Promise.resolve(jsonResponse()).finally(() => { active -= 1 })
	}, clock)
	const pages = Array.from({ length: 100 }, (_, index) => markedPage(index + 1, 10000 + index))
	const result = await client.parsePages(pages)
	assert.equal(calls, 100)
	assert.equal(peak, 3)
	assert.equal(active, 0)
	assert.deepEqual(result.pages.map((entry) => entry.pageNumber), Array.from({ length: 100 }, (_, index) => index + 1))
	const next = await client.parsePages([markedPage(1, 10150)])
	assert.equal(next.pages.length, 1)
	assert.equal(calls, 101)
	assert.equal(active, 0)
	assert.equal(clock.activeTimers, 0)
})

test('pageConcurrency four is a hard per-client cap while separate clients have independent pools', async () => {
	function hangingTransport(counter) {
		return (_endpoint, request) => {
			counter.calls += 1
			counter.active += 1
			counter.peak = Math.max(counter.peak, counter.active)
			return new Promise((_resolve, reject) => {
				EventTarget.prototype.addEventListener.call(request.signal, 'abort', () => {
					counter.active -= 1
					reject(new Error('pool-test-cancelled'))
				}, { once: true })
			})
		}
	}

	const hardClock = new FakeClock()
	const hardCounter = { calls: 0, active: 0, peak: 0 }
	const hardController = new AbortController()
	const hardClient = clientWithTransport(hangingTransport(hardCounter), hardClock, 4)
	const hardPending = hardClient.parsePages(
		Array.from({ length: 8 }, (_, index) => markedPage(index + 1, 1100 + index)),
		{ signal: hardController.signal }
	)
	await flushUntil(() => hardCounter.calls === 4)
	assert.equal(hardCounter.peak, 4)
	hardController.abort()
	await assert.rejects(hardPending, (error) => error.code === 'ABORT_ERR')
	assert.equal(hardCounter.active, 0)
	assert.equal(hardClock.activeTimers, 0)

	const independentClock = new FakeClock()
	const independentCounter = { calls: 0, active: 0, peak: 0 }
	const firstController = new AbortController()
	const secondController = new AbortController()
	const firstClient = clientWithTransport(hangingTransport(independentCounter), independentClock)
	const secondClient = clientWithTransport(hangingTransport(independentCounter), independentClock)
	const firstPending = firstClient.parsePages(
		Array.from({ length: 3 }, (_, index) => markedPage(index + 1, 1200 + index)),
		{ signal: firstController.signal }
	)
	const secondPending = secondClient.parsePages(
		Array.from({ length: 3 }, (_, index) => markedPage(index + 1, 1300 + index)),
		{ signal: secondController.signal }
	)
	await flushUntil(() => independentCounter.calls === 6)
	assert.equal(independentCounter.peak, 6)
	firstController.abort()
	secondController.abort()
	await Promise.all([
		assert.rejects(firstPending, (error) => error.code === 'ABORT_ERR'),
		assert.rejects(secondPending, (error) => error.code === 'ABORT_ERR'),
	])
	assert.equal(independentCounter.active, 0)
	assert.equal(independentClock.activeTimers, 0)
})

test('attempt slots remain held through response normalization and output restores input order', async () => {
	const normalizeResolvers = []
	let normalizeCalls = 0
	const normalizeClient = clientWithTransport(async () => {
		normalizeCalls += 1
		return {
			status: 200,
			json: () => new Promise((resolve) => normalizeResolvers.push(resolve)),
		}
	}, null, 1)
	const normalizePending = normalizeClient.parsePages([markedPage(1, 1401), markedPage(2, 1402)])
	await flushUntil(() => normalizeResolvers.length === 1)
	assert.equal(normalizeCalls, 1)
	normalizeResolvers[0](successEnvelope())
	await flushUntil(() => normalizeResolvers.length === 2)
	assert.equal(normalizeCalls, 2)
	normalizeResolvers[1](successEnvelope())
	assert.deepEqual((await normalizePending).pages.map((entry) => entry.pageNumber), [1, 2])

	const operations = []
	const orderedClient = clientWithTransport(() => new Promise((resolve) => operations.push(resolve)))
	const orderedPending = orderedClient.parsePages([
		markedPage(1, 1501),
		markedPage(2, 1502),
		markedPage(3, 1503),
	])
	await flushUntil(() => operations.length === 3)
	operations[2](jsonResponse())
	operations[0](jsonResponse())
	operations[1](jsonResponse())
	const ordered = await orderedPending
	assert.deepEqual(ordered.pages.map((entry) => entry.pageNumber), [1, 2, 3])
	assert.equal(Object.isFrozen(ordered.pages), true)
})

test('retry backoff releases a concurrency-one slot for another batch before reacquiring FIFO', async () => {
	const clock = new FakeClock()
	const firstFile = markedPage(1, 1601).jpegDataUri
	const secondFile = markedPage(1, 1602).jpegDataUri
	const order = []
	let firstAttempts = 0
	const client = clientWithTransport(async (_endpoint, request) => {
		const file = JSON.parse(request.body).file
		if (file === firstFile) {
			firstAttempts += 1
			order.push('retrying-batch')
			if (firstAttempts === 1) {
				return { status: 429, rawHeaders: ['Retry-After', '1'], json: async () => null }
			}
			return jsonResponse()
		}
		assert.equal(file, secondFile)
		order.push('other-batch')
		return jsonResponse()
	}, clock, 1)
	const first = client.parsePages([markedPage(1, 1601)])
	const second = client.parsePages([markedPage(1, 1602)])
	await flushUntil(() => order.length === 2)
	assert.deepEqual(order, ['retrying-batch', 'other-batch'])
	assert.equal((await second).pages.length, 1)
	clock.advance(999)
	await flushMicrotasks()
	assert.equal(firstAttempts, 1)
	clock.advance(1)
	assert.equal((await first).pages.length, 1)
	assert.deepEqual(order, ['retrying-batch', 'other-batch', 'retrying-batch'])
	assert.equal(clock.activeTimers, 0)
})

test('queue wait counts toward stage but each 120s page timer starts only after permit grant', async () => {
	const clock = new FakeClock()
	const operations = []
	let calls = 0
	const client = clientWithTransport(() => {
		calls += 1
		return new Promise((resolve) => operations.push(resolve))
	}, clock, 1)
	const first = client.parsePages([markedPage(1, 1651)])
	const second = client.parsePages([markedPage(1, 1652)])
	await flushUntil(() => operations.length === 1)
	clock.advance(119000)
	operations[0](jsonResponse())
	assert.equal((await first).pages.length, 1)
	await flushUntil(() => operations.length === 2)
	assert.equal(calls, 2)
	clock.advance(119000)
	operations[1](jsonResponse())
	assert.equal((await second).pages.length, 1)
	assert.equal(clock.time, 238000)
	assert.equal(clock.activeTimers, 0)
})

test('queued caller and stage cancellation unlink waiters without ghost dispatch', async () => {
	for (const control of ['caller', 'stage']) {
		const clock = new FakeClock()
		const activeController = new AbortController()
		const queuedController = new AbortController()
		let calls = 0
		const client = clientWithTransport((_endpoint, request) => {
			calls += 1
			return new Promise((_resolve, reject) => {
				EventTarget.prototype.addEventListener.call(request.signal, 'abort', () => {
					reject(new Error('queued-control-cancelled'))
				}, { once: true })
			})
		}, clock, 1)
		const active = client.parsePages([markedPage(1, control === 'caller' ? 1701 : 1702)], {
			signal: activeController.signal,
		})
		const queued = client.parsePages([markedPage(1, control === 'caller' ? 1703 : 1704)], {
			signal: queuedController.signal,
		})
		await flushUntil(() => calls === 1)
		if (control === 'caller') {
			queuedController.abort('queued-caller')
			await assert.rejects(queued, (error) => error.code === 'ABORT_ERR')
			activeController.abort('active-cleanup')
			await assert.rejects(active, (error) => error.code === 'ABORT_ERR')
		} else {
			clock.advance(420000)
			await Promise.all([
				assert.rejects(active, (error) => error.code === 'OCR_STAGE_DEADLINE_EXCEEDED'),
				assert.rejects(queued, (error) => error.code === 'OCR_STAGE_DEADLINE_EXCEEDED'),
			])
		}
		await flushMicrotasks()
		assert.equal(calls, 1)
		assert.equal(clock.activeTimers, 0)
	}
})

test('permit release is exact once across late promise events, sync throw, and normalize failure', async () => {
	const raceClock = new FakeClock()
	const firstController = new AbortController()
	const operations = []
	const callFiles = []
	const raceClient = clientWithTransport((_endpoint, request) => {
		callFiles.push(JSON.parse(request.body).file)
		return new Promise((resolve, reject) => operations.push({ resolve, reject }))
	}, raceClock, 1)
	const first = raceClient.parsePages([markedPage(1, 1751)], { signal: firstController.signal })
	const second = raceClient.parsePages([markedPage(1, 1752)])
	const third = raceClient.parsePages([markedPage(1, 1753)])
	await flushUntil(() => operations.length === 1)
	firstController.abort('release-first-slot')
	await assert.rejects(first, (error) => error.code === 'ABORT_ERR')
	await flushUntil(() => operations.length === 2)
	operations[0].resolve(jsonResponse())
	operations[0].reject(new Error('late-double-reject'))
	operations[0].resolve(jsonResponse())
	await flushMicrotasks()
	assert.equal(callFiles.length, 2)
	operations[1].resolve(jsonResponse())
	assert.equal((await second).pages.length, 1)
	await flushUntil(() => operations.length === 3)
	operations[2].resolve(jsonResponse())
	assert.equal((await third).pages.length, 1)
	assert.equal(callFiles.length, 3)
	assert.equal(raceClock.activeTimers, 0)

	const recoveryClock = createImmediateBackoffClock()
	let mode = 'throw'
	let recoveryCalls = 0
	const recoveryClient = clientWithTransport(() => {
		recoveryCalls += 1
		if (mode === 'throw') throw new Error('sync-transport-failure')
		if (mode === 'invalid') return jsonResponse({})
		return jsonResponse()
	}, recoveryClock, 1)
	await assert.rejects(
		recoveryClient.parsePages([markedPage(1, 1761)]),
		(error) => error.code === 'GLM_OCR_NETWORK_ERROR'
	)
	assert.equal(recoveryCalls, 2)
	mode = 'invalid'
	await assert.rejects(
		recoveryClient.parsePages([markedPage(1, 1762)]),
		(error) => error.code === 'GLM_OCR_RESPONSE_INVALID'
	)
	assert.equal(recoveryCalls, 3)
	mode = 'success'
	assert.equal((await recoveryClient.parsePages([markedPage(1, 1763)])).pages.length, 1)
	assert.equal(recoveryCalls, 4)
	assert.equal(recoveryClock.activeTimers, 0)
})

test('a permanent page failure cancels only its batch, waits sibling teardown, and exposes no partial pages', async () => {
	const clock = new FakeClock()
	const batchAFiles = new Set([1801, 1802, 1803, 1804, 1805].map(
		(marker, index) => markedPage(index + 1, marker).jpegDataUri
	))
	const firstFile = markedPage(1, 1801).jpegDataUri
	const batchBFile = markedPage(1, 1810).jpegDataUri
	let batchACalls = 0
	let batchBCalls = 0
	const siblingSignals = []
	const lateSiblingOperations = []
	const client = clientWithTransport((_endpoint, request) => {
		const file = JSON.parse(request.body).file
		if (file === batchBFile) {
			batchBCalls += 1
			return Promise.resolve(jsonResponse())
		}
		assert.equal(batchAFiles.has(file), true)
		batchACalls += 1
		if (file === firstFile) {
			return Promise.resolve({ status: 400, rawHeaders: [], json: async () => null })
		}
		siblingSignals.push(request.signal)
		return new Promise((resolve, reject) => {
			lateSiblingOperations.push({ resolve, reject })
		})
	}, clock)
	const failed = client.parsePages(
		[1801, 1802, 1803, 1804, 1805].map((marker, index) => markedPage(index + 1, marker))
	)
	const unaffected = client.parsePages([markedPage(1, 1810)])
	await assert.rejects(failed, (error) => {
		assert.equal(error.code, 'GLM_OCR_BAD_REQUEST')
		assert.deepEqual(Object.keys(error), ['code', 'class', 'stage', 'retryable', 'safeMessageKey'])
		assert.equal('pages' in error, false)
		assert.equal('results' in error, false)
		return true
	})
	assert.equal((await unaffected).pages.length, 1)
	assert.equal(batchACalls, 3)
	assert.equal(batchBCalls, 1)
	assert.equal(siblingSignals.length, 2)
	assert.equal(siblingSignals.every((signal) => signal.aborted), true)
	lateSiblingOperations[0].resolve(jsonResponse())
	lateSiblingOperations[1].reject(new Error('ignored-late-peer-rejection'))
	await flushMicrotasks()
	assert.equal(batchACalls, 3)
	assert.equal(batchBCalls, 1)
	assert.equal(clock.activeTimers, 0)
})

test('default HTTPS final failure destroys same-batch siblings while another batch continues', async () => {
	const clock = new FakeClock()
	const records = []
	const requestFactory = (_options, callback) => {
		const request = new MockRequest()
		records.push({ request, callback, socket: null, response: null })
		return request
	}
	const client = createGlmOcrClient({
		__testing: {
			apiKey: FAKE_TOKEN,
			requestFactory,
			clock: clock.hooks,
			pageConcurrency: 3,
		},
	})
	const batchAPages = [1821, 1822, 1823, 1824].map(
		(marker, index) => markedPage(index + 1, marker)
	)
	const batchAFiles = new Set(batchAPages.map((entry) => entry.jpegDataUri))
	const batchBPage = markedPage(1, 1830)
	const failed = client.parsePages(batchAPages)
	const unaffected = client.parsePages([batchBPage])
	assert.equal(records.length, 3)
	for (const record of records) {
		record.socket = new MockSocket()
		record.request.emit('socket', record.socket)
		record.socket.emit('secureConnect')
	}
	const initial = records.slice()
	const responseBody = Buffer.from(JSON.stringify(successEnvelope()))
	for (let index = 1; index < initial.length; index += 1) {
		const response = new MockResponse(200, jsonRawHeaders(responseBody.length))
		initial[index].response = response
		initial[index].callback(response)
		response.emit('data', responseBody.subarray(0, 10))
	}
	const rejectedResponse = new MockResponse(400, [])
	initial[0].response = rejectedResponse
	initial[0].callback(rejectedResponse)

	await assert.rejects(failed, (error) => {
		assert.equal(error.code, 'GLM_OCR_BAD_REQUEST')
		assert.equal('pages' in error, false)
		assert.equal('results' in error, false)
		for (const record of initial.slice(1)) {
			assert.equal(record.request.destroyed, true)
			assert.equal(record.socket.destroyed, true)
			assert.equal(record.response.destroyed, true)
		}
		return true
	})
	await flushUntil(() => records.length === 4)
	const other = records[3]
	assert.equal(batchAFiles.has(JSON.parse(other.request.body).file), false)
	assert.equal(JSON.parse(other.request.body).file, batchBPage.jpegDataUri)
	other.socket = new MockSocket()
	other.request.emit('socket', other.socket)
	other.socket.emit('secureConnect')
	other.response = new MockResponse(200, jsonRawHeaders(responseBody.length))
	other.callback(other.response)
	emitCompleteResponse(other.response, [responseBody])
	assert.equal((await unaffected).pages.length, 1)
	assert.equal(records.filter((record) => batchAFiles.has(JSON.parse(record.request.body).file)).length, 3)
	assert.equal(clock.activeTimers, 0)
})

test('post-attempt retry failures fan out safely while another batch on the same client completes', async () => {
	for (const mode of ['wall-clock', 'backoff-setup', 'monotonic-rollback']) {
		const baseClock = new FakeClock()
		let rollbackArmed = false
		let rollbackReads = 0
		const hooks = {
			...baseClock.hooks,
			now: () => {
				if (!rollbackArmed) return baseClock.time
				rollbackReads += 1
				if (rollbackReads === 1) return 100
				if (rollbackReads === 2) return 50
				return 100
			},
			wallNow: () => {
				if (mode === 'wall-clock') throw new Error('private-wall-fanout')
				return baseClock.wallTime
			},
			setTimeout: (callback, delay) => {
				if (mode === 'backoff-setup' && delay === 1000) {
					throw new Error('private-backoff-fanout')
				}
				return baseClock.hooks.setTimeout(callback, delay)
			},
		}
		const batchAPages = [1901, 1902, 1903, 1904, 1905].map(
			(marker, index) => markedPage(index + 1, marker)
		)
		const firstFile = batchAPages[0].jpegDataUri
		const batchAFiles = new Set(batchAPages.map((entry) => entry.jpegDataUri))
		const batchBFile = markedPage(1, 1910).jpegDataUri
		let batchACalls = 0
		let batchBCalls = 0
		let siblingAborts = 0
		const client = clientWithTransport((_endpoint, request) => {
			const file = JSON.parse(request.body).file
			if (file === batchBFile) {
				batchBCalls += 1
				return Promise.resolve(jsonResponse())
			}
			assert.equal(batchAFiles.has(file), true)
			batchACalls += 1
			if (file === firstFile) {
				const response = mode === 'wall-clock'
					? {
						status: 429,
						rawHeaders: ['Retry-After', new Date(baseClock.wallTime + 5000).toUTCString()],
						json: async () => null,
					}
					: { status: 503, rawHeaders: [], json: async () => null }
				return Promise.resolve().then(() => {
					if (mode === 'monotonic-rollback') rollbackArmed = true
					return response
				})
			}
			return new Promise((_resolve, reject) => {
				EventTarget.prototype.addEventListener.call(request.signal, 'abort', () => {
					siblingAborts += 1
					reject(new Error('post-attempt-peer-cancel'))
				}, { once: true })
			})
		}, hooks)
		const failed = client.parsePages(batchAPages)
		const unaffected = client.parsePages([markedPage(1, 1910)])
		await assert.rejects(failed, (error) => {
			assert.equal(error.code, 'GLM_OCR_CLIENT_ERROR')
			const visible = `${JSON.stringify(error)} ${error.stack}`
			assert.equal(visible.includes('private-wall-fanout'), false)
			assert.equal(visible.includes('private-backoff-fanout'), false)
			assert.equal('pages' in error, false)
			assert.equal('results' in error, false)
			return true
		})
		assert.equal((await unaffected).pages.length, 1)
		assert.equal(batchACalls, 3)
		assert.equal(batchBCalls, 1)
		assert.equal(siblingAborts, 2)
		assert.equal(baseClock.activeTimers, 0)
	}
})

test('all concurrent page successes keep first-event precedence over late caller or stage control', async () => {
	for (const lateControl of ['caller', 'stage']) {
		const clock = new FakeClock()
		const controller = new AbortController()
		const records = []
		const requestFactory = (_options, callback) => {
			const request = new MockRequest()
			records.push({ request, callback })
			return request
		}
		const client = createGlmOcrClient({
			__testing: {
				apiKey: FAKE_TOKEN,
				requestFactory,
				clock: clock.hooks,
				pageConcurrency: 3,
			},
		})
		const pending = client.parsePages(
			[markedPage(1, 2001), markedPage(2, 2002), markedPage(3, 2003)],
			{ signal: controller.signal }
		)
		assert.equal(records.length, 3)
		const body = Buffer.from(JSON.stringify(successEnvelope()))
		for (const record of records) {
			const socket = new MockSocket()
			record.request.emit('socket', socket)
			socket.emit('secureConnect')
			const response = new MockResponse(200, jsonRawHeaders(body.length))
			record.callback(response)
			emitCompleteResponse(response, [body])
		}
		if (lateControl === 'caller') controller.abort('late-after-all-page-success')
		else clock.advance(420000)
		const result = await pending
		assert.deepEqual(result.pages.map((entry) => entry.pageNumber), [1, 2, 3])
		assert.equal(clock.activeTimers, 0)
	}

	const clock = new FakeClock()
	const controller = new AbortController()
	const operations = []
	const client = clientWithTransport(() => new Promise((resolve) => operations.push(resolve)), clock)
	const pending = client.parsePages(
		[markedPage(1, 2011), markedPage(2, 2012), markedPage(3, 2013)],
		{ signal: controller.signal }
	)
	await flushUntil(() => operations.length === 3)
	operations[0](jsonResponse())
	await flushMicrotasks()
	controller.abort('control-before-all-pages-finish')
	operations[1](jsonResponse())
	operations[2](jsonResponse())
	await assert.rejects(pending, (error) => {
		assert.equal(error.code, 'ABORT_ERR')
		assert.equal('pages' in error, false)
		assert.equal('results' in error, false)
		return true
	})
	assert.equal(clock.activeTimers, 0)
})

test('native signal own method pollution cannot bypass captured cancellation methods', async () => {
	const clock = new FakeClock()
	const controller = new AbortController()
	Object.defineProperty(controller.signal, 'addEventListener', {
		value: () => { throw new Error('private-own-add') },
	})
	Object.defineProperty(controller.signal, 'removeEventListener', {
		value: () => { throw new Error('private-own-remove') },
	})
	const client = clientWithTransport(() => new Promise(() => {}), clock)
	const pending = client.parsePages([page(1)], { signal: controller.signal })
	controller.abort('private-signal-reason')
	await assert.rejects(pending, (error) => {
		assert.equal(error.code, 'ABORT_ERR')
		const visible = `${JSON.stringify(error)} ${error.stack}`
		assert.equal(visible.includes('private-own-add'), false)
		assert.equal(visible.includes('private-own-remove'), false)
		return true
	})
	assert.equal(clock.activeTimers, 0)
})

test('one shared monotonic guard rejects rollback across preflight, transport, and HTTPS components', async () => {
	let controlledOperationResolved = false
	let controlledPostCalls = 0
	let controlledTransportCalls = 0
	const controlledClock = {
		now: () => {
			if (controlledOperationResolved) {
				controlledPostCalls += 1
				return controlledPostCalls === 1 ? 100 : 50
			}
			return 0
		},
		wallNow: () => Date.UTC(2026, 0, 1),
		setTimeout: () => 1,
		clearTimeout: () => {},
	}
	const controlled = clientWithTransport(
		async () => Promise.resolve(jsonResponse()).then((value) => {
			controlledTransportCalls += 1
			controlledOperationResolved = true
			return value
		}),
		controlledClock,
		1
	)
	await assert.rejects(
		controlled.parsePages([page(1), page(2)]),
		(error) => error.code === 'GLM_OCR_CLIENT_ERROR'
	)
	assert.equal(controlledTransportCalls, 1)

	let httpsTime = 0
	const request = new MockRequest()
	request.end = function end(body) {
		this.endCalls += 1
		this.body = body
		httpsTime = 50
	}
	const httpsClock = {
		now: () => httpsTime,
		wallNow: () => Date.UTC(2026, 0, 1),
		setTimeout: () => 1,
		clearTimeout: () => {},
	}
	const httpsClient = createGlmOcrClient({
		__testing: {
			apiKey: FAKE_TOKEN,
			requestFactory: () => {
				httpsTime = 100
				return request
			},
			clock: httpsClock,
		},
	})
	await assert.rejects(
		httpsClient.parsePages([page(1)]),
		(error) => error.code === 'GLM_OCR_CLIENT_ERROR'
	)
})

test('synchronous deadline crossings choose earliest absolute due and stage wins exact ties', async () => {
	for (const scenario of [
		{ increments: [119000, 119000, 42000], finalTime: 421000, code: 'GLM_OCR_PAGE_TIMEOUT' },
		{ increments: [100000, 100000, 100000], finalTime: 421000, code: 'OCR_STAGE_DEADLINE_EXCEEDED' },
	]) {
		const clock = new FakeClock()
		let calls = 0
		const client = clientWithTransport(async () => {
			calls += 1
			if (calls <= 3) {
				clock.setTime(clock.time + scenario.increments[calls - 1])
				return jsonResponse()
			}
			clock.setTime(scenario.finalTime)
			return jsonResponse()
		}, clock, 1)
		await assert.rejects(
			client.parsePages([page(1), page(2), page(3), page(4)]),
			(error) => error.code === scenario.code
		)
		assert.equal(calls, 4)
		assert.equal(clock.activeTimers, 0)
	}

	const harness = createHttpsHarness({ pageConcurrency: 1 })
	const pending = harness.client.parsePages([page(1), page(2), page(3), page(4), page(5)])
	for (const increment of [100000, 100000, 100000, 105000]) {
		const socket = harness.freshSocket()
		socket.emit('secureConnect')
		harness.clock.setTime(harness.clock.time + increment)
		const body = Buffer.from(JSON.stringify(successEnvelope()))
		const response = new MockResponse(200, jsonRawHeaders(body.length))
		harness.respond(response)
		emitCompleteResponse(response, [body])
		await flushMicrotasks()
	}
	assert.equal(harness.requestFactoryCalls, 5)
	harness.clock.advance(15000)
	await assert.rejects(pending, (error) => error.code === 'OCR_STAGE_DEADLINE_EXCEEDED')
	assert.equal(harness.clock.activeTimers, 0)
})

test('delayed timer and network callbacks still choose the earliest absolute attempt deadline', async () => {
	const controlledClock = new FakeClock()
	let controlledCalls = 0
	const controlled = clientWithTransport(() => {
		controlledCalls += 1
		return new Promise(() => {})
	}, controlledClock, 1)
	const controlledPending = controlled.parsePages([markedPage(1, 2051)])
	const controlledPageTimer = [...controlledClock.timers.entries()].find(
		([, timer]) => timer.due === 120000
	)
	assert.ok(controlledPageTimer)
	controlledClock.setTime(421000)
	controlledClock.timers.delete(controlledPageTimer[0])
	controlledPageTimer[1].callback()
	await assert.rejects(
		controlledPending,
		(error) => error.code === 'GLM_OCR_PAGE_TIMEOUT'
	)
	assert.equal(controlledCalls, 1)
	assert.equal(controlledClock.activeTimers, 0)

	const factoryClock = new FakeClock()
	let factoryCalls = 0
	const factoryClient = createGlmOcrClient({
		__testing: {
			apiKey: FAKE_TOKEN,
			requestFactory: () => {
				factoryCalls += 1
				factoryClock.setTime(421000)
				throw new Error('late-request-factory-failure')
			},
			clock: factoryClock.hooks,
		},
	})
	await assert.rejects(
		factoryClient.parsePages([markedPage(1, 2052)]),
		(error) => error.code === 'GLM_OCR_CONNECT_TIMEOUT'
	)
	assert.equal(factoryCalls, 1)
	assert.equal(factoryClock.activeTimers, 0)

	const bodyHarness = createHttpsHarness()
	const bodyPending = bodyHarness.client.parsePages([markedPage(1, 2053)])
	const bodySocket = bodyHarness.freshSocket()
	bodySocket.emit('secureConnect')
	const body = Buffer.from(JSON.stringify(successEnvelope()))
	const response = new MockResponse(200, jsonRawHeaders(body.length))
	bodyHarness.respond(response)
	response.emit('data', body.subarray(0, 10))
	bodyHarness.clock.setTime(421000)
	response.emit('error', new Error('late-body-network-failure'))
	await assert.rejects(
		bodyPending,
		(error) => error.code === 'GLM_OCR_PAGE_TIMEOUT'
	)
	assert.equal(bodyHarness.requestFactoryCalls, 1)
	assert.equal(bodyHarness.clock.activeTimers, 0)
})

test('snapshots exact page values synchronously and restores input order', async () => {
	let releaseFirst
	const requests = []
	const originalSecond = jpegDataUri(Buffer.from([0xff, 0xd8, 0x02, 0x03, 0xff, 0xd9]))
	const pages = [page(1), page(2, originalSecond)]
	const client = clientWithTransport(async (_endpoint, request) => {
		requests.push(JSON.parse(request.body).file)
		if (requests.length === 1) await new Promise((resolve) => { releaseFirst = resolve })
		return jsonResponse()
	})

	const pending = client.parsePages(pages)
	pages[1].jpegDataUri = 'https://example.invalid/replaced.jpg'
	pages.reverse()
	releaseFirst()
	const result = await pending

	assert.equal(requests[1], originalSecond)
	assert.deepEqual(result.pages.map((item) => item.pageNumber), [1, 2])
})

test('rejects non-canonical page containers, page objects, numbers, and alternate input types before network', () => {
	let calls = 0
	const client = clientWithTransport(async () => {
		calls += 1
		return jsonResponse()
	})
	const inherited = Object.create({ pageNumber: 1, jpegDataUri: jpegDataUri() })
	const getterPage = { pageNumber: 1 }
	Object.defineProperty(getterPage, 'jpegDataUri', { get: () => jpegDataUri(), enumerable: true })
	const sparse = new Array(1)

	for (const value of [
		[],
		sparse,
		[page(2)],
		[{ ...page(1), extra: true }],
		[inherited],
		[getterPage],
		[{ pageNumber: 1, jpegDataUri: Buffer.from('jpeg') }],
		[{ pageNumber: 1, jpegDataUri: { url: 'https://example.invalid/a.jpg' } }],
	]) {
		assert.throws(
			() => client.parsePages(value),
			(error) => error.code === 'GLM_OCR_BAD_REQUEST'
		)
	}
	assert.equal(calls, 0)
})

test('maps public reflection and Proxy traps to safe closed errors', async () => {
	const sensitive = ['private', 'proxy', 'payload'].join('-')
	const trap = () => { throw new Error(sensitive) }
	function safe(error, code) {
		assert.equal(error.code, code)
		assert.deepEqual(Object.keys(error), ['code', 'class', 'stage', 'retryable', 'safeMessageKey'])
		assert.equal(`${JSON.stringify(error)} ${error.stack}`.includes(sensitive), false)
		assert.equal('cause' in error, false)
		return true
	}

	assert.throws(
		() => createGlmOcrClient(new Proxy({}, { getPrototypeOf: trap })),
		(error) => safe(error, 'GLM_OCR_CLIENT_ERROR')
	)

	let calls = 0
	const client = clientWithTransport(async () => {
		calls += 1
		return jsonResponse()
	})
	const trappedPages = new Proxy([page(1)], { ownKeys: trap })
	const trappedPage = new Proxy(page(1), { getOwnPropertyDescriptor: trap })
	const trappedOptions = new Proxy({}, { ownKeys: trap })
	const proxiedSignal = new Proxy(new AbortController().signal, {})
	const revokedSignal = Proxy.revocable(new AbortController().signal, {})
	revokedSignal.revoke()
	for (const invoke of [
		() => client.parsePages(trappedPages),
		() => client.parsePages([trappedPage]),
		() => client.parsePages([page(1)], trappedOptions),
		() => client.parsePages([page(1)], { signal: proxiedSignal }),
		() => client.parsePages([page(1)], { signal: revokedSignal.proxy }),
	]) {
		assert.throws(invoke, (error) => safe(error, 'GLM_OCR_BAD_REQUEST'))
	}
	assert.equal(calls, 0)

	const rawTop = new Proxy(successEnvelope(), { getPrototypeOf: trap })
	const rawDataInfo = successEnvelope()
	rawDataInfo.data_info = new Proxy(rawDataInfo.data_info, { ownKeys: trap })
	const rawRegion = successEnvelope()
	rawRegion.layout_details[0][0] = new Proxy(rawRegion.layout_details[0][0], { getOwnPropertyDescriptor: trap })
	const responseProxy = new Proxy({}, {
		get(_target, key) {
			if (key === 'then') return undefined
			return trap()
		},
	})
	for (const transport of [
		async () => jsonResponse(rawTop),
		async () => jsonResponse(rawDataInfo),
		async () => jsonResponse(rawRegion),
		async () => responseProxy,
	]) {
		await assert.rejects(
			clientWithTransport(transport).parsePages([page(1)]),
			(error) => safe(error, 'GLM_OCR_RESPONSE_INVALID')
		)
	}
})

test('rejects transparent and revoked Proxies at every public input and response boundary', async () => {
	const sentinel = 'transparent-proxy-private-target'
	const transparent = (value) => new Proxy(value, {})
	const revoked = (value) => {
		const holder = Proxy.revocable(value, {})
		holder.revoke()
		return holder.proxy
	}
	function safe(error, code) {
		assert.equal(error.code, code)
		assert.deepEqual(Object.keys(error), ['code', 'class', 'stage', 'retryable', 'safeMessageKey'])
		assert.equal(`${JSON.stringify(error)} ${error.stack}`.includes(sentinel), false)
		return true
	}

	for (const wrap of [transparent, revoked]) {
		const configTransport = async () => jsonResponse()
		assert.throws(
			() => createGlmOcrClient(wrap({
				__testing: { apiKey: sentinel, transport: configTransport },
			})),
			(error) => safe(error, 'GLM_OCR_CLIENT_ERROR')
		)
		assert.throws(
			() => createGlmOcrClient({
				__testing: wrap({ apiKey: sentinel, transport: configTransport }),
			}),
			(error) => safe(error, 'GLM_OCR_CLIENT_ERROR')
		)

		let inputCalls = 0
		const inputClient = clientWithTransport(async () => {
			inputCalls += 1
			return jsonResponse()
		})
		const nativeSignal = new AbortController().signal
		for (const invoke of [
			() => inputClient.parsePages(wrap([page(1)])),
			() => inputClient.parsePages([wrap(page(1))]),
			() => inputClient.parsePages([page(1)], wrap({})),
			() => inputClient.parsePages([page(1)], { signal: wrap(nativeSignal) }),
		]) {
			assert.throws(invoke, (error) => safe(error, 'GLM_OCR_BAD_REQUEST'))
		}
		assert.equal(inputCalls, 0)
	}

	const nestedBuilders = [
		(raw, wrap) => { raw.id = sentinel; return wrap({ ...raw }) },
		(raw, wrap) => { raw.data_info = wrap({ ...raw.data_info }); return raw },
		(raw, wrap) => { raw.data_info.pages = wrap(raw.data_info.pages); return raw },
		(raw, wrap) => { raw.data_info.pages[0] = wrap({ ...raw.data_info.pages[0] }); return raw },
		(raw, wrap) => { raw.layout_details = wrap(raw.layout_details); return raw },
		(raw, wrap) => { raw.layout_details[0] = wrap(raw.layout_details[0]); return raw },
		(raw, wrap) => {
			raw.layout_details[0][0].content = sentinel
			raw.layout_details[0][0] = wrap({ ...raw.layout_details[0][0] })
			return raw
		},
		(raw, wrap) => { raw.layout_details[0][0].bbox_2d = wrap(raw.layout_details[0][0].bbox_2d); return raw },
		(raw, wrap) => { raw.usage = wrap({ ...raw.usage }); return raw },
		(raw, wrap) => {
			raw.usage.prompt_tokens_details = wrap({ ...raw.usage.prompt_tokens_details })
			return raw
		},
		(raw, wrap) => { raw.layout_visualization = wrap(raw.layout_visualization); return raw },
	]
	let responseCalls = 0
	for (const wrap of [transparent, revoked]) {
		const responseWrapper = wrap(jsonResponse())
		await assert.rejects(
			clientWithTransport(() => {
				responseCalls += 1
				return responseWrapper
			}).parsePages([page(1)]),
			(error) => safe(error, 'GLM_OCR_RESPONSE_INVALID')
		)
		const promiseWrapper = wrap(Promise.resolve(jsonResponse()))
		await assert.rejects(
			clientWithTransport(() => {
				responseCalls += 1
				return promiseWrapper
			}).parsePages([page(1)]),
			(error) => safe(error, 'GLM_OCR_RESPONSE_INVALID')
		)

		for (const build of nestedBuilders) {
			const raw = build(successEnvelope(), wrap)
			await assert.rejects(
				clientWithTransport(() => {
					responseCalls += 1
					return {
						status: 200,
						json: async () => raw,
					}
				}).parsePages([page(1)]),
				(error) => safe(error, 'GLM_OCR_RESPONSE_INVALID')
			)
		}
	}
	assert.equal(responseCalls, 26)
})

test('rejects transparent and revoked Proxies across lower HTTPS and decompressor seams', async () => {
	const sentinel = 'lower-seam-private-sentinel'
	const transparent = (value) => new Proxy(value, {})
	const revoked = (value) => {
		const holder = Proxy.revocable(value, {})
		holder.revoke()
		return holder.proxy
	}
	function safe(error, code) {
		assert.equal(error.code, code)
		assert.equal(`${JSON.stringify(error)} ${error.stack}`.includes(sentinel), false)
		return true
	}

	for (const wrap of [transparent, revoked]) {
		const baseClock = new FakeClock()
		for (const hookConfig of [
			{ apiKey: FAKE_TOKEN, transport: wrap(async () => jsonResponse()) },
			{ apiKey: FAKE_TOKEN, requestFactory: wrap(() => new MockRequest()), clock: baseClock.hooks },
			{
				apiKey: FAKE_TOKEN,
				requestFactory: () => new MockRequest(),
				clock: baseClock.hooks,
				decompressorFactory: wrap(() => null),
			},
			{
				apiKey: FAKE_TOKEN,
				requestFactory: () => new MockRequest(),
				clock: wrap(baseClock.hooks),
			},
			{
				apiKey: FAKE_TOKEN,
				requestFactory: () => new MockRequest(),
				clock: {
					now: wrap(() => 0),
					wallNow: () => Date.UTC(2026, 0, 1),
					setTimeout: () => 1,
					clearTimeout: () => {},
				},
			},
			{
				apiKey: FAKE_TOKEN,
				requestFactory: () => new MockRequest(),
				clock: {
					now: () => 0,
					wallNow: wrap(() => Date.UTC(2026, 0, 1)),
					setTimeout: () => 1,
					clearTimeout: () => {},
				},
			},
		]) {
			assert.throws(
				() => createGlmOcrClient({ __testing: hookConfig }),
				(error) => safe(error, 'GLM_OCR_CLIENT_ERROR')
			)
		}

		const requestClock = new FakeClock()
		const proxiedRequest = wrap(Object.assign(new MockRequest(), { sentinel }))
		const requestClient = createGlmOcrClient({
			__testing: {
				apiKey: FAKE_TOKEN,
				requestFactory: () => proxiedRequest,
				clock: requestClock.hooks,
			},
		})
		await assert.rejects(
			requestClient.parsePages([page(1)]),
			(error) => safe(error, 'GLM_OCR_CLIENT_ERROR')
		)

		const socketHarness = createHttpsHarness()
		const socketPending = socketHarness.client.parsePages([page(1)])
		const proxiedSocket = wrap(Object.assign(new MockSocket(), { sentinel }))
		socketHarness.request.emit('socket', proxiedSocket)
		await assert.rejects(socketPending, (error) => safe(error, 'GLM_OCR_CLIENT_ERROR'))

		const responseHarness = createHttpsHarness()
		const responsePending = responseHarness.client.parsePages([page(1)])
		const responseSocket = responseHarness.freshSocket()
		responseSocket.emit('secureConnect')
		const rawBody = Buffer.from(JSON.stringify(successEnvelope()))
		const proxiedResponse = wrap(Object.assign(
			new MockResponse(200, jsonRawHeaders(rawBody.length)),
			{ sentinel }
		))
		responseHarness.respond(proxiedResponse)
		await assert.rejects(
			responsePending,
			(error) => safe(error, 'GLM_OCR_RESPONSE_INVALID')
		)

		const headerHarness = createHttpsHarness()
		const headerPending = headerHarness.client.parsePages([page(1)])
		const headerSocket = headerHarness.freshSocket()
		headerSocket.emit('secureConnect')
		const headerResponse = new MockResponse(200, wrap(jsonRawHeaders(rawBody.length)))
		headerHarness.respond(headerResponse)
		await assert.rejects(headerPending, (error) => safe(error, 'GLM_OCR_RESPONSE_INVALID'))

		class ProxyDecoder extends EventEmitter {
			constructor(decodedChunk) {
				super()
				this.decodedChunk = decodedChunk
				this.bytesWritten = 0
			}
			write(chunk) {
				this.bytesWritten += chunk.byteLength
				this.emit('data', this.decodedChunk)
				return true
			}
			end() { this.emit('end') }
			destroy() { this.emit('close') }
		}

		const decoderTarget = Object.assign(new ProxyDecoder(rawBody), { sentinel })
		const decoderHarness = createHttpsHarness({ decompressorFactory: () => wrap(decoderTarget) })
		const decoderPending = decoderHarness.client.parsePages([page(1)])
		const decoderSocket = decoderHarness.freshSocket()
		decoderSocket.emit('secureConnect')
		const wire = Buffer.from('wire')
		const decoderResponse = new MockResponse(200, jsonRawHeaders(wire.length, { contentEncoding: 'gzip' }))
		decoderHarness.respond(decoderResponse)
		await assert.rejects(decoderPending, (error) => safe(error, 'GLM_OCR_RESPONSE_INVALID'))

		const wireHarness = createHttpsHarness()
		const wirePending = wireHarness.client.parsePages([page(1)])
		const wireSocket = wireHarness.freshSocket()
		wireSocket.emit('secureConnect')
		const wireResponse = new MockResponse(200, jsonRawHeaders(rawBody.length))
		wireHarness.respond(wireResponse)
		wireResponse.emit('data', wrap(Buffer.from(rawBody)))
		await assert.rejects(wirePending, (error) => safe(error, 'GLM_OCR_RESPONSE_INVALID'))

		const decodedTarget = wrap(Buffer.from(rawBody))
		const decodedHarness = createHttpsHarness({
			decompressorFactory: () => new ProxyDecoder(decodedTarget),
		})
		const decodedPending = decodedHarness.client.parsePages([page(1)])
		const decodedSocket = decodedHarness.freshSocket()
		decodedSocket.emit('secureConnect')
		const decodedResponse = new MockResponse(200, jsonRawHeaders(wire.length, { contentEncoding: 'gzip' }))
		decodedHarness.respond(decodedResponse)
		decodedResponse.emit('data', wire)
		await assert.rejects(decodedPending, (error) => safe(error, 'GLM_OCR_RESPONSE_INVALID'))
	}
})

test('rejects more than 100 pages and any non-dense continuous page numbering locally', () => {
	let calls = 0
	const client = clientWithTransport(async () => {
		calls += 1
		return jsonResponse()
	})
	const tooMany = Array.from({ length: 101 }, (_, index) => page(index + 1))
	assert.throws(() => client.parsePages(tooMany), (error) => error.code === 'GLM_OCR_BAD_REQUEST')
	assert.throws(
		() => client.parsePages([page(1), page(3)]),
		(error) => error.code === 'GLM_OCR_BAD_REQUEST'
	)
	assert.equal(calls, 0)
})

test('accepts only the exact canonical JPEG data URI grammar and significant pad bits', async () => {
	let calls = 0
	const client = clientWithTransport(async () => {
		calls += 1
		return jsonResponse()
	})
	const canonical = jpegDataUri()
	await client.parsePages([page(1, canonical)])
	assert.equal(calls, 1)

	for (const invalid of [
		canonical.replace('data:image/jpeg', 'data:image/jpg'),
		canonical.replace('base64,', 'base64,\n'),
		canonical.slice(0, -1),
		`${PREFIX}/9j/2R==`,
		`${PREFIX}${Buffer.from([0x00, 0xd8, 0x01, 0x02, 0xff, 0xd9]).toString('base64')}`,
		`${PREFIX}${Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0x00]).toString('base64')}`,
		'https://example.invalid/page.jpg',
	]) {
		assert.throws(
			() => client.parsePages([page(1, invalid)]),
			(error) => error.code === 'GLM_OCR_BAD_REQUEST'
		)
	}
	assert.equal(calls, 1)
})

test('checks JPEG EOI across base64 tail quartets for every decoded-length modulo', async () => {
	let calls = 0
	const client = clientWithTransport(async () => {
		calls += 1
		return jsonResponse()
	})
	function imageWithLength(length, validEoi = true) {
		const bytes = Buffer.alloc(length, 0x21)
		bytes[0] = 0xff
		bytes[1] = 0xd8
		bytes[length - 2] = 0xff
		bytes[length - 1] = validEoi ? 0xd9 : 0xd8
		return jpegDataUri(bytes)
	}

	for (const length of [6, 7, 8]) {
		assert.equal(length % 3, [0, 1, 2][length - 6])
		await client.parsePages([page(1, imageWithLength(length))])
	}
	assert.equal(calls, 3)
	assert.throws(
		() => client.parsePages([page(1, imageWithLength(7, false))]),
		(error) => error.code === 'GLM_OCR_BAD_REQUEST'
	)
	assert.equal(calls, 3)
})

test('enforces decoded JPEG bytes strictly below 9437184 with zero network at and above the cap', async () => {
	let calls = 0
	const client = clientWithTransport(async () => {
		calls += 1
		return jsonResponse()
	})
	function boundaryImage(size) {
		const bytes = Buffer.alloc(size)
		bytes[0] = 0xff
		bytes[1] = 0xd8
		bytes[size - 2] = 0xff
		bytes[size - 1] = 0xd9
		return jpegDataUri(bytes)
	}

	await client.parsePages([page(1, boundaryImage(PAGE_BYTE_CAP - 1))])
	assert.equal(calls, 1)
	for (const size of [PAGE_BYTE_CAP, PAGE_BYTE_CAP + 1]) {
		assert.throws(
			() => client.parsePages([page(1, boundaryImage(size))]),
			(error) => error.code === 'GLM_OCR_INPUT_TOO_LARGE'
		)
	}
	assert.equal(calls, 1)
})

test('fast-rejects far-oversized single and 100-page inputs before payload scan or network', () => {
	let calls = 0
	const client = clientWithTransport(async () => {
		calls += 1
		return jsonResponse()
	})
	const maximumCanonicalChars = 4 * Math.ceil((PAGE_BYTE_CAP - 1) / 3)
	const oversized = `${PREFIX}${'A'.repeat(maximumCanonicalChars + 4)}`
	const hundredPages = Array.from({ length: 100 }, (_, index) => page(index + 1, oversized))

	for (const pages of [[page(1, oversized)], hundredPages]) {
		assert.throws(
			() => client.parsePages(pages),
			(error) => error.code === 'GLM_OCR_INPUT_TOO_LARGE'
		)
	}
	assert.equal(calls, 0)
})

test('accepts the official response model case-insensitively and preserves only raw provider labels', async () => {
	for (const model of ['GLM-OCR', 'glm-ocr', 'GlM-OcR']) {
		for (const label of ['image', 'text', 'formula', 'table']) {
			const raw = successEnvelope(label)
			raw.model = model
			const result = await clientWithTransport(async () => jsonResponse(raw)).parsePages([page(1)])
			assert.equal(result.model, 'glm-ocr')
			assert.equal(result.pages[0].layoutDetails[0][0].label, label)
			assert.equal(
				result.pages[0].layoutDetails[0][0].content,
				label === 'image' ? '' : 'candidate-content'
			)
		}
	}

	for (const invalid of ['glm-ocr-v2', 'other-model', 'ＧＬＭ-OCR']) {
		const raw = successEnvelope()
		raw.model = invalid
		await assert.rejects(
			clientWithTransport(async () => jsonResponse(raw)).parsePages([page(1)]),
			(error) => error.code === 'GLM_OCR_RESPONSE_INVALID'
		)
	}
})

test('validates but never projects or follows provider image resource URLs', async () => {
	const providerResource = 'https://provider.invalid/private-crop-id'
	const raw = successEnvelope('image')
	raw.layout_details[0][0].content = providerResource
	let transportCalls = 0
	const result = await clientWithTransport(async (endpoint) => {
		transportCalls += 1
		assert.equal(endpoint, ENDPOINT)
		return jsonResponse(raw)
	}).parsePages([page(1)])

	assert.equal(transportCalls, 1)
	assert.equal(result.pages[0].layoutDetails[0][0].content, '')
	assert.equal(JSON.stringify(result).includes(providerResource), false)
})

test('validates then drops known unsafe metadata and returns a deeply frozen no-alias envelope', async () => {
	const raw = successEnvelope()
	const result = await clientWithTransport(async () => jsonResponse(raw)).parsePages([page(1)])
	const serialized = JSON.stringify(result)

	for (const discarded of [
		'discarded-task-id',
		'discarded-request-id',
		'discarded-markdown',
		'discarded-visualization',
		'prompt_tokens',
	]) assert.equal(serialized.includes(discarded), false)

	assert.equal(Object.isFrozen(result), true)
	assert.equal(Object.isFrozen(result.pages), true)
	assert.equal(Object.isFrozen(result.pages[0]), true)
	assert.equal(Object.isFrozen(result.pages[0].layoutDetails), true)
	assert.equal(Object.isFrozen(result.pages[0].layoutDetails[0][0]), true)
	assert.equal(Object.isFrozen(result.pages[0].layoutDetails[0][0].bbox_2d), true)
	assert.equal(Object.isFrozen(result.pages[0].dataInfo.pages[0]), true)

	raw.layout_details[0][0].content = 'mutated-after-return'
	raw.layout_details[0][0].bbox_2d[0] = 0.9
	raw.data_info.pages[0].width = 999
	assert.equal(result.pages[0].layoutDetails[0][0].content, 'candidate-content')
	assert.equal(result.pages[0].layoutDetails[0][0].bbox_2d[0], 0.1)
	assert.equal(result.pages[0].dataInfo.pages[0].width, 600)
})

test('rejects unknown or accessor fields throughout the success envelope', async () => {
	const variants = []
	const topExtra = successEnvelope()
	topExtra.extra = true
	variants.push(topExtra)
	const regionExtra = successEnvelope()
	regionExtra.layout_details[0][0].confidence = 1
	variants.push(regionExtra)
	const dataExtra = successEnvelope()
	dataExtra.data_info.pages[0].unit = 'px'
	variants.push(dataExtra)
	const usageExtra = successEnvelope()
	usageExtra.usage.provider_request = 'discarded'
	variants.push(usageExtra)
	const accessor = successEnvelope()
	Object.defineProperty(accessor, 'request_id', { get: () => 'hidden', enumerable: true })
	variants.push(accessor)

	for (const raw of variants) {
		await assert.rejects(
			clientWithTransport(async () => jsonResponse(raw)).parsePages([page(1)]),
			(error) => error.code === 'GLM_OCR_RESPONSE_INVALID'
		)
	}
})

test('rejects malformed region and metadata shapes without retaining the raw response', async () => {
	const mutators = [
		(raw) => { raw.id = '' },
		(raw) => { raw.created = Number.MAX_SAFE_INTEGER + 1 },
		(raw) => { raw.layout_visualization = [1] },
		(raw) => { raw.usage.prompt_tokens = -1 },
		(raw) => { raw.layout_details[0][0].label = 'paragraph' },
		(raw) => { raw.layout_details[0][0].bbox_2d = [0, 0, 2, 1] },
		(raw) => { raw.layout_details[0][0].bbox_2d = [0.5, 0.5, 0.5, 0.6] },
		(raw) => { raw.layout_details[0][0].bbox_2d = [0.7, 0.5, 0.5, 0.6] },
		(raw) => { raw.layout_details[0][0].bbox_2d = [0.1, 0.8, 0.5, 0.2] },
		(raw) => { raw.layout_details[0][0].width = 601 },
	]
	for (const mutate of mutators) {
		const raw = successEnvelope()
		mutate(raw)
		await assert.rejects(
			clientWithTransport(async () => jsonResponse(raw)).parsePages([page(1)]),
			(error) => error.code === 'GLM_OCR_RESPONSE_INVALID'
		)
	}
})

test('accepts provider dimensions through 20000 and rejects 20001', async () => {
	const atLimit = successEnvelope()
	atLimit.data_info.pages[0] = { width: 20000, height: 20000 }
	atLimit.layout_details[0][0].width = 20000
	atLimit.layout_details[0][0].height = 20000
	const accepted = await clientWithTransport(async () => jsonResponse(atLimit)).parsePages([page(1)])
	assert.deepEqual(accepted.pages[0].dataInfo.pages[0], { width: 20000, height: 20000 })

	for (const field of ['width', 'height']) {
		const aboveLimit = successEnvelope()
		aboveLimit.data_info.pages[0][field] = 20001
		aboveLimit.layout_details[0][0][field] = 20001
		await assert.rejects(
			clientWithTransport(async () => jsonResponse(aboveLimit)).parsePages([page(1)]),
			(error) => error.code === 'GLM_OCR_RESPONSE_INVALID'
		)
	}
})

test('rejects lone Unicode surrogates in every provider string projection and discarded metadata', async () => {
	const mutators = [
		(raw) => { raw.id = '\ud800' },
		(raw) => { raw.request_id = '\udfff' },
		(raw) => { raw.md_results = `bad-\ud800-text` },
		(raw) => { raw.layout_visualization[0] = `bad-\udfff-resource` },
		(raw) => { raw.layout_details[0][0].content = `bad-\ud800-content` },
		(raw) => { raw.layout_details[0][0].content = `bad-\ud800` },
		(raw) => { raw.layout_details[0][0].content = `bad-\udfff` },
	]
	for (const mutate of mutators) {
		const raw = successEnvelope()
		mutate(raw)
		await assert.rejects(
			clientWithTransport(async () => jsonResponse(raw)).parsePages([page(1)]),
			(error) => error.code === 'GLM_OCR_RESPONSE_INVALID'
		)
	}

	const paired = successEnvelope()
	paired.id = 'task-😀'
	paired.request_id = 'request-😀'
	paired.md_results = 'markdown-😀'
	paired.layout_visualization[0] = 'visualization-😀'
	paired.layout_details[0][0].content = 'content-😀'
	const accepted = await clientWithTransport(async () => jsonResponse(paired)).parsePages([page(1)])
	assert.equal(accepted.pages[0].layoutDetails[0][0].content, 'content-😀')
})

test('requires every discarded usage token count to be a nonnegative safe integer', async () => {
	const paths = [
		(raw, value) => { raw.usage.prompt_tokens = value },
		(raw, value) => { raw.usage.completion_tokens = value },
		(raw, value) => { raw.usage.total_tokens = value },
		(raw, value) => { raw.usage.prompt_tokens_details.cached_tokens = value },
	]
	for (const setValue of paths) {
		for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
			const raw = successEnvelope()
			setValue(raw, invalid)
			await assert.rejects(
				clientWithTransport(async () => jsonResponse(raw)).parsePages([page(1)]),
				(error) => error.code === 'GLM_OCR_RESPONSE_INVALID'
			)
		}
	}
})

test('maps valid but mismatched single-page coverage to the closed evidence tuple', async () => {
	for (const mutate of [
		(raw) => { raw.data_info.num_pages = 2 },
		(raw) => { raw.data_info.pages.push({ width: 600, height: 800 }); raw.data_info.num_pages = 2 },
		(raw) => { raw.layout_details.push([]) },
	]) {
		const raw = successEnvelope()
		mutate(raw)
		await assert.rejects(
			clientWithTransport(async () => jsonResponse(raw)).parsePages([page(1)]),
			(error) => assertErrorTuple(error, {
				code: 'GLM_OCR_PAGE_COVERAGE_MISMATCH',
				stage: 'ocr-normalize',
				class: 'evidence',
				taskErrorClass: 'evidence_permanent',
				publicMessageKey: 'evidence-structure-unproven',
				automaticRetrySameJob: false,
				retryable: false,
			})
		)
	}
})

test('maps every locked HTTP status without reading any non-200 body', async () => {
	function expected(status) {
		const explicit = {
			400: ['GLM_OCR_BAD_REQUEST', 'ocr-provider', 'input_permanent', false, 'analysis-input-rejected'],
			401: ['GLM_OCR_AUTH_FAILED', 'ocr-provider', 'configuration_permanent', false, 'provider-configuration-unavailable'],
			403: ['GLM_OCR_FORBIDDEN', 'ocr-provider', 'configuration_permanent', false, 'provider-configuration-unavailable'],
			408: ['GLM_OCR_HTTP_408', 'ocr-provider', 'upstream_transient', true, 'provider-timeout'],
			413: ['GLM_OCR_INPUT_TOO_LARGE', 'ocr-preflight', 'input_permanent', false, 'analysis-input-rejected'],
			429: ['GLM_OCR_RATE_LIMITED', 'ocr-provider', 'upstream_transient', true, 'provider-temporarily-unavailable'],
			500: ['GLM_OCR_PROVIDER_UNAVAILABLE', 'ocr-provider', 'upstream_transient', true, 'provider-temporarily-unavailable'],
			502: ['GLM_OCR_PROVIDER_UNAVAILABLE', 'ocr-provider', 'upstream_transient', true, 'provider-temporarily-unavailable'],
			503: ['GLM_OCR_PROVIDER_UNAVAILABLE', 'ocr-provider', 'upstream_transient', true, 'provider-temporarily-unavailable'],
			504: ['GLM_OCR_PROVIDER_UNAVAILABLE', 'ocr-provider', 'upstream_transient', true, 'provider-temporarily-unavailable'],
		}
		if (explicit[status]) return explicit[status]
		if (status <= 499) {
			return ['GLM_OCR_CLIENT_ERROR', 'ocr-provider', 'configuration_permanent', false, 'provider-configuration-unavailable']
		}
		return ['GLM_OCR_PROVIDER_ERROR', 'ocr-provider', 'upstream_transient', true, 'provider-temporarily-unavailable']
	}

	for (const status of Array.from({ length: 300 }, (_, index) => index + 300)) {
		const [code, stage, taskErrorClass, retryable, publicMessageKey] = expected(status)
		let bodyReads = 0
		let calls = 0
		const retryClock = createImmediateBackoffClock()
		const client = clientWithTransport(async () => {
			calls += 1
			return {
				status,
				json: async () => {
					bodyReads += 1
					throw new Error('non-200-body-must-not-be-read')
				},
			}
		}, retryClock)
		await assert.rejects(
			client.parsePages([page(1)]),
			(error) => assertErrorTuple(error, { code, stage, taskErrorClass, publicMessageKey, retryable })
		)
		assert.equal(bodyReads, 0)
		assert.equal(calls, [408, 429, 500, 502, 503, 504].includes(status) ? 2 : 1)
		assert.equal(retryClock.activeTimers, 0)
	}

	for (const status of [201, 299, 600]) {
		let bodyReads = 0
		await assert.rejects(
			clientWithTransport(async () => ({
				status,
				json: async () => { bodyReads += 1 },
			})).parsePages([page(1)]),
			(error) => error.code === 'GLM_OCR_RESPONSE_INVALID'
		)
		assert.equal(bodyReads, 0)
	}
})

test('maps transport failures and malformed 200 readers to safe errors with no raw cause', async () => {
	const sensitive = ['sensitive', 'transport', 'detail'].join('-')
	const networkClient = clientWithTransport(
		async () => { throw new Error(sensitive) },
		createImmediateBackoffClock()
	)
	await assert.rejects(networkClient.parsePages([page(1)]), (error) => {
		assertErrorTuple(error, {
			code: 'GLM_OCR_NETWORK_ERROR',
			stage: 'ocr-provider',
			class: 'transient',
			taskErrorClass: 'transport_transient',
			publicMessageKey: 'provider-connection-interrupted',
			automaticRetrySameJob: true,
			retryable: true,
		})
		assert.equal('cause' in error, false)
		assert.equal(JSON.stringify(error).includes(sensitive), false)
		assert.equal(String(error.stack).includes(sensitive), false)
		return true
	})

	const invalidClient = clientWithTransport(async () => ({
		status: 200,
		json: async () => { throw new Error(sensitive) },
	}))
	await assert.rejects(
		invalidClient.parsePages([page(1)]),
		(error) => error.code === 'GLM_OCR_RESPONSE_INVALID'
			&& !JSON.stringify(error).includes(sensitive)
	)

	const forgedContract = {
		name: 'GlmOcrClientError',
		code: 'GLM_OCR_AUTH_FAILED',
		message: sensitive,
		cause: sensitive,
		secret: sensitive,
	}
	await assert.rejects(
		clientWithTransport(
			async () => { throw forgedContract },
			createImmediateBackoffClock()
		).parsePages([page(1)]),
		(error) => error.code === 'GLM_OCR_NETWORK_ERROR'
			&& !`${JSON.stringify(error)} ${error.stack}`.includes(sensitive)
	)

	const forgedAbort = Object.assign(new Error(sensitive), { name: 'AbortError', code: 'ABORT_ERR' })
	await assert.rejects(
		clientWithTransport(
			async () => { throw forgedAbort },
			createImmediateBackoffClock()
		).parsePages([page(1)]),
		(error) => error.name === 'GlmOcrClientError'
			&& error.code === 'GLM_OCR_NETWORK_ERROR'
			&& !`${JSON.stringify(error)} ${error.stack}`.includes(sensitive)
	)
})

test('caller abort is fixed nonterminal control flow before and during transport', async () => {
	let calls = 0
	const before = new AbortController()
	before.abort(['private', 'reason'].join('-'))
	const client = clientWithTransport(async () => {
		calls += 1
		return jsonResponse()
	})
	assert.throws(() => client.parsePages([page(1)], { signal: before.signal }), (error) => {
		assert.equal(error.name, 'AbortError')
		assert.equal(error.code, 'ABORT_ERR')
		assert.equal(error.message, 'operation-aborted')
		assert.deepEqual(Object.keys(error), ['code'])
		assert.deepEqual(Reflect.ownKeys(error).sort(), ['code', 'message', 'name', 'stack'].sort())
		assert.equal(error.stack, 'AbortError: operation-aborted')
		assert.equal('cause' in error, false)
		assert.equal('reason' in error, false)
		return true
	})
	assert.equal(calls, 0)

	const nearCapBytes = Buffer.alloc(PAGE_BYTE_CAP - 1)
	nearCapBytes[0] = 0xff
	nearCapBytes[1] = 0xd8
	nearCapBytes[nearCapBytes.length - 2] = 0xff
	nearCapBytes[nearCapBytes.length - 1] = 0xd9
	for (const skippedPages of [null, [], [page(1, jpegDataUri(nearCapBytes))]]) {
		assert.throws(
			() => client.parsePages(skippedPages, { signal: before.signal }),
			(error) => error.name === 'AbortError'
				&& error.code === 'ABORT_ERR'
				&& error.message === 'operation-aborted'
		)
	}
	assert.equal(calls, 0)
	assert.throws(
		() => client.parsePages([], { signal: before.signal, extra: true }),
		(error) => error.code === 'GLM_OCR_BAD_REQUEST'
	)
	assert.equal(calls, 0)

	const during = new AbortController()
	const pendingClient = clientWithTransport(async (_endpoint, request) => {
		calls += 1
		return new Promise((_resolve, reject) => {
			request.signal.addEventListener('abort', () => reject(new Error('private-abort-detail')), { once: true })
		})
	})
	const pending = pendingClient.parsePages([page(1)], { signal: during.signal })
	during.abort('private-caller-reason')
	await assert.rejects(pending, (error) => {
		assert.equal(error.name, 'AbortError')
		assert.equal(error.code, 'ABORT_ERR')
		assert.equal(error.message, 'operation-aborted')
		assert.deepEqual(Object.keys(error), ['code'])
		assert.deepEqual(Reflect.ownKeys(error).sort(), ['code', 'message', 'name', 'stack'].sort())
		assert.equal(error.stack, 'AbortError: operation-aborted')
		const visible = `${JSON.stringify(error)} ${String(error.stack)}`
		assert.equal(visible.includes('private-abort-detail'), false)
		assert.equal(visible.includes('private-caller-reason'), false)
		return true
	})
	assert.equal(calls, 1)
})

test('configuration and testing injection are closed and production aliases cannot bypass them', () => {
	for (const config of [
		{ apiKey: FAKE_TOKEN },
		{ transport: async () => jsonResponse() },
		{ endpoint: 'https://example.invalid' },
		{ decompressorFactory: () => null },
		{ __testing: {} },
		{ __testing: { apiKey: FAKE_TOKEN } },
		{ __testing: { transport: async () => jsonResponse() } },
		{ __testing: { apiKey: FAKE_TOKEN, transport: async () => jsonResponse(), endpoint: 'x' } },
		{
			__testing: {
				apiKey: FAKE_TOKEN,
				transport: async () => jsonResponse(),
				decompressorFactory: () => null,
			},
		},
		{
			__testing: {
				apiKey: FAKE_TOKEN,
				requestFactory: () => new MockRequest(),
				decompressorFactory: 'invalid',
			},
		},
	]) {
		assert.throws(() => createGlmOcrClient(config), (error) => error.code === 'GLM_OCR_CLIENT_ERROR')
	}

	const previous = process.env.NODE_ENV
	try {
		for (const productionAlias of ['production', 'prod', 'PROD', 'Production']) {
			process.env.NODE_ENV = productionAlias
			assert.throws(
				() => clientWithTransport(async () => jsonResponse()),
				(error) => error.code === 'GLM_OCR_CLIENT_ERROR'
			)
			assert.throws(
				() => createGlmOcrClient({
					__testing: {
						apiKey: FAKE_TOKEN,
						requestFactory: () => new MockRequest(),
						decompressorFactory: () => null,
					},
				}),
				(error) => error.code === 'GLM_OCR_CLIENT_ERROR'
			)
		}
	} finally {
		if (previous === undefined) delete process.env.NODE_ENV
		else process.env.NODE_ENV = previous
	}
})

test('pageConcurrency is an exact nonproduction seam with default three and hard cap four', async () => {
	let dispatches = 0
	const transport = async () => {
		dispatches += 1
		return jsonResponse()
	}
	for (const invalid of [0, -1, 0.5, 5, '3', NaN, Infinity, {}, new Number(3)]) {
		assert.throws(
			() => createGlmOcrClient({
				__testing: { apiKey: FAKE_TOKEN, transport, pageConcurrency: invalid },
			}),
			(error) => error.code === 'GLM_OCR_CLIENT_ERROR'
		)
	}
	assert.equal(dispatches, 0)
	assert.throws(
		() => createGlmOcrClient({ pageConcurrency: 4 }),
		(error) => error.code === 'GLM_OCR_CLIENT_ERROR'
	)
	assert.throws(
		() => createGlmOcrClient({
			__testing: new Proxy({ apiKey: FAKE_TOKEN, transport, pageConcurrency: 3 }, {}),
		}),
		(error) => error.code === 'GLM_OCR_CLIENT_ERROR'
	)
	let accessorReads = 0
	const accessorTesting = { apiKey: FAKE_TOKEN, transport }
	Object.defineProperty(accessorTesting, 'pageConcurrency', {
		enumerable: true,
		get() {
			accessorReads += 1
			return 3
		},
	})
	assert.throws(
		() => createGlmOcrClient({ __testing: accessorTesting }),
		(error) => error.code === 'GLM_OCR_CLIENT_ERROR'
	)
	assert.equal(accessorReads, 0)
	assert.doesNotThrow(() => createGlmOcrClient({
		__testing: {
			apiKey: FAKE_TOKEN,
			requestFactory: () => new MockRequest(),
			pageConcurrency: 4,
		},
	}))

	const previousNodeEnv = process.env.NODE_ENV
	const previousConcurrency = process.env.ZHIPU_GLM_OCR_PAGE_CONCURRENCY
	try {
		process.env.NODE_ENV = 'test'
		process.env.ZHIPU_GLM_OCR_PAGE_CONCURRENCY = '4'
		const clock = new FakeClock()
		const controller = new AbortController()
		let defaultCalls = 0
		const client = createGlmOcrClient({
			__testing: {
				apiKey: FAKE_TOKEN,
				transport: (_endpoint, request) => {
					defaultCalls += 1
					return new Promise((_resolve, reject) => {
						EventTarget.prototype.addEventListener.call(request.signal, 'abort', () => {
							reject(new Error('default-concurrency-cancelled'))
						}, { once: true })
					})
				},
				clock: clock.hooks,
				pageConcurrency: undefined,
			},
		})
		const pending = client.parsePages(
			Array.from({ length: 5 }, (_, index) => markedPage(index + 1, 2100 + index)),
			{ signal: controller.signal }
		)
		await flushUntil(() => defaultCalls === 3)
		assert.equal(defaultCalls, 3)
		controller.abort()
		await assert.rejects(pending, (error) => error.code === 'ABORT_ERR')
		assert.equal(clock.activeTimers, 0)

		for (const alias of ['production', 'prod', 'PROD', 'Production']) {
			process.env.NODE_ENV = alias
			assert.throws(
				() => createGlmOcrClient({
					__testing: { apiKey: FAKE_TOKEN, transport, pageConcurrency: 1 },
				}),
				(error) => error.code === 'GLM_OCR_CLIENT_ERROR'
			)
		}
	} finally {
		if (previousNodeEnv === undefined) delete process.env.NODE_ENV
		else process.env.NODE_ENV = previousNodeEnv
		if (previousConcurrency === undefined) delete process.env.ZHIPU_GLM_OCR_PAGE_CONCURRENCY
		else process.env.ZHIPU_GLM_OCR_PAGE_CONCURRENCY = previousConcurrency
	}
	assert.equal(dispatches, 0)
})

test('ordinary factory reads only ZHIPU_GLM_OCR_API_KEY with abort/config/page precedence', async () => {
	const names = [
		'NODE_ENV',
		'ZHIPU_GLM_OCR_API_KEY',
		'KIMI_API_KEY',
		'MOONSHOT_API_KEY',
		'DEEPSEEK_API_KEY',
	]
	const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
	try {
		process.env.NODE_ENV = 'test'
		delete process.env.ZHIPU_GLM_OCR_API_KEY
		process.env.KIMI_API_KEY = 'wrong-provider-token'
		process.env.MOONSHOT_API_KEY = 'wrong-provider-token'
		process.env.DEEPSEEK_API_KEY = 'wrong-provider-token'
		const missing = createGlmOcrClient()
		const trappedPage = new Proxy(page(1), {
			getPrototypeOf() { throw new Error('page-preflight-must-not-run') },
		})
		assert.throws(
			() => missing.parsePages([trappedPage]),
			(error) => error.code === 'GLM_OCR_NOT_CONFIGURED'
				&& !`${JSON.stringify(error)} ${error.stack}`.includes('page-preflight-must-not-run')
		)

		const nearCapEncoded = 'A'.repeat(4 * Math.ceil((PAGE_BYTE_CAP - 1) / 3))
		assert.throws(
			() => missing.parsePages([page(1, `${PREFIX}${nearCapEncoded}`)]),
			(error) => error.code === 'GLM_OCR_NOT_CONFIGURED'
		)
		assert.throws(
			() => missing.parsePages([], { extra: true }),
			(error) => error.code === 'GLM_OCR_BAD_REQUEST'
		)
		const aborted = new AbortController()
		aborted.abort('must-not-be-read')
		assert.throws(
			() => missing.parsePages(null, { signal: aborted.signal }),
			(error) => error.name === 'AbortError' && error.code === 'ABORT_ERR'
		)

		process.env.ZHIPU_GLM_OCR_API_KEY = FAKE_TOKEN
		const configured = createGlmOcrClient()
		assert.equal(JSON.stringify(configured).includes(FAKE_TOKEN), false)
		assert.equal(inspect(configured, { showHidden: true }).includes(FAKE_TOKEN), false)
	} finally {
		for (const name of names) {
			if (previous[name] === undefined) delete process.env[name]
			else process.env[name] = previous[name]
		}
	}
})

test('credential validation rejects unsafe boundaries and never exposes a valid fake token on the client', () => {
	let calls = 0
	const transport = async () => {
		calls += 1
		return jsonResponse()
	}
	for (const invalid of [
		'',
		' ',
		' leading',
		'trailing ',
		'line\r\nbreak',
		'nul\u0000byte',
		'中文',
		'emoji-😀',
		'latin-\u0080',
		'A'.repeat(4097),
	]) {
		let client
		try {
			client = createGlmOcrClient({ __testing: { apiKey: invalid, transport } })
		} catch (error) {
			assert.equal(error.code, 'GLM_OCR_NOT_CONFIGURED')
			continue
		}
		assert.throws(
			() => client.parsePages([page(1)]),
			(error) => error.code === 'GLM_OCR_NOT_CONFIGURED'
		)
	}
	assert.equal(calls, 0)

	const client = clientWithTransport(transport)
	assert.equal(JSON.stringify(client).includes(FAKE_TOKEN), false)
	assert.equal(inspect(client, { showHidden: true }).includes(FAKE_TOKEN), false)
})

test('errors never expose authorization, JPEG data, provider ids, or response bodies', async () => {
	const image = jpegDataUri()
	let bodyReads = 0
	const rawProviderDetail = ['provider', 'body', 'private'].join('-')
	const client = clientWithTransport(async () => ({
		status: 401,
		json: async () => {
			bodyReads += 1
			return { id: 'provider-private-id', detail: rawProviderDetail }
		},
	}))
	await assert.rejects(client.parsePages([page(1, image)]), (error) => {
		const visible = `${error.message} ${JSON.stringify(error)} ${String(error.stack)}`
		for (const forbidden of [FAKE_TOKEN, image, 'provider-private-id', rawProviderDetail, 'authorization']) {
			assert.equal(visible.includes(forbidden), false)
		}
		return true
	})
	assert.equal(bodyReads, 0)
})
