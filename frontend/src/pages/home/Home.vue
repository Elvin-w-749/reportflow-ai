<template>
	<view class="page rpt-page" :style="pageToneStyle">
		<view class="status-bar" :style="{ height: topSafeH + 'px' }"></view>

		<scroll-view class="scroll-body" scroll-y>
			<view class="home-shell rpt-content-max">
				<view class="home-col-left">
				<view class="score-stage">
					<view class="orbit-node orbit-top">
						<view class="orbit-badge orbit-badge-blue"><text class="orbit-icon">✓</text></view>
						<text class="orbit-text">履约能力</text>
					</view>
					<view class="orbit-node orbit-left-top" @click="hasReport ? goReportManage() : goUpload()">
						<view class="orbit-badge orbit-badge-cyan"><text class="orbit-icon">▤</text></view>
						<text class="orbit-text">历史记录</text>
					</view>
					<view class="orbit-node orbit-right-top" @click="hasReport ? goReportSection('risk') : goUpload()">
						<view class="orbit-badge orbit-badge-teal"><text class="orbit-icon">●</text></view>
						<text class="orbit-text">信用行为</text>
					</view>
					<view class="orbit-node orbit-left-bottom" @click="hasReport ? goDebtManage() : goUpload()">
						<view class="orbit-badge orbit-badge-purple"><text class="orbit-icon">◔</text></view>
						<text class="orbit-text">负债情况</text>
					</view>
					<view class="orbit-node orbit-right-bottom" @click="hasReport ? goReportSection('query', { queryWindow: '6m' }) : goUpload()">
						<view class="orbit-badge orbit-badge-orange"><text class="orbit-icon">⌕</text></view>
						<text class="orbit-text">查询记录</text>
					</view>

					<view class="score-meter" :style="scoreRingStyle" @click="hasReport ? goReportSection('score') : goUpload()">
						<view class="score-meter-inner">
							<text class="score-label">信用分</text>
							<text class="score-value" :style="{ color: scoreToneColor }">{{ scoreDisplay }}</text>
							<view class="score-pill" :style="{ backgroundColor: scoreToneSoft }">
								<text class="score-pill-text" :style="{ color: scoreToneColor }">{{ scoreBandLabel }}</text>
							</view>
						</view>
					</view>
				</view>

				<view class="hero-copy">
					<text class="hero-title">{{ priorityTitle }}</text>
					<text class="hero-sub">{{ priorityDesc }}</text>
				</view>

				<view class="action-row">
					<view class="action-primary" @click="handlePriorityAction">
						<view class="action-shield"><text class="action-shield-text">ϟ</text></view>
						<view class="action-copy">
							<text class="action-title">{{ priorityBtnText }}</text>
							<text class="action-sub">{{ primaryActionSub }}</text>
						</view>
					</view>
					<view class="action-secondary" @click="goAdvisor">
						<text class="advisor-icon">☏</text>
						<view class="advisor-copy">
							<text class="advisor-title">咨询顾问</text>
							<text class="advisor-sub">专业解答信用问题</text>
						</view>
					</view>
				</view>

				</view><!-- /home-col-left -->

				<view class="home-col-right">
				<view class="metric-strip">
					<view class="metric-item" @click="hasReport ? goReportSection('debt') : goUpload()">
						<view class="metric-icon metric-icon-blue"><text class="metric-icon-text">≋</text></view>
						<view class="metric-copy">
							<text class="metric-label">总债务笔数</text>
							<text class="metric-value">{{ hasDebtEvidence && debtCount != null ? debtCount : '--' }}</text>
						</view>
						<RptChevron class="metric-arrow" direction="right" />
					</view>
					<view class="metric-divider"></view>
					<view class="metric-item" @click="hasReport ? goReportSection('accounts', { accountFilter: 'abnormal' }) : goUpload()">
						<view class="metric-icon metric-icon-green"><text class="metric-icon-text">●</text></view>
						<view class="metric-copy">
							<text class="metric-label">逾期账户</text>
							<text class="metric-value" :class="{ 'metric-danger': overdueCount > 0 }">{{ hasOverdueEvidence ? overdueCount : '--' }}</text>
						</view>
						<RptChevron class="metric-arrow" direction="right" />
					</view>
					<view class="metric-divider"></view>
					<view class="metric-item" @click="hasReport ? goReportSection('query', { queryWindow: '6m' }) : goUpload()">
						<view class="metric-icon metric-icon-violet"><text class="metric-icon-text">⌕</text></view>
						<view class="metric-copy">
							<text class="metric-label">近6月查询</text>
							<text class="metric-value" :class="{ 'metric-danger': query6mCount > ACTION_THRESHOLDS.QUERY6M_ADVISOR }">{{ hasQueryEvidence ? query6mCount : '--' }}</text>
						</view>
						<RptChevron class="metric-arrow" direction="right" />
					</view>
				</view>

				<view class="repay-card" @click="goRepaymentReminder">
					<view class="repay-head">
						<view class="repay-icon"><text class="repay-icon-text">日</text></view>
						<view class="repay-main">
							<view class="repay-title-row">
								<text class="repay-title">{{ repayTitle }}</text>
								<text class="repay-status" :class="repayStatusClass">{{ repayReminderStatusText }}</text>
							</view>
							<text class="repay-sub">{{ repaySub }}</text>
						</view>
						<view class="repay-side">
							<text class="repay-amount">{{ repaySummary.monthDueText }}</text>
							<view class="repay-link">
								<text class="repay-link-text">设置</text>
								<RptChevron class="repay-link-arrow" direction="right" />
							</view>
						</view>
					</view>
					<view class="repay-foot">
						<text class="repay-next">{{ repayNextText }}</text>
						<text class="repay-consent">{{ repayConsentText }}</text>
					</view>
				</view>

				<view class="path-card">
					<view class="section-head">
						<text class="section-title">行动路径</text>
						<text class="section-note">{{ priorityHint }}</text>
					</view>
					<view class="path-flow">
						<view class="path-step" :class="{ 'path-step-on': homeActionKey === 'upload' || hasReport }" @click="goUpload">
							<view class="path-icon-wrap path-blue">
								<text class="path-num">1</text>
								<text class="path-icon">⇧</text>
							</view>
							<text class="path-title">上传报告</text>
							<text class="path-desc">清晰截图或 PDF</text>
						</view>
						<view class="path-dash"></view>
						<view class="path-step" :class="{ 'path-step-on': hasReport }" @click="hasReport ? goReport() : goUpload()">
							<view class="path-icon-wrap path-green">
								<text class="path-num">2</text>
								<text class="path-icon">▧</text>
							</view>
							<text class="path-title">查看画像</text>
							<text class="path-desc">评分与风险项</text>
						</view>
						<view class="path-dash"></view>
						<view class="path-step" :class="{ 'path-step-on': homeActionKey === 'match' }" @click="handleMatchStep">
							<view class="path-icon-wrap path-yellow">
								<text class="path-num">3</text>
								<text class="path-icon">▣</text>
							</view>
							<text class="path-title">匹配方案</text>
							<text class="path-desc">材料齐全后开放</text>
						</view>
					</view>
				</view>
				</view><!-- /home-col-right -->

				<view class="recent-section">
					<view class="section-head section-head-row">
						<view>
							<text class="section-title">{{ hasReport ? '最近债务' : '信用建档' }}</text>
							<text class="section-note">{{ hasReport ? '用于快速判断还款压力' : '上传报告后生成信用画像和方案建议' }}</text>
						</view>
						<view class="section-link" @click="hasReport ? goDebtManage() : goUpload()">
							<text class="section-link-text">{{ hasReport ? '全部' : '上传' }}</text>
							<RptChevron class="section-link-arrow" direction="right" />
						</view>
					</view>

					<view v-if="hasReport && debtList.length > 0">
						<view class="debt-item" v-for="(item, i) in debtList" :key="item.key || i" @click="goDebtItem(item)">
							<view class="debt-marker" :class="{ 'debt-marker-danger': item.isOverdue }"></view>
							<view class="debt-icon"><text class="debt-icon-text">▤</text></view>
							<view class="debt-main">
								<text class="debt-name">{{ item.name }}</text>
								<text class="debt-tag" :style="{ color: item.tagColor }">{{ item.tag }}</text>
							</view>
							<view class="debt-amount-col">
								<text class="debt-amount" :class="{ 'debt-amount-danger': item.isOverdue }">{{ item.amount }}</text>
								<text class="debt-amount-label">应还金额</text>
							</view>
							<RptChevron class="debt-arrow" direction="right" />
						</view>
					</view>
					<view v-else class="debt-item debt-empty" @click="hasReport ? goDebtManage() : goUpload()">
						<view class="debt-marker"></view>
						<view class="debt-icon"><text class="debt-icon-text">↑</text></view>
						<view class="debt-main">
							<text class="debt-name">{{ hasReport ? recentDebtEmptyTitle : '先完成一次信用建档' }}</text>
							<text class="debt-tag debt-tag-muted">{{ hasReport ? recentDebtEmptySub : '支持 JPG、PNG、PDF，优先上传清晰报告。' }}</text>
						</view>
						<RptChevron class="debt-arrow" direction="right" />
					</view>
				</view>

				<view class="trust-note">
					<text class="trust-text">仅用于信用分析，实际审批以金融机构审核为准。</text>
				</view>
				<view class="bottom-safe rpt-page-bottom"></view>
			</view>
		</scroll-view>
		</view>
	</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { onShow } from '@/compat/web-lifecycle.js'
