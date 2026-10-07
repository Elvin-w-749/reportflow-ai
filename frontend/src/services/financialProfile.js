/**
 * 综合资质画像：征信 + 三金（社保公积金）+ 收入结构 + 可选资产
 * 用于调整展示分、偿债能力代理指标、产品/顾问匹配的加权因子。
 *
 * 说明：金融机构最终以审批为准；本模块为平台侧初筛与排序逻辑。
 * 仅上传征信时：使用 defaultFinancialSupplement() 占位，不强制用户填写本模块字段。
 */

import { resolveV6TotalFromAnalysis } from './scoreV6.js'

const MONTHLY_RANGE_MID = {
	under5k: 4000,
	'5k_10k': 7500,
	'10k_20k': 15000,
	'20k_50k': 35000,
	above50k: 65000
}

/**
 * @typedef {Object} FinancialSupplement
 * @property {{ status: string, months?: number, housingFund: string }} socialSecurity
 * @property {{ primarySource: string, monthlyRangeKey: string }} income
 * @property {{ hasProperty?: boolean, hasVehicle?: boolean, hasLiquid?: boolean }} [assets]
 */

export const defaultFinancialSupplement = () => ({
	socialSecurity: {
		status: 'unknown',
		months: 0,
		housingFund: 'unknown'
	},
	income: {
		primarySource: 'salary',
		monthlyRangeKey: '5k_10k'
	},
	assets: {
		hasProperty: false,
		hasVehicle: false,
		hasLiquid: false
	}
})

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))

/**
 * 校验必填项（三金状态、收入区间、收入来源）
 */
export const validateFinancialSupplement = (s) => {
	if (!s?.socialSecurity?.status || s.socialSecurity.status === 'unknown') {
		return { ok: false, msg: '请选择社保/公积金缴纳情况' }
	}
	if (!s?.income?.primarySource) {
		return { ok: false, msg: '请选择主要收入来源' }
	}
	if (!s?.income?.monthlyRangeKey) {
		return { ok: false, msg: '请选择月收入区间' }
	}
	return { ok: true, msg: '' }
}

const socialStabilityScore = (social) => {
	let v = 50
	const st = social?.status
	if (st === 'continuous') v += 35
	else if (st === 'recent_gap') v += 12
	else if (st === 'none') v -= 25

	const months = Number(social?.months) || 0
	if (st === 'continuous' && months >= 24) v += 10
	else if (st === 'continuous' && months >= 12) v += 5

	const hf = social?.housingFund
	if (hf === 'yes_high') v += 12
	else if (hf === 'yes_normal') v += 6
	else if (hf === 'no') v -= 5

	return clamp(v, 0, 100)
}

const incomeTierScore = (income) => {
	const mid = MONTHLY_RANGE_MID[income?.monthlyRangeKey] || 7500
	let v = 40
	if (mid >= 60000) v = 95
	else if (mid >= 35000) v = 85
	else if (mid >= 15000) v = 72
	else if (mid >= 7500) v = 58
	else v = 42

	const src = income?.primarySource
	if (src === 'salary') v += 5
	if (src === 'business') v += 0
	if (src === 'mixed') v += 3
	if (src === 'other') v -= 3

	return clamp(v, 0, 100)
}

const assetStrength = (assets) => {
	const a = assets || {}
	let pts = 0
	if (a.hasProperty) pts += 12
	if (a.hasVehicle) pts += 6
	if (a.hasLiquid) pts += 8
	return clamp(pts, 0, 26)
}

/**
 * 估算月还款/收入（若征信维度里存在月均还款）
 */
const estimateDtiRatio = (analysisData, incomeMid) => {
	const dims = analysisData?.dimensions || {}
	const monthlyPay =
		(typeof dims.monthlyPaymentTotal === 'number' && dims.monthlyPaymentTotal > 0)
			? dims.monthlyPaymentTotal
			: (typeof dims.monthlyPayment === 'number' && dims.monthlyPayment > 0)
				? dims.monthlyPayment
				: (typeof dims.avgMonthlyPayment === 'number' ? dims.avgMonthlyPayment : null)
	if (!monthlyPay || !incomeMid || incomeMid <= 0) return null
	return clamp(monthlyPay / incomeMid, 0, 3)
}

