'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
	buildDeterministicCreditChunks,
	mergeExtractedCreditFactChunks,
	assertSourceAccountOverviewCoverage,
	addDeterministicPdfPageMarkers,
	stripVerifiedQuerySectionForModel
} = require('../backend/services/creditAnalysisService')

test('text-layer PDF pages receive stable markers without changing page text', () => {
	const marked = addDeterministicPdfPageMarkers('\n\n首页事实\n第二行\n\n次页事实', 2)
	assert.equal(marked, '【第1页】\n首页事实\n第二行\n\n【第2页】\n次页事实')
	assert.equal(addDeterministicPdfPageMarkers('无法证明分页', 2), '无法证明分页')
})

test('a fully verified institution-query table is omitted only from model input', () => {
	const source = [
		'【第1页】',
		'账户明细',
		'机构查询记录明细',
		'12026年5月9日甲银行贷款审批',
		'个人查询记录明细',
		'1 2026年5月1日 本人 本人查询（互联网个人信用信息服务平台）',
		'公共记录明细'
	].join('\n')
	const evidence = {
		query_details_total: 1,
		query_details: [{ seq: 1, date: '2026-05-09', institution: '甲银行', reason: '贷款审批' }]
	}
	const modelText = stripVerifiedQuerySectionForModel(source, evidence)

	assert.match(modelText, /账户明细/)
	assert.doesNotMatch(modelText, /12026年5月9日/)
	assert.match(modelText, /机构查询明细由服务端独立核验/)
	assert.match(modelText, /本人查询（互联网个人信用信息服务平台）/)
	assert.match(modelText, /公共记录明细/)
})

function buildChunkFacts(overrides = {}) {
	const facts = {
		meta: {
			report_type: '个人信用报告',
			report_date: '2026-06-30',
			query_date: '2026-06-30',
			...(overrides.meta || {})
		},
		basic_info: { ...(overrides.basic_info || {}) },
		loan_details: {
			bank_loans: [],
			non_bank_loans: [],
			settled_loans: [],
			historical_overdue_loans: [],
			...(overrides.loan_details || {})
		},
		credit_card_details: overrides.credit_card_details || [],
		credit_card_details_cancelled: overrides.credit_card_details_cancelled || [],
		query_analysis: {
			query_details: [],
			self_queries: [],
			...(overrides.query_analysis || {})
		},
		overdue_info: {
			has_overdue: false,
			details: [],
			...(overrides.overdue_info || {})
		},
		public_records: {
			has_record: false,
			items: [],
			...(overrides.public_records || {})
		},
		guarantee_records: {
			total_amount: 0,
			items: [],
			...(overrides.guarantee_records || {})
		},
		loan_history: {
			title: null,
			unit: null,
			trend_data: [],
			...(overrides.loan_history || {})
		}
	}
	const arrays = {
		bank_loans: facts.loan_details.bank_loans,
		non_bank_loans: facts.loan_details.non_bank_loans,
		settled_loans: facts.loan_details.settled_loans,
		historical_overdue_loans: facts.loan_details.historical_overdue_loans,
		credit_card_details: facts.credit_card_details,
		credit_card_details_cancelled: facts.credit_card_details_cancelled,
		query_details: facts.query_analysis.query_details,
		self_queries: facts.query_analysis.self_queries,
		overdue_details: facts.overdue_info.details,
		public_records: facts.public_records.items,
		guarantee_records: facts.guarantee_records.items,
		loan_history: facts.loan_history.trend_data
	}
	facts._coverage = {
		has_basic_info: Object.keys(facts.basic_info).length > 0,
		has_loans: arrays.bank_loans.length + arrays.non_bank_loans.length > 0,
		has_cards: arrays.credit_card_details.length > 0,
		has_queries: arrays.query_details.length > 0,
		has_overdue: facts.overdue_info.has_overdue === true,
		has_public_records: facts.public_records.has_record === true,
		has_guarantee: arrays.guarantee_records.length > 0,
		truncated: false,
		notes: '',
		counts: Object.fromEntries(Object.entries(arrays).map(([name, rows]) => [
			name,
			{ total: rows.length, listed: rows.length }
		]))
	}
	return facts
}

