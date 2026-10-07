// 本文件的评分权重与扣分阶梯为演示配置，不代表任何机构的真实授信规则。
'use strict'

/**
 * 评分算法 — 单一权威源（CJS 格式，Node.js 与浏览器 Vite 构建可引用）
 *
 * 消费方：
 *   - ai-proxy/creditRuleEngine.js（CJS require）—— 服务端规则引擎
 *   - services/creditAlgorithmCore.js（未来通过 createRequire）—— 前端 ESM
 *
 * 一致性保障：
 *   - tests/strict-gate.js — consistency:four-dim-weights-sync
 *   - scripts/algo-audit.mjs — G 段交叉验证
 *   - server.js 启动门禁 — 权重和=1 断言
 *
 * 修改本文件时务必同步验证以上所有门禁。
 */

// ═══════════════════════════════════════════════════════════════════════════
// 评分权重（四维 · 演示配置，权重之和 = 1）
// ═══════════════════════════════════════════════════════════════════════════
const FOUR_DIM_WEIGHTS = {
	repayment_record: 0.33,
	credit_history: 0.27,
	account_structure: 0.24,
	query_frequency: 0.16
}

function cnt(x) {
	const n = typeof x === 'number' ? x : Number(x)
	return Number.isFinite(n) && n > 0 ? n : 0
}

// ═══════════════════════════════════════════════════════════════════════════
// 还款记录（逾期）评分 —— 扣分阶梯为演示配置
// ═══════════════════════════════════════════════════════════════════════════
function scoreRepaymentRecord(dim) {
	const d = dim || {}
	let s = 100
	const m1 = cnt(d.m1Count)
	const m2 = cnt(d.m2Count)
	const m3 = cnt(d.m3Count)
	const overdueCnt = cnt(d.overdueCount)

	if (overdueCnt > 0) s -= 3
	s -= m1 * 9
	s -= m2 * 24
	s -= m3 * 42

	const maxDays = cnt(d.maxOverdueDays)
	if (maxDays > 90) s -= 21
	else if (maxDays > 60) s -= 9
	else if (maxDays > 30) s -= 3

	if (d.hasLianSan) s -= 24
	if (d.hasLeiLiu)  s -= 45
	if (overdueCnt > 1) s -= Math.min(21, (overdueCnt - 1) * 9)
	if (d.hasPublicRecord) s -= 9

	return Math.max(0, Math.min(100, Math.round(s)))
}

