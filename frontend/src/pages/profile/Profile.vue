<template>
  <view class="page rpt-page">
    <scroll-view class="scroll-body" scroll-y>
      <view class="wrap rpt-content-max">
        <!-- 用户卡 -->
        <view class="user-card">
          <view class="avatar"><text class="avatar-text">{{ avatarText }}</text></view>
          <view class="user-main">
            <text class="user-name">{{ loggedIn ? displayName : '未登录' }}</text>
            <text class="user-phone">{{ loggedIn ? maskedPhone : '登录后体验完整功能' }}</text>
          </view>
          <view v-if="!loggedIn" class="login-btn" @click="goLogin">
            <text class="login-btn-text">登录</text>
          </view>
        </view>

        <!-- 信用报告管理 -->
        <view v-if="loggedIn" class="report-panel">
          <view class="report-panel-head">
            <view>
              <text class="report-panel-kicker">信用报告管理</text>
              <text class="report-panel-title">{{ reportPanelTitle }}</text>
            </view>
            <view class="report-panel-view" @click="goReportManage"><text class="report-panel-view-text">查看</text></view>
          </view>
          <view v-if="reports.length > 0" class="report-panel-grid">
            <view class="report-panel-cell">
              <text class="report-panel-num">{{ reports.length }}</text>
              <text class="report-panel-label">报告数</text>
            </view>
            <view class="report-panel-cell">
              <text class="report-panel-num" :style="{ color: scoreColor }">{{ stats.latestScore == null ? '--' : stats.latestScore }}</text>
              <text class="report-panel-label">最新评分</text>
            </view>
            <view class="report-panel-cell">
              <text class="report-panel-num">{{ stats.averageScore == null ? '--' : stats.averageScore }}</text>
              <text class="report-panel-label">平均分</text>
            </view>
          </view>
          <text class="report-panel-sub">{{ reportPanelSub }}</text>
          <view class="report-panel-actions">
            <view class="report-panel-primary" @click="goReportManage"><text class="report-panel-primary-text">管理报告</text></view>
            <view class="report-panel-ghost" @click="goUpload"><text class="report-panel-ghost-text">上传新报告</text></view>
          </view>
        </view>

        <!-- 咨询进度 -->
        <view v-if="loggedIn && consultationStatus" class="consult-panel" :class="'consult-panel-' + consultPanelTone">
          <view class="consult-panel-head">
            <view class="consult-panel-main">
              <text class="consult-panel-kicker">咨询进度</text>
              <text class="consult-panel-title">{{ consultPanelTitle }}</text>
            </view>
            <view class="consult-panel-view" @click="goAdvisor"><text class="consult-panel-view-text">查看</text></view>
          </view>
          <text class="consult-panel-sub">{{ consultPanelSub }}</text>
          <view v-if="consultPanelAlert" class="consult-alert" :class="'consult-alert-' + consultPanelAlert.level">
            <text class="consult-alert-title">{{ consultPanelAlert.title }}</text>
            <text class="consult-alert-text">{{ consultPanelAlert.text }}</text>
          </view>
          <view v-if="consultMaterialSummary" class="consult-material-strip">
            <text class="consult-material-label">材料</text>
            <text class="consult-material-text">{{ consultMaterialSummary }}</text>
          </view>
        </view>

        <!-- 功能菜单 -->
        <view class="menu">
          <view class="menu-row" @click="goReportManage">
            <view class="menu-icon"><text class="menu-icon-text">报</text></view>
            <text class="menu-text">信用报告管理</text>
            <text v-if="reports.length > 0" class="menu-note">{{ reports.length }} 份</text>
            <RptChevron class="menu-arrow" direction="right" />
          </view>
          <view class="menu-row" @click="goUpload">
            <view class="menu-icon menu-icon-red"><text class="menu-icon-text menu-icon-text-red">传</text></view>
            <text class="menu-text">上传信用报告</text>
            <RptChevron class="menu-arrow" direction="right" />
          </view>
          <view class="menu-row" @click="goSupplementMaterials">
            <view class="menu-icon menu-icon-blue"><text class="menu-icon-text menu-icon-text-blue">材</text></view>
            <text class="menu-text">补充材料</text>
            <text class="menu-note">{{ supplementMenuNote }}</text>
            <RptChevron class="menu-arrow" direction="right" />
          </view>
          <view class="menu-row" @click="goAdvisor">
            <view class="menu-icon menu-icon-blue"><text class="menu-icon-text menu-icon-text-blue">询</text></view>
            <text class="menu-text">咨询进度</text>
            <text v-if="consultationStatus" class="menu-note">{{ consultMenuNote }}</text>
            <RptChevron class="menu-arrow" direction="right" />
          </view>
          <view class="menu-row" @click="goDebtManage">
            <view class="menu-icon menu-icon-green"><text class="menu-icon-text menu-icon-text-green">债</text></view>
            <text class="menu-text">债务管理</text>
            <text v-if="reports.length > 0" class="menu-note">按报告测算</text>
            <RptChevron class="menu-arrow" direction="right" />
          </view>
          <view class="menu-row" @click="goRepaymentReminder">
            <view class="menu-icon menu-icon-gold"><text class="menu-icon-text menu-icon-text-gold">日</text></view>
            <text class="menu-text">还款提醒</text>
            <text class="menu-note">本地提醒</text>
            <RptChevron class="menu-arrow" direction="right" />
          </view>
          <view v-if="canOpenTeacherPort" class="menu-row" @click="goTeacher">
            <view class="menu-icon menu-icon-gold"><text class="menu-icon-text menu-icon-text-gold">师</text></view>
            <text class="menu-text">银行老师端</text>
            <text class="menu-note">本机构客户</text>
            <RptChevron class="menu-arrow" direction="right" />
          </view>
          <view v-if="canOpenServicePort" class="menu-row" @click="goService">
            <view class="menu-icon menu-icon-blue"><text class="menu-icon-text menu-icon-text-blue">服</text></view>
            <text class="menu-text">客服端</text>
            <text class="menu-note">客服咨询</text>
            <RptChevron class="menu-arrow" direction="right" />
          </view>
          <view v-if="loggedIn && isAdminAccount" class="menu-row" @click="goAdmin">
            <view class="menu-icon menu-icon-green"><text class="menu-icon-text menu-icon-text-green">管</text></view>
            <text class="menu-text">管理员端</text>
            <text class="menu-note">总控台</text>
            <RptChevron class="menu-arrow" direction="right" />
          </view>
          <view v-if="loggedIn" class="menu-row" @click="goChangePassword">
            <view class="menu-icon"><text class="menu-icon-text">密</text></view>
            <text class="menu-text">修改密码</text>
            <RptChevron class="menu-arrow" direction="right" />
          </view>
          <view class="menu-row" @click="contactService">
            <view class="menu-icon"><text class="menu-icon-text">电</text></view>
            <text class="menu-text">联系客服</text>
            <RptChevron class="menu-arrow" direction="right" />
          </view>
          <view class="menu-row" @click="openLegal('agreement')">
            <view class="menu-icon"><text class="menu-icon-text">协</text></view>
            <text class="menu-text">用户协议</text>
            <RptChevron class="menu-arrow" direction="right" />
          </view>
          <view class="menu-row" @click="showAbout">
            <view class="menu-icon"><text class="menu-icon-text">报</text></view>
            <text class="menu-text">关于分析报告工作台</text>
            <RptChevron class="menu-arrow" direction="right" />
          </view>
        </view>

        <view v-if="loggedIn" class="logout" @click="doLogout">
          <text class="logout-text">退出登录</text>
        </view>

        <view class="bottom-safe rpt-page-bottom"></view>
      </view>
    </scroll-view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue'
