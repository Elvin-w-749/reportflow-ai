'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const TEST_ROOT = path.join(os.tmpdir(), `rpt-deploy-security-${process.pid}-${Date.now()}`)
process.env.DATA_DIR = path.join(TEST_ROOT, 'data')
process.env.LOG_DIR = path.join(TEST_ROOT, 'logs')
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'deployment-security-test-jwt-secret-32-bytes'
process.env.ANALYSIS_CACHE_SECRET = 'deployment-security-analysis-secret-32-bytes'
process.env.SMS_PROVIDER = 'dev'

const express = require('express')
const store = require('../backend/db/store')
const userRoutes = require('../backend/routes/user')
const logRoutes = require('../backend/routes/log')
const { buildAnalysisScopeHmac } = require('../backend/services/analysisIdentity')

const app = express()
app.use(express.json({ limit: '1mb' }))
app.use(userRoutes)
app.use(logRoutes)

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

function seedAnalysisScope(scope, suffix) {
	const scopeHmac = buildAnalysisScopeHmac(scope)
	const analysisKey = `ak_v3_${String(suffix).padEnd(64, '0').slice(0, 64)}`
	const leaseOwner = `lease-${suffix}`
	const claim = store.claimAnalysisJob(scopeHmac, analysisKey, leaseOwner, 60000)
	assert.equal(claim.claimed, true)
	store.completeAnalysisJob({
		scopeHmac,
		analysisKey,
		leaseOwner,
		encryptedPayload: `encrypted-${suffix}`,
		resultHash: `rh_v1_${String(suffix).padEnd(64, '1').slice(0, 64)}`,
		versionsJson: '{}',
		expiresAt: new Date(Date.now() + 86400000).toISOString()
	})
	const job = store.getAnalysisJob(scopeHmac, analysisKey)
	return { scopeHmac, analysisKey, supportRef: job.support_ref }
}

test('账号注销只级联删除该 user scope 的 analysis_results 与 analysis_jobs', async () => {
	const registered = await post('/api/user/register', {
		phone: '18839990001',
		password: 'DeploySafe!2026'
	})
	assert.equal(registered.body.code, 0, registered.body.message)
	const { uid, token } = registered.body.data
	const owned = seedAnalysisScope(`user:${uid}`, 'owned')
	const other = seedAnalysisScope('user:usr_other_scope_for_delete_test', 'other')

	assert.ok(store.getAnalysisResult(owned.scopeHmac, owned.analysisKey))
	assert.ok(store.getAnalysisJob(owned.scopeHmac, owned.analysisKey))
	const ownedTerminalBefore = store.getTrustedAnalysisEventBySupportRef(owned.supportRef)
	const otherTerminalBefore = store.getTrustedAnalysisEventBySupportRef(other.supportRef)

	const deleted = await post('/api/user/delete-account', {}, token)
	assert.equal(deleted.body.code, 0, deleted.body.message)
	assert.equal(store.getAnalysisResult(owned.scopeHmac, owned.analysisKey), null)
	assert.equal(store.getAnalysisJob(owned.scopeHmac, owned.analysisKey), null)
	assert.deepEqual(store.getTrustedAnalysisEventBySupportRef(owned.supportRef), ownedTerminalBefore)
	assert.equal(store.getScopedTrustedAnalysisEvent(owned.scopeHmac, owned.supportRef), null)
	assert.ok(store.getAnalysisResult(other.scopeHmac, other.analysisKey))
	assert.ok(store.getAnalysisJob(other.scopeHmac, other.analysisKey))
	assert.deepEqual(store.getTrustedAnalysisEventBySupportRef(other.supportRef), otherTerminalBefore)
	assert.deepEqual(store.getScopedTrustedAnalysisEvent(other.scopeHmac, other.supportRef), otherTerminalBefore)
	const database = new (require('better-sqlite3'))(store.DATA_FILE, { readonly: true })
	assert.equal(database.prepare('SELECT COUNT(*) AS total FROM analysis_support_bindings WHERE scope_hmac = ?').get(owned.scopeHmac).total, 0)
	assert.equal(database.prepare('SELECT COUNT(*) AS total FROM analysis_support_bindings WHERE scope_hmac = ?').get(other.scopeHmac).total, 1)
	database.close()
})

