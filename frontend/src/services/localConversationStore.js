import { getCachedUserInfo, getUserId, resolveAuthToken } from './authService.js'

const LOCAL_CONVERSATION_KEY = 'rpt_local_test_conversations'

const LOCAL_TEST_PROFILES = {
	'19600000001': { role: 'user', nickname: '客户测试号', institution: '' },
	'19600000002': { role: 'advisor', nickname: '示例银行A经理测试号', institution: '示例银行A' },
	'19600000003': { role: 'service', nickname: '客服测试号', institution: '平台客服中心' },
	'19600000004': { role: 'admin', nickname: '管理员测试号', institution: '平台管理后台' },
	'19600000005': { role: 'advisor', nickname: '示例银行B经理测试号', institution: '示例银行B' },
	'19600000006': { role: 'advisor', nickname: '示例惠想消费金融经理测试号', institution: '示例惠想消费金融' }
}

const SEED_CONVERSATIONS = [
	{
		id: 'local-contact-001',
		contactId: 'local-contact-001',
		clientId: 'local-client-001',
		clientUid: 'demo-client-zhang-001',
		userId: 'local-dev-19600000001',
			channel: 'bank',
			deskType: 'bank',
			contactType: 'match-product',
			groupMode: 'service-bank-customer',
			serviceRequired: true,
			serviceStatus: 'open',
			advisorStatus: 'open',
			status: 'pending',
			statusText: '待处理',
			name: '张先生',
		phone: '138****2608',
		time: '今天 10:28',
		productName: '臻享信用贷E07',
		institution: '示例银行A',
		rateText: '年化 3.85% 起',
			amountText: '最高 50 万',
			termText: '最长 60 期',
			matchRate: 86,
			summary: '征信评分较好，已补充公积金账单，待确认收入流水。',
			materials: [
				{ id: 'fund', name: '公积金账单', statusText: '待确认', fileName: 'fund-bill.png' },
				{ id: 'tax', name: '个税截图', statusText: '待确认', fileName: 'tax-proof.png' }
			],
			messages: [{ id: 'local-msg-bank-001', senderType: 'user', senderRole: 'user', senderId: 'local-dev-19600000001', senderName: '客户测试号', content: '我想咨询这个产品的准入条件。', createdAt: '2026-07-07T02:28:00.000Z' }]
		},
	{
		id: 'local-contact-002',
		contactId: 'local-contact-002',
		clientId: 'local-client-002',
		clientUid: 'demo-client-li-002',
		userId: 'local-dev-19600000001',
			channel: 'bank',
			deskType: 'bank',
			contactType: 'match-product',
			groupMode: 'service-bank-customer',
			serviceRequired: true,
			serviceStatus: 'open',
			advisorStatus: 'open',
			status: 'processing',
			statusText: '处理中',
		name: '李女士',
		phone: '139****0716',
		time: '昨天 16:42',
		productName: '家装消费贷E18',
		institution: '示例惠想消费金融',
		rateText: '按审批浮动',
			amountText: '以审批为准',
			termText: '最长 36 期',
			matchRate: 74,
			summary: '近期查询偏多，建议先补充个税截图和社保记录后再确认方案。',
			materials: [
				{ id: 'tax', name: '个税截图', statusText: '待确认', fileName: 'tax.png' },
				{ id: 'social', name: '社保记录', statusText: '待补充' }
			],
			messages: [{ id: 'local-msg-bank-002', senderType: 'user', senderRole: 'user', senderId: 'local-dev-19600000001', senderName: '客户测试号', content: '我已经上传了个税截图，麻烦看一下。', createdAt: '2026-07-06T08:42:00.000Z' }]
		},
		{
			id: 'local-contact-003',
			contactId: 'local-contact-003',
			clientId: 'local-client-003',
			clientUid: 'demo-client-zhou-003',
			userId: 'local-dev-19600000001',
			channel: 'bank',
			deskType: 'bank',
			contactType: 'match-product',
			groupMode: 'service-bank-customer',
			serviceRequired: true,
			serviceStatus: 'open',
			advisorStatus: 'open',
			status: 'pending',
			statusText: '待处理',
			name: '周先生',
			phone: '135****6309',
			time: '今天 09:18',
			productName: '臻享信用贷E05',
			institution: '示例银行B',
			rateText: '年化 3.45% 起',
			amountText: '最高 30 万',
			termText: '最长 36 期',
			matchRate: 82,
			summary: '稳定代发工资，信用记录正常，待补充近 6 个月工资流水。',
			materials: [
				{ id: 'payroll', name: '工资流水', statusText: '待补充' },
				{ id: 'asset', name: '房产证明', statusText: '待确认', fileName: 'house.png' }
			],
			messages: [{ id: 'local-msg-bank-003', senderType: 'user', senderRole: 'user', senderId: 'local-dev-19600000001', senderName: '客户测试号', content: '我想了解示例银行B这个方案能不能做。', createdAt: '2026-07-07T01:18:00.000Z' }]
		},
	{
		id: 'local-service-contact-001',
		contactId: 'local-service-contact-001',
		clientId: 'local-service-client-001',
		clientUid: 'demo-client-wang-001',
		userId: 'local-dev-19600000001',
		channel: 'service',
		deskType: 'service',
		contactType: 'customer-service',
		status: 'pending',
		statusText: '待回复',
		name: '王先生',
		phone: '137****8126',
		time: '今天 11:06',
		summary: '上传信用报告后提示网络连接失败，需要客服协助确认入口。',
		messages: [{ id: 'local-msg-service-001', senderType: 'user', senderRole: 'user', senderId: 'local-dev-19600000001', senderName: '客户测试号', content: '上传信用报告显示网络连接失败，可以帮我看一下吗？', createdAt: '2026-07-07T03:06:00.000Z' }]
	},
	{
		id: 'local-service-contact-003',
		contactId: 'local-service-contact-003',
		clientId: 'local-service-client-001',
		clientUid: 'demo-client-wang-001',
		userId: 'local-dev-19600000001',
		channel: 'service',
		deskType: 'service',
		contactType: 'customer-service',
		contactIntent: 'debt-optimization',
		businessName: '债务优化',
		status: 'pending',
		statusText: '待回复',
		name: '王先生',
		phone: '137****8126',
		time: '今天 10:51',
		summary: '客户补充询问债务优化材料清单。',
		messages: [
			{ id: 'local-msg-service-003-a', senderType: 'user', senderRole: 'user', senderId: 'local-dev-19600000001', senderName: '客户测试号', content: '债务优化需要先准备哪些材料？', createdAt: '2026-07-07T02:49:00.000Z' },
			{ id: 'local-msg-service-003-b', senderType: 'service', senderRole: 'service', senderId: 'local-dev-19600000003', senderName: '客服测试号', content: '可以先准备征信报告和现有负债账单。', createdAt: '2026-07-07T02:50:00.000Z' },
			{ id: 'local-msg-service-003-c', senderType: 'user', senderRole: 'user', senderId: 'local-dev-19600000001', senderName: '客户测试号', content: '好的，我先整理后再上传。', createdAt: '2026-07-07T02:51:00.000Z' }
		]
	},
	{
		id: 'local-service-contact-002',
		contactId: 'local-service-contact-002',
		clientId: 'local-service-client-002',
		clientUid: 'demo-client-chen-002',
		userId: 'local-dev-19600000001',
		channel: 'service',
		deskType: 'service',
		contactType: 'customer-service',
		status: 'processing',
		statusText: '处理中',
		name: '陈女士',
		phone: '136****0972',
		time: '昨天 18:20',
		summary: '客户询问测试账号登录和补充材料上传方式。',
		messages: [{ id: 'local-msg-service-002', senderType: 'user', senderRole: 'user', senderId: 'local-dev-19600000001', senderName: '客户测试号', content: '我想确认三金账单截图上传后在哪里看进度。', createdAt: '2026-07-06T10:20:00.000Z' }]
	}
]

