'use strict'

/**
 * 银行老师端路由
 *
 * 老师角色仅可查看与本人存在案件级关系的联系记录和关联报告；管理员保留审计权限。
 * 所有端点均需 authRequired + 角色校验（user.role === 'advisor' 或 admin）。
 *
 * 启用条件：环境变量 TEACHER_ENABLE=true（默认关闭，防止未授权访问）。
 */

const express = require('express')
const { ok, fail } = require('../utils/response')
const { authRequired } = require('../middlewares/auth')
const { hasRole } = require('../middlewares/roles')
const store = require('../db/store')
const logger = require('../utils/logger')
const { maskPhone } = require('../utils/mask')
const {
	contactInstitutionOf,
	firstValidInstitution,
	institutionTextMatches,
	normalizedInstitution
} = require('../utils/institutionPolicy')

const router = express.Router()

const TEACHER_ENABLED = String(process.env.TEACHER_ENABLE || 'false').toLowerCase() === 'true'

function contactChannelOf(item = {}) {
	const raw = String(item.channel || item.deskType || item.serviceChannel || '').trim().toLowerCase()
	if (raw === 'service' || raw === 'support' || raw === 'customer-service') return 'service'
	if (String(item.contactType || '') === 'customer-service') return 'service'
	return 'bank'
}

function firstNonEmpty(...values) {
	for (const value of values) {
		if (value !== undefined && value !== null && value !== '') return String(value).trim()
	}
	return ''
}

function maskPhoneText(value) {
	return String(value || '').replace(/(^|[^\d])(1[3-9]\d{9})(?=$|[^\d])/g, (_match, prefix, phone) => `${prefix}${maskPhone(phone)}`)
}

function minimalLeadName(value) {
	const text = maskPhoneText(firstNonEmpty(value)).trim()
	const [first = '客'] = Array.from(text)
	return `${first}*`
}

function actorInstitution(req) {
	const user = req._teacherUser || {}
	return firstValidInstitution(
		user.institution,
		user.bankName,
		user.company
	)
}

function institutionMatches(req, contact) {
	if (req._teacherUser && hasRole(req._teacherUser, ['admin'])) return true
	const staffInstitution = normalizedInstitution(actorInstitution(req))
	const contactInstitution = normalizedInstitution(contactInstitutionOf(contact))
	if (!staffInstitution || !contactInstitution) return false
	return institutionTextMatches(staffInstitution, contactInstitution)
}

function bankContactsOf(state, req) {
	return (state.advisorContacts || []).filter((item) => contactChannelOf(item) === 'bank' && teacherCanListContact(req, item))
}

function contactIdOf(item = {}) {
	return String(item._id || item.id || item.contactId || '').trim()
}

function isBankServiceGroup(item = {}) {
	return contactChannelOf(item) === 'bank' && (item.serviceRequired === true || item.groupMode === 'service-bank-customer' || item.contactType === 'match-product')
}

function advisorTargetLocked(contact = {}) {
	return !!(
		(!isBankServiceGroup(contact) && contact.advisorId) ||
		contact.advisorAssigneeId ||
		contact.invitedAdvisorId ||
		(Array.isArray(contact.advisorInviteRecords) && contact.advisorInviteRecords.some((invite) => invite.advisorId))
	)
}

function teacherCanListContact(req, contact) {
	if (req._teacherUser && hasRole(req._teacherUser, ['admin'])) return true
	if (!institutionMatches(req, contact)) return false
	if (!isBankServiceGroup(contact)) {
		const actorId = String(req.user && req.user.uid || '')
		if (contact.advisorAssigneeId) return advisorAssignmentIsProven(contact, actorId)
		const invites = Array.isArray(contact.advisorInviteRecords) ? contact.advisorInviteRecords : []
		if (contact.invitedAdvisorId || invites.length) {
			return invites.some((invite) => provenAdvisorInviteMatches(req, contact, invite))
		}
		if (contact.advisorId) return String(contact.advisorId) === actorId
		return true
	}
	if (isBankServiceGroup(contact) && advisorTargetLocked(contact)) return advisorHasGroupAccess(req, contact)
	return true
}

