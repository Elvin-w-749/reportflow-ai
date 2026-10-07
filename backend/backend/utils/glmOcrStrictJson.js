'use strict'

const RAW_RESPONSE_MAX_BYTES = 16 * 1024 * 1024
const JSON_MAX_DEPTH = 32
const JSON_MAX_NODES = 200000
const JSON_MAX_KEY_CHARS = 128
const JSON_MAX_OBJECT_KEYS = 64
const JSON_MAX_ARRAY_ITEMS = 5000
const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const JSON_SIMPLE_ESCAPE_CODES = new Set([0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74])

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
function responseInvalid() {
	const error = new SyntaxError('strict-json-invalid')
	Object.defineProperty(error, 'stack', {
		value: 'SyntaxError: strict-json-invalid',
		enumerable: false,
		writable: false,
		configurable: false,
	})
	return Object.freeze(error)
}

class StrictJsonParser {
	constructor(source, checkDeadline) {
		this.source = source
		this.index = 0
		this.nodes = 0
		this.nextDeadlineCheck = 4096
		this.checkDeadline = checkDeadline
	}

	parse() {
		this.skipWhitespace()
		if (this.index >= this.source.length) throw responseInvalid()
		const value = this.parseValue(1)
		this.skipWhitespace()
		if (this.index !== this.source.length) throw responseInvalid()
		this.checkDeadline()
		return value
	}

	checkProgress() {
		if (this.index >= this.nextDeadlineCheck) {
			this.nextDeadlineCheck = this.index + 4096
			this.checkDeadline()
		}
	}

	bumpNode() {
		this.nodes += 1
		if (this.nodes > JSON_MAX_NODES) throw responseInvalid()
		if ((this.nodes & 255) === 0) this.checkDeadline()
	}

	skipWhitespace() {
		while (this.index < this.source.length) {
			const code = this.source.charCodeAt(this.index)
			if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break
			this.index += 1
			this.checkProgress()
		}
	}

	parseValue(depth) {
		if (depth > JSON_MAX_DEPTH) throw responseInvalid()
		this.bumpNode()
		const code = this.source.charCodeAt(this.index)
		if (code === 0x7b) return this.parseObject(depth)
		if (code === 0x5b) return this.parseArray(depth)
		if (code === 0x22) return this.parseString()
		if (code === 0x74) return this.parseLiteral('true', true)
		if (code === 0x66) return this.parseLiteral('false', false)
		if (code === 0x6e) return this.parseLiteral('null', null)
		if (code === 0x2d || (code >= 0x30 && code <= 0x39)) return this.parseNumber()
		throw responseInvalid()
	}

	parseObject(depth) {
		this.index += 1
		this.skipWhitespace()
		const result = {}
		const seen = new Set()
		let keyCount = 0
		if (this.source.charCodeAt(this.index) === 0x7d) {
			this.index += 1
			return result
		}

		while (this.index < this.source.length) {
			if (this.source.charCodeAt(this.index) !== 0x22) throw responseInvalid()
			const key = this.parseString(JSON_MAX_KEY_CHARS)
			this.bumpNode()
			keyCount += 1
			if (keyCount > JSON_MAX_OBJECT_KEYS
				|| FORBIDDEN_JSON_KEYS.has(key)
				|| seen.has(key)) {
				throw responseInvalid()
			}
			seen.add(key)
			this.skipWhitespace()
			if (this.source.charCodeAt(this.index) !== 0x3a) throw responseInvalid()
			this.index += 1
			this.skipWhitespace()
			const value = this.parseValue(depth + 1)
			Object.defineProperty(result, key, {
				value,
				enumerable: true,
				writable: true,
				configurable: true,
			})
			this.skipWhitespace()
			const delimiter = this.source.charCodeAt(this.index)
			if (delimiter === 0x7d) {
				this.index += 1
				return result
			}
			if (delimiter !== 0x2c) throw responseInvalid()
			this.index += 1
			this.skipWhitespace()
		}
		throw responseInvalid()
	}

	parseArray(depth) {
		this.index += 1
		this.skipWhitespace()
		const result = []
		if (this.source.charCodeAt(this.index) === 0x5d) {
			this.index += 1
			return result
		}

		while (this.index < this.source.length) {
			if (result.length >= JSON_MAX_ARRAY_ITEMS) throw responseInvalid()
			result.push(this.parseValue(depth + 1))
			this.skipWhitespace()
			const delimiter = this.source.charCodeAt(this.index)
			if (delimiter === 0x5d) {
				this.index += 1
				return result
			}
			if (delimiter !== 0x2c) throw responseInvalid()
			this.index += 1
			this.skipWhitespace()
		}
		throw responseInvalid()
	}

	parseString(maxScalars = null) {
		const tokenStart = this.index
		this.index += 1
		let scalarCount = 0
		while (this.index < this.source.length) {
			const code = this.source.charCodeAt(this.index)
			if (code === 0x22) {
				this.index += 1
				let value
				try {
					value = JSON.parse(this.source.slice(tokenStart, this.index))
				} catch {
					this.checkDeadline()
					throw responseInvalid()
				}
				this.checkDeadline()
				if (value.includes('\u0000') || !hasOnlyUnicodeScalars(value)) throw responseInvalid()
				return value
			}
			if (code === 0x5c) {
				this.index += 1
				this.scanEscape()
				scalarCount += 1
				if (maxScalars !== null && scalarCount > maxScalars) throw responseInvalid()
				this.checkProgress()
				continue
			}
			if (code <= 0x1f) throw responseInvalid()
			if (code >= 0xd800 && code <= 0xdbff) {
				const next = this.source.charCodeAt(this.index + 1)
				if (!(next >= 0xdc00 && next <= 0xdfff)) throw responseInvalid()
				this.index += 2
			} else {
				if (code >= 0xdc00 && code <= 0xdfff) throw responseInvalid()
				this.index += 1
			}
			scalarCount += 1
			if (maxScalars !== null && scalarCount > maxScalars) throw responseInvalid()
			this.checkProgress()
		}
		throw responseInvalid()
	}

