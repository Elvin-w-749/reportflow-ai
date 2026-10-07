'use strict'

const https = require('node:https')
const { performance } = require('node:perf_hooks')
const { isProxy } = require('node:util').types
const zlib = require('node:zlib')
const { isProductionRuntime } = require('./backend/utils/env')
const {
	parseStrictJsonBytes,
	STRICT_JSON_LIMITS,
} = require('./backend/utils/glmOcrStrictJson')

const GLM_OCR_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/layout_parsing'
const GLM_OCR_MODEL = 'glm-ocr'
const CLIENT_SCHEMA_VERSION = 'glm-ocr-client-v1'
const JPEG_DATA_URI_PREFIX = 'data:image/jpeg;base64,'
const MAX_PAGE_BYTES = 9 * 1024 * 1024
const MAX_PAGES = 100
const MAX_REGIONS_PER_PAGE = 5000
const MAX_REGION_CONTENT_CHARS = 200000
const MAX_METADATA_STRING_CHARS = 1000000
const MAX_VISUALIZATION_STRING_CHARS = 16 * 1024 * 1024
const MAX_PROVIDER_DIMENSION = 20000
const MAX_CANONICAL_BASE64_CHARS = 4 * Math.ceil((MAX_PAGE_BYTES - 1) / 3)
const RAW_RESPONSE_MAX_BYTES = STRICT_JSON_LIMITS.rawBytes
const CONNECT_TIMEOUT_MS = 15 * 1000
const PAGE_TIMEOUT_MS = 120 * 1000
const STAGE_DEADLINE_MS = 420 * 1000
const MAX_ATTEMPTS_PER_PAGE = 2
const DEFAULT_RETRY_DELAY_MS = 1000
const RETRY_AFTER_CAP_MS = 30000
const DEFAULT_PAGE_CONCURRENCY = 3
const HARD_PAGE_CONCURRENCY_CAP = 4
const FIXED_HTTPS_OPTIONS = Object.freeze({
	protocol: 'https:',
	hostname: 'open.bigmodel.cn',
	port: 443,
	method: 'POST',
	path: '/api/paas/v4/layout_parsing',
	rejectUnauthorized: true,
	servername: 'open.bigmodel.cn',
})
const REAL_CLOCK = Object.freeze({
	now: () => performance.now(),
	wallNow: () => Date.now(),
	setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
	clearTimeout: (timer) => clearTimeout(timer),
})
const SAFE_ERROR_SINK = () => {}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const RAW_LABELS = new Set(['image', 'text', 'formula', 'table'])
const CONTRACT_ERRORS = new WeakSet()
const ABORT_ERRORS = new WeakSet()
const INTERNAL_FAILURES = new WeakMap()
const RETRY_HINTS = new WeakMap()
const ATTEMPT_EVENTS = new WeakMap()
const FINAL_DEADLINE_FAILURES = new WeakSet()
const ERROR_SINKS = new WeakSet()
const ABORTED_GETTER = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get
const EVENT_TARGET_ADD = EventTarget.prototype.addEventListener
const EVENT_TARGET_REMOVE = EventTarget.prototype.removeEventListener

const ERROR_TUPLES = deepFreeze({
	GLM_OCR_NOT_CONFIGURED: {
		stage: 'ocr-config',
		provider: 'zhipu',
		class: 'configuration',
		taskErrorClass: 'configuration_permanent',
		terminalStatus: 'failed',
		publicMessageKey: 'provider-configuration-unavailable',
		automaticRetrySameJob: false,
		sameInputNewJobCanRetry: false,
	},
	GLM_OCR_NETWORK_ERROR: {
		stage: 'ocr-provider',
		provider: 'zhipu',
		class: 'transient',
		taskErrorClass: 'transport_transient',
		terminalStatus: 'failed',
		publicMessageKey: 'provider-connection-interrupted',
		automaticRetrySameJob: true,
		sameInputNewJobCanRetry: true,
	},
	GLM_OCR_CONNECT_TIMEOUT: {
		stage: 'ocr-provider',
		provider: 'zhipu',
		class: 'transient',
		taskErrorClass: 'transport_transient',
		terminalStatus: 'failed',
		publicMessageKey: 'provider-timeout',
		automaticRetrySameJob: true,
		sameInputNewJobCanRetry: true,
	},
	GLM_OCR_PAGE_TIMEOUT: {
		stage: 'ocr-provider',
		provider: 'zhipu',
		class: 'transient',
		taskErrorClass: 'transport_transient',
		terminalStatus: 'failed',
		publicMessageKey: 'provider-timeout',
		automaticRetrySameJob: true,
		sameInputNewJobCanRetry: true,
	},
	OCR_STAGE_DEADLINE_EXCEEDED: {
		stage: 'ocr-provider',
		provider: 'zhipu',
		class: 'transient',
		taskErrorClass: 'transport_transient',
		terminalStatus: 'failed',
		publicMessageKey: 'analysis-deadline-exceeded',
		automaticRetrySameJob: false,
		sameInputNewJobCanRetry: true,
	},
	GLM_OCR_HTTP_408: {
		stage: 'ocr-provider',
		provider: 'zhipu',
		class: 'transient',
		taskErrorClass: 'upstream_transient',
		terminalStatus: 'failed',
		publicMessageKey: 'provider-timeout',
		automaticRetrySameJob: true,
		sameInputNewJobCanRetry: true,
	},
	GLM_OCR_RATE_LIMITED: {
		stage: 'ocr-provider',
		provider: 'zhipu',
		class: 'transient',
		taskErrorClass: 'upstream_transient',
		terminalStatus: 'failed',
		publicMessageKey: 'provider-temporarily-unavailable',
		automaticRetrySameJob: true,
		sameInputNewJobCanRetry: true,
	},
	GLM_OCR_PROVIDER_UNAVAILABLE: {
		stage: 'ocr-provider',
		provider: 'zhipu',
		class: 'transient',
		taskErrorClass: 'upstream_transient',
		terminalStatus: 'failed',
		publicMessageKey: 'provider-temporarily-unavailable',
		automaticRetrySameJob: true,
		sameInputNewJobCanRetry: true,
	},
	GLM_OCR_PROVIDER_ERROR: {
		stage: 'ocr-provider',
		provider: 'zhipu',
		class: 'transient',
		taskErrorClass: 'upstream_transient',
		terminalStatus: 'failed',
		publicMessageKey: 'provider-temporarily-unavailable',
		automaticRetrySameJob: false,
		sameInputNewJobCanRetry: true,
	},
	GLM_OCR_BAD_REQUEST: {
		stage: 'ocr-provider',
		provider: 'zhipu',
		class: 'permanent',
		taskErrorClass: 'input_permanent',
		terminalStatus: 'failed',
		publicMessageKey: 'analysis-input-rejected',
		automaticRetrySameJob: false,
		sameInputNewJobCanRetry: false,
	},
	GLM_OCR_CLIENT_ERROR: {
		stage: 'ocr-provider',
		provider: 'zhipu',
		class: 'configuration',
		taskErrorClass: 'configuration_permanent',
		terminalStatus: 'failed',
		publicMessageKey: 'provider-configuration-unavailable',
		automaticRetrySameJob: false,
		sameInputNewJobCanRetry: false,
	},
	GLM_OCR_AUTH_FAILED: {
		stage: 'ocr-provider',
		provider: 'zhipu',
		class: 'configuration',
		taskErrorClass: 'configuration_permanent',
		terminalStatus: 'failed',
		publicMessageKey: 'provider-configuration-unavailable',
		automaticRetrySameJob: false,
		sameInputNewJobCanRetry: false,
	},
	GLM_OCR_FORBIDDEN: {
		stage: 'ocr-provider',
		provider: 'zhipu',
		class: 'configuration',
		taskErrorClass: 'configuration_permanent',
		terminalStatus: 'failed',
		publicMessageKey: 'provider-configuration-unavailable',
		automaticRetrySameJob: false,
		sameInputNewJobCanRetry: false,
	},
	GLM_OCR_INPUT_TOO_LARGE: {
		stage: 'ocr-preflight',
		provider: 'zhipu',
		class: 'permanent',
		taskErrorClass: 'input_permanent',
		terminalStatus: 'failed',
		publicMessageKey: 'analysis-input-rejected',
		automaticRetrySameJob: false,
		sameInputNewJobCanRetry: false,
	},
	GLM_OCR_RESPONSE_INVALID: {
		stage: 'ocr-normalize',
		provider: 'zhipu',
		class: 'evidence',
		taskErrorClass: 'schema_permanent',
		terminalStatus: 'failed',
		publicMessageKey: 'provider-response-invalid',
		automaticRetrySameJob: false,
		sameInputNewJobCanRetry: false,
	},
	GLM_OCR_PAGE_COVERAGE_MISMATCH: {
		stage: 'ocr-normalize',
		provider: 'zhipu',
		class: 'evidence',
		taskErrorClass: 'evidence_permanent',
		terminalStatus: 'failed',
		publicMessageKey: 'evidence-structure-unproven',
		automaticRetrySameJob: false,
		sameInputNewJobCanRetry: false,
	},
})

