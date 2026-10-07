import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEBT_EXECUTION_RECORD_KEY,
  DEBT_EXECUTION_SYNC_QUEUE_KEY,
  acknowledgeDebtProofReview,
  activeDebtExecutionRecords,
  applyDebtExecutionCloudSnapshot,
  applyDebtProofReviews,
  collectDebtProofReviewsFromContactRecords,
  collectDebtProofReviewsFromMaterials,
  debtExecutionRecordsToMaterials,
  debtExecutionRecordToPayload,
  debtProofMaterialId,
  debtProofStatusText,
  mergeDebtExecutionRecords,
  readDebtExecutionSyncQueue,
  retryPendingDebtExecutionSync,
  syncDebtExecutionRecord,
  supersededDebtProofRecords,
  syncDebtProofReviewsFromContacts
} from '../src/services/debtExecution.js'

describe('debt execution helpers', () => {
  it('converts debt proof records to reviewable materials', () => {
    const records = [{
      id: 'proof-a',
      type: 'proof',
      debtId: 'card-a',
      reportId: 'r1',
      title: '工商银行 · 信用卡',
      status: 'reviewing',
      url: 'https://example.test/proof.png',
      fileName: 'proof.png',
      uploadedAt: '2026-07-02T10:00:00.000Z'
    }]

    const materials = debtExecutionRecordsToMaterials(records)

    assert.equal(materials.length, 1)
    assert.equal(materials[0].id, debtProofMaterialId(records[0]))
    assert.equal(materials[0].statusText, '待确认')
    assert.equal(materials[0].source, 'debt-proof')
    assert.equal(materials[0].uploadUrl, 'https://example.test/proof.png')
  })

  it('applies advisor proof reviews back to local execution records', () => {
    const records = [{
      id: 'proof-a',
      type: 'proof',
      debtId: 'card-a',
      title: '工商银行 · 信用卡',
      status: 'reviewing',
      fileName: 'proof.png',
      uploadedAt: '2026-07-02T10:00:00.000Z'
    }]
    const reviews = collectDebtProofReviewsFromMaterials([{
      id: debtProofMaterialId(records[0]),
      executionRecordId: 'proof-a',
      source: 'debt-proof',
      status: 'rejected',
      statusText: '需重传',
      reviewNote: '请重新上传清晰完整凭证',
      reviewedAt: '2026-07-02T11:00:00.000Z'
    }])

    const result = applyDebtProofReviews(records, reviews)

    assert.equal(result.changed, true)
    assert.equal(debtProofStatusText(result.records[0]), '需重传')
    assert.equal(result.records[0].reviewNote, '请重新上传清晰完整凭证')
    assert.equal(result.records[0].reviewedAt, '2026-07-02T11:00:00.000Z')
  })
  it('does not downgrade reviewed proof records from stale pending contact data', () => {
    const result = applyDebtProofReviews([{
      id: 'proof-a',
      type: 'proof',
      debtId: 'card-a',
      status: 'confirmed',
      statusText: '已确认',
      reviewedAt: '2026-07-02T12:00:00.000Z'
    }], collectDebtProofReviewsFromMaterials([{
      id: 'debt-proof-proof-a',
      executionRecordId: 'proof-a',
      source: 'debt-proof',
      status: 'uploaded',
      statusText: '待确认'
    }]))

    assert.equal(result.changed, false)
    assert.equal(result.records[0].statusText, '已确认')
  })
  it('collects debt proof reviews from advisor contact records', () => {
    const reviews = collectDebtProofReviewsFromContactRecords({
      data: {
        contacts: [{
          id: 'contact-1',
          context: {
            materials: [{
              id: 'debt-proof-proof-new',
              executionRecordId: 'proof-new',
              source: 'debt-proof',
              status: 'confirmed',
              statusText: '已确认',
              reviewNote: '已核对到账',
              reviewedAt: '2026-07-02T12:00:00.000Z'
            }]
          }
        }]
      }
    })

    assert.equal(reviews.length, 1)
    assert.equal(reviews[0].executionRecordId, 'proof-new')
    assert.equal(reviews[0].statusText, '已确认')
    assert.equal(reviews[0].reviewNote, '已核对到账')
  })

  it('syncs remote contact proof reviews into local execution storage', () => {
    const store = new Map()
    const api = {
      getStorageSync: (key) => store.get(key) || '',
      setStorageSync: (key, value) => store.set(key, value)
    }
    store.set(DEBT_EXECUTION_RECORD_KEY, JSON.stringify([{
      id: 'proof-new',
      type: 'proof',
      debtId: 'card-a',
      title: '工商银行 · 信用卡',
      status: 'reviewing',
      fileName: 'repay-new.png',
      uploadedAt: '2026-07-02T11:05:00.000Z'
    }]))

    const result = syncDebtProofReviewsFromContacts([{
      id: 'contact-1',
      requiredMaterials: [{
        id: 'debt-proof-proof-new',
        executionRecordId: 'proof-new',
        source: 'debt-proof',
        status: 'confirmed',
        statusText: '已确认',
        reviewNote: '已核对到账',
        reviewedAt: '2026-07-02T12:00:00.000Z'
      }]
    }], api)

    const saved = store.get(DEBT_EXECUTION_RECORD_KEY)
    assert.equal(result.changed, true)
    assert.equal(result.records[0].statusText, '已确认')
    assert.equal(saved[0].statusText, '已确认')
    assert.equal(saved[0].reviewNote, '已核对到账')
  })
  it('records user acknowledgement for reviewed debt proof results', () => {
    const result = acknowledgeDebtProofReview([{
      id: 'proof-confirmed',
      type: 'proof',
      debtId: 'card-a',
      reportId: 'r1',
      title: '工商银行 · 信用卡',
      status: 'confirmed',
      statusText: '已确认',
      reviewedAt: '2026-07-02T12:00:00.000Z',
      uploadedAt: '2026-07-02T11:00:00.000Z',
      url: 'https://example.test/proof.png'
    }], { id: 'proof-confirmed' }, {
      at: '2026-07-02T12:05:00.000Z',
      reviewAcknowledgedNote: '用户已查看凭证确认结果。'
    })

    const payload = debtExecutionRecordToPayload(result.record)

    assert.equal(result.changed, true)
    assert.equal(result.record.reviewAckStage, 'review_acknowledged')
    assert.equal(result.record.reviewAcknowledgedAt, '2026-07-02T12:05:00.000Z')
    assert.equal(payload.reviewReceipt.stage, 'review_acknowledged')
    assert.equal(payload.reviewReceipt.executionRecordId, 'proof-confirmed')
    assert.equal(payload.reviewReceipt.actionAt, '2026-07-02T12:05:00.000Z')
  })
  it('keeps an advisor unneeded proof terminal and acknowledgeable', () => {
    const result = acknowledgeDebtProofReview([{
      id: 'proof-unneeded',
      type: 'proof',
      debtId: 'card-a',
      reportId: 'r1',
      status: 'unneeded',
      statusText: '无需',
      reviewNote: '无需继续补充',
      reviewedAt: '2026-07-02T11:00:00.000Z'
    }], {
      id: 'proof-unneeded',
      reportId: 'r1'
    }, {
      reviewAcknowledgedAt: '2026-07-02T12:00:00.000Z'
    })

    assert.equal(debtProofStatusText(result.record), '无需')
    assert.equal(result.record.status, 'unneeded')
    assert.equal(result.record.reviewAckStage, 'review_acknowledged')
  })
  it('folds rejected proof records after a newer reupload', () => {
    const records = [
      {
        id: 'proof-old',
        type: 'proof',
        debtId: 'card-a',
        title: '工商银行 · 信用卡',
        status: 'rejected',
        statusText: '需重传',
        reviewNote: '截图金额不清晰',
        reviewedAt: '2026-07-02T11:00:00.000Z',
        createdAt: '2026-07-02T10:00:00.000Z'
      },
      {
        id: 'proof-new',
        type: 'proof',
        debtId: 'card-a',
        title: '工商银行 · 信用卡',
        status: 'reviewing',
        reuploadOf: 'proof-old',
        uploadedAt: '2026-07-02T11:05:00.000Z',
        createdAt: '2026-07-02T11:05:00.000Z'
      }
    ]

    assert.deepEqual(activeDebtExecutionRecords(records).map((item) => item.id), ['proof-new'])
    assert.deepEqual(supersededDebtProofRecords(records).map((item) => item.id), ['proof-old'])
    assert.deepEqual(debtExecutionRecordsToMaterials(records).map((item) => item.executionRecordId), ['proof-new'])
  })

  it('does not fold a rejected proof because another report reused the same debt id', () => {
    const records = [
      {
        id: 'proof-report-a',
        type: 'proof',
        debtId: 'card-shared',
        reportId: 'report-a',
        status: 'rejected',
        statusText: '需重传',
        reviewedAt: '2026-07-02T11:00:00.000Z',
        createdAt: '2026-07-02T10:00:00.000Z'
      },
      {
        id: 'proof-report-b',
        type: 'proof',
        debtId: 'card-shared',
        reportId: 'report-b',
        status: 'reviewing',
        uploadedAt: '2026-07-02T11:05:00.000Z',
        createdAt: '2026-07-02T11:05:00.000Z'
      }
    ]

    assert.deepEqual(activeDebtExecutionRecords(records).map((item) => item.id), ['proof-report-a', 'proof-report-b'])
    assert.deepEqual(supersededDebtProofRecords(records), [])
  })

  it('does not apply debt and file fallback reviews across report scopes', () => {
    const records = [
      {
        id: 'proof-a',
        type: 'proof',
        debtId: 'card-shared',
        reportId: 'report-a',
        status: 'reviewing',
        fileName: 'repayment.png'
      },
      {
        id: 'proof-b',
        type: 'proof',
        debtId: 'card-shared',
        reportId: 'report-b',
        status: 'reviewing',
        fileName: 'repayment.png'
      }
    ]
    const result = applyDebtProofReviews(records, [{
      debtId: 'card-shared',
      reportId: 'report-b',
      fileName: 'repayment.png',
      status: 'confirmed',
      statusText: '已确认',
      reviewedAt: '2026-07-02T12:00:00.000Z'
    }])

    assert.equal(result.changed, true)
    assert.equal(debtProofStatusText(result.records[0]), '待复核')
    assert.equal(debtProofStatusText(result.records[1]), '已确认')
  })

  it('matches a formal report review to its legacy client report alias', () => {
    const result = applyDebtProofReviews([{
      id: 'proof-local-alias',
      type: 'proof',
      debtId: 'card-a',
      reportId: 'local_report_A',
      status: 'reviewing',
      fileName: 'repayment.png'
    }], [{
      debtId: 'card-a',
      reportId: 'r_formal_A',
      clientReportId: 'local_report_A',
      fileName: 'repayment.png',
      status: 'confirmed',
      statusText: '已确认'
    }])

    assert.equal(result.changed, true)
    assert.equal(debtProofStatusText(result.records[0]), '已确认')
  })

  it('uses the newest decisive review across a formal report id and its local alias', () => {
    const result = applyDebtProofReviews([{
      id: 'proof-shared-scope',
      type: 'proof',
      debtId: 'card-a',
      reportId: 'r_formal_A',
      clientReportId: 'local_report_A',
      status: 'reviewing',
      fileName: 'repayment.png'
    }], [{
      executionRecordId: 'proof-shared-scope',
      reportId: 'local_report_A',
      status: 'uploaded',
      statusText: '待复核',
      updatedAt: '2026-07-02T10:00:00.000Z'
    }, {
      executionRecordId: 'proof-shared-scope',
      reportId: 'r_formal_A',
      status: 'confirmed',
      statusText: '已确认',
      reviewedAt: '2026-07-02T12:00:00.000Z'
    }])

    assert.equal(result.changed, true)
    assert.equal(debtProofStatusText(result.records[0]), '已确认')
    assert.equal(result.records[0].reviewedAt, '2026-07-02T12:00:00.000Z')
  })

  it('does not let a newer pending snapshot shadow an earlier decisive review', () => {
    const result = applyDebtProofReviews([{
      id: 'proof-terminal',
      type: 'proof',
      debtId: 'card-a',
      reportId: 'r_formal_A',
      status: 'reviewing'
    }], [{
      executionRecordId: 'proof-terminal',
      reportId: 'r_formal_A',
      status: 'confirmed',
      statusText: '已确认',
      reviewedAt: '2026-07-02T12:00:00.000Z'
    }, {
      executionRecordId: 'proof-terminal',
      reportId: 'r_formal_A',
      status: 'uploaded',
      statusText: '待复核',
      updatedAt: '2026-07-02T13:00:00.000Z'
    }])

    assert.equal(debtProofStatusText(result.records[0]), '已确认')
  })

  it('does not apply an unscoped legacy review to duplicate ids in different reports', () => {
    const result = applyDebtProofReviews([{
      id: 'proof-duplicate',
      type: 'proof',
      debtId: 'card-shared',
      reportId: 'report-a',
      status: 'reviewing'
    }, {
      id: 'proof-duplicate',
      type: 'proof',
      debtId: 'card-shared',
      reportId: 'report-b',
      status: 'reviewing'
    }], [{
      executionRecordId: 'proof-duplicate',
      status: 'confirmed',
      statusText: '已确认',
      reviewedAt: '2026-07-02T12:00:00.000Z'
    }])

    assert.equal(result.changed, false)
    assert.deepEqual(result.records.map(debtProofStatusText), ['待复核', '待复核'])
  })

  it('inherits the contact report scope for nested legacy proof reviews', () => {
    const reviews = collectDebtProofReviewsFromContactRecords([{
      reportId: 'report-b',
      materials: [{
        debtId: 'card-shared',
        fileName: 'repayment.png',
        source: 'debt-proof',
        status: 'confirmed',
        statusText: '已确认'
      }]
    }])

    assert.equal(reviews.length, 1)
    assert.equal(reviews[0].reportId, 'report-b')
  })

  it('merges cloud debt records and advisor reviews into the user snapshot', () => {
    const localRecords = [{
      id: 'proof-a',
      type: 'proof',
      debtId: 'card-a',
      title: '工商银行 · 信用卡',
      status: 'reviewing',
      fileName: 'proof.png',
      uploadedAt: '2026-07-02T10:00:00.000Z'
    }]
    const remoteRecords = [{
      id: 'handled-b',
      type: 'handled',
      debtId: 'loan-b',
      title: '建设银行 · 消费贷',
      status: 'handled',
      createdAt: '2026-07-02T10:30:00.000Z'
    }]
    const contactRecords = [{
      context: {
        materials: [{
          id: debtProofMaterialId(localRecords[0]),
          executionRecordId: 'proof-a',
          source: 'debt-proof',
          status: 'confirmed',
          statusText: '已确认',
          reviewedAt: '2026-07-02T11:00:00.000Z'
        }]
      }
    }]

    const result = applyDebtExecutionCloudSnapshot(localRecords, { remoteRecords, contactRecords })

    assert.equal(result.changed, true)
    assert.equal(result.remoteCount, 1)
    assert.equal(result.reviewCount, 1)
    assert.deepEqual(result.records.map((item) => item.id).sort(), ['handled-b', 'proof-a'])
    assert.equal(debtProofStatusText(result.records.find((item) => item.id === 'proof-a')), '已确认')
  })

  it('keeps identical execution identities isolated between reports', () => {
    const records = mergeDebtExecutionRecords(
      [{
        id: 'same-id',
        type: 'proof',
        debtId: 'same-debt',
        reportId: 'report-a',
        fileName: 'same.png',
        uploadedAt: '2026-07-02T10:00:00.000Z'
      }],
      [{
        id: 'same-id',
        type: 'proof',
        debtId: 'same-debt',
        reportId: 'report-b',
        fileName: 'same.png',
        uploadedAt: '2026-07-02T10:00:00.000Z'
      }]
    )

    assert.equal(records.length, 2)
    assert.deepEqual(new Set(records.map((item) => item.reportId)), new Set(['report-a', 'report-b']))
  })

  it('merges a local report alias with the same canonical cloud record', () => {
    const records = mergeDebtExecutionRecords(
      [{
        id: 'same-id',
        type: 'proof',
        debtId: 'same-debt',
        reportId: 'local_report_A',
        fileName: 'same.png',
        uploadedAt: '2026-07-02T10:00:00.000Z'
      }],
      [{
        id: 'same-id',
        type: 'proof',
        debtId: 'same-debt',
        reportId: 'r_formal_A',
        clientReportId: 'local_report_A',
        fileName: 'same.png',
        uploadedAt: '2026-07-02T10:00:00.000Z'
      }]
    )

    assert.equal(records.length, 1)
    assert.equal(records[0].reportId, 'r_formal_A')
    assert.equal(records[0].clientReportId, 'local_report_A')
  })

  it('queues failed cloud debt execution sync and retries it', async () => {
    const store = new Map()
    const api = {
      getStorageSync: (key) => store.get(key) || '',
      setStorageSync: (key, value) => store.set(key, value)
    }
    const record = {
      id: 'proof-a',
      type: 'proof',
      debtId: 'card-a',
      title: '工商银行 · 信用卡',
      status: 'reviewing',
      url: 'https://example.test/proof.png',
      uploadedAt: '2026-07-02T10:00:00.000Z'
    }

    const failed = await syncDebtExecutionRecord(record, async () => { throw new Error('offline') }, api)
    const queued = readDebtExecutionSyncQueue(api)
    const storedBeforeRetry = JSON.parse(store.get(DEBT_EXECUTION_SYNC_QUEUE_KEY))
    let sent = null
    const retried = await retryPendingDebtExecutionSync(async (payload) => { sent = payload }, api)

    assert.equal(failed.queued, true)
    assert.equal(queued.length, 1)
    assert.equal(queued[0].retryCount, 1)
    assert.equal(storedBeforeRetry.length, 1)
    assert.equal(retried.success, 1)
    assert.equal(sent.executionRecordId, 'proof-a')
    assert.equal(readDebtExecutionSyncQueue(api).length, 0)
  })

  it('keeps failed sync outbox entries isolated between reports', async () => {
    const store = new Map()
    const api = {
      getStorageSync: (key) => store.get(key) || '',
      setStorageSync: (key, value) => store.set(key, value)
    }
    const shared = {
      id: 'same-id',
      type: 'proof',
      debtId: 'same-debt',
      fileName: 'same.png',
      uploadedAt: '2026-07-02T10:00:00.000Z'
    }
    await syncDebtExecutionRecord({ ...shared, reportId: 'report-a' }, async () => { throw new Error('offline') }, api)
    await syncDebtExecutionRecord({ ...shared, reportId: 'report-b' }, async () => { throw new Error('offline') }, api)

    const queued = readDebtExecutionSyncQueue(api)
    assert.equal(queued.length, 2)
    assert.deepEqual(new Set(queued.map((item) => item.reportId)), new Set(['report-a', 'report-b']))

    await syncDebtExecutionRecord({ ...shared, reportId: 'report-a' }, async () => {}, api)
    const remaining = readDebtExecutionSyncQueue(api)
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0].reportId, 'report-b')
  })

  it('migrates a legacy unscoped queue key from the payload report', () => {
    const store = new Map()
    const api = {
      getStorageSync: (key) => store.get(key) || '',
      setStorageSync: (key, value) => store.set(key, value)
    }
    store.set(DEBT_EXECUTION_SYNC_QUEUE_KEY, JSON.stringify([{
      syncKey: 'same-id|same-debt|proof|same.png',
      id: 'same-id',
      executionRecordId: 'same-id',
      debtId: 'same-debt',
      type: 'proof',
      reportId: 'report-a',
      fileName: 'same.png',
      uploadUrl: 'https://example.test/same.png'
    }]))

    const [migrated] = readDebtExecutionSyncQueue(api)
    assert.match(migrated.syncKey, /^report-a\|/)
  })
})
