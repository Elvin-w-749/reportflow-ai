<template>
  <view
    class="rpt-backbtn rpt-backbtn-light rpt-centered-back"
    role="button"
    tabindex="0"
    :aria-label="label"
    @click="activate"
    @keydown.enter.prevent="activate"
    @keydown.space.prevent="activate"
  >
    <RptChevron class="rpt-centered-back-icon" direction="left" />
  </view>
</template>

<script setup>
import RptChevron from '@/components/RptChevron.vue'

defineProps({
  label: { type: String, default: '返回' }
})

const emit = defineEmits(['click'])
const activate = (event) => emit('click', event)
</script>

<style scoped>
.rpt-centered-back {
  width: 64rpx;
  height: 64rpx;
  padding: 0;
  box-sizing: border-box;
  display: flex;
  flex: 0 0 auto;
  flex-direction: row;
  align-items: center;
  justify-content: center;
}

.rpt-centered-back-icon {
  width: 30rpx;
  height: 30rpx;
  color: var(--rpt-color-text-primary);
}
</style>