function deepFreeze(value) {
	if (!value || (typeof value !== 'object' && typeof value !== 'function') || Object.isFrozen(value)) {
		return value
	}
	for (const key of Reflect.ownKeys(value)) deepFreeze(value[key])
	return Object.freeze(value)
}

function contractError(code) {
	const tuple = ERROR_TUPLES[code]
	if (!tuple) throw new TypeError('unknown GLM-OCR error code')
	const error = new Error(tuple.publicMessageKey)
	Object.defineProperty(error, 'name', { value: 'GlmOcrClientError', enumerable: false })
	Object.defineProperty(error, 'stack', {
		value: `GlmOcrClientError: ${tuple.publicMessageKey}`,
		enumerable: false,
		writable: false,
		configurable: false,
	})
	Object.assign(error, {
		code,
		class: tuple.taskErrorClass,
		stage: tuple.stage,
		retryable: tuple.sameInputNewJobCanRetry,
		safeMessageKey: tuple.publicMessageKey,
	})
	CONTRACT_ERRORS.add(error)
	return Object.freeze(error)
}

function abortError() {
	const error = new Error('operation-aborted')
	Object.defineProperty(error, 'name', { value: 'AbortError', enumerable: false })
	Object.defineProperty(error, 'stack', {
		value: 'AbortError: operation-aborted',
		enumerable: false,
		writable: false,
		configurable: false,
	})
	Object.defineProperty(error, 'code', { value: 'ABORT_ERR', enumerable: true })
	ABORT_ERRORS.add(error)
	return Object.freeze(error)
}

function isContractError(error) {
	return Boolean(error && (typeof error === 'object' || typeof error === 'function') && CONTRACT_ERRORS.has(error))
}

function isAbortError(error) {
	return Boolean(error && (typeof error === 'object' || typeof error === 'function') && ABORT_ERRORS.has(error))
}

function internalFailure(kind, details = null) {
	const error = new Error('glm-ocr-internal-transport-failure')
	Object.defineProperty(error, 'name', { value: 'GlmOcrInternalFailure', enumerable: false })
	Object.defineProperty(error, 'stack', {
		value: 'GlmOcrInternalFailure: transport-failed',
		enumerable: false,
		writable: false,
		configurable: false,
	})
	INTERNAL_FAILURES.set(error, Object.freeze({ kind, details }))
	return Object.freeze(error)
}

function getInternalFailure(error) {
	if (!error || (typeof error !== 'object' && typeof error !== 'function')) return null
	return INTERNAL_FAILURES.get(error) || null
}

function setRetryHint(error, hint) {
	if (isContractError(error) && hint && typeof hint === 'object') RETRY_HINTS.set(error, hint)
	return error
}

function getRetryHint(error) {
	if (!error || (typeof error !== 'object' && typeof error !== 'function')) return null
	return RETRY_HINTS.get(error) || null
}

function copyAttemptEvent(from, to) {
	const sequence = ATTEMPT_EVENTS.get(from)
	if (sequence !== undefined && to && (typeof to === 'object' || typeof to === 'function')) {
		ATTEMPT_EVENTS.set(to, sequence)
	}
	if (FINAL_DEADLINE_FAILURES.has(from)
		&& to
		&& (typeof to === 'object' || typeof to === 'function')) {
		FINAL_DEADLINE_FAILURES.add(to)
	}
	return to
}

function isAutomaticRetryError(error) {
	if (!isContractError(error)) return false
	return ERROR_TUPLES[error.code]?.automaticRetrySameJob === true
}

function rejectProxy(value, code) {
	let proxied
	try {
		proxied = isProxy(value)
	} catch {
		throw contractError(code)
	}
	if (proxied) throw contractError(code)
}

function readDataObject(value, allowedKeys, requiredKeys, code) {
	rejectProxy(value, code)
	let prototype
	try {
		prototype = value && typeof value === 'object' ? Object.getPrototypeOf(value) : null
	} catch {
		throw contractError(code)
	}
	if (!value || typeof value !== 'object' || prototype !== Object.prototype) throw contractError(code)
	const allowed = new Set(allowedKeys)
	let keys
	try {
		keys = Reflect.ownKeys(value)
	} catch {
		throw contractError(code)
	}
	if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) throw contractError(code)
	for (const key of requiredKeys) {
		if (!keys.includes(key)) throw contractError(code)
	}

	const snapshot = Object.create(null)
	for (const key of keys) {
		let descriptor
		try {
			descriptor = Object.getOwnPropertyDescriptor(value, key)
		} catch {
			throw contractError(code)
		}
		if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw contractError(code)
		snapshot[key] = descriptor.value
	}
	return snapshot
}

function readDenseArray(value, maximumLength, code) {
	rejectProxy(value, code)
	let arrayValue
	let prototype
	let lengthDescriptor
	try {
		arrayValue = Array.isArray(value)
		prototype = arrayValue ? Object.getPrototypeOf(value) : null
		lengthDescriptor = arrayValue ? Object.getOwnPropertyDescriptor(value, 'length') : null
	} catch {
		throw contractError(code)
	}
	if (!arrayValue
		|| prototype !== Array.prototype
		|| !lengthDescriptor
		|| !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
		|| !Number.isSafeInteger(lengthDescriptor.value)
		|| lengthDescriptor.value < 0
		|| lengthDescriptor.value > maximumLength) {
		throw contractError(code)
	}
	const length = lengthDescriptor.value
	let keys
	try {
		keys = Reflect.ownKeys(value)
	} catch {
		throw contractError(code)
	}
	if (keys.length !== length + 1 || keys[keys.length - 1] !== 'length') throw contractError(code)

	const snapshot = new Array(length)
	for (let index = 0; index < length; index += 1) {
		if (keys[index] !== String(index)) throw contractError(code)
		let descriptor
		try {
			descriptor = Object.getOwnPropertyDescriptor(value, String(index))
		} catch {
			throw contractError(code)
		}
		if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw contractError(code)
		snapshot[index] = descriptor.value
	}
	return snapshot
}

function invalidInput() {
	return contractError('GLM_OCR_BAD_REQUEST')
}

function decodedBase64Length(encodedLength, padding) {
	return (encodedLength / 4) * 3 - padding
}

function hasCanonicalPadBits(source, padding) {
	if (padding === 2) {
		const value = BASE64_ALPHABET.indexOf(source[source.length - 3])
		return value >= 0 && (value & 15) === 0
	}
	if (padding === 1) {
		const value = BASE64_ALPHABET.indexOf(source[source.length - 2])
		return value >= 0 && (value & 3) === 0
	}
	return true
}

function isBase64CharacterCode(code) {
	return (code >= 65 && code <= 90)
		|| (code >= 97 && code <= 122)
		|| (code >= 48 && code <= 57)
		|| code === 43
		|| code === 47
}

function hasCanonicalBase64Grammar(source, offset, encodedLength, padding, checkStage) {
	const dataEnd = source.length - padding
	for (let index = offset; index < dataEnd; index += 1) {
		if (((index - offset) & 65535) === 0) checkStage()
		if (!isBase64CharacterCode(source.charCodeAt(index))) return false
	}
	for (let index = dataEnd; index < source.length; index += 1) {
		if (source.charCodeAt(index) !== 61) return false
	}
	return encodedLength >= 8 && hasCanonicalPadBits(source, padding)
}

function validateJpegDataUri(jpegDataUri, checkStage) {
	checkStage()
	if (typeof jpegDataUri !== 'string' || !jpegDataUri.startsWith(JPEG_DATA_URI_PREFIX)) {
		throw invalidInput()
	}
	const offset = JPEG_DATA_URI_PREFIX.length
	const encodedLength = jpegDataUri.length - offset
	if (encodedLength > MAX_CANONICAL_BASE64_CHARS) throw contractError('GLM_OCR_INPUT_TOO_LARGE')
	if (encodedLength < 8 || encodedLength % 4 !== 0) throw invalidInput()
	const padding = jpegDataUri.endsWith('==') ? 2 : jpegDataUri.endsWith('=') ? 1 : 0
	const byteLength = decodedBase64Length(encodedLength, padding)
	if (byteLength >= MAX_PAGE_BYTES) throw contractError('GLM_OCR_INPUT_TOO_LARGE')
	if (byteLength < 4) throw invalidInput()
	if (!hasCanonicalBase64Grammar(jpegDataUri, offset, encodedLength, padding, checkStage)) throw invalidInput()

	const firstBytes = Buffer.from(jpegDataUri.slice(offset, offset + 4), 'base64')
	const lastBytes = Buffer.from(jpegDataUri.slice(-8), 'base64')
	if (firstBytes[0] !== 0xff || firstBytes[1] !== 0xd8
		|| lastBytes[lastBytes.length - 2] !== 0xff || lastBytes[lastBytes.length - 1] !== 0xd9) {
		throw invalidInput()
	}
	checkStage()
	return jpegDataUri
}

function snapshotPages(pages, checkStage) {
	checkStage()
	const values = readDenseArray(pages, MAX_PAGES, 'GLM_OCR_BAD_REQUEST')
	if (values.length < 1) throw invalidInput()
	const snapshot = values.map((value, index) => {
		checkStage()
		const page = readDataObject(
			value,
			['pageNumber', 'jpegDataUri'],
			['pageNumber', 'jpegDataUri'],
			'GLM_OCR_BAD_REQUEST'
		)
		if (page.pageNumber !== index + 1) throw invalidInput()
		return Object.freeze({
			pageNumber: page.pageNumber,
			jpegDataUri: validateJpegDataUri(page.jpegDataUri, checkStage),
		})
	})
	checkStage()
	return Object.freeze(snapshot)
}

