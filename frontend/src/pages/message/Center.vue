<template>
  <view class="page rpt-page">
    <view class="nav">
      <view class="nav-spacer"></view>
      <text class="nav-title">消息中心</text>
      <view class="nav-right" @click="readAll">
        <text v-if="loggedIn && !isServiceInbox && allUnreadCount > 0" class="nav-right-text">全部已读</text>
        <text v-else class="nav-right-text nav-right-empty"> </text>
      </view>
    </view>

    <MasterDetailLayout
      :active-pane="detailActivePane"
      master-width="400px"
      single-column
      class="msg-master-detail"
    >
      <template #master>
    <scroll-view class="scroll-body" scroll-y enhanced :show-scrollbar="false">
      <view class="wrap">
        <view v-if="!loggedIn" class="state">
          <text class="state-title">登录后查看消息</text>
          <text class="state-sub">系统通知、审批进度与顾问消息将在这里展示。</text>
          <view class="state-btn" @click="goLogin"><text class="state-btn-text">去登录</text></view>
        </view>

        <view v-else-if="loading" class="inbox-skeleton">
          <view class="skeleton-head">
            <view class="skeleton-title skeleton-shimmer"></view>
            <view class="skeleton-pill skeleton-shimmer"></view>
          </view>
          <view v-for="idx in 4" :key="idx" class="skeleton-row">
            <view class="skeleton-dot skeleton-shimmer"></view>
            <view class="skeleton-main">
              <view class="skeleton-line skeleton-line-title skeleton-shimmer"></view>
              <view class="skeleton-line skeleton-line-sub skeleton-shimmer"></view>
            </view>
          </view>
        </view>

        <view v-else>
          <view class="summary-card">
            <view class="summary-main">
              <text class="summary-title">{{ summaryTitle }}</text>
              <text class="summary-sub">{{ summaryText }}</text>
            </view>
            <view class="summary-actions">
              <text class="summary-count">{{ summaryCount }}</text>
              <view v-if="!isServiceInbox" class="settings-entry" @click="settingsOpen = !settingsOpen">
                <text class="settings-entry-text">{{ settingsOpen ? '收起' : '偏好' }}</text>
              </view>
            </view>
          </view>

          <view v-if="messageReturnContext" class="return-context-card">
            <view class="return-context-main">
              <text class="return-context-kicker">回到消息</text>
              <text class="return-context-title">{{ messageReturnContext.title }}</text>
              <text class="return-context-sub">{{ messageReturnContext.sub }}</text>
            </view>
            <view class="return-context-actions">
              <view class="return-context-primary" @click="showAllMessages"><text class="return-context-primary-text">查看全部</text></view>
              <view class="return-context-ghost" @click="dismissMessageReturnContext"><text class="return-context-ghost-text">收起</text></view>
            </view>
          </view>

          <view v-if="settingsOpen && !isServiceInbox" class="pref-panel">
            <view class="pref-head">
              <view class="pref-head-main">
                <text class="pref-title">通知偏好</text>
                <text class="pref-sub">{{ preferenceStatusText }}</text>
              </view>
              <text class="pref-mode">{{ preferenceModeText }}</text>
            </view>

            <view v-if="preferenceSyncNotice" class="sync-notice" :class="'sync-notice-' + preferenceSyncNotice.level">
              <view class="sync-copy">
                <text class="sync-title">{{ preferenceSyncNotice.title }}</text>
                <text class="sync-sub">{{ preferenceSyncNotice.text }}</text>
              </view>
              <view v-if="preferenceCanRetry" class="sync-retry" @click="retryNotificationSync">
                <text class="sync-retry-text">重试</text>
              </view>
            </view>

            <view v-if="syncQueueNotice" class="sync-notice sync-notice-warn">
              <view class="sync-copy">
                <text class="sync-title">{{ syncQueueNotice.title }}</text>
                <text class="sync-sub">{{ syncQueueNotice.text }}</text>
              </view>
              <view class="sync-retry" @click="retryPendingWritebacks">
                <text class="sync-retry-text">{{ syncRetrying ? '同步中' : '重试' }}</text>
              </view>
            </view>

            <view v-if="retrySummaryText" class="sync-detail">
              <text class="sync-detail-title">{{ retrySummaryText }}</text>
              <view v-for="item in retrySummaryRows" :key="item.key" class="sync-detail-row">
                <text class="sync-detail-label">{{ item.label }}</text>
                <text class="sync-detail-value">成功 {{ item.success }} · 失败 {{ item.failed }} · 剩余 {{ item.remaining }}</text>
              </view>
            </view>

            <view class="pref-row" @click="requestPushPermission">
              <view class="pref-copy">
                <text class="pref-label">系统推送权限</text>
                <text class="pref-value">{{ pushPermissionText }}</text>
                <text v-if="pushBindingText" class="pref-value pref-value-sub">{{ pushBindingText }}</text>
              </view>
              <view class="permission-pill" :class="'permission-pill-' + pushPermissionState.status">
                <text class="permission-pill-text">{{ pushPermissionActionText }}</text>
              </view>
            </view>

            <view class="pref-row" @click="toggleEnabled">
              <view class="pref-copy">
                <text class="pref-label">消息提醒</text>
                <text class="pref-value">{{ notificationSettings.enabled ? '开启' : '关闭' }}</text>
              </view>
              <view class="toggle" :class="{ 'toggle-on': notificationSettings.enabled }">
                <view class="toggle-knob"></view>
              </view>
            </view>

            <view class="pref-section">
              <text class="pref-section-title">分类静默</text>
              <view class="mute-grid">
                <view v-for="item in categoryOptions" :key="item.key" class="mute-option" :class="{ 'mute-option-on': isCategoryMuted(item.key) }" @click="toggleCategoryMute(item.key)">
                  <text class="mute-label">{{ item.label }}</text>
                  <text class="mute-state">{{ isCategoryMuted(item.key) ? '静默' : '提醒' }}</text>
                </view>
              </view>
            </view>

            <view class="pref-row" @click="toggleQuietHours">
              <view class="pref-copy">
                <text class="pref-label">免打扰时段</text>
                <text class="pref-value">{{ notificationSettings.quietHours.enabled ? `${notificationSettings.quietHours.start}-${notificationSettings.quietHours.end}` : '关闭' }}</text>
              </view>
              <view class="toggle" :class="{ 'toggle-on': notificationSettings.quietHours.enabled }">
                <view class="toggle-knob"></view>
              </view>
            </view>

            <view v-if="notificationSettings.quietHours.enabled" class="quiet-row">
              <view class="time-chip" @click.stop="cycleQuietTime('start')">
                <text class="time-label">开始</text>
                <text class="time-value">{{ notificationSettings.quietHours.start }}</text>
              </view>
              <view class="time-chip" @click.stop="cycleQuietTime('end')">
                <text class="time-label">结束</text>
                <text class="time-value">{{ notificationSettings.quietHours.end }}</text>
              </view>
            </view>

            <view class="pref-row pref-row-last" @click="toggleCriticalBypass">
              <view class="pref-copy">
                <text class="pref-label">关键咨询强提醒</text>
                <text class="pref-value">{{ notificationSettings.criticalConsultationBypass ? '开启' : '跟随静默' }}</text>
              </view>
              <view class="toggle" :class="{ 'toggle-on': notificationSettings.criticalConsultationBypass }">
                <view class="toggle-knob"></view>
              </view>
            </view>
          </view>

          <view v-if="!messages.length" class="state-card-small">
            <text class="state-title-small">暂无消息</text>
            <text class="state-sub-small">{{ errorMsg || '有新的通知时会第一时间提醒你。' }}</text>
            <view v-if="errorMsg" class="state-btn-small" @click="load"><text class="state-btn-small-text">重新加载</text></view>
          </view>

          <view v-else>
            <view class="filter-row">
              <view class="filter-chip" :class="{ 'filter-chip-on': filterMode === 'all' }" @click="setFilterMode('all')">
                <text class="filter-text" :class="{ 'filter-text-on': filterMode === 'all' }">{{ isServiceInbox ? '全部客户' : '全部' }}</text>
              </view>
              <view class="filter-chip" :class="{ 'filter-chip-on': filterMode === 'unread' }" @click="setFilterMode('unread')">
                <text class="filter-text" :class="{ 'filter-text-on': filterMode === 'unread' }">未读</text>
              </view>
              <view v-if="!isServiceInbox" class="filter-chip" :class="{ 'filter-chip-on': filterMode === 'consultation' }" @click="setFilterMode('consultation')">
                <text class="filter-text" :class="{ 'filter-text-on': filterMode === 'consultation' }">咨询</text>
                <text v-if="consultationCount" class="filter-badge" :class="{ 'filter-badge-on': filterMode === 'consultation' }">{{ consultationCount }}</text>
              </view>
              <view v-if="!isServiceInbox" class="filter-chip" :class="{ 'filter-chip-on': filterMode === 'debt' }" @click="setFilterMode('debt')">
                <text class="filter-text" :class="{ 'filter-text-on': filterMode === 'debt' }">债务</text>
                <text v-if="debtCount" class="filter-badge" :class="{ 'filter-badge-on': filterMode === 'debt' }">{{ debtCount }}</text>
              </view>
              <view v-if="!isServiceInbox" class="filter-chip" :class="{ 'filter-chip-on': filterMode === 'muted' }" @click="setFilterMode('muted')">
                <text class="filter-text" :class="{ 'filter-text-on': filterMode === 'muted' }">静默</text>
                <text v-if="mutedCount" class="filter-badge" :class="{ 'filter-badge-on': filterMode === 'muted' }">{{ mutedCount }}</text>
              </view>
            </view>

            <view v-if="!isServiceInbox && filterMode === 'debt' && debtCount" class="debt-segment-row">
              <view class="debt-segment-chip" :class="{ 'debt-segment-chip-on': debtViewMode === 'all' }" @click="setDebtViewMode('all')">
                <text class="debt-segment-text" :class="{ 'debt-segment-text-on': debtViewMode === 'all' }">全部</text>
                <text class="debt-segment-count" :class="{ 'debt-segment-text-on': debtViewMode === 'all' }">{{ debtCount }}</text>
              </view>
              <view class="debt-segment-chip" :class="{ 'debt-segment-chip-on': debtViewMode === 'pending' }" @click="setDebtViewMode('pending')">
                <text class="debt-segment-text" :class="{ 'debt-segment-text-on': debtViewMode === 'pending' }">待处理</text>
                <text class="debt-segment-count" :class="{ 'debt-segment-text-on': debtViewMode === 'pending' }">{{ debtPendingCount }}</text>
              </view>
              <view class="debt-segment-chip" :class="{ 'debt-segment-chip-on': debtViewMode === 'viewed' }" @click="setDebtViewMode('viewed')">
                <text class="debt-segment-text" :class="{ 'debt-segment-text-on': debtViewMode === 'viewed' }">已查看</text>
                <text class="debt-segment-count" :class="{ 'debt-segment-text-on': debtViewMode === 'viewed' }">{{ debtViewedCount }}</text>
              </view>
              <text class="debt-segment-summary">{{ debtViewSummary }}</text>
            </view>
            <view v-if="!visibleInboxEntries.length" class="state-card-small">
              <text class="state-title-small">暂无匹配消息</text>
              <text class="state-sub-small">{{ emptyStateSub }}</text>
            </view>

            <view
              v-for="entry in visibleInboxEntries"
              :key="entry.key"
              class="inbox-entry"
              :class="{ 'inbox-entry-client': entry.kind === 'client-group', 'inbox-entry-client-open': entry.kind === 'client-group' && isClientGroupExpanded(entry.key) }"
            >
              <view
                v-if="entry.kind === 'client-group'"
                class="client-inbox-group"
                :class="{ 'client-inbox-group-open': isClientGroupExpanded(entry.key) }"
              >
                <view
                  class="client-inbox-summary"
                  role="button"
                  tabindex="0"
                  :aria-expanded="isClientGroupExpanded(entry.key)"
                  @click="toggleClientGroup(entry.key)"
                  @keydown.enter="toggleClientGroup(entry.key)"
                  @keydown.space.prevent="toggleClientGroup(entry.key)"
                >
                  <view class="client-inbox-avatar">
                    <image
                      v-if="clientAvatar(entry) && !clientAvatarFailed(entry)"
                      class="client-inbox-avatar-image"
                      :src="clientAvatar(entry)"
                      mode="aspectFill"
                      :aria-label="`${clientName(entry)}头像`"
                      @error="handleClientAvatarError(entry)"
                    />
                    <text v-else class="client-inbox-avatar-text">{{ clientName(entry).slice(0, 1) }}</text>
                  </view>
                  <view class="client-inbox-main">
                    <view class="client-inbox-title-line">
                      <text class="client-inbox-name">{{ clientName(entry) }}</text>
                      <text v-if="entry.hasUnread" class="client-inbox-unread">{{ entry.unreadCount > 99 ? '99+' : entry.unreadCount }}</text>
                    </view>
                    <text class="client-inbox-uid">UID：{{ clientUid(entry) || '暂未同步' }}</text>
                    <view class="client-inbox-business-line">
                      <text class="client-inbox-business-key">业务</text>
                      <text class="client-inbox-business">{{ clientBusiness(entry) }}</text>
                    </view>
                    <text class="client-inbox-preview">{{ entry.latestMessage && entry.latestMessage.content ? entry.latestMessage.content : '点击展开客户消息' }}</text>
                  </view>
                  <view class="client-inbox-side">
                    <text class="client-inbox-time">{{ clientTime(entry) }}</text>
                    <text class="client-inbox-count">{{ entry.messages.length }} 个会话</text>
                    <view
                      class="client-inbox-chevron"
                      :class="{ 'client-inbox-chevron-open': isClientGroupExpanded(entry.key) }"
                      aria-hidden="true"
                    >
                      <RptChevron class="client-inbox-chevron-icon" direction="down" />
                    </view>
                  </view>
                </view>
              </view>

              <view
                v-if="entry.kind === 'message' || isClientGroupExpanded(entry.key)"
                class="inbox-entry-messages"
                :class="{ 'client-inbox-messages': entry.kind === 'client-group' }"
              >
                <SwipeDelete
                  v-for="m in entryMessages(entry)"
                  :key="m.id"
                  :disabled="!canDeleteMessage(m)"
                  @content-click="openMsg(m)"
                  @delete="deleteMessage(m)"
                >
                  <view class="msg" :class="{ 'msg-unread': !m.read && !m.muted, 'msg-muted': m.muted, 'msg-consultation': m.category === 'consultation', 'msg-debt': m.debt, 'msg-danger': m.level === 'danger' && !m.muted, 'msg-warning': m.level === 'warning' && !m.muted }">
                    <view class="msg-dot-wrap">
                      <view class="msg-dot" v-if="!m.read && !m.muted"></view>
                      <view class="msg-muted-dot" v-else-if="!m.read && m.muted"></view>
                    </view>
                    <view class="msg-main">
                      <view class="msg-head">
                        <view class="msg-title-line">
                          <text class="msg-title" :class="{ 'msg-title-read': m.read || m.muted }">{{ m.title }}</text>
                          <text v-if="m.tag" class="msg-tag" :class="'msg-tag-' + m.category">{{ m.tag }}</text>
                          <text v-if="m.unreadCount > 0 && !m.muted" class="msg-unread-count">{{ m.unreadCount > 99 ? '99+' : m.unreadCount }}</text>
                          <text v-if="m.muted" class="msg-muted-pill">{{ muteReasonText(m.muteReason) }}</text>
                        </view>
                        <text class="msg-time">{{ m.time }}</text>
                      </view>
                      <text class="msg-content">{{ m.content }}</text>
                      <view v-if="m.contextText || m.actionText || m.level || m.receiptText" class="msg-meta">
                        <text v-if="m.level" class="msg-level" :class="'msg-level-' + m.level">{{ levelText(m.level) }}</text>
                        <text v-if="m.contextText" class="msg-context">{{ m.contextText }}</text>
                        <text v-if="m.receiptText" class="msg-receipt">{{ m.receiptText }}</text>
                        <text v-if="m.actionText" class="msg-action">{{ m.actionText }}</text>
                      </view>
                    </view>
                  </view>
                </SwipeDelete>
              </view>
            </view>
          </view>
        </view>

        <view class="bottom-safe rpt-page-bottom"></view>
      </view>
    </scroll-view>
      </template>
      <template #detail>
        <view class="msg-detail-pane">
          <view v-if="previewMessage" class="detail-inner">
            <view class="detail-toolbar">
              <RptBackButton label="返回消息列表" @click="closePreviewMessage" />
              <text class="detail-toolbar-text">返回消息列表</text>
            </view>
            <view class="detail-head">
              <text class="detail-title">{{ previewMessage.title }}</text>
              <text class="detail-tag" :class="'msg-tag-' + previewMessage.category">{{ previewMessage.tag }}</text>
            </view>
            <text class="detail-time">{{ previewMessage.time }}</text>
            <text class="detail-content">{{ previewMessage.content }}</text>
            <view v-if="previewMessage.contextText || previewMessage.receiptText" class="detail-meta">
              <text v-if="previewMessage.contextText" class="detail-meta-item">{{ previewMessage.contextText }}</text>
              <text v-if="previewMessage.receiptText" class="detail-meta-item">{{ previewMessage.receiptText }}</text>
            </view>
            <view v-if="previewMessage.actionUrl" class="detail-action" @click="openMsg(previewMessage)">
              <text class="detail-action-text">查看详情</text>
            </view>
          </view>
          <view v-else class="detail-empty">
            <text class="detail-empty-title">选择一条消息</text>
            <text class="detail-empty-sub">点击左侧列表中的消息可在此处预览详情。</text>
          </view>
        </view>
      </template>
    </MasterDetailLayout>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue'