const clone = (value) => JSON.parse(JSON.stringify(value || null))

function storageGet(key) {
	try { return uni.getStorageSync(key) } catch (_) { return '' }
}

function storageSet(key, value) {
	try { uni.setStorageSync(key, value) } catch (_) {}
}

function readStoredConversations() {
	const raw = storageGet(LOCAL_CONVERSATION_KEY)
	if (!raw) return []
	if (Array.isArray(raw)) return raw
	try {
		const parsed = JSON.parse(raw)
		return Array.isArray(parsed) ? parsed : []
	} catch (_) {
		return []
	}
}

function writeStoredConversations(list = []) {
	storageSet(LOCAL_CONVERSATION_KEY, JSON.stringify(list))
}

function firstNonEmpty(...values) {
	for (const value of values) {
		if (value !== undefined && value !== null && String(value).trim()) return String(value).trim()
	}
	return ''
}

function avatarOf(...values) {
	for (const value of values) {
		const item = value && typeof value === 'object' ? value : {}
		const avatar = firstNonEmpty(
			item.avatar,
			item.avatarUrl,
			item.avatar_url,
			item.headImage,
			item.headImg,
			item.head_image,
			item.profileImage,
			item.profilePhoto,
			item.portrait
		)
		if (avatar) return avatar
	}
	return ''
}

function nowIso() {
	return new Date().toISOString()
}

function contactIdOf(item = {}) {
	return firstNonEmpty(item.contactId, item.id, item._id)
}

function channelOf(input = {}) {
	const raw = firstNonEmpty(input.channel, input.deskType, input.serviceChannel).toLowerCase()
	if (raw === 'service' || raw === 'support' || raw === 'customer-service') return 'service'
	if (raw === 'bank' || raw === 'advisor' || raw === 'manager') return 'bank'
	if (input.contactType === 'customer-service') return 'service'
	return 'bank'
}

function mergedConversations() {
	const map = new Map()
	SEED_CONVERSATIONS.forEach((item) => map.set(contactIdOf(item), clone(item)))
	readStoredConversations().forEach((item) => {
		const id = contactIdOf(item)
		if (id) map.set(id, { ...(map.get(id) || {}), ...clone(item) })
	})
	return [...map.values()]
}

function isLocalDevToken() {
	return String(resolveAuthToken() || '').startsWith('local-dev-token-')
}

function userRole() {
	if (!isLocalDevToken()) return ''
	const token = String(resolveAuthToken() || '')
	const match = token.match(/local-dev-token-(196000000\d{2})-/)
	if (match && LOCAL_TEST_PROFILES[match[1]]) return LOCAL_TEST_PROFILES[match[1]].role
	const user = getCachedUserInfo() || {}
	const mobile = String(user.mobile || user.phone || '').trim()
	if (LOCAL_TEST_PROFILES[mobile]) return LOCAL_TEST_PROFILES[mobile].role
	return ''
}

function userProfile() {
	if (!isLocalDevToken()) return null
	const token = String(resolveAuthToken() || '')
	const match = token.match(/local-dev-token-(196000000\d{2})-/)
	if (match && LOCAL_TEST_PROFILES[match[1]]) return LOCAL_TEST_PROFILES[match[1]]
	const user = getCachedUserInfo() || {}
	const mobile = String(user.mobile || user.phone || '').trim()
	if (LOCAL_TEST_PROFILES[mobile]) return LOCAL_TEST_PROFILES[mobile]
	return null
}

