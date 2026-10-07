const first = (...values) => values.find((value) => value !== undefined && value !== null && String(value).trim() !== '') || ''

const normalizeStatus = (value) => {
  const raw = String(value || '').toLowerCase()
  if (['completed', 'done', 'resolved', 'closed'].includes(raw)) return 'completed'
  if (['pending', 'new', 'todo'].includes(raw)) return 'pending'
  if (['need_info', 'need-material', 'material_reupload'].includes(raw)) return 'need_info'
  return 'processing'
}

export const materialStatusText = (item = {}) => {
  const explicit = String(first(item.statusText, item.stateText))
  // 明确的复核结论优先于旧客户端残留的 uploaded 状态，避免确认后仍显示“待确认”。
  if (/已确认|已完成|审核通过/.test(explicit)) return '已确认'
  if (/需重传|重新上传|审核拒绝|不通过/.test(explicit)) return '需重传'
  if (/无需|暂无|不提供/.test(explicit)) return '无需'
  const raw = String(first(item.status, item.state, item.uploadStatus)).toLowerCase()
  if (['uploaded', 'submitted', 'reviewing', 'pending_review', 'provided', 'received', 'available'].includes(raw)) return '待确认'
  if (['done', 'completed', 'confirmed', 'verified', 'approved'].includes(raw)) return '已确认'
  if (['rejected', 'reject', 'reupload', 'need_reupload', 'invalid', 'failed'].includes(raw)) return '需重传'
  if (['optional', 'unneeded', 'not_required', 'waived', 'none', 'skipped', 'unavailable'].includes(raw) || item.unavailable === true) return '无需'
  if (['draft', 'pending', 'missing', 'required', 'not_uploaded'].includes(raw)) return '待补充'
  if (/待确认|审核中|待审核|已上传/.test(explicit)) return '待确认'
  if (/待上传|待补充/.test(explicit)) return '待补充'
  if (explicit) return explicit
  return '待补充'
}

const normalizeMaterials = (value) => {
  if (!Array.isArray(value)) return []
  return value
    .map((item, index) => {
      if (typeof item === 'string') return { id: `material-${index}`, name: item, statusText: '待补充' }
      if (!item || typeof item !== 'object') return null
      const name = first(item.name, item.title, item.label, item.materialName, item.documentName, item.type)
      if (!name) return null
      return {
        ...item,
        id: first(item.id, item.key, item.code, `material-${index}`),
        name,
        statusText: materialStatusText(item)
      }
    })
    .filter(Boolean)
}

export const collectMaterials = (source = {}) => {
  const candidates = [
    source.materials,
    source.pendingMaterials,
    source.materialChecklist,
    source.materialList,
    source.context && source.context.materials,
    source.context && source.context.pendingMaterials,
    source.product && source.product.materials,
    source.product && source.product.materialChecklist,
    // 补充材料放在最后，同类型时覆盖旧清单状态。
    source.supplementMaterials,
    source.context && source.context.supplementMaterials
  ]
  const merged = []
  const identityValues = (item, keys) => keys
    .map((key) => String(item && item[key] || '').trim().toLowerCase())
    .filter((value) => value && !/^material[-_]\d+$/.test(value))
  const sameMaterial = (left, right) => [
    ['id', 'materialId', 'key', 'code'],
    ['type', 'materialType'],
    ['name', 'materialName', 'title', 'label']
  ].some((keys) => {
    const a = identityValues(left, keys)
    const b = identityValues(right, keys)
    return a.length > 0 && b.length > 0 && a.some((value) => b.includes(value))
  })
  for (const list of candidates) {
    const normalized = normalizeMaterials(list)
    normalized.forEach((item) => {
      const index = merged.findIndex((existing) => sameMaterial(existing, item))
      if (index >= 0) merged[index] = { ...merged[index], ...item }
      else merged.push(item)
    })
  }
  return merged
}

const materialStatsOf = (materials = []) => materials.reduce((acc, item) => {
  const text = item.statusText || materialStatusText(item)
  acc.total += 1
  if (text === '待补充') acc.pending += 1
  else if (text === '需重传') acc.reupload += 1
  else if (text === '待确认') acc.reviewing += 1
  else if (['已确认', '无需'].includes(text)) acc.done += 1
  return acc
}, { total: 0, pending: 0, reupload: 0, reviewing: 0, done: 0 })

const nonNegativeCount = (...values) => {
  return Math.max(0, ...values.map((value) => {
    const count = Number(value)
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
  }))
}

