/**
 * 征信报告详情页：从 mapServerAnalyzeDataToClientAnalysis 统一结构派生展示数据
 */

import { getLiveTimeAnchor, parseYmdAsBeijing } from './beijingTime.js'
import { summarizeCreditCardUtilization } from './creditCardUtilization.js'
import {
	statusExplicitlyDeniesOverdue,
	statusIndicatesAbnormal,
	statusIndicatesActiveUnsettled,
	statusIndicatesOverdue,
	statusIndicatesSettled,
	statusIsUnknown
} from './creditStatus.js'
import { strictFiniteNumberOrNull, strictNonNegativeIntegerOrNull, strictNonNegativeNumberOrNull } from './strictNumber.js'

export const num = (x, def = 0) => {
	const parsed = strictFiniteNumberOrNull(x)
	return parsed == null ? def : parsed
}

/**
 * 展示/聚合用可空数值解析。缺失、null、空白串与布尔值保持 null；
 * 显式 0 则原样保留，避免把“未识别”混成已核验 0。
 */
export const numberOrNull = strictFiniteNumberOrNull

export const nonNegativeNumberOrNull = strictNonNegativeNumberOrNull

const firstNumberOrNull = (...values) => {
	for (const value of values) {
		const parsed = numberOrNull(value)
		if (parsed != null) return parsed
	}
	return null
}

const firstNonNegativeNumberOrNull = (...values) => {
	for (const value of values) {
		const parsed = nonNegativeNumberOrNull(value)
		if (parsed != null) return parsed
	}
	return null
}

const firstNonNegativeIntegerOrNull = (...values) => {
	for (const value of values) {
		const parsed = strictNonNegativeIntegerOrNull(value)
		if (parsed != null) return parsed
	}
	return null
}

/**
 * 整数千分位分组（手写，不依赖 Number.prototype.toLocaleString）。
 * 部分手机浏览器的 WebKit 引擎缺少完整 ICU/zh-CN locale 数据，
 * toLocaleString('zh-CN') 可能退化为无分隔符甚至抛错；此处保证多端一致输出。
 */
export const groupThousands = (n) => {
	const parsed = numberOrNull(n)
	if (parsed == null) return '—'
	const neg = parsed < 0
	const s = String(Math.abs(Math.round(parsed)))
	const grouped = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
	return neg ? '-' + grouped : grouped
}

export function isBankInstitution(name) {
	const s = String(name || '').trim()
	if (!s) return false
	return /银行|农商|信用社|邮储|农村商业|村镇银行|合作银行/i.test(s)
}

const EXPLICIT_BANK_KIND = /^(?:bank|bank_loan|banking|commercial_bank|rural_bank)$/i
const EXPLICIT_NON_BANK_KIND = /^(?:non_?bank|nonbank|nonbanking|non_?bank_loan|consumer_finance|micro_?loan)$/i
const EXPLICIT_UNKNOWN_KIND = /^(?:unknown|other|unclassified|unspecified)$/i
const LEGACY_NON_BANK_INSTITUTION = /消费金融|汽车金融|小额贷款|小贷|贷款公司|信托|融资租赁|金融租赁|担保|保理|网贷|典当|互联网金融/i

/**
 * 规范机构分类。显式字段优先；名称正则只用于没有显式分类的旧数据。
 * 返回值固定为 bank / non_bank / unknown，未知机构不再默认归入非银。
 */
export function normalizeInstitutionKind(explicitKind, institutionName = '') {
	const hasExplicit = explicitKind !== undefined && explicitKind !== null && String(explicitKind).trim() !== ''
	if (hasExplicit) {
		const raw = String(explicitKind).normalize('NFKC').trim()
		const normalized = raw.toLowerCase().replace(/[\s-]+/g, '_')
		if (EXPLICIT_NON_BANK_KIND.test(normalized) || /非银行|非银|消费金融|汽车金融|小额贷款|小贷|信托|融资租赁|网贷/.test(raw)) return 'non_bank'
		if (EXPLICIT_BANK_KIND.test(normalized) || /^(?:银行|银行机构|商业银行|农村银行|村镇银行|农商行|信用社)$/.test(raw)) return 'bank'
		if (EXPLICIT_UNKNOWN_KIND.test(normalized) || /^(?:未知|其他|未分类|未说明)$/.test(raw)) return 'unknown'
		return 'unknown'
	}
	const name = String(institutionName || '').trim()
	if (!name) return 'unknown'
	if (LEGACY_NON_BANK_INSTITUTION.test(name)) return 'non_bank'
	if (isBankInstitution(name)) return 'bank'
	return 'unknown'
}

export function parseIdCardAgeGender(idCard) {
	const raw = String(idCard || '').replace(/\s/g, '')
	let digits = ''
	if (/^\d{17}[\dXx]$/.test(raw)) digits = raw
	else if (raw.length >= 14 && /^\d/.test(raw)) {
		const m = raw.match(/(\d{17}[\dXx]|\d{15})/)
		if (m) digits = m[1]
	}
	if (digits.length !== 18 && digits.length !== 15) return { age: null, gender: '' }
	let birthStr = ''
	if (digits.length === 18) birthStr = digits.slice(6, 14)
	else birthStr = '19' + digits.slice(6, 12)
	const y = parseInt(birthStr.slice(0, 4), 10)
	const mo = parseInt(birthStr.slice(4, 6), 10) - 1
	const d = parseInt(birthStr.slice(6, 8), 10)
	if (!Number.isFinite(y) || mo < 0 || mo > 11 || d < 1) return { age: null, gender: '' }
	const birth = new Date(y, mo, d)
	const today = getLiveTimeAnchor()
	let age = today.getFullYear() - birth.getFullYear()
	const m = today.getMonth() - birth.getMonth()
	if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age -= 1
	let gender = ''
	if (digits.length === 18) {
		const g = parseInt(digits.charAt(16), 10)
		gender = g % 2 === 1 ? '男' : '女'
	}
	return { age: age >= 0 && age < 130 ? age : null, gender }
}

// ── 详情页纯展示/格式化辅助（从 detail.uvue 抽出，集中维护、可单测） ──

