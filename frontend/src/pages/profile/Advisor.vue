<template>
  <view class="page rpt-page">
    <view class="nav">
      <RptBackButton @click="goBack" />
      <text class="nav-title">我的顾问</text>
      <view class="nav-spacer"></view>
    </view>

    <scroll-view class="scroll-body" scroll-y>
      <view class="wrap rpt-content-narrow">
        <view class="advisor-card">
          <view class="avatar">
            <text class="avatar-text">顾</text>
          </view>
          <text class="advisor-name">{{ advisor.name }}</text>
          <text class="advisor-title">{{ advisor.jobTitle }}</text>
          <text class="advisor-spec">{{ advisor.specialization }}</text>
          <view v-if="hasRating" class="rating-row">
            <text class="rating-main">{{ advisor.rating }}</text>
            <text class="rating-sub">分 · {{ advisor.reviewCount }} 条评价</text>
          </view>
        </view>

        <view class="contact-card">
          <view class="contact-row" @click="callAdvisor">
            <view class="contact-main">
              <text class="contact-title">电话沟通</text>
              <text class="contact-sub">工作时间内优先接听</text>
            </view>
            <RptChevron class="contact-arrow" direction="right" />
          </view>
          <view class="divider"></view>
          <view class="contact-row" @click="messageAdvisor">
            <view class="contact-main">
              <text class="contact-title">在线咨询</text>
              <text class="contact-sub">查看消息与咨询进度</text>
            </view>
            <RptChevron class="contact-arrow" direction="right" />
          </view>
        </view>

        <view v-if="landingNotice" class="landing-card">
          <text class="landing-title">{{ landingNotice.title }}</text>
          <text class="landing-sub">{{ landingNotice.text }}</text>
        </view>

        <view class="section-head">
          <text class="section-title">服务记录</text>
          <text class="section-note">{{ serviceRecords.length ? serviceRecords.length + ' 条' : '暂无' }}</text>
        </view>

        <view v-if="loading" class="state-card">
          <text class="state-sub">加载中…</text>
        </view>

        <view v-else-if="!loggedIn" class="state-card">
          <text class="state-title">登录后查看服务记录</text>
          <text class="state-sub">预约、处理进度和顾问回复会同步到当前账号。</text>
          <view class="state-btn" @click="goLogin">
            <text class="state-btn-text">去登录</text>
          </view>
        </view>

        <view v-else-if="!serviceRecords.length" class="state-card">
          <text class="state-title">暂无服务记录</text>
          <text class="state-sub">你可以先预约一次咨询，顾问会结合报告给出下一步建议。</text>
        </view>

        <view v-else>
          <view v-for="record in serviceRecords" :key="record.id" class="record-card" :class="{ 'record-card-focus': record.focused }">
            <view v-if="record.focused" class="record-focus-line">
              <text class="record-focus-text">{{ record.landingHint }}</text>
              <text class="record-focus-status">已记录</text>
            </view>
            <view class="record-head">
              <text class="record-title">{{ record.title }}</text>
              <text class="record-status">{{ record.statusText }}</text>
            </view>
            <text class="record-time">{{ record.time }}</text>
            <text class="record-summary">{{ record.summary }}</text>
            <view v-if="record.meta && record.meta.length" class="record-meta">
              <text v-for="(item, idx) in record.meta" :key="idx" class="record-meta-item">{{ item }}</text>
            </view>
            <view v-if="record.progressAlert" class="record-alert" :class="'record-alert-' + record.progressAlert.level">
              <text class="record-alert-title">{{ record.progressAlert.title }}</text>
              <text class="record-alert-text">{{ record.progressAlert.text }}</text>
            </view>
            <view v-if="record.nextStep" class="record-next">
              <text class="record-next-label">下一步</text>
              <text class="record-next-text">{{ record.nextStep }}</text>
            </view>
            <view v-if="record.timeline && record.timeline.length" class="record-timeline">
              <view class="timeline-head">
                <text class="timeline-title">进度时间线</text>
                <text class="timeline-count">{{ record.timeline.length }} 步</text>
              </view>
              <view v-for="item in record.timeline" :key="item.key" class="timeline-row" :class="'timeline-row-' + item.state">
                <text class="timeline-dot"></text>
                <view class="timeline-main">
                  <view class="timeline-line">
                    <text class="timeline-item-title">{{ item.title }}</text>
                    <text v-if="item.time" class="timeline-time">{{ item.time }}</text>
                  </view>
                  <text v-if="item.desc" class="timeline-desc">{{ item.desc }}</text>
                </view>
              </view>
            </view>
            <view v-if="record.materials && record.materials.length" class="record-materials">
              <view class="record-material-head">
                <text class="record-material-title">{{ record.materialTitle }}</text>
                <text class="record-material-count">{{ record.materialSummary }}</text>
              </view>
              <view class="record-material-list">
                <view v-for="item in record.materials" :key="item.id" class="material-chip" :class="{ 'material-chip-review': item.isReview, 'material-chip-done': item.isDone, 'material-chip-reupload': item.isReupload }">
                  <view class="material-main">
                    <text class="material-name">{{ item.name }}</text>
                    <text v-if="item.fileName" class="material-file">{{ item.fileName }}</text>
                    <text v-if="item.reviewNote || item.note" class="material-note">{{ item.reviewNote || item.note }}</text>
                  </view>
                  <view class="material-side">
                    <text class="material-status">{{ item.statusText }}</text>
                    <text v-if="item.canUpload" class="material-upload" @click.stop="uploadMaterial(record, item)">{{ materialUploadingKey === materialKeyOf(record, item) ? '上传中' : '上传' }}</text>
                  </view>
                </view>
              </view>
            </view>
            <view class="record-actions">
              <view v-if="record.reportId" class="record-action" @click="goReport(record)">
                <text class="record-action-text">查看报告</text>
              </view>
              <view class="record-action record-action-soft" @click="messageAdvisor">
                <text class="record-action-soft-text">继续咨询</text>
              </view>
            </view>
          </view>
        </view>

        <view class="bottom-safe"></view>
      </view>
    </scroll-view>

    <view class="footer">
      <view class="book-btn" @click="bookConsult">
        <text class="book-btn-text">预约咨询</text>
      </view>
    </view>
  </view>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { onShow } from '@/compat/web-lifecycle.js'
