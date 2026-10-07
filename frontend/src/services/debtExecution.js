export const DEBT_EXECUTION_RECORD_KEY = 'debt_execution_records'
export const DEBT_EXECUTION_SYNC_QUEUE_KEY = 'rpt_debt_execution_sync_queue'

const storage = () => (typeof uni !== 'undefined' ? uni : null)
const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== '')
const asObject = (value) => value && typeof value === 'object' ? value : {}
const asArray = (value) => Array.isArray(value) ? value : []
const cleanStatus = (value) => String(value || '').trim().toLowerCase()
const parseStored = (raw, fallback = null) => {
  if (raw == null || raw === '') return fallback
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch (e) { return fallback }
  }
  return raw
}
const arrayFromPayload = (payload) => {
  const raw = parseStored(payload, payload)
  if (Array.isArray(raw)) return raw
  if (!raw || typeof raw !== 'object') return []
  return arrayFromPayload(first(raw.records, raw.list, raw.items, raw.executionRecords, raw.debtExecutionRecords, raw.debtProofs, raw.data, []))
}
const toTs = (value) => {
  if (value == null || value === '') return 0
  const n = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(n) ? n : 0
}
const syncIdentityKeyOf = (record = {}) => [
  first(record.id, record.recordId, record.executionRecordId, ''),
  first(record.debtId, record.accountId, ''),
  first(record.type, record.kind, ''),
  first(record.url, record.uploadUrl, record.fileUrl, record.createdAt, record.uploadedAt, '')
].join('|')
const recordUpdatedTs = (record = {}) => toTs(first(record.reviewedAt, record.updatedAt, record.uploadedAt, record.createdAt, record.time))
const reportScopeIds = (record = {}) => [
  record.reportId,
  record.clientReportId,
  record.sourceReportId
].map((value) => String(value || '').trim()).filter(Boolean)
const syncScopeKeyOf = (record = {}) => String(first(
  record.clientReportId,
  record.sourceReportId,
  record.reportId,
  'legacy'
))
const syncKeyOf = (record = {}) => `${syncScopeKeyOf(record)}|${syncIdentityKeyOf(record)}`
const reportScopesConflict = (left = {}, right = {}) => {
  const leftIds = reportScopeIds(left)
  const rightIds = reportScopeIds(right)
  return leftIds.length > 0 && rightIds.length > 0 && !leftIds.some((value) => rightIds.includes(value))
}
const sameReportScope = (left = {}, right = {}) => {
  const leftIds = reportScopeIds(left)
  const rightIds = reportScopeIds(right)
  return (!leftIds.length && !rightIds.length) || leftIds.some((value) => rightIds.includes(value))
}

export const debtProofMaterialId = (record = {}) => `debt-proof-${first(record.id, record.executionRecordId, record.debtId, record.fileName, 'record')}`

export function debtProofStatusText(record = {}) {
  const explicit = first(record.statusText, record.stateText, '')
  if (explicit) return explicit === '待确认' ? '待复核' : explicit
  const status = cleanStatus(first(record.status, record.state, record.reviewStatus, ''))
  if (['confirmed', 'approved', 'verified', 'done', 'completed'].includes(status)) return '已确认'
  if (['unneeded', 'optional', 'not_required', 'waived', 'skipped'].includes(status)) return '无需'
  if (['rejected', 'reject', 'reupload', 'need_reupload', 'invalid', 'failed'].includes(status)) return '需重传'
  if (['reviewing', 'uploaded', 'submitted', 'pending_review', 'pending'].includes(status)) return '待复核'
  return record.type === 'proof' ? '待复核' : '已记录'
}

