<template>
  <view class="page rpt-page">
    <view class="nav">
      <RptBackButton @click="goBack" />
      <text class="nav-title">客户列表</text>
      <view class="nav-spacer"></view>
    </view>

    <view class="search-wrap">
      <view class="search-box">
        <text class="search-icon">⌕</text>
        <input v-model.trim="keyword" class="search-input" placeholder="搜索姓名、手机号或状态" maxlength="30" />
      </view>
      <view class="sync-line">
        <text class="sync-dot" :class="syncMeta.state"></text>
        <text class="sync-text">{{ syncMeta.label }}</text>
        <text class="sync-source">{{ syncMeta.sourceText }}</text>
        <text class="sync-time">{{ syncMeta.timeText }}</text>
      </view>
      <view v-if="loggedIn && writebackIncompleteCount" class="writeback-alert">
        <view class="writeback-alert-main">
          <text class="writeback-alert-title">回写缺口</text>
          <text class="writeback-alert-sub">{{ writebackAlertText }}</text>
        </view>
        <view class="writeback-alert-action" @click="currentTab = 'writeback'">
          <text class="writeback-alert-action-text">{{ currentTab === 'writeback' ? '查看中' : '只看缺口' }}</text>
        </view>
      </view>
      <scroll-view class="tabs" scroll-x>
        <view class="tabs-inner">
          <view v-for="tab in tabs" :key="tab.key" class="tab" :class="{ active: currentTab === tab.key }" @click="currentTab = tab.key">
            <text class="tab-text" :class="{ active: currentTab === tab.key }">{{ tab.label }}</text>
            <text v-if="tab.count != null" class="tab-count" :class="{ active: currentTab === tab.key }">{{ tab.count }}</text>
          </view>
        </view>
      </scroll-view>
    </view>

    <scroll-view class="scroll-body" scroll-y refresher-enabled :refresher-triggered="refreshing" @refresherrefresh="refresh">
      <view class="wrap rpt-content-max">
        <view v-if="loading" class="state-card">
          <text class="state-title">正在加载客户</text>
          <text class="state-sub">同步授权客户与最近进度。</text>
        </view>

        <view v-else-if="!loggedIn" class="state-card">
          <text class="state-title">登录后查看客户</text>
          <text class="state-sub">客户列表仅面向已认证老师账号开放。</text>
          <view class="state-btn" @click="goLogin"><text class="state-btn-text">去登录</text></view>
        </view>

        <view v-else-if="filteredClients.length" class="client-list">
          <view v-for="client in filteredClients" :key="client.id" class="client-card" @click="openClient(client)">
            <view class="client-top">
              <view class="avatar"><text class="avatar-text">{{ avatarOf(client.name) }}</text></view>
              <view class="client-main">
                <view class="client-name-line">
                  <text class="client-name">{{ client.name }}</text>
                  <text class="status" :class="statusClass(client.status)">{{ client.statusText || statusText(client.status) }}</text>
                </view>
                <text class="client-meta">{{ client.phone || '未留手机号' }} · {{ client.time || '暂无最近记录' }}</text>
              </view>
            </view>
            <view class="client-bottom">
              <view class="info-cell">
                <text class="info-label">授权状态</text>
                <text class="info-value">{{ client.consentText || '已授权咨询' }}</text>
              </view>
              <view class="info-cell">
                <text class="info-label">风险摘要</text>
                <text class="info-value">{{ client.riskText || client.summary || '待查看报告' }}</text>
              </view>
              <view v-if="client.productName || client.rateText || client.amountText" class="info-cell product-cell">
                <text class="info-label">咨询产品</text>
                <view class="product-info">
                  <text class="product-name">{{ client.productName || '待确认产品' }}</text>
                  <text class="product-rate">参考利率 {{ client.rateText || '详询' }}{{ client.amountText ? ` · 额度 ${client.amountText}` : '' }}</text>
                </view>
              </view>
              <view v-if="client.writebackSummary && client.writebackSummary.hasWritebacks" class="info-cell writeback-cell">
                <text class="info-label">回写状态</text>
                <view class="writeback-inline">
                  <text class="writeback-chip" :class="writebackStatusClass(client)">{{ writebackStatusText(client) }}</text>
                  <text class="writeback-hint">{{ writebackHintOf(client) }}</text>
                </view>
              </view>
            </view>
          </view>
        </view>

        <view v-else class="state-card">
          <text class="state-title">{{ emptyStateTitle }}</text>
          <text class="state-sub">{{ emptyStateSub }}</text>
          <view v-if="keyword || currentTab !== 'all'" class="state-ghost" @click="resetFilter">
            <text class="state-ghost-text">清空筛选</text>
          </view>
        </view>

        <view class="bottom-safe"></view>
      </view>
    </scroll-view>
  </view>