import { onShow } from '@/compat/web-lifecycle.js'
import { isLoggedIn, getCachedUserInfo, logout } from '@/services/authService.js'
import { getReportAnalysisDate, getReportList, getReportStats, getReportUploadDate } from '@/services/reportStorage.js'
import { buildConsultationProgress, readLastConsultationStatus } from '@/services/userConsultationStatus.js'
import { createCustomerServiceContact, openAdvisorConversation } from '@/services/profileService.js'
import { switchToAdmin, switchToAdvisor, switchToService } from '@/services/roleService.js'
import { getScoreColor } from '@/config/riskLevel.js'
import { buildSupplementMaterialProfile, readSupplementMaterials } from '@/services/supplementMaterialService.js'
import RptChevron from '@/components/RptChevron.vue'

const loggedIn = ref(false)
const userInfo = ref(null)
const stats = ref({ totalCount: 0, latestScore: null, averageScore: null })
const reports = ref([])
const consultationStatus = ref(null)
const lastConsultationSignature = ref('')
const supplementProfile = ref(buildSupplementMaterialProfile([]))

const displayName = computed(() => {
  const u = userInfo.value || {}
  return u.nickname || u.userName || (u.mobile ? '用户' + String(u.mobile).slice(-4) : '平台用户')
})
const maskedPhone = computed(() => {
  const m = String((userInfo.value && (userInfo.value.mobile || userInfo.value.phone)) || '')
  return /^\d{11}$/.test(m) ? m.slice(0, 3) + '****' + m.slice(-4) : m
})
const avatarText = computed(() => {
  if (!loggedIn.value) return '游'
  const n = displayName.value
  return n ? n.slice(0, 1) : '云'
})
const scoreColor = computed(() => getScoreColor(stats.value.latestScore))
const latestReport = computed(() => reports.value[0] || null)
const latestReportDate = computed(() => {
  const r = latestReport.value
	return r ? getReportAnalysisDate(r) : ''
})
const latestUploadDate = computed(() => latestReport.value ? getReportUploadDate(latestReport.value) : '')
const reportPanelTitle = computed(() => reports.value.length > 0 ? `已保存 ${reports.value.length} 份报告` : '还没有保存报告')
const reportPanelSub = computed(() => {
  if (!reports.value.length) return '上传后可在这里查看、管理和删除自己的信用报告。'
	const reportDate = latestReportDate.value ? `报告日 ${latestReportDate.value}` : '报告日待核对'
	const uploadDate = latestUploadDate.value ? `上传 ${latestUploadDate.value}` : '上传时间待核对'
	return `${reportDate} · ${uploadDate}，可进入管理页查看历史报告和详情。`
})