export function normalizeDebtExecutionRecord(value = {}, index = 0) {
  const raw = asObject(value)
  const now = new Date().toISOString()
  const type = first(raw.type, raw.kind, raw.category, raw.url || raw.uploadUrl || raw.fileName ? 'proof' : 'handled')
  const id = String(first(raw.id, raw.recordId, raw.executionRecordId, `debt_exec_${index}`))
  const statusText = type === 'proof' ? debtProofStatusText(raw) : first(raw.statusText, '已记录')
  const status = first(
    raw.status,
    raw.state,
    statusText === '已确认' ? 'confirmed' : statusText === '无需' ? 'unneeded' : statusText === '需重传' ? 'rejected' : type === 'proof' ? 'reviewing' : 'handled'
  )
  const createdAt = first(raw.createdAt, raw.uploadedAt, raw.reviewedAt, raw.updatedAt, now)
  const time = Number(first(raw.time, Date.parse(createdAt), Date.now()))
  return {
    ...raw,
    id,
    type,
    debtId: first(raw.debtId, raw.accountId, raw.itemId, ''),
    reportId: first(raw.reportId, ''),
    title: first(raw.title, raw.debtTitle, raw.name, raw.materialName, '当前债务'),
    product: first(raw.product, ''),
    institution: first(raw.institution, ''),
    status,
    statusText,
    note: first(raw.note, raw.desc, raw.description, ''),
    reviewNote: first(raw.reviewNote, raw.rejectReason, raw.reason, raw.reviewRemark, ''),
    reviewedAt: first(raw.reviewedAt, raw.reviewTime, ''),
    reviewAckStage: first(raw.reviewAckStage, raw.ackStage, raw.userReviewAckStage, ''),
    reviewAcknowledgedAt: first(raw.reviewAcknowledgedAt, raw.reviewAckAt, raw.acknowledgedAt, raw.userAcknowledgedAt, ''),
    reviewAcknowledgedNote: first(raw.reviewAcknowledgedNote, raw.reviewAckNote, raw.ackNote, raw.userReviewNote, ''),
    uploadedAt: first(raw.uploadedAt, raw.uploadTime, raw.submittedAt, type === 'proof' ? createdAt : ''),
    url: first(raw.url, raw.uploadUrl, raw.fileUrl, ''),
    fileName: first(raw.fileName, raw.nameOnDisk, raw.uploadName, ''),
    fileSize: raw.fileSize === undefined ? '' : raw.fileSize,
    time: Number.isFinite(time) ? time : Date.now(),
    createdAt
  }
}

export function readDebtExecutionRecords(api = storage()) {
  if (!api) return []
  try {
    const raw = api.getStorageSync(DEBT_EXECUTION_RECORD_KEY)
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw
    return asArray(parsed).map(normalizeDebtExecutionRecord)
  } catch (e) {
    return []
  }
}

export function saveDebtExecutionRecords(records = [], api = storage()) {
  const next = asArray(records).map(normalizeDebtExecutionRecord).slice(0, 80)
  if (api) {
    try { api.setStorageSync(DEBT_EXECUTION_RECORD_KEY, next) } catch (e) {}
  }
  return next
}

export function isDebtProofSuperseded(record = {}, records = []) {
  const target = normalizeDebtExecutionRecord(record)
  if (target.type !== 'proof' || debtProofStatusText(target) !== '需重传') return false
  const targetTs = toTs(first(target.reviewedAt, target.updatedAt, target.uploadedAt, target.createdAt, target.time))
  return asArray(records)
    .map(normalizeDebtExecutionRecord)
    .some((item) => {
      if (item.id === target.id || item.type !== 'proof') return false
      if (!sameReportScope(item, target)) return false
      if (item.reuploadOf && String(item.reuploadOf) === String(target.id)) return true
      if (!target.debtId || String(item.debtId) !== String(target.debtId)) return false
      const itemTs = toTs(first(item.uploadedAt, item.createdAt, item.time))
      return itemTs > targetTs && debtProofStatusText(item) !== '需重传'
    })
}

export function activeDebtExecutionRecords(records = []) {
  const normalized = asArray(records).map(normalizeDebtExecutionRecord)
  return normalized.filter((record) => !isDebtProofSuperseded(record, normalized))
}

