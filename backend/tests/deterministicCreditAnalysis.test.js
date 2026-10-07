'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
	sanitizeExtractedCreditFacts,
	finalizeExtractedCreditFacts,
	normalizeCreditAnalysisAggregates,
	validateExtractedCreditFactsSchema,
	reconcileSourceQueryCoverage,
	resolveCompleteQueryEvidence,
	buildEvidenceSourceVerifiedCounts,
	buildCreditChatRequest,
	preflightCreditEvidenceSource,
	runCreditLLMAnalysis
} = require('../backend/services/creditAnalysisService')

function officialOverviewDocumentMeta({ misalign = false, extraCell = false, missingHeader = false, unrelatedAccountRow = false } = {}) {
	const columns = [230, 275, 313, 365]
	const line = (text, x1, y1, x2, y2) => ({ text, bbox: [x1, y1, x2, y2] })
	const cell = (text, column, y) => {
		const center = columns[column] + (misalign && column === 2 && y === 140 ? 24 : 0)
		return line(text, center - 8, y, center + 8, y + 12)
	}
	const lines = [
		line('信息概要', 40, 10, 110, 24),
		...(unrelatedAccountRow ? [
			line('账户数', 45, 28, 190, 40),
			cell('4', 0, 28), cell('--', 1, 28), cell('19', 2, 28), cell('--', 3, 28)
		] : []),
		...(!missingHeader ? [
			line('贷款', 270, 30, 320, 42),
			line('信用卡', 212, 50, 248, 62),
			line('购房', 260, 50, 290, 62),
			line('其他', 298, 50, 328, 62),
			line('其他业务', 342, 50, 388, 62)
		] : []),
		line('账户数', 45, 100, 190, 112),
		cell('5', 0, 100), cell('--', 1, 100), cell('109', 2, 100), cell('--', 3, 100),
		line('未结清/未销户账户数', 45, 120, 190, 132),
		cell('3', 0, 120), cell('--', 1, 120), cell('8', 2, 120), cell('--', 3, 120),
		line('发生过逾期的账户数', 45, 140, 190, 152),
		cell('0', 0, 140), cell('--', 1, 140), cell('0', 2, 140), cell('--', 3, 140),
		line('发生过90天以上逾期的账户数', 45, 160, 190, 172),
		cell('0', 0, 160), cell('--', 1, 160), cell('0', 2, 160), cell('--', 3, 160),
		// Nearby explanatory numbers must not become table cells.
		line('最近60个月与90天说明', 410, 184, 540, 196)
	]
	if (extraCell) lines.push(line('7', 392, 120, 404, 132))
	return {
		sourceMode: 'pdf-text',
		expectedPageCount: 1,
		complete: true,
		pages: [{
			pageNumber: 1,
			bounds: [0, 0, 600, 800],
			text: lines.map((item) => item.text).join('\n'),
			blocks: [{ text: lines.map((item) => item.text).join('\n'), lines }]
		}]
	}
}

test('official vertical overview geometry proves active cards and loans without reading nearby numbers', () => {
	for (const documentMeta of [
		officialOverviewDocumentMeta(),
		officialOverviewDocumentMeta({ unrelatedAccountRow: true })
	]) {
		const verified = buildEvidenceSourceVerifiedCounts(
			documentMeta.pages[0].text,
			{ complete: true, query_details_total: 85 },
			documentMeta
		)

		assert.deepEqual(verified, {
			active_loans: { count: 8, basis: 'source-account-overview-pdf-geometry-v2' },
			credit_card_details: { count: 3, basis: 'source-account-overview-pdf-geometry-v2' },
			query_details: { count: 85, basis: 'source-query-table-v1' }
		})
	}
})

test('ambiguous or misaligned overview geometry fails closed while independent query proof survives', () => {
	for (const documentMeta of [
		officialOverviewDocumentMeta({ misalign: true }),
		officialOverviewDocumentMeta({ extraCell: true }),
		officialOverviewDocumentMeta({ missingHeader: true })
	]) {
		assert.deepEqual(
			buildEvidenceSourceVerifiedCounts(
				documentMeta.pages[0].text,
				{ complete: true, query_details_total: 85 },
				documentMeta
			),
			{ query_details: { count: 85, basis: 'source-query-table-v1' } }
		)
	}
})

test('verified query evidence accepts compact PDF table rows without column whitespace', () => {
	const source = [
		'机构查询记录明细',
		'编号查询日期查询机构查询原因',
		'12026年5月9日甲银行贷款审批',
		'22026年5月8日乙担保机构保后管理',
		'个人查询记录明细'
	].join('\n')
	const evidence = resolveCompleteQueryEvidence(source)

	assert.equal(evidence.query_details_total, 2)
	assert.equal(evidence.query_details.length, 2)
	assert.deepEqual(evidence.query_details.map((row) => row.seq), [1, 2])
})

test('verified query evidence accepts current headings, controlled date forms and official reasons', () => {
	const source = [
		'机 构\n查 询 记 录 明 细',
		'编号 查询日期 查询机构 查询原因',
		'1 2026.05.12 甲支付机构 特 约 商 户 实 名 审 查',
		'2 2026 年 05 月 11 日 乙银行 客户准入资格审查',
		'3 2026-05-10 丙银行 贷款审批',
		'4 2026/05/09 丁银行 信用卡审批',
		'本 人 查 询 记 录 明 细'
	].join('\n')
	const evidence = resolveCompleteQueryEvidence(source)

	assert.equal(evidence.complete, true)
	assert.equal(evidence.query_details_total, 4)
	assert.deepEqual(
		evidence.query_details.map(({ seq, date, reason }) => ({ seq, date, reason })),
		[
			{ seq: 1, date: '2026-05-12', reason: '特约商户实名审查' },
			{ seq: 2, date: '2026-05-11', reason: '客户准入资格审查' },
			{ seq: 3, date: '2026-05-10', reason: '贷款审批' },
			{ seq: 4, date: '2026-05-09', reason: '信用卡审批' }
		]
	)
})

