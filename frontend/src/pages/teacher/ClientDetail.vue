<template>
  <view class="page rpt-page">
    <view class="nav">
      <RptBackButton @click="goBack" />
      <text class="nav-title">客户详情</text>
      <view class="nav-link" @click="changeStatus">
        <text class="nav-link-text">状态</text>
      </view>
    </view>

    <scroll-view class="scroll-body" scroll-y refresher-enabled :refresher-triggered="refreshing" @refresherrefresh="refresh">
      <view class="wrap rpt-content-narrow">
        <view v-if="loading" class="state-card">
          <text class="state-title">正在加载客户详情</text>
          <text class="state-sub">同步授权资料与跟进记录。</text>
        </view>

        <view v-else-if="!loggedIn" class="state-card">
          <text class="state-title">登录后查看详情</text>
          <text class="state-sub">客户详情仅面向已接单的客服或银行老师开放。</text>
          <view class="state-btn" @click="goLogin"><text class="state-btn-text">去登录</text></view>
        </view>

        <view v-else>
          <view class="client-head">
            <view class="avatar"><text class="avatar-text">{{ avatarOf(client.name) }}</text></view>
            <view class="client-main">
              <view class="name-line">
                <text class="client-name">{{ client.name || '未命名客户' }}</text>
                <text class="status" :class="statusClass(localStatus)">{{ statusText(localStatus) }}</text>
              </view>
              <text class="client-meta">{{ client.phone || '未留手机号' }} · {{ client.latestTime || '暂无最近记录' }}</text>
              <view class="sync-line">
                <text class="sync-dot" :class="syncMeta.state"></text>
                <text class="sync-text">{{ syncMeta.label }}</text>
                <text class="sync-source">{{ syncMeta.sourceText }}</text>
                <text class="sync-time">{{ syncMeta.timeText }}</text>
              </view>
            </view>
          </view>

          <view class="summary-grid">
            <view class="summary-cell">
              <text class="summary-num">{{ client.contactCount || history.length || 0 }}</text>
              <text class="summary-label">跟进次数</text>
            </view>
            <view class="summary-cell">
              <text class="summary-num">{{ client.reportCount || client.reportTotal || 0 }}</text>
              <text class="summary-label">报告数</text>
            </view>
            <view class="summary-cell">
              <text class="summary-num">{{ client.score == null ? '--' : client.score }}</text>
              <text class="summary-label">信用评分</text>
            </view>
          </view>

	          <view class="chat-panel">
	            <view class="chat-panel-main">
	              <text class="chat-panel-title">客户会话</text>
	              <text class="chat-panel-sub">{{ latestMessageText }}</text>
	            </view>
	            <view v-if="needsAdvisorClaim" class="chat-panel-ghost" @click="claimClient">
	              <text class="chat-panel-ghost-text">接单</text>
	            </view>
	            <view class="chat-panel-btn" @click="openChat">
	              <text class="chat-panel-btn-text">进入会话</text>
	            </view>
	          </view>

          <view v-if="productTerms.length" class="section product-section">
            <view class="section-head">
              <text class="section-title">产品口径</text>
              <text class="section-note">经理端可见</text>
            </view>
            <view class="product-kv">
              <view v-for="item in productTerms" :key="item.label" class="product-kv-cell">
                <text class="product-kv-label">{{ item.label }}</text>
                <text class="product-kv-value">{{ item.value }}</text>
              </view>
            </view>
          </view>

          <view class="section consent">
            <view class="section-head">
              <text class="section-title">客户授权</text>
              <text class="section-tag">已留痕</text>
            </view>
            <text class="section-text">仅展示客户授权咨询所需信息。沟通记录、备注和状态变更应围绕本次服务目的。</text>
          </view>

          <view class="section">
            <view class="section-head">
              <text class="section-title">风险摘要</text>
              <text class="section-note">报告视角</text>
            </view>
            <view v-if="riskItems.length" class="risk-list">
              <view v-for="item in riskItems" :key="item.label" class="risk-row">
                <text class="risk-label">{{ item.label }}</text>
                <text class="risk-value">{{ item.value }}</text>
              </view>
            </view>
            <view v-else class="empty-inline">
              <text class="empty-inline-text">暂无风险摘要，等待客户上传或授权报告。</text>
            </view>
          </view>

          <view class="section">
            <view class="section-head">
              <text class="section-title">匹配建议</text>
              <text class="section-note">沟通参考</text>
            </view>
            <view v-if="suggestions.length" class="suggestion-list">
              <view v-for="item in suggestions" :key="item.title || item" class="suggestion-row">
                <text class="suggestion-title">{{ item.title || item }}</text>
                <text v-if="item.desc" class="suggestion-desc">{{ item.desc }}</text>
              </view>
            </view>
            <view v-else class="empty-inline">
              <text class="empty-inline-text">暂无产品匹配建议，可先补充职业、负债与收入信息。</text>
            </view>
          </view>

          <view class="section">
            <view class="section-head">
              <text class="section-title">材料复核</text>
              <text class="section-note">{{ reviewMaterials.length ? reviewMaterials.length + ' 项' : '暂无' }}</text>
            </view>
	            <view v-if="materialAccessBlocked" class="empty-inline access-block">
	              <text class="empty-inline-text">{{ materialAccessText }}</text>
	            </view>
	            <view v-else-if="reviewMaterials.length" class="material-review-list">
              <view v-for="item in reviewMaterials" :key="item.id || item.name" class="material-review-row" @click="reviewMaterial(item)">
                <view class="material-review-main">
                  <text class="material-review-name">{{ item.name }}</text>
                  <text v-if="materialReviewNote(item)" class="material-review-note">{{ materialReviewNote(item) }}</text>
                </view>
                <text class="material-review-status" :class="materialStatusClass(item)">{{ materialStatusText(item) }}</text>
              </view>
            </view>
            <view v-else class="empty-inline">
              <text class="empty-inline-text">暂无待复核材料，等待用户补充或后端同步材料清单。</text>
            </view>
          </view>

          <view class="section">
            <view class="section-head">
              <text class="section-title">用户回写摘要</text>
              <text class="section-note">{{ writebackOverallText }}</text>
            </view>
            <view class="writeback-list">
              <view v-for="item in writebackCards" :key="item.key" class="writeback-row" :class="'writeback-row-' + item.state">
                <view class="writeback-main">
                  <text class="writeback-title">{{ item.title }}</text>
                  <text class="writeback-desc">{{ item.desc }}</text>
                </view>
                <view class="writeback-pill" :class="'writeback-pill-' + item.state">
                  <text class="writeback-pill-text">{{ item.status }}</text>
                </view>
              </view>
            </view>
            <view v-if="writebackMissingText" class="writeback-warning">
              <text class="writeback-warning-text">{{ writebackMissingText }}</text>
            </view>
          </view>
          <view class="section">
            <view class="section-head">
              <text class="section-title">新增备注</text>
              <text class="section-note">内部可见</text>
            </view>
            <textarea v-model.trim="note" class="note-input" placeholder="记录客户诉求、补充材料、下一步计划" maxlength="200" />
            <view class="note-actions">
              <view class="ghost-btn" @click="callClient"><text class="ghost-btn-text">电话联系</text></view>
              <view class="save-btn" @click="saveNote"><text class="save-btn-text">保存备注</text></view>
            </view>
          </view>

          <view class="section">
            <view class="section-head">
              <text class="section-title">跟进记录</text>
              <text class="section-note">{{ history.length }} 条</text>
            </view>
            <view v-if="history.length" class="history-list">
              <view v-for="record in history" :key="record.id" class="history-row">
                <view class="history-top">
                  <text class="history-time">{{ record.time || '暂无时间' }}</text>
                  <text class="status small" :class="statusClass(record.status)">{{ record.statusText || statusText(record.status) }}</text>
                </view>
                <text class="history-summary">{{ record.summary || '已创建服务跟进记录。' }}</text>
                <view v-if="record.notes && record.notes.length" class="note-list">
                  <text v-for="(n, idx) in record.notes" :key="idx" class="note-item">{{ noteText(n) }}</text>
                </view>
              </view>
            </view>
            <view v-else class="empty-inline">
              <text class="empty-inline-text">暂无跟进记录，保存备注后会形成服务留痕。</text>
            </view>
          </view>
        </view>

        <view class="bottom-safe"></view>
      </view>
    </scroll-view>
  </view>
