/**
 * 个人中心服务层
 *
 * 将 pages/profile/* 等页面中直调 apiClient 的 API 调用封装为服务函数，
 * 统一端点、错误处理与数据格式，各页面只需 import 对应函数即可。
 */

import { request } from './apiClient.js'
import {
	appendLocalConversationMessage,
	claimLocalConversation,
	clearLocalConversationView,
	completeLocalConversation,
	createLocalConversation,
	endLocalConversation,
	getLocalConversation,
	inviteLocalConversationAdvisor,
	isLocalConversationAuth,
	listLocalBankTeachers,
	markLocalConversationRead,
	renameLocalConversationGroup,
	submitLocalConversationFeedback
} from './localConversationStore.js'

// ─── 通知偏好 ──────────────────────────────────────────

export function getNotificationSettings() {
	return request({ url: '/api/profile/notification-settings', method: 'GET' })
}

export function saveNotificationSettings(settings) {
	return request({ url: '/api/profile/notification-settings', method: 'POST', data: settings })
}

export function saveSystemPushBinding(binding) {
	return request({ url: '/api/profile/push-binding', method: 'POST', data: binding })
}

export function saveRepaymentSmsConsent(consent = {}) {
	return request({ url: '/api/profile/repayment-sms-consent', method: 'POST', data: consent })
}

// ─── 授权项 ────────────────────────────────────────────

export function getAuthorizationItems() {
	return request({ url: '/api/profile/authorization-items', method: 'GET' })
}

// ─── 债务总览 ──────────────────────────────────────────

export function getDebtSummary(params = {}) {
	return request({ url: '/api/profile/debt-summary', method: 'GET', data: params })
}

export function getDebtExecutionRecords(params = {}) {
	return request({ url: '/api/profile/debt-execution-records', method: 'GET', data: params })
}

export function saveDebtExecutionRecordRemote(record) {
	return request({ url: '/api/profile/debt-execution-record', method: 'POST', data: record })
}

export function syncDebtExecutionRecordsRemote(records = []) {
	return request({ url: '/api/profile/debt-execution-records/sync', method: 'POST', data: { records } })
}

// ─── 银行卡管理 ────────────────────────────────────────

export function getBankCards() {
	return request({ url: '/api/profile/bank-cards', method: 'GET' })
}

export function addBankCard(cardNumber, bankName, cardType) {
	return request({
		url: '/api/profile/bank-cards/add',
		method: 'POST',
		data: { cardNumber, bankName, cardType }
	})
}

export function deleteBankCard(cardId) {
	return request({ url: '/api/profile/bank-cards/delete', method: 'POST', data: { cardId } })
}

// ─── 合同协议 ──────────────────────────────────────────

export function getContracts() {
	return request({ url: '/api/profile/contracts', method: 'GET' })
}

// ─── 优化方案 ──────────────────────────────────────────

export function getOptimizePlans() {
	return request({ url: '/api/optimize/plans', method: 'GET' })
}

// ─── 消息 ──────────────────────────────────────────────

export function getMessageList(type = 'all') {
	return request({ url: '/api/message/list', method: 'POST', data: { type } })
}

export function markMessageRead(messageId) {
	return request({ url: '/api/message/read', method: 'POST', data: { messageId } })
}

export function markAllMessagesRead() {
	return request({ url: '/api/message/read-all', method: 'POST' })
}

export function getUnreadCount() {
	return request({ url: '/api/message/unread-count', method: 'GET' })
}

export function saveMessageActionReceiptRemote(receipt) {
	return request({ url: '/api/message/action-receipt', method: 'POST', data: receipt })
}

// ─── 顾问 ──────────────────────────────────────────────

export function getAdvisorMy() {
	return request({ url: '/api/advisor/my', method: 'GET' })
}

export function getAdvisorContacts() {
	return request({ url: '/api/advisor/contacts', method: 'GET' })
}

export function getBankAdvisorCandidates(contactId = '') {
	if (isLocalConversationAuth()) return Promise.resolve({ list: listLocalBankTeachers() })
	const scopedContactId = String(contactId || '').trim()
	return request({
		url: '/api/advisor/bank-teachers',
		method: 'GET',
		data: scopedContactId ? { contactId: scopedContactId } : {}
	})
}

export function createAdvisorContact(advisorId, reportId, contactType = 'phone', context = {}) {
	const data = { advisorId, reportId, contactType }
	if (context && typeof context === 'object') {
		Object.assign(data, context)
		data.context = context
	}
	if (isLocalConversationAuth()) return Promise.resolve(createLocalConversation(data))
	return request({ url: '/api/advisor/contact', method: 'POST', data })
}

export function resolveAdvisorContactId(payload = {}) {
	if (typeof payload === 'string') return payload
	const source = payload && typeof payload === 'object' ? payload : {}
	const data = source.data && typeof source.data === 'object' ? source.data : {}
	const record = source.record && typeof source.record === 'object' ? source.record : {}
	const dataRecord = data.record && typeof data.record === 'object' ? data.record : {}
	return String(
		source.contactId ||
		source.id ||
		record.contactId ||
		record.id ||
		data.contactId ||
		data.id ||
		dataRecord.contactId ||
		dataRecord.id ||
		''
	).trim()
}

export function openAdvisorConversation(payload) {
	const contactId = resolveAdvisorContactId(payload)
	if (!contactId) throw new Error('会话创建成功但缺少会话编号，请稍后重试')
	const url = `/pages/chat/conversation?contactId=${encodeURIComponent(contactId)}`
	return new Promise((resolve) => {
		uni.navigateTo({
			url,
			success: () => resolve({ ok: true, contactId, url }),
			fail: () => {
				try {
					if (typeof window !== 'undefined' && window.location) {
						window.location.hash = `#${url}`
						resolve({ ok: true, contactId, url, fallback: 'hash' })
						return
					}
				} catch (_) {}
				uni.showToast({ title: '无法打开聊天页', icon: 'none' })
				resolve({ ok: false, contactId, url })
			}
		})
	})
}

