<template>
  <view class="page rpt-page">
    <view class="nav">
      <RptBackButton @click="goBack" />
      <text class="nav-title">补充材料</text>
      <view class="nav-spacer"></view>
    </view>

    <scroll-view class="scroll-body" scroll-y>
      <view class="wrap rpt-content-narrow">
        <view class="hero">
          <text class="hero-kicker">二次匹配依据</text>
          <text class="hero-title">补充材料，提升匹配准确度</text>
          <text class="hero-sub">有材料就上传，没有就选择暂无。系统会按真实材料情况匹配，暂时不适合的会给出养护周期和下一步建议。</text>
          <view class="hero-tags">
            <view class="hero-tag"><text class="hero-tag-text">{{ profile.confidenceText }}</text></view>
            <view class="hero-tag hero-tag-soft"><text class="hero-tag-text hero-tag-soft-text">{{ profile.materialCount }} 项已记录</text></view>
          </view>
        </view>

        <view class="summary-panel">
          <view class="summary-cell">
            <text class="summary-value">{{ profile.stableMonths || '--' }}</text>
            <text class="summary-label">连续月份</text>
          </view>
          <view class="summary-cell">
            <text class="summary-value">{{ incomeText }}</text>
            <text class="summary-label">月收入</text>
          </view>
          <view class="summary-cell">
            <text class="summary-value">{{ profile.hasAssetEvidence ? '有' : '--' }}</text>
            <text class="summary-label">资产材料</text>
          </view>
        </view>

        <view v-if="profile.missing.length" class="guide-card">
            <text class="guide-title">这些信息还没有说清楚</text>
            <text class="guide-sub">{{ profile.productUnlockMissing.length ? profile.productUnlockMissing.join('、') : profile.missing.join('、') }}。有就上传，没有就点暂无，系统会按缺失材料场景保守匹配。</text>
        </view>

        <view v-for="group in groupedTypes" :key="group.name" class="group">
          <view class="section-head">
            <text class="section-title">{{ group.name }}</text>
            <text class="section-note">{{ group.items.length }} 项</text>
          </view>
          <view v-for="item in group.items" :key="item.key" class="material-card" :class="{ 'material-card-active': uploadingKey === item.key || recognizingKey === item.key }">
            <view class="material-head">
              <view class="material-icon"><text class="material-icon-text">{{ item.icon }}</text></view>
              <view class="material-main">
                <text class="material-title">{{ item.title }}</text>
                <text class="material-desc">{{ item.desc }}</text>
              </view>
              <text class="material-status" :class="{ 'material-status-done': materialDone(item.key) }">{{ materialStatusText(item.key) }}</text>
            </view>

            <view class="choice-row">
              <view class="choice-chip" :class="{ 'choice-chip-on': !materialOf(item.key).unavailable }" @click="setMaterialAvailability(item.key, true)">
                <text class="choice-chip-text" :class="{ 'choice-chip-text-on': !materialOf(item.key).unavailable }">{{ item.inputOnly ? '填写信息' : '有材料' }}</text>
              </view>
              <view v-if="!item.inputOnly" class="choice-chip" :class="{ 'choice-chip-on': materialOf(item.key).unavailable }" @click="setMaterialAvailability(item.key, false)">
                <text class="choice-chip-text" :class="{ 'choice-chip-text-on': materialOf(item.key).unavailable }">暂无/没有</text>
              </view>
            </view>

            <view class="guide-box">
              <text class="guide-box-title">核验重点</text>
              <text class="guide-box-text">{{ item.guide && item.guide.focus }}</text>
              <text class="guide-box-title guide-box-title-gap">怎么找到</text>
              <text class="guide-box-text">{{ item.guide && item.guide.findPath }}</text>
              <view v-if="item.guide && item.guide.examples && item.guide.examples.length" class="example-row">
                <text v-for="example in item.guide.examples" :key="example" class="example-chip">{{ example }}</text>
              </view>
            </view>

            <view v-if="item.inputOnly" class="education-row" @click="chooseEducation(item.key)">
              <text class="education-label">最高学历</text>
              <text class="education-value">{{ educationText(drafts[item.key].educationLevel) }}</text>
            </view>

            <view v-if="!materialOf(item.key).unavailable && !item.inputOnly" class="form-grid">
              <view v-if="needsMonths(item.key)" class="field">
                <text class="field-label">连续月份</text>
                <input class="field-input" type="number" v-model="drafts[item.key].months" placeholder="如 12" />
              </view>
              <view v-if="needsSameEmployer(item.key)" class="field">
                <text class="field-label">同单位月份</text>
                <input class="field-input" type="number" v-model="drafts[item.key].sameEmployerMonths" placeholder="如 12" />
              </view>
            </view>

            <view v-if="!materialOf(item.key).unavailable && !item.inputOnly" class="form-grid">
              <view v-if="needsIncome(item.key)" class="field">
                <text class="field-label">{{ incomeFieldLabel(item.key) }}</text>
                <input class="field-input" type="number" v-model="drafts[item.key].monthlyIncome" placeholder="如 15000" />
              </view>
              <view v-if="needsEmployerCount(item.key)" class="field">
                <text class="field-label">单位数量</text>
                <input class="field-input" type="number" v-model="drafts[item.key].employerCount" placeholder="如 1" />
              </view>
              <view v-if="needsAssetValue(item.key)" class="field">
                <text class="field-label">资产估值</text>
                <input class="field-input" type="number" v-model="drafts[item.key].declaredValue" placeholder="选填" />
              </view>
            </view>

            <view v-if="!materialOf(item.key).unavailable && needsCompany(item.key)" class="field field-full">
              <text class="field-label">单位/主体名称</text>
              <input class="field-input" v-model="drafts[item.key].companyName" placeholder="如 上海某某有限公司" />
            </view>

            <textarea class="note-input" v-model="drafts[item.key].note" maxlength="140" :placeholder="materialOf(item.key).unavailable ? '可说明暂无原因，例如无房、无车、未缴公积金等' : '补充说明，例如单位稳定、产权情况、车辆状态等'" />

            <view v-if="attachmentsOf(item.key).length" class="file-strip">
              <view class="file-strip-head">
                <text class="file-label">已上传</text>
                <text class="file-count">共 {{ attachmentsOf(item.key).length }} 份</text>
              </view>
              <view v-for="(file, fileIndex) in visibleAttachmentsOf(item.key)" :key="attachmentRenderKey(file, fileIndex)" class="file-row">
                <view class="file-main">
                  <text class="file-dot"></text>
                  <text class="file-name">{{ file.fileName || '材料截图' }}</text>
                </view>
                <view class="file-actions">
                  <text class="file-action" @click.stop="replaceAttachment(item.key, file, fileIndex)">替换</text>
                  <text class="file-action file-action-danger" @click.stop="removeAttachment(item.key, file, fileIndex)">删除</text>
                </view>
              </view>
            </view>
            <view v-if="materialOf(item.key).detectedSummary || materialOf(item.key).ocrError" class="ocr-strip" :class="{ 'ocr-strip-warn': materialOf(item.key).ocrError }">
              <text class="ocr-label">{{ materialOf(item.key).ocrError ? '待复核' : '已识别' }}</text>
              <text class="ocr-text">{{ materialOf(item.key).detectedSummary || materialOf(item.key).ocrError }}</text>
            </view>

            <view class="material-actions">
              <view class="material-ghost" @click="saveDraft(item.key)"><text class="material-ghost-text">保存摘要</text></view>
              <view v-if="!item.inputOnly && !materialOf(item.key).unavailable" class="material-primary" :class="{ 'material-primary-loading': uploadingKey === item.key || recognizingKey === item.key }" @click="uploadMaterial(item.key)">
                <view v-if="uploadingKey === item.key || recognizingKey === item.key" class="inline-spinner"></view>
                <text class="material-primary-text">{{ actionText(item.key) }}</text>
              </view>
            </view>
          </view>
        </view>

        <view class="bottom-actions">
          <view class="bottom-ghost" @click="goAdvisor"><text class="bottom-ghost-text">让顾问复核</text></view>
          <view class="bottom-primary" @click="goMatch"><text class="bottom-primary-text">{{ profile.productMatchUnlocked ? '重新匹配产品' : '继续完善材料' }}</text></view>
        </view>
        <view class="disclaimer">
          <text class="disclaimer-text">材料仅用于信用分析和顾问复核。最终产品、额度、利率与是否通过，以金融机构审批为准。</text>
        </view>
        <view class="bottom-safe rpt-page-bottom"></view>
      </view>
    </scroll-view>
  </view>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import { onShow } from '@/compat/web-lifecycle.js'
