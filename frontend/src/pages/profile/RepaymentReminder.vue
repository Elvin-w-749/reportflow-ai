<template>
  <view class="page rpt-page">
    <view class="nav">
      <RptBackButton @click="goBack" />
      <text class="nav-title">还款提醒</text>
      <view class="nav-spacer"></view>
    </view>

    <scroll-view class="scroll-body" scroll-y>
      <view class="wrap rpt-content-narrow">
        <view class="hero">
          <view class="hero-main">
            <text class="hero-kicker">本地账本提醒</text>
            <text class="hero-title">{{ heroTitle }}</text>
            <text class="hero-sub">{{ heroSub }}</text>
          </view>
          <view class="hero-orb">
            <text class="hero-orb-num">{{ summary.upcoming.length }}</text>
            <text class="hero-orb-label">7天内</text>
          </view>
        </view>

        <view class="metric-grid">
          <view class="metric-card">
            <text class="metric-value">{{ summary.monthDueText }}</text>
            <text class="metric-label">本月应还估算</text>
          </view>
          <view class="metric-card">
            <text class="metric-value">{{ summary.manualCount }}</text>
            <text class="metric-label">已设提醒</text>
          </view>
          <view class="metric-card">
            <text class="metric-value danger-value">{{ summary.overdue.length }}</text>
            <text class="metric-label">逾期/过期</text>
          </view>
        </view>

        <view class="setting-card">
          <view class="setting-main">
            <text class="setting-title">统一提醒日</text>
            <text class="setting-sub">{{ reminderSettingText }}</text>
          </view>
          <view class="setting-btn" @click="chooseReminderDay"><text class="setting-btn-text">设置</text></view>
        </view>

        <view class="sms-card" :class="{ 'sms-card-on': smsReady }">
          <view class="sms-icon"><text class="sms-icon-text">信</text></view>
          <view class="sms-main">
            <view class="sms-title-row">
              <text class="sms-title">短信提醒</text>
              <text class="sms-badge" :class="{ 'sms-badge-on': smsReady }">{{ smsReady ? '已开启' : '需同意条例' }}</text>
            </view>
            <text class="sms-sub">{{ smsReminderText }}</text>
          </view>
          <view v-if="smsReady" class="sms-btn sms-btn-ghost" @click.stop="closeSmsReminder"><text class="sms-btn-ghost-text">关闭</text></view>
          <view v-else class="sms-btn" @click.stop="openSmsConsent"><text class="sms-btn-text">开启</text></view>
        </view>

        <view class="section-head">
          <text class="section-title">最近还款</text>
          <text class="section-note">{{ summary.items.length ? summary.items.length + ' 项' : '暂无' }}</text>
        </view>

        <view v-if="summary.items.length" class="reminder-list">
          <view v-for="item in summary.items.slice(0, 12)" :key="item.id" class="reminder-card" :class="cardClass(item)">
            <view class="reminder-main">
              <text class="reminder-title">{{ item.title }}</text>
              <text class="reminder-sub">{{ [item.product, item.dueText].filter(Boolean).join(' · ') }}</text>
            </view>
            <view class="reminder-side">
              <text class="reminder-amount">{{ item.amountText }}</text>
              <text class="reminder-date">{{ item.dueDate || '待补日期' }}</text>
            </view>
          </view>
        </view>

        <view v-else class="empty-card">
          <text class="empty-title">还没有可提醒的债务</text>
          <text class="empty-sub">上传信用报告或进入债务管理设置单笔提醒后，这里会自动汇总。</text>
          <view class="empty-btn" @click="goDebtManage"><text class="empty-btn-text">去债务管理</text></view>
        </view>

        <view class="action-row">
          <view class="action-ghost" @click="goDebtManage"><text class="action-ghost-text">管理债务</text></view>
          <view class="action-primary" @click="goAdvisor"><text class="action-primary-text">咨询顾问</text></view>
        </view>

        <view class="disclaimer">
          <text class="disclaimer-text">当前为应用内提醒和本地账本摘要，具体还款金额与日期请以银行或机构账单为准。</text>
        </view>
        <view class="bottom-safe rpt-page-bottom"></view>
      </view>
    </scroll-view>
  </view>
</template>

