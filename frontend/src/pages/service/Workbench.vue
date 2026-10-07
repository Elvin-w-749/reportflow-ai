<template>
  <view class="page rpt-page">
    <view class="nav">
      <RptBackButton @click="goBack" />
      <text class="nav-title">客服端</text>
      <view class="nav-link" @click="refresh"><text class="nav-link-text">刷新</text></view>
    </view>

    <scroll-view class="scroll-body" scroll-y refresher-enabled :refresher-triggered="refreshing" @refresherrefresh="refresh">
      <view class="wrap rpt-content-max">
        <view class="hero">
          <view class="hero-main">
	            <text class="hero-kicker">客户咨询</text>
	            <text class="hero-title">客服接单工作台</text>
	            <text class="hero-desc">处理客服咨询，也接入产品咨询三方群；接单后才可查看客户资料。</text>
            <view class="sync-line">
              <text class="sync-dot" :class="refreshState"></text>
              <text class="sync-text">{{ refreshStatusText }}</text>
            </view>
          </view>
          <view class="hero-badge">
            <text class="hero-num">{{ pendingCount }}</text>
            <text class="hero-label">待接单</text>
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

        <view v-if="loading" class="state-card">
          <text class="state-title">正在加载客服咨询</text>
          <text class="state-sub">同步用户问题和最新会话。</text>
        </view>

        <view v-else-if="!loggedIn" class="state-card">
          <text class="state-title">登录后进入客服端</text>
          <text class="state-sub">客服端需要账号登录，用于记录回复人和服务留痕。</text>
          <view class="state-btn" @click="goLogin"><text class="state-btn-text">去登录</text></view>
        </view>

        <view v-else-if="!items.length" class="state-card">
          <text class="state-title">暂无客服咨询</text>
          <text class="state-sub">用户从“联系客服”发起问题后会出现在这里。</text>
        </view>

        <view v-else>
          <view class="ticket-tabs">
            <view v-for="tab in serviceTabs" :key="tab.key" class="ticket-tab" :class="{ active: activeTab === tab.key }" @click="activeTab = tab.key">
              <text class="ticket-tab-text" :class="{ active: activeTab === tab.key }">{{ tab.label }}</text>
              <text class="ticket-tab-count">{{ tab.count }}</text>
            </view>
          </view>

          <view v-if="filteredItems.length" class="list">
            <SwipeDelete
              v-for="item in filteredItems"
              :key="item.contactId || item.id"
              :disabled="!canDeleteTicket(item)"
              @content-click="openChat(item)"
              @delete="deleteTicket(item)"
            >
              <view class="ticket-card">
              <view class="ticket-head">
                <view class="avatar">
                  <image
                    v-if="avatarUrlOf(item) && !avatarFailed(item)"
                    class="avatar-image"
                    :src="avatarUrlOf(item)"
                    mode="aspectFill"
                    :aria-label="`${item.name || '客户'}头像`"
                    @error="handleAvatarError(item)"
                  />
                  <text v-else class="avatar-text">{{ avatarOf(item.name) }}</text>
                </view>
                <view class="ticket-main">
                  <view class="ticket-line">
                    <text class="ticket-name">{{ item.name || '客户' }}</text>
                    <text v-if="item.hasUnread" class="unread-badge">{{ item.unreadCount || 1 }}</text>
                    <text v-if="item.reopenedByCustomer" class="reopened-badge">客户新消息重新开启</text>
                    <text class="status" :class="statusClass(item.status)">{{ item.statusText || statusText(item.status) }}</text>
                  </view>
                  <view class="ticket-detail-line">
                    <text class="ticket-uid">UID：{{ clientUidOf(item) || '暂未同步' }}</text>
                    <text class="ticket-meta">{{ item.phone || '未留手机号' }} · {{ item.time || '暂无时间' }}</text>
                  </view>
                </view>
              </view>
              <view class="ticket-body">
                <view class="ticket-business-line">
                  <text class="ticket-business-key">业务</text>
                  <text class="ticket-label">{{ businessText(item) }}</text>
                  <text class="ticket-mode">{{ serviceModeText(item) }}</text>
                </view>
                <text class="ticket-text">{{ latestMessageText(item) }}</text>
                <view class="ticket-actions">
                  <text class="ticket-access">{{ serviceAccessText(item) }}</text>
                  <view v-if="canClaim(item)" class="claim-mini" @click.stop="claimTicket(item)">
                    <text class="claim-mini-text">接单</text>
                  </view>
                </view>
                <ServiceProgressStrip :source="item" compact :show-alert="false" @material-click="openMaterialArchive(item)" />
              </view>
              </view>
            </SwipeDelete>
          </view>

          <view v-else class="state-card slim">
            <text class="state-title">{{ emptyTabTitle }}</text>
            <text class="state-sub">{{ emptyTabSub }}</text>
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
import { getUserId, isLoggedIn } from '@/services/authService.js'
	import { switchToService } from '@/services/roleService.js'
	import {
	  applyServiceWorkbenchHiddenWatermarks,
	  getTeacherClientsData,
	  isTemporaryServiceWorkbenchFailure,
	  serviceWorkbenchCustomerWatermark,
	  shouldApplyServiceWorkbenchResponse
	} from '@/services/teacherService.js'
	import { claimAdvisorContact, clearAdvisorContactView } from '@/services/profileService.js'
