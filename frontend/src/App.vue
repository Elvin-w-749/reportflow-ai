<template>
  <router-view v-slot="{ Component }">
    <component :is="Component" />
  </router-view>
  <TabBar v-if="showTab" />
  <UniOverlay />
</template>

<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import TabBar from './components/TabBar.vue'
import UniOverlay from './compat/components/UniOverlay.vue'

const route = useRoute()
const showTab = computed(() => !!route.meta && route.meta.tab === true)
</script>
