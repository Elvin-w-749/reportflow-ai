<template>
  <view class="page rpt-page">
    <view class="nav">
      <RptBackButton @click="goBack" />
      <text class="nav-title">客户与群监测</text>
      <view class="nav-link" @click="refresh"><text class="nav-link-text">刷新</text></view>
    </view>

    <view v-if="loggedIn" class="tabs-wrap">
      <scroll-view class="tabs" scroll-x>
        <view class="tabs-inner">
          <view v-for="tab in tabs" :key="tab.key" class="tab" :class="{ active: currentTab === tab.key }" @click="currentTab = tab.key">
            <text class="tab-text" :class="{ active: currentTab === tab.key }">{{ tab.label }}</text>
            <text class="tab-count" :class="{ active: currentTab === tab.key }">{{ tab.count }}</text>
          </view>
        </view>
      </scroll-view>
    </view>

    <scroll-view class="scroll-body" scroll-y refresher-enabled :refresher-triggered="refreshing" @refresherrefresh="refresh">
      <view class="wrap rpt-content-max">
        <view class="hero">
          <view class="hero-main">
            <text class="hero-kicker">全量监测</text>
            <text class="hero-title">客户资料与群沟通进度</text>
            <text class="hero-desc">管理员可查看全部客户、上传材料、会话内容和每个三方群的处理状态。</text>
          </view>
          <view class="hero-badge">
            <text class="hero-num">{{ stats.activeGroups || 0 }}</text>
            <text class="hero-label">三方群</text>
          </view>
        </view>

        <view v-if="loading" class="state-card">
          <view class="monitor-loader">
            <view class="monitor-loader-ring"></view>
            <view class="monitor-loader-dot"></view>
          </view>
          <text class="state-title">正在加载监测数据</text>
          <text class="state-sub">同步全局使用量、材料和会话。</text>
        </view>

        <view v-else-if="!loggedIn" class="state-card">
          <text class="state-title">登录后进入监测页</text>
          <text class="state-sub">客户监测页需要管理员账号。</text>
          <view class="state-btn" @click="goLogin"><text class="state-btn-text">去登录</text></view>
        </view>

        <view v-else>
          <view class="stats-grid">
            <view v-for="item in metricItems" :key="item.label" class="metric" @click="openMetric(item)">
              <text class="metric-num">{{ item.value }}</text>
              <text class="metric-label">{{ item.label }}</text>
            </view>
          </view>

          <view v-if="currentTab === 'customers'" class="section">
            <view class="section-head">
              <text class="section-title">客户信息</text>
              <text class="section-note">{{ customerRows.length }} 位</text>
            </view>
            <view v-if="selectedCustomerDoc" class="profile-card">
              <view class="profile-head">
                <view class="avatar profile-avatar"><text class="avatar-text">{{ avatarOf(selectedCustomerDoc.name) }}</text></view>
                <view class="profile-main">
                  <text class="profile-name">{{ selectedCustomerDoc.name || '客户档案' }}</text>
                  <text class="profile-phone">{{ phoneText(selectedCustomerDoc) }}</text>
                </view>
                <view class="profile-score">
                  <text class="profile-score-num">{{ reportScoreText(selectedCustomerDoc.latestReport) }}</text>
                  <text class="profile-score-label">平台分析</text>
                </view>
              </view>
              <view class="profile-lines">
                <text v-for="line in profileSummaryLines(selectedCustomerDoc)" :key="line" class="profile-line">{{ line }}</text>
              </view>
              <view class="profile-actions">
                <view class="mini-action primary" @click.stop="openCustomerMaterials(selectedCustomerDoc)"><text class="mini-action-text primary">查看客户资料</text></view>
                <view v-if="selectedCustomerDoc.contactId" class="mini-action" @click.stop="openChat(selectedCustomerDoc)"><text class="mini-action-text">查看最近会话</text></view>
              </view>
            </view>
            <view v-if="customerRows.length" class="customer-list">
              <view v-for="item in customerRows" :key="item.id" class="customer-card" :class="{ active: selectedCustomerDoc && selectedCustomerDoc.id === item.id }" @click="openCustomer(item)">
                <view class="avatar"><text class="avatar-text">{{ avatarOf(item.name) }}</text></view>
                <view class="customer-main">
                  <view class="conversation-line">
                    <text class="conversation-name">{{ item.name || '客户' }}</text>
                    <text class="status" :class="statusClass(item.status)">{{ item.statusText || statusText(item.status) }}</text>
                  </view>
                  <text class="conversation-meta">{{ phoneText(item) }} · {{ item.institution || '机构待确认' }}</text>
                  <text class="conversation-last">征信 {{ item.reportCount || 0 }} 份 · 资料 {{ item.materialCount || 0 }} 项 · 会话 {{ item.conversationCount || 0 }} 条</text>
                  <view class="customer-actions">
                    <view class="mini-action primary" @click.stop="openCustomerProfile(item)"><text class="mini-action-text primary">查看客户资料</text></view>
                    <view v-if="item.contactId" class="mini-action" @click.stop="openChat(item)"><text class="mini-action-text">会话</text></view>
                  </view>
                </view>
                <RptChevron class="open-arrow" direction="right" />
              </view>
            </view>
            <view v-else class="empty-inline">
              <text class="empty-inline-text">暂无客户记录。</text>
            </view>
          </view>

          <view v-if="currentTab === 'groups'" class="section">
            <view class="section-head">
              <text class="section-title">三方沟通群</text>
              <text class="section-note">{{ groupConversations.length }} 个</text>
            </view>
            <view v-if="groupConversations.length" class="conversation-list">
              <view v-for="item in groupConversations" :key="item.contactId || item.id" class="conversation-card" @click="openChat(item)">
                <view class="conversation-top">
                  <view class="avatar"><text class="avatar-text">{{ avatarOf(item.name) }}</text></view>
                  <view class="conversation-main">
                    <view class="conversation-line">
                      <text class="conversation-name">{{ item.name || '客户' }}</text>
                      <text class="status" :class="progressClass(item)">{{ progressStatus(item) }}</text>
                    </view>
                    <text class="conversation-meta">{{ item.institution || '机构待确认' }} · {{ item.productName || '咨询产品' }}</text>
                  </view>
                </view>
                <view class="progress-grid">
                  <view class="progress-cell">
                    <text class="progress-label">客服</text>
                    <text class="progress-value">{{ item.serviceAssigneeName || '待接单' }}</text>
                  </view>
                  <view class="progress-cell">
                    <text class="progress-label">银行老师</text>
                    <text class="progress-value">{{ item.advisorAssigneeName || '待接单' }}</text>
                  </view>
                  <view class="progress-cell tappable" @click.stop="openContactMaterials(item)">
                    <text class="progress-label">资料</text>
                    <text class="progress-value">{{ materialAccessText(item) }}</text>
                  </view>
                </view>
                <text class="conversation-last">{{ latestMessageText(item) }}</text>
                <view class="conversation-actions">
                  <view class="mini-action primary" @click.stop="openChat(item)"><text class="mini-action-text primary">查看会话</text></view>
                  <view class="mini-action" @click.stop="openContactMaterials(item)"><text class="mini-action-text">客户资料</text></view>
                </view>
              </view>
            </view>
            <view v-else class="empty-inline">
              <text class="empty-inline-text">暂无三方沟通群。</text>
            </view>
          </view>

          <view v-if="currentTab === 'franchise'" class="section">
            <view class="section-head">
              <text class="section-title">加盟商报告权限</text>
              <text class="section-note">{{ franchiseReportUsers.length }} 个</text>
            </view>
            <view v-if="canManageAdmins" class="franchise-panel">
              <text class="franchise-title">开通后，该手机号验证码登录后可不限份数上传征信报告。</text>
              <view class="franchise-input-row">
                <input v-model="franchiseForm.phone" class="franchise-input" type="number" maxlength="11" placeholder="加盟商手机号" />
              </view>
              <view class="franchise-input-row double">
                <input v-model="franchiseForm.nickname" class="franchise-input half" maxlength="20" placeholder="名称/备注" />
                <input v-model="franchiseForm.institution" class="franchise-input half" maxlength="40" placeholder="机构/来源" />
              </view>
              <view class="franchise-submit" @click="submitFranchiseGrant"><text class="franchise-submit-text">开通不限上传</text></view>
            </view>
            <view v-else class="empty-inline">
              <text class="empty-inline-text">只有总管理员可以开通或撤回加盟商报告权限。</text>
            </view>
            <view v-if="franchiseReportUsers.length" class="franchise-list">
              <view v-for="item in franchiseReportUsers" :key="item.phone || item.uid" class="franchise-row">
                <view class="franchise-main">
                  <text class="franchise-name">{{ item.nickname || '加盟商账号' }}</text>
                  <text class="franchise-meta">{{ item.phone }} · 不限报告份数{{ item.institution ? ' · ' + item.institution : '' }}</text>
                </view>
                <view v-if="canManageAdmins" class="franchise-revoke" @click="revokeFranchiseGrant(item)"><text class="franchise-revoke-text">撤回</text></view>
              </view>
            </view>
            <view v-else class="empty-inline">
              <text class="empty-inline-text">暂无加盟商报告权限。</text>
            </view>
          </view>

          <view v-if="currentTab === 'materials'" class="section">
            <view class="section-head">
              <text class="section-title">上传资料</text>
              <text class="section-note" @click="clearMaterialFilter">{{ materialFilterText }}</text>
            </view>
            <view v-if="visibleMaterials.length" class="material-list">
              <view v-for="item in visibleMaterials" :key="materialKey(item)" class="material-row" @click="openMaterial(item)">
                <view class="material-main">
                  <text class="material-name">{{ item.name || item.materialName || '补充材料' }}</text>
                  <text class="material-meta">{{ materialMeta(item) }}</text>
                </view>
                <text class="material-status">{{ item.statusText || '待确认' }}</text>
                <RptChevron class="open-arrow" direction="right" />
              </view>
            </view>
            <view v-else class="empty-inline">
              <text class="empty-inline-text">暂无上传资料。</text>
            </view>
          </view>

          <view v-if="currentTab === 'conversations'" class="section">
            <view class="section-head">
              <text class="section-title">全部会话</text>
              <text class="section-note">{{ conversations.length }} 条</text>
            </view>
            <view v-if="conversations.length" class="conversation-list">
              <view v-for="item in conversations" :key="item.contactId || item.id" class="conversation-card" @click="openChat(item)">
                <view class="conversation-top">
                  <view class="avatar"><text class="avatar-text">{{ avatarOf(item.name) }}</text></view>
                  <view class="conversation-main">
                    <view class="conversation-line">
                      <text class="conversation-name">{{ item.name || '客户' }}</text>
                      <text class="status" :class="statusClass(item.status)">{{ item.statusText || statusText(item.status) }}</text>
                    </view>
                    <text class="conversation-meta">{{ channelText(item) }} · {{ item.institution || item.productName || '平台客服' }}</text>
                  </view>
                </view>
                <text class="conversation-last">{{ latestMessageText(item) }}</text>
                <view class="conversation-actions">
                  <view class="mini-action primary" @click.stop="openChat(item)"><text class="mini-action-text primary">查看会话</text></view>
                  <view class="mini-action" @click.stop="openContactMaterials(item)"><text class="mini-action-text">客户资料</text></view>
                </view>
              </view>
            </view>
            <view v-else class="empty-inline">
              <text class="empty-inline-text">暂无会话记录。</text>
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
import { onLoad, onShow } from '@/compat/web-lifecycle.js'
import { isLoggedIn } from '@/services/authService.js'
import { switchToAdmin } from '@/services/roleService.js'
import { getAdminOverview, getFranchiseReportGrants, grantFranchiseReport, revokeFranchiseReport } from '@/services/adminService.js'
import RptBackButton from '@/components/RptBackButton.vue'
import RptChevron from '@/components/RptChevron.vue'
import safeBack from '@/utils/safeBack.js'

