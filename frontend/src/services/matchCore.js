/**
 * 统一匹配核心（算法驱动）
 * 前端 matchEngine、服务端 matchProducts 共用同一套规则；修改时请同步
 */

import { resolveV6ScoreDetails } from './scoreV6.js'
import {
	resolveDecisionInstitutionCount,
	resolveDecisionNonBankLoanRatio,
	resolveDecisionOverdue,
	resolveDecisionQueryCounts,
	resolveEvidenceBackedDebtRatio
} from './decisionMetrics.js'
import { decisionReportIdOf, isOwnerApiEvidenceVerified, trustedDecisionValue } from './decisionTrust.js'

const safeNum = (v, def = 0) =>
	typeof v === 'number' && !isNaN(v) && isFinite(v) ? v : def

const objectValue = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {}

const boundedScore = (value) => {
	const number = Number(value)
	return Number.isFinite(number) && number >= 0 && number <= 100 ? Math.round(number) : null
}

/**
 * @param {object} payload - analysisData | { analysisResult, compositeMeta }
 */
export function normalizeAnalysisPayload(payload) {
	if (!payload || typeof payload !== 'object') return { root: {}, compositeMeta: null, decisionTrust: null, expectedReportId: '' }
	const root = payload.analysisResult || payload.analysisData || payload
	const compositeMeta = payload.compositeMeta || root.compositeMeta || null
	const decisionTrust = payload.analysisResult || payload.analysisData ? (payload.decisionTrust || null) : null
	const expectedReportId = payload.analysisResult || payload.analysisData ? decisionReportIdOf(payload) : ''
	return { root, compositeMeta, decisionTrust, expectedReportId }
}

/**
 * 构建统一匹配画像：四维 + 维度字段 + 算法 v2（负债/查询/机构）
 */
