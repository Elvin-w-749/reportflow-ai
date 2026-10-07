/**
 * AI 结构化结果适配层（模型无关）
 * 负责：归一化结果、内部维度映射、四维评分映射、视觉结果重建。
 */

import {
	statusExplicitlyDeniesOverdue,
	statusIndicatesActiveUnsettled,
	statusIndicatesOverdue,
	statusIndicatesSettled,
	statusIsUnknown
} from '../utils/creditStatus.js'
import { strictNonNegativeIntegerOrNull, strictNonNegativeNumberOrNull } from '../utils/strictNumber.js'

const isExtendedCreditReport = (v) =>
	!!(v && typeof v === 'object' && v.meta && v.credit_debt)

/**
 * 通用安全数值转换：处理 number/string/逗号分隔/NaN/Infinity。
 * 各子模块（mapExtendedToLegacyPickSource / buildCreditAccountFrom* / normalizeAIResult）
 * 均通过此函数统一转换口径，避免同一逻辑在文件中重复定义 4 次。
 * @param {*} x 输入值
 * @param {number|null} [def=null] 无法解析时的默认值
 * @returns {number|null}
 */
const nonNegativeOrNull = strictNonNegativeNumberOrNull
const countOrNull = strictNonNegativeIntegerOrNull
const nonNegativeOrFallback = (value, fallback = null) => (
	nonNegativeOrNull(value) ?? nonNegativeOrNull(fallback)
)
const countOrFallback = (value, fallback = null) => countOrNull(value) ?? countOrNull(fallback)

const maxKnown = (...values) => {
	const known = []
	for (const value of values) {
		const parsed = nonNegativeOrNull(value)
		if (parsed != null) known.push(parsed)
	}
	return known.length ? Math.max(...known) : null
}

const explicitBooleanOrNull = (value) => typeof value === 'boolean' ? value : null
const statusTextOrEmpty = (value) => {
	const text = typeof value === 'string' ? value.normalize('NFKC').trim() : ''
	return statusIsUnknown(text) ? '' : text
}

const statusExplicitlyNoOverdue = (value) => {
	const text = String(value == null ? '' : value).normalize('NFKC').trim()
	return statusExplicitlyDeniesOverdue(text) || /^(?:normal|performing|正常|按时|良好)$/.test(text)
}

