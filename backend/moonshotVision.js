'use strict'

const sharp = require('sharp')
const { ocrImageBufferToText, normalizeProvider } = require('./localOcr')

const CHAT_URL = process.env.MOONSHOT_CHAT_URL || process.env.KIMI_CHAT_URL || 'https://api.moonshot.cn/v1/chat/completions'
const API_KEY = process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY
const VISION_MODEL = process.env.KIMI_VISION_MODEL || process.env.MOONSHOT_VISION_MODEL || 'moonshot-v1-8k-vision-preview'
const TEMPERATURE = Number(process.env.KIMI_VISION_TEMPERATURE || process.env.MOONSHOT_VISION_TEMPERATURE || 0)
const OCR_TIMEOUT_MS = Number(process.env.KIMI_VISION_TIMEOUT_MS || process.env.MOONSHOT_VISION_TIMEOUT_MS || 120000)
const OCR_PROVIDER = normalizeProvider(process.env.OCR_PROVIDER, Boolean(API_KEY))
// Dense credit-report pages can contain dozens of narrow rows. Keeping a whole
// PDF page in one/two OCR prompts makes vision models skip middle rows, so the
// default tile is intentionally shorter than a rendered A4 page.
const CLOUD_TILE_MAX_HEIGHT = Math.max(600, Number(process.env.OCR_TILE_MAX_HEIGHT || 900))
const LOCAL_TILE_MAX_HEIGHT = Math.max(1200, Number(process.env.LOCAL_OCR_TILE_MAX_HEIGHT || 4000))
const TILE_MAX_HEIGHT = OCR_PROVIDER === 'local' ? LOCAL_TILE_MAX_HEIGHT : CLOUD_TILE_MAX_HEIGHT
const TILE_MAX_WIDTH = Math.max(800, Number(process.env.OCR_TILE_MAX_WIDTH || 1400))

function cleanBase64(input) {
	return String(input || '').replace(/^data:[^,]+,/i, '').replace(/\s/g, '')
}

function normalizeMimeType(mimeType = '') {
	const s = String(mimeType || '').toLowerCase()
	if (s.includes('png')) return 'image/png'
	if (s.includes('webp')) return 'image/webp'
	return 'image/jpeg'
}

function contentToText(content) {
	if (typeof content === 'string') return content
	if (Array.isArray(content)) {
		return content
			.map((item) => {
				if (typeof item === 'string') return item
				if (item && typeof item.text === 'string') return item.text
				return ''
			})
			.filter(Boolean)
			.join('\n')
	}
	return ''
}

function safeVisionError(code, message, upstreamStatus) {
	const error = new Error(message)
	error.code = code
	if (Number.isInteger(upstreamStatus)) error.upstreamStatus = upstreamStatus
	return error
}

