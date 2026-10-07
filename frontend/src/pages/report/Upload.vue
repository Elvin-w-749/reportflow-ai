<template>
  <view class="page rpt-page">
    <view class="nav">
      <RptBackButton @click="goBack" />
      <text class="nav-title">上传信用报告</text>
      <view class="nav-spacer"></view>
    </view>

    <scroll-view class="scroll-body" scroll-y>
      <view class="wrap rpt-content-narrow">
        <!-- 选择区（未分析时显示） -->
        <view v-if="!analyzing && !errorMsg">
          <view class="hero">
            <text class="hero-title">上传信用报告，生成信用画像</text>
            <text class="hero-sub">支持人行 / 百行个人信用报告，PDF 或清晰截图。文件仅用于本次分析。</text>
          </view>

          <view class="flow-card">
            <view class="flow-step">
              <text class="flow-num">1</text>
              <text class="flow-text">选择文件</text>
            </view>
            <view class="flow-line"></view>
            <view class="flow-step">
              <text class="flow-num">2</text>
              <text class="flow-text">识别解析</text>
            </view>
            <view class="flow-line"></view>
            <view class="flow-step">
              <text class="flow-num">3</text>
              <text class="flow-text">查看画像</text>
            </view>
          </view>

          <view class="opt-card" @click="chooseAndAnalyze('pdf')">
            <view class="opt-ico opt-ico-pdf"><text class="opt-ico-text">PDF</text></view>
            <view class="opt-main">
              <text class="opt-title">上传 PDF 报告</text>
              <text class="opt-desc">从官方渠道下载的原始 PDF，识别最准确</text>
            </view>
            <view class="opt-arrow" aria-hidden="true">
              <RptChevron class="opt-arrow-icon" direction="right" />
            </view>
          </view>

          <view class="opt-card" @click="chooseAndAnalyze('image')">
            <view class="opt-ico opt-ico-img"><text class="opt-ico-text">IMG</text></view>
            <view class="opt-main">
              <text class="opt-title">上传报告截图</text>
              <text class="opt-desc">可一次选择多张，按报告页顺序上传</text>
            </view>
            <view class="opt-arrow" aria-hidden="true">
              <RptChevron class="opt-arrow-icon" direction="right" />
            </view>
          </view>

          <view class="tips">
            <text class="tips-title">温馨提示</text>
            <text class="tips-line">· 请确保报告完整、文字清晰，避免反光和裁切</text>
            <text class="tips-line">· 截图版征信请按页面顺序多选，系统会合并为一份报告解析</text>
            <text class="tips-line">· 分析过程可能需要 30 秒至数分钟，请保持网络通畅</text>
            <text class="tips-line">· 分析结果仅供参考，实际审批以金融机构为准</text>
          </view>

          <view class="privacy-card">
            <text class="privacy-title">隐私保护</text>
            <text class="privacy-sub">本地缓存会尽量脱敏身份证号；请勿在公共设备长期保留报告文件。</text>
          </view>
        </view>

        <!-- 分析进度 -->
        <view v-if="analyzing" class="progress-box">
          <view class="analysis-panel">
            <view class="analysis-head">
              <view class="analysis-copy">
                <text class="analysis-kicker">信用报告解析中</text>
                <text class="analysis-title">{{ currentStepName || '正在读取报告结构' }}</text>
                <text class="analysis-sub">{{ currentStepDetail || '正在提取账户、查询、逾期和负债字段。' }}</text>
              </view>
              <view class="analysis-score">
                <text class="analysis-score-num">{{ progress }}</text>
                <text class="analysis-score-pct">%</text>
              </view>
            </view>

            <view class="scan-card">
              <view class="scan-line"></view>
              <view class="scan-corner scan-corner-a"></view>
              <view class="scan-corner scan-corner-b"></view>
              <view class="scan-doc-mark"><text class="scan-doc-mark-text">信</text></view>
              <view class="scan-doc-copy">
                <text class="scan-title">正在读取报告结构</text>
                <text class="scan-sub">先生成征信问题，确认材料有无后再精准匹配</text>
                <view class="scan-bars">
                  <view class="scan-bar scan-bar-a"></view>
                  <view class="scan-bar scan-bar-b"></view>
                  <view class="scan-bar scan-bar-c"></view>
                </view>
              </view>
            </view>

            <view class="progress-track">
              <view class="progress-fill" :style="{ width: progress + '%' }"></view>
            </view>
            <view class="analysis-meta">
              <text class="analysis-meta-text">OCR 文字提取</text>
              <text class="analysis-meta-sub">服务端识别 · AI 结构化 · 本机保存</text>
            </view>

            <view class="analysis-orbit">
              <view class="ring">
                <view class="ring-glow"></view>
                <view class="ring-sweep"></view>
                <view class="ring-core">
                  <text class="ring-core-text">解析</text>
                </view>
              </view>
              <view class="pulse-dots">
                <view class="pulse-dot pulse-dot-a"></view>
                <view class="pulse-dot pulse-dot-b"></view>
                <view class="pulse-dot pulse-dot-c"></view>
              </view>
            </view>
          </view>

          <view class="steps">
            <view v-for="(s, i) in steps" :key="s.name" class="step-row" :class="{ 'step-row-active': s.status === 'processing' }">
              <view class="step-dot" :class="stepDotClass(s.status)">
                <text v-if="s.status === 'completed'" class="step-dot-icon">✓</text>
              </view>
              <view class="step-copy">
                <text class="step-name" :class="{ 'step-name-active': s.status !== 'pending' }">{{ s.name }}</text>
                <text v-if="s.detail" class="step-detail">{{ s.detail }}</text>
              </view>
            </view>
          </view>
          <view class="prog-hint-card">
            <text class="prog-hint">请勿退出页面，分析完成后将自动跳转报告详情</text>
          </view>
        </view>

        <!-- 错误态 -->
        <view v-if="errorMsg && !analyzing" class="error-box">
          <text class="error-emoji">!</text>
          <text class="error-title">{{ errorTitle }}</text>
          <text class="error-msg">{{ errorMsg }}</text>
          <text v-if="errorCode" class="error-code">错误码：{{ errorCode }}</text>
          <text v-if="errorSupportRef" class="error-support-ref">支持编号：{{ errorSupportRef }}</text>
          <text v-if="errorServerTime" class="error-server-time">服务端时间：{{ errorServerTime }}</text>
          <text v-if="errorAdvice" class="error-advice">{{ errorAdvice }}</text>
          <view class="error-btn" @click="handleErrorAction"><text class="error-btn-text">{{ errorActionLabel }}</text></view>
        </view>

        <view class="bottom-safe"></view>
      </view>
    </scroll-view>
  </view>