/** 将 10 模块征信 JSON 压平为旧版 normalize 所读取的顶层字段（与 debt_summary / query_records 等对齐） */
function mapExtendedToLegacyPickSource(v) {
	const n = nonNegativeOrFallback
	const cd = v.credit_debt || {}
	const cl = cd.credit_loans || {}
	const cc = cd.credit_cards || {}
	const ld = v.loan_details || {}
	const stB = ld.subtotal_bank || {}
	const stN = ld.subtotal_non_bank || {}
	const tot = ld.total || {}
	const sumRows = (rows) => {
		if (!Array.isArray(rows) || !rows.length) return { bal: null, lim: null }
		const balances = rows.map((row) => nonNegativeOrNull(row && row.balance))
		const limits = rows.map((row) => nonNegativeOrNull(row && row.credit_limit))
		return {
			bal: balances.every((value) => value != null) ? balances.reduce((sum, value) => sum + value, 0) : null,
			lim: limits.every((value) => value != null) ? limits.reduce((sum, value) => sum + value, 0) : null
		}
	}
	const bankRows = sumRows(ld.bank_loans)
	const nonRows = sumRows(ld.non_bank_loans)
	const subtotalBank = nonNegativeOrNull(stB.balance)
	const subtotalNonBank = nonNegativeOrNull(stN.balance)
	const subtotalBalance = subtotalBank != null && subtotalNonBank != null ? subtotalBank + subtotalNonBank : null
	const rowBalance = bankRows.bal != null && nonRows.bal != null ? bankRows.bal + nonRows.bal : null
	const loanBal = subtotalBalance ?? nonNegativeOrNull(tot.balance) ?? rowBalance
	const listedLoanCount = Array.isArray(ld.bank_loans) && Array.isArray(ld.non_bank_loans) && ld.bank_loans.length + ld.non_bank_loans.length > 0
		? ld.bank_loans.length + ld.non_bank_loans.length
		: null
	const loanCount = countOrNull(tot.count) ?? listedLoanCount
	const cardDetails = Array.isArray(v.credit_card_details) ? v.credit_card_details : []
	const cardCount = countOrNull(cc.card_count) ?? (cardDetails.length > 0 ? cardDetails.length : null)
	const cardLimits = cardDetails.map((row) => nonNegativeOrNull(row && row.credit_limit))
	const cardUsedValues = cardDetails.map((row) => nonNegativeOrNull(row && row.used_limit))
	const cardLimitFromRows = cardDetails.length && cardLimits.every((value) => value != null) ? cardLimits.reduce((sum, value) => sum + value, 0) : null
	const cardUsedFromRows = cardDetails.length && cardUsedValues.every((value) => value != null) ? cardUsedValues.reduce((sum, value) => sum + value, 0) : null
	const totalCardLimit = nonNegativeOrNull(cc.total_limit) ?? cardLimitFromRows
	const totalCardUsed = nonNegativeOrNull(cc.total_used) ?? cardUsedFromRows
	const usageRatePct =
		nonNegativeOrNull(cc.usage_rate_pct) != null
			? nonNegativeOrNull(cc.usage_rate_pct)
			: nonNegativeOrNull(cc.usage_rate) != null && nonNegativeOrNull(cc.usage_rate) <= 1
				? Math.round(nonNegativeOrNull(cc.usage_rate) * 10000) / 100
				: totalCardLimit > 0 && totalCardUsed != null
					? Math.round((totalCardUsed / totalCardLimit) * 10000) / 100
					: null
	const loanAmount = nonNegativeOrNull(cl.total_amount)
	const subtotalBankLimit = nonNegativeOrNull(stB.credit_limit)
	const subtotalNonBankLimit = nonNegativeOrNull(stN.credit_limit)
	const subtotalLoanLimit = subtotalBankLimit != null && subtotalNonBankLimit != null ? subtotalBankLimit + subtotalNonBankLimit : null
	const rowLoanLimit = bankRows.lim != null && nonRows.lim != null ? bankRows.lim + nonRows.lim : null
	const resolvedLoanLimit = loanAmount ?? subtotalLoanLimit ?? rowLoanLimit ?? loanBal
	const totalCreditLine = resolvedLoanLimit != null && totalCardLimit != null ? resolvedLoanLimit + totalCardLimit : null
	const qsum = (v.query_analysis && v.query_analysis.summary) || {}
	const pickQ = (k) => {
		const o = qsum[k] || {}
		return countOrNull(o.total)
	}
	const ov = v.overdue_info || {}
	const _rawHits = (v.risk_analysis || {}).risk_hits
	const hits = (Array.isArray(_rawHits) ? _rawHits : []).map((h) => h && h.title).filter(Boolean)
	const asmt = v.assessment || {}
	const baseScore = n(asmt.score, null)
	const sdIn = v.six_dimensions || {}
	// v7「无编造」：AI 未给出的维度不再用 baseScore(默认70) 顶满，保留 null；
	// 下游 aiToScores / normalizeAdvisoryScores 同样保留 null（UI 画灰显示「—」），不再 归 0。
	const fillSix = (k) => n(sdIn[k], null)
	const six = {
		repayment_ability: fillSix('repayment_ability'),
		credit_history: fillSix('credit_history'),
		debt_ratio: fillSix('debt_ratio'),
		query_frequency: fillSix('query_frequency'),
		account_structure: fillSix('account_structure'),
		repayment_record: fillSix('repayment_record')
	}
	const rawRisk = asmt.risk_level ?? (v.risk_analysis || {}).overall_level
	const zhRisk = typeof rawRisk === 'string' ? rawRisk.trim() : ''
	const mapZhToEn = () => {
		const s = zhRisk.toLowerCase()
		if (!s) return ''
		// 英文枚举精确匹配（含复合等级；三级制下复合等级按"不低估风险"就近归并）
		if (s === 'high' || s === 'medium-high') return 'high'
		if (s === 'medium' || s === 'medium-low') return 'medium'
		if (s === 'low') return 'low'
		// 中文：必须先判「高」（含「中高」）、再判「中」（含「中低」）、最后才判「低」，
		// 否则 includes('低') 会把「中低」误判为 low（低估风险）。
		if (s.includes('高')) return 'high'
		if (s.includes('中')) return 'medium'
		if (s.includes('低')) return 'low'
		return ''
	}
	const totalDebt = n((v.debt_summary || {}).total_debt, n(cd.total_debt))
	const debtRatioPct =
		nonNegativeOrNull((v.debt_summary || {}).debt_ratio_pct) != null
			? nonNegativeOrNull((v.debt_summary || {}).debt_ratio_pct)
			: nonNegativeOrNull(cd.debt_ratio) != null && nonNegativeOrNull(cd.debt_ratio) <= 1
				? Math.round(nonNegativeOrNull(cd.debt_ratio) * 10000) / 100
				: nonNegativeOrNull(cd.debt_ratio) != null
					? nonNegativeOrNull(cd.debt_ratio)
					: totalCreditLine > 0 && totalDebt != null
						? Math.round((totalDebt / totalCreditLine) * 10000) / 100
						: null
	const bi = v.basic_info || {}
	const meta = v.meta || {}
	const idLast = bi.id_last4 != null ? String(bi.id_last4).replace(/\D/g, '').slice(-4) : ''
	const idCard =
		bi.id_card ||
		bi.idCard ||
		(idLast.length === 4 ? `****************${idLast}` : '')
	const other = v.other_debts || {}
	const guarAmt = n(other.guarantee && other.guarantee.amount)

	return {
		basic_info: {
			name: bi.name || '',
			id_card: idCard,
			report_date: bi.report_date || meta.report_date || meta.query_date || '',
			report_no: bi.report_no || ''
		},
		credit_score_estimate: {
			score: n((v.credit_score_estimate || {}).score, baseScore),
			level: (v.credit_score_estimate || {}).level || asmt.risk_level || '',
			basis: (v.credit_score_estimate || {}).basis || asmt.suggestion || ''
		},
		debt_summary: {
			total_credit_line: n((v.debt_summary || {}).total_credit_line, totalCreditLine),
			used_credit: n((v.debt_summary || {}).used_credit, totalCardUsed),
			loan_balance: n((v.debt_summary || {}).loan_balance, loanBal),
			total_debt: totalDebt,
			available_credit: n(
				(v.debt_summary || {}).available_credit,
				totalCardLimit != null && totalCardUsed != null ? Math.max(0, totalCardLimit - totalCardUsed) : null
			),
			debt_ratio_pct: debtRatioPct
		},
		overdue_summary: {
			current_overdue_count: countOrFallback((v.overdue_summary || {}).current_overdue_count, countOrNull(ov.total_overdue_accounts)),
			current_overdue_amount: n((v.overdue_summary || {}).current_overdue_amount, null),
			max_overdue_days: countOrFallback((v.overdue_summary || {}).max_overdue_days, null),
			m1_count: countOrFallback((v.overdue_summary || {}).m1_count, null),
			m2_count: countOrFallback((v.overdue_summary || {}).m2_count, null),
			m3_plus_count: countOrFallback((v.overdue_summary || {}).m3_plus_count, countOrNull(ov.overdue_90_days)),
			consecutive_overdue_3: explicitBooleanOrNull((v.overdue_summary || {}).consecutive_overdue_3),
			cumulative_overdue_6: explicitBooleanOrNull((v.overdue_summary || {}).cumulative_overdue_6),
			total_overdue_24m: countOrFallback((v.overdue_summary || {}).total_overdue_24m, countOrNull(ov.total_overdue_months))
		},
		query_records: {
			recent_1m: countOrFallback((v.query_records || {}).recent_1m, pickQ('last_1m')),
			recent_3m: countOrFallback((v.query_records || {}).recent_3m, pickQ('last_3m')),
			recent_6m: countOrFallback((v.query_records || {}).recent_6m, pickQ('last_6m')),
			recent_12m: countOrFallback((v.query_records || {}).recent_12m, pickQ('last_12m')),
			loan_query_1m: countOrFallback((v.query_records || {}).loan_query_1m, null),
			card_query_1m: countOrFallback((v.query_records || {}).card_query_1m, null)
		},
		credit_cards: {
			count: countOrFallback((v.credit_cards || {}).count, cardCount),
			total_limit: n((v.credit_cards || {}).total_limit, totalCardLimit),
			used_amount: n((v.credit_cards || {}).used_amount, totalCardUsed),
			usage_rate_pct: n((v.credit_cards || {}).usage_rate_pct, usageRatePct),
			overdue_count: countOrFallback((v.credit_cards || {}).overdue_count, null)
		},
		loan_accounts: {
			count: countOrFallback((v.loan_accounts || {}).count, loanCount),
			total_loan_amount: n((v.loan_accounts || {}).total_loan_amount, subtotalLoanLimit ?? rowLoanLimit),
			balance: n((v.loan_accounts || {}).balance, loanBal),
			monthly_payment: n((v.loan_accounts || {}).monthly_payment, null),
			overdue_count: countOrFallback((v.loan_accounts || {}).overdue_count, null)
		},
		account_overview: {
			total_count: countOrFallback((v.account_overview || {}).total_count, loanCount != null && cardCount != null ? loanCount + cardCount : null),
			active_count: countOrNull((v.account_overview || {}).active_count),
			settled_count: countOrFallback((v.account_overview || {}).settled_count, null),
			oldest_account_years: n((v.account_overview || {}).oldest_account_years, null),
			avg_account_years: n((v.account_overview || {}).avg_account_years, null)
		},
		public_records: v.public_records || { has_record: null, items: [] },
		guarantee_records: v.guarantee_records || {
			has_guarantee: guarAmt == null ? null : guarAmt > 0,
			total_guarantee_amount: guarAmt,
			guarantee_count: countOrNull(other.guarantee && other.guarantee.count),
			note: ''
		},
		hidden_debt_analysis: v.hidden_debt_analysis || {
			consumer_finance_count: Array.isArray(ld.non_bank_loans) && ld.non_bank_loans.length > 0 ? ld.non_bank_loans.length : null,
			revolving_credit_count: null,
			estimated_hidden_debt: n(cl.non_bank_amount),
			multi_loan_risk: (Array.isArray(ld.non_bank_loans) && ld.non_bank_loans.length >= 5 ? '较高' : ''),
			note: ''
		},
		behavior_tags: Array.isArray(v.behavior_tags) ? v.behavior_tags : [],
		risk_tags: [...new Set([...(Array.isArray(v.risk_tags) ? v.risk_tags : []), ...hits])].filter(Boolean),
		six_dimensions: { ...six, ...sdIn },
		risk_level: mapZhToEn() || v.risk_level || 'unknown',
		suggestion: v.suggestion || asmt.suggestion || '',
		debt_restructure_feasibility: v.debt_restructure_feasibility || '',
		product_accessibility: v.product_accessibility || {
			bank_mortgage: '',
			bank_consumer_loan: '',
			bank_credit_card: '',
			online_loan: '',
			note: ''
		}
	}
}

