<template>
  <view class="page rpt-page">
    <view class="nav">
      <text class="nav-title">智能方案匹配</text>
    </view>

    <scroll-view class="scroll-body" scroll-y>
      <view class="wrap rpt-content-max">
        <view class="banner">
          <view class="banner-copy">
            <text class="banner-title">{{ bannerTitle }}</text>
            <text class="banner-sub">{{ bannerSubtitle }}</text>
          </view>
          <view v-if="!hasReport" class="banner-btn" @click="goUpload"><text class="banner-btn-text">上传报告</text></view>
          <view v-else class="banner-btn banner-btn-soft" @click="goReport"><text class="banner-btn-text banner-btn-soft-text">查看画像</text></view>
        </view>

        <view v-if="reportContextNotice" class="report-context-card">
          <view class="report-context-main">
            <text class="report-context-title">{{ reportContextNotice.title }}</text>
            <text class="report-context-sub">{{ reportContextNotice.subtitle }}</text>
          </view>
          <view class="report-context-side">
            <text class="report-context-tag">{{ reportContextNotice.tag }}</text>
            <text v-if="reportContextNotice.canUseLatest" class="report-context-link" @click="useLatestReport">用最新报告</text>
          </view>
        </view>

        <view v-if="matchMessageNotice" class="match-message-card">
          <view class="match-message-main">
            <text class="match-message-title">{{ matchMessageNotice.title }}</text>
            <text class="match-message-sub">{{ matchMessageNotice.subtitle }}</text>
          </view>
          <view class="match-message-side">
            <text class="match-message-tag">{{ matchMessageNotice.tag }}</text>
            <text class="match-message-link" @click="goMessageCenter">返回消息</text>
          </view>
        </view>

        <view v-if="consultationNotice" class="consult-status-card">
          <view class="consult-status-main">
            <text class="consult-status-title">{{ consultationNotice.title }}</text>
            <text class="consult-status-sub">{{ consultationNotice.subtitle }}</text>
          </view>
          <view class="consult-status-side">
            <text class="consult-status-tag">{{ consultationNotice.tag }}</text>
            <text class="consult-status-link" @click="goAdvisor">查看进度</text>
          </view>
        </view>

        <view v-if="supplementNotice" class="supplement-card">
          <view class="supplement-main">
            <text class="supplement-title">{{ supplementNotice.title }}</text>
            <text class="supplement-sub">{{ supplementNotice.subtitle }}</text>
          </view>
          <view class="supplement-btn" @click="goSupplementMaterials"><text class="supplement-btn-text">{{ supplementNotice.action }}</text></view>
        </view>

        <view class="summary-grid">
          <view class="summary-cell">
            <text class="summary-value">{{ products.length }}</text>
            <text class="summary-label">{{ productGateLocked ? '已开放方案' : '可看方案' }}</text>
          </view>
          <view class="summary-cell">
							<text class="summary-value" :class="{ 'summary-hot': productGateLocked ? supplementReadyCount >= 3 : bestMatch != null && bestMatch >= 80 }">{{ productGateLocked ? supplementReadyText : (bestMatch == null ? '--' : bestMatch) }}</text>
            <text class="summary-label">{{ productGateLocked ? '材料进度' : SCORE_COPY.matchRate.maxLabel }}</text>
          </view>
          <view class="summary-cell">
							<text class="summary-value">{{ productGateLocked ? riskIssueCount : (highMatchCount == null ? '--' : highMatchCount) }}</text>
            <text class="summary-label">{{ productGateLocked ? '需关注问题' : '高匹配' }}</text>
          </view>
        </view>

        <view v-if="!productGateLocked" class="filter-row">
          <view class="filter-chip" :class="{ 'filter-chip-on': filterMode === 'all' }" @click="filterMode = 'all'">
            <text class="filter-text" :class="{ 'filter-text-on': filterMode === 'all' }">全部</text>
          </view>
          <view class="filter-chip" :class="{ 'filter-chip-on': filterMode === 'high' }" @click="filterMode = 'high'">
            <text class="filter-text" :class="{ 'filter-text-on': filterMode === 'high' }">高匹配</text>
          </view>
          <view class="filter-chip" :class="{ 'filter-chip-on': filterMode === 'stable' }" @click="filterMode = 'stable'">
            <text class="filter-text" :class="{ 'filter-text-on': filterMode === 'stable' }">稳妥优先</text>
          </view>
        </view>

        <view v-if="matchNotice && (products.length || productGateLocked)" class="notice-card" :class="{ 'notice-card-locked': productGateLocked }">
          <text class="notice-title">{{ matchNotice.title }}</text>
          <text class="notice-sub">{{ matchNotice.summary }}</text>
          <view v-if="matchNotice.reasons && matchNotice.reasons.length" class="notice-reasons">
            <text v-for="(r, ri) in matchNotice.reasons" :key="ri" class="notice-reason">· {{ r }}</text>
          </view>
          <view v-if="matchNotice.nextActions && matchNotice.nextActions.length" class="notice-actions">
            <text class="notice-actions-title">下一步</text>
            <text v-for="(r, ri) in matchNotice.nextActions" :key="'a' + ri" class="notice-reason">· {{ r }}</text>
          </view>
        </view>

        <view v-if="!filteredProducts.length" class="state-card">
          <text class="state-title">{{ emptyStateTitle }}</text>
          <text class="state-sub">{{ emptyStateSub }}</text>
          <view v-if="!products.length && matchNotice && matchNotice.reasons && matchNotice.reasons.length" class="state-reasons">
            <text v-for="(r, ri) in matchNotice.reasons" :key="ri" class="state-reason">· {{ r }}</text>
          </view>
          <view class="state-btn" @click="handleEmptyAction"><text class="state-btn-text">{{ emptyActionText }}</text></view>
        </view>

        <view v-for="(p, i) in filteredProducts" :key="p.id || i" class="prod-card">
          <view class="prod-head" @click="toggle(p.id)">
            <view class="prod-main">
              <text class="prod-name">{{ p.name }}</text>
              <text class="prod-inst">{{ p.institution }}</text>
            </view>
            <view class="match-badge" :style="{ background: rateBg(p.matchRate) }">
								<text class="match-num" :style="{ color: rateColor(p.matchRate) }">{{ matchRateOfProduct(p) == null ? '待核对' : matchRateOfProduct(p) }}</text>
								<text v-if="matchRateOfProduct(p) != null" class="match-pct" :style="{ color: rateColor(p.matchRate) }">% 匹配</text>
            </view>
          </view>

          <view class="prod-kv">
            <view class="kv"><text class="kv-label">参考利率</text><text class="kv-val">{{ p.rateText || '详询' }}</text></view>
            <view class="kv"><text class="kv-label">额度</text><text class="kv-val">{{ p.amountText || '详询' }}</text></view>
            <view class="kv"><text class="kv-label">期限</text><text class="kv-val">{{ p.termText || '详询' }}</text></view>
          </view>

          <view v-if="p.tags && p.tags.length" class="tag-wrap">
            <view v-for="(t, ti) in p.tags" :key="ti" class="tag"><text class="tag-text">{{ t }}</text></view>
          </view>

          <view v-if="p.matchReasons && p.matchReasons.length" class="reasons">
            <text v-for="(r, ri) in p.matchReasons" :key="ri" class="reason-text">· {{ r }}</text>
          </view>

          <!-- 展开详情 -->
          <view v-if="expandedId === p.id" class="detail">
            <view v-if="detailOf(p).features.length" class="detail-block">
              <text class="detail-title">产品亮点</text>
              <view class="feat-wrap">
                <view v-for="(f, fi) in detailOf(p).features" :key="fi" class="feat">
                  <view class="feat-sym"><text class="feat-sym-text">{{ f.sym }}</text></view>
                  <view class="feat-main">
                    <text class="feat-name">{{ f.name }}</text>
                    <text class="feat-desc">{{ f.desc }}</text>
                  </view>
                </view>
              </view>
            </view>
            <view v-if="detailOf(p).conditions.length" class="detail-block">
              <text class="detail-title">申请条件</text>
              <text v-for="(c, ci) in detailOf(p).conditions" :key="ci" class="cond-text">· {{ c.text }}</text>
            </view>
            <view v-if="detailOf(p).steps.length" class="detail-block">
              <text class="detail-title">申请流程</text>
              <view v-for="(s, si) in detailOf(p).steps" :key="si" class="step">
                <text class="step-idx">{{ si + 1 }}</text>
                <view class="step-main">
                  <text class="step-title">{{ s.title }}</text>
                  <text v-if="stepDescription(s)" class="step-desc">{{ stepDescription(s) }}</text>
                </view>
              </view>
            </view>
            <view v-if="!detailOf(p).features.length && !detailOf(p).conditions.length && !detailOf(p).steps.length" class="detail-block">
              <text class="detail-title">产品详情</text>
              <text class="cond-text">详细条件与流程以金融机构官方页面及最终审批为准。</text>
            </view>
          </view>

          <view class="prod-actions">
            <view class="act-ghost" @click="toggle(p.id)">
              <text class="act-ghost-text">{{ expandedId === p.id ? '收起详情' : '查看详情' }}</text>
            </view>
							<view class="act-primary" :class="{ disabled: matchRateOfProduct(p) == null }" @click="contactService(p)">
								<text class="act-primary-text">{{ matchRateOfProduct(p) == null ? '匹配度待核对' : contactSubmittingId === (p.id || p.name) ? '提交中' : '咨询申请' }}</text>
            </view>
          </view>
        </view>

        <view class="disclaimer">
          <text class="disclaimer-text">匹配结果由服务端基于已验证征信事实和确定性规则计算，仅供参考；最终额度、利率与是否通过以金融机构审批为准。</text>
        </view>
        <view class="bottom-safe rpt-page-bottom"></view>
      </view>
    </scroll-view>
  </view>
