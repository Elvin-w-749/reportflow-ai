import { scoreFourDimensions, calculatePrimaryRuleScore } from './creditAlgorithmCore.js'
import { parseCreditDate } from '../utils/beijingTime.js'
import { summarizeCreditCardUtilization } from '../utils/creditCardUtilization.js'
import { statusIndicatesActiveUnsettled, statusIndicatesSettled, statusIsUnknown } from '../utils/creditStatus.js'
import {
	firstStrictNonNegativeNumberOrNull,
	strictFiniteNumberOrNull,
	strictNonNegativeIntegerOrNull,
	strictNonNegativeNumberOrNull
} from '../utils/strictNumber.js'
import {
	classifyAccountStatus,
	filterQueryInstitutionDetailsLive,
	normalizeInstitutionKind,
	summarizeQueriesByWindows
} from '../utils/reportDetailAggregates.js'
import {
	AUTHORITATIVE_EVIDENCE_PATHS,
	getDeterministicDimensions,
	getServerAnalysisAuthority,
	isAuthoritativeServerAnalysis,
	markMappedServerAnalysis,
	resolveAuthoritativeServerRoot
} from './authoritativeAnalysis.js'

/**
 * 将 POST /api/analyze 返回的 data 规范为与本地 aiAnalysis 输出一致的结构，
 * 供 enrichAnalysisWithFinancialProfile、报告详情、normalizeReportData 使用。
 *
 * 服务端可能返回：完整客户端 bundle、扁平 snake_case、或嵌套在 result/analysis 下。
 */

const mapRiskLevel = (v) => {
	const raw = typeof v === 'string' ? v : ''
	const s = raw.trim().toLowerCase()
	if (!v && !s) return 'unknown'
	// 必须先判「高」（含「中高」），再判「中低」，再判「中」，最后才判「低」，
	// 否则 /低/ 会把「中低」误判为 low（低估风险）。
	if (s === 'high' || s === 'medium-high' || s === '高风险' || /高/.test(raw)) return 'high'
	if (s === 'medium-low' || s === 'medium_low' || raw.includes('中低')) return 'medium-low'
	if (s === 'medium' || s === '中风险' || s === '中' || /中/.test(raw)) return 'medium'
	if (s === 'low' || s === '低风险' || (/低/.test(raw) && !/降低/.test(raw))) return 'low'
	return 'unknown'
}

const num = (x, def = 0) => {
	const parsed = strictFiniteNumberOrNull(x)
	return parsed == null ? def : parsed
}

const finiteNumberOrNull = strictFiniteNumberOrNull

const nonNegativeNumberOrNull = strictNonNegativeNumberOrNull

const booleanOrNull = (value) => typeof value === 'boolean' ? value : null
const statusTextOrEmpty = (value) => {
	const text = typeof value === 'string' ? value.normalize('NFKC').trim() : ''
	return statusIsUnknown(text) ? '' : text
}

const firstNonNegativeNumberOrNull = firstStrictNonNegativeNumberOrNull

const maxKnownNonNegative = (...values) => {
	const numbers = []
	for (const value of values) {
		const number = nonNegativeNumberOrNull(value)
		if (number != null) numbers.push(number)
	}
	return numbers.length ? Math.max(...numbers) : null
}

const sumKnownRows = (rows, readValue, emptyIsKnown = false) => {
	if (!Array.isArray(rows)) return null
	if (!rows.length) return emptyIsKnown ? 0 : null
	let total = 0
	for (const row of rows) {
		const value = nonNegativeNumberOrNull(readValue(row || {}))
		if (value == null) return null
		total += value
	}
	return total
}

const DEBT_RATIO_DIAGNOSTIC_STATUS = 'denominator-evidence-pending'
const DISABLED_DEBT_RATIO_RISK_RULES = new Set([
	'DEBT_RATIO_HIGH',
	'DEBT_RATIO_CRITICAL',
	'MONTHLY_BURDEN'
])

const markDebtRatioDiagnosticOnly = (dimensions) => {
	if (!dimensions || typeof dimensions !== 'object') return dimensions
	dimensions.debtRatioDecisionEligible = false
	dimensions.debtRatioStatus = DEBT_RATIO_DIAGNOSTIC_STATUS
	// Keep the raw ratio for archival reconciliation, but never let legacy
	// suggestion/risk builders consume it as a formal threshold input.
	dimensions.debtRatioExceeds70 = false
	return dimensions
}

const isDisabledDebtRatioRiskHit = (hit) => {
	const code = String(
		typeof hit === 'string'
			? hit
			: hit && (hit.rule_name || hit.ruleName || hit.code) || ''
	).trim().toUpperCase()
	if (DISABLED_DEBT_RATIO_RISK_RULES.has(code)) return true
	const text = typeof hit === 'string'
		? hit
		: `${hit && hit.title || ''} ${hit && hit.detail || ''}`
	return isDisabledDebtRatioRiskText(text)
}

const isDisabledDebtRatioRiskText = (value) => (
	/负债率|授信占用率|月度还款压力/.test(String(value || ''))
)

const isCancelledCardRow = (row) =>
	/销户|注销|关闭|销卡|作废|已结清|结清/.test(String(row && row.status || ''))

const score100 = (x, def = 0) => {
	const n = num(x, NaN)
	if (!Number.isFinite(n) || n < 0 || n > 1000) return def
	const normalized = n > 100 && n <= 1000 ? n / 10 : n
	return Math.max(0, Math.min(100, Math.round(normalized)))
}

const pickFirst = (obj, keys, def = undefined) => {
	for (const k of keys) {
		if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k]
	}
	return def
}

const accountInstitutionKind = (row, structuralFallback = undefined) => {
	const source = row || {}
	const explicit = pickFirst(source, [
		'institutionKind',
		'institution_kind',
		'institutionType',
		'institution_type',
		'orgType',
		'org_type',
		'lenderType',
		'lender_type'
	], structuralFallback)
	return normalizeInstitutionKind(explicit, source.bank || source.institution || source.org || source.name || '')
}

const accountOverdueFlags = (row, status, overdueDays) => classifyAccountStatus({
	status,
	overdueDays,
	explicitOverdue: pickFirst(row || {}, ['isOverdue', 'is_overdue', 'overdue']),
	explicitAbnormal: pickFirst(row || {}, ['isAbnormal', 'is_abnormal', 'abnormal'])
})

const hasFiniteOwnNumber = (value, key) => (
	value &&
	typeof value === 'object' &&
	Object.prototype.hasOwnProperty.call(value, key) &&
	value[key] !== null &&
	value[key] !== undefined &&
	typeof value[key] !== 'boolean' &&
	(typeof value[key] === 'number' || (
		typeof value[key] === 'string' &&
		value[key].trim() !== ''
	)) &&
	Number.isFinite(Number(value[key]))
)

const optionalQueryCount = (value, keys) => {
	for (const key of keys) {
		if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, key)) continue
		const parsed = strictNonNegativeIntegerOrNull(value[key])
		if (parsed != null) return parsed
	}
	return null
}

/**
 * 查询总数存在但银行/非银分项缺失时，以 null + breakdownAvailable=false 表达未知，
 * 禁止将缺失信息伪装成 0/0。只有来源明确，或完整明细与总数吻合时才发布分项。
 */
const normalizeQueryWindowBreakdown = (rawValue, totalValue, derivedValue) => {
	const raw = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue) ? rawValue : {}
	const parsedTotal = nonNegativeNumberOrNull(totalValue)
	if (parsedTotal == null || parsedTotal < 0) {
		return {
			total: null,
			bank: null,
			nonBank: null,
			non_bank: null,
			unknown: null,
			breakdownAvailable: false,
			classificationComplete: false
		}
	}
	const total = Math.max(0, Math.round(parsedTotal))
	const bank = optionalQueryCount(raw, ['bank', 'bank_count'])
	const nonBank = optionalQueryCount(raw, ['non_bank', 'nonBank', 'non_bank_count', 'nonBankCount'])
	const reportedUnknown = optionalQueryCount(raw, ['unknown', 'unknown_count', 'unclassified', 'unclassified_count'])
	if (bank !== null && nonBank !== null) {
		if (bank + nonBank > total || (reportedUnknown !== null && bank + nonBank + reportedUnknown !== total)) {
			return {
				total,
				bank: null,
				nonBank: null,
				non_bank: null,
				unknown: total,
				breakdownAvailable: false,
				classificationComplete: false
			}
		}
		const unknown = reportedUnknown === null ? Math.max(0, total - bank - nonBank) : reportedUnknown
		return {
			total,
			bank,
			nonBank,
			non_bank: nonBank,
			unknown,
			breakdownAvailable: true,
			classificationComplete: unknown === 0 && bank + nonBank === total
		}
	}
	if (
		derivedValue &&
		Math.round(num(derivedValue.total)) === total &&
		derivedValue.breakdownAvailable !== false &&
		Math.round(num(derivedValue.bank) + num(derivedValue.nonBank) + num(derivedValue.unknown)) === total
	) {
		const derivedBank = Math.max(0, Math.round(num(derivedValue.bank)))
		const derivedNonBank = Math.max(0, Math.round(num(derivedValue.nonBank)))
		const derivedUnknown = Math.max(0, Math.round(num(derivedValue.unknown)))
		return {
			total,
			bank: derivedBank,
			nonBank: derivedNonBank,
			non_bank: derivedNonBank,
			unknown: derivedUnknown,
			breakdownAvailable: true,
			classificationComplete: derivedUnknown === 0 && derivedBank + derivedNonBank === total
		}
	}
	return {
		total,
		bank: null,
		nonBank: null,
		non_bank: null,
		unknown: total,
		breakdownAvailable: false,
		classificationComplete: false
	}
}

const deterministicDimensionAliases = {
	totalCreditLine: ['total_credit_line'],
	usedCardLimit: ['used_card_limit', 'total_card_used'],
	cardUtilizationUsed: ['card_utilization_used', 'utilization_used'],
	totalLoanBalance: ['total_loan_balance'],
	availableCredit: ['available_credit'],
	totalDebt: ['total_debt'],
	totalOverdueAmt: ['total_overdue_amt', 'total_overdue_amount'],
	debtRatio: ['debt_ratio'],
	cardUtilizationRate: ['card_utilization_rate', 'usage_rate'],
	cardRawTotalLimit: ['card_raw_total_limit', 'raw_total_limit'],
	cardRawTotalUsed: ['card_raw_total_used', 'raw_total_used'],
	cardUtilizationGroupCount: ['card_utilization_group_count', 'utilization_group_count'],
	cardSharedGroupCount: ['card_shared_group_count', 'shared_group_count'],
	cardForeignCurrencyAccountCount: ['card_foreign_currency_account_count', 'foreign_currency_account_count'],
	overdueCount: ['overdue_count'],
	maxOverdueDays: ['max_overdue_days'],
	m1Count: ['m1_count'],
	m2Count: ['m2_count'],
	m3Count: ['m3_count'],
	q1: ['query_1m', 'last_1m'],
	q3: ['query_3m', 'last_3m'],
	q6: ['query_6m', 'last_6m'],
	q12: ['query_12m', 'last_12m'],
	loanQueryCount: ['loan_query_count'],
	cardQueryCount: ['card_query_count'],
	totalAccountCount: ['total_account_count'],
	activeAccountCount: ['active_account_count'],
	settledAccountCount: ['settled_account_count'],
	creditCardCount: ['credit_card_count'],
	loanCount: ['loan_count'],
	nonBankLoanCount: ['non_bank_loan_count'],
	oldestAccountYears: ['oldest_account_years'],
	avgAccountYears: ['avg_account_years'],
	monthlyPaymentTotal: ['monthly_payment_total'],
	monthlyIncomeRatio: ['monthly_income_ratio']
}

const deterministicBooleanAliases = {
	hasOverdue: ['has_overdue'],
	hasM3Plus: ['has_m3_plus'],
	hasLianSan: ['has_lian_san'],
	hasLeiLiu: ['has_lei_liu'],
	hasPublicRecord: ['has_public_record'],
	isHighRisk: ['is_high_risk'],
	debtRatioExceeds70: ['debt_ratio_exceeds_70']
}

const normalizeDeterministicDimensions = (value) => {
	const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
	const out = {}
	for (const [target, aliases] of Object.entries(deterministicDimensionAliases)) {
		const raw = pickFirst(source, [target, ...aliases])
		const parsed = nonNegativeNumberOrNull(raw)
		if (parsed != null) out[target] = parsed
	}
	for (const [target, aliases] of Object.entries(deterministicBooleanAliases)) {
		const raw = pickFirst(source, [target, ...aliases])
		if (typeof raw === 'boolean') out[target] = raw
		else if (raw === 0 || raw === 1 || raw === '0' || raw === '1') out[target] = Number(raw) === 1
	}
	return out
}

const assertAuthoritativeV2Core = (core, analysisAuthority = getServerAnalysisAuthority(core)) => {
	if (analysisAuthority.authoritative !== true) return
	const loans = core.credit_debt && core.credit_debt.credit_loans
	const cards = core.credit_debt && core.credit_debt.credit_cards
	const summary = core.query_analysis && core.query_analysis.summary
	const primary = core.primary_rule_score
	const required = [
		[core.credit_debt, 'total_debt'],
		[loans, 'total_balance'],
		[cards, 'total_limit'],
		[cards, 'total_used'],
		[cards, 'utilization_used'],
		[cards, 'usage_rate'],
		[cards, 'shared_group_count'],
		[summary && summary.last_1m, 'total'],
		[summary && summary.last_3m, 'total'],
		[summary && summary.last_6m, 'total'],
		[summary && summary.last_12m, 'total'],
		[primary, 'score']
	]
	if (required.every(([value, key]) => hasFiniteOwnNumber(value, key))) return
	const error = new Error('服务端确定性分析结果缺少权威汇总字段，已停止生成报告')
	error.code = 'INCOMPLETE_AUTHORITATIVE_ANALYSIS_RESULT'
	error.authoritativeAnalysisFailure = true
	throw error
}