function snapshotParseOptions(options) {
	if (options === undefined) return Object.freeze({ signal: undefined, aborted: false })
	const values = readDataObject(options, ['signal'], [], 'GLM_OCR_BAD_REQUEST')
	const signal = values.signal
	if (signal === undefined) return Object.freeze({ signal: undefined, aborted: false })
	if (!signal || (typeof signal !== 'object' && typeof signal !== 'function')) {
		throw invalidInput()
	}
	rejectProxy(signal, 'GLM_OCR_BAD_REQUEST')
	let aborted
	try {
		aborted = ABORTED_GETTER.call(signal)
	} catch {
		throw invalidInput()
	}
	return Object.freeze({ signal, aborted })
}

function snapshotClientConfig(config) {
	if (config === undefined) config = {}
	const values = readDataObject(config, ['__testing'], [], 'GLM_OCR_CLIENT_ERROR')
	let apiKey = process.env.ZHIPU_GLM_OCR_API_KEY
	let transport = null
	let requestFactory = https.request
	let clock = REAL_CLOCK
	let decompressorFactory = makeDecompressor
	let pageConcurrency = DEFAULT_PAGE_CONCURRENCY
	if (values.__testing !== undefined) {
		if (isProductionRuntime()) throw contractError('GLM_OCR_CLIENT_ERROR')
		const testing = readDataObject(
			values.__testing,
			['apiKey', 'transport', 'requestFactory', 'clock', 'decompressorFactory', 'pageConcurrency'],
			['apiKey'],
			'GLM_OCR_CLIENT_ERROR'
		)
		apiKey = testing.apiKey
		const hasTransport = testing.transport !== undefined
		const hasRequestFactory = testing.requestFactory !== undefined
		if (hasTransport === hasRequestFactory) throw contractError('GLM_OCR_CLIENT_ERROR')
		if (hasTransport) {
			if (typeof testing.transport !== 'function'
				|| testing.decompressorFactory !== undefined) {
				throw contractError('GLM_OCR_CLIENT_ERROR')
			}
			rejectProxy(testing.transport, 'GLM_OCR_CLIENT_ERROR')
			transport = testing.transport
			requestFactory = null
		} else {
			if (typeof testing.requestFactory !== 'function') throw contractError('GLM_OCR_CLIENT_ERROR')
			rejectProxy(testing.requestFactory, 'GLM_OCR_CLIENT_ERROR')
			requestFactory = testing.requestFactory
			if (testing.decompressorFactory !== undefined) {
				if (typeof testing.decompressorFactory !== 'function') {
					throw contractError('GLM_OCR_CLIENT_ERROR')
				}
				rejectProxy(testing.decompressorFactory, 'GLM_OCR_CLIENT_ERROR')
				decompressorFactory = testing.decompressorFactory
			}
		}
		if (testing.clock !== undefined) {
			const clockFields = readDataObject(
				testing.clock,
				['now', 'wallNow', 'setTimeout', 'clearTimeout'],
				['now', 'wallNow', 'setTimeout', 'clearTimeout'],
				'GLM_OCR_CLIENT_ERROR'
			)
			if (typeof clockFields.now !== 'function'
				|| typeof clockFields.wallNow !== 'function'
				|| typeof clockFields.setTimeout !== 'function'
				|| typeof clockFields.clearTimeout !== 'function') {
				throw contractError('GLM_OCR_CLIENT_ERROR')
			}
			rejectProxy(clockFields.now, 'GLM_OCR_CLIENT_ERROR')
			rejectProxy(clockFields.wallNow, 'GLM_OCR_CLIENT_ERROR')
			rejectProxy(clockFields.setTimeout, 'GLM_OCR_CLIENT_ERROR')
			rejectProxy(clockFields.clearTimeout, 'GLM_OCR_CLIENT_ERROR')
			clock = Object.freeze({
				now: clockFields.now,
				wallNow: clockFields.wallNow,
				setTimeout: clockFields.setTimeout,
				clearTimeout: clockFields.clearTimeout,
			})
		}
		if (testing.pageConcurrency !== undefined) {
			if (!Number.isInteger(testing.pageConcurrency)
				|| testing.pageConcurrency < 1
				|| testing.pageConcurrency > HARD_PAGE_CONCURRENCY_CAP) {
				throw contractError('GLM_OCR_CLIENT_ERROR')
			}
			pageConcurrency = testing.pageConcurrency
		}
	}
	if (apiKey === '') apiKey = undefined
	if (apiKey !== undefined && (typeof apiKey !== 'string'
		|| apiKey.length < 1
		|| apiKey.length > 4096
		|| !/^[\x21-\x7e]+$/.test(apiKey))) {
		throw contractError('GLM_OCR_NOT_CONFIGURED')
	}
	return Object.freeze({
		apiKey,
		transport,
		requestFactory,
		clock,
		decompressorFactory,
		pageConcurrency,
	})
}

function hasOnlyUnicodeScalars(value) {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index)
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1)
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false
			index += 1
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return false
		}
	}
	return true
}

function assertBoundedString(value, maximumChars, allowEmpty = true) {
	return typeof value === 'string'
		&& (allowEmpty || value.length > 0)
		&& value.length <= maximumChars
		&& !value.includes('\u0000')
		&& hasOnlyUnicodeScalars(value)
}

function assertTokenCount(value) {
	return Number.isSafeInteger(value) && value >= 0
}

function assertPositiveDimension(value) {
	return Number.isSafeInteger(value) && value > 0 && value <= MAX_PROVIDER_DIMENSION
}

function responseInvalid() {
	return contractError('GLM_OCR_RESPONSE_INVALID')
}


function validateKnownMetadata(raw) {
	if (!assertBoundedString(raw.id, 1024, false)
		|| !Number.isSafeInteger(raw.created)
		|| raw.created < 0) {
		throw contractError('GLM_OCR_RESPONSE_INVALID')
	}
	if (raw.request_id !== undefined && !assertBoundedString(raw.request_id, 1024, false)) {
		throw contractError('GLM_OCR_RESPONSE_INVALID')
	}
	if (raw.md_results !== undefined && !assertBoundedString(raw.md_results, MAX_METADATA_STRING_CHARS)) {
		throw contractError('GLM_OCR_RESPONSE_INVALID')
	}
	if (raw.layout_visualization !== undefined) {
		const values = readDenseArray(raw.layout_visualization, MAX_PAGES, 'GLM_OCR_RESPONSE_INVALID')
		if (values.some((value) => !assertBoundedString(value, MAX_VISUALIZATION_STRING_CHARS))) {
			throw contractError('GLM_OCR_RESPONSE_INVALID')
		}
	}
	if (raw.usage !== undefined) validateUsage(raw.usage)
}

function validateUsage(value) {
	const usage = readDataObject(
		value,
		['prompt_tokens', 'completion_tokens', 'prompt_tokens_details', 'total_tokens'],
		[],
		'GLM_OCR_RESPONSE_INVALID'
	)
	for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
		if (usage[key] !== undefined && !assertTokenCount(usage[key])) {
			throw contractError('GLM_OCR_RESPONSE_INVALID')
		}
	}
	if (usage.prompt_tokens_details !== undefined) {
		const details = readDataObject(
			usage.prompt_tokens_details,
			['cached_tokens'],
			[],
			'GLM_OCR_RESPONSE_INVALID'
		)
		if (details.cached_tokens !== undefined && !assertTokenCount(details.cached_tokens)) {
			throw contractError('GLM_OCR_RESPONSE_INVALID')
		}
	}
}

function normalizeDataInfo(value) {
	const dataInfo = readDataObject(
		value,
		['num_pages', 'pages'],
		['num_pages', 'pages'],
		'GLM_OCR_RESPONSE_INVALID'
	)
	if (!Number.isInteger(dataInfo.num_pages) || dataInfo.num_pages < 1 || dataInfo.num_pages > MAX_PAGES) {
		throw contractError('GLM_OCR_RESPONSE_INVALID')
	}
	const pages = readDenseArray(dataInfo.pages, MAX_PAGES, 'GLM_OCR_RESPONSE_INVALID')
	const normalizedPages = pages.map((page) => {
		const fields = readDataObject(page, ['width', 'height'], ['width', 'height'], 'GLM_OCR_RESPONSE_INVALID')
		if (!assertPositiveDimension(fields.width) || !assertPositiveDimension(fields.height)) {
			throw contractError('GLM_OCR_RESPONSE_INVALID')
		}
		return { width: fields.width, height: fields.height }
	})
	if (dataInfo.num_pages !== normalizedPages.length) {
		throw contractError('GLM_OCR_PAGE_COVERAGE_MISMATCH')
	}
	return { num_pages: dataInfo.num_pages, pages: normalizedPages }
}

