/**
 * 综合评分 · 逾期专项规则（独立 / 最高优先级）
 *
 * 业务口径（产品定义）：
 *   · 默认基准分 70 分
 *   · 按「逾期发生时间窗口（recency）」分层，互斥取档：
 *       0–6 个月（半年内）：
 *         - 逾期一个月（M1）        → 减 50
 *         - 逾期大于一个月（M2/M3+）→ 减 70
 *       6–12 个月（一年内）：
 *         - 逾期一个月（M1）              → 减 10
 *         - 逾期两个月（M2）              → 减 20
 *         - 逾期半年以上（M3+ 且 >180天）→ 减 70
 *         - M3+ 但未满半年（90–180天）   → 减 40（介于两个月与半年以上之间的插值）
 *       12 个月以上（历史逾期）：仍按等级轻量扣分（M1 -3 / M2 -5 / M3+ -8）
 *   · 多笔逾期累加扣分，最终分数下限 0、上限 100。
 *   · 逾期「时长档」由已有 M1/M2/M3+ 等级映射（M1=一个月，M2=两个月，M3+ 再按天数判半年以上）。
 *
 * 数据缺失约定：
 *   · 单笔逾期缺少可解析日期时，按「6–12 个月（一年内）」中档处理（不就高也不就低）。
 *   · 无逐笔记录、仅有维度聚合（m1/m2/m3 计数）时，整体按「一年内」档复算，
 *     M3+ 的半年以上判定使用 maxOverdueDays 作为代理。
 *
 * 该分数为「最高优先级」：只要存在逾期信号即作为页头综合分的权威值，
 * 覆盖原四维加权 / 主评分框架结果（见 scoreV6.resolveV6TotalFromAnalysis 与 detail.uvue）。
 */

import { getLiveTimeAnchor, parseYmdAsBeijing } from '../utils/beijingTime.js'

export const OVERDUE_BASE_SCORE = 70

const DAY_MS = 24 * 60 * 60 * 1000

