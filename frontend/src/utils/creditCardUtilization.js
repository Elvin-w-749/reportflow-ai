import { strictNonNegativeNumberOrNull } from './strictNumber.js'

const CLOSED_CARD_RE = /销户|注销|关闭|销卡|作废|已结清|结清/

const CURRENCY_PATTERNS = [
	['CNY', /人民币|\bCNY\b|\bRMB\b/i],
	['USD', /美元|美金|\bUSD\b/i],
	['EUR', /欧元|\bEUR\b/i],
	['JPY', /日元|\bJPY\b/i],
	['GBP', /英镑|\bGBP\b/i],
	['HKD', /港币|港元|香港元|\bHKD\b/i],
	['AUD', /澳大利亚元|澳元|\bAUD\b/i],
	['NZD', /新西兰元|纽元|\bNZD\b/i],
	['CAD', /加拿大元|加元|\bCAD\b/i],
	['CHF', /瑞士法郎|瑞郎|\bCHF\b/i],
	['SGD', /新加坡元|新元|\bSGD\b/i],
	['MOP', /澳门元|澳门币|\bMOP\b/i]
]

const compact = (value) => String(value || '').replace(/\s+/g, '').trim().toLowerCase()

const firstText = (...values) => {
	for (const value of values) {
		const text = String(value == null ? '' : value).trim()
		if (text) return text
	}
	return ''
}

const firstOwn = (row, keys) => {
	const source = row && typeof row === 'object' ? row : {}
	const nestedRaw = source.raw && typeof source.raw === 'object' && !Array.isArray(source.raw) ? source.raw : null
	for (const candidate of [source, nestedRaw].filter(Boolean)) {
		for (const key of keys) {
			if (!Object.prototype.hasOwnProperty.call(candidate, key)) continue
			const value = candidate[key]
			if (value !== undefined && value !== null && value !== '') return value
		}
	}
	return undefined
}

const nonNegativeAmount = (value) => {
	return strictNonNegativeNumberOrNull(value)
}

const explicitBoolean = (value) => {
	if (value === true || value === false) return value
	if (value === 1 || value === '1') return true
	if (value === 0 || value === '0') return false
	const text = String(value == null ? '' : value).trim().toLowerCase()
	if (/^(?:true|yes|y|include|included|是|计入)$/.test(text)) return true
	if (/^(?:false|no|n|exclude|excluded|否|不计入|排除)$/.test(text)) return false
	return null
}

const cardDescriptor = (row) => [
	row && row.currency,
	row && row.currency_code,
	row && row.currencyCode,
	row && row.account_type,
	row && row.accountType,
	row && row.card_type,
	row && row.cardType,
	row && row.type,
	row && row.product
].filter(Boolean).join(' ')

export const detectCreditCardCurrency = (row) => {
	const descriptor = cardDescriptor(row)
	for (const [code, pattern] of CURRENCY_PATTERNS) {
		if (pattern.test(descriptor)) return code
	}
	return ''
}

const activeCardRow = (row) => {
	if (!row || typeof row !== 'object' || row.isLoan === true) return false
	if (row.isSettled === true || row.is_settled === true) return false
	return !CLOSED_CARD_RE.test(String(row.status || ''))
}

const rowLimit = (row) => nonNegativeAmount(
	row.credit_limit ?? row.creditLimit ?? row.limit ?? row.total_limit ?? row.totalLimit
)

const rowUsed = (row) => nonNegativeAmount(
	row.used_limit ?? row.usedLimit ?? row.used_amount ?? row.usedAmount ?? row.balance
)

const rowIdentity = (row) => firstText(
	firstOwn(row, ['account_id', 'accountId', 'card_id', 'cardId', 'id', '_id'])
)

const normalizedRole = (row) => {
	const raw = compact(firstText(
		firstOwn(row, [
			'shared_limit_role', 'sharedLimitRole',
			'utilization_role', 'utilizationRole',
			'relationship_role', 'relationshipRole'
		])
	))
	if (/^(?:parent|primary|main|facility|父|主账户|主卡)$/.test(raw)) return 'parent'
	if (/^(?:child|secondary|companion|supplementary|子|子账户|附属卡|伴生账户)$/.test(raw)) return 'child'
	return ''
}