/** 查询行日期格式化为 YYYY-MM-DD（解析失败回退原始字段） */
export function fmtQueryRowDate(row) {
	const r = row || {}
	const dt = parseQueryItemDate(r)
	if (!dt) return String(r.date || r.query_date || r.queryDate || '—').slice(0, 10)
	return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

/** 借款轨迹金额：≥1万显示「x.x万」，否则千分位整数 */
export function formatTrailAmount(amt) {
	const v = nonNegativeNumberOrNull(amt)
	if (v == null) return '—'
	if (v >= 10000) return (v / 10000).toFixed(1) + '万'
	return groupThousands(v)
}

/** 带单位的借款金额：≥1万显示「X.X万元」，否则「N元」（避免出现「X.X万 元」重复单位） */
export function formatTrailAmountUnit(amt) {
	const v = nonNegativeNumberOrNull(amt)
	if (v == null) return '—'
	if (v >= 10000) return (v / 10000).toFixed(1) + '万元'
	return groupThousands(v) + '元'
}

/** 数据完整度等级 → 颜色 */
export function completenessGradeColor(grade) {
	const g = String(grade || '').toUpperCase()
	if (g === 'A' || g === 'AA' || g === 'AAA') return '#16a34a'
	if (g === 'B') return '#f59e0b'
	if (g === 'C') return '#f97316'
	return '#C62828'
}

/** 原文长度 → 「x字 / xk字 / x.x万字」 */
export function formatTextLen(n) {
	const v = nonNegativeNumberOrNull(n)
	if (v == null) return '—'
	if (v >= 10000) return (v / 10000).toFixed(1) + '万字'
	if (v >= 1000) return (v / 1000).toFixed(1) + 'k 字'
	return v + ' 字'
}

/** 风险卡片 class */
export function riskCardClass(level) {
	const lv = String(level || '')
	if (lv === '风险') return 'risk-card risk-card-high'
	if (lv === '警告') return 'risk-card risk-card-warn'
	if (lv === '信息') return 'risk-card risk-card-good'
	return 'risk-card risk-card-info'
}

/** 风险徽标英文文案 */
export function riskBadgeText(level) {
	const lv = String(level || '')
	if (lv === '风险') return 'High'
	if (lv === '警告') return 'Warn'
	if (lv === '信息') return 'OK'
	return 'Info'
}

/** 同位对比状态 class */
export function peerStatusClass(status) {
	if (status === 'better') return 'peer-bar-better'
	if (status === 'worse') return 'peer-bar-worse'
	return 'peer-bar-avg'
}

/** 同位对比进度条宽度（百分比字符串）。下沉计算，避免在 UVUE 模板内使用全局 Math。 */
export function peerBarWidth(p) {
	const ratio = p ? num(p.bar_ratio) : 0
	const pct = Math.max(4, Math.round(ratio * 100))
	return pct + '%'
}

/** 同位对比状态文案 */
export function peerStatusText(status) {
	if (status === 'better') return '优于多数'
	if (status === 'worse') return '弱于多数'
	return '与多数持平'
}

/** 行动清单等级圆点 class */
export function planLevelClass(level) {
	const lv = String(level || '')
	if (lv === '风险') return 'plan-dot plan-dot-high'
	if (lv === '警告') return 'plan-dot plan-dot-warn'
	if (lv === '信息') return 'plan-dot plan-dot-good'
	return 'plan-dot plan-dot-info'
}

/** 风险等级徽标 class（WXSS 不支持中文选择器，统一 ASCII slug） */
export function riskBadgeClass(level) {
	const t = String(level == null ? '' : level).trim()
	if (/极低|^低|低风险/.test(t) && !/降低/.test(t)) return 'risk-lv-low'
	if (/极高|^高|高风险/.test(t)) return 'risk-lv-high'
	return 'risk-lv-mid'
}

/** 命中项等级 class */
export function hitLevelClass(level) {
	const t = String(level == null ? '' : level).trim()
	if (t.indexOf('风险') >= 0) return 'hit-lv-risk'
	if (t.indexOf('优质') >= 0) return 'hit-lv-good'
	return 'hit-lv-tip'
}

/** 贷款状态 class */
export function loanStatusClass(status) {
	const t = String(status == null ? '' : status).trim()
	if (t === '正常') return 'loan-st-normal'
	if (statusIndicatesAbnormal(t)) return 'loan-st-bad'
	return 'loan-st-other'
}

/** 疑似放款列 class */
export function disburseClass(val) {
	if (val == null || val === '') return ''
	const s = String(val).trim()
	if (s === '--' || s === '—' || s === 'null') return ''
	if (/\d/.test(s) && /元/.test(s)) return 'd-red d-red-strong'
	return 'd-red d-red-strong'
}

/** 信用卡行使用率（%） */
export function ccRowUsagePct(item) {
	if (!item) return null
	if (item.usage_pct != null && item.usage_pct !== '') {
		// 兼容比率误填：0~1 之间视为比率（0.85→85%），>=1 视为已是百分比
		const p = numberOrNull(item.usage_pct)
		if (p == null || p < 0) return null
		return Math.round(p > 0 && p < 1 ? p * 100 : p)
	}
	const lim = numberOrNull(item.credit_limit)
	const used = numberOrNull(item.used_limit)
	if (lim == null || used == null || lim <= 0 || used < 0) return null
	return Math.round((used / lim) * 100)
}

/** 信用卡行是否高使用率（>70%） */
export function ccRowUsageHigh(item) {
	const usage = ccRowUsagePct(item)
	return usage != null && usage > 70
}

/** 信用卡占比条宽度（百分比字符串，封顶 100%）。下沉计算，避免模板内 Math。 */
export function ccRowBarWidth(item) {
	const usage = ccRowUsagePct(item)
	return `${usage == null ? 0 : Math.min(100, usage)}%`
}

/** 信用卡行去重 key */
export function ccRowKey(item) {
	if (!item) return ''
	return `${item.institution}|${item.credit_limit}|${item.used_limit}`
}

/** 金额 → 千分位整数元（空值返回 --） */
export function formatYuan(val) {
	const v = numberOrNull(val)
	if (v == null) return '--'
	return groupThousands(v)
}

/** 金额 → 万元（整除不带小数，否则一位） */
export function formatWan(val) {
	const v = nonNegativeNumberOrNull(val)
	if (v == null) return '--'
	const w = v / 10000
	const dec = Math.abs(v % 10000) < 1e-6 ? 0 : 1
	return w.toFixed(dec)
}

/** 账户按机构名排序的比较器（纯函数，供贷款列表稳定排序） */
const compareInstitutionName = (left, right) => String(left || '').localeCompare(
	String(right || ''),
	'zh-Hans-CN-u-co-pinyin'
)

export function accountSortName(a, b) {
	return compareInstitutionName(a && a.bank, b && b.bank)
}

/** 汇总一组贷款的余额与月供（纯聚合） */
export function subtotalMappedLoans(list) {
	let bal = 0
	let monthly = 0
	for (const a of (Array.isArray(list) ? list : [])) {
		bal += num(a && a.balance)
		monthly += num(a && a.monthlyPayment)
	}
	return { bal, monthly }
}

/** 风险命中的等级归一化：风险 / 警告 / 提示（纯分类） */
export function riskLevelBucket(hit) {
	const level = String((hit && hit.level) || '')
	const severity = num(hit && hit.severity, 1)
	if (level === '风险' || severity >= 4) return '风险'
	if (level === '警告' || severity >= 3) return '警告'
	return '提示'
}

export function splitLoanAccountsByBank(accounts) {
	const loans = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.isLoan === true)
	let bankAmt = 0
	let bankCnt = 0
	let nbAmt = 0
	let nbCnt = 0
	for (const a of loans) {
		const bal = num(a.balance) + num(a.loanAmount) > 0 ? num(a.balance || a.loanAmount) : num(a.balance)
		const amt = bal > 0 ? bal : num(a.loanAmount || a.limit)
		if (isBankInstitution(a.bank)) {
			bankAmt += amt
			bankCnt += 1
		} else {
			nbAmt += amt
			nbCnt += 1
		}
	}
	return { bankAmt, bankCnt, nbAmt, nbCnt, loans }
}

const firstValue = (...values) => values.find((v) => v !== undefined && v !== null && v !== '')
const asObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const asArr = (v) => (Array.isArray(v) ? v : [])
const readNum = (...values) => firstNumberOrNull(...values) ?? 0
const REVIEW_LOAN_KEY = 'loan-review'

const formatKnownNonNegativeMoney = (value) => {
	const amount = nonNegativeNumberOrNull(value)
	if (amount == null) return '—'
	if (amount === 0) return '¥ 0'
	if (amount >= 10000) return `¥ ${(amount / 10000).toFixed(amount >= 100000 ? 0 : 1)}万`
	return `¥ ${groupThousands(amount)}`
}

export function buildGuaranteeRowsForDetail(items) {
	return asArr(items).slice(0, 5).map((item, index) => {
		const row = asObj(item)
		const rawAmount = firstValue(row.amount, row.balance, row.guarantee_amount)
		return {
			key: `gua_${index}`,
			title: String(firstValue(row.institution, row.bank, row.org, '担保记录')),
			desc: String(firstValue(row.desc, row.detail, row.type, row.status, '对外担保信息')),
			amount: formatKnownNonNegativeMoney(rawAmount),
			amountKnown: nonNegativeNumberOrNull(rawAmount) != null
		}
	})
}

function riskDetailText(hit) {
	const r = asObj(hit)
	return [
		firstValue(r.bucket, r.level, r.risk_level, r.riskLevel, r.type, r.grade, r.status),
		firstValue(r.title, r.name, r.tag, r.rule_name, r.ruleName),
		firstValue(r.detail, r.desc, r.description, r.reason, r.message)
	].filter(Boolean).join(' ')
}

export function riskHitBucket(hit) {
	const r = asObj(hit)
	const severity = readNum(r.severity, r.weight)
	const rawLevel = String(firstValue(r.bucket, r.level, r.risk_level, r.riskLevel, r.type, r.grade, r.status, '') || '').trim()
	const rawLower = rawLevel.toLowerCase()
	const text = riskDetailText(hit)
	if ((/^(low|info|tip|normal|ok|good)$/.test(rawLower) || /无风险|低风险|较低|正常|良好|优质|提示/.test(rawLevel)) && severity < 3) return 'info'
	if (/^(high|critical|severe|danger|risk|red)$/.test(rawLower) || /^(风险|高|高风险|严重|重大|高危)$/.test(rawLevel) || /极高|高风险|严重|重大|高危/.test(text) || severity >= 4) return 'high'
	if (/^(medium|middle|warn|warning|yellow)$/.test(rawLower) || /^(警告|中|中风险|关注|较高)$/.test(rawLevel) || /警告|中风险|中等|关注|较高/.test(text) || severity >= 3) return 'warn'
	return 'info'
}

export function riskHitLevelText(bucket) {
	if (bucket === 'high') return '高风险'
	if (bucket === 'warn') return '警告'
	return '提示'
}

function safeRiskKey(value) {
	return String(value || 'risk').replace(/\s+/g, '').slice(0, 28) || 'risk'
}

export function normalizeRiskHitForDetail(item, index = 0) {
	const r = asObj(item)
	const severity = readNum(r.severity, r.weight, 0)
	const bucket = riskHitBucket({ ...r, severity })
	const title = String(firstValue(r.title, r.name, r.tag, r.rule_name, r.ruleName, '风险提示') || '风险提示').trim()
	const detail = String(firstValue(r.detail, r.desc, r.description, r.reason, r.message, '建议结合原始信用报告进一步核对。') || '建议结合原始信用报告进一步核对。').trim()
	const ruleName = String(firstValue(r.rule_name, r.ruleName, r.code, '') || '').trim()
	return {
		key: `risk_${index}_${bucket}_${safeRiskKey(title)}`,
		title,
		detail,
		level: riskHitLevelText(bucket),
		bucket,
		severity: severity || (bucket === 'high' ? 4 : bucket === 'warn' ? 3 : 1),
		ruleName
	}
}

