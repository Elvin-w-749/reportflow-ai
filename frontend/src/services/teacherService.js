import { request } from './apiClient.js'
import { getCachedUserInfo, resolveAuthToken } from './authService.js'
import {
	buildTeacherSyncMeta,
	buildUserWritebackSyncSummary,
	collectRequiredMissing,
	collectUserWritebackMissing,
	latestTimestampFromItems
} from './teacherRealtime.js'
import { normalizeAdvisorContactContext } from './teacherContactContext.js'
import { getLocalTestRole, listLocalConversations } from './localConversationStore.js'

export { TEACHER_REALTIME_POLL_MS, startTeacherRealtimeRefresh } from './teacherRealtime.js'

// 老师端专用端点（TEACHER_ENABLE=true 时可用）
const TEACHER_ENDPOINTS = {
	workbench: { url: '/api/teacher/workbench', method: 'GET', source: 'teacher-workbench' },
	clients: { url: '/api/teacher/clients', method: 'GET', source: 'teacher-clients' },
	tasks: { url: '/api/teacher/tasks', method: 'GET', source: 'teacher-tasks' },
	clientDetail: (uid) => ({ url: `/api/teacher/client/${encodeURIComponent(uid)}`, method: 'GET', source: 'teacher-client-detail' })
}

// 用户端回退端点（老师端不可用时走顾问记录）
const CONTACT_ENDPOINTS = [
	{ url: '/api/advisor/contacts', method: 'GET', source: 'advisor-contacts' }
]

const WORKBENCH_ENDPOINTS = [
	{ url: '/api/advisor/my', method: 'GET', source: 'advisor-my' }
]

const COMPLETE_ENDPOINTS = [
	{ url: '/api/advisor/contact/status', method: 'POST', mode: 'contact' }
]

const MATERIAL_REVIEW_ENDPOINT = '/api/advisor/contact/material-review'

const PENDING_SET = new Set(['pending', 'processing', 'todo', 'new'])
const DONE_SET = new Set(['completed', 'done', 'resolved'])

const STATUS_TEXT = {
	pending: '待处理',
	processing: '处理中',
	completed: '已完成',
	cancelled: '已取消',
	done: '已完成',
	resolved: '已完成',
	todo: '待处理',
	new: '待处理'
}

const EMPTY_SYNC_META = () => buildTeacherSyncMeta({ source: 'none', missingFields: ['source'] })

const LOCAL_TEST_BANK_CLIENTS = [
	{
		id: 'local-client-001',
		contactId: 'local-contact-001',
		clientId: 'local-client-001',
		channel: 'bank',
		deskType: 'bank',
		contactType: 'match-product',
		name: '张先生',
		phone: '138****2608',
		time: '今天 10:28',
		status: 'pending',
		statusText: '待处理',
		productName: '臻享信用贷E07',
		rateText: '年化 3.85% 起',
		amountText: '最高 50 万',
		termText: '最长 60 期',
		matchRate: 86,
		summary: '征信评分较好，已补充公积金账单，待确认收入流水。',
		messages: [{ senderType: 'user', content: '我想咨询这个产品的准入条件。' }],
		writebackSummary: {
			hasWritebacks: true,
			isComplete: false,
			missingFields: ['materialReview'],
			counts: { materialSubmit: 1, messageAction: 1, pushBinding: 0, incomplete: 1 }
		}
	},
	{
		id: 'local-client-002',
		contactId: 'local-contact-002',
		clientId: 'local-client-002',
		channel: 'bank',
		deskType: 'bank',
		contactType: 'match-product',
		name: '李女士',
		phone: '139****0716',
		time: '昨天 16:42',
		status: 'processing',
		statusText: '处理中',
		productName: '家装消费贷E18',
		rateText: '按审批浮动',
		amountText: '以审批为准',
		termText: '最长 36 期',
		matchRate: 74,
		summary: '近期查询偏多，建议先补充个税截图和社保记录后再确认方案。',
		messages: [{ senderType: 'user', content: '我已经上传了个税截图，麻烦看一下。' }],
		writebackSummary: {
			hasWritebacks: true,
			isComplete: true,
			missingFields: [],
			counts: { materialSubmit: 2, messageAction: 1, pushBinding: 0, incomplete: 0 }
		}
	}
]

const LOCAL_TEST_SERVICE_CLIENTS = [
	{
		id: 'local-service-client-001',
		contactId: 'local-service-contact-001',
		clientId: 'local-service-client-001',
		clientUid: 'demo-client-wang-001',
		channel: 'service',
		deskType: 'service',
		contactType: 'customer-service',
		name: '王先生',
		phone: '137****8126',
		time: '今天 11:06',
		status: 'pending',
		statusText: '待回复',
		summary: '上传信用报告后提示网络连接失败，需要客服协助确认入口。',
		messages: [{ senderType: 'user', content: '上传信用报告显示网络连接失败，可以帮我看一下吗？' }],
		writebackSummary: {
			hasWritebacks: false,
			isComplete: true,
			missingFields: [],
			counts: { materialSubmit: 0, messageAction: 0, pushBinding: 0, incomplete: 0 }
		}
	},
	{
		id: 'local-service-client-002',
		contactId: 'local-service-contact-002',
		clientId: 'local-service-client-002',
		clientUid: 'demo-client-chen-002',
		channel: 'service',
		deskType: 'service',
		contactType: 'customer-service',
		name: '陈女士',
		phone: '136****0972',
		time: '昨天 18:20',
		status: 'processing',
		statusText: '处理中',
		summary: '客户询问测试账号登录和补充材料上传方式。',
		messages: [{ senderType: 'user', content: '我想确认三金账单截图上传后在哪里看进度。' }],
		writebackSummary: {
			hasWritebacks: false,
			isComplete: true,
			missingFields: [],
			counts: { materialSubmit: 0, messageAction: 0, pushBinding: 0, incomplete: 0 }
		}
	}
]