export function buildUnifiedMatchProfile(payload) {
	const { root, compositeMeta, decisionTrust, expectedReportId } = normalizeAnalysisPayload(payload)
	const report = root.report || {}
	const ki = root.aiInsight || root.kimiInsight || {}

	const scores = report.scores || root.scores || ki.six_dimensions || {}
	// v5：四维评分（移除 repaymentAbility / debtRatio）。
	// v7 无保底：?? 而非 ||，保留真实 0 分；缺失维度默认 0（不再垫 60/70）。
	// 字段名沿用 sixDims 是历史兼容，不再代表"六维"。
	const sixDims = {
		creditHistory: safeNum(scores.credit_history ?? scores['信用历史'], 0),
		queryFrequency: safeNum(scores.query_frequency ?? scores['查询频率'], 0),
		accountStructure: safeNum(scores.account_structure ?? scores['账户结构'], 0),
		repaymentRecord: safeNum(scores.repayment_record ?? scores['还款记录'], 0)
	}

	const scoreResolution = resolveV6ScoreDetails(root, decisionTrust, expectedReportId)
	const hasDecisionScore = scoreResolution.decisionEligible === true && typeof scoreResolution.score === 'number'
	const totalScore = hasDecisionScore ? Math.round(scoreResolution.score) : null
	const archivalBaseScore = !hasDecisionScore && typeof scoreResolution.score === 'number'
		? Math.round(scoreResolution.score)
		: null
	const adjustedCandidate = boundedScore(
		report.adjustedTotalScore ?? objectValue(compositeMeta).adjustedTotalScore
	)
	// adjustedScoreAttestation lives in the browser-controlled report body and
	// cannot establish provenance. Preserve the candidate for archival display,
	// but product decisions always use the reproducible base rule score.
	const hasDecisionAdjustedScore = false
	const adjustedTotalScore = null
	const effectiveScore = adjustedTotalScore ?? totalScore
	// Legacy four-dimensional UI values are not part of the verified decision
	// contract and therefore must not silently alter product-match scoring.
	const hasAuditableDimensions = false

	const overdueResolution = resolveDecisionOverdue(root, decisionTrust, expectedReportId)
	const {
		hasOverdue,
		hasLianSan,
		hasLeiLiu,
		hasDecisionOverdue,
		overdueKnown,
		hasLianSanKnown,
		hasLeiLiuKnown,
		archivalHasOverdue,
		archivalOverdueCount,
		archivalHasLianSan,
		archivalHasLeiLiu
	} = overdueResolution

	const debtRatioResolution = resolveEvidenceBackedDebtRatio(root, decisionTrust, expectedReportId)
	const hasDecisionDebtRatio = debtRatioResolution.decisionEligible === true
	const debtRatio = hasDecisionDebtRatio ? debtRatioResolution.value : null
	const debtRatioPct = hasDecisionDebtRatio
		? Math.round(debtRatio <= 1.5 ? debtRatio * 100 : debtRatio)
		: null

	const queryResolution = resolveDecisionQueryCounts(root, decisionTrust, expectedReportId)
	const { q1, q3, q6, q12, q1Known, q3Known, q6Known, q12Known } = queryResolution
	const hasDecisionQueryWindows = queryResolution.known === true
	const nonBankResolution = resolveDecisionNonBankLoanRatio(root, decisionTrust, expectedReportId)
	const hasDecisionNonBankLoanRatio = nonBankResolution.decisionEligible === true
	const nonBankLoanRatioKnown = hasDecisionNonBankLoanRatio
	const nonBankLoanRatio = hasDecisionNonBankLoanRatio ? nonBankResolution.value : null
	const institutionResolution = resolveDecisionInstitutionCount(root, decisionTrust, expectedReportId)
	const hasDecisionInstitutionCount = institutionResolution.decisionEligible === true
	const institutionCountKnown = hasDecisionInstitutionCount
	const institutionCount = hasDecisionInstitutionCount ? institutionResolution.value : null
	const integratedRiskScore = null
	// The browser receives only compact evidence metadata and cannot verify the
	// server HMAC ledger. Matching must obtain total debt server-side by reportId.
	const trustedTotalDebtRaw = trustedDecisionValue(decisionTrust, 'totalDebt', 'totalDebt', expectedReportId)
	const trustedTotalDebt = trustedTotalDebtRaw === null || trustedTotalDebtRaw === '' || typeof trustedTotalDebtRaw === 'boolean'
		? null
		: Number(trustedTotalDebtRaw)
	const hasDecisionTotalCreditDebt = trustedTotalDebt != null && Number.isFinite(trustedTotalDebt) && trustedTotalDebt >= 0
	const totalCreditDebt = hasDecisionTotalCreditDebt ? trustedTotalDebt : null

	const trustedRiskLevel = trustedDecisionValue(decisionTrust, 'riskLevel', 'riskLevel', expectedReportId)
	const riskLevel = typeof trustedRiskLevel === 'string' && trustedRiskLevel.trim()
		? trustedRiskLevel.trim()
		: 'unknown'
	const stabilityScore = null

	const overdueCount = overdueKnown ? overdueResolution.overdueCount : null

	return {
		sixDims,
		totalScore: effectiveScore,
		baseTotalScore: totalScore,
		archivalBaseScore,
		adjustedTotalScore,
		archivalAdjustedTotalScore: adjustedCandidate,
		hasDecisionAdjustedScore,
		hasDecisionScore,
		hasVerifiedEvidenceV2: isOwnerApiEvidenceVerified(decisionTrust, expectedReportId),
		evidenceDecisionReason: isOwnerApiEvidenceVerified(decisionTrust, expectedReportId) ? '' : 'SERVER_CANONICAL_LEDGER_REQUIRED',
		hasAuditableDimensions,
		supplementMaterialProfile: root.supplementMaterialProfile || report.supplementMaterialProfile || null,
		hasOverdue,
		hasLianSan,
		hasLeiLiu,
		overdueCount,
		hasDecisionOverdue,
		overdueKnown,
		hasLianSanKnown,
		hasLeiLiuKnown,
		archivalHasOverdue,
		archivalOverdueCount,
		archivalHasLianSan,
		archivalHasLeiLiu,
		debtRatio,
		debtRatioPct,
		hasDecisionDebtRatio,
		riskLevel,
		stabilityScore,
		compositeMeta,
		q1,
		q3,
		q6,
		q12,
		hasDecisionQueryWindows,
		q1Known,
		q3Known,
		q6Known,
		q12Known,
		nonBankLoanRatio,
		hasDecisionNonBankLoanRatio,
		nonBankLoanRatioKnown,
		institutionCount,
		hasDecisionInstitutionCount,
		institutionCountKnown,
		integratedRiskScore,
		totalCreditDebt,
		hasDecisionTotalCreditDebt,
		isHighRisk:
			hasLianSan || hasLeiLiu ||
			(hasDecisionDebtRatio && debtRatioPct > 80),
		isLowRisk: false
	}
}

