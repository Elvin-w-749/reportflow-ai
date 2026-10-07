const STRICT_NUMBER_TEXT = /^[+-]?(?:(?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?$/

/**
 * Parse a finite number without JavaScript coercion or prefix parsing.
 *
 * Accepted:
 * - finite number primitives;
 * - complete numeric strings, optionally using valid thousands grouping.
 *
 * Rejected:
 * - arrays, objects, booleans, bigint/symbol/function;
 * - null/undefined/blank strings;
 * - NaN/Infinity;
 * - partial strings such as `12x`, currency/percent text, or malformed commas.
 */
export const strictFiniteNumberOrNull = (value) => {
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) return null
		return Object.is(value, -0) ? 0 : value
	}
	if (typeof value !== 'string') return null
	const text = value.trim()
	if (!text || !STRICT_NUMBER_TEXT.test(text)) return null
	const parsed = Number(text.replace(/,/g, ''))
	if (!Number.isFinite(parsed)) return null
	return Object.is(parsed, -0) ? 0 : parsed
}

export const strictNonNegativeNumberOrNull = (value) => {
	const parsed = strictFiniteNumberOrNull(value)
	return parsed != null && parsed >= 0 ? parsed : null
}

export const strictNonNegativeIntegerOrNull = (value) => {
	const parsed = strictNonNegativeNumberOrNull(value)
	return parsed != null && Number.isInteger(parsed) ? parsed : null
}

export const firstStrictFiniteNumberOrNull = (...values) => {
	for (const value of values) {
		const parsed = strictFiniteNumberOrNull(value)
		if (parsed != null) return parsed
	}
	return null
}

export const firstStrictNonNegativeNumberOrNull = (...values) => {
	for (const value of values) {
		const parsed = strictNonNegativeNumberOrNull(value)
		if (parsed != null) return parsed
	}
	return null
}

export default {
	strictFiniteNumberOrNull,
	strictNonNegativeNumberOrNull,
	strictNonNegativeIntegerOrNull,
	firstStrictFiniteNumberOrNull,
	firstStrictNonNegativeNumberOrNull
}
