'use strict'

/**
 * Evidence-first credit analysis primitives.
 *
 * This module is intentionally independent from the legacy finalizer. It accepts
 * the object returned by `finalizeExtractedCreditFacts` (or `{ facts, ... }`),
 * never mutates it, and emits only hashes, typed facts, page/block coordinates
 * and deterministic derivations. Source block text and matched quotes are never
 * returned or logged.
 */

const crypto = require('crypto')
const {
	parseQueryDateMs,
	countQueriesByWindow,
	classifyInstitution,
	classifyLoanInstitution,
	summarizeHardQueryBursts
} = require('./queryWindowPolicy')
const {
	calculatePrimaryRuleScore
} = require('../scoringAlgorithms.cjs')

const FACT_STATUS = Object.freeze({
	ACCEPTED: 'accepted',
	UNKNOWN: 'unknown',
	ABSENT: 'absent',
	NOT_APPLICABLE: 'not_applicable',
	CONFLICT: 'conflict'
})
const PRIMARY_SCORE_FORMULA_ID = 'primary-score-deterministic-v3'

const REQUIRED_SECTION_SELECTORS = Object.freeze({
	active_loans: (facts) => [
		...arrayAt(facts?.loan_details?.bank_loans),
		...arrayAt(facts?.loan_details?.non_bank_loans),
		...arrayAt(facts?.loan_details?.unknown_loans)
	],
	credit_card_details: (facts) => arrayAt(facts?.credit_card_details),
	query_details: (facts) => arrayAt(facts?.query_analysis?.query_details)
})

function arrayAt(value) {
	return Array.isArray(value)
		? value.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
		: []
}

function plainObject(value) {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function normalizeString(value) {
	return String(value == null ? '' : value).normalize('NFC').trim()
}

function canonicalString(value) {
	return normalizeString(value).replace(/\s+/g, ' ')
}

// Artifact order must never inherit the host ICU locale.  All values sorted
// with this comparator are machine identifiers/keys, so UTF-16 code-unit order
// is the deterministic contract across Windows, Linux and Node builds.
function compareMachineText(left, right) {
	const a = String(left == null ? '' : left)
	const b = String(right == null ? '' : right)
	return a < b ? -1 : (a > b ? 1 : 0)
}

/** RFC-8785-style deterministic JSON for the supported JSON value domain. */
function stableCanonicalize(value) {
	if (value === null) return 'null'
	if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'))
	if (typeof value === 'boolean') return value ? 'true' : 'false'
	if (typeof value === 'number') {
		if (!Number.isFinite(value) || Object.is(value, -0)) {
			throw new TypeError('canonical values must contain finite numbers and no negative zero')
		}
		return JSON.stringify(value)
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableCanonicalize(item === undefined ? null : item)).join(',')}]`
	}
	if (typeof value === 'object') {
		const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort()
		return `{${keys.map((key) => `${JSON.stringify(key.normalize('NFC'))}:${stableCanonicalize(value[key])}`).join(',')}}`
	}
	throw new TypeError(`unsupported canonical value type: ${typeof value}`)
}

function defaultHashFn(prefix, canonicalPayload) {
	return `${prefix}_${crypto.createHash('sha256').update(canonicalPayload, 'utf8').digest('hex')}`
}

function createHmacHashFn(secret) {
	const key = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret || ''), 'utf8')
	if (key.length < 32) throw new TypeError('evidence hash secret must contain at least 32 bytes')
	return (prefix, canonicalPayload) => {
		const hmac = crypto.createHmac('sha256', key)
		hmac.update(String(prefix))
		hmac.update('\0')
		hmac.update(canonicalPayload, 'utf8')
		return `${prefix}_${hmac.digest('hex')}`
	}
}

function artifactHash(prefix, payload, hashFn = defaultHashFn) {
	if (typeof hashFn !== 'function') throw new TypeError('hashFn must be a function')
	const value = String(hashFn(prefix, stableCanonicalize(payload)) || '')
	if (!value) throw new TypeError('hashFn returned an empty digest')
	return value
}

function normalizedSearchText(value) {
	return normalizeString(value)
		.normalize('NFKC')
		.replace(/[\u00a0\t\r]+/g, ' ')
		.replace(/\s+/g, ' ')
}

function splitSourcePages(sourceText) {
	const source = normalizeString(sourceText)
	if (!source) return [{ pageNo: 1, text: '' }]
	const marker = /【第\s*(\d+)\s*页】/g
	const matches = [...source.matchAll(marker)]
	if (!matches.length) return [{ pageNo: 1, text: source }]

	const pages = []
	const preamble = source.slice(0, matches[0].index).trim()
	for (let index = 0; index < matches.length; index += 1) {
		const current = matches[index]
		const next = matches[index + 1]
		let text = source.slice(current.index + current[0].length, next ? next.index : source.length).trim()
		if (index === 0 && preamble) text = `${preamble}\n${text}`.trim()
		pages.push({ pageNo: Number(current[1]), text })
	}
	return pages
}

function rectPolygon(rect) {
	if (!Array.isArray(rect) || rect.length < 4 || !rect.slice(0, 4).every(Number.isFinite)) return null
	const [x0, y0, x1, y1] = rect.slice(0, 4).map((value) => Math.round(value * 1000) / 1000)
	if (x1 <= x0 || y1 <= y0) return null
	return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
}

function validPageBounds(bounds) {
	if (!Array.isArray(bounds) || bounds.length < 4 || !bounds.slice(0, 4).every(Number.isFinite)) return null
	const normalized = bounds.slice(0, 4).map(Number)
	return normalized[2] > normalized[0] && normalized[3] > normalized[1] ? normalized : null
}

function polygonInsideBounds(polygon, bounds) {
	if (!polygon) return true
	const page = validPageBounds(bounds)
	if (!page) return bounds == null
	const [x0, y0, x1, y1] = page
	return polygon.every(([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1)
}

function fallbackPageBlocks(text) {
	const source = String(text || '')
	const blocks = []
	const matcher = /[^\r\n]+/g
	let match
	while ((match = matcher.exec(source)) !== null) {
		const raw = String(match[0] || '')
		const leading = raw.length - raw.trimStart().length
		const value = raw.trim()
		if (!value) continue
		const charStart = match.index + leading
		blocks.push({
			text: value,
			charStart,
			charEnd: charStart + value.length,
			bbox: null
		})
	}
	return blocks
}

function splitSuppliedBlockIntoRows(block, sourceBlockOrdinal = 0) {
	const lines = Array.isArray(block?.lines)
		? block.lines.filter((line) => String(line?.text || '').trim())
		: []
	if (lines.length) {
		return lines.map((line, index) => ({
			...line,
			sourceBlockOrdinal,
			sourceLineOrdinal: index + 1,
			sourceLineCount: lines.length
		}))
	}
	const text = String(block?.text || '')
	if (!/[\r\n]/.test(text)) {
		return [{
			...block,
			sourceBlockOrdinal,
			sourceLineOrdinal: 1,
			sourceLineCount: 1
		}]
	}
	const base = Number(block?.charStart)
	const rows = fallbackPageBlocks(text)
	return rows.map((row, index) => ({
		...row,
		charStart: (Number.isInteger(base) ? base : 0) + row.charStart,
		charEnd: (Number.isInteger(base) ? base : 0) + row.charEnd,
		bbox: Array.isArray(block?.bbox) ? block.bbox : null,
		sourceBlockOrdinal,
		sourceLineOrdinal: index + 1,
		sourceLineCount: rows.length
	}))
}

function structuredSourcePages(sourceText, documentMeta) {
	const supplied = Array.isArray(documentMeta?.pages) ? documentMeta.pages : []
	if (!supplied.length) return splitSourcePages(sourceText)
	return supplied.map((page, index) => {
		const text = String(page?.text || '')
		const suppliedBlocks = Array.isArray(page?.blocks) ? page.blocks : []
		// MuPDF text blocks may contain an entire page table. Binding account
		// anchors and values against that coarse container can join an institution
		// from one row to an amount from another. Prefer the real line geometry
		// whenever the reader supplied it; multiline rows then fail closed instead
		// of being silently cross-bound.
		const evidenceBlocks = suppliedBlocks
			.flatMap((block, blockIndex) => splitSuppliedBlockIntoRows(block, blockIndex + 1))
			.sort((left, right) => Number(left?.charStart) - Number(right?.charStart))
		return {
			pageNo: positiveInteger(page?.pageNumber || page?.pageNo) || index + 1,
			text,
			bounds: Array.isArray(page?.bounds) ? page.bounds.slice(0, 4).map(Number) : null,
			sourceMode: normalizeString(page?.sourceMode || documentMeta?.sourceMode) || 'normalized-text',
			blocks: evidenceBlocks.length
				? evidenceBlocks.map((block) => ({
					text: String(block?.text || ''),
					charStart: Number(block?.charStart),
					charEnd: Number(block?.charEnd),
					bbox: Array.isArray(block?.bbox) ? block.bbox.slice(0, 4).map(Number) : null,
					sourceBlockOrdinal: positiveInteger(block?.sourceBlockOrdinal),
					sourceLineOrdinal: positiveInteger(block?.sourceLineOrdinal),
					sourceLineCount: positiveInteger(block?.sourceLineCount)
				})).filter((block) => block.text.trim())
				: fallbackPageBlocks(text)
		}
	})
}

function nonWhitespaceTextCovered(pageText, blocks) {
	const source = String(pageText || '')
	if (!source.trim()) return true
	const covered = new Uint8Array(source.length)
	for (const block of blocks) {
		if (block.sourceIntegrityState !== 'valid') continue
		for (let index = block.charStart; index < block.charEnd && index < covered.length; index += 1) {
			covered[index] = 1
		}
	}
	for (let index = 0; index < source.length; index += 1) {
		if (/\S/.test(source[index]) && covered[index] !== 1) return false
	}
	return true
}

function buildInternalSource({ sourceText, declaredPageCount, verifiedBlankPages, documentMeta = {}, documentId, hashFn }) {
	const pages = structuredSourcePages(sourceText, documentMeta)
	const scopedDocumentId = normalizeString(documentId)
	const blankSet = new Set(arrayAtNumbers(verifiedBlankPages))
	const pageNos = pages.map((page) => page.pageNo)
	const duplicates = [...new Set(pageNos.filter((pageNo, index) => pageNos.indexOf(pageNo) !== index))].sort((a, b) => a - b)
	const maxPage = Math.max(1, ...pageNos)
	const declared = positiveInteger(declaredPageCount || documentMeta?.expectedPageCount) || maxPage
	const present = new Set(pageNos)
	const missing = []
	for (let pageNo = 1; pageNo <= declared; pageNo += 1) {
		if (!present.has(pageNo)) missing.push(pageNo)
	}

	const internalPages = pages.map((page) => {
		const sourceBlocks = Array.isArray(page.blocks) ? page.blocks : fallbackPageBlocks(page.text)
		const blocks = sourceBlocks.map((sourceBlock, index) => {
			const text = String(sourceBlock.text || '').trim()
			const searchText = normalizedSearchText(text)
			const textDigest = artifactHash('bt_v2', {
				documentId: scopedDocumentId,
				pageNo: page.pageNo,
				ordinal: index + 1,
				text: searchText
			}, hashFn)
			const suppliedStart = Number(sourceBlock.charStart)
			const suppliedEnd = Number(sourceBlock.charEnd)
			const charStart = Number.isInteger(suppliedStart) && suppliedStart >= 0 ? suppliedStart : 0
			const charEnd = Number.isInteger(suppliedEnd) && suppliedEnd >= charStart
				? suppliedEnd
				: charStart + text.length
			const polygon = rectPolygon(sourceBlock.bbox)
			const pageText = String(page.text || '')
			const spanMatchesText =
				Number.isInteger(suppliedStart) &&
				Number.isInteger(suppliedEnd) &&
				suppliedStart >= 0 &&
				suppliedEnd > suppliedStart &&
				suppliedEnd <= pageText.length &&
				normalizedSearchText(pageText.slice(suppliedStart, suppliedEnd)) === searchText
			const geometrySupplied = sourceBlock.bbox != null
			const pageBoundsValid = page.bounds == null || Boolean(validPageBounds(page.bounds))
			const geometryValid = pageBoundsValid && (!geometrySupplied || Boolean(
				polygon && polygonInsideBounds(polygon, page.bounds)
			))
			const sourceIntegrityState = spanMatchesText && geometryValid ? 'valid' : 'invalid'
			const sourceBlockOrdinal = positiveInteger(sourceBlock.sourceBlockOrdinal) || index + 1
			const sourceLineOrdinal = positiveInteger(sourceBlock.sourceLineOrdinal) || 1
			const sourceLineCount = positiveInteger(sourceBlock.sourceLineCount) || 1
			return {
				pageNo: page.pageNo,
				ordinal: index + 1,
				blockId: artifactHash('blk_v2', {
					documentId: scopedDocumentId,
					pageNo: page.pageNo,
					ordinal: index + 1,
					charStart,
					charEnd,
					textDigest,
					polygon
				}, hashFn),
				text,
				searchText,
				textDigest,
				charStart,
				charEnd,
				polygon,
				geometryState: polygon ? 'available' : 'unavailable',
				sourceIntegrityState,
				sourceMode: normalizeString(page.sourceMode || documentMeta?.sourceMode) || 'normalized-text',
				sourceBlockOrdinal,
				sourceLineOrdinal,
				sourceLineCount,
				sourceGroupId: artifactHash('sg_v3', {
					documentId: scopedDocumentId,
					pageNo: page.pageNo,
					sourceBlockOrdinal
				}, hashFn)
			}
		}).filter((block) => block.searchText)
		const textCoverageComplete = nonWhitespaceTextCovered(page.text, blocks)
		return {
			pageNo: page.pageNo,
			text: page.text,
			blocks,
			bounds: Array.isArray(page.bounds) ? page.bounds : null,
			sourceMode: normalizeString(page.sourceMode || documentMeta?.sourceMode) || 'normalized-text',
			textCoverageComplete,
			verifiedBlank: blankSet.has(page.pageNo)
		}
	})
	return { pages: internalPages, declared, duplicates, missing }
}

function arrayAtNumbers(value) {
	return Array.isArray(value)
		? value.map(Number).filter((item) => Number.isInteger(item) && item > 0)
		: []
}

function positiveInteger(value) {
	const number = Number(value)
	return Number.isInteger(number) && number > 0 ? number : 0
}

function factsAndContext(evidenceContext) {
	const context = plainObject(evidenceContext)
	const facts = plainObject(context.facts || context.finalizedFacts || context)
	return { facts, context }
}

function buildDocumentManifest({
	sourceText,
	evidenceContext = {},
	inputKind = 'credit-report-pdf',
	documentId,
	declaredPageCount,
	versions = {},
	hashFn = defaultHashFn
} = {}) {
	const { context } = factsAndContext(evidenceContext)
	const suppliedDocumentId = normalizeString(documentId)
	const resolvedDocumentId = /^doc_v2_[a-f0-9]{64}$/.test(suppliedDocumentId)
		? suppliedDocumentId
		: artifactHash('doc_v2', suppliedDocumentId
			? {
				inputKind,
				externalIdDigest: artifactHash('ext_v2', {
					inputKind,
					externalId: suppliedDocumentId
				}, hashFn)
			}
			: {
				inputKind,
				sourceText: normalizeString(sourceText)
			}, hashFn)
	const internal = buildInternalSource({
		sourceText,
		declaredPageCount:
			declaredPageCount ||
			context?.documentMeta?.declaredPageCount ||
			context?.documentMeta?.expectedPageCount,
		verifiedBlankPages: context?.documentMeta?.verifiedBlankPages,
		documentMeta: context?.documentMeta,
		documentId: resolvedDocumentId,
		hashFn
	})
	const pages = internal.pages.map((page) => {
		const textDigest = artifactHash('pt_v2', {
			documentId: resolvedDocumentId,
			pageNo: page.pageNo,
			text: normalizeString(page.text)
		}, hashFn)
		const empty = page.blocks.length === 0
		return {
			pageNo: page.pageNo,
			pageId: artifactHash('pg_v2', { documentId: resolvedDocumentId, pageNo: page.pageNo, textDigest }, hashFn),
			sourceMode: empty && page.verifiedBlank ? 'verified-blank' : page.sourceMode,
			bounds: Array.isArray(page.bounds) ? page.bounds : null,
			geometryState: page.blocks.some((block) => block.geometryState === 'available')
				? 'available'
				: 'unavailable',
			textDigest,
			textLength: normalizeString(page.text).length,
			blockCount: page.blocks.length,
			textCoverageComplete: page.textCoverageComplete,
			status: (!empty || page.verifiedBlank) &&
				page.blocks.every((block) => block.sourceIntegrityState === 'valid') &&
				page.textCoverageComplete
				? 'complete'
				: 'rejected'
		}
	})
	const readerComplete = context?.documentMeta?.complete !== false &&
		context?.documentMeta?.sourceMode !== 'pdf-parse-legacy' &&
		internal.pages.every((page) => page.sourceMode !== 'pdf-parse-legacy')
	const complete = readerComplete &&
		internal.missing.length === 0 &&
		internal.duplicates.length === 0 &&
		pages.length === internal.declared &&
		pages.every((page) => page.status === 'complete')
	const payload = {
		schema: 'rpt.credit/document-manifest/2.0',
		status: complete ? 'complete' : 'rejected',
		documentId: resolvedDocumentId,
		input: {
			kind: normalizeString(inputKind) || 'credit-report-pdf',
			textLength: internal.pages.reduce((sum, page) => sum + normalizeString(page.text).length, 0)
		},
		sourceAssurance: {
			classification: 'official-credit-report',
			assertionBasis: 'user-confirmed',
			issuerSignatureVerified: false
		},
		pages,
		coverage: {
			declaredPageCount: internal.declared,
			processedPageCount: pages.length,
			processedPageNos: pageNosSorted(pages),
			missingPageNos: internal.missing,
			duplicatePageNos: internal.duplicates,
			readerComplete,
			complete
		},
		versions: {
			manifestSchema: '2.0',
			segmentation: 'line-blocks-v1',
			...plainObject(versions)
		}
	}
	return {
		...payload,
		manifestHash: artifactHash('mh_v2', payload, hashFn)
	}
}

function pageNosSorted(pages) {
	return pages.map((page) => page.pageNo).sort((a, b) => a - b)
}

function parseDate(value) {
	const text = normalizeString(value)
	const match = text.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?$/)
	if (!match) return null
	const year = Number(match[1])
	const month = Number(match[2])
	const day = Number(match[3])
	const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
	if (year < 1900 || month < 1 || month > 12 || day < 1 || day > maxDay) return null
	return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function dateVariants(value) {
	const date = parseDate(value)
	if (!date) return []
	const [year, monthText, dayText] = date.split('-')
	const month = Number(monthText)
	const day = Number(dayText)
	return [...new Set([
		date,
		`${year}/${monthText}/${dayText}`,
		`${year}.${monthText}.${dayText}`,
		`${year}年${month}月${day}日`,
		`${year}年${monthText}月${dayText}日`
	])]
}

function moneyMagnitude(value) {
	if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
	const text = normalizeString(value).replace(/[,，\s人民币元]/g, '')
	const match = text.match(/^-?\d+(?:\.\d+)?/)
	if (!match) return null
	let amount = Number(match[0])
	if (/万/.test(text)) amount *= 10000
	if (!Number.isFinite(amount) || amount < 0) return null
	const minor = Math.round(amount * 100)
	return Number.isSafeInteger(minor) ? { minor, scale: 2 } : null
}

function moneyValue(value, currencyCode) {
	const magnitude = moneyMagnitude(value)
	const currency = currencyValue(currencyCode)
	return magnitude && currency
		? { type: 'money', currency: currency.code, ...magnitude }
		: null
}

function moneyVariants(value) {
	const money = moneyMagnitude(value)
	if (!money) return []
	const yuan = money.minor / 100
	const fixed = yuan.toFixed(2)
	const integer = Number.isInteger(yuan) ? String(yuan) : String(yuan)
	const grouped = Number(yuan).toLocaleString('en-US', {
		minimumFractionDigits: Number.isInteger(yuan) ? 0 : 2,
		maximumFractionDigits: 2
	})
	const variants = [integer, fixed, grouped, `${grouped}元`, `${fixed}元`]
	if (yuan !== 0 && Number.isInteger(yuan / 10000)) {
		variants.push(`${yuan / 10000}万`, `${yuan / 10000}万元`)
	}
	return [...new Set(variants)]
}

function stableRows(value) {
	return arrayAt(value)
		.map((row) => ({ row, key: stableCanonicalize(row) }))
		.sort((left, right) => compareMachineText(left.key, right.key))
		.map((item) => item.row)
}

const CURRENCY_ALIAS_ENTRIES = Object.freeze([
	['CNY', /^(?:人民币(?:元)?|CNY|RMB)$/u],
	['USD', /^(?:美元|美金|USD)$/u],
	['EUR', /^(?:欧元|EUR)$/u],
	['JPY', /^(?:日元|JPY)$/u],
	['GBP', /^(?:英镑|GBP)$/u],
	['HKD', /^(?:港币|港元|香港元|HKD)$/u],
	['AUD', /^(?:澳大利亚元|澳元|AUD)$/u],
	['NZD', /^(?:新西兰元|纽元|NZD)$/u],
	['CAD', /^(?:加拿大元|加元|CAD)$/u],
	['CHF', /^(?:瑞士法郎|瑞郎|CHF)$/u],
	['SGD', /^(?:新加坡元|新元|SGD)$/u],
	['MOP', /^(?:澳门元|澳门币|MOP)$/u]
])

const SOURCE_CURRENCY_TOKEN = '(?:人民币(?:元)?|CNY|RMB|美元|美金|USD|欧元|EUR|日元|JPY|英镑|GBP|港币|港元|香港元|HKD|澳大利亚元|澳元|AUD|新西兰元|纽元|NZD|加拿大元|加元|CAD|瑞士法郎|瑞郎|CHF|新加坡元|新元|SGD|澳门元|澳门币|MOP)'

function currencyValue(value) {
	if (typeof value !== 'string') return null
	const text = canonicalString(value).normalize('NFKC').toUpperCase()
	if (!text) return null
	const selected = CURRENCY_ALIAS_ENTRIES.find(([, pattern]) => pattern.test(text))
	return selected ? { type: 'currency', code: selected[0] } : null
}

function currencyFieldMissing(value) {
	return value === null || value === undefined || (
		typeof value === 'string' && canonicalString(value) === ''
	)
}

function resolveCurrencyFields(primary, secondary, { missingCode = null } = {}) {
	const supplied = [primary, secondary].filter((value) => !currencyFieldMissing(value))
	if (!supplied.length) return {
		missing: true,
		hasInput: false,
		valid: Boolean(missingCode),
		code: missingCode
	}
	const parsed = supplied.map((value) => currencyValue(value)?.code || null)
	const unique = new Set(parsed.filter(Boolean))
	const valid = parsed.every(Boolean) && unique.size === 1
	return {
		missing: false,
		hasInput: true,
		valid,
		code: valid ? parsed[0] : null
	}
}

function currencyVariants(value) {
	const currency = currencyValue(value)
	if (!currency) return []
	const variants = {
		CNY: ['人民币', 'CNY', 'RMB'],
		USD: ['美元', '美金', 'USD'],
		EUR: ['欧元', 'EUR'],
		JPY: ['日元', 'JPY'],
		GBP: ['英镑', 'GBP'],
		HKD: ['港币', '港元', '香港元', 'HKD'],
		AUD: ['澳大利亚元', '澳元', 'AUD'],
		NZD: ['新西兰元', '纽元', 'NZD'],
		CAD: ['加拿大元', '加元', 'CAD'],
		CHF: ['瑞士法郎', '瑞郎', 'CHF'],
		SGD: ['新加坡元', '新元', 'SGD'],
		MOP: ['澳门元', '澳门币', 'MOP']
	}
	return variants[currency.code] || [currency.code]
}

const SOURCE_CURRENCY_FIELD_LABEL = '(?:账户币种|结算币种|币种|币别|CURRENCY)'
const SOURCE_CARD_MONEY_FIELD = '(?:信用额度|授信额度|账户额度|已用额度|已使用额度|已用金额|使用额度|未出单大额专项分期余额|大额分期余额|专项分期余额|分期余额)'
const SOURCE_FOREIGN_CURRENCY_SIGNAL_PATTERN = /外币|美元|美金|\bUSD\b|欧元|\bEUR\b|日元|\bJPY\b|港币|港元|\bHKD\b|英镑|\bGBP\b|澳元|澳大利亚元|\bAUD\b|加元|加拿大元|\bCAD\b|新加坡元|\bSGD\b|瑞士法郎|\bCHF\b|韩元|\bKRW\b|新西兰元|\bNZD\b|澳门元|\bMOP\b|泰铢|\bTHB\b/u

function sourceCurrencyTokens(value, block, baseOffset = 0) {
	const source = String(value || '')
	const matcher = new RegExp(`(^|[^A-Za-z])(${SOURCE_CURRENCY_TOKEN})(?![A-Za-z])`, 'giu')
	const assertions = []
	let match
	while ((match = matcher.exec(source)) !== null) {
		const token = String(match[2] || '')
		const code = currencyValue(token)?.code
		if (!code) continue
		const start = baseOffset + match.index + String(match[1] || '').length
		assertions.push({
			code,
			block,
			match: { needle: token, start, end: start + token.length }
		})
	}
	return assertions
}

function closedCurrencySequence(value, block, baseOffset = 0) {
	const source = normalizeString(value).normalize('NFKC')
	if (!source) return []
	const grammar = new RegExp(
		`^${SOURCE_CURRENCY_TOKEN}(?:\\s*账户)?(?:\\s*(?:/|／|、|及|和|与|\\+|&)\\s*${SOURCE_CURRENCY_TOKEN}(?:\\s*账户)?)*$`,
		'iu'
	)
	if (!grammar.test(source)) return []
	return sourceCurrencyTokens(source, block, baseOffset)
}

function controlledBareCurrencyAssertions(block) {
	const source = String(block?.searchText || '').replace(/[。.]$/u, '').trim()
	if (!source) return []
	const field = source.match(new RegExp(`^${SOURCE_CURRENCY_FIELD_LABEL}\\s*[：:=#]?\\s*`, 'iu'))
	const value = field ? source.slice(field[0].length) : source
	return closedCurrencySequence(value, block, field ? field[0].length : 0)
}