const loggedIn = ref(false)
const loading = ref(false)
const refreshing = ref(false)
const currentTab = ref('groups')
const stats = ref({ users: 0, conversations: 0, materials: 0, messages: 0, activeGroups: 0 })
const conversations = ref([])
const materials = ref([])
const customerDocuments = ref([])
const franchiseReportUsers = ref([])
const canManageAdmins = ref(false)
const franchiseForm = ref({ phone: '', nickname: '', institution: '' })
const materialFilterContactId = ref('')
const materialFilterUserId = ref('')
const selectedCustomerId = ref('')

const groupConversations = computed(() => conversations.value.filter((item) => item.groupMode === 'service-bank-customer' || item.serviceRequired))
const customerRows = computed(() => {
  if (customerDocuments.value.length) {
    return customerDocuments.value.map((doc) => {
      const latest = Array.isArray(doc.conversations) && doc.conversations.length
        ? doc.conversations.slice().sort((a, b) => timeValue(b.updateTime || b.updatedAt || b.createdAt) - timeValue(a.updateTime || a.updatedAt || a.createdAt))[0]
        : {}
      return {
        ...doc,
        id: doc.id || doc.userId || doc.name,
        name: doc.name || doc.reportCustomerName || '客户',
        phone: doc.phone || '',
        status: latest.status || doc.status || 'processing',
        statusText: latest.statusText || '',
        institution: latest.institution || '',
        productName: latest.productName || '',
        contactId: latest.contactId || latest.id || '',
        materialCount: Number(doc.materialCount || 0),
        conversationCount: Number(doc.conversationCount || 0),
        reportCount: Number(doc.reportCount || (Array.isArray(doc.reports) ? doc.reports.length : 0) || 0),
        latestReport: doc.latestReport || null,
        latestTs: timeValue(doc.latestTs || latest.updateTime || latest.updatedAt || latest.createdAt)
      }
    }).sort((a, b) => b.latestTs - a.latestTs)
  }
  const map = new Map()
  conversations.value.forEach((item) => {
    const id = String(item.userId || item.clientId || item.name || item.contactId || item.id || '')
    if (!id) return
    const existing = map.get(id) || {
      id,
      name: item.name || item.clientName || '客户',
      status: item.status || 'processing',
      statusText: item.statusText || '',
      institution: item.institution || '',
      productName: item.productName || '',
      contactId: item.contactId || item.id || '',
      materialCount: 0,
      conversationCount: 0,
      latestTs: 0
    }
    const ts = timeValue(item.updateTime || item.updatedAt || item.latestTime || item.createdAt || item.createTime || item.time)
    existing.conversationCount += 1
    existing.materialCount += materialCountOf(item)
    if (ts >= existing.latestTs) {
      existing.latestTs = ts
      existing.status = item.status || existing.status
      existing.statusText = item.statusText || existing.statusText
      existing.institution = item.institution || existing.institution
      existing.productName = item.productName || existing.productName
      existing.contactId = item.contactId || item.id || existing.contactId
    }
    map.set(id, existing)
  })
  return Array.from(map.values()).sort((a, b) => b.latestTs - a.latestTs)
})
const visibleMaterials = computed(() => {
  if (materialFilterUserId.value) return materials.value.filter((item) => String(item.userId || '') === String(materialFilterUserId.value))
  if (!materialFilterContactId.value) return materials.value
  return materials.value.filter((item) => String(item.contactId || '') === String(materialFilterContactId.value))
})
const tabs = computed(() => [
  { key: 'customers', label: '客户', count: customerRows.value.length },
  { key: 'groups', label: '三方群', count: groupConversations.value.length },
  { key: 'franchise', label: '加盟商', count: franchiseReportUsers.value.length },
  { key: 'materials', label: '客户资料', count: materials.value.length },
  { key: 'conversations', label: '全部会话', count: conversations.value.length }
])
const metricItems = computed(() => [
  { label: '客户', value: stats.value.users || customerRows.value.length || 0, view: 'customers' },
  { label: '资料', value: stats.value.materials || 0, view: 'materials' },
  { label: '消息', value: stats.value.messages || 0, view: 'conversations' },
  { label: '会话', value: stats.value.conversations || 0, view: 'conversations' },
  { label: '加盟', value: stats.value.franchiseReportUsers || franchiseReportUsers.value.length || 0, view: 'franchise' }
])
const selectedCustomerDoc = computed(() => {
  if (!selectedCustomerId.value) return customerRows.value[0] || null
  return customerRows.value.find((item) => String(item.id || item.userId || '') === String(selectedCustomerId.value)) || null
})
const materialFilterText = computed(() => (materialFilterContactId.value || materialFilterUserId.value) ? `${visibleMaterials.value.length} 项 · 清除筛选` : `${materials.value.length} 项`)

