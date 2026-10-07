import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const sourcePath = new URL('../src/services/supplementMaterialService.js', import.meta.url)
let source = fs.readFileSync(sourcePath, 'utf8')
source = source.replace(/^import\s+.*\r?\n/gm, '')

const stubs = `
const enrichAnalysisWithFinancialProfile = (value) => value
const request = async (args) => { globalThis.__supplementLastRequest = args; return args }
const getUserId = () => globalThis.__supplementUid || ''
const getLatestReport = () => globalThis.__supplementLatestReport || null
`
const moduleUrl = `data:text/javascript;base64,${Buffer.from(stubs + source).toString('base64')}`
const {
  SUPPLEMENT_MATERIAL_KEY,
  getSupplementMaterialsRemote,
  materialStorageKey,
  mergeSupplementMaterialCloudSnapshot,
  normalizeSupplementMaterial,
  readSupplementMaterials,
  restoreSupplementMaterialsFromCloud,
  sanitizeSupplementMaterialRemotePayload,
  saveSupplementMaterialRemote,
  saveSupplementMaterials,
  syncSupplementMaterial
} = await import(moduleUrl)

const storage = new Map()
globalThis.uni = {
  getStorageSync: (key) => storage.get(key),
  setStorageSync: (key, value) => storage.set(key, value),
  removeStorageSync: (key) => storage.delete(key)
}

