import { statusIndicatesActiveUnsettled, statusIndicatesSettled } from '../utils/creditStatus.js'
import { firstStrictNonNegativeNumberOrNull, strictNonNegativeNumberOrNull } from '../utils/strictNumber.js'

const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== '')
const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {}

const numberOf = (value) => {
	return strictNonNegativeNumberOrNull(value)
}

export const debtBalanceOf = (account = {}) => firstStrictNonNegativeNumberOrNull(
  account.remainingAmount,
  account.remaining_amount,
  account.balance,
  account.currentBalance,
  account.current_balance,
  account.loanBalance,
  account.loan_balance,
  account.usedLimit,
  account.used_limit,
  account.usedAmount,
  account.used_amount,
  account.used_card_limit,
  account.amount
)

export const debtMonthlyOf = (account = {}) => firstStrictNonNegativeNumberOrNull(
  account.monthlyPayment,
  account.monthly_payment,
  account.monthlyPay,
  account.monthly_pay,
  account.monthlyRepayment,
  account.monthly_repayment,
  account.repayAmount,
  account.repay_amount
)

export const debtLimitOf = (account = {}) => firstStrictNonNegativeNumberOrNull(
  account.limit,
  account.creditLimit,
  account.credit_limit,
  account.totalLimit,
  account.total_limit,
  account.loanAmount,
  account.loan_amount,
  account.totalAmount,
  account.total_amount
)

export const debtUtilizationPct = (account = {}) => {
  const limit = debtLimitOf(account)
  const balance = debtBalanceOf(account)
  if (limit == null || balance == null || limit <= 0) return null
  return Math.max(0, Math.min(999, Math.round((balance / limit) * 100)))
}

export const debtSettlementState = (account = {}) => {
  if (typeof account.isSettled === 'boolean') return account.isSettled
  if (typeof account.settled === 'boolean') return account.settled
	const rawStatus = first(account.status, account.accountStatus, account.account_status, '')
	const status = typeof rawStatus === 'string' ? rawStatus.trim().toLowerCase() : ''
	if (statusIndicatesSettled(status)) return true
	if (statusIndicatesActiveUnsettled(status)) return false
	return null
}

export const isSettledDebtAccount = (account = {}) => {
  return debtSettlementState(account) === true
}

export const debtInclusionState = (account = {}) => {
	const hasCamel = Object.prototype.hasOwnProperty.call(account, 'utilizationIncluded')
	const hasSnake = Object.prototype.hasOwnProperty.call(account, 'utilization_included')
	if (!hasCamel && !hasSnake) return true
	const value = hasCamel ? account.utilizationIncluded : account.utilization_included
	if (typeof value === 'boolean') return value
	if (value === 1 || value === '1') return true
	if (value === 0 || value === '0') return false
	return null
}

export const isDebtAccountIncluded = (account = {}) => debtInclusionState(account) !== false

export const resolveDebtAccountEvidence = (account = {}) => {
  const balance = debtBalanceOf(account)
  const limit = debtLimitOf(account)
  const monthly = debtMonthlyOf(account)
  const settled = debtSettlementState(account)
	const included = debtInclusionState(account)
  return {
    balance,
    balanceKnown: balance != null,
    limit,
    limitKnown: limit != null,
    monthly,
    monthlyKnown: monthly != null,
    settled,
    settlementKnown: typeof settled === 'boolean',
		included,
		inclusionKnown: typeof included === 'boolean'
  }
}

const debtAccountCompleteness = (account = {}) => {
  let score = 0
  if (debtLimitOf(account) > 0) score += 16
  if (debtBalanceOf(account) > 0) score += 8
  if (debtMonthlyOf(account) > 0) score += 4
  if (first(account.endDate, account.end_date, account.dueDate, account.due_date, account.repayDate, account.repay_date)) score += 2
  if (first(account.overdueDays, account.overdue_days, account.maxOverdueDays, account.max_overdue_days) !== undefined) score += 1
  if (first(account.accountId, account.account_id, account.id, account._id)) score += 1
  return score
}