const unwrapCore = (data) => {
	if (!data || typeof data !== 'object') return {}
	const rootKeys = [
		'analysisResult',
		'analysis_result',
		'result',
		'analysis',
		'payload',
		'data',
		'credit_report_full',
		'creditReportV2',
		'credit_report_v2'
	]
	const pending = [data]
	const seen = new Set()
	let core = {}
	while (pending.length) {
		const candidate = pending.shift()
		if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || seen.has(candidate)) continue
		seen.add(candidate)
		core = { ...core, ...candidate }
		for (const key of rootKeys) pending.push(candidate[key])
	}
	return core
}

// evidence_v2 is an internal audit artifact. It can contain OCR source blocks,
// page manifests and a complete fact ledger, so it must never be copied into
// the Web report's compatibility aliases (which are subsequently persisted).
// The browser only keeps the bounded, non-content metadata needed to identify
// and audit the server-owned result.
const privateEvidenceKeys = new Set([
	'evidencev2',
	'evidencemeta',
	'manifest',
	'documentmanifest',
	'evidencegraph',
	'factledger',
	'derivedanalysis',
	'publicationgate',
	'evidenceblocks',
	'rawevidence',
	'rawevidenceblocks',
	'sourceevidence',
	'sourceevidenceblocks',
	'sourceblocks',
	'sourcetext',
	'rawtext',
	'rawocrtext',
	'ocrtext',
	'matchedquotes'
])

const duplicatedEvidenceHashKeys = new Set([
	'manifesthash',
	'documentmanifesthash',
	'evidencegraphhash',
	'factledgerhash',
	'derivedanalysishash',
	'evidencehash',
	'facthash',
	'metrichash'
])

const normalizeEvidenceKey = (key) => String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase()

const stripPrivateEvidenceArtifacts = (value, seen = new WeakMap()) => {
	if (!value || typeof value !== 'object') return value
	if (seen.has(value)) return seen.get(value)

	if (Array.isArray(value)) {
		const copy = []
		seen.set(value, copy)
		for (const item of value) copy.push(stripPrivateEvidenceArtifacts(item, seen))
		return copy
	}

	const copy = {}
	seen.set(value, copy)
	for (const [key, item] of Object.entries(value)) {
		const normalizedKey = normalizeEvidenceKey(key)
		if (privateEvidenceKeys.has(normalizedKey) || duplicatedEvidenceHashKeys.has(normalizedKey)) continue
		copy[key] = stripPrivateEvidenceArtifacts(item, seen)
	}
	return copy
}

const evidenceObject = (value) => (
	value && typeof value === 'object' && !Array.isArray(value) ? value : {}
)

const firstEvidenceString = (...values) => {
	for (const value of values) {
		if (typeof value !== 'string' && typeof value !== 'number') continue
		const token = String(value).trim()
		if (token) return token
	}
	return undefined
}

const safeEvidenceEnum = (allowed, ...values) => {
	const token = firstEvidenceString(...values)
	return token && allowed.has(token) ? token : undefined
}

const safeEvidenceHash = (prefix, ...values) => {
	const token = firstEvidenceString(...values)
	return token && new RegExp(`^${prefix}_[a-f0-9]{64}$`).test(token) ? token : undefined
}

const safeEvidenceCount = (...values) => {
	for (const value of values) {
		const count = strictNonNegativeIntegerOrNull(value)
		if (count != null && count <= Number.MAX_SAFE_INTEGER) return count
	}
	return undefined
}

// Evidence v2 currently proves only these legacy fields. Keep the list fixed in
// the client so an arbitrary server string cannot become persisted metadata or
// accidentally broaden the field-level authority claim.
const safeEvidenceScope = (...values) => {
	for (const value of values) {
		if (!Array.isArray(value)) continue
		const declared = new Set(value.filter((item) => typeof item === 'string'))
		const safe = AUTHORITATIVE_EVIDENCE_PATHS.filter((path) => declared.has(path))
		if (safe.length) return safe
	}
	return undefined
}

const buildCompactEvidenceMeta = (data, core) => {
	const root = evidenceObject(data)
	const source = evidenceObject(core)
	const declared = evidenceObject(
		source.evidence_meta || source.evidenceMeta || root.evidence_meta || root.evidenceMeta
	)
	const artifacts = evidenceObject(
		source.evidence_v2 || source.evidenceV2 || root.evidence_v2 || root.evidenceV2
	)
	if (!Object.keys(declared).length && !Object.keys(artifacts).length) return null
	const hasArtifacts = Object.keys(artifacts).length > 0

	const manifest = evidenceObject(artifacts.manifest || artifacts.documentManifest || artifacts.document_manifest)
	const graph = evidenceObject(artifacts.evidenceGraph || artifacts.evidence_graph)
	const ledger = evidenceObject(artifacts.factLedger || artifacts.fact_ledger)
	const derived = evidenceObject(artifacts.derivedAnalysis || artifacts.derived_analysis)
	const gate = evidenceObject(artifacts.publicationGate || artifacts.publication_gate)
	const facts = Array.isArray(ledger.facts) ? ledger.facts : []
	const acceptedFactCount = facts.filter((fact) => evidenceObject(fact).status === 'accepted').length
	const contractVersion = String(artifacts.contract || '').includes('/2.') ? 'evidence-v2' : undefined

	const declaredMetadata = {
		version: safeEvidenceEnum(new Set(['evidence-v2']), declared.version),
		status: safeEvidenceEnum(new Set(['publishable', 'blocked']), declared.status),
		manifest_hash: safeEvidenceHash('mh_v2', declared.manifest_hash, declared.manifestHash),
		evidence_hash: safeEvidenceHash('eg_v2', declared.evidence_hash, declared.evidenceHash),
		fact_hash: safeEvidenceHash('fl_v2', declared.fact_hash, declared.factHash),
		metric_hash: safeEvidenceHash('da_v2', declared.metric_hash, declared.metricHash),
		publication_gate: safeEvidenceEnum(
			new Set(['passed', 'blocked']),
			declared.publication_gate,
			declared.publicationGate
		),
		fact_count: safeEvidenceCount(declared.fact_count, declared.factCount),
		supported_fact_count: safeEvidenceCount(
			declared.supported_fact_count,
			declared.supportedFactCount
		)
	}
	const artifactMetadata = {
		version: safeEvidenceEnum(new Set(['evidence-v2']), contractVersion),
		status: safeEvidenceEnum(new Set(['publishable', 'blocked']), artifacts.status),
		manifest_hash: safeEvidenceHash('mh_v2', manifest.manifestHash, manifest.manifest_hash),
		evidence_hash: safeEvidenceHash('eg_v2', graph.evidenceGraphHash, graph.evidence_graph_hash),
		fact_hash: safeEvidenceHash('fl_v2', ledger.factLedgerHash, ledger.fact_ledger_hash),
		metric_hash: safeEvidenceHash('da_v2', derived.derivedAnalysisHash, derived.derived_analysis_hash),
		publication_gate: safeEvidenceEnum(new Set(['passed', 'blocked']), gate.status),
		fact_count: hasArtifacts ? facts.length : undefined,
		supported_fact_count: hasArtifacts ? acceptedFactCount : undefined
	}
	let trustedMetadata = declaredMetadata
	if (hasArtifacts) {
		const requiredArtifactFields = [
			'version', 'status', 'manifest_hash', 'evidence_hash', 'fact_hash',
			'metric_hash', 'publication_gate', 'fact_count', 'supported_fact_count'
		]
		if (requiredArtifactFields.some((key) => artifactMetadata[key] === undefined)) return null
		if (requiredArtifactFields.some((key) => (
			declaredMetadata[key] !== undefined && declaredMetadata[key] !== artifactMetadata[key]
		))) return null
		trustedMetadata = artifactMetadata
	}
	const metadata = {
		...trustedMetadata,
		authoritative_scope: safeEvidenceScope(
			declared.authoritative_scope,
			declared.authoritativeScope
		)
	}

	return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined))
}

const attachCompactEvidenceMeta = (analysis, evidenceMeta) => (
	evidenceMeta && Object.keys(evidenceMeta).length
		? { ...analysis, evidence_meta: evidenceMeta }
		: analysis
)

const buildDimensionSnapshot = (dimensions, overdueRecords, queryRecords) => {
	const dim = dimensions || {}
	const qr = queryRecords || {}
	const debtRatioRaw = nonNegativeNumberOrNull(dim.debtRatio)
	const fieldScopedAuthority = dim.fieldScopedAuthority === true
	const nullableInteger = (value) => {
		const number = nonNegativeNumberOrNull(value)
		return number == null ? null : Math.round(number)
	}
	const nullableBoolean = (value) => typeof value === 'boolean' ? value : null
	return {
		// Canonical debtRatio is always a ratio (totalDebt / totalLine). Values
		// above 1 are valid over-limit ratios, not already-scaled percentages.
		debtRatioPct: debtRatioRaw == null
			? null
			: debtRatioRaw <= 0 ? 0 : Math.round(debtRatioRaw * 10000) / 100,
		debtRatioDecisionEligible: false,
		debtRatioStatus: DEBT_RATIO_DIAGNOSTIC_STATUS,
		overdueCount: nullableInteger(dim.overdueCount) ?? (
			!fieldScopedAuthority && Array.isArray(overdueRecords) && overdueRecords.length > 0
					? overdueRecords.length
					: null
		),
		maxOverdueDays: nonNegativeNumberOrNull(dim.maxOverdueDays),
		m1Count: nullableInteger(dim.m1Count),
		m2Count: nullableInteger(dim.m2Count),
		m3Count: nullableInteger(dim.m3Count),
		hasLianSan: nullableBoolean(dim.hasLianSan),
		hasLeiLiu: nullableBoolean(dim.hasLeiLiu),
		q1: nullableInteger(dim.q1) ?? nullableInteger(qr.recent1Month),
		q3: nullableInteger(dim.q3) ?? nullableInteger(qr.recent3Month),
		q6: nullableInteger(dim.q6) ?? nullableInteger(qr.recent6Month),
		q12: nullableInteger(dim.q12) ?? nullableInteger(qr.recent12Month),
		totalAccountCount: nullableInteger(dim.totalAccountCount),
		nonBankLoanCount: nullableInteger(dim.nonBankLoanCount)
	}
}

/**
 * Flask 后端常返回 LLM 结构化 JSON（与 ai-proxy TEXT_SCHEMA_PROMPT 一致）：
 * { basic_info, debt_summary, overdue_summary, query_records, credit_cards, loan_accounts,
 *   account_overview, public_records, behavior_tags, risk_tags, six_dimensions, risk_level,
 *   suggestion, credit_score_estimate, debt_restructure_feasibility, product_accessibility }
 * 这里把上述字段映射成详情页所需的 dimensions / accounts / overdueRecords / queryRecords。
 */
