<template>
  <view class="page rpt-page">
    <view class="nav">
      <RptBackButton @click="goBack" />
      <text class="nav-title">债务管理</text>
      <view class="nav-spacer"></view>
    </view>

    <scroll-view class="scroll-body" scroll-y :scroll-into-view="focusedDebtAnchor" scroll-with-animation>
      <view class="wrap rpt-content-narrow">
        <view v-if="reportContextTitle" class="report-context">
          <view class="report-context-main">
            <text class="report-context-kicker">当前依据</text>
            <text class="report-context-title">{{ reportContextTitle }}</text>
            <text class="report-context-sub">{{ reportContextSub }}</text>
          </view>
          <view class="report-context-actions">
            <view class="context-action" @click="goReportDetail"><text class="context-action-text">查看报告</text></view>
            <view class="context-ghost" @click="goReportManage"><text class="context-ghost-text">切换</text></view>
          </view>
        </view>

        <view v-if="messageRouteContext" class="message-route-card">
          <view class="message-route-main">
            <text class="message-route-kicker">消息定位</text>
            <text class="message-route-title">{{ messageRouteContext.title }}</text>
            <text class="message-route-sub">{{ messageRouteContext.sub }}</text>
          </view>
          <view class="message-route-actions">
            <view class="message-route-primary" @click="goDebtMessages"><text class="message-route-primary-text">返回消息</text></view>
            <view class="message-route-ghost" @click="goReportManage"><text class="message-route-ghost-text">报告资产</text></view>
          </view>
        </view>
        <view class="summary-card">
          <text class="summary-kicker">{{ displaySummary.totalDebtLabel }}</text>
          <text class="summary-total">{{ displaySummary.totalDebt }}</text>
          <view class="summary-grid">
            <view class="summary-cell">
              <text class="summary-label">档案本月应还</text>
              <text class="summary-value">{{ displaySummary.monthlyPay }}</text>
            </view>
            <view class="summary-cell">
              <text class="summary-label">{{ displaySummary.dtiLabel }}</text>
              <text class="summary-value">{{ displaySummary.dti }}</text>
            </view>
          </view>
          <view class="ratio-chip">
            <text class="ratio-chip-text">{{ ratioHint }}</text>
          </view>
        </view>

        <view class="reminder-row" @click="onRemind">
          <view class="reminder-main">
            <text class="reminder-title">还款提醒</text>
            <text class="reminder-sub">{{ reminderText }}</text>
          </view>
          <RptChevron class="reminder-arrow" direction="right" />
        </view>

        <view v-if="!loading && debts.length && hasDecisionGuidance" class="action-panel">
          <view class="action-main">
            <text class="action-kicker">优化目标</text>
            <text class="action-title">{{ goalTitle }}</text>
            <text class="action-sub">{{ goalSub }}</text>
          </view>
          <view class="action-buttons">
            <view class="action-primary" @click="setOptimizationGoal"><text class="action-primary-text">设置目标</text></view>
            <view class="action-ghost" @click="goAdvisorWithDebt()"><text class="action-ghost-text">咨询顾问</text></view>
          </view>
        </view>

        <view v-if="!loading && debts.length && !hasDecisionGuidance" class="decision-archive-note">
          <text class="decision-archive-title">当前仅展示报告档案数据</text>
          <text class="decision-archive-sub">本次会话尚无与该报告一致的已验证决策字段，不生成风险分级、还款排序或优化目标。</text>
        </view>

        <view v-if="!loading && debts.length" class="feedback-panel">
          <view class="feedback-head">
            <view class="feedback-titlebox">
              <text class="feedback-kicker">执行反馈</text>
              <text class="feedback-title">{{ goalProgress.title }}</text>
            </view>
            <view class="feedback-link" @click="goDebtMessages"><text class="feedback-link-text">消息</text></view>
          </view>
          <text v-if="executionCloudSyncText" class="feedback-sync">{{ executionCloudSyncText }}</text>
          <view class="feedback-track">
            <view class="feedback-fill" :style="{ width: goalProgress.percent + '%' }"></view>
          </view>
          <view class="feedback-grid">
            <view v-for="item in executionStats" :key="item.key" class="feedback-cell">
              <text class="feedback-value">{{ item.value }}</text>
              <text class="feedback-label">{{ item.label }}</text>
              <text class="feedback-sub">{{ item.sub }}</text>
            </view>
          </view>
          <view v-if="advisorFeedback" class="advisor-backfill" @click="goAdvisorWithDebt()">
            <view class="advisor-backfill-main">
              <text class="advisor-backfill-title">{{ advisorFeedback.title }}</text>
              <text class="advisor-backfill-sub">{{ advisorFeedback.summary }}</text>
            </view>
            <text class="advisor-backfill-status">{{ advisorFeedback.statusText }}</text>
          </view>
          <view v-if="executionTimeline.length" class="execution-timeline">
            <view class="execution-head">
              <text class="execution-head-title">债务处理时间线</text>
              <text class="execution-head-count">{{ executionTimeline.length }} 条</text>
            </view>
            <view v-for="item in executionTimeline" :key="item.id" class="execution-row" :class="'execution-row-' + item.state">
              <text class="execution-dot"></text>
              <view class="execution-main">
                <view class="execution-line">
                  <text class="execution-title">{{ item.title }}</text>
                  <text class="execution-time">{{ item.time }}</text>
                </view>
                <text class="execution-desc">{{ item.desc }}</text>
              </view>
            </view>
          </view>
        </view>

        <view v-if="!loading && riskGroups.length" class="section-head">
          <text class="section-title">{{ SCORE_COPY.debtPriority.sectionTitle }}</text>
          <text class="section-note">{{ riskSummaryText }}</text>
        </view>
        <view v-if="!loading && riskGroups.length" class="risk-grid">
          <view v-for="item in riskGroups" :key="item.key" class="risk-cell" :class="'risk-cell-' + item.key">
            <text class="risk-num" :class="'risk-num-' + item.key">{{ item.count }}</text>
            <text class="risk-label">{{ item.label }}</text>
            <text class="risk-sub">{{ item.amountText }}</text>
          </view>
        </view>

        <view v-if="!loading && repaymentPlan.length" class="section-head">
          <text class="section-title">优先还款计划</text>
          <text class="section-note">{{ SCORE_COPY.debtPriority.sortNote }}</text>
        </view>
        <view v-if="!loading && repaymentPlan.length" class="plan-list">
          <view v-for="item in repaymentPlan" :key="item.id" class="plan-card">
            <view class="plan-rank"><text class="plan-rank-text">{{ item.rank }}</text></view>
            <view class="plan-main">
              <text class="plan-title">{{ item.title }}</text>
              <text class="plan-sub">{{ item.subtitle }}</text>
              <text class="plan-action">{{ item.action }}</text>
            </view>
            <view class="plan-side">
              <text class="plan-amount">{{ item.amount }}</text>
              <text class="plan-risk" :class="'plan-risk-' + item.riskLevel">{{ item.riskText }}</text>
            </view>
          </view>
        </view>

        <view v-if="!loading && optimizationTips.length" class="section-head">
          <text class="section-title">优化建议</text>
          <text class="section-note">{{ optimizationTips.length }} 条</text>
        </view>
        <view v-if="!loading && optimizationTips.length" class="tip-list">
          <view v-for="item in optimizationTips" :key="item.key" class="tip-card" :class="'tip-card-' + item.level">
            <view class="tip-dot" :class="'tip-dot-' + item.level"></view>
            <view class="tip-main">
              <text class="tip-title">{{ item.title }}</text>
              <text class="tip-desc">{{ item.desc }}</text>
              <text class="tip-effect">{{ item.effect }}</text>
            </view>
          </view>
        </view>

        <view class="section-head">
          <text class="section-title">债务明细</text>
					<text class="section-note">{{ debts.length ? debts.length + (debtConflictReason ? ' 条已知明细（非完整）' : ' 条') : (explicitNoDebt ? '0 条' : '待核对') }}</text>
        </view>

        <view v-if="loading" class="state-card">
          <text class="state-sub">加载中…</text>
        </view>

        <view v-else-if="!debts.length" class="state-card">
          <text class="state-title">{{ emptyStateTitle }}</text>
          <text class="state-sub">{{ emptyStateSub }}</text>
          <view v-if="!loggedIn" class="state-btn" @click="goLogin">
            <text class="state-btn-text">去登录</text>
          </view>
          <view v-else class="state-btn" @click="goUpload">
            <text class="state-btn-text">上传报告</text>
          </view>
        </view>

        <view v-else>
			<view v-if="currentDebtConflictCopy" class="state-card">
				<text class="state-title">{{ currentDebtConflictCopy.title }}</text>
				<text class="state-sub">{{ currentDebtConflictCopy.detail }}</text>
			</view>
          <view v-for="item in debts" :id="debtAnchorId(item)" :key="item.id" class="debt-card" :class="{ 'debt-card-focus': isFocusedDebt(item) }">
            <view v-if="isFocusedDebt(item)" class="debt-focus-hint">
              <text class="debt-focus-title">{{ focusedDebtSourceTitle }}</text>
              <text class="debt-focus-sub">{{ focusedDebtHint(item) }}</text>
            </view>
            <view class="debt-head">
              <view class="debt-main">
                <text class="debt-name">{{ item.institution }}</text>
                <text class="debt-product">{{ item.product }}</text>
              </view>
              <view class="status" :class="statusClass(item.status)">
                <text class="status-text" :class="statusTextClass(item.status)">{{ item.status }}</text>
              </view>
            </view>
            <view class="amount-row">
              <view class="amount-cell">
                <text class="amount-label">剩余本金</text>
                <text class="amount-value">{{ item.balanceLabel }}</text>
              </view>
              <view class="amount-cell amount-right">
                <text class="amount-label">月供</text>
                <text class="amount-value">{{ item.monthlyLabel }}</text>
              </view>
            </view>
            <view class="progress-track">
							<view class="progress-fill" :class="'progress-fill-' + item.riskLevel" :style="{ width: (item.progress == null ? 0 : item.progress) + '%' }"></view>
            </view>
            <view class="debt-foot">
              <text class="debt-risk" :class="'debt-risk-' + item.riskLevel">{{ item.riskText }}</text>
              <text class="debt-reason">{{ item.riskReason }}</text>
            </view>
            <view v-if="debtExecutionStatus(item)" class="debt-execution">
              <view class="debt-execution-main">
                <text class="debt-execution-title">{{ debtExecutionStatus(item).title }}</text>
                <text class="debt-execution-sub">{{ debtExecutionStatus(item).sub }}</text>
              </view>
              <text class="debt-execution-status" :class="'debt-execution-status-' + debtExecutionStatus(item).state">{{ debtExecutionStatus(item).statusText }}</text>
            </view>
            <view class="debt-actions">
              <view class="debt-action debt-action-soft" @click="setDebtReminder(item)">
                <text class="debt-action-text">{{ isDebtReminderSet(item) ? '已提醒' : '提醒' }}</text>
              </view>
              <view class="debt-action debt-action-soft" @click="handleDebtExecutionAction(item)">
                <text class="debt-action-text">{{ debtActionText(item) }}</text>
              </view>
              <view class="debt-action" @click="goAdvisorWithDebt(item)">
                <text class="debt-action-primary-text">问顾问</text>
              </view>
            </view>
          </view>
        </view>

        <view class="bottom-safe"></view>
      </view>
    </scroll-view>
  </view>
