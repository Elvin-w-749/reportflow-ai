export const CONSULTATION_STATUS_KEY = 'rpt_user_last_consultation_status'
export const CONSULTATION_MATERIAL_SYNC_QUEUE_KEY = 'rpt_consultation_material_sync_queue'
export const CONSULTATION_STATUS_MAX_AGE = 7 * 24 * 60 * 60 * 1000

const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== '')
const toNumberOrEmpty = (value) => {
  if (value === undefined || value === null || value === '') return ''
  const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, '').replace('%', ''))
  return Number.isFinite(n) ? Math.round(n) : ''
}
const asArray = (...candidates) => {
  for (const value of candidates) {
    if (Array.isArray(value)) return value
    if (typeof value === 'string' && value.trim()) return value.split(/[、,，;；\n]/).map((item) => item.trim()).filter(Boolean)
  }
  return []
}
const materialStatusText = (item) => {
  const explicit = first(item.statusText, item.stateText, '')
  if (explicit) return explicit
  const status = String(first(item.status, item.state, item.uploadStatus, '')).toLowerCase()
  if (['uploaded', 'submitted', 'reviewing', 'pending_review'].includes(status)) return '待确认'
  if (['done', 'completed', 'confirmed', 'verified', 'approved'].includes(status)) return '已确认'
  if (['rejected', 'reject', 'reupload', 'need_reupload', 'invalid', 'failed'].includes(status)) return '需重传'
  if (['optional', 'unneeded', 'not_required', 'waived', 'none', 'skipped'].includes(status)) return '无需'
  return '待补充'
}
const normalizeMaterialItem = (value, index) => {
  if (typeof value === 'string') {
    const name = value.trim()
    return name ? { id: `material_${index}`, name, status: 'pending', statusText: '待补充' } : null
  }
  const item = value && typeof value === 'object' ? value : {}
  const name = first(item.name, item.title, item.label, item.materialName, item.documentName, item.type, '')
  if (!name) return null
  const statusText = materialStatusText(item)
  return {
    id: first(item.id, item.key, item.code, `material_${index}`),
    name,
    status: first(item.status, item.state, item.uploadStatus, statusText === '已确认' ? 'confirmed' : statusText === '需重传' ? 'rejected' : statusText === '无需' ? 'unneeded' : statusText === '待确认' ? 'uploaded' : 'pending'),
    statusText,
    note: first(item.note, item.desc, item.description, item.remark, ''),
    uploadUrl: first(item.uploadUrl, item.url, item.fileUrl, ''),
    fileName: first(item.fileName, item.nameOnDisk, item.uploadName, ''),
    fileSize: item.fileSize === undefined ? '' : item.fileSize,
    uploadedAt: first(item.uploadedAt, item.uploadTime, item.submittedAt, ''),
    reviewNote: first(item.reviewNote, item.rejectReason, item.reason, item.reviewRemark, ''),
    reviewedAt: first(item.reviewedAt, item.reviewTime, ''),
    required: item.required === undefined ? statusText !== '无需' : Boolean(item.required)
  }
}
const collectMaterials = (value = {}) => asArray(
  value.requiredMaterials,
  value.pendingMaterials,
  value.materials,
  value.materialChecklist,
  value.materialList,
  value.documents,
  value.product && value.product.requiredMaterials,
  value.product && value.product.materials,
  value.product && value.product.materialChecklist
).map(normalizeMaterialItem).filter(Boolean)
const storage = () => (typeof uni !== 'undefined' ? uni : null)

