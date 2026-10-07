'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

process.env.DEEPSEEK_API_KEY = 'offline-test-key'
process.env.DEEPSEEK_MAX_ATTEMPTS = '1'
delete process.env.DEEPSEEK_TEXT_MODEL

const {
	runCreditLLMAnalysis
} = require('../backend/services/creditAnalysisService')

const ORIGINAL_FETCH = global.fetch
const SOURCE_TEXT = `个人信用报告 报告时间：2026-06-30 ${'完整报告正文'.repeat(20)}`

function coverageCounts() {
	return Object.fromEntries([
		'bank_loans',
		'non_bank_loans',
		'settled_loans',
		'historical_overdue_loans',
		'credit_card_details',
		'credit_card_details_cancelled',
		'query_details',
		'self_queries',
		'overdue_details',
		'public_records',
		'guarantee_records',
		'loan_history'
	].map((name) => [name, { total: 0, listed: 0 }]))
}

function completeFacts() {
	return {
		meta: { report_date: '2026-06-30' },
		basic_info: {},
		loan_details: {
			bank_loans: [],
			non_bank_loans: [],
			settled_loans: [],
			historical_overdue_loans: []
		},
		credit_card_details: [],
		credit_card_details_cancelled: [],
		query_analysis: { query_details: [], self_queries: [] },
		overdue_info: { details: [] },
		public_records: { items: [] },
		guarantee_records: { items: [] },
		loan_history: { trend_data: [] },
		_coverage: {
			truncated: false,
			counts: coverageCounts(),
			notes: ''
		}
	}
}

function sseResponse(content, finishReason = 'stop') {
	const events = [
		`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n`,
		`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n`,
		'data: [DONE]\n'
	]
	return {
		ok: true,
		status: 200,
		body: (async function * stream() {
			for (const event of events) yield Buffer.from(event, 'utf8')
		})()
	}
}

const SYNTHETIC_CHUNK_ENV_KEYS = [
	'DEEPSEEK_CHUNK_TRIGGER_PAGES',
	'DEEPSEEK_CHUNK_MAX_PAGES',
	'DEEPSEEK_CHUNK_MAX_CHARS',
	'DEEPSEEK_CHUNK_CONCURRENCY'
]

function syntheticLoanRows(start, count) {
	return Array.from({ length: count }, (_, index) => {
		const seq = start + index
		return {
			seq,
			institution: `SYNTHETIC_LENDER_${String(seq).padStart(4, '0')}`,
			status: '正常'
		}
	})
}

function syntheticFourChunkSource() {
	const pageCounts = [84, 84, 84, 83]
	let nextSeq = 1
	return pageCounts.map((count, index) => {
		const lines = syntheticLoanRows(nextSeq, count)
			.map((row) => `SYNTH_LOAN_${String(row.seq).padStart(4, '0')}`)
		nextSeq += count
		if (index === 0) {
			lines.unshift(
				'个人信用报告 报告时间：2026-06-30',
				'信息概要',
				'信用卡 购房贷款 其他贷款 其他业务',
				'账户数 0 0 335 0',
				'未结清/未销户账户数 0 0 335 0',
				'发生过逾期的账户数 0 0 0 0',
				'发生过90天以上逾期的账户数 0 0 0 0',
				'信贷交易信息明细'
			)
		}
		return `【第${index + 1}页】\n${lines.join('\n')}`
	}).join('\n')
}

async function runSyntheticFourChunkScenario(retainedCounts, mutateFacts) {
	const starts = [1, 85, 169, 253]
	let calls = 0
	global.fetch = async (_url, options) => {
		calls += 1
		const request = JSON.parse(String(options && options.body || '{}'))
		const userText = String(request.messages?.find((message) => message.role === 'user')?.content || '')
		const chunkNumber = Number(userText.match(/第 (\d+)\/4 个/)?.[1] || 0)
		assert.ok(chunkNumber >= 1 && chunkNumber <= 4)
		const rows = syntheticLoanRows(starts[chunkNumber - 1], retainedCounts[chunkNumber - 1])
		const facts = completeFacts()
		facts.loan_details.bank_loans = rows
		facts._coverage.counts.bank_loans = { total: rows.length, listed: rows.length }
		if (typeof mutateFacts === 'function') mutateFacts(facts, chunkNumber)
		return sseResponse(JSON.stringify(facts))
	}
	const result = await runCreditLLMAnalysis(syntheticFourChunkSource())
	return { result, calls }
}

