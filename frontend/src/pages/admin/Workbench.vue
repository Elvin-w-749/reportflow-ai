<template>
  <view class="page rpt-page">
    <view class="nav">
      <RptBackButton @click="goBack" />
      <text class="nav-title">管理员端</text>
      <view class="nav-link" @click="refresh"><text class="nav-link-text">刷新</text></view>
    </view>

    <scroll-view class="scroll-body" scroll-y refresher-enabled :refresher-triggered="refreshing" @refresherrefresh="refresh">
      <view class="wrap rpt-content-max">
        <view class="hero">
          <view class="hero-main">
            <text class="hero-kicker">平台总控</text>
            <text class="hero-title">管理员功能台</text>
            <text class="hero-desc">统一进入客户、产品、客服、银行老师和运营监测能力。</text>
          </view>
          <view class="hero-badge" @click="goMonitor">
            <text class="hero-num">{{ stats.conversations || 0 }}</text>
            <text class="hero-label">全量会话</text>
          </view>
        </view>

        <view v-if="loading" class="state-card">
          <text class="state-title">正在加载管理员端</text>
          <text class="state-sub">同步使用量、材料和群聊进度。</text>
        </view>

        <view v-else-if="!loggedIn" class="state-card">
          <text class="state-title">登录后进入管理员端</text>
          <text class="state-sub">管理员端需要平台授权账号。</text>
          <view class="state-btn" @click="goLogin"><text class="state-btn-text">去登录</text></view>
        </view>

        <view v-else>
          <view class="stats-grid">
            <view v-for="item in metricItems" :key="item.label" class="metric">
              <text class="metric-num">{{ item.value }}</text>
              <text class="metric-label">{{ item.label }}</text>
            </view>
          </view>

          <view class="section">
            <view class="section-head">
              <text class="section-title">权限备案</text>
              <text class="section-note">{{ canManageAdmins ? '总管理员' : '普通管理员' }}</text>
            </view>
            <view v-if="canManageAdmins" class="grant-panel">
              <view class="grant-input-row">
                <input v-model="grantForm.phone" class="grant-input" type="number" maxlength="11" placeholder="输入手机号备案权限" />
              </view>
              <view class="role-chips">
                <view v-for="role in grantRoles" :key="role.value" class="role-chip" :class="{ active: grantForm.role === role.value }" @click="grantForm.role = role.value">
                  <text class="role-chip-text" :class="{ active: grantForm.role === role.value }">{{ role.label }}</text>
                </view>
              </view>
              <view class="grant-input-row double">
                <input v-model="grantForm.nickname" class="grant-input half" maxlength="20" placeholder="名称/备注" />
                <input v-model="grantForm.institution" class="grant-input half" maxlength="40" placeholder="机构/银行" />
              </view>
              <view class="grant-submit" @click="submitGrant"><text class="grant-submit-text">保存备案</text></view>
            </view>
            <view v-else class="grant-limited">
              <text class="grant-limited-title">当前账号可查看客户档案、会话和材料。</text>
              <text class="grant-limited-sub">授权新管理员、撤回权限等操作仅总管理员可用。</text>
            </view>
            <view v-if="roleGrants.length" class="grant-list">
              <view v-for="item in roleGrants" :key="item.phone || item.uid" class="grant-row">
                <view class="grant-user">
                  <text class="grant-name">{{ item.nickname || roleLabel(item.role) }}</text>
                  <text class="grant-meta">{{ item.phone }} · {{ roleLabel(item.role) }}{{ item.institution ? ' · ' + item.institution : '' }}</text>
                </view>
                <view v-if="item.isSuperAdmin" class="grant-tag super"><text class="grant-tag-text super">总账号</text></view>
                <view v-else-if="canManageAdmins" class="grant-tag" @click="revokeGrant(item)"><text class="grant-tag-text">撤回</text></view>
              </view>
            </view>
          </view>

          <view class="section">
            <view class="section-head">
              <text class="section-title">端口入口</text>
              <text class="section-note">管理员可看全局</text>
            </view>
            <view class="portal-grid">
              <view v-for="item in portalItems" :key="item.title" class="portal-card" @click="openPortal(item)">
                <view class="portal-icon" :class="'portal-icon-' + item.tone">
                  <text class="portal-icon-text">{{ item.icon }}</text>
                </view>
                <view class="portal-main">
                  <text class="portal-title">{{ item.title }}</text>
                  <text class="portal-desc">{{ item.desc }}</text>
                </view>
                <RptChevron class="portal-arrow" direction="right" />
              </view>
            </view>
          </view>

          <view class="section">
            <view class="section-head">
              <text class="section-title">群进度快照</text>
              <text class="section-more" @click="goMonitor">进入监测页</text>
            </view>
            <view v-if="groupSnapshots.length" class="snapshot-list">
              <view v-for="item in groupSnapshots" :key="item.contactId || item.id" class="snapshot-row" @click="openChat(item)">
                <view class="snapshot-main">
                  <text class="snapshot-title">{{ item.institution || '机构' }} · {{ item.productName || '咨询产品' }}</text>
                  <text class="snapshot-sub">{{ item.name || '客户' }} · {{ progressText(item) }}</text>
                </view>
                <text class="snapshot-status" :class="progressClass(item)">{{ statusText(item.status) }}</text>
              </view>
            </view>
            <view v-else class="empty-inline">
              <text class="empty-inline-text">暂无三方沟通群。</text>
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
import { onShow } from '@/compat/web-lifecycle.js'
import { isLoggedIn } from '@/services/authService.js'
import { switchToAdmin } from '@/services/roleService.js'
import { getAdminOverview, getAdminRoleGrants, grantAdminRole, revokeAdminRole } from '@/services/adminService.js'
import RptBackButton from '@/components/RptBackButton.vue'
import RptChevron from '@/components/RptChevron.vue'
import safeBack from '@/utils/safeBack.js'