export function normalizeConsultationStatus(value, now = Date.now()) {
  if (!value || typeof value !== 'object') return null
  const createdAt = first(value.createdAt, value.createTime, value.time, '')
  const parsedCreated = createdAt ? Date.parse(createdAt) : 0
  const savedAt = Number(first(value.savedAt, parsedCreated || '', 0))
  if (savedAt && now - savedAt > CONSULTATION_STATUS_MAX_AGE) return null
  const productName = first(value.productName, value.product && value.product.name, '匹配方案')
  const reportTitle = first(value.reportTitle, value.report && (value.report.title || value.report.reportType), '信用报告')
  const reportScore = toNumberOrEmpty(first(value.reportScore, value.report && (value.report.scoreText || value.report.score), ''))
  const matchRate = toNumberOrEmpty(first(value.matchRate, value.product && value.product.matchRate, value.match && value.match.matchRate, ''))
  const materials = collectMaterials(value)
  return {
    id: String(first(value.id, value.contactId, `${first(value.reportId, value.report && value.report.id, 'report')}-${first(value.productId, value.product && value.product.id, productName)}`)),
    status: first(value.status, 'pending'),
    statusText: first(value.statusText, '待顾问处理'),
    productId: first(value.productId, value.product && value.product.id, ''),
    productName,
    institution: first(value.institution, value.product && value.product.institution, ''),
    matchRate,
    reportId: first(value.reportId, value.report && value.report.id, ''),
    reportTitle,
    reportScore,
    reportDate: first(value.reportDate, value.report && value.report.date, ''),
    summary: first(value.summary, `${productName} · ${matchRate !== '' ? `匹配度 ${matchRate}%` : '咨询进度'} · 基于 ${reportTitle}`),
    messageId: first(value.messageId, value.sourceMessageId, value.messageContext && value.messageContext.messageId, ''),
    sourceMessageId: first(value.sourceMessageId, value.messageId, value.messageContext && value.messageContext.messageId, ''),
    sourceMessageTitle: first(value.sourceMessageTitle, value.messageContext && value.messageContext.sourceTitle, ''),
    sourceMessageFocus: first(value.sourceMessageFocus, value.messageContext && value.messageContext.sourceFocus, ''),
    materials,
    createdAt,
    savedAt: savedAt || now
  }
}

export function buildConsultationStatus(payload = {}, response = {}) {
  const responseData = response && response.data ? response.data : response
  return normalizeConsultationStatus({
    id: first(responseData && responseData.contactId, responseData && responseData.id, `${payload.reportId || 'report'}-${payload.productId || payload.productName || 'product'}`),
    status: 'pending',
    statusText: '待顾问处理',
    productId: payload.productId,
    productName: payload.productName,
    institution: payload.institution,
    matchRate: payload.matchRate,
    reportId: payload.reportId,
    reportTitle: payload.reportTitle,
    reportScore: payload.reportScore,
    reportDate: payload.reportDate,
    summary: payload.summary,
    messageId: payload.messageId,
    sourceMessageId: payload.sourceMessageId,
    sourceMessageTitle: payload.sourceMessageTitle,
    sourceMessageFocus: payload.sourceMessageFocus,
    messageContext: payload.messageContext,
    materials: first(responseData && responseData.materials, responseData && responseData.requiredMaterials, payload.materials, payload.requiredMaterials, payload.pendingMaterials, payload.product && payload.product.requiredMaterials, ''),
    createdAt: payload.createdAt,
    savedAt: Date.now()
  })
}

export function saveLastConsultationStatus(payload = {}, response = {}) {
  const status = buildConsultationStatus(payload, response)
  const api = storage()
  if (api && status) {
    try { api.setStorageSync(CONSULTATION_STATUS_KEY, JSON.stringify(status)) } catch (e) {}
  }
  return status
}

export function readLastConsultationStatus() {
  const api = storage()
  if (!api) return null
  try {
    const raw = api.getStorageSync(CONSULTATION_STATUS_KEY)
    const parsed = typeof raw === 'string' ? JSON.parse(raw || 'null') : raw
    const status = normalizeConsultationStatus(parsed)
    if (!status && raw) {
      try { api.removeStorageSync(CONSULTATION_STATUS_KEY) } catch (e) {}
    }
    return status
  } catch (e) {
    return null
  }
}

const sameMaterial = (item, ref = {}) => {
  const refId = first(ref.id, ref.key, ref.code, '')
  const refName = first(ref.name, ref.title, ref.label, ref.materialName, '')
  return Boolean((refId && item.id === refId) || (refName && item.name === refName))
}

export function updateLastConsultationMaterial(materialRef = {}, patch = {}) {
  const api = storage()
  const current = readLastConsultationStatus()
  if (!api || !current || !Array.isArray(current.materials) || !current.materials.length) return null
  let changed = false
  const materials = current.materials.map((item) => {
    if (!sameMaterial(item, materialRef)) return item
    changed = true
    return normalizeMaterialItem({ ...item, ...patch }, 0)
  }).filter(Boolean)
  if (!changed) return null
  const next = normalizeConsultationStatus({
    ...current,
    status: first(patch.recordStatus, current.status, 'processing'),
    statusText: first(patch.recordStatusText, current.statusText, '材料待确认'),
    materials,
    savedAt: Date.now()
  })
  try { api.setStorageSync(CONSULTATION_STATUS_KEY, JSON.stringify(next)) } catch (e) {}
  return next
}