import { onShow } from '@/compat/web-lifecycle.js'
import { getUserId, isLoggedIn } from '@/services/authService.js'
import { getCurrentRole } from '@/services/roleService.js'
import { getTeacherClientsData } from '@/services/teacherService.js'
import { readConsultationMaterialSyncQueue, retryPendingConsultationMaterialSync } from '@/services/userConsultationStatus.js'
import { clearAdvisorContactView, getAdvisorContacts, getDebtExecutionRecords, getMessageList, markAdvisorContactRead, markMessageRead, markAllMessagesRead, getNotificationSettings, saveNotificationSettings, saveSystemPushBinding, saveMessageActionReceiptRemote, saveDebtExecutionRecordRemote, submitAdvisorContactMaterial } from '@/services/profileService.js'
import { applyMessageActionReceipts, applyNotificationSettings, buildConsultationMessages, buildCustomerChatMessages, buildDebtExecutionMessages, filterDebtMessagesByViewState, getDebtMessageViewState, detectSystemPushPermissionState, markNotificationSyncFailed, markNotificationSyncPending, markNotificationSyncSuccess, messageReportDetailActionUrl, notifyMessageUnreadChange, normalizeNotificationSettings, normalizeNotificationSyncState, readMessageActionSyncQueue, readSystemPushBindingState, readSystemPushPermissionState, requestSystemPushPermission, retryPendingMessageActionSync, syncMessageActionReceipt, syncSystemPushBinding, notificationSettingsToPayload, readLocalMessageIds, readNotificationSettings, readNotificationSyncState, readMessageCenterViewState, resolveMessageCenterReturnViewState, saveLocalMessageIds, saveLocalNotificationSettings, saveMessageActionReceipt, saveMessageCenterViewState } from '@/services/messageCenter.js'
import { applyDebtExecutionCloudSnapshot, readDebtExecutionRecords, readDebtExecutionSyncQueue, retryPendingDebtExecutionSync, saveDebtExecutionRecords } from '@/services/debtExecution.js'
import { buildMessageInboxEntries } from '@/utils/messageInboxGroups.js'
import SwipeDelete from '@/components/SwipeDelete.vue'
import RptBackButton from '@/components/RptBackButton.vue'
import RptChevron from '@/components/RptChevron.vue'
import MasterDetailLayout from '@/components/layout/MasterDetailLayout.vue'

