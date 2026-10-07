<template>
  <view class="page rpt-page">
    <view class="nav">
      <RptBackButton @click="goBack" />
      <text class="nav-title">银行老师入驻</text>
      <view class="nav-spacer"></view>
    </view>

    <scroll-view class="scroll-body" scroll-y>
      <view class="wrap rpt-content-narrow">
        <view class="intro">
          <text class="intro-kicker">平台认证服务端</text>
          <text class="intro-title">提交职业资料后开通客户跟进工作台</text>
          <text class="intro-desc">用于承接已授权用户的信用解读、方案沟通和进度跟进。平台会校验身份、机构信息与服务合规承诺。</text>
        </view>

        <view class="section">
          <view class="section-head">
            <text class="section-title">基本信息</text>
            <text class="section-note">必填</text>
          </view>
          <view class="field">
            <text class="field-label">姓名</text>
            <input v-model.trim="form.name" class="field-input" placeholder="请输入真实姓名" maxlength="20" />
          </view>
          <view class="field">
            <text class="field-label">手机号</text>
            <input v-model.trim="form.mobile" class="field-input" placeholder="用于审核联系" maxlength="11" type="number" />
          </view>
          <view class="field">
            <text class="field-label">所在城市</text>
            <input v-model.trim="form.city" class="field-input" placeholder="例如：深圳" maxlength="20" />
          </view>
        </view>

        <view class="section">
          <view class="section-head">
            <text class="section-title">机构与岗位</text>
            <text class="section-note">实名审核</text>
          </view>
          <view class="field">
            <text class="field-label">银行/机构</text>
            <input v-model.trim="form.institution" class="field-input" placeholder="请输入机构全称" maxlength="40" />
          </view>
          <view class="field">
            <text class="field-label">支行/部门</text>
            <input v-model.trim="form.branch" class="field-input" placeholder="请输入支行或部门" maxlength="40" />
          </view>
          <view class="field">
            <text class="field-label">岗位</text>
            <input v-model.trim="form.title" class="field-input" placeholder="例如：客户经理 / 信贷经理" maxlength="30" />
          </view>
          <view class="field">
            <text class="field-label">从业年限</text>
            <input v-model.trim="form.years" class="field-input" placeholder="例如：5" maxlength="2" type="number" />
          </view>
        </view>

        <view class="section">
          <view class="section-head">
            <text class="section-title">服务专长</text>
            <text class="section-note">可多选</text>
          </view>
          <view class="chips">
            <view
              v-for="item in specialtyOptions"
              :key="item"
              class="chip"
              :class="{ active: form.specialties.includes(item) }"
              @click="toggleSpecialty(item)"
            >
              <text class="chip-text" :class="{ active: form.specialties.includes(item) }">{{ item }}</text>
            </view>
          </view>
        </view>

        <view class="section">
          <view class="section-head">
            <text class="section-title">资质材料</text>
            <text class="section-note">工牌/名片/授权证明</text>
          </view>
          <view class="upload-box" @click="chooseCredential">
            <text class="upload-mark">＋</text>
            <text class="upload-title">{{ files.length ? '继续添加材料' : '上传资质图片' }}</text>
            <text class="upload-desc">支持图片文件，建议遮挡非必要敏感信息。</text>
          </view>
          <view v-if="files.length" class="file-list">
            <view v-for="(file, index) in files" :key="file.path || index" class="file-row">
              <view class="file-main">
                <text class="file-name">{{ file.name || '资质图片' }}</text>
                <text class="file-size">{{ formatSize(file.size) }}</text>
              </view>
              <text class="file-remove" @click.stop="removeFile(index)">删除</text>
            </view>
          </view>
        </view>

        <view class="commit" @click="form.agree = !form.agree">
          <view class="check" :class="{ checked: form.agree }">
            <text v-if="form.agree" class="check-text">✓</text>
          </view>
          <text class="commit-text">我承诺仅在用户授权范围内查看与跟进资料，不私下转存、外传或用于非服务目的。</text>
        </view>

        <view class="submit" @click="submit">
          <text class="submit-text">提交入驻审核</text>
        </view>

        <view class="bottom-safe"></view>
      </view>
    </scroll-view>
  </view>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { isLoggedIn, getCachedUserInfo } from '@/services/authService.js'
import RptBackButton from '@/components/RptBackButton.vue'
import safeBack from '@/utils/safeBack.js'

const STORAGE_KEY = 'teacher_application'
const specialtyOptions = ['信用解读', '负债优化', '贷前规划', '资料预审', '企业主融资', '房抵沟通']
const files = ref([])
const cachedUser = getCachedUserInfo() || {}

const form = reactive({
  name: cachedUser.realName || cachedUser.nickname || '',
  mobile: cachedUser.mobile || cachedUser.phone || uni.getStorageSync('userPhone') || '',
  city: '',
  institution: '',
  branch: '',
  title: '',
  years: '',
  specialties: ['信用解读'],
  agree: false
})

const goBack = () => safeBack('/pages/profile/profile')

const toggleSpecialty = (item) => {
  const idx = form.specialties.indexOf(item)
  if (idx >= 0) form.specialties.splice(idx, 1)
  else form.specialties.push(item)
}

const chooseCredential = () => {
  uni.chooseImage({
    count: 1,
    sourceType: ['album', 'camera'],
    success: (res) => {
      const tempFiles = Array.isArray(res.tempFiles) ? res.tempFiles : []
      const tempPaths = Array.isArray(res.tempFilePaths) ? res.tempFilePaths : []
      const mapped = tempFiles.length
        ? tempFiles
        : tempPaths.map((path) => ({ path, name: '资质图片', size: 0 }))
      files.value = [...files.value, ...mapped].slice(0, 4)
    }
  })
}

