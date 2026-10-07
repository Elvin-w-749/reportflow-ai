<template>
  <view v-if="visible" class="prompt-mask" @click="close">
    <view class="prompt-panel" @click.stop>
      <view class="prompt-head">
        <view class="prompt-icon"><text class="prompt-icon-text">☏</text></view>
        <view class="prompt-title-wrap">
          <text class="prompt-title">顾问文字咨询</text>
          <text class="prompt-sub">{{ subtitle }}</text>
        </view>
        <view class="prompt-close" @click="close"><text class="prompt-close-text">×</text></view>
      </view>

      <view class="quick-row">
        <view v-for="item in quickTexts" :key="item" class="quick-chip" @click="useQuick(item)">
          <text class="quick-chip-text">{{ item }}</text>
        </view>
      </view>

      <textarea
        v-model.trim="draft"
        class="prompt-input"
        maxlength="500"
        auto-height
        placeholder="输入你想问顾问的问题"
      />

      <view class="prompt-actions">
        <view class="prompt-secondary" @click="close"><text class="prompt-secondary-text">取消</text></view>
        <view class="prompt-primary" :class="{ disabled: !draft || loading }" @click="submit">
          <text class="prompt-primary-text">{{ loading ? '创建中' : '开始聊天' }}</text>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, watch } from 'vue'

const props = defineProps({
  visible: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  subtitle: { type: String, default: '留下问题后进入会话，顾问会用文字回复你。' }
})
const emit = defineEmits(['close', 'submit'])
const draft = ref('')
const quickTexts = ['申请顺序怎么排', '信用分怎么提升', '先处理哪些风险']

watch(() => props.visible, (value) => {
  if (value) draft.value = ''
})

const close = () => {
  if (props.loading) return
  emit('close')
}
const useQuick = (text) => {
  draft.value = text
}
const submit = () => {
  if (!draft.value || props.loading) return
  emit('submit', draft.value)
}
</script>

<style scoped>
.prompt-mask { position: fixed; left: 0; right: 0; top: 0; bottom: 0; z-index: 1200; background: rgba(15, 23, 42, 0.28); justify-content: flex-end; }
.prompt-panel { background: #fff; border-radius: 18px 18px 0 0; padding: 18px 16px calc(var(--rpt-safe-bottom) + 16px); border: 1px solid rgba(219, 234, 254, 0.96); box-shadow: 0 -18px 48px rgba(17, 44, 86, 0.18); }
.prompt-head { flex-direction: row; align-items: center; }
.prompt-icon { width: 46px; height: 46px; border-radius: 23px; background: #EAF3FF; align-items: center; justify-content: center; margin-right: 12px; border: 1px solid #DBEAFE; }
.prompt-icon-text { font-size: 24px; color: #0878F2; font-weight: 900; }
.prompt-title-wrap { flex: 1; }
.prompt-title { font-size: 18px; color: #071B3A; font-weight: 900; }
.prompt-sub { margin-top: 3px; font-size: 12px; color: #7A879A; line-height: 1.45; }
.prompt-close { width: 34px; height: 34px; border-radius: 17px; background: #F4F8FF; align-items: center; justify-content: center; }
.prompt-close-text { font-size: 22px; color: #8EA0B8; line-height: 1; }
.quick-row { flex-direction: row; flex-wrap: wrap; margin-top: 16px; }
.quick-chip { height: 30px; padding: 0 10px; border-radius: 15px; background: #F4F8FF; border: 1px solid #E2ECFA; align-items: center; justify-content: center; margin-right: 8px; margin-bottom: 8px; }
.quick-chip-text { font-size: 12px; color: #1D4ED8; font-weight: 800; }
.prompt-input { width: 100%; min-height: 96px; border-radius: 12px; background: #F8FBFF; border: 1px solid #DCE8F8; padding: 12px; font-size: 14px; color: #071B3A; line-height: 1.55; }
.prompt-actions { flex-direction: row; margin-top: 14px; }
.prompt-secondary,
.prompt-primary { flex: 1; height: 44px; border-radius: 12px; align-items: center; justify-content: center; }
.prompt-secondary { background: #F4F8FF; border: 1px solid #E2ECFA; margin-right: 10px; }
.prompt-secondary-text { color: #52627A; font-size: 14px; font-weight: 900; }
.prompt-primary { background: linear-gradient(135deg, #1DA1FF 0%, #0878F2 100%); box-shadow: 0 10px 22px rgba(8, 120, 242, 0.24); }
.prompt-primary.disabled { background: #CBD5E1; box-shadow: none; }
.prompt-primary-text { color: #fff; font-size: 14px; font-weight: 900; }
</style>
