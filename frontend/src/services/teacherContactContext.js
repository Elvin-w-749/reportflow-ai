import { debtExecutionRecordsToMaterials } from './debtExecution.js'

const asObj = (value) => value && typeof value === 'object' ? value : {}
const pickStr = (...candidates) => {
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}
const pickIdentifier = (...candidates) => {
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if ((typeof value === 'number' || typeof value === 'bigint') && String(value).trim()) return String(value)
  }
  return ''
}
const avatarOf = (value) => {
  const item = asObj(value)
  return pickStr(
    item.avatar,
    item.avatarUrl,
    item.avatar_url,
    item.headImage,
    item.headImg,
    item.head_image,
    item.profileImage,
    item.profilePhoto,
    item.portrait
  )
}
const pickNumOrNull = (...candidates) => {
  for (const value of candidates) {
    if (value === undefined || value === null || value === '') continue
    const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, '').replace('%', ''))
    if (Number.isFinite(n)) return Math.round(n)
  }
  return null
}
const asArray = (...candidates) => {
  for (const value of candidates) {
    if (Array.isArray(value)) return value
    if (typeof value === 'string' && value.trim()) return value.split(/[、,，;；\n]/).map((item) => item.trim()).filter(Boolean)
  }
  return []
}
const materialStatusText = (item) => {
  const explicit = pickStr(item.statusText, item.stateText)
  if (explicit) return explicit
  const status = pickStr(item.status, item.state, item.uploadStatus).toLowerCase()
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
  const item = asObj(value)
  const name = pickStr(item.name, item.title, item.label, item.materialName, item.documentName, item.type)
  if (!name) return null
  const statusText = materialStatusText(item)
  return {
    ...item,
    id: pickStr(item.id, item.key, item.code, `material_${index}`),
    name,
    status: pickStr(item.status, item.state, item.uploadStatus, statusText === '已确认' ? 'confirmed' : statusText === '需重传' ? 'rejected' : statusText === '无需' ? 'unneeded' : statusText === '待确认' ? 'uploaded' : 'pending'),
    statusText,
    note: pickStr(item.note, item.desc, item.description, item.remark),
    uploadUrl: pickStr(item.uploadUrl, item.url, item.fileUrl),
    fileName: pickStr(item.fileName, item.nameOnDisk, item.uploadName),
    fileSize: item.fileSize === undefined ? '' : item.fileSize,
    uploadedAt: pickStr(item.uploadedAt, item.uploadTime, item.submittedAt),
    reviewNote: pickStr(item.reviewNote, item.rejectReason, item.reason, item.reviewRemark),
    reviewedAt: pickStr(item.reviewedAt, item.reviewTime),
    reviewAckStage: pickStr(item.reviewAckStage, item.ackStage, item.userReviewAckStage),
    reviewAcknowledgedAt: pickStr(item.reviewAcknowledgedAt, item.reviewAckAt, item.acknowledgedAt, item.userAcknowledgedAt),
    reviewAcknowledgedNote: pickStr(item.reviewAcknowledgedNote, item.reviewAckNote, item.ackNote, item.userReviewNote),
    source: pickStr(item.source),
    executionRecordId: pickStr(item.executionRecordId),
    debtId: pickStr(item.debtId),
    reportId: pickStr(item.reportId),
    required: item.required === undefined ? statusText !== '无需' : Boolean(item.required)
  }
}
const collectMaterials = (raw, context, report, product) => {
  const debtMaterials = debtExecutionRecordsToMaterials(asArray(
    raw.executionRecords,
    raw.debtExecutionRecords,
    raw.debtProofs,
    context.executionRecords,
    context.debtExecutionRecords,
    context.debtProofs
  ))
  const baseMaterials = asArray(
      raw.requiredMaterials,
      raw.pendingMaterials,
      raw.materials,
      raw.materialChecklist,
      raw.materialList,
      raw.documents,
      context.requiredMaterials,
      context.pendingMaterials,
      context.materials,
      context.materialChecklist,
      context.materialList,
      context.documents,
      report.requiredMaterials,
      product.requiredMaterials,
      product.materials,
      product.materialChecklist
    )
  const supplementMaterials = [
    ...asArray(raw.supplementMaterials),
    ...asArray(context.supplementMaterials),
    ...asArray(report.supplementMaterials)
  ]
  const list = [
    ...baseMaterials,
    // 补充材料最后合并，使最新上传/复核状态覆盖旧清单。
    ...supplementMaterials,
    ...debtMaterials
  ]
  const merged = []
  list.map(normalizeMaterialItem).filter(Boolean).forEach((item) => {
    const ids = [item.id, item.materialId, item.key, item.code].filter(Boolean).map(String)
    const types = [item.type, item.materialType].filter(Boolean).map(String)
    const names = [item.name, item.materialName].filter(Boolean).map(String)
    const index = merged.findIndex((existing) => {
      const existingIds = [existing.id, existing.materialId, existing.key, existing.code].filter(Boolean).map(String)
      const existingTypes = [existing.type, existing.materialType].filter(Boolean).map(String)
      const existingNames = [existing.name, existing.materialName].filter(Boolean).map(String)
      return ids.some((value) => existingIds.includes(value)) ||
        types.some((value) => existingTypes.includes(value)) ||
        names.some((value) => existingNames.includes(value))
    })
    if (index >= 0) merged[index] = { ...merged[index], ...item }
    else merged.push(item)
  })
  return merged
}