import safeBack from '@/utils/safeBack.js'
import RptBackButton from '@/components/RptBackButton.vue'
import safeSwitchTab from '@/utils/safeSwitchTab.js'
import { uploadLocalFile } from '@/services/apiClient.js'
import { isLoggedIn } from '@/services/authService.js'
import { parseImageText } from '@/services/pdfParser.js'
import {
  SUPPLEMENT_MATERIAL_TYPES,
  buildSupplementMaterialProfile,
  extractSupplementMaterialFromText,
  resolveSupplementMaterialScope,
  readSupplementMaterials,
  replaceSupplementMaterial,
  restoreSupplementMaterialsFromCloud,
  supplementMaterialScopesOverlap,
  syncSupplementMaterial,
  syncSupplementMaterialExact,
  upsertSupplementMaterial,
  saveSupplementMaterialRemote
} from '@/services/supplementMaterialService.js'

const materials = ref([])
const profile = ref(buildSupplementMaterialProfile([]))
const uploadingKey = ref('')
const recognizingKey = ref('')
const drafts = reactive({})
let cloudRestoreSequence = 0
const EDUCATION_OPTIONS = [
  { value: 'doctorate', label: '博士' },
  { value: 'master', label: '硕士' },
  { value: 'bachelor', label: '本科' },
  { value: 'college', label: '大专' },
  { value: 'high_school', label: '高中/中专' },
  { value: 'other', label: '其他' }
]

