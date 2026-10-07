import { getLatestReport, normalizeReportData } from './reportStorage.js'
import { resolveDecisionTotalDebt } from './decisionMetrics.js'
import { decisionReportIdOf } from './decisionTrust.js'
import { strictNonNegativeIntegerOrNull, strictNonNegativeNumberOrNull } from '../utils/strictNumber.js'
import { resolveDebtAccountEvidence, resolveHomeDebtDisplay } from './debtSummary.js'

export const REPAYMENT_REMINDER_KEY = 'debt_repay_reminder'
export const REPAYMENT_ITEM_REMINDER_KEY = 'debt_item_repay_reminders'
export const REPAYMENT_SMS_CONSENT_VERSION = '2026-07-07'

const storage = () => (typeof uni !== 'undefined' ? uni : null)
const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== '')
const num = (value) => {
	return strictNonNegativeNumberOrNull(value)
}
const pad = (n) => String(n).padStart(2, '0')
const reminderDayOrZero = (value) => {
	const day = strictNonNegativeIntegerOrNull(value)
	return day != null && day >= 1 && day <= 28 ? day : 0
}

export function todayIso() {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function formatMoney(value) {
	const n = num(value)
	if (n == null) return '—'
	if (n === 0) return '¥ 0'
	if (n < 0) return '—'
  if (n >= 10000) return `¥ ${(n / 10000).toFixed(1)} 万`
  return `¥ ${Math.round(n).toLocaleString()}`
}

export const resolveDebtReminderAmount = (item = {}) => {
	const monthly = item.monthlyKnown === true ? num(item.monthly) : null
	const balance = item.balanceKnown === true ? num(item.balance) : null
	const amount = monthly != null ? monthly : balance
	return {
		amount,
		amountKnown: amount != null,
		amountText: formatMoney(amount)
	}
}

function parseDate(value) {
	if (typeof value !== 'string') return null
	const raw = value.slice(0, 10)
	if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(raw)) return null
	const [year, month, day] = raw.split('-').map(Number)
	const d = new Date(year, month - 1, day)
	return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day ? d : null
}

export function daysBetween(from, to) {
  const a = parseDate(from)
  const b = parseDate(to)
  if (!a || !b) return null
  return Math.ceil((b.getTime() - a.getTime()) / 86400000)
}

export function readRepaymentReminderSetting() {
  const api = storage()
  if (!api) return normalizeRepaymentSetting()
  const saved = api.getStorageSync(REPAYMENT_REMINDER_KEY)
  return normalizeRepaymentSetting(saved)
}

export function saveRepaymentReminderSetting(setting = {}) {
  const current = readRepaymentReminderSetting()
  const next = normalizeRepaymentSetting({
    ...current,
    ...setting,
    enabled: setting.enabled !== undefined ? !!setting.enabled : !!current.enabled,
		day: setting.day !== undefined ? reminderDayOrZero(setting.day) : reminderDayOrZero(current.day),
    smsEnabled: setting.smsEnabled !== undefined ? !!setting.smsEnabled : !!current.smsEnabled,
    smsConsentAccepted: setting.smsConsentAccepted !== undefined ? !!setting.smsConsentAccepted : !!current.smsConsentAccepted
  })
  const api = storage()
  if (api) api.setStorageSync(REPAYMENT_REMINDER_KEY, next)
  return next
}

function normalizeRepaymentSetting(setting = {}) {
  const source = setting && typeof setting === 'object' ? setting : {}
	const day = reminderDayOrZero(source.day)
  const smsConsentAccepted = !!source.smsConsentAccepted
  const smsEnabled = !!source.smsEnabled && smsConsentAccepted
  return {
    enabled: !!source.enabled,
    day,
    smsEnabled,
    smsConsentAccepted,
    smsConsentAt: smsConsentAccepted ? String(source.smsConsentAt || '') : '',
    smsConsentVersion: smsConsentAccepted ? String(source.smsConsentVersion || REPAYMENT_SMS_CONSENT_VERSION) : ''
  }
}

export function canSendRepaymentSms(setting = readRepaymentReminderSetting()) {
  const normalized = normalizeRepaymentSetting(setting)
  return !!(normalized.enabled && normalized.day && normalized.smsEnabled && normalized.smsConsentAccepted)
}

