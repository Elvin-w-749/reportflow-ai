'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

// 必须在加载 store/user 路由前隔离数据目录和固定账号开关。
process.env.DATA_DIR = path.join(os.tmpdir(), `rpt-user-uid-${process.pid}-${Date.now()}`)
process.env.NODE_ENV = 'test'
process.env.ENABLE_FIXED_TEST_ACCOUNTS = 'true'
process.env.JWT_SECRET = process.env.JWT_SECRET || 'user-uid-test-secret-at-least-32-bytes'
process.env.SMS_PROVIDER = 'dev'

const express = require('express')
const store = require('../backend/db/store')
const userRoutes = require('../backend/routes/user')

const UID_RE = /^usr_[0-9a-f]{32}$/
const app = express()
app.use(express.json())
app.use(userRoutes)

let server
let baseUrl

test.before(async () => {
	server = app.listen(0, '127.0.0.1')
	await new Promise((resolve, reject) => {
		server.once('listening', resolve)
		server.once('error', reject)
	})
	baseUrl = `http://127.0.0.1:${server.address().port}`
})

test.after(async () => {
	if (server) await new Promise((resolve) => server.close(resolve))
	store.flushSync()
})

async function post(route, body, token = '') {
	const response = await fetch(`${baseUrl}${route}`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(token ? { authorization: `Bearer ${token}` } : {})
		},
		body: JSON.stringify(body || {})
	})
	return { status: response.status, body: await response.json() }
}

async function get(route, token) {
	const response = await fetch(`${baseUrl}${route}`, {
		headers: { authorization: `Bearer ${token}` }
	})
	return { status: response.status, body: await response.json() }
}

async function passwordRegister(phone, password = 'UidTest!2026') {
	const result = await post('/api/user/register', { phone, password })
	assert.equal(result.body.code, 0, result.body.message)
	return result.body.data
}

async function smsRegister(phone) {
	const sent = await post('/api/user/send-login-sms-code', { phone })
	assert.equal(sent.body.code, 0, sent.body.message)
	assert.match(String(sent.body.data.devCode || ''), /^\d{6}$/)
	const loggedIn = await post('/api/user/sms-login', {
		phone,
		code: sent.body.data.devCode
	})
	assert.equal(loggedIn.body.code, 0, loggedIn.body.message)
	return loggedIn.body.data
}

test('密码注册生成 usr_ + 32 位十六进制 UID，并贯穿登录、刷新和当前用户响应', async () => {
	const phone = '18810000001'
	const registered = await passwordRegister(phone)
	assert.match(registered.uid, UID_RE)

	const loggedIn = await post('/api/user/login', { phone, password: 'UidTest!2026' })
	assert.equal(loggedIn.body.code, 0, loggedIn.body.message)
	assert.equal(loggedIn.body.data.uid, registered.uid)

	const refreshed = await post('/api/user/refresh-token', {}, loggedIn.body.data.token)
	assert.equal(refreshed.body.code, 0, refreshed.body.message)
	assert.equal(refreshed.body.data.uid, registered.uid)

	const current = await get('/api/user/current', refreshed.body.data.token)
	assert.equal(current.body.code, 0, current.body.message)
	assert.equal(current.body.data.uid, registered.uid)
})

test('密码注册与短信首次登录共用相同 UUID 格式生成规则', async (t) => {
	const originalRandomUUID = crypto.randomUUID
	t.after(() => { crypto.randomUUID = originalRandomUUID })
	const expected = [
		'11111111-1111-4111-8111-111111111111',
		'22222222-2222-4222-8222-222222222222'
	]
	let cursor = 0
	crypto.randomUUID = () => expected[cursor++]

	const passwordUser = await passwordRegister('18810000002')
	const smsUser = await smsRegister('18810000003')

	assert.equal(passwordUser.uid, 'usr_11111111111141118111111111111111')
	assert.equal(smsUser.uid, 'usr_22222222222242228222222222222222')
	assert.equal(cursor, 2)
})

test('UID 碰撞时检查现有用户并重试，随后写入新的 UID', async (t) => {
	const originalRandomUUID = crypto.randomUUID
	t.after(() => { crypto.randomUUID = originalRandomUUID })
	const occupiedUuid = '33333333-3333-4333-8333-333333333333'
	const freshUuid = '44444444-4444-4444-8444-444444444444'

	crypto.randomUUID = () => occupiedUuid
	const first = await passwordRegister('18810000004')
	assert.equal(first.uid, 'usr_33333333333343338333333333333333')

	const sequence = [occupiedUuid, freshUuid]
	let cursor = 0
	crypto.randomUUID = () => sequence[cursor++]
	const second = await passwordRegister('18810000005')

	assert.equal(second.uid, 'usr_44444444444444448444444444444444')
	assert.equal(cursor, 2)
	assert.notEqual(first.uid, second.uid)
})

test('随机源持续碰撞达到明确上限后注册失败且不写入用户', async (t) => {
	const originalRandomUUID = crypto.randomUUID
	t.after(() => { crypto.randomUUID = originalRandomUUID })
	const occupiedUuid = '55555555-5555-4555-8555-555555555555'

	crypto.randomUUID = () => occupiedUuid
	await passwordRegister('18810000006')

	let calls = 0
	crypto.randomUUID = () => {
		calls += 1
		return occupiedUuid
	}
	const failed = await post('/api/user/register', {
		phone: '18810000007',
		password: 'UidTest!2026'
	})

	assert.equal(failed.body.code, 5000)
	assert.match(failed.body.message, /注册失败/)
	assert.equal(calls, 8)
	assert.equal(store.findUserByPhone('18810000007'), null)
})

test('固定测试账号继续使用 u_手机号，不受普通 UID 规则影响', async () => {
	const fixed = await passwordRegister('19600000001')
	assert.equal(fixed.uid, 'u_19600000001')
	assert.equal(fixed.userInfo.role, 'user')
})

test('批量注册产生格式正确且互不重复的 UID', async () => {
	const ids = new Set()
	for (let i = 10; i < 35; i++) {
		const phone = `188100000${String(i).padStart(2, '0')}`
		const data = await passwordRegister(phone)
		assert.match(data.uid, UID_RE)
		ids.add(data.uid)
	}
	assert.equal(ids.size, 25)
})

test('不同手机号并发注册仍生成互不重复的 UID', async () => {
	const results = await Promise.all(
		Array.from({ length: 12 }, (_, index) =>
			passwordRegister(`188200000${String(index + 1).padStart(2, '0')}`)
		)
	)
	const ids = results.map((item) => item.uid)
	ids.forEach((uid) => assert.match(uid, UID_RE))
	assert.equal(new Set(ids).size, ids.length)
})