const loggedIn = ref(false)
const loading = ref(false)
const messages = ref([])
const errorMsg = ref('')
const filterMode = ref('all')
const debtViewMode = ref('all')
const settingsOpen = ref(false)
const settingsSaving = ref(false)
const syncRetrying = ref(false)
const pendingWritebackCount = ref(0)
const preferenceSyncText = ref('本机设置')
const preferenceSyncState = ref(readNotificationSyncState())
const pushPermissionState = ref(readSystemPushPermissionState())
const pushBindingState = ref(readSystemPushBindingState())
const lastRetrySummary = ref(null)
const notificationSettings = ref(readNotificationSettings())
const messageReturnContext = ref(null)
const previewMessage = ref(null)
const activeRole = ref('user')
const expandedClientKeys = ref([])
const failedClientAvatars = ref([])
const isServiceInbox = computed(() => activeRole.value === 'service')
const detailActivePane = computed(() => previewMessage.value ? 'detail' : 'master')
const closePreviewMessage = () => {
  previewMessage.value = null
}

const categoryOptions = [
  { key: 'consultation', label: '咨询' },
  { key: 'approval', label: '审批' },
  { key: 'advisor', label: '顾问' },
  { key: 'system', label: '系统' }
]
const quietStartOptions = ['20:00', '21:00', '22:00', '23:00']
const quietEndOptions = ['07:00', '08:00', '09:00', '10:00']

const allUnreadCount = computed(() => messages.value.filter((m) => !m.read).length)
const unreadCount = computed(() => messages.value.filter((m) => !m.read && !m.muted).length)
const mutedCount = computed(() => messages.value.filter((m) => m.muted).length)
const mutedUnreadCount = computed(() => messages.value.filter((m) => !m.read && m.muted).length)
const consultationCount = computed(() => messages.value.filter((m) => m.category === 'consultation').length)
const debtMessageList = computed(() => messages.value.filter((m) => m.debt))
const debtCount = computed(() => debtMessageList.value.length)
const debtPendingCount = computed(() => filterDebtMessagesByViewState(messages.value, 'pending').length)
const debtViewedCount = computed(() => filterDebtMessagesByViewState(messages.value, 'viewed').length)
const unreadConsultationCount = computed(() => messages.value.filter((m) => m.category === 'consultation' && !m.read && !m.muted).length)
const inboxEntries = computed(() => buildMessageInboxEntries(messages.value, { groupClients: isServiceInbox.value }))
const serviceClientCount = computed(() => inboxEntries.value.filter((entry) => entry.kind === 'client-group').length)
const serviceUnreadCount = computed(() => inboxEntries.value.reduce((sum, entry) => sum + Number(entry.unreadCount || 0), 0))
const summaryTitle = computed(() => isServiceInbox.value ? '客户消息' : '消息收件箱')
const summaryCount = computed(() => isServiceInbox.value ? serviceClientCount.value : messages.value.length)
const summaryText = computed(() => {
  if (isServiceInbox.value) {
    if (serviceUnreadCount.value > 0) return `${serviceUnreadCount.value} 条客户消息未读，按客户归入折叠框`
    return serviceClientCount.value ? `${serviceClientCount.value} 位客户的消息已同步` : '暂无待处理的客户消息'
  }
  if (unreadCount.value > 0) return `${unreadCount.value} 条未读需要处理${unreadConsultationCount.value ? `，其中 ${unreadConsultationCount.value} 条咨询提醒` : ''}`
  if (mutedUnreadCount.value > 0) return `${mutedUnreadCount.value} 条已静默未读，消息仍在列表中保留`
  if (debtCount.value) return '债务提醒已同步，暂无未读消息'
  return consultationCount.value ? '咨询进度已同步，暂无未读消息' : '暂无待处理消息'
})
const debtViewSummary = computed(() => {
  if (debtViewMode.value === 'pending') return `待处理 ${debtPendingCount.value} 条`
  if (debtViewMode.value === 'viewed') return `已查看 ${debtViewedCount.value} 条`
  return `全部 ${debtCount.value} 条`
})
const emptyStateSub = computed(() => {
  if (filterMode.value === 'debt' && debtViewMode.value === 'pending') return '暂无待处理债务消息，已查看记录已归入已查看分组。'
  if (filterMode.value === 'debt' && debtViewMode.value === 'viewed') return '暂无已查看债务消息，处理后会在这里保留记录。'
  return '切换筛选或等待新的通知。'
})
const visibleMessages = computed(() => {
  if (filterMode.value === 'unread') return messages.value.filter((m) => !m.read && !m.muted)
  if (filterMode.value === 'consultation') return messages.value.filter((m) => m.category === 'consultation')
  if (filterMode.value === 'debt') return filterDebtMessagesByViewState(messages.value, debtViewMode.value)
  if (filterMode.value === 'muted') return messages.value.filter((m) => m.muted)
  return messages.value
})
const visibleInboxEntries = computed(() => buildMessageInboxEntries(visibleMessages.value, { groupClients: isServiceInbox.value }))
const entryMessages = (entry = {}) => entry.kind === 'client-group'
  ? (Array.isArray(entry.messages) ? entry.messages : [])
  : (entry.message ? [entry.message] : [])
const isClientGroupExpanded = (key) => expandedClientKeys.value.includes(String(key))
const toggleClientGroup = (key) => {
  const normalizedKey = String(key)
  expandedClientKeys.value = isClientGroupExpanded(normalizedKey)
    ? expandedClientKeys.value.filter((item) => item !== normalizedKey)
    : [...expandedClientKeys.value, normalizedKey]
}
const pruneExpandedClientKeys = () => {
  const availableKeys = new Set(inboxEntries.value.filter((entry) => entry.kind === 'client-group').map((entry) => entry.key))
  expandedClientKeys.value = expandedClientKeys.value.filter((key) => availableKeys.has(key))
}