const initDraft = (type) => {
  if (!drafts[type]) drafts[type] = {
    months: '',
    sameEmployerMonths: '',
    employerCount: '',
    monthlyIncome: '',
    annualTaxableIncome: '',
    declaredValue: '',
    companyName: '',
    educationLevel: '',
    note: ''
  }
  return drafts[type]
}
SUPPLEMENT_MATERIAL_TYPES.forEach((item) => initDraft(item.key))

const groupedTypes = computed(() => {
  const map = new Map()
  SUPPLEMENT_MATERIAL_TYPES.forEach((item) => {
    if (!map.has(item.group)) map.set(item.group, [])
    map.get(item.group).push(item)
  })
  return Array.from(map.entries()).map(([name, items]) => ({ name, items }))
})
const incomeText = computed(() => profile.value.monthlyIncome ? `¥${Math.round(profile.value.monthlyIncome).toLocaleString()}` : '--')

const materialOf = (type) => materials.value.find((item) => item.type === type) || {}
const attachmentsOf = (type) => {
  const material = materialOf(type)
  const attachments = Array.isArray(material.attachments) ? material.attachments : []
  if (attachments.length) return attachments
  if (material.fileName || material.fileUrl || material.uploadUrl || material.localFilePath) return [material]
  return []
}
const visibleAttachmentsOf = (type) => attachmentsOf(type)
const attachmentIdentity = (file = {}, index = 0) => String(file.id || file.attachmentId || file.fileUrl || file.uploadUrl || file.localFilePath || `${file.fileName || 'attachment'}:${file.fileSize || ''}:${index}`)
const attachmentRenderKey = (file, index) => attachmentIdentity(file, index)
const materialHasFiles = (type) => attachmentsOf(type).length > 0
const materialDone = (type) => materialHasFiles(type) || materialOf(type).unavailable || materialOf(type).educationLevel
const materialStatusText = (type) => {
  const material = materialOf(type)
  const count = attachmentsOf(type).length
  if (material.unavailable) return '暂无'
  if (material.educationLevel && !count) return material.statusText || '已填写'
  if (count) return `${count}份待确认`
  return material.statusText || '待确认'
}
const actionText = (type) => {
  if (recognizingKey.value === type) return '识别中'
  if (uploadingKey.value === type) return '上传中'
  return materialHasFiles(type) ? '继续上传' : '上传材料'
}
const needsMonths = (type) => ['social_security', 'housing_fund', 'payroll', 'tax', 'business_operation'].includes(type)
const needsSameEmployer = (type) => ['social_security', 'housing_fund', 'payroll', 'tax'].includes(type)
const needsEmployerCount = (type) => ['tax', 'payroll'].includes(type)
const needsCompany = (type) => ['social_security', 'housing_fund', 'payroll', 'tax', 'business_operation'].includes(type)
const needsIncome = (type) => ['social_security', 'housing_fund', 'payroll', 'tax', 'business_operation'].includes(type)
const needsAssetValue = (type) => ['property', 'vehicle'].includes(type)
const incomeFieldLabel = (type) => {
  if (type === 'housing_fund') return '缴存基数/月'
  if (type === 'social_security') return '缴费基数/月'
  if (type === 'business_operation') return '月均经营流水'
  if (type === 'tax') return '月均纳税收入'
  return '月收入'
}
const educationText = (value) => (EDUCATION_OPTIONS.find((item) => item.value === value) || {}).label || '请选择'

const refresh = (restoredMaterials = null) => {
  materials.value = Array.isArray(restoredMaterials) ? restoredMaterials : readSupplementMaterials()
  profile.value = buildSupplementMaterialProfile(materials.value)
  SUPPLEMENT_MATERIAL_TYPES.forEach((item) => {
    const saved = materialOf(item.key)
    const draft = initDraft(item.key)
    draft.months = saved.months || draft.months || ''
    draft.sameEmployerMonths = saved.sameEmployerMonths || draft.sameEmployerMonths || ''
    draft.employerCount = saved.employerCount || draft.employerCount || ''
    draft.monthlyIncome = saved.monthlyIncome || draft.monthlyIncome || ''
    draft.annualTaxableIncome = saved.annualTaxableIncome || draft.annualTaxableIncome || ''
    draft.declaredValue = saved.declaredValue || draft.declaredValue || ''
    draft.companyName = saved.companyName || draft.companyName || ''
    draft.educationLevel = saved.educationLevel || draft.educationLevel || ''
    draft.note = saved.note || draft.note || ''
  })
}

const refreshFromCloud = async () => {
  refresh()
  const requestSequence = ++cloudRestoreSequence
  if (!isLoggedIn()) return
  const requestedScope = resolveSupplementMaterialScope()
  if (!requestedScope.caseId) return
  try {
    const restored = await restoreSupplementMaterialsFromCloud(requestedScope)
    if (requestSequence !== cloudRestoreSequence) return
    const activeScope = resolveSupplementMaterialScope()
    if (
      !supplementMaterialScopesOverlap(activeScope, restored.requestedScope) &&
      !supplementMaterialScopesOverlap(activeScope, restored.canonicalScope)
    ) return
    refresh(restored.materials)
  } catch (_) {
    // 云端恢复失败不覆盖本机待上传队列；用户仍可离线补充材料。
  }
}