const debtAccountIdentity = (account = {}) => String(first(
  account.accountId,
  account.account_id,
  account.id,
  account._id,
  account.accountNo,
  account.account_no,
  ''
) || '').trim()

const sourceSettlementConflict = (left = {}, right = {}) => {
  const leftById = new Map(
    left.accounts
      .map((account) => [debtAccountIdentity(account), account])
      .filter(([id]) => id)
  )
  const directConflict = right.accounts.some((account) => {
    const id = debtAccountIdentity(account)
    if (!id || !leftById.has(id)) return false
    return isSettledDebtAccount(leftById.get(id)) !== isSettledDebtAccount(account)
  })
  if (directConflict) return true
  const leftSettled = left.accounts.filter(isSettledDebtAccount).length
  const rightSettled = right.accounts.filter(isSettledDebtAccount).length
  return leftSettled !== rightSettled
}

export const selectDebtAccountSource = (...sources) => sources
  .map((source, index) => ({
    index,
    accounts: Array.isArray(source)
      ? source.filter((account) => account && typeof account === 'object' && Object.keys(account).length > 0)
      : []
  }))
  .filter((source) => source.accounts.length > 0)
  .map((source) => ({
    ...source,
    accountCount: source.accounts.length,
    inclusionMetadataCount: source.accounts.filter((account) => (
      typeof account.utilizationIncluded === 'boolean' || typeof account.utilization_included === 'boolean'
    )).length,
    limitCount: source.accounts.filter((account) => isDebtAccountIncluded(account) && debtLimitOf(account) > 0).length,
    completeness: source.accounts.reduce((sum, account) => sum + debtAccountCompleteness(account), 0)
  }))
  .sort((left, right) => (
    right.accountCount - left.accountCount ||
    (sourceSettlementConflict(left, right) ? left.index - right.index : 0) ||
    right.inclusionMetadataCount - left.inclusionMetadataCount ||
    right.limitCount - left.limitCount ||
    right.completeness - left.completeness ||
    left.index - right.index
  ))[0]?.accounts || []

export const debtAccountsFromAnalysis = (analysisData = {}, normalizedAccounts = []) => {
  const rd = asObject(analysisData)
  const report = asObject(rd.report)
  const ai = asObject(rd.aiInsight)
  const kimi = asObject(rd.kimiInsight)
  const cv2Containers = [rd.creditReportV2, rd.credit_report_full, rd.credit_report_v2, rd.cv2]
    .map(asObject)
    .filter((value) => Object.keys(value).length > 0)
  const cv2Sources = cv2Containers.flatMap((cv2) => {
    const loanDetails = asObject(cv2.loan_details || cv2.loanDetails)
    const cards = Array.isArray(cv2.credit_card_details) ? cv2.credit_card_details : cv2.creditCardDetails
    const bankLoans = Array.isArray(loanDetails.bank_loans) ? loanDetails.bank_loans : loanDetails.bankLoans
    const nonBankLoans = Array.isArray(loanDetails.non_bank_loans) ? loanDetails.non_bank_loans : loanDetails.nonBankLoans
    const details = [
      ...(Array.isArray(cards) ? cards.map((account) => ({
        ...account,
        isLoan: false,
        type: first(account.type, account.accountType, account.account_type, account.cardType, account.card_type, '信用卡')
      })) : []),
      ...(Array.isArray(bankLoans) ? bankLoans.map((account) => ({ ...account, isLoan: true })) : []),
      ...(Array.isArray(nonBankLoans) ? nonBankLoans.map((account) => ({ ...account, isLoan: true })) : [])
    ]
    return [cv2.accounts, cv2.credit_accounts, cv2.creditAccounts, details]
  })
  return selectDebtAccountSource(
    rd.accounts,
    rd.creditAccounts,
    rd.credit_accounts,
    report.creditAccounts,
    report.credit_accounts,
    normalizedAccounts,
    ai.credit_accounts,
    kimi.credit_accounts,
    ...cv2Sources
  )
}