const buildClientShapeFromLLM = (core) => {
	const ds = core.debt_summary || core.debtSummary || {}
	const os = core.overdue_summary || core.overdueSummary || {}
	const qr = core.query_records || core.queryRecords || {}
	const ao = core.account_overview || core.accountOverview || {}
	const cards = core.credit_cards || core.creditCards || {}
	const loans = core.loan_accounts || core.loanAccounts || {}
	const pub = core.public_records || core.publicRecords || {}
	const hd = core.hidden_debt_analysis || core.hiddenDebtAnalysis || {}
	const bi = core.basic_info || core.basicInfo || {}

	const totalCreditLine = nonNegativeNumberOrNull(ds.total_credit ?? ds.totalCredit ?? ds.total_credit_line ?? ds.totalCreditLine ?? ao.total_credit)
	const totalDebt = nonNegativeNumberOrNull(ds.total_debt ?? ds.totalDebt)
	const debtRatio = (() => {
		const explicitPct = ds.debt_ratio_pct ?? ds.debtRatioPct ?? ds.ratio_pct
		const pct = nonNegativeNumberOrNull(explicitPct)
		if (pct != null) {
			return pct / 100
		}
		const explicitRatio = ds.debt_ratio ?? ds.debtRatio
		const ratio = nonNegativeNumberOrNull(explicitRatio)
		if (ratio != null) {
			return ratio
		}
		return totalCreditLine > 0 && totalDebt != null ? Math.max(0, totalDebt / totalCreditLine) : null
	})()
	const cardUseRate = (() => {
		const raw = nonNegativeNumberOrNull(cards.usage_rate_pct ?? cards.usageRatePct)
		if (raw != null) return raw > 1 ? Math.min(raw / 100, 1) : Math.min(raw, 1)
		const ratio = nonNegativeNumberOrNull(cards.usage_rate ?? cards.usageRate)
		return ratio == null ? null : Math.min(ratio, 1)
	})()
	const cardOverdueCount = nonNegativeNumberOrNull(cards.overdue_count ?? cards.overdueCount)
	const loanOverdueCount = nonNegativeNumberOrNull(loans.overdue_count ?? loans.overdueCount)
	const accountOverdueCount = cardOverdueCount != null && loanOverdueCount != null
		? cardOverdueCount + loanOverdueCount
		: (cardOverdueCount > 0 ? cardOverdueCount : loanOverdueCount > 0 ? loanOverdueCount : null)
	const overdueCount = maxKnownNonNegative(
		os.total_overdue_count ?? os.totalOverdueCount ?? os.count,
		os.current_overdue_count ?? os.currentOverdueCount,
		accountOverdueCount
	)
	const nonBankLoanCount = maxKnownNonNegative(
		hd.consumer_finance_count ?? hd.consumerFinanceCount,
		loans.non_bank_count ?? loans.nonBankCount,
		Array.isArray(loans.non_bank_loans) && loans.non_bank_loans.length > 0 ? loans.non_bank_loans.length : null
	)

	const dimensions = {
		totalCreditLine,
		usedCardLimit: nonNegativeNumberOrNull(cards.used_amount ?? cards.usedAmount),
		totalLoanBalance: nonNegativeNumberOrNull(loans.total_balance ?? loans.totalBalance ?? ds.total_loan_balance),
		availableCredit: nonNegativeNumberOrNull(ds.available_credit ?? ds.availableCredit),
		totalDebt,
		totalOverdueAmt: nonNegativeNumberOrNull(os.total_overdue_amount ?? os.totalOverdueAmount),

		debtRatio,
		cardUtilizationRate: cardUseRate,
		overdueCount,
		maxOverdueDays: nonNegativeNumberOrNull(os.max_overdue_days ?? os.maxOverdueDays),
		m1Count: nonNegativeNumberOrNull(os.m1_count ?? os.m1Count),
		m2Count: nonNegativeNumberOrNull(os.m2_count ?? os.m2Count),
		m3Count: nonNegativeNumberOrNull(os.m3_count ?? os.m3Count ?? os.m3plus_count),
		hasLianSan: booleanOrNull(os.has_lian_san ?? os.hasLianSan ?? os.consecutive_three),
		hasLeiLiu: booleanOrNull(os.has_lei_liu ?? os.hasLeiLiu ?? os.cumulative_six),
		hasPublicRecord: Array.isArray(pub.items) && pub.items.length > 0 ? true : booleanOrNull(pub.has_record ?? pub.hasRecord),

		q1: nonNegativeNumberOrNull(qr.recent_1_month ?? qr.recent1Month ?? qr.last1m_count),
		q3: nonNegativeNumberOrNull(qr.recent_3_month ?? qr.recent3Month ?? qr.last3m_count),
		q6: nonNegativeNumberOrNull(qr.recent_6_month ?? qr.recent6Month ?? qr.last6m_count),
		q12: nonNegativeNumberOrNull(qr.recent_12_month ?? qr.recent12Month ?? qr.last12m_count),
		loanQueryCount: nonNegativeNumberOrNull(qr.loan_query_count ?? qr.loanQueryCount),
		cardQueryCount: nonNegativeNumberOrNull(qr.card_query_count ?? qr.cardQueryCount),

		totalAccountCount: nonNegativeNumberOrNull(ao.total_count ?? ao.totalCount),
		activeAccountCount: nonNegativeNumberOrNull(ao.active_count ?? ao.activeCount),
		settledAccountCount: nonNegativeNumberOrNull(ao.settled_count ?? ao.settledCount),
		creditCardCount: nonNegativeNumberOrNull(cards.count ?? cards.total_count),
		loanCount: nonNegativeNumberOrNull(loans.count ?? loans.total_count),
		nonBankLoanCount,
		oldestAccountYears: nonNegativeNumberOrNull(ao.oldest_account_years ?? ao.oldestAccountYears),
		avgAccountYears: nonNegativeNumberOrNull(ao.avg_account_years ?? ao.avgAccountYears),

		monthlyPaymentTotal: nonNegativeNumberOrNull(ds.monthly_payment ?? ds.monthlyPayment),
		monthlyIncomeRatio: null
	}
	dimensions.hasOverdue = dimensions.overdueCount == null ? null : dimensions.overdueCount > 0
	dimensions.hasM3Plus = dimensions.m3Count == null ? null : dimensions.m3Count > 0
	const highRiskSignals = [dimensions.hasLianSan, dimensions.hasLeiLiu, dimensions.hasM3Plus, dimensions.hasPublicRecord]
	dimensions.isHighRisk = highRiskSignals.some((value) => value === true)
		? true
		: highRiskSignals.every((value) => value === false) ? false : null
	markDebtRatioDiagnosticOnly(dimensions)

	// accounts：把 cards.list / loans.list 拍平为统一对象数组（详情页用）
	const flattenList = (raw, isLoan) => {
		const list = Array.isArray(raw) ? raw : (Array.isArray(raw && raw.list) ? raw.list : [])
		return list.map((it) => {
			const x = it || {}
			const institutionKind = accountInstitutionKind(x)
			const status = statusTextOrEmpty(x.status)
			const overdueDays = nonNegativeNumberOrNull(x.overdue_days ?? x.overdueDays)
			const overdueFlags = accountOverdueFlags(x, x.status || '', overdueDays)
			return {
				bank: x.bank || x.institution || x.name || '',
				institutionKind,
				institution_type: institutionKind,
				accountType: x.account_type || x.accountType || (isLoan ? '贷款' : '贷记卡'),
				isLoan,
				limit: firstNonNegativeNumberOrNull(x.limit, x.credit_limit, x.amount, x.loan_amount),
				balance: firstNonNegativeNumberOrNull(x.balance, x.used_amount, x.loan_balance),
				loanAmount: isLoan ? firstNonNegativeNumberOrNull(x.loan_amount, x.amount, x.limit) : null,
				status: status || null,
				openDate: x.open_date || x.openDate || '',
				endDate: x.end_date || x.endDate || x.settle_date || '',
				isSettled: typeof (x.is_settled ?? x.isSettled) === 'boolean'
					? (x.is_settled ?? x.isSettled)
					: statusIndicatesSettled(status) ? true : statusIndicatesActiveUnsettled(status) ? false : null,
				repayRecord: x.repay_record || x.repayRecord || '',
				monthlyPayment: nonNegativeNumberOrNull(x.monthly_payment ?? x.monthlyPayment),
				overdueDays,
				overdueAmount: nonNegativeNumberOrNull(x.overdue_amount ?? x.overdueAmount),
				overdueLevel: x.overdue_level || x.overdueLevel || (overdueDays == null ? 'unknown' : overdueDays > 60 ? 'M3+' : overdueDays > 30 ? 'M2' : overdueDays > 0 ? 'M1' : 'none'),
				isOverdue: overdueFlags.overdueKnown ? overdueFlags.overdue : null,
				isAbnormal: overdueFlags.abnormalKnown ? overdueFlags.abnormal : null
			}
		})
	}
	const accounts = [
		...flattenList(cards.list || cards, false),
		...flattenList(loans.list || loans, true)
	]

	const overdueRecords = (() => {
		const list = Array.isArray(os.records) ? os.records : (Array.isArray(os.list) ? os.list : [])
		if (list.length > 0) {
			return list.map((x) => ({
				bank: x.bank || x.institution || '',
				accountType: x.account_type || x.accountType || '',
				amount: nonNegativeNumberOrNull(x.amount ?? x.overdue_amount),
				days: nonNegativeNumberOrNull(x.days ?? x.overdue_days),
				level: x.level || (() => {
					const days = nonNegativeNumberOrNull(x.days ?? x.overdue_days)
					return days == null ? 'unknown' : days > 60 ? 'M3+' : days > 30 ? 'M2' : days > 0 ? 'M1' : 'none'
				})(),
				date: x.date || x.overdue_date || ''
			}))
		}
		return accounts.filter((a) => a.isOverdue).map((a) => ({
			bank: a.bank, accountType: a.accountType, amount: nonNegativeNumberOrNull(a.overdueAmount),
			days: a.overdueDays, level: a.overdueLevel, date: ''
		}))
	})()

	const queryRecords = {
		recent1Month: dimensions.q1,
		recent3Month: dimensions.q3,
		recent6Month: dimensions.q6,
		recent12Month: dimensions.q12,
		details: Array.isArray(qr.details) ? qr.details : (Array.isArray(qr.items) ? qr.items : []),
		queryItems: Array.isArray(qr.items) ? qr.items : (Array.isArray(qr.details) ? qr.details : [])
	}

	const publicRecords = {
		hasRecord: dimensions.hasPublicRecord,
		items: Array.isArray(pub.items) ? pub.items : []
	}

	const consecutiveOverdue = {
		hasLianSan: dimensions.hasLianSan,
		hasLeiLiu: dimensions.hasLeiLiu,
		triggered: dimensions.hasLianSan || dimensions.hasLeiLiu,
		details: []
	}

	const basicInfo = {
		name: bi.name || '',
		idCard: bi.id_card || bi.idCard || '',
		phone: bi.phone || '',
		reportDate: bi.report_date || bi.reportDate || '',
		address: bi.address || ''
	}

	return { dimensions, accounts, overdueRecords, queryRecords, publicRecords, consecutiveOverdue, basicInfo }
}

/** 决策树式 → 改善建议（与本地 aiAnalysis 风格保持一致） */
const buildSuggestionsFromDim = (dim, suggestionText, riskTags) => {
	const out = []
	// 手写千分位（至多 2 位小数，去尾随 0），避免 toLocaleString 在缺 ICU 的 JS 引擎上退化/抛错
	const fmt = (n) => {
		const v = num(n)
		const neg = v < 0
		const fixed = Math.abs(v).toFixed(2).replace(/\.?0+$/, '')
		const parts = fixed.split('.')
		const grouped = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
		return (neg ? '-' : '') + grouped + (parts[1] ? '.' + parts[1] : '')
	}
	if (dim.hasOverdue) {
		const overdueAmount = nonNegativeNumberOrNull(dim.totalOverdueAmt)
		out.push({
			title: '立即核对并处理逾期款项',
			desc: overdueAmount == null
				? '当前存在逾期记录，逾期金额待核对；请先结合原始报告确认后处理。'
				: `当前逾期金额 ${fmt(overdueAmount)} 元，还清后逾期状态将在下期更新`,
			priority: 'high',
			effect: '可在 1-3 个月内提升还款记录评分',
			trigger: 'overdue'
		})
	}
	if (dim.debtRatioExceeds70) {
		out.push({ title: '降低综合负债率', desc: `当前负债率 ${(dim.debtRatio * 100).toFixed(0)}%，建议优先还清信用卡`, priority: 'high', effect: '负债率降至 50% 可显著提升匹配产品数量', trigger: 'high_debt' })
	}
	if (dim.q1 > 3) {
		out.push({ title: '停止新增信用查询', desc: `近 1 月查询 ${dim.q1} 次，过多查询会被识别为资金需求迫切`, priority: 'medium', effect: '暂停 3 个月可显著恢复', trigger: 'high_query' })
	}
	if (dim.cardUtilizationRate > 0.5) {
		out.push({ title: '降低信用卡使用率', desc: `当前 ${(dim.cardUtilizationRate * 100).toFixed(0)}%，建议控制在 50% 以下`, priority: 'medium', effect: '降至 30% 以下可提升 10-15 分', trigger: 'high_utilization' })
	}
	if (Array.isArray(riskTags) && riskTags.length > 0) {
		out.push({ title: 'AI 风险标签', desc: `识别到：${riskTags.slice(0, 5).join('、')}`, priority: 'medium', effect: '请结合下方建议逐项优化', trigger: 'ai_tags' })
	}
	if (suggestionText && String(suggestionText).trim().length > 4) {
		out.push({ title: 'AI 专业建议', desc: String(suggestionText).trim(), priority: 'medium', effect: '', source: 'ai', trigger: 'ai_suggestion' })
	}
	return out
}

const buildKeyFindingsFromDim = (dim) => {
	const out = []
	if (dim.hasLianSan) out.push('连续 3 期逾期（连三），已触发银行核心风控红线')
	if (dim.hasLeiLiu) out.push('累计 6 期逾期（累六），多数银行将永久拒绝申请')
	if (dim.m3Count > 0) out.push(`存在 M3+ 严重逾期 ${dim.m3Count} 个，需立即处理`)
	if (dim.hasPublicRecord) out.push('存在公共记录（法院/税务），属最高级风险标记')
	if (dim.cardUtilizationRate > 0.8) out.push(`信用卡使用率 ${(dim.cardUtilizationRate * 100).toFixed(0)}%，循环利息消耗大`)
	if (dim.q6 > 12) out.push(`近半年查询 ${dim.q6} 次，存在以贷养贷特征`)
	if (out.length === 0) {
		const nonScopedRiskKnown = [
			dim.hasLianSan,
			dim.hasLeiLiu,
			dim.hasPublicRecord,
			dim.m3Count,
			dim.overdueCount
		].every((value) => value !== null && value !== undefined)
		out.push(nonScopedRiskKnown
			? '未发现已核验的核心风险点'
			: '逾期、公共记录等核心风险字段待核对')
	}
	return out
}