const baseRecordOf = (type) => {
  const meta = SUPPLEMENT_MATERIAL_TYPES.find((item) => item.key === type) || {}
  const draft = initDraft(type)
  return {
    ...materialOf(type),
    id: type,
    materialId: type,
    type,
    materialType: type,
    name: meta.title,
    materialName: meta.title,
    group: meta.group,
    unavailable: materialOf(type).unavailable === true,
    months: draft.months,
    sameEmployerMonths: draft.sameEmployerMonths,
    employerCount: draft.employerCount,
    monthlyIncome: draft.monthlyIncome,
    annualTaxableIncome: draft.annualTaxableIncome,
    declaredValue: draft.declaredValue,
    companyName: draft.companyName,
    educationLevel: draft.educationLevel,
    note: draft.note,
    updatedAt: new Date().toISOString()
  }
}

const saveDraft = (type) => {
  upsertSupplementMaterial(baseRecordOf(type))
  refresh()
  uni.showToast({ title: '摘要已保存', icon: 'none' })
}

const setMaterialAvailability = async (type, available) => {
  const base = baseRecordOf(type)
  const record = available
    ? { ...base, unavailable: false, status: materialHasFiles(type) ? 'uploaded' : 'draft', statusText: materialHasFiles(type) ? '待确认' : '待上传' }
    : { ...base, unavailable: true, attachments: [], attachmentCount: 0, fileUrl: '', uploadUrl: '', localFilePath: '', fileName: '', status: 'unavailable', statusText: '暂无' }
  upsertSupplementMaterial(record)
  if (isLoggedIn()) await syncSupplementMaterial(record, saveSupplementMaterialRemote)
  refresh()
}

const chooseEducation = (type) => new Promise((resolve) => {
  uni.showActionSheet({
    itemList: EDUCATION_OPTIONS.map((item) => item.label),
    success: (res) => {
      const selected = EDUCATION_OPTIONS[res.tapIndex]
      if (!selected) { resolve(null); return }
      const draft = initDraft(type)
      draft.educationLevel = selected.value
      const record = { ...baseRecordOf(type), educationLevel: selected.value, status: 'provided', statusText: selected.label, unavailable: false }
      upsertSupplementMaterial(record)
      if (isLoggedIn()) syncSupplementMaterial(record, saveSupplementMaterialRemote)
      refresh()
      resolve(selected)
    },
    fail: () => resolve(null)
  })
})

const normalizePickedMaterials = (res, fallbackName, sourceType) => {
  const tempFiles = Array.isArray(res.tempFiles) ? res.tempFiles : []
  const tempFilePaths = Array.isArray(res.tempFilePaths) ? res.tempFilePaths : []
  const count = Math.max(tempFiles.length, tempFilePaths.length)
  const out = []
  for (let i = 0; i < count; i += 1) {
    const f = tempFiles[i] || {}
    const path = tempFilePaths[i] || f.path || ''
    if (!path) continue
    const mimeType = f.type || (sourceType === 'image' ? 'image/jpeg' : 'application/pdf')
    const fallback = count > 1 ? fallbackName.replace(/(\.[^.]+)$/, `-${i + 1}$1`) : fallbackName
    const file = f.file || (typeof File !== 'undefined' && f instanceof File ? f : null)
    out.push({
      path,
      name: f.name || fallback,
      size: typeof f.size === 'number' ? f.size : '',
      mimeType,
      fileType: /^image\//i.test(mimeType) ? 'image' : 'pdf',
      file
    })
  }
  if (!out.length) throw new Error('未选择材料')
  return out
}

const pickImageMaterial = () => new Promise((resolve, reject) => {
  uni.chooseImage({
    count: 9,
    sourceType: ['album', 'camera'],
    success: (res) => {
      try { resolve(normalizePickedMaterials(res, 'material.jpg', 'image')) } catch (e) { reject(e) }
    },
    fail: () => reject(new Error('cancel'))
  })
})

const pickPdfMaterial = () => new Promise((resolve, reject) => {
  if (typeof uni.chooseFile !== 'function') {
    reject(new Error('当前环境不支持 PDF 文件选择，请使用截图上传'))
    return
  }
  uni.chooseFile({
    count: 6,
    extension: ['.pdf'],
    success: (res) => {
      try { resolve(normalizePickedMaterials(res, 'material.pdf', 'pdf')) } catch (e) { reject(e) }
    },
    fail: () => reject(new Error('cancel'))
  })
})

const confirmMaterialAccess = () => new Promise((resolve) => {
  if (typeof uni.showModal !== 'function') {
    resolve(true)
    return
  }
  uni.showModal({
    title: '选择材料',
    content: '接下来会打开相册或文件选择器。请只选择本次需要上传的征信、三金、流水、个税或资产材料，平台仅用于材料分析和顾问复核。',
    confirmText: '继续选择',
    cancelText: '取消',
    success: (res) => resolve(!!res.confirm),
    fail: () => resolve(false)
  })
})