</template>

<script setup>
import { computed, ref } from 'vue'
import { onHide, onShow } from '@/compat/web-lifecycle.js'
import { useRoute } from 'vue-router'
import { isLoggedIn } from '@/services/authService.js'
import { switchToAdvisor, switchToService } from '@/services/roleService.js'
	import { getTeacherClientDetail, saveContactMaterialReview, saveContactNote, startTeacherRealtimeRefresh } from '@/services/teacherService.js'
	import { claimAdvisorContact } from '@/services/profileService.js'
import { DEFAULT_TEACHER_SYNC_META } from '@/services/teacherRealtime.js'
import { normalizeAdvisorContactContext } from '@/services/teacherContactContext.js'
import RptBackButton from '@/components/RptBackButton.vue'
import safeBack from '@/utils/safeBack.js'

const route = useRoute()
const loggedIn = ref(false)
const loading = ref(false)
const refreshing = ref(false)
const client = ref({})
const history = ref([])
const note = ref('')
const localStatus = ref('processing')
const syncMeta = ref({ ...DEFAULT_TEACHER_SYNC_META })

const clientId = computed(() => String(route.query.id || route.query.uid || ''))
const activePort = computed(() => String(route.query.port || '').toLowerCase() === 'service' ? 'service' : 'bank')
const isServicePort = computed(() => activePort.value === 'service')

