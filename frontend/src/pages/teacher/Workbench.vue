<template>
  <view class="page rpt-page">
    <view class="nav">
      <RptBackButton @click="goBack" />
      <text class="nav-title">银行老师端</text>
      <view class="nav-link" @click="goApply">
        <text class="nav-link-text">入驻</text>
      </view>
    </view>

    <DesktopShell side="left" sidebarWidth="300px" :maxWidth="'1440px'">
      <template #sidebar>
        <view class="desktop-sidebar-inner">
          <view class="hero">
            <view class="hero-main">
              <text class="hero-kicker">本机构端口</text>
              <text class="hero-title">{{ greeting }}</text>
              <text class="hero-desc">只展示匹配 {{ institutionName }} 的客户信息和客服协同沟通。</text>
              <view class="sync-line">
                <text class="sync-dot" :class="syncMeta.state"></text>
                <text class="sync-text">{{ syncMeta.label }}</text>
                <text class="sync-source hide-mobile">{{ syncMeta.sourceText }}</text>
                <text class="sync-time hide-mobile">{{ syncMeta.timeText }}</text>
              </view>
              <view v-if="writebackGapCount" class="hero-alert" @click="goClientsWriteback">
                <text class="hero-alert-text">{{ writebackGapCount }} 位客户回写待核对</text>
                <text class="hero-alert-link">去筛选</text>
              </view>
            </view>
            <view class="hero-badge hide-mobile">
              <text class="hero-badge-num">{{ stats.pending }}</text>
              <text class="hero-badge-text">待处理</text>
            </view>
          </view>

          <view v-if="incomingNotice" class="incoming-toast" @click="openIncomingNotice">
            <view class="incoming-dot"></view>
            <view class="incoming-main">
              <text class="incoming-title">客户新消息</text>
              <text class="incoming-text">{{ incomingNotice.name }}：{{ incomingNotice.text }}</text>
            </view>
            <text class="incoming-link">查看</text>
          </view>

          <view v-if="stats.pending || stats.todayNew || stats.monthDone" class="stats-grid stats-grid-sidebar">
            <view v-for="item in metricItems" :key="item.label" class="metric">
              <text class="metric-num">{{ item.value }}</text>
              <text class="metric-label">{{ item.label }}</text>
            </view>
          </view>

          <view class="quick-grid">
            <view class="quick-card" @click="goClients">
              <view class="quick-icon"><text class="quick-icon-text">客</text></view>
              <view class="quick-main">
                <text class="quick-title">客户信息界面</text>
                <text class="quick-desc">{{ clientsQuickDesc }}</text>
              </view>
              <RptChevron class="quick-arrow" direction="right" />
            </view>
            <view class="quick-card" @click="goTasks">
              <view class="quick-icon amber"><text class="quick-icon-text amber">办</text></view>
              <view class="quick-main">
                <text class="quick-title">待办任务</text>
                <text class="quick-desc">处理联系与补资料提醒</text>
              </view>
              <RptChevron class="quick-arrow" direction="right" />
            </view>
          </view>
        </view>
      </template>

      <view class="desktop-main-inner">
        <scroll-view class="scroll-body" scroll-y refresher-enabled :refresher-triggered="refreshing" @refresherrefresh="refresh">
          <view class="wrap">

        <view v-if="loading" class="state-card">
          <text class="state-title">正在加载工作台</text>
          <text class="state-sub">同步客户、待办和最新进度。</text>
        </view>

        <view v-else-if="!loggedIn" class="state-card">
          <text class="state-title">登录后进入经理端</text>
          <text class="state-sub">银行经理端需要绑定账号，用于审核身份和记录服务行为。</text>
          <view class="state-btn" @click="goLogin">
            <text class="state-btn-text">去登录</text>
          </view>
        </view>

        <view v-else-if="showReviewGate" class="state-card">
          <text class="state-title">入驻资料审核中</text>
          <text class="state-sub">审核通过后会开通客户工作台。你可以先查看流程或更新资料。</text>
          <view class="state-actions">
            <view class="state-ghost" @click="goReviewing"><text class="state-ghost-text">查看审核</text></view>
            <view class="state-btn compact" @click="goApply"><text class="state-btn-text">更新资料</text></view>
          </view>
        </view>

        <view v-else-if="showApplyGate" class="state-card">
          <text class="state-title">申请开通老师端</text>
          <text class="state-sub">提交银行/机构、岗位和资质材料后，平台会为你开通客户跟进权限。</text>
          <view class="state-btn" @click="goApply">
            <text class="state-btn-text">提交入驻申请</text>
          </view>
        </view>

        <view v-else>
          <view class="panel-tabs">
            <view class="panel-tab" :class="{ active: activePanel === 'clients' }" @click="activePanel = 'clients'">
              <text class="panel-tab-text" :class="{ active: activePanel === 'clients' }">本行客户</text>
              <text class="panel-tab-count">{{ clientRows.length }}</text>
            </view>
            <view class="panel-tab" :class="{ active: activePanel === 'groups' }" @click="activePanel = 'groups'">
              <text class="panel-tab-text" :class="{ active: activePanel === 'groups' }">客服沟通</text>
              <text class="panel-tab-count">{{ groupRows.length }}</text>
            </view>
          </view>

          <view v-if="activePanel === 'clients'">
            <view class="section-head">
              <text class="section-title">本机构客户</text>
              <text class="section-more" @click="goClients">全部客户</text>
            </view>

            <view v-if="clientRows.length" class="client-list">
              <SwipeDelete
                v-for="client in clientRows"
                :key="client.id"
                :disabled="!canDeleteConversation(client)"
                @content-click="openClient(client)"
                @delete="deleteConversation(client)"
              >
                <view class="client-card">
                <view class="avatar"><text class="avatar-text">{{ avatarOf(client.name) }}</text></view>
                <view class="client-main">
                  <view class="client-line">
                    <text class="client-name">{{ client.name || '未命名客户' }}</text>
                    <text v-if="client.hasUnread" class="unread-badge">{{ client.unreadCount || 1 }}</text>
                    <text class="status" :class="statusClass(client.status)">{{ client.statusText || statusText(client.status) }}</text>
                  </view>
                  <text class="client-sub">{{ client.time || '暂无最近记录' }}</text>
                  <text v-if="client.productName || client.rateText" class="client-product">
                    {{ client.productName || '咨询产品' }} · 参考利率 {{ client.rateText || '详询' }}
                  </text>
                  <text v-if="client.advisorJoinRequired" class="client-access">{{ client.advisorAccessText || '待客服确认进入群聊' }}</text>
                  <ServiceProgressStrip :source="client" compact :show-alert="false" @material-click="openMaterialArchive(client)" />
                </view>
                </view>
              </SwipeDelete>
            </view>

            <view v-else class="empty-card">
              <text class="empty-title">暂无本机构客户</text>
              <text class="empty-sub">只有匹配到 {{ institutionName }} 的客户会出现在这里。</text>
            </view>
          </view>

          <view v-else>
            <view class="section-head">
              <text class="section-title">客服协同沟通</text>
              <text class="section-more">三方群</text>
            </view>

            <view v-if="groupRows.length" class="group-list">
              <SwipeDelete
                v-for="group in groupRows"
                :key="group.contactId || group.id"
                :disabled="!canDeleteConversation(group)"
                @content-click="openGroupChat(group)"
                @delete="deleteConversation(group)"
              >
                <view class="group-card">
                <view class="group-top">
                  <view class="avatar"><text class="avatar-text">{{ avatarOf(group.name) }}</text></view>
                  <view class="group-main">
                    <view class="client-line">
                      <text class="client-name">{{ group.name || '未命名客户' }}</text>
                      <text v-if="group.hasUnread" class="unread-badge">{{ group.unreadCount || 1 }}</text>
                      <text class="status" :class="groupProgressClass(group)">{{ groupProgressText(group) }}</text>
                    </view>
                    <text class="client-sub">{{ group.productName || '咨询产品' }} · {{ group.time || '暂无最近记录' }}</text>
                    <text class="client-product">{{ group.serviceAssigneeName ? `客服 ${group.serviceAssigneeName}` : '客服待接单' }} · {{ group.advisorJoinRequired ? '待客服确认拉入' : group.advisorAssigneeName ? '本机构已接入' : '待银行老师接单' }}</text>
                    <text v-if="group.advisorJoinRequired" class="client-access">{{ group.advisorAccessText || '待客服确认后可查看聊天记录' }}</text>
                    <ServiceProgressStrip :source="group" compact :show-alert="false" @material-click="openMaterialArchive(group)" />
                  </view>
                </view>
                </view>
              </SwipeDelete>
            </view>

            <view v-else class="empty-card">
              <text class="empty-title">暂无客服协同群</text>
              <text class="empty-sub">客户匹配 {{ institutionName }} 产品后，会生成客户、客服、银行老师三方群。</text>
            </view>
          </view>
        </view>

        <view class="bottom-safe"></view>
          </view>
        </scroll-view>
      </view>
    </DesktopShell>
  </view>