test.after(() => {
	global.fetch = ORIGINAL_FETCH
	delete process.env.DEEPSEEK_INPUT_MAX_CHARS
})

test('DeepSeek request fixes model mode and JSON output contract', async () => {
	let calls = 0
	let requestBody = null
	global.fetch = async (_url, options) => {
		calls += 1
		requestBody = JSON.parse(options.body)
		return sseResponse(JSON.stringify(completeFacts()))
	}

	const result = await runCreditLLMAnalysis(SOURCE_TEXT)

	assert.equal(result.ok, true)
	assert.equal(calls, 1)
	assert.equal(requestBody.model, 'deepseek-v4-flash')
	assert.equal(requestBody.temperature, 0)
	assert.deepEqual(requestBody.response_format, { type: 'json_object' })
	assert.deepEqual(requestBody.thinking, { type: 'disabled' })
	assert.equal(requestBody.max_tokens, 131072)
	assert.match(requestBody.messages[0].content, /值为 null 的明细字段必须省略/)
	assert.match(requestBody.messages[0].content, /输出紧凑 JSON/)
	assert.equal(requestBody.stream, true)
	assert.equal(result.data.derivation_meta.mode, 'deterministic-v1')
	assert.equal(result.data.derivation_meta.anchor_date, '2026-06-30')
})

test('a complete JSON response above 100k characters is accumulated and accepted', async () => {
	const facts = completeFacts()
	facts._coverage.notes = 'x'.repeat(110000)
	const content = JSON.stringify(facts)
	assert.ok(content.length > 100000)
	global.fetch = async () => sseResponse(content)

	const result = await runCreditLLMAnalysis(SOURCE_TEXT)

	assert.equal(result.ok, true)
	assert.equal(result.data._coverage.llm_finish_reason, 'stop')
})

test('a declared missing fact row is repaired by a bounded targeted extraction', async () => {
	const firstPass = completeFacts()
	firstPass.loan_details.settled_loans = [
		{ seq: 1, institution: '甲银行', status: '已结清' }
	]
	firstPass._coverage.counts.settled_loans = { total: 2, listed: 1 }
	const targeted = {
		complete: true,
		total: 2,
		rows: [
			{ seq: 1, institution: '甲银行', status: '已结清' },
			{ seq: 2, institution: '乙银行', status: '已结清' }
		]
	}
	let calls = 0
	global.fetch = async () => {
		calls += 1
		return sseResponse(JSON.stringify(calls === 1 ? firstPass : targeted))
	}

	const result = await runCreditLLMAnalysis(SOURCE_TEXT)

	assert.equal(result.ok, true)
	assert.equal(calls, 2)
	assert.equal(result.data.loan_details.settled_loans.length, 2)
	assert.deepEqual(
		result.data._coverage.counts.settled_loans,
		{ total: 2, listed: 2 }
	)
})

test('empty card placeholders are pruned before coverage repair without lowering total', async () => {
	const firstPass = completeFacts()
	const factual = Array.from({ length: 4 }, (_, index) => ({
		seq: index + 1,
		institution: `首轮银行${index + 1}`,
		status: '正常'
	}))
	firstPass.credit_card_details = [
		...factual,
		...Array.from({ length: 36 }, () => ({
			seq: null,
			institution: null,
			credit_limit: null,
			used_limit: null,
			status: null
		}))
	]
	firstPass._coverage.counts.credit_card_details = { total: 40, listed: 40 }
	const repairedRows = Array.from({ length: 40 }, (_, index) => ({
		seq: index + 1,
		institution: `完整银行${index + 1}`,
		status: '正常',
		card_tail: String(index + 1).padStart(4, '0')
	}))
	let calls = 0
	global.fetch = async () => {
		calls += 1
		return sseResponse(JSON.stringify(calls === 1
			? firstPass
			: { complete: true, total: 40, rows: repairedRows }))
	}

	const result = await runCreditLLMAnalysis(SOURCE_TEXT)

	assert.equal(result.ok, true)
	assert.equal(calls, 2)
	assert.equal(result.data.credit_card_details.length, 40)
	assert.deepEqual(
		result.data._coverage.counts.credit_card_details,
		{ total: 40, listed: 40 }
	)
})

