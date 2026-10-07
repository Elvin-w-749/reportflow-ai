/**
 * 北京时间锚点（Asia/Shanghai）
 *
 * 客户端：启动时请求 /api/time 校准设备时钟偏差，统计窗口以联网时间为准。
 * Node/审计：未校准时使用当前 UTC 时刻（测试可传固定 anchor）。
 */

import { buildProxyApiUrl, PROXY_BASE } from '../config/proxy.js'

const SHANGHAI_TZ = 'Asia/Shanghai'
const SYNC_TTL_MS = 5 * 60 * 1000

let offsetMs = 0
let hasSync = false
let lastSyncAt = 0
let syncInflight = null

export function getBeijingNowMs() {
	if (hasSync) return Date.now() + offsetMs
	return Date.now()
}

/** 统计窗口右端：联网校准后的当前时刻（Date） */
export function getLiveTimeAnchor() {
	return new Date(getBeijingNowMs())
}

export function isBeijingTimeSynced() {
	return hasSync && Date.now() - lastSyncAt < SYNC_TTL_MS
}

export function applyServerTimeSync(serverUnixMs) {
	const ms = Number(serverUnixMs)
	if (!Number.isFinite(ms)) return false
	offsetMs = ms - Date.now()
	hasSync = true
	lastSyncAt = Date.now()
	return true
}

/** YYYY-MM-DD（北京时间日历日） */
export function formatBeijingYmd(ms = getBeijingNowMs()) {
	const fmt = new Intl.DateTimeFormat('en-CA', {
		timeZone: SHANGHAI_TZ,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	})
	return fmt.format(new Date(ms))
}

/** 征信常见日期串 → 北京时间当日中午（避免时区日界偏移） */
export function parseYmdAsBeijing(ymd) {
	const s = String(ymd || '').trim().replace(/\./g, '-').slice(0, 10)
	const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
	if (!m) return null
	const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T12:00:00+08:00`)
	return Number.isNaN(t) ? null : new Date(t)
}

/**
 * 征信报告日期通用解析（统一入口）。
 * 兼容格式：YYYY-MM-DD / YYYY/MM/DD / YYYY年MM月DD日 / YYYY.MM.DD
 * 解析为北京时间当日正午，确保跨平台一致（避免 `new Date(s)` 的 UTC/本地歧义）。
 * @param {string} raw 日期字符串
 * @returns {Date|null} 解析成功返回 Date，失败返回 null
 */
export function parseCreditDate(raw) {
	if (!raw) return null
	const s = String(raw).trim()
	// 1) 标准 ISO / 点分隔 → 归一到 YYYY-MM-DD 后走 parseYmdAsBeijing
	const m1 = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/)
	if (m1) {
		return parseYmdAsBeijing(`${m1[1]}-${m1[2].padStart(2, '0')}-${m1[3].padStart(2, '0')}`)
	}
	// 2) 中文年月日：YYYY年MM月DD日
	const m2 = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?$/)
	if (m2) {
		return parseYmdAsBeijing(`${m2[1]}-${m2[2].padStart(2, '0')}-${m2[3].padStart(2, '0')}`)
	}
	// 3) 回退：尝试原生解析（非标准格式的最后手段）
	const t = Date.parse(s)
	return Number.isNaN(t) ? null : new Date(t)
}

async function fetchTimeFromApi(url) {
	if (typeof uni !== 'undefined' && typeof uni.request === 'function') {
		const res = await new Promise((resolve, reject) => {
			uni.request({
				url,
				method: 'GET',
				timeout: 8000,
				success: resolve,
				fail: reject
			})
		})
		return {
			ok: true,
			status: Number(res && res.statusCode) || 0,
			data: res && res.data,
			headers: (res && res.header) || {}
		}
	}
	if (typeof fetch === 'function') {
		const res = await fetch(url, { method: 'GET' })
		let data = null
		try {
			data = await res.json()
		} catch {
			data = null
		}
		const headers = {}
		try {
			res.headers.forEach((v, k) => {
				headers[k] = v
			})
		} catch {}
		if (!res.ok) {
			return { ok: false, status: res.status, data, headers }
		}
		return { ok: true, status: res.status, data, headers }
	}
	return null
}

/**
 * 从网关拉取北京时间并校准本地时钟偏差
 * @param {{ force?: boolean }} [opts]
 */
export async function syncBeijingTimeFromNetwork(opts = {}) {
	const force = opts.force === true
	if (!force && isBeijingTimeSynced()) return true
	if (!force && syncInflight) return syncInflight

	syncInflight = (async () => {
		try {
			let buildUrl = null
			let base = ''
			if (typeof uni !== 'undefined') {
				buildUrl = buildProxyApiUrl
				base = String(PROXY_BASE || '').replace(/\/+$/, '')
			}
			const url = buildUrl ? buildUrl('/time') : ''
			if (url) {
				const timeRes = await fetchTimeFromApi(url)
				if (timeRes && timeRes.ok && timeRes.data && timeRes.data.ok && applyServerTimeSync(timeRes.data.timestamp_ms)) {
					return true
				}
			}
			// 兼容线上旧网关未开放 /api/time：回退使用 /health 的 Date 头做弱校时
			if (base) {
				const healthRes = await fetchTimeFromApi(`${base}/health`)
				if (healthRes && healthRes.ok) {
					const headers = healthRes.headers || {}
					const rawDate = headers.date || headers.Date || ''
					const ts = Date.parse(String(rawDate || ''))
					if (Number.isFinite(ts)) {
						return applyServerTimeSync(ts)
					}
				}
			}
		} catch (e) {
			console.warn('[beijingTime] 联网校时失败，使用本机时钟', e && e.message ? e.message : e)
		}
		return false
	})()

	try {
		return await syncInflight
	} finally {
		syncInflight = null
	}
}
