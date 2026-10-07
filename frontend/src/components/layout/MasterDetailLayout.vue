<template>
  <div
    class="md-layout"
    :class="[`md-active-${activePane}`, { 'md-single-column': singleColumn }]"
    :style="layoutStyle"
  >
    <section class="md-master">
      <slot name="master" />
    </section>
    <section class="md-detail">
      <slot name="detail" />
    </section>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  /* <1024px 单栏时显示的面板：master=列表，detail=详情（页面用返回按钮切换） */
  activePane: { type: String, default: 'master', validator: (v) => ['master', 'detail'].includes(v) },
  /* 桌面端 master 栏固定宽度（建议 320px-380px） */
  masterWidth: { type: String, default: '360px' },
  /* 无论窗口宽度如何都保持单栏，由 activePane 决定显示列表或详情 */
  singleColumn: { type: Boolean, default: false }
})

const layoutStyle = computed(() => ({ '--md-master-w': props.masterWidth }))
</script>

<style scoped>
/* 列表+详情双栏：≥1024px 双栏并排，<1024px 由 activePane 决定单栏内容。
 * 布局切换纯 CSS @media，无 JS resize 监听 */
.md-layout {
  width: 100%;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.md-master,
.md-detail {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.md-single-column.md-active-master .md-detail { display: none; }
.md-single-column.md-active-detail .md-master { display: none; }

/* 窄屏：单栏，只显示 activePane 指定面板 */
@media (max-width: 1023.98px) {
  .md-active-master .md-detail { display: none; }
  .md-active-detail .md-master { display: none; }
}

/* ≥1024px：双栏，master 定宽、detail 自适应；两栏各自可滚动 */
@media (min-width: 1024px) {
  .md-layout:not(.md-single-column) {
    display: grid;
    grid-template-columns: var(--md-master-w, 360px) minmax(0, 1fr);
    gap: var(--rpt-space-4);
    align-items: stretch;
  }
  .md-layout:not(.md-single-column) > .md-master,
  .md-layout:not(.md-single-column) > .md-detail {
    flex: none;
    overflow-y: auto;
  }
}
</style>