function normalizedInstitution(value = '') {
	return String(value || '').replace(/\s+/g, '').replace(/股份有限公司|有限责任公司|有限公司/g, '').trim()
}

function contactInstitutionOf(item = {}) {
	return firstNonEmpty(item.institution, item.productInstitution, item.bankName, item.product && item.product.institution, item.advisorInfo && item.advisorInfo.bank)
}

function institutionMatches(item = {}) {
	const staffInstitution = normalizedInstitution(getLocalActorInstitution())
	const contactInstitution = normalizedInstitution(contactInstitutionOf(item))
	if (!staffInstitution || !contactInstitution) return true
	return contactInstitution === staffInstitution || contactInstitution.includes(staffInstitution) || staffInstitution.includes(contactInstitution)
}

function isBankServiceGroup(item = {}) {
	return channelOf(item) === 'bank' && (item.serviceRequired === true || item.groupMode === 'service-bank-customer' || item.contactType === 'match-product')
}

function isAssignedToCurrentActor(item = {}, role = userRole()) {
	const uid = getUserId()
	if (!uid) return false
	if (role === 'service') return String(item.serviceAssigneeId || '') === String(uid)
	if (role === 'advisor') return String(item.advisorAssigneeId || '') === String(uid)
	return false
}

function materialVisibleForRole(item = {}, role = userRole()) {
	if (role === 'admin') return true
	if (role === 'user') return String(item.userId || '') === String(getUserId() || '')
	if (role === 'service') return (channelOf(item) === 'service' || isBankServiceGroup(item)) && isAssignedToCurrentActor(item, 'service')
	if (role === 'advisor') return channelOf(item) === 'bank' && institutionMatches(item) && isAssignedToCurrentActor(item, 'advisor')
	return false
}

function redactMaterialFields(item = {}) {
	const materialCount = [
		Array.isArray(item.materials) ? item.materials.length : 0,
		Array.isArray(item.supplementMaterials) ? item.supplementMaterials.length : 0,
		Array.isArray(item.requiredMaterials) ? item.requiredMaterials.length : 0
	].reduce((sum, n) => sum + n, 0)
	return {
		...item,
		materialAccess: false,
		materialsRedacted: materialCount > 0,
		materialCount,
		materials: [],
		supplementMaterials: [],
		requiredMaterials: [],
		materialAccessText: materialCount > 0 ? '接单后可查看客户资料' : '暂无客户资料'
	}
}

function decorateForCurrentRole(item = {}) {
	const role = userRole()
	const visibleMessages = visibleMessagesForCurrentRole(item)
	const unreadCount = unreadCountForCurrentRole(item, visibleMessages)
	const base = {
		...item,
		channel: channelOf(item),
		deskType: channelOf(item),
		isGroupChat: isBankServiceGroup(item),
		serviceRequired: item.serviceRequired === true || isBankServiceGroup(item),
		materialAccess: materialVisibleForRole(item, role),
		messages: visibleMessages,
		totalMessageCount: Array.isArray(item.messages) ? item.messages.length : 0,
		visibleMessageCount: visibleMessages.length,
		unreadCount,
		hasUnread: unreadCount > 0
	}
	return base.materialAccess ? base : redactMaterialFields(base)
}

function visibleMessagesForCurrentRole(contact = {}) {
	const role = userRole()
	const messages = Array.isArray(contact.messages) ? contact.messages : []
	if (role === 'admin') return messages
	if (role === 'user' && contact.customerChatClosed === true) return []
	const actorId = getUserId() || role
	const clears = Array.isArray(contact.chatClears) ? contact.chatClears : []
	const latestClear = clears
		.filter((item) => item.actorRole === role && String(item.actorId || '') === String(actorId))
		.map((item) => new Date(item.clearedAt || 0).getTime())
		.filter((ts) => Number.isFinite(ts))
		.sort((a, b) => b - a)[0]
	if (!latestClear) return messages
	return messages.filter((message) => {
		const ts = new Date(message.createdAt || message.updateTime || 0).getTime()
		return Number.isFinite(ts) && ts > latestClear
	})
}

function latestClearTsForCurrentRole(contact = {}) {
	const role = userRole()
	const actorId = getUserId() || role
	const clears = Array.isArray(contact.chatClears) ? contact.chatClears : []
	return clears
		.filter((item) => item.actorRole === role && String(item.actorId || '') === String(actorId))
		.map((item) => new Date(item.clearedAt || 0).getTime())
		.filter((ts) => Number.isFinite(ts))
		.sort((a, b) => b - a)[0] || 0
}

function shouldHideForCurrentRole(contact = {}) {
	const role = userRole()
	if (role === 'admin') return false
	if (role === 'user' && contact.customerChatClosed === true) return true
	const latestClear = latestClearTsForCurrentRole(contact)
	if (!latestClear) return false
	const actorId = getUserId() || role
	const ownInfo = senderInfoForRole(role)
	const messages = Array.isArray(contact.messages) ? contact.messages : []
	const hasIncomingAfterClear = messages.some((message) => {
		if (!message || message.senderType === 'system') return false
		if (message.senderType === ownInfo.senderType) return false
		if (actorId && message.senderId && String(message.senderId) === String(actorId)) return false
		const ts = new Date(message.createdAt || message.updateTime || 0).getTime()
		return Number.isFinite(ts) && ts > latestClear
	})
	return !hasIncomingAfterClear
}

