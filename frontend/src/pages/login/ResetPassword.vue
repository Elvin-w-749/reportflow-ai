<template>
  <view class="page rpt-page">
    <view class="nav">
      <RptBackButton @click="goBack" />
      <text class="nav-title">重置密码</text>
      <view class="nav-spacer"></view>
    </view>

    <scroll-view class="scroll-body" scroll-y>
      <view class="wrap">
        <view class="brand">
          <text class="brand-title">通过短信重置密码</text>
          <text class="brand-sub">验证手机号后即可设置新的登录密码</text>
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
            v-model="code"
            label="验证码"
            type="tel"
            maxlength="6"
            placeholder="请输入验证码"
            class="rpt-field"
            input-align="right"
          >
            <template #button>
              <van-button
                size="small"
                type="primary"
                plain
                :disabled="counting > 0"
                class="code-van-btn"
                @click="sendCode"
              >{{ counting > 0 ? counting + 's' : '获取验证码' }}</van-button>
            </template>
          </van-field>

          <van-field
            v-model="newPassword"
            label="新密码"
            type="password"
            placeholder="至少 6 位"
            class="rpt-field"
            input-align="right"
          />
          <van-field
            v-model="confirm"
            label="确认新密码"
            type="password"
            placeholder="再次输入新密码"
            class="rpt-field"
            input-align="right"
          />

          <van-button
            type="primary"
            block
            round
            :loading="loading"
            :loading-text="loading ? '提交中…' : ''"
            class="submit-btn"
            @click="submit"
          >{{ loading ? '提交中…' : '重置密码' }}</van-button>

          <view class="foot">
            <text class="foot-hint">想起密码了？</text>
            <text class="foot-link" @click="goBack">返回登录</text>
          </view>
        </view>

        <view class="bottom-safe"></view>
      </view>
    </scroll-view>
  </view>
</template>

<script setup>
import { ref, onUnmounted } from 'vue'
import { resetPassword, sendSmsCode } from '@/services/authService.js'
import safeBack from '@/utils/safeBack.js'
import RptBackButton from '@/components/RptBackButton.vue'

const phone = ref('')
const code = ref('')
const newPassword = ref('')
const confirm = ref('')
const loading = ref(false)
const counting = ref(0)
let timer = null

const isValidPhone = (p) => /^1[3-9]\d{9}$/.test(String(p || '').trim())

const goBack = () => safeBack('/pages/login/index')

const startCountdown = (sec) => {
  counting.value = sec
  if (timer) clearInterval(timer)
  timer = setInterval(() => {
    counting.value -= 1
    if (counting.value <= 0) { clearInterval(timer); timer = null }
  }, 1000)
}

const sendCode = async () => {
  if (counting.value > 0) return
  if (!isValidPhone(phone.value)) { uni.showToast({ title: '请输入正确的手机号', icon: 'none' }); return }
  try {
    const res = await sendSmsCode(phone.value.trim(), 'reset-password')
    startCountdown(60)
    if (res && res.data && res.data.devCode) code.value = String(res.data.devCode)
    uni.showToast({ title: '验证码已发送', icon: 'none' })
  } catch (e) {
    uni.showToast({ title: (e && (e.message || e.errMsg)) || '发送失败', icon: 'none' })
  }
}

const submit = async () => {
  if (loading.value) return
  if (!isValidPhone(phone.value)) { uni.showToast({ title: '请输入正确的手机号', icon: 'none' }); return }
  if (!code.value) { uni.showToast({ title: '请输入验证码', icon: 'none' }); return }
  if (!newPassword.value || newPassword.value.length < 6) { uni.showToast({ title: '新密码至少 6 位', icon: 'none' }); return }
  if (newPassword.value !== confirm.value) { uni.showToast({ title: '两次密码不一致', icon: 'none' }); return }

  loading.value = true
  try {
    const res = await resetPassword(phone.value.trim(), code.value.trim(), newPassword.value)
    if (res && res.errCode === 0) {
      uni.showToast({ title: '密码已重置', icon: 'success' })
      setTimeout(() => {
        // 重置接口若已返回登录态则直接进首页，否则回登录页用新密码登录
        if (res.token || res.accessToken) {
          uni.reLaunch({ url: '/pages/home/home' })
        } else {
          uni.reLaunch({ url: '/pages/login/index' })
        }
      }, 600)
    } else {
      uni.showToast({ title: (res && res.errMsg) || '重置失败', icon: 'none' })
    }
  } catch (e) {
    uni.showToast({ title: (e && (e.message || e.errMsg)) || '重置失败', icon: 'none' })
  } finally {
    loading.value = false
  }
}

onUnmounted(() => { if (timer) { clearInterval(timer); timer = null } })
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

.code-van-btn { font-size: 12px; font-weight: 700; color: #086CEA; border-color: #BFDBFE; background: #EAF3FF; }
.code-van-btn[disabled] { background: #F1F3F6; color: #9CA3AF; border-color: #E5E7EB; }

.submit-btn { margin-top: 14px; height: 50px; font-size: 16px; font-weight: 800; background: #086CEA; border-color: #086CEA; }

.foot { flex-direction: row; align-items: center; margin-top: 18px; justify-content: center; }
.foot-hint { font-size: 13px; color: #9CA3AF; }
.foot-link { font-size: 13px; color: #086CEA; font-weight: 800; margin-left: 4px; }

.bottom-safe { height: 40px; }
</style>