test('zero query evidence requires an explicit empty table and never hides an unparsed row', () => {
	const explicitEmpty = [
		'机构查询记录明细',
		'编号 查询日期 查询机构 查询原因',
		'本人查询记录明细'
	].join('\n')
	assert.deepEqual(resolveCompleteQueryEvidence(explicitEmpty), {
		complete: true,
		query_details_total: 0,
		query_details: []
	})
	const supplementalEmpty = {
		complete: true,
		query_details_total: 0,
		query_details: []
	}
	assert.deepEqual(
		resolveCompleteQueryEvidence(explicitEmpty, supplementalEmpty),
		supplementalEmpty
	)

	for (const unsafeSource of [
		[
			'机构查询记录明细',
			'本人查询记录明细'
		].join('\n'),
		[
			'机构查询记录明细',
			'编号 查询日期 查询机构 查询原因',
			'1 2026.05.12 甲银行 未知查询原因',
			'本人查询记录明细'
		].join('\n'),
		[
			'机构查询记录明细',
			'编号 查询日期 查询机构 查询原因',
			'1 2026 年 05 月 12 甲银行 贷款审批',
			'本人查询记录明细'
		].join('\n')
	]) {
		assert.equal(resolveCompleteQueryEvidence(unsafeSource), null)
		assert.equal(resolveCompleteQueryEvidence(unsafeSource, supplementalEmpty), null)
	}
})

test('deterministic query evidence proves a 142-row table across page boundaries', () => {
	const pages = []
	let seq = 1
	for (let page = 1; page <= 6; page += 1) {
		const rows = []
		const pageRows = page < 6 ? 24 : 22
		for (let index = 0; index < pageRows; index += 1) {
			rows.push(`${seq}2026.05.01第${seq}银行贷款审批`)
			seq += 1
		}
		pages.push(`【第${page}页】\n${page === 1 ? '机 构 查 询 记 录 明 细\n' : ''}${rows.join('\n')}`)
	}
	const source = `${pages.join('\n')}\n本 人 查 询 记 录 明 细`

	const evidence = resolveCompleteQueryEvidence(source)

	assert.equal(evidence.complete, true)
	assert.equal(evidence.query_details_total, 142)
	assert.equal(evidence.query_details.length, 142)
	assert.deepEqual(evidence.query_details.map((row) => row.seq), Array.from({ length: 142 }, (_v, i) => i + 1))
})

test('complete two-pass evidence keeps a recovered terminal query row missing from first OCR', () => {
	const verifiedRows = Array.from({ length: 142 }, (_value, index) => ({
		seq: index + 1,
		date: '2026-05-01',
		institution: `第${index + 1}银行`,
		reason: '贷款审批'
	}))
	const firstPassSource = [
		'机构查询记录明细',
		...verifiedRows.slice(0, 141).map((row) =>
			`${row.seq} 2026年5月1日 ${row.institution} ${row.reason}`
		),
		'个人查询记录明细'
	].join('\n')
	const supplemental = {
		complete: true,
		query_details_total: 142,
		query_details: verifiedRows
	}

	const resolved = resolveCompleteQueryEvidence(firstPassSource, supplemental)
	assert.equal(resolved.query_details_total, 142)
	assert.equal(resolved.query_details.at(-1).seq, 142)

	const facts = sanitizeExtractedCreditFacts(baseFacts())
	facts.query_analysis.query_details = []
	facts._coverage.counts.query_details = { total: 0, listed: 0 }
	reconcileSourceQueryCoverage(facts, firstPassSource, supplemental)
	assert.equal(facts.query_analysis.query_details.length, 142)
	assert.deepEqual(facts._coverage.counts.query_details, { total: 142, listed: 142 })
	delete facts._coverage.counts_declared
	assert.equal(validateExtractedCreditFactsSchema(facts), true)
})

function attachCoverage(facts, overrides = {}) {
	const counts = {
		bank_loans: facts.loan_details?.bank_loans?.length || 0,
		non_bank_loans: facts.loan_details?.non_bank_loans?.length || 0,
		settled_loans: facts.loan_details?.settled_loans?.length || 0,
		historical_overdue_loans: facts.loan_details?.historical_overdue_loans?.length || 0,
		credit_card_details: facts.credit_card_details?.length || 0,
		credit_card_details_cancelled: facts.credit_card_details_cancelled?.length || 0,
		query_details: facts.query_analysis?.query_details?.length || 0,
		self_queries: facts.query_analysis?.self_queries?.length || 0,
		overdue_details: facts.overdue_info?.details?.length || 0,
		public_records: facts.public_records?.items?.length || 0,
		guarantee_records: facts.guarantee_records?.items?.length || 0,
		loan_history: facts.loan_history?.trend_data?.length || 0
	}
	facts._coverage = {
		has_basic_info: true,
		has_loans: counts.bank_loans + counts.non_bank_loans > 0,
		has_cards: counts.credit_card_details > 0,
		has_queries: counts.query_details > 0,
		has_overdue: false,
		has_public_records: counts.public_records > 0,
		has_guarantee: counts.guarantee_records > 0,
		truncated: false,
		notes: '',
		counts: Object.fromEntries(
			Object.entries(counts).map(([name, total]) => [
				name,
				{ total, listed: total, ...(overrides[name] || {}) }
			])
		)
	}
	return facts
}