const normalizeRecord = (item, index) => {
  const source = item || {}
  const context = normalizeAdvisorContactContext(source)
  const rawMaterials = Array.isArray(context.materials) ? context.materials : []
  return {
    id: source.id || source.contactId || source._id || `record-${index}`,
    status: source.status || 'processing',
	    statusText: source.statusText || statusText(source.status),
	    time: source.time || source.createTime || source.createdAt || source.updateTime || '',
	    summary: context.summary || source.summary || source.desc || '',
	    productName: context.productName || source.productName || '',
	    institution: context.institution || source.institution || '',
	    rateText: context.rateText || source.rateText || '',
	    amountText: context.amountText || source.amountText || '',
	    termText: context.termText || source.termText || '',
	    matchRate: context.matchRate == null ? source.matchRate : context.matchRate,
	    channel: context.channel,
	    messages: Array.isArray(source.messages) ? source.messages : Array.isArray(context.messages) ? context.messages : [],
	    materials: rawMaterials,
	    materialAccess: source.materialAccess !== false,
	    materialsRedacted: source.materialsRedacted === true,
	    materialAccessText: source.materialAccessText || '',
	    materialCount: source.materialCount || 0,
	    serviceRequired: source.serviceRequired === true,
	    advisorAssigneeId: source.advisorAssigneeId || '',
	    advisorAssigneeName: source.advisorAssigneeName || '',
	    writebackSummary: source.writebackSummary || null,
    notes: Array.isArray(source.notes) ? source.notes : []
  }
}
const riskItems = computed(() => {
  const c = client.value || {}
  const raw = Array.isArray(c.riskItems) ? c.riskItems : Array.isArray(c.riskHits) ? c.riskHits : []
  if (raw.length) return raw.map((item, index) => ({ label: item.label || item.title || `风险项 ${index + 1}`, value: item.value || item.desc || item.content || '待确认' }))
  const out = []
  if (c.riskLevelText || c.riskLevel) out.push({ label: '综合风险', value: c.riskLevelText || c.riskLevel })
  if (c.overdueText || c.overdueCount) out.push({ label: '逾期情况', value: c.overdueText || `${c.overdueCount} 条` })
  if (c.debtText || c.debtRatio) out.push({ label: '负债压力', value: c.debtText || `${c.debtRatio}%` })
  return out
})

const suggestions = computed(() => {
  const c = client.value || {}
  const raw = Array.isArray(c.suggestions) ? c.suggestions : Array.isArray(c.matchSuggestions) ? c.matchSuggestions : []
  return raw.map((item) => typeof item === 'string' ? { title: item, desc: '' } : item)
})

const reviewMaterials = computed(() => {
  const record = history.value.find((item) => Array.isArray(item.materials) && item.materials.length)
  const list = record ? record.materials : client.value && Array.isArray(client.value.materials) ? client.value.materials : []
  return list.map((item, index) => typeof item === 'string' ? { id: `material_${index}`, name: item, statusText: '待补充' } : ({ ...item, id: item.id || item.key || item.code || `material_${index}`, statusText: item.statusText || '待补充' }))
})