</template>

<script setup>
import { ref } from 'vue'
import { onShow, onUnload } from '@/compat/web-lifecycle.js'
import { getCachedUserInfo, requireLogin } from '@/services/authService.js'
import { analyzeCreditReport, resumeCreditAnalysisJob } from '@/services/aiAnalysis.js'
import { getReportList, saveReportDurable, validateReportArchivePolicy } from '@/services/reportStorage.js'
import {
  acknowledgeAnalysisJob,
  clearActiveAnalysisTask,
  getLatestAnalysisJob,
  loadActiveAnalysisTask,
  saveActiveAnalysisTask
} from '@/services/analysisTaskService.js'
import { reportError } from '@/services/errorReporter.js'
import { buildUploadTelemetryExtra, classifyUploadFailure, createUploadError, validatePickedFile } from '@/services/uploadFailure.js'
import RptBackButton from '@/components/RptBackButton.vue'
import RptChevron from '@/components/RptChevron.vue'
import safeBack from '@/utils/safeBack.js'

const analyzing = ref(false)
const progress = ref(0)
const steps = ref([])
const currentStepName = ref('')
const currentStepDetail = ref('')
const errorMsg = ref('')
const errorTitle = ref('分析未完成')
const errorAdvice = ref('')
const errorActionLabel = ref('重新上传')
const errorCategory = ref('')
const errorCode = ref('')
const errorSupportRef = ref('')
const errorServerTime = ref('')

let analysisAbortController = null
let pageUnloading = false

const beginClientAnalysisWatch = () => {
  try { analysisAbortController?.abort?.() } catch (_) {}
  analysisAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null
  return analysisAbortController
}

const endClientAnalysisWatch = (controller) => {
  if (analysisAbortController === controller) analysisAbortController = null
}

const isPageUnloadAbort = (error) => pageUnloading && ['ANALYSIS_POLL_ABORTED', 'UPLOAD_ABORTED'].includes(String(error?.code || ''))