test('/api/log/error 对 extra 逐层白名单并在服务端递归脱敏', async () => {
	const secrets = {
		phone: '13800138000',
		idCard: '11010519491231002X',
		bankCard: '6222021234567890123',
		apiKey: 'sk-upstream-secret-1234567890',
		email: 'private@example.com',
		arbitrary: 'RAW-PDF-SHOULD-NOT-BE-LOGGED'
	}
	const supportRef = `sr_${'z'.repeat(24)}`
	const trustedCountBefore = new (require('better-sqlite3'))(store.DATA_FILE, { readonly: true })
	const eventCountBefore = trustedCountBefore.prepare('SELECT COUNT(*) AS total FROM analysis_terminal_events').get().total
	trustedCountBefore.close()
	const response = await post('/api/log/error', {
		kind: 'upload-failed',
		message: `失败 ${secrets.phone} ${secrets.apiKey} ${secrets.email}`,
		stack: `id=${secrets.idCard}`,
		page: 'report/Upload',
		rawPdf: secrets.arbitrary,
		extra: {
			action: 'upload',
			fileSize: 1024,
			clientSupportRef: supportRef,
			terminalServerTime: '2026-08-18T01:02:03.004Z',
			phone: secrets.phone,
			secret: secrets.apiKey,
			arbitrary: { stage: secrets.arbitrary },
			context: {
				stage: `card=${secrets.bankCard}; phone=${secrets.phone}`,
				details: {
					reportId: `report-${secrets.idCard}`,
					method: 'POST',
					password: secrets.arbitrary
				}
			}
		}
	})
	assert.equal(response.body.code, 0)

	const logFile = fs.readdirSync(process.env.LOG_DIR).find((name) => /^error-\d{4}-\d{2}-\d{2}\.log$/.test(name))
	assert.ok(logFile)
	const lines = fs.readFileSync(path.join(process.env.LOG_DIR, logFile), 'utf8').trim().split('\n')
	const record = JSON.parse(lines.at(-1))
	const serialized = JSON.stringify(record)
	for (const secret of Object.values(secrets)) assert.equal(serialized.includes(secret), false)

	const extra = JSON.parse(record.extra)
	assert.equal(record.sourceTrust, 'untrusted-client-report')
	assert.deepEqual(Object.keys(extra).sort(), [
		'action', 'clientSupportRef', 'context', 'fileSize', 'terminalServerTime'
	])
	assert.equal(extra.action, 'upload')
	assert.equal(extra.fileSize, 1024)
	assert.equal(extra.clientSupportRef, supportRef)
	assert.deepEqual(Object.keys(extra.context).sort(), ['details', 'stage'])
	assert.deepEqual(Object.keys(extra.context.details).sort(), ['method', 'reportId'])
	assert.match(extra.context.stage, /\*{4}/)
	assert.match(extra.context.details.reportId, /\*{8}/)
	const trustedCountAfter = new (require('better-sqlite3'))(store.DATA_FILE, { readonly: true })
	assert.equal(
		trustedCountAfter.prepare('SELECT COUNT(*) AS total FROM analysis_terminal_events').get().total,
		eventCountBefore
	)
	trustedCountAfter.close()
})

test('Kimi/Moonshot HTTP 异常的 Error 不携带上游响应正文', async (t) => {
	const modulePath = require.resolve('../moonshotVision')
	const originalFetch = global.fetch
	const previous = {
		provider: process.env.OCR_PROVIDER,
		kimi: process.env.KIMI_API_KEY,
		moonshot: process.env.MOONSHOT_API_KEY
	}
	t.after(() => {
		global.fetch = originalFetch
		if (previous.provider === undefined) delete process.env.OCR_PROVIDER
		else process.env.OCR_PROVIDER = previous.provider
		if (previous.kimi === undefined) delete process.env.KIMI_API_KEY
		else process.env.KIMI_API_KEY = previous.kimi
		if (previous.moonshot === undefined) delete process.env.MOONSHOT_API_KEY
		else process.env.MOONSHOT_API_KEY = previous.moonshot
		delete require.cache[modulePath]
	})

	const upstreamBody = 'supplier detail sk-live-leak-123456789 13800138000 RAW-UPSTREAM-BODY'
	for (const provider of ['kimi', 'moonshot']) {
		process.env.OCR_PROVIDER = provider
		if (provider === 'kimi') {
			process.env.KIMI_API_KEY = 'kimi-unit-test-key'
			delete process.env.MOONSHOT_API_KEY
		} else {
			delete process.env.KIMI_API_KEY
			process.env.MOONSHOT_API_KEY = 'moonshot-unit-test-key'
		}
		delete require.cache[modulePath]
		const { ocrImageToText } = require('../moonshotVision')
		global.fetch = async () => ({
			ok: false,
			status: 429,
			text: async () => upstreamBody
		})

		await assert.rejects(
			() => ocrImageToText('A'.repeat(200), 'image/jpeg'),
			(error) => {
				assert.equal(error.code, 'VISION_OCR_UPSTREAM_HTTP_ERROR')
				assert.equal(error.upstreamStatus, 429)
				assert.equal(String(error.message).includes(upstreamBody), false)
				assert.equal(String(error.stack).includes('RAW-UPSTREAM-BODY'), false)
				return true
			}
		)
	}
})