const loggedIn = ref(false)
const loading = ref(false)
const refreshing = ref(false)
const stats = ref({ users: 0, conversations: 0, materials: 0, messages: 0, activeGroups: 0 })
const conversations = ref([])
const canManageAdmins = ref(false)
const roleGrants = ref([])
const grantForm = ref({ phone: '', role: 'admin', nickname: '', institution: '' })

const grantRoles = [
  { label: '普通管理员', value: 'admin' },
  { label: '客服', value: 'service' },
  { label: '银行老师', value: 'advisor' },
  { label: '监测账号', value: 'monitor' }
]

const metricItems = computed(() => [
  { label: '客户', value: stats.value.users || 0 },
  { label: '资料', value: stats.value.materials || 0 },
  { label: '消息', value: stats.value.messages || 0 },
  { label: '三方群', value: stats.value.activeGroups || 0 }
])

const portalItems = [
  { icon: '监', title: '运营监测', desc: '客户资料、会话和群进度', url: '/pages/admin/monitor', tone: 'blue' },
  { icon: '客', title: '客户端首页', desc: '查看用户使用入口', url: '/pages/home/home', tone: 'green' },
  { icon: '产', title: '产品匹配', desc: '查看用户产品匹配页', url: '/pages/match/index', tone: 'gold' },
  { icon: '信', title: '上传报告', desc: '信用报告上传链路', url: '/pages/report/upload', tone: 'red' },
  { icon: '群', title: '全部会话', desc: '进入群聊监测列表', url: '/pages/admin/monitor?view=groups', tone: 'blue' },
  { icon: '材', title: '客户资料', desc: '查看上传资料明细', url: '/pages/admin/monitor?view=materials', tone: 'green' }
]

const groupSnapshots = computed(() => conversations.value.filter((item) => item.serviceRequired || item.groupMode === 'service-bank-customer').slice(0, 4))

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
    canManageAdmins.value = !!(data.currentAdmin && data.currentAdmin.canManageAdmins)
    await loadRoleGrants({ silent: true })
  } catch (e) {
    conversations.value = []
    uni.showToast({ title: e && e.message ? e.message : '管理员数据加载失败', icon: 'none' })
  } finally {
    if (!opts.silent) loading.value = false
  }
}

const loadRoleGrants = async () => {
  try {
    const data = await getAdminRoleGrants()
    canManageAdmins.value = !!(data.currentAdmin && data.currentAdmin.canManageAdmins)
    roleGrants.value = Array.isArray(data.list) ? data.list : []
  } catch (_) {
    roleGrants.value = []
  }
}

const refresh = async () => {
  refreshing.value = true
  await load({ silent: true })
  refreshing.value = false
}

