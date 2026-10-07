// 本模块引用的评分权重与扣分阶梯为演示配置，不代表任何机构的真实授信规则。
'use strict'

/**
 * 征信双引擎 — 规则层：数值补全、一致性校验、风险命中、前端图表组装。
 * 与 Master Prompt 输出的 10 模块 JSON 对齐；AI 结果经本模块后再返回客户端。
 */

const COLORS = {
	bank: '#3B82F6',
	nonBank: '#F59E0B',
	ccUsed: '#EF4444',
	ccAvail: '#10B981',
	mortgage: '#8B5CF6',
	car: '#EC4899',
	creditLoan: '#3B82F6',
	biz: '#06B6D4',
	guarantee: '#F97316'
}

/** 风险等级 → 严重度（用于排序、汇总徽标） */
const LEVEL_SEVERITY = { 风险: 4, 警告: 3, 提示: 2, 信息: 1 }

const DIAGNOSTIC_ONLY_DEBT_RATIO_RULES = new Set([
	'DEBT_RATIO_HIGH',
	'DEBT_RATIO_CRITICAL',
	'MONTHLY_BURDEN'
])
const DEBT_RATIO_DIAGNOSTIC_STATUS = 'denominator-evidence-pending'

/**
 * 评分算法 — 从共享权威源导入（单一来源，消除 CJS/ESM 双维护）
 *
 * 权威源：ai-proxy/backend/scoringAlgorithms.cjs
 * 前端 ESM 副本：services/creditAlgorithmCore.js（行为等价，strict-gate 交叉验证）
 *
 * 防护：
 *   1) strict-gate consistency:four-dim-weights-sync（提交前）
 *   2) server.js 启动门禁（权重和=1 断言）
 *   3) creditRuleEngine.test.js 测试
 */
const {
	FOUR_DIM_WEIGHTS,
	scoreFourDimensions,
	calculatePrimaryRuleScore: calculatePrimaryRuleScoreCore,
	applyOverdueTotalCap,
	composeFourDimTotal
} = require('./backend/scoringAlgorithms.cjs')
const {
	parseQueryDateMs,
	subtractCalendarMonths,
	isHardCreditQuery,
	buildQueryWindowSummary,
	summarizeHardQueryBursts
} = require('./backend/services/queryWindowPolicy')
const { summarizeCreditCardUtilization, isNotActivatedCardStatus } = require('./backend/services/creditCardUtilization')

const SIX_DIM_LABEL = {
	repayment_record: '还款记录',
	credit_history: '信用历史',
	account_structure: '账户结构',
	query_frequency: '查询频率'
}

/**
 * 规则 → 行动模板。命中规则后产出 `improvement_plan`，前端按优先级展示。
 * 每条 action 由 { rule_name, priority(1-5), title, action, impact } 组成。
 */
const RULE_ACTION_TEMPLATES = {
	CC_USAGE_HIGH: { priority: 5, title: '信用卡使用率过高', action: '优先归还高额度信用卡至 70% 以下；可考虑账单分期或调降部分额度', impact: '负债比例 / 还款能力' },
	CC_USAGE_WARNING: { priority: 3, title: '信用卡使用率偏高', action: '保持每月使用率在 70% 以下，避免账单日临近时刷爆', impact: '负债比例' },
	QUERY_DENSE_1M: { priority: 5, title: '近1月查询过密', action: '至少 30 天内不要再申请任何贷款 / 信用卡，避免被金融机构标记“资金紧张”', impact: '查询频率 / 准入难度' },
	QUERY_DENSE_3M: { priority: 3, title: '近3月查询略多', action: '将申请节奏放慢至 1 个月内不超过 2 次硬查询', impact: '查询频率' },
	SUSPECT_P2P_LOANS: { priority: 5, title: '非银/小贷数量偏多', action: '优先结清利息高、余额小的非银贷款，集中并精简持牌账户', impact: '账户结构 / 申请准入' },
	UPCOMING_MANY: { priority: 4, title: '近6个月到期笔数较多', action: '梳理到期日历，预留 1~3 个月现金流缓冲，避免连环展期', impact: '偿债能力' },
	OVERDUE_ACTIVE: { priority: 5, title: '存在逾期记录', action: '尽快结清当前逾期；非主观逾期可发起异议；保持连续 6 个月不再新增逾期', impact: '还款记录 / 综合评分' },
	REPORT_STALE: { priority: 2, title: '征信报告时效偏旧', action: '重新拉取最新征信，确保分析结论基于最新状态', impact: '数据时效' },
	DEBT_RATIO_HIGH: { priority: 4, title: '负债率偏高', action: '降低非必要负债（账单分期/可还款的车贷余额），将负债率控制在 0.6 以下', impact: '负债比例' },
	DEBT_RATIO_CRITICAL: { priority: 5, title: '负债率严重偏高', action: '建议先结清 1~2 笔小额负债，将负债率回落到 0.8 以下再考虑大额申请', impact: '负债比例 / 审批通过率' },
	ACCOUNT_OPENED_BURST: { priority: 4, title: '近6月新增账户过多', action: '暂停申请新账户至少 3 个月，集中精力管理已有账户', impact: '账户结构' },
	INSTITUTION_DIVERSITY_HIGH: { priority: 3, title: '借款机构过于分散', action: '逐步集中到 2~3 家持牌机构，避免“多头借贷”标签', impact: '账户结构' },
	CARD_LARGE_INSTALLMENT: { priority: 3, title: '大额信用卡分期', action: '关注未出账分期对真实负债率的拉高，必要时一次性结清', impact: '负债比例 / 还款能力' },
	GUARANTEE_EXPOSURE: { priority: 4, title: '存在对外担保', action: '与被担保方确认还款节奏；必要时通过结清/置换降低担保敞口', impact: '隐性负债' },
	HEALTHY_NO_RISK: { priority: 1, title: '当前无明显风险', action: '保持现有还款节奏，并定期（季度）复查征信报告', impact: '维持' },
		DEBT_SPIRAL: { priority: 5, title: '疑似以贷养贷模式', action: '立即停止新增借贷；优先偿还最高利率债务；如有困难可主动联系银行协商重组方案', impact: '综合评分 / 偿债能力 / 准入' },
		MONTHLY_BURDEN: { priority: 4, title: '月度还款压力较大', action: '梳理全部月还款额，评估是否超过月收入50%；考虑将高息短期债务置换为低息长期贷款', impact: '偿债能力 / 审批通过率' },
		DORMANT_CARD: { priority: 2, title: '存在较多睡眠信用卡', action: '确认是否仍需保留；不用的卡建议注销（减少年费风险、降低被盗刷面）', impact: '账户管理 / 安全' }
}

function safeInt(v, def = 0) {
	if (v === null || v === undefined) return def
	if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v)
	const n = parseInt(String(v).replace(/,/g, ''), 10)
	return Number.isFinite(n) ? n : def
}

function safeFloat(v, def = 0) {
	if (v === null || v === undefined) return def
	if (typeof v === 'number' && Number.isFinite(v)) return v
	const n = parseFloat(String(v).replace(/,/g, ''))
	return Number.isFinite(n) ? n : def
}

// 否定盲区修复：`未结清` 等否定短语包含闭户关键词，包含匹配会把
// 活跃账户误判为已关闭。与 creditAnalysisService 保持同一语义。
function hasNegatedClosedStatusPhrase(status) {
	return /(?:未|尚未|非)\s*(?:结清|还清|销户|注销|关闭|销卡|作废|终止|结转|解除|失效)/u.test(String(status || ''))
}

function isClosedLoanStatus(status) {
	const text = String(status || '')
	if (hasNegatedClosedStatusPhrase(text)) return false
	return /已?结清|销户|注销|关闭|作废|终止|结转/.test(text)
}

function isCnyLoanRow(row) {
	const value = row && (row.currency || row.currency_code)
	const text = String(value == null ? '' : value).normalize('NFKC').trim().toUpperCase()
	if (!text) return true
	return /人民币|\bCNY\b|\bRMB\b/.test(text)
}

function isDebtBearingLoanRow(row) {
	if (!row || typeof row !== 'object') return false
	if (isClosedLoanStatus(row.status)) return false
	if (!isCnyLoanRow(row)) return false
	return safeFloat(row.balance ?? row.remaining_balance ?? row.loan_balance, 0) > 0
}

function isCancelledCardStatus(status) {
	const text = String(status || '')
	if (hasNegatedClosedStatusPhrase(text)) return false
	return /销户|注销|关闭|销卡|作废|已结清|结清/.test(text)
}

function isActiveCardRow(row) {
	if (!row || typeof row !== 'object') return false
	return !isCancelledCardStatus(row.status)
}

function isExplicitCnyCardRow(row) {
	const values = [row?.currency, row?.currency_code].filter((value) =>
		value !== null && value !== undefined && !(typeof value === 'string' && value.trim() === '')
	)
	return values.length > 0 && values.every((value) =>
		typeof value === 'string' && /^(?:人民币(?:元)?|CNY|RMB)$/iu.test(value.normalize('NFKC').trim())
	)
}

function isActiveLoanRow(row) {
	if (!row || typeof row !== 'object') return false
	return !isClosedLoanStatus(row.status)
}

function currentLoanRows(data) {
	const bankLoans = Array.isArray(data?.loan_details?.bank_loans) ? data.loan_details.bank_loans : []
	const nonBankLoans = Array.isArray(data?.loan_details?.non_bank_loans) ? data.loan_details.non_bank_loans : []
	const unknownLoans = Array.isArray(data?.loan_details?.unknown_loans) ? data.loan_details.unknown_loans : []
	return {
		bankLoans,
		nonBankLoans,
		unknownLoans,
		activeBankLoans: bankLoans.filter(isActiveLoanRow),
		activeNonBankLoans: nonBankLoans.filter(isActiveLoanRow),
		activeUnknownLoans: unknownLoans.filter(isActiveLoanRow),
		debtBankLoans: bankLoans.filter(isDebtBearingLoanRow),
		debtNonBankLoans: nonBankLoans.filter(isDebtBearingLoanRow),
		debtUnknownLoans: unknownLoans.filter(isDebtBearingLoanRow)
	}
}

