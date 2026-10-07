'use strict'

const crypto = require('node:crypto')
const { isPromise, isProxy } = require('node:util').types
const sharp = require('sharp')
const { parseJpegSofDimensions } = require('./backend/utils/jpegSofDimensions')

const PROMISE_CONSTRUCTOR = Promise
const PROMISE_PROTOTYPE = PROMISE_CONSTRUCTOR.prototype
const PROMISE_THEN = PROMISE_PROTOTYPE.then
const PROMISE_RACE = PROMISE_CONSTRUCTOR.race
const EVENT_TARGET_ADD = EventTarget.prototype.addEventListener
const EVENT_TARGET_REMOVE = EventTarget.prototype.removeEventListener
const PROMISE_CONSTRUCTOR_DESCRIPTOR = Object.freeze({
	writable: Object.getOwnPropertyDescriptor(PROMISE_PROTOTYPE, 'constructor').writable,
	enumerable: Object.getOwnPropertyDescriptor(PROMISE_PROTOTYPE, 'constructor').enumerable,
	configurable: Object.getOwnPropertyDescriptor(PROMISE_PROTOTYPE, 'constructor').configurable,
})

const JPEG_PREFIX = 'data:image/jpeg;base64,'
const MAX_PAGES = 100
const MAX_PAGE_BYTES = 9 * 1024 * 1024
const MAX_PIXELS = 25_000_000
const MAX_DIMENSION = 20_000
const MAX_REGIONS = 5000
const MAX_BLOCK_CHARS = 200000
const MAX_TEXT_CHARS = 1000000
const MAX_TABLE_CELLS = 256
const MAX_TABLE_ROWS = 10000
const MAX_SOURCE_LINES = 10000
const MAX_TABLES = 1000
const MAX_BASE64_CHARS = 4 * Math.ceil((MAX_PAGE_BYTES - 1) / 3)
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const RAW_LABELS = new Set(['image', 'text', 'formula', 'table'])
const OWN_ERRORS = new WeakSet()
const OWN_ABORT_ERRORS = new WeakSet()
const ABORTED_GETTER = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get

const ERROR_DEFINITIONS = Object.freeze({
	GLM_OCR_NOT_CONFIGURED: ['configuration_permanent', 'ocr-config', false, 'provider-configuration-unavailable'],
	GLM_OCR_NETWORK_ERROR: ['transport_transient', 'ocr-provider', true, 'provider-connection-interrupted'],
	GLM_OCR_CONNECT_TIMEOUT: ['transport_transient', 'ocr-provider', true, 'provider-timeout'],
	GLM_OCR_PAGE_TIMEOUT: ['transport_transient', 'ocr-provider', true, 'provider-timeout'],
	OCR_STAGE_DEADLINE_EXCEEDED: ['transport_transient', 'ocr-provider', true, 'analysis-deadline-exceeded'],
	GLM_OCR_HTTP_408: ['upstream_transient', 'ocr-provider', true, 'provider-timeout'],
	GLM_OCR_RATE_LIMITED: ['upstream_transient', 'ocr-provider', true, 'provider-temporarily-unavailable'],
	GLM_OCR_PROVIDER_UNAVAILABLE: ['upstream_transient', 'ocr-provider', true, 'provider-temporarily-unavailable'],
	GLM_OCR_PROVIDER_ERROR: ['upstream_transient', 'ocr-provider', true, 'provider-temporarily-unavailable'],
	GLM_OCR_BAD_REQUEST: ['input_permanent', 'ocr-provider', false, 'analysis-input-rejected'],
	GLM_OCR_CLIENT_ERROR: ['configuration_permanent', 'ocr-provider', false, 'provider-configuration-unavailable'],
	GLM_OCR_AUTH_FAILED: ['configuration_permanent', 'ocr-provider', false, 'provider-configuration-unavailable'],
	GLM_OCR_FORBIDDEN: ['configuration_permanent', 'ocr-provider', false, 'provider-configuration-unavailable'],
	GLM_OCR_INPUT_TOO_LARGE: ['input_permanent', 'ocr-preflight', false, 'analysis-input-rejected'],
	GLM_OCR_RESPONSE_INVALID: ['schema_permanent', 'ocr-normalize', false, 'provider-response-invalid'],
	GLM_OCR_PAGE_COVERAGE_MISMATCH: ['evidence_permanent', 'ocr-normalize', false, 'evidence-structure-unproven'],
	OCR_RECORD_MEMBERSHIP_UNPROVEN: ['evidence_permanent', 'ocr-normalize', false, 'evidence-structure-unproven'],
	OCR_READING_ORDER_CONFLICT: ['evidence_permanent', 'ocr-normalize', false, 'evidence-structure-unproven'],
})

function deepFreeze(value) {
	if (!value || (typeof value !== 'object' && typeof value !== 'function') || Object.isFrozen(value)) return value
	for (const key of Reflect.ownKeys(value)) deepFreeze(value[key])
	return Object.freeze(value)
}

function safeError(code) {
	const definition = ERROR_DEFINITIONS[code]
	if (!definition) throw new TypeError('unknown OCR structured error code')
	const [errorClass, stage, retryable, safeMessageKey] = definition
	const error = new Error(safeMessageKey)
	Object.defineProperty(error, 'name', { value: 'OcrStructuredAdapterError', enumerable: false })
	Object.defineProperty(error, 'stack', {
		value: `OcrStructuredAdapterError: ${safeMessageKey}`,
		enumerable: false,
		writable: false,
		configurable: false,
	})
	Object.assign(error, { code, class: errorClass, stage, retryable, safeMessageKey })
	OWN_ERRORS.add(error)
	return Object.freeze(error)
}

function abortError() {
	const error = new Error('operation-aborted')
	Object.defineProperty(error, 'name', { value: 'AbortError', enumerable: false })
	Object.defineProperty(error, 'stack', {
		value: 'AbortError: operation-aborted', enumerable: false, writable: false, configurable: false,
	})
	Object.defineProperty(error, 'code', { value: 'ABORT_ERR', enumerable: true })
	OWN_ABORT_ERRORS.add(error)
	return Object.freeze(error)
}

function isOwnError(value) {
	return Boolean(value && (typeof value === 'object' || typeof value === 'function') && OWN_ERRORS.has(value))
}

function isOwnAbortError(value) {
	return Boolean(value && (typeof value === 'object' || typeof value === 'function')
		&& OWN_ABORT_ERRORS.has(value))
}

function signalAborted(signal) {
	if (signal === undefined) return false
	try { return ABORTED_GETTER.call(signal) } catch { throw safeError('GLM_OCR_BAD_REQUEST') }
}

function throwIfAborted(signal) {
	if (signalAborted(signal)) throw abortError()
}

function rejectProxy(value, code) {
	let result
	try { result = isProxy(value) } catch { throw safeError(code) }
	if (result) throw safeError(code)
}

