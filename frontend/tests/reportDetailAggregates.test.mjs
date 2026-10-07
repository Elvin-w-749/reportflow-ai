import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const originalWarn = console.warn
console.warn = () => {}
const aggregates = await import('../src/utils/reportDetailAggregates.js')
const { summarizeCreditCardUtilization } = await import('../src/utils/creditCardUtilization.js')
console.warn = originalWarn

const {
	creditCardUsageRatePct,
	buildDebtStructureSegments,
	aggregateQueryItemsByMonth,
	classifyQueryItemBank,
	filterAccountsForDetail,
	filterBankQueries12m,
	filterQueryInstitutionDetailsLive,
	filterSelfQueriesInLiveWindow,
	formatWan,
	groupThousands,
	isNegativeOverdueStatus,
	loanStatusClass,
	normalizeAccountForDetail,
	normalizeInstitutionKind,
	normalizeRiskHitsForDetail,
	queryLiveWindowStart,
	summarizeAccountsForDetail,
	summarizeQueriesByWindows,
	summarizeRiskHitsByBucket,
	upcomingLoansFromAccounts
} = aggregates

describe('reportDetailAggregates', () => {
	it('formats common money and percentage values consistently', () => {
		assert.equal(groupThousands(1234567.4), '1,234,567')
		assert.equal(groupThousands(-98765.9), '-98,766')
		assert.equal(formatWan(120000), '12')
		assert.equal(formatWan(125000), '12.5')
		assert.equal(creditCardUsageRatePct({ usage_rate_pct: 0.735 }), 74)
		assert.equal(creditCardUsageRatePct(null, null, [
			{ isLoan: false, currency: 'CNY', limit: 100000, balance: 45000 },
			{ isLoan: false, currency: 'CNY', limit: 50000, balance: 15000 },
			{ isLoan: true, limit: 200000, balance: 100000 }
		]), 40)
	})

	it('does not style negated overdue text as a bad loan status', () => {
		for (const status of ['未逾期', '无逾期', '从未逾期', '当前无逾期']) {
			assert.notEqual(loanStatusClass(status), 'loan-st-bad', status)
		}
		assert.equal(loanStatusClass('当前逾期'), 'loan-st-bad')
		assert.equal(loanStatusClass('呆账'), 'loan-st-bad')
	})

	it('does not infer shared limits from matching tail, institution or opening date', () => {
		const accounts = [
			{ isLoan: false, bank: '测试银行', openDate: '2020-01-01', accountType: '贷记卡（人民币账户，尾号8744）', limit: 48000, balance: 44975 },
			{ isLoan: false, bank: '测试银行', openDate: '2020-01-01', accountType: '贷记卡（美元账户，尾号8744）', limit: 58993, balance: 0 },
			{ isLoan: false, bank: '测试银行', openDate: '2020-01-01', accountType: '贷记卡（日元账户，尾号8744）', limit: 34313, balance: 0 }
		]
		const utilization = summarizeCreditCardUtilization(accounts)

		assert.equal(utilization.totalLimit, 48000)
		assert.equal(utilization.totalUsed, 44975)
		assert.equal(utilization.status, 'unknown')
		assert.equal(utilization.decisionEligible, false)
		assert.equal(utilization.sharedGroupCount, 0)
		assert.equal(utilization.unknownAccountCount, 2)
		assert.equal(utilization.usageRate, null)
		assert.equal(creditCardUsageRatePct({ usage_rate: 0.3183 }, null, accounts), null)
	})

	it('treats negative shared-relation sentinels as no relationship', () => {
		for (const sentinel of ['无', '未共享', '无共享', '未设置', '不共享', 'N/A', 'none', 'null', '-']) {
			const utilization = summarizeCreditCardUtilization([
				{
					currency: 'CNY',
					credit_limit: 10000,
					used_limit: 8000,
					shared_credit_group: sentinel,
					utilization_group: sentinel,
					parent_account_id: sentinel
				},
				{
					currency: 'CNY',
					credit_limit: 30000,
					used_limit: 10000,
					shared_credit_group: sentinel,
					utilization_group: sentinel,
					parent_account_id: sentinel
				}
			])

			assert.equal(utilization.totalLimit, 40000, sentinel)
			assert.equal(utilization.totalUsed, 18000, sentinel)
			assert.equal(utilization.sharedGroupCount, 0, sentinel)
			assert.equal(utilization.decisionEligible, true, sentinel)
		}
	})

	it('preserves explicit shared-limit metadata through account normalization', () => {
		const accounts = [
			normalizeAccountForDetail({
				isLoan: false,
				bank: '测试银行',
				accountType: '贷记卡',
				openDate: '2020-01-01',
				limit: 50000,
				balance: 20000,
				currency: 'CNY',
				cardTail: '1111',
				sharedCreditGroup: 'shared-card-1',
				utilizationGroup: 'explicit:shared-card-1',
				utilizationIncluded: true,
				utilizationNote: '人民币主账户（共享额度）',
				status: '正常'
			}, 0),
			normalizeAccountForDetail({
				isLoan: false,
				bank: '测试银行',
				accountType: '贷记卡',
				openDate: '2020-01-01',
				limit: 350000,
				balance: 100000,
				currency: 'USD',
				cardTail: '9999',
				sharedCreditGroup: 'shared-card-1',
				utilizationGroup: 'explicit:shared-card-1',
				utilizationIncluded: false,
				utilizationNote: '外币伴生账户，不重复计入人民币额度',
				status: '正常'
			}, 1)
		]

		assert.deepEqual({
			currency: accounts[1].currency,
			cardTail: accounts[1].cardTail,
			sharedCreditGroup: accounts[1].sharedCreditGroup,
			utilizationGroup: accounts[1].utilizationGroup,
			utilizationIncluded: accounts[1].utilizationIncluded,
			utilizationNote: accounts[1].utilizationNote
		}, {
			currency: 'USD',
			cardTail: '9999',
			sharedCreditGroup: 'shared-card-1',
			utilizationGroup: 'explicit:shared-card-1',
			utilizationIncluded: false,
			utilizationNote: '外币伴生账户，不重复计入人民币额度'
		})

		const summary = summarizeAccountsForDetail(accounts)
		assert.equal(summary.cardRawLimit, 400000)
		assert.equal(summary.cardLimit, 50000)
		assert.equal(summary.cardUsed, 20000)
		assert.equal(summary.cardUsagePct, 40)
		assert.equal(summary.cardSharedGroupCount, 1)
		assert.equal(summary.cardForeignCurrencyAccountCount, 1)
	})

	it('keeps explicit foreign currency metadata when the product text has no currency', () => {
		const accounts = [
			normalizeAccountForDetail({
				isLoan: false,
				bank: '甲银行',
				accountType: '贷记卡',
				openDate: '2021-02-03',
				limit: 60000,
				balance: 30000,
				currency_code: 'CNY',
				card_tail: '1234'
			}, 0),
			normalizeAccountForDetail({
				isLoan: false,
				bank: '乙银行',
				accountType: '贷记卡',
				openDate: '2022-03-04',
				limit: 90000,
				balance: 45000,
				currency_code: 'USD',
				card_tail: '5678'
			}, 1)
		]

		const utilization = summarizeCreditCardUtilization(accounts)
		assert.equal(accounts[0].currency, 'CNY')
		assert.equal(accounts[1].currency, 'USD')
		assert.equal(utilization.totalLimit, 60000)
		assert.equal(utilization.totalUsed, 30000)
		assert.equal(utilization.foreignAccountCount, 1)
		assert.equal(utilization.foreignOnlyGroupCount, 1)
		assert.equal(utilization.status, 'unknown')
		assert.equal(utilization.unknownAccountCount, 1)
		assert.equal(utilization.usageRate, null)
	})

	it('does not merge different card tails opened at the same institution on the same day', () => {
		const accounts = [
			normalizeAccountForDetail({
				isLoan: false,
				bank: '测试银行',
				accountType: '贷记卡',
				openDate: '2023-05-06',
				limit: 40000,
				balance: 10000,
				currency: 'CNY',
				cardTail: '1111',
				status: '正常'
			}, 0),
			normalizeAccountForDetail({
				isLoan: false,
				bank: '测试银行',
				accountType: '贷记卡',
				openDate: '2023-05-06',
				limit: 60000,
				balance: 30000,
				currency: 'CNY',
				cardTail: '2222',
				status: '正常'
			}, 1)
		]

		const summary = summarizeAccountsForDetail(accounts)
		assert.equal(summary.cardLimit, 100000)
		assert.equal(summary.cardUsed, 40000)
		assert.equal(summary.cardUsagePct, 40)
		assert.equal(summary.cardSharedGroupCount, 0)
		assert.equal(summary.cardInferredSharedGroupCount, 0)
	})

	it('does not merge two CNY cards solely because institution and opening date match', () => {
		const cards = [
			{ isLoan: false, bank: '同日开户银行', openDate: '2022-02-02', currency: 'CNY', limit: 100000, balance: 60000 },
			{ isLoan: false, bank: '同日开户银行', openDate: '2022-02-02', currency: 'CNY', limit: 50000, balance: 15000 }
		]
		const utilization = summarizeCreditCardUtilization(cards)
		assert.equal(utilization.totalLimit, 150000)
		assert.equal(utilization.totalUsed, 75000)
		assert.equal(utilization.utilizationGroupCount, 2)
	})

	it('uses the backend canonical ratio when detail rows do not show shared accounts', () => {
		assert.equal(creditCardUsageRatePct({ usage_rate: 0.8123 }), 81)
		assert.equal(creditCardUsageRatePct({ usage_rate: 1.12 }), 112)
	})

	it('never lets conflicting detail rows override an authoritative card ratio, including zero', () => {
		const rows = [{ isLoan: false, limit: 100000, balance: 90000 }]
		assert.equal(creditCardUsageRatePct(
			{ usage_rate: 0.9 },
			{ cardUtilizationRate: 0.25 },
			rows,
			{ authoritative: true }
		), 25)
		assert.equal(creditCardUsageRatePct(
			{ usage_rate: 0.9 },
			{ cardUtilizationRate: 0 },
			rows,
			{ authoritative: true }
		), 0)
	})

	it('normalizes risk hit detail buckets and de-duplicates repeated hits', () => {
		const rows = normalizeRiskHitsForDetail([
			{ level: '低风险', title: '整体信用风险较低', detail: '保持当前状态', severity: 1 },
			{ risk_level: '高风险', title: '当前逾期', detail: '存在 M3 逾期', rule_name: 'OD_M3', severity: 4 },
			{ level: '警告', title: '当前逾期', detail: '存在 M3 逾期', rule_name: 'OD_M3', severity: 3 },
			{ level: '警告', title: '查询偏多', detail: '近6月审批查询偏多', severity: 3 },
			{ level: '警告', title: '查询偏多', detail: '近6月审批查询偏多', severity: 3 }
		])
		const summary = summarizeRiskHitsByBucket(rows)

		assert.deepEqual(rows.map((row) => row.bucket), ['info', 'high', 'warn'])
		assert.deepEqual(summary, { high: 1, warn: 1, info: 1, total: 3 })
		assert.equal(rows[0].level, '提示')
		assert.equal(rows[1].level, '高风险')
	})

	it('normalizes account detail filters with actual abnormal counts', () => {
		const accounts = [
			normalizeAccountForDetail({ isLoan: 'true', bank: '建设银行', accountType: '个人消费贷款', balance: 70000, monthlyPayment: 2500, status: '正常' }, 0),
			normalizeAccountForDetail({ isLoan: false, bank: '招商银行', accountType: '贷记卡', currency: 'CNY', used_limit: 18000, credit_limit: 50000, status: '逾期', overdue_days: 12 }, 1),
			normalizeAccountForDetail({ bank: '工商银行', type: '贷记卡', currency: 'CNY', usedLimit: 0, creditLimit: 30000, status: '销户' }, 2),
			normalizeAccountForDetail({ isLoan: false, bank: '浦发银行', type: '贷记卡', currency: 'CNY', usedLimit: 85000, creditLimit: 100000, status: '正常' }, 3),
			normalizeAccountForDetail({ isLoan: true, bank: '马上消费金融', accountType: '消费贷', balance: 120000, loanAmount: 150000, status: '正常' }, 4)
		]
		const summary = summarizeAccountsForDetail(accounts)

		assert.deepEqual({ total: summary.total, loan: summary.loan, card: summary.card, abnormal: summary.abnormal, settled: summary.settled }, {
			total: 5,
			loan: 2,
			card: 3,
			abnormal: 1,
			settled: 1
		})
		assert.equal(summary.active, 4)
		assert.equal(summary.bank, 4)
		assert.equal(summary.nonbank, 1)
		assert.equal(summary.highUsage, 1)
		assert.equal(summary.largeBalance, 1)
		assert.equal(summary.activeBalance, 293000)
		assert.equal(summary.cardUsagePct, 69)
		assert.deepEqual(filterAccountsForDetail(accounts, 'abnormal').map((a) => a.institution), ['招商银行'])
		assert.deepEqual(filterAccountsForDetail(accounts, 'settled').map((a) => a.institution), ['工商银行'])
		assert.deepEqual(filterAccountsForDetail(accounts, 'highUsage').map((a) => a.institution), ['浦发银行'])
		assert.deepEqual(filterAccountsForDetail(accounts, 'largeBalance').map((a) => a.institution), ['马上消费金融'])
		assert.deepEqual(filterAccountsForDetail(accounts, 'nonbank').map((a) => a.institution), ['马上消费金融'])
		assert.equal(filterAccountsForDetail(accounts, 'active').length, 4)
		assert.equal(accounts[1].statusText, '逾期 12 天')
		assert.match(accounts[0].detailText, /月供/)
		assert.match(accounts[3].detailText, /使用率 85%/)
	})

	it('does not classify negated overdue text as overdue and keeps other abnormalities separate', () => {
		const normalRows = ['未逾期', '无逾期', '从未逾期'].map((status, index) => (
			normalizeAccountForDetail({ isLoan: true, institution: `未知机构${index}`, status }, index)
		))
		const overdueByDays = normalizeAccountForDetail({ status: '未逾期', overdue_days: 3, institution: '甲银行' }, 3)
		const overdueByAuthority = normalizeAccountForDetail({ status: '从未逾期', is_overdue: true, institution: '乙银行' }, 4)
		const otherAbnormal = normalizeAccountForDetail({ status: '冻结', institution: '某机构' }, 5)
		const accounts = [...normalRows, overdueByDays, overdueByAuthority, otherAbnormal]
		const summary = summarizeAccountsForDetail(accounts)

		assert.equal(isNegativeOverdueStatus('从未逾期'), true)
		assert.deepEqual(normalRows.map((row) => [row.abnormal, row.overdue]), [[false, false], [false, false], [false, false]])
		assert.equal(overdueByDays.overdue, true)
		assert.equal(overdueByAuthority.overdue, true)
		assert.deepEqual({ abnormal: otherAbnormal.abnormal, overdue: otherAbnormal.overdue, other: otherAbnormal.otherAbnormal }, {
			abnormal: true,
			overdue: false,
			other: true
		})
		assert.equal(summary.abnormal, 3)
		assert.equal(summary.overdue, null)
		assert.equal(summary.overdueKnown, false)
		assert.equal(summary.otherAbnormal, 1)
		assert.deepEqual(filterAccountsForDetail(accounts, 'overdue').map((row) => row.institution), ['甲银行', '乙银行'])
	})

	it('normalizes explicit institution types before legacy name heuristics and keeps unknown separate', () => {
		const explicitBank = normalizeAccountForDetail({ institution: '某消费金融', institution_type: 'bank', status: '正常' }, 0)
		const explicitNonBank = normalizeAccountForDetail({ institution: '某银行', institutionKind: 'nonbank', status: '正常' }, 1)
		const legacyNonBank = normalizeAccountForDetail({ institution: '某消费金融有限公司', status: '正常' }, 2)
		const unknown = normalizeAccountForDetail({ institution: '某数据服务公司', status: '正常' }, 3)
		const summary = summarizeAccountsForDetail([explicitBank, explicitNonBank, legacyNonBank, unknown])

		assert.equal(normalizeInstitutionKind(undefined, '招商银行'), 'bank')
		assert.equal(normalizeInstitutionKind(undefined, '某消费金融有限公司'), 'non_bank')
		assert.equal(normalizeInstitutionKind(undefined, '某银行消费金融有限公司'), 'non_bank')
		assert.equal(normalizeInstitutionKind(undefined, '某数据服务公司'), 'unknown')
		assert.deepEqual([explicitBank.institutionKind, explicitNonBank.institutionKind, legacyNonBank.institutionKind, unknown.institutionKind], [
			'bank', 'non_bank', 'non_bank', 'unknown'
		])
		assert.deepEqual({ bank: summary.bank, nonbank: summary.nonbank, unknown: summary.unknown }, { bank: 1, nonbank: 2, unknown: 1 })
		assert.deepEqual(filterAccountsForDetail([explicitBank, explicitNonBank, legacyNonBank, unknown], 'unknown').map((row) => row.institution), ['某数据服务公司'])
	})

	it('classifies query institutions for UI filters', () => {
		assert.equal(classifyQueryItemBank({ org: '招商银行', reason: '贷款审批' }), 'bank')
		assert.equal(classifyQueryItemBank({ org: '某消费金融有限公司', reason: '贷款审批' }), 'nonBank')
		assert.equal(classifyQueryItemBank({ org: '名称含银行', institution_type: 'non_bank', reason: '贷款审批' }), 'nonBank')
		assert.equal(classifyQueryItemBank({ org: '某数据服务公司', reason: '贷款审批' }), 'unknown')
		assert.equal(classifyQueryItemBank({ org: '本人', reason: '本人查询' }), 'self')
	})

	it('aggregates approval query items by month for trend display', () => {
		const rows = [
			{ date: '2026-06-20', org: '招商银行', reason: '贷款审批' },
			{ date: '2026-06-15', org: '某消费金融', reason: '贷款审批' },
			{ date: '2026-05-01', org: '建设银行', reason: '信用卡审批' },
			{ date: '2026-06-10', org: '工商银行', reason: '贷后管理' },
			{ date: '2026-06-08', org: '本人', reason: '本人查询' }
		]

		const trend = aggregateQueryItemsByMonth(rows, 3, '2026-06-30')

		assert.deepEqual(trend.map((item) => item.month), ['2026-04', '2026-05', '2026-06'])
		assert.deepEqual(trend.map((item) => [item.bank, item.nonBank]), [[0, 0], [1, 0], [1, 1]])
	})

	it('summarizes effective approval queries in report-date anchored calendar-month windows', () => {
		const rows = [
			{ date: '2026-06-20', org: '招商银行', reason: '贷款审批' },
			{ date: '2026-05-01', org: '某消费金融', reason: '贷款审批' },
			{ date: '2026-01-05', org: '建设银行', reason: '信用卡审批' },
			{ date: '2026-06-15', org: '本人查询', reason: '本人查询' },
			{ date: '2026-06-10', org: '工商银行', reason: '贷后管理' }
		]

		const summary = summarizeQueriesByWindows(rows, '2026-06-30')

		assert.deepEqual(summary['1m'], { bank: 1, nonBank: 0, total: 1 })
		assert.deepEqual(summary['3m'], { bank: 1, nonBank: 1, total: 2 })
		assert.deepEqual(summary['6m'], { bank: 2, nonBank: 1, total: 3 })
		assert.deepEqual(summary['12m'], { bank: 2, nonBank: 1, total: 3 })
	})

	it('matches API calendar-month boundary semantics with inclusive start and end dates', () => {
		const rows = [
			{ date: '2026-05-30', org: '甲银行', reason: '贷款审批' },
			{ date: '2026-05-29', org: '乙银行', reason: '贷款审批' },
			{ date: '2026-06-30', org: '丙银行', reason: '信用卡审批' },
			{ date: '2026-07-01', org: '未来银行', reason: '贷款审批' }
		]
		const summary = summarizeQueriesByWindows(rows, '2026-06-30')
		const details = filterQueryInstitutionDetailsLive(rows, { monthsBack: 1, anchorDate: '2026-06-30' })

		assert.deepEqual(summary['1m'], { bank: 2, nonBank: 0, total: 2 })
		assert.deepEqual(details.map((row) => row.org), ['丙银行', '甲银行'])
		const localYmd = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
		assert.equal(localYmd(queryLiveWindowStart(1, '2026-03-31')), '2026-02-28')
		assert.equal(localYmd(queryLiveWindowStart(12, '2026-06-30')), '2025-06-30')
	})

	it('reports unclassified query details explicitly instead of defaulting them to non-bank', () => {
		const summary = summarizeQueriesByWindows([
			{ date: '2026-06-30', org: '某数据服务公司', reason: '贷款审批' }
		], '2026-06-30')

		assert.deepEqual(summary['1m'], {
			bank: 0,
			nonBank: 0,
			unknown: 1,
			total: 1,
			breakdownAvailable: true,
			classificationComplete: false
		})
	})

	it('anchors query detail filters to the report date instead of the current day', () => {
		const rows = [
			{ date: '2026-06-20', org: '招商银行', reason: '贷款审批' },
			{ date: '2026-02-01', org: '本人查询', reason: '本人查询' },
			{ date: '2025-07-01', org: '建设银行', reason: '信用卡审批' },
			{ date: '2026-07-15', org: '未来银行', reason: '贷款审批' }
		]

		const bankRows = filterBankQueries12m(rows, '2026-06-30')
		const selfRows = filterSelfQueriesInLiveWindow(rows, 12, '2026-06-30')

		assert.deepEqual(bankRows.map((row) => row.org), ['招商银行', '建设银行'])
		assert.deepEqual(selfRows.map((row) => row.org), ['本人查询'])
	})
	it('includes approval queries on the report date in live windows', () => {
		const rows = [
			{ date: '2026-07-01', org: '招商银行', reason: '贷款审批' },
			{ date: '2026-07-02', org: '未来银行', reason: '贷款审批' },
			{ date: '2026-06-15', org: '工商银行', reason: '贷后管理' }
		]

		const summary = summarizeQueriesByWindows(rows, '2026-07-01')
		const details = filterQueryInstitutionDetailsLive(rows, { monthsBack: 1, anchorDate: '2026-07-01' })

		assert.deepEqual(summary['1m'], { bank: 1, nonBank: 0, total: 1 })
		assert.deepEqual(details.map((row) => row.org), ['招商银行'])
	})

	it('filters approval query details by the selected live window', () => {
		const rows = [
			{ date: '2026-06-20', org: '招商银行', reason: '贷款审批' },
			{ date: '2026-05-15', org: '某消费金融', reason: '贷款审批' },
			{ date: '2026-02-12', org: '建设银行', reason: '信用卡审批' },
			{ date: '2026-06-10', org: '工商银行', reason: '贷后管理' },
			{ date: '2026-06-08', org: '本人查询', reason: '本人查询' },
			{ date: '2025-05-01', org: '农业银行', reason: '贷款审批' }
		]

		const threeMonthRows = filterQueryInstitutionDetailsLive(rows, { monthsBack: 3, anchorDate: '2026-06-30' })
		const bankOnlyRows = filterQueryInstitutionDetailsLive(rows, { monthsBack: 12, bankOnly: true, anchorDate: '2026-06-30' })

		assert.deepEqual(threeMonthRows.map((row) => row.org), ['招商银行', '某消费金融'])
		assert.deepEqual(bankOnlyRows.map((row) => row.org), ['招商银行', '建设银行'])
	})

	it('keeps large approval query detail sets complete for UI pagination', () => {
		const rows = Array.from({ length: 35 }, (_, index) => ({
			date: `2026-06-${String(28 - (index % 20)).padStart(2, '0')}`,
			org: index % 2 === 0 ? `银行${index}` : `消费金融${index}`,
			reason: index % 3 === 0 ? '信用卡审批' : '贷款审批'
		}))

		const details = filterQueryInstitutionDetailsLive(rows, { monthsBack: 1, anchorDate: '2026-06-30' })
		const summary = summarizeQueriesByWindows(rows, '2026-06-30')

		assert.equal(details.length, 35)
		assert.equal(summary['1m'].total, 35)
	})

	it('finds upcoming loan maturities within the selected horizon', () => {
		const result = upcomingLoansFromAccounts([
			{ isLoan: true, bank: '建设银行', balance: 50000, endDate: '2026-09-01' },
			{ isLoan: true, bank: '招商银行', balance: 80000, endDate: '2027-01-01' },
			{ isLoan: false, bank: '交通银行', balance: 20000, endDate: '2026-08-01' }
		], 6, '2026-06-30')

		assert.equal(result.count, 1)
		assert.equal(result.total_balance, 50000)
		assert.deepEqual(result.items, [
			{ institution: '建设银行', balance: 50000, due_date: '2026-09-01' }
		])
	})
	it('uses algorithm debt breakdown before account fallback', () => {
		const result = buildDebtStructureSegments({
			algorithmReport: {
				creditDebt: { total: 200000, loan: 150000, card: 50000 },
				breakdown: {
					bankLoan: { amount: 100000, count: 2 },
					nonBankLoan: { amount: 40000, count: 1 },
					otherLoan: { amount: 10000, count: 1 },
					highLimitCards: { amount: 30000, count: 1 },
					normalCards: { amount: 20000, count: 2 }
				}
			},
			accounts: [
				{ isLoan: true, institution: '错误银行', balance: 999999 }
			]
		})

		assert.deepEqual(result.map(({ key, amount, count, percent }) => ({ key, amount, count, percent })), [
			{ key: 'bank', amount: 100000, count: 2, percent: 50 },
			{ key: 'nonbank', amount: 40000, count: 1, percent: 20 },
			{ key: 'other', amount: 10000, count: 1, percent: 5 },
			{ key: 'card', amount: 50000, count: 3, percent: 25 }
		])
	})

	it('builds debt structure from V2 loan details when algorithm breakdown is absent', () => {
		const result = buildDebtStructureSegments({
			creditReportV2: {
				credit_debt: {
					total_debt: 160000,
					credit_cards: { total_used: 60000, card_count: 2 }
				},
				loan_details: {
					subtotal_bank: { balance: 80000, count: 1 },
					subtotal_non_bank: { balance: 20000, count: 1 }
				}
			}
		})

		assert.deepEqual(result.map(({ key, amount, count, percent }) => ({ key, amount, count, percent })), [
			{ key: 'bank', amount: 80000, count: 1, percent: 50 },
			{ key: 'nonbank', amount: 20000, count: 1, percent: 13 },
			{ key: 'card', amount: 60000, count: 2, percent: 38 }
		])
	})
	it('moves unmatched debt into reviewable loan bucket instead of unclassified debt', () => {
		const result = buildDebtStructureSegments({
			algorithmReport: {
				creditDebt: { total: 210000, loan: 160000, card: 50000 },
				breakdown: {
					bankLoan: { amount: 100000, count: 2 },
					nonBankLoan: { amount: 40000, count: 1 },
					otherLoan: { amount: 0, count: 0 },
					highLimitCards: { amount: 30000, count: 1 },
					normalCards: { amount: 20000, count: 2 }
				}
			}
		})

		assert.equal(result.some((item) => item.key === 'unclassified' || item.name === '未拆分负债'), false)
		const review = result.find((item) => item.key === 'loan-review')
		assert.equal(review.name, '待核对贷款')
		assert.equal(review.amount, 20000)
		assert.equal(review.review, true)
		assert.equal(result.meta.adjustmentAmount, 20000)
	})

	it('falls through total-only algorithm reports to account details', () => {
		const result = buildDebtStructureSegments({
			algorithmReport: {
				creditDebt: { total: 120000 },
				breakdown: { nonBankLoanRatio: 0.2 }
			},
			accounts: [
				{ isLoan: true, institution: '建设银行', balance: 70000 },
				{ isLoan: false, institution: '招商银行', balance: 30000, limit: 80000 }
			]
		})

		assert.equal(result.some((item) => item.key === 'unclassified' || item.name === '未拆分负债'), false)
		assert.deepEqual(result.map(({ key, amount }) => ({ key, amount })), [
			{ key: 'bank', amount: 70000 },
			{ key: 'nonbank', amount: 0 },
			{ key: 'card', amount: 30000 }
		])
		assert.equal(result.meta.source, 'accounts')
	})
})