export function supersededDebtProofRecords(records = []) {
  const normalized = asArray(records).map(normalizeDebtExecutionRecord)
  return normalized.filter((record) => isDebtProofSuperseded(record, normalized))
}
export function debtExecutionRecordsToMaterials(records = []) {
  return activeDebtExecutionRecords(records)
    .filter((record) => record.type === 'proof')
    .map((record) => ({
      id: debtProofMaterialId(record),
      executionRecordId: record.id,
      debtId: record.debtId,
      reportId: record.reportId,
      clientReportId: record.clientReportId,
      sourceReportId: record.sourceReportId,
      name: `${record.title || '债务'}还款凭证`,
      materialName: `${record.title || '债务'}还款凭证`,
      status: record.status,
      statusText: debtProofStatusText(record) === '待复核' ? '待确认' : debtProofStatusText(record),
      uploadUrl: record.url,
      fileName: record.fileName,
      fileSize: record.fileSize,
      uploadedAt: record.uploadedAt || record.createdAt,
      reviewNote: record.reviewNote,
      reviewedAt: record.reviewedAt,
      reviewAckStage: record.reviewAckStage,
      reviewAcknowledgedAt: record.reviewAcknowledgedAt,
      reviewAcknowledgedNote: record.reviewAcknowledgedNote,
      source: 'debt-proof',
      required: true
    }))
}

export function collectDebtProofReviewsFromMaterials(materials = []) {
  return asArray(materials)
    .filter((item) => {
      const raw = asObject(item)
      return raw.source === 'debt-proof' || raw.executionRecordId || String(raw.id || '').startsWith('debt-proof-')
    })
    .map((item) => {
      const raw = asObject(item)
      return {
        materialId: first(raw.id, ''),
        executionRecordId: first(raw.executionRecordId, String(raw.id || '').replace(/^debt-proof-/, '')),
        debtId: first(raw.debtId, ''),
        reportId: first(raw.reportId, ''),
        clientReportId: first(raw.clientReportId, raw.sourceReportId, ''),
        sourceReportId: first(raw.sourceReportId, raw.clientReportId, ''),
        status: first(raw.status, raw.state, raw.uploadStatus, ''),
        statusText: debtProofStatusText(raw),
        reviewNote: first(raw.reviewNote, raw.rejectReason, raw.reason, raw.reviewRemark, raw.note, ''),
        reviewedAt: first(raw.reviewedAt, raw.reviewTime, ''),
        uploadUrl: first(raw.uploadUrl, raw.url, raw.fileUrl, ''),
        fileName: first(raw.fileName, raw.nameOnDisk, raw.uploadName, '')
      }
    })
}

const MATERIAL_REVIEW_KEYS = ['materials', 'requiredMaterials', 'pendingMaterials', 'materialChecklist', 'materialList', 'documents']
const EXECUTION_RECORD_KEYS = ['executionRecords', 'debtExecutionRecords', 'debtProofs']
const CONTACT_NESTED_KEYS = ['data', 'list', 'records', 'contacts', 'items', 'results', 'rows', 'context', 'consultContext', 'matchContext', 'payload', 'extra', 'report', 'reportInfo', 'product', 'productInfo']

const debtReviewIdentityKey = (review = {}) => first(
  review.executionRecordId,
  review.materialId,
  review.debtId && review.uploadUrl ? `${review.debtId}|${review.uploadUrl}` : '',
  review.debtId && review.fileName ? `${review.debtId}|${review.fileName}` : ''
)

const reviewScore = (review = {}) => {
  const statusText = debtProofStatusText(review)
  const reviewed = review.reviewedAt ? 2 : 0
  const noted = review.reviewNote ? 1 : 0
  const decisive = statusText === '已确认' || statusText === '需重传' ? 4 : 0
  return decisive + reviewed + noted
}

const reviewTimestamp = (review = {}) => toTs(first(
  review.reviewedAt,
  review.updatedAt,
  review.uploadedAt,
  review.createdAt
))

const preferredReview = (left = {}, right = {}) => {
  const leftDecisive = ['已确认', '需重传'].includes(debtProofStatusText(left))
  const rightDecisive = ['已确认', '需重传'].includes(debtProofStatusText(right))
  if (rightDecisive !== leftDecisive) return rightDecisive ? right : left
  const leftTs = reviewTimestamp(left)
  const rightTs = reviewTimestamp(right)
  if (rightTs !== leftTs) return rightTs > leftTs ? right : left
  return reviewScore(right) >= reviewScore(left) ? right : left
}

const dedupeDebtProofReviews = (reviews = []) => {
  const deduped = []
  asArray(reviews).filter(Boolean).forEach((review) => {
    const raw = asObject(review)
    const identityKey = debtReviewIdentityKey(raw)
    if (!identityKey) {
      deduped.push(raw)
      return
    }
    const previousIndex = deduped.findIndex((previous) => (
      debtReviewIdentityKey(previous) === identityKey &&
      sameReportScope(previous, raw)
    ))
    if (previousIndex < 0) deduped.push(raw)
    else deduped[previousIndex] = preferredReview(deduped[previousIndex], raw)
  })
  return deduped
}