import {
	getLatestReportAsync,
	cleanInvalidReports,
	hasMeaningfulAnalysisData,
	migrateLegacyReportBodiesToCloud,
	normalizeReportData
} from '@/services/reportStorage.js'
import { clearMatchReportContext } from '@/services/reportMatchContext.js'
import { resolveV6ScoreDetails } from '@/services/scoreV6.js'
import { decisionReportIdOf, normalizeDecisionReportId } from '@/services/decisionTrust.js'
import { resolveDecisionTotalDebt } from '@/services/decisionMetrics.js'
import { isLoggedIn } from '@/services/authService.js'
import { createCustomerServiceContact, openAdvisorConversation } from '@/services/profileService.js'
import { buildRepaymentReminderSummary } from '@/services/repaymentReminderService.js'
import { debtAccountsFromAnalysis, debtBalanceOf, debtEvidenceConflictCopy, debtNavigationKey, resolveHomeDebtDisplay } from '@/services/debtSummary.js'
import RptChevron from '@/components/RptChevron.vue'
import {
	ACTION_KEYS,
	ACTION_THRESHOLDS,
	resolveActionKey,
	resolveHighRiskMetric,
	resolveQuery6mMetric,
	resolveOverdueAccountMetric
} from '@/services/actionPolicy.js'
import safeSwitchTab from '@/utils/safeSwitchTab.js'
import { getWindowLayoutSync } from '@/utils/windowMetrics.js'
import { statusIndicatesAbnormal, statusIndicatesOverdue } from '@/utils/creditStatus.js'
import { strictNonNegativeNumberOrNull } from '@/utils/strictNumber.js'
import { getRiskMeta, getScoreColor } from '@/config/riskLevel.js'