const chooseMaterialUploadMode = () => new Promise((resolve, reject) => {
  if (typeof uni.showActionSheet !== 'function') {
    resolve('image')
    return
  }
  uni.showActionSheet({
    itemList: ['上传截图（可多选）', '上传 PDF/文件'],
    success: (res) => resolve(res.tapIndex === 1 ? 'pdf' : 'image'),
    fail: () => reject(new Error('cancel'))
  })
})

const pickMaterialFiles = async () => {
  const allowed = await confirmMaterialAccess()
  if (!allowed) throw new Error('cancel')
  const mode = await chooseMaterialUploadMode()
  return mode === 'pdf' ? pickPdfMaterial() : pickImageMaterial()
}

const maxNumber = (...values) => Math.max(0, ...values.map((value) => Number(value || 0)).filter((value) => Number.isFinite(value)))
const mergeExtractedPatch = (base = {}, extracted = {}) => ({
  months: maxNumber(base.months, extracted.months),
  sameEmployerMonths: maxNumber(base.sameEmployerMonths, extracted.sameEmployerMonths),
  employerCount: maxNumber(base.employerCount, extracted.employerCount),
  annualTaxableIncome: maxNumber(base.annualTaxableIncome, extracted.annualTaxableIncome),
  monthlyIncome: maxNumber(base.monthlyIncome, extracted.monthlyIncome),
  declaredValue: maxNumber(base.declaredValue, extracted.declaredValue)
})
const uniqueText = (list = []) => Array.from(new Set(list.filter(Boolean).map((item) => String(item).trim()).filter(Boolean)))
const applyExtractedToDraft = (type, extracted = {}) => {
  const draft = initDraft(type)
  if (extracted.months) draft.months = String(extracted.months)
  if (extracted.sameEmployerMonths) draft.sameEmployerMonths = String(extracted.sameEmployerMonths)
  if (extracted.employerCount) draft.employerCount = String(extracted.employerCount)
  if (extracted.annualTaxableIncome) draft.annualTaxableIncome = String(Math.round(extracted.annualTaxableIncome))
  if (extracted.monthlyIncome) draft.monthlyIncome = String(Math.round(extracted.monthlyIncome))
  if (extracted.declaredValue) draft.declaredValue = String(Math.round(extracted.declaredValue))
}

const buildRecordWithAttachments = (type, attachments = [], patch = {}) => {
  const primary = attachments[0] || {}
  const hasFiles = attachments.length > 0
  const base = baseRecordOf(type)
  return {
    ...base,
    ...patch,
    attachments,
    attachmentCount: attachments.length,
    fileUrl: primary.fileUrl || '',
    uploadUrl: primary.uploadUrl || '',
    localFilePath: primary.localFilePath || '',
    fileName: primary.fileName || '',
    fileSize: primary.fileSize || '',
    fileType: primary.fileType || '',
    mimeType: primary.mimeType || '',
    status: hasFiles ? (patch.status || 'uploaded') : (base.unavailable ? 'unavailable' : 'draft'),
    statusText: hasFiles ? (patch.statusText || '待确认') : (base.unavailable ? '暂无' : '待上传'),
    updatedAt: new Date().toISOString()
  }
}

const persistExactMaterial = async (record) => {
  if (isLoggedIn()) return syncSupplementMaterialExact(record, saveSupplementMaterialRemote)
  replaceSupplementMaterial(record)
  return { ok: true, localOnly: true, queued: true, material: record }
}

const confirmAttachmentAction = ({ title, content, confirmText = '确定' }) => new Promise((resolve) => {
  if (typeof uni.showModal !== 'function') {
    resolve(true)
    return
  }
  uni.showModal({
    title,
    content,
    confirmText,
    cancelText: '取消',
    success: (res) => resolve(!!res.confirm),
    fail: () => resolve(false)
  })
})

const removeAttachment = async (type, file, fileIndex = 0) => {
  if (uploadingKey.value || recognizingKey.value) return
  const ok = await confirmAttachmentAction({
    title: '删除材料',
    content: `确定删除「${file.fileName || '这份材料'}」吗？删除后管理员端也会同步更新，但已产生的历史沟通留档不会被清除。`,
    confirmText: '删除'
  })
  if (!ok) return
  const target = attachmentIdentity(file, fileIndex)
  const attachments = attachmentsOf(type).filter((item, index) => attachmentIdentity(item, index) !== target)
  const record = buildRecordWithAttachments(type, attachments)
  const result = await persistExactMaterial(record)
  refresh()
  uni.showToast({ title: result.queued ? '已删除，稍后同步' : '材料已删除', icon: 'none' })
}

const replaceAttachment = async (type, file, fileIndex = 0) => {
  if (uploadingKey.value || recognizingKey.value) return
  const ok = await confirmAttachmentAction({
    title: '替换材料',
    content: `将替换「${file.fileName || '这份材料'}」，其他已上传材料会保留。`,
    confirmText: '去替换'
  })
  if (!ok) return
  await uploadMaterial(type, { replaceAttachmentKey: attachmentIdentity(file, fileIndex) })
}

