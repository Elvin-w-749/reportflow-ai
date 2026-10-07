<template>
  <view class="page rpt-page">
    <view class="nav">
      <RptBackButton @click="goBack" />
      <text class="nav-title">登录</text>
      <view class="nav-spacer"></view>
    </view>

    <scroll-view class="scroll-body" scroll-y>
      <view class="wrap">
        <view class="brand">
          <text class="brand-title">欢迎使用分析报告工作台</text>
          <text class="brand-sub">登录后可上传信用报告、生成信用画像</text>
        </view>

        <view class="tabs">
          <view class="tab" :class="{ 'tab-active': mode === 'password' }" @click="mode = 'password'">
            <text class="tab-text" :class="{ 'tab-text-active': mode === 'password' }">密码登录</text>
          </view>
          <view class="tab" :class="{ 'tab-active': mode === 'sms' }" @click="mode = 'sms'">
            <text class="tab-text" :class="{ 'tab-text-active': mode === 'sms' }">验证码登录</text>
          </view>
        </view>

        <view class="form">
          <van-field
            v-model="phone"
            :label="mode === 'password' ? '手机号/账号' : '手机号'"
            :type="mode === 'password' ? 'text' : 'tel'"
            :maxlength="mode === 'password' ? 32 : 11"
            :placeholder="mode === 'password' ? '请输入手机号或账号' : '请输入手机号'"
            class="rpt-field"
            label-class="rpt-field-label"
            input-align="right"
          />

          <van-field
            v-if="mode === 'password'"
            v-model="password"
            label="密码"
            type="password"
            placeholder="请输入密码"
            class="rpt-field"
            label-class="rpt-field-label"
            input-align="right"
          >
            <template #extra>
              <text class="forgot-link" @click="goForgot">忘记密码？</text>
            </template>
          </van-field>

          <van-field
            v-else
            v-model="code"
            label="验证码"
            type="tel"
            maxlength="6"
            placeholder="请输入验证码"
            class="rpt-field"
            label-class="rpt-field-label"
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
            :loading-text="loading ? '登录中…' : ''"
            class="submit-btn"
            @click="submit"
          >{{ loading ? '登录中…' : '登录' }}</van-button>

          <view class="foot">
            <text class="foot-link" @click="goRegister">注册新账号</text>
            <text class="foot-sep">·</text>
            <text class="foot-hint">未注册手机号验证码登录将自动注册</text>
          </view>
        </view>

        <view class="bottom-safe"></view>
      </view>
    </scroll-view>
  </view>
</template>

<script setup>
import { ref, onUnmounted } from 'vue'
import { login, loginBySmsCode, sendLoginSmsCode } from '@/services/authService.js'
import safeBack from '@/utils/safeBack.js'
import RptBackButton from '@/components/RptBackButton.vue'

const mode = ref('password')
const phone = ref('')
const password = ref('')
const code = ref('')
const loading = ref(false)
const agreed = ref(false)
const counting = ref(0)
let timer = null

const isValidPhone = (p) => /^1[3-9]\d{9}$/.test(String(p || '').trim())
const isValidLoginAccount = (p) => {
  const value = String(p || '').trim()
  return isValidPhone(value) || /^[A-Za-z][A-Za-z0-9_]{2,31}$/.test(value)
}

const goBack = () => safeBack('/pages/home/home')
const goRegister = () => uni.navigateTo({ url: '/pages/login/register', fail: () => { uni.showToast({ title: '无法打开注册页', icon: 'none' }) } })
const goForgot = () => uni.navigateTo({ url: '/pages/login/reset-password', fail: () => { uni.showToast({ title: '无法打开重置密码页', icon: 'none' }) } })
const openLegal = (kind) => uni.navigateTo({ url: `/pages/legal/document?type=${kind}`, fail: () => { uni.showToast({ title: '无法打开文档', icon: 'none' }) } })

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
  if (mode.value === 'password' && !isValidLoginAccount(phone.value)) { uni.showToast({ title: '请输入正确的手机号或账号', icon: 'none' }); return }
  if (mode.value === 'sms' && !isValidPhone(phone.value)) { uni.showToast({ title: '请输入正确的手机号', icon: 'none' }); return }
  try {
    const res = await sendLoginSmsCode(phone.value.trim())
    startCountdown(60)
    if (res && res.data && res.data.devCode) code.value = String(res.data.devCode)
    uni.showToast({ title: '验证码已发送', icon: 'none' })
  } catch (e) {
    uni.showToast({ title: (e && (e.message || e.errMsg)) || '发送失败', icon: 'none' })
  }
}

