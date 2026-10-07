import { request } from './apiClient.js'
import { getLocalTestRole, listLocalConversations } from './localConversationStore.js'
import { getCachedUserInfo } from './authService.js'

function materialItemsOf(contact = {}) {
	const groups = [
		Array.isArray(contact.materials) ? contact.materials : [],
		Array.isArray(contact.supplementMaterials) ? contact.supplementMaterials : [],
		Array.isArray(contact.requiredMaterials) ? contact.requiredMaterials : []
	]
	return groups.flat().map((item, index) => ({
		...(typeof item === 'string' ? { name: item } : item),
		id: (item && (item.id || item.materialId || item.key)) || `${contact.contactId || contact.id || 'contact'}-${index}`,
		contactId: contact.contactId || contact.id || '',
		customerName: contact.name || contact.clientName || '客户',
		productName: contact.productName || '',
		institution: contact.institution || '',
		statusText: (item && item.statusText) || '待确认'
	}))
}

function buildLocalOverview() {
	const conversations = listLocalConversations('')
	const materials = conversations.flatMap(materialItemsOf)
	const messageCount = conversations.reduce((sum, item) => sum + (Array.isArray(item.messages) ? item.messages.length : 0), 0)
	const customerIds = new Set(conversations.map((item) => item.userId || item.clientId || item.name).filter(Boolean))
	const activeGroups = conversations.filter((item) => item.groupMode === 'service-bank-customer' || item.serviceRequired).length
	const customerDocuments = Array.from(customerIds).map((id) => {
		const rows = conversations.filter((item) => String(item.userId || item.clientId || item.name || '') === String(id))
		const materialRows = materials.filter((item) => rows.some((row) => String(row.contactId || row.id || '') === String(item.contactId || '')))
		const latest = rows.slice().sort((a, b) => String(b.updateTime || b.createdAt || '').localeCompare(String(a.updateTime || a.createdAt || '')))[0] || {}
		return {
			id: `customer-doc-${id}`,
			userId: id,
			name: latest.name || latest.clientName || '客户',
			phone: latest.phone || latest.mobile || '',
			conversationCount: rows.length,
			materialCount: materialRows.length,
			reportCount: 0,
			messageCount: rows.reduce((sum, item) => sum + (Array.isArray(item.messages) ? item.messages.length : 0), 0),
			latestTs: latest.updateTime || latest.updatedAt || latest.createdAt || '',
			conversations: rows,
			materials: materialRows,
			reports: [],
			notes: [],
			latestReport: null
		}
	})
	const cached = getCachedUserInfo() || {}
	return {
		stats: {
			users: customerIds.size,
			conversations: conversations.length,
			materials: materials.length,
			messages: messageCount,
			activeGroups,
			customerDocuments: customerDocuments.length,
			franchiseReportUsers: 1
		},
		conversations,
		materials,
		customerDocuments,
		franchiseReportUsers: [
			{ uid: 'local-dev-franchise', phone: '19600000008', nickname: '加盟商测试号', role: 'user', reportUploadUnlimited: true, franchiseReportUnlimited: true, institution: '测试加盟商' }
		],
		currentAdmin: {
			uid: cached.uid || '',
			phone: cached.mobile || cached.phone || '',
			nickname: cached.nickname || '管理员测试号',
			role: 'admin',
			adminLevel: cached.adminLevel || 'super',
			isSuperAdmin: cached.isSuperAdmin !== false,
			canManageAdmins: cached.isSuperAdmin !== false
		},
		source: 'local-admin-overview'
	}
}

export async function getAdminOverview() {
	if (getLocalTestRole() === 'admin') return buildLocalOverview()
	return request({ url: '/api/admin/overview', method: 'GET' })
}

export async function getAdminRoleGrants() {
	if (getLocalTestRole() === 'admin') {
		return {
			currentAdmin: buildLocalOverview().currentAdmin,
			list: [
				{ uid: 'local-dev-19600000004', phone: '19600000004', nickname: '管理员测试号', role: 'admin', adminLevel: 'super', isSuperAdmin: true, institution: '平台管理后台' },
				{ uid: 'local-dev-19600000003', phone: '19600000003', nickname: '客服测试号', role: 'service', institution: '平台客服中心' }
			]
		}
	}
	return request({ url: '/api/admin/role-grants', method: 'GET' })
}

export async function getFranchiseReportGrants() {
	if (getLocalTestRole() === 'admin') {
		return {
			currentAdmin: buildLocalOverview().currentAdmin,
			list: buildLocalOverview().franchiseReportUsers
		}
	}
	return request({ url: '/api/admin/franchise-report-grants', method: 'GET' })
}

export async function grantFranchiseReport(payload = {}) {
	if (getLocalTestRole() === 'admin') return getFranchiseReportGrants()
	return request({ url: '/api/admin/franchise-report-grant', method: 'POST', data: payload })
}

export async function revokeFranchiseReport(phone) {
	if (getLocalTestRole() === 'admin') return getFranchiseReportGrants()
	return request({ url: `/api/admin/franchise-report-grant?phone=${encodeURIComponent(phone)}`, method: 'DELETE' })
}

export async function grantAdminRole(payload = {}) {
	if (getLocalTestRole() === 'admin') return getAdminRoleGrants()
	return request({ url: '/api/admin/role-grant', method: 'POST', data: payload })
}

export async function revokeAdminRole(phone) {
	if (getLocalTestRole() === 'admin') return getAdminRoleGrants()
	return request({ url: `/api/admin/role-grant?phone=${encodeURIComponent(phone)}`, method: 'DELETE' })
}

export default {
	getAdminOverview,
	getAdminRoleGrants,
	getFranchiseReportGrants,
	grantFranchiseReport,
	revokeFranchiseReport,
	grantAdminRole,
	revokeAdminRole
}
