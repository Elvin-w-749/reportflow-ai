'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-teacher-detail-auth-'))
process.env.DATA_DIR = dataDir
process.env.JWT_SECRET = 'teacher-detail-authorization-test-secret'
process.env.NODE_ENV = 'test'
process.env.TEACHER_ENABLE = 'true'
process.env.RPT_RELEASE_ID = ''
process.env.RPT_GIT_COMMIT = ''

const express = require('express')
const jwt = require('jsonwebtoken')
const store = require('../backend/db/store')
const teacherRoutes = require('../backend/routes/teacher')

function tokenFor(user) {
	return jwt.sign({
		uid: user.id,
		phone: user.phone,
		tokenVersion: Number(user.tokenVersion || 0)
	}, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })
}

async function get(baseUrl, token, pathname) {
	const response = await fetch(`${baseUrl}${pathname}`, {
		headers: { Authorization: `Bearer ${token}` }
	})
	return { response, payload: await response.json() }
}

function makeContact(id, userId, extra = {}) {
	return {
		_id: id,
		id,
		contactId: id,
		userId,
		channel: 'bank',
		institution: '示例银行',
		status: 'processing',
		createTime: '2026-08-16T08:00:00.000Z',
		phone: 'CONTACT_PHONE_MUST_NOT_LEAK',
		mobile: 'CONTACT_MOBILE_MUST_NOT_LEAK',
		passwordHash: 'CONTACT_PASSWORD_HASH_MUST_NOT_LEAK',
		internalSecret: 'CONTACT_INTERNAL_SECRET_MUST_NOT_LEAK',
		context: {
			phone: 'CONTEXT_PHONE_MUST_NOT_LEAK',
			internalPayload: 'CONTEXT_INTERNAL_MUST_NOT_LEAK'
		},
		messages: [{
			id: `message_${id}`,
			senderType: 'user',
			content: `可见案件消息 ${id}`,
			createdAt: '2026-08-16T08:01:00.000Z',
			phone: 'MESSAGE_PHONE_MUST_NOT_LEAK',
			internalNote: 'MESSAGE_INTERNAL_MUST_NOT_LEAK'
		}],
		materials: [{
			id: `material_${id}`,
			name: `案件材料 ${id}`,
			status: 'provided',
			uploadUrl: `https://files.example.invalid/${id}`,
			binaryPayload: 'MATERIAL_BINARY_MUST_NOT_LEAK',
			ownerPhone: 'MATERIAL_PHONE_MUST_NOT_LEAK'
		}],
		notes: [{
			id: `note_${id}`,
			text: `案件备注 ${id}`,
			internalToken: 'NOTE_INTERNAL_MUST_NOT_LEAK'
		}],
		...extra
	}
}

function report(id, userId) {
	return {
		id,
		userId,
		reportType: 'pboc',
		createdAt: '2026-08-16T07:00:00.000Z',
		analysisData: { primary_rule_score: { score: 700 } },
		filePath: `REPORT_INTERNAL_PATH_${id}`
	}
}