import SwipeDelete from '@/components/SwipeDelete.vue'
import ServiceProgressStrip from '@/components/ServiceProgressStrip.vue'
import RptBackButton from '@/components/RptBackButton.vue'
import safeBack from '@/utils/safeBack.js'

const loggedIn = ref(false)
const loading = ref(false)
const refreshing = ref(false)
const items = ref([])
const activeTab = ref('pending')
const incomingNotice = ref(null)
const refreshState = ref('ready')
const lastRefreshAt = ref('')
const failedAvatarKeys = ref([])
const SERVICE_POLL_MS = 6000
let pollTimer = null
let messageKeysReady = false
let seenMessageKeys = new Set()
let incomingNoticeTimer = null
let loadPromise = null
let latestRequestId = 0
const hiddenContacts = new Map()

const firstText = (...values) => {
  for (const value of values) {
    if (value === undefined || value === null) continue
    const text = String(value).trim()
    if (text) return text
  }
  return ''
}
const serviceChannelOf = (item = {}) => String(item.channel || item.deskType || (item.contactType === 'customer-service' ? 'service' : 'bank') || '').trim()
const isServiceWorkItem = (item = {}) => {
  const channel = serviceChannelOf(item)
  return channel === 'service' || item.serviceRequired === true || item.groupMode === 'service-bank-customer' || item.contactType === 'match-product'
}
const availableToClaim = (item = {}) => isServiceWorkItem(item) && !item.serviceAssigneeId
const pendingCount = computed(() => unclaimedItems.value.length)
const claimedByMe = (item = {}) => {
  const uid = getUserId()
  return !!uid && String(item.serviceAssigneeId || '') === String(uid)
}
const unclaimedItems = computed(() => items.value.filter(availableToClaim))
const myItems = computed(() => items.value.filter(claimedByMe))
const visibleItems = computed(() => items.value.filter((item) => availableToClaim(item) || claimedByMe(item)))
const serviceTabs = computed(() => [
  { key: 'pending', label: '待接单', count: unclaimedItems.value.length },
  { key: 'mine', label: '我的接单', count: myItems.value.length },
  { key: 'all', label: '协同记录', count: visibleItems.value.length }
])
const filteredItems = computed(() => {
  if (activeTab.value === 'mine') return myItems.value
  if (activeTab.value === 'pending') return unclaimedItems.value
  return visibleItems.value
})
const emptyTabTitle = computed(() => activeTab.value === 'mine' ? '暂无我的接单' : activeTab.value === 'pending' ? '暂无待接单客户' : '暂无客服协同')
const emptyTabSub = computed(() => activeTab.value === 'mine'
  ? '接单后客户会出现在这里。'
  : activeTab.value === 'pending'
    ? '客户发起客服咨询或产品匹配需要客服介入时，会进入待接单。'
    : '当前没有可处理的客服会话。')