</template>

<script setup>
import { computed, ref } from 'vue'
import { onShow } from '@/compat/web-lifecycle.js'
import { matchProducts } from '@/services/deepseekService.js'
import { getLatestReportAsync, getReportAnalysisDate, getReportAsync, getReportCustomerName, getReportList } from '@/services/reportStorage.js'
import { getCachedUserInfo } from '@/services/authService.js'
import { clearMatchReportContext, inspectMatchReportContext } from '@/services/reportMatchContext.js'
import { createAdvisorContact, openAdvisorConversation, resolveAdvisorContactId, saveMessageActionReceiptRemote } from '@/services/profileService.js'
import { readLastConsultationStatus, saveLastConsultationStatus } from '@/services/userConsultationStatus.js'
import { saveMessageActionReceipt, syncMessageActionReceipt } from '@/services/messageCenter.js'
import safeSwitchTab from '@/utils/safeSwitchTab.js'
import { SCORE_COPY, matchRateText, reportScoreText } from '@/utils/scorePresentation.js'
import { resolveV6TotalFromAnalysis } from '@/services/scoreV6.js'
import { decisionReportIdOf, decisionServerReportIdOf, resolveDecisionReportIdAliases } from '@/services/decisionTrust.js'
import { appendKnownReportScore, filterProductsByKnownMatchRate, matchRateOfProduct, matchRateOrNull, reportScoreOrNull, summarizeKnownMatchRates } from '@/services/matchPresentation.js'