const landingUrlForRole = (role) => {
  const r = String(role || '').trim().toLowerCase()
  if (r === 'service') return '/pages/service/workbench'
  if (r === 'advisor') return '/pages/teacher/workbench'
  if (r === 'admin') return '/pages/admin/workbench'
  return '/pages/home/home'
}

const onSuccess = (res = {}) => {
  const role = res && res.userInfo ? res.userInfo.role : ''
  const url = landingUrlForRole(role)
  uni.showToast({ title: '登录成功', icon: 'success' })
  setTimeout(() => {
    uni.reLaunch({ url })
  }, 600)
}

const submit = async () => {
  if (loading.value) return
  if (!agreed.value) { uni.showToast({ title: '请先阅读并同意协议', icon: 'none' }); return }
  if (mode.value === 'password' && !isValidLoginAccount(phone.value)) { uni.showToast({ title: '请输入正确的手机号或账号', icon: 'none' }); return }
  if (mode.value === 'sms' && !isValidPhone(phone.value)) { uni.showToast({ title: '请输入正确的手机号', icon: 'none' }); return }
  if (mode.value === 'password' && !password.value) { uni.showToast({ title: '请输入密码', icon: 'none' }); return }
  if (mode.value === 'sms' && !code.value) { uni.showToast({ title: '请输入验证码', icon: 'none' }); return }

  loading.value = true
  try {
    const res = mode.value === 'password'
      ? await login(phone.value.trim(), password.value)
      : await loginBySmsCode(phone.value.trim(), code.value.trim())
    if (res && (res.errCode === 0 || res.token)) {
      onSuccess(res)
    } else {
      uni.showToast({ title: (res && res.errMsg) || '登录失败', icon: 'none' })
    }
  } catch (e) {
    uni.showToast({ title: (e && (e.message || e.errMsg)) || '登录失败', icon: 'none' })
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

.brand { margin-bottom: 28px; }
.brand-title { display: block; font-size: 24px; font-weight: 900; color: #111827; }
.brand-sub { display: block; margin-top: 8px; font-size: 13px; color: #9CA3AF; }

.tabs { flex-direction: row; margin-bottom: 20px; }
.tab { margin-right: 24px; padding-bottom: 6px; border-bottom: 2px solid transparent; }
.tab-active { border-bottom-color: #086CEA; }
.tab-text { font-size: 16px; color: #9CA3AF; font-weight: 700; }
.tab-text-active { color: #111827; }

.form { }
.forgot-link { font-size: 13px; color: #086CEA; font-weight: 800; }

.rpt-field { margin-bottom: 16px; background: rgba(248,251,255,0.95); border: 1px solid #DCE8F8; border-radius: 8px; overflow: hidden; }
.rpt-field :deep(.van-field__label) { font-size: 13px; color: #6B7280; width: auto; }
.rpt-field :deep(.van-field__control) { font-size: 15px; color: #111827; }
.rpt-field :deep(.van-field__control::placeholder) { color: #C7CBD1; }
.rpt-field :deep(.van-cell) { padding: 12px 14px; background: transparent; }

.code-van-btn { font-size: 12px; font-weight: 700; color: #086CEA; border-color: #BFDBFE; background: #EAF3FF; }
.code-van-btn[disabled] { background: #F1F3F6; color: #9CA3AF; border-color: #E5E7EB; }

.agreement-row { flex-direction: row; align-items: flex-start; margin-top: 4px; margin-bottom: 12px; }
.rpt-checkbox { margin-right: 8px; flex-shrink: 0; }
.agreement-copy { flex: 1; flex-direction: row; flex-wrap: wrap; }
.agreement-text { font-size: 12px; color: #9CA3AF; line-height: 18px; }
.agreement-link { font-size: 12px; color: #086CEA; font-weight: 900; line-height: 18px; }

.submit-btn { margin-top: 14px; height: 50px; font-size: 16px; font-weight: 800; background: #086CEA; border-color: #086CEA; }

.foot { flex-direction: row; align-items: center; flex-wrap: wrap; margin-top: 18px; }
.foot-link { font-size: 13px; color: #086CEA; font-weight: 800; }
.foot-sep { margin: 0 8px; color: #D1D5DB; font-size: 13px; }
.foot-hint { font-size: 12px; color: #9CA3AF; }

.bottom-safe { height: 40px; }
</style>