const refreshStatusText = computed(() => {
  if (refreshState.value === 'offline') return '同步异常，稍后自动重试'
  if (refreshState.value === 'syncing') return '正在同步最新咨询'
  return lastRefreshAt.value ? `实时同步中 · ${timeText(lastRefreshAt.value)}` : '实时同步中'
})
const normalizeItem = (item, index) => ({
  ...item,
  id: item.id || item.clientId || item.contactId || `service-${index}`,
  contactId: item.contactId || item.id || '',
  clientUid: firstText(item.clientUid, item.userId, item.uid, item.clientId),
  avatar: firstText(item.avatar, item.avatarUrl, item.avatarURL, item.headImg, item.headImage),
  name: item.name || item.clientName || '客户',
  phone: item.phone || item.mobile || '',
	  status: item.status || 'pending',
	  statusText: item.statusText || statusText(item.status),
	  time: item.time || item.latestTime || item.updateTime || '',
	  productName: item.productName || '',
	  institution: item.institution || '',
	  serviceRequired: item.serviceRequired === true,
	  groupMode: item.groupMode || '',
	  contactType: item.contactType || '',
	  businessName: item.businessName || '',
	  businessType: item.businessType || '',
	  serviceType: item.serviceType || '',
	  contactIntent: item.contactIntent || '',
	  source: item.source || '',
	  serviceAssigneeId: item.serviceAssigneeId || '',
	  serviceAssigneeName: item.serviceAssigneeName || '',
	  materialAccessText: item.materialAccessText || '',
	  materials: Array.isArray(item.materials) ? item.materials : Array.isArray(item.context && item.context.materials) ? item.context.materials : [],
	  supplementMaterials: Array.isArray(item.supplementMaterials)
	    ? item.supplementMaterials
	    : Array.isArray(item.context && item.context.supplementMaterials) ? item.context.supplementMaterials : [],
	  pendingMaterials: Array.isArray(item.pendingMaterials) ? item.pendingMaterials : [],
	  caseId: item.caseId || (item.context && item.context.caseId) || '',
	  reportId: item.reportId || (item.context && item.context.reportId) || '',
	  materialProgressSummary: item.materialProgressSummary || (item.context && item.context.materialProgressSummary) || {},
	  reopenedByCustomer: item.reopenedByCustomer === true || item.serviceReopenedByCustomer === true,
	  unreadCount: Number(item.unreadCount || 0),
	  hasUnread: item.hasUnread === true || Number(item.unreadCount || 0) > 0
	})