export function collectDebtProofReviewsFromContactRecords(records = []) {
  const reviews = []
  const seen = new Set()
  const withReportScope = (items, scope = {}) => asArray(items).map((item) => ({
    ...item,
    reportId: first(item.reportId, scope.reportId, ''),
    clientReportId: first(item.clientReportId, item.sourceReportId, scope.clientReportId, ''),
    sourceReportId: first(item.sourceReportId, item.clientReportId, scope.clientReportId, '')
  }))
  const visit = (value, depth = 0, inheritedScope = {}) => {
    if (!value || depth > 6) return
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1, inheritedScope))
      return
    }
    if (typeof value !== 'object') return
    if (seen.has(value)) return
    seen.add(value)
    const raw = asObject(value)
    const currentScope = {
      reportId: String(first(raw.reportId, raw.context && raw.context.reportId, inheritedScope.reportId, '') || ''),
      clientReportId: String(first(
        raw.clientReportId,
        raw.sourceReportId,
        raw.context && raw.context.clientReportId,
        raw.context && raw.context.sourceReportId,
        inheritedScope.clientReportId,
        ''
      ) || '')
    }
    reviews.push(...withReportScope(collectDebtProofReviewsFromMaterials([raw]), currentScope))
    MATERIAL_REVIEW_KEYS.forEach((key) => {
      if (Array.isArray(raw[key])) reviews.push(...withReportScope(collectDebtProofReviewsFromMaterials(raw[key]), currentScope))
    })
    EXECUTION_RECORD_KEYS.forEach((key) => {
      if (Array.isArray(raw[key])) {
        reviews.push(...withReportScope(collectDebtProofReviewsFromMaterials(debtExecutionRecordsToMaterials(raw[key])), currentScope))
      }
    })
    CONTACT_NESTED_KEYS.forEach((key) => {
      const next = raw[key]
      if (next && typeof next === 'object') visit(next, depth + 1, currentScope)
    })
  }
  visit(records)
  return dedupeDebtProofReviews(reviews)
}
const sameProofRecord = (record = {}, review = {}) => {
  const materialId = first(review.materialId, '')
  const executionId = first(review.executionRecordId, '')
  if (reportScopesConflict(record, review)) return false
  if (executionId && String(record.id) === String(executionId)) return true
  if (materialId && debtProofMaterialId(record) === String(materialId)) return true
  if (!sameReportScope(record, review)) return false
  if (review.debtId && record.debtId && String(review.debtId) === String(record.debtId)) {
    if (review.uploadUrl && record.url && String(review.uploadUrl) === String(record.url)) return true
    if (review.fileName && record.fileName && String(review.fileName) === String(record.fileName)) return true
  }
  return false
}

export function applyDebtProofReviews(records = [], reviews = []) {
  let changed = false
  const normalizedRecords = asArray(records).map(normalizeDebtExecutionRecord)
  const normalizedReviews = dedupeDebtProofReviews(reviews)
  const next = normalizedRecords.map((record) => {
    if (record.type !== 'proof') return record
    const review = normalizedReviews
      .filter((item) => {
        if (!sameProofRecord(record, item)) return false
        if (reportScopeIds(item).length) return true
        const candidates = normalizedRecords.filter((candidate) => (
          candidate.type === 'proof' && sameProofRecord(candidate, item)
        ))
        return candidates.length === 1
      })
      .reduce((selected, item) => selected ? preferredReview(selected, item) : item, null)
    if (!review) return record
    const currentStatusText = debtProofStatusText(record)
    const statusText = debtProofStatusText(review)
    if ((currentStatusText === '已确认' || currentStatusText === '需重传') && statusText === '待复核' && !review.reviewedAt && !review.reviewNote) return record
    const merged = normalizeDebtExecutionRecord({
      ...record,
      status: first(review.status, statusText === '已确认' ? 'confirmed' : statusText === '需重传' ? 'rejected' : record.status),
      statusText,
      reviewNote: first(review.reviewNote, record.reviewNote, ''),
      reviewedAt: first(review.reviewedAt, record.reviewedAt, ''),
      updatedAt: first(review.reviewedAt, record.updatedAt, record.createdAt)
    })
    if (
      merged.statusText !== record.statusText ||
      merged.reviewNote !== record.reviewNote ||
      merged.reviewedAt !== record.reviewedAt ||
      merged.status !== record.status
    ) changed = true
    return merged
  })
  return { records: next, changed }
}