const products = ref([])
const matchResultsKnown = ref(false)
const hasReport = ref(false)
const expandedId = ref('')
const filterMode = ref('all')
const matchNotice = ref(null)
const activeReport = ref(null)
const activeMatchContext = ref(null)
const contactSubmittingId = ref('')
const lastConsultation = ref(null)
const matchMessageLandedId = ref('')
const supplementProfile = ref(null)
let loadGeneration = 0

const rateColor = (r) => {
	const rate = matchRateOrNull(r)
	return rate == null ? '#64748B' : rate < 50 ? '#DC2626' : rate <= 70 ? '#D97706' : '#086CEA'
}
const rateBg = (r) => {
	const rate = matchRateOrNull(r)
	return rate == null ? '#F1F5F9' : rate < 50 ? '#FEF2F2' : rate <= 70 ? '#FFFBEB' : '#EAF3FF'
}
const matchRateSummary = computed(() => summarizeKnownMatchRates(products.value, matchResultsKnown.value))
const bestMatch = computed(() => matchRateSummary.value.best)
const highMatchCount = computed(() => matchRateSummary.value.highCount)
const productGateLocked = computed(() => !!(hasReport.value && supplementProfile.value && supplementProfile.value.productMatchBlocked === true))
const supplementReadyCount = computed(() => Number(supplementProfile.value && supplementProfile.value.productUnlockCompletedCount || 0))
const supplementReadyText = computed(() => supplementProfile.value && supplementProfile.value.unlockProgressText ? supplementProfile.value.unlockProgressText : '0/4')
const riskIssueCount = computed(() => {
	if (!matchNotice.value || !Array.isArray(matchNotice.value.reasons)) return '--'
	return matchNotice.value.reasons.length
})
const bannerTitle = computed(() => {
  if (!hasReport.value) return '先建档，再做精准匹配'
  if (productGateLocked.value) return '先看征信问题，再确认材料'
  return '按完整画像排序的方案'
})
const bannerSubtitle = computed(() => {
  if (!hasReport.value) return '上传报告后会先展示综合分、查询、负债和风险项。'
  if (productGateLocked.value) return '当前只展示征信风险与下一步建议；有材料就上传，没有就选择暂无，确认后按真实条件匹配。'
  return '已结合征信报告与材料有无情况，优先展示匹配度高、查询成本更可控的选项。'
})
const filteredProducts = computed(() => {
  if (productGateLocked.value) return []
	return filterProductsByKnownMatchRate(products.value, filterMode.value)
})
const emptyStateTitle = computed(() => {
  if (!products.value.length && matchNotice.value) return matchNotice.value.title
  return '暂无符合当前筛选的方案'
})
const emptyStateSub = computed(() => {
  if (!products.value.length && matchNotice.value) return matchNotice.value.summary
  return '可以切回全部查看，或先上传最新信用报告刷新画像。'
})
const emptyActionText = computed(() => {
  if (!hasReport.value) return activeMatchContext.value && activeMatchContext.value.reportId ? '选择最新报告' : '上传报告'
  return !products.value.length ? '补充材料' : '查看全部'
})
const supplementNotice = computed(() => {
  const profile = supplementProfile.value
  if (!hasReport.value || !profile) return null
  if (profile.productMatchBlocked) {
    const missing = Array.isArray(profile.productUnlockMissing) && profile.productUnlockMissing.length ? profile.productUnlockMissing.join('、') : '材料情况'
    return {
      title: `产品匹配待确认 · ${profile.unlockProgressText || '0/4'}`,
      subtitle: `还需确认${missing}。有就上传，没有就选择暂无，确认后再保守匹配。`,
      action: '确认材料'
    }
  }
  return {
    title: `材料画像已纳入 · ${profile.confidenceText}`,
    subtitle: profile.summary || '产品已按完整画像重新排序，仍需以机构审批为准。',
    action: '管理'
  }
})
const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== '')
const reportDateOf = (report) => {
	const value = first(
		getReportAnalysisDate(report || {}),
		activeMatchContext.value && activeMatchContext.value.reportDate,
		activeMatchContext.value && activeMatchContext.value.date
	)
	if (!value) return ''
  const s = String(value)
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s.slice(0, 10)
}
const reportScoreOf = (report) => {
  const analysis = report && (report.analysisData || report.analysisResult)
  const resolved = resolveV6TotalFromAnalysis(analysis, report?.decisionTrust || null, decisionReportIdOf(report))
  const raw = resolved
	const n = reportScoreOrNull(raw)
	return n == null ? '' : String(Math.round(n))
}
const latestReportId = computed(() => {
  try { return getReportList().find((row) => row && row.id)?.id || '' } catch (e) { return '' }
})
const reportContextNotice = computed(() => {
  if (!hasReport.value || !activeReport.value) return null
  const isPinned = Boolean(activeMatchContext.value && activeMatchContext.value.reportId === activeReport.value.id)
  const fromMessage = Boolean(activeMatchContext.value && activeMatchContext.value.source === 'message-detail')
  const reportType = first(activeReport.value.reportType, activeMatchContext.value && activeMatchContext.value.reportType, '信用报告')
  const date = reportDateOf(activeReport.value)
  const score = reportScoreOf(activeReport.value)
  return {
    title: isPinned ? '基于当前信用报告匹配' : '基于最新信用报告匹配',
		subtitle: `${reportType} · ${date ? `报告日 ${date}` : '报告日待核对'}${score ? ` · ${reportScoreText(score)}` : ''}`,
    tag: fromMessage ? '消息进入' : isPinned ? '详情页进入' : '最新报告',
    canUseLatest: isPinned && latestReportId.value && latestReportId.value !== activeReport.value.id
  }
})
const matchMessageContext = computed(() => activeMatchContext.value && activeMatchContext.value.messageContext ? activeMatchContext.value.messageContext : null)
const matchMessageNotice = computed(() => {
  const context = matchMessageContext.value
  if (!context || !context.messageId) return null
  return {
    title: `来自消息 · ${context.sourceTitle || '信用报告消息'}`,
    subtitle: '已延续到智能匹配，提交咨询后会记录处理完成。',
    tag: '消息定位'
  }
})
const consultationNotice = computed(() => {
  const item = lastConsultation.value
  if (!item) return null
  const productName = first(item.productName, '匹配方案')
  const reportTitle = first(item.reportTitle, '信用报告')
  const score = first(item.reportScore, '')
  const matchText = matchRateText(item.matchRate) || '匹配方案'
	const baseSubtitle = `${productName} · ${matchText} · 基于 ${reportTitle}`
	return {
    title: '咨询申请已提交',
		subtitle: appendKnownReportScore(baseSubtitle, score, reportScoreText),
    tag: first(item.statusText, '待顾问处理')
  }
})

