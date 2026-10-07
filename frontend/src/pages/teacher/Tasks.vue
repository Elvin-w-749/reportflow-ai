<template>
  <view class="page rpt-page">
    <view class="nav">
      <RptBackButton @click="goBack" />
      <text class="nav-title">待办任务</text>
      <view class="nav-spacer"></view>
    </view>

    <view class="tabs-wrap">
      <scroll-view class="tabs" scroll-x>
        <view class="tabs-inner">
          <view v-for="tab in tabs" :key="tab.key" class="tab" :class="{ active: currentTab === tab.key }" @click="currentTab = tab.key">
            <text class="tab-text" :class="{ active: currentTab === tab.key }">{{ tab.label }}</text>
            <text class="tab-count" :class="{ active: currentTab === tab.key }">{{ tab.count }}</text>
          </view>
        </view>
      </scroll-view>
      <view class="sync-line">
        <text class="sync-dot" :class="syncMeta.state"></text>
        <text class="sync-text">{{ syncMeta.label }}</text>
        <text class="sync-source">{{ syncMeta.sourceText }}</text>
        <text class="sync-time">{{ syncMeta.timeText }}</text>
      </view>
    </view>

    <scroll-view class="scroll-body" scroll-y refresher-enabled :refresher-triggered="refreshing" @refresherrefresh="refresh">
      <view class="wrap rpt-content-max">
        <view v-if="loading" class="state-card">
          <text class="state-title">正在加载待办</text>
          <text class="state-sub">同步联系任务与服务进度。</text>
        </view>

        <view v-else-if="!loggedIn" class="state-card">
          <text class="state-title">登录后查看待办</text>
          <text class="state-sub">老师端任务需要认证账号才能访问。</text>
          <view class="state-btn" @click="goLogin"><text class="state-btn-text">去登录</text></view>
        </view>

        <view v-else-if="filteredTasks.length" class="task-list">
          <view v-for="task in filteredTasks" :key="task.id" class="task-card">
            <view class="task-head">
              <view class="priority" :class="priorityClass(task.priority)"></view>
              <view class="task-title-wrap">
                <text class="task-title">{{ task.title }}</text>
                <text class="task-time">{{ task.time || '暂无时间' }}</text>
              </view>
              <text class="status" :class="statusClass(task.status)">{{ task.statusText || statusText(task.status) }}</text>
            </view>
            <text class="task-desc">{{ task.desc || '请查看客户详情并完成跟进。' }}</text>
            <view class="task-actions">
              <view class="ghost-btn" @click="openTaskClient(task)">
                <text class="ghost-btn-text">客户详情</text>
              </view>
              <view v-if="!isDone(task.status)" class="done-btn" @click="finishTask(task)">
                <text class="done-btn-text">标记完成</text>
              </view>
            </view>
          </view>
        </view>

        <view v-else class="state-card">
          <text class="state-title">暂无待办任务</text>
          <text class="state-sub">当客户进入待沟通、待补资料或待确认状态时，会生成待办。</text>
          <view class="state-ghost" @click="goClients"><text class="state-ghost-text">查看客户列表</text></view>
        </view>

        <view class="bottom-safe"></view>
      </view>
    </scroll-view>
  </view>
</template>

<script setup>
import { computed, ref } from 'vue'
import { onHide, onShow } from '@/compat/web-lifecycle.js'
import { isLoggedIn } from '@/services/authService.js'
import { switchToAdvisor } from '@/services/roleService.js'
import { completeTeacherTask, getTeacherTasksData, startTeacherRealtimeRefresh } from '@/services/teacherService.js'
import { DEFAULT_TEACHER_SYNC_META } from '@/services/teacherRealtime.js'
import RptBackButton from '@/components/RptBackButton.vue'
import safeBack from '@/utils/safeBack.js'

const loggedIn = ref(false)
const loading = ref(false)
const refreshing = ref(false)
const currentTab = ref('active')
const tasks = ref([])
const syncMeta = ref({ ...DEFAULT_TEACHER_SYNC_META })

const normalizeTask = (item, index) => ({
  id: item.id || item.taskId || item.contactId || `task-${index}`,
  contactId: item.contactId || item.clientId || item.id || '',
  clientId: item.clientId || item.contactId || item.id || '',
  title: item.title || item.name || '客户跟进',
  desc: item.desc || item.summary || item.content || '',
  time: item.time || item.deadline || item.createTime || '',
  status: item.status || 'pending',
  statusText: item.statusText || statusText(item.status),
  priority: item.priority || (item.status === 'pending' ? 'high' : 'normal')
})

const filteredTasks = computed(() => tasks.value.filter((task) => {
  if (currentTab.value === 'all') return true
  if (currentTab.value === 'active') return !isDone(task.status)
  return normalizedTabStatus(task.status) === currentTab.value
}))

const tabs = computed(() => {
  const count = (key) => tasks.value.filter((task) => key === 'all' ? true : key === 'active' ? !isDone(task.status) : normalizedTabStatus(task.status) === key).length
  return [
    { key: 'active', label: '进行中', count: count('active') },
    { key: 'pending', label: '待处理', count: count('pending') },
    { key: 'processing', label: '处理中', count: count('processing') },
    { key: 'completed', label: '已完成', count: count('completed') },
    { key: 'all', label: '全部', count: tasks.value.length }
  ]
})

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
	    const data = await getTeacherTasksData({ port: 'bank' })
	    const list = Array.isArray(data.tasks) ? data.tasks : []
	    tasks.value = list.map(normalizeTask)
	    syncMeta.value = data.syncMeta || { ...DEFAULT_TEACHER_SYNC_META }
	  } catch (e) {
	    if (e && e.statusCode === 401) loggedIn.value = false
	    if (!opts.silent && e && e.message) uni.showToast({ title: e.message, icon: 'none' })
	    tasks.value = []
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
  return 'processing'
}