<script setup>
import { computed, ref } from 'vue'
import { onShow } from '@/compat/web-lifecycle.js'
import safeBack from '@/utils/safeBack.js'
import RptBackButton from '@/components/RptBackButton.vue'
import { saveRepaymentSmsConsent } from '@/services/profileService.js'
import { getLatestReportAsync } from '@/services/reportStorage.js'
import {
  buildRepaymentReminderSummary,
  saveRepaymentReminderSetting,
  REPAYMENT_SMS_CONSENT_VERSION
} from '@/services/repaymentReminderService.js'

const summary = ref(buildRepaymentReminderSummary(null))

const heroTitle = computed(() => {
  if (summary.value.overdue.length) return '先处理过期账单'
  if (summary.value.upcoming.length) return '近期有还款要跟进'
  return '本周暂无还款压力'
})
const heroSub = computed(() => {
  if (summary.value.overdue.length) return `有 ${summary.value.overdue.length} 项已经过期，请优先核对账单并处理。`
  if (summary.value.upcoming.length) return `未来 7 天有 ${summary.value.upcoming.length} 项提醒，建议提前安排现金流。`
  return '继续保持稳定还款，减少临近还款日的资金压力。'
})
const reminderSettingText = computed(() => {
  const setting = summary.value.setting || {}
  return setting.enabled && setting.day ? `当前每月 ${setting.day} 日提醒` : '还没有设置统一提醒日'
})
const smsReady = computed(() => !!summary.value.smsReady)
const smsReminderText = computed(() => {
  const setting = summary.value.setting || {}
  if (summary.value.smsReady) return `已同意短信提醒说明，将按每月 ${setting.day} 日的提醒设置执行。`
  if (setting.smsConsentAccepted) return '你已同意过短信提醒说明，当前处于关闭状态，可随时重新开启。'
  return '阅读并同意提醒说明后，可开启短信提醒；具体发送以短信通道和账单信息为准。'
})

const refresh = async () => {
  const report = await getLatestReportAsync().catch(() => null)
  summary.value = buildRepaymentReminderSummary(report)
}

const chooseReminderDay = () => {
  const days = [1, 5, 10, 15, 20, 25]
  uni.showActionSheet({
    itemList: days.map((day) => `每月 ${day} 日`),
    success: (res) => {
      const day = days[Number(res.tapIndex)]
      if (!day) return
      saveRepaymentReminderSetting({ ...summary.value.setting, enabled: true, day })
      void refresh()
      uni.showToast({ title: `已设置每月 ${day} 日提醒`, icon: 'none' })
    }
  })
}

const syncSmsConsent = async (setting = {}) => {
  try {
    await saveRepaymentSmsConsent({
      enabled: !!setting.enabled,
      smsEnabled: !!setting.smsEnabled,
      smsConsentAccepted: !!setting.smsConsentAccepted,
      day: Number(setting.day) || 0,
      smsConsentAt: setting.smsConsentAt || '',
      smsConsentVersion: setting.smsConsentVersion || REPAYMENT_SMS_CONSENT_VERSION,
      source: 'repayment-reminder'
    })
  } catch (e) {
    console.warn('[repayment] 同步短信授权失败', e && e.message)
  }
}

const openSmsConsent = () => {
  const current = summary.value.setting || {}
  const day = current.day || 5
  uni.showModal({
    title: '开启短信提醒',
    content: '请确认已阅读并同意《还款提醒短信服务说明》：短信仅用于还款日提醒，可随时关闭；还款金额与日期以银行或机构账单为准。',
    confirmText: '同意并开启',
    cancelText: '暂不开启',
    success: (res) => {
      if (!res.confirm) return
      const next = saveRepaymentReminderSetting({
        ...current,
        enabled: true,
        day,
        smsEnabled: true,
        smsConsentAccepted: true,
        smsConsentAt: new Date().toISOString(),
        smsConsentVersion: REPAYMENT_SMS_CONSENT_VERSION
      })
      void refresh()
      syncSmsConsent(next)
      uni.showToast({ title: `已开启每月 ${day} 日短信提醒`, icon: 'none' })
    }
  })
}

const closeSmsReminder = () => {
  const next = saveRepaymentReminderSetting({ ...summary.value.setting, smsEnabled: false })
  void refresh()
  syncSmsConsent(next)
  uni.showToast({ title: '已关闭短信提醒', icon: 'none' })
}