function localTestRole() {
	const token = String(resolveAuthToken() || '')
	if (!token.startsWith('local-dev-token-')) return ''
	const directRole = getLocalTestRole()
	if (directRole) return directRole
	const user = getCachedUserInfo() || {}
	const mobile = String(user.mobile || user.phone || '').trim()
	if (/^19600000002$/.test(mobile)) return 'advisor'
	if (/^19600000003$/.test(mobile)) return 'service'
	if (/^19600000004$/.test(mobile)) return 'admin'
	if (/^19600000005$/.test(mobile)) return 'advisor'
	if (/^19600000006$/.test(mobile)) return 'advisor'
	if (/^19600000001$/.test(mobile)) return 'user'
	const match = token.match(/local-dev-token-(196000000\d{2})-/)
	if (!match) return ''
	if (match[1].endsWith('02')) return 'advisor'
	if (match[1].endsWith('03')) return 'service'
	if (match[1].endsWith('04')) return 'admin'
	if (match[1].endsWith('05')) return 'advisor'
	if (match[1].endsWith('06')) return 'advisor'
	if (match[1].endsWith('01')) return 'user'
	return ''
}

function isLocalTestAuth(port = '') {
	const role = localTestRole()
	if (port === 'bank') return role === 'advisor'
	if (port === 'service') return role === 'service'
	return role === 'advisor' || role === 'service'
}

function localTestClientsForPort(port = 'bank') {
	const live = listLocalConversations(port)
	if (live.length) return live
	return port === 'service' ? LOCAL_TEST_SERVICE_CLIENTS : LOCAL_TEST_BANK_CLIENTS
}

function localTestSyncMeta(scope, port = 'bank') {
	return syncMetaFor(`local-test-${port}-${scope}`, localTestClientsForPort(port), [])
}

function localTestWorkbenchData(port = 'bank') {
	const clients = localTestClientsForPort(port).map((item) => attachWritebackSummary(item))
	const pending = clients.filter((item) => PENDING_SET.has(normalizeStatus(item.status))).length
	const todayNew = clients.filter((item) => String(item.time || '').includes('今天')).length || (clients.length ? 1 : 0)
	return {
		stats: { todayNew, pending, monthDone: 0 },
		recentClients: clients,
		source: `local-test-${port}-workbench`,
		contacts: clients,
		syncMeta: localTestSyncMeta('workbench', port)
	}
}

function localTestClientsData(port = 'bank') {
	const clients = localTestClientsForPort(port).map((item) => attachWritebackSummary(item))
	return {
		clients,
		source: `local-test-${port}-clients`,
		total: clients.length,
		syncMeta: localTestSyncMeta('clients', port)
	}
}

function localTestTasksData(port = 'bank') {
	const clients = localTestClientsForPort(port).map((item) => attachWritebackSummary(item))
	return {
		tasks: buildTasksFromContacts(clients),
		source: `local-test-${port}-tasks`,
		syncMeta: localTestSyncMeta('tasks', port)
	}
}

function asObj(v) {
	return v && typeof v === 'object' ? v : {}
}

function asNum(v) {
	const n = Number(v)
	return Number.isFinite(n) ? n : 0
}

function parseTs(v) {
	if (v == null || v === '') return 0
	const d = new Date(v)
	const ts = d.getTime()
	return Number.isFinite(ts) ? ts : 0
}

function latestMessageOf(messages = []) {
	return Array.isArray(messages) && messages.length ? messages[messages.length - 1] : null
}

function latestActivityTsOf(raw = {}, context = {}) {
	const latestMessage = latestMessageOf(context.messages)
	return parseTs(
		(latestMessage && (latestMessage.createdAt || latestMessage.updateTime || latestMessage.updatedAt)) ||
		raw.updateTime ||
		raw.updatedAt ||
		raw.latestMessageAt ||
		raw.lastMessageAt ||
		raw.latestTime ||
		raw.createTime ||
		raw.createdAt ||
		raw.time
	)
}

function toList(data) {
	if (Array.isArray(data)) return data
	const o = asObj(data)
	if (Array.isArray(o.list)) return o.list
	if (Array.isArray(o.records)) return o.records
	if (Array.isArray(o.items)) return o.items
	if (Array.isArray(o.clients)) return o.clients
	if (Array.isArray(o.tasks)) return o.tasks
	if (Array.isArray(o.contacts)) return o.contacts
	if (Array.isArray(o.history)) return o.history
	const d = asObj(o.data)
	if (Array.isArray(d.list)) return d.list
	if (Array.isArray(d.records)) return d.records
	if (Array.isArray(d.items)) return d.items
	if (Array.isArray(d.clients)) return d.clients
	if (Array.isArray(d.tasks)) return d.tasks
	if (Array.isArray(d.contacts)) return d.contacts
	if (Array.isArray(d.history)) return d.history
	if (Array.isArray(d)) return d
	return null
}