const consultPanelTitle = computed(() => {
  const item = consultationStatus.value
  if (!item) return '查看咨询进度'
  return `最近申请：${item.productName || '匹配方案'}`
})
const consultPanelSub = computed(() => {
  const item = consultationStatus.value
  if (!item) return ''
  const parts = [
    item.reportTitle ? `基于 ${item.reportTitle}` : '基于信用报告',
    item.reportScore !== '' && item.reportScore != null ? `信用分 ${item.reportScore}` : '',
    item.matchRate !== '' && item.matchRate != null ? `匹配 ${item.matchRate}%` : '',
    item.statusText || '待顾问处理'
  ].filter(Boolean)
  return parts.join(' · ')
})
const consultationProgress = computed(() => buildConsultationProgress(consultationStatus.value))
const consultPanelAlert = computed(() => consultationProgress.value && consultationProgress.value.alert ? consultationProgress.value.alert : null)
const consultPanelTone = computed(() => consultPanelAlert.value && consultPanelAlert.value.level ? consultPanelAlert.value.level : 'info')
const consultMenuNote = computed(() => consultPanelAlert.value && ['danger', 'warning'].includes(consultPanelAlert.value.level) ? consultPanelAlert.value.title : (consultationStatus.value && consultationStatus.value.statusText) || '待顾问处理')
const consultMaterialSummary = computed(() => {
  const stats = consultationProgress.value && consultationProgress.value.materialStats
  if (!stats || !stats.total) return ''
  const parts = [
    stats.pending ? `${stats.pending} 待补` : '',
    stats.reupload ? `${stats.reupload} 重传` : '',
    stats.reviewing ? `${stats.reviewing} 待确认` : '',
    stats.confirmed || stats.unneeded ? `${stats.confirmed + stats.unneeded} 已处理` : ''
  ].filter(Boolean)
  return parts.join(' · ')
})
const supplementMenuNote = computed(() => {
  const profile = supplementProfile.value || {}
  if (profile.materialCount) return `${profile.materialCount} 项`
  return '三金/个税/资产'
})
const isAdminAccount = computed(() => {
  const u = userInfo.value || {}
  return String(u.role || '').trim().toLowerCase() === 'admin' || String(u.mobile || u.phone || '') === '19600000004'
})
const currentRole = computed(() => String((userInfo.value && userInfo.value.role) || '').trim().toLowerCase())
const currentPhone = computed(() => String((userInfo.value && (userInfo.value.mobile || userInfo.value.phone)) || '').trim())
const canOpenTeacherPort = computed(() => loggedIn.value && (currentRole.value === 'advisor' || ['19600000002', '19600000005', '19600000006'].includes(currentPhone.value)))
const canOpenServicePort = computed(() => loggedIn.value && (currentRole.value === 'service' || currentPhone.value === '19600000003'))
const consultationSignature = (item) => {
  if (!item) return ''
  const materials = Array.isArray(item.materials) ? item.materials : []
  return [item.status, item.statusText, materials.map((material) => `${material.id || material.name}:${material.statusText}:${material.reviewedAt || material.uploadedAt || ''}`).join(',')].join('|')
}
const consultationToastText = (item) => {
  const progress = buildConsultationProgress(item)
  const alert = progress && progress.alert
  if (alert && ['danger', 'warning', 'success'].includes(alert.level)) return alert.title
  return item && item.statusText ? `咨询进度：${item.statusText}` : '咨询进度已更新'
}
const refresh = () => {
  loggedIn.value = isLoggedIn()
  userInfo.value = loggedIn.value ? getCachedUserInfo() : null
  const nextConsultationStatus = loggedIn.value ? readLastConsultationStatus() : null
  const nextConsultationSignature = consultationSignature(nextConsultationStatus)
  if (lastConsultationSignature.value && nextConsultationSignature && nextConsultationSignature !== lastConsultationSignature.value) {
    const tip = consultationToastText(nextConsultationStatus)
    if (tip) uni.showToast({ title: tip, icon: 'none' })
  }
  consultationStatus.value = nextConsultationStatus
  lastConsultationSignature.value = loggedIn.value ? nextConsultationSignature : ''
  if (loggedIn.value) {
    try {
      reports.value = getReportList()
      supplementProfile.value = buildSupplementMaterialProfile(readSupplementMaterials())
      const s = getReportStats()
      stats.value = {
        totalCount: s.totalCount || 0,
        latestScore: s.latestScore,
        averageScore: s.averageScore
      }
    } catch (e) {
      reports.value = []
      stats.value = { totalCount: 0, latestScore: null, averageScore: null }
      supplementProfile.value = buildSupplementMaterialProfile([])
    }
  } else {
    reports.value = []
    stats.value = { totalCount: 0, latestScore: null, averageScore: null }
    supplementProfile.value = buildSupplementMaterialProfile([])
  }
}