function baseFacts() {
	return attachCoverage({
		meta: {
			report_type: '个人信用报告',
			report_date: '2026-06-30',
			query_date: '2026-06-30'
		},
		basic_info: {
			name: '测**',
			id_last4: '1234'
		},
		loan_details: {
			bank_loans: [{
				seq: 1,
				institution: '测试银行',
				credit_limit: 100000,
				balance: 40000,
				type: '个人消费贷款',
				start_date: '2020-01-01',
				end_date: '2027-01-01',
				status: '正常'
			}],
			non_bank_loans: [],
			settled_loans: [],
			historical_overdue_loans: []
		},
		credit_card_details: [
			{
				seq: 1,
				institution: '示例银行',
				credit_limit: 100000,
				used_limit: 50000,
				currency: 'CNY',
				card_tail: '5678',
				start_date: '2021-01-01',
				status: '正常',
				shared_credit_group: 'model-group-a'
			},
			{
				seq: 2,
				institution: '示例银行',
				credit_limit: 700000,
				used_limit: 0,
				currency: 'USD',
				card_tail: '5678',
				start_date: '2021-01-01',
				status: '正常',
				shared_credit_group: 'model-group-b'
			}
		],
		credit_card_details_cancelled: [],
		query_analysis: {
			summary: {
				last_6m: { total: 999 }
			},
			query_details: [
				{ institution: '测试银行', date: '2026-06-01', reason: '贷款审批' },
				{ institution: '示例消费金融', date: '2026-01-01', reason: '贷款审批' }
			],
			self_queries: []
		},
		overdue_info: {
			has_overdue: false,
			total_overdue_accounts: 0,
			details: []
		},
		public_records: { has_record: false, items: [] },
		guarantee_records: { total_amount: 0, items: [] },
		loan_history: { title: null, unit: null, trend_data: [] },
		credit_debt: {
			total_debt: 9999999,
			credit_cards: { usage_rate: 0.01 }
		},
		risk_analysis: {
			risk_hits: [{ rule_name: 'MODEL_FAKE_RISK', title: '模型伪风险' }]
		},
		assessment: { score: 1, risk_level: 'high' },
		six_dimensions: {
			credit_history: 1,
			query_frequency: 1,
			account_structure: 1,
			repayment_record: 1
		}
	})
}

test('DeepSeek payload is reduced to raw facts before deterministic derivation', () => {
	const raw = baseFacts()
	raw.credit_card_details.push({
		seq: null,
		institution: null,
		credit_limit: null,
		used_limit: null,
		status: null
	})
	const sanitized = sanitizeExtractedCreditFacts(raw)

	assert.equal(sanitized.credit_debt, undefined)
	assert.equal(sanitized.risk_analysis, undefined)
	assert.equal(sanitized.assessment, undefined)
	assert.equal(sanitized.six_dimensions, undefined)
	assert.equal(sanitized.query_analysis.summary, undefined)
	assert.equal(sanitized.credit_card_details[0].shared_credit_group, undefined)
	assert.equal(sanitized.credit_card_details.length, 2)
})

test('utilization, shared credit, queries, debt and score come from deterministic rules', () => {
	const result = finalizeExtractedCreditFacts(baseFacts())
	const cards = result.credit_debt.credit_cards

	assert.equal(cards.total_limit, 100000)
	assert.equal(cards.total_used, 50000)
	assert.equal(cards.usage_rate, 0.5)
	assert.equal(cards.shared_group_count, 0)
	assert.equal(cards.foreign_currency_account_count, 1)
	assert.equal(result.credit_debt.total_debt, 90000)
	assert.equal(result.query_analysis.summary.last_1m.total, 1)
	assert.equal(result.query_analysis.summary.last_6m.total, 2)
	assert.equal(result.primary_rule_score.score, 100)
	assert.equal(result.derivation_meta.mode, 'deterministic-v1')
	assert.equal(result.derivation_meta.anchor_date, '2026-06-30')
	assert.equal(
		result.risk_analysis.risk_hits.some((hit) => hit.rule_name === 'MODEL_FAKE_RISK'),
		false
	)
	assert.notEqual(result.six_dimensions.credit_history, 1)
})

test('loan institution class is deterministic and model array placement cannot change score', () => {
	const facts = baseFacts()
	facts.loan_details.bank_loans = [
		{
			seq: 1,
			institution: '甲持牌信贷中心',
			credit_limit: 50000,
			balance: 20000,
			status: '正常'
		},
		{
			seq: 2,
			institution: '丙消费金融股份有限公司',
			credit_limit: 40000,
			balance: 15000,
			status: '正常'
		}
	]
	facts.loan_details.non_bank_loans = [{
		seq: 3,
		institution: '乙银行科技服务',
		credit_limit: 30000,
		balance: 10000,
		status: '正常'
	}]
	const result = finalizeExtractedCreditFacts(attachCoverage(facts))

	assert.deepEqual(result.loan_details.bank_loans.map((row) => row.institution), ['乙银行科技服务'])
	assert.deepEqual(result.loan_details.non_bank_loans.map((row) => row.institution), ['丙消费金融股份有限公司'])
	assert.deepEqual(result.loan_details.unknown_loans.map((row) => row.institution), ['甲持牌信贷中心'])
	assert.equal(result.credit_debt.credit_loans.bank_count, 1)
	assert.equal(result.credit_debt.credit_loans.non_bank_count, 1)
	assert.equal(result.credit_debt.credit_loans.unknown_count, 1)
	assert.equal(result.credit_debt.credit_loans.total_count, 3)
	assert.equal(result.primary_rule_score.metrics.activeNonBankLoanCount, 1)
	assert.ok(result.credit_debt.credit_loans.chart_data.some((row) => row.name === '未分类' && row.value === 20000))
	const completeness = result.data_completeness.modules.find((row) => row.key === 'loan_details')
	assert.equal(completeness.present, true)
	assert.match(completeness.detail, /未分类 1 笔/)
})

