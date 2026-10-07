<template>
  <view class="page rpt-page">
    <view class="nav">
      <RptBackButton @click="goBack" />
      <text class="nav-title">入驻审核</text>
      <view class="nav-spacer"></view>
    </view>

    <scroll-view class="scroll-body" scroll-y>
      <view class="wrap rpt-content-narrow">
        <view class="status-card">
          <view class="status-mark">
            <text class="status-mark-text">审</text>
          </view>
          <text class="status-title">{{ application ? '资料审核中' : '尚未提交资料' }}</text>
          <text class="status-sub">{{ application ? '平台会核验身份、机构与服务资质，审核结果会同步到老师端入口。' : '完成入驻申请后，可查看审核状态并等待开通。' }}</text>
        </view>

        <view v-if="application" class="summary">
          <view class="summary-row">
            <text class="summary-label">姓名</text>
            <text class="summary-value">{{ application.name }}</text>
          </view>
          <view class="summary-row">
            <text class="summary-label">机构</text>
            <text class="summary-value">{{ application.institution }}</text>
          </view>
          <view class="summary-row">
            <text class="summary-label">岗位</text>
            <text class="summary-value">{{ application.title }}</text>
          </view>
          <view class="summary-row">
            <text class="summary-label">提交时间</text>
            <text class="summary-value">{{ submittedAt }}</text>
          </view>
        </view>

        <view class="timeline">
          <view v-for="item in timeline" :key="item.title" class="timeline-row">
            <view class="timeline-axis">
              <view class="dot" :class="{ done: item.done, current: item.current }"></view>
              <view class="line"></view>
            </view>
            <view class="timeline-main">
              <text class="timeline-title">{{ item.title }}</text>
              <text class="timeline-desc">{{ item.desc }}</text>
            </view>
          </view>
        </view>

        <view class="notice">
          <text class="notice-title">审核后将获得</text>
          <text class="notice-text">客户工作台、授权客户列表、待办任务、客户跟进记录与合规留痕。</text>
        </view>

        <view v-if="application" class="secondary" @click="goWorkbench">
          <text class="secondary-text">查看老师端工作台</text>
        </view>
        <view class="primary" @click="goApply">
          <text class="primary-text">{{ application ? '更新入驻资料' : '去提交资料' }}</text>
        </view>

        <view class="bottom-safe"></view>
      </view>
    </scroll-view>
  </view>
</template>

<script setup>
import { computed, ref } from 'vue'
import { onShow } from '@/compat/web-lifecycle.js'
import RptBackButton from '@/components/RptBackButton.vue'
import safeBack from '@/utils/safeBack.js'

const STORAGE_KEY = 'teacher_application'
const application = ref(null)

const readApplication = () => {
  const raw = uni.getStorageSync(STORAGE_KEY)
  if (!raw) return null
  if (typeof raw === 'object') return raw
  try { return JSON.parse(raw) } catch (e) { return null }
}

const submittedAt = computed(() => {
  const raw = application.value && application.value.submittedAt
  if (!raw) return '刚刚'
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return String(raw).slice(0, 16)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
})

const timeline = computed(() => [
  { title: '资料提交', desc: application.value ? '已收到你的入驻资料。' : '等待提交实名与机构资料。', done: !!application.value },
  { title: '平台初审', desc: '校验手机号、机构名称、资质图片和服务专长。', current: !!application.value },
  { title: '合规确认', desc: '确认用户授权边界、服务话术与数据保护要求。' },
  { title: '开通工作台', desc: '审核通过后可以承接授权客户并处理待办。' }
])

const goBack = () => safeBack('/pages/profile/profile')
const goApply = () => uni.navigateTo({ url: '/pages/teacher/apply' })
const goWorkbench = () => uni.navigateTo({ url: '/pages/teacher/workbench' })

onShow(() => {
  application.value = readApplication()
})
</script>

<style scoped>
.page { min-height: 100vh; background: #F5F6FA; }
.nav { flex-direction: row; align-items: center; padding: calc(var(--rpt-safe-top) + 8px) 14px 8px; background: #fff; border-bottom: 1px solid #EEF0F4; }
.nav-title { flex: 1; text-align: center; font-size: 16px; font-weight: 900; color: #111827; }
.nav-spacer { width: 32px; }
.scroll-body { flex: 1; height: 100vh; }
.wrap { padding: 16px; }
.status-card { align-items: center; background: #fff; border-radius: 8px; padding: 28px 20px; border: 1px solid #EEF0F4; }
.status-mark { width: 64px; height: 64px; border-radius: 32px; background: #EAF3FF; border: 1px solid #BFDBFE; align-items: center; justify-content: center; }
.status-mark-text { font-size: 24px; color: #086CEA; font-weight: 900; }
.status-title { margin-top: 14px; font-size: 20px; color: #111827; font-weight: 900; }
.status-sub { margin-top: 8px; font-size: 13px; color: #6B7280; line-height: 1.7; text-align: center; }
.summary { margin-top: 12px; background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; padding: 14px 16px; }
.summary-row { flex-direction: row; align-items: center; padding: 9px 0; border-bottom: 1px solid #F3F4F6; }
.summary-row:last-child { border-bottom-width: 0; }
.summary-label { width: 72px; font-size: 13px; color: #9CA3AF; font-weight: 700; }
.summary-value { flex: 1; font-size: 14px; color: #111827; font-weight: 800; text-align: right; }
.timeline { margin-top: 12px; background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; padding: 16px; }
.timeline-row { flex-direction: row; min-height: 70px; }
.timeline-axis { width: 26px; align-items: center; }
.dot { width: 12px; height: 12px; border-radius: 6px; background: #CBD5E1; margin-top: 4px; }
.dot.done { background: #16A34A; }
.dot.current { background: #086CEA; }
.line { flex: 1; width: 1px; background: #E5E7EB; margin-top: 6px; }
.timeline-row:last-child .line { background: transparent; }
.timeline-main { flex: 1; padding-bottom: 16px; }
.timeline-title { font-size: 15px; color: #111827; font-weight: 900; }
.timeline-desc { margin-top: 5px; font-size: 12px; color: #6B7280; line-height: 1.6; }
.notice { margin-top: 12px; background: #FFFBEB; border-radius: 8px; border: 1px solid #FDE68A; padding: 14px; }
.notice-title { font-size: 14px; color: #92400E; font-weight: 900; }
.notice-text { margin-top: 6px; font-size: 12px; color: #92400E; line-height: 1.6; }
.secondary { margin-top: 16px; height: 46px; border-radius: 8px; background: #fff; border: 1px solid #E5E7EB; align-items: center; justify-content: center; }
.secondary-text { font-size: 14px; color: #374151; font-weight: 900; }
.primary { margin-top: 10px; height: 48px; border-radius: 8px; background: #086CEA; align-items: center; justify-content: center; }
.primary-text { color: #fff; font-size: 15px; font-weight: 900; }
.bottom-safe { height: 36px; }
</style>