const scoresFromServer = (core, reportScores) => {
	// v5：四维评分（移除 偿债能力 / 负债比例）。服务端若仍返回旧字段也不再回填。
	const zhKeys = ['信用历史', '查询频率', '账户结构', '还款记录']
	const enMap = {
		credit_history: '信用历史',
		query_frequency: '查询频率',
		account_structure: '账户结构',
		repayment_record: '还款记录'
	}
	let dimExtra = pickFirst(core, ['dimension_scores', 'dimensionScores'])
	if (dimExtra && typeof dimExtra !== 'object') dimExtra = null
	const src =
		reportScores ||
		core.scores ||
		core.six_dimensions ||
		core.sixDimensions ||
		dimExtra ||
		{}

	const out = {}
	for (const k of Object.keys(src)) {
		if (k === 'repayment_ability' || k === 'debt_ratio' || k === '偿债能力' || k === '负债比例') continue
		out[k] = src[k]
	}
	const fill = (en, zh, ...aliases) => {
		let v = pickFirst(src, [en, zh, ...aliases])
		if (v == null && core.six_dimensions && typeof core.six_dimensions === 'object') {
			v = core.six_dimensions[zh] ?? core.six_dimensions[en]
		}
		if (typeof v === 'number' && Number.isFinite(v)) {
			out[en] = Math.round(v)
			out[zh] = Math.round(v)
		}
	}
	fill('credit_history', '信用历史')
	fill('query_frequency', '查询频率')
	fill('account_structure', '账户结构')
	fill('repayment_record', '还款记录')

	for (const zh of zhKeys) {
		if (out[zh] == null && typeof src[zh] === 'number') out[zh] = Math.round(src[zh])
	}
	for (const [en, zh] of Object.entries(enMap)) {
		if (out[en] == null && typeof out[zh] === 'number') out[en] = out[zh]
		if (out[zh] == null && typeof out[en] === 'number') out[zh] = out[en]
	}
	return out
}

/**
 * 形态 C：旧版 Python 分析服务（build_response 输出）专属 schema：
 *   {
 *     basic_info: { name, id_last4, report_time, marriage },
 *     summary_cards: [{ title, value }, ...],
 *     risk_level: '极低|低|中|高|极高',
 *     suggestions: '...',
 *     details: {
 *       basic_info: { ... },
 *       credit_summary: {
 *         credit_cards: { active, total, overdue_count, overdue_90_days, total_used_limit, sample_high_usage },
 *         loans: { active, total, overdue_count, mortgage, consumer_loans, total_debt, monthly_repay_estimate }
 *       },
 *       query_records: { last_2_years: { total_queries, loan_approval, credit_card_approval, post_loan_management, self_query, density_analysis } },
 *       risk_assessment: { overall_level, score, pros, cons, recommendation },
 *       behavior_patterns: { card_usage_pattern, consumption_loan_频率, debt_structure }
 *     }
 *   }
 *
 * 字段名与本地 dimensions 完全不同，必须显式翻译；否则会出现"评分 0、信贷账户 0"的现象。
 */
const looksLikeLegacyPython = (core) =>
	core && typeof core === 'object' &&
	core.details && typeof core.details === 'object' &&
	(core.summary_cards !== undefined || core.suggestions !== undefined) &&
	(core.details.credit_summary || core.details.risk_assessment || core.details.query_records)

/**
 * 形态 D：ai-proxy 10 模块 V2 schema（与 TEXT_SCHEMA_PROMPT / runCreditRuleEngine 对齐）：
 *   { meta, basic_info, risk_analysis, credit_debt, other_debts, overdue_info,
 *     query_analysis, loan_details, credit_card_details, loan_history, assessment,
 *     six_dimensions, risk_tags, frontend_payload, ... }
 *
 * 旧 mapper 只识别 Flask 后端 debt_summary/credit_cards/loan_accounts 那一套 snake_case 顶层字段，
 * 所以拿到 V2 时所有维度全是 0。这里直接按 V2 字段构建客户端形状，保证详情页拿到非 0 数据。
 */
const looksLikeCreditReportV2 = (core) =>
	core && typeof core === 'object' &&
	(
		(core.meta && core.credit_debt) ||
		(Array.isArray(core.credit_card_details) && core.credit_card_details.length > 0) ||
		(core.loan_details && (Array.isArray(core.loan_details.bank_loans) || Array.isArray(core.loan_details.non_bank_loans))) ||
		(core.query_analysis && (core.query_analysis.summary || Array.isArray(core.query_analysis.query_details))) ||
		(core.frontend_payload && core.frontend_payload.header)
	)

const yyyymmddToOpenDate = (raw) => {
	if (!raw) return ''
	const s = String(raw).trim()
	if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
	const m = s.match(/(\d{4})[./-]?(\d{1,2})[./-]?(\d{1,2})/)
	if (m) {
		const yy = m[1]
		const mm = String(m[2]).padStart(2, '0')
		const dd = String(m[3]).padStart(2, '0')
		return `${yy}-${mm}-${dd}`
	}
	return ''
}

const buildLoanAccountFromV2Row = (r, isBank) => {
	const status = statusTextOrEmpty(r.status)
	const isSettled = statusIndicatesSettled(status)
		? true
		: statusIndicatesActiveUnsettled(status) ? false : null
	const overdueDays = nonNegativeNumberOrNull(r.overdue_days)
	const overdueAmount = nonNegativeNumberOrNull(r.overdue_amount)
	const institutionKind = accountInstitutionKind(r, isBank ? 'bank' : 'non_bank')
	const overdueFlags = accountOverdueFlags(r, status, overdueDays)
	return {
		bank: r.institution || (isBank ? '银行' : '非银机构'),
		institutionKind,
		institution_type: institutionKind,
		accountType: r.type || (isBank ? '银行贷款' : '消费贷款'),
		isLoan: true,
		limit: firstNonNegativeNumberOrNull(r.credit_limit, r.amount),
		balance: nonNegativeNumberOrNull(r.balance),
		loanAmount: firstNonNegativeNumberOrNull(r.credit_limit, r.amount, r.balance),
		status: status || null,
		openDate: yyyymmddToOpenDate(r.start_date),
		endDate: yyyymmddToOpenDate(r.end_date),
		isSettled,
		repayRecord: r.repay_record || '',
		monthlyPayment: nonNegativeNumberOrNull(r.monthly_payment),
		overdueDays,
		overdueAmount,
		overdueLevel: overdueDays == null ? 'unknown' : overdueDays > 60 ? 'M3+' : overdueDays > 30 ? 'M2' : overdueDays > 0 ? 'M1' : 'none',
		isOverdue: overdueFlags.overdueKnown ? overdueFlags.overdue : null,
		isAbnormal: overdueFlags.abnormalKnown ? overdueFlags.abnormal : null
	}
}

const buildCardAccountFromV2Row = (c, utilizationDecision = {}) => {
	const status = statusTextOrEmpty(c.status)
	const isSettled = statusIndicatesSettled(status)
		? true
		: statusIndicatesActiveUnsettled(status) ? false : null
	const overdueDays = nonNegativeNumberOrNull(c.overdue_days)
	const institutionKind = accountInstitutionKind(c)
	const overdueFlags = accountOverdueFlags(c, status, overdueDays)
	return {
		bank: c.institution || '发卡行',
		institutionKind,
		institution_type: institutionKind,
		accountType: c.type || c.account_type || c.accountType || '贷记卡',
		isLoan: false,
		limit: nonNegativeNumberOrNull(c.credit_limit),
		balance: nonNegativeNumberOrNull(c.used_limit),
		loanAmount: null,
		status: status || null,
		openDate: yyyymmddToOpenDate(c.start_date),
		endDate: yyyymmddToOpenDate(c.end_date),
		isSettled,
		repayRecord: c.repay_record || '',
		monthlyPayment: null,
		overdueDays,
		overdueAmount: nonNegativeNumberOrNull(c.overdue_amount),
		overdueLevel: overdueDays == null ? 'unknown' : overdueDays > 60 ? 'M3+' : overdueDays > 30 ? 'M2' : overdueDays > 0 ? 'M1' : 'none',
		isOverdue: overdueFlags.overdueKnown ? overdueFlags.overdue : null,
		isAbnormal: overdueFlags.abnormalKnown ? overdueFlags.abnormal : null,
		installment: nonNegativeNumberOrNull(c.installment),
		currency: c.currency || utilizationDecision.currency || '',
		cardTail: c.card_tail || c.cardTail || '',
		sharedCreditGroup: c.shared_credit_group || c.sharedCreditGroup || '',
		utilizationIncluded: utilizationDecision.status === 'included'
			? true
			: utilizationDecision.status === 'excluded' ? false : undefined,
		utilizationStatus: utilizationDecision.status || 'unknown',
		utilizationGroup: c.utilization_group || utilizationDecision.groupKey || '',
		utilizationNote: c.utilization_note || utilizationDecision.reason || ''
	}
}

const objectValue = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {}

const nonEmptyAlias = (sources, aliases) => {
	for (const source of sources) {
		for (const alias of aliases) {
			const value = source && source[alias]
			if (value !== undefined && value !== null && String(value).trim() !== '') return value
		}
	}
	return ''
}

const cleanIdentityLast4 = (value) => {
	const normalized = String(value == null ? '' : value).replace(/[^\dXx]/g, '').toUpperCase()
	return normalized.length >= 4 ? normalized.slice(-4) : ''
}

/**
 * 仅从服务端已约定的身份信息容器取值，避免在账户/机构明细中误把通用 name 字段当作报告姓名。
 * 输出统一的 camelCase 字段，同时保留 id_last4 供旧缓存与旧详情页读取。
 */
export const normalizeServerBasicInfo = (core = {}, fallback = {}) => {
	const trustedRoots = []
	const seen = new Set()
	const addRoot = (value) => {
		const obj = objectValue(value)
		if (!Object.keys(obj).length || seen.has(obj)) return
		seen.add(obj)
		trustedRoots.push(obj)
	}

	addRoot(core)
	for (const key of [
		'report', 'details', 'frontendPayload', 'frontend_payload',
		'creditReportV2', 'credit_report_v2', 'credit_report_full',
		'analysisData', 'analysisResult', 'analysis_result', 'result', 'analysis', 'payload', 'data'
	]) addRoot(core && core[key])
	for (const root of [...trustedRoots]) {
		for (const key of ['report', 'details', 'frontendPayload', 'frontend_payload', 'analysisData']) {
			addRoot(root && root[key])
		}
	}

	const sources = []
	for (const root of trustedRoots) {
		for (const key of ['basicInfo', 'basic_info', 'personalInfo', 'personal_info']) {
			const candidate = objectValue(root[key])
			if (Object.keys(candidate).length) sources.push(candidate)
		}
	}
	for (const root of trustedRoots) {
		for (const frontend of [root.frontendPayload, root.frontend_payload]) {
			const header = objectValue(frontend && frontend.header)
			if (Object.keys(header).length) sources.push(header)
		}
	}
	const fallbackInfo = objectValue(fallback)
	if (Object.keys(fallbackInfo).length) sources.push(fallbackInfo)

	const name = String(nonEmptyAlias(sources, [
		'name', 'real_name', 'realName', 'customer_name', 'customerName',
		'user_name', 'userName', 'client_name', 'clientName', '姓名'
	]) || '').trim()
	const idCard = String(nonEmptyAlias(sources, [
		'idCard', 'id_card', 'idNo', 'id_no', 'idNumber', 'id_number',
		'identityNo', 'identity_no', 'certificateNo', 'certificate_no',
		'certNo', 'cert_no', 'credentialNo', 'credential_no', '身份证号', '证件号码'
	]) || '').trim()
	const explicitLast4 = nonEmptyAlias(sources, [
		'idLast4', 'id_last4', 'identityLast4', 'identity_last4',
		'certificateLast4', 'certificate_last4', '身份证尾号', '证件尾号'
	])
	const idLast4 = cleanIdentityLast4(explicitLast4) || cleanIdentityLast4(idCard)
	const reportDate = String(nonEmptyAlias(sources, [
		'reportDate', 'report_date', 'reportTime', 'report_time', 'queryDate', 'query_date', '报告时间'
	]) || '').trim()

	return {
		...fallbackInfo,
		name,
		idCard,
		idLast4,
		id_last4: idLast4,
		reportDate: reportDate || String(fallbackInfo.reportDate || fallbackInfo.report_date || '').trim(),
		phone: String(nonEmptyAlias(sources, ['phone', 'mobile', '手机号']) || fallbackInfo.phone || '').trim(),
		address: String(nonEmptyAlias(sources, ['address', 'address_city', '居住地址']) || fallbackInfo.address || '').trim(),
		marriage: String(nonEmptyAlias(sources, ['marriage', 'marital_status', '婚姻状况']) || fallbackInfo.marriage || '').trim(),
		occupation: String(nonEmptyAlias(sources, ['occupation', '职业']) || fallbackInfo.occupation || '').trim(),
		employer: String(nonEmptyAlias(sources, ['employer', 'company', '单位名称']) || fallbackInfo.employer || '').trim()
	}
}