export function markLastConsultationMaterialUploaded(materialRef = {}, fileMeta = {}) {
  return updateLastConsultationMaterial(materialRef, {
    status: 'uploaded',
    statusText: '待确认',
    uploadUrl: first(fileMeta.url, fileMeta.uploadUrl, fileMeta.fileUrl, ''),
    fileName: first(fileMeta.name, fileMeta.fileName, ''),
    fileSize: fileMeta.size === undefined ? '' : fileMeta.size,
    uploadedAt: first(fileMeta.uploadedAt, new Date().toISOString()),
    recordStatus: 'processing',
    recordStatusText: '材料待确认'
  })
}

export function markLastConsultationMaterialReviewed(materialRef = {}, review = {}) {
  const status = first(review.status, review.reviewStatus, '')
  const statusText = materialStatusText({ status, statusText: review.statusText, stateText: review.stateText })
  const recordTextMap = { '已确认': '材料已确认', '需重传': '材料需重传', '无需': '材料无需补充', '待确认': '材料待确认' }
  return updateLastConsultationMaterial(materialRef, {
    status: first(status, statusText === '已确认' ? 'confirmed' : statusText === '需重传' ? 'rejected' : statusText === '无需' ? 'unneeded' : 'reviewing'),
    statusText,
    reviewNote: first(review.reviewNote, review.rejectReason, review.reason, review.note, ''),
    reviewedAt: first(review.reviewedAt, review.reviewTime, new Date().toISOString()),
    recordStatus: statusText === '需重传' ? 'need_info' : 'processing',
    recordStatusText: recordTextMap[statusText] || '材料待确认'
  })
}

const countMaterialsByStatus = (materials = []) => materials.reduce((acc, item) => {
  const text = item.statusText || materialStatusText(item)
  acc.total += 1
  if (text === '待补充') acc.pending += 1
  else if (text === '需重传') acc.reupload += 1
  else if (text === '待确认') acc.reviewing += 1
  else if (text === '已确认') acc.confirmed += 1
  else if (text === '无需') acc.unneeded += 1
  return acc
}, { total: 0, pending: 0, reupload: 0, reviewing: 0, confirmed: 0, unneeded: 0 })

const formatProgressTime = (raw) => {
  if (!raw) return ''
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return String(raw).slice(0, 16)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const materialNames = (materials = []) => materials.slice(0, 3).map((item) => item.name).filter(Boolean).join('、')
const hashString = (value = '') => Array.from(String(value)).reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0)

const parseStored = (raw, fallback = null) => {
  if (raw == null || raw === '') return fallback
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch (e) { return fallback }
  }
  return raw
}
const cleanContactId = (value) => String(value || '').replace(/^local_/, '')

const normalizeMaterialSubmitPayload = (payload = {}) => {
  const uploadedAt = first(payload.uploadedAt, payload.updatedAt, new Date().toISOString())
  const contactId = cleanContactId(first(payload.contactId, payload.statusId, payload.sourceId, payload.id, ''))
  return {
    contactId,
    materialId: first(payload.materialId, payload.id, payload.key, payload.code, ''),
    materialName: first(payload.materialName, payload.name, payload.title, payload.label, ''),
    status: first(payload.status, 'uploaded'),
    statusText: first(payload.statusText, '待确认'),
    uploadUrl: first(payload.uploadUrl, payload.url, payload.fileUrl, ''),
    fileName: first(payload.fileName, payload.nameOnDisk, payload.uploadName, ''),
    fileSize: payload.fileSize === undefined ? '' : payload.fileSize,
    uploadedAt,
    reportId: first(payload.reportId, ''),
    reportTitle: first(payload.reportTitle, ''),
    reportScore: first(payload.reportScore, ''),
    productName: first(payload.productName, ''),
    institution: first(payload.institution, ''),
    matchRate: first(payload.matchRate, ''),
    messageId: first(payload.messageId, ''),
    receiptStage: first(payload.receiptStage, 'handled'),
    source: first(payload.source, 'user-advisor-material'),
    updatedAt: uploadedAt
  }
}