function ensureDeep(obj, path, factory) {
	let cur = obj
	for (let i = 0; i < path.length - 1; i++) {
		const k = path[i]
		if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {}
		cur = cur[k]
	}
	const last = path[path.length - 1]
	if (cur[last] == null || typeof cur[last] !== 'object') cur[last] = factory()
	return cur[last]
}

function roundRate(v) {
	const n = safeFloat(v)
	return Math.round(n * 10000) / 10000
}

function dedupeHits(hits, byKey = 'rule_name') {
	const seen = new Map()
	const out = []
	for (const h of hits) {
		const k = h && h[byKey] != null ? String(h[byKey]) : JSON.stringify(h)
		const prev = seen.get(k)
		if (!prev || safeInt(h.severity, 0) > safeInt(prev.severity, 0)) {
			seen.set(k, h)
		}
	}
	for (const h of seen.values()) out.push(h)
	out.sort((a, b) => safeInt(b.severity, 0) - safeInt(a.severity, 0))
	return out
}

function daysBetween(isoDateA, isoDateB) {
	const a = Date.parse(String(isoDateA || '').slice(0, 10))
	const b = Date.parse(String(isoDateB || '').slice(0, 10))
	if (!Number.isFinite(a) || !Number.isFinite(b)) return null
	return Math.floor((b - a) / 86400000)
}

function parseQueryIsoDate(raw) {
	if (!raw) return null
	const s = String(raw).trim()
	const m = s.match(/(\d{4})[-\/年.](\d{1,2})[-\/月.](\d{1,2})/)
	if (!m) return null
	const t = Date.parse(`${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`)
	return Number.isFinite(t) ? t : null
}

function isBankInstitutionName(name) {
	return /银行|农商|信用社|邮储|农村商业|村镇银行|合作银行/i.test(String(name || ''))
}

function resolveAnalysisAnchorMs(data) {
	const meta = data && data.meta && typeof data.meta === 'object' ? data.meta : {}
	if (data && data.derivation_meta && data.derivation_meta.mode === 'deterministic-v1') {
		// 确定性链路只接受报告日；不得回退 query_date、明细最新日或服务器当天。
		return parseQueryDateMs(meta.report_date || meta.reportDate) || 0
	}
	const explicit = parseQueryIsoDate(
		meta.report_date || meta.query_date || meta.reportDate || meta.queryDate
	)
	if (explicit != null) return explicit

	let latest = 0
	const collect = (rows, keys) => {
		for (const row of Array.isArray(rows) ? rows : []) {
			for (const key of keys) {
				const value = parseQueryIsoDate(row && row[key])
				if (value != null && value > latest) latest = value
			}
		}
	}
	collect(data && data.query_analysis && data.query_analysis.query_details, ['date', 'query_date'])
	collect(data && data.loan_details && data.loan_details.bank_loans, ['start_date', 'end_date'])
	collect(data && data.loan_details && data.loan_details.non_bank_loans, ['start_date', 'end_date'])
	collect(data && data.loan_details && data.loan_details.unknown_loans, ['start_date', 'end_date'])
	collect(data && data.credit_card_details, ['start_date', 'end_date'])
	return latest
}

function anchorIsoDate(anchorMs) {
	return Number.isFinite(anchorMs) && anchorMs > 0
		? new Date(anchorMs).toISOString().slice(0, 10)
		: null
}

/** 按报告日期从查询明细重算窗口；不读取服务器当前时间。 */
function querySummaryFromDetails(details, anchorMs) {
	return buildQueryWindowSummary(details, Number(anchorMs) || 0)
}

/** 按报告日期从贷款明细重算 upcoming_6m。 */
function upcoming6mFromLoans(data, anchorMs) {
	const { debtBankLoans, debtNonBankLoans, debtUnknownLoans } = currentLoanRows(data)
	const rows = [...debtBankLoans, ...debtNonBankLoans, ...debtUnknownLoans]
	const nowT = Number(anchorMs) || 0
	if (nowT <= 0) return { count: 0, total_balance: 0, items: [] }
	const now = new Date(nowT)
	const horizonT = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 6, now.getUTCDate())
	const items = []
	for (const r of rows) {
		if (!r) continue
		const due = String(r.end_date || r.due_date || r.endDate || '').slice(0, 10)
		const t = Date.parse(due)
		if (!Number.isFinite(t) || t <= nowT || t > horizonT) continue
		const bal = safeInt(r.balance ?? r.loan_balance ?? r.remaining_balance)
		if (bal <= 0) continue
		items.push({
			institution: String(r.institution || r.bank || r.org || '—').trim(),
			balance: bal,
			due_date: due
		})
	}
	items.sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)))
	const total_balance = items.reduce((s, x) => s + safeInt(x.balance), 0)
	return { count: items.length, total_balance, items }
}

/**
 * 把任意输入收敛为 0~100 数字；非数字 / 负值返回 null（表示无数据，前端要画灰）。
 */
function clampScore(v) {
	if (v === null || v === undefined || v === '') return null
	const n = typeof v === 'number' ? v : parseFloat(String(v))
	if (!Number.isFinite(n)) return null
	return Math.max(0, Math.min(100, Math.round(n)))
}

/**
 * 主评分框架适配器（v2 细粒度版）
 *
 * 从嵌套 ai-proxy 数据结构提取 flat dim → 委托共享算法核心。
 * 算法权威源：ai-proxy/backend/scoringAlgorithms.cjs
 *
 * 规则口径（取最高命中，不累计；扣分阶梯为演示配置）：
 *   >50:-48  >30:-36  >15:-24  >6:-9  >3:-3
 *   非银贷款集中度：≥10:-33  ≥5:-21
 *   信用卡使用率：>90%:-27  >70%:-9  >50%:-3
 *   大额分期：-24
 *   近6月查询：>12:-27  >6:-9  >3:-3
 *   同日查询>3次：-21
 */
function calculatePrimaryRuleScore(data) {
	const { activeBankLoans, activeNonBankLoans, activeUnknownLoans } = currentLoanRows(data)
	const activeLoanCount = activeBankLoans.length + activeUnknownLoans.length
	const activeNonBankLoanCount = activeNonBankLoans.length
	const activeCards = Array.isArray(data.credit_card_details) ? data.credit_card_details.filter(isActiveCardRow) : []
	const activeCardCount = activeCards.length
	const totalAccounts = activeLoanCount + activeNonBankLoanCount + activeCardCount

	const usageRate = safeFloat(data.credit_debt?.credit_cards?.usage_rate)

	const evidenceV2 = data.derivation_meta?.evidence_mode === 'evidence-v2'
	// 未激活卡计入账户数，但其字段为 NOT_APPLICABLE，不参与大额分期口径。
	const installmentEligibleCards = activeCards.filter((row) => !isNotActivatedCardStatus(row?.status))
	const installmentCards = evidenceV2 ? installmentEligibleCards.filter(isExplicitCnyCardRow) : installmentEligibleCards
	let bigInstallmentTotal = evidenceV2
		? 0
		: safeInt(data.credit_debt?.credit_cards?.large_installment)
	if (!bigInstallmentTotal && installmentCards.length) {
		for (const c of installmentCards) {
			bigInstallmentTotal += safeInt(c && (c.installment || c.large_installment))
		}
	}

	const q6 = safeInt(data.query_analysis?.summary?.last_6m?.total)

	const details = Array.isArray(data.query_analysis?.query_details) ? data.query_analysis.query_details : []
	const queryBursts = summarizeHardQueryBursts(details, resolveAnalysisAnchorMs(data), { months: 6 })
	const sameDayTriggered = queryBursts.sameDayInquiryDayCount > 0

	const dim = {
		totalAccountCount: totalAccounts,
		nonBankLoanCount: activeNonBankLoanCount,
		cardUtilizationRate: usageRate,
		hasBigInstallment: bigInstallmentTotal > 0,
		q6,
		sameDayInquiryDayCount: sameDayTriggered ? 1 : 0
	}

	const result = calculatePrimaryRuleScoreCore(dim)
	result.metrics = {
		totalAccounts,
		activeNonBankLoanCount,
		cardUsageRate: usageRate,
		bigInstallmentTotal,
		q6,
		sameDayTriggered
	}
	return result
}

// applyOverdueTotalCap — 已从共享权威源 ai-proxy/backend/scoringAlgorithms.cjs 导入，不再本地维护副本。

/**
 * 生成单条同位对比行：
 * @param {string} metric    指标名
 * @param {number} value     当前用户数值（已是真实小数/计数）
 * @param {number} p50       人群中位数参考
 * @param {number} p75       人群偏弱分位参考（>p75 → 弱于多数人）
 * @param {object} opts      { unit, scale, betterLower }
 *                           - scale: 1 = 直接显示；100 = 内部小数，UI 显示百分数
 *                           - betterLower: true 表示数值越低越好（多数信用指标）
 */
function peerRow(metric, value, p50, p75, opts = {}) {
	const v = typeof value === 'number' && Number.isFinite(value) ? value : 0
	const scale = opts.scale || 1
	const display = (x) => {
		const out = scale === 100 ? `${Math.round(x * 100)}%` : `${Math.round(x * 100) / 100}${opts.unit || ''}`
		return out
	}
	let status = 'avg'
	if (opts.betterLower) {
		if (v <= p50) status = 'better'
		else if (v >= p75) status = 'worse'
	} else {
		if (v >= p75) status = 'better'
		else if (v <= p50) status = 'worse'
	}
	const max = Math.max(p75 * 1.5, v * 1.2, p50, 0.01)
	const ratio = Math.max(0, Math.min(1, v / max))
	return {
		metric,
		value: v,
		display: display(v),
		peer_p50: p50,
		peer_p50_display: display(p50),
		peer_p75: p75,
		peer_p75_display: display(p75),
		status,
		bar_ratio: Math.round(ratio * 100) / 100
	}
}

