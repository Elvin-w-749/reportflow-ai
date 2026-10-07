<template>
  <view class="page rpt-page">
    <view class="nav rpt-content-max">
      <RptBackButton @click="goBack" />
      <view class="nav-main">
        <text class="nav-title">{{ titleText }}</text>
        <text class="nav-sub">{{ subText }}</text>
      </view>
      <view class="nav-refresh" @click="load()">
        <text v-if="contact.hasUnread" class="nav-unread-dot">{{ contact.unreadCount || '' }}</text>
        <text class="nav-refresh-text">同步</text>
      </view>
    </view>

    <scroll-view class="scroll-body" scroll-y :scroll-into-view="bottomAnchor">
      <view class="wrap rpt-content-max">
        <view v-if="loading" class="state-card">
          <view class="loading-dots">
            <view class="loading-dot loading-dot-a"></view>
            <view class="loading-dot loading-dot-b"></view>
            <view class="loading-dot loading-dot-c"></view>
          </view>
          <text class="state-title">正在加载会话</text>
          <text class="state-sub">同步咨询记录和最新回复。</text>
        </view>

        <view v-else-if="!contactId" class="state-card">
          <text class="state-title">缺少会话</text>
          <text class="state-sub">请从产品咨询、客服入口或处理端列表进入。</text>
        </view>

        <view v-else>
          <view class="chat-brief">
            <view class="brief-main">
              <text class="brief-title">{{ contactTitle }}</text>
              <text class="brief-sub">{{ contextSub }}</text>
            </view>
            <view class="status-pill" :class="'status-' + normalizedStatus">
              <text class="status-pill-text">{{ statusText }}</text>
            </view>
          </view>

	          <view v-if="claimNotice" class="claim-card">
	            <view class="claim-main">
	              <text class="claim-title">{{ claimNotice.title }}</text>
	              <text class="claim-sub">{{ claimNotice.sub }}</text>
	            </view>
	            <view v-if="needsClaim" class="claim-btn" @click="claimConversation">
	              <text class="claim-btn-text">接单</text>
	            </view>
	          </view>

          <view class="sync-strip" :class="'sync-' + syncState">
            <view class="sync-left">
              <text class="sync-dot"></text>
              <text class="sync-text">{{ syncStatusText }}</text>
            </view>
            <view v-if="newMessageHint" class="sync-new" @click="jumpToLatest">
              <text class="sync-new-text">有新回复</text>
            </view>
          </view>

          <view class="quiet-tools">
            <view class="quiet-tool-main">
              <text class="quiet-tool-title">{{ toolSummaryTitle }}</text>
              <text class="quiet-tool-sub">{{ toolSummarySub }}</text>
            </view>
            <view class="quiet-tool-btn" @click="actionPanelOpen = !actionPanelOpen">
              <text class="quiet-tool-btn-text">{{ actionPanelOpen ? '收起' : '更多' }}</text>
            </view>
          </view>

          <view v-if="actionPanelOpen" class="action-panel">
            <ChatParticipantStrip :source="contact" />
            <ServiceProgressStrip :source="contact" @material-click="openMaterialArchive" />
            <view class="action-grid">
              <view v-if="canMentionService" class="action-chip" @click="appendMention('service')"><text class="action-chip-text">@客服</text></view>
              <view v-if="canMentionAdvisor" class="action-chip" @click="appendMention('advisor')"><text class="action-chip-text">@银行老师</text></view>
              <view v-if="canInviteAdvisor" class="action-chip" @click="inviteAdvisor"><text class="action-chip-text">拉老师</text></view>
              <view v-if="canRenameGroup" class="action-chip" @click="openRenameGroup"><text class="action-chip-text">改群名</text></view>
              <view v-if="canFeedback" class="action-chip" @click="submitFeedback"><text class="action-chip-text">评价</text></view>
              <view v-if="canComplete" class="action-chip" @click="completeOrder"><text class="action-chip-text">完成</text></view>
              <view v-if="canClearChat" class="action-chip muted" @click="clearChat"><text class="action-chip-text muted">删除</text></view>
              <view v-if="canEndChat" class="action-chip danger" @click="endChat"><text class="action-chip-text danger">结束</text></view>
            </view>
            <view v-if="renamePanelOpen" class="rename-panel">
              <input v-model.trim="groupNameDraft" class="rename-input" maxlength="30" placeholder="输入新的群名称" confirm-type="done" @confirm="submitRenameGroup" />
              <view class="rename-actions">
                <view class="rename-cancel" @click="renamePanelOpen = false"><text class="rename-cancel-text">取消</text></view>
                <view class="rename-save" @click="submitRenameGroup"><text class="rename-save-text">保存</text></view>
              </view>
            </view>
          </view>

          <view v-if="!messages.length" class="empty-chat">
            <text class="empty-chat-text">还没有消息，直接发送你的问题即可。</text>
          </view>

          <view v-for="message in messages" :id="'msg_' + message.id" :key="message.id" class="msg-row" :class="{ mine: isMine(message) }">
            <view class="msg-bubble" :class="{ mine: isMine(message) }">
              <text class="msg-name">{{ senderName(message) }}</text>
              <text class="msg-content">{{ message.content }}</text>
              <view class="msg-meta-line">
                <text class="msg-time">{{ timeText(message.createdAt) }}</text>
                <text
                  v-if="message.sendStatus"
                  class="msg-status"
                  :class="{ failed: message.sendStatus === 'failed' }"
                  @click.stop="retryMessage(message)"
                >{{ sendStatusText(message) }}</text>
                <text v-else-if="readReceiptText(message)" class="msg-read-receipt" :class="{ unread: readReceiptText(message) === '未读' }">{{ readReceiptText(message) }}</text>
              </view>
            </view>
          </view>
          <view id="chat_bottom" class="bottom-anchor"></view>
        </view>
      </view>
    </scroll-view>

    <view class="composer rpt-content-max">
      <input v-model.trim="draft" class="composer-input" :disabled="composerDisabled" :placeholder="placeholderText" maxlength="500" confirm-type="send" @confirm="send" />
      <view class="send-btn" :class="{ disabled: !draft || sending || composerDisabled }" @click="send">
        <text class="send-btn-text">{{ sending ? '发送中' : '发送' }}</text>
      </view>
    </view>
  </view>
