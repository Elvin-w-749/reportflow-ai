'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-institution-isolation-'))
process.env.DATA_DIR = dataDir
process.env.JWT_SECRET = 'institution-isolation-test-secret'
process.env.NODE_ENV = 'test'
process.env.TEACHER_ENABLE = 'true'

const jwt = require('jsonwebtoken')
const {
	contactInstitutionOf,
	institutionTextMatches,
	normalizedInstitution
} = require('../backend/utils/institutionPolicy')
const store = require('../backend/db/store')
const { app } = require('../server')

function tokenFor(user, extra = {}) {
	return jwt.sign({
		uid: user.id,
		phone: user.phone,
		tokenVersion: Number(user.tokenVersion || 0),
		...extra
	}, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })
}

async function request(baseUrl, token, method, pathname, body) {
	const response = await fetch(`${baseUrl}${pathname}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			...(body === undefined ? {} : { 'Content-Type': 'application/json' })
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) })
	})
	return { response, payload: await response.json() }
}

function contact(id, userId, institution, extra = {}) {
	return {
		_id: id,
		id,
		contactId: id,
		userId,
		channel: 'bank',
		deskType: 'bank',
		contactType: 'phone',
		institution,
		status: 'pending',
		createTime: '2026-08-16T08:00:00.000Z',
		createdAt: '2026-08-16T08:00:00.000Z',
		messages: [{
			id: `message_${id}`,
			senderType: 'user',
			senderRole: 'user',
			senderId: userId,
			content: `private-${id}`,
			createdAt: '2026-08-16T08:00:00.000Z'
		}],
		...extra
	}
}

function listIds(result) {
	return (result.payload.data.list || []).map((item) => item.contactId || item.id || item._id)
}

const STRICT_STAFF_DTO = Object.freeze({
	contactId: 'strict_staff_contact_18812345678',
	clientReportId: 'client-report-18812345678',
	productId: 'product-18812345678',
	messageId: 'message-18812345678',
	payloadAssociationId: 'payload-association-18812345678',
	phone: '13700137000',
	maskedPhone: '137****00'
})

const STRICT_STAFF_SENTINELS = Object.freeze([
	'CONTACT_PHONE_ALIAS_MUST_NOT_LEAK',
	'CONTACT_TEL_ALIAS_MUST_NOT_LEAK',
	'CONTACT_IDENTITY_ALIAS_MUST_NOT_LEAK',
	'CONTACT_MODEL_OUTPUT_MUST_NOT_LEAK',
	'CONTACT_FACT_LEDGER_MUST_NOT_LEAK',
	'CONTACT_ALLOWED_KEY_OBJECT_SMUGGLE_MUST_NOT_LEAK',
	'CONTACT_RAW_ANALYSIS_MUST_NOT_LEAK',
	'CONTEXT_CONTACT_TEL_MUST_NOT_LEAK',
	'CONTEXT_CREDIT_REPORT_MUST_NOT_LEAK',
	'CONTEXT_INTERNAL_SECRET_MUST_NOT_LEAK',
	'CONTEXT_DEBUG_TRACE_MUST_NOT_LEAK',
	'CONTEXT_JWT_MUST_NOT_LEAK',
	'CONTEXT_SESSION_KEY_MUST_NOT_LEAK',
	'CONTEXT_CHINESE_REPORT_MUST_NOT_LEAK',
	'MESSAGE_MOBILE_ALIAS_MUST_NOT_LEAK',
	'MESSAGE_CREDIT_REPORT_MUST_NOT_LEAK',
	'MESSAGE_MODEL_RAW_OUTPUT_MUST_NOT_LEAK',
	'MESSAGE_WARNING_FLAGS_MUST_NOT_LEAK',
	'PAYLOAD_PHONE_ALIAS_MUST_NOT_LEAK',
	'PAYLOAD_INTERNAL_SECRET_MUST_NOT_LEAK',
	'PAYLOAD_RAW_EVIDENCE_MUST_NOT_LEAK',
	'PAYLOAD_RATING_POINTS_MUST_NOT_LEAK',
	'PAYLOAD_ALLOWED_KEY_OBJECT_SMUGGLE_MUST_NOT_LEAK',
	'PUSH_CLIENT_ID_MUST_NOT_LEAK',
	'PUSH_DEVICE_ID_MUST_NOT_LEAK',
	'PUSH_TOKEN_MUST_NOT_LEAK'
])

const STRICT_ADMIN_MATERIAL = Object.freeze({
	id: 'strict_admin_material',
	phoneAlias: 'ADMIN_MATERIAL_PHONE_ALIAS_MUST_NOT_LEAK',
	rawAnalysis: 'ADMIN_MATERIAL_RAW_ANALYSIS_MUST_NOT_LEAK',
	internalSecret: 'ADMIN_MATERIAL_INTERNAL_SECRET_MUST_NOT_LEAK',
	nestedToken: 'ADMIN_MATERIAL_NESTED_TOKEN_MUST_NOT_LEAK',
	attachmentToken: 'ADMIN_MATERIAL_ATTACHMENT_TOKEN_MUST_NOT_LEAK',
	receiptSecret: 'ADMIN_MATERIAL_RECEIPT_SECRET_MUST_NOT_LEAK'
})

const SAFE_STAFF_PUSH_BINDING = Object.freeze({
	status: 'granted',
	platform: 'browser',
	updatedAt: '2026-08-16T08:00:00.000Z'
})

function assertStrictStaffMessages(messages, label) {
	const message = (Array.isArray(messages) ? messages : []).find((item) => item.id === STRICT_STAFF_DTO.messageId)
	assert.ok(message, `${label}: strict DTO message should remain visible`)
	assert.equal(message.id, STRICT_STAFF_DTO.messageId, `${label}: message.id changed`)
	assert.equal(message.contactId, STRICT_STAFF_DTO.contactId, `${label}: message contactId changed`)
	assert.equal(message.clientReportId, STRICT_STAFF_DTO.clientReportId, `${label}: message clientReportId changed`)
	assert.equal(message.product.id, STRICT_STAFF_DTO.productId, `${label}: message product.id changed`)
	assert.equal(message.payload.associationId, STRICT_STAFF_DTO.payloadAssociationId, `${label}: payload associationId changed`)
	assert.equal(message.payload.contactId, STRICT_STAFF_DTO.contactId, `${label}: payload contactId changed`)
	assert.equal(message.payload.clientReportId, STRICT_STAFF_DTO.clientReportId, `${label}: payload clientReportId changed`)
	assert.equal(message.payload.product.id, STRICT_STAFF_DTO.productId, `${label}: payload product.id changed`)
	assert.equal(message.payload.messageId, STRICT_STAFF_DTO.messageId, `${label}: payload messageId changed`)
	assert.equal(message.content.includes(STRICT_STAFF_DTO.phone), false, `${label}: raw phone leaked in message content`)
	assert.equal(message.content.includes(STRICT_STAFF_DTO.maskedPhone), true, `${label}: masked phone missing from message content`)
	const json = JSON.stringify(messages)
	for (const sentinel of STRICT_STAFF_SENTINELS) {
		assert.equal(json.includes(sentinel), false, `${label}: ${sentinel}`)
	}
}

function assertStrictStaffContact(contactDto, label) {
	assert.ok(contactDto, `${label}: strict DTO contact should remain visible`)
	assert.equal(contactDto.contactId, STRICT_STAFF_DTO.contactId, `${label}: contactId changed`)
	assert.equal(contactDto.clientReportId, STRICT_STAFF_DTO.clientReportId, `${label}: clientReportId changed`)
	assert.equal(contactDto.product.id, STRICT_STAFF_DTO.productId, `${label}: product.id changed`)
	assert.deepEqual(contactDto.pushBinding, SAFE_STAFF_PUSH_BINDING, `${label}: unsafe pushBinding projection`)
	assert.deepEqual(contactDto.pushBindings, [SAFE_STAFF_PUSH_BINDING], `${label}: unsafe pushBindings projection`)
	assert.deepEqual(contactDto.systemPushBinding, SAFE_STAFF_PUSH_BINDING, `${label}: unsafe systemPushBinding projection`)
	assert.deepEqual(Object.keys(contactDto.pushBinding).sort(), ['platform', 'status', 'updatedAt'])
	assertStrictStaffMessages(contactDto.messages, `${label} contact.messages`)
	const json = JSON.stringify(contactDto)
	for (const sentinel of STRICT_STAFF_SENTINELS) {
		assert.equal(json.includes(sentinel), false, `${label}: ${sentinel}`)
	}
}

test('institution isolation fails closed across shared policy, lists, detail, claim, grant, and invite', async (t) => {
	await t.test('shared policy rejects empty, placeholder, substring, and cross-family matches', () => {
		for (const placeholder of [
			'', '合作银行', '合作机构', '未知机构', '待确认', '银行',
			'未知', '未填写', '暂无', '无', 'null', 'NULL', 'undefined', '-', '--'
		]) {
			assert.equal(normalizedInstitution(placeholder), '')
			assert.equal(institutionTextMatches(placeholder, '平安银行'), false)
		}
		assert.equal(institutionTextMatches('中国', '中国银行'), false)
		assert.equal(institutionTextMatches('上海银行', '上海农商银行'), false)
		assert.equal(institutionTextMatches('平安银行', '假平安银行'), false)
		assert.equal(institutionTextMatches('平安银行', '平安银行营销冒充'), false)
		assert.equal(institutionTextMatches('中国平安集团有限公司', '平安银行深圳分行'), true)
		assert.equal(institutionTextMatches('ACME BANK股份有限公司', 'acme bank有限公司'), true)
		assert.equal(institutionTextMatches('某县农村信用合作社', '某县农村信用合作社'), true)
		assert.equal(institutionTextMatches('某县农村信用合作社', '某县农村信用合作社分社'), false)
		assert.equal(institutionTextMatches('', ''), false)
		assert.equal(contactInstitutionOf({
			institution: '合作银行',
			product: { institution: '平安银行' },
			advisorInfo: { bank: '未知机构' }
		}), '平安银行')
	})

	const admin = { id: 'u_inst_admin', phone: '18831000001', role: 'admin', roles: ['admin'], adminLevel: 'super', tokenVersion: 0 }
	const service = { id: 'u_inst_service', phone: '18831000002', role: 'service', roles: ['service'], tokenVersion: 0 }
	const aliasAdvisor = { id: 'u_inst_alias', phone: '18831000003', role: 'advisor', roles: ['advisor'], institution: '中国平安集团有限公司', tokenVersion: 0 }
	const aliasPeer = { id: 'u_inst_alias_peer', phone: '18831000004', role: 'advisor', roles: ['advisor'], institution: '平安消费金融', tokenVersion: 0 }
	const caseAdvisor = { id: 'u_inst_case', phone: '18831000005', role: 'advisor', roles: ['advisor'], institution: 'ACME BANK股份有限公司', tokenVersion: 0 }
	const crossAdvisor = { id: 'u_inst_cross', phone: '18831000006', role: 'advisor', roles: ['advisor'], institution: '兴业银行', tokenVersion: 0 }
	const shanghaiAdvisor = { id: 'u_inst_shanghai', phone: '18831000007', role: 'advisor', roles: ['advisor'], institution: '上海银行', tokenVersion: 0 }
	const emptyAdvisor = { id: 'u_inst_empty', phone: '18831000008', role: 'advisor', roles: ['advisor'], tokenVersion: 0 }
	const retainedAdvisor = { id: 'u_inst_retained', phone: '18831000009', role: 'advisor', roles: ['advisor'], institution: '中国建设银行', tokenVersion: 0 }
	const phoneOnlyAdvisor = { id: 'u_inst_phone_only', phone: '18831000013', role: 'advisor', roles: ['advisor'], institution: '测试银行A', tokenVersion: 0 }
	const client = { id: 'u_inst_client', phone: '18831000012', role: 'user', roles: ['user'], nickname: '机构隔离测试客户', tokenVersion: 0 }

	const state = store.state()
	state.users = [admin, service, aliasAdvisor, aliasPeer, caseAdvisor, crossAdvisor, shanghaiAdvisor, emptyAdvisor, retainedAdvisor, phoneOnlyAdvisor, client]
	state.reports = []
	state.messages = []
	state.supplementMaterials = [{
		id: STRICT_ADMIN_MATERIAL.id,
		materialId: 'strict-admin-material-business-id',
		userId: client.id,
		caseId: 'strict-admin-material-case-id',
		institution: '测试材料银行',
		name: '收入证明',
		status: 'uploaded',
		statusText: '待确认',
		fileName: 'income-proof.pdf',
		createdAt: '2026-08-16T08:05:00.000Z',
		customerPhoneNumber: STRICT_ADMIN_MATERIAL.phoneAlias,
		rawAnalysis: STRICT_ADMIN_MATERIAL.rawAnalysis,
		internalSecret: STRICT_ADMIN_MATERIAL.internalSecret,
		nested: { accessToken: STRICT_ADMIN_MATERIAL.nestedToken },
		attachments: [{ fileName: 'supporting-proof.pdf', accessToken: STRICT_ADMIN_MATERIAL.attachmentToken }],
		reviewReceipt: { status: 'received', internalSecret: STRICT_ADMIN_MATERIAL.receiptSecret }
	}]
	state.pushBindings = {
		[client.id]: {
			status: 'granted',
			platform: 'browser',
			clientId: 'PUSH_CLIENT_ID_MUST_NOT_LEAK',
			deviceId: 'PUSH_DEVICE_ID_MUST_NOT_LEAK',
			token: 'PUSH_TOKEN_MUST_NOT_LEAK',
			updatedAt: '2026-08-16T08:00:00.000Z'
		}
	}
	state.advisorContacts = [
		contact('lead_alias', client.id, '平安银行股份有限公司', {
			phone: '13800138000',
			mobile: '13900139000',
			reportScore: 987654321,
			reportDate: 'SENSITIVE-REPORT-DATE',
			reportTitle: 'SENSITIVE-REPORT-TITLE',
			summary: 'SENSITIVE-SUMMARY',
			supplementProfile: { income: 'SENSITIVE-INCOME' },
			context: { reportScore: 123456789, idCard: '11010519491231002X' },
			notes: [{ text: 'SENSITIVE-NOTE' }]
		}),
		contact('lead_alias_claim', client.id, '平安银行'),
		contact('lead_case', client.id, 'acme bank有限公司', { advisorId: caseAdvisor.id }),
		contact('lead_cross', client.id, '兴业银行'),
		contact('lead_shanghai_rural', client.id, '上海农商银行股份有限公司'),
		contact('lead_placeholder_nested', client.id, '合作银行', { product: { institution: '平安银行' } }),
		contact('group_invite_alias', client.id, '平安银行', {
			contactType: 'match-product',
			groupMode: 'service-bank-customer',
			serviceRequired: true
		}),
		contact('group_phone_only_invite', client.id, phoneOnlyAdvisor.institution, {
			contactType: 'match-product',
			groupMode: 'service-bank-customer',
			serviceRequired: true,
			serviceAssigneeId: service.id,
			serviceAssigneeName: '客服0002',
			serviceAssignedAt: '2026-08-16T08:04:00.000Z',
			serviceStatus: 'assigned',
			messages: [{
				id: 'phone_only_service_claim_event',
				senderType: 'system',
				senderRole: 'system',
				senderId: 'system',
				eventType: 'service-claimed',
				serviceId: service.id,
				claimedAt: '2026-08-16T08:04:00.000Z',
				createdAt: '2026-08-16T08:04:00.000Z',
				content: '客服0002已接单，可查看授权资料并协助沟通。'
			}]
		}),
		contact(STRICT_STAFF_DTO.contactId, client.id, '平安银行', {
			contactType: 'match-product',
			groupMode: 'service-bank-customer',
			serviceRequired: true,
			clientReportId: STRICT_STAFF_DTO.clientReportId,
			product: {
				id: STRICT_STAFF_DTO.productId,
				name: '严格 DTO 合法产品'
			},
			phone: STRICT_STAFF_DTO.phone,
			customerPhoneNumber: 'CONTACT_PHONE_ALIAS_MUST_NOT_LEAK',
			tel: 'CONTACT_TEL_ALIAS_MUST_NOT_LEAK',
			identityCardNumber: 'CONTACT_IDENTITY_ALIAS_MUST_NOT_LEAK',
			modelOutput: 'CONTACT_MODEL_OUTPUT_MUST_NOT_LEAK',
			factLedger: 'CONTACT_FACT_LEDGER_MUST_NOT_LEAK',
			summary: { internalSecret: 'CONTACT_ALLOWED_KEY_OBJECT_SMUGGLE_MUST_NOT_LEAK' },
			rawAnalysis: 'CONTACT_RAW_ANALYSIS_MUST_NOT_LEAK',
			context: {
				clientReportId: STRICT_STAFF_DTO.clientReportId,
				product: { id: STRICT_STAFF_DTO.productId },
				contactTel: 'CONTEXT_CONTACT_TEL_MUST_NOT_LEAK',
				credit_report_full: 'CONTEXT_CREDIT_REPORT_MUST_NOT_LEAK',
				internalSecret: 'CONTEXT_INTERNAL_SECRET_MUST_NOT_LEAK',
				debugTrace: 'CONTEXT_DEBUG_TRACE_MUST_NOT_LEAK',
				jwt: 'CONTEXT_JWT_MUST_NOT_LEAK',
				sessionKey: 'CONTEXT_SESSION_KEY_MUST_NOT_LEAK',
				征信报告: 'CONTEXT_CHINESE_REPORT_MUST_NOT_LEAK'
			},
			serviceAssigneeId: service.id,
			serviceAssigneeName: '严格 DTO 客服',
			serviceAssignedAt: '2026-08-16T08:01:00.000Z',
			serviceStatus: 'assigned',
			advisorAssigneeId: aliasAdvisor.id,
			advisorAssigneeName: '严格 DTO 银行老师',
			advisorAssignedAt: '2026-08-16T08:02:00.000Z',
			advisorStatus: 'assigned',
			messages: [{
				id: 'strict_service_claim_event',
				contactId: STRICT_STAFF_DTO.contactId,
				senderType: 'system',
				senderRole: 'system',
				senderId: 'system',
				eventType: 'service-claimed',
				serviceId: service.id,
				claimedAt: '2026-08-16T08:01:00.000Z',
				createdAt: '2026-08-16T08:01:00.000Z',
				content: '客服已接入'
			}, {
				id: 'strict_advisor_claim_event',
				contactId: STRICT_STAFF_DTO.contactId,
				senderType: 'system',
				senderRole: 'system',
				senderId: 'system',
				eventType: 'advisor-claimed',
				advisorId: aliasAdvisor.id,
				claimedAt: '2026-08-16T08:02:00.000Z',
				createdAt: '2026-08-16T08:02:00.000Z',
				content: '银行老师已接入'
			}, {
				id: STRICT_STAFF_DTO.messageId,
				contactId: STRICT_STAFF_DTO.contactId,
				clientReportId: STRICT_STAFF_DTO.clientReportId,
				product: { id: STRICT_STAFF_DTO.productId },
				senderType: 'user',
				senderRole: 'user',
				senderId: client.id,
				content: `客户联系电话 ${STRICT_STAFF_DTO.phone}，请按关联标识处理`,
				recipientMobile: 'MESSAGE_MOBILE_ALIAS_MUST_NOT_LEAK',
				creditReportFull: 'MESSAGE_CREDIT_REPORT_MUST_NOT_LEAK',
				modelRawOutput: 'MESSAGE_MODEL_RAW_OUTPUT_MUST_NOT_LEAK',
				warningFlags: 'MESSAGE_WARNING_FLAGS_MUST_NOT_LEAK',
				payload: {
					associationId: STRICT_STAFF_DTO.payloadAssociationId,
					contactId: STRICT_STAFF_DTO.contactId,
					clientReportId: STRICT_STAFF_DTO.clientReportId,
					product: { id: STRICT_STAFF_DTO.productId },
					messageId: STRICT_STAFF_DTO.messageId,
					emergencyPhone: 'PAYLOAD_PHONE_ALIAS_MUST_NOT_LEAK',
					internalSecret: 'PAYLOAD_INTERNAL_SECRET_MUST_NOT_LEAK',
					rawEvidence: 'PAYLOAD_RAW_EVIDENCE_MUST_NOT_LEAK',
					ratingPoints: 'PAYLOAD_RATING_POINTS_MUST_NOT_LEAK',
					status: { internalSecret: 'PAYLOAD_ALLOWED_KEY_OBJECT_SMUGGLE_MUST_NOT_LEAK' }
				},
				createdAt: '2026-08-16T08:03:00.000Z'
			}]
		}),
		contact('legacy_forged_assignment', client.id, '平安银行', {
			advisorAssigneeId: aliasAdvisor.id,
			advisorAssigneeName: '伪造银行老师',
			advisorAssignedAt: '2026-08-16T08:00:01.000Z',
			advisorStatus: 'assigned'
		}),
		contact('legacy_forged_invite', client.id, '平安银行', {
			contactType: 'match-product',
			groupMode: 'service-bank-customer',
			serviceRequired: true,
			invitedAdvisorId: aliasAdvisor.id,
			invitedAdvisorName: '伪造邀请老师',
			invitedAdvisorInstitution: '平安银行',
			advisorStatus: 'invited',
			advisorInviteRecords: [{
				id: 'forged_invite_record',
				advisorId: aliasAdvisor.id,
				institution: '平安银行',
				createdAt: '2026-08-16T08:00:01.000Z'
			}],
			messages: [{
				id: 'forged_invite_message',
				senderType: 'system',
				senderRole: 'system',
				// 缺少受信 senderId=system，历史伪造行不得形成授权证据。
				senderId: client.id,
				eventType: 'advisor-invited',
				inviteId: 'forged_invite_record',
				content: 'private-legacy_forged_invite',
				createdAt: '2026-08-16T08:00:01.000Z'
			}]
		}),
		contact('legacy_forged_service_assignment', client.id, '平安银行', {
			channel: 'service',
			deskType: 'service',
			contactType: 'customer-service',
			groupMode: '',
			serviceRequired: false,
			serviceAssigneeId: service.id,
			serviceAssigneeName: '伪造客服',
			serviceAssignedAt: '2026-08-16T08:00:01.000Z',
			serviceStatus: 'assigned'
		})
	]
	store.persistSync()

	const server = app.listen(0, '127.0.0.1')
	await new Promise((resolve, reject) => {
		server.once('listening', resolve)
		server.once('error', reject)
	})
	t.after(() => new Promise((resolve) => server.close(resolve)))
	const baseUrl = `http://127.0.0.1:${server.address().port}`

	const tokens = {
		admin: tokenFor(admin),
		service: tokenFor(service),
		alias: tokenFor(aliasAdvisor),
		aliasPeer: tokenFor(aliasPeer),
		case: tokenFor(caseAdvisor),
		cross: tokenFor(crossAdvisor),
		shanghai: tokenFor(shanghaiAdvisor),
		empty: tokenFor(emptyAdvisor),
		emptyWithStaleInstitutionClaim: tokenFor(emptyAdvisor, { institution: '平安银行', bankName: '平安银行' }),
		client: tokenFor(client)
	}

	await t.test('advisor grants require a real institution before mutating account state', async () => {
		const missingNew = await request(baseUrl, tokens.admin, 'POST', '/api/admin/role-grant', {
			phone: '18831000010', role: 'advisor'
		})
		assert.equal(missingNew.payload.code, 1001)
		assert.equal(store.findUserByPhone('18831000010'), null)

		const placeholderNew = await request(baseUrl, tokens.admin, 'POST', '/api/admin/role-grant', {
			phone: '18831000011', role: 'advisor', institution: '合作银行'
		})
		assert.equal(placeholderNew.payload.code, 1001)
		assert.equal(store.findUserByPhone('18831000011'), null)

		const missingExisting = await request(baseUrl, tokens.admin, 'POST', '/api/admin/role-grant', {
			phone: emptyAdvisor.phone, role: 'advisor'
		})
		assert.equal(missingExisting.payload.code, 1001)
		assert.equal(normalizedInstitution(emptyAdvisor.institution), '')

		const retained = await request(baseUrl, tokens.admin, 'POST', '/api/admin/role-grant', {
			phone: retainedAdvisor.phone, role: 'advisor', nickname: '保留原机构'
		})
		assert.equal(retained.payload.code, 0)
		assert.equal(store.findUserById(retainedAdvisor.id).institution, '中国建设银行')
	})

	const createdMissing = await request(baseUrl, tokens.client, 'POST', '/api/advisor/contact', {
		contactType: 'match-product',
		productName: '未定机构方案'
	})
	assert.equal(createdMissing.payload.code, 0)
	const missingContactId = createdMissing.payload.data.contactId
	const missingContact = store.state().advisorContacts.find((item) => String(item.id || item._id) === missingContactId)
	assert.ok(missingContact)
	assert.equal(missingContact.institution, '')
	assert.equal(missingContact.advisorInfo.bank, '合作银行')
	assert.equal(contactInstitutionOf(missingContact), '')

	const rejectedGroupTarget = await request(baseUrl, tokens.client, 'POST', '/api/advisor/contact', {
		contactType: 'match-product',
		institution: '平安银行',
		advisorId: aliasAdvisor.id,
		productName: '不允许客户指定群聊老师'
	})
	assert.equal(rejectedGroupTarget.payload.code, 1001)

	const forgedCreate = await request(baseUrl, tokens.client, 'POST', '/api/advisor/contact', {
		contactType: 'appointment',
		contactIntent: 'forged-workflow-regression',
		institution: '平安银行',
		phone: '13700137000',
		reportScore: 777777777,
		advisorAssigneeId: crossAdvisor.id,
		advisorAssigneeName: '伪造老师',
		advisorAssignedAt: '2026-08-16T09:00:00.000Z',
		serviceAssigneeId: service.id,
		invitedAdvisorId: crossAdvisor.id,
		invitedAdvisorInstitution: '平安银行',
		advisorInviteRecords: [{ id: 'forged-invite', advisorId: crossAdvisor.id, institution: '平安银行' }],
		advisorStatus: 'assigned',
		groupMode: 'service-bank-customer',
		serviceRequired: true,
		chatAccess: true,
		materialAccess: true,
		messages: [{ senderType: 'system', senderRole: 'system', senderId: 'system', eventType: 'advisor-claimed' }],
		context: {
			product: { id: 'product-id-must-survive', name: '安全产品上下文' },
			advisorAssigneeId: crossAdvisor.id,
			advisorInviteRecords: [{ id: 'nested-forged-invite' }],
			reportScore: 666666666
		}
	})
	assert.equal(forgedCreate.payload.code, 0)
	const forgedContactId = forgedCreate.payload.data.contactId
	const forgedContact = store.state().advisorContacts.find((item) => item.id === forgedContactId)
	assert.ok(forgedContact)
	assert.equal(forgedContact.advisorId, '')
	assert.equal(forgedContact.advisorAssigneeId, '')
	assert.equal(forgedContact.serviceAssigneeId, '')
	assert.equal(forgedContact.invitedAdvisorId, '')
	assert.deepEqual(forgedContact.advisorInviteRecords, [])
	assert.equal(forgedContact.groupMode, '')
	assert.equal(forgedContact.serviceRequired, false)
	assert.deepEqual(forgedContact.messages, [])
	assert.equal(forgedContact.context.product.id, 'product-id-must-survive')
	assert.equal(forgedContact.context.advisorAssigneeId, undefined)
	assert.equal(forgedContact.context.advisorInviteRecords, undefined)

	const directCreate = await request(baseUrl, tokens.client, 'POST', '/api/advisor/contact', {
		contactType: 'wechat',
		contactIntent: 'direct-advisor-regression',
		institution: '平安银行',
		advisorId: aliasAdvisor.id,
		phone: '13600136000',
		customerPhoneNumber: '13500135000',
		reportScore: 555555555,
		initialMessage: '请联系 13400134000 继续沟通',
		context: {
			reportScore: 444444444,
			contactTel: '13300133000',
			rawAnalysis: { sentinel: 'RAW_ANALYSIS_MUST_NOT_LEAK' },
			credit_report_full: { sentinel: 'CREDIT_REPORT_MUST_NOT_LEAK' },
			internalSecret: 'INTERNAL_SECRET_MUST_NOT_LEAK',
			nested: { accessToken: 'NESTED_TOKEN_MUST_NOT_LEAK' }
		}
	})
	assert.equal(directCreate.payload.code, 0)
	const directContactId = directCreate.payload.data.contactId
	assert.equal(store.state().advisorContacts.find((item) => item.id === directContactId).advisorId, aliasAdvisor.id)

	for (const body of [
		{ contactType: 'phone', institution: '平安银行', advisorId: 'u_unknown_advisor', contactIntent: 'unknown-direct-target' },
		{ contactType: 'phone', institution: '兴业银行', advisorId: aliasAdvisor.id, contactIntent: 'cross-direct-target' },
		{ contactType: 'phone', institution: '合作银行', advisorId: aliasAdvisor.id, contactIntent: 'placeholder-direct-target' }
	]) {
		const denied = await request(baseUrl, tokens.client, 'POST', '/api/advisor/contact', body)
		assert.notEqual(denied.payload.code, 0)
	}

	const notifiedLead = await request(baseUrl, tokens.client, 'POST', '/api/advisor/contact', {
		contactType: 'match-product',
		contactIntent: 'masked-lead-notification-regression',
		institution: '平安银行',
		productName: '通知脱敏测试方案',
		customerName: '敏感全名测试'
	})
	assert.equal(notifiedLead.payload.code, 0)
	const notifiedLeadId = notifiedLead.payload.data.contactId
	const leadNotifications = store.state().messages.filter((item) => item.contactId === notifiedLeadId)
	assert.equal(leadNotifications.length, 2)
	leadNotifications.forEach((item) => {
		assert.equal(item.desc.includes('敏感全名测试'), false)
		assert.equal(item.desc.includes('敏***'), true)
	})

	await t.test('lead lists are minimal while details fail closed until a direct or proven relationship exists', async () => {
		const aliasList = await request(baseUrl, tokens.alias, 'GET', '/api/advisor/contacts')
		assert.equal(aliasList.payload.code, 0)
		assert.deepEqual(new Set(listIds(aliasList)), new Set([
			'lead_alias', 'lead_alias_claim', 'lead_placeholder_nested', 'group_invite_alias',
			STRICT_STAFF_DTO.contactId, forgedContactId, directContactId, notifiedLeadId
		]))
		assert.equal(listIds(aliasList).includes(missingContactId), false)
		assert.equal(listIds(aliasList).includes('legacy_forged_assignment'), false)
		assert.equal(listIds(aliasList).includes('legacy_forged_invite'), false)

		const minimalLead = aliasList.payload.data.list.find((item) => item.contactId === 'lead_alias')
		assert.ok(minimalLead)
		assert.equal(minimalLead.leadOnly, true)
		assert.equal(minimalLead.chatAccess, false)
		assert.equal(minimalLead.materialAccess, false)
		assert.equal(minimalLead.reportScore, null)
		assert.equal(minimalLead.reportScoreVerified, false)
		assert.deepEqual(minimalLead.messages, [])
		assert.equal(Object.hasOwn(minimalLead, 'context'), false)
		assert.equal(Object.hasOwn(minimalLead, 'supplementProfile'), false)
		assert.equal(Object.hasOwn(minimalLead, 'reportDate'), false)
		assert.equal(Object.hasOwn(minimalLead, 'reportTitle'), false)
		assert.equal(Object.hasOwn(minimalLead, 'notes'), false)
		const minimalJson = JSON.stringify(minimalLead)
		for (const sentinel of [
			'13800138000', '13900139000', '987654321', '123456789',
			'SENSITIVE-REPORT-DATE', 'SENSITIVE-REPORT-TITLE', 'SENSITIVE-SUMMARY',
			'SENSITIVE-INCOME', '11010519491231002X', 'SENSITIVE-NOTE', 'private-lead_alias'
		]) assert.equal(minimalJson.includes(sentinel), false, sentinel)

		const directVisible = aliasList.payload.data.list.find((item) => item.contactId === directContactId)
		assert.ok(directVisible)
		assert.notEqual(directVisible.leadOnly, true)
		assert.equal(directVisible.reportScore, null)
		assert.equal(directVisible.reportScoreVerified, false)
		assert.equal(directVisible.phone, '')
		assert.equal(directVisible.mobile, '')
		const directJson = JSON.stringify(directVisible)
		for (const sentinel of [
			'13600136000', '13500135000', '13400134000', '13300133000', '555555555', '444444444',
			'RAW_ANALYSIS_MUST_NOT_LEAK', 'CREDIT_REPORT_MUST_NOT_LEAK',
			'INTERNAL_SECRET_MUST_NOT_LEAK', 'NESTED_TOKEN_MUST_NOT_LEAK',
			'PUSH_CLIENT_ID_MUST_NOT_LEAK', 'PUSH_DEVICE_ID_MUST_NOT_LEAK', 'PUSH_TOKEN_MUST_NOT_LEAK'
		]) {
			assert.equal(directJson.includes(sentinel), false, sentinel)
		}
		assert.equal(directJson.includes('134****00'), true)
		assert.equal(directVisible.contactId, directContactId)
		assert.deepEqual(directVisible.pushBinding, {
			status: 'granted',
			platform: 'browser',
			updatedAt: '2026-08-16T08:00:00.000Z'
		})
		const directMessages = await request(baseUrl, tokens.alias, 'GET', `/api/advisor/contact/${encodeURIComponent(directContactId)}/messages`)
		assert.equal(directMessages.payload.code, 0)
		const directMessagesJson = JSON.stringify(directMessages.payload.data.messages)
		assert.equal(directMessagesJson.includes('13400134000'), false)
		assert.equal(directMessagesJson.includes('134****00'), true)

		const peerList = await request(baseUrl, tokens.aliasPeer, 'GET', '/api/advisor/contacts')
		assert.equal(peerList.payload.code, 0)
		assert.equal(listIds(peerList).includes('lead_alias'), true)
		assert.equal(listIds(peerList).includes(forgedContactId), true)
		assert.equal(listIds(peerList).includes(directContactId), false)

		const aliasTeacherTasks = await request(baseUrl, tokens.alias, 'GET', '/api/teacher/tasks')
		assert.equal(aliasTeacherTasks.payload.code, 0)
		assert.deepEqual(
			new Set(aliasTeacherTasks.payload.data.tasks.map((item) => item.contactId)),
			new Set([
				'lead_alias', 'lead_alias_claim', 'lead_placeholder_nested', 'group_invite_alias',
				STRICT_STAFF_DTO.contactId, forgedContactId, directContactId, notifiedLeadId
			])
		)

		const emptyList = await request(baseUrl, tokens.empty, 'GET', '/api/advisor/contacts')
		assert.equal(emptyList.payload.code, 0)
		assert.deepEqual(listIds(emptyList), [])
		const staleClaimList = await request(baseUrl, tokens.emptyWithStaleInstitutionClaim, 'GET', '/api/advisor/contacts')
		assert.equal(staleClaimList.payload.code, 0)
		assert.deepEqual(listIds(staleClaimList), [])

		const emptyTeacherTasks = await request(baseUrl, tokens.empty, 'GET', '/api/teacher/tasks')
		assert.equal(emptyTeacherTasks.payload.code, 0)
		assert.deepEqual(emptyTeacherTasks.payload.data.tasks, [])
		const staleClaimTeacherTasks = await request(baseUrl, tokens.emptyWithStaleInstitutionClaim, 'GET', '/api/teacher/tasks')
		assert.equal(staleClaimTeacherTasks.payload.code, 0)
		assert.deepEqual(staleClaimTeacherTasks.payload.data.tasks, [])

		const deniedDetails = [
			[tokens.empty, 'lead_alias'],
			[tokens.empty, missingContactId],
			[tokens.alias, missingContactId],
			[tokens.alias, 'lead_cross'],
			[tokens.shanghai, 'lead_shanghai_rural'],
			[tokens.alias, 'lead_alias'],
			[tokens.alias, forgedContactId],
			[tokens.aliasPeer, directContactId],
			[tokens.alias, 'legacy_forged_assignment'],
			[tokens.alias, 'legacy_forged_invite']
		]
		for (const [token, contactId] of deniedDetails) {
			const detail = await request(baseUrl, token, 'GET', `/api/advisor/contact/${encodeURIComponent(contactId)}/messages`)
			assert.notEqual(detail.payload.code, 0, contactId)
			assert.equal(JSON.stringify(detail.payload).includes(`private-${contactId}`), false, contactId)
		}

		const directDetail = await request(baseUrl, tokens.alias, 'GET', `/api/advisor/contact/${encodeURIComponent(directContactId)}/messages`)
		assert.equal(directDetail.payload.code, 0)
		assert.equal(directDetail.payload.data.contact.reportScore, null)
		assert.equal(directDetail.payload.data.contact.reportScoreVerified, false)
		const caseDetail = await request(baseUrl, tokens.case, 'GET', '/api/advisor/contact/lead_case/messages')
		assert.equal(caseDetail.payload.code, 0)
		assert.equal(caseDetail.payload.data.messages[0].content, 'private-lead_case')

		const serviceList = await request(baseUrl, tokens.service, 'GET', '/api/advisor/contacts')
		assert.equal(serviceList.payload.code, 0)
		assert.equal(listIds(serviceList).includes('group_invite_alias'), true)
		assert.equal(listIds(serviceList).includes(missingContactId), true)
		assert.equal(listIds(serviceList).includes('legacy_forged_service_assignment'), false)
		for (const contactId of ['group_invite_alias', missingContactId, 'legacy_forged_service_assignment']) {
			const serviceDetail = await request(baseUrl, tokens.service, 'GET', `/api/advisor/contact/${encodeURIComponent(contactId)}/messages`)
			assert.notEqual(serviceDetail.payload.code, 0, contactId)
		}

		const adminList = await request(baseUrl, tokens.admin, 'GET', '/api/advisor/contacts')
		assert.equal(adminList.payload.code, 0)
		assert.equal(listIds(adminList).includes(missingContactId), true)
		assert.equal(listIds(adminList).includes('lead_cross'), true)
		assert.equal(listIds(adminList).includes('legacy_forged_assignment'), true)
		const adminDetail = await request(baseUrl, tokens.admin, 'GET', `/api/advisor/contact/${missingContactId}/messages`)
		assert.equal(adminDetail.payload.code, 0)
		const adminTeacherTasks = await request(baseUrl, tokens.admin, 'GET', '/api/teacher/tasks')
		assert.equal(adminTeacherTasks.payload.code, 0)
		assert.equal(adminTeacherTasks.payload.data.tasks.some((item) => item.contactId === missingContactId), true)
	})

	await t.test('advisor, service, and admin receive the same strict staff DTO without corrupting business identifiers', async () => {
		for (const [role, token] of [
			['advisor', tokens.alias],
			['service', tokens.service],
			['admin', tokens.admin]
		]) {
			const listResult = await request(baseUrl, token, 'GET', '/api/advisor/contacts')
			assert.equal(listResult.payload.code, 0, `${role}: contact list request failed`)
			const listContact = listResult.payload.data.list.find((item) => item.contactId === STRICT_STAFF_DTO.contactId)
			assertStrictStaffContact(listContact, `${role} list`)

			const detailResult = await request(
				baseUrl,
				token,
				'GET',
				`/api/advisor/contact/${encodeURIComponent(STRICT_STAFF_DTO.contactId)}/messages`
			)
			assert.equal(detailResult.payload.code, 0, `${role}: contact messages request failed`)
			assertStrictStaffContact(detailResult.payload.data.contact, `${role} detail contact`)
			assertStrictStaffMessages(detailResult.payload.data.messages, `${role} detail messages`)
		}
	})

	await t.test('admin overview projects supplemental materials without arbitrary aliases or nested secrets', async () => {
		const overview = await request(baseUrl, tokens.admin, 'GET', '/api/admin/overview')
		assert.equal(overview.payload.code, 0)

		const material = overview.payload.data.materials.find((item) => item.id === STRICT_ADMIN_MATERIAL.id)
		assert.ok(material, 'safe supplemental material should remain visible in overview materials')
		assert.equal(material.materialId, 'strict-admin-material-business-id')
		assert.equal(material.userId, client.id)

		const customerDocument = overview.payload.data.customerDocuments.find((item) => item.userId === client.id)
		assert.ok(customerDocument, 'customer document should include the supplemental material owner')
		const documentMaterial = customerDocument.materials.find((item) => item.id === STRICT_ADMIN_MATERIAL.id)
		assert.ok(documentMaterial, 'safe supplemental material should remain visible in customerDocuments')

		const sensitiveSentinels = Object.values(STRICT_ADMIN_MATERIAL).filter((item) => item !== STRICT_ADMIN_MATERIAL.id)
		const overviewJson = JSON.stringify(overview.payload.data)
		for (const sentinel of sensitiveSentinels) {
			assert.equal(overviewJson.includes(sentinel), false, `admin overview: ${sentinel}`)
		}
		for (const [label, value] of [
			['overview materials', material],
			['customerDocuments materials', documentMaterial]
		]) {
			const json = JSON.stringify(value)
			for (const sentinel of sensitiveSentinels) {
				assert.equal(json.includes(sentinel), false, `${label}: ${sentinel}`)
			}
		}
	})

	await t.test('claim paths fail closed and accept only a valid same-institution advisor', async () => {
		for (const [token, contactId] of [
			[tokens.empty, 'lead_alias'],
			[tokens.empty, missingContactId],
			[tokens.alias, missingContactId],
			[tokens.alias, 'lead_cross'],
			[tokens.aliasPeer, directContactId],
			[tokens.alias, 'legacy_forged_assignment'],
			[tokens.alias, 'legacy_forged_invite'],
			[tokens.cross, forgedContactId]
		]) {
			const claim = await request(baseUrl, token, 'POST', '/api/advisor/contact/claim', { contactId })
			assert.notEqual(claim.payload.code, 0, contactId)
		}

		const accepted = await request(baseUrl, tokens.alias, 'POST', '/api/advisor/contact/claim', { contactId: 'lead_alias_claim' })
		assert.equal(accepted.payload.code, 0)
		const claimed = store.state().advisorContacts.find((item) => item.id === 'lead_alias_claim')
		assert.equal(claimed.advisorAssigneeId, aliasAdvisor.id)
		assert.equal(claimed.advisorStatus, 'assigned')
		assert.equal(claimed.advisorAssigneeName, '银行客户经理0003')
		const event = claimed.messages.find((message) => message.eventType === 'advisor-claimed')
		assert.ok(event)
		assert.equal(JSON.stringify(event).includes(aliasAdvisor.phone), false)
		assert.equal(event.senderType, 'system')
		assert.equal(event.senderRole, 'system')
		assert.equal(event.senderId, 'system')
		assert.equal(event.advisorId, aliasAdvisor.id)
		assert.equal(event.assigneeId, aliasAdvisor.id)
		assert.equal(event.claimedAt, claimed.advisorAssignedAt)
		assert.equal(event.createdAt, claimed.advisorAssignedAt)

		const afterClaim = await request(baseUrl, tokens.alias, 'GET', '/api/advisor/contact/lead_alias_claim/messages')
		assert.equal(afterClaim.payload.code, 0)
		assert.equal(afterClaim.payload.data.messages.some((message) => message.content === 'private-lead_alias_claim'), true)
		const peerAfterClaim = await request(baseUrl, tokens.aliasPeer, 'GET', '/api/advisor/contact/lead_alias_claim/messages')
		assert.notEqual(peerAfterClaim.payload.code, 0)
	})

	await t.test('candidate and invite paths cannot cross or forge institutions and can bind a missing contact only to a real advisor', async () => {
		const phoneOnlyCandidates = await request(baseUrl, tokens.service, 'GET', '/api/advisor/bank-teachers?contactId=group_phone_only_invite')
		assert.equal(phoneOnlyCandidates.payload.code, 0)
		const phoneOnlyCandidate = phoneOnlyCandidates.payload.data.list.find((item) => item.uid === phoneOnlyAdvisor.id)
		assert.ok(phoneOnlyCandidate)
		assert.equal(phoneOnlyCandidate.name, '银行老师0013')
		assert.equal(JSON.stringify(phoneOnlyCandidate).includes(phoneOnlyAdvisor.phone), false)

		const phoneOnlyInvite = await request(baseUrl, tokens.service, 'POST', '/api/advisor/contact/invite-advisor', {
			contactId: 'group_phone_only_invite',
			advisorId: phoneOnlyAdvisor.id,
			institution: phoneOnlyAdvisor.institution
		})
		assert.equal(phoneOnlyInvite.payload.code, 0)
		assert.equal(JSON.stringify(phoneOnlyInvite.payload.data).includes(phoneOnlyAdvisor.phone), false)

		const phoneOnlyContact = store.state().advisorContacts.find((item) => item.id === 'group_phone_only_invite')
		const storedPhoneOnlyInvite = phoneOnlyContact.advisorInviteRecords.find((item) => item.advisorId === phoneOnlyAdvisor.id)
		assert.ok(storedPhoneOnlyInvite)
		assert.equal(storedPhoneOnlyInvite.advisorName, '银行老师0013')
		assert.equal(JSON.stringify(storedPhoneOnlyInvite).includes(phoneOnlyAdvisor.phone), false)
		const storedPhoneOnlyMessage = phoneOnlyContact.messages.find((item) => item.inviteId === storedPhoneOnlyInvite.id)
		assert.ok(storedPhoneOnlyMessage)
		assert.equal(JSON.stringify(storedPhoneOnlyMessage).includes(phoneOnlyAdvisor.phone), false)

		const groupServiceClaim = await request(baseUrl, tokens.service, 'POST', '/api/advisor/contact/claim', { contactId: 'group_invite_alias' })
		assert.equal(groupServiceClaim.payload.code, 0)
		const groupContact = store.state().advisorContacts.find((item) => item.id === 'group_invite_alias')
		const serviceEvent = groupContact.messages.find((message) => message.eventType === 'service-claimed')
		assert.ok(serviceEvent)
		assert.equal(groupContact.serviceAssigneeName, '客服0002')
		assert.equal(JSON.stringify(groupServiceClaim.payload.data).includes(service.phone), false)
		assert.equal(JSON.stringify(serviceEvent).includes(service.phone), false)
		assert.equal(serviceEvent.senderType, 'system')
		assert.equal(serviceEvent.senderRole, 'system')
		assert.equal(serviceEvent.senderId, 'system')
		assert.equal(serviceEvent.serviceId, service.id)
		assert.equal(serviceEvent.claimedAt, groupContact.serviceAssignedAt)
		assert.equal(serviceEvent.createdAt, groupContact.serviceAssignedAt)
		const serviceAfterClaim = await request(baseUrl, tokens.service, 'GET', '/api/advisor/contact/group_invite_alias/messages')
		assert.equal(serviceAfterClaim.payload.code, 0)

		const scopedCandidates = await request(baseUrl, tokens.service, 'GET', '/api/advisor/bank-teachers?contactId=group_invite_alias')
		assert.equal(scopedCandidates.payload.code, 0)
		assert.deepEqual(new Set(scopedCandidates.payload.data.list.map((item) => item.uid)), new Set([aliasAdvisor.id, aliasPeer.id]))
		assert.equal(scopedCandidates.payload.data.institutionBindingRequired, false)
		assert.equal(scopedCandidates.payload.data.list.every((item) => !Object.hasOwn(item, 'phone') && !Object.hasOwn(item, 'mobile')), true)
		const unscopedCandidates = await request(baseUrl, tokens.service, 'GET', '/api/advisor/bank-teachers')
		assert.equal(unscopedCandidates.payload.code, 0)
		assert.deepEqual(unscopedCandidates.payload.data.list, [])
		assert.equal(unscopedCandidates.payload.data.institutionBindingRequired, true)

		const explicitContact = store.state().advisorContacts.find((item) => item.id === 'group_invite_alias')
		const explicitInstitution = explicitContact.institution
		for (const body of [
			{ contactId: explicitContact.id, advisorId: crossAdvisor.id, institution: crossAdvisor.institution },
			{ contactId: explicitContact.id, advisorId: 'u_unknown_advisor', institution: explicitInstitution },
			{ contactId: explicitContact.id, advisorId: aliasAdvisor.id, institution: '中国' },
			{ contactId: explicitContact.id, institution: explicitInstitution }
		]) {
			const denied = await request(baseUrl, tokens.service, 'POST', '/api/advisor/contact/invite-advisor', body)
			assert.notEqual(denied.payload.code, 0)
			assert.equal(explicitContact.institution, explicitInstitution)
			assert.equal(explicitContact.invitedAdvisorId, undefined)
		}

		const acceptedExplicit = await request(baseUrl, tokens.service, 'POST', '/api/advisor/contact/invite-advisor', {
			contactId: explicitContact.id,
			advisorId: aliasAdvisor.id,
			institution: '平安银行'
		})
		assert.equal(acceptedExplicit.payload.code, 0)
		assert.equal(explicitContact.institution, explicitInstitution)
		assert.equal(explicitContact.invitedAdvisorId, aliasAdvisor.id)
		assert.equal(acceptedExplicit.payload.data.message.eventType, 'advisor-invited')
		assert.equal(acceptedExplicit.payload.data.message.inviteId, acceptedExplicit.payload.data.invite.id)
		assert.equal(acceptedExplicit.payload.data.message.senderType, 'system')
		assert.equal(acceptedExplicit.payload.data.message.senderRole, 'system')
		assert.equal(acceptedExplicit.payload.data.message.senderId, 'system')
		const invitedCanRead = await request(baseUrl, tokens.alias, 'GET', '/api/advisor/contact/group_invite_alias/messages')
		assert.equal(invitedCanRead.payload.code, 0)
		const invitedPeerDenied = await request(baseUrl, tokens.aliasPeer, 'GET', '/api/advisor/contact/group_invite_alias/messages')
		assert.notEqual(invitedPeerDenied.payload.code, 0)

		const serviceClaim = await request(baseUrl, tokens.service, 'POST', '/api/advisor/contact/claim', { contactId: missingContactId })
		assert.equal(serviceClaim.payload.code, 0)
		const missingServiceDetail = await request(baseUrl, tokens.service, 'GET', `/api/advisor/contact/${encodeURIComponent(missingContactId)}/messages`)
		assert.equal(missingServiceDetail.payload.code, 0)
		const unboundCandidates = await request(baseUrl, tokens.service, 'GET', `/api/advisor/bank-teachers?contactId=${encodeURIComponent(missingContactId)}`)
		assert.equal(unboundCandidates.payload.code, 0)
		assert.equal(unboundCandidates.payload.data.institutionBindingRequired, true)
		assert.equal(unboundCandidates.payload.data.list.some((item) => item.uid === emptyAdvisor.id), false)

		for (const body of [
			{ contactId: missingContactId, advisorId: 'u_unknown_advisor', institution: '平安银行' },
			{ contactId: missingContactId, advisorId: aliasAdvisor.id, institution: '兴业银行' }
		]) {
			const denied = await request(baseUrl, tokens.service, 'POST', '/api/advisor/contact/invite-advisor', body)
			assert.notEqual(denied.payload.code, 0)
			assert.equal(contactInstitutionOf(missingContact), '')
		}

		const bound = await request(baseUrl, tokens.service, 'POST', '/api/advisor/contact/invite-advisor', {
			contactId: missingContactId,
			advisorId: aliasAdvisor.id,
			institution: '平安银行'
		})
		assert.equal(bound.payload.code, 0)
		assert.equal(missingContact.institution, aliasAdvisor.institution)
		assert.equal(missingContact.invitedAdvisorId, aliasAdvisor.id)

		const newlyAuthorized = await request(baseUrl, tokens.alias, 'GET', `/api/advisor/contact/${encodeURIComponent(missingContactId)}/messages`)
		assert.equal(newlyAuthorized.payload.code, 0)
	})
})