test('page-aware chunks are deterministic, non-overlapping, and reconstruct the source', () => {
	const source = `报告前言\n${Array.from(
		{ length: 10 },
		(_, index) => `【第${index + 1}页】\n${String(index + 1).repeat(120)}\n`
	).join('')}`
	const options = { triggerPages: 2, maxPages: 3, maxChars: 1000 }
	const first = buildDeterministicCreditChunks(source, options)
	const second = buildDeterministicCreditChunks(source, options)

	assert.deepEqual(second, first)
	assert.ok(first.length > 1)
	assert.equal(first.map((chunk) => chunk.text).join(''), source)
	assert.equal(first[0].start, 0)
	assert.equal(first.at(-1).end, source.length)
	for (let index = 0; index < first.length; index += 1) {
		assert.equal(first[index].index, index)
		assert.equal(first[index].total, first.length)
		assert.ok(first[index].text.length <= 1000)
		if (index > 0) assert.equal(first[index - 1].end, first[index].start)
	}
})

test('dense OCR reports default to bounded three-page model chunks', () => {
	const source = Array.from(
		{ length: 8 },
		(_, index) => `【第${index + 1}页】\n本页原始事实\n`
	).join('')
	const chunks = buildDeterministicCreditChunks(source)

	assert.equal(chunks.length, 3)
	assert.deepEqual(chunks.map((chunk) => chunk.pageStart), [1, 4, 7])
	assert.deepEqual(chunks.map((chunk) => chunk.pageEnd), [3, 6, 8])
	assert.equal(chunks.map((chunk) => chunk.text).join(''), source)
})

test('long text without page markers is split without loss or overlap', () => {
	const source = `${'段落甲。'.repeat(420)}\n${'段落乙；'.repeat(420)}`
	const chunks = buildDeterministicCreditChunks(source, {
		triggerChars: 1000,
		maxChars: 1000
	})

	assert.ok(chunks.length >= 3)
	assert.equal(chunks.map((chunk) => chunk.text).join(''), source)
	assert.ok(chunks.every((chunk) => chunk.text.length > 0 && chunk.text.length <= 1000))
})

test('an oversized OCR page is reconstructed byte-for-byte across internal chunk boundaries', () => {
	const longPage = [
		'【第1页】\n',
		'账户明细开始\n',
		'甲银行 授信额度100000元 余额50000元。'.repeat(90),
		'\n账户明细结束'
	].join('')
	const source = `${longPage}【第2页】\n报告说明`
	const chunks = buildDeterministicCreditChunks(source, {
		triggerPages: 2,
		maxPages: 1,
		maxChars: 1000
	})

	assert.ok(chunks.length > 2)
	assert.equal(chunks.map((chunk) => chunk.text).join(''), source)
	for (let index = 0; index < chunks.length; index += 1) {
		const chunk = chunks[index]
		assert.equal(chunk.text, source.slice(chunk.start, chunk.end))
		if (index > 0) assert.equal(chunks[index - 1].end, chunk.start)
	}
})

test('chunk merge preserves identical legitimate query rows and derives report aggregates once', () => {
	const identicalQuery = { institution: '示例银行', date: '2026-06-01', reason: '贷款审批' }
	const first = buildChunkFacts({
		meta: { report_valid: false },
		basic_info: { name: '测**', id_last4: '1234' },
		query_analysis: { query_details: [identicalQuery] },
		guarantee_records: { total_amount: 100 }
	})
	const second = buildChunkFacts({
		meta: { report_valid: true },
		query_analysis: { query_details: [identicalQuery] },
		overdue_info: {
			has_overdue: true,
			total_overdue_accounts: 1,
			details: [{ institution: '示例机构', date: '2025-01-01', overdue_months: 2 }]
		},
		public_records: {
			has_record: true,
			items: [{ type: '民事判决', date: '2025-01-01', detail: '已结案' }]
		},
		guarantee_records: {
			total_amount: 200,
			items: [{ guarantee_for: '示例主体', amount: 150, status: '正常' }]
		}
	})

	const merged = mergeExtractedCreditFactChunks([first, second])

	assert.equal(merged.query_analysis.query_details.length, 2)
	assert.deepEqual(merged._coverage.counts.query_details, { total: 2, listed: 2 })
	assert.equal(merged.meta.report_valid, true)
	assert.equal(merged.overdue_info.has_overdue, true)
	assert.equal(merged.overdue_info.total_overdue_accounts, 1)
	assert.equal(merged.overdue_info.total_overdue_months, 2)
	assert.equal(merged.public_records.has_record, true)
	assert.equal(merged.guarantee_records.total_amount, 200)
})

test('chunk merge fails closed on conflicting identity facts', () => {
	const first = buildChunkFacts({ basic_info: { name: '测试甲' } })
	const second = buildChunkFacts({ basic_info: { name: '测试乙' } })

	assert.throws(
		() => mergeExtractedCreditFactChunks([first, second]),
		(error) => error &&
			error.code === 'CHUNK_SCALAR_CONFLICT' &&
			error.schemaPath === '$.basic_info.name'
	)
})