const uploadMaterial = async (type, options = {}) => {
  if (!isLoggedIn()) {
    uni.navigateTo({ url: '/pages/login/index' })
    return
  }
  if (uploadingKey.value) return
  uploadingKey.value = type
  try {
    const pickedFiles = await pickMaterialFiles()
    let extractedPatch = {}
    const ocrTexts = []
    const detectedSummaries = []
    const ocrErrors = []
    const newAttachments = []
    if (pickedFiles.some((item) => item.fileType === 'image')) recognizingKey.value = type
    for (const picked of pickedFiles) {
      let attachmentOcr = {}
      if (picked.fileType === 'image') {
        try {
          const text = await parseImageText(picked.file || picked.path)
          const extracted = extractSupplementMaterialFromText(text, type)
          extractedPatch = mergeExtractedPatch(extractedPatch, extracted)
          if (extracted.ocrText) ocrTexts.push(extracted.ocrText)
          if (extracted.detectedSummary) detectedSummaries.push(extracted.detectedSummary)
          attachmentOcr = {
            ocrText: extracted.ocrText,
            ocrConfidence: extracted.confidence,
            detectedSummary: extracted.detectedSummary
          }
        } catch (e) {
          const message = e && e.message ? String(e.message).slice(0, 80) : '截图识别失败，已保存待人工复核'
          ocrErrors.push(message)
          attachmentOcr = { ocrError: message }
        }
      }
      let url = ''
      let uploadError = ''
      try {
        url = await uploadLocalFile({ filePath: picked.path, file: picked.file, folder: 'supplement-materials' })
      } catch (e) {
        uploadError = e && e.message ? String(e.message) : '网络上传失败'
      }
      const uploadedAt = new Date().toISOString()
      const attachmentId = `${type}_${Date.now()}_${newAttachments.length}`
      newAttachments.push({
        id: attachmentId,
        attachmentId,
        fileUrl: url,
        uploadUrl: url,
        localFilePath: url ? '' : picked.path,
        fileName: picked.name,
        fileSize: picked.size,
        fileType: picked.fileType,
        mimeType: picked.mimeType,
        uploadError,
        uploadedAt,
        createdAt: uploadedAt,
        updatedAt: uploadedAt,
        ...attachmentOcr
      })
    }
    recognizingKey.value = ''
    applyExtractedToDraft(type, extractedPatch)
    const ocrPatch = {
      ocrText: uniqueText(ocrTexts).join('\n\n'),
      ocrConfidence: detectedSummaries.length >= 2 ? 'medium' : detectedSummaries.length ? 'low' : '',
      detectedSummary: uniqueText(detectedSummaries).join(' · '),
      ocrError: uniqueText(ocrErrors).join('；'),
      months: extractedPatch.months || baseRecordOf(type).months,
      sameEmployerMonths: extractedPatch.sameEmployerMonths || baseRecordOf(type).sameEmployerMonths,
      employerCount: extractedPatch.employerCount || baseRecordOf(type).employerCount,
      annualTaxableIncome: extractedPatch.annualTaxableIncome || baseRecordOf(type).annualTaxableIncome,
      monthlyIncome: extractedPatch.monthlyIncome || baseRecordOf(type).monthlyIncome,
      declaredValue: extractedPatch.declaredValue || baseRecordOf(type).declaredValue
    }
    const existingAttachments = options.replaceAttachmentKey
      ? attachmentsOf(type).filter((item, index) => attachmentIdentity(item, index) !== options.replaceAttachmentKey)
      : attachmentsOf(type)
    const attachments = [...newAttachments, ...existingAttachments]
    const allUploaded = newAttachments.every((item) => item.fileUrl || item.uploadUrl)
    const record = buildRecordWithAttachments(type, attachments, {
      ...ocrPatch,
      uploadError: uniqueText(newAttachments.map((item) => item.uploadError)).join('；'),
      status: allUploaded ? 'uploaded' : 'queued',
      statusText: allUploaded ? '待确认' : '本机已保存',
      uploadedAt: new Date().toISOString()
    })
    const result = await persistExactMaterial(record)
    refresh()
    const verb = options.replaceAttachmentKey ? '替换' : '上传'
    uni.showToast({ title: result.localOnly ? `已记录${newAttachments.length}份，稍后同步` : result.queued ? `已保存${newAttachments.length}份，稍后同步` : `已${verb}${newAttachments.length}份材料`, icon: 'none' })
  } catch (e) {
    const message = e && e.message ? String(e.message) : ''
    if (!/cancel/i.test(message)) uni.showToast({ title: message || '上传失败', icon: 'none' })
  } finally {
    uploadingKey.value = ''
    recognizingKey.value = ''
  }
}

const goBack = () => safeBack('/pages/profile/profile')
const goMatch = () => safeSwitchTab('/pages/match/index')
const goAdvisor = () => uni.navigateTo({ url: '/pages/profile/advisor', fail: () => { uni.showToast({ title: '无法打开顾问页', icon: 'none' }) } })

onShow(() => { void refreshFromCloud() })
</script>