test('targeted repair containing empty placeholders is rejected', async () => {
	const firstPass = completeFacts()
	firstPass.credit_card_details = [
		{ seq: 1, institution: '甲银行', status: '正常' },
		{}
	]
	firstPass._coverage.counts.credit_card_details = { total: 2, listed: 2 }
	let calls = 0
	global.fetch = async () => {
		calls += 1
		return sseResponse(JSON.stringify(calls === 1
			? firstPass
			: {
				complete: true,
				total: 2,
				rows: [{ seq: 1, institution: '甲银行', status: '正常' }, {}]
			}))
	}

	const result = await runCreditLLMAnalysis(SOURCE_TEXT)

	assert.equal(result.ok, false)
	assert.equal(result.errCode, 'FACT_SCHEMA_INVALID')
	assert.equal(calls, 2)
})

test('targeted card repair rejects seq-only, duplicate, and cancelled padding rows', async () => {
	const invalidRepairs = [
		[
			{ seq: 1, institution: '甲银行', status: '正常' },
			{ seq: 2 }
		],
		[
			{ seq: 1, institution: '甲银行', status: '正常', card_tail: '1234' },
			{ seq: 2, institution: '甲银行', status: '正常', card_tail: '1234' }
		],
		[
			{ seq: 1, institution: '甲银行', status: '正常', card_tail: '1234' },
			{ seq: 2, institution: '乙银行', status: '已销户', card_tail: '5678' }
		]
	]

	for (const rows of invalidRepairs) {
		const firstPass = completeFacts()
		firstPass.credit_card_details = [
			{ seq: 1, institution: '甲银行', status: '正常', card_tail: '1234' }
		]
		firstPass._coverage.counts.credit_card_details = { total: 2, listed: 1 }
		let calls = 0
		global.fetch = async () => {
			calls += 1
			return sseResponse(JSON.stringify(calls === 1
				? firstPass
				: { complete: true, total: 2, rows }))
		}

		const result = await runCreditLLMAnalysis(SOURCE_TEXT)

		assert.equal(result.ok, false)
		assert.equal(result.errCode, 'FACT_SCHEMA_INVALID')
		assert.equal(calls, 2)
	}
})

test('coverage repair never lowers a declared total or discards extra rows', async () => {
	const inconsistent = completeFacts()
	inconsistent.loan_details.settled_loans = [
		{ seq: 1, institution: '甲银行', status: '已结清' },
		{ seq: 2, institution: '乙银行', status: '已结清' }
	]
	inconsistent._coverage.counts.settled_loans = { total: 1, listed: 2 }
	let calls = 0
	global.fetch = async () => {
		calls += 1
		return sseResponse(JSON.stringify(inconsistent))
	}

	const result = await runCreditLLMAnalysis(SOURCE_TEXT)

	assert.equal(result.ok, false)
	assert.equal(result.errCode, 'FACT_SCHEMA_INVALID')
	assert.equal(calls, 1)
})

test('malformed JSON is rejected without a second model generation', async () => {
	let calls = 0
	global.fetch = async () => {
		calls += 1
		return sseResponse('not-json')
	}

	const result = await runCreditLLMAnalysis(SOURCE_TEXT)

	assert.equal(result.ok, false)
	assert.equal(result.errCode, 'ANALYSIS_NON_JSON_OUTPUT')
	assert.equal(calls, 1)
})

test('finish_reason length is rejected even when the partial content parses', async () => {
	let calls = 0
	global.fetch = async () => {
		calls += 1
		return sseResponse(JSON.stringify(completeFacts()), 'length')
	}

	const result = await runCreditLLMAnalysis(SOURCE_TEXT)

	assert.equal(result.ok, false)
	assert.equal(result.errCode, 'ANALYSIS_OUTPUT_TRUNCATED')
	assert.equal(calls, 1)
})