test('chunk merge fails closed when a numbered fact is repeated across chunks', () => {
	const repeated = {
		seq: 1,
		institution: '示例银行',
		credit_limit: 10000,
		balance: 5000,
		status: '正常'
	}
	const first = buildChunkFacts({ loan_details: { bank_loans: [repeated] } })
	const second = buildChunkFacts({ loan_details: { bank_loans: [repeated] } })

	assert.throws(
		() => mergeExtractedCreditFactChunks([first, second]),
		(error) => error && error.code === 'CHUNK_FACT_CONFLICT'
	)
})

test('source account overview independently verifies merged card and loan counts', () => {
	const facts = buildChunkFacts({
		loan_details: {
			bank_loans: [{ institution: '甲银行', balance: 1000, status: '正常' }],
			settled_loans: [
				{ institution: '乙银行', balance: 0, status: '已结清' },
				{ institution: '丙银行', balance: 0, status: '已结清' }
			]
		},
		credit_card_details: [{ institution: '甲银行', status: '正常' }],
		credit_card_details_cancelled: [{ institution: '乙银行', status: '已销户' }]
	})
	const source = [
		'信息概要',
		'信用卡 购房贷款 其他贷款 其他',
		'账户数 2 0 3 0',
		'未结清/未销户账户数 1 0 1 0',
		'发生过逾期的账户数 0 0 0 0',
		'发生过90天以上逾期的账户数 0 0 0 0',
		'信贷交易信息明细'
	].join('\n')

	assert.equal(assertSourceAccountOverviewCoverage(facts, source), true)
	facts.loan_details.settled_loans.pop()
	assert.throws(
		() => assertSourceAccountOverviewCoverage(facts, source),
		(error) => error &&
			error.code === 'CHUNK_SOURCE_OVERVIEW_MISMATCH' &&
			error.expectedCount === 3 &&
			error.actualCount === 2
	)
})

test('a missing open-account overview row remains unknown instead of being treated as zero', () => {
	const facts = buildChunkFacts({
		loan_details: {
			bank_loans: [{ institution: '甲银行', balance: 1000, status: '正常' }]
		},
		credit_card_details: [{ institution: '乙银行', status: '正常' }]
	})
	const source = [
		'信息概要',
		'信用卡 购房贷款 其他贷款 其他业务',
		'账户数 1 0 1 0',
		'发生过逾期的账户数 0 0 0 0',
		'发生过90天以上逾期的账户数 0 0 0 0',
		'信贷交易信息明细'
	].join('\n')

	assert.doesNotThrow(() => assertSourceAccountOverviewCoverage(facts, source))
})

function accountOverviewSource({ cardTotal = 0, cardOpen = 0, loanTotal = 0, loanOpen = 0, decoy = false } = {}) {
	return [
		'信息概要',
		...(decoy ? [
			'账户数 9 9 9 9',
			'未结清/未销户账户数 9 9 9 9',
			'发生过逾期的账户数 9 9 9 9',
			'发生过90天以上逾期的账户数 9 9 9 9'
		] : []),
		'信用卡 购房贷款 其他贷款 其他业务',
		`账户数 ${cardTotal} 0 ${loanTotal} 0`,
		`未结清/未销户账户数 ${cardOpen} 0 ${loanOpen} 0`,
		'发生过逾期的账户数 0 0 0 0',
		'发生过90天以上逾期的账户数 0 0 0 0',
		'信贷交易信息明细'
	].join('\n')
}

function closedRowsInActiveBuckets() {
	return buildChunkFacts({
		loan_details: {
			bank_loans: [{ institution: '示例银行甲', status: '已结清' }],
			settled_loans: [{ institution: '示例银行乙', status: '已结清' }],
			historical_overdue_loans: [{ institution: '示例银行丙', status: '历史逾期' }]
		},
		credit_card_details: [{ institution: '示例银行甲', status: '已销户' }],
		credit_card_details_cancelled: [{ institution: '示例银行乙', status: '已销户' }]
	})
}

test('overview active counts reuse authoritative closed-status semantics for rows in active buckets', () => {
	const source = accountOverviewSource({ cardTotal: 2, loanTotal: 2 })
	const facts = closedRowsInActiveBuckets()

	assert.doesNotThrow(() => assertSourceAccountOverviewCoverage(facts, source))

	facts.loan_details.bank_loans[0].status = '正常'
	assert.throws(
		() => assertSourceAccountOverviewCoverage(facts, source),
		(error) => error &&
			error.code === 'CHUNK_SOURCE_OVERVIEW_MISMATCH' &&
			error.schemaPath === '$.loan_details.active' &&
			error.expectedCount === 0 &&
			error.actualCount === 1
	)
})