export function buildAdvisorMaterialSubmitPayload(record = {}, material = {}, fileMeta = {}, meta = {}) {
  return normalizeMaterialSubmitPayload({
    contactId: first(meta.contactId, record.statusId, record.contactId, record.sourceId, record.id, ''),
    materialId: first(material.id, material.key, material.code, ''),
    materialName: first(material.name, material.title, material.label, material.materialName, ''),
    status: 'uploaded',
    statusText: '待确认',
    uploadUrl: first(fileMeta.url, fileMeta.uploadUrl, fileMeta.fileUrl, material.uploadUrl, ''),
    fileName: first(fileMeta.name, fileMeta.fileName, material.fileName, ''),
    fileSize: fileMeta.size === undefined ? first(material.fileSize, '') : fileMeta.size,
    uploadedAt: first(fileMeta.uploadedAt, material.uploadedAt, new Date().toISOString()),
    reportId: first(meta.reportId, record.reportId, ''),
    reportTitle: first(record.reportTitle, ''),
    reportScore: first(record.reportScore, ''),
    productName: first(record.productName, ''),
    institution: first(record.institution, ''),
    matchRate: first(record.matchRate, ''),
    messageId: first(meta.messageId, ''),
    receiptStage: first(meta.receiptStage, 'handled')
  })
}

const materialSyncKeyOf = (payload = {}) => [
  cleanContactId(payload.contactId),
  payload.materialId || payload.materialName || '',
  payload.uploadUrl || payload.uploadedAt || ''
].join('|')

const normalizeMaterialSyncQueue = (raw) => {
  const parsed = parseStored(raw, [])
  const list = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? Object.values(parsed) : [])
  return list
    .map((item) => item && typeof item === 'object' ? item : null)
    .filter(Boolean)
    .map((item) => {
      const payload = normalizeMaterialSubmitPayload(item.payload || item)
      return {
        ...payload,
        syncKey: item.syncKey || materialSyncKeyOf(payload),
        pending: item.pending !== false,
        status: item.status || 'failed',
        error: item.error ? String(item.error) : '',
        retryCount: Number.isFinite(Number(item.retryCount)) ? Math.max(0, Math.round(Number(item.retryCount))) : 0,
        updatedAt: item.updatedAt || payload.updatedAt
      }
    })
}

export function readConsultationMaterialSyncQueue(api = storage()) {
  if (!api) return []
  try {
    return normalizeMaterialSyncQueue(api.getStorageSync(CONSULTATION_MATERIAL_SYNC_QUEUE_KEY))
  } catch (e) {
    return []
  }
}

export function saveConsultationMaterialSyncQueue(queue = [], api = storage()) {
  const next = normalizeMaterialSyncQueue(queue)
  if (api) {
    try { api.setStorageSync(CONSULTATION_MATERIAL_SYNC_QUEUE_KEY, JSON.stringify(next)) } catch (e) {}
  }
  return next
}

export function enqueueConsultationMaterialSync(payload = {}, error = '', api = storage()) {
  const normalized = normalizeMaterialSubmitPayload(payload)
  const syncKey = materialSyncKeyOf(normalized)
  const queue = readConsultationMaterialSyncQueue(api)
  const previous = queue.find((item) => item.syncKey === syncKey) || {}
  const next = {
    ...previous,
    ...normalized,
    syncKey,
    pending: true,
    status: 'failed',
    error: error && (error.message || error.errMsg) ? String(error.message || error.errMsg) : String(error || '同步失败'),
    retryCount: (previous.retryCount || 0) + 1,
    updatedAt: new Date().toISOString()
  }
  const saved = queue.filter((item) => item.syncKey !== syncKey)
  saved.unshift(next)
  saveConsultationMaterialSyncQueue(saved, api)
  return next
}

export function removeConsultationMaterialSync(payloadOrKey, api = storage()) {
  const key = typeof payloadOrKey === 'string' ? payloadOrKey : materialSyncKeyOf(payloadOrKey || {})
  const next = readConsultationMaterialSyncQueue(api).filter((item) => item.syncKey !== key)
  saveConsultationMaterialSyncQueue(next, api)
  return next
}