/**
 * 单产品匹配率 0–100 + 原因
 * @param {object} product - 含 rules
 * @param {object} profile - buildUnifiedMatchProfile 结果
 */
export function computeProductMatchRate(product, profile) {
	const rules = product.rules || {}
	let score = 100
	const reasons = []
	const decisionBlocks = []
	const supplement = profile.supplementMaterialProfile || {}

	if (profile.hasDecisionOverdue === true && !rules.allowLianSan && (profile.hasLianSan || profile.hasLeiLiu)) {
		const reason = profile.hasLianSan && profile.hasLeiLiu
			? '存在连三累六，不符准入'
			: profile.hasLianSan
				? '存在连三（连续逾期3期+），不符准入'
				: '存在累六（累计逾期6次+），不符准入'
		return { matchRate: 5, matchReasons: [reason], isMatch: false }
	}
	if (!rules.allowLianSan && (profile.hasLianSanKnown !== true || profile.hasLeiLiuKnown !== true)) {
		addReason(decisionBlocks, '连三累六状态缺少可复核证据，待核对后匹配')
	}

	if (profile.hasDecisionOverdue === true && rules.allowOverdue === false && profile.hasOverdue) {
		return { matchRate: 5, matchReasons: ['存在逾期记录，不符准入'], isMatch: false }
	}
	if (rules.allowOverdue !== true && profile.overdueKnown !== true) {
		addReason(decisionBlocks, '逾期状态缺少可复核证据，待核对后匹配')
	}

	if (profile.hasDecisionOverdue === true && !rules.allowOverdue && profile.hasOverdue) {
		score -= 30
		reasons.push('存在逾期记录')
	}

	const minScore = safeNum(rules.minScore, 0)
	const eff = profile.totalScore
	if (minScore > 0 && profile.hasDecisionScore === true && typeof eff === 'number' && eff < minScore) {
		score -= Math.min(40, minScore - eff)
		reasons.push('综合评分低于产品门槛')
	} else if (minScore > 0 && profile.hasDecisionScore !== true) {
		addReason(decisionBlocks, '综合评分缺少可复算依据，待核对后匹配')
	}

	const maxDr = safeNum(rules.maxDebtRatio, 1)  // safeNum 兜底 NaN/Infinity，避免 typeof NaN === 'number' 穿透
	if (profile.hasDecisionDebtRatio === true && typeof profile.debtRatio === 'number' && profile.debtRatio > maxDr) {
		const excess = (profile.debtRatio - maxDr) * 100
		score -= Math.min(35, excess * 1.5)
		reasons.push('负债率偏高')
	} else if (rules.maxDebtRatio != null && profile.hasDecisionDebtRatio !== true) {
		addReason(decisionBlocks, '负债比例暂无正式证据化口径，待核对后匹配')
	}

	if (rules.maxQueryCount != null) {
		if (profile.hasDecisionQueryWindows === true && typeof profile.q3 === 'number' && profile.q3 > rules.maxQueryCount) {
			score -= Math.min(20, (profile.q3 - rules.maxQueryCount) * 3)
			reasons.push('近3个月信用查询偏多')
		} else if (profile.hasDecisionQueryWindows !== true) {
			addReason(decisionBlocks, '近3个月查询次数未知，待核对后匹配')
		}
	}

	if (rules.maxNonBankRatio != null) {
		if (profile.hasDecisionNonBankLoanRatio === true && typeof profile.nonBankLoanRatio === 'number' && profile.nonBankLoanRatio > rules.maxNonBankRatio) {
			score -= Math.min(18, (profile.nonBankLoanRatio - rules.maxNonBankRatio) * 40)
			reasons.push('非银贷款占比较高')
		} else if (profile.hasDecisionNonBankLoanRatio !== true) {
			addReason(decisionBlocks, '非银贷款占比未知，待核对后匹配')
		}
	}

	if (rules.maxInstitutions != null) {
		if (profile.hasDecisionInstitutionCount === true && typeof profile.institutionCount === 'number' && profile.institutionCount > rules.maxInstitutions) {
			score -= Math.min(15, (profile.institutionCount - rules.maxInstitutions) * 2)
			reasons.push('多头机构数偏多')
		} else if (profile.hasDecisionInstitutionCount !== true) {
			addReason(decisionBlocks, '借贷机构数未知，待核对后匹配')
		}
	}

	// 统一口径：总分优先主评分框架（规则扣分制）
	const sd = profile.sixDims
	const weightedScore =
		(sd.repaymentRecord * 0.33 +
			sd.creditHistory * 0.27 +
			sd.accountStructure * 0.24 +
			sd.queryFrequency * 0.16) /
		100

	if (profile.hasAuditableDimensions === true) {
		score = score * (0.85 + weightedScore * 0.15)
	}

	if (rules.preferHighDebt && profile.hasDecisionDebtRatio === true && profile.debtRatioPct > 60) {
		score = Math.min(100, score + 12)
	}
	if (rules.preferHighOverdue && profile.hasDecisionOverdue === true && profile.hasOverdue) {
		score = Math.min(100, score + 10)
	}
	if (rules.preferLowScore && profile.hasDecisionScore === true && profile.totalScore < 50) {
		score = Math.min(100, score + 8)
	}
	if (rules.preferLowDebt && profile.hasDecisionDebtRatio === true && profile.debtRatioPct < 40) {
		score = Math.min(100, score + 8)
	}
	if (rules.preferGoodHistory && profile.hasAuditableDimensions === true && sd.creditHistory > 75) {
		score = Math.min(100, score + 8)
	}

	if (typeof profile.integratedRiskScore === 'number') {
		if (profile.integratedRiskScore >= 72 && minScore >= 60 && !profile.hasLianSan) {
			score = Math.min(100, score + 5)
		}
		if (profile.integratedRiskScore < 52 && (rules.preferHighDebt || rules.preferLowScore)) {
			score = Math.min(100, score + 6)
		}
	}

	if (rules.preferIncomeEvidence && supplement.hasStableIncomeEvidence) {
		score = Math.min(100, score + 5)
	}
	if (rules.preferAssetEvidence && supplement.hasAssetEvidence) {
		score = Math.min(100, score + 5)
	}
	if (rules.requireIncomeEvidence && !supplement.hasStableIncomeEvidence) {
		score = Math.max(0, score - 12)
		reasons.push('稳定收入材料不足')
	}
	if (rules.requireAssetEvidence && !supplement.hasAssetEvidence) {
		score = Math.max(0, score - 12)
		reasons.push('资产材料不足')
	}
	if (rules.requireBusinessEvidence && !supplement.hasBusinessEvidence) {
		score = Math.max(0, score - 15)
		reasons.push('经营材料不足')
	}
	if (product.category === 'merchant_loan' && !supplement.hasBusinessEvidence) {
		score = Math.max(0, score - 10)
		addReason(reasons, '经营流水或商户材料待补充')
	}
	if ((product.category === 'credit_loan' || product.category === 'credit_card') && !supplement.hasStableIncomeEvidence && minScore >= 58) {
		score = Math.max(0, score - 6)
		addReason(reasons, '稳定收入材料待确认')
	}
	if (product.category === 'mortgage' && !supplement.hasAssetEvidence) {
		score = Math.max(0, score - 18)
		addReason(reasons, '房产或抵押类材料不足')
	}

	const stableMonths = safeNum(supplement.stableMonths, 0)
	const monthlyIncome = safeNum(supplement.monthlyIncome, 0)
	const socialMonths = safeNum(supplement.socialMonths, 0)
	const fundMonths = safeNum(supplement.fundMonths, 0)
	const socialBase = safeNum(supplement.socialBase, 0)
	const fundBase = safeNum(supplement.fundBase, 0)
	const educationScore = safeNum(supplement.educationScore, 0)
	const tax = supplement.taxAnalysis || {}
	if (stableMonths >= 12) score = Math.min(100, score + 4)
	else if (stableMonths > 0 && stableMonths < 6 && minScore >= 60) {
		score = Math.max(0, score - 5)
		addReason(reasons, '收入或缴存连续性不足6个月')
	}
	if (monthlyIncome >= 20000) score = Math.min(100, score + 4)
	else if (monthlyIncome > 0 && monthlyIncome < 5000 && minScore >= 58) {
		score = Math.max(0, score - 5)
		addReason(reasons, '收入水平偏低')
	}
	if (fundMonths >= 12) score = Math.min(100, score + 4)
	else if (fundMonths > 0) score = Math.min(100, score + 2)
	if (socialMonths >= 12) score = Math.min(100, score + 3)
	else if (socialMonths > 0) score = Math.min(100, score + 1)
	if (fundBase >= 15000) score = Math.min(100, score + 3)
	if (socialBase >= 15000) score = Math.min(100, score + 2)
	if (tax.hasFullYearTaxView) score = Math.min(100, score + 3)
	if (tax.jobChangeLikely && minScore >= 60) {
		score = Math.max(0, score - 4)
		addReason(reasons, '个税显示单位变动，需复核稳定性')
	}
	if (product.category === 'credit_card' && educationScore >= 3) score = Math.min(100, score + 3)
	if (product.category === 'credit_card' && educationScore <= 0 && minScore >= 62) {
		score = Math.max(0, score - 2)
	}

	score = Math.max(5, Math.round(score))
	for (const reason of decisionBlocks) addReason(reasons, reason)
	const decisionEligible = decisionBlocks.length === 0
	if (!decisionEligible) score = Math.min(score, 59)

	return {
		matchRate: score,
		matchReasons: reasons,
		isMatch: decisionEligible && score >= 60,
		decisionEligible
	}
}