function advisorInviteMatches(req, contact = {}, invite = {}) {
	const actorId = String(req.user && req.user.uid || '')
	if (
		!actorId ||
		String(contact.invitedAdvisorId || '') !== actorId ||
		!invite.advisorId ||
		String(invite.advisorId) !== actorId
	) return false
	return institutionTextMatches(actorInstitution(req), invite.institution) &&
		institutionTextMatches(contactInstitutionOf(contact), invite.institution)
}

function isServerSystemMessage(message = {}) {
	return String(message.senderType || '').toLowerCase() === 'system' &&
		String(message.senderRole || '').toLowerCase() === 'system' &&
		String(message.senderId || '').toLowerCase() === 'system'
}

function advisorAssignmentIsProven(contact = {}, actorId = '') {
	if (!actorId || String(contact.advisorAssigneeId || '') !== actorId) return false
	if (String(contact.advisorStatus || '').toLowerCase() !== 'assigned') return false
	const assignedAt = String(contact.advisorAssignedAt || '')
	const assigneeName = String(contact.advisorAssigneeName || '')
	if (!assignedAt || !assigneeName) return false
	const expectedContent = `${assigneeName}已接入本机构客户咨询。`
	return (Array.isArray(contact.messages) ? contact.messages : []).some((message) => (
		isServerSystemMessage(message) &&
		String(message.createdAt || '') === assignedAt &&
		(
			(
				String(message.eventType || '') === 'advisor-claimed' &&
				String(message.advisorId || '') === actorId &&
				String(message.claimedAt || '') === assignedAt
			) || (
				!message.eventType &&
				String(message.content || '') === expectedContent
			)
		)
	))
}

function provenAdvisorInviteMatches(req, contact = {}, invite = {}) {
	const inviteId = String(invite.id || invite.inviteId || '')
	if (!inviteId || !advisorInviteMatches(req, contact, invite)) return false
	return (Array.isArray(contact.messages) ? contact.messages : []).some((message) => (
		isServerSystemMessage(message) &&
		String(message.eventType || '') === 'advisor-invited' &&
		String(message.inviteId || '') === inviteId
	))
}

function advisorHasGroupAccess(req, contact) {
	if (req._teacherUser && hasRole(req._teacherUser, ['admin'])) return true
	if (!isBankServiceGroup(contact)) return true
	if (!institutionMatches(req, contact)) return false
	const actorId = String(req.user && req.user.uid || '')
	if (advisorAssignmentIsProven(contact, actorId)) return true
	const invites = Array.isArray(contact.advisorInviteRecords) ? contact.advisorInviteRecords : []
	return invites.some((invite) => provenAdvisorInviteMatches(req, contact, invite))
}

function isTeacherAdmin(req) {
	return !!(req._teacherUser && hasRole(req._teacherUser, ['admin']))
}

/**
 * 客户 UID 本身不是授权凭据。普通老师必须在具体 contact 上拥有可验证的
 * 分配、定向服务或邀请关系；仅机构相同不足以读取客户详情。
 */
function teacherHasCaseRelationship(req, contact = {}) {
	if (isTeacherAdmin(req)) return true
	if (contactChannelOf(contact) !== 'bank' || !institutionMatches(req, contact)) return false
	const actorId = String(req.user && req.user.uid || '')
	if (!actorId) return false
	if (!isBankServiceGroup(contact)) {
		// 一旦进入正式分配或邀请流程，旧 advisorId 不再具备授权效力。
		// 与 business.advisorCanReadContact 保持一致：assignment > invite > direct target。
		if (contact.advisorAssigneeId) return advisorAssignmentIsProven(contact, actorId)
		const invites = Array.isArray(contact.advisorInviteRecords) ? contact.advisorInviteRecords : []
		if (contact.invitedAdvisorId || invites.length) {
			return invites.some((invite) => provenAdvisorInviteMatches(req, contact, invite))
		}
		return !!contact.advisorId && String(contact.advisorId) === actorId
	}

	// match-product/service-bank-customer 必须经过客服邀请或正式接单，防止客户伪造 advisorId 绕过确认。
	if (advisorAssignmentIsProven(contact, actorId)) return true

	const invites = Array.isArray(contact.advisorInviteRecords) ? contact.advisorInviteRecords : []
	return invites.some((invite) => provenAdvisorInviteMatches(req, contact, invite))
}

