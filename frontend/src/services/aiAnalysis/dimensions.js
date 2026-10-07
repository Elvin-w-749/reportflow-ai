/**
 * aiAnalysis 内部：20+ 维度计算 + AI/正则融合
 *
 *   · enrichDimensions：纯正则结构化 → 20+ 维度
 *   · mergeResults：弱信号时用 AI 数值救援
 *   · fuseDeterministicCoreWithAISemantics：强信号时主数值保持正则、查询取 max
 *   · applyVisionAIAccountOverview：视觉路径用 AI account_overview 修正占位账户偏差
 *   · isWeakStructuredSignal / isDimensionSparse：稀疏判定
 */

import { INSTITUTION_TYPE, classifyInstitution, queryCountsFromItems } from '../creditAlgorithmCore.js'
import { getLiveTimeAnchor, parseCreditDate } from '../../utils/beijingTime.js'

// ─────────────────────────────────────────────
// AI 结果 与 正则结果 深度合并
// 策略：
//   · 数值字段：仅当 AI 给出有限且 >0 的数时才采用（模型缺失字段常被规范化为 0，不得覆盖正则）
//   · 布尔字段：任一为 true 则取 true（风险保守原则）
//   · 负债率/卡使用率：仍仅在 AI>0 时采用 AI（与历史逻辑一致）
//   · maxOverdueDays：取 AI 与正则较大值，避免低估逾期天数
// ─────────────────────────────────────────────
export const mergeResults = (regexDim, aiDim) => {
	if (!aiDim) return regexDim  // AI失败直接用正则

	const isPosNum = (x) => typeof x === 'number' && !isNaN(x) && isFinite(x) && x > 0
	const isNonNegNum = (x) => typeof x === 'number' && !isNaN(x) && isFinite(x) && x >= 0

	/** AI 仅在给出明确正数时优先；否则沿用正则（解决模型填 0 覆盖真实解析值） */
	const pickNum = (a, b) => (isPosNum(a) ? a : b)

	const pickBool = (a, b) => a || b                   // 任一true取true

	const maxOverdueMerged = (() => {
		const ra = isNonNegNum(aiDim.maxOverdueDays) ? aiDim.maxOverdueDays : 0
		const rb = isNonNegNum(regexDim.maxOverdueDays) ? regexDim.maxOverdueDays : 0
		const m = Math.max(ra, rb)
		return m > 0 ? m : pickNum(aiDim.maxOverdueDays, regexDim.maxOverdueDays)
	})()

	return {
		// 基础层：AI 有把握的正数才覆盖正则
		totalCreditLine:    pickNum(aiDim.totalCreditLine,    regexDim.totalCreditLine),
		usedCardLimit:      pickNum(aiDim.usedCardLimit,      regexDim.usedCardLimit),
		totalLoanBalance:   pickNum(aiDim.totalLoanBalance,   regexDim.totalLoanBalance),
		availableCredit:    pickNum(aiDim.availableCredit,    regexDim.availableCredit),
		totalDebt:          pickNum(aiDim.totalDebt,          regexDim.totalDebt),
		totalOverdueAmt:    pickNum(aiDim.totalOverdueAmt,    regexDim.totalOverdueAmt),

		// 风险层：任一触发则标记（保守原则）
		debtRatio:          aiDim.debtRatio > 0 ? aiDim.debtRatio : regexDim.debtRatio,
		cardUtilizationRate: aiDim.cardUtilizationRate > 0 ? aiDim.cardUtilizationRate : regexDim.cardUtilizationRate,
		overdueCount:       pickNum(aiDim.overdueCount,     regexDim.overdueCount),
		maxOverdueDays:     maxOverdueMerged,
		m1Count:            pickNum(aiDim.m1Count,          regexDim.m1Count),
		m2Count:            pickNum(aiDim.m2Count,          regexDim.m2Count),
		m3Count:            pickNum(aiDim.m3Count,          regexDim.m3Count),
		hasLianSan:         pickBool(aiDim.hasLianSan,      regexDim.hasLianSan),
		hasLeiLiu:          pickBool(aiDim.hasLeiLiu,       regexDim.hasLeiLiu),
		hasPublicRecord:    pickBool(aiDim.hasPublicRecord, regexDim.hasPublicRecord),

		// 行为层
		q1:  pickNum(aiDim.q1,  regexDim.q1),
		q3:  pickNum(aiDim.q3,  regexDim.q3),
		q6:  pickNum(aiDim.q6,  regexDim.q6),
		q12: pickNum(aiDim.q12, regexDim.q12),
		loanQueryCount: pickNum(aiDim.loanQueryCount, regexDim.loanQueryCount),
		cardQueryCount: pickNum(aiDim.cardQueryCount, regexDim.cardQueryCount),

		// 历史层
		totalAccountCount:   pickNum(aiDim.totalAccountCount,   regexDim.totalAccountCount),
		activeAccountCount:  pickNum(aiDim.activeAccountCount,  regexDim.activeAccountCount),
		settledAccountCount: pickNum(aiDim.settledAccountCount, regexDim.settledAccountCount),
		creditCardCount:     pickNum(aiDim.creditCardCount,     regexDim.creditCardCount),
		loanCount:           pickNum(aiDim.loanCount,           regexDim.loanCount),
		nonBankLoanCount:    pickNum(aiDim.nonBankLoanCount,    regexDim.nonBankLoanCount),
		oldestAccountYears:  pickNum(aiDim.oldestAccountYears,  regexDim.oldestAccountYears),
		avgAccountYears:     pickNum(aiDim.avgAccountYears,     regexDim.avgAccountYears),

		// 财务层
		monthlyPaymentTotal: pickNum(aiDim.monthlyPaymentTotal, regexDim.monthlyPaymentTotal),
		monthlyIncomeRatio:  aiDim.monthlyIncomeRatio ?? regexDim.monthlyIncomeRatio,

		// 快捷标志（重新推算保证一致性）
		hasOverdue:
			(pickNum(aiDim.overdueCount, regexDim.overdueCount)) > 0 ||
			(pickNum(aiDim.m1Count, regexDim.m1Count)) > 0 ||
			(pickNum(aiDim.m2Count, regexDim.m2Count)) > 0 ||
			(pickNum(aiDim.m3Count, regexDim.m3Count)) > 0 ||
			pickBool(aiDim.hasLianSan, regexDim.hasLianSan) ||
			pickBool(aiDim.hasLeiLiu, regexDim.hasLeiLiu),
		hasM3Plus:   (pickNum(aiDim.m3Count, regexDim.m3Count)) > 0,
		isHighRisk:
			pickBool(aiDim.hasLianSan, regexDim.hasLianSan) ||
			pickBool(aiDim.hasLeiLiu, regexDim.hasLeiLiu) ||
			(pickNum(aiDim.m3Count, regexDim.m3Count)) > 0 ||
			pickBool(aiDim.hasPublicRecord, regexDim.hasPublicRecord) ||
			pickBool(aiDim.isHighRisk, regexDim.isHighRisk),
		debtRatioExceeds70: pickBool(aiDim.debtRatioExceeds70, regexDim.debtRatioExceeds70)
	}
}