function readObject(value, allowedKeys, requiredKeys, code) {
	rejectProxy(value, code)
	let prototype
	let keys
	try {
		prototype = value && typeof value === 'object' ? Object.getPrototypeOf(value) : null
		keys = value && typeof value === 'object' ? Reflect.ownKeys(value) : []
	} catch { throw safeError(code) }
	if (!value || typeof value !== 'object' || prototype !== Object.prototype) throw safeError(code)
	const allowed = new Set(allowedKeys)
	if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) throw safeError(code)
	if (requiredKeys.some((key) => !keys.includes(key))) throw safeError(code)
	const snapshot = Object.create(null)
	for (const key of keys) {
		let descriptor
		try { descriptor = Object.getOwnPropertyDescriptor(value, key) } catch { throw safeError(code) }
		if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw safeError(code)
		snapshot[key] = descriptor.value
	}
	return snapshot
}

function readArray(value, maximum, code, limitCode = code) {
	rejectProxy(value, code)
	let isArray
	let prototype
	let lengthDescriptor
	let keys
	try {
		isArray = Array.isArray(value)
		prototype = isArray ? Object.getPrototypeOf(value) : null
		lengthDescriptor = isArray ? Object.getOwnPropertyDescriptor(value, 'length') : null
		keys = isArray ? Reflect.ownKeys(value) : []
	} catch { throw safeError(code) }
	if (!isArray || prototype !== Array.prototype || !lengthDescriptor
		|| !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
		|| !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) throw safeError(code)
	if (lengthDescriptor.value > maximum) throw safeError(limitCode)
	const length = lengthDescriptor.value
	if (keys.length !== length + 1 || keys[keys.length - 1] !== 'length') throw safeError(code)
	const result = new Array(length)
	for (let index = 0; index < length; index += 1) {
		if (keys[index] !== String(index)) throw safeError(code)
		let descriptor
		try { descriptor = Object.getOwnPropertyDescriptor(value, String(index)) } catch { throw safeError(code) }
		if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw safeError(code)
		result[index] = descriptor.value
	}
	return result
}

function snapshotOptions(options) {
	if (options === undefined) return Object.freeze({ signal: undefined, aborted: false })
	const values = readObject(options, ['signal'], [], 'GLM_OCR_BAD_REQUEST')
	if (values.signal === undefined) return Object.freeze({ signal: undefined, aborted: false })
	const signal = values.signal
	if (!signal || (typeof signal !== 'object' && typeof signal !== 'function')) throw safeError('GLM_OCR_BAD_REQUEST')
	rejectProxy(signal, 'GLM_OCR_BAD_REQUEST')
	let aborted
	try { aborted = ABORTED_GETTER.call(signal) } catch { throw safeError('GLM_OCR_BAD_REQUEST') }
	return Object.freeze({ signal, aborted })
}

function snapshotClient(config) {
	const values = readObject(config, ['glmClient'], ['glmClient'], 'GLM_OCR_CLIENT_ERROR')
	const client = values.glmClient
	const clientValues = readObject(client, ['parsePages'], ['parsePages'], 'GLM_OCR_CLIENT_ERROR')
	if (typeof clientValues.parsePages !== 'function') throw safeError('GLM_OCR_CLIENT_ERROR')
	rejectProxy(clientValues.parsePages, 'GLM_OCR_CLIENT_ERROR')
	return Object.freeze({ parsePages: clientValues.parsePages })
}

function base64Character(code) {
	return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
		|| (code >= 48 && code <= 57) || code === 43 || code === 47
}

function decodeCanonicalJpeg(value) {
	if (typeof value !== 'string' || !value.startsWith(JPEG_PREFIX)) throw safeError('GLM_OCR_BAD_REQUEST')
	const source = value.slice(JPEG_PREFIX.length)
	if (source.length > MAX_BASE64_CHARS) throw safeError('GLM_OCR_INPUT_TOO_LARGE')
	if (source.length < 8 || source.length % 4 !== 0) throw safeError('GLM_OCR_BAD_REQUEST')
	const padding = source.endsWith('==') ? 2 : source.endsWith('=') ? 1 : 0
	const dataEnd = source.length - padding
	for (let index = 0; index < dataEnd; index += 1) {
		if (!base64Character(source.charCodeAt(index))) throw safeError('GLM_OCR_BAD_REQUEST')
	}
	for (let index = dataEnd; index < source.length; index += 1) {
		if (source.charCodeAt(index) !== 61) throw safeError('GLM_OCR_BAD_REQUEST')
	}
	if (padding === 2) {
		const bits = BASE64.indexOf(source[source.length - 3])
		if (bits < 0 || (bits & 15) !== 0) throw safeError('GLM_OCR_BAD_REQUEST')
	} else if (padding === 1) {
		const bits = BASE64.indexOf(source[source.length - 2])
		if (bits < 0 || (bits & 3) !== 0) throw safeError('GLM_OCR_BAD_REQUEST')
	}
	const decodedLength = (source.length / 4) * 3 - padding
	if (decodedLength >= MAX_PAGE_BYTES) throw safeError('GLM_OCR_INPUT_TOO_LARGE')
	let bytes
	try { bytes = Buffer.from(source, 'base64') } catch { throw safeError('GLM_OCR_BAD_REQUEST') }
	if (bytes.length !== decodedLength) throw safeError('GLM_OCR_BAD_REQUEST')
	return bytes
}

function parseFrame(bytes) {
	try { return parseJpegSofDimensions(bytes) } catch (error) {
		let code
		try { code = error && error.code } catch { code = null }
		if (code === 'JPEG_SOF_LIMIT_EXCEEDED') throw safeError('GLM_OCR_INPUT_TOO_LARGE')
		throw safeError('GLM_OCR_BAD_REQUEST')
	}
}

function positiveDimension(value) {
	return Number.isSafeInteger(value) && value > 0 && value <= MAX_DIMENSION
}

function snapshotBatch(batch) {
	const values = readObject(batch, ['expectedPageCount', 'render', 'pages'],
		['expectedPageCount', 'render', 'pages'], 'GLM_OCR_BAD_REQUEST')
	if (!Number.isSafeInteger(values.expectedPageCount) || values.expectedPageCount < 1) {
		throw safeError('GLM_OCR_BAD_REQUEST')
	}
	if (values.expectedPageCount > MAX_PAGES) throw safeError('GLM_OCR_INPUT_TOO_LARGE')
	const render = readObject(values.render, ['engine', 'dpi', 'format', 'quality'],
		['engine', 'dpi', 'format', 'quality'], 'GLM_OCR_BAD_REQUEST')
	if (!['mupdf', 'sharp'].includes(render.engine) || render.dpi !== 200
		|| render.format !== 'jpeg' || render.quality !== 92) throw safeError('GLM_OCR_BAD_REQUEST')
	const pages = readArray(values.pages, MAX_PAGES, 'GLM_OCR_BAD_REQUEST', 'GLM_OCR_INPUT_TOO_LARGE')
	if (pages.length !== values.expectedPageCount) throw safeError('GLM_OCR_BAD_REQUEST')
	const pageSnapshots = pages.map((value, index) => {
		const page = readObject(value, ['pageNumber', 'jpegDataUri', 'renderedWidth', 'renderedHeight'],
			['pageNumber', 'jpegDataUri', 'renderedWidth', 'renderedHeight'], 'GLM_OCR_BAD_REQUEST')
		if (page.pageNumber !== index + 1) throw safeError('GLM_OCR_BAD_REQUEST')
		if (!positiveDimension(page.renderedWidth) || !positiveDimension(page.renderedHeight)) {
			if (Number.isSafeInteger(page.renderedWidth) && Number.isSafeInteger(page.renderedHeight)
				&& page.renderedWidth > 0 && page.renderedHeight > 0) throw safeError('GLM_OCR_INPUT_TOO_LARGE')
			throw safeError('GLM_OCR_BAD_REQUEST')
		}
		const pixels = page.renderedWidth * page.renderedHeight
		if (!Number.isSafeInteger(pixels) || pixels > MAX_PIXELS) throw safeError('GLM_OCR_INPUT_TOO_LARGE')
		const frame = parseFrame(decodeCanonicalJpeg(page.jpegDataUri))
		if (frame.width !== page.renderedWidth || frame.height !== page.renderedHeight) {
			throw safeError('GLM_OCR_BAD_REQUEST')
		}
		return Object.freeze({
			pageNumber: page.pageNumber,
			jpegDataUri: page.jpegDataUri,
			renderedWidth: page.renderedWidth,
			renderedHeight: page.renderedHeight,
		})
	})
	return deepFreeze({
		expectedPageCount: values.expectedPageCount,
		render: { engine: render.engine, dpi: 200, format: 'jpeg', quality: 92 },
		pages: pageSnapshots,
	})
}

