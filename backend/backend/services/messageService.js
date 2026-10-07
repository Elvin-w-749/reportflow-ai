'use strict'

/**
 * 系统消息服务
 *
 * 统一消息创建入口，供各业务模块在关键事件发生时自动生成用户可见的消息。
 * 消息持久化到 store（走现有 JSON 存储），前端消息中心通过 /api/message/list 拉取。
 *
 * 使用方式：
 *   const { addMessage } = require('../services/messageService')
 *   await addMessage(uid, { type:'analysis', title:'...', desc:'...', linkType:'report', linkId:'r_xxx' })
 */

const store = require('../db/store')
const logger = require('../utils/logger')

/** 允许的消息类型，与前端 tabs + /api/message/list 白名单对齐 */
const VALID_TYPES = new Set(['analysis', 'product', 'system', 'security'])

/** 消息类型的默认图标颜色（仅作服务端参考；前端有独立的 TYPE_STYLES 映射） */
const TYPE_DEFAULTS = {
	analysis: { linkType: 'report' },
	product: { linkType: 'product' },
	system: { linkType: 'modal' },
	security: { linkType: 'modal' }
}

/**
 * 生成当天/昨天/更早的分组标签
 */
function dateGroupLabel(ts) {
	const d = new Date(ts)
	const now = new Date()
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
	const yesterday = today - 86400000
	const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
	if (msgDay >= today) return '今天'
	if (msgDay >= yesterday) return '昨天'
	return '更早'
}

/**
 * 生成短时间字符串
 */
function timeShort(ts) {
	const d = new Date(ts)
	const hh = String(d.getHours()).padStart(2, '0')
	const mm = String(d.getMinutes()).padStart(2, '0')
	return `${hh}:${mm}`
}

/**
 * 向指定用户的消息列表中添加一条消息。
 *
 * @param {string} uid 用户 ID
 * @param {object} opts
 * @param {string} opts.type      — 消息类型：analysis | product | system | security
 * @param {string} opts.title     — 消息标题（≤30 字）
 * @param {string} opts.desc      — 消息正文（≤200 字）
 * @param {string} [opts.linkType]  — 点击跳转类型：report | product | modal（默认 modal）
 * @param {string} [opts.linkId]    — 关联的业务 ID（如 reportId）
 * @param {string} [opts.action]    — 操作按钮文案（如"查看报告"），不传则无按钮
 * @returns {object} 创建的消息对象
 */
function addMessage(uid, opts = {}) {
	if (!uid || typeof uid !== 'string') return null

	const type = VALID_TYPES.has(opts.type) ? opts.type : 'system'
	const defaults = TYPE_DEFAULTS[type] || {}
	const now = Date.now()

	// 通知偏好检查：用户关闭该类型通知则静默跳过
	const s = store.state()
	const prefs = (s.notificationSettings && s.notificationSettings[uid]) || null
	if (prefs && typeof prefs[type] === 'boolean' && !prefs[type]) {
		return null
	}

	const msg = {
		id: `msg_${now}_${Math.random().toString(36).slice(2, 8)}`,
		userId: uid,
		type,
		title: String(opts.title || '').slice(0, 30),
		desc: String(opts.desc || '').slice(0, 200),
		isRead: false,
		dateGroup: dateGroupLabel(now),
		timeShort: timeShort(now),
		linkType: opts.linkType || defaults.linkType || 'modal',
		linkId: opts.linkId || '',
		url: opts.url || opts.actionUrl || '',
		actionUrl: opts.actionUrl || opts.url || '',
		action: opts.action || '',
		reportId: opts.linkType === 'report' ? (opts.linkId || '') : '',
		contactId: opts.contactId || '',
		statusId: opts.statusId || opts.contactId || '',
		createdAt: new Date(now).toISOString()
	}

	if (!s.messages) s.messages = []
	s.messages.push(msg)
	store.persist()

	logger.info({ uid, type, title: msg.title }, 'message added')
	return msg
}

/**
 * 批量检查：某用户是否有指定类型的未读消息（供角标/红点判断）。
 * @returns {number} 未读数
 */
function unreadCount(uid) {
	const s = store.state()
	const msgs = s.messages || []
	return msgs.filter((m) => m.userId === uid && !m.isRead).length
}

module.exports = { addMessage, unreadCount, VALID_TYPES }