const removeFile = (index) => {
  files.value = files.value.filter((_, i) => i !== index)
}

const formatSize = (size) => {
  const n = Number(size || 0)
  if (!n) return '已选择'
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const requireField = (value, label) => {
  if (!String(value || '').trim()) {
    uni.showToast({ title: `请填写${label}`, icon: 'none' })
    return false
  }
  return true
}

const submit = () => {
  if (!isLoggedIn()) {
    uni.showModal({
      title: '请先登录',
      content: '银行老师入驻需要绑定账号，登录后可以继续提交资料。',
      confirmText: '去登录',
      success: (res) => {
        if (res.confirm) uni.navigateTo({ url: '/pages/login/index' })
      }
    })
    return
  }
  if (!requireField(form.name, '姓名')) return
  if (!/^1\d{10}$/.test(String(form.mobile || ''))) {
    uni.showToast({ title: '请输入有效手机号', icon: 'none' })
    return
  }
  if (!requireField(form.city, '所在城市')) return
  if (!requireField(form.institution, '银行/机构')) return
  if (!requireField(form.title, '岗位')) return
  if (!form.specialties.length) {
    uni.showToast({ title: '请选择服务专长', icon: 'none' })
    return
  }
  if (!files.value.length) {
    uni.showToast({ title: '请上传资质材料', icon: 'none' })
    return
  }
  if (!form.agree) {
    uni.showToast({ title: '请确认合规承诺', icon: 'none' })
    return
  }

  uni.setStorageSync(STORAGE_KEY, {
    ...form,
    files: files.value.map((f) => ({ name: f.name || '资质图片', path: f.path || '', size: f.size || 0 })),
    status: 'reviewing',
    submittedAt: new Date().toISOString()
  })
  uni.showToast({ title: '已提交审核', icon: 'none' })
  uni.redirectTo({ url: '/pages/teacher/reviewing' })
}
</script>

<style scoped>
.page { min-height: 100vh; background: #F5F6FA; }
.nav { flex-direction: row; align-items: center; padding: calc(var(--rpt-safe-top) + 8px) 14px 8px; background: #fff; border-bottom: 1px solid #EEF0F4; }
.nav-title { flex: 1; text-align: center; font-size: 16px; font-weight: 900; color: #111827; }
.nav-spacer { width: 32px; }
.scroll-body { flex: 1; height: 100vh; }
.wrap { padding: 14px 16px 18px; }
.intro { background: #fff; border-radius: 8px; padding: 18px; border: 1px solid #EEF0F4; }
.intro-kicker { font-size: 12px; color: #086CEA; font-weight: 900; }
.intro-title { margin-top: 8px; font-size: 22px; line-height: 1.25; color: #111827; font-weight: 900; }
.intro-desc { margin-top: 10px; font-size: 13px; color: #6B7280; line-height: 1.7; }
.section { margin-top: 12px; background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; padding: 15px; }
.section-head { flex-direction: row; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.section-title { font-size: 16px; color: #111827; font-weight: 900; }
.section-note { font-size: 12px; color: #9CA3AF; font-weight: 700; }
.field { margin-bottom: 12px; }
.field:last-child { margin-bottom: 0; }
.field-label { font-size: 13px; color: #374151; font-weight: 800; margin-bottom: 7px; }
.field-input { height: 44px; padding: 0 12px; border-radius: 8px; background: #F8FAFC; border: 1px solid #E5E7EB; font-size: 14px; color: #111827; }
.chips { flex-direction: row; flex-wrap: wrap; margin-right: -8px; margin-bottom: -8px; }
.chip { padding: 8px 11px; border-radius: 8px; border: 1px solid #E5E7EB; background: #F8FAFC; margin-right: 8px; margin-bottom: 8px; }
.chip.active { background: #EAF3FF; border-color: #BFDBFE; }
.chip-text { font-size: 13px; color: #4B5563; font-weight: 800; }
.chip-text.active { color: #086CEA; }
.upload-box { align-items: center; justify-content: center; min-height: 112px; border-radius: 8px; border: 1px dashed #CBD5E1; background: #F8FAFC; }
.upload-mark { font-size: 24px; color: #086CEA; font-weight: 700; }
.upload-title { margin-top: 6px; font-size: 14px; color: #111827; font-weight: 900; }
.upload-desc { margin-top: 5px; font-size: 12px; color: #9CA3AF; }
.file-list { margin-top: 10px; }
.file-row { flex-direction: row; align-items: center; padding: 10px 0; border-top: 1px solid #F3F4F6; }
.file-main { flex: 1; }
.file-name { font-size: 13px; color: #111827; font-weight: 800; }
.file-size { margin-top: 3px; font-size: 12px; color: #9CA3AF; }
.file-remove { font-size: 13px; color: #C62828; font-weight: 800; padding-left: 12px; }
.commit { flex-direction: row; align-items: flex-start; margin-top: 14px; padding: 13px; background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; }
.check { width: 20px; height: 20px; border-radius: 6px; border: 1px solid #CBD5E1; margin-right: 9px; align-items: center; justify-content: center; }
.check.checked { background: #086CEA; border-color: #086CEA; }
.check-text { color: #fff; font-size: 13px; font-weight: 900; }
.commit-text { flex: 1; font-size: 12px; color: #4B5563; line-height: 1.6; }
.submit { margin-top: 16px; height: 48px; border-radius: 8px; background: #086CEA; align-items: center; justify-content: center; }
.submit-text { color: #fff; font-size: 15px; font-weight: 900; }
.bottom-safe { height: 36px; }
</style>