describe('supplement material case isolation', () => {
  beforeEach(() => {
    storage.clear()
    globalThis.__supplementUid = 'user-1'
    globalThis.__supplementLatestReport = null
    globalThis.__supplementLastRequest = null
  })

  it('uses the latest canonical cloud report as active case automatically', () => {
    globalThis.__supplementLatestReport = {
      id: 'local-report-1',
      syncMeta: { cloudReportId: 'cloud-report-1' }
    }

    assert.equal(
      materialStorageKey(),
      `${SUPPLEMENT_MATERIAL_KEY}:user-1:case:cloud-report-1`
    )
    const material = normalizeSupplementMaterial({ type: 'payroll', status: 'uploaded' })
    assert.equal(material.caseId, 'cloud-report-1')
    assert.equal(material.reportId, 'cloud-report-1')
  })

  it('does not bring legacy materials into a new case', () => {
    storage.set(`${SUPPLEMENT_MATERIAL_KEY}:user-1`, [{ id: 'old', type: 'tax', status: 'uploaded' }])
    globalThis.__supplementLatestReport = { id: 'new-report' }

    assert.deepEqual(readSupplementMaterials(), [])
    saveSupplementMaterials([{ id: 'new', type: 'payroll', status: 'uploaded' }])

    const newRows = storage.get(`${SUPPLEMENT_MATERIAL_KEY}:user-1:case:new-report`)
    assert.equal(newRows.length, 1)
    assert.equal(newRows[0].caseId, 'new-report')
    assert.equal(storage.get(`${SUPPLEMENT_MATERIAL_KEY}:user-1`)[0].id, 'old')
  })

  it('migrates the same report local case when its cloud id arrives', () => {
    storage.set(`${SUPPLEMENT_MATERIAL_KEY}:user-1:case:local-report`, [
      { id: 'same-report', type: 'tax', status: 'uploaded', caseId: 'local-report', reportId: 'local-report' }
    ])
    globalThis.__supplementLatestReport = {
      id: 'local-report',
      cloudReportId: 'cloud-report'
    }

    const rows = readSupplementMaterials()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].caseId, 'cloud-report')
    assert.equal(storage.get(`${SUPPLEMENT_MATERIAL_KEY}:user-1:case:cloud-report`)[0].caseId, 'cloud-report')
  })

  it('keeps legacy calls compatible when there is no active report', () => {
    storage.set(`${SUPPLEMENT_MATERIAL_KEY}:user-1`, [{ id: 'legacy', type: 'tax', status: 'uploaded' }])
    assert.equal(readSupplementMaterials()[0].id, 'legacy')
  })

  it('sends caseId and reportId on remote case queries', async () => {
    await getSupplementMaterialsRemote({ caseId: 'case-9', reportId: 'report-9' })
    assert.deepEqual(globalThis.__supplementLastRequest.data, {
      caseId: 'case-9',
      reportId: 'report-9'
    })
  })

  it('keeps local file paths on-device and never marks them as cloud uploads', async () => {
    const localMaterial = {
      id: 'local-only-income',
      materialType: 'income',
      caseId: 'case-local-only',
      reportId: 'case-local-only',
      status: 'uploaded',
      localFilePath: 'wxfile://private/income.pdf',
      fileUrl: 'wxfile://private/income.pdf',
      attachments: [{
        id: 'local-only-attachment',
        fileName: 'income.pdf',
        localFilePath: 'wxfile://private/income.pdf',
        uploadUrl: 'blob:https://client.invalid/income'
      }]
    }

    const sanitized = sanitizeSupplementMaterialRemotePayload(localMaterial)
    assert.equal(sanitized.status, 'queued')
    assert.equal(sanitized.statusText, '本机已保存')
    assert.equal(Object.prototype.hasOwnProperty.call(sanitized, 'localFilePath'), false)
    assert.deepEqual(sanitized.attachments, [])
    assert.equal(JSON.stringify(sanitized).includes('wxfile://'), false)

    await saveSupplementMaterialRemote(localMaterial)
    assert.equal(globalThis.__supplementLastRequest.data.status, 'queued')
    assert.equal(JSON.stringify(globalThis.__supplementLastRequest.data).includes('wxfile://'), false)

    let remotePayload = null
    const result = await syncSupplementMaterial(localMaterial, async (payload) => {
      remotePayload = payload
      return { ok: true }
    })
    assert.equal(result.ok, true)
    assert.equal(result.material.localFilePath, 'wxfile://private/income.pdf')
    assert.equal(remotePayload.status, 'queued')
    assert.equal(JSON.stringify(remotePayload).includes('wxfile://'), false)
  })

  it('restores a canonical cloud snapshot after local storage was cleared', async () => {
    globalThis.__supplementLatestReport = {
      id: 'local-report-restore',
      cloudReportId: 'cloud-report-restore'
    }

    const restored = await restoreSupplementMaterialsFromCloud({}, async (scope) => {
      assert.equal(scope.caseId, 'cloud-report-restore')
      return {
        caseId: 'cloud-report-restore',
        reportId: 'cloud-report-restore',
        clientReportId: 'local-report-restore',
        list: [{
          id: 'income',
          materialType: 'income',
          name: '云端收入证明',
          caseId: 'cloud-report-restore',
          reportId: 'cloud-report-restore',
          status: 'uploaded',
          uploadUrl: 'https://files.invalid/cloud-income.pdf',
          updatedAt: '2026-07-28T08:00:00.000Z'
        }]
      }
    })

    assert.equal(restored.skipped, false)
    assert.equal(restored.materials.length, 1)
    assert.equal(restored.materials[0].name, '云端收入证明')
    assert.equal(restored.materials[0].caseId, 'cloud-report-restore')
    assert.equal(readSupplementMaterials()[0].uploadUrl, 'https://files.invalid/cloud-income.pdf')
  })

  it('keeps a newer local pending upload while restoring other cloud materials', async () => {
    const scope = { caseId: 'case-queued', reportId: 'case-queued' }
    saveSupplementMaterials([{
      id: 'income',
      materialType: 'income',
      name: '本机待同步收入证明',
      caseId: 'case-queued',
      reportId: 'case-queued',
      status: 'queued',
      localFilePath: 'local://income.pdf',
      updatedAt: '2026-07-28T09:00:00.000Z'
    }], scope)

    const restored = await restoreSupplementMaterialsFromCloud(scope, async () => ({
      caseId: 'case-queued',
      reportId: 'case-queued',
      list: [
        {
          id: 'income',
          materialType: 'income',
          name: '旧云端收入证明',
          caseId: 'case-queued',
          status: 'uploaded',
          uploadUrl: 'https://files.invalid/old-income.pdf',
          updatedAt: '2026-07-28T08:00:00.000Z'
        },
        {
          id: 'tax',
          materialType: 'tax',
          name: '云端纳税记录',
          caseId: 'case-queued',
          status: 'uploaded',
          uploadUrl: 'https://files.invalid/tax.pdf',
          updatedAt: '2026-07-28T08:30:00.000Z'
        }
      ]
    }))

    assert.equal(restored.materials.length, 2)
    const income = restored.materials.find((item) => item.type === 'income')
    assert.equal(income.name, '本机待同步收入证明')
    assert.equal(income.status, 'queued')
    assert.equal(income.localFilePath, 'local://income.pdf')
    assert.equal(income.uploadUrl, 'https://files.invalid/old-income.pdf')
  })

  it('accepts a server canonical case only when the response links it to the requested local case', async () => {
    const localScope = { caseId: 'local-case', reportId: 'local-case' }
    saveSupplementMaterials([{
      id: 'local-draft',
      materialType: 'tax',
      caseId: 'local-case',
      reportId: 'local-case',
      status: 'draft',
      note: '本地草稿'
    }], localScope)

    const restored = await restoreSupplementMaterialsFromCloud(localScope, async () => ({
      caseId: 'cloud-case',
      reportId: 'cloud-case',
      clientReportId: 'local-case',
      list: [{
        id: 'cloud-income',
        materialType: 'income',
        caseId: 'cloud-case',
        status: 'uploaded',
        uploadUrl: 'https://files.invalid/income.pdf'
      }]
    }))

    assert.equal(restored.canonicalScope.caseId, 'cloud-case')
    assert.equal(restored.materials.length, 2)
    assert.ok(restored.materials.every((item) => item.caseId === 'cloud-case'))
    assert.equal(storage.has(`${SUPPLEMENT_MATERIAL_KEY}:user-1:case:cloud-case`), true)
    assert.equal(storage.has(`${SUPPLEMENT_MATERIAL_KEY}:user-1:case:local-case`), false)

    await assert.rejects(
      () => restoreSupplementMaterialsFromCloud(
        { caseId: 'different-case', reportId: 'different-case' },
        async () => ({
          caseId: 'unrelated-cloud-case',
          reportId: 'unrelated-cloud-case',
          clientReportId: 'someone-else',
          list: [{ id: 'secret', materialType: 'income', caseId: 'unrelated-cloud-case' }]
        })
      ),
      (error) => error && error.code === 'SUPPLEMENT_CASE_MISMATCH'
    )
    assert.equal(storage.has(`${SUPPLEMENT_MATERIAL_KEY}:user-1:case:unrelated-cloud-case`), false)
  })

  it('never fetches all remote cases when there is no active case', async () => {
    let called = false
    const result = await restoreSupplementMaterialsFromCloud({}, async () => {
      called = true
      return { list: [{ id: 'other-case-secret', materialType: 'income', caseId: 'other-case' }] }
    })

    assert.equal(result.skipped, true)
    assert.equal(result.reason, 'missing-active-case')
    assert.equal(called, false)
    assert.deepEqual(result.materials, [])
  })

  it('merges only rows belonging to the selected canonical case', () => {
    const merged = mergeSupplementMaterialCloudSnapshot([], [
      { id: 'accepted', materialType: 'income', caseId: 'case-a', status: 'uploaded' },
      { id: 'rejected', materialType: 'tax', caseId: 'case-b', status: 'uploaded' }
    ], { caseId: 'case-a', reportId: 'case-a' })

    assert.deepEqual(merged.map((item) => item.id), ['accepted'])
    assert.ok(merged.every((item) => item.caseId === 'case-a'))
  })
})