const toggle = (id) => { expandedId.value = expandedId.value === id ? '' : id }

const detailOf = (p = {}) => ({
  features: Array.isArray(p.features) && p.features.length
    ? p.features.map((item) => typeof item === 'string' ? { sym: '·', name: item, desc: '' } : item).filter(Boolean)
    : (p.sourceNote ? [{ sym: '✓', name: '官方产品说明', desc: String(p.sourceNote) }] : []),
  conditions: Array.isArray(p.conditions) && p.conditions.length
    ? p.conditions.map((item) => typeof item === 'string' ? { text: item } : item).filter(Boolean)
    : [
        ...(p.eligibilityText ? [{ text: String(p.eligibilityText) }] : []),
        ...(Array.isArray(p.requiredMaterials) && p.requiredMaterials.length
          ? [{ text: `常见材料：${p.requiredMaterials.map(String).join('、')}` }]
          : [])
      ],
  steps: Array.isArray(p.steps)
    ? p.steps.map((item) => typeof item === 'string' ? { title: item, desc: '', time: '' } : item).filter(Boolean)
    : []
})
const stepDescription = (step = {}) => [step.desc, step.time ? `（${step.time}）` : ''].filter(Boolean).join('')

const goUpload = () => uni.navigateTo({ url: '/pages/report/upload', fail: () => { uni.showToast({ title: '无法打开上传页', icon: 'none' }) } })
const goReport = () => {
  const reportId = activeReport.value && activeReport.value.id ? String(activeReport.value.id) : ''
  const context = matchMessageContext.value
  const query = []
  if (reportId) query.push(`id=${encodeURIComponent(reportId)}`)
  if (context && context.messageId) {
    query.push('from=message')
    query.push(`messageId=${encodeURIComponent(context.messageId)}`)
    query.push(`reportId=${encodeURIComponent(reportId || context.reportId || '')}`)
    query.push('focus=report')
  } else if (reportId) {
    query.push('from=match')
  }
  const suffix = query.length ? `?${query.join('&')}` : ''
  uni.navigateTo({ url: `/pages/report/detail${suffix}`, fail: () => { uni.showToast({ title: '无法打开报告页', icon: 'none' }) } })
}
const goAdvisor = () => {
  const item = lastConsultation.value || {}
  const query = []
  if (item.messageId) {
    query.push('from=message')
    query.push(`messageId=${encodeURIComponent(item.messageId)}`)
    if (item.id) query.push(`statusId=${encodeURIComponent(item.id)}`)
    if (item.reportId) query.push(`reportId=${encodeURIComponent(item.reportId)}`)
    query.push('focus=progress')
  }
  const suffix = query.length ? `?${query.join('&')}` : ''
  uni.navigateTo({ url: `/pages/profile/advisor${suffix}`, fail: () => { uni.showToast({ title: '无法打开顾问页', icon: 'none' }) } })
}
const goMessageCenter = () => safeSwitchTab('/pages/message/center')
const handleEmptyAction = () => {
  if (!hasReport.value && activeMatchContext.value && activeMatchContext.value.reportId) { useLatestReport(); return }
  if (!hasReport.value) { goUpload(); return }
  if (!products.value.length && hasReport.value) { goSupplementMaterials(); return }
  filterMode.value = 'all'
}
const goSupplementMaterials = () => {
  uni.navigateTo({ url: '/pages/profile/supplement-materials', fail: () => { uni.showToast({ title: '无法打开补充材料页', icon: 'none' }) } })
}