function canReadLocalContact(item = {}) {
	const role = userRole()
	if (!role) return false
	const channel = channelOf(item)
	if (role === 'admin') return true
	if (role === 'advisor') return channel === 'bank' && institutionMatches(item) && (!item.advisorAssigneeId || isAssignedToCurrentActor(item, 'advisor'))
	if (role === 'service') return (channel === 'service' || isBankServiceGroup(item)) && (!item.serviceAssigneeId || isAssignedToCurrentActor(item, 'service'))
	return String(item.userId || '') === String(getUserId() || '')
}

function senderTypeForRole(role = userRole()) {
	if (role === 'advisor') return 'bank'
	if (role === 'service') return 'service'
	if (role === 'admin') return 'admin'
	return 'user'
}

function readStateForCurrentRole(contact = {}) {
	const role = userRole()
	const actorId = getUserId() || role
	const states = Array.isArray(contact.chatReadStates) ? contact.chatReadStates : []
	return states.find((item) => item.actorRole === role && String(item.actorId || '') === String(actorId)) || null
}

function unreadCountForCurrentRole(contact = {}, visibleMessages = null) {
	const role = userRole()
	if (!role || role === 'admin') return 0
	if (role === 'user' && contact.customerChatClosed === true) return 0
	const actorId = getUserId() || role
	const ownType = senderTypeForRole(role)
	const read = readStateForCurrentRole(contact)
	const lastReadTs = new Date((read && read.readAt) || 0).getTime() || 0
	const messages = Array.isArray(visibleMessages) ? visibleMessages : visibleMessagesForCurrentRole(contact)
	return messages.filter((message) => {
		if (!message || message.senderType === 'system') return false
		if (message.senderType === ownType) return false
		if (message.senderId && String(message.senderId) === String(actorId)) return false
		const ts = new Date(message.createdAt || message.updateTime || 0).getTime()
		return Number.isFinite(ts) && ts > lastReadTs
	}).length
}

function markLocalReadForCurrentRole(contact = {}, readAt = nowIso()) {
	const role = userRole()
	const actorId = getUserId() || role
	if (!actorId) return null
	const states = Array.isArray(contact.chatReadStates) ? contact.chatReadStates : []
	const current = states.find((item) => item.actorRole === role && String(item.actorId || '') === String(actorId))
	const patch = { actorId, actorRole: role, readAt, updatedAt: nowIso() }
	if (current) Object.assign(current, patch)
	else states.push(patch)
	contact.chatReadStates = states
	return patch
}

function senderInfoForRole(role) {
	if (role === 'advisor') return { senderType: 'bank', senderRole: 'advisor', senderName: '银行客户经理' }
	if (role === 'service') return { senderType: 'service', senderRole: 'service', senderName: '客服' }
	if (role === 'admin') return { senderType: 'admin', senderRole: 'admin', senderName: '管理员' }
	const user = getCachedUserInfo() || {}
	return { senderType: 'user', senderRole: 'user', senderName: user.nickname || '客户测试号' }
}

function extractMentions(text = '') {
	const source = String(text || '')
	const hits = []
	const add = (role, label) => {
		if (!hits.some((item) => item.role === role)) hits.push({ role, label })
	}
	if (/@(客服|在线客服)/.test(source)) add('service', '客服')
	if (/@(银行老师|银行经理|客户经理)/.test(source)) add('advisor', '银行老师')
	if (/@(管理员|平台|监控)/.test(source)) add('admin', '管理员')
	if (/@(客户|用户)/.test(source)) add('user', '客户')
	return hits
}

function appendSystemMessage(record = {}, content = '', extra = {}) {
	const message = {
		id: `local-system-${Date.now()}`,
		contactId: contactIdOf(record),
		userId: record.userId || 'local-dev-19600000001',
		channel: channelOf(record),
		senderType: 'system',
		senderRole: 'system',
		senderId: 'system',
		senderName: '系统',
		content,
		createdAt: nowIso(),
		...extra
	}
	return message
}

function upsertStoredConversation(record) {
	const id = contactIdOf(record)
	if (!id) return
	const list = readStoredConversations()
	const index = list.findIndex((item) => contactIdOf(item) === id)
	if (index >= 0) list[index] = record
	else list.unshift(record)
	writeStoredConversations(list)
}

function reusableLocalValue(value = '') {
	return String(value || '').replace(/\s+/g, '').trim().toLowerCase()
}

function reusableLocalContactMatches(input = {}, item = {}) {
	if (!item || item.customerChatClosed === true) return false
	if (String(item.userId || '') !== String(input.userId || '')) return false
	if (['completed', 'done', 'resolved'].includes(String(item.status || '').toLowerCase())) return false
	if (channelOf(item) !== input.channel) return false
	if (String(item.contactType || '') !== String(input.contactType || '')) return false
	const reportId = reusableLocalValue(input.reportId)
	const itemReportId = reusableLocalValue(firstNonEmpty(item.reportId, item.sourceReportId, item.context && item.context.reportId))
	if (reportId && itemReportId !== reportId) return false
	const intent = reusableLocalValue(input.contactIntent)
	const itemIntent = reusableLocalValue(firstNonEmpty(item.contactIntent, item.context && item.context.contactIntent))
	if (intent && itemIntent && intent !== itemIntent) return false
	if (input.contactType === 'match-product') {
		const productId = reusableLocalValue(firstNonEmpty(item.productId, item.product && item.product.id))
		const productName = reusableLocalValue(firstNonEmpty(item.productName, item.product && item.product.name))
		const institution = normalizedInstitution(contactInstitutionOf(item))
		if (input.productId && productId && productId !== input.productId) return false
		if (!input.productId && input.productName && productName !== input.productName) return false
		if (input.institution && institution && normalizedInstitution(input.institution) !== institution) return false
	}
	return !!(reportId || intent || input.productId || input.productName)
}