function sourceBundleCurrencyAssertion(bundle) {
	const blocks = [...new Map([
		...arrayAt(bundle?.members),
		...arrayAt(bundle?.currencySignalBlocks)
	].map((block) => [block.blockId, block])).values()]
	const assertions = []
	const fieldSignalBlocks = []
	let invalidField = false
	let fieldCount = 0
	const add = (items) => assertions.push(...items)
	for (const block of blocks) {
		const source = String(block.searchText || '')
		const fieldPattern = new RegExp(`${SOURCE_CURRENCY_FIELD_LABEL}\\s*[：:=#]?\\s*`, 'giu')
		let field
		while ((field = fieldPattern.exec(source)) !== null) {
			fieldCount += 1
			fieldSignalBlocks.push(block)
			const valueStart = field.index + field[0].length
			const remaining = source.slice(valueStart)
			const nextField = remaining.search(new RegExp(
				`(?:${SOURCE_CARD_MONEY_FIELD}|贷款余额|借款余额|当前余额)`,
				'iu'
			))
			const bounded = remaining.slice(0, nextField >= 0 ? nextField : 64)
			const envelope = bounded.split(/[，,；;。]/u)[0].trim()
			const parsed = closedCurrencySequence(envelope, block, valueStart + bounded.indexOf(envelope))
			if (!parsed.length) invalidField = true
			add(parsed)
		}

		const parenthetical = /[（(]([^（）()\r\n]{1,128})[）)]/gu
		let wrapped
		while ((wrapped = parenthetical.exec(source)) !== null) {
			const inner = String(wrapped[1] || '').replace(
				/\s*[，,]\s*(?:卡片尾号|账户标识尾号|账户尾号|卡号后四位|账号后四位|尾号)\s*[：:=#]?\s*\d{4}\s*$/u,
				''
			)
			add(closedCurrencySequence(inner, block, wrapped.index + 1))
		}

		let clauseStart = 0
		for (const clause of source.split(/[，,；;。]/u)) {
			const trimmed = clause.trim()
			const offset = clauseStart + clause.indexOf(trimmed)
			add(closedCurrencySequence(trimmed, block, offset))
			clauseStart += clause.length + 1
		}

		const moneyFieldPattern = new RegExp(
			`(?:${SOURCE_CARD_MONEY_FIELD}|贷款余额|借款余额|当前余额)`,
			'giu'
		)
		let moneyField
		while ((moneyField = moneyFieldPattern.exec(source)) !== null) {
			let prefix = source.slice(0, moneyField.index).replace(/[，,；;。]+$/u, '').trimEnd()
			const controlledFieldAt = prefix.search(
				/(?:授信协议编号|信用协议编号|共享额度组|共享授信组|额度组)\s*[：:=#]?/u
			)
			if (controlledFieldAt >= 0) prefix = prefix.slice(0, controlledFieldAt).replace(/[，,；;。]+$/u, '').trimEnd()
			const tail = prefix.match(/(?:^|[\s）)])([^\s）)]{1,128})$/u)
			if (!tail) continue
			const sequence = String(tail[1] || '')
			const start = prefix.length - tail[0].length + tail[0].lastIndexOf(sequence)
			add(closedCurrencySequence(sequence, block, start))
		}
	}
	const uniqueAssertions = [...new Map(assertions.map((item) => [
		`${item.block.blockId}:${item.match.start}:${item.match.end}:${item.code}`,
		item
	])).values()]
	const codes = new Set(uniqueAssertions.map((item) => item.code))
	return {
		status: invalidField || fieldCount > 1 || codes.size > 1
			? 'conflict'
			: (codes.size === 1 ? 'unique' : 'missing'),
		code: codes.size === 1 ? [...codes][0] : null,
		assertions: uniqueAssertions,
		signals: [...new Map([
			...fieldSignalBlocks,
			...uniqueAssertions.map((item) => item.block)
		].map((block) => [block.blockId, block])).values()]
	}
}

const CARD_NOT_ACTIVATED_STATUS = '(?:尚未激活|未激活|待激活|尚未启用|未启用|未开卡)'
const CARD_NOT_ACTIVATED_STATUS_PATTERN = new RegExp(`^${CARD_NOT_ACTIVATED_STATUS}$`, 'u')

function modelCardNotActivated(row) {
	if (typeof row?.status !== 'string') return false
	// 归一化必须与 creditCardUtilization.isNotActivatedCardStatus 逐字节一致
	// （NFKC + 去全部空白 + 去句读），否则台账与 legacy 层对同一状态口径分叉。
	return CARD_NOT_ACTIVATED_STATUS_PATTERN.test(
		String(row.status).normalize('NFKC').replace(/\s+/g, '').replace(/[。.!！]/gu, '')
	)
}

function sourceBundleNotActivatedSignals(bundle) {
	const signals = []
	for (const block of arrayAt(bundle?.members)) {
		const source = String(block.searchText || '')
		const labeled = new RegExp(
			`(?:账户状态|状态)\\s*[：:=#]\\s*${CARD_NOT_ACTIVATED_STATUS}(?=$|[\\s，,；;。.!！])`,
			'u'
		)
		if (labeled.test(source)) {
			signals.push(block)
			continue
		}
		const clauses = source.split(/[，,；;。.!！]/u).map((value) => value.trim()).filter(Boolean)
		if (clauses.some((clause) => {
			if (new RegExp(
				`^(?:(?:该)?(?:信用卡|贷记卡|账户)\\s*)?${CARD_NOT_ACTIVATED_STATUS}$`,
				'u'
			).test(clause)) return true
			const timed = clause.match(new RegExp(`^(.+?)[，,\\s]*(${CARD_NOT_ACTIVATED_STATUS})$`, 'u'))
			return Boolean(timed && isStrictSourceAsOfTransition(timed[1]))
		})) signals.push(block)
	}
	return [...new Map(signals.map((block) => [block.blockId, block])).values()]
}

/**
 * PRD-DECISION-001：未激活是受支持闭集状态，但状态本身必须有源行证据。
 * 返回块内可引用的激活状态证据 span（优先取带标签的完整断言，
 * 否则取经过分句校验后的状态关键词本身）。
 */
function blockNotActivatedSignalSpan(block) {
	const source = String(block?.searchText || '')
	if (!source) return null
	const labeled = source.match(new RegExp(
		`(?:账户状态|状态)\\s*[：:=#]\\s*${CARD_NOT_ACTIVATED_STATUS}(?=$|[\\s，,；;。.!！])`,
		'u'
	))
	if (labeled && typeof labeled.index === 'number') {
		return { start: labeled.index, end: labeled.index + labeled[0].length }
	}
	if (!sourceBundleNotActivatedSignals({ members: [block] }).length) return null
	const keyword = source.match(new RegExp(CARD_NOT_ACTIVATED_STATUS, 'u'))
	if (!keyword || typeof keyword.index !== 'number') return null
	return { start: keyword.index, end: keyword.index + keyword[0].length }
}

function normalizedCurrencyAssertion(value) {
	return normalizeString(value)
		.normalize('NFKC')
		.replace(new RegExp(`^${SOURCE_CURRENCY_FIELD_LABEL}\\s*[：:=]?\\s*`, 'iu'), '')
		.trim()
}

function isExactCnyAssertion(value) {
	return /^(?:人民币|CNY|RMB)$/iu.test(normalizedCurrencyAssertion(value))
}

function hasCnyAssertionToken(value) {
	return /人民币|\b(?:CNY|RMB)\b/iu.test(normalizeString(value).normalize('NFKC'))
}

function hasNonCnyUppercaseIsoToken(value) {
	const source = normalizeString(value).normalize('NFKC')
	for (const match of source.matchAll(/(^|[^A-Z])([A-Z]{3})(?![A-Z])/gu)) {
		if (!['CNY', 'RMB'].includes(match[2])) return true
	}
	return false
}

function immediateSourceClause(source, fieldStart) {
	const prefix = source.slice(0, fieldStart).replace(/[\s，,；;]*$/u, '')
	for (let index = prefix.length - 1; index >= 0; index -= 1) {
		const char = prefix[index]
		if (!/[，,；;。\n]/u.test(char)) continue
		if (
			/[，,]/u.test(char) &&
			/\d/u.test(prefix[index - 1] || '') &&
			/^\d{3}(?!\d)/u.test(prefix.slice(index + 1))
		) continue
		return prefix.slice(index + 1).trim()
	}
	return prefix.trim()
}

function trimCurrencyAssertionEnvelope(value) {
	return normalizeString(value)
		.normalize('NFKC')
		.replace(/^[\s，,；;。]+/u, '')
		.replace(/[\s，,；;。]+$/u, '')
}

function isStrictSourceAsOfTransition(value) {
	return /^(?:截至|截止)\s*(?:报告日|(?:19|20)\d{2}\s*年\s*(?:0?[1-9]|1[0-2])\s*月(?:\s*(?:0?[1-9]|[12]\d|3[01])\s*日)?|(?:19|20)\d{2}\s*([.\/-])\s*(?:0?[1-9]|1[0-2])\s*\1\s*(?:0?[1-9]|[12]\d|3[01]))$/u.test(
		normalizeString(value).normalize('NFKC')
	)
}

function hasControlledCurrencyLikeToken(value) {
	const source = normalizeString(value).normalize('NFKC')
	if (!source) return false
	if (
		hasCnyAssertionToken(source) ||
		hasNonCnyUppercaseIsoToken(source) ||
		SOURCE_FOREIGN_CURRENCY_SIGNAL_PATTERN.test(source)
	) return true
	return /[\p{Script=Han}]{1,8}(?:币|元|卢布|法郎)|(?:^|[^A-Za-z])[A-Za-z]{3,}(?![A-Za-z])|[$€£¥₽]/u.test(source)
}

function isClosedSourceCardMoneySequence(value) {
	let source = normalizeString(value).normalize('NFKC')
	if (!source) return false
	const fieldPattern = new RegExp(
		`^(?:${SOURCE_CARD_MONEY_FIELD}|余额|\\(含未出单的大额专项分期余额)(?=\\s*[：:=#]?\\s*[-+]?\\d)`,
		'iu'
	)
	let fieldCount = 0
	while (source) {
		const field = source.match(fieldPattern)
		if (!field) return false
		const wrappedInstallment = field[0].startsWith('(')
		const afterField = source.slice(field[0].length)
		const money = sourceMoneyAtStart(afterField, {
			requireExplicitEnd: false,
			requireUniqueToken: false
		})
		if (!money) return false
		fieldCount += 1
		source = afterField.slice(money.end).trimStart()
		if (source.startsWith('人民币元')) source = source.slice('人民币元'.length).trimStart()
		if (wrappedInstallment) {
			if (!source.startsWith(')')) return false
			source = source.slice(1).trimStart()
		}
		if (!source) return fieldCount > 0
		source = source.replace(/^(?:\s|[，,；;。.\]】])+/u, '')
		if (!source) return fieldCount > 0
	}
	return false
}