const statusText = (status) => {
  const raw = String(status || '')
  if (['completed', 'done', 'resolved'].includes(raw)) return '已完成'
  if (['pending', 'new', 'todo'].includes(raw)) return '待处理'
  return '处理中'
}
const progressText = (item = {}) => {
  const service = item.serviceAssigneeName ? `客服 ${item.serviceAssigneeName}` : '客服待接单'
  const advisor = item.advisorAssigneeName ? `银行 ${item.advisorAssigneeName}` : '银行待接单'
  return `${service} / ${advisor}`
}
const progressClass = (item = {}) => {
  if (item.serviceAssigneeId && item.advisorAssigneeId) return 'done'
  if (item.serviceAssigneeId || item.advisorAssigneeId) return 'processing'
  return 'pending'
}
const openPortal = (item) => {
  if (item && item.url) uni.navigateTo({ url: item.url })
}
const roleLabel = (role) => {
  const found = grantRoles.find((item) => item.value === role)
  if (found) return found.label
  if (role === 'admin') return '普通管理员'
  if (role === 'user') return '客户'
  return '账号'
}
const submitGrant = async () => {
  const phone = String(grantForm.value.phone || '').trim()
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    uni.showToast({ title: '请输入正确手机号', icon: 'none' })
    return
  }
  try {
    const data = await grantAdminRole({
      phone,
      role: grantForm.value.role,
      nickname: grantForm.value.nickname,
      institution: grantForm.value.institution
    })
    roleGrants.value = Array.isArray(data.list) ? data.list : roleGrants.value
    grantForm.value = { phone: '', role: 'admin', nickname: '', institution: '' }
    uni.showToast({ title: '已保存备案', icon: 'none' })
  } catch (e) {
    uni.showToast({ title: e && e.message ? e.message : '备案失败', icon: 'none' })
  }
}
const revokeGrant = (item = {}) => {
  if (!item.phone) return
  uni.showModal({
    title: '撤回权限',
    content: `确认撤回 ${item.phone} 的${roleLabel(item.role)}权限？`,
    confirmText: '撤回',
    confirmColor: '#DC2626',
    success: async (res) => {
      if (!res.confirm) return
      try {
        const data = await revokeAdminRole(item.phone)
        roleGrants.value = Array.isArray(data.list) ? data.list : roleGrants.value.filter((row) => row.phone !== item.phone)
        uni.showToast({ title: '已撤回', icon: 'none' })
      } catch (e) {
        uni.showToast({ title: e && e.message ? e.message : '撤回失败', icon: 'none' })
      }
    }
  })
}
const goMonitor = () => uni.navigateTo({ url: '/pages/admin/monitor' })
const openChat = (item) => {
  const id = item.contactId || item.id
  if (id) uni.navigateTo({ url: `/pages/chat/conversation?contactId=${encodeURIComponent(id)}` })
}
const goBack = () => safeBack('/pages/profile/profile')
const goLogin = () => uni.navigateTo({ url: '/pages/login/index' })