</template>

<script setup>
import { computed, ref } from 'vue'
import { onHide, onShow } from '@/compat/web-lifecycle.js'
import { isLoggedIn, getCachedUserInfo } from '@/services/authService.js'
import { switchToAdvisor } from '@/services/roleService.js'
import { getTeacherWorkbenchData, startTeacherRealtimeRefresh } from '@/services/teacherService.js'
import { clearAdvisorContactView } from '@/services/profileService.js'
import { DEFAULT_TEACHER_SYNC_META } from '@/services/teacherRealtime.js'
import SwipeDelete from '@/components/SwipeDelete.vue'
import ServiceProgressStrip from '@/components/ServiceProgressStrip.vue'
import DesktopShell from '@/components/layout/DesktopShell.vue'
import RptBackButton from '@/components/RptBackButton.vue'
import RptChevron from '@/components/RptChevron.vue'
import safeBack from '@/utils/safeBack.js'

const STORAGE_KEY = 'teacher_application'
const loggedIn = ref(false)
const loading = ref(false)
const refreshing = ref(false)
const application = ref(null)
const source = ref('')
const stats = ref({ todayNew: 0, pending: 0, monthDone: 0 })
const recentClients = ref([])
const syncMeta = ref({ ...DEFAULT_TEACHER_SYNC_META })
const activePanel = ref('clients')
const incomingNotice = ref(null)
let messageKeysReady = false
let seenMessageKeys = new Set()
let incomingNoticeTimer = null