const goLogin = () => uni.navigateTo({ url: '/pages/login/index', fail: () => { uni.showToast({ title: '无法打开登录页', icon: 'none' }) } })
const goChangePassword = () => uni.navigateTo({ url: '/pages/login/change-password', fail: () => { uni.showToast({ title: '无法打开修改密码页', icon: 'none' }) } })
const goUpload = () => uni.navigateTo({ url: '/pages/report/upload', fail: () => { uni.showToast({ title: '无法打开上传页', icon: 'none' }) } })
const goSupplementMaterials = () => {
  if (!loggedIn.value) { goLogin(); return }
  uni.navigateTo({ url: '/pages/profile/supplement-materials', fail: () => { uni.showToast({ title: '无法打开补充材料页', icon: 'none' }) } })
}
const goAdvisor = () => {
  if (!loggedIn.value) { goLogin(); return }
  uni.navigateTo({ url: '/pages/profile/advisor', fail: () => { uni.showToast({ title: '无法打开顾问页', icon: 'none' }) } })
}
const goDebtManage = () => {
  if (!loggedIn.value) { goLogin(); return }
  const latest = reports.value && reports.value.length ? reports.value[0] : null
  const query = latest && latest.id ? `?reportId=${encodeURIComponent(latest.id)}&from=profile` : ''
  uni.navigateTo({ url: `/pages/profile/debt-manage${query}`, fail: () => { uni.showToast({ title: '无法打开债务管理页', icon: 'none' }) } })
}
const goRepaymentReminder = () => {
  if (!loggedIn.value) { goLogin(); return }
  uni.navigateTo({ url: '/pages/profile/repayment-reminder', fail: () => { uni.showToast({ title: '无法打开还款提醒页', icon: 'none' }) } })
}
const readTeacherApplication = () => {
  const raw = uni.getStorageSync('teacher_application')
  if (!raw) return null
  if (typeof raw === 'object') return raw
  try { return JSON.parse(raw) } catch (e) { return null }
}
const goTeacher = async () => {
  if (!loggedIn.value) { goLogin(); return }
  const switched = await switchToAdvisor()
  if (!switched.ok) uni.showToast({ title: switched.errMsg || '银行经理端暂未开通', icon: 'none' })
  const app = readTeacherApplication()
  const url = app && app.status === 'reviewing' ? '/pages/teacher/reviewing' : '/pages/bank/workbench'
  uni.navigateTo({ url, fail: () => { uni.showToast({ title: '无法打开经理端', icon: 'none' }) } })
}
const goService = async () => {
  if (!loggedIn.value) { goLogin(); return }
  const switched = await switchToService()
  if (!switched.ok) {
    uni.showToast({ title: switched.errMsg || '客服端暂未开通', icon: 'none' })
    return
  }
  uni.navigateTo({ url: '/pages/service/workbench', fail: () => { uni.showToast({ title: '无法打开客服端', icon: 'none' }) } })
}
const goAdmin = async () => {
  if (!loggedIn.value) { goLogin(); return }
  const switched = await switchToAdmin()
  if (!switched.ok) {
    uni.showToast({ title: switched.errMsg || '管理员端暂未开通', icon: 'none' })
    return
  }
  uni.navigateTo({ url: '/pages/admin/workbench', fail: () => { uni.showToast({ title: '无法打开管理员端', icon: 'none' }) } })
}
const goReportManage = () => {
  if (!loggedIn.value) { goLogin(); return }
  uni.navigateTo({ url: '/pages/report/manage', fail: () => { uni.showToast({ title: '无法打开报告管理页', icon: 'none' }) } })
}