export async function syncConsultationMaterialSubmit(payload = {}, submitter, api = storage()) {
  const normalized = normalizeMaterialSubmitPayload(payload)
  if (!normalized.contactId || typeof submitter !== 'function') return { ok: false, queued: false, payload: normalized }
  try {
    await submitter(normalized.contactId, normalized)
    removeConsultationMaterialSync(normalized, api)
    return { ok: true, payload: normalized }
  } catch (e) {
    const queued = enqueueConsultationMaterialSync(normalized, e, api)
    return { ok: false, queued: true, payload: queued, error: e }
  }
}
export async function retryPendingConsultationMaterialSync(submitter, api = storage(), options = {}) {
  const queue = readConsultationMaterialSyncQueue(api)
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0 ? Math.round(Number(options.limit)) : queue.length
  let success = 0
  let failed = 0
  let skipped = 0
  for (const item of queue.slice(0, limit)) {
    const result = await syncConsultationMaterialSubmit(item, submitter, api)
    if (result.ok) success += 1
    else if (result.queued) failed += 1
    else skipped += 1
  }
  return { total: queue.length, attempted: Math.min(queue.length, limit), success, failed, skipped, remaining: readConsultationMaterialSyncQueue(api).length }
}
export function buildConsultationProgress(statusValue) {
  const status = normalizeConsultationStatus(statusValue, 0)
  if (!status) return null
  const materials = Array.isArray(status.materials) ? status.materials : []
  const stats = countMaterialsByStatus(materials)
  const reuploadItems = materials.filter((item) => item.statusText === '需重传')
  const pendingItems = materials.filter((item) => item.statusText === '待补充')
  const reviewingItems = materials.filter((item) => item.statusText === '待确认')
  const doneItems = materials.filter((item) => ['已确认', '无需'].includes(item.statusText))
  const timeline = [
    {
      key: 'submitted',
      state: 'done',
      title: '已提交咨询',
      desc: `${status.productName || '匹配方案'} · 基于 ${status.reportTitle || '信用报告'}`,
      time: formatProgressTime(status.createdAt)
    }
  ]
  if (stats.total) {
    if (reuploadItems.length) {
      timeline.push({ key: 'material-reupload', state: 'action', title: '材料需重传', desc: `请重新上传${materialNames(reuploadItems)}，顾问会重新复核。`, time: formatProgressTime(reuploadItems[0].reviewedAt) })
    } else if (pendingItems.length) {
      timeline.push({ key: 'material-pending', state: 'action', title: '待补充材料', desc: `请补充${materialNames(pendingItems)}，补齐后继续确认方案。`, time: '' })
    } else if (reviewingItems.length) {
      timeline.push({ key: 'material-reviewing', state: 'current', title: '材料待确认', desc: `${materialNames(reviewingItems)} 已提交，等待顾问复核。`, time: formatProgressTime(reviewingItems[0].uploadedAt) })
    } else if (doneItems.length === stats.total) {
      timeline.push({ key: 'material-done', state: 'done', title: '材料已确认', desc: '当前材料已复核完成，可继续等待顾问方案。', time: formatProgressTime(doneItems[0].reviewedAt || doneItems[0].uploadedAt) })
    }
  }
  if (status.status === 'completed' || status.status === 'done') {
    timeline.push({ key: 'completed', state: 'done', title: '咨询已完成', desc: '可继续查看报告或发起新的咨询。', time: '' })
  } else {
    timeline.push({ key: 'advisor-processing', state: stats.reupload || stats.pending ? 'pending' : 'current', title: stats.reupload || stats.pending ? '等待补齐后处理' : '顾问处理中', desc: stats.reupload || stats.pending ? '材料补齐后顾问会继续跟进。' : '顾问会结合信用报告与匹配方案给出下一步建议。', time: '' })
  }
  const alert = stats.reupload
    ? { level: 'danger', title: '有材料需要重传', text: `请重新上传${materialNames(reuploadItems)}。` }
    : stats.pending
      ? { level: 'warning', title: '还有材料待补充', text: `请补充${materialNames(pendingItems)}。` }
      : stats.reviewing
        ? { level: 'info', title: '材料等待顾问确认', text: '提交的材料正在复核中。' }
        : stats.total && doneItems.length === stats.total
          ? { level: 'success', title: '材料已复核', text: '当前材料无需继续补充。' }
          : { level: 'info', title: status.statusText || '待顾问处理', text: '顾问会结合报告继续处理。' }
  return { materialStats: stats, timeline, alert }
}

