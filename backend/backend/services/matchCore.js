'use strict'

const { evaluatePublicationGate } = require('./creditEvidenceLedger')
const { buildArtifactHash } = require('./analysisIdentity')

/**
 * 服务端匹配核心（CommonJS）— 与前端 services/matchCore.js 同算法、同字段。
 *
 * ⚠️ 修改任意一侧时，必须同步另一侧；这是云端 /api/match-products 和
 *    客户端本地预览（localMatchProducts）给同一份征信打出相同分数的前提。
 *
 * 因为前端是 ESM、后端是 CommonJS，且后端无法在 require 中加载 ESM 文件，
 * 因此采用「同算法两份」的策略；逻辑保持 1:1 镜像。
 */

function safeNum(v, def = 0) {
	return typeof v === 'number' && !isNaN(v) && isFinite(v) ? v : def
}

function addReason(list, text) {
	if (!text || list.includes(text)) return
	list.push(text)
}

function objectValue(value) {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function first(...values) {
	return values.find((value) => value !== undefined && value !== null && value !== '')
}

function boundedScore(value) {
	const number = Number(value)
	return Number.isFinite(number) && number >= 0 && number <= 100 ? Math.round(number) : null
}

function validHash(value, prefix) {
	return new RegExp(`^${prefix}_[a-f0-9]{64}$`).test(String(value || '').trim())
}

const REQUIRED_EVIDENCE_SCOPE = Object.freeze([
	'credit_debt.total_debt',
	'credit_debt.credit_loans.total_balance',
	'credit_debt.credit_cards.total_limit',
	'credit_debt.credit_cards.total_used',
	'credit_debt.credit_cards.utilization_used',
	'credit_debt.credit_cards.usage_rate',
	'credit_debt.credit_cards.shared_group_count',
	'query_analysis.summary.last_1m.total',
	'query_analysis.summary.last_3m.total',
	'query_analysis.summary.last_6m.total',
	'query_analysis.summary.last_12m.total',
	'primary_rule_score.score'
])

function finiteNumberOrNull(value) {
	if (value === '' || value === null || value === undefined || typeof value === 'boolean') return null
	const number = Number(value)
	return Number.isFinite(number) ? number : null
}

function moneyValueYuan(input) {
	const value = objectValue(input)
	if (String(value.type || '').toLowerCase() !== 'money') return null
	if (String(value.currency || '').toUpperCase() !== 'CNY') return null
	const minor = finiteNumberOrNull(value.minor)
	return minor == null ? null : minor / 100
}

function moneyMetricYuan(metric) {
	return moneyValueYuan(metric && metric.value)
}

function metricValueNumber(metric) {
	const value = objectValue(metric && metric.value)
	return finiteNumberOrNull(value.value)
}

function sameNumber(left, right, tolerance = 0.0001) {
	const a = finiteNumberOrNull(left)
	const b = finiteNumberOrNull(right)
	return a != null && b != null && Math.abs(a - b) <= tolerance
}

/**
 * Verify the complete evidence-v2 HMAC chain and its canonical projections.
 * `evidence_meta` is only an index into the signed artifacts; its hash-looking
 * strings are never sufficient by themselves because a client can invent them.
 */
function inspectEvidenceV2(payload) {
	const { root } = normalizeAnalysisPayload(payload)
	const artifacts = objectValue(first(root.evidence_v2, root.evidenceV2))
	const manifest = objectValue(artifacts.manifest)
	const evidenceGraph = objectValue(artifacts.evidenceGraph)
	const factLedger = objectValue(artifacts.factLedger)
	const derivedAnalysis = objectValue(artifacts.derivedAnalysis)
	const declaredGate = objectValue(artifacts.publicationGate)
	const meta = objectValue(first(root.evidence_meta, root.evidenceMeta))
	const scope = Array.isArray(meta.authoritative_scope) ? meta.authoritative_scope : []
	const metrics = objectValue(derivedAnalysis.metrics)
	const fail = (reason) => ({ verified: false, reason, root, metrics: {}, scope: [] })

	if (
		artifacts.contract !== 'rpt.credit/evidence-first-analysis/2.0' ||
		String(artifacts.status || '').toLowerCase() !== 'publishable' ||
		String(declaredGate.status || '').toLowerCase() !== 'passed'
	) return fail('ARTIFACT_CONTRACT_INVALID')

	let evaluatedGate
	try {
		evaluatedGate = evaluatePublicationGate(
			{ manifest, evidenceGraph, factLedger, derivedAnalysis },
			{ hashFn: buildArtifactHash }
		)
	} catch (_) {
		return fail('ARTIFACT_HASH_INVALID')
	}
	if (!evaluatedGate.publishable || evaluatedGate.status !== 'passed') return fail('ARTIFACT_HASH_INVALID')

	if (
		String(meta.version || '').toLowerCase() !== 'evidence-v2' ||
		String(meta.status || '').toLowerCase() !== 'publishable' ||
		String(meta.publication_gate || '').toLowerCase() !== 'passed' ||
		!validHash(meta.manifest_hash, 'mh_v2') ||
		!validHash(meta.evidence_hash, 'eg_v2') ||
		!validHash(meta.fact_hash, 'fl_v2') ||
		!validHash(meta.metric_hash, 'da_v2') ||
		meta.manifest_hash !== manifest.manifestHash ||
		meta.evidence_hash !== evidenceGraph.evidenceGraphHash ||
		meta.fact_hash !== factLedger.factLedgerHash ||
		meta.metric_hash !== derivedAnalysis.derivedAnalysisHash ||
		!REQUIRED_EVIDENCE_SCOPE.every((path) => scope.includes(path))
	) return fail('EVIDENCE_META_INVALID')

	const primaryScore = objectValue(metrics.primaryScore)
	const queryCounts = objectValue(metrics.queryCounts)
	const totalDebt = objectValue(metrics.totalDebt)
	const totalLoanBalance = objectValue(metrics.totalLoanBalance)
	const cardOutstanding = objectValue(metrics.cardOutstanding)
	const cardUtilization = objectValue(metrics.cardUtilization)
	const creditDebt = objectValue(root.credit_debt)
	const creditLoans = objectValue(creditDebt.credit_loans)
	const creditCards = objectValue(creditDebt.credit_cards)
	const querySummary = objectValue(objectValue(root.query_analysis).summary)
	const primary = objectValue(root.primary_rule_score)

	if (
		String(primaryScore.status || '').toLowerCase() !== 'computed' ||
		!['primary-score-deterministic-v2', 'primary-score-deterministic-v3']
			.includes(String(primaryScore.formulaId || '')) ||
		boundedScore(metricValueNumber(primaryScore)) == null ||
		!sameNumber(metricValueNumber(primaryScore), primary.score, 0) ||
		String(queryCounts.status || '').toLowerCase() !== 'computed' ||
		String(queryCounts.formulaId || '') !== 'hard-query-calendar-window-v2' ||
		String(totalDebt.status || '').toLowerCase() !== 'computed' ||
		String(totalDebt.formulaId || '') !== 'total-debt-v2' ||
		String(totalLoanBalance.status || '').toLowerCase() !== 'computed' ||
		String(totalLoanBalance.formulaId || '') !== 'loan-balance-sum-v2' ||
		String(cardOutstanding.status || '').toLowerCase() !== 'computed' ||
		String(cardOutstanding.formulaId || '') !== 'card-outstanding-cny-v1'
	) return fail('DERIVED_METRIC_INVALID')

	const totalDebtYuan = moneyMetricYuan(totalDebt)
	const totalLoanYuan = moneyMetricYuan(totalLoanBalance)
	const cardOutstandingYuan = moneyMetricYuan(cardOutstanding)
	if (
		totalDebtYuan == null || totalLoanYuan == null || cardOutstandingYuan == null ||
		!sameNumber(totalDebtYuan, creditDebt.total_debt, 0.001) ||
		!sameNumber(totalLoanYuan, creditLoans.total_balance, 0.001) ||
		!sameNumber(totalDebtYuan, totalLoanYuan + cardOutstandingYuan, 0.001)
	) return fail('DERIVED_PROJECTION_MISMATCH')

	const cardStatus = String(cardUtilization.status || '').toLowerCase()
	let expectedLimit = null
	let expectedUsed = null
	let expectedUsage = null
	if (cardStatus === 'computed' && cardUtilization.formulaId === 'card-utilization-cny-v2') {
		expectedLimit = finiteNumberOrNull(objectValue(cardUtilization.denominator).minor)
		expectedUsed = finiteNumberOrNull(objectValue(cardUtilization.numerator).minor)
		expectedUsage = finiteNumberOrNull(objectValue(cardUtilization.value).value)
		if (expectedLimit != null) expectedLimit /= 100
		if (expectedUsed != null) expectedUsed /= 100
		if (expectedUsage != null) expectedUsage /= 10000
	} else if (cardStatus === 'not_applicable' && cardUtilization.formulaId === 'card-utilization-cny-v2') {
		expectedLimit = 0
		expectedUsed = 0
		expectedUsage = 0
	} else {
		return fail('DERIVED_METRIC_INVALID')
	}
	const facilityTrace = Array.isArray(cardOutstanding.facilityTrace) ? cardOutstanding.facilityTrace : null
	const sharedGroupCount = facilityTrace
		? facilityTrace.filter((group) => Array.isArray(group.memberEntityIds) && group.memberEntityIds.length > 1).length
		: null
	if (
		expectedLimit == null || expectedUsed == null || expectedUsage == null || sharedGroupCount == null ||
		!sameNumber(expectedLimit, creditCards.total_limit, 0.001) ||
		!sameNumber(cardOutstandingYuan, creditCards.total_used, 0.001) ||
		!sameNumber(expectedUsed, creditCards.utilization_used, 0.001) ||
		!sameNumber(expectedUsage, creditCards.usage_rate, 0.0001) ||
		!sameNumber(sharedGroupCount, creditCards.shared_group_count, 0)
	) return fail('DERIVED_PROJECTION_MISMATCH')

	const windows = objectValue(queryCounts.value)
	for (const months of [1, 3, 6, 12]) {
		const key = `last_${months}m`
		if (!sameNumber(windows[key], objectValue(querySummary[key]).total, 0)) {
			return fail('DERIVED_PROJECTION_MISMATCH')
		}
	}

	return {
		verified: true,
		reason: '',
		root,
		artifacts,
		metrics,
		scope: [...scope]
	}
}

function resolveDecisionScore(root, evidence = inspectEvidenceV2(root)) {
	const report = objectValue(root.report)
	const primary = objectValue(first(
		root.primary_rule_score,
		report.primaryRuleScore,
		report.primary_rule_score
	))
	const archivalValue = boundedScore(first(
		primary.score,
		report.totalScore,
		root.totalScore
	))
	if (evidence.verified) {
		const score = boundedScore(metricValueNumber(evidence.metrics.primaryScore))
		return {
			value: score,
			archivalValue,
			decisionEligible: score != null,
			source: score == null ? 'unavailable' : 'verified-evidence-v2'
		}
	}
	return {
		value: null,
		archivalValue,
		decisionEligible: false,
		source: archivalValue == null ? 'unavailable' : 'archival-primary-rule'
	}
}

function resolveEvidenceBackedDebtRatio() {
	// evidence-v2 intentionally publishes totalDebt and cardUtilization, not a
	// debt ratio. There is no approved denominator/PRD formula, so a client-added
	// `derived.metrics.debtRatio` must never become a decision input.
	return { value: null, decisionEligible: false, source: 'unsupported-metric' }
}

function archivalOverdueState(root) {
	const report = objectValue(root.report)
	const insight = objectValue(first(root.aiInsight, root.kimiInsight))
	const overdue = objectValue(insight.overdue_summary)
	const overdueInfo = objectValue(root.overdue_info)
	const dims = objectValue(root.dimensions)
	const snapshot = objectValue(report.dimensionSnapshot)
	const records = Array.isArray(root.overdueRecords) ? root.overdueRecords : []
	const recordOverdue = records.some((record) => {
		if (!record || typeof record !== 'object') return false
		const days = finiteNumberOrNull(first(record.days, record.overdueDays, record.overdue_days))
		const level = String(first(record.level, record.overdueLevel, record.overdue_level, ''))
		return record.isOverdue === true || record.has_overdue === true ||
			(days != null && days > 0) || /^M[1-9]\+?$/i.test(level) || statusIndicatesOverdue(record.status)
	})
	const count = finiteNumberOrNull(first(
		overdueInfo.total_overdue_accounts,
		overdue.current_overdue_count,
		dims.overdueCount
	))
	const hasExplicitData = records.length > 0 || count != null ||
		typeof overdueInfo.has_overdue === 'boolean' ||
		typeof dims.hasLianSan === 'boolean' || typeof dims.hasLeiLiu === 'boolean'
	const hasOverdue = hasExplicitData
		? Boolean(overdueInfo.has_overdue === true || (count != null && count > 0) || recordOverdue)
		: null
	const hasLianSan = hasExplicitData
		? Boolean(overdue.consecutive_overdue_3 || dims.hasLianSan || snapshot.hasLianSan)
		: null
	const hasLeiLiu = hasExplicitData
		? Boolean(overdue.cumulative_overdue_6 || dims.hasLeiLiu || snapshot.hasLeiLiu ||
			(count != null && count >= 6 && !hasLianSan))
		: null
	return {
		hasOverdue,
		hasLianSan,
		hasLeiLiu,
		count: count == null ? (records.length ? records.length : null) : count
	}
}

function verifiedQueryWindows(evidence) {
	if (!evidence || evidence.verified !== true) {
		return { q1: null, q3: null, q6: null, q12: null, decisionEligible: false }
	}
	const metric = objectValue(evidence.metrics.queryCounts)
	const value = objectValue(metric.value)
	const windows = [1, 3, 6, 12].map((months) => finiteNumberOrNull(value[`last_${months}m`]))
	if (
		String(metric.status || '').toLowerCase() !== 'computed' ||
		metric.formulaId !== 'hard-query-calendar-window-v2' ||
		windows.some((count) => count == null || count < 0 || !Number.isInteger(count))
	) return { q1: null, q3: null, q6: null, q12: null, decisionEligible: false }
	return {
		q1: windows[0],
		q3: windows[1],
		q6: windows[2],
		q12: windows[3],
		decisionEligible: true
	}
}

function verifiedTotalDebt(evidence) {
	if (!evidence || evidence.verified !== true) return { value: null, decisionEligible: false }
	const value = moneyMetricYuan(evidence.metrics.totalDebt)
	return value != null && value >= 0
		? { value, decisionEligible: true }
		: { value: null, decisionEligible: false }
}

function verifiedTotalLoanBalance(evidence) {
	if (!evidence || evidence.verified !== true) return { value: null, decisionEligible: false }
	const metric = objectValue(evidence.metrics.totalLoanBalance)
	const value = moneyMetricYuan(metric)
	return (
		String(metric.status || '').toLowerCase() === 'computed' &&
		metric.formulaId === 'loan-balance-sum-v2' &&
		value != null && value >= 0
	)
		? { value, decisionEligible: true }
		: { value: null, decisionEligible: false }
}

function verifiedCardUtilization(evidence) {
	const unavailable = {
		totalLimit: null,
		totalUsed: null,
		utilizationUsed: null,
		rate: null,
		pct: null,
		sharedCreditGroupCount: null,
		decisionEligible: false
	}
	if (!evidence || evidence.verified !== true) return unavailable
	const metric = objectValue(evidence.metrics.cardUtilization)
	const outstandingMetric = objectValue(evidence.metrics.cardOutstanding)
	const status = String(metric.status || '').toLowerCase()
	if (metric.formulaId !== 'card-utilization-cny-v2') return unavailable
	const facilityTrace = Array.isArray(outstandingMetric.facilityTrace) ? outstandingMetric.facilityTrace : null
	if (!facilityTrace) return unavailable
	const cardOutstanding = moneyMetricYuan(outstandingMetric)
	if (
		String(outstandingMetric.status || '').toLowerCase() !== 'computed' ||
		outstandingMetric.formulaId !== 'card-outstanding-cny-v1' ||
		cardOutstanding == null || cardOutstanding < 0
	) return unavailable
	const sharedCreditGroupCount = facilityTrace.filter((group) => (
		Array.isArray(group && group.memberEntityIds) && group.memberEntityIds.length > 1
	)).length

	if (status === 'not_applicable') {
		return {
			totalLimit: 0,
			totalUsed: cardOutstanding,
			utilizationUsed: 0,
			rate: 0,
			pct: 0,
			sharedCreditGroupCount,
			decisionEligible: true
		}
	}
	if (status !== 'computed') return unavailable
	const totalLimit = moneyValueYuan(metric.denominator)
	const totalUsed = moneyValueYuan(metric.numerator)
	const rateValue = objectValue(metric.value)
	const rateBps = finiteNumberOrNull(rateValue.value)
	if (
		totalLimit == null || totalLimit <= 0 ||
		totalUsed == null || totalUsed < 0 ||
		String(rateValue.type || '').toLowerCase() !== 'rate-bps' ||
		rateBps == null || rateBps < 0 ||
		!sameNumber(rateBps / 10000, totalUsed / totalLimit, 0.0001)
	) return unavailable
	// Over-limit facilities are a real, decision-relevant fact. Preserve the
	// evidence-backed ratio above 1 instead of silently rewriting it to 100%.
	const rate = Math.max(0, rateBps / 10000)
	return {
		totalLimit,
		totalUsed: cardOutstanding,
		utilizationUsed: totalUsed,
		rate,
		pct: Math.round(rate * 10000) / 100,
		sharedCreditGroupCount,
		decisionEligible: true
	}
}

function statusIndicatesOverdue(status) {
	const remaining = String(status || '')
		.replace(/(?:未|无|从未|从无|没有|不存在|未发生|未出现)(?:任何|过)?逾期/gi, ' ')
		.replace(/逾期(?:记录|情况|账户|月份|月数|次数)?(?:为|共|合计)?\s*(?:0|零|无)(?:个|次|月|笔)?/gi, ' ')
		.replace(/(?:not|never|no)\s+overdue/gi, ' ')
	return /逾期|overdue/i.test(remaining)
}

function normalizeAnalysisPayload(payload) {
	if (!payload || typeof payload !== 'object') return { root: {}, compositeMeta: null }
	const root = payload.analysisResult || payload.analysisData || payload
	const compositeMeta = payload.compositeMeta || root.compositeMeta || null
	return { root, compositeMeta }
}

function buildUnifiedMatchProfile(payload) {
	const { root, compositeMeta } = normalizeAnalysisPayload(payload)
	const report = objectValue(root.report)
	const dims = objectValue(root.dimensions)
	const ki = objectValue(first(root.aiInsight, root.kimiInsight))
	const evidence = inspectEvidenceV2(root)

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

	const scoreResolution = resolveDecisionScore(root, evidence)
	const hasDecisionScore = scoreResolution.decisionEligible === true
	const totalScore = hasDecisionScore ? scoreResolution.value : null
	const adjustedCandidate = boundedScore(first(
		report.adjustedTotalScore,
		objectValue(compositeMeta).adjustedTotalScore
	))
	// Adjusted/composite scores are outside the signed evidence-v2 metric set.
	// Keep every historical or client-named attestation archival-only.
	const hasDecisionAdjustedScore = false
	const adjustedTotalScore = null
	const effectiveScore = totalScore
	const hasAuditableDimensions = false

	// The current evidence-v2 contract has no overdue metric. Preserve legacy
	// rows for display only and keep all overdue decisions unknown/fail-closed.
	const archivalOverdue = archivalOverdueState(root)
	const hasDecisionOverdue = false
	const hasOverdue = null
	const hasLianSan = null
	const hasLeiLiu = null

	const debtRatioResolution = resolveEvidenceBackedDebtRatio()
	const hasDecisionDebtRatio = debtRatioResolution.decisionEligible === true
	const debtRatio = hasDecisionDebtRatio ? debtRatioResolution.value : null
	const debtRatioPct = hasDecisionDebtRatio
		? (debtRatio <= 1.5 ? Math.round(debtRatio * 100) : Math.round(debtRatio))
		: null

	const query = verifiedQueryWindows(evidence)
	const q1 = query.q1
	const q3 = query.q3
	const q6 = query.q6
	const q12 = query.q12
	const hasDecisionQueryWindows = query.decisionEligible === true

	// Neither ratio nor institution count has a published evidence-v2 metric.
	const nonBankLoanRatio = null
	const institutionCount = null
	const hasDecisionNonBankLoanRatio = false
	const hasDecisionInstitutionCount = false
	const integratedRiskScore = null
	const totalDebtResolution = verifiedTotalDebt(evidence)
	const totalCreditDebt = totalDebtResolution.decisionEligible ? totalDebtResolution.value : null
	const hasDecisionTotalCreditDebt = totalDebtResolution.decisionEligible === true

	const riskLevel = 'unknown'
	const stabilityScore = null

	return {
		sixDims,
		totalScore: effectiveScore,
		baseTotalScore: totalScore,
		adjustedTotalScore,
		archivalAdjustedTotalScore: adjustedCandidate,
		hasDecisionAdjustedScore,
		hasDecisionScore,
		hasVerifiedEvidenceV2: evidence.verified === true,
		evidenceDecisionReason: evidence.verified ? '' : evidence.reason,
		hasAuditableDimensions,
		supplementMaterialProfile: root.supplementMaterialProfile || report.supplementMaterialProfile || null,
		hasOverdue,
		hasLianSan,
		hasLeiLiu,
		overdueCount: null,
		archivalHasOverdue: archivalOverdue.hasOverdue,
		archivalHasLianSan: archivalOverdue.hasLianSan,
		archivalHasLeiLiu: archivalOverdue.hasLeiLiu,
		archivalOverdueCount: archivalOverdue.count,
		hasDecisionOverdue,
		overdueKnown: false,
		hasLianSanKnown: false,
		hasLeiLiuKnown: false,
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
		q1Known: hasDecisionQueryWindows,
		q3Known: hasDecisionQueryWindows,
		q6Known: hasDecisionQueryWindows,
		nonBankLoanRatio,
		hasDecisionNonBankLoanRatio,
		nonBankLoanRatioKnown: hasDecisionNonBankLoanRatio,
		institutionCount,
		hasDecisionInstitutionCount,
		institutionCountKnown: hasDecisionInstitutionCount,
		integratedRiskScore,
		totalCreditDebt,
		hasDecisionTotalCreditDebt,
		isHighRisk:
			(hasDecisionOverdue && (hasLianSan || hasLeiLiu)) ||
			(hasDecisionDebtRatio && debtRatioPct > 80),
		isLowRisk: false
	}
}

function computeProductMatchRate(product, profile) {
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
	const maxDr = safeNum(rules.maxDebtRatio, 1)
	if (profile.hasDecisionDebtRatio === true && typeof profile.debtRatio === 'number' && profile.debtRatio > maxDr) {
		const excess = (profile.debtRatio - maxDr) * 100
		score -= Math.min(35, excess * 1.5)
		reasons.push('负债率偏高')
	} else if (rules.maxDebtRatio != null && profile.hasDecisionDebtRatio !== true) {
		addReason(decisionBlocks, '负债比例暂无正式证据化口径，待核对后匹配')
	}
	if (
		rules.maxQueryCount != null && profile.hasDecisionQueryWindows === true &&
		typeof profile.q3 === 'number' && profile.q3 > rules.maxQueryCount
	) {
		score -= Math.min(20, (profile.q3 - rules.maxQueryCount) * 3)
		reasons.push('近3个月信用查询偏多')
	} else if (rules.maxQueryCount != null && profile.hasDecisionQueryWindows !== true) {
		addReason(decisionBlocks, '近3个月查询次数未知，待核对后匹配')
	}
	if (
		rules.maxNonBankRatio != null && profile.hasDecisionNonBankLoanRatio === true &&
		typeof profile.nonBankLoanRatio === 'number' && profile.nonBankLoanRatio > rules.maxNonBankRatio
	) {
		score -= Math.min(18, (profile.nonBankLoanRatio - rules.maxNonBankRatio) * 40)
		reasons.push('非银贷款占比较高')
	} else if (rules.maxNonBankRatio != null && profile.hasDecisionNonBankLoanRatio !== true) {
		addReason(decisionBlocks, '非银贷款占比未知，待核对后匹配')
	}
	if (
		rules.maxInstitutions != null && profile.hasDecisionInstitutionCount === true &&
		typeof profile.institutionCount === 'number' && profile.institutionCount > rules.maxInstitutions
	) {
		score -= Math.min(15, (profile.institutionCount - rules.maxInstitutions) * 2)
		reasons.push('多头机构数偏多')
	} else if (rules.maxInstitutions != null && profile.hasDecisionInstitutionCount !== true) {
		addReason(decisionBlocks, '借贷机构数未知，待核对后匹配')
	}

	// 统一口径：总分优先主评分框架（规则扣分制）
	const sd = profile.sixDims
	const weightedScore =
		(sd.repaymentRecord * 0.33 +
			sd.creditHistory * 0.27 +
			sd.accountStructure * 0.24 +
			sd.queryFrequency * 0.16) /
		100
	if (profile.hasAuditableDimensions === true) score = score * (0.85 + weightedScore * 0.15)

	if (rules.preferHighDebt && profile.hasDecisionDebtRatio === true && profile.debtRatioPct > 60) score = Math.min(100, score + 12)
	if (rules.preferHighOverdue && profile.hasDecisionOverdue === true && profile.hasOverdue) score = Math.min(100, score + 10)
	if (rules.preferLowScore && profile.hasDecisionScore === true && profile.totalScore < 50) score = Math.min(100, score + 8)
	if (rules.preferLowDebt && profile.hasDecisionDebtRatio === true && profile.debtRatioPct < 40) score = Math.min(100, score + 8)
	if (rules.preferGoodHistory && profile.hasAuditableDimensions === true && sd.creditHistory > 75) score = Math.min(100, score + 8)

	if (typeof profile.integratedRiskScore === 'number') {
		if (profile.integratedRiskScore >= 72 && minScore >= 60 && !profile.hasLianSan) {
			score = Math.min(100, score + 5)
		}
		if (profile.integratedRiskScore < 52 && (rules.preferHighDebt || rules.preferLowScore)) {
			score = Math.min(100, score + 6)
		}
	}
	if (typeof profile.stabilityScore === 'number' && profile.stabilityScore >= 76 && !profile.hasLianSan) {
		score = Math.min(100, score + 5)
	}
	if (typeof profile.stabilityScore === 'number' && profile.stabilityScore < 36 && minScore >= 55) {
		score = Math.max(0, score - 6)
	}

	if (rules.preferIncomeEvidence && supplement.hasStableIncomeEvidence) score = Math.min(100, score + 5)
	if (rules.preferAssetEvidence && supplement.hasAssetEvidence) score = Math.min(100, score + 5)
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

	let compositeBonus = 0
	// Legacy compositeMeta is not part of the signed evidence-v2 metric set.
	// Preserve it for display/debug compatibility, but never award points from it.

	score = Math.min(100, score + compositeBonus)
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

function firstFiniteOrNull(...values) {
	for (const value of values) {
		const number = finiteNumberOrNull(value)
		if (number != null) return number
	}
	return null
}

function firstTextOrNull(...values) {
	for (const value of values) {
		if (value === undefined || value === null || value === '') continue
		return String(value)
	}
	return null
}

/**
 * Decision-safe report projection used by owner lists, statistics and admin
 * views. Legacy/raw values remain available only under explicit archival keys.
 */
function buildDecisionSummary(payload, options = {}) {
	const envelope = objectValue(payload)
	const { root } = normalizeAnalysisPayload(payload)
	const evidence = options && options.evidenceTrusted === true
		? inspectEvidenceV2(root)
		: {
			verified: false,
			reason: 'EVIDENCE_NOT_SERVER_TRUSTED',
			metrics: {}
		}
	const report = objectValue(root.report)
	const assessment = objectValue(root.assessment)
	const deterministicDimensions = objectValue(first(
		root.deterministic_dimensions,
		root.deterministicDimensions,
		root.dimensions
	))
	const creditReport = objectValue(first(root.creditReportV2, root.credit_report_v2, root.credit_report_full))
	const frontendPayload = objectValue(first(root.frontendPayload, root.frontend_payload))
	const creditDebt = objectValue(first(
		root.credit_debt,
		root.creditDebt,
		creditReport.credit_debt,
		creditReport.creditDebt,
		frontendPayload.credit_debt,
		frontendPayload.creditDebt
	))
	const queryAnalysis = objectValue(first(
		root.query_analysis,
		root.queryAnalysis,
		creditReport.query_analysis,
		creditReport.queryAnalysis,
		frontendPayload.query_analysis,
		frontendPayload.queryAnalysis
	))
	const querySummary = objectValue(queryAnalysis.summary)
	const query6m = objectValue(first(querySummary.last_6m, querySummary.last6m))
	const accounts = Array.isArray(root.accounts)
		? root.accounts
		: (Array.isArray(report.accounts) ? report.accounts : null)

	const archival = {
		score: firstFiniteOrNull(
			envelope._score,
			envelope.score,
			envelope.totalScore,
			report.totalScore,
			root.totalScore,
			root.score,
			assessment.score,
			objectValue(root.primary_rule_score).score
		),
		riskLevel: firstTextOrNull(
			envelope._riskLevel,
			envelope.riskLevel,
			report.riskLevel,
			root.riskLevel,
			assessment.risk_level,
			assessment.riskLevel
		),
		accountCount: firstFiniteOrNull(
			envelope._accountCount,
			envelope.accountCount,
			deterministicDimensions.totalAccountCount,
			report.debtCount,
			accounts ? accounts.length : null
		),
		totalDebt: firstFiniteOrNull(
			creditDebt.total_debt,
			creditDebt.totalDebt,
			creditDebt.debt_total,
			envelope.totalDebt
		),
		query6mCount: firstFiniteOrNull(
			query6m.total,
			querySummary.last_6m_total,
			querySummary.last6mTotal,
			root.query6mCount,
			envelope.query6mCount
		)
	}

	const score = evidence.verified
		? boundedScore(metricValueNumber(evidence.metrics.primaryScore))
		: null
	const debt = verifiedTotalDebt(evidence)
	const loanBalance = verifiedTotalLoanBalance(evidence)
	const card = verifiedCardUtilization(evidence)
	const query = verifiedQueryWindows(evidence)
	const decisionFlags = {
		score: score != null,
		riskLevel: false,
		accountCount: false,
		totalDebt: debt.decisionEligible === true,
		totalLoanBalance: loanBalance.decisionEligible === true,
		cardTotalLimit: card.decisionEligible === true,
		cardTotalUsed: card.decisionEligible === true,
		cardUtilizationUsed: card.decisionEligible === true,
		cardUtilizationRate: card.decisionEligible === true,
		cardUtilizationPct: card.decisionEligible === true,
		sharedCreditGroupCount: card.decisionEligible === true,
		query1mCount: query.decisionEligible === true,
		query3mCount: query.decisionEligible === true,
		query6mCount: query.decisionEligible === true,
		query12mCount: query.decisionEligible === true
	}
	const knownCount = Object.values(decisionFlags).filter(Boolean).length
	const archivalCount = Object.values(archival).filter((value) => value !== null).length
	const decisionState = knownCount === Object.keys(decisionFlags).length
		? 'verified'
		: (knownCount > 0 ? 'partial' : (archivalCount > 0 ? 'archival' : 'unknown'))

	return {
		score,
		riskLevel: null,
		accountCount: null,
		totalDebt: debt.decisionEligible ? debt.value : null,
		totalLoanBalance: loanBalance.decisionEligible ? loanBalance.value : null,
		cardTotalLimit: card.decisionEligible ? card.totalLimit : null,
		cardTotalUsed: card.decisionEligible ? card.totalUsed : null,
		cardUtilizationUsed: card.decisionEligible ? card.utilizationUsed : null,
		cardUtilizationRate: card.decisionEligible ? card.rate : null,
		cardUtilizationPct: card.decisionEligible ? card.pct : null,
		sharedCreditGroupCount: card.decisionEligible ? card.sharedCreditGroupCount : null,
		query1mCount: query.decisionEligible ? query.q1 : null,
		query3mCount: query.decisionEligible ? query.q3 : null,
		query6mCount: query.decisionEligible ? query.q6 : null,
		query12mCount: query.decisionEligible ? query.q12 : null,
		archival,
		archivalScore: archival.score,
		archivalRiskLevel: archival.riskLevel,
		archivalAccountCount: archival.accountCount,
		archivalTotalDebt: archival.totalDebt,
		archivalQuery6mCount: archival.query6mCount,
		decisionFlags,
		decisionState,
		evidenceVerified: evidence.verified === true,
		evidenceReason: evidence.verified ? '' : evidence.reason
	}
}

function rankProductsByMatch(products, profile, opts = {}) {
	const minRate = opts.minRate != null ? opts.minRate : 30
	const limit = opts.limit != null ? opts.limit : 6
	const list = (products || []).map((p) => {
		const r = computeProductMatchRate(p, profile)
		return {
			...p,
			matchRate: r.matchRate,
			matchReasons: r.matchReasons,
			isMatch: r.isMatch,
			decisionEligible: r.decisionEligible
		}
	})
	return list
		.filter((p) => p.isMatch === true && p.matchRate > minRate)
		.sort((a, b) => b.matchRate - a.matchRate)
		.slice(0, limit)
}

module.exports = {
	safeNum,
	normalizeAnalysisPayload,
	inspectEvidenceV2,
	buildDecisionSummary,
	buildUnifiedMatchProfile,
	computeProductMatchRate,
	rankProductsByMatch
}
