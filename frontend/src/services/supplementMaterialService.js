import { enrichAnalysisWithFinancialProfile } from './financialProfile.js'
import { request } from './apiClient.js'
import { getUserId } from './authService.js'
import { getLatestReport } from './reportStorage.js'

export const SUPPLEMENT_MATERIAL_KEY = 'rpt_supplement_materials_v1'

export const SUPPLEMENT_MATERIAL_TYPES = [
  {
    key: 'education',
    group: '基础信息',
    title: '学历信息',
    desc: '客户自填，用于辅助判断部分信用卡和消费类产品',
    icon: '学',
    inputOnly: true,
    guide: {
      focus: '学历不要求上传证书，客户如实选择即可；它只作为辅助信号，不替代征信、收入和资产判断。',
      findPath: '在下方选择当前最高学历，后续如需人工复核再补充证明。',
      examples: ['本科', '大专', '硕士及以上']
    }
  },
  {
    key: 'social_security',
    group: '三金账单',
    title: '社保账单',
    desc: '连续缴纳月份、单位稳定性',
    icon: '社',
    guide: {
      focus: '看最近 6-12 个月是否连续缴纳、单位是否稳定、缴费基数是否与收入相匹配。',
      findPath: '可在随申办、人社或社保服务渠道查询个人缴费记录，截图需包含姓名、月份、缴费单位和缴费基数。',
      examples: ['近 12 个月缴费明细', '个人权益记录单', '单位缴纳明细截图']
    }
  },
  {
    key: 'housing_fund',
    group: '三金账单',
    title: '公积金账单',
    desc: '缴存基数、连续月份',
    icon: '金',
    guide: {
      focus: '看缴存基数、月缴额、连续月数和单位名称，公积金连续性通常能反映受薪稳定度。',
      findPath: '可在随申办、公积金官方渠道查询个人账户明细，截图需包含姓名、单位、月份和缴存金额。',
      examples: ['公积金缴存明细', '个人账户信息页', '近 12 个月缴存记录']
    }
  },
  {
    key: 'payroll',
    group: '三金账单',
    title: '工资流水',
    desc: '近 6-12 个月收入稳定性',
    icon: '流',
    guide: {
      focus: '看近 6-12 个月工资入账是否稳定、发薪单位是否一致、金额波动是否异常。',
      findPath: '可在工资卡银行 APP 导出或截图流水，优先保留工资摘要、交易对手、入账金额和月份。',
      examples: ['工资卡近 12 个月流水', '工资入账筛选截图', '银行电子流水 PDF']
    }
  },
  {
    key: 'tax',
    group: '个税材料',
    title: '个税记录',
    desc: '一年收入纳税明细、单位稳定性',
    icon: '税',
    guide: {
      focus: '看 12 个月收入纳税明细、年度收入、扣缴义务人数量、同一单位连续月份和是否换工作。',
      findPath: '打开个人所得税 APP，进入收入纳税明细查询或纳税记录开具，选择近一年月份后截图或导出 PDF；只截“收入合计”无法判断月收入。',
      examples: ['近 12 个月收入纳税明细', '逐月工资薪金收入截图', '纳税记录 PDF（含完整月份）'],
      sourceTitle: '国家税务总局：收入纳税明细查询/纳税记录开具',
      sourceUrl: 'https://etax.chinatax.gov.cn/webstatic/'
    }
  },
  {
    key: 'property',
    group: '资产材料',
    title: '房产材料',
    desc: '产调、产权和抵押信息',
    icon: '房',
    guide: {
      focus: '看产权人、坐落、面积、抵押/查封/共有情况。上海产调或房屋查询结果通常是 3-4 页，需页面完整。',
      findPath: '可在上海一网通办/随申办的“我的不动产”或“开具本市房屋查询结果证明”获取。',
      examples: ['本市房屋查询结果证明', '我的不动产查询结果', '不动产登记簿/产调 PDF'],
      sourceTitle: '上海一网通办：不动产登记全网通',
      sourceUrl: 'https://zwdt.sh.gov.cn/govPortals/column/bdc/index.html'
    }
  },
  {
    key: 'vehicle',
    group: '资产材料',
    title: '车辆材料',
    desc: '行驶证、登记证书和车辆状态',
    icon: '车',
    guide: {
      focus: '看机动车所有人、车辆识别代号、使用性质、登记状态和是否抵押。车辆价值只能作辅助资产信号。',
      findPath: '可上传纸质行驶证照片，或在交管 12123 申领/出示电子行驶证后截图。',
      examples: ['机动车行驶证', '机动车登记证书', '交管 12123 电子行驶证截图'],
      sourceTitle: '公安部：机动车登记规定',
      sourceUrl: 'https://www.mps.gov.cn/n6557558/c8281750/content.html'
    }
  },
  {
    key: 'business_operation',
    group: '经营材料',
    title: '经营流水/商户材料',
    desc: '经营收入、收款稳定性和真实经营',
    icon: '营',
    guide: {
      focus: '看营业或经营主体、收款流水、经营年限、月均流水和用途是否合规，主要用于商户/经营类产品。',
      findPath: '可上传营业执照、收款码流水、对公/经营账户流水或平台经营后台截图。',
      examples: ['营业执照', '近 6-12 个月收款流水', '门店/平台经营后台截图']
    }
  }
]

const nowIso = () => new Date().toISOString()
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))
const num = (value, fallback = 0) => {
  const n = typeof value === 'number' ? value : Number(String(value == null ? '' : value).replace(/,/g, '').replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? n : fallback
}
const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== '')
const EDUCATION_SCORE = {
  doctorate: 5,
  master: 4,
  bachelor: 3,
  college: 2,
  high_school: 1,
  other: 0,
  unknown: 0
}
const storage = () => (typeof uni !== 'undefined' ? uni : null)
export const deriveSupplementMaterialScope = (report = null, explicit = {}) => {
  const source = explicit && typeof explicit === 'object' ? explicit : {}
  const row = report && typeof report === 'object' ? report : {}
  const cloudReportId = String(first(
    source.cloudReportId,
    row.cloudReportId,
    row.serverReportId,
    row.syncMeta && row.syncMeta.cloudReportId,
    ''
  ) || '').trim()
  const localReportId = String(first(source.localReportId, source.clientReportId, row.clientReportId, row.localReportId, row.id, '') || '').trim()
  const reportId = String(first(source.reportId, cloudReportId, row.reportId, row.id, '') || '').trim()
  const caseId = String(first(source.caseId, cloudReportId, row.caseId, reportId, '') || '').trim()
  const caseAliases = [localReportId, row.caseId]
    .map((value) => String(value || '').trim())
    .filter((value, index, values) => value && value !== caseId && values.indexOf(value) === index)
  return { caseId, reportId, caseAliases }
}