function teacherHasMaterialAccess(req, contact = {}) {
	if (isTeacherAdmin(req)) return true
	if (!teacherHasCaseRelationship(req, contact) || !advisorHasGroupAccess(req, contact)) return false
	if (!isBankServiceGroup(contact)) return true
	const actorId = String(req.user && req.user.uid || '')
	return advisorAssignmentIsProven(contact, actorId)
}

function publicMessageForTeacher(message = {}) {
	return {
		id: firstNonEmpty(message.id, message.messageId),
		senderType: firstNonEmpty(message.senderType),
		senderRole: firstNonEmpty(message.senderRole),
		senderName: maskPhoneText(firstNonEmpty(message.senderName)),
		content: maskPhoneText(firstNonEmpty(message.content, message.text)),
		createdAt: firstNonEmpty(message.createdAt, message.createTime),
		messageSequence: Number(message.messageSequence || message.sequence || 0) || 0,
		sequence: Number(message.sequence || message.messageSequence || 0) || 0
	}
}

function publicMaterialForTeacher(material = {}) {
	return {
		id: firstNonEmpty(material.id, material.materialId, material.key, material.code),
		materialId: firstNonEmpty(material.materialId, material.id, material.key, material.code),
		name: maskPhoneText(firstNonEmpty(material.name, material.materialName, material.title, material.label)),
		status: firstNonEmpty(material.status, material.state),
		statusText: maskPhoneText(firstNonEmpty(material.statusText)),
		reviewNote: maskPhoneText(firstNonEmpty(material.reviewNote, material.rejectReason)),
		reviewedAt: firstNonEmpty(material.reviewedAt, material.reviewTime),
		executionRecordId: firstNonEmpty(material.executionRecordId),
		debtId: firstNonEmpty(material.debtId),
		reportId: firstNonEmpty(material.reportId),
		uploadUrl: firstNonEmpty(material.uploadUrl, material.url, material.fileUrl),
		fileName: maskPhoneText(firstNonEmpty(material.fileName, material.nameOnDisk, material.uploadName)),
		uploadedAt: firstNonEmpty(material.uploadedAt, material.createdAt)
	}
}

function publicNoteForTeacher(note = {}) {
	if (typeof note === 'string') return { text: maskPhoneText(note), createdAt: '' }
	return {
		id: firstNonEmpty(note.id, note.noteId),
		text: maskPhoneText(firstNonEmpty(note.text, note.content, note.note)),
		createdAt: firstNonEmpty(note.createdAt, note.createTime)
	}
}

function publicProductForTeacher(product = {}) {
	if (!product || typeof product !== 'object' || Array.isArray(product)) return null
	return {
		id: firstNonEmpty(product.id, product.productId),
		name: maskPhoneText(firstNonEmpty(product.name, product.productName, product.title)),
		institution: firstNonEmpty(product.institution, product.bankName),
		parentInstitution: firstNonEmpty(product.parentInstitution),
		rateText: firstNonEmpty(product.rateText, product.interestRate),
		amountText: firstNonEmpty(product.amountText, product.amount),
		termText: firstNonEmpty(product.termText, product.term, product.periodText)
	}
}

function publicContextForTeacher(context = {}) {
	if (!context || typeof context !== 'object' || Array.isArray(context)) return null
	return {
		reportId: firstNonEmpty(context.reportId),
		caseId: firstNonEmpty(context.caseId),
		clientReportId: firstNonEmpty(context.clientReportId),
		sourceReportId: firstNonEmpty(context.sourceReportId),
		productId: firstNonEmpty(context.productId),
		productName: firstNonEmpty(context.productName),
		institution: firstNonEmpty(context.institution),
		parentInstitution: firstNonEmpty(context.parentInstitution),
		rateText: firstNonEmpty(context.rateText),
		amountText: firstNonEmpty(context.amountText),
		termText: firstNonEmpty(context.termText),
		matchRate: Number.isFinite(Number(context.matchRate)) ? Number(context.matchRate) : null,
		contactIntent: firstNonEmpty(context.contactIntent),
		businessType: firstNonEmpty(context.businessType),
		serviceType: firstNonEmpty(context.serviceType),
		product: publicProductForTeacher(context.product)
	}
}

