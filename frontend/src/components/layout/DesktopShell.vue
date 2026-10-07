<template>
  <div
    class="desktop-shell"
    :class="[
      hasSidebar ? `shell-side-${side}` : 'shell-no-side',
      hasSidebar ? `shell-mobile-${sidebarMobile}` : ''
    ]"
    :style="shellStyle"
  >
    <aside v-if="hasSidebar" class="shell-sidebar">
      <slot name="sidebar" />
    </aside>
    <main class="shell-main">
      <slot />
    </main>
  </div>
</template>

<script setup>
import { computed, useSlots } from 'vue'

const props = defineProps({
  /* 侧栏在桌面端的位置 */
  side: { type: String, default: 'left', validator: (v) => ['left', 'right'].includes(v) },
  /* 窄屏（<1024px）时侧栏内容：top=置顶显示，hidden=隐藏 */
  sidebarMobile: { type: String, default: 'top', validator: (v) => ['top', 'hidden'].includes(v) },
  /* 桌面端侧栏固定宽度 */
  sidebarWidth: { type: String, default: '320px' },
  /* 居中限宽 */
  maxWidth: { type: String, default: '1440px' }
})

const slots = useSlots()
const hasSidebar = computed(() => !!slots.sidebar)
const shellStyle = computed(() => ({
  '--shell-max-w': props.maxWidth,
  '--shell-sidebar-w': props.sidebarWidth
}))
</script>

<style scoped>
/* 桌面壳：居中限宽 + 可选侧栏。布局切换纯 CSS @media，无 JS resize 监听 */
.desktop-shell {
  width: 100%;
  max-width: var(--shell-max-w, 1440px);
  margin-left: auto;
  margin-right: auto;
  display: flex;
  flex-direction: column;
  gap: var(--rpt-space-4);
  min-height: 0;
}

.shell-sidebar,
.shell-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

/* 窄屏：单栏，侧栏置顶（DOM 顺序即 sidebar 在前）或隐藏 */
@media (max-width: 1023.98px) {
  .shell-mobile-hidden .shell-sidebar { display: none; }
}

/* ≥1024px：Grid 双栏，侧栏定宽、主区自适应 */
@media (min-width: 1024px) {
  .desktop-shell {
    display: grid;
    grid-template-areas: 'sidebar main';
    grid-template-columns: var(--shell-sidebar-w, 320px) minmax(0, 1fr);
    gap: var(--rpt-space-5);
    align-items: start;
  }
  .shell-side-right {
    grid-template-areas: 'main sidebar';
    grid-template-columns: minmax(0, 1fr) var(--shell-sidebar-w, 320px);
  }
  .shell-no-side {
    display: grid;
    grid-template-areas: 'main';
    grid-template-columns: minmax(0, 1fr);
  }
  .shell-sidebar {
    grid-area: sidebar;
    position: sticky;
    top: var(--rpt-space-4);
  }
  .shell-main { grid-area: main; }
}
</style>