export const resolveSupplementMaterialScope = (scope = {}) => {
  const explicit = typeof scope === 'string' ? { caseId: scope } : (scope || {})
  const hasExplicit = !!(explicit.caseId || explicit.reportId || explicit.cloudReportId)
  let report = null
  if (!hasExplicit && explicit.useActiveReport !== false) {
    try { report = getLatestReport() } catch (_) {}
  }
  return deriveSupplementMaterialScope(report, explicit)
}

const normalizedScopeToken = (value) => String(value || '').trim()
const scopeTokens = (scope = {}) => {
  const resolved = scope && typeof scope === 'object' && Array.isArray(scope.caseAliases)
    ? scope
    : resolveSupplementMaterialScope(scope)
  return [
    resolved.caseId,
    resolved.reportId,
    resolved.clientReportId,
    ...(Array.isArray(resolved.caseAliases) ? resolved.caseAliases : [])
  ].map(normalizedScopeToken).filter(Boolean)
}

export const supplementMaterialScopesOverlap = (left = {}, right = {}) => {
  const leftTokens = new Set(scopeTokens(left))
  return scopeTokens(right).some((value) => leftTokens.has(value))
}

export const materialStorageKey = (scope = {}) => {
  const uid = String(getUserId() || '').trim()
  const { caseId } = resolveSupplementMaterialScope(scope)
  const base = uid ? `${SUPPLEMENT_MATERIAL_KEY}:${uid}` : SUPPLEMENT_MATERIAL_KEY
  return caseId ? `${base}:case:${encodeURIComponent(caseId)}` : base
}
const fileTypeFromMime = (mimeType) => {
  const text = String(mimeType || '')
  if (/^image\//i.test(text)) return 'image'
  if (/pdf/i.test(text)) return 'pdf'
  return ''
}
const attachmentHasFile = (item = {}) =>
  !!(item && (item.fileUrl || item.uploadUrl || item.url || item.localFilePath || item.localPath || item.tempFilePath || item.fileName || item.nameOnDisk || item.uploadName))
const normalizeRemoteFileReference = (value = '') => {
  const text = String(value || '').trim()
  if (!text || /\s/.test(text)) return ''
  if (/^https?:\/\/[^/]/i.test(text)) return text
  if (/^\/\/[^/]/.test(text)) return text
  if (/^\/(?!\/)/.test(text)) return text
  return ''
}
const firstRemoteFileReference = (...values) => {
  for (const value of values) {
    const normalized = normalizeRemoteFileReference(value)
    if (normalized) return normalized
  }
  return ''
}
const attachmentHasRemoteFile = (item = {}) =>
  !!(item && firstRemoteFileReference(item.fileUrl, item.uploadUrl, item.url))
const attachmentKey = (item = {}, index = 0) =>
  String(first(item.fileUrl, item.uploadUrl, item.url, item.localFilePath, item.localPath, item.tempFilePath, item.id, item.attachmentId, item.fileName ? `${item.fileName}:${item.fileSize || ''}` : '', `attachment_${index}`))
const dedupeAttachments = (attachments = []) => {
  const seen = new Set()
  const out = []
  ;(Array.isArray(attachments) ? attachments : []).forEach((item, index) => {
    const normalized = normalizeSupplementAttachment(item, index)
    if (!attachmentHasFile(normalized)) return
    const key = attachmentKey(normalized, index)
    if (seen.has(key)) return
    seen.add(key)
    out.push(normalized)
  })
  return out
}

export function normalizeSupplementAttachment(raw = {}, index = 0) {
  const uploadedAt = first(raw.uploadedAt, raw.updatedAt, raw.createdAt, nowIso())
  const mimeType = first(raw.mimeType, raw.contentType, /^image|application/i.test(String(raw.type || '')) ? raw.type : '')
  const fileUrl = first(raw.fileUrl, raw.uploadUrl, raw.url, '')
  const uploadUrl = first(raw.uploadUrl, raw.fileUrl, raw.url, '')
  const localFilePath = first(raw.localFilePath, raw.localPath, raw.tempFilePath, '')
  const fileName = first(raw.fileName, raw.nameOnDisk, raw.uploadName, raw.name, '')
  const id = first(raw.id, raw.attachmentId, fileUrl, uploadUrl, localFilePath, fileName ? `${fileName}_${raw.fileSize || index}` : `${uploadedAt}_${index}`)
  return {
    id: String(id),
    attachmentId: String(id),
    fileUrl,
    uploadUrl,
    localFilePath,
    fileName,
    fileSize: raw.fileSize === undefined ? '' : raw.fileSize,
    fileType: first(raw.fileType, raw.typeOfFile, fileTypeFromMime(mimeType)),
    mimeType,
    uploadError: first(raw.uploadError, raw.errMsg, ''),
    ocrText: first(raw.ocrText, ''),
    ocrConfidence: first(raw.ocrConfidence, ''),
    detectedSummary: first(raw.detectedSummary, ''),
    ocrError: first(raw.ocrError, ''),
    uploadedAt,
    createdAt: first(raw.createdAt, uploadedAt),
    updatedAt: first(raw.updatedAt, uploadedAt)
  }
}

const normalizeSupplementAttachments = (raw = {}) => {
  const list = Array.isArray(raw.attachments) ? raw.attachments : []
  const legacy = attachmentHasFile(raw) ? [raw] : []
  return dedupeAttachments([...list, ...legacy])
}

export function materialTypeMeta(type) {
  return SUPPLEMENT_MATERIAL_TYPES.find((item) => item.key === type) || {
    key: type || 'other',
    group: '补充材料',
    title: '补充材料',
    desc: '用于进一步核实资质',
    icon: '材'
  }
}

export function normalizeSupplementMaterial(raw = {}, scope = {}) {
  const type = first(raw.type, raw.materialType, raw.key, 'other')
  const meta = materialTypeMeta(type)
  const materialScope = resolveSupplementMaterialScope({
    ...scope,
    caseId: first(raw.caseId, scope && scope.caseId, ''),
    reportId: first(raw.reportId, scope && scope.reportId, ''),
    cloudReportId: first(raw.cloudReportId, scope && scope.cloudReportId, '')
  })
  const uploadedAt = first(raw.uploadedAt, raw.updatedAt, raw.createdAt, nowIso())
  const id = first(raw.id, raw.materialId, `${type}_${uploadedAt}`)
  const unavailable = raw.unavailable === true || raw.hasMaterial === false || raw.noMaterial === true || raw.status === 'unavailable'
  const attachments = unavailable ? [] : normalizeSupplementAttachments(raw)
  const primaryAttachment = attachments[0] || {}
  const hasUpload = attachments.some(attachmentHasFile) || raw.fileUrl || raw.uploadUrl || raw.url || raw.localFilePath
  return {
    id: String(id),
    materialId: String(id),
    type,
    materialType: type,
    name: first(raw.name, raw.materialName, meta.title),
    materialName: first(raw.materialName, raw.name, meta.title),
    caseId: materialScope.caseId,
    reportId: materialScope.reportId,
    group: first(raw.group, meta.group),
    status: unavailable ? 'unavailable' : first(raw.status, hasUpload ? 'uploaded' : 'draft'),
    statusText: unavailable ? '暂无' : first(raw.statusText, hasUpload ? '待确认' : '待上传'),
    unavailable,
    months: clamp(Math.round(num(raw.months, 0)), 0, 360),
    sameEmployerMonths: clamp(Math.round(num(raw.sameEmployerMonths, 0)), 0, 360),
    employerCount: clamp(Math.round(num(raw.employerCount, 0)), 0, 60),
    monthlyIncome: Math.max(0, num(raw.monthlyIncome, 0)),
    annualTaxableIncome: Math.max(0, num(raw.annualTaxableIncome, raw.taxAnnualIncome || 0)),
    declaredValue: Math.max(0, num(raw.declaredValue, raw.assetValue || 0)),
    companyName: first(raw.companyName, raw.employerName, raw.unitName, ''),
    educationLevel: first(raw.educationLevel, raw.education, ''),
    note: first(raw.note, raw.remark, ''),
    fileUrl: first(primaryAttachment.fileUrl, raw.fileUrl, raw.uploadUrl, raw.url, ''),
    uploadUrl: first(primaryAttachment.uploadUrl, raw.uploadUrl, raw.fileUrl, raw.url, ''),
    localFilePath: first(primaryAttachment.localFilePath, raw.localFilePath, raw.localPath, raw.tempFilePath, ''),
    fileName: first(primaryAttachment.fileName, raw.fileName, raw.nameOnDisk, raw.uploadName, ''),
    fileSize: first(primaryAttachment.fileSize, raw.fileSize === undefined ? '' : raw.fileSize),
    fileType: first(primaryAttachment.fileType, raw.fileType, raw.typeOfFile, fileTypeFromMime(raw.mimeType)),
    mimeType: first(primaryAttachment.mimeType, raw.mimeType, raw.contentType, ''),
    uploadError: first(raw.uploadError, raw.errMsg, ''),
    attachments,
    attachmentCount: attachments.length,
    uploadedAt,
    updatedAt: first(raw.updatedAt, uploadedAt),
    source: first(raw.source, 'supplement-material')
  }
}

export function sanitizeSupplementMaterialRemotePayload(record = {}, scope = {}) {
  const material = normalizeSupplementMaterial(record, scope)
  const attachments = (Array.isArray(material.attachments) ? material.attachments : [])
    .filter(attachmentHasRemoteFile)
    .map((item) => {
      const { localFilePath, localPath, tempFilePath, ...remoteAttachment } = item
      return remoteAttachment
    })
  const { localFilePath, localPath, tempFilePath, ...remoteMaterial } = material
  const hasRemoteUpload = attachmentHasRemoteFile(remoteMaterial) || attachments.some(attachmentHasRemoteFile)
  const status = String(remoteMaterial.status || '').trim().toLowerCase()
  const localOnlyUpload = !hasRemoteUpload && (
    !!localFilePath
    || (Array.isArray(material.attachments) && material.attachments.some((item) => !!(item && item.localFilePath)))
    || ['uploaded', 'reviewing', 'submitted', 'queued', 'pending_sync', 'pending-sync', 'upload-error'].includes(status)
  )
  return {
    ...remoteMaterial,
    status: localOnlyUpload ? 'queued' : remoteMaterial.status,
    statusText: localOnlyUpload ? '本机已保存' : remoteMaterial.statusText,
    fileUrl: firstRemoteFileReference(remoteMaterial.fileUrl, remoteMaterial.uploadUrl),
    uploadUrl: firstRemoteFileReference(remoteMaterial.uploadUrl, remoteMaterial.fileUrl),
    attachments,
    attachmentCount: attachments.length
  }
}

export function readSupplementMaterials(scope = {}) {
  const api = storage()
  if (!api) return []
  try {
    const resolvedScope = resolveSupplementMaterialScope(scope)
    const key = materialStorageKey(resolvedScope)
    let raw = api.getStorageSync(key)
    // 同一报告由本地 ID 升级为云端 ID 时搬迁原 case，不把无 case 的历史资料带进来。
    if (!raw && resolvedScope.caseId && Array.isArray(resolvedScope.caseAliases)) {
      for (const alias of resolvedScope.caseAliases) {
        raw = api.getStorageSync(materialStorageKey({ caseId: alias, reportId: alias }))
        if (raw) {
          const aliasList = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw ? JSON.parse(raw) : [])
          const migrated = aliasList.map((item) => normalizeSupplementMaterial({
            ...item,
            caseId: resolvedScope.caseId,
            reportId: resolvedScope.reportId
          }, resolvedScope))
          api.setStorageSync(key, migrated)
          raw = migrated
          break
        }
      }
    }
    // 仅 legacy（没有 caseId）允许读取历史无 UID 数据；新 case 绝不带入旧资料。
    if (!resolvedScope.caseId && !raw && key !== SUPPLEMENT_MATERIAL_KEY) raw = api.getStorageSync(SUPPLEMENT_MATERIAL_KEY)
    const list = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw ? JSON.parse(raw) : [])
    return list.map((item) => normalizeSupplementMaterial(item, resolvedScope)).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
  } catch {
    return []
  }
}