function publicMaterialProgressForTeacher(value = {}) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
	const out = {}
	;['total', 'uploaded', 'pendingReview', 'confirmed', 'rejected', 'unavailable', 'pendingSupplement', 'draft'].forEach((key) => {
		const amount = Number(value[key])
		if (Number.isFinite(amount) && amount >= 0) out[key] = amount
	})
	if (value.completionState) out.completionState = String(value.completionState)
	return out
}

function publicBankContactForTeacher(req, contact = {}) {
	const chatAccess = teacherHasCaseRelationship(req, contact) && advisorHasGroupAccess(req, contact)
	const materialAccess = teacherHasMaterialAccess(req, contact)
	const messages = chatAccess && Array.isArray(contact.messages) ? contact.messages.map(publicMessageForTeacher) : []
	const notes = chatAccess && Array.isArray(contact.notes) ? contact.notes.map(publicNoteForTeacher) : []
	const materials = materialAccess && Array.isArray(contact.materials) ? contact.materials.map(publicMaterialForTeacher) : []
	const supplementMaterials = materialAccess && Array.isArray(contact.supplementMaterials) ? contact.supplementMaterials.map(publicMaterialForTeacher) : []
	const materialCount = Math.max(
		Number(contact.materialCount || 0) || 0,
		Array.isArray(contact.materials) ? contact.materials.length : 0,
		Array.isArray(contact.supplementMaterials) ? contact.supplementMaterials.length : 0
	)
	const product = publicProductForTeacher(contact.product)
	const context = publicContextForTeacher(contact.context)
	const advisorInfo = contact.advisorInfo && typeof contact.advisorInfo === 'object' && !Array.isArray(contact.advisorInfo)
		? {
			name: maskPhoneText(firstNonEmpty(contact.advisorInfo.name)),
			role: firstNonEmpty(contact.advisorInfo.role),
			bank: maskPhoneText(firstNonEmpty(contact.advisorInfo.bank)),
			avatar: firstNonEmpty(contact.advisorInfo.avatar)
		}
		: null
	return {
		id: contactIdOf(contact),
		contactId: contactIdOf(contact),
		userId: firstNonEmpty(contact.userId),
		reportId: firstNonEmpty(contact.reportId, context && context.reportId),
		caseId: firstNonEmpty(contact.caseId, context && context.caseId),
		clientReportId: firstNonEmpty(contact.clientReportId, context && context.clientReportId),
		sourceReportId: firstNonEmpty(contact.sourceReportId, context && context.sourceReportId),
		status: firstNonEmpty(contact.status, 'pending'),
		contactType: firstNonEmpty(contact.contactType, 'phone'),
		channel: contactChannelOf(contact),
		createTime: firstNonEmpty(contact.createTime, contact.createdAt),
		createdAt: firstNonEmpty(contact.createdAt, contact.createTime),
		updateTime: firstNonEmpty(contact.updateTime, contact.updatedAt),
		updatedAt: firstNonEmpty(contact.updatedAt, contact.updateTime),
		productId: firstNonEmpty(contact.productId, context && context.productId, product && product.id),
		productName: firstNonEmpty(contact.productName, context && context.productName, product && product.name),
		institution: contactInstitutionOf(contact),
		parentInstitution: firstNonEmpty(contact.parentInstitution, context && context.parentInstitution, product && product.parentInstitution),
		rateText: firstNonEmpty(contact.rateText, context && context.rateText, product && product.rateText),
		amountText: firstNonEmpty(contact.amountText, context && context.amountText, product && product.amountText),
		termText: firstNonEmpty(contact.termText, context && context.termText, product && product.termText),
		matchRate: Number.isFinite(Number(contact.matchRate)) ? Number(contact.matchRate) : (context && context.matchRate),
		summary: chatAccess ? maskPhoneText(firstNonEmpty(contact.summary, contact.desc)) : '',
		groupMode: firstNonEmpty(contact.groupMode),
		serviceRequired: contact.serviceRequired === true,
		serviceStatus: firstNonEmpty(contact.serviceStatus),
		serviceAssigneeName: maskPhoneText(firstNonEmpty(contact.serviceAssigneeName)),
		advisorStatus: firstNonEmpty(contact.advisorStatus),
		advisorAssigneeName: maskPhoneText(firstNonEmpty(contact.advisorAssigneeName)),
		advisorJoinRequired: !chatAccess,
		chatAccess,
		advisorAccessText: chatAccess ? '' : '待客服确认邀请后可进入群聊',
		materialAccess,
		materialsRedacted: !materialAccess && materialCount > 0,
		materialAccessText: materialAccess ? '' : (materialCount > 0 ? '接单后可查看客户资料' : '暂无客户资料'),
		materialCount,
		materialProgressSummary: publicMaterialProgressForTeacher(contact.materialProgressSummary),
		messages,
		notes,
		materials,
		supplementMaterials,
		product,
		context,
		advisorInfo,
		visibleMessageCount: messages.length,
		totalMessageCount: Array.isArray(contact.messages) ? contact.messages.length : 0
	}
}