export function isReviewableDebtProofRecord(record = {}) {
  const normalized = normalizeDebtExecutionRecord(record)
  const statusText = debtProofStatusText(normalized)
  return normalized.type === 'proof' && (statusText === '已确认' || statusText === '无需' || statusText === '需重传')
}

export function debtProofReviewAckReceipt(record = {}, patch = {}) {
  const normalized = normalizeDebtExecutionRecord(record)
  const at = first(patch.reviewAcknowledgedAt, patch.acknowledgedAt, patch.actionAt, patch.at, normalized.reviewAcknowledgedAt, new Date().toISOString())
  const stage = first(patch.reviewAckStage, patch.stage, normalized.reviewAckStage, 'review_acknowledged')
  return {
    id: first(patch.id, `debt-proof-review-${normalized.id}`),
    messageId: first(patch.messageId, `debt-proof-review-${normalized.id}`),
    stage,
    actionAt: at,
    handledAt: at,
    debtId: normalized.debtId,
    executionRecordId: normalized.id,
    reportId: normalized.reportId,
    statusText: debtProofStatusText(normalized),
    title: normalized.title,
    source: 'debt-proof-review'
  }
}

export function acknowledgeDebtProofReview(records = [], target = {}, patch = {}) {
  const targetId = first(target.id, target.executionRecordId, patch.id, patch.executionRecordId, '')
  let changed = false
  let acknowledged = null
  let receipt = null
  const next = asArray(records).map(normalizeDebtExecutionRecord).map((record) => {
    const matched = targetId
      ? String(record.id) === String(targetId) && !reportScopesConflict(record, target)
      : sameProofRecord(record, target)
    if (!matched || !isReviewableDebtProofRecord(record)) return record
    const nextReceipt = debtProofReviewAckReceipt(record, patch)
    const statusText = debtProofStatusText(record)
    const nextNote = first(
      patch.reviewAcknowledgedNote,
      patch.note,
      record.reviewAcknowledgedNote,
      statusText === '需重传' ? '用户已查看驳回原因，稍后处理。' : '用户已查看凭证确认结果。'
    )
    const merged = normalizeDebtExecutionRecord({
      ...record,
      reviewAckStage: nextReceipt.stage,
      reviewAcknowledgedAt: nextReceipt.actionAt,
      reviewAcknowledgedNote: nextNote,
      reviewReceipt: nextReceipt,
      updatedAt: nextReceipt.actionAt
    })
    if (
      merged.reviewAckStage !== record.reviewAckStage ||
      merged.reviewAcknowledgedAt !== record.reviewAcknowledgedAt ||
      merged.reviewAcknowledgedNote !== record.reviewAcknowledgedNote
    ) changed = true
    acknowledged = merged
    receipt = nextReceipt
    return merged
  })
  return { records: next, changed, record: acknowledged, receipt }
}
export function syncDebtProofReviewsFromContacts(contactsData = [], api = storage()) {
  const reviews = collectDebtProofReviewsFromContactRecords(contactsData)
  const synced = applyDebtProofReviews(readDebtExecutionRecords(api), reviews)
  if (synced.changed) saveDebtExecutionRecords(synced.records, api)
  return { ...synced, reviews }
}
export function normalizeDebtExecutionRecordsPayload(payload = []) {
  return arrayFromPayload(payload).map(normalizeDebtExecutionRecord)
}

const mergeRecordFields = (previous = {}, next = {}) => {
  const merged = { ...previous, ...next }
  Object.keys(previous || {}).forEach((key) => {
    if (next[key] === undefined || next[key] === null || next[key] === '') merged[key] = previous[key]
  })
  return normalizeDebtExecutionRecord(merged)
}

