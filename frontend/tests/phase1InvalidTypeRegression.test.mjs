import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

import {
	strictFiniteNumberOrNull,
	strictNonNegativeIntegerOrNull,
	strictNonNegativeNumberOrNull
} from '../src/utils/strictNumber.js'
import { mapServerAnalyzeDataToClientAnalysis } from '../src/services/serverAnalyzeMapper.js'
import { buildParsedFromAINormalized, normalizeAIResult } from '../src/services/aiSchemaAdapter.js'
import {
	buildDebtStructureSegments,
	buildGuaranteeRowsForDetail,
	creditCardUsageRatePct,
	normalizeAccountForDetail,
	numberOrNull,
	summarizeAccountsForDetail
} from '../src/utils/reportDetailAggregates.js'
import {
	debtBalanceOf,
	debtEvidenceConflictCopy,
	debtSettlementState,
	resolveDebtTotalFromEvidence,
	resolveHomeDebtDisplay
} from '../src/services/debtSummary.js'
import {
	resolveDecisionAccountCount,
	resolveDecisionQueryCounts,
	resolveDecisionTotalDebt
} from '../src/services/decisionMetrics.js'
import {
	createOwnerApiDecisionTrust,
	decisionReportIdOf,
	decisionServerReportIdOf,
	normalizeDecisionReportId,
	resolveDecisionReportIdAliases,
	trustedDecisionValue
} from '../src/services/decisionTrust.js'
import { resolveV6ScoreDetails } from '../src/services/scoreV6.js'
import { ACTION_KEYS, resolveActionKey } from '../src/services/actionPolicy.js'
import { summarizeCreditCardUtilization } from '../src/utils/creditCardUtilization.js'
import {
	appendKnownReportScore,
	filterProductsByKnownMatchRate,
	matchRateOfProduct,
	summarizeKnownMatchRates
} from '../src/services/matchPresentation.js'

const invalidValues = [
	{}, [], [0], [27], true, false, Number.NaN,
	Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
	-1, '12x', '   '
]

const originalUni = globalThis.uni
const storage = new Map()
globalThis.uni = {
	getStorageSync: (key) => storage.get(key) ?? '',
	setStorageSync: (key, value) => storage.set(key, value),
	removeStorageSync: (key) => storage.delete(key),
	getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
	$emit: () => {}
}

const vite = await createServer({
	mode: 'production',
	define: { __RPT_PROD__: 'true' },
	server: { middlewareMode: true },
	appType: 'custom',
	logLevel: 'silent'
})
const reportStorage = await vite.ssrLoadModule('/src/services/reportStorage.js')
const repayment = await vite.ssrLoadModule('/src/services/repaymentReminderService.js')
const runtimeTrust = await vite.ssrLoadModule('/src/services/decisionTrust.js')
const deepseek = await vite.ssrLoadModule('/src/services/deepseekService.js')

after(async () => {
	await vite.close()
	if (originalUni === undefined) delete globalThis.uni
	else globalThis.uni = originalUni
})

const runtimeProjection = (id, totalDebt) => runtimeTrust.createOwnerApiDecisionTrust({
	id,
	decisionEvidenceLinked: true,
	evidenceVerified: true,
	decisionFlags: { totalDebt: true },
	totalDebt
})

const reportWithAccounts = ({ id, totalDebt, accounts }) => ({
	id,
	analysisData: { report: { creditAccounts: accounts } },
	decisionTrust: totalDebt === undefined ? null : runtimeProjection(id, totalDebt)
})