export function isLocalConversationAuth() {
	return !!userRole()
}

export function getLocalTestRole() {
	return userRole()
}

export function getLocalActorInstitution() {
	const profile = userProfile()
	return profile && profile.institution ? profile.institution : ''
}

export function getLocalTestProfile() {
	return clone(userProfile())
}

export function listLocalConversations(port = '') {
	if (!isLocalConversationAuth()) return []
	const target = String(port || '').trim()
	return mergedConversations()
		.filter((item) => {
			if (!canReadLocalContact(item)) return false
			if (shouldHideForCurrentRole(item)) return false
			if (!target) return true
			if (target === 'service') return channelOf(item) === 'service' || isBankServiceGroup(item)
			if (target === 'bank') return channelOf(item) === 'bank'
			return channelOf(item) === target
		})
		.map((item) => clone(decorateForCurrentRole(item)))
}

export function getLocalConversation(contactId) {
	if (!isLocalConversationAuth()) return null
	const id = String(contactId || '')
	const contact = mergedConversations().find((item) => contactIdOf(item) === id)
	if (!contact || !canReadLocalContact(contact)) return null
	if (shouldHideForCurrentRole(contact)) return null
	markLocalReadForCurrentRole(contact)
	upsertStoredConversation(contact)
	return {
		contact: clone(decorateForCurrentRole(contact)),
		messages: clone(visibleMessagesForCurrentRole(contact))
	}
}

export function createLocalConversation(input = {}) {
	if (!isLocalConversationAuth()) return null
	const channel = channelOf(input)
	const createdAt = nowIso()
	const userId = getUserId() || 'local-dev-19600000001'
	const user = getCachedUserInfo() || {}
	const customerAvatar = avatarOf(user, input, input.user, input.client, input.context)
	const contactType = input.contactType || (channel === 'service' ? 'customer-service' : 'appointment')
	const source = firstNonEmpty(input.source, input.contactSource, input.entrySource, input.context && input.context.source)
	const contactIntent = firstNonEmpty(input.contactIntent, input.consultIntent, input.businessIntent, input.intent, input.context && input.context.contactIntent)
	const businessType = firstNonEmpty(input.businessType, input.serviceType, input.businessCode, input.context && input.context.businessType)
	const serviceType = firstNonEmpty(input.serviceType, input.businessType, input.serviceCode, input.context && input.context.serviceType)
	const businessName = firstNonEmpty(
		input.businessName,
		input.serviceName,
		input.businessLabel,
		input.context && input.context.businessName
	)
	const reusable = mergedConversations()
		.filter((item) => reusableLocalContactMatches({
			userId,
			channel,
			contactType,
			reportId: firstNonEmpty(input.reportId),
			contactIntent: firstNonEmpty(input.contactIntent),
			productId: reusableLocalValue(firstNonEmpty(input.productId, input.product && input.product.id)),
			productName: reusableLocalValue(firstNonEmpty(input.productName, input.product && input.product.name)),
			institution: firstNonEmpty(input.institution, input.product && input.product.institution)
		}, item))
		.sort((a, b) => String(b.updateTime || b.updatedAt || b.createdAt || '').localeCompare(String(a.updateTime || a.updatedAt || a.createdAt || '')))[0]
	if (reusable) {
		const next = {
			...reusable,
			clientUid: firstNonEmpty(reusable.clientUid, reusable.userId, userId),
			avatar: avatarOf(reusable) || customerAvatar,
			source: firstNonEmpty(reusable.source, source),
			contactIntent: firstNonEmpty(reusable.contactIntent, contactIntent),
			businessType: firstNonEmpty(reusable.businessType, businessType),
			serviceType: firstNonEmpty(reusable.serviceType, serviceType),
			businessName: firstNonEmpty(reusable.businessName, businessName),
			lastReusedAt: createdAt,
			updateTime: createdAt,
			updatedAt: createdAt
		}
		upsertStoredConversation(next)
		return { ok: true, reused: true, contactId: contactIdOf(next), id: contactIdOf(next), record: clone(decorateForCurrentRole(next)) }
	}
	const id = `local-${channel}-contact-${Date.now()}`
	const customerName = firstNonEmpty(input.clientName, input.name, input.userName, user.nickname, user.realName, user.userName, user.mobile ? `用户${String(user.mobile).slice(-4)}` : '客户')
	const customerPhone = firstNonEmpty(input.phone, input.mobile, user.mobile, user.phone)
	const initialContent = firstNonEmpty(input.initialMessage, input.message, input.question, input.summary)
	const record = {
		...input,
		id,
		_id: id,
		contactId: id,
		clientId: userId,
		clientUid: userId,
		userId,
			name: customerName,
			clientName: customerName,
			userName: customerName,
			phone: customerPhone,
			mobile: customerPhone,
			avatar: customerAvatar,
			channel,
			deskType: channel,
			contactType,
			source,
			contactIntent,
			businessType,
			serviceType,
			businessName,
			groupMode: channel === 'bank' && input.contactType === 'match-product' ? 'service-bank-customer' : input.groupMode,
			serviceRequired: channel === 'bank' && input.contactType === 'match-product' ? true : input.serviceRequired === true,
			serviceStatus: channel === 'bank' && input.contactType === 'match-product' ? 'open' : input.serviceStatus,
			advisorStatus: channel === 'bank' && input.contactType === 'match-product' ? 'open' : input.advisorStatus,
			institution: firstNonEmpty(input.institution, input.product && input.product.institution, input.context && input.context.institution),
			status: 'pending',
			statusText: channel === 'service' ? '待回复' : '待处理',
		createTime: createdAt,
		createdAt,
		updateTime: createdAt,
		updatedAt: createdAt,
		messages: []
	}
	if (initialContent) {
		record.messages.push({
			id: `local-msg-${Date.now()}`,
			contactId: id,
			userId,
			channel,
			senderType: 'user',
			senderRole: 'user',
			senderId: userId,
			senderName: customerName || '客户测试号',
			content: initialContent,
			createdAt
		})
	}
	upsertStoredConversation(record)
	return { ok: true, contactId: id, id, record: clone(record) }
}