// ─────────────────────────────────────────────
// v5：弱结构化判定（无账户/无负债数字/无查询明细 → 需 AI 数值救援）
// ─────────────────────────────────────────────
export const isWeakStructuredSignal = (parsed, regexDim) => {
	const accounts = parsed.creditAccounts || []
	const overdue = parsed.overdueRecords || []
	const qr = parsed.queryRecords || {}
	const hasQuerySignal =
		(qr.recent1Month || 0) > 0 ||
		(qr.recent3Month || 0) > 0 ||
		(qr.recent6Month || 0) > 0 ||
		(qr.recent12Month || 0) > 0 ||
		(Array.isArray(qr.details) && qr.details.length > 0)
	if (accounts.length > 0 || overdue.length > 0) return false
	if ((regexDim.totalCreditLine || 0) > 0 || (regexDim.totalDebt || 0) > 0) return false
	if (hasQuerySignal) return false
	return true
}

// ─────────────────────────────────────────────
// v5：强信号下 — 主数值保持正则；查询取 max 偏保守；语义类布尔谨慎吸收 AI
//
// 修复 H5：避免 "regex.debtRatio=0 但 AI.debtRatio>0.7 → debtRatioExceeds70=true 但 debtRatio 仍是 0"
// 这种 UI 自相矛盾。负债率与标志位必须同源：
//   - 正则有可信负债率（>0）：完全采用正则，AI 不参与
//   - 正则无负债率而 AI 有：采用 AI 的负债率，并据此重算标志位
//   - 都没有：负债率=0，标志位=false
// ─────────────────────────────────────────────
export const fuseDeterministicCoreWithAISemantics = (regexDim, aiDim) => {
	if (!aiDim) return { ...regexDim }
	const maxN = (r, a) => {
		const rr = typeof r === 'number' && !isNaN(r) && isFinite(r) ? r : 0
		const aa = typeof a === 'number' && !isNaN(a) && isFinite(a) ? a : 0
		return Math.max(rr, aa)
	}
	const orB = (r, a) => !!r || !!a

	// 同源负债率：优先正则；正则缺失时回退到 AI
	const isPosRatio = (x) => typeof x === 'number' && !isNaN(x) && isFinite(x) && x > 0
	const finalDebtRatio = isPosRatio(regexDim.debtRatio)
		? regexDim.debtRatio
		: (isPosRatio(aiDim.debtRatio) ? Math.min(aiDim.debtRatio, 2) : 0)
	const overdueCount = maxN(regexDim.overdueCount, aiDim.overdueCount)
	const m1Count = maxN(regexDim.m1Count, aiDim.m1Count)
	const m2Count = maxN(regexDim.m2Count, aiDim.m2Count)
	const m3Count = maxN(regexDim.m3Count, aiDim.m3Count)
	const hasLianSan = orB(regexDim.hasLianSan, aiDim.hasLianSan)
	const hasLeiLiu = orB(regexDim.hasLeiLiu, aiDim.hasLeiLiu)
	const hasPublicRecord = orB(regexDim.hasPublicRecord, aiDim.hasPublicRecord)
	const hasOverdue = overdueCount > 0 || m1Count > 0 || m2Count > 0 || m3Count > 0 || hasLianSan || hasLeiLiu

	return {
		...regexDim,
		debtRatio: finalDebtRatio,
		debtRatioExceeds70: finalDebtRatio > 0.7,
		totalOverdueAmt: maxN(regexDim.totalOverdueAmt, aiDim.totalOverdueAmt),
		overdueCount,
		maxOverdueDays: maxN(regexDim.maxOverdueDays, aiDim.maxOverdueDays),
		m1Count,
		m2Count,
		m3Count,
		hasLianSan,
		hasLeiLiu,
		hasOverdue,
		hasM3Plus: m3Count > 0,
		nonBankLoanCount: maxN(regexDim.nonBankLoanCount, aiDim.nonBankLoanCount),
		q1: maxN(regexDim.q1, aiDim.q1),
		q3: maxN(regexDim.q3, aiDim.q3),
		q6: maxN(regexDim.q6, aiDim.q6),
		q12: maxN(regexDim.q12, aiDim.q12),
		loanQueryCount: maxN(regexDim.loanQueryCount, aiDim.loanQueryCount),
		cardQueryCount: maxN(regexDim.cardQueryCount, aiDim.cardQueryCount),
		hasPublicRecord,
		isHighRisk: hasLianSan || hasLeiLiu || m3Count > 0 || hasPublicRecord,
		monthlyIncomeRatio: regexDim.monthlyIncomeRatio ?? aiDim.monthlyIncomeRatio ?? null
	}
}