import { isLoggedIn } from '@/services/authService.js'
import { createCustomerServiceContact, getAdvisorContacts, getAdvisorMy, openAdvisorConversation, saveMessageActionReceiptRemote, submitAdvisorContactMaterial } from '@/services/profileService.js'
import { uploadLocalFile } from '@/services/apiClient.js'
import { normalizeAdvisorContactContext } from '@/services/teacherContactContext.js'
import { buildAdvisorMaterialSubmitPayload, buildConsultationProgress, consultationStatusToContactRecord, markLastConsultationMaterialUploaded, readLastConsultationStatus, saveLastConsultationStatus, syncConsultationMaterialSubmit } from '@/services/userConsultationStatus.js'
import { readMessageCenterViewState, saveMessageActionReceipt, syncMessageActionReceipt } from '@/services/messageCenter.js'
import { debtExecutionRecordsToMaterials } from '@/services/debtExecution.js'
import safeSwitchTab from '@/utils/safeSwitchTab.js'
import safeBack from '@/utils/safeBack.js'
import { matchRateLabel, reportScoreText } from '@/utils/scorePresentation.js'
import { SERVICE_HOTLINE, SERVICE_HOURS } from '@/config/contact.js'
import RptBackButton from '@/components/RptBackButton.vue'
import RptChevron from '@/components/RptChevron.vue'

const route = useRoute()
const DEBT_ADVISOR_CONTEXT_KEY = 'debt_advisor_context'

const loggedIn = ref(false)
const loading = ref(false)
const advisor = ref({
  name: '平台顾问',
  jobTitle: '信用顾问 · 平台认证',
  specialization: '信用解读、负债结构优化、贷前规划',
  rating: '',
  reviewCount: 0,
  phone: SERVICE_HOTLINE
})
const serviceRecords = ref([])
const materialUploadingKey = ref('')
const lastRecordsSignature = ref('')
const suppressNextProgressToast = ref(false)
const landingTarget = ref(null)
const landingNotice = ref(null)
const advisorChatSubmitting = ref(false)

const hasRating = computed(() => advisor.value.rating !== '' && advisor.value.rating != null)