function normalizeRegion(value, dimensions) {
	const region = readDataObject(
		value,
		['index', 'label', 'bbox_2d', 'content', 'height', 'width'],
		['index', 'label', 'bbox_2d', 'content', 'height', 'width'],
		'GLM_OCR_RESPONSE_INVALID'
	)
	if (!Number.isInteger(region.index) || region.index < 1 || region.index > MAX_REGIONS_PER_PAGE
		|| !RAW_LABELS.has(region.label)
		|| !assertBoundedString(region.content, MAX_REGION_CONTENT_CHARS)
		|| !assertPositiveDimension(region.width)
		|| !assertPositiveDimension(region.height)
		|| region.width !== dimensions.width
		|| region.height !== dimensions.height) {
		throw contractError('GLM_OCR_RESPONSE_INVALID')
	}

	const bbox = readDenseArray(region.bbox_2d, 4, 'GLM_OCR_RESPONSE_INVALID')
	if (bbox.length !== 4 || bbox.some((coordinate) => (
		typeof coordinate !== 'number'
		|| !Number.isFinite(coordinate)
		|| coordinate < 0
		|| coordinate > 1
	)) || bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) {
		throw contractError('GLM_OCR_RESPONSE_INVALID')
	}
	return {
		index: region.index,
		label: region.label,
		bbox_2d: bbox.slice(),
		content: region.label === 'image' ? '' : region.content,
		height: region.height,
		width: region.width,
	}
}

function normalizeLayoutDetails(value, dataInfo) {
	const pageLayouts = readDenseArray(value, MAX_PAGES, 'GLM_OCR_RESPONSE_INVALID')
	if (pageLayouts.length !== dataInfo.num_pages) {
		throw contractError('GLM_OCR_PAGE_COVERAGE_MISMATCH')
	}
	return pageLayouts.map((page, pageIndex) => {
		const regions = readDenseArray(page, MAX_REGIONS_PER_PAGE, 'GLM_OCR_RESPONSE_INVALID')
		return regions.map((region) => normalizeRegion(region, dataInfo.pages[pageIndex]))
	})
}

function normalizeSuccessEnvelope(rawValue) {
	const raw = readDataObject(
		rawValue,
		['id', 'created', 'model', 'md_results', 'layout_details', 'layout_visualization', 'data_info', 'usage', 'request_id'],
		['id', 'created', 'model', 'layout_details', 'data_info'],
		'GLM_OCR_RESPONSE_INVALID'
	)
	validateKnownMetadata(raw)
	if (typeof raw.model !== 'string'
		|| !/^[A-Za-z0-9-]+$/.test(raw.model)
		|| raw.model.toLowerCase() !== GLM_OCR_MODEL) {
		throw contractError('GLM_OCR_RESPONSE_INVALID')
	}

	const dataInfo = normalizeDataInfo(raw.data_info)
	const layoutDetails = normalizeLayoutDetails(raw.layout_details, dataInfo)
	if (dataInfo.num_pages !== 1) throw contractError('GLM_OCR_PAGE_COVERAGE_MISMATCH')
	return deepFreeze({ model: GLM_OCR_MODEL, layoutDetails, dataInfo })
}

function httpErrorCode(status) {
	if (status === 400) return 'GLM_OCR_BAD_REQUEST'
	if (status === 401) return 'GLM_OCR_AUTH_FAILED'
	if (status === 403) return 'GLM_OCR_FORBIDDEN'
	if (status === 408) return 'GLM_OCR_HTTP_408'
	if (status === 413) return 'GLM_OCR_INPUT_TOO_LARGE'
	if (status === 429) return 'GLM_OCR_RATE_LIMITED'
	if ([500, 502, 503, 504].includes(status)) return 'GLM_OCR_PROVIDER_UNAVAILABLE'
	if (status >= 300 && status <= 499) return 'GLM_OCR_CLIENT_ERROR'
	if (status >= 500 && status <= 599) return 'GLM_OCR_PROVIDER_ERROR'
	return 'GLM_OCR_RESPONSE_INVALID'
}

function callerSignalAborted(signal) {
	if (!signal) return false
	try {
		return ABORTED_GETTER.call(signal)
	} catch {
		throw contractError('GLM_OCR_BAD_REQUEST')
	}
}

function createExecutionGuard(clock, callerSignal) {
	let lastNow = -Infinity
	function monotonicNow() {
		let value
		try { value = clock.now() } catch (_) { throw contractError('GLM_OCR_CLIENT_ERROR') }
		if (typeof value !== 'number' || !Number.isFinite(value) || value < lastNow) {
			throw contractError('GLM_OCR_CLIENT_ERROR')
		}
		lastNow = value
		return value
	}

	const startedAt = monotonicNow()
	const deadline = startedAt + STAGE_DEADLINE_MS
	const controller = new AbortController()
	const batchController = new AbortController()
	let terminalKind = null
	let terminalError = null
	let terminalSequence = null
	let eventSequence = 0
	let batchFailure = null
	let batchFailureSequence = null
	let stageTimer = null
	let callerListener = null
	let rejectTerminal
	let rejectBatch
	const terminalPromise = new Promise((_resolve, reject) => { rejectTerminal = reject })
	const batchPromise = new Promise((_resolve, reject) => { rejectBatch = reject })
	terminalPromise.catch(() => {})
	batchPromise.catch(() => {})

	function settle(kind) {
		if (terminalKind) return false
		eventSequence += 1
		terminalKind = kind
		terminalSequence = eventSequence
		terminalError = internalFailure(kind)
		rejectTerminal(terminalError)
		try { controller.abort() } catch (_) {}
		return true
	}

	try {
		stageTimer = clock.setTimeout(() => settle('stage-deadline'), STAGE_DEADLINE_MS)
	} catch (_) {
		throw contractError('GLM_OCR_CLIENT_ERROR')
	}
	if (terminalKind && stageTimer !== null) {
		try { clock.clearTimeout(stageTimer) } catch (_) {}
		stageTimer = null
	}
	if (callerSignal) {
		callerListener = () => settle('caller-abort')
		EVENT_TARGET_ADD.call(callerSignal, 'abort', callerListener, { once: true })
		if (callerSignalAborted(callerSignal)) settle('caller-abort')
	}

	function check() {
		checkDeadlines()
	}

	function checkWork() {
		checkWorkDeadlines()
	}

	function checkWorkDeadlines(pageDeadline = null, connectDeadline = null) {
		checkDeadlines(pageDeadline, connectDeadline)
		if (batchFailure) throw internalFailure('peer-cancel')
	}

	function checkDeadlines(pageDeadline = null, connectDeadline = null) {
		if (terminalError) throw terminalError
		const now = monotonicNow()
		const due = [
			{ kind: 'stage-deadline', at: deadline, priority: 0 },
			{ kind: 'page-timeout', at: pageDeadline, priority: 1 },
			{ kind: 'connect-timeout', at: connectDeadline, priority: 2 },
		]
			.filter((entry) => entry.at !== null && entry.at <= now)
			.sort((left, right) => left.at - right.at || left.priority - right.priority)[0]
		if (!due) return now
		if (due.kind === 'stage-deadline') {
			settle('stage-deadline')
			throw terminalError
		}
		const failure = internalFailure(due.kind)
		if (deadline <= now && due.at < deadline) FINAL_DEADLINE_FAILURES.add(failure)
		throw failure
	}

	async function sleep(milliseconds) {
		check()
		if (milliseconds <= 0) return
		let timer = null
		let resolveSleeper
		const sleeper = new Promise((resolve) => { resolveSleeper = resolve })
		try {
			timer = clock.setTimeout(resolveSleeper, milliseconds)
		} catch (_) {
			throw contractError('GLM_OCR_CLIENT_ERROR')
		}
		try {
			await Promise.race([sleeper, terminalPromise, batchPromise])
			checkWork()
		} finally {
			if (timer !== null) {
				try { clock.clearTimeout(timer) } catch (_) {}
			}
		}
	}

	function cleanup() {
		if (stageTimer !== null) {
			try { clock.clearTimeout(stageTimer) } catch (_) {}
			stageTimer = null
		}
		if (callerSignal && callerListener) {
			try { EVENT_TARGET_REMOVE.call(callerSignal, 'abort', callerListener) } catch (_) {}
		}
		callerListener = null
	}

	function markAttempt(value) {
		if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value
		const failure = getInternalFailure(value)
		if (failure && ['caller-abort', 'stage-deadline'].includes(failure.kind)) return value
		eventSequence += 1
		ATTEMPT_EVENTS.set(value, eventSequence)
		return value
	}

	function transferAttempt(from, to) {
		return copyAttemptEvent(from, to)
	}

	function terminalWinsAgainst(value) {
		if (!terminalError) return false
		const attemptSequence = ATTEMPT_EVENTS.get(value)
		return attemptSequence === undefined || terminalSequence < attemptSequence
	}

	function failBatch(error) {
		if (!error || (typeof error !== 'object' && typeof error !== 'function')) return false
		const sequence = ATTEMPT_EVENTS.get(error) ?? (++eventSequence)
		if (batchFailure && batchFailureSequence <= sequence) return false
		batchFailure = error
		batchFailureSequence = sequence
		if (!batchController.signal.aborted) {
			rejectBatch(internalFailure('peer-cancel'))
			try { batchController.abort() } catch (_) {}
		}
		return true
	}

	function winningFailure() {
		if (!batchFailure) return terminalError
		if (!terminalError) return batchFailure
		return batchFailureSequence < terminalSequence ? batchFailure : terminalError
	}

	return Object.freeze({
		signal: controller.signal,
		batchSignal: batchController.signal,
		check,
		checkWork,
		checkWorkDeadlines,
		checkDeadlines,
		cleanup,
		kind: () => terminalKind,
		failBatch,
		hasBatchFailure: () => Boolean(batchFailure),
		hasTerminal: () => Boolean(terminalError),
		markAttempt,
		now: monotonicNow,
		race: (promise) => Promise.race([Promise.resolve(promise), terminalPromise]),
		sleep,
		winningFailure,
		terminalError: () => terminalError,
		terminalWinsAgainst,
		transferAttempt,
	})
}