</template>

<script setup>
import { computed, ref } from 'vue'
import { onLoad, onShow } from '@/compat/web-lifecycle.js'
import { isLoggedIn } from '@/services/authService.js'
import { getAdvisorContacts, getDebtExecutionRecords, getDebtSummary, saveDebtExecutionRecordRemote } from '@/services/profileService.js'
import { getLatestReportAsync, getReportAnalysisDate, getReportAsync, normalizeReportData } from '@/services/reportStorage.js'
import { debtAccountsFromAnalysis, debtAggregateTotalFromAnalysis, debtBalanceOf, debtEvidenceConflictCopy, debtLimitOf, debtMonthlyOf, debtNavigationKey, debtUtilizationPct, isSettledDebtAccount, resolveDebtAccountEvidence, resolveDebtTotalFromEvidence, resolveHomeDebtDisplay } from '@/services/debtSummary.js'
import { resolveDebtDecisionPolicy } from '@/services/debtDecisionPolicy.js'
import { decisionReportIdOf, isAbsentDecisionReportId, normalizeDecisionReportId, resolveDecisionReportIdAliases, trustedDecisionValue } from '@/services/decisionTrust.js'
import { uploadLocalFile } from '@/services/apiClient.js'
import { readLastConsultationStatus } from '@/services/userConsultationStatus.js'
import { acknowledgeDebtProofReview, activeDebtExecutionRecords, applyDebtExecutionCloudSnapshot, debtProofStatusText, isReviewableDebtProofRecord, readDebtExecutionRecords, readDebtExecutionSyncQueue, retryPendingDebtExecutionSync, saveDebtExecutionRecords, supersededDebtProofRecords, syncDebtExecutionRecord } from '@/services/debtExecution.js'
import { notifyMessageUnreadChange } from '@/services/messageCenter.js'
import safeSwitchTab from '@/utils/safeSwitchTab.js'
import safeBack from '@/utils/safeBack.js'
import { SCORE_COPY, reportScoreText } from '@/utils/scorePresentation.js'
import { statusIndicatesOverdue, statusIsUnknown } from '@/utils/creditStatus.js'
import { strictNonNegativeIntegerOrNull, strictNonNegativeNumberOrNull } from '@/utils/strictNumber.js'
import { resolveDebtReminderAmount } from '@/services/repaymentReminderService.js'
import RptBackButton from '@/components/RptBackButton.vue'
import RptChevron from '@/components/RptChevron.vue'

const REMINDER_KEY = 'debt_repay_reminder'
const ITEM_REMINDER_KEY = 'debt_item_repay_reminders'
const GOAL_KEY = 'debt_optimization_goal'
const DEBT_ADVISOR_CONTEXT_KEY = 'debt_advisor_context'

const loggedIn = ref(false)
const loading = ref(false)
const summary = ref({ totalDebt: '—', monthlyPay: '—', dti: '—' })
const debts = ref([])
const debtEvidenceKnown = ref(false)
const explicitNoDebt = ref(false)
const debtConflictReason = ref('')
const reminder = ref({ enabled: false, day: 0 })
const itemReminders = ref({})
const optimizationGoal = ref(null)
const advisorFeedback = ref(null)
const executionRecords = ref([])
const proofUploadingId = ref('')
const activeReportId = ref('')
const activeCanonicalReportId = ref('')
const activeClientReportId = ref('')
const routeRequestedReportId = ref('')
const activeReport = ref(null)
const activeDecisionTrust = ref(null)
const activeDecisionReportId = ref('')
const activeSource = ref('latest')
const routeFocus = ref('')
const focusedDebtId = ref('')
const focusedDebtNavigationKey = ref('')
const focusedExecutionRecordId = ref('')
const routeSource = ref('')
const focusPrompted = ref(false)
const executionCloudSyncState = ref({ status: 'idle', pending: 0, error: '', updatedAt: '' })
let loadRequestId = 0