export function normalizeRiskHitsForDetail(items) {
	const seen = new Map()
	asArr(items).forEach((item, index) => {
		const hit = normalizeRiskHitForDetail(item, index)
		const dedupeKey = `${hit.ruleName}|${hit.title}|${hit.detail}`.toLowerCase().replace(/\s+/g, '')
		const existing = seen.get(dedupeKey)
		if (!existing || hit.severity > existing.severity) seen.set(dedupeKey, hit)
	})
	return [...seen.values()].map((hit, index) => ({ ...hit, key: `risk_${index}_${hit.bucket}_${safeRiskKey(hit.title)}` }))
}

export function summarizeRiskHitsByBucket(hits) {
	const out = { high: 0, warn: 0, info: 0, total: 0 }
	asArr(hits).forEach((hit) => {
		const bucket = (hit && hit.bucket) || riskHitBucket(hit)
		if (bucket === 'high') out.high += 1
		else if (bucket === 'warn') out.warn += 1
		else out.info += 1
		out.total += 1
	})
	return out
}

function accountBool(value, fallback = false) {
	if (typeof value === 'boolean') return value
	if (typeof value === 'number') {
		if (value === 1) return true
		if (value === 0) return false
		return fallback
	}
	if (typeof value !== 'string') return fallback
	const s = value.trim().toLowerCase()
	if (!s) return fallback
	if (/^(false|no|n|0|none|null)$/i.test(s) || /否|无|没有|正常/.test(s) || isNegativeOverdueStatus(s)) return false
	if (/^(true|yes|y|1|ok)$/i.test(s) || /是|有|存在/.test(s) || statusIndicatesOverdue(s)) return true
	return fallback
}

/** “未逾期 / 无逾期 / 从未逾期”等否定表述不能命中“逾期”子串。 */
export function isNegativeOverdueStatus(value) {
	return statusExplicitlyDeniesOverdue(value)
}

/**
 * 将账户状态拆分为 overdue 与 otherAbnormal。明确 overdueDays>0 或显式 true 优先，
 * 其余情况才读取状态文本；这让“逾期”和“呆账/冻结”等其他异常可以分别统计。
 */
export function classifyAccountStatus({ status = '', overdueDays = null, explicitOverdue, explicitAbnormal } = {}) {
	const text = String(status == null ? '' : status)
	const explicit = accountBool(explicitOverdue, null)
	const parsedDays = nonNegativeNumberOrNull(overdueDays)
	const overdueByText = statusIndicatesOverdue(text)
	const overdueDeniedByText = statusExplicitlyDeniesOverdue(text) || /^(?:normal|performing|正常|结清|已结清|关闭|销户|注销)$/i.test(text.trim())
	const overdueKnown = explicit !== null || parsedDays !== null || overdueByText || overdueDeniedByText
	const overdue = explicit === true || (parsedDays != null && parsedDays > 0) || overdueByText
	const abnormalFlag = accountBool(explicitAbnormal, null)
	const otherAbnormal = /呆账|不良|代偿|核销|止付|冻结|关注|次级|可疑|损失/i.test(text) || (abnormalFlag === true && !overdue)
	return {
		overdue,
		overdueKnown,
		otherAbnormal,
		abnormal: overdue || otherAbnormal,
		abnormalKnown: overdueKnown || abnormalFlag !== null || otherAbnormal || statusIndicatesSettled(text)
	}
}

function cleanAccountText(value, fallback = '') {
	const s = String(value == null ? '' : value).trim()
	return s || fallback
}

function normalizeAccountDate(value, fallback = '') {
	const s = cleanAccountText(value, '')
	if (!s) return fallback
	return s.replace(/[./]/g, '-').slice(0, 10) || fallback
}

function formatAccountBriefMoney(value) {
	const n = numberOrNull(value)
	if (n == null) return ''
	if (Math.abs(n) < 0.5) return '¥ 0'
	const sign = n < 0 ? '-' : ''
	const abs = Math.abs(n)
	if (abs >= 10000) return `${sign}¥ ${(abs / 10000).toFixed(abs >= 100000 ? 0 : 1)}万`
	return `${sign}¥ ${groupThousands(abs)}`
}

function accountUsagePct(balance, limit) {
	const lim = numberOrNull(limit)
	const used = numberOrNull(balance)
	if (lim == null || used == null || lim <= 0) return null
	return Math.max(0, Math.min(999, Math.round((used / lim) * 100)))
}

export function normalizeAccountForDetail(acc, index = 0) {
	const rawAcc = asObj(acc)
	const product = cleanAccountText(firstValue(
		rawAcc.accountType,
		rawAcc.account_type,
		rawAcc.loanType,
		rawAcc.loan_type,
		rawAcc.type,
		rawAcc.product,
		rawAcc.productName,
		rawAcc.product_name,
		rawAcc.name
	), '信贷账户')
	const productText = String(product || '')
	const explicitLoan = accountBool(firstValue(rawAcc.isLoan, rawAcc.is_loan, rawAcc.loanAccount, rawAcc.isLoanAccount), false)
	const explicitCard = accountBool(firstValue(rawAcc.isCreditCard, rawAcc.is_credit_card, rawAcc.isCard, rawAcc.is_card), false)
	const looksCard = /信用卡|贷记卡|准贷记卡|card/i.test(productText)
	const looksLoan = /贷|贷款|借款|按揭|分期|融资|小额/i.test(productText) && !looksCard
	const isLoan = explicitLoan || (!explicitCard && looksLoan)
	const institution = cleanAccountText(firstValue(
		rawAcc.bank,
		rawAcc.institution,
		rawAcc.org,
		rawAcc.creditor,
		rawAcc.lender,
		rawAcc.company,
		rawAcc.name
	), '未知机构')
	const balance = firstNonNegativeNumberOrNull(rawAcc.balance, rawAcc.remainingAmount, rawAcc.remaining_amount, rawAcc.used_limit, rawAcc.usedLimit, rawAcc.amount)
	const limit = firstNonNegativeNumberOrNull(rawAcc.limit, rawAcc.creditLimit, rawAcc.credit_limit, rawAcc.loanAmount, rawAcc.loan_amount, rawAcc.principal)
	const monthly = firstNonNegativeNumberOrNull(rawAcc.monthlyPayment, rawAcc.monthly_payment, rawAcc.monthlyPay, rawAcc.monthly_pay)
	const overdueDaysRaw = firstNonNegativeNumberOrNull(rawAcc.overdueDays, rawAcc.overdue_days, rawAcc.maxOverdueDays, rawAcc.max_overdue_days)
	const overdueDays = overdueDaysRaw == null ? null : Math.max(0, Math.round(overdueDaysRaw))
	const rawStatus = firstValue(rawAcc.status, rawAcc.state, rawAcc.accountStatus, rawAcc.account_status)
	const status = typeof rawStatus === 'string' ? rawStatus.normalize('NFKC').trim() : ''
	const displayStatus = statusIsUnknown(status) ? '' : status
	const statusSource = `${status} ${productText}`
	const statusClassification = classifyAccountStatus({
		status,
		overdueDays,
		explicitOverdue: firstValue(rawAcc.isOverdue, rawAcc.is_overdue, rawAcc.overdue),
		explicitAbnormal: firstValue(rawAcc.isAbnormal, rawAcc.is_abnormal, rawAcc.abnormal)
	})
	const { abnormal, abnormalKnown, overdue, overdueKnown, otherAbnormal } = statusClassification
	const explicitSettled = accountBool(firstValue(rawAcc.isSettled, rawAcc.is_settled, rawAcc.settled), null)
	const settledByText = statusIndicatesSettled(status)
	const activeByText = statusIndicatesActiveUnsettled(status)
	const lifecycleKnown = explicitSettled !== null || settledByText || activeByText
	const settled = settledByText || explicitSettled === true
		? true
		: (explicitSettled === false || activeByText) ? false : null
	const active = settled == null ? null : !settled
	const statusText = abnormal
		? (overdueDays > 0 ? `逾期 ${overdueDays} 天` : (displayStatus || '异常'))
		: (settled === true ? '已结清' : (displayStatus || '待核对'))
	const openDate = normalizeAccountDate(firstValue(rawAcc.openDate, rawAcc.open_date, rawAcc.startDate, rawAcc.start_date), '日期待核对')
	const endDate = normalizeAccountDate(firstValue(rawAcc.endDate, rawAcc.end_date, rawAcc.dueDate, rawAcc.due_date), '')
	// These fields are independent account metadata, not presentation-only raw data.
	// Keep them at the normalized top level so a later utilization aggregation can
	// still distinguish currencies, explicit shared-limit groups and separate cards.
	const currency = cleanAccountText(firstValue(rawAcc.currency, rawAcc.currency_code, rawAcc.currencyCode), '')
	const cardTail = cleanAccountText(firstValue(rawAcc.cardTail, rawAcc.card_tail, rawAcc.tailNumber, rawAcc.tail_number, rawAcc.last4), '')
	const sharedCreditGroup = cleanAccountText(firstValue(rawAcc.sharedCreditGroup, rawAcc.shared_credit_group), '')
	const utilizationGroup = cleanAccountText(firstValue(rawAcc.utilizationGroup, rawAcc.utilization_group), '')
	const rawUtilizationIncluded = firstValue(rawAcc.utilizationIncluded, rawAcc.utilization_included)
	const parsedUtilizationIncluded = accountBool(rawUtilizationIncluded, null)
	const utilizationIncluded = typeof parsedUtilizationIncluded === 'boolean' ? parsedUtilizationIncluded : undefined
	const utilizationNote = cleanAccountText(firstValue(rawAcc.utilizationNote, rawAcc.utilization_note), '')
	const explicitInstitutionKind = firstValue(
		rawAcc.institutionKind,
		rawAcc.institution_kind,
		rawAcc.institutionType,
		rawAcc.institution_type,
		rawAcc.orgType,
		rawAcc.org_type,
		rawAcc.lenderType,
		rawAcc.lender_type
	)
	const institutionKind = normalizeInstitutionKind(explicitInstitutionKind, institution)
	const usagePct = !isLoan ? accountUsagePct(balance, limit) : null
	const available = !isLoan && limit != null && balance != null ? Math.max(0, limit - balance) : null
	const highUsage = !isLoan && active === true && usagePct != null && usagePct >= 70
	const largeBalance = active === true && balance != null && balance >= 100000
	const detailParts = []
	if (monthly != null) detailParts.push(`月供 ${formatAccountBriefMoney(monthly)}`)
	if (limit != null) detailParts.push(`${isLoan ? '本金/额度' : '授信'} ${formatAccountBriefMoney(limit)}`)
	if (!isLoan && usagePct != null) detailParts.push(`使用率 ${usagePct}%`)
	if (!isLoan && available != null) detailParts.push(`可用 ${formatAccountBriefMoney(available)}`)
	if (endDate) detailParts.push(`到期 ${endDate}`)
	return {
		key: String(firstValue(rawAcc.id, rawAcc._id, rawAcc.accountId, rawAcc.account_id, `${institution}_${product}_${index}`)),
		institution,
		bank: institution,
		product,
		accountType: product,
		isLoan,
		category: isLoan ? 'loan' : 'card',
		categoryText: isLoan ? '贷款' : '信用卡',
		balance,
		balanceKnown: balance != null,
		limit,
		limitKnown: limit != null,
		loanAmount: limit,
		monthly,
		monthlyKnown: monthly != null,
		monthlyPayment: monthly,
		abnormal,
		abnormalKnown,
		overdue,
		overdueKnown,
		otherAbnormal,
		overdueDays,
		settled,
		active,
		lifecycleKnown,
		institutionKind,
		institutionKindText: institutionKind === 'bank' ? '银行' : institutionKind === 'non_bank' ? '非银' : '未分类',
		usagePct,
		available,
		highUsage,
		largeBalance,
		status: displayStatus || null,
		statusText,
		openDate,
		endDate,
		currency,
		cardTail,
		sharedCreditGroup,
		utilizationGroup,
		utilizationIncluded,
		utilizationNote,
		detailText: detailParts.length ? detailParts.join(' · ') : '额度、余额与状态待核对',
		raw: rawAcc
	}
}