export function claimLocalConversation(contactId, requestedRole = '') {
	if (!isLocalConversationAuth()) return null
	const id = String(contactId || '')
	const current = mergedConversations().find((item) => contactIdOf(item) === id)
	if (!current || !canReadLocalContact(current)) return null
	const actualRole = userRole()
	const role = actualRole === 'admin' && requestedRole ? requestedRole : actualRole
	if (!['advisor', 'service'].includes(role)) throw new Error('当前账号不能接单')
	const channel = channelOf(current)
	if (role === 'advisor' && (channel !== 'bank' || !institutionMatches(current))) throw new Error('只能接入本机构匹配客户')
	if (role === 'service' && channel === 'bank' && !isBankServiceGroup(current)) throw new Error('该会话不需要客服接单')
	const uid = getUserId() || role
	const profile = userProfile() || {}
	const assigneeName = profile.nickname || senderInfoForRole(role).senderName
	if (role === 'advisor' && current.advisorAssigneeId && String(current.advisorAssigneeId) !== String(uid)) throw new Error('该客户已由其他银行经理接单')
	if (role === 'service' && current.serviceAssigneeId && String(current.serviceAssigneeId) !== String(uid)) throw new Error('该客户已由其他客服接单')
	const claimedAt = nowIso()
	const patch = role === 'advisor'
		? { advisorStatus: 'assigned', advisorAssigneeId: uid, advisorAssigneeName: assigneeName, advisorAssignedAt: claimedAt }
		: { serviceStatus: 'assigned', serviceAssigneeId: uid, serviceAssigneeName: assigneeName, serviceAssignedAt: claimedAt }
	const systemMessage = {
		id: `local-system-${Date.now()}`,
		contactId: contactIdOf(current),
		userId: current.userId || 'local-dev-19600000001',
		channel,
		senderType: 'system',
		senderRole: 'system',
		senderId: 'system',
		senderName: '系统',
		content: role === 'advisor' ? `${assigneeName}已接入本机构客户咨询。` : `${assigneeName}已接单，可查看授权资料并协助沟通。`,
		createdAt: claimedAt
	}
	const next = {
		...current,
		...patch,
		status: current.status === 'pending' ? 'processing' : current.status,
		statusText: current.status === 'pending' ? '处理中' : current.statusText,
		updateTime: claimedAt,
		updatedAt: claimedAt,
		messages: [...(Array.isArray(current.messages) ? current.messages : []), systemMessage]
	}
	upsertStoredConversation(next)
	return { ok: true, contactId: contactIdOf(next), contact: clone(decorateForCurrentRole(next)), message: clone(systemMessage) }
}

export function appendLocalConversationMessage(contactId, content) {
	const current = getLocalConversation(contactId)
	if (!current) return null
	const rawContact = mergedConversations().find((item) => contactIdOf(item) === String(contactId || '')) || current.contact
	const role = userRole()
	const channel = channelOf(rawContact)
	if (role === 'advisor' && channel !== 'bank') throw new Error('银行经理不能回复客服会话')
	if (role === 'advisor' && rawContact.serviceRequired && !isAssignedToCurrentActor(rawContact, 'advisor')) throw new Error('请先接单后再回复客户')
	if (role === 'service' && channel === 'bank' && !rawContact.serviceRequired) throw new Error('客服不能回复非三方产品咨询')
	if (role === 'service' && !isAssignedToCurrentActor(rawContact, 'service')) throw new Error('请先接单后再回复客户')
	if (role === 'service' && channel !== 'service' && channel !== 'bank') throw new Error('客服不能回复该会话')
	if (role === 'admin') {
		// 管理员可在测试环境中留痕说明，但生产侧仍由后端鉴权约束。
	}
	const text = String(content || '').trim()
	if (!text) throw new Error('消息内容不能为空')
	const info = senderInfoForRole(role)
	const message = {
		id: `local-msg-${Date.now()}`,
		contactId: contactIdOf(rawContact),
		userId: rawContact.userId || 'local-dev-19600000001',
		channel,
		...info,
		senderId: getUserId() || info.senderRole,
		content: text,
		createdAt: nowIso()
	}
	const mentions = extractMentions(text)
	if (mentions.length) message.mentions = mentions
	const next = {
		...rawContact,
		status: rawContact.status === 'pending' ? 'processing' : rawContact.status,
		statusText: rawContact.status === 'pending' ? '处理中' : rawContact.statusText,
		updateTime: message.createdAt,
		updatedAt: message.createdAt,
		messages: [...(Array.isArray(rawContact.messages) ? rawContact.messages : []), message]
	}
	markLocalReadForCurrentRole(next, message.createdAt)
	upsertStoredConversation(next)
	return { ok: true, contactId: contactIdOf(next), message: clone(message) }
}

export function markLocalConversationRead(contactId) {
	const current = getLocalConversation(contactId)
	if (!current) return null
	const next = mergedConversations().find((item) => contactIdOf(item) === String(contactId || ''))
	if (!next) return null
	const readState = markLocalReadForCurrentRole(next)
	upsertStoredConversation(next)
	return { ok: true, contactId: contactIdOf(next), unreadCount: 0, readState, contact: clone(decorateForCurrentRole(next)) }
}