// ═══════════════════════════════════════════════════════════════════════════
// 四维评分（v7）—— 只接受规则引擎已经从原始事实派生出的维度输入
// ═══════════════════════════════════════════════════════════════════════════
function scoreFourDimensions(dim) {
	const d = dim || {}

	let creditHistory = 0
	creditHistory += Math.min(36, cnt(d.oldestAccountYears) * 6)
	creditHistory += Math.min(20, cnt(d.avgAccountYears) * 4)
	creditHistory += Math.min(20, cnt(d.activeAccountCount) * 5)
	creditHistory += Math.min(24, cnt(d.settledAccountCount) * 6)
	if (d.hasPublicRecord) creditHistory -= 33
	creditHistory = Math.max(0, Math.min(100, creditHistory))

	let queryScore = 100
	queryScore -= Math.max(0, cnt(d.q1) - 2) * 9
	queryScore -= Math.max(0, cnt(d.q3) - 4) * 3
	queryScore -= Math.max(0, cnt(d.q12) - 8) * 3
	if (cnt(d.q6) > 6) queryScore -= 21
	if (cnt(d.q6) > 10) queryScore -= 27
	if (d.has30dConcentrated) queryScore -= 3
	if (d.has7dConcentrated) queryScore -= 9
	if (cnt(d.sameDayInquiryDayCount) > 0) {
		queryScore -= Math.min(24, cnt(d.sameDayInquiryDayCount) * 9)
	}
	queryScore = Math.max(0, Math.min(100, queryScore))

	let accountScore = 0
	if (cnt(d.creditCardCount) > 0) accountScore += 15
	if (cnt(d.loanCount) > 0) accountScore += 15
	if (cnt(d.creditCardCount) > 0 && cnt(d.loanCount) > 0) accountScore += 10
	if (cnt(d.settledAccountCount) > 0) accountScore += 15
	const activeCount = cnt(d.activeAccountCount)
	if (activeCount >= 2 && activeCount <= 6) accountScore += 25
	else if (activeCount === 1) accountScore += 12
	else if (activeCount >= 7 && activeCount <= 10) accountScore += 15
	else if (activeCount > 10) accountScore += 5
	const totalCount = cnt(d.totalAccountCount)
	if (totalCount >= 3 && totalCount <= 8) accountScore += 20
	else if (totalCount >= 1 && totalCount <= 2) accountScore += 8
	else if (totalCount >= 9 && totalCount <= 12) accountScore += 10
	accountScore = Math.max(0, Math.min(100, accountScore))

	const hasRepayData =
		cnt(d.totalAccountCount) > 0 || cnt(d.overdueCount) > 0 ||
		cnt(d.m1Count) > 0 || cnt(d.m2Count) > 0 || cnt(d.m3Count) > 0 ||
		d.hasLianSan || d.hasLeiLiu

	return {
		credit_history: Math.round(creditHistory),
		query_frequency: Math.round(queryScore),
		account_structure: Math.round(accountScore),
		repayment_record: hasRepayData ? Math.round(scoreRepaymentRecord(d)) : null
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// 主评分框架（100 分扣减制 · 扣分阶梯为演示配置）
//
// 规则口径（取最高命中，不累计）：
//   账户数分档：>50:-48  >30:-36  >15:-24  >6:-9  >3:-3
//   非银贷款集中度：≥10:-33  ≥5:-21
//   信用卡使用率：>90%:-27  >70%:-9  >50%:-3
//   大额分期：-24
//   近6月查询：>12:-27  >6:-9  >3:-3
//   同日查询>3次：-21
// ═══════════════════════════════════════════════════════════════════════════
function calculatePrimaryRuleScore(dim) {
	const d = dim || {}
	const deductions = []

	// 账户数分档（从高到低匹配，命中即停止）
	const totalAccounts = cnt(d.totalAccountCount)
	if (totalAccounts > 50) deductions.push({ code: 'ACC_GT_50', label: '账户数超过50个', points: 48 })
	else if (totalAccounts > 30) deductions.push({ code: 'ACC_GT_30', label: '账户数超过30个', points: 36 })
	else if (totalAccounts > 15) deductions.push({ code: 'ACC_GT_15', label: '账户数超过15个', points: 24 })
	else if (totalAccounts > 6) deductions.push({ code: 'ACC_GT_6', label: '账户数超过6个', points: 9 })
	else if (totalAccounts > 3) deductions.push({ code: 'ACC_GT_3', label: '账户数超过3个', points: 3 })

	// 非银贷款集中度（多头借贷风险）
	const nonBankCnt = cnt(d.nonBankLoanCount)
	if (nonBankCnt >= 10) deductions.push({ code: 'NONBANK_GE_10', label: '非银贷款达到10笔', points: 33 })
	else if (nonBankCnt >= 5) deductions.push({ code: 'NONBANK_GE_5', label: '非银贷款达到5笔', points: 21 })

	// 信用卡使用率（取最高命中，不累计）
	const usageRate = cnt(d.cardUtilizationRate)
	if (usageRate > 0.9) deductions.push({ code: 'CARD_UTIL_GT_90', label: '信用卡使用率超过90%', points: 27 })
	else if (usageRate > 0.7) deductions.push({ code: 'CARD_UTIL_GT_70', label: '信用卡使用率超过70%', points: 9 })
	else if (usageRate > 0.5) deductions.push({ code: 'CARD_UTIL_GT_50', label: '信用卡使用率超过50%', points: 3 })

	if (d.hasBigInstallment) {
		deductions.push({ code: 'CARD_BIG_INSTALLMENT', label: '信用卡存在大额分期', points: 24 })
	}

	// 近6月查询（取最高命中，不累计）
	const q6 = cnt(d.q6)
	if (q6 > 12) deductions.push({ code: 'Q6_GT_12', label: '近6个月查询超过12次', points: 27 })
	else if (q6 > 6) deductions.push({ code: 'Q6_GT_6', label: '近6个月查询超过6次', points: 9 })
	else if (q6 > 3) deductions.push({ code: 'Q6_GT_3', label: '近6个月查询超过3次', points: 3 })

	// 同日查询>3次
	if (cnt(d.sameDayInquiryDayCount) > 0) {
		deductions.push({ code: 'SAME_DAY_QUERY_GT_3', label: '同一天查询超过3次', points: 21 })
	}

	const totalDeduction = deductions.reduce((sum, x) => sum + (x.points || 0), 0)
	const score = Math.max(0, Math.min(100, 100 - totalDeduction))

	return {
		score,
		baseScore: 100,
		totalDeduction,
		deductions
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// 严重逾期对综合分设硬上限（上限档位为演示配置）
// ═══════════════════════════════════════════════════════════════════════════
function applyOverdueTotalCap(total, dim) {
	if (!dim || typeof total !== 'number' || !isFinite(total)) return total
	let cap = 100
	if (dim.hasLeiLiu) cap = 27
	else if (dim.hasLianSan) cap = 33
	else if (cnt(dim.m3Count) > 0) cap = 39
	else if (cnt(dim.m2Count) > 0) cap = 45
	else if (cnt(dim.m1Count) > 0 || cnt(dim.overdueCount) > 0) cap = 48
	return Math.min(Math.round(total), cap)
}

// ═══════════════════════════════════════════════════════════════════════════
// 四维 → 加权综合分（含逾期上限）
// ═══════════════════════════════════════════════════════════════════════════
function composeFourDimTotal(four, dim) {
	const f = four || {}
	const safe = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : 0
	let t = 0
	t += safe(f.repayment_record)  * FOUR_DIM_WEIGHTS.repayment_record
	t += safe(f.credit_history)    * FOUR_DIM_WEIGHTS.credit_history
	t += safe(f.account_structure) * FOUR_DIM_WEIGHTS.account_structure
	t += safe(f.query_frequency)   * FOUR_DIM_WEIGHTS.query_frequency
	return applyOverdueTotalCap(Math.round(t), dim)
}

// ═══════════════════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════════════════

/** 安全整数转换 */
function safeInt(v, fallback = 0) {
	const n = Number(v)
	return Number.isFinite(n) ? Math.round(n) : fallback
}

/** 安全浮点转换 */
function safeFloat(v, fallback = 0) {
	const n = Number(v)
	return Number.isFinite(n) ? n : fallback
}

/** 分数裁剪到 0-100 */
function clampScore(v) {
	const n = Number(v)
	if (!Number.isFinite(n)) return null
	return Math.max(0, Math.min(100, Math.round(n)))
}

// ═══════════════════════════════════════════════════════════════════════════
// 导出
// ═══════════════════════════════════════════════════════════════════════════
module.exports = {
	FOUR_DIM_WEIGHTS,
	scoreRepaymentRecord,
	scoreFourDimensions,
	calculatePrimaryRuleScore,
	applyOverdueTotalCap,
	composeFourDimTotal,
	clampScore,
	safeInt,
	safeFloat
}