/** 统一逾期明细行，供 tables.overdue 与 overdue_info.details 复用 */
function normalizeOverdueTableRows(details) {
	if (!Array.isArray(details)) return []
	const rows = []
	let i = 0
	for (const raw of details) {
		if (!raw || typeof raw !== 'object') continue
		i += 1
		const institution =
			String(
				raw.institution ||
					raw.account ||
					raw.bank ||
					raw.org_name ||
					raw.管理机构 ||
					raw.account_name ||
					raw.creditor ||
					''
			).trim()
		const desc = String(
			raw.desc || raw.remark || raw.type || raw.account_type || raw.reason || raw.level || ''
		).trim()
		const amt = safeInt(raw.amount ?? raw.overdue_amount ?? raw.逾期金额 ?? raw.money ?? raw.balance)
		const date = String(raw.date || raw.overdue_date || raw.逾期日期 || raw.month || raw.period || '').trim()
		const label = institution || desc || '逾期记录'
		rows.push({
			seq: raw.seq != null ? safeInt(raw.seq) : i,
			institution: label,
			desc: institution && desc && desc !== institution ? desc : '',
			amount: amt,
			date: date || '—'
		})
	}
	return rows
}

class CreditRuleEngine {
	constructor(rawData) {
		this.data = rawData && typeof rawData === 'object' ? JSON.parse(JSON.stringify(rawData)) : {}
		this.risk_hits = []
		this.warnings = []
		this.isDeterministic = this.data.derivation_meta?.mode === 'deterministic-v1'
		this.isEvidenceV2 = this.data.derivation_meta?.evidence_mode === 'evidence-v2'
		this.anchorMs = resolveAnalysisAnchorMs(this.data)
	}

	runAll() {
		this._ensureSkeleton()
		this._recalcTimeWindows()
		this._normalizeOverdueDetails()
		this._calcCreditCardUsage()
		this._calcDebtStructure()
		this._checkQueryDensity()
		this._checkP2pRisk()
		this._checkUpcomingDue()
		this._checkOverdueRisk()
		this._checkDebtRatio()
		this._checkAccountVelocity()
		this._checkInstitutionDiversity()
		this._checkLargeInstallment()
		this._checkGuaranteeExposure()
		this._checkDebtSpiral()
		this._checkMonthlyBurden()
		this._checkDormantCards()
		this._checkReportFreshness()
		this._validateConsistency()
		this._mergeRiskHits()
		this._healthyFallback()
		this._deriveDeterministicScores()
		this._buildScoreBreakdown()
		this._buildRadar()
		this._buildImprovementPlan()
		this._buildPeerComparison()
		this._buildDataCompleteness()
		this.data.frontend_payload = assembleFrontendPayload(this.data)
		this.data.rule_engine_warnings = this.warnings.slice()
		return this.data
	}

	_ensureSkeleton() {
		const d = this.data
		if (!d.meta || typeof d.meta !== 'object') d.meta = {}
		if (!d.basic_info || typeof d.basic_info !== 'object') d.basic_info = {}
		if (!d.risk_analysis || typeof d.risk_analysis !== 'object') d.risk_analysis = { risk_hits: [] }
		if (!Array.isArray(d.risk_analysis.risk_hits)) d.risk_analysis.risk_hits = []
		if (!d.credit_debt || typeof d.credit_debt !== 'object') d.credit_debt = {}
		if (!d.credit_debt.credit_loans || typeof d.credit_debt.credit_loans !== 'object') {
			d.credit_debt.credit_loans = {}
		}
		if (!d.credit_debt.credit_cards || typeof d.credit_debt.credit_cards !== 'object') {
			d.credit_debt.credit_cards = {}
		}
		if (!d.credit_debt.upcoming_6m || typeof d.credit_debt.upcoming_6m !== 'object') {
			d.credit_debt.upcoming_6m = { items: [] }
		}
		if (!Array.isArray(d.credit_debt.upcoming_6m.items)) d.credit_debt.upcoming_6m.items = []
		if (!d.loan_details || typeof d.loan_details !== 'object') d.loan_details = {}
		if (!Array.isArray(d.loan_details.bank_loans)) d.loan_details.bank_loans = []
		if (!Array.isArray(d.loan_details.non_bank_loans)) d.loan_details.non_bank_loans = []
		if (!Array.isArray(d.loan_details.unknown_loans)) d.loan_details.unknown_loans = []
		if (!d.query_analysis || typeof d.query_analysis !== 'object') d.query_analysis = {}
		if (!d.query_analysis.summary || typeof d.query_analysis.summary !== 'object') {
			d.query_analysis.summary = {}
		}
		if (!d.overdue_info || typeof d.overdue_info !== 'object') d.overdue_info = {}
		if (!Array.isArray(d.overdue_info.details)) d.overdue_info.details = []
		if (!d.assessment || typeof d.assessment !== 'object') d.assessment = {}
		if (!d.derivation_meta || typeof d.derivation_meta !== 'object') d.derivation_meta = {}
		if (this.isDeterministic) {
			d.derivation_meta.mode = 'deterministic-v1'
			d.derivation_meta.anchor_date = anchorIsoDate(this.anchorMs)
		}
	}

	/** 查询窗口、近6月到期：固定按报告日期重算，不随服务器时间漂移。 */
	_recalcTimeWindows() {
		const d = this.data
		const details = d.query_analysis?.query_details
		if (Array.isArray(details) && details.length > 0) {
			d.query_analysis.summary = querySummaryFromDetails(details, this.anchorMs)
			d.query_analysis.all_query_summary = buildQueryWindowSummary(
				details,
				this.anchorMs,
				{ hardOnly: false }
			)
		} else if (this.isDeterministic) {
			d.query_analysis.summary = querySummaryFromDetails([], this.anchorMs)
			d.query_analysis.all_query_summary = buildQueryWindowSummary(
				[],
				this.anchorMs,
				{ hardOnly: false }
			)
		}
		if (this.isDeterministic) {
			d.query_analysis.window_policy = {
				anchor: 'report_date',
				boundary: 'calendar-month-inclusive',
				counted: 'hard-credit-inquiries-only',
				excluded: ['本人/自查', '贷后管理', '异议/账户管理']
			}
		}
		const hasLoans =
			(Array.isArray(d.loan_details?.bank_loans) && d.loan_details.bank_loans.length > 0) ||
			(Array.isArray(d.loan_details?.non_bank_loans) && d.loan_details.non_bank_loans.length > 0) ||
			(Array.isArray(d.loan_details?.unknown_loans) && d.loan_details.unknown_loans.length > 0)
		if (hasLoans || this.isDeterministic) {
			d.credit_debt.upcoming_6m = upcoming6mFromLoans(d, this.anchorMs)
		}
	}

	_normalizeOverdueDetails() {
		const o = this.data.overdue_info
		if (!o || typeof o !== 'object') return
		const raw = o.details
		if (!Array.isArray(raw) || raw.length === 0) return
		const norm = normalizeOverdueTableRows(raw)
		o.details = norm
		if (safeInt(o.total_overdue_accounts) <= 0 && norm.length) {
			o.total_overdue_accounts = norm.length
			this.warnings.push('逾期账户数已按明细条数由规则引擎补全')
		}
		if (norm.length && !o.has_overdue) {
			o.has_overdue = true
		}
	}

	_mergeRiskHits() {
		const aiHits = !this.isDeterministic && Array.isArray(this.data.risk_analysis.risk_hits)
			? this.data.risk_analysis.risk_hits
			: []
		const merged = dedupeHits([...this.risk_hits, ...aiHits]).filter((hit) => (
			!DIAGNOSTIC_ONLY_DEBT_RATIO_RULES.has(String(hit && hit.rule_name || '').trim().toUpperCase())
		))
		this.data.risk_analysis.risk_hits = merged
	}

	_calcCreditCardUsage() {
		const cards = Array.isArray(this.data.credit_card_details) ? this.data.credit_card_details : []
		const cd = ensureDeep(this.data, ['credit_debt', 'credit_cards'], () => ({}))
		const utilization = summarizeCreditCardUtilization(cards, {
			trustExplicitSharedGroup: this.isEvidenceV2,
			allowHeuristicSharedCredit: false
		})
		const preserveCompleteSummary =
			!this.isDeterministic && /完整汇总优先/.test(String(cd.utilization_basis || ''))
		let totalLimit = preserveCompleteSummary ? safeInt(cd.total_limit) : utilization.totalLimit
		let utilizationUsed = preserveCompleteSummary ? safeInt(cd.total_used) : utilization.totalUsed
		let cardOutstanding = preserveCompleteSummary ? safeInt(cd.total_used) : utilization.cardOutstanding
		if (totalLimit <= 0 && safeInt(cd.total_limit) > 0 && cards.length === 0) {
			totalLimit = safeInt(cd.total_limit)
			utilizationUsed = safeInt(cd.utilization_used ?? cd.total_used)
			cardOutstanding = safeInt(cd.total_used)
		}
		if (totalLimit > 0 || cardOutstanding > 0) {
			const usage = totalLimit > 0
				? Math.round((utilizationUsed / totalLimit) * 10000) / 10000
				: 0
			cd.usage_rate = usage
			cd.total_limit = totalLimit
			cd.total_used = cardOutstanding
			cd.utilization_used = utilizationUsed
			if (cards.length > 0) {
				cd.raw_total_limit = utilization.rawTotalLimit
				cd.raw_total_used = utilization.rawTotalUsed
				cd.utilization_group_count = preserveCompleteSummary ? safeInt(cd.card_count) : utilization.utilizationGroupCount
				cd.shared_group_count = utilization.sharedGroupCount
				cd.inferred_shared_group_count = utilization.inferredSharedGroupCount
				cd.foreign_currency_account_count = utilization.foreignAccountCount
				cd.foreign_only_group_count = utilization.foreignOnlyGroupCount
				if (this.isEvidenceV2) {
					cd.shared_credit_candidates = utilization.candidateGroups
				}
				if (!preserveCompleteSummary) {
					cd.utilization_basis = this.isEvidenceV2
						? '人民币可比账户求和；共享额度仅接受已核验证据；候选关系不自动去重；外币不直接相加'
						: '人民币可比账户独立求和；没有核验证据不合并共享额度；外币不直接相加'
				}
			}
			const remain = Math.max(0, totalLimit - utilizationUsed)
			cd.chart_basis = 'positive-limit-utilization'
			cd.chart_data = [
				{ name: '已使用', value: utilizationUsed, color: COLORS.ccUsed },
				{ name: '剩余额度', value: remain, color: COLORS.ccAvail }
			]
			if (usage > 0.9) {
				this.risk_hits.push({
					level: '风险',
					rule_name: 'CC_USAGE_HIGH',
					title: '信用卡使用率过高',
					detail: `使用率${(usage * 100).toFixed(1)}%，建议降至70%以下`,
					severity: 4
				})
			} else if (usage > 0.7) {
				this.risk_hits.push({
					level: '提示',
					rule_name: 'CC_USAGE_WARNING',
					title: '信用卡使用率偏高',
					detail: `使用率${(usage * 100).toFixed(1)}%`,
					severity: 2
				})
			}
		}
	}

