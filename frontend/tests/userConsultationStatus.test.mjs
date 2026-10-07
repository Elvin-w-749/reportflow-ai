import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CONSULTATION_MATERIAL_SYNC_QUEUE_KEY, CONSULTATION_STATUS_KEY, CONSULTATION_STATUS_MAX_AGE, buildAdvisorMaterialSubmitPayload, buildConsultationProgress, consultationStatusToContactRecord, consultationStatusToMessage, markLastConsultationMaterialReviewed, markLastConsultationMaterialUploaded, normalizeConsultationStatus, readConsultationMaterialSyncQueue, retryPendingConsultationMaterialSync, saveLastConsultationStatus, syncConsultationMaterialSubmit } from '../src/services/userConsultationStatus.js'
import { normalizeMatchMessageContext } from '../src/services/reportMatchContext.js'

describe('user consultation status', () => {
  it('normalizes recent match consultation status for user-side readback', () => {
    const now = Date.parse('2026-07-02T08:00:00.000Z')
    const status = normalizeConsultationStatus({
      id: 'c1',
      productName: '优选方案',
      institution: '示例银行',
      matchRate: '86%',
      reportId: 'r1',
      reportTitle: '信用报告',
      reportScore: '712',
      savedAt: now
    }, now)

    assert.equal(status.productName, '优选方案')
    assert.equal(status.matchRate, 86)
    assert.equal(status.reportScore, 712)
    assert.equal(status.statusText, '待顾问处理')
    assert.deepEqual(normalizeConsultationStatus({ requiredMaterials: '收入流水、负债明细', savedAt: now }, now).materials.map((item) => item.name), ['收入流水', '负债明细'])
  })

  it('drops expired local consultation status', () => {
    const now = Date.parse('2026-07-10T08:00:00.000Z')
    const expired = normalizeConsultationStatus({ savedAt: now - CONSULTATION_STATUS_MAX_AGE - 1 }, now)
    assert.equal(expired, null)
  })

  it('converts local status to advisor contact record shape', () => {
    const record = consultationStatusToContactRecord({
      id: 'c2',
      productName: '稳妥方案',
      matchRate: 78,
      reportId: 'r2',
      reportTitle: '信用报告',
      reportScore: 690,
      createdAt: '2026-07-02T08:00:00.000Z',
      requiredMaterials: [{ name: '收入流水', status: 'pending' }],
      savedAt: Date.parse('2026-07-02T08:00:00.000Z')
    })

    assert.equal(record.contactType, 'match-product')
    assert.equal(record.reportId, 'r2')
    assert.equal(record.context.product.name, '稳妥方案')
    assert.equal(record.context.match.matchRate, 78)
    assert.equal(record.materials[0].name, '收入流水')
    assert.equal(record.context.requiredMaterials[0].statusText, '待补充')
  })
  it('keeps source message context through match consultation status', () => {
    const messageContext = normalizeMatchMessageContext({
      sourceMessageId: 'msg-report-1',
      sourceTitle: '信用报告已更新',
      sourceCategory: 'system',
      sourceFocus: 'match',
      reportId: 'r1',
      actionUrl: '/pages/report/detail?id=r1'
    })
    const status = normalizeConsultationStatus({
      id: 'contact-msg',
      productName: '消息延续方案',
      reportId: 'r1',
      reportTitle: '信用报告',
      messageContext,
      savedAt: Date.parse('2026-07-02T08:00:00.000Z')
    }, Date.parse('2026-07-02T08:00:00.000Z'))
    const record = consultationStatusToContactRecord(status)

    assert.equal(messageContext.messageId, 'msg-report-1')
    assert.equal(status.messageId, 'msg-report-1')
    assert.equal(status.sourceMessageTitle, '信用报告已更新')
    assert.equal(record.context.sourceMessage.id, 'msg-report-1')
    assert.equal(record.context.sourceMessage.focus, 'match')
  })
  it('builds consultation progress timeline and material alerts', () => {
    const progress = buildConsultationProgress({
      id: 'c3',
      productName: '重传方案',
      reportTitle: '信用报告',
      status: 'need_info',
      statusText: '材料需重传',
      requiredMaterials: [
        { id: 'income', name: '收入流水', status: 'rejected', reviewNote: '文件不清晰', reviewedAt: '2026-07-02T09:00:00.000Z' },
        { id: 'debt', name: '负债明细', status: 'confirmed', reviewedAt: '2026-07-02T09:10:00.000Z' }
      ],
      createdAt: '2026-07-02T08:00:00.000Z',
      savedAt: Date.parse('2026-07-02T09:20:00.000Z')
    })

    assert.equal(progress.alert.level, 'danger')
    assert.equal(progress.materialStats.reupload, 1)
    assert.equal(progress.timeline.some((item) => item.key === 'material-reupload'), true)
    assert.equal(progress.timeline.at(-1).title, '等待补齐后处理')
  })
  it('converts consultation progress into a local message', () => {
    const message = consultationStatusToMessage({
      id: 'c4',
      productName: '材料方案',
      reportTitle: '信用报告',
      requiredMaterials: [{ id: 'income', name: '收入流水', status: 'rejected', reviewedAt: '2026-07-02T10:00:00.000Z' }],
      createdAt: '2026-07-02T08:00:00.000Z',
      savedAt: Date.parse('2026-07-02T10:00:00.000Z')
    })

    assert.equal(message.category, 'consultation')
    assert.equal(message.level, 'danger')
    assert.equal(message.title, '有材料需要重传')
    assert.match(message.actionUrl, /^\/pages\/profile\/advisor\?/)
    assert.match(message.actionUrl, /from=message/)
    assert.match(message.actionUrl, /focus=materials/)
    assert.match(message.actionUrl, /messageId=/)
    assert.match(message.content, /材料方案/)
  })
  it('marks local consultation material as uploaded for advisor review', () => {
    const store = new Map()
    global.uni = {
      getStorageSync: (key) => store.get(key) || '',
      setStorageSync: (key, value) => store.set(key, value),
      removeStorageSync: (key) => store.delete(key)
    }

    saveLastConsultationStatus({
      reportId: 'r3',
      productName: '补材料方案',
      requiredMaterials: [{ id: 'income', name: '收入流水', status: 'pending' }],
      createdAt: '2026-07-02T08:00:00.000Z'
    }, {})

    const updated = markLastConsultationMaterialUploaded({ id: 'income' }, { url: 'https://example.test/income.pdf', name: 'income.pdf', size: 2048 })
    const raw = JSON.parse(store.get(CONSULTATION_STATUS_KEY))

    assert.equal(updated.materials[0].statusText, '待确认')
    assert.equal(updated.materials[0].uploadUrl, 'https://example.test/income.pdf')
    assert.equal(raw.materials[0].fileName, 'income.pdf')
    assert.equal(raw.statusText, '材料待确认')

    const reviewed = markLastConsultationMaterialReviewed({ id: 'income' }, { status: 'rejected', reviewNote: '请上传近6个月流水' })
    const reviewedRaw = JSON.parse(store.get(CONSULTATION_STATUS_KEY))

    assert.equal(reviewed.materials[0].statusText, '需重传')
    assert.equal(reviewed.materials[0].reviewNote, '请上传近6个月流水')
    assert.equal(reviewedRaw.statusText, '材料需重传')

    delete global.uni
  })
  it('builds and queues advisor material submit payloads for server writeback', async () => {
    const store = new Map()
    const api = {
      getStorageSync: (key) => store.get(key) || '',
      setStorageSync: (key, value) => store.set(key, value)
    }
    const payload = buildAdvisorMaterialSubmitPayload(
      { statusId: 'contact-1', reportId: 'r3', reportTitle: '信用报告', reportScore: 701, productName: '补材料方案', matchRate: 82 },
      { id: 'income', name: '收入流水' },
      { url: 'https://example.test/income.pdf', name: 'income.pdf', size: 2048, uploadedAt: '2026-07-02T10:02:00.000Z' },
      { messageId: 'msg-1' }
    )
    const failed = await syncConsultationMaterialSubmit(payload, async () => { throw new Error('offline') }, api)
    const queued = readConsultationMaterialSyncQueue(api)
    const storedWhileQueued = JSON.parse(store.get(CONSULTATION_MATERIAL_SYNC_QUEUE_KEY))
    let sent = null
    const synced = await retryPendingConsultationMaterialSync(async (contactId, data) => { sent = { contactId, data } }, api)

    assert.equal(payload.contactId, 'contact-1')
    assert.equal(payload.materialName, '收入流水')
    assert.equal(payload.statusText, '待确认')
    assert.equal(failed.queued, true)
    assert.equal(queued.length, 1)
    assert.equal(queued[0].retryCount, 1)
    assert.equal(storedWhileQueued.length, 1)
    assert.equal(synced.success, 1)
    assert.equal(sent.contactId, 'contact-1')
    assert.equal(sent.data.uploadUrl, 'https://example.test/income.pdf')
    assert.equal(readConsultationMaterialSyncQueue(api).length, 0)
  })
})