const statusBarH = ref(0)

const hasReport    = ref(false)
const hasScore     = ref(false)
const hasDebtEvidence = ref(false)
const hasOverdueEvidence = ref(false)
const hasQueryEvidence = ref(false)
const hasHighRiskEvidence = ref(false)
const displayScore = ref(null)
const reportRiskLevel = ref('unknown')
const debtCount    = ref(null)
const totalDebtValue = ref(null)
const overdueCount = ref(null)
const highRiskCount = ref(null)
const query6mCount = ref(null)
const debtList     = ref([])
const debtConflictReason = ref('')
const latestReportId = ref('')
const advisorChatSubmitting = ref(false)
const repaySummary = ref(buildRepaymentReminderSummary(null))

const topSafeH = computed(() => Math.max(statusBarH.value || 0, 48))
const displayScoreNumber = computed(() => strictNonNegativeNumberOrNull(displayScore.value))
const scoreDisplay = computed(() => hasScore.value && displayScoreNumber.value != null ? Math.round(displayScoreNumber.value) : '--')
const scoreToneColor = computed(() => hasScore.value ? getScoreColor(displayScore.value) : '#9AA7BA')
const scoreToneSoft = computed(() => {
	if (!hasScore.value) return '#EEF3FA'
	const score = displayScoreNumber.value ?? 0
	if (score < 50) return '#FFE9ED'
	if (score <= 70) return '#FFF5D8'
	return '#EAF3FF'
})
const scoreBandLabel = computed(() => {
	return hasScore.value ? getRiskMeta(reportRiskLevel.value).creditLabel : '待评估'
})
const scoreProgress = computed(() => {
	if (!hasScore.value) return 18
	const score = displayScoreNumber.value ?? 0
	return Math.max(8, Math.min(100, score))
})
const scoreRingStyle = computed(() => ({
	background: `conic-gradient(${scoreToneColor.value} ${scoreProgress.value * 3.6}deg, rgba(218, 229, 244, 0.62) ${scoreProgress.value * 3.6}deg 360deg)`,
	boxShadow: `0 18px 44px ${scoreToneSoft.value}, inset 0 0 0 1px rgba(255,255,255,0.86)`
}))
const pageToneStyle = computed(() => ({
	'--home-score-color': scoreToneColor.value,
	'--home-score-soft': scoreToneSoft.value
}))

const homeActionKey = computed(() => {
	if (hasReport.value && !hasScore.value) return ACTION_KEYS.UPLOAD
	return resolveActionKey({
		hasReport: hasReport.value,
		score: hasScore.value ? displayScore.value : null,
		highRiskCount: highRiskCount.value,
		overdueAccountCount: overdueCount.value,
		query6mCount: query6mCount.value,
		scoreKnown: hasScore.value,
		highRiskKnown: hasHighRiskEvidence.value,
		overdueKnown: hasOverdueEvidence.value,
		queryKnown: hasQueryEvidence.value
	})
})

const priorityTitle = computed(() => {
	if (!hasReport.value) return '上传信用报告，生成画像'
	return '更新信用报告，刷新评估'
})

const priorityDesc = computed(() => {
	if (!hasReport.value) return '支持 PDF 或多张截图，先完成建档再看风险与方案'
	return '报告更新后重新上传，系统会同步刷新信用分、负债和查询记录'
})

const priorityBtnText = computed(() => {
	return hasReport.value ? '更新报告' : '上传报告'
})

const primaryActionSub = computed(() => {
	return hasReport.value ? '刷新信用画像' : 'PDF 或多张截图'
})