export function submitLocalConversationFeedback(contactId, feedback = {}) {
	const current = getLocalConversation(contactId)
	if (!current) return null
	const rawContact = mergedConversations().find((item) => contactIdOf(item) === String(contactId || '')) || current.contact
	const role = userRole()
	if (role !== 'user') throw new Error('仅客户本人可评价服务')
	const rating = Math.max(1, Math.min(5, Math.round(Number(feedback.rating || feedback.score || 0))))
	if (!rating) throw new Error('请选择评分')
	const content = firstNonEmpty(feedback.content, feedback.comment, feedback.feedback)
	const createdAt = nowIso()
	const item = {
		id: `local-feedback-${Date.now()}`,
		contactId: contactIdOf(rawContact),
		userId: rawContact.userId || 'local-dev-19600000001',
		rating,
		score: rating,
		content,
		createdAt
	}
	const systemMessage = appendSystemMessage(rawContact, `客户提交服务评价：${rating}分${content ? `，${content}` : ''}`, { eventType: 'service-feedback', feedbackId: item.id, createdAt })
	const next = {
		...rawContact,
		serviceFeedbacks: [item, ...(Array.isArray(rawContact.serviceFeedbacks) ? rawContact.serviceFeedbacks : [])],
		latestFeedback: item,
		feedbackCount: Number(rawContact.feedbackCount || 0) + 1,
		updateTime: createdAt,
		updatedAt: createdAt,
		messages: [...(Array.isArray(rawContact.messages) ? rawContact.messages : []), systemMessage]
	}
	upsertStoredConversation(next)
	return { ok: true, contactId: contactIdOf(next), feedback: clone(item), contact: clone(decorateForCurrentRole(next)) }
}

export function completeLocalConversation(contactId, payload = {}) {
	const current = getLocalConversation(contactId)
	if (!current) return null
	const rawContact = mergedConversations().find((item) => contactIdOf(item) === String(contactId || '')) || current.contact
	const role = userRole()
	const info = senderInfoForRole(role)
	const createdAt = nowIso()
	const note = firstNonEmpty(payload.note, payload.remark, payload.content)
	const completion = {
		id: `local-done-${Date.now()}`,
		contactId: contactIdOf(rawContact),
		userId: rawContact.userId || 'local-dev-19600000001',
		completedById: getUserId() || role,
		completedByRole: role,
		completedByName: info.senderName,
		note,
		createdAt
	}
	const content = role === 'user' ? '客户确认愿意办理，订单已完成。' : `${info.senderName}标记服务完成。`
	const systemMessage = appendSystemMessage(rawContact, note ? `${content}说明：${note}` : content, { eventType: 'service-completed', completionId: completion.id, createdAt })
	const next = {
		...rawContact,
		status: 'completed',
		statusText: '已完成',
		orderStatus: 'completed',
		completedAt: createdAt,
		completedById: completion.completedById,
		completedByRole: completion.completedByRole,
		completedByName: completion.completedByName,
		serviceCompletedAt: rawContact.serviceAssigneeId ? createdAt : rawContact.serviceCompletedAt,
		advisorCompletedAt: rawContact.advisorAssigneeId ? createdAt : rawContact.advisorCompletedAt,
		completionRecords: [completion, ...(Array.isArray(rawContact.completionRecords) ? rawContact.completionRecords : [])],
		latestCompletion: completion,
		completionCount: Number(rawContact.completionCount || 0) + 1,
		updateTime: createdAt,
		updatedAt: createdAt,
		messages: [...(Array.isArray(rawContact.messages) ? rawContact.messages : []), systemMessage]
	}
	upsertStoredConversation(next)
	return { ok: true, contactId: contactIdOf(next), completion: clone(completion), contact: clone(decorateForCurrentRole(next)) }
}

export function endLocalConversation(contactId, payload = {}) {
	const current = getLocalConversation(contactId)
	if (!current) return null
	const rawContact = mergedConversations().find((item) => contactIdOf(item) === String(contactId || '')) || current.contact
	const role = userRole()
	if (role !== 'user') throw new Error('仅客户本人可结束聊天')
	const createdAt = nowIso()
	const reason = firstNonEmpty(payload.reason, payload.note)
	const systemMessage = appendSystemMessage(rawContact, reason ? `客户已结束聊天，原因：${reason}` : '客户已结束聊天。', { eventType: 'customer-chat-ended', createdAt })
	const next = {
		...rawContact,
		customerChatClosed: true,
		customerChatClosedAt: createdAt,
		customerVisibleMessagesCleared: true,
		chatStatus: 'customer_closed',
		orderStatus: rawContact.orderStatus === 'completed' ? rawContact.orderStatus : 'customer_closed',
		updateTime: createdAt,
		updatedAt: createdAt,
		messages: [...(Array.isArray(rawContact.messages) ? rawContact.messages : []), systemMessage]
	}
	upsertStoredConversation(next)
	return { ok: true, contactId: contactIdOf(next), customerChatClosed: true, contact: clone(decorateForCurrentRole(next)) }
}

export function clearLocalConversationView(contactId) {
	const current = getLocalConversation(contactId)
	if (!current) return null
	const rawContact = mergedConversations().find((item) => contactIdOf(item) === String(contactId || '')) || current.contact
	const role = userRole()
	if (!['user', 'service', 'advisor'].includes(role)) throw new Error('当前端口不能清空聊天框')
	const clearedAt = nowIso()
	const actorId = getUserId() || role
	const clearRecord = { actorId, actorRole: role, clearedAt }
	const next = {
		...rawContact,
		chatClears: [
			clearRecord,
			...(Array.isArray(rawContact.chatClears) ? rawContact.chatClears.filter((item) => !(String(item.actorId || '') === String(actorId) && item.actorRole === role)) : [])
		],
		updateTime: clearedAt,
		updatedAt: clearedAt
	}
	markLocalReadForCurrentRole(next, clearedAt)
	upsertStoredConversation(next)
	return { ok: true, contactId: contactIdOf(next), clearedAt, messages: [] }
}