export function saveSupplementMaterials(materials = [], scope = {}) {
  const api = storage()
  const firstMaterial = Array.isArray(materials) && materials.length ? materials[0] : {}
  const resolvedScope = resolveSupplementMaterialScope({
    ...scope,
    caseId: first(scope && scope.caseId, firstMaterial && firstMaterial.caseId, ''),
    reportId: first(scope && scope.reportId, firstMaterial && firstMaterial.reportId, '')
  })
  const list = (Array.isArray(materials) ? materials : []).map((item) => normalizeSupplementMaterial(item, resolvedScope))
  if (api) api.setStorageSync(materialStorageKey(resolvedScope), list)
  return list
}

export function upsertSupplementMaterial(record = {}, scope = {}) {
  const resolvedScope = resolveSupplementMaterialScope({
    ...scope,
    caseId: first(record.caseId, scope && scope.caseId, ''),
    reportId: first(record.reportId, scope && scope.reportId, '')
  })
  const normalized = normalizeSupplementMaterial(record, resolvedScope)
  const list = readSupplementMaterials(resolvedScope)
  const idx = list.findIndex((item) => item.id === normalized.id || item.type === normalized.type)
  if (idx >= 0) {
    const attachments = normalized.unavailable
      ? []
      : dedupeAttachments([...(normalized.attachments || []), ...(list[idx].attachments || [])])
    list[idx] = normalizeSupplementMaterial({
      ...list[idx],
      ...normalized,
      attachments,
      fileUrl: attachments[0] ? attachments[0].fileUrl : normalized.fileUrl,
      uploadUrl: attachments[0] ? attachments[0].uploadUrl : normalized.uploadUrl,
      localFilePath: attachments[0] ? attachments[0].localFilePath : normalized.localFilePath,
      fileName: attachments[0] ? attachments[0].fileName : normalized.fileName,
      updatedAt: nowIso()
    })
  }
  else list.unshift({ ...normalized, createdAt: normalized.uploadedAt, updatedAt: nowIso() })
  return saveSupplementMaterials(list, resolvedScope)
}