function hasUnicodeScalars(value) {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index)
		if (code >= 0xd800 && code <= 0xdbff) {
			if (index + 1 >= value.length) return false
			const next = value.charCodeAt(index + 1)
			if (next < 0xdc00 || next > 0xdfff) return false
			index += 1
		} else if (code >= 0xdc00 && code <= 0xdfff) return false
	}
	return true
}

function boundedString(value, maximum, allowEmpty = true) {
	return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.length > 0)
		&& !value.includes('\u0000') && hasUnicodeScalars(value)
}

function safeText(value, maximum, allowEmpty = true) {
	return boundedString(value, maximum, allowEmpty)
		&& !/<\s*\/?\s*[A-Za-z][^>]*>/.test(value)
		&& !/\bon[A-Za-z0-9_-]*\s*=/i.test(value)
		&& !/\b(?:href|src|xlink:href)\s*=/i.test(value)
		&& !/\burl\s*\(/i.test(value)
}

function membershipUnproven() {
	throw safeError('OCR_RECORD_MEMBERSHIP_UNPROVEN')
}

function normalizedContent(value) {
	let content
	try { content = value.replace(/\r\n?/g, '\n').normalize('NFC') } catch {
		throw safeError('GLM_OCR_RESPONSE_INVALID')
	}
	if (!boundedString(content, MAX_BLOCK_CHARS)) throw safeError('GLM_OCR_RESPONSE_INVALID')
	return content
}

function tableCellText(value) {
	const text = value.trim()
	if (!/\S/u.test(text) || text.includes('\t') || text.includes('\n')) membershipUnproven()
	if (!safeText(text, MAX_BLOCK_CHARS, false)) throw safeError('GLM_OCR_RESPONSE_INVALID')
	return text
}

function responseInvalid() {
	throw safeError('GLM_OCR_RESPONSE_INVALID')
}

function asciiTagNameCharacter(code) {
	return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
		|| (code >= 48 && code <= 57) || code === 45 || code === 58 || code === 95
}

function validateHtmlCellAttributes(content, start, end) {
	if (start === end) return
	const seen = new Set()
	let cursor = start
	let membershipFailure = false
	while (cursor < end) {
		if (content.charCodeAt(cursor) !== 32) responseInvalid()
		cursor += 1
		const nameStart = cursor
		while (cursor < end && asciiTagNameCharacter(content.charCodeAt(cursor))) cursor += 1
		const name = content.slice(nameStart, cursor)
		if (name !== 'rowspan' && name !== 'colspan') responseInvalid()
		if (seen.has(name)) membershipFailure = true
		seen.add(name)
		if (content[cursor] !== '=' || content[cursor + 1] !== '"') responseInvalid()
		cursor += 2
		const valueStart = cursor
		while (cursor < end && content.charCodeAt(cursor) >= 48 && content.charCodeAt(cursor) <= 57) {
			cursor += 1
		}
		if (cursor === valueStart || content[cursor] !== '"') responseInvalid()
		if (content.slice(valueStart, cursor) !== '1') membershipFailure = true
		cursor += 1
	}
	if (membershipFailure) membershipUnproven()
}

function nextHtmlToken(content, state) {
	if (state.lookahead !== undefined) {
		const token = state.lookahead
		state.lookahead = undefined
		return token
	}
	if (state.cursor >= content.length) return { kind: 'eof' }
	if (content[state.cursor] !== '<') {
		const start = state.cursor
		while (state.cursor < content.length && content[state.cursor] !== '<') {
			if (content[state.cursor] === '>' || content[state.cursor] === '&') responseInvalid()
			state.cursor += 1
		}
		return { kind: 'text', value: content.slice(start, state.cursor) }
	}
	state.cursor += 1
	let closing = false
	if (content[state.cursor] === '/') {
		closing = true
		state.cursor += 1
	}
	const nameStart = state.cursor
	while (state.cursor < content.length && asciiTagNameCharacter(content.charCodeAt(state.cursor))) {
		state.cursor += 1
	}
	if (state.cursor === nameStart) responseInvalid()
	const name = content.slice(nameStart, state.cursor)
	if (!['table', 'thead', 'tbody', 'tr', 'th', 'td'].includes(name)) responseInvalid()
	const attributesStart = state.cursor
	while (state.cursor < content.length && content[state.cursor] !== '>') {
		if (content[state.cursor] === '<' || content[state.cursor] === '&') responseInvalid()
		state.cursor += 1
	}
	if (state.cursor >= content.length) responseInvalid()
	const attributesEnd = state.cursor
	state.cursor += 1
	if (closing || !['th', 'td'].includes(name)) {
		if (attributesStart !== attributesEnd) responseInvalid()
	} else {
		validateHtmlCellAttributes(content, attributesStart, attributesEnd)
	}
	return { kind: closing ? 'close' : 'open', name }
}

function peekHtmlToken(content, state) {
	if (state.lookahead === undefined) state.lookahead = nextHtmlToken(content, state)
	return state.lookahead
}

function expectHtmlToken(content, state, kind, name) {
	const token = nextHtmlToken(content, state)
	if (token.kind !== kind || token.name !== name) membershipUnproven()
}

function parseHtmlRow(content, state, cellTag) {
	expectHtmlToken(content, state, 'open', 'tr')
	const cells = []
	while (peekHtmlToken(content, state).kind === 'open'
		&& peekHtmlToken(content, state).name === cellTag) {
		if (cells.length >= MAX_TABLE_CELLS) throw safeError('GLM_OCR_RESPONSE_INVALID')
		nextHtmlToken(content, state)
		const cellToken = nextHtmlToken(content, state)
		if (cellToken.kind !== 'text') {
			if (cellToken.kind === 'open') responseInvalid()
			membershipUnproven()
		}
		const close = nextHtmlToken(content, state)
		if (close.kind === 'open') responseInvalid()
		if (close.kind !== 'close' || close.name !== cellTag) membershipUnproven()
		cells.push(tableCellText(cellToken.value))
	}
	if (cells.length < 1) membershipUnproven()
	expectHtmlToken(content, state, 'close', 'tr')
	return cells
}

function assertTableColumns(header, rows) {
	const seen = new Set()
	for (const cell of header) {
		if (seen.has(cell)) membershipUnproven()
		seen.add(cell)
	}
	for (const row of rows) {
		if (row.length !== header.length) membershipUnproven()
	}
}

function parseHtmlTable(content, maximumBlocks) {
	const state = { cursor: 0, lookahead: undefined }
	expectHtmlToken(content, state, 'open', 'table')
	expectHtmlToken(content, state, 'open', 'thead')
	const header = parseHtmlRow(content, state, 'th')
	expectHtmlToken(content, state, 'close', 'thead')
	expectHtmlToken(content, state, 'open', 'tbody')
	const rows = []
	while (peekHtmlToken(content, state).kind === 'open'
		&& peekHtmlToken(content, state).name === 'tr') {
		if (rows.length >= MAX_TABLE_ROWS || rows.length + 1 >= MAX_SOURCE_LINES
			|| rows.length + 1 >= maximumBlocks) throw safeError('GLM_OCR_RESPONSE_INVALID')
		rows.push(parseHtmlRow(content, state, 'td'))
	}
	if (rows.length < 1) membershipUnproven()
	expectHtmlToken(content, state, 'close', 'tbody')
	expectHtmlToken(content, state, 'close', 'table')
	if (nextHtmlToken(content, state).kind !== 'eof') membershipUnproven()
	assertTableColumns(header, rows)
	return { header, rows }
}

function parseMarkdownRow(line) {
	if (line.length < 3 || line[0] !== '|' || line[line.length - 1] !== '|') membershipUnproven()
	const cells = []
	let start = 1
	for (let cursor = 1; cursor < line.length; cursor += 1) {
		if (line.charCodeAt(cursor) !== 124) continue
		if (cells.length >= MAX_TABLE_CELLS) throw safeError('GLM_OCR_RESPONSE_INVALID')
		cells.push(tableCellText(line.slice(start, cursor)))
		start = cursor + 1
	}
	return cells
}

function assertMarkdownSafe(content) {
	for (let cursor = 0; cursor < content.length; cursor += 1) {
		if (['<', '>', '&', '[', ']', '\\', '`'].includes(content[cursor])) responseInvalid()
	}
}

function hyphenSeparator(value) {
	if (value.length < 3) return false
	for (let cursor = 0; cursor < value.length; cursor += 1) {
		if (value.charCodeAt(cursor) !== 45) return false
	}
	return true
}

function parseMarkdownTable(content, maximumBlocks) {
	assertMarkdownSafe(content)
	const lines = []
	let start = 0
	for (let cursor = 0; cursor <= content.length; cursor += 1) {
		if (cursor !== content.length && content.charCodeAt(cursor) !== 10) continue
		if (lines.length >= MAX_SOURCE_LINES + 1) throw safeError('GLM_OCR_RESPONSE_INVALID')
		const line = content.slice(start, cursor)
		if (line.length < 1) membershipUnproven()
		lines.push(line)
		start = cursor + 1
	}
	if (lines.length < 3) membershipUnproven()
	const header = parseMarkdownRow(lines[0])
	const separator = parseMarkdownRow(lines[1])
	if (separator.length !== header.length || separator.some((cell) => !hyphenSeparator(cell))) {
		membershipUnproven()
	}
	const rows = []
	for (let index = 2; index < lines.length; index += 1) {
		if (rows.length >= MAX_TABLE_ROWS || rows.length + 1 >= MAX_SOURCE_LINES
			|| rows.length + 1 >= maximumBlocks) {
			throw safeError('GLM_OCR_RESPONSE_INVALID')
		}
		const row = parseMarkdownRow(lines[index])
		if (row.every((cell) => hyphenSeparator(cell))) membershipUnproven()
		rows.push(row)
	}
	assertTableColumns(header, rows)
	return { header, rows }
}

function parseTableContent(content, maximumBlocks) {
	const trimmed = content.trim()
	if (trimmed.startsWith('<')) {
		if (!trimmed.startsWith('<table')) responseInvalid()
		return parseHtmlTable(trimmed, maximumBlocks)
	}
	if (trimmed.startsWith('|')) return parseMarkdownTable(trimmed, maximumBlocks)
	for (let cursor = 0; cursor < trimmed.length; cursor += 1) {
		if (['<', '>', '&', '[', ']', '\\', '`'].includes(trimmed[cursor])) responseInvalid()
	}
	membershipUnproven()
}

function round3(value) {
	const rounded = Math.round(value * 1000) / 1000
	return Object.is(rounded, -0) ? 0 : rounded
}

function normalizeBbox(rawValue, width, height) {
	const values = readArray(rawValue, 4, 'GLM_OCR_RESPONSE_INVALID')
	if (values.length !== 4 || values.some((value) => typeof value !== 'number'
		|| !Number.isFinite(value) || value < 0 || value > 1)
		|| values[2] <= values[0] || values[3] <= values[1]) throw safeError('GLM_OCR_RESPONSE_INVALID')
	const bbox = [round3(values[0] * width), round3(values[1] * height),
		round3(values[2] * width), round3(values[3] * height)]
	if (bbox.some((value) => !Number.isFinite(value) || Object.is(value, -0))
		|| bbox[0] < 0 || bbox[1] < 0 || bbox[2] > width || bbox[3] > height
		|| bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) throw safeError('GLM_OCR_RESPONSE_INVALID')
	return bbox
}

function assertReadingOrder(regions) {
	for (let left = 0; left < regions.length; left += 1) {
		for (let right = left + 1; right < regions.length; right += 1) {
			const a = regions[left].bbox
			const b = regions[right].bbox
			if (b[3] <= a[1]) throw safeError('OCR_READING_ORDER_CONFLICT')
			if (a[3] <= b[1]) continue
			if (b[2] <= a[0]) throw safeError('OCR_READING_ORDER_CONFLICT')
		}
	}
}

function normalizeProviderRegion(value, local, providerDimensions) {
	const region = readObject(value, ['index', 'label', 'bbox_2d', 'content', 'height', 'width'],
		['index', 'label', 'bbox_2d', 'content', 'height', 'width'], 'GLM_OCR_RESPONSE_INVALID')
	if (!Number.isInteger(region.index) || region.index < 1 || region.index > MAX_REGIONS
		|| !RAW_LABELS.has(region.label) || !boundedString(region.content, MAX_BLOCK_CHARS)
		|| !positiveDimension(region.width) || !positiveDimension(region.height)) {
		throw safeError('GLM_OCR_RESPONSE_INVALID')
	}
	if (region.width !== providerDimensions.width || region.height !== providerDimensions.height
		|| region.width !== local.renderedWidth || region.height !== local.renderedHeight) {
		throw safeError('GLM_OCR_PAGE_COVERAGE_MISMATCH')
	}
	if (region.label === 'image' && region.content !== '') throw safeError('GLM_OCR_RESPONSE_INVALID')
	return {
		index: region.index,
		label: region.label,
		content: region.content,
		bbox: normalizeBbox(region.bbox_2d, local.renderedWidth, local.renderedHeight),
	}
}

async function normalizeVerifiedBlankPage(local, signal) {
	let abortHandler
	let listenerRegistered = false
	let abortObserved = false
	try {
		throwIfAborted(signal)
		const pipeline = sharp(decodeCanonicalJpeg(local.jpegDataUri), {
			limitInputPixels: MAX_PIXELS,
			limitInputChannels: 3,
			unlimited: false,
			sequentialRead: true,
			failOn: 'warning',
		}).toColourspace('srgb').raw()
		let abortPending
		if (signal !== undefined) {
			abortPending = new PROMISE_CONSTRUCTOR((resolve, reject) => {
				abortHandler = () => {
					if (abortObserved) return
					abortObserved = true
					const error = abortError()
					try { pipeline.destroy() } catch {}
					reject(error)
				}
			})
			Reflect.apply(EVENT_TARGET_ADD, signal, ['abort', abortHandler, { once: true }])
			listenerRegistered = true
			if (signalAborted(signal)) abortHandler()
		}
		const decodePending = pipeline.toBuffer({ resolveWithObject: true })
		const { data, info } = abortPending === undefined
			? await decodePending
			: await Reflect.apply(PROMISE_RACE, PROMISE_CONSTRUCTOR, [[decodePending, abortPending]])
		if (listenerRegistered) {
			try { Reflect.apply(EVENT_TARGET_REMOVE, signal, ['abort', abortHandler]) } catch {}
			listenerRegistered = false
		}
		throwIfAborted(signal)
		const expectedBytes = local.renderedWidth * local.renderedHeight * 3
		if (!Buffer.isBuffer(data) || !info || info.width !== local.renderedWidth
			|| info.height !== local.renderedHeight || info.channels !== 3
			|| data.byteLength !== expectedBytes) throw new TypeError('blank-page-decode-mismatch')
		for (let index = 0; index < data.byteLength; index += 1) {
			if (data[index] !== 255) throw new TypeError('blank-page-non-white')
		}
		return {
			pageNumber: local.pageNumber,
			bounds: [0, 0, local.renderedWidth, local.renderedHeight],
			verifiedBlank: true,
			text: '',
			blocks: [],
		}
	} catch (error) {
		if (isOwnAbortError(error) || abortObserved) throw isOwnAbortError(error) ? error : abortError()
		throw safeError('GLM_OCR_PAGE_COVERAGE_MISMATCH')
	} finally {
		if (listenerRegistered) {
			try { Reflect.apply(EVENT_TARGET_REMOVE, signal, ['abort', abortHandler]) } catch {}
		}
	}
}

function normalizeProviderPage(value, local, precedingDocumentChars) {
	const page = readObject(value, ['pageNumber', 'layoutDetails', 'dataInfo'],
		['pageNumber', 'layoutDetails', 'dataInfo'], 'GLM_OCR_RESPONSE_INVALID')
	if (page.pageNumber !== local.pageNumber) throw safeError('GLM_OCR_PAGE_COVERAGE_MISMATCH')
	const dataInfo = readObject(page.dataInfo, ['num_pages', 'pages'], ['num_pages', 'pages'], 'GLM_OCR_RESPONSE_INVALID')
	if (!Number.isInteger(dataInfo.num_pages)) throw safeError('GLM_OCR_RESPONSE_INVALID')
	const providerPages = readArray(dataInfo.pages, MAX_PAGES, 'GLM_OCR_RESPONSE_INVALID')
	if (dataInfo.num_pages !== 1 || providerPages.length !== 1) throw safeError('GLM_OCR_PAGE_COVERAGE_MISMATCH')
	const dimensions = readObject(providerPages[0], ['width', 'height'], ['width', 'height'], 'GLM_OCR_RESPONSE_INVALID')
	if (!positiveDimension(dimensions.width) || !positiveDimension(dimensions.height)) {
		throw safeError('GLM_OCR_RESPONSE_INVALID')
	}
	if (dimensions.width !== local.renderedWidth || dimensions.height !== local.renderedHeight) {
		throw safeError('GLM_OCR_PAGE_COVERAGE_MISMATCH')
	}
	const layouts = readArray(page.layoutDetails, MAX_PAGES, 'GLM_OCR_RESPONSE_INVALID')
	if (layouts.length !== 1) throw safeError('GLM_OCR_PAGE_COVERAGE_MISMATCH')
	const rawRegions = readArray(layouts[0], MAX_REGIONS, 'GLM_OCR_RESPONSE_INVALID')
	if (rawRegions.length === 0) return null
	const regions = rawRegions.map((region) => normalizeProviderRegion(region, local, dimensions))
	for (let index = 0; index < regions.length; index += 1) {
		if (regions[index].index !== index + 1) throw safeError('GLM_OCR_RESPONSE_INVALID')
	}
	assertReadingOrder(regions)
	const pendingBlocks = []
	let pageChars = 0
	let tableOrdinal = 0
	const appendBlock = (block) => {
		if (pendingBlocks.length >= MAX_REGIONS) throw safeError('GLM_OCR_RESPONSE_INVALID')
		if (!safeText(block.text, MAX_BLOCK_CHARS, false)) throw safeError('GLM_OCR_RESPONSE_INVALID')
		const candidatePageChars = pageChars + (pendingBlocks.length === 0 ? 0 : 1) + block.text.length
		if (candidatePageChars > MAX_TEXT_CHARS
			|| precedingDocumentChars + candidatePageChars > MAX_TEXT_CHARS) {
			throw safeError('GLM_OCR_RESPONSE_INVALID')
		}
		pageChars = candidatePageChars
		pendingBlocks.push(block)
	}
	for (const region of regions) {
		if (region.label === 'image') continue
		const content = normalizedContent(region.content)
		if (region.label === 'table') {
			tableOrdinal += 1
			if (tableOrdinal > MAX_TABLES) throw safeError('GLM_OCR_RESPONSE_INVALID')
			const table = parseTableContent(content, MAX_REGIONS - pendingBlocks.length)
			const sourceLineCount = table.rows.length + 1
			appendBlock({
				text: table.header.join('\t'), bbox: region.bbox.slice(), sourceBlockOrdinal: region.index,
				sourceLineOrdinal: 1, sourceLineCount, regionLabel: 'header',
				recordMembership: 'non-record', table: null,
			})
			for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex += 1) {
				const cellTexts = table.rows[rowIndex]
				appendBlock({
					text: cellTexts.join('\t'), bbox: region.bbox.slice(), sourceBlockOrdinal: region.index,
					sourceLineOrdinal: rowIndex + 2, sourceLineCount, regionLabel: 'table_row',
					recordMembership: 'logical-table-row',
					table: { tableOrdinal, rowOrdinal: rowIndex + 1, rowCount: table.rows.length, cellTexts },
				})
			}
			continue
		}
		if (!safeText(content, MAX_BLOCK_CHARS)) throw safeError('GLM_OCR_RESPONSE_INVALID')
		const firstRegionBlock = pendingBlocks.length
		let sourceLineCount = 0
		let lineStart = 0
		for (let cursor = 0; cursor <= content.length; cursor += 1) {
			if (cursor !== content.length && content.charCodeAt(cursor) !== 10) continue
			const line = content.slice(lineStart, cursor)
			lineStart = cursor + 1
			if (!/\S/u.test(line)) continue
			if (!safeText(line, MAX_BLOCK_CHARS, false)) throw safeError('GLM_OCR_RESPONSE_INVALID')
			sourceLineCount += 1
			appendBlock({
				text: line, bbox: region.bbox.slice(), sourceBlockOrdinal: region.index,
				sourceLineOrdinal: sourceLineCount, sourceLineCount: 0,
				regionLabel: region.label === 'text' ? 'paragraph' : 'formula',
				recordMembership: 'non-record', table: null,
			})
		}
		for (let index = firstRegionBlock; index < pendingBlocks.length; index += 1) {
			pendingBlocks[index].sourceLineCount = sourceLineCount
		}
	}
	if (pendingBlocks.length < 1) throw safeError('GLM_OCR_PAGE_COVERAGE_MISMATCH')
	let text = ''
	const blocks = pendingBlocks.map((block, index) => {
		if (index > 0) text += '\n'
		const charStart = text.length
		text += block.text
		let logicalTable = null
		if (block.table !== null) {
			let cellStart = charStart
			const cellCount = block.table.cellTexts.length
			const cells = block.table.cellTexts.map((cellText, cellIndex) => {
				if (cellIndex > 0) cellStart += 1
				const cell = {
					text: cellText, charStart: cellStart, charEnd: cellStart + cellText.length,
					cellOrdinal: cellIndex + 1, cellCount, columnRole: 'other',
				}
				cellStart = cell.charEnd
				return cell
			})
			logicalTable = {
				tableOrdinal: block.table.tableOrdinal, rowOrdinal: block.table.rowOrdinal,
				rowCount: block.table.rowCount, cells,
			}
		}
		return {
			text: block.text, charStart, charEnd: text.length, bbox: block.bbox,
			sourceBlockOrdinal: block.sourceBlockOrdinal,
			sourceLineOrdinal: block.sourceLineOrdinal,
			sourceLineCount: block.sourceLineCount,
			regionIndex: index + 1,
			regionLabel: block.regionLabel,
			geometryGranularity: 'region',
			recordMembership: block.recordMembership,
			logicalTable,
		}
	})
	if (text.length !== pageChars) throw safeError('GLM_OCR_RESPONSE_INVALID')
	return {
		pageNumber: local.pageNumber,
		bounds: [0, 0, local.renderedWidth, local.renderedHeight],
		verifiedBlank: false,
		text,
		blocks,
	}
}

