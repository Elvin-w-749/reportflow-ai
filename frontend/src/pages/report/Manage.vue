<template>
  <view class="page rpt-page">
    <view class="nav">
      <RptBackButton @click="goBack" />
      <text class="nav-title">信用报告管理</text>
      <text class="nav-action" @click="goUpload">上传</text>
    </view>

    <scroll-view class="scroll-body" scroll-y refresher-enabled :refresher-triggered="refreshing" :scroll-into-view="focusedReportAnchor" scroll-with-animation @refresherrefresh="pullRefresh">
      <view class="wrap rpt-content-max">
        <view v-if="!loggedIn" class="state-card">
          <text class="state-title">登录后管理信用报告</text>
          <text class="state-sub">登录后可以查看历史报告、打开详情、删除旧报告。</text>
          <view class="state-btn" @click="goLogin"><text class="state-btn-text">去登录</text></view>
        </view>

        <view v-else>
          <view v-if="messageReportContext" class="message-report-card">
            <view class="message-report-main">
              <text class="message-report-kicker">消息定位</text>
              <text class="message-report-title">{{ messageReportContext.title }}</text>
              <text class="message-report-sub">{{ messageReportContext.sub }}</text>
            </view>
            <view class="message-report-actions">
              <view class="message-report-primary" @click="goMessageCenter"><text class="message-report-primary-text">返回消息</text></view>
              <view class="message-report-ghost" @click="clearRouteFocus"><text class="message-report-ghost-text">查看全部</text></view>
            </view>
          </view>
          <view class="summary-card">
            <view class="summary-head">
              <view>
                <text class="summary-kicker">个人报告资产</text>
                <text class="summary-title">{{ reportCountText }}</text>
              </view>
              <view class="summary-score" :style="{ borderColor: latestScoreColor }">
                <text class="summary-score-num" :style="{ color: latestScoreColor }">{{ latestScoreText }}</text>
                <text class="summary-score-label">{{ SCORE_COPY.reportTotal.summaryLabel }}</text>
              </view>
            </view>
            <view class="summary-grid">
              <view class="summary-cell">
                <text class="summary-value">{{ localReportCount }}</text>
                <text class="summary-label">本机报告</text>
              </view>
              <view class="summary-cell">
                <text class="summary-value">{{ cloudAssetCountText }}</text>
                <text class="summary-label">云端资产</text>
              </view>
              <view class="summary-cell">
                <text class="summary-value">{{ latestDateText }}</text>
								<text class="summary-label">最近上传</text>
              </view>
            </view>
            <view class="sync-strip" :class="syncOverview.statusClass">
              <view class="sync-dot"></view>
              <view class="sync-copy">
                <text class="sync-title">{{ syncOverview.title }}</text>
                <text class="sync-sub">{{ syncOverview.subtitle }}</text>
              </view>
            </view>
            <view class="summary-actions">
              <view class="summary-primary" @click="openLatest"><text class="summary-primary-text">查看最新报告</text></view>
              <view class="summary-ghost" @click="goUpload"><text class="summary-ghost-text">上传新报告</text></view>
            </view>
          </view>

          <view class="flow-card">
            <view class="flow-step active">
              <text class="flow-num">1</text>
              <text class="flow-text">管理</text>
            </view>
            <view class="flow-line"></view>
            <view class="flow-step">
              <text class="flow-num">2</text>
              <text class="flow-text">查看详情</text>
            </view>
            <view class="flow-line"></view>
            <view class="flow-step">
              <text class="flow-num">3</text>
              <text class="flow-text">匹配方案</text>
            </view>
          </view>

          <view class="section-head">
            <text class="section-title">我的信用报告</text>
            <view v-if="reportRows.length" class="section-actions">
              <text v-if="localSelectableRows.length" class="section-action muted" @click="toggleBatchMode">{{ batchMode ? '完成' : '批量' }}</text>
              <text v-if="reports.length && !batchMode" class="section-action" @click="confirmClearAll">清空本机</text>
            </view>
          </view>
          <scroll-view v-if="reportRows.length" class="filter-scroll" scroll-x>
            <view class="filter-row">
              <view
                v-for="item in assetFilterOptions"
                :key="item.key"
                class="filter-chip"
                :class="{ active: activeFilter === item.key }"
                @click="setAssetFilter(item.key)"
              >
                <text class="filter-chip-text" :class="{ active: activeFilter === item.key }">{{ item.label }}</text>
                <text class="filter-chip-count" :class="{ active: activeFilter === item.key }">{{ item.count }}</text>
              </view>
            </view>
          </scroll-view>

          <view v-if="reportRows.length" class="search-panel">
            <view class="search-box">
              <text class="search-icon">查</text>
              <input class="search-input" v-model="searchKeyword" confirm-type="search" placeholder="搜索文件名、报告类型、日期" />
              <text v-if="searchKeyword" class="search-clear" @click="clearSearch">清除</text>
            </view>
            <view class="sort-row">
              <text class="sort-label">排序</text>
              <view
                v-for="item in sortOptions"
                :key="item.key"
                class="sort-chip"
                :class="{ active: sortMode === item.key }"
                @click="setSortMode(item.key)"
              >
                <text class="sort-chip-text" :class="{ active: sortMode === item.key }">{{ item.label }}</text>
              </view>
            </view>
          </view>

          <view v-if="actionNotice" class="action-notice" :class="actionNotice.tone">
            <view class="action-notice-main">
              <text class="action-notice-title">{{ actionNotice.title }}</text>
              <text class="action-notice-sub">{{ actionNotice.subtitle }}</text>
            </view>
            <view v-if="actionNotice.actionText" class="action-notice-btn" @click="runNoticeAction">
              <text class="action-notice-btn-text">{{ actionNotice.actionText }}</text>
            </view>
            <text class="action-notice-close" @click="dismissActionNotice">收起</text>
          </view>

          <view v-if="batchMode" class="batch-hint">
            <text class="batch-hint-text">批量模式只清理当前筛选下的本机缓存，云端资产默认保护。</text>
          </view>

	          <view v-if="filteredReportRows.length" class="report-list">
	            <SwipeDelete
	              v-for="row in filteredReportRows"
	              :key="row.id"
	              class="report-swipe"
	              :action-text="rowSwipeActionText(row)"
	              :disabled="batchMode"
	              @delete="confirmSwipeDeleteReport(row)"
	              @content-click="handleReportTap(row)"
	            >
	              <view
	                :id="reportAnchorId(row)"
	                class="report-card"
	                :class="{ 'report-card-cloud': row.assetSource === 'cloud', 'report-card-batch': batchMode, 'report-card-selected': isSelected(row), 'report-card-disabled': batchMode && !row.localId, 'report-card-focus': isFocusedReport(row) }"
	              >
	                <view class="report-top">
	                  <view v-if="batchMode" class="select-box" :class="{ selected: isSelected(row), disabled: !row.localId }">
	                    <text class="select-box-text">{{ row.localId ? (isSelected(row) ? '选' : '') : '云' }}</text>
	                  </view>
	                  <view class="report-mark"><text class="report-mark-text">信</text></view>
	                  <view class="report-main">
	                    <view class="report-title-line">
	                      <text class="report-title">{{ row.title }}</text>
	                      <text class="report-status" :class="row.statusClass">{{ row.statusText }}</text>
	                    </view>
	                    <view class="report-meta-line">
												<text class="report-meta">{{ row.dateText }} · {{ row.uploadDateText }} · {{ row.sourceText }}</text>
	                      <text class="report-sync" :class="row.syncClass">{{ row.syncText }}</text>
	                    </view>
	                  </view>
	                </view>
	                <view class="report-bottom">
	                  <view class="report-metric">
	                    <text class="metric-value" :style="{ color: row.scoreColor }">{{ row.scoreText }}</text>
	                    <text class="metric-label">{{ SCORE_COPY.reportTotal.label }}</text>
	                  </view>
	                  <view class="report-metric">
	                    <text class="metric-value">{{ row.riskText }}</text>
	                    <text class="metric-label">风险</text>
	                  </view>
	                  <view class="report-metric">
	                    <text class="metric-value">{{ row.accountText }}</text>
	                    <text class="metric-label">账户</text>
	                  </view>
	                </view>
	                <view v-if="!batchMode" class="report-actions">
	                  <view class="line-btn" @click.stop="openReport(row)"><text class="line-btn-text">{{ row.assetSource === 'cloud' && restoringId === row.cloudId ? '恢复中' : row.primaryActionText }}</text></view>
	                  <view v-if="row.localId && row.syncKey === 'failed'" class="line-btn sync-retry-btn" @click.stop="retrySync(row)">
	                    <text class="line-btn-text">{{ syncingId === row.localId ? '同步中' : '重试同步' }}</text>
	                  </view>
	                  <view v-if="row.cloudId" class="line-btn cloud-action-btn" @click.stop="confirmDeleteCloud(row)">
	                    <text class="line-btn-text">{{ deletingCloudId === row.cloudId ? '处理中' : '移出云端' }}</text>
	                  </view>
	                  <view v-if="row.localId" class="danger-btn" @click.stop="confirmDeleteLocal(row)"><text class="danger-btn-text">{{ row.cloudId ? '移出本机' : '删除' }}</text></view>
	                </view>
	              </view>
	            </SwipeDelete>
	          </view>

          <view v-else-if="reportRows.length" class="state-card">
            <text class="state-title">{{ filterEmptyTitle }}</text>
            <text class="state-sub">{{ filterEmptySub }}</text>
            <view class="state-btn ghost" @click="resetViewState"><text class="state-btn-text ghost">查看全部</text></view>
          </view>

          <view v-else class="state-card">
            <text class="state-title">{{ emptyStateTitle }}</text>
            <text class="state-sub">{{ emptyStateSub }}</text>
            <view class="state-btn" @click="goUpload"><text class="state-btn-text">上传信用报告</text></view>
          </view>
        </view>

        <view class="bottom-safe" :class="{ 'bottom-safe-batch': batchMode }"></view>
      </view>
    </scroll-view>

    <view v-if="batchMode" class="batch-bar">
      <view class="batch-info">
        <text class="batch-title">已选 {{ selectedLocalCount }} / {{ localSelectableRows.length }} 份本机报告</text>
        <text class="batch-sub">云端资产不会删除，老师端/监控端读取不受影响。</text>
      </view>
      <view class="batch-actions">
        <view class="batch-secondary" @click="toggleSelectAllLocal"><text class="batch-secondary-text">{{ allLocalSelected ? '取消全选' : '全选本机' }}</text></view>
        <view class="batch-danger" :class="{ disabled: selectedLocalCount === 0 }" @click="confirmBatchDeleteLocal"><text class="batch-danger-text">移出本机</text></view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { onLoad, onShow } from '@/compat/web-lifecycle.js'