export function replaceSupplementMaterial(record = {}, scope = {}) {
  const resolvedScope = resolveSupplementMaterialScope({
    ...scope,
    caseId: first(record.caseId, scope && scope.caseId, ''),
    reportId: first(record.reportId, scope && scope.reportId, '')
  })
  const normalized = normalizeSupplementMaterial(record, resolvedScope)
  const list = readSupplementMaterials(resolvedScope)
  const idx = list.findIndex((item) => item.id === normalized.id || item.type === normalized.type)
  if (idx >= 0) list[idx] = { ...normalized, updatedAt: nowIso() }
  else list.unshift({ ...normalized, createdAt: normalized.uploadedAt, updatedAt: nowIso() })
  return saveSupplementMaterials(list, resolvedScope)
}

export function removeSupplementMaterial(typeOrId, scope = {}) {
  const key = String(typeOrId || '')
  const resolvedScope = resolveSupplementMaterialScope(scope)
  const next = readSupplementMaterials(resolvedScope).filter((item) => item.id !== key && item.type !== key)
  return saveSupplementMaterials(next, resolvedScope)
}

export function saveSupplementMaterialRemote(record, scope = {}) {
  const material = sanitizeSupplementMaterialRemotePayload(record, scope)
  return request({ url: '/api/profile/supplement-material', method: 'POST', data: material })
}

export function getSupplementMaterialsRemote(scope = {}) {
  const { caseId, reportId } = resolveSupplementMaterialScope(scope)
  return request({
    url: '/api/profile/supplement-materials',
    method: 'GET',
    data: {
      ...(caseId ? { caseId } : {}),
      ...(reportId ? { reportId } : {})
    }
  })
}

const materialIdentity = (item = {}, index = 0) =>
  String(first(item.materialType, item.type, item.id, item.materialId, item.name, `material_${index}`)).trim().toLowerCase()

const timestampOf = (item = {}) => {
  const ts = new Date(first(item.updatedAt, item.uploadedAt, item.createdAt, 0)).getTime()
  return Number.isFinite(ts) ? ts : 0
}

const hasLocalOnlyAttachment = (item = {}) => {
  const attachments = Array.isArray(item.attachments) ? item.attachments : []
  if (item.localFilePath && !item.fileUrl && !item.uploadUrl) return true
  return attachments.some((attachment) =>
    !!(attachment && attachment.localFilePath && !attachment.fileUrl && !attachment.uploadUrl)
  )
}

const localMaterialNeedsUpload = (item = {}) => {
  const status = String(item.status || '').trim().toLowerCase()
  return ['queued', 'uploading', 'failed', 'draft', 'local', 'pending_sync'].includes(status) ||
    !!item.uploadError ||
    item.syncPending === true ||
    item.localOnly === true ||
    hasLocalOnlyAttachment(item)
}

const responseMaterials = (response = {}) => {
  if (Array.isArray(response)) return response
  if (Array.isArray(response.list)) return response.list
  if (Array.isArray(response.materials)) return response.materials
  return []
}

const canonicalScopeFromResponse = (requestedScope, response = {}) => resolveSupplementMaterialScope({
  caseId: first(response.caseId, response.materialScopeId, requestedScope.caseId),
  reportId: first(response.reportId, response.caseId, requestedScope.reportId),
  useActiveReport: false
})

const responseMatchesRequestedScope = (requestedScope, canonicalScope, response = {}) => {
  if (supplementMaterialScopesOverlap(requestedScope, canonicalScope)) return true
  const responseAliases = {
    caseId: response.clientReportId,
    reportId: response.sourceReportId,
    caseAliases: [response.clientReportId, response.sourceReportId].filter(Boolean)
  }
  return supplementMaterialScopesOverlap(requestedScope, responseAliases)
}

