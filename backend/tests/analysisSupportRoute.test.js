'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-analysis-support-route-'))
process.env.DATA_DIR = path.join(root, 'data')
process.env.LOG_DIR = path.join(root, 'logs')
process.env.ANALYSIS_CACHE_SECRET = 'analysis-support-route-secret-at-least-32-bytes'
process.env.JWT_SECRET = 'analysis-support-route-jwt-secret'
process.env.NODE_ENV = 'test'
process.env.RPT_RELEASE_ID = ''
process.env.RPT_GIT_COMMIT = ''

const jwt = require('jsonwebtoken')
const store = require('../backend/db/store')
const analysisTaskService = require('../backend/services/analysisTaskService')
const { buildAnalysisIdentity } = require('../backend/services/analysisIdentity')
const { app } = require('../server')

function tokenFor(user) {
	return jwt.sign(
		{ uid: user.id, phone: user.phone, tokenVersion: Number(user.tokenVersion || 0) },
		process.env.JWT_SECRET,
		{ algorithm: 'HS256', expiresIn: '1h' }
	)
}

async function request(baseUrl, pathname, options = {}) {
	const response = await fetch(`${baseUrl}${pathname}`, options)
	return { response, payload: await response.json() }
}

test('support lookup is owner-scoped while ops trace lookup is authenticated and read-only', async (t) => {
	const owner = { id: 'support_owner', phone: '19600003001', role: 'user', tokenVersion: 0 }
	const other = { id: 'support_other', phone: '19600003002', role: 'user', tokenVersion: 0 }
	const monitor = { id: 'support_monitor', phone: '19600003003', role: 'monitor', tokenVersion: 0 }
	store.state().users = [owner, other, monitor]
	store.persistSync()

	const content = Buffer.from('%PDF-1.7\nSUPPORT_ROUTE_TERMINAL\n%%EOF')
	const identity = buildAnalysisIdentity({
		content,
		scope: `user:${owner.id}`,
		inputKind: 'credit-report-pdf'
	})
	const jobId = `aj_${Buffer.alloc(18, 31).toString('base64url')}`
	const enqueued = store.enqueueAnalysisJob({
		scopeHmac: identity.scopeHmac,
		analysisKey: identity.analysisKey,
		jobId,
		documentId: identity.documentId,
		inputKind: 'credit-report-pdf',
		inputPath: path.join(root, `${jobId}.bin`),
		inputSize: content.length,
		scopeCiphertext: 'support-route-scope'
	})
	const supportRef = enqueued.job.support_ref
	assert.equal(store.failQueuedAnalysisJob(
		identity.scopeHmac,
		identity.analysisKey,
		'EVIDENCE_PUBLICATION_BLOCKED',
		{
			errorClass: 'evidence_permanent',
			diagnostic: {
				version: 1,
				evidenceIssueCount: 3,
				unknownCount: 99,
				extra: 'PRIVATE_REPORT_TEXT_MUST_NOT_LEAK'
			}
		}
	), true)

	const successContent = Buffer.from('%PDF-1.7\nSUPPORT_ROUTE_SUCCESS\n%%EOF')
	const successIdentity = buildAnalysisIdentity({
		content: successContent,
		scope: `user:${owner.id}`,
		inputKind: 'credit-report-pdf'
	})
	const successJobId = `aj_${Buffer.alloc(18, 32).toString('base64url')}`
	const successDelivery = store.enqueueAnalysisJob({
		scopeHmac: successIdentity.scopeHmac,
		analysisKey: successIdentity.analysisKey,
		jobId: successJobId,
		documentId: successIdentity.documentId,
		inputKind: 'credit-report-pdf',
		inputPath: path.join(root, `${successJobId}.bin`),
		inputSize: successContent.length,
		scopeCiphertext: 'support-route-success-scope'
	})
	store.claimAnalysisJob(
		successIdentity.scopeHmac,
		successIdentity.analysisKey,
		'support-route-success-worker',
		120000
	)
	const successEvent = store.completeAnalysisJob({
		scopeHmac: successIdentity.scopeHmac,
		analysisKey: successIdentity.analysisKey,
		leaseOwner: 'support-route-success-worker',
		encryptedPayload: 'support-route-success-payload',
		resultHash: 'support-route-success-hash',
		versionsJson: '{}',
		expiresAt: '9999-12-31T23:59:59.999Z'
	})
	assert.equal(successEvent.diagnostic, null)
	assert.equal(analysisTaskService.getAnalysisTask(`user:${owner.id}`, successJobId).diagnostic, null)
	const successDatabase = new (require('better-sqlite3'))(store.DATA_FILE, { readonly: true })
	assert.equal(
		successDatabase.prepare(
			'SELECT diagnostic_json FROM analysis_terminal_events WHERE support_ref = ?'
		).get(successDelivery.job.support_ref).diagnostic_json,
		'null'
	)
	successDatabase.close()

	const server = app.listen(0, '127.0.0.1')
	t.after(async () => {
		await new Promise((resolve) => server.close(resolve))
	})
	await new Promise((resolve) => server.once('listening', resolve))
	const address = server.address()
	const baseUrl = `http://127.0.0.1:${address.port}`
	const ownerToken = tokenFor(owner)
	const otherToken = tokenFor(other)
	const monitorToken = tokenFor(monitor)

	const owned = await request(baseUrl, `/api/analysis/support/${supportRef}?userId=${other.id}`, {
		headers: { Authorization: `Bearer ${ownerToken}` }
	})
	assert.equal(owned.response.status, 200)
	assert.equal(owned.payload.code, 0)
	assert.deepEqual(Object.keys(owned.payload.data), [
		'schemaVersion', 'supportRef', 'status', 'code', 'errorClass', 'stage',
		'retryable', 'safeMessageKey', 'diagnostic', 'serverTime', 'release', 'versions'
	])
	assert.equal(owned.payload.data.supportRef, supportRef)
	assert.equal(owned.payload.data.traceId, undefined)
	assert.deepEqual(owned.payload.data.diagnostic, { version: 1, evidenceIssueCount: 3 })
	assert.doesNotMatch(JSON.stringify(owned.payload), /PRIVATE_REPORT|unknownCount|scope|jobId|analysisKey|documentId|resultHash/)

	const missingRef = `sr_${'z'.repeat(24)}`
	const foreign = await request(baseUrl, `/api/analysis/support/${supportRef}`, {
		headers: { Authorization: `Bearer ${otherToken}` }
	})
	const missing = await request(baseUrl, `/api/analysis/support/${missingRef}`, {
		headers: { Authorization: `Bearer ${otherToken}` }
	})
	const malformed = await request(baseUrl, '/api/analysis/support/not-a-ref', {
		headers: { Authorization: `Bearer ${otherToken}` }
	})
	for (const denied of [foreign, missing, malformed]) {
		assert.equal(denied.response.status, 404)
		assert.deepEqual(denied.payload, { code: 404, msg: '支持编号不存在' })
	}

	const userOps = await request(baseUrl, `/api/ops/analysis/support/${supportRef}`, {
		headers: { Authorization: `Bearer ${ownerToken}` }
	})
	assert.equal(userOps.response.status, 403)
	const ops = await request(baseUrl, `/api/ops/analysis/support/${supportRef}`, {
		headers: { Authorization: `Bearer ${monitorToken}` }
	})
	assert.equal(ops.response.status, 200)
	assert.match(ops.payload.data.traceId, /^tr_[A-Za-z0-9_-]{24}$/)
	assert.equal(ops.payload.data.supportRef, supportRef)

	const ownerSuccess = await request(
		baseUrl,
		`/api/analysis/support/${successDelivery.job.support_ref}`,
		{ headers: { Authorization: `Bearer ${ownerToken}` } }
	)
	assert.equal(ownerSuccess.response.status, 200)
	assert.equal(ownerSuccess.payload.data.status, 'succeeded')
	assert.equal(ownerSuccess.payload.data.diagnostic, null)
	assert.deepEqual(Object.keys(ownerSuccess.payload.data), [
		'schemaVersion', 'supportRef', 'status', 'code', 'errorClass', 'stage',
		'retryable', 'safeMessageKey', 'diagnostic', 'serverTime', 'release', 'versions'
	])
	const opsSuccess = await request(
		baseUrl,
		`/api/ops/analysis/support/${successDelivery.job.support_ref}`,
		{ headers: { Authorization: `Bearer ${monitorToken}` } }
	)
	assert.equal(opsSuccess.response.status, 200)
	assert.equal(opsSuccess.payload.data.diagnostic, null)
	assert.deepEqual(Object.keys(opsSuccess.payload.data), [
		'schemaVersion', 'supportRef', 'traceId', 'status', 'code', 'errorClass',
		'stage', 'retryable', 'safeMessageKey', 'diagnostic', 'release', 'versions',
		'serverTime'
	])
	assert.doesNotMatch(JSON.stringify([ownerSuccess.payload, opsSuccess.payload]), /extra|details|meta|jobId|analysisKey|documentId|resultHash/)

	const cacheContent = Buffer.from('%PDF-1.7\nCACHE_RESULT_ROUTE_FAILURE\n%%EOF')
	const cacheIdentity = buildAnalysisIdentity({
		content: cacheContent,
		scope: `user:${owner.id}`,
		inputKind: 'credit-report-pdf'
	})
	const cacheJobId = `aj_${Buffer.alloc(18, 34).toString('base64url')}`
	const cacheDelivery = store.enqueueAnalysisJob({
		scopeHmac: cacheIdentity.scopeHmac,
		analysisKey: cacheIdentity.analysisKey,
		jobId: cacheJobId,
		documentId: cacheIdentity.documentId,
		inputKind: 'credit-report-pdf',
		inputPath: path.join(root, `${cacheJobId}.bin`),
		inputSize: cacheContent.length,
		scopeCiphertext: 'cache-result-route-scope'
	})
	const cacheClaim = store.claimAnalysisJob(
		cacheIdentity.scopeHmac,
		cacheIdentity.analysisKey,
		'cache-result-route-worker',
		120000
	)
	store.completeAnalysisJob({
		scopeHmac: cacheIdentity.scopeHmac,
		analysisKey: cacheIdentity.analysisKey,
		leaseOwner: 'cache-result-route-worker',
		encryptedPayload: 'tampered-cache-payload',
		resultHash: 'tampered-cache-hash',
		versionsJson: '{}',
		expiresAt: '9999-12-31T23:59:59.999Z'
	})
	const successTime = analysisTaskService.getAnalysisTask(`user:${owner.id}`, cacheJobId).serverTime
	const originalGetResult = analysisTaskService.getAnalysisTaskResult
	analysisTaskService.getAnalysisTaskResult = () => {
		store.invalidateAnalysisResult(
			cacheIdentity.scopeHmac,
			cacheIdentity.analysisKey,
			'CACHE_INTEGRITY_FAILED'
		)
		const error = new Error('cache result invalid')
		error.code = 'ANALYSIS_RESULT_UNAVAILABLE'
		throw error
	}
	try {
		await new Promise((resolve) => setTimeout(resolve, 2))
		const resultFailure = await request(baseUrl, `/api/analysis/jobs/${cacheJobId}/result`, {
			headers: { Authorization: `Bearer ${ownerToken}` }
		})
		assert.equal(resultFailure.response.status, 200)
		assert.equal(resultFailure.payload.code, 0)
		assert.equal(resultFailure.payload.data.result, null)
		assert.equal(resultFailure.payload.data.job.status, 'failed')
		assert.equal(resultFailure.payload.data.job.errorCode, 'CACHE_INTEGRITY_FAILED')
		assert.equal(resultFailure.payload.data.job.supportRef, cacheDelivery.job.support_ref)
		assert.notEqual(resultFailure.payload.data.job.serverTime, successTime)
		assert.equal(resultFailure.payload.data.job.serverTime, store.getTrustedAnalysisEventBySupportRef(cacheClaim.supportRef).serverTime)
		const ack = await request(baseUrl, `/api/analysis/jobs/${cacheJobId}/ack`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${ownerToken}`,
				'Content-Type': 'application/json'
			},
			body: '{}'
		})
		assert.equal(ack.payload.data.supportRef, cacheDelivery.job.support_ref)
		assert.equal(ack.payload.data.serverTime, resultFailure.payload.data.job.serverTime)
	} finally {
		analysisTaskService.getAnalysisTaskResult = originalGetResult
	}

	const beforeEvents = new (require('better-sqlite3'))(store.DATA_FILE, { readonly: true })
	const beforeCount = beforeEvents.prepare('SELECT COUNT(*) AS total FROM analysis_terminal_events').get().total
	beforeEvents.close()
	const forged = await request(baseUrl, '/api/log/error', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			kind: 'forged-trusted-event',
			message: 'client supplied data is untrusted',
			supportRef: missingRef,
			traceId: `tr_${'y'.repeat(24)}`,
			release: { id: 'PRIVATE_RELEASE_SENTINEL' },
			diagnostic: { extra: 'PRIVATE_REPORT_TEXT_MUST_NOT_LEAK' }
		})
	})
	assert.deepEqual(forged.payload, { code: 0 })
	assert.equal(JSON.stringify(forged.payload).includes(missingRef), false)
	const afterEvents = new (require('better-sqlite3'))(store.DATA_FILE, { readonly: true })
	assert.equal(afterEvents.prepare('SELECT COUNT(*) AS total FROM analysis_terminal_events').get().total, beforeCount)
	afterEvents.close()
	const stillMissing = await request(baseUrl, `/api/analysis/support/${missingRef}`, {
		headers: { Authorization: `Bearer ${ownerToken}` }
	})
	assert.equal(stillMissing.response.status, 404)
})