const blankMessageSourceState = () => ({
  sourceMessageId: '',
  sourceTitle: '',
  sourceCategory: '',
  sourceDebt: false,
  sourceFocus: '',
  reportId: '',
  debtId: '',
  executionRecordId: '',
  actionUrl: '',
  sourceOpenedAt: '',
  returnedAt: ''
})
const persistMessageViewState = (extra = {}) => saveMessageCenterViewState({
  filterMode: filterMode.value,
  debtViewMode: debtViewMode.value,
  ...extra
})
const restoreMessageViewState = () => {
  const state = readMessageCenterViewState()
  filterMode.value = state.filterMode
  debtViewMode.value = state.debtViewMode
}
const clearMessageSourceState = () => persistMessageViewState(blankMessageSourceState())
const setFilterMode = (mode) => {
  filterMode.value = mode
  messageReturnContext.value = null
  clearMessageSourceState()
}
const setDebtViewMode = (mode) => {
  debtViewMode.value = mode
  messageReturnContext.value = null
  clearMessageSourceState()
}
const buildMessageReturnContext = (state) => {
  if (!state.sourceMessageId && !state.sourceTitle) return null
  const source = state.sourceMessage || {}
  const title = source.title || state.sourceTitle || '消息'
  const context = source.contextText || (state.reportId ? '关联信用报告' : '')
  const receipt = source.receiptText || (state.sourceMessageState === 'viewed' ? '已查看' : '')
  const sub = [title, context, receipt].filter(Boolean).join(' · ')
  return {
    title: state.sourceMessageState === 'viewed' ? '已归入已查看' : '已恢复消息筛选',
    sub: sub || '已保留刚才的筛选状态。'
  }
}
const applyMessageReturnState = () => {
  const resolved = resolveMessageCenterReturnViewState(messages.value, readMessageCenterViewState())
  filterMode.value = resolved.filterMode
  debtViewMode.value = resolved.debtViewMode
  persistMessageViewState({ ...resolved, returnedAt: new Date().toISOString() })
  messageReturnContext.value = buildMessageReturnContext(resolved)
}
const recordMessageOpenSource = (m) => persistMessageViewState({
  sourceMessageId: m.id || '',
  sourceTitle: m.title || '',
  sourceCategory: m.category || '',
  sourceDebt: !!m.debt,
  sourceFocus: m.focus || '',
  reportId: m.reportId || '',
  debtId: m.debtId || '',
  executionRecordId: m.executionRecordId || '',
  actionUrl: m.actionUrl || '',
  sourceOpenedAt: new Date().toISOString(),
  returnedAt: ''
})
const dismissMessageReturnContext = () => {
  messageReturnContext.value = null
  clearMessageSourceState()
}
const showAllMessages = () => setFilterMode('all')
const preferenceStatusText = computed(() => {
  if (settingsSaving.value) return '同步中'
  const state = normalizeNotificationSyncState(preferenceSyncState.value)
  if (state.status === 'failed') return '同步失败'
  if (state.status === 'pending') return '待同步'
  return preferenceSyncText.value
})
const preferenceSyncNotice = computed(() => {
  if (!loggedIn.value) return null
  const state = normalizeNotificationSyncState(preferenceSyncState.value)
  if (!state.pending) return null
  if (state.status === 'failed') {
    return { level: 'error', title: '偏好暂未同步', text: '本机设置已生效，服务端同步失败。' }
  }
  return { level: 'warn', title: '偏好待同步', text: '本机设置已生效，等待服务端确认。' }
})
const preferenceCanRetry = computed(() => !!preferenceSyncNotice.value && !settingsSaving.value)
const pushPermissionText = computed(() => {
  const state = pushPermissionState.value || {}
  const binding = pushBindingState.value || {}
  if (state.status === 'granted' && binding.status === 'synced') return '系统推送已开启，服务端已绑定'
  if (state.status === 'granted' && binding.pending) return '系统推送已开启，绑定待同步'
  const map = { granted: '系统推送已开启', denied: '系统权限未开启', prompt: '可开启系统推送', unsupported: '当前环境不支持', unknown: '待检测' }
  return map[state.status] || '待检测'
})
const pushBindingText = computed(() => {
  if (!loggedIn.value) return ''
  const binding = pushBindingState.value || {}
  if (binding.status === 'failed') return `服务端绑定失败：${binding.error || '稍后自动重试'}`
  if (binding.status === 'pending') return '推送标识正在同步到服务端'
  if (binding.status === 'synced') return '老师端/监控端可读取最新推送状态'
  if (pushPermissionState.value && pushPermissionState.value.status === 'granted') return '将同步推送标识给服务端'
  return ''
})
const pushPermissionActionText = computed(() => {
  const state = pushPermissionState.value || {}
  const binding = pushBindingState.value || {}
  if (state.status === 'granted' && binding.status === 'failed') return '重试'
  if (state.status === 'granted' && binding.pending) return '待同步'
  return state.status === 'granted' ? '已开启' : '开启'
})
const syncQueueNotice = computed(() => {
  if (!loggedIn.value || !pendingWritebackCount.value) return null
  return { level: 'warn', title: '有待同步记录', text: `${pendingWritebackCount.value} 条处理记录待恢复同步。` }
})
const retrySummaryRows = computed(() => {
  const summary = lastRetrySummary.value
  if (!summary) return []
  return [
    { key: 'message', label: '消息回写', ...(summary.message || {}) },
    { key: 'material', label: '材料同步', ...(summary.material || {}) },
    { key: 'debt', label: '债务执行', ...(summary.debt || {}) }
  ].filter((item) => item.total || item.attempted || item.success || item.failed || item.remaining)
})
const retrySummaryText = computed(() => {
  const rows = retrySummaryRows.value
  if (!rows.length) return ''
  const success = rows.reduce((sum, item) => sum + (item.success || 0), 0)
  const failed = rows.reduce((sum, item) => sum + (item.failed || 0), 0)
  const remaining = rows.reduce((sum, item) => sum + (item.remaining || 0), 0)
  if (remaining) return `已恢复 ${success} 条，仍有 ${remaining} 条待同步`
  if (failed) return `已恢复 ${success} 条，仍有失败记录待重试`
  return success ? `已恢复 ${success} 条，队列已清空` : '待同步队列已检查'
})
const preferenceModeText = computed(() => {
  const settings = notificationSettings.value
  if (!settings.enabled) return '提醒关闭'
  const mutedLabels = categoryOptions.filter((item) => settings.mutedCategories[item.key]).map((item) => item.label)
  if (settings.quietHours.enabled) return mutedLabels.length ? `静默 ${mutedLabels.length} 类` : '免打扰开启'
  return mutedLabels.length ? `静默 ${mutedLabels.length} 类` : '全部提醒'
})

const goLogin = () => uni.navigateTo({ url: '/pages/login/index', fail: () => { uni.showToast({ title: '无法打开登录页', icon: 'none' }) } })

const parseTs = (raw) => {
  if (raw == null || raw === '') return 0
  if (typeof raw === 'number') return raw < 1e12 ? raw * 1000 : raw
  const ts = Date.parse(raw)
  return Number.isFinite(ts) ? ts : 0
}

const formatTime = (raw) => {
  const ts = parseTs(raw)
  if (!ts) return raw == null ? '' : String(raw).slice(0, 16)
  const d = new Date(ts)
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const levelText = (level) => {
  const map = { danger: '需处理', warning: '待补充', success: '已更新', info: '提醒' }
  return map[level] || '提醒'
}

const categoryText = (category) => {
  const map = { consultation: '咨询', approval: '审批', system: '系统', advisor: '顾问' }
  return map[category] || '通知'
}

const firstText = (...values) => {
  for (const value of values) {
    if (value === undefined || value === null) continue
    const text = String(value).trim()
    if (text) return text
  }
  return ''
}
const clientMessageWith = (entry = {}, fields = []) => {
  const rows = entryMessages(entry)
  return rows.find((message) => fields.some((field) => firstText(message && message[field]))) || rows[0] || {}
}
const clientName = (entry = {}) => firstText(clientMessageWith(entry, ['clientName']).clientName, '客户')
const clientUid = (entry = {}) => {
  const message = clientMessageWith(entry, ['clientUid', 'userId', 'uid'])
  return firstText(message.clientUid, message.userId, message.uid)
}
const clientAvatar = (entry = {}) => {
  const message = clientMessageWith(entry, ['avatar', 'avatarUrl', 'avatarURL'])
  return firstText(message.avatar, message.avatarUrl, message.avatarURL)
}
const clientAvatarFailureKey = (entry = {}) => {
  const url = clientAvatar(entry)
  return url ? JSON.stringify([entry.key || clientUid(entry) || clientName(entry), url]) : ''
}
const clientAvatarFailed = (entry = {}) => {
  const key = clientAvatarFailureKey(entry)
  return !!key && failedClientAvatars.value.includes(key)
}
const handleClientAvatarError = (entry = {}) => {
  const key = clientAvatarFailureKey(entry)
  if (key && !failedClientAvatars.value.includes(key)) failedClientAvatars.value = [...failedClientAvatars.value, key]
}
const BUSINESS_LABELS = Object.freeze({
  'debt-optimization': '债务优化',
  debt: '债务优化',
  appointment: '预约咨询',
  booking: '预约咨询',
  'match-product': '产品咨询',
  'product-consultation': '产品咨询',
  product: '产品咨询',
  'customer-service': '客户服务',
  service: '客户服务',
  support: '客户服务',
  advisor: '顾问咨询'
})
const mappedBusinessText = (value) => {
  const raw = firstText(value)
  if (!raw) return ''
  const key = raw.toLowerCase().replace(/[\s_]+/g, '-')
  if (BUSINESS_LABELS[key]) return BUSINESS_LABELS[key]
  if (key.includes('debt')) return '债务优化'
  if (key.includes('appointment') || key.includes('booking')) return '预约咨询'
  if (key.includes('match') || key.includes('product')) return '产品咨询'
  if (key.includes('service') || key.includes('support')) return '客户服务'
  if (key.includes('advisor')) return '顾问咨询'
  return /[\u3400-\u9FFF]/.test(raw) ? raw : ''
}
const messageBusinessText = (message = {}) => {
  const explicit = firstText(message.businessName)
  if (explicit) return explicit
  const productContext = [firstText(message.institution), firstText(message.productName)].filter(Boolean).join(' · ')
  if (productContext) return productContext
  return mappedBusinessText(firstText(message.contactIntent, message.businessType, message.serviceType, message.source, message.contactType)) || '客户咨询'
}
const clientBusiness = (entry = {}) => {
  const labels = [...new Set(entryMessages(entry).map(messageBusinessText).filter(Boolean))]
  if (!labels.length) return '客户咨询'
  if (labels.length === 1) return labels[0]
  return `${labels[0]} +${labels.length - 1} 项业务`
}
const clientTime = (entry = {}) => {
  const timestamp = Number(entry.rawTs || (entry.latestMessage && entry.latestMessage.rawTs) || 0)
  if (!timestamp) return ''
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  if (sameDay) return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (date.getFullYear() === yesterday.getFullYear() && date.getMonth() === yesterday.getMonth() && date.getDate() === yesterday.getDate()) return '昨天'
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const muteReasonText = (reason) => {
  const map = { all: '已关闭', category: '已静默', quiet: '免打扰' }
  return map[reason] || '已静默'
}

const collectRecords = (payload) => {
  if (!payload) return []
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload.list)) return payload.list
  if (Array.isArray(payload.records)) return payload.records
  if (Array.isArray(payload.messages)) return payload.messages
  if (Array.isArray(payload.contacts)) return payload.contacts
  if (payload.data) return collectRecords(payload.data)
  return []
}

