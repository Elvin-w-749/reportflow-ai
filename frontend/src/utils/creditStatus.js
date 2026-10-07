const NEGATED_OVERDUE_PATTERNS = [
	/(?:未|无|从未|从无|没有|不存在|未发生|未出现)(?:任何|过)?逾期/gi,
	/逾期(?:记录|情况|账户|月份|月数|次数)?(?:为|共|合计)?\s*(?:0|零|无)(?:个|次|月|笔)?/gi,
	/(?:not|never|no)\s+overdue/gi
]

const ZERO_OVERDUE_COUNT_PATTERNS = [
	/(?:有|共|合计)?\s*(?:0|零)\s*个?月[^。；，,]*处于逾期状态/gi,
	/(?:逾期|overdue)[^。；，,]{0,12}(?:count|months?|次数|月数|月份数)?\s*[:：=]?\s*0/gi
]

const OVERDUE_STATUS_RE = /逾期|overdue/i
const OTHER_ABNORMAL_STATUS_RE = /呆账|不良|关注|次级|可疑|损失|核销|止付|冻结/i
const UNKNOWN_ACCOUNT_STATUS_RE = /^(?:unknown|unspecified|unclassified|pending|pending_review|n\/?a|na|null|none|-|--|未知|不详|待核对|待确认|未识别|无法确认)$/i
const SETTLED_ACCOUNT_STATUS_RE = /^(?:paid[_ -]?off|settled|closed|cancelled|canceled|written[_ -]?off|已结清|结清|已还清|关闭|已关闭|销户|已销户|销卡|已销卡|注销|已注销|核销)$/i
const ACTIVE_ACCOUNT_STATUS_RE = /^(?:active|open|current|normal|performing|overdue|在用|活跃|正常|未结清|尚未结清|未还清|未关闭|尚未销户|未销卡|未注销|逾期|呆账|不良|关注|次级|可疑|损失|止付|冻结)$/i

export const statusIsUnknown = (value) => {
	const text = String(value == null ? '' : value).normalize('NFKC').trim()
	return !text || UNKNOWN_ACCOUNT_STATUS_RE.test(text)
}

export const statusIndicatesSettled = (value) => {
	const text = String(value == null ? '' : value).normalize('NFKC').trim()
	if (statusIsUnknown(text)) return false
	if (/(?:未|尚未)(?:结清|还清|关闭|销户|销卡|注销)/.test(text)) return false
	return SETTLED_ACCOUNT_STATUS_RE.test(text)
}

export const statusIndicatesActiveUnsettled = (value) => {
	const text = String(value == null ? '' : value).normalize('NFKC').trim()
	if (statusIsUnknown(text) || statusIndicatesSettled(text)) return false
	if (ACTIVE_ACCOUNT_STATUS_RE.test(text)) return true
	return statusIndicatesOverdue(text) || OTHER_ABNORMAL_STATUS_RE.test(text)
}

/**
 * Remove phrases that explicitly assert the absence of overdue facts before
 * applying substring-based rules. Numeric overdue evidence is handled by the
 * caller and must take precedence over this text helper.
 */
export const stripNegatedOverduePhrases = (value) => {
	let text = String(value == null ? '' : value)
	for (const pattern of [...NEGATED_OVERDUE_PATTERNS, ...ZERO_OVERDUE_COUNT_PATTERNS]) {
		text = text.replace(pattern, ' ')
	}
	return text.replace(/\s+/g, ' ').trim()
}

export const statusIndicatesOverdue = (value) =>
	OVERDUE_STATUS_RE.test(stripNegatedOverduePhrases(value))

export const statusExplicitlyDeniesOverdue = (value) => {
	const original = String(value == null ? '' : value).trim()
	if (!original) return false
	const remaining = stripNegatedOverduePhrases(original)
	return remaining !== original && !OVERDUE_STATUS_RE.test(remaining)
}

export const statusIndicatesAbnormal = (value) => {
	const remaining = stripNegatedOverduePhrases(value)
	return OVERDUE_STATUS_RE.test(remaining) || OTHER_ABNORMAL_STATUS_RE.test(remaining)
}

export default statusIndicatesOverdue