const buildClientShapeFromV2 = (core, analysisAuthority = getServerAnalysisAuthority(core)) => {
	const authoritative = analysisAuthority.authoritative === true
	assertAuthoritativeV2Core(core, analysisAuthority)
	const cd = core.credit_debt || {}
	const cl = cd.credit_loans || {}
	const cc = cd.credit_cards || {}
	const ld = core.loan_details || {}
	const cardDetailsKnown = Array.isArray(core.credit_card_details)
	const cardDetails = Array.isArray(core.credit_card_details) ? core.credit_card_details : []
	const cardAccountDetails = cardDetails.filter((card) => {
		const explicitSettled = booleanOrNull(card && (card.is_settled ?? card.isSettled))
		const status = statusTextOrEmpty(card && card.status)
		return explicitSettled !== true && !statusIndicatesSettled(status) && !isCancelledCardRow(card)
	})
	const activeCardDetails = cardAccountDetails.filter((card) => {
		const explicitSettled = booleanOrNull(card && (card.is_settled ?? card.isSettled))
		return explicitSettled === false || statusIndicatesActiveUnsettled(statusTextOrEmpty(card && card.status))
	})
	const bankLoansKnown = Array.isArray(ld.bank_loans)
	const nonBankLoansKnown = Array.isArray(ld.non_bank_loans)
	const bankLoans = Array.isArray(ld.bank_loans) ? ld.bank_loans : []
	const nonBankLoans = Array.isArray(ld.non_bank_loans) ? ld.non_bank_loans : []
	const cardAmountEvidenceComplete = cardDetailsKnown &&
		activeCardDetails.length > 0 &&
		activeCardDetails.length === cardAccountDetails.length &&
		activeCardDetails.every((row) => (
		nonNegativeNumberOrNull(row && row.credit_limit) != null &&
		nonNegativeNumberOrNull(row && row.used_limit) != null
		))
	const cardUtilization = cardAmountEvidenceComplete
		? summarizeCreditCardUtilization(activeCardDetails)
		: {
			decisionEligible: false,
			status: 'unknown',
			totalUsed: null,
			cardOutstanding: null,
			totalLimit: null,
			rawTotalLimit: null,
			rawTotalUsed: null,
			usageRate: null,
			utilizationGroupCount: 0,
			sharedGroupCount: 0,
			inferredSharedGroupCount: 0,
			foreignAccountCount: 0,
			unknownAccountCount: cardAccountDetails.length,
			excludedAccountCount: 0,
			rowDecisions: []
		}
	const cardUtilizationEligible = cardUtilization.decisionEligible === true && cardUtilization.status !== 'unknown'
	const utilizationDecisionByCard = new Map(cardUtilization.rowDecisions.map((item) => [activeCardDetails[item.index], item]))

	const accounts = [
		...bankLoans.map((r) => buildLoanAccountFromV2Row(r, true)),
		...nonBankLoans.map((r) => buildLoanAccountFromV2Row(r, false)),
		...cardAccountDetails.map((c) => buildCardAccountFromV2Row(c, utilizationDecisionByCard.get(c)))
	]

	const utilizationUsedFromCards = cardUtilization.totalUsed
	const outstandingFromCards = cardUtilization.cardOutstanding
	const limitFromCards = cardUtilization.totalLimit
	const balanceFromBankLoans = sumKnownRows(bankLoans, (row) => row.balance, bankLoansKnown)
	const balanceFromNonBankLoans = sumKnownRows(nonBankLoans, (row) => row.balance, nonBankLoansKnown)
	const balanceFromLoans = balanceFromBankLoans != null && balanceFromNonBankLoans != null
		? balanceFromBankLoans + balanceFromNonBankLoans
		: null
	const creditFromBankLoans = sumKnownRows(bankLoans, (row) => row.credit_limit ?? row.amount, bankLoansKnown)
	const creditFromNonBankLoans = sumKnownRows(nonBankLoans, (row) => row.credit_limit ?? row.amount, nonBankLoansKnown)
	const loanCreditFromList = creditFromBankLoans != null && creditFromNonBankLoans != null
		? creditFromBankLoans + creditFromNonBankLoans
		: null
	const hasLoanDetails = bankLoans.length + nonBankLoans.length > 0
	const hasCardDetails = activeCardDetails.length > 0
	const existingCardLimit = nonNegativeNumberOrNull(cc.total_limit)
	const existingCardUsed = nonNegativeNumberOrNull(cc.total_used)
	const existingUtilizationUsed = Object.prototype.hasOwnProperty.call(cc, 'utilization_used')
		? nonNegativeNumberOrNull(cc.utilization_used)
		: null
	const subtotalBankBalance = nonNegativeNumberOrNull(ld.subtotal_bank && ld.subtotal_bank.balance)
	const subtotalNonBankBalance = nonNegativeNumberOrNull(ld.subtotal_non_bank && ld.subtotal_non_bank.balance)
	const subtotalLoanBalance = subtotalBankBalance != null && subtotalNonBankBalance != null
		? subtotalBankBalance + subtotalNonBankBalance
		: null
	const serverLoanBalance = firstNonNegativeNumberOrNull(
		cl.total_balance,
		cl.balance,
		ld.total && ld.total.balance,
		subtotalLoanBalance,
		cl.total_amount
	)
	const serverLoanCredit = firstNonNegativeNumberOrNull(
		cl.total_credit_limit,
		cl.total_credit,
		ld.total && ld.total.credit_limit,
		cl.total_amount
	)

	const fallbackCardLimit = existingCardLimit ?? cardUtilization.rawTotalLimit
	const fallbackCardUsed = existingCardUsed ?? cardUtilization.rawTotalUsed
	const totalCardLimit = authoritative
		? existingCardLimit
		: (cardDetailsKnown && hasCardDetails
			? (cardUtilizationEligible ? limitFromCards : fallbackCardLimit)
			: existingCardLimit)
	const totalCardUsed = authoritative
		? existingCardUsed
		: (cardDetailsKnown && hasCardDetails
			? (cardUtilizationEligible ? outstandingFromCards : fallbackCardUsed)
			: existingCardUsed)
	const cardUtilizationUsed = authoritative
		? (existingUtilizationUsed == null
			? Math.max(0, nonNegativeNumberOrNull(cc.usage_rate) * totalCardLimit)
			: existingUtilizationUsed)
		: (cardDetailsKnown && hasCardDetails && cardUtilizationEligible
			? utilizationUsedFromCards
			: (nonNegativeNumberOrNull(cc.usage_rate) != null && totalCardLimit != null
				? Math.max(0, nonNegativeNumberOrNull(cc.usage_rate) * totalCardLimit)
				: null))
	const totalLoanBalance = authoritative
		? serverLoanBalance
		: (bankLoansKnown && nonBankLoansKnown)
			? balanceFromLoans
			: serverLoanBalance
	const totalLoanCredit = authoritative
		? null
		: (bankLoansKnown && nonBankLoansKnown && loanCreditFromList != null)
			? loanCreditFromList
			: (serverLoanCredit ?? totalLoanBalance)

	const totalDebt = authoritative
		? nonNegativeNumberOrNull(cd.total_debt)
		: (totalLoanBalance != null && totalCardUsed != null && (bankLoansKnown && nonBankLoansKnown) && cardAmountEvidenceComplete)
			? totalLoanBalance + totalCardUsed
			: nonNegativeNumberOrNull(cd.total_debt)
	const totalCreditLine = authoritative
		? nonNegativeNumberOrNull(cd.total_credit_line ?? cd.total_credit)
		: (totalLoanCredit != null && totalCardLimit != null
			? totalLoanCredit + totalCardLimit
			: firstNonNegativeNumberOrNull(cd.total_credit_line, cd.total_credit))

	// Canonical debt_ratio is a ratio, including valid values above 1. Never
	// infer a percentage unit from the numeric magnitude.
	const declaredDebtRatio = authoritative ? nonNegativeNumberOrNull(cd.debt_ratio) : null
	const debtRatio = declaredDebtRatio == null ? null : Math.max(0, declaredDebtRatio)

	let cardUseRate = nonNegativeNumberOrNull(cc.usage_rate)
	// Legacy compatibility payloads sometimes used percentages (for example
	// 94.67). The authoritative deterministic contract always uses a ratio and
	// may legitimately exceed 1 when an account is over its limit.
	if (!authoritative && cardUseRate != null && cardUseRate > 1) cardUseRate = cardUseRate / 100
	if (!authoritative && cardDetailsKnown && hasCardDetails) {
		cardUseRate = cardUtilizationEligible ? cardUtilization.usageRate : null
	} else if (!authoritative && cardUseRate == null && totalCardLimit > 0 && totalCardUsed != null) {
		cardUseRate = totalCardUsed / totalCardLimit
	}

	const ov = core.overdue_info || {}
	const ovDetailsKnown = Array.isArray(ov.details)
	const ovDetails = Array.isArray(ov.details) ? ov.details : []
	const overdueLevelCount = (lvl) => ovDetails.filter((d) => String(d.level || d.overdue_level).toUpperCase() === lvl).length
	const m1Count = authoritative ? null : (nonNegativeNumberOrNull(ov.m1_count) ?? (ovDetails.length ? overdueLevelCount('M1') : null))
	const m2Count = authoritative ? null : (nonNegativeNumberOrNull(ov.m2_count) ?? (ovDetails.length ? overdueLevelCount('M2') : null))
	const m3Count = authoritative
		? null
		: (nonNegativeNumberOrNull(ov.m3_plus_count ?? ov.m3_count) ?? (ovDetails.length ? ovDetails.filter((d) => {
			const lv = String(d.level || d.overdue_level || '').toUpperCase()
			return lv === 'M3+' || lv === 'M3' || lv === 'M4' || lv === 'M5' || lv === 'M6' || lv === 'M7'
		}).length : null))

	const maxOverdueDays = authoritative
		? null
		: (nonNegativeNumberOrNull(ov.max_overdue_days) ?? (
			ovDetails.length && ovDetails.every((d) => nonNegativeNumberOrNull(d.days ?? d.overdue_days) != null)
				? Math.max(...ovDetails.map((d) => nonNegativeNumberOrNull(d.days ?? d.overdue_days)))
				: null
		))
	const totalOverdueAmt = authoritative
		? null
		: (nonNegativeNumberOrNull(ov.total_overdue_amount) ?? sumKnownRows(
			ovDetails,
			(d) => d.amount ?? d.overdue_amount,
			ovDetailsKnown && ovDetails.length > 0
		))

	const qs = (core.query_analysis && core.query_analysis.summary) || {}
	const pickQ = (k) => nonNegativeNumberOrNull((qs[k] || {}).total)
	const queryDetails = (core.query_analysis && Array.isArray(core.query_analysis.query_details)) ? core.query_analysis.query_details : []
	const mappedQueryItems = queryDetails.map((d) => ({
		date: d.date || d.query_date || '',
		institution: d.institution || d.org || d.bank || d.query_org || '',
		reason: d.reason || d.query_reason || d.purpose || '',
		institutionKind: pickFirst(d, [
			'institutionKind', 'institution_kind', 'institutionType', 'institution_type',
			'orgType', 'org_type', 'lenderType', 'lender_type'
		])
	}))
	let q1 = pickQ('last_1m')
	let q3 = pickQ('last_3m')
	let q6 = pickQ('last_6m')
	let q12 = pickQ('last_12m')
	const reportAnchor = parseCreditDate(
		analysisAuthority.anchorDate ||
		(core.basic_info && core.basic_info.report_date) ||
		(core.meta && (core.meta.report_date || core.meta.query_date))
	)
	const anchoredQueryWindows = reportAnchor
		? summarizeQueriesByWindows(mappedQueryItems, reportAnchor)
		: null
	if (!authoritative && queryDetails.length > 0 && reportAnchor) {
		q1 = anchoredQueryWindows['1m'].total
		q3 = anchoredQueryWindows['3m'].total
		q6 = anchoredQueryWindows['6m'].total
		q12 = anchoredQueryWindows['12m'].total
	}
	const last1mQueryDetails = reportAnchor
		? filterQueryInstitutionDetailsLive(queryDetails, { monthsBack: 1, anchorDate: reportAnchor })
		: []
	const last1mSummary = qs.last_1m || {}
	const approvalBreakdown = last1mSummary.by_reason || last1mSummary.reason_counts || {}
	const authoritativeLoanQueryCount = nonNegativeNumberOrNull(
		last1mSummary.loan_approval ??
		last1mSummary.loan_approval_count ??
		approvalBreakdown.loan_approval ??
		approvalBreakdown['贷款审批']
	)
	const authoritativeCardQueryCount = nonNegativeNumberOrNull(
		last1mSummary.credit_card_approval ??
		last1mSummary.card_approval_count ??
		approvalBreakdown.credit_card_approval ??
		approvalBreakdown['信用卡审批'] ??
		approvalBreakdown['贷记卡审批']
	)
	const loanQueryCount = authoritative
		? null
		: (nonNegativeNumberOrNull(authoritativeLoanQueryCount) ?? (reportAnchor && queryDetails.length > 0
			? last1mQueryDetails.filter((d) => /贷款审批|担保(?:资格)?审查|保前审查|融资审批|授信审批/.test(String(d.reason || d.query_reason || d.purpose || ''))).length
			: null))
	const cardQueryCount = authoritative
		? null
		: (nonNegativeNumberOrNull(authoritativeCardQueryCount) ?? (reportAnchor && queryDetails.length > 0
			? last1mQueryDetails.filter((d) => /信用卡审批|贷记卡审批/.test(String(d.reason || d.query_reason || d.purpose || ''))).length
			: null))

	const rawHits = Array.isArray(core.risk_analysis && core.risk_analysis.risk_hits) ? core.risk_analysis.risk_hits : []
	const hasDisabledDebtRatioRiskHit = rawHits.some(isDisabledDebtRatioRiskHit)
	const hits = rawHits.filter((hit) => !isDisabledDebtRatioRiskHit(hit))
	const overdueHits = hits.filter((h) => String(h.rule_name || '').match(/OVERDUE|连三|累六/i))
	const hasLianSanHit = overdueHits.some((h) => /连三|LIAN_SAN/.test(String(h.rule_name || '') + String(h.title || '')))
	const hasLeiLiuHit = overdueHits.some((h) => /累六|LEI_LIU/.test(String(h.rule_name || '') + String(h.title || '')))
	const hasLianSan = hasLianSanHit ? true : booleanOrNull(ov.has_lian_san)
	const hasLeiLiu = hasLeiLiuHit ? true : booleanOrNull(ov.has_lei_liu)
	const publicRecordSource = core.public_records && typeof core.public_records === 'object' ? core.public_records : null
	const hasPublicRecord = publicRecordSource && Array.isArray(publicRecordSource.items) && publicRecordSource.items.length > 0
		? true
		: booleanOrNull(publicRecordSource && publicRecordSource.has_record)
	const dimensions = {
		fieldScopedAuthority: authoritative,
		totalCreditLine,
		usedCardLimit: totalCardUsed,
		cardUtilizationUsed,
		totalLoanBalance,
		availableCredit: totalCreditLine == null || totalDebt == null ? null : Math.max(totalCreditLine - totalDebt, 0),
		totalDebt,
		totalOverdueAmt,

		debtRatio,
		cardUtilizationRate: cardUseRate,
		cardUtilizationStatus: authoritative ? 'server-authoritative' : cardUtilization.status,
		cardUtilizationDecisionEligible: authoritative || cardUtilizationEligible,
		cardRawTotalLimit: authoritative ? null : cardUtilization.rawTotalLimit,
		cardRawTotalUsed: authoritative ? null : cardUtilization.rawTotalUsed,
		cardUtilizationGroupCount: authoritative ? null : (cardAmountEvidenceComplete ? cardUtilization.utilizationGroupCount : null),
		cardSharedGroupCount: authoritative ? nonNegativeNumberOrNull(cc.shared_group_count) : (cardAmountEvidenceComplete ? cardUtilization.sharedGroupCount : null),
		cardForeignCurrencyAccountCount: authoritative ? null : (cardAmountEvidenceComplete ? cardUtilization.foreignAccountCount : null),
		cardUnknownUtilizationAccountCount: authoritative ? null : (cardAmountEvidenceComplete ? cardUtilization.unknownAccountCount : null),
		cardExcludedUtilizationAccountCount: authoritative ? null : (cardAmountEvidenceComplete ? cardUtilization.excludedAccountCount : null),
		overdueCount: authoritative ? null : (nonNegativeNumberOrNull(ov.total_overdue_accounts) ?? (ovDetails.length ? ovDetails.length : null)),
		maxOverdueDays,
		m1Count,
		m2Count,
		m3Count,
		hasLianSan: authoritative ? null : hasLianSan,
		hasLeiLiu: authoritative ? null : hasLeiLiu,
		hasPublicRecord: authoritative ? null : hasPublicRecord,

		q1, q3, q6, q12,
		loanQueryCount,
		cardQueryCount,

		totalAccountCount: authoritative ? null : ((cardDetailsKnown && bankLoansKnown && nonBankLoansKnown) ? accounts.length : null),
		activeAccountCount: authoritative ? null : (accounts.length > 0 && accounts.every((a) => typeof a.isSettled === 'boolean')
			? accounts.filter((a) => a.isSettled === false).length
			: null),
		settledAccountCount: authoritative ? null : (accounts.length > 0 && accounts.every((a) => typeof a.isSettled === 'boolean')
			? accounts.filter((a) => a.isSettled === true).length
			: null),
		creditCardCount: authoritative ? null : (() => {
			const summaryCount = nonNegativeNumberOrNull(cc.card_count)
			if (summaryCount > 0 && cardAccountDetails.length > 0 && summaryCount <= cardAccountDetails.length * 2) return summaryCount
			if (cardAccountDetails.length > 0) return cardAccountDetails.length
			return summaryCount
		})(),
		loanCount: authoritative ? null : (bankLoans.length + nonBankLoans.length > 0
			? bankLoans.length + nonBankLoans.length
			: nonNegativeNumberOrNull(cl.total_count ?? cl.count)),
		nonBankLoanCount: authoritative ? null : (nonBankLoans.length > 0
			? nonBankLoans.length
			: nonNegativeNumberOrNull(cl.non_bank_count)),
		oldestAccountYears: authoritative ? null : nonNegativeNumberOrNull(cd.oldest_account_years),
		avgAccountYears: authoritative ? null : nonNegativeNumberOrNull(cd.avg_account_years),

		monthlyPaymentTotal: authoritative ? null : (accounts.length && accounts.every((a) => nonNegativeNumberOrNull(a.monthlyPayment) != null)
			? accounts.reduce((s, a) => s + nonNegativeNumberOrNull(a.monthlyPayment), 0)
			: null),
		monthlyIncomeRatio: null
	}
	const deterministicDimensions = authoritative ? {} : normalizeDeterministicDimensions(getDeterministicDimensions(core))
	Object.assign(dimensions, deterministicDimensions)
	if (authoritative) {
		// Deterministic dimensions are useful compatibility projections, but
		// they are not in evidence-v2's authoritative scope. Re-apply every
		// scoped value from its canonical path so an alias cannot override it.
		Object.assign(dimensions, {
			totalDebt,
			totalLoanBalance,
			usedCardLimit: totalCardUsed,
			cardUtilizationUsed,
			cardUtilizationRate: cardUseRate,
			cardSharedGroupCount: nonNegativeNumberOrNull(cc.shared_group_count),
			q1,
			q3,
			q6,
			q12
		})
	}
	if (!authoritative && !Object.prototype.hasOwnProperty.call(deterministicDimensions, 'hasOverdue')) {
		const overdueInputs = [dimensions.overdueCount, dimensions.m1Count, dimensions.m2Count, dimensions.m3Count]
		const knownOverdueInputs = overdueInputs.filter((value) => nonNegativeNumberOrNull(value) != null)
		dimensions.hasOverdue = knownOverdueInputs.length
			? knownOverdueInputs.some((value) => nonNegativeNumberOrNull(value) > 0)
			: null
	}
	if (authoritative) dimensions.hasOverdue = null
	if (!authoritative && !Object.prototype.hasOwnProperty.call(deterministicDimensions, 'hasM3Plus')) {
		dimensions.hasM3Plus = dimensions.m3Count == null ? null : dimensions.m3Count > 0
	}
	if (authoritative) dimensions.hasM3Plus = null
	if (!authoritative && !Object.prototype.hasOwnProperty.call(deterministicDimensions, 'isHighRisk')) {
		const highRiskSignals = [hasLianSan, hasLeiLiu, dimensions.m3Count == null ? null : dimensions.m3Count > 0, hasPublicRecord]
		dimensions.isHighRisk = highRiskSignals.some((value) => value === true)
			? true
			: highRiskSignals.every((value) => value === false) ? false : null
	}
	if (authoritative) dimensions.isHighRisk = null
	markDebtRatioDiagnosticOnly(dimensions)

	const overdueRecords = authoritative ? [] : ovDetails.length > 0
		? ovDetails.map((d) => {
				const days = nonNegativeNumberOrNull(d.days ?? d.overdue_days)
				const explicitLevel = String(d.level || d.overdue_level || '').trim()
				const level = explicitLevel
					? explicitLevel.toUpperCase()
					: days == null ? 'unknown' : days > 60 ? 'M3+' : days > 30 ? 'M2' : days > 0 ? 'M1' : 'none'
				return {
					bank: d.institution || d.bank || '',
					accountType: d.account_type || d.type || '',
					amount: nonNegativeNumberOrNull(d.amount ?? d.overdue_amount),
					days,
					level,
					date: d.date || ''
				}
			})
		: accounts.filter((a) => a.isOverdue).map((a) => ({
				bank: a.bank, accountType: a.accountType, amount: nonNegativeNumberOrNull(a.overdueAmount),
				days: a.overdueDays, level: a.overdueLevel, date: ''
			}))

	const queryRecords = {
		recent1Month: dimensions.q1,
		recent3Month: dimensions.q3,
		recent6Month: dimensions.q6,
		recent12Month: dimensions.q12,
		recent24Month: pickQ('last_24m'),
		windowSummaries: {
			last_1m: normalizeQueryWindowBreakdown(qs.last_1m, dimensions.q1, anchoredQueryWindows && anchoredQueryWindows['1m']),
			last_3m: normalizeQueryWindowBreakdown(qs.last_3m, dimensions.q3, anchoredQueryWindows && anchoredQueryWindows['3m']),
			last_6m: normalizeQueryWindowBreakdown(qs.last_6m, dimensions.q6, anchoredQueryWindows && anchoredQueryWindows['6m']),
			last_12m: normalizeQueryWindowBreakdown(qs.last_12m, dimensions.q12, anchoredQueryWindows && anchoredQueryWindows['12m'])
		},
		details: queryDetails,
		queryItems: queryDetails
	}

	const publicRecords = {
		hasRecord: typeof dimensions.hasPublicRecord === 'boolean' ? dimensions.hasPublicRecord : null,
		items: authoritative ? [] : ((core.public_records && core.public_records.items) || [])
	}
	const consecutiveOverdue = {
		hasLianSan: typeof dimensions.hasLianSan === 'boolean' ? dimensions.hasLianSan : null,
		hasLeiLiu: typeof dimensions.hasLeiLiu === 'boolean' ? dimensions.hasLeiLiu : null,
		triggered: typeof dimensions.hasLianSan === 'boolean' && typeof dimensions.hasLeiLiu === 'boolean'
			? dimensions.hasLianSan || dimensions.hasLeiLiu
			: null,
		details: []
	}

	const bi = core.basic_info || {}
	const idLast = bi.id_last4 != null ? String(bi.id_last4).replace(/\D/g, '').slice(-4) : ''
	const basicInfo = {
		name: bi.name || '',
		idCard: bi.id_card || (idLast.length === 4 ? `****************${idLast}` : ''),
		phone: bi.phone || '',
		reportDate: analysisAuthority.anchorDate || bi.report_date || (core.meta && core.meta.report_date) || (core.meta && core.meta.query_date) || '',
		address: bi.address || bi.address_city || '',
		marriage: bi.marriage || '',
		occupation: bi.occupation || '',
		employer: bi.employer || ''
	}

	// 四维评分（兼容展示字段：移除 偿债能力/负债比例）
	// 服务端缺某维度真实分时，用本地 dimensions 经 scoreFourDimensions 复算，
	// 取代旧的「统一兜底 60」（会让综合分加权后恒等于 60）。
	const sd = core.six_dimensions || {}
	const legacyScoringInputsComplete = !authoritative && [
		dimensions.totalDebt,
		dimensions.totalLoanBalance,
		dimensions.usedCardLimit,
		dimensions.q1,
		dimensions.q3,
		dimensions.q6,
		dimensions.q12,
		dimensions.totalAccountCount,
		dimensions.overdueCount,
		dimensions.m1Count,
		dimensions.m2Count,
		dimensions.m3Count
	].every((value) => nonNegativeNumberOrNull(value) != null)
	const localFour = legacyScoringInputsComplete ? scoreFourDimensions(dimensions) : null
	const pickDim = (key) => {
		if (authoritative) return null
		const v = nonNegativeNumberOrNull(sd[key])
		if (v != null && v <= 100) return v
		return localFour ? localFour[key] : null
	}
	const six = {
		credit_history: pickDim('credit_history'),
		query_frequency: pickDim('query_frequency'),
		account_structure: pickDim('account_structure'),
		repayment_record: pickDim('repayment_record')
	}
	const scores = {
		credit_history: six.credit_history,
		query_frequency: six.query_frequency,
		account_structure: six.account_structure,
		repayment_record: six.repayment_record,
		'信用历史': six.credit_history,
		'查询频率': six.query_frequency,
		'账户结构': six.account_structure,
		'还款记录': six.repayment_record
	}

	return {
		dimensions, accounts, overdueRecords, queryRecords, publicRecords,
		consecutiveOverdue, basicInfo, scores,
		totalScore: authoritative
			? score100(core.primary_rule_score.score, null)
			: score100(
				(core.primary_rule_score && core.primary_rule_score.score) ??
				(core.assessment && core.assessment.primary_rule_score && core.assessment.primary_rule_score.score) ??
				(core.frontend_payload && core.frontend_payload.primary_rule_score && core.frontend_payload.primary_rule_score.score) ??
				(core.assessment && (core.assessment.score ?? core.assessment.composed_score)),
				legacyScoringInputsComplete ? calculatePrimaryRuleScore(dimensions).score : null
			),
		riskLevelEn: authoritative || hasDisabledDebtRatioRiskHit
			? 'unknown'
			: mapRiskLevel(core.assessment && core.assessment.risk_level || core.risk_level || (core.risk_analysis && core.risk_analysis.overall_level)),
		riskTags: authoritative ? [] : (Array.isArray(core.risk_tags)
			? core.risk_tags
			: hits.map((hit) => hit && hit.title).filter(Boolean)
		).filter((tag) => !isDisabledDebtRatioRiskText(tag)),
		suggestion: authoritative ? '' : String((core.assessment && core.assessment.suggestion) || core.suggestion || '').trim(),
		pros: authoritative ? [] : (Array.isArray(core.assessment && core.assessment.pros) ? core.assessment.pros : []),
		cons: authoritative ? [] : (Array.isArray(core.assessment && core.assessment.cons) ? core.assessment.cons : []),
		authoritative
	}
}