<style scoped>
.page { min-height: 100vh; background: #F3F7FF; }
.nav { flex-direction: row; align-items: center; padding: calc(var(--rpt-safe-top) + 8px) 14px 10px; background: #F6F9FF; border-bottom: 1px solid rgba(214, 226, 245, 0.8); }
.nav-title { flex: 1; text-align: center; font-size: 16px; font-weight: 900; color: #071B3D; }
.nav-spacer { width: 38px; }
.scroll-body { flex: 1; height: 100vh; background: linear-gradient(180deg, #F6F9FF 0%, #F2F6FF 56%, #F8FAFF 100%); }
.wrap { padding: 14px 14px 0; }
.hero { border-radius: 8px; padding: 18px 16px; background: linear-gradient(180deg, #FFFFFF 0%, #EEF6FF 100%); border: 1px solid #DCEBFF; box-shadow: 0 12px 26px rgba(23, 83, 156, 0.08); }
.hero-kicker { font-size: 12px; color: #0A70EA; font-weight: 900; }
.hero-title { margin-top: 7px; font-size: 22px; line-height: 28px; color: #071B3D; font-weight: 900; }
.hero-sub { margin-top: 7px; font-size: 12px; line-height: 18px; color: #64748B; }
.hero-tags { margin-top: 13px; flex-direction: row; }
.hero-tag { height: 28px; padding: 0 11px; border-radius: 8px; background: #0A70EA; align-items: center; justify-content: center; margin-right: 8px; }
.hero-tag-soft { background: #EAF3FF; border: 1px solid #BFDBFE; }
.hero-tag-text { color: #FFFFFF; font-size: 12px; font-weight: 900; }
.hero-tag-soft-text { color: #0A70EA; }
.summary-panel { margin-top: 12px; min-height: 72px; border-radius: 8px; background: #FFFFFF; border: 1px solid #E7EEF8; box-shadow: 0 8px 20px rgba(28, 62, 114, 0.06); flex-direction: row; align-items: center; }
.summary-cell { flex: 1; align-items: center; }
.summary-value { font-size: 20px; color: #071B3D; font-weight: 900; }
.summary-label { margin-top: 4px; font-size: 11px; color: #7C8799; }
.guide-card { margin-top: 12px; padding: 13px 14px; border-radius: 8px; background: #FFFBEB; border: 1px solid #FDE68A; }
.guide-title { font-size: 14px; color: #92400E; font-weight: 900; }
.guide-sub { margin-top: 5px; font-size: 12px; line-height: 18px; color: #B45309; }
.group { margin-top: 16px; }
.section-head { flex-direction: row; align-items: center; justify-content: space-between; margin-bottom: 9px; }
.section-title { font-size: 18px; color: #071B3D; font-weight: 900; }
.section-note { font-size: 12px; color: #7C8799; font-weight: 800; }
.material-card { position: relative; margin-bottom: 10px; border-radius: 8px; padding: 13px; background: #FFFFFF; border: 1px solid #E7EEF8; box-shadow: 0 8px 18px rgba(28, 62, 114, 0.05); overflow: hidden; }
.material-card-active { border-color: #BFDBFE; box-shadow: 0 12px 24px rgba(8, 108, 234, 0.12); }
.material-card-active::before { content: ''; position: absolute; left: -40%; right: -40%; top: 0; height: 2px; background: linear-gradient(90deg, transparent, #086CEA, transparent); animation: materialScan 1.4s ease-in-out infinite; }
.material-head { flex-direction: row; align-items: center; }
.material-icon { width: 38px; height: 38px; border-radius: 8px; background: #EAF3FF; align-items: center; justify-content: center; margin-right: 10px; border: 1px solid #D7E8FF; }
.material-icon-text { font-size: 14px; color: #0A70EA; font-weight: 900; }
.material-main { flex: 1; min-width: 0; }
.material-title { font-size: 15px; color: #071B3D; font-weight: 900; }
.material-desc { margin-top: 3px; font-size: 11px; color: #7C8799; line-height: 15px; }
.material-status { min-width: 54px; text-align: center; padding: 4px 7px; border-radius: 8px; font-size: 11px; color: #B45309; background: #FFFBEB; font-weight: 900; }
.material-status-done { color: #15803D; background: #F0FDF4; }
.choice-row { flex-direction: row; margin-top: 12px; }
.choice-chip { height: 30px; padding: 0 12px; border-radius: 8px; background: #F8FAFC; border: 1px solid #DDE7F4; align-items: center; justify-content: center; margin-right: 8px; }
.choice-chip-on { background: #EAF3FF; border-color: #93C5FD; }
.choice-chip-text { font-size: 12px; color: #64748B; font-weight: 900; }
.choice-chip-text-on { color: #086CEA; }
.guide-box { margin-top: 10px; padding: 10px; border-radius: 8px; background: #F8FBFF; border: 1px solid #E1EAF6; }
.guide-box-title { font-size: 11px; color: #071B3D; font-weight: 900; }
.guide-box-title-gap { margin-top: 8px; }
.guide-box-text { margin-top: 4px; font-size: 11px; color: #64748B; line-height: 16px; }
.example-row { flex-direction: row; flex-wrap: wrap; margin-top: 8px; }
.example-chip { margin-right: 6px; margin-bottom: 6px; padding: 4px 7px; border-radius: 7px; background: #FFFFFF; border: 1px solid #DDE7F4; color: #334155; font-size: 10px; font-weight: 800; }
.education-row { margin-top: 10px; height: 42px; border-radius: 8px; background: #F8FBFF; border: 1px solid #E1EAF6; padding: 0 11px; flex-direction: row; align-items: center; justify-content: space-between; }
.education-label { font-size: 12px; color: #64748B; font-weight: 900; }
.education-value { font-size: 13px; color: #071B3D; font-weight: 900; }
.form-grid { flex-direction: row; margin-top: 12px; }
.field { flex: 1; margin-right: 8px; }
.field:last-child { margin-right: 0; }
.field-full { margin-top: 10px; margin-right: 0; }
.field-label { font-size: 11px; color: #64748B; font-weight: 800; }
.field-input { margin-top: 6px; height: 36px; border-radius: 8px; background: #F8FBFF; border: 1px solid #E1EAF6; padding: 0 9px; font-size: 13px; color: #071B3D; }
.note-input { margin-top: 10px; min-height: 58px; border-radius: 8px; background: #F8FBFF; border: 1px solid #E1EAF6; padding: 9px; font-size: 12px; color: #071B3D; line-height: 18px; }
.file-strip { margin-top: 9px; padding: 9px; border-radius: 8px; background: #F0FDF4; border: 1px solid #BBF7D0; }
.file-strip-head { flex-direction: row; align-items: center; justify-content: space-between; margin-bottom: 5px; }
.file-label { font-size: 11px; color: #15803D; font-weight: 900; }
.file-count { font-size: 11px; color: #16A34A; font-weight: 900; }
.file-row { min-height: 30px; flex-direction: row; align-items: center; padding: 3px 0; }
.file-main { flex: 1; min-width: 0; flex-direction: row; align-items: center; }
.file-dot { width: 5px; height: 5px; border-radius: 3px; background: #22C55E; margin-right: 7px; }
.file-name { flex: 1; font-size: 11px; color: #166534; line-height: 15px; }
.file-actions { flex-direction: row; align-items: center; margin-left: 8px; }
.file-action { min-width: 36px; height: 24px; padding: 0 7px; border-radius: 7px; background: #FFFFFF; border: 1px solid #BBF7D0; color: #047857; font-size: 11px; font-weight: 900; text-align: center; line-height: 24px; margin-left: 6px; }
.file-action-danger { color: #DC2626; border-color: #FECACA; background: #FFF7F7; }
.ocr-strip { margin-top: 8px; flex-direction: row; align-items: center; padding: 8px 9px; border-radius: 8px; background: #EAF3FF; border: 1px solid #BFDBFE; }
.ocr-strip-warn { background: #FFFBEB; border-color: #FDE68A; }
.ocr-label { font-size: 11px; color: #086CEA; font-weight: 900; margin-right: 8px; }
.ocr-strip-warn .ocr-label { color: #B45309; }
.ocr-text { flex: 1; font-size: 11px; color: #334155; line-height: 15px; }
.ocr-strip-warn .ocr-text { color: #92400E; }
.material-actions { flex-direction: row; margin-top: 11px; }
.material-ghost, .material-primary { flex: 1; height: 38px; border-radius: 8px; align-items: center; justify-content: center; }
.material-ghost { background: #F8FAFC; border: 1px solid #DDE7F4; margin-right: 9px; }
.material-ghost-text { font-size: 13px; color: #334155; font-weight: 900; }
.material-primary { flex-direction: row; background: linear-gradient(180deg, #3194FF 0%, #086CEA 100%); box-shadow: 0 8px 18px rgba(8, 108, 234, 0.18); }
.material-primary-loading { opacity: .95; }
.inline-spinner { width: 13px; height: 13px; border-radius: 7px; border: 2px solid rgba(255,255,255,.45); border-top-color: #FFFFFF; margin-right: 6px; animation: spin .85s linear infinite; }
.material-primary-text { font-size: 13px; color: #FFFFFF; font-weight: 900; }
.bottom-actions { flex-direction: row; margin-top: 14px; }
.bottom-ghost, .bottom-primary { flex: 1; height: 44px; border-radius: 8px; align-items: center; justify-content: center; }
.bottom-ghost { background: #FFFFFF; border: 1px solid #DDE7F4; margin-right: 10px; }
.bottom-ghost-text { color: #334155; font-size: 14px; font-weight: 900; }
.bottom-primary { background: #086CEA; }
.bottom-primary-text { color: #FFFFFF; font-size: 14px; font-weight: 900; }
.disclaimer { padding: 12px 2px 0; }
.disclaimer-text { font-size: 11px; color: #9AA7BA; line-height: 17px; text-align: center; }
.bottom-safe { height: 44px; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes materialScan { 0% { transform: translateX(-35%); } 100% { transform: translateX(35%); } }

/* ── 桌面端限宽微调 ≥1024px ── */
@media (min-width: 1024px) {
  .wrap { padding: 20px 24px 0; }
  .hero { padding: 22px 20px; }
  .form-grid { margin-top: 14px; }
}
</style>