function buildCreditAccountFromLoanRow(r, isBank) {
	const n = nonNegativeOrFallback
	const st = statusTextOrEmpty(r.status)
	const days = _odDays(r)
	const overdueByStatus = statusIndicatesOverdue(st)
	return {
		bank: String(r.institution || '未知机构'),
		accountType: String(r.type || '贷款'),
		isLoan: true,
		institutionCategory: isBank ? '商业银行' : '非银',
		loanTypeCategory: '消费贷',
		hasBigInstallment: null,
		bigInstallmentAmount: null,
		limit: n(r.credit_limit),
		balance: n(r.balance),
		loanAmount: n(r.credit_limit),
		status: st || null,
		openDate: String(r.start_date || ''),
		endDate: String(r.end_date || ''),
		isSettled: statusIndicatesSettled(st) ? true : statusIndicatesActiveUnsettled(st) ? false : null,
		repayRecord: '',
		repayMethod: '',
		monthlyPayment: null,
		guaranteeType: '',
		repayMatrix: [],
		overdueDays: days != null ? days : (overdueByStatus ? 1 : statusExplicitlyNoOverdue(st) ? 0 : null),
		overdueAmount: n(r.overdue_amount ?? r.overdueAmount),
		overdueDate: String(r.overdue_date || r.overdueDate || ''),
		overdueLevel: _odLevel(days, st),
		isOverdue: days != null || overdueByStatus || statusExplicitlyNoOverdue(st)
			? (overdueByStatus || (days != null && days > 0))
			: null
	}
}