onShow(() => load())
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
.hero-title { margin-top: 5px; font-size: 20px; color: #111827; font-weight: 900; }
.hero-desc { margin-top: 6px; font-size: 12px; color: #6B7280; line-height: 1.5; }
.hero-badge { width: 76px; height: 76px; border-radius: 8px; background: #EFF6FF; border: 1px solid #BFDBFE; align-items: center; justify-content: center; }
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
.section-note, .section-more { font-size: 12px; color: #086CEA; font-weight: 900; }
.grant-panel { background: #F8FBFF; border: 1px solid #D7E8FF; border-radius: 8px; padding: 12px; }
.grant-input-row { flex-direction: row; align-items: center; margin-bottom: 10px; }
.grant-input-row.double { gap: 8px; }
.grant-input { flex: 1; height: 40px; border-radius: 8px; background: #FFFFFF; border: 1px solid #E5E7EB; padding: 0 11px; color: #111827; font-size: 13px; font-weight: 800; }
.grant-input.half { width: 50%; }
.role-chips { flex-direction: row; flex-wrap: wrap; margin-bottom: 10px; }
.role-chip { height: 30px; border-radius: 8px; border: 1px solid #E5E7EB; background: #FFFFFF; align-items: center; justify-content: center; padding: 0 10px; margin-right: 7px; margin-bottom: 7px; }
.role-chip.active { background: #086CEA; border-color: #086CEA; }
.role-chip-text { font-size: 12px; color: #64748B; font-weight: 900; }
.role-chip-text.active { color: #FFFFFF; }
.grant-submit { height: 40px; border-radius: 8px; background: #086CEA; align-items: center; justify-content: center; }
.grant-submit-text { font-size: 14px; color: #FFFFFF; font-weight: 900; }
.grant-limited { background: #F8FAFC; border-radius: 8px; padding: 13px; }
.grant-limited-title { font-size: 13px; color: #111827; font-weight: 900; }
.grant-limited-sub { margin-top: 5px; font-size: 12px; color: #64748B; line-height: 1.5; }
.grant-list { margin-top: 10px; border-top: 1px solid #F3F4F6; }
.grant-row { flex-direction: row; align-items: center; padding: 11px 0; border-bottom: 1px solid #F3F4F6; }
.grant-user { flex: 1; min-width: 0; }
.grant-name { font-size: 13px; color: #111827; font-weight: 900; }
.grant-meta { margin-top: 4px; font-size: 11px; color: #64748B; line-height: 1.45; }
.grant-tag { min-width: 48px; height: 28px; border-radius: 8px; border: 1px solid #FECACA; background: #FEF2F2; align-items: center; justify-content: center; padding: 0 8px; }
.grant-tag.super { border-color: #BFDBFE; background: #EFF6FF; }
.grant-tag-text { font-size: 11px; color: #DC2626; font-weight: 900; }
.grant-tag-text.super { color: #086CEA; }
.portal-card { flex-direction: row; align-items: center; padding: 13px 0; border-top: 1px solid #F3F4F6; }
.portal-card:first-child { border-top-width: 0; }
.portal-icon { width: 38px; height: 38px; border-radius: 8px; align-items: center; justify-content: center; margin-right: 12px; border: 1px solid #DBEAFE; background: #EFF6FF; }
.portal-icon-green { background: #F0FDF4; border-color: #BBF7D0; }
.portal-icon-gold { background: #FFFBEB; border-color: #FDE68A; }
.portal-icon-red { background: #FEF2F2; border-color: #FECACA; }
.portal-icon-text { font-size: 14px; color: #086CEA; font-weight: 900; }
.portal-main { flex: 1; }
.portal-title { font-size: 14px; color: #111827; font-weight: 900; }
.portal-desc { margin-top: 4px; font-size: 12px; color: #6B7280; }
.portal-arrow { width: 22px; height: 22px; display: flex; flex: 0 0 22px; align-items: center; justify-content: center; padding: 0; box-sizing: border-box; color: #C7CBD1; }
.snapshot-row { flex-direction: row; align-items: center; padding: 12px 0; border-top: 1px solid #F3F4F6; }
.snapshot-row:first-child { border-top-width: 0; }
.snapshot-main { flex: 1; margin-right: 10px; }
.snapshot-title { font-size: 13px; color: #111827; font-weight: 900; }
.snapshot-sub { margin-top: 4px; font-size: 11px; color: #6B7280; line-height: 1.45; }
.snapshot-status { font-size: 11px; font-weight: 900; padding: 4px 7px; border-radius: 8px; overflow: hidden; color: #086CEA; background: #EAF3FF; }
.snapshot-status.processing { color: #1D4ED8; background: #EFF6FF; }
.snapshot-status.done { color: #15803D; background: #F0FDF4; }
.state-card { align-items: center; background: #fff; border: 1px solid #EEF0F4; border-radius: 8px; padding: 32px 20px; }
.state-title { font-size: 17px; color: #111827; font-weight: 900; }
.state-sub { margin-top: 8px; font-size: 13px; color: #6B7280; line-height: 1.7; text-align: center; }
.state-btn { margin-top: 18px; min-width: 120px; height: 42px; border-radius: 8px; background: #086CEA; align-items: center; justify-content: center; padding: 0 16px; }
.state-btn-text { color: #fff; font-size: 14px; font-weight: 900; }
.empty-inline { background: #F8FAFC; border-radius: 8px; padding: 14px; }
.empty-inline-text { font-size: 12px; color: #9CA3AF; line-height: 1.6; text-align: center; }
.bottom-safe { height: 36px; }
@media (min-width: 1024px) {
  .stats-grid { flex-wrap: wrap; }
  .portal-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); gap: 12px; }
}
</style>