const load = async (opts = {}) => {
  loggedIn.value = isLoggedIn()
  if (!loggedIn.value) return
  if (!opts.silent) loading.value = true
  try {
    const switched = await switchToAdmin()
    if (!switched.ok) throw new Error(switched.errMsg || '管理员端暂未开通')
    const data = await getAdminOverview()
    stats.value = data.stats || stats.value
    conversations.value = Array.isArray(data.conversations) ? data.conversations : []
    materials.value = Array.isArray(data.materials) ? data.materials : []
    customerDocuments.value = Array.isArray(data.customerDocuments) ? data.customerDocuments : []
    franchiseReportUsers.value = Array.isArray(data.franchiseReportUsers) ? data.franchiseReportUsers : []
    canManageAdmins.value = !!(data.currentAdmin && data.currentAdmin.canManageAdmins)
    await loadFranchiseGrants()
    if (!selectedCustomerId.value && customerRows.value[0]) selectedCustomerId.value = customerRows.value[0].id || customerRows.value[0].userId || ''
  } catch (e) {
    conversations.value = []
    materials.value = []
    customerDocuments.value = []
    uni.showToast({ title: e && e.message ? e.message : '监测数据加载失败', icon: 'none' })
  } finally {
    if (!opts.silent) loading.value = false
  }
}