</template>

<script setup>
import { computed, ref } from 'vue'
import { onHide, onLoad, onShow } from '@/compat/web-lifecycle.js'
import { isLoggedIn } from '@/services/authService.js'
import { switchToAdvisor } from '@/services/roleService.js'
import { getTeacherClientsData, startTeacherRealtimeRefresh } from '@/services/teacherService.js'
import { DEFAULT_TEACHER_SYNC_META } from '@/services/teacherRealtime.js'
import RptBackButton from '@/components/RptBackButton.vue'
import safeBack from '@/utils/safeBack.js'

const loggedIn = ref(false)
const loading = ref(false)
const refreshing = ref(false)
const keyword = ref('')
const currentTab = ref('all')
const clients = ref([])
const syncMeta = ref({ ...DEFAULT_TEACHER_SYNC_META })

const normalizeClient = (item, index) => ({
  id: item.id || item.clientId || item.contactId || `client-${index}`,
  name: item.name || item.clientName || '未命名客户',
  phone: item.phone || item.mobile || '',
  time: item.time || item.latestTime || item.updateTime || '暂无最近记录',
  status: item.status || 'processing',
  statusText: item.statusText || statusText(item.status),
  consentText: item.consentText || item.consentStatusText || '',
  riskText: item.riskText || item.riskLevelText || '',
  summary: item.summary || item.desc || '',
  productName: item.productName || '',
  rateText: item.rateText || '',
  amountText: item.amountText || '',
  termText: item.termText || '',
  writebackSummary: item.writebackSummary || null
})

const filteredClients = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return clients.value.filter((client) => {
    const tabOk = currentTab.value === 'all'
      || (currentTab.value === 'writeback' ? isWritebackIncomplete(client) : normalizedTabStatus(client.status) === currentTab.value)
    if (!tabOk) return false
    if (!kw) return true
    const haystack = [client.name, client.phone, client.statusText, client.riskText, client.summary, writebackStatusText(client), writebackHintOf(client)].join(' ').toLowerCase()
    return haystack.includes(kw)
  })
})

const tabs = computed(() => {
  const count = (key) => clients.value.filter((c) => key === 'all' || normalizedTabStatus(c.status) === key).length
  return [
    { key: 'all', label: '全部', count: clients.value.length },
    { key: 'writeback', label: '回写缺口', count: writebackIncompleteCount.value },
    { key: 'pending', label: '待处理', count: count('pending') },
    { key: 'processing', label: '处理中', count: count('processing') },
    { key: 'need_info', label: '待补充', count: count('need_info') },
    { key: 'completed', label: '已完成', count: count('completed') }
  ]
})

const writebackMissingCountOf = (client) => {
  const summary = client && client.writebackSummary
  if (!summary || !summary.hasWritebacks) return 0
  const missing = Array.isArray(summary.missingFields) ? summary.missingFields.length : 0
  const incomplete = Number(summary.counts && summary.counts.incomplete ? summary.counts.incomplete : 0)
  return missing + incomplete
}

const isWritebackIncomplete = (client) => writebackMissingCountOf(client) > 0
const writebackIncompleteClients = computed(() => clients.value.filter(isWritebackIncomplete))
const writebackIncompleteCount = computed(() => writebackIncompleteClients.value.length)
const writebackSyncedCount = computed(() => clients.value.filter((client) => {
  const summary = client && client.writebackSummary
  return summary && summary.hasWritebacks && !isWritebackIncomplete(client)
}).length)
const writebackAlertText = computed(() => `${writebackIncompleteCount.value} 位客户服务端回写不完整，优先核对材料、消息回执或推送绑定。已完整 ${writebackSyncedCount.value} 位。`)

const writebackLabel = (field = '') => {
  const raw = String(field)
  if (raw.includes('materialSubmit')) return '材料提交'
  if (raw.includes('messageAction')) return '消息回执'
  if (raw.includes('pushBinding')) return '推送绑定'
  return '回写字段'
}

const writebackStatusText = (client) => {
  const summary = client && client.writebackSummary
  if (!summary || !summary.hasWritebacks) return ''
  return isWritebackIncomplete(client) ? '回写待核对' : '回写已同步'
}