test('an unknown-only loan remains complete and affects totals without a non-bank penalty', () => {
	const facts = baseFacts()
	facts.loan_details.bank_loans = [{
		seq: 1,
		institution: '甲持牌信贷中心',
		credit_limit: 50000,
		balance: 20000,
		status: '正常'
	}]
	facts.loan_details.non_bank_loans = []
	const result = finalizeExtractedCreditFacts(attachCoverage(facts))

	assert.equal(result.loan_details.unknown_loans.length, 1)
	assert.equal(result.credit_debt.credit_loans.total_balance, 20000)
	assert.equal(result.credit_debt.credit_loans.total_count, 1)
	assert.equal(result.primary_rule_score.metrics.activeNonBankLoanCount, 0)
	assert.equal(result.data_completeness.modules.find((row) => row.key === 'loan_details').present, true)
	assert.equal(result.frontend_payload.tables.loan_unknown.length, 1)
})

test('active zero-balance non-bank loans keep account counts without increasing debt', () => {
	const facts = baseFacts()
	facts.loan_details.bank_loans = [{
		seq: 1,
		institution: '甲消费金融股份有限公司',
		credit_limit: 50000,
		balance: 0,
		status: '正常'
	}]
	facts.loan_details.non_bank_loans = []
	const result = finalizeExtractedCreditFacts(attachCoverage(facts))

	assert.equal(result.credit_debt.credit_loans.non_bank_count, 1)
	assert.equal(result.credit_debt.credit_loans.total_count, 1)
	assert.equal(result.credit_debt.credit_loans.total_balance, 0)
	assert.equal(result.primary_rule_score.metrics.activeNonBankLoanCount, 1)
	assert.equal(result.deterministic_dimensions.nonBankLoanCount, 1)
})

test('two CNY cards are not merged merely because institution/date or model group match', () => {
	const facts = baseFacts()
	facts.loan_details.bank_loans = []
	facts.credit_card_details = [
		{
			institution: '同日开户银行',
			credit_limit: 100000,
			used_limit: 60000,
			currency: 'CNY',
			start_date: '2022-02-02',
			status: '正常',
			shared_credit_group: 'model-says-same'
		},
		{
			institution: '同日开户银行',
			credit_limit: 50000,
			used_limit: 15000,
			currency: 'CNY',
			start_date: '2022-02-02',
			status: '正常',
			shared_credit_group: 'model-says-same'
		}
	]

	const result = finalizeExtractedCreditFacts(attachCoverage(facts))
	assert.equal(result.credit_debt.credit_cards.total_limit, 150000)
	assert.equal(result.credit_debt.credit_cards.total_used, 75000)
	assert.equal(result.credit_debt.credit_cards.usage_rate, 0.5)
	assert.equal(result.credit_debt.credit_cards.shared_group_count, 0)
	assert.equal(result.credit_debt.credit_cards.utilization_group_count, 2)
})

test('validated card facts remain intact when derived utilization deduplicates rows', () => {
	const facts = baseFacts()
	facts.loan_details.bank_loans = []
	facts.credit_card_details = [
		{
			institution: '同一银行',
			credit_limit: 50000,
			used_limit: 10000,
			currency: 'CNY',
			card_tail: '1111',
			start_date: '2022-02-02',
			status: '正常'
		},
		{
			institution: '同一银行',
			credit_limit: 50000,
			used_limit: 10000,
			currency: 'CNY',
			card_tail: '2222',
			start_date: '2022-02-02',
			status: '正常'
		}
	]
	attachCoverage(facts)

	const result = finalizeExtractedCreditFacts(facts)

	assert.equal(result.credit_card_details.length, 2)
	assert.deepEqual(
		result.credit_card_details.map((row) => row.card_tail).sort(),
		['1111', '2222']
	)
	assert.deepEqual(
		result._coverage.counts.credit_card_details,
		{ total: 2, listed: 2 }
	)
	assert.equal(result.credit_debt.credit_cards.total_limit, 100000)
	assert.equal(result.credit_debt.credit_cards.total_used, 20000)
	assert.equal(result.credit_debt.credit_cards.card_count, 2)
	assert.equal(result.credit_debt.credit_cards.utilization_group_count, 2)
	assert.equal(result.credit_debt.credit_cards.shared_group_count, 0)
	assert.equal(result.deterministic_dimensions.creditCardCount, 2)
})

test('the same extracted facts produce byte-for-byte equivalent analysis objects', () => {
	const first = finalizeExtractedCreditFacts(baseFacts())
	const second = finalizeExtractedCreditFacts(baseFacts())

	assert.deepEqual(second, first)
})

test('incomplete fact arrays fail closed instead of producing partial metrics', () => {
	const facts = baseFacts()
	attachCoverage(facts, { query_details: { total: 10, listed: 2 } })

	assert.throws(
		() => finalizeExtractedCreditFacts(facts),
		(error) =>
			error &&
			error.code === 'DETERMINISTIC_FACTS_INCOMPLETE' &&
			Array.isArray(error.coverageIssues) &&
			error.coverageIssues.some((issue) => issue.array === 'query_details')
	)
})