const loadFranchiseGrants = async () => {
  try {
    const data = await getFranchiseReportGrants()
    canManageAdmins.value = !!(data.currentAdmin && data.currentAdmin.canManageAdmins)
    franchiseReportUsers.value = Array.isArray(data.list) ? data.list : franchiseReportUsers.value
  } catch (_) {}
}

const refresh = async () => {
  refreshing.value = true
  await load({ silent: true })
  refreshing.value = false
}

const normalizedStatus = (status) => {
  const raw = String(status || '')
  if (['completed', 'done', 'resolved'].includes(raw)) return 'completed'
  if (['pending', 'new', 'todo'].includes(raw)) return 'pending'
  return 'processing'
}
const statusText = (status) => ({ pending: '待处理', processing: '处理中', completed: '已完成' }[normalizedStatus(status)] || '处理中')
const statusClass = (status) => normalizedStatus(status)
const progressStatus = (item = {}) => {
  if (item.serviceAssigneeId && item.advisorAssigneeId) return '双端已接入'
  if (item.serviceAssigneeId || item.advisorAssigneeId) return '部分接入'
  return '待接单'
}
const progressClass = (item = {}) => {
  if (item.serviceAssigneeId && item.advisorAssigneeId) return 'completed'
  if (item.serviceAssigneeId || item.advisorAssigneeId) return 'processing'
  return 'pending'
}
const avatarOf = (name) => String(name || '客').slice(0, 1)
const channelText = (item = {}) => item.channel === 'service' || item.contactType === 'customer-service' ? '客服咨询' : item.serviceRequired ? '三方产品咨询' : '产品咨询'
const latestMessageText = (item = {}) => {
  const msg = Array.isArray(item.messages) && item.messages.length ? item.messages[item.messages.length - 1] : null
  return (msg && msg.content) || item.summary || '暂无最新消息。'
}
const materialAttachmentsOf = (item = {}) => {
  const attachments = Array.isArray(item.attachments) ? item.attachments : []
  if (attachments.length) return attachments
  if (item.fileUrl || item.uploadUrl || item.url || item.localFilePath || item.fileName) return [item]
  return []
}
const materialUrlsOf = (item = {}) => materialAttachmentsOf(item)
  .map((file) => file.fileUrl || file.uploadUrl || file.url || file.localFilePath || '')
  .filter(Boolean)
