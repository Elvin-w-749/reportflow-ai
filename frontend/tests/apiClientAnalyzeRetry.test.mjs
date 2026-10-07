import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let source = readFileSync(join(__dirname, '..', 'src', 'services', 'apiClient.js'), 'utf8')
source = source.replace(/^import[\s\S]*?from\s+['"][^'"]+['"]\s*\r?\n/gm, '')

const stubs = `
const PROXY_BASE = 'http://127.0.0.1:3200'
const DEV_ANALYZE_BEARER_TOKEN = ''
const getProxyBaseMisconfigReason = () => ''
const buildProxyApiUrl = (path) => path
const reportError = () => {}
const resolveAuthToken = () => 'token-a'
const captureLocalSessionState = () => ({ token: 'token-a', revision: 1 })
const isLocalSessionStateCurrent = () => true
const clearLocalSessionState = () => {}
`

const moduleUrl = `data:text/javascript;base64,${Buffer.from(stubs + source).toString('base64')}`
const apiClient = await import(moduleUrl)

const installHarness = () => {
  const uploads = []
  globalThis.uni = {
    getStorageSync: () => '',
    setStorageSync: () => {},
    removeStorageSync: () => {},
    getStorageInfoSync: () => ({ keys: [] }),
    request: () => {},
    uploadFile: (options) => uploads.push(options)
  }
  return { uploads }
}

describe('PDF analyze retry safety', () => {
  it('does not POST the same PDF to the alternate URL after an XHR timeout', async () => {
    const harness = installHarness()
    const outcome = apiClient.uploadCreditAnalyze('/tmp/long-report.pdf', { maxAttempts: 3 }).then(
      (value) => ({ value }),
      (error) => ({ error })
    )

    assert.equal(harness.uploads.length, 1)
    assert.equal(harness.uploads[0].url, '/api/analyze')
    assert.equal(harness.uploads[0].timeout, 900000)
    harness.uploads[0].fail({ errMsg: 'uploadFile:fail timeout' })

    const result = await outcome
    assert.match(result.error.message, /上传分析超时/)
    assert.equal(harness.uploads.length, 1)
  })

  it('does not POST the same PDF to the alternate URL after an HTTP 504 timeout', async () => {
    const harness = installHarness()
    const outcome = apiClient.uploadCreditAnalyze('/tmp/long-report.pdf').then(
      (value) => ({ value }),
      (error) => ({ error })
    )

    assert.equal(harness.uploads.length, 1)
    harness.uploads[0].success({
      statusCode: 504,
      data: '<html><body>504 Gateway Timeout</body></html>'
    })

    const result = await outcome
    assert.equal(result.error.statusCode, 504)
    assert.equal(harness.uploads.length, 1)
  })

  it('does not POST again when the browser transport reports ETIMEDOUT', async () => {
    const harness = installHarness()
    const outcome = apiClient.uploadCreditAnalyze('/tmp/long-report.pdf', { maxAttempts: 3 }).then(
      (value) => ({ value }),
      (error) => ({ error })
    )

    assert.equal(harness.uploads.length, 1)
    harness.uploads[0].fail({ errMsg: 'uploadFile:fail ETIMEDOUT', code: 'ETIMEDOUT' })

    const result = await outcome
    assert.match(result.error.message, /上传分析超时/)
    assert.equal(harness.uploads.length, 1)
  })

  it('does not retry a gateway-specific HTTP 524 timeout', async () => {
    const harness = installHarness()
    const outcome = apiClient.uploadCreditAnalyze('/tmp/long-report.pdf', { maxAttempts: 3 }).then(
      (value) => ({ value }),
      (error) => ({ error })
    )

    assert.equal(harness.uploads.length, 1)
    harness.uploads[0].success({
      statusCode: 524,
      data: '<html><body>524 A Timeout Occurred</body></html>'
    })

    const result = await outcome
    assert.equal(result.error.statusCode, 524)
    assert.equal(harness.uploads.length, 1)
  })

	 it('keeps a large-file browser connection failure as network rather than upload limit', async () => {
		 const harness = installHarness()
		 const outcome = apiClient.uploadCreditAnalyze('/tmp/long-report.pdf', {
			 fileSize: Math.round(9.2 * 1024 * 1024)
		 }).then(
			 (value) => ({ value }),
			 (error) => ({ error })
		 )

		 harness.uploads[0].fail({ errMsg: 'uploadFile:fail network', code: 'UPLOAD_NETWORK_ERROR' })
		 await Promise.resolve()
		 assert.equal(harness.uploads.length, 2)
		 harness.uploads[1].fail({ errMsg: 'uploadFile:fail network', code: 'UPLOAD_NETWORK_ERROR' })
		 const result = await outcome
		 assert.equal(result.error.code, 'UPLOAD_NETWORK_ERROR')
		 assert.match(result.error.message, /9\.2MB|连接中断/)
		 assert.doesNotMatch(result.error.message, /上传上限|client_max_body_size/)
	 })

	 it('preserves the raw HTTP status separately from a business code', async () => {
		 const harness = installHarness()
		 const outcome = apiClient.uploadCreditAnalyze('/tmp/report.pdf').then(
			 (value) => ({ value }),
			 (error) => ({ error })
		 )
		 harness.uploads[0].success({
			 statusCode: 200,
			 data: JSON.stringify({ code: 413, message: '业务校验失败' })
		 })
		 const result = await outcome
		 assert.equal(result.error.statusCode, 413)
		 assert.equal(result.error.httpStatus, 200)
		 assert.equal(result.error.transportKind, 'http')
	 })
})