export function listLocalBankTeachers() {
	return Object.entries(LOCAL_TEST_PROFILES)
		.filter(([, profile]) => profile.role === 'advisor')
		.map(([phone, profile]) => ({
			id: `local-dev-${phone}`,
			uid: `local-dev-${phone}`,
			name: profile.nickname || '银行老师',
			phone,
			institution: profile.institution || '',
			role: 'advisor'
		}))
		.filter((item) => item.institution)
}

export function inviteLocalConversationAdvisor(contactId, payload = {}) {
	const current = getLocalConversation(contactId)
	if (!current) return null
	const rawContact = mergedConversations().find((item) => contactIdOf(item) === String(contactId || '')) || current.contact
	const role = userRole()
	if (role !== 'service' && role !== 'admin') throw new Error('仅客服可邀请银行老师')
	if (role === 'service' && !isAssignedToCurrentActor(rawContact, 'service')) throw new Error('请先接单后再邀请银行老师')
	if (rawContact.advisorAssigneeId) throw new Error(`该会话已由${rawContact.advisorAssigneeName || '银行老师'}接入`)
	const candidates = listLocalBankTeachers()
	const target = candidates.find((item) => String(item.uid) === String(payload.advisorId || payload.teacherId || payload.uid || '')) ||
		candidates.find((item) => normalizedInstitution(item.institution) === normalizedInstitution(payload.institution || payload.bankName || ''))
	const institution = firstNonEmpty(target && target.institution, payload.institution, payload.bankName)
	if (!institution) throw new Error('请选择银行老师或机构')
	const invitedAt = nowIso()
	const invite = {
		id: `local-invite-${Date.now()}`,
		contactId: contactIdOf(rawContact),
		userId: rawContact.userId || 'local-dev-19600000001',
		advisorId: target ? target.uid : '',
		advisorName: target ? target.name : '',
		institution,
		invitedById: getUserId() || role,
		invitedByRole: role,
		invitedByName: senderInfoForRole(role).senderName,
		note: firstNonEmpty(payload.note, payload.remark),
		createdAt: invitedAt
	}
	const label = invite.advisorName ? `${institution}${invite.advisorName}` : `${institution}银行老师`
	const systemMessage = appendSystemMessage(rawContact, `${invite.invitedByName}已邀请${label}进入群聊。`, { eventType: 'advisor-invited', inviteId: invite.id, createdAt: invitedAt })
	const next = {
		...rawContact,
		channel: 'bank',
		deskType: 'bank',
		contactType: rawContact.contactType === 'customer-service' ? 'match-product' : rawContact.contactType,
		groupMode: 'service-bank-customer',
		serviceRequired: true,
		advisorStatus: 'invited',
		institution,
		invitedAdvisorId: invite.advisorId,
		invitedAdvisorName: invite.advisorName,
		invitedAdvisorInstitution: institution,
		advisorInvitedAt: invitedAt,
		advisorInviteRecords: [invite, ...(Array.isArray(rawContact.advisorInviteRecords) ? rawContact.advisorInviteRecords : [])],
		updateTime: invitedAt,
		updatedAt: invitedAt,
		messages: [...(Array.isArray(rawContact.messages) ? rawContact.messages : []), systemMessage]
	}
	upsertStoredConversation(next)
	return { ok: true, contactId: contactIdOf(next), invite: clone(invite), message: clone(systemMessage), contact: clone(decorateForCurrentRole(next)) }
}

export function renameLocalConversationGroup(contactId, groupName) {
	const current = getLocalConversation(contactId)
	if (!current) return null
	const rawContact = mergedConversations().find((item) => contactIdOf(item) === String(contactId || '')) || current.contact
	const role = userRole()
	if (!['service', 'advisor', 'admin'].includes(role)) throw new Error('仅客服或银行老师可修改群名称')
	if (!isBankServiceGroup(rawContact)) throw new Error('仅三方群聊可修改群名称')
	if (role === 'service' && !isAssignedToCurrentActor(rawContact, 'service')) throw new Error('请先接单后再修改群名称')
	if (role === 'advisor' && !isAssignedToCurrentActor(rawContact, 'advisor')) throw new Error('请先接单后再修改群名称')
	const name = String(groupName || '').replace(/\s+/g, ' ').trim()
	if (name.length < 2 || name.length > 30) throw new Error('群名称需为 2-30 个字')
	const createdAt = nowIso()
	const actorName = senderInfoForRole(role).senderName
	const previousGroupName = firstNonEmpty(rawContact.groupName, rawContact.groupTitle, rawContact.displayTitle)
	const systemMessage = appendSystemMessage(rawContact, `${actorName}将群名称修改为「${name}」。`, {
		eventType: 'group-renamed',
		previousGroupName,
		groupName: name,
		createdAt
	})
	const next = {
		...rawContact,
		groupName: name,
		groupTitle: name,
		displayTitle: name,
		updateTime: createdAt,
		updatedAt: createdAt,
		messages: [...(Array.isArray(rawContact.messages) ? rawContact.messages : []), systemMessage]
	}
	upsertStoredConversation(next)
	return { ok: true, contactId: contactIdOf(next), groupName: name, previousGroupName, message: clone(systemMessage), contact: clone(decorateForCurrentRole(next)) }
}