import { isLoggedIn } from '@/services/authService.js'
	import { clearAllReports, deleteCloudReport, deleteReport, getCloudReportList, getReportAnalysisDate, getReportList, getReportStats, getReportUploadDate, isValidReport, restoreCloudReportToLocal, retryReportCloudSync, unlinkCloudReportFromLocal } from '@/services/reportStorage.js'
	import SwipeDelete from '@/components/SwipeDelete.vue'
import RptBackButton from '@/components/RptBackButton.vue'
import { getRiskMeta, getScoreColor } from '@/config/riskLevel.js'
import { resolveV6ScoreDetails } from '@/services/scoreV6.js'
import { decisionReportIdOf, trustedDecisionValue } from '@/services/decisionTrust.js'
import { resolveDecisionAccountCount } from '@/services/decisionMetrics.js'
import safeSwitchTab from '@/utils/safeSwitchTab.js'
import safeBack from '@/utils/safeBack.js'
import { SCORE_COPY } from '@/utils/scorePresentation.js'
import { strictNonNegativeNumberOrNull } from '@/utils/strictNumber.js'

const VIEW_STATE_KEY = 'report_manage_view_state'
const DETAIL_CONTEXT_KEY = 'report_manage_detail_context'
const VIEW_STATE_TTL_MS = 30 * 60 * 1000

const loggedIn = ref(false)
const refreshing = ref(false)
const reports = ref([])
const cloudReports = ref([])
const cloudLoading = ref(false)
const cloudLoaded = ref(false)
const stats = ref({ totalCount: 0, latestScore: null, averageScore: null })
const syncingId = ref('')
const restoringId = ref('')
const deletingCloudId = ref('')
const batchMode = ref(false)
const selectedLocalIds = ref([])
const activeFilter = ref('all')
const searchKeyword = ref('')
const sortMode = ref('newest')
const actionNotice = ref(null)
const routeSource = ref('')
const focusedReportId = ref('')

const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== '')
const queryText = (value) => Array.isArray(value) ? String(value[0] || '') : String(value || '')
const safeAnchorText = (value) => String(value || '').replace(/[^A-Za-z0-9_-]/g, '-')
const parseStoredState = (value) => {
  if (!value) return null
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch (e) { return null }
  }
  return value && typeof value === 'object' ? value : null
}
const asArray = (value) => {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.list)) return value.list
  if (Array.isArray(value?.items)) return value.items
  if (Array.isArray(value?.records)) return value.records
  return []
}
const numberOrNull = (value) => {
	const parsed = strictNonNegativeNumberOrNull(value)
	return parsed == null ? null : Math.round(parsed)
}
const scoreOf = (row) => {
  const analysis = row?.analysisData || row?.analysisResult || null
  const expectedReportId = decisionReportIdOf(row)
  const resolved = resolveV6ScoreDetails(analysis, row?.decisionTrust || null, expectedReportId)
  return resolved.decisionEligible === true ? numberOrNull(resolved.score) : null
}
const cloudIdOf = (row) => String(first(row?.cloudReportId, row?.serverReportId, row?.reportId, row?.report_id, row?._id, row?.id, '') || '')
const localCloudIdOf = (row) => String(first(row?.cloudReportId, row?.serverReportId, row?.syncMeta?.cloudReportId, row?.syncMeta?.remoteId, row?.remoteId, '') || '')
const accountCountOf = (row) => {
	const resolved = resolveDecisionAccountCount(
		row?.analysisData || row?.analysisResult || null,
		row?.decisionTrust || null,
		decisionReportIdOf(row)
	)
	return resolved.known ? resolved.value : null
}
const riskLevelOf = (row) => {
  const expectedReportId = decisionReportIdOf(row)
  const level = trustedDecisionValue(row?.decisionTrust || null, 'riskLevel', 'riskLevel', expectedReportId)
  return typeof level === 'string' && level.trim() ? level.trim() : null
}

