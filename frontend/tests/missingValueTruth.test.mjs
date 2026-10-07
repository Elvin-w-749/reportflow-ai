import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'

import {
	aiToInternalDimensions,
	buildParsedFromAINormalized,
	normalizeAIResult
} from '../src/services/aiSchemaAdapter.js'
import { mapServerAnalyzeDataToClientAnalysis } from '../src/services/serverAnalyzeMapper.js'
import {
	creditCardUsageRatePct,
	normalizeAccountForDetail,
	summarizeAccountsForDetail
} from '../src/utils/reportDetailAggregates.js'
import {
	resolveDecisionAccountCount,
	resolveDecisionQueryCounts,
	resolveDecisionTotalDebt
} from '../src/services/decisionMetrics.js'
import { createOwnerApiDecisionTrust } from '../src/services/decisionTrust.js'
import { readMatchReportContext, saveMatchReportContext } from '../src/services/reportMatchContext.js'
import {
	debtBalanceOf,
	debtLimitOf,
	debtUtilizationPct,
	resolveDebtTotalFromEvidence
} from '../src/services/debtSummary.js'

const cases = [
	{ name: 'missing', apply: () => ({}), expected: null },
	{ name: 'null', apply: (key) => ({ [key]: null }), expected: null },
	{ name: 'empty', apply: (key) => ({ [key]: '' }), expected: null },
	{ name: 'zero', apply: (key) => ({ [key]: 0 }), expected: 0 },
	{ name: 'nonzero', apply: (key) => ({ [key]: 27 }), expected: 27 }
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
const { getReportAnalysisDate, getReportUploadDate } = await vite.ssrLoadModule('/src/services/reportStorage.js')
const { formatMoney, buildRepaymentReminderSummary } = await vite.ssrLoadModule('/src/services/repaymentReminderService.js')
const { createOwnerApiDecisionTrust: createRuntimeDecisionTrust } = await vite.ssrLoadModule('/src/services/decisionTrust.js')

after(async () => {
	await vite.close()
	if (originalUni === undefined) delete globalThis.uni
	else globalThis.uni = originalUni
})

describe('phase 1 missing-value truth matrix', () => {
	it('preserves missing/null/blank/zero/nonzero through the AI normalization and dimensions adapters', () => {
		for (const item of cases) {
			const normalized = normalizeAIResult({ debt_summary: item.apply('total_debt') })
			assert.equal(normalized.debt_summary.total_debt, item.expected, item.name)
			assert.equal(aiToInternalDimensions(normalized).totalDebt, item.expected, item.name)
		}

		const empty = normalizeAIResult({})
		assert.equal(empty.risk_level, 'unknown')
		assert.equal(empty.public_records.has_record, null)
		assert.equal(empty.account_overview.active_count, null)
		assert.equal(empty.hidden_debt_analysis.multi_loan_risk, '')
	})

	it('keeps null report adapters unknown while preserving an explicit zero report', () => {
		const empty = buildParsedFromAINormalized(null)
		assert.deepEqual(
			[empty.queryRecords.recent1Month, empty.publicRecords.hasRecord, empty.consecutiveOverdue.triggered],
			[null, null, null]
		)

		const explicitZero = buildParsedFromAINormalized(normalizeAIResult({
			query_records: { recent_1m: 0, recent_3m: 0, recent_6m: 0, recent_12m: 0 },
			public_records: { has_record: false, items: [] },
			overdue_summary: { consecutive_overdue_3: false, cumulative_overdue_6: false }
		}))
		assert.deepEqual(
			[explicitZero.queryRecords.recent1Month, explicitZero.publicRecords.hasRecord, explicitZero.consecutiveOverdue.triggered],
			[0, false, false]
		)
	})

	it('preserves the five-value matrix through the server mapper and never overwrites a zero with an alias', () => {
		for (const item of cases) {
			const mapped = mapServerAnalyzeDataToClientAnalysis({
				meta: {},
				credit_debt: {
					...item.apply('total_debt'),
					credit_loans: {},
					credit_cards: {}
				}
			})
			assert.equal(mapped.dimensions.totalDebt, item.expected, item.name)
		}

		const aliasFallback = mapServerAnalyzeDataToClientAnalysis({
			report: { totalScore: 0 },
			dimensions: { q1: 0, q3: 0, q6: 0, q12: 0 },
			queryRecords: { recent1Month: 7, recent3Month: 8, recent6Month: 9, recent12Month: 10 }
		})
		assert.deepEqual(aliasFallback.report.dimensionSnapshot, {
			debtRatioPct: null,
			debtRatioDecisionEligible: false,
			debtRatioStatus: 'denominator-evidence-pending',
			overdueCount: null,
			maxOverdueDays: null,
			m1Count: null,
			m2Count: null,
			m3Count: null,
			hasLianSan: null,
			hasLeiLiu: null,
			q1: 0,
			q3: 0,
			q6: 0,
			q12: 0,
			totalAccountCount: null,
			nonBankLoanCount: null
		})
	})

	it('does not manufacture account amounts, normal status, or active lifecycle', () => {
		for (const item of cases) {
			const account = normalizeAccountForDetail({
				accountType: '贷款',
				status: '正常',
				...item.apply('balance')
			})
			assert.equal(account.balance, item.expected, item.name)
			assert.equal(summarizeAccountsForDetail([account]).totalBalance, item.expected, item.name)
		}

		for (const status of [undefined, null, '']) {
			const account = normalizeAccountForDetail({ accountType: '贷款', status })
			assert.equal(account.statusText, '待核对')
			assert.equal(account.active, null)
			assert.equal(account.settled, null)
			assert.equal(account.balance, null)
			assert.equal(summarizeAccountsForDetail([account]).active, null)
		}

		const explicit = normalizeAccountForDetail({ accountType: '贷款', status: '正常', balance: 0, limit: 0 })
		assert.equal(explicit.active, true)
		assert.equal(explicit.statusText, '正常')
		assert.equal(explicit.balance, 0)
	})

	it('keeps card utilization unknown unless the value itself is present, including authoritative mode', () => {
		for (const item of cases) {
			const value = creditCardUsageRatePct(
				item.apply('usage_rate'),
				null,
				[],
				{ authoritative: true }
			)
			const expected = item.expected
			assert.equal(value, expected, item.name)
		}
	})

	it('requires owner-API flags and same-report values before zero is known', () => {
		for (const item of cases) {
			const reportId = `report-${item.name}`
			const projection = createOwnerApiDecisionTrust({
				id: reportId,
				decisionEvidenceLinked: true,
				evidenceVerified: true,
				decisionFlags: { totalDebt: true, accountCount: true, query6mCount: true },
				...item.apply('totalDebt'),
				...item.apply('accountCount'),
				...item.apply('query6mCount')
			})
			const debt = resolveDecisionTotalDebt({}, projection, reportId)
			const accounts = resolveDecisionAccountCount({}, projection, reportId)
			const queries = resolveDecisionQueryCounts({}, projection, reportId)
			assert.equal(debt.known, item.expected != null, `${item.name}: debt known`)
			assert.equal(accounts.known, item.expected != null, `${item.name}: accounts known`)
			assert.equal(queries.q6Known, item.expected != null, `${item.name}: query known`)
			assert.equal(debt.value, item.expected, `${item.name}: debt`)
			assert.equal(accounts.value, item.expected, `${item.name}: accounts`)
			assert.equal(queries.q6, item.expected, `${item.name}: query`)
		}
	})

	it('keeps debt helpers nullable and accepts only explicit zero evidence', () => {
		assert.equal(debtBalanceOf({}), null)
		assert.equal(debtLimitOf({ balance: 1 }), null)
		assert.equal(debtUtilizationPct({ balance: 1 }), null)
		assert.deepEqual(resolveDebtTotalFromEvidence([{ status: '正常' }], null), {
			known: false,
			total: null,
			source: 'unavailable',
			explicitZero: false
		})
		assert.deepEqual(resolveDebtTotalFromEvidence([{ status: '正常', balance: 0 }], null), {
			known: true,
			total: 0,
			source: 'accounts',
			explicitZero: true
		})
	})

	it('keeps LLM, V2, Python, and AI-visual compatibility projections nullable', () => {
		const v2 = normalizeAIResult({ meta: {}, credit_debt: {} })
		assert.equal(v2.debt_summary.total_debt, null)
		assert.equal(v2.account_overview.active_count, null)

		const python = mapServerAnalyzeDataToClientAnalysis({
			summary_cards: [],
			details: { credit_summary: {}, risk_assessment: {}, query_records: {} }
		})
		assert.equal(python.report.totalScore, null)
		assert.equal(python.report.riskLevel, 'unknown')
		assert.equal(python.queryRecords.recent6Month, null)

		const visual = buildParsedFromAINormalized(normalizeAIResult({
			credit_cards: { count: 1 }
		}))
		assert.equal(visual.creditAccounts[0].balance, null)
		assert.equal(visual.creditAccounts[0].status, null)
		assert.equal(visual.creditAccounts[0].isSettled, null)
	})

	it('separates report date from upload time and never uses createdAt as report day', () => {
		const uploadOnly = { createdAt: '2026-08-17T08:30:00.000Z' }
		assert.equal(getReportAnalysisDate(uploadOnly), '')
		assert.equal(getReportUploadDate(uploadOnly), '2026-08-17')
		assert.equal(getReportAnalysisDate({ date: '2025-06-30' }), '')
		assert.equal(getReportUploadDate({ date: '2025-06-30' }), '')

		const report = {
			createdAt: '2026-08-17T08:30:00.000Z',
			analysisData: { basicInfo: { reportDate: '2025-06-30' } }
		}
		assert.equal(getReportAnalysisDate(report), '2025-06-30')
		assert.equal(getReportUploadDate(report), '2026-08-17')

		storage.clear()
		assert.equal(saveMatchReportContext({ id: 'upload-only', createdAt: '2026-08-17T08:30:00.000Z' }), true)
		const uploadContext = readMatchReportContext()
		assert.equal(uploadContext.reportDate, '')
		assert.equal(uploadContext.date, '')
		assert.equal(uploadContext.uploadDate, '2026-08-17')

		storage.clear()
		assert.equal(saveMatchReportContext({
			id: 'dated-report',
			createdAt: '2026-08-17T08:30:00.000Z',
			analysisData: { basicInfo: { reportDate: '2025-06-30' } }
		}), true)
		const datedContext = readMatchReportContext()
		assert.equal(datedContext.reportDate, '2025-06-30')
		assert.equal(datedContext.date, '2025-06-30')
		assert.equal(datedContext.uploadDate, '2026-08-17')
	})

	it('does not turn a missing repayment amount into ¥0 or an empty report into no bills', () => {
		assert.equal(formatMoney(undefined), '—')
		assert.equal(formatMoney(null), '—')
		assert.equal(formatMoney(''), '—')
		assert.equal(formatMoney(0), '¥ 0')
		assert.equal(formatMoney(25), '¥ 25')

		const summary = buildRepaymentReminderSummary({ analysisData: { report: {} } })
		assert.equal(summary.monthDue, null)
		assert.equal(summary.monthDueText, '—')
		assert.equal(summary.reportAmountEvidenceKnown, false)

		const reportId = 'report-explicit-zero-debt'
		const explicitZero = buildRepaymentReminderSummary({
			id: reportId,
			analysisData: { report: {} },
			decisionTrust: createRuntimeDecisionTrust({
				id: reportId,
				decisionEvidenceLinked: true,
				evidenceVerified: true,
				decisionFlags: { totalDebt: true },
				totalDebt: 0
			})
		})
		assert.equal(explicitZero.monthDue, 0)
		assert.equal(explicitZero.monthDueText, '¥ 0')
		assert.equal(explicitZero.explicitNoDebt, true)
	})

	it('keeps all user entry points on explicit pending semantics', () => {
		const detail = readFileSync(new URL('../src/pages/report/Detail.vue', import.meta.url), 'utf8')
		const manage = readFileSync(new URL('../src/pages/report/Manage.vue', import.meta.url), 'utf8')
		const home = readFileSync(new URL('../src/pages/home/Home.vue', import.meta.url), 'utf8')
		const debt = readFileSync(new URL('../src/pages/profile/DebtManage.vue', import.meta.url), 'utf8')
		const match = readFileSync(new URL('../src/pages/match/Match.vue', import.meta.url), 'utf8')

		assert.match(detail, /风险信息待核对/)
		assert.match(detail, /报告日 \{\{ displayReportDate \}\}/)
		assert.match(manage, /报告日待核对/)
		assert.match(manage, /最近上传/)
		assert.match(home, /债务数据待核对/)
		assert.match(home, /报告未提供完整应还金额，未按 ¥0 处理/)
		assert.match(debt, /余额或账户状态缺失，未按 0 元或“暂无债务”处理/)
		assert.match(match, /报告日待核对/)
	})
})