const stepDotClass = (status) => ({
  'step-dot-done': status === 'completed',
  'step-dot-doing': status === 'processing',
  'step-dot-error': status === 'error'
})

const FIXED_TEST_ACCOUNT_RE = /^1960000000[1-7]$/
const MAX_REPORT_IMAGE_PAGES = 30

const currentUserCanUploadUnlimitedReports = () => {
  const user = getCachedUserInfo() || {}
  const phone = String(user.mobile || user.phone || user.username || '').trim()
  return user.reportUploadUnlimited === true || user.franchiseReportUnlimited === true || FIXED_TEST_ACCOUNT_RE.test(phone)
}

// 归属校验需要的姓名、报告月份和证件后四位已经预算进摘要；不再为了校验
// 把所有历史征信正文同步读进手机内存。
const fullReportsForPolicy = () => getReportList().filter(Boolean)

const goBack = () => safeBack('/pages/home/home')

const resetState = () => {
  analyzing.value = false
  errorMsg.value = ''
  errorTitle.value = '分析未完成'
  errorAdvice.value = ''
  errorActionLabel.value = '重新上传'
  errorCategory.value = ''
  errorCode.value = ''
  errorSupportRef.value = ''
  errorServerTime.value = ''
  progress.value = 0
  steps.value = []
  currentStepName.value = ''
  currentStepDetail.value = ''
}

const applyFailure = (failure) => {
  errorCategory.value = failure.category || ''
  errorTitle.value = failure.title || '分析未完成'
  errorMsg.value = failure.message || '分析失败，请重试'
  errorAdvice.value = failure.advice || ''
  errorActionLabel.value = failure.actionLabel || '重新上传'
  errorCode.value = failure.errorCode || ''
  errorSupportRef.value = failure.supportRef || ''
  errorServerTime.value = failure.serverTime || ''
}

const handleErrorAction = () => {
  if (errorCategory.value === 'auth') {
    uni.navigateTo({
      url: '/pages/login/index',
      fail: () => {
        resetState()
        uni.showToast({ title: '请重新登录后再上传', icon: 'none' })
      }
    })
    return
  }
  if (errorCategory.value === 'save') {
    resetState()
    void resumeActiveAnalysis()
    return
  }
  resetState()
}

const mapChosenImages = (res, startIndex = 0) => {
  const tempFiles = Array.isArray(res && res.tempFiles) ? res.tempFiles : []
  const tempPaths = Array.isArray(res && res.tempFilePaths) ? res.tempFilePaths : []
  return (tempFiles.length ? tempFiles : tempPaths.map((path) => ({ path })))
    .map((f, index) => {
      const path = (tempPaths && tempPaths[index]) || (f && (f.path || f.tempFilePath)) || ''
      const seq = startIndex + index + 1
      return {
        path,
        name: (f && f.name) || `report-${seq}.jpg`,
        size: f && typeof f.size === 'number' ? f.size : null,
        file: f && f.file ? f.file : (f && typeof Blob !== 'undefined' && f instanceof Blob ? f : null)
      }
    })
    .filter((f) => f.path || f.file)
}

const chooseImageOnce = (remaining) => new Promise((resolve, reject) => {
  uni.chooseImage({
    count: Math.max(1, Math.min(MAX_REPORT_IMAGE_PAGES, remaining || MAX_REPORT_IMAGE_PAGES)),
    sourceType: ['album', 'camera'],
    success: (res) => resolve(mapChosenImages(res)),
    fail: () => reject(new Error('cancel'))
  })
})

const askImageNextAction = (selectedCount) => new Promise((resolve) => {
  uni.showModal({
    title: `已选择 ${selectedCount} 张`,
    content: selectedCount >= MAX_REPORT_IMAGE_PAGES
      ? '已达到最多上传页数，是否开始解析？'
      : '还要继续添加下一页征信截图吗？请按报告页面顺序选择。',
    confirmText: selectedCount >= MAX_REPORT_IMAGE_PAGES ? '开始解析' : '继续添加',
    cancelText: '开始解析',
    success: (res) => {
      if (selectedCount >= MAX_REPORT_IMAGE_PAGES) {
        resolve('start')
        return
      }
      resolve(res.confirm ? 'add' : 'start')
    },
    fail: () => resolve(selectedCount < 2 ? 'add' : 'start')
  })
})