/** 逾期天数多源解析（V2 行重建用） */
function _odDays(row) {
	return nonNegativeOrNull(row && (row.overdue_days ?? row.overdueDays))
}
/** 由逾期天数 + 状态推断 M1/M2/M3+（与 pdfParser.classifyOverdueLevel 同口径） */
function _odLevel(days, status) {
	const d = nonNegativeOrNull(days)
	if (d == null) return statusIndicatesOverdue(status) ? 'M1' : statusExplicitlyNoOverdue(status) ? 'none' : 'unknown'
	if (d > 60) return 'M3+'
	if (d > 30) return 'M2'
	if (d > 0) return 'M1'
	return statusIndicatesOverdue(status) ? 'M1' : 'none'
}

function buildCreditAccountFromCardRow(c) {
	const n = nonNegativeOrFallback
	const st = statusTextOrEmpty(c.status)
	const days = _odDays(c)
	const overdueByStatus = statusIndicatesOverdue(st)
	return {
		bank: String(c.institution || '信用卡'),
		accountType: '贷记卡',
		isLoan: false,
		institutionCategory: '商业银行',
		loanTypeCategory: '信用卡',
		hasBigInstallment: n(c.installment) == null ? null : n(c.installment) > 0,
		bigInstallmentAmount: n(c.installment),
		limit: n(c.credit_limit),
		balance: n(c.used_limit),
		loanAmount: null,
		status: st || null,
		openDate: '',
		endDate: '',
		isSettled: statusIndicatesSettled(st) ? true : statusIndicatesActiveUnsettled(st) ? false : null,
		repayRecord: '',
		repayMethod: '',
		monthlyPayment: null,
		guaranteeType: '',
		repayMatrix: [],
		overdueDays: days != null ? days : (overdueByStatus ? 1 : statusExplicitlyNoOverdue(st) ? 0 : null),
		overdueAmount: n(c.overdue_amount ?? c.overdueAmount),
		overdueDate: String(c.overdue_date || c.overdueDate || ''),
		overdueLevel: _odLevel(days, st),
		isOverdue: days != null || overdueByStatus || statusExplicitlyNoOverdue(st)
			? (overdueByStatus || (days != null && days > 0))
			: null
	}
}