export const debtAggregateTotalFromAnalysis = (analysisData = {}) => {
  const rd = asObject(analysisData)
  const report = asObject(rd.report)
  const cv2Containers = [rd.creditReportV2, rd.credit_report_full, rd.credit_report_v2, rd.cv2]
    .map(asObject)
    .filter((value) => Object.keys(value).length > 0)
  const creditDebtSources = [
    rd.credit_debt,
    rd.creditDebt,
    ...cv2Containers.flatMap((cv2) => [cv2.credit_debt, cv2.creditDebt])
  ].map(asObject)
  const dimensionSources = [
    rd.dimensions,
    report.dimensions,
    ...cv2Containers.map((cv2) => cv2.dimensions)
  ].map(asObject)
  const values = [
    ...creditDebtSources.flatMap((source) => [
      source.total_debt,
      source.totalDebt,
      source.total_remaining,
      source.totalRemaining,
      source.remaining_amount,
      source.remainingAmount
    ]),
    ...dimensionSources.flatMap((source) => [
      source.totalDebt,
      source.total_debt,
      source.debtTotal,
      source.debt_total,
      source.totalRemaining,
      source.total_remaining
    ])
  ].map(numberOf).filter((value) => value != null && value >= 0)
  return values.length ? values[0] : null
}

export const resolveDebtTotalFromEvidence = (accounts = [], aggregateTotal = null) => {
  const rows = Array.isArray(accounts) ? accounts.filter((account) => account && typeof account === 'object') : []
  const evidence = rows.map(resolveDebtAccountEvidence)
  const accountEvidenceComplete = evidence.length > 0 && evidence.every((item) => (
		item.included === false || (
			item.inclusionKnown && item.included === true && item.settlementKnown && (item.settled === true || item.balanceKnown)
		)
  ))
  const activeTotal = accountEvidenceComplete
    ? evidence
		.filter((item) => item.included === true && item.settled === false)
      .reduce((sum, item) => sum + Math.max(0, item.balance), 0)
    : null
  const explicitZero = accountEvidenceComplete && activeTotal === 0
  const aggregate = numberOf(aggregateTotal)
  const useAccountEvidence = accountEvidenceComplete
  return {
	known: useAccountEvidence || (aggregate != null && aggregate >= 0),
    total: useAccountEvidence ? activeTotal : (aggregate != null && aggregate >= 0 ? aggregate : null),
    source: useAccountEvidence ? 'accounts' : (aggregate != null && aggregate >= 0 ? 'aggregate' : 'unavailable'),
    explicitZero
  }
}

export const resolveHomeDebtDisplay = (trustedTotalDebt, accounts = []) => {
	const totalDebt = numberOf(trustedTotalDebt)
	const rows = Array.isArray(accounts)
		? accounts.map((account, sourceIndex) => ({ account, sourceIndex })).filter(({ account }) => account && typeof account === 'object')
		: []
	const positiveBalanceRows = rows.filter(({ account }) => {
		const evidence = resolveDebtAccountEvidence(account)
		return evidence.included === true && evidence.balanceKnown && evidence.balance > 0
	})
	const archivalPositiveRows = rows.filter(({ account }) => {
		const evidence = resolveDebtAccountEvidence(account)
		return evidence.included === true && evidence.settlementKnown && evidence.settled === false && evidence.balanceKnown && evidence.balance > 0
	})
	const accountSetComplete = rows.length > 0 && rows.every(({ account }) => {
		const evidence = resolveDebtAccountEvidence(account)
		return evidence.included === false || (
			evidence.inclusionKnown && evidence.included === true && evidence.settlementKnown && (evidence.settled === true || evidence.balanceKnown)
		)
	})
	const archivalTotal = accountSetComplete
		? archivalPositiveRows.reduce((sum, { account }) => sum + debtBalanceOf(account), 0)
		: null
	if (totalDebt === 0) {
		const conflictReason = positiveBalanceRows.length > 0 ? 'owner-zero-archive-positive' : ''
		return {
			debtCount: 0,
			debtCountKnown: true,
			rows: [],
			archiveConflict: Boolean(conflictReason),
			conflictReason
		}
	}
	const conflictReason = totalDebt > 0
		? (!accountSetComplete
			? 'owner-positive-details-incomplete'
			: archivalPositiveRows.length === 0
				? 'owner-positive-archive-empty'
				: Math.abs(archivalTotal - totalDebt) > 0.01 ? 'owner-positive-archive-mismatch' : '')
		: ''
	return {
		debtCount: null,
		debtCountKnown: false,
		rows: archivalPositiveRows,
		archiveConflict: Boolean(conflictReason),
		conflictReason
	}
}