</template>

<script setup>
import { computed, nextTick, ref } from 'vue'
import { onHide, onShow } from '@/compat/web-lifecycle.js'
import { useRoute } from 'vue-router'
import { getCachedUserInfo, getUserId, isLoggedIn } from '@/services/authService.js'
import { getCurrentRole } from '@/services/roleService.js'
import { claimAdvisorContact, clearAdvisorContactView, completeAdvisorContact, endAdvisorContact, getAdvisorContactMessages, getBankAdvisorCandidates, inviteAdvisorToContact, renameAdvisorContactGroup, sendAdvisorContactMessage, submitAdvisorContactFeedback } from '@/services/profileService.js'
import ChatParticipantStrip from '@/components/ChatParticipantStrip.vue'
import ServiceProgressStrip from '@/components/ServiceProgressStrip.vue'
import RptBackButton from '@/components/RptBackButton.vue'
import safeBack from '@/utils/safeBack.js'

const route = useRoute()
const loading = ref(false)
const sending = ref(false)
const actionBusy = ref(false)
const contact = ref({})
const messages = ref([])
const draft = ref('')
const bottomAnchor = ref('')
const syncState = ref('ready')
const lastSyncedAt = ref('')
const newMessageHint = ref(false)
const actionPanelOpen = ref(false)
const renamePanelOpen = ref(false)
const groupNameDraft = ref('')
const CHAT_POLL_MS = 2500
let pollTimer = null

const contactId = computed(() => String(route.query.contactId || route.query.id || ''))
const currentRole = computed(() => getCurrentRole())
const channel = computed(() => String(contact.value.channel || contact.value.deskType || (contact.value.contactType === 'customer-service' ? 'service' : 'bank') || 'bank'))
const normalizedStatus = computed(() => {
  const raw = String(contact.value.status || 'pending')
  if (['completed', 'done', 'resolved'].includes(raw)) return 'completed'
  if (['pending', 'new', 'todo'].includes(raw)) return 'pending'
  return 'processing'
})
const statusText = computed(() => ({ pending: '待处理', processing: '处理中', completed: '已完成' }[normalizedStatus.value] || '处理中'))
const channelText = computed(() => channel.value === 'service' ? '客服咨询' : '产品咨询')
const isGroupChat = computed(() => channel.value === 'bank' && (contact.value.serviceRequired || contact.value.groupMode === 'service-bank-customer' || contact.value.contactType === 'match-product'))
const titleText = computed(() => {
  if (channel.value === 'service') return '客服会话'
  return isGroupChat.value ? '三方沟通群' : '银行经理会话'
})
const contactTitle = computed(() => {
  const groupName = contact.value.groupName || contact.value.groupTitle || contact.value.displayTitle
  if (groupName) return groupName
  if (channel.value === 'service') return '在线客服'
  const product = contact.value.productName || (contact.value.product && contact.value.product.name) || '匹配产品'
  const institution = contact.value.institution || (contact.value.product && contact.value.product.institution) || ''
  return institution ? `${institution} · ${product}` : product
})
const subText = computed(() => contactTitle.value)
const contextSub = computed(() => {
  const parts = [
    contact.value.reportTitle || (contact.value.report && contact.value.report.title) || '',
    contact.value.matchRate ? `匹配 ${contact.value.matchRate}%` : '',
    contact.value.summary || ''
  ].filter(Boolean)
	  return parts.join(' · ') || (isGroupChat.value ? '客户、客服和对应机构银行经理共用此沟通群。' : '会话内容会同步到对应处理端。')
	})