const openLegal = (kind) => uni.navigateTo({ url: `/pages/legal/document?type=${kind}`, fail: () => { uni.showToast({ title: '无法打开文档', icon: 'none' }) } })
const contactService = async () => {
  if (!loggedIn.value) { goLogin(); return }
  try {
    const response = await createCustomerServiceContact({
      source: 'profile-service',
      summary: '用户发起客服咨询',
      initialMessage: '我想咨询客服，请协助处理。',
      createdAt: new Date().toISOString()
    })
    await openAdvisorConversation(response)
  } catch (e) {
    uni.showToast({ title: e && e.message ? e.message : '客服会话创建失败', icon: 'none' })
  }
}

const showAbout = () => {
  uni.showModal({
    title: '关于分析报告工作台',
    content: '分析报告工作台 · 个人信用智能分析。分析结果仅供参考，实际授信以金融机构为准。',
    showCancel: false,
    confirmText: '知道了'
  })
}

const doLogout = () => {
  uni.showModal({
    title: '退出登录',
    content: '确定要退出当前账号吗？',
    success: async (res) => {
      if (!res.confirm) return
      try { await logout() } catch (e) { /* logout 内部已兜底清理 */ }
      refresh()
      uni.showToast({ title: '已退出', icon: 'none' })
    }
  })
}

