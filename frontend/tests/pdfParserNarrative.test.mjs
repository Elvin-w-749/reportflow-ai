import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

const originalWarn = console.warn
console.warn = () => {}
const server = await createServer({
	mode: 'production',
	define: { __RPT_PROD__: 'true' },
	server: { middlewareMode: true },
	appType: 'custom',
	logLevel: 'silent'
})
const { extractCreditInfoFromText } = await server.ssrLoadModule('/src/services/pdfParser.js')
const { summarizeQueriesByWindows } = await server.ssrLoadModule('/src/utils/reportDetailAggregates.js')
console.warn = originalWarn

after(async () => {
	await server.close()
})

describe('pdfParser narrative credit report accounts', () => {
	it('parses wrapped PBOC query table rows without corrupting reasons', () => {
		const text = `个人信用报告
报告时间：2026-07-01 09:00:00
查询记录
机构查询记录明细
编号 查询日期 查询机构 查询原因
1 2026年07月01日 中国农业银行上海东
方枢纽支行
贷款审批
2 2026年04月23日 某消费金融有限
公司
贷后管理
3 2025年11月07日 某担保有限公司 贷款审批
4 2025年09月01日 中国农业银行上海东
方枢纽支行
贷款审批
说  明
`

		const parsed = extractCreditInfoFromText(text)
		const items = parsed.queryRecords.queryItems
		const windows = summarizeQueriesByWindows(items, parsed.basicInfo.reportDate)

		assert.equal(items.length, 4)
		assert.deepEqual(items.map((item) => item.reason), ['贷款审批', '贷后管理', '贷款审批', '贷款审批'])
		assert.deepEqual(windows['1m'], { bank: 1, nonBank: 0, total: 1 })
		assert.deepEqual(windows['3m'], { bank: 1, nonBank: 0, total: 1 })
		assert.deepEqual(windows['6m'], { bank: 1, nonBank: 0, total: 1 })
		assert.deepEqual(windows['12m'], { bank: 2, nonBank: 1, total: 3 })
	})

	it('extracts PBOC narrative card, loan, revolving and settled accounts', () => {
		const text = `个人信用报告
报告编号：RPT001 报告时间：2026-02-25 12:01:03
信息概要
信用卡
2024年01月02日招商银行股份有限公司信用卡中心发放的贷记卡（人民币账户）。截至2026年02月，信用额度50,000，已使用额度12,300。
贷款
2025年03月04日南京银行股份有限公司发放的100,000元（人民币）其他个人消费贷款，2027年03月04日到期。截至2026年02月，余额80,000。
2025年04月05日四川新网银行股份有限公司为其他个人消费贷款授信，额度有效期至2027年04月05日，可循环使用。截至2026年02月，信用额度200,000元（人民币），余额为20,000，当前无逾期。
2020年01月01日上海银行股份有限公司信用卡中心发放的贷记卡（人民币账户），2023年02月销户。
2019年01月01日中国建设银行股份有限公司发放的30,000元（人民币）其他个人消费贷款，2021年02月已结清。
`

		const parsed = extractCreditInfoFromText(text)
		const cards = parsed.creditAccounts.filter((account) => !account.isLoan)
		const loans = parsed.creditAccounts.filter((account) => account.isLoan)

		assert.equal(parsed.basicInfo.reportDate, '2026-02-25')
		assert.equal(parsed.creditAccounts.length, 5)
		assert.equal(cards.length, 2)
		assert.equal(loans.length, 3)
		assert.equal(cards[0].bank, '招商银行股份有限公司信用卡中心')
		assert.equal(cards[0].limit, 50000)
		assert.equal(cards[0].balance, 12300)
		assert.equal(loans[0].loanAmount, 100000)
		assert.equal(loans[0].balance, 80000)
		assert.equal(loans[1].limit, 200000)
		assert.equal(loans[1].balance, 20000)
		assert.equal(cards[1].isSettled, true)
		assert.equal(loans[2].isSettled, true)
	})

	it('extracts paper-report risk signals from a simulated hundred-page scan', () => {
		const text = buildLongPaperCreditReportText()
		const parsed = extractCreditInfoFromText(text)
		const focusLoan = parsed.creditAccounts.find((account) => account.bank.includes('重点消费金融'))
		const focusGuarantee = parsed.creditAccounts.find((account) => account.sourceType === 'guarantee')
		const focusShared = parsed.creditAccounts.find((account) => account.sharedResponsibility)

		assert.equal(parsed.basicInfo.name, '张三')
		assert.equal(parsed.basicInfo.reportNo, 'PAPER-LONG-001')
		assert.equal(parsed.parseMeta.sourceType, 'pboc-paper-or-scan')
		assert.equal(parsed.parseMeta.pageCountHint, 120)
		assert.equal(parsed.creditSummary.loanAccountCount, 72)
		assert.equal(parsed.creditSummary.cardAccountCount, 48)
		assert.equal(parsed.creditSummary.totalCreditLine, 1200000)
		assert.equal(parsed.creditSummary.usedCredit, 320000)
		assert.ok(parsed.creditAccounts.length >= 122)
		assert.ok(focusLoan)
		assert.equal(focusLoan.fiveCategory, '关注')
		assert.equal(focusLoan.overdueLevel, 'M3+')
		assert.deepEqual(focusLoan.repayMatrix.slice(0, 10), ['N', 'N', '1', '2', '3', 'N', '1', '1', '1', 'N'])
		assert.ok(focusGuarantee)
		assert.equal(focusGuarantee.guaranteeType, '为他人担保')
		assert.ok(focusShared)
		assert.equal(focusShared.sharedResponsibility, true)
		assert.equal(parsed.overdueRecords.some((record) => record.level === 'M3+'), true)
		assert.equal(parsed.consecutiveOverdue.triggered, true)
		assert.equal(parsed.queryRecords.queryItems.length, 3)
	})

	it('keeps closed and normal matrix codes out of overdue month counts', () => {
		const text = `个人信用报告
报告时间：2026-07-01 09:00:00
1. 中国银行股份有限公司上海市分行
账户类型：个人消费贷款
账户状态：正常
开户日期：2024年01月01日
贷款金额：100,000元
贷款余额：50,000元
还款状态：N C G D Z / * 0 1 2 3 N
`

		const parsed = extractCreditInfoFromText(text)
		const account = parsed.creditAccounts[0]

		assert.deepEqual(account.repayMatrix, ['N', 'C', 'G', 'D', 'Z', '/', '*', '0', '1', '2', '3', 'N'])
		assert.equal(parsed.consecutiveOverdue.hasLianSan, true)
		assert.equal(parsed.consecutiveOverdue.details[0].maxConsecutive, 3)
		assert.equal(parsed.consecutiveOverdue.hasLeiLiu, false)
	})

	it('does not turn negated overdue phrases into overdue accounts', () => {
		for (const status of ['未逾期', '无逾期', '从未逾期']) {
			const parsed = extractCreditInfoFromText(`个人信用报告
报告时间：2026-07-01 09:00:00
2025年04月05日匿名消费金融公司为其他个人消费贷款授信，额度有效期至2027年04月05日，可循环使用。截至2026年06月，信用额度200,000元（人民币），余额为20,000，当前${status}。
`)
			assert.equal(parsed.creditAccounts.length, 1, status)
			assert.equal(parsed.creditAccounts[0].isOverdue, false, status)
			assert.equal(parsed.creditAccounts[0].overdueLevel, 'none', status)
			assert.equal(parsed.overdueRecords.length, 0, status)
		}
	})
})