/** 解析逾期记录上的日期串 → Date（失败返回 null） */
function parseOverdueDate(raw) {
	if (!raw) return null
	const beijing = parseYmdAsBeijing(raw)
	if (beijing) return beijing
	const s = String(raw).trim().replace(/[年月]/g, '-').replace(/日/g, '')
	const m = s.match(/(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/)
	if (m) {
		const y = Number(m[1])
		const mo = Number(m[2]) - 1
		const d = m[3] ? Number(m[3]) : 1
		const dt = new Date(y, mo, d, 12, 0, 0)
		return Number.isNaN(dt.getTime()) ? null : dt
	}
	const t = Date.parse(s)
	return Number.isNaN(t) ? null : new Date(t)
}

/** 距锚点的月数（约值，30.44 天/月）；无法解析返回 null */
function monthsAgo(dateRaw, anchor) {
	const d = parseOverdueDate(dateRaw)
	if (!d) return null
	const diff = anchor.getTime() - d.getTime()
	if (!Number.isFinite(diff)) return null
	return diff / (30.44 * DAY_MS)
}

/** 归一化逾期等级：M1 / M2 / M3+ */
function normalizeLevel(rec) {
	const lv = String((rec && (rec.level || rec.overdueLevel)) || '').toUpperCase()
	if (lv === 'M1') return 'M1'
	if (lv === 'M2') return 'M2'
	if (lv === 'M3+' || lv === 'M3' || lv === 'M4' || lv === 'M5' || lv === 'M6' || lv === 'M7') return 'M3+'
	// 无等级时按天数兜底
	const days = Number((rec && (rec.days || rec.overdueDays)) || 0)
	if (days <= 0) return 'none'
	if (days <= 30) return 'M1'
	if (days <= 60) return 'M2'
	return 'M3+'
}

function normalizeRecordAliases(rec) {
	if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return {}
	return {
		...rec,
		level: rec.level ?? rec.overdueLevel ?? rec.overdue_level,
		days: rec.days ?? rec.overdueDays ?? rec.overdue_days,
		date: rec.date ?? rec.overdueDate ?? rec.overdue_date,
		bank: rec.bank ?? rec.institution ?? rec.organization,
		accountType: rec.accountType ?? rec.account_type ?? rec.type,
		current: rec.current === true || rec.isCurrent === true || rec.current_overdue === true
	}
}

/** 时间窗口分档：'within6m' | 'within12m' | 'older'（缺日期/非法 → within12m 中档） */
function recencyBucket(monthsValue) {
	// null/非有限值/负值（未来日期解析所得）→ 视为日期不可信，归中档 within12m，
	// 避免把脏日期误判进最重的 within6m 档而虚高扣分。
	if (monthsValue == null || !Number.isFinite(monthsValue) || monthsValue < 0) return 'within12m'
	if (monthsValue <= 6) return 'within6m'
	if (monthsValue <= 12) return 'within12m'
	return 'older'
}

/** 从服务端 overdue_info 聚合块提取严重度信号（用于回填逐笔缺失的 level/days/recency） */
function severityFromOverdueInfo(ov) {
	if (!ov || typeof ov !== 'object') return null
	const overdue90 = Number(ov.overdue_90_days ?? ov.overdue90 ?? ov.over90_count) || 0
	const months = Number(ov.total_overdue_months ?? ov.totalOverdueMonths ?? ov.overdue_months) || 0
	const maxDays = Number(ov.max_overdue_days ?? ov.maxOverdueDays) || 0
	const currentCount = Math.max(
		Number(ov.current_overdue_count ?? ov.currentOverdueCount) || 0,
		ov.has_overdue === true || ov.current_overdue === true ? 1 : 0
	)
	const hasCurrent =
		ov.has_overdue === true ||
		ov.current_overdue === true ||
		currentCount > 0
	if (overdue90 === 0 && months === 0 && maxDays === 0 && !hasCurrent) return null
	return { overdue90, months, maxDays, hasCurrent, currentCount }
}

/**
 * 用聚合严重度回填「弱记录」：服务端 overdue_info.details 常只给 amount/date，
 * 逐笔缺 level/days 时会被误判为轻微 M1。此处依据 90 天以上逾期 / 累计逾期月数
 * 还原单笔严重度；当前仍逾期但逐笔无日期时标记 current（归入半年内最重档）。
 */
function upgradeRecordSeverity(rec, sev) {
	if (!sev) return rec
	const r = { ...rec }
	const days = Number(r.days ?? r.overdueDays) || 0
	const level = String(r.level || r.overdueLevel || '').toUpperCase()
	const weak = (days <= 30) && (level === '' || level === 'M1')
	if (weak && (sev.overdue90 > 0 || sev.maxDays > 90)) {
		// ≥半年累计逾期 → 判「半年以上」(>180天)；否则至少 M3+（90 天以上）
		const proxyDays = sev.months >= 6 ? Math.max(181, sev.months * 30) : Math.max(91, sev.maxDays)
		r.days = Math.max(days, proxyDays)
		r.level = 'M3+'
	}
	const rawDate = r.date && r.date !== '-' ? r.date : ''
	if (sev.hasCurrent && !rawDate) r.current = true
	return r
}

function upgradeRecordsSeverity(records, sev) {
	const normalized = records.map(normalizeRecordAliases)
	if (!sev) return normalized
	let severeBudget = Math.max(
		0,
		Math.round(sev.overdue90 || 0),
		sev.maxDays > 90 || sev.months >= 3 ? 1 : 0
	)
	let currentBudget = Math.max(0, Math.round(sev.currentCount || (sev.hasCurrent ? 1 : 0)))
	return normalized.map((record) => {
		const days = Number(record.days ?? record.overdueDays) || 0
		const level = String(record.level || record.overdueLevel || '').toUpperCase()
		const weak = days <= 30 && (level === '' || level === 'M1')
		const shouldUpgrade = weak && severeBudget > 0
		const hasDate = !!(record.date && record.date !== '-')
		const shouldMarkCurrent = !hasDate && currentBudget > 0
		if (shouldUpgrade) severeBudget -= 1
		if (shouldMarkCurrent) currentBudget -= 1
		if (!shouldUpgrade && !shouldMarkCurrent) return record
		return upgradeRecordSeverity(record, {
			overdue90: shouldUpgrade ? Math.max(1, sev.overdue90 || 0) : 0,
			months: shouldUpgrade ? sev.months : 0,
			maxDays: shouldUpgrade ? sev.maxDays : 0,
			hasCurrent: shouldMarkCurrent
		})
	})
}

function summaryDimensions(analysisData) {
	const sources = [
		analysisData.report && analysisData.report.overdueSummary,
		analysisData.report && analysisData.report.overdue_summary,
		analysisData.aiInsight && analysisData.aiInsight.overdue_summary,
		analysisData.kimiInsight && analysisData.kimiInsight.overdue_summary,
		analysisData.frontendPayload && analysisData.frontendPayload.overdue_summary,
		analysisData.frontend_payload && analysisData.frontend_payload.overdue_summary,
		analysisData.overdue_info,
		analysisData.creditReportV2 && analysisData.creditReportV2.overdue_info,
		analysisData.credit_report_full && analysisData.credit_report_full.overdue_info,
		analysisData.credit_report_v2 && analysisData.credit_report_v2.overdue_info
	].filter((item) => item && typeof item === 'object' && !Array.isArray(item))
	const maxOf = (...keys) => sources.reduce((max, source) => {
		for (const key of keys) {
			const value = Number(source[key])
			if (Number.isFinite(value) && value >= 0) max = Math.max(max, value)
		}
		return max
	}, 0)
	const maxOverdueDays = maxOf('max_overdue_days', 'maxOverdueDays')
	const m1Count = maxOf('m1_count', 'm1Count')
	const m2Count = maxOf('m2_count', 'm2Count')
	const m3Count = Math.max(maxOf('m3_count', 'm3Count'), maxOf('overdue_90_days', 'overdue90'))
	let overdueCount = maxOf(
		'total_overdue_count', 'current_overdue_count', 'overdueCount',
		'total_overdue_accounts', 'currentOverdueCount'
	)
	if (overdueCount <= 0 && (m1Count + m2Count + m3Count > 0 || maxOverdueDays > 0)) overdueCount = Math.max(1, m1Count + m2Count + m3Count)
	return overdueCount > 0
		? { overdueCount, m1Count, m2Count, m3Count, maxOverdueDays }
		: null
}

/**
 * 单笔逾期的扣分（业务矩阵）
 * @param {'within6m'|'within12m'|'older'} bucket
 * @param {'M1'|'M2'|'M3+'} level
 * @param {number} days
 */
function deductionFor(bucket, level, days) {
	if (level === 'none') return 0
	if (bucket === 'within6m') {
		// 半年内：一个月 -50，大于一个月（M2/M3+）-70
		return level === 'M1' ? 50 : 70
	}
	if (bucket === 'within12m') {
		// 一年内：一个月 -10，两个月 -20，半年以上 -70，M3+ 未满半年 -40
		if (level === 'M1') return 10
		if (level === 'M2') return 20
		return days > 180 ? 70 : 40
	}
	// 12 个月以上：轻量扣分
	if (level === 'M1') return 3
	if (level === 'M2') return 5
	return 8
}

function clampScore(n) {
	return Math.max(0, Math.min(100, Math.round(n)))
}

/**
 * 由逐笔逾期记录计算综合评分。
 * @param {Array<{level?:string, days?:number, date?:string, bank?:string, accountType?:string}>} records
 * @param {Date} [anchorDate] 时间锚点；省略时取联网北京时间
 * @returns {{ base:number, score:number, totalDeduction:number, deductions:Array }|null}
 */
export function overdueScoreFromRecords(records, anchorDate) {
	if (!Array.isArray(records) || records.length === 0) return null
	const anchor = anchorDate instanceof Date ? anchorDate : getLiveTimeAnchor()
	let score = OVERDUE_BASE_SCORE
	const deductions = []
	let effective = 0
	for (const rec of records) {
		const level = normalizeLevel(rec)
		if (level === 'none') continue
		const days = Number((rec && (rec.days || rec.overdueDays)) || 0)
		let bucket = recencyBucket(monthsAgo(rec && rec.date, anchor))
		// 当前仍逾期（current）→ 归入半年内最重档，覆盖「缺日期默认一年内」
		if (rec && rec.current === true && bucket !== 'within6m') bucket = 'within6m'
		const points = deductionFor(bucket, level, days)
		score -= points
		effective += 1
		deductions.push({
			bank: (rec && rec.bank) || '',
			accountType: (rec && rec.accountType) || '',
			level,
			days,
			bucket,
			points
		})
	}
	if (effective === 0) return null
	return {
		base: OVERDUE_BASE_SCORE,
		score: clampScore(score),
		totalDeduction: deductions.reduce((s, d) => s + d.points, 0),
		deductions
	}
}

/**
 * 仅有维度聚合（无逐笔记录）时的兜底复算：整体按「一年内」档，
 * M3+ 的半年以上判定用 maxOverdueDays 代理。recency 未知，故不进入半年内重档。
 * @param {object} dim dimensions（含 m1Count/m2Count/m3Count/maxOverdueDays/overdueCount）
 * @returns {{ base:number, score:number, totalDeduction:number, deductions:Array }|null}
 */
export function overdueScoreFromDimensions(dim) {
	if (!dim || typeof dim !== 'object') return null
	const m1 = Number(dim.m1Count) || 0
	const m2 = Number(dim.m2Count) || 0
	const m3 = Number(dim.m3Count) || 0
	const oc = Number(dim.overdueCount) || 0
	const maxDays = Number(dim.maxOverdueDays) || 0
	if (m1 + m2 + m3 === 0) {
		// 仅知道有逾期账户但无等级明细：按一年内「一个月」轻档逐笔扣分
		if (oc <= 0) return null
		const score = clampScore(OVERDUE_BASE_SCORE - oc * 10)
		return {
			base: OVERDUE_BASE_SCORE,
			score,
			totalDeduction: oc * 10,
			deductions: [{ level: 'M1', count: oc, bucket: 'within12m', points: 10 }]
		}
	}
	const m3Points = maxDays > 180 ? 70 : 40
	const totalDeduction = m1 * 10 + m2 * 20 + m3 * m3Points
	return {
		base: OVERDUE_BASE_SCORE,
		score: clampScore(OVERDUE_BASE_SCORE - totalDeduction),
		totalDeduction,
		deductions: [
			m1 > 0 ? { level: 'M1', count: m1, bucket: 'within12m', points: 10 } : null,
			m2 > 0 ? { level: 'M2', count: m2, bucket: 'within12m', points: 20 } : null,
			m3 > 0 ? { level: 'M3+', count: m3, bucket: 'within12m', points: m3Points } : null
		].filter((x) => x != null)
	}
}

/**
 * 从分析数据对象解析逾期综合评分（最高优先级口径）。
 * 优先逐笔记录（可识别 recency），否则回退维度聚合。无逾期信号返回 null。
 * @param {object} analysisData
 * @param {Date} [anchorDate]
 * @returns {{ base:number, score:number, totalDeduction:number, deductions:Array }|null}
 */
export function resolveOverdueScore(analysisData, anchorDate) {
	if (!analysisData || typeof analysisData !== 'object') return null

	// 聚合严重度信号（服务端 V2：overdue_info.{overdue_90_days,total_overdue_months,has_overdue}）
	const severitySignals = [
		analysisData.overdue_info,
		analysisData.creditReportV2 && analysisData.creditReportV2.overdue_info,
		analysisData.credit_report_full && analysisData.credit_report_full.overdue_info,
		analysisData.credit_report_v2 && analysisData.credit_report_v2.overdue_info,
		analysisData.aiInsight && analysisData.aiInsight.overdue_info,
		analysisData.kimiInsight && analysisData.kimiInsight.overdue_info,
		analysisData.frontendPayload && analysisData.frontendPayload.overdue_info,
		analysisData.frontend_payload && analysisData.frontend_payload.overdue_info,
		analysisData.report && analysisData.report.overdue_info
	].map(severityFromOverdueInfo).filter(Boolean)
	const sev = severitySignals.length ? severitySignals.reduce((acc, item) => ({
		overdue90: Math.max(acc.overdue90, item.overdue90),
		months: Math.max(acc.months, item.months),
		maxDays: Math.max(acc.maxDays, item.maxDays),
		hasCurrent: acc.hasCurrent || item.hasCurrent,
		currentCount: Math.max(acc.currentCount, item.currentCount || 0)
	}), { overdue90: 0, months: 0, maxDays: 0, hasCurrent: false, currentCount: 0 }) : null

	const recordCandidates = [
		analysisData.overdueRecords,
		analysisData.overdue_records,
		analysisData.report && analysisData.report.overdueRecords,
		analysisData.report && analysisData.report.overdue_records,
		analysisData.creditReportV2 && analysisData.creditReportV2.overdueRecords,
		analysisData.creditReportV2 && analysisData.creditReportV2.overdue_records,
		analysisData.creditReportV2 && analysisData.creditReportV2.overdue_info && analysisData.creditReportV2.overdue_info.records,
		analysisData.creditReportV2 && analysisData.creditReportV2.overdue_info && analysisData.creditReportV2.overdue_info.details,
		analysisData.credit_report_full && analysisData.credit_report_full.overdueRecords,
		analysisData.credit_report_full && analysisData.credit_report_full.overdue_records,
		analysisData.credit_report_full && analysisData.credit_report_full.overdue_info && analysisData.credit_report_full.overdue_info.records,
		analysisData.credit_report_full && analysisData.credit_report_full.overdue_info && analysisData.credit_report_full.overdue_info.details,
		analysisData.credit_report_v2 && analysisData.credit_report_v2.overdueRecords,
		analysisData.credit_report_v2 && analysisData.credit_report_v2.overdue_records,
		analysisData.credit_report_v2 && analysisData.credit_report_v2.overdue_info && analysisData.credit_report_v2.overdue_info.records,
		analysisData.credit_report_v2 && analysisData.credit_report_v2.overdue_info && analysisData.credit_report_v2.overdue_info.details,
		analysisData.frontendPayload && analysisData.frontendPayload.overdueRecords,
		analysisData.frontendPayload && analysisData.frontendPayload.overdue_records,
		analysisData.frontend_payload && analysisData.frontend_payload.overdueRecords,
		analysisData.frontend_payload && analysisData.frontend_payload.overdue_records,
		analysisData.aiInsight && analysisData.aiInsight.overdue_records,
		analysisData.kimiInsight && analysisData.kimiInsight.overdue_records
	]
	for (const candidate of recordCandidates) {
		if (!Array.isArray(candidate) || candidate.length === 0) continue
		const records = upgradeRecordsSeverity(candidate, sev)
		const fromRecords = overdueScoreFromRecords(records, anchorDate)
		// 非空占位数组（如 [{}] / [{ level: 'none' }]）不应遮住后续旧版真实记录。
		if (fromRecords) return fromRecords
	}
	// 旧版报告常保留空的顶层 dimensions 占位；不能让它遮住 report / 快照中的真实逾期。
	const candidates = [
		analysisData.dimensions,
		analysisData.dimensionSnapshot,
		analysisData.report && analysisData.report.dimensions,
		analysisData.report && analysisData.report.dimensionSnapshot,
		analysisData.credit_report_full && analysisData.credit_report_full.dimensions,
		analysisData.credit_report_full && analysisData.credit_report_full.dimensionSnapshot,
		analysisData.frontendPayload && analysisData.frontendPayload.dimensions,
		analysisData.frontendPayload && analysisData.frontendPayload.dimensionSnapshot,
		analysisData.frontend_payload && analysisData.frontend_payload.dimensions,
		analysisData.frontend_payload && analysisData.frontend_payload.dimensionSnapshot
	]
	for (const dim of candidates) {
		const scored = overdueScoreFromDimensions(dim)
		if (scored) return scored
	}
	const fromSummary = overdueScoreFromDimensions(summaryDimensions(analysisData))
	if (fromSummary) return fromSummary
	return null
}

export default {
	OVERDUE_BASE_SCORE,
	overdueScoreFromRecords,
	overdueScoreFromDimensions,
	resolveOverdueScore
}