const buildImagePickedPayload = (files) => {
  const normalized = files.map((file, index) => ({
    ...file,
    name: file.name || `report-${index + 1}.jpg`
  }))
  const first = normalized[0] || null
  const totalSize = normalized.reduce((sum, item) => sum + (typeof item.size === 'number' ? item.size : 0), 0)
  return {
    path: first && first.path ? first.path : (first && first.file ? (first.name || 'report.jpg') : ''),
    name: normalized.length > 1 ? `信用报告截图${normalized.length}张` : (first && first.name) || 'report.jpg',
    size: totalSize || (first && typeof first.size === 'number' ? first.size : null),
    file: first && first.file ? first.file : null,
    files: normalized
  }
}

const pickImagePages = async () => {
  const files = []
  while (files.length < MAX_REPORT_IMAGE_PAGES) {
    let batch = []
    try {
      batch = await chooseImageOnce(MAX_REPORT_IMAGE_PAGES - files.length)
    } catch (e) {
      if (files.length) break
      throw e
    }
    files.push(...batch.map((file, index) => ({
      ...file,
      name: file.name || `report-${files.length + index + 1}.jpg`
    })))
    if (files.length >= MAX_REPORT_IMAGE_PAGES) break
    const action = await askImageNextAction(files.length)
    if (action !== 'add') break
  }
  if (!files.length) throw new Error('未选择图片')
  return buildImagePickedPayload(files)
}

const pickFile = (fileType) => new Promise((resolve, reject) => {
  if (fileType === 'pdf') {
    uni.chooseFile({
      count: 1,
      extension: ['.pdf'],
      success: (res) => {
        const f = (res.tempFiles && res.tempFiles[0]) || null
        const path = (res.tempFilePaths && res.tempFilePaths[0]) || (f && f.path) || ''
        if (!path) { reject(new Error('未选择文件')); return }
        resolve({ path, name: (f && f.name) || 'report.pdf', size: f && typeof f.size === 'number' ? f.size : null, file: f && f.file ? f.file : null })
      },
      fail: () => reject(new Error('cancel'))
    })
  } else {
    pickImagePages().then(resolve, reject)
  }
})

const onProgress = (task) => {
  if (!task) return
  progress.value = Math.max(0, Math.min(100, Math.round(task.progress || 0)))
  if (Array.isArray(task.steps)) {
    steps.value = task.steps.map((s) => ({ name: s.name, detail: s.detail, status: s.status }))
    const active = task.steps.find((s) => s.status === 'processing') ||
      [...task.steps].reverse().find((s) => s.status === 'completed')
    if (active) {
      currentStepName.value = active.name
      currentStepDetail.value = active.detail || ''
    }
  }
}

const stableLocalReportId = (remoteJobId) => {
  const safe = String(remoteJobId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 160)
  return safe ? `REPORT_${safe}` : undefined
}

const openCompletedReport = async (task, source = {}) => {
  const data = task && task.data
  if (!data) throw createUploadError('EMPTY_ANALYSIS_RESULT', '分析结果为空，请重试')
  const remoteJobId = String(task.remoteJobId || source.jobId || '')
  const supportRef = String(task.supportRef || source.supportRef || '')
  const draftReport = {
    id: stableLocalReportId(remoteJobId),
    clientReportId: stableLocalReportId(remoteJobId),
    analysisJobId: remoteJobId,
    analysisData: data,
    fileName: source.fileName || '信用报告.pdf',
    // 浏览器 blob URL / 手机临时路径在离开页面后会失效，不写入长期摘要。
    filePath: '',
    reportType: (data.reportFormat && data.reportFormat.source) || '信用报告'
  }
  const policy = validateReportArchivePolicy(draftReport, fullReportsForPolicy(), currentUserCanUploadUnlimitedReports())
  if (!policy.allowed) {
    // 服务端任务已经完成，但结果不允许归档到当前账号。确认并清除恢复指针，
    // 避免每次重新进入页面都重复打开同一份受限报告。
    if (remoteJobId) {
		try { await acknowledgeAnalysisJob(remoteJobId, supportRef) } catch (_) {}
      try { clearActiveAnalysisTask(remoteJobId) } catch (_) {}
    }
    throw createUploadError('REPORT_OWNER_POLICY', policy.message || '当前账号不能继续上传该征信报告')
  }

  // 云端正文成功 + 本地摘要写入并读回成功后，才允许打开详情页。
  const reportId = await saveReportDurable(draftReport)
  let acknowledged = false
  if (remoteJobId) {
    try {
      acknowledged = await acknowledgeAnalysisJob(remoteJobId, supportRef)
    } catch (e) {
      reportError({ kind: 'analysis-task-ack-failed', message: (e && (e.message || e.errMsg)) || '任务完成确认失败', page: 'report/Upload' })
    }
    if (acknowledged) clearActiveAnalysisTask(remoteJobId)
  }
  analyzing.value = false
  uni.redirectTo({
    url: `/pages/report/detail?id=${encodeURIComponent(reportId)}`,
    fail: () => { uni.showToast({ title: '无法打开报告页', icon: 'none' }) }
  })
  return reportId
}