export const normalizeAIResult = (raw) => {
	const safeNum = nonNegativeOrFallback
	const safeCount = countOrFallback
	const safeBool = (v, def = null) => {
		if (typeof v === 'boolean') return v
		if (v === true || v === 1) return true
		if (v === false || v === 0) return false
		if (typeof v === 'string') {
			const s = v.trim().toLowerCase()
			if (s === 'true' || s === 'yes' || s === '1') return true
			if (s === 'false' || s === 'no' || s === '0') return false
		}
		return def
	}
	const safeStr = (v, def = '') => (typeof v === 'string' ? v : def)
	const safeArr = (v) => (Array.isArray(v) ? v : [])
	const pick = (...vals) => {
		for (const v of vals) {
			if (v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '')) return v
		}
		return undefined
	}
	const unwrap = (v) => {
		if (!v || typeof v !== 'object') return {}
		if (v.data && typeof v.data === 'object') return v.data
		if (v.result && typeof v.result === 'object') return v.result
		if (v.analysis && typeof v.analysis === 'object') return v.analysis
		return v
	}

	const base = unwrap(raw)
	const fromV2 = isExtendedCreditReport(base)
	const src = fromV2 ? { ...base, ...mapExtendedToLegacyPickSource(base) } : base
	const bi = src.basic_info || src.basicInfo || {}
	const ds = src.debt_summary || src.debtSummary || {}
	const os = src.overdue_summary || src.overdueSummary || {}
	const qr = src.query_records || src.queryRecords || {}
	const cc = src.credit_cards || src.creditCards || {}
	const la = src.loan_accounts || src.loanAccounts || {}
	const ao = src.account_overview || src.accountOverview || {}
	const pr = src.public_records || src.publicRecords || {}
	const gr = src.guarantee_records || src.guaranteeRecords || {}
	const hd = src.hidden_debt_analysis || src.hiddenDebtAnalysis || {}
	const sd = src.six_dimensions || src.sixDimensions || {}
	const pa = src.product_accessibility || src.productAccessibility || {}
	const normalizeRiskLevel = (v) => {
		const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
		if (!s) return 'unknown'
		// 先判「高」（含「中高」/high/medium-high），再判「中」（含「中低」/medium-low），
		// 最后才判纯「低」，避免 includes('低') 抢先把「中低」误判为 low（低估风险）。
		if (s === 'high' || s === 'medium-high' || s.includes('高')) return 'high'
		if (s === 'medium' || s === 'medium-low' || s.includes('中')) return 'medium'
		if (s === 'low' || s.includes('低')) return 'low'
		return 'unknown'
	}
	const normalizedTotalCreditLine = safeNum(pick(ds.total_credit_line, ds.totalCreditLine, ds.总授信额度))
	const normalizedTotalDebt = safeNum(pick(ds.total_debt, ds.totalDebt, ds.总负债))
	const normalizedDebtRatioPct = (() => {
		const explicit = safeNum(pick(ds.debt_ratio_pct, ds.debtRatioPct, ds.负债率), null)
		if (explicit != null && explicit >= 0) return explicit
		return normalizedTotalCreditLine > 0 && normalizedTotalDebt != null
			? Math.round((normalizedTotalDebt / normalizedTotalCreditLine) * 10000) / 100
			: null
	})()

	return {
		basic_info: {
			name: safeStr(pick(bi.name, bi.real_name, bi.姓名)),
			id_card: safeStr(pick(bi.id_card, bi.idCard, bi.身份证号)),
			report_date: safeStr(pick(bi.report_date, bi.reportDate, bi.报告日期)),
			report_no: safeStr(pick(bi.report_no, bi.reportNo, bi.报告编号))
		},
		credit_score_estimate: {
			score: safeNum(pick(src?.credit_score_estimate?.score, src?.creditScoreEstimate?.score)),
			level: safeStr(pick(src?.credit_score_estimate?.level, src?.creditScoreEstimate?.level)),
			basis: safeStr(pick(src?.credit_score_estimate?.basis, src?.creditScoreEstimate?.basis))
		},
		debt_summary: {
			total_credit_line: normalizedTotalCreditLine,
			used_credit: safeNum(pick(ds.used_credit, ds.usedCredit, ds.已用授信)),
			loan_balance: safeNum(pick(ds.loan_balance, ds.loanBalance, ds.贷款余额)),
			total_debt: normalizedTotalDebt,
			available_credit: safeNum(pick(ds.available_credit, ds.availableCredit, ds.剩余额度)),
			debt_ratio_pct: normalizedDebtRatioPct
		},
		overdue_summary: {
			current_overdue_count: safeCount(pick(os.current_overdue_count, os.currentOverdueCount, os.当前逾期笔数)),
			current_overdue_amount: safeNum(pick(os.current_overdue_amount, os.currentOverdueAmount, os.当前逾期金额)),
			max_overdue_days: safeNum(pick(os.max_overdue_days, os.maxOverdueDays, os.最大逾期天数)),
			m1_count: safeCount(pick(os.m1_count, os.m1Count)),
			m2_count: safeCount(pick(os.m2_count, os.m2Count)),
			m3_plus_count: safeCount(pick(os.m3_plus_count, os.m3Count, os.m3_plus)),
			consecutive_overdue_3: safeBool(pick(os.consecutive_overdue_3, os.consecutiveOverdue3, os.连三)),
			cumulative_overdue_6: safeBool(pick(os.cumulative_overdue_6, os.cumulativeOverdue6, os.累六)),
			total_overdue_24m: safeCount(pick(os.total_overdue_24m, os.totalOverdue24m))
		},
		query_records: {
			recent_1m: safeCount(pick(qr.recent_1m, qr.recent1m, qr.recent1Month, qr.近1月查询)),
			recent_3m: safeCount(pick(qr.recent_3m, qr.recent3m, qr.recent3Month, qr.近3月查询)),
			recent_6m: safeCount(pick(qr.recent_6m, qr.recent6m, qr.recent6Month, qr.近6月查询)),
			recent_12m: safeCount(pick(qr.recent_12m, qr.recent12m, qr.recent12Month, qr.近12月查询)),
			loan_query_1m: safeCount(pick(qr.loan_query_1m, qr.loanQuery1m, qr.近1月贷款审批查询)),
			card_query_1m: safeCount(pick(qr.card_query_1m, qr.cardQuery1m, qr.近1月信用卡审批查询))
		},
		credit_cards: {
			count: safeCount(pick(cc.count, cc.账户数)),
			total_limit: safeNum(pick(cc.total_limit, cc.totalLimit, cc.总额度)),
			used_amount: safeNum(pick(cc.used_amount, cc.usedAmount, cc.已用额度)),
			usage_rate_pct: safeNum(pick(cc.usage_rate_pct, cc.usageRatePct, cc.使用率)),
			overdue_count: safeCount(pick(cc.overdue_count, cc.overdueCount, cc.逾期账户数))
		},
		loan_accounts: {
			count: safeCount(pick(la.count, la.账户数)),
			total_loan_amount: safeNum(pick(la.total_loan_amount, la.totalLoanAmount, la.总贷款金额)),
			balance: safeNum(pick(la.balance, la.贷款余额)),
			monthly_payment: safeNum(pick(la.monthly_payment, la.monthlyPayment, la.月还款)),
			overdue_count: safeCount(pick(la.overdue_count, la.overdueCount, la.逾期账户数))
		},
		account_overview: {
			total_count: safeCount(pick(ao.total_count, ao.totalCount, ao.总账户数)),
			active_count: safeCount(pick(ao.active_count, ao.activeCount, ao.在用账户数)),
			settled_count: safeCount(pick(ao.settled_count, ao.settledCount, ao.已结清账户数)),
			oldest_account_years: safeNum(pick(ao.oldest_account_years, ao.oldestAccountYears, ao.最早账户年限)),
			avg_account_years: safeNum(pick(ao.avg_account_years, ao.avgAccountYears, ao.平均账龄))
		},
		public_records: {
			has_record: safeBool(pick(pr.has_record, pr.hasRecord, pr.有无不良公共记录)),
			items: safeArr(pick(pr.items, pr.记录))
		},
		guarantee_records: {
			has_guarantee: safeBool(pick(gr.has_guarantee, gr.hasGuarantee)),
			total_guarantee_amount: safeNum(pick(gr.total_guarantee_amount, gr.totalGuaranteeAmount)),
			guarantee_count: safeCount(pick(gr.guarantee_count, gr.guaranteeCount)),
			note: safeStr(pick(gr.note))
		},
		hidden_debt_analysis: {
			consumer_finance_count: safeCount(pick(hd.consumer_finance_count, hd.consumerFinanceCount)),
			revolving_credit_count: safeCount(pick(hd.revolving_credit_count, hd.revolvingCreditCount)),
			estimated_hidden_debt: safeNum(pick(hd.estimated_hidden_debt, hd.estimatedHiddenDebt)),
			multi_loan_risk: safeStr(pick(hd.multi_loan_risk, hd.multiLoanRisk)),
			note: safeStr(pick(hd.note))
		},
		behavior_tags: safeArr(pick(src.behavior_tags, src.behaviorTags)),
		risk_tags: safeArr(pick(src.risk_tags, src.riskTags)),
		six_dimensions: {
			// v7「无编造」：AI 未给出的维度保留 null（UI 显示「—」），不再以 0 回填。
			// 0 会被下游误读为「该维度最差分」。真实数值（含合法 0）仍原样保留。
			repayment_ability: safeNum(pick(sd.repayment_ability, sd.repaymentAbility, sd.偿债能力), null),
			credit_history: safeNum(pick(sd.credit_history, sd.creditHistory, sd.信用历史), null),
			debt_ratio: safeNum(pick(sd.debt_ratio, sd.debtRatio, sd.负债比例), null),
			query_frequency: safeNum(pick(sd.query_frequency, sd.queryFrequency, sd.查询频率), null),
			account_structure: safeNum(pick(sd.account_structure, sd.accountStructure, sd.账户结构), null),
			repayment_record: safeNum(pick(sd.repayment_record, sd.repaymentRecord, sd.还款记录), null)
		},
		risk_level: normalizeRiskLevel(pick(src.risk_level, src.riskLevel, src.风险等级)),
		suggestion: safeStr(pick(src.suggestion, src.建议)),
		debt_restructure_feasibility: safeStr(pick(src.debt_restructure_feasibility, src.debtRestructureFeasibility)),
		product_accessibility: {
			bank_mortgage: safeStr(pick(pa.bank_mortgage, pa.bankMortgage)),
			bank_consumer_loan: safeStr(pick(pa.bank_consumer_loan, pa.bankConsumerLoan)),
			bank_credit_card: safeStr(pick(pa.bank_credit_card, pa.bankCreditCard)),
			online_loan: safeStr(pick(pa.online_loan, pa.onlineLoan)),
			note: safeStr(pick(pa.note))
		},
		_source: fromV2 ? 'credit-report-v2' : 'ai-generic',
		_timestamp: new Date().toISOString(),
		...(fromV2
			? {
					credit_report_full: base,
					frontend_payload: base.frontend_payload,
					rule_engine_warnings: Array.isArray(base.rule_engine_warnings)
						? base.rule_engine_warnings
						: [],
					data_completeness:
						base.data_completeness ||
						(base.frontend_payload && base.frontend_payload.data_completeness) ||
						null
				}
			: {})
	}
}

