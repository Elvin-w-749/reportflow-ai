<template>
  <view class="page rpt-page">
    <view class="nav">
      <RptBackButton @click="goBack" />
      <text class="nav-title">{{ hasPassword ? '修改密码' : '设置密码' }}</text>
      <view class="nav-spacer"></view>
    </view>

    <scroll-view class="scroll-body" scroll-y>
      <view class="wrap">
        <view class="brand">
          <text class="brand-title">{{ hasPassword ? '修改登录密码' : '设置登录密码' }}</text>
          <text class="brand-sub">{{ hasPassword ? '修改成功后请牢记新密码，下次登录使用' : '设置后可使用手机号+密码登录' }}</text>
        </view>

        <view class="form">
          <van-field
            v-if="hasPassword"
            v-model="oldPassword"
            label="原密码"
            type="password"
            placeholder="请输入原密码"
            class="rpt-field"
            input-align="right"
          />
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
          >{{ loading ? '提交中…' : '确认' }}</van-button>
        </view>

        <view class="bottom-safe"></view>
      </view>
    </scroll-view>
  </view>
</template>

<script setup>
import { ref } from 'vue'
import { onShow } from '@/compat/web-lifecycle.js'
import { changePassword, getCurrentUser, getCachedUserInfo, isLoggedIn } from '@/services/authService.js'
import safeBack from '@/utils/safeBack.js'
import RptBackButton from '@/components/RptBackButton.vue'

const hasPassword = ref(true)
const oldPassword = ref('')
const newPassword = ref('')
const confirm = ref('')
const loading = ref(false)

const goBack = () => safeBack('/pages/profile/profile')

const resolveHasPassword = (info) => {
  if (!info || typeof info !== 'object') return true
  if (info.hasPassword != null) return !!info.hasPassword
  if (info.passwordSet != null) return !!info.passwordSet
  return true
}

const refresh = async () => {
  if (!isLoggedIn()) {
    uni.showToast({ title: '请先登录', icon: 'none' })
    setTimeout(() => uni.reLaunch({ url: '/pages/login/index' }), 600)
    return
  }
  hasPassword.value = resolveHasPassword(getCachedUserInfo())
  try {
    const res = await getCurrentUser()
    if (res && res.data) hasPassword.value = resolveHasPassword(res.data)
  } catch (e) {
    // 拉取失败时保留本地判断，不阻塞修改流程
  }
}

const submit = async () => {
  if (loading.value) return
  if (hasPassword.value && !oldPassword.value) { uni.showToast({ title: '请输入原密码', icon: 'none' }); return }
  if (!newPassword.value || newPassword.value.length < 6) { uni.showToast({ title: '新密码至少 6 位', icon: 'none' }); return }
  if (newPassword.value !== confirm.value) { uni.showToast({ title: '两次密码不一致', icon: 'none' }); return }
  if (hasPassword.value && oldPassword.value === newPassword.value) { uni.showToast({ title: '新密码不能与原密码相同', icon: 'none' }); return }

  loading.value = true
  try {
    const res = await changePassword(hasPassword.value ? oldPassword.value : '', newPassword.value)
    if (res && res.errCode === 0) {
      uni.showToast({ title: hasPassword.value ? '密码已修改' : '密码已设置', icon: 'success' })
      setTimeout(() => goBack(), 600)
    } else {
      uni.showToast({ title: (res && res.errMsg) || '操作失败', icon: 'none' })
    }
  } catch (e) {
    uni.showToast({ title: (e && (e.message || e.errMsg)) || '操作失败', icon: 'none' })
  } finally {
    loading.value = false
  }
}

onShow(() => refresh())
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

.submit-btn { margin-top: 14px; height: 50px; font-size: 16px; font-weight: 800; background: #086CEA; border-color: #086CEA; }

.bottom-safe { height: 40px; }
</style>