function pickStr(...candidates) {
	for (const v of candidates) {
		if (typeof v === 'string' && v.trim()) return v.trim()
	}
	return ''
}

function pickIdentifier(...candidates) {
	for (const value of candidates) {
		if (typeof value === 'string' && value.trim()) return value.trim()
		if ((typeof value === 'number' || typeof value === 'bigint') && String(value).trim()) return String(value)
	}
	return ''
}

function avatarOf(value) {
	const item = asObj(value)
	return pickStr(
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
}


function normalizeStatus(rawStatus) {
	const s = pickStr(rawStatus).toLowerCase()
	if (!s) return 'pending'
	if (PENDING_SET.has(s) || DONE_SET.has(s) || s === 'cancelled') return s
	return 'processing'
}

export function contactPortOf(item = {}) {
	const raw = String(pickStr(item.channel, item.deskType, item.serviceChannel, item.contactType)).toLowerCase()
	if (raw === 'service' || raw === 'support' || raw === 'customer-service') return 'service'
	return 'bank'
}

function normalizePort(port = 'bank') {
	return port === 'service' ? 'service' : 'bank'
}

export function filterByPort(list = [], port = 'bank') {
	const target = normalizePort(port)
	return list.filter((item) => {
		if (target === 'service') {
			return contactPortOf(item) === 'service' ||
				item.serviceRequired === true ||
				item.groupMode === 'service-bank-customer' ||
				item.contactType === 'match-product'
		}
		return contactPortOf(item) === target
	})
}

const contactIdentityOf = (item = {}) => String(item.contactId || item.id || '').trim()
const customerMessageOf = (item = {}) => {
	const messages = Array.isArray(item.messages) ? item.messages : []
	const latest = item.latestMessage || (messages.length ? messages[messages.length - 1] : null)
	return latest && latest.senderType === 'user' ? latest : null
}

export function serviceWorkbenchCustomerWatermark(item = {}) {
	const message = customerMessageOf(item)
	if (!message) return { key: '', at: 0 }
	const rawAt = message.createdAt || message.updatedAt || message.updateTime || item.latestMessageAt || ''
	const parsedAt = new Date(rawAt).getTime()
	const signature = message.id || rawAt || message.content || ''
	return {
		key: signature ? `${contactIdentityOf(item)}:${String(signature)}` : '',
		at: Number.isFinite(parsedAt) ? parsedAt : 0
	}
}

export function shouldApplyServiceWorkbenchResponse(requestId, latestRequestId) {
	return Number(requestId) === Number(latestRequestId)
}

export function isTemporaryServiceWorkbenchFailure(error = {}) {
	const status = Number(error.statusCode ?? error.status ?? error.code)
	if ([408, 425, 429].includes(status) || status >= 500) return true
	if (Number.isFinite(status) && status > 0) return false
	const message = String(error.message || error.errMsg || error.code || error || '')
	return /network|timeout|timed out|offline|econn|socket|request:fail|网络|超时|连接失败|暂时不可用/i.test(message)
}

export function applyServiceWorkbenchHiddenWatermarks(list = [], hiddenByContact = new Map()) {
	const hidden = hiddenByContact instanceof Map
		? hiddenByContact
		: new Map(Object.entries(hiddenByContact || {}))
	const reopenedIds = []
	const items = (Array.isArray(list) ? list : []).filter((item) => {
		const id = contactIdentityOf(item)
		const marker = id ? hidden.get(id) : null
		if (!marker) return true
		const current = serviceWorkbenchCustomerWatermark(item)
		const explicitlyReopened = item.reopenedByCustomer === true || item.serviceReopenedByCustomer === true
		const newerTimestamp = current.at > Number(marker.customerMessageAt || marker.at || 0)
		const changedMessage = !!current.key && !!marker.customerMessageKey && current.key !== marker.customerMessageKey
		if (explicitlyReopened || newerTimestamp || changedMessage) {
			item.reopenedByCustomer = true
			reopenedIds.push(id)
			return true
		}
		return false
	})
	return { items, reopenedIds }
}

function formatRelative(ts) {
	if (!ts) return '未知时间'
	const d = new Date(ts)
	const now = new Date()
	const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
	if (sameDay) {
		const hh = String(d.getHours()).padStart(2, '0')
		const mm = String(d.getMinutes()).padStart(2, '0')
		return `今天 ${hh}:${mm}`
	}
	const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
	const sameYesterday = d.getFullYear() === yesterday.getFullYear() && d.getMonth() === yesterday.getMonth() && d.getDate() === yesterday.getDate()
	if (sameYesterday) {
		const hh = String(d.getHours()).padStart(2, '0')
		const mm = String(d.getMinutes()).padStart(2, '0')
		return `昨天 ${hh}:${mm}`
	}
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function normalizeContact(item, idx = 0) {
	const raw = asObj(item)
	const clientInfo = asObj(raw.clientInfo)
	const userInfo = asObj(raw.userInfo)
	const customer = asObj(raw.customer)
	const user = asObj(raw.user)
	const client = asObj(raw.client)
	const context = normalizeAdvisorContactContext(raw)

	const id = pickStr(raw._id, raw.id, raw.contactId, raw.taskId, `contact-${idx}`)
	const clientId = pickIdentifier(
		raw.clientId,
		client.clientId,
		clientInfo.clientId,
		client.id,
		client._id,
		clientInfo.id,
		clientInfo._id,
		user.clientId,
		userInfo.clientId,
		customer.clientId,
		user.id,
		user._id,
		userInfo.id,
		userInfo._id,
		customer.id,
		customer._id,
		context.clientId
	)
	const clientUid = pickIdentifier(
		raw.userId,
		raw.uid,
		raw.clientUid,
		raw.customerUid,
		user.uid,
		user.userId,
		user.clientUid,
		userInfo.uid,
		userInfo.userId,
		userInfo.clientUid,
		client.uid,
		client.userId,
		client.clientUid,
		clientInfo.uid,
		clientInfo.userId,
		clientInfo.clientUid,
		customer.uid,
		customer.userId,
		customer.clientUid,
		customer.customerUid,
		context.clientUid,
		clientId
	)
	const userId = pickIdentifier(
		raw.userId,
		user.userId,
		userInfo.userId,
		client.userId,
		clientInfo.userId,
		customer.userId,
		context.userId
	)
	const name = pickStr(
		clientInfo.name,
		clientInfo.realName,
		userInfo.name,
		userInfo.realName,
		customer.name,
		customer.realName,
		user.name,
		user.realName,
		raw.name,
		raw.realName,
		raw.clientName,
		raw.userName
	)
	const phone = pickStr(
		clientInfo.phone,
		clientInfo.mobile,
		userInfo.phone,
		userInfo.mobile,
		customer.phone,
		customer.mobile,
		user.phone,
		user.mobile,
		raw.phone,
		raw.mobile
	)
	const avatar = pickStr(
		avatarOf(clientInfo),
		avatarOf(userInfo),
		avatarOf(customer),
		avatarOf(user),
		avatarOf(client),
		avatarOf(raw),
		context.avatar
	)
	const status = normalizeStatus(raw.status)
	const latestMessage = latestMessageOf(context.messages)
	const ts = latestActivityTsOf(raw, context)
	const writebackSummary = normalizedWritebackSummaryOf({ ...raw, materials: context.materials })

	return {
		id,
		contactId: id,
		clientUid,
		clientId,
		userId,
		name: name || '未命名客户',
		phone,
		avatar,
		status,
		statusText: STATUS_TEXT[status] || '处理中',
		time: formatRelative(ts),
		createTs: ts,
		summary: context.summary,
		riskText: context.riskText,
		reportId: context.reportId,
		reportTitle: context.reportTitle,
		reportDate: context.reportDate,
		reportScore: context.reportScore,
			productId: context.productId,
			productName: context.productName,
			institution: context.institution,
			rateText: context.rateText,
			amountText: context.amountText,
			termText: context.termText,
				matchRate: context.matchRate,
			groupMode: raw.groupMode || context.groupMode,
			serviceRequired: raw.serviceRequired === true || context.serviceRequired === true,
			serviceStatus: raw.serviceStatus || context.serviceStatus || '',
			serviceAssigneeId: raw.serviceAssigneeId || '',
			serviceAssigneeName: raw.serviceAssigneeName || '',
			advisorStatus: raw.advisorStatus || context.advisorStatus || '',
			advisorAssigneeId: raw.advisorAssigneeId || '',
			advisorAssigneeName: raw.advisorAssigneeName || '',
			advisorJoinRequired: raw.advisorJoinRequired === true,
			chatAccess: raw.chatAccess !== false,
			advisorAccessText: raw.advisorAccessText || '',
			materialAccess: raw.materialAccess !== false,
			materialsRedacted: raw.materialsRedacted === true,
			materialAccessText: raw.materialAccessText || '',
			materialCount: raw.materialCount || 0,
			contactType: context.contactType,
			channel: context.channel,
			source: context.source,
			contactIntent: context.contactIntent,
			businessType: context.businessType,
			serviceType: context.serviceType,
			businessName: context.businessName,
			caseId: raw.caseId || context.caseId || asObj(raw.context).caseId || '',
			supplementMaterials: Array.isArray(raw.supplementMaterials)
				? raw.supplementMaterials
				: Array.isArray(asObj(raw.context).supplementMaterials) ? asObj(raw.context).supplementMaterials : [],
			materialProgressSummary: asObj(raw.materialProgressSummary || asObj(raw.context).materialProgressSummary),
			reopenedByCustomer: raw.reopenedByCustomer === true || raw.serviceReopenedByCustomer === true,
		advisorInfo: context.advisorInfo,
		messages: context.messages,
		latestMessage,
		latestMessageAt: latestMessage && (latestMessage.createdAt || latestMessage.updateTime || latestMessage.updatedAt),
		latestMessageSenderType: latestMessage && latestMessage.senderType,
		matchSuggestions: context.matchSuggestions,
		materials: context.materials,
		writebackSummary,
		raw
	}
}

function summarizeStats(contacts) {
	const now = new Date()
	const startDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
	const startMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
	const todayNew = contacts.filter((c) => c.createTs >= startDay).length
	const pending = contacts.filter((c) => PENDING_SET.has(c.status)).length
	const monthDone = contacts.filter((c) => DONE_SET.has(c.status) && c.createTs >= startMonth).length
	return { todayNew, pending, monthDone }
}

function pickStats(data) {
	const o = asObj(data)
	const stats = asObj(o.stats)
	const dStats = asObj(asObj(o.data).stats)
	const source = Object.keys(stats).length > 0 ? stats : dStats
	if (Object.keys(source).length === 0) return null
	const todayNew = asNum(source.todayNew ?? source.today_new ?? source.newToday ?? source.new_count)
	const pending = asNum(source.pending ?? source.pendingCount ?? source.pending_count)
	const monthDone = asNum(source.monthDone ?? source.month_done ?? source.completedThisMonth ?? source.done_count)
	return { todayNew, pending, monthDone }
}

function pickRecent(data) {
	const o = asObj(data)
	const list =
		(Array.isArray(o.recentClients) && o.recentClients) ||
		(Array.isArray(o.clients) && o.clients) ||
		(Array.isArray(asObj(o.data).recentClients) && asObj(o.data).recentClients) ||
		(Array.isArray(asObj(o.data).clients) && asObj(o.data).clients) ||
		null
	return Array.isArray(list) ? list : null
}

async function fetchFirstSuccess(endpoints) {
	const errors = []
	for (const ep of endpoints) {
		try {
			const data = await request({ url: ep.url, method: ep.method })
			return { ok: true, source: ep.source, data }
		} catch (e) {
			if (e && e.statusCode === 401) throw e
			errors.push({ source: ep.source, message: e && e.message ? e.message : String(e || '') })
		}
	}
	return { ok: false, source: '', data: null, errors }
}

function syncMetaFor(source, listOrItem, missingFields = [], extra = {}) {
	return buildTeacherSyncMeta({
		source: source || 'none',
		fetchedAt: Date.now(),
		updatedAt: latestTimestampFromItems(listOrItem, extra.updatedCandidates || []),
		missingFields,
		errors: extra.errors || []
	})
}

async function fetchContactsCore(port = 'bank') {
	const hit = await fetchFirstSuccess(CONTACT_ENDPOINTS)
	if (!hit.ok) return { contacts: [], source: 'none', errors: hit.errors || [], missingFields: ['contacts'], syncMeta: EMPTY_SYNC_META() }
	const list = toList(hit.data)
	const contacts = Array.isArray(list) ? filterByPort(list, port).map((x, i) => normalizeContact(x, i)) : []
	contacts.sort((a, b) => b.createTs - a.createTs)
	const missingFields = Array.isArray(list) ? [...collectRequiredMissing(contacts, ['id', 'name', 'status'], 'contacts'), ...collectUserWritebackMissing(contacts, 'contacts')] : ['contacts']
	return { contacts, source: hit.source, errors: [], missingFields, syncMeta: syncMetaFor(hit.source, contacts, missingFields) }
}

function buildRecentClientsFromContacts(contacts, limit = 5, options = {}) {
	const out = []
	const seen = new Set()
	for (const c of contacts) {
		// 客服工作台按工单而不是客户聚合：同一客户的不同报告/产品必须分别保留。
		const key = options.preserveContacts
			? (c.contactId || c.id || `${c.clientUid || c.clientId}|${c.reportId}|${c.productId}`)
			: (c.clientUid || c.clientId || `${c.name}|${c.phone}`)
		if (seen.has(key)) continue
		seen.add(key)
		out.push({
			id: c.clientId || c.contactId,
			contactId: c.contactId,
			clientUid: c.clientUid || '',
			clientId: c.clientId || '',
			userId: c.userId || '',
			channel: c.channel,
			name: c.name || '未命名客户',
			phone: c.phone,
			avatar: c.avatar || '',
			time: c.time,
			status: c.status,
			statusText: c.statusText,
			riskText: c.riskText,
			summary: c.summary,
			reportId: c.reportId,
			reportTitle: c.reportTitle,
			reportCount: c.reportId ? 1 : 0,
				score: c.reportScore,
				institution: c.institution,
				productName: c.productName,
				rateText: c.rateText,
			amountText: c.amountText,
			termText: c.termText,
			matchRate: c.matchRate,
			source: c.source || '',
			contactIntent: c.contactIntent || '',
			businessType: c.businessType || '',
			serviceType: c.serviceType || '',
			businessName: c.businessName || '',
			messages: c.messages || [],
			latestMessage: c.latestMessage || (c.messages && c.messages.length ? c.messages[c.messages.length - 1] : null),
			latestMessageAt: c.latestMessageAt || (c.latestMessage && (c.latestMessage.createdAt || c.latestMessage.updateTime || c.latestMessage.updatedAt)),
			latestMessageSenderType: c.latestMessageSenderType || (c.latestMessage && c.latestMessage.senderType),
			unreadCount: Number(c.unreadCount || 0),
			hasUnread: c.hasUnread === true || Number(c.unreadCount || 0) > 0,
			matchSuggestions: c.matchSuggestions,
				materials: c.materials || [],
				supplementMaterials: c.supplementMaterials || [],
				caseId: c.caseId || '',
				materialProgressSummary: c.materialProgressSummary || {},
				materialAccess: c.materialAccess,
				materialsRedacted: c.materialsRedacted,
				materialAccessText: c.materialAccessText,
				materialCount: c.materialCount,
				groupMode: c.groupMode,
				serviceRequired: c.serviceRequired,
				serviceStatus: c.serviceStatus,
				serviceAssigneeId: c.serviceAssigneeId,
				serviceAssigneeName: c.serviceAssigneeName,
				advisorStatus: c.advisorStatus,
				advisorAssigneeId: c.advisorAssigneeId,
				advisorAssigneeName: c.advisorAssigneeName,
				advisorJoinRequired: c.advisorJoinRequired === true,
				chatAccess: c.chatAccess !== false,
				advisorAccessText: c.advisorAccessText || '',
				reopenedByCustomer: c.reopenedByCustomer === true,
				writebackSummary: c.writebackSummary
			})
		if (out.length >= limit) break
	}
	return out
}

function buildTasksFromContacts(contacts) {
	return contacts
		.filter((c) => PENDING_SET.has(c.status))
		.map((c, i) => ({
			id: c.contactId || `task-${i}`,
			contactId: c.contactId || '',
			clientId: c.clientId || c.contactId || '',
			title: c.productName ? `${c.name || '客户'}咨询${c.productName}` : `${c.name || '客户'}跟进`,
			desc: c.summary || (c.phone ? `联系电话：${c.phone}` : '待确认联系电话'),
			time: c.time,
			status: c.status,
			statusText: c.statusText,
				reportId: c.reportId,
				productName: c.productName,
				rateText: c.rateText,
				amountText: c.amountText,
				termText: c.termText,
				matchRate: c.matchRate,
			priority: c.matchRate >= 80 || c.status === 'pending' ? 'high' : 'normal',
			writebackSummary: c.writebackSummary
		}))
}

export async function getTeacherWorkbenchData(options = {}) {
	const port = normalizePort(options.port)
	if (isLocalTestAuth(port)) return localTestWorkbenchData(port)
	// 优先使用老师端专用端点
	const teacherHit = port === 'bank' ? await fetchFirstSuccess([TEACHER_ENDPOINTS.workbench]) : { ok: false, source: '', data: null, errors: [] }
	if (teacherHit.ok) {
		const d = teacherHit.data || {}
		const pickedStats = pickStats(d)
		const rawRecent = pickRecent(d)
		const stats = pickedStats || { todayNew: 0, pending: 0, monthDone: 0 }
		const recentClients = Array.isArray(rawRecent)
			? rawRecent.map((c) => attachWritebackSummary({ ...c, time: c.time || formatRelativeTs(c.latestTime || c.createTime) }))
			: []
		const missingFields = [
			...(!pickedStats ? ['stats'] : []),
			...(!Array.isArray(rawRecent) ? ['recentClients'] : []),
			...collectUserWritebackMissing(recentClients, 'recentClients')
		]
		return { stats, recentClients, source: teacherHit.source, contacts: [], syncMeta: syncMetaFor(teacherHit.source, recentClients, missingFields, { updatedCandidates: [d.updatedAt, d.updateTime, d.latestTime] }) }
	}

	// 回退：从顾问记录聚合
	const wb = port === 'bank' ? await fetchFirstSuccess(WORKBENCH_ENDPOINTS) : { ok: false, source: '', data: null, errors: [] }
	const contactsHit = await fetchContactsCore(port)
	let stats = summarizeStats(contactsHit.contacts)
	let recentClients = buildRecentClientsFromContacts(contactsHit.contacts, 5)
	let source = contactsHit.source

	if (wb.ok) {
		const wbStats = pickStats(wb.data)
		const wbRecent = pickRecent(wb.data)
		if (wbStats) stats = wbStats
		if (wbRecent) {
			recentClients = buildRecentClientsFromContacts(wbRecent.map((x, i) => normalizeContact(x, i)), 5)
		}
		source = wb.source
	}

	return { stats, recentClients, source, contacts: contactsHit.contacts, syncMeta: syncMetaFor(source, contactsHit.contacts, contactsHit.missingFields || []) }
}


function materialListOf(item = {}) {
	const raw = asObj(item)
	return Array.isArray(raw.materials) ? raw.materials
		: Array.isArray(raw.requiredMaterials) ? raw.requiredMaterials
			: Array.isArray(raw.materialChecklist) ? raw.materialChecklist
				: Array.isArray(raw.materialList) ? raw.materialList
					: []
}

function normalizedWritebackSummaryOf(item = {}) {
	const existing = asObj(item.writebackSummary)
	if (Object.keys(existing).length > 0 && ('hasWritebacks' in existing || 'isComplete' in existing || 'counts' in existing || 'missingFields' in existing)) {
		const counts = asObj(existing.counts)
		const materialSubmitCount = asNum(counts.materialSubmit ?? asObj(existing.materialSubmit).total)
		const messageActionCount = asNum(counts.messageAction ?? asObj(existing.messageAction).total)
		const pushBindingCount = asNum(counts.pushBinding ?? asObj(existing.pushBinding).total)
		const incomplete = asNum(counts.incomplete)
		const missingFields = Array.isArray(existing.missingFields) ? existing.missingFields : []
		const total = materialSubmitCount + messageActionCount + pushBindingCount
		return {
			...existing,
			hasWritebacks: typeof existing.hasWritebacks === 'boolean' ? existing.hasWritebacks : total > 0 || missingFields.length > 0,
			isComplete: typeof existing.isComplete === 'boolean' ? existing.isComplete : missingFields.length === 0 && incomplete === 0,
			missingFields,
			counts: {
				materialSubmit: materialSubmitCount,
				messageAction: messageActionCount,
				pushBinding: pushBindingCount,
				incomplete
			}
		}
	}
	return buildUserWritebackSyncSummary(item, { materials: materialListOf(item) })
}

function attachWritebackSummary(item = {}) {
	return {
		...item,
		writebackSummary: normalizedWritebackSummaryOf(item)
	}
}
export async function getTeacherClientsData(options = {}) {
	const port = normalizePort(options.port)
	if (isLocalTestAuth(port)) return localTestClientsData(port)
	const teacherHit = port === 'bank' ? await fetchFirstSuccess([TEACHER_ENDPOINTS.clients]) : { ok: false, source: '', data: null, errors: [] }
	if (teacherHit.ok) {
		const d = teacherHit.data || {}
		const rawClients = toList(d)
		const clients = Array.isArray(rawClients)
			? rawClients.map((c, i) => attachWritebackSummary({
				...c,
				id: c.id || c.clientId || c.contactId || `client-${i}`,
				name: c.name || c.clientName || c.realName || '未命名客户',
				status: c.status || 'processing',
				time: c.time || formatRelativeTs(c.latestTime || c.createTime),
				statusText: c.statusText || '处理中'
			}))
			: []
		const missingFields = Array.isArray(rawClients) ? [...collectRequiredMissing(clients, ['id', 'name', 'status'], 'clients'), ...collectUserWritebackMissing(clients, 'clients')] : ['clients']
		return { clients, source: teacherHit.source, total: clients.length, syncMeta: syncMetaFor(teacherHit.source, clients, missingFields, { updatedCandidates: [d.updatedAt, d.updateTime, d.latestTime] }) }
	}
	const hit = await fetchContactsCore(port)
	const clients = buildRecentClientsFromContacts(hit.contacts, 50, { preserveContacts: port === 'service' })
	return { clients, source: hit.source, total: hit.contacts.length, syncMeta: syncMetaFor(hit.source, clients, hit.missingFields || []) }
}

export async function getTeacherTasksData(options = {}) {
	const port = normalizePort(options.port)
	if (isLocalTestAuth(port)) return localTestTasksData(port)
	const teacherHit = port === 'bank' ? await fetchFirstSuccess([TEACHER_ENDPOINTS.tasks]) : { ok: false, source: '', data: null, errors: [] }
	if (teacherHit.ok) {
		const d = teacherHit.data || {}
		const rawTasks = toList(d)
		const tasks = Array.isArray(rawTasks)
			? rawTasks.map((t, i) => attachWritebackSummary({
				...t,
				id: t.id || t.taskId || t.contactId || `task-${i}`,
				title: t.title || t.name || t.clientName || '客户跟进',
				status: t.status || 'pending'
			}))
			: []
		const missingFields = Array.isArray(rawTasks) ? [...collectRequiredMissing(tasks, ['id', 'title', 'status'], 'tasks'), ...collectUserWritebackMissing(tasks, 'tasks')] : ['tasks']
		return { tasks, source: teacherHit.source, syncMeta: syncMetaFor(teacherHit.source, tasks, missingFields, { updatedCandidates: [d.updatedAt, d.updateTime, d.latestTime] }) }
	}
	const hit = await fetchContactsCore(port)
	const tasks = buildTasksFromContacts(hit.contacts)
	return { tasks, source: hit.source, syncMeta: syncMetaFor(hit.source, tasks, hit.missingFields || []) }
}

export async function getTeacherClientDetail(clientId, options = {}) {
	const port = normalizePort(options.port)
	if (isLocalTestAuth(port)) {
		const localClients = localTestClientsForPort(port)
		const client = localClients.find((item) => item.id === clientId || item.clientId === clientId || item.contactId === clientId) || localClients[0]
		return {
			client: attachWritebackSummary(client),
			history: localClients.map((item) => attachWritebackSummary(item)),
			source: `local-test-${port}-client-detail`,
			syncMeta: localTestSyncMeta('client-detail', port)
		}
	}
	const teacherHit = port === 'bank' ? await fetchFirstSuccess([TEACHER_ENDPOINTS.clientDetail(clientId)]) : { ok: false, source: '', data: null, errors: [] }
	if (teacherHit.ok) {
		const d = teacherHit.data || {}
		const dd = asObj(d.data)
		const client = attachWritebackSummary(d.client || dd.client || { id: clientId, name: '未命名客户', phone: '', contactCount: 0, latestTime: '暂无记录' })
		const rawHistory = Array.isArray(d.contacts) ? d.contacts : Array.isArray(d.history) ? d.history : Array.isArray(dd.contacts) ? dd.contacts : Array.isArray(dd.history) ? dd.history : []
		const history = Array.isArray(rawHistory) ? rawHistory.map((item) => attachWritebackSummary(item)) : []
		const detailItems = [client, ...history]
		const missingFields = [
			...collectRequiredMissing([client], ['id', 'name'], 'client'),
			...(!Array.isArray(rawHistory) ? ['history'] : []),
			...collectUserWritebackMissing(detailItems, 'clientDetail')
		]
		return {
			client,
			history,
			source: teacherHit.source,
			syncMeta: syncMetaFor(teacherHit.source, detailItems, missingFields, { updatedCandidates: [d.updatedAt, d.updateTime, d.latestTime] })
		}
	}
	const hit = await fetchContactsCore(port)
	const all = hit.contacts
	const id = String(clientId || '')
	const matches = all.filter((c) => {
		if (id && (c.clientId === id || c.contactId === id)) return true
		if (id && c.name === id) return true
		return false
	})
	const clientName = matches.length > 0 && matches[0].name
		? matches[0].name
		: all.find((c) => c.contactId === id || c.clientId === id)?.name || all.find((c) => c.phone === id)?.name || id
	const clientPhone = matches.length > 0 ? matches[0].phone : ''
	// 客服从某个工单进入资料档案时只读取该 contact，避免同名客户的其他报告串入。
	const historySource = (port === 'service' && matches.length
		? matches
		: all.filter((c) => c.name === clientName)
	).sort((a, b) => b.createTs - a.createTs)
	const latest = historySource[0] || matches[0] || {}
	const history = historySource.map((c) => ({
		id: c.contactId,
		time: c.time,
		createTs: c.createTs,
		status: c.status,
		statusText: c.statusText,
		summary: c.summary,
			reportId: c.reportId,
			reportTitle: c.reportTitle,
			productName: c.productName,
			rateText: c.rateText,
			amountText: c.amountText,
			termText: c.termText,
			matchRate: c.matchRate,
		materials: c.materials || [],
		writebackSummary: c.writebackSummary,
		notes: Array.isArray(c.raw && c.raw.notes) ? c.raw.notes : [],
		raw: c.raw
	}))
	const reportCount = new Set(historySource.map((c) => c.reportId).filter(Boolean)).size
	return {
		client: {
			id: clientId || clientName,
			name: clientName || '未命名客户',
			phone: clientPhone,
			contactCount: history.length,
			reportCount,
			reportTotal: reportCount,
			score: latest.reportScore,
			riskText: latest.riskText,
			summary: latest.summary,
			matchSuggestions: latest.matchSuggestions || [],
				materials: latest.materials || [],
				productName: latest.productName,
				rateText: latest.rateText,
				amountText: latest.amountText,
				termText: latest.termText,
				reportId: latest.reportId,
			writebackSummary: latest.writebackSummary,
			latestTime: history.length > 0 ? history[0].time : '暂无记录'
		},
		history,
		source: hit.source,
		syncMeta: syncMetaFor(hit.source, history, hit.missingFields || [])
	}
}

function formatRelativeTs(isoStr) {
	if (!isoStr) return '未知时间'
	const d = new Date(isoStr)
	if (isNaN(d.getTime())) return '未知时间'
	const now = new Date()
	const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
	if (sameDay) return `今天 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
	const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
	if (d.getFullYear() === yesterday.getFullYear() && d.getMonth() === yesterday.getMonth() && d.getDate() === yesterday.getDate()) {
		return `昨天 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
	}
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export async function saveContactNote(contactId, note) {
	if (!contactId || !String(note).trim()) return { ok: false, errMsg: '参数缺失' }
	try {
		const data = await request({
			url: '/api/advisor/contact/notes',
			method: 'POST',
			data: { contactId, note: String(note).trim() }
		})
		return { ok: true, notes: Array.isArray(data && data.notes) ? data.notes : [] }
	} catch (e) {
		return { ok: false, errMsg: e && e.message ? e.message : '保存备注失败' }
	}
}

export async function saveContactMaterialReview(contactId, material = {}, review = {}) {
	const id = pickStr(contactId)
	const materialId = pickStr(material.id, material.key, material.code)
	const materialName = pickStr(material.name, material.title, material.label, material.materialName)
	const status = pickStr(review.status, review.reviewStatus)
	if (!id || (!materialId && !materialName) || !status) return { ok: false, errMsg: '参数缺失' }
	try {
		const data = await request({
			url: MATERIAL_REVIEW_ENDPOINT,
			method: 'POST',
			data: {
				contactId: id,
				materialId,
				materialName,
				status,
				statusText: pickStr(review.statusText),
				reviewNote: pickStr(review.reviewNote, review.rejectReason, review.reason, review.note),
				reviewedAt: pickStr(review.reviewedAt, review.reviewTime, new Date().toISOString()),
				source: pickStr(material.source),
				executionRecordId: pickStr(material.executionRecordId),
				debtId: pickStr(material.debtId),
				reportId: pickStr(material.reportId),
				uploadUrl: pickStr(material.uploadUrl, material.url, material.fileUrl),
				fileName: pickStr(material.fileName, material.nameOnDisk, material.uploadName)
			}
		})
		return { ok: true, material: asObj(data && data.material), data }
	} catch (e) {
		if (e && e.statusCode === 401) throw e
		return { ok: false, errMsg: e && e.message ? e.message : '材料复核失败' }
	}
}

export async function completeTeacherTask(task) {
	const taskObj = asObj(task)
	const taskId = pickStr(taskObj.id, taskObj.taskId)
	const contactId = pickStr(taskObj.contactId, taskObj.id)
	for (const ep of COMPLETE_ENDPOINTS) {
		try {
			const data =
				ep.mode === 'task'
					? { taskId, status: 'completed' }
					: { contactId, status: 'completed' }
			await request({
				url: ep.url,
				method: ep.method,
				data
			})
			return true
		} catch (e) {
			if (e && e.statusCode === 401) throw e
		}
	}
	return false
}