	_calcDebtStructure() {
		const cl = this.data.credit_debt.credit_loans
		const bankAmt = safeInt(cl.bank_amount)
		const nonAmt = safeInt(cl.non_bank_amount)
		const unknownAmt = safeInt(cl.unknown_amount)
		if (bankAmt + nonAmt + unknownAmt > 0) {
			cl.chart_data = [
				{ name: '银行类', value: bankAmt, color: COLORS.bank },
				{ name: '非银类', value: nonAmt, color: COLORS.nonBank },
				...(unknownAmt > 0
					? [{ name: '未分类', value: unknownAmt, color: '#94A3B8' }]
					: [])
			]
		}
		const od = this.data.other_debts
		if (od && typeof od === 'object') {
			const totalOther =
				safeInt(od.mortgage?.amount) +
				safeInt(od.car_loan?.amount) +
				safeInt((od.credit_loan || od.creditLoan || od.consumer_loan || od.consumerLoan)?.amount) +
				safeInt(od.business_loan?.amount) +
				safeInt(od.guarantee?.amount)
			if (totalOther > 0) {
				const pct = (part) => (totalOther > 0 ? Math.round((part / totalOther) * 10000) / 10000 : 0)
				;['mortgage', 'car_loan', 'credit_loan', 'consumer_loan', 'business_loan', 'guarantee'].forEach((k) => {
					if (od[k] && typeof od[k] === 'object') {
						od[k].percentage = pct(safeInt(od[k].amount))
					}
				})
			}
			const creditLoan = od.credit_loan || od.creditLoan || od.consumer_loan || od.consumerLoan || {}
			od.chart_data = [
				{ name: '房贷', value: safeInt(od.mortgage?.amount), color: COLORS.mortgage },
				{ name: '车贷', value: safeInt(od.car_loan?.amount), color: COLORS.car },
				{ name: '信用贷款', value: safeInt(creditLoan.amount), color: COLORS.creditLoan },
				{ name: '经营贷', value: safeInt(od.business_loan?.amount), color: COLORS.biz },
				{ name: '对外担保', value: safeInt(od.guarantee?.amount), color: COLORS.guarantee }
			]
		}
	}

	_checkQueryDensity() {
		const summary = this.data.query_analysis.summary || {}
		const last1m = safeInt(summary.last_1m?.total)
		const last3m = safeInt(summary.last_3m?.total)
		if (last1m >= 3) {
			this.risk_hits.push({
				level: '风险',
				rule_name: 'QUERY_DENSE_1M',
				title: '近1个月查询过多',
				detail: `硬查询${last1m}次，金融机构可能认为资金紧张`,
				severity: 3
			})
		} else if (last3m >= 6) {
			this.risk_hits.push({
				level: '提示',
				rule_name: 'QUERY_DENSE_3M',
				title: '近3个月查询较多',
				detail: `硬查询${last3m}次`,
				severity: 2
			})
		}
	}

	_checkP2pRisk() {
		const nonBank = currentLoanRows(this.data).activeNonBankLoans
		const count = nonBank.length
		if (count >= 5) {
			this.risk_hits.push({
				level: '风险',
				rule_name: 'SUSPECT_P2P_LOANS',
				title: '疑似网贷多',
				detail: `${count}笔非银贷款，存在多头借贷风险`,
				severity: 4
			})
		}
	}

	_checkUpcomingDue() {
		const u = this.data.credit_debt.upcoming_6m
		const items = u.items || []
		let sum = 0
		for (const it of items) {
			sum += safeInt(it.balance)
		}
		if (items.length && sum > 0 && safeInt(u.total_balance) <= 0) {
			u.total_balance = sum
			this.warnings.push('近6个月到期合计余额已由规则引擎按明细重算')
		}
		if (items.length >= 8) {
			this.risk_hits.push({
				level: '提示',
				rule_name: 'UPCOMING_MANY',
				title: '近6个月到期笔数较多',
				detail: `${items.length}笔即将到期，请关注现金流`,
				severity: 2
			})
		}
	}

	_checkOverdueRisk() {
		const o = this.data.overdue_info
		if (!o || typeof o !== 'object') return
		if (o.has_overdue || safeInt(o.total_overdue_accounts) > 0) {
			const historical = Array.isArray(this.data.loan_details?.historical_overdue_loans)
				? this.data.loan_details.historical_overdue_loans
				: []
			const large = historical.find((row) => safeInt(row.credit_limit || row.amount) >= 1000000)
			const detail = large
				? `${large.institution || '贷款机构'}历史${large.type || '贷款'}${(safeInt(large.credit_limit || large.amount) / 10000).toFixed(0)}万，曾出现${safeInt(large.overdue_months) || 1}个月逾期；当前未见余额，不计入当前负债。`
				: `逾期账户${safeInt(o.total_overdue_accounts)}个，90天以上${safeInt(o.overdue_90_days)}次`
			this.risk_hits.push({
				level: '风险',
				rule_name: 'OVERDUE_ACTIVE',
				title: '存在当前或历史逾期风险',
				detail,
				severity: 5
			})
		}
	}

	_checkReportFreshness() {
		const reportDate = this.data.meta && this.data.meta.report_date
		if (!reportDate || typeof reportDate !== 'string') return
		const evaluationDate = anchorIsoDate(this.anchorMs)
		if (!evaluationDate) return
		const d = daysBetween(reportDate, evaluationDate)
		if (d != null && d > 180) {
			this.risk_hits.push({
				level: '提示',
				rule_name: 'REPORT_STALE',
				title: '报告时效性一般',
				detail: `距报告生成日已${d}天，建议拉取最新征信`,
				severity: 1
			})
		}
	}

	/**
	 * `debt_ratio` is an archival ratio (`totalDebt / totalLine`). Until the
	 * denominator has an evidence-complete contract it must not create a risk
	 * hit, change a risk level, or feed a decision. Keep an explicit status so
	 * downstream presentation can label the value as pending verification.
	 */
	_checkDebtRatio() {
		const cd = this.data.credit_debt
		if (!cd) return
		cd.debt_ratio_policy = {
			metric: 'credit-line-utilization',
			formula: 'totalDebt/totalLine',
			unit: 'ratio',
			status: DEBT_RATIO_DIAGNOSTIC_STATUS,
			decision_eligible: false,
			risk_rule_status: 'disabled'
		}
	}

	/**
	 * 近6个月新开户数：贷款 + 信用卡明细，取 start_date / open_date 在近 6 个月内的笔数。
	 * 7 笔以上视为新开户过多。
	 */
	_checkAccountVelocity() {
		const now = this.anchorMs
		if (!Number.isFinite(now) || now <= 0) return
		const sixMs = 180 * 86400000
		const countNew = (rows, dateKeys) => {
			if (!Array.isArray(rows)) return 0
			let n = 0
			for (const r of rows) {
				if (!r) continue
				if (!isDebtBearingLoanRow(r) && !isActiveCardRow(r)) continue
				for (const k of dateKeys) {
					const t = Date.parse(String(r[k] || '').slice(0, 10))
					if (Number.isFinite(t) && now - t <= sixMs) {
						n += 1
						break
					}
				}
			}
			return n
		}
		const { activeBankLoans, activeNonBankLoans, activeUnknownLoans } = currentLoanRows(this.data)
		const loanNew =
			countNew(activeBankLoans, ['start_date', 'open_date']) +
			countNew(activeNonBankLoans, ['start_date', 'open_date']) +
			countNew(activeUnknownLoans, ['start_date', 'open_date'])
		const cardNew = countNew((this.data.credit_card_details || []).filter(isActiveCardRow), ['start_date', 'open_date'])
		const total = loanNew + cardNew
		if (total >= 7) {
			this.risk_hits.push({
				level: '风险',
				rule_name: 'ACCOUNT_OPENED_BURST',
				title: '近6个月新增账户过多',
				detail: `近6月新增贷款${loanNew}笔 + 信用卡${cardNew}张`,
				severity: 3
			})
		}
	}