const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== '')
const queryText = (value) => Array.isArray(value) ? String(value[0] || '') : String(value || '')
const safeAnchorText = (value) => String(value || '').replace(/[^A-Za-z0-9_-]/g, '-')
const num = (value) => {
	return strictNonNegativeNumberOrNull(value)
}
const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, value))
const parseDate = (value) => {
	if (typeof value !== 'string') return null
	const raw = value.slice(0, 10)
  if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(raw)) return null
  const d = new Date(`${raw}T00:00:00`)
  return Number.isNaN(d.getTime()) ? null : d
}
const daysUntil = (value, anchorValue = '') => {
  const d = parseDate(value)
  if (!d) return null
  const anchor = parseDate(anchorValue)
  const today = new Date()
  const base = anchor || new Date(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.ceil((d.getTime() - base.getTime()) / 86400000)
}
const formatMoney = (value) => {
	const n = num(value)
	if (n == null || n < 0) return '—'
	if (n === 0) return '¥ 0'
  if (n >= 10000) return `¥ ${(n / 10000).toFixed(1)} 万`
  return `¥ ${Math.round(n).toLocaleString()}`
}

const normalizeStatus = (raw, overdue) => {
  if (overdue) return '逾期'
  if (isSettledDebtAccount({ status: raw })) return '已结清'
	if (typeof raw !== 'string') return '待核对'
	const s = raw.toLowerCase()
	if (statusIsUnknown(s)) return '待核对'
  if (s === 'overdue') return '逾期'
  if (s === 'restructured') return '重组中'
	return /正常|未逾期|在用|活跃/.test(s) ? '正常' : String(raw)
}

const makeDebt = (raw, index, source, anchorDate = '') => {
  const product = first(raw.debtName, raw.accountType, raw.account_type, raw.type, raw.productName, raw.cardType, raw.card_type, '信贷账户')
  const balance = debtBalanceOf(raw)
  const monthly = debtMonthlyOf(raw)
  const limit = debtLimitOf(raw)
	const accountEvidence = resolveDebtAccountEvidence(raw)
	const overdueDays = num(first(raw.overdueDays, raw.overdue_days, raw.maxOverdueDays))
  const overdue = !!(
    raw.isOverdue === true ||
    overdueDays > 0 ||
    statusIndicatesOverdue(raw.status)
  )
	const progress = raw.progress != null ? num(raw.progress) : (limit > 0 && balance != null ? Math.round((balance / limit) * 100) : null)
	const endDateRaw = first(raw.endDate, raw.end_date, raw.dueDate, raw.due_date, raw.repayDate, '')
	const endDate = typeof endDateRaw === 'string' ? endDateRaw.slice(0, 10) : ''
  const dueDays = daysUntil(endDate, anchorDate)
  const isCard = raw.isLoan === false ||
    /信用卡|贷记卡|card/i.test(String(product)) ||
    (first(raw.creditLimit, raw.credit_limit, raw.usedLimit, raw.used_limit, raw.used_card_limit, '') !== '')
  const utilization = debtUtilizationPct(raw)
	const sourceIndexRaw = strictNonNegativeIntegerOrNull(first(raw.sourceIndex, raw.source_index, index))
	const sourceIndex = sourceIndexRaw == null ? index : sourceIndexRaw
  const base = {
    id: first(raw._id, raw.id, raw.accountId, raw.account_id, `${source}_${index}`),
    institution: first(raw.bank, raw.institution, raw.name, raw.orgName, raw.org_name, raw.bankName, raw.bank_name, raw.lender, '未知机构'),
    product,
		balanceLabel: accountEvidence.balanceKnown ? formatMoney(balance) : '—',
		monthlyLabel: accountEvidence.monthlyKnown ? formatMoney(monthly) : '—',
    status: normalizeStatus(raw.status, overdue),
		progress: progress == null ? null : clamp(progress),
    balance,
    monthly,
    limit,
		utilization,
		balanceKnown: accountEvidence.balanceKnown,
		monthlyKnown: accountEvidence.monthlyKnown,
		limitKnown: accountEvidence.limitKnown,
		settlementKnown: accountEvidence.settlementKnown,
    overdue,
    overdueDays,
    endDate,
    dueDays,
    dueAnchorDate: anchorDate || '',
    dueText: dueDays == null ? '到期日未知' : dueDays < 0 ? '已到期' : dueDays === 0 ? '今日到期' : `${dueDays} 天后到期`,
    isCard,
    navigationKey: debtNavigationKey(raw, sourceIndex)
  }
  return {
    ...base,
    decisionEligible: false,
    riskScore: null,
    riskLevel: 'archive',
    riskText: '档案记录',
    riskReason: '仅展示报告原始账户信息',
    riskAction: ''
  }
}

const reportTitleOf = (report) => first(report?.fileName, report?.reportType, '信用报告')
const reportDateOf = (report) => getReportAnalysisDate(report || {})
const reportScoreOf = (report) => {
  const expectedReportId = decisionReportIdOf(report)
  const score = expectedReportId
    ? trustedDecisionValue(report?.decisionTrust || null, 'score', 'score', expectedReportId)
    : null
  return score == null || score === '' ? '' : String(score)
}

const reportAccountsOf = (report) => {
  const rd = report && report.analysisData
  if (!rd) return []
  const normalized = normalizeReportData(rd, report?.decisionTrust || null, decisionReportIdOf(report))
  return debtAccountsFromAnalysis(rd, normalized.creditAccounts)
}

const reportScopeResolutionOf = (report) => {
	if (report === undefined || report === null) return Object.freeze([])
	if (!report || typeof report !== 'object' || Array.isArray(report)) return null
	let syncMeta = {}
	if (Object.prototype.hasOwnProperty.call(report, 'syncMeta')) {
		const rawSyncMeta = report.syncMeta
		if (rawSyncMeta !== undefined && rawSyncMeta !== null && rawSyncMeta !== '') {
			if (!rawSyncMeta || typeof rawSyncMeta !== 'object' || Array.isArray(rawSyncMeta)) return null
			syncMeta = rawSyncMeta
		}
	}
	const strongIds = resolveDecisionReportIdAliases([
		report.cloudReportId,
		report.serverReportId,
		report.reportId,
		report.report_id,
		report._id,
		syncMeta.cloudReportId
	], { requireMatch: true })
	const localIds = resolveDecisionReportIdAliases([
		report.id,
		report.clientReportId,
		report.sourceReportId,
		report.localReportId
	], { requireMatch: true })
	if (!strongIds || !localIds) return null
	return Object.freeze([...new Set([...strongIds, ...localIds])])
}

const reportScopeIdsOf = (report) => new Set(reportScopeResolutionOf(report) || [])

const reportMatchesScope = (report, scopeIds = []) => {
	const reportIds = reportScopeResolutionOf(report)
	const normalizedScope = resolveDecisionReportIdAliases(Array.from(scopeIds))
	if (!reportIds || !normalizedScope) return false
	const reportIdSet = new Set(reportIds)
	return normalizedScope.some((value) => reportIdSet.has(value))
}

const clearActiveDecisionTrust = () => {
  activeDecisionTrust.value = null
  activeDecisionReportId.value = ''
}

const bindActiveDecisionTrust = (report, expectedReportId = '') => {
  const candidateReportId = decisionReportIdOf(report)
	const expectedAbsent = isAbsentDecisionReportId(expectedReportId)
	const normalizedExpected = normalizeDecisionReportId(expectedReportId)
	if (!expectedAbsent && !normalizedExpected) {
		clearActiveDecisionTrust()
		return
	}
	const reportId = expectedAbsent ? candidateReportId : normalizedExpected
  if (!report || !reportId || !candidateReportId || candidateReportId !== reportId || !reportMatchesScope(report, [reportId])) {
    clearActiveDecisionTrust()
    return
  }
  activeDecisionTrust.value = report.decisionTrust || null
  activeDecisionReportId.value = reportId
}

const debtDecisionPolicy = computed(() => resolveDebtDecisionPolicy(
  activeDecisionTrust.value,
  activeDecisionReportId.value
))
const displaySummary = computed(() => {
  const policy = debtDecisionPolicy.value
  return {
    totalDebtLabel: policy.fields.totalDebt ? '已验证负债合计' : '档案负债合计',
    totalDebt: policy.fields.totalDebt ? formatMoney(policy.totalDebt) : summary.value.totalDebt,
    monthlyPay: summary.value.monthlyPay,
    dtiLabel: policy.fields.debtRatio ? '已验证负债比例' : '负债收入比',
    dti: policy.fields.debtRatio ? `${policy.debtRatioPct.toFixed(2)}%` : '—'
  }
})

const applyReportFallback = (sourceReport = null, source = 'latest') => {
  const report = sourceReport
  activeReport.value = report || null
  activeSource.value = source
  const localReportId = normalizeDecisionReportId(report && report.id)
  if (localReportId) activeReportId.value = localReportId
  bindActiveDecisionTrust(report, activeCanonicalReportId.value || decisionReportIdOf(report))
  const accounts = reportAccountsOf(report)
	const policy = debtDecisionPolicy.value
	const trustedTotalDebt = policy.fields.totalDebt ? policy.totalDebt : null
  if (!Array.isArray(accounts) || accounts.length === 0) {
    debts.value = []
    const aggregateTotal = debtAggregateTotalFromAnalysis(report && report.analysisData)
		const debtDisplay = resolveHomeDebtDisplay(trustedTotalDebt, [])
		debtConflictReason.value = debtDisplay.conflictReason
		debtEvidenceKnown.value = trustedTotalDebt != null || aggregateTotal != null
		explicitNoDebt.value = trustedTotalDebt === 0 || (trustedTotalDebt == null && aggregateTotal === 0)
		summary.value = { totalDebt: formatMoney(aggregateTotal), monthlyPay: '—', dti: '—' }
		return Boolean(report)
  }

	const debtDisplay = resolveHomeDebtDisplay(trustedTotalDebt, accounts)
	const list = debtDisplay.rows.map(({ account, sourceIndex }) => ({ account, index: sourceIndex }))
	const anchorDate = reportDateOf(report)
  debts.value = list.map(({ account, index }) => makeDebt(account, index, 'report', anchorDate))
  const aggregateTotal = debtAggregateTotalFromAnalysis(report && report.analysisData)
  const totalEvidence = resolveDebtTotalFromEvidence(accounts, aggregateTotal)
  const total = totalEvidence.total
	debtConflictReason.value = debtDisplay.conflictReason
	debtEvidenceKnown.value = trustedTotalDebt != null || totalEvidence.known
	explicitNoDebt.value = trustedTotalDebt === 0 || (trustedTotalDebt == null && totalEvidence.known && total === 0)
	const monthlyKnown = !debtDisplay.archiveConflict && debts.value.length > 0 && debts.value.every((item) => item.monthlyKnown)
	const monthly = monthlyKnown ? debts.value.reduce((sum, item) => sum + item.monthly, 0) : null
  const dimensions = report?.analysisData?.dimensions || {}
	const dtiRaw = first(dimensions.debtRatioPct, dimensions.debt_ratio_pct, dimensions.debtRatio, dimensions.debt_ratio)
	const parsedDti = num(dtiRaw)
	const dtiValue = parsedDti == null ? null : (parsedDti > 0 && parsedDti <= 1 ? Math.round(parsedDti * 100) : Math.round(parsedDti))
  summary.value = {
    totalDebt: formatMoney(total),
		monthlyPay: monthlyKnown ? formatMoney(monthly) : '—',
    dti: dtiValue == null ? '—' : `${dtiValue}%`
  }
  return true
}

const load = async () => {
  const requestId = ++loadRequestId
	debtEvidenceKnown.value = false
	explicitNoDebt.value = false
	debtConflictReason.value = ''
  clearActiveDecisionTrust()
  activeCanonicalReportId.value = ''
  activeClientReportId.value = ''
  loggedIn.value = isLoggedIn()
  restoreReminder()
  restoreItemReminders()
  restoreExecutionRecords()
  loading.value = true
  try {
    const requestedReport = routeRequestedReportId.value ? await getReportAsync(routeRequestedReportId.value) : null
    const data = loggedIn.value
      ? await getDebtSummary(routeRequestedReportId.value ? { reportId: routeRequestedReportId.value } : {}).catch(() => null)
      : null
    if (requestId !== loadRequestId) return
		const apiReportIds = resolveDecisionReportIdAliases([data?.reportId, data?.report_id], { requireMatch: true })
		const apiClientReportIds = resolveDecisionReportIdAliases([data?.clientReportId, data?.client_report_id], { requireMatch: true })
		const apiIdentityValid = Boolean(apiReportIds && apiClientReportIds)
		const apiReportId = apiIdentityValid ? (apiReportIds[0] || '') : ''
		const apiClientReportId = apiIdentityValid ? (apiClientReportIds[0] || '') : ''
    activeCanonicalReportId.value = apiReportId
    activeClientReportId.value = apiClientReportId
		const apiAnchorRaw = first(data?.reportDate, data?.report_date, '')
		const apiAnchorDate = typeof apiAnchorRaw === 'string' ? apiAnchorRaw : ''
		const rawApiDebts = Array.isArray(data?.debts)
			? data.debts.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
			: []

    if (requestedReport && requestedReport.analysisData) {
      const localApplied = applyReportFallback(requestedReport, 'selected')
			if (localApplied || !rawApiDebts.length) return
    }

    if (data && apiReportId) {
      const localCandidate = requestedReport || await getLatestReportAsync()
      const cloudScopeIds = new Set([apiReportId, apiClientReportId].filter(Boolean))
      if (localCandidate && reportMatchesScope(localCandidate, cloudScopeIds)) {
        bindActiveDecisionTrust(localCandidate, apiReportId)
      } else {
        clearActiveDecisionTrust()
      }
			if (!rawApiDebts.length && reportAccountsOf(localCandidate).length && reportMatchesScope(localCandidate, cloudScopeIds)) {
        applyReportFallback(localCandidate, requestedReport ? 'selected' : 'latest')
        return
      }
			const apiTotal = num(data.totalRemaining)
			const policy = debtDecisionPolicy.value
			const trustedTotalDebt = policy.fields.totalDebt ? policy.totalDebt : null
			const currentTotal = trustedTotalDebt != null ? trustedTotalDebt : apiTotal
			const debtDisplay = resolveHomeDebtDisplay(currentTotal, rawApiDebts)
			const apiDebts = debtDisplay.rows.map(({ account, sourceIndex }) => (
				makeDebt(account, sourceIndex, `api_${apiReportId}`, apiAnchorDate)
			))
      activeReportId.value = apiReportId
      activeReport.value = null
      activeSource.value = 'api'
      debts.value = apiDebts
			debtConflictReason.value = debtDisplay.conflictReason
			debtEvidenceKnown.value = currentTotal != null
			explicitNoDebt.value = currentTotal === 0
			const apiMonthly = num(data.totalMonthly)
			const monthlyKnown = !debtDisplay.archiveConflict && (currentTotal === 0 || apiMonthly != null)
			const monthly = currentTotal === 0 ? 0 : (monthlyKnown ? apiMonthly : null)
			const apiDti = num(data.dtiRatio)
      summary.value = {
				totalDebt: formatMoney(currentTotal),
				monthlyPay: formatMoney(monthly),
				dti: apiDti == null ? '—' : `${apiDti}%`
      }
      return
    }

    if (routeRequestedReportId.value) {
      activeReport.value = null
      activeSource.value = 'unavailable'
      debts.value = []
		debtEvidenceKnown.value = false
		explicitNoDebt.value = false
		summary.value = { totalDebt: '—', monthlyPay: '—', dti: '—' }
      return
    }

    const latestReport = await getLatestReportAsync()
    if (!applyReportFallback(latestReport, 'latest')) {
      debts.value = []
		debtEvidenceKnown.value = false
		explicitNoDebt.value = false
		summary.value = { totalDebt: '—', monthlyPay: '—', dti: '—' }
    }
  } finally {
    if (requestId !== loadRequestId) return
    const reportId = activeReportKey.value
    await syncRemoteDebtExecutionSnapshot({
      reportId,
      isCurrent: () => requestId === loadRequestId && activeReportKey.value === reportId
    }).catch(() => {
      if (requestId === loadRequestId) refreshExecutionCloudSyncState({ status: 'local' })
    })
    if (requestId !== loadRequestId) return
    restoreOptimizationGoal()
    restoreAdvisorFeedback()
    loading.value = false
    setTimeout(() => promptFocusedReupload(), 0)
  }
}

const ratioHint = computed(() => {
  const policy = debtDecisionPolicy.value
  if (!policy.fields.debtRatio) return '档案比例未用于风险判断'
  const dti = policy.debtRatioPct
  if (dti <= 30) return '负债比例健康'
  if (dti <= 50) return '建议控制新增负债'
  return '负债比例偏高，建议优化'
})

const activeReminderCount = computed(() => {
  return debts.value.filter((item) => isDebtReminderSet(item)).length
})

const reminderText = computed(() => {
  if (activeReminderCount.value) return `已设置 ${activeReminderCount.value} 笔单项提醒`
  if (reminder.value.enabled && reminder.value.day > 0) return `已设每月 ${reminder.value.day} 日提醒`
  return '设置固定提醒日，避免还款遗漏'
})

// The owner API currently publishes aggregate decision fields only.  It does
// not publish an evidence-backed per-account risk rank, so account grouping and
// repayment ordering must remain unavailable instead of being recreated from
// archival inner-analysis rows in the browser.
const riskGroups = computed(() => [])
const repaymentPlan = computed(() => [])
const highRiskCount = computed(() => debtDecisionPolicy.value.fields.highRiskCount
  ? debtDecisionPolicy.value.highRiskCount
  : 0)
const riskSummaryText = computed(() => debtDecisionPolicy.value.fields.highRiskCount
  ? (highRiskCount.value ? `${highRiskCount.value} 个高优先级` : '未发现高优先级账户')
  : '暂无已验证的账户级风险分层')

const availableOptimizationGoals = computed(() => {
  const policy = debtDecisionPolicy.value
  const goals = []
  if (policy.fields.overdue && policy.hasOverdue === true) {
    goals.push({
      key: 'clear-overdue',
      level: 'danger',
      title: '先清逾期账户',
      sub: policy.overdueCount == null ? '已验证字段显示存在逾期账户，优先补齐并确认状态更新。' : `${policy.overdueCount} 笔存在逾期信号，优先补齐并确认状态更新。`,
      effect: '先处理已验证的逾期信号'
    })
  }
  if (policy.fields.cardUtilization && policy.cardUtilizationPct >= 70) {
    goals.push({
      key: 'lower-card-util',
      level: 'warning',
      title: '信用卡占用降到 60% 以下',
      sub: `已验证的信用卡整体使用率为 ${policy.cardUtilizationPct.toFixed(2)}%，先压降占用再看新增方案。`,
      effect: '改善已验证的信用卡额度使用率'
    })
  }
  if (policy.fields.debtRatio && policy.debtRatioPct > 50) {
    goals.push({
      key: 'lower-monthly',
      level: 'warning',
      title: '降低月供压力',
      sub: `已验证的负债比例为 ${policy.debtRatioPct.toFixed(2)}%，建议优先降低还款压力。`,
      effect: '降低已验证的负债比例'
    })
  }
  if (policy.fields.highRiskCount && policy.highRiskCount > 0) {
    goals.push({
      key: 'handle-high-risk',
      level: 'danger',
      title: '处理高优先级债务',
      sub: `${policy.highRiskCount} 笔已由服务端标记为高优先级，请按顾问确认的顺序处理。`,
      effect: '处理服务端已验证的高优先级项'
    })
  }
  if (policy.fields.accountCount && policy.accountCount >= 6) {
    goals.push({
      key: 'reduce-account-count',
      level: 'info',
      title: '减少小额分散账户',
      sub: `已验证账户数为 ${policy.accountCount}，可与顾问确认需要优先收拢的账户。`,
      effect: '逐步收拢分散账户'
    })
  }
  const allStableSignalsKnown = policy.fields.overdue && policy.fields.cardUtilization && policy.fields.debtRatio && policy.fields.riskLevel
  if (!goals.length && allStableSignalsKnown && policy.hasOverdue === false && policy.cardUtilizationPct < 70 && policy.debtRatioPct <= 50 && /低|low|稳定/i.test(policy.riskLevel)) {
    goals.push({
      key: 'keep-stable',
      level: 'success',
      title: '保持稳定还款',
      sub: '已验证字段未出现当前规则关注的高风险信号，继续按期还款。',
      effect: '维持稳定记录'
    })
  }
  return goals.slice(0, 4)
})
const optimizationTips = computed(() => availableOptimizationGoals.value.map((item) => ({
  key: item.key,
  level: item.level,
  title: item.title,
  desc: item.sub,
  effect: item.effect
})))
const hasDecisionGuidance = computed(() => availableOptimizationGoals.value.length > 0)
const suggestedGoal = computed(() => availableOptimizationGoals.value[0] || null)
const currentGoal = computed(() => {
  const selectedKey = optimizationGoal.value && optimizationGoal.value.key
  return availableOptimizationGoals.value.find((item) => item.key === selectedKey) || suggestedGoal.value
})
const goalTitle = computed(() => currentGoal.value?.title || '暂无已验证优化目标')
const goalSub = computed(() => currentGoal.value?.sub || '当前仅展示报告档案数据，不在浏览器内生成建议。')
const activeReportScopeIds = computed(() => {
	const stateIds = resolveDecisionReportIdAliases([
		activeCanonicalReportId.value,
		activeClientReportId.value,
		routeRequestedReportId.value,
		activeReportId.value
	])
	const reportIds = reportScopeResolutionOf(activeReport.value)
	if (!stateIds || !reportIds) return new Set()
	return new Set([...stateIds, ...reportIds])
})
const activeReportKey = computed(() => Array.from(activeReportScopeIds.value)[0] || '')
const recordBelongsToActiveReport = (record) => {
	const recordReportIds = resolveDecisionReportIdAliases([
    record && record.reportId,
    record && record.clientReportId,
    record && record.sourceReportId
	])
	if (!recordReportIds) return false
  if (activeReportScopeIds.value.size) return recordReportIds.some((value) => activeReportScopeIds.value.has(value))
  return recordReportIds.length === 0
}
const currentDebtIds = computed(() => new Set(debts.value.map((item) => String(item.id))))
const currentExecutionRecords = computed(() => executionRecords.value.filter((item) => (
  recordBelongsToActiveReport(item) &&
  currentDebtIds.value.has(String(item.debtId))
)))
const goalProgress = computed(() => {
  const goal = currentGoal.value
  const policy = debtDecisionPolicy.value
  if (!hasDecisionGuidance.value || !goal) {
    return {
      title: '决策进度未验证',
      percent: 0,
      sub: '当前仅展示档案与用户操作记录，不计算风险改善进度'
    }
  }
  const handledIds = new Set(activeDebtExecutionRecords(currentExecutionRecords.value)
    .filter((record) => record.type === 'handled' || (record.type === 'proof' && debtProofStatusText(record) !== '需重传'))
    .map((record) => String(record.debtId)))
  const handledRatio = debts.value.length ? clamp(Math.round((handledIds.size / debts.value.length) * 100), 0, 100) : 0
  const withHandled = (percent) => Math.max(percent, handledRatio)
  if (goal.key === 'clear-overdue') {
    const count = policy.overdueCount
    const percent = count === 0 ? 100 : 20
    return { title: count == null ? '已验证存在逾期信号' : `${count} 笔逾期待处理`, percent: withHandled(percent), sub: '优先补齐并确认状态更新' }
  }
  if (goal.key === 'lower-card-util') {
    const pct = policy.cardUtilizationPct
    const percent = pct <= 60 ? 100 : clamp(Math.round(100 - (pct - 60) * 2), 15, 95)
    return { title: `信用卡整体使用率 ${pct.toFixed(2)}%`, percent: withHandled(percent), sub: '继续压降已验证的整体额度占用' }
  }
  if (goal.key === 'lower-monthly') {
    const dti = policy.debtRatioPct
    const percent = clamp(100 - Math.max(0, dti - 50) * 2, 20, 100)
    return { title: `负债比例 ${dti.toFixed(2)}%`, percent: withHandled(percent), sub: dti > 50 ? '已验证负债比例仍偏高' : '已验证负债比例趋稳' }
  }
  if (goal.key === 'handle-high-risk') {
    const percent = highRiskCount.value ? clamp(100 - highRiskCount.value * 22, 20, 90) : 100
    return { title: highRiskCount.value ? `${highRiskCount.value} 个高优先级待处理` : '高优先级已处理', percent: withHandled(percent), sub: '按服务端已验证结果推进' }
  }
  if (goal.key === 'reduce-account-count') {
    return { title: `已验证账户数 ${policy.accountCount}`, percent: withHandled(25), sub: '与顾问确认需要优先收拢的账户' }
  }
  return { title: '稳定还款中', percent: withHandled(100), sub: '保持提醒和顾问跟进' }
})
const currentActiveExecutionRecords = computed(() => activeDebtExecutionRecords(currentExecutionRecords.value))
const foldedRejectedProofRecords = computed(() => supersededDebtProofRecords(currentExecutionRecords.value))
const proofReviewStats = computed(() => currentActiveExecutionRecords.value.reduce((acc, item) => {
  if (item.type !== 'proof') return acc
  const text = debtProofStatusText(item)
  acc.total += 1
  if (text === '已确认' || text === '无需') acc.confirmed += 1
  else if (text === '需重传') acc.rejected += 1
  else acc.reviewing += 1
  return acc
}, { total: 0, reviewing: 0, confirmed: 0, rejected: 0 }))
const handledDebtCount = computed(() => new Set(currentActiveExecutionRecords.value.filter((item) => item.type === 'handled' || (item.type === 'proof' && debtProofStatusText(item) !== '需重传')).map((item) => String(item.debtId))).size)
const proofRecordCount = computed(() => proofReviewStats.value.total)
const proofTimelineState = (item) => {
  const text = debtProofStatusText(item)
  if (text === '已确认' || text === '无需') return 'done'
  if (text === '需重传') return 'action'
  return 'review'
}
const proofTimelineTitle = (item) => {
  const text = debtProofStatusText(item)
  if (text === '已确认') return '凭证已确认'
  if (text === '无需') return '凭证无需补充'
  if (text === '需重传') return '凭证需重传'
  return '上传还款凭证'
}
const proofTimelineDesc = (item) => {
  const text = debtProofStatusText(item)
  if (text === '已确认') return `${item.title} · 顾问已确认${item.fileName ? ` ${item.fileName}` : '该凭证'}。`
  if (text === '无需') return `${item.title} · 顾问已标记该凭证无需继续补充。`
  if (text === '需重传') return `${item.title} · ${item.reviewNote || '凭证未通过复核，请重新上传清晰完整凭证。'}`
  return `${item.title} · ${item.fileName || '凭证已上传'}，等待顾问复核。`
}
const executionTimeline = computed(() => {
  const rows = currentActiveExecutionRecords.value
    .slice()
    .sort((a, b) => Number(b.time || 0) - Number(a.time || 0))
    .slice(0, 6)
    .map((item) => ({
      id: item.id,
      state: item.type === 'proof' ? proofTimelineState(item) : 'done',
      title: item.type === 'proof' ? proofTimelineTitle(item) : '标记债务已处理',
      desc: item.type === 'proof' ? proofTimelineDesc(item) : `${item.title} · ${item.note || '已记录处理动作，可继续上传凭证。'}`,
      time: formatShortTime(item.reviewedAt || item.createdAt)
    }))
  if (foldedRejectedProofRecords.value.length) {
    rows.push({
      id: 'folded-rejected-proofs',
      state: 'folded',
      title: '旧驳回记录已折叠',
      desc: `${foldedRejectedProofRecords.value.length} 条旧驳回凭证已重新上传，当前以最新凭证复核进度为准。`,
      time: ''
    })
  }
  return rows
})
const proofStatsText = computed(() => {
  const stats = proofReviewStats.value
  if (stats.rejected) return `${stats.rejected} 份需重传`
  if (stats.reviewing) return `${stats.reviewing} 份待复核`
  if (stats.confirmed) return `${stats.confirmed} 份已确认`
  return '可上传截图或文件'
})
const executionCloudSyncText = computed(() => {
  const state = executionCloudSyncState.value || {}
  if (state.pending) return `云端待同步 ${state.pending} 条，联网后自动重试`
  if (state.status === 'failed') return '云端同步失败，已保留本机记录'
  if (state.status === 'cloud') return '已读取云端执行记录和顾问复核结果'
  if (state.status === 'synced') return '执行记录已同步云端'
  return ''
})

const executionStats = computed(() => [
  { key: 'goal', label: '目标进度', value: `${goalProgress.value.percent}%`, sub: goalProgress.value.sub },
  { key: 'handled', label: '已处理', value: `${handledDebtCount.value} 笔`, sub: handledDebtCount.value ? '已进入时间线' : '可标记重点账户' },
  { key: 'proof', label: '凭证', value: `${proofRecordCount.value} 份`, sub: proofStatsText.value },
  { key: 'advisor', label: '顾问回填', value: advisorFeedback.value ? '已接入' : '待预约', sub: advisorFeedback.value ? advisorFeedback.value.statusText : '可带当前债务咨询' }
])

const reportContextTitle = computed(() => activeReport.value ? reportTitleOf(activeReport.value) : '')
const reportContextSub = computed(() => {
  if (!activeReport.value) return ''
  const parts = [reportDateOf(activeReport.value), reportScoreText(reportScoreOf(activeReport.value))]
    .filter(Boolean)
    .join(' · ')
  const sourceText = activeSource.value === 'fallback' ? '指定报告不可用，已使用最新报告' : activeSource.value === 'selected' ? '来自当前查看的报告' : '来自最新报告'
  return parts ? `${sourceText} · ${parts}` : sourceText
})
const currentDebtConflictCopy = computed(() => debtEvidenceConflictCopy(debtConflictReason.value))
const emptyStateTitle = computed(() => {
  if (!loggedIn.value) return '登录后查看债务明细'
	if (currentDebtConflictCopy.value) return currentDebtConflictCopy.value.title
	if (debtDecisionPolicy.value.fields.totalDebt && debtDecisionPolicy.value.totalDebt === 0) return '已核验暂无未结清债务'
	if (explicitNoDebt.value) return '报告档案记录负债为 0（待核对）'
	if (activeReport.value) return '这份报告的债务明细待核对'
	return '债务信息待核对'
})
const emptyStateSub = computed(() => {
  if (!loggedIn.value) return '登录后可同步云端报告，并查看负债概览。'
	if (currentDebtConflictCopy.value) return currentDebtConflictCopy.value.detail
	if (debtDecisionPolicy.value.fields.totalDebt && debtDecisionPolicy.value.totalDebt === 0) return '服务端证据明确确认当前负债为 0。'
	if (explicitNoDebt.value) return '档案字段明确为 0，但本次会话没有同报告 owner 证据，不用于风险或优化决策。'
	if (activeReport.value) return '余额或账户状态缺失，未按 0 元或“暂无债务”处理；可重新上传清晰完整报告。'
  return '上传信用报告后，系统会从报告账户中生成债务概览。'
})

const restoreReminder = () => {
  const saved = uni.getStorageSync(REMINDER_KEY)
	if (saved && typeof saved === 'object') {
		const day = strictNonNegativeIntegerOrNull(saved.day)
		reminder.value = { enabled: saved.enabled === true, day: day != null && day <= 28 ? day : 0 }
	}
}

const persistReminder = () => {
  uni.setStorageSync(REMINDER_KEY, { ...reminder.value })
}

const restoreItemReminders = () => {
  const saved = uni.getStorageSync(ITEM_REMINDER_KEY)
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
    itemReminders.value = {}
    return
  }
  const normalized = {}
  Object.entries(saved).forEach(([storedKey, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const delimiterAt = storedKey.indexOf('::')
    const storedNamespace = delimiterAt > 0 ? storedKey.slice(0, delimiterAt) : ''
		const storedDebtId = String(value.id || (delimiterAt > 0 ? storedKey.slice(delimiterAt + 2) : storedKey) || '')
		if (!storedDebtId) return
		const namespaceIds = resolveDecisionReportIdAliases([
			value.reportId,
			value.namespace,
			storedNamespace
		], { requireMatch: true })
		if (!namespaceIds) return
		const namespace = namespaceIds[0] || 'legacy'
    normalized[`${namespace}::${storedDebtId}`] = { ...value, id: storedDebtId, namespace }
  })
  itemReminders.value = normalized
}

const persistItemReminders = () => {
  uni.setStorageSync(ITEM_REMINDER_KEY, { ...(itemReminders.value || {}) })
}

const refreshExecutionCloudSyncState = (patch = {}) => {
  executionCloudSyncState.value = {
    ...executionCloudSyncState.value,
    ...patch,
    pending: readDebtExecutionSyncQueue().length,
    updatedAt: patch.updatedAt || new Date().toISOString()
  }
}

const restoreExecutionRecords = () => {
  const saved = readDebtExecutionRecords()
  const status = readLastConsultationStatus()
  const synced = applyDebtExecutionCloudSnapshot(saved, { reviewMaterials: status && status.materials })
  executionRecords.value = synced.changed ? saveDebtExecutionRecords(synced.records) : synced.records
  refreshExecutionCloudSyncState({ status: 'local', error: '' })
}

const persistExecutionRecords = () => {
  executionRecords.value = saveDebtExecutionRecords(executionRecords.value)
  refreshExecutionCloudSyncState({ status: 'local', error: '' })
}

const syncExecutionRecordToCloud = async (record) => {
  if (!loggedIn.value || !record) {
    refreshExecutionCloudSyncState()
    return null
  }
  const result = await syncDebtExecutionRecord(record, saveDebtExecutionRecordRemote)
  refreshExecutionCloudSyncState({
    status: result.ok ? 'synced' : result.queued ? 'failed' : 'skipped',
    error: result.error ? String(result.error.message || result.error.errMsg || result.error) : ''
  })
  notifyMessageUnreadChange({ source: 'debt-execution-cloud-sync', recordId: record.id })
  return result
}

const syncRemoteDebtExecutionSnapshot = async (options = {}) => {
  if (!loggedIn.value) return
  const reportId = options.reportId === undefined ? activeReportKey.value : options.reportId
  const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true
  const [remoteResult, contactsResult] = await Promise.allSettled([
    getDebtExecutionRecords(reportId ? { reportId } : {}),
    getAdvisorContacts()
  ])
  if (!isCurrent()) return
  const remoteRecords = remoteResult.status === 'fulfilled' ? remoteResult.value : []
  const contactsData = contactsResult.status === 'fulfilled' ? contactsResult.value : []
  const synced = applyDebtExecutionCloudSnapshot(executionRecords.value, { remoteRecords, contactRecords: contactsData })
  if (synced.changed) {
    executionRecords.value = saveDebtExecutionRecords(synced.records)
    notifyMessageUnreadChange({ source: 'debt-execution-cloud-snapshot' })
  }
  const retryResult = await retryPendingDebtExecutionSync(saveDebtExecutionRecordRemote, undefined, { limit: 5 }).catch((e) => ({ error: e }))
  if (!isCurrent()) return
  refreshExecutionCloudSyncState({
    status: remoteResult.status === 'fulfilled' ? 'cloud' : 'local',
    error: remoteResult.status === 'rejected' ? String(remoteResult.reason && (remoteResult.reason.message || remoteResult.reason.errMsg) || remoteResult.reason || '') : ''
  })
  if (retryResult && !retryResult.error && retryResult.success) notifyMessageUnreadChange({ source: 'debt-execution-cloud-retry' })
}

const formatShortTime = (value) => {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value).slice(5, 16)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const restoreOptimizationGoal = () => {
  const saved = uni.getStorageSync(GOAL_KEY)
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
    optimizationGoal.value = null
    return
  }
	const savedReportId = normalizeDecisionReportId(saved.reportId)
  const currentReportId = activeReportKey.value
  optimizationGoal.value = currentReportId && activeReportScopeIds.value.has(savedReportId)
    ? saved
    : (!currentReportId && !savedReportId ? saved : null)
}

