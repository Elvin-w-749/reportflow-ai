/**
 * 客户端错误上报（最小闭环 Sentry）
 *
 * 设计目标：
 *   - 任何路径（uni.* 没法用的场景下）都不能反过来抛错
 *   - 拒绝因为后端挂了或 PROXY_BASE 不通而打断正常业务
 *   - 内存中按 kind+message 去重 + 1 分钟节流，避免无限循环里把后端打爆
 *   - 不依赖 services/apiClient.js（apiClient 自身可能也是错误源，避免循环）
 */

import { PROXY_BASE } from '@/config/proxy.js'

const MAX_QUEUE = 30
const THROTTLE_MS = 60 * 1000

const recent = new Map() // key → lastSendAt
let dropped = 0

function keyOf(payload) {
	return `${payload.kind}::${(payload.message || '').slice(0, 80)}`
}

function buildEndpoint() {
	const base = String(PROXY_BASE || '').replace(/\/+$/, '')
	if (!/^https?:\/\//i.test(base)) return ''
	return base + '/api/log/error'
}

function safeStringify(v) {
	try {
		if (typeof v === 'string') return v
		return JSON.stringify(v)
	} catch {
		return String(v)
	}
}

/**
 * 脱敏：上报前抹掉手机号 / 身份证 / 银行卡等明文，避免 PII 随错误日志外泄。
 * 顺序：先身份证（18 位），再手机号（11 位），最后泛化长数字串（13-19 位，覆盖银行卡）。
 */
function maskPII(s) {
	if (typeof s !== 'string' || !s) return s
	return s
		.replace(/\b\d{6}\d{8}\d{3}[\dXx]\b/g, (m) => m.slice(0, 6) + '********' + m.slice(-4))
		.replace(/\b1[3-9]\d{9}\b/g, (m) => m.slice(0, 3) + '****' + m.slice(-4))
		.replace(/\b\d{13,19}\b/g, (m) => m.slice(0, 4) + '****' + m.slice(-4))
}

/** 脱敏 extra：保持原始形态（对象→脱敏后的对象，便于后端按 object 落库），字符串→脱敏字符串 */
function maskExtra(v) {
	const masked = maskPII(safeStringify(v))
	if (typeof v === 'string') return masked.slice(0, 4096)
	try {
		return JSON.parse(masked)
	} catch {
		return masked.slice(0, 4096)
	}
}

/**
 * @param {{ kind?: string, message: string, stack?: any, page?: string, extra?: any }} input
 */
export function reportError(input) {
	try {
		const payload = {
			kind: String((input && input.kind) || 'client-error').slice(0, 64),
			message: maskPII(safeStringify((input && input.message) || 'unknown error')).slice(0, 1024),
			stack: maskPII(safeStringify((input && input.stack) || '')).slice(0, 4096),
			page: String((input && input.page) || '').slice(0, 256),
			ts: Date.now(),
			ua: 'legacy-web',
			extra: input && input.extra ? maskExtra(input.extra) : null
		}
		const key = keyOf(payload)
		const last = recent.get(key) || 0
		const now = Date.now()
		if (now - last < THROTTLE_MS) {
			dropped++
			return
		}
		recent.set(key, now)
		if (recent.size > MAX_QUEUE) {
			const oldest = recent.keys().next().value
			if (oldest) recent.delete(oldest)
		}

		const url = buildEndpoint()
		if (!url) return

		uni.request({
			url,
			method: 'POST',
			data: payload,
			timeout: 5000,
			header: { 'content-type': 'application/json' },
			success: () => {},
			fail: () => {
				// 静默：避免上报失败本身又触发上报 → 无限递归
			}
		})
	} catch {
		// 兜底：上报模块不能再抛错
	}
}

/** 调试用：拿到当前丢弃数（被节流的次数） */
export function getDroppedCount() {
	return dropped
}

export default { reportError, getDroppedCount }