export function mergeSupplementMaterialCloudSnapshot(localMaterials = [], remoteMaterials = [], scope = {}) {
  const canonicalScope = resolveSupplementMaterialScope({ ...scope, useActiveReport: false })
  const merged = new Map()

  ;(Array.isArray(remoteMaterials) ? remoteMaterials : []).forEach((item, index) => {
    const rawCaseId = normalizedScopeToken(first(item.caseId, item.materialScopeId))
    if (rawCaseId && canonicalScope.caseId && rawCaseId !== canonicalScope.caseId) return
    const normalized = normalizeSupplementMaterial({
      ...item,
      caseId: canonicalScope.caseId,
      reportId: canonicalScope.reportId
    }, canonicalScope)
    merged.set(materialIdentity(normalized, index), normalized)
  })

  ;(Array.isArray(localMaterials) ? localMaterials : []).forEach((item, index) => {
    const normalizedLocal = normalizeSupplementMaterial({
      ...item,
      caseId: canonicalScope.caseId,
      reportId: canonicalScope.reportId
    }, canonicalScope)
    const key = materialIdentity(normalizedLocal, index)
    const remote = merged.get(key)
    if (!remote) {
      merged.set(key, normalizedLocal)
      return
    }
    const keepLocal = localMaterialNeedsUpload(normalizedLocal) || timestampOf(normalizedLocal) > timestampOf(remote)
    if (!keepLocal) return
    const attachments = dedupeAttachments([
      ...(normalizedLocal.attachments || []),
      ...(remote.attachments || [])
    ])
    merged.set(key, normalizeSupplementMaterial({
      ...remote,
      ...normalizedLocal,
      caseId: canonicalScope.caseId,
      reportId: canonicalScope.reportId,
      attachments,
      fileUrl: first(normalizedLocal.fileUrl, remote.fileUrl),
      uploadUrl: first(normalizedLocal.uploadUrl, remote.uploadUrl),
      localFilePath: first(normalizedLocal.localFilePath, remote.localFilePath)
    }, canonicalScope))
  })

  return [...merged.values()].sort((a, b) => timestampOf(b) - timestampOf(a))
}

export async function restoreSupplementMaterialsFromCloud(
  scope = {},
  remoteFn = getSupplementMaterialsRemote
) {
  const requestedScope = resolveSupplementMaterialScope(scope)
  if (!requestedScope.caseId) {
    return {
      ok: true,
      skipped: true,
      reason: 'missing-active-case',
      requestedScope,
      canonicalScope: requestedScope,
      materials: readSupplementMaterials(requestedScope)
    }
  }

  const localRequested = readSupplementMaterials(requestedScope)
  const response = await remoteFn(requestedScope)
  const canonicalScope = canonicalScopeFromResponse(requestedScope, response || {})
  if (!canonicalScope.caseId || !responseMatchesRequestedScope(requestedScope, canonicalScope, response || {})) {
    const error = new Error('云端材料归属与当前报告不一致')
    error.code = 'SUPPLEMENT_CASE_MISMATCH'
    throw error
  }

  const localCanonical = supplementMaterialScopesOverlap(requestedScope, canonicalScope)
    ? []
    : readSupplementMaterials(canonicalScope)
  const merged = mergeSupplementMaterialCloudSnapshot(
    [...localCanonical, ...localRequested],
    responseMaterials(response || {}),
    canonicalScope
  )
  const materials = saveSupplementMaterials(merged, canonicalScope)
  if (!supplementMaterialScopesOverlap(requestedScope, canonicalScope)) {
    const api = storage()
    if (api && typeof api.removeStorageSync === 'function') {
      api.removeStorageSync(materialStorageKey(requestedScope))
    }
  }
  return {
    ok: true,
    skipped: false,
    requestedScope,
    canonicalScope,
    materials,
    remoteCount: responseMaterials(response || {}).length
  }
}

export async function syncSupplementMaterial(record, remoteFn = saveSupplementMaterialRemote) {
  const material = normalizeSupplementMaterial(record)
  upsertSupplementMaterial(material, material)
  try {
    const response = await remoteFn(sanitizeSupplementMaterialRemotePayload(material))
    return { ok: true, queued: false, material, response }
  } catch (err) {
    return { ok: false, queued: true, material, errMsg: err && err.message ? err.message : '同步失败，已保存在本机' }
  }
}

export async function syncSupplementMaterialExact(record, remoteFn = saveSupplementMaterialRemote) {
  const material = normalizeSupplementMaterial(record)
  replaceSupplementMaterial(material, material)
  try {
    const response = await remoteFn(sanitizeSupplementMaterialRemotePayload(material))
    return { ok: true, queued: false, material, response }
  } catch (err) {
    return { ok: false, queued: true, material, errMsg: err && err.message ? err.message : '同步失败，已保存在本机' }
  }
}

function incomeRangeKey(monthlyIncome) {
  const income = Number(monthlyIncome || 0)
  if (income >= 50000) return 'above50k'
  if (income >= 20000) return '20k_50k'
  if (income >= 10000) return '10k_20k'
  if (income >= 5000) return '5k_10k'
  return 'under5k'
}

const hasUploadedEvidence = (item) =>
  !!(item && ((Array.isArray(item.attachments) && item.attachments.some(attachmentHasFile)) || item.fileUrl || item.uploadUrl || item.localFilePath || item.status === 'uploaded' || item.status === 'queued' || item.statusText === '待确认' || item.statusText === '本机已保存'))

const hasManualEvidence = (item) =>
  !!(item && !item.unavailable && (num(item.months, 0) > 0 || num(item.sameEmployerMonths, 0) > 0 || num(item.monthlyIncome, 0) > 0 || num(item.annualTaxableIncome, 0) > 0 || num(item.declaredValue, 0) > 0 || String(item.companyName || '').trim() || String(item.note || '').trim()))

const hasMaterialEvidence = (item) => hasUploadedEvidence(item) || hasManualEvidence(item)
const isUnavailable = (item) => !!(item && item.unavailable === true)
const hasAnsweredMaterial = (item) => hasMaterialEvidence(item) || isUnavailable(item)
const groupAnswered = (...items) => items.some(hasMaterialEvidence) || items.every((item) => item && isUnavailable(item))

const normalizeOcrText = (text = '') => String(text || '').replace(/[，,]/g, '').replace(/\s+/g, ' ').trim()

const parseMoneyToYuan = (raw = '', unit = '') => {
  const n = num(raw, 0)
  if (!n) return 0
  return /万/.test(String(unit || raw)) ? n * 10000 : n
}

const isYearLikeAmount = (value, unit = '') => {
  if (unit) return false
  const n = Number(value)
  return Number.isFinite(n) && n >= 1900 && n <= 2099 && Math.round(n) === n
}

const isDateFragmentContext = (source = '', start = 0, end = 0) => {
  const left = source.slice(Math.max(0, start - 8), start)
  const right = source.slice(end, Math.min(source.length, end + 8))
  return /20\d{2}\s*[-/.年]?\s*$/.test(left) || /^\s*[-/.年]\s*(0?[1-9]|1[0-2])/.test(right) || /月份|所属期|申报期|税款所属/.test(left + right)
}