	/**
	 * 借款机构集中度：唯一机构数 >= 8 视为过于分散。
	 */
	_checkInstitutionDiversity() {
		const set = new Set()
		const collect = (rows, key = 'institution') => {
			if (!Array.isArray(rows)) return
			for (const r of rows) {
				const v = r && r[key] ? String(r[key]).trim() : ''
				if (v) set.add(v)
			}
		}
		const { activeBankLoans, activeNonBankLoans, activeUnknownLoans } = currentLoanRows(this.data)
		collect(activeBankLoans)
		collect(activeNonBankLoans)
		collect(activeUnknownLoans)
		collect((this.data.credit_card_details || []).filter(isActiveCardRow))
		if (set.size >= 8) {
			this.risk_hits.push({
				level: '警告',
				rule_name: 'INSTITUTION_DIVERSITY_HIGH',
				title: '借款机构过多',
				detail: `跨${set.size}家机构存在授信/借款，可能被识别为多头借贷`,
				severity: 3
			})
		}
		this.data._diagnostics = this.data._diagnostics || {}
		this.data._diagnostics.institution_count = set.size
	}

	/** 大额分期：信用卡明细中带 installment 字段或 large_installment 总额 >= 5 万 */
	_checkLargeInstallment() {
		const cd = this.data.credit_debt?.credit_cards || {}
		const cards = Array.isArray(this.data.credit_card_details)
			? this.data.credit_card_details.filter((row) => isActiveCardRow(row) && !isNotActivatedCardStatus(row?.status))
			: []
		const installmentCards = this.isEvidenceV2 ? cards.filter(isExplicitCnyCardRow) : cards
		let total = this.isEvidenceV2 ? 0 : safeInt(cd.large_installment)
		if (!total) {
			for (const c of installmentCards) {
				total += safeInt(c.installment || c.large_installment || 0)
			}
		}
		if (total >= 50000) {
			this.risk_hits.push({
				level: '警告',
				rule_name: 'CARD_LARGE_INSTALLMENT',
				title: '存在大额信用卡分期',
				detail: `合计分期余额约 ${(total / 10000).toFixed(1)}万元，建议纳入真实负债评估`,
				severity: 2
			})
		}
	}

	/** 对外担保：other_debts.guarantee.amount > 0 即提示 */
	_checkGuaranteeExposure() {
		const g = this.data.other_debts?.guarantee || {}
		const amt = safeInt(g.amount)
		if (amt > 0) {
			this.risk_hits.push({
				level: '警告',
				rule_name: 'GUARANTEE_EXPOSURE',
				title: '存在对外担保',
				detail: `担保敞口约 ${(amt / 10000).toFixed(1)}万元，请关注被担保方还款状况`,
				severity: 3
			})
		}
	}

	/** 没有已验证风险命中时，明确保留未纳入决策的指标边界。 */
	_healthyFallback() {
		const list = this.data.risk_analysis.risk_hits
		if (Array.isArray(list) && list.length === 0) {
			list.push({
				level: '信息',
				rule_name: 'HEALTHY_NO_RISK',
				title: '已验证规则未发现风险',
				detail: '已纳入证据合同的规则未发现红色信号；授信占用率等待核对指标不在本结论内',
				severity: 1
			})
		}
	}

	/**
	 * 从账户、查询、逾期等原始事实生成评分输入与四维分。
	 * 模型返回的 six_dimensions 在确定性链路中不会被读取。
	 */
	_deriveDeterministicScores() {
		const d = this.data
		const {
			bankLoans,
			nonBankLoans,
			unknownLoans,
			activeBankLoans,
			activeNonBankLoans,
			activeUnknownLoans,
			debtBankLoans,
			debtNonBankLoans,
			debtUnknownLoans
		} = currentLoanRows(d)
		const activeCards = Array.isArray(d.credit_card_details)
			? d.credit_card_details.filter(isActiveCardRow)
			: []
		const cancelledCards = Array.isArray(d.credit_card_details_cancelled)
			? d.credit_card_details_cancelled
			: []
		const settledLoans = Array.isArray(d.loan_details?.settled_loans)
			? d.loan_details.settled_loans
			: []
		const closedLoans = [...bankLoans, ...nonBankLoans, ...unknownLoans]
			.filter((row) => isClosedLoanStatus(row && row.status))
		const settledAccountCount = settledLoans.length + closedLoans.length + cancelledCards.length
		const activeAccountCount = activeBankLoans.length + activeNonBankLoans.length + activeUnknownLoans.length + activeCards.length
		const totalAccountCount = activeAccountCount + settledAccountCount

		const datedRows = [
			...bankLoans,
			...nonBankLoans,
			...unknownLoans,
			...settledLoans,
			...activeCards,
			...cancelledCards
		]
		const ages = []
		if (this.anchorMs > 0) {
			for (const row of datedRows) {
				const opened = parseQueryIsoDate(row && (row.start_date || row.open_date || row.startDate || row.openDate))
				if (opened == null || opened > this.anchorMs) continue
				ages.push((this.anchorMs - opened) / (365.25 * 86400000))
			}
		}

		const querySummary = d.query_analysis?.summary || {}
		const q = (key) => safeInt(querySummary[key]?.total)
		const queryDetails = Array.isArray(d.query_analysis?.query_details)
			? d.query_analysis.query_details
			: []
		let queriesLast7d = 0
		let loanQueryCount = 0
		let cardQueryCount = 0
		const oneMonthStart = subtractCalendarMonths(this.anchorMs, 1)
		for (const row of queryDetails) {
			if (!isHardCreditQuery(row)) continue
			const t = parseQueryDateMs(row && (row.date || row.query_date))
			if (!t || this.anchorMs <= 0 || t > this.anchorMs) continue
			if (this.anchorMs - t <= 7 * 86400000) queriesLast7d += 1
			if (t >= oneMonthStart) {
				const reason = String(row.reason || row.query_reason || '')
				if (/贷款审批|担保资格审查|担保审查|保前审查|融资审批|授信审批/.test(reason)) loanQueryCount += 1
				if (/信用卡审批|贷记卡审批/.test(reason)) cardQueryCount += 1
			}
		}
		const sameDayInquiryDayCount = summarizeHardQueryBursts(
			queryDetails,
			this.anchorMs,
			{ months: 6 }
		).sameDayInquiryDayCount

		const overdue = this._overdueCapInputs()
		const overdueDetails = Array.isArray(d.overdue_info?.details) ? d.overdue_info.details : []
		const maxOverdueDays = overdueDetails.reduce(
			(max, row) => Math.max(max, safeInt(row && (row.overdue_days ?? row.days ?? row.months))),
			safeInt(d.overdue_info?.max_overdue_days)
		)
		const hasPublicRecord = !!(
			d.public_records &&
			(d.public_records.has_record === true ||
				(Array.isArray(d.public_records.items) && d.public_records.items.length > 0))
		)

		const dim = {
			totalAccountCount,
			activeAccountCount,
			settledAccountCount,
			creditCardCount: activeCards.length + cancelledCards.length,
			loanCount: bankLoans.length + nonBankLoans.length + unknownLoans.length + settledLoans.length,
			nonBankLoanCount: activeNonBankLoans.length,
			oldestAccountYears: ages.length ? Math.max(...ages) : 0,
			avgAccountYears: ages.length ? ages.reduce((sum, value) => sum + value, 0) / ages.length : 0,
			q1: q('last_1m'),
			q3: q('last_3m'),
			q6: q('last_6m'),
			q12: q('last_12m'),
			loanQueryCount,
			cardQueryCount,
			has30dConcentrated: q('last_1m') > 2,
			has7dConcentrated: queriesLast7d > 2,
			sameDayInquiryDayCount,
			overdueCount: overdue.overdueCount,
			m1Count: overdue.m1Count,
			m2Count: overdue.m2Count,
			m3Count: overdue.m3Count,
			maxOverdueDays,
			hasLianSan: overdue.hasLianSan,
			hasLeiLiu: overdue.hasLeiLiu,
			hasPublicRecord,
			cardUtilizationRate: safeFloat(d.credit_debt?.credit_cards?.usage_rate),
			totalDebt: safeInt(d.credit_debt?.total_debt),
			debtRatio: safeFloat(d.credit_debt?.debt_ratio)
		}
		d.deterministic_dimensions = dim
		d.six_dimensions = scoreFourDimensions(dim)
	}

	/**
	 * 四维评分拆解：把规则引擎生成的 six_dimensions 转换为
	 * [{ key, label, weight, value, weighted, status }]，前端可直接渲染。
	 */
	_buildScoreBreakdown() {
		const dim = this.data.six_dimensions || {}
		const breakdown = []
		const four = {}
		let weightSum = 0
		for (const key of Object.keys(FOUR_DIM_WEIGHTS)) {
			const weight = FOUR_DIM_WEIGHTS[key]
			const value = clampScore(dim[key])
			if (value == null) {
				breakdown.push({ key, label: SIX_DIM_LABEL[key], weight, value: null, weighted: 0, status: '—' })
				continue
			}
			const weighted = Math.round(value * weight * 100) / 100
			four[key] = value
			weightSum += weight
			breakdown.push({
				key,
				label: SIX_DIM_LABEL[key],
				weight,
				value,
				weighted,
				status: value >= 85 ? '优' : value >= 70 ? '良' : value >= 60 ? '一般' : '弱'
			})
		}
			// 委托共享权威源计算加权综合分（含逾期硬上限），消除 CJS/ESM 双维护。
		const hasAny = Object.values(four).some(v => v != null)
		const composed = hasAny
			? composeFourDimTotal(four, this._overdueCapInputs())
			: null
		this.data.assessment = this.data.assessment || {}
		this.data.assessment.score_breakdown = breakdown
		if (composed != null) {
			this.data.assessment.composed_score = composed
			if (safeInt(this.data.assessment.score, 0) <= 0) {
				this.data.assessment.score = Math.round(composed)
			}
		}
	}