const usableGroupId = (value) => {
	const text = firstText(value)
	if (!text || /^(?:row|tail|date):/i.test(text)) return ''
	const normalized = compact(text.replace(/^explicit:/i, ''))
	if (/^(?:无|否|不共享|未共享|无共享|未设置|无设置|不适用|n\/a|na|none|null|-|--)$/.test(normalized)) return ''
	return normalized
}

const explicitRelation = (row) => {
	const sharedGroup = usableGroupId(firstOwn(row, [
		'shared_credit_group', 'sharedCreditGroup',
		'shared_limit_group', 'sharedLimitGroup',
		'credit_facility_id', 'creditFacilityId'
	]))
	if (sharedGroup) return { key: `shared:${sharedGroup}`, basis: 'explicit-shared-group' }

	const utilizationGroup = usableGroupId(firstOwn(row, ['utilization_group', 'utilizationGroup']))
	if (utilizationGroup) return { key: `shared:${utilizationGroup}`, basis: 'explicit-utilization-group' }

	const parentId = usableGroupId(firstOwn(row, [
		'parent_account_id', 'parentAccountId',
		'parent_card_id', 'parentCardId',
		'shared_limit_parent_id', 'sharedLimitParentId'
	]))
	if (parentId) return { key: `parent:${parentId}`, basis: 'explicit-parent-child' }

	const role = normalizedRole(row)
	const ownId = usableGroupId(rowIdentity(row))
	if (role === 'parent' && ownId) return { key: `parent:${ownId}`, basis: 'explicit-parent-child' }
	return null
}

const cnyEquivalent = (row, currency, limit, used) => {
	const explicitLimit = nonNegativeAmount(firstOwn(row, [
		'cny_credit_limit', 'cnyCreditLimit', 'credit_limit_cny', 'creditLimitCny',
		'rmb_credit_limit', 'rmbCreditLimit', 'cny_equivalent_limit', 'cnyEquivalentLimit'
	]))
	const explicitUsed = nonNegativeAmount(firstOwn(row, [
		'cny_used_limit', 'cnyUsedLimit', 'used_limit_cny', 'usedLimitCny',
		'rmb_used_limit', 'rmbUsedLimit', 'cny_equivalent_used', 'cnyEquivalentUsed'
	]))
	if (explicitLimit != null && explicitLimit > 0 && explicitUsed != null) {
		return { limit: explicitLimit, used: explicitUsed, basis: 'explicit-cny-equivalent' }
	}

	const exchangeRate = nonNegativeAmount(firstOwn(row, [
		'exchange_rate_to_cny', 'exchangeRateToCny', 'fx_rate_to_cny', 'fxRateToCny',
		'cny_exchange_rate', 'cnyExchangeRate'
	]))
	if (currency && currency !== 'CNY' && exchangeRate != null && exchangeRate > 0 && limit > 0) {
		return {
			limit: limit * exchangeRate,
			used: used * exchangeRate,
			basis: 'explicit-cny-exchange-rate'
		}
	}
	return null
}

const chooseRepresentative = (rows) => [...rows].sort((left, right) => (
	Number(right.explicitIncluded === true) - Number(left.explicitIncluded === true) ||
	Number(right.role === 'parent') - Number(left.role === 'parent') ||
	right.limit - left.limit ||
	right.used - left.used ||
	left.index - right.index
))[0]

const exclusionReason = (item, grouped = false) => {
	if (item.explicitIncluded === false) return '报告明确标记不计入主人民币使用率'
	if (item.role === 'child') return '报告明确标记为共享额度子账户，不重复计入'
	if (grouped) return '报告明确标记为共享额度伴生账户，不重复计入'
	return '账户未计入主人民币使用率'
}