test('incomplete overdue details fail closed instead of understating overdue risk', () => {
	const facts = baseFacts()
	attachCoverage(facts, { overdue_details: { total: 2, listed: 0 } })

	assert.throws(
		() => finalizeExtractedCreditFacts(facts),
		(error) => error && error.code === 'DETERMINISTIC_FACTS_INCOMPLETE'
	)
})

test('deterministic facts are not overwritten by a partial legacy source-text parser', () => {
	const facts = baseFacts()
	const sourceText = [
		'2026年1月1日另一测试银行发放的99999元（人民币）个人消费贷款，',
		'2027年1月1日到期。截至2026年6月，余额为9999'
	].join('')
	const result = finalizeExtractedCreditFacts(facts, sourceText)

	assert.equal(result.loan_details.bank_loans.length, 1)
	assert.equal(result.loan_details.bank_loans[0].institution, '测试银行')
	assert.equal(result.loan_details.bank_loans[0].balance, 40000)
})

test('official zero-month overdue wording remains a negative fact in legacy source normalization', () => {
	const facts = baseFacts()
	const sourceText = [
		'2020年1月1日测试银行发放的100000元（人民币）个人消费贷款，',
		'最近5年内有0个月处于逾期状态，没有发生过90天以上的逾期'
	].join('')
	const result = normalizeCreditAnalysisAggregates(facts, sourceText)

	assert.equal(result.loan_details.historical_overdue_loans.length, 0)
	assert.equal(result.overdue_info.has_overdue, false)
	assert.equal(result.overdue_info.total_overdue_accounts, 0)
	assert.equal(
		(result.risk_analysis?.risk_hits || []).some((hit) => hit?.rule_name === 'HISTORICAL_LARGE_OVERDUE'),
		false
	)
})

test('positive historical overdue months remain explicit and are never defaulted', () => {
	const facts = baseFacts()
	const sourceText = [
		'2020年1月1日测试银行发放的100000元（人民币）个人消费贷款，',
		'最近5年内有2个月处于逾期状态，没有发生过90天以上的逾期'
	].join('')
	const result = normalizeCreditAnalysisAggregates(facts, sourceText)

	assert.equal(result.loan_details.historical_overdue_loans.length, 1)
	assert.equal(result.loan_details.historical_overdue_loans[0].overdue_months, 2)
	assert.equal(result.overdue_info.has_overdue, true)
	assert.equal(result.overdue_info.total_overdue_months, 2)
	const overdueHit = result.risk_analysis.risk_hits.find((hit) => hit?.rule_name === 'HISTORICAL_LARGE_OVERDUE')
	assert.match(overdueHit.detail, /2个月逾期/)
})

test('revolving-loan negative overdue wording remains normal in legacy source normalization', () => {
	for (const status of ['未逾期', '无逾期', '从未逾期', '逾期月数为0']) {
		const facts = baseFacts()
		const sourceText = [
			'2025年1月1日测试银行为个人消费贷款授信，额度长期有效，可循环使用。',
			`截至2026年6月，信用额度10000元（人民币），余额为1000，当前${status}`
		].join('')
		const result = normalizeCreditAnalysisAggregates(facts, sourceText)
		const rebuilt = result.loan_details.bank_loans.find((row) => row.credit_limit === 10000)
		assert.equal(rebuilt.status, '正常', status)
	}
})

test('facts-only normalization does not replace queries from non-contiguous legacy text', () => {
	const facts = baseFacts()
	facts.query_analysis.query_details = []
	facts.query_analysis.self_queries = []
	attachCoverage(facts)
	const sourceText = [
		'机构查询记录明细',
		'1 2026年6月1日 甲银行 贷款审批',
		'3 2026年5月1日 乙银行 信用卡审批',
		'个人查询记录明细'
	].join('\n')

	const result = finalizeExtractedCreditFacts(facts, sourceText)

	assert.equal(result.query_analysis.query_details.length, 0)
	assert.deepEqual(
		result._coverage.counts.query_details,
		{ total: 0, listed: 0 }
	)
})

test('strict schema rejects unknown derived fields and incomplete coverage', () => {
	const unknown = baseFacts()
	unknown.credit_debt = { total_debt: 1 }
	assert.throws(
		() => validateExtractedCreditFactsSchema(unknown),
		(error) => error && error.code === 'FACT_SCHEMA_INVALID'
	)

	const incomplete = baseFacts()
	incomplete._coverage.counts.query_details.total += 1
	assert.throws(
		() => validateExtractedCreditFactsSchema(incomplete),
		(error) => error && error.code === 'FACT_SCHEMA_INVALID'
	)

	const invalidDate = baseFacts()
	invalidDate.meta.report_date = 'not-a-date'
	assert.throws(
		() => validateExtractedCreditFactsSchema(invalidDate),
		(error) => error && error.code === 'FACT_SCHEMA_INVALID'
	)
})

test('strict schema rejects empty, all-null, and seq-only fact rows', () => {
	for (const invalidRow of [
		{},
		{ seq: null, institution: null },
		{ seq: 1 }
	]) {
		const facts = sanitizeExtractedCreditFacts(baseFacts())
		facts.credit_card_details = [invalidRow]
		attachCoverage(facts)
		assert.throws(
			() => validateExtractedCreditFactsSchema(facts),
			(error) =>
				error &&
				error.code === 'FACT_SCHEMA_INVALID' &&
				error.schemaPath === '$.credit_card_details[0]'
		)
	}

	const zeroIsEvidence = sanitizeExtractedCreditFacts(baseFacts())
	zeroIsEvidence.credit_card_details = [{ institution: '甲银行', credit_limit: 0 }]
	attachCoverage(zeroIsEvidence)
	assert.equal(validateExtractedCreditFactsSchema(zeroIsEvidence), true)
})