	scanEscape() {
		const code = this.source.charCodeAt(this.index)
		if (JSON_SIMPLE_ESCAPE_CODES.has(code)) {
			this.index += 1
			return
		}
		if (code !== 0x75) throw responseInvalid()
		this.index += 1
		const first = this.parseHexQuad()
		if (first === 0) throw responseInvalid()
		if (first >= 0xd800 && first <= 0xdbff) {
			if (this.source.charCodeAt(this.index) !== 0x5c
				|| this.source.charCodeAt(this.index + 1) !== 0x75) {
				throw responseInvalid()
			}
			this.index += 2
			const second = this.parseHexQuad()
			if (second < 0xdc00 || second > 0xdfff) throw responseInvalid()
			return
		}
		if (first >= 0xdc00 && first <= 0xdfff) throw responseInvalid()
	}

	parseHexQuad() {
		if (this.index + 4 > this.source.length) throw responseInvalid()
		let value = 0
		for (let offset = 0; offset < 4; offset += 1) {
			const code = this.source.charCodeAt(this.index + offset)
			let digit
			if (code >= 0x30 && code <= 0x39) digit = code - 0x30
			else if (code >= 0x41 && code <= 0x46) digit = code - 0x41 + 10
			else if (code >= 0x61 && code <= 0x66) digit = code - 0x61 + 10
			else throw responseInvalid()
			value = (value << 4) | digit
		}
		this.index += 4
		return value
	}

	parseLiteral(literal, value) {
		if (this.source.slice(this.index, this.index + literal.length) !== literal) throw responseInvalid()
		this.index += literal.length
		return value
	}

	parseNumber() {
		const start = this.index
		if (this.source.charCodeAt(this.index) === 0x2d) this.index += 1
		if (this.source.charCodeAt(this.index) === 0x30) {
			this.index += 1
			const next = this.source.charCodeAt(this.index)
			if (next >= 0x30 && next <= 0x39) throw responseInvalid()
		} else {
			const first = this.source.charCodeAt(this.index)
			if (first < 0x31 || first > 0x39) throw responseInvalid()
			while (this.index < this.source.length) {
				const code = this.source.charCodeAt(this.index)
				if (code < 0x30 || code > 0x39) break
				this.index += 1
				if (this.index - start > 128) throw responseInvalid()
			}
		}
		if (this.source.charCodeAt(this.index) === 0x2e) {
			this.index += 1
			const firstFraction = this.source.charCodeAt(this.index)
			if (firstFraction < 0x30 || firstFraction > 0x39) throw responseInvalid()
			while (this.index < this.source.length) {
				const code = this.source.charCodeAt(this.index)
				if (code < 0x30 || code > 0x39) break
				this.index += 1
				if (this.index - start > 128) throw responseInvalid()
			}
		}
		const exponent = this.source.charCodeAt(this.index)
		if (exponent === 0x65 || exponent === 0x45) {
			this.index += 1
			const sign = this.source.charCodeAt(this.index)
			if (sign === 0x2b || sign === 0x2d) this.index += 1
			const firstExponent = this.source.charCodeAt(this.index)
			if (firstExponent < 0x30 || firstExponent > 0x39) throw responseInvalid()
			while (this.index < this.source.length) {
				const code = this.source.charCodeAt(this.index)
				if (code < 0x30 || code > 0x39) break
				this.index += 1
				if (this.index - start > 128) throw responseInvalid()
			}
		}
		const token = this.source.slice(start, this.index)
		const value = Number(token)
		if (!Number.isFinite(value)) throw responseInvalid()
		return value
	}
}

function hasLeadingBom(buffer) {
	return (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf)
		|| (buffer.length >= 2 && ((buffer[0] === 0xfe && buffer[1] === 0xff)
			|| (buffer[0] === 0xff && buffer[1] === 0xfe)))
		|| (buffer.length >= 4 && ((buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0xfe && buffer[3] === 0xff)
			|| (buffer[0] === 0xff && buffer[1] === 0xfe && buffer[2] === 0x00 && buffer[3] === 0x00)))
}

function parseStrictJsonBytes(buffer, checkDeadline) {
	if (!Buffer.isBuffer(buffer) || buffer.length < 1 || buffer.length > RAW_RESPONSE_MAX_BYTES || hasLeadingBom(buffer)) {
		throw responseInvalid()
	}
	let source
	try {
		source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer)
	} catch {
		throw responseInvalid()
	}
	if (source.charCodeAt(0) === 0xfeff) throw responseInvalid()
	return new StrictJsonParser(source, checkDeadline).parse()
}


const STRICT_JSON_LIMITS = Object.freeze({
	rawBytes: RAW_RESPONSE_MAX_BYTES,
	rootDepth: 1,
	maxDepth: JSON_MAX_DEPTH,
	maxNodes: JSON_MAX_NODES,
	maxKeyChars: JSON_MAX_KEY_CHARS,
	maxObjectKeys: JSON_MAX_OBJECT_KEYS,
	maxArrayItems: JSON_MAX_ARRAY_ITEMS,
	nodeAccounting: 'container+decoded-key+primitive',
})

module.exports = { parseStrictJsonBytes, STRICT_JSON_LIMITS }