function coordinate(value, maximum) {
	return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)
		&& value >= 0 && value <= maximum && Math.abs(value - round3(value)) <= 1e-9
}

function exactOwnDataKeys(value, expectedKeys) {
	if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false
	const keys = Reflect.ownKeys(value)
	if (keys.length !== expectedKeys.length || expectedKeys.some((key) => !keys.includes(key))) return false
	return keys.every((key) => {
		const descriptor = Object.getOwnPropertyDescriptor(value, key)
		return typeof key === 'string' && descriptor
			&& Object.prototype.hasOwnProperty.call(descriptor, 'value')
	})
}

function validateEvidence(evidence) {
	if (evidence.version !== 'ocr-structured-v1' || evidence.sourceMode !== 'ocr-structured'
		|| evidence.provider !== 'zhipu-layout-parsing' || evidence.model !== 'glm-ocr'
		|| evidence.complete !== true || evidence.pages.length !== evidence.expectedPageCount) {
		throw safeError('GLM_OCR_RESPONSE_INVALID')
	}
	let documentChars = 0
	for (let pageIndex = 0; pageIndex < evidence.pages.length; pageIndex += 1) {
		const page = evidence.pages[pageIndex]
		if (page.pageNumber !== pageIndex + 1
			|| page.blocks.length > MAX_REGIONS || page.bounds[0] !== 0 || page.bounds[1] !== 0
			|| !coordinate(page.bounds[2], MAX_DIMENSION) || !coordinate(page.bounds[3], MAX_DIMENSION)) {
			throw safeError('GLM_OCR_RESPONSE_INVALID')
		}
		if (page.verifiedBlank === true) {
			if (page.text !== '' || page.blocks.length !== 0) throw safeError('GLM_OCR_RESPONSE_INVALID')
			continue
		}
		if (page.verifiedBlank !== false || !safeText(page.text, MAX_TEXT_CHARS, false)
			|| page.blocks.length < 1) throw safeError('GLM_OCR_RESPONSE_INVALID')
		documentChars += page.text.length
		if (documentChars > MAX_TEXT_CHARS) throw safeError('GLM_OCR_RESPONSE_INVALID')
		const coverage = new Uint8Array(page.text.length)
		const sourceGroups = new Map()
		const tableRows = new Map()
		let previousEnd = 0
		for (let blockIndex = 0; blockIndex < page.blocks.length; blockIndex += 1) {
			const block = page.blocks[blockIndex]
			if (!exactOwnDataKeys(block, ['text', 'charStart', 'charEnd', 'bbox', 'sourceBlockOrdinal',
				'sourceLineOrdinal', 'sourceLineCount', 'regionIndex', 'regionLabel',
				'geometryGranularity', 'recordMembership', 'logicalTable'])
				|| !safeText(block.text, MAX_BLOCK_CHARS, false) || block.regionIndex !== blockIndex + 1
				|| !Number.isInteger(block.charStart) || !Number.isInteger(block.charEnd)
				|| block.charStart < previousEnd || block.charEnd <= block.charStart
				|| page.text.slice(block.charStart, block.charEnd) !== block.text
				|| block.geometryGranularity !== 'region'
				|| !['paragraph', 'formula', 'header', 'table_row'].includes(block.regionLabel)) {
				throw safeError('GLM_OCR_RESPONSE_INVALID')
			}
			if (block.regionLabel === 'table_row') {
				const logical = block.logicalTable
				if (block.recordMembership !== 'logical-table-row'
					|| !exactOwnDataKeys(logical, ['tableOrdinal', 'rowOrdinal', 'rowCount', 'cells'])
					|| !Number.isInteger(logical.tableOrdinal) || logical.tableOrdinal < 1
					|| logical.tableOrdinal > MAX_TABLES || !Number.isInteger(logical.rowOrdinal)
					|| logical.rowOrdinal < 1 || logical.rowOrdinal > MAX_TABLE_ROWS
					|| !Number.isInteger(logical.rowCount) || logical.rowCount < 1
					|| logical.rowCount > MAX_TABLE_ROWS || !Array.isArray(logical.cells)
					|| logical.cells.length < 1 || logical.cells.length > MAX_TABLE_CELLS) {
					throw safeError('GLM_OCR_RESPONSE_INVALID')
				}
				const cellCoverage = new Uint8Array(block.text.length)
				for (let cellIndex = 0; cellIndex < logical.cells.length; cellIndex += 1) {
					const cell = logical.cells[cellIndex]
					if (!exactOwnDataKeys(cell, ['text', 'charStart', 'charEnd', 'cellOrdinal',
						'cellCount', 'columnRole']) || !safeText(cell.text, MAX_BLOCK_CHARS, false)
						|| cell.text.includes('\t') || cell.text.includes('\n')
						|| !Number.isInteger(cell.charStart) || !Number.isInteger(cell.charEnd)
						|| cell.charStart < block.charStart || cell.charEnd <= cell.charStart
						|| cell.charEnd > block.charEnd
						|| page.text.slice(cell.charStart, cell.charEnd) !== cell.text
						|| cell.cellOrdinal !== cellIndex + 1 || cell.cellCount !== logical.cells.length
						|| cell.columnRole !== 'other') throw safeError('GLM_OCR_RESPONSE_INVALID')
					for (let offset = cell.charStart - block.charStart;
						offset < cell.charEnd - block.charStart; offset += 1) {
						cellCoverage[offset] += 1
						if (cellCoverage[offset] > 1) throw safeError('GLM_OCR_RESPONSE_INVALID')
					}
				}
				if (block.text !== logical.cells.map((cell) => cell.text).join('\t')) {
					throw safeError('GLM_OCR_RESPONSE_INVALID')
				}
				for (let offset = 0; offset < block.text.length; offset += 1) {
					if (/\S/u.test(block.text[offset]) && cellCoverage[offset] !== 1) {
						throw safeError('GLM_OCR_RESPONSE_INVALID')
					}
				}
				const table = tableRows.get(logical.tableOrdinal)
					|| { sourceBlockOrdinal: block.sourceBlockOrdinal, rows: [] }
				if (table.sourceBlockOrdinal !== block.sourceBlockOrdinal) {
					throw safeError('GLM_OCR_RESPONSE_INVALID')
				}
				table.rows.push({ rowOrdinal: logical.rowOrdinal, rowCount: logical.rowCount })
				tableRows.set(logical.tableOrdinal, table)
			} else if (block.logicalTable !== null || block.recordMembership !== 'non-record') {
				throw safeError('GLM_OCR_RESPONSE_INVALID')
			}
			previousEnd = block.charEnd
			if (!Array.isArray(block.bbox) || block.bbox.length !== 4
				|| !block.bbox.every((value, index) => coordinate(value, index % 2 === 0 ? page.bounds[2] : page.bounds[3]))
				|| block.bbox[2] <= block.bbox[0] || block.bbox[3] <= block.bbox[1]) {
				throw safeError('GLM_OCR_RESPONSE_INVALID')
			}
			for (let offset = block.charStart; offset < block.charEnd; offset += 1) {
				coverage[offset] += 1
				if (coverage[offset] > 1) throw safeError('GLM_OCR_RESPONSE_INVALID')
			}
			if (!Number.isInteger(block.sourceBlockOrdinal) || block.sourceBlockOrdinal < 1
				|| block.sourceBlockOrdinal > MAX_SOURCE_LINES
				|| !Number.isInteger(block.sourceLineOrdinal) || !Number.isInteger(block.sourceLineCount)
				|| block.sourceLineOrdinal < 1 || block.sourceLineOrdinal > block.sourceLineCount
				|| block.sourceLineCount > MAX_SOURCE_LINES) {
				throw safeError('GLM_OCR_RESPONSE_INVALID')
			}
			if (!sourceGroups.has(block.sourceBlockOrdinal)) sourceGroups.set(block.sourceBlockOrdinal, [])
			sourceGroups.get(block.sourceBlockOrdinal).push(block)
		}
		for (let index = 0; index < page.text.length; index += 1) {
			if (coverage[index] > 1 || (/\S/u.test(page.text[index]) && coverage[index] !== 1)) {
				throw safeError('GLM_OCR_RESPONSE_INVALID')
			}
		}
		for (const group of sourceGroups.values()) {
			if (group.some((block) => block.sourceLineCount !== group.length)
				|| group.some((block, index) => block.sourceLineOrdinal !== index + 1)) {
				throw safeError('GLM_OCR_RESPONSE_INVALID')
			}
			const tableMembers = group.filter((block) => block.regionLabel === 'table_row')
			if (tableMembers.length > 0 && (group[0].regionLabel !== 'header'
				|| tableMembers.length !== group.length - 1
				|| group.slice(1).some((block) => block.regionLabel !== 'table_row'))) {
				throw safeError('GLM_OCR_RESPONSE_INVALID')
			}
		}
		const tableOrdinals = [...tableRows.keys()].sort((left, right) => left - right)
		if (tableOrdinals.some((ordinal, index) => ordinal !== index + 1)) {
			throw safeError('GLM_OCR_RESPONSE_INVALID')
		}
		for (const table of tableRows.values()) {
			if (table.rows.some((row, index) => row.rowOrdinal !== index + 1
				|| row.rowCount !== table.rows.length)) throw safeError('GLM_OCR_RESPONSE_INVALID')
		}
	}
}