test('four synthetic chunks preserve 335 rows and expose only safe overview mismatch counts', async () => {
	const previous = Object.fromEntries(SYNTHETIC_CHUNK_ENV_KEYS.map((key) => [key, process.env[key]]))
	Object.assign(process.env, {
		DEEPSEEK_CHUNK_TRIGGER_PAGES: '2',
		DEEPSEEK_CHUNK_MAX_PAGES: '1',
		DEEPSEEK_CHUNK_MAX_CHARS: '40000',
		DEEPSEEK_CHUNK_CONCURRENCY: '1'
	})
	try {
		const complete = await runSyntheticFourChunkScenario([84, 84, 84, 83])
		assert.equal(complete.calls, 4)
		assert.equal(complete.result.ok, true)
		const completeLoanRows = [
			...complete.result.data.loan_details.bank_loans,
			...complete.result.data.loan_details.non_bank_loans,
			...complete.result.data.loan_details.unknown_loans,
			...complete.result.data.loan_details.settled_loans
		]
		assert.equal(completeLoanRows.length, 335)
		assert.equal(new Set(completeLoanRows.map((row) => row.seq)).size, 335)

		const undercount = await runSyntheticFourChunkScenario([50, 50, 50, 47])
		assert.equal(undercount.calls, 4)
		assert.equal(undercount.result.ok, false)
		assert.equal(undercount.result.httpStatus, 422)
		assert.equal(undercount.result.errCode, 'CHUNK_SOURCE_OVERVIEW_MISMATCH')
		assert.deepEqual(undercount.result.diagnostic, {
			version: 1,
			expectedCount: 335,
			actualCount: 197
		})
		assert.deepEqual(Object.keys(undercount.result.diagnostic), [
			'version',
			'expectedCount',
			'actualCount'
		])
		assert.equal(Object.isFrozen(undercount.result.diagnostic), true)

		const overcount = await runSyntheticFourChunkScenario([84, 84, 84, 84])
		assert.equal(overcount.calls, 4)
		assert.equal(overcount.result.ok, false)
		assert.equal(overcount.result.httpStatus, 422)
		assert.equal(overcount.result.errCode, 'CHUNK_SOURCE_OVERVIEW_MISMATCH')
		assert.deepEqual(overcount.result.diagnostic, {
			version: 1,
			expectedCount: 335,
			actualCount: 336
		})

		const cardMismatch = await runSyntheticFourChunkScenario(
			[84, 84, 84, 83],
			(facts, chunkNumber) => {
				facts.credit_card_details = [{
					seq: chunkNumber,
					institution: `SYNTHETIC_CARD_ISSUER_${chunkNumber}`,
					status: '正常'
				}]
				facts._coverage.counts.credit_card_details = { total: 1, listed: 1 }
			}
		)
		assert.equal(cardMismatch.calls, 4)
		assert.equal(cardMismatch.result.ok, false)
		assert.equal(cardMismatch.result.httpStatus, 422)
		assert.equal(cardMismatch.result.errCode, 'CHUNK_SOURCE_OVERVIEW_MISMATCH')
		assert.equal(
			cardMismatch.result.errMsg,
			'报告概要与账户明细无法一致核验，已安全停止评分'
		)
		assert.deepEqual(cardMismatch.result.diagnostic, {
			version: 1,
			expectedCount: 0,
			actualCount: 4
		})

		const otherChunkFailure = await runSyntheticFourChunkScenario(
			[84, 84, 84, 83],
			(facts, chunkNumber) => {
				facts.basic_info = { name: `SYNTHETIC_SUBJECT_${chunkNumber}` }
			}
		)
		assert.equal(otherChunkFailure.calls, 4)
		assert.equal(otherChunkFailure.result.ok, false)
		assert.equal(otherChunkFailure.result.httpStatus, 502)
		assert.equal(otherChunkFailure.result.errCode, 'CHUNK_SCALAR_CONFLICT')
		assert.equal(Object.hasOwn(otherChunkFailure.result, 'diagnostic'), false)
	} finally {
		for (const key of SYNTHETIC_CHUNK_ENV_KEYS) {
			if (previous[key] === undefined) delete process.env[key]
			else process.env[key] = previous[key]
		}
	}
})