const actionUrlOf = (m) => {
  const provided = m.actionUrl || m.url || m.path || m.targetUrl
  if (provided) return provided
  if (!m.reportId) return ''
  return messageReportDetailActionUrl(m.reportId, { messageId: m.id || m._id || m.messageId || '', focus: m.focus || 'report' })
}

const normMsg = (m, i, localReadIds = new Set()) => {
  const local = !!m.local
  const id = String(m.id || m._id || m.messageId || `msg_${i}`)
  const category = m.category || m.type || (local ? 'consultation' : 'system')
  const rawTime = m.createdAt || m.time || m.created_at || m.ts || m.date
  const rawTs = parseTs(rawTime)
  const autoRead = !!(m.autoRead || m.reviewAcknowledged || m.reviewAcknowledgedAt)
  const remoteUnreadCount = Number(m.unreadCount || m.unread_count || 0)
  const unreadCount = Number.isFinite(remoteUnreadCount) && remoteUnreadCount > 0 ? Math.round(remoteUnreadCount) : 0
  const hasRemoteUnread = m.hasUnread === true || unreadCount > 0
  const read = autoRead || (local ? (!hasRemoteUnread && (localReadIds.has(id) || !!m.read)) : !!(m.read || m.isRead || m.is_read || m.status === 'read'))
  const contextText = m.contextText || (m.debt && m.reportId ? '关联信用报告' : '')
  return {
    id,
    local,
    category,
    level: m.level || '',
    tag: m.tag || categoryText(category),
    title: m.title || m.subject || m.type || '系统通知',
    content: m.content || m.body || m.text || m.message || '',
    time: formatTime(rawTime),
    rawTs,
    read,
    unreadCount,
    hasUnread: hasRemoteUnread,
    actionText: m.actionText || '',
    actionUrl: actionUrlOf(m),
	    reportId: m.reportId || '',
	    statusId: m.statusId || '',
	    contactId: m.contactId || '',
	    focus: m.focus || '',
    messageKind: m.messageKind || '',
    clientScoped: m.clientScoped === true,
    clientGroupKey: m.clientGroupKey || '',
    clientUid: firstText(m.clientUid, m.userId, m.uid, m.customerUid),
    clientId: firstText(m.clientId, m.customerId),
    clientName: firstText(m.clientName, m.customerName, m.name),
    avatar: firstText(m.avatar, m.avatarUrl, m.avatarURL),
    phone: firstText(m.phone, m.mobile),
    businessName: firstText(m.businessName),
    businessType: firstText(m.businessType),
    serviceType: firstText(m.serviceType),
    contactIntent: firstText(m.contactIntent),
    source: firstText(m.source),
    contactType: firstText(m.contactType),
    institution: firstText(m.institution),
    productName: firstText(m.productName),
    debtId: m.debtId || '',
    executionRecordId: m.executionRecordId || '',
    contextText,
    viewState: m.debt ? getDebtMessageViewState({ ...m, read, autoRead }) : '',
    reviewAcknowledged: !!(m.reviewAcknowledged || m.reviewAcknowledgedAt),
    reviewAcknowledgedAt: m.reviewAcknowledgedAt || '',
    autoRead,
    receiptText: m.receiptText || '',
    actionReceipt: m.actionReceipt || null,
    debt: !!m.debt,
    muted: false,
    muteReason: ''
  }
}

const mergeMessages = (items) => {
  const seen = new Set()
  return items
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item.id)) return false
      seen.add(item.id)
      return true
    })
    .sort((a, b) => (b.rawTs || 0) - (a.rawTs || 0))
}

const refreshMutedMessages = () => {
  messages.value = applyMessageActionReceipts(applyNotificationSettings(messages.value, notificationSettings.value))
  notifyMessageUnreadChange({ total: unreadCount.value })
}

const refreshPendingWritebacks = () => {
  pendingWritebackCount.value = readMessageActionSyncQueue().length + readConsultationMaterialSyncQueue().length + readDebtExecutionSyncQueue().length
}

const summarizeRetryResult = (result = {}) => ({
  total: result.total || 0,
  attempted: result.attempted || 0,
  success: result.success || 0,
  failed: result.failed || 0,
  skipped: result.skipped || 0,
  remaining: result.remaining || 0
})

const retryPendingWritebacks = async (options = {}) => {
  if (!loggedIn.value || syncRetrying.value) return null
  refreshPendingWritebacks()
  if (!pendingWritebackCount.value) return null
  syncRetrying.value = true
  try {
    const messageResult = await retryPendingMessageActionSync(saveMessageActionReceiptRemote)
    const materialResult = await retryPendingConsultationMaterialSync(submitAdvisorContactMaterial)
    const debtResult = await retryPendingDebtExecutionSync(saveDebtExecutionRecordRemote)
    refreshPendingWritebacks()
    const summary = {
      message: summarizeRetryResult(messageResult),
      material: summarizeRetryResult(materialResult),
      debt: summarizeRetryResult(debtResult),
      updatedAt: new Date().toISOString()
    }
    lastRetrySummary.value = summary
    if (!options.silent) {
      const done = (messageResult.success || 0) + (materialResult.success || 0) + (debtResult.success || 0)
      uni.showToast({ title: pendingWritebackCount.value ? '仍有记录待同步' : `已同步 ${done} 条`, icon: 'none' })
    }
    return { messageResult, materialResult, debtResult, summary }
  } finally {
    syncRetrying.value = false
  }
}

const syncPushBindingToServer = async (state, options = {}) => {
  if (!loggedIn.value) return null
  const result = await syncSystemPushBinding(state || pushPermissionState.value, saveSystemPushBinding)
  pushBindingState.value = result && result.state ? result.state : readSystemPushBindingState()
  if (!options.silent) {
    if (result && result.ok) uni.showToast({ title: '推送绑定已同步', icon: 'none' })
    else if (result && result.queued) uni.showToast({ title: '推送绑定待同步', icon: 'none' })
  }
  return result
}

const requestPushPermission = async () => {
  const state = await requestSystemPushPermission()
  pushPermissionState.value = state
  const bindingResult = await syncPushBindingToServer(state, { silent: true })
  if (state.status === 'granted') uni.showToast({ title: bindingResult && bindingResult.ok ? '系统推送已开启' : '已开启，绑定待同步', icon: 'none' })
  else if (state.status === 'unsupported') uni.showToast({ title: '当前环境不支持系统推送', icon: 'none' })
  else uni.showToast({ title: state.reason || '暂未开启系统推送', icon: 'none' })
}

const preferenceTextForState = (state, fallback = '本机设置') => {
  const normalized = normalizeNotificationSyncState(state)
  if (normalized.status === 'failed') return '同步失败'
  if (normalized.status === 'pending') return '待同步'
  if (normalized.status === 'synced') return '已同步'
  return fallback
}

const syncNotificationSettingsToServer = async (settings, options = {}) => {
  if (!loggedIn.value) return false
  const normalized = normalizeNotificationSettings(settings)
  preferenceSyncState.value = markNotificationSyncPending(normalized)
  preferenceSyncText.value = '待同步'
  settingsSaving.value = true
  try {
    await saveNotificationSettings(notificationSettingsToPayload(normalized))
    preferenceSyncState.value = markNotificationSyncSuccess()
    preferenceSyncText.value = '已同步'
    if (options.manual) uni.showToast({ title: '同步已完成', icon: 'none' })
    return true
  } catch (e) {
    preferenceSyncState.value = markNotificationSyncFailed(e, normalized)
    preferenceSyncText.value = '同步失败'
    uni.showToast({ title: options.manual ? '重试失败，请稍后再试' : '偏好同步失败，可重试', icon: 'none' })
    return false
  } finally {
    settingsSaving.value = false
  }
}

const loadNotificationSettings = async () => {
  let next = readNotificationSettings()
  let syncState = readNotificationSyncState()
  preferenceSyncState.value = syncState
  notificationSettings.value = next
  preferenceSyncText.value = preferenceTextForState(syncState)
  if (!loggedIn.value) return next
  if (syncState.pending && syncState.settings) {
    next = saveLocalNotificationSettings(syncState.settings)
    notificationSettings.value = next
    preferenceSyncText.value = preferenceTextForState(syncState)
    return next
  }
  try {
    const remote = await getNotificationSettings()
    next = saveLocalNotificationSettings(normalizeNotificationSettings(remote))
    notificationSettings.value = next
    preferenceSyncState.value = markNotificationSyncSuccess()
    preferenceSyncText.value = '已同步'
  } catch (e) {
    syncState = readNotificationSyncState()
    preferenceSyncState.value = syncState
    preferenceSyncText.value = preferenceTextForState(syncState)
  }
  return next
}

const persistNotificationSettings = async (nextSettings) => {
  const localSettings = saveLocalNotificationSettings(nextSettings)
  notificationSettings.value = localSettings
  preferenceSyncText.value = loggedIn.value ? '待同步' : '本机已保存'
  refreshMutedMessages()
  if (!loggedIn.value) return
  await syncNotificationSettingsToServer(localSettings)
}