function readWallNow(clock) {
	let value
	try { value = clock.wallNow() } catch (_) { throw contractError('GLM_OCR_CLIENT_ERROR') }
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw contractError('GLM_OCR_CLIENT_ERROR')
	}
	return value
}

function parseRawHeaderPairs(response) {
	let rawHeaders
	try {
		rawHeaders = response.rawHeaders
	} catch {
		throw responseInvalid()
	}
	const values = readDenseArray(rawHeaders, 400, 'GLM_OCR_RESPONSE_INVALID')
	if (values.length % 2 !== 0) throw responseInvalid()
	const governed = new Map()
	const governedNames = new Set([
		'content-type',
		'content-length',
		'content-encoding',
		'transfer-encoding',
		'retry-after',
	])
	let totalBytes = 0
	for (let index = 0; index < values.length; index += 2) {
		const name = values[index]
		const value = values[index + 1]
		if (typeof name !== 'string'
			|| typeof value !== 'string'
			|| !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)
			|| /[\u0000\r\n]/.test(value)) {
			throw responseInvalid()
		}
		totalBytes += Buffer.byteLength(name) + Buffer.byteLength(value)
		if (totalBytes > 32768 || value.length > 8192) throw responseInvalid()
		const lowerName = name.toLowerCase()
		if (!governedNames.has(lowerName)) continue
		if (governed.has(lowerName)) throw responseInvalid()
		governed.set(lowerName, value)
	}
	return governed
}

function validateSuccessHeaders(response) {
	const headers = parseRawHeaderPairs(response)
	const contentType = headers.get('content-type')
	if (typeof contentType !== 'string'
		|| !/^application\/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*(?:utf-8|"utf-8"))?[ \t]*$/i.test(contentType)) {
		throw responseInvalid()
	}

	const rawEncoding = headers.get('content-encoding')
	const contentEncoding = rawEncoding === undefined ? 'identity' : rawEncoding.trim().toLowerCase()
	if (!['identity', 'gzip', 'deflate', 'br'].includes(contentEncoding)
		|| (rawEncoding !== undefined && /[,;]/.test(rawEncoding))) {
		throw responseInvalid()
	}

	const transferEncoding = headers.get('transfer-encoding')
	if (transferEncoding !== undefined && transferEncoding.trim().toLowerCase() !== 'chunked') {
		throw responseInvalid()
	}

	const rawLength = headers.get('content-length')
	if (rawLength !== undefined && transferEncoding !== undefined) throw responseInvalid()
	let contentLength = null
	if (rawLength !== undefined) {
		if (!/^(?:0|[1-9][0-9]*)$/.test(rawLength) || rawLength.length > 16) throw responseInvalid()
		contentLength = Number(rawLength)
		if (!Number.isSafeInteger(contentLength)
			|| contentLength < 0
			|| contentLength > RAW_RESPONSE_MAX_BYTES) {
			throw responseInvalid()
		}
	}
	return Object.freeze({ contentEncoding, contentLength })
}

function snapshotRetryAfterHint(response, status) {
	if (status !== 429) return null
	try {
		const value = parseRawHeaderPairs(response).get('retry-after')
		if (typeof value !== 'string'
			|| value.length < 1
			|| !/^[\x09\x20-\x7e]+$/.test(value)) {
			return null
		}
		const trimmed = value.replace(/^[ \t]+|[ \t]+$/g, '')
		if (/^[0-9]+$/.test(trimmed)) {
			let significant = 0
			while (significant < trimmed.length && trimmed.charCodeAt(significant) === 0x30) {
				significant += 1
			}
			const digits = trimmed.length - significant
			if (digits === 0) return Object.freeze({ kind: 'delay', delayMs: 0 })
			if (digits > 2) return Object.freeze({ kind: 'delay', delayMs: RETRY_AFTER_CAP_MS })
			let seconds = 0
			for (let index = significant; index < trimmed.length; index += 1) {
				seconds = (seconds * 10) + (trimmed.charCodeAt(index) - 0x30)
			}
			return Object.freeze({
				kind: 'delay',
				delayMs: Math.min(RETRY_AFTER_CAP_MS, seconds * 1000),
			})
		}
		if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/.test(trimmed)) {
			return null
		}
		const parsed = Date.parse(trimmed)
		if (!Number.isFinite(parsed) || new Date(parsed).toUTCString() !== trimmed) return null
		return Object.freeze({ kind: 'date', epochMs: parsed })
	} catch {
		return null
	}
}

function makeDecompressor(contentEncoding) {
	if (contentEncoding === 'gzip') return zlib.createGunzip()
	if (contentEncoding === 'deflate') return zlib.createInflate()
	if (contentEncoding === 'br') return zlib.createBrotliDecompress()
	return null
}

function inspectStreamChunk(chunk) {
	rejectProxy(chunk, 'GLM_OCR_RESPONSE_INVALID')
	if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) throw responseInvalid()
	let byteLength
	try { byteLength = chunk.byteLength } catch (_) { throw responseInvalid() }
	if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw responseInvalid()
	return { chunk, byteLength }
}

function safeDestroy(value) {
	if (!value) return
	try {
		if (typeof value.destroy === 'function') value.destroy()
	} catch {
		// Destruction is best-effort after the safe terminal state has been chosen.
	}
}

function installErrorSink(value) {
	if (!value || (typeof value !== 'object' && typeof value !== 'function') || ERROR_SINKS.has(value)) return
	try {
		if (typeof value.on === 'function') {
			value.on('error', SAFE_ERROR_SINK)
			ERROR_SINKS.add(value)
		}
	} catch {
		// A terminal object that cannot accept a sink is already outside our control.
	}
}

function safeTerminalDestroy(value) {
	installErrorSink(value)
	safeDestroy(value)
}

function makeHttpsOptions(apiKey, body) {
	return Object.freeze({
		...FIXED_HTTPS_OPTIONS,
		headers: Object.freeze({
			authorization: `Bearer ${apiKey}`,
			'content-type': 'application/json',
			'content-length': Buffer.byteLength(body),
		}),
	})
}