async function normalizeEnvelope(rawValue, snapshot, signal) {
	const raw = readObject(rawValue, ['schemaVersion', 'provider', 'model', 'pages'],
		['schemaVersion', 'provider', 'model', 'pages'], 'GLM_OCR_RESPONSE_INVALID')
	if (raw.schemaVersion !== 'glm-ocr-client-v1' || raw.provider !== 'zhipu-layout-parsing'
		|| raw.model !== 'glm-ocr') throw safeError('GLM_OCR_RESPONSE_INVALID')
	const providerPages = readArray(raw.pages, MAX_PAGES, 'GLM_OCR_RESPONSE_INVALID')
	if (providerPages.length !== snapshot.expectedPageCount) throw safeError('GLM_OCR_PAGE_COVERAGE_MISMATCH')
	const pagePlans = []
	let documentChars = 0
	for (let index = 0; index < providerPages.length; index += 1) {
		const page = normalizeProviderPage(providerPages[index], snapshot.pages[index], documentChars)
		if (page !== null) {
			documentChars += page.text.length
			if (documentChars > MAX_TEXT_CHARS) throw safeError('GLM_OCR_RESPONSE_INVALID')
		}
		pagePlans.push(page)
	}
	const pages = []
	for (let index = 0; index < pagePlans.length; index += 1) {
		pages.push(pagePlans[index] === null
			? await normalizeVerifiedBlankPage(snapshot.pages[index], signal)
			: pagePlans[index])
	}
	const evidence = {
		version: 'ocr-structured-v1',
		sourceMode: 'ocr-structured',
		provider: 'zhipu-layout-parsing',
		model: 'glm-ocr',
		complete: true,
		expectedPageCount: snapshot.expectedPageCount,
		metadata: {
			adapterVersion: 'glm-layout-adapter-v1',
			readingOrderVersion: 'ocr-reading-order-v1',
			tableParserVersion: 'ocr-table-parser-v1',
			canonicalizationVersion: 'credit-ocr-canonical-json-v1',
			normalizationLimitsVersion: 'ocr-normalization-limits-v1',
			providerBboxNormalizationVersion: 'glm-normalized-region-bbox-to-rendered-pixels-v1',
			blankPagePolicyVersion: 'verified-blank-page-v1',
			coordinateSpace: {
				name: 'rendered-image-pixels', origin: 'top-left', xAxis: 'right', yAxis: 'down',
				boundsOrder: 'x0-y0-x1-y1', precisionDecimals: 3,
			},
			render: { ...snapshot.render },
		},
		pages,
	}
	validateEvidence(evidence)
	return deepFreeze(evidence)
}