/**
 * 信用卡主人民币使用率聚合。
 *
 * 安全边界：
 * - 共享额度只认报告明确提供的 shared group、parent-child 或逐行计入标记；
 * - 卡尾、机构、开户日相同都不是共享关系证据，每行仍独立；
 * - 外币/未知币种只有明确人民币等值金额或兑换率时才能计入；
 * - 明确排除会标为 excluded，其余不可比较行标为 unknown，并令整体使用率未知。
 */
export function summarizeCreditCardUtilization(rows) {
	const normalized = (Array.isArray(rows) ? rows : [])
		.map((row, index) => {
			if (!activeCardRow(row)) return null
			const rawLimit = rowLimit(row)
			const rawUsed = rowUsed(row)
			const currency = detectCreditCardCurrency(row)
			const relation = explicitRelation(row)
			const explicitIncluded = explicitBoolean(firstOwn(row, ['utilization_included', 'utilizationIncluded']))
			const role = normalizedRole(row)
			const converted = cnyEquivalent(row, currency, rawLimit, rawUsed)
			const amountsKnown = rawLimit != null && rawUsed != null
			const comparable = amountsKnown && (currency === 'CNY' || converted != null || (!currency && explicitIncluded === true))
			return {
				row,
				index,
				institution: firstText(row.institution, row.bank, row.issuer, '信用卡'),
				currency,
				rawLimit,
				rawUsed,
				limit: converted ? converted.limit : rawLimit,
				used: converted ? converted.used : rawUsed,
				conversionBasis: converted ? converted.basis : (currency === 'CNY' ? 'reported-cny' : (!currency && explicitIncluded === true ? 'explicit-inclusion' : '')),
				explicitIncluded,
				role,
				relation,
				groupKey: relation ? relation.key : `row:${index}`,
				groupBasis: relation ? relation.basis : 'independent-row',
				comparable
			}
		})
		.filter(Boolean)

	const grouped = new Map()
	for (const item of normalized) {
		if (!grouped.has(item.groupKey)) grouped.set(item.groupKey, [])
		grouped.get(item.groupKey).push(item)
	}

	const decisions = new Map()
	const groups = []
	let totalLimit = 0
	let totalUsed = 0
	let cardOutstanding = 0
	let sharedGroupCount = 0
	let unknownAccountCount = 0
	let excludedAccountCount = 0
	let foreignOnlyGroupCount = 0

	const mark = (item, status, reason, included = false) => {
		if (status === 'unknown') unknownAccountCount += 1
		if (status === 'excluded') excludedAccountCount += 1
		decisions.set(item.index, {
			included,
			status,
			groupKey: item.groupKey,
			groupBasis: item.groupBasis,
			currency: item.currency,
			conversionBasis: item.conversionBasis,
			reason
		})
	}

	for (const [groupKey, members] of grouped.entries()) {
		const groupedByEvidence = members[0].groupBasis !== 'independent-row'
		if (groupedByEvidence && members.length > 1) sharedGroupCount += 1
		const comparable = members.filter((item) => item.comparable && item.explicitIncluded !== false && item.role !== 'child')
		const explicitlyIncluded = comparable.filter((item) => item.explicitIncluded === true)
		const explicitParents = comparable.filter((item) => item.role === 'parent')
		const ambiguousSelection = explicitlyIncluded.length > 1 || (!explicitlyIncluded.length && explicitParents.length > 1)
		const representative = ambiguousSelection
			? null
			: chooseRepresentative(explicitlyIncluded.length ? explicitlyIncluded : (explicitParents.length ? explicitParents : comparable))

		if (!representative) {
			const allExplicitlyExcluded = members.every((item) => item.explicitIncluded === false)
			if (members.every((item) => item.currency && item.currency !== 'CNY' && !item.conversionBasis)) foreignOnlyGroupCount += 1
			for (const item of members) {
				if (item.explicitIncluded === false) mark(item, 'excluded', exclusionReason(item, groupedByEvidence))
				else mark(item, 'unknown', ambiguousSelection
					? '共享额度组存在多个计入/父账户标记，无法确定人民币主账户'
					: '缺少可比较的人民币金额或明确人民币折算证据')
			}
			groups.push({
				key: groupKey,
				institution: members[0].institution,
				included: false,
				status: allExplicitlyExcluded ? 'excluded' : 'unknown',
				limit: 0,
				used: 0,
				memberCount: members.length,
				basis: members[0].groupBasis,
				reason: allExplicitlyExcluded ? '报告明确标记全部不计入主人民币使用率' : '人民币主账户金额未知'
			})
			continue
		}

		const utilizationIncluded = representative.limit > 0
		cardOutstanding += representative.used
		if (utilizationIncluded) {
			totalLimit += representative.limit
			totalUsed += representative.used
		}
		for (const item of members) {
			if (item.index === representative.index) {
				if (utilizationIncluded) {
					mark(item, 'included', item.conversionBasis === 'reported-cny'
						? (groupedByEvidence ? '明确共享关系中的人民币主账户' : '独立人民币账户')
						: `按${item.conversionBasis || '明确计入标记'}计入人民币使用率`, true)
				} else {
					mark(item, 'excluded', '零或未披露额度账户：余额计入信用卡余额/总负债，不计入使用率分子')
				}
				continue
			}
			if (item.explicitIncluded === false || item.role === 'child' || groupedByEvidence) {
				mark(item, 'excluded', exclusionReason(item, groupedByEvidence))
			} else {
				mark(item, 'unknown', '币种或人民币折算关系未知，未计入主人民币使用率')
			}
		}
		groups.push({
			key: groupKey,
			institution: representative.institution,
			included: utilizationIncluded,
			outstandingIncluded: true,
			status: utilizationIncluded ? 'computed' : 'not_applicable',
			limit: representative.limit,
			used: representative.used,
			usageRate: representative.limit > 0 ? representative.used / representative.limit : 0,
			memberCount: members.length,
			basis: representative.groupBasis,
			reason: utilizationIncluded
				? (groupedByEvidence ? '按报告明确共享关系计入一次' : '独立人民币账户')
				: '零或未披露额度账户余额仅计入信用卡余额/总负债'
		})
	}

	const rawAmountsKnown = normalized.every((item) => item.rawLimit != null && item.rawUsed != null)
	const rawTotalLimit = rawAmountsKnown ? normalized.reduce((sum, item) => sum + item.rawLimit, 0) : null
	const rawTotalUsed = rawAmountsKnown ? normalized.reduce((sum, item) => sum + item.rawUsed, 0) : null
	const status = unknownAccountCount > 0 ? 'unknown' : (totalLimit > 0 ? 'computed' : 'not_applicable')
	const rowDecisions = normalized.map((item) => ({
		index: item.index,
		...(decisions.get(item.index) || {
			included: false,
			status: 'unknown',
			groupKey: item.groupKey,
			groupBasis: item.groupBasis,
			currency: item.currency,
			conversionBasis: item.conversionBasis,
			reason: '账户使用率证据未知'
		})
	}))

	return {
		status,
		decisionEligible: status !== 'unknown',
		totalLimit,
		totalUsed,
		cardOutstanding,
		usageRate: status === 'unknown' ? null : (totalLimit > 0 ? totalUsed / totalLimit : 0),
		rawTotalLimit,
		rawTotalUsed,
		activeAccountCount: normalized.length,
		includedAccountCount: rowDecisions.filter((item) => item.status === 'included').length,
		outstandingAccountCount: groups.filter((group) => group.outstandingIncluded).length,
		unknownAccountCount,
		excludedAccountCount,
		utilizationGroupCount: groups.filter((group) => group.included).length,
		sharedGroupCount,
		inferredSharedGroupCount: 0,
		foreignAccountCount: normalized.filter((item) => item.currency && item.currency !== 'CNY').length,
		foreignOnlyGroupCount,
		hasSharedGroups: sharedGroupCount > 0,
		hasForeignCurrency: normalized.some((item) => item.currency && item.currency !== 'CNY'),
		hasUnknownCurrency: normalized.some((item) => !item.currency),
		groups,
		rowDecisions
	}
}

export default { detectCreditCardCurrency, summarizeCreditCardUtilization }
