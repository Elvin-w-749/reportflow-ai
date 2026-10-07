<template>
  <view class="page rpt-page">
    <view class="nav">
      <RptBackButton @click="goBack" />
      <text class="nav-title">注册</text>
      <view class="nav-spacer"></view>
    </view>

    <scroll-view class="scroll-body" scroll-y>
      <view class="wrap">
        <view class="brand">
          <text class="brand-title">创建分析报告工作台账号</text>
          <text class="brand-sub">注册成功后将自动登录</text>
        </view>

        <view class="form">
          <van-field
            v-model="phone"
            label="手机号"
            type="tel"
            maxlength="11"
            placeholder="请输入手机号"
            class="rpt-field"
            input-align="right"
          />
          <van-field
            v-model="nickname"
            label="昵称（选填）"
            maxlength="20"
            placeholder="请输入昵称"
            class="rpt-field"
            input-align="right"
          />
          <van-field
            v-model="password"
            label="密码"
            type="password"
            placeholder="至少 6 位"
            class="rpt-field"
            input-align="right"
          />
          <van-field
            v-model="confirm"
            label="确认密码"
            type="password"
            placeholder="再次输入密码"
            class="rpt-field"
            input-align="right"
          />

          <view class="agreement-row">
            <van-checkbox v-model="agreed" shape="square" class="rpt-checkbox" icon-size="18px" />
            <view class="agreement-copy">
              <text class="agreement-text">我已阅读并同意</text>
              <text class="agreement-link" @click.stop="openLegal('agreement')">《用户协议》</text>
            </view>
          </view>

          <van-button
            type="primary"
            block
            round
            :loading="loading"
            :loading-text="loading ? '注册中…' : ''"
            class="submit-btn"
            @click="submit"
          >{{ loading ? '注册中…' : '注册并登录' }}</van-button>

          <view class="foot">
            <text class="foot-hint">已有账号？</text>
            <text class="foot-link" @click="goBack">返回登录</text>
          </view>
        </view>

        <view class="bottom-safe"></view>
      </view>
    </scroll-view>
  </view>
</template>

<script setup>
import { ref } from 'vue'
import { register } from '@/services/authService.js'
import safeBack from '@/utils/safeBack.js'
import RptBackButton from '@/components/RptBackButton.vue'

const phone = ref('')
const nickname = ref('')
const password = ref('')
const confirm = ref('')
const agreed = ref(false)
const loading = ref(false)

const isValidPhone = (p) => /^1[3-9]\d{9}$/.test(String(p || '').trim())

const goBack = () => safeBack('/pages/login/index')
const openLegal = (kind) => uni.navigateTo({ url: `/pages/legal/document?type=${kind}`, fail: () => { uni.showToast({ title: '无法打开文档', icon: 'none' }) } })

const submit = async () => {
  if (loading.value) return
  if (!agreed.value) { uni.showToast({ title: '请先阅读并同意协议', icon: 'none' }); return }
  if (!isValidPhone(phone.value)) { uni.showToast({ title: '请输入正确的手机号', icon: 'none' }); return }
  if (!password.value || password.value.length < 6) { uni.showToast({ title: '密码至少 6 位', icon: 'none' }); return }
  if (password.value !== confirm.value) { uni.showToast({ title: '两次密码不一致', icon: 'none' }); return }

  loading.value = true
  try {
    const res = await register(phone.value.trim(), password.value, (nickname.value || '').trim())
    if (res && (res.errCode === 0 || res.token)) {
      uni.showToast({ title: '注册成功', icon: 'success' })
      setTimeout(() => { uni.reLaunch({ url: '/pages/home/home' }) }, 600)
    } else {
      uni.showToast({ title: (res && res.errMsg) || '注册失败', icon: 'none' })
    }
  } catch (e) {
    uni.showToast({ title: (e && (e.message || e.errMsg)) || '注册失败', icon: 'none' })
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.page { min-height: 100vh; background: #F5F6FA; }
.nav { flex-direction: row; align-items: center; padding: calc(var(--rpt-safe-top) + 8px) 14px 8px; background: #fff; border-bottom: 1px solid #EEF0F4; }
.nav-title { flex: 1; text-align: center; font-size: 16px; font-weight: 800; color: #111827; }
.nav-spacer { width: 32px; }
.scroll-body { flex: 1; height: 100vh; }
.wrap { padding: 24px 20px; }

.brand { margin-bottom: 24px; }
.brand-title { display: block; font-size: 24px; font-weight: 900; color: #111827; }
.brand-sub { display: block; margin-top: 8px; font-size: 13px; color: #9CA3AF; }

.rpt-field { margin-bottom: 16px; background: rgba(248,251,255,0.95); border: 1px solid #DCE8F8; border-radius: 8px; overflow: hidden; }
.rpt-field :deep(.van-field__label) { font-size: 13px; color: #6B7280; width: auto; }
.rpt-field :deep(.van-field__control) { font-size: 15px; color: #111827; }
.rpt-field :deep(.van-field__control::placeholder) { color: #C7CBD1; }
.rpt-field :deep(.van-cell) { padding: 12px 14px; background: transparent; }

.agreement-row { flex-direction: row; align-items: flex-start; margin-top: 2px; margin-bottom: 12px; }
.rpt-checkbox { margin-right: 8px; flex-shrink: 0; }
.agreement-copy { flex: 1; flex-direction: row; flex-wrap: wrap; }
.agreement-text { font-size: 12px; color: #9CA3AF; line-height: 18px; }
.agreement-link { font-size: 12px; color: #086CEA; font-weight: 900; line-height: 18px; }

.submit-btn { margin-top: 14px; height: 50px; font-size: 16px; font-weight: 800; background: #086CEA; border-color: #086CEA; }

.foot { flex-direction: row; align-items: center; margin-top: 18px; justify-content: center; }
.foot-hint { font-size: 13px; color: #9CA3AF; }
.foot-link { font-size: 13px; color: #086CEA; font-weight: 800; margin-left: 4px; }

.bottom-safe { height: 40px; }
</style>