const acknowledgeTerminalAnalysisFailure = async (jobId, supportRef) => {
  const id = String(jobId || '').trim()
  if (!id) return false
  try {
    const acknowledged = await acknowledgeAnalysisJob(id, supportRef)
    if (acknowledged) clearActiveAnalysisTask(id)
    return acknowledged
  } catch (e) {
    reportError({
      kind: 'analysis-task-failure-ack-failed',
      message: (e && (e.message || e.errMsg)) || '失败任务确认失败',
      page: 'report/Upload'
    })
    return false
  }
}

const chooseAndAnalyze = async (fileType) => {
  if (!requireLogin()) return
  let picked
  try {
    picked = await pickFile(fileType)
  } catch (e) {
    if (e && e.message === 'cancel') return
    uni.showToast({ title: (e && e.message) || '选择失败', icon: 'none' })
    return
  }

  resetState()
  let failureStage = 'validate'
  try {
    validatePickedFile(picked, fileType)
  } catch (e) {
    const failure = classifyUploadFailure(e, { fileType, fileName: picked && picked.name, stage: failureStage })
    applyFailure(failure)
    reportError({ kind: failure.reportKind, message: failure.message, page: 'report/Upload', extra: buildUploadTelemetryExtra({ category: failure.category, fileType, fileName: picked && picked.name, fileSize: picked && picked.size, stage: failureStage, error: e }) })
    return
  }

  analyzing.value = true
  const clientWatch = beginClientAnalysisWatch()
  try {
    failureStage = 'analysis'
    const analysisFile = fileType === 'image' && Array.isArray(picked.files) && picked.files.length
      ? picked.files
      : picked.file || picked.path
    const task = await analyzeCreditReport(analysisFile, fileType, onProgress, {
      fileSize: picked.size,
      fileName: picked.name,
      files: picked.files || null,
      signal: clientWatch?.signal
    })

    failureStage = 'save'
    await openCompletedReport(task, { fileName: picked.name })
  } catch (e) {
    analyzing.value = false
    if (isPageUnloadAbort(e)) return
    const failure = classifyUploadFailure(e, { fileType, fileName: picked && picked.name, stage: failureStage })
    applyFailure(failure)
    reportError({ kind: failure.reportKind, message: failure.message, page: 'report/Upload', extra: buildUploadTelemetryExtra({ category: failure.category, fileType, fileName: picked && picked.name, fileSize: picked && picked.size, stage: failureStage, error: e }) })
    if (failureStage === 'analysis' && e && e.terminalAnalysisFailure === true) {
      const failedJobId = String(e.analysisJobId || '')
      if (failedJobId) await acknowledgeTerminalAnalysisFailure(failedJobId, e.supportRef)
    }
  } finally {
    endClientAnalysisWatch(clientWatch)
  }
}

let resumeFlight = null