test('long input is deterministically chunked instead of shrinking 40k to 12k', async () => {
	process.env.DEEPSEEK_INPUT_MAX_CHARS = '1000'
	process.env.DEEPSEEK_CHUNK_TRIGGER_CHARS = '1000'
	process.env.DEEPSEEK_CHUNK_MAX_CHARS = '1000'
	process.env.DEEPSEEK_CHUNK_CONCURRENCY = '2'
	let calls = 0
	global.fetch = async () => {
		calls += 1
		return sseResponse(JSON.stringify(completeFacts()))
	}

	try {
		const longSource = `个人信用报告 报告时间：2026-06-30\n${'完整报告正文。'.repeat(500)}`
		const result = await runCreditLLMAnalysis(longSource)

		assert.equal(result.ok, true)
		assert.ok(calls > 1)
		assert.equal(result.data.derivation_meta.mode, 'deterministic-v1')
	} finally {
		delete process.env.DEEPSEEK_INPUT_MAX_CHARS
		delete process.env.DEEPSEEK_CHUNK_TRIGGER_CHARS
		delete process.env.DEEPSEEK_CHUNK_MAX_CHARS
		delete process.env.DEEPSEEK_CHUNK_CONCURRENCY
	}
})

test('query summary wording alone is not mistaken for an incomplete detail table', async () => {
	let calls = 0
	global.fetch = async () => {
		calls += 1
		return sseResponse(JSON.stringify(completeFacts()))
	}
	const source = `个人信用报告 报告时间：2026-06-30 查询记录概要 ${'完整报告正文'.repeat(20)}`

	const result = await runCreditLLMAnalysis(source)

	assert.equal(result.ok, true)
	assert.equal(calls, 1)
})

test('verified OCR query evidence bypasses repeated model output and is restored after chunk merge', async () => {
	const modelFacts = completeFacts()
	modelFacts.query_analysis.query_details = [
		{ institution: '模型残缺行', date: '2026-06-01', reason: '贷款审批' }
	]
	modelFacts._coverage.counts.query_details = { total: 2, listed: 1 }
	let calls = 0
	const requests = []
	global.fetch = async (_url, options) => {
		calls += 1
		requests.push(JSON.parse(String(options && options.body || '{}')))
		return sseResponse(JSON.stringify(modelFacts))
	}
	const queryRows = [
		{ seq: 1, institution: '甲银行', date: '2026-06-01', reason: '贷款审批' },
		{ seq: 2, institution: '乙银行', date: '2026-05-01', reason: '信用卡审批' }
	]
	const source = [
		'【第1页】',
		'个人信用报告 报告时间：2026-06-30',
		'【第2页】\n账户明细',
		'【第3页】\n账户明细',
		'【第4页】\n账户明细',
		'【第5页】',
		'机 构 查 询 记 录 明 细',
		'1 2026.06.01 甲银行 贷款审批',
		'2 2026 年 5 月 1 日 乙银行 信用卡审批',
		'本 人 查 询 记 录 明 细',
		'【第6页】\n其他明细',
		'【第7页】\n其他明细',
		'【第8页】\n报告说明'
	].join('\n')

	const result = await runCreditLLMAnalysis(source, {
		queryEvidence: {
			query_details_total: 2,
			query_details: queryRows
		}
	})

	assert.equal(result.ok, true)
	assert.ok(calls >= 1)
	assert.ok(requests.every((request) =>
		String(request.messages?.find((message) => message.role === 'system')?.content || '')
			.includes('机构查询记录不属于模型任务')
	))
	assert.ok(requests.every((request) =>
		!String(request.messages?.find((message) => message.role === 'user')?.content || '')
			.includes('甲银行 贷款审批')
	))
	assert.deepEqual(result.data.query_analysis.query_details, [
		{ date: '2026-05-01', institution: '乙银行', reason: '信用卡审批' },
		{ date: '2026-06-01', institution: '甲银行', reason: '贷款审批' }
	])
	assert.deepEqual(result.data._coverage.counts.query_details, { total: 2, listed: 2 })
	assert.equal(result.data._coverage.has_queries, true)
})

test('incomplete institution-query source fails before any model generation', async () => {
	let calls = 0
	global.fetch = async () => {
		calls += 1
		return sseResponse(JSON.stringify(completeFacts()))
	}
	const source = [
		'个人信用报告 报告时间：2026-06-30',
		'机构查询记录明细',
		'1 2026.06.01 甲银行 贷款审批',
		'2 2026 年 5 月 1 日 乙银行 无法识别的原因',
		'本人查询记录明细'
	].join('\n')

	const result = await runCreditLLMAnalysis(source)

	assert.equal(result.ok, false)
	assert.equal(result.errCode, 'QUERY_EVIDENCE_INCOMPLETE')
	assert.equal(calls, 0)
})