test('overview card active counts reuse authoritative cancelled-status semantics', () => {
	const source = accountOverviewSource({ cardTotal: 2, loanTotal: 2 })
	const facts = closedRowsInActiveBuckets()
	facts.credit_card_details[0].status = '正常'

	assert.throws(
		() => assertSourceAccountOverviewCoverage(facts, source),
		(error) => error &&
			error.code === 'CHUNK_SOURCE_OVERVIEW_MISMATCH' &&
			error.schemaPath === '$.credit_card_details.active' &&
			error.expectedCount === 0 &&
			error.actualCount === 1
	)
})

test('text overview binds the unique official table after its header and keeps historical overdue rows archival', () => {
	const source = accountOverviewSource({ cardTotal: 2, loanTotal: 2, decoy: true })
	const facts = closedRowsInActiveBuckets()

	assert.doesNotThrow(() => assertSourceAccountOverviewCoverage(facts, source))

	facts.loan_details.settled_loans.pop()
	assert.throws(
		() => assertSourceAccountOverviewCoverage(facts, source),
		(error) => error &&
			error.code === 'CHUNK_SOURCE_OVERVIEW_MISMATCH' &&
			error.schemaPath === '$.loan_details' &&
			error.expectedCount === 2 &&
			error.actualCount === 1
	)
})

test('multiple complete text overview tables are ambiguous and fail closed', () => {
	const first = accountOverviewSource({ cardTotal: 2, loanTotal: 2 })
		.replace('信贷交易信息明细', '')
	const second = accountOverviewSource({ cardTotal: 2, loanTotal: 2 })
		.replace('信息概要\n', '')
	const source = `${first}\n${second}`

	assert.throws(
		() => assertSourceAccountOverviewCoverage(closedRowsInActiveBuckets(), source),
		(error) => error &&
			error.code === 'CHUNK_SOURCE_OVERVIEW_MISMATCH' &&
			error.schemaPath === '$.source.account_overview' &&
			error.expectedCount === 1 &&
			error.actualCount === 2
	)
})

test('four synthetic loan chunks retain all rows and report exact overview undercount and overcount paths', () => {
	const counts = [84, 84, 84, 83]
	let nextSeq = 1
	const fullChunks = counts.map((count) => {
		const rows = Array.from({ length: count }, (_, index) => ({
			seq: nextSeq + index,
			institution: `SYNTHETIC_LENDER_${String(nextSeq + index).padStart(4, '0')}`,
			status: '正常'
		}))
		nextSeq += count
		return buildChunkFacts({ loan_details: { bank_loans: rows } })
	})
	const source = accountOverviewSource({ loanTotal: 335, loanOpen: 335 })
	const merged = mergeExtractedCreditFactChunks(fullChunks)

	assert.equal(merged.loan_details.bank_loans.length, 335)
	assert.doesNotThrow(() => assertSourceAccountOverviewCoverage(merged, source))

	const retained = [50, 50, 50, 47]
	const undercountChunks = fullChunks.map((facts, index) => buildChunkFacts({
		loan_details: { bank_loans: facts.loan_details.bank_loans.slice(0, retained[index]) }
	}))
	const undercount = mergeExtractedCreditFactChunks(undercountChunks)
	assert.equal(undercount.loan_details.bank_loans.length, 197)
	assert.throws(
		() => assertSourceAccountOverviewCoverage(undercount, source),
		(error) => error &&
			error.code === 'CHUNK_SOURCE_OVERVIEW_MISMATCH' &&
			error.schemaPath === '$.loan_details' &&
			error.expectedCount === 335 &&
			error.actualCount === 197
	)

	const extraRow = {
		seq: 336,
		institution: 'SYNTHETIC_LENDER_0336',
		status: '正常'
	}
	const overcountChunks = fullChunks.map((facts, index) => buildChunkFacts({
		loan_details: {
			bank_loans: index === 3
				? [...facts.loan_details.bank_loans, extraRow]
				: facts.loan_details.bank_loans
		}
	}))
	const overcount = mergeExtractedCreditFactChunks(overcountChunks)
	assert.equal(overcount.loan_details.bank_loans.length, 336)
	assert.throws(
		() => assertSourceAccountOverviewCoverage(overcount, source),
		(error) => error &&
			error.code === 'CHUNK_SOURCE_OVERVIEW_MISMATCH' &&
			error.schemaPath === '$.loan_details' &&
			error.expectedCount === 335 &&
			error.actualCount === 336
	)
})