test('strict schema accepts a complete prompt-shaped fact payload', () => {
	const facts = baseFacts()
	delete facts.credit_debt
	delete facts.risk_analysis
	delete facts.assessment
	delete facts.six_dimensions
	delete facts.query_analysis.summary
	for (const card of facts.credit_card_details) delete card.shared_credit_group

	assert.equal(validateExtractedCreditFactsSchema(facts), true)
})

test('strict schema allows large complete histories while retaining a 500-row safety limit', () => {
	const validQueries = sanitizeExtractedCreditFacts(baseFacts())
	validQueries.query_analysis.query_details = Array.from({ length: 81 }, (_, index) => ({
		institution: `查询机构${index + 1}`,
		date: '2026-06-01',
		reason: '贷款审批'
	}))
	attachCoverage(validQueries)
	assert.equal(validateExtractedCreditFactsSchema(validQueries), true)

	const excessiveQueries = sanitizeExtractedCreditFacts(baseFacts())
	excessiveQueries.query_analysis.query_details = Array.from({ length: 501 }, (_, index) => ({
		institution: `查询机构${index + 1}`,
		date: '2026-06-01',
		reason: '贷款审批'
	}))
	attachCoverage(excessiveQueries)
	assert.throws(
		() => validateExtractedCreditFactsSchema(excessiveQueries),
		(error) =>
			error &&
			error.code === 'FACT_SCHEMA_INVALID' &&
			error.schemaPath === '$.query_analysis.query_details' &&
			error.schemaReason === 'more_than_500_rows'
	)

	const validLoans = sanitizeExtractedCreditFacts(baseFacts())
	validLoans.loan_details.bank_loans = Array.from(
		{ length: 81 },
		(_, index) => ({
			seq: index + 1,
			institution: '测试银行',
			credit_limit: 100000,
			balance: 0,
			type: '个人消费贷款',
			status: '正常'
		})
	)
	attachCoverage(validLoans)
	assert.equal(validateExtractedCreditFactsSchema(validLoans), true)

	const excessiveLoans = sanitizeExtractedCreditFacts(baseFacts())
	excessiveLoans.loan_details.bank_loans = Array.from(
		{ length: 501 },
		(_, index) => ({
			seq: index + 1,
			institution: '测试银行',
			credit_limit: 100000,
			balance: 0,
			type: '个人消费贷款',
			status: '正常'
		})
	)
	attachCoverage(excessiveLoans)
	assert.throws(
		() => validateExtractedCreditFactsSchema(excessiveLoans),
		(error) =>
			error &&
			error.code === 'FACT_SCHEMA_INVALID' &&
			error.schemaPath === '$.loan_details.bank_loans' &&
			error.schemaReason === 'more_than_500_rows'
	)
})

test('query coverage is repaired only when source numbering proves completeness', () => {
	const completeSource = [
		'机构查询记录明细',
		'1 2026年6月1日 甲银行 贷款审批',
		'2 2026年5月1日 乙银行 信用卡审批',
		'个人查询记录明细'
	].join('\n')

	const countOnlyRepair = sanitizeExtractedCreditFacts(baseFacts())
	delete countOnlyRepair._coverage.counts_declared
	countOnlyRepair._coverage.counts.query_details = { total: 99, listed: 1 }
	reconcileSourceQueryCoverage(countOnlyRepair, completeSource)
	assert.equal(countOnlyRepair.query_analysis.query_details.length, 2)
	assert.deepEqual(
		countOnlyRepair._coverage.counts.query_details,
		{ total: 2, listed: 2 }
	)
	assert.equal(validateExtractedCreditFactsSchema(countOnlyRepair), true)

	const sourceRowRepair = sanitizeExtractedCreditFacts(baseFacts())
	delete sourceRowRepair._coverage.counts_declared
	sourceRowRepair.query_analysis.query_details = sourceRowRepair.query_analysis.query_details.slice(0, 1)
	sourceRowRepair._coverage.counts.query_details = { total: 2, listed: 1 }
	reconcileSourceQueryCoverage(sourceRowRepair, completeSource)
	assert.equal(sourceRowRepair.query_analysis.query_details.length, 2)
	assert.deepEqual(
		sourceRowRepair._coverage.counts.query_details,
		{ total: 2, listed: 2 }
	)
	assert.equal(validateExtractedCreditFactsSchema(sourceRowRepair), true)

	const paginatedSource = [
		'机构查询记录明细',
		'编号 查询日期 查询机构 查询原因',
		'1 2026年6月1日 甲银行信用卡中心 贷款审批',
		'2 2026年5月1日 换行显示的 乙银行 贷后管理',
		'第 1 页，共 2 页 【第2页】',
		'3 2026年4月1日 丙融资担保公司 担保资格审查',
		'个人查询记录明细'
	].join('\n')
	const paginatedRepair = sanitizeExtractedCreditFacts(baseFacts())
	delete paginatedRepair._coverage.counts_declared
	paginatedRepair.query_analysis.query_details = paginatedRepair.query_analysis.query_details.slice(0, 1)
	paginatedRepair._coverage.counts.query_details = { total: 1, listed: 1 }
	reconcileSourceQueryCoverage(paginatedRepair, paginatedSource)
	assert.deepEqual(
		paginatedRepair.query_analysis.query_details.map((row) => row.reason),
		['贷款审批', '贷后管理', '担保资格审查']
	)
	assert.deepEqual(
		paginatedRepair._coverage.counts.query_details,
		{ total: 3, listed: 3 }
	)
	assert.equal(validateExtractedCreditFactsSchema(paginatedRepair), true)

	const incompleteSource = [
		'机构查询记录明细',
		'1 2026年6月1日 甲银行 贷款审批',
		'2 2026年5月1日 无法解析的查询原因',
		'个人查询记录明细'
	].join('\n')
	const failClosed = sanitizeExtractedCreditFacts(baseFacts())
	delete failClosed._coverage.counts_declared
	failClosed.query_analysis.query_details = failClosed.query_analysis.query_details.slice(0, 1)
	failClosed._coverage.counts.query_details = { total: 2, listed: 1 }
	reconcileSourceQueryCoverage(failClosed, incompleteSource)
	assert.equal(failClosed.query_analysis.query_details.length, 1)
	assert.throws(
		() => validateExtractedCreditFactsSchema(failClosed),
		(error) =>
			error &&
			error.code === 'FACT_SCHEMA_INVALID' &&
			error.schemaPath === '$._coverage.counts.query_details' &&
			error.schemaReason === 'total/listed_mismatch'
	)

	for (const unsafeSource of [
		[
			'机构查询记录明细',
			'2 2026年6月1日 甲银行 贷款审批',
			'2 2026年5月1日 乙银行 信用卡审批',
			'个人查询记录明细'
		].join('\n'),
		[
			'机构查询记录明细',
			'1 2026年6月1日 【第2页】甲银行 贷款审批',
			'个人查询记录明细'
		].join('\n'),
		[
			'机构查询记录明细',
			'1 2026年2月31日 甲银行 贷款审批',
			'个人查询记录明细'
		].join('\n')
	]) {
		const unsafe = sanitizeExtractedCreditFacts(baseFacts())
		delete unsafe._coverage.counts_declared
		unsafe.query_analysis.query_details = unsafe.query_analysis.query_details.slice(0, 1)
		unsafe._coverage.counts.query_details = { total: 2, listed: 1 }
		reconcileSourceQueryCoverage(unsafe, unsafeSource)
		assert.equal(unsafe.query_analysis.query_details.length, 1)
		assert.throws(
			() => validateExtractedCreditFactsSchema(unsafe),
			(error) =>
				error &&
				error.code === 'FACT_SCHEMA_INVALID' &&
				error.schemaPath === '$._coverage.counts.query_details'
		)
	}
})