const productKeyOf = (p) => String((p && (p.id || p.name)) || '')
const recordMatchMessageReceipt = (stage = 'landed', focus = 'match') => {
  const context = matchMessageContext.value
  if (!context || !context.messageId) return null
	const reportIds = resolveDecisionReportIdAliases([
		activeReport.value && activeReport.value.id,
		context.reportId
	], { requireMatch: true })
	const reportId = reportIds && reportIds.length ? reportIds[0] : ''
  const receipt = saveMessageActionReceipt({
    id: context.messageId,
    category: context.sourceCategory || 'system',
    title: context.sourceTitle || '信用报告消息',
    reportId,
    actionUrl: context.actionUrl || ''
  }, { stage, page: '/pages/match/index', focus, reportId, at: new Date().toISOString() })
  syncMessageActionReceipt(receipt, saveMessageActionReceiptRemote)
  return receipt
}
const recordMatchLanding = () => {
  const context = matchMessageContext.value
  if (!context || !context.messageId || matchMessageLandedId.value === context.messageId) return
  const receipt = recordMatchMessageReceipt('landed', 'match')
  if (receipt) matchMessageLandedId.value = context.messageId
}
const buildConsultationPayload = (p) => {
  const report = activeReport.value || {}
  const user = getCachedUserInfo() || {}
  const reportCustomerName = getReportCustomerName(report)
  const customerName = first(reportCustomerName, user.nickname, user.realName, user.userName, user.mobile ? `用户${String(user.mobile).slice(-4)}` : '客户')
  const customerPhone = first(user.mobile, user.phone, '')
	const reportIds = resolveDecisionReportIdAliases([
		report.id,
		activeMatchContext.value && activeMatchContext.value.reportId
	], { requireMatch: true })
	const reportId = reportIds && reportIds.length ? reportIds[0] : ''
  const reportType = first(report.reportType, activeMatchContext.value && activeMatchContext.value.reportType, '信用报告')
  const reportDate = reportDateOf(report)
  const reportScore = reportScoreOf(report)
  const productName = first(p && p.name, '匹配方案')
	const matchRate = matchRateOfProduct(p)
  const messageContext = matchMessageContext.value || null
  const supplement = supplementProfile.value || null
  const supplementMaterials = supplement && Array.isArray(supplement.materials) ? supplement.materials : []
	const summary = appendKnownReportScore(
		`${productName} · ${matchRate == null ? '匹配度待核对' : matchRateText(matchRate)} · ${reportType}`,
		reportScore,
		reportScoreText
	)
  return {
    source: 'match-page',
    sourceMessageId: messageContext && messageContext.messageId ? messageContext.messageId : '',
    messageId: messageContext && messageContext.messageId ? messageContext.messageId : '',
    sourceMessageTitle: messageContext && messageContext.sourceTitle ? messageContext.sourceTitle : '',
    sourceMessageFocus: messageContext && messageContext.sourceFocus ? messageContext.sourceFocus : '',
    messageContext,
    reportId,
    productId: first(p && p.id, ''),
    productName,
    name: customerName,
    clientName: customerName,
    userName: customerName,
    customerName,
    reportCustomerName,
    phone: customerPhone,
    mobile: customerPhone,
    institution: first(p && p.institution, ''),
    matchRate,
    channel: 'bank',
    deskType: 'bank',
    contactIntent: 'product-consultation',
    initialMessage: `我想咨询${productName}，请银行客户经理结合我的报告${supplementMaterials.length ? '和补充材料' : ''}给出办理建议。`,
    summary,
    supplementProfile: supplement,
    supplementMaterials,
    materials: supplementMaterials,
    reportTitle: first(report.fileName, reportType),
    reportScore,
    reportDate,
    product: {
      id: first(p && p.id, ''),
      name: productName,
      institution: first(p && p.institution, ''),
      matchRate,
      rateText: first(p && p.rateText, ''),
      amountText: first(p && p.amountText, ''),
      termText: first(p && p.termText, ''),
      tags: Array.isArray(p && p.tags) ? p.tags : [],
      matchReasons: Array.isArray(p && p.matchReasons) ? p.matchReasons : []
    },
    report: {
      id: reportId,
      title: first(report.fileName, reportType),
      reportType,
      date: reportDate,
      scoreText: reportScore,
      cloudReportId: first(report.cloudReportId, report.serverReportId, report.syncMeta && report.syncMeta.cloudReportId, '')
    },
    match: {
      source: activeMatchContext.value ? 'detail-pinned-report' : 'latest-report',
      filterMode: filterMode.value,
      bestMatch: bestMatch.value,
      highMatchCount: highMatchCount.value
    },
    createdAt: new Date().toISOString()
  }
}
const saveConsultationStatus = (payload, response) => {
  lastConsultation.value = saveLastConsultationStatus(payload, response)
}
const showConsultModal = (p, synced, contactPayload = '') => {
	const payload = buildConsultationPayload(p)
	const contactId = resolveAdvisorContactId(contactPayload)
	uni.showModal({
    title: synced ? '咨询申请已记录' : '咨询记录同步失败',
    content: synced
		? `产品：${payload.productName}\n依据：${payload.reportTitle}${payload.reportScore !== '' && payload.reportScore != null ? ` · ${reportScoreText(payload.reportScore)}` : ''}\n已进入银行经理端待处理。`
      : `本次报告与产品上下文尚未同步到银行经理端，请稍后重试。\n产品：${payload.productName}`,
    confirmText: synced ? '进入会话' : '知道了',
	    cancelText: synced ? '稍后查看' : '返回',
	    success: (res) => {
	      if (res.confirm && synced && contactId) {
	        openAdvisorConversation(contactPayload)
	      }
	    }
	  })
}
const contactService = async (p) => {
  if (productGateLocked.value) {
    goSupplementMaterials()
    return
  }
	if (matchRateOfProduct(p) == null) {
		uni.showToast({ title: '匹配度待服务端核对，暂不能提交咨询', icon: 'none' })
		return
	}
  const key = productKeyOf(p)
  if (contactSubmittingId.value) return
  contactSubmittingId.value = key
  const payload = buildConsultationPayload(p)
  try {
	    const response = await createAdvisorContact('', payload.reportId, 'match-product', payload)
	    saveConsultationStatus(payload, response)
	    recordMatchMessageReceipt('handled', 'consultation-submit')
	    showConsultModal(p, true, response)
  } catch (e) {
    showConsultModal(p, false)
  } finally {
    contactSubmittingId.value = ''
  }
}

