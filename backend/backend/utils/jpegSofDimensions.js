'use strict'

const { isProxy } = require('node:util').types

const DEFAULT_MAX_PIXELS = 25_000_000
const DEFAULT_MAX_HEADER_BYTES = 1_048_576
const DEFAULT_MAX_MARKERS = 4096
const DEFAULT_MAX_BYTES = (9 * 1024 * 1024) - 1
const DEFAULT_MAX_DIMENSION = 20_000
const SOF_MARKERS = new Set([
	0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
	0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])
const OPTION_KEYS = new Set([
	'maxPixels', 'maxHeaderBytes', 'maxMarkers', 'maxBytes', 'maxDimension',
])

const reflectApply = Reflect.apply
const reflectOwnKeys = Reflect.ownKeys
const getPrototypeOf = Object.getPrototypeOf
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const hasOwn = Function.call.bind(Object.prototype.hasOwnProperty)
const bufferIsBuffer = Buffer.isBuffer
const bufferAllocUnsafe = Buffer.allocUnsafe
const Uint8ArrayIntrinsic = Uint8Array
const typedArrayPrototype = getPrototypeOf(Uint8Array.prototype)
const typedArrayBuffer = getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get
const typedArrayByteOffset = getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get
const typedArrayByteLength = getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get
const typedArraySet = Uint8Array.prototype.set
const sharedArrayBufferByteLength = typeof SharedArrayBuffer === 'function'
	? getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength').get
	: null

function jpegError(code) {
	const error = new TypeError(code)
	Object.defineProperty(error, 'code', {
		value: code, enumerable: true, writable: false, configurable: false,
	})
	Object.defineProperty(error, 'stack', {
		value: `TypeError: ${code}`, enumerable: false, writable: false, configurable: false,
	})
	return Object.freeze(error)
}

function invalid() { throw jpegError('JPEG_SOF_INVALID') }
function unsupported() { throw jpegError('JPEG_SOF_UNSUPPORTED') }
function limitExceeded() { throw jpegError('JPEG_SOF_LIMIT_EXCEEDED') }

function safeIsProxy(value) {
	try { return isProxy(value) } catch { invalid() }
}

function resolveLimit(values, key, defaultValue) {
	if (!hasOwn(values, key)) return defaultValue
	const value = values[key]
	if (!Number.isSafeInteger(value) || value < 1 || value > defaultValue) invalid()
	return value
}

function snapshotOptions(options) {
	const defaults = {
		maxPixels: DEFAULT_MAX_PIXELS,
		maxHeaderBytes: DEFAULT_MAX_HEADER_BYTES,
		maxMarkers: DEFAULT_MAX_MARKERS,
		maxBytes: DEFAULT_MAX_BYTES,
		maxDimension: DEFAULT_MAX_DIMENSION,
	}
	if (options === undefined) return defaults
	if (!options || typeof options !== 'object' || safeIsProxy(options)) invalid()
	let prototype
	let keys
	try {
		prototype = getPrototypeOf(options)
		keys = reflectOwnKeys(options)
	} catch { invalid() }
	if (prototype !== Object.prototype
		|| keys.some((key) => typeof key !== 'string' || !OPTION_KEYS.has(key))) invalid()
	const values = Object.create(null)
	for (const key of keys) {
		let descriptor
		try { descriptor = getOwnPropertyDescriptor(options, key) } catch { invalid() }
		if (!descriptor || !hasOwn(descriptor, 'value')) invalid()
		values[key] = descriptor.value
	}
	return {
		maxPixels: resolveLimit(values, 'maxPixels', defaults.maxPixels),
		maxHeaderBytes: resolveLimit(values, 'maxHeaderBytes', defaults.maxHeaderBytes),
		maxMarkers: resolveLimit(values, 'maxMarkers', defaults.maxMarkers),
		maxBytes: resolveLimit(values, 'maxBytes', defaults.maxBytes),
		maxDimension: resolveLimit(values, 'maxDimension', defaults.maxDimension),
	}
}

function isSharedBacking(value) {
	if (!sharedArrayBufferByteLength) return false
	try {
		reflectApply(sharedArrayBufferByteLength, value, [])
		return true
	} catch { return false }
}