async function chatVision(messages) {
	if (!API_KEY) throw new Error('KIMI_API_KEY or MOONSHOT_API_KEY not configured')
	const ctrl = new AbortController()
	const timer = setTimeout(() => ctrl.abort(), OCR_TIMEOUT_MS)
	try {
		const res = await fetch(CHAT_URL, {
			method: 'POST',
			signal: ctrl.signal,
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${API_KEY}`
			},
			body: JSON.stringify({
				model: VISION_MODEL,
				temperature: Number.isFinite(TEMPERATURE) ? TEMPERATURE : 0,
				messages
			})
		})
		const text = await res.text()
		if (!res.ok) {
			throw safeVisionError(
				'VISION_OCR_UPSTREAM_HTTP_ERROR',
				`vision OCR upstream request failed (HTTP ${res.status})`,
				res.status
			)
		}
		let json = null
		try {
			json = JSON.parse(text)
		} catch {
			throw safeVisionError(
				'VISION_OCR_UPSTREAM_INVALID_RESPONSE',
				'vision OCR upstream returned invalid JSON'
			)
		}
		const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content
		const out = contentToText(content).trim()
		if (!out) {
			throw safeVisionError(
				'VISION_OCR_UPSTREAM_EMPTY_RESPONSE',
				'vision OCR upstream returned empty text'
			)
		}
		return out
	} catch (error) {
		if (error && /^VISION_OCR_UPSTREAM_/.test(String(error.code || ''))) throw error
		if (ctrl.signal.aborted || (error && error.name === 'AbortError')) {
			throw safeVisionError('VISION_OCR_UPSTREAM_TIMEOUT', 'vision OCR upstream request timed out')
		}
		// 不传播 fetch/SDK 原始错误，避免供应商响应正文、请求对象或凭证随 Error 落日志。
		throw safeVisionError('VISION_OCR_UPSTREAM_ERROR', 'vision OCR upstream request failed')
	} finally {
		clearTimeout(timer)
	}
}

async function toJpeg(buffer, opts = {}) {
	const width = opts.width
	const pipeline = sharp(buffer, { limitInputPixels: false }).rotate()
	if (width) pipeline.resize({ width, withoutEnlargement: true })
	return pipeline.jpeg({ quality: 88, mozjpeg: true }).toBuffer()
}

async function splitImageForOcr(input, mimeType = 'image/jpeg', options = {}) {
	const buffer = Buffer.isBuffer(input) ? input : Buffer.from(cleanBase64(input), 'base64')
	if (!buffer.length) return []

	const meta = await sharp(buffer, { limitInputPixels: false }).metadata()
	const sourceWidth = Number(meta.width || 0)
	const sourceHeight = Number(meta.height || 0)
	const targetWidth = sourceWidth > TILE_MAX_WIDTH ? TILE_MAX_WIDTH : undefined
	const normalized = await toJpeg(buffer, { width: targetWidth })
	const normalizedMeta = await sharp(normalized, { limitInputPixels: false }).metadata()
	const width = Number(normalizedMeta.width || sourceWidth || 0)
	const height = Number(normalizedMeta.height || sourceHeight || 0)

	if (!width || !height || height <= TILE_MAX_HEIGHT) {
		return [{ base64: normalized.toString('base64'), mimeType: 'image/jpeg', index: 0, total: 1 }]
	}

	const tiles = []
	const requestedOffset = Number(options.tileOffset || 0)
	const tileOffset = Number.isFinite(requestedOffset)
		? Math.max(0, Math.min(TILE_MAX_HEIGHT - 1, Math.floor(requestedOffset)))
		: 0
	let top = 0
	if (tileOffset > 0) {
		const firstHeight = Math.min(tileOffset, height)
		const firstTile = await sharp(normalized, { limitInputPixels: false })
			.extract({ left: 0, top: 0, width, height: firstHeight })
			.jpeg({ quality: 88, mozjpeg: true })
			.toBuffer()
		tiles.push({ base64: firstTile.toString('base64'), mimeType: 'image/jpeg', index: 0, total: 0 })
		top = firstHeight
	}
	for (; top < height; top += TILE_MAX_HEIGHT) {
		const tileHeight = Math.min(TILE_MAX_HEIGHT, height - top)
		const tile = await sharp(normalized, { limitInputPixels: false })
			.extract({ left: 0, top, width, height: tileHeight })
			.jpeg({ quality: 88, mozjpeg: true })
			.toBuffer()
		tiles.push({ base64: tile.toString('base64'), mimeType: 'image/jpeg', index: tiles.length, total: 0 })
	}
	return tiles.map((tile) => ({ ...tile, total: tiles.length }))
}

async function ocrImageToText(base64, mimeType = 'image/jpeg') {
	const clean = cleanBase64(base64)
	if (clean.length < 100) return ''
	if (OCR_PROVIDER === 'local') {
		return ocrImageBufferToText(Buffer.from(clean, 'base64'))
	}
	if (OCR_PROVIDER !== 'moonshot' && OCR_PROVIDER !== 'kimi') {
		throw new Error(`Unsupported OCR_PROVIDER: ${OCR_PROVIDER}`)
	}
	const dataUrl = `data:${normalizeMimeType(mimeType)};base64,${clean}`
	return chatVision([
		{
			role: 'system',
			content: '你是严谨的中文 OCR 引擎。只提取图片中的可见文字和数字，不要推测，不要解释。'
		},
		{
			role: 'user',
			content: [
				{
					type: 'text',
					text: '请逐行识别图片文字。保留月份、单位、金额、缴费月数、税额、余额等数字。看不清的地方用[无法识别]，不要编造。只输出纯文本。'
				},
				{
					type: 'image_url',
					image_url: { url: dataUrl }
				}
			]
		}
	])
}

async function analyzeCreditReportImage(base64, mimeType = 'image/jpeg') {
	const text = await ocrImageToText(base64, mimeType)
	return {
		rawText: text,
		ocrText: text,
		text,
		source: 'vision-ocr'
	}
}

module.exports = {
	analyzeCreditReportImage,
	ocrImageToText,
	splitImageForOcr
}