function executeHttpsPage({ requestFactory, decompressorFactory, clock, apiKey, page, executionGuard }) {
	executionGuard.checkWork()
	const signal = executionGuard.signal
	const startedAt = executionGuard.now()
	const pageDeadline = startedAt + PAGE_TIMEOUT_MS

	return new Promise((resolve, reject) => {
		let settled = false
		let terminalHadError = false
		let connected = false
		let request = null
		let response = null
		let socket = null
		let decompressor = null
		let connectTimer = null
		let connectDeadline = null
		let pageTimer = null
		let abortListener = null
		let batchAbortListener = null
		let wireEnded = false
		let decompressorEnded = false
		let responsePaused = false
		const removers = []
		let decodedBuffer = null
		let wireBytes = 0
		let decodedBytes = 0

		function removeListeners() {
			for (const remove of removers.splice(0)) {
				try { remove() } catch (_) {}
			}
			if (signal && abortListener) {
				try { EVENT_TARGET_REMOVE.call(signal, 'abort', abortListener) } catch (_) {}
			}
			abortListener = null
			if (batchAbortListener) {
				try {
					EVENT_TARGET_REMOVE.call(executionGuard.batchSignal, 'abort', batchAbortListener)
				} catch (_) {}
				batchAbortListener = null
			}
			if (connectTimer !== null) {
				try { clock.clearTimeout(connectTimer) } catch (_) {}
				connectTimer = null
			}
			if (pageTimer !== null) {
				try { clock.clearTimeout(pageTimer) } catch (_) {}
				pageTimer = null
			}
		}

		function addListener(emitter, event, handler, once = false, code = 'GLM_OCR_CLIENT_ERROR') {
			rejectProxy(emitter, code)
			let add
			let remove
			try {
				add = once ? emitter.once : emitter.on
				remove = emitter.removeListener
			} catch {
				throw contractError(code)
			}
			if (typeof add !== 'function' || typeof remove !== 'function') throw contractError(code)
			add.call(emitter, event, handler)
			removers.push(() => remove.call(emitter, event, handler))
		}

		function commitFinish(error, value) {
			if (settled) return false
			settled = true
			terminalHadError = Boolean(error)
			executionGuard.markAttempt(error || value)
			if (error) {
				installErrorSink(socket)
				installErrorSink(request)
				installErrorSink(response)
				installErrorSink(decompressor)
				safeDestroy(decompressor)
				safeDestroy(response)
				safeDestroy(request)
				safeDestroy(socket)
			}
			removeListeners()
			if (error) reject(error)
			else resolve(value)
			return true
		}

		function finish(error, value) {
			if (settled) return false
			try {
				checkAttemptDeadlines()
			} catch (deadlineError) {
				return commitFinish(deadlineError)
			}
			return commitFinish(error, value)
		}

		function fail(kind, details = null) {
			finish(internalFailure(kind, details))
		}

		function failResponseInvalid() {
			finish(responseInvalid())
		}

		function checkPageDeadline() {
			executionGuard.checkWorkDeadlines(
				pageDeadline,
				connectDeadline !== null && !connected ? connectDeadline : null
			)
		}

		function checkAttemptDeadlines() {
			executionGuard.checkWorkDeadlines(
				pageDeadline,
				connectDeadline !== null && !connected ? connectDeadline : null
			)
		}

		function clearConnectTimer() {
			if (connectTimer === null) return
			try { clock.clearTimeout(connectTimer) } catch (_) {}
			connectTimer = null
		}

		function clearPageTimer() {
			if (pageTimer === null) return
			try { clock.clearTimeout(pageTimer) } catch (_) {}
			pageTimer = null
		}

		function markConnected() {
			if (settled || connected) return
			try {
				executionGuard.checkWorkDeadlines(pageDeadline, connectDeadline)
			} catch (error) {
				finish(error)
				return
			}
			connected = true
			clearConnectTimer()
		}

		function finalizeDecodedBody(expectedLength) {
			if (settled) return
			try {
				if (!wireEnded || (expectedLength !== null && wireBytes !== expectedLength)) {
					throw responseInvalid()
				}
				checkPageDeadline()
				const bytes = decodedBuffer.subarray(0, decodedBytes)
				const raw = parseStrictJsonBytes(bytes, checkPageDeadline)
				checkPageDeadline()
				const normalized = normalizeSuccessEnvelope(raw)
				checkPageDeadline()
				finish(null, normalized)
			} catch (error) {
				try {
					checkPageDeadline()
				} catch (deadlineError) {
					finish(deadlineError)
					return
				}
				if (getInternalFailure(error) || isContractError(error)) finish(error)
				else failResponseInvalid()
			}
		}

		function handleDecodedChunk(chunk) {
			if (settled) return
			try {
				checkPageDeadline()
				const inspected = inspectStreamChunk(chunk)
				if (inspected.byteLength === 0) return
				if (!decodedBuffer) throw responseInvalid()
				if (decodedBytes + inspected.byteLength > RAW_RESPONSE_MAX_BYTES) throw responseInvalid()
				const bytes = Buffer.from(inspected.chunk)
				bytes.copy(decodedBuffer, decodedBytes)
				decodedBytes += bytes.length
				checkPageDeadline()
			} catch (error) {
				if (getInternalFailure(error) || isContractError(error)) finish(error)
				else failResponseInvalid()
			}
		}

		function attachBody(responseHeaders) {
			try {
				decodedBuffer = Buffer.allocUnsafe(RAW_RESPONSE_MAX_BYTES)
				decompressor = decompressorFactory(responseHeaders.contentEncoding)
				if (decompressor) {
					addListener(decompressor, 'data', handleDecodedChunk, false, 'GLM_OCR_RESPONSE_INVALID')
					addListener(decompressor, 'error', () => failResponseInvalid(), true, 'GLM_OCR_RESPONSE_INVALID')
					addListener(
						decompressor,
						'end',
						() => {
							decompressorEnded = true
							try {
								let consumedBytes
								try { consumedBytes = decompressor.bytesWritten } catch (_) { throw responseInvalid() }
								if (!Number.isSafeInteger(consumedBytes) || consumedBytes !== wireBytes) {
									throw responseInvalid()
								}
								checkPageDeadline()
								finalizeDecodedBody(responseHeaders.contentLength)
							} catch (error) {
								if (getInternalFailure(error) || isContractError(error)) finish(error)
								else failResponseInvalid()
							}
						},
						true,
						'GLM_OCR_RESPONSE_INVALID'
					)
					addListener(decompressor, 'close', () => {
						if (!decompressorEnded && !settled) failResponseInvalid()
					}, true, 'GLM_OCR_RESPONSE_INVALID')
				}

				addListener(response, 'data', (chunk) => {
					if (settled) return
					try {
						checkPageDeadline()
						const inspected = inspectStreamChunk(chunk)
						if (inspected.byteLength === 0) return
						if (wireBytes + inspected.byteLength > RAW_RESPONSE_MAX_BYTES
							|| (responseHeaders.contentLength !== null
								&& wireBytes + inspected.byteLength > responseHeaders.contentLength)) {
							throw responseInvalid()
						}
						const bytes = Buffer.from(inspected.chunk)
						wireBytes += bytes.length
						if (decompressor) {
							if (responsePaused) throw responseInvalid()
							const canContinue = decompressor.write(bytes)
							if (settled) return
							if (!canContinue) {
								let pause
								try { pause = response.pause } catch (_) { throw responseInvalid() }
								if (typeof pause !== 'function') throw responseInvalid()
								pause.call(response)
								responsePaused = true
								addListener(decompressor, 'drain', () => {
									if (settled || !responsePaused) return
									let resume
									try { resume = response.resume } catch (_) { failResponseInvalid(); return }
									if (typeof resume !== 'function') { failResponseInvalid(); return }
									responsePaused = false
									try { resume.call(response) } catch (_) { failResponseInvalid() }
								}, true, 'GLM_OCR_RESPONSE_INVALID')
							}
						} else {
							handleDecodedChunk(bytes)
							if (settled) return
						}
						checkPageDeadline()
					} catch (error) {
						if (getInternalFailure(error) || isContractError(error)) finish(error)
						else failResponseInvalid()
					}
				}, false, 'GLM_OCR_RESPONSE_INVALID')
				addListener(response, 'error', () => fail('network'), true, 'GLM_OCR_RESPONSE_INVALID')
				addListener(response, 'aborted', () => fail('network'), true, 'GLM_OCR_RESPONSE_INVALID')
				addListener(response, 'close', () => {
					if (!wireEnded) fail('network')
				}, true, 'GLM_OCR_RESPONSE_INVALID')
				addListener(response, 'end', () => {
					if (settled) return
					wireEnded = true
					let complete
					try { complete = response.complete } catch (_) { fail('network'); return }
					if (complete !== true) {
						fail('network')
						return
					}
					if (responseHeaders.contentLength !== null && wireBytes !== responseHeaders.contentLength) {
						failResponseInvalid()
						return
					}
					if (decompressor) {
						try { decompressor.end() } catch (_) { failResponseInvalid() }
					} else {
						finalizeDecodedBody(responseHeaders.contentLength)
					}
				}, true, 'GLM_OCR_RESPONSE_INVALID')
			} catch (error) {
				if (getInternalFailure(error) || isContractError(error)) finish(error)
				else failResponseInvalid()
			}
		}

		function handleResponse(incoming) {
			if (settled) {
				safeTerminalDestroy(incoming)
				return
			}
			try {
				response = incoming
				rejectProxy(incoming, 'GLM_OCR_RESPONSE_INVALID')
				if (!connected) {
					fail('connect-timeout')
					return
				}
				checkPageDeadline()
				let status
				try { status = response.statusCode } catch (_) { throw responseInvalid() }
				if (!Number.isInteger(status) || status !== 200) {
					const retryAfterHint = snapshotRetryAfterHint(response, status)
					fail('http', Object.freeze({ status, retryAfterHint }))
					return
				}
				attachBody(validateSuccessHeaders(response))
			} catch (error) {
				if (getInternalFailure(error) || isContractError(error)) finish(error)
				else failResponseInvalid()
			}
		}

		function handleSocket(assignedSocket) {
			if (settled) {
				if (terminalHadError) safeTerminalDestroy(assignedSocket)
				return
			}
			try {
				rejectProxy(assignedSocket, 'GLM_OCR_CLIENT_ERROR')
				socket = assignedSocket
				let reused = false
				try { reused = request.reusedSocket === true } catch (_) { throw contractError('GLM_OCR_CLIENT_ERROR') }
				addListener(socket, 'error', () => fail('network'), true)
				if (reused) markConnected()
				else addListener(socket, 'secureConnect', markConnected, true)
			} catch (error) {
				if (isContractError(error)) finish(error)
				else finish(contractError('GLM_OCR_CLIENT_ERROR'))
			}
		}

		function rejectProtocolSwitch(incoming, upgradedSocket, head) {
			if (settled) {
				safeTerminalDestroy(incoming)
				safeTerminalDestroy(upgradedSocket)
				safeTerminalDestroy(head)
				return
			}
			response = incoming
			safeTerminalDestroy(upgradedSocket)
			safeTerminalDestroy(head)
			finish(responseInvalid())
		}

		try {
			pageTimer = clock.setTimeout(() => fail('page-timeout'), PAGE_TIMEOUT_MS)
			if (settled) {
				clearConnectTimer()
				clearPageTimer()
				return
			}
			if (signal) {
				abortListener = () => fail(
					executionGuard.kind() === 'caller-abort' ? 'caller-abort' : 'stage-deadline'
				)
				EVENT_TARGET_ADD.call(signal, 'abort', abortListener, { once: true })
				if (callerSignalAborted(signal)) {
					abortListener()
					return
				}
			}
			batchAbortListener = () => fail('peer-cancel')
			EVENT_TARGET_ADD.call(
				executionGuard.batchSignal,
				'abort',
				batchAbortListener,
				{ once: true }
			)
			if (callerSignalAborted(executionGuard.batchSignal)) {
				batchAbortListener()
				return
			}

			const body = JSON.stringify({
				model: GLM_OCR_MODEL,
				file: page.jpegDataUri,
				return_crop_images: false,
				need_layout_visualization: false,
			})
			const requestOptions = makeHttpsOptions(apiKey, body)
			checkAttemptDeadlines()
			if (settled) return
			connectDeadline = executionGuard.now() + CONNECT_TIMEOUT_MS
			connectTimer = clock.setTimeout(() => fail('connect-timeout'), CONNECT_TIMEOUT_MS)
			if (settled) {
				clearConnectTimer()
				return
			}
			let synchronousResponse = null
			request = requestFactory(requestOptions, (incoming) => {
				if (!request) synchronousResponse = incoming
				else handleResponse(incoming)
			})
			if (settled) {
				safeTerminalDestroy(request)
				return
			}
			checkAttemptDeadlines()
			rejectProxy(request, 'GLM_OCR_CLIENT_ERROR')
			addListener(request, 'socket', handleSocket, true)
			addListener(request, 'error', () => fail('network'), true)
			addListener(request, 'upgrade', rejectProtocolSwitch, true)
			addListener(request, 'connect', rejectProtocolSwitch, true)
			let end
			try { end = request.end } catch (_) { throw contractError('GLM_OCR_CLIENT_ERROR') }
			if (typeof end !== 'function') throw contractError('GLM_OCR_CLIENT_ERROR')
			if (settled) {
				safeTerminalDestroy(request)
				return
			}
			end.call(request, body)
			checkAttemptDeadlines()
			if (synchronousResponse) handleResponse(synchronousResponse)
		} catch (error) {
			if (getInternalFailure(error) || isContractError(error)) finish(error)
			else fail('network')
		}
	})
}