const retryNotificationSync = async () => {
  if (!loggedIn.value || settingsSaving.value) return
  const syncState = normalizeNotificationSyncState(readNotificationSyncState())
  if (!syncState.pending) return
  const next = syncState.settings ? saveLocalNotificationSettings(syncState.settings) : notificationSettings.value
  notificationSettings.value = next
  refreshMutedMessages()
  await syncNotificationSettingsToServer(next, { manual: true })
}

const isCategoryMuted = (key) => !!notificationSettings.value.mutedCategories[key]
const toggleEnabled = () => persistNotificationSettings({ ...notificationSettings.value, enabled: !notificationSettings.value.enabled })
const toggleCategoryMute = (key) => {
  const next = normalizeNotificationSettings(notificationSettings.value)
  next.mutedCategories = { ...next.mutedCategories, [key]: !next.mutedCategories[key] }
  persistNotificationSettings(next)
}
const toggleQuietHours = () => {
  const next = normalizeNotificationSettings(notificationSettings.value)
  next.quietHours = { ...next.quietHours, enabled: !next.quietHours.enabled }
  persistNotificationSettings(next)
}
const toggleCriticalBypass = () => persistNotificationSettings({ ...notificationSettings.value, criticalConsultationBypass: !notificationSettings.value.criticalConsultationBypass })
const cycleQuietTime = (field) => {
  const next = normalizeNotificationSettings(notificationSettings.value)
  const options = field === 'start' ? quietStartOptions : quietEndOptions
  const current = next.quietHours[field]
  const index = options.indexOf(current)
  next.quietHours = { ...next.quietHours, [field]: options[(index + 1 + options.length) % options.length] }
  persistNotificationSettings(next)
}

const loadServiceCustomerInbox = async () => {
  const localReadIds = readLocalMessageIds()
  try {
    const data = await getTeacherClientsData({ port: 'service' })
    const actorId = String(getUserId() || '')
    const clients = (data && Array.isArray(data.clients) ? data.clients : []).filter((item) => (
      !item.serviceAssigneeId || (actorId && String(item.serviceAssigneeId) === actorId)
    ))
    const nextMessages = mergeMessages(
      buildCustomerChatMessages(clients).map((item, index) => normMsg(item, `service_${index}`, localReadIds))
    )
    messages.value = nextMessages
    failedClientAvatars.value = []
    pruneExpandedClientKeys()
    errorMsg.value = ''
    notifyMessageUnreadChange({ total: serviceUnreadCount.value })
  } catch (e) {
    messages.value = []
    expandedClientKeys.value = []
    errorMsg.value = (e && (e.message || e.errMsg)) || '客户消息加载失败，请稍后重试'
  } finally {
    loading.value = false
  }
}

const load = async () => {
  loggedIn.value = isLoggedIn()
  if (!loggedIn.value) { messages.value = []; return }
  activeRole.value = getCurrentRole()
  loading.value = true
  errorMsg.value = ''
  if (isServiceInbox.value) {
    if (!['all', 'unread'].includes(filterMode.value)) filterMode.value = 'all'
    settingsOpen.value = false
    messageReturnContext.value = null
    await loadServiceCustomerInbox()
    return
  }
  pushPermissionState.value = detectSystemPushPermissionState()
  pushBindingState.value = readSystemPushBindingState()
  const bindingSource = pushBindingState.value.pending && pushBindingState.value.binding ? pushBindingState.value.binding : pushPermissionState.value
  if (pushPermissionState.value.status === 'granted' || pushBindingState.value.pending) {
    syncPushBindingToServer(bindingSource, { silent: true }).catch(() => { pushBindingState.value = readSystemPushBindingState() })
  }
  refreshPendingWritebacks()
  const settings = await loadNotificationSettings()
  const localReadIds = readLocalMessageIds()
  let serverMessages = []
  let consultationMessages = []
  let debtMessages = []
  let serverError = ''
  try {
    const data = await getMessageList('all')
    serverMessages = collectRecords(data)
  } catch (e) {
    serverError = (e && (e.message || e.errMsg)) || '消息加载失败，请稍后重试'
  }
  let contactsData = null
  try {
    contactsData = await getAdvisorContacts()
    consultationMessages = buildConsultationMessages(contactsData)
  } catch (e) {
    consultationMessages = buildConsultationMessages(null)
  }
  let debtRecords = readDebtExecutionRecords()
  try {
    const cloudDebtRecords = await getDebtExecutionRecords()
    const synced = applyDebtExecutionCloudSnapshot(debtRecords, { remoteRecords: cloudDebtRecords, contactRecords: contactsData })
    debtRecords = synced.records
    if (synced.changed) {
      saveDebtExecutionRecords(debtRecords)
      notifyMessageUnreadChange({ source: 'debt-execution-cloud-message' })
    }
  } catch (e) {
    const synced = applyDebtExecutionCloudSnapshot(debtRecords, { contactRecords: contactsData })
    debtRecords = synced.records
    if (synced.changed) saveDebtExecutionRecords(debtRecords)
  }
  debtMessages = buildDebtExecutionMessages(undefined, undefined, debtRecords)
  const nextMessages = mergeMessages([
    ...debtMessages.map((item, index) => normMsg(item, `debt_${index}`, localReadIds)),
    ...consultationMessages.map((item, index) => normMsg(item, `consult_${index}`, localReadIds)),
    ...serverMessages.map((item, index) => normMsg(item, index, localReadIds))
  ])
  messages.value = applyMessageActionReceipts(applyNotificationSettings(nextMessages, settings))
  pruneExpandedClientKeys()
  applyMessageReturnState()
  errorMsg.value = nextMessages.length ? '' : serverError
  loading.value = false
  notifyMessageUnreadChange({ total: unreadCount.value })
  refreshPendingWritebacks()
  if (pendingWritebackCount.value) retryPendingWritebacks({ silent: true })
}

const openMsg = async (m) => {
  previewMessage.value = m
  if (m.actionUrl) recordMessageOpenSource(m)
  if (!m.read) {
    m.read = true
    if (isServiceInbox.value && isChatMessage(m)) {
      m.unreadCount = 0
      m.hasUnread = false
      try { await markAdvisorContactRead(m.contactId) } catch (e) { /* 已在当前页面置为已读，稍后重新加载时以服务端状态为准 */ }
    }
    if (m.local) {
      const ids = readLocalMessageIds()
      ids.add(m.id)
      saveLocalMessageIds(ids)
    } else {
      try { await markMessageRead(m.id) } catch (e) { /* 本地已置已读，忽略网络失败 */ }
    }
    notifyMessageUnreadChange({ total: isServiceInbox.value ? serviceUnreadCount.value : unreadCount.value })
  }
  if ((m.category === 'consultation' || m.debt) && m.actionUrl) {
    const openedReceipt = saveMessageActionReceipt(m, { stage: 'opened', page: '/pages/message/center', focus: m.focus || '', debtId: m.debtId || '', executionRecordId: m.executionRecordId || '' })
    syncMessageActionReceipt(openedReceipt, saveMessageActionReceiptRemote).then(() => refreshPendingWritebacks())
    messages.value = applyMessageActionReceipts(messages.value)
  }
  if (m.actionUrl) {
    uni.navigateTo({ url: m.actionUrl, fail: () => { uni.showToast({ title: '无法打开目标页面', icon: 'none' }) } })
  }
}

const isChatMessage = (m = {}) => m.messageKind === 'customer-chat' || m.focus === 'chat' || String(m.actionUrl || '').includes('/pages/chat/conversation')
const canDeleteMessage = (m = {}) => !!m.contactId && isChatMessage(m)
const deleteMessage = async (m = {}) => {
  if (!canDeleteMessage(m)) return
  try {
    await clearAdvisorContactView(m.contactId)
    messages.value = messages.value.filter((item) => !(isChatMessage(item) && String(item.contactId || '') === String(m.contactId || '')))
    if (previewMessage.value && String(previewMessage.value.contactId || '') === String(m.contactId || '')) previewMessage.value = null
    pruneExpandedClientKeys()
    notifyMessageUnreadChange({ total: isServiceInbox.value ? serviceUnreadCount.value : unreadCount.value })
    uni.showToast({ title: '已删除聊天框', icon: 'none' })
  } catch (e) {
    uni.showToast({ title: e && e.message ? e.message : '删除失败', icon: 'none' })
  }
}

const readAll = async () => {
  if (!loggedIn.value || allUnreadCount.value === 0) return
  const localIds = readLocalMessageIds()
  messages.value.forEach((m) => {
    m.read = true
    if (m.local) localIds.add(m.id)
  })
  saveLocalMessageIds(localIds)
  if (messages.value.some((m) => !m.local)) {
    try { await markAllMessagesRead() } catch (e) { uni.showToast({ title: '同步失败，请稍后重试', icon: 'none' }) }
  }
  notifyMessageUnreadChange({ total: 0 })
}

onShow(() => {
  restoreMessageViewState()
  load()
})
</script>