export function mergeDebtExecutionRecords(...sources) {
  const mergedRecords = []
  sources.forEach((source) => {
    arrayFromPayload(source).map(normalizeDebtExecutionRecord).forEach((record) => {
      const index = mergedRecords.findIndex((previous) => (
        sameReportScope(previous, record) &&
        syncIdentityKeyOf(previous) === syncIdentityKeyOf(record)
      ))
      if (index < 0) {
        mergedRecords.push(record)
        return
      }
      const previous = mergedRecords[index]
      if (recordUpdatedTs(record) >= recordUpdatedTs(previous)) {
        mergedRecords[index] = mergeRecordFields(previous, record)
      }
    })
  })
  return mergedRecords.sort((a, b) => recordUpdatedTs(b) - recordUpdatedTs(a)).slice(0, 120)
}

export function applyDebtExecutionCloudSnapshot(localRecords = [], options = {}) {
  const remoteRecords = normalizeDebtExecutionRecordsPayload(options.remoteRecords || [])
  const merged = mergeDebtExecutionRecords(localRecords, remoteRecords)
  const reviews = [
    ...collectDebtProofReviewsFromMaterials(options.reviewMaterials || []),
    ...collectDebtProofReviewsFromContactRecords(options.contactRecords || [])
  ]
  const applied = applyDebtProofReviews(merged, reviews)
  const before = JSON.stringify(arrayFromPayload(localRecords).map(normalizeDebtExecutionRecord))
  const after = JSON.stringify(applied.records)
  return {
    records: applied.records,
    changed: applied.changed || before !== after,
    remoteCount: remoteRecords.length,
    reviewCount: reviews.length
  }
}

export function debtExecutionRecordToPayload(record = {}, patch = {}) {
  const normalized = normalizeDebtExecutionRecord({ ...record, ...patch })
  return {
    id: normalized.id,
    executionRecordId: normalized.id,
    debtId: normalized.debtId,
    reportId: normalized.reportId,
    clientReportId: normalized.clientReportId || normalized.sourceReportId || '',
    sourceReportId: normalized.sourceReportId || normalized.clientReportId || '',
    type: normalized.type,
    title: normalized.title,
    product: normalized.product,
    institution: normalized.institution,
    status: normalized.status,
    statusText: normalized.statusText,
    note: normalized.note,
    reviewNote: normalized.reviewNote,
    reviewedAt: normalized.reviewedAt,
    reviewAckStage: normalized.reviewAckStage,
    reviewAcknowledgedAt: normalized.reviewAcknowledgedAt,
    reviewAcknowledgedNote: normalized.reviewAcknowledgedNote,
    reviewReceipt: normalized.reviewAcknowledgedAt ? debtProofReviewAckReceipt(normalized) : normalized.reviewReceipt || null,
    uploadedAt: normalized.uploadedAt,
    uploadUrl: normalized.url,
    url: normalized.url,
    fileName: normalized.fileName,
    fileSize: normalized.fileSize,
    reuploadOf: normalized.reuploadOf || '',
    createdAt: normalized.createdAt,
    updatedAt: first(normalized.updatedAt, normalized.reviewedAt, normalized.uploadedAt, normalized.createdAt, new Date().toISOString()),
    source: first(normalized.source, 'user-debt-execution')
  }
}

const normalizeDebtExecutionSyncQueue = (raw) => {
  const list = arrayFromPayload(raw)
  const normalized = list
    .map((item) => item && typeof item === 'object' ? item : null)
    .filter(Boolean)
    .map((item) => {
      const payload = debtExecutionRecordToPayload(item.payload || item)
      return {
        ...payload,
        // 读取旧队列时按当前报告作用域重新计算，迁移旧版无 scope 的 key。
        syncKey: syncKeyOf(payload),
        pending: item.pending !== false,
        syncStatus: item.syncStatus || item.queueStatus || 'failed',
        error: item.error ? String(item.error) : '',
        retryCount: Number.isFinite(Number(item.retryCount)) ? Math.max(0, Math.round(Number(item.retryCount))) : 0,
        lastAttemptAt: item.lastAttemptAt || '',
        updatedAt: item.updatedAt || payload.updatedAt
      }
    })
  const seen = new Set()
  return normalized.filter((item) => {
    if (seen.has(item.syncKey)) return false
    seen.add(item.syncKey)
    return true
  })
}