const assignedToCurrentRole = computed(() => {
  const uid = getUserId()
  if (currentRole.value === 'service') return !!uid && String(contact.value.serviceAssigneeId || '') === String(uid)
  if (currentRole.value === 'advisor') return !!uid && String(contact.value.advisorAssigneeId || '') === String(uid)
  return true
})
const needsClaim = computed(() => {
  if (currentRole.value === 'advisor') return isGroupChat.value && !assignedToCurrentRole.value
  if (currentRole.value === 'service') return (isGroupChat.value || channel.value === 'service') && !assignedToCurrentRole.value
  return false
})
const claimNotice = computed(() => {
  if (!['advisor', 'service'].includes(currentRole.value)) return null
  if (currentRole.value === 'advisor' && !isGroupChat.value) return null
  if (currentRole.value === 'service' && !isGroupChat.value && channel.value !== 'service') return null
  if (needsClaim.value) {
    return currentRole.value === 'service'
      ? { title: '待客服接单', sub: isGroupChat.value ? '接单后可查看客户授权资料，并在群内协助沟通。' : '接单后可回复客户咨询，并查看本次授权材料。' }
      : { title: '待银行经理接单', sub: '仅匹配机构经理可接入，接单后可查看客户授权资料。' }
  }
  const name = currentRole.value === 'service' ? contact.value.serviceAssigneeName : contact.value.advisorAssigneeName
  return { title: '已接入会话', sub: `${name || '当前账号'}已接单，回复会同步给客户和群内成员。` }
})
const placeholderText = computed(() => {
  if (contact.value.customerChatClosed) return '会话已结束'
  if (needsClaim.value) return '接单后可回复客户'
  if (currentRole.value === 'advisor') return isGroupChat.value ? '在三方群回复客户' : '回复客户产品咨询'
  if (currentRole.value === 'service') return isGroupChat.value ? '在三方群协助客户' : '回复客户客服咨询'
  if (currentRole.value === 'admin') return '管理员留痕说明'
  return '输入你的问题'
})
const composerDisabled = computed(() => !!contact.value.customerChatClosed || needsClaim.value)
const canMentionService = computed(() => isGroupChat.value && currentRole.value !== 'service' && !contact.value.customerChatClosed)
const canMentionAdvisor = computed(() => isGroupChat.value && currentRole.value !== 'advisor' && !contact.value.customerChatClosed)
const canFeedback = computed(() => currentRole.value === 'user' && !!contactId.value && !contact.value.customerChatClosed)
const canComplete = computed(() => !!contactId.value && !contact.value.customerChatClosed && normalizedStatus.value !== 'completed' && (currentRole.value === 'user' || currentRole.value === 'admin' || (['advisor', 'service'].includes(currentRole.value) && assignedToCurrentRole.value)))
const canClearChat = computed(() => !!contactId.value && ['user', 'service', 'advisor'].includes(currentRole.value))
const canEndChat = computed(() => currentRole.value === 'user' && !!contactId.value && !contact.value.customerChatClosed)
const canInviteAdvisor = computed(() => currentRole.value === 'service' && assignedToCurrentRole.value && !contact.value.advisorAssigneeId && !contact.value.customerChatClosed)
const canRenameGroup = computed(() => !!contactId.value && isGroupChat.value && !contact.value.customerChatClosed && (currentRole.value === 'admin' || (['service', 'advisor'].includes(currentRole.value) && assignedToCurrentRole.value)))
const syncStatusText = computed(() => {
  if (syncState.value === 'offline') return '连接不稳，正在重试'
  if (syncState.value === 'syncing') return '正在同步消息'
  return lastSyncedAt.value ? `实时同步中 · ${timeText(lastSyncedAt.value)}` : '实时同步中'
})
const toolSummaryTitle = computed(() => {
  if (needsClaim.value) return currentRole.value === 'service' ? '先接单再沟通' : '等待客服拉入群聊'
  if (contact.value.advisorJoinRequired) return '待客服确认'
  if (isGroupChat.value) return '三方群聊'
  return channel.value === 'service' ? '客服对话' : '一对一咨询'
})
const toolSummarySub = computed(() => {
  if (contact.value.advisorJoinRequired) return contact.value.advisorAccessText || '客服确认后，银行老师才能查看聊天记录。'
  if (needsClaim.value) return claimNotice.value && claimNotice.value.sub ? claimNotice.value.sub : '接单后可回复并查看授权资料。'
  if (isGroupChat.value) return '资料、成员和订单操作已收起到更多。'
  return '评价、删除、结束等操作在更多里。'
})