const resolveMatchReport = async () => {
  const inspected = inspectMatchReportContext()
  if (inspected.present && inspected.invalid) {
    return { report: null, context: inspected.context || { reportId: '__invalid__' } }
  }
  const context = inspected.context
  if (context && context.reportId) {
    let report = null
    try { report = await getReportAsync(context.reportId) } catch (e) { return { report: null, context } }
    if (report && report.analysisData) return { report, context }
    // A report-specific entry point must never drift to another month/customer.
    // Keep the failed context visible and require an explicit user choice.
    return { report: null, context }
  }
  const report = await getLatestReportAsync()
  return { report, context: null }
}
const serverReportIdOf = (report) => decisionServerReportIdOf(report)
const supplementProfileFromGate = (gate, locked) => {
  const source = gate && typeof gate === 'object' && !Array.isArray(gate) ? gate : {}
  const completed = Array.isArray(source.completedGroups) ? source.completedGroups : []
  const missing = Array.isArray(source.missing) ? source.missing : []
  const evidence = source.evidence && typeof source.evidence === 'object' ? source.evidence : {}
  return {
    profileVersion: String(source.version || 'server-reviewed-materials-v1'),
    productMatchBlocked: locked === true,
    productMatchUnlocked: locked !== true && source.unlocked === true,
    productUnlockCompletedCount: completed.length,
    productUnlockTotalCount: 4,
    productUnlockMissing: missing,
    unlockProgressText: `${completed.length}/4`,
    hasStableIncomeEvidence: evidence.stableIncome === true,
    hasAssetEvidence: evidence.asset === true,
    hasBusinessEvidence: evidence.business === true,
    confidenceText: source.unlocked === true ? '服务端材料流程已确认' : '材料待确认',
    summary: source.unlocked === true
      ? '服务端已确认材料流程；正向收入、资产与经营事实仍以复核证据为准。'
      : '请先完成服务端材料确认流程。'
  }
}
const load = async () => {
  const generation = ++loadGeneration
  // Clear the previous report synchronously. A slow same-session reload must
  // never leave another month/customer's decision visible while awaiting I/O.
  activeReport.value = null
  activeMatchContext.value = null
  hasReport.value = false
  products.value = []
	matchResultsKnown.value = false
  supplementProfile.value = null
  matchNotice.value = null
  expandedId.value = ''
  filterMode.value = 'all'
  lastConsultation.value = readLastConsultationStatus()
  let resolved = null
  try {
    resolved = await resolveMatchReport()
  } catch (e) {
    resolved = { report: null, context: null }
  }
  if (generation !== loadGeneration) return
  activeReport.value = resolved.report || null
  activeMatchContext.value = resolved.context || null
  hasReport.value = Boolean(activeReport.value && activeReport.value.analysisData)
  const serverReportId = serverReportIdOf(activeReport.value)
  if (!hasReport.value || !serverReportId) {
    products.value = []
    supplementProfile.value = null
    matchNotice.value = !hasReport.value && activeMatchContext.value && activeMatchContext.value.reportId
      ? {
          title: '指定报告已不可用',
          summary: '当前入口绑定的报告无法读取，系统没有自动切换到其他客户或月份。请明确选择最新报告，或重新上传。',
          reasons: []
        }
      : hasReport.value
      ? {
          title: '报告尚未完成云端证据绑定',
          summary: '当前仅有本机或历史正文，不能用于产品决策；请重新分析并完成云端保存。',
          reasons: []
        }
      : null
    expandedId.value = ''
    filterMode.value = 'all'
    recordMatchLanding()
    return
  }
  try {
    const result = await matchProducts({ reportId: serverReportId })
    if (generation !== loadGeneration || serverReportIdOf(activeReport.value) !== serverReportId) return
		const productRows = Array.isArray(result.products) ? result.products : []
		const productRatesValid = result.locked === true || (
			Array.isArray(result.products) && productRows.every((product) => matchRateOfProduct(product) != null)
		)
		const trustedEnvelope = (
      result.reportId === serverReportId &&
      result.evidenceVerified === true &&
			result.decisionEligible === true &&
			productRatesValid
    )
		matchResultsKnown.value = trustedEnvelope
		products.value = trustedEnvelope && result.locked !== true ? [...productRows] : []
    supplementProfile.value = trustedEnvelope
      ? supplementProfileFromGate(result.materialGate, result.locked)
      : null
    matchNotice.value = trustedEnvelope && result.locked === true
      ? {
          title: result.notice?.title || '已读取征信问题，待确认材料情况',
          summary: result.notice?.summary || '请先完成材料确认，再由服务端进行产品匹配。',
          reasons: Array.isArray(result.notice?.missing) ? result.notice.missing : []
        }
      : (trustedEnvelope ? null : {
          title: '匹配证据校验未通过',
          summary: '服务端未确认当前报告的完整证据链，已停止产品匹配。',
          reasons: []
        })
  } catch (e) {
    if (generation !== loadGeneration || serverReportIdOf(activeReport.value) !== serverReportId) return
    products.value = []
		matchResultsKnown.value = false
    matchNotice.value = {
      title: '云端匹配未完成',
      summary: String(e?.message || '报告已读取，但服务端匹配未完成，请稍后重试或重新分析报告。'),
      reasons: []
    }
    supplementProfile.value = null
  }
  expandedId.value = ''
  filterMode.value = 'all'
  recordMatchLanding()
}
const useLatestReport = () => {
  clearMatchReportContext()
  void load()
  uni.showToast({ title: '正在读取最新报告', icon: 'none' })
}