const buildLongPaperCreditReportText = () => {
	const pages = []
	for (let i = 1; i <= 120; i++) {
		const month = String((i % 12) + 1).padStart(2, '0')
		const bank = `上海第${i}银行股份有限公司`
		const amount = String(80000 + i * 1000).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
		const balance = String(30000 + i * 500).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
		const accountLine = i % 3 === 0
			? `2024年${month}月02日${bank}信用卡中心发放的贷记卡（人民币账户）。截至2026年06月，信用额度50,000，已使用额度${String(10000 + i).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}。`
			: `2024年${month}月01日${bank}发放的${amount}元（人民币）其他个人消费贷款，2028年${month}月01日到期。截至2026年06月，余额${balance}。五级分类为正常。最近5年还款状态：N N N N N N N N N N N N。`
		pages.push([
			'个人信用报告',
			`第 ${i} 页，共 120 页`,
			i === 1
				? [
					'姓名：张三',
					'证件号码：310101198801011234',
					'报告编号：PAPER-LONG-001',
					'报告时间：2026-07-01 09:00:00',
					'信息概要',
					'贷款法人机构数 60 账户数 72 未结清账户数 70 余额 5,200,000元',
					'信用卡发卡机构数 18 账户数 48 未销户账户数 46 授信总额 1,200,000元 已用额度 320,000元'
				].join('\n')
				: '',
			accountLine,
			`第 ${i} 页，共 120 页`
		].join('\n'))
	}

	return `${pages.join('\n')}
2023年05月05日重点消费金融有限公司发放的120,000元（人民币）其他个人消费贷款，2027年05月05日到期。截至2026年06月，余额85,000。五级分类为关注。最近5年内有6个月处于逾期状态，其中逾期超过90天的月份数为1，最长逾期3个月。最近5年还款状态：N N 1 2 3 N 1 1 1 N N N。
2022年06月06日上海担保有限公司为他人担保的个人经营性贷款，截至2026年06月，担保余额为90,000元，五级分类为正常。
2021年07月07日中国银行股份有限公司上海市分行作为共同借款人承担相关还款责任的个人住房贷款，截至2026年06月，余额650,000元，五级分类为正常。
查询记录
机构查询记录明细
编号 查询日期 查询机构 查询原因
1 2026年06月28日 中国银行股份有限公司上海市分行
贷款审批
2 2026年05月20日 兴业消费金融股份公司
贷款审批
3 2026年02月03日 中国平安银行股份有限公司上海分行
贷后管理
说  明
`
}