function makeRequest(apiKey, page, signal) {
	return {
		method: 'POST',
		redirect: 'error',
		headers: Object.freeze({
			authorization: `Bearer ${apiKey}`,
			'content-type': 'application/json',
		}),
		body: JSON.stringify({
			model: GLM_OCR_MODEL,
			file: page.jpegDataUri,
			return_crop_images: false,
			need_layout_visualization: false,
		}),
		signal,
	}
}

async function requestPage(transport, apiKey, page, signal) {
	if (callerSignalAborted(signal)) throw abortError()
	let response
	try {
		const pendingResponse = transport(GLM_OCR_ENDPOINT, makeRequest(apiKey, page, signal))
		rejectProxy(pendingResponse, 'GLM_OCR_RESPONSE_INVALID')
		response = await pendingResponse
		rejectProxy(response, 'GLM_OCR_RESPONSE_INVALID')
	} catch (error) {
		if (callerSignalAborted(signal)) throw abortError()
		if (isContractError(error)) throw error
		throw contractError('GLM_OCR_NETWORK_ERROR')
	}
	if (callerSignalAborted(signal)) throw abortError()

	let status
	try {
		status = response && response.status
	} catch {
		throw contractError('GLM_OCR_RESPONSE_INVALID')
	}
	if (!Number.isInteger(status) || status !== 200) {
		const error = contractError(httpErrorCode(status))
		throw setRetryHint(error, snapshotRetryAfterHint(response, status))
	}

	let raw
	try {
		if (!response || typeof response.json !== 'function') throw new TypeError('missing response reader')
		raw = await response.json()
	} catch (error) {
		if (callerSignalAborted(signal)) throw abortError()
		throw contractError('GLM_OCR_RESPONSE_INVALID')
	}
	if (callerSignalAborted(signal)) throw abortError()
	try {
		return normalizeSuccessEnvelope(raw)
	} catch (error) {
		if (isContractError(error)) throw error
		throw contractError('GLM_OCR_RESPONSE_INVALID')
	}
}

function requestPageWithControlledTransport(runtime, apiKey, page, executionGuard) {
	executionGuard.checkWork()
	const pageStartedAt = executionGuard.now()
	const pageDeadline = pageStartedAt + PAGE_TIMEOUT_MS

	return new Promise((resolve, reject) => {
		const attemptController = new AbortController()
		let settled = false
		let pageTimer = null
		let guardListener = null
		let batchListener = null

		function cleanup() {
			if (pageTimer !== null) {
				try { runtime.clock.clearTimeout(pageTimer) } catch (_) {}
				pageTimer = null
			}
			if (guardListener) {
				try {
					EVENT_TARGET_REMOVE.call(executionGuard.signal, 'abort', guardListener)
				} catch (_) {}
				guardListener = null
			}
			if (batchListener) {
				try {
					EVENT_TARGET_REMOVE.call(executionGuard.batchSignal, 'abort', batchListener)
				} catch (_) {}
				batchListener = null
			}
		}

		function settleError(error) {
			if (settled) return false
			settled = true
			executionGuard.markAttempt(error)
			cleanup()
			try { attemptController.abort() } catch (_) {}
			reject(error)
			return true
		}

		function settleValue(value) {
			if (settled) return false
			settled = true
			executionGuard.markAttempt(value)
			cleanup()
			resolve(value)
			return true
		}

		function controlError() {
			return internalFailure(
				executionGuard.kind() === 'caller-abort' ? 'caller-abort' : 'stage-deadline'
			)
		}

		function checkPageAfterOperation() {
			executionGuard.checkWorkDeadlines(pageDeadline, null)
		}

		guardListener = () => settleError(controlError())
		EVENT_TARGET_ADD.call(executionGuard.signal, 'abort', guardListener, { once: true })
		if (callerSignalAborted(executionGuard.signal)) {
			guardListener()
			return
		}
		batchListener = () => settleError(internalFailure('peer-cancel'))
		EVENT_TARGET_ADD.call(
			executionGuard.batchSignal,
			'abort',
			batchListener,
			{ once: true }
		)
		if (callerSignalAborted(executionGuard.batchSignal)) {
			batchListener()
			return
		}
		try {
			pageTimer = runtime.clock.setTimeout(
				() => {
					try {
						checkPageAfterOperation()
						settleError(internalFailure('page-timeout'))
					} catch (error) {
						settleError(error)
					}
				},
				PAGE_TIMEOUT_MS
			)
		} catch (_) {
			settleError(contractError('GLM_OCR_CLIENT_ERROR'))
			return
		}
		if (settled) {
			cleanup()
			return
		}
		try {
			checkPageAfterOperation()
		} catch (error) {
			settleError(error)
			return
		}

		let operation
		try {
			operation = requestPage(runtime.transport, apiKey, page, attemptController.signal)
		} catch (error) {
			settleError(isContractError(error) ? error : contractError('GLM_OCR_NETWORK_ERROR'))
			return
		}
		Promise.resolve(operation).then(
			(value) => {
				if (settled) return
				try {
					checkPageAfterOperation()
					settleValue(value)
				} catch (error) {
					settleError(error)
				}
			},
			(error) => {
				if (settled) return
				try {
					checkPageAfterOperation()
					settleError(error)
				} catch (deadlineError) {
					settleError(deadlineError)
				}
			}
		)
	})
}

async function requestPageWithHttps(runtime, apiKey, page, executionGuard) {
	try {
		return await executeHttpsPage({
			requestFactory: runtime.requestFactory,
			decompressorFactory: runtime.decompressorFactory,
			clock: runtime.clock,
			apiKey,
			page,
			executionGuard,
		})
	} catch (error) {
		const failure = getInternalFailure(error)
		if (failure) {
			if (failure.kind === 'peer-cancel') throw error
			if (failure.kind === 'caller-abort') {
				throw executionGuard.transferAttempt(error, abortError())
			}
			if (failure.kind === 'stage-deadline') {
				throw executionGuard.transferAttempt(
					error,
					contractError('OCR_STAGE_DEADLINE_EXCEEDED')
				)
			}
			if (failure.kind === 'connect-timeout') {
				throw executionGuard.transferAttempt(error, contractError('GLM_OCR_CONNECT_TIMEOUT'))
			}
			if (failure.kind === 'page-timeout') {
				throw executionGuard.transferAttempt(error, contractError('GLM_OCR_PAGE_TIMEOUT'))
			}
			if (failure.kind === 'http') {
				const mapped = contractError(httpErrorCode(failure.details && failure.details.status))
				setRetryHint(mapped, failure.details && failure.details.retryAfterHint)
				throw executionGuard.transferAttempt(error, mapped)
			}
			throw executionGuard.transferAttempt(error, contractError('GLM_OCR_NETWORK_ERROR'))
		}
		if (isContractError(error)) throw error
		throw contractError('GLM_OCR_NETWORK_ERROR')
	}
}