function normalizedScopeId(value) {
	return String(value || '').trim().replace(/^local_/, '')
}

function reportScopeIds(value = {}) {
	const context = value.context && typeof value.context === 'object' && !Array.isArray(value.context) ? value.context : {}
	return new Set([
		value.id,
		value._id,
		value.reportId,
		value.caseId,
		value.clientReportId,
		value.sourceReportId,
		context.reportId,
		context.caseId,
		context.clientReportId,
		context.sourceReportId
	].map(normalizedScopeId).filter(Boolean))
}

function contactReportScopeIds(value = {}) {
	const context = value.context && typeof value.context === 'object' && !Array.isArray(value.context) ? value.context : {}
	return new Set([
		value.reportId,
		value.caseId,
		value.clientReportId,
		value.sourceReportId,
		context.reportId,
		context.caseId,
		context.clientReportId,
		context.sourceReportId
	].map(normalizedScopeId).filter(Boolean))
}

function reportBoundToContacts(report = {}, contacts = []) {
	const reportIds = reportScopeIds(report)
	if (reportIds.size === 0) return false
	return contacts.some((contact) => {
		const contactIds = contactReportScopeIds(contact)
		return [...reportIds].some((id) => contactIds.has(id))
	})
}

/** 所有老师端路由的守门中间件 */
function teacherOnly(req, res, next) {
	if (!TEACHER_ENABLED) {
		return fail(res, 3003, '老师端功能未启用，请联系管理员', null, 403)
	}
	const user = store.findUserById(req.user.uid)
	if (!user || !hasRole(user, ['advisor', 'admin'])) {
		return fail(res, 3003, '仅银行老师可访问此功能', null, 403)
	}
	req._teacherUser = user
	next()
}

router.use('/api/teacher', authRequired, teacherOnly)

// ─── 工作台数据 ──────────────────────────────────────

router.get('/api/teacher/workbench', (req, res) => {
	try {
		const s = store.state()
			const contacts = bankContactsOf(s, req)

		// 按现实时间聚合统计
		const now = new Date()
		const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
		const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()

		const pending = contacts.filter((c) => {
			const st = String(c.status || '')
			return st === 'pending' || st === 'processing' || st === 'new'
		})

		const todayNew = contacts.filter((c) => {
			const t = new Date(c.createTime || '').getTime()
			return t >= todayStart
		})

		const monthDone = contacts.filter((c) => {
			const st = String(c.status || '')
			const t = new Date(c.createTime || '').getTime()
			return (st === 'completed' || st === 'done' || st === 'resolved') && t >= monthStart
		})

		// 最近咨询客户（去重 userId）
		const seen = new Set()
		const recentClients = []
		for (const c of contacts) {
			const visible = publicBankContactForTeacher(req, c)
			const identityAccess = teacherHasCaseRelationship(req, c)
			const uid = c.userId
			if (!uid || seen.has(uid)) continue
			seen.add(uid)
			const user = store.findUserById(uid)
			recentClients.push({
				id: identityAccess ? uid : visible.contactId,
				clientId: identityAccess ? uid : visible.contactId,
				contactId: visible.contactId,
				name: identityAccess
					? maskPhoneText((user && user.nickname) || '未命名客户')
					: minimalLeadName(user && user.nickname),
				phone: identityAccess && user && user.phone ? maskPhone(user.phone) : '',
				phoneMasked: identityAccess && user && user.phone ? maskPhone(user.phone) : '',
				time: c.createTime || '',
				status: c.status || 'pending',
				statusText: { pending: '待处理', processing: '处理中', completed: '已完成', cancelled: '已取消' }[c.status] || '待处理',
				productName: c.productName || (c.product && c.product.name) || '匹配方案',
				institution: visible.institution,
				advisorJoinRequired: visible.advisorJoinRequired,
				chatAccess: visible.chatAccess,
				advisorAccessText: visible.advisorAccessText
			})
			if (recentClients.length >= 10) break
		}

		return ok(res, {
			stats: {
				todayNew: todayNew.length,
				pending: pending.length,
				monthDone: monthDone.length
			},
			recentClients,
			source: 'teacher-workbench'
		})
	} catch (e) {
		logger.error({ err: e }, 'teacher/workbench failed')
		return fail(res, 5000, '获取工作台数据失败')
	}
})