export function summarizeAccountsForDetail(accounts) {
	const out = {
		total: 0,
		loan: 0,
		card: 0,
		abnormal: 0,
		abnormalKnown: true,
		overdue: 0,
		overdueKnown: true,
		otherAbnormal: 0,
		settled: 0,
		active: 0,
		activeKnown: true,
		lifecycleUnknown: 0,
		bank: 0,
		nonbank: 0,
		unknown: 0,
		highUsage: 0,
		highUsageKnown: true,
		largeBalance: 0,
		largeBalanceKnown: true,
		totalBalance: null,
		totalBalanceKnown: true,
		totalLimit: null,
		totalLimitKnown: true,
		totalMonthly: null,
		totalMonthlyKnown: true,
		activeBalance: null,
		activeBalanceKnown: true,
		activeLimit: null,
		activeLimitKnown: true,
		cardUsed: null,
		cardLimit: null,
		cardUsagePct: null,
		cardRawUsed: null,
		cardRawLimit: null,
		cardUtilizationStatus: 'not_applicable',
		cardUtilizationDecisionEligible: true,
		cardUtilizationGroupCount: 0,
		cardSharedGroupCount: 0,
		cardInferredSharedGroupCount: 0,
		cardForeignCurrencyAccountCount: 0,
		cardUnknownUtilizationAccountCount: 0,
		cardExcludedUtilizationAccountCount: 0
	}
	const activeCards = []
	let totalBalance = 0
	let totalLimit = 0
	let totalMonthly = 0
	let activeBalance = 0
	let activeLimit = 0
	let cardRawUsed = 0
	let cardRawLimit = 0
	let activeCardEvidenceKnown = true
	asArr(accounts).forEach((item, index) => {
		const account = item && item.category ? item : normalizeAccountForDetail(item, index)
		out.total += 1
		if (account.isLoan) out.loan += 1
		else out.card += 1
		if (account.abnormalKnown !== true) out.abnormalKnown = false
		if (account.overdueKnown !== true) out.overdueKnown = false
		if (account.abnormal || account.overdue) out.abnormal += 1
		if (account.overdue) out.overdue += 1
		if (account.otherAbnormal) out.otherAbnormal += 1
		if (account.settled === true) out.settled += 1
		else if (account.active === true) out.active += 1
		else {
			out.activeKnown = false
			out.lifecycleUnknown += 1
		}
		const institutionKind = normalizeInstitutionKind(
			firstValue(
				account.institutionKind,
				account.institution_kind,
				account.institutionType,
				account.institution_type,
				account.orgType,
				account.org_type,
				account.lenderType,
				account.lender_type
			),
			account.institution || account.bank
		)
		if (institutionKind === 'bank') out.bank += 1
		else if (institutionKind === 'non_bank') out.nonbank += 1
		else out.unknown += 1
		const balance = nonNegativeNumberOrNull(account.balance)
		const limit = nonNegativeNumberOrNull(account.limit)
		const monthly = nonNegativeNumberOrNull(account.monthly)
		if (balance == null) out.totalBalanceKnown = false
		else totalBalance += balance
		if (limit == null) out.totalLimitKnown = false
		else totalLimit += limit
		if (monthly == null) out.totalMonthlyKnown = false
		else totalMonthly += monthly
		if (account.highUsage) out.highUsage += 1
		if (account.largeBalance) out.largeBalance += 1
		if (account.active == null) {
			out.activeBalanceKnown = false
			out.activeLimitKnown = false
		} else if (account.active === true) {
			if (balance == null) out.activeBalanceKnown = false
			if (limit == null) out.activeLimitKnown = false
		}
		if (account.active === true) {
			if (balance != null) activeBalance += balance
			if (limit != null) activeLimit += limit
		}
		if (!account.isLoan && account.active == null) {
			activeCardEvidenceKnown = false
			out.highUsageKnown = false
		}
		if (!account.isLoan && account.active === true) {
			if (balance == null || limit == null) {
				activeCardEvidenceKnown = false
				out.highUsageKnown = false
			} else {
				cardRawUsed += balance
				cardRawLimit += limit
			}
			activeCards.push(account)
		}
		if (account.active == null || (account.active === true && balance == null)) out.largeBalanceKnown = false
	})
	if (out.total === 0) {
		out.abnormalKnown = false
		out.overdueKnown = false
		out.activeKnown = false
		out.highUsageKnown = false
		out.largeBalanceKnown = false
		out.totalBalanceKnown = false
		out.totalLimitKnown = false
		out.totalMonthlyKnown = false
		out.activeBalanceKnown = false
		out.activeLimitKnown = false
		activeCardEvidenceKnown = false
	}
	if (!out.abnormalKnown) out.abnormal = null
	if (!out.overdueKnown) out.overdue = null
	if (!out.activeKnown) {
		out.active = null
		out.settled = null
	}
	if (!out.highUsageKnown) out.highUsage = null
	if (!out.largeBalanceKnown) out.largeBalance = null
	out.totalBalance = out.totalBalanceKnown ? totalBalance : null
	out.totalLimit = out.totalLimitKnown ? totalLimit : null
	out.totalMonthly = out.totalMonthlyKnown ? totalMonthly : null
	out.activeBalance = out.activeBalanceKnown ? activeBalance : null
	out.activeLimit = out.activeLimitKnown ? activeLimit : null
	out.cardRawUsed = activeCardEvidenceKnown ? cardRawUsed : null
	out.cardRawLimit = activeCardEvidenceKnown ? cardRawLimit : null
	const cardUtilization = activeCardEvidenceKnown
		? summarizeCreditCardUtilization(activeCards)
		: {
			status: 'unknown', decisionEligible: false, totalUsed: 0, totalLimit: 0,
			utilizationGroupCount: 0, sharedGroupCount: 0, inferredSharedGroupCount: 0,
			foreignAccountCount: 0, unknownAccountCount: activeCards.length,
			excludedAccountCount: 0
		}
	if (activeCardEvidenceKnown) {
		out.cardUsed = cardUtilization.totalUsed
		out.cardLimit = cardUtilization.totalLimit
	}
	if (
		cardUtilization.activeAccountCount > 0 &&
		cardUtilization.decisionEligible === true &&
		cardUtilization.status !== 'unknown' &&
		out.activeBalanceKnown &&
		out.activeLimitKnown &&
		out.totalBalanceKnown &&
		out.totalLimitKnown
	) {
		out.activeBalance = Math.max(0, activeBalance - cardRawUsed + cardUtilization.totalUsed)
		out.activeLimit = Math.max(0, activeLimit - cardRawLimit + cardUtilization.totalLimit)
		out.totalBalance = Math.max(0, totalBalance - cardRawUsed + cardUtilization.totalUsed)
		out.totalLimit = Math.max(0, totalLimit - cardRawLimit + cardUtilization.totalLimit)
	}
	out.cardUtilizationGroupCount = cardUtilization.utilizationGroupCount
	out.cardSharedGroupCount = cardUtilization.sharedGroupCount
	out.cardInferredSharedGroupCount = cardUtilization.inferredSharedGroupCount
	out.cardForeignCurrencyAccountCount = cardUtilization.foreignAccountCount
	out.cardUnknownUtilizationAccountCount = cardUtilization.unknownAccountCount
	out.cardExcludedUtilizationAccountCount = cardUtilization.excludedAccountCount
	out.cardUtilizationStatus = cardUtilization.status
	out.cardUtilizationDecisionEligible = cardUtilization.decisionEligible
	out.cardUsagePct = activeCardEvidenceKnown && cardUtilization.decisionEligible
		? accountUsagePct(out.cardUsed, out.cardLimit)
		: null
	return out
}

