'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const gatewayPath = path.join(__dirname, '..', 'deploy', 'isolated-tls-gateway.cjs')
const source = fs.readFileSync(gatewayPath, 'utf8')

test('isolated TLS gateway keeps the long-report timeout and TLS floor explicit', () => {
	assert.match(source, /REQUEST_TIMEOUT_MS = Number\(process\.env\.REQUEST_TIMEOUT_MS \|\| 910000\)/)
	assert.match(source, /upstream\.setTimeout\(REQUEST_TIMEOUT_MS/)
	assert.match(source, /server\.requestTimeout = REQUEST_TIMEOUT_MS/)
	assert.match(source, /server\.headersTimeout = REQUEST_TIMEOUT_MS \+ 10000/)
	assert.match(source, /minVersion: 'TLSv1\.2'/)
})

test('isolated TLS gateway exposes only health, API, and upload paths', () => {
	assert.match(source, /pathname === '\/legacy-gateway-health'/)
	assert.match(source, /pathname === '\/health'/)
	assert.match(source, /pathname === '\/api'/)
	assert.match(source, /pathname\.startsWith\('\/api\/'\)/)
	assert.match(source, /pathname === '\/uploads'/)
	assert.match(source, /pathname\.startsWith\('\/uploads\/'\)/)
	assert.match(source, /return json\(res, 404/)
})