/**
 * 生成综合元数据（不写回征信原始分，单独存 adjustedTotalScore 供匹配使用）
 */
export const buildCompositeMeta = (analysisData, supplement) => {
	const sup = supplement || defaultFinancialSupplement()
	const stability = socialStabilityScore(sup.socialSecurity)
	const incomeTier = incomeTierScore(sup.income)
	const assetPts = assetStrength(sup.assets)
	const incomeMid = MONTHLY_RANGE_MID[sup.income?.monthlyRangeKey] || 7500
	const dti = estimateDtiRatio(analysisData, incomeMid)

	let matchBoost = 0
	matchBoost += Math.round((stability - 50) * 0.12)
	matchBoost += Math.round((incomeTier - 50) * 0.10)
	matchBoost += Math.round(assetPts * 0.35)

	if (dti != null) {
		if (dti <= 0.35) matchBoost += 8
		else if (dti <= 0.5) matchBoost += 3
		else if (dti > 0.7) matchBoost -= 12
		else if (dti > 0.55) matchBoost -= 5
	}

	matchBoost = clamp(Math.round(matchBoost), -18, 22)

	// 区分「真实分（含合法 0 分高风险）」与「无分数（全部解析不出）」：
	// 旧逻辑用 baseScore > 0 判定，会把合法 0 分误当作无分数而丢弃调整。
	const resolvedBase = resolveV6TotalFromAnalysis(analysisData)
	const hasBaseScore = typeof resolvedBase === 'number' && Number.isFinite(resolvedBase)
	const baseScore = hasBaseScore ? resolvedBase : 0
	const adjustedTotalScore = hasBaseScore ? clamp(Math.round(baseScore + matchBoost * 0.65), 0, 100) : 0

	const tags = []
	if (stability >= 75) tags.push('缴存稳定')
	if (incomeTier >= 80) tags.push('收入充裕')
	if (assetPts >= 12) tags.push('有资产背书')
	if (sup.income?.primarySource === 'business') tags.push('经营收入')
	if (dti != null && dti <= 0.4) tags.push('现金流压力可控')
	if (stability < 40) tags.push('缴存待核实')

	return {
		stabilityScore: stability,
		incomeTierScore: incomeTier,
		assetStrengthPoints: assetPts,
		incomeMidpoint: incomeMid,
		dtiEstimate: dti,
		matchBoost,
		adjustedTotalScore,
		hasBaseScore,
		tags,
		compositeConfidenceBonus: (stability >= 60 && incomeTier >= 50 ? 8 : 0) + (assetPts >= 6 ? 4 : 0)
	}
}

/**
 * 将用户填写的资质合并进分析结果（本地存储与上传云函数共用）
 */
export const enrichAnalysisWithFinancialProfile = (analysisData, supplement) => {
	if (!analysisData) return analysisData
	const sup = { ...defaultFinancialSupplement(), ...supplement, socialSecurity: { ...defaultFinancialSupplement().socialSecurity, ...supplement?.socialSecurity }, income: { ...defaultFinancialSupplement().income, ...supplement?.income }, assets: { ...defaultFinancialSupplement().assets, ...supplement?.assets } }

	const compositeMeta = buildCompositeMeta(analysisData, sup)
	const report = { ...(analysisData.report || {}) }

	if (compositeMeta.hasBaseScore) {
		report.adjustedTotalScore = compositeMeta.adjustedTotalScore
		report.compositeMatchBoost = compositeMeta.matchBoost
	}

	const scores = { ...(report.scores || {}) }
	const bump = Math.round(compositeMeta.matchBoost * 0.4)
	if (compositeMeta.hasBaseScore && bump !== 0) {
		const add = (k, zh) => {
			const cur = scores[k] ?? scores[zh]
			if (typeof cur === 'number') {
				const next = clamp(Math.round(cur + bump), 0, 100)
				scores[k] = next
				scores[zh] = next
			}
		}
		add('repayment_record', '还款记录')
		add('credit_history', '信用历史')
		add('account_structure', '账户结构')
		add('query_frequency', '查询频率')
	}
	report.scores = scores

	return {
		...analysisData,
		report,
		financialSupplement: sup,
		compositeMeta
	}
}

export default {
	defaultFinancialSupplement,
	validateFinancialSupplement,
	buildCompositeMeta,
	enrichAnalysisWithFinancialProfile
}