function buildParsedFromCreditReportFull(cf, n) {
	const bi = n.basic_info || {}
	const o = n.overdue_summary || {}
	const q = n.query_records || {}
	const creditAccounts = []
	for (const r of cf.loan_details?.bank_loans || []) {
		creditAccounts.push(buildCreditAccountFromLoanRow(r, true))
	}
	for (const r of cf.loan_details?.non_bank_loans || []) {
		creditAccounts.push(buildCreditAccountFromLoanRow(r, false))
	}
	for (const c of cf.credit_card_details || []) {
		creditAccounts.push(buildCreditAccountFromCardRow(c))
	}
	const overdueRecords = []
	const levelCounts = [o.m1_count, o.m2_count, o.m3_plus_count].map(nonNegativeOrNull)
	const totalLevelCount = levelCounts.every((value) => value != null) ? levelCounts.reduce((sum, value) => sum + value, 0) : null
	const currentOverdueAmount = nonNegativeOrNull(o.current_overdue_amount)
	const splitAmt = totalLevelCount > 0 && currentOverdueAmount != null ? currentOverdueAmount / totalLevelCount : null
	const pushOverdue = (count, level, daysLo, daysHi) => {
		const parsedCount = nonNegativeOrNull(count)
		if (parsedCount == null) return
		const nPush = Math.max(0, Math.floor(parsedCount))
		const md = typeof o.max_overdue_days === 'number' && o.max_overdue_days > 0 ? o.max_overdue_days : daysHi
		for (let i = 0; i < nPush; i++) {
			const days = Math.min(Math.max(md, daysLo), daysHi)
			overdueRecords.push({
				bank: '汇总',
				accountType: '贷款',
				amount: splitAmt,
				days,
				level,
				date: '',
				repayMatrix: []
			})
		}
	}
	pushOverdue(o.m1_count, 'M1', 1, 30)
	pushOverdue(o.m2_count, 'M2', 31, 60)
	pushOverdue(o.m3_plus_count, 'M3+', 61, 9999)
	const q6 = nonNegativeOrNull(q.recent_6m)
	const q12 = nonNegativeOrNull(q.recent_12m)
	const qd = cf.query_analysis?.query_details
	const queryItems = Array.isArray(qd)
		? qd.map((row, i) => ({
				date: row.date || '',
				institution: row.institution || '',
				reason: row.reason || '',
				period: row.period || ''
			}))
		: []
	return {
		basicInfo: {
			name: bi.name || '',
			idCard: bi.id_card || '',
			reportDate: bi.report_date || '',
			reportNo: bi.report_no || ''
		},
		creditAccounts,
		overdueRecords,
		queryRecords: {
			recent1Month: nonNegativeOrNull(q.recent_1m),
			recent3Month: nonNegativeOrNull(q.recent_3m),
			recent6Month: q6,
			recent12Month: q12,
			details: [],
			queryItems
		},
		publicRecords: { hasRecord: explicitBooleanOrNull(n.public_records && n.public_records.has_record), items: (n.public_records && n.public_records.items) || [] },
		consecutiveOverdue: {
			hasLianSan: explicitBooleanOrNull(o.consecutive_overdue_3),
			hasLeiLiu: explicitBooleanOrNull(o.cumulative_overdue_6),
			triggered: typeof o.consecutive_overdue_3 === 'boolean' && typeof o.cumulative_overdue_6 === 'boolean'
				? o.consecutive_overdue_3 || o.cumulative_overdue_6
				: null,
			details: []
		},
		rawText: '[信用结构化V2]'
	}
}