const priorityHint = computed(() => {
	if (homeActionKey.value === 'upload') return hasReport.value
		? '当前报告暂无可信评分，重新上传清晰完整报告后再生成建议'
		: '首次建档后，系统将自动生成后续行动建议'
	if (homeActionKey.value === 'risk-fix') return '先修复后申请，可减少无效操作和时间成本'
	if (homeActionKey.value === 'advisor') return '先规划申请顺序，再进入匹配更稳妥'
	return '材料齐全后再看产品，减少无效申请和新增查询'
})
const repayTitle = computed(() => {
	const conflict = debtEvidenceConflictCopy(repaySummary.value.reportConflictReason)
	if (repaySummary.value.reportArchiveConflict && conflict) return `还款提醒：${conflict.title}`
	if (!repaySummary.value.reportAmountEvidenceKnown && repaySummary.value.manualCount) return '还款提醒：手工提醒已设置，报告账单待核对'
	if (repaySummary.value.overdue && repaySummary.value.overdue.length) return '还款提醒：先处理过期账单'
	if (repaySummary.value.upcoming && repaySummary.value.upcoming.length) return '还款提醒：近期有账单'
	if (!repaySummary.value.reportAmountEvidenceKnown && !repaySummary.value.manualCount) return '还款提醒：账单待核对'
	return '还款提醒：保持节奏'
})
const repaySub = computed(() => {
	if (repaySummary.value.reportArchiveConflict) {
		return debtEvidenceConflictCopy(repaySummary.value.reportConflictReason)?.detail || '报告账单与服务端总额存在冲突，待核对'
	}
	if (!repaySummary.value.reportAmountEvidenceKnown && repaySummary.value.manualCount) return `已设置 ${repaySummary.value.manualCount} 项手工提醒；报告应还金额仍待核对`
	if (!repaySummary.value.reportAmountEvidenceKnown) return '报告未提供完整应还金额，未按 ¥0 处理'
	if (repaySummary.value.overdue && repaySummary.value.overdue.length) return `${repaySummary.value.overdue.length} 项已过期，建议优先核对并处理`
	if (repaySummary.value.upcoming && repaySummary.value.upcoming.length) return `未来 7 天 ${repaySummary.value.upcoming.length} 项，提前安排现金流`
	if (repaySummary.value.manualCount) return `已设置 ${repaySummary.value.manualCount} 项单笔提醒`
	return '设置还款日，避免账单遗漏'
})
const repayReminderStatusText = computed(() => {
	if (repaySummary.value.smsReady) return '短信已开'
	if (repaySummary.value.setting && repaySummary.value.setting.enabled) return '应用提醒'
	return '未开启'
})
const repayStatusClass = computed(() => ({
	'repay-status-ready': !!repaySummary.value.smsReady,
	'repay-status-browser': !!(repaySummary.value.setting && repaySummary.value.setting.enabled && !repaySummary.value.smsReady),
	'repay-status-off': !(repaySummary.value.setting && repaySummary.value.setting.enabled)
}))
const repayNextText = computed(() => {
	const item = repaySummary.value.nextItem
	if (!item) return repaySummary.value.reportAmountEvidenceKnown
		? '当前没有可展示的临近账单'
		: '账单金额或还款日待核对'
	return `${item.title || '还款账单'} · ${item.dueText || item.dueDate || '待补还款日'}`
})
const recentDebtEmptyTitle = computed(() => {
	const conflict = debtEvidenceConflictCopy(debtConflictReason.value)
	if (conflict) return conflict.title
	if (!hasDebtEvidence.value) return '债务数据待核对'
	if (totalDebtValue.value === 0) return '已核验暂无未结清债务'
	return '债务明细待核对'
})
const recentDebtEmptySub = computed(() => {
	const conflict = debtEvidenceConflictCopy(debtConflictReason.value)
	if (conflict) return conflict.detail
	if (!hasDebtEvidence.value) return '当前报告缺少已核验债务总额，请重新上传清晰完整报告。'
	if (totalDebtValue.value === 0) return '服务端证据明确确认当前负债为 0。'
	return '服务端已确认存在债务，但账户余额或状态明细尚不完整。'
})
const repayConsentText = computed(() => {
	if (repaySummary.value.smsReady) return '已同意短信提醒条例'
	if (repaySummary.value.setting && repaySummary.value.setting.smsConsentAccepted) return '短信提醒已关闭'
	return '阅读条例后可开启短信提醒'
})

const firstAccountValue = (...values) => values.find((value) => value !== undefined && value !== null && value !== '')
const accountNumber = (...values) => {
	for (const value of values) {
		const parsed = strictNonNegativeNumberOrNull(value)
		if (parsed != null) return parsed
	}
	return null
}
const isCardAccount = (account = {}) => {
	const product = String(firstAccountValue(account.accountType, account.account_type, account.type, account.cardType, account.card_type, account.productName, account.product, ''))
	return account.isLoan === false || /信用卡|贷记卡|card/i.test(product)
}
const resolveHomeMetricEvidence = (rd, normalized, decisionTrust = null, expectedReportId = '') => {
	if (!hasMeaningfulAnalysisData(rd)) {
		return {
			debt: false,
			debtValue: null,
			overdue: false,
			query: false,
			highRisk: false,
			overdueValue: null,
			queryValue: null,
			highRiskValue: null
		}
	}
	const debtMetric = resolveDecisionTotalDebt(rd, decisionTrust, expectedReportId)
	const overdueMetric = resolveOverdueAccountMetric(rd, decisionTrust, expectedReportId)
	const queryMetric = resolveQuery6mMetric(rd, decisionTrust, expectedReportId)
	const highRiskMetric = resolveHighRiskMetric(rd, decisionTrust, expectedReportId)
	return {
		debt: debtMetric.known,
		debtValue: debtMetric.value,
		overdue: overdueMetric.known,
		query: queryMetric.known,
		highRisk: highRiskMetric.known,
		overdueValue: overdueMetric.value,
		queryValue: queryMetric.value,
		highRiskValue: highRiskMetric.value
	}
}