function mapAttemptControlError(error) {
	const failure = getInternalFailure(error)
	if (!failure) return error
	if (failure.kind === 'caller-abort') return copyAttemptEvent(error, abortError())
	if (failure.kind === 'stage-deadline') {
		return copyAttemptEvent(error, contractError('OCR_STAGE_DEADLINE_EXCEEDED'))
	}
	if (failure.kind === 'connect-timeout') {
		return copyAttemptEvent(error, contractError('GLM_OCR_CONNECT_TIMEOUT'))
	}
	if (failure.kind === 'page-timeout') {
		return copyAttemptEvent(error, contractError('GLM_OCR_PAGE_TIMEOUT'))
	}
	if (failure.kind === 'peer-cancel') return error
	return copyAttemptEvent(error, contractError('GLM_OCR_NETWORK_ERROR'))
}

function retryAfterDelay(error, clock) {
	if (!isContractError(error) || error.code !== 'GLM_OCR_RATE_LIMITED') {
		return DEFAULT_RETRY_DELAY_MS
	}
	const hint = getRetryHint(error)
	if (!hint) return DEFAULT_RETRY_DELAY_MS
	if (hint.kind === 'delay') return hint.delayMs
	if (hint.kind !== 'date') return DEFAULT_RETRY_DELAY_MS
	const delay = Math.ceil(hint.epochMs - readWallNow(clock))
	return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, delay))
}

class SharedAttemptPool {
	constructor(limit) {
		this.limit = limit
		this.active = 0
		this.head = null
		this.tail = null
	}

	acquire(executionGuard) {
		try { executionGuard.checkWork() } catch (error) { return Promise.reject(error) }
		if (this.active < this.limit && this.head === null) return this.createRelease()
		return new Promise((resolve, reject) => {
			const node = {
				prev: this.tail,
				next: null,
				state: 'queued',
				resolve,
				reject,
				executionGuard,
				executionListener: null,
				batchListener: null,
			}
			if (this.tail) this.tail.next = node
			else this.head = node
			this.tail = node

			const cancel = (kind) => {
				if (node.state !== 'queued') return
				this.remove(node)
				node.state = 'cancelled'
				this.detach(node)
				reject(internalFailure(kind))
			}
			node.executionListener = () => cancel(
				executionGuard.kind() === 'caller-abort' ? 'caller-abort' : 'stage-deadline'
			)
			node.batchListener = () => cancel('peer-cancel')
			EVENT_TARGET_ADD.call(
				executionGuard.signal,
				'abort',
				node.executionListener,
				{ once: true }
			)
			EVENT_TARGET_ADD.call(
				executionGuard.batchSignal,
				'abort',
				node.batchListener,
				{ once: true }
			)
			if (callerSignalAborted(executionGuard.signal)) node.executionListener()
			else if (callerSignalAborted(executionGuard.batchSignal)) node.batchListener()
			this.drain()
		})
	}

	detach(node) {
		if (node.executionListener) {
			try {
				EVENT_TARGET_REMOVE.call(
					node.executionGuard.signal,
					'abort',
					node.executionListener
				)
			} catch (_) {}
			node.executionListener = null
		}
		if (node.batchListener) {
			try {
				EVENT_TARGET_REMOVE.call(
					node.executionGuard.batchSignal,
					'abort',
					node.batchListener
				)
			} catch (_) {}
			node.batchListener = null
		}
	}

	remove(node) {
		if (node.prev) node.prev.next = node.next
		else if (this.head === node) this.head = node.next
		if (node.next) node.next.prev = node.prev
		else if (this.tail === node) this.tail = node.prev
		node.prev = null
		node.next = null
	}

	drain() {
		while (this.active < this.limit && this.head) {
			const node = this.head
			this.remove(node)
			if (node.state !== 'queued') continue
			node.state = 'active'
			this.detach(node)
			node.resolve(this.createRelease())
		}
	}

	createRelease() {
		this.active += 1
		let released = false
		return () => {
			if (released) return false
			released = true
			this.active -= 1
			this.drain()
			return true
		}
	}
}

async function executePageWithRetry(page, runtime, apiKey, executionGuard, pool) {
	for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_PAGE; attempt += 1) {
		executionGuard.checkWork()
		const ticket = pool.acquire(executionGuard)
		const release = typeof ticket === 'function' ? ticket : await ticket
		let retryError = null
		try {
			let normalized
			let caught = null
			try {
				executionGuard.checkWork()
				normalized = runtime.transport
					? await requestPageWithControlledTransport(runtime, apiKey, page, executionGuard)
					: await requestPageWithHttps(runtime, apiKey, page, executionGuard)
			} catch (error) {
				caught = error
			}
			if (!caught) return normalized

			const error = mapAttemptControlError(caught)
			const finalOutcome = isAbortError(error)
				|| !isAutomaticRetryError(error)
				|| attempt >= MAX_ATTEMPTS_PER_PAGE
				|| FINAL_DEADLINE_FAILURES.has(error)
			if (finalOutcome) {
				const failure = getInternalFailure(error)
				if ((!failure || failure.kind !== 'peer-cancel')
					&& !isAbortError(error)
					&& error.code !== 'OCR_STAGE_DEADLINE_EXCEEDED') {
					executionGuard.failBatch(error)
				}
				if (executionGuard.terminalWinsAgainst(error)) {
					throw mapAttemptControlError(executionGuard.terminalError())
				}
				throw error
			}
			retryError = error
		} finally {
			release()
		}
		executionGuard.checkWork()
		const delay = retryAfterDelay(retryError, runtime.clock)
		await executionGuard.sleep(delay)
	}
	throw contractError('GLM_OCR_NETWORK_ERROR')
}

async function runWithSharedPool(pages, runtime, apiKey, executionGuard, pool) {
	const results = new Array(pages.length)
	const outcomes = new Array(pages.length)
	let nextIndex = 0
	let completedCount = 0

	async function worker() {
		while (true) {
			const index = nextIndex
			if (index >= pages.length) return
			try { executionGuard.checkWork() } catch (error) { throw error }
			nextIndex += 1
			const page = pages[index]
			try {
				const normalized = await executePageWithRetry(
					page,
					runtime,
					apiKey,
					executionGuard,
					pool
				)
				outcomes[index] = normalized
				results[index] = copyAttemptEvent(normalized, {
					pageNumber: page.pageNumber,
					layoutDetails: normalized.layoutDetails,
					dataInfo: normalized.dataInfo,
				})
				completedCount += 1
			} catch (caught) {
				const error = mapAttemptControlError(caught)
				const failure = getInternalFailure(error)
				if ((!failure || failure.kind !== 'peer-cancel')
					&& !isAbortError(error)
					&& error.code !== 'OCR_STAGE_DEADLINE_EXCEEDED') {
					executionGuard.failBatch(error)
				}
				throw error
			}
		}
	}

	const workers = Array.from(
		{ length: Math.min(pool.limit, pages.length) },
		() => worker()
	)
	const settled = await Promise.allSettled(workers)
	if (executionGuard.hasBatchFailure()) {
		throw mapAttemptControlError(executionGuard.winningFailure())
	}

	const allSucceeded = completedCount === pages.length
	if (allSucceeded && executionGuard.hasTerminal()) {
		let lastOutcome = null
		let lastSequence = -Infinity
		for (const outcome of outcomes) {
			const sequence = ATTEMPT_EVENTS.get(outcome)
			if (sequence !== undefined && sequence > lastSequence) {
				lastSequence = sequence
				lastOutcome = outcome
			}
		}
		if (!lastOutcome || executionGuard.terminalWinsAgainst(lastOutcome)) {
			throw mapAttemptControlError(executionGuard.terminalError())
		}
	}
	if (!allSucceeded && executionGuard.hasTerminal()) {
		throw mapAttemptControlError(executionGuard.terminalError())
	}
	const rejected = settled.find((entry) => entry.status === 'rejected')
	if (rejected) throw mapAttemptControlError(rejected.reason)

	return deepFreeze({
		schemaVersion: CLIENT_SCHEMA_VERSION,
		provider: 'zhipu-layout-parsing',
		model: GLM_OCR_MODEL,
		pages: results,
	})
}

function createGlmOcrClient(config) {
	const snapshot = snapshotClientConfig(config)
	const pool = new SharedAttemptPool(snapshot.pageConcurrency)
	const runtime = Object.freeze({
		transport: snapshot.transport,
		requestFactory: snapshot.requestFactory,
		decompressorFactory: snapshot.decompressorFactory,
		clock: snapshot.clock,
	})
	return Object.freeze({
		parsePages(pages, options) {
			const { signal, aborted } = snapshotParseOptions(options)
			if (aborted) throw abortError()
			if (!snapshot.apiKey) throw contractError('GLM_OCR_NOT_CONFIGURED')
			const executionGuard = createExecutionGuard(runtime.clock, signal)
			let pageSnapshot
			try {
				pageSnapshot = snapshotPages(pages, executionGuard.check)
			} catch (caught) {
				executionGuard.cleanup()
				throw mapAttemptControlError(caught)
			}
			return runWithSharedPool(pageSnapshot, runtime, snapshot.apiKey, executionGuard, pool)
				.catch((error) => { throw mapAttemptControlError(error) })
				.finally(() => executionGuard.cleanup())
		},
	})
}

module.exports = { createGlmOcrClient }