// ─── 客户列表 ──────────────────────────────────────

router.get('/api/teacher/clients', (req, res) => {
	try {
		const s = store.state()
			const contacts = bankContactsOf(s, req)

		// 按 userId 去重聚合
		const clientMap = new Map()
		for (const c of contacts) {
			const uid = c.userId
			if (!uid) continue
			const identityAccess = teacherHasCaseRelationship(req, c)
			if (!clientMap.has(uid)) {
				const user = store.findUserById(uid)
				clientMap.set(uid, {
					id: identityAccess ? uid : contactIdOf(c),
					clientId: identityAccess ? uid : contactIdOf(c),
					contactId: contactIdOf(c),
					name: identityAccess
						? maskPhoneText((user && user.nickname) || '未命名客户')
						: minimalLeadName(user && user.nickname),
					phone: identityAccess && user && user.phone ? maskPhone(user.phone) : '',
					phoneMasked: identityAccess && user && user.phone ? maskPhone(user.phone) : '',
					identityAccess,
					contactCount: 0,
					latestTime: '',
					latestStatus: 'pending'
				})
			}
			const entry = clientMap.get(uid)
			if (identityAccess && !entry.identityAccess) {
				const user = store.findUserById(uid)
				entry.id = uid
				entry.clientId = uid
				entry.name = maskPhoneText((user && user.nickname) || '未命名客户')
				entry.phone = user && user.phone ? maskPhone(user.phone) : ''
				entry.phoneMasked = entry.phone
				entry.identityAccess = true
			}
			entry.contactCount += 1
			const t = c.createTime || ''
			if (!entry.latestTime || t > entry.latestTime) {
				entry.latestTime = t
				entry.latestStatus = c.status || 'pending'
			}
		}

		const clients = [...clientMap.values()]
			.sort((a, b) => String(b.latestTime).localeCompare(String(a.latestTime)))
			.map(({ identityAccess: _identityAccess, ...c }) => ({
				...c,
				time: c.latestTime ? formatRelative(c.latestTime) : '未知时间',
				status: c.latestStatus,
				statusText: { pending: '待处理', processing: '处理中', completed: '已完成', cancelled: '已取消' }[c.latestStatus] || '处理中'
			}))

		return ok(res, { clients, source: 'teacher-clients' })
	} catch (e) {
		logger.error({ err: e }, 'teacher/clients failed')
		return fail(res, 5000, '获取客户列表失败')
	}
})

// ─── 客户详情 ──────────────────────────────────────