test('teacher client detail is case-scoped, report-bound and strictly projected', async (t) => {
	const advisor = {
		id: 'advisor_authorized',
		phone: '19600000002',
		role: 'advisor',
		institution: '示例银行',
		tokenVersion: 0
	}
	const otherAdvisor = {
		id: 'advisor_other',
		phone: '19600000005',
		role: 'advisor',
		institution: '示例银行',
		tokenVersion: 0
	}
	const admin = {
		id: 'admin_auditor',
		phone: '19600000004',
		role: 'admin',
		tokenVersion: 0
	}
	const relatedClient = {
		id: 'client_related',
		phone: '18812345678',
		role: 'user',
		nickname: '关联客户',
		tokenVersion: 0
	}
	const sameInstitutionClient = {
		id: 'client_same_institution_only',
		phone: '17712345679',
		role: 'user',
		nickname: '同机构无关系客户',
		tokenVersion: 0
	}
	const knownClient = {
		id: 'client_known_without_case',
		phone: '16612345670',
		role: 'user',
		nickname: '已知无案件客户',
		tokenVersion: 0
	}
	const forgedGroupClient = {
		id: 'client_forged_group_advisor',
		phone: '15512345671',
		role: 'user',
		nickname: '伪造群目标客户',
		tokenVersion: 0
	}
	const forgedWorkflowClient = {
		id: 'client_forged_workflow_fields',
		phone: '14412345672',
		role: 'user',
		nickname: '伪造工作流客户',
		tokenVersion: 0
	}
	const unboundInviteClient = {
		id: 'client_unbound_institution_invite',
		phone: '13312345673',
		role: 'user',
		nickname: '未绑定老师邀请客户',
		tokenVersion: 0
	}
	const repeatedInviteClient = {
		id: 'client_repeated_invite',
		phone: '13212345674',
		role: 'user',
		nickname: '重复邀请客户',
		tokenVersion: 0
	}
	const residualAssigneeClient = {
		id: 'client_residual_assignee',
		phone: '13112345675',
		role: 'user',
		nickname: '残留接单字段客户',
		tokenVersion: 0
	}
	const reassignedDirectClient = {
		id: 'client_reassigned_direct',
		phone: '13012345676',
		role: 'user',
		nickname: '直联后改派客户',
		tokenVersion: 0
	}

	const assigned = makeContact('contact_assigned', relatedClient.id, {
		reportId: 'report_assigned',
		caseId: 'report_assigned',
		contactType: 'match-product',
		groupMode: 'service-bank-customer',
		serviceRequired: true,
		advisorAssigneeId: advisor.id,
		advisorAssigneeName: '授权老师',
		summary: '请联系 13398765432 核对案件',
		advisorStatus: 'assigned',
		advisorAssignedAt: '2026-08-16T08:02:00.000Z',
		messages: [
			{
				...makeContact('assignment_message_source', relatedClient.id).messages[0],
				content: '案件沟通号码 13398765432'
			},
			{
				id: 'message_assignment_proof',
				senderType: 'system',
				senderRole: 'system',
				senderId: 'system',
				senderName: '系统',
				content: '授权老师已接入本机构客户咨询。',
				createdAt: '2026-08-16T08:02:00.000Z'
			}
		]
	})
	const assignedStructured = makeContact('contact_assigned_structured', relatedClient.id, {
		reportId: 'report_assigned_structured',
		caseId: 'report_assigned_structured',
		contactType: 'match-product',
		groupMode: 'service-bank-customer',
		serviceRequired: true,
		advisorAssigneeId: advisor.id,
		advisorAssigneeName: '授权老师',
		advisorStatus: 'assigned',
		advisorAssignedAt: '2026-08-16T08:02:30.000Z',
		messages: [{
			id: 'message_assignment_structured_proof',
			senderType: 'system',
			senderRole: 'system',
			senderId: 'system',
			senderName: '系统',
			content: '结构化接单事件',
			eventType: 'advisor-claimed',
			advisorId: advisor.id,
			claimedAt: '2026-08-16T08:02:30.000Z',
			createdAt: '2026-08-16T08:02:30.000Z'
		}]
	})
	const invited = makeContact('contact_invited', relatedClient.id, {
		reportId: 'report_invited',
		caseId: 'report_invited',
		contactType: 'match-product',
		groupMode: 'service-bank-customer',
		serviceRequired: true,
		advisorStatus: 'invited',
		invitedAdvisorId: advisor.id,
		advisorInviteRecords: [{
			id: 'invite_authorized',
			advisorId: advisor.id,
			institution: '示例银行',
			internalToken: 'INVITE_INTERNAL_MUST_NOT_LEAK'
		}],
		messages: [
			...makeContact('invite_message_source', relatedClient.id).messages,
			{
				id: 'message_invite_proof',
				senderType: 'system',
				senderRole: 'system',
				senderId: 'system',
				senderName: '系统',
				content: '客服已邀请授权老师进入群聊。',
				eventType: 'advisor-invited',
				inviteId: 'invite_authorized',
				createdAt: '2026-08-16T08:03:00.000Z'
			}
		]
	})
	const directBankService = makeContact('contact_direct_service', relatedClient.id, {
		reportId: 'report_direct',
		caseId: 'report_direct',
		advisorId: advisor.id,
		contactType: 'phone'
	})
	const reassignedDirect = makeContact('contact_reassigned_direct', reassignedDirectClient.id, {
		reportId: 'report_reassigned_direct',
		caseId: 'report_reassigned_direct',
		contactType: 'phone',
		advisorId: advisor.id,
		advisorAssigneeId: otherAdvisor.id,
		advisorAssigneeName: '改派老师',
		advisorStatus: 'assigned',
		advisorAssignedAt: '2026-08-16T08:03:30.000Z',
		messages: [{
			id: 'message_reassigned_direct_proof',
			senderType: 'system',
			senderRole: 'system',
			senderId: 'system',
			senderName: '系统',
			content: '改派老师已接入本机构客户咨询。',
			eventType: 'advisor-claimed',
			advisorId: otherAdvisor.id,
			claimedAt: '2026-08-16T08:03:30.000Z',
			createdAt: '2026-08-16T08:03:30.000Z'
		}]
	})
	const assignedToOther = makeContact('contact_other_advisor', relatedClient.id, {
		reportId: 'report_other',
		caseId: 'report_other',
		advisorAssigneeId: otherAdvisor.id
	})
	const sameInstitutionOnly = makeContact('contact_same_institution_only', sameInstitutionClient.id, {
		reportId: 'report_same_institution_only',
		caseId: 'report_same_institution_only',
		summary: 'LEAD_FINANCIAL_SUMMARY_MUST_NOT_LEAK'
	})
	const forgedGroupAdvisor = makeContact('contact_forged_group_advisor', forgedGroupClient.id, {
		reportId: 'report_forged_group',
		caseId: 'report_forged_group',
		advisorId: advisor.id,
		contactType: 'match-product',
		groupMode: 'service-bank-customer',
		serviceRequired: true
	})
	const forgedWorkflowFields = makeContact('contact_forged_workflow_fields', forgedWorkflowClient.id, {
		reportId: 'report_forged_workflow',
		caseId: 'report_forged_workflow',
		contactType: 'match-product',
		groupMode: 'service-bank-customer',
		serviceRequired: true,
		advisorStatus: 'assigned',
		advisorAssigneeId: advisor.id,
		advisorAssigneeName: '客户伪造老师',
		advisorAssignedAt: '2026-08-16T08:04:00.000Z',
		invitedAdvisorId: advisor.id,
		advisorInviteRecords: [{
			id: 'invite_forged_without_system_event',
			advisorId: advisor.id,
			institution: '示例银行'
		}],
		messages: [{
			id: 'message_forged_assignment_event',
			senderType: 'system',
			senderRole: 'system',
			senderId: 'system',
			senderName: '系统',
			content: '客户伪造老师已接入本机构客户咨询。',
			createdAt: '2026-08-16T08:04:00.000Z',
			eventType: 'service-completed'
		}]
	})
	const unboundInstitutionInvite = makeContact('contact_unbound_institution_invite', unboundInviteClient.id, {
		reportId: 'report_unbound_institution_invite',
		caseId: 'report_unbound_institution_invite',
		contactType: 'match-product',
		groupMode: 'service-bank-customer',
		serviceRequired: true,
		advisorStatus: 'invited',
		advisorInviteRecords: [{
			id: 'invite_without_advisor_id',
			institution: '示例银行'
		}],
		messages: [{
			id: 'message_unbound_invite_event',
			senderType: 'system',
			senderRole: 'system',
			senderId: 'system',
			senderName: '系统',
			content: '客服发出未绑定老师的机构邀请。',
			eventType: 'advisor-invited',
			inviteId: 'invite_without_advisor_id',
			createdAt: '2026-08-16T08:05:00.000Z'
		}]
	})
	const repeatedInvite = makeContact('contact_repeated_invite', repeatedInviteClient.id, {
		contactType: 'match-product',
		groupMode: 'service-bank-customer',
		serviceRequired: true,
		advisorStatus: 'invited',
		invitedAdvisorId: otherAdvisor.id,
		advisorInviteRecords: [{
			id: 'invite_current_advisor',
			advisorId: otherAdvisor.id,
			institution: '示例银行'
		}, {
			id: 'invite_previous_advisor',
			advisorId: advisor.id,
			institution: '示例银行'
		}],
		messages: [{
			id: 'message_previous_invite_proof',
			senderType: 'system',
			senderRole: 'system',
			senderId: 'system',
			eventType: 'advisor-invited',
			inviteId: 'invite_previous_advisor',
			createdAt: '2026-08-16T08:06:00.000Z'
		}, {
			id: 'message_current_invite_proof',
			senderType: 'system',
			senderRole: 'system',
			senderId: 'system',
			eventType: 'advisor-invited',
			inviteId: 'invite_current_advisor',
			createdAt: '2026-08-16T08:07:00.000Z'
		}, {
			id: 'message_repeated_invite_private',
			senderType: 'user',
			senderRole: 'user',
			senderId: repeatedInviteClient.id,
			content: 'REPEATED_INVITE_CHAT_MUST_NOT_LEAK_TO_PREVIOUS_ADVISOR',
			createdAt: '2026-08-16T08:08:00.000Z'
		}]
	})
	const residualAssignee = makeContact('contact_residual_assignee', residualAssigneeClient.id, {
		contactType: 'match-product',
		groupMode: 'service-bank-customer',
		serviceRequired: true,
		advisorStatus: 'assigned',
		advisorAssigneeId: advisor.id,
		advisorAssigneeName: '残留接单字段',
		advisorAssignedAt: '',
		invitedAdvisorId: advisor.id,
		advisorInviteRecords: [{
			id: 'invite_residual_assignee',
			advisorId: advisor.id,
			institution: '示例银行'
		}],
		messages: [{
			id: 'message_residual_invite_proof',
			senderType: 'system',
			senderRole: 'system',
			senderId: 'system',
			eventType: 'advisor-invited',
			inviteId: 'invite_residual_assignee',
			createdAt: '2026-08-16T08:09:00.000Z'
		}],
		materials: [{
			id: 'material_residual_assignee',
			name: '残留接单字段不得解锁的材料',
			uploadUrl: 'https://files.example.invalid/RESIDUAL_ASSIGNEE_MATERIAL_MUST_NOT_LEAK'
		}]
	})

	const state = store.state()
	state.users = [advisor, otherAdvisor, admin, relatedClient, sameInstitutionClient, knownClient, forgedGroupClient, forgedWorkflowClient, unboundInviteClient, repeatedInviteClient, residualAssigneeClient, reassignedDirectClient]
	state.advisorContacts = [assigned, assignedStructured, invited, directBankService, reassignedDirect, assignedToOther, sameInstitutionOnly, forgedGroupAdvisor, forgedWorkflowFields, unboundInstitutionInvite, repeatedInvite, residualAssignee]
	state.reports = [
		report('report_assigned', relatedClient.id),
		report('report_assigned_structured', relatedClient.id),
		report('report_invited', relatedClient.id),
		report('report_direct', relatedClient.id),
		report('report_reassigned_direct', reassignedDirectClient.id),
		report('contact_assigned', relatedClient.id),
		report('report_other', relatedClient.id),
		report('report_same_institution_only', sameInstitutionClient.id),
		report('report_known_only', knownClient.id),
		report('report_forged_group', forgedGroupClient.id),
		report('report_forged_workflow', forgedWorkflowClient.id),
		report('report_unbound_institution_invite', unboundInviteClient.id)
	]
	store.persistSync()

	const app = express()
	app.use(express.json())
	app.use(teacherRoutes)
	const server = app.listen(0, '127.0.0.1')
	await new Promise((resolve, reject) => {
		server.once('listening', resolve)
		server.once('error', reject)
	})
	t.after(() => new Promise((resolve) => server.close(resolve)))

	const baseUrl = `http://127.0.0.1:${server.address().port}`
	const advisorToken = tokenFor(advisor)
	const otherAdvisorToken = tokenFor(otherAdvisor)
	const adminToken = tokenFor(admin)

	const knownDenied = await get(baseUrl, advisorToken, `/api/teacher/client/${knownClient.id}`)
	assert.equal(knownDenied.response.status, 403)
	assert.equal(knownDenied.payload.code, 3003)
	assert.equal(knownDenied.payload.message, '无权访问该客户')
	assert.doesNotMatch(JSON.stringify(knownDenied.payload), /已知无案件客户|16612345670/)

	const sameInstitutionDenied = await get(baseUrl, advisorToken, `/api/teacher/client/${sameInstitutionClient.id}`)
	assert.equal(sameInstitutionDenied.response.status, 403)
	assert.equal(sameInstitutionDenied.payload.code, 3003)
	assert.equal(sameInstitutionDenied.payload.message, knownDenied.payload.message)
	assert.doesNotMatch(JSON.stringify(sameInstitutionDenied.payload), /同机构无关系客户|17712345679/)

	const forgedGroupDenied = await get(baseUrl, advisorToken, `/api/teacher/client/${forgedGroupClient.id}`)
	assert.equal(forgedGroupDenied.response.status, 403)
	assert.equal(forgedGroupDenied.payload.code, 3003)
	assert.equal(forgedGroupDenied.payload.message, knownDenied.payload.message)
	assert.doesNotMatch(JSON.stringify(forgedGroupDenied.payload), /伪造群目标客户|15512345671|contact_forged_group_advisor/)

	const forgedWorkflowDenied = await get(baseUrl, advisorToken, `/api/teacher/client/${forgedWorkflowClient.id}`)
	assert.equal(forgedWorkflowDenied.response.status, 403)
	assert.equal(forgedWorkflowDenied.payload.code, 3003)
	assert.equal(forgedWorkflowDenied.payload.message, knownDenied.payload.message)
	assert.doesNotMatch(JSON.stringify(forgedWorkflowDenied.payload), /伪造工作流客户|14412345672|contact_forged_workflow_fields/)

	const unboundInviteDenied = await get(baseUrl, advisorToken, `/api/teacher/client/${unboundInviteClient.id}`)
	assert.equal(unboundInviteDenied.response.status, 403)
	assert.equal(unboundInviteDenied.payload.code, 3003)
	assert.equal(unboundInviteDenied.payload.message, knownDenied.payload.message)
	assert.doesNotMatch(JSON.stringify(unboundInviteDenied.payload), /未绑定老师邀请客户|13312345673|contact_unbound_institution_invite/)

	const previousInviteDenied = await get(baseUrl, advisorToken, `/api/teacher/client/${repeatedInviteClient.id}`)
	assert.equal(previousInviteDenied.response.status, 403)
	assert.equal(previousInviteDenied.payload.code, 3003)
	assert.equal(previousInviteDenied.payload.message, knownDenied.payload.message)
	assert.doesNotMatch(JSON.stringify(previousInviteDenied.payload), /重复邀请客户|13212345674|contact_repeated_invite|REPEATED_INVITE_CHAT_MUST_NOT_LEAK/)

	const currentInviteAllowed = await get(baseUrl, otherAdvisorToken, `/api/teacher/client/${repeatedInviteClient.id}`)
	assert.equal(currentInviteAllowed.response.status, 200)
	assert.equal(currentInviteAllowed.payload.code, 0)
	assert.deepEqual(currentInviteAllowed.payload.data.contacts.map((item) => item.id), [repeatedInvite.id])
	assert.match(JSON.stringify(currentInviteAllowed.payload), /REPEATED_INVITE_CHAT_MUST_NOT_LEAK_TO_PREVIOUS_ADVISOR/)

	const residualAssigneeAllowed = await get(baseUrl, advisorToken, `/api/teacher/client/${residualAssigneeClient.id}`)
	assert.equal(residualAssigneeAllowed.response.status, 200)
	assert.equal(residualAssigneeAllowed.payload.code, 0)
	assert.deepEqual(residualAssigneeAllowed.payload.data.contacts.map((item) => item.id), [residualAssignee.id])
	assert.equal(residualAssigneeAllowed.payload.data.contacts[0].chatAccess, true)
	assert.equal(residualAssigneeAllowed.payload.data.contacts[0].materialAccess, false)
	assert.deepEqual(residualAssigneeAllowed.payload.data.contacts[0].materials, [])
	assert.doesNotMatch(JSON.stringify(residualAssigneeAllowed.payload), /RESIDUAL_ASSIGNEE_MATERIAL_MUST_NOT_LEAK/)

	const unknownDenied = await get(baseUrl, advisorToken, '/api/teacher/client/client_unknown')
	assert.equal(unknownDenied.response.status, knownDenied.response.status)
	assert.equal(unknownDenied.payload.code, knownDenied.payload.code)
	assert.equal(unknownDenied.payload.message, knownDenied.payload.message)

	const directTargetDeniedToPeer = await get(baseUrl, otherAdvisorToken, `/api/teacher/client/${relatedClient.id}`)
	assert.equal(directTargetDeniedToPeer.response.status, 403)
	assert.equal(directTargetDeniedToPeer.payload.code, 3003)

	const staleDirectTargetDenied = await get(baseUrl, advisorToken, `/api/teacher/client/${reassignedDirectClient.id}`)
	assert.equal(staleDirectTargetDenied.response.status, 403)
	assert.equal(staleDirectTargetDenied.payload.code, 3003)
	assert.doesNotMatch(JSON.stringify(staleDirectTargetDenied.payload), /直联后改派客户|13012345676|contact_reassigned_direct/)

	const verifiedAssigneeAllowed = await get(baseUrl, otherAdvisorToken, `/api/teacher/client/${reassignedDirectClient.id}`)
	assert.equal(verifiedAssigneeAllowed.response.status, 200)
	assert.equal(verifiedAssigneeAllowed.payload.code, 0)
	assert.deepEqual(verifiedAssigneeAllowed.payload.data.contacts.map((item) => item.id), [reassignedDirect.id])
	assert.deepEqual(verifiedAssigneeAllowed.payload.data.reports.map((item) => item.id), ['report_reassigned_direct'])

	const allowed = await get(baseUrl, advisorToken, `/api/teacher/client/${relatedClient.id}`)
	assert.equal(allowed.response.status, 200)
	assert.equal(allowed.payload.code, 0)
	assert.equal(allowed.payload.data.client.phone, '188****78')
	assert.equal(allowed.payload.data.client.phoneMasked, '188****78')
	assert.deepEqual(
		new Set(allowed.payload.data.contacts.map((item) => item.id)),
		new Set(['contact_assigned', 'contact_assigned_structured', 'contact_invited', 'contact_direct_service'])
	)
	assert.deepEqual(
		new Set(allowed.payload.data.reports.map((item) => item.id)),
		new Set(['report_assigned', 'report_assigned_structured', 'report_invited', 'report_direct'])
	)
	allowed.payload.data.reports.forEach((item) => {
		assert.equal(item.score, null)
		assert.equal(item.scoreVerified, false)
		assert.equal(item.scoreState, 'unavailable')
		assert.notEqual(item.score, 700)
	})

	const assignedResult = allowed.payload.data.contacts.find((item) => item.id === assigned.id)
	const assignedStructuredResult = allowed.payload.data.contacts.find((item) => item.id === assignedStructured.id)
	const invitedResult = allowed.payload.data.contacts.find((item) => item.id === invited.id)
	const directResult = allowed.payload.data.contacts.find((item) => item.id === directBankService.id)
	assert.equal(assignedResult.chatAccess, true)
	assert.equal(assignedResult.materialAccess, true)
	assert.equal(assignedResult.messages.length, 2)
	assert.equal(assignedResult.materials.length, 1)
	assert.equal(assignedStructuredResult.chatAccess, true)
	assert.equal(assignedStructuredResult.materialAccess, true)
	assert.equal(invitedResult.chatAccess, true)
	assert.equal(invitedResult.materialAccess, false)
	assert.equal(invitedResult.messages.length, 2)
	assert.deepEqual(invitedResult.materials, [])
	assert.equal(directResult.chatAccess, true)
	assert.equal(directResult.materialAccess, true)

	const serializedAllowed = JSON.stringify(allowed.payload.data)
	;[
		'18812345678',
		'13398765432',
		'CONTACT_PHONE_MUST_NOT_LEAK',
		'CONTACT_MOBILE_MUST_NOT_LEAK',
		'CONTACT_PASSWORD_HASH_MUST_NOT_LEAK',
		'CONTACT_INTERNAL_SECRET_MUST_NOT_LEAK',
		'CONTEXT_PHONE_MUST_NOT_LEAK',
		'CONTEXT_INTERNAL_MUST_NOT_LEAK',
		'MESSAGE_PHONE_MUST_NOT_LEAK',
		'MESSAGE_INTERNAL_MUST_NOT_LEAK',
		'MATERIAL_BINARY_MUST_NOT_LEAK',
		'MATERIAL_PHONE_MUST_NOT_LEAK',
		'NOTE_INTERNAL_MUST_NOT_LEAK',
		'INVITE_INTERNAL_MUST_NOT_LEAK',
		'contact_other_advisor',
		'"id":"contact_assigned","reportId":"contact_assigned"',
		'report_other'
	].forEach((secret) => assert.equal(serializedAllowed.includes(secret), false, `${secret} leaked`))
	assert.equal(serializedAllowed.includes('133****32'), true)
	allowed.payload.data.contacts.forEach((contact) => {
		assert.equal(Object.prototype.hasOwnProperty.call(contact, 'raw'), false)
		assert.equal(Object.prototype.hasOwnProperty.call(contact, 'phone'), false)
		assert.equal(Object.prototype.hasOwnProperty.call(contact, 'mobile'), false)
	})

	const workbench = await get(baseUrl, advisorToken, '/api/teacher/workbench')
	assert.equal(workbench.response.status, 200)
	assert.equal(JSON.stringify(workbench.payload.data).includes('LEAD_FINANCIAL_SUMMARY_MUST_NOT_LEAK'), false)
	assert.equal(JSON.stringify(workbench.payload.data).includes(reassignedDirect.id), false)
	assert.equal(JSON.stringify(workbench.payload.data).includes(reassignedDirectClient.id), false)
	assert.equal(JSON.stringify(workbench.payload.data).includes(sameInstitutionClient.nickname), false)
	assert.equal(JSON.stringify(workbench.payload.data).includes(sameInstitutionClient.id), false)
	const workbenchLead = workbench.payload.data.recentClients.find((item) => item.contactId === sameInstitutionOnly.id)
	assert.equal(workbenchLead.id, sameInstitutionOnly.id)
	assert.equal(workbenchLead.name, '同*')
	assert.equal(workbenchLead.phone, '')
	assert.equal(workbenchLead.phoneMasked, '')
	workbench.payload.data.recentClients.forEach((client) => {
		assert.equal(client.phone, client.phoneMasked)
		assert.equal(/^[0-9]{11}$/.test(client.phone), false)
	})
	const clients = await get(baseUrl, advisorToken, '/api/teacher/clients')
	assert.equal(clients.response.status, 200)
	assert.equal(JSON.stringify(clients.payload.data).includes('LEAD_FINANCIAL_SUMMARY_MUST_NOT_LEAK'), false)
	assert.equal(JSON.stringify(clients.payload.data).includes(reassignedDirect.id), false)
	assert.equal(JSON.stringify(clients.payload.data).includes(reassignedDirectClient.id), false)
	assert.equal(JSON.stringify(clients.payload.data).includes(sameInstitutionClient.nickname), false)
	assert.equal(JSON.stringify(clients.payload.data).includes(sameInstitutionClient.id), false)
	const clientsLead = clients.payload.data.clients.find((item) => item.contactId === sameInstitutionOnly.id)
	assert.equal(clientsLead.id, sameInstitutionOnly.id)
	assert.equal(clientsLead.name, '同*')
	assert.equal(clientsLead.phone, '')
	assert.equal(clientsLead.phoneMasked, '')
	clients.payload.data.clients.forEach((client) => {
		assert.equal(client.phone, client.phoneMasked)
		assert.equal(/^[0-9]{11}$/.test(client.phone), false)
	})
	const tasks = await get(baseUrl, advisorToken, '/api/teacher/tasks')
	assert.equal(tasks.response.status, 200)
	assert.equal(JSON.stringify(tasks.payload.data).includes(reassignedDirect.id), false)
	assert.equal(JSON.stringify(tasks.payload.data).includes(reassignedDirectClient.id), false)
	assert.equal(JSON.stringify(tasks.payload.data).includes(sameInstitutionClient.nickname), false)
	const taskLead = tasks.payload.data.tasks.find((item) => item.contactId === sameInstitutionOnly.id)
	assert.equal(taskLead.clientId, sameInstitutionOnly.id)
	assert.equal(taskLead.title, '同* 的咨询跟进')
	assert.equal(taskLead.desc, '接单后可查看客户联系方式')

	const adminAudit = await get(baseUrl, adminToken, `/api/teacher/client/${sameInstitutionClient.id}`)
	assert.equal(adminAudit.response.status, 200)
	assert.equal(adminAudit.payload.code, 0)
	assert.deepEqual(adminAudit.payload.data.contacts.map((item) => item.id), [sameInstitutionOnly.id])
	assert.deepEqual(adminAudit.payload.data.reports.map((item) => item.id), ['report_same_institution_only'])
	assert.equal(adminAudit.payload.data.client.phone, '177****79')
	assert.equal(Object.prototype.hasOwnProperty.call(adminAudit.payload.data.contacts[0], 'raw'), false)
	assert.equal(JSON.stringify(adminAudit.payload.data).includes('CONTACT_INTERNAL_SECRET_MUST_NOT_LEAK'), false)

	const adminNoCase = await get(baseUrl, adminToken, `/api/teacher/client/${knownClient.id}`)
	assert.equal(adminNoCase.response.status, 200)
	assert.equal(adminNoCase.payload.code, 0)
	assert.deepEqual(adminNoCase.payload.data.contacts, [])
	assert.deepEqual(adminNoCase.payload.data.reports.map((item) => item.id), ['report_known_only'])
})