const restoreAdvisorFeedback = () => {
  const status = readLastConsultationStatus()
  const marker = [status?.productName, status?.summary, status?.contactType].filter(Boolean).join(' ')
	const statusReportId = normalizeDecisionReportId(status?.reportId)
  const currentReportId = activeReportKey.value
  const belongsToCurrentReport = currentReportId
    ? activeReportScopeIds.value.has(statusReportId)
    : !statusReportId
  if (!status || !belongsToCurrentReport || !/债务|负债/.test(marker)) {
    advisorFeedback.value = null
    return
  }
  advisorFeedback.value = {
    title: status.productName || '债务优化顾问已接入',
    statusText: status.statusText || '待顾问处理',
    summary: status.summary || '顾问已收到债务优化需求，将结合当前信用报告处理。',
    reportId: status.reportId || '',
    updatedAt: status.createdAt || status.savedAt || ''
  }
}

const persistOptimizationGoal = (goal) => {
  const reportId = activeReportKey.value
  optimizationGoal.value = goal ? { ...goal, reportId, updatedAt: new Date().toISOString() } : null
  if (optimizationGoal.value) uni.setStorageSync(GOAL_KEY, optimizationGoal.value)
  else uni.removeStorageSync(GOAL_KEY)
}

const setOptimizationGoal = () => {
  if (!loggedIn.value) {
    goLogin()
    return
  }
  const goals = availableOptimizationGoals.value
  if (!goals.length) {
    uni.showToast({ title: '暂无已验证优化目标', icon: 'none' })
    return
  }
  uni.showActionSheet({
    itemList: goals.map((item) => item.title),
    success: (res) => {
      const goal = goals[Number(res.tapIndex)]
      if (!goal) return
      persistOptimizationGoal(goal)
      uni.showToast({ title: '已更新优化目标', icon: 'none' })
    }
  })
}