	/**
	 * 由 overdue_info + 已合并 risk_hits 推导逾期上限输入（口径对齐前端/本地）。
	 *
	 * M1/M2 来源优先级：
	 *   1) overdue_info 的直接字段（overdue_30_days / overdue_60_days / m1_count / m2_count）
	 *   2) details[] 明细中按逾期月数分级计数（desc/level 含 M1/M2/30天/60天 等标识）
	 *   3) 兜底 0（AI prompt 当前未强制输出 M1/M2 颗粒度）
	 */
	_overdueCapInputs() {
		const o = (this.data && this.data.overdue_info) || {}
		const hits = Array.isArray(this.data.risk_analysis && this.data.risk_analysis.risk_hits)
			? this.data.risk_analysis.risk_hits
			: []
		const hitText = hits
			.map((h) => String((h && h.rule_name) || '') + String((h && h.title) || ''))
			.join('|')

		// ── M3+：优先 overdue_90_days 字段 ──
		let m3Count = safeInt(o.overdue_90_days) > 0 ? safeInt(o.overdue_90_days) : 0
		// ── M2：优先 overdue_60_days 字段；其次从 details 中按标识计数 ──
		let m2Count = safeInt(o.overdue_60_days ?? o.m2_count) || 0
		// ── M1：优先 overdue_30_days 字段；其次从 details 中按标识计数 ──
		let m1Count = safeInt(o.overdue_30_days ?? o.m1_count) || 0

		// 若直接字段均为 0，尝试从 details[] 中按级别描述推断 M2/M1/M3
		const details = Array.isArray(o.details) ? o.details : []
		if (m3Count === 0 && m2Count === 0 && m1Count === 0 && details.length > 0) {
			for (const d of details) {
				if (!d) continue
				const desc = String(d.desc || d.level || d.type || d.remark || '').toLowerCase()
				const months = safeInt(d.months ?? d.overdue_months ?? d.overdue_days)
				if (months > 0) {
					// 按实际逾期天数/月数分级
					if (months >= 90) m3Count++
					else if (months >= 60) m2Count++
					else if (months >= 30) m1Count++
				} else if (/[m3]|90|九十|[３3]/.test(desc) || /严重|呆账|核销/.test(desc)) {
					m3Count++
				} else if (/[m2]|60|六十|[２2]/.test(desc)) {
					m2Count++
				} else if (/[m1]|30|三十|[１1]/.test(desc)) {
					m1Count++
				}
			}
		}

		const overdueCount = o.has_overdue === true || safeInt(o.total_overdue_accounts) > 0
			? Math.max(1, safeInt(o.total_overdue_accounts))
			: 0

		// 若 details 分级计数后发现 M3/M2/M1 总数超过 overdueCount，用后者兜底
		const gradedTotal = m3Count + m2Count + m1Count
		if (gradedTotal > overdueCount && overdueCount > 0) {
			// 按优先级保留：M3 > M2 > M1，截断到 overdueCount
			const cap = overdueCount
			m3Count = Math.min(m3Count, cap)
			m2Count = Math.min(m2Count, cap - m3Count)
			m1Count = Math.min(m1Count, cap - m3Count - m2Count)
		}

		return {
			hasLeiLiu: o.has_lei_liu === true || /累六|LEI_LIU/i.test(hitText),
			hasLianSan: o.has_lian_san === true || /连三|LIAN_SAN/i.test(hitText),
			m3Count,
			m2Count,
			m1Count,
			overdueCount
		}
	}

	/** 雷达坐标：把四维 0-100 标准化到 0-1，供 SVG 多边形/CSS polygon 使用。 */
	_buildRadar() {
		const dim = this.data.six_dimensions || {}
		const axes = []
		const values = []
		const normalized = []
		for (const key of Object.keys(FOUR_DIM_WEIGHTS)) {
			const v = clampScore(dim[key])
			axes.push(SIX_DIM_LABEL[key])
			values.push(v == null ? 0 : v)
			normalized.push(v == null ? 0 : Math.max(0, Math.min(1, v / 100)))
		}
		this.data.assessment = this.data.assessment || {}
		this.data.assessment.radar = { axes, values, normalized }
	}

	/** 把规则命中映射成行动卡片，按优先级排序，去重保留高优先级。 */
	_buildImprovementPlan() {
		const hits = this.data.risk_analysis.risk_hits || []
		const map = new Map()
		for (const h of hits) {
			const k = h && h.rule_name ? String(h.rule_name) : ''
			if (!k) continue
			const tpl = RULE_ACTION_TEMPLATES[k]
			if (!tpl) continue
			const prev = map.get(k)
			if (!prev || tpl.priority > prev.priority) {
				map.set(k, {
					rule_name: k,
					priority: tpl.priority,
					level: h.level || '提示',
					title: tpl.title,
					action: tpl.action,
					impact: tpl.impact,
					origin: h.title || tpl.title
				})
			}
		}
		const plan = [...map.values()].sort((a, b) => b.priority - a.priority)
		this.data.assessment = this.data.assessment || {}
		this.data.assessment.improvement_plan = plan
	}

	/**
	 * 同位（peer）对比基线：用经验值 / 行业常见水位作为参考，
	 * 真实生产可替换为聚合表查询。返回 { metric, value, peer_p50, peer_p75, status }。
	 */
	_buildPeerComparison() {
		const cd = this.data.credit_debt || {}
		const usage = safeFloat(cd.credit_cards?.usage_rate)
		const q6 = safeInt(this.data.query_analysis?.summary?.last_6m?.total)
		const cards = Array.isArray(this.data.credit_card_details) ? this.data.credit_card_details.filter(isActiveCardRow).length : 0
		const nonBankCnt = currentLoanRows(this.data).activeNonBankLoans.length

		const rows = [
			peerRow('信用卡使用率', usage, 0.4, 0.7, { unit: '%', scale: 100, betterLower: true }),
			peerRow('近6月查询', q6, 6, 12, { unit: '次', scale: 1, betterLower: true }),
			peerRow('信用卡张数', cards, 4, 8, { unit: '张', scale: 1, betterLower: true }),
			peerRow('非银贷款数', nonBankCnt, 2, 5, { unit: '笔', scale: 1, betterLower: true })
		]

		this.data.peer_comparison = rows
		this.data.peer_comparison_meta = {
			scope: 'archival',
			decision_eligible: false
		}
	}

	/**
	 * 数据完整性诊断：10 个模块逐项校验 present/missing，结合 LLM 注入的 _coverage 元数据，
	 * 产出 data_completeness = { modules[], score, grade, source, notes }。
	 * 前端可据此显示「报告原文已读取 ✓ / 模型输出被截断 ⚠」等诊断卡。
	 */
	_buildDataCompleteness() {
		const d = this.data
		const cov = d._coverage && typeof d._coverage === 'object' ? d._coverage : {}
		const isObj = (x) => x && typeof x === 'object'
		const arrLen = (x) => (Array.isArray(x) ? x.length : 0)
		const modules = [
			{
				key: 'basic_info',
				label: '基础信息',
				present: !!(isObj(d.basic_info) && (d.basic_info.name || d.basic_info.id_last4 || d.basic_info.age)),
				detail: isObj(d.basic_info) && d.basic_info.name ? `姓名 ${d.basic_info.name}` : '缺少姓名/年龄/身份证后4位',
				critical: true
			},
			{
				key: 'meta',
				label: '报告元信息',
				present: !!(isObj(d.meta) && (d.meta.report_date || d.meta.query_date)),
				detail: isObj(d.meta) && d.meta.report_date ? `报告日期 ${d.meta.report_date}` : '缺少报告日期/查询日期',
				critical: true
			},
			{
				key: 'credit_debt',
				label: '信用负债总览',
				present: !!(isObj(d.credit_debt) && (safeInt(d.credit_debt.total_debt) > 0 || safeFloat(d.credit_debt.debt_ratio) > 0)),
				detail: isObj(d.credit_debt) && safeInt(d.credit_debt.total_debt) > 0
					? `总负债 ${(safeInt(d.credit_debt.total_debt) / 10000).toFixed(2)}万`
					: '总负债 / 负债率 为空',
				critical: true
			},
			{
				key: 'loan_details',
				label: '贷款明细',
				present: arrLen(d.loan_details && d.loan_details.bank_loans) +
					arrLen(d.loan_details && d.loan_details.non_bank_loans) +
					arrLen(d.loan_details && d.loan_details.unknown_loans) > 0,
				detail: `银行 ${arrLen(d.loan_details && d.loan_details.bank_loans)} 笔 / 非银 ${arrLen(d.loan_details && d.loan_details.non_bank_loans)} 笔 / 未分类 ${arrLen(d.loan_details && d.loan_details.unknown_loans)} 笔`,
				critical: true
			},
			{
				key: 'credit_card_details',
				label: '信用卡明细',
				present: arrLen(d.credit_card_details) > 0,
				detail: `${arrLen(d.credit_card_details)} 张`,
				critical: false
			},
			{
				key: 'overdue_info',
				label: '逾期信息',
				present: isObj(d.overdue_info) && (d.overdue_info.has_overdue === true || d.overdue_info.has_overdue === false),
				detail: isObj(d.overdue_info)
					? d.overdue_info.has_overdue
						? `${safeInt(d.overdue_info.total_overdue_accounts)} 个逾期账户`
						: '无当前/历史逾期'
					: '未读取',
				critical: true
			},
			{
				key: 'query_analysis',
				label: '查询记录',
				present:
					arrLen(d.query_analysis && d.query_analysis.query_details) +
						arrLen(d.query_analysis && d.query_analysis.self_queries) >
						0 ||
					(isObj(d.query_analysis && d.query_analysis.summary) &&
						safeInt(d.query_analysis.summary.last_6m && d.query_analysis.summary.last_6m.total) > 0),
				detail: `近6月 ${safeInt(d.query_analysis && d.query_analysis.summary && d.query_analysis.summary.last_6m && d.query_analysis.summary.last_6m.total)} 次 · 明细 ${arrLen(d.query_analysis && d.query_analysis.query_details)} 行`,
				critical: false
			},
			{
				key: 'public_records',
				label: '公共记录',
				present: !!(isObj(d.public_records) && (d.public_records.has_record === true || d.public_records.has_record === false || arrLen(d.public_records.items) > 0)),
				detail: isObj(d.public_records)
					? d.public_records.has_record
						? `${arrLen(d.public_records.items)} 条`
						: '无公共记录'
					: '未读取',
				critical: false
			},
			{
				key: 'guarantee',
				label: '对外担保',
				present: !!(isObj(d.other_debts && d.other_debts.guarantee) || isObj(d.guarantee_records)),
				detail:
					safeInt(d.other_debts && d.other_debts.guarantee && d.other_debts.guarantee.amount) > 0
						? `担保金额 ${(safeInt(d.other_debts.guarantee.amount) / 10000).toFixed(1)}万`
						: '无担保',
				critical: false
			},
			{
				key: 'assessment',
				label: '综合评估',
				present: !!(isObj(d.assessment) && (safeInt(d.assessment.score) > 0 || d.assessment.risk_level || (d.assessment.suggestion && String(d.assessment.suggestion).length > 0))),
				detail: isObj(d.assessment) && safeInt(d.assessment.score) > 0 ? `评分 ${safeInt(d.assessment.score)}` : '评分缺失',
				critical: true
			}
		]
		const present_count = modules.filter((m) => m.present).length
		const critical_total = modules.filter((m) => m.critical).length
		const critical_present = modules.filter((m) => m.critical && m.present).length
		const total_count = modules.length
		const raw_ratio = total_count > 0 ? present_count / total_count : 0
		const critical_ratio = critical_total > 0 ? critical_present / critical_total : 0
		const score = Math.round((critical_ratio * 0.7 + raw_ratio * 0.3) * 100)
		const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : 'D'
		const notes = []
		const missingCritical = modules.filter((m) => m.critical && !m.present).map((m) => m.label)
		if (missingCritical.length) notes.push(`关键模块缺失：${missingCritical.join('、')}`)
		if (cov.truncated) notes.push(`原文长度 ${safeInt(cov.source_text_length)} 字符，已对输入进行裁切（裁后 ${safeInt(cov.sent_text_length)} 字符）`)
		if (cov.llm_output_truncated) notes.push('模型输出因长度达到上限被截断，建议加大 max_tokens 或分段重试')
		this.data.data_completeness = {
			modules,
			score,
			grade,
			present_count,
			total_count,
			critical_present,
			critical_total,
			notes,
			source: {
				text_length: safeInt(cov.source_text_length),
				sent_length: safeInt(cov.sent_text_length),
				truncated: !!cov.truncated,
				llm_output_truncated: !!cov.llm_output_truncated,
				llm_finish_reason: cov.llm_finish_reason || null
			},
			scope: 'archival',
			decision_eligible: false
		}
	}