/** Python 返回如 "3笔，总余额56" / "0笔，余额0" 字符串 → { count, balance } */
const parsePythonLoanLineString = (s) => {
	const str = String(s == null ? '' : s)
	const mCount = str.match(/(\d+)\s*笔/)
	const mBalance = str.match(/(?:余额|总余额)\s*([\d.]+)/)
	return {
		count: mCount ? num(mCount[1]) : null,
		balance: mBalance ? num(mBalance[1]) : null
	}
}

const mapZhRiskCnToEn = (v) => {
	const s = typeof v === 'string' ? v.trim() : ''
	if (!s) return 'unknown'
	if (s === '极低' || s === '低') return 'low'
	if (s === '极高' || s === '高') return 'high'
	if (s === '中低') return 'medium-low'
	if (s === '中' || s === '中等' || s === '一般') return 'medium'
	return mapRiskLevel(s)
}

const buildClientShapeFromLegacyPython = (core) => {
	const details = (core && core.details) || {}
	const bi = details.basic_info || core.basic_info || {}
	const cs = details.credit_summary || {}
	const cc = cs.credit_cards || {}
	const ln = cs.loans || {}
	const qr2y = (details.query_records && details.query_records.last_2_years) || {}
	const ra = details.risk_assessment || {}
	const bp = details.behavior_patterns || {}

	const consumerLoans = parsePythonLoanLineString(ln.consumer_loans)
	const mortgageLoans = parsePythonLoanLineString(ln.mortgage)

	// 信用卡总授信：sample_high_usage 通常只采样使用率最高的 3 张，无法精准还原全部授信。
	// 取已知样本 + 其余卡按"采样均值估算"作为兜底，避免把负债率算成 0。
	const samples = Array.isArray(cc.sample_high_usage) ? cc.sample_high_usage : []
	const sampleLimitSum = sumKnownRows(samples, (x) => x['额度'] ?? x.limit ?? x.credit_limit, false)
	const sampleAvg = samples.length > 0 && sampleLimitSum != null ? sampleLimitSum / samples.length : null
	const cardCount = nonNegativeNumberOrNull(cc.total)
	const cardActive = nonNegativeNumberOrNull(cc.active)
	const totalCardLimit = sampleLimitSum != null && sampleAvg != null && cardCount != null
		? sampleLimitSum + Math.max(0, cardCount - samples.length) * sampleAvg
		: null
	const usedCardLimit = nonNegativeNumberOrNull(cc.total_used_limit)

	const totalDebt = nonNegativeNumberOrNull(ln.total_debt) // 服务端口径：信用卡已用 + 贷款余额
	const totalLoanBalance = consumerLoans.balance != null && mortgageLoans.balance != null
		? consumerLoans.balance + mortgageLoans.balance
		: null
	// 注意：totalLoanBalance 已含 consumerLoans.balance，不可再单独加一次，
	// 否则分母虚高导致负债率被系统性低估。口径 = 信用卡总授信 + 贷款总余额。
	const totalCreditLine = totalCardLimit != null && totalLoanBalance != null ? totalCardLimit + totalLoanBalance : null
	// 负债率统一按 总负债额度 / 总信用额度 计算。
	const debtRatio = totalCreditLine > 0 && totalDebt != null ? Math.max(0, totalDebt / totalCreditLine) : null
	const cardUsage = totalCardLimit > 0 && usedCardLimit != null ? Math.min(usedCardLimit / totalCardLimit, 1) : null

	const cardOverdue = nonNegativeNumberOrNull(cc.overdue_count)
	const loanOverdue = nonNegativeNumberOrNull(ln.overdue_count)
	const overdueCount = cardOverdue != null && loanOverdue != null ? cardOverdue + loanOverdue : null
	const m3 = nonNegativeNumberOrNull(cc.overdue_90_days)

	const aiScore = num(
		(core.primary_rule_score && core.primary_rule_score.score) ??
		(ra.primary_rule_score && ra.primary_rule_score.score) ??
		ra.score,
		null
	)

	const dimensions = {
		totalCreditLine,
		usedCardLimit,
		totalLoanBalance,
		availableCredit: totalCreditLine != null && totalDebt != null ? Math.max(totalCreditLine - totalDebt, 0) : null,
		totalDebt,
		totalOverdueAmt: null,

		debtRatio,
		cardUtilizationRate: cardUsage,
		overdueCount,
		maxOverdueDays: m3 == null ? null : m3 > 0 ? 90 : 0,
		m1Count: null,
		m2Count: null,
		m3Count: m3,
		hasLianSan: null,
		hasLeiLiu: null,
		hasPublicRecord: null,

		// Python 只给"近 2 年"汇总，q12 用 total_queries 兜底，q1/q3/q6 留 0
		q1: null,
		q3: null,
		q6: null,
		q12: nonNegativeNumberOrNull(qr2y.total_queries),
		loanQueryCount: nonNegativeNumberOrNull(qr2y.loan_approval),
		cardQueryCount: nonNegativeNumberOrNull(qr2y.credit_card_approval),

		totalAccountCount: cardCount != null && nonNegativeNumberOrNull(ln.total) != null ? cardCount + nonNegativeNumberOrNull(ln.total) : null,
		activeAccountCount: cardActive != null && nonNegativeNumberOrNull(ln.active) != null ? cardActive + nonNegativeNumberOrNull(ln.active) : null,
		settledAccountCount: cardCount != null && cardActive != null && nonNegativeNumberOrNull(ln.total) != null && nonNegativeNumberOrNull(ln.active) != null
			? Math.max(0, cardCount - cardActive) + Math.max(0, nonNegativeNumberOrNull(ln.total) - nonNegativeNumberOrNull(ln.active))
			: null,
		creditCardCount: cardCount,
		loanCount: nonNegativeNumberOrNull(ln.total),
		nonBankLoanCount: consumerLoans.count,
		oldestAccountYears: null,
		avgAccountYears: null,

		monthlyPaymentTotal: nonNegativeNumberOrNull(ln.monthly_repay_estimate),
		monthlyIncomeRatio: null
	}
	dimensions.hasOverdue = dimensions.overdueCount == null ? null : dimensions.overdueCount > 0
	dimensions.hasM3Plus = dimensions.m3Count == null ? null : dimensions.m3Count > 0
	dimensions.isHighRisk = dimensions.m3Count == null ? null : dimensions.m3Count > 0
	markDebtRatioDiagnosticOnly(dimensions)

	const accounts = []
	for (const x of samples) {
		const status = statusTextOrEmpty(x.status)
		accounts.push({
			bank: String(x['银行'] || x.bank || '信用卡'),
			accountType: '贷记卡',
			isLoan: false,
			limit: nonNegativeNumberOrNull(x['额度'] ?? x.limit ?? x.credit_limit),
			balance: nonNegativeNumberOrNull(x['已用'] ?? x.used ?? x.balance),
			loanAmount: null,
			status: status || null,
			openDate: '',
			endDate: '',
			isSettled: statusIndicatesSettled(status) ? true : statusIndicatesActiveUnsettled(status) ? false : null,
			repayRecord: '',
			monthlyPayment: null,
			overdueDays: null,
			overdueAmount: null,
			overdueLevel: 'unknown',
			isOverdue: null
		})
	}
	if (consumerLoans.count > 0) {
		accounts.push({
			bank: '消费贷（合计）',
			accountType: '个人消费贷款',
			isLoan: true,
			limit: null,
			balance: consumerLoans.balance,
			loanAmount: consumerLoans.balance,
			status: null,
			openDate: '',
			endDate: '',
			isSettled: null,
			repayRecord: '',
			monthlyPayment: nonNegativeNumberOrNull(ln.monthly_repay_estimate),
			overdueDays: null,
			overdueAmount: null,
			overdueLevel: 'unknown',
			isOverdue: null
		})
	}
	if (mortgageLoans.count > 0) {
		accounts.push({
			bank: '房贷（合计）',
			accountType: '住房按揭',
			isLoan: true,
			limit: null,
			balance: mortgageLoans.balance,
			loanAmount: mortgageLoans.balance,
			status: null,
			openDate: '',
			endDate: '',
			isSettled: null,
			repayRecord: '',
			monthlyPayment: null,
			overdueDays: null,
			overdueAmount: null,
			overdueLevel: 'unknown',
			isOverdue: null
		})
	}

	const queryRecords = {
		recent1Month: null,
		recent3Month: null,
		recent6Month: null,
		recent12Month: null,
		recent24Month: nonNegativeNumberOrNull(qr2y.total_queries),
		loanApprovalCount: nonNegativeNumberOrNull(qr2y.loan_approval),
		cardApprovalCount: nonNegativeNumberOrNull(qr2y.credit_card_approval),
		postLoanManagementCount: nonNegativeNumberOrNull(qr2y.post_loan_management),
		selfQueryCount: nonNegativeNumberOrNull(qr2y.self_query),
		details: [],
		queryItems: []
	}

	const publicRecords = { hasRecord: null, items: [] }
	const consecutiveOverdue = { hasLianSan: null, hasLeiLiu: null, triggered: null, details: [] }

	const basicInfo = {
		name: bi.name || '',
		idCard: bi.id_last4 ? `**************${bi.id_last4}` : '',
		phone: '',
		reportDate: bi.report_time || '',
		address: '',
		marriage: bi.marriage || ''
	}

	// 四维评分 —— 严格按算法（scoreFourDimensions）由 dimensions 真实计算，
	//     取代旧的「按 aiScore/账户数/查询数写死阶梯分」倒推；
	//     与 V2 路径、前端 composedScoreV6、本地 aiAnalysis 完全同口径。
	//     Python 仅给近 2 年查询汇总 → q1/q3/q6=0，查询频率维度据此弱化（数据限制，非兜底）。
	const hasScorable =
		dimensions.totalAccountCount > 0 ||
		num(qr2y.total_queries) > 0 ||
		dimensions.overdueCount > 0
	const four = hasScorable ? scoreFourDimensions(dimensions) : null
	const scores = four
		? {
				credit_history: four.credit_history,
				query_frequency: four.query_frequency,
				account_structure: four.account_structure,
				repayment_record: four.repayment_record,
				'信用历史': four.credit_history,
				'查询频率': four.query_frequency,
				'账户结构': four.account_structure,
				'还款记录': four.repayment_record
			}
		: {}
	// 综合分：优先服务端 aiScore（其权威单分），否则本地主评分框架（规则扣分制）；
	// 无可评分数据时置 0（前端 totalScoreU 取不到 >0 值 → 显示「—」）。
	const primaryLocal = hasScorable ? calculatePrimaryRuleScore(dimensions).score : null
	const totalScore = aiScore != null ? score100(aiScore, null) : primaryLocal

	return {
		dimensions,
		accounts,
		overdueRecords: [],
		queryRecords,
		publicRecords,
		consecutiveOverdue,
		basicInfo,
		scores,
		totalScore,
		riskLevelEn: mapZhRiskCnToEn(ra.overall_level || core.risk_level),
		summary: String(ra.recommendation || core.suggestions || '').trim(),
		pros: Array.isArray(ra.pros) ? ra.pros.slice(0, 6) : [],
		cons: Array.isArray(ra.cons) ? ra.cons.slice(0, 6) : [],
		behaviorPatterns: bp,
		summaryCards: Array.isArray(core.summary_cards) ? core.summary_cards : []
	}
}