export const buildParsedFromAINormalized = (n) => {
	if (n && n.credit_report_full && typeof n.credit_report_full === 'object') {
		const cf = n.credit_report_full
		if (cf.loan_details || (Array.isArray(cf.credit_card_details) && cf.credit_card_details.length)) {
			return buildParsedFromCreditReportFull(cf, n)
		}
	}
	if (!n || typeof n !== 'object') {
		return {
			basicInfo: {},
			creditAccounts: [],
			overdueRecords: [],
			queryRecords: { recent1Month: null, recent3Month: null, recent6Month: null, recent12Month: null, details: [], queryItems: [] },
			publicRecords: { hasRecord: null, items: [] },
			consecutiveOverdue: { hasLianSan: null, hasLeiLiu: null, triggered: null, details: [] },
			rawText: ''
		}
	}
	const o = n.overdue_summary || {}
	const q = n.query_records || {}
	const cc = n.credit_cards || {}
	const la = n.loan_accounts || {}
	const bi = n.basic_info || {}
	const a = n.account_overview || {}
	const oldestYears = typeof a.oldest_account_years === 'number' && a.oldest_account_years > 0 ? a.oldest_account_years : 0
	const openDate = (() => {
		if (!oldestYears) return ''
		const t = new Date()
		t.setFullYear(t.getFullYear() - Math.min(Math.floor(oldestYears), 80))
		return t.toISOString().slice(0, 10)
	})()
	const creditAccounts = []
	if ((cc.count || 0) > 0 || (cc.total_limit || 0) > 0 || (cc.used_amount || 0) > 0) {
		const overdueCount = nonNegativeOrNull(cc.overdue_count)
		creditAccounts.push({
			bank: '信用卡（AI视觉汇总）',
			accountType: '贷记卡',
			isLoan: false,
			limit: nonNegativeOrNull(cc.total_limit),
			balance: nonNegativeOrNull(cc.used_amount),
			loanAmount: null,
			status: overdueCount > 0 ? '逾期' : null,
			openDate,
			isSettled: null,
			repayMatrix: [],
			overdueDays: null,
			overdueAmount: null,
			overdueLevel: overdueCount == null ? 'unknown' : overdueCount > 0 ? 'M1' : 'none',
			isOverdue: overdueCount == null ? null : overdueCount > 0,
			monthlyPayment: null
		})
	}
	if ((la.count || 0) > 0 || (la.balance || 0) > 0 || (la.total_loan_amount || 0) > 0) {
		const overdueCount = nonNegativeOrNull(la.overdue_count)
		creditAccounts.push({
			bank: '贷款（AI视觉汇总）',
			accountType: '个人消费贷款',
			isLoan: true,
			limit: nonNegativeOrNull(la.total_loan_amount),
			balance: nonNegativeOrNull(la.balance),
			loanAmount: nonNegativeOrNull(la.total_loan_amount) ?? nonNegativeOrNull(la.balance),
			status: overdueCount > 0 ? '逾期' : null,
			openDate,
			isSettled: null,
			repayMatrix: [],
			overdueDays: null,
			overdueAmount: nonNegativeOrNull(o.current_overdue_amount),
			overdueLevel: overdueCount == null ? 'unknown' : overdueCount > 0 ? 'M1' : 'none',
			isOverdue: overdueCount == null ? null : overdueCount > 0,
			monthlyPayment: nonNegativeOrNull(la.monthly_payment)
		})
	}
	const overdueRecords = []
	const levelCounts = [o.m1_count, o.m2_count, o.m3_plus_count].map(nonNegativeOrNull)
	const totalLevelCount = levelCounts.every((value) => value != null) ? levelCounts.reduce((sum, value) => sum + value, 0) : null
	const currentOverdueAmount = nonNegativeOrNull(o.current_overdue_amount)
	const splitAmt = totalLevelCount > 0 && currentOverdueAmount != null ? currentOverdueAmount / totalLevelCount : null
	const pushOverdue = (count, level, daysLo, daysHi) => {
		const parsedCount = nonNegativeOrNull(count)
		if (parsedCount == null) return
		const nPush = Math.max(0, Math.floor(parsedCount))
		const md = typeof o.max_overdue_days === 'number' && o.max_overdue_days > 0 ? o.max_overdue_days : daysHi
		for (let i = 0; i < nPush; i++) {
			const days = Math.min(Math.max(md, daysLo), daysHi)
			overdueRecords.push({ bank: '汇总', accountType: '贷款', amount: splitAmt, days, level, date: '', repayMatrix: [] })
		}
	}
	pushOverdue(o.m1_count, 'M1', 1, 30)
	pushOverdue(o.m2_count, 'M2', 31, 60)
	pushOverdue(o.m3_plus_count, 'M3+', 61, 9999)
	const q6 = nonNegativeOrNull(q.recent_6m)
	const q12 = nonNegativeOrNull(q.recent_12m)
	return {
		basicInfo: { name: bi.name || '', idCard: bi.id_card || '', reportDate: bi.report_date || '', reportNo: bi.report_no || '' },
		creditAccounts,
		overdueRecords,
		queryRecords: { recent1Month: nonNegativeOrNull(q.recent_1m), recent3Month: nonNegativeOrNull(q.recent_3m), recent6Month: q6, recent12Month: q12, details: [], queryItems: [] },
		publicRecords: { hasRecord: explicitBooleanOrNull(n.public_records && n.public_records.has_record), items: (n.public_records && n.public_records.items) || [] },
		consecutiveOverdue: {
			hasLianSan: explicitBooleanOrNull(o.consecutive_overdue_3),
			hasLeiLiu: explicitBooleanOrNull(o.cumulative_overdue_6),
			triggered: typeof o.consecutive_overdue_3 === 'boolean' && typeof o.cumulative_overdue_6 === 'boolean'
				? o.consecutive_overdue_3 || o.cumulative_overdue_6
				: null,
			details: []
		},
		rawText: '[AI视觉分析]'
	}
}