const queryText = (value) => Array.isArray(value) ? String(value[0] || '') : String(value || '')
const readDebtAdvisorContext = () => {
  const saved = uni.getStorageSync(DEBT_ADVISOR_CONTEXT_KEY)
  if (!saved) return null
  if (typeof saved === 'object') return saved
  if (typeof saved === 'string') {
    try {
      const parsed = JSON.parse(saved)
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch (e) {
      return null
    }
  }
  return null
}
const debtLandingText = (context, target) => {
  const goalTitle = context?.goal?.title || '债务优化目标'
  const debtTitle = context?.debt?.title || target.debtName || ''
  const totalDebt = context?.summary?.totalDebt || ''
  if (debtTitle) return `已带入 ${debtTitle} 和“${goalTitle}”，顾问会优先查看这笔债务。`
  if (totalDebt) return `已带入当前负债概览和“${goalTitle}”，顾问会按你的目标校准方案。`
  return `已带入“${goalTitle}”，可直接预约顾问继续处理。`
}
const syncLandingTarget = () => {
  const query = route.query || {}
  const from = queryText(query.from)
  const messageId = queryText(query.messageId)
  if (from === 'debt') {
    const debtContext = readDebtAdvisorContext()
    const target = {
      from: 'debt',
      reportId: queryText(query.reportId) || debtContext?.reportId || '',
      focus: queryText(query.focus) || 'debt',
      debtId: queryText(query.debtId) || debtContext?.debt?.id || '',
      debtName: queryText(query.debtName) || debtContext?.debt?.title || ''
    }
    landingTarget.value = target
    landingNotice.value = {
      title: '已带入债务优化目标',
      text: debtLandingText(debtContext, target)
    }
    return target
  }
  if (from !== 'message' || !messageId) {
    landingTarget.value = null
    landingNotice.value = null
    return null
  }
  const target = {
    from: 'message',
    messageId,
    statusId: queryText(query.statusId),
    reportId: queryText(query.reportId),
    focus: queryText(query.focus) || 'progress'
  }
  landingTarget.value = target
  landingNotice.value = {
    title: target.focus === 'materials' ? '已进入材料处理页' : '已进入咨询进度页',
    text: target.focus === 'materials' ? '下方已定位需要处理的咨询记录，可直接查看材料状态。' : '下方已定位咨询记录，可继续查看处理进度。'
  }
  const sourceState = readMessageCenterViewState()
  const sourceMatches = sourceState.sourceMessageId && String(sourceState.sourceMessageId) === String(target.messageId)
  const sourceReportId = target.reportId || (sourceMatches ? sourceState.reportId : '')
  const landedReceipt = saveMessageActionReceipt({
    id: target.messageId,
    category: sourceMatches ? sourceState.sourceCategory || 'consultation' : 'consultation',
    title: sourceMatches ? sourceState.sourceTitle || '消息提醒' : '咨询进度消息',
    statusId: target.statusId,
    reportId: sourceReportId,
    actionUrl: sourceMatches ? sourceState.actionUrl || '' : ''
  }, { stage: 'landed', page: '/pages/profile/advisor', focus: target.focus, reportId: sourceReportId })
  syncMessageActionReceipt(landedReceipt, saveMessageActionReceiptRemote)
  return target
}
const recordMatchesLandingTarget = (record) => {
  const target = landingTarget.value
  if (!target || !record) return false
  const ids = [record.id, record.statusId, record.sourceId, String(record.id || '').replace(/^local_/, '')].filter(Boolean).map(String)
  if (target.statusId && ids.includes(String(target.statusId))) return true
  return Boolean(target.reportId && record.reportId && String(target.reportId) === String(record.reportId))
}
const landingHintText = () => {
  if (landingTarget.value && landingTarget.value.from === 'debt') return '来自债务管理，查看债务优化咨询'
  return landingTarget.value && landingTarget.value.focus === 'materials' ? '来自关键咨询提醒，优先处理材料' : '来自消息提醒，查看当前进度'
}
const decorateLandingRecords = (records = []) => records.map((record) => {
  const focused = recordMatchesLandingTarget(record)
  return {
    ...record,
    focused,
    landingHint: focused ? landingHintText() : ''
  }
})

const statusText = (status, fallback = '') => {
  if (fallback) return fallback
  const map = { pending: '待处理', processing: '处理中', need_info: '待补充', completed: '已完成', cancelled: '已取消' }
  return map[status] || '待处理'
}

const materialNeedsUpload = (item) => item && ['待补充', '需重传'].includes(item.statusText)
const materialNeedsAction = (item) => item && !['已确认', '无需'].includes(item.statusText)
const materialUiState = (item) => ({
  ...item,
  isReview: item.statusText === '待确认',
  isReupload: item.statusText === '需重传',
  isDone: ['已确认', '无需'].includes(item.statusText),
  canUpload: materialNeedsUpload(item)
})
const materialNextStepText = (materials) => {
  const reuploadPending = materials.filter((item) => item.statusText === '需重传')
  if (reuploadPending.length) {
    const names = reuploadPending.slice(0, 3).map((item) => item.name).join('、')
    return `请重新上传${names}，顾问会重新复核。`
  }
  const uploadPending = materials.filter((item) => item.statusText === '待补充')
  if (uploadPending.length) {
    const names = uploadPending.slice(0, 3).map((item) => item.name).join('、')
    return `请优先补充${names}，补齐后顾问会继续确认方案。`
  }
  const reviewPending = materials.filter((item) => item.statusText === '待确认')
  if (reviewPending.length) return '材料已提交，等待顾问复核。'
  return ''
}
const materialKeyOf = (record, item) => `${record && record.id ? record.id : 'record'}_${item && item.id ? item.id : item && item.name ? item.name : 'material'}`

const nextStepText = (status) => {
  const map = {
    pending: '等待顾问确认需求，保持电话畅通。',
    processing: '顾问正在结合信用报告和匹配方案处理。',
    completed: '本次咨询已完成，可继续查看报告或发起新咨询。',
    cancelled: '本次咨询已取消，可重新预约。'
  }
  return map[status] || '等待顾问确认需求，保持电话畅通。'
}

const contactTypeText = (type) => {
  const map = { phone: '电话咨询', wechat: '微信咨询', appointment: '预约咨询', 'match-product': '产品咨询', 'debt-optimization': '债务优化' }
  return map[type] || '咨询记录'
}

const formatTime = (raw) => {
  if (!raw) return ''
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return String(raw).slice(0, 16)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const collectRecords = (payload) => {
  if (!payload) return []
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload.serviceRecords)) return payload.serviceRecords
  if (Array.isArray(payload.contacts)) return payload.contacts
  if (Array.isArray(payload.contactRecords)) return payload.contactRecords
  if (Array.isArray(payload.records)) return payload.records
  if (Array.isArray(payload.list)) return payload.list
  if (payload.data) return collectRecords(payload.data)
  return []
}