const cardClass = (item) => {
  if (item.status === '逾期' || (item.daysUntil != null && item.daysUntil < 0)) return 'reminder-card-danger'
  if (item.daysUntil != null && item.daysUntil <= 1) return 'reminder-card-urgent'
  if (item.daysUntil != null && item.daysUntil <= 7) return 'reminder-card-soon'
  return 'reminder-card-calm'
}
const goBack = () => safeBack('/pages/home/home')
const goDebtManage = () => uni.navigateTo({ url: '/pages/profile/debt-manage', fail: () => { uni.showToast({ title: '无法打开债务管理页', icon: 'none' }) } })
const goAdvisor = () => uni.navigateTo({ url: '/pages/profile/advisor', fail: () => { uni.showToast({ title: '无法打开顾问页', icon: 'none' }) } })

onShow(() => { void refresh() })
</script>

<style scoped>
.page { min-height: 100vh; min-height: 100dvh; height: 100vh; height: 100dvh; background: #F3F7FF; overflow: hidden; }
.nav { flex-direction: row; align-items: center; padding: calc(var(--rpt-safe-top) + 8px) 14px 10px; background: #F6F9FF; border-bottom: 1px solid rgba(214, 226, 245, 0.8); }
.nav-title { flex: 1; text-align: center; font-size: 16px; font-weight: 900; color: #071B3D; }
.nav-spacer { width: 38px; }
.scroll-body { flex: 1; min-height: 0; height: auto; background: linear-gradient(180deg, #F6F9FF 0%, #F2F6FF 56%, #F8FAFF 100%); -webkit-overflow-scrolling: touch; }
.wrap { padding: 14px; }
.hero { min-height: 126px; border-radius: 8px; padding: 18px 16px; flex-direction: row; align-items: center; background: linear-gradient(135deg, #FFFFFF 0%, #ECF5FF 100%); border: 1px solid #DCEBFF; box-shadow: 0 12px 26px rgba(23, 83, 156, 0.08); }
.hero-main { flex: 1; margin-right: 12px; }
.hero-kicker { font-size: 12px; color: #0A70EA; font-weight: 900; }
.hero-title { margin-top: 8px; font-size: 22px; color: #071B3D; font-weight: 900; line-height: 28px; }
.hero-sub { margin-top: 7px; font-size: 12px; color: #64748B; line-height: 18px; }
.hero-orb { width: 74px; height: 74px; border-radius: 50%; background: #FFFFFF; border: 1px solid #D7E8FF; align-items: center; justify-content: center; box-shadow: 0 10px 22px rgba(18, 102, 220, 0.13); }
.hero-orb-num { font-size: 25px; color: #0A70EA; font-weight: 900; line-height: 29px; }
.hero-orb-label { font-size: 11px; color: #64748B; font-weight: 800; }
.metric-grid { flex-direction: row; margin-top: 12px; }
.metric-card { flex: 1; min-height: 68px; border-radius: 8px; background: #FFFFFF; border: 1px solid #E7EEF8; align-items: center; justify-content: center; margin-right: 8px; }
.metric-card:last-child { margin-right: 0; }
.metric-value { font-size: 18px; color: #071B3D; font-weight: 900; text-align: center; }
.danger-value { color: #F43F5E; }
.metric-label { margin-top: 4px; font-size: 11px; color: #7C8799; }
.setting-card { margin-top: 12px; padding: 14px; border-radius: 8px; background: #FFFFFF; border: 1px solid #E7EEF8; flex-direction: row; align-items: center; box-shadow: 0 8px 18px rgba(28, 62, 114, 0.05); }
.setting-main { flex: 1; margin-right: 10px; }
.setting-title { font-size: 15px; color: #071B3D; font-weight: 900; }
.setting-sub { margin-top: 4px; font-size: 12px; color: #64748B; }
.setting-btn { height: 34px; padding: 0 13px; border-radius: 8px; background: #EAF3FF; border: 1px solid #BFDBFE; align-items: center; justify-content: center; }
.setting-btn-text { font-size: 12px; color: #0A70EA; font-weight: 900; }
.sms-card { margin-top: 12px; padding: 14px; border-radius: 8px; background: #FFFFFF; border: 1px solid #E7EEF8; flex-direction: row; align-items: center; box-shadow: 0 8px 18px rgba(28, 62, 114, 0.05); }
.sms-card-on { border-color: #BBF7D0; background: linear-gradient(180deg, #FFFFFF 0%, #F0FDF4 100%); }
.sms-icon { width: 42px; height: 42px; border-radius: 8px; background: #EAF3FF; border: 1px solid #BFDBFE; align-items: center; justify-content: center; margin-right: 11px; }
.sms-card-on .sms-icon { background: #ECFDF3; border-color: #BBF7D0; }
.sms-icon-text { font-size: 15px; color: #086CEA; font-weight: 900; }
.sms-card-on .sms-icon-text { color: #16A34A; }
.sms-main { flex: 1; min-width: 0; margin-right: 10px; }
.sms-title-row { flex-direction: row; align-items: center; min-width: 0; }
.sms-title { font-size: 15px; color: #071B3D; font-weight: 900; line-height: 20px; }
.sms-badge { margin-left: 6px; padding: 2px 6px; border-radius: 8px; background: #F1F5F9; color: #64748B; border: 1px solid #E2E8F0; font-size: 10px; line-height: 14px; font-weight: 900; white-space: nowrap; overflow: hidden; }
.sms-badge-on { background: #ECFDF3; color: #047857; border-color: #BBF7D0; }
.sms-sub { margin-top: 4px; font-size: 11px; color: #64748B; line-height: 16px; }
.sms-btn { height: 34px; padding: 0 13px; border-radius: 8px; background: #086CEA; align-items: center; justify-content: center; }
.sms-btn-text { color: #FFFFFF; font-size: 12px; font-weight: 900; }
.sms-btn-ghost { background: #FFFFFF; border: 1px solid #DDE7F4; }
.sms-btn-ghost-text { color: #334155; font-size: 12px; font-weight: 900; }
.section-head { flex-direction: row; align-items: center; justify-content: space-between; margin: 16px 2px 9px; }
.section-title { font-size: 18px; color: #071B3D; font-weight: 900; }
.section-note { font-size: 12px; color: #7C8799; font-weight: 800; }
.reminder-card { min-height: 64px; margin-bottom: 9px; padding: 12px; border-radius: 8px; background: #FFFFFF; border: 1px solid #E7EEF8; flex-direction: row; align-items: center; box-shadow: 0 8px 18px rgba(28, 62, 114, 0.05); }
.reminder-card-danger { border-color: #FECACA; background: #FFF5F6; }
.reminder-card-urgent { border-color: #FDE68A; background: #FFFBEB; }
.reminder-card-soon { border-color: #BFDBFE; background: #F4F8FF; }
.reminder-main { flex: 1; min-width: 0; margin-right: 9px; }
.reminder-title { font-size: 14px; color: #071B3D; font-weight: 900; }
.reminder-sub { margin-top: 4px; font-size: 11px; color: #64748B; line-height: 15px; }
.reminder-side { align-items: flex-end; min-width: 82px; }
.reminder-amount { font-size: 13px; color: #071B3D; font-weight: 900; text-align: right; }
.reminder-date { margin-top: 4px; font-size: 11px; color: #7C8799; text-align: right; }
.empty-card { align-items: center; padding: 28px 18px; border-radius: 8px; background: #FFFFFF; border: 1px solid #E7EEF8; }
.empty-title { font-size: 16px; color: #071B3D; font-weight: 900; }
.empty-sub { margin-top: 8px; font-size: 12px; color: #64748B; line-height: 18px; text-align: center; }
.empty-btn { margin-top: 16px; height: 38px; padding: 0 18px; border-radius: 8px; background: #086CEA; align-items: center; justify-content: center; }
.empty-btn-text { color: #FFFFFF; font-size: 13px; font-weight: 900; }
.action-row { flex-direction: row; margin-top: 14px; }
.action-ghost, .action-primary { flex: 1; height: 44px; border-radius: 8px; align-items: center; justify-content: center; }
.action-ghost { background: #FFFFFF; border: 1px solid #DDE7F4; margin-right: 10px; }
.action-ghost-text { color: #334155; font-size: 14px; font-weight: 900; }
.action-primary { background: #086CEA; }
.action-primary-text { color: #FFFFFF; font-size: 14px; font-weight: 900; }
.disclaimer { padding: 12px 2px 0; }
.disclaimer-text { font-size: 11px; color: #9AA7BA; line-height: 17px; text-align: center; }
.bottom-safe { height: 44px; }

/* ── 桌面端限宽微调 ≥1024px ── */
@media (min-width: 1024px) {
  .wrap { padding: 20px 24px; }
  .metric-grid { margin-top: 16px; }
  .hero { padding: 22px 20px; }
}
</style>
