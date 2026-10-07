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
const resolveAuthToken = () => String(globalThis.__apiClientStorage.get('auth_token') || '')
const captureLocalSessionState = () => ({
  token: resolveAuthToken(),
  revision: Number(globalThis.__apiClientRevision || 0)
})
const isLocalSessionStateCurrent = (snapshot = {}) => {
  const current = captureLocalSessionState()
  return String(snapshot.token || '') === current.token && Number(snapshot.revision) === current.revision
}
const clearLocalSessionState = () => {
  globalThis.__apiClientRevision = Number(globalThis.__apiClientRevision || 0) + 1
  globalThis.__apiClientStorage.clear()
}
`

const moduleUrl = `data:text/javascript;base64,${Buffer.from(stubs + source).toString('base64')}`
const apiClient = await import(moduleUrl)

const tick = () => new Promise((resolve) => setImmediate(resolve))

const installHarness = (token = 'token-a') => {
  const storage = new Map([['auth_token', token], ['uni_id_token', token], ['uni_id', 'uid-a']])
  const requests = []
  const uploads = []
  globalThis.__apiClientStorage = storage
  globalThis.__apiClientRevision = Number(globalThis.__apiClientRevision || 0) + 1
  globalThis.uni = {
    getStorageSync: (key) => storage.get(key) || '',
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
    request: (options) => requests.push(options),
    uploadFile: (options) => uploads.push(options)
  }
  const switchTo = (nextToken, uid = 'uid-b') => {
    globalThis.__apiClientRevision += 1
    storage.clear()
    storage.set('auth_token', nextToken)
    storage.set('uni_id_token', nextToken)
    storage.set('uni_id', uid)
  }
  return { storage, requests, uploads, switchTo }
}

describe('api client session isolation', () => {
  it('drops a successful old-account response after the user switches accounts', async () => {
    const harness = installHarness()
    const outcome = apiClient.request({ url: '/api/profile/debt-summary' }).then(
      (value) => ({ value }),
      (error) => ({ error })
    )

    assert.equal(harness.requests[0].header.Authorization, 'Bearer token-a')
    harness.switchTo('token-b')
    harness.requests[0].success({ statusCode: 200, data: { code: 0, data: { owner: 'A' } } })

    const result = await outcome
    assert.equal(result.error.code, 'STALE_SESSION_RESPONSE')
    assert.equal(result.error.staleSession, true)
    assert.equal(harness.storage.get('auth_token'), 'token-b')
  })

  it('keeps refresh single-flight scoped to each account generation', async () => {
    const harness = installHarness()
    const resultA = apiClient.request({ url: '/api/profile/debt-summary' }).then(
      (value) => ({ value }),
      (error) => ({ error })
    )
    harness.requests[0].success({ statusCode: 401, data: { code: 401, message: 'expired A' } })
    assert.equal(harness.requests[1].header.Authorization, 'Bearer token-a')

    harness.switchTo('token-b')
    const resultB = apiClient.request({ url: '/api/profile/debt-summary' }).then(
      (value) => ({ value }),
      (error) => ({ error })
    )
    harness.requests[2].success({ statusCode: 401, data: { code: 401, message: 'expired B' } })
    assert.equal(harness.requests[3].header.Authorization, 'Bearer token-b')

    harness.requests[1].success({ statusCode: 200, data: { code: 0, data: { token: 'token-a-new' } } })
    harness.requests[3].success({ statusCode: 200, data: { code: 0, data: { token: 'token-b-new' } } })
    await tick()
    await tick()

    assert.equal(harness.requests.length, 5)
    assert.equal(harness.requests[4].header.Authorization, 'Bearer token-b-new')
    harness.requests[4].success({ statusCode: 200, data: { code: 0, data: { owner: 'B' } } })

    const [settledA, settledB] = await Promise.all([resultA, resultB])
    assert.equal(settledA.error.staleSession, true)
    assert.deepEqual(settledB.value, { owner: 'B' })
    assert.equal(harness.storage.get('auth_token'), 'token-b-new')
  })

  it('drops old-account PDF, image and material upload successes after a switch', async () => {
    const cases = [
      {
        start: () => apiClient.uploadCreditAnalyze('/tmp/a.pdf'),
        response: { statusCode: 200, data: JSON.stringify({ code: 0, data: { report: 'A' } }) }
      },
      {
        start: () => apiClient.uploadCreditAnalyzeImages(['/tmp/a.jpg']),
        response: { statusCode: 200, data: JSON.stringify({ code: 0, data: { report: 'A' } }) }
      },
      {
        start: () => apiClient.uploadLocalFile({ filePath: '/tmp/a.jpg', folder: 'material' }),
        response: { statusCode: 200, data: JSON.stringify({ code: 0, data: { url: '/upload/a.jpg' } }) }
      }
    ]

    for (const entry of cases) {
      const harness = installHarness()
      const outcome = entry.start().then(
        (value) => ({ value }),
        (error) => ({ error })
      )
      assert.equal(harness.uploads.length, 1)
      assert.equal(harness.uploads[0].header.Authorization, 'Bearer token-a')
      harness.switchTo('token-b')
      harness.uploads[0].success(entry.response)

      const result = await outcome
      assert.equal(result.error.code, 'STALE_SESSION_RESPONSE')
      assert.equal(harness.storage.get('auth_token'), 'token-b')
      assert.equal(harness.uploads.length, 1)
    }
  })

  it('does not refresh or retry an old material upload with the new account token', async () => {
    const harness = installHarness()
    const outcome = apiClient.uploadLocalFile({ filePath: '/tmp/a.jpg', folder: 'material' }).then(
      (value) => ({ value }),
      (error) => ({ error })
    )
    harness.switchTo('token-b')
    harness.uploads[0].success({ statusCode: 401, data: JSON.stringify({ code: 401, message: 'expired A' }) })

    const result = await outcome
    assert.equal(result.error.staleSession, true)
    assert.equal(harness.requests.length, 0)
    assert.equal(harness.uploads.length, 1)
    assert.equal(harness.storage.get('auth_token'), 'token-b')
  })
})