	/** 以贷养贷模式：非银贷款≥3 + 近3月查询≥6 + 信用卡使用率>70% 三者齐备 */
	_checkDebtSpiral() {
		const nonBank = currentLoanRows(this.data).activeNonBankLoans
		const q3 = safeInt(this.data.query_analysis?.summary?.last_3m?.total)
		const usage = safeFloat(this.data.credit_debt?.credit_cards?.usage_rate)
		if (nonBank.length >= 3 && q3 >= 6 && usage > 0.7) {
			this.risk_hits.push({
				level: '风险',
				rule_name: 'DEBT_SPIRAL',
				title: '疑似以贷养贷',
				detail: '非银' + nonBank.length + '笔 + 近3月查询' + q3 + '次 + 信用卡使用率' + (usage * 100).toFixed(0) + '%——三个风险信号叠加',
				severity: 5
			})
		}
	}

	/** 月均到期额可存档；与未证据化 debt_ratio 组合的风险规则已停用。 */
	_checkMonthlyBurden() {
		const u = this.data.credit_debt?.upcoming_6m || {}
		const total = safeInt(u.total_balance) || (Array.isArray(u.items) ? u.items.reduce((s, x) => s + safeInt(x.balance), 0) : 0)
		const monthlyAvg = Math.round(total / 6)
		this.data.credit_debt.monthly_burden_diagnostic = {
			monthly_due_average: monthlyAvg,
			status: DEBT_RATIO_DIAGNOSTIC_STATUS,
			decision_eligible: false,
			risk_rule_status: 'disabled'
		}
	}

	/** 睡眠信用卡：信用卡≥6张 且 使用率<10% */
	_checkDormantCards() {
		const cards = Array.isArray(this.data.credit_card_details) ? this.data.credit_card_details.filter(isActiveCardRow) : []
		const usage = parseFloat(safeFloat(this.data.credit_debt?.credit_cards?.usage_rate) || 0)
		if (cards.length >= 6 && usage < 0.1 && usage >= 0) {
			this.risk_hits.push({
				level: '提示',
				rule_name: 'DORMANT_CARD',
				title: '睡眠信用卡较多',
				detail: cards.length + '张卡但使用率仅' + (usage * 100).toFixed(1) + '%，建议注销闲置卡',
				severity: 1
			})
		}
	}

	_validateConsistency() {
		const ld = this.data.loan_details
		const bankRows = Array.isArray(ld.bank_loans) ? ld.bank_loans : []
		const nonBankRows = Array.isArray(ld.non_bank_loans) ? ld.non_bank_loans : []
		const unknownRows = Array.isArray(ld.unknown_loans) ? ld.unknown_loans : []
		const sumList = (arr) =>
			(Array.isArray(arr) ? arr : []).filter(isDebtBearingLoanRow).reduce(
				(acc, r) => {
					acc.bal += safeInt(r.balance)
					acc.lim += safeInt(r.credit_limit)
					return acc
				},
					{ bal: 0, lim: 0 }
				)
		const bank = sumList(bankRows)
		const non = sumList(nonBankRows)
		const unknown = sumList(unknownRows)
		const stB = ld.subtotal_bank
		const stN = ld.subtotal_non_bank
		const stU = ld.subtotal_unknown
		const coverageNotes = String(this.data._coverage?.notes || '')
		const sourceDetailAuthoritative = /原文贷款明细|按贷款明细复核|原文校准|source-text/.test(coverageNotes)
		const hasExcludedDebtRows = (rows) => rows.some((row) =>
			row && !isDebtBearingLoanRow(row) && safeInt(row.balance ?? row.remaining_balance ?? row.loan_balance) > 0
		)
		if (stB && Math.abs(safeInt(stB.balance) - bank.bal) > Math.max(500, bank.bal * 0.02)) {
			if (sourceDetailAuthoritative || hasExcludedDebtRows(bankRows)) {
				this.warnings.push(
					`银行类贷款余额小计(${safeInt(stB.balance)})与未结清明细求和(${bank.bal})不一致，已按当前有效余额纠正`
				)
				stB.balance = bank.bal
				stB.credit_limit = bank.lim
			} else {
				this.warnings.push(
					`银行类贷款余额小计(${safeInt(stB.balance)})与已列明细求和(${bank.bal})不一致，明细可能未列全，暂保留汇总`
				)
			}
		}
		if (stN && Math.abs(safeInt(stN.balance) - non.bal) > Math.max(500, non.bal * 0.02)) {
			if (sourceDetailAuthoritative || hasExcludedDebtRows(nonBankRows)) {
				this.warnings.push(
					`非银类贷款余额小计(${safeInt(stN.balance)})与未结清明细求和(${non.bal})不一致，已按当前有效余额纠正`
				)
				stN.balance = non.bal
				stN.credit_limit = non.lim
			} else {
				this.warnings.push(
					`非银类贷款余额小计(${safeInt(stN.balance)})与已列明细求和(${non.bal})不一致，明细可能未列全，暂保留汇总`
				)
			}
		}
		const cards = Array.isArray(this.data.credit_card_details)
			? this.data.credit_card_details.filter((row) => isActiveCardRow(row) && !isNotActivatedCardStatus(row?.status))
			: []
		const debtCards = this.isEvidenceV2 ? cards.filter(isExplicitCnyCardRow) : cards
		const detailCardUsed = debtCards.reduce((s, c) => s + safeInt(c.used_limit), 0)
		const summaryCardUsed = safeInt(this.data.credit_debt?.credit_cards?.total_used)
		const cardUsed = summaryCardUsed > 0 ? summaryCardUsed : detailCardUsed
		const loanBal = safeInt(stB?.balance) + safeInt(stN?.balance) + safeInt(stU?.balance)
		if (loanBal === 0) {
			const fb = bank.bal + non.bal + unknown.bal
			if (fb > 0) this.warnings.push('贷款小计缺失，负债校验已改用明细余额求和')
		}
		const computedLoanTotal = stB && stN && stU
			? safeInt(stB.balance) + safeInt(stN.balance) + safeInt(stU.balance)
			: bank.bal + non.bal + unknown.bal
		const computedTotal = computedLoanTotal + cardUsed
		const declared = safeInt(this.data.credit_debt.total_debt)
		const diff = Math.abs(declared - computedTotal)
		if (computedTotal > 0 && diff > 1) {
			if (declared <= 0 || diff > Math.max(2000, declared * 0.03)) {
				this.warnings.push(
					`总负债(${declared})与「贷款余额+信用卡已用」(${computedTotal})差异较大，已按明细汇总纠正`
				)
			}
			this.data.credit_debt.total_debt = computedTotal
			const totalLine =
				safeInt(this.data.loan_details?.total?.credit_limit) +
				safeInt(this.data.credit_debt?.credit_cards?.total_limit)
			if (totalLine > 0) {
				this.data.credit_debt.debt_ratio = roundRate(computedTotal / totalLine)
			}
			const debtSummary = ensureDeep(this.data, ['debt_summary'], () => ({}))
			debtSummary.total_debt = computedTotal
			debtSummary.loan_balance = computedTotal - cardUsed
			debtSummary.used_credit = cardUsed
			if (totalLine > 0) {
				debtSummary.total_credit_line = totalLine
				debtSummary.debt_ratio_pct = Math.round((computedTotal / totalLine) * 10000) / 100
			}
		}
		const creditLoans = ensureDeep(this.data, ['credit_debt', 'credit_loans'], () => ({}))
		creditLoans.bank_amount = safeInt(stB?.balance)
		creditLoans.non_bank_amount = safeInt(stN?.balance)
		creditLoans.unknown_amount = safeInt(stU?.balance)
		creditLoans.total_amount = creditLoans.bank_amount + creditLoans.non_bank_amount + creditLoans.unknown_amount
		const currentLoans = currentLoanRows(this.data)
		creditLoans.bank_count = currentLoans.activeBankLoans.length
		creditLoans.non_bank_count = currentLoans.activeNonBankLoans.length
		creditLoans.unknown_count = currentLoans.activeUnknownLoans.length
		creditLoans.total_count = creditLoans.bank_count + creditLoans.non_bank_count + creditLoans.unknown_count
		ld.total = ld.total && typeof ld.total === 'object' ? ld.total : {}
		ld.total.balance = creditLoans.total_amount
		ld.total.count = creditLoans.total_count
		ld.total.credit_limit = safeInt(stB?.credit_limit) + safeInt(stN?.credit_limit) + safeInt(stU?.credit_limit)
	}
}