const moneyCandidates = (text = '') => {
  const source = normalizeOcrText(text)
  const out = []
  const push = (value, unit = '', label = '', start = 0, end = 0) => {
    if (isYearLikeAmount(value, unit)) return
    if (!unit && isDateFragmentContext(source, start, end)) return
    const yuan = parseMoneyToYuan(value, unit)
    if (yuan > 0) out.push({ value: yuan, unit, label })
  }
  const labeled = /(月收入|收入合计|收入总额|收入额合计|累计收入|年度收入|收入|工资|实发工资|应发工资|税前工资|税后工资|缴存基数|缴费基数|平均工资|纳税收入|应纳税所得额|资产估值|评估价|购车价|房产价值|车辆价值)[^\d]{0,12}([\d.]+)\s*(万|万元|元)?/g
  let m
  while ((m = labeled.exec(source)) !== null) push(m[2], m[3], m[1], m.index, labeled.lastIndex)
  const generic = /([\d.]+)\s*(万元|万|元)/g
  while ((m = generic.exec(source)) !== null) push(m[1], m[2], '', m.index, generic.lastIndex)
  return out
}

const taxAnnualIncomeCandidates = (text = '') => {
  const source = normalizeOcrText(text)
  return moneyCandidates(source)
    .filter((item) => /收入合计|收入总额|收入额合计|累计收入|年度收入|纳税收入|应纳税所得额/.test(item.label))
    .filter((item) => item.value >= 1000 && item.value <= 10000000)
}

const pickTaxAnnualIncome = (text = '') => {
  const candidates = taxAnnualIncomeCandidates(text)
  return candidates.length ? Math.max(...candidates.map((item) => item.value)) : 0
}

const pickTaxMonthlyIncome = (text = '', months = 0, annualIncome = 0) => {
  const candidates = moneyCandidates(text)
    .filter((item) => item.value >= 1000 && item.value <= 500000)
    .filter((item) => !/已申报税额|税额合计|税款|个税|应纳税额/.test(item.label))
  const monthlyPreferred = candidates
    .filter((item) => /月收入|工资|实发|应发|税前工资|税后工资|收入/.test(item.label) && !/收入合计|收入总额|收入额合计|年度收入|累计收入|纳税收入|应纳税所得额/.test(item.label))
    .map((item) => item.value)
    .filter((value) => !(annualIncome && value === annualIncome))
  if (monthlyPreferred.length) {
    const sorted = monthlyPreferred.sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)] || sorted[0] || 0
  }
  return 0
}

const monthCandidates = (text = '') => {
  const source = normalizeOcrText(text)
  const out = []
  const push = (value, start, end) => {
    if (isDateFragmentContext(source, start, end)) return
    const n = Number(value)
    if (Number.isFinite(n) && n >= 1 && n <= 360) out.push(n)
  }
  const re = /(连续|近|最近|累计|覆盖|满|合计|共|同单位|缴纳|缴存|流水|工资|月份|月数)[^\d]{0,8}(\d{1,3})\s*(个月|月)/g
  let m
  while ((m = re.exec(source)) !== null) {
    push(m[2], m.index, re.lastIndex)
  }
  const tail = /(\d{1,3})\s*(个月|月)[^\d]{0,8}(连续|累计|覆盖|满|合计|共|同单位|缴纳|缴存|流水|工资|月份|月数)/g
  while ((m = tail.exec(source)) !== null) {
    push(m[1], m.index, tail.lastIndex)
  }
  return out
}

const fullYearTaxMonths = (text = '') => {
  const source = normalizeOcrText(text)
  if (/全年|整年|12\s*个月|十二\s*个月/.test(source)) return 12
  const months = new Set()
  const re = /(?:20\d{2})[-/.年]\s*(0?[1-9]|1[0-2])\s*(?:月)?/g
  let m
  while ((m = re.exec(source)) !== null) months.add(Number(m[1]))
  return months.size >= 10 ? 12 : months.size
}

const employerCountFromText = (text = '') => {
  const source = normalizeOcrText(text)
  const labeled = /(扣缴义务人|任职受雇单位|单位名称|发薪单位|缴费单位|缴存单位)[：:\s]*([\u4e00-\u9fa5A-Za-z0-9（）()·\-]{4,40})/g
  const names = new Set()
  let m
  while ((m = labeled.exec(source)) !== null) {
    const name = String(m[2] || '').replace(/(收入|工资|金额|月份|税款|明细).*$/, '').trim()
    if (name.length >= 4) names.add(name)
  }
  return names.size
}

const pickMonthlyIncome = (text = '', type = '') => {
  const candidates = moneyCandidates(text)
    .filter((item) => item.value >= 1000 && item.value <= 500000)
  const preferred = candidates.filter((item) => /收入|工资|实发|应发|缴存基数|缴费基数|纳税|所得/.test(item.label))
  const pool = preferred.length ? preferred : candidates
  if (!pool.length) return 0
  if (type === 'housing_fund' || type === 'social_security') return Math.max(...pool.map((item) => item.value))
  const values = pool.map((item) => item.value).sort((a, b) => a - b)
  return values[Math.floor(values.length / 2)] || values[values.length - 1] || 0
}

const pickAssetValue = (text = '') => {
  const candidates = moneyCandidates(text)
    .filter((item) => item.value >= 50000 && item.value <= 100000000)
  const preferred = candidates.filter((item) => /资产|估值|评估|房产|车辆|购车|价值/.test(item.label))
  const pool = preferred.length ? preferred : candidates
  return pool.length ? Math.max(...pool.map((item) => item.value)) : 0
}

export function extractSupplementMaterialFromText(text = '', type = '') {
  const ocrText = normalizeOcrText(text)
  const months = type === 'tax'
    ? Math.max(0, fullYearTaxMonths(ocrText), ...monthCandidates(ocrText))
    : Math.max(0, ...monthCandidates(ocrText))
  const taxAnnualIncome = type === 'tax' ? pickTaxAnnualIncome(ocrText) : 0
  const monthlyIncome = type === 'tax' ? pickTaxMonthlyIncome(ocrText, months, taxAnnualIncome) : pickMonthlyIncome(ocrText, type)
  const declaredValue = ['property', 'vehicle'].includes(type) ? pickAssetValue(ocrText) : 0
  const employerCount = ['tax', 'payroll', 'social_security', 'housing_fund'].includes(type) ? employerCountFromText(ocrText) : 0
  const annualTaxableIncome = type === 'tax' ? (taxAnnualIncome || (monthlyIncome && months ? monthlyIncome * Math.min(months, 12) : 0)) : 0
  const sameEmployerMonths = type === 'tax' && employerCount === 1 && months ? months : 0
  const detected = []
  if (months) detected.push(`连续${months}个月`)
  if (type === 'tax' && months >= 12) detected.push('已覆盖近一年')
  if (employerCount > 1) detected.push(`识别到${employerCount}个单位`)
  if (type === 'tax' && annualTaxableIncome) detected.push(`年收入约${Math.round(annualTaxableIncome).toLocaleString()}元`)
  if (monthlyIncome) detected.push(`收入/基数约${Math.round(monthlyIncome).toLocaleString()}元`)
  if (type === 'tax' && annualTaxableIncome && !monthlyIncome) detected.push('收入合计不作为月收入，请补充近12个月逐月明细')
  if (declaredValue) detected.push(`资产约${Math.round(declaredValue).toLocaleString()}元`)
  return {
    ocrText,
    months,
    sameEmployerMonths,
    employerCount,
    annualTaxableIncome,
    monthlyIncome,
    declaredValue,
    confidence: detected.length >= 3 ? 'high' : detected.length >= 2 ? 'medium' : detected.length ? 'low' : 'none',
    detectedSummary: detected.join(' · ')
  }
}