const isMine = (message = {}) => {
  const uid = getUserId()
  if (uid && message.senderId && String(message.senderId) === String(uid)) return true
	  if (currentRole.value === 'advisor') return message.senderType === 'bank'
	  if (currentRole.value === 'service') return message.senderType === 'service'
	  if (currentRole.value === 'admin') return message.senderType === 'admin'
	  return message.senderType === 'user'
	}
const senderName = (message = {}) => {
	  if (message.senderName) return message.senderName
	  if (message.senderType === 'bank') return '银行客户经理'
	  if (message.senderType === 'service') return '客服'
	  if (message.senderType === 'admin') return '管理员'
	  if (message.senderType === 'system') return '系统'
	  const user = getCachedUserInfo() || {}
	  return user.nickname || '用户'
	}
const timeText = (value) => {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 16)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const messageKeyOf = (message = {}, index = 0) => {
  const stableId = String(message.id || message.messageId || '').trim()
  if (stableId) return stableId
  return [
    index,
    message.senderId || '',
    message.senderType || '',
    message.createdAt || message.updateTime || '',
    message.content || ''
  ].join('|')
}
const normalizeMessages = (list = []) => Array.isArray(list)
  ? list.map((message, index) => ({ ...message, id: messageKeyOf(message, index) }))
  : []
const remoteMessages = () => messages.value.filter((message) => !message.localPending)
const localPendingMessages = () => messages.value.filter((message) => message.localPending && message.sendStatus !== 'sent')
const mergePendingMessages = (nextMessages = []) => {
  const existingIds = new Set(nextMessages.map((message, index) => messageKeyOf(message, index)))
  const pending = localPendingMessages().filter((message) => !existingIds.has(messageKeyOf(message)))
  return pending.length ? [...nextMessages, ...pending] : nextMessages
}
const messageSignature = (list = []) => list
  .map((message, index) => [
    messageKeyOf(message, index),
    message.senderType || '',
    message.senderId || '',
    message.createdAt || message.updateTime || '',
    message.content || ''
  ].join('#'))
  .join('::')