const latestMessageOf = (item = {}) => item.latestMessage || (Array.isArray(item.messages) && item.messages.length ? item.messages[item.messages.length - 1] : null)
const timeText = (value) => {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 16)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const latestCustomerMessageKey = (item = {}) => {
  const msg = latestMessageOf(item)
  if (!msg || msg.senderType !== 'user') return ''
  const id = item.contactId || item.id || ''
  const sig = msg.id || msg.createdAt || msg.updateTime || msg.content || ''
  return id && sig ? `${id}:${sig}` : ''
}
const rememberMessageKeys = (list = []) => {
  seenMessageKeys = new Set(list.map(latestCustomerMessageKey).filter(Boolean))
  messageKeysReady = true
}
const showIncomingMessage = (item = {}) => {
  const text = latestMessageText(item).slice(0, 80)
  incomingNotice.value = { item, name: item.name || '客户', text: text || '发来一条咨询消息' }
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
  if (item) openChat(item)
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
const clearSensitiveWorkbenchState = () => {
  latestRequestId += 1
  loadPromise = null
  items.value = []
  incomingNotice.value = null
  failedAvatarKeys.value = []
  hiddenContacts.clear()
  seenMessageKeys = new Set()
  messageKeysReady = false
  if (incomingNoticeTimer) clearTimeout(incomingNoticeTimer)
  incomingNoticeTimer = null
}
const load = async (opts = {}) => {
  loggedIn.value = isLoggedIn()
  if (!loggedIn.value) {
    clearSensitiveWorkbenchState()
    return
  }
  if (loadPromise) return loadPromise
  const requestId = ++latestRequestId
  const run = async () => {
    refreshState.value = 'syncing'
    if (!opts.silent) loading.value = true
    try {
      const switched = await switchToService()
      if (!switched.ok) {
        clearSensitiveWorkbenchState()
        refreshState.value = 'offline'
        if (!opts.silent) uni.showToast({ title: switched.errMsg || '客服端暂未开通', icon: 'none' })
        return { ok: false }
      }
      const data = await getTeacherClientsData({ port: 'service' })
      if (!shouldApplyServiceWorkbenchResponse(requestId, latestRequestId)) return { ok: false, stale: true }
      const list = Array.isArray(data.clients) ? data.clients : []
      const normalized = list.map(normalizeItem)
      const visible = applyServiceWorkbenchHiddenWatermarks(normalized, hiddenContacts)
      visible.reopenedIds.forEach((id) => hiddenContacts.delete(String(id)))
      items.value = visible.items
      detectIncomingMessages(visible.items, { prime: !opts.silent })
      lastRefreshAt.value = new Date().toISOString()
      refreshState.value = 'ready'
      return { ok: true }
    } catch (e) {
      if (!shouldApplyServiceWorkbenchResponse(requestId, latestRequestId)) return { ok: false, stale: true }
      refreshState.value = 'offline'
      const status = Number(e && (e.statusCode ?? e.status ?? e.code))
      if (status === 401 || status === 403 || !isTemporaryServiceWorkbenchFailure(e)) {
        clearSensitiveWorkbenchState()
        if (status === 401) loggedIn.value = false
      }
      if (!opts.silent) uni.showToast({ title: e && e.message ? e.message : '客服咨询加载失败', icon: 'none' })
      return { ok: false }
    } finally {
      if (!opts.silent) loading.value = false
    }
  }
  let currentPromise = null
  currentPromise = run().finally(() => {
    if (loadPromise === currentPromise) loadPromise = null
  })
  loadPromise = currentPromise
  return loadPromise
}
const refresh = async () => {
  refreshing.value = true
  try {
    const result = await load({ silent: true })
    if (result && result.ok) failedAvatarKeys.value = []
  } finally {
    refreshing.value = false
  }
}
const normalizedStatus = (status) => {
  const raw = String(status || '')
  if (['completed', 'done', 'resolved'].includes(raw)) return 'completed'
  if (['pending', 'new', 'todo'].includes(raw)) return 'pending'
  return 'processing'
}
const statusText = (status) => ({ pending: '待回复', processing: '处理中', completed: '已完成' }[normalizedStatus(status)] || '处理中')
const statusClass = (status) => normalizedStatus(status)
const avatarOf = (name) => String(name || '客').slice(0, 1)
const clientUidOf = (item = {}) => firstText(item.clientUid, item.userId, item.uid, item.clientId)
const avatarUrlOf = (item = {}) => firstText(item.avatar, item.avatarUrl, item.avatarURL, item.headImg, item.headImage)
const avatarIdentityOf = (item = {}) => clientUidOf(item) || firstText(item.contactId, item.id, item.name, 'unknown-client')
const avatarFailureKey = (item = {}) => {
  const identity = avatarIdentityOf(item)
  const url = avatarUrlOf(item)
  return identity && url ? JSON.stringify([identity, url]) : ''
}
const avatarFailed = (item = {}) => {
  const key = avatarFailureKey(item)
  return !!key && failedAvatarKeys.value.includes(key)
}
const handleAvatarError = (item = {}) => {
  const key = avatarFailureKey(item)
  if (key && !failedAvatarKeys.value.includes(key)) {
    failedAvatarKeys.value = [...failedAvatarKeys.value, key]
  }
}
const BUSINESS_LABELS = Object.freeze({
  'debt-optimization': '债务优化',
  debt: '债务优化',
  'advisor-chat': '顾问咨询',
  advisor: '顾问咨询',
  appointment: '预约咨询',
  booking: '预约咨询',
  'match-product': '产品咨询',
  'product-consultation': '产品咨询',
  product: '产品咨询',
  'customer-service': '客户服务',
  service: '客户服务',
  support: '客户服务',
  'home-advisor': '顾问咨询',
  'advisor-page-chat': '顾问咨询',
  'advisor-debt-chat': '债务优化',
  'advisor-debt-booking': '债务优化',
  'advisor-page-booking': '预约咨询',
  'profile-service': '客户服务'
})
const mappedBusinessText = (value) => {
  const raw = firstText(value)
  if (!raw) return ''
  const key = raw.toLowerCase().replace(/[\s_]+/g, '-')
  if (BUSINESS_LABELS[key]) return BUSINESS_LABELS[key]
  if (key.includes('debt')) return '债务优化'
  if (key.includes('appointment') || key.includes('booking')) return '预约咨询'
  if (key.includes('advisor')) return '顾问咨询'
  if (key.includes('match') || key.includes('product')) return '产品咨询'
  if (key.includes('customer-service') || key.includes('support')) return '客户服务'
  return /[\u3400-\u9FFF]/.test(raw) ? raw : ''
}
const businessText = (item = {}) => {
  const explicit = firstText(item.businessName)
  if (explicit) return explicit
  const productContext = [firstText(item.institution), firstText(item.productName)].filter(Boolean).join(' · ')
  if (productContext) return productContext
  const candidates = [item.contactIntent, item.source, item.businessType, item.serviceType, item.contactType]
  let genericLabel = ''
  for (const candidate of candidates) {
    const label = mappedBusinessText(candidate)
    if (!label) continue
    if (label === '客户服务') {
      genericLabel = genericLabel || label
      continue
    }
    return label
  }
  return genericLabel || (item.serviceRequired ? '三方产品咨询' : '客户服务')
}
const serviceModeText = (item = {}) => item.serviceRequired ? '三方协同' : '客服直连'
const latestMessageText = (item = {}) => {
	  const msg = item.latestMessage || (Array.isArray(item.messages) && item.messages.length ? item.messages[item.messages.length - 1] : null)
	  const prefix = item.serviceRequired ? [item.institution, item.productName].filter(Boolean).join(' · ') : ''
	  const text = (msg && msg.content) || item.summary || '等待客服查看。'
	  return prefix ? `${prefix}：${text}` : text
	}
const serviceAccessText = (item = {}) => {
  if (!item.serviceRequired && !item.serviceAssigneeId) return '客户直接咨询，接单后归入我的接单'
  if (claimedByMe(item)) return '我的接单，可查看授权资料'
  if (item.serviceAssigneeId) return `已由${item.serviceAssigneeName || '其他客服'}接单`
  return item.materialAccessText || '待接单，资料暂不可见'
}
const canClaim = (item = {}) => availableToClaim(item)
const canDeleteTicket = (item = {}) => !!(item.contactId || item.id)
const claimTicket = async (item = {}) => {
  const id = item.contactId || item.id
  if (!id) return
  try {
    await claimAdvisorContact(id, 'service')
    uni.showToast({ title: '已接单', icon: 'none' })
    await load({ silent: true })
  } catch (e) {
    uni.showToast({ title: e && e.message ? e.message : '接单失败', icon: 'none' })
  }
}
const deleteTicket = async (item = {}) => {
  const id = item.contactId || item.id
  if (!id || !canDeleteTicket(item)) return
  try {
    await clearAdvisorContactView(id)
    const watermark = serviceWorkbenchCustomerWatermark(item)
    hiddenContacts.set(String(id), {
      customerMessageKey: watermark.key,
      customerMessageAt: watermark.at,
      hiddenAt: Date.now()
    })
    // 使删除前已经发出的请求失效，避免旧快照把聊天框放回来。
    latestRequestId += 1
    items.value = items.value.filter((row) => String(row.contactId || row.id || '') !== String(id))
    uni.showToast({ title: '已删除聊天框', icon: 'none' })
  } catch (e) {
    uni.showToast({ title: e && e.message ? e.message : '删除失败', icon: 'none' })
  }
}
const openChat = (item) => {
  const id = item.contactId || item.id
  if (!id) return
  uni.navigateTo({ url: `/pages/chat/conversation?contactId=${encodeURIComponent(id)}` })
}
const openMaterialArchive = (item = {}) => {
  if (!claimedByMe(item)) {
    uni.showToast({ title: '接单后可查看授权资料', icon: 'none' })
    return
  }
  const id = item.contactId || item.id
  if (!id) return
  uni.navigateTo({ url: `/pages/teacher/client-detail?id=${encodeURIComponent(id)}&port=service` })
}
const stopPolling = () => {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  if (incomingNoticeTimer) clearTimeout(incomingNoticeTimer)
  incomingNoticeTimer = null
}
const startPolling = () => {
  stopPolling()
  pollTimer = setInterval(() => load({ silent: true }), SERVICE_POLL_MS)
}
const goBack = () => safeBack('/pages/profile/profile')
const goLogin = () => uni.navigateTo({ url: '/pages/login/index' })

onShow(async () => {
  await load()
  if (loggedIn.value) startPolling()
})
onHide(() => stopPolling())
</script>

<style scoped>
.page { min-height: 100vh; background: #F5F6FA; }
.nav { flex-direction: row; align-items: center; padding: calc(var(--rpt-safe-top) + 8px) 14px 8px; background: #fff; border-bottom: 1px solid #EEF0F4; }
.nav-title { flex: 1; text-align: center; font-size: 16px; color: #111827; font-weight: 900; }
.nav-link { width: 42px; align-items: flex-end; }
.nav-link-text { font-size: 12px; color: #086CEA; font-weight: 900; }
.scroll-body { flex: 1; height: 100vh; }
.wrap { padding: 14px 16px 18px; }
.hero { flex-direction: row; align-items: center; background: #fff; border: 1px solid #EEF0F4; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
.hero-main { flex: 1; margin-right: 12px; }
.hero-kicker { font-size: 12px; color: #1D4ED8; font-weight: 900; }
.hero-title { margin-top: 5px; font-size: 18px; color: #111827; font-weight: 900; }
.hero-desc { margin-top: 6px; font-size: 12px; color: #6B7280; line-height: 1.5; }
.sync-line { flex-direction: row; align-items: center; margin-top: 10px; }
.sync-dot { width: 7px; height: 7px; border-radius: 4px; background: #16A34A; margin-right: 7px; }
.sync-dot.syncing { background: #086CEA; animation: serviceSyncPulse 1.1s ease-in-out infinite; }
.sync-dot.offline { background: #DC2626; }
.sync-text { font-size: 11px; color: #64748B; font-weight: 800; }
.hero-badge { width: 70px; height: 70px; border-radius: 8px; background: #EFF6FF; align-items: center; justify-content: center; }
.hero-num { font-size: 24px; color: #1D4ED8; font-weight: 900; }
.hero-label { margin-top: 2px; font-size: 11px; color: #1D4ED8; font-weight: 900; }
.incoming-toast { flex-direction: row; align-items: center; background: #EEF6FF; border: 1px solid #BFDBFE; border-radius: 8px; padding: 11px 12px; margin-bottom: 12px; }
.incoming-dot { width: 8px; height: 8px; border-radius: 4px; background: #086CEA; margin-right: 10px; }
.incoming-main { flex: 1; min-width: 0; }
.incoming-title { font-size: 12px; color: #1D4ED8; font-weight: 900; }
.incoming-text { margin-top: 3px; font-size: 12px; color: #334155; line-height: 1.35; }
.incoming-link { margin-left: 10px; font-size: 12px; color: #086CEA; font-weight: 900; }
.ticket-tabs { flex-direction: row; background: #fff; border: 1px solid #EEF0F4; border-radius: 8px; padding: 5px; margin-bottom: 10px; }
.ticket-tab { flex: 1; height: 38px; border-radius: 8px; flex-direction: row; align-items: center; justify-content: center; }
.ticket-tab.active { background: #EAF3FF; border: 1px solid #BFDBFE; }
.ticket-tab-text { font-size: 13px; color: #64748B; font-weight: 900; }
.ticket-tab-text.active { color: #086CEA; }
.ticket-tab-count { margin-left: 5px; min-width: 18px; text-align: center; font-size: 11px; color: #086CEA; font-weight: 900; }
.ticket-card { background: #fff; border: 1px solid #EEF0F4; border-radius: 8px; padding: 14px; }
.ticket-head { flex-direction: row; align-items: center; }
.avatar { flex-shrink: 0; width: 42px; height: 42px; border-radius: 21px; background: #F8FAFC; border: 1px solid #E5E7EB; align-items: center; justify-content: center; margin-right: 12px; overflow: hidden; }
.avatar-image { display: block; width: 100%; height: 100%; border-radius: 21px; }
.avatar-text { font-size: 15px; color: #475569; font-weight: 900; }
.ticket-main { flex: 1; min-width: 0; }
.ticket-line { flex-direction: row; align-items: center; }
.ticket-name { flex: 1; font-size: 15px; color: #111827; font-weight: 900; }
.unread-badge { min-width: 18px; height: 18px; border-radius: 9px; background: #EF4444; color: #fff; font-size: 10px; line-height: 18px; text-align: center; font-weight: 900; margin-right: 6px; overflow: hidden; }
.reopened-badge { margin-right: 6px; padding: 3px 6px; border-radius: 7px; background: #FFF7ED; color: #C2410C; font-size: 9px; font-weight: 900; }
.ticket-detail-line { margin-top: 5px; flex-direction: row; align-items: center; flex-wrap: wrap; }
.ticket-uid { max-width: 100%; margin-right: 8px; font-size: 11px; color: #64748B; font-weight: 800; word-break: break-all; }
.ticket-meta { font-size: 12px; color: #9CA3AF; }
.status { font-size: 11px; font-weight: 900; padding: 4px 7px; border-radius: 8px; overflow: hidden; }
.status.pending { color: #086CEA; background: #EAF3FF; }
.status.processing { color: #1D4ED8; background: #EFF6FF; }
.status.completed { color: #15803D; background: #F0FDF4; }
.ticket-body { margin-top: 12px; padding-top: 12px; border-top: 1px solid #F3F4F6; }
.ticket-business-line { flex-direction: row; align-items: center; flex-wrap: wrap; }
.ticket-business-key { flex-shrink: 0; margin-right: 7px; padding: 3px 6px; border-radius: 6px; background: #EFF6FF; color: #1D4ED8; font-size: 10px; font-weight: 900; }
.ticket-label { flex: 1; min-width: 120px; font-size: 12px; color: #334155; font-weight: 900; line-height: 1.45; }
.ticket-mode { flex-shrink: 0; margin-left: 8px; font-size: 10px; color: #64748B; font-weight: 800; }
	.ticket-text { margin-top: 5px; font-size: 13px; color: #374151; line-height: 1.55; }
	.ticket-actions { margin-top: 10px; flex-direction: row; align-items: center; }
	.ticket-access { flex: 1; font-size: 11px; color: #64748B; font-weight: 800; }
	.claim-mini { height: 30px; border-radius: 8px; background: #086CEA; align-items: center; justify-content: center; padding: 0 12px; margin-left: 10px; }
	.claim-mini-text { color: #fff; font-size: 12px; font-weight: 900; }
.state-card { align-items: center; background: #fff; border: 1px solid #EEF0F4; border-radius: 8px; padding: 32px 20px; }
.state-card.slim { padding: 24px 18px; }
.state-title { font-size: 17px; color: #111827; font-weight: 900; }
.state-sub { margin-top: 8px; font-size: 13px; color: #6B7280; line-height: 1.7; text-align: center; }
.state-btn { margin-top: 18px; min-width: 120px; height: 42px; border-radius: 8px; background: #086CEA; align-items: center; justify-content: center; padding: 0 16px; }
.state-btn-text { color: #fff; font-size: 14px; font-weight: 900; }
.bottom-safe { height: 36px; }
@media (min-width: 1024px) {
  .list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: 12px; }
  .ticket-card { margin-bottom: 0; }
}
@keyframes serviceSyncPulse { 0%, 100% { opacity: .35; transform: scale(.9); } 50% { opacity: 1; transform: scale(1.18); } }
</style>