function sourceHasUniqueParentheticalCnyAccountAsOfTransition(source, firstMoneyFieldStart) {
	const prefix = String(source || '').slice(0, firstMoneyFieldStart).normalize('NFKC')
	if ((prefix.match(/[（(]/gu) || []).length !== 1 || (prefix.match(/[）)]/gu) || []).length !== 1) return false
	const assertion = prefix.match(/(?:（\s*([^（）()\r\n]*)\s*）|\(\s*([^（）()\r\n]*)\s*\))/u)
	if (!assertion) return false
	const assertionValue = normalizeString(assertion[1] ?? assertion[2]).replace(/\s+/g, ' ')
	// Official card identities may keep the four-digit tail in the same closed
	// parenthesis as the currency assertion. Accept only that exact metadata
	// suffix; arbitrary prose, a second currency, or an incomplete tail keeps the
	// assertion untrusted.
	if (!/^(?:人民币|CNY|RMB)(?:\s*账户)?(?:\s*[，,]\s*(?:卡片尾号|账户标识尾号|账户尾号|卡号后四位|账号后四位|尾号)\s*[：:=#]?\s*\d{4})?$/iu.test(assertionValue)) {
		return false
	}

	const beforeAssertion = prefix.slice(0, assertion.index)
	const adjacentCardType = beforeAssertion.match(/(?:准贷记卡|信用卡|贷记卡)\s*$/u)
	if (!adjacentCardType) return false
	const cardTypeModifier = beforeAssertion.slice(0, adjacentCardType.index).trimEnd()
	if (/(?:非|不是|并非|不属于|疑似|可能|未知|不明)(?:\s*(?:为|是|属于))?(?:\s*(?:类型|卡种|性质))?\s*$/u.test(cardTypeModifier)) {
		return false
	}
	if (hasControlledCurrencyLikeToken(beforeAssertion)) return false
	const afterAssertion = trimCurrencyAssertionEnvelope(
		prefix.slice(assertion.index + assertion[0].length)
	)
	const immediateClause = normalizeString(immediateSourceClause(prefix, prefix.length)).normalize('NFKC')
	return isStrictSourceAsOfTransition(afterAssertion) &&
		isStrictSourceAsOfTransition(immediateClause) &&
		afterAssertion === immediateClause &&
		isClosedSourceCardMoneySequence(String(source || '').slice(firstMoneyFieldStart))
}

function sourceBundleHasClosedParentheticalCnyMoneySequence(bundle) {
	if (
		bundle?.kind !== 'card' ||
		bundle?.recordMembershipProven !== true ||
		bundle?.recordClosureProven !== true
	) return false
	const source = arrayAt(bundle.members)
		.map((member) => normalizeString(member.searchText).normalize('NFKC'))
		.join('\n')
	const firstMoneyField = source.match(new RegExp(SOURCE_CARD_MONEY_FIELD, 'u'))
	return Boolean(
		firstMoneyField &&
		sourceHasUniqueParentheticalCnyAccountAsOfTransition(source, firstMoneyField.index)
	)
}

function sourceHasBalancedRoundParentheses(value) {
	const stack = []
	const expectedOpen = new Map([
		[')', '('],
		['）', '（']
	])
	for (const char of String(value || '')) {
		if (char === '(' || char === '（') {
			stack.push(char)
			continue
		}
		if (!expectedOpen.has(char)) continue
		if (stack.pop() !== expectedOpen.get(char)) return false
	}
	return stack.length === 0
}

function sourceBundleProvesOnlyCny(bundle) {
	if (
		bundle?.kind !== 'card' ||
		bundle?.recordMembershipProven !== true ||
		bundle?.recordClosureProven !== true
	) return false
	const members = arrayAt(bundle.members)
	const rawSource = members
		.map((member) => normalizeString(member.text ?? member.searchText))
		.join('\n')
	if (!sourceHasBalancedRoundParentheses(rawSource)) return false
	const source = members
		.map((member) => normalizeString(member.searchText).normalize('NFKC'))
		.join('\n')
	if (!source) return false
	// This is a positive proof, not a list of currencies that happen to be
	// recognized today. Negation or an open-ended currency domain is enough to
	// reject the scoring repair before any value is introduced.
	if (/非\s*(?:人民币|\bCNY\b|\bRMB\b)|外币|其他币种|多币种|双币种|币种不(?:详|明)|币种未知/iu.test(source)) {
		return false
	}

	// A connector makes the whole punctuation-delimited clause one currency
	// assertion. Every member of such an assertion must independently be an
	// exact CNY alias; an unknown word or arbitrary ISO code therefore fails
	// closed without maintaining a foreign-currency blacklist.
	for (const clause of source.split(/[，,；;。\n]/u)) {
		if (!hasCnyAssertionToken(clause) || !/(?:及|和|与|\/|／|、|&|\+)/u.test(clause)) continue
		const values = clause
			.split(/(?:及|和|与|\/|／|、|&|\+)/u)
			.map(normalizedCurrencyAssertion)
			.filter(Boolean)
		if (!values.length || values.some((value) => !isExactCnyAssertion(value))) return false
	}

	const moneyFieldPattern = new RegExp(SOURCE_CARD_MONEY_FIELD, 'gu')
	const moneyFields = [...source.matchAll(moneyFieldPattern)]
	if (!moneyFields.length) return false
	const firstMoneyFieldStart = moneyFields[0].index
	const currencyLabelPattern = new RegExp(
		`(?:^|[，,；;。\\n\\s])${SOURCE_CURRENCY_FIELD_LABEL}\\s*[：:=]?\\s*`,
		'giu'
	)
	const currencyLabels = [...source.matchAll(currencyLabelPattern)]
	// More than one declared currency field is not a unique source assertion,
	// even when the model selected one of them. A declaration after the first
	// card amount also cannot retroactively authorize that amount's currency.
	if (currencyLabels.length > 1) return false
	let assertion
	if (currencyLabels.length === 1) {
		const label = currencyLabels[0]
		const valueStart = label.index + label[0].length
		if (valueStart > firstMoneyFieldStart) return false
		// Capture the entire field value through the first card amount. Removing
		// only outer punctuation makes `人民币，美元` one non-CNY assertion rather
		// than accepting its first token and silently discarding the remainder.
		assertion = trimCurrencyAssertionEnvelope(source.slice(valueStart, firstMoneyFieldStart))
	} else {
		assertion = normalizedCurrencyAssertion(immediateSourceClause(source, firstMoneyFieldStart))
		if (
			!isExactCnyAssertion(assertion) &&
			sourceHasUniqueParentheticalCnyAccountAsOfTransition(source, firstMoneyFieldStart)
		) assertion = '人民币'
	}
	if (!isExactCnyAssertion(assertion)) return false

	const priorMoneyFieldPattern = new RegExp(SOURCE_CARD_MONEY_FIELD, 'u')
	for (let index = 1; index < moneyFields.length; index += 1) {
		const match = moneyFields[index]
		const clause = immediateSourceClause(source, match.index)
		if (!clause) continue
		const assertion = normalizedCurrencyAssertion(clause)
		if (isExactCnyAssertion(assertion)) continue
		if (/\d/u.test(clause) && priorMoneyFieldPattern.test(clause)) continue
		// A clause carrying a currency label, CNY token, or an uppercase ISO-shaped
		// token is controlled currency context. Anything other than the closed CNY
		// grammar above is ambiguous. Ordinary English words elsewhere in an issuer
		// or account description are never scanned as currency codes.
		if (
			new RegExp(SOURCE_CURRENCY_FIELD_LABEL, 'iu').test(clause) ||
			hasCnyAssertionToken(clause) ||
			hasNonCnyUppercaseIsoToken(clause)
		) return false
		// Later amount fields are normally preceded by the prior labelled amount.
		// Any other non-numeric clause occupies a controlled currency slot and is
		// therefore an unexplained second assertion rather than ignorable prose.
		if (!/\d/u.test(clause)) return false
	}
	return true
}

function textValue(value) {
	const text = canonicalString(value)
	return text ? { type: 'text', value: text } : null
}

function redactedValue(value, hashFn, documentId = '') {
	const text = canonicalString(value)
	return text ? {
		type: 'redacted',
		valueDigest: artifactHash('rv_v2', { documentId: normalizeString(documentId), value: text }, hashFn)
	} : null
}

function normalizeSourceSharedGroupToken(rawToken) {
	return String(rawToken == null ? '' : rawToken)
		.normalize('NFKC')
		.replace(/\s+/gu, ' ')
		.trim()
}

const SHARED_GROUP_CONNECTOR_PATTERN = /[._/\\:\-\u2010-\u2015\u2212]$/u

function hasCompleteSharedGroupTokenShape(rawToken) {
	const normalized = normalizeSourceSharedGroupToken(rawToken)
	if (!normalized || normalized.length > 128) return false
	// A connector at either edge proves that the protocol identifier is only a
	// fragment (for example `G-` followed by the rest on another PDF line).
	// Never hash such a fragment into a seemingly valid facility relation.
	if (SHARED_GROUP_CONNECTOR_PATTERN.test(normalized)) return false
	if (/^[._/\\:\-\u2010-\u2015\u2212]/u.test(normalized)) return false
	return true
}

function isExplicitNoSharedCreditToken(rawToken) {
	const normalized = normalizeSourceSharedGroupToken(rawToken).replace(/\s+/gu, '').toUpperCase()
	if (new Set([
		'无', '不适用', '未提供', '未知', '否', '没有', '暂无', '不共享',
		'未共享', '无共享', '未设置', '无设置',
		'N/A', 'NA', 'NONE', 'NULL', 'NO', 'NOTSET', 'UNSET'
	]).has(normalized)) return true
	return /^(?:无|未|不|否|没有|暂无)(?:共享|设置|提供|适用|关联|授信|额度)/u.test(normalized)
}

function buildSourceSharedGroupId(rawToken, hashFn = defaultHashFn, documentId = '') {
	const normalized = normalizeSourceSharedGroupToken(rawToken)
	if (!hasCompleteSharedGroupTokenShape(normalized) || isExplicitNoSharedCreditToken(normalized)) return ''
	if (/^grp_v2_[a-f0-9]{64}$/.test(normalized)) return normalized
	// A positive source relation must look like a stable protocol/agreement ID.
	// Pure natural-language values stay untrusted and are handled by the global
	// unclaimed-signal fail-closed gate instead of being silently grouped.
	if (!/[A-Z0-9]/iu.test(normalized)) return ''
	const scopedDocumentId = normalizeString(documentId)
	if (!/^doc_v2_[a-f0-9]{64}$/.test(scopedDocumentId)) return ''
	return artifactHash('grp_v2', {
		documentId: scopedDocumentId,
		token: normalized.toUpperCase()
	}, hashFn)
}

function targetVariants(target) {
	if (target.valueType === 'money') return moneyVariants(target.rawValue)
	if (target.valueType === 'date') return dateVariants(target.rawValue)
	if (target.valueType === 'currency') return currencyVariants(target.rawValue)
	if (target.valueType === 'shared_group') return []
	if (target.valueType === 'card_activation_state') return []
	const value = canonicalString(target.rawValue)
	return value ? [value] : []
}

function typedTargetValue(target, hashFn, documentId = '') {
	if (target.valueType === 'shared_group') {
		const id = buildSourceSharedGroupId(target.rawValue, hashFn, documentId)
		return id ? { type: 'opaque-group', id } : null
	}
	if (target.valueType === 'card_activation_state') {
		return { type: 'card-state', state: 'not_activated' }
	}
	if (target.sensitive === true) return redactedValue(target.rawValue, hashFn, documentId)
	if (target.valueType === 'money') return moneyValue(target.rawValue, target.currencyCode)
	if (target.valueType === 'date') {
		const value = parseDate(target.rawValue)
		return value ? { type: 'date', value } : null
	}
	if (target.valueType === 'currency') return currencyValue(target.rawValue)
	return textValue(target.rawValue)
}

function buildAnchors(row, kind) {
	const institution = canonicalString(row?.institution || row?.bank || row?.org)
	const date = parseDate(row?.start_date || row?.open_date)
	const tail = canonicalString(row?.card_tail || row?.tail_number || row?.last4).replace(/\D/g, '').slice(-4)
	return {
		institution,
		date,
		tail,
		requireDateOrTail: kind === 'card' && Boolean(date || tail),
		requireDate: kind === 'loan' && Boolean(date)
	}
}

function makeTargets(facts) {
	const targets = []
	const add = (target) => targets.push({ critical: true, sensitive: false, ...target })
	add({ key: 'report.report_date', entityKey: 'document', field: 'report_date', valueType: 'date', rawValue: facts?.meta?.report_date || facts?.basic_info?.report_date, anchors: {}, labels: ['报告日期', '报告时间', '报告日'] })

	const loanRows = stableRows([
		...arrayAt(facts?.loan_details?.bank_loans),
		...arrayAt(facts?.loan_details?.non_bank_loans),
		...arrayAt(facts?.loan_details?.unknown_loans)
	])
		loanRows.forEach((row, index) => {
			const entityKey = `loan:${index}`
			const entitySubtype = `${classifyLoanInstitution(row)}_loan`
			const anchors = buildAnchors(row, 'loan')
			const currency = resolveCurrencyFields(row.currency, row.currency_code, { missingCode: 'CNY' })
			// Official domestic-loan narratives commonly omit an explicit currency.
			// Keep that compatibility only together with the source-side foreign-
			// currency guard in buildEvidenceGraph: any foreign signal linked to this
			// closed record (including an adjacent MuPDF source group) fails closed.
			add({ key: `${entityKey}:balance`, entityKey, entityKind: 'loan', entitySubtype, field: 'balance', valueType: 'money', currencyCode: currency.code, allowImplicitCnySourceCurrency: currency.missing === true, rawValue: row.balance ?? row.remaining_balance, anchors, labels: ['当前余额', '贷款余额', '余额'] })
			if (currency.hasInput) {
				add({ key: `${entityKey}:currency`, entityKey, entityKind: 'loan', entitySubtype, field: 'currency', valueType: 'currency', rawValue: currency.valid ? currency.code : null, anchors })
			}
			add({ key: `${entityKey}:institution`, entityKey, entityKind: 'loan', entitySubtype, field: 'institution_identity', valueType: 'text', rawValue: anchors.institution, anchors: {}, sensitive: true, critical: false })
		})

	stableRows(facts?.credit_card_details).forEach((row, index) => {
		const entityKey = `card:${index}`
		const anchors = buildAnchors(row, 'card')
		const currency = resolveCurrencyFields(row.currency, row.currency_code)
		const explicitGroup = row.shared_credit_group || row.sharedCreditGroup || row.utilization_group || row.utilizationGroup
		// PRD-DECISION-001：模型声明未激活时，货币/额度类字段按状态豁免绑定，
		// 记录级绑定改由激活状态目标驱动（状态必须有源行证据才能通过）。
		const notActivated = modelCardNotActivated(row)
		const stateExempt = notActivated ? { cardNotActivatedExempt: true, assignmentRequired: false } : {}
		add({ key: `${entityKey}:credit_limit`, entityKey, entityKind: 'card', field: 'credit_limit', valueType: 'money', currencyCode: currency.code, rawValue: row.credit_limit, anchors, labels: ['授信额度', '信用额度', '账户额度'], ...stateExempt })
		add({ key: `${entityKey}:used_limit`, entityKey, entityKind: 'card', field: 'used_limit', valueType: 'money', currencyCode: currency.code, rawValue: row.used_limit ?? row.used_amount ?? row.balance, anchors, labels: ['已用额度', '已使用额度', '已用金额', '使用额度'], ...stateExempt })
		add({ key: `${entityKey}:currency`, entityKey, entityKind: 'card', field: 'currency', valueType: 'currency', rawValue: currency.valid ? currency.code : null, anchors, ...stateExempt })
		const installment = row.installment ?? row.large_installment
		add({
			key: `${entityKey}:installment`,
			entityKey,
			entityKind: 'card',
			field: 'installment',
			valueType: 'money',
			currencyCode: currency.code,
			rawValue: installment,
			anchors,
			labels: ['未出单大额专项分期余额', '大额分期余额', '专项分期余额', '分期余额'],
			assignmentRequired: installment !== null && installment !== undefined && installment !== '',
			absencePolicy: 'card-installment',
			...stateExempt
		})
		if (notActivated) {
			add({ key: `${entityKey}:activation_state`, entityKey, entityKind: 'card', field: 'activation_state', valueType: 'card_activation_state', rawValue: canonicalString(row.status), anchors })
		}
		add({ key: `${entityKey}:institution`, entityKey, entityKind: 'card', field: 'institution_identity', valueType: 'text', rawValue: anchors.institution, anchors: {}, sensitive: true, critical: false })
		add({ key: `${entityKey}:start_date`, entityKey, entityKind: 'card', field: 'start_date_identity', valueType: 'date', rawValue: anchors.date, anchors: { institution: anchors.institution }, sensitive: true, critical: false })
		add({ key: `${entityKey}:tail`, entityKey, entityKind: 'card', field: 'tail_identity', valueType: 'text', rawValue: anchors.tail, anchors: { institution: anchors.institution }, sensitive: true, critical: false })
		if (explicitGroup && !isExplicitNoSharedCreditToken(explicitGroup)) {
			add({ key: `${entityKey}:shared_group`, entityKey, entityKind: 'card', field: 'shared_group_identity', valueType: 'shared_group', rawValue: explicitGroup, anchors, labels: ['授信协议编号', '信用协议编号', '共享额度组', '共享授信组', '额度组'], sensitive: true, critical: false })
		}
	})

	stableRows(facts?.query_analysis?.query_details).forEach((row, index) => {
		const entityKey = `query:${index}`
		const entitySubtype = classifyInstitution(row)
		const anchors = { institution: canonicalString(row.institution || row.org || row.bank) }
		add({ key: `${entityKey}:date`, entityKey, entityKind: 'query', entitySubtype, field: 'date', valueType: 'date', rawValue: row.date || row.query_date, anchors })
		add({ key: `${entityKey}:reason`, entityKey, entityKind: 'query', entitySubtype, field: 'reason', valueType: 'text', rawValue: row.reason || row.query_reason, anchors: { ...anchors, date: parseDate(row.date || row.query_date), requireDateOrTail: true } })
	})
	return targets
}

function containsVariant(searchText, variants) {
	for (const variant of variants) {
		const needle = normalizedSearchText(variant)
		if (!needle) continue
		const start = searchText.indexOf(needle)
		if (start >= 0) return { needle, start, end: start + needle.length }
	}
	return null
}

function containsLabeledVariant(searchText, variants, labels) {
	const normalizedLabels = Array.isArray(labels)
		? labels.map(normalizedSearchText).filter(Boolean).sort((a, b) => b.length - a.length)
		: []
	if (!normalizedLabels.length) return containsVariant(searchText, variants)
	for (const label of normalizedLabels) {
		let labelAt = searchText.indexOf(label)
		while (labelAt >= 0) {
			const valueStart = labelAt + label.length
			const bounded = searchText.slice(valueStart, valueStart + 64)
			const match = containsVariant(bounded, variants)
			if (match) {
				return {
					needle: match.needle,
					start: valueStart + match.start,
					end: valueStart + match.end
				}
			}
			labelAt = searchText.indexOf(label, labelAt + label.length)
		}
	}
	return null
}

function exactMoneyMatch(searchText, expectedMoney, {
	firstTokenOnly = false,
	anchored = false,
	requireExplicitEnd = false
} = {}) {
	if (!expectedMoney || expectedMoney.type !== 'money') return null
	const matcher = anchored
		? /^([：:=#\s]*(?:(?:为|是)\s*)?)([-+]?(?:\d{1,3}(?:[,，]\d{3})+|\d+)(?:\.\d+)?\s*(?:万)?\s*(?:元)?)(?!\d)/g
		: /(^|[^\d])([-+]?(?:\d{1,3}(?:[,，]\d{3})+|\d+)(?:\.\d+)?\s*(?:万)?\s*(?:元)?)(?!\d)/g
	let match
	while ((match = matcher.exec(searchText)) !== null) {
		const matchedTokenText = String(match[2] || '')
		const token = matchedTokenText.trim()
		const tokenStart = match.index + String(match[1] || '').length
		const sourceTail = String(searchText || '').slice(tokenStart + matchedTokenText.length)
		const nextSourceChar = sourceTail[0] || ''
		// Without an explicit unit, a following decimal/thousands connector means
		// this is only a line fragment (`15,` + `000`, or `15.` + `00`). Treating
		// `15` as a complete amount would silently bind a different fact.
		const hasExplicitUnit = /(?:元|万)$/u.test(token)
		const numericConnectorContinues = /^[.,，]\s*\d/u.test(sourceTail)
		// A decimal/thousands connector at the end of an atomic source line is
		// never a proven field terminator.  This stays incomplete even when the
		// line is the final member of a bundle (`15,` may be a clipped `15,000`).
		const connectorEndsBeforeContinuation = /^[.,，]\s*$/u.test(sourceTail)
		const incompleteAtLineBoundary = !hasExplicitUnit && (
			numericConnectorContinues ||
			connectorEndsBeforeContinuation ||
			(requireExplicitEnd && !nextSourceChar)
		)
		if (incompleteAtLineBoundary) {
			if (firstTokenOnly) return null
			continue
		}
		const parsed = moneyMagnitude(token)
		// A labeled field owns its first complete numeric token only. Continuing
		// after a mismatch would let `余额11000，尾号1000` bind the expected
		// balance 1000 to an unrelated trailing number on the same source row.
		if (!parsed || parsed.minor !== expectedMoney.minor) {
			if (firstTokenOnly) return null
			continue
		}
		const start = tokenStart
		return { needle: token, start, end: start + token.length }
	}
	return null
}

function hasLabeledMoneyToken(searchText, labels) {
	const normalizedLabels = Array.isArray(labels)
		? labels.map(normalizedSearchText).filter(Boolean).sort((a, b) => b.length - a.length)
		: []
	for (const label of normalizedLabels) {
		let labelAt = String(searchText || '').indexOf(label)
		while (labelAt >= 0) {
			const bounded = String(searchText || '').slice(labelAt + label.length, labelAt + label.length + 128)
			const token = bounded.match(/^([：:=#\s]*(?:(?:为|是)\s*)?)([-+]?(?:\d{1,3}(?:[,，]\d{3})+|\d+)(?:\.\d+)?\s*(?:万)?\s*(?:元)?)(?!\d)/)
			if (token) {
				const matchedTokenText = String(token[2] || '')
				const rawToken = matchedTokenText.trim()
				const tokenStart = String(token[1] || '').length
				const sourceTail = bounded.slice(tokenStart + matchedTokenText.length)
				const nextSourceChar = sourceTail[0] || ''
				const hasExplicitUnit = /(?:元|万)$/u.test(rawToken)
				const incompleteAtLineBoundary = !hasExplicitUnit && (
					/^[.,，]\s*\d/u.test(sourceTail) ||
					/^[.,，]\s*$/u.test(sourceTail) ||
					!nextSourceChar
				)
				if (!incompleteAtLineBoundary && moneyMagnitude(rawToken)) return true
			}
			labelAt = String(searchText || '').indexOf(label, labelAt + label.length)
		}
	}
	return false
}

function sourceSharedGroupTokenMatch(sourceText, hashFn, documentId, { requireExplicitEnd = false } = {}) {
	const source = String(sourceText || '')
	const prefix = source.match(/^[：:=#\s]*/u)?.[0] || ''
	const remainder = source.slice(prefix.length)
	if (!remainder) return { status: 'missing', token: '', groupId: '', start: prefix.length, end: prefix.length }
	const tokenMatch = remainder.match(/^([A-Za-z0-9\u3400-\u9FFF][A-Za-z0-9\u3400-\u9FFF._/\\:\-\u2010-\u2015\u2212]{0,127})/u)
	if (!tokenMatch) return { status: 'invalid', token: '', groupId: '', start: prefix.length, end: prefix.length }
	const token = tokenMatch[1]
	const start = prefix.length
	const end = start + token.length
	if (!hasCompleteSharedGroupTokenShape(token)) return { status: 'invalid', token, groupId: '', start, end }
	const suffix = source.slice(end)
	const trimmedSuffix = suffix.trimStart()
	const hasExplicitTerminator = /^[,，;；。|｜)）]/u.test(trimmedSuffix) ||
		/^\s+(?:授信额度|信用额度|账户额度|已用额度|已使用额度|已用金额|使用额度|币种|状态|截至|截止)/u.test(suffix)
	if (!hasExplicitTerminator && (suffix || requireExplicitEnd)) return { status: 'incomplete', token, groupId: '', start, end }
	const groupId = buildSourceSharedGroupId(token, hashFn, documentId)
	return groupId
		? { status: 'valid', token, groupId, start, end }
		: { status: 'invalid', token, groupId: '', start, end }
}

function targetLabelHasCompatibleRecordContext(searchText, target, normalizedLabel, options = {}) {
	if (target?.entityKind !== 'loan' || target?.field !== 'balance') return true
	const source = String(searchText || '')
	if (/担保责任余额|信用额度余额|授信额度余额|其他业务余额/u.test(source)) return false
	// Bare `余额` is too broad to prove a loan fact. It may only be used when
	// the same atomic line identifies loan context or a proven, closed account
	// bundle owns this continuation. Explicitly unrelated liabilities above are
	// still rejected even inside such a segment.
	if (normalizedLabel === normalizedSearchText('余额')) {
		return /贷款|借款|信贷/u.test(source) || options.allowBoundAccountContinuation === true
	}
	return true
}

function labeledMatch(searchText, target, typedValue, hashFn, documentId, options = {}) {
	const labels = Array.isArray(target.labels)
		? target.labels.map(normalizedSearchText).filter(Boolean).sort((a, b) => b.length - a.length)
		: []
	if (!labels.length) {
		if (target.valueType === 'money') return exactMoneyMatch(searchText, typedValue)
		return containsVariant(searchText, targetVariants(target))
	}
	for (const label of labels) {
		if (!targetLabelHasCompatibleRecordContext(searchText, target, label, options)) continue
		let labelAt = searchText.indexOf(label)
		while (labelAt >= 0) {
			const valueStart = labelAt + label.length
			const bounded = searchText.slice(valueStart, valueStart + 128)
			let match = null
			if (target.valueType === 'money') {
				match = exactMoneyMatch(bounded, typedValue, {
					firstTokenOnly: true,
					anchored: true,
					requireExplicitEnd: options.requireExplicitEnd === true
				})
			} else if (target.valueType === 'shared_group') {
				const tokenMatch = sourceSharedGroupTokenMatch(bounded, hashFn, documentId, {
					requireExplicitEnd: options.requireExplicitEnd === true
				})
				if (tokenMatch.status === 'valid' && tokenMatch.groupId === typedValue?.id) {
					match = { needle: tokenMatch.token, start: tokenMatch.start, end: tokenMatch.end }
				}
			} else {
				match = containsVariant(bounded, targetVariants(target))
			}
			if (match) {
				return {
					needle: match.needle,
					start: valueStart + match.start,
					end: valueStart + match.end
				}
			}
			labelAt = searchText.indexOf(label, labelAt + label.length)
		}
	}
	return null
}

function hasTargetLabel(searchText, target) {
	return Array.isArray(target.labels) && target.labels.some((label) =>
		searchText.includes(normalizedSearchText(label))
	)
}

function consecutiveAtomicSourceLines(left, right) {
	return Boolean(
		left && right &&
		left.pageNo === right.pageNo &&
		left.sourceGroupId === right.sourceGroupId &&
		right.sourceLineOrdinal === left.sourceLineOrdinal + 1
	)
}

function independentCardBalanceLabels(searchText) {
	const source = String(searchText || '')
	const labels = []
	const pattern = /(^|[，,；;。.!！?？、:：|｜])\s*余额(?=$|[：:=#\s+\-\d])/gu
	let match
	while ((match = pattern.exec(source)) !== null) {
		const labelStart = match.index + match[0].lastIndexOf('余额')
		const precedingField = source.slice(0, match.index).replace(/[，,；;。.!！?？、:：=|｜\s]+$/gu, '')
		if (QUALIFIED_BALANCE_CONTEXT_PATTERN.test(precedingField)) continue
		labels.push({
			start: labelStart,
			end: labelStart + '余额'.length,
			lineLeading: match.index === 0
		})
	}
	return labels
}

const QUALIFIED_BALANCE_CONTEXT_PATTERN = /(?:专项分期|分期付款|担保责任|贷款|借款|其他业务|授信|信用额度|授信额度|账户额度)\s*$/u

function priorAtomicLineQualifiesBalance(members, block, label) {
	if (label?.lineLeading !== true) return false
	const previous = arrayAt(members).find((candidate) => consecutiveAtomicSourceLines(candidate, block))
	const precedingField = String(previous?.searchText || '').replace(/[，,；;。.!！?？、:：=|｜\s]+$/gu, '')
	return Boolean(previous && QUALIFIED_BALANCE_CONTEXT_PATTERN.test(precedingField))
}

function controlledCardUsedBalanceMatch(target, bundle, typedValue, hashFn, documentId) {
	if (
		target?.entityKind !== 'card' ||
		target?.field !== 'used_limit' ||
		typedValue?.type !== 'money' ||
		bundle?.recordMembershipProven !== true ||
		bundle?.recordClosureProven !== true
	) return null

	const members = arrayAt(bundle.members)
	const fields = members.flatMap((block) =>
		independentCardBalanceLabels(block.searchText)
			.filter((label) => !priorAtomicLineQualifiesBalance(members, block, label))
			.map((label) => ({ block, label }))
	)
	// Multiple standalone balance fields inside one account segment are
	// ambiguous. Never select one merely because its number happens to match.
	if (fields.length !== 1) return null

	const { block, label } = fields[0]
	const nextBlock = members.find((candidate) => consecutiveAtomicSourceLines(block, candidate))
	const afterLabel = block.searchText.slice(label.end, label.end + 128)
	const sameLineValue = exactMoneyMatch(afterLabel, typedValue, {
		firstTokenOnly: true,
		anchored: true,
		requireExplicitEnd: Boolean(nextBlock)
	})
	if (sameLineValue) {
		const match = {
			needle: block.searchText.slice(label.start, label.end + sameLineValue.end),
			start: label.start,
			end: label.end + sameLineValue.end
		}
		return {
			block,
			match,
			refs: [evidenceRef({ block, match }, hashFn, documentId)],
			blocks: [block]
		}
	}

	// A wrapped value is permitted only when the balance field itself ends the
	// atomic line and the first complete token on the immediate next atomic line
	// is the expected amount. No source-group join or skipped line is allowed.
	if (!nextBlock || !/^[：:=#\s]*$/u.test(afterLabel)) return null
	const followingBlock = members.find((candidate) => consecutiveAtomicSourceLines(nextBlock, candidate))
	const nextLineValue = exactMoneyMatch(nextBlock.searchText, typedValue, {
		firstTokenOnly: true,
		anchored: true,
		requireExplicitEnd: Boolean(followingBlock)
	})
	if (!nextLineValue) return null
	const labelMatch = {
		needle: '余额',
		start: label.start,
		end: label.end
	}
	const valueMatch = {
		needle: nextLineValue.needle,
		start: nextLineValue.start,
		end: nextLineValue.end
	}
	return {
		block: nextBlock,
		match: valueMatch,
		refs: [
			evidenceRef({ block, match: labelMatch }, hashFn, documentId),
			evidenceRef({ block: nextBlock, match: valueMatch }, hashFn, documentId)
		],
		blocks: [block, nextBlock]
	}
}

function hasCompleteMoneyToken(searchText) {
	const source = String(searchText || '')
	const matcher = /(^|[^\d])([-+]?(?:\d{1,3}(?:[,，]\d{3})+|\d+)(?:\.\d+)?\s*(?:万)?\s*(?:元)?)(?!\d)/gu
	let match
	while ((match = matcher.exec(source)) !== null) {
		const tokenText = String(match[2] || '')
		const token = tokenText.trim()
		const tokenStart = match.index + String(match[1] || '').length
		const tail = source.slice(tokenStart + tokenText.length)
		const hasExplicitUnit = /(?:元|万)$/u.test(token)
		if (!hasExplicitUnit && (/^[.,，]\s*\d/u.test(tail) || /^[.,，]\s*$/u.test(tail))) continue
		if (moneyMagnitude(token)) return true
	}
	return false
}

function sourceMoneyAtStart(searchText, { requireExplicitEnd = false, requireUniqueToken = false } = {}) {
	const source = String(searchText || '')
	const tokenMatch = source.match(/^([：:=#\s]*(?:(?:为|是)\s*)?)([-+]?(?:\d{1,3}(?:[,，]\d{3})+|\d+)(?:\.\d+)?\s*(?:万)?\s*(?:元)?)(?!\d)/u)
	if (!tokenMatch) return null
	const tokenText = String(tokenMatch[2] || '')
	const token = tokenText.trim()
	const start = String(tokenMatch[1] || '').length
	const end = start + tokenText.length
	const tail = source.slice(end)
	const hasExplicitUnit = /(?:元|万)$/u.test(token)
	if (!hasExplicitUnit && (
		/^[.,，]\s*\d/u.test(tail) ||
		/^[.,，]\s*$/u.test(tail) ||
		(requireExplicitEnd && !tail[0])
	)) return null
	const value = moneyMagnitude(token)
	if (requireUniqueToken && hasCompleteMoneyToken(tail)) return null
	return value ? { value, needle: token, start, end } : null
}

function sourceCnyMoneyMatchHasSafeTerminator(selected, { allowNextMoneyField = false } = {}) {
	const source = String(selected?.block?.searchText || '')
	const end = Number(selected?.match?.end)
	if (!source || !Number.isInteger(end) || end < 0 || end > source.length) return false
	let tail = source.slice(end).trimStart()
	// The generic number parser may stop before the explicit long-form domestic
	// unit. Consume only that closed CNY spelling; every other adjacent word,
	// ISO code, or currency symbol remains an unsafe suffix.
	if (tail.startsWith('人民币元')) tail = tail.slice('人民币元'.length).trimStart()
	if (!tail) return true
	tail = tail.replace(/^(?:\s|[，,；;。.）)\]】])+/u, '')
	if (!tail) return true
	// Positive installment repair is deliberately terminal: even a syntactically
	// valid status/date field would leave unverified free text after the repaired
	// scoring input. Primary limit/used values may precede another controlled
	// money field, but the complete following field (and every later one) must be
	// parsed here rather than accepted by a label prefix.
	if (!allowNextMoneyField) return false
	const nextField = tail.match(new RegExp(
		`^(?:${SOURCE_CARD_MONEY_FIELD}|余额)(?=\\s*[：:=#]?\\s*[-+]?\\d)`,
		'iu'
	))
	if (!nextField) return false
	const afterLabel = tail.slice(nextField[0].length)
	const nextValue = sourceMoneyAtStart(afterLabel, {
		requireExplicitEnd: false,
		requireUniqueToken: false
	})
	if (!nextValue) return false
	const valueStart = nextField[0].length + nextValue.start
	const valueEnd = nextField[0].length + nextValue.end
	return sourceCnyMoneyMatchHasSafeTerminator({
		block: { searchText: tail },
		match: {
			start: valueStart,
			end: valueEnd
		}
	}, { allowNextMoneyField: true })
}

function sourceMoneyMatchIsLastNonemptyBundleMember(selected, bundle, sourceBlocks = []) {
	const block = selected?.block
	const members = arrayAt(bundle?.members)
	const selectedIndex = members.findIndex((member) =>
		member?.blockId === block?.blockId &&
		member?.pageNo === block?.pageNo &&
		member?.sourceGroupId === block?.sourceGroupId &&
		member?.sourceLineOrdinal === block?.sourceLineOrdinal
	)
	if (selectedIndex < 0) return false
	if (members.slice(selectedIndex + 1).some((member) => normalizeString(member?.searchText))) return false

	// MuPDF can emit an immediate visual continuation as the next original block
	// rather than as another line in the same source group. Such a block is not a
	// proven record boundary and therefore prevents this amount from being the
	// terminal fact of the closed card record.
	const orderedPageBlocks = arrayAt(sourceBlocks)
		.filter((candidate) => candidate?.pageNo === block?.pageNo)
		.sort((left, right) => left.charStart - right.charStart || compareMachineText(left.blockId, right.blockId))
	const globalIndex = orderedPageBlocks.findIndex((candidate) => candidate?.blockId === block?.blockId)
	if (globalIndex < 0) return false
	const nextBlock = orderedPageBlocks.slice(globalIndex + 1).find((candidate) => normalizeString(candidate?.searchText))
	if (
		nextBlock &&
		!members.some((member) => member.blockId === nextBlock.blockId) &&
		!accountRecordBoundary(nextBlock) &&
		foreignCurrencySignalRelatesToAccountBundle(nextBlock, bundle)
	) return false
	return true
}

function nonOverlappingLabelOccurrences(searchText, labels) {
	const source = String(searchText || '')
	const occurrences = []
	for (const rawLabel of [...labels].sort((left, right) => right.length - left.length)) {
		const label = normalizedSearchText(rawLabel)
		let start = source.indexOf(label)
		while (start >= 0) {
			const end = start + label.length
			if (!occurrences.some((item) => start >= item.start && end <= item.end)) {
				occurrences.push({ label, start, end })
			}
			start = source.indexOf(label, start + label.length)
		}
	}
	return occurrences.sort((left, right) => left.start - right.start || right.label.length - left.label.length)
}

function controlledSourceInstallmentMatch(target, bundle, hashFn, documentId, {
	allowPositive = false,
	sourceBlocks = []
} = {}) {
	if (
		target?.absencePolicy !== 'card-installment' ||
		bundle?.kind !== 'card' ||
		bundle?.recordMembershipProven !== true ||
		bundle?.recordClosureProven !== true ||
		!Array.isArray(target.labels)
	) return { status: 'unproven', matches: [], signals: [] }

	const targetCurrency = currencyValue(target.currencyCode)
	if (!targetCurrency) return { status: 'unproven', matches: [], signals: [] }
	const members = arrayAt(bundle.members)
	const signals = []
	const matches = []
	let labeledOccurrenceCount = 0
	const addMatch = ({ value, evidenceParts }) => {
		const typedValue = { type: 'money', currency: targetCurrency.code, ...value }
		const selectedValue = evidenceParts[evidenceParts.length - 1]
		if (
			allowPositive === true &&
			typedValue.minor > 0 &&
			(
				!sourceCnyMoneyMatchHasSafeTerminator(selectedValue) ||
				!sourceMoneyMatchIsLastNonemptyBundleMember(selectedValue, bundle, sourceBlocks)
			)
		) return
		const refs = evidenceParts.map((part) => evidenceRef(part, hashFn, documentId))
		const signature = stableCanonicalize({
			value: typedValue,
			spans: refs.map((ref) => ({ blockId: ref.blockId, offset: ref.span.offset, length: ref.span.length }))
		})
		if (!matches.some((item) => item.signature === signature)) matches.push({ value: typedValue, refs, signature })
	}

	for (const block of members) {
		for (const occurrence of nonOverlappingLabelOccurrences(block.searchText, target.labels)) {
			labeledOccurrenceCount += 1
			signals.push(block)
			const afterLabel = block.searchText.slice(occurrence.end, occurrence.end + 128)
			const nextBlock = members.find((candidate) => consecutiveAtomicSourceLines(block, candidate))
			let valueMatch = sourceMoneyAtStart(afterLabel, {
				requireExplicitEnd: Boolean(nextBlock),
				requireUniqueToken: true
			})
			if (valueMatch) {
				addMatch({
					value: valueMatch.value,
					evidenceParts: [{
						block,
						match: {
							needle: block.searchText.slice(occurrence.start, occurrence.end + valueMatch.end),
							start: occurrence.start,
							end: occurrence.end + valueMatch.end
						}
					}]
				})
				continue
			}
			if (!nextBlock || !/^[：:=#\s]*$/u.test(afterLabel)) continue
			const followingBlock = members.find((candidate) => consecutiveAtomicSourceLines(nextBlock, candidate))
			valueMatch = sourceMoneyAtStart(nextBlock.searchText, {
				requireExplicitEnd: Boolean(followingBlock),
				requireUniqueToken: true
			})
			if (!valueMatch) continue
			addMatch({
				value: valueMatch.value,
				evidenceParts: [
					{
						block,
						match: { needle: occurrence.label, start: occurrence.start, end: occurrence.end }
					},
					{
						block: nextBlock,
						match: { needle: valueMatch.needle, start: valueMatch.start, end: valueMatch.end }
					}
				]
			})
		}
	}

	// A controlled label itself may wrap at an atomic-line boundary. Match only
	// the longest configured label at that boundary; nested shorter labels must
	// not manufacture duplicate candidates for the same source field.
	const orderedLabels = [...target.labels].map(normalizedSearchText).sort((left, right) => right.length - left.length)
	for (let index = 0; index + 1 < members.length; index += 1) {
		const left = members[index]
		const right = members[index + 1]
		if (!consecutiveAtomicSourceLines(left, right)) continue
		let acceptedBoundary = false
		for (const label of orderedLabels) {
			for (let split = 1; split < label.length; split += 1) {
				const prefix = label.slice(0, split)
				const suffix = label.slice(split)
				if (!left.searchText.endsWith(prefix) || !right.searchText.startsWith(suffix)) continue
				labeledOccurrenceCount += 1
				signals.push(left, right)
				const afterLabel = right.searchText.slice(suffix.length, suffix.length + 128)
				const valueMatch = sourceMoneyAtStart(afterLabel, { requireUniqueToken: true })
				if (valueMatch) addMatch({
					value: valueMatch.value,
					evidenceParts: [
						{
							block: left,
							match: { needle: prefix, start: left.searchText.length - prefix.length, end: left.searchText.length }
						},
						{
							block: right,
							match: {
								needle: right.searchText.slice(0, suffix.length + valueMatch.end),
								start: 0,
								end: suffix.length + valueMatch.end
							}
						}
					]
				})
				acceptedBoundary = true
				break
			}
			if (acceptedBoundary) break
		}
	}

	const uniqueSignals = [...new Map(signals.map((block) => [block.blockId, block])).values()]
	// A model-omitted positive installment changes deterministic scoring inputs
	// and therefore cannot be repaired inside the evidence layer alone. The
	// pre-rule controlled repair may opt in only after it has proved a unique,
	// closed, one-to-one CNY card binding. Evidence construction itself keeps the
	// old zero-only behavior so positive or ambiguous values still fail closed if
	// that upstream proof did not run.
	if (
		matches.length === 1 &&
		labeledOccurrenceCount === 1 &&
		(matches[0].value.minor === 0 || allowPositive === true)
	) {
		return { status: 'matched', match: matches[0], signals: uniqueSignals }
	}
	return {
		status: matches.length > 1 || labeledOccurrenceCount > 1 ? 'ambiguous' : 'missing',
		matches,
		signals: uniqueSignals
	}
}

function controlledSplitLabelSignal(target, bundle) {
	if (!Array.isArray(target?.labels)) return null
	const members = arrayAt(bundle?.members)
	const consecutive = (left, right) => Boolean(
		left && right &&
		left.pageNo === right.pageNo &&
		left.sourceGroupId === right.sourceGroupId &&
		right.sourceLineOrdinal === left.sourceLineOrdinal + 1
	)
	for (let index = 0; index < members.length; index += 1) {
		const left = members[index]
		const right = members[index + 1]
		for (const rawLabel of target.labels) {
			const label = normalizedSearchText(rawLabel)
			for (let split = 1; split <= label.length; split += 1) {
				const prefix = label.slice(0, split)
				const suffix = label.slice(split)
				if (!left.searchText.endsWith(prefix) || !consecutive(left, right) || !right.searchText.startsWith(suffix)) continue
				const bounded = right.searchText.slice(suffix.length, suffix.length + 128)
				if (hasLabeledMoneyToken(`${label}${bounded}`, [label])) return { blocks: [left, right] }
				const third = members[index + 2]
				if (
					consecutive(right, third) &&
					/^[：:=#\s]*$/u.test(bounded) &&
					hasLabeledMoneyToken(`${label}${bounded}${third.searchText}`, [label])
				) return { blocks: [left, right, third] }
			}
		}
	}
	return null
}

function controlledSplitSharedGroupSignal(bundle, documentId, hashFn) {
	const labels = ['授信协议编号', '信用协议编号', '共享额度组', '共享授信组', '额度组']
	const members = arrayAt(bundle?.members)
	const consecutive = (left, right) => Boolean(
		left && right &&
		left.pageNo === right.pageNo &&
		left.sourceGroupId === right.sourceGroupId &&
		right.sourceLineOrdinal === left.sourceLineOrdinal + 1
	)
	let conservative = null
	for (let index = 0; index < members.length; index += 1) {
		const left = members[index]
		const right = members[index + 1]
		for (const rawLabel of labels) {
			const label = normalizedSearchText(rawLabel)
			const completeLabelMatch = left.searchText.match(new RegExp(`(${escapeRegExp(label)}[：:=#]?)$`, 'u'))
			if (completeLabelMatch) {
				const leftToken = completeLabelMatch[1]
				const leftMatch = {
					needle: leftToken,
					start: left.searchText.length - leftToken.length,
					end: left.searchText.length
				}
				if (consecutive(left, right)) {
					const tokenMatch = sourceSharedGroupTokenMatch(right.searchText, hashFn, documentId)
					if (tokenMatch.status === 'valid') return {
						status: 'valid',
						groupId: tokenMatch.groupId,
						blocks: [left, right],
						evidenceParts: [
							{ block: left, match: leftMatch },
							{ block: right, match: { needle: tokenMatch.token, start: tokenMatch.start, end: tokenMatch.end } }
						]
					}
					if (!conservative) conservative = {
						status: tokenMatch.status,
						blocks: [left, right],
						evidenceParts: [{ block: left, match: leftMatch }]
					}
				} else if (!conservative) {
					conservative = { status: 'partial', blocks: [left], evidenceParts: [{ block: left, match: leftMatch }] }
				}
			}
			for (let split = 1; split <= label.length; split += 1) {
				const prefix = label.slice(0, split)
				const suffix = label.slice(split)
				if (!left.searchText.endsWith(prefix)) continue
				const leftMatch = {
					needle: prefix,
					start: left.searchText.length - prefix.length,
					end: left.searchText.length
				}
				if (!consecutive(left, right) || !right.searchText.startsWith(suffix)) {
					const distinctivePartial = prefix.includes('共享') || prefix.includes('协议')
					const prefixStart = left.searchText.length - prefix.length
					const prefixBoundary = prefixStart === 0 || /[\s,，;；:：]/u.test(left.searchText[prefixStart - 1])
					if (prefix.length >= 2 && distinctivePartial && prefixBoundary && !conservative) conservative = {
						status: 'partial', blocks: [left], evidenceParts: [{ block: left, match: leftMatch }]
					}
					continue
				}
				const afterLabel = right.searchText.slice(suffix.length)
				let tokenMatch = sourceSharedGroupTokenMatch(afterLabel, hashFn, documentId)
				let valueBlock = right
				let valueOffset = suffix.length
				const evidenceParts = [{ block: left, match: leftMatch }]
				if (tokenMatch.status === 'missing') {
					const third = members[index + 2]
					if (consecutive(right, third) && /^[：:=#\s]*$/u.test(afterLabel)) {
						tokenMatch = sourceSharedGroupTokenMatch(third.searchText, hashFn, documentId)
						valueBlock = third
						valueOffset = 0
						if (suffix) evidenceParts.push({
							block: right,
							match: { needle: suffix, start: 0, end: suffix.length }
						})
						if (tokenMatch.status !== 'missing') evidenceParts.push({
							block: third,
							match: {
								needle: tokenMatch.token,
								start: tokenMatch.start,
								end: tokenMatch.end
							}
						})
					}
				}
				if (tokenMatch.status === 'valid') {
					if (valueBlock === right) evidenceParts.push({
						block: right,
						match: {
							needle: tokenMatch.token,
							start: valueOffset + tokenMatch.start,
							end: valueOffset + tokenMatch.end
						}
					})
					return {
						status: 'valid',
						groupId: tokenMatch.groupId,
						blocks: [...new Map(evidenceParts.map((part) => [part.block.blockId, part.block])).values()],
						evidenceParts
					}
				}
				if (!conservative) conservative = {
					status: tokenMatch.status === 'missing' ? 'partial' : tokenMatch.status,
					blocks: [...new Map(evidenceParts.map((part) => [part.block.blockId, part.block])).values()],
					evidenceParts
				}
			}
		}
	}
	return conservative
}

function matchesAnchors(block, anchors) {
	const source = block.searchText
	const institution = canonicalString(anchors?.institution)
	if (institution && !source.includes(normalizedSearchText(institution))) return false
	const tail = canonicalString(anchors?.tail)
	const date = anchors?.date
	if (anchors?.requireDateOrTail === true) {
		// Tail is the stronger row discriminator. Falling back to the opening
		// date only when no tail exists prevents two same-day cards from making
		// every amount/currency match ambiguous before the relation gate runs.
		if (tail) {
			if (!source.includes(tail)) return false
		} else if (date && !containsVariant(source, dateVariants(date))) {
			return false
		}
	}
	return true
}

function escapeRegExp(value) {
	return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasStrongCardIdentity(block, anchors) {
	const source = String(block?.searchText || '')
	const institution = normalizedSearchText(anchors?.institution)
	const tail = String(anchors?.tail || '').replace(/\D/g, '').slice(-4)
	if (!institution || !source.includes(institution) || tail.length !== 4) return false
	const tailPattern = new RegExp(
		`(?:^|[\\s（(，,；;。:：])(?:卡片尾号|账户标识尾号|账户尾号|卡号后四位|账号后四位|尾号)\\s*[：:=#]?\\s*${escapeRegExp(tail)}(?![A-Za-z0-9\\u3400-\\u9FFF])`,
		'u'
	)
	return tailPattern.test(source)
}

function targetMatches(target, blocks, hashFn, documentId) {
	const typedValue = typedTargetValue(target, hashFn, documentId)
	if (!typedValue) return { status: 'invalid', typedValue: null, matches: [], signals: [] }
	const matches = []
	const signals = []
	for (const block of blocks) {
		if (!matchesAnchors(block, target.anchors)) continue
		if (hasTargetLabel(block.searchText, target)) signals.push(block)
		const match = labeledMatch(block.searchText, target, typedValue, hashFn, documentId)
		if (match) matches.push({ block, match })
	}
	return { status: matches.length ? 'matched' : 'missing', typedValue, matches, signals }
}

function evidenceRef(selected, hashFn, documentId) {
	const normalizedSpan = { start: selected.match.start, end: selected.match.end }
	return {
		blockId: selected.block.blockId,
		pageNo: selected.block.pageNo,
		ordinal: selected.block.ordinal,
		span: {
			offset: selected.block.charStart,
			length: Math.max(0, selected.block.charEnd - selected.block.charStart)
		},
		polygon: selected.block.polygon,
		geometryState: selected.block.geometryState,
		normalizedSpan,
		quoteDigest: artifactHash('qt_v2', {
			documentId,
			blockId: selected.block.blockId,
			normalizedSpan
		}, hashFn)
	}
}

function matchTargetOnAssignedBlock(target, block, hashFn, documentId) {
	if (target.absencePolicy === 'card-installment' && !target.assignmentRequired) {
		if (hasTargetLabel(block.searchText, target)) {
			return { status: 'source-value-omitted', typedValue: null, refs: [], signals: [block] }
		}
		return {
			status: 'matched-absence',
			typedValue: { type: 'absence', code: 'NO_INSTALLMENT_SIGNAL' },
			refs: [{
				blockId: block.blockId,
				pageNo: block.pageNo,
				ordinal: block.ordinal,
				span: {
					offset: block.charStart,
					length: Math.max(0, block.charEnd - block.charStart)
				},
				polygon: block.polygon,
				geometryState: block.geometryState,
				normalizedSpan: null,
				quoteDigest: artifactHash('qt_v2', {
					documentId,
					absence: 'installment',
					blockId: block.blockId,
					normalizedSpan: null
				}, hashFn)
			}]
		}
	}
	const result = targetMatches(target, [block], hashFn, documentId)
	if (!result.matches.length) return { ...result, refs: [] }
	return {
		status: 'matched',
		typedValue: result.typedValue,
		refs: [evidenceRef(result.matches[0], hashFn, documentId)],
		signals: result.signals
	}
}

function polygonRect(block) {
	const polygon = Array.isArray(block?.polygon) ? block.polygon : null
	if (!polygon || polygon.length !== 4) return null
	const xs = polygon.map((point) => Number(point?.[0]))
	const ys = polygon.map((point) => Number(point?.[1]))
	if (![...xs, ...ys].every(Number.isFinite)) return null
	const rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
	return rect[2] > rect[0] && rect[3] > rect[1] ? rect : null
}

function verticalOverlapRatio(left, right) {
	const a = polygonRect(left)
	const b = polygonRect(right)
	if (!a || !b) return 0
	const overlap = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
	return overlap / Math.max(1e-9, Math.min(a[3] - a[1], b[3] - b[1]))
}

function horizontalOverlap(left, right) {
	const a = polygonRect(left)
	const b = polygonRect(right)
	if (!a || !b) return 0
	return Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
}

function verticalGap(left, right) {
	const a = polygonRect(left)
	const b = polygonRect(right)
	if (!a || !b) return Number.POSITIVE_INFINITY
	return Math.max(0, Math.max(a[1], b[1]) - Math.min(a[3], b[3]))
}

function foreignCurrencySignalRelatesToAccountBundle(signalBlock, bundle) {
	if (
		!signalBlock || !bundle ||
		bundle.recordMembershipProven !== true ||
		bundle.recordClosureProven !== true ||
		signalBlock.pageNo !== bundle.pageNo
	) return false
	if (arrayAt(bundle.members).some((member) => member.blockId === signalBlock.blockId)) return true

	return arrayAt(bundle.members).some((member) => {
		const signalRect = polygonRect(signalBlock)
		const memberRect = polygonRect(member)
		if (signalRect && memberRect) {
			// Geometry is authoritative over MuPDF emission order: unrelated source
			// blocks may be interleaved between two visually adjacent fragments.
			if (verticalOverlapRatio(signalBlock, member) >= 0.8) return true
			const maxHeight = Math.max(signalRect[3] - signalRect[1], memberRect[3] - memberRect[1])
			return verticalGap(signalBlock, member) <= maxHeight && horizontalOverlap(signalBlock, member) > 0
		}
		// Without geometry, adjacency is the only safe fallback. Both the original
		// source-block order and emitted atomic-block order must be consecutive.
		return Math.abs(signalBlock.sourceBlockOrdinal - member.sourceBlockOrdinal) === 1 &&
			Math.abs(signalBlock.ordinal - member.ordinal) === 1
	})
}

function recordBundle({
	kind,
	boundaryType,
	members,
	identityBlocks,
	institutionBlocks,
	documentId,
	hashFn,
	recordMembershipProven = false,
	recordClosureProven = false
}) {
	const sortedMembers = [...new Map(arrayAt(members).map((block) => [block.blockId, block])).values()]
		.sort((left, right) => left.pageNo - right.pageNo || left.charStart - right.charStart || compareMachineText(left.blockId, right.blockId))
	if (!sortedMembers.length || new Set(sortedMembers.map((block) => block.pageNo)).size !== 1) return null
	const memberIds = sortedMembers.map((block) => block.blockId)
	const identities = [...new Map(arrayAt(identityBlocks).map((block) => [block.blockId, block])).values()]
		.filter((block) => memberIds.includes(block.blockId))
	const institutions = [...new Map(arrayAt(institutionBlocks).map((block) => [block.blockId, block])).values()]
		.filter((block) => memberIds.includes(block.blockId))
	return {
		kind,
		boundaryType,
		recordMembershipProven: recordMembershipProven === true,
		recordClosureProven: recordClosureProven === true,
		pageNo: sortedMembers[0].pageNo,
		members: sortedMembers,
		identityBlocks: identities.length ? identities : [sortedMembers[0]],
		institutionBlocks: institutions,
		recordBindingId: artifactHash('rbd_v3', {
			documentId,
			kind,
			boundaryType,
			memberIds
		}, hashFn)
	}
}

function singletonRecordBundle(kind, block, documentId, hashFn) {
	const source = String(block?.searchText || '')
	const recordClosureProven = block?.sourceLineOrdinal === 1 && block?.sourceLineCount === 1
	const recordMembershipProven = kind === 'card'
		? (/信用卡|贷记卡|准贷记卡/u.test(source) || (
			/尾号/u.test(source) && /授信额度|信用额度|账户额度/u.test(source) && /已用额度|已使用额度|已用金额|使用额度/u.test(source)
		))
		: (kind === 'loan' ? /贷款余额|借款余额|信贷业务/u.test(source) : true)
	return recordBundle({
		kind,
		boundaryType: 'atomic-line',
		members: [block],
		identityBlocks: [block],
		documentId,
		hashFn,
		recordMembershipProven,
		recordClosureProven
	})
}

function accountRecordBoundary(block) {
	const source = String(block?.searchText || '').normalize('NFKC')
	if (!/(?:19|20)\d{2}\s*[年.\/-]\s*\d{1,2}\s*[月.\/-]\s*\d{1,2}/u.test(source)) return null
	if (/贷款审批|信用卡审批|贷记卡审批|贷后管理|担保资格审查|资信审查/u.test(source)) return null
	// Only an explicit as-of continuation is allowed to remain in the current
	// account segment. Every other dated row is a hard record boundary, even if
	// a newly introduced business wording or numbering style is unknown.
	if (/^\s*(?:截至|截止)/u.test(source)) return null
	// Official numbered account descriptions are hard boundaries even when a
	// new wording is not yet recognized. They may truncate a previous bundle,
	// but only a proven account kind/action below may become publishable.
	const looksNumberedRecord = /^\s*(?:(?:\(\s*\d{1,4}\s*\)|\[\s*\d{1,4}\s*\])|(?:\d{1,4}\s*[.、)]))/u.test(source)
	const hasCompleteCardShape = /尾号/u.test(source) &&
		/授信额度|信用额度|账户额度/u.test(source) &&
		/已用额度|已使用额度|已用金额|使用额度/u.test(source)
	const kind = /信用卡|贷记卡|准贷记卡/u.test(source) || hasCompleteCardShape
		? 'card'
		: (/贷款|信贷业务/u.test(source) ? 'loan' : '')
	if (!kind) return { kind: 'unknown', proven: false, numbered: looksNumberedRecord }
	const proven = /发放|授信|开立|办理|开通/u.test(source) || hasCompleteCardShape
	if (proven) return { kind, proven: true }
	// An unknown account-origination phrase is still a hard record boundary.
	// It may not publish by itself, but it must truncate the preceding proven
	// bundle so its values can never be borrowed by another account.
	return { kind, proven: false }
}

function buildAccountRecordBundles(blocks, kind, documentId, hashFn) {
	const groups = new Map()
	for (const block of blocks) {
		const key = `${block.pageNo}:${block.sourceGroupId}`
		if (!groups.has(key)) groups.set(key, [])
		groups.get(key).push(block)
	}
	const bundles = []
	for (const group of groups.values()) {
		group.sort((left, right) => left.sourceLineOrdinal - right.sourceLineOrdinal || left.charStart - right.charStart)
		const starts = []
		for (let index = 0; index < group.length; index += 1) {
			const boundary = accountRecordBoundary(group[index])
			if (boundary) starts.push({ index, ...boundary })
		}
		if (!starts.length) {
			for (const block of group) bundles.push(singletonRecordBundle(kind, block, documentId, hashFn))
			continue
		}
		for (let index = 0; index < starts.length; index += 1) {
			const start = starts[index]
			const end = index + 1 < starts.length ? starts[index + 1].index : group.length
			if (start.kind !== kind || start.proven !== true) continue
			const bundle = recordBundle({
				kind,
				boundaryType: 'account-source-segment',
				members: group.slice(start.index, end),
				identityBlocks: [group[start.index]],
				documentId,
				hashFn,
				recordMembershipProven: true,
				recordClosureProven: true
			})
			if (bundle) bundles.push(bundle)
		}
	}
	return bundles.filter((bundle) =>
		bundle && bundle.recordMembershipProven === true && bundle.recordClosureProven === true
	)
}

function attachExternalCardCurrencySignals(cardBundles, sourceBlocks, accountBundles = cardBundles) {
	const ownedBlockIds = new Set(arrayAt(accountBundles)
		.flatMap((bundle) => arrayAt(bundle.members))
		.map((block) => block.blockId))
	const candidates = arrayAt(sourceBlocks).filter((block) =>
		!ownedBlockIds.has(block.blockId) &&
		!accountRecordBoundary(block) &&
		controlledBareCurrencyAssertions(block).length > 0
	)
	const unclaimedSignals = []
	for (const block of candidates) {
		const related = arrayAt(cardBundles).filter((bundle) =>
			foreignCurrencySignalRelatesToAccountBundle(block, bundle)
		)
		if (related.length === 0) continue
		if (related.length > 1) {
			unclaimedSignals.push(block)
			continue
		}
		const owner = related[0]
		owner.currencySignalBlocks = [
			...arrayAt(owner.currencySignalBlocks),
			block
		]
	}
	return { cardBundles, unclaimedSignals }
}

function closedCardInstallmentContinuation(block) {
	const source = String(block?.searchText || '')
	const labels = ['未出单大额专项分期余额', '大额分期余额', '专项分期余额', '分期余额']
	const occurrences = nonOverlappingLabelOccurrences(source, labels)
	if (occurrences.length !== 1 || occurrences[0].start !== 0) return null
	if (
		new RegExp(SOURCE_CURRENCY_FIELD_LABEL, 'iu').test(source) ||
		hasCnyAssertionToken(source) ||
		SOURCE_FOREIGN_CURRENCY_SIGNAL_PATTERN.test(source) ||
		hasNonCnyUppercaseIsoToken(source) ||
		/(?:19|20)\d{2}\s*(?:年|[.\/-])|(?:截至|截止)|信用卡|贷记卡|准贷记卡|尾号|卡号后四位|账号后四位|银行|机构|贷款|借款|担保|信用额度|授信额度|账户额度|已用额度|已使用额度|已用金额|使用额度/u.test(source)
	) return null
	const occurrence = occurrences[0]
	const valueMatch = sourceMoneyAtStart(source.slice(occurrence.end), {
		requireExplicitEnd: false,
		requireUniqueToken: true
	})
	if (!valueMatch) return null
	const selected = {
		block,
		match: {
			start: occurrence.start,
			end: occurrence.end + valueMatch.end
		}
	}
	if (
		!sourceCnyMoneyMatchHasSafeTerminator(selected) ||
		!/^[\s，,；;。.!！?？]*$/u.test(source.slice(selected.match.end))
	) return null
	return { value: valueMatch.value, selected }
}

function structuredBlocksContinueBelow(ownerBlock, continuationBlock, {
	requireSingleLine = false,
	requireSourceAdjacency = true
} = {}) {
	if (
		!ownerBlock || !continuationBlock ||
		ownerBlock.sourceMode !== 'pdf-text' ||
		continuationBlock.sourceMode !== 'pdf-text' ||
		ownerBlock.pageNo !== continuationBlock.pageNo ||
		continuationBlock.ordinal !== ownerBlock.ordinal + 1 ||
		(requireSourceAdjacency && continuationBlock.sourceBlockOrdinal !== ownerBlock.sourceBlockOrdinal + 1) ||
		ownerBlock.sourceLineOrdinal !== ownerBlock.sourceLineCount ||
		continuationBlock.sourceLineOrdinal !== 1 ||
		(requireSingleLine && continuationBlock.sourceLineCount !== 1) ||
		ownerBlock.sourceIntegrityState !== 'valid' ||
		continuationBlock.sourceIntegrityState !== 'valid' ||
		ownerBlock.geometryState !== 'available' ||
		continuationBlock.geometryState !== 'available'
	) return false
	const ownerRect = polygonRect(ownerBlock)
	const continuationRect = polygonRect(continuationBlock)
	if (!ownerRect || !continuationRect) return false
	const ownerHeight = ownerRect[3] - ownerRect[1]
	const continuationHeight = continuationRect[3] - continuationRect[1]
	const gap = continuationRect[1] - ownerRect[3]
	const maxHeight = Math.max(ownerHeight, continuationHeight)
	if (gap < -1 || gap > Math.max(2, maxHeight * 0.5)) return false
	const ownerWidth = ownerRect[2] - ownerRect[0]
	const continuationWidth = continuationRect[2] - continuationRect[0]
	const overlap = horizontalOverlap(ownerBlock, continuationBlock)
	if (overlap / Math.min(ownerWidth, continuationWidth) < 0.8) return false
	const leftEdgeTolerance = maxHeight * 1.5
	return Math.abs(ownerRect[0] - continuationRect[0]) <= leftEdgeTolerance
}

function strictStructuredCardContinuation(ownerBlock, continuationBlock) {
	return structuredBlocksContinueBelow(ownerBlock, continuationBlock, { requireSingleLine: true })
}

/**
 * Build a card-only source continuation plan. It never changes generic account
 * segmentation: a geometrically proven, closed installment line replaces its
 * owner bundle only inside card binding. The global one-to-one planner below
 * must still prove the resulting combined edge is forced for one model entity.
 */
function buildCardInstallmentContinuationPlan(ownerBundles, sourceBlocks, documentId, hashFn) {
	const owners = arrayAt(ownerBundles)
	const blocks = arrayAt(sourceBlocks)
	const blockByPosition = new Map(blocks.map((block) => [
		`${block.pageNo}:${block.ordinal}`,
		block
	]))
	const proposals = []
	for (const ownerBundle of owners) {
		const ownerBlock = arrayAt(ownerBundle.members).at(-1)
		const continuationBlock = ownerBlock
			? blockByPosition.get(`${ownerBlock.pageNo}:${ownerBlock.ordinal + 1}`)
			: null
		if (
			!strictStructuredCardContinuation(ownerBlock, continuationBlock) ||
			!closedCardInstallmentContinuation(continuationBlock)
		) continue
		const followingBlock = blockByPosition.get(`${continuationBlock.pageNo}:${continuationBlock.ordinal + 1}`)
		if (
			followingBlock &&
			structuredBlocksContinueBelow(continuationBlock, followingBlock, {
				requireSourceAdjacency: false
			}) &&
			!accountRecordBoundary(followingBlock)
		) continue
		const combined = recordBundle({
			kind: 'card',
			boundaryType: 'card-installment-continuation-v1',
			members: [...arrayAt(ownerBundle.members), continuationBlock],
			identityBlocks: arrayAt(ownerBundle.identityBlocks),
			documentId,
			hashFn,
			recordMembershipProven: true,
			recordClosureProven: true
		})
		if (combined) combined.currencySignalBlocks = arrayAt(ownerBundle.currencySignalBlocks)
		if (combined) proposals.push({ ownerBundle, continuationBlock, combined })
	}
	const continuationClaims = new Map()
	for (const proposal of proposals) {
		const blockId = proposal.continuationBlock.blockId
		continuationClaims.set(blockId, (continuationClaims.get(blockId) || 0) + 1)
	}
	const acceptedByOwnerBinding = new Map(proposals
		.filter((proposal) => continuationClaims.get(proposal.continuationBlock.blockId) === 1)
		.map((proposal) => [proposal.ownerBundle.recordBindingId, proposal]))
	return {
		bundles: owners.map((ownerBundle) =>
			acceptedByOwnerBinding.get(ownerBundle.recordBindingId)?.combined || ownerBundle
		),
		acceptedByOwnerBinding
	}
}

function cardContinuationHasStrongModelIdentity(bundle, targets) {
	if (bundle?.boundaryType !== 'card-installment-continuation-v1') return true
	const anchors = arrayAt(targets).find((target) => target?.entityKind === 'card')?.anchors
	return arrayAt(bundle.identityBlocks).some((block) => hasStrongCardIdentity(block, anchors))
}

/**
 * Compute a deterministic one-to-one card-to-record plan without depending on
 * model row order or source bundle order.  The base plan is a maximum-cardinality
 * bipartite matching.  An edge is publishable only when removing it lowers that
 * maximum, which proves that the same assignment exists in every maximum plan.
 * Variable edges are deliberately left unassigned and marked ambiguous instead
 * of using a lexicographic tie-break as evidence of fact ownership.
 */
function buildDeterministicCardBindingPlan(mappings) {
	const bundlesById = new Map()
	const candidateIdsByEntity = new Map()
	for (const mapping of arrayAt(mappings)) {
		const entityKey = String(mapping.entityKey || '')
		if (!entityKey || candidateIdsByEntity.has(entityKey)) continue
		const candidates = new Map()
		for (const bundle of arrayAt(mapping.candidates)) {
			const bindingId = String(bundle.recordBindingId || '')
			if (!bindingId) continue
			candidates.set(bindingId, bundle)
			if (!bundlesById.has(bindingId)) bundlesById.set(bindingId, bundle)
		}
		candidateIdsByEntity.set(entityKey, [...candidates.keys()].sort(compareMachineText))
	}
	const entityKeys = [...candidateIdsByEntity.keys()].sort(compareMachineText)

	const solveMaximum = (forbidden = null) => {
		const ownerByBinding = new Map()
		const augment = (entityKey, seenBindings) => {
			for (const bindingId of candidateIdsByEntity.get(entityKey) || []) {
				if (
					forbidden &&
					forbidden.entityKey === entityKey &&
					forbidden.bindingId === bindingId
				) continue
				if (seenBindings.has(bindingId)) continue
				seenBindings.add(bindingId)
				const owner = ownerByBinding.get(bindingId)
				if (!owner || augment(owner, seenBindings)) {
					ownerByBinding.set(bindingId, entityKey)
					return true
				}
			}
			return false
		}
		for (const entityKey of entityKeys) augment(entityKey, new Set())
		return new Map([...ownerByBinding.entries()].map(([bindingId, entityKey]) => [
			entityKey,
			bindingId
		]))
	}

	const baseAssignment = solveMaximum()
	const maximumSize = baseAssignment.size
	const forcedAssignment = new Map()
	const ambiguousEntityKeys = new Set()
	for (const [entityKey, bindingId] of [...baseAssignment.entries()].sort(([a], [b]) =>
		compareMachineText(a, b)
	)) {
		const alternative = solveMaximum({ entityKey, bindingId })
		if (alternative.size < maximumSize) {
			forcedAssignment.set(entityKey, bindingId)
			continue
		}
		for (const candidateEntityKey of entityKeys) {
			if (baseAssignment.get(candidateEntityKey) !== alternative.get(candidateEntityKey)) {
				ambiguousEntityKeys.add(candidateEntityKey)
			}
		}
	}
	for (const entityKey of entityKeys) {
		if (
			(candidateIdsByEntity.get(entityKey) || []).length > 0 &&
			!forcedAssignment.has(entityKey)
		) ambiguousEntityKeys.add(entityKey)
	}

	return {
		assignedBundleByEntity: new Map([...forcedAssignment.entries()].map(([entityKey, bindingId]) => [
			entityKey,
			bundlesById.get(bindingId)
		])),
		ambiguousEntityKeys,
		candidatesByEntity: new Map(entityKeys.map((entityKey) => [
			entityKey,
			(candidateIdsByEntity.get(entityKey) || []).map((bindingId) => bundlesById.get(bindingId))
		])),
		maximumSize,
		complete: maximumSize === entityKeys.length,
		unique: forcedAssignment.size === maximumSize
	}
}

/**
 * Fill an omitted card currency/installment only when the native source proves
 * the value inside one closed card record that maps one-to-one to one extracted
 * card. Currency repair is intentionally narrower than general currency
 * parsing: it can introduce CNY only from an explicit, conflict-free CNY source
 * assertion and never overwrites any non-empty model value. This runs before
 * deterministic scoring and reuses the evidence ledger's record segmentation,
 * anchor matching and money parser instead of maintaining a second source path.
 *
 * Valid model money is never overwritten. Positive values additionally require
 * the assigned card's critical currency fact to be source-bound as CNY because
 * the controlled installment parser intentionally emits CNY money. Zero keeps
 * the evidence layer's existing calculation-neutral semantics.
 */
function applyControlledSourceCardInstallments(facts, sourceText, {
	documentId,
	declaredPageCount,
	documentMeta = {},
	hashFn = defaultHashFn
} = {}) {
	const data = plainObject(facts)
	const cards = stableRows(data.credit_card_details)
	if (
		!cards.length ||
		!normalizeString(sourceText) ||
		documentMeta?.sourceMode !== 'pdf-text' ||
		documentMeta?.complete !== true ||
		!Array.isArray(documentMeta?.pages)
	) return data

	const manifest = buildDocumentManifest({
		sourceText,
		evidenceContext: { facts: data, documentMeta: plainObject(documentMeta) },
		documentId,
		declaredPageCount,
		hashFn
	})
	if (manifest.status !== 'complete') return data

	const internal = buildInternalSource({
		sourceText,
		declaredPageCount: manifest.coverage.declaredPageCount,
		verifiedBlankPages: documentMeta?.verifiedBlankPages,
		documentMeta: plainObject(documentMeta),
		documentId: manifest.documentId,
		hashFn
	})
	const sourceBlocks = internal.pages.flatMap((page) => page.blocks)
	const ownerBundles = buildAccountRecordBundles(
		sourceBlocks,
		'card',
		manifest.documentId,
		hashFn
	)
	attachExternalCardCurrencySignals(ownerBundles, sourceBlocks)
	const continuationPlan = buildCardInstallmentContinuationPlan(
		ownerBundles,
		sourceBlocks,
		manifest.documentId,
		hashFn
	)
	const bundles = continuationPlan.bundles
	if (!bundles.length) return data

	const targetsByEntity = new Map()
	for (const target of makeTargets(data).filter((item) => item.entityKind === 'card')) {
		if (!targetsByEntity.has(target.entityKey)) targetsByEntity.set(target.entityKey, [])
		targetsByEntity.get(target.entityKey).push(target)
	}
	const mappings = cards.map((_card, index) => {
		const entityKey = `card:${index}`
		const targets = targetsByEntity.get(entityKey) || []
		const installmentTarget = targets.find((target) => target.field === 'installment') || null
		const currencyTarget = targets.find((target) => target.field === 'currency') || null
		const primaryTargets = targets.filter((target) =>
			target.critical === true &&
			target.field !== 'installment' &&
			target.assignmentRequired !== false &&
			(target.valueType === 'money'
				? moneyMagnitude(target.rawValue)
				: typedTargetValue(target, hashFn, manifest.documentId))
		)
		const candidates = primaryTargets.length
			? bundles.filter((bundle) =>
				cardContinuationHasStrongModelIdentity(bundle, targets) &&
				primaryTargets.every((target) =>
					targetHasSafeCnySourceMatch(target, bundle, hashFn, manifest.documentId)
				)
			)
			: []
		return { entityKey, targets, currencyTarget, installmentTarget, primaryTargets, candidates }
	})
	const bindingPlan = buildDeterministicCardBindingPlan(mappings)
	if (!bindingPlan.complete) return data

	// A missing model currency must not invalidate every other independently
	// source-bound field of the same card. Repair only the domestic value that is
	// positively asserted by one closed source bundle. Both scoring money fields
	// must already match that same bundle, and the card-to-bundle edge must be
	// forced in every deterministic maximum one-to-one plan. A missing assertion,
	// foreign/mixed assertion, ambiguous plan or non-empty model value remains
	// untouched and therefore fails the ordinary critical evidence gate below.
	for (let index = 0; index < cards.length; index += 1) {
		const card = cards[index]
		const currencyCanBeRepaired = [card.currency, card.currency_code].every((value) =>
			value === null || value === undefined || (
				typeof value === 'string' && canonicalString(value) === ''
			)
		)
		if (!currencyCanBeRepaired) continue
		const mapping = mappings[index]
		const boundCoreFields = new Set(mapping.primaryTargets.map((target) => target.field))
		const bundle = bindingPlan.assignedBundleByEntity.get(mapping.entityKey)
		const strongIdentity = bundle && arrayAt(bundle.identityBlocks).some((block) =>
			hasStrongCardIdentity(block, mapping.currencyTarget?.anchors)
		)
		if (
			!mapping.currencyTarget ||
			!boundCoreFields.has('credit_limit') ||
			!boundCoreFields.has('used_limit') ||
			!strongIdentity ||
			!sourceBundleProvesOnlyCny(bundle)
		) continue
		card.currency = 'CNY'
		// Keep the already-built target set consistent for the immediately
		// following controlled installment proof. The final evidence graph is
		// rebuilt from `data` after deterministic normalization.
		mapping.currencyTarget.rawValue = 'CNY'
		for (const target of mapping.targets) {
			if (target.valueType === 'money') target.currencyCode = 'CNY'
		}
	}

	for (let index = 0; index < cards.length; index += 1) {
		const card = cards[index]
		const cardCurrency = resolveCurrencyFields(card.currency, card.currency_code)
		if (moneyValue(
			card.installment ?? card.large_installment,
			cardCurrency.valid ? cardCurrency.code : null
		)) continue
		const mapping = mappings[index]
		if (
			!mapping.installmentTarget ||
			!bindingPlan.assignedBundleByEntity.has(mapping.entityKey)
		) continue

		const bundle = bindingPlan.assignedBundleByEntity.get(mapping.entityKey)
		const sourceDerived = controlledSourceInstallmentMatch(
			mapping.installmentTarget,
			bundle,
			hashFn,
			manifest.documentId,
			{ allowPositive: true, sourceBlocks }
		)
		if (sourceDerived.status !== 'matched') continue
		if (sourceDerived.match.value.minor > 0) {
			if (!sourceBundleProvesOnlyCny(bundle)) continue
			const currencyTarget = mapping.targets.find((target) => target.field === 'currency')
			const currency = currencyTarget
				? typedTargetValue(currencyTarget, hashFn, manifest.documentId)
				: null
			const currencyBound = currencyTarget &&
				targetMatchesInBundle(currencyTarget, bundle, hashFn, manifest.documentId).matches.length > 0
			if (!currencyBound || currency?.type !== 'currency' || currency.code !== 'CNY') continue
		}
		card.installment = sourceDerived.match.value.minor / 100
	}
	return data
}

const QUERY_REASON_BUNDLE_PATTERN = /(?:法人代表、负责人、高管等资信审查|担保资格审查|信用卡审批|贷记卡审批|贷款审批|融资审批|授信审批|贷后管理|保后管理|保前审查|担保审查|特约商户实名审查|客户准入资格审查|资信审查)/u
const QUERY_DATE_BUNDLE_PATTERN = /20\d{2}\s*(?:年|[.\/-])\s*\d{1,2}\s*(?:月|[.\/-])\s*\d{1,2}\s*(?:日)?/u

function geometryRows(blocks) {
	const rows = []
	for (const block of blocks.filter((item) => polygonRect(item)).sort((left, right) => {
		const a = polygonRect(left)
		const b = polygonRect(right)
		return a[1] - b[1] || a[0] - b[0] || compareMachineText(left.blockId, right.blockId)
	})) {
		const row = rows.find((candidate) => candidate.every((member) => verticalOverlapRatio(member, block) >= 0.8))
		if (row) row.push(block)
		else rows.push([block])
	}
	return rows.map((row) => row.sort((left, right) => polygonRect(left)[0] - polygonRect(right)[0] || compareMachineText(left.blockId, right.blockId)))
}

function queryInstitutionContinuations({ institutionBlocks, pageBlocks, dateRect, reasonRect }) {
	const continuations = []
	const byGroup = new Map()
	for (const block of institutionBlocks) {
		if (!byGroup.has(block.sourceGroupId)) byGroup.set(block.sourceGroupId, [])
		byGroup.get(block.sourceGroupId).push(block)
	}
	for (const [sourceGroupId, initial] of byGroup.entries()) {
		const ordered = [...initial].sort((left, right) => left.sourceLineOrdinal - right.sourceLineOrdinal)
		let previous = ordered[ordered.length - 1]
		while (previous) {
			const previousRect = polygonRect(previous)
			const candidate = pageBlocks.find((block) => {
				const rect = polygonRect(block)
				const horizontallyRelated = rect && (
					Math.min(previousRect[2], rect[2]) > Math.max(previousRect[0], rect[0]) ||
					Math.abs(rect[0] - previousRect[2]) <= 1
				)
				if (
					!rect || block.sourceGroupId !== sourceGroupId ||
					block.sourceLineOrdinal !== previous.sourceLineOrdinal + 1 ||
					rect[0] < dateRect[2] - 1 || rect[2] > reasonRect[0] + 1 ||
					rect[1] < previousRect[3] - 1 ||
					rect[1] > previousRect[3] + Math.max(2, (previousRect[3] - previousRect[1]) / 2) ||
					!horizontallyRelated
				) return false
				const source = String(block.searchText || '')
				return source.length > 0 &&
					!/^\d{1,4}$/u.test(source.replace(/\s+/g, '')) &&
					!QUERY_DATE_BUNDLE_PATTERN.test(source) &&
					!QUERY_REASON_BUNDLE_PATTERN.test(source)
			})
			if (!candidate) break
			continuations.push(candidate)
			previous = candidate
		}
	}
	return continuations
}

function queryGeometryBundle(row, pageBlocks, documentId, hashFn) {
	const sequence = row.filter((block) => /^\d{1,4}$/u.test(String(block.searchText || '').replace(/\s+/g, '')))
	const dates = row.filter((block) => QUERY_DATE_BUNDLE_PATTERN.test(block.searchText))
	const reasons = row.filter((block) => QUERY_REASON_BUNDLE_PATTERN.test(block.searchText))
	if (sequence.length !== 1 || dates.length !== 1 || reasons.length !== 1) return null
	const seqRect = polygonRect(sequence[0])
	const dateRect = polygonRect(dates[0])
	const reasonRect = polygonRect(reasons[0])
	if (!seqRect || !dateRect || !reasonRect || !(seqRect[2] <= dateRect[0] + 1 && dateRect[2] <= reasonRect[0] + 1)) return null
	const institutionBlocks = row.filter((block) => {
		const rect = polygonRect(block)
		return rect && rect[0] >= dateRect[2] - 1 && rect[2] <= reasonRect[0] + 1 && block.blockId !== dates[0].blockId
	}).sort((left, right) => polygonRect(left)[0] - polygonRect(right)[0] || compareMachineText(left.blockId, right.blockId))
	if (!institutionBlocks.length) return null
	for (let index = 1; index < institutionBlocks.length; index += 1) {
		if (polygonRect(institutionBlocks[index - 1])[2] > polygonRect(institutionBlocks[index])[0] + 1) return null
	}
	const institutionContinuations = queryInstitutionContinuations({
		institutionBlocks,
		pageBlocks,
		dateRect,
		reasonRect
	})
	const completeInstitutionBlocks = [...institutionBlocks, ...institutionContinuations]
		.sort((left, right) => left.sourceLineOrdinal - right.sourceLineOrdinal || polygonRect(left)[0] - polygonRect(right)[0])
	const members = [sequence[0], dates[0], ...completeInstitutionBlocks, reasons[0]]
	const sourceOrdinals = [...new Set(members.map((block) => block.sourceBlockOrdinal))].sort((a, b) => a - b)
	// Real official rows are either one MuPDF block or spill into its immediately
	// adjacent block. A same-y fragment elsewhere on the page must never be used.
	if (
		sourceOrdinals.length > 2 ||
		(sourceOrdinals.length === 2 && sourceOrdinals[1] !== sourceOrdinals[0] + 1)
	) return null
	return recordBundle({
		kind: 'query',
		boundaryType: 'query-layout-row',
		members,
		identityBlocks: [dates[0], ...completeInstitutionBlocks, reasons[0], sequence[0]],
		institutionBlocks: completeInstitutionBlocks,
		documentId,
		hashFn
	})
}

function buildQueryRecordBundles(blocks, documentId, hashFn) {
	const bundles = []
	const claimed = new Set()
	const byPage = new Map()
	for (const block of blocks) {
		if (!byPage.has(block.pageNo)) byPage.set(block.pageNo, [])
		byPage.get(block.pageNo).push(block)
	}
	for (const pageBlocks of byPage.values()) {
		for (const row of geometryRows(pageBlocks)) {
			const bundle = queryGeometryBundle(row, pageBlocks, documentId, hashFn)
			if (!bundle) continue
			bundles.push(bundle)
			for (const member of bundle.members) claimed.add(member.blockId)
		}
	}
	for (const block of blocks) {
		if (!claimed.has(block.blockId)) bundles.push(singletonRecordBundle('query', block, documentId, hashFn))
	}
	return bundles.filter(Boolean)
}

function bundleMatchesAnchors(bundle, anchors) {
	const identityBlocks = arrayAt(bundle?.identityBlocks)
	const identitySearch = identityBlocks.map((block) => String(block.searchText || ''))
	const combined = identitySearch.join(' ')
	const compactCombined = identitySearch.join('')
	const institution = normalizedSearchText(canonicalString(anchors?.institution))
	if (institution && bundle?.kind === 'query' && arrayAt(bundle?.institutionBlocks).length) {
		const sourceInstitution = bundle.institutionBlocks
			.map((block) => String(block.searchText || '').replace(/\s+/g, ''))
			.join('')
		const expectedInstitution = institution.replace(/\s+/g, '')
		if (sourceInstitution !== expectedInstitution) return false
	} else if (institution && !identitySearch.some((source) => source.includes(institution)) && !compactCombined.includes(institution)) {
		return false
	}
	const tail = canonicalString(anchors?.tail)
	const date = anchors?.date
	if (anchors?.requireDateOrTail === true) {
		if (tail) {
			if (!combined.includes(tail)) return false
		} else if (date && !containsVariant(combined, dateVariants(date))) {
			return false
		}
	}
	if (anchors?.requireDate === true && date && !containsVariant(combined, dateVariants(date))) return false
	return true
}

function targetMatchesInBundle(target, bundle, hashFn, documentId) {
	const typedValue = typedTargetValue(target, hashFn, documentId)
	if (!typedValue) return { status: 'invalid', typedValue: null, matches: [], signals: [] }
	if (!bundleMatchesAnchors(bundle, target.anchors)) return { status: 'missing', typedValue, matches: [], signals: [] }
	if (target.valueType === 'card_activation_state') {
		const matches = []
		for (const block of arrayAt(bundle.members)) {
			const span = blockNotActivatedSignalSpan(block)
			if (span) matches.push({ block, match: span })
		}
		return { status: matches.length ? 'matched' : 'missing', typedValue, matches, signals: [] }
	}
	if (
		['card', 'loan'].includes(target.entityKind) &&
		['currency', 'money'].includes(target.valueType)
	) {
		const assertion = sourceBundleCurrencyAssertion(bundle)
		const expectedCode = target.valueType === 'currency' ? typedValue.code : typedValue.currency
		const implicitDomesticLoan = target.entityKind === 'loan' &&
			target.valueType === 'money' &&
			target.allowImplicitCnySourceCurrency === true &&
			expectedCode === 'CNY' &&
			assertion.status === 'missing'
		if (target.valueType === 'currency') {
			const matches = assertion.status === 'unique' && assertion.code === expectedCode
				? assertion.assertions
					.filter((item) => item.code === expectedCode)
					.map((item) => ({ block: item.block, match: item.match }))
				: []
			return {
				status: matches.length ? 'matched' : 'missing',
				typedValue,
				matches,
				signals: assertion.signals
			}
		}
		if (!implicitDomesticLoan && !(
			assertion.status === 'unique' && assertion.code === expectedCode
		)) return {
			status: 'missing',
			typedValue,
			matches: [],
			signals: assertion.signals
		}
	}
	const matches = []
	const signals = []
	for (const block of bundle.members) {
		if (hasTargetLabel(block.searchText, target)) signals.push(block)
		const nextBlock = bundle.members.find((candidate) =>
			candidate.pageNo === block.pageNo &&
			candidate.sourceGroupId === block.sourceGroupId &&
			candidate.sourceLineOrdinal === block.sourceLineOrdinal + 1
		)
		const match = labeledMatch(block.searchText, target, typedValue, hashFn, documentId, {
			requireExplicitEnd: Boolean(nextBlock),
			allowBoundAccountContinuation:
				bundle.recordMembershipProven === true &&
				bundle.recordClosureProven === true
		})
		if (match) matches.push({ block, match })
	}
	// Some official card rows call the used amount only `余额`. Keep that broad
	// word out of the global target labels: it is eligible solely inside one
	// proven, closed card record and only when no explicit used-limit label is
	// present in that record.
	if (!matches.length && !signals.length) {
		const genericBalanceMatch = controlledCardUsedBalanceMatch(
			target,
			bundle,
			typedValue,
			hashFn,
			documentId
		)
		if (genericBalanceMatch) {
			matches.push(genericBalanceMatch)
			signals.push(...genericBalanceMatch.blocks)
		}
	}
	// Official PDFs may wrap a fixed field label between two consecutive lines,
	// for example `已使用额` + `度：10,000元`.  This is deliberately not a
	// generic text join: both fragments must be consecutive atomic lines in the
	// same original source block and the value must be the first complete money
	// token immediately after the controlled label suffix.
	if (target.valueType === 'money' && Array.isArray(target.labels)) {
		const members = bundle.members
		for (let index = 0; index + 1 < members.length; index += 1) {
			const left = members[index]
			const right = members[index + 1]
			if (
				left.pageNo !== right.pageNo ||
				left.sourceGroupId !== right.sourceGroupId ||
				right.sourceLineOrdinal !== left.sourceLineOrdinal + 1
			) continue
			for (const rawLabel of target.labels) {
				const label = normalizedSearchText(rawLabel)
				for (let split = 1; split <= label.length; split += 1) {
					const prefix = label.slice(0, split)
					const suffix = label.slice(split)
					if (!left.searchText.endsWith(prefix) || !right.searchText.startsWith(suffix)) continue
					const bounded = right.searchText.slice(suffix.length, suffix.length + 128)
					const valueMatch = exactMoneyMatch(bounded, typedValue, {
						firstTokenOnly: true,
						anchored: true
					})
					if (!valueMatch) continue
					const leftMatch = {
						needle: prefix,
						start: left.searchText.length - prefix.length,
						end: left.searchText.length
					}
					const rightMatch = {
						needle: valueMatch.needle,
						start: suffix.length + valueMatch.start,
						end: suffix.length + valueMatch.end
					}
					matches.push({
						block: right,
						match: rightMatch,
						refs: [
							evidenceRef({ block: left, match: leftMatch }, hashFn, documentId),
							evidenceRef({ block: right, match: rightMatch }, hashFn, documentId)
						]
					})
					signals.push(left, right)
				}
			}
		}
	}
	if (target.valueType === 'shared_group') {
		const splitSignal = controlledSplitSharedGroupSignal(bundle, documentId, hashFn)
		if (splitSignal?.status === 'valid' && splitSignal.groupId === typedValue.id) {
			matches.push({
				block: splitSignal.evidenceParts.at(-1).block,
				match: splitSignal.evidenceParts.at(-1).match,
				refs: splitSignal.evidenceParts.map((part) => evidenceRef(part, hashFn, documentId))
			})
			signals.push(...splitSignal.blocks)
		} else if (splitSignal) {
			signals.push(...splitSignal.blocks)
		}
	}
	return { status: matches.length ? 'matched' : 'missing', typedValue, matches, signals }
}

function targetHasSafeCnySourceMatch(target, bundle, hashFn, documentId) {
	const effectiveTarget = target?.valueType === 'money' &&
		!currencyValue(target.currencyCode) &&
		moneyMagnitude(target.rawValue)
		? { ...target, currencyCode: 'CNY' }
		: target
	const result = targetMatchesInBundle(effectiveTarget, bundle, hashFn, documentId)
	if (!result.matches.length) return false
	if (target?.valueType !== 'money') return true
	if (result.matches.length !== 1) return false
	if (result.matches.every((selected) =>
		sourceCnyMoneyMatchHasSafeTerminator(selected, { allowNextMoneyField: true })
	)) return true
	// The official wrapped-balance layout splits the generic used-balance label
	// and value across two atomic lines. Its primary limit and used amount cannot
	// satisfy the ordinary single-line terminator, but are safe when the bundle's
	// narrowly closed parenthetical-CNY grammar consumes the entire remaining
	// money sequence. No other target or source layout receives this exception.
	return ['credit_limit', 'used_limit'].includes(target?.field) &&
		sourceBundleHasClosedParentheticalCnyMoneySequence(bundle)
}

function absenceEvidenceRef(block, hashFn, documentId) {
	return {
		blockId: block.blockId,
		pageNo: block.pageNo,
		ordinal: block.ordinal,
		span: {
			offset: block.charStart,
			length: Math.max(0, block.charEnd - block.charStart)
		},
		polygon: block.polygon,
		geometryState: block.geometryState,
		normalizedSpan: null,
		quoteDigest: artifactHash('qt_v2', {
			documentId,
			absence: 'installment',
			blockId: block.blockId,
			normalizedSpan: null
		}, hashFn)
	}
}

function matchTargetOnAssignedBundle(target, bundle, hashFn, documentId) {
	if (target.absencePolicy === 'card-installment' && !target.assignmentRequired) {
		const sourceDerived = controlledSourceInstallmentMatch(target, bundle, hashFn, documentId)
		if (sourceDerived.status === 'matched') return {
			status: 'matched',
			typedValue: sourceDerived.match.value,
			refs: sourceDerived.match.refs,
			signals: sourceDerived.signals
		}
		const signals = sourceDerived.signals
		const splitSignal = controlledSplitLabelSignal(target, bundle)
		if (signals.length || splitSignal) return {
			status: 'source-value-omitted',
			typedValue: null,
			refs: [],
			signals: splitSignal ? splitSignal.blocks : signals
		}
		if (bundle.recordMembershipProven !== true || bundle.recordClosureProven !== true) return {
			status: 'record-closure-unproven',
			typedValue: null,
			refs: [],
			signals: arrayAt(bundle.identityBlocks)
		}
		const anchor = bundle.identityBlocks[0] || bundle.members[0]
		return {
			status: 'matched-absence',
			typedValue: { type: 'absence', code: 'NO_INSTALLMENT_SIGNAL' },
			refs: [absenceEvidenceRef(anchor, hashFn, documentId)],
			signals: []
		}
	}
	const result = targetMatchesInBundle(target, bundle, hashFn, documentId)
	if (!result.matches.length) return { ...result, refs: [] }
	const selected = result.matches[0]
	return {
		status: 'matched',
		typedValue: result.typedValue,
		refs: Array.isArray(selected.refs)
			? selected.refs
			: [evidenceRef(selected, hashFn, documentId)],
		signals: result.signals
	}
}

function buildEvidenceGraph({
	sourceText,
	evidenceContext = {},
	manifest,
	hashFn = defaultHashFn
} = {}) {
	if (!manifest || typeof manifest !== 'object') throw new TypeError('manifest is required')
	const { facts, context } = factsAndContext(evidenceContext)
	const internal = buildInternalSource({
		sourceText,
		declaredPageCount: manifest.coverage?.declaredPageCount,
		verifiedBlankPages: context?.documentMeta?.verifiedBlankPages,
		documentMeta: context?.documentMeta,
		documentId: manifest.documentId,
		hashFn
	})
	const blocks = internal.pages.flatMap((page) => page.blocks)
	const publicBlock = (block) => ({
		blockId: block.blockId,
		pageNo: block.pageNo,
		ordinal: block.ordinal,
		textDigest: block.textDigest,
		textLength: block.searchText.length,
		span: {
			offset: block.charStart,
			length: Math.max(0, block.charEnd - block.charStart)
		},
		polygon: block.polygon,
		geometryState: block.geometryState,
		sourceMode: block.sourceMode
	})
	const targets = makeTargets(facts)
	const nodes = []
	const unresolved = []
	const targetGroups = new Map()
	for (const target of targets) {
		if (!targetGroups.has(target.entityKey)) targetGroups.set(target.entityKey, [])
		targetGroups.get(target.entityKey).push(target)
	}
	const inactiveModelCardEntityKeys = new Set(stableRows(facts?.credit_card_details)
		.map((row, index) => modelCardNotActivated(row) ? `card:${index}` : '')
		.filter(Boolean))
	const claimedSourceRows = new Set()
	const claimedRecordBindings = new Set()
	const retainedBlockIds = new Set()
	const blockByPosition = new Map(blocks.map((block) => [
		`${block.pageNo}:${block.ordinal}`,
		block
	]))
	const documentBundles = blocks.map((block) => singletonRecordBundle('document', block, manifest.documentId, hashFn))
	const cardOwnerBundles = buildAccountRecordBundles(blocks, 'card', manifest.documentId, hashFn)
	const accountBundles = {
		loan: buildAccountRecordBundles(blocks, 'loan', manifest.documentId, hashFn),
		card: cardOwnerBundles
	}
	const cardCurrencySignalPlan = attachExternalCardCurrencySignals(
		cardOwnerBundles,
		blocks,
		[...cardOwnerBundles, ...accountBundles.loan]
	)
	const cardContinuationPlan = buildCardInstallmentContinuationPlan(
		cardOwnerBundles,
		blocks,
		manifest.documentId,
		hashFn
	)
	const cardBindingBundles = cardContinuationPlan.bundles
	const queryBundles = buildQueryRecordBundles(blocks, manifest.documentId, hashFn)
	const cardBindingPlan = buildDeterministicCardBindingPlan(
		[...targetGroups.entries()]
			.filter(([, entityTargets]) => entityTargets[0]?.entityKind === 'card')
			.map(([entityKey, entityTargets]) => {
				const assignmentTargets = entityTargets.filter((target) =>
					target.critical === true && target.assignmentRequired !== false
				)
				const candidates = assignmentTargets.length
					? cardBindingBundles.filter((bundle) =>
						cardContinuationHasStrongModelIdentity(bundle, entityTargets) &&
						assignmentTargets.every((target) =>
							targetMatchesInBundle(target, bundle, hashFn, manifest.documentId).matches.length
						)
					)
					: []
				return { entityKey, candidates }
			})
	)
	const plannedCardOwnerByBinding = new Map()
	const plannedCardOwnerByBlock = new Map()
	const cardBundleResourceBlocks = (bundle) => [...new Map([
		...arrayAt(bundle?.members),
		...arrayAt(bundle?.currencySignalBlocks)
	].map((block) => [block.blockId, block])).values()]
	for (const [entityKey, bundle] of cardBindingPlan.assignedBundleByEntity) {
		plannedCardOwnerByBinding.set(bundle.recordBindingId, entityKey)
		for (const block of cardBundleResourceBlocks(bundle)) plannedCardOwnerByBlock.set(block.blockId, entityKey)
	}
	const bundlesForKind = (kind) => {
		if (kind === 'card') return cardBindingBundles
		if (kind === 'loan') return accountBundles.loan
		if (kind === 'query') return queryBundles
		return documentBundles
	}
	for (const [entityKey, entityTargets] of [...targetGroups.entries()].sort(([a], [b]) => compareMachineText(a, b))) {
		const entityKind = entityTargets[0]?.entityKind || 'document'
		const sourceBundles = bundlesForKind(entityKind)
		const assignmentTargets = entityTargets.filter((target) =>
			target.critical === true && target.assignmentRequired !== false
		)
		const candidateByTarget = new Map(entityTargets.map((target) => {
			const matches = sourceBundles.map((bundle) => ({
				bundle,
				result: targetMatchesInBundle(target, bundle, hashFn, manifest.documentId)
			}))
			const typedValue = typedTargetValue(target, hashFn, manifest.documentId)
			return [target.key, {
				status: typedValue ? (matches.some((item) => item.result.matches.length) ? 'matched' : 'missing') : 'invalid',
				typedValue,
				matches,
				signals: matches.flatMap((item) => item.result.signals || [])
			}]
		}))
		let compatible = assignmentTargets.length
			? sourceBundles.filter((bundle) => assignmentTargets.every((target) =>
				candidateByTarget.get(target.key).matches.some((item) =>
					item.bundle.recordBindingId === bundle.recordBindingId && item.result.matches.length
				)
			))
			: []
		compatible = compatible.sort((left, right) =>
			left.pageNo - right.pageNo ||
			left.members[0].charStart - right.members[0].charStart ||
			compareMachineText(left.recordBindingId, right.recordBindingId)
		)
		if (entityKind === 'card') {
			compatible = cardBindingPlan.candidatesByEntity.get(entityKey) || []
		}
		const mustClaim = ['loan', 'card', 'query'].includes(entityKind)
		const bundleAvailable = (bundle) => {
			if (!mustClaim) return true
			const resourceBlocks = entityKind === 'card'
				? cardBundleResourceBlocks(bundle)
				: arrayAt(bundle.members)
			if (
				claimedRecordBindings.has(bundle.recordBindingId) ||
				resourceBlocks.some((block) => claimedSourceRows.has(block.blockId))
			) return false
			if (entityKind !== 'card') return true
			const bindingOwner = plannedCardOwnerByBinding.get(bundle.recordBindingId)
			if (bindingOwner && bindingOwner !== entityKey) return false
			return resourceBlocks.every((block) => {
				const blockOwner = plannedCardOwnerByBlock.get(block.blockId)
				return !blockOwner || blockOwner === entityKey
			})
		}
		let assignedBundle = entityKind === 'card'
			? cardBindingPlan.assignedBundleByEntity.get(entityKey) || null
			: compatible.find(bundleAvailable) || null
		let ambiguousCardBundle = entityKind === 'card' &&
			cardBindingPlan.ambiguousEntityKeys.has(entityKey)
		if (assignedBundle && !bundleAvailable(assignedBundle)) assignedBundle = null
		if (!assignedBundle && entityKind === 'card' && !ambiguousCardBundle) {
			const installmentTarget = assignmentTargets.find((target) => target.field === 'installment')
			const primaryTargets = assignmentTargets.filter((target) => target.field !== 'installment')
			if (installmentTarget && primaryTargets.length > 0) {
				const primaryBundles = sourceBundles.filter((bundle) => primaryTargets.every((target) =>
					targetMatchesInBundle(target, bundle, hashFn, manifest.documentId).matches.length
				))
				const bundles = primaryBundles.flatMap((primaryBundle) => {
					const primaryBlock = primaryBundle.members[primaryBundle.members.length - 1]
					const supplementBlock = blockByPosition.get(`${primaryBlock.pageNo}:${primaryBlock.ordinal + 1}`)
					const legacyOrdinalFallbackAllowed = [primaryBlock, supplementBlock].every((block) =>
						block && block.sourceMode === 'normalized-text' && block.geometryState === 'unavailable'
					)
					const supplementBundle = supplementBlock
						? singletonRecordBundle('card', supplementBlock, manifest.documentId, hashFn)
						: null
					const combined = supplementBundle ? recordBundle({
						kind: 'card',
						boundaryType: 'card-adjacent-installment',
						members: [...primaryBundle.members, supplementBlock],
						identityBlocks: [...primaryBundle.identityBlocks, supplementBlock],
						documentId: manifest.documentId,
						hashFn
					}) : null
					if (
						!legacyOrdinalFallbackAllowed || !supplementBlock || !combined ||
						!targetMatchesInBundle(installmentTarget, combined, hashFn, manifest.documentId).matches.length ||
						!hasStrongCardIdentity(primaryBlock, installmentTarget.anchors) ||
						!hasStrongCardIdentity(supplementBlock, installmentTarget.anchors) ||
						!bundleAvailable(combined)
					) return []
					return [combined]
				}).sort((left, right) =>
					left.pageNo - right.pageNo ||
					left.members[0].ordinal - right.members[0].ordinal ||
					compareMachineText(left.recordBindingId, right.recordBindingId)
				)
				if (bundles.length === 1) {
					assignedBundle = bundles[0]
				} else if (bundles.length > 1) {
					ambiguousCardBundle = true
				}
			}
		}
		const activationSignalBlocks = entityKind === 'card' && assignedBundle
			? sourceBundleNotActivatedSignals(assignedBundle)
			: []
		const modelInactiveCard = entityKind === 'card' && inactiveModelCardEntityKeys.has(entityKey)
		// PRD-DECISION-001：未激活是受支持状态，但仅当模型声明与源行证据同时
		// 成立（绑定计划以激活状态目标选中源行）。任何单边主张保持失败关闭：
		// 模型声明而源行未证明，或源行显示未激活而模型未声明，都拒绝绑定。
		const unsupportedCardActivation = entityKind === 'card' && (
			modelInactiveCard
				? (!assignedBundle || activationSignalBlocks.length === 0)
				: activationSignalBlocks.length > 0
		)
		if (unsupportedCardActivation) assignedBundle = null
		if (assignedBundle && mustClaim) {
			claimedRecordBindings.add(assignedBundle.recordBindingId)
			const resourceBlocks = entityKind === 'card'
				? cardBundleResourceBlocks(assignedBundle)
				: arrayAt(assignedBundle.members)
			for (const block of resourceBlocks) claimedSourceRows.add(block.blockId)
		}
		const fallbackEntityId = artifactHash('ent_v2', {
			documentId: manifest.documentId,
			kind: entityKind,
			key: entityKey
		}, hashFn)
		const entityId = assignedBundle
			? artifactHash('ent_v2', {
				documentId: manifest.documentId,
				kind: entityKind,
				recordBindingId: assignedBundle.recordBindingId
			}, hashFn)
			: fallbackEntityId

		for (const target of entityTargets) {
			// 已证明未激活的卡：货币/额度目标豁免绑定，事实层落 NOT_APPLICABLE。
			if (target.cardNotActivatedExempt === true && assignedBundle) continue
			const typed = typedTargetValue(target, hashFn, manifest.documentId)
			const targetId = artifactHash('tgt_v2', {
				entityId,
				field: target.field,
				valueDigest: typed ? artifactHash('val_v2', typed, hashFn) : null
			}, hashFn)
			if (!assignedBundle) {
				const candidate = candidateByTarget.get(target.key)
				const signalBlockIds = unsupportedCardActivation
					? activationSignalBlocks.map((block) => block.blockId).sort()
					: [...new Set([
						...candidate.matches.flatMap((item) => item.result.matches.map((match) => match.block.blockId)),
						...candidate.signals.map((block) => block.blockId)
					])].sort()
				for (const blockId of signalBlockIds) retainedBlockIds.add(blockId)
				unresolved.push({
					targetId,
					targetKey: target.key,
					entityId,
					critical: target.critical === true,
					reason: unsupportedCardActivation
						? 'UNSUPPORTED_CARD_ACTIVATION_STATE'
						: ambiguousCardBundle
						? 'AMBIGUOUS_CARD_SOURCE_BUNDLE'
						: compatible.length && mustClaim
							? 'SOURCE_ROW_ALREADY_ASSIGNED'
						: candidate.status === 'invalid'
								? 'INVALID_TYPED_VALUE'
								: 'ENTITY_SOURCE_ROW_MISMATCH',
					signalBlockIds
				})
				continue
			}

			const matched = matchTargetOnAssignedBundle(
				target,
				assignedBundle,
				hashFn,
				manifest.documentId
			)
			if (!['matched', 'matched-absence'].includes(matched.status)) {
				const signalBlockIds = [...new Set((matched.signals || []).map((block) => block.blockId))].sort()
				for (const blockId of signalBlockIds) retainedBlockIds.add(blockId)
				unresolved.push({
					targetId,
					targetKey: target.key,
					entityId,
					critical: target.critical === true,
					reason: matched.status === 'source-value-omitted'
						? 'SOURCE_VALUE_OMITTED_BY_MODEL'
						: matched.status === 'invalid'
							? 'INVALID_TYPED_VALUE'
							: 'SOURCE_MATCH_MISSING',
					signalBlockIds
				})
				continue
			}
			for (const ref of matched.refs) retainedBlockIds.add(ref.blockId)
			const valueDigest = artifactHash('val_v2', matched.typedValue, hashFn)
			const effectiveTargetId = matched.status === 'matched' && !typed
				? artifactHash('tgt_v2', {
					entityId,
					field: target.field,
					valueDigest
				}, hashFn)
				: targetId
			const base = {
				targetId: effectiveTargetId,
				targetKey: target.key,
				entityId,
				entityKind,
				recordBindingId: assignedBundle.recordBindingId,
				...(target.entitySubtype ? { entitySubtype: target.entitySubtype } : {}),
				field: target.field,
				value: matched.typedValue,
				valueDigest,
				evidenceRefs: matched.refs,
				critical: matched.status === 'matched-absence' ? false : target.critical === true
			}
			nodes.push({ nodeId: artifactHash('ev_v2', base, hashFn), ...base })
		}
	}
	const sharedSignalPattern = /共享额度|共享授信|共享额度组|共享授信组|授信协议编号|信用协议编号/u
	const explicitNoRelationPattern = /(?:共享额度组|共享授信组|额度组|授信协议编号|信用协议编号)\s*[：:=#]?\s*([^\s,，;；。|｜]{1,128})/gu
	const hasOnlyExplicitNoRelation = (searchText) => {
		const matches = [...String(searchText || '').matchAll(explicitNoRelationPattern)]
		return matches.length > 0 && matches.every((match) => isExplicitNoSharedCreditToken(match[1]))
	}
	const claimedSharedSignalBlockIds = new Set(nodes
		.filter((node) => node.field === 'shared_group_identity')
		.flatMap((node) => node.evidenceRefs.map((ref) => ref.blockId)))
	for (const block of blocks) {
		if (
			!sharedSignalPattern.test(block.searchText) ||
			claimedSharedSignalBlockIds.has(block.blockId) ||
			hasOnlyExplicitNoRelation(block.searchText)
		) continue
		retainedBlockIds.add(block.blockId)
		const entityId = artifactHash('ent_v2', {
			documentId: manifest.documentId,
			kind: 'source-shared-credit-signal',
			sourceRowId: block.blockId
		}, hashFn)
		unresolved.push({
			targetId: artifactHash('tgt_v2', {
				entityId,
				field: 'shared_group_identity',
				sourceRowId: block.blockId
			}, hashFn),
			targetKey: `source-shared-credit-signal:${block.blockId}`,
			entityId,
			critical: true,
			reason: 'UNCLAIMED_SOURCE_SHARED_CREDIT_SIGNAL',
			signalBlockIds: [block.blockId]
		})
	}
	for (const bundle of accountBundles.card) {
		const splitSignal = controlledSplitSharedGroupSignal(bundle, manifest.documentId, hashFn)
		if (!splitSignal) continue
		const signalBlockIds = splitSignal.blocks.map((block) => block.blockId)
		if (signalBlockIds.every((blockId) => claimedSharedSignalBlockIds.has(blockId))) continue
		for (const blockId of signalBlockIds) retainedBlockIds.add(blockId)
		const entityId = artifactHash('ent_v2', {
			documentId: manifest.documentId,
			kind: 'source-shared-credit-signal',
			signalBlockIds
		}, hashFn)
		unresolved.push({
			targetId: artifactHash('tgt_v2', {
				entityId,
				field: 'shared_group_identity',
				signalBlockIds
			}, hashFn),
			targetKey: `source-shared-credit-signal:${entityId}`,
			entityId,
			critical: true,
			reason: 'UNCLAIMED_SOURCE_SHARED_CREDIT_SIGNAL',
			signalBlockIds
		})
	}
	for (const block of cardCurrencySignalPlan.unclaimedSignals) {
		retainedBlockIds.add(block.blockId)
		const entityId = artifactHash('ent_v2', {
			documentId: manifest.documentId,
			kind: 'source-card-currency-signal',
			sourceRowId: block.blockId
		}, hashFn)
		unresolved.push({
			targetId: artifactHash('tgt_v2', {
				entityId,
				field: 'currency',
				sourceRowId: block.blockId
			}, hashFn),
			targetKey: `source-card-currency-signal:${entityId}`,
			entityId,
			critical: true,
			reason: 'AMBIGUOUS_SOURCE_CARD_CURRENCY_SIGNAL',
			signalBlockIds: [block.blockId]
		})
	}
	const installmentSignalPattern = /未出单大额专项分期余额|大额分期余额|专项分期余额|分期余额/u
	const installmentLabels = ['未出单大额专项分期余额', '大额分期余额', '专项分期余额', '分期余额']
	const claimedInstallmentSignalBlockIds = new Set(nodes
		.filter((node) => node.field === 'installment' && node.value?.type === 'money')
		.flatMap((node) => node.evidenceRefs.map((ref) => ref.blockId)))
	for (const block of blocks) {
		if (
			!installmentSignalPattern.test(block.searchText) ||
			!hasLabeledMoneyToken(block.searchText, installmentLabels) ||
			claimedInstallmentSignalBlockIds.has(block.blockId)
		) continue
		retainedBlockIds.add(block.blockId)
		const entityId = artifactHash('ent_v2', {
			documentId: manifest.documentId,
			kind: 'source-installment-signal',
			sourceRowId: block.blockId
		}, hashFn)
		unresolved.push({
			targetId: artifactHash('tgt_v2', {
				entityId,
				field: 'installment',
				sourceRowId: block.blockId
			}, hashFn),
			targetKey: `source-installment-signal:${block.blockId}`,
			entityId,
			critical: true,
			reason: 'UNCLAIMED_SOURCE_INSTALLMENT_SIGNAL',
			 signalBlockIds: [block.blockId]
		})
	}
	const installmentSignalTarget = { labels: installmentLabels }
	for (const bundle of accountBundles.card) {
		const splitSignal = controlledSplitLabelSignal(installmentSignalTarget, bundle)
		if (!splitSignal) continue
		const signalBlockIds = splitSignal.blocks.map((block) => block.blockId)
		if (signalBlockIds.every((blockId) => claimedInstallmentSignalBlockIds.has(blockId))) continue
		for (const blockId of signalBlockIds) retainedBlockIds.add(blockId)
		const entityId = artifactHash('ent_v2', {
			documentId: manifest.documentId,
			kind: 'source-installment-signal',
			signalBlockIds
		}, hashFn)
		unresolved.push({
			targetId: artifactHash('tgt_v2', {
				entityId,
				field: 'installment',
				signalBlockIds
			}, hashFn),
			targetKey: `source-installment-signal:${entityId}`,
			entityId,
			critical: true,
			reason: 'UNCLAIMED_SOURCE_INSTALLMENT_SIGNAL',
			signalBlockIds
		})
	}
	const claimedForeignCurrencyBlockIds = new Set(nodes
		.filter((node) => node.field === 'currency' && node.value?.type === 'currency' && node.value.code !== 'CNY')
		.flatMap((node) => node.evidenceRefs.map((ref) => ref.blockId)))
	const loanBalanceNodesByBinding = new Map(nodes
		.filter((node) => node.entityKind === 'loan' && node.field === 'balance')
		.map((node) => [node.recordBindingId, node]))
	const loanContextPattern = /贷款|借款|信贷业务/u
	const cardContextPattern = /信用卡|贷记卡|准贷记卡/u
	for (const block of blocks) {
		if (
			!SOURCE_FOREIGN_CURRENCY_SIGNAL_PATTERN.test(block.searchText) ||
			claimedForeignCurrencyBlockIds.has(block.blockId)
		) continue

		const relatedLoanBundles = accountBundles.loan.filter((bundle) =>
			foreignCurrencySignalRelatesToAccountBundle(block, bundle)
		)
		const relatedCardBundles = accountBundles.card.filter((bundle) =>
			foreignCurrencySignalRelatesToAccountBundle(block, bundle)
		)
		const relatedLoanNodes = [...new Map(relatedLoanBundles
			.map((bundle) => loanBalanceNodesByBinding.get(bundle.recordBindingId))
			.filter(Boolean)
			.map((node) => [node.entityId, node])).values()]
		const explicitLoanContext = loanContextPattern.test(block.searchText) && !cardContextPattern.test(block.searchText)
		if (!explicitLoanContext && relatedLoanBundles.length === 0) continue

		retainedBlockIds.add(block.blockId)
		const uniqueLoanSource = relatedLoanBundles.length === 1 && relatedCardBundles.length === 0
		const uniqueLoan = relatedLoanNodes.length === 1 && uniqueLoanSource
		const entityId = uniqueLoan
			? relatedLoanNodes[0].entityId
			: artifactHash('ent_v2', {
				documentId: manifest.documentId,
				kind: 'source-loan-currency-signal',
				sourceRowId: block.blockId
			}, hashFn)
		const signalBlockIds = [block.blockId]
		unresolved.push({
			targetId: artifactHash('tgt_v2', {
				entityId,
				field: 'currency',
				signalBlockIds
			}, hashFn),
			targetKey: `source-loan-currency-signal:${entityId}`,
			entityId,
			critical: true,
			reason: uniqueLoanSource
				? 'SOURCE_LOAN_CURRENCY_OMITTED'
				: 'AMBIGUOUS_SOURCE_LOAN_CURRENCY_SIGNAL',
			signalBlockIds
		})
	}
	const publicBlocks = blocks.filter((block) => retainedBlockIds.has(block.blockId)).map(publicBlock)
	nodes.sort((left, right) => compareMachineText(left.entityId, right.entityId) || compareMachineText(left.field, right.field) || compareMachineText(left.targetId, right.targetId))
	unresolved.sort((left, right) => compareMachineText(left.targetId, right.targetId))
	const complete = manifest.status === 'complete' && !unresolved.some((item) => item.critical)
	const payload = {
		schema: 'rpt.credit/evidence-graph/2.0',
		status: complete ? 'complete' : 'rejected',
		documentId: manifest.documentId,
		manifestHash: manifest.manifestHash,
		blocks: publicBlocks,
		nodes,
		unresolved,
		coverage: {
			blockCount: publicBlocks.length,
			totalSourceBlockCount: blocks.length,
			retainedBlockCount: publicBlocks.length,
			nodeCount: nodes.length,
			criticalUnresolvedCount: unresolved.filter((item) => item.critical).length,
			complete
		}
	}
	return {
		...payload,
		evidenceGraphHash: artifactHash('eg_v2', payload, hashFn)
	}
}

function verifiedSectionCount(context, name) {
	const source = plainObject(context.sourceVerifiedCounts || context.source_verified_counts)
	const raw = source[name]
	if (raw && typeof raw === 'object') {
		const count = Number(raw.count)
		const basis = normalizeString(raw.basis)
		if (Number.isInteger(count) && count >= 0 && /^source-/.test(basis)) return { count, basis }
	}
	return null
}

function targetNodeMap(graph) {
	return new Map(arrayAt(graph?.nodes).map((node) => [node.targetKey, node]))
}

function targetRecordMap(graph) {
	return new Map([
		...arrayAt(graph?.nodes).map((node) => [node.targetKey, node]),
		...arrayAt(graph?.unresolved).map((item) => [item.targetKey, item])
	])
}

function makeFact({ target, node, record, hashFn, documentId }) {
	const nodeValue = node?.value
	const absence = nodeValue?.type === 'absence'
	const typed = absence ? null : (nodeValue || typedTargetValue(target, hashFn, documentId))
	let status = FACT_STATUS.ACCEPTED
	let reason = null
	if (absence) {
		status = FACT_STATUS.ABSENT
		reason = 'SOURCE_ROW_NO_INSTALLMENT_SIGNAL'
	} else if (!typed) {
		status = FACT_STATUS.UNKNOWN
		reason = 'INVALID_TYPED_VALUE'
	} else if (!node) {
		status = FACT_STATUS.UNKNOWN
		reason = 'SOURCE_EVIDENCE_MISSING'
	}
	const base = {
		targetId: node?.targetId || record?.targetId || artifactHash('tgt_v2', {
			documentId,
			entityKey: target.entityKey,
			field: target.field
		}, hashFn),
		entityId: node?.entityId || record?.entityId || artifactHash('ent_v2', {
			documentId,
			kind: target.entityKind || 'document',
			key: target.entityKey
		}, hashFn),
		entityKind: target.entityKind || 'document',
		...(target.entitySubtype ? { entitySubtype: target.entitySubtype } : {}),
		field: target.field,
		value: typed,
		status,
		reason,
		evidenceNodeIds: node ? [node.nodeId] : [],
		critical: absence ? false : target.critical === true
	}
	return {
		factId: artifactHash('fact_v2', base, hashFn),
		...base,
		_targetKey: target.key
	}
}

function relationConflicts(facts, graph, hashFn) {
	const rows = stableRows(facts?.credit_card_details)
	const nodes = targetNodeMap(graph)
	const identities = rows.map((row, index) => {
		const hasBoundCriticalEvidence = [
			`card:${index}:credit_limit`,
			`card:${index}:used_limit`,
			`card:${index}:currency`
		].every((key) => nodes.has(key))
		return {
			index,
			entityId: nodes.get(`card:${index}:credit_limit`)?.entityId || artifactHash('ent_v2', {
				documentId: graph?.documentId,
				kind: 'card',
				key: `card:${index}`
			}, hashFn),
			explicitGroup: nodes.has(`card:${index}:shared_group`)
				? canonicalString(nodes.get(`card:${index}:shared_group`)?.value?.id)
				: '',
			hasBoundCriticalEvidence
		}
	})
	const relations = []
	const conflicts = []
	const explicitGroups = new Map()
	for (const identity of identities) {
		if (!identity.explicitGroup) continue
		if (!explicitGroups.has(identity.explicitGroup)) explicitGroups.set(identity.explicitGroup, [])
		explicitGroups.get(identity.explicitGroup).push(identity.entityId)
	}
	for (const members of explicitGroups.values()) {
		if (members.length !== 1) continue
		const relationBase = {
			type: 'same-credit-facility',
			members: [...members],
			status: 'candidate',
			basis: 'single-member-source-group'
		}
		const relationId = artifactHash('rel_v2', relationBase, hashFn)
		relations.push({ relationId, ...relationBase })
		conflicts.push({
			code: 'SINGLE_MEMBER_SHARED_GROUP_UNRESOLVED',
			relationId,
			entityIds: [...members]
		})
	}
	for (let left = 0; left < identities.length; left += 1) {
		for (let right = left + 1; right < identities.length; right += 1) {
			const a = identities[left]
			const b = identities[right]
			const explicit = Boolean(
				a.hasBoundCriticalEvidence &&
				b.hasBoundCriticalEvidence &&
				a.explicitGroup &&
				a.explicitGroup === b.explicitGroup
			)
			// Distinct, source-counted report records remain singleton calculation
			// units unless the source itself binds both records to one opaque facility
			// group. Institution/date or four-digit-tail collisions are not relation
			// evidence and must neither merge facilities nor block publication.
			if (!explicit) continue
			const relationBase = {
				type: 'same-credit-facility',
				members: [a.entityId, b.entityId].sort(),
				status: 'accepted',
				basis: 'explicit-source-group'
			}
			const relationId = artifactHash('rel_v2', relationBase, hashFn)
			relations.push({ relationId, ...relationBase })
		}
	}
	return { relations, conflicts }
}

function buildCreditFactLedger({
	evidenceContext = {},
	manifest,
	evidenceGraph,
	hashFn = defaultHashFn
} = {}) {
	if (!manifest || !evidenceGraph) throw new TypeError('manifest and evidenceGraph are required')
	const { facts, context } = factsAndContext(evidenceContext)
	const nodes = targetNodeMap(evidenceGraph)
	const records = targetRecordMap(evidenceGraph)
	const targets = makeTargets(facts).filter((target) => target.critical === true)
	let ledgerFacts = targets.map((target) => {
		// PRD-DECISION-001：已证明未激活的卡，其货币/额度事实为 NOT_APPLICABLE，
		// 证据溯源指向已接受的激活状态节点，不参与关键事实闭合。
		if (target.cardNotActivatedExempt === true) {
			const activationNode = nodes.get(`${target.entityKey}:activation_state`)
			if (activationNode) {
				const base = {
					targetId: artifactHash('tgt_v2', {
						documentId: manifest.documentId,
						entityKey: target.entityKey,
						field: target.field
					}, hashFn),
					entityId: activationNode.entityId,
					entityKind: 'card',
					field: target.field,
					value: null,
					status: FACT_STATUS.NOT_APPLICABLE,
					reason: 'CARD_NOT_ACTIVATED',
					evidenceNodeIds: [activationNode.nodeId],
					critical: false
				}
				return { factId: artifactHash('fact_v2', base, hashFn), ...base, _targetKey: target.key }
			}
		}
		return makeFact({
			target,
			node: nodes.get(target.key),
			record: records.get(target.key),
			hashFn,
			documentId: manifest.documentId
		})
	})
	const acceptedEntityCount = (kind, requiredFields, alternativeFields = []) => {
		const fieldsByEntity = new Map()
		for (const fact of ledgerFacts) {
			if (fact.entityKind !== kind || fact.status !== FACT_STATUS.ACCEPTED) continue
			if (!fieldsByEntity.has(fact.entityId)) fieldsByEntity.set(fact.entityId, new Set())
			fieldsByEntity.get(fact.entityId).add(fact.field)
		}
		return [...fieldsByEntity.values()].filter((fields) =>
			requiredFields.every((field) => fields.has(field)) ||
			(alternativeFields.length > 0 && alternativeFields.every((field) => fields.has(field)))
		).length
	}
	const sections = Object.entries(REQUIRED_SECTION_SELECTORS).map(([name, selectRows]) => {
		const verified = verifiedSectionCount(context, name)
		const declared = selectRows(facts).length
		const actual = name === 'active_loans'
			? acceptedEntityCount('loan', ['balance'])
			: name === 'credit_card_details'
				? acceptedEntityCount('card', ['credit_limit', 'used_limit', 'currency'], ['activation_state'])
				: acceptedEntityCount('query', ['date', 'reason'])
		return {
			name,
			expectedCount: verified ? verified.count : null,
			acceptedEntityCount: actual,
			declaredEntityCount: declared,
			basis: verified?.basis || 'missing-source-verification',
			status: verified && verified.count === actual
				? (actual === 0 ? 'empty-proven' : 'complete')
				: 'incomplete'
		}
	})

	const relationResult = relationConflicts(facts, evidenceGraph, hashFn)
	const conflictedEntities = new Set(relationResult.conflicts.flatMap((item) => item.entityIds))
	for (const fact of ledgerFacts) {
		if (conflictedEntities.has(fact.entityId)) {
			fact.status = FACT_STATUS.CONFLICT
			fact.reason = 'CARD_FACILITY_RELATION_UNRESOLVED'
		}
	}
	for (const section of sections) {
		if (section.status !== 'empty-proven') continue
		const base = {
			targetId: artifactHash('tgt_v2', {
				documentId: manifest.documentId,
				entityKind: 'section',
				field: section.name
			}, hashFn),
			entityId: artifactHash('ent_v2', {
				documentId: manifest.documentId,
				kind: 'section',
				key: section.name
			}, hashFn),
			entityKind: 'section',
			field: section.name,
			value: null,
			status: FACT_STATUS.ABSENT,
			reason: 'SOURCE_VERIFIED_EMPTY_SECTION',
			evidenceNodeIds: [],
			critical: false
		}
		ledgerFacts.push({ factId: artifactHash('fact_v2', base, hashFn), ...base })
	}
	for (const currencyFact of ledgerFacts.filter((fact) =>
		fact.entityKind === 'card' &&
		fact.field === 'currency' &&
		fact.status === FACT_STATUS.ACCEPTED &&
		fact.value?.code !== 'CNY'
	)) {
		const base = {
			targetId: artifactHash('tgt_v2', { entityId: currencyFact.entityId, field: 'cny_equivalent' }, hashFn),
			entityId: currencyFact.entityId,
			entityKind: 'card',
			field: 'cny_equivalent',
			value: null,
			status: FACT_STATUS.NOT_APPLICABLE,
			reason: 'NON_CNY_WITHOUT_EXPLICIT_EQUIVALENT',
			evidenceNodeIds: currencyFact.evidenceNodeIds,
			critical: false
		}
		ledgerFacts.push({ factId: artifactHash('fact_v2', base, hashFn), ...base })
	}
	ledgerFacts = ledgerFacts.map((fact) => {
		const { factId: _oldFactId, _targetKey, ...base } = fact
		return {
			factId: artifactHash('fact_v2', base, hashFn),
			...base,
			...(_targetKey ? { _targetKey } : {})
		}
	}).sort((left, right) =>
		compareMachineText(left.entityId, right.entityId) ||
		compareMachineText(left.field, right.field) ||
		compareMachineText(left.targetId, right.targetId)
	)
	const entities = [...new Map(ledgerFacts.map((fact) => [fact.entityId, {
		entityId: fact.entityId,
		kind: fact.entityKind,
		...(fact.entitySubtype ? { subtype: fact.entitySubtype } : {})
	}])).values()].sort((a, b) => compareMachineText(a.entityId, b.entityId))
	const criticalFailures = ledgerFacts.filter((fact) => fact.critical && fact.status !== FACT_STATUS.ACCEPTED)
	const incompleteSections = sections.filter((section) => !['complete', 'empty-proven'].includes(section.status))
	const ready = manifest.status === 'complete' &&
		evidenceGraph.status === 'complete' &&
		criticalFailures.length === 0 &&
		incompleteSections.length === 0 &&
		relationResult.conflicts.length === 0
	const publicFacts = ledgerFacts.map(({ _targetKey, ...fact }) => fact)
	const payload = {
		schema: 'rpt.credit/fact-ledger/2.0',
		status: ready ? 'ready' : 'blocked',
		documentId: manifest.documentId,
		evidenceGraphHash: evidenceGraph.evidenceGraphHash,
		anchorDate: parseDate(facts?.meta?.report_date || facts?.basic_info?.report_date),
		entities,
		facts: publicFacts,
		sections,
		relations: relationResult.relations.sort((a, b) => compareMachineText(a.relationId, b.relationId)),
		conflicts: relationResult.conflicts.sort((a, b) => compareMachineText(a.relationId, b.relationId)),
		gate: {
			status: ready ? 'passed' : 'blocked',
			criticalFactIds: criticalFailures.map((fact) => fact.factId).sort(),
			incompleteSections: incompleteSections.map((section) => section.name).sort(),
			conflictCodes: [...new Set(relationResult.conflicts.map((item) => item.code))].sort()
		}
	}
	return {
		...payload,
		factLedgerHash: artifactHash('fl_v2', payload, hashFn)
	}
}

function factsByEntity(ledger, kind) {
	const map = new Map()
	for (const fact of arrayAt(ledger?.facts)) {
		if (fact.entityKind !== kind || fact.status !== FACT_STATUS.ACCEPTED) continue
		if (!map.has(fact.entityId)) map.set(fact.entityId, {})
		map.get(fact.entityId)[fact.field] = fact
	}
	return map
}

function metric(formulaId, inputFacts, value, extra = {}) {
	return {
		status: 'computed',
		formulaId,
		inputFactIds: inputFacts.map((fact) => fact.factId).sort(),
		value,
		...extra
	}
}

function blockedMetric(formulaId, reason) {
	return { status: 'blocked', formulaId, inputFactIds: [], value: null, reason }
}

function acceptedCardFacilityGroups(cardEntities, relations) {
	const ids = [...cardEntities.keys()].sort()
	const parent = new Map(ids.map((id) => [id, id]))
	const find = (id) => {
		let current = id
		while (parent.has(current) && parent.get(current) !== current) current = parent.get(current)
		return current
	}
	const union = (left, right) => {
		const a = find(left)
		const b = find(right)
		if (!parent.has(a) || !parent.has(b) || a === b) return
		if (a < b) parent.set(b, a)
		else parent.set(a, b)
	}
	for (const relation of arrayAt(relations)) {
		if (relation.type !== 'same-credit-facility' || relation.status !== 'accepted') continue
		const members = Array.isArray(relation.members) ? relation.members : []
		for (let index = 1; index < members.length; index += 1) union(members[0], members[index])
	}
	const grouped = new Map()
	for (const id of ids) {
		const root = find(id)
		if (!grouped.has(root)) grouped.set(root, [])
		grouped.get(root).push({ entityId: id, facts: cardEntities.get(id) })
	}
	return [...grouped.entries()].map(([facilityId, members]) => ({ facilityId, members }))
}

function buildDerivedAnalysis({
	manifest,
	evidenceGraph,
	factLedger,
	facts = {},
	ruleVersion = 'credit-evidence-rules-v2',
	hashFn = defaultHashFn
} = {}) {
	if (!manifest || !evidenceGraph || !factLedger) throw new TypeError('manifest, evidenceGraph and factLedger are required')
	const linked = factLedger.evidenceGraphHash === evidenceGraph.evidenceGraphHash &&
		evidenceGraph.manifestHash === manifest.manifestHash
	if (factLedger.status !== 'ready' || !linked) {
		const payload = {
			schema: 'rpt.credit/derived-analysis/2.0',
			status: 'blocked',
			inputs: {
				documentManifestHash: manifest.manifestHash,
				evidenceGraphHash: evidenceGraph.evidenceGraphHash,
				factLedgerHash: factLedger.factLedgerHash,
				anchorDate: factLedger.anchorDate,
				ruleVersion
			},
			metrics: {
				totalLoanBalance: blockedMetric('loan-balance-sum-v2', 'FACT_LEDGER_BLOCKED'),
				cardOutstanding: blockedMetric('card-outstanding-cny-v1', 'FACT_LEDGER_BLOCKED'),
				cardUtilization: blockedMetric('card-utilization-cny-v2', 'FACT_LEDGER_BLOCKED'),
				totalDebt: blockedMetric('total-debt-v2', 'FACT_LEDGER_BLOCKED'),
				queryCounts: blockedMetric('hard-query-calendar-window-v2', 'FACT_LEDGER_BLOCKED'),
				primaryScore: blockedMetric(PRIMARY_SCORE_FORMULA_ID, 'FACT_LEDGER_BLOCKED')
			}
		}
		return { ...payload, derivedAnalysisHash: artifactHash('da_v2', payload, hashFn) }
	}

	const loanEntities = factsByEntity(factLedger, 'loan')
	const loanFacts = [...loanEntities.values()]
		.map((row) => row.balance)
		.filter((fact) => fact?.value?.currency === 'CNY')
	const totalLoanMinor = loanFacts.reduce((sum, fact) => sum + fact.value.minor, 0)
	const totalLoanBalance = metric(
		'loan-balance-sum-v2',
		loanFacts,
		{ type: 'money', currency: 'CNY', minor: totalLoanMinor, scale: 2 }
	)

	const cardEntities = factsByEntity(factLedger, 'card')
	// PRD-DECISION-001：已证明未激活的卡计入账户数，但排除在使用率/负债之外。
	const notActivatedCardEntityIds = new Set([...cardEntities.entries()]
		.filter(([, row]) =>
			row.activation_state?.value?.type === 'card-state' &&
			row.activation_state.value.state === 'not_activated'
		)
		.map(([entityId]) => entityId))
	let cardMoneyCurrencyClosureValid = true
	for (const [entityId, row] of cardEntities.entries()) {
		if (notActivatedCardEntityIds.has(entityId)) {
			// 未激活卡不得同时携带已接受的货币/额度事实。
			if (row.credit_limit || row.used_limit || row.currency || row.installment) {
				cardMoneyCurrencyClosureValid = false
			}
			continue
		}
		const code = row.currency?.value?.code
		if (
			!code ||
			row.credit_limit?.value?.currency !== code ||
			row.used_limit?.value?.currency !== code ||
			(row.installment?.value?.type === 'money' && row.installment.value.currency !== code)
		) cardMoneyCurrencyClosureValid = false
	}
	const facilityCardEntities = new Map([...cardEntities.entries()]
		.filter(([entityId]) => !notActivatedCardEntityIds.has(entityId)))
	const facilityGroups = acceptedCardFacilityGroups(facilityCardEntities, factLedger.relations)
	const cnyFacilities = []
	const exclusions = [...notActivatedCardEntityIds].sort().map((entityId) => ({
		entityId,
		reason: 'CARD_NOT_ACTIVATED'
	}))
	for (const facility of facilityGroups) {
		const cnyMembers = []
		for (const member of facility.members) {
			if (
				member.facts.currency?.value?.code !== 'CNY' ||
				member.facts.credit_limit?.value?.currency !== 'CNY' ||
				member.facts.used_limit?.value?.currency !== 'CNY'
			) {
				exclusions.push({ entityId: member.entityId, reason: 'NON_CNY_WITHOUT_EQUIVALENT' })
				continue
			}
			cnyMembers.push(member)
		}
		if (!cnyMembers.length) continue
		const limitMinor = Math.max(...cnyMembers.map((member) => member.facts.credit_limit.value.minor))
		const usedMinor = Math.max(...cnyMembers.map((member) => member.facts.used_limit.value.minor))
		cnyFacilities.push({
			facilityId: facility.facilityId,
			members: cnyMembers,
			limitMinor,
			usedMinor
		})
	}
	const cardOutstandingInputs = cnyFacilities.flatMap((facility) =>
		facility.members.flatMap((member) => [
			member.facts.credit_limit,
			member.facts.used_limit,
			member.facts.currency
		])
	).filter(Boolean)
	const outstandingFacilityTrace = cnyFacilities.map((facility) => ({
		facilityId: facility.facilityId,
		memberEntityIds: facility.members.map((member) => member.entityId).sort(),
		inputRelationIds: arrayAt(factLedger.relations)
			.filter((relation) => relation.status === 'accepted' &&
				Array.isArray(relation.members) &&
				relation.members.every((entityId) => facility.members.some((member) => member.entityId === entityId)))
			.map((relation) => relation.relationId)
			.sort(),
		limitMinor: facility.limitMinor,
		usedMinor: facility.usedMinor,
		policy: facility.members.length > 1 ? 'accepted-shared-max-v1' : 'single-account-v1'
	}))
	const totalOutstandingMinor = cnyFacilities.reduce((sum, facility) => sum + facility.usedMinor, 0)
	const cardOutstanding = metric(
		'card-outstanding-cny-v1',
		cardOutstandingInputs,
		{ type: 'money', currency: 'CNY', minor: totalOutstandingMinor, scale: 2 },
		{ facilityTrace: outstandingFacilityTrace }
	)
	const positiveLimitFacilities = cnyFacilities.filter((facility) => facility.limitMinor > 0)
	// The zero-limit facts remain explicit inputs so the exclusion is auditable;
	// only positive-limit facilities contribute to the numerator/denominator.
	const utilizationInputs = cardOutstandingInputs
	const totalLimitMinor = positiveLimitFacilities.reduce((sum, facility) => sum + facility.limitMinor, 0)
	const utilizationUsedMinor = positiveLimitFacilities.reduce((sum, facility) => sum + facility.usedMinor, 0)
	const facilityTrace = outstandingFacilityTrace.filter((facility) => facility.limitMinor > 0)
	const utilizationExclusions = [
		...exclusions,
		...outstandingFacilityTrace
			.filter((facility) => facility.limitMinor <= 0)
			.map((facility) => ({
				facilityId: facility.facilityId,
				memberEntityIds: facility.memberEntityIds,
				reason: 'NO_POSITIVE_CNY_LIMIT'
			}))
	]
	const cardUtilization = totalLimitMinor > 0
		? metric(
			'card-utilization-cny-v2',
			utilizationInputs,
			{ type: 'rate-bps', value: Math.round(utilizationUsedMinor * 10000 / totalLimitMinor) },
			{
				numerator: { type: 'money', currency: 'CNY', minor: utilizationUsedMinor, scale: 2 },
				denominator: { type: 'money', currency: 'CNY', minor: totalLimitMinor, scale: 2 },
				exclusions: utilizationExclusions,
				facilityTrace
			}
		)
		: {
			status: FACT_STATUS.NOT_APPLICABLE,
			formulaId: 'card-utilization-cny-v2',
			inputFactIds: utilizationInputs.map((fact) => fact.factId).sort(),
			value: null,
			reason: 'NO_POSITIVE_CNY_LIMIT',
			exclusions: utilizationExclusions,
			facilityTrace
		}

	const totalDebtInputs = [
		...loanFacts,
		...cnyFacilities.flatMap((facility) => facility.members.map((member) => member.facts.used_limit))
	].filter(Boolean)
	const totalDebt = metric(
		'total-debt-v2',
		totalDebtInputs,
		{ type: 'money', currency: 'CNY', minor: totalLoanMinor + totalOutstandingMinor, scale: 2 }
	)

	const reportFact = arrayAt(factLedger.facts).find((fact) => fact.entityKind === 'document' && fact.field === 'report_date' && fact.status === FACT_STATUS.ACCEPTED)
	const queryEntities = factsByEntity(factLedger, 'query')
	const queryRows = []
	const queryInputs = []
	for (const row of queryEntities.values()) {
		if (!row.date || !row.reason) continue
		queryRows.push({
			date: row.date.value.value,
			reason: row.reason.value.value,
			institution_type: row.date.entitySubtype || row.reason.entitySubtype || 'unknown'
		})
		queryInputs.push(row.date, row.reason)
	}
	const anchor = parseQueryDateMs(reportFact?.value?.value)
	const windows = {}
	const windowBreakdown = {}
	for (const months of [1, 3, 6, 12]) {
		const key = `last_${months}m`
		const bucket = countQueriesByWindow(queryRows, anchor, months, { hardOnly: true })
		// 保留 last_*m 数值字段给旧版消费者，新增按机构三态拆分的权威窗口。
		windows[key] = bucket.total
		windowBreakdown[key] = {
			total: bucket.total,
			bank: bucket.bank,
			non_bank: bucket.non_bank,
			unknown: bucket.unknown
		}
	}
	const queryCounts = metric(
		'hard-query-calendar-window-v2',
		[reportFact, ...queryInputs].filter(Boolean),
		{ type: 'query-window-counts', ...windows, by_window: windowBreakdown },
		{ anchorDate: reportFact.value.value }
	)
	const cnyCardEntityIds = new Set([...cardEntities.entries()]
		.filter(([, row]) =>
			row.currency?.value?.code === 'CNY' &&
			row.credit_limit?.value?.currency === 'CNY' &&
			row.used_limit?.value?.currency === 'CNY'
		)
		.map(([entityId]) => entityId))
	const scoreInputs = arrayAt(factLedger.facts).filter((fact) => {
		if (fact.entityKind === 'card' && fact.field === 'installment') {
			return cnyCardEntityIds.has(fact.entityId) && (
				(fact.status === FACT_STATUS.ACCEPTED && fact.value?.currency === 'CNY') ||
				fact.status === FACT_STATUS.ABSENT
			)
		}
		return fact.critical === true && fact.status === FACT_STATUS.ACCEPTED
	})
	const totalAccountCount = loanEntities.size + cardEntities.size
	const nonBankLoanCount = [...loanEntities.values()].filter(
		(row) => row.balance?.entitySubtype === 'non_bank_loan'
	).length
	const bigInstallmentMinor = [...cardEntities.entries()].reduce(
		(total, [entityId, row]) => total + (
			cnyCardEntityIds.has(entityId) && row.installment?.value?.currency === 'CNY'
				? Number(row.installment.value.minor || 0)
				: 0
		),
		0
	)
	const queryBursts = summarizeHardQueryBursts(queryRows, anchor, { months: 6 })
	const scoringInputs = {
		totalAccountCount,
		nonBankLoanCount,
		cardUtilizationRate: cardUtilization.status === 'computed'
			? Number(cardUtilization.value.value) / 10000
			: 0,
		hasBigInstallment: bigInstallmentMinor > 0,
		q6: Number(windows.last_6m || 0),
		sameDayInquiryDayCount: queryBursts.sameDayInquiryDayCount
	}
	const scoreProjection = calculatePrimaryRuleScore(scoringInputs)
	const suppliedScore = Number(facts?.primary_rule_score?.score)
	const scoreMatches = cardMoneyCurrencyClosureValid &&
		Number.isFinite(suppliedScore) && suppliedScore === scoreProjection.score
	const primaryScore = scoreMatches
		? metric(
			PRIMARY_SCORE_FORMULA_ID,
			scoreInputs,
			{ type: 'internal-credit-score', value: scoreProjection.score, scale: 100 },
			{
				label: '分析报告工作台内部评估分',
				baseScore: scoreProjection.baseScore,
				totalDeduction: scoreProjection.totalDeduction,
				inputMetrics: {
					...scoringInputs,
					bigInstallment: { type: 'money', currency: 'CNY', minor: bigInstallmentMinor, scale: 2 }
				},
				deductionTrace: arrayAt(scoreProjection.deductions).map((item) => ({
					ruleId: item.code,
					points: Number(item.points)
				}))
			}
		)
		: {
			...blockedMetric(
				PRIMARY_SCORE_FORMULA_ID,
				cardMoneyCurrencyClosureValid
					? 'DETERMINISTIC_SCORE_PROJECTION_MISMATCH'
					: 'MONEY_CURRENCY_MISMATCH'
			),
			expectedScore: scoreProjection.score
		}

	const payload = {
		schema: 'rpt.credit/derived-analysis/2.0',
		status: primaryScore.status === 'computed' ? 'validated' : 'blocked',
		inputs: {
			documentManifestHash: manifest.manifestHash,
			evidenceGraphHash: evidenceGraph.evidenceGraphHash,
			factLedgerHash: factLedger.factLedgerHash,
			anchorDate: factLedger.anchorDate,
			ruleVersion
		},
		metrics: { totalLoanBalance, cardOutstanding, cardUtilization, totalDebt, queryCounts, primaryScore }
	}
	return { ...payload, derivedAnalysisHash: artifactHash('da_v2', payload, hashFn) }
}

function withoutOwnKey(value, key) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return value
	const copy = { ...value }
	delete copy[key]
	return copy
}

function artifactHashesValid({ manifest, evidenceGraph, factLedger, derivedAnalysis }, hashFn) {
	try {
		return Boolean(
			manifest?.manifestHash === artifactHash(
				'mh_v2',
				withoutOwnKey(manifest, 'manifestHash'),
				hashFn
			) &&
			evidenceGraph?.evidenceGraphHash === artifactHash(
				'eg_v2',
				withoutOwnKey(evidenceGraph, 'evidenceGraphHash'),
				hashFn
			) &&
			factLedger?.factLedgerHash === artifactHash(
				'fl_v2',
				withoutOwnKey(factLedger, 'factLedgerHash'),
				hashFn
			) &&
			derivedAnalysis?.derivedAnalysisHash === artifactHash(
				'da_v2',
				withoutOwnKey(derivedAnalysis, 'derivedAnalysisHash'),
				hashFn
			)
		)
	} catch (_) {
		return false
	}
}

function evaluatePublicationGate(
	{ manifest, evidenceGraph, factLedger, derivedAnalysis } = {},
	{ hashFn = defaultHashFn } = {}
) {
	const artifacts = { manifest, evidenceGraph, factLedger, derivedAnalysis }
	const checks = [
		{ id: 'MANIFEST_COMPLETE', passed: manifest?.status === 'complete' && manifest?.coverage?.complete === true },
		{ id: 'EVIDENCE_COMPLETE', passed: evidenceGraph?.status === 'complete' && evidenceGraph?.coverage?.complete === true },
		{ id: 'LEDGER_READY', passed: factLedger?.status === 'ready' && factLedger?.gate?.status === 'passed' },
		{ id: 'DERIVED_VALIDATED', passed: derivedAnalysis?.status === 'validated' },
		{ id: 'HASH_INTEGRITY_VALID', passed: artifactHashesValid(artifacts, hashFn) },
		{ id: 'HASH_CHAIN_LINKED', passed: Boolean(
			manifest?.manifestHash &&
			evidenceGraph?.manifestHash === manifest.manifestHash &&
			factLedger?.evidenceGraphHash === evidenceGraph?.evidenceGraphHash &&
			derivedAnalysis?.inputs?.factLedgerHash === factLedger?.factLedgerHash
		) }
	]
	const failedChecks = checks.filter((check) => !check.passed).map((check) => check.id)
	return {
		status: failedChecks.length === 0 ? 'passed' : 'blocked',
		publishable: failedChecks.length === 0,
		checks,
		failedChecks
	}
}

// Publication failures are logged from the request path. Keep this diagnostic
// deliberately smaller than the public evidence artifacts: it is an explicit
// allowlist of aggregate counters and closed enums only. In particular, never
// copy arbitrary artifact keys or values here because they can contain source
// text, dates, amounts, institutions, IDs, hashes, spans or quotations.
const DIAGNOSTIC_FAILED_CHECKS = [
	'MANIFEST_COMPLETE',
	'EVIDENCE_COMPLETE',
	'LEDGER_READY',
	'DERIVED_VALIDATED',
	'HASH_INTEGRITY_VALID',
	'HASH_CHAIN_LINKED'
]
const DIAGNOSTIC_UNRESOLVED_REASONS = [
	'AMBIGUOUS_CARD_SOURCE_BUNDLE',
	'AMBIGUOUS_SOURCE_LOAN_CURRENCY_SIGNAL',
	'AMBIGUOUS_SOURCE_CARD_CURRENCY_SIGNAL',
	'ENTITY_SOURCE_ROW_MISMATCH',
	'INVALID_TYPED_VALUE',
	'SOURCE_MATCH_MISSING',
	'SOURCE_ROW_ALREADY_ASSIGNED',
	'SOURCE_VALUE_OMITTED_BY_MODEL',
	'UNSUPPORTED_CARD_ACTIVATION_STATE',
	'SOURCE_LOAN_CURRENCY_OMITTED',
	'UNCLAIMED_SOURCE_INSTALLMENT_SIGNAL',
	'UNCLAIMED_SOURCE_SHARED_CREDIT_SIGNAL'
]
const DIAGNOSTIC_CONFLICT_CODES = [
	'CARD_FACILITY_RELATION_UNRESOLVED',
	'SINGLE_MEMBER_SHARED_GROUP_UNRESOLVED'
]
const DIAGNOSTIC_BLOCKED_REASONS = [
	'DETERMINISTIC_SCORE_PROJECTION_MISMATCH',
	'FACT_LEDGER_BLOCKED',
	'MONEY_CURRENCY_MISMATCH'
]
const DIAGNOSTIC_FORMULAS = [
	'card-outstanding-cny-v1',
	'card-utilization-cny-v2',
	'hard-query-calendar-window-v2',
	'loan-balance-sum-v2',
	'primary-score-deterministic-v2',
	'primary-score-deterministic-v3',
	'total-debt-v2'
]
const DIAGNOSTIC_SECTION_NAMES = [
	'active_loans',
	'credit_card_details',
	'query_details'
]
const DIAGNOSTIC_SECTION_BASES = new Set([
	'missing-source-verification',
	'source-account-overview-pdf-geometry-v2',
	'source-account-overview-text-v1',
	'source-query-table-v1'
])
const DIAGNOSTIC_TARGET_CLASSES = [
	'report.report_date',
	'loan.balance',
	'loan.currency',
	'loan.institution_identity',
	'card.credit_limit',
	'card.used_limit',
	'card.currency',
	'card.installment',
	'card.institution_identity',
	'card.start_date_identity',
	'card.tail_identity',
	'card.shared_group_identity',
	'query.date',
	'query.reason',
	'source.installment',
	'source.shared_group_identity',
	'source.currency'
]

function diagnosticStatus(value, allowed) {
	const text = String(value || '')
	return allowed.includes(text) ? text : 'unknown'
}

function diagnosticCount(value, fallback = 0) {
	const number = Number(value)
	return Number.isSafeInteger(number) && number >= 0 ? number : fallback
}

function diagnosticNullableCount(value) {
	return value === null || value === undefined ? null : diagnosticCount(value, null)
}

function diagnosticEnumCounts(items, readValue, allowedValues) {
	const counts = new Map(allowedValues.map((value) => [value, 0]))
	let other = 0
	for (const item of arrayAt(items)) {
		const value = String(readValue(item) || '')
		if (counts.has(value)) counts.set(value, counts.get(value) + 1)
		else other += 1
	}
	const result = allowedValues
		.filter((value) => counts.get(value) > 0)
		.map((value) => ({ value, count: counts.get(value) }))
	if (other > 0) result.push({ value: 'OTHER', count: other })
	return result
}

function diagnosticTargetClass(item) {
	const key = String(item?.targetKey || '')
	const parts = key.split(':')
	if (parts[0] === 'report' && parts.at(-1) === 'report_date') return 'report.report_date'
	if (['loan', 'card', 'query'].includes(parts[0])) {
		const candidate = `${parts[0]}.${parts.at(-1)}`
		return DIAGNOSTIC_TARGET_CLASSES.includes(candidate) ? candidate : 'OTHER'
	}
	if (key.startsWith('source-installment-signal:')) return 'source.installment'
	if (key.startsWith('source-shared-credit-signal:')) return 'source.shared_group_identity'
	if (key.startsWith('source-loan-currency-signal:')) return 'source.currency'
	if (key.startsWith('source-card-currency-signal:')) return 'source.currency'
	return 'OTHER'
}

function diagnosticUnresolvedByTarget(unresolved) {
	const grouped = new Map(DIAGNOSTIC_TARGET_CLASSES.map((name) => [name, []]))
	const other = []
	for (const item of arrayAt(unresolved)) {
		const name = diagnosticTargetClass(item)
		if (grouped.has(name)) grouped.get(name).push(item)
		else other.push(item)
	}
	const result = DIAGNOSTIC_TARGET_CLASSES
		.filter((name) => grouped.get(name).length > 0)
		.map((name) => ({
			name,
			count: grouped.get(name).length,
			reasons: diagnosticEnumCounts(
				grouped.get(name),
				(item) => item?.reason,
				DIAGNOSTIC_UNRESOLVED_REASONS
			)
		}))
	if (other.length) result.push({
		name: 'OTHER',
		count: other.length,
		reasons: diagnosticEnumCounts(
			other,
			(item) => item?.reason,
			DIAGNOSTIC_UNRESOLVED_REASONS
		)
	})
	return result
}

function buildSafeEvidenceDiagnostic(
	{ manifest, evidenceGraph, factLedger, derivedAnalysis } = {},
	gate = null
) {
	const resolvedGate = gate && typeof gate === 'object'
		? gate
		: evaluatePublicationGate({ manifest, evidenceGraph, factLedger, derivedAnalysis })
	const pages = arrayAt(manifest?.pages)
	const unresolved = arrayAt(evidenceGraph?.unresolved)
	const criticalUnresolved = unresolved.filter((item) => item?.critical === true)
	const facts = arrayAt(factLedger?.facts)
	const criticalFailures = facts.filter((fact) => fact?.critical === true && fact?.status !== FACT_STATUS.ACCEPTED)
	const sectionsByName = new Map(arrayAt(factLedger?.sections)
		.filter((section) => DIAGNOSTIC_SECTION_NAMES.includes(String(section?.name || '')))
		.map((section) => [String(section.name), section]))
	const sections = DIAGNOSTIC_SECTION_NAMES
		.filter((name) => sectionsByName.has(name))
		.map((name) => {
			const section = sectionsByName.get(name)
			const rawBasis = String(section?.basis || '')
			return {
				name,
				expectedCount: diagnosticNullableCount(section?.expectedCount),
				acceptedCount: diagnosticCount(section?.acceptedEntityCount),
				declaredCount: diagnosticCount(section?.declaredEntityCount),
				status: diagnosticStatus(section?.status, ['complete', 'empty-proven', 'incomplete']),
				basis: DIAGNOSTIC_SECTION_BASES.has(rawBasis) ? rawBasis : 'other-source-basis'
			}
		})
	const metrics = Object.values(plainObject(derivedAnalysis?.metrics))
		.filter((metricValue) => metricValue && metricValue.status === 'blocked')
	return {
		failedChecks: DIAGNOSTIC_FAILED_CHECKS.filter((check) =>
			(Array.isArray(resolvedGate?.failedChecks) ? resolvedGate.failedChecks : []).includes(check)
		),
		manifest: {
			status: diagnosticStatus(manifest?.status, ['complete', 'rejected']),
			declaredPageCount: diagnosticCount(manifest?.coverage?.declaredPageCount),
			processedPageCount: diagnosticCount(manifest?.coverage?.processedPageCount, pages.length),
			completePageCount: pages.filter((page) => page?.status === 'complete').length,
			rejectedPageCount: pages.filter((page) => page?.status === 'rejected').length,
			missingPageCount: Array.isArray(manifest?.coverage?.missingPageNos)
				? manifest.coverage.missingPageNos.length
				: 0,
			duplicatePageCount: Array.isArray(manifest?.coverage?.duplicatePageNos)
				? manifest.coverage.duplicatePageNos.length
				: 0
		},
		graph: {
			status: diagnosticStatus(evidenceGraph?.status, ['complete', 'rejected']),
			nodeCount: arrayAt(evidenceGraph?.nodes).length,
			criticalUnresolvedCount: criticalUnresolved.length,
			unresolvedReasons: diagnosticEnumCounts(
				unresolved,
				(item) => item?.reason,
				DIAGNOSTIC_UNRESOLVED_REASONS
			),
			unresolvedByTarget: diagnosticUnresolvedByTarget(unresolved)
		},
		ledger: {
			status: diagnosticStatus(factLedger?.status, ['ready', 'blocked']),
			criticalFailureCount: criticalFailures.length,
			sections,
			conflictCodes: diagnosticEnumCounts(
				factLedger?.conflicts,
				(item) => item?.code,
				DIAGNOSTIC_CONFLICT_CODES
			)
		},
		derived: {
			status: diagnosticStatus(derivedAnalysis?.status, ['validated', 'blocked']),
			blockedMetricCount: metrics.length,
			blockedReasons: diagnosticEnumCounts(
				metrics,
				(item) => item?.reason,
				DIAGNOSTIC_BLOCKED_REASONS
			),
			blockedFormulas: diagnosticEnumCounts(
				metrics,
				(item) => item?.formulaId,
				DIAGNOSTIC_FORMULAS
			)
		}
	}
}

function assertPublicationGate(artifacts, options = {}) {
	const gate = evaluatePublicationGate(artifacts, options)
	if (!gate.publishable) {
		const error = new Error('evidence-first credit analysis is not publishable')
		error.code = 'EVIDENCE_PUBLICATION_BLOCKED'
		error.failedChecks = gate.failedChecks
		error.diagnostic = buildSafeEvidenceDiagnostic(artifacts, gate)
		throw error
	}
	return true
}

function buildEvidenceFirstCreditAnalysis({
	sourceText,
	evidenceContext = {},
	inputKind = 'credit-report-pdf',
	documentId,
	declaredPageCount,
	versions = {},
	ruleVersion,
	hashFn = defaultHashFn,
	requirePublishable = false
} = {}) {
	if (requirePublishable && hashFn === defaultHashFn) {
		const error = new Error('publishable evidence requires a keyed artifact hash function')
		error.code = 'EVIDENCE_HASH_KEY_REQUIRED'
		throw error
	}
	const manifest = buildDocumentManifest({
		sourceText,
		evidenceContext,
		inputKind,
		documentId,
		declaredPageCount,
		versions,
		hashFn
	})
	const evidenceGraph = buildEvidenceGraph({ sourceText, evidenceContext, manifest, hashFn })
	const factLedger = buildCreditFactLedger({ evidenceContext, manifest, evidenceGraph, hashFn })
	const { facts } = factsAndContext(evidenceContext)
	const derivedAnalysis = buildDerivedAnalysis({
		manifest,
		evidenceGraph,
		factLedger,
		facts,
		ruleVersion,
		hashFn
	})
	const publicationGate = evaluatePublicationGate(
		{ manifest, evidenceGraph, factLedger, derivedAnalysis },
		{ hashFn }
	)
	const result = {
		contract: 'rpt.credit/evidence-first-analysis/2.0',
		status: publicationGate.publishable ? 'publishable' : 'blocked',
		manifest,
		evidenceGraph,
		factLedger,
		derivedAnalysis,
		publicationGate
	}
	if (requirePublishable) assertPublicationGate(result, { hashFn })
	return result
}

// Explicit adapter name documents that the legacy finalizer output is accepted
// as input but is not mutated or treated as v2-authoritative without verified
// source section counts and evidence binding.
function fromFinalizedCreditFacts(sourceText, finalizedFacts, options = {}) {
	return buildEvidenceFirstCreditAnalysis({
		...options,
		sourceText,
		evidenceContext: {
			facts: finalizedFacts,
			sourceVerifiedCounts: options.sourceVerifiedCounts,
			documentMeta: options.documentMeta
		}
	})
}

module.exports = {
	FACT_STATUS,
	stableCanonicalize,
	defaultHashFn,
	createHmacHashFn,
	resolveCurrencyFields,
	isExplicitNoSharedCreditToken,
	buildSourceSharedGroupId,
	applyControlledSourceCardInstallments,
	buildDocumentManifest,
	buildEvidenceGraph,
	buildCreditFactLedger,
	buildDerivedAnalysis,
	evaluatePublicationGate,
	buildSafeEvidenceDiagnostic,
	assertPublicationGate,
	buildEvidenceFirstCreditAnalysis,
	fromFinalizedCreditFacts
}
