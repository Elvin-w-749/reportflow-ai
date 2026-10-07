<template>
  <view class="swipe-delete" :class="{ 'swipe-delete-open': isOpen }">
    <view class="swipe-action" :style="{ width: `${actionWidth}px` }" @click.stop="emitDelete">
      <text class="swipe-action-text">{{ actionText }}</text>
    </view>
    <view
      class="swipe-content"
      :style="{ transform: `translateX(${offsetX}px)` }"
      @touchstart="onTouchStart"
      @touchmove="onTouchMove"
      @touchend="onTouchEnd"
      @touchcancel="onTouchEnd"
      @click="onContentClick"
    >
      <slot />
    </view>
  </view>
</template>

<script setup>
import { ref } from 'vue'

const props = defineProps({
  actionText: { type: String, default: '删除' },
  actionWidth: { type: Number, default: 76 },
  disabled: { type: Boolean, default: false }
})

const emit = defineEmits(['delete', 'content-click'])

const offsetX = ref(0)
const isOpen = ref(false)
let startX = 0
let startY = 0
let swiping = false
let moved = false

const pointOf = (event = {}) => {
  const point = event.touches && event.touches[0] ? event.touches[0] : event.changedTouches && event.changedTouches[0]
  return point || { clientX: 0, clientY: 0 }
}

const close = () => {
  offsetX.value = 0
  isOpen.value = false
}

const open = () => {
  offsetX.value = -Math.abs(props.actionWidth)
  isOpen.value = true
}

const onTouchStart = (event) => {
  if (props.disabled) return
  const point = pointOf(event)
  startX = point.clientX
  startY = point.clientY
  swiping = false
  moved = false
}

const onTouchMove = (event) => {
  if (props.disabled) return
  const point = pointOf(event)
  const dx = point.clientX - startX
  const dy = point.clientY - startY
  const absX = Math.abs(dx)
  const absY = Math.abs(dy)
  if (!swiping && absX < 12 && absY < 12) return
  if (!swiping && absY >= absX) return
  if (!swiping && absX < absY * 1.2) return
  swiping = true
  moved = true
  if (event && typeof event.preventDefault === 'function' && event.cancelable !== false) event.preventDefault()
  if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
  const base = isOpen.value ? -Math.abs(props.actionWidth) : 0
  const next = Math.max(-Math.abs(props.actionWidth), Math.min(0, base + dx))
  offsetX.value = next
}

const onTouchEnd = () => {
  if (props.disabled || !swiping) return
  if (offsetX.value < -Math.abs(props.actionWidth) * 0.45) open()
  else close()
  setTimeout(() => { moved = false }, 80)
}

const onContentClick = () => {
  if (props.disabled) return emit('content-click')
  if (moved) return
  if (isOpen.value) return close()
  emit('content-click')
}

const emitDelete = () => {
  if (props.disabled) return
  close()
  emit('delete')
}
</script>

<style scoped>
.swipe-delete { position: relative; overflow: hidden; margin-bottom: 10px; touch-action: pan-y; }
.swipe-action { position: absolute; top: 0; right: 0; bottom: 0; background: #EF4444; border-radius: 8px; align-items: center; justify-content: center; }
.swipe-action-text { color: #fff; font-size: 13px; font-weight: 900; }
.swipe-content { transition: transform .18s ease; touch-action: pan-y; will-change: transform; }
.swipe-delete-open .swipe-content { transition: transform .16s ease; }
</style>