const isDone = (status) => normalizedTabStatus(status) === 'completed'
const statusText = (status) => ({ pending: '待处理', processing: '处理中', completed: '已完成', done: '已完成', resolved: '已完成' }[status] || '待处理')
const statusClass = (status) => normalizedTabStatus(status)
const priorityClass = (priority) => priority === 'high' ? 'high' : priority === 'low' ? 'low' : 'normal'

const finishTask = async (task) => {
  try {
    const ok = await completeTeacherTask(task)
    if (!ok) throw new Error('complete failed')
    task.status = 'completed'
    task.statusText = '已完成'
    uni.showToast({ title: '已完成', icon: 'none' })
  } catch (e) {
    uni.showToast({ title: '完成失败，请稍后重试', icon: 'none' })
  }
}

const goBack = () => safeBack('/pages/teacher/workbench')
const goLogin = () => uni.navigateTo({ url: '/pages/login/index' })
const goClients = () => uni.navigateTo({ url: '/pages/teacher/clients' })
const openTaskClient = (task) => uni.navigateTo({ url: `/pages/teacher/client-detail?id=${encodeURIComponent(task.clientId || task.contactId || task.id)}` })

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
.tabs-wrap { background: #fff; padding: 10px 16px; border-bottom: 1px solid #EEF0F4; }
.tabs { white-space: nowrap; }
.sync-line { flex-direction: row; align-items: center; flex-wrap: wrap; margin-top: 9px; }
.sync-dot { width: 7px; height: 7px; border-radius: 4px; background: #CBD5E1; margin-right: 6px; }
.sync-dot.live { background: #16A34A; }
.sync-dot.incomplete { background: #F59E0B; }
.sync-dot.offline, .sync-dot.stale { background: #C62828; }
.sync-text { font-size: 11px; color: #374151; font-weight: 900; margin-right: 8px; }
.sync-source, .sync-time { font-size: 11px; color: #9CA3AF; margin-right: 8px; }
.tabs-inner { flex-direction: row; }
.tab { height: 34px; padding: 0 12px; border-radius: 8px; background: #F8FAFC; border: 1px solid #E5E7EB; flex-direction: row; align-items: center; margin-right: 8px; }
.tab.active { background: #EAF3FF; border-color: #BFDBFE; }
.tab-text { font-size: 13px; color: #4B5563; font-weight: 900; }
.tab-text.active { color: #086CEA; }
.tab-count { margin-left: 5px; font-size: 11px; color: #9CA3AF; font-weight: 800; }
.tab-count.active { color: #086CEA; }
.scroll-body { flex: 1; height: calc(100vh - 128px); }
.wrap { padding: 14px 16px 18px; }
.task-card { background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; padding: 14px; margin-bottom: 10px; }
.task-head { flex-direction: row; align-items: center; }
.priority { width: 4px; height: 34px; border-radius: 4px; background: #CBD5E1; margin-right: 10px; }
.priority.high { background: #C62828; }
.priority.normal { background: #1D4ED8; }
.priority.low { background: #16A34A; }
.task-title-wrap { flex: 1; }
.task-title { font-size: 15px; color: #111827; font-weight: 900; }
.task-time { margin-top: 4px; font-size: 12px; color: #9CA3AF; }
.task-desc { margin-top: 12px; font-size: 13px; color: #4B5563; line-height: 1.6; }
.status { font-size: 11px; font-weight: 900; padding: 4px 7px; border-radius: 8px; overflow: hidden; }
.status.pending { color: #086CEA; background: #EAF3FF; }
.status.processing { color: #1D4ED8; background: #EFF6FF; }
.status.completed { color: #15803D; background: #F0FDF4; }
.task-actions { flex-direction: row; justify-content: flex-end; margin-top: 14px; }
.ghost-btn { height: 36px; padding: 0 14px; border-radius: 8px; border: 1px solid #E5E7EB; align-items: center; justify-content: center; margin-right: 8px; }
.ghost-btn-text { font-size: 13px; color: #374151; font-weight: 900; }
.done-btn { height: 36px; padding: 0 14px; border-radius: 8px; background: #086CEA; align-items: center; justify-content: center; }
.done-btn-text { font-size: 13px; color: #fff; font-weight: 900; }
.state-card { align-items: center; background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; padding: 32px 20px; }
.state-title { font-size: 17px; color: #111827; font-weight: 900; }
.state-sub { margin-top: 8px; font-size: 13px; color: #6B7280; line-height: 1.7; text-align: center; }
.state-btn { margin-top: 18px; min-width: 120px; height: 42px; border-radius: 8px; background: #086CEA; align-items: center; justify-content: center; padding: 0 16px; }
.state-btn-text { color: #fff; font-size: 14px; font-weight: 900; }
.state-ghost { margin-top: 18px; height: 42px; border-radius: 8px; border: 1px solid #E5E7EB; align-items: center; justify-content: center; padding: 0 18px; }
.state-ghost-text { color: #374151; font-size: 14px; font-weight: 900; }
.bottom-safe { height: 36px; }
@media (min-width: 1024px) {
  .task-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: 12px; }
  .task-card { margin-bottom: 0; }
}
</style>
