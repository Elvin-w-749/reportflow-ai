<template>
  <div class="uni-overlay-root">
    <!-- Toast / Loading / Modal 已由 Vant 4 命令式 API 渲染，此处仅保留 ActionSheet -->

    <!-- ActionSheet -->
    <transition name="slide-up">
      <div v-if="s.actionSheet" class="uni-as-mask" @click.self="s.actionSheet.resolve(-1)">
        <div class="uni-as-panel">
          <div
            v-for="(item, i) in s.actionSheet.itemList"
            :key="i"
            class="uni-as-item"
            @click="s.actionSheet.resolve(i)"
          >{{ item }}</div>
          <div class="uni-as-cancel" @click="s.actionSheet.resolve(-1)">取消</div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup>
import { overlayState } from '../overlay.js'
const s = overlayState
</script>

<style scoped>
.uni-as-mask {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: rgba(0,0,0,0.5);
}
.uni-as-panel { width: 100%; background: #F2F3F5; }
.uni-as-item { background: #fff; text-align: center; padding: 15px 0; font-size: 16px; color: #111827; border-bottom: 1px solid #F2F3F5; }
.uni-as-cancel { margin-top: 8px; background: #fff; text-align: center; padding: 15px 0; font-size: 16px; font-weight: 700; color: #111827; }

.slide-up-enter-active, .slide-up-leave-active { transition: opacity 0.2s; }
.slide-up-enter-from, .slide-up-leave-to { opacity: 0; }
</style>