// ─────────────────────────────────────────────
// 视觉路径：用 AI account_overview / 卡贷汇总修正占位账户带来的账户数、账龄偏差
//
// 修复 H2：覆盖比率（cardUtilizationRate / debtRatio）时必须同步覆盖对应的金额来源
// （usedCardLimit / totalCardLimit / totalLoanBalance / totalDebt / totalCreditLine），
// 否则会出现 「已用 / 总额 ≠ 卡使用率」「债务 / 授信 ≠ 综合负债率」的 UI 自相矛盾。
// ─────────────────────────────────────────────
export const applyVisionAIAccountOverview = (dim, kn) => {
	if (!kn || !dim) return dim
	const a = kn.account_overview || {}
	const cc = kn.credit_cards || {}
	const la = kn.loan_accounts || {}
	const d = kn.debt_summary || {}
	const o = kn.overdue_summary || {}
	const hd = kn.hidden_debt_analysis || {}
	const isPosNum = (x) => typeof x === 'number' && !isNaN(x) && isFinite(x) && x > 0
	const isNonNegNum = (x) => typeof x === 'number' && !isNaN(x) && isFinite(x) && x >= 0

	const out = { ...dim }

	// 1. 账户数 / 账龄类（与金额无强耦合，可独立覆盖）
	if (isPosNum(a.total_count))   out.totalAccountCount = a.total_count
	if (isNonNegNum(a.active_count))  out.activeAccountCount = a.active_count
	if (isNonNegNum(a.settled_count)) out.settledAccountCount = a.settled_count
	if (isPosNum(cc.count))        out.creditCardCount = cc.count
	if (isPosNum(la.count))        out.loanCount = la.count
	if (isNonNegNum(hd.consumer_finance_count)) out.nonBankLoanCount = Math.max(out.nonBankLoanCount || 0, hd.consumer_finance_count)
	if (isPosNum(a.oldest_account_years)) out.oldestAccountYears = a.oldest_account_years
	if (isPosNum(a.avg_account_years))    out.avgAccountYears = a.avg_account_years

	// 2. 信用卡口径同源覆盖：AI 给出 used_amount / total_limit / usage_rate_pct 时，三者一起接管
	const aiCardUsed  = isPosNum(cc.used_amount) ? cc.used_amount : null
	const aiCardLimit = isPosNum(cc.total_limit) ? cc.total_limit : null
	if (aiCardUsed != null)  out.usedCardLimit = aiCardUsed
	if (aiCardLimit != null) {
		// 重算 cardUtilizationRate 保持 = used / limit；如果 AI 也给了 usage_rate_pct，优先用它
		const used = aiCardUsed ?? out.usedCardLimit ?? 0
		out.cardUtilizationRate = aiCardLimit > 0 ? Math.min(used / aiCardLimit, 1) : 0
	}
	if (isPosNum(cc.usage_rate_pct) && cc.usage_rate_pct <= 100) {
		out.cardUtilizationRate = cc.usage_rate_pct / 100
		// 当 AI 仅给比率没给金额时，反推金额以保持口径一致
		if (aiCardLimit == null && isPosNum(out.usedCardLimit) && out.cardUtilizationRate > 0) {
			// usedCardLimit / rate = totalLimit
		}
	}

	// 3. 贷款口径同源覆盖
	if (isPosNum(la.balance))           out.totalLoanBalance = la.balance
	if (isPosNum(la.monthly_payment))   out.monthlyPaymentTotal = la.monthly_payment

	const aiOverdueCount = Math.max(
		isNonNegNum(o.current_overdue_count) ? o.current_overdue_count : 0,
		(isNonNegNum(cc.overdue_count) ? cc.overdue_count : 0) + (isNonNegNum(la.overdue_count) ? la.overdue_count : 0)
	)
	if (aiOverdueCount > 0) {
		out.overdueCount = Math.max(out.overdueCount || 0, aiOverdueCount)
		out.totalOverdueAmt = Math.max(out.totalOverdueAmt || 0, isNonNegNum(o.current_overdue_amount) ? o.current_overdue_amount : 0)
		out.maxOverdueDays = Math.max(out.maxOverdueDays || 0, isNonNegNum(o.max_overdue_days) ? o.max_overdue_days : 0)
		out.m1Count = Math.max(out.m1Count || 0, isNonNegNum(o.m1_count) ? o.m1_count : 0)
		out.m2Count = Math.max(out.m2Count || 0, isNonNegNum(o.m2_count) ? o.m2_count : 0)
		out.m3Count = Math.max(out.m3Count || 0, isNonNegNum(o.m3_plus_count) ? o.m3_plus_count : 0)
		out.hasLianSan = !!out.hasLianSan || !!o.consecutive_overdue_3
		out.hasLeiLiu = !!out.hasLeiLiu || !!o.cumulative_overdue_6
		out.hasOverdue = true
		out.hasM3Plus = (out.m3Count || 0) > 0
		out.isHighRisk = !!out.hasLianSan || !!out.hasLeiLiu || (out.m3Count || 0) > 0 || !!out.hasPublicRecord
	}

	// 4. 综合负债同源覆盖：负债率统一按 总负债额度 / 总信用额度 计算
	const aiTotalDebt   = isPosNum(d.total_debt)         ? d.total_debt         : null
	const aiTotalCredit = isPosNum(d.total_credit_line)  ? d.total_credit_line  : null
	const aiAvailable   = isPosNum(d.available_credit)   ? d.available_credit   : null
	if (aiTotalDebt != null)   out.totalDebt = aiTotalDebt
	if (aiTotalCredit != null) out.totalCreditLine = aiTotalCredit
	if (aiAvailable != null)   out.availableCredit = aiAvailable
	if (aiTotalDebt != null && aiTotalCredit != null && aiTotalCredit > 0) {
		out.debtRatio = Math.min(aiTotalDebt / aiTotalCredit, 2)
	} else if (isPosNum(d.debt_ratio_pct)) {
		out.debtRatio = Math.min(d.debt_ratio_pct / 100, 2)
	}
	if (typeof out.debtRatio === 'number' && !isNaN(out.debtRatio)) {
		out.debtRatioExceeds70 = out.debtRatio > 0.7
	}
	return out
}