describe('phase 1 invalid-type and tri-state regressions', () => {
	it('accepts only finite scalar numeric primitives or complete numeric strings', () => {
		for (const value of invalidValues) {
			assert.equal(strictNonNegativeNumberOrNull(value), null, String(value))
			assert.equal(strictNonNegativeIntegerOrNull(value), null, String(value))
		}
		assert.equal(strictFiniteNumberOrNull(-1), -1)
		assert.equal(strictNonNegativeNumberOrNull(0), 0)
		assert.equal(strictNonNegativeNumberOrNull('0'), 0)
		assert.equal(strictNonNegativeNumberOrNull('12.5'), 12.5)
		assert.equal(strictNonNegativeNumberOrNull('1,234.50'), 1234.5)
		assert.equal(strictNonNegativeIntegerOrNull('12'), 12)
		assert.equal(strictNonNegativeIntegerOrNull('0.4'), null)
		assert.equal(strictNonNegativeNumberOrNull('1,23'), null)
	})

	it('rejects invalid numeric types through mapper and account aggregation', () => {
		for (const value of invalidValues) {
			assert.equal(normalizeAIResult({ debt_summary: { total_debt: value } }).debt_summary.total_debt, null, `AI ${String(value)}`)
			const mapped = mapServerAnalyzeDataToClientAnalysis({
				meta: {},
				credit_debt: { total_debt: value, credit_loans: {}, credit_cards: {} }
			})
			assert.equal(mapped.dimensions.totalDebt, null, `mapper ${String(value)}`)

			const account = normalizeAccountForDetail({ accountType: '贷款', status: '正常', balance: value })
			assert.equal(account.balance, null, `account ${String(value)}`)
			assert.equal(summarizeAccountsForDetail([account]).totalBalance, null, `summary ${String(value)}`)
			assert.equal(debtBalanceOf({ balance: value }), null, `debt ${String(value)}`)
		}
		assert.equal(numberOrNull([]), null)
		assert.equal(normalizeAccountForDetail({ status: '正常', balance: 0 }).balance, 0)
		assert.equal(normalizeAccountForDetail({ status: '正常', balance: 25 }).balance, 25)
		assert.equal(mapServerAnalyzeDataToClientAnalysis({ report: { totalScore: -1 } }).report.totalScore, null)
		assert.equal(mapServerAnalyzeDataToClientAnalysis({ report: { totalScore: [80] } }).report.totalScore, null)
		assert.equal(summarizeCreditCardUtilization([{ status: '正常', currency: 'CNY', credit_limit: [], used_limit: 0 }]).decisionEligible, false)
	})

	it('rejects invalid owner values before any score, debt, account, or query decision', () => {
		for (const value of invalidValues) {
			const id = `invalid-${invalidValues.indexOf(value)}`
			const projection = createOwnerApiDecisionTrust({
				id,
				decisionEvidenceLinked: true,
				evidenceVerified: true,
				decisionFlags: { score: true, totalDebt: true, accountCount: true, query6mCount: true },
				score: value,
				totalDebt: value,
				accountCount: value,
				query6mCount: value
			})
			assert.equal(trustedDecisionValue(projection, 'score', 'score', id), null)
			assert.equal(resolveDecisionTotalDebt({}, projection, id).known, false)
			assert.equal(resolveDecisionAccountCount({}, projection, id).known, false)
			assert.equal(resolveDecisionQueryCounts({}, projection, id).q6Known, false)
			assert.equal(resolveV6ScoreDetails({}, projection, id).decisionEligible, false)
		}

		const zero = createOwnerApiDecisionTrust({
			id: 'valid-zero', decisionEvidenceLinked: true, evidenceVerified: true,
			decisionFlags: { score: true, totalDebt: true, accountCount: true, query6mCount: true },
			score: 0, totalDebt: 0, accountCount: 0, query6mCount: 0
		})
		assert.equal(trustedDecisionValue(zero, 'score', 'score', 'valid-zero'), 0)
		assert.equal(resolveDecisionTotalDebt({}, zero, 'valid-zero').value, 0)
		assert.equal(resolveDecisionAccountCount({}, zero, 'valid-zero').value, 0)
		assert.equal(resolveDecisionQueryCounts({}, zero, 'valid-zero').q6, 0)

		const fractional = createOwnerApiDecisionTrust({
			id: 'fractional-count', decisionEvidenceLinked: true, evidenceVerified: true,
			decisionFlags: { accountCount: true, query6mCount: true }, accountCount: 0.4, query6mCount: 0.4
		})
		assert.equal(resolveDecisionAccountCount({}, fractional, 'fractional-count').known, false)
		assert.equal(resolveDecisionQueryCounts({}, fractional, 'fractional-count').q6Known, false)
		assert.equal(resolveActionKey({
			hasReport: true, score: [80], highRiskCount: 0, overdueAccountCount: 0, query6mCount: 0,
			scoreKnown: true, highRiskKnown: true, overdueKnown: true, queryKnown: true
		}), ACTION_KEYS.ADVISOR)

		const zeroId = createOwnerApiDecisionTrust({
			id: 0, decisionEvidenceLinked: true, evidenceVerified: true,
			decisionFlags: { totalDebt: true }, totalDebt: 0
		})
		assert.equal(resolveDecisionTotalDebt({}, zeroId, '0').known, false)
	})

	it('fails closed on every explicitly malformed report identity alias', () => {
		const ownerBase = {
			reportId: 'owner-good', id: 'owner-good', _id: 'owner-good',
			decisionEvidenceLinked: true,
			evidenceVerified: true,
			decisionFlags: { totalDebt: true },
			totalDebt: 0
		}
		for (const key of ['reportId', 'id', '_id']) {
			for (const invalid of [[], {}, 0]) {
				const projection = createOwnerApiDecisionTrust({ ...ownerBase, [key]: invalid })
				assert.equal(trustedDecisionValue(projection, 'totalDebt', 'totalDebt', 'owner-good'), null, `${key}:${String(invalid)}`)
			}
		}
		const mismatch = createOwnerApiDecisionTrust({ ...ownerBase, id: 'owner-other' })
		assert.equal(trustedDecisionValue(mismatch, 'totalDebt', 'totalDebt', 'owner-good'), null)
		const blankIsAbsent = createOwnerApiDecisionTrust({ ...ownerBase, reportId: '   ', _id: null })
		assert.equal(trustedDecisionValue(blankIsAbsent, 'totalDebt', 'totalDebt', 'owner-good'), 0)

		const strongAliases = ['cloudReportId', 'serverReportId', 'reportId', 'report_id', '_id']
		for (const key of strongAliases) {
			for (const invalid of [[], {}, 0]) {
				assert.equal(decisionReportIdOf({ id: 'fallback-good', [key]: invalid }), '', `${key}:${String(invalid)}`)
			}
		}
		for (const invalid of [[], {}, 0]) {
			assert.equal(decisionReportIdOf({ id: 'fallback-good', syncMeta: { cloudReportId: invalid } }), '')
		}
		assert.equal(decisionReportIdOf({ id: 'fallback-good', syncMeta: [] }), '')
		assert.equal(decisionReportIdOf({ id: 'local-id', cloudReportId: 'server-id', serverReportId: 'server-id' }), 'server-id')
		assert.equal(decisionReportIdOf({ id: 'local-id', cloudReportId: 'server-a', serverReportId: 'server-b' }), '')
		assert.equal(normalizeDecisionReportId(' report-good '), 'report-good')
		assert.equal(resolveDecisionReportIdAliases([['report-good'], 'report-good']), null)

		const expectedProjection = createOwnerApiDecisionTrust(ownerBase)
		for (const invalidExpected of [[], {}, 0]) {
			assert.equal(trustedDecisionValue(expectedProjection, 'totalDebt', 'totalDebt', invalidExpected), null)
		}

		assert.equal(decisionServerReportIdOf({ id: 'local-only' }), '')
		assert.equal(decisionServerReportIdOf({ cloudReportId: 'server-id', serverReportId: 'server-id' }), 'server-id')
		assert.equal(decisionServerReportIdOf({ cloudReportId: 'server-a', serverReportId: 'server-b' }), '')
		for (const invalid of [[], ['server-id'], {}, 0]) {
			assert.equal(decisionServerReportIdOf({ cloudReportId: invalid, serverReportId: 'server-id' }), '')
			assert.equal(decisionServerReportIdOf({ serverReportId: 'server-id', syncMeta: { cloudReportId: invalid } }), '')
		}

		assert.deepEqual(reportStorage.resolveCloudReportIdentity({ reportId: 'cloud-good' }, 'cloud-good'), {
			reportId: 'cloud-good', clientReportId: ''
		})
		assert.deepEqual(reportStorage.resolveCloudReportIdentity({ clientReportId: 'client-good' }, 'cloud-good'), {
			reportId: 'cloud-good', clientReportId: 'client-good'
		})
		assert.deepEqual(reportStorage.resolveCloudReportIdentity({ reportId: 'cloud-good', clientReportId: 'client-good' }, 'client-good'), {
			reportId: 'cloud-good', clientReportId: 'client-good'
		})
		for (const key of ['cloudReportId', 'serverReportId', 'reportId', 'report_id', '_id', 'id']) {
			for (const invalid of [[], {}, 0]) {
				assert.equal(reportStorage.resolveCloudReportIdentity({ [key]: invalid }, 'cloud-good'), null, `cloud ${key}:${String(invalid)}`)
			}
		}
		assert.equal(reportStorage.resolveCloudReportIdentity({ syncMeta: { cloudReportId: [] } }, 'cloud-good'), null)
		assert.equal(reportStorage.resolveCloudReportIdentity({ reportId: 'cloud-other' }, 'cloud-good'), null)
		assert.equal(reportStorage.resolveCloudReportIdentity({ reportId: 'cloud-good', clientReportId: 'client-other' }, 'client-good'), null)
		assert.equal(reportStorage.resolveCloudReportIdentity({ reportId: 'cloud-good', serverReportId: 'cloud-other' }), null)
		assert.equal(reportStorage.resolveCloudReportIdentity({ clientReportId: [] }, 'cloud-good'), null)

		for (const invalid of [[], ['match-good'], {}, 0, true]) {
			assert.throws(
				() => deepseek.buildMatchProductsRequest({ reportId: invalid }),
				(error) => error?.code === 'MATCH_REPORT_ID_REQUIRED'
			)
			const invalidResponse = deepseek.normalizeMatchProductsResponse({
				reportId: invalid, evidenceVerified: true, decisionEligible: true, products: [{ id: 'forged' }]
			}, 'match-good')
			assert.equal(invalidResponse.decisionEligible, false)
			assert.equal(invalidResponse.products.length, 0)
			const invalidExpected = deepseek.normalizeMatchProductsResponse({
				reportId: 'match-good', evidenceVerified: true, decisionEligible: true, products: [{ id: 'forged' }]
			}, invalid)
			assert.equal(invalidExpected.decisionEligible, false)
			assert.equal(invalidExpected.products.length, 0)
		}
		const validMatch = deepseek.normalizeMatchProductsResponse({
			reportId: 'match-good', evidenceVerified: true, decisionEligible: true, products: [{ id: 'valid' }]
		}, 'match-good')
		assert.equal(validMatch.products.length, 1)
	})

	it('keeps unknown account-status tokens unknown in every compatibility layer', () => {
		for (const status of ['unknown', 'UNKNOWN', '未知', '待核对']) {
			const detail = normalizeAccountForDetail({ accountType: '贷款', status, balance: 0 })
			assert.equal(detail.statusText, '待核对', status)
			assert.equal(detail.active, null, status)
			assert.equal(detail.settled, null, status)
			assert.equal(detail.overdueKnown, false, status)
			assert.equal(detail.abnormalKnown, false, status)

			const total = resolveDebtTotalFromEvidence([{ status, balance: 0 }], null)
			assert.deepEqual(total, { known: false, total: null, source: 'unavailable', explicitZero: false }, status)

			const parsed = buildParsedFromAINormalized({
				basic_info: {}, overdue_summary: {}, query_records: {},
				credit_report_full: {
					loan_details: { bank_loans: [{ institution: '甲机构', status, balance: 0 }], non_bank_loans: [] },
					credit_card_details: []
				}
			})
			assert.equal(parsed.creditAccounts[0].isSettled, null, status)
			assert.equal(parsed.creditAccounts[0].isOverdue, null, status)

			const mapped = mapServerAnalyzeDataToClientAnalysis({
				loan_details: { bank_loans: [{ institution: '乙机构', status, balance: 0 }], non_bank_loans: [] },
				credit_card_details: [], query_analysis: { summary: {} }
			})
			assert.equal(mapped.accounts[0].status, null, status)
			assert.equal(mapped.accounts[0].isSettled, null, status)
			assert.equal(mapped.accounts[0].isOverdue, null, status)
		}

		for (const flag of [[1], [0], {}, -1, 2, '12x']) {
			const invalidFlags = normalizeAccountForDetail({
				accountType: '贷记卡', status: 'unknown', balance: 0,
				isSettled: flag, isOverdue: flag, isLoan: flag, utilizationIncluded: flag
			})
			assert.equal(invalidFlags.settled, null, `settled ${String(flag)}`)
			assert.equal(invalidFlags.overdueKnown, false, `overdue ${String(flag)}`)
			assert.equal(invalidFlags.isLoan, false, `loan ${String(flag)}`)
			assert.equal(invalidFlags.utilizationIncluded, undefined, `utilization ${String(flag)}`)
			assert.deepEqual(
				resolveDebtTotalFromEvidence([{ status: '正常', balance: 0, utilizationIncluded: flag }], null),
				{ known: false, total: null, source: 'unavailable', explicitZero: false },
				`debt utilization ${String(flag)}`
			)
		}
	})

	it('does not infer active accounts from V2 totals without active_count or statuses', () => {
		const normalized = normalizeAIResult({
			meta: {},
			credit_debt: { credit_loans: {}, credit_cards: { card_count: 1 } },
			loan_details: { total: { count: 0 } }
		})
		assert.equal(normalized.account_overview.total_count, 1)
		assert.equal(normalized.account_overview.active_count, null)
		const { credit_report_full: _archivalV2, ...generic } = normalized
		const parsed = buildParsedFromAINormalized(generic)
		assert.equal(parsed.creditAccounts[0].isSettled, null)
		assert.equal(parsed.creditAccounts[0].status, null)

		const secondary = normalizeAIResult({ meta: {}, credit_debt: { total_debt: 25, credit_loans: {}, credit_cards: {} } })
		assert.equal(secondary.debt_summary.total_debt, 25)
		const explicitZero = normalizeAIResult({
			meta: {}, debt_summary: { total_debt: 0 },
			credit_debt: { total_debt: 25, credit_loans: {}, credit_cards: {} }
		})
		assert.equal(explicitZero.debt_summary.total_debt, 0)
	})

	it('requires complete V2 debt components and preserves an explicitly complete zero', () => {
		for (const value of [undefined, null, '', {}, [], true, -1, '12x']) {
			const bank = value === undefined ? {} : { balance: value }
			const result = buildDebtStructureSegments({
				creditReportV2: {
					loan_details: { subtotal_bank: bank, subtotal_non_bank: { balance: 0, count: 0 }, total: {} },
					credit_debt: { credit_cards: { total_used: 0, card_count: 0 } }
				}
			})
			assert.deepEqual(result, [], String(value))
		}

		const zero = buildDebtStructureSegments({
			creditReportV2: {
				loan_details: {
					subtotal_bank: { balance: 0, count: 0 },
					subtotal_non_bank: { balance: 0, count: 0 },
					total: { balance: 0 }
				},
				credit_debt: { total_debt: 0, credit_cards: { total_used: 0, card_count: 0 } }
			}
		})
		assert.deepEqual(zero.map(({ key, amount, amountKnown }) => ({ key, amount, amountKnown })), [
			{ key: 'bank', amount: 0, amountKnown: true },
			{ key: 'nonbank', amount: 0, amountKnown: true },
			{ key: 'card', amount: 0, amountKnown: true }
		])

		const nonzero = buildDebtStructureSegments({
			creditReportV2: {
				loan_details: {
					subtotal_bank: { balance: 25, count: 1 },
					subtotal_non_bank: { balance: 0, count: 0 },
					total: { balance: 25 }
				},
				credit_debt: { total_debt: 25, credit_cards: { total_used: 0, card_count: 0 } }
			}
		})
		assert.equal(nonzero.find((item) => item.key === 'bank').amount, 25)

		const partialAlgorithm = buildDebtStructureSegments({ algorithmReport: { breakdown: { bankLoan: { amount: 25 } } } })
		assert.equal(partialAlgorithm[0].amount, 25)
		assert.equal(partialAlgorithm[0].percent, null)
		assert.equal(partialAlgorithm.meta.total, null)
		assert.equal(partialAlgorithm.meta.componentsComplete, false)

		const partialSummary = buildDebtStructureSegments({ creditDebt: { loan: 25 } })
		assert.equal(partialSummary[0].amount, 25)
		assert.equal(partialSummary[0].percent, null)
		assert.equal(partialSummary.meta.total, null)
		assert.equal(partialSummary.meta.componentsComplete, false)
	})

	it('keeps incomplete overdue details nullable and never overwrites an explicit zero', () => {
		const incomplete = mapServerAnalyzeDataToClientAnalysis({
			meta: {}, credit_debt: { credit_loans: {}, credit_cards: {} },
			overdue_info: { details: [{ institution: '甲机构' }] }
		})
		assert.deepEqual(incomplete.overdueRecords[0], {
			bank: '甲机构', accountType: '', amount: null, days: null, level: 'unknown', date: ''
		})

		const zero = mapServerAnalyzeDataToClientAnalysis({
			loan_details: {
				bank_loans: [{ institution: '乙机构', status: '逾期', balance: 100, overdue_amount: 0, overdue_days: 1 }],
				non_bank_loans: []
			},
			credit_card_details: [], query_analysis: { summary: {} }
		})
		assert.equal(zero.overdueRecords[0].amount, 0)

		const missingAmount = mapServerAnalyzeDataToClientAnalysis({
			debt_summary: { total_debt: 25, total_credit_line: 100 },
			overdue_summary: { current_overdue_count: 1 },
			credit_cards: { overdue_count: 0 }, loan_accounts: { overdue_count: 0 },
			account_overview: {}, query_records: {}
		})
		const overdueSuggestion = missingAmount.report.suggestions.find((item) => item.trigger === 'overdue')
		assert.match(overdueSuggestion.desc, /逾期金额待核对/)
		assert.doesNotMatch(overdueSuggestion.desc, /逾期金额 0 元/)
	})

	it('does not publish utilization from a known-card subset when another card lifecycle is unknown', () => {
		const mapped = mapServerAnalyzeDataToClientAnalysis({
			credit_debt: {
				total_debt: 30,
				credit_loans: {},
				credit_cards: { total_limit: 100, total_used: 30, usage_rate: 0.3, card_count: 2 }
			},
			loan_details: { bank_loans: [], non_bank_loans: [] },
			credit_card_details: [
				{ institution: '甲机构', status: '正常', currency: 'CNY', credit_limit: 100, used_limit: 30 },
				{ institution: '乙机构', status: 'unknown', currency: 'CNY', credit_limit: 50, used_limit: 10 }
			],
			query_analysis: { summary: {} }
		})
		assert.equal(mapped.dimensions.cardUtilizationRate, null)
		assert.equal(mapped.dimensions.cardUtilizationStatus, 'unknown')
		assert.equal(mapped.dimensions.cardUtilizationDecisionEligible, false)
		assert.equal(mapped.accounts.find((account) => account.bank === '乙机构').isSettled, null)
		assert.equal(creditCardUsageRatePct({}, {}, []), null)
		assert.equal(creditCardUsageRatePct({ usage_rate_pct: 0 }, {}, []), 0)
		assert.equal(creditCardUsageRatePct({ usage_rate_pct: 25 }, {}, []), 25)
		assert.equal(creditCardUsageRatePct({ usage_rate: 0 }, {}, []), 0)
		assert.equal(creditCardUsageRatePct({}, { cardUtilizationRate: 0 }, []), 0)
		assert.equal(creditCardUsageRatePct({ usage_rate: [] }, {}, []), null)
	})

	it('derives guarantee rows and upload-only detail metadata without runtime fallbacks', () => {
		assert.deepEqual(buildGuaranteeRowsForDetail([
			{ institution: '甲机构', amount: 0 },
			{ institution: '乙机构', amount: 25 },
			{ institution: '丙机构', amount: [] }
		]), [
			{ key: 'gua_0', title: '甲机构', desc: '对外担保信息', amount: '¥ 0', amountKnown: true },
			{ key: 'gua_1', title: '乙机构', desc: '对外担保信息', amount: '¥ 25', amountKnown: true },
			{ key: 'gua_2', title: '丙机构', desc: '对外担保信息', amount: '—', amountKnown: false }
		])
		assert.deepEqual(reportStorage.getReportDateDisplayMeta({ createdAt: '2026-08-17T08:30:00Z' }), {
			reportDate: '', uploadDate: '2026-08-17', reportDateText: '报告日待核对', uploadDateText: '上传 2026-08-17'
		})
		for (const value of [0, '0', [], ['2025-06-30'], {}, true, '2025-02-31', '2025-13-01', 'x2025-06-30']) {
			assert.equal(reportStorage.getReportAnalysisDate({ reportDate: value }), '', `report date ${String(value)}`)
			assert.equal(reportStorage.getReportUploadDate({ createdAt: value }), '', `upload date ${String(value)}`)
		}
	})

	it('keeps storage counters unknown for invalid scalars and empty compatibility arrays', () => {
		for (const value of invalidValues) {
			const normalized = reportStorage.normalizeReportData({
				report: { debtCount: value, queryCount: value },
				dimensions: { overdueCount: value },
				overdueRecords: []
			})
			assert.equal(normalized.debtCount, null, `debt ${String(value)}`)
			assert.equal(normalized.queryCount, null, `query ${String(value)}`)
			assert.equal(normalized.overdueCount, null, `overdue ${String(value)}`)
		}
		const zero = reportStorage.normalizeReportData({
			report: { debtCount: 0, queryCount: 0 }, dimensions: { overdueCount: 0 }
		})
		assert.deepEqual([zero.debtCount, zero.queryCount, zero.overdueCount], [0, 0, 0])

		for (const value of [[], [0], [27], true, '   ', -1]) {
			storage.clear()
			reportStorage.saveReport({
				id: `summary-${String(value)}`,
				fileName: '测试报告.pdf',
				_accountCount: value,
				analysisData: { report: { totalScore: 70 } }
			}, { skipCloudSync: true })
			assert.equal(reportStorage.getReportList()[0]._accountCount, null, `summary ${String(value)}`)
		}
	})

	it('keeps owner totals, archive rows, and manual reminders as separate evidence components', () => {
		const manualKey = repayment.REPAYMENT_ITEM_REMINDER_KEY
		const setManual = (value) => {
			storage.clear()
			if (value !== undefined) storage.set(manualKey, { manual: { id: 'manual', title: '手工提醒', amount: value } })
		}

		setManual(undefined)
		const noEvidence = repayment.buildRepaymentReminderSummary(null)
		assert.equal(noEvidence.monthDue, null)
		assert.equal(noEvidence.monthDueKnown, false)

		setManual(undefined)
		const ownerZeroOnly = repayment.buildRepaymentReminderSummary(reportWithAccounts({
			id: 'report-zero-only', totalDebt: 0, accounts: []
		}))
		assert.equal(ownerZeroOnly.monthDue, 0)
		assert.equal(ownerZeroOnly.monthDueKnown, true)

		setManual(100)
		const manualOnly = repayment.buildRepaymentReminderSummary(null)
		assert.equal(manualOnly.monthDue, 100)
		assert.equal(manualOnly.monthDueKnown, true)

		setManual(100)
		const reportUnknown = repayment.buildRepaymentReminderSummary(reportWithAccounts({
			id: 'report-unknown', accounts: [{ status: 'unknown', balance: 50 }]
		}))
		assert.equal(reportUnknown.manualMonthDue, 100)
		assert.equal(reportUnknown.monthDue, null)
		assert.equal(reportUnknown.reportComponentKnown, false)

		setManual(100)
		const ownerZeroConflict = repayment.buildRepaymentReminderSummary(reportWithAccounts({
			id: 'report-zero', totalDebt: 0, accounts: [{ status: '正常', balance: 50 }]
		}))
		assert.equal(ownerZeroConflict.reportArchiveConflict, true)
		assert.equal(ownerZeroConflict.accountCount, 0)
		assert.equal(ownerZeroConflict.monthDue, 100)
		assert.equal(ownerZeroConflict.items.length, 1)

		setManual(100)
		const ownerPositiveZeroRows = repayment.buildRepaymentReminderSummary(reportWithAccounts({
			id: 'report-positive-zero', totalDebt: 50, accounts: [{ status: '正常', balance: 0 }]
		}))
		assert.equal(ownerPositiveZeroRows.reportArchiveConflict, true)
		assert.equal(ownerPositiveZeroRows.monthDue, null)

		setManual(100)
		const ownerPositive = repayment.buildRepaymentReminderSummary(reportWithAccounts({
			id: 'report-positive', totalDebt: 50, accounts: [{ status: '正常', balance: 50 }]
		}))
		assert.equal(ownerPositive.reportArchiveConflict, false)
		assert.equal(ownerPositive.monthDue, 150)

		setManual(100)
		const ownerPositiveMismatch = repayment.buildRepaymentReminderSummary(reportWithAccounts({
			id: 'report-positive-mismatch', totalDebt: 100, accounts: [{ status: '正常', balance: 50 }]
		}))
		assert.equal(ownerPositiveMismatch.reportConflictReason, 'owner-positive-archive-mismatch')
		assert.equal(ownerPositiveMismatch.reportMonthDue, null)
		assert.equal(ownerPositiveMismatch.monthDue, null)

		setManual(100)
		const settledArchive = repayment.buildRepaymentReminderSummary(reportWithAccounts({
			id: 'report-settled', accounts: [{ status: '已结清', balance: 50 }]
		}))
		assert.equal(settledArchive.monthDue, 100)
		assert.equal(settledArchive.accountCount, 0)

		setManual(100)
		const ownerPositiveSettled = repayment.buildRepaymentReminderSummary(reportWithAccounts({
			id: 'report-positive-settled', totalDebt: 50, accounts: [{ status: '已结清', balance: 50 }]
		}))
		assert.equal(ownerPositiveSettled.reportArchiveConflict, true)
		assert.equal(ownerPositiveSettled.monthDue, null)

		setManual(0)
		const manualZero = repayment.buildRepaymentReminderSummary(null)
		assert.equal(manualZero.monthDue, 0)
		assert.equal(manualZero.monthDueKnown, true)
		assert.equal(repayment.formatMoney({}), '—')
		assert.equal(repayment.formatMoney([]), '—')
		assert.equal(repayment.daysBetween(['2026-08-17'], '2026-08-18'), null)
		assert.equal(repayment.daysBetween('2026-02-31', '2026-03-01'), null)
		assert.deepEqual(repayment.resolveDebtReminderAmount({ monthlyKnown: true, monthly: 0, balanceKnown: true, balance: 50 }), {
			amount: 0, amountKnown: true, amountText: '¥ 0'
		})
		assert.deepEqual(repayment.resolveDebtReminderAmount({ monthlyKnown: false, monthly: null, balanceKnown: true, balance: 50 }), {
			amount: 50, amountKnown: true, amountText: '¥ 50'
		})
		assert.deepEqual(repayment.resolveDebtReminderAmount({ monthlyKnown: false, balanceKnown: false }), {
			amount: null, amountKnown: false, amountText: '—'
		})
		assert.deepEqual(repayment.resolveDebtReminderAmount({ monthlyKnown: true, monthly: 25, balanceKnown: true, balance: 50 }), {
			amount: 25, amountKnown: true, amountText: '¥ 25'
		})

		storage.clear()
		const producerPayload = repayment.resolveDebtReminderAmount({ monthlyKnown: true, monthly: 0, balanceKnown: true, balance: 50 })
		storage.set(manualKey, { producer: { id: 'producer', title: '页面生产提醒', ...producerPayload } })
		const producerRoundTrip = repayment.buildRepaymentReminderSummary(null)
		assert.equal(producerRoundTrip.items[0].amount, 0)
		assert.equal(producerRoundTrip.items[0].amountKnown, true)
		assert.equal(producerRoundTrip.monthDue, 0)

		storage.clear()
		storage.set(manualKey, { shared: { id: 'shared', title: '手工覆盖', amount: 100 } })
		const manualOverride = repayment.buildRepaymentReminderSummary(reportWithAccounts({
			id: 'report-manual-override', accounts: [{ id: 'shared', status: '正常', balance: 50 }]
		}))
		assert.equal(manualOverride.items.length, 1)
		assert.equal(manualOverride.monthDue, 100)

		setManual([])
		const invalidManual = repayment.buildRepaymentReminderSummary(null)
		assert.equal(invalidManual.manualComponentKnown, false)
		assert.equal(invalidManual.monthDue, null)
	})

	it('keeps Home and DebtManage current-debt displays consistent across owner and archive conflicts', () => {
		assert.deepEqual(resolveHomeDebtDisplay(0, [{ status: '正常', balance: 50 }]), {
			debtCount: 0, debtCountKnown: true, rows: [], archiveConflict: true,
			conflictReason: 'owner-zero-archive-positive'
		})
		assert.deepEqual(resolveHomeDebtDisplay(50, []), {
			debtCount: null, debtCountKnown: false, rows: [], archiveConflict: true,
			conflictReason: 'owner-positive-details-incomplete'
		})
		const positive = resolveHomeDebtDisplay(50, [{ status: '正常', balance: 50 }])
		assert.equal(positive.debtCountKnown, false)
		assert.equal(positive.debtCount, null)
		assert.equal(positive.rows.length, 1)
		assert.equal(positive.archiveConflict, false)
		assert.equal(positive.conflictReason, '')
		const incomplete = resolveHomeDebtDisplay(50, [{ status: 'unknown', balance: 50 }])
		assert.equal(incomplete.rows.length, 0)
		assert.equal(incomplete.debtCount, null)
		assert.equal(incomplete.conflictReason, 'owner-positive-details-incomplete')
		const zeroRows = resolveHomeDebtDisplay(50, [{ status: '正常', balance: 0 }])
		assert.equal(zeroRows.rows.length, 0)
		assert.equal(zeroRows.conflictReason, 'owner-positive-archive-empty')
		const settledRows = resolveHomeDebtDisplay(50, [{ status: '已结清', balance: 50 }])
		assert.equal(settledRows.rows.length, 0)
		assert.equal(settledRows.conflictReason, 'owner-positive-archive-empty')
		const mixedRows = resolveHomeDebtDisplay(50, [
			{ status: '正常', balance: 25 },
			{ status: 'unknown', balance: 25 }
		])
		assert.equal(mixedRows.rows.length, 1)
		assert.equal(mixedRows.conflictReason, 'owner-positive-details-incomplete')
		const mismatchedPositive = resolveHomeDebtDisplay(100, [{ status: '正常', balance: 50 }])
		assert.equal(mismatchedPositive.rows.length, 1)
		assert.equal(mismatchedPositive.conflictReason, 'owner-positive-archive-mismatch')
		const matchingPositive = resolveHomeDebtDisplay(100, [
			{ status: '正常', balance: 40 },
			{ status: '正常', balance: 60 }
		])
		assert.equal(matchingPositive.rows.length, 2)
		assert.equal(matchingPositive.archiveConflict, false)
		const archiveOnly = resolveHomeDebtDisplay(null, [{ status: '正常', balance: 50 }])
		assert.equal(archiveOnly.rows.length, 1)
		assert.equal(archiveOnly.archiveConflict, false)
		assert.equal(debtSettlementState({ status: ['正常'] }), null)
		assert.match(debtEvidenceConflictCopy('owner-zero-archive-positive').detail, /历史正余额/)
		assert.match(debtEvidenceConflictCopy('owner-positive-archive-empty').title, /已核验存在负债/)
		assert.doesNotMatch(debtEvidenceConflictCopy('owner-positive-archive-empty').detail, /已核验为 0/)
		assert.match(debtEvidenceConflictCopy('owner-positive-archive-mismatch').title, /合计不一致/)
	})

	it('preserves explicit zero and rejects invalid match rates and report scores', () => {
		for (const value of invalidValues) assert.equal(matchRateOfProduct({ matchRate: value }), null)
		assert.equal(matchRateOfProduct({ matchRate: 0 }), 0)
		assert.equal(matchRateOfProduct({ matchRate: 80 }), 80)
		assert.deepEqual(summarizeKnownMatchRates([], false), { known: false, best: null, highCount: null })
		assert.deepEqual(summarizeKnownMatchRates([], true), { known: true, best: null, highCount: 0 })
		assert.deepEqual(summarizeKnownMatchRates([{ matchRate: 0 }], true), { known: true, best: 0, highCount: 0 })
		assert.deepEqual(summarizeKnownMatchRates([{ matchRate: [] }], true), { known: false, best: null, highCount: null })
		assert.equal(filterProductsByKnownMatchRate([{ id: 1, matchRate: [] }, { id: 2, matchRate: 80 }], 'high')[0].id, 2)
		assert.equal(appendKnownReportScore('基于报告', 0, (score) => `综合分 ${score}`), '基于报告 · 综合分 0')
		assert.equal(appendKnownReportScore('基于报告', [80], (score) => `综合分 ${score}`), '基于报告')
	})
})