const emptyAnalysis = () => ({
	report: {
		totalScore: null,
		riskLevel: 'unknown',
		summary: '暂无有效分析摘要',
		scores: {},
		dimensionSnapshot: {},
		suggestions: [],
		weakPoints: [],
		keyFindings: [],
		behaviorTags: [],
		behaviorDetails: [],
		hiddenRisks: []
	},
	dimensions: {},
	accounts: [],
	overdueRecords: [],
	queryRecords: {},
	publicRecords: {},
	consecutiveOverdue: {},
	analysisPipelineVersion: 'server-api'
})

/**
 * @param {any} data POST /api/analyze 成功时返回的 data
 * @returns {Object} 与 saveReport / 详情页兼容的分析对象
 */
export const mapServerAnalyzeDataToClientAnalysis = (data) => {
	const analysisAuthority = getServerAnalysisAuthority(data)
	// Authority and values must come from the exact same object. Wrapper
	// flattening is retained only for legacy display compatibility; it must not
	// let a later nested object override a root that passed the scoped gate.
	const authoritativeRoot = resolveAuthoritativeServerRoot(data)
	const rawCore = authoritativeRoot || unwrapCore(data)
	const evidenceMeta = buildCompactEvidenceMeta(data, rawCore)
	const core = stripPrivateEvidenceArtifacts(rawCore)

	// 形态 D：ai-proxy 10 模块 V2 schema —— meta+credit_debt+loan_details+credit_card_details 等。
	// 必须优先于其他形态匹配，否则会被旧 LLM 形态 buildClientShapeFromLLM 误读为全 0。
	if (looksLikeCreditReportV2(core)) {
		const built = buildClientShapeFromV2(core, analysisAuthority)
		built.basicInfo = normalizeServerBasicInfo(core, built.basicInfo)
		if (analysisAuthority.authoritative && analysisAuthority.anchorDate) {
			built.basicInfo.reportDate = analysisAuthority.anchorDate
		}
		const aiScoreNum = score100(built.totalScore, null)
		const report = {
			totalScore: aiScoreNum,
			riskLevel: built.riskLevelEn,
			summary: built.suggestion || (aiScoreNum != null
				? (built.riskLevelEn === 'unknown'
					? `综合评分 ${aiScoreNum} 分；整体风险等级待核对。`
					: `综合评分 ${aiScoreNum} 分，风险等级 ${built.riskLevelEn}。`)
				: '报告已读取，关键字段待核对'),
			scores: built.scores,
			dimensionSnapshot: buildDimensionSnapshot(built.dimensions, built.overdueRecords, built.queryRecords),
			suggestions: buildSuggestionsFromDim(built.dimensions, built.suggestion, built.riskTags),
			weakPoints: Object.entries(built.scores)
				.filter(([k, v]) => /[一-龥]/.test(k) && typeof v === 'number' && v < 70)
				.map(([k]) => k),
			keyFindings: built.cons.length > 0 ? built.cons : buildKeyFindingsFromDim(built.dimensions),
			behaviorTags: [],
			behaviorDetails: [],
			hiddenRisks: [],
			riskTags: built.riskTags,
			aiSuggestion: built.suggestion,
			productAccessibility: core.product_accessibility || null,
			creditAccounts: built.accounts,
			pros: built.pros,
			cons: built.cons
		}
		const mapped = attachCompactEvidenceMeta({
			...emptyAnalysis(),
			...core,
			basicInfo: built.basicInfo,
			accounts: built.accounts,
			overdueRecords: built.overdueRecords,
			queryRecords: built.queryRecords,
			publicRecords: built.publicRecords,
			consecutiveOverdue: built.consecutiveOverdue,
			dimensions: built.dimensions,
			scores: built.scores,
			aiAdvisoryScores: built.scores,
			kimiAdvisoryScores: built.scores,
			report,
			aiInsight: core,
			kimiInsight: core,
			// 透传 V2 专属顶层：详情页直接读取 creditReportV2 / frontendPayload / dataCompleteness
			creditReportV2: core,
			frontendPayload: core.frontend_payload || null,
			ruleEngineWarnings: Array.isArray(core.rule_engine_warnings) ? core.rule_engine_warnings : [],
			dataCompleteness:
				core.data_completeness ||
				(core.frontend_payload && core.frontend_payload.data_completeness) ||
				null,
			derivationMeta: core.derivation_meta || core.derivationMeta || null,
			analysisAuthority,
			authoritativeAnalysis: analysisAuthority.wholeObjectAuthoritative === true,
			authoritativeScope: analysisAuthority.authoritativeScope,
			analysisPipelineVersion: analysisAuthority.authoritative
				? 'server-deterministic-v1'
				: 'server-credit-v2-legacy-compatible'
		}, evidenceMeta)
		return analysisAuthority.authoritative ? markMappedServerAnalysis(mapped) : mapped
	}

	// 形态 C：旧版 Python 分析服务 build_response 输出（独有 details + summary_cards/suggestions）
	// 必须优先于形态 A/B 检测——Python 的 details 里嵌了 basic_info/credit_summary 容易被 looksLikeLLM 误判。
	if (looksLikeLegacyPython(core)) {
		const built = buildClientShapeFromLegacyPython(core)
		built.basicInfo = normalizeServerBasicInfo(core, built.basicInfo)
		const report = {
			totalScore: built.totalScore == null ? null : Math.round(built.totalScore),
			riskLevel: built.riskLevelEn,
			summary: built.summary || (built.totalScore != null ? `综合评分 ${Math.round(built.totalScore)} 分，风险等级 ${built.riskLevelEn}。` : '服务端已返回分析数据'),
			scores: built.scores,
			dimensionSnapshot: buildDimensionSnapshot(built.dimensions, built.overdueRecords, built.queryRecords),
			suggestions: buildSuggestionsFromDim(built.dimensions, built.summary, built.cons),
			weakPoints: Object.entries(built.scores)
				.filter(([k, v]) => /[一-龥]/.test(k) && typeof v === 'number' && v < 70)
				.map(([k]) => k),
			keyFindings: built.cons.length > 0 ? built.cons : buildKeyFindingsFromDim(built.dimensions),
			behaviorTags: [],
			behaviorDetails: [],
			hiddenRisks: [],
			riskTags: built.cons,
			aiSuggestion: built.summary,
			productAccessibility: null,
			creditAccounts: built.accounts,
			pros: built.pros,
			cons: built.cons,
			behaviorPatterns: built.behaviorPatterns,
			summaryCards: built.summaryCards
		}
		return attachCompactEvidenceMeta({
			...emptyAnalysis(),
			...core,
			basicInfo: built.basicInfo,
			accounts: built.accounts,
			overdueRecords: [],
			queryRecords: built.queryRecords,
			publicRecords: built.publicRecords,
			consecutiveOverdue: built.consecutiveOverdue,
			dimensions: built.dimensions,
			// detail.uvue 的 dimensionItems 直接读 analysisData.scores，必须在顶层镜像四维分
			scores: built.scores,
			aiAdvisoryScores: built.scores,
			kimiAdvisoryScores: built.scores,
			report,
			aiInsight: core,
			kimiInsight: core,
			analysisAuthority,
			authoritativeAnalysis: analysisAuthority.wholeObjectAuthoritative === true,
			authoritativeScope: analysisAuthority.authoritativeScope,
			analysisPipelineVersion: analysisAuthority.authoritative
				? 'server-deterministic-v1'
				: 'server-python-legacy-compatible'
		}, evidenceMeta)
	}

	// 形态 A：服务端已直接返回与本地 aiAnalysis 一致的客户端结构（含 report 对象）
	if (core.report && typeof core.report === 'object') {
		const dimensions = core.dimensions || {}
		const accounts = core.accounts || core.creditAccounts || []
		const overdueRecords = core.overdueRecords || []
		const queryRecords = core.queryRecords || {}
		const report = { ...core.report }
		if (typeof report.totalScore !== 'number' || !Number.isFinite(report.totalScore)) {
			const rawScore = pickFirst(core, ['totalScore', 'total_score', 'credit_score'])
			const ts = rawScore === undefined || rawScore === null || rawScore === ''
				? null
				: score100(rawScore, null)
			report.totalScore = ts
		} else {
			report.totalScore = score100(report.totalScore, null)
		}
		if (!report.riskLevel) {
			const rawRisk = pickFirst(core, ['riskLevel', 'risk_level'])
			report.riskLevel = rawRisk === undefined || rawRisk === null || String(rawRisk).trim() === ''
				? 'unknown'
				: mapRiskLevel(rawRisk)
		}
		if (!report.dimensionSnapshot || !Object.keys(report.dimensionSnapshot).length) {
			report.dimensionSnapshot = buildDimensionSnapshot(dimensions, overdueRecords, queryRecords)
		}
		if (!report.scores || !Object.keys(report.scores).length) {
			report.scores = scoresFromServer(core, report.scores)
		}
		return attachCompactEvidenceMeta({
			...core,
			basicInfo: normalizeServerBasicInfo(core, core.basicInfo || core.basic_info || {}),
			report,
			dimensions: Object.keys(dimensions).length ? dimensions : core.dimensions || {},
			accounts: Array.isArray(accounts) ? accounts : [],
			overdueRecords: Array.isArray(overdueRecords) ? overdueRecords : [],
			queryRecords,
			analysisAuthority,
			authoritativeAnalysis: analysisAuthority.wholeObjectAuthoritative === true,
			authoritativeScope: analysisAuthority.authoritativeScope,
			analysisPipelineVersion: analysisAuthority.authoritative
				? 'server-deterministic-v1'
				: core.analysisPipelineVersion || 'server-api-legacy-compatible'
		}, evidenceMeta)
	}

	// 形态 B：Flask `/api/analyze` 直接返回 LLM 结构化 JSON（snake_case，TEXT_SCHEMA_PROMPT）
	const looksLikeLLM =
		core && typeof core === 'object' && (
			core.six_dimensions || core.basic_info || core.debt_summary ||
			core.overdue_summary || core.query_records || core.credit_cards ||
			core.loan_accounts || core.account_overview || core.risk_tags ||
			core.behavior_tags || core.suggestion || core.product_accessibility
		)

	const aiInsight = pickFirst(core, ['aiInsight', 'kimiInsight', 'ai_insight', 'ai_result', 'ai']) || (looksLikeLLM ? core : null)

	let dimensions = pickFirst(core, ['dimensions', 'dimension', 'stats']) || {}
	let accounts = pickFirst(core, ['accounts', 'creditAccounts', 'credit_accounts', 'account_list']) || []
	let overdueRecords = pickFirst(core, ['overdueRecords', 'overdue_records', 'overdues']) || []
	let queryRecords = pickFirst(core, ['queryRecords', 'query_records', 'queries']) || {}
	let publicRecords = core.publicRecords || core.public_records || {}
	let consecutiveOverdue = core.consecutiveOverdue || core.consecutive_overdue || {}
	let basicInfo = core.basicInfo || core.basic_info || {}

	if (looksLikeLLM && (!dimensions || Object.keys(dimensions).length === 0)) {
		const built = buildClientShapeFromLLM(core)
		dimensions = built.dimensions
		if (!Array.isArray(accounts) || accounts.length === 0) accounts = built.accounts
		if (!Array.isArray(overdueRecords) || overdueRecords.length === 0) overdueRecords = built.overdueRecords
		if (!queryRecords || Object.keys(queryRecords).length === 0) queryRecords = built.queryRecords
		if (!publicRecords || Object.keys(publicRecords).length === 0) publicRecords = built.publicRecords
		if (!consecutiveOverdue || Object.keys(consecutiveOverdue).length === 0) consecutiveOverdue = built.consecutiveOverdue
		if (!basicInfo || Object.keys(basicInfo).length === 0) basicInfo = built.basicInfo
	}
	basicInfo = normalizeServerBasicInfo(core, basicInfo)

	const rawScore =
		(core.primary_rule_score && core.primary_rule_score.score) ??
		pickFirst(core, ['totalScore', 'total_score', 'credit_score_estimate', 'credit_score', 'score', '综合评分'])
	const totalScore = rawScore === undefined || rawScore === null || rawScore === ''
		? null
		: score100(rawScore, null)
	const rawRisk = pickFirst(core, ['riskLevel', 'risk_level', 'risk', '风险等级'])
	const riskLevel = rawRisk === undefined || rawRisk === null || String(rawRisk).trim() === ''
		? 'unknown'
		: mapRiskLevel(rawRisk)
	const summary = String(
		pickFirst(core, ['summary', 'conclusion', 'abstract', '诊断摘要', '分析摘要', 'suggestion']) || ''
	).trim()

	const riskTags = Array.isArray(core.riskTags) ? core.riskTags : (Array.isArray(core.risk_tags) ? core.risk_tags : [])
	const behaviorTags = Array.isArray(core.behaviorTags) ? core.behaviorTags : (Array.isArray(core.behavior_tags) ? core.behavior_tags : [])

	const suggestions = (() => {
		if (Array.isArray(core.suggestions)) return core.suggestions
		// LLM 仅给出 suggestion 字符串 + risk_tags 时，按维度自动生成结构化建议
		return buildSuggestionsFromDim(dimensions, core.suggestion || core.ai_suggestion, riskTags)
	})()

	const keyFindings = (() => {
		if (Array.isArray(core.keyFindings)) return core.keyFindings
		if (!dimensions || typeof dimensions !== 'object' || Object.keys(dimensions).length === 0) return []
		return buildKeyFindingsFromDim(dimensions)
	})()

	const report = {
		totalScore,
		riskLevel,
		summary: summary || (totalScore != null ? `综合评分 ${Math.round(totalScore)} 分，风险等级已估算。` : '服务端已返回分析数据'),
		scores: scoresFromServer(core, null),
		dimensionSnapshot: buildDimensionSnapshot(dimensions, overdueRecords, queryRecords),
		suggestions,
		weakPoints: Array.isArray(core.weakPoints) ? core.weakPoints : [],
		keyFindings,
		behaviorTags,
		behaviorDetails: Array.isArray(core.behaviorDetails) ? core.behaviorDetails : [],
		hiddenRisks: Array.isArray(core.hiddenRisks) ? core.hiddenRisks : [],
		riskTags,
		aiSuggestion: String(core.suggestion || core.ai_suggestion || '').trim(),
		productAccessibility: core.product_accessibility || core.productAccessibility || null,
		creditAccounts: Array.isArray(accounts) ? accounts : []
	}

	const out = {
		...emptyAnalysis(),
		...core,
		basicInfo,
		accounts: Array.isArray(accounts) ? accounts : [],
		overdueRecords: Array.isArray(overdueRecords) ? overdueRecords : [],
		queryRecords: typeof queryRecords === 'object' && queryRecords ? queryRecords : {},
		publicRecords,
		consecutiveOverdue,
		dimensions: typeof dimensions === 'object' && dimensions ? dimensions : {},
		report,
		aiInsight: aiInsight || undefined,
		kimiInsight: aiInsight || undefined,
		analysisAuthority,
		authoritativeAnalysis: analysisAuthority.wholeObjectAuthoritative === true,
		authoritativeScope: analysisAuthority.authoritativeScope,
		analysisPipelineVersion: analysisAuthority.authoritative
			? 'server-deterministic-v1'
			: looksLikeLLM
				? 'server-llm-legacy-compatible'
				: 'server-api-flat-legacy-compatible'
	}

	return attachCompactEvidenceMeta(out, evidenceMeta)
}

export default { mapServerAnalyzeDataToClientAnalysis }