test('query windows use report date, inclusive calendar months, and hard inquiries only', () => {
	const facts = baseFacts()
	facts.loan_details.bank_loans = []
	facts.credit_card_details = []
	facts.query_analysis.query_details = [
		{ institution: '甲银行', date: '2026-05-30', reason: '贷款审批' },
		{ institution: '甲银行', date: '2026-05-29', reason: '贷款审批' },
		{ institution: '乙银行', date: '2026-06-30', reason: '信用卡审批' },
		{ institution: '乙银行', date: '2026-06-30', reason: '信用卡审批' },
		{ institution: '甲银行', date: '2026-06-20', reason: '贷后管理' },
		{ institution: '中国人民银行', date: '2026-06-10', reason: '本人查询' },
		{ institution: '担保公司', date: '2026-06-01', reason: '担保资格审查' }
	]
	const result = finalizeExtractedCreditFacts(attachCoverage(facts))

	assert.equal(result.query_analysis.summary.last_1m.total, 4)
	assert.equal(result.query_analysis.summary.last_1m.loan_approval, 2)
	assert.equal(result.query_analysis.summary.last_1m.credit_card_approval, 2)
	assert.equal(result.query_analysis.summary.last_1m.bank, 3)
	assert.equal(result.query_analysis.summary.last_1m.non_bank, 0)
	assert.equal(result.query_analysis.summary.last_1m.unknown, 1)
	assert.equal(result.query_analysis.all_query_summary.last_1m.total, 6)
	assert.equal(result.deterministic_dimensions.q1, 4)
	assert.equal(result.deterministic_dimensions.loanQueryCount, 2)
	assert.equal(result.deterministic_dimensions.cardQueryCount, 2)
	assert.equal(result.deterministic_dimensions.anchorDate, '2026-06-30')
})

test('same-day scoring ignores post-loan management and hard inquiries outside six months', () => {
	for (const queryDetails of [
		Array.from({ length: 4 }, (_, index) => ({
			institution: `贷后机构${index + 1}`,
			date: '2026-06-20',
			reason: '贷后管理'
		})),
		Array.from({ length: 4 }, (_, index) => ({
			institution: `历史机构${index + 1}`,
			date: '2025-01-15',
			reason: '贷款审批'
		}))
	]) {
		const facts = baseFacts()
		facts.loan_details.bank_loans = []
		facts.loan_details.non_bank_loans = []
		facts.credit_card_details = []
		facts.query_analysis.query_details = queryDetails
		const result = finalizeExtractedCreditFacts(attachCoverage(facts))

		assert.equal(result.query_analysis.summary.last_6m.total, 0)
		assert.equal(result.primary_rule_score.metrics.sameDayTriggered, false)
		assert.equal(
			result.primary_rule_score.deductions.some((item) => item.code === 'SAME_DAY_QUERY_GT_3'),
			false
		)
	}
})

test('report interpretation never describes post-loan-management rows as approval inquiries', () => {
	const facts = baseFacts()
	facts.loan_details.bank_loans = []
	facts.loan_details.non_bank_loans = []
	facts.credit_card_details = []
	facts.query_analysis.query_details = Array.from({ length: 60 }, (_, index) => ({
		institution: `贷后机构${index + 1}`,
		date: '2026-06-20',
		reason: '贷后管理'
	}))
	const result = finalizeExtractedCreditFacts(attachCoverage(facts))

	assert.equal(result.report_interpretation.queries.query_details_total, 60)
	assert.equal(result.report_interpretation.queries.hard_query_details_total, 0)
	assert.equal(
		result.report_interpretation.key_points.some((item) => item.title === '查询记录偏密'),
		false
	)
	assert.equal(
		result.report_interpretation.action_items.some((item) => item.includes('暂停贷款和信用卡申请')),
		false
	)
})