const scrollBottom = () => {
  bottomAnchor.value = ''
  nextTick(() => { bottomAnchor.value = 'chat_bottom' })
}
const jumpToLatest = () => {
  newMessageHint.value = false
  scrollBottom()
}
const load = async (opts = {}) => {
  if (!isLoggedIn()) {
    if (!opts.silent) uni.navigateTo({ url: '/pages/login/index' })
    return
  }
  if (!contactId.value) return
  syncState.value = 'syncing'
  if (!opts.silent) loading.value = true
  try {
    const data = await getAdvisorContactMessages(contactId.value)
    contact.value = data.contact || {}
    const nextMessages = normalizeMessages(data.messages)
    const changed = messageSignature(nextMessages) !== messageSignature(remoteMessages())
    const latest = nextMessages[nextMessages.length - 1]
    if (changed || !opts.silent) messages.value = mergePendingMessages(nextMessages)
    if (opts.silent && changed && latest && !isMine(latest)) newMessageHint.value = true
    if (!opts.silent || opts.forceScroll || (changed && latest && isMine(latest))) {
      newMessageHint.value = false
      scrollBottom()
    }
    lastSyncedAt.value = new Date().toISOString()
    syncState.value = 'ready'
  } catch (e) {
    syncState.value = 'offline'
    if (!opts.silent) uni.showToast({ title: e && e.message ? e.message : '会话加载失败', icon: 'none' })
  } finally {
    if (!opts.silent) loading.value = false
  }
}
const senderTypeForCurrentRole = () => {
  if (currentRole.value === 'advisor') return 'bank'
  if (currentRole.value === 'service') return 'service'
  if (currentRole.value === 'admin') return 'admin'
  return 'user'
}
const currentSenderName = () => {
  const user = getCachedUserInfo() || {}
  if (currentRole.value === 'advisor') return user.nickname || user.realName || '银行客户经理'
  if (currentRole.value === 'service') return user.nickname || user.realName || '客服'
  if (currentRole.value === 'admin') return user.nickname || user.realName || '管理员'
  return user.nickname || user.realName || '我'
}
const makePendingMessage = (content, id = '') => ({
  id: id || `pending-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
  localPending: true,
  sendStatus: 'sending',
  senderId: getUserId(),
  senderType: senderTypeForCurrentRole(),
  senderName: currentSenderName(),
  content,
  createdAt: new Date().toISOString()
})
const sendStatusText = (message = {}) => {
  if (message.sendStatus === 'failed') return '发送失败，点此重发'
  if (message.sendStatus === 'sending') return '发送中'
  return ''
}
const readReceiptText = (message = {}) => {
  if (!isMine(message) || message.senderType === 'system' || message.localPending || message.sendStatus) return ''
  if (message.readStatusText) return message.readStatusText
  if (message.readStatus === 'read') return '已读'
  if (message.readStatus === 'unread') return '未读'
  return ''
}
const markPendingStatus = (id, status) => {
  messages.value = messages.value.map((message) => (
    String(message.id) === String(id)
      ? { ...message, sendStatus: status, localPending: true }
      : message
  ))
}
const sendText = async (text, pendingId = '') => {
  const content = String(text || '').trim()
  if (!content) return
  const localMessage = makePendingMessage(content, pendingId)
  if (pendingId) {
    markPendingStatus(pendingId, 'sending')
  } else {
    messages.value = [...messages.value, localMessage]
  }
  newMessageHint.value = false
  scrollBottom()
  sending.value = true
  try {
    const activePendingId = pendingId || localMessage.id
    const data = await sendAdvisorContactMessage(contactId.value, content)
    if (data && data.message) {
      messages.value = normalizeMessages([
        ...messages.value.filter((message) => String(message.id) !== String(activePendingId)),
        data.message
      ])
      scrollBottom()
      await load({ silent: true, forceScroll: true })
    } else {
      messages.value = messages.value.filter((message) => String(message.id) !== String(activePendingId))
      await load({ forceScroll: true })
    }
    scrollBottom()
  } catch (e) {
    markPendingStatus(pendingId || localMessage.id, 'failed')
    uni.showToast({ title: e && e.message ? e.message : '发送失败', icon: 'none' })
  } finally {
    sending.value = false
	  }
	}
const retryMessage = async (message = {}) => {
  if (sending.value || composerDisabled.value || message.sendStatus !== 'failed') return
  await sendText(message.content || '', message.id)
}
const openMaterialArchive = () => {
  const id = contactId.value
  if (currentRole.value === 'admin') {
    uni.navigateTo({ url: `/pages/admin/monitor?view=materials&contactId=${encodeURIComponent(id)}` })
    return
  }
  if (currentRole.value === 'advisor') {
    uni.navigateTo({ url: `/pages/teacher/client-detail?id=${encodeURIComponent(id)}` })
    return
  }
  if (currentRole.value === 'service') {
    uni.navigateTo({ url: `/pages/teacher/client-detail?id=${encodeURIComponent(id)}&port=service` })
    return
  }
  if (currentRole.value === 'user') {
    uni.navigateTo({ url: `/pages/profile/supplement-materials?contactId=${encodeURIComponent(id)}` })
    return
  }
  uni.showToast({ title: '当前账号无权查看授权资料', icon: 'none' })
}
const send = async () => {
	  if (!draft.value || sending.value || !contactId.value || composerDisabled.value) return
	  if (needsClaim.value) {
	    uni.showToast({ title: '请先接单后再回复', icon: 'none' })
	    return
	  }
	  const text = draft.value
	  draft.value = ''
	  await sendText(text)
	}
const appendMention = (target) => {
  const label = target === 'service' ? '@客服' : '@银行老师'
  draft.value = [draft.value, label].filter(Boolean).join(draft.value ? ' ' : '').trim() + ' '
  actionPanelOpen.value = false
}
const askConfirm = (title, content, confirmText = '确认') => new Promise((resolve) => {
  uni.showModal({
    title,
    content,
    confirmText,
    cancelText: '取消',
    success: (res) => resolve(!!(res && res.confirm)),
    fail: () => resolve(false)
  })
})
const withAction = async (runner) => {
  if (actionBusy.value) return
  actionBusy.value = true
  try {
    await runner()
  } finally {
    actionBusy.value = false
  }
}
const submitFeedback = () => withAction(async () => {
  if (!canFeedback.value) return
  uni.showActionSheet({
    itemList: ['5分 非常满意', '4分 满意', '3分 一般'],
    success: async (res) => {
      const rating = res.tapIndex === 0 ? 5 : res.tapIndex === 1 ? 4 : 3
      await submitAdvisorContactFeedback(contactId.value, { rating })
      uni.showToast({ title: '已提交评价', icon: 'none' })
      await load({ forceScroll: true })
    }
  })
})
const completeOrder = () => withAction(async () => {
  if (!canComplete.value) return
  const ok = await askConfirm('确认完成服务', currentRole.value === 'user' ? '确认愿意办理并结束本次订单？' : '确认将本次服务标记为已完成？', '完成')
  if (!ok) return
  await completeAdvisorContact(contactId.value, { businessConfirmed: true })
  uni.showToast({ title: '已完成', icon: 'none' })
  await load({ forceScroll: true })
})
const candidateListOf = (payload) => {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload && payload.list)) return payload.list
  if (Array.isArray(payload && payload.data && payload.data.list)) return payload.data.list
  return []
}
const inviteAdvisor = () => withAction(async () => {
  if (!canInviteAdvisor.value) return
  const payload = await getBankAdvisorCandidates(contactId.value)
  const candidates = candidateListOf(payload)
  if (!candidates.length) {
    uni.showToast({ title: '暂无可邀请的银行老师', icon: 'none' })
    return
  }
  const labels = candidates.slice(0, 6).map((item) => `${item.institution || '合作机构'} · ${item.name || '银行老师'}`)
  uni.showActionSheet({
    itemList: labels,
    success: async (res) => {
      const target = candidates[res.tapIndex]
      if (!target) return
      try {
        await inviteAdvisorToContact(contactId.value, {
          advisorId: target.uid || target.id,
          institution: target.institution
        })
        uni.showToast({ title: '已邀请银行老师', icon: 'none' })
        await load({ forceScroll: true })
      } catch (e) {
        uni.showToast({ title: e && e.message ? e.message : '邀请失败', icon: 'none' })
      }
    }
  })
})
const openRenameGroup = () => {
  if (!canRenameGroup.value) return
  groupNameDraft.value = contactTitle.value || ''
  renamePanelOpen.value = true
}
const submitRenameGroup = () => withAction(async () => {
  if (!canRenameGroup.value) return
  const name = String(groupNameDraft.value || '').trim()
  if (name.length < 2) {
    uni.showToast({ title: '群名称至少 2 个字', icon: 'none' })
    return
  }
  try {
    const data = await renameAdvisorContactGroup(contactId.value, name)
    if (data && data.contact) contact.value = data.contact
    if (data && data.message) messages.value = normalizeMessages([...messages.value, data.message])
    renamePanelOpen.value = false
    uni.showToast({ title: '群名称已更新', icon: 'none' })
    await load({ silent: true, forceScroll: true })
  } catch (e) {
    uni.showToast({ title: e && e.message ? e.message : '修改失败', icon: 'none' })
  }
})
const clearChat = () => withAction(async () => {
  if (!canClearChat.value) return
  const ok = await askConfirm('删除当前会话', '删除后你的列表里不再显示这个聊天窗口，管理员后台仍会保留完整留档。', '删除')
  if (!ok) return
  await clearAdvisorContactView(contactId.value)
  messages.value = []
  uni.showToast({ title: '已删除会话', icon: 'none' })
  setTimeout(() => goBack(), 250)
})
const endChat = () => withAction(async () => {
  if (!canEndChat.value) return
  const ok = await askConfirm('结束聊天', '结束后客户侧会关闭此对话框并清空聊天记录，管理员后台仍保留完整记录。', '结束')
  if (!ok) return
  await endAdvisorContact(contactId.value)
  messages.value = []
  uni.showToast({ title: '聊天已结束', icon: 'none' })
  setTimeout(() => goBack(), 250)
})
const claimConversation = async () => {
  if (!contactId.value || !needsClaim.value) return
  try {
    const data = await claimAdvisorContact(contactId.value, currentRole.value)
    if (data && data.message) messages.value = [...messages.value, data.message]
    await load({ forceScroll: true })
    startPolling()
    uni.showToast({ title: '已接单', icon: 'none' })
  } catch (e) {
    uni.showToast({ title: e && e.message ? e.message : '接单失败', icon: 'none' })
  }
}
const goBack = () => {
  if (currentRole.value === 'admin') return safeBack('/pages/admin/workbench')
  if (currentRole.value === 'advisor') return safeBack('/pages/bank/workbench')
  if (currentRole.value === 'service') return safeBack('/pages/service/workbench')
  return safeBack('/pages/message/center')
}

const stopPolling = () => {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}
const startPolling = () => {
  stopPolling()
  pollTimer = setInterval(() => load({ silent: true }), CHAT_POLL_MS)
}

onShow(async () => {
  await load()
  startPolling()
})
onHide(() => stopPolling())
</script>

<style scoped>
.page { min-height: 100vh; background: #F5F6FA; }
.nav { flex-direction: row; align-items: center; padding: calc(var(--rpt-safe-top) + 8px) 12px 8px; background: #fff; border-bottom: 1px solid #EEF0F4; }
.nav-main { flex: 1; min-width: 0; padding: 0 8px; }
.nav-title { font-size: 16px; color: #111827; font-weight: 900; }
.nav-sub { margin-top: 2px; font-size: 11px; color: #9CA3AF; }
.nav-refresh { width: 42px; align-items: flex-end; }
.nav-unread-dot { min-width: 16px; height: 16px; border-radius: 8px; background: #EF4444; color: #fff; font-size: 10px; line-height: 16px; text-align: center; font-weight: 900; margin-bottom: 2px; overflow: hidden; }
.nav-refresh-text { font-size: 12px; color: #086CEA; font-weight: 900; }
.scroll-body { flex: 1; height: calc(100vh - 118px); }
.wrap { padding: 12px 14px 18px; }
.chat-brief { flex-direction: row; align-items: center; background: rgba(255, 255, 255, .92); border: 1px solid #EEF3FA; border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; }
.brief-main { flex: 1; min-width: 0; margin-right: 10px; }
.brief-title { font-size: 14px; color: #111827; font-weight: 900; }
.brief-sub { margin-top: 3px; font-size: 11px; color: #8B95A7; line-height: 1.45; }
.context-card { flex-direction: row; align-items: center; background: #fff; border: 1px solid #EEF0F4; border-radius: 8px; padding: 13px; margin-bottom: 12px; }
.context-main { flex: 1; margin-right: 10px; }
.context-kicker { font-size: 11px; color: #1D4ED8; font-weight: 900; }
.context-title { margin-top: 4px; font-size: 15px; color: #111827; font-weight: 900; }
.context-sub { margin-top: 4px; font-size: 12px; color: #6B7280; line-height: 1.45; }
.status-pill { padding: 5px 8px; border-radius: 8px; background: #EFF6FF; }
.status-pending { background: #EAF3FF; }
.status-completed { background: #F0FDF4; }
	.status-pill-text { font-size: 11px; color: #1D4ED8; font-weight: 900; }
	.status-pending .status-pill-text { color: #086CEA; }
	.status-completed .status-pill-text { color: #15803D; }
	.claim-card { flex-direction: row; align-items: center; background: #EFF6FF; border: 1px solid #BFDBFE; border-radius: 8px; padding: 12px 13px; margin-bottom: 12px; }
	.claim-main { flex: 1; margin-right: 10px; }
	.claim-title { font-size: 13px; color: #111827; font-weight: 900; }
	.claim-sub { margin-top: 4px; font-size: 12px; color: #475569; line-height: 1.45; }
	.claim-btn { height: 36px; padding: 0 14px; border-radius: 8px; background: #086CEA; align-items: center; justify-content: center; }
	.claim-btn-text { font-size: 13px; color: #fff; font-weight: 900; }
.sync-strip { flex-direction: row; align-items: center; justify-content: space-between; min-height: 32px; border-radius: 8px; background: #F8FAFC; border: 1px solid #E5E7EB; padding: 7px 10px; margin-bottom: 10px; }
.sync-left { flex-direction: row; align-items: center; flex: 1; min-width: 0; }
.sync-dot { width: 7px; height: 7px; border-radius: 4px; background: #16A34A; margin-right: 7px; }
.sync-syncing .sync-dot { background: #086CEA; animation: syncPulse 1.1s ease-in-out infinite; }
.sync-offline { background: #FEF2F2; border-color: #FECACA; }
.sync-offline .sync-dot { background: #DC2626; }
.sync-text { flex: 1; font-size: 11px; color: #64748B; font-weight: 800; }
.sync-new { height: 24px; border-radius: 8px; background: #EAF3FF; padding: 0 9px; align-items: center; justify-content: center; margin-left: 8px; }
.sync-new-text { font-size: 11px; color: #086CEA; font-weight: 900; }
.quiet-tools { flex-direction: row; align-items: center; background: #fff; border: 1px solid #EEF0F4; border-radius: 8px; padding: 10px 11px; margin-bottom: 10px; }
.quiet-tool-main { flex: 1; min-width: 0; margin-right: 10px; }
.quiet-tool-title { font-size: 13px; color: #111827; font-weight: 900; }
.quiet-tool-sub { margin-top: 3px; font-size: 11px; color: #8B95A7; line-height: 1.4; }
.quiet-tool-btn { width: 52px; height: 30px; border-radius: 8px; background: #EAF3FF; align-items: center; justify-content: center; }
.quiet-tool-btn-text { font-size: 12px; color: #086CEA; font-weight: 900; }
.action-panel { background: #fff; border: 1px solid #E6EEF9; border-radius: 8px; padding: 10px; margin-bottom: 10px; }
.action-grid { flex-direction: row; align-items: center; flex-wrap: wrap; margin: 8px -4px 0; }
.action-chip { height: 30px; border-radius: 8px; background: #EAF3FF; border: 1px solid #BFDBFE; padding: 0 10px; margin: 0 4px 8px; align-items: center; justify-content: center; }
.action-chip.muted { background: #F8FAFC; border-color: #E5E7EB; }
.action-chip.danger { background: #FEF2F2; border-color: #FECACA; }
.action-chip-text { font-size: 12px; color: #086CEA; font-weight: 900; }
.action-chip-text.muted { color: #64748B; }
.action-chip-text.danger { color: #DC2626; }
.rename-panel { background: #F8FBFF; border: 1px solid #D7E8FF; border-radius: 8px; padding: 10px; margin-top: 2px; }
.rename-input { height: 38px; border-radius: 8px; background: #fff; border: 1px solid #E5E7EB; padding: 0 11px; font-size: 13px; color: #111827; }
.rename-actions { flex-direction: row; align-items: center; justify-content: flex-end; margin-top: 9px; }
.rename-cancel, .rename-save { height: 32px; border-radius: 8px; align-items: center; justify-content: center; padding: 0 13px; margin-left: 8px; }
.rename-cancel { background: #F8FAFC; border: 1px solid #E5E7EB; }
.rename-save { background: #086CEA; }
.rename-cancel-text { font-size: 12px; color: #64748B; font-weight: 900; }
.rename-save-text { font-size: 12px; color: #fff; font-weight: 900; }
.msg-row { margin-bottom: 10px; align-items: flex-start; }
.msg-row.mine { align-items: flex-end; }
.msg-bubble { max-width: 78%; background: #fff; border: 1px solid #EEF0F4; border-radius: 8px; padding: 10px 11px; }
.msg-bubble.mine { background: #086CEA; border-color: #086CEA; }
.msg-name { font-size: 11px; color: #9CA3AF; font-weight: 900; }
.msg-content { margin-top: 4px; font-size: 14px; color: #111827; line-height: 1.55; }
.msg-meta-line { flex-direction: row; align-items: center; margin-top: 6px; }
.msg-time { font-size: 10px; color: #9CA3AF; }
.msg-status { margin-left: 7px; font-size: 10px; color: rgba(255, 255, 255, .82); font-weight: 800; }
.msg-status.failed { color: #FEE2E2; text-decoration: underline; }
.msg-bubble:not(.mine) .msg-status { color: #64748B; }
.msg-bubble:not(.mine) .msg-status.failed { color: #DC2626; }
.msg-read-receipt { margin-left: 7px; font-size: 10px; color: rgba(255, 255, 255, .82); font-weight: 900; }
.msg-read-receipt.unread { color: rgba(255, 255, 255, .66); }
.msg-bubble:not(.mine) .msg-read-receipt { color: #64748B; }
.msg-bubble.mine .msg-name, .msg-bubble.mine .msg-content, .msg-bubble.mine .msg-time { color: #fff; }
.empty-chat { padding: 20px; align-items: center; }
.empty-chat-text { font-size: 13px; color: #9CA3AF; }
.state-card { align-items: center; background: #fff; border: 1px solid #EEF0F4; border-radius: 8px; padding: 28px 18px; }
.loading-dots { flex-direction: row; margin-bottom: 12px; }
.loading-dot { width: 7px; height: 7px; border-radius: 4px; background: #086CEA; margin: 0 4px; animation: chatDot 1s ease-in-out infinite; }
.loading-dot-b { animation-delay: .14s; }
.loading-dot-c { animation-delay: .28s; }
.state-title { font-size: 16px; color: #111827; font-weight: 900; }
.state-sub { margin-top: 8px; font-size: 12px; color: #6B7280; line-height: 1.6; text-align: center; }
.bottom-anchor { height: 12px; }
.composer { flex-direction: row; align-items: center; padding: 10px 12px calc(var(--rpt-safe-bottom) + 10px); background: #fff; border-top: 1px solid #EEF0F4; }
.composer-input { flex: 1; height: 40px; border-radius: 8px; background: #F8FAFC; border: 1px solid #E5E7EB; padding: 0 12px; font-size: 14px; color: #111827; }
.send-btn { width: 72px; height: 40px; margin-left: 9px; border-radius: 8px; background: #086CEA; align-items: center; justify-content: center; }
.send-btn.disabled { background: #D1D5DB; }
.send-btn-text { font-size: 13px; color: #fff; font-weight: 900; }
@keyframes chatDot { 0%, 100% { opacity: .3; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-4px); } }
@keyframes syncPulse { 0%, 100% { opacity: .35; transform: scale(.9); } 50% { opacity: 1; transform: scale(1.18); } }

/* ── 桌面端居中限宽会话布局 ≥1024px ── */
@media (min-width: 1024px) {
  .wrap { padding: 16px 24px 18px; }
  .msg-bubble { max-width: 60%; }
}
</style>