export function normalizeAdvisorContactContext(rawValue) {
  const raw = asObj(rawValue)
  const context = asObj(raw.context || raw.consultContext || raw.matchContext || raw.payload || raw.extra)
  const clientInfo = asObj(raw.clientInfo)
  const userInfo = asObj(raw.userInfo)
  const customer = asObj(raw.customer)
  const user = asObj(raw.user)
  const client = asObj(raw.client)
  const report = asObj(raw.report || raw.reportInfo || context.report || context.reportInfo)
  const product = asObj(raw.product || raw.productInfo || context.product || context.productInfo)
  const match = asObj(raw.match || context.match)
  const clientId = pickIdentifier(
    raw.clientId,
    client.clientId,
    clientInfo.clientId,
    client.id,
    client._id,
    clientInfo.id,
    clientInfo._id,
    user.clientId,
    userInfo.clientId,
    customer.clientId,
    user.id,
    user._id,
    userInfo.id,
    userInfo._id,
    customer.id,
    customer._id
  )
  const clientUid = pickIdentifier(
    raw.userId,
    raw.uid,
    raw.clientUid,
    raw.customerUid,
    user.uid,
    user.userId,
    user.clientUid,
    userInfo.uid,
    userInfo.userId,
    userInfo.clientUid,
    client.uid,
    client.userId,
    client.clientUid,
    clientInfo.uid,
    clientInfo.userId,
    clientInfo.clientUid,
    customer.uid,
    customer.userId,
    customer.clientUid,
    customer.customerUid,
    clientId
  )
  const userId = pickIdentifier(
    raw.userId,
    user.userId,
    userInfo.userId,
    client.userId,
    clientInfo.userId,
    customer.userId
  )
  const avatar = pickStr(
    avatarOf(clientInfo),
    avatarOf(userInfo),
    avatarOf(customer),
    avatarOf(user),
    avatarOf(client),
    avatarOf(raw),
    avatarOf(context)
  )
  const reportId = pickStr(raw.reportId, context.reportId, report.id, report.reportId)
  const reportTitle = pickStr(raw.reportTitle, context.reportTitle, report.title, report.fileName, report.reportType)
  const reportScore = pickNumOrNull(raw.reportScore, context.reportScore, report.scoreText, report.score, report.totalScore)
  const reportDate = pickStr(raw.reportDate, context.reportDate, report.date, report.createdAt)
  const productId = pickStr(raw.productId, context.productId, product.id, product.productId)
  const productName = pickStr(raw.productName, context.productName, product.name, product.title)
  const institution = pickStr(raw.institution, context.institution, product.institution, product.bankName)
  const rateText = pickStr(raw.rateText, context.rateText, product.rateText, product.interestRate, product.rate, product.aprText)
  const amountText = pickStr(raw.amountText, context.amountText, product.amountText, product.amount, product.creditLimitText)
  const termText = pickStr(raw.termText, context.termText, product.termText, product.term, product.periodText)
  const matchRate = pickNumOrNull(raw.matchRate, context.matchRate, product.matchRate, match.matchRate)
  const contactType = pickStr(raw.contactType, context.contactType)
  const channel = pickStr(raw.channel, context.channel, raw.deskType, context.deskType) || (contactType === 'customer-service' ? 'service' : 'bank')
  const source = pickStr(
    raw.source,
    context.source,
    raw.contactSource,
    context.contactSource,
    raw.entrySource,
    context.entrySource,
    raw.sourceType,
    context.sourceType,
    raw.origin,
    context.origin
  )
  const contactIntent = pickStr(
    raw.contactIntent,
    context.contactIntent,
    raw.consultIntent,
    context.consultIntent,
    raw.businessIntent,
    context.businessIntent,
    raw.intent,
    context.intent
  )
  const businessType = pickStr(
    raw.businessType,
    context.businessType,
    raw.serviceType,
    context.serviceType,
    raw.businessCode,
    context.businessCode
  )
  const serviceType = pickStr(
    raw.serviceType,
    context.serviceType,
    raw.businessType,
    context.businessType,
    raw.serviceCode,
    context.serviceCode
  )
  const businessName = pickStr(
    raw.businessName,
    context.businessName,
    raw.serviceName,
    context.serviceName,
    raw.businessLabel,
    context.businessLabel,
    product.businessName,
    product.serviceName
  )
  const advisorInfo = asObj(raw.advisorInfo || context.advisorInfo)
  const messages = asArray(raw.messages, context.messages)
  const materials = collectMaterials(raw, context, report, product)
  const summary = pickStr(raw.summary, context.summary) || [
    productName ? `咨询${productName}` : '',
    matchRate != null ? `匹配度${matchRate}%` : '',
    reportTitle || reportId ? `基于${reportTitle || '信用报告'}` : '',
    reportScore != null ? `信用分${reportScore}` : ''
  ].filter(Boolean).join(' · ')
  return {
    clientUid,
    clientId,
    userId,
    avatar,
    reportId,
    reportTitle,
    reportDate,
    reportScore,
    productId,
    productName,
    institution,
    rateText,
    amountText,
    termText,
    matchRate,
    contactType,
    channel,
    source,
    contactIntent,
    businessType,
    serviceType,
    businessName,
    advisorInfo,
    messages,
    summary,
    materials,
    riskText: reportScore != null ? `信用分 ${reportScore}` : (reportTitle || ''),
    matchSuggestions: productName ? [{
      title: productName,
      desc: [
        institution,
        rateText ? `参考利率 ${rateText}` : '参考利率详询',
        amountText ? `额度 ${amountText}` : '',
        termText ? `期限 ${termText}` : '',
        matchRate != null ? `匹配度 ${matchRate}%` : '待老师确认准入'
      ].filter(Boolean).join(' · ')
    }] : []
  }
}

export default { normalizeAdvisorContactContext }
