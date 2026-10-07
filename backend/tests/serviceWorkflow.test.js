'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-service-workflow-'))
process.env.DATA_DIR = dataDir
process.env.JWT_SECRET = 'service-workflow-test-secret'
process.env.NODE_ENV = 'test'

const jwt = require('jsonwebtoken')
const Database = require('better-sqlite3')
const store = require('../backend/db/store')
const { app } = require('../server.js')

function tokenFor(user) {
	return jwt.sign({
		uid: user.id,
		phone: user.phone,
		tokenVersion: Number(user.tokenVersion || 0)
	}, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })
}

async function request(baseUrl, token, method, pathname, body) {
	const { response, payload } = await rawRequest(baseUrl, token, method, pathname, body)
	assert.equal(response.status, 200, `${method} ${pathname}: ${JSON.stringify(payload)}`)
	assert.equal(payload.code, 0, `${method} ${pathname}: ${JSON.stringify(payload)}`)
	return payload.data
}

async function rawRequest(baseUrl, token, method, pathname, body) {
	const response = await fetch(`${baseUrl}${pathname}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			...(body === undefined ? {} : { 'Content-Type': 'application/json' })
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) })
	})
	const payload = await response.json()
	return { response, payload }
}

function reportPayload(clientReportId, fileName, score = 650) {
	const payload = {
		reportType: 'pboc',
		fileName,
		analysisResult: {
			basic_info: {
				name: '测试客户',
				id_card: '310101199001011234'
			},
			accounts: [{
				id: `account_${clientReportId || fileName}`,
				institution: '测试银行',
				type: '信用卡',
				accountNoLast4: clientReportId ? clientReportId.slice(-4) : '0000',
				balance: 5000,
				monthly_payment: 500,
				status: 'active'
			}],
			report: { totalScore: score }
		}
	}
	if (clientReportId) payload.clientReportId = clientReportId
	return payload
}

test('service workflow is idempotent, case-isolated, and reopens only on a new customer message', async (t) => {
	const client = {
		id: 'u_workflow_client',
		phone: '19600000001',
		role: 'user',
		roles: ['user'],
		nickname: '流程测试客户',
		tokenVersion: 0
	}
	const service = {
		id: 'u_workflow_service',
		phone: '19600000003',
		role: 'service',
		roles: ['service'],
		nickname: '流程测试客服',
		institution: '平台客服中心',
		tokenVersion: 0
	}
	const state = store.state()
	state.users = [client, service]
	state.reports = []
	state.advisorContacts = []
	state.supplementMaterials = []
	state.messages = []
	store.persistSync()

	const server = app.listen(0, '127.0.0.1')
	await new Promise((resolve, reject) => {
		server.once('listening', resolve)
		server.once('error', reject)
	})
	t.after(() => new Promise((resolve) => server.close(resolve)))

	const baseUrl = `http://127.0.0.1:${server.address().port}`
	const clientToken = tokenFor(client)
	const serviceToken = tokenFor(service)

	const firstUpload = await request(baseUrl, clientToken, 'POST', '/api/report/upload', reportPayload('local_report_A', 'A.pdf'))
	assert.equal(firstUpload.clientReportId, 'local_report_A')
	assert.equal(firstUpload.caseId, firstUpload.reportId)
	assert.ok(firstUpload.contactId)
	assert.equal(firstUpload.workItemCreated, true)

	const retryUpload = await request(baseUrl, clientToken, 'POST', '/api/report/upload', reportPayload('local_report_A', 'A.pdf'))
	assert.equal(retryUpload.reused, true)
	assert.equal(retryUpload.reportId, firstUpload.reportId)
	assert.equal(retryUpload.contactId, firstUpload.contactId)
	assert.equal(retryUpload.workItemCreated, false)
	assert.equal(store.state().reports.length, 1)
	assert.equal(
		store.state().advisorContacts.filter((item) => item.reportServiceWorkItem && item.reportId === firstUpload.reportId).length,
		1
	)

	const secondUpload = await request(baseUrl, clientToken, 'POST', '/api/report/upload', reportPayload('local_report_B', 'B.pdf'))
	assert.notEqual(secondUpload.caseId, firstUpload.caseId)
	const storedReportA = store.state().reports.find((item) => item.id === firstUpload.reportId)
	const legacyV2DebtData = {
		credit_card_details: [{
			institution: '已结清旧格式银行',
			card_type: '信用卡',
			used_limit: 100,
			credit_limit: 1000,
			status: '已结清'
		}, {
			account_id: 'legacy-account-a',
			institution: '旧格式银行',
			card_type: '信用卡',
			used_limit: 7200,
			credit_limit: 14400,
			monthlyPayment: 720,
			status: '正常',
			due_date: '2026-08-15'
		}],
		loan_details: {
			bank_loans: [{
				institution: '旧格式消费金融',
				type: '消费贷',
				loan_balance: 2500,
				monthly_payment: 250,
				status: '逾期',
				overdue_days: 12
			}]
		}
	}
	storedReportA.analysisData = {
		accounts: [{}],
		creditReportV2: legacyV2DebtData
	}
	store.persistSync()

	const debtRecordA = await request(baseUrl, clientToken, 'POST', '/api/profile/debt-execution-record', {
		id: 'shared-execution-id',
		reportId: 'local_report_A',
		debtId: 'shared-debt-id',
		type: 'proof',
		status: 'reviewing',
		statusText: '待复核',
		fileName: 'repayment.png',
		uploadUrl: 'https://files.invalid/a-repayment.png'
	})
	const debtRecordB = await request(baseUrl, clientToken, 'POST', '/api/profile/debt-execution-record', {
		id: 'shared-execution-id',
		reportId: 'local_report_B',
		debtId: 'shared-debt-id',
		type: 'proof',
		status: 'reviewing',
		statusText: '待复核',
		fileName: 'repayment.png',
		uploadUrl: 'https://files.invalid/b-repayment.png'
	})
	assert.equal(debtRecordA.record.reportId, firstUpload.reportId)
	assert.equal(debtRecordA.record.clientReportId, 'local_report_A')
	assert.equal(debtRecordB.record.reportId, secondUpload.reportId)
	assert.equal(
		store.state().debtExecutionRecords.filter((item) => item.id === 'shared-execution-id').length,
		2
	)
	const forgedSingleReview = await request(baseUrl, clientToken, 'POST', '/api/profile/debt-execution-record', {
		id: 'shared-execution-id',
		reportId: 'local_report_A',
		debtId: 'shared-debt-id',
		type: 'proof',
		status: 'confirmed',
		statusText: '已确认',
		reviewNote: '用户伪造确认',
		reviewedAt: new Date().toISOString(),
		fileName: 'repayment.png',
		uploadUrl: 'https://files.invalid/a-repayment.png'
	})
	assert.equal(forgedSingleReview.record.status, 'reviewing')
	assert.equal(forgedSingleReview.record.statusText, '待复核')
	assert.equal(forgedSingleReview.record.reviewNote, '')
	const forgedBatchReview = await request(baseUrl, clientToken, 'POST', '/api/profile/debt-execution-records/sync', {
		records: [{
			id: 'shared-execution-id',
			reportId: 'local_report_B',
			debtId: 'shared-debt-id',
			type: 'proof',
			status: 'confirmed',
			statusText: '已确认',
			reviewNote: '批量伪造确认',
			reviewedAt: new Date().toISOString(),
			fileName: 'repayment.png',
			uploadUrl: 'https://files.invalid/b-repayment.png'
		}]
	})
	assert.equal(forgedBatchReview.records[0].status, 'reviewing')
	assert.equal(forgedBatchReview.records[0].statusText, '待复核')
	assert.equal(forgedBatchReview.records[0].reviewNote, '')
	const debtRecordsByAliasA = await request(
		baseUrl,
		clientToken,
		'GET',
		`/api/profile/debt-execution-records?reportId=${encodeURIComponent('local_report_A')}`
	)
	const debtRecordsByFormalA = await request(
		baseUrl,
		clientToken,
		'GET',
		`/api/profile/debt-execution-records?reportId=${encodeURIComponent(firstUpload.reportId)}`
	)
	const debtRecordsByAliasB = await request(
		baseUrl,
		clientToken,
		'GET',
		`/api/profile/debt-execution-records?reportId=${encodeURIComponent('local_report_B')}`
	)
	assert.equal(debtRecordsByAliasA.records.length, 1)
	assert.equal(debtRecordsByAliasA.records.every((item) => item.reportId === firstUpload.reportId), true)
	assert.deepEqual(
		debtRecordsByFormalA.records.map((item) => item.id).sort(),
		debtRecordsByAliasA.records.map((item) => item.id).sort()
	)
	assert.equal(debtRecordsByFormalA.records.every((item) => item.reportId === firstUpload.reportId), true)
	assert.deepEqual(debtRecordsByAliasB.records.map((item) => item.reportId), [secondUpload.reportId])

	store.state().debtExecutionRecords.push({
		id: 'historical-alias-record',
		executionRecordId: 'historical-alias-record',
		userId: client.id,
		reportId: 'local_report_A',
		debtId: 'legacy-debt-a',
		type: 'handled',
		status: 'handled',
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString()
	})
	store.persistSync()
	const projectedHistoricalRecords = await request(
		baseUrl,
		clientToken,
		'GET',
		`/api/profile/debt-execution-records?reportId=${encodeURIComponent(firstUpload.reportId)}`
	)
	assert.equal(
		projectedHistoricalRecords.records.find((item) => item.id === 'historical-alias-record').reportId,
		firstUpload.reportId
	)

	const summaryByAliasA = await request(
		baseUrl,
		clientToken,
		'GET',
		`/api/profile/debt-summary?reportId=${encodeURIComponent('local_report_A')}`
	)
	const summaryByFormalA = await request(
		baseUrl,
		clientToken,
		'GET',
		`/api/profile/debt-summary?reportId=${encodeURIComponent(firstUpload.reportId)}`
	)
	const latestDebtSummary = await request(baseUrl, clientToken, 'GET', '/api/profile/debt-summary')
	assert.equal(summaryByAliasA.reportId, firstUpload.reportId)
	assert.equal(summaryByAliasA.clientReportId, 'local_report_A')
	assert.deepEqual(summaryByAliasA.debts.map((item) => item.id), summaryByFormalA.debts.map((item) => item.id))
	assert.deepEqual(summaryByAliasA.debts.map((item) => item.id), ['legacy-account-a', 'report_2'])
	assert.equal(summaryByAliasA.totalRemaining, 9700)
	assert.equal(summaryByAliasA.debts[0].creditLimit, 14400)
	assert.equal(summaryByAliasA.debts[0].remainingAmount, 7200)
	assert.equal(summaryByAliasA.debts[0].endDate, '2026-08-15')
	assert.equal(summaryByAliasA.debts[1].isOverdue, true)
	assert.equal(summaryByAliasA.debts[1].overdueDays, 12)
	assert.equal(latestDebtSummary.reportId, secondUpload.reportId)
	for (const field of ['credit_report_full', 'credit_report_v2', 'cv2']) {
		storedReportA.analysisData = { accounts: [{}], [field]: legacyV2DebtData }
		const aliasSummary = await request(
			baseUrl,
			clientToken,
			'GET',
			`/api/profile/debt-summary?reportId=${encodeURIComponent('local_report_A')}`
		)
		assert.deepEqual(aliasSummary.debts.map((item) => item.id), ['legacy-account-a', 'report_2'], field)
		assert.equal(aliasSummary.totalRemaining, 9700, field)
	}
	storedReportA.analysisData = { accounts: [{}], creditReportV2: legacyV2DebtData }
	storedReportA.analysisData.accounts = [{
		accountId: 'legacy-account-a',
		type: '信用卡',
		usedLimit: 7200
	}, {
		type: '消费贷',
		loan_balance: 2500
	}]
	const richSourceSummary = await request(
		baseUrl,
		clientToken,
		'GET',
		`/api/profile/debt-summary?reportId=${encodeURIComponent('local_report_A')}`
	)
	assert.equal(richSourceSummary.debts[0].creditLimit, 14400)
	assert.equal(richSourceSummary.debts[0].remainingAmount, 7200)
	assert.equal(Math.round((richSourceSummary.debts[0].remainingAmount / richSourceSummary.debts[0].creditLimit) * 100), 50)
	storedReportA.analysisData = {
		creditReportV2: {
			credit_card_details: [{
				account_id: 'negated-open-card',
				card_type: '信用卡',
				used_limit: 5000,
				credit_limit: 10000,
				status: '未逾期'
			}, {
				account_id: 'closed-card',
				card_type: '信用卡',
				used_limit: 4000,
				credit_limit: 8000,
				status: '已销卡'
			}]
		}
	}
	const statusSummary = await request(
		baseUrl,
		clientToken,
		'GET',
		`/api/profile/debt-summary?reportId=${encodeURIComponent('local_report_A')}`
	)
	assert.deepEqual(statusSummary.debts.map((item) => item.id), ['negated-open-card'])
	assert.equal(statusSummary.totalRemaining, 5000)
	assert.equal(statusSummary.debts[0].creditLimit, 10000)
	assert.equal(statusSummary.debts[0].isOverdue, false)
	storedReportA.analysisData = {
		creditReportV2: {
			credit_card_details: [{
				account_id: 'card-main',
				card_type: '信用卡',
				used_limit: 5000,
				credit_limit: 10000,
				utilization_included: true,
				status: '正常'
			}, {
				account_id: 'card-companion',
				card_type: '信用卡',
				used_limit: 5000,
				credit_limit: 10000,
				utilization_included: false,
				status: '正常'
			}]
		}
	}
	const sharedLimitSummary = await request(
		baseUrl,
		clientToken,
		'GET',
		`/api/profile/debt-summary?reportId=${encodeURIComponent('local_report_A')}`
	)
	assert.deepEqual(sharedLimitSummary.debts.map((item) => item.id), ['card-main'])
	assert.equal(sharedLimitSummary.totalRemaining, 5000)
	assert.equal(sharedLimitSummary.debts[0].creditLimit, 10000)
	storedReportA.analysisData = {
		accounts: [{ accountId: 'card-closed-first', status: '已结清', usedLimit: 5000 }],
		creditReportV2: {
			credit_card_details: [{
				account_id: 'card-closed-first',
				card_type: '信用卡',
				status: '正常',
				used_limit: 5000,
				credit_limit: 10000
			}]
		}
	}
	const authoritativeSettledSummary = await request(
		baseUrl,
		clientToken,
		'GET',
		`/api/profile/debt-summary?reportId=${encodeURIComponent('local_report_A')}`
	)
	assert.equal(authoritativeSettledSummary.totalRemaining, 0)
	assert.deepEqual(authoritativeSettledSummary.debts, [])
	storedReportA.analysisData = {
		accounts: [{ institution: '无编号旧格式银行', card_type: '信用卡', status: '已结清', used_limit: 5000 }],
		creditReportV2: {
			credit_card_details: [{
				institution: '无编号旧格式银行',
				card_type: '信用卡',
				status: '正常',
				used_limit: 5000,
				credit_limit: 10000
			}]
		}
	}
	const noIdSettledSummary = await request(
		baseUrl,
		clientToken,
		'GET',
		`/api/profile/debt-summary?reportId=${encodeURIComponent('local_report_A')}`
	)
	assert.equal(noIdSettledSummary.totalRemaining, 0)
	assert.deepEqual(noIdSettledSummary.debts, [])
	storedReportA.analysisData = {
		accounts: [{ accountId: 'summary-shell', type: '信用卡' }],
		creditReportV2: {
			credit_debt: { total_debt: 50000 }
		}
	}
	const aggregateOnlySummary = await request(
		baseUrl,
		clientToken,
		'GET',
		`/api/profile/debt-summary?reportId=${encodeURIComponent('local_report_A')}`
	)
	assert.equal(aggregateOnlySummary.totalRemaining, 50000)
	assert.deepEqual(aggregateOnlySummary.debts, [])
	storedReportA.analysisData = { accounts: [{}], creditReportV2: legacyV2DebtData }

	const unknownDebtSummary = await rawRequest(
		baseUrl,
		clientToken,
		'GET',
		'/api/profile/debt-summary?reportId=unknown_report'
	)
	assert.equal(unknownDebtSummary.response.status, 404)
	assert.equal(unknownDebtSummary.payload.code, 2001)

	const debtRecordCountBeforeRejectedBatch = store.state().debtExecutionRecords.length
	const rejectedDebtBatch = await rawRequest(
		baseUrl,
		clientToken,
		'POST',
		'/api/profile/debt-execution-records/sync',
		{
			records: [
				{ id: 'valid-before-invalid', reportId: 'local_report_A', debtId: 'debt-valid', type: 'handled' },
				{ id: 'invalid-report-record', reportId: 'unknown_report', debtId: 'debt-invalid', type: 'handled' }
			]
		}
	)
	assert.equal(rejectedDebtBatch.response.status, 404)
	assert.equal(store.state().debtExecutionRecords.length, debtRecordCountBeforeRejectedBatch)

	const reportCountBeforeAliasConflict = store.state().reports.length
	const aliasConflict = await rawRequest(
		baseUrl,
		clientToken,
		'POST',
		'/api/report/upload',
		reportPayload(firstUpload.reportId, 'alias-conflict.pdf')
	)
	assert.equal(aliasConflict.response.status, 409)
	assert.equal(aliasConflict.payload.code, 1001)
	assert.match(aliasConflict.payload.message, /clientReportId/)
	assert.equal(store.state().reports.length, reportCountBeforeAliasConflict)

	const productContact = await request(baseUrl, clientToken, 'POST', '/api/advisor/contact', {
		reportId: 'local_report_A',
		contactType: 'match-product',
		channel: 'bank',
		institution: '平安银行',
		productId: 'pa-001',
		productName: '平安测试方案'
	})
	assert.equal(productContact.record.reportId, firstUpload.reportId)
	assert.equal(productContact.record.caseId, firstUpload.caseId)
	assert.equal(productContact.record.channel, 'bank')
	assert.equal(productContact.record.groupMode, 'service-bank-customer')
	assert.equal(productContact.record.serviceRequired, true)

	const materialA = await request(baseUrl, clientToken, 'POST', '/api/profile/supplement-material', {
		caseId: 'local_report_A',
		id: 'income',
		materialType: 'income',
		name: '收入证明 A',
		uploadUrl: 'https://files.invalid/a.pdf',
		status: 'confirmed',
		statusText: '已确认',
		reviewNote: '用户伪造材料确认',
		reviewedAt: new Date().toISOString()
	})
	const materialB = await request(baseUrl, clientToken, 'POST', '/api/profile/supplement-material', {
		reportId: 'local_report_B',
		id: 'income',
		materialType: 'income',
		name: '收入证明 B',
		uploadUrl: 'https://files.invalid/b.pdf'
	})
	assert.equal(materialA.caseId, firstUpload.caseId)
	assert.equal(materialA.material.status, 'uploaded')
	assert.equal(materialA.material.statusText, '待确认')
	assert.equal(materialA.material.reviewNote, '')
	assert.equal(materialA.material.reviewedAt, '')
	assert.equal(materialB.caseId, secondUpload.caseId)
	assert.equal(store.state().supplementMaterials.length, 2)
	const formalPriorityMaterial = await request(baseUrl, clientToken, 'POST', '/api/profile/supplement-material', {
		reportId: firstUpload.reportId,
		clientReportId: 'local_report_B',
		id: 'formal-priority',
		materialType: 'identity',
		name: '正式 ID 优先资料',
		uploadUrl: 'https://files.invalid/formal-priority.pdf'
	})
	assert.equal(formalPriorityMaterial.caseId, firstUpload.caseId)
	assert.equal(formalPriorityMaterial.reportId, firstUpload.reportId)
	assert.equal(formalPriorityMaterial.clientReportId, 'local_report_A')
	assert.equal(store.state().supplementMaterials.length, 3)
	const conflictingAliases = await rawRequest(
		baseUrl,
		clientToken,
		'POST',
		'/api/profile/supplement-material',
		{
			reportId: 'local_report_A',
			clientReportId: 'local_report_B',
			id: 'must-not-cross-case',
			materialType: 'identity',
			name: '冲突别名资料',
			uploadUrl: 'https://files.invalid/must-not-cross-case.pdf'
		}
	)
	assert.equal(conflictingAliases.response.status, 409)
	assert.equal(conflictingAliases.payload.code, 1001)
	assert.match(conflictingAliases.payload.message, /不同 case/)
	assert.equal(store.state().supplementMaterials.length, 3)

	const listA = await request(
		baseUrl,
		clientToken,
		'GET',
		`/api/profile/supplement-materials?reportId=${encodeURIComponent('local_report_A')}`
	)
	assert.equal(listA.caseId, firstUpload.caseId)
	assert.equal(listA.total, 2)
	assert.deepEqual(
		new Set(listA.list.map((item) => item.name)),
		new Set(['正式 ID 优先资料', '收入证明 A'])
	)

	const serviceContactA = store.state().advisorContacts.find((item) => item.id === firstUpload.contactId)
	const serviceContactB = store.state().advisorContacts.find((item) => item.id === secondUpload.contactId)
	const productContactA = store.state().advisorContacts.find((item) => item.id === productContact.contactId)
	assert.deepEqual(
		new Set(serviceContactA.supplementMaterials.map((item) => item.name)),
		new Set(['正式 ID 优先资料', '收入证明 A'])
	)
	assert.deepEqual(serviceContactB.supplementMaterials.map((item) => item.name), ['收入证明 B'])
	assert.deepEqual(
		new Set(productContactA.supplementMaterials.map((item) => item.name)),
		new Set(['正式 ID 优先资料', '收入证明 A'])
	)

	const localOnlyMaterial = await request(baseUrl, clientToken, 'POST', '/api/profile/supplement-material', {
		reportId: 'local_report_A',
		id: 'address-local-only',
		materialType: 'address',
		name: '本机待同步住址证明',
		status: 'uploaded',
		statusText: '待确认',
		localFilePath: 'C:\\private\\address.pdf',
		fileUrl: 'wxfile://private/address.pdf',
		attachments: [{
			id: 'address-local-attachment',
			fileName: 'address.pdf',
			localFilePath: 'C:\\private\\address.pdf',
			uploadUrl: 'blob:https://client.invalid/address'
		}]
	})
	assert.equal(localOnlyMaterial.material.status, 'queued')
	assert.equal(localOnlyMaterial.material.statusText, '本机已保存')
	assert.equal(Object.prototype.hasOwnProperty.call(localOnlyMaterial.material, 'localFilePath'), false)
	assert.deepEqual(localOnlyMaterial.material.attachments, [])
	const storedLocalOnlyMaterial = store.state().supplementMaterials.find((item) => item.id === 'address-local-only')
	assert.ok(storedLocalOnlyMaterial)
	assert.equal(Object.prototype.hasOwnProperty.call(storedLocalOnlyMaterial, 'localFilePath'), false)
	assert.deepEqual(storedLocalOnlyMaterial.attachments, [])

	const orphanContact = await request(baseUrl, clientToken, 'POST', '/api/advisor/contact', {
		reportId: 'local_report_C',
		contactType: 'customer-service',
		channel: 'service'
	})
	const orphanRecord = store.state().advisorContacts.find((item) => item.id === orphanContact.contactId)
	assert.equal(orphanRecord.caseId, 'local_report_C')
	assert.equal(orphanRecord.context.caseId, 'local_report_C')
	const orphanMaterial = await request(baseUrl, clientToken, 'POST', '/api/profile/supplement-material', {
		caseId: 'local_report_C',
		id: 'pre-upload-income',
		materialType: 'income',
		name: '先于报告上传的收入证明',
		uploadUrl: 'https://files.invalid/pre-upload.pdf'
	})
	assert.equal(orphanMaterial.caseId, 'local_report_C')
	assert.deepEqual(orphanMaterial.syncedContactIds, [orphanContact.contactId])
	orphanRecord.supplementMaterials.push({
		...orphanRecord.supplementMaterials[0],
		updatedAt: '2020-01-01T00:00:00.000Z'
	})
	orphanRecord.materials = [
		{
			id: 'nested-proof',
			materialId: 'nested-proof',
			materialType: 'proof',
			status: 'uploaded',
			uploadUrl: 'https://files.invalid/nested-proof.pdf'
		},
		{
			id: 'nested-proof',
			materialId: 'nested-proof',
			materialType: 'proof',
			status: 'uploaded',
			uploadUrl: 'https://files.invalid/nested-proof.pdf'
		},
		{
			id: 'foreign-case-proof',
			materialId: 'foreign-case-proof',
			materialType: 'proof',
			caseId: secondUpload.caseId,
			reportId: secondUpload.reportId,
			status: 'uploaded',
			uploadUrl: 'https://files.invalid/foreign.pdf'
		}
	]
	store.persistSync()
	const thirdUpload = await request(baseUrl, clientToken, 'POST', '/api/report/upload', reportPayload('local_report_C', 'C.pdf'))
	assert.equal(thirdUpload.migratedMaterials, 1)
	assert.equal(thirdUpload.contactId, orphanContact.contactId)
	const migratedMaterial = store.state().supplementMaterials.find((item) => item.id === 'pre-upload-income')
	assert.equal(migratedMaterial.caseId, thirdUpload.caseId)
	assert.equal(migratedMaterial.materialScopeId, thirdUpload.caseId)
	assert.equal(migratedMaterial.reportId, thirdUpload.reportId)
	assert.equal(migratedMaterial.clientReportId, 'local_report_C')
	const serviceContactC = store.state().advisorContacts.find((item) => item.id === thirdUpload.contactId)
	assert.equal(serviceContactC.caseId, thirdUpload.caseId)
	assert.equal(serviceContactC.reportId, thirdUpload.reportId)
	assert.equal(serviceContactC.context.caseId, thirdUpload.caseId)
	assert.equal(serviceContactC.context.reportId, thirdUpload.reportId)
	assert.deepEqual(serviceContactC.supplementMaterials.map((item) => item.name), ['先于报告上传的收入证明'])
	assert.equal(serviceContactC.materials.filter((item) => item.id === 'nested-proof').length, 1)
	assert.equal(serviceContactC.materials.find((item) => item.id === 'nested-proof').caseId, thirdUpload.caseId)
	assert.equal(serviceContactC.materials.find((item) => item.id === 'foreign-case-proof').caseId, secondUpload.caseId)

	const legacyUploadPayload = reportPayload('', 'legacy-client.pdf', 701)
	const legacyUpload = await request(baseUrl, clientToken, 'POST', '/api/report/upload', legacyUploadPayload)
	const storedLegacyUpload = store.state().reports.find((item) => item.id === legacyUpload.reportId)
	delete storedLegacyUpload.uploadFingerprint
	store.persistSync()
	const legacyRetry = await request(baseUrl, clientToken, 'POST', '/api/report/upload', legacyUploadPayload)
	assert.equal(legacyRetry.reused, true)
	assert.equal(legacyRetry.reuseReason, 'upload-fingerprint')
	assert.equal(legacyRetry.reportId, legacyUpload.reportId)
	assert.equal(legacyRetry.contactId, legacyUpload.contactId)
	assert.match(storedLegacyUpload.uploadFingerprint, /^[a-f0-9]{64}$/)
	const changedLegacyUpload = await request(
		baseUrl,
		clientToken,
		'POST',
		'/api/report/upload',
		reportPayload('', 'legacy-client.pdf', 702)
	)
	assert.equal(changedLegacyUpload.reused, false)
	assert.notEqual(changedLegacyUpload.reportId, legacyUpload.reportId)

	const legacyContact = {
		_id: 'c_legacy_no_scope',
		id: 'c_legacy_no_scope',
		contactId: 'c_legacy_no_scope',
		userId: client.id,
		contactType: 'customer-service',
		channel: 'service',
		deskType: 'service',
		status: 'pending',
		serviceStatus: 'open',
		orderStatus: 'open',
		messages: [],
		supplementMaterials: [],
		createdAt: new Date().toISOString(),
		updateTime: new Date().toISOString()
	}
	store.state().advisorContacts.unshift(legacyContact)
	store.persistSync()
	const forgedContactMaterial = await request(baseUrl, clientToken, 'POST', '/api/advisor/contact/material-submit', {
		contactId: legacyContact.id,
		id: 'legacy-forged-confirmed-material',
		materialType: 'income',
		name: '旧版用户材料',
		uploadUrl: 'https://files.invalid/legacy-forged-material.pdf',
		status: 'confirmed',
		statusText: '已确认',
		reviewNote: '用户伪造确认',
		reviewedAt: new Date().toISOString()
	})
	assert.equal(forgedContactMaterial.material.status, 'uploaded')
	assert.equal(forgedContactMaterial.material.statusText, '待确认')
	assert.equal(forgedContactMaterial.material.reviewNote, '')
	assert.equal(forgedContactMaterial.material.reviewedAt, '')
	const legacyMaterial = await request(baseUrl, clientToken, 'POST', '/api/profile/supplement-material', {
		id: 'legacy-income',
		materialType: 'income',
		name: '旧版未归档资料',
		uploadUrl: 'https://files.invalid/legacy.pdf'
	})
	assert.equal(legacyMaterial.caseId, 'legacy')
	assert.equal(serviceContactA.supplementMaterials.some((item) => item.name === '旧版未归档资料'), false)
	assert.equal(serviceContactB.supplementMaterials.some((item) => item.name === '旧版未归档资料'), false)
	assert.deepEqual(legacyContact.supplementMaterials.map((item) => item.name), ['旧版未归档资料'])

	serviceContactA.requiredMaterials = [{
		id: 'wrong-case-sensitive',
		materialId: 'wrong-case-sensitive',
		materialType: 'identity',
		caseId: secondUpload.caseId,
		reportId: secondUpload.reportId,
		name: '不应出现在 A 案件摘要中的敏感材料',
		uploadUrl: 'https://files.invalid/wrong-case-sensitive.pdf',
		status: 'uploaded'
	}]
	serviceContactA.materials = [{
		id: 'stale-income-checklist',
		materialId: 'stale-income-checklist',
		materialType: 'income',
		caseId: 'local_report_A',
		reportId: 'local_report_A',
		status: 'pending',
		statusText: '待补充'
	}]
	serviceContactA.pendingMaterials = [
		{
			id: 'income-duplicate-id',
			materialId: 'income-duplicate-id',
			materialType: 'income',
			caseId: firstUpload.caseId,
			reportId: firstUpload.reportId,
			status: 'pending',
			statusText: '待补充'
		},
		{
			id: 'address-proof',
			materialId: 'address-proof',
			materialType: 'address',
			caseId: firstUpload.caseId,
			reportId: firstUpload.reportId,
			status: 'draft',
			statusText: '待上传'
		}
	]
	serviceContactA.debtProofs = [{
		id: 'sensitive-debt-proof',
		type: 'debt-proof',
		caseId: firstUpload.caseId,
		reportId: firstUpload.reportId,
		fileName: '客户债务凭证.pdf',
		uploadUrl: 'https://files.invalid/debt-proof.pdf',
		status: 'uploaded'
	}]
	store.persistSync()
	const unclaimedContacts = await request(baseUrl, serviceToken, 'GET', '/api/advisor/contacts')
	const redactedA = unclaimedContacts.list.find((item) => item.id === firstUpload.contactId)
	assert.ok(redactedA)
	assert.equal(redactedA.leadOnly, true)
	assert.equal(redactedA.claimRequired, true)
	assert.equal(redactedA.materialAccess, false)
	assert.equal(redactedA.chatAccess, false)
	assert.deepEqual(redactedA.messages, [])
	assert.equal(Object.hasOwn(redactedA, 'materialsRedacted'), false)
	assert.equal(Object.hasOwn(redactedA, 'materials'), false)
	assert.equal(Object.hasOwn(redactedA, 'supplementMaterials'), false)
	assert.equal(Object.hasOwn(redactedA, 'requiredMaterials'), false)
	assert.equal(Object.hasOwn(redactedA, 'materialProgressSummary'), false)
	const redactedJson = JSON.stringify(redactedA)
	assert.equal(redactedJson.includes('https://files.invalid/a.pdf'), false)
	assert.equal(redactedJson.includes('不应出现在 A 案件摘要中的敏感材料'), false)
	assert.equal(redactedJson.includes('客户债务凭证.pdf'), false)
	assert.equal(redactedJson.includes('https://files.invalid/debt-proof.pdf'), false)

	await request(baseUrl, serviceToken, 'POST', '/api/advisor/contact/claim', {
		contactId: firstUpload.contactId
	})
	await request(baseUrl, serviceToken, 'POST', '/api/advisor/contact/claim', {
		contactId: secondUpload.contactId
	})
	const staleAliasCannotAuthorizeAnotherCase = await rawRequest(
		baseUrl,
		serviceToken,
		'POST',
		'/api/advisor/contact/material-review',
		{
			contactId: secondUpload.contactId,
			reportId: firstUpload.reportId,
			clientReportId: 'local_report_B',
			executionRecordId: 'shared-execution-id',
			debtId: 'shared-debt-id',
			materialType: 'debt-proof',
			status: 'confirmed',
			statusText: '已确认'
		}
	)
	assert.equal(staleAliasCannotAuthorizeAnotherCase.response.status, 409)
	assert.equal(
		store.state().debtExecutionRecords.find((item) => item.reportId === secondUpload.reportId && item.id === 'shared-execution-id').statusText,
		'待复核'
	)
	const forgedCrossReportReview = await rawRequest(
		baseUrl,
		serviceToken,
		'POST',
		'/api/advisor/contact/material-review',
		{
			contactId: firstUpload.contactId,
			reportId: secondUpload.reportId,
			executionRecordId: 'shared-execution-id',
			debtId: 'shared-debt-id',
			materialType: 'debt-proof',
			status: 'confirmed',
			statusText: '已确认'
		}
	)
	assert.equal(forgedCrossReportReview.response.status, 409)
	assert.equal(
		store.state().debtExecutionRecords.find((item) => item.reportId === secondUpload.reportId && item.id === 'shared-execution-id').statusText,
		'待复核'
	)
	const serviceNote = await request(baseUrl, serviceToken, 'POST', '/api/advisor/contact/notes', {
		contactId: firstUpload.contactId,
		note: '客服已核对当前报告资料'
	})
	assert.equal(serviceNote.notes[0].text, '客服已核对当前报告资料')
	await request(baseUrl, serviceToken, 'POST', '/api/advisor/contact/status', {
		contactId: firstUpload.contactId,
		status: 'processing'
	})
	assert.equal(serviceContactA.status, 'processing')
	const reviewedMaterial = await request(baseUrl, serviceToken, 'POST', '/api/advisor/contact/material-review', {
		contactId: firstUpload.contactId,
		id: 'income',
		materialType: 'income',
		name: '收入证明 A（客服复核）',
		status: 'confirmed',
		statusText: '已确认',
		reviewNote: '清晰完整'
	})
	assert.equal(reviewedMaterial.material.status, 'confirmed')
	assert.equal(reviewedMaterial.material.statusText, '已确认')
	assert.equal(reviewedMaterial.material.uploadUrl, 'https://files.invalid/a.pdf')
	assert.equal(
		store.state().supplementMaterials.find((item) => item.caseId === firstUpload.caseId && item.id === 'income').status,
		'confirmed'
	)
	assert.equal(
		store.state().supplementMaterials.find((item) => item.caseId === secondUpload.caseId && item.id === 'income').status,
		'uploaded'
	)
	assert.equal(serviceContactA.supplementMaterials.find((item) => item.id === 'income').statusText, '已确认')
	assert.equal(productContactA.supplementMaterials.find((item) => item.id === 'income').statusText, '已确认')
	assert.equal(serviceContactB.supplementMaterials[0].statusText, '待确认')

	const reviewedListA = await request(
		baseUrl,
		clientToken,
		'GET',
		`/api/profile/supplement-materials?reportId=${encodeURIComponent('local_report_A')}`
	)
	const reviewedIncome = reviewedListA.list.find((item) => item.id === 'income')
	assert.equal(reviewedIncome.statusText, '已确认')
	assert.equal(reviewedIncome.reviewNote, '清晰完整')

	const reuploadedIncome = await request(baseUrl, clientToken, 'POST', '/api/profile/supplement-material', {
		reportId: 'local_report_A',
		id: 'income',
		materialType: 'income',
		name: '收入证明 A（重新上传）',
		status: 'uploaded',
		statusText: '待确认',
		uploadUrl: 'https://files.invalid/a-reuploaded.pdf',
		uploadedAt: new Date(Date.now() + 1000).toISOString()
	})
	assert.equal(reuploadedIncome.material.status, 'uploaded')
	await request(baseUrl, serviceToken, 'POST', '/api/advisor/contact/material-review', {
		contactId: firstUpload.contactId,
		id: 'address-local-only',
		materialType: 'address',
		name: '住址证明',
		status: 'unneeded',
		statusText: '无需'
	})
	const postReviewContacts = await request(baseUrl, serviceToken, 'GET', '/api/advisor/contacts')
	const postReviewContactA = postReviewContacts.list.find((item) => item.id === firstUpload.contactId)
	assert.equal(postReviewContactA.materialProgressSummary.total, 5)
	assert.equal(postReviewContactA.materialProgressSummary.uploaded, 4)
	assert.equal(postReviewContactA.materialProgressSummary.pendingReview, 4)
	assert.equal(postReviewContactA.materialProgressSummary.confirmed, 0)
	assert.equal(postReviewContactA.materialProgressSummary.unavailable, 1)
	assert.equal(postReviewContactA.materialProgressSummary.pendingSupplement, 0)
	assert.equal(postReviewContactA.materialProgressSummary.completionState, 'pending-review')
	assert.equal(postReviewContactA.supplementMaterials.find((item) => item.id === 'income').status, 'uploaded')
	assert.equal(postReviewContactA.supplementMaterials.find((item) => item.id === 'address-local-only').status, 'unneeded')
	assert.equal(postReviewContactA.debtExecutionRecords.length, 2)
	assert.equal(postReviewContactA.debtExecutionRecords.every((item) => item.reportId === firstUpload.reportId), true)
	delete serviceContactA.debtExecutionRecords
	const fallbackScopedContacts = await request(baseUrl, serviceToken, 'GET', '/api/advisor/contacts')
	const fallbackScopedContactA = fallbackScopedContacts.list.find((item) => item.id === firstUpload.contactId)
	assert.equal(fallbackScopedContactA.debtExecutionRecords.length, 2)
	assert.equal(fallbackScopedContactA.debtExecutionRecords.every((item) => item.reportId === firstUpload.reportId), true)
	serviceContactA.debtExecutionRecords = [debtRecordA.record]

	const formalPriorityDebtRecord = await request(baseUrl, clientToken, 'POST', '/api/profile/debt-execution-record', {
		id: 'formal-priority-debt-record',
		reportId: firstUpload.reportId,
		clientReportId: 'local_report_B',
		debtId: 'formal-priority-debt',
		type: 'handled'
	})
	assert.equal(formalPriorityDebtRecord.record.reportId, firstUpload.reportId)
	assert.equal(formalPriorityDebtRecord.record.clientReportId, 'local_report_A')

	await request(baseUrl, serviceToken, 'POST', '/api/advisor/contact/material-review', {
		contactId: firstUpload.contactId,
		id: 'debt-proof-shared-execution-id',
		executionRecordId: 'shared-execution-id',
		debtId: 'shared-debt-id',
		materialType: 'debt-proof',
		name: 'A 报告还款凭证',
		status: 'confirmed',
		statusText: '已确认',
		reviewNote: 'A 报告凭证已确认'
	})
	const scopedDebtRecordsAfterReview = store.state().debtExecutionRecords
		.filter((item) => item.id === 'shared-execution-id')
	assert.equal(
		scopedDebtRecordsAfterReview.find((item) => item.reportId === firstUpload.reportId).statusText,
		'已确认'
	)
	assert.equal(
		scopedDebtRecordsAfterReview.find((item) => item.reportId === secondUpload.reportId).statusText,
		'待复核'
	)
	const acknowledgedReviewedDebt = await request(baseUrl, clientToken, 'POST', '/api/profile/debt-execution-record', {
		id: 'shared-execution-id',
		reportId: 'local_report_A',
		debtId: 'forged-other-debt',
		type: 'proof',
		status: 'reviewing',
		statusText: '待复核',
		fileName: 'replacement.png',
		uploadUrl: 'https://files.invalid/replacement.png',
		reviewAckStage: 'review_acknowledged',
		reviewAcknowledgedAt: '2026-07-28T12:00:00.000Z',
		reviewAcknowledgedNote: '用户已查看'
	})
	assert.equal(acknowledgedReviewedDebt.record.statusText, '已确认')
	assert.equal(acknowledgedReviewedDebt.record.reviewNote, 'A 报告凭证已确认')
	assert.equal(acknowledgedReviewedDebt.record.debtId, 'shared-debt-id')
	assert.equal(acknowledgedReviewedDebt.record.fileName, 'repayment.png')
	assert.equal(acknowledgedReviewedDebt.record.uploadUrl, 'https://files.invalid/a-repayment.png')
	assert.equal(acknowledgedReviewedDebt.record.reviewAckStage, 'review_acknowledged')
	assert.equal(acknowledgedReviewedDebt.record.reviewAcknowledgedAt, '2026-07-28T12:00:00.000Z')
	await request(baseUrl, serviceToken, 'POST', '/api/advisor/contact/material-review', {
		contactId: firstUpload.contactId,
		id: 'debt-proof-shared-execution-id',
		executionRecordId: 'shared-execution-id',
		debtId: 'shared-debt-id',
		materialType: 'debt-proof',
		name: 'A 报告还款凭证',
		status: 'unneeded',
		statusText: '无需',
		reviewNote: '该凭证无需继续补充'
	})
	const acknowledgedUnneededDebt = await request(baseUrl, clientToken, 'POST', '/api/profile/debt-execution-records/sync', {
		records: [{
			id: 'shared-execution-id',
			reportId: 'local_report_A',
			debtId: 'shared-debt-id',
			type: 'proof',
			status: 'reviewing',
			statusText: '待复核',
			reviewAckStage: 'review_acknowledged',
			reviewAcknowledgedAt: '2026-07-28T12:01:00.000Z'
		}]
	})
	assert.equal(acknowledgedUnneededDebt.records[0].status, 'unneeded')
	assert.equal(acknowledgedUnneededDebt.records[0].statusText, '无需')
	assert.equal(acknowledgedUnneededDebt.records[0].reviewNote, '该凭证无需继续补充')
	assert.equal(acknowledgedUnneededDebt.records[0].reviewAckStage, 'review_acknowledged')

	const legacyDebtContact = await request(baseUrl, clientToken, 'POST', '/api/advisor/contact', {
		contactType: 'debt-optimization',
		channel: 'service',
		deskType: 'service',
		serviceRequired: true,
		contactIntent: 'legacy-unscoped-debt-review',
		summary: '旧版无报告号债务复核'
	})
	assert.equal(legacyDebtContact.record.reportId, '')
	const legacyDebtRecord = await request(baseUrl, clientToken, 'POST', '/api/profile/debt-execution-record', {
		id: 'legacy-unscoped-debt-record',
		debtId: 'legacy-unscoped-debt',
		type: 'proof',
		status: 'reviewing',
		statusText: '待复核',
		fileName: 'legacy-proof.png',
		uploadUrl: 'https://files.invalid/legacy-proof.png'
	})
	assert.equal(legacyDebtRecord.record.reportId, '')
	await request(baseUrl, serviceToken, 'POST', '/api/advisor/contact/claim', {
		contactId: legacyDebtContact.contactId
	})
	await request(baseUrl, serviceToken, 'POST', '/api/advisor/contact/material-review', {
		contactId: legacyDebtContact.contactId,
		id: 'legacy-unscoped-review',
		debtId: 'legacy-unscoped-debt',
		materialType: 'debt-proof',
		status: 'confirmed',
		statusText: '已确认'
	})
	assert.equal(
		store.state().debtExecutionRecords.find((item) => item.id === 'legacy-unscoped-debt-record').statusText,
		'已确认'
	)

	const firstClear = await request(baseUrl, serviceToken, 'POST', '/api/advisor/contact/clear-view', {
		contactId: firstUpload.contactId
	})
	assert.ok(firstClear.clearRecord.clearSequence > 0)
	assert.equal(firstClear.reopenedByCustomer, false)

	const db = new Database(store.DATA_FILE, { readonly: true })
	t.after(() => db.close())
	const persistedContacts = JSON.parse(db.prepare("SELECT data FROM collections WHERE name = 'advisorContacts'").get().data)
	const persisted = persistedContacts.find((item) => item.id === firstUpload.contactId)
	assert.equal(persisted.chatClears.at(-1).id, firstClear.clearRecord.id)

	let serviceContacts = await request(baseUrl, serviceToken, 'GET', '/api/advisor/contacts')
	assert.equal(serviceContacts.list.some((item) => item.id === firstUpload.contactId), false)

	await request(baseUrl, serviceToken, 'POST', '/api/advisor/contact/message', {
		contactId: firstUpload.contactId,
		content: '客服自己的后续说明不应重新打开已隐藏窗口'
	})
	serviceContacts = await request(baseUrl, serviceToken, 'GET', '/api/advisor/contacts')
	assert.equal(serviceContacts.list.some((item) => item.id === firstUpload.contactId), false)

	const customerReply = await request(baseUrl, clientToken, 'POST', '/api/advisor/contact/message', {
		contactId: firstUpload.contactId,
		content: '客户提交新的补充说明'
	})
	assert.equal(customerReply.reopenedByCustomer, true)
	assert.equal(customerReply.reopenedClearCount, 1)

	serviceContacts = await request(baseUrl, serviceToken, 'GET', '/api/advisor/contacts')
	const reopened = serviceContacts.list.find((item) => item.id === firstUpload.contactId)
	assert.ok(reopened)
	assert.equal(reopened.reopenedByCustomer, true)
	assert.equal(reopened.reopenedMessageId, customerReply.message.id)
	assert.ok(customerReply.message.messageSequence > firstClear.clearRecord.clearSequence)

	await request(baseUrl, clientToken, 'DELETE', `/api/report/${encodeURIComponent(firstUpload.reportId)}`)
	for (const pathname of [
		`/api/profile/debt-execution-records?reportId=${encodeURIComponent('local_report_A')}`,
		`/api/profile/debt-summary?reportId=${encodeURIComponent(firstUpload.reportId)}`
	]) {
		const hiddenRead = await rawRequest(baseUrl, clientToken, 'GET', pathname)
		assert.equal(hiddenRead.response.status, 404)
		assert.equal(hiddenRead.payload.code, 2001)
	}
	const hiddenWrite = await rawRequest(
		baseUrl,
		clientToken,
		'POST',
		'/api/profile/debt-execution-record',
		{ id: 'hidden-report-write', reportId: 'local_report_A', debtId: 'hidden-debt', type: 'handled' }
	)
	assert.equal(hiddenWrite.response.status, 404)
	const hiddenBatch = await rawRequest(
		baseUrl,
		clientToken,
		'POST',
		'/api/profile/debt-execution-records/sync',
		{ records: [{ id: 'hidden-report-batch', reportId: firstUpload.reportId, debtId: 'hidden-debt', type: 'handled' }] }
	)
	assert.equal(hiddenBatch.response.status, 404)
	const visibleDebtRecords = await request(baseUrl, clientToken, 'GET', '/api/profile/debt-execution-records')
	assert.equal(visibleDebtRecords.records.some((item) => item.reportId === firstUpload.reportId), false)
	const hiddenAliasMismatch = await rawRequest(
		baseUrl,
		clientToken,
		'POST',
		'/api/report/upload',
		reportPayload('local_report_A', 'new-after-delete.pdf')
	)
	assert.equal(hiddenAliasMismatch.response.status, 409)
	assert.equal(hiddenAliasMismatch.payload.data.reason, 'idempotency-content-mismatch')
	assert.equal(store.state().reports.find((item) => item.id === firstUpload.reportId).hiddenFromOwner, true)
	const restoredUpload = await request(
		baseUrl,
		clientToken,
		'POST',
		'/api/report/upload',
		reportPayload('local_report_A', 'A.pdf')
	)
	assert.equal(restoredUpload.reportId, firstUpload.reportId)
	assert.equal(restoredUpload.reused, true)
	assert.equal(restoredUpload.restored, true)
	const restoredList = await request(baseUrl, clientToken, 'POST', '/api/report/list', { page: 1, pageSize: 50 })
	assert.equal(restoredList.list.some((item) => item.id === firstUpload.reportId), true)
	const restoredDetail = await request(baseUrl, clientToken, 'GET', `/api/report/${encodeURIComponent(firstUpload.reportId)}`)
	assert.equal(restoredDetail.id, firstUpload.reportId)
	const restoredDebtSummary = await request(
		baseUrl,
		clientToken,
		'GET',
		`/api/profile/debt-summary?reportId=${encodeURIComponent('local_report_A')}`
	)
	assert.equal(restoredDebtSummary.reportId, firstUpload.reportId)
})