/**
 * 风险命中按等级聚合：用于前端顶部「高 X · 中 Y · 提示 Z」条。
 * 同时返回最大 severity，便于决定卡片配色基调。
 */
function summarizeRiskHits(hits) {
	const out = { high: 0, warn: 0, info: 0, total: 0, max_severity: 0, top: [] }
	if (!Array.isArray(hits)) return out
	const sorted = [...hits].sort((a, b) => safeInt(b.severity, 0) - safeInt(a.severity, 0))
	for (const h of sorted) {
		if (!h) continue
		out.total += 1
		const sev = safeInt(h.severity, LEVEL_SEVERITY[h.level] || 1)
		if (sev >= 4) out.high += 1
		else if (sev >= 3) out.warn += 1
		else out.info += 1
		if (sev > out.max_severity) out.max_severity = sev
	}
	out.top = sorted.slice(0, 3).map((h) => ({
		level: h.level || '提示',
		title: h.title || '—',
		rule_name: h.rule_name || ''
	}))
	return out
}

function assembleFrontendPayload(data) {
	const formatWan = (yuan) => {
		const n = safeInt(yuan)
		if (!n) return '0'
		return (n / 10000).toFixed(2) + '万'
	}
	const pct = (r) => {
		const x = safeFloat(r, 0)
		return `${(x * 100).toFixed(2)}%`
	}
	const sum = data.query_analysis?.summary || {}
	const last6 = sum.last_6m || {}
	const hits = data.risk_analysis?.risk_hits || []
	return {
		header: {
			name: data.basic_info?.name || '',
			report_date: data.meta?.report_date || data.basic_info?.report_date || '',
			risk_level: data.assessment?.risk_level || data.risk_analysis?.overall_level || '',
			score: safeInt(data.assessment?.score, 0)
		},
		risk_summary: summarizeRiskHits(hits),
		risk_cards: hits,
		charts: {
			debt_structure: data.credit_debt?.credit_loans?.chart_data || [],
			other_debt: data.other_debts?.chart_data || [],
			cc_usage: data.credit_debt?.credit_cards?.chart_data || [],
			loan_trend: data.loan_history?.trend_data || [],
			query_trend: data.query_analysis?.monthly_trend || [],
			radar: data.assessment?.radar || null
		},
		tables: {
			upcoming: data.credit_debt?.upcoming_6m?.items || [],
			loan_bank: data.loan_details?.bank_loans || [],
			loan_nonbank: data.loan_details?.non_bank_loans || [],
			loan_unknown: data.loan_details?.unknown_loans || [],
			credit_cards: data.credit_card_details || [],
			query_details: data.query_analysis?.query_details || [],
			overdue: normalizeOverdueTableRows(data.overdue_info?.details),
			score_breakdown: data.assessment?.score_breakdown || [],
			peer_comparison: Array.isArray(data.peer_comparison) ? data.peer_comparison : [],
			improvement_plan: data.assessment?.improvement_plan || []
		},
			summary: {
				total_debt: formatWan(data.credit_debt?.total_debt),
				debt_ratio: '待核对',
				credit_line_utilization: {
					label: '授信占用率',
					ratio: safeFloat(data.credit_debt?.debt_ratio),
					unit: 'ratio',
					status: DEBT_RATIO_DIAGNOSTIC_STATUS,
					decision_eligible: false
				},
				cc_usage: pct(data.credit_debt?.credit_cards?.usage_rate),
				query_6m: safeInt(last6.total)
			},
			report_interpretation: data.report_interpretation || null,
			assessment: data.assessment || {},
			data_completeness: data.data_completeness || null
		}
	}

/**
 * @param {object} aiJson
 * @returns {object} 规则处理后的完整 JSON（含 frontend_payload、rule_engine_warnings）
 */
function runCreditRuleEngine(aiJson) {
	const engine = new CreditRuleEngine(aiJson)
	const out = engine.runAll()
	out.primary_rule_score = calculatePrimaryRuleScore(out)
	const unifiedScore = safeInt(out.primary_rule_score && out.primary_rule_score.score)
	const deterministic = out.derivation_meta?.mode === 'deterministic-v1'
	if (deterministic) {
		const hits = Array.isArray(out.risk_analysis?.risk_hits) ? out.risk_analysis.risk_hits : []
		const riskSummary = summarizeRiskHits(hits)
		const riskLevel =
			riskSummary.high > 0 || unifiedScore < 50
				? 'high'
				: riskSummary.warn > 0 || unifiedScore < 75
					? 'medium'
					: 'low'
		const actionableHits = hits.filter((hit) => hit && hit.rule_name !== 'HEALTHY_NO_RISK')
		const pros = []
		if (!out.overdue_info?.has_overdue && safeInt(out.overdue_info?.total_overdue_accounts) <= 0) {
			pros.push('当前事实未显示逾期账户')
		}
		if (safeFloat(out.credit_debt?.credit_cards?.usage_rate) <= 0.5) {
			pros.push('信用卡整体使用率不高于50%')
		}
		if (safeInt(out.query_analysis?.summary?.last_6m?.total) <= 3) {
			pros.push('近6个月机构查询次数不高于3次')
		}
		const improvementPlan = Array.isArray(out.assessment?.improvement_plan)
			? out.assessment.improvement_plan
			: []
		const suggestion = improvementPlan.length
			? improvementPlan.slice(0, 3).map((item) => item.action).filter(Boolean).join('；')
			: '保持按时还款，并以报告日为基准定期复核账户、查询和负债变化。'

		out.risk_analysis.overall_level = riskLevel
		out.risk_analysis.data_rating = out.data_completeness?.grade || null
		out.risk_level = riskLevel
		out.risk_tags = actionableHits.map((hit) => hit.title).filter(Boolean)
		out.suggestion = suggestion
		out.assessment = out.assessment || {}
		out.assessment.risk_level = riskLevel
		out.assessment.pros = pros
		out.assessment.cons = actionableHits.slice(0, 6).map((hit) => hit.title).filter(Boolean)
		out.assessment.suggestion = suggestion
		out.score_basis = {
			version: out.derivation_meta?.evidence_mode === 'evidence-v2'
				? 'primary-rule-v3'
				: 'primary-rule-v2',
			base_score: out.primary_rule_score.baseScore,
			total_deduction: out.primary_rule_score.totalDeduction,
			deductions: out.primary_rule_score.deductions
		}
		out.derivation_meta.rules_version = out.derivation_meta?.evidence_mode === 'evidence-v2'
			? 'credit-rules-deterministic-v3'
			: 'credit-deterministic-v1'
		out.derivation_meta.model_role = 'raw-facts-only'
	}
	if (out.assessment && typeof out.assessment === 'object') {
		out.assessment.primary_rule_score = out.primary_rule_score
		out.assessment.score = unifiedScore
	}
	if (deterministic) {
		out.frontend_payload = assembleFrontendPayload(out)
	}
	if (out.frontend_payload && typeof out.frontend_payload === 'object') {
		out.frontend_payload.primary_rule_score = out.primary_rule_score
		if (out.frontend_payload.header && typeof out.frontend_payload.header === 'object') {
			out.frontend_payload.header.score = unifiedScore
		}
		if (out.frontend_payload.assessment && typeof out.frontend_payload.assessment === 'object') {
			out.frontend_payload.assessment.primary_rule_score = out.primary_rule_score
			out.frontend_payload.assessment.score = unifiedScore
		}
	}
	// data_completeness 的「综合评估」明细在 _buildDataCompleteness 阶段读取的是
	// 模型原始 assessment.score（可能为 350-950 量纲），此处统一回写为 0-100 主分，
	// 避免覆盖清单出现「评分 350」这类超出满分 100 的量纲混淆。
	const patchAssessmentDetail = (dc) => {
		if (!dc || !Array.isArray(dc.modules)) return
		for (const m of dc.modules) {
			if (m && m.key === 'assessment') {
				m.detail = unifiedScore > 0 ? `综合分 ${unifiedScore}（满分100）` : (m.present ? '已生成评估' : '评分缺失')
			}
		}
	}
	patchAssessmentDetail(out.data_completeness)
	patchAssessmentDetail(out.frontend_payload && out.frontend_payload.data_completeness)
	return out
}

module.exports = {
	CreditRuleEngine,
	assembleFrontendPayload,
	summarizeRiskHits,
	runCreditRuleEngine,
	normalizeOverdueTableRows,
	clampScore,
	applyOverdueTotalCap,
	peerRow,
	RULE_ACTION_TEMPLATES,
	FOUR_DIM_WEIGHTS,
	SIX_DIM_LABEL,
	LEVEL_SEVERITY,
	COLORS,
	calculatePrimaryRuleScore
}