const debtTitleOf = (item) => [item?.institution, item?.product].filter(Boolean).join(' · ') || '当前债务'
const activeDebtNamespace = computed(() => activeReportKey.value || (activeSource.value === 'api' ? 'api' : 'legacy'))
const debtReminderKey = (item) => item && item.id ? `${activeDebtNamespace.value}::${String(item.id)}` : ''
const debtReminderKeys = (item) => {
  if (!item || !item.id) return []
  const namespaces = activeReportScopeIds.value.size ? Array.from(activeReportScopeIds.value) : [activeDebtNamespace.value]
  return namespaces.filter(Boolean).map((namespace) => `${namespace}::${String(item.id)}`)
}
const existingDebtReminderEntry = (item) => debtReminderKeys(item)
  .map((key) => ({ key, value: itemReminders.value && itemReminders.value[key] }))
  .find((entry) => entry.value) || null
const isDebtReminderSet = (item) => {
  return Boolean(existingDebtReminderEntry(item))
}

const setDebtReminder = (item) => {
  if (!loggedIn.value) {
    goLogin()
    return
  }
  if (!item || !item.id) return
  const reminderKey = debtReminderKey(item)
  const existingEntry = existingDebtReminderEntry(item)
  if (existingEntry) {
    const existing = existingEntry.value
    uni.showModal({
      title: '单笔提醒',
      content: `${existing.title || debtTitleOf(item)} 已设置提醒。`,
      confirmText: '关闭',
      cancelText: '保留',
      success: (res) => {
        if (!res.confirm) return
        const next = { ...(itemReminders.value || {}) }
        delete next[existingEntry.key]
        itemReminders.value = next
        persistItemReminders()
        uni.showToast({ title: '已关闭单笔提醒', icon: 'none' })
      }
    })
    return
  }
  const dueDay = item.dueDays != null && item.dueDays >= 0 ? item.dueText : (reminder.value.enabled && reminder.value.day ? `每月 ${reminder.value.day} 日` : item.dueText)
	const reminderAmount = resolveDebtReminderAmount(item)
  itemReminders.value = {
    ...(itemReminders.value || {}),
    [reminderKey]: {
      id: item.id,
      namespace: activeDebtNamespace.value,
      title: debtTitleOf(item),
			amount: reminderAmount.amount,
			amountText: reminderAmount.amountText,
      reportId: activeReportKey.value,
      dueText: dueDay || '按账单日提醒',
      riskLevel: item.decisionEligible ? item.riskLevel : '',
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    }
  }
  persistItemReminders()
  uni.showToast({ title: '已设置单笔提醒', icon: 'none' })
}

const recordsForDebt = (item) => item && item.id
  ? executionRecords.value.filter((record) => (
      recordBelongsToActiveReport(record) &&
      String(record.debtId) === String(item.id)
    ))
  : []