export function readItemRepaymentReminders() {
  const api = storage()
  if (!api) return {}
  const saved = api.getStorageSync(REPAYMENT_ITEM_REMINDER_KEY)
  return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}
}

export function saveItemRepaymentReminders(items = {}) {
  const next = items && typeof items === 'object' && !Array.isArray(items) ? items : {}
  const api = storage()
  if (api) api.setStorageSync(REPAYMENT_ITEM_REMINDER_KEY, next)
  return next
}

function dueDateFromDay(day, anchor = new Date()) {
	const safeDay = reminderDayOrZero(day)
  if (!safeDay) return ''
  const candidate = new Date(anchor.getFullYear(), anchor.getMonth(), safeDay)
  const today = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())
  const target = candidate < today ? new Date(anchor.getFullYear(), anchor.getMonth() + 1, safeDay) : candidate
  return `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`
}

function reportAccountsOf(report) {
  const rd = report && report.analysisData
  if (!rd) return []
  const normalized = normalizeReportData(rd)
  const accounts = normalized.creditAccounts || rd.report?.creditAccounts || rd.accounts || rd.aiInsight?.credit_accounts || rd.kimiInsight?.credit_accounts || []
  return Array.isArray(accounts) ? accounts : []
}

function normalizeAccount(raw, index, reminderSetting) {
  const product = first(raw.debtName, raw.accountType, raw.account_type, raw.type, raw.productName, '信贷账户')
  const balance = num(first(raw.remainingAmount, raw.remaining_amount, raw.balance, raw.currentBalance, raw.loanBalance, raw.usedLimit, raw.used_card_limit, raw.amount))
  const monthly = num(first(raw.monthlyPayment, raw.monthly_payment, raw.monthlyPay, raw.repayAmount))
	const overdueDays = num(first(raw.overdueDays, raw.overdue_days, raw.maxOverdueDays))
	const dueDateRaw = first(raw.nextDueDate, raw.next_due_date, raw.endDate, raw.end_date, raw.dueDate, raw.due_date, raw.repayDate, '')
	const dueDate = typeof dueDateRaw === 'string' ? dueDateRaw.slice(0, 10) : ''
  const fallbackDueDate = reminderSetting.enabled && reminderSetting.day ? dueDateFromDay(reminderSetting.day) : ''
  const finalDueDate = parseDate(dueDate) ? dueDate : fallbackDueDate
  const dayDiff = finalDueDate ? daysBetween(todayIso(), finalDueDate) : null
	const overdueKnown = typeof raw.isOverdue === 'boolean' || overdueDays != null || dayDiff != null
	const isOverdue = raw.isOverdue === true || overdueDays > 0 || (dayDiff != null && dayDiff < 0)
	const amount = monthly != null ? monthly : balance
  return {
    id: String(first(raw._id, raw.id, `report_${index}`)),
    title: first(raw.bank, raw.institution, raw.name, raw.orgName, '未知机构'),
    product,
		amount,
		amountKnown: amount != null,
		amountText: formatMoney(amount),
    dueDate: finalDueDate,
    dueText: dayDiff == null ? (reminderSetting.enabled ? `每月 ${reminderSetting.day} 日提醒` : '待补还款日') : dayDiff < 0 ? '已过期' : dayDiff === 0 ? '今天到期' : `${dayDiff} 天后`,
    daysUntil: dayDiff,
		status: isOverdue ? '逾期' : overdueKnown ? '未还' : '待核对',
    source: 'report'
  }
}

function normalizeManualReminder(raw = {}, key) {
	const dueDate = typeof raw.dueDate === 'string' && parseDate(raw.dueDate) ? raw.dueDate.slice(0, 10) : ''
  const dayDiff = dueDate ? daysBetween(todayIso(), dueDate) : null
	const amount = num(raw.amount)
	const explicitAmountText = typeof raw.amountText === 'string' && raw.amountText.trim() ? raw.amountText.trim() : ''
  return {
    id: String(first(raw.id, key)),
    title: first(raw.title, '还款提醒'),
    product: first(raw.product, ''),
		amount,
		amountKnown: amount != null,
		amountText: explicitAmountText || (amount != null ? formatMoney(amount) : '按账单确认'),
    dueDate,
    dueText: first(raw.dueText, dayDiff == null ? '按账单日提醒' : `${dayDiff} 天后`),
    daysUntil: dayDiff,
    status: dayDiff != null && dayDiff < 0 ? '逾期' : '未还',
    source: 'manual',
    updatedAt: raw.updatedAt || ''
  }
}