export function readDebtExecutionSyncQueue(api = storage()) {
  if (!api) return []
  try {
    return normalizeDebtExecutionSyncQueue(api.getStorageSync(DEBT_EXECUTION_SYNC_QUEUE_KEY))
  } catch (e) {
    return []
  }
}

export function saveDebtExecutionSyncQueue(queue = [], api = storage()) {
  const next = normalizeDebtExecutionSyncQueue(queue)
  if (api) {
    try { api.setStorageSync(DEBT_EXECUTION_SYNC_QUEUE_KEY, JSON.stringify(next)) } catch (e) {}
  }
  return next
}

export function enqueueDebtExecutionSync(record = {}, error = '', api = storage()) {
  const payload = debtExecutionRecordToPayload(record)
  const syncKey = syncKeyOf(payload)
  const queue = readDebtExecutionSyncQueue(api)
  const previous = queue.find((item) => item.syncKey === syncKey) || {}
  const next = {
    ...previous,
    ...payload,
    syncKey,
    pending: true,
    syncStatus: 'failed',
    error: error && (error.message || error.errMsg) ? String(error.message || error.errMsg) : String(error || '同步失败'),
    retryCount: (previous.retryCount || 0) + 1,
    lastAttemptAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
  const saved = queue.filter((item) => item.syncKey !== syncKey)
  saved.unshift(next)
  saveDebtExecutionSyncQueue(saved, api)
  return next
}

export function removeDebtExecutionSync(recordOrKey, api = storage()) {
  const key = typeof recordOrKey === 'string' ? recordOrKey : syncKeyOf(debtExecutionRecordToPayload(recordOrKey || {}))
  const next = readDebtExecutionSyncQueue(api).filter((item) => item.syncKey !== key)
  saveDebtExecutionSyncQueue(next, api)
  return next
}

export async function syncDebtExecutionRecord(record = {}, syncer, api = storage()) {
  const payload = debtExecutionRecordToPayload(record)
  if (!payload.id || typeof syncer !== 'function') return { ok: false, queued: false, payload }
  try {
    await syncer(payload)
    removeDebtExecutionSync(payload, api)
    return { ok: true, payload }
  } catch (e) {
    const queued = enqueueDebtExecutionSync(payload, e, api)
    return { ok: false, queued: true, payload: queued, error: e }
  }
}

export async function retryPendingDebtExecutionSync(syncer, api = storage(), options = {}) {
  const queue = readDebtExecutionSyncQueue(api)
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0 ? Math.round(Number(options.limit)) : queue.length
  let success = 0
  let failed = 0
  let skipped = 0
  for (const item of queue.slice(0, limit)) {
    const result = await syncDebtExecutionRecord(item, syncer, api)
    if (result.ok) success += 1
    else if (result.queued) failed += 1
    else skipped += 1
  }
  return { total: queue.length, attempted: Math.min(queue.length, limit), success, failed, skipped, remaining: readDebtExecutionSyncQueue(api).length }
}

export default {
  DEBT_EXECUTION_RECORD_KEY,
  DEBT_EXECUTION_SYNC_QUEUE_KEY,
  debtProofMaterialId,
  debtProofStatusText,
  normalizeDebtExecutionRecord,
  normalizeDebtExecutionRecordsPayload,
  readDebtExecutionRecords,
  saveDebtExecutionRecords,
  isDebtProofSuperseded,
  activeDebtExecutionRecords,
  supersededDebtProofRecords,
  debtExecutionRecordsToMaterials,
  collectDebtProofReviewsFromMaterials,
  collectDebtProofReviewsFromContactRecords,
  isReviewableDebtProofRecord,
  debtProofReviewAckReceipt,
  acknowledgeDebtProofReview,
  applyDebtProofReviews,
  syncDebtProofReviewsFromContacts,
  applyDebtExecutionCloudSnapshot,
  mergeDebtExecutionRecords,
  debtExecutionRecordToPayload,
  readDebtExecutionSyncQueue,
  saveDebtExecutionSyncQueue,
  enqueueDebtExecutionSync,
  removeDebtExecutionSync,
  syncDebtExecutionRecord,
  retryPendingDebtExecutionSync
}
