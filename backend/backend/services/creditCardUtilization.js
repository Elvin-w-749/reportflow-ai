'use strict'

const CLOSED_CARD_RE = /销户|注销|关闭|销卡|作废|已结清|结清/
// 否定盲区：`未结清`/`尚未销户` 等否定短语不代表账户已关闭。
const NEGATED_CLOSED_CARD_RE = /(?:未|尚未|非)\s*(?:结清|还清|销户|注销|关闭|销卡|作废|终止|结转)/u
// PRD-DECISION-001：未激活信用卡计入账户数，但不参与使用率/负债汇总。
const NOT_ACTIVATED_CARD_RE = /^(?:尚未激活|未激活|待激活|尚未启用|未启用|未开卡)$/u

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

function amount(value) {
	const n = typeof value === 'number'
		? value
		: Number.parseFloat(String(value == null ? '' : value).replace(/[^0-9.+-]/g, ''))
	return Number.isFinite(n) && n > 0 ? n : 0
}

function compact(value) {
	return String(value || '').replace(/\s+/g, '').trim().toLowerCase()
}

function firstText(...values) {
	for (const value of values) {
		const text = String(value == null ? '' : value).trim()
		if (text) return text
	}
	return ''
}

function cardDescriptor(row) {
	return [
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
}

function detectCreditCardCurrency(row) {
	const descriptor = cardDescriptor(row)
	for (const [code, pattern] of CURRENCY_PATTERNS) {
		if (pattern.test(descriptor)) return code
	}
	return ''
}

function cardTail(row) {
	const explicit = firstText(
		row && row.card_tail,
		row && row.cardTail,
		row && row.tail_number,
		row && row.tailNumber,
		row && row.last4
	).replace(/\D/g, '').slice(-4)
	if (explicit.length === 4) return explicit
	const match = cardDescriptor(row).match(/(?:尾号|末四位|后四位|卡号后4位)\D{0,5}(\d{4})/)
	return match ? match[1] : ''
}

function normalizedDate(row) {
	return firstText(
		row && row.start_date,
		row && row.startDate,
		row && row.open_date,
		row && row.openDate
	).slice(0, 10)
}

function normalizedInstitution(row) {
	return compact(firstText(row && row.institution, row && row.bank, row && row.issuer))
}

function explicitSharedGroup(row) {
	return firstText(
		row && row.shared_credit_group,
		row && row.sharedCreditGroup,
		row && row.utilization_group,
		row && row.utilizationGroup
	)
}

function isClosedCardStatus(status) {
	const text = String(status || '')
	if (NEGATED_CLOSED_CARD_RE.test(text)) return false
	return CLOSED_CARD_RE.test(text)
}

function isNotActivatedCardStatus(status) {
	const text = String(status == null ? '' : status)
		.normalize('NFKC')
		.replace(/\s+/g, '')
		.replace(/[。.!！]/gu, '')
	return NOT_ACTIVATED_CARD_RE.test(text)
}

function activeCardRow(row) {
	if (!row || typeof row !== 'object' || row.isLoan === true) return false
	if (row.isSettled === true || row.is_settled === true) return false
	return !isClosedCardStatus(row.status)
}

function rowLimit(row) {
	return amount(row.credit_limit ?? row.creditLimit ?? row.limit ?? row.total_limit ?? row.totalLimit)
}

function rowUsed(row) {
	return amount(row.used_limit ?? row.usedLimit ?? row.used_amount ?? row.usedAmount ?? row.balance)
}

function chooseRepresentative(rows) {
	return [...rows].sort((a, b) => b.limit - a.limit || b.used - a.used || a.index - b.index)[0]
}

/**
 * 统一信用卡整体使用率口径。纯外币账户没有人民币等值金额时不参与人民币汇总；
 * 共享额度默认失败关闭，只有调用方明确启用且提供可信关系时才去重。
 */
function summarizeCreditCardUtilization(rows, options = {}) {
	// Shared-credit deduplication is fail-closed. Callers must opt in to both a
	// trusted explicit relation and any legacy heuristic; neither is inferred by
	// default from institution/date/tail similarities.
	const trustExplicitSharedGroup = options.trustExplicitSharedGroup === true
	const allowHeuristicSharedCredit = options.allowHeuristicSharedCredit === true
	const notActivatedDecisions = []
	const normalized = (Array.isArray(rows) ? rows : [])
		.map((row, index) => {
			if (!activeCardRow(row)) return null
			if (isNotActivatedCardStatus(row.status)) {
				notActivatedDecisions.push({
					index,
					included: false,
					groupKey: `row:${index}`,
					currency: detectCreditCardCurrency(row),
					reason: '未激活信用卡：计入账户数，不计入使用率与负债'
				})
				return null
			}
			const institution = normalizedInstitution(row)
			const startDate = normalizedDate(row)
			const tail = cardTail(row)
			const sharedGroup = trustExplicitSharedGroup ? explicitSharedGroup(row) : ''
			const currency = detectCreditCardCurrency(row)
			let groupKey = `row:${index}`
			let groupBasis = 'single'
			if (sharedGroup) {
				groupKey = `explicit:${compact(sharedGroup)}`
				groupBasis = 'explicit'
			} else if (allowHeuristicSharedCredit && institution && tail) {
				groupKey = `tail:${institution}|${tail}`
				groupBasis = 'tail'
			} else if (
				allowHeuristicSharedCredit &&
				institution &&
				startDate &&
				(currency || trustExplicitSharedGroup)
			) {
				groupKey = `date:${institution}|${startDate}`
				groupBasis = 'institution-date'
			}
			return {
				row,
				index,
				institution: firstText(row.institution, row.bank, row.issuer, '信用卡'),
				startDate,
				tail,
			currency,
				limit: rowLimit(row),
				used: rowUsed(row),
				groupKey,
				groupBasis
			}
		})
		.filter(Boolean)

	const grouped = new Map()
	for (const item of normalized) {
		if (!grouped.has(item.groupKey)) grouped.set(item.groupKey, [])
		grouped.get(item.groupKey).push(item)
	}

	// v2 权威路径关闭启发式合并时，仍把潜在共享关系作为“候选”交给
	// 证据账本/人工裁决。这里只返回行索引和判定依据，不暴露机构、卡尾等
	// 业务文本，也绝不能把候选关系直接用于额度去重。
	const candidateGroups = []
	if (!allowHeuristicSharedCredit) {
		const collectCandidates = (basis, keyOf) => {
			const candidates = new Map()
			for (const item of normalized) {
				if (explicitSharedGroup(item.row) && trustExplicitSharedGroup) continue
				const key = keyOf(item)
				if (!key) continue
				if (!candidates.has(key)) candidates.set(key, [])
				candidates.get(key).push(item)
			}
			for (const members of candidates.values()) {
				if (members.length < 2) continue
				candidateGroups.push({
					basis,
					memberIndexes: members.map((item) => item.index).sort((a, b) => a - b),
					affectsCnyAggregation: members.filter(
						(item) => item.currency === 'CNY' || !item.currency
					).length > 1
				})
			}
		}
		collectCandidates(
			'tail',
			(item) => item.institution && item.tail
				? `${compact(item.institution)}|${item.tail}`
				: ''
		)
		collectCandidates(
			'institution-date',
			(item) => item.institution && item.startDate
				? `${compact(item.institution)}|${item.startDate}`
				: ''
		)
		candidateGroups.sort((a, b) => {
			const basis = a.basis.localeCompare(b.basis)
			if (basis !== 0) return basis
			return a.memberIndexes.join(',').localeCompare(b.memberIndexes.join(','))
		})
	}

	const decisions = new Map()
	const groups = []
	let totalLimit = 0
	let totalUsed = 0
	let cardOutstanding = 0
	let foreignOnlyGroupCount = 0
	let inferredSharedGroupCount = 0
	let sharedGroupCount = 0

	const resolvedGroups = []
	for (const [groupKey, members] of grouped.entries()) {
		// 缺失卡尾时，「同机构 + 同开户日」并不足以证明是同一张卡。
		// 只有唯一人民币账户与外币伴生账户同时出现，才保守地推断为共享额度；
		// 多张人民币卡同日开户必须分别计入，不能因为去重而压低使用率。
		if (members[0].groupBasis === 'institution-date') {
			const cnyCount = members.filter((item) => item.currency === 'CNY').length
			const foreignCount = members.filter((item) => item.currency && item.currency !== 'CNY').length
			const unknownCount = members.filter((item) => !item.currency).length
			const canInferShared =
				(cnyCount === 1 && foreignCount > 0) ||
				(cnyCount === 0 && foreignCount === members.length) ||
				(trustExplicitSharedGroup && unknownCount === members.length && members.length > 1)
			if (!canInferShared) {
				for (const item of members) resolvedGroups.push([`row:${item.index}`, [item]])
				continue
			}
		}
		resolvedGroups.push([groupKey, members])
	}

	for (const [groupKey, members] of resolvedGroups) {
		const cny = members.filter((item) => item.currency === 'CNY')
		const unknown = members.filter((item) => !item.currency)
		const foreign = members.filter((item) => item.currency && item.currency !== 'CNY')
		const isShared = members.length > 1
		if (isShared) sharedGroupCount += 1
		if (isShared && members[0].groupBasis === 'institution-date') inferredSharedGroupCount += 1

		const candidates = cny.length > 0 ? cny : unknown
		const reason = cny.length > 0
			? (isShared ? '人民币主账户（共享额度）' : '人民币账户')
			: (isShared ? '旧报告同机构同开户日共享额度推断' : '单一可比账户')

		if (candidates.length === 0 && foreign.length > 0) {
			foreignOnlyGroupCount += 1
			for (const item of members) {
				decisions.set(item.index, {
					included: false,
					groupKey,
					currency: item.currency,
					reason: '纯外币账户缺少人民币等值金额，未计入整体使用率'
				})
			}
			groups.push({
				key: groupKey,
				institution: members[0].institution,
				startDate: members[0].startDate,
				included: false,
				limit: 0,
				used: 0,
				memberCount: members.length,
				reason: '纯外币账户未折算'
			})
			continue
		}

		const representative = chooseRepresentative(candidates)
		const groupLimit = candidates.reduce((max, item) => Math.max(max, item.limit), 0)
		const groupUsed = candidates.reduce((max, item) => Math.max(max, item.used), 0)
		const utilizationIncluded = groupLimit > 0
		cardOutstanding += groupUsed
		if (utilizationIncluded) {
			totalLimit += groupLimit
			totalUsed += groupUsed
		}

		for (const item of members) {
			const included = utilizationIncluded && item.index === representative.index
			let rowReason = reason
			if (!utilizationIncluded && item.index === representative.index) {
				rowReason = '零或未披露额度账户：余额计入信用卡余额/总负债，不计入使用率分子'
			} else if (!included) {
				rowReason = item.currency && item.currency !== 'CNY'
					? '外币/伴生子账户，不重复计入人民币额度'
					: '共享额度伴生账户，不重复计入整体使用率'
			}
			decisions.set(item.index, {
				included,
				groupKey,
				currency: item.currency,
				reason: rowReason
			})
		}

		groups.push({
			key: groupKey,
			institution: representative.institution,
			startDate: representative.startDate,
			included: utilizationIncluded,
			outstandingIncluded: true,
			limit: groupLimit,
			used: groupUsed,
			usageRate: groupLimit > 0 ? groupUsed / groupLimit : 0,
			memberCount: members.length,
			reason: utilizationIncluded
				? reason
				: '零或未披露额度账户余额仅计入信用卡余额/总负债'
		})
	}

	const rawTotalLimit = normalized.reduce((sum, item) => sum + item.limit, 0)
	const rawTotalUsed = normalized.reduce((sum, item) => sum + item.used, 0)
	const rowDecisions = [
		...normalized.map((item) => ({
			index: item.index,
			...(decisions.get(item.index) || {
				included: true,
				groupKey: item.groupKey,
				currency: item.currency,
				reason: '单一可比账户'
			})
		})),
		...notActivatedDecisions
	].sort((a, b) => a.index - b.index)

	return {
		totalLimit,
		totalUsed,
		cardOutstanding,
		usageRate: totalLimit > 0 ? totalUsed / totalLimit : 0,
		rawTotalLimit,
		rawTotalUsed,
		activeAccountCount: normalized.length,
		notActivatedAccountCount: notActivatedDecisions.length,
		utilizationGroupCount: groups.filter((group) => group.included).length,
		outstandingGroupCount: groups.filter((group) => group.outstandingIncluded).length,
		sharedGroupCount,
		inferredSharedGroupCount,
		foreignAccountCount: normalized.filter((item) => item.currency && item.currency !== 'CNY').length,
		foreignOnlyGroupCount,
		candidateGroups,
		hasSharedGroups: sharedGroupCount > 0,
		hasForeignCurrency: normalized.some((item) => item.currency && item.currency !== 'CNY'),
		groups,
		rowDecisions
	}
}

module.exports = { detectCreditCardCurrency, summarizeCreditCardUtilization, isNotActivatedCardStatus }
