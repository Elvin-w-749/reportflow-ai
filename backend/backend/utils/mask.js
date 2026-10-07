'use strict'

/**
 * 敏感信息脱敏工具（后端统一入口）
 *
 * 规则：
 *   - 手机号：保留前 3 后 2（如 138****5678 → 138****78）
 *   - 身份证：保留前 6 后 4（如 310101********1234）
 */

/** 手机号脱敏（前 3 后 2）；过短则全掩 */
function maskPhone(phone) {
	const s = String(phone || '')
	return s.length >= 7 ? `${s.slice(0, 3)}****${s.slice(-2)}` : '***'
}

/** 身份证号脱敏（前 6 后 4） */
function maskIdCard(id) {
	const s = String(id || '').replace(/[^\dXx]/g, '')
	return s.length >= 15 ? `${s.slice(0, 6)}********${s.slice(-4)}` : (s ? '***' : '')
}

module.exports = { maskPhone, maskIdCard }