onShow(() => { void load() })
</script>

<style scoped>
.page { min-height: 100vh; background: #F3F7FF; }
.nav { align-items: center; padding: calc(var(--rpt-safe-top) + 10px) 14px 10px; background: #F6F9FF; border-bottom: 1px solid rgba(214, 226, 245, 0.8); }
.nav-title { font-size: 16px; font-weight: 900; color: #071B3D; }
.scroll-body { flex: 1; height: 100vh; }
.wrap { padding: 16px; }

.banner { background: linear-gradient(180deg, #FFFFFF 0%, #EEF6FF 100%); border-radius: 8px; padding: 16px; margin-bottom: 12px; border: 1px solid #DCEBFF; flex-direction: row; align-items: center; box-shadow: 0 10px 24px rgba(23, 83, 156, 0.07); }
.banner-copy { flex: 1; margin-right: 10px; }
.banner-title { display: block; font-size: 16px; font-weight: 800; color: #fff; }
.banner .banner-title { color: #111827; }
.banner-sub { display: block; margin-top: 6px; font-size: 12px; color: #6B7280; line-height: 1.45; }
.banner-btn { align-self: center; background: #086CEA; border-radius: 8px; padding: 9px 13px; }
.banner-btn-text { color: #fff; font-size: 13px; font-weight: 900; }
.banner-btn-soft { background: #EAF3FF; border: 1px solid #BFDBFE; }
.banner-btn-soft-text { color: #086CEA; }

.report-context-card { background: #fff; border-radius: 8px; border: 1px solid #BBF7D0; background-color: #F0FDF4; padding: 12px 13px; margin-bottom: 12px; flex-direction: row; align-items: center; }
.report-context-main { flex: 1; margin-right: 10px; }
.report-context-title { font-size: 14px; color: #111827; font-weight: 900; }
.report-context-sub { margin-top: 4px; font-size: 12px; color: #64748B; line-height: 1.45; }
.report-context-side { align-items: flex-end; }
.report-context-tag { font-size: 12px; color: #15803D; font-weight: 900; background: rgba(255,255,255,0.8); border-radius: 8px; padding: 5px 8px; }
.report-context-link { margin-top: 7px; font-size: 12px; color: #086CEA; font-weight: 900; }
.match-message-card { background: #111827; border-radius: 8px; border: 1px solid #111827; padding: 12px 13px; margin-bottom: 12px; flex-direction: row; align-items: center; }
.match-message-main { flex: 1; margin-right: 10px; }
.match-message-title { font-size: 14px; color: #fff; font-weight: 900; }
.match-message-sub { margin-top: 4px; font-size: 12px; color: #CBD5E1; line-height: 1.45; }
.match-message-side { align-items: flex-end; }
.match-message-tag { font-size: 12px; color: #FDE68A; font-weight: 900; background: rgba(255,255,255,0.08); border-radius: 8px; padding: 5px 8px; }
.match-message-link { margin-top: 7px; font-size: 12px; color: #fff; font-weight: 900; }
.consult-status-card { background: #fff; border-radius: 8px; border: 1px solid #BFDBFE; background-color: #EFF6FF; padding: 12px 13px; margin-bottom: 12px; flex-direction: row; align-items: center; }
.consult-status-main { flex: 1; margin-right: 10px; }
.consult-status-title { font-size: 14px; color: #111827; font-weight: 900; }
.consult-status-sub { margin-top: 4px; font-size: 12px; color: #475569; line-height: 1.45; }
.consult-status-side { align-items: flex-end; }
.consult-status-tag { font-size: 12px; color: #1D4ED8; font-weight: 900; background: rgba(255,255,255,0.85); border-radius: 8px; padding: 5px 8px; }
.consult-status-link { margin-top: 7px; font-size: 12px; color: #086CEA; font-weight: 900; }
.supplement-card { background: #fff; border-radius: 8px; border: 1px solid #BFDBFE; background-color: #F4F8FF; padding: 12px 13px; margin-bottom: 12px; flex-direction: row; align-items: center; }
.supplement-main { flex: 1; margin-right: 10px; }
.supplement-title { font-size: 14px; color: #071B3D; font-weight: 900; }
.supplement-sub { margin-top: 4px; font-size: 12px; color: #475569; line-height: 1.45; }
.supplement-btn { min-width: 64px; height: 34px; border-radius: 8px; background: #086CEA; align-items: center; justify-content: center; padding: 0 12px; }
.supplement-btn-text { font-size: 12px; color: #FFFFFF; font-weight: 900; }
.summary-grid { flex-direction: row; margin-bottom: 12px; }
.summary-cell { flex: 1; background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; padding: 12px 6px; align-items: center; margin-right: 8px; }
.summary-cell:last-child { margin-right: 0; }
.summary-value { font-size: 22px; color: #111827; font-weight: 900; }
.summary-hot { color: #16A34A; }
.summary-label { margin-top: 3px; font-size: 11px; color: #9CA3AF; }

.filter-row { flex-direction: row; margin-bottom: 12px; }
.filter-chip { height: 34px; padding: 0 14px; border-radius: 8px; background: #fff; border: 1px solid #EEF0F4; align-items: center; justify-content: center; margin-right: 8px; }
.filter-chip-on { background: #086CEA; border-color: #086CEA; }
.filter-text { font-size: 12px; color: #4B5563; font-weight: 800; }
.filter-text-on { color: #fff; }

.prod-card { background: #fff; border-radius: 8px; padding: 16px; margin-bottom: 12px; border: 1px solid #EEF0F4; }
.prod-head { flex-direction: row; align-items: center; justify-content: space-between; }
.prod-main { flex: 1; }
.prod-name { display: block; font-size: 16px; font-weight: 800; color: #111827; }
.prod-inst { display: block; margin-top: 4px; font-size: 12px; color: #9CA3AF; }
.match-badge { border-radius: 8px; padding: 6px 12px; align-items: center; flex-direction: row; }
.match-num { font-size: 20px; font-weight: 900; }
.match-pct { font-size: 11px; font-weight: 700; margin-top: 6px; margin-left: 2px; }

.prod-kv { flex-direction: row; margin-top: 14px; }
.kv { flex: 1; }
.kv-label { display: block; font-size: 11px; color: #9CA3AF; }
.kv-val { display: block; margin-top: 4px; font-size: 13px; font-weight: 700; color: #111827; }

.tag-wrap { flex-direction: row; flex-wrap: wrap; margin-top: 12px; }
.tag { background: #F1F3F6; border-radius: 6px; padding: 4px 9px; margin-right: 8px; margin-bottom: 6px; }
.tag-text { font-size: 11px; color: #6B7280; }

.reasons { margin-top: 8px; }
.reason-text { display: block; font-size: 12px; color: #D97706; line-height: 1.7; }

.detail { margin-top: 14px; padding-top: 14px; border-top: 1px solid #F3F4F6; }
.detail-block { margin-bottom: 14px; }
.detail-title { display: block; font-size: 13px; font-weight: 800; color: #374151; margin-bottom: 8px; }
.feat-wrap { }
.feat { flex-direction: row; align-items: center; margin-bottom: 8px; }
.feat-sym { width: 28px; height: 28px; border-radius: 8px; background: #EAF3FF; align-items: center; justify-content: center; margin-right: 10px; border: 1px solid #BFDBFE; }
.feat-sym-text { font-size: 13px; font-weight: 900; color: #086CEA; }
.feat-main { flex: 1; }
.feat-name { display: block; font-size: 13px; font-weight: 700; color: #111827; }
.feat-desc { display: block; margin-top: 2px; font-size: 11px; color: #9CA3AF; }
.cond-text { display: block; font-size: 12px; color: #4B5563; line-height: 1.8; }
.step { flex-direction: row; align-items: flex-start; margin-bottom: 8px; }
.step-idx { width: 20px; height: 20px; border-radius: 8px; background: #EAF3FF; color: #086CEA; font-size: 12px; font-weight: 800; text-align: center; line-height: 20px; margin-right: 10px; }
.step-main { flex: 1; }
.step-title { display: block; font-size: 13px; font-weight: 700; color: #111827; }
.step-desc { display: block; margin-top: 2px; font-size: 11px; color: #9CA3AF; }

.prod-actions { flex-direction: row; margin-top: 14px; }
.act-ghost { flex: 1; height: 42px; border: 1px solid #D1D5DB; border-radius: 8px; align-items: center; justify-content: center; margin-right: 10px; }
.act-ghost-text { font-size: 14px; color: #374151; font-weight: 700; }
.act-primary { flex: 1; height: 42px; background: #086CEA; border-radius: 8px; align-items: center; justify-content: center; }
.act-primary.disabled { background: #94A3B8; }
.act-primary-text { font-size: 14px; color: #fff; font-weight: 800; }

.notice-card { background: #FFFBEB; border-radius: 8px; padding: 14px 16px; border: 1px solid #FDE68A; margin-bottom: 12px; }
.notice-title { display: block; font-size: 14px; font-weight: 900; color: #92400E; }
.notice-sub { display: block; margin-top: 6px; font-size: 12px; color: #B45309; line-height: 1.55; }
.notice-reasons { margin-top: 8px; }
.notice-actions { margin-top: 10px; padding-top: 9px; border-top: 1px solid rgba(253, 230, 138, 0.9); }
.notice-actions-title { font-size: 12px; color: #92400E; font-weight: 900; margin-bottom: 4px; }
.notice-reason { display: block; font-size: 12px; color: #92400E; line-height: 1.6; }
.state-card { align-items: center; background: #fff; border-radius: 8px; padding: 30px 20px; border: 1px solid #EEF0F4; margin-bottom: 12px; }
.state-title { font-size: 16px; color: #111827; font-weight: 900; }
.state-sub { margin-top: 8px; font-size: 13px; color: #6B7280; text-align: center; line-height: 1.55; }
.state-reasons { width: 100%; margin-top: 12px; background: #F9FAFB; border-radius: 8px; padding: 10px 12px; }
.state-reason { display: block; font-size: 12px; color: #4B5563; line-height: 1.7; }
.state-btn { margin-top: 18px; padding: 10px 26px; border-radius: 8px; background: #086CEA; }
.state-btn-text { color: #fff; font-size: 14px; font-weight: 900; }

.disclaimer { padding: 8px 4px; }
.disclaimer-text { font-size: 11px; color: #B6BAC2; line-height: 1.6; }
.bottom-safe { height: 40px; }

/* ── 桌面端限宽+多栏卡片网格 ≥1024px ── */
@media (min-width: 1024px) {
  .wrap { padding: 20px 24px; }
  .summary-grid { margin-bottom: 16px; }
  .prod-card {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0 20px;
  }
  .prod-head { grid-column: 1 / -1; }
  .prod-kv { grid-column: 1 / -1; }
  .prod-actions { grid-column: 1 / -1; }
}
</style>
