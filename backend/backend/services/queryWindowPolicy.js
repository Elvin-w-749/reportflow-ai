'use strict'

const HARD_QUERY_REASON = /贷款审批|信用卡审批|贷记卡审批|担保(?:资格)?审查|保前审查|融资审批|授信审批/
const EXCLUDED_QUERY_REASON = /本人|自查|个人查询|贷后管理|异议|账户管理/
const WINDOW_MONTHS = Object.freeze([1, 2, 3, 6, 12, 24])

function parseQueryDateMs(value) {
	const raw = String(value || '').trim()
	const match = raw.match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/)
	if (!match) return 0
	const year = Number(match[1])
	const month = Number(match[2])
	const day = Number(match[3])
	if (
		year < 1900 ||
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > new Date(Date.UTC(year, month, 0)).getUTCDate()
	) return 0
	return Date.UTC(year, month - 1, day)
}

function subtractCalendarMonths(anchor, months) {
	if (!Number.isFinite(anchor) || anchor <= 0) return 0
	const date = new Date(anchor)
	const absoluteMonth = date.getUTCFullYear() * 12 + date.getUTCMonth() - months
	const targetYear = Math.floor(absoluteMonth / 12)
	const targetMonth = ((absoluteMonth % 12) + 12) % 12
	const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()
	return Date.UTC(targetYear, targetMonth, Math.min(date.getUTCDate(), lastDay))
}

function isHardCreditQuery(row) {
	const reason = String(row && (row.reason || row.query_reason) || '').replace(/\s+/g, '')
	return !!reason && !EXCLUDED_QUERY_REASON.test(reason) && HARD_QUERY_REASON.test(reason)
}

const INSTITUTION_TYPE_FIELDS = Object.freeze([
	'institution_type',
	'institutionType',
	'institution_kind',
	'institutionKind',
	'org_type',
	'orgType',
	'lender_type',
	'lenderType'
])

function normalizeInstitutionType(value) {
	const raw = String(value == null ? '' : value).normalize('NFKC').trim()
	if (!raw) return ''
	const text = raw.toLowerCase().replace(/[\s-]+/g, '_')
	// “非银行”包含“银行”，因此非银必须先判定。
	if (
		/^(?:non_?bank|nonbank|non_?bank_loan|consumer_finance|micro_?loan)$/.test(text) ||
		/非银行|非银|消费金融|汽车金融|小额贷款|小贷|信托|融资租赁|网贷/.test(raw)
	) return 'non_bank'
	if (
		/^(?:bank|bank_loan|banking|commercial_bank|rural_bank)$/.test(text) ||
		/^(?:银行|银行机构|商业银行|农村银行|村镇银行|农商行|信用社)$/.test(raw)
	) return 'bank'
	if (/^(?:unknown|unclassified|unspecified|other|未知|未分类|未说明|其他)$/.test(text)) {
		return 'unknown'
	}
	return 'unknown'
}

function explicitInstitutionType(row) {
	if (!row || typeof row !== 'object' || Array.isArray(row)) return ''
	for (const field of INSTITUTION_TYPE_FIELDS) {
		if (!Object.prototype.hasOwnProperty.call(row, field)) continue
		const raw = row[field]
		// 字段一旦显式出现，就不得再用机构名称覆盖；无法识别时保持 unknown。
		if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
			return normalizeInstitutionType(raw)
		}
	}
	return ''
}

function institutionName(rowOrName) {
	if (rowOrName && typeof rowOrName === 'object' && !Array.isArray(rowOrName)) {
		return rowOrName.institution || rowOrName.org || rowOrName.bank || ''
	}
	return rowOrName
}

/**
 * 机构三态分类：显式类型 > 调用方的权威分组 > 名称确定性匹配 > unknown。
 * 未命中银行规则绝不等价于非银。
 */
function classifyInstitution(rowOrName, options = {}) {
	const explicit = explicitInstitutionType(rowOrName)
	if (explicit) return explicit
	const fallback = normalizeInstitutionType(options.fallbackType)
	if (fallback) return fallback
	const name = String(institutionName(rowOrName) || '').normalize('NFKC').trim()
	if (!name) return 'unknown'
	// 机构法定主体为“银行股份有限公司”时，即使后缀是汽车消费金融中心，
	// 仍属于该银行内部机构；不能被后面的“消费金融”关键词误归为非银。
	if (/银行股份有限公司/i.test(name)) {
		return 'bank'
	}
	if (/消费金融|汽车金融|小额贷款|小贷|贷款公司|信托|融资租赁|融资担保|保理|网贷/i.test(name)) {
		return 'non_bank'
	}
	if (/银行|农商|信用社|邮储|农村商业|村镇银行|合作银行|农信/i.test(name)) {
		return 'bank'
	}
	return 'unknown'
}

/**
 * 贷款机构分类只接受原始机构名称。模型提供的 institution_type 与其
 * bank/non_bank 数组位置都不是事实，不能影响负债、风险或评分。
 */