onShow(() => refresh())
</script>

<style scoped>
.page { min-height: 100vh; background: #F5F6FA; }
.scroll-body { flex: 1; height: 100vh; }
.wrap { padding: calc(var(--rpt-safe-top) + 12px) 16px 16px; }

.user-card { flex-direction: row; align-items: center; background: #fff; border-radius: 8px; padding: 18px; border: 1px solid #EEF0F4; }
.avatar { width: 56px; height: 56px; border-radius: 28px; background: #EAF3FF; align-items: center; justify-content: center; margin-right: 14px; border: 1px solid #BFDBFE; }
.avatar-text { color: #086CEA; font-size: 22px; font-weight: 900; }
.user-main { flex: 1; }
.user-name { display: block; font-size: 18px; font-weight: 800; color: #111827; }
.user-phone { display: block; margin-top: 5px; font-size: 13px; color: #9CA3AF; }
.login-btn { background: #086CEA; border-radius: 8px; padding: 9px 16px; }
.login-btn-text { color: #fff; font-size: 14px; font-weight: 900; }

.report-panel { background: #fff; border-radius: 8px; padding: 16px; margin-top: 12px; border: 1px solid #EEF0F4; }
.report-panel-head { flex-direction: row; align-items: center; justify-content: space-between; }
.report-panel-kicker { font-size: 12px; color: #086CEA; font-weight: 900; }
.report-panel-title { margin-top: 5px; font-size: 18px; color: #111827; font-weight: 900; }
.report-panel-view { height: 34px; padding: 0 13px; border-radius: 8px; background: #EAF3FF; align-items: center; justify-content: center; }
.report-panel-view-text { font-size: 13px; color: #086CEA; font-weight: 900; }
.report-panel-grid { flex-direction: row; margin-top: 14px; border-top: 1px solid #F3F4F6; padding-top: 13px; }
.report-panel-cell { flex: 1; align-items: center; }
.report-panel-num { font-size: 20px; color: #111827; font-weight: 900; }
.report-panel-label { margin-top: 4px; font-size: 11px; color: #9CA3AF; }
.report-panel-sub { margin-top: 12px; font-size: 12px; color: #6B7280; line-height: 1.55; }
.report-panel-actions { flex-direction: row; margin-top: 14px; }
.report-panel-primary,
.report-panel-ghost { flex: 1; height: 40px; border-radius: 8px; align-items: center; justify-content: center; }
.report-panel-primary { background: #086CEA; margin-right: 9px; box-shadow: 0 10px 22px rgba(8,108,234,0.12); }
.report-panel-primary-text { color: #fff; font-size: 13px; font-weight: 900; }
.report-panel-ghost { background: #F8FAFC; border: 1px solid #E5E7EB; }
.report-panel-ghost-text { color: #374151; font-size: 13px; font-weight: 900; }

.consult-panel { background: #EFF6FF; border-radius: 8px; padding: 15px 16px; margin-top: 12px; border: 1px solid #BFDBFE; }
.consult-panel-danger { background: #FEF2F2; border-color: #FECACA; }
.consult-panel-warning { background: #FFFBEB; border-color: #FDE68A; }
.consult-panel-success { background: #F0FDF4; border-color: #BBF7D0; }
.consult-panel-head { flex-direction: row; align-items: center; justify-content: space-between; }
.consult-panel-main { flex: 1; margin-right: 10px; }
.consult-panel-kicker { font-size: 12px; color: #1D4ED8; font-weight: 900; }
.consult-panel-title { margin-top: 5px; font-size: 16px; color: #111827; font-weight: 900; }
.consult-panel-view { height: 32px; padding: 0 12px; border-radius: 8px; background: #FFFFFF; align-items: center; justify-content: center; border: 1px solid #DBEAFE; }
.consult-panel-view-text { font-size: 12px; color: #086CEA; font-weight: 900; }
.consult-panel-sub { margin-top: 9px; font-size: 12px; color: #475569; line-height: 1.55; }
.consult-alert { margin-top: 10px; padding: 9px 10px; border-radius: 8px; background: #FFFFFF; border: 1px solid #DBEAFE; }
.consult-alert-title { font-size: 12px; color: #1D4ED8; font-weight: 900; }
.consult-alert-text { margin-top: 3px; font-size: 12px; color: #475569; line-height: 1.45; }
.consult-alert-danger { border-color: #FECACA; }
.consult-alert-danger .consult-alert-title, .consult-alert-danger .consult-alert-text { color: #C62828; }
.consult-alert-warning { border-color: #FDE68A; }
.consult-alert-warning .consult-alert-title, .consult-alert-warning .consult-alert-text { color: #92400E; }
.consult-alert-success { border-color: #BBF7D0; }
.consult-alert-success .consult-alert-title, .consult-alert-success .consult-alert-text { color: #15803D; }
.consult-material-strip { flex-direction: row; align-items: center; justify-content: space-between; margin-top: 9px; padding-top: 9px; border-top: 1px solid rgba(148, 163, 184, 0.24); }
.consult-material-label { font-size: 11px; color: #64748B; font-weight: 900; }
.consult-material-text { flex: 1; margin-left: 10px; text-align: right; font-size: 11px; color: #475569; font-weight: 800; }
.menu { background: #fff; border-radius: 8px; margin-top: 12px; border: 1px solid #EEF0F4; overflow: hidden; }
.menu-row { flex-direction: row; align-items: center; padding: 15px 16px; border-bottom: 1px solid #F3F4F6; }
.menu-icon { width: 30px; height: 30px; border-radius: 8px; background: #F8FAFC; align-items: center; justify-content: center; margin-right: 12px; border: 1px solid #EEF0F4; }
.menu-icon-red { background: #EAF3FF; border-color: #BFDBFE; }
.menu-icon-blue { background: #EFF6FF; border-color: #BFDBFE; }
.menu-icon-green { background: #F0FDF4; border-color: #BBF7D0; }
.menu-icon-gold { background: #FFFBEB; border-color: #FDE68A; }
.menu-icon-text { font-size: 12px; color: #64748B; font-weight: 900; }
.menu-icon-text.menu-icon-text-red { color: #086CEA; }
.menu-icon-text.menu-icon-text-blue { color: #1D4ED8; }
.menu-icon-text.menu-icon-text-green { color: #15803D; }
.menu-icon-text.menu-icon-text-gold { color: #B45309; }
.menu-text { flex: 1; font-size: 15px; color: #374151; font-weight: 600; }
.menu-note { margin-right: 8px; font-size: 12px; color: #9CA3AF; font-weight: 700; }
.menu-arrow { width: 20px; height: 20px; color: #C7CBD1; }

.logout { margin-top: 16px; background: #fff; border-radius: 8px; padding: 15px; align-items: center; border: 1px solid #EEF0F4; }
.logout-text { font-size: 15px; color: #DC2626; font-weight: 700; }

.bottom-safe { height: 40px; }

/* ── 桌面端限宽+多栏布局 ≥1024px ── */
@media (min-width: 1024px) {
  .wrap { padding: 20px 24px 24px; }
  .user-card { margin-bottom: 4px; }
  .report-panel { margin-top: 16px; }
  .menu { margin-top: 16px; }
  .report-panel-grid { margin-top: 16px; }
}
</style>