export function analyzeTaxEvidence(item = {}) {
  const months = clamp(Math.round(num(item.months, 0)), 0, 360)
  const sameEmployerMonths = clamp(Math.round(num(item.sameEmployerMonths, months || 0)), 0, 360)
  const employerCount = clamp(Math.round(num(item.employerCount, 0)), 0, 60)
  const annualTaxableIncome = Math.max(0, num(item.annualTaxableIncome, 0))
  const monthlyIncome = Math.max(0, num(item.monthlyIncome, 0))
  const hasFullYearTaxView = months >= 12
  const employerStable = hasFullYearTaxView && (sameEmployerMonths >= 12 || employerCount === 1)
  const jobChangeLikely = months >= 6 && ((employerCount > 1) || (sameEmployerMonths > 0 && sameEmployerMonths < Math.min(months, 12)))
  const taxSignals = []
  if (hasFullYearTaxView) taxSignals.push('近一年个税已覆盖')
  else if (months > 0) taxSignals.push(`个税仅覆盖${months}个月`)
  if (employerStable) taxSignals.push('同一单位满一年')
  if (jobChangeLikely) taxSignals.push('疑似换工作或多单位收入')
  if (monthlyIncome >= 20000) taxSignals.push('收入较强')
  else if (monthlyIncome >= 10000) taxSignals.push('收入稳定')
  return {
    months,
    sameEmployerMonths,
    employerCount,
    annualTaxableIncome,
    monthlyIncome,
    hasFullYearTaxView,
    employerStable,
    jobChangeLikely,
    taxSignals,
    confidence: hasFullYearTaxView && monthlyIncome > 0 ? (employerStable ? 'high' : 'medium') : months > 0 || monthlyIncome > 0 ? 'low' : 'none'
  }
}