<style scoped>
.page { min-height: 100vh; min-height: 100dvh; height: 100vh; height: 100dvh; background: #F5F6FA; overflow: hidden; }
.nav { flex-shrink: 0; flex-direction: row; align-items: center; padding: calc(var(--rpt-safe-top) + 10px) 14px 10px; background: #fff; border-bottom: 1px solid #EEF0F4; }
.nav-spacer { width: 64px; }
.nav-title { flex: 1; text-align: center; font-size: 16px; font-weight: 800; color: #111827; }
.nav-right { width: 64px; align-items: flex-end; }
.nav-right-text { font-size: 13px; color: #086CEA; font-weight: 800; }
.nav-right-empty { color: transparent; }
.scroll-body { flex: 1; min-height: 0; height: 0 !important; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior-y: contain; touch-action: pan-y; }
.wrap { padding: 12px 16px 0; flex-shrink: 0; }

.state { align-items: center; padding: 80px 24px; }
.state-title { font-size: 17px; font-weight: 800; color: #111827; }
.state-sub { margin-top: 10px; font-size: 13px; color: #9CA3AF; text-align: center; line-height: 1.6; }
.state-btn { margin-top: 22px; background: #086CEA; border-radius: 8px; padding: 11px 36px; }
.state-btn-text { color: #fff; font-size: 15px; font-weight: 800; }

.inbox-skeleton { background: #fff; border-radius: 8px; padding: 15px; border: 1px solid #EEF0F4; }
.skeleton-head { flex-direction: row; align-items: center; justify-content: space-between; padding-bottom: 12px; border-bottom: 1px solid #F3F4F6; }
.skeleton-title { width: 42%; height: 18px; border-radius: 8px; }
.skeleton-pill { width: 58px; height: 28px; border-radius: 8px; }
.skeleton-row { flex-direction: row; align-items: center; padding: 14px 0; border-bottom: 1px solid #F5F6F8; }
.skeleton-row:last-child { border-bottom-width: 0; padding-bottom: 0; }
.skeleton-dot { width: 38px; height: 38px; border-radius: 8px; margin-right: 12px; }
.skeleton-main { flex: 1; min-width: 0; }
.skeleton-line { height: 12px; border-radius: 8px; }
.skeleton-line-title { width: 68%; }
.skeleton-line-sub { width: 88%; margin-top: 9px; }
.skeleton-shimmer { background: linear-gradient(90deg, #EEF4FF 0%, #F8FAFC 45%, #E7F3FF 80%); background-size: 220% 100%; animation: skeletonShimmer 1.1s ease-in-out infinite; }

.summary-card { flex-direction: row; align-items: center; background: #fff; border-radius: 8px; padding: 15px; margin-bottom: 12px; border: 1px solid #EEF0F4; }
.summary-main { flex: 1; padding-right: 10px; }
.summary-title { font-size: 16px; color: #111827; font-weight: 900; }
.summary-sub { margin-top: 4px; font-size: 12px; color: #6B7280; line-height: 1.45; }
.summary-actions { align-items: flex-end; }
.summary-count { font-size: 24px; color: #111827; font-weight: 900; }
.settings-entry { margin-top: 5px; height: 26px; min-width: 48px; padding: 0 10px; border-radius: 8px; background: #EAF3FF; align-items: center; justify-content: center; }
.settings-entry-text { font-size: 12px; color: #086CEA; font-weight: 900; }
.return-context-card { background: #111827; border-radius: 8px; padding: 12px; margin-bottom: 12px; flex-direction: row; align-items: center; }
.return-context-main { flex: 1; padding-right: 10px; }
.return-context-kicker { font-size: 11px; color: #93C5FD; font-weight: 900; }
.return-context-title { margin-top: 4px; font-size: 14px; color: #FFFFFF; font-weight: 900; line-height: 1.35; }
.return-context-sub { margin-top: 3px; font-size: 11px; color: #D1D5DB; line-height: 1.45; }
.return-context-actions { width: 76px; align-items: stretch; }
.return-context-primary, .return-context-ghost { height: 28px; border-radius: 8px; align-items: center; justify-content: center; }
.return-context-primary { background: #086CEA; }
.return-context-ghost { margin-top: 7px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.18); }
.return-context-primary-text { font-size: 11px; color: #fff; font-weight: 900; }
.return-context-ghost-text { font-size: 11px; color: #F3F4F6; font-weight: 900; }

.pref-panel { background: #fff; border: 1px solid #EEF0F4; border-radius: 8px; padding: 14px; margin-bottom: 12px; }
.pref-head { flex-direction: row; align-items: center; justify-content: space-between; padding-bottom: 10px; border-bottom: 1px solid #F1F3F7; }
.pref-head-main { flex: 1; }
.pref-title { font-size: 15px; color: #111827; font-weight: 900; }
.pref-sub { margin-top: 3px; font-size: 11px; color: #9CA3AF; }
.pref-mode { font-size: 12px; color: #086CEA; font-weight: 900; }
.sync-notice { margin-top: 12px; margin-bottom: 2px; border-radius: 8px; padding: 10px 12px; flex-direction: row; align-items: center; border: 1px solid #FDE68A; background: #FFFBEB; }
.sync-notice-error { border-color: #FECACA; background: #FEF2F2; }
.sync-copy { flex: 1; padding-right: 10px; }
.sync-title { font-size: 13px; color: #111827; font-weight: 900; }
.sync-sub { margin-top: 3px; font-size: 11px; color: #6B7280; line-height: 1.4; }
.sync-retry { height: 28px; min-width: 48px; border-radius: 8px; background: #086CEA; align-items: center; justify-content: center; padding: 0 12px; }
.sync-retry-text { font-size: 12px; color: #fff; font-weight: 900; }
.permission-pill { min-width: 52px; height: 28px; padding: 0 10px; border-radius: 8px; background: #EAF3FF; align-items: center; justify-content: center; }
.permission-pill-granted { background: #F0FDF4; }
.permission-pill-unsupported, .permission-pill-denied { background: #F3F4F6; }
.permission-pill-text { font-size: 12px; color: #086CEA; font-weight: 900; }
.permission-pill-granted .permission-pill-text { color: #15803D; }
.permission-pill-unsupported .permission-pill-text, .permission-pill-denied .permission-pill-text { color: #6B7280; }
.pref-row { flex-direction: row; align-items: center; justify-content: space-between; padding: 13px 0; border-bottom: 1px solid #F4F5F8; }
.pref-row-last { border-bottom-width: 0; padding-bottom: 0; }
.pref-copy { flex: 1; padding-right: 12px; }
.pref-label { font-size: 14px; color: #111827; font-weight: 800; }
.pref-value { margin-top: 3px; font-size: 12px; color: #6B7280; }
.pref-value-sub { color: #9CA3AF; line-height: 1.4; }
.sync-detail { margin-top: 8px; margin-bottom: 2px; border-radius: 8px; border: 1px solid #E5E7EB; background: #F9FAFB; padding: 10px 12px; }
.sync-detail-title { font-size: 12px; color: #111827; font-weight: 900; }
.sync-detail-row { margin-top: 6px; flex-direction: row; align-items: center; justify-content: space-between; }
.sync-detail-label { font-size: 11px; color: #6B7280; font-weight: 800; }
.sync-detail-value { font-size: 11px; color: #374151; font-weight: 800; }
.toggle { width: 42px; height: 24px; border-radius: 12px; background: #D1D5DB; padding: 2px; flex-direction: row; align-items: center; justify-content: flex-start; }
.toggle-on { background: #086CEA; justify-content: flex-end; }
.toggle-knob { width: 20px; height: 20px; border-radius: 10px; background: #fff; box-shadow: 0 1px 4px rgba(17,24,39,0.18); }
.pref-section { padding: 13px 0; border-bottom: 1px solid #F4F5F8; }
.pref-section-title { font-size: 13px; color: #111827; font-weight: 900; }
.mute-grid { margin-top: 10px; flex-direction: row; flex-wrap: wrap; }
.mute-option { width: 23%; min-width: 58px; margin-right: 2%; margin-bottom: 8px; border-radius: 8px; border: 1px solid #E5E7EB; background: #F9FAFB; padding: 9px 0; align-items: center; }
.mute-option-on { background: #F3F4F6; border-color: #9CA3AF; }
.mute-label { font-size: 12px; color: #111827; font-weight: 900; }
.mute-state { margin-top: 3px; font-size: 10px; color: #6B7280; }
.quiet-row { flex-direction: row; padding: 0 0 12px; border-bottom: 1px solid #F4F5F8; }
.time-chip { flex: 1; border-radius: 8px; background: #F9FAFB; border: 1px solid #E5E7EB; padding: 10px 12px; margin-right: 8px; }
.time-label { font-size: 11px; color: #9CA3AF; }
.time-value { margin-top: 3px; font-size: 14px; color: #111827; font-weight: 900; }

.filter-row { flex-direction: row; margin-bottom: 12px; flex-wrap: wrap; }
.filter-chip { height: 34px; padding: 0 14px; border-radius: 8px; background: #fff; border: 1px solid #EEF0F4; align-items: center; justify-content: center; margin-right: 8px; margin-bottom: 8px; flex-direction: row; }
.filter-chip-on { background: #086CEA; border-color: #086CEA; }
.filter-text { font-size: 12px; color: #4B5563; font-weight: 800; }
.filter-text-on { color: #fff; }
.filter-badge { margin-left: 5px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; background: #EAF3FF; color: #086CEA; font-size: 10px; font-weight: 900; text-align: center; line-height: 16px; }
.filter-badge-on { background: #FFFFFF; color: #086CEA; }
.debt-segment-row { flex-direction: row; align-items: center; margin-top: -4px; margin-bottom: 12px; flex-wrap: wrap; }
.debt-segment-chip { height: 30px; padding: 0 10px; border-radius: 8px; background: #fff; border: 1px solid #E5E7EB; flex-direction: row; align-items: center; justify-content: center; margin-right: 8px; margin-bottom: 6px; }
.debt-segment-chip-on { background: #111827; border-color: #111827; }
.debt-segment-text { font-size: 12px; color: #4B5563; font-weight: 900; }
.debt-segment-count { margin-left: 5px; font-size: 11px; color: #6B7280; font-weight: 900; }
.debt-segment-text-on { color: #fff; }
.debt-segment-summary { margin-bottom: 6px; font-size: 11px; color: #9CA3AF; font-weight: 800; }
.state-card-small { align-items: center; background: #fff; border-radius: 8px; padding: 30px 18px; border: 1px solid #EEF0F4; }
.state-title-small { font-size: 15px; color: #111827; font-weight: 900; }
.state-sub-small { margin-top: 7px; font-size: 12px; color: #9CA3AF; text-align: center; line-height: 1.5; }
.state-btn-small { margin-top: 16px; background: #086CEA; border-radius: 8px; padding: 9px 24px; }
.state-btn-small-text { color: #fff; font-size: 13px; font-weight: 900; }
.inbox-entry-client { margin-bottom: 10px; overflow: hidden; background: #fff; border: 1px solid #E5E7EB; border-radius: 10px; }
.inbox-entry-client-open { border-color: #BFDBFE; box-shadow: 0 5px 16px rgba(15, 23, 42, .05); }
.client-inbox-group { background: #fff; }
.client-inbox-summary { min-height: 94px; padding: 13px; flex-direction: row; align-items: flex-start; cursor: pointer; }
.client-inbox-summary:focus { outline: 2px solid #93C5FD; outline-offset: -2px; }
.client-inbox-avatar { flex-shrink: 0; width: 42px; height: 42px; margin-right: 11px; overflow: hidden; border: 1px solid #DBEAFE; border-radius: 21px; background: #EFF6FF; align-items: center; justify-content: center; }
.client-inbox-avatar-image { display: block; width: 100%; height: 100%; border-radius: 21px; }
.client-inbox-avatar-text { color: #1D4ED8; font-size: 15px; font-weight: 900; }
.client-inbox-main { flex: 1; min-width: 0; }
.client-inbox-title-line { min-height: 21px; flex-direction: row; align-items: center; }
.client-inbox-name { flex-shrink: 1; min-width: 0; overflow: hidden; color: #111827; font-size: 15px; font-weight: 900; line-height: 1.4; text-overflow: ellipsis; white-space: nowrap; }
.client-inbox-unread { flex-shrink: 0; min-width: 18px; height: 18px; margin-left: 5px; padding: 0 5px; overflow: hidden; border-radius: 9px; background: #EF4444; color: #fff; font-size: 10px; font-weight: 900; line-height: 18px; text-align: center; }
.client-inbox-uid { display: block; max-width: 100%; margin-top: 3px; overflow: hidden; color: #64748B; font-size: 10px; font-weight: 800; text-overflow: ellipsis; white-space: nowrap; }
.client-inbox-business-line { margin-top: 7px; flex-direction: row; align-items: center; min-width: 0; }
.client-inbox-business-key { flex-shrink: 0; margin-right: 6px; padding: 2px 5px; border-radius: 5px; background: #EFF6FF; color: #1D4ED8; font-size: 9px; font-weight: 900; }
.client-inbox-business { flex: 1; min-width: 0; color: #334155; font-size: 11px; font-weight: 900; line-height: 1.4; }
.client-inbox-preview { display: -webkit-box; margin-top: 6px; overflow: hidden; color: #6B7280; font-size: 11px; line-height: 1.45; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.client-inbox-side { flex-shrink: 0; width: 64px; margin-left: 7px; align-items: flex-end; }
.client-inbox-time { max-width: 64px; overflow: hidden; color: #94A3B8; font-size: 9px; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
.client-inbox-count { margin-top: 10px; color: #475569; font-size: 10px; font-weight: 900; text-align: right; }
.client-inbox-chevron {
  width: 28px;
  height: 28px;
  margin-top: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #086CEA;
  transition: transform .18s ease;
}
.client-inbox-chevron-icon {
  width: 18px;
  height: 18px;
}
.client-inbox-chevron-open { transform: rotate(180deg); }
.client-inbox-messages { padding: 10px 10px 0; background: #F8FAFC; border-top: 1px solid #DBEAFE; }
.msg { flex-direction: row; align-items: flex-start; background: #fff; border-radius: 8px; padding: 14px; border: 1px solid #EEF0F4; }
.msg-unread { border-color: #BFDBFE; }
.msg-muted { background: #FAFAFA; border-color: #E5E7EB; }
.msg-consultation { border-color: #DBEAFE; }
.msg-debt { border-color: #BBF7D0; }
.msg-danger { border-color: #FECACA; }
.msg-warning { border-color: #FDE68A; }
.msg-dot-wrap { width: 14px; padding-top: 5px; }
.msg-dot { width: 8px; height: 8px; border-radius: 4px; background: #086CEA; }
.msg-muted-dot { width: 8px; height: 8px; border-radius: 4px; background: #D1D5DB; }
.msg-main { flex: 1; }
.msg-head { flex-direction: row; align-items: flex-start; justify-content: space-between; }
.msg-title-line { flex: 1; flex-direction: row; align-items: center; margin-right: 8px; flex-wrap: wrap; }
.msg-title { font-size: 15px; font-weight: 800; color: #111827; flex: 1; min-width: 120px; }
.msg-title-read { font-weight: 600; color: #6B7280; }
.msg-tag { margin-left: 6px; padding: 3px 6px; border-radius: 6px; background: #F8FAFC; color: #64748B; font-size: 10px; font-weight: 900; }
.msg-tag-consultation { background: #EFF6FF; color: #1D4ED8; }
.msg-tag-advisor { background: #F0FDF4; color: #15803D; }
.msg-unread-count { margin-left: 6px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: #EF4444; color: #fff; font-size: 10px; font-weight: 900; line-height: 18px; text-align: center; }
.msg-muted-pill { margin-left: 6px; padding: 3px 6px; border-radius: 6px; background: #F3F4F6; color: #6B7280; font-size: 10px; font-weight: 900; }
.msg-time { font-size: 11px; color: #B6BAC2; margin-left: 8px; }
.msg-content { display: block; margin-top: 6px; font-size: 13px; color: #6B7280; line-height: 1.6; }
.msg-meta { flex-direction: row; align-items: center; justify-content: flex-start; margin-top: 9px; flex-wrap: wrap; }
.msg-level { padding: 3px 7px; border-radius: 6px; background: #F8FAFC; color: #64748B; font-size: 10px; font-weight: 900; margin-right: 8px; margin-bottom: 4px; }
.msg-level-danger { background: #FEF2F2; color: #DC2626; }
.msg-level-warning { background: #FFFBEB; color: #92400E; }
.msg-level-success { background: #F0FDF4; color: #15803D; }
.msg-context { padding: 3px 7px; border-radius: 6px; background: #F0FDF4; color: #15803D; font-size: 10px; font-weight: 900; margin-right: 8px; margin-bottom: 4px; }
.msg-receipt { font-size: 12px; color: #15803D; font-weight: 900; margin-right: 8px; margin-bottom: 4px; }
.msg-action { font-size: 12px; color: #086CEA; font-weight: 900; margin-bottom: 4px; }

.bottom-safe { height: calc(98px + var(--rpt-safe-bottom)); }
@keyframes skeletonShimmer { 0% { background-position: 120% 0; } 100% { background-position: -120% 0; } }

/* ── 桌面端 MasterDetail 样式 ≥1024px ── */
.msg-detail-pane { flex: 1; background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; padding: 20px; overflow-y: auto; }
.detail-inner { display: flex; flex-direction: column; }
.detail-toolbar { margin-bottom: 14px; flex-direction: row; align-items: center; }
.detail-toolbar-text { margin-left: 8px; color: #64748B; font-size: 13px; font-weight: 800; }
.detail-head { flex-direction: row; align-items: center; }
.detail-title { font-size: 18px; font-weight: 900; color: #111827; flex: 1; }
.detail-tag { padding: 4px 8px; border-radius: 6px; background: #F8FAFC; color: #64748B; font-size: 11px; font-weight: 900; }
.detail-time { margin-top: 8px; font-size: 12px; color: #9CA3AF; }
.detail-content { margin-top: 14px; font-size: 14px; color: #374151; line-height: 1.7; }
.detail-meta { margin-top: 12px; flex-direction: row; flex-wrap: wrap; }
.detail-meta-item { margin-right: 8px; margin-bottom: 6px; padding: 4px 8px; border-radius: 6px; background: #F0FDF4; color: #15803D; font-size: 11px; font-weight: 900; }
.detail-action { margin-top: 18px; height: 40px; border-radius: 8px; background: #086CEA; align-items: center; justify-content: center; align-self: flex-start; padding: 0 24px; }
.detail-action-text { color: #fff; font-size: 14px; font-weight: 900; }
.detail-empty { align-items: center; justify-content: center; padding: 60px 20px; }
.detail-empty-title { font-size: 16px; font-weight: 900; color: #111827; }
.detail-empty-sub { margin-top: 8px; font-size: 13px; color: #9CA3AF; text-align: center; }

@media (min-width: 1024px) {
  .page { height: 100dvh; }
  .wrap { padding: 16px 20px 0; }
}
</style>
