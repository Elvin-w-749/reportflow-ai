<template>
  <div
    class="rpt-scroll-view"
    :class="{ 'rpt-scroll-x': scrollX, 'rpt-scroll-y': scrollY !== false }"
    @scroll="onScroll"
  >
    <slot />
  </div>
</template>

<script setup>
const props = defineProps({
  scrollY: { type: [Boolean, String], default: false },
  scrollX: { type: [Boolean, String], default: false },
  scrollIntoView: { type: String, default: '' },
  scrollWithAnimation: { type: [Boolean, String], default: false },
  refresherEnabled: { type: [Boolean, String], default: false },
  refresherTriggered: { type: [Boolean, String], default: false }
})
const emit = defineEmits(['scroll', 'scrolltolower', 'refresherrefresh'])

function onScroll(e) {
  const t = e.target
  emit('scroll', {
    detail: { scrollTop: t.scrollTop, scrollLeft: t.scrollLeft, scrollHeight: t.scrollHeight }
  })
  if (t.scrollHeight - t.scrollTop - t.clientHeight < 40) {
    emit('scrolltolower', {})
  }
}
</script>

<style>
.rpt-scroll-view {
  display: flex;
  flex-direction: column;
  width: 100%;
}
.rpt-scroll-y {
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
.rpt-scroll-x {
  flex-direction: row;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
</style>