export function filterAccountsForDetail(accounts, filter = 'all') {
	const list = asArr(accounts).filter(Boolean)
	const filtered = list.filter((account) => {
		if (filter === 'loan') return account.isLoan
		if (filter === 'card') return !account.isLoan
		if (filter === 'abnormal') return account.abnormal || account.overdue
		if (filter === 'overdue') return account.overdue
		if (filter === 'otherAbnormal') return account.otherAbnormal
		if (filter === 'active') return account.active === true
		if (filter === 'settled') return account.settled
		const institutionKind = normalizeInstitutionKind(
			firstValue(
				account.institutionKind,
				account.institution_kind,
				account.institutionType,
				account.institution_type,
				account.orgType,
				account.org_type,
				account.lenderType,
				account.lender_type
			),
			account.institution || account.bank
		)
		if (filter === 'bank') return institutionKind === 'bank'
		if (filter === 'nonbank') return institutionKind === 'non_bank'
		if (filter === 'unknown') return institutionKind === 'unknown'
		if (filter === 'highUsage') return account.highUsage
		if (filter === 'largeBalance') return account.largeBalance
		return true
	})
	return [...filtered].sort((a, b) => {
		const rank = (item) => (item && (item.abnormal || item.overdue) ? 0 : item && item.settled ? 2 : 1)
		const rankDelta = rank(a) - rank(b)
		if (rankDelta !== 0) return rankDelta
		const balanceDelta = num(b && b.balance) - num(a && a.balance)
		if (Math.abs(balanceDelta) > 0.5) return balanceDelta
		return compareInstitutionName(a && a.institution, b && b.institution)
	})
}
function segment(key, name, amount, count, color, extra = {}) {
	const parsedAmount = nonNegativeNumberOrNull(amount)
	const parsedCount = strictNonNegativeIntegerOrNull(count)
	return {
		key,
		name,
		amount: parsedAmount == null ? null : Math.max(0, parsedAmount),
		amountKnown: parsedAmount != null,
		count: parsedCount == null ? null : Math.max(0, Math.round(parsedCount)),
		countKnown: parsedCount != null,
		color,
		...extra
	}
}

function attachDebtMeta(segments, meta) {
	Object.defineProperty(segments, 'meta', {
		value: meta,
		enumerable: false,
		configurable: true
	})
	return segments
}

function finalizeDebtSegments(segments, expectedTotal = 0, meta = {}) {
	const clean = segments.filter((item) => item && (item.amount > 0 || item.count > 0 || (item.amountKnown && ['bank', 'nonbank', 'card'].includes(item.key))))
	const splitKnown = clean.every((item) => item.amountKnown)
	const splitTotal = splitKnown ? clean.reduce((total, item) => total + item.amount, 0) : null
	const expected = numberOrNull(expectedTotal)
	const componentsComplete = meta.componentsComplete !== false
	const total = expected != null
		? (splitTotal == null ? expected : Math.max(splitTotal, expected))
		: (componentsComplete && splitTotal != null ? splitTotal : null)
	const mapped = clean.map((item) => {
		const percent = total > 0 && item.amountKnown ? Math.round((item.amount / total) * 100) : null
		return {
			...item,
			percent,
			percentText: percent == null ? '—' : `${percent}%`
		}
	})
	return attachDebtMeta(mapped, {
		...meta,
		componentsComplete,
		total,
		splitTotal,
		remainder: total == null || splitTotal == null ? null : Math.max(0, total - splitTotal)
	})
}

function addReviewLoanSegment(segments, amount, reason) {
	const value = Math.max(0, readNum(amount))
	if (value <= 1) return 0
	const existing = segments.find((item) => item.key === REVIEW_LOAN_KEY)
	if (existing) {
		existing.amount += value
		existing.note = existing.note ? `${existing.note}；${reason}` : reason
		return value
	}
	segments.push(segment(REVIEW_LOAN_KEY, '待核对贷款', value, 0, '#64748B', {
		review: true,
		note: reason,
		countLabel: '机构待核对'
	}))
	return value
}

function debtSegmentsFromAlgorithm(algorithmReport) {
	const ar = asObj(algorithmReport)
	const breakdown = asObj(ar.breakdown)
	const creditDebt = asObj(ar.creditDebt)
	const bankLoan = asObj(breakdown.bankLoan)
	const nonBankLoan = asObj(breakdown.nonBankLoan)
	const otherLoan = asObj(breakdown.otherLoan)
	const highCards = asObj(breakdown.highLimitCards)
	const normalCards = asObj(breakdown.normalCards)
	const bankAmount = firstNonNegativeNumberOrNull(bankLoan.amount)
	const nonBankAmount = firstNonNegativeNumberOrNull(nonBankLoan.amount)
	const otherAmount = firstNonNegativeNumberOrNull(otherLoan.amount)
	const highCardAmount = firstNonNegativeNumberOrNull(highCards.amount)
	const normalCardAmount = firstNonNegativeNumberOrNull(normalCards.amount)
	const cardBreakdownAmount = highCardAmount != null && normalCardAmount != null
		? highCardAmount + normalCardAmount
		: null
	const bankCount = firstNonNegativeIntegerOrNull(bankLoan.count)
	const nonBankCount = firstNonNegativeIntegerOrNull(nonBankLoan.count)
	const otherCount = firstNonNegativeIntegerOrNull(otherLoan.count)
	const highCardCount = firstNonNegativeIntegerOrNull(highCards.count)
	const normalCardCount = firstNonNegativeIntegerOrNull(normalCards.count)
	const cardCount = highCardCount != null && normalCardCount != null ? highCardCount + normalCardCount : null
	const hasAnyKnownDetail = [bankAmount, nonBankAmount, otherAmount, cardBreakdownAmount, bankCount, nonBankCount, otherCount, cardCount]
		.some((value) => value != null)
	if (!hasAnyKnownDetail) return null

	const cardAmount = firstNonNegativeNumberOrNull(creditDebt.card, breakdown.cardTotal, cardBreakdownAmount)
	const loanComponentsComplete = [bankAmount, nonBankAmount, otherAmount].every((value) => value != null)
	const computedLoanTotal = loanComponentsComplete
		? bankAmount + nonBankAmount + otherAmount
		: null
	const loanTotal = firstNonNegativeNumberOrNull(creditDebt.loan, breakdown.loanTotal, computedLoanTotal)
	const computedTotal = loanTotal != null && cardAmount != null ? loanTotal + cardAmount : null
	const componentsComplete = loanComponentsComplete && cardAmount != null
	const total = firstNonNegativeNumberOrNull(creditDebt.total, breakdown.totalCreditDebt, breakdown.totalDebt, computedTotal)
	const segments = [
		segment('bank', '银行贷款', bankAmount, bankCount, '#C62828'),
		segment('nonbank', '非银贷款', nonBankAmount, nonBankCount, '#F97316'),
		segment('other', '其他贷款', otherAmount, otherCount, '#64748B'),
		segment('card', '信用卡已用', cardAmount, cardCount, '#16A34A')
	]
	let adjustmentAmount = 0
	if (loanTotal != null && computedLoanTotal != null) {
		adjustmentAmount += addReviewLoanSegment(segments, loanTotal - computedLoanTotal, '贷款余额高于机构明细合计')
	}
	if (total != null && loanTotal != null && cardAmount != null) {
		adjustmentAmount += addReviewLoanSegment(segments, total - loanTotal - cardAmount, '总负债高于贷款与信用卡合计')
	}
	const finalized = finalizeDebtSegments(segments, total, {
		source: 'algorithm',
		componentsComplete,
		adjustmentAmount,
		adjustmentReason: adjustmentAmount > 0 ? '报告总额与账户明细存在差额，已归入待核对贷款' : ''
	})
	return finalized
}