export const aiToInternalDimensions = (aiResult) => {
	const o = aiResult.overdue_summary || {}
	const q = aiResult.query_records || {}
	const d = aiResult.debt_summary || {}
	const a = aiResult.account_overview || {}
	const cc = aiResult.credit_cards || {}
	const la = aiResult.loan_accounts || {}
	const hd = aiResult.hidden_debt_analysis || {}
	const safeRatio = (pct) => {
		const parsed = nonNegativeOrNull(pct)
		return parsed == null ? null : Math.min(Math.max(parsed / 100, 0), 2)
	}
	const cardOverdue = nonNegativeOrNull(cc.overdue_count)
	const loanOverdue = nonNegativeOrNull(la.overdue_count)
	const accountOverdue = cardOverdue != null && loanOverdue != null ? cardOverdue + loanOverdue : null
	const overdueCount = maxKnown(o.current_overdue_count, accountOverdue)
	const nonBankLoanCount = maxKnown(hd.consumer_finance_count, la.non_bank_count)
	const publicRecord = explicitBooleanOrNull(aiResult.public_records && aiResult.public_records.has_record)
	const hasLianSan = explicitBooleanOrNull(o.consecutive_overdue_3)
	const hasLeiLiu = explicitBooleanOrNull(o.cumulative_overdue_6)
	const m3Count = nonNegativeOrNull(o.m3_plus_count)
	const highRiskSignals = [hasLianSan, hasLeiLiu, m3Count == null ? null : m3Count > 0, publicRecord]
	return {
		totalCreditLine: d.total_credit_line,
		usedCardLimit: cc.used_amount,
		totalLoanBalance: la.balance,
		availableCredit: d.available_credit,
		totalDebt: d.total_debt,
		totalOverdueAmt: o.current_overdue_amount,
		debtRatio: safeRatio(d.debt_ratio_pct),
		cardUtilizationRate: safeRatio(cc.usage_rate_pct),
		overdueCount,
		maxOverdueDays: o.max_overdue_days,
		m1Count: o.m1_count,
		m2Count: o.m2_count,
		m3Count: o.m3_plus_count,
		hasLianSan,
		hasLeiLiu,
		hasPublicRecord: publicRecord,
		q1: q.recent_1m,
		q3: q.recent_3m,
		q6: q.recent_6m,
		q12: q.recent_12m,
		loanQueryCount: q.loan_query_1m,
		cardQueryCount: q.card_query_1m,
		totalAccountCount: a.total_count,
		activeAccountCount: a.active_count,
		settledAccountCount: a.settled_count,
		creditCardCount: cc.count,
		loanCount: la.count,
		nonBankLoanCount,
		oldestAccountYears: a.oldest_account_years,
		avgAccountYears: a.avg_account_years,
		monthlyPaymentTotal: la.monthly_payment,
		monthlyIncomeRatio: null,
		hasOverdue: overdueCount == null ? null : overdueCount > 0,
		hasM3Plus: m3Count == null ? null : m3Count > 0,
		isHighRisk: highRiskSignals.some((value) => value === true)
			? true
			: highRiskSignals.every((value) => value === false) ? false : null,
		debtRatioExceeds70: nonNegativeOrNull(d.debt_ratio_pct) == null ? null : nonNegativeOrNull(d.debt_ratio_pct) > 70,
		hasGuarantee: explicitBooleanOrNull(aiResult.guarantee_records?.has_guarantee),
		guaranteeAmount: nonNegativeOrNull(aiResult.guarantee_records?.total_guarantee_amount),
		hiddenDebtNote: aiResult.hidden_debt_analysis?.note || '',
		multiLoanRisk: aiResult.hidden_debt_analysis?.multi_loan_risk || '',
		estimatedHiddenDebt: nonNegativeOrNull(aiResult.hidden_debt_analysis?.estimated_hidden_debt),
		debtRestructureFeasibility: aiResult.debt_restructure_feasibility || ''
	}
}

export const aiToScores = (aiResult) => {
	// v5：仅输出四维（移除 偿债能力 / 负债比例），AI 上游若给出旧字段也不再回填
	// v7：AI 未给出的维度返回 null（下游 normalizeAdvisoryScores 保留 null，UI 显示「—」），
	//     不再以 0 回填——0 会被误读为"该维度最差分"，且 v7 已无保底分。
	const sd = aiResult.six_dimensions || {}
	const n = (v) => (typeof v === 'number' && !isNaN(v) && isFinite(v) ? v : null)
	return {
		'信用历史': n(sd.credit_history),
		'查询频率': n(sd.query_frequency),
		'账户结构': n(sd.account_structure),
		'还款记录': n(sd.repayment_record)
	}
}

export default {
	normalizeAIResult,
	buildParsedFromAINormalized,
	aiToInternalDimensions,
	aiToScores
}
