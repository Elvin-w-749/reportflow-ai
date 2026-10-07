<template>
  <view class="participant-strip">
    <view class="participant-head">
      <text class="participant-kicker">{{ title }}</text>
      <text class="participant-sub">{{ subtitle }}</text>
    </view>
    <view class="participant-row">
      <view v-for="item in participants" :key="item.key" class="participant" :class="'participant-' + item.state">
        <view class="participant-avatar">
          <text class="participant-avatar-text">{{ item.avatar }}</text>
        </view>
        <view class="participant-copy">
          <text class="participant-role">{{ item.role }}</text>
          <text class="participant-name">{{ item.name }}</text>
        </view>
        <view class="participant-state">
          <text class="participant-state-text">{{ item.stateText }}</text>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  source: { type: Object, default: () => ({}) }
})

const first = (...values) => values.find((value) => value !== undefined && value !== null && String(value).trim()) || ''
const shortName = (value, fallback) => String(value || fallback || '').slice(0, 1)

const isGroupChat = computed(() => {
  const source = props.source || {}
  return source.channel === 'bank' || source.deskType === 'bank' || source.serviceRequired === true || source.groupMode === 'service-bank-customer' || source.contactType === 'match-product'
})

const title = computed(() => isGroupChat.value ? '三方沟通成员' : '服务沟通成员')
const subtitle = computed(() => isGroupChat.value ? '客户、客服、匹配机构老师共用此会话' : '客户与客服共用此会话')

const participants = computed(() => {
  const source = props.source || {}
  const customerName = first(source.clientName, source.name, source.userName, '客户')
  const serviceName = first(source.serviceAssigneeName, source.serviceName, '待客服接单')
  const advisorName = first(source.advisorAssigneeName, source.advisorName, source.institution ? `${source.institution}老师` : '', '待银行老师接入')
  const rows = [
    {
      key: 'customer',
      role: '客户',
      name: customerName,
      avatar: shortName(customerName, '客'),
      state: 'connected',
      stateText: '已发起'
    },
    {
      key: 'service',
      role: '客服',
      name: serviceName,
      avatar: '服',
      state: source.serviceAssigneeId ? 'connected' : 'waiting',
      stateText: source.serviceAssigneeId ? '已接单' : '待接单'
    }
  ]
  if (isGroupChat.value) {
    rows.push({
      key: 'advisor',
      role: '银行老师',
      name: advisorName,
      avatar: '行',
      state: source.advisorAssigneeId ? 'connected' : 'waiting',
      stateText: source.advisorAssigneeId ? '已接入' : '待接入'
    })
  }
  return rows
})
</script>

<style scoped>
.participant-strip { background: #fff; border: 1px solid #EEF0F4; border-radius: 8px; padding: 12px; margin-bottom: 10px; }
.participant-head { flex-direction: row; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.participant-kicker { font-size: 12px; color: #111827; font-weight: 900; }
.participant-sub { flex: 1; margin-left: 10px; text-align: right; font-size: 10px; color: #94A3B8; font-weight: 800; }
.participant-row { flex-direction: row; align-items: stretch; }
.participant { flex: 1; min-width: 0; border-radius: 8px; background: #F8FAFC; border: 1px solid #E5E7EB; padding: 9px 8px; margin-right: 7px; }
.participant:last-child { margin-right: 0; }
.participant-connected { background: #EFF6FF; border-color: #BFDBFE; }
.participant-waiting { background: #FFFBEB; border-color: #FDE68A; }
.participant-avatar { width: 28px; height: 28px; border-radius: 14px; background: #FFFFFF; border: 1px solid rgba(148, 163, 184, .35); align-items: center; justify-content: center; margin-bottom: 7px; }
.participant-avatar-text { font-size: 12px; color: #1D4ED8; font-weight: 900; }
.participant-waiting .participant-avatar-text { color: #B45309; }
.participant-copy { min-width: 0; }
.participant-role { font-size: 10px; color: #64748B; font-weight: 900; }
.participant-name { margin-top: 3px; font-size: 12px; color: #111827; font-weight: 900; line-height: 1.25; }
.participant-state { align-self: flex-start; margin-top: 7px; border-radius: 6px; background: rgba(255, 255, 255, .7); padding: 3px 6px; }
.participant-state-text { font-size: 10px; color: #1D4ED8; font-weight: 900; }
.participant-waiting .participant-state-text { color: #B45309; }
</style>
