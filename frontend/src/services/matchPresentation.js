import { strictNonNegativeNumberOrNull } from '../utils/strictNumber.js'

export const matchRateOrNull = (value) => {
	const parsed = strictNonNegativeNumberOrNull(value)
	return parsed != null && parsed <= 100 ? parsed : null
}

export const matchRateOfProduct = (product) => matchRateOrNull(product && product.matchRate)

export const reportScoreOrNull = (value) => {
	const parsed = strictNonNegativeNumberOrNull(value)
	return parsed != null && parsed <= 100 ? parsed : null
}

export const appendKnownReportScore = (base, value, formatScore = (score) => `综合分 ${score}`) => {
	const score = reportScoreOrNull(value)
	return score == null ? String(base || '') : `${String(base || '')} · ${formatScore(score)}`
}

export const summarizeKnownMatchRates = (products, complete = false) => {
	const rows = Array.isArray(products) ? products : []
	if (complete !== true) return { known: false, best: null, highCount: null }
	if (!rows.length) return { known: true, best: null, highCount: 0 }
	const rates = rows.map(matchRateOfProduct)
	if (rates.some((value) => value == null)) return { known: false, best: null, highCount: null }
	return {
		known: true,
		best: Math.max(...rates),
		highCount: rates.filter((value) => value >= 80).length
	}
}

export const filterProductsByKnownMatchRate = (products, mode = 'all') => {
	const rows = Array.isArray(products) ? products : []
	if (mode === 'high') return rows.filter((product) => {
		const rate = matchRateOfProduct(product)
		return rate != null && rate >= 80
	})
	if (mode === 'stable') return rows.filter((product) => {
		const rate = matchRateOfProduct(product)
		return rate != null && rate >= 60
	}).slice(0, 5)
	return rows
}

export default {
	matchRateOrNull,
	matchRateOfProduct,
	reportScoreOrNull,
	appendKnownReportScore,
	summarizeKnownMatchRates,
	filterProductsByKnownMatchRate
}