const readApplication = () => {
  const raw = uni.getStorageSync(STORAGE_KEY)
  if (!raw) return null
  if (typeof raw === 'object') return raw
  try { return JSON.parse(raw) } catch (e) { return null }
}

const greeting = computed(() => {
  const u = getCachedUserInfo() || {}
  const name = u.nickname || u.realName || u.userName || ''
  return name ? `${name}，今日客户进度` : '今日客户进度'
})

const institutionName = computed(() => {
  const u = getCachedUserInfo() || {}
  return u.institution || u.bankName || u.company || '当前机构'
})

const metricItems = computed(() => [
  { label: '今日新增', value: stats.value.todayNew || 0 },
  { label: '待处理', value: stats.value.pending || 0 },
  { label: '本月完成', value: stats.value.monthDone || 0 }
])

const hasWorkbenchData = computed(() => {
  if (source.value && source.value !== 'none') return true
  if (recentClients.value.length > 0) return true
  return (stats.value.todayNew || 0) + (stats.value.pending || 0) + (stats.value.monthDone || 0) > 0
})
const showReviewGate = computed(() => loggedIn.value && !hasWorkbenchData.value && application.value && application.value.status === 'reviewing')
const showApplyGate = computed(() => loggedIn.value && !hasWorkbenchData.value && !application.value)