test('document-terminal institution query table is provably complete without a self-query heading', async () => {
	let calls = 0
	const requests = []
	global.fetch = async (_url, options) => {
		calls += 1
		requests.push(JSON.parse(String(options && options.body || '{}')))
		return sseResponse(JSON.stringify(completeFacts()))
	}
	const source = [
		'个人信用报告 报告时间：2026-06-30',
		'账户明细',
		'机构查询记录明细',
		'编号 查询日期 查询机构 查询原因',
		'1 2026.06.01 甲银行 贷款审批',
		'2 2026 年 5 月 1 日 乙银行 信用卡审批',
		'第5页，共5页'
	].join('\n')

	const result = await runCreditLLMAnalysis(source)

	assert.equal(result.ok, true)
	assert.equal(calls, 1)
	assert.ok(requests.every((request) =>
		!String(request.messages?.find((message) => message.role === 'user')?.content || '')
			.includes('甲银行')
	))
	assert.deepEqual(result.data.query_analysis.query_details, [
		{ date: '2026-05-01', institution: '乙银行', reason: '信用卡审批' },
		{ date: '2026-06-01', institution: '甲银行', reason: '贷款审批' }
	])
	assert.deepEqual(result.data._coverage.counts.query_details, { total: 2, listed: 2 })
	assert.equal(result.data._coverage.has_queries, true)
})

test('terminal query table followed by the standard closing notes is provably complete', async () => {
	let calls = 0
	global.fetch = async () => {
		calls += 1
		return sseResponse(JSON.stringify(completeFacts()))
	}
	const source = [
		'个人信用报告 报告时间：2026-06-30',
		'机构查询记录明细',
		'编号 查询日期 查询机构 查询原因',
		'1 2026年04月14日 甲融资担保有限公司 担保资格审查',
		'2 2026年04月02日 乙银行股份有限公司 贷款审批',
		'第 10 页，共 11 页',
		'说 明',
		'1.除查询记录外，本报告中的信息是依据截至报告时间个人征信系统记录的信息生成。',
		'5.更多咨询，请致电全国客户服务热线400-810-8866。',
		'第 11 页，共 11 页'
	].join('\n')

	const result = await runCreditLLMAnalysis(source)

	assert.equal(result.ok, true)
	assert.equal(calls, 1)
	assert.deepEqual(result.data._coverage.counts.query_details, { total: 2, listed: 2 })
})

test('terminal institution query section with unrecognized trailing content stays fail-closed', async () => {
	let calls = 0
	global.fetch = async () => {
		calls += 1
		return sseResponse(JSON.stringify(completeFacts()))
	}
	const source = [
		'个人信用报告 报告时间：2026-06-30',
		'机构查询记录明细',
		'1 2026.06.01 甲银行 贷款审批',
		'2 2026 年 5 月 1 日 乙银行 信用卡审批',
		'报告说明 本报告由征信中心出具，仅供本人参考'
	].join('\n')

	const result = await runCreditLLMAnalysis(source)

	assert.equal(result.ok, false)
	assert.equal(result.errCode, 'QUERY_EVIDENCE_INCOMPLETE')
	assert.equal(calls, 0)
})

test('terminal institution query section with a numbering gap stays fail-closed', async () => {
	let calls = 0
	global.fetch = async () => {
		calls += 1
		return sseResponse(JSON.stringify(completeFacts()))
	}
	const source = [
		'个人信用报告 报告时间：2026-06-30',
		'机构查询记录明细',
		'1 2026.06.01 甲银行 贷款审批',
		'3 2026 年 5 月 1 日 乙银行 信用卡审批'
	].join('\n')

	const result = await runCreditLLMAnalysis(source)

	assert.equal(result.ok, false)
	assert.equal(result.errCode, 'QUERY_EVIDENCE_INCOMPLETE')
	assert.equal(calls, 0)
})

test('query details are discarded before generic coverage repair can call the model again', async () => {
	const facts = completeFacts()
	facts.query_analysis.query_details = [
		{ institution: '模型行', date: '2026-06-01', reason: '贷款审批' }
	]
	facts._coverage.counts.query_details = { total: 142, listed: 1 }
	let calls = 0
	global.fetch = async () => {
		calls += 1
		return sseResponse(JSON.stringify(facts))
	}

	const result = await runCreditLLMAnalysis(SOURCE_TEXT)

	assert.equal(result.ok, true)
	assert.equal(calls, 1)
	assert.deepEqual(result.data.query_analysis.query_details, [])
	assert.deepEqual(result.data._coverage.counts.query_details, { total: 0, listed: 0 })
})