function snapshotBuffer(buffer, maxBytes) {
	if (safeIsProxy(buffer) || !bufferIsBuffer(buffer)) invalid()
	let backing
	let byteOffset
	let byteLength
	try {
		backing = reflectApply(typedArrayBuffer, buffer, [])
		byteOffset = reflectApply(typedArrayByteOffset, buffer, [])
		byteLength = reflectApply(typedArrayByteLength, buffer, [])
	} catch { invalid() }
	if (isSharedBacking(backing)) invalid()
	if (!Number.isSafeInteger(byteLength) || byteLength > maxBytes) limitExceeded()
	try {
		const snapshot = reflectApply(bufferAllocUnsafe, Buffer, [byteLength])
		const source = new Uint8ArrayIntrinsic(backing, byteOffset, byteLength)
		reflectApply(typedArraySet, snapshot, [source])
		return snapshot
	} catch { invalid() }
}

function isApplicationMarker(marker) { return marker >= 0xe0 && marker <= 0xef }
function isRestartMarker(marker) { return marker >= 0xd0 && marker <= 0xd7 }
function readUint16(bytes, offset) { return (bytes[offset] * 256) + bytes[offset + 1] }

function parseJpegSofDimensions(buffer, options) {
	const limits = snapshotOptions(options)
	const bytes = snapshotBuffer(buffer, limits.maxBytes)
	const byteLength = reflectApply(typedArrayByteLength, bytes, [])
	if (byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) invalid()
	let offset = 2
	let markerCount = 1
	let frame = null
	let firstSosSeen = false
	let inEntropy = false
	let pendingMarker = null
	let scanDataBytes = 0
	let restartInterval = 0
	let expectedRestart = 0
	const quantizationTables = new Map()
	const dcHuffmanTables = new Set()
	const acHuffmanTables = new Map()
	const baselineScannedComponents = new Set()
	let progressiveCoefficients = null

	const countMarker = () => {
		markerCount += 1
		if (markerCount > limits.maxMarkers) limitExceeded()
	}
	const readSegmentEnd = () => {
		if (offset + 2 > byteLength) invalid()
		const length = readUint16(bytes, offset)
		if (length < 2) invalid()
		const end = offset + length
		if (end > byteLength) invalid()
		offset += 2
		return { length, end }
	}
	const readMarkerOutsideEntropy = () => {
		if (offset >= byteLength || bytes[offset] !== 0xff) invalid()
		while (offset < byteLength && bytes[offset] === 0xff) offset += 1
		if (offset >= byteLength) invalid()
		const marker = bytes[offset++]
		if (marker === 0x00 || marker === 0xff) invalid()
		countMarker()
		return marker
	}
	const parseDqt = () => {
		const { end } = readSegmentEnd()
		const start = offset
		while (offset < end) {
			const info = bytes[offset++]
			const precision = info >> 4
			const tableId = info & 0x0f
			if (precision > 1 || tableId > 3) invalid()
			const valueBytes = precision === 0 ? 64 : 128
			if (offset + valueBytes > end) invalid()
			for (let index = 0; index < 64; index += 1) {
				const value = precision === 0 ? bytes[offset + index] : readUint16(bytes, offset + (index * 2))
				if (value === 0) invalid()
			}
			offset += valueBytes
			quantizationTables.set(tableId, Object.freeze({ precision }))
		}
		if (offset !== end || offset === start) invalid()
	}
	const parseDht = () => {
		const { end } = readSegmentEnd()
		const start = offset
		while (offset < end) {
			if (offset + 17 > end) invalid()
			const info = bytes[offset++]
			const tableClass = info >> 4
			const tableId = info & 0x0f
			if (tableClass > 1 || tableId > 3) invalid()
			let symbolCount = 0
			let remainingCodeSlots = 1
			for (let index = 0; index < 16; index += 1) {
				const count = bytes[offset + index]
				symbolCount += count
				remainingCodeSlots = (remainingCodeSlots * 2) - count
				if (remainingCodeSlots < 0) invalid()
			}
			if (remainingCodeSlots === 0) invalid()
			offset += 16
			if (symbolCount < 1 || symbolCount > 256 || offset + symbolCount > end) invalid()
			const symbols = new Set()
			let baselineCompatible = true
			for (let index = 0; index < symbolCount; index += 1) {
				const symbol = bytes[offset + index]
				if (symbols.has(symbol)) invalid()
				symbols.add(symbol)
				if (tableClass === 0) {
					if (symbol > 11) invalid()
				} else {
					const run = symbol >> 4
					const size = symbol & 0x0f
					if (size > 10) invalid()
					if (size === 0 && run !== 0 && run !== 15) baselineCompatible = false
				}
			}
			offset += symbolCount
			if (tableClass === 0) dcHuffmanTables.add(tableId)
			else acHuffmanTables.set(tableId, Object.freeze({ baselineCompatible }))
		}
		if (offset !== end || offset === start) invalid()
	}

	while (offset < byteLength || pendingMarker !== null) {
		if (inEntropy) {
			let foundMarker = false
			while (offset < byteLength) {
				if (bytes[offset] !== 0xff) {
					offset += 1
					scanDataBytes += 1
					continue
				}
				offset += 1
				let fillRunLength = 1
				while (offset < byteLength && bytes[offset] === 0xff) {
					offset += 1
					fillRunLength += 1
				}
				if (offset >= byteLength) invalid()
				const marker = bytes[offset++]
				if (marker === 0x00) {
					if (fillRunLength !== 1) invalid()
					scanDataBytes += 1
					continue
				}
				countMarker()
				if (isRestartMarker(marker)) {
					if (restartInterval < 1 || marker !== 0xd0 + expectedRestart || scanDataBytes < 1) invalid()
					expectedRestart = (expectedRestart + 1) & 7
					scanDataBytes = 0
					continue
				}
				if (scanDataBytes < 1) invalid()
				pendingMarker = marker
				inEntropy = false
				foundMarker = true
				break
			}
			if (!foundMarker) invalid()
		}

		const marker = pendingMarker === null ? readMarkerOutsideEntropy() : pendingMarker
		pendingMarker = null
		if (marker === 0xd8 || marker === 0x01 || isRestartMarker(marker)) invalid()
		if (marker === 0xd9) {
			if (!firstSosSeen || !frame || offset !== byteLength) invalid()
			if (frame.marker === 0xc0
				&& frame.componentIds.some((id) => !baselineScannedComponents.has(id))) invalid()
			if (frame.marker === 0xc2
				&& frame.componentIds.some((id) => progressiveCoefficients.get(id)[0] === null)) invalid()
			return Object.freeze({
				frameType: frame.marker === 0xc0 ? 'SOF0' : 'SOF2',
				width: frame.width, height: frame.height, pixels: frame.pixels,
			})
		}
		if (marker === 0xdc || marker === 0xc8 || marker === 0xde || marker === 0xdf || marker === 0xcc) unsupported()
		if (marker === 0xdb) { parseDqt(); continue }
		if (marker === 0xc4) { parseDht(); continue }
		if (marker === 0xdd) {
			const { length, end } = readSegmentEnd()
			if (length !== 4) invalid()
			restartInterval = readUint16(bytes, offset)
			offset = end
			continue
		}
		if (SOF_MARKERS.has(marker)) {
			if (frame || firstSosSeen) invalid()
			if (marker !== 0xc0 && marker !== 0xc2) unsupported()
			const { length, end } = readSegmentEnd()
			if (length !== 17 || offset + 15 !== end) invalid()
			const precision = bytes[offset]
			const height = readUint16(bytes, offset + 1)
			const width = readUint16(bytes, offset + 3)
			if (precision !== 8 || height < 1 || width < 1 || bytes[offset + 5] !== 3) invalid()
			if (width > limits.maxDimension || height > limits.maxDimension) limitExceeded()
			const componentIds = []
			let samplingSum = 0
			for (let index = 0; index < 3; index += 1) {
				const componentOffset = offset + 6 + (index * 3)
				const id = bytes[componentOffset]
				const sampling = bytes[componentOffset + 1]
				const horizontal = sampling >> 4
				const vertical = sampling & 0x0f
				const quantTableId = bytes[componentOffset + 2]
				if (horizontal < 1 || horizontal > 4 || vertical < 1 || vertical > 4
					|| quantTableId > 3) invalid()
				samplingSum += horizontal * vertical
				componentIds.push(id)
			}
			const idSet = new Set(componentIds)
			if (idSet.size !== 3 || !idSet.has(1) || !idSet.has(2) || !idSet.has(3) || samplingSum > 10) invalid()
			const pixels = width * height
			if (!Number.isSafeInteger(pixels) || pixels > limits.maxPixels) limitExceeded()
			frame = {
				marker, width, height, pixels, componentIds,
				quantTableByComponent: new Map([
					[componentIds[0], bytes[offset + 8]],
					[componentIds[1], bytes[offset + 11]],
					[componentIds[2], bytes[offset + 14]],
				]),
			}
			if (marker === 0xc2) {
				progressiveCoefficients = new Map(componentIds.map((id) => [id, new Array(64).fill(null)]))
			}
			offset = end
			continue
		}
		if (marker === 0xda) {
			if (!frame) invalid()
			const { length, end } = readSegmentEnd()
			if (length < 8) invalid()
			const scanComponents = bytes[offset]
			if (scanComponents < 1 || scanComponents > 3 || length !== 6 + (2 * scanComponents)) invalid()
			const seen = new Set()
			const selectors = []
			for (let index = 0; index < scanComponents; index += 1) {
				const componentId = bytes[offset + 1 + (index * 2)]
				const selector = bytes[offset + 2 + (index * 2)]
				const dcTableId = selector >> 4
				const acTableId = selector & 0x0f
				if (!frame.componentIds.includes(componentId) || seen.has(componentId)
					|| dcTableId > 3 || acTableId > 3) invalid()
				const quantTable = quantizationTables.get(frame.quantTableByComponent.get(componentId))
				if (!quantTable || (frame.marker === 0xc0 && quantTable.precision !== 0)) invalid()
				seen.add(componentId)
				selectors.push({ componentId, dcTableId, acTableId })
			}
			const paramsOffset = offset + 1 + (scanComponents * 2)
			const spectralStart = bytes[paramsOffset]
			const spectralEnd = bytes[paramsOffset + 1]
			const approximation = bytes[paramsOffset + 2]
			const high = approximation >> 4
			const low = approximation & 0x0f
			if (frame.marker === 0xc0) {
				if (spectralStart !== 0 || spectralEnd !== 63 || high !== 0 || low !== 0) invalid()
				for (const selector of selectors) {
					if (!dcHuffmanTables.has(selector.dcTableId)
						|| !acHuffmanTables.has(selector.acTableId)
						|| !acHuffmanTables.get(selector.acTableId).baselineCompatible) invalid()
					if (baselineScannedComponents.has(selector.componentId)) invalid()
				}
				for (const selector of selectors) baselineScannedComponents.add(selector.componentId)
			} else {
				if (spectralStart > spectralEnd || spectralEnd > 63
					|| (spectralStart === 0 && spectralEnd !== 0)
					|| (spectralStart > 0 && scanComponents !== 1)
					|| high > 13 || low > 13 || (high !== 0 && high !== low + 1)) invalid()
				for (const selector of selectors) {
					if (spectralStart === 0 && !dcHuffmanTables.has(selector.dcTableId)) invalid()
					if (spectralStart > 0 && !acHuffmanTables.has(selector.acTableId)) invalid()
					const coefficients = progressiveCoefficients.get(selector.componentId)
					if (spectralStart > 0 && coefficients[0] === null) invalid()
					for (let coefficient = spectralStart; coefficient <= spectralEnd; coefficient += 1) {
						if (high === 0) {
							if (coefficients[coefficient] !== null) invalid()
						} else if (coefficients[coefficient] !== high) invalid()
					}
				}
				for (const selector of selectors) {
					const coefficients = progressiveCoefficients.get(selector.componentId)
					for (let coefficient = spectralStart; coefficient <= spectralEnd; coefficient += 1) {
						coefficients[coefficient] = low
					}
				}
			}
			offset = end
			if (!firstSosSeen) {
				firstSosSeen = true
				if (offset > limits.maxHeaderBytes) limitExceeded()
			}
			scanDataBytes = 0
			expectedRestart = 0
			inEntropy = true
			continue
		}
		if (isApplicationMarker(marker) || marker === 0xfe) {
			const { end } = readSegmentEnd()
			offset = end
			continue
		}
		unsupported()
	}
	invalid()
}

module.exports = { parseJpegSofDimensions }