test('authoritative deterministic dimensions satisfy the frontend contract', () => {
	const result = finalizeExtractedCreditFacts(baseFacts())
	for (const key of [
		'totalAccountCount', 'activeAccountCount', 'settledAccountCount',
		'creditCardCount', 'loanCount', 'nonBankLoanCount',
		'q1', 'q3', 'q6', 'q12', 'loanQueryCount', 'cardQueryCount',
		'overdueCount', 'm1Count', 'm2Count', 'm3Count',
		'cardUtilizationRate', 'totalDebt', 'debtRatio'
	]) {
		assert.equal(Number.isFinite(Number(result.deterministic_dimensions[key])), true, key)
	}
})

test('DeepSeek request is pinned to JSON mode, zero temperature and disabled thinking', () => {
	const body = buildCreditChatRequest('x'.repeat(80), 4096)
	assert.equal(body.model, process.env.DEEPSEEK_TEXT_MODEL || 'deepseek-v4-flash')
	assert.equal(body.temperature, 0)
	assert.equal(body.max_tokens, 4096)
	assert.deepEqual(body.response_format, { type: 'json_object' })
	assert.deepEqual(body.thinking, { type: 'disabled' })
})

test('DeepSeek request defaults to a 128K structured-output budget', () => {
	const previous = process.env.DEEPSEEK_OUTPUT_MAX_TOKENS
	delete process.env.DEEPSEEK_OUTPUT_MAX_TOKENS
	try {
		assert.equal(buildCreditChatRequest('x'.repeat(80)).max_tokens, 131072)
	} finally {
		if (previous === undefined) delete process.env.DEEPSEEK_OUTPUT_MAX_TOKENS
		else process.env.DEEPSEEK_OUTPUT_MAX_TOKENS = previous
	}
})

test('input above the 1M document hard ceiling fails before any model call', async () => {
	const previousKey = process.env.DEEPSEEK_API_KEY
	const previousDocumentMax = process.env.CREDIT_DOCUMENT_MAX_CHARS
	const previousFetch = global.fetch
	process.env.DEEPSEEK_API_KEY = 'local-test-key'
	delete process.env.CREDIT_DOCUMENT_MAX_CHARS
	let calls = 0
	global.fetch = async () => {
		calls += 1
		throw new Error('must not call fetch')
	}
	try {
		const result = await runCreditLLMAnalysis('征'.repeat(1000001))
		assert.equal(result.ok, false)
		assert.equal(result.errCode, 'ANALYSIS_INPUT_TOO_LARGE')
		assert.equal(calls, 0)
	} finally {
		global.fetch = previousFetch
		if (previousDocumentMax === undefined) delete process.env.CREDIT_DOCUMENT_MAX_CHARS
		else process.env.CREDIT_DOCUMENT_MAX_CHARS = previousDocumentMax
		if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY
		else process.env.DEEPSEEK_API_KEY = previousKey
	}
})

test('all authoritative OCR evidence modes fail before stages or model calls', async () => {
	const previousKey = process.env.DEEPSEEK_API_KEY
	const previousFetch = global.fetch
	process.env.DEEPSEEK_API_KEY = 'local-test-key'
	let calls = 0
	let stages = 0
	global.fetch = async () => {
		calls += 1
		throw new Error('must not call fetch')
	}
	try {
		for (const sourceMode of ['ocr', 'ocr-image']) {
			const result = await runCreditLLMAnalysis('扫描件识别文字'.repeat(20), {
				evidenceRequired: true,
				onStage: () => { stages += 1 },
				evidenceContext: {
					version: `${sourceMode}-span-v1`,
					sourceMode,
					expectedPageCount: 2,
					complete: true,
					geometryState: 'unavailable',
					pages: [{ pageNumber: 1, text: '扫描件识别文字', blocks: [] }]
				}
			})
			assert.equal(result.ok, false)
			assert.equal(result.httpStatus, 422)
			assert.equal(result.errCode, 'OCR_STRUCTURED_EVIDENCE_UNAVAILABLE')
		}
		assert.equal(calls, 0)
		assert.equal(stages, 0)
	} finally {
		global.fetch = previousFetch
		if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY
		else process.env.DEEPSEEK_API_KEY = previousKey
	}
})

test('legacy or incomplete PDF evidence fails closed while complete native PDF evidence is allowed', async () => {
	for (const evidenceContext of [
		{ sourceMode: 'pdf-parse-legacy', complete: false },
		{ sourceMode: 'pdf-text', complete: false }
	]) {
		const blocked = preflightCreditEvidenceSource({ evidenceRequired: true, evidenceContext })
		assert.equal(blocked.ok, false)
		assert.equal(blocked.httpStatus, 422)
		assert.equal(blocked.errCode, 'PDF_EVIDENCE_SOURCE_UNVERIFIED')
	}
	assert.equal(preflightCreditEvidenceSource({
		evidenceRequired: true,
		evidenceContext: { sourceMode: 'pdf-text', complete: true, pages: [] }
	}), null)
	assert.equal(preflightCreditEvidenceSource({
		evidenceRequired: false,
		evidenceContext: { sourceMode: 'ocr', complete: false }
	}), null)
})