function debtSegmentsFromV2(creditReportV2) {
	const c = asObj(creditReportV2)
	const loanDetails = asObj(c.loan_details || c.loanDetails)
	const bank = asObj(loanDetails.subtotal_bank || loanDetails.subtotalBank)
	const nonBank = asObj(loanDetails.subtotal_non_bank || loanDetails.subtotalNonBank)
	const totalLoan = asObj(loanDetails.total)
	const creditDebt = asObj(c.credit_debt || c.creditDebt)
	const cards = asObj(creditDebt.credit_cards || creditDebt.creditCards || c.credit_cards || c.creditCards)
	const bankRows = asArr(loanDetails.bank_loans || loanDetails.bankLoans)
	const nonBankRows = asArr(loanDetails.non_bank_loans || loanDetails.nonBankLoans)
	const cardRows = asArr(c.credit_card_details || c.creditCardDetails)
	const sumNonEmptyRows = (rows, readValue) => {
		if (!rows.length) return null
		const values = rows.map((row) => nonNegativeNumberOrNull(readValue(row || {})))
		return values.every((value) => value != null)
			? values.reduce((sum, value) => sum + value, 0)
			: null
	}
	const bankRowsAmount = sumNonEmptyRows(bankRows, (row) => row.balance)
	const nonBankRowsAmount = sumNonEmptyRows(nonBankRows, (row) => row.balance)
	const cardRowsAmount = sumNonEmptyRows(cardRows, (row) => row.used_limit ?? row.usedLimit ?? row.balance)
	const bankAmount = firstNonNegativeNumberOrNull(bank.balance, bankRowsAmount)
	const nonBankAmount = firstNonNegativeNumberOrNull(nonBank.balance, nonBankRowsAmount)
	const cardAmount = firstNonNegativeNumberOrNull(cards.total_used, cards.totalUsed, cards.used_amount, cards.usedAmount, cardRowsAmount)
	if (bankAmount == null || nonBankAmount == null || cardAmount == null) return null
	const computedLoanTotal = bankAmount + nonBankAmount
	const loanTotal = firstNonNegativeNumberOrNull(totalLoan.balance, computedLoanTotal)
	const computedTotal = loanTotal + cardAmount
	const total = firstNonNegativeNumberOrNull(creditDebt.total_debt, creditDebt.totalDebt, computedTotal)
	const bankCount = firstNonNegativeIntegerOrNull(bank.count, bankRows.length > 0 ? bankRows.length : null)
	const nonBankCount = firstNonNegativeIntegerOrNull(nonBank.count, nonBankRows.length > 0 ? nonBankRows.length : null)
	const cardCount = firstNonNegativeIntegerOrNull(cards.card_count, cards.cardCount, cards.count, cardRows.length > 0 ? cardRows.length : null)
	const segments = [
		segment('bank', '银行贷款', bankAmount, bankCount, '#C62828'),
		segment('nonbank', '非银贷款', nonBankAmount, nonBankCount, '#F97316'),
		segment('card', '信用卡已用', cardAmount, cardCount, '#16A34A')
	]
	let adjustmentAmount = 0
	const knownLoan = bankAmount + nonBankAmount
	const loanBaseline = loanTotal
	adjustmentAmount += addReviewLoanSegment(segments, loanBaseline - knownLoan, '贷款总表高于银行与非银明细合计')
	const totalBaseline = total
	adjustmentAmount += addReviewLoanSegment(segments, totalBaseline - loanBaseline - cardAmount, '总负债高于贷款与信用卡合计')
	const finalized = finalizeDebtSegments(segments, totalBaseline, {
		source: 'v2',
		componentsComplete: true,
		adjustmentAmount,
		adjustmentReason: adjustmentAmount > 0 ? '报告总表与明细表存在差额，已归入待核对贷款' : ''
	})
	return finalized
}

function debtSegmentsFromCreditDebt(creditDebt) {
	const cd = asObj(creditDebt)
	if (!Object.keys(cd).length) return null
	const cards = asObj(cd.credit_cards || cd.creditCards)
	const cardAmount = firstNonNegativeNumberOrNull(cd.card, cd.cardTotal, cd.card_used, cd.cardUsed, cards.total_used, cards.totalUsed, cards.used_amount, cards.usedAmount)
	const loanAmount = firstNonNegativeNumberOrNull(cd.loan, cd.loanTotal, cd.loan_balance, cd.loanBalance)
	if (loanAmount == null && cardAmount == null) return null
	const computedTotal = loanAmount != null && cardAmount != null ? loanAmount + cardAmount : null
	const componentsComplete = loanAmount != null && cardAmount != null
	const total = firstNonNegativeNumberOrNull(cd.total, cd.total_debt, cd.totalDebt, computedTotal)
	const segments = [
		segment('bank', '贷款余额', loanAmount, firstNonNegativeIntegerOrNull(cd.loan_count, cd.loanCount), '#C62828'),
		segment('card', '信用卡已用', cardAmount, firstValue(cards.card_count, cards.cardCount, cards.count), '#16A34A')
	]
	let adjustmentAmount = 0
	if (total != null && loanAmount != null && cardAmount != null) {
		adjustmentAmount += addReviewLoanSegment(segments, total - loanAmount - cardAmount, '总负债高于贷款与信用卡合计')
	}
	const finalized = finalizeDebtSegments(segments, total, {
		source: 'summary',
		componentsComplete,
		adjustmentAmount,
		adjustmentReason: adjustmentAmount > 0 ? '摘要总额与分项金额存在差额，已归入待核对贷款' : ''
	})
	return finalized
}

function debtSegmentsFromAccounts(accounts) {
	const list = Array.isArray(accounts) ? accounts : []
	if (!list.length) return null
	let bankAmt = 0
	let bankCnt = 0
	let nonBankAmt = 0
	let nonBankCnt = 0
	let otherAmt = 0
	let otherCnt = 0
	let cardAmt = 0
	let cardCnt = 0
	for (const a of list) {
		if (!a) continue
		const amount = firstNonNegativeNumberOrNull(a.balance, a.loanAmount, a.limit)
		// 账户存在但余额/已用额缺失时，不能把该账户当成 0 元并发布“暂无债务”。
		if (amount == null) return null
		if (a.isLoan) {
			const institution = firstValue(a.institution, a.bank, a.org, a.name)
			const institutionKind = normalizeInstitutionKind(firstValue(
				a.institutionKind, a.institution_kind, a.institutionType, a.institution_type
			), institution)
			if (institutionKind === 'bank') {
				bankAmt += amount
				bankCnt += 1
			} else if (institutionKind === 'non_bank') {
				nonBankAmt += amount
				nonBankCnt += 1
			} else {
				otherAmt += amount
				otherCnt += 1
			}
		} else {
			cardAmt += amount
			cardCnt += 1
		}
	}
	return finalizeDebtSegments([
		segment('bank', '银行贷款', bankAmt, bankCnt, '#C62828'),
		segment('nonbank', '非银贷款', nonBankAmt, nonBankCnt, '#F97316'),
		segment('other', '机构待核对贷款', otherAmt, otherCnt, '#64748B'),
		segment('card', '信用卡已用', cardAmt, cardCnt, '#16A34A')
	], bankAmt + nonBankAmt + otherAmt + cardAmt, { source: 'accounts', known: true, componentsComplete: true, adjustmentAmount: 0 })
}

export function buildDebtStructureSegments({ algorithmReport, strictAlgorithm, creditDebt, creditReportV2, accounts } = {}) {
	return debtSegmentsFromAlgorithm(algorithmReport)
		|| debtSegmentsFromAlgorithm(strictAlgorithm)
		|| debtSegmentsFromV2(creditReportV2)
		|| debtSegmentsFromCreditDebt(creditDebt)
		|| debtSegmentsFromAccounts(accounts)
		|| []
}
function parseYmdDate(s) {
	if (!s || typeof s !== 'string') return null
	const t = s.replace(/\./g, '-').slice(0, 10)
	const m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/)
	if (!m) return null
	const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10))
	return Number.isNaN(d.getTime()) ? null : d
}

function resolveAnchorDate(anchor) {
	if (anchor instanceof Date && !Number.isNaN(anchor.getTime())) {
		return new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())
	}
	if (typeof anchor === 'string') {
		const d = parseYmdDate(anchor)
		if (d) return d
	}
	if (typeof anchor === 'number' && Number.isFinite(anchor)) {
		const d = new Date(anchor)
		if (!Number.isNaN(d.getTime())) return new Date(d.getFullYear(), d.getMonth(), d.getDate())
	}
	return getLiveTimeAnchor()
}