const hasWritebackContent = (summary) => {
  if (!summary || typeof summary !== 'object') return false
  const counts = summary.counts || {}
  return !!summary.hasWritebacks || !!(counts.materialSubmit || counts.messageAction || counts.pushBinding || counts.incomplete) || (Array.isArray(summary.missingFields) && summary.missingFields.length > 0)
}
const writebackSummaries = computed(() => {
  const summaries = []
  if (hasWritebackContent(client.value && client.value.writebackSummary)) summaries.push(client.value.writebackSummary)
  history.value.forEach((record) => {
    if (hasWritebackContent(record && record.writebackSummary)) summaries.push(record.writebackSummary)
  })
  return summaries
})
const syncWritebackMissing = computed(() => Array.isArray(syncMeta.value.missingFields) ? syncMeta.value.missingFields.filter((item) => String(item).includes('.writebacks.')) : [])
const writebackItemsOf = (key) => writebackSummaries.value.flatMap((summary) => summary && summary[key] && Array.isArray(summary[key].items) ? summary[key].items : [])
const writebackMissingOf = (key) => Array.from(new Set([
  ...writebackSummaries.value.flatMap((summary) => summary && summary[key] && Array.isArray(summary[key].missingFields) ? summary[key].missingFields.map((field) => `${key}.${field}`) : []),
  ...syncWritebackMissing.value.filter((field) => String(field).includes(key))
]))
const formatWritebackTime = (value) => {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const latestWritebackItem = (items) => items.reduce((latest, item) => {
  const ts = Number(item && item.latestAt) || 0
  return ts > (Number(latest && latest.latestAt) || 0) ? item : latest
}, null)
const stageText = (stage) => ({ opened: '已打开', landed: '已进入处理页', handled: '已提交材料' }[stage] || stage || '已记录')
const platformText = (platform) => {
  const text = String(platform || '')
  if (text.includes('app')) return '历史原生推送（已停用）'
  if (text.includes('legacy-subscribe')) return '历史订阅渠道（已停用）'
  if (text.includes('browser')) return '浏览器通知'
  return text || '系统推送'
}
const writebackCardOf = (key, title, emptyText, describe) => {
  const items = writebackItemsOf(key)
  const missing = writebackMissingOf(key)
  const incomplete = items.filter((item) => item && item.isComplete === false).length
  const latest = latestWritebackItem(items)
  const time = latest && latest.latestAt ? formatWritebackTime(latest.latestAt) : ''
  const state = missing.length || incomplete ? 'warn' : items.length ? 'ok' : 'empty'
  const status = state === 'warn' ? '需核对' : items.length ? '已同步' : '暂无'
  const desc = items.length ? `${describe(latest || items[0])}${time ? ` · ${time}` : ''}` : missing.length ? '服务端声明必需，当前读取不完整' : emptyText
  return { key, title, desc, state, status, total: items.length, missingCount: missing.length + incomplete }
}
const writebackCards = computed(() => [
  writebackCardOf('materialSubmit', '材料提交', '暂无用户提交材料记录', (item = {}) => `${item.name || item.id || '材料'} · ${item.status || '已提交'}`),
  writebackCardOf('messageAction', '消息动作', '暂无消息点击或处理回执', (item = {}) => `${stageText(item.stage)} · ${item.id || '消息'}`),
  writebackCardOf('pushBinding', '推送绑定', '暂无系统推送绑定记录', (item = {}) => `${platformText(item.platform)} · ${item.status || '已绑定'}`)
])
const writebackOverallText = computed(() => {
  const total = writebackCards.value.reduce((sum, item) => sum + item.total, 0)
  const missing = writebackCards.value.reduce((sum, item) => sum + item.missingCount, 0)
  if (missing) return `${missing} 项待核对`
  return total ? '服务端已读取' : '暂无回写'
})
const writebackMissingText = computed(() => syncWritebackMissing.value.length ? `完整性提示：${syncWritebackMissing.value.slice(0, 2).join('，')}${syncWritebackMissing.value.length > 2 ? ' 等' : ''}` : '')

let stopLiveRefresh = () => {}
const resetSyncMeta = () => { syncMeta.value = { ...DEFAULT_TEACHER_SYNC_META } }

const load = async (opts = {}) => {
  loggedIn.value = isLoggedIn()
  if (!loggedIn.value) {
    resetSyncMeta()
    return
	  }
	  if (!opts.silent) loading.value = true
	  try {
	    const switched = isServicePort.value ? await switchToService() : await switchToAdvisor()
	    if (!switched.ok) throw new Error(switched.errMsg || (isServicePort.value ? '客服端暂未开通' : '银行经理端暂未开通'))
	    const data = await getTeacherClientDetail(clientId.value, { port: activePort.value })
	    client.value = data.client || { id: clientId.value, name: '未命名客户' }
	    history.value = Array.isArray(data.history) ? data.history.map(normalizeRecord) : []
	    localStatus.value = client.value.status || (history.value[0] && history.value[0].status) || 'processing'
	    syncMeta.value = data.syncMeta || { ...DEFAULT_TEACHER_SYNC_META }
	  } catch (e) {
	    if (e && e.statusCode === 401) loggedIn.value = false
	    if (!opts.silent && e && e.message) uni.showToast({ title: e.message, icon: 'none' })
	    client.value = { id: clientId.value, name: '未命名客户' }
    history.value = []
    syncMeta.value = { ...DEFAULT_TEACHER_SYNC_META, state: 'offline', label: '同步失败', errorCount: 1 }
  } finally {
    if (!opts.silent) loading.value = false
  }
}

const restartLiveRefresh = () => {
  stopLiveRefresh()
  stopLiveRefresh = loggedIn.value ? startTeacherRealtimeRefresh(() => load({ silent: true })) : () => {}
}

const stopLive = () => {
  stopLiveRefresh()
  stopLiveRefresh = () => {}
}

const refresh = async () => {
  refreshing.value = true
  await load({ silent: true })
  refreshing.value = false
}

const statusText = (status) => {
  const map = { pending: '待处理', processing: '处理中', need_info: '待补充', completed: '已完成', done: '已完成', resolved: '已完成' }
  return map[status] || '处理中'
}

const normalizedStatus = (status) => {
  if (status === 'completed' || status === 'done' || status === 'resolved') return 'completed'
  if (status === 'pending' || status === 'new' || status === 'todo') return 'pending'
  if (status === 'need_info' || status === 'needInfo') return 'need_info'
  return 'processing'
}

const statusClass = (status) => normalizedStatus(status)
const avatarOf = (name) => String(name || '客').slice(0, 1)
const noteText = (value) => typeof value === 'string' ? value : (value && (value.content || value.text || value.note)) || '备注'

const targetContactId = () => (history.value[0] && history.value[0].id) || client.value.contactId || client.value.id || clientId.value
const latestMessageText = computed(() => {
  const record = history.value.find((item) => Array.isArray(item.messages) && item.messages.length)
  const message = record ? record.messages[record.messages.length - 1] : null
  return message && message.content ? message.content : '查看产品咨询对话并回复客户。'
})
const latestProductContext = computed(() => history.value.find((item) => item.productName || item.rateText || item.amountText || item.termText) || client.value || {})
const latestContactRecord = computed(() => history.value[0] || client.value || {})
const needsAdvisorClaim = computed(() => {
  const item = latestContactRecord.value || {}
  if (isServicePort.value) {
    return !item.serviceAssigneeId && (item.materialAccess === false || item.materialsRedacted === true)
  }
  return item.serviceRequired === true && !item.advisorAssigneeId
})
const materialAccessBlocked = computed(() => {
  const item = latestContactRecord.value || {}
  return item.materialAccess === false || item.materialsRedacted === true
})
const materialAccessText = computed(() => {
  const item = latestContactRecord.value || {}
  return item.materialAccessText || '接单后可查看客户授权资料。'
})
const productTerms = computed(() => {
  const item = latestProductContext.value || {}
  const out = [
    { label: '产品', value: [item.institution, item.productName].filter(Boolean).join(' · ') || item.productName || '' },
    { label: '参考利率', value: item.rateText || '详询' },
    { label: '额度', value: item.amountText || '' },
    { label: '期限', value: item.termText || '' },
    { label: '匹配度', value: item.matchRate != null && item.matchRate !== '' ? `${item.matchRate}%` : '' }
  ].filter((entry) => entry.value)
  return out.length > 1 ? out : []
})
const materialStatusText = (item) => item && item.statusText ? item.statusText : '待补充'
const materialStatusClass = (item) => {
  const text = materialStatusText(item)
  if (text === '已确认') return 'confirmed'
  if (text === '需重传') return 'reupload'
  if (text === '无需') return 'unneeded'
  if (text === '待确认') return 'reviewing'
  return 'pending'
}
const materialReviewNote = (item = {}) => {
  const attachmentCount = Number(item.attachmentCount || (Array.isArray(item.attachments) ? item.attachments.length : 0) || 0)
  const countText = attachmentCount > 1 ? `${attachmentCount}份附件` : ''
  const base = item.reviewNote || item.note || countText || item.fileName || ''
  const ack = item.reviewAcknowledgedAt ? (item.reviewAcknowledgedNote || '用户已查看复核结果') : ''
  const reviewed = ['已确认', '需重传', '无需'].includes(materialStatusText(item)) ? '点击可二次复核' : ''
  return [base, countText && base !== countText ? countText : '', ack, reviewed].filter(Boolean).join(' · ')
}
const sameMaterial = (item, target) => {
  const itemId = item && (item.id || item.key || item.code)
  const targetId = target && (target.id || target.key || target.code)
  return Boolean((itemId && targetId && itemId === targetId) || (item && target && item.name && item.name === target.name))
}
const patchLocalMaterial = (target, patch) => {
  const patchList = (list) => list.map((item) => sameMaterial(item, target) ? { ...item, ...patch } : item)
  history.value = history.value.map((record) => Array.isArray(record.materials) ? { ...record, materials: patchList(record.materials) } : record)
  if (Array.isArray(client.value.materials)) client.value = { ...client.value, materials: patchList(client.value.materials) }
}
const reviewMaterial = (item) => {
  if (!item) return
  const reviewed = ['已确认', '需重传', '无需'].includes(materialStatusText(item))
  const rejectNote = item.source === 'debt-proof' ? '请重新上传清晰完整凭证' : '请重新上传清晰完整材料'
  const options = [
    { label: reviewed ? '再次确认通过' : '确认通过', status: 'confirmed', statusText: '已确认' },
    { label: reviewed ? '改为要求重传' : '要求重传', status: 'rejected', statusText: '需重传', reviewNote: rejectNote },
    { label: reviewed ? '改为无需补充' : '标记无需补充', status: 'unneeded', statusText: '无需' }
  ]
  uni.showActionSheet({
    itemList: options.map((option) => option.label),
    success: async (res) => {
      const review = options[res.tapIndex]
      if (!review) return
      try {
        const result = await saveContactMaterialReview(targetContactId(), item, review)
        if (!result.ok) throw new Error(result.errMsg || '材料复核失败')
        patchLocalMaterial(item, { ...review, reviewedAt: new Date().toISOString() })
        uni.showToast({ title: '复核状态已同步', icon: 'none' })
        load({ silent: true })
      } catch (e) {
        uni.showToast({ title: e && e.message ? e.message : '复核失败，请稍后重试', icon: 'none' })
      }
    }
  })
}

const saveNote = async () => {
  if (!note.value) {
    uni.showToast({ title: '请先填写备注', icon: 'none' })
    return
  }
  try {
    const res = await saveContactNote(targetContactId(), note.value)
    if (!res.ok) throw new Error(res.errMsg || '保存失败')
    if (history.value.length) history.value[0].notes = [note.value, ...(history.value[0].notes || [])]
    else history.value = [{ id: targetContactId(), status: localStatus.value, statusText: statusText(localStatus.value), time: '刚刚', summary: '新增老师备注。', notes: [note.value] }]
    note.value = ''
    uni.showToast({ title: '备注已保存', icon: 'none' })
  } catch (e) {
    uni.showToast({ title: '保存失败，请稍后重试', icon: 'none' })
  }
}

const callClient = () => {
  if (!client.value.phone) {
    uni.showToast({ title: '客户未留手机号', icon: 'none' })
    return
  }
  uni.makePhoneCall({ phoneNumber: String(client.value.phone).replace(/[-\s]/g, '') })
}
const openChat = () => {
  const id = targetContactId()
  if (!id) {
    uni.showToast({ title: '缺少会话记录', icon: 'none' })
    return
  }
	  uni.navigateTo({ url: `/pages/chat/conversation?contactId=${encodeURIComponent(id)}` })
	}
const claimClient = async () => {
  const id = targetContactId()
  if (!id) return
  try {
    await claimAdvisorContact(id, isServicePort.value ? 'service' : 'advisor')
    uni.showToast({ title: '已接单', icon: 'none' })
    await load({ silent: true })
  } catch (e) {
    uni.showToast({ title: e && e.message ? e.message : '接单失败', icon: 'none' })
  }
}

const changeStatus = () => {
  uni.showActionSheet({
    itemList: ['待处理', '处理中', '待补充资料', '已完成'],
    success: (res) => {
      const next = ['pending', 'processing', 'need_info', 'completed'][res.tapIndex]
      if (next) localStatus.value = next
    }
  })
}

const goBack = () => safeBack(isServicePort.value ? '/pages/service/workbench' : '/pages/teacher/clients')
const goLogin = () => uni.navigateTo({ url: '/pages/login/index' })

onShow(async () => {
  await load()
  restartLiveRefresh()
})
onHide(() => stopLive())
</script>

<style scoped>
.page { min-height: 100vh; background: #F5F6FA; }
.nav { flex-direction: row; align-items: center; padding: calc(var(--rpt-safe-top) + 8px) 14px 8px; background: #fff; border-bottom: 1px solid #EEF0F4; }
.nav-title { flex: 1; text-align: center; font-size: 16px; font-weight: 900; color: #111827; }
.nav-link { width: 42px; align-items: flex-end; }
.nav-link-text { font-size: 13px; color: #086CEA; font-weight: 900; }
.scroll-body { flex: 1; height: 100vh; }
.wrap { padding: 14px 16px 18px; }
.client-head { flex-direction: row; align-items: center; background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; padding: 16px; }
.avatar { width: 50px; height: 50px; border-radius: 25px; background: #F8FAFC; border: 1px solid #E5E7EB; align-items: center; justify-content: center; margin-right: 12px; }
.avatar-text { font-size: 18px; color: #475569; font-weight: 900; }
.client-main { flex: 1; }
.name-line { flex-direction: row; align-items: center; }
.client-name { flex: 1; font-size: 18px; color: #111827; font-weight: 900; }
.client-meta { margin-top: 6px; font-size: 12px; color: #9CA3AF; }
.sync-line { flex-direction: row; align-items: center; flex-wrap: wrap; margin-top: 9px; }
.sync-dot { width: 7px; height: 7px; border-radius: 4px; background: #CBD5E1; margin-right: 6px; }
.sync-dot.live { background: #16A34A; }
.sync-dot.incomplete { background: #F59E0B; }
.sync-dot.offline, .sync-dot.stale { background: #C62828; }
.sync-text { font-size: 11px; color: #374151; font-weight: 900; margin-right: 8px; }
.sync-source, .sync-time { font-size: 11px; color: #9CA3AF; margin-right: 8px; }
.status { font-size: 11px; font-weight: 900; padding: 4px 7px; border-radius: 8px; overflow: hidden; }
.status.small { font-size: 10px; padding: 3px 6px; }
.status.pending { color: #086CEA; background: #EAF3FF; }
.status.processing { color: #1D4ED8; background: #EFF6FF; }
.status.need_info { color: #B45309; background: #FFFBEB; }
.status.completed { color: #15803D; background: #F0FDF4; }
.summary-grid { flex-direction: row; margin-top: 12px; }
.summary-cell { flex: 1; background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; padding: 15px 4px; align-items: center; margin-right: 8px; }
.summary-cell:last-child { margin-right: 0; }
.summary-num { font-size: 21px; color: #111827; font-weight: 900; }
.summary-label { margin-top: 5px; font-size: 12px; color: #6B7280; font-weight: 700; }
.chat-panel { margin-top: 12px; flex-direction: row; align-items: center; background: #fff; border-radius: 8px; border: 1px solid #BFDBFE; padding: 14px; }
.chat-panel-main { flex: 1; margin-right: 10px; }
.chat-panel-title { font-size: 15px; color: #111827; font-weight: 900; }
.chat-panel-sub { margin-top: 5px; font-size: 12px; color: #6B7280; line-height: 1.5; }
	.chat-panel-btn { height: 38px; padding: 0 13px; border-radius: 8px; background: #086CEA; align-items: center; justify-content: center; }
	.chat-panel-btn-text { font-size: 13px; color: #fff; font-weight: 900; }
	.chat-panel-ghost { height: 38px; padding: 0 13px; border-radius: 8px; border: 1px solid #BFDBFE; background: #EFF6FF; align-items: center; justify-content: center; margin-right: 8px; }
	.chat-panel-ghost-text { font-size: 13px; color: #086CEA; font-weight: 900; }
.product-section { border-color: #DBEAFE; background: #F8FBFF; }
.product-kv { flex-direction: row; flex-wrap: wrap; margin: -4px; }
.product-kv-cell { width: 50%; padding: 4px; }
.product-kv-label { font-size: 11px; color: #7A879A; font-weight: 800; }
.product-kv-value { margin-top: 4px; font-size: 13px; color: #071B3A; font-weight: 900; line-height: 1.45; }
.section { margin-top: 12px; background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; padding: 15px; }
.section.consent { background: #FFFBEB; border-color: #FDE68A; }
.section-head { flex-direction: row; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.section-title { font-size: 16px; color: #111827; font-weight: 900; }
.section-note { font-size: 12px; color: #9CA3AF; font-weight: 800; }
.section-tag { font-size: 12px; color: #92400E; font-weight: 900; }
.section-text { font-size: 13px; color: #92400E; line-height: 1.7; }
.risk-row { flex-direction: row; align-items: center; padding: 10px 0; border-top: 1px solid #F3F4F6; }
.risk-row:first-child { border-top-width: 0; }
.risk-label { width: 82px; font-size: 13px; color: #6B7280; font-weight: 800; }
.risk-value { flex: 1; font-size: 13px; color: #111827; font-weight: 800; text-align: right; }
.suggestion-row { padding: 11px 0; border-top: 1px solid #F3F4F6; }
.suggestion-row:first-child { border-top-width: 0; }
.suggestion-title { font-size: 14px; color: #111827; font-weight: 900; }
.suggestion-desc { margin-top: 5px; font-size: 12px; color: #6B7280; line-height: 1.6; }
	.empty-inline { background: #F8FAFC; border-radius: 8px; padding: 14px; }
	.access-block { background: #EFF6FF; border: 1px solid #BFDBFE; }
.empty-inline-text { font-size: 12px; color: #9CA3AF; line-height: 1.6; text-align: center; }
.material-review-row { flex-direction: row; align-items: center; padding: 11px 0; border-top: 1px solid #F3F4F6; }
.material-review-row:first-child { border-top-width: 0; }
.material-review-main { flex: 1; margin-right: 10px; }
.material-review-name { font-size: 13px; color: #111827; font-weight: 900; }
.material-review-note { margin-top: 4px; font-size: 11px; color: #6B7280; line-height: 1.5; }
.material-review-status { min-width: 54px; text-align: center; padding: 4px 7px; border-radius: 8px; font-size: 11px; font-weight: 900; color: #B45309; background: #FFFBEB; }
.material-review-status.reviewing { color: #1D4ED8; background: #EFF6FF; }
.material-review-status.confirmed, .material-review-status.unneeded { color: #15803D; background: #F0FDF4; }
.material-review-status.reupload { color: #C62828; background: #FEF2F2; }
.writeback-row { flex-direction: row; align-items: center; padding: 11px 0; border-top: 1px solid #F3F4F6; }
.writeback-row:first-child { border-top-width: 0; }
.writeback-main { flex: 1; padding-right: 10px; }
.writeback-title { font-size: 13px; color: #111827; font-weight: 900; }
.writeback-desc { margin-top: 4px; font-size: 11px; color: #6B7280; line-height: 1.5; }
.writeback-pill { min-width: 54px; padding: 4px 7px; border-radius: 8px; align-items: center; background: #F3F4F6; }
.writeback-pill-ok { background: #F0FDF4; }
.writeback-pill-warn { background: #FFFBEB; }
.writeback-pill-text { font-size: 11px; color: #6B7280; font-weight: 900; }
.writeback-pill-ok .writeback-pill-text { color: #15803D; }
.writeback-pill-warn .writeback-pill-text { color: #B45309; }
.writeback-warning { margin-top: 10px; border-radius: 8px; background: #FFFBEB; border: 1px solid #FDE68A; padding: 9px 10px; }
.writeback-warning-text { font-size: 11px; color: #92400E; line-height: 1.5; }
.note-input { min-height: 94px; width: 100%; padding: 12px; box-sizing: border-box; border-radius: 8px; background: #F8FAFC; border: 1px solid #E5E7EB; font-size: 14px; color: #111827; line-height: 1.6; }
.note-actions { flex-direction: row; justify-content: flex-end; margin-top: 12px; }
.ghost-btn { height: 38px; padding: 0 14px; border-radius: 8px; border: 1px solid #E5E7EB; align-items: center; justify-content: center; margin-right: 8px; }
.ghost-btn-text { font-size: 13px; color: #374151; font-weight: 900; }
.save-btn { height: 38px; padding: 0 14px; border-radius: 8px; background: #086CEA; align-items: center; justify-content: center; }
.save-btn-text { font-size: 13px; color: #fff; font-weight: 900; }
.history-row { padding: 13px 0; border-top: 1px solid #F3F4F6; }
.history-row:first-child { border-top-width: 0; }
.history-top { flex-direction: row; align-items: center; justify-content: space-between; }
.history-time { font-size: 12px; color: #9CA3AF; font-weight: 800; }
.history-summary { margin-top: 7px; font-size: 13px; color: #374151; line-height: 1.6; }
.note-list { margin-top: 9px; background: #F8FAFC; border-radius: 8px; padding: 10px; }
.note-item { display: block; font-size: 12px; color: #4B5563; line-height: 1.6; margin-bottom: 6px; }
.note-item:last-child { margin-bottom: 0; }
.state-card { align-items: center; background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; padding: 32px 20px; }
.state-title { font-size: 17px; color: #111827; font-weight: 900; }
.state-sub { margin-top: 8px; font-size: 13px; color: #6B7280; line-height: 1.7; text-align: center; }
.state-btn { margin-top: 18px; min-width: 120px; height: 42px; border-radius: 8px; background: #086CEA; align-items: center; justify-content: center; padding: 0 16px; }
.state-btn-text { color: #fff; font-size: 14px; font-weight: 900; }
.bottom-safe { height: 36px; }
</style>