const normalizeRecord = (record, index) => {
  const context = normalizeAdvisorContactContext(record)
  const productName = context.productName || record.productName || ''
  const reportTitle = context.reportTitle || record.reportTitle || ''
  const reportScore = context.reportScore != null ? context.reportScore : record.reportScore
  const matchRate = context.matchRate != null ? context.matchRate : record.matchRate
  const materials = Array.isArray(context.materials) ? context.materials.map(materialUiState) : []
  const pendingMaterials = materials.filter(materialNeedsAction)
  const status = record.status || (pendingMaterials.length ? 'need_info' : 'pending')
  const displayStatusText = statusText(status, record.statusText || record.stateText || '')
  const progress = buildConsultationProgress({
    ...record,
    status,
    statusText: displayStatusText,
    productName,
    reportTitle,
    reportScore,
    matchRate,
    materials,
    createdAt: record.createdAt || record.createTime || record.time
  }) || {}
  const title = productName ? `咨询 ${productName}` : contactTypeText(record.contactType)
  const meta = [
    reportTitle ? `报告：${reportTitle}` : '',
    reportScoreText(reportScore),
    matchRateLabel(matchRate)
  ].filter(Boolean)
  const rawId = record.id || record._id || record.contactId || `record_${index}`
  return {
    id: rawId,
    sourceId: rawId,
    statusId: record.statusId || record.contactId || String(rawId).replace(/^local_/, ''),
    title,
    status,
    statusText: displayStatusText,
    time: formatTime(record.time || record.createTime || record.createdAt),
    summary: context.summary || record.summary || '顾问已收到你的咨询请求，将结合信用报告与当前状态处理。',
    reportId: context.reportId || record.reportId || '',
    reportTitle,
    reportScore,
    productName,
    institution: context.institution || record.institution || '',
    matchRate,
    meta,
    materials,
    materialTitle: pendingMaterials.length ? '待补材料' : '材料清单',
    materialSummary: materials.length ? `${pendingMaterials.length}/${materials.length} 待处理` : '',
    materialStats: progress.materialStats || null,
    progressAlert: progress.alert && progress.alert.level !== 'info' ? progress.alert : null,
    timeline: progress.timeline || [],
    nextStep: materialNextStepText(materials) || nextStepText(status)
  }
}