function classifyLoanInstitution(rowOrName) {
	const name = String(institutionName(rowOrName) || '').normalize('NFKC').trim()
	if (!name) return 'unknown'
	const compactName = name.replace(/\s+/gu, '')

	// 法律主体名称可以消解品牌词冲突。例如“某银行股份有限公司汽车消费
	// 金融中心”的法律主体仍是银行；“某银行小额贷款有限公司”的法律主体
	// 则是小额贷款公司。这里只认公司全称结构，不把模型分组当作证明。
	const legalBank = /银行(?:（[^）]{1,20}）|\([^)]{1,20}\))?(?:股份有限公司|有限责任公司|有限公司)/i.test(compactName)
	const legalNonBank = /(?:消费金融|汽车金融|小额贷款|贷款公司|信托|金融租赁|融资租赁|融资担保|商业保理|保理)(?:（[^）]{1,20}）|\([^)]{1,20}\))?(?:股份有限公司|有限责任公司|有限公司)/i.test(compactName)
	if (legalBank && legalNonBank) return 'unknown'
	if (legalBank) return 'bank'
	if (legalNonBank) return 'non_bank'

	const hasBankSignal = /银行|农商|信用社|邮储|农村商业|村镇银行|合作银行|农信/i.test(compactName)
	const hasNonBankSignal = /非银行|非银|消费金融|汽车金融|小额贷款|小贷|贷款公司|信托|金融租赁|融资租赁|融资担保|保理|网贷/i.test(compactName)

	// 同时出现银行与非银信号但没有明确法律主体时，证据不足以支持风险
	// 分类。失败关闭为 unknown，避免简称或内部中心名称触发非银扣分。
	if (hasBankSignal && hasNonBankSignal) return 'unknown'
	if (hasNonBankSignal) return 'non_bank'
	if (hasBankSignal) return 'bank'
	return 'unknown'
}

function isBankInstitution(rowOrName) {
	return classifyInstitution(rowOrName) === 'bank'
}

/**
 * 唯一查询窗口口径：
 * - 锚点仅由调用方传入的报告日决定；
 * - 使用日历月，起止日均包含；
 * - 默认只统计硬查询；本人/自查、贷后管理、异议/账户管理均排除。
 */
function countQueriesByWindow(rows, anchor, months, options = {}) {
	const start = subtractCalendarMonths(anchor, months)
	const hardOnly = options.hardOnly !== false
	const bucket = {
		total: 0,
		bank: 0,
		non_bank: 0,
		unknown: 0,
		loan_approval: 0,
		credit_card_approval: 0,
		by_reason: {}
	}
	for (const row of Array.isArray(rows) ? rows : []) {
		const timestamp = parseQueryDateMs(row && (row.date || row.query_date))
		if (!timestamp || !anchor || timestamp < start || timestamp > anchor) continue
		if (hardOnly && !isHardCreditQuery(row)) continue
		const reason = String(row && (row.reason || row.query_reason) || '').trim() || '其他'
		bucket.total += 1
		const institutionType = classifyInstitution(row)
		bucket[institutionType] += 1
		if (/信用卡审批|贷记卡审批/.test(reason)) bucket.credit_card_approval += 1
		else if (/贷款审批|担保(?:资格)?审查|保前审查|融资审批|授信审批/.test(reason)) {
			bucket.loan_approval += 1
		}
		bucket.by_reason[reason] = (bucket.by_reason[reason] || 0) + 1
	}
	bucket.by_reason = Object.fromEntries(
		Object.entries(bucket.by_reason).sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))
	)
	return bucket
}

function buildQueryWindowSummary(rows, anchor, options = {}) {
	const result = {}
	for (const months of WINDOW_MONTHS) {
		result[`last_${months}m`] = countQueriesByWindow(rows, anchor, months, options)
	}
	return result
}

/**
 * 同日集中查询的唯一权威口径：只统计报告日前指定日历月窗口内的硬查询。
 * 贷后管理、本人查询等非申请型查询，以及窗口外的历史查询，均不能触发扣分。
 */
function summarizeHardQueryBursts(rows, anchor, options = {}) {
	const requestedMonths = Number(options.months)
	const months = Number.isInteger(requestedMonths) && requestedMonths > 0
		? requestedMonths
		: 6
	const start = subtractCalendarMonths(anchor, months)
	const dayCounts = new Map()
	for (const row of Array.isArray(rows) ? rows : []) {
		if (!isHardCreditQuery(row)) continue
		const timestamp = parseQueryDateMs(row && (row.date || row.query_date))
		if (!timestamp || !anchor || timestamp < start || timestamp > anchor) continue
		const day = new Date(timestamp).toISOString().slice(0, 10)
		dayCounts.set(day, (dayCounts.get(day) || 0) + 1)
	}
	const counts = [...dayCounts.values()]
	return {
		windowMonths: months,
		total: counts.reduce((sum, count) => sum + count, 0),
		sameDayInquiryDayCount: counts.filter((count) => count > 3).length,
		maxSameDayCount: counts.length ? Math.max(...counts) : 0
	}
}

module.exports = {
	WINDOW_MONTHS,
	parseQueryDateMs,
	subtractCalendarMonths,
	isHardCreditQuery,
	normalizeInstitutionType,
	classifyInstitution,
	classifyLoanInstitution,
	countQueriesByWindow,
	buildQueryWindowSummary,
	summarizeHardQueryBursts
}