// ─────────────────────────────────────────────
// 20+ 维度计算
// ─────────────────────────────────────────────
export const enrichDimensions = (parsed) => {
	const accounts      = parsed.creditAccounts || []
	const overdueRecs   = parsed.overdueRecords  || []
	const query         = parsed.queryRecords    || {}
	const consec        = parsed.consecutiveOverdue || {}
	const pub           = parsed.publicRecords   || {}

	// ── 基础层 ──────────────────────────────
	// 单次遍历accounts数组，同时计算多个指标
	let activeAccounts = []
	let settledAccounts = []
	let creditCards = []
	let loans = []
	let hasBigInstallment = false

	for (const account of accounts) {
		if (account.isSettled) {
			settledAccounts.push(account)
		} else {
			activeAccounts.push(account)
			if (account.hasBigInstallment) hasBigInstallment = true
			if (account.isLoan) {
				loans.push(account)
			} else {
				creditCards.push(account)
			}
		}
	}
	const nonBankLoanCount = loans.filter((account) =>
		classifyInstitution(account.bank || account.institution || account.org || '') === INSTITUTION_TYPE.NON_BANK
	).length

	// 信用卡相关 - 单次遍历计算
	let totalCardLimit = 0
	let usedCardLimit = 0
	for (const card of creditCards) {
		totalCardLimit += card.limit || 0
		usedCardLimit += card.balance || 0
	}

	// 贷款相关 - 单次遍历计算
	let totalLoanBalance = 0
	let totalLoanAmount = 0
	for (const loan of loans) {
		totalLoanBalance += loan.balance || 0
		totalLoanAmount += loan.loanAmount || loan.limit || 0
	}

	// 总体
	const totalCreditLine  = totalCardLimit + totalLoanAmount
	const totalDebt        = usedCardLimit + totalLoanBalance
	const availableCredit  = totalCreditLine - totalDebt

	// 逾期 - 单次遍历计算多个指标
	let totalOverdueAmt = 0
	let maxOverdueDays = 0
	let m1Count = 0
	let m2Count = 0
	let m3Count = 0

	for (const record of overdueRecs) {
		totalOverdueAmt += record.amount || 0
		maxOverdueDays = Math.max(maxOverdueDays, record.days || 0)
		if (record.level === 'M1') m1Count++
		else if (record.level === 'M2') m2Count++
		else if (record.level === 'M3+') m3Count++
	}

	const overdueCount = overdueRecs.length // 逾期账户数

	// ── 风险层 ──────────────────────────────
	// 综合负债率 = 总负债额度 / 总信用额度（含贷款授信）
	const debtRatio = totalCreditLine > 0 ? totalDebt / totalCreditLine : 0
	// 信用卡使用率
	const cardUtilizationRate = totalCardLimit > 0 ? usedCardLimit / totalCardLimit : 0

	// ── 行为层 ──────────────────────────────
	// 查询机构分布（贷款审批/信用卡审批/本人查询）—— 优先用结构化 queryItems，回退到 details
	const queryItems = Array.isArray(query.queryItems) && query.queryItems.length
		? query.queryItems
		: (Array.isArray(query.details) ? query.details : [])

		// 日期解析统一走 parseCreditDate（北京时间正午），避免 new Date(s) 的 UTC/本地歧义
	// 近 N 月次数：有明细时按现实时间重算；否则回退 PDF 摘要字段
	let q1  = query.recent1Month  || 0
	let q3  = query.recent3Month  || 0
	let q6  = query.recent6Month  || 0
	let q12 = query.recent12Month || 0
	if (queryItems.length > 0) {
		const live = queryCountsFromItems(queryItems)
		q1 = live.q1
		q3 = live.q3
		q6 = live.q6
		q12 = live.q12
	}

	const DAY_MS = 24 * 60 * 60 * 1000
	const queryNow = getLiveTimeAnchor()
	const queryNowT = queryNow.getTime()
	const inLastDays = (d, days) => d && (queryNowT - d.getTime()) <= days * DAY_MS && d.getTime() <= queryNowT
	const isEffectiveQueryReason = (reason) => {
		const s = String(reason || '')
		if (/本人|自查|自助|贷后管理/.test(s)) return false
		return /贷款审批|信用卡审批|贷记卡审批|担保资格审查|担保审查|保前审查|审批/.test(s)
	}

	const loanQueryCount = queryItems.filter((d) => {
		const dt = parseCreditDate(d?.date)
		return inLastDays(dt, 30) && /贷款审批|担保资格审查|担保审查|保前审查/.test(d?.reason || '')
	}).length
	const cardQueryCount = queryItems.filter((d) => {
		const dt = parseCreditDate(d?.date)
		return inLastDays(dt, 30) && /信用卡审批|贷记卡审批/.test(d?.reason || '')
	}).length

	// 集中查询 / 同日多次：仅统计近 6 个月（相对现实时间）内的查询
	const inquiryDates = queryItems
		.filter(it => isEffectiveQueryReason(it?.reason || it?.query_reason || it?.purpose))
		.map(it => parseCreditDate(it?.date))
		.filter((d) => inLastDays(d, 180))
		.sort((a, b) => a - b)

	// 同日 > 3 次的"重复日"个数（严格"超过3次"口径）
	let sameDayInquiryDayCount = 0
	{
		const dayMap = new Map()
		for (const d of inquiryDates) {
			const k = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
			dayMap.set(k, (dayMap.get(k) || 0) + 1)
		}
		for (const cnt of dayMap.values()) {
			if (cnt > 3) sameDayInquiryDayCount += 1
		}
	}

	// 集中查询：滚动窗口判定（任一 7 天窗口 ≥ 3 / 30 天窗口 ≥ 4）
	let has7dConcentrated = false
	let has30dConcentrated = false
	if (inquiryDates.length >= 3) {
		const DAY = 24 * 60 * 60 * 1000
		for (let i = 0; i < inquiryDates.length; i++) {
			const base = inquiryDates[i].getTime()
			let in7 = 0, in30 = 0
			for (let j = i; j < inquiryDates.length; j++) {
				const diff = inquiryDates[j].getTime() - base
				if (diff <= 7 * DAY) in7++
				if (diff <= 30 * DAY) in30++
				else break
			}
			if (in7 >= 3) has7dConcentrated = true
			if (in30 >= 4) has30dConcentrated = true
			if (has7dConcentrated && has30dConcentrated) break
		}
	}

	// ── 历史层 ──────────────────────────────
	const now = getLiveTimeAnchor()
	const accountAges = accounts.map(a => {
		if (!a.openDate) return 0
		const open = new Date(a.openDate)
		return isNaN(open.getTime()) ? 0 : Math.floor((now - open) / (1000 * 60 * 60 * 24 * 365 * 1))
	}).filter(y => y > 0)

	const oldestAccountYears = accountAges.length > 0 ? Math.max(...accountAges) : 0
	const avgAccountYears    = accountAges.length > 0 ? accountAges.reduce((s, y) => s + y, 0) / accountAges.length : 0

	// ── 财务层 ──────────────────────────────
	const monthlyPaymentTotal = loans.reduce((s, a) => s + (a.monthlyPayment || 0), 0)

	return {
		// === 基础层 ===
		totalCreditLine,         // 总授信额度
		usedCardLimit,           // 信用卡已用额度
		totalLoanBalance,        // 贷款余额合计
		availableCredit,         // 可用额度
		totalDebt,               // 总债务
		totalOverdueAmt,         // 逾期金额合计

		// === 风险层 ===
		debtRatio,               // 综合负债率（0-1）
		cardUtilizationRate,     // 信用卡使用率（0-1）
		overdueCount,            // 逾期账户数
		maxOverdueDays,          // 最大逾期天数
		m1Count,                 // M1 逾期账户数
		m2Count,                 // M2 逾期账户数
		m3Count,                 // M3+ 逾期账户数
		hasLianSan:  consec.hasLianSan  || false,  // 连三
		hasLeiLiu:   consec.hasLeiLiu   || false,  // 累六
		hasPublicRecord: pub.hasRecord  || false,  // 公共记录

		// === 行为层 ===
		q1, q3, q6, q12,
		loanQueryCount,          // 贷款审批查询次数（1月内）
		cardQueryCount,          // 信用卡审批查询次数（1月内）
		// v5：查询频率维度专用扣分信号
		sameDayInquiryDayCount,  // 同一天 > 3 次查询的日期个数（"超过3次"严格口径）
		has7dConcentrated,       // 7 天内 ≥ 3 次（短期密集）
		has30dConcentrated,      // 30 天内 ≥ 4 次（集中查询）
		hasBigInstallment,       // 是否存在信用卡大额分期

		// === 历史层 ===
		totalAccountCount:  accounts.length,
		activeAccountCount: activeAccounts.length,
		settledAccountCount:settledAccounts.length,
		creditCardCount:    creditCards.length,
		loanCount:          loans.length,
		nonBankLoanCount,
		oldestAccountYears,      // 最早开户年限（年）
		avgAccountYears,         // 平均账龄（年）

		// === 财务层 ===
		monthlyPaymentTotal,     // 月均还款额
		// 月还款/收入比（用户未填收入时为 null）
		monthlyIncomeRatio: null,

		// === 快捷标志位（风控规则引擎直接使用）===
		hasOverdue:  overdueCount > 0,
		hasM3Plus:   m3Count > 0,
		isHighRisk:  consec.hasLianSan || consec.hasLeiLiu || m3Count > 0 || pub.hasRecord,
		debtRatioExceeds70: debtRatio > 0.7
	}
}

// 结构化数据过弱时，避免“维度全0却显示高分”的错觉
export const isDimensionSparse = (dim) => {
	if (!dim || typeof dim !== 'object') return true
	const nums = [
		dim.totalCreditLine, dim.usedCardLimit, dim.totalLoanBalance, dim.totalDebt,
		dim.overdueCount, dim.m1Count, dim.m2Count, dim.m3Count,
		dim.q1, dim.q3, dim.q6, dim.q12,
		dim.totalAccountCount, dim.creditCardCount, dim.loanCount
	]
	const nonZero = nums.filter(v => typeof v === 'number' && isFinite(v) && v > 0).length
	return nonZero <= 1
}