test('analysis stage callbacks receive numeric monotonic progress and cannot break analysis', async () => {
	global.fetch = async () => sseResponse(JSON.stringify(completeFacts()))
	const events = []
	const result = await runCreditLLMAnalysis(SOURCE_TEXT, {
		onStage: async (stage, progress, detail) => {
			events.push({ stage, progress, detail })
			if (events.length === 1) throw new Error('simulated stage persistence failure')
		}
	})

	assert.equal(result.ok, true)
	assert.deepEqual(events.map((event) => event.progress), [40, 50, 55, 82, 86])
	assert.deepEqual(events.map((event) => event.stage), [
		'query_evidence',
		'query_evidence',
		'fact_extraction',
		'fact_extraction',
		'rule_validation'
	])
	assert.ok(events.every((event) => Number.isInteger(event.progress)))
})

test('bounded chunks never lower a declared total to the emitted row count', async () => {
	let calls = 0
	global.fetch = async () => {
		calls += 1
		const facts = completeFacts()
		facts.public_records = {
			has_record: true,
			items: [{ type: '行政处罚', date: '2025-01-01', detail: `片段${calls}` }]
		}
		facts._coverage.counts.public_records = { total: 2, listed: 1 }
		return sseResponse(JSON.stringify(facts))
	}
	const source = Array.from(
		{ length: 8 },
		(_, index) => `【第${index + 1}页】\n${index === 0 ? '个人信用报告 报告时间：2026-06-30' : '公共记录明细'}`
	).join('\n')

	const result = await runCreditLLMAnalysis(source)

	assert.ok(calls >= 1)
	assert.equal(result.ok, false)
	assert.match(
		String(result.errCode || ''),
		/^(?:FACT_SCHEMA_INVALID|CHUNK_COVERAGE_MISMATCH)$/
	)
})

test('chunks fail closed when a report-level total is copied into fragment coverage', async () => {
	let calls = 0
	global.fetch = async (_url, options) => {
		calls += 1
		const request = JSON.parse(String(options && options.body || '{}'))
		const userText = String(request.messages?.find((message) => message.role === 'user')?.content || '')
		const chunkNumber = Number(userText.match(/第 (\d+)\/3 个/)?.[1] || calls)
		const facts = completeFacts()
		facts.loan_details.settled_loans = [{
			seq: chunkNumber,
			institution: `示例机构${chunkNumber}`,
			balance: 0,
			status: '已结清'
		}]
		facts._coverage.counts.settled_loans = { total: 49, listed: 1 }
		return sseResponse(JSON.stringify(facts))
	}
	const source = [
		'【第1页】',
		'个人信用报告 报告时间：2026-06-30',
		'账户数 0 0 8 0',
		'未结清/未销户账户数 0 0 0 0',
		'发生过逾期的账户数 0 0 0 0',
		'发生过90天以上逾期的账户数 0 0 0 0',
		...Array.from({ length: 7 }, (_, index) => `【第${index + 2}页】\n已结清账户明细`)
	].join('\n')

	const result = await runCreditLLMAnalysis(source)

	assert.equal(result.ok, false)
	assert.ok(calls >= 1)
	assert.equal(result.errCode, 'FACT_SCHEMA_INVALID')
})

test('context-limit failure is not retried with a shortened report', async () => {
	let calls = 0
	global.fetch = async () => {
		calls += 1
		return {
			ok: false,
			status: 400,
			body: {},
			json: async () => ({ error: { message: 'maximum context length exceeded' } })
		}
	}

	const result = await runCreditLLMAnalysis(SOURCE_TEXT)

	assert.equal(result.ok, false)
	assert.equal(result.errCode, 'ANALYSIS_CONTEXT_LIMIT')
	assert.equal(calls, 1)
})

test('coverage must declare overdue detail completeness', async () => {
	const facts = completeFacts()
	delete facts._coverage.counts.overdue_details
	global.fetch = async () => sseResponse(JSON.stringify(facts))

	const result = await runCreditLLMAnalysis(SOURCE_TEXT)

	assert.equal(result.ok, false)
	assert.equal(result.errCode, 'FACT_SCHEMA_INVALID')
})