const writebackMissingCountOf = (client) => {
  const summary = client && client.writebackSummary
  if (!summary || !summary.hasWritebacks) return 0
  const missing = Array.isArray(summary.missingFields) ? summary.missingFields.length : 0
  const incomplete = Number(summary.counts && summary.counts.incomplete ? summary.counts.incomplete : 0)
  return missing + incomplete
}
const writebackGapCount = computed(() => recentClients.value.filter((client) => writebackMissingCountOf(client) > 0).length)
const clientsQuickDesc = computed(() => writebackGapCount.value ? `${writebackGapCount.value} 位回写待核对` : '筛选状态与搜索客户')
const clientRows = computed(() => recentClients.value)
const groupRows = computed(() => recentClients.value.filter((item) => item.serviceRequired || item.groupMode === 'service-bank-customer'))

const normalizeRecent = (list) => Array.isArray(list)
  ? list.map((item, index) => ({
    id: item.id || item.clientId || item.contactId || `client-${index}`,
    contactId: item.contactId || item.id || '',
    channel: item.channel || '',
    name: item.name || item.clientName || '未命名客户',
    time: item.time || item.latestTime || '暂无最近记录',
    status: item.status || 'processing',
    statusText: item.statusText || statusText(item.status),
    summary: item.summary || '',
    productName: item.productName || '',
    rateText: item.rateText || '',
    amountText: item.amountText || '',
    termText: item.termText || '',
    groupMode: item.groupMode || '',
    serviceRequired: item.serviceRequired === true,
    serviceAssigneeId: item.serviceAssigneeId || '',
    serviceAssigneeName: item.serviceAssigneeName || '',
    advisorAssigneeId: item.advisorAssigneeId || '',
    advisorAssigneeName: item.advisorAssigneeName || '',
    advisorJoinRequired: item.advisorJoinRequired === true,
    chatAccess: item.chatAccess !== false,
    advisorAccessText: item.advisorAccessText || '',
    unreadCount: Number(item.unreadCount || 0),
    hasUnread: item.hasUnread === true || Number(item.unreadCount || 0) > 0,
    messages: Array.isArray(item.messages) ? item.messages : [],
    latestMessage: item.latestMessage || (Array.isArray(item.messages) && item.messages.length ? item.messages[item.messages.length - 1] : null),
    materials: Array.isArray(item.materials) ? item.materials : Array.isArray(item.context && item.context.materials) ? item.context.materials : [],
    pendingMaterials: Array.isArray(item.pendingMaterials) ? item.pendingMaterials : [],
    writebackSummary: item.writebackSummary || null
  }))
  : []

let stopLiveRefresh = () => {}

const resetSyncMeta = () => { syncMeta.value = { ...DEFAULT_TEACHER_SYNC_META } }

