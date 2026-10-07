'use strict'

const logger = require('../utils/logger')

/**
 * 客户端错误上报（最小闭环 Sentry）
 *
 *   POST /api/log/error
 *   body: { kind?, message, stack?, page?, ts?, ua?, extra? }
 *
 * - 公开端点（未登录时也可以上报）；但有限流以防滥用
 * - 落盘到 ai-proxy/data/error-YYYY-MM-DD.log（每行 1 个 JSON，便于 jq / logrotate / 接管到 ELK）
 * - body 任何字段都做长度截断，防止巨型 payload 撑爆磁盘
 *
 * 后续接入 Sentry / Datadog / 自建 ES 时，只需替换 writeLine 的 IO 实现。
 */

const express = require('express')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')

const router = express.Router()

const LOG_DIR = process.env.LOG_DIR
	? path.resolve(process.env.LOG_DIR)
	: path.join(__dirname, '..', '..', 'data')

const EXTRA_SCALAR_FIELDS = Object.freeze({
	action: { type: 'string', max: 64 },
	category: { type: 'string', max: 64 },
	fileType: { type: 'string', max: 32 },
	fileExtension: { type: 'string', max: 16 },
	fileSize: { type: 'number' },
	stage: { type: 'string', max: 64 },
	reportId: { type: 'string', max: 128 },
	code: { type: 'string', max: 64 },
	status: { type: 'string', max: 64 },
	statusCode: { type: 'number' },
	method: { type: 'string', max: 16 },
	route: { type: 'string', max: 256 },
	source: { type: 'string', max: 64 },
	component: { type: 'string', max: 128 },
	attempt: { type: 'number' },
	retryCount: { type: 'number' },
	provider: { type: 'string', max: 32 },
	model: { type: 'string', max: 64 },
	cacheHit: { type: 'boolean' },
	clientSupportRef: { type: 'support-ref' },
	terminalServerTime: { type: 'iso-time' }
})
const EXTRA_CONTAINER_FIELDS = new Set(['context', 'details', 'meta', 'metadata'])
const EXTRA_MAX_DEPTH = 3
const EXTRA_MAX_ARRAY_ITEMS = 10

function ensureDir() {
	if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })
}

function todayFile() {
	const d = new Date()
	const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
	return path.join(LOG_DIR, `error-${ymd}.log`)
}

function truncate(v, max) {
	if (v == null) return ''
	const s = String(v)
	return s.length > max ? s.slice(0, max) + '…(truncated)' : s
}

function redactSensitiveText(value) {
	return String(value == null ? '' : value)
		.replace(/\b(?:sk|ak)-[A-Za-z0-9_-]{8,}\b/gi, '[redacted-key]')
		.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}=*/gi, 'Bearer [redacted-token]')
		.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted-token]')
		.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
		.replace(/\b(\d{6})\d{8}(\d{3}[\dXx])\b/g, '$1********$2')
		.replace(/\b(1[3-9]\d)\d{4}(\d{4})\b/g, '$1****$2')
		.replace(/\b(\d{4})\d{5,11}(\d{4})\b/g, '$1****$2')
}

function sanitizeExtraScalar(value, rule) {
	if (rule.type === 'string') {
		if (typeof value !== 'string') return undefined
		return truncate(redactSensitiveText(value), rule.max)
	}
	if (rule.type === 'number') {
		return typeof value === 'number' && Number.isFinite(value) ? value : undefined
	}
	if (rule.type === 'boolean') return typeof value === 'boolean' ? value : undefined
	if (rule.type === 'support-ref') {
		return typeof value === 'string' && /^sr_[A-Za-z0-9_-]{24}$/.test(value) ? value : undefined
	}
	if (rule.type === 'iso-time') {
		if (
			typeof value !== 'string' ||
			!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
		) return undefined
		try { return new Date(value).toISOString() === value ? value : undefined } catch (_) { return undefined }
	}
	return undefined
}

/**
 * extra 是公开端点的非可信 JSON。每一层都只保留明确字段，字符串再做 PII/凭证脱敏；
 * 未知字段、过深对象和非 JSON 标量全部丢弃，避免任意客户端对象进入持久日志。
 */
function sanitizeExtra(value, depth = 0) {
	if (!value || typeof value !== 'object' || depth > EXTRA_MAX_DEPTH) return undefined
	if (Array.isArray(value)) {
		const items = value
			.slice(0, EXTRA_MAX_ARRAY_ITEMS)
			.map((item) => sanitizeExtra(item, depth + 1))
			.filter((item) => item && Object.keys(item).length > 0)
		return items.length > 0 ? items : undefined
	}

	const out = Object.create(null)
	for (const [key, raw] of Object.entries(value)) {
		const scalarRule = EXTRA_SCALAR_FIELDS[key]
		if (scalarRule) {
			const sanitized = sanitizeExtraScalar(raw, scalarRule)
			if (sanitized !== undefined && sanitized !== '') out[key] = sanitized
			continue
		}
		if (!EXTRA_CONTAINER_FIELDS.has(key) || depth >= EXTRA_MAX_DEPTH) continue
		const nested = sanitizeExtra(raw, depth + 1)
		if (nested && Object.keys(nested).length > 0) out[key] = nested
	}
	return out
}

// 异步追加：错误上报属高频公开端点，用 fs/promises 避免同步 IO 阻塞事件循环；
// 仍在响应前 await 落盘，保证「上报成功」语义可靠。
async function writeLine(line) {
	ensureDir()
	await fsp.appendFile(todayFile(), line + '\n', 'utf8')
}

router.post('/api/log/error', async (req, res) => {
	const b = req.body || {}
	const safeExtra = sanitizeExtra(b.extra)
	const record = {
		ts: new Date().toISOString(),
		ip: req.ip,
		ua: truncate(redactSensitiveText(req.headers['user-agent'] || b.ua), 256),
		kind: truncate(redactSensitiveText(b.kind || 'client-error'), 64),
		message: truncate(redactSensitiveText(b.message), 1024),
		stack: truncate(redactSensitiveText(b.stack), 4096),
		page: truncate(redactSensitiveText(b.page), 256),
		sourceTrust: 'untrusted-client-report',
		extra: safeExtra ? truncate(JSON.stringify(safeExtra), 4096) : ''
	}
	if (!record.message) return res.json({ code: 1001, message: 'message required' })

	try {
		await writeLine(JSON.stringify(record))
	} catch (e) {
		logger.error({ err: e }, 'log/error append failed')
	}
	return res.json({ code: 0 })
})

module.exports = router