export function createCustomerServiceContact(context = {}) {
	const data = {
		...context,
		contactType: 'customer-service',
		channel: 'service',
		deskType: 'service'
	}
	data.context = { ...context, contactType: 'customer-service', channel: 'service', deskType: 'service' }
	if (isLocalConversationAuth()) return Promise.resolve(createLocalConversation(data))
	return request({ url: '/api/advisor/contact', method: 'POST', data })
}

export function getAdvisorContactMessages(contactId) {
	const local = getLocalConversation(contactId)
	if (local) return Promise.resolve(local)
	return request({ url: `/api/advisor/contact/${encodeURIComponent(contactId)}/messages`, method: 'GET' })
}

export function sendAdvisorContactMessage(contactId, content) {
	const local = getLocalConversation(contactId)
	if (local) return Promise.resolve(appendLocalConversationMessage(contactId, content))
	return request({
		url: '/api/advisor/contact/message',
		method: 'POST',
		data: { contactId, content }
	})
}

export function submitAdvisorContactFeedback(contactId, feedback = {}) {
	const local = getLocalConversation(contactId)
	if (local) return Promise.resolve(submitLocalConversationFeedback(contactId, feedback))
	return request({
		url: '/api/advisor/contact/feedback',
		method: 'POST',
		data: { ...feedback, contactId }
	})
}

export function completeAdvisorContact(contactId, payload = {}) {
	const local = getLocalConversation(contactId)
	if (local) return Promise.resolve(completeLocalConversation(contactId, payload))
	return request({
		url: '/api/advisor/contact/complete',
		method: 'POST',
		data: { ...payload, contactId }
	})
}

export function endAdvisorContact(contactId, payload = {}) {
	const local = getLocalConversation(contactId)
	if (local) return Promise.resolve(endLocalConversation(contactId, payload))
	return request({
		url: '/api/advisor/contact/end',
		method: 'POST',
		data: { ...payload, contactId }
	})
}

export function clearAdvisorContactView(contactId) {
	const local = getLocalConversation(contactId)
	if (local) return Promise.resolve(clearLocalConversationView(contactId))
	return request({
		url: '/api/advisor/contact/clear-view',
		method: 'POST',
		data: { contactId }
	})
}

export function inviteAdvisorToContact(contactId, payload = {}) {
	const local = getLocalConversation(contactId)
	if (local) return Promise.resolve(inviteLocalConversationAdvisor(contactId, payload))
	return request({
		url: '/api/advisor/contact/invite-advisor',
		method: 'POST',
		data: { ...payload, contactId }
	})
}

export function renameAdvisorContactGroup(contactId, groupName) {
	const local = getLocalConversation(contactId)
	if (local) return Promise.resolve(renameLocalConversationGroup(contactId, groupName))
	return request({
		url: '/api/advisor/contact/rename',
		method: 'POST',
		data: { contactId, groupName }
	})
}

export function markAdvisorContactRead(contactId) {
	const local = getLocalConversation(contactId)
	if (local) return Promise.resolve(markLocalConversationRead(contactId))
	return request({
		url: '/api/advisor/contact/read',
		method: 'POST',
		data: { contactId }
	})
}

export function claimAdvisorContact(contactId, role = '') {
	const local = claimLocalConversation(contactId, role)
	if (local) return Promise.resolve(local)
	return request({
		url: '/api/advisor/contact/claim',
		method: 'POST',
		data: { contactId, role }
	})
}

export function updateAdvisorContactStatus(contactId, status) {
	return request({ url: '/api/advisor/contact/status', method: 'POST', data: { contactId, status } })
}

export function submitAdvisorContactMaterial(contactId, material = {}, context = {}) {
	const data = { ...context, contactId }
	if (material && typeof material === 'object') Object.assign(data, material)
	return request({ url: '/api/advisor/contact/material-submit', method: 'POST', data })
}

// ─── 客户补充材料：三金、个税、房车资产 ─────────────────────

export function getSupplementMaterials() {
	return request({ url: '/api/profile/supplement-materials', method: 'GET' })
}

export function saveSupplementMaterial(material = {}) {
	return request({ url: '/api/profile/supplement-material', method: 'POST', data: material })
}

export default {
	getNotificationSettings,
	saveNotificationSettings,
	saveSystemPushBinding,
	saveRepaymentSmsConsent,
	getAuthorizationItems,
	getDebtSummary,
	getDebtExecutionRecords,
	saveDebtExecutionRecordRemote,
	syncDebtExecutionRecordsRemote,
	getBankCards,
	addBankCard,
	deleteBankCard,
	getContracts,
	getOptimizePlans,
	getMessageList,
	markMessageRead,
	markAllMessagesRead,
	getUnreadCount,
	saveMessageActionReceiptRemote,
	getAdvisorMy,
	getAdvisorContacts,
	getBankAdvisorCandidates,
	createAdvisorContact,
	createCustomerServiceContact,
	getAdvisorContactMessages,
	sendAdvisorContactMessage,
	submitAdvisorContactFeedback,
	completeAdvisorContact,
	endAdvisorContact,
	clearAdvisorContactView,
	inviteAdvisorToContact,
	renameAdvisorContactGroup,
	markAdvisorContactRead,
	claimAdvisorContact,
	updateAdvisorContactStatus,
	submitAdvisorContactMaterial,
	getSupplementMaterials,
	saveSupplementMaterial
}