const uniqueRecords = (records) => {
  const seen = new Set()
  return records.filter((record) => {
    const key = [record.reportId || '', record.productName || '', record.time || '', record.title || record.id].join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const recordsSignature = (records) => records.map((record) => [
  record.id,
  record.statusText,
  (record.materials || []).map((item) => `${item.id || item.name}:${item.statusText}:${item.reviewedAt || item.uploadedAt || ''}`).join(',')
].join('|')).join('||')

const progressToastText = (records) => {
  const actionRecord = records.find((record) => record.progressAlert && ['danger', 'warning'].includes(record.progressAlert.level))
  if (actionRecord && actionRecord.progressAlert) return actionRecord.progressAlert.title
  const successRecord = records.find((record) => record.progressAlert && record.progressAlert.level === 'success')
  if (successRecord) return '材料复核已更新'
  return records.length ? '咨询进度已更新' : ''
}

const commitServiceRecords = (records) => {
  const signature = recordsSignature(records)
  if (lastRecordsSignature.value && signature !== lastRecordsSignature.value && !suppressNextProgressToast.value) {
    const tip = progressToastText(records)
    if (tip) uni.showToast({ title: tip, icon: 'none' })
  }
  suppressNextProgressToast.value = false
  lastRecordsSignature.value = signature
  serviceRecords.value = decorateLandingRecords(records)
}

const load = async () => {
  loggedIn.value = isLoggedIn()
  if (!loggedIn.value) {
    serviceRecords.value = []
    lastRecordsSignature.value = ''
    return
  }
  loading.value = true
  let data = null
  let contactsData = null
  try {
    data = await getAdvisorMy()
    const nextAdvisor = data?.advisor || data || null
    if (nextAdvisor) {
      advisor.value = {
        name: nextAdvisor.name || '平台顾问',
        jobTitle: nextAdvisor.jobTitle || '信用顾问 · 平台认证',
        specialization: nextAdvisor.specialization || '信用解读、负债结构优化、贷前规划',
        rating: nextAdvisor.rating == null ? '' : String(nextAdvisor.rating),
        reviewCount: nextAdvisor.reviewCount || 0,
        phone: nextAdvisor.phone || SERVICE_HOTLINE
      }
    }
  } catch (e) {
    data = null
  }
  try {
    contactsData = await getAdvisorContacts()
  } catch (e) {
    contactsData = null
  }
  try {
    const localRecord = consultationStatusToContactRecord(readLastConsultationStatus())
    const rawRecords = [
      ...(localRecord ? [localRecord] : []),
      ...collectRecords(data),
      ...collectRecords(contactsData)
    ]
    commitServiceRecords(uniqueRecords(rawRecords.map(normalizeRecord)))
  } finally {
    loading.value = false
  }
}

const callAdvisor = () => {
  const rawPhone = String(advisor.value.phone || SERVICE_HOTLINE || '')
  const phone = rawPhone.replace(/[-\s]/g, '')
  if (!/^\d{5,}$/.test(phone)) {
    messageAdvisor()
    return
  }
  uni.showModal({
    title: '拨打顾问热线',
    content: `电话：${rawPhone}\n服务时间：${SERVICE_HOURS}`,
    confirmText: '立即拨打',
    success: (res) => {
      if (res.confirm) uni.makePhoneCall({ phoneNumber: phone })
    }
  })
}

const messageAdvisor = () => {
  if (!loggedIn.value) {
    goLogin()
    return
  }
  openCustomerServiceChat({
    source: 'advisor-page-chat',
    contactIntent: 'advisor-chat',
    summary: '用户发起顾问文字咨询',
    initialMessage: '我想咨询信用问题，请客服协助。'
  })
}

const openCustomerServiceChat = async (payload = {}) => {
  if (advisorChatSubmitting.value) return
  if (!loggedIn.value) {
    goLogin()
    return
  }
  advisorChatSubmitting.value = true
  try {
    const debtContext = buildDebtContactContext()
    const response = await createCustomerServiceContact({
      ...(debtContext || {}),
      source: debtContext ? 'advisor-debt-chat' : (payload.source || 'advisor-page-chat'),
      contactIntent: payload.contactIntent || (debtContext ? 'debt-optimization' : 'advisor-chat'),
      summary: debtContext ? debtContext.summary : (payload.summary || '用户发起顾问文字咨询'),
      initialMessage: payload.initialMessage || (debtContext ? `我想咨询${debtContext.productName || '债务优化'}，请客服协助安排。` : '我想咨询信用问题，请客服协助。'),
      createdAt: new Date().toISOString()
    })
    await openAdvisorConversation(response)
  } catch (e) {
    uni.showToast({ title: e && e.message ? e.message : '顾问会话创建失败', icon: 'none' })
  } finally {
    advisorChatSubmitting.value = false
  }
}

const buildDebtContactContext = () => {
  const query = route.query || {}
  if (queryText(query.from) !== 'debt') return null
  const saved = readDebtAdvisorContext() || {}
  const debt = saved.debt || {}
  const goal = saved.goal || {}
  const overview = saved.summary || {}
  const proofMaterials = debtExecutionRecordsToMaterials(saved.executionRecords || [])
  const reportId = queryText(query.reportId) || saved.reportId || ''
  const productName = debt.title || '债务优化方案'
  const summary = [
    goal.title ? `目标：${goal.title}` : '债务优化咨询',
    debt.title ? `债务：${debt.title}` : '',
    overview.totalDebt ? `总负债 ${overview.totalDebt}` : '',
    overview.monthlyPay ? `本月应还 ${overview.monthlyPay}` : ''
  ].filter(Boolean).join(' · ')
  return {
    source: 'debt-manage',
    reportId,
    reportTitle: saved.reportTitle || '',
    reportScore: saved.reportScore || '',
    productName,
    institution: debt.institution || '',
    contactType: 'debt-optimization',
    summary,
    debt,
    goal,
    debtSummary: overview,
    materials: proofMaterials,
    requiredMaterials: proofMaterials,
    context: { ...saved, materials: proofMaterials, requiredMaterials: proofMaterials },
    createdAt: new Date().toISOString()
  }
}

const bookConsult = async () => {
  if (!loggedIn.value) {
    goLogin()
    return
  }
  const debtContext = buildDebtContactContext()
  const reportId = debtContext?.reportId || uni.getStorageSync('currentTaskId') || ''
  try {
    const response = await createCustomerServiceContact({
      ...(debtContext || {}),
      reportId,
      source: debtContext ? 'advisor-debt-booking' : 'advisor-page-booking',
      contactIntent: debtContext ? 'debt-optimization' : 'appointment',
      summary: debtContext ? debtContext.summary : '用户发起预约咨询',
      initialMessage: debtContext ? `我想预约${debtContext.productName || '债务优化'}咨询，请客服协助安排。` : '我想预约咨询，请客服协助安排。',
      createdAt: new Date().toISOString()
    })
    if (debtContext) {
      saveLastConsultationStatus({
        reportId: debtContext.reportId,
        reportTitle: debtContext.reportTitle,
        reportScore: debtContext.reportScore,
        productName: debtContext.productName,
        institution: debtContext.institution,
        summary: debtContext.summary,
        materials: debtContext.materials,
        requiredMaterials: debtContext.requiredMaterials,
        createdAt: debtContext.createdAt
      }, response)
    }
    await openAdvisorConversation(response)
  } catch (e) {
    uni.showToast({ title: e && e.message ? e.message : '预约失败，请稍后重试', icon: 'none' })
  }
}

const pickMaterialFile = () => new Promise((resolve, reject) => {
  const done = (res, fallbackName) => {
    const f = (res.tempFiles && res.tempFiles[0]) || null
    const path = (res.tempFilePaths && res.tempFilePaths[0]) || (f && f.path) || ''
    if (!path) { reject(new Error('未选择材料')); return }
    resolve({ path, name: (f && f.name) || fallbackName, size: f && typeof f.size === 'number' ? f.size : '' })
  }
  if (typeof uni.chooseFile === 'function') {
    uni.chooseFile({
      count: 1,
      extension: ['.pdf', '.jpg', '.jpeg', '.png'],
      success: (res) => done(res, 'material.pdf'),
      fail: () => reject(new Error('cancel'))
    })
    return
  }
  uni.chooseImage({
    count: 1,
    sourceType: ['album', 'camera'],
    success: (res) => done(res, 'material.jpg'),
    fail: () => reject(new Error('cancel'))
  })
})

const seedLocalMaterialStatus = (record) => {
  if (!record) return null
  return saveLastConsultationStatus({
    reportId: record.reportId,
    reportTitle: record.reportTitle,
    reportScore: record.reportScore,
    productName: record.productName || record.title,
    institution: record.institution,
    matchRate: record.matchRate,
    summary: record.summary,
    materials: record.materials,
    createdAt: new Date().toISOString()
  }, {})
}

const uploadMaterial = async (record, item) => {
  if (!item || !item.canUpload || materialUploadingKey.value) return
  const key = materialKeyOf(record, item)
  materialUploadingKey.value = key
  try {
    const picked = await pickMaterialFile()
    const url = await uploadLocalFile({ filePath: picked.path, folder: 'consultation-materials' })
    const uploadedAt = new Date().toISOString()
    const fileMeta = { url, name: picked.name, size: picked.size, uploadedAt }
    let updated = markLastConsultationMaterialUploaded(item, fileMeta)
    if (!updated) {
      seedLocalMaterialStatus(record)
      updated = markLastConsultationMaterialUploaded(item, fileMeta)
    }
    if (!updated) throw new Error('材料状态回写失败')
    const materialPayload = buildAdvisorMaterialSubmitPayload(record, item, fileMeta, {
      messageId: landingTarget.value && landingTarget.value.messageId,
      receiptStage: 'handled'
    })
    const materialSync = await syncConsultationMaterialSubmit(materialPayload, submitAdvisorContactMaterial)
    if (recordMatchesLandingTarget(record) && landingTarget.value && landingTarget.value.messageId) {
      const handledReceipt = saveMessageActionReceipt(
        { id: landingTarget.value.messageId, category: 'consultation', statusId: landingTarget.value.statusId, reportId: record.reportId },
        {
          stage: 'handled',
          page: '/pages/profile/advisor',
          focus: landingTarget.value.focus,
          reportId: record.reportId,
          materialId: item.id,
          materialName: item.name,
          uploadUrl: url,
          fileName: picked.name,
          uploadedAt
        }
      )
      syncMessageActionReceipt(handledReceipt, saveMessageActionReceiptRemote)
    }
    uni.showToast({ title: materialSync.queued ? '已提交，本机已记录' : '已提交，等待顾问确认', icon: 'none' })
    suppressNextProgressToast.value = true
    load()
  } catch (e) {
    const message = e && e.message ? String(e.message) : ''
    if (!/cancel/i.test(message)) uni.showToast({ title: message || '上传失败，请重试', icon: 'none' })
  } finally {
    materialUploadingKey.value = ''
  }
}

const goReport = (record) => {
  if (!record || !record.reportId) return
  uni.navigateTo({ url: `/pages/report/detail?id=${encodeURIComponent(record.reportId)}&from=advisor`, fail: () => { uni.showToast({ title: '无法打开报告页', icon: 'none' }) } })
}
const goBack = () => safeBack('/pages/profile/profile')
const goLogin = () => uni.navigateTo({ url: '/pages/login/index' })

onShow(() => {
  syncLandingTarget()
  load()
})
</script>

<style scoped>
.page { min-height: 100vh; background: #F5F6FA; padding-bottom: calc(78px + var(--rpt-safe-bottom)); }
.nav { flex-direction: row; align-items: center; padding: calc(var(--rpt-safe-top) + 8px) 14px 8px; background: #fff; border-bottom: 1px solid #EEF0F4; }
.nav-title { flex: 1; text-align: center; font-size: 16px; font-weight: 800; color: #111827; }
.nav-spacer { width: 32px; }
.scroll-body { flex: 1; height: 100vh; }
.wrap { padding: 16px; }

.advisor-card { align-items: center; background: #fff; border-radius: 8px; padding: 24px 18px; border: 1px solid #EEF0F4; }
.avatar { width: 64px; height: 64px; border-radius: 32px; background: #EAF3FF; align-items: center; justify-content: center; border: 1px solid #BFDBFE; }
.avatar-text { color: #086CEA; font-size: 24px; font-weight: 900; }
.advisor-name { margin-top: 14px; font-size: 20px; color: #111827; font-weight: 900; }
.advisor-title { margin-top: 4px; font-size: 13px; color: #6B7280; text-align: center; }
.advisor-spec { margin-top: 12px; font-size: 13px; color: #374151; text-align: center; line-height: 1.6; }
.rating-row { flex-direction: row; align-items: center; margin-top: 12px; padding: 5px 10px; background: #FFFBEB; border-radius: 8px; }
.rating-main { color: #B45309; font-size: 14px; font-weight: 900; }
.rating-sub { color: #B45309; font-size: 12px; margin-left: 4px; }

.contact-card { background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; margin-top: 12px; overflow: hidden; }
.contact-row { flex-direction: row; align-items: center; padding: 15px 16px; }
.contact-main { flex: 1; }
.contact-title { font-size: 15px; color: #111827; font-weight: 800; }
.contact-sub { margin-top: 3px; font-size: 12px; color: #9CA3AF; }
.contact-arrow { width: 22px; height: 22px; color: #C7CBD1; }
.divider { height: 1px; background: #F3F4F6; margin: 0 16px; }
.landing-card { margin-top: 12px; padding: 12px 14px; border-radius: 8px; background: #F0FDF4; border: 1px solid #BBF7D0; }
.landing-title { font-size: 14px; color: #15803D; font-weight: 900; }
.landing-sub { margin-top: 4px; font-size: 12px; color: #166534; line-height: 1.5; }

.section-head { flex-direction: row; justify-content: space-between; align-items: center; margin: 18px 2px 10px; }
.section-title { font-size: 16px; font-weight: 900; color: #111827; }
.section-note { font-size: 12px; color: #9CA3AF; }
.state-card { align-items: center; background: #fff; border-radius: 8px; padding: 34px 22px; border: 1px solid #EEF0F4; }
.state-title { font-size: 16px; color: #111827; font-weight: 800; }
.state-sub { margin-top: 8px; font-size: 13px; color: #6B7280; text-align: center; line-height: 1.6; }
.state-btn { margin-top: 18px; padding: 10px 30px; border-radius: 8px; background: #086CEA; }
.state-btn-text { color: #fff; font-size: 14px; font-weight: 800; }

.record-card { background: #fff; border-radius: 8px; padding: 15px; margin-bottom: 10px; border: 1px solid #EEF0F4; }
.record-card-focus { border-color: #BBF7D0; box-shadow: 0 8px 20px rgba(21,128,61,0.08); }
.record-focus-line { flex-direction: row; align-items: center; justify-content: space-between; margin-bottom: 10px; padding: 8px 10px; border-radius: 8px; background: #F0FDF4; }
.record-focus-text { flex: 1; margin-right: 8px; font-size: 12px; color: #166534; font-weight: 900; }
.record-focus-status { font-size: 11px; color: #15803D; font-weight: 900; }
.record-head { flex-direction: row; align-items: center; justify-content: space-between; }
.record-title { flex: 1; margin-right: 10px; font-size: 15px; font-weight: 900; color: #111827; }
.record-status { font-size: 12px; color: #086CEA; font-weight: 800; }
.record-time { margin-top: 4px; font-size: 12px; color: #9CA3AF; }
.record-summary { margin-top: 8px; font-size: 13px; color: #4B5563; line-height: 1.6; }
.record-meta { flex-direction: row; flex-wrap: wrap; margin-top: 10px; }
.record-meta-item { margin-right: 7px; margin-bottom: 6px; padding: 4px 8px; border-radius: 6px; background: #F8FAFC; border: 1px solid #E5E7EB; color: #475569; font-size: 11px; font-weight: 700; }
.record-alert { margin-top: 10px; padding: 9px 10px; border-radius: 8px; background: #EFF6FF; border: 1px solid #BFDBFE; }
.record-alert-title { font-size: 12px; color: #1D4ED8; font-weight: 900; }
.record-alert-text { margin-top: 3px; font-size: 12px; color: #475569; line-height: 1.45; }
.record-alert-danger { background: #FEF2F2; border-color: #FECACA; }
.record-alert-danger .record-alert-title, .record-alert-danger .record-alert-text { color: #C62828; }
.record-alert-warning { background: #FFFBEB; border-color: #FDE68A; }
.record-alert-warning .record-alert-title, .record-alert-warning .record-alert-text { color: #92400E; }
.record-alert-success { background: #F0FDF4; border-color: #BBF7D0; }
.record-alert-success .record-alert-title, .record-alert-success .record-alert-text { color: #15803D; }
.record-next { margin-top: 8px; padding: 9px 10px; border-radius: 8px; background: #F0FDF4; border: 1px solid #BBF7D0; }
.record-next-label { font-size: 11px; color: #15803D; font-weight: 900; }
.record-next-text { margin-top: 3px; font-size: 12px; color: #166534; line-height: 1.5; }
.record-timeline { margin-top: 10px; padding: 10px; border-radius: 8px; background: #F8FAFC; border: 1px solid #E5E7EB; }
.timeline-head { flex-direction: row; align-items: center; justify-content: space-between; margin-bottom: 7px; }
.timeline-title { font-size: 12px; color: #111827; font-weight: 900; }
.timeline-count { font-size: 11px; color: #94A3B8; font-weight: 800; }
.timeline-row { flex-direction: row; padding: 7px 0; }
.timeline-dot { width: 8px; height: 8px; border-radius: 4px; background: #CBD5E1; margin-top: 5px; margin-right: 9px; }
.timeline-row-done .timeline-dot { background: #16A34A; }
.timeline-row-current .timeline-dot { background: #1D4ED8; }
.timeline-row-action .timeline-dot { background: #086CEA; }
.timeline-main { flex: 1; }
.timeline-line { flex-direction: row; align-items: center; justify-content: space-between; }
.timeline-item-title { flex: 1; margin-right: 8px; font-size: 12px; color: #111827; font-weight: 900; }
.timeline-time { font-size: 10px; color: #94A3B8; }
.timeline-desc { margin-top: 3px; font-size: 11px; color: #64748B; line-height: 1.45; }
.record-materials { margin-top: 10px; padding: 10px; border-radius: 8px; background: #FFFBEB; border: 1px solid #FDE68A; }
.record-material-head { flex-direction: row; align-items: center; justify-content: space-between; }
.record-material-title { font-size: 12px; color: #92400E; font-weight: 900; }
.record-material-count { font-size: 11px; color: #B45309; font-weight: 800; }
.record-material-list { margin-top: 8px; }
.material-chip { flex-direction: row; align-items: center; justify-content: space-between; min-height: 32px; padding: 7px 9px; margin-bottom: 6px; border-radius: 8px; background: #FFFFFF; border: 1px solid #FDE68A; }
.material-chip-review { background: #EFF6FF; border-color: #BFDBFE; }
.material-chip-done { background: #F0FDF4; border-color: #BBF7D0; }
.material-main { flex: 1; margin-right: 8px; }
.material-name { font-size: 12px; color: #374151; font-weight: 800; }
.material-file { margin-top: 2px; font-size: 10px; color: #64748B; line-height: 1.4; }
.material-note { margin-top: 2px; font-size: 10px; color: #991B1B; line-height: 1.4; }
.material-side { align-items: flex-end; }
.material-status { font-size: 11px; color: #B45309; font-weight: 900; }
.material-upload { margin-top: 5px; padding: 4px 9px; border-radius: 8px; background: #086CEA; color: #FFFFFF; font-size: 11px; font-weight: 900; }
.material-chip-review .material-status { color: #1D4ED8; }
.material-chip-done .material-status { color: #15803D; }
.material-chip-reupload { background: #FEF2F2; border-color: #FECACA; }
.material-chip-reupload .material-status { color: #C62828; }
.record-actions { flex-direction: row; margin-top: 12px; }
.record-action { flex: 1; height: 36px; border-radius: 8px; background: #086CEA; align-items: center; justify-content: center; margin-right: 8px; }
.record-action:last-child { margin-right: 0; }
.record-action-soft { background: #EAF3FF; border: 1px solid #BFDBFE; }
.record-action-text { color: #fff; font-size: 13px; font-weight: 900; }
.record-action-soft-text { color: #086CEA; font-size: 13px; font-weight: 900; }
.bottom-safe { height: 44px; }

.footer { position: fixed; left: 0; right: 0; bottom: 0; padding: 12px 16px calc(12px + var(--rpt-safe-bottom)); background: rgba(255,255,255,0.96); box-shadow: 0 -8px 24px rgba(0,0,0,0.06); }
.book-btn { height: 46px; border-radius: 8px; background: #086CEA; align-items: center; justify-content: center; }
.book-btn-text { color: #fff; font-size: 15px; font-weight: 900; }

/* ── 桌面端限宽微调 ≥1024px ── */
@media (min-width: 1024px) {
  .wrap { padding: 20px 24px; }
  .advisor-card { padding: 28px 22px; }
  .footer {
    position: static;
    margin-top: 16px;
    box-shadow: none;
    border: 1px solid #EEF0F4;
    border-radius: 8px;
    padding: 16px;
  }
}
</style>