const materialUrlOf = (item = {}) => materialUrlsOf(item)[0] || ''
const materialKey = (item = {}) => [item.contactId || '', item.id || item.materialId || item.key || '', item.name || item.materialName || '', materialUrlOf(item)].join('|')
const timeValue = (value) => {
  if (!value) return 0
  const ts = new Date(value).getTime()
  return Number.isFinite(ts) ? ts : 0
}
const materialCountOf = (item = {}) => Number(item.materialCount || item.attachmentCount || (Array.isArray(item.attachments) ? item.attachments.length : 0) || (Array.isArray(item.materials) ? item.materials.length : 0) || 0)
const materialMeta = (item = {}) => {
  const base = [item.customerName, item.institution, item.productName].filter(Boolean).join(' · ') || '客户资料'
  const count = materialAttachmentsOf(item).length
  const file = item.fileName || item.nameOnDisk || item.uploadName || ''
  const countText = count > 1 ? `${count}份附件` : ''
  return [base, countText, file].filter(Boolean).join(' · ')
}
const materialAccessText = (item = {}) => {
  const count = materialCountOf(item)
  if (count) return `${count} 项`
  if (item.materialAccessText) return item.materialAccessText
  return '暂无'
}
const openMetric = (item = {}) => {
  if (item.view) currentTab.value = item.view
  if (item.view !== 'materials') clearMaterialFilter()
}
const submitFranchiseGrant = async () => {
  const phone = String(franchiseForm.value.phone || '').trim()
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    uni.showToast({ title: '请输入正确手机号', icon: 'none' })
    return
  }
  try {
    const data = await grantFranchiseReport({
      phone,
      nickname: franchiseForm.value.nickname,
      institution: franchiseForm.value.institution
    })
    franchiseReportUsers.value = Array.isArray(data.list) ? data.list : franchiseReportUsers.value
    franchiseForm.value = { phone: '', nickname: '', institution: '' }
    uni.showToast({ title: '已开通加盟商权限', icon: 'none' })
  } catch (e) {
    uni.showToast({ title: e && e.message ? e.message : '开通失败', icon: 'none' })
  }
}
const revokeFranchiseGrant = (item = {}) => {
  if (!item.phone) return
  uni.showModal({
    title: '撤回加盟商权限',
    content: `确认撤回 ${item.phone} 的不限上传权限？`,
    confirmText: '撤回',
    confirmColor: '#DC2626',
    success: async (res) => {
      if (!res.confirm) return
      try {
        const data = await revokeFranchiseReport(item.phone)
        franchiseReportUsers.value = Array.isArray(data.list) ? data.list : franchiseReportUsers.value.filter((row) => row.phone !== item.phone)
        uni.showToast({ title: '已撤回', icon: 'none' })
      } catch (e) {
        uni.showToast({ title: e && e.message ? e.message : '撤回失败', icon: 'none' })
      }
    }
  })
}
const openChat = (item) => {
  const id = item.contactId || item.id
  if (id) uni.navigateTo({ url: `/pages/chat/conversation?contactId=${encodeURIComponent(id)}` })
}
const openCustomer = (item = {}) => {
  openCustomerProfile(item)
}
const clearMaterialFilter = () => {
  materialFilterContactId.value = ''
  materialFilterUserId.value = ''
}
const openContactMaterials = (item = {}) => {
  const id = item.contactId || item.id
  materialFilterContactId.value = id || ''
  materialFilterUserId.value = ''
  currentTab.value = 'materials'
  if (id && !materials.value.some((m) => String(m.contactId || '') === String(id))) {
    uni.showToast({ title: '该客户暂无可打开资料', icon: 'none' })
  }
}
const openCustomerProfile = (item = {}) => {
  selectedCustomerId.value = item.id || item.userId || ''
}
const openCustomerMaterials = (item = {}) => {
  const userId = item.userId || ''
  materialFilterUserId.value = userId
  materialFilterContactId.value = ''
  currentTab.value = 'materials'
  if (userId && !materials.value.some((m) => String(m.userId || '') === String(userId))) {
    uni.showToast({ title: '该客户暂无可打开资料', icon: 'none' })
  }
}
const reportScoreText = (report = {}) => {
  const score = Number(report && report.score)
  return Number.isFinite(score) && score > 0 ? `${score} 分` : '暂无评分'
}
const reportRiskText = (report = {}) => report.riskText || report.riskLevel || '待分析'
const phoneText = (item = {}) => item.phone ? `手机号 ${item.phone}` : '手机号待留档'
const profileSummaryLines = (item = {}) => {
  const report = item.latestReport || {}
  return [
    `征信报告 ${item.reportCount || 0} 份`,
    `上传资料 ${item.materialCount || 0} 项`,
    `会话记录 ${item.conversationCount || 0} 条`,
    `平台分析 ${reportScoreText(report)} · ${reportRiskText(report)}`
  ]
}
const copyMaterialUrl = (url) => {
  if (!url) return
  if (typeof uni.setClipboardData === 'function') {
    uni.setClipboardData({ data: url, success: () => uni.showToast({ title: '资料链接已复制', icon: 'none' }) })
    return
  }
  uni.showToast({ title: '资料链接无法直接打开', icon: 'none' })
}
const openUrl = (url) => {
  const lower = String(url || '').toLowerCase()
  if (!url) return false
  if (typeof uni.previewImage === 'function' && /\.(png|jpe?g|webp|gif|bmp)(\?|#|$)/i.test(lower)) {
    uni.previewImage({ urls: [url], current: url, fail: () => copyMaterialUrl(url) })
    return true
  }
  if (typeof window !== 'undefined' && typeof window.open === 'function') {
    window.open(url, '_blank')
    return true
  }
  if (typeof uni.downloadFile === 'function' && typeof uni.openDocument === 'function') {
    uni.downloadFile({
      url,
      success: (res) => uni.openDocument({ filePath: res.tempFilePath || url, fail: () => copyMaterialUrl(url) }),
      fail: () => copyMaterialUrl(url)
    })
    return true
  }
  copyMaterialUrl(url)
  return true
}
const openMaterial = (item = {}) => {
  const urls = materialUrlsOf(item)
  const imageUrls = urls.filter((url) => /\.(png|jpe?g|webp|gif|bmp)(\?|#|$)/i.test(String(url || '').toLowerCase()))
  if (imageUrls.length && typeof uni.previewImage === 'function') {
    uni.previewImage({ urls: imageUrls, current: imageUrls[0], fail: () => openUrl(imageUrls[0]) })
    return
  }
  if (urls[0] && openUrl(urls[0])) return
  if (item.contactId) {
    openChat(item)
    return
  }
  uni.showToast({ title: '暂无可打开资料', icon: 'none' })
}
const goBack = () => safeBack('/pages/admin/workbench')
const goLogin = () => uni.navigateTo({ url: '/pages/login/index' })

onLoad((query = {}) => {
  if (['customers', 'groups', 'franchise', 'materials', 'conversations'].includes(query.view)) currentTab.value = query.view
})
onShow(() => load())
</script>

<style scoped>
.page { min-height: 100vh; background: #F5F6FA; }
.nav { flex-direction: row; align-items: center; padding: calc(var(--rpt-safe-top) + 8px) 14px 8px; background: #fff; border-bottom: 1px solid #EEF0F4; }
.nav-title { flex: 1; text-align: center; font-size: 16px; color: #111827; font-weight: 900; }
.nav-link { width: 42px; align-items: flex-end; }
.nav-link-text { font-size: 12px; color: #086CEA; font-weight: 900; }
.tabs-wrap { background: #fff; border-bottom: 1px solid #EEF0F4; padding: 10px 16px; }
.tabs { white-space: nowrap; }
.tabs-inner { flex-direction: row; }
.tab { height: 34px; padding: 0 12px; border-radius: 8px; background: #F8FAFC; border: 1px solid #E5E7EB; flex-direction: row; align-items: center; margin-right: 8px; }
.tab.active { background: #EAF3FF; border-color: #BFDBFE; }
.tab-text { font-size: 13px; color: #4B5563; font-weight: 900; }
.tab-text.active { color: #086CEA; }
.tab-count { margin-left: 5px; font-size: 11px; color: #9CA3AF; font-weight: 800; }
.tab-count.active { color: #086CEA; }
.scroll-body { flex: 1; height: calc(100vh - 112px); }
.wrap { padding: 14px 16px 18px; }
.hero { flex-direction: row; align-items: center; background: #fff; border: 1px solid #EEF0F4; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
.hero-main { flex: 1; margin-right: 12px; }
.hero-kicker { font-size: 12px; color: #1D4ED8; font-weight: 900; }
.hero-title { margin-top: 5px; font-size: 19px; color: #111827; font-weight: 900; }
.hero-desc { margin-top: 6px; font-size: 12px; color: #6B7280; line-height: 1.5; }
.hero-badge { width: 72px; height: 72px; border-radius: 8px; background: #EFF6FF; border: 1px solid #BFDBFE; align-items: center; justify-content: center; }
.hero-num { font-size: 24px; color: #086CEA; font-weight: 900; }
.hero-label { margin-top: 2px; font-size: 11px; color: #1D4ED8; font-weight: 900; }
.stats-grid { flex-direction: row; margin-bottom: 12px; }
.metric { flex: 1; background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; padding: 14px 4px; align-items: center; margin-right: 8px; }
.metric:last-child { margin-right: 0; }
.metric-num { font-size: 21px; color: #111827; font-weight: 900; }
.metric-label { margin-top: 5px; font-size: 11px; color: #6B7280; font-weight: 800; }
.section { margin-top: 12px; background: #fff; border: 1px solid #EEF0F4; border-radius: 8px; padding: 15px; }
.section-head { flex-direction: row; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.section-title { font-size: 16px; color: #111827; font-weight: 900; }
.section-note { font-size: 12px; color: #9CA3AF; font-weight: 800; }
.customer-card { flex-direction: row; align-items: center; border-top: 1px solid #F3F4F6; padding: 12px 0; }
.customer-card:first-child { border-top-width: 0; }
.customer-card.active { background: #F8FBFF; margin-left: -8px; margin-right: -8px; padding-left: 8px; padding-right: 8px; border-radius: 8px; border-top-color: transparent; }
.customer-main { flex: 1; min-width: 0; }
.customer-actions { flex-direction: row; margin-top: 9px; }
.open-arrow { width: 20px; height: 20px; display: flex; flex: 0 0 20px; align-items: center; justify-content: center; padding: 0; box-sizing: border-box; color: #CBD5E1; margin-left: 8px; }
.profile-card { background: #F8FBFF; border: 1px solid #D7E8FF; border-radius: 8px; padding: 13px; margin-bottom: 8px; }
.profile-head { flex-direction: row; align-items: center; }
.profile-avatar { background: #EAF3FF; border-color: #BFDBFE; }
.profile-main { flex: 1; min-width: 0; }
.profile-name { font-size: 15px; color: #111827; font-weight: 900; }
.profile-phone { margin-top: 4px; font-size: 12px; color: #64748B; font-weight: 800; }
.profile-score { align-items: flex-end; margin-left: 10px; }
.profile-score-num { font-size: 14px; color: #086CEA; font-weight: 900; }
.profile-score-label { margin-top: 3px; font-size: 10px; color: #64748B; font-weight: 900; }
.profile-lines { margin-top: 10px; background: #fff; border-radius: 8px; padding: 9px 10px; }
.profile-line { font-size: 12px; color: #334155; font-weight: 800; line-height: 1.75; }
.profile-actions { flex-direction: row; margin-top: 10px; }
.conversation-card { border-top: 1px solid #F3F4F6; padding: 12px 0; }
.conversation-card:first-child { border-top-width: 0; }
.conversation-top { flex-direction: row; align-items: center; }
.avatar { width: 40px; height: 40px; border-radius: 20px; background: #F8FAFC; border: 1px solid #E5E7EB; align-items: center; justify-content: center; margin-right: 11px; }
.avatar-text { font-size: 14px; color: #475569; font-weight: 900; }
.conversation-main { flex: 1; }
.conversation-line { flex-direction: row; align-items: center; }
.conversation-name { flex: 1; font-size: 14px; color: #111827; font-weight: 900; }
.conversation-meta { margin-top: 4px; font-size: 12px; color: #6B7280; }
.conversation-last { margin-top: 8px; font-size: 12px; color: #374151; line-height: 1.5; }
.progress-grid { flex-direction: row; margin-top: 11px; background: #F8FAFC; border-radius: 8px; padding: 10px 6px; }
.progress-cell { flex: 1; align-items: center; padding: 0 4px; }
.progress-cell.tappable { border-radius: 8px; background: #EFF6FF; }
.progress-label { font-size: 10px; color: #94A3B8; font-weight: 900; }
.progress-value { margin-top: 4px; font-size: 11px; color: #334155; font-weight: 900; text-align: center; }
.conversation-actions { flex-direction: row; margin-top: 10px; }
.mini-action { height: 30px; border-radius: 8px; border: 1px solid #D7E8FF; background: #F8FBFF; align-items: center; justify-content: center; padding: 0 12px; margin-right: 8px; }
.mini-action.primary { background: #086CEA; border-color: #086CEA; }
.mini-action-text { font-size: 12px; color: #086CEA; font-weight: 900; }
.mini-action-text.primary { color: #FFFFFF; }
.franchise-panel { background: #F8FBFF; border: 1px solid #D7E8FF; border-radius: 8px; padding: 12px; margin-bottom: 10px; }
.franchise-title { font-size: 12px; color: #334155; font-weight: 800; line-height: 1.55; margin-bottom: 10px; }
.franchise-input-row { flex-direction: row; align-items: center; margin-top: 9px; }
.franchise-input-row.double { gap: 8px; }
.franchise-input { flex: 1; height: 38px; border-radius: 8px; background: #fff; border: 1px solid #E5E7EB; padding: 0 11px; font-size: 13px; color: #111827; font-weight: 800; }
.franchise-input.half { width: 50%; }
.franchise-submit { height: 40px; border-radius: 8px; background: #086CEA; align-items: center; justify-content: center; margin-top: 10px; }
.franchise-submit-text { color: #fff; font-size: 13px; font-weight: 900; }
.franchise-list { border-top: 1px solid #F3F4F6; }
.franchise-row { flex-direction: row; align-items: center; padding: 12px 0; border-bottom: 1px solid #F3F4F6; }
.franchise-main { flex: 1; min-width: 0; margin-right: 10px; }
.franchise-name { font-size: 13px; color: #111827; font-weight: 900; }
.franchise-meta { margin-top: 4px; font-size: 11px; color: #64748B; line-height: 1.45; }
.franchise-revoke { height: 30px; border-radius: 8px; border: 1px solid #FECACA; background: #FEF2F2; align-items: center; justify-content: center; padding: 0 10px; }
.franchise-revoke-text { font-size: 11px; color: #DC2626; font-weight: 900; }
.material-row { flex-direction: row; align-items: center; padding: 11px 0; border-top: 1px solid #F3F4F6; }
.material-row:first-child { border-top-width: 0; }
.material-main { flex: 1; margin-right: 10px; }
.material-name { font-size: 13px; color: #111827; font-weight: 900; }
.material-meta { margin-top: 4px; font-size: 11px; color: #6B7280; line-height: 1.5; }
.material-status { min-width: 54px; text-align: center; padding: 4px 7px; border-radius: 8px; font-size: 11px; font-weight: 900; color: #1D4ED8; background: #EFF6FF; }
.status { font-size: 11px; font-weight: 900; padding: 4px 7px; border-radius: 8px; overflow: hidden; }
.status.pending { color: #086CEA; background: #EAF3FF; }
.status.processing { color: #1D4ED8; background: #EFF6FF; }
.status.completed { color: #15803D; background: #F0FDF4; }
.state-card { align-items: center; background: #fff; border: 1px solid #EEF0F4; border-radius: 8px; padding: 32px 20px; }
.monitor-loader { position: relative; width: 42px; height: 42px; margin-bottom: 14px; align-items: center; justify-content: center; }
.monitor-loader-ring { position: absolute; width: 42px; height: 42px; border-radius: 21px; border: 3px solid #EAF3FF; border-top-color: #086CEA; animation: adminSpin 1s linear infinite; }
.monitor-loader-dot { width: 8px; height: 8px; border-radius: 4px; background: #086CEA; animation: adminPulse 1s ease-in-out infinite; }
.state-title { font-size: 17px; color: #111827; font-weight: 900; }
.state-sub { margin-top: 8px; font-size: 13px; color: #6B7280; line-height: 1.7; text-align: center; }
.state-btn { margin-top: 18px; min-width: 120px; height: 42px; border-radius: 8px; background: #086CEA; align-items: center; justify-content: center; padding: 0 16px; }
.state-btn-text { color: #fff; font-size: 14px; font-weight: 900; }
.empty-inline { background: #F8FAFC; border-radius: 8px; padding: 14px; }
.empty-inline-text { font-size: 12px; color: #9CA3AF; line-height: 1.6; text-align: center; }
.bottom-safe { height: 36px; }
@media (min-width: 1024px) {
  .customer-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr)); gap: 12px; }
  .stats-grid { flex-wrap: wrap; }
}
@keyframes adminSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes adminPulse { 0%, 100% { opacity: .45; transform: scale(.8); } 50% { opacity: 1; transform: scale(1.25); } }
</style>
