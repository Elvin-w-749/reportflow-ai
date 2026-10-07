'use strict'

/**
 * 结构化日志（pino 可选 + console JSON fallback）
 *
 * - 输出每条日志一行 JSON（ts/level/svc/...payload），便于 jq / ELK / Datadog 采集
 * - 默认 fallback 到 console，不强制依赖 pino
 * - 如果 ai-proxy 上线机器 `npm i pino`，自动切到 pino（更高性能，async 写入）
 * - LOG_LEVEL=trace|debug|info|warn|error|fatal（默认 info）
 *
 * 用法：
 *   const logger = require('./utils/logger')
 *   logger.info({ uid: 'u_1' }, 'user logged in')
 *   logger.error({ err }, 'pdf parse failed')
 */

const SVC = 'ai-proxy'
const ENV = String(process.env.NODE_ENV || 'development')
const LEVEL = String(process.env.LOG_LEVEL || 'info').toLowerCase()

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 }
const minLevel = LEVELS[LEVEL] || LEVELS.info

let impl

try {
	const pino = require('pino')
	// 自定义目标：按级别把整行 JSON 路由到 stdout / stderr（与下方 console fallback 行为一致），
	// 同时避免 pino 默认 SonicBoom 直写 fd 绕过 process.stdout（导致单测无法捕获）。
	const levelRoutingDestination = {
		write(line) {
			let isErr = false
			try {
				const lvl = JSON.parse(line).level
				isErr =
					lvl === 'error' ||
					lvl === 'fatal' ||
					lvl === 'warn' ||
					(typeof lvl === 'number' && lvl >= 40)
			} catch {
				isErr = false
			}
			if (isErr) process.stderr.write(line)
			else process.stdout.write(line)
		}
	}
	impl = pino(
		{
			level: LEVEL,
			base: { svc: SVC, env: ENV },
			formatters: { level: (label) => ({ level: label }) },
			timestamp: () => `,"ts":"${new Date().toISOString()}"`
		},
		levelRoutingDestination
	)
} catch {
	function emit(level, msgOrObj, maybeMsg) {
		if (LEVELS[level] < minLevel) return
		let payload
		if (msgOrObj instanceof Error) {
			payload = { err: { name: msgOrObj.name, message: msgOrObj.message, stack: msgOrObj.stack } }
		} else if (typeof msgOrObj === 'string') {
			payload = { msg: msgOrObj }
		} else if (msgOrObj && typeof msgOrObj === 'object') {
			payload = msgOrObj.err instanceof Error
				? { ...msgOrObj, err: { name: msgOrObj.err.name, message: msgOrObj.err.message, stack: msgOrObj.err.stack } }
				: { ...msgOrObj }
		} else {
			payload = { msg: String(msgOrObj) }
		}
		if (maybeMsg && !payload.msg) payload.msg = String(maybeMsg)

		const line = JSON.stringify({
			ts: new Date().toISOString(),
			level,
			svc: SVC,
			env: ENV,
			...payload
		})
		if (level === 'error' || level === 'fatal' || level === 'warn') {
			console.error(line)
		} else {
			console.log(line)
		}
	}
	impl = {
		trace: (a, b) => emit('trace', a, b),
		debug: (a, b) => emit('debug', a, b),
		info: (a, b) => emit('info', a, b),
		warn: (a, b) => emit('warn', a, b),
		error: (a, b) => emit('error', a, b),
		fatal: (a, b) => emit('fatal', a, b),
		child: (extra) => makeChild(extra)
	}

	function makeChild(extra) {
		function mix(o, m) {
			if (typeof o === 'string') return { ...extra, msg: o, ...(m ? { msg2: m } : {}) }
			return { ...extra, ...o }
		}
		return {
			trace: (a, b) => emit('trace', mix(a, b)),
			debug: (a, b) => emit('debug', mix(a, b)),
			info: (a, b) => emit('info', mix(a, b)),
			warn: (a, b) => emit('warn', mix(a, b)),
			error: (a, b) => emit('error', mix(a, b)),
			fatal: (a, b) => emit('fatal', mix(a, b)),
			child: (more) => makeChild({ ...extra, ...more })
		}
	}
}

module.exports = impl