export const materialProgressStatsOf = (source = {}) => {
  const summary = source.materialProgressSummary ||
    (source.context && source.context.materialProgressSummary) ||
    {}
  if (!summary || typeof summary !== 'object') return null
  const total = nonNegativeCount(summary.total, summary.materialCount, source.materialCount)
  if (!total) return null
  const state = String(first(summary.state, summary.status, summary.completionState)).toLowerCase()
  const hasPendingReview = Object.prototype.hasOwnProperty.call(summary, 'pendingReview') ||
    Object.prototype.hasOwnProperty.call(summary, 'pendingReviewCount')
  const confirmedOrUnavailable =
    nonNegativeCount(summary.confirmed, summary.confirmedCount, summary.verified) +
    nonNegativeCount(summary.unavailable, summary.unavailableCount, summary.waived)
  const reviewing = nonNegativeCount(
    summary.reviewing,
    summary.reviewingCount,
    summary.pendingReview,
    summary.pendingReviewCount,
    summary.provided,
    summary.providedCount,
    summary.submitted,
    summary.submittedCount
  ) || (!hasPendingReview ? nonNegativeCount(summary.uploaded, summary.uploadedCount) : 0)
  const stats = {
    total,
    pending: nonNegativeCount(
      summary.pending,
      summary.pendingCount,
      summary.pendingSupplement,
      summary.pendingSupplementCount,
      summary.missing,
      summary.missingCount,
      summary.toUpload,
      summary.draft
    ),
    reupload: nonNegativeCount(summary.reupload, summary.reuploadCount, summary.rejected, summary.rejectedCount),
    reviewing,
    done: Math.max(nonNegativeCount(summary.done, summary.doneCount), confirmedOrUnavailable)
  }
  const categorized = stats.pending + stats.reupload + stats.reviewing + stats.done
  if (!categorized) {
    if (['uploaded', 'provided', 'submitted', 'reviewing', 'pending_review', 'pending-review'].includes(state)) stats.reviewing = total
    else if (['confirmed', 'completed', 'done', 'verified', 'unavailable', 'waived'].includes(state)) stats.done = total
    else if (['reupload', 'rejected', 'failed', 'action-required'].includes(state)) stats.reupload = total
    else stats.pending = total
  } else if (categorized < total) {
    // 脱敏摘要缺少分类时保守记为待补充，绝不把“已提供”误判成全部完成。
    stats.pending += total - categorized
  }
  return stats
}

const namesOf = (materials = []) => materials.slice(0, 2).map((item) => item.name).filter(Boolean).join('、')

const materialStageState = (stats) => {
  if (!stats.total) return 'pending'
  if (stats.reupload || stats.pending) return 'action'
  if (stats.reviewing) return 'current'
  return 'done'
}

const materialAlertOf = (materials, stats) => {
  if (stats.reupload) {
    const items = materials.filter((item) => item.statusText === '需重传')
    return { level: 'danger', title: '资料需要重传', text: `请优先处理${namesOf(items) || '补充资料'}。` }
  }
  if (stats.pending) {
    const items = materials.filter((item) => item.statusText === '待补充')
    return { level: 'warning', title: '资料还未补齐', text: `待补充${namesOf(items) || '关键资料'}，补齐后才能继续推进。` }
  }
  if (stats.reviewing) return { level: 'info', title: '资料待核验', text: '已提交资料正在等待客服或银行老师确认。' }
  if (stats.total) return { level: 'success', title: '资料已归档', text: '当前授权资料已进入本次服务档案。' }
  return { level: 'info', title: '待建立资料档案', text: '确认材料有无后，系统会继续匹配和推进服务。' }
}

export function buildServiceProgress(source = {}) {
  const status = normalizeStatus(source.status)
  const channel = String(source.channel || source.deskType || (source.contactType === 'customer-service' ? 'service' : 'bank') || '')
  const materials = collectMaterials(source)
  const summaryStats = materialProgressStatsOf(source)
  const stats = materials.length ? materialStatsOf(materials) : (summaryStats || materialStatsOf(materials))
  const serviceDone = !!source.serviceAssigneeId || status !== 'pending'
  const advisorRequired = channel === 'bank' || source.serviceRequired === true || source.groupMode === 'service-bank-customer' || source.contactType === 'match-product'
  const advisorDone = !!source.advisorAssigneeId || (!advisorRequired && status !== 'pending')
  const completed = status === 'completed'
  const materialState = materialStageState(stats)
  const stages = [
    { key: 'submitted', title: '发起', state: 'done' },
    { key: 'service', title: '客服', state: serviceDone ? 'done' : 'current' },
    { key: 'materials', title: '资料', state: materialState },
    { key: 'advisor', title: advisorRequired ? '银行' : '处理', state: advisorDone ? 'done' : (serviceDone && !stats.pending && !stats.reupload ? 'current' : 'pending') },
    { key: 'completed', title: '完成', state: completed ? 'done' : 'pending' }
  ]
  const current = stages.find((item) => ['current', 'action'].includes(item.state)) || stages[stages.length - 1]
  const title = completed ? '服务已完成' : current.key === 'materials' ? '资料档案处理中' : current.key === 'advisor' ? (advisorRequired ? '等待银行老师接入' : '客服处理中') : '服务推进中'
  const text = completed
    ? '本次咨询已完成，管理员端保留完整留档。'
    : current.key === 'service'
      ? '客户已发起咨询，等待客服接单后进入资料核验。'
      : current.key === 'materials'
        ? materialAlertOf(materials, stats).text
        : current.key === 'advisor'
          ? (advisorRequired ? '客服可拉入匹配机构老师继续沟通。' : '客服正在处理客户咨询。')
          : '服务正在推进中。'
  return {
    title,
    text,
    stages,
    materials,
    materialStats: stats,
    materialSummary: stats.total ? `${stats.done}/${stats.total} 已确认` : '待上传',
    alert: materialAlertOf(materials, stats)
  }
}