export const debtEvidenceConflictCopy = (reason) => {
	if (reason === 'owner-zero-archive-positive') {
		return {
			title: '当前负债已核验为 0',
			detail: '历史正余额明细与服务端当前总额冲突，已停止作为当前债务或账单展示。'
		}
	}
	if (reason === 'owner-positive-archive-empty') {
		return {
			title: '已核验存在负债，明细待闭合',
			detail: '历史明细均为 0 或已结清，与服务端当前正负债冲突，不能发布 0 笔或 ¥0。'
		}
	}
	if (reason === 'owner-positive-details-incomplete') {
		return {
			title: '已核验存在负债，明细待核对',
			detail: '账户余额、状态或完整集合尚未闭合，不能据此发布债务笔数或月应还。'
		}
	}
	if (reason === 'owner-positive-archive-mismatch') {
		return {
			title: '已核验负债与明细合计不一致',
			detail: '已知账户明细仅作部分展示；在当前总额与明细合计闭合前，不发布完整笔数或月应还。'
		}
	}
	return null
}

export const debtNavigationKey = (account = {}, fallbackIndex = 0) => {
  const sourceIndexRaw = Number(first(account.sourceIndex, account.source_index, fallbackIndex))
  const sourceIndex = Number.isInteger(sourceIndexRaw) && sourceIndexRaw >= 0 ? sourceIndexRaw : Math.max(0, Number(fallbackIndex) || 0)
  const rawIdentity = String(first(account.accountId, account.account_id, account.id, account._id, '') || '').trim()
  const identity = rawIdentity === `report_${sourceIndex}` ? '' : rawIdentity
  const signature = [
    sourceIndex,
    identity,
    first(account.accountNoLast4, account.account_no_last4, account.accountNo, account.account_no, ''),
    first(account.institution, account.bank, account.name, account.orgName, account.org_name, account.bankName, account.bank_name, account.lender, ''),
    first(account.debtName, account.accountType, account.account_type, account.type, account.productName, account.cardType, account.card_type, ''),
    debtBalanceOf(account),
    debtLimitOf(account)
  ].map((value) => String(value == null ? '' : value).trim().toLowerCase()).join('|')
  let hash = 2166136261
  for (let i = 0; i < signature.length; i += 1) {
    hash ^= signature.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `debt-nav-${sourceIndex}-${(hash >>> 0).toString(36)}`
}

export default {
  debtBalanceOf,
  debtMonthlyOf,
  debtLimitOf,
  debtUtilizationPct,
	debtSettlementState,
	debtInclusionState,
	resolveDebtAccountEvidence,
	resolveHomeDebtDisplay,
	debtEvidenceConflictCopy,
  isSettledDebtAccount,
  isDebtAccountIncluded,
  selectDebtAccountSource,
  debtAccountsFromAnalysis,
  debtAggregateTotalFromAnalysis,
  resolveDebtTotalFromEvidence,
  debtNavigationKey
}
