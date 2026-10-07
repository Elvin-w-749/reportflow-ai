<template>
  <view class="service-progress" :class="{ compact }">
    <view class="progress-head">
      <view class="progress-copy">
        <text class="progress-kicker">服务进度</text>
        <text class="progress-title">{{ progress.title }}</text>
        <text v-if="!compact" class="progress-text">{{ progress.text }}</text>
      </view>
      <view class="material-entry" @click.stop="$emit('material-click')">
        <text class="material-entry-label">资料档案</text>
        <text class="material-entry-count">{{ progress.materialSummary }}</text>
      </view>
    </view>
    <view class="stage-row">
      <view v-for="item in progress.stages" :key="item.key" class="stage" :class="'stage-' + item.state">
        <view class="stage-dot"><text class="stage-dot-text">{{ item.state === 'done' ? '✓' : '' }}</text></view>
        <text class="stage-title">{{ item.title }}</text>
      </view>
    </view>
    <view v-if="showAlert" class="progress-alert" :class="'progress-alert-' + progress.alert.level">
      <text class="progress-alert-title">{{ progress.alert.title }}</text>
      <text class="progress-alert-text">{{ progress.alert.text }}</text>
    </view>
  </view>
</template>

<script setup>
import { computed } from 'vue'
import { buildServiceProgress } from '@/services/serviceProgress.js'

const props = defineProps({
  source: { type: Object, default: () => ({}) },
  compact: { type: Boolean, default: false },
  showAlert: { type: Boolean, default: true }
})

defineEmits(['material-click'])

const progress = computed(() => buildServiceProgress(props.source || {}))
</script>

<style scoped>
.service-progress { background: #fff; border: 1px solid #EEF0F4; border-radius: 8px; padding: 13px; margin-bottom: 12px; }
.service-progress.compact { padding: 10px 0 0; margin: 11px 0 0; border-width: 1px 0 0; border-color: #F3F4F6; border-radius: 0; background: transparent; }
.progress-head { flex-direction: row; align-items: center; }
.progress-copy { flex: 1; min-width: 0; margin-right: 10px; }
.progress-kicker { font-size: 11px; color: #1D4ED8; font-weight: 900; }
.progress-title { margin-top: 4px; font-size: 15px; color: #111827; font-weight: 900; }
.progress-text { margin-top: 4px; font-size: 12px; color: #64748B; line-height: 1.45; }
.material-entry { min-width: 74px; min-height: 42px; border-radius: 8px; background: #EAF3FF; border: 1px solid #BFDBFE; align-items: center; justify-content: center; padding: 6px 8px; }
.material-entry-label { font-size: 11px; color: #086CEA; font-weight: 900; }
.material-entry-count { margin-top: 2px; font-size: 10px; color: #1D4ED8; font-weight: 800; }
.stage-row { flex-direction: row; align-items: flex-start; margin-top: 13px; }
.stage { flex: 1; align-items: center; position: relative; min-width: 0; }
.stage::before { content: ''; position: absolute; top: 8px; left: 0; right: 50%; height: 2px; background: #E5E7EB; }
.stage::after { content: ''; position: absolute; top: 8px; left: 50%; right: 0; height: 2px; background: #E5E7EB; }
.stage:first-child::before, .stage:last-child::after { display: none; }
.stage-dot { width: 18px; height: 18px; border-radius: 9px; background: #E5E7EB; align-items: center; justify-content: center; z-index: 1; }
.stage-dot-text { font-size: 10px; color: #fff; font-weight: 900; line-height: 18px; }
.stage-title { margin-top: 5px; font-size: 10px; color: #64748B; font-weight: 800; text-align: center; }
.stage-done .stage-dot { background: #086CEA; }
.stage-done::before, .stage-done::after { background: #BFDBFE; }
.stage-current .stage-dot { background: #16A34A; box-shadow: 0 0 0 4px #DCFCE7; }
.stage-current .stage-title { color: #15803D; }
.stage-action .stage-dot { background: #F59E0B; box-shadow: 0 0 0 4px #FEF3C7; animation: progressPulse 1.1s ease-in-out infinite; }
.stage-action .stage-title { color: #B45309; }
.progress-alert { margin-top: 12px; border-radius: 8px; padding: 9px 10px; background: #EFF6FF; border: 1px solid #BFDBFE; }
.progress-alert-title { font-size: 12px; color: #1D4ED8; font-weight: 900; }
.progress-alert-text { margin-top: 3px; font-size: 11px; color: #475569; line-height: 1.45; }
.progress-alert-warning { background: #FFFBEB; border-color: #FDE68A; }
.progress-alert-warning .progress-alert-title { color: #B45309; }
.progress-alert-danger { background: #FEF2F2; border-color: #FECACA; }
.progress-alert-danger .progress-alert-title { color: #DC2626; }
.progress-alert-success { background: #F0FDF4; border-color: #BBF7D0; }
.progress-alert-success .progress-alert-title { color: #15803D; }
@keyframes progressPulse { 0%, 100% { transform: scale(.95); } 50% { transform: scale(1.12); } }
</style>