const writebackStatusClass = (client) => isWritebackIncomplete(client) ? 'warn' : 'ok'

const writebackHintOf = (client) => {
  const summary = client && client.writebackSummary
  if (!summary || !summary.hasWritebacks) return ''
  const missing = Array.isArray(summary.missingFields) ? summary.missingFields : []
  if (missing.length) return `缺${writebackLabel(missing[0])}${missing.length > 1 ? `等 ${missing.length} 项` : ''}`
  const incomplete = Number(summary.counts && summary.counts.incomplete ? summary.counts.incomplete : 0)
  if (incomplete) return `${incomplete} 项回写字段不完整`
  const total = Number(summary.counts ? (summary.counts.materialSubmit || 0) + (summary.counts.messageAction || 0) + (summary.counts.pushBinding || 0) : 0)
  return total ? `${total} 项服务端回写完整` : '服务端回写完整'
}

const emptyStateTitle = computed(() => currentTab.value === 'writeback' ? '暂无回写缺口' : '暂无匹配客户')
const emptyStateSub = computed(() => currentTab.value === 'writeback'
  ? '当前客户服务端回写完整，可继续查看全部客户。'
  : '试试切换状态或清空搜索词。新授权客户会自动进入列表。')

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
	    const switched = await switchToAdvisor()
	    if (!switched.ok) throw new Error(switched.errMsg || '银行经理端暂未开通')
	    const data = await getTeacherClientsData({ port: 'bank' })
	    const list = Array.isArray(data.clients) ? data.clients : []
	    clients.value = list.map(normalizeClient)
	    syncMeta.value = data.syncMeta || { ...DEFAULT_TEACHER_SYNC_META }
	  } catch (e) {
	    if (e && e.statusCode === 401) loggedIn.value = false
	    if (!opts.silent && e && e.message) uni.showToast({ title: e.message, icon: 'none' })
	    clients.value = []
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

const normalizedTabStatus = (status) => {
  if (status === 'completed' || status === 'done' || status === 'resolved') return 'completed'
  if (status === 'pending' || status === 'new' || status === 'todo') return 'pending'
  if (status === 'need_info' || status === 'needInfo') return 'need_info'
  return 'processing'
}

const statusText = (status) => {
  const map = { pending: '待处理', processing: '处理中', need_info: '待补充', completed: '已完成', done: '已完成', resolved: '已完成' }
  return map[status] || '处理中'
}

const statusClass = (status) => normalizedTabStatus(status)
const avatarOf = (name) => String(name || '客').slice(0, 1)
const resetFilter = () => { keyword.value = ''; currentTab.value = 'all' }
const goBack = () => safeBack('/pages/teacher/workbench')
const goLogin = () => uni.navigateTo({ url: '/pages/login/index' })
const openClient = (client) => uni.navigateTo({ url: `/pages/teacher/client-detail?id=${encodeURIComponent(client.id || client.name || '')}` })

onLoad((query = {}) => {
  if (query.filter === 'writeback') currentTab.value = 'writeback'
})

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
.nav-spacer { width: 32px; }
.search-wrap { background: #fff; padding: 12px 16px 10px; border-bottom: 1px solid #EEF0F4; }
.search-box { height: 42px; border-radius: 8px; background: #F8FAFC; border: 1px solid #E5E7EB; flex-direction: row; align-items: center; padding: 0 12px; }
.search-icon { font-size: 17px; color: #9CA3AF; margin-right: 8px; }
.search-input { flex: 1; font-size: 14px; color: #111827; }
.sync-line { flex-direction: row; align-items: center; flex-wrap: wrap; margin-top: 9px; }
.sync-dot { width: 7px; height: 7px; border-radius: 4px; background: #CBD5E1; margin-right: 6px; }
.sync-dot.live { background: #16A34A; }
.sync-dot.incomplete { background: #F59E0B; }
.sync-dot.offline, .sync-dot.stale { background: #C62828; }
.sync-text { font-size: 11px; color: #374151; font-weight: 900; margin-right: 8px; }
.sync-source, .sync-time { font-size: 11px; color: #9CA3AF; margin-right: 8px; }
.writeback-alert { margin-top: 10px; flex-direction: row; align-items: center; background: #FFFBEB; border: 1px solid #FDE68A; border-radius: 8px; padding: 10px 10px 10px 12px; }
.writeback-alert-main { flex: 1; }
.writeback-alert-title { font-size: 13px; color: #92400E; font-weight: 900; }
.writeback-alert-sub { margin-top: 4px; font-size: 11px; color: #B45309; line-height: 1.5; }
.writeback-alert-action { height: 32px; border-radius: 8px; background: #086CEA; align-items: center; justify-content: center; padding: 0 10px; margin-left: 10px; }
.writeback-alert-action-text { color: #fff; font-size: 12px; font-weight: 900; }
.tabs { margin-top: 10px; white-space: nowrap; }
.tabs-inner { flex-direction: row; }
.tab { height: 34px; padding: 0 12px; border-radius: 8px; background: #F8FAFC; border: 1px solid #E5E7EB; flex-direction: row; align-items: center; margin-right: 8px; }
.tab.active { background: #EAF3FF; border-color: #BFDBFE; }
.tab-text { font-size: 13px; color: #4B5563; font-weight: 900; }
.tab-text.active { color: #086CEA; }
.tab-count { margin-left: 5px; font-size: 11px; color: #9CA3AF; font-weight: 800; }
.tab-count.active { color: #086CEA; }
.scroll-body { flex: 1; height: calc(100vh - 148px); }
.wrap { padding: 14px 16px 18px; }
.client-card { background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; padding: 14px; margin-bottom: 10px; }
.client-top { flex-direction: row; align-items: center; }
.avatar { width: 42px; height: 42px; border-radius: 21px; background: #F8FAFC; border: 1px solid #E5E7EB; align-items: center; justify-content: center; margin-right: 12px; }
.avatar-text { font-size: 15px; color: #475569; font-weight: 900; }
.client-main { flex: 1; }
.client-name-line { flex-direction: row; align-items: center; }
.client-name { flex: 1; font-size: 15px; color: #111827; font-weight: 900; }
.client-meta { margin-top: 5px; font-size: 12px; color: #9CA3AF; }
.status { font-size: 11px; font-weight: 900; padding: 4px 7px; border-radius: 8px; overflow: hidden; }
.status.pending { color: #086CEA; background: #EAF3FF; }
.status.processing { color: #1D4ED8; background: #EFF6FF; }
.status.need_info { color: #B45309; background: #FFFBEB; }
.status.completed { color: #15803D; background: #F0FDF4; }
.client-bottom { margin-top: 12px; border-top: 1px solid #F3F4F6; padding-top: 12px; }
.info-cell { flex-direction: row; align-items: center; margin-bottom: 8px; }
.info-cell:last-child { margin-bottom: 0; }
.info-label { width: 64px; font-size: 12px; color: #9CA3AF; font-weight: 800; }
.info-value { flex: 1; font-size: 12px; color: #374151; font-weight: 700; }
.product-cell,
.writeback-cell { align-items: flex-start; }
.product-info { flex: 1; }
.product-name { font-size: 12px; color: #111827; font-weight: 900; }
.product-rate { margin-top: 3px; font-size: 12px; color: #1D4ED8; line-height: 1.45; font-weight: 800; }
.writeback-inline { flex: 1; flex-direction: row; align-items: center; flex-wrap: wrap; }
.writeback-chip { font-size: 11px; font-weight: 900; padding: 4px 7px; border-radius: 8px; overflow: hidden; margin-right: 8px; }
.writeback-chip.warn { color: #B45309; background: #FFFBEB; }
.writeback-chip.ok { color: #15803D; background: #F0FDF4; }
.writeback-hint { flex: 1; min-width: 120px; font-size: 12px; color: #6B7280; line-height: 1.5; }
.state-card { align-items: center; background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; padding: 32px 20px; }
.state-title { font-size: 17px; color: #111827; font-weight: 900; }
.state-sub { margin-top: 8px; font-size: 13px; color: #6B7280; line-height: 1.7; text-align: center; }
.state-btn { margin-top: 18px; min-width: 120px; height: 42px; border-radius: 8px; background: #086CEA; align-items: center; justify-content: center; padding: 0 16px; }
.state-btn-text { color: #fff; font-size: 14px; font-weight: 900; }
.state-ghost { margin-top: 18px; height: 42px; border-radius: 8px; border: 1px solid #E5E7EB; align-items: center; justify-content: center; padding: 0 18px; }
.state-ghost-text { color: #374151; font-size: 14px; font-weight: 900; }
.bottom-safe { height: 36px; }
@media (min-width: 1024px) {
  .client-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: 12px; }
  .client-card { margin-bottom: 0; }
}
</style>
