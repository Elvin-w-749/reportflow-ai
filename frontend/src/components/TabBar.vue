<template>
  <view class="tabbar">
    <view class="tabbar-topline"></view>
    <view
      class="tab-item"
      v-for="(item, index) in tabList"
      :key="index"
      :class="{ 'tab-active': activeIndex === index }"
      @click="switchTab(index)"
    >
      <view class="tab-bg-pill" v-if="activeIndex === index"></view>
      <view class="tab-icon-wrap">
        <text class="tab-symbol" :class="activeIndex === index ? 'on' : ''">{{ tabIcon(index) }}</text>
        <view class="msg-badge" v-if="index === 2 && msgCount > 0">
          <text class="badge-num">{{ msgCount > 99 ? '99+' : msgCount }}</text>
        </view>
      </view>
      <text class="tab-text" :class="activeIndex === index ? 'tab-text-active' : ''">{{ item.text }}</text>
    </view>
  </view>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { TAB_BAR_LIST } from '@/config/tabbar.js'
import { MESSAGE_UNREAD_EVENT, getMessageUnreadSummary } from '@/services/messageCenter.js'

const route = useRoute()
const router = useRouter()
const tabList = ref(TAB_BAR_LIST)
const msgCount = ref(0)
const TAB_UNREAD_POLL_MS = 8000
let unreadTimer = null

const activeIndex = computed(() => {
  const i = tabList.value.findIndex((t) => t.pagePath === route.path)
  return i < 0 ? 0 : i
})

const switchTab = (index) => {
  const target = tabList.value[index].pagePath
  if (target === route.path) return
  router.push(target)
}

const tabIcon = (index) => ['⌂', '▣', '••', '●'][index] || '●'

const setMsgCount = (value) => {
  const n = Number(value)
  msgCount.value = Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

const refreshMsgCount = async () => {
  try {
    const summary = await getMessageUnreadSummary()
    setMsgCount(summary.total)
  } catch (e) {
    setMsgCount(0)
  }
}

const handleUnreadEvent = (payload) => {
  if (payload && typeof payload.total === 'number') {
    setMsgCount(payload.total)
    return
  }
  refreshMsgCount()
}

onMounted(() => {
  refreshMsgCount()
  unreadTimer = setInterval(refreshMsgCount, TAB_UNREAD_POLL_MS)
  if (typeof uni !== 'undefined' && typeof uni.$on === 'function') uni.$on(MESSAGE_UNREAD_EVENT, handleUnreadEvent)
})

onBeforeUnmount(() => {
  if (unreadTimer) clearInterval(unreadTimer)
  unreadTimer = null
  if (typeof uni !== 'undefined' && typeof uni.$off === 'function') uni.$off(MESSAGE_UNREAD_EVENT, handleUnreadEvent)
})

watch(() => route.path, () => { refreshMsgCount() })
</script>

<style scoped>
.tabbar {
  position: fixed;
  bottom: calc(8px + var(--rpt-safe-bottom));
  left: 12px;
  right: 12px;
  height: 66px;
  background: rgba(255,255,255,0.9);
  display: flex;
  flex-direction: row;
  justify-content: space-around;
  align-items: center;
  z-index: 999;
  border-radius: 18px;
  border: 1px solid rgba(219, 234, 254, 0.92);
  box-shadow: 0 14px 36px rgba(26, 65, 120, 0.14);
  backdrop-filter: blur(18px);
}
.tabbar-topline { display: none; }
.tab-item { flex: 1; height: 56px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; position: relative; }
.tab-bg-pill { position: absolute; top: 5px; left: 50%; transform: translateX(-50%); width: 42px; height: 32px; background: linear-gradient(180deg, #EAF3FF 0%, #DCEBFF 100%); border-radius: 8px; border: 1px solid rgba(191, 219, 254, 0.9); }
.tab-icon-wrap { position: relative; width: 30px; height: 28px; display: flex; align-items: center; justify-content: center; }
.tab-symbol { font-size: 24px; color: #8793A8; font-weight: 900; line-height: 26px; text-align: center; }
.tab-symbol.on { color: #086CEA; }
.msg-badge { position: absolute; top: -4px; right: -4px; min-width: 16px; height: 16px; background: #FF3B30; border-radius: 8px; border: 1.5px solid #fff; display: flex; align-items: center; justify-content: center; padding: 0 3px; }
.badge-num { font-size: 9px; color: #fff; font-weight: 700; line-height: 1; }
.tab-text { font-size: 11px; color: #7E8798; line-height: 14px; text-align: center; }
.tab-text-active { color: #086CEA; font-weight: 900; }
</style>