function endOfAnchorDay(anchor) {
	const d = resolveAnchorDate(anchor)
	return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999)
}

function formatYmd(d) {
	const y = d.getFullYear()
	const m = String(d.getMonth() + 1).padStart(2, '0')
	const day = String(d.getDate()).padStart(2, '0')
	return `${y}-${m}-${day}`
}

export function upcomingLoansFromAccounts(accounts, months = 6, anchorDate = null) {
	const loans = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.isLoan === true)
	const now = resolveAnchorDate(anchorDate)
	const horizon = new Date(now.getFullYear(), now.getMonth() + months, now.getDate())
	const items = []
	for (const a of loans) {
		const ed = parseYmdDate(String(a.endDate || a.end_date || '').slice(0, 10))
		if (!ed || ed > horizon || ed < now) continue
		items.push({
			institution: a.bank || '—',
			balance: num(a.balance),
			due_date: formatYmd(ed)
		})
	}
	items.sort((x, y) => String(x.due_date).localeCompare(String(y.due_date)))
	const total_balance = items.reduce((s, x) => s + num(x.balance), 0)
	return { count: items.length, total_balance, items }
}

export function fourOtherLiabilitiesFromAccounts(accounts) {
	const list = Array.isArray(accounts) ? accounts : []
	let largeInstAmt = 0
	let largeInstCnt = 0
	let card10Amt = 0
	let card10Cnt = 0
	let cardLowAmt = 0
	let cardLowCnt = 0
	let creditLoanAmt = 0
	let creditLoanCnt = 0
	let otherLoanAmt = 0
	let otherLoanCnt = 0
	for (const a of list) {
		if (!a) continue
		if (!a.isLoan) {
			const lim = num(a.limit)
			const bal = num(a.balance)
			const typ = String(a.accountType || '')
			if (/分期|大额/.test(typ)) {
				largeInstAmt += bal
				largeInstCnt += 1
			} else if (lim >= 100000) {
				card10Amt += bal
				card10Cnt += 1
			} else if (lim > 0 || bal > 0) {
				cardLowAmt += bal
				cardLowCnt += 1
			}
		} else {
			const bal = num(a.balance) || num(a.loanAmount)
			const typ = String(a.accountType || a.account_type || a.loanType || a.type || '')
			if (/信用贷|信用贷款|消费贷|个人贷款|无抵押|经营周转/.test(typ)) {
				creditLoanAmt += bal
				creditLoanCnt += 1
			} else {
				otherLoanAmt += bal
				otherLoanCnt += 1
			}
		}
	}
	return [
		{ key: 'large', name: '大额分期', amount: largeInstAmt, count: largeInstCnt, color: '#8B5CF6' },
		{ key: 'card10', name: '授信≥10万信用卡', amount: card10Amt, count: card10Cnt, color: '#EC4899' },
		{ key: 'creditLoan', name: '信用贷款', amount: creditLoanAmt, count: creditLoanCnt, color: '#3B82F6' },
		{ key: 'cardLow', name: '10万以下信用卡', amount: cardLowAmt, count: cardLowCnt, color: '#06B6D4' },
		{ key: 'otherLoan', name: '其他贷款', amount: otherLoanAmt, count: otherLoanCnt, color: '#F97316' }
	]
}

export function otherLiabilitiesConicStyle(four) {
	const list = four.map((x) => Math.max(0, num(x.amount)))
	const t = list.reduce((s, v) => s + v, 0)
	if (t <= 0) return { background: '#E5E7EB' }
	const colors = four.map((x) => x.color)
	let acc = 0
	const parts = []
	for (let i = 0; i < list.length; i++) {
		const p = t > 0 ? Math.round((list[i] / t) * 100) : 0
		const start = acc
		acc += p
		parts.push(`${colors[i]} ${start}% ${acc}%`)
	}
	return { background: `conic-gradient(${parts.join(', ')})` }
}

// applyOverdueTotalCap 已统一到 services/creditAlgorithmCore.js（单一真相源）。
// 如需使用请 import { applyOverdueTotalCap } from '@/services/creditAlgorithmCore.js'

/** 贷后管理查询：不计入「查询机构明细」展示（非审批类硬查询） */
export function isPostLoanManagementQuery(row) {
	if (!row || typeof row !== 'object') return false
	const reason = String(row.reason || row.query_reason || row.purpose || '').trim()
	return /贷后管理/.test(reason)
}

export function isEffectiveQuery(row) {
	if (!row || typeof row !== 'object') return false
	const reason = String(row.reason || row.query_reason || row.purpose || '').trim()
	if (/本人|自查|自助|个人查询|贷后管理|异议|账户管理/.test(reason)) return false
	return /贷款审批|信用卡审批|贷记卡审批|担保(?:资格)?审查|保前审查|融资审批|授信审批/.test(reason)
}

export function classifyQueryItemBank(row) {
	const org = String(row.org || row.institution || row.bank || row.query_org || '').trim()
	const reason = String(row.reason || row.query_reason || row.purpose || '').trim()
	const s = `${org} ${reason}`
	if (/本人|自查|自助|个人查询/.test(s)) return 'self'
	const explicitKind = firstValue(
		row.institutionKind,
		row.institution_kind,
		row.institutionType,
		row.institution_type,
		row.orgType,
		row.org_type,
		row.lenderType,
		row.lender_type
	)
	const kind = normalizeInstitutionKind(explicitKind, org)
	if (kind === 'bank') return 'bank'
	if (kind === 'non_bank') return 'nonBank'
	return 'unknown'
}

export function parseQueryItemDate(row) {
	const d = row.date || row.query_date || row.queryDate || row.time
	if (!d) return null
	const beijing = parseYmdAsBeijing(String(d).replace(/\./g, '-').slice(0, 10))
	if (beijing) return beijing
	return parseYmdDate(String(d).replace(/\./g, '-').slice(0, 10))
}