export function buildSupplementMaterialProfile(materials = readSupplementMaterials()) {
  const list = (Array.isArray(materials) ? materials : []).map(normalizeSupplementMaterial)
  const byType = new Map(list.map((item) => [item.type, item]))
  const social = byType.get('social_security')
  const fund = byType.get('housing_fund')
  const payroll = byType.get('payroll')
  const tax = byType.get('tax')
  const property = byType.get('property')
  const vehicle = byType.get('vehicle')
  const business = byType.get('business_operation')
  const education = byType.get('education')
  const hasSocialEvidence = hasUploadedEvidence(social)
  const hasFundEvidence = hasUploadedEvidence(fund)
  const hasPayrollEvidence = hasUploadedEvidence(payroll)
  const hasTaxEvidence = hasUploadedEvidence(tax)
  const hasIncomeEvidence = hasMaterialEvidence(social) || hasMaterialEvidence(fund) || hasMaterialEvidence(payroll) || hasMaterialEvidence(tax)
  const hasPropertyEvidence = hasUploadedEvidence(property)
  const hasVehicleEvidence = hasUploadedEvidence(vehicle)
  const hasBusinessEvidence = hasUploadedEvidence(business)
  const educationLevel = String((education && education.educationLevel) || '').trim()
  const educationScore = EDUCATION_SCORE[educationLevel] || 0
  const taxAnalysis = analyzeTaxEvidence(tax || {})
  const payrollMonths = Math.max(num(payroll && payroll.months, 0), num(payroll && payroll.sameEmployerMonths, 0))
  const socialMonths = Math.max(num(social && social.months, 0), num(social && social.sameEmployerMonths, 0))
  const fundMonths = Math.max(num(fund && fund.months, 0), num(fund && fund.sameEmployerMonths, 0))
  const fundingMonths = Math.max(socialMonths, fundMonths)
  const socialBase = num(social && social.monthlyIncome, 0)
  const fundBase = num(fund && fund.monthlyIncome, 0)
  const productUnlockGroups = [
    {
      key: 'education_record',
      title: '学历信息',
      desc: '客户自填即可，用于辅助信用卡和消费类产品排序。',
      complete: !!educationLevel || isUnavailable(education)
    },
    {
      key: 'funding_record',
      title: '社保或公积金',
      desc: '用于确认缴存连续性和单位稳定性；没有也要点“暂无”。',
      complete: groupAnswered(social, fund)
    },
    {
      key: 'income_record',
      title: '工资流水或个税',
      desc: '个税建议查看近一年，工资流水建议 6-12 个月。',
      complete: !!(hasMaterialEvidence(payroll) || hasMaterialEvidence(tax) || (isUnavailable(payroll) && isUnavailable(tax)))
    },
    {
      key: 'asset_record',
      title: '房产或车辆资产',
      desc: '有资产就上传；没有则选择暂无，系统会过滤资产类产品。',
      complete: groupAnswered(property, vehicle)
    }
  ]
  const productUnlockMissing = productUnlockGroups.filter((item) => !item.complete).map((item) => item.title)
  const productUnlockCompletedCount = productUnlockGroups.filter((item) => item.complete).length
  const productMatchUnlocked = productUnlockCompletedCount === productUnlockGroups.length
  const stableMonths = Math.max(fundingMonths, payrollMonths, taxAnalysis.sameEmployerMonths || taxAnalysis.months)
  const monthlyIncome = Math.max(
    num(payroll && payroll.monthlyIncome, 0),
    taxAnalysis.monthlyIncome,
    socialBase,
    fundBase
  )
  const materialCount = list.filter(hasMaterialEvidence).length
  const missing = []
  if (!hasAnsweredMaterial(social) && !hasAnsweredMaterial(fund)) missing.push('社保或公积金')
  if (!hasMaterialEvidence(payroll) && !hasMaterialEvidence(tax)) missing.push('工资流水或个税')
  if (!hasAnsweredMaterial(property) && !hasAnsweredMaterial(vehicle)) missing.push('房产或车辆资产')

  const tags = []
  if (stableMonths >= 12) tags.push('收入/缴存稳定')
  else if (stableMonths > 0 || hasSocialEvidence || hasFundEvidence) tags.push('缴存待核实')
  if (taxAnalysis.hasFullYearTaxView) tags.push('个税覆盖一年')
  if (taxAnalysis.jobChangeLikely) tags.push('疑似换工作')
  if (fundMonths >= 12) tags.push('公积金连续一年')
  if (socialMonths >= 12) tags.push('社保连续一年')
  if (fundBase >= 15000) tags.push('公积金基数较高')
  if (educationScore >= 3) tags.push('学历辅助加分')
  if (monthlyIncome >= 20000) tags.push('收入较强')
  else if (monthlyIncome >= 10000) tags.push('收入稳定')
  else if (hasPayrollEvidence || hasTaxEvidence) tags.push('收入材料待复核')
  if (hasPropertyEvidence) tags.push('有房产材料')
  if (hasVehicleEvidence) tags.push('有车辆材料')
  if (hasBusinessEvidence) tags.push('有经营材料')

  const financialSupplement = {
    socialSecurity: {
      status: fundingMonths >= 6 ? 'continuous' : fundingMonths > 0 ? 'recent_gap' : (hasSocialEvidence || hasFundEvidence) ? 'submitted' : isUnavailable(social) && isUnavailable(fund) ? 'none' : 'unknown',
      months: fundingMonths,
      socialMonths,
      fundMonths,
      socialBase,
      fundBase,
      housingFund: fund ? (fundBase >= 20000 || fund.declaredValue >= 20000 ? 'yes_high' : 'yes_normal') : isUnavailable(fund) ? 'no' : 'unknown',
      socialSecurity: social ? (socialBase >= 15000 ? 'yes_high' : 'yes_normal') : isUnavailable(social) ? 'no' : 'unknown'
    },
    income: {
      primarySource: hasPayrollEvidence || hasTaxEvidence ? 'salary' : hasBusinessEvidence ? 'business' : 'other',
      monthlyRangeKey: monthlyIncome > 0 ? incomeRangeKey(monthlyIncome) : 'under5k',
      stableMonths,
      taxAnalysis
    },
    assets: {
      hasProperty: hasPropertyEvidence,
      hasVehicle: hasVehicleEvidence,
      hasLiquid: monthlyIncome >= 20000,
      noProperty: isUnavailable(property),
      noVehicle: isUnavailable(vehicle)
    },
    business: {
      hasBusinessEvidence
    },
    education: {
      level: educationLevel,
      score: educationScore
    }
  }
  const hasStableIncomeEvidence = !!(
    monthlyIncome > 0 &&
    (stableMonths >= 6 || taxAnalysis.hasFullYearTaxView || hasPayrollEvidence)
  )

  return {
    materials: list,
    materialCount,
    materialDecisionCount: list.filter((item) => hasMaterialEvidence(item) || isUnavailable(item) || item.type === 'education').length,
    completedCount: list.filter(hasUploadedEvidence).length,
    hasStableIncomeEvidence,
    hasTaxEvidence,
    taxAnalysis,
    educationLevel,
    educationScore,
    socialMonths,
    fundMonths,
    socialBase,
    fundBase,
    hasAssetEvidence: !!(hasPropertyEvidence || hasVehicleEvidence),
    hasProperty: hasPropertyEvidence,
    hasVehicle: hasVehicleEvidence,
    hasBusinessEvidence,
    productMatchUnlocked,
    productMatchBlocked: !productMatchUnlocked,
    productUnlockGroups,
    productUnlockMissing,
    productUnlockCompletedCount,
    productUnlockTotalCount: productUnlockGroups.length,
    unlockProgressText: `${productUnlockCompletedCount}/${productUnlockGroups.length}`,
    stableMonths,
    monthlyIncome,
    missing,
    tags,
    confidenceText: materialCount >= 4 ? '材料较完整' : materialCount >= 2 ? '材料可复核' : productMatchUnlocked ? '已确认暂无材料' : '材料不足',
    summary: tags.length ? tags.join(' · ') : (productMatchUnlocked ? '已按暂无材料场景进行保守匹配' : '暂未补充三金、个税或资产材料'),
    financialSupplement
  }
}

export function canMatchProductsWithSupplementProfile(profile) {
  return !!(profile && profile.productMatchUnlocked === true)
}

export function canMatchProductsWithMaterials(materials = readSupplementMaterials()) {
  return canMatchProductsWithSupplementProfile(buildSupplementMaterialProfile(materials))
}

export function enrichAnalysisWithSupplementMaterials(analysisData, materials = readSupplementMaterials()) {
  const profile = buildSupplementMaterialProfile(materials)
  if (!analysisData || (!profile.materialCount && !profile.materialDecisionCount)) return { analysisData, supplementProfile: profile, enriched: false }
  const enriched = enrichAnalysisWithFinancialProfile(analysisData, profile.financialSupplement)
  return {
    analysisData: {
      ...enriched,
      supplementMaterialProfile: profile
    },
    supplementProfile: profile,
    enriched: true
  }
}

export default {
  SUPPLEMENT_MATERIAL_TYPES,
  deriveSupplementMaterialScope,
  resolveSupplementMaterialScope,
  materialStorageKey,
  readSupplementMaterials,
  saveSupplementMaterials,
  upsertSupplementMaterial,
  replaceSupplementMaterial,
  removeSupplementMaterial,
  normalizeSupplementAttachment,
  sanitizeSupplementMaterialRemotePayload,
  extractSupplementMaterialFromText,
  buildSupplementMaterialProfile,
  canMatchProductsWithSupplementProfile,
  canMatchProductsWithMaterials,
  enrichAnalysisWithSupplementMaterials,
  saveSupplementMaterialRemote,
  getSupplementMaterialsRemote,
  mergeSupplementMaterialCloudSnapshot,
  restoreSupplementMaterialsFromCloud,
  supplementMaterialScopesOverlap,
  syncSupplementMaterial,
  syncSupplementMaterialExact
}
