import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let source = readFileSync(join(__dirname, '..', 'src', 'services', 'apiClient.js'), 'utf8')
source = source.replace(/^import[\s\S]*?from\s+['"][^'"]+['"]\s*\r?\n/gm, '')

const stubs = `
const PROXY_BASE = ''
const DEV_ANALYZE_BEARER_TOKEN = ''
const getProxyBaseMisconfigReason = () => ''
const buildProxyApiUrl = (path) => path
const reportError = () => {}
const resolveAuthToken = () => ''
const captureLocalSessionState = () => ({ token: '', revision: 0 })
const isLocalSessionStateCurrent = () => true
const clearLocalSessionState = () => true
`

const moduleUrl = `data:text/javascript;base64,${Buffer.from(stubs + source).toString('base64')}`
const { request } = await import(moduleUrl)

const startRequest = (options = {}) => {
	const requests = []
	globalThis.uni = { request: (requestOptions) => requests.push(requestOptions) }
	const outcome = request({ url: '/api/report/upload', ...options }).then(
		(value) => ({ value }),
		(error) => ({ error })
	)
	return { requests, outcome }
}

describe('generic API request transport metadata', () => {
	it('marks a real HTTP error with the raw HTTP status', async () => {
		const { requests, outcome } = startRequest()
		requests[0].success({ statusCode: 413, data: { code: 5000, message: '请求体超过限制' } })
		const { error } = await outcome

		assert.equal(error.transportKind, 'http')
		assert.equal(error.httpStatus, 413)
		assert.equal(error.statusCode, 413)
		assert.equal(error.code, 5000)
		assert.equal(error.businessCode, 5000)
	})

	it('preserves a safe backend code without exposing the response payload as metadata', async () => {
		const { requests, outcome } = startRequest()
		requests[0].success({
			statusCode: 500,
			data: { code: 5000, message: '报告保存失败', errCode: 'REPORT_PERSIST_FAILED', data: { private: 'not-metadata' } }
		})
		const { error } = await outcome

		assert.equal(error.businessCode, 5000)
		assert.equal(error.backendCode, 'REPORT_PERSIST_FAILED')
		assert.equal(error.private, undefined)
	})

	for (const entry of [
		{ name: 'timeout', transport: { errMsg: 'request:fail timeout' }, code: 'REQUEST_TIMEOUT', kind: 'timeout', flag: 'timedOut' },
		{ name: 'abort', transport: { errMsg: 'request:fail abort' }, code: 'REQUEST_ABORTED', kind: 'abort', flag: 'aborted' },
		{ name: 'network', transport: { errMsg: 'request:fail' }, code: 'REQUEST_NETWORK_ERROR', kind: 'network', flag: 'networkFailure' }
	]) {
		it(`normalizes ${entry.name} failures without guessing an HTTP status`, async () => {
			const { requests, outcome } = startRequest()
			requests[0].fail(entry.transport)
			const { error } = await outcome

			assert.equal(error.code, entry.code)
			assert.equal(error.transportKind, entry.kind)
			assert.equal(error[entry.flag], true)
			assert.equal(error.httpStatus, undefined)
		})
	}
})