const resumeActiveAnalysis = async () => {
  if (analyzing.value || resumeFlight || !requireLogin()) return
  resumeFlight = (async () => {
    let active = loadActiveAnalysisTask()
    if (!active) {
      try {
        const latest = await getLatestAnalysisJob()
        if (!latest) return
        active = saveActiveAnalysisTask({ ...latest, fileType: 'pdf', fileName: '信用报告.pdf' })
      } catch (e) {
        reportError({ kind: 'analysis-task-latest-failed', message: (e && (e.message || e.errMsg)) || '恢复分析任务失败', page: 'report/Upload' })
        return
      }
    }

    resetState()
    analyzing.value = true
    const clientWatch = beginClientAnalysisWatch()
    let failureStage = 'analysis'
    try {
      const task = await resumeCreditAnalysisJob(active, onProgress, { signal: clientWatch?.signal })
      failureStage = 'save'
      await openCompletedReport(task, active)
    } catch (e) {
      analyzing.value = false
      if (isPageUnloadAbort(e)) return
      const failure = classifyUploadFailure(e, { fileType: 'pdf', fileName: active.fileName, stage: failureStage })
      applyFailure(failure)
      reportError({
        kind: failure.reportKind,
        message: failure.message,
        page: 'report/Upload',
        extra: buildUploadTelemetryExtra({ category: failure.category, fileType: 'pdf', fileName: active.fileName, stage: failureStage, error: e })
      })
      // 只有服务端明确返回 failed/cancelled/expired 终态，且云端确认成功后，
      // 才清掉恢复指针。HTTP 5xx、断网和轮询取消都保留任务供下次恢复。
      if (
        failureStage === 'analysis' &&
        e &&
        e.terminalAnalysisFailure === true &&
        String(e.analysisJobId || '') === String(active.jobId || '')
      ) {
        await acknowledgeTerminalAnalysisFailure(active.jobId, e.supportRef)
      }
    } finally {
      endClientAnalysisWatch(clientWatch)
    }
  })().finally(() => { resumeFlight = null })
  return resumeFlight
}

onShow(() => {
  pageUnloading = false
  void resumeActiveAnalysis()
})

onUnload(() => {
  pageUnloading = true
  try { analysisAbortController?.abort?.() } catch (_) {}
  analysisAbortController = null
})
</script>

