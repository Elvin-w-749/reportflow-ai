'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-fixed-account-production-'))
process.env.DATA_DIR = dataDir
process.env.NODE_ENV = 'production'
process.env.ENABLE_FIXED_TEST_ACCOUNTS = ''
process.env.ALLOW_EMPTY_STORE_BOOTSTRAP = 'true'
process.env.JWT_SECRET = 'fixed-account-production-jwt-secret-32-bytes'
process.env.ANALYSIS_CACHE_SECRET = 'fixed-account-production-analysis-secret-32-bytes'
process.env.DEV_ANALYZE_BEARER = 'fixed-account-production-static-bearer'
process.env.ANALYSIS_STATIC_TENANT_ID = 'fixed-account-production-test'
process.env.SMS_PROVIDER = 'custom'
process.env.RPT_RELEASE_ID = 'fixed-account-production-gate-aaaaaaa-api'
process.env.RPT_GIT_COMMIT = 'a'.repeat(40)

const jwt = require('jsonwebtoken')
const store = require('../backend/db/store')
const { app } = require('../server')

function tokenFor(user) {
	return jwt.sign(
		{ uid: user.id, phone: user.phone, tokenVersion: Number(user.tokenVersion || 0) },
		process.env.JWT_SECRET,
		{ algorithm: 'HS256', expiresIn: '1h' }
	)
}

function reportPayload(clientReportId, name, idCard) {
	return {
		reportType: '信用报告',
		fileName: `${clientReportId}.pdf`,
		clientReportId,
		analysisResult: {
			basic_info: { name, id_card: idCard }
		}
	}
}

async function upload(baseUrl, token, payload) {
	const response = await fetch(`${baseUrl}/api/report/upload`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(payload)
	})
	return { response, payload: await response.json() }
}

test('production does not grant report-unlimited permission from a fixed test phone alone', async (t) => {
	const ordinaryFixedPhone = {
		id: 'u_production_fixed_phone',
		phone: '19600000001',
		role: 'user',
		roles: ['user'],
		tokenVersion: 0
	}
	const explicitlyGranted = {
		id: 'u_production_explicit_grant',
		phone: '19600000002',
		role: 'user',
		roles: ['user'],
		tokenVersion: 0,
		reportUploadUnlimited: true
	}
	store.state().users = [ordinaryFixedPhone, explicitlyGranted]
	store.state().reports = []
	store.persistSync()

	const server = app.listen(0, '127.0.0.1')
	await new Promise((resolve, reject) => {
		server.once('listening', resolve)
		server.once('error', reject)
	})
	t.after(() => new Promise((resolve) => server.close(resolve)))
	const baseUrl = `http://127.0.0.1:${server.address().port}`

	const ordinaryToken = tokenFor(ordinaryFixedPhone)
	const first = await upload(baseUrl, ordinaryToken, reportPayload(
		'REPORT_FIXED_PROD_1',
		'生产客户甲',
		'11010519491231002X'
	))
	assert.equal(first.response.status, 200)
	assert.equal(first.payload.code, 0)

	const crossHolder = await upload(baseUrl, ordinaryToken, reportPayload(
		'REPORT_FIXED_PROD_2',
		'生产客户乙',
		'110105194912310021'
	))
	assert.equal(crossHolder.response.status, 403)
	assert.equal(crossHolder.payload.code, 3003)
	assert.match(crossHolder.payload.message || crossHolder.payload.msg, /不能上传其他人的征信报告/)

	const grantedToken = tokenFor(explicitlyGranted)
	const grantedFirst = await upload(baseUrl, grantedToken, reportPayload(
		'REPORT_GRANTED_PROD_1',
		'授权客户甲',
		'11010519491231002X'
	))
	const grantedSecond = await upload(baseUrl, grantedToken, reportPayload(
		'REPORT_GRANTED_PROD_2',
		'授权客户乙',
		'110105194912310021'
	))
	assert.equal(grantedFirst.payload.code, 0)
	assert.equal(grantedSecond.payload.code, 0)
})
