'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const {
	validReleaseBaseId,
	resolveApiReleaseIdentity
} = require('../backend/utils/releaseIdentity')

test('release base validation accepts operational labels and rejects PII/credential shapes', () => {
	for (const value of [
		'phase2',
		'20260818-010203-evidence-v7',
		'release_candidate.2'
	]) assert.equal(validReleaseBaseId(value), true, value)
	for (const value of [
		'../phase2',
		'phase2..candidate',
		'20260818-010203-private-customer',
		'phase2-13800138000',
		'phase2-6222021234567890',
		'phase2-secret-token'
	]) assert.equal(validReleaseBaseId(value), false, value)
})

test('API release identity binds the generated short SHA to the full commit', () => {
	const commit = 'abcdef1234567890abcdef1234567890abcdef12'
	assert.deepEqual(
		resolveApiReleaseIdentity('phase2-abcdef1-api', commit),
		{ id: 'phase2-abcdef1-api', gitCommit: commit }
	)
	assert.deepEqual(
		resolveApiReleaseIdentity('phase2-0000000-api', commit),
		{ id: null, gitCommit: null }
	)
	assert.deepEqual(
		resolveApiReleaseIdentity('phase2-abcdef1-web', commit),
		{ id: null, gitCommit: null }
	)
	assert.deepEqual(
		resolveApiReleaseIdentity('private-customer-abcdef1-api', commit),
		{ id: null, gitCommit: null }
	)
})

test('production startup rejects any trusted terminal version drift', (t) => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-release-version-gate-'))
	t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
	const serverPath = path.resolve(__dirname, '../server.js')
	const commit = 'a'.repeat(40)
	const child = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(serverPath)})`], {
		encoding: 'utf8',
		env: {
			...process.env,
			NODE_ENV: 'production',
			DATA_DIR: dataDir,
			ALLOW_EMPTY_STORE_BOOTSTRAP: 'true',
			RPT_RELEASE_ID: 'phase2-aaaaaaa-api',
			RPT_GIT_COMMIT: commit,
			DEEPSEEK_TEXT_MODEL: 'deepseek-PRIVATE_CUSTOMER_13800138000',
			DEV_ANALYZE_BEARER: 'release-version-gate-static-bearer',
			ANALYSIS_STATIC_TENANT_ID: 'release-version-gate',
			ANALYSIS_CACHE_SECRET: 'release-version-gate-cache-secret-at-least-32-bytes',
			JWT_SECRET: 'release-version-gate-jwt-secret-at-least-32-bytes',
			SMS_PROVIDER: 'custom'
		}
	})
	assert.notEqual(child.status, 0)
	assert.match(child.stderr, /trusted terminal release\/version identity is invalid/)
	assert.doesNotMatch(child.stderr, /PRIVATE_CUSTOMER|13800138000/)
})