<style scoped>
.page { min-height: 100vh; background: #F5F6FA; }
.nav { min-height: 49px; flex-direction: row; align-items: center; padding: calc(var(--rpt-safe-top) + 8px) 14px 8px; background: #fff; border-bottom: 1px solid #EEF0F4; }
.nav-title { flex: 1; min-width: 0; text-align: center; font-size: 16px; font-weight: 800; color: #111827; }
.nav-spacer { width: 32px; flex: 0 0 32px; }
.scroll-body { flex: 1; height: 100vh; }
.wrap { width: 100%; max-width: 760px; margin: 0 auto; padding: 16px; }

.hero { margin-bottom: 14px; }
.hero-title { display: block; font-size: 20px; font-weight: 900; color: #111827; }
.hero-sub { display: block; margin-top: 8px; font-size: 13px; color: #6B7280; line-height: 1.6; }

.flow-card { background: #fff; border-radius: 8px; padding: 13px 10px; margin-bottom: 12px; border: 1px solid #EEF0F4; flex-direction: row; align-items: center; }
.flow-step { flex: 1 1 0; min-width: 0; align-items: center; }
.flow-num { width: 24px; height: 24px; border-radius: 8px; background: #EAF3FF; color: #086CEA; font-size: 12px; font-weight: 900; text-align: center; line-height: 24px; }
.flow-text { margin-top: 6px; font-size: 11px; color: #4B5563; font-weight: 800; }
.flow-line { flex: 0 0 28px; height: 1px; background: #E5E7EB; margin: 0 2px; }

.opt-card { flex-direction: row; align-items: center; background: #fff; border-radius: 8px; padding: 16px; margin-bottom: 12px; border: 1px solid #EEF0F4; }
.opt-ico { width: 44px; height: 44px; border-radius: 8px; align-items: center; justify-content: center; margin-right: 12px; }
.opt-ico-pdf { background: #EAF3FF; border: 1px solid #BFDBFE; }
.opt-ico-img { background: #F0FDF4; border: 1px solid #BBF7D0; }
.opt-ico-text { font-size: 13px; font-weight: 900; color: #086CEA; }
.opt-ico-img .opt-ico-text { color: #16A34A; }
.opt-main { flex: 1; }
.opt-title { display: block; font-size: 15px; font-weight: 800; color: #111827; }
.opt-desc { display: block; margin-top: 4px; font-size: 12px; color: #9CA3AF; }
.opt-arrow {
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #C7CBD1;
}
.opt-arrow-icon {
  width: 18px;
  height: 18px;
}

.tips { margin-top: 8px; background: #fff; border-radius: 8px; padding: 14px 16px; border: 1px solid #EEF0F4; }
.tips-title { display: block; font-size: 13px; font-weight: 800; color: #374151; margin-bottom: 8px; }
.tips-line { display: block; font-size: 12px; color: #9CA3AF; line-height: 1.9; }
.privacy-card { margin-top: 12px; background: #FFFBEB; border-radius: 8px; border: 1px solid #FDE68A; padding: 12px 14px; }
.privacy-title { font-size: 13px; color: #92400E; font-weight: 900; }
.privacy-sub { margin-top: 4px; font-size: 12px; color: #B45309; line-height: 1.5; }

.progress-box { align-items: stretch; padding: 12px 0 24px; }
.analysis-panel { position: relative; overflow: hidden; background: #FFFFFF; border: 1px solid #D8E8FF; border-radius: 8px; padding: 16px; box-shadow: 0 18px 38px rgba(13, 78, 153, 0.11); }
.analysis-panel::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 4px; background: linear-gradient(90deg, #086CEA, #36BFFA, #22C55E); }
.analysis-head { flex-direction: row; align-items: center; margin-bottom: 14px; }
.analysis-copy { flex: 1; min-width: 0; padding-right: 12px; }
.analysis-kicker { font-size: 11px; color: #086CEA; font-weight: 900; letter-spacing: 0; }
.analysis-title { display: block; margin-top: 5px; font-size: 19px; color: #071B3D; font-weight: 900; line-height: 1.25; }
.analysis-sub { display: block; margin-top: 6px; font-size: 12px; color: #64748B; line-height: 1.5; }
.analysis-score { width: 66px; height: 66px; border-radius: 8px; background: #F4F8FF; border: 1px solid #CFE2FF; align-items: center; justify-content: center; flex-direction: row; }
.analysis-score-num { font-size: 24px; color: #086CEA; font-weight: 900; }
.analysis-score-pct { margin-top: 7px; font-size: 12px; color: #086CEA; font-weight: 900; }
.scan-card { position: relative; width: 100%; min-height: 104px; border-radius: 8px; background: linear-gradient(180deg, #F8FBFF 0%, #FFFFFF 100%); border: 1px solid #DCEBFF; overflow: hidden; padding: 14px; flex-direction: row; align-items: center; }
.scan-line { position: absolute; left: 0; right: 0; top: 0; height: 2px; background: linear-gradient(90deg, transparent, #086CEA, #22C55E, transparent); animation: scanMove 1.8s ease-in-out infinite; }
.scan-corner { position: absolute; width: 38px; height: 38px; opacity: .8; }
.scan-corner-a { left: 10px; top: 10px; border-left: 2px solid #93C5FD; border-top: 2px solid #93C5FD; }
.scan-corner-b { right: 10px; bottom: 10px; border-right: 2px solid #93C5FD; border-bottom: 2px solid #93C5FD; }
.scan-doc-mark { width: 46px; height: 46px; border-radius: 8px; background: #EAF3FF; border: 1px solid #BFDBFE; align-items: center; justify-content: center; margin-right: 13px; }
.scan-doc-mark-text { font-size: 18px; color: #086CEA; font-weight: 900; }
.scan-doc-copy { flex: 1; min-width: 0; }
.scan-title { font-size: 14px; color: #071B3D; font-weight: 900; }
.scan-sub { display: block; margin-top: 4px; font-size: 11px; color: #64748B; line-height: 1.45; }
.scan-bars { margin-top: 12px; }
.scan-bar { height: 7px; border-radius: 7px; background: linear-gradient(90deg, #EAF3FF 0%, #BFDBFE 42%, #DCFCE7 78%); margin-bottom: 7px; animation: shimmer 1.6s ease-in-out infinite; }
.scan-bar-a { width: 88%; }
.scan-bar-b { width: 66%; animation-delay: .12s; }
.scan-bar-c { width: 78%; animation-delay: .24s; }
.progress-track { width: 100%; height: 8px; border-radius: 8px; background: #EAF3FF; margin-top: 14px; overflow: hidden; }
.progress-fill { height: 8px; border-radius: 8px; background: linear-gradient(90deg, #086CEA 0%, #36BFFA 62%, #22C55E 100%); box-shadow: 0 0 16px rgba(8,108,234,0.28); transition: width .28s ease; }
.analysis-meta { flex-direction: row; align-items: center; justify-content: space-between; margin-top: 9px; }
.analysis-meta-text { font-size: 12px; color: #071B3D; font-weight: 900; }
.analysis-meta-sub { font-size: 11px; color: #94A3B8; }
.analysis-orbit { align-items: center; margin-top: 16px; }
.ring { position: relative; width: 88px; height: 88px; border-radius: 44px; background: #fff; border: 5px solid #EAF3FF; align-items: center; justify-content: center; box-shadow: 0 12px 24px rgba(8,108,234,0.12); overflow: hidden; }
.ring-glow { position: absolute; width: 66px; height: 66px; border-radius: 33px; background: #F8FBFF; }
.ring-sweep { position: absolute; width: 88px; height: 88px; border-radius: 44px; border: 5px solid transparent; border-top-color: #086CEA; border-right-color: #36BFFA; animation: ringSpin 1.25s linear infinite; }
.ring-core { position: relative; z-index: 2; width: 48px; height: 48px; border-radius: 24px; background: #F8FBFF; align-items: center; justify-content: center; border: 1px solid #EAF3FF; }
.ring-core-text { font-size: 13px; color: #086CEA; font-weight: 900; }
.pulse-dots { flex-direction: row; margin-top: 9px; }
.pulse-dot { width: 6px; height: 6px; border-radius: 3px; background: #086CEA; margin: 0 3px; animation: dotPulse 1.1s ease-in-out infinite; }
.pulse-dot-b { animation-delay: .14s; }
.pulse-dot-c { animation-delay: .28s; }
.steps { width: 100%; margin-top: 12px; background: #FFFFFF; border: 1px solid #E5EEFB; border-radius: 8px; padding: 8px 10px; }
.step-row { flex-direction: row; align-items: center; padding: 8px 0; }
.step-row-active { background: #F4F8FF; border-radius: 8px; padding-left: 8px; }
.step-dot { width: 18px; height: 18px; border-radius: 9px; background: #E5E7EB; margin-right: 10px; align-items: center; justify-content: center; }
.step-dot-done { background: #22C55E; }
.step-dot-doing { background: #086CEA; animation: dotRing 1.2s ease-in-out infinite; }
.step-dot-error { background: #EF4444; }
.step-dot-icon { font-size: 11px; color: #fff; font-weight: 900; }
.step-copy { flex: 1; min-width: 0; }
.step-name { font-size: 13px; color: #9CA3AF; }
.step-name-active { color: #374151; font-weight: 700; }
.step-detail { display: block; margin-top: 2px; font-size: 11px; color: #94A3B8; line-height: 1.35; }
.prog-hint-card { margin-top: 12px; background: #F8FAFC; border: 1px solid #E5E7EB; border-radius: 8px; padding: 10px 12px; align-items: center; }
.prog-hint { font-size: 12px; color: #64748B; text-align: center; }

.error-box { align-items: center; padding: 40px 24px; }
.error-emoji { width: 56px; height: 56px; border-radius: 28px; background: #FEF2F2; color: #DC2626; font-size: 30px; font-weight: 900; text-align: center; line-height: 56px; }
.error-title { margin-top: 16px; font-size: 17px; font-weight: 800; color: #111827; }
.error-msg { margin-top: 8px; font-size: 13px; color: #6B7280; text-align: center; line-height: 1.6; }
.error-code { margin-top: 8px; padding: 4px 8px; border-radius: 6px; background: #FFF1F2; color: #BE123C; font-size: 11px; font-weight: 800; }
.error-support-ref { margin-top: 10px; font-size: 12px; color: #334155; font-weight: 800; }
.error-server-time { margin-top: 4px; font-size: 11px; color: #64748B; }
.error-advice { margin-top: 10px; font-size: 12px; color: #9CA3AF; text-align: center; line-height: 1.6; }
.error-btn { margin-top: 24px; background: #086CEA; border-radius: 8px; padding: 12px 40px; box-shadow: 0 10px 22px rgba(8,108,234,0.16); }
.error-btn-text { color: #fff; font-size: 15px; font-weight: 800; }

.bottom-safe { height: 40px; }
@media (min-width: 1024px) {
  .hero { flex-direction: row; align-items: center; }
}
@keyframes ringSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes dotPulse { 0%, 100% { opacity: .35; transform: scale(.8); } 50% { opacity: 1; transform: scale(1.2); } }
@keyframes dotRing { 0%, 100% { box-shadow: 0 0 0 0 rgba(8,108,234,.26); } 50% { box-shadow: 0 0 0 7px rgba(8,108,234,0); } }
@keyframes scanMove { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
@keyframes shimmer { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
</style>