const loadData = async () => {
	try {
		const report = await getLatestReportAsync()
		repaySummary.value = buildRepaymentReminderSummary(report || null)
		const rd = report?.analysisData
		if (!report) {
			latestReportId.value = ''
			hasReport.value = false
			hasScore.value = false
			hasDebtEvidence.value = false
			hasOverdueEvidence.value = false
			hasQueryEvidence.value = false
			hasHighRiskEvidence.value = false
			displayScore.value = null
			reportRiskLevel.value = 'unknown'
			debtCount.value = null
			totalDebtValue.value = null
			overdueCount.value = null
			highRiskCount.value = null
			query6mCount.value = null
			debtList.value = []
			debtConflictReason.value = ''
			return
		}
		latestReportId.value = normalizeDecisionReportId(report.id)
		hasReport.value = true
		const decisionTrust = report.decisionTrust || null
		const expectedReportId = decisionReportIdOf(report)
		const normalized = normalizeReportData(rd, decisionTrust, expectedReportId)
		const metricEvidence = resolveHomeMetricEvidence(rd, normalized, decisionTrust, expectedReportId)
		hasDebtEvidence.value = metricEvidence.debt
		totalDebtValue.value = metricEvidence.debtValue
		hasOverdueEvidence.value = metricEvidence.overdue
		hasQueryEvidence.value = metricEvidence.query
		hasHighRiskEvidence.value = metricEvidence.highRisk
		const scoreResolution = resolveV6ScoreDetails(rd, decisionTrust, expectedReportId)
		const validScore = scoreResolution.decisionEligible === true ? scoreResolution.score : null
		hasScore.value = validScore != null
		displayScore.value = validScore == null ? null : Number(validScore)
		reportRiskLevel.value = normalized.riskLevel || 'unknown'
		highRiskCount.value = metricEvidence.highRiskValue
		query6mCount.value = metricEvidence.queryValue
		debtCount.value = metricEvidence.debtValue === 0 ? 0 : null
		overdueCount.value = metricEvidence.overdueValue
		debtList.value = []
		debtConflictReason.value = ''
		if (!rd) return
		setTimeout(() => {
			try {
				const accounts = debtAccountsFromAnalysis(rd, normalized.creditAccounts)
				const debtDisplay = resolveHomeDebtDisplay(totalDebtValue.value, accounts)
				debtCount.value = debtDisplay.debtCountKnown ? debtDisplay.debtCount : null
				debtConflictReason.value = debtDisplay.conflictReason
				if (Array.isArray(accounts) && accounts.length > 0) {
					const currentAccounts = debtDisplay.rows
					debtList.value = currentAccounts.slice(0, 3).map(({ account: acc, sourceIndex }, index) => {
						const days = accountNumber(acc.overdueDays, acc.overdue_days, acc.maxOverdueDays)
						const status = String(firstAccountValue(acc.status, acc.accountStatus, acc.account_status, ''))
						const isOv = acc.isOverdue === true || days > 0 || statusIndicatesOverdue(status)
						const isOtherAbnormal = !isOv && statusIndicatesAbnormal(status)
						const normalStatus = /正常|未逾期|无逾期|从未逾期|按时|良好/.test(status) && !isOtherAbnormal
						const balance = debtBalanceOf(acc)
						const card = isCardAccount(acc)
						const debtId = firstAccountValue(acc._id, acc.id, acc.accountId, acc.account_id, '')
						return {
							key: debtId || `home_debt_${index}_${firstAccountValue(acc.name, acc.institution, 'account')}`,
							name: acc.name || acc.institution || '信贷账户',
							tag: isOv ? (days != null ? `逾期 ${days} 天` : '逾期待核对') : isOtherAbnormal ? status : normalStatus ? '正常还款' : '状态待核对',
							tagColor: isOv || isOtherAbnormal ? '#F44336' : normalStatus ? '#4CAF50' : '#64748B',
							amount: balance > 0 ? `¥${Number(balance).toLocaleString()}` : '--',
							isOverdue: isOv,
							debtId: debtId ? String(debtId) : '',
							debtKey: debtNavigationKey(acc, sourceIndex),
							accountFilter: isOv ? 'abnormal' : (card ? 'card' : 'loan')
						}
					})
				} else {
					debtList.value = []
				}
			} catch (e) {
				console.warn('[home] 加载债务明细失败', e.message)
			}
		}, 0)
	} catch (e) {
		console.warn('[home] 加载数据失败', e.message)
		hasReport.value = false
		hasScore.value = false
		hasDebtEvidence.value = false
		hasOverdueEvidence.value = false
		hasQueryEvidence.value = false
		hasHighRiskEvidence.value = false
		reportRiskLevel.value = 'unknown'
		highRiskCount.value = null
		query6mCount.value = null
		debtCount.value = null
		totalDebtValue.value = null
		overdueCount.value = null
		debtConflictReason.value = ''
	}
}

const _homeMounted = ref(false)
onShow(() => {
	if (_homeMounted.value) {
		void migrateLegacyReportBodiesToCloud({ limit: 2 })
		loadData()
	}
})

onMounted(() => {
	const sys = getWindowLayoutSync()
	statusBarH.value = sys.statusBarHeight || 0
	cleanInvalidReports()
	void migrateLegacyReportBodiesToCloud({ limit: 2 })
	_homeMounted.value = true
	loadData()
})

const handlePriorityAction = () => {
	goUpload()
}

