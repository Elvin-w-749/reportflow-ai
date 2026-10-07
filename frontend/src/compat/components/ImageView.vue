<template>
  <img class="rpt-image" :src="src" :style="fitStyle" @error="onError" @load="$emit('load', $event)" />
</template>

<script setup>
import { computed } from 'vue'
const props = defineProps({
  src: { type: String, default: '' },
  mode: { type: String, default: 'scaleToFill' }
})
const emit = defineEmits(['error', 'load'])

const fitStyle = computed(() => {
  switch (props.mode) {
    case 'aspectFill': return { objectFit: 'cover' }
    case 'aspectFit': return { objectFit: 'contain' }
    case 'widthFix': return { width: '100%', height: 'auto' }
    case 'heightFix': return { height: '100%', width: 'auto' }
    default: return { objectFit: 'fill' }
  }
})
function onError(e) { emit('error', e) }
</script>

<style>
.rpt-image { display: block; }
</style>