export function aggregateQueryItemsByMonth(items, monthsBack = 12, anchorDate = null) {
	const raw = Array.isArray(items) ? items : []
	const now = endOfAnchorDay(anchorDate)
	const start = new Date(now.getFullYear(), now.getMonth() - (monthsBack - 1), 1)
	const map = {}
	for (let i = 0; i < monthsBack; i++) {
		const d = new Date(start.getFullYear(), start.getMonth() + i, 1)
		const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
		map[key] = { month: key, bank: 0, nonBank: 0, unknown: 0, items: [] }
	}
	for (const row of raw) {
		if (!isEffectiveQuery(row)) continue
		const dt = parseQueryItemDate(row)
		if (!dt || dt < start || dt > now) continue
		const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`
		if (!map[key]) continue
		const kind = classifyQueryItemBank(row)
		if (kind === 'self') continue
		if (kind === 'bank') map[key].bank += 1
		else if (kind === 'nonBank') map[key].nonBank += 1
		else map[key].unknown += 1
		map[key].items.push(row)
	}
	return Object.keys(map)
		.sort()
		.map((k) => {
			const value = map[k]
			if (value.unknown === 0) delete value.unknown
			else {
				value.breakdownAvailable = true
				value.classificationComplete = false
			}
			return value
		})
}

/** 查询明细时间窗起点（锚定调用方报告日，与 API queryWindowPolicy 一致） */
export function queryLiveWindowStart(monthsBack = 12, anchor = getLiveTimeAnchor()) {
	const safeAnchor = resolveAnchorDate(anchor)
	const safeMonths = Math.max(0, Math.trunc(num(monthsBack, 0)))
	const absoluteMonth = safeAnchor.getFullYear() * 12 + safeAnchor.getMonth() - safeMonths
	const targetYear = Math.floor(absoluteMonth / 12)
	const targetMonth = ((absoluteMonth % 12) + 12) % 12
	const lastDay = new Date(targetYear, targetMonth + 1, 0).getDate()
	return new Date(targetYear, targetMonth, Math.min(safeAnchor.getDate(), lastDay))
}

/**
 * 「查询机构明细」：近 N 月、报告日为锚；默认排除贷后管理/本人查询
 * @param {object} [opts] monthsBack, bankOnly, excludePostLoan, excludeSelf
 */
export function filterQueryInstitutionDetailsLive(items, opts = {}) {
	const monthsBack = opts.monthsBack ?? 12
	const bankOnly = opts.bankOnly === true
	const excludePostLoan = opts.excludePostLoan !== false
	const excludeSelf = opts.excludeSelf !== false
	const now = endOfAnchorDay(opts.anchorDate ?? null)
	const since = queryLiveWindowStart(monthsBack, now)
	const raw = Array.isArray(items) ? items : []
	return raw
		.filter((row) => {
			if (!row) return false
			if (excludePostLoan && isPostLoanManagementQuery(row)) return false
			if (!isEffectiveQuery(row)) return false
			if (excludeSelf && String(row.period || '').indexOf('自查') >= 0) return false
			const kind = classifyQueryItemBank(row)
			if (excludeSelf && kind === 'self') return false
			if (bankOnly && kind !== 'bank') return false
			const dt = parseQueryItemDate(row)
			if (!dt || dt < since || dt > now) return false
			return true
		})
		.sort((a, b) => {
			const da = parseQueryItemDate(a)
			const db = parseQueryItemDate(b)
			return db && da ? db.getTime() - da.getTime() : 0
		})
}

export function filterBankQueries12m(items, anchorDate = null) {
	return filterQueryInstitutionDetailsLive(items, { monthsBack: 12, bankOnly: true, anchorDate })
}

/** 自查记录：近 N 月（报告日锚点） */
export function filterSelfQueriesInLiveWindow(items, monthsBack = 12, anchorDate = null) {
	const now = endOfAnchorDay(anchorDate)
	const since = queryLiveWindowStart(monthsBack, now)
	return filterSelfQueries(items).filter((row) => {
		const dt = parseQueryItemDate(row)
		return dt && dt >= since && dt <= now
	})
}

export function filterSelfQueries(items) {
	const raw = Array.isArray(items) ? items : []
	return raw
		.filter((row) => {
			const org = String(row.org || row.institution || row.bank || '').trim()
			const reason = String(row.reason || row.query_reason || '').trim()
			return /本人|自查|自助/.test(`${org} ${reason}`)
		})
		.sort((a, b) => {
			const da = parseQueryItemDate(a)
			const db = parseQueryItemDate(b)
			return (db && da ? db.getTime() - da.getTime() : 0)
		})
}

/**
 * 按近 1/3/6/12 月统计查询次数（排除本人查询），区分银行 / 非银。
 */
export function summarizeQueriesByWindows(items, anchorDate = null) {
	const raw = Array.isArray(items) ? items : []
	const now = endOfAnchorDay(anchorDate)
	const windows = [
		{ key: '1m', months: 1 },
		{ key: '3m', months: 3 },
		{ key: '6m', months: 6 },
		{ key: '12m', months: 12 }
	]
	const init = () => ({ bank: 0, nonBank: 0, unknown: 0, total: 0 })
	const out = { '1m': init(), '3m': init(), '6m': init(), '12m': init() }
	for (const row of raw) {
		if (!isEffectiveQuery(row)) continue
		const kind = classifyQueryItemBank(row)
		if (kind === 'self') continue
		const dt = parseQueryItemDate(row)
		if (!dt || dt > now) continue
		for (const w of windows) {
			if (dt < queryLiveWindowStart(w.months, now)) continue
			const o = out[w.key]
			o.total += 1
			if (kind === 'bank') o.bank += 1
			else if (kind === 'nonBank') o.nonBank += 1
			else o.unknown += 1
		}
	}
	for (const value of Object.values(out)) {
		if (value.unknown === 0) delete value.unknown
		else {
			value.breakdownAvailable = true
			value.classificationComplete = false
		}
	}
	return out
}

/** 从账户列表提取贷款轨迹点（isLoan === true，按 openDate） */
export function loanTrajectoryFromAccounts(accounts) {
	const loans = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.isLoan === true)
	const pts = []
	for (const a of loans) {
		const dt = parseYmdDate(String(a.openDate || a.open_date || '').slice(0, 10))
		const amt = num(a.loanAmount) || num(a.limit) || num(a.balance)
		if (!dt || amt <= 0) continue
		pts.push({
			date: dt,
			amount: amt,
			label: formatYmd(dt),
			bank: String(a.bank || a.institution || '').trim()
		})
	}
	return finalizeLoanTrajectoryPoints(pts)
}

function finalizeLoanTrajectoryPoints(pts) {
	const sorted = [...pts].sort((x, y) => x.date.getTime() - y.date.getTime())
	const amounts = sorted.map((p) => p.amount)
	const maxAmt = amounts.length ? Math.max(...amounts) : 0
	return sorted.map((p) => ({
		...p,
		pct: maxAmt > 0 ? Math.round((p.amount / maxAmt) * 100) : 0,
		isMax: maxAmt > 0 && p.amount >= maxAmt
	}))
}

const normalizedUsagePct = (raw, kind = 'ratio') => {
	if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') return null
	const n = num(raw, NaN)
	if (!Number.isFinite(n) || n < 0) return null
	if (kind === 'pct') return Math.max(0, Math.round(n > 1 ? n : n * 100))
	return Math.max(0, Math.round(n > 10 ? n : n * 100))
}

/** 信用卡总使用率：确定性报告只读服务端值；历史报告保留明细兼容逻辑。 */
export function creditCardUsageRatePct(creditCards, dimensions, cardAccounts, options = {}) {
	const cc = creditCards || {}
	const cards = Array.isArray(cardAccounts) ? cardAccounts : []
	const d = dimensions || {}
	if (options.authoritative === true) {
		const fromDimensions = normalizedUsagePct(d.cardUtilizationRate ?? d.card_utilization_rate)
		if (fromDimensions != null) return fromDimensions
		const fromPct = normalizedUsagePct(cc.usage_rate_pct ?? cc.usageRatePct, 'pct')
		if (fromPct != null) return fromPct
		const fromRatio = normalizedUsagePct(cc.usage_rate ?? cc.usageRate)
		return fromRatio
	}
	const utilization = summarizeCreditCardUtilization(cards)
	if (cards.length > 0) {
		if (!utilization.decisionEligible || utilization.usageRate == null) return null
		return Math.max(0, Math.round(utilization.usageRate * 100))
	}
	const pctRaw = cc.usage_rate_pct ?? cc.usageRatePct
	const fromPct = normalizedUsagePct(pctRaw, 'pct')
	if (fromPct != null) return fromPct
	const ratioRaw = cc.usage_rate ?? cc.usageRate
	const fromRatio = normalizedUsagePct(ratioRaw)
	if (fromRatio != null) return fromRatio
	return normalizedUsagePct(d.cardUtilizationRate ?? d.card_utilization_rate)
}

/** creditAccounts / accounts 中 isLoan === false → 表格行（含展开详情字段） */
export function creditCardRowsFromAccounts(accounts) {
	const list = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.isLoan !== true)
	return list
		.map((a) => {
			const lim = num(a.limit)
			const used = num(a.balance)
			const pct = lim > 0 ? Math.round((used / lim) * 100) : 0
			return {
				institution: a.bank || a.institution || '—',
				credit_limit: lim,
				used_limit: used,
				status: a.status || '—',
				usage_pct: pct,
				account_type: a.accountType || a.account_type || '贷记卡',
				open_date: String(a.openDate || a.open_date || '').slice(0, 10) || '—',
				end_date: String(a.endDate || a.end_date || '').slice(0, 10) || '—',
				available: Math.max(lim - used, 0),
				repay_record: a.repayRecord || a.repay_record || '',
				is_settled: !!(a.isSettled || a.is_settled),
				overdue_days: num(a.overdueDays ?? a.overdue_days)
			}
		})
		.sort((x, y) => compareInstitutionName(x.institution, y.institution))
}

/**
 * 借款轨迹：当前报告 creditAccounts + 本地历史报告叠加（去重）
 */
export function mergeLoanTrajectoryFromReports(getReportList, getReport, currentReportId, currentAccounts) {
	const dedupe = new Map()

	const ingest = (accounts, source) => {
		const loans = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.isLoan === true)
		for (const a of loans) {
			const dt = parseYmdDate(String(a.openDate || a.open_date || '').slice(0, 10))
			const amt = num(a.loanAmount) || num(a.limit) || num(a.balance)
			if (!dt || amt <= 0) continue
			const key = `${formatYmd(dt)}|${String(a.bank || a.institution || '').trim()}|${Math.round(amt)}`
			const row = {
				date: dt,
				amount: amt,
				label: formatYmd(dt),
				bank: String(a.bank || a.institution || '').trim() || '—',
				source: source || '本报告',
				account_type: a.accountType || a.account_type || '贷款',
				monthly_payment: num(a.monthlyPayment ?? a.monthly_payment),
				balance: num(a.balance),
				status: a.status || '—'
			}
			if (!dedupe.has(key) || source === '本报告') dedupe.set(key, row)
		}
	}

	ingest(currentAccounts, '本报告')

	try {
		const list = typeof getReportList === 'function' ? getReportList() : []
		for (const row of list) {
			if (!row || !row.id || row.id === currentReportId) continue
			const full = typeof getReport === 'function' ? getReport(row.id) : null
			const ad = (full && (full.analysisData || full.analysisResult)) || null
			if (!ad) continue
			const r = ad.report || {}
			const ac =
				(Array.isArray(r.creditAccounts) && r.creditAccounts.length ? r.creditAccounts : null) ||
				(Array.isArray(ad.accounts) ? ad.accounts : [])
			const histLabel = row.date ? `历史·${String(row.date).slice(0, 10)}` : '历史报告'
			ingest(ac, histLabel)
		}
	} catch (e) {
		/* 历史报告读取失败时仅用当前报告 */
	}

	return finalizeLoanTrajectoryPoints([...dedupe.values()])
}