export function buildRepaymentReminderSummary(report = getLatestReport()) {
  const reminderSetting = readRepaymentReminderSetting()
  const manualMap = readItemRepaymentReminders()
  const manualItems = Object.keys(manualMap).map((key) => normalizeManualReminder(manualMap[key], key))
	const sourceAccounts = reportAccountsOf(report)
	const trustedDebt = report
		? resolveDecisionTotalDebt(report.analysisData, report.decisionTrust || null, decisionReportIdOf(report))
		: { known: false, value: null }
	const hasReport = !!(report && report.analysisData)
	const explicitNoDebt = trustedDebt.known && trustedDebt.value === 0
	const accountSetComplete = sourceAccounts.length > 0 && sourceAccounts.every((item) => {
		const evidence = resolveDebtAccountEvidence(item)
		return evidence.included === false || (
			evidence.inclusionKnown && evidence.included === true && evidence.settlementKnown && (evidence.settled === true || evidence.balanceKnown)
		)
	})
	const reportAmountEvidenceKnown = explicitNoDebt || accountSetComplete
	const debtDisplay = resolveHomeDebtDisplay(trustedDebt.known ? trustedDebt.value : null, sourceAccounts)
	const reportArchiveConflict = debtDisplay.archiveConflict
	const reportConflictReason = debtDisplay.conflictReason
	const reportItems = explicitNoDebt ? [] : debtDisplay.rows.map(({ account, sourceIndex }) => (
		normalizeAccount(account, sourceIndex, reminderSetting)
	))
  const manualIds = new Set(manualItems.map((item) => item.id))
	const effectiveReportItems = reportItems.filter((item) => !manualIds.has(item.id))
  const items = [
    ...manualItems,
		...effectiveReportItems
  ].sort((a, b) => {
    const da = a.daysUntil == null ? 9999 : a.daysUntil
    const db = b.daysUntil == null ? 9999 : b.daysUntil
    return da - db
  })
	const reportComponentKnown = !hasReport || explicitNoDebt || (!reportArchiveConflict && (
			reportAmountEvidenceKnown &&
			effectiveReportItems.every((item) => item.amountKnown === true)
	))
	const manualComponentKnown = manualItems.every((item) => item.amountKnown === true)
	const hasApplicableEvidence = hasReport || manualItems.length > 0
	const monthDueKnown = hasApplicableEvidence && reportComponentKnown && manualComponentKnown
	const reportMonthDue = !hasReport || explicitNoDebt ? 0 : reportComponentKnown
		? effectiveReportItems.reduce((sum, item) => sum + item.amount, 0)
		: null
	const manualMonthDue = manualComponentKnown
		? manualItems.reduce((sum, item) => sum + item.amount, 0)
		: null
	const monthDue = monthDueKnown ? reportMonthDue + manualMonthDue : null
  const upcoming = items.filter((item) => item.daysUntil != null && item.daysUntil >= 0 && item.daysUntil <= 7)
  const overdue = items.filter((item) => item.status === '逾期' || (item.daysUntil != null && item.daysUntil < 0))
  return {
    setting: reminderSetting,
    smsReady: canSendRepaymentSms(reminderSetting),
    items,
    upcoming,
    overdue,
    manualCount: manualItems.length,
    accountCount: reportItems.length,
		monthDue,
		monthDueText: formatMoney(monthDue),
		monthDueKnown,
		reportAmountEvidenceKnown,
		explicitNoDebt,
		reportArchiveConflict,
		reportConflictReason,
		reportComponentKnown,
		manualComponentKnown,
		reportMonthDue,
		manualMonthDue,
    nextItem: upcoming[0] || items[0] || null,
		hasReport
  }
}

export default {
  buildRepaymentReminderSummary,
  readRepaymentReminderSetting,
  saveRepaymentReminderSetting,
  readItemRepaymentReminders,
  saveItemRepaymentReminders,
  canSendRepaymentSms,
  REPAYMENT_SMS_CONSENT_VERSION,
  formatMoney,
	resolveDebtReminderAmount,
  daysBetween,
  todayIso
}