const load = async (opts = {}) => {
  loggedIn.value = isLoggedIn()
  application.value = readApplication()
  if (!loggedIn.value) {
    source.value = 'none'
    resetSyncMeta()
    return
	  }
	  if (!opts.silent) loading.value = true
	  try {
	    const switched = await switchToAdvisor()
	    if (!switched.ok) throw new Error(switched.errMsg || '银行经理端暂未开通')
	    const data = await getTeacherWorkbenchData({ port: 'bank' })
	    stats.value = data.stats || { todayNew: 0, pending: 0, monthDone: 0 }
	    const nextRecent = normalizeRecent(data.recentClients)
	    recentClients.value = nextRecent
	    detectIncomingMessages(nextRecent, { prime: !opts.silent })
	    source.value = data.source || ''
	    syncMeta.value = data.syncMeta || { ...DEFAULT_TEACHER_SYNC_META }
	  } catch (e) {
	    if (e && e.statusCode === 401) loggedIn.value = false
	    if (!opts.silent && e && e.message) uni.showToast({ title: e.message, icon: 'none' })
	    source.value = 'none'
    recentClients.value = []
    stats.value = { todayNew: 0, pending: 0, monthDone: 0 }
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
  if (incomingNoticeTimer) clearTimeout(incomingNoticeTimer)
  incomingNoticeTimer = null
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

const statusClass = (status) => {
  if (status === 'completed' || status === 'done' || status === 'resolved') return 'done'
  if (status === 'pending' || status === 'new' || status === 'todo') return 'pending'
  if (status === 'need_info') return 'need'
  return 'processing'
}

const avatarOf = (name) => String(name || '客').slice(0, 1)
const groupProgressText = (item = {}) => {
  if (item.serviceAssigneeId && item.advisorAssigneeId) return '双端已接入'
  if (item.serviceAssigneeId || item.advisorAssigneeId) return '部分接入'
  return '待接单'
}
const groupProgressClass = (item = {}) => {
  if (item.serviceAssigneeId && item.advisorAssigneeId) return 'done'
  if (item.serviceAssigneeId || item.advisorAssigneeId) return 'processing'
  return 'pending'
}
const latestMessageOf = (item = {}) => item.latestMessage || (Array.isArray(item.messages) && item.messages.length ? item.messages[item.messages.length - 1] : null)
const latestCustomerMessageKey = (item = {}) => {
  const msg = latestMessageOf(item)
  if (!msg || msg.senderType !== 'user') return ''
  const id = item.contactId || item.id || ''
  const sig = msg.id || msg.createdAt || msg.updateTime || msg.content || ''
  return id && sig ? `${id}:${sig}` : ''
}
const latestMessageText = (item = {}) => {
  const msg = latestMessageOf(item)
  return (msg && msg.content) || item.summary || '发来一条咨询消息'
}
const rememberMessageKeys = (list = []) => {
  seenMessageKeys = new Set(list.map(latestCustomerMessageKey).filter(Boolean))
  messageKeysReady = true
}
const openConversation = (item = {}) => {
  if (item.advisorJoinRequired) {
    uni.showToast({ title: item.advisorAccessText || '待客服确认后可进入群聊', icon: 'none' })
    return
  }
  const id = item.contactId || item.id
  if (id) uni.navigateTo({ url: `/pages/chat/conversation?contactId=${encodeURIComponent(id)}` })
}
const showIncomingMessage = (item = {}) => {
  incomingNotice.value = {
    item,
    name: item.name || '客户',
    text: latestMessageText(item).slice(0, 80) || '发来一条咨询消息'
  }
  if (incomingNoticeTimer) clearTimeout(incomingNoticeTimer)
  incomingNoticeTimer = setTimeout(() => {
    incomingNotice.value = null
    incomingNoticeTimer = null
  }, 8000)
}
const openIncomingNotice = () => {
  const item = incomingNotice.value && incomingNotice.value.item
  incomingNotice.value = null
  if (incomingNoticeTimer) clearTimeout(incomingNoticeTimer)
  incomingNoticeTimer = null
  if (item) openConversation(item)
}
const detectIncomingMessages = (list = [], opts = {}) => {
  if (opts.prime || !messageKeysReady) {
    rememberMessageKeys(list)
    return
  }
  const incoming = list.find((item) => {
    const key = latestCustomerMessageKey(item)
    return key && !seenMessageKeys.has(key)
  })
  rememberMessageKeys(list)
  if (incoming) showIncomingMessage(incoming)
}
const goBack = () => safeBack('/pages/profile/profile')
const goLogin = () => uni.navigateTo({ url: '/pages/login/index' })
const goApply = () => uni.navigateTo({ url: '/pages/teacher/apply' })
const goReviewing = () => uni.navigateTo({ url: '/pages/teacher/reviewing' })
const goClients = () => uni.navigateTo({ url: '/pages/teacher/clients' })
const goClientsWriteback = () => uni.navigateTo({ url: '/pages/teacher/clients?filter=writeback' })
const goTasks = () => uni.navigateTo({ url: '/pages/teacher/tasks' })
const openClient = (client) => uni.navigateTo({ url: `/pages/teacher/client-detail?id=${encodeURIComponent(client.id || client.name || '')}` })
const openGroupChat = (group) => openConversation(group)
const openMaterialArchive = (item = {}) => {
  const id = item.contactId || item.id || ''
  if (!id) return
  uni.navigateTo({ url: `/pages/teacher/client-detail?id=${encodeURIComponent(id)}&focus=materials` })
}
const canDeleteConversation = (item = {}) => !!(item.contactId || item.id)
const deleteConversation = async (item = {}) => {
  const id = item.contactId || item.id
  if (!id || !canDeleteConversation(item)) return
  try {
    await clearAdvisorContactView(id)
    recentClients.value = recentClients.value.filter((row) => String(row.contactId || row.id || '') !== String(id))
    uni.showToast({ title: '已删除聊天框', icon: 'none' })
  } catch (e) {
    uni.showToast({ title: e && e.message ? e.message : '删除失败', icon: 'none' })
  }
}

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
.hero { flex-direction: row; align-items: center; background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; padding: 18px; }
.incoming-toast { flex-direction: row; align-items: center; background: #EEF6FF; border: 1px solid #BFDBFE; border-radius: 8px; padding: 11px 12px; margin-top: 12px; }
.incoming-dot { width: 8px; height: 8px; border-radius: 4px; background: #086CEA; margin-right: 10px; }
.incoming-main { flex: 1; min-width: 0; }
.incoming-title { font-size: 12px; color: #1D4ED8; font-weight: 900; }
.incoming-text { margin-top: 3px; font-size: 12px; color: #334155; line-height: 1.35; }
.incoming-link { margin-left: 10px; font-size: 12px; color: #086CEA; font-weight: 900; }
.hero-main { flex: 1; }
.hero-kicker { font-size: 12px; color: #086CEA; font-weight: 900; }
.hero-title { margin-top: 6px; font-size: 21px; color: #111827; font-weight: 900; line-height: 1.25; }
.hero-desc { margin-top: 7px; font-size: 13px; color: #6B7280; }
.hero-alert { margin-top: 10px; align-self: flex-start; height: 30px; border-radius: 8px; border: 1px solid #FDE68A; background: #FFFBEB; padding: 0 9px; flex-direction: row; align-items: center; }
.hero-alert-text { font-size: 11px; color: #92400E; font-weight: 900; }
.hero-alert-link { margin-left: 8px; font-size: 11px; color: #086CEA; font-weight: 900; }
.sync-line { flex-direction: row; align-items: center; flex-wrap: wrap; margin-top: 10px; }
.sync-dot { width: 7px; height: 7px; border-radius: 4px; background: #CBD5E1; margin-right: 6px; }
.sync-dot.live { background: #16A34A; }
.sync-dot.incomplete { background: #F59E0B; }
.sync-dot.offline, .sync-dot.stale { background: #C62828; }
.sync-text { font-size: 11px; color: #374151; font-weight: 900; margin-right: 8px; }
.sync-source, .sync-time { font-size: 11px; color: #9CA3AF; margin-right: 8px; }
.hero-badge { width: 72px; height: 72px; border-radius: 8px; background: #EAF3FF; border: 1px solid #BFDBFE; align-items: center; justify-content: center; margin-left: 12px; }
.hero-badge-num { font-size: 22px; color: #086CEA; font-weight: 900; }
.hero-badge-text { margin-top: 2px; font-size: 12px; color: #086CEA; font-weight: 800; }
.state-card { align-items: center; margin-top: 12px; background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; padding: 30px 20px; }
.state-title { font-size: 17px; color: #111827; font-weight: 900; }
.state-sub { margin-top: 8px; font-size: 13px; color: #6B7280; line-height: 1.7; text-align: center; }
.state-btn { margin-top: 18px; min-width: 138px; height: 42px; border-radius: 8px; background: #086CEA; align-items: center; justify-content: center; padding: 0 16px; }
.state-btn.compact { margin-top: 0; }
.state-btn-text { color: #fff; font-size: 14px; font-weight: 900; }
.state-actions { flex-direction: row; align-items: center; margin-top: 18px; }
.state-ghost { height: 42px; padding: 0 16px; border-radius: 8px; border: 1px solid #E5E7EB; align-items: center; justify-content: center; margin-right: 10px; }
.state-ghost-text { font-size: 14px; color: #374151; font-weight: 900; }
.stats-grid { flex-direction: row; margin-top: 12px; }
.metric { flex: 1; background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; padding: 16px 6px; align-items: center; margin-right: 8px; }
.metric:last-child { margin-right: 0; }
.metric-num { font-size: 24px; color: #111827; font-weight: 900; }
.metric-label { margin-top: 5px; font-size: 12px; color: #6B7280; font-weight: 700; }
.quick-grid { margin-top: 12px; }
.quick-card { flex-direction: row; align-items: center; background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; padding: 14px; margin-bottom: 10px; }
.quick-icon { width: 38px; height: 38px; border-radius: 8px; background: #EAF3FF; border: 1px solid #BFDBFE; align-items: center; justify-content: center; margin-right: 12px; }
.quick-icon.amber { background: #FFFBEB; border-color: #FDE68A; }
.quick-icon-text { font-size: 14px; color: #086CEA; font-weight: 900; }
.quick-icon-text.amber { color: #B45309; }
.quick-main { flex: 1; }
.quick-title { font-size: 15px; color: #111827; font-weight: 900; }
.quick-desc { margin-top: 4px; font-size: 12px; color: #9CA3AF; }
.quick-arrow { width: 22px; height: 22px; display: flex; flex: 0 0 22px; align-items: center; justify-content: center; padding: 0; box-sizing: border-box; color: #C7CBD1; }
.panel-tabs { flex-direction: row; background: #fff; border: 1px solid #EEF0F4; border-radius: 8px; padding: 5px; margin-top: 12px; }
.panel-tab { flex: 1; height: 38px; border-radius: 8px; flex-direction: row; align-items: center; justify-content: center; }
.panel-tab.active { background: #EAF3FF; border: 1px solid #BFDBFE; }
.panel-tab-text { font-size: 13px; color: #64748B; font-weight: 900; }
.panel-tab-text.active { color: #086CEA; }
.panel-tab-count { margin-left: 6px; min-width: 18px; text-align: center; font-size: 11px; color: #086CEA; font-weight: 900; }
.section-head { flex-direction: row; align-items: center; justify-content: space-between; margin: 16px 2px 10px; }
.section-title { font-size: 16px; color: #111827; font-weight: 900; }
.section-more { font-size: 12px; color: #086CEA; font-weight: 900; }
.client-card { flex-direction: row; align-items: center; background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; padding: 14px; }
.group-card { background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; padding: 14px; }
.group-top { flex-direction: row; align-items: center; }
.group-main { flex: 1; }
.avatar { width: 42px; height: 42px; border-radius: 21px; background: #F8FAFC; border: 1px solid #E5E7EB; align-items: center; justify-content: center; margin-right: 12px; }
.avatar-text { font-size: 15px; color: #475569; font-weight: 900; }
.client-main { flex: 1; }
.client-line { flex-direction: row; align-items: center; }
.client-name { flex: 1; font-size: 15px; color: #111827; font-weight: 900; }
.unread-badge { min-width: 18px; height: 18px; border-radius: 9px; background: #EF4444; color: #fff; font-size: 10px; line-height: 18px; text-align: center; font-weight: 900; margin-right: 6px; overflow: hidden; }
.client-sub { margin-top: 5px; font-size: 12px; color: #9CA3AF; }
.client-product { margin-top: 5px; font-size: 12px; color: #1D4ED8; font-weight: 800; line-height: 1.45; }
.client-access { margin-top: 5px; font-size: 11px; color: #B45309; font-weight: 900; line-height: 1.4; }
.status { font-size: 11px; font-weight: 900; padding: 4px 7px; border-radius: 8px; overflow: hidden; }
.status.pending { color: #086CEA; background: #EAF3FF; }
.status.processing { color: #1D4ED8; background: #EFF6FF; }
.status.need { color: #B45309; background: #FFFBEB; }
.status.done { color: #15803D; background: #F0FDF4; }
.empty-card { align-items: center; background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; padding: 28px 18px; }
.empty-title { font-size: 15px; color: #111827; font-weight: 900; }
.empty-sub { margin-top: 7px; font-size: 12px; color: #9CA3AF; text-align: center; line-height: 1.6; }
.bottom-safe { height: 36px; }
.desktop-sidebar-inner { padding: 4px 0; }
.desktop-main-inner { min-width: 0; }
.stats-grid-sidebar { flex-direction: column; }
.stats-grid-sidebar .metric { margin-right: 0; margin-bottom: 8px; }
@media (min-width: 1024px) {
  .scroll-body { height: calc(100vh - 60px); }
}
</style>