const dateText = (value) => {
  if (!value) return '未知日期'
  const s = String(value)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return s.slice(0, 10) || '未知日期'
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const reportDateTextOf = (row) => {
	const value = getReportAnalysisDate(row)
	return value ? `报告日 ${dateText(value)}` : '报告日待核对'
}
const uploadDateTextOf = (row) => {
	const value = getReportUploadDate(row)
	return value ? `上传 ${dateText(value)}` : '上传时间待核对'
}
const sortTimeOf = (row) => {
  const raw = first(row?.createdAt, row?.created_at, row?.updatedAt, row?.updated_at, row?.uploadTime, row?.date)
  const t = raw ? new Date(raw).getTime() : 0
  return Number.isFinite(t) ? t : 0
}

const syncStatusOf = (row) => {
  const meta = (row && row.syncMeta) || {}
  const raw = String(row?.syncStatus || row?.cloudSyncStatus || meta.status || '').toLowerCase()
  if (/syncing|pending|uploading|processing/.test(raw)) return { key: 'syncing', text: '云端同步中', className: 'syncing' }
  if (/fail|error|timeout/.test(raw)) return { key: 'failed', text: '云端同步失败', className: 'failed' }
  if (/synced|success|done/.test(raw) || row?.cloudReportId || row?.serverReportId || meta.cloudReportId) {
    return { key: 'synced', text: '云端已同步', className: 'synced' }
  }
  return { key: 'local', text: '本地已保存', className: 'local' }
}

const refreshCloud = async () => {
  cloudReports.value = []
  cloudLoaded.value = false
  if (!loggedIn.value) return
  cloudLoading.value = true
  try {
    cloudReports.value = asArray(await getCloudReportList(1, 50))
  } finally {
    cloudLoading.value = false
    cloudLoaded.value = true
  }
}

const refresh = async () => {
  loggedIn.value = isLoggedIn()
  if (!loggedIn.value) {
    reports.value = []
    cloudReports.value = []
    cloudLoading.value = false
    cloudLoaded.value = false
    stats.value = { totalCount: 0, latestScore: null, averageScore: null }
    return
  }
  reports.value = getReportList()
  selectedLocalIds.value = selectedLocalIds.value.filter((id) => reports.value.some((row) => row && row.id === id))
  stats.value = getReportStats()
  await refreshCloud()
}

const localReportRows = computed(() => reports.value.map((row, index) => {
  const score = scoreOf(row)
  const riskMeta = getRiskMeta(riskLevelOf(row))
  const valid = isValidReport(row)
  const sync = syncStatusOf(row)
  const localId = row.id || `report-${index}`
  const cloudId = localCloudIdOf(row)
  return {
    id: localId,
    localId,
    cloudId,
    assetKey: cloudId || localId,
    raw: row,
    title: row.fileName || row.reportType || `信用报告 ${index + 1}`,
		dateText: reportDateTextOf(row),
		uploadDateText: uploadDateTextOf(row),
		uploadDateValue: getReportUploadDate(row),
    sourceText: row.reportType || '本机信用报告',
    scoreText: score == null ? '--' : String(score),
    scoreColor: getScoreColor(score),
		riskText: valid ? (riskLevelOf(row) ? riskMeta.riskLabel : '待核对') : '待恢复',
    accountText: accountCountOf(row) == null ? '--' : String(accountCountOf(row)),
    statusText: valid ? '可查看' : '需重传',
    statusClass: valid ? 'ok' : 'warn',
    syncKey: sync.key,
    syncText: sync.text,
    syncClass: sync.className,
    assetSource: cloudId ? 'both' : 'local',
    canOpen: true,
    needsUpload: !valid,
    primaryActionText: valid ? '查看详情' : '重新上传',
    sortTime: sortTimeOf(row)
  }
}))

const cloudReportRows = computed(() => cloudReports.value.map((row, index) => {
  const cloudId = cloudIdOf(row) || `cloud-${index}`
  const score = scoreOf(row)
  const accountCount = accountCountOf(row)
  const riskMeta = getRiskMeta(riskLevelOf(row))
  return {
    id: `cloud_${cloudId}`,
    localId: '',
    cloudId,
    assetKey: cloudId,
    raw: row,
    title: first(row.fileName, row.file_name, row.name, row.title, `云端信用报告 ${index + 1}`),
		dateText: reportDateTextOf(row),
		uploadDateText: uploadDateTextOf(row),
		uploadDateValue: getReportUploadDate(row),
    sourceText: first(row.reportType, row.report_type, '云端信用报告'),
    scoreText: score == null ? '--' : String(score),
    scoreColor: getScoreColor(score),
		riskText: riskLevelOf(row) ? riskMeta.riskLabel : '待核对',
    accountText: accountCount == null ? '--' : String(accountCount),
    statusText: '云端资产',
    statusClass: 'cloud',
    syncKey: 'synced',
    syncText: '云端已同步',
    syncClass: 'synced',
    assetSource: 'cloud',
    canOpen: false,
    needsUpload: false,
    primaryActionText: '恢复详情',
    sortTime: sortTimeOf(row)
  }
}))

const reportRows = computed(() => {
  const merged = new Map()
  localReportRows.value.forEach((row) => merged.set(row.assetKey, row))
  cloudReportRows.value.forEach((row) => {
    const existing = merged.get(row.assetKey)
    if (!existing) {
      merged.set(row.assetKey, row)
      return
    }
    merged.set(row.assetKey, {
      ...existing,
      cloudId: row.cloudId,
      assetSource: 'both',
      syncKey: 'synced',
      syncText: '本机+云端',
      syncClass: 'synced',
      statusText: existing.canOpen ? '可查看' : existing.statusText,
      statusClass: existing.canOpen ? 'ok' : existing.statusClass,
      sortTime: Math.max(existing.sortTime || 0, row.sortTime || 0)
    })
  })
  return [...merged.values()].sort((a, b) => (b.sortTime || 0) - (a.sortTime || 0))
})
const reportAnchorId = (row) => row ? `report-${safeAnchorText(row.assetKey || row.localId || row.cloudId || row.id)}` : ''
const matchesFocusedReport = (row) => {
  const id = String(focusedReportId.value || '')
  if (!id || !row) return false
  return [row.localId, row.cloudId, row.assetKey, row.id].filter(Boolean).map(String).includes(id)
}
const focusedReportRow = computed(() => reportRows.value.find(matchesFocusedReport) || null)
const focusedReportAnchor = computed(() => focusedReportRow.value ? reportAnchorId(focusedReportRow.value) : '')
const isFocusedReport = (row) => Boolean(routeSource.value === 'message' && matchesFocusedReport(row))
const messageReportContext = computed(() => {
  if (routeSource.value !== 'message') return null
  const row = focusedReportRow.value
  if (focusedReportId.value && row) return { title: `已定位到 ${row.title}`, sub: `${row.dateText} · ${row.syncText}，可继续查看详情或恢复云端资产。` }
  if (focusedReportId.value) return { title: '正在定位消息关联报告', sub: '已清空旧筛选，若本机没有这份报告，可从云端资产恢复或重新上传。' }
  return { title: '已从消息进入信用报告管理', sub: '当前展示完整报告资产，可继续查看详情或切换报告。' }
})
const matchesAssetFilter = (row, key) => {
  if (!row) return false
  if (key === 'local') return Boolean(row.localId)
  if (key === 'cloud') return Boolean(row.cloudId)
  if (key === 'failed') return row.syncKey === 'failed'
  if (key === 'needsUpload') return Boolean(row.needsUpload)
  return true
}
const assetFilterOptions = computed(() => {
  const rows = reportRows.value
  return [
    { key: 'all', label: '全部', count: rows.length },
    { key: 'local', label: '本机', count: rows.filter((row) => matchesAssetFilter(row, 'local')).length },
    { key: 'cloud', label: '云端', count: rows.filter((row) => matchesAssetFilter(row, 'cloud')).length },
    { key: 'failed', label: '失败', count: rows.filter((row) => matchesAssetFilter(row, 'failed')).length },
    { key: 'needsUpload', label: '需重传', count: rows.filter((row) => matchesAssetFilter(row, 'needsUpload')).length }
  ]
})
const activeFilterMeta = computed(() => assetFilterOptions.value.find((item) => item.key === activeFilter.value) || assetFilterOptions.value[0])
const sortOptions = [
  { key: 'newest', label: '最新' },
  { key: 'oldest', label: '最早' },
  { key: 'scoreHigh', label: '综合分高' },
  { key: 'scoreLow', label: '综合分低' }
]
const assetFilterKeys = () => assetFilterOptions.value.map((item) => item.key)
const sortKeys = () => sortOptions.map((item) => item.key)
const sortLabelOf = (key) => (sortOptions.find((item) => item.key === key) || sortOptions[0]).label
const searchTextOf = (row) => [row?.title, row?.sourceText, row?.dateText, row?.syncText, row?.statusText, row?.scoreText]
  .filter((item) => item !== undefined && item !== null)
  .join(' ')
  .toLowerCase()
const matchesSearch = (row) => {
  const keyword = String(searchKeyword.value || '').trim().toLowerCase()
  if (!keyword) return true
  return searchTextOf(row).includes(keyword)
}
const filteredReportRows = computed(() => {
  const scoreValue = (row) => {
    const n = numberOrNull(row?.scoreText)
    return n == null ? -1 : n
  }
  const rows = reportRows.value
    .filter((row) => matchesAssetFilter(row, activeFilter.value))
    .filter((row) => matchesSearch(row))
  return [...rows].sort((a, b) => {
    if (sortMode.value === 'oldest') return (a.sortTime || 0) - (b.sortTime || 0)
    if (sortMode.value === 'scoreHigh') return scoreValue(b) - scoreValue(a) || (b.sortTime || 0) - (a.sortTime || 0)
    if (sortMode.value === 'scoreLow') return scoreValue(a) - scoreValue(b) || (b.sortTime || 0) - (a.sortTime || 0)
    return (b.sortTime || 0) - (a.sortTime || 0)
  })
})
const localSelectableRows = computed(() => filteredReportRows.value.filter((row) => row.localId))
const selectedLocalCount = computed(() => selectedLocalIds.value.length)
const allLocalSelected = computed(() => localSelectableRows.value.length > 0 && selectedLocalCount.value === localSelectableRows.value.length)
const latestRow = computed(() => reportRows.value.find((row) => row.canOpen) || reportRows.value[0] || null)
const latestScoreText = computed(() => stats.value.latestScore == null ? '--' : String(stats.value.latestScore))
const latestScoreColor = computed(() => getScoreColor(stats.value.latestScore))
const latestDateText = computed(() => latestRow.value && latestRow.value.uploadDateValue ? dateText(latestRow.value.uploadDateValue) : '--')
const localReportCount = computed(() => reports.value.length)
const cloudAssetCount = computed(() => cloudReports.value.length)
const cloudAssetCountText = computed(() => cloudLoading.value ? '读取中' : String(cloudAssetCount.value))
const reportCountText = computed(() => reportRows.value.length ? `共 ${reportRows.value.length} 份报告资产` : '还没有保存报告')
const emptyStateTitle = computed(() => cloudLoading.value ? '正在读取云端资产' : '暂无信用报告')
const emptyStateSub = computed(() => cloudLoading.value ? '正在同步本机缓存与云端报告资产。' : '上传报告后，这里会沉淀你的历史报告和最新分析结果。')
const filterEmptyTitle = computed(() => searchKeyword.value ? '没有找到匹配报告' : `暂无${activeFilterMeta.value.label}资产`)
const filterEmptySub = computed(() => searchKeyword.value ? '换个关键词或清除搜索后再试。' : '当前筛选下没有报告资产，可切回全部查看完整列表。')
const syncOverview = computed(() => {
  const rows = reportRows.value
  if (cloudLoading.value) return { title: '云端资产读取中', subtitle: `正在融合本机 ${localReportCount.value} 份报告与云端资产。`, statusClass: 'syncing' }
  if (!rows.length) return { title: '本地已保存', subtitle: '暂无报告需要同步。', statusClass: 'local' }
  if (rows.some((row) => row.syncKey === 'failed')) {
    return { title: '云端同步失败', subtitle: '本地报告仍可查看，请稍后重试或重新上传。', statusClass: 'failed' }
  }
  if (rows.some((row) => row.syncKey === 'syncing')) {
    return { title: '云端同步中', subtitle: '本地报告可先查看，同步完成后老师端可读取。', statusClass: 'syncing' }
  }
  if (cloudAssetCount.value > 0) {
    return { title: '本机与云端已融合', subtitle: `本机 ${localReportCount.value} 份 · 云端 ${cloudAssetCount.value} 份，老师端/监控端读取云端资产。`, statusClass: 'synced' }
  }
  if (rows.some((row) => row.syncKey === 'synced')) {
    return { title: '云端已同步', subtitle: '报告摘要已可供老师端和监控端读取。', statusClass: 'synced' }
  }
  return loggedIn.value
    ? { title: '本地已保存', subtitle: '暂未获取云端同步结果，报告详情可正常查看。', statusClass: 'local' }
    : { title: '本地已保存', subtitle: '登录后可同步到云端。', statusClass: 'local' }
})
const pullRefresh = async () => {
  refreshing.value = true
  await refresh()
  refreshing.value = false
}

const goBack = () => safeBack(routeSource.value === 'message' ? '/pages/message/center' : '/pages/profile/profile')
const goLogin = () => uni.navigateTo({ url: '/pages/login/index', fail: () => { uni.showToast({ title: '无法打开登录页', icon: 'none' }) } })
const goUpload = () => uni.navigateTo({ url: '/pages/report/upload', fail: () => { uni.showToast({ title: '无法打开上传页', icon: 'none' }) } })
const goMessageCenter = () => safeSwitchTab('/pages/message/center')
const clearRouteFocus = () => {
  routeSource.value = ''
  focusedReportId.value = ''
  resetViewState()
}
const applyRouteFocusView = () => {
  if (routeSource.value !== 'message') return
  activeFilter.value = 'all'
  searchKeyword.value = ''
  sortMode.value = 'newest'
  batchMode.value = false
  selectedLocalIds.value = []
}
const saveViewState = () => {
  try {
    uni.setStorageSync(VIEW_STATE_KEY, JSON.stringify({
      activeFilter: activeFilter.value,
      searchKeyword: searchKeyword.value,
      sortMode: sortMode.value,
      savedAt: Date.now()
    }))
  } catch (e) { /* ignore */ }
}
const saveDetailContext = (activeId) => {
  const id = String(activeId || '')
  const toContextItem = (row) => ({
    id: row.localId,
    title: row.title,
    dateText: row.dateText,
    sourceText: row.sourceText,
    scoreText: row.scoreText,
    syncText: row.syncText,
    assetSource: row.assetSource
  })
  const items = filteredReportRows.value.filter((row) => row && row.localId).map(toContextItem)
  const activeRow = reportRows.value.find((row) => row && row.localId === id)
  if (activeRow && !items.some((item) => item.id === id)) items.unshift(toContextItem(activeRow))
  try {
    uni.setStorageSync(DETAIL_CONTEXT_KEY, JSON.stringify({
      activeId: id,
      items,
      filterKey: activeFilter.value,
      filterLabel: activeFilterMeta.value ? activeFilterMeta.value.label : '全部',
      searchKeyword: searchKeyword.value,
      sortMode: sortMode.value,
      sortLabel: sortLabelOf(sortMode.value),
      savedAt: Date.now()
    }))
  } catch (e) { /* ignore */ }
}
const restoreViewState = () => {
  try {
    const raw = uni.getStorageSync(VIEW_STATE_KEY)
    const state = parseStoredState(raw)
    if (!state || !state.savedAt || Date.now() - state.savedAt > VIEW_STATE_TTL_MS) return
    activeFilter.value = assetFilterKeys().includes(state.activeFilter) ? state.activeFilter : 'all'
    searchKeyword.value = typeof state.searchKeyword === 'string' ? state.searchKeyword : ''
    sortMode.value = sortKeys().includes(state.sortMode) ? state.sortMode : 'newest'
  } catch (e) { /* ignore */ }
}
const resetViewState = () => {
  activeFilter.value = 'all'
  searchKeyword.value = ''
  sortMode.value = 'newest'
  selectedLocalIds.value = []
  saveViewState()
}
const isSelected = (row) => Boolean(row && row.localId && selectedLocalIds.value.includes(row.localId))
const setAssetFilter = (key) => {
  activeFilter.value = key || 'all'
  selectedLocalIds.value = []
  saveViewState()
}
const clearSearch = () => {
  searchKeyword.value = ''
  selectedLocalIds.value = []
  saveViewState()
}
const setSortMode = (key) => {
  sortMode.value = key || 'newest'
  selectedLocalIds.value = []
  saveViewState()
}
const showActionNotice = (notice) => {
  actionNotice.value = {
    tone: 'info',
    title: '',
    subtitle: '',
    actionText: '',
    action: '',
    ...notice
  }
}
const dismissActionNotice = () => {
  actionNotice.value = null
}
const runNoticeAction = () => {
  const action = actionNotice.value?.action
  if (action === 'filterCloud') { setAssetFilter('cloud'); return }
  if (action === 'filterLocal') { setAssetFilter('local'); return }
  if (action === 'upload') { goUpload(); return }
  if (action === 'all') resetViewState()
}
const toggleBatchMode = () => {
  batchMode.value = !batchMode.value
  selectedLocalIds.value = []
}
const toggleReportSelect = (row) => {
  if (!row || !row.localId) {
    uni.showToast({ title: '云端资产已保护', icon: 'none' })
    return
  }
  const id = row.localId
  selectedLocalIds.value = isSelected(row)
    ? selectedLocalIds.value.filter((item) => item !== id)
    : [...selectedLocalIds.value, id]
}
const handleReportTap = (row) => {
  if (batchMode.value) {
    toggleReportSelect(row)
    return
  }
  openReport(row)
}
const toggleSelectAllLocal = () => {
  selectedLocalIds.value = allLocalSelected.value ? [] : localSelectableRows.value.map((row) => row.localId)
}
const openReport = (row) => {
  if (!row) { goUpload(); return }
  if (!row.canOpen || !row.localId) {
    saveViewState()
    restoreCloudRow(row)
    return
  }
  saveViewState()
  saveDetailContext(row.localId)
  uni.navigateTo({ url: `/pages/report/detail?id=${encodeURIComponent(row.localId)}&from=manage`, fail: () => { uni.showToast({ title: '无法打开报告页', icon: 'none' }) } })
}
const openLatest = () => {
  if (!latestRow.value) { goUpload(); return }
  openReport(latestRow.value)
}

const restoreCloudRow = async (row) => {
  if (!row || !row.cloudId || restoringId.value) return
  restoringId.value = row.cloudId
  try {
    const localId = await restoreCloudReportToLocal(row.raw || row.cloudId)
    await refresh()
    if (localId) {
      saveViewState()
      saveDetailContext(localId)
      showActionNotice({
        tone: 'success',
        title: '已恢复本机详情',
        subtitle: '这份云端报告已恢复到本机，可继续在本机和云端筛选中查看。',
        actionText: '看本机',
        action: 'filterLocal'
      })
      uni.showToast({ title: '已恢复本机详情', icon: 'none' })
      uni.navigateTo({ url: `/pages/report/detail?id=${encodeURIComponent(localId)}&from=manage`, fail: () => { uni.showToast({ title: '无法打开报告页', icon: 'none' }) } })
      return
    }
    showActionNotice({
      tone: 'warning',
      title: '需要重新上传',
      subtitle: '云端暂未返回完整详情，重新上传后会生成可查看的信用画像。',
      actionText: '上传报告',
      action: 'upload'
    })
    uni.showModal({
      title: '需要重新上传',
      content: '云端暂未返回完整详情。请重新上传报告，系统会重新生成可查看的信用画像。',
      confirmText: '重新上传',
      success: (res) => { if (res.confirm) goUpload() }
    })
  } finally {
    restoringId.value = ''
  }
}
const retrySync = async (row) => {
  if (!row || !row.localId || syncingId.value) return
  syncingId.value = row.localId
  try {
    const ok = await retryReportCloudSync(row.localId)
    await refresh()
    showActionNotice(ok
      ? {
        tone: 'success',
        title: '同步已完成',
        subtitle: '老师端/监控端可读取这份云端资产。',
        actionText: '看云端',
        action: 'filterCloud'
      }
      : {
        tone: 'danger',
        title: '同步失败',
        subtitle: '本机报告仍可查看，请稍后重试。',
        actionText: '看本机',
        action: 'filterLocal'
      })
    uni.showToast({ title: ok ? '同步已完成' : '同步失败，请稍后重试', icon: 'none' })
  } finally {
    syncingId.value = ''
  }
}

const rowSwipeActionText = (row) => row && row.cloudId ? '移出' : '删除'

const confirmSwipeDeleteReport = (row) => {
  if (!row) return
  if (!row.cloudId) {
    confirmDeleteLocal(row)
    return
  }
  const hasLocal = Boolean(row.localId)
  uni.showModal({
    title: '移出报告记录',
    content: hasLocal
      ? '将从当前账号的报告列表移出这份记录，本机缓存同步清理；管理员监测端仍会保留留档，方便后续查看。确定继续吗？'
      : '将从当前账号的报告列表移出这份云端记录；管理员监测端仍会保留留档，方便后续查看。确定继续吗？',
    confirmText: '移出',
    confirmColor: '#DC2626',
    success: async (res) => {
      if (!res.confirm || deletingCloudId.value) return
      deletingCloudId.value = row.cloudId
      try {
        const ok = await deleteCloudReport(row.cloudId)
        if (ok && hasLocal) deleteReport(row.localId)
        await refresh()
        showActionNotice(ok
          ? {
            tone: 'success',
            title: '已移出报告列表',
            subtitle: '管理员监测端已保留这份报告留档，当前账号列表不再显示。',
            actionText: '查看全部',
            action: 'all'
          }
          : {
            tone: 'danger',
            title: '移出失败',
            subtitle: '云端记录未发生变化，请稍后重试。',
            actionText: '看云端',
            action: 'filterCloud'
          })
        uni.showToast({ title: ok ? '已移出列表' : '移出失败', icon: 'none' })
      } finally {
        deletingCloudId.value = ''
      }
    }
  })
}

const confirmDeleteLocal = (row) => {
  const hasCloud = Boolean(row && row.cloudId)
  uni.showModal({
    title: hasCloud ? '移出本机' : '删除报告',
    content: hasCloud
      ? '只删除本机缓存，云端资产会保留，老师端/监控端仍可读取。确定继续吗？'
      : '这份报告仅保存在本机，删除后无法查看，确定删除吗？',
    confirmText: hasCloud ? '移出本机' : '删除',
    confirmColor: '#DC2626',
    success: async (res) => {
      if (!res.confirm) return
      deleteReport(row.localId || row.id)
      await refresh()
      showActionNotice(hasCloud
        ? {
          tone: 'success',
          title: '已移出本机',
          subtitle: '云端资产已保留，老师端/监控端仍可读取。',
          actionText: '看云端',
          action: 'filterCloud'
        }
        : {
          tone: 'warning',
          title: '已删除本机报告',
          subtitle: '这份报告仅在本机保存，已从资产列表移除。',
          actionText: '上传新报告',
          action: 'upload'
        })
      uni.showToast({ title: hasCloud ? '已移出本机' : '已删除', icon: 'none' })
    }
  })
}

const confirmDeleteCloud = (row) => {
  if (!row || !row.cloudId || deletingCloudId.value) return
  const hasLocal = Boolean(row.localId)
  uni.showModal({
    title: '移出云端资产',
    content: hasLocal
      ? '将从当前账号云端列表移出这份报告，管理员监测端仍会留档；本机详情会保留。确定继续吗？'
      : '将从当前账号云端列表移出这份报告，管理员监测端仍会留档；本机没有详情缓存。确定继续吗？',
    confirmText: '移出云端',
    confirmColor: '#DC2626',
    success: async (res) => {
      if (!res.confirm) return
      deletingCloudId.value = row.cloudId
      try {
        const ok = await deleteCloudReport(row.cloudId)
        if (ok && hasLocal) unlinkCloudReportFromLocal(row.localId, { cloudDeletedAt: new Date().toISOString() })
        await refresh()
        showActionNotice(ok
          ? {
            tone: 'warning',
            title: '云端列表已移出',
            subtitle: hasLocal ? '本机详情仍保留，管理员监测端已保留这份报告留档。' : '这份云端资产已从当前账号列表移出，管理员监测端仍保留留档。',
            actionText: hasLocal ? '看本机' : '查看全部',
            action: hasLocal ? 'filterLocal' : 'all'
          }
          : {
            tone: 'danger',
            title: '云端删除失败',
            subtitle: '请稍后重试，云端资产未发生变化。',
            actionText: '看云端',
            action: 'filterCloud'
          })
        uni.showToast({ title: ok ? '已移出云端' : '移出失败', icon: 'none' })
      } finally {
        deletingCloudId.value = ''
      }
    }
  })
}

const confirmBatchDeleteLocal = () => {
  if (!selectedLocalIds.value.length) {
    uni.showToast({ title: '先选择本机报告', icon: 'none' })
    return
  }
  const ids = [...selectedLocalIds.value]
  uni.showModal({
    title: '批量移出本机',
    content: `将移出 ${ids.length} 份本机缓存，云端资产不会删除，老师端/监控端仍可读取。确定继续吗？`,
    confirmText: '移出本机',
    confirmColor: '#DC2626',
    success: async (res) => {
      if (!res.confirm) return
      ids.forEach((id) => deleteReport(id))
      selectedLocalIds.value = []
      batchMode.value = false
      await refresh()
      showActionNotice({
        tone: 'success',
        title: '已批量移出本机',
        subtitle: `已移出 ${ids.length} 份本机缓存，云端资产保持不变。`,
        actionText: '看云端',
        action: 'filterCloud'
      })
      uni.showToast({ title: '已移出本机', icon: 'none' })
    }
  })
}

const confirmClearAll = () => {
  uni.showModal({
    title: '清空本机报告',
    content: '将清空本机保存的全部信用报告记录，云端资产不会删除，确定继续吗？',
    confirmText: '清空',
    confirmColor: '#DC2626',
    success: async (res) => {
      if (!res.confirm) return
      clearAllReports()
      await refresh()
      showActionNotice({
        tone: 'warning',
        title: '本机已清空',
        subtitle: '本机缓存已清理，云端资产不会删除，可从云端筛选恢复详情。',
        actionText: '看云端',
        action: 'filterCloud'
      })
      uni.showToast({ title: '已清空', icon: 'none' })
    }
  })
}

watch([activeFilter, searchKeyword, sortMode], () => saveViewState())

onLoad((query = {}) => {
  routeSource.value = queryText(query.from)
  focusedReportId.value = queryText(query.reportId || query.id || query.cloudReportId)
  applyRouteFocusView()
})
onShow(async () => {
  restoreViewState()
  applyRouteFocusView()
  await refresh()
})
</script>

<style scoped>
.page { min-height: 100vh; background: #F5F6FA; }
.nav { flex-direction: row; align-items: center; padding: calc(var(--rpt-safe-top) + 8px) 14px 8px; background: #fff; border-bottom: 1px solid #EEF0F4; }
.nav-title { flex: 1; text-align: center; font-size: 16px; font-weight: 900; color: #111827; }
.nav-action { width: 42px; text-align: right; font-size: 13px; font-weight: 900; color: #086CEA; }
.scroll-body { flex: 1; height: 100vh; }
.wrap { padding: 14px 16px 18px; }

.summary-card,
.flow-card,
.report-card,
.state-card { background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; }

.message-report-card { background: #111827; border-radius: 8px; padding: 13px; margin-bottom: 12px; flex-direction: row; align-items: center; }
.message-report-main { flex: 1; padding-right: 10px; }
.message-report-kicker { font-size: 11px; color: #93C5FD; font-weight: 900; }
.message-report-title { margin-top: 4px; font-size: 14px; color: #fff; font-weight: 900; line-height: 1.35; }
.message-report-sub { margin-top: 3px; font-size: 11px; color: #D1D5DB; line-height: 1.45; }
.message-report-actions { width: 76px; align-items: stretch; }
.message-report-primary, .message-report-ghost { height: 28px; border-radius: 8px; align-items: center; justify-content: center; }
.message-report-primary { background: #086CEA; }
.message-report-ghost { margin-top: 7px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.18); }
.message-report-primary-text { font-size: 11px; color: #fff; font-weight: 900; }
.message-report-ghost-text { font-size: 11px; color: #F3F4F6; font-weight: 900; }
.summary-card { padding: 16px; }
.summary-head { flex-direction: row; align-items: center; justify-content: space-between; }
.summary-kicker { font-size: 12px; color: #086CEA; font-weight: 900; }
.summary-title { margin-top: 5px; font-size: 20px; color: #111827; font-weight: 900; }
.summary-score { width: 68px; height: 68px; border-radius: 34px; border-width: 5px; border-style: solid; align-items: center; justify-content: center; }
.summary-score-num { font-size: 22px; font-weight: 900; }
.summary-score-label { margin-top: 1px; font-size: 10px; color: #9CA3AF; }
.summary-grid { flex-direction: row; margin-top: 16px; border-top: 1px solid #F3F4F6; padding-top: 14px; }
.summary-cell { flex: 1; align-items: center; }
.summary-value { font-size: 18px; color: #111827; font-weight: 900; }
.summary-label { margin-top: 4px; font-size: 11px; color: #9CA3AF; }
.sync-strip { margin-top: 14px; border-radius: 8px; padding: 10px 11px; flex-direction: row; align-items: center; border: 1px solid #E5E7EB; background: #F8FAFC; }
.sync-strip.synced { background: #F0FDF4; border-color: #BBF7D0; }
.sync-strip.syncing { background: #EFF6FF; border-color: #BFDBFE; }
.sync-strip.failed { background: #FEF2F2; border-color: #FECACA; }
.sync-dot { width: 8px; height: 8px; border-radius: 4px; background: #64748B; margin-right: 9px; }
.sync-strip.synced .sync-dot { background: #16A34A; }
.sync-strip.syncing .sync-dot { background: #2563EB; }
.sync-strip.failed .sync-dot { background: #DC2626; }
.sync-copy { flex: 1; }
.sync-title { font-size: 12px; color: #111827; font-weight: 900; }
.sync-sub { margin-top: 2px; font-size: 11px; color: #64748B; line-height: 1.45; }
.summary-actions { flex-direction: row; margin-top: 16px; }
.summary-primary,
.summary-ghost { flex: 1; height: 40px; border-radius: 8px; align-items: center; justify-content: center; }
.summary-primary { background: #086CEA; margin-right: 9px; box-shadow: 0 10px 22px rgba(8,108,234,0.12); }
.summary-primary-text { font-size: 13px; color: #fff; font-weight: 900; }
.summary-ghost { background: #F8FAFC; border: 1px solid #E5E7EB; }
.summary-ghost-text { font-size: 13px; color: #374151; font-weight: 900; }

.flow-card { flex-direction: row; align-items: center; padding: 12px 10px; margin-top: 12px; }
.flow-step { flex: 1; align-items: center; }
.flow-num { width: 24px; height: 24px; border-radius: 8px; background: #F8FAFC; color: #64748B; font-size: 12px; font-weight: 900; text-align: center; line-height: 24px; border: 1px solid #E5E7EB; }
.flow-step.active .flow-num { background: #EAF3FF; color: #086CEA; border-color: #BFDBFE; }
.flow-text { margin-top: 6px; font-size: 11px; color: #4B5563; font-weight: 800; }
.flow-line { width: 20px; height: 1px; background: #E5E7EB; margin: 0 2px; }

.section-head { flex-direction: row; align-items: center; justify-content: space-between; margin: 16px 2px 10px; }
.section-title { font-size: 16px; color: #111827; font-weight: 900; }
.section-actions { flex-direction: row; align-items: center; }
.section-action { margin-left: 13px; font-size: 12px; color: #086CEA; font-weight: 900; }
.section-action.muted { color: #64748B; }
.filter-scroll { margin: 0 0 10px; white-space: nowrap; }
.filter-row { flex-direction: row; }
.filter-chip { min-width: 76px; height: 34px; border-radius: 8px; background: #fff; border: 1px solid #E5E7EB; margin-right: 8px; padding: 0 10px; flex-direction: row; align-items: center; justify-content: center; }
.filter-chip.active { background: #086CEA; border-color: #086CEA; box-shadow: 0 8px 18px rgba(8,108,234,0.12); }
.filter-chip-text { font-size: 12px; color: #4B5563; font-weight: 900; }
.filter-chip-text.active { color: #fff; }
.filter-chip-count { margin-left: 5px; min-width: 16px; text-align: center; font-size: 11px; color: #64748B; font-weight: 900; background: #F1F5F9; border-radius: 8px; padding: 2px 5px; }
.filter-chip-count.active { color: #086CEA; background: #fff; }
.search-panel { background: #fff; border: 1px solid #EEF0F4; border-radius: 8px; padding: 10px; margin-bottom: 10px; }
.search-box { height: 38px; border-radius: 8px; background: #F8FAFC; border: 1px solid #E5E7EB; flex-direction: row; align-items: center; padding: 0 10px; }
.search-icon { width: 24px; font-size: 12px; color: #64748B; font-weight: 900; }
.search-input { flex: 1; height: 36px; font-size: 13px; color: #111827; }
.search-clear { margin-left: 8px; font-size: 12px; color: #086CEA; font-weight: 900; }
.sort-row { margin-top: 9px; flex-direction: row; align-items: center; flex-wrap: wrap; }
.sort-label { margin-right: 4px; font-size: 12px; color: #64748B; font-weight: 900; }
.sort-chip { height: 30px; border-radius: 8px; background: #F8FAFC; border: 1px solid #E5E7EB; padding: 0 10px; align-items: center; justify-content: center; margin-left: 6px; }
.sort-chip.active { background: #EAF3FF; border-color: #BFDBFE; }
.sort-chip-text { font-size: 12px; color: #4B5563; font-weight: 900; }
.sort-chip-text.active { color: #086CEA; }
.action-notice { margin-bottom: 10px; background: #fff; border: 1px solid #EEF0F4; border-radius: 8px; padding: 11px 12px; flex-direction: row; align-items: center; }
.action-notice.success { background: #F0FDF4; border-color: #BBF7D0; }
.action-notice.warning { background: #FFFBEB; border-color: #FDE68A; }
.action-notice.danger { background: #FEF2F2; border-color: #FECACA; }
.action-notice-main { flex: 1; padding-right: 8px; }
.action-notice-title { font-size: 13px; color: #111827; font-weight: 900; }
.action-notice-sub { margin-top: 3px; font-size: 11px; color: #64748B; line-height: 1.45; }
.action-notice-btn { height: 30px; border-radius: 8px; padding: 0 10px; background: #111827; align-items: center; justify-content: center; margin-right: 8px; }
.action-notice.success .action-notice-btn { background: #15803D; }
.action-notice.warning .action-notice-btn { background: #B45309; }
.action-notice.danger .action-notice-btn { background: #DC2626; }
.action-notice-btn-text { font-size: 12px; color: #fff; font-weight: 900; }
.action-notice-close { font-size: 12px; color: #64748B; font-weight: 900; }
.batch-hint { margin: 0 0 10px; background: #F8FAFC; border: 1px solid #E5E7EB; border-radius: 8px; padding: 9px 11px; }
.batch-hint-text { font-size: 12px; color: #64748B; line-height: 1.45; }
	.report-card { padding: 14px; margin-bottom: 0; }
.report-card-batch { border-color: #E5E7EB; }
.report-card-selected { border-color: #086CEA; background: #F4F8FF; }
.report-card-focus { border-color: #93C5FD; background: #F4F8FF; box-shadow: 0 0 0 2px rgba(8,108,234,0.08); }
.report-card-disabled { opacity: 0.78; }
.report-card-cloud { border-color: #BFDBFE; }
.report-top { flex-direction: row; align-items: center; }
.select-box { width: 24px; height: 24px; border-radius: 8px; border: 1px solid #CBD5E1; background: #fff; align-items: center; justify-content: center; margin-right: 9px; }
.select-box.selected { background: #086CEA; border-color: #086CEA; }
.select-box.disabled { background: #EFF6FF; border-color: #BFDBFE; }
.select-box-text { font-size: 11px; color: #fff; font-weight: 900; }
.select-box.disabled .select-box-text { color: #1D4ED8; }
.report-mark { width: 42px; height: 42px; border-radius: 8px; background: #EAF3FF; border: 1px solid #BFDBFE; align-items: center; justify-content: center; margin-right: 12px; }
.report-mark-text { color: #086CEA; font-size: 15px; font-weight: 900; }
.report-main { flex: 1; }
.report-title-line { flex-direction: row; align-items: center; }
.report-title { flex: 1; font-size: 15px; color: #111827; font-weight: 900; }
.report-meta-line { margin-top: 5px; flex-direction: row; align-items: center; flex-wrap: wrap; }
.report-meta { font-size: 12px; color: #9CA3AF; margin-right: 7px; }
.report-sync { margin-top: 3px; font-size: 10px; font-weight: 900; padding: 3px 6px; border-radius: 7px; overflow: hidden; }
.report-sync.local { color: #64748B; background: #F8FAFC; }
.report-sync.synced { color: #15803D; background: #F0FDF4; }
.report-sync.syncing { color: #1D4ED8; background: #EFF6FF; }
.report-sync.failed { color: #DC2626; background: #FEF2F2; }
.report-status { font-size: 11px; font-weight: 900; padding: 4px 7px; border-radius: 8px; overflow: hidden; }
.report-status.ok { color: #15803D; background: #F0FDF4; }
.report-status.warn { color: #B45309; background: #FFFBEB; }
.report-status.cloud { color: #1D4ED8; background: #EFF6FF; }
.report-bottom { flex-direction: row; border-top: 1px solid #F3F4F6; margin-top: 13px; padding-top: 12px; }
.report-metric { flex: 1; align-items: center; }
.metric-value { font-size: 17px; color: #111827; font-weight: 900; }
.metric-label { margin-top: 3px; font-size: 11px; color: #9CA3AF; }
.report-actions { flex-direction: row; justify-content: flex-end; flex-wrap: wrap; margin-top: 9px; }
.line-btn,
.danger-btn { height: 34px; border-radius: 8px; padding: 0 13px; align-items: center; justify-content: center; margin-left: 8px; margin-top: 4px; }
.line-btn { background: #F8FAFC; border: 1px solid #E5E7EB; }
.sync-retry-btn { background: #EFF6FF; border-color: #BFDBFE; }
.cloud-action-btn { background: #FFF7ED; border-color: #FED7AA; }
.line-btn-text { font-size: 12px; color: #374151; font-weight: 900; }
.cloud-action-btn .line-btn-text { color: #C2410C; }
.danger-btn { background: #FEF2F2; border: 1px solid #FECACA; }
.danger-btn-text { font-size: 12px; color: #DC2626; font-weight: 900; }

.state-card { align-items: center; padding: 34px 20px; margin-top: 12px; }
.state-title { font-size: 17px; color: #111827; font-weight: 900; }
.state-sub { margin-top: 8px; font-size: 13px; color: #6B7280; line-height: 1.7; text-align: center; }
.state-btn { margin-top: 18px; min-width: 138px; height: 42px; border-radius: 8px; background: #086CEA; align-items: center; justify-content: center; padding: 0 16px; box-shadow: 0 10px 22px rgba(8,108,234,0.12); }
.state-btn.ghost { background: #F8FAFC; border: 1px solid #E5E7EB; }
.state-btn-text { color: #fff; font-size: 14px; font-weight: 900; }
.state-btn-text.ghost { color: #374151; }
.bottom-safe { height: 36px; }
@media (min-width: 1024px) {
  .report-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: 12px; }
}
.bottom-safe-batch { height: 132px; }
.batch-bar { position: fixed; left: 0; right: 0; bottom: 0; padding: 10px 14px calc(10px + var(--rpt-safe-bottom)); background: rgba(255,255,255,0.98); border-top: 1px solid #EEF0F4; }
.batch-info { margin-bottom: 9px; }
.batch-title { font-size: 14px; color: #111827; font-weight: 900; }
.batch-sub { margin-top: 3px; font-size: 11px; color: #64748B; line-height: 1.45; }
.batch-actions { flex-direction: row; }
.batch-secondary,
.batch-danger { flex: 1; height: 42px; border-radius: 8px; align-items: center; justify-content: center; }
.batch-secondary { background: #F8FAFC; border: 1px solid #E5E7EB; margin-right: 9px; }
.batch-secondary-text { font-size: 13px; color: #374151; font-weight: 900; }
.batch-danger { background: #DC2626; }
.batch-danger.disabled { background: #FCA5A5; }
.batch-danger-text { font-size: 13px; color: #fff; font-weight: 900; }
</style>