router.get('/api/teacher/client/:uid', (req, res) => {
	const uid = String(req.params.uid || '')
	if (!uid) return fail(res, 1001, '缺少客户 uid')

	try {
		const s = store.state()
		const adminAudit = isTeacherAdmin(req)
		const contacts = bankContactsOf(s, req)
			.filter((c) => String(c.userId || '') === uid)
			.filter((c) => adminAudit || teacherHasCaseRelationship(req, c))
			.sort((a, b) => String(b.createTime || '').localeCompare(String(a.createTime || '')))
			.map((c) => ({
				...publicBankContactForTeacher(req, c),
				time: formatRelative(c.createTime),
				createTs: new Date(c.createTime || '').getTime(),
				status: c.status || 'pending',
				statusText: { pending: '待处理', processing: '处理中', completed: '已完成', cancelled: '已取消' }[c.status] || '处理中',
				contactType: c.contactType || 'phone',
				channel: contactChannelOf(c)
			}))

		// 不先读取用户档案：普通老师对无案件关系的已知/未知 UID 得到同一响应，
		// 避免把客户 UID 当作可枚举的授权入口。
		if (!adminAudit && contacts.length === 0) {
			return fail(res, 3003, '无权访问该客户', null, 403)
		}
		const user = store.findUserById(uid)
		if (!user) return fail(res, 2001, '客户不存在')

		const reports = (s.reports || [])
			.filter((r) => String(r.userId || '') === uid)
			.filter((r) => adminAudit || reportBoundToContacts(r, contacts))
			.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
			.slice(0, 5)
			.map((r) => ({
				id: r.id || r._id,
				reportId: r.id || r._id,
				time: formatRelative(r.createdAt),
				reportType: r.reportType || '征信报告',
				// 本摘要端点没有执行 canonical task/evidence replay，历史存量分数不得作为权威决策值输出。
				score: null,
				scoreVerified: false,
				scoreState: 'unavailable'
			}))

		return ok(res, {
			client: {
				id: uid,
				name: maskPhoneText(user.nickname || '未命名客户'),
				phone: user.phone ? maskPhone(user.phone) : '', phoneMasked: user.phone ? maskPhone(user.phone) : '',
				contactCount: contacts.length,
				reportCount: reports.length,
				latestTime: contacts.length > 0 ? contacts[0].time : '暂无记录'
			},
			contacts,
			reports,
			source: 'teacher-client-detail'
		})
	} catch (e) {
		logger.error({ err: e }, 'teacher/client/detail failed')
		return fail(res, 5000, '获取客户详情失败')
	}
})

// ─── 客户任务列表（待处理联系记录） ─────────────────

router.get('/api/teacher/tasks', (req, res) => {
	try {
		const s = store.state()
			const contacts = bankContactsOf(s, req)

		const pendingContacts = contacts
			.filter((c) => {
				const st = String(c.status || '')
				return st === 'pending' || st === 'processing' || st === 'new'
			})
			.sort((a, b) => String(b.createTime || '').localeCompare(String(a.createTime || '')))

		const tasks = pendingContacts.map((c) => {
			const visible = publicBankContactForTeacher(req, c)
			const identityAccess = teacherHasCaseRelationship(req, c)
			const user = store.findUserById(c.userId)
			return {
				id: visible.contactId,
				contactId: visible.contactId,
				clientId: identityAccess ? (c.userId || '') : visible.contactId,
				title: `${identityAccess ? maskPhoneText((user && user.nickname) || '客户') : minimalLeadName(user && user.nickname)} 的咨询跟进`,
				desc: identityAccess
					? ((user && user.phone) ? `联系电话：${maskPhone(user.phone)}` : '待确认联系方式')
					: '接单后可查看客户联系方式',
				time: formatRelative(c.createTime),
				status: c.status || 'pending',
				statusText: { pending: '待处理', processing: '处理中' }[c.status] || '待处理',
				priority: c.status === 'pending' ? 'high' : 'normal',
				productName: c.productName || (c.product && c.product.name) || '匹配方案',
				institution: visible.institution,
				advisorJoinRequired: visible.advisorJoinRequired,
				chatAccess: visible.chatAccess,
				advisorAccessText: visible.advisorAccessText
			}
		})

		return ok(res, { tasks, source: 'teacher-tasks' })
	} catch (e) {
		logger.error({ err: e }, 'teacher/tasks failed')
		return fail(res, 5000, '获取任务列表失败')
	}
})

// ─── 工具函数 ──────────────────────────────────────

function formatRelative(isoStr) {
	if (!isoStr) return '未知时间'
	const d = new Date(isoStr)
	if (isNaN(d.getTime())) return '未知时间'
	const now = new Date()
	const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
	if (sameDay) {
		const hh = String(d.getHours()).padStart(2, '0')
		const mm = String(d.getMinutes()).padStart(2, '0')
		return `今天 ${hh}:${mm}`
	}
	const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
	if (d.getFullYear() === yesterday.getFullYear() && d.getMonth() === yesterday.getMonth() && d.getDate() === yesterday.getDate()) {
		const hh = String(d.getHours()).padStart(2, '0')
		const mm = String(d.getMinutes()).padStart(2, '0')
		return `昨天 ${hh}:${mm}`
	}
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

module.exports = router