const latestMaterialTime = (materials = []) => materials.reduce((latest, item) => {
  const raw = first(item.reviewedAt, item.uploadedAt, item.submittedAt, '')
  const ts = raw ? Date.parse(raw) : 0
  return Number.isFinite(ts) && ts > latest ? ts : latest
}, 0)

export function consultationStatusToMessage(statusValue, index = 0) {
  const status = normalizeConsultationStatus(statusValue, 0)
  if (!status) return null
  const progress = buildConsultationProgress(status)
  if (!progress || !progress.alert) return null
  const materialTs = latestMaterialTime(status.materials)
  const createdTs = status.createdAt ? Date.parse(status.createdAt) : 0
  const eventTs = materialTs || (Number.isFinite(createdTs) ? createdTs : 0) || status.savedAt || Date.now()
  const messageKey = [status.id, progress.alert.level, status.statusText, status.materials.map((item) => `${item.id || item.name}:${item.statusText}:${item.reviewedAt || item.uploadedAt || ''}`).join(',')].join('|')
  const suffix = [status.productName, status.reportTitle ? `基于${status.reportTitle}` : ''].filter(Boolean).join(' · ')
  const id = `consult_${index}_${Math.abs(hashString(messageKey))}`
  const focus = ['danger', 'warning'].includes(progress.alert.level) ? 'materials' : 'progress'
  const params = [
    'from=message',
    `messageId=${encodeURIComponent(id)}`,
    `statusId=${encodeURIComponent(status.id || '')}`,
    `reportId=${encodeURIComponent(status.reportId || '')}`,
    `focus=${focus}`
  ]
  return {
    id,
    local: true,
    category: 'consultation',
    level: progress.alert.level,
    title: progress.alert.title,
    content: suffix ? `${progress.alert.text} ${suffix}` : progress.alert.text,
    createdAt: eventTs,
    time: eventTs,
    read: false,
    actionText: focus === 'materials' ? '去处理' : '查看进度',
    actionUrl: `/pages/profile/advisor?${params.join('&')}`,
    reportId: status.reportId,
    statusId: status.id,
    focus,
    progress
  }
}

export function consultationStatusToContactRecord(statusValue) {
  const status = normalizeConsultationStatus(statusValue, 0)
  if (!status) return null
  return {
    id: `local_${status.id}`,
    source: 'local-consultation-status',
    contactType: 'match-product',
    status: status.status,
    statusText: status.statusText,
    time: status.createdAt,
    createdAt: status.createdAt,
    summary: status.summary,
    reportId: status.reportId,
    reportTitle: status.reportTitle,
    reportScore: status.reportScore,
    reportDate: status.reportDate,
    productId: status.productId,
    productName: status.productName,
    institution: status.institution,
    matchRate: status.matchRate,
    materials: status.materials,
    context: {
      report: { id: status.reportId, title: status.reportTitle, scoreText: status.reportScore, date: status.reportDate },
      product: { id: status.productId, name: status.productName, institution: status.institution, matchRate: status.matchRate, materials: status.materials },
      sourceMessage: { id: status.messageId, title: status.sourceMessageTitle, focus: status.sourceMessageFocus },
      materials: status.materials,
      requiredMaterials: status.materials,
      match: { matchRate: status.matchRate }
    }
  }
}

export default {
  CONSULTATION_STATUS_KEY,
  CONSULTATION_MATERIAL_SYNC_QUEUE_KEY,
  CONSULTATION_STATUS_MAX_AGE,
  normalizeConsultationStatus,
  buildConsultationStatus,
  saveLastConsultationStatus,
  readLastConsultationStatus,
  updateLastConsultationMaterial,
  markLastConsultationMaterialUploaded,
  markLastConsultationMaterialReviewed,
  buildAdvisorMaterialSubmitPayload,
  readConsultationMaterialSyncQueue,
  saveConsultationMaterialSyncQueue,
  enqueueConsultationMaterialSync,
  removeConsultationMaterialSync,
  syncConsultationMaterialSubmit,
  retryPendingConsultationMaterialSync,
  buildConsultationProgress,
  consultationStatusToMessage,
  consultationStatusToContactRecord
}