const goUpload = () => {
	uni.navigateTo({ url: '/pages/report/upload', fail: () => { uni.showToast({ title: '无法打开上传页', icon: 'none' }) } })
}
const goMatch       = () => { clearMatchReportContext(); safeSwitchTab('/pages/match/index') }
const handleMatchStep = () => {
	if (homeActionKey.value === ACTION_KEYS.MATCH && hasScore.value) {
		goMatch()
		return
	}
	if (homeActionKey.value === ACTION_KEYS.UPLOAD || !hasScore.value) {
		goUpload()
		return
	}
	goAdvisor()
}
const HOME_REPORT_SECTIONS = new Set(['profile', 'risk', 'score', 'debt', 'query', 'accounts'])
const HOME_ACCOUNT_FILTERS = new Set(['all', 'active', 'loan', 'card', 'abnormal', 'highUsage', 'largeBalance', 'nonbank', 'settled'])
const HOME_QUERY_WINDOWS = new Set(['1m', '3m', '6m', '12m'])
const goReportSection = (section = 'profile', options = {}) => {
	if (!hasReport.value) {
		goUpload()
		return
	}
	const safeSection = HOME_REPORT_SECTIONS.has(section) ? section : 'profile'
	const query = [
		latestReportId.value ? `id=${encodeURIComponent(latestReportId.value)}` : '',
		'from=home',
		`section=${encodeURIComponent(safeSection)}`
	]
	if (HOME_ACCOUNT_FILTERS.has(options.accountFilter)) query.push(`accountFilter=${encodeURIComponent(options.accountFilter)}`)
	if (HOME_QUERY_WINDOWS.has(options.queryWindow)) query.push(`queryWindow=${encodeURIComponent(options.queryWindow)}`)
	uni.navigateTo({
		url: `/pages/report/detail?${query.filter(Boolean).join('&')}`,
		fail: () => { uni.showToast({ title: '无法打开报告页', icon: 'none' }) }
	})
}
const goReport      = () => goReportSection('profile')
const goReportManage = () => uni.navigateTo({ url: '/pages/report/manage', fail: () => { uni.showToast({ title: '无法打开报告管理页', icon: 'none' }) } })
const goDebtManage  = (debtId = '', debtKey = '') => {
	const safeDebtId = typeof debtId === 'string' || typeof debtId === 'number' ? String(debtId) : ''
	const safeDebtKey = typeof debtKey === 'string' ? debtKey : ''
	const queryParts = [
		latestReportId.value ? `reportId=${encodeURIComponent(latestReportId.value)}` : '',
		'from=home',
		safeDebtId ? `debtId=${encodeURIComponent(safeDebtId)}` : '',
		safeDebtKey ? `debtKey=${encodeURIComponent(safeDebtKey)}` : ''
	].filter(Boolean)
	const query = queryParts.length ? `?${queryParts.join('&')}` : ''
	uni.navigateTo({ url: `/pages/profile/debt-manage${query}`, fail: () => { uni.showToast({ title: '无法打开债务管理页', icon: 'none' }) } })
}
const goDebtItem = (item = {}) => {
	if (item.debtId || item.debtKey) {
		goDebtManage(item.debtId, item.debtKey)
		return
	}
	goReportSection('accounts', { accountFilter: item.accountFilter || 'active' })
}
const goRepaymentReminder = () => {
	uni.navigateTo({ url: '/pages/profile/repayment-reminder', fail: () => { uni.showToast({ title: '无法打开还款提醒页', icon: 'none' }) } })
}
const goAdvisor = async () => {
	if (advisorChatSubmitting.value) return
	if (!isLoggedIn()) {
		uni.navigateTo({ url: '/pages/login/index', fail: () => { uni.showToast({ title: '请先登录', icon: 'none' }) } })
		return
	}
	advisorChatSubmitting.value = true
	try {
		const response = await createCustomerServiceContact({
			source: 'home-advisor',
			contactIntent: 'advisor-chat',
			reportId: latestReportId.value,
			summary: '用户发起顾问文字咨询',
			initialMessage: '我想咨询信用问题，请客服协助。',
			createdAt: new Date().toISOString()
		})
		await openAdvisorConversation(response)
	} catch (e) {
		uni.showToast({ title: e && e.message ? e.message : '顾问会话创建失败', icon: 'none' })
	} finally {
		advisorChatSubmitting.value = false
	}
}
</script>