function canonicalJson(value) {
	if (value === null) return 'null'
	if (typeof value === 'boolean') return value ? 'true' : 'false'
	if (typeof value === 'number') {
		if (!Number.isFinite(value) || Object.is(value, -0)) throw safeError('GLM_OCR_RESPONSE_INVALID')
		return JSON.stringify(value)
	}
	if (typeof value === 'string') {
		if (!hasUnicodeScalars(value)) throw safeError('GLM_OCR_RESPONSE_INVALID')
		return JSON.stringify(value.normalize('NFC'))
	}
	if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
	if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
		throw safeError('GLM_OCR_RESPONSE_INVALID')
	}
	const normalized = new Map()
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== 'string' || !hasUnicodeScalars(key)) throw safeError('GLM_OCR_RESPONSE_INVALID')
		const descriptor = Object.getOwnPropertyDescriptor(value, key)
		if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
			throw safeError('GLM_OCR_RESPONSE_INVALID')
		}
		const normalizedKey = key.normalize('NFC')
		if (normalized.has(normalizedKey)) throw safeError('GLM_OCR_RESPONSE_INVALID')
		normalized.set(normalizedKey, descriptor.value)
	}
	return `{${[...normalized.keys()].sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(normalized.get(key))}`).join(',')}}`
}

function isProviderAbort(error) {
	if (!error || (typeof error !== 'object' && typeof error !== 'function')) return false
	try {
		if (isProxy(error) || Object.getPrototypeOf(error) !== Error.prototype || !Object.isFrozen(error)) return false
		const keys = Reflect.ownKeys(error)
		if (keys.length !== 4 || !['stack', 'message', 'name', 'code'].every((key) => keys.includes(key))) return false
		const name = Object.getOwnPropertyDescriptor(error, 'name')
		const code = Object.getOwnPropertyDescriptor(error, 'code')
		const message = Object.getOwnPropertyDescriptor(error, 'message')
		const stack = Object.getOwnPropertyDescriptor(error, 'stack')
		return Boolean(name && Object.prototype.hasOwnProperty.call(name, 'value') && name.value === 'AbortError'
			&& name.enumerable === false
			&& code && Object.prototype.hasOwnProperty.call(code, 'value') && code.value === 'ABORT_ERR'
			&& code.enumerable === true
			&& message && Object.prototype.hasOwnProperty.call(message, 'value') && message.value === 'operation-aborted'
			&& message.enumerable === false
			&& stack && Object.prototype.hasOwnProperty.call(stack, 'value')
			&& stack.value === 'AbortError: operation-aborted' && stack.enumerable === false)
	} catch { return false }
}

function reconstructProviderError(error) {
	if (isOwnError(error)) return error
	if (!error || typeof error !== 'object') return null
	try {
		if (isProxy(error) || Object.getPrototypeOf(error) !== Error.prototype || !Object.isFrozen(error)) return null
		const enumerable = Object.keys(error)
		if (enumerable.length !== 5 || !['code', 'class', 'stage', 'retryable', 'safeMessageKey']
			.every((key) => enumerable.includes(key))) return null
		const values = Object.create(null)
		for (const key of enumerable) {
			const descriptor = Object.getOwnPropertyDescriptor(error, key)
			if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null
			values[key] = descriptor.value
		}
		const definition = ERROR_DEFINITIONS[values.code]
		if (!definition || values.class !== definition[0] || values.stage !== definition[1]
			|| values.retryable !== definition[2] || values.safeMessageKey !== definition[3]) return null
		const name = Object.getOwnPropertyDescriptor(error, 'name')
		if (!name || name.value !== 'GlmOcrClientError') return null
		return safeError(values.code)
	} catch { return null }
}

function mapClientFailure(error, signal) {
	const providerError = reconstructProviderError(error)
	if (providerError) return providerError
	let aborted = false
	if (signal !== undefined) {
		try { aborted = ABORTED_GETTER.call(signal) } catch { aborted = false }
	}
	if (aborted && isProviderAbort(error)) return abortError()
	return safeError('GLM_OCR_CLIENT_ERROR')
}

function createOcrStructuredV1Adapter(config) {
	const dependency = snapshotClient(config)
	return Object.freeze({
		parseRenderedBatch(batch, options) {
			const optionSnapshot = snapshotOptions(options)
			if (optionSnapshot.aborted) throw abortError()
			const batchSnapshot = snapshotBatch(batch)
			const pages = Object.freeze(batchSnapshot.pages.map((page) => Object.freeze({
				pageNumber: page.pageNumber, jpegDataUri: page.jpegDataUri,
			})))
			let pending
			try {
				pending = Reflect.apply(dependency.parsePages, undefined,
					[pages, optionSnapshot.signal === undefined ? undefined : Object.freeze({ signal: optionSnapshot.signal })])
				rejectProxy(pending, 'GLM_OCR_CLIENT_ERROR')
				const ownConstructor = Object.getOwnPropertyDescriptor(pending, 'constructor')
				const prototypeConstructor = Object.getOwnPropertyDescriptor(PROMISE_PROTOTYPE, 'constructor')
				if (!isPromise(pending) || Object.getPrototypeOf(pending) !== PROMISE_PROTOTYPE
					|| ownConstructor !== undefined || !prototypeConstructor
					|| !Object.prototype.hasOwnProperty.call(prototypeConstructor, 'value')
					|| prototypeConstructor.value !== PROMISE_CONSTRUCTOR
					|| prototypeConstructor.writable !== PROMISE_CONSTRUCTOR_DESCRIPTOR.writable
					|| prototypeConstructor.enumerable !== PROMISE_CONSTRUCTOR_DESCRIPTOR.enumerable
					|| prototypeConstructor.configurable !== PROMISE_CONSTRUCTOR_DESCRIPTOR.configurable) {
					throw safeError('GLM_OCR_CLIENT_ERROR')
				}
			} catch (error) {
				throw mapClientFailure(error, optionSnapshot.signal)
			}
			try {
				return Reflect.apply(PROMISE_THEN, pending, [
					async (raw) => {
						let evidence
						try { evidence = await normalizeEnvelope(raw, batchSnapshot, optionSnapshot.signal) } catch (error) {
							if (isOwnError(error) || isOwnAbortError(error)) throw error
							throw safeError('GLM_OCR_RESPONSE_INVALID')
						}
						const serialized = canonicalJson(evidence)
						const canonicalSha256 = crypto.createHash('sha256').update(Buffer.from(serialized, 'utf8')).digest('hex')
						return deepFreeze({ evidence, canonicalJson: serialized, canonicalSha256 })
					},
					(error) => { throw mapClientFailure(error, optionSnapshot.signal) },
				])
			} catch (error) {
				throw mapClientFailure(error, optionSnapshot.signal)
			}
		},
	})
}

module.exports = { createOcrStructuredV1Adapter }