export function scoreProductsByMatch(products, profile) {
	return (products || []).map((p) => {
		const r = computeProductMatchRate(p, profile)
		return {
			...p,
			matchRate: r.matchRate,
			matchReasons: r.matchReasons,
			isMatch: r.isMatch,
			decisionEligible: r.decisionEligible
		}
	}).sort((a, b) => b.matchRate - a.matchRate)
}

function addReason(list, text) {
	if (!text || list.includes(text)) return
	list.push(text)
}

export function explainMatchGaps(profile, scoredProducts = [], visibleProducts = []) {
	const reasons = []
	const nextActions = []
	if (!profile || typeof profile !== 'object') {
		return {
			severity: 'empty',
			title: '缺少信用画像',
			summary: '当前没有可用于匹配的报告数据，请先上传或重新分析报告。',
			reasons: ['未读取到有效报告画像'],
			nextActions: ['先上传最新信用报告，再补充三金、个税或资产材料。']
		}
	}

	if (profile.hasDecisionOverdue === true && (profile.hasLianSan || profile.hasLeiLiu)) {
		addReason(reasons, '存在连三或累六等严重逾期，银行类产品通常会直接拒绝')
		addReason(nextActions, '先结清或处理逾期账户，保持 6-12 个月无新增逾期后再评估银行类产品。')
	} else if (profile.hasDecisionOverdue === true && profile.hasOverdue) {
		addReason(reasons, '存在逾期记录，纯信用产品通过率会下降')
		addReason(nextActions, '优先补齐逾期并确认账户状态更新，连续 3-6 个月正常还款后再申请更稳。')
	} else if (profile.hasDecisionOverdue !== true && profile.archivalHasOverdue === true) {
		addReason(nextActions, '历史报告含逾期信号，但缺少证据化来源；重新分析后再用于准入判断。')
	}
	if (profile.hasDecisionScore === true && profile.totalScore > 0 && profile.totalScore < 55) {
		addReason(reasons, '综合评分低于多数产品准入门槛')
		addReason(nextActions, '先养护征信 3-6 个月：按期还款、降低额度占用、暂停密集申请。')
	} else if (profile.hasDecisionScore !== true) {
		addReason(nextActions, '重新分析完整报告，生成可复算的评分依据后再使用分数类门槛。')
	}
	if (profile.hasDecisionDebtRatio === true && profile.debtRatioPct > 80) {
		addReason(reasons, '负债率偏高，建议先降低月供或优化负债结构')
		addReason(nextActions, '优先压降高月供和高占用账户，1-3 个月内把负债率降到 70% 以下再重新匹配。')
	} else if (profile.hasDecisionDebtRatio !== true) {
		addReason(nextActions, '负债比例缺少可核对分子、分母时不作高低判断，以报告债务明细为准。')
	}
	if (profile.q3Known === true && profile.q3 > 10) {
		addReason(reasons, '近 3 个月信用查询偏多，短期申请过密')
		addReason(nextActions, '暂停新增申请 2-3 个月，等待查询影响自然下降。')
	} else if (profile.q3Known !== true) {
		addReason(nextActions, '查询次数缺少证据时不作安全判断，请重新分析完整报告。')
	}
	if (profile.nonBankLoanRatioKnown === true && profile.nonBankLoanRatio > 0.4) {
		addReason(reasons, '非银贷款占比较高，银行系产品会更谨慎')
		addReason(nextActions, '减少非银账户占比，优先保留银行系、稳定还款的账户记录，通常需观察 3-6 个月。')
	} else if (profile.nonBankLoanRatioKnown !== true) {
		addReason(nextActions, '非银贷款占比未知，需完成机构分类复核后再匹配。')
	}
	if (profile.institutionCountKnown === true && profile.institutionCount > 10) {
		addReason(reasons, '授信或借贷机构数偏多，存在多头借贷特征')
		addReason(nextActions, '合并或结清小额分散账户，降低机构数量后等待下一期征信更新。')
	} else if (profile.institutionCountKnown !== true) {
		addReason(nextActions, '借贷机构数未知，需核对完整账户明细后再匹配。')
	}
	if (typeof profile.integratedRiskScore === 'number' && profile.integratedRiskScore < 55) {
		addReason(reasons, '综合风险分偏低，需要人工复核或债务优化方案')
		addReason(nextActions, '先让顾问复核报告异常项，再决定是否进入产品申请。')
	}
	const supplement = profile.supplementMaterialProfile || {}
	if (!supplement.materialCount && !supplement.materialDecisionCount) {
		addReason(nextActions, '先确认社保/公积金、工资流水/个税、房产或车辆材料：有就上传，没有就选择暂无。')
	} else if (Array.isArray(supplement.missing) && supplement.missing.length) {
		addReason(nextActions, `继续确认${supplement.missing.slice(0, 2).join('、')}，没有也要选择暂无，系统会按真实条件保守匹配。`)
	}
	if (supplement.productMatchUnlocked && !supplement.hasStableIncomeEvidence) {
		addReason(reasons, '稳定收入或缴存材料不足')
		addReason(nextActions, '如暂时没有三金/个税，先保留 6 个月工资流水或稳定经营流水，再重新评估。')
	}
	if (supplement.taxAnalysis && supplement.taxAnalysis.jobChangeLikely) {
		addReason(reasons, '个税显示工作或扣缴单位变化')
		addReason(nextActions, '换工作后建议稳定缴纳 6 个月以上，再申请对单位稳定性要求高的银行产品。')
	}

	for (const product of scoredProducts.slice(0, 6)) {
		for (const reason of product.matchReasons || []) addReason(reasons, reason)
	}

	if (reasons.length === 0 && visibleProducts.length === 0) {
		addReason(reasons, '当前产品库规则与报告画像匹配度不足')
	}
	if (reasons.length === 0 && visibleProducts.length > 0) {
		addReason(reasons, '可选方案较少，建议补充收入、资产或顾问信息后再复核')
	}

	const bestRate = scoredProducts.length ? Number(scoredProducts[0].matchRate || 0) : 0
	const hasVisible = visibleProducts.length > 0
	return {
		severity: hasVisible ? 'warning' : 'empty',
		title: hasVisible ? '匹配度偏低，建议谨慎选择' : '暂无高可信匹配方案',
		summary: hasVisible
			? `当前最高匹配度 ${bestRate || '--'}%，建议结合顾问复核后再申请。`
			: '系统未找到足够可信的可申请方案，建议先优化关键风险项；如果无法自行判断，请联系顾问人工评估。',
		reasons: reasons.slice(0, 5),
		nextActions: [...nextActions, '无法自行完成养护或材料判断时，建议联系客服进入人工复核。'].slice(0, 5)
	}
}

/**
 * 对产品列表打分排序（云端本地通用）
 */
export function rankProductsByMatch(products, profile, opts = {}) {
	const minRate = opts.minRate ?? 30
	const limit = opts.limit ?? 6
	return scoreProductsByMatch(products, profile)
		.filter((p) => p.isMatch === true && p.matchRate > minRate)
		.slice(0, limit)
}