<style scoped>
.page { min-height: 100vh; min-height: 100dvh; height: 100vh; height: 100dvh; background: #F3F7FF; flex-direction: column; overflow: hidden; }
	.status-bar { background: #EAF3FF; flex-shrink: 0; }
.scroll-body { flex: 1; min-height: 0; height: auto; background: linear-gradient(180deg, #F6F9FF 0%, #F2F6FF 58%, #F8FAFF 100%); -webkit-overflow-scrolling: touch; }
.home-shell { position: relative; padding: 0 14px 0; }

	.score-stage { height: 286px; align-items: center; justify-content: center; }
	.score-meter { width: 190px; height: 190px; border-radius: 50%; padding: 13px; align-items: center; justify-content: center; transform: translateY(10px); }
.score-meter::before { content: ""; position: absolute; inset: 7px; border-radius: 50%; border: 1px solid rgba(209, 222, 242, 0.58); }
.score-meter::after { content: ""; position: absolute; left: 25px; bottom: 24px; width: 56px; height: 36px; border-bottom: 2px dotted var(--home-score-color); border-radius: 0 0 0 38px; opacity: 0.45; }
	.score-meter-inner { width: 162px; height: 162px; border-radius: 50%; background: linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(248,251,255,0.98) 100%); align-items: center; justify-content: center; box-shadow: inset 0 0 30px rgba(220, 231, 247, 0.62), 0 12px 28px rgba(26, 65, 120, 0.08); }
.score-label { font-size: 17px; color: #071B3D; line-height: 22px; }
.score-value { margin-top: 1px; font-size: 58px; font-weight: 900; line-height: 64px; letter-spacing: 0; text-align: center; }
.score-pill { margin-top: 6px; min-width: 88px; height: 30px; padding: 0 12px; border-radius: 15px; align-items: center; justify-content: center; }
.score-pill-text { font-size: 15px; font-weight: 900; line-height: 20px; text-align: center; }
.orbit-node { position: absolute; align-items: center; min-width: 70px; }
.orbit-top { top: 0; left: 50%; transform: translateX(-50%); }
.orbit-left-top { left: 14px; top: 72px; }
.orbit-right-top { right: 10px; top: 76px; }
.orbit-left-bottom { left: 22px; bottom: 37px; }
.orbit-right-bottom { right: 20px; bottom: 37px; }
.orbit-badge { width: 42px; height: 42px; border-radius: 50%; background: #fff; align-items: center; justify-content: center; box-shadow: 0 10px 26px rgba(48, 87, 140, 0.13); border: 1px solid rgba(231, 238, 248, 0.92); }
.orbit-badge-blue { color: #0B7BFF; }
.orbit-badge-cyan { color: #1188F0; }
.orbit-badge-teal { color: #20D0C3; }
.orbit-badge-purple { color: #7C3AED; }
.orbit-badge-orange { color: #F47A2F; }
.orbit-icon { font-size: 21px; font-weight: 900; line-height: 23px; color: currentColor; text-align: center; }
.orbit-text { margin-top: 5px; font-size: 11px; color: #071B3D; line-height: 15px; text-align: center; white-space: nowrap; }

.hero-copy { margin-top: -4px; align-items: center; }
.hero-title { font-size: 24px; color: #071B3D; font-weight: 900; line-height: 31px; text-align: center; }
.hero-sub { margin-top: 4px; font-size: 13px; color: #6D7A90; line-height: 18px; text-align: center; }

.action-row { margin-top: 18px; flex-direction: row; align-items: stretch; }
.action-primary, .action-secondary { height: 62px; border-radius: 8px; flex-direction: row; align-items: center; justify-content: center; }
	.action-primary { flex: 1; margin-right: 10px; background: linear-gradient(135deg, #2EA0FF 0%, #086CEA 58%, #0759C7 100%); box-shadow: 0 14px 28px rgba(8, 108, 234, 0.22); }
	.action-secondary { width: 164px; background: linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(248,251,255,0.98) 100%); border: 1px solid #DCE7F6; box-shadow: 0 10px 24px rgba(25, 58, 109, 0.08); }
.action-shield { width: 38px; height: 38px; border-radius: 8px; border: 2px solid rgba(255,255,255,0.8); align-items: center; justify-content: center; margin-right: 10px; }
.action-shield-text { color: #fff; font-size: 25px; font-weight: 900; line-height: 28px; }
.action-copy, .advisor-copy { min-width: 0; }
.action-title { color: #fff; font-size: 18px; font-weight: 900; line-height: 23px; }
.action-sub { margin-top: 1px; color: rgba(255,255,255,0.82); font-size: 11px; line-height: 15px; }
.advisor-icon { font-size: 25px; color: #086CEA; font-weight: 900; line-height: 28px; margin-right: 8px; }
.advisor-title { font-size: 17px; font-weight: 900; color: #071B3D; line-height: 22px; }
.advisor-sub { margin-top: 1px; color: #6D7A90; font-size: 11px; line-height: 15px; }

.metric-strip { margin-top: 16px; min-height: 78px; border-radius: 8px; background: rgba(255,255,255,0.96); border: 1px solid rgba(231, 238, 248, 0.92); box-shadow: 0 10px 24px rgba(28, 62, 114, 0.08); flex-direction: row; align-items: center; padding: 10px 8px; }
.metric-item { flex: 1; min-width: 0; flex-direction: row; align-items: center; justify-content: center; }
.metric-divider { width: 1px; height: 42px; background: #E7EDF6; }
.metric-icon { width: 36px; height: 36px; border-radius: 50%; align-items: center; justify-content: center; margin-right: 6px; flex-shrink: 0; }
.metric-icon-blue { background: #EAF4FF; color: #0A7BF5; }
.metric-icon-green { background: #EAFBF0; color: #22C55E; }
.metric-icon-violet { background: #F0EBFF; color: #7357D9; }
.metric-icon-text { color: currentColor; font-size: 20px; font-weight: 900; line-height: 22px; text-align: center; }
.metric-copy { min-width: 0; }
.metric-label { font-size: 11px; color: #606D82; line-height: 15px; white-space: nowrap; }
.metric-value { margin-top: 2px; font-size: 24px; font-weight: 900; color: #071B3D; line-height: 28px; }
.metric-danger { color: #F43F5E; }
.metric-arrow { width: 20px; height: 20px; color: #A9B4C5; margin-left: 2px; }

.repay-card { margin-top: 12px; min-height: 100px; border-radius: 8px; background: linear-gradient(180deg, #FFFFFF 0%, #F4F8FF 100%); border: 1px solid #DCEBFF; box-shadow: 0 10px 22px rgba(28, 62, 114, 0.07); padding: 12px; }
.repay-head { flex-direction: row; align-items: center; }
.repay-icon { width: 42px; height: 42px; border-radius: 8px; background: #EAF3FF; border: 1px solid #BFDBFE; align-items: center; justify-content: center; margin-right: 10px; }
.repay-icon-text { color: #0A70EA; font-size: 16px; font-weight: 900; }
.repay-main { flex: 1; min-width: 0; margin-right: 8px; }
.repay-title-row { flex-direction: row; align-items: center; min-width: 0; }
.repay-title { font-size: 14px; color: #071B3D; font-weight: 900; line-height: 19px; }
.repay-status { margin-left: 6px; padding: 2px 6px; border-radius: 8px; font-size: 10px; font-weight: 900; line-height: 14px; white-space: nowrap; overflow: hidden; }
.repay-status-ready { color: #047857; background: #ECFDF3; border: 1px solid #BBF7D0; }
.repay-status-browser { color: #0A70EA; background: #EAF3FF; border: 1px solid #BFDBFE; }
.repay-status-off { color: #64748B; background: #F1F5F9; border: 1px solid #E2E8F0; }
.repay-sub { margin-top: 3px; font-size: 11px; color: #64748B; line-height: 15px; }
.repay-side { align-items: flex-end; min-width: 76px; }
.repay-amount { font-size: 13px; color: #071B3D; font-weight: 900; line-height: 18px; text-align: right; }
.repay-link { margin-top: 3px; min-height: 15px; flex-direction: row; align-items: center; justify-content: flex-end; color: #0A70EA; }
.repay-link-text { font-size: 11px; color: currentColor; font-weight: 900; line-height: 15px; }
.repay-link-arrow { width: 15px; height: 15px; margin-left: 1px; }
.repay-foot { margin-top: 10px; padding-top: 10px; border-top: 1px solid #E5EEF9; flex-direction: row; align-items: center; justify-content: space-between; }
.repay-next { flex: 1; min-width: 0; font-size: 11px; color: #334155; line-height: 15px; font-weight: 800; }
.repay-consent { margin-left: 8px; font-size: 10px; color: #7C8799; line-height: 14px; text-align: right; }

.path-card, .recent-section { margin-top: 14px; border-radius: 8px; background: rgba(255,255,255,0.96); border: 1px solid rgba(231, 238, 248, 0.92); box-shadow: 0 10px 24px rgba(28, 62, 114, 0.07); padding: 14px 12px; }
.section-head { margin-bottom: 12px; }
.section-head-row { flex-direction: row; align-items: flex-start; justify-content: space-between; }
.section-title { font-size: 18px; font-weight: 900; color: #071B3D; line-height: 23px; }
.section-note { margin-top: 2px; font-size: 12px; color: #748197; line-height: 17px; }
.section-link { height: 28px; flex-direction: row; align-items: center; justify-content: center; padding-left: 8px; }
.section-link-text { font-size: 12px; font-weight: 900; color: #0A70EA; line-height: 16px; }
.section-link-arrow { width: 20px; height: 20px; color: #0A70EA; margin-left: 2px; }
.path-flow { flex-direction: row; align-items: center; }
.path-step { flex: 1; align-items: center; min-width: 0; }
.path-icon-wrap { width: 54px; height: 46px; align-items: center; justify-content: center; }
.path-num { position: absolute; top: 1px; left: 0; width: 25px; height: 25px; border-radius: 50%; background: rgba(255,255,255,0.88); text-align: center; line-height: 25px; font-size: 15px; font-weight: 900; }
.path-icon { width: 38px; height: 38px; border-radius: 50%; text-align: center; line-height: 38px; font-size: 22px; font-weight: 900; }
.path-blue .path-num, .path-blue .path-icon { color: #0A78F2; background: #EAF4FF; }
.path-green .path-num, .path-green .path-icon { color: #22C55E; background: #ECFDF3; }
.path-yellow .path-num, .path-yellow .path-icon { color: #F5B400; background: #FFF7D9; }
.path-title { margin-top: 5px; font-size: 14px; font-weight: 900; color: #071B3D; line-height: 18px; text-align: center; }
.path-desc { margin-top: 2px; font-size: 11px; color: #7C8799; line-height: 15px; text-align: center; }
.path-dash { width: 34px; height: 1px; border-top: 1px dashed #C8D2E1; margin: 0 1px 24px; }

.debt-item { min-height: 64px; border-radius: 8px; background: #FFFFFF; border: 1px solid #EDF2F8; box-shadow: 0 8px 18px rgba(25, 58, 109, 0.05); padding: 10px 8px; margin-top: 8px; flex-direction: row; align-items: center; }
.debt-marker { width: 4px; height: 38px; border-radius: 4px; background: #25D56D; margin-right: 9px; }
.debt-marker-danger { background: #F43F5E; }
.debt-icon { width: 34px; height: 34px; border-radius: 8px; background: #EAFBF0; align-items: center; justify-content: center; margin-right: 10px; }
.debt-icon-text { font-size: 19px; font-weight: 900; color: #22C55E; line-height: 22px; text-align: center; }
.debt-main { flex: 1; min-width: 0; margin-right: 8px; }
.debt-name { font-size: 14px; font-weight: 900; color: #071B3D; line-height: 19px; }
.debt-tag { margin-top: 2px; font-size: 11px; font-weight: 800; line-height: 15px; }
.debt-tag-muted { color: #748197; font-weight: 600; }
.debt-amount-col { align-items: flex-end; min-width: 62px; }
.debt-amount { font-size: 13px; font-weight: 900; color: #071B3D; line-height: 17px; text-align: right; }
.debt-amount-danger { color: #F43F5E; }
.debt-amount-label { margin-top: 2px; font-size: 10px; color: #9AA7BA; line-height: 13px; text-align: right; }
.debt-arrow { width: 22px; height: 22px; color: #B7C1D0; margin-left: 4px; }
.debt-empty .debt-icon { background: #EEF5FF; }
.debt-empty .debt-icon-text { color: #0A70EA; }

.trust-note { padding: 10px 2px 18px; align-items: center; }
.trust-text { font-size: 10px; color: #9AA7BA; line-height: 15px; text-align: center; }

/* ── 桌面端双栏布局 ≥1024px ── */
@media (min-width: 1024px) {
  .home-shell {
    display: grid;
    grid-template-areas:
      'left right'
      'recent recent'
      'trust trust';
    grid-template-columns: minmax(360px, 1fr) minmax(320px, 1fr);
    gap: 0 24px;
    padding: 0 24px;
  }
  .home-col-left { grid-area: left; }
  .home-col-right { grid-area: right; }
  .recent-section { grid-area: recent; }
  .trust-note { grid-area: trust; }
  .score-stage { height: 320px; }
  .score-meter { width: 220px; height: 220px; }
  .score-meter-inner { width: 186px; height: 186px; }
}
</style>
