import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let source = readFileSync(join(__dirname, '..', 'src', 'services', 'apiClient.js'), 'utf8')
source = source.replace(/^import[\s\S]*?from\s+['"][^'"]+['"]\s*\r?\n/gm, '')

const stubs = `
const PROXY_BASE = 'https://reportflow.test/legacy-api'
const DEV_ANALYZE_BEARER_TOKEN = ''
const getProxyBaseMisconfigReason = () => ''
const buildProxyApiUrl = (path) => PROXY_BASE + path
const reportError = () => {}
const resolveAuthToken = () => String(globalThis.__analyzeStorage.get('auth_token') || '')
const captureLocalSessionState = () => ({
  token: resolveAuthToken(),
  revision: Number(globalThis.__analyzeRevision || 0)
})
const isLocalSessionStateCurrent = (snapshot = {}) => {
  const current = captureLocalSessionState()
  return String(snapshot.token || '') === current.token && Number(snapshot.revision) === current.revision
}
const clearLocalSessionState = () => {
  globalThis.__analyzeRevision = Number(globalThis.__analyzeRevision || 0) + 1
  globalThis.__analyzeStorage.clear()
}
`

const moduleUrl = `data:text/javascript;base64,${Buffer.from(stubs + source).toString('base64')}`
const apiClient = await import(moduleUrl)

const installHarness = () => {
  const storage = new Map([['auth_token', 'token-a']])
  const uploads = []
  globalThis.__analyzeStorage = storage
  globalThis.__analyzeRevision = Number(globalThis.__analyzeRevision || 0) + 1
  globalThis.uni = {
    getStorageSync: (key) => storage.get(key) || '',
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
    request: () => {},
    uploadFile: (options) => uploads.push(options)
  }
  return { uploads }
}

const uploadCases = [
  {
    name: 'PDF',
    start: () => apiClient.uploadCreditAnalyze('/tmp/report.pdf')
  },
  {
    name: 'image',
    start: () => apiClient.uploadCreditAnalyzeImages(['/tmp/report.jpg'])
  }
]

describe('analyze upload response contract', () => {
  for (const entry of uploadCases) {
    it(`preserves only whitelisted ${entry.name} analysis execution metadata`, async () => {
      const harness = installHarness()
      const outcome = entry.start()
      assert.equal(harness.uploads.length, 1)
      harness.uploads[0].success({
        statusCode: 200,
        data: JSON.stringify({
          code: 0,
          data: { report: { totalScore: 80 } },
          analysis: {
            cacheHit: true,
            cacheSource: 'sqlite',
            analysisKey: 'ak_v3_abc123',
            resultHash: 'rh_v1_def456',
            versions: { prompt: 'internal-version' },
            internalDiagnostic: 'must-not-leak'
          }
        })
      })

      const value = await outcome
      assert.deepEqual(value.analysisExecution, {
        cacheHit: true,
        cacheSource: 'sqlite',
        analysisKey: 'ak_v3_abc123',
        resultHash: 'rh_v1_def456'
      })
      assert.equal(value.analysisExecution.versions, undefined)
      assert.equal(value.analysisExecution.internalDiagnostic, undefined)
    })

    it(`keeps ${entry.name} backend errCode and promotes a business failure status`, async () => {
      const harness = installHarness()
      const outcome = entry.start().then(
        (value) => ({ value }),
        (error) => ({ error })
      )
      harness.uploads[0].success({
        statusCode: 200,
        data: JSON.stringify({
          code: 500,
          msg: 'PDF 识别失败，请重新上传清晰文件',
          errCode: 'RAPIDOCR_PROCESS_ERROR'
        })
      })

      const result = await outcome
      assert.equal(result.error.code, 'RAPIDOCR_PROCESS_ERROR')
      assert.equal(result.error.backendCode, 'RAPIDOCR_PROCESS_ERROR')
      assert.equal(result.error.statusCode, 500)
      assert.equal(result.error.data.payload.errCode, 'RAPIDOCR_PROCESS_ERROR')
    })
  }

  it('preserves generated provenance without reporting a cache hit', async () => {
    const harness = installHarness()
    const outcome = apiClient.uploadCreditAnalyze('/tmp/new-report.pdf')
    harness.uploads[0].success({
      statusCode: 200,
      data: JSON.stringify({
        code: 0,
        data: { report: { totalScore: 88 } },
        analysis: {
          cacheHit: false,
          cacheSource: 'generated',
          analysisKey: 'ak_v3_new',
          resultHash: 'rh_v1_new'
        }
      })
    })

    const value = await outcome
    assert.equal(value.analysisExecution.cacheHit, false)
    assert.equal(value.analysisExecution.cacheSource, 'generated')
  })
})