const activeRecordsForDebt = (item) => activeDebtExecutionRecords(recordsForDebt(item))
const reviewedProofRecordsForDebt = (item) => activeRecordsForDebt(item)
  .filter((record) => record.type === 'proof' && isReviewableDebtProofRecord(record))
  .sort((a, b) => Number(b.time || 0) - Number(a.time || 0))
const pendingReviewAckRecordForDebt = (item) => reviewedProofRecordsForDebt(item).find((record) => !record.reviewAcknowledgedAt) || null
const reviewAckSubText = (record) => {
  if (!record || !record.reviewAcknowledgedAt) return ''
  return debtProofStatusText(record) === '需重传' ? '已记录用户查看驳回原因' : '已记录用户查看确认结果'
}
const focusedProofRecord = computed(() => {
  const id = focusedExecutionRecordId.value
  if (!id) return null
  return currentActiveExecutionRecords.value.find((record) => String(record.id) === String(id)) || null
})
const focusedDebtKey = computed(() => focusedDebtId.value || (focusedProofRecord.value && focusedProofRecord.value.debtId) || '')
const debtAnchorId = (item) => item && item.id ? `debt-${safeAnchorText(item.id)}` : ''
const isFocusedDebt = (item) => Boolean(item && (
  (item.id && focusedDebtKey.value && String(item.id) === String(focusedDebtKey.value)) ||
  (item.navigationKey && focusedDebtNavigationKey.value && String(item.navigationKey) === String(focusedDebtNavigationKey.value))
))
const focusedDebtItem = computed(() => debts.value.find((item) => isFocusedDebt(item)) || null)
const focusedDebtAnchor = computed(() => focusedDebtItem.value ? debtAnchorId(focusedDebtItem.value) : (focusedDebtKey.value ? `debt-${safeAnchorText(focusedDebtKey.value)}` : ''))
const focusedDebtSourceTitle = computed(() => routeSource.value === 'home' ? '首页最近债务' : '来自消息提醒')
const reuploadRecordForDebt = (item) => {
  if (!item) return null
  const focused = focusedProofRecord.value
  if (focused && String(focused.debtId) === String(item.id) && activeRecordsForDebt(item).some((record) => String(record.id) === String(focused.id)) && debtProofStatusText(focused) === '需重传') return focused
  return activeRecordsForDebt(item).find((record) => record.type === 'proof' && debtProofStatusText(record) === '需重传') || null
}
const shouldReuploadFocusedDebt = (item) => routeFocus.value === 'proof-reupload' && isFocusedDebt(item) && !!reuploadRecordForDebt(item)
const focusedDebtHint = (item) => {
  const record = reuploadRecordForDebt(item)
  if (record) return record.reviewNote || '凭证未通过复核，请重新上传清晰完整凭证。'
  if (routeFocus.value === 'proof-record') return '已定位到这笔债务的凭证记录，可查看处理记录。'
  if (routeSource.value === 'home') return '已定位到首页选择的这笔债务。'
  return '已定位到消息关联债务。'
}
const focusedDebtTitle = computed(() => {
  const item = focusedDebtItem.value
  return item ? debtTitleOf(item) : ''
})
const messageRouteContext = computed(() => {
  if (routeSource.value !== 'message') return null
  const title = focusedDebtTitle.value ? `已定位到 ${focusedDebtTitle.value}` : '已从消息进入债务管理'
  const sub = routeFocus.value === 'proof-reupload'
    ? '这条消息需要重新上传凭证，页面已高亮对应债务。'
    : routeFocus.value === 'proof-record'
      ? '页面已定位到对应债务，可查看处理记录和复核结果。'
      : '已保留消息来源，可返回消息中心或查看关联信用报告资产。'
  return { title, sub }
})
const debtActionText = (item) => shouldReuploadFocusedDebt(item) ? '重传' : (pendingReviewAckRecordForDebt(item) ? '确认' : (debtExecutionStatus(item) ? '记录' : '处理'))
const debtExecutionStatus = (item) => {
  const latest = activeRecordsForDebt(item).slice().sort((a, b) => Number(b.time || 0) - Number(a.time || 0))[0]
  if (!latest) return null
  if (latest.type === 'proof') {
    const text = debtProofStatusText(latest)
    if (text === '已确认') return { title: latest.reviewAcknowledgedAt ? '确认结果已查看' : '凭证已确认', sub: reviewAckSubText(latest) || latest.fileName || '顾问已确认该凭证', statusText: '已确认', state: 'confirmed' }
    if (text === '需重传') return { title: latest.reviewAcknowledgedAt ? '驳回原因已查看' : '凭证需重传', sub: reviewAckSubText(latest) || latest.reviewNote || '请重新上传清晰完整凭证', statusText: '需重传', state: 'rejected' }
    return { title: '凭证待复核', sub: latest.fileName || '已上传还款凭证', statusText: '待复核', state: 'review' }
  }
  return { title: '已标记处理', sub: latest.note || '可继续上传凭证给顾问复核', statusText: '已记录', state: 'handled' }
}
const addExecutionRecord = (item, patch = {}) => {
  const now = new Date().toISOString()
  const record = {
    id: `debt_exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    debtId: item.id,
    title: debtTitleOf(item),
    product: item.product,
    institution: item.institution,
    reportId: activeReportKey.value,
    status: patch.type === 'proof' ? 'reviewing' : 'handled',
    statusText: patch.type === 'proof' ? '待复核' : '已记录',
    time: Date.now(),
    createdAt: now,
    ...patch
  }
  executionRecords.value = [record, ...executionRecords.value]
  persistExecutionRecords()
  syncExecutionRecordToCloud(record).catch(() => refreshExecutionCloudSyncState({ status: 'failed' }))
  notifyMessageUnreadChange({ source: 'debt-execution', recordId: record.id })
  return record
}
const acknowledgeDebtProofReviewForDebt = (item, options = {}) => {
  if (!loggedIn.value) { goLogin(); return null }
  const target = options.record || pendingReviewAckRecordForDebt(item) || reviewedProofRecordsForDebt(item)[0]
  if (!target) {
    if (!options.silent) uni.showToast({ title: '暂无可确认的复核结果', icon: 'none' })
    return null
  }
  const statusText = debtProofStatusText(target)
  const acknowledged = acknowledgeDebtProofReview(executionRecords.value, target, {
    reviewAcknowledgedNote: options.note || (statusText === '需重传' ? '用户已查看驳回原因，稍后处理。' : '用户已查看凭证确认结果。')
  })
  if (!acknowledged.record) return null
  executionRecords.value = saveDebtExecutionRecords(acknowledged.records)
  syncExecutionRecordToCloud(acknowledged.record).catch(() => refreshExecutionCloudSyncState({ status: 'failed' }))
  notifyMessageUnreadChange({ source: 'debt-proof-review-ack', recordId: acknowledged.record.id })
  if (!options.silent) uni.showToast({ title: statusText === '需重传' ? '已记录查看原因' : '已确认查看结果', icon: 'none' })
  return acknowledged.record
}
const markDebtHandled = (item) => {
  if (!loggedIn.value) { goLogin(); return }
  addExecutionRecord(item, { type: 'handled', note: item.riskAction || '用户已标记该账户完成处理。' })
  uni.showToast({ title: '已记录处理动作', icon: 'none' })
}
const pickProofFile = () => new Promise((resolve, reject) => {
  const done = (res, fallbackName) => {
    const f = (res.tempFiles && res.tempFiles[0]) || null
    const path = (res.tempFilePaths && res.tempFilePaths[0]) || (f && f.path) || ''
    if (!path) { reject(new Error('未选择凭证')); return }
    resolve({ path, name: (f && f.name) || fallbackName, size: f && typeof f.size === 'number' ? f.size : '' })
  }
  if (typeof uni.chooseFile === 'function') {
    uni.chooseFile({
      count: 1,
      extension: ['.pdf', '.jpg', '.jpeg', '.png'],
      success: (res) => done(res, 'debt-proof.pdf'),
      fail: () => reject(new Error('cancel'))
    })
    return
  }
  uni.chooseImage({
    count: 1,
    sourceType: ['album', 'camera'],
    success: (res) => done(res, 'debt-proof.jpg'),
    fail: () => reject(new Error('cancel'))
  })
})
const uploadDebtProof = async (item, options = {}) => {
  if (!loggedIn.value) { goLogin(); return }
  if (proofUploadingId.value) return
  proofUploadingId.value = item.id
  try {
    const picked = await pickProofFile()
    const url = await uploadLocalFile({ filePath: picked.path, folder: 'debt-proofs' })
    const record = addExecutionRecord(item, {
      type: 'proof',
      note: options.reuploadOf ? '用户已重新上传债务处理凭证，等待顾问复核。' : '用户已上传债务处理凭证，等待顾问复核。',
      reuploadOf: options.reuploadOf || '',
      fileName: picked.name,
      fileSize: picked.size,
      url,
      uploadedAt: new Date().toISOString()
    })
    if (options.reuploadOf) {
      focusedExecutionRecordId.value = record.id
      focusedDebtId.value = item.id
      routeFocus.value = 'proof-record'
    }
    uni.showToast({ title: options.reuploadOf ? '凭证已重新上传' : '凭证已上传', icon: 'none' })
  } catch (e) {
    if (!/cancel/i.test(String(e && e.message))) uni.showToast({ title: '凭证上传失败', icon: 'none' })
  } finally {
    proofUploadingId.value = ''
  }
}
const showDebtExecutionRecords = (item) => {
  const source = recordsForDebt(item)
  const list = activeDebtExecutionRecords(source).slice().sort((a, b) => Number(b.time || 0) - Number(a.time || 0)).slice(0, 4)
  const folded = supersededDebtProofRecords(source)
  if (!list.length && !folded.length) {
    uni.showToast({ title: '暂无处理记录', icon: 'none' })
    return
  }
  const lines = list.map((record) => {
    const ack = record.reviewAcknowledgedAt ? ' · 已查看复核结果' : ''
    return `${formatShortTime(record.reviewedAt || record.createdAt)} ${record.type === 'proof' ? `上传凭证（${debtProofStatusText(record)}）${ack}` : '标记处理'}`
  })
  if (folded.length) lines.push(`已折叠 ${folded.length} 条旧驳回记录`)
  uni.showModal({
    title: '处理记录',
    content: lines.join('\n'),
    showCancel: false,
    confirmText: '知道了'
  })
}
const openDebtExecution = (item) => {
  if (!loggedIn.value) { goLogin(); return }
  const actions = []
  if (pendingReviewAckRecordForDebt(item)) actions.push({ label: '确认复核结果', run: () => acknowledgeDebtProofReviewForDebt(item) })
  actions.push(
    { label: '标记已处理', run: () => markDebtHandled(item) },
    { label: '上传凭证/截图', run: () => uploadDebtProof(item) },
    { label: '查看处理记录', run: () => showDebtExecutionRecords(item) }
  )
  uni.showActionSheet({
    itemList: actions.map((action) => action.label),
    success: (res) => {
      const action = actions[Number(res.tapIndex)]
      if (action) action.run()
    }
  })
}
const handleDebtExecutionAction = (item) => {
  if (shouldReuploadFocusedDebt(item)) {
    const record = reuploadRecordForDebt(item)
    uploadDebtProof(item, { reuploadOf: record && record.id })
    return
  }
  openDebtExecution(item)
}
const promptFocusedReupload = () => {
  if (!loggedIn.value || focusPrompted.value || routeFocus.value !== 'proof-reupload') return
  const target = debts.value.find((item) => isFocusedDebt(item))
  const record = target ? reuploadRecordForDebt(target) : null
  if (!target || !record) return
  focusPrompted.value = true
  uni.showModal({
    title: '凭证需重传',
    content: `${debtTitleOf(target)}\n${record.reviewNote || '凭证未通过复核，请重新上传清晰完整凭证。'}`,
    confirmText: '重新上传',
    cancelText: '稍后处理',
    success: (res) => {
      if (res.confirm) uploadDebtProof(target, { reuploadOf: record.id })
      else acknowledgeDebtProofReviewForDebt(target, { record, silent: true, note: '用户已查看驳回原因，稍后重传。' })
    }
  })
}

const buildAdvisorDebtContext = (item = null) => ({
  reportId: activeReportKey.value,
  reportTitle: activeReport.value ? reportTitleOf(activeReport.value) : '',
  reportScore: activeReport.value ? reportScoreOf(activeReport.value) : '',
  goal: hasDecisionGuidance.value ? currentGoal.value : null,
  executionRecords: item ? activeRecordsForDebt(item) : currentActiveExecutionRecords.value,
  executionSummary: { handledDebtCount: handledDebtCount.value, proofRecordCount: proofRecordCount.value },
  debt: item ? {
    id: item.id,
    title: debtTitleOf(item),
    institution: item.institution,
    product: item.product,
    balanceLabel: item.balanceLabel,
    monthlyLabel: item.monthlyLabel,
    dueText: item.dueText,
    riskLevel: item.decisionEligible ? item.riskLevel : null,
    riskText: item.decisionEligible ? item.riskText : '',
    riskReason: item.decisionEligible ? item.riskReason : '',
    riskAction: item.decisionEligible ? item.riskAction : ''
  } : null,
  summary: {
    totalDebt: displaySummary.value.totalDebt,
    totalDebtLabel: displaySummary.value.totalDebtLabel,
    monthlyPay: displaySummary.value.monthlyPay,
    dti: displaySummary.value.dti,
    dtiLabel: displaySummary.value.dtiLabel,
    highRiskCount: debtDecisionPolicy.value.fields.highRiskCount ? highRiskCount.value : null
  },
  updatedAt: new Date().toISOString()
})

const goAdvisorWithDebt = (item = null) => {
  if (!loggedIn.value) {
    goLogin()
    return
  }
  const context = buildAdvisorDebtContext(item)
  uni.setStorageSync(DEBT_ADVISOR_CONTEXT_KEY, context)
  const query = [
    'from=debt',
    'focus=debt',
    context.reportId ? `reportId=${encodeURIComponent(context.reportId)}` : '',
    item && item.id ? `debtId=${encodeURIComponent(item.id)}` : '',
    item ? `debtName=${encodeURIComponent(debtTitleOf(item))}` : ''
  ].filter(Boolean).join('&')
  uni.navigateTo({
    url: `/pages/profile/advisor?${query}`,
    fail: () => { uni.showToast({ title: '无法打开顾问页', icon: 'none' }) }
  })
}

const chooseReminderDay = () => {
  const days = Array.from({ length: 28 }, (_, i) => `每月 ${i + 1} 日`)
  uni.showActionSheet({
    itemList: days,
    success: (res) => {
      const day = Number(res.tapIndex) + 1
      reminder.value = { enabled: true, day }
      persistReminder()
      uni.showToast({ title: `已设置每月 ${day} 日提醒`, icon: 'none' })
    }
  })
}

const onRemind = () => {
  if (!loggedIn.value) {
    goLogin()
    return
  }
  if (!reminder.value.enabled) {
    chooseReminderDay()
    return
  }
  uni.showModal({
    title: '还款提醒',
    content: `当前已设置每月 ${reminder.value.day} 日提醒。`,
    confirmText: '修改',
    cancelText: '关闭',
    success: (res) => {
      if (res.confirm) chooseReminderDay()
      else if (res.cancel) {
        reminder.value = { enabled: false, day: 0 }
        persistReminder()
        uni.showToast({ title: '已关闭提醒', icon: 'none' })
      }
    }
  })
}

const statusClass = (status) => ({
  'status-ok': status === '正常',
  'status-bad': status === '逾期',
  'status-done': status !== '正常' && status !== '逾期'
})
const statusTextClass = (status) => ({
  'status-text-ok': status === '正常',
  'status-text-bad': status === '逾期',
  'status-text-done': status !== '正常' && status !== '逾期'
})

const goBack = () => {
  if (routeSource.value === 'message') { goDebtMessages(); return }
  safeBack('/pages/profile/profile')
}
const goLogin = () => uni.navigateTo({ url: '/pages/login/index' })
const goUpload = () => uni.navigateTo({ url: '/pages/report/upload' })
const goReportManage = () => {
  const id = activeReport.value && activeReport.value.id ? activeReport.value.id : activeReportId.value
  const query = [routeSource.value === 'message' ? 'from=message' : '', id ? `reportId=${encodeURIComponent(id)}` : ''].filter(Boolean).join('&')
  const url = `/pages/report/manage${query ? '?' + query : ''}`
  uni.navigateTo({ url, fail: () => { uni.showToast({ title: '无法打开报告管理页', icon: 'none' }) } })
}
const goDebtMessages = () => safeSwitchTab('/pages/message/center')
const goReportDetail = () => {
  const id = activeReport.value && activeReport.value.id ? activeReport.value.id : activeReportId.value
  if (!id) { goReportManage(); return }
  uni.navigateTo({ url: `/pages/report/detail?id=${encodeURIComponent(id)}&from=debt`, fail: () => { uni.showToast({ title: '无法打开报告页', icon: 'none' }) } })
}

onLoad((query = {}) => {
	const requestedIds = resolveDecisionReportIdAliases([query.reportId, query.id], { requireMatch: true })
	routeRequestedReportId.value = requestedIds && requestedIds.length ? requestedIds[0] : ''
  activeReportId.value = routeRequestedReportId.value
  routeSource.value = queryText(query.from)
  activeSource.value = query.from ? 'selected' : 'latest'
  routeFocus.value = queryText(query.focus)
  focusedDebtId.value = queryText(query.debtId)
  focusedDebtNavigationKey.value = queryText(query.debtKey)
  focusedExecutionRecordId.value = queryText(query.executionRecordId)
  focusPrompted.value = false
})
onShow(() => load())
</script>

<style scoped>
.page { min-height: 100vh; background: #F5F6FA; }
.nav { flex-direction: row; align-items: center; padding: calc(var(--rpt-safe-top) + 8px) 14px 8px; background: #fff; border-bottom: 1px solid #EEF0F4; }
.nav-title { flex: 1; text-align: center; font-size: 16px; font-weight: 800; color: #111827; }
.nav-spacer { width: 32px; }
.scroll-body { flex: 1; height: 100vh; }
.wrap { padding: 16px; }

.report-context { background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; padding: 14px; margin-bottom: 12px; flex-direction: row; align-items: center; }
.message-route-card { background: #111827; border-radius: 8px; padding: 13px; margin-bottom: 12px; flex-direction: row; align-items: center; }
.message-route-main { flex: 1; padding-right: 10px; }
.message-route-kicker { font-size: 11px; color: #93C5FD; font-weight: 900; }
.message-route-title { margin-top: 4px; font-size: 14px; color: #fff; font-weight: 900; line-height: 1.35; }
.message-route-sub { margin-top: 3px; font-size: 11px; color: #D1D5DB; line-height: 1.45; }
.message-route-actions { width: 76px; align-items: stretch; }
.message-route-primary, .message-route-ghost { height: 28px; border-radius: 8px; align-items: center; justify-content: center; }
.message-route-primary { background: #086CEA; }
.message-route-ghost { margin-top: 7px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.18); }
.message-route-primary-text { font-size: 11px; color: #fff; font-weight: 900; }
.message-route-ghost-text { font-size: 11px; color: #F3F4F6; font-weight: 900; }
.report-context-main { flex: 1; margin-right: 10px; }
.report-context-kicker { font-size: 11px; color: #086CEA; font-weight: 900; }
.report-context-title { margin-top: 4px; font-size: 15px; color: #111827; font-weight: 900; line-height: 1.35; }
.report-context-sub { margin-top: 4px; font-size: 12px; color: #6B7280; line-height: 1.5; }
.report-context-actions { align-items: flex-end; }
.context-action { height: 30px; border-radius: 8px; background: #086CEA; align-items: center; justify-content: center; padding: 0 10px; }
.context-action-text { color: #fff; font-size: 12px; font-weight: 900; }
.context-ghost { margin-top: 8px; height: 28px; border-radius: 8px; border: 1px solid #E5E7EB; align-items: center; justify-content: center; padding: 0 10px; }
.context-ghost-text { color: #374151; font-size: 12px; font-weight: 900; }

.summary-card { background: #fff; border-radius: 8px; padding: 18px; border: 1px solid #EEF0F4; }
.summary-kicker { font-size: 12px; color: #6B7280; font-weight: 700; }
.summary-total { margin-top: 6px; font-size: 30px; color: #086CEA; font-weight: 900; }
.summary-grid { flex-direction: row; margin-top: 16px; }
.summary-cell { flex: 1; }
.summary-label { font-size: 12px; color: #9CA3AF; }
.summary-value { margin-top: 4px; font-size: 16px; color: #111827; font-weight: 800; }
.ratio-chip { align-self: flex-start; margin-top: 14px; padding: 5px 10px; background: #FFFBEB; border-radius: 8px; }
.ratio-chip-text { font-size: 12px; color: #B45309; font-weight: 700; }

.reminder-row { flex-direction: row; align-items: center; background: #fff; border-radius: 8px; padding: 14px 16px; margin-top: 12px; border: 1px solid #EEF0F4; }
.reminder-main { flex: 1; }
.reminder-title { font-size: 15px; color: #111827; font-weight: 800; }
.reminder-sub { margin-top: 3px; font-size: 12px; color: #9CA3AF; }
.reminder-arrow { width: 22px; height: 22px; color: #C7CBD1; }
.action-panel { flex-direction: row; align-items: center; background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; padding: 14px; margin-top: 12px; }
.action-main { flex: 1; margin-right: 12px; }
.action-kicker { font-size: 11px; color: #086CEA; font-weight: 900; }
.action-title { margin-top: 4px; font-size: 15px; color: #111827; font-weight: 900; line-height: 1.35; }
.action-sub { margin-top: 4px; font-size: 12px; color: #6B7280; line-height: 1.5; }
.action-buttons { width: 86px; align-items: stretch; }
.action-primary { height: 30px; border-radius: 8px; background: #086CEA; align-items: center; justify-content: center; }
.action-primary-text { color: #fff; font-size: 12px; font-weight: 900; }
.action-ghost { margin-top: 8px; height: 28px; border-radius: 8px; border: 1px solid #E5E7EB; align-items: center; justify-content: center; }
.action-ghost-text { color: #374151; font-size: 12px; font-weight: 900; }
.decision-archive-note { background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px; padding: 12px 14px; margin-top: 12px; }
.decision-archive-title { font-size: 13px; color: #334155; font-weight: 900; }
.decision-archive-sub { margin-top: 4px; font-size: 11px; color: #64748B; line-height: 1.5; }
.feedback-panel { background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; padding: 14px; margin-top: 12px; }
.feedback-head { flex-direction: row; align-items: center; justify-content: space-between; }
.feedback-titlebox { flex: 1; margin-right: 10px; }
.feedback-kicker { font-size: 11px; color: #15803D; font-weight: 900; }
.feedback-title { margin-top: 4px; font-size: 15px; color: #111827; font-weight: 900; line-height: 1.35; }
.feedback-link { height: 28px; border-radius: 8px; border: 1px solid #BBF7D0; padding: 0 10px; align-items: center; justify-content: center; background: #F0FDF4; }
.feedback-link-text { color: #15803D; font-size: 12px; font-weight: 900; }
.feedback-sync { margin-top: 8px; font-size: 11px; color: #64748B; line-height: 1.45; }
.feedback-track { height: 6px; border-radius: 6px; background: #ECFDF5; margin-top: 12px; overflow: hidden; }
.feedback-fill { height: 6px; border-radius: 6px; background: #16A34A; }
.feedback-grid { flex-direction: row; flex-wrap: wrap; margin-top: 12px; }
.feedback-cell { width: 50%; padding-right: 8px; margin-bottom: 9px; }
.feedback-value { font-size: 16px; color: #111827; font-weight: 900; }
.feedback-label { margin-top: 4px; font-size: 11px; color: #6B7280; font-weight: 900; }
.feedback-sub { margin-top: 3px; font-size: 11px; color: #9CA3AF; line-height: 1.35; }
.advisor-backfill { margin-top: 12px; padding: 11px; border-radius: 8px; background: #F8FAFC; border: 1px solid #E5E7EB; flex-direction: row; align-items: center; }
.advisor-backfill-main { flex: 1; margin-right: 10px; }
.advisor-backfill-title { font-size: 13px; color: #111827; font-weight: 900; }
.advisor-backfill-sub { margin-top: 4px; font-size: 12px; color: #6B7280; line-height: 1.45; }
.advisor-backfill-status { font-size: 11px; color: #15803D; font-weight: 900; padding: 4px 7px; border-radius: 8px; background: #F0FDF4; }
.execution-timeline { margin-top: 12px; padding-top: 12px; border-top: 1px solid #EEF0F4; }
.execution-head { flex-direction: row; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.execution-head-title { font-size: 12px; color: #111827; font-weight: 900; }
.execution-head-count { font-size: 11px; color: #94A3B8; font-weight: 800; }
.execution-row { flex-direction: row; padding: 7px 0; }
.execution-dot { width: 8px; height: 8px; border-radius: 4px; background: #CBD5E1; margin-top: 5px; margin-right: 9px; }
.execution-row-done .execution-dot { background: #16A34A; }
.execution-row-review .execution-dot { background: #F59E0B; }
.execution-row-action .execution-dot { background: #086CEA; }
.execution-row-folded .execution-dot { background: #94A3B8; }
.execution-row-folded .execution-title { color: #64748B; }
.execution-main { flex: 1; }
.execution-line { flex-direction: row; align-items: center; justify-content: space-between; }
.execution-title { flex: 1; margin-right: 8px; font-size: 12px; color: #111827; font-weight: 900; }
.execution-time { font-size: 10px; color: #94A3B8; }
.execution-desc { margin-top: 3px; font-size: 11px; color: #64748B; line-height: 1.45; }

.section-head { flex-direction: row; justify-content: space-between; align-items: center; margin: 18px 2px 10px; }
.section-title { font-size: 16px; font-weight: 900; color: #111827; }
.section-note { font-size: 12px; color: #9CA3AF; }

.state-card { align-items: center; background: #fff; border-radius: 8px; padding: 36px 22px; border: 1px solid #EEF0F4; }
.state-title { font-size: 16px; color: #111827; font-weight: 800; }
.state-sub { margin-top: 8px; font-size: 13px; color: #6B7280; text-align: center; line-height: 1.6; }
.state-btn { margin-top: 18px; padding: 10px 30px; border-radius: 8px; background: #086CEA; box-shadow: 0 10px 22px rgba(8,108,234,0.12); }
.state-btn-text { font-size: 14px; color: #fff; font-weight: 800; }

.debt-card { background: #fff; border-radius: 8px; padding: 15px; margin-bottom: 10px; border: 1px solid #EEF0F4; }
.debt-card-focus { border-color: #93C5FD; background: #F4F8FF; }
.debt-focus-hint { margin-bottom: 10px; padding: 9px 10px; border-radius: 8px; background: #EAF3FF; border: 1px solid #BFDBFE; }
.debt-focus-title { font-size: 12px; color: #086CEA; font-weight: 900; }
.debt-focus-sub { margin-top: 3px; font-size: 11px; color: #1D4ED8; line-height: 1.45; }
.debt-head { flex-direction: row; align-items: flex-start; }
.debt-main { flex: 1; margin-right: 10px; }
.debt-name { font-size: 15px; color: #111827; font-weight: 900; }
.debt-product { margin-top: 3px; font-size: 12px; color: #6B7280; }
.status { padding: 4px 9px; border-radius: 8px; }
.status-ok { background: #F0FDF4; }
.status-bad { background: #FEF2F2; }
.status-done { background: #F1F5F9; }
.status-text { font-size: 12px; font-weight: 800; }
.status-text-ok { color: #16A34A; }
.status-text-bad { color: #DC2626; }
.status-text-done { color: #64748B; }
.amount-row { flex-direction: row; margin-top: 14px; }
.amount-cell { flex: 1; }
.amount-right { align-items: flex-end; }
.amount-label { font-size: 11px; color: #9CA3AF; }
.amount-value { margin-top: 4px; font-size: 15px; color: #111827; font-weight: 800; }
.progress-track { height: 6px; border-radius: 6px; background: #F1F3F6; margin-top: 14px; overflow: hidden; }
.progress-fill { height: 6px; border-radius: 6px; background: #086CEA; }
.progress-fill-archive { background: #94A3B8; }
.progress-fill-medium { background: #F59E0B; }
.progress-fill-low { background: #16A34A; }
.risk-grid { flex-direction: row; margin-bottom: 4px; }
.risk-cell { flex: 1; background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; padding: 12px 8px; align-items: center; margin-right: 8px; }
.risk-cell:last-child { margin-right: 0; }
.risk-cell-high { border-color: #FECACA; }
.risk-cell-medium { border-color: #FDE68A; }
.risk-cell-low { border-color: #BBF7D0; }
.risk-num { font-size: 22px; font-weight: 900; color: #111827; }
.risk-num-high { color: #C62828; }
.risk-num-medium { color: #B45309; }
.risk-num-low { color: #15803D; }
.risk-label { margin-top: 3px; font-size: 12px; color: #374151; font-weight: 900; }
.risk-sub { margin-top: 3px; font-size: 11px; color: #9CA3AF; }
.plan-list { margin-bottom: 4px; }
.plan-card { flex-direction: row; align-items: center; background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; padding: 13px; margin-bottom: 9px; }
.plan-rank { width: 28px; height: 28px; border-radius: 8px; background: #EAF3FF; align-items: center; justify-content: center; margin-right: 10px; }
.plan-rank-text { color: #086CEA; font-size: 13px; font-weight: 900; }
.plan-main { flex: 1; margin-right: 8px; }
.plan-title { font-size: 14px; color: #111827; font-weight: 900; }
.plan-sub { margin-top: 3px; font-size: 11px; color: #9CA3AF; }
.plan-action { margin-top: 5px; font-size: 12px; color: #374151; font-weight: 800; line-height: 1.45; }
.plan-side { align-items: flex-end; max-width: 98px; }
.plan-amount { font-size: 12px; color: #111827; font-weight: 900; text-align: right; }
.plan-risk { margin-top: 6px; font-size: 11px; font-weight: 900; padding: 3px 6px; border-radius: 8px; overflow: hidden; }
.plan-risk-high { color: #C62828; background: #FEF2F2; }
.plan-risk-medium { color: #B45309; background: #FFFBEB; }
.plan-risk-low { color: #15803D; background: #F0FDF4; }
.tip-list { margin-bottom: 4px; }
.tip-card { flex-direction: row; align-items: flex-start; background: #fff; border-radius: 8px; border: 1px solid #EEF0F4; padding: 13px; margin-bottom: 9px; }
.tip-card-danger { border-color: #FECACA; }
.tip-card-warning { border-color: #FDE68A; }
.tip-card-success { border-color: #BBF7D0; }
.tip-dot { width: 8px; height: 8px; border-radius: 4px; background: #CBD5E1; margin-top: 5px; margin-right: 10px; }
.tip-dot-danger { background: #C62828; }
.tip-dot-warning { background: #F59E0B; }
.tip-dot-success { background: #16A34A; }
.tip-main { flex: 1; }
.tip-title { font-size: 14px; color: #111827; font-weight: 900; }
.tip-desc { margin-top: 4px; font-size: 12px; color: #4B5563; line-height: 1.55; }
.tip-effect { margin-top: 4px; font-size: 11px; color: #9CA3AF; line-height: 1.45; }
.debt-foot { flex-direction: row; align-items: center; margin-top: 10px; }
.debt-risk { font-size: 11px; font-weight: 900; padding: 4px 7px; border-radius: 8px; overflow: hidden; margin-right: 8px; }
.debt-risk-high { color: #C62828; background: #FEF2F2; }
.debt-risk-medium { color: #B45309; background: #FFFBEB; }
.debt-risk-low { color: #15803D; background: #F0FDF4; }
.debt-risk-archive { color: #475569; background: #F1F5F9; }
.debt-reason { flex: 1; font-size: 12px; color: #6B7280; line-height: 1.45; }
.debt-execution { margin-top: 10px; padding: 10px; border-radius: 8px; background: #F8FAFC; border: 1px solid #E5E7EB; flex-direction: row; align-items: center; }
.debt-execution-main { flex: 1; margin-right: 8px; }
.debt-execution-title { font-size: 12px; color: #111827; font-weight: 900; }
.debt-execution-sub { margin-top: 3px; font-size: 11px; color: #6B7280; line-height: 1.35; }
.debt-execution-status { font-size: 11px; color: #15803D; font-weight: 900; padding: 3px 6px; border-radius: 8px; background: #F0FDF4; }
.debt-execution-status-review { color: #B45309; background: #FFFBEB; }
.debt-execution-status-rejected { color: #C62828; background: #FEF2F2; }
.debt-execution-status-handled { color: #374151; background: #F3F4F6; }
.debt-actions { flex-direction: row; margin-top: 12px; }
.debt-action { flex: 1; min-width: 0; height: 34px; border-radius: 8px; background: #086CEA; align-items: center; justify-content: center; }
.debt-action + .debt-action { margin-left: 6px; }
.debt-action-soft { background: #F9FAFB; border: 1px solid #E5E7EB; }
.debt-action-text { color: #374151; font-size: 12px; font-weight: 900; }
.debt-action-primary-text { color: #fff; font-size: 12px; font-weight: 900; }
.bottom-safe { height: 44px; }

/* ── 桌面端限宽微调 ≥1024px ── */
@media (min-width: 1024px) {
  .wrap { padding: 20px 24px; }
  .summary-card { padding: 20px; }
  .risk-grid { margin-bottom: 8px; }
}
</style>
