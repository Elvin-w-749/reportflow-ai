<template>
  <view class="page rpt-page">
    <view class="nav">
      <RptBackButton @click="goBack" />
      <text class="nav-title">{{ doc.title }}</text>
      <view class="nav-spacer"></view>
    </view>

    <scroll-view class="scroll-body" scroll-y>
      <view class="wrap rpt-content-narrow">
        <view class="doc-card">
          <text class="doc-kicker">{{ doc.kicker }}</text>
          <text class="doc-title">{{ doc.title }}</text>
          <text class="doc-sub">{{ doc.sub }}</text>
        </view>

        <view class="notice">
          <text class="notice-title">发布候选版本</text>
          <text class="notice-text">本页面已接入当前协议文本，正式上架前请以运营主体最终确认版本为准。</text>
        </view>

        <view class="content">
          <view v-for="(block, index) in blocks" :key="index" :class="['block', 'block-' + block.type]">
            <text class="block-text">{{ block.text }}</text>
          </view>
        </view>

        <view class="bottom-safe rpt-page-bottom"></view>
      </view>
    </scroll-view>
  </view>
</template>

<script setup>
import { computed } from 'vue'
import safeBack from '@/utils/safeBack.js'
import RptBackButton from '@/components/RptBackButton.vue'
import userAgreement from '../../../docs/USER_AGREEMENT.md?raw'

const docs = {
  agreement: {
    title: '用户协议',
    kicker: 'User Agreement',
    sub: '说明账号使用、信用报告分析、顾问服务和用户责任边界。',
    source: userAgreement
  }
}

const doc = computed(() => docs.agreement)

const normalizeMarkdown = (source) => String(source || '')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !/^\|?\s*-{3,}/.test(line))
  .map((line) => {
    if (line.startsWith('# ')) return { type: 'title', text: line.replace(/^#\s+/, '') }
    if (line.startsWith('## ')) return { type: 'section', text: line.replace(/^##\s+/, '') }
    if (/^\d+\.\s+/.test(line)) return { type: 'list', text: line }
    if (line.startsWith('>')) return { type: 'quote', text: line.replace(/^>\s*/, '') }
    if (line.includes('|')) return { type: 'table', text: line.replace(/^\||\|$/g, '').split('|').map((item) => item.trim()).join(' / ') }
    return { type: 'paragraph', text: line }
  })

const blocks = computed(() => normalizeMarkdown(doc.value.source))

const goBack = () => safeBack('/pages/profile/profile')
</script>

<style scoped>
.page { min-height: 100vh; background: #F5F6FA; }
.nav { flex-direction: row; align-items: center; padding: calc(var(--rpt-safe-top) + 8px) 14px 8px; background: #fff; border-bottom: 1px solid #EEF0F4; }
.nav-title { flex: 1; text-align: center; font-size: 16px; font-weight: 900; color: #111827; }
.nav-spacer { width: 32px; }
.scroll-body { flex: 1; height: 100vh; }
.wrap { padding: 14px 16px 16px; }
.doc-card { background: #fff; border: 1px solid #EEF0F4; border-radius: 8px; padding: 18px; }
.doc-kicker { font-size: 12px; color: #086CEA; font-weight: 900; }
.doc-title { margin-top: 8px; font-size: 24px; color: #111827; font-weight: 900; }
.doc-sub { margin-top: 10px; font-size: 13px; color: #6B7280; line-height: 1.6; }
.notice { margin-top: 12px; padding: 13px 14px; border-radius: 8px; background: #FFF7ED; border: 1px solid #FED7AA; }
.notice-title { font-size: 13px; color: #9A3412; font-weight: 900; }
.notice-text { margin-top: 5px; font-size: 12px; color: #9A3412; line-height: 1.5; }
.content { margin-top: 12px; background: #fff; border: 1px solid #EEF0F4; border-radius: 8px; padding: 16px; }
.block { margin-bottom: 10px; }
.block-title { display: none; }
.block-section { margin-top: 16px; margin-bottom: 8px; }
.block-text { font-size: 13px; color: #4B5563; line-height: 1.7; }
.block-section .block-text { font-size: 16px; color: #111827; font-weight: 900; }
.block-list .block-text { color: #374151; }
.block-quote { padding: 10px 12px; border-radius: 8px; background: #EAF3FF; border: 1px solid #BFDBFE; }
.block-quote .block-text { color: #1E3A8A; font-weight: 800; }
.block-table { padding: 9px 10px; border-radius: 8px; background: #F8FAFC; }
.block-table .block-text { font-size: 12px; color: #475569; }
.bottom-safe { height: 40px; }
</style>
