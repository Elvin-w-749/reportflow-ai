'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
	FACT_STATUS,
	stableCanonicalize,
	createHmacHashFn,
	buildSourceSharedGroupId,
	applyControlledSourceCardInstallments,
	buildEvidenceFirstCreditAnalysis,
	fromFinalizedCreditFacts,
	evaluatePublicationGate,
	assertPublicationGate
} = require('../backend/services/creditEvidenceLedger')
const {
	finalizeExtractedCreditFacts
} = require('../backend/services/creditAnalysisService')

const TEST_HASH_FN = createHmacHashFn('ledger-test-artifact-secret-at-least-32-bytes')

const SOURCE = `【第1页】
个人信用报告 报告日期：2026年6月30日
【第2页】
甲银行 贷款余额：10,000.00元
乙银行 2025年1月1日 尾号1234 人民币 授信额度：20,000.00元 已用额度：10,000.00元
丙银行 2026年6月1日 贷款审批`

function finalizedFacts(overrides = {}) {
	const facts = {
		meta: { report_date: '2026-06-30' },
		basic_info: { name: '不应进入证据产物' },
		loan_details: {
			bank_loans: [{ institution: '甲银行', balance: 10000 }],
			non_bank_loans: []
		},
		credit_card_details: [{
			institution: '乙银行',
			start_date: '2025-01-01',
			card_tail: '1234',
			currency: 'CNY',
			credit_limit: 20000,
			used_limit: 10000
		}],
		query_analysis: {
			query_details: [{ institution: '丙银行', date: '2026-06-01', reason: '贷款审批' }]
		},
		primary_rule_score: { score: 100, deductions: [] }
	}
	return Object.assign(facts, overrides)
}

function isolatedFacts({ loans = [], cards = [], queries = [], score = 100 } = {}) {
	return {
		meta: { report_date: '2026-06-30' },
		loan_details: { bank_loans: loans, non_bank_loans: [] },
		credit_card_details: cards,
		query_analysis: { query_details: queries },
		primary_rule_score: { score, deductions: [] }
	}
}

function extractedCardFacts(cards) {
	const counts = Object.fromEntries([
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
	].map((name) => {
		const total = name === 'credit_card_details' ? cards.length : 0
		return [name, { total, listed: total }]
	}))
	return {
		meta: { report_date: '2026-06-30' },
		basic_info: {},
		loan_details: {
			bank_loans: [],
			non_bank_loans: [],
			settled_loans: [],
			historical_overdue_loans: []
		},
		credit_card_details: cards,
		credit_card_details_cancelled: [],
		query_analysis: { query_details: [], self_queries: [] },
		overdue_info: { details: [] },
		public_records: { items: [] },
		guarantee_records: { items: [] },
		loan_history: { trend_data: [] },
		_coverage: { truncated: false, counts }
	}
}

function sourceCount(count) {
	return { count, basis: 'source-test-fixture-v1' }
}

function verifiedContext(facts = finalizedFacts(), countOverrides = {}) {
	const normalizedOverrides = Object.fromEntries(Object.entries(countOverrides).map(([name, value]) => [
		name,
		typeof value === 'object' && value !== null ? value : sourceCount(value)
	]))
	return {
		facts,
		sourceVerifiedCounts: {
			active_loans: sourceCount(1),
			credit_card_details: sourceCount(1),
			query_details: sourceCount(1),
			...normalizedOverrides
		}
	}
}

function structuredPdfFixture(blockSpecs) {
	let pageText = ''
	const blocks = blockSpecs.map((spec, blockIndex) => {
		if (blockIndex > 0) pageText += '\n'
		const lines = (Array.isArray(spec) ? spec : spec.lines).map((line) => (
			typeof line === 'string' ? { text: line, bbox: null } : line
		))
		const blockStart = pageText.length
		const structuredLines = lines.map((line, lineIndex) => {
			if (lineIndex > 0) pageText += '\n'
			const charStart = pageText.length
			pageText += line.text
			return {
				text: line.text,
				charStart,
				charEnd: pageText.length,
				bbox: line.bbox
			}
		})
		const boxes = structuredLines.map((line) => line.bbox).filter(Array.isArray)
		const bbox = boxes.length
			? [
				Math.min(...boxes.map((box) => box[0])),
				Math.min(...boxes.map((box) => box[1])),
				Math.max(...boxes.map((box) => box[2])),
				Math.max(...boxes.map((box) => box[3]))
			]
			: null
		return {
			text: pageText.slice(blockStart),
			charStart: blockStart,
			charEnd: pageText.length,
			bbox,
			lines: structuredLines
		}
	})
	return {
		sourceText: `【第1页】\n${pageText}`,
		documentMeta: {
			sourceMode: 'pdf-text',
			expectedPageCount: 1,
			complete: true,
			pages: [{
				pageNumber: 1,
				bounds: [0, 0, 600, 800],
				text: pageText,
				blocks
			}]
		}
	}
}

function structuredMultiPageFixture(pageLines) {
	const pages = pageLines.map((lines, pageIndex) => {
		const text = lines.join('\n')
		let offset = 0
		const blocks = lines.map((line, lineIndex) => {
			const charStart = offset
			offset += line.length + (lineIndex + 1 < lines.length ? 1 : 0)
			const y = 20 + lineIndex * 18
			return {
				text: line,
				charStart,
				charEnd: charStart + line.length,
				bbox: [10, y, 590, y + 16]
			}
		})
		return {
			pageNumber: pageIndex + 1,
			bounds: [0, 0, 600, 800],
			text,
			blocks
		}
	})
	return {
		sourceText: pages.map((page) => `【第${page.pageNumber}页】\n${page.text}`).join('\n'),
		documentMeta: {
			sourceMode: 'pdf-text',
			expectedPageCount: pages.length,
			complete: true,
			pages
		}
	}
}

function analyzeStructuredCardFixture(fixture, card, options = {}) {
	return buildEvidenceFirstCreditAnalysis({
		sourceText: fixture.sourceText,
		evidenceContext: {
			...verifiedContext(isolatedFacts({ cards: [card] }), {
				active_loans: 0,
				credit_card_details: 1,
				query_details: 0
			}),
			documentMeta: fixture.documentMeta
		},
		hashFn: TEST_HASH_FN,
		...options
	})
}

function analyzeStructuredLoanFixture(fixture, loans, options = {}) {
	return buildEvidenceFirstCreditAnalysis({
		sourceText: fixture.sourceText,
		evidenceContext: {
			...verifiedContext(isolatedFacts({ loans }), {
				active_loans: loans.length,
				credit_card_details: 0,
				query_details: 0
			}),
			documentMeta: fixture.documentMeta
		},
		hashFn: TEST_HASH_FN,
		...options
	})
}

test('builds a publishable four-artifact hash chain from finalized fact shape', () => {
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: SOURCE,
		evidenceContext: verifiedContext(),
		hashFn: TEST_HASH_FN,
		requirePublishable: true
	})

	assert.equal(result.status, 'publishable')
	assert.equal(result.manifest.status, 'complete')
	assert.equal(result.evidenceGraph.status, 'complete')
	assert.equal(result.factLedger.status, 'ready')
	assert.equal(result.derivedAnalysis.status, 'validated')
	assert.equal(result.publicationGate.publishable, true)
	assert.equal(result.evidenceGraph.manifestHash, result.manifest.manifestHash)
	assert.equal(result.factLedger.evidenceGraphHash, result.evidenceGraph.evidenceGraphHash)
	assert.equal(result.derivedAnalysis.inputs.factLedgerHash, result.factLedger.factLedgerHash)

	assert.deepEqual(result.derivedAnalysis.metrics.totalLoanBalance.value, {
		type: 'money', currency: 'CNY', minor: 1000000, scale: 2
	})
	assert.deepEqual(result.derivedAnalysis.metrics.totalDebt.value, {
		type: 'money', currency: 'CNY', minor: 2000000, scale: 2
	})
	assert.deepEqual(result.derivedAnalysis.metrics.cardUtilization.value, {
		type: 'rate-bps', value: 5000
	})
	assert.deepEqual(result.derivedAnalysis.metrics.queryCounts.value, {
		type: 'query-window-counts',
		last_1m: 1,
		last_3m: 1,
		last_6m: 1,
		last_12m: 1,
		by_window: {
			last_1m: { total: 1, bank: 1, non_bank: 0, unknown: 0 },
			last_3m: { total: 1, bank: 1, non_bank: 0, unknown: 0 },
			last_6m: { total: 1, bank: 1, non_bank: 0, unknown: 0 },
			last_12m: { total: 1, bank: 1, non_bank: 0, unknown: 0 }
		}
	})
	assert.ok(result.derivedAnalysis.metrics.cardUtilization.inputFactIds.length >= 3)
	assert.deepEqual(result.derivedAnalysis.metrics.primaryScore.value, {
		type: 'internal-credit-score', value: 100, scale: 100
	})
	assert.deepEqual(result.derivedAnalysis.metrics.primaryScore.inputMetrics, {
		totalAccountCount: 2,
		nonBankLoanCount: 0,
		cardUtilizationRate: 0.5,
		hasBigInstallment: false,
		q6: 1,
		sameDayInquiryDayCount: 0,
		bigInstallment: { type: 'money', currency: 'CNY', minor: 0, scale: 2 }
	})
	assert.equal(assertPublicationGate(result, { hashFn: TEST_HASH_FN }), true)
})

test('evidence query windows keep an unclassified institution in unknown, not non-bank', () => {
	const source = SOURCE.replace('丙银行 2026年6月1日 贷款审批', '丙服务中心 2026年6月1日 贷款审批')
	const facts = finalizedFacts({
		query_analysis: {
			query_details: [{ institution: '丙服务中心', date: '2026-06-01', reason: '贷款审批' }]
		}
	})
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: source,
		evidenceContext: verifiedContext(facts),
		hashFn: TEST_HASH_FN,
		requirePublishable: true
	})

	assert.deepEqual(result.derivedAnalysis.metrics.queryCounts.value.by_window.last_1m, {
		total: 1,
		bank: 0,
		non_bank: 0,
		unknown: 1
	})
})

test('same source and facts produce the same manifest, graph, ledger, and derived hashes five times', () => {
	const hashFn = createHmacHashFn('stable-evidence-test-secret-32-bytes-minimum')
	const hashes = Array.from({ length: 5 }, () => {
		const result = buildEvidenceFirstCreditAnalysis({
			sourceText: SOURCE,
			evidenceContext: verifiedContext(),
			hashFn
		})
		return [
			result.manifest.manifestHash,
			result.evidenceGraph.evidenceGraphHash,
			result.factLedger.factLedgerHash,
			result.derivedAnalysis.derivedAnalysisHash
		]
	})

	assert.equal(new Set(hashes.map(JSON.stringify)).size, 1)
	for (const hash of hashes[0]) assert.match(hash, /_v2_[a-f0-9]{64}$/)
	const hmacResult = buildEvidenceFirstCreditAnalysis({
		sourceText: SOURCE,
		evidenceContext: verifiedContext(),
		hashFn
	})
	assert.equal(hmacResult.publicationGate.publishable, true)
	assert.equal(assertPublicationGate(hmacResult, { hashFn }), true)
})

test('a supplied score cannot override the score recomputed from evidence-bound inputs', () => {
	const facts = finalizedFacts()
	facts.primary_rule_score.score = 88
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: SOURCE,
		evidenceContext: verifiedContext(facts)
	})

	assert.equal(result.derivedAnalysis.status, 'blocked')
	assert.equal(result.derivedAnalysis.metrics.primaryScore.status, 'blocked')
	assert.equal(
		result.derivedAnalysis.metrics.primaryScore.reason,
		'DETERMINISTIC_SCORE_PROJECTION_MISMATCH'
	)
	assert.equal(result.derivedAnalysis.metrics.primaryScore.expectedScore, 100)
	assert.equal(result.publicationGate.publishable, false)
})

test('a positive card installment is evidence-bound and deterministically deducted from the score', () => {
	const source = SOURCE.replace(
		'已用额度：10,000.00元',
		'已用额度：10,000.00元 分期余额：5,000.00元'
	)
	const facts = finalizedFacts()
	facts.credit_card_details[0].installment = 5000
	facts.primary_rule_score.score = 76
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: source,
		evidenceContext: verifiedContext(facts),
		hashFn: TEST_HASH_FN,
		requirePublishable: true
	})

	assert.equal(result.derivedAnalysis.metrics.primaryScore.value.value, 76)
	assert.equal(result.derivedAnalysis.metrics.primaryScore.inputMetrics.hasBigInstallment, true)
	assert.deepEqual(result.derivedAnalysis.metrics.primaryScore.deductionTrace, [
		{ ruleId: 'CARD_BIG_INSTALLMENT', points: 24 }
	])
	assert.ok(result.factLedger.facts.some((fact) =>
		fact.entityKind === 'card' && fact.field === 'installment' && fact.status === FACT_STATUS.ACCEPTED
	))
})

test('pre-rule repair binds one explicit CNY installment and publishes its deterministic score', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[{
			text: '1. 2025年3月3日丙银行发放的贷记卡（尾号4321），人民币，信用额度：30,000元，已用额度15,000元，未出单大额专项分期余额5,000元。',
			bbox: [20, 100, 590, 118]
		}]
	])
	const result = finalizeExtractedCreditFacts(extractedCardFacts([{
		institution: '丙银行',
		start_date: '2025-03-03',
		card_tail: '4321',
		currency: 'CNY',
		credit_limit: 30000,
		used_limit: 15000,
		installment: '模型未识别',
		status: '正常'
	}]), fixture.sourceText, {
		evidenceRequired: true,
		documentId: `doc_v2_${'b'.repeat(64)}`,
		evidenceContext: fixture.documentMeta,
		sourceVerifiedCounts: {
			active_loans: sourceCount(0),
			credit_card_details: sourceCount(1),
			query_details: sourceCount(0)
		}
	})

	assert.equal(result.credit_card_details[0].installment, 5000)
	assert.equal(result.credit_debt.credit_cards.large_installment, 5000)
	assert.equal(result.primary_rule_score.score, 76)
	assert.ok(result.primary_rule_score.deductions.some((item) => item.code === 'CARD_BIG_INSTALLMENT'))
	assert.equal(result.evidence_v2.status, 'publishable')
	assert.ok(result.evidence_v2.factLedger.facts.some((fact) =>
		fact.entityKind === 'card' &&
		fact.field === 'installment' &&
		fact.status === FACT_STATUS.ACCEPTED
	))
})

test('a uniquely bound closed CNY card repairs an omitted model currency before installment evidence', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[{
			text: '1. 2025年3月3日丙银行发放的贷记卡（人民币账户，卡片尾号：4321）。截至2026年6月，信用额度30,000元，余额15,000元（含未出单的大额专项分期余额5,000元）。',
			bbox: [20, 100, 590, 118]
		}]
	])
	const result = finalizeExtractedCreditFacts(extractedCardFacts([{
		institution: '丙银行',
		start_date: '2025-03-03',
		card_tail: '4321',
		credit_limit: 30000,
		used_limit: 15000,
		status: '正常'
	}]), fixture.sourceText, {
		evidenceRequired: true,
		documentId: `doc_v2_${'c'.repeat(64)}`,
		evidenceContext: fixture.documentMeta,
		sourceVerifiedCounts: {
			active_loans: sourceCount(0),
			credit_card_details: sourceCount(1),
			query_details: sourceCount(0)
		}
	})

	assert.equal(result.credit_card_details[0].currency, 'CNY')
	assert.equal(result.credit_card_details[0].installment, 5000)
	assert.equal(result.evidence_v2.publicationGate.publishable, true)
	assert.equal(result.evidence_v2.evidenceGraph.unresolved.length, 0)
})

test('omitted card currency repair rejects foreign or non-unique source bundles', () => {
	const cases = [
		{
			name: 'foreign-source',
			lines: [
				'1. 2025年3月3日丙银行发放的贷记卡（美元账户，卡片尾号：4321）。截至2026年6月，信用额度30,000元，余额15,000元（含未出单的大额专项分期余额5,000元）。'
			]
		},
		{
			name: 'non-unique-source',
			lines: [
				'1. 2025年3月3日丙银行发放的贷记卡（人民币账户，卡片尾号：4321）。截至2026年6月，信用额度30,000元，余额15,000元（含未出单的大额专项分期余额5,000元）。',
				'2. 2025年3月3日丙银行发放的贷记卡（人民币账户，卡片尾号：4321）。截至2026年6月，信用额度30,000元，余额15,000元（含未出单的大额专项分期余额5,000元）。'
			]
		},
		{
			name: 'non-empty-model-conflict',
			modelCurrency: 'USD',
			lines: [
				'1. 2025年3月3日丙银行发放的贷记卡（人民币账户，卡片尾号：4321）。截至2026年6月，信用额度30,000元，余额15,000元（含未出单的大额专项分期余额5,000元）。'
			]
		},
		{
			name: 'invalid-but-present-model-currency',
			modelCurrency: 0,
			lines: [
				'1. 2025年3月3日丙银行发放的贷记卡（人民币账户，卡片尾号：4321）。截至2026年6月，信用额度30,000元，余额15,000元（含未出单的大额专项分期余额5,000元）。'
			]
		},
		{
			name: 'boolean-model-currency',
			modelCurrency: false,
			lines: [
				'1. 2025年3月3日丙银行发放的贷记卡（人民币账户，卡片尾号：4321）。截至2026年6月，信用额度30,000元，余额15,000元（含未出单的大额专项分期余额5,000元）。'
			]
		},
		{
			name: 'empty-array-model-currency',
			modelCurrency: [],
			lines: [
				'1. 2025年3月3日丙银行发放的贷记卡（人民币账户，卡片尾号：4321）。截至2026年6月，信用额度30,000元，余额15,000元（含未出单的大额专项分期余额5,000元）。'
			]
		},
		{
			name: 'blank-array-model-currency',
			modelCurrency: [''],
			lines: [
				'1. 2025年3月3日丙银行发放的贷记卡（人民币账户，卡片尾号：4321）。截至2026年6月，信用额度30,000元，余额15,000元（含未出单的大额专项分期余额5,000元）。'
			]
		},
		{
			name: 'object-model-currency',
			modelCurrency: {},
			lines: [
				'1. 2025年3月3日丙银行发放的贷记卡（人民币账户，卡片尾号：4321）。截至2026年6月，信用额度30,000元，余额15,000元（含未出单的大额专项分期余额5,000元）。'
			]
		},
		{
			name: 'explicit-currency-in-open-chinese-parenthesis',
			lines: [
				'1. 2025年3月3日丙银行发放的贷记卡（卡片尾号：4321，币种：人民币，信用额度30,000元，已使用额度15,000元，未出单大额专项分期余额5,000元。'
			]
		},
		{
			name: 'explicit-currency-in-open-ascii-parenthesis',
			lines: [
				'1. 2025年3月3日丙银行发放的贷记卡 (卡片尾号：4321，币种：人民币，信用额度30,000元，已使用额度15,000元，未出单大额专项分期余额5,000元。'
			]
		},
		{
			name: 'closing-parenthesis-before-opening-parenthesis',
			lines: [
				'）1. 2025年3月3日丙银行发放的贷记卡（卡片尾号：4321，币种：人民币，信用额度30,000元，已使用额度15,000元，未出单大额专项分期余额5,000元。'
			]
		},
		{
			name: 'mixed-chinese-open-ascii-close',
			lines: [
				'1. 2025年3月3日丙银行发放的贷记卡（卡片尾号：4321，币种：人民币，信用额度30,000元，已使用额度15,000元，未出单大额专项分期余额5,000元)。'
			]
		},
		{
			name: 'mixed-ascii-open-chinese-close',
			lines: [
				'1. 2025年3月3日丙银行发放的贷记卡 (卡片尾号：4321，币种：人民币，信用额度30,000元，已使用额度15,000元，未出单大额专项分期余额5,000元）。'
			]
		},
		{
			name: 'three-digit-tail',
			lines: [
				'1. 2025年3月3日丙银行发放的贷记卡（人民币账户，卡片尾号：321）。截至2026年6月，信用额度30,000元，余额15,000元（含未出单的大额专项分期余额5,000元）。'
			]
		},
		{
			name: 'five-digit-tail',
			lines: [
				'1. 2025年3月3日丙银行发放的贷记卡（人民币账户，卡片尾号：54321）。截至2026年6月，信用额度30,000元，余额15,000元（含未出单的大额专项分期余额5,000元）。'
			]
		},
		{
			name: 'tail-free-text',
			lines: [
				'1. 2025年3月3日丙银行发放的贷记卡（人民币账户，卡片尾号：4321主卡）。截至2026年6月，信用额度30,000元，余额15,000元（含未出单的大额专项分期余额5,000元）。'
			]
		},
		{
			name: 'second-currency-in-parenthesis',
			lines: [
				'1. 2025年3月3日丙银行发放的贷记卡（人民币账户，卡片尾号：4321，美元账户）。截至2026年6月，信用额度30,000元，余额15,000元（含未出单的大额专项分期余额5,000元）。'
			]
		},
		{
			name: 'negated-cny-parenthesis',
			lines: [
				'1. 2025年3月3日丙银行发放的贷记卡（非人民币账户，卡片尾号：4321）。截至2026年6月，信用额度30,000元，余额15,000元（含未出单的大额专项分期余额5,000元）。'
			]
		},
		{
			name: 'second-parenthesis',
			lines: [
				'1. 2025年3月3日丙银行发放的贷记卡（人民币账户，卡片尾号：4321）（账户说明）。截至2026年6月，信用额度30,000元，余额15,000元（含未出单的大额专项分期余额5,000元）。'
			]
		},
		{
			name: 'missing-as-of-transition',
			lines: [
				'1. 2025年3月3日丙银行发放的贷记卡（人民币账户，卡片尾号：4321），信用额度30,000元，余额15,000元（含未出单的大额专项分期余额5,000元）。'
			]
		},
		{
			name: 'non-strict-as-of-transition',
			lines: [
				'1. 2025年3月3日丙银行发放的贷记卡（人民币账户，卡片尾号：4321）。截至2026年6月统计，信用额度30,000元，余额15,000元（含未出单的大额专项分期余额5,000元）。'
			]
		},
		{
			name: 'unparsed-field-after-money-sequence',
			lines: [
				'1. 2025年3月3日丙银行发放的贷记卡（人民币账户，卡片尾号：4321）。截至2026年6月，信用额度30,000元，余额15,000元（含未出单的大额专项分期余额5,000元），附加字段未知。'
			]
		}
	]
	for (const [index, item] of cases.entries()) {
		const fixture = structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			item.lines.map((text, lineIndex) => ({
				text,
				bbox: [20, 100 + lineIndex * 20, 590, 118 + lineIndex * 20]
			}))
		])
		assert.throws(() => finalizeExtractedCreditFacts(extractedCardFacts([{
			institution: '丙银行',
			start_date: '2025-03-03',
			card_tail: '4321',
			...(Object.prototype.hasOwnProperty.call(item, 'modelCurrency')
				? { currency: item.modelCurrency }
				: {}),
			credit_limit: 30000,
			used_limit: 15000,
			status: '正常'
		}]), fixture.sourceText, {
			evidenceRequired: true,
			documentId: `doc_v2_${index.toString(16).padStart(64, '0')}`,
			evidenceContext: fixture.documentMeta,
			sourceVerifiedCounts: {
				active_loans: sourceCount(0),
				credit_card_details: sourceCount(1),
				query_details: sourceCount(0)
			}
		}), (error) => error?.code === 'EVIDENCE_PUBLICATION_BLOCKED', item.name)
	}
})

test('currency repair requires a labeled exact tail and cannot match the expected digits in an amount', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[{
			text: '1. 2025年3月3日丙银行发放的贷记卡（人民币账户，卡片尾号：9999）。截至2026年6月，信用额度4,321元，余额1,500元（含未出单的大额专项分期余额500元）。',
			bbox: [20, 100, 590, 118]
		}]
	])
	assert.throws(() => finalizeExtractedCreditFacts(extractedCardFacts([{
		institution: '丙银行',
		start_date: '2025-03-03',
		card_tail: '4321',
		credit_limit: 4321,
		used_limit: 1500,
		status: '正常'
	}]), fixture.sourceText, {
		evidenceRequired: true,
		documentId: `doc_v2_${'a'.repeat(64)}`,
		evidenceContext: fixture.documentMeta,
		sourceVerifiedCounts: {
			active_loans: sourceCount(0),
			credit_card_details: sourceCount(1),
			query_details: sourceCount(0)
		}
	}), (error) => error?.code === 'EVIDENCE_PUBLICATION_BLOCKED')
})

test('a controlled geometric continuation repairs installment from the next source block', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[{
			text: '1. 2025年3月3日丙银行发放的贷记卡（人民币账户，卡片尾号：4321）。截至2026年6月，信用额度30,000元，已使用额度15,000元。',
			bbox: [20, 100, 590, 118]
		}],
		[{ text: '未出单大额专项分期余额5,000元。', bbox: [20, 120, 360, 138] }]
	])
	const extracted = extractedCardFacts([{
		institution: '丙银行',
		start_date: '2025-03-03',
		card_tail: '4321',
		credit_limit: 30000,
		used_limit: 15000,
		status: '正常'
	}])
	applyControlledSourceCardInstallments(extracted, fixture.sourceText, {
		documentId: `doc_v2_${'6'.repeat(64)}`,
		declaredPageCount: 1,
		documentMeta: fixture.documentMeta,
		hashFn: TEST_HASH_FN
	})
	assert.equal(extracted.credit_card_details[0].currency, 'CNY')
	assert.equal(extracted.credit_card_details[0].installment, 5000)

	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: fixture.sourceText,
		documentId: `doc_v2_${'6'.repeat(64)}`,
		evidenceContext: {
			...verifiedContext(isolatedFacts({ cards: extracted.credit_card_details, score: 76 }), {
				active_loans: 0,
				credit_card_details: 1,
				query_details: 0
			}),
			documentMeta: fixture.documentMeta
		},
		hashFn: TEST_HASH_FN
	})
	assert.equal(result.publicationGate.publishable, true)
	assert.equal(result.evidenceGraph.coverage.criticalUnresolvedCount, 0)
	assert.equal(result.evidenceGraph.nodes.find((node) =>
		node.entityKind === 'card' && node.field === 'installment'
	)?.evidenceRefs[0].ordinal, 3)
})

test('a controlled installment continuation closes before the next recognized card record', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[{
			text: '1. 2025年3月3日丙银行发放的贷记卡（人民币账户，卡片尾号：4321）。截至2026年6月，信用额度30,000元，已使用额度15,000元。',
			bbox: [20, 100, 590, 118]
		}],
		[{ text: '未出单大额专项分期余额5,000元。', bbox: [20, 120, 360, 138] }],
		[{
			text: '2. 2025年4月4日丁银行发放的贷记卡（人民币账户，卡片尾号：5678）。截至2026年6月，信用额度20,000元，已使用额度5,000元。',
			bbox: [20, 140, 590, 158]
		}]
	])
	const extracted = extractedCardFacts([
		{
			institution: '丙银行', start_date: '2025-03-03', card_tail: '4321',
			credit_limit: 30000, used_limit: 15000, status: '正常'
		},
		{
			institution: '丁银行', start_date: '2025-04-04', card_tail: '5678',
			currency: 'CNY', credit_limit: 20000, used_limit: 5000, status: '正常'
		}
	])
	applyControlledSourceCardInstallments(extracted, fixture.sourceText, {
		documentId: `doc_v2_${'3'.repeat(64)}`,
		declaredPageCount: 1,
		documentMeta: fixture.documentMeta,
		hashFn: TEST_HASH_FN
	})
	assert.equal(extracted.credit_card_details.find((card) => card.card_tail === '4321')?.installment, 5000)

	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: fixture.sourceText,
		documentId: `doc_v2_${'3'.repeat(64)}`,
		evidenceContext: {
			...verifiedContext(isolatedFacts({ cards: extracted.credit_card_details, score: 76 }), {
				active_loans: 0,
				credit_card_details: 2,
				query_details: 0
			}),
			documentMeta: fixture.documentMeta
		},
		hashFn: TEST_HASH_FN
	})
	assert.equal(result.publicationGate.publishable, true)
	assert.equal(result.evidenceGraph.coverage.criticalUnresolvedCount, 0)
	const permuted = buildEvidenceFirstCreditAnalysis({
		sourceText: fixture.sourceText,
		documentId: `doc_v2_${'3'.repeat(64)}`,
		evidenceContext: {
			...verifiedContext(isolatedFacts({
				cards: [...extracted.credit_card_details].reverse(),
				score: 76
			}), {
				active_loans: 0,
				credit_card_details: 2,
				query_details: 0
			}),
			documentMeta: fixture.documentMeta
		},
		hashFn: TEST_HASH_FN
	})
	assert.deepEqual([
		permuted.manifest.manifestHash,
		permuted.evidenceGraph.evidenceGraphHash,
		permuted.factLedger.factLedgerHash,
		permuted.derivedAnalysis.derivedAnalysisHash
	], [
		result.manifest.manifestHash,
		result.evidenceGraph.evidenceGraphHash,
		result.factLedger.factLedgerHash,
		result.derivedAnalysis.derivedAnalysisHash
	])
})

test('a controlled installment continuation preserves an explicit source zero', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[{
			text: '1. 2025年3月3日丙银行发放的贷记卡（人民币账户，卡片尾号：4321）。截至2026年6月，信用额度30,000元，已使用额度15,000元。',
			bbox: [20, 100, 590, 118]
		}],
		[{ text: '未出单大额专项分期余额0元。', bbox: [20, 120, 360, 138] }]
	])
	const extracted = extractedCardFacts([{
		institution: '丙银行', start_date: '2025-03-03', card_tail: '4321',
		credit_limit: 30000, used_limit: 15000, status: '正常'
	}])
	applyControlledSourceCardInstallments(extracted, fixture.sourceText, {
		documentId: `doc_v2_${'2'.repeat(64)}`,
		declaredPageCount: 1,
		documentMeta: fixture.documentMeta,
		hashFn: TEST_HASH_FN
	})
	assert.equal(extracted.credit_card_details[0].installment, 0)

	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: fixture.sourceText,
		documentId: `doc_v2_${'2'.repeat(64)}`,
		evidenceContext: {
			...verifiedContext(isolatedFacts({ cards: extracted.credit_card_details, score: 100 }), {
				active_loans: 0,
				credit_card_details: 1,
				query_details: 0
			}),
			documentMeta: fixture.documentMeta
		},
		hashFn: TEST_HASH_FN
	})
	const installment = result.factLedger.facts.find((fact) =>
		fact.entityKind === 'card' && fact.field === 'installment'
	)
	assert.equal(result.publicationGate.publishable, true)
	assert.equal(installment.status, FACT_STATUS.ACCEPTED)
	assert.equal(installment.value.minor, 0)
})

test('structured continuation rejects a same-row cross-column identity block', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[{
			text: '1. 2025年3月3日丙银行发放的贷记卡（人民币账户，卡片尾号：4321）。截至2026年6月，信用额度30,000元，已使用额度15,000元。',
			bbox: [20, 100, 285, 118]
		}],
		[{
			text: '丙银行 卡片尾号4321 未出单大额专项分期余额5,000元。',
			bbox: [315, 100, 590, 118]
		}]
	])
	const facts = isolatedFacts({ cards: [{
		institution: '丙银行',
		start_date: '2025-03-03',
		card_tail: '4321',
		currency: 'CNY',
		credit_limit: 30000,
		used_limit: 15000,
		installment: 5000
	}], score: 76 })
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: fixture.sourceText,
		evidenceContext: {
			...verifiedContext(facts, {
				active_loans: 0,
				credit_card_details: 1,
				query_details: 0
			}),
			documentMeta: fixture.documentMeta
		},
		hashFn: TEST_HASH_FN
	})

	assert.equal(result.publicationGate.publishable, false)
	assert.equal(result.evidenceGraph.nodes.some((node) =>
		node.entityKind === 'card' && node.field === 'installment'
	), false)
	assert.equal(result.evidenceGraph.unresolved.some((item) =>
		item.reason === 'UNCLAIMED_SOURCE_INSTALLMENT_SIGNAL'
	), true)
})

test('structured installment continuation requires closed syntax and strict geometry', () => {
	const owner = '1. 2025年3月3日丙银行发放的贷记卡（人民币账户，卡片尾号：4321）。截至2026年6月，信用额度30,000元，已使用额度15,000元。'
	const cases = [
		{
			name: 'same-row-right-column',
			text: '未出单大额专项分期余额5,000元。',
			bbox: [315, 100, 590, 118]
		},
		{
			name: 'below-different-column',
			text: '未出单大额专项分期余额5,000元。',
			bbox: [315, 120, 590, 138]
		},
		{
			name: 'excessive-vertical-gap',
			text: '未出单大额专项分期余额5,000元。',
			bbox: [20, 180, 360, 198]
		},
		{
			name: 'missing-geometry',
			text: '未出单大额专项分期余额5,000元。',
			bbox: null
		},
		{
			name: 'identity-prefix',
			text: '丙银行 卡片尾号4321 未出单大额专项分期余额5,000元。',
			bbox: [20, 120, 430, 138]
		},
		{
			name: 'date-prefix',
			text: '2026年6月30日 未出单大额专项分期余额5,000元。',
			bbox: [20, 120, 430, 138]
		},
		{
			name: 'currency-suffix',
			text: '未出单大额专项分期余额5,000元，币种人民币。',
			bbox: [20, 120, 430, 138]
		},
		{
			name: 'other-debt-suffix',
			text: '未出单大额专项分期余额5,000元，贷款余额1,000元。',
			bbox: [20, 120, 430, 138]
		},
		{
			name: 'second-installment-field',
			text: '未出单大额专项分期余额5,000元，分期余额1,000元。',
			bbox: [20, 120, 430, 138]
		},
		{
			name: 'unbalanced-closing-parenthesis',
			text: '未出单大额专项分期余额5,000元）',
			bbox: [20, 120, 430, 138]
		}
	]
	for (const [index, item] of cases.entries()) {
		const fixture = structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			[{ text: owner, bbox: [20, 100, 285, 118] }],
			[{ text: item.text, bbox: item.bbox }]
		])
		const extracted = extractedCardFacts([{
			institution: '丙银行',
			start_date: '2025-03-03',
			card_tail: '4321',
			credit_limit: 30000,
			used_limit: 15000,
			status: '正常'
		}])
		applyControlledSourceCardInstallments(extracted, fixture.sourceText, {
			documentId: `doc_v2_${index.toString(16).padStart(64, '0')}`,
			declaredPageCount: 1,
			documentMeta: fixture.documentMeta,
			hashFn: TEST_HASH_FN
		})
		assert.equal(extracted.credit_card_details[0].installment, undefined, item.name)
	}
})

test('structured installment continuation applies the vertical gap threshold exactly', () => {
	for (const [index, item] of [
		{ name: 'at-threshold', top: 127, expected: 5000 },
		{ name: 'above-threshold', top: 127.01, expected: undefined }
	].entries()) {
		const fixture = structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			[{
				text: '1. 2025年3月3日丙银行发放的贷记卡（人民币账户，卡片尾号：4321）。截至2026年6月，信用额度30,000元，已使用额度15,000元。',
				bbox: [20, 100, 590, 118]
			}],
			[{
				text: '未出单大额专项分期余额5,000元。',
				bbox: [20, item.top, 360, item.top + 18]
			}]
		])
		const extracted = extractedCardFacts([{
			institution: '丙银行', start_date: '2025-03-03', card_tail: '4321',
			credit_limit: 30000, used_limit: 15000, status: '正常'
		}])
		applyControlledSourceCardInstallments(extracted, fixture.sourceText, {
			documentId: `doc_v2_${String(index + 20).padStart(64, '0')}`,
			declaredPageCount: 1,
			documentMeta: fixture.documentMeta,
			hashFn: TEST_HASH_FN
		})
		assert.equal(extracted.credit_card_details[0].installment, item.expected, item.name)
	}
})

test('structured installment continuation cannot skip blocks, cross pages, or use multiline geometry', () => {
	const owner = '1. 2025年3月3日丙银行发放的贷记卡（人民币账户，卡片尾号：4321）。截至2026年6月，信用额度30,000元，已使用额度15,000元。'
	const installment = '未出单大额专项分期余额5,000元。'
	const fixtures = [
		{
			name: 'intervening-source-block',
			fixture: structuredPdfFixture([
				[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
				[{ text: owner, bbox: [20, 100, 590, 118] }],
				[{ text: '账户说明文字。', bbox: [20, 120, 360, 138] }],
				[{ text: installment, bbox: [20, 140, 360, 158] }]
			])
		},
		{
			name: 'trailing-continuation-text',
			fixture: structuredPdfFixture([
				[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
				[{ text: owner, bbox: [20, 100, 590, 118] }],
				[{ text: installment, bbox: [20, 120, 360, 138] }],
				[{ text: '尚有未闭合的账户说明。', bbox: [20, 140, 360, 158] }]
			])
		},
		{
			name: 'multiline-continuation-block',
			fixture: structuredPdfFixture([
				[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
				[{ text: owner, bbox: [20, 100, 590, 118] }],
				[
					{ text: installment, bbox: [20, 120, 360, 138] },
					{ text: '附注。', bbox: [20, 140, 120, 158] }
				]
			])
		},
		{
			name: 'owner-geometry-unavailable',
			fixture: structuredPdfFixture([
				[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
				[{ text: owner, bbox: null }],
				[{ text: installment, bbox: [20, 120, 360, 138] }]
			])
		},
		{
			name: 'cross-page-continuation',
			fixture: structuredMultiPageFixture([
				['个人信用报告 报告日期：2026年6月30日', owner],
				[installment]
			])
		}
	]
	for (const [index, item] of fixtures.entries()) {
		const extracted = extractedCardFacts([{
			institution: '丙银行',
			start_date: '2025-03-03',
			card_tail: '4321',
			credit_limit: 30000,
			used_limit: 15000,
			status: '正常'
		}])
		applyControlledSourceCardInstallments(extracted, item.fixture.sourceText, {
			documentId: `doc_v2_${String(index + 10).padStart(64, '0')}`,
			declaredPageCount: item.fixture.documentMeta.expectedPageCount,
			documentMeta: item.fixture.documentMeta,
			hashFn: TEST_HASH_FN
		})
		assert.equal(extracted.credit_card_details[0].installment, undefined, item.name)
	}
})

test('structured installment continuation requires one forced model owner', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[{
			text: '1. 2025年3月3日丙银行发放的贷记卡（人民币账户，卡片尾号：4321）。截至2026年6月，信用额度30,000元，已使用额度15,000元。',
			bbox: [20, 100, 590, 118]
		}],
		[{ text: '未出单大额专项分期余额5,000元。', bbox: [20, 120, 360, 138] }]
	])
	const duplicate = {
		institution: '丙银行',
		start_date: '2025-03-03',
		card_tail: '4321',
		credit_limit: 30000,
		used_limit: 15000,
		status: '正常'
	}
	const extracted = extractedCardFacts([{ ...duplicate }, { ...duplicate }])
	applyControlledSourceCardInstallments(extracted, fixture.sourceText, {
		documentId: `doc_v2_${'5'.repeat(64)}`,
		declaredPageCount: 1,
		documentMeta: fixture.documentMeta,
		hashFn: TEST_HASH_FN
	})

	assert.deepEqual(extracted.credit_card_details.map((card) => card.installment), [undefined, undefined])

	const dateOnly = extractedCardFacts([{ ...duplicate, card_tail: undefined, currency: 'CNY' }])
	applyControlledSourceCardInstallments(dateOnly, fixture.sourceText, {
		documentId: `doc_v2_${'4'.repeat(64)}`,
		declaredPageCount: 1,
		documentMeta: fixture.documentMeta,
		hashFn: TEST_HASH_FN
	})
	assert.equal(dateOnly.credit_card_details[0].installment, undefined)
})

test('two same-day official card records stay separate while a unique positive installment is repaired', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[
			{
				text: '1. 2024年10月7日同一银行发放的贷记卡，人民币，信用额度0元，余额0元。',
				bbox: [20, 100, 590, 118]
			},
			{ text: '未出单大额专项分期余额0元。', bbox: [40, 120, 360, 138] },
			{
				text: '2. 2024年10月7日同一银行发放的贷记卡，人民币，信用额度0元，余额49,670元。',
				bbox: [20, 150, 590, 168]
			},
			{ text: '未出单大额专项分期余额45,736元。', bbox: [40, 170, 380, 188] }
		]
	])
	const result = finalizeExtractedCreditFacts(extractedCardFacts([
		{
			institution: '同一银行', start_date: '2024-10-07', currency: 'CNY',
			credit_limit: 0, used_limit: 0, status: '正常'
		},
		{
			institution: '同一银行', start_date: '2024-10-07', currency: 'CNY',
			credit_limit: 0, used_limit: 49670, status: '正常'
		}
	]), fixture.sourceText, {
		evidenceRequired: true,
		documentId: `doc_v2_${'e'.repeat(64)}`,
		evidenceContext: fixture.documentMeta,
		sourceVerifiedCounts: {
			active_loans: sourceCount(0),
			credit_card_details: sourceCount(2),
			query_details: sourceCount(0)
		}
	})

	assert.deepEqual(result.credit_card_details.map((card) => card.installment).sort((a, b) => a - b), [0, 45736])
	assert.equal(result.credit_debt.credit_cards.total_used, 49670)
	assert.equal(result.credit_debt.credit_cards.large_installment, 45736)
	assert.equal(result.primary_rule_score.score, 76)
	assert.equal(result.evidence_v2.factLedger.relations.length, 0)
	assert.equal(result.evidence_v2.factLedger.conflicts.length, 0)
	assert.equal(result.evidence_v2.publicationGate.publishable, true)
	assert.equal(result.evidence_v2.derivedAnalysis.metrics.cardOutstanding.facilityTrace.length, 2)
})

test('five-card topology repairs only the uniquely identified omitted CNY currency and installment', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[{ text: '1. 2025年3月3日同源银行发放的贷记卡（人民币账户，卡片尾号：4321）。截至2026年6月，信用额度30,000元，余额15,000元（含未出单的大额专项分期余额5,000元）。', bbox: [20, 100, 590, 118] }],
		[{ text: '2. 2025年3月3日同源银行发放的贷记卡（人民币账户，卡片尾号：8765）。截至2026年6月，信用额度28,000元，已使用额度4,000元。', bbox: [20, 130, 590, 148] }],
		[{ text: '3. 2025年3月3日同源银行信用卡中心发放的贷记卡（人民币账户，卡片尾号：2468）。截至2026年6月，信用额度18,000元，已使用额度2,000元。', bbox: [20, 160, 590, 178] }],
		[{ text: '4. 2025年3月3日同源银行发放的贷记卡（美元账户，卡片尾号：1357）。截至2026年6月，信用额度10,000元，已使用额度0元。', bbox: [20, 190, 590, 208] }],
		[{ text: '5. 2025年4月4日异源银行发放的贷记卡（人民币账户，卡片尾号：1122）。截至2026年6月，信用额度12,000元，已使用额度1,000元。', bbox: [20, 220, 590, 238] }]
	])
	const result = finalizeExtractedCreditFacts(extractedCardFacts([
		{
			institution: '同源银行', start_date: '2025-03-03', card_tail: '4321',
			credit_limit: 30000, used_limit: 15000, status: '正常'
		},
		{
			institution: '同源银行', start_date: '2025-03-03', card_tail: '8765',
			currency: 'CNY', credit_limit: 28000, used_limit: 4000, status: '正常'
		},
		{
			institution: '同源银行信用卡中心', start_date: '2025-03-03', card_tail: '2468',
			currency: 'CNY', credit_limit: 18000, used_limit: 2000, status: '正常'
		},
		{
			institution: '同源银行', start_date: '2025-03-03', card_tail: '1357',
			currency: 'USD', credit_limit: 10000, used_limit: 0, status: '正常'
		},
		{
			institution: '异源银行', start_date: '2025-04-04', card_tail: '1122',
			currency: 'CNY', credit_limit: 12000, used_limit: 1000, status: '正常'
		}
	]), fixture.sourceText, {
		evidenceRequired: true,
		documentId: `doc_v2_${'8'.repeat(64)}`,
		evidenceContext: fixture.documentMeta,
		sourceVerifiedCounts: {
			active_loans: sourceCount(0),
			credit_card_details: sourceCount(5),
			query_details: sourceCount(0)
		}
	})

	const repaired = result.credit_card_details.find((card) => card.card_tail === '4321')
	const cardSection = result.evidence_v2.factLedger.sections.find((section) =>
		section.name === 'credit_card_details'
	)
	assert.equal(repaired.currency, 'CNY')
	assert.equal(repaired.installment, 5000)
	assert.deepEqual([
		cardSection.expectedCount,
		cardSection.declaredEntityCount,
		cardSection.acceptedEntityCount,
		cardSection.status
	], [5, 5, 5, 'complete'])
	assert.equal(result.evidence_v2.evidenceGraph.coverage.criticalUnresolvedCount, 0)
	assert.equal(result.evidence_v2.evidenceGraph.unresolved.some((item) =>
		item.reason === 'UNCLAIMED_SOURCE_INSTALLMENT_SIGNAL'
	), false)
	assert.equal(result.evidence_v2.factLedger.relations.length, 0)
	assert.equal(result.evidence_v2.factLedger.conflicts.length, 0)
	assert.equal(result.evidence_v2.publicationGate.publishable, true)
})

test('global card binding repairs the forced bundle instead of consuming the first compatible row', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[{
			text: '1. 2025年1月1日同一银行发放的贷记卡（卡片尾号：9999），人民币，信用额度：30,000元，已用额度15,000元，未出单大额专项分期余额1,000元。',
			bbox: [20, 100, 590, 118]
		}],
		[{
			text: '2. 2025年2月2日同一银行发放的贷记卡（卡片尾号：9999），人民币，信用额度：30,000元，已用额度15,000元，未出单大额专项分期余额2,000元。',
			bbox: [20, 140, 590, 158]
		}]
	])
	const cards = [
		{
			account_order: 'A',
			institution: '同一银行',
			card_tail: '9999',
			credit_limit: 30000,
			used_limit: 15000,
			status: '正常'
		},
		{
			account_order: 'B',
			institution: '同一银行',
			start_date: '2025-01-01',
			currency: 'CNY',
			credit_limit: 30000,
			used_limit: 15000,
			installment: 1000,
			status: '正常'
		}
	]
	const extracted = extractedCardFacts(cards)
	applyControlledSourceCardInstallments(extracted, fixture.sourceText, {
		documentId: `doc_v2_${'6'.repeat(64)}`,
		declaredPageCount: 1,
		documentMeta: fixture.documentMeta,
		hashFn: TEST_HASH_FN
	})

	const flexible = extracted.credit_card_details.find((card) => card.account_order === 'A')
	assert.equal(flexible.currency, 'CNY')
	assert.equal(flexible.installment, 2000)
	extracted.primary_rule_score = { score: 76, deductions: [] }

	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: fixture.sourceText,
		evidenceContext: {
			...verifiedContext(extracted, {
				active_loans: 0,
				credit_card_details: 2,
				query_details: 0
			}),
			documentMeta: fixture.documentMeta
		},
		documentId: `doc_v2_${'6'.repeat(64)}`,
		hashFn: TEST_HASH_FN
	})
	assert.equal(result.publicationGate.publishable, true)
	assert.equal(result.evidenceGraph.coverage.criticalUnresolvedCount, 0)
	assert.equal(new Set(result.evidenceGraph.nodes
		.filter((node) => node.entityKind === 'card' && node.field === 'credit_limit')
		.map((node) => node.recordBindingId)).size, 2)
})

test('global card binding is permutation independent and fails closed when a perfect assignment is not unique', () => {
	const makeFixture = (rows) => structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		...rows.map((date, index) => [{
			text: `${index + 1}. ${date === '2025-01-01' ? '2025年1月1日' : '2025年2月2日'}同一银行发放的贷记卡，人民币，信用额度：20,000元，已用额度5,000元。`,
			bbox: [20, 100 + index * 40, 590, 118 + index * 40]
		}])
	])
	const forcedCards = [
		{ account_order: 'A', institution: '同一银行', currency: 'CNY', credit_limit: 20000, used_limit: 5000 },
		{ account_order: 'B', institution: '同一银行', start_date: '2025-01-01', currency: 'CNY', credit_limit: 20000, used_limit: 5000 }
	]
	for (const [caseIndex, rows] of [
		['2025-01-01', '2025-02-02'],
		['2025-02-02', '2025-01-01']
	].entries()) {
		const fixture = makeFixture(rows)
		const result = buildEvidenceFirstCreditAnalysis({
			sourceText: fixture.sourceText,
			evidenceContext: {
				...verifiedContext(isolatedFacts({ cards: [...forcedCards].reverse() }), {
					active_loans: 0,
					credit_card_details: 2,
					query_details: 0
				}),
				documentMeta: fixture.documentMeta
			},
			documentId: `doc_v2_${String(caseIndex + 7).repeat(64)}`,
			hashFn: TEST_HASH_FN
		})
		assert.equal(result.publicationGate.publishable, true, `source permutation ${caseIndex}`)
		assert.equal(result.evidenceGraph.coverage.criticalUnresolvedCount, 0, `source permutation ${caseIndex}`)
	}

	const ambiguousFixture = makeFixture(['2025-01-01', '2025-02-02'])
	const ambiguous = buildEvidenceFirstCreditAnalysis({
		sourceText: ambiguousFixture.sourceText,
		evidenceContext: {
			...verifiedContext(isolatedFacts({ cards: forcedCards.map((card) => {
				const copy = { ...card }
				delete copy.start_date
				return copy
			}) }), {
				active_loans: 0,
				credit_card_details: 2,
				query_details: 0
			}),
			documentMeta: ambiguousFixture.documentMeta
		},
		documentId: `doc_v2_${'9'.repeat(64)}`,
		hashFn: TEST_HASH_FN
	})
	assert.equal(ambiguous.publicationGate.publishable, false)
	assert.equal(ambiguous.evidenceGraph.nodes.some((node) => node.entityKind === 'card'), false)
	assert.equal(ambiguous.evidenceGraph.unresolved.some((item) =>
		item.reason === 'AMBIGUOUS_CARD_SOURCE_BUNDLE'
	), true)
})

test('five-page 6-loan 5-card 65-query evidence chain publishes with singleton same-day cards', () => {
	const loans = Array.from({ length: 6 }, (_, index) => ({
		institution: `匿名贷款机构${String(index + 1).padStart(2, '0')}银行`,
		start_date: `2025-0${index + 1}-0${index + 1}`,
		currency: 'CNY',
		balance: (index + 1) * 1000,
		status: '正常'
	}))
	const cards = [
		{
			institution: '匿名卡机构甲银行', start_date: '2024-01-02', card_tail: '1101',
			currency: 'CNY', credit_limit: 20000, used_limit: 5000, status: '正常'
		},
		{
			institution: '匿名卡机构乙银行', start_date: '2024-02-03', card_tail: '2202',
			currency: 'CNY', credit_limit: 30000, used_limit: 6000, status: '正常'
		},
		{
			institution: '匿名卡机构丙银行', start_date: '2024-03-04', card_tail: '3303',
			currency: 'CNY', credit_limit: 40000, used_limit: 7000, status: '正常'
		},
		{
			institution: '匿名同日机构银行', start_date: '2024-10-07',
			currency: 'CNY', credit_limit: 0, used_limit: 0, status: '正常'
		},
		{
			institution: '匿名同日机构银行', start_date: '2024-10-07',
			currency: 'CNY', credit_limit: 0, used_limit: 49670, status: '正常'
		}
	]
	const queries = Array.from({ length: 65 }, (_, index) => {
		const day = index % 28 + 1
		const month = index < 35 ? 6 : 5
		return {
			institution: `匿名查询机构${String(index + 1).padStart(2, '0')}银行`,
			date: `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
			reason: '贷款审批'
		}
	})
	const fixture = structuredMultiPageFixture([
		[
			'个人信用报告 报告日期：2026年6月30日',
			...loans.slice(0, 3).map((loan, index) =>
				`${index + 1}. ${loan.start_date.replace(/-(\d{2})-(\d{2})$/, '年$1月$2日')}${loan.institution}发放个人消费贷款，人民币，贷款余额：${loan.balance.toLocaleString('en-US')}元。`
			)
		],
		loans.slice(3).map((loan, index) =>
			`${index + 4}. ${loan.start_date.replace(/-(\d{2})-(\d{2})$/, '年$1月$2日')}${loan.institution}发放个人消费贷款，人民币，贷款余额：${loan.balance.toLocaleString('en-US')}元。`
		),
		[
			'1. 2024年1月2日匿名卡机构甲银行发放的贷记卡（尾号1101），人民币，信用额度20,000元，已用额度5,000元。',
			'2. 2024年2月3日匿名卡机构乙银行发放的贷记卡（尾号2202），人民币，信用额度30,000元，已用额度6,000元。',
			'3. 2024年3月4日匿名卡机构丙银行发放的贷记卡（尾号3303），人民币，信用额度40,000元，已用额度7,000元。',
			'4. 2024年10月7日匿名同日机构银行发放的贷记卡，人民币，信用额度0元，已用额度0元，未出单大额专项分期余额0元。',
			'5. 2024年10月7日匿名同日机构银行发放的贷记卡，人民币，信用额度0元，已用额度49,670元，未出单大额专项分期余额45,736元。'
		],
		queries.slice(0, 33).map((query, index) =>
			`${index + 1}. ${query.institution} ${query.date.replace(/-(\d{2})-(\d{2})$/, '年$1月$2日')} ${query.reason}`
		),
		queries.slice(33).map((query, index) =>
			`${index + 34}. ${query.institution} ${query.date.replace(/-(\d{2})-(\d{2})$/, '年$1月$2日')} ${query.reason}`
		)
	])
	const countNames = [
		'bank_loans', 'non_bank_loans', 'settled_loans', 'historical_overdue_loans',
		'credit_card_details', 'credit_card_details_cancelled', 'query_details', 'self_queries',
		'overdue_details', 'public_records', 'guarantee_records', 'loan_history'
	]
	const facts = {
		meta: { report_date: '2026-06-30' },
		basic_info: {},
		loan_details: {
			bank_loans: loans,
			non_bank_loans: [],
			settled_loans: [],
			historical_overdue_loans: []
		},
		credit_card_details: cards,
		credit_card_details_cancelled: [],
		query_analysis: { query_details: queries, self_queries: [] },
		overdue_info: { details: [] },
		public_records: { items: [] },
		guarantee_records: { items: [] },
		loan_history: { trend_data: [] },
		_coverage: {
			truncated: false,
			counts: Object.fromEntries(countNames.map((name) => {
				const total = name === 'bank_loans' ? 6
					: name === 'credit_card_details' ? 5
						: name === 'query_details' ? 65 : 0
				return [name, { total, listed: total }]
			}))
		}
	}
	const result = finalizeExtractedCreditFacts(facts, fixture.sourceText, {
		evidenceRequired: true,
		documentId: `doc_v2_${'7'.repeat(64)}`,
		evidenceContext: fixture.documentMeta,
		sourceVerifiedCounts: {
			active_loans: sourceCount(6),
			credit_card_details: sourceCount(5),
			query_details: sourceCount(65)
		}
	})

	assert.equal(result.evidence_v2.manifest.coverage.processedPageCount, 5)
	assert.deepEqual(
		Object.fromEntries(result.evidence_v2.factLedger.sections.map((section) => [
			section.name,
			[section.expectedCount, section.declaredEntityCount, section.acceptedEntityCount, section.status]
		])),
		{
			active_loans: [6, 6, 6, 'complete'],
			credit_card_details: [5, 5, 5, 'complete'],
			query_details: [65, 65, 65, 'complete']
		}
	)
	assert.equal(result.evidence_v2.publicationGate.status, 'passed')
	assert.equal(result.evidence_v2.factLedger.relations.length, 0)
	assert.equal(result.evidence_v2.factLedger.conflicts.length, 0)
	assert.equal(result.credit_card_details.find((card) => card.used_limit === 49670)?.installment, 45736)
	assert.equal(result.evidence_v2.derivedAnalysis.metrics.cardOutstanding.facilityTrace.length, 5)
	assert.ok(result.evidence_v2.derivedAnalysis.metrics.cardOutstanding.facilityTrace.every(
		(facility) => facility.memberEntityIds.length === 1 && facility.inputRelationIds.length === 0
	))
	assert.equal(
		result.evidence_v2.derivedAnalysis.metrics.totalDebt.value.minor / 100,
		result.credit_debt.total_debt
	)
	assert.equal(
		result.evidence_v2.derivedAnalysis.metrics.primaryScore.value.value,
		result.primary_rule_score.score
	)
})

test('non-evidence analysis never derives a missing installment from source text', () => {
	const source = [
		'【第1页】',
		'个人信用报告 报告日期：2026年6月30日',
		'1. 2025年3月3日丙银行发放的贷记卡，人民币，信用额度30,000元，已用额度15,000元，专项分期余额5,000元。'
	].join('\n')
	const result = finalizeExtractedCreditFacts(extractedCardFacts([{
		institution: '丙银行', start_date: '2025-03-03', currency: 'CNY',
		credit_limit: 30000, used_limit: 15000, status: '正常'
	}]), source)

	assert.equal(result.credit_card_details[0].installment, undefined)
	assert.equal(result.credit_debt.credit_cards.large_installment, 0)
})

test('evidence pre-rule repair never overwrites a valid model installment and a mismatch fails closed', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[{
			text: '1. 2025年3月3日丙银行发放的贷记卡（尾号4321），人民币，信用额度：30,000元，已用额度15,000元，分期余额5,000元。',
			bbox: [20, 100, 590, 118]
		}]
	])
	const options = {
		evidenceRequired: true,
		documentId: `doc_v2_${'9'.repeat(64)}`,
		evidenceContext: fixture.documentMeta,
		sourceVerifiedCounts: {
			active_loans: sourceCount(0),
			credit_card_details: sourceCount(1),
			query_details: sourceCount(0)
		}
	}
	const card = {
		institution: '丙银行', start_date: '2025-03-03', card_tail: '4321',
		currency: 'CNY', credit_limit: 30000, used_limit: 15000,
		status: '正常'
	}
	const consistent = finalizeExtractedCreditFacts(extractedCardFacts([{
		...card,
		installment: 5000
	}]), fixture.sourceText, options)
	assert.equal(consistent.credit_card_details[0].installment, 5000)
	assert.equal(consistent.credit_debt.credit_cards.large_installment, 5000)
	assert.equal(consistent.evidence_v2.publicationGate.publishable, true)

	const inconsistentFacts = extractedCardFacts([{ ...card, installment: 7000 }])
	applyControlledSourceCardInstallments(inconsistentFacts, fixture.sourceText, {
		documentId: options.documentId,
		declaredPageCount: 1,
		documentMeta: fixture.documentMeta,
		hashFn: TEST_HASH_FN
	})
	assert.equal(inconsistentFacts.credit_card_details[0].installment, 7000)
	assert.throws(
		() => finalizeExtractedCreditFacts(
			extractedCardFacts([{ ...card, installment: 7000 }]),
			fixture.sourceText,
			options
		),
		(error) => error?.code === 'EVIDENCE_PUBLICATION_BLOCKED'
	)
})

test('positive installment repair rejects foreign currency and ambiguous source values', () => {
	const cases = [
		{
			name: 'foreign-currency',
			currency: 'USD',
			currencyText: '美元',
			installmentText: '未出单大额专项分期余额5,000元'
		},
		{
			name: 'multiple-values',
			currency: 'CNY',
			currencyText: '人民币',
			installmentText: '专项分期余额0元，分期余额5,000元'
		}
	]
	for (const item of cases) {
		const fixture = structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			[{
				text: `1. 2025年3月3日丙银行发放的贷记卡（尾号4321），${item.currencyText}，信用额度：30,000元，已用额度15,000元，${item.installmentText}。`,
				bbox: [20, 100, 590, 118]
			}]
		])
		assert.throws(() => finalizeExtractedCreditFacts(extractedCardFacts([{
			institution: '丙银行', start_date: '2025-03-03', card_tail: '4321',
			currency: item.currency, credit_limit: 30000, used_limit: 15000,
			status: '正常'
		}]), fixture.sourceText, {
			evidenceRequired: true,
			documentId: `doc_v2_${item.name === 'foreign-currency' ? 'c' : 'd'}`.padEnd(71, item.name === 'foreign-currency' ? 'c' : 'd'),
			evidenceContext: fixture.documentMeta,
			sourceVerifiedCounts: {
				active_loans: sourceCount(0),
				credit_card_details: sourceCount(1),
				query_details: sourceCount(0)
			}
		}), (error) => error?.code === 'EVIDENCE_PUBLICATION_BLOCKED', item.name)
	}
})

test('positive installment repair requires closed CNY grammar and rejects mixed, negated, or unknown currencies', () => {
	const card = {
		institution: '匿名银行', start_date: '2025-03-03', card_tail: '4321',
		currency: 'CNY', credit_limit: 30000, used_limit: 15000,
		status: '正常'
	}
	const cases = [
		['cny-usd', '人民币、美元'],
		['cny-aed', '人民币及AED'],
		['cny-twd', '人民币及TWD'],
		['negated-cny', '非人民币'],
		['cny-us-dollar', '人民币及U.S. Dollar'],
		['cny-russian-rouble', '人民币及俄罗斯卢布'],
		['field-cny-usd', '币种：人民币，美元'],
		['field-cny-russian-rouble', '币种：人民币，俄罗斯卢布'],
		['field-cny-us-dollar', '币种：人民币，U.S. Dollar'],
		['field-cny-lowercase-aed', '币种：人民币，aed']
	]
	for (const [index, [name, currencyText]] of cases.entries()) {
		const fixture = structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			[{
				text: `1. 2025年3月3日匿名银行发放的贷记卡（尾号4321），${currencyText}，信用额度：30,000元，已用额度15,000元，未出单大额专项分期余额5,000元。`,
				bbox: [20, 100, 590, 118]
			}]
		])
		const documentId = `doc_v2_${String.fromCharCode(97 + index).repeat(64)}`
		const facts = extractedCardFacts([{ ...card }])
		applyControlledSourceCardInstallments(facts, fixture.sourceText, {
			documentId,
			declaredPageCount: 1,
			documentMeta: fixture.documentMeta,
			hashFn: TEST_HASH_FN
		})
		assert.equal(facts.credit_card_details[0].installment, undefined, `${name}: helper`)
		assert.throws(() => finalizeExtractedCreditFacts(
			extractedCardFacts([{ ...card }]),
			fixture.sourceText,
			{
				evidenceRequired: true,
				documentId,
				evidenceContext: fixture.documentMeta,
				sourceVerifiedCounts: {
					active_loans: sourceCount(0),
					credit_card_details: sourceCount(1),
					query_details: sourceCount(0)
				}
			}
		), (error) => error?.code === 'EVIDENCE_PUBLICATION_BLOCKED', `${name}: gate`)
	}
})

test('positive installment repair rejects non-CNY suffixes on every source money dependency', () => {
	const cases = [
		['credit-limit-usd', '30,000美元', '15,000元', '5,000元'],
		['used-limit-usd', '30,000元', '15,000美元', '5,000元'],
		['installment-usd', '30,000元', '15,000元', '5,000美元'],
		['installment-aed', '30,000元', '15,000元', '5,000AED'],
		['installment-comma-usd', '30,000元', '15,000元', '5,000元，美元'],
		['installment-period-usd', '30,000元', '15,000元', '5,000元。美元'],
		['installment-paren-usd', '30,000元', '15,000元', '5,000元）美元'],
		['installment-bare-comma-usd', '30,000元', '15,000元', '5,000，美元'],
		['installment-semicolon-aed', '30,000元', '15,000元', '5,000元；AED'],
		['installment-dollar-symbol', '30,000元', '15,000元', '5,000元，$'],
		['installment-euro-symbol', '30,000元', '15,000元', '5,000€'],
		['installment-pound-symbol', '30,000元', '15,000元', '5,000元；£'],
		['installment-yen-symbol', '30,000元', '15,000元', '5,000¥'],
		['installment-status-prefix', '30,000元', '15,000元', '5,000元，状态美元'],
		['installment-status-value-tail', '30,000元', '15,000元', '5,000元，状态：正常，美元'],
		['installment-balance-prefix', '30,000元', '15,000元', '5,000元，余额美元'],
		['installment-limit-prefix', '30,000元', '15,000元', '5,000元，信用额度美元'],
		['installment-date-prefix', '30,000元', '15,000元', '5,000元，截至美元']
	]
	const card = {
		institution: '匿名银行', start_date: '2025-03-03', card_tail: '4321',
		currency: 'CNY', credit_limit: 30000, used_limit: 15000,
		status: '正常'
	}
	for (const [index, [name, limitText, usedText, installmentText]] of cases.entries()) {
		const fixture = structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			[{
				text: `1. 2025年3月3日匿名银行发放的贷记卡（尾号4321），人民币，信用额度：${limitText}，已用额度${usedText}，未出单大额专项分期余额${installmentText}。`,
				bbox: [20, 100, 590, 118]
			}]
		])
		const documentId = `doc_v2_${String.fromCharCode(97 + (index % 26)).repeat(64)}`
		const facts = extractedCardFacts([{ ...card }])
		applyControlledSourceCardInstallments(facts, fixture.sourceText, {
			documentId,
			declaredPageCount: 1,
			documentMeta: fixture.documentMeta,
			hashFn: TEST_HASH_FN
		})
		assert.equal(facts.credit_card_details[0].installment, undefined, `${name}: helper`)
		assert.throws(() => finalizeExtractedCreditFacts(
			extractedCardFacts([{ ...card }]),
			fixture.sourceText,
			{
				evidenceRequired: true,
				documentId,
				evidenceContext: fixture.documentMeta,
				sourceVerifiedCounts: {
					active_loans: sourceCount(0),
					credit_card_details: sourceCount(1),
					query_details: sourceCount(0)
				}
			}
		), (error) => error?.code === 'EVIDENCE_PUBLICATION_BLOCKED', `${name}: gate`)
	}
})

test('positive installment repair rejects a foreign-currency atomic member after the matched amount', () => {
	const card = {
		institution: '匿名银行', start_date: '2025-03-03', card_tail: '4321',
		currency: 'CNY', credit_limit: 30000, used_limit: 15000,
		status: '正常'
	}
	const cardLine = '1. 2025年3月3日匿名银行发放的贷记卡（尾号4321），人民币，信用额度：30,000元，已用额度15,000元，未出单大额专项分期余额5,000元。'
	const fixtures = [
		[
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			{
				lines: [
					{ text: cardLine, bbox: [20, 100, 590, 118] },
					{ text: '美元', bbox: [20, 120, 80, 138] }
				]
			}
		],
		[
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			[{ text: cardLine, bbox: [20, 100, 590, 118] }],
			[{ text: '美元', bbox: [20, 120, 80, 138] }]
		]
	]
	for (const [index, blockSpecs] of fixtures.entries()) {
		const fixture = structuredPdfFixture(blockSpecs)
		const documentId = `doc_v2_${(index ? 'v' : 'u').repeat(64)}`
		const facts = extractedCardFacts([{ ...card }])
		applyControlledSourceCardInstallments(facts, fixture.sourceText, {
			documentId,
			declaredPageCount: 1,
			documentMeta: fixture.documentMeta,
			hashFn: TEST_HASH_FN
		})
		assert.equal(facts.credit_card_details[0].installment, undefined, `fixture ${index}: helper`)
		assert.throws(() => finalizeExtractedCreditFacts(
			extractedCardFacts([{ ...card }]),
			fixture.sourceText,
			{
				evidenceRequired: true,
				documentId,
				evidenceContext: fixture.documentMeta,
				sourceVerifiedCounts: {
					active_loans: sourceCount(0),
					credit_card_details: sourceCount(1),
					query_details: sourceCount(0)
				}
			}
		), (error) => error?.code === 'EVIDENCE_PUBLICATION_BLOCKED', `fixture ${index}: gate`)
	}
})

test('positive installment repair accepts one exact CNY-account assertion followed by a strict as-of line', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		{
			lines: [
				{
					text: '1. 2025年3月3日匿名银行发放的贷记卡（人民币账户）',
					bbox: [20, 100, 490, 118]
				},
				{
					text: '截至2026年6月，信用额度：30,000元，已用额度15,000元，未出单大额专项分期余额5,000元。',
					bbox: [20, 120, 590, 138]
				}
			]
		}
	])
	const card = {
		institution: '匿名银行', start_date: '2025-03-03',
		currency: 'CNY', credit_limit: 30000, used_limit: 15000,
		status: '正常'
	}
	const documentId = `doc_v2_${'r'.repeat(64)}`
	const facts = extractedCardFacts([{ ...card }])
	applyControlledSourceCardInstallments(facts, fixture.sourceText, {
		documentId,
		declaredPageCount: 1,
		documentMeta: fixture.documentMeta,
		hashFn: TEST_HASH_FN
	})
	assert.equal(facts.credit_card_details[0].installment, 5000)

	const result = finalizeExtractedCreditFacts(extractedCardFacts([{ ...card }]), fixture.sourceText, {
		evidenceRequired: true,
		documentId,
		evidenceContext: fixture.documentMeta,
		sourceVerifiedCounts: {
			active_loans: sourceCount(0),
			credit_card_details: sourceCount(1),
			query_details: sourceCount(0)
		}
	})
	assert.equal(result.credit_card_details[0].installment, 5000)
	assert.equal(result.evidence_v2.publicationGate.publishable, true)
})

test('parenthetical CNY-account fallback accepts the closed official wrapped-balance sequence', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		{
			lines: [
				{
					text: '1. 2025年3月3日匿名银行发放的贷记卡（人民币账户），截至2026年6月，信用额度：30,000元，余额',
					bbox: [20, 100, 590, 118]
				},
				{
					text: '15,000元（含未出单的大额专项分期余额5,000元）。',
					bbox: [20, 120, 410, 138]
				}
			]
		}
	])
	const card = {
		institution: '匿名银行', start_date: '2025-03-03',
		currency: 'CNY', credit_limit: 30000, used_limit: 15000,
		status: '正常'
	}
	const documentId = `doc_v2_${'w'.repeat(64)}`
	const facts = extractedCardFacts([{ ...card }])
	applyControlledSourceCardInstallments(facts, fixture.sourceText, {
		documentId,
		declaredPageCount: 1,
		documentMeta: fixture.documentMeta,
		hashFn: TEST_HASH_FN
	})
	assert.equal(facts.credit_card_details[0].installment, 5000)

	const result = finalizeExtractedCreditFacts(extractedCardFacts([{ ...card }]), fixture.sourceText, {
		evidenceRequired: true,
		documentId,
		evidenceContext: fixture.documentMeta,
		sourceVerifiedCounts: {
			active_loans: sourceCount(0),
			credit_card_details: sourceCount(1),
			query_details: sourceCount(0)
		}
	})
	assert.equal(result.credit_card_details[0].installment, 5000)
	assert.equal(result.evidence_v2.publicationGate.publishable, true)
})

test('parenthetical CNY-account fallback rejects unclosed or foreign wrapped installment money', () => {
	const card = {
		institution: '匿名银行', start_date: '2025-03-03',
		currency: 'CNY', credit_limit: 30000, used_limit: 15000,
		status: '正常'
	}
	const cases = [
		['missing-close', '（含未出单的大额专项分期余额5,000元。'],
		['usd-suffix', '（含未出单的大额专项分期余额5,000美元）。'],
		['aed-suffix', '（含未出单的大额专项分期余额5,000AED）。']
	]
	for (const [index, [name, wrappedLine]] of cases.entries()) {
		const fixture = structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			{
				lines: [
					{
						text: '1. 2025年3月3日匿名银行发放的贷记卡（人民币账户），截至2026年6月，信用额度：30,000元，已用额度15,000元。',
						bbox: [20, 100, 590, 118]
					},
					{ text: wrappedLine, bbox: [20, 120, 410, 138] }
				]
			}
		])
		const documentId = `doc_v2_${String(index + 7).repeat(64).slice(0, 64)}`
		const facts = extractedCardFacts([{ ...card }])
		applyControlledSourceCardInstallments(facts, fixture.sourceText, {
			documentId,
			declaredPageCount: 1,
			documentMeta: fixture.documentMeta,
			hashFn: TEST_HASH_FN
		})
		assert.equal(facts.credit_card_details[0].installment, undefined, `${name}: helper`)
		assert.throws(() => finalizeExtractedCreditFacts(
			extractedCardFacts([{ ...card }]),
			fixture.sourceText,
			{
				evidenceRequired: true,
				documentId,
				evidenceContext: fixture.documentMeta,
				sourceVerifiedCounts: {
					active_loans: sourceCount(0),
					credit_card_details: sourceCount(1),
					query_details: sourceCount(0)
				}
			}
		), (error) => error?.code === 'EVIDENCE_PUBLICATION_BLOCKED', `${name}: gate`)
	}
})

test('parenthetical CNY-account fallback accepts complete controlled money lines', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		{
			lines: [
				{ text: '1. 2025年3月3日匿名银行发放的贷记卡（人民币账户）', bbox: [20, 100, 490, 118] },
				{ text: '截至2026年6月，信用额度：30,000元。', bbox: [20, 120, 360, 138] },
				{ text: '已用额度15,000元。', bbox: [20, 140, 260, 158] },
				{ text: '未出单大额专项分期余额5,000元。', bbox: [20, 160, 360, 178] }
			]
		}
	])
	const card = {
		institution: '匿名银行', start_date: '2025-03-03',
		currency: 'CNY', credit_limit: 30000, used_limit: 15000,
		status: '正常'
	}
	const result = finalizeExtractedCreditFacts(extractedCardFacts([{ ...card }]), fixture.sourceText, {
		evidenceRequired: true,
		documentId: `doc_v2_${'q'.repeat(64)}`,
		evidenceContext: fixture.documentMeta,
		sourceVerifiedCounts: {
			active_loans: sourceCount(0),
			credit_card_details: sourceCount(1),
			query_details: sourceCount(0)
		}
	})
	assert.equal(result.credit_card_details[0].installment, 5000)
	assert.equal(result.evidence_v2.publicationGate.publishable, true)
})

test('parenthetical CNY-account fallback rejects free atomic lines between money fields', () => {
	const card = {
		institution: '匿名银行', start_date: '2025-03-03',
		currency: 'CNY', credit_limit: 30000, used_limit: 15000,
		status: '正常'
	}
	const cases = ['美元100', 'aed100', '账户说明100', '（美元账户）100']
	for (const [index, freeLine] of cases.entries()) {
		const fixture = structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			{
				lines: [
					{ text: '1. 2025年3月3日匿名银行发放的贷记卡（人民币账户）', bbox: [20, 100, 490, 118] },
					{ text: '截至2026年6月，信用额度：30,000元。', bbox: [20, 120, 360, 138] },
					{ text: freeLine, bbox: [20, 140, 220, 158] },
					{ text: '已用额度15,000元，未出单大额专项分期余额5,000元。', bbox: [20, 160, 510, 178] }
				]
			}
		])
		const documentId = `doc_v2_${String.fromCharCode(104 + index).repeat(64)}`
		const facts = extractedCardFacts([{ ...card }])
		applyControlledSourceCardInstallments(facts, fixture.sourceText, {
			documentId,
			declaredPageCount: 1,
			documentMeta: fixture.documentMeta,
			hashFn: TEST_HASH_FN
		})
		assert.equal(facts.credit_card_details[0].installment, undefined, `${freeLine}: helper`)
		assert.throws(() => finalizeExtractedCreditFacts(
			extractedCardFacts([{ ...card }]),
			fixture.sourceText,
			{
				evidenceRequired: true,
				documentId,
				evidenceContext: fixture.documentMeta,
				sourceVerifiedCounts: {
					active_loans: sourceCount(0),
					credit_card_details: sourceCount(1),
					query_details: sourceCount(0)
				}
			}
		), (error) => error?.code === 'EVIDENCE_PUBLICATION_BLOCKED', `${freeLine}: gate`)
	}
})

test('parenthetical CNY-account fallback rejects every non-unique or non-date transition', () => {
	const card = {
		institution: '匿名银行', start_date: '2025-03-03',
		currency: 'CNY', credit_limit: 30000, used_limit: 15000,
		status: '正常'
	}
	const cases = [
		['external-usd', '1. 2025年3月3日匿名银行发放的贷记卡（人民币账户），美元', '截至2026年6月'],
		['external-aed', '1. 2025年3月3日匿名银行AED发放的贷记卡（人民币账户）', '截至2026年6月'],
		['before-us-dollar', '1. 2025年3月3日匿名银行U.S. Dollar发放的贷记卡（人民币账户）', '截至2026年6月'],
		['before-dollar-word', '1. 2025年3月3日匿名银行DOLLAR发放的贷记卡（人民币账户）', '截至2026年6月'],
		['before-meijin', '1. 2025年3月3日匿名银行美金发放的贷记卡（人民币账户）', '截至2026年6月'],
		['external-us-dollar', '1. 2025年3月3日匿名银行发放的贷记卡（人民币账户），U.S. Dollar', '截至2026年6月'],
		['external-russian-rouble', '1. 2025年3月3日匿名银行俄罗斯卢布发放的贷记卡（人民币账户）', '截至2026年6月'],
		['mixed-account-parenthesis', '1. 2025年3月3日匿名银行发放的贷记卡（人民币、美元账户）', '截至2026年6月'],
		['second-currency-parenthesis', '1. 2025年3月3日匿名银行发放的贷记卡（人民币账户）（美元账户）', '截至2026年6月'],
		['negated-card-type', '1. 2025年3月3日匿名银行发放的非贷记卡（人民币账户）', '截至2026年6月'],
		['not-card-type', '1. 2025年3月3日匿名银行发放的不是信用卡（人民币账户）', '截至2026年6月'],
		['suspected-card-type', '1. 2025年3月3日匿名银行发放的疑似准贷记卡（人民币账户）', '截至2026年6月'],
		['free-date-tail', '1. 2025年3月3日匿名银行发放的贷记卡（人民币账户）', '截至2026年6月统计'],
		['multiple-parentheses', '1. 2025年3月3日匿名银行发放的贷记卡（人民币账户）（账户说明）', '截至2026年6月']
	]
	for (const [index, [name, identityLine, asOfLine]] of cases.entries()) {
		const fixture = structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			{
				lines: [
					{ text: identityLine, bbox: [20, 100, 570, 118] },
					{
						text: `${asOfLine}，信用额度：30,000元，已用额度15,000元，未出单大额专项分期余额5,000元。`,
						bbox: [20, 120, 590, 138]
					}
				]
			}
		])
		const documentId = `doc_v2_${String.fromCharCode(115 + index).repeat(64)}`
		const facts = extractedCardFacts([{ ...card }])
		applyControlledSourceCardInstallments(facts, fixture.sourceText, {
			documentId,
			declaredPageCount: 1,
			documentMeta: fixture.documentMeta,
			hashFn: TEST_HASH_FN
		})
		assert.equal(facts.credit_card_details[0].installment, undefined, `${name}: helper`)
		assert.throws(() => finalizeExtractedCreditFacts(
			extractedCardFacts([{ ...card }]),
			fixture.sourceText,
			{
				evidenceRequired: true,
				documentId,
				evidenceContext: fixture.documentMeta,
				sourceVerifiedCounts: {
					active_loans: sourceCount(0),
					credit_card_details: sourceCount(1),
					query_details: sourceCount(0)
				}
			}
		), (error) => error?.code === 'EVIDENCE_PUBLICATION_BLOCKED', `${name}: gate`)
	}
})

test('positive installment repair accepts closed CNY units and a directly adjacent controlled field', () => {
	const cases = [
		['ten-thousand-yuan', '信用额度3万元，已用额度15,000元，未出单大额专项分期余额5,000元'],
		['long-form-cny-unit', '信用额度30,000人民币元，已用额度15,000元，未出单大额专项分期余额5,000元'],
		['adjacent-controlled-field', '信用额度30,000元已用额度15,000元未出单大额专项分期余额5,000元']
	]
	const card = {
		institution: '匿名银行', start_date: '2025-03-03', card_tail: '4321',
		currency: 'CNY', credit_limit: 30000, used_limit: 15000,
		status: '正常'
	}
	for (const [index, [name, moneyFields]] of cases.entries()) {
		const fixture = structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			[{
				text: `1. 2025年3月3日匿名银行发放的贷记卡（尾号4321），人民币，${moneyFields}。`,
				bbox: [20, 100, 590, 118]
			}]
		])
		const result = finalizeExtractedCreditFacts(extractedCardFacts([{ ...card }]), fixture.sourceText, {
			evidenceRequired: true,
			documentId: `doc_v2_${String.fromCharCode(120 + index).repeat(64)}`,
			evidenceContext: fixture.documentMeta,
			sourceVerifiedCounts: {
				active_loans: sourceCount(0),
				credit_card_details: sourceCount(1),
				query_details: sourceCount(0)
			}
		})
		assert.equal(result.credit_card_details[0].installment, 5000, name)
		assert.equal(result.evidence_v2.publicationGate.publishable, true, name)
	}
})

test('controlled installment repair cannot cross groups, skip a line, or borrow another card value', () => {
	const card = {
		institution: '丙银行', start_date: '2025-03-03', card_tail: '4321',
		currency: 'CNY', credit_limit: 30000, used_limit: 15000
	}
	const fixtures = [
		structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			[{ text: '1. 2025年3月3日丙银行发放的贷记卡（尾号4321），人民币，信用额度：30,000元，已用额度15,000元，专项分期余额', bbox: [20, 100, 570, 118] }],
			[{ text: '5,000元。', bbox: [20, 122, 180, 140] }]
		]),
		structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			[
				{ text: '1. 2025年3月3日丙银行发放的贷记卡（尾号4321），人民币，信用额度：30,000元，已用额度15,000元，专项分期余额', bbox: [20, 100, 570, 118] },
				{ text: '字段说明', bbox: [20, 122, 180, 140] },
				{ text: '5,000元。', bbox: [20, 144, 180, 162] }
			]
		]),
		structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			[{
				text: '1. 2025年3月3日丙银行发放的贷记卡（尾号4321），人民币，信用额度：30,000元，已用额度15,000元。',
				bbox: [20, 100, 570, 118]
			}, {
				text: '2. 2025年4月4日丁银行发放的贷记卡（尾号9876），人民币，信用额度：50,000元，已用额度5,000元，专项分期余额5,000元。',
				bbox: [20, 144, 590, 162]
			}]
		])
	]
	for (const fixture of fixtures) {
		const facts = isolatedFacts({ cards: [{ ...card }] })
		applyControlledSourceCardInstallments(facts, fixture.sourceText, {
			documentMeta: fixture.documentMeta,
			hashFn: TEST_HASH_FN
		})
		assert.equal(facts.credit_card_details[0].installment, undefined)
	}
})

test('native structured PDF context preserves real page spans and polygons without exposing block text', () => {
	const page1 = '个人信用报告 报告日期：2026年6月30日'
	const page2 = [
		'甲银行 贷款余额：10,000.00元',
		'乙银行 2025年1月1日 尾号1234 人民币 授信额度：20,000.00元 已用额度：10,000.00元',
		'丙银行 2026年6月1日 贷款审批'
	].join('\n')
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: SOURCE,
		evidenceContext: {
			...verifiedContext(),
			documentMeta: {
				sourceMode: 'pdf-text',
				expectedPageCount: 2,
				complete: true,
				pages: [
					{
						pageNumber: 1,
						bounds: [0, 0, 600, 800],
						text: page1,
						blocks: [{ text: page1, charStart: 0, charEnd: page1.length, bbox: [10, 10, 590, 40] }]
					},
					{
						pageNumber: 2,
						bounds: [0, 0, 600, 800],
						text: page2,
						blocks: page2.split('\n').map((text, index, rows) => {
							const charStart = rows.slice(0, index).reduce((sum, row) => sum + row.length + 1, 0)
							return { text, charStart, charEnd: charStart + text.length, bbox: [10, 50 + index * 20, 590, 68 + index * 20] }
						})
					}
				]
			}
		}
	})

	assert.equal(result.manifest.pages.every((page) => page.geometryState === 'available'), true)
	assert.equal(result.evidenceGraph.blocks.every((block) => block.geometryState === 'available'), true)
	assert.ok(result.evidenceGraph.blocks.every((block) => Array.isArray(block.polygon) && block.polygon.length === 4))
	assert.ok(result.evidenceGraph.nodes.every((node) => node.evidenceRefs.every((ref) =>
		Number.isInteger(ref.span.offset) && ref.span.length > 0 && ref.geometryState === 'available'
	)))
	assert.doesNotMatch(JSON.stringify(result), /甲银行|乙银行|丙银行/)
})

test('structured PDF line geometry prevents cross-row institution and amount binding', () => {
	const pageText = [
		'个人信用报告 报告日期：2026年6月30日',
		'甲银行 贷款余额：100.00元',
		'乙银行 贷款余额：200.00元'
	].join('\n')
	const firstEnd = pageText.indexOf('\n')
	const secondEnd = pageText.indexOf('\n', firstEnd + 1)
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: `【第1页】\n${pageText}`,
		evidenceContext: {
			facts: {
				meta: { report_date: '2026-06-30' },
				loan_details: {
					bank_loans: [{ institution: '乙银行', balance: 100 }],
					non_bank_loans: []
				},
				credit_card_details: [],
				query_analysis: { query_details: [] },
				primary_rule_score: { score: 100 }
			},
			sourceVerifiedCounts: {
				active_loans: sourceCount(1),
				credit_card_details: sourceCount(0),
				query_details: sourceCount(0)
			},
			documentMeta: {
				sourceMode: 'pdf-text',
				expectedPageCount: 1,
				complete: true,
				pages: [{
					pageNumber: 1,
					bounds: [0, 0, 600, 800],
					text: pageText,
					blocks: [{
						text: pageText,
						charStart: 0,
						charEnd: pageText.length,
						bbox: [10, 10, 590, 100],
						lines: [
							{ text: pageText.slice(0, firstEnd), charStart: 0, charEnd: firstEnd, bbox: [10, 10, 590, 30] },
							{ text: pageText.slice(firstEnd + 1, secondEnd), charStart: firstEnd + 1, charEnd: secondEnd, bbox: [10, 40, 590, 60] },
							{ text: pageText.slice(secondEnd + 1), charStart: secondEnd + 1, charEnd: pageText.length, bbox: [10, 70, 590, 90] }
						]
					}]
				}]
			}
		}
	})
	const balance = result.factLedger.facts.find((fact) =>
		fact.entityKind === 'loan' && fact.field === 'balance'
	)

	assert.equal(balance.status, FACT_STATUS.UNKNOWN)
	assert.equal(balance.reason, 'SOURCE_EVIDENCE_MISSING')
	assert.equal(result.publicationGate.publishable, false)
})

test('structured PDF blocks with false spans or out-of-page geometry fail closed', () => {
	const pageText = '个人信用报告 报告日期：2026年6月30日'
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: pageText,
		evidenceContext: {
			...verifiedContext(finalizedFacts({
				loan_details: { bank_loans: [], non_bank_loans: [] },
				credit_card_details: [],
				query_analysis: { query_details: [] }
			}), {
				active_loans: 0,
				credit_card_details: 0,
				query_details: 0
			}),
			documentMeta: {
				sourceMode: 'pdf-text',
				expectedPageCount: 1,
				complete: true,
				pages: [{
					pageNumber: 1,
					bounds: [0, 0, 600, 800],
					text: pageText,
					blocks: [{
						text: pageText,
						charStart: 1,
						charEnd: pageText.length,
						bbox: [10, 10, 700, 40]
					}]
				}]
			}
		}
	})

	assert.equal(result.manifest.status, 'rejected')
	assert.equal(result.manifest.pages[0].status, 'rejected')
	assert.equal(result.publicationGate.publishable, false)
	assert.ok(result.publicationGate.failedChecks.includes('MANIFEST_COMPLETE'))
})

test('structured PDF page rejects an apparently valid block list that omits non-whitespace page text', () => {
	const firstLine = '个人信用报告 报告日期：2026年6月30日'
	const secondLine = '本行故意不提供结构化块'
	const pageText = `${firstLine}\n${secondLine}`
	const facts = finalizedFacts({
		loan_details: { bank_loans: [], non_bank_loans: [] },
		credit_card_details: [],
		query_analysis: { query_details: [] }
	})
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: pageText,
		evidenceContext: {
			...verifiedContext(facts, {
				active_loans: 0,
				credit_card_details: 0,
				query_details: 0
			}),
			documentMeta: {
				sourceMode: 'pdf-text',
				expectedPageCount: 1,
				complete: true,
				pages: [{
					pageNumber: 1,
					bounds: [0, 0, 600, 800],
					text: pageText,
					blocks: [{
						text: firstLine,
						charStart: 0,
						charEnd: firstLine.length,
						bbox: [10, 10, 590, 40]
					}]
				}]
			}
		}
	})

	assert.equal(result.manifest.pages[0].textCoverageComplete, false)
	assert.equal(result.manifest.status, 'rejected')
	assert.equal(result.publicationGate.publishable, false)
})

test('artifacts never expose source blocks, matched quotes, names, institutions, or card tails', () => {
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: SOURCE,
		evidenceContext: verifiedContext(),
		documentId: '客户张三-身份证号码不应透传'
	})
	const serialized = JSON.stringify(result)

	assert.doesNotMatch(serialized, /不应进入证据产物|甲银行|乙银行|丙银行|尾号1234|客户张三|身份证号码不应透传/)
	assert.doesNotMatch(serialized, /"quote"\s*:/)
	assert.doesNotMatch(serialized, /"sourceText"\s*:/)
	assert.ok(result.evidenceGraph.blocks.every((block) => !Object.hasOwn(block, 'text')))
	assert.ok(result.evidenceGraph.nodes.every((node) =>
		node.evidenceRefs.every((ref) => ref.quoteDigest && !Object.hasOwn(ref, 'quote'))
	))
})

test('a critical value without a deterministic source match remains unknown and blocks publication', () => {
	const facts = finalizedFacts()
	facts.credit_card_details[0].used_limit = 9999
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: SOURCE,
		evidenceContext: verifiedContext(facts)
	})
	const usedFact = result.factLedger.facts.find((fact) => fact.entityKind === 'card' && fact.field === 'used_limit')

	assert.equal(usedFact.status, FACT_STATUS.UNKNOWN)
	assert.equal(result.status, 'blocked')
	assert.equal(result.evidenceGraph.coverage.complete, false)
	assert.throws(
		() => assertPublicationGate(result),
		(error) => error?.code === 'EVIDENCE_PUBLICATION_BLOCKED' && error.failedChecks.includes('EVIDENCE_COMPLETE')
	)
})

test('distinct official card records remain singleton facilities without an explicit source relation', () => {
	const source = `【第1页】
个人信用报告 报告日期：2026年6月30日
同一银行 2025年1月1日 尾号1234 人民币 授信额度：20,000元 已用额度：5,000元
同一银行 2025年1月1日 尾号5678 人民币 授信额度：30,000元 已用额度：6,000元`
	const facts = finalizedFacts({
		loan_details: { bank_loans: [], non_bank_loans: [] },
		credit_card_details: [
			{ institution: '同一银行', start_date: '2025-01-01', card_tail: '1234', currency: 'CNY', credit_limit: 20000, used_limit: 5000 },
			{ institution: '同一银行', start_date: '2025-01-01', card_tail: '5678', currency: 'CNY', credit_limit: 30000, used_limit: 6000 }
		],
		query_analysis: { query_details: [] }
	})
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: source,
		evidenceContext: verifiedContext(facts, {
			active_loans: 0,
			credit_card_details: 2,
			query_details: 0
		})
	})

	assert.equal(result.factLedger.relations.length, 0)
	assert.equal(result.factLedger.conflicts.length, 0)
	assert.equal(result.factLedger.status, 'ready')
	assert.equal(result.derivedAnalysis.status, 'validated')
	assert.equal(result.publicationGate.publishable, true)
	assert.equal(result.derivedAnalysis.metrics.cardUtilization.facilityTrace.length, 2)
	assert.ok(result.derivedAnalysis.metrics.cardUtilization.facilityTrace.every(
		(facility) => facility.policy === 'single-account-v1' && facility.inputRelationIds.length === 0
	))
})

test('a four-digit tail collision across distinct official card records is never treated as a facility relation', () => {
	const source = `【第1页】
个人信用报告 报告日期：2026年6月30日
甲银行 2025年1月1日 尾号1234 人民币 授信额度：20,000元 已用额度：5,000元
乙银行 2025年2月2日 尾号1234 人民币 授信额度：30,000元 已用额度：6,000元`
	const facts = finalizedFacts({
		loan_details: { bank_loans: [], non_bank_loans: [] },
		credit_card_details: [
			{ institution: '甲银行', start_date: '2025-01-01', card_tail: '1234', currency: 'CNY', credit_limit: 20000, used_limit: 5000 },
			{ institution: '乙银行', start_date: '2025-02-02', card_tail: '1234', currency: 'CNY', credit_limit: 30000, used_limit: 6000 }
		],
		query_analysis: { query_details: [] }
	})
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: source,
		evidenceContext: verifiedContext(facts, {
			active_loans: 0,
			credit_card_details: 2,
			query_details: 0
		})
	})

	assert.equal(result.factLedger.relations.length, 0)
	assert.equal(result.factLedger.conflicts.length, 0)
	assert.equal(result.publicationGate.publishable, true)
	assert.equal(result.derivedAnalysis.metrics.cardUtilization.facilityTrace.length, 2)
})

test('a foreign-currency companion cannot block or inflate the CNY facility', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[
			{ text: '1. 2025年3月3日丙银行发放的贷记卡，人民币，授信额度：30,000元，已使用额度：15,000元。', bbox: [20, 100, 550, 118] },
			{ text: '2. 2025年3月3日丙银行发放的贷记卡，美元，授信额度：2,000元，已使用额度：500元。', bbox: [20, 140, 550, 158] }
		]
	])
	const facts = isolatedFacts({
		cards: [
			{ institution: '丙银行', start_date: '2025-03-03', currency: 'CNY', credit_limit: 30000, used_limit: 15000 },
			{ institution: '丙银行', start_date: '2025-03-03', currency: 'USD', credit_limit: 2000, used_limit: 500 }
		]
	})
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: fixture.sourceText,
		evidenceContext: {
			...verifiedContext(facts, {
				active_loans: 0,
				credit_card_details: 2,
				query_details: 0
			}),
			documentMeta: fixture.documentMeta
		},
		hashFn: TEST_HASH_FN,
		requirePublishable: true
	})

	assert.equal(result.publicationGate.publishable, true)
	assert.equal(result.factLedger.conflicts.length, 0)
	assert.equal(result.derivedAnalysis.metrics.cardUtilization.denominator.minor, 3000000)
	assert.equal(result.derivedAnalysis.metrics.cardUtilization.numerator.minor, 1500000)
})

test('a USD card preserves money currency and cannot create a CNY installment deduction', () => {
	const source = `【第1页】
个人信用报告 报告日期：2026年6月30日
1. 2025年3月3日丙银行发放的贷记卡（尾号4321），美元，信用额度：10,000元，已用额度5,000元，未出单大额专项分期余额5,000元。`
	const facts = isolatedFacts({
		cards: [{
			institution: '丙银行',
			start_date: '2025-03-03',
			card_tail: '4321',
			currency: 'USD',
			credit_limit: 10000,
			used_limit: 5000,
			installment: 5000
		}],
		score: 100
	})
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: source,
		evidenceContext: verifiedContext(facts, {
			active_loans: 0,
			credit_card_details: 1,
			query_details: 0
		}),
		hashFn: TEST_HASH_FN
	})
	const moneyFacts = result.factLedger.facts.filter((fact) =>
		fact.entityKind === 'card' && ['credit_limit', 'used_limit', 'installment'].includes(fact.field)
	)

	assert.equal(result.publicationGate.publishable, true)
	assert.deepEqual(moneyFacts.map((fact) => [fact.field, fact.value.currency]), [
		['credit_limit', 'USD'],
		['installment', 'USD'],
		['used_limit', 'USD']
	])
	assert.equal(result.derivedAnalysis.metrics.cardOutstanding.value.minor, 0)
	assert.equal(result.derivedAnalysis.metrics.totalDebt.value.minor, 0)
	assert.equal(result.derivedAnalysis.metrics.primaryScore.inputMetrics.bigInstallment.minor, 0)
	assert.equal(result.derivedAnalysis.metrics.primaryScore.inputMetrics.hasBigInstallment, false)
	assert.equal(result.derivedAnalysis.metrics.primaryScore.deductionTrace.some((item) =>
		item.ruleId === 'CARD_BIG_INSTALLMENT'
	), false)
})

test('the deterministic service excludes a USD installment from CNY score and risk outputs', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[{
			text: '1. 2025年3月3日丙银行发放的贷记卡（尾号4321），美元，信用额度：100,000元，已用额度5,000元，未出单大额专项分期余额60,000元。',
			bbox: [20, 100, 590, 118]
		}]
	])
	const result = finalizeExtractedCreditFacts(extractedCardFacts([{
		institution: '丙银行',
		start_date: '2025-03-03',
		card_tail: '4321',
		currency: 'USD',
		credit_limit: 100000,
		used_limit: 5000,
		installment: 60000,
		status: '正常'
	}]), fixture.sourceText, {
		evidenceRequired: true,
		documentId: `doc_v2_${'1'.repeat(64)}`,
		evidenceContext: fixture.documentMeta,
		sourceVerifiedCounts: {
			active_loans: sourceCount(0),
			credit_card_details: sourceCount(1),
			query_details: sourceCount(0)
		}
	})

	assert.equal(result.credit_debt.credit_cards.large_installment, 0)
	assert.equal(result.primary_rule_score.score, 100)
	assert.equal(result.primary_rule_score.deductions.some((item) =>
		item.code === 'CARD_BIG_INSTALLMENT'
	), false)
	assert.equal(result.risk_analysis.risk_hits.some((item) =>
		item.rule_name === 'CARD_LARGE_INSTALLMENT'
	), false)
	assert.equal(result.evidence_v2.publicationGate.publishable, true)
	assert.equal(result.evidence_v2.derivedAnalysis.metrics.primaryScore.formulaId, 'primary-score-deterministic-v3')
	assert.equal(result.score_basis.version, 'primary-rule-v3')
	assert.equal(result.derivation_meta.rules_version, 'credit-rules-deterministic-v3')
})

test('missing, invalid, or conflicting card currency cannot manufacture CNY money facts', () => {
	const source = `【第1页】
个人信用报告 报告日期：2026年6月30日
1. 2025年3月3日丙银行发放的贷记卡（尾号4321），人民币，信用额度：10,000元，已用额度5,000元，未出单大额专项分期余额1,000元。`
	const cases = [
		{ name: 'missing' },
		{ name: 'combined-code', currency: 'CNY/USD' },
		{ name: 'object', currency: {} },
		{ name: 'array', currency: ['CNY'] },
		{ name: 'number', currency: 156 },
		{ name: 'conflict', currency: 'CNY', currency_code: 'USD' }
	]
	for (const item of cases) {
		const result = buildEvidenceFirstCreditAnalysis({
			sourceText: source,
			evidenceContext: verifiedContext(isolatedFacts({
				cards: [{
					institution: '丙银行',
					start_date: '2025-03-03',
					card_tail: '4321',
					...(Object.hasOwn(item, 'currency') ? { currency: item.currency } : {}),
					...(Object.hasOwn(item, 'currency_code') ? { currency_code: item.currency_code } : {}),
					credit_limit: 10000,
					used_limit: 5000,
					installment: 1000
				}],
				score: 100
			}), {
				active_loans: 0,
				credit_card_details: 1,
				query_details: 0
			})
		})
		const cardFacts = result.factLedger.facts.filter((fact) => fact.entityKind === 'card')
		assert.equal(result.publicationGate.publishable, false, item.name)
		assert.equal(result.derivedAnalysis.status, 'blocked', item.name)
		assert.equal(cardFacts.some((fact) =>
			['credit_limit', 'used_limit', 'installment'].includes(fact.field) &&
			fact.status === FACT_STATUS.ACCEPTED
		), false, item.name)
		assert.equal(cardFacts.some((fact) => fact.value?.currency === 'CNY'), false, item.name)
	}
})

test('a non-empty invalid or conflicting loan currency never falls back to CNY', () => {
	const source = `【第1页】
个人信用报告 报告日期：2026年6月30日
甲银行 人民币 贷款余额：10,000元`
	for (const item of [
		{ name: 'invalid', currency: 'CNY/USD' },
		{ name: 'object', currency: {} },
		{ name: 'conflict', currency: 'CNY', currency_code: 'USD' }
	]) {
		const result = buildEvidenceFirstCreditAnalysis({
			sourceText: source,
			evidenceContext: verifiedContext(isolatedFacts({
				loans: [{ institution: '甲银行', balance: 10000, ...item }]
			}), {
				active_loans: 1,
				credit_card_details: 0,
				query_details: 0
			})
		})
		const balance = result.factLedger.facts.find((fact) =>
			fact.entityKind === 'loan' && fact.field === 'balance'
		)
		assert.equal(balance.status, FACT_STATUS.UNKNOWN, item.name)
		assert.notEqual(balance.value?.currency, 'CNY', item.name)
		assert.equal(result.publicationGate.publishable, false, item.name)
	}
})

test('card source currency must be one controlled assertion, never a model-selected mixed value', () => {
	const cases = [
		{ name: 'cny-usd-cny-model', sourceCurrency: '人民币、美元', modelCurrency: 'CNY', publishable: false },
		{ name: 'cny-usd-usd-model', sourceCurrency: '人民币、美元', modelCurrency: 'USD', publishable: false },
		{ name: 'usd-cny', sourceCurrency: '美元、人民币', modelCurrency: 'USD', publishable: false },
		{ name: 'repeated-fields', sourceCurrency: '币种：人民币，币种：美元', modelCurrency: 'CNY', publishable: false },
		{ name: 'slash-field', sourceCurrency: '币种：CNY/USD', modelCurrency: 'CNY', publishable: false },
		{ name: 'single-cny', sourceCurrency: '人民币', modelCurrency: 'CNY', publishable: true },
		{ name: 'single-usd', sourceCurrency: '美元', modelCurrency: 'USD', publishable: true },
		{ name: 'usd-issuer-collision', institution: '美元银行', sourceCurrency: '', modelCurrency: 'USD', publishable: false },
		{ name: 'cny-issuer-collision', institution: '人民币银行', sourceCurrency: '', modelCurrency: 'CNY', publishable: false }
	]
	for (const item of cases) {
		const institution = item.institution || '丙银行'
		const currencyClause = item.sourceCurrency ? `，${item.sourceCurrency}` : ''
		const source = `【第1页】\n个人信用报告 报告日期：2026年6月30日\n1. 2025年3月3日${institution}发放的贷记卡（尾号4321）${currencyClause}，信用额度：10,000元，已用额度5,000元。`
		const result = buildEvidenceFirstCreditAnalysis({
			sourceText: source,
			evidenceContext: verifiedContext(isolatedFacts({
				cards: [{
					institution, start_date: '2025-03-03', card_tail: '4321',
					currency: item.modelCurrency, credit_limit: 10000, used_limit: 5000
				}],
				score: 100
			}), {
				active_loans: 0,
				credit_card_details: 1,
				query_details: 0
			})
		})
		assert.equal(result.publicationGate.publishable, item.publishable, item.name)
		if (!item.publishable) assert.equal(result.factLedger.facts.some((fact) =>
			fact.entityKind === 'card' &&
			['credit_limit', 'used_limit'].includes(fact.field) &&
			fact.status === FACT_STATUS.ACCEPTED
		), false, item.name)
	}
})

test('an adjacent bare foreign-currency block conflicts with a CNY card owner', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[{
			text: '1. 2025年3月3日丙银行发放的贷记卡（尾号4321），人民币，信用额度：10,000元，已用额度5,000元。',
			bbox: [20, 100, 590, 118]
		}],
		[{ text: '美元', bbox: [20, 120, 80, 138] }]
	])
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: fixture.sourceText,
		evidenceContext: {
			...verifiedContext(isolatedFacts({ cards: [{
				institution: '丙银行', start_date: '2025-03-03', card_tail: '4321',
				currency: 'CNY', credit_limit: 10000, used_limit: 5000
			}] }), {
				active_loans: 0,
				credit_card_details: 1,
				query_details: 0
			}),
			documentMeta: fixture.documentMeta
		}
	})
	assert.equal(result.publicationGate.publishable, false)
	assert.equal(result.factLedger.facts.some((fact) =>
		fact.entityKind === 'card' &&
		['credit_limit', 'used_limit'].includes(fact.field) &&
		fact.status === FACT_STATUS.ACCEPTED
	), false)
})

test('one bare currency signal can never be shared by multiple card source owners', () => {
	for (const [name, specs] of [
		['vertical-sandwich', [
			{ text: '1. 2025年3月3日甲银行发放的贷记卡（尾号1111），信用额度：10,000元，已用额度1,000元。', bbox: [20, 100, 590, 118] },
			{ text: '人民币', bbox: [20, 120, 100, 138] },
			{ text: '2. 2025年4月4日乙银行发放的贷记卡（尾号2222），信用额度：20,000元，已用额度2,000元。', bbox: [20, 140, 590, 158] }
		]],
		['same-row-multiple-owners', [
			{ text: '1. 2025年3月3日甲银行发放的贷记卡（尾号1111），信用额度：10,000元，已用额度1,000元。', bbox: [20, 100, 275, 118] },
			{ text: '2. 2025年4月4日乙银行发放的贷记卡（尾号2222），信用额度：20,000元，已用额度2,000元。', bbox: [300, 100, 590, 118] },
			{ text: '人民币', bbox: [250, 100, 350, 118] }
		]]
	]) {
		const fixture = structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			...specs.map((spec) => [spec])
		])
		const result = buildEvidenceFirstCreditAnalysis({
			sourceText: fixture.sourceText,
			evidenceContext: {
				...verifiedContext(isolatedFacts({ cards: [
					{ institution: '甲银行', start_date: '2025-03-03', card_tail: '1111', currency: 'CNY', credit_limit: 10000, used_limit: 1000 },
					{ institution: '乙银行', start_date: '2025-04-04', card_tail: '2222', currency: 'CNY', credit_limit: 20000, used_limit: 2000 }
				] }), {
					active_loans: 0,
					credit_card_details: 2,
					query_details: 0
				}),
				documentMeta: fixture.documentMeta
			}
		})
		assert.equal(result.publicationGate.publishable, false, name)
		assert.equal(result.evidenceGraph.unresolved.some((item) =>
			item.reason === 'AMBIGUOUS_SOURCE_CARD_CURRENCY_SIGNAL'
		), true, name)
		assert.equal(result.evidenceGraph.nodes.filter((node) =>
			node.entityKind === 'card' && node.field === 'currency'
		).length, 0, name)
	}
})

test('one card currency signal cannot satisfy duplicate model owners', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[{ text: '1. 2025年3月3日甲银行发放的贷记卡（尾号1111），信用额度：10,000元，已用额度1,000元。', bbox: [20, 100, 590, 118] }],
		[{ text: '人民币', bbox: [20, 120, 100, 138] }]
	])
	const duplicate = { institution: '甲银行', start_date: '2025-03-03', card_tail: '1111', currency: 'CNY', credit_limit: 10000, used_limit: 1000 }
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: fixture.sourceText,
		evidenceContext: {
			...verifiedContext(isolatedFacts({ cards: [{ ...duplicate }, { ...duplicate }] }), {
				active_loans: 0,
				credit_card_details: 2,
				query_details: 0
			}),
			documentMeta: fixture.documentMeta
		}
	})
	assert.equal(result.publicationGate.publishable, false)
	assert.equal(result.evidenceGraph.nodes.filter((node) =>
		node.entityKind === 'card' && node.field === 'currency'
	).length, 0)
})

test('a bare currency note unrelated to every card owner is not card evidence', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[{ text: '1. 2025年3月3日甲银行发放的贷记卡（尾号1111），人民币，信用额度：10,000元，已用额度1,000元。', bbox: [20, 100, 590, 118] }],
		[{ text: '美元', bbox: [400, 400, 470, 418] }]
	])
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: fixture.sourceText,
		evidenceContext: {
			...verifiedContext(isolatedFacts({ cards: [{
				institution: '甲银行', start_date: '2025-03-03', card_tail: '1111',
				currency: 'CNY', credit_limit: 10000, used_limit: 1000
			}] }), {
				active_loans: 0,
				credit_card_details: 1,
				query_details: 0
			}),
			documentMeta: fixture.documentMeta
		}
	})
	assert.equal(result.publicationGate.publishable, true)
	assert.equal(result.evidenceGraph.unresolved.some((item) =>
		item.reason === 'AMBIGUOUS_SOURCE_CARD_CURRENCY_SIGNAL'
	), false)
})

test('not-activated card lifecycle: proven state publishes as supported, one-sided claims stay fail-closed', () => {
	// PRD-DECISION-001：模型声明 + 源行证据同时成立时，未激活是受支持闭集状态：
	// 计入账户数、货币/额度事实为 NOT_APPLICABLE、排除在使用率/负债之外。
	// 任何单边主张（仅模型说、或仅源行显示）仍以 UNSUPPORTED_CARD_ACTIVATION_STATE 失败关闭。
	const cases = [
		{ name: 'source-and-model-inactive-zero', sourceStatus: '截至2026年6月尚未激活', modelStatus: '尚未激活', blocked: false, inactiveSupported: true },
		{ name: 'source-inactive-model-normal', sourceStatus: '截至2026年6月尚未激活', modelStatus: '正常', blocked: true },
		{ name: 'model-inactive-source-normal', sourceStatus: '正常', modelStatus: '尚未激活', blocked: true },
		{ name: 'inactive-without-money', sourceStatus: '截至2026年6月尚未激活', modelStatus: '尚未激活', omitMoney: true, blocked: false, inactiveSupported: true },
		{ name: 'model-inactive-spaced-status', sourceStatus: '截至2026年6月尚未激活', modelStatus: '尚未 激活。', blocked: false, inactiveSupported: true },
		{ name: 'model-inactive-identity-mismatch', sourceStatus: '截至2026年6月尚未激活', modelStatus: '尚未激活', modelTail: '9999', blocked: true },
		{ name: 'negated-phrase', sourceStatus: '不是未激活', modelStatus: '正常', blocked: false },
		{ name: 'institution-collision', institution: '尚未激活银行', sourceStatus: '正常', modelStatus: '正常', blocked: false },
		{ name: 'free-text-collision', sourceStatus: '备注：尚未激活', modelStatus: '正常', blocked: false }
	]
	for (const item of cases) {
		const institution = item.institution || '甲银行'
		const money = item.omitMoney ? '' : '，信用额度：0元，已用额度0元'
		const source = `【第1页】\n个人信用报告 报告日期：2026年6月30日\n1. 2025年3月3日${institution}发放的贷记卡（尾号1111），${item.sourceStatus}，人民币${money}。`
		const result = buildEvidenceFirstCreditAnalysis({
			sourceText: source,
			evidenceContext: verifiedContext(isolatedFacts({
				cards: [{
					institution, start_date: '2025-03-03', card_tail: item.modelTail || '1111',
					status: item.modelStatus, currency: 'CNY', credit_limit: 0, used_limit: 0
				}]
			}), {
				active_loans: 0,
				credit_card_details: 1,
				query_details: 0
			})
		})
		assert.equal(result.publicationGate.publishable, !item.blocked, item.name)
		assert.equal(result.evidenceGraph.unresolved.some((entry) =>
			entry.reason === 'UNSUPPORTED_CARD_ACTIVATION_STATE'
		), item.blocked, item.name)
		if (item.blocked) {
			assert.equal(result.factLedger.sections.find((section) =>
				section.name === 'credit_card_details'
			)?.acceptedEntityCount, 0, item.name)
			assert.equal(result.derivedAnalysis.metrics.primaryScore.status, 'blocked', item.name)
			continue
		}
		if (!item.inactiveSupported) continue
		const activationFact = result.factLedger.facts.find((fact) =>
			fact.entityKind === 'card' && fact.field === 'activation_state'
		)
		assert.equal(activationFact?.status, FACT_STATUS.ACCEPTED, item.name)
		assert.equal(activationFact?.critical, true, item.name)
		assert.deepEqual(activationFact?.value, { type: 'card-state', state: 'not_activated' }, item.name)
		assert.ok(activationFact.evidenceNodeIds.length > 0, item.name)
		for (const field of ['credit_limit', 'used_limit', 'currency', 'installment']) {
			const fact = result.factLedger.facts.find((entry) =>
				entry.entityKind === 'card' && entry.field === field
			)
			assert.equal(fact?.status, FACT_STATUS.NOT_APPLICABLE, `${item.name}:${field}`)
			assert.equal(fact?.reason, 'CARD_NOT_ACTIVATED', `${item.name}:${field}`)
			assert.equal(fact?.critical, false, `${item.name}:${field}`)
		}
		const section = result.factLedger.sections.find((entry) => entry.name === 'credit_card_details')
		assert.equal(section?.acceptedEntityCount, 1, item.name)
		assert.equal(section?.status, 'complete', item.name)
		const utilization = result.derivedAnalysis.metrics.cardUtilization
		assert.equal(utilization.status, FACT_STATUS.NOT_APPLICABLE, item.name)
		assert.deepEqual(utilization.exclusions, [{
			entityId: activationFact.entityId,
			reason: 'CARD_NOT_ACTIVATED'
		}], item.name)
		assert.equal(result.derivedAnalysis.metrics.cardOutstanding.value.minor, 0, item.name)
		const primaryScore = result.derivedAnalysis.metrics.primaryScore
		assert.equal(primaryScore.status, 'computed', item.name)
		assert.equal(primaryScore.inputMetrics.totalAccountCount, 1, item.name)
		assert.ok(primaryScore.inputFactIds.includes(activationFact.factId), item.name)
	}
})

test('a proven not-activated card counts as an account but never joins utilization or debt', () => {
	const source = [
		'【第1页】',
		'个人信用报告 报告日期：2026年6月30日',
		'1. 2025年3月3日甲银行发放的贷记卡（尾号1111），截至2026年6月尚未激活，人民币。',
		'2. 2025年4月4日乙银行发放的贷记卡（尾号2222），人民币，信用额度：20,000元，已用额度5,000元。'
	].join('\n')
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: source,
		evidenceContext: verifiedContext(isolatedFacts({
			cards: [
				{ institution: '甲银行', start_date: '2025-03-03', card_tail: '1111', status: '尚未激活', currency: 'CNY', credit_limit: 0, used_limit: 0 },
				{ institution: '乙银行', start_date: '2025-04-04', card_tail: '2222', status: '正常', currency: 'CNY', credit_limit: 20000, used_limit: 5000 }
			]
		}), {
			active_loans: 0,
			credit_card_details: 2,
			query_details: 0
		}),
		hashFn: TEST_HASH_FN,
		requirePublishable: true
	})
	assert.equal(result.publicationGate.publishable, true)
	const activationFact = result.factLedger.facts.find((fact) => fact.field === 'activation_state')
	assert.equal(activationFact?.status, FACT_STATUS.ACCEPTED)
	const utilization = result.derivedAnalysis.metrics.cardUtilization
	assert.equal(utilization.status, 'computed')
	// 使用率只来自已激活卡：5,000 / 20,000 = 25%。
	assert.equal(utilization.value.value, 2500)
	assert.deepEqual(utilization.exclusions, [{
		entityId: activationFact.entityId,
		reason: 'CARD_NOT_ACTIVATED'
	}])
	assert.equal(utilization.facilityTrace.length, 1)
	assert.equal(result.derivedAnalysis.metrics.cardOutstanding.value.minor, 500000)
	const section = result.factLedger.sections.find((entry) => entry.name === 'credit_card_details')
	assert.equal(section?.acceptedEntityCount, 2)
	assert.equal(section?.status, 'complete')
	const primaryScore = result.derivedAnalysis.metrics.primaryScore
	assert.equal(primaryScore.status, 'computed')
	assert.equal(primaryScore.inputMetrics.totalAccountCount, 2)
})

test('negated closed-status phrases keep accounts active instead of silently zeroing balances', () => {
	// 否定盲区回归（report-11 根因）：`未结清`/`未销户` 含有闭户关键词，
	// 修复前会被误判为已关闭——贷款余额被清零后与源行证据冲突，整单
	// 以 ENTITY_SOURCE_ROW_MISMATCH 失败关闭。修复后余额保留并正常出证。
	const source = `【第1页】
个人信用报告 报告日期：2026年6月30日
信息概要
信用卡 | 购房贷款 | 其他贷款 | 其他业务
账户数 | 1 | 0 | 1 | 0
未结清/未销户账户数 | 1 | 0 | 1 | 0
发生过逾期的账户数 | 0 | 0 | 0 | 0
发生过90天以上逾期的账户数 | 0 | 0 | 0 | 0
信贷交易信息明细
甲银行 贷款余额：10,000.00元
乙银行 2025年1月1日 尾号1234 人民币 授信额度：20,000.00元 已用额度：10,000.00元
机构查询记录明细
1 2026年6月1日 丙银行 贷款审批
本人查询记录明细`
	const facts = {
		meta: { report_date: '2026-06-30' },
		basic_info: {},
		loan_details: {
			bank_loans: [{ institution: '甲银行', balance: 10000, status: '未结清' }],
			non_bank_loans: [],
			settled_loans: [],
			historical_overdue_loans: []
		},
		credit_card_details: [{
			institution: '乙银行',
			start_date: '2025-01-01',
			card_tail: '1234',
			currency: 'CNY',
			credit_limit: 20000,
			used_limit: 10000,
			status: '未销户'
		}],
		credit_card_details_cancelled: [],
		query_analysis: {
			query_details: [{ institution: '丙银行', date: '2026-06-01', reason: '贷款审批' }],
			self_queries: []
		},
		overdue_info: { has_overdue: false, total_overdue_accounts: 0, details: [] },
		public_records: { has_record: false, items: [] },
		guarantee_records: { total_amount: 0, items: [] },
		loan_history: { trend_data: [] },
		_coverage: {
			truncated: false,
			counts: Object.fromEntries([
				['bank_loans', 1],
				['non_bank_loans', 0],
				['settled_loans', 0],
				['historical_overdue_loans', 0],
				['credit_card_details', 1],
				['credit_card_details_cancelled', 0],
				['query_details', 1],
				['self_queries', 0],
				['overdue_details', 0],
				['public_records', 0],
				['guarantee_records', 0],
				['loan_history', 0]
			].map(([name, total]) => [name, { total, listed: total }]))
		}
	}
	const result = finalizeExtractedCreditFacts(facts, source, {
		evidenceRequired: true,
		documentId: `doc_v2_${'d'.repeat(64)}`,
		evidenceContext: {
			version: 'test-page-span-v1',
			sourceMode: 'pdf-text',
			expectedPageCount: 1,
			complete: true
		},
		queryEvidence: {
			complete: true,
			query_details_total: 1,
			query_details: [{ seq: 1, institution: '丙银行', date: '2026-06-01', reason: '贷款审批' }]
		}
	})

	assert.equal(result.evidence_v2.status, 'publishable')
	assert.equal(result.loan_details.bank_loans[0].balance, 10000)
	assert.notEqual(result.loan_details.bank_loans[0].is_settled, true)
	assert.equal(result.credit_debt.total_debt, 20000)
	assert.equal(result.credit_debt.credit_cards.usage_rate, 0.5)
	assert.equal(
		result.evidence_v2.derivedAnalysis.metrics.totalLoanBalance.value.minor,
		1000000
	)
	assert.ok(result.evidence_v2.factLedger.facts.some((fact) =>
		fact.entityKind === 'loan' &&
		fact.field === 'balance' &&
		fact.status === FACT_STATUS.ACCEPTED &&
		fact.value?.minor === 1000000
	))
})

test('loan source currency must be unique while issuer-name text is never currency evidence', () => {
	const cases = [
		{ name: 'cny-usd', institution: '甲银行', sourceCurrency: '人民币、美元', modelCurrency: 'CNY', publishable: false },
		{ name: 'usd-cny', institution: '甲银行', sourceCurrency: '美元、人民币', modelCurrency: 'USD', publishable: false },
		{ name: 'repeated-fields', institution: '甲银行', sourceCurrency: '币种：人民币 币种：美元', modelCurrency: 'CNY', publishable: false },
		{ name: 'single-cny', institution: '甲银行', sourceCurrency: '人民币', modelCurrency: 'CNY', publishable: true },
		{ name: 'single-usd', institution: '甲银行', sourceCurrency: '美元', modelCurrency: 'USD', publishable: true },
		{ name: 'usd-issuer-collision', institution: '美元银行', sourceCurrency: '', modelCurrency: 'USD', publishable: false },
		{ name: 'cny-issuer-collision', institution: '人民币银行', sourceCurrency: '', modelCurrency: 'CNY', publishable: false }
	]
	for (const item of cases) {
		const source = `【第1页】\n个人信用报告 报告日期：2026年6月30日\n${item.institution} ${item.sourceCurrency} 贷款余额：10,000元`
		const result = buildEvidenceFirstCreditAnalysis({
			sourceText: source,
			evidenceContext: verifiedContext(isolatedFacts({
				loans: [{ institution: item.institution, currency: item.modelCurrency, balance: 10000 }]
			}), {
				active_loans: 1,
				credit_card_details: 0,
				query_details: 0
			})
		})
		assert.equal(result.publicationGate.publishable, item.publishable, item.name)
	}

	const implicitDomestic = buildEvidenceFirstCreditAnalysis({
		sourceText: '【第1页】\n个人信用报告 报告日期：2026年6月30日\n人民币银行 贷款余额：10,000元',
		evidenceContext: verifiedContext(isolatedFacts({
			loans: [{ institution: '人民币银行', balance: 10000 }]
		}), {
			active_loans: 1,
			credit_card_details: 0,
			query_details: 0
		})
	})
	assert.equal(implicitDomestic.publicationGate.publishable, true)
	assert.equal(implicitDomestic.factLedger.facts.some((fact) =>
		fact.entityKind === 'loan' && fact.field === 'currency'
	), false)
	assert.equal(implicitDomestic.factLedger.facts.find((fact) =>
		fact.entityKind === 'loan' && fact.field === 'balance'
	)?.value.currency, 'CNY')
})

test('source-proved shared facility is accepted and counted once by max limit and used amount', () => {
	const source = `【第1页】
个人信用报告 报告日期：2026年6月30日
同一银行 2025年1月1日 尾号1234 人民币 共享额度组：G1 授信额度：20,000元 已用额度：10,000元
同一银行 2025年2月1日 尾号5678 人民币 共享额度组：G1 授信额度：20,000元 已用额度：8,000元`
	const facts = finalizedFacts({
		loan_details: { bank_loans: [], non_bank_loans: [] },
		credit_card_details: [
			{ institution: '同一银行', start_date: '2025-01-01', card_tail: '1234', currency: 'CNY', shared_credit_group: 'G1', credit_limit: 20000, used_limit: 10000 },
			{ institution: '同一银行', start_date: '2025-02-01', card_tail: '5678', currency: 'CNY', shared_credit_group: 'G1', credit_limit: 20000, used_limit: 8000 }
		],
		query_analysis: { query_details: [] }
	})
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: source,
		evidenceContext: verifiedContext(facts, {
			active_loans: 0,
			credit_card_details: 2,
			query_details: 0
		})
	})

	assert.equal(result.factLedger.relations.length, 1)
	assert.equal(result.factLedger.relations[0].status, 'accepted')
	assert.equal(result.factLedger.conflicts.length, 0)
	assert.equal(result.publicationGate.publishable, true)
	assert.equal(result.derivedAnalysis.metrics.cardUtilization.denominator.minor, 2000000)
	assert.equal(result.derivedAnalysis.metrics.cardUtilization.numerator.minor, 1000000)
	assert.equal(result.derivedAnalysis.metrics.cardUtilization.value.value, 5000)
	assert.equal(result.derivedAnalysis.metrics.cardUtilization.facilityTrace.length, 1)
	assert.equal(result.derivedAnalysis.metrics.cardUtilization.facilityTrace[0].memberEntityIds.length, 2)
})

test('legacy finalizer output is accepted without mutation but cannot publish without source-verified section counts', () => {
	const facts = finalizedFacts()
	const before = stableCanonicalize(facts)
	const result = fromFinalizedCreditFacts(SOURCE, facts)

	assert.equal(stableCanonicalize(facts), before)
	assert.equal(result.status, 'blocked')
	assert.deepEqual(
		result.factLedger.gate.incompleteSections,
		['active_loans', 'credit_card_details', 'query_details']
	)
	assert.equal(result.factLedger.gate.status, 'blocked')
})

test('fact ledger preserves accepted, unknown, absent, not_applicable, and conflict as distinct states', () => {
	const foreignSource = `【第1页】
个人信用报告 报告日期：2026年6月30日
甲银行 2025年1月1日 尾号1234 美元 授信额度：20,000元 已用额度：0元`
	const foreignFacts = finalizedFacts({
		loan_details: { bank_loans: [], non_bank_loans: [] },
		credit_card_details: [{
			institution: '甲银行',
			start_date: '2025-01-01',
			card_tail: '1234',
			currency: 'USD',
			credit_limit: 20000,
			used_limit: 0
		}],
		query_analysis: { query_details: [] }
	})
	const foreign = buildEvidenceFirstCreditAnalysis({
		sourceText: foreignSource,
		evidenceContext: verifiedContext(foreignFacts, {
			active_loans: 0,
			credit_card_details: 1,
			query_details: 0
		})
	})
	const states = new Set(foreign.factLedger.facts.map((fact) => fact.status))
	const entityIds = new Set(foreign.factLedger.entities.map((entity) => entity.entityId))
	assert.ok(states.has(FACT_STATUS.ACCEPTED))
	assert.ok(states.has(FACT_STATUS.ABSENT))
	assert.ok(states.has(FACT_STATUS.NOT_APPLICABLE))
	assert.ok(foreign.factLedger.facts.every((fact) => entityIds.has(fact.entityId)))

	const unknownFacts = finalizedFacts()
	unknownFacts.credit_card_details[0].used_limit = 9999
	const unknown = buildEvidenceFirstCreditAnalysis({
		sourceText: SOURCE,
		evidenceContext: verifiedContext(unknownFacts)
	})
	assert.ok(unknown.factLedger.facts.some((fact) => fact.status === FACT_STATUS.UNKNOWN))

	const conflictSource = `【第1页】
个人信用报告 报告日期：2026年6月30日
甲银行 2025年1月1日 尾号1234 人民币 授信额度：20,000元 已用额度：5,000元 共享额度组：GROUP-ONLY。`
	const conflictFacts = finalizedFacts({
		loan_details: { bank_loans: [], non_bank_loans: [] },
		credit_card_details: [{
			institution: '甲银行',
			start_date: '2025-01-01',
			card_tail: '1234',
			currency: 'CNY',
			credit_limit: 20000,
			used_limit: 5000,
			shared_credit_group: 'GROUP-ONLY'
		}],
		query_analysis: { query_details: [] }
	})
	const conflict = buildEvidenceFirstCreditAnalysis({
		sourceText: conflictSource,
		evidenceContext: verifiedContext(conflictFacts, {
			active_loans: 0,
			credit_card_details: 1,
			query_details: 0
		})
	})
	assert.ok(conflict.factLedger.facts.some((fact) => fact.status === FACT_STATUS.CONFLICT))
})

test('an explicit zero is accepted only when the source contains the labeled zero value', () => {
	const source = SOURCE.replace('已用额度：10,000.00元', '已用额度：0元')
	const facts = finalizedFacts()
	facts.credit_card_details[0].used_limit = 0
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: source,
		evidenceContext: verifiedContext(facts)
	})
	const usedFact = result.factLedger.facts.find((fact) => fact.entityKind === 'card' && fact.field === 'used_limit')

	assert.equal(usedFact.status, FACT_STATUS.ACCEPTED)
	assert.equal(usedFact.value.minor, 0)
	assert.equal(result.derivedAnalysis.metrics.cardUtilization.value.value, 0)
	assert.equal(result.publicationGate.publishable, true)
})

test('labeled money uses the first complete token and never a numeric substring or trailing tail', () => {
	for (const sourceAmount of [10000, 11000]) {
		for (const expected of [0, 1, 10, 100, 1000]) {
			const formatted = sourceAmount.toLocaleString('en-US')
			const source = `【第1页】\n个人信用报告 报告日期：2026年6月30日\n甲银行 贷款余额：${formatted}元 尾号${expected}`
			const facts = isolatedFacts({
				loans: [{ institution: '甲银行', balance: expected }]
			})
			const result = buildEvidenceFirstCreditAnalysis({
				sourceText: source,
				evidenceContext: verifiedContext(facts, {
					active_loans: 1,
					credit_card_details: 0,
					query_details: 0
				})
			})
			const balance = result.factLedger.facts.find((fact) =>
				fact.entityKind === 'loan' && fact.field === 'balance'
			)

			assert.equal(balance.status, FACT_STATUS.UNKNOWN, `${expected} must not match ${formatted}`)
			assert.equal(result.publicationGate.publishable, false)
		}
	}
})

test('a missing money value cannot borrow the amount from the next labeled field', () => {
	const source = SOURCE.replace(
		'授信额度：20,000.00元 已用额度：10,000.00元',
		'授信额度：未知 已用额度：10,000.00元'
	)
	const facts = finalizedFacts({
		credit_card_details: [{
			institution: '乙银行',
			start_date: '2025-01-01',
			card_tail: '1234',
			currency: 'CNY',
			credit_limit: 10000,
			used_limit: 10000
		}]
	})
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: source,
		evidenceContext: verifiedContext(facts)
	})

	assert.equal(result.factLedger.facts.find((fact) =>
		fact.entityKind === 'card' && fact.field === 'credit_limit'
	)?.status, FACT_STATUS.UNKNOWN)
	assert.equal(result.publicationGate.publishable, false)
})

test('one source row cannot support two declared loan entities', () => {
	const source = `【第1页】\n个人信用报告 报告日期：2026年6月30日\n甲银行 贷款余额：1,000元`
	const duplicate = { institution: '甲银行', balance: 1000 }
	const facts = isolatedFacts({ loans: [{ ...duplicate }, { ...duplicate }] })
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: source,
		evidenceContext: verifiedContext(facts, {
			active_loans: 2,
			credit_card_details: 0,
			query_details: 0
		})
	})
	const balances = result.factLedger.facts.filter((fact) =>
		fact.entityKind === 'loan' && fact.field === 'balance'
	)
	const section = result.factLedger.sections.find((item) => item.name === 'active_loans')

	assert.equal(balances.filter((fact) => fact.status === FACT_STATUS.ACCEPTED).length, 1)
	assert.equal(balances.filter((fact) => fact.status === FACT_STATUS.UNKNOWN).length, 1)
	assert.equal(section.acceptedEntityCount, 1)
	assert.equal(section.expectedCount, 2)
	assert.equal(section.status, 'incomplete')
	assert.ok(result.evidenceGraph.unresolved.some((item) => item.reason === 'SOURCE_ROW_ALREADY_ASSIGNED'))
	assert.equal(result.publicationGate.publishable, false)
})

test('a source-proved foreign-currency loan is excluded from CNY debt', () => {
	const source = `【第1页】
个人信用报告 报告日期：2026年6月30日
甲银行 美元 贷款余额：10,000.00元`
	const facts = isolatedFacts({
		loans: [{ institution: '甲银行', currency: 'USD', balance: 10000 }]
	})
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: source,
		evidenceContext: verifiedContext(facts, {
			active_loans: 1,
			credit_card_details: 0,
			query_details: 0
		}),
		hashFn: TEST_HASH_FN
	})
	const balance = result.factLedger.facts.find((fact) =>
		fact.entityKind === 'loan' && fact.field === 'balance'
	)

	assert.equal(result.publicationGate.publishable, true)
	assert.equal(balance.value.currency, 'USD')
	assert.equal(result.derivedAnalysis.metrics.totalLoanBalance.value.minor, 0)
	assert.equal(result.derivedAnalysis.metrics.totalDebt.value.minor, 0)
})

test('an explicit foreign-currency loan signal omitted by the model blocks publication', () => {
	const source = `【第1页】
个人信用报告 报告日期：2026年6月30日
甲银行 美元 贷款余额：10,000.00元`
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: source,
		evidenceContext: verifiedContext(isolatedFacts({
			loans: [{ institution: '甲银行', balance: 10000 }]
		}), {
			active_loans: 1,
			credit_card_details: 0,
			query_details: 0
		}),
		hashFn: TEST_HASH_FN
	})

	assert.ok(result.evidenceGraph.unresolved.some((item) =>
		item.reason === 'SOURCE_LOAN_CURRENCY_OMITTED' && item.critical === true
	))
	assert.equal(result.publicationGate.publishable, false)
})

test('an interleaved source block cannot hide a geometrically adjacent foreign-currency loan signal', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[{ text: '1. 2025年1月1日甲银行发放个人消费贷款，贷款余额：10,000元。', bbox: [20, 100, 430, 118] }],
		[{ text: '字段说明甲', bbox: [20, 300, 120, 318] }],
		[{ text: '字段说明乙', bbox: [20, 340, 120, 358] }],
		[{ text: '美元', bbox: [20, 120, 80, 138] }]
	])
	const result = analyzeStructuredLoanFixture(fixture, [{
		institution: '甲银行', start_date: '2025-01-01', balance: 10000
	}])

	const balanceNode = result.evidenceGraph.nodes.find((node) =>
		node.entityKind === 'loan' && node.field === 'balance'
	)
	const unresolved = result.evidenceGraph.unresolved.find((item) =>
		item.reason === 'SOURCE_LOAN_CURRENCY_OMITTED'
	)
	assert.equal(unresolved?.entityId, balanceNode?.entityId)
	assert.equal(unresolved?.critical, true)
	assert.equal(result.publicationGate.publishable, false)
})

test('a same-y generic foreign-currency sibling omitted by the model blocks the unique loan record', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[{ text: '1. 2025年1月1日甲银行发放个人消费贷款，贷款余额：10,000元。', bbox: [20, 100, 430, 118] }],
		[{ text: '字段说明', bbox: [20, 300, 120, 318] }],
		[{ text: '外币', bbox: [440, 100, 500, 118] }]
	])
	const result = analyzeStructuredLoanFixture(fixture, [{
		institution: '甲银行', start_date: '2025-01-01', balance: 10000
	}])

	assert.ok(result.evidenceGraph.unresolved.some((item) =>
		item.reason === 'SOURCE_LOAN_CURRENCY_OMITTED' && item.critical === true
	))
	assert.equal(result.publicationGate.publishable, false)
})

test('same-bundle explicit domestic and foreign loan currencies retain deterministic semantics', () => {
	const domesticFixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[{ text: '1. 2025年1月1日甲银行发放个人消费贷款，人民币，贷款余额：10,000元。', bbox: [20, 100, 500, 118] }]
	])
	const domestic = analyzeStructuredLoanFixture(domesticFixture, [{
		institution: '甲银行', start_date: '2025-01-01', balance: 10000
	}])
	assert.equal(domestic.publicationGate.publishable, true)
	assert.equal(domestic.factLedger.facts.find((fact) =>
		fact.entityKind === 'loan' && fact.field === 'balance'
	)?.value.currency, 'CNY')

	const foreignFixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[{ text: '1. 2025年1月1日甲银行发放个人消费贷款，美元，贷款余额：10,000元。', bbox: [20, 100, 500, 118] }]
	])
	const foreign = analyzeStructuredLoanFixture(foreignFixture, [{
		institution: '甲银行', start_date: '2025-01-01', currency: 'USD', balance: 10000
	}])
	assert.equal(foreign.publicationGate.publishable, true)
	assert.equal(foreign.factLedger.facts.find((fact) =>
		fact.entityKind === 'loan' && fact.field === 'balance'
	)?.value.currency, 'USD')
	assert.equal(foreign.derivedAnalysis.metrics.totalLoanBalance.value.minor, 0)

	const omittedForeign = analyzeStructuredLoanFixture(foreignFixture, [{
		institution: '甲银行', start_date: '2025-01-01', balance: 10000
	}])
	assert.equal(omittedForeign.publicationGate.publishable, false)
})

test('a closed official domestic loan remains compatible when neither source nor model spells out currency', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[{ text: '1. 2025年1月1日甲银行发放个人消费贷款，贷款余额：10,000元。', bbox: [20, 100, 500, 118] }]
	])
	const result = analyzeStructuredLoanFixture(fixture, [{
		institution: '甲银行', start_date: '2025-01-01', balance: 10000
	}])

	assert.equal(result.publicationGate.publishable, true)
	assert.equal(result.factLedger.facts.find((fact) =>
		fact.entityKind === 'loan' && fact.field === 'balance'
	)?.value.currency, 'CNY')
})

test('an external foreign-currency signal adjacent to two loans is never guessed onto either record', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[{ text: '1. 2025年1月1日甲银行发放个人消费贷款，贷款余额：10,000元。', bbox: [20, 100, 430, 118] }],
		[{ text: '美元', bbox: [20, 120, 80, 138] }],
		[{ text: '2. 2025年2月2日乙银行发放个人消费贷款，贷款余额：20,000元。', bbox: [20, 140, 430, 158] }]
	])
	const result = analyzeStructuredLoanFixture(fixture, [
		{ institution: '甲银行', start_date: '2025-01-01', balance: 10000 },
		{ institution: '乙银行', start_date: '2025-02-02', balance: 20000 }
	])
	const loanEntityIds = new Set(result.evidenceGraph.nodes
		.filter((node) => node.entityKind === 'loan' && node.field === 'balance')
		.map((node) => node.entityId))
	const unresolved = result.evidenceGraph.unresolved.find((item) =>
		item.reason === 'AMBIGUOUS_SOURCE_LOAN_CURRENCY_SIGNAL'
	)

	assert.equal(unresolved?.critical, true)
	assert.equal(loanEntityIds.has(unresolved?.entityId), false)
	assert.equal(result.publicationGate.publishable, false)
})

test('a foreign-currency signal adjacent to both a loan and card is ambiguous, never assigned to the loan', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[{ text: '1. 2025年1月1日甲银行发放个人消费贷款，贷款余额：10,000元。', bbox: [20, 100, 430, 118] }],
		[{ text: '美元', bbox: [20, 120, 80, 138] }],
		[{
			text: '2. 2025年2月2日乙银行发放贷记卡（尾号4321），信用额度：20,000元，已使用额度：5,000元。',
			bbox: [20, 140, 540, 158]
		}]
	])
	const result = analyzeStructuredLoanFixture(fixture, [{
		institution: '甲银行', start_date: '2025-01-01', balance: 10000
	}])
	const loanEntityId = result.evidenceGraph.nodes.find((node) =>
		node.entityKind === 'loan' && node.field === 'balance'
	)?.entityId
	const ambiguous = result.evidenceGraph.unresolved.find((item) =>
		item.reason === 'AMBIGUOUS_SOURCE_LOAN_CURRENCY_SIGNAL'
	)

	assert.equal(ambiguous?.critical, true)
	assert.notEqual(ambiguous?.entityId, loanEntityId)
	assert.equal(result.evidenceGraph.unresolved.some((item) =>
		item.reason === 'SOURCE_LOAN_CURRENCY_OMITTED'
	), false)
	assert.equal(result.publicationGate.publishable, false)
})

test('two identical legal query rows bind to distinct source rows and count stably', () => {
	const source = `【第1页】
个人信用报告 报告日期：2026年6月30日
甲银行 2026年6月1日 贷款审批
甲银行 2026年6月1日 贷款审批`
	const query = { institution: '甲银行', date: '2026-06-01', reason: '贷款审批' }
	const facts = isolatedFacts({ queries: [{ ...query }, { ...query }] })
	const builds = Array.from({ length: 5 }, () => buildEvidenceFirstCreditAnalysis({
		sourceText: source,
		evidenceContext: verifiedContext(facts, {
			active_loans: 0,
			credit_card_details: 0,
			query_details: 2
		}),
		hashFn: TEST_HASH_FN
	}))
	const result = builds[0]
	const queryDateNodes = result.evidenceGraph.nodes.filter((node) =>
		node.entityKind === 'query' && node.field === 'date'
	)

	assert.equal(result.publicationGate.publishable, true)
	assert.equal(result.factLedger.sections.find((item) => item.name === 'query_details').acceptedEntityCount, 2)
	assert.equal(new Set(queryDateNodes.map((node) => node.entityId)).size, 2)
	assert.equal(new Set(queryDateNodes.map((node) => node.evidenceRefs[0].blockId)).size, 2)
	assert.equal(result.derivedAnalysis.metrics.queryCounts.value.last_1m, 2)
	assert.equal(new Set(builds.map((item) => item.evidenceGraph.evidenceGraphHash)).size, 1)
})

test('source installment signal omitted by the model is a critical unresolved fact', () => {
	const source = SOURCE.replace(
		'已用额度：10,000.00元',
		'已用额度：10,000.00元 分期余额：5,000.00元'
	)
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: source,
		evidenceContext: verifiedContext()
	})
	const installment = result.factLedger.facts.find((fact) =>
		fact.entityKind === 'card' && fact.field === 'installment'
	)

	assert.equal(installment.status, FACT_STATUS.UNKNOWN)
	assert.ok(result.evidenceGraph.unresolved.some((item) =>
		item.critical === true && item.reason === 'SOURCE_VALUE_OMITTED_BY_MODEL'
	))
	assert.equal(result.publicationGate.publishable, false)
})

test('an unclaimed installment signal on a separate source row blocks publication', () => {
	const source = SOURCE.replace(
		'已用额度：10,000.00元',
		'已用额度：10,000.00元\n未出单大额专项分期余额：5,000.00元'
	)
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: source,
		evidenceContext: verifiedContext()
	})

	assert.ok(result.evidenceGraph.unresolved.some((item) =>
		item.critical === true && item.reason === 'UNCLAIMED_SOURCE_INSTALLMENT_SIGNAL'
	))
	assert.equal(result.evidenceGraph.status, 'rejected')
	assert.equal(result.publicationGate.publishable, false)
	assert.notEqual(result.derivedAnalysis.metrics.primaryScore.status, 'computed')
})

test('a correctly extracted adjacent card installment row binds to the same card entity', () => {
	const source = SOURCE.replace(
		'已用额度：10,000.00元',
		'已用额度：10,000.00元\n乙银行 尾号1234 未出单大额专项分期余额：5,000.00元'
	)
	const facts = finalizedFacts({
		credit_card_details: [{
			institution: '乙银行',
			start_date: '2025-01-01',
			card_tail: '1234',
			currency: 'CNY',
			credit_limit: 20000,
			used_limit: 10000,
			installment: 5000
		}],
		primary_rule_score: { score: 76, deductions: [] }
	})
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: source,
		evidenceContext: verifiedContext(facts),
		hashFn: TEST_HASH_FN
	})
	const installment = result.factLedger.facts.find((fact) =>
		fact.entityKind === 'card' && fact.field === 'installment'
	)
	const creditLimit = result.factLedger.facts.find((fact) =>
		fact.entityKind === 'card' && fact.field === 'credit_limit'
	)
	const nodeById = new Map(result.evidenceGraph.nodes.map((node) => [node.nodeId, node]))

	assert.equal(result.publicationGate.publishable, true)
	assert.equal(installment.status, FACT_STATUS.ACCEPTED)
	assert.equal(installment.entityId, creditLimit.entityId)
	assert.equal(
		nodeById.get(installment.evidenceNodeIds[0]).evidenceRefs[0].ordinal,
		nodeById.get(creditLimit.evidenceNodeIds[0]).evidenceRefs[0].ordinal + 1
	)
})

test('an adjacent installment row with a different card tail cannot be bundled', () => {
	const source = SOURCE.replace(
		'已用额度：10,000.00元',
		'已用额度：10,000.00元\n乙银行 尾号9999 未出单大额专项分期余额：5,000.00元'
	)
	const facts = finalizedFacts({
		credit_card_details: [{
			institution: '乙银行',
			start_date: '2025-01-01',
			card_tail: '1234',
			currency: 'CNY',
			credit_limit: 20000,
			used_limit: 10000,
			installment: 5000
		}],
		primary_rule_score: { score: 76, deductions: [] }
	})
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: source,
		evidenceContext: verifiedContext(facts),
		hashFn: TEST_HASH_FN
	})

	assert.equal(result.publicationGate.publishable, false)
	assert.ok(result.evidenceGraph.unresolved.some((item) => item.critical === true))
})

test('an installment heading without a complete money token is not a fact signal', () => {
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: `${SOURCE}\n分期余额说明：本项仅供参考`,
		evidenceContext: verifiedContext()
	})

	assert.equal(result.evidenceGraph.unresolved.some((item) =>
		item.reason === 'UNCLAIMED_SOURCE_INSTALLMENT_SIGNAL'
	), false)
	assert.equal(result.publicationGate.publishable, true)
})

test('a complete card row without installment signal produces an absent scoring input', () => {
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: SOURCE,
		evidenceContext: verifiedContext()
	})
	const installment = result.factLedger.facts.find((fact) =>
		fact.entityKind === 'card' && fact.field === 'installment'
	)

	assert.equal(installment.status, FACT_STATUS.ABSENT)
	assert.equal(installment.reason, 'SOURCE_ROW_NO_INSTALLMENT_SIGNAL')
	assert.ok(result.derivedAnalysis.metrics.primaryScore.inputFactIds.includes(installment.factId))
	assert.equal(result.publicationGate.publishable, true)
})

test('a three-line installment label and delayed value blocks optional absence', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[
			{ text: '1. 2025年3月3日丙银行发放的贷记卡（尾号4321），人民币，授信额度：30,000元，已使用额度：15,000元，未出单大额专项分期余', bbox: [20, 100, 550, 118] },
			{ text: '额：', bbox: [20, 122, 80, 140] },
			{ text: '50,000元。', bbox: [20, 144, 180, 162] }
		]
	])
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: fixture.sourceText,
		evidenceContext: {
			...verifiedContext(isolatedFacts({ cards: [{
				institution: '丙银行', start_date: '2025-03-03', card_tail: '4321',
				currency: 'CNY', credit_limit: 30000, used_limit: 15000
			}] }), { active_loans: 0, credit_card_details: 1, query_details: 0 }),
			documentMeta: fixture.documentMeta
		},
		hashFn: TEST_HASH_FN
	})
	assert.equal(result.publicationGate.publishable, false)
	assert.ok(result.evidenceGraph.unresolved.some((item) =>
		item.reason === 'SOURCE_VALUE_OMITTED_BY_MODEL' ||
		item.reason === 'UNCLAIMED_SOURCE_INSTALLMENT_SIGNAL'
	))
})

test('array permutation preserves target IDs and every artifact hash', () => {
	const source = `【第1页】
个人信用报告 报告日期：2026年6月30日
甲银行 贷款余额：1,000元
乙银行 贷款余额：2,000元
丙银行 2026年6月1日 贷款审批
丁银行 2026年5月1日 信用卡审批`
	const loans = [
		{ institution: '乙银行', balance: 2000 },
		{ institution: '甲银行', balance: 1000 }
	]
	const queries = [
		{ institution: '丁银行', date: '2026-05-01', reason: '信用卡审批' },
		{ institution: '丙银行', date: '2026-06-01', reason: '贷款审批' }
	]
	const build = (loanRows, queryRows) => buildEvidenceFirstCreditAnalysis({
		sourceText: source,
		evidenceContext: verifiedContext(isolatedFacts({ loans: loanRows, queries: queryRows }), {
			active_loans: 2,
			credit_card_details: 0,
			query_details: 2
		}),
		hashFn: TEST_HASH_FN
	})
	const first = build(loans, queries)
	const second = build([...loans].reverse(), [...queries].reverse())

	assert.equal(first.publicationGate.publishable, true)
	assert.equal(second.publicationGate.publishable, true)
	assert.deepEqual(
		first.evidenceGraph.nodes.map((node) => node.targetId),
		second.evidenceGraph.nodes.map((node) => node.targetId)
	)
	assert.deepEqual(
		[
			first.manifest.manifestHash,
			first.evidenceGraph.evidenceGraphHash,
			first.factLedger.factLedgerHash,
			first.derivedAnalysis.derivedAnalysisHash
		],
		[
			second.manifest.manifestHash,
			second.evidenceGraph.evidenceGraphHash,
			second.factLedger.factLedgerHash,
			second.derivedAnalysis.derivedAnalysisHash
		]
	)
})

test('moving identical loans across model transport buckets preserves every evidence hash', () => {
	const source = `【第1页】
个人信用报告 报告日期：2026年6月30日
甲银行 贷款余额：1,000元
乙银行 贷款余额：2,000元`
	const loans = [
		{ institution: '甲银行', balance: 1000 },
		{ institution: '乙银行', balance: 2000 }
	]
	const build = (loanDetails) => buildEvidenceFirstCreditAnalysis({
		sourceText: source,
		evidenceContext: verifiedContext({
			...isolatedFacts({ loans: [] }),
			loan_details: loanDetails
		}, {
			active_loans: 2,
			credit_card_details: 0,
			query_details: 0
		}),
		hashFn: TEST_HASH_FN
	})
	const first = build({ bank_loans: loans, non_bank_loans: [], unknown_loans: [] })
	const second = build({ bank_loans: [], non_bank_loans: [loans[1]], unknown_loans: [loans[0]] })

	assert.equal(first.publicationGate.publishable, true)
	assert.equal(second.publicationGate.publishable, true)
	assert.deepEqual(
		[
			first.evidenceGraph.evidenceGraphHash,
			first.factLedger.factLedgerHash,
			first.derivedAnalysis.derivedAnalysisHash
		],
		[
			second.evidenceGraph.evidenceGraphHash,
			second.factLedger.factLedgerHash,
			second.derivedAnalysis.derivedAnalysisHash
		]
	)
})

test('public evidence blocks contain only accepted references or blocking signals', () => {
	const filler = Array.from({ length: 40 }, (_, index) => `无关说明行-${index}`).join('\n')
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: `${SOURCE}\n${filler}`,
		evidenceContext: verifiedContext()
	})
	const referenced = new Set(result.evidenceGraph.nodes.flatMap((node) =>
		node.evidenceRefs.map((ref) => ref.blockId)
	))
	const signaled = new Set(result.evidenceGraph.unresolved.flatMap((item) => item.signalBlockIds || []))

	assert.ok(result.evidenceGraph.coverage.totalSourceBlockCount > result.evidenceGraph.coverage.retainedBlockCount)
	assert.equal(result.evidenceGraph.coverage.blockCount, result.evidenceGraph.coverage.retainedBlockCount)
	assert.ok(result.evidenceGraph.blocks.every((block) => referenced.has(block.blockId) || signaled.has(block.blockId)))
	assert.equal(result.publicationGate.publishable, true)
})

test('bare integer section counts are never accepted as source verification', () => {
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: SOURCE,
		evidenceContext: {
			facts: finalizedFacts(),
			sourceVerifiedCounts: {
				active_loans: 1,
				credit_card_details: 1,
				query_details: 1
			}
		}
	})

	assert.equal(result.evidenceGraph.status, 'complete')
	assert.deepEqual(result.factLedger.gate.incompleteSections, [
		'active_loans',
		'credit_card_details',
		'query_details'
	])
	assert.equal(result.publicationGate.publishable, false)
})

test('sensitive digests are document-scoped', () => {
	const first = buildEvidenceFirstCreditAnalysis({
		sourceText: SOURCE,
		documentId: 'external-document-a',
		evidenceContext: verifiedContext(),
		hashFn: TEST_HASH_FN
	})
	const second = buildEvidenceFirstCreditAnalysis({
		sourceText: SOURCE,
		documentId: 'external-document-b',
		evidenceContext: verifiedContext(),
		hashFn: TEST_HASH_FN
	})
	const sensitiveDigest = (result) => result.evidenceGraph.nodes.find((node) =>
		node.field === 'institution_identity'
	).value.valueDigest
	const firstEvidenceRef = (result) => result.evidenceGraph.nodes.find((node) =>
		Array.isArray(node.evidenceRefs) && node.evidenceRefs.length > 0
	).evidenceRefs[0]

	assert.notEqual(sensitiveDigest(first), sensitiveDigest(second))
	assert.notEqual(first.manifest.pages[0].textDigest, second.manifest.pages[0].textDigest)
	assert.notEqual(first.evidenceGraph.blocks[0].blockId, second.evidenceGraph.blocks[0].blockId)
	assert.notEqual(first.evidenceGraph.blocks[0].textDigest, second.evidenceGraph.blocks[0].textDigest)
	assert.notEqual(first.evidenceGraph.nodes[0].entityId, second.evidenceGraph.nodes[0].entityId)
	assert.notEqual(firstEvidenceRef(first).quoteDigest, firstEvidenceRef(second).quoteDigest)
	assert.doesNotMatch(JSON.stringify(first), /甲银行|乙银行|丙银行/)
})

test('shared group IDs normalize case, width, and whitespace and protocol labels are accepted', () => {
	const documentId = `doc_v2_${'6'.repeat(64)}`
	const otherDocumentId = `doc_v2_${'7'.repeat(64)}`
	const groupId = buildSourceSharedGroupId('  g1  ', TEST_HASH_FN, documentId)
	assert.match(groupId, /^grp_v2_[a-f0-9]{64}$/)
	assert.equal(groupId, buildSourceSharedGroupId('Ｇ１', TEST_HASH_FN, documentId))
	assert.equal(groupId, buildSourceSharedGroupId(groupId, TEST_HASH_FN, documentId))
	assert.notEqual(groupId, buildSourceSharedGroupId('G1', TEST_HASH_FN, otherDocumentId))
	assert.equal(buildSourceSharedGroupId('G1', TEST_HASH_FN), '')
	for (const sentinel of ['无', '不共享', '未共享', '无共享', '未设置', '不适用', 'N/A']) {
		assert.equal(buildSourceSharedGroupId(sentinel, TEST_HASH_FN, documentId), '', sentinel)
	}
	assert.equal(buildSourceSharedGroupId('共同额度组', TEST_HASH_FN, documentId), '')

	const source = `【第1页】
个人信用报告 报告日期：2026年6月30日
甲银行 2025年1月1日 尾号1234 人民币 授信协议编号：ｇ１ 授信额度：20,000元 已用额度：10,000元
乙银行 2025年2月1日 尾号5678 人民币 信用协议编号：G1 授信额度：20,000元 已用额度：8,000元`
	const cards = [
		{ institution: '甲银行', start_date: '2025-01-01', card_tail: '1234', currency: 'CNY', shared_credit_group: groupId, credit_limit: 20000, used_limit: 10000 },
		{ institution: '乙银行', start_date: '2025-02-01', card_tail: '5678', currency: 'CNY', shared_credit_group: groupId, credit_limit: 20000, used_limit: 8000 }
	]
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: source,
		documentId,
		evidenceContext: verifiedContext(isolatedFacts({ cards }), {
			active_loans: 0,
			credit_card_details: 2,
			query_details: 0
		}),
		hashFn: TEST_HASH_FN
	})

	assert.equal(result.publicationGate.publishable, true)
	assert.equal(result.factLedger.relations.length, 1)
	assert.equal(result.factLedger.relations[0].status, 'accepted')
	assert.equal(result.factLedger.relations[0].basis, 'explicit-source-group')
	assert.equal(result.evidenceGraph.unresolved.some((item) =>
		item.reason === 'UNCLAIMED_SOURCE_SHARED_CREDIT_SIGNAL'
	), false)
})

test('an unclaimed source shared-credit signal blocks even across different institutions and dates', () => {
	const source = `【第1页】
个人信用报告 报告日期：2026年6月30日
甲银行 2025年1月1日 尾号1234 人民币 共享额度：两账户共用 授信额度：20,000元 已用额度：10,000元
乙银行 2025年2月1日 尾号5678 人民币 授信额度：30,000元 已用额度：8,000元`
	const cards = [
		{ institution: '甲银行', start_date: '2025-01-01', card_tail: '1234', currency: 'CNY', credit_limit: 20000, used_limit: 10000 },
		{ institution: '乙银行', start_date: '2025-02-01', card_tail: '5678', currency: 'CNY', credit_limit: 30000, used_limit: 8000 }
	]
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: source,
		evidenceContext: verifiedContext(isolatedFacts({ cards }), {
			active_loans: 0,
			credit_card_details: 2,
			query_details: 0
		})
	})

	assert.equal(result.factLedger.conflicts.length, 0)
	assert.ok(result.evidenceGraph.unresolved.some((item) =>
		item.critical === true && item.reason === 'UNCLAIMED_SOURCE_SHARED_CREDIT_SIGNAL'
	))
	assert.equal(result.evidenceGraph.status, 'rejected')
	assert.equal(result.publicationGate.publishable, false)
})

test('a single accepted shared group member is unresolved and cannot publish', () => {
	const source = `【第1页】
个人信用报告 报告日期：2026年6月30日
甲银行 2025年1月1日 尾号1234 人民币 授信协议编号：G1 授信额度：20,000元 已用额度：10,000元`
	const cards = [{
		institution: '甲银行',
		start_date: '2025-01-01',
		card_tail: '1234',
		currency: 'CNY',
		shared_credit_group: 'G1',
		credit_limit: 20000,
		used_limit: 10000
	}]
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: source,
		evidenceContext: verifiedContext(isolatedFacts({ cards }), {
			active_loans: 0,
			credit_card_details: 1,
			query_details: 0
		})
	})

	assert.ok(result.factLedger.conflicts.some((item) =>
		item.code === 'SINGLE_MEMBER_SHARED_GROUP_UNRESOLVED'
	))
	assert.equal(result.factLedger.status, 'blocked')
	assert.equal(result.publicationGate.publishable, false)
})

test('requirePublishable rejects the unkeyed default artifact hash', () => {
	assert.throws(
		() => buildEvidenceFirstCreditAnalysis({
			sourceText: SOURCE,
			evidenceContext: verifiedContext(),
			requirePublishable: true
		}),
		(error) => error?.code === 'EVIDENCE_HASH_KEY_REQUIRED'
	)
})

test('canonicalization is independent of object key insertion order and rejects unsafe numbers', () => {
	assert.equal(
		stableCanonicalize({ z: 1, a: { y: 2, x: '中文' } }),
		stableCanonicalize({ a: { x: '中文', y: 2 }, z: 1 })
	)
	assert.throws(() => stableCanonicalize({ value: Number.NaN }), /finite numbers/)
	assert.throws(() => stableCanonicalize({ value: -0 }), /negative zero/)
})

test('publication gate recomputes every artifact hash and rejects payload tampering', () => {
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: SOURCE,
		evidenceContext: verifiedContext()
	})
	const tampered = structuredClone(result)
	tampered.derivedAnalysis.metrics.totalDebt.value.minor += 1
	const gate = evaluatePublicationGate(tampered)

	assert.equal(gate.publishable, false)
	assert.ok(gate.failedChecks.includes('HASH_INTEGRITY_VALID'))
	assert.throws(
		() => assertPublicationGate(tampered),
		(error) => error?.code === 'EVIDENCE_PUBLICATION_BLOCKED' &&
			error.failedChecks.includes('HASH_INTEGRITY_VALID')
	)
})

test('legacy finalizer can publish a compatible deterministic result only after the v2 evidence gate passes', () => {
	const source = `【第1页】
个人信用报告 报告日期：2026年6月30日
信息概要
信用卡 | 购房贷款 | 其他贷款 | 其他业务
账户数 | 1 | 0 | 1 | 0
未结清/未销户账户数 | 1 | 0 | 1 | 0
发生过逾期的账户数 | 0 | 0 | 0 | 0
发生过90天以上逾期的账户数 | 0 | 0 | 0 | 0
信贷交易信息明细
甲银行 贷款余额：10,000.00元
乙银行 2025年1月1日 尾号1234 人民币 授信额度：20,000.00元 已用额度：10,000.00元
机构查询记录明细
1 2026年6月1日 丙银行 贷款审批
本人查询记录明细`
	const facts = {
		meta: { report_date: '2026-06-30' },
		basic_info: {},
		loan_details: {
			bank_loans: [{ institution: '甲银行', balance: 10000, status: '正常' }],
			non_bank_loans: [],
			settled_loans: [],
			historical_overdue_loans: []
		},
		credit_card_details: [{
			institution: '乙银行',
			start_date: '2025-01-01',
			card_tail: '1234',
			currency: 'CNY',
			credit_limit: 20000,
			used_limit: 10000,
			status: '正常'
		}],
		credit_card_details_cancelled: [],
		query_analysis: {
			query_details: [{ institution: '丙银行', date: '2026-06-01', reason: '贷款审批' }],
			self_queries: []
		},
		overdue_info: { has_overdue: false, total_overdue_accounts: 0, details: [] },
		public_records: { has_record: false, items: [] },
		guarantee_records: { total_amount: 0, items: [] },
		loan_history: { trend_data: [] },
		_coverage: {
			truncated: false,
			counts: Object.fromEntries([
				['bank_loans', 1],
				['non_bank_loans', 0],
				['settled_loans', 0],
				['historical_overdue_loans', 0],
				['credit_card_details', 1],
				['credit_card_details_cancelled', 0],
				['query_details', 1],
				['self_queries', 0],
				['overdue_details', 0],
				['public_records', 0],
				['guarantee_records', 0],
				['loan_history', 0]
			].map(([name, total]) => [name, { total, listed: total }]))
		}
	}
	const result = finalizeExtractedCreditFacts(facts, source, {
		evidenceRequired: true,
		documentId: `doc_v2_${'a'.repeat(64)}`,
		evidenceContext: {
			version: 'test-page-span-v1',
			sourceMode: 'pdf-text',
			expectedPageCount: 1,
			complete: true
		},
		queryEvidence: {
			complete: true,
			query_details_total: 1,
			query_details: [{ seq: 1, institution: '丙银行', date: '2026-06-01', reason: '贷款审批' }]
		}
	})

	assert.equal(result.derivation_meta.mode, 'deterministic-v1')
	assert.equal(result.derivation_meta.evidence_mode, 'evidence-v2')
	assert.equal(result.evidence_v2.status, 'publishable')
	assert.equal(result.evidence_v2.manifest.documentId, `doc_v2_${'a'.repeat(64)}`)
	assert.equal(result.evidence_v2.publicationGate.status, 'passed')
	assert.equal(result.credit_debt.total_debt, 20000)
	assert.equal(result.credit_debt.credit_cards.usage_rate, 0.5)
	assert.equal(result.evidence_meta.metric_hash, result.evidence_v2.derivedAnalysis.derivedAnalysisHash)
})

test('MuPDF multiline loan record binds its dated identity line to its balance continuation line', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[
			{ text: '1. 2025年1月1日甲银行发放的个人住房贷款，人民币。', bbox: [20, 100, 500, 118] },
			{ text: '截至2026年6月30日，贷款余额：10,000.00元。', bbox: [20, 122, 500, 140] }
		]
	])
	const facts = isolatedFacts({
		loans: [{ institution: '甲银行', start_date: '2025-01-01', balance: 10000 }]
	})
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: fixture.sourceText,
		evidenceContext: {
			...verifiedContext(facts, {
				active_loans: 1,
				credit_card_details: 0,
				query_details: 0
			}),
			documentMeta: fixture.documentMeta
		},
		hashFn: TEST_HASH_FN,
		requirePublishable: true
	})
	const loanNodes = result.evidenceGraph.nodes.filter((node) => node.entityKind === 'loan')
	const balanceNode = loanNodes.find((node) => node.field === 'balance')
	const institutionNode = loanNodes.find((node) => node.field === 'institution_identity')

	assert.equal(result.publicationGate.publishable, true)
	assert.equal(balanceNode.evidenceRefs[0].span.offset > institutionNode.evidenceRefs[0].span.offset, true)
	assert.equal(new Set(loanNodes.map((node) => node.recordBindingId)).size, 1)
})

test('two accounts in one MuPDF parent block remain separate and cannot exchange balances', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[
			{ text: '1. 2025年1月1日甲银行发放的个人消费贷款，人民币。', bbox: [20, 100, 500, 118] },
			{ text: '截至2026年6月30日，贷款余额：10,000.00元。', bbox: [20, 122, 500, 140] },
			{ text: '2. 2025年2月2日乙银行发放的个人消费贷款，人民币。', bbox: [20, 160, 500, 178] },
			{ text: '截至2026年6月30日，贷款余额：20,000.00元。', bbox: [20, 182, 500, 200] }
		]
	])
	const build = (loans) => buildEvidenceFirstCreditAnalysis({
		sourceText: fixture.sourceText,
		evidenceContext: {
			...verifiedContext(isolatedFacts({ loans }), {
				active_loans: 2,
				credit_card_details: 0,
				query_details: 0
			}),
			documentMeta: fixture.documentMeta
		},
		hashFn: TEST_HASH_FN
	})
	const correct = build([
		{ institution: '甲银行', start_date: '2025-01-01', balance: 10000 },
		{ institution: '乙银行', start_date: '2025-02-02', balance: 20000 }
	])
	const swapped = build([
		{ institution: '甲银行', start_date: '2025-01-01', balance: 20000 },
		{ institution: '乙银行', start_date: '2025-02-02', balance: 10000 }
	])
	const correctLoanNodes = correct.evidenceGraph.nodes.filter((node) => node.entityKind === 'loan')
	const swappedBalances = swapped.factLedger.facts.filter((fact) =>
		fact.entityKind === 'loan' && fact.field === 'balance'
	)

	assert.equal(correct.publicationGate.publishable, true)
	assert.equal(new Set(correctLoanNodes.map((node) => node.recordBindingId)).size, 2)
	assert.equal(swapped.publicationGate.publishable, false)
	assert.equal(swappedBalances.every((fact) => fact.status === FACT_STATUS.UNKNOWN), true)
})

test('an unknown account-origination phrase truncates the preceding bundle and fails closed', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[
			{ text: '1. 2025年1月1日甲银行发放的个人消费贷款，人民币。', bbox: [20, 100, 500, 118] },
			{ text: '截至2026年6月30日，贷款余额：10,000.00元。', bbox: [20, 122, 500, 140] },
			{ text: '2. 2025年2月2日乙银行承做个人消费贷款，人民币。', bbox: [20, 160, 500, 178] },
			{ text: '截至2026年6月30日，贷款余额：99,999.00元。', bbox: [20, 182, 500, 200] }
		]
	])
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: fixture.sourceText,
		evidenceContext: {
			...verifiedContext(isolatedFacts({
				loans: [{ institution: '甲银行', start_date: '2025-01-01', balance: 99999 }]
			}), {
				active_loans: 1,
				credit_card_details: 0,
				query_details: 0
			}),
			documentMeta: fixture.documentMeta
		},
		hashFn: TEST_HASH_FN
	})
	const loanBalances = result.factLedger.facts.filter((fact) =>
		fact.entityKind === 'loan' && fact.field === 'balance'
	)

	assert.equal(result.publicationGate.publishable, false)
	assert.equal(loanBalances.every((fact) => fact.status === FACT_STATUS.UNKNOWN), true)
})

test('a numbered unknown credit-business record with an inline amount is a hard boundary', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[
			{ text: '1. 2025年1月1日甲银行发放的个人消费贷款，人民币。', bbox: [20, 100, 500, 118] },
			{ text: '截至2026年6月30日，贷款余额：10,000.00元。', bbox: [20, 122, 500, 140] },
			{ text: '2. 2025年2月2日乙机构承做消费信贷业务，信用额度：99,999.00元。', bbox: [20, 160, 520, 178] },
			{ text: '截至2026年6月30日，贷款余额：99,999.00元。', bbox: [20, 182, 500, 200] }
		]
	])
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: fixture.sourceText,
		evidenceContext: {
			...verifiedContext(isolatedFacts({
				loans: [{ institution: '甲银行', start_date: '2025-01-01', balance: 99999 }]
			}), {
				active_loans: 1,
				credit_card_details: 0,
				query_details: 0
			}),
			documentMeta: fixture.documentMeta
		},
		hashFn: TEST_HASH_FN
	})

	assert.equal(result.publicationGate.publishable, false)
	assert.equal(result.factLedger.facts.some((fact) =>
		fact.entityKind === 'loan' && fact.field === 'balance' && fact.status === FACT_STATUS.ACCEPTED
	), false)
})

test('MuPDF multiline card record keeps identity, limit, used amount, and currency in one record binding', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[
			{ text: '1. 2025年3月3日丙银行发放的贷记卡（尾号4321）。', bbox: [20, 100, 500, 118] },
			{ text: '币种：人民币，授信额度：30,000.00元。', bbox: [20, 122, 500, 140] },
			{ text: '截至2026年6月30日，已用额度：15,000.00元。', bbox: [20, 144, 500, 162] }
		]
	])
	const facts = isolatedFacts({
		cards: [{
			institution: '丙银行',
			start_date: '2025-03-03',
			card_tail: '4321',
			currency: 'CNY',
			credit_limit: 30000,
			used_limit: 15000
		}]
	})
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: fixture.sourceText,
		evidenceContext: {
			...verifiedContext(facts, {
				active_loans: 0,
				credit_card_details: 1,
				query_details: 0
			}),
			documentMeta: fixture.documentMeta
		},
		hashFn: TEST_HASH_FN,
		requirePublishable: true
	})
	const cardNodes = result.evidenceGraph.nodes.filter((node) => node.entityKind === 'card')
	const refsByField = Object.fromEntries(cardNodes.map((node) => [node.field, node.evidenceRefs[0].span.offset]))

	assert.equal(result.publicationGate.publishable, true)
	assert.equal(new Set(cardNodes.map((node) => node.recordBindingId)).size, 1)
	assert.ok(refsByField.credit_limit > refsByField.start_date_identity)
	assert.ok(refsByField.used_limit > refsByField.credit_limit)
})

test('a controlled card money label split across consecutive atomic lines keeps both evidence refs', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[
			{ text: '1. 2025年3月3日丙银行发放的贷记卡（尾号4321），人民币，授信额度：30,000元，已使用额', bbox: [20, 100, 550, 118] },
			{ text: '度：15,000元。', bbox: [20, 122, 180, 140] }
		]
	])
	const facts = isolatedFacts({
		cards: [{
			institution: '丙银行',
			start_date: '2025-03-03',
			card_tail: '4321',
			currency: 'CNY',
			credit_limit: 30000,
			used_limit: 15000
		}]
	})
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: fixture.sourceText,
		evidenceContext: {
			...verifiedContext(facts, {
				active_loans: 0,
				credit_card_details: 1,
				query_details: 0
			}),
			documentMeta: fixture.documentMeta
		},
		hashFn: TEST_HASH_FN,
		requirePublishable: true
	})
	const usedNode = result.evidenceGraph.nodes.find((node) =>
		node.entityKind === 'card' && node.field === 'used_limit'
	)

	assert.equal(result.publicationGate.publishable, true)
	assert.equal(usedNode.evidenceRefs.length, 2)
	assert.equal(usedNode.evidenceRefs[1].ordinal, usedNode.evidenceRefs[0].ordinal + 1)
})

test('a complete card money label at line end binds the value on its immediate continuation', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[
			{ text: '1. 2025年3月3日丙银行发放的贷记卡（尾号4321），人民币，授信额度：30,000元，已使用额度', bbox: [20, 100, 550, 118] },
			{ text: '15,000元。', bbox: [20, 122, 180, 140] }
		]
	])
	const facts = isolatedFacts({
		cards: [{
			institution: '丙银行',
			start_date: '2025-03-03',
			card_tail: '4321',
			currency: 'CNY',
			credit_limit: 30000,
			used_limit: 15000
		}]
	})
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: fixture.sourceText,
		evidenceContext: {
			...verifiedContext(facts, {
				active_loans: 0,
				credit_card_details: 1,
				query_details: 0
			}),
			documentMeta: fixture.documentMeta
		},
		hashFn: TEST_HASH_FN,
		requirePublishable: true
	})
	const usedNode = result.evidenceGraph.nodes.find((node) =>
		node.entityKind === 'card' && node.field === 'used_limit'
	)

	assert.equal(result.publicationGate.publishable, true)
	assert.equal(usedNode.evidenceRefs.length, 2)
})

test('a proven closed card record binds standalone balance as used amount without claiming installment balance', () => {
	const card = {
		institution: '丙银行',
		start_date: '2025-03-03',
		card_tail: '4321',
		currency: 'CNY',
		credit_limit: 30000,
		used_limit: 15000
	}
	const fixtures = [
		structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			[
				{ text: '1. 2025年3月3日丙银行发放的贷记卡（尾号4321），人民币，信用额度：30,000元，余额', bbox: [20, 100, 550, 118] },
				{ text: '15,000元（含未出单的大额专项分期余额0）。', bbox: [20, 122, 360, 140] }
			]
		]),
		structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			[{
				text: '1. 2025年3月3日丙银行发放的贷记卡（尾号4321），人民币，信用额度：30,000元，余额15,000元（含未出单的大额专项分期余额0）。',
				bbox: [20, 100, 590, 118]
			}]
		]),
		structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			[
				{ text: '1. 2025年3月3日丙银行发放的贷记卡（尾号4321），人民币，信用额度：30,000元，已用额度15,000元，未出单大额专项分期余', bbox: [20, 100, 570, 118] },
				{ text: '额0。', bbox: [20, 122, 180, 140] }
			]
		])
	]

	for (const fixture of fixtures) {
		const result = analyzeStructuredCardFixture(fixture, card, { requirePublishable: true })
		const usedNode = result.evidenceGraph.nodes.find((node) =>
			node.entityKind === 'card' && node.field === 'used_limit'
		)
		const installmentNode = result.evidenceGraph.nodes.find((node) =>
			node.entityKind === 'card' && node.field === 'installment'
		)
		const installmentFact = result.factLedger.facts.find((fact) =>
			fact.entityKind === 'card' && fact.field === 'installment'
		)

		assert.equal(result.publicationGate.publishable, true)
		assert.equal(usedNode.value.minor, 1500000)
		assert.equal(installmentNode.value.minor, 0)
		assert.equal(installmentFact.status, FACT_STATUS.ACCEPTED)
		assert.equal(installmentFact.targetId, installmentNode.targetId)
		const valueDigest = TEST_HASH_FN('val_v2', stableCanonicalize(installmentNode.value))
		assert.equal(installmentNode.targetId, TEST_HASH_FN('tgt_v2', stableCanonicalize({
			entityId: installmentNode.entityId,
			field: 'installment',
			valueDigest
		})))
	}
})

test('standalone card balance cannot cross a source group, skip a line, or publish without record closure', () => {
	const card = {
		institution: '丙银行', start_date: '2025-03-03', card_tail: '4321',
		currency: 'CNY', credit_limit: 30000, used_limit: 15000
	}
	const fixtures = [
		structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			[{ text: '1. 2025年3月3日丙银行发放的贷记卡（尾号4321），人民币，信用额度：30,000元，余额', bbox: [20, 100, 550, 118] }],
			[{ text: '15,000元。', bbox: [20, 122, 180, 140] }]
		]),
		structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			[
				{ text: '1. 2025年3月3日丙银行发放的贷记卡（尾号4321），人民币，信用额度：30,000元，余额', bbox: [20, 100, 550, 118] },
				{ text: '字段说明', bbox: [20, 122, 180, 140] },
				{ text: '15,000元。', bbox: [20, 144, 180, 162] }
			]
		]),
		structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			[
				{ text: '丙银行信用卡（尾号4321），人民币，信用额度：30,000元，余额', bbox: [20, 100, 550, 118] },
				{ text: '15,000元。', bbox: [20, 122, 180, 140] }
			]
		])
	]

	for (const fixture of fixtures) {
		const result = analyzeStructuredCardFixture(fixture, card)
		assert.equal(result.publicationGate.publishable, false)
		assert.notEqual(result.factLedger.facts.find((fact) =>
			fact.entityKind === 'card' && fact.field === 'used_limit'
		)?.status, FACT_STATUS.ACCEPTED)
	}
})

test('a line-leading balance cannot detach from a qualified balance context on the prior atomic line', () => {
	const card = {
		institution: '丙银行', start_date: '2025-03-03', card_tail: '4321',
		currency: 'CNY', credit_limit: 30000, used_limit: 15000
	}
	for (const qualifier of ['专项分期', '担保责任', '贷款', '其他业务', '授信']) {
		const fixture = structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			[
				{ text: '1. 2025年3月3日丙银行发放的贷记卡（尾号4321），人民币，信用额度：30,000元。', bbox: [20, 100, 550, 118] },
				{ text: qualifier, bbox: [20, 122, 180, 140] },
				{ text: '余额15,000元。', bbox: [20, 144, 180, 162] }
			]
		])
		const result = analyzeStructuredCardFixture(fixture, card)
		assert.equal(result.publicationGate.publishable, false, qualifier)
		assert.notEqual(result.factLedger.facts.find((fact) =>
			fact.entityKind === 'card' && fact.field === 'used_limit'
		)?.status, FACT_STATUS.ACCEPTED, qualifier)
	}
})

test('standalone card balance rejects qualified balance context on the same atomic line', () => {
	const card = {
		institution: '丙银行', start_date: '2025-03-03', card_tail: '4321',
		currency: 'CNY', credit_limit: 30000, used_limit: 15000
	}
	for (const qualifier of ['专项分期', '担保责任', '贷款', '其他业务']) {
		const fixture = structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			[{
				text: `1. 2025年3月3日丙银行发放的贷记卡（尾号4321），人民币，信用额度：30,000元。${qualifier}，余额15,000元。`,
				bbox: [20, 100, 580, 118]
			}]
		])
		const result = analyzeStructuredCardFixture(fixture, card)
		assert.equal(result.publicationGate.publishable, false, qualifier)
		assert.notEqual(result.factLedger.facts.find((fact) =>
			fact.entityKind === 'card' && fact.field === 'used_limit'
		)?.status, FACT_STATUS.ACCEPTED, qualifier)
	}
})

test('an installment balance is never borrowed as card used amount', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[
			{ text: '1. 2025年3月3日丙银行发放的贷记卡（尾号4321），人民币，信用额度：30,000元。', bbox: [20, 100, 550, 118] },
			{ text: '未出单大额专项分期余额15,000元。', bbox: [20, 122, 360, 140] }
		]
	])
	const result = analyzeStructuredCardFixture(fixture, {
		institution: '丙银行', start_date: '2025-03-03', card_tail: '4321',
		currency: 'CNY', credit_limit: 30000, used_limit: 15000
	})

	assert.equal(result.publicationGate.publishable, false)
	assert.notEqual(result.factLedger.facts.find((fact) =>
		fact.entityKind === 'card' && fact.field === 'used_limit'
	)?.status, FACT_STATUS.ACCEPTED)
})

test('source-derived installment blocks ambiguous, cross-group, skipped-line, and other-record values', () => {
	const card = {
		institution: '丙银行', start_date: '2025-03-03', card_tail: '4321',
		currency: 'CNY', credit_limit: 30000, used_limit: 15000
	}
	const fixtures = [
		structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			[{
				text: '1. 2025年3月3日丙银行发放的贷记卡（尾号4321），人民币，信用额度：30,000元，已用额度15,000元，专项分期余额0，分期余额5,000元。',
				bbox: [20, 100, 580, 118]
			}]
		]),
		structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			[{
				text: '1. 2025年3月3日丙银行发放的贷记卡（尾号4321），人民币，信用额度：30,000元，已用额度15,000元，专项分期余额0，另列5,000元。',
				bbox: [20, 100, 580, 118]
			}]
		]),
		structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			[{ text: '1. 2025年3月3日丙银行发放的贷记卡（尾号4321），人民币，信用额度：30,000元，已用额度15,000元，专项分期余额', bbox: [20, 100, 570, 118] }],
			[{ text: '5,000元。', bbox: [20, 122, 180, 140] }]
		]),
		structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			[
				{ text: '1. 2025年3月3日丙银行发放的贷记卡（尾号4321），人民币，信用额度：30,000元，已用额度15,000元，专项分期余额', bbox: [20, 100, 570, 118] },
				{ text: '字段说明', bbox: [20, 122, 180, 140] },
				{ text: '5,000元。', bbox: [20, 144, 180, 162] }
			]
		]),
		structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			[
				{ text: '1. 2025年3月3日丙银行发放的贷记卡（尾号4321），人民币，信用额度：30,000元，已用额度15,000元。', bbox: [20, 100, 570, 118] },
				{ text: '2. 2025年4月4日丁银行发放的贷记卡（尾号9876），人民币，信用额度：50,000元，已用额度5,000元，专项分期余额1,000元。', bbox: [20, 144, 580, 162] }
			]
		])
	]

	for (const fixture of fixtures) {
		const result = analyzeStructuredCardFixture(fixture, card)
		assert.equal(result.publicationGate.publishable, false)
		assert.notEqual(result.factLedger.facts.find((fact) =>
			fact.entityKind === 'card' && fact.field === 'installment'
		)?.status, FACT_STATUS.ACCEPTED)
	}
})

test('a split money label cannot cross a source group or skip an atomic line', () => {
	const facts = isolatedFacts({
		cards: [{
			institution: '丙银行',
			start_date: '2025-03-03',
			card_tail: '4321',
			currency: 'CNY',
			credit_limit: 30000,
			used_limit: 15000
		}]
	})
	const builds = [
		structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			[{ text: '1. 2025年3月3日丙银行发放的贷记卡（尾号4321），人民币，授信额度：30,000元，已使用额', bbox: [20, 100, 550, 118] }],
			[{ text: '度：15,000元。', bbox: [20, 122, 180, 140] }]
		]),
		structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			[
				{ text: '1. 2025年3月3日丙银行发放的贷记卡（尾号4321），人民币，授信额度：30,000元，已使用额', bbox: [20, 100, 550, 118] },
				{ text: '无关字段', bbox: [20, 120, 180, 138] },
				{ text: '度：15,000元。', bbox: [20, 142, 180, 160] }
			]
		])
	]
	for (const fixture of builds) {
		const result = buildEvidenceFirstCreditAnalysis({
			sourceText: fixture.sourceText,
			evidenceContext: {
				...verifiedContext(facts, {
					active_loans: 0,
					credit_card_details: 1,
					query_details: 0
				}),
				documentMeta: fixture.documentMeta
			},
			hashFn: TEST_HASH_FN
		})
		assert.equal(result.publicationGate.publishable, false)
	}
})

test('query row binds date and reason across lines and an adjacent original MuPDF block by geometry', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[
			{ text: '1', bbox: [20, 200, 35, 218] },
			{ text: '2026年6月1日', bbox: [60, 200, 145, 218] },
			{ text: '丁银行', bbox: [180, 200, 250, 218] }
		],
		[{ text: '贷款审批', bbox: [400, 200, 470, 218] }]
	])
	const facts = isolatedFacts({
		queries: [{ institution: '丁银行', date: '2026-06-01', reason: '贷款审批' }]
	})
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: fixture.sourceText,
		evidenceContext: {
			...verifiedContext(facts, {
				active_loans: 0,
				credit_card_details: 0,
				query_details: 1
			}),
			documentMeta: fixture.documentMeta
		},
		hashFn: TEST_HASH_FN,
		requirePublishable: true
	})
	const queryNodes = result.evidenceGraph.nodes.filter((node) => node.entityKind === 'query')
	const dateNode = queryNodes.find((node) => node.field === 'date')
	const reasonNode = queryNodes.find((node) => node.field === 'reason')

	assert.equal(result.publicationGate.publishable, true)
	assert.equal(queryNodes.length, 2)
	assert.equal(dateNode.recordBindingId, reasonNode.recordBindingId)
	assert.notEqual(dateNode.evidenceRefs[0].blockId, reasonNode.evidenceRefs[0].blockId)
})

test('query fragments at different vertical positions are not joined into one record', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[
			{ text: '1', bbox: [20, 200, 35, 218] },
			{ text: '2026年6月1日', bbox: [60, 200, 145, 218] },
			{ text: '丁银行', bbox: [180, 200, 250, 218] }
		],
		[{ text: '贷款审批', bbox: [400, 230, 470, 248] }]
	])
	const facts = isolatedFacts({
		queries: [{ institution: '丁银行', date: '2026-06-01', reason: '贷款审批' }]
	})
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: fixture.sourceText,
		evidenceContext: {
			...verifiedContext(facts, {
				active_loans: 0,
				credit_card_details: 0,
				query_details: 1
			}),
			documentMeta: fixture.documentMeta
		},
		hashFn: TEST_HASH_FN
	})
	const queryFacts = result.factLedger.facts.filter((fact) => fact.entityKind === 'query')

	assert.equal(result.publicationGate.publishable, false)
	assert.equal(queryFacts.every((fact) => fact.status === FACT_STATUS.UNKNOWN), true)
})

test('same-y query fragments require non-overlapping columns and adjacent MuPDF source blocks', () => {
	const facts = isolatedFacts({
		queries: [{ institution: '丁银行', date: '2026-06-01', reason: '贷款审批' }]
	})
	const build = (fixture) => buildEvidenceFirstCreditAnalysis({
		sourceText: fixture.sourceText,
		evidenceContext: {
			...verifiedContext(facts, {
				active_loans: 0,
				credit_card_details: 0,
				query_details: 1
			}),
			documentMeta: fixture.documentMeta
		},
		hashFn: TEST_HASH_FN
	})
	const nonAdjacent = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[
			{ text: '1', bbox: [20, 200, 35, 218] },
			{ text: '2026年6月1日', bbox: [60, 200, 145, 218] },
			{ text: '丁银行', bbox: [180, 200, 250, 218] }
		],
		[{ text: '无关表格内容', bbox: [20, 300, 140, 318] }],
		[{ text: '贷款审批', bbox: [400, 200, 470, 218] }]
	])
	const overlapping = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[
			{ text: '1', bbox: [20, 200, 70, 218] },
			{ text: '2026年6月1日', bbox: [60, 200, 190, 218] },
			{ text: '丁银行', bbox: [180, 200, 410, 218] },
			{ text: '贷款审批', bbox: [400, 200, 470, 218] }
		]
	])

	for (const result of [build(nonAdjacent), build(overlapping)]) {
		assert.equal(result.publicationGate.publishable, false)
		assert.equal(
			result.factLedger.facts
				.filter((fact) => fact.entityKind === 'query')
				.every((fact) => fact.status === FACT_STATUS.UNKNOWN),
			true
		)
	}
})

test('two identical query facts on separate visual rows receive distinct record bindings', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[
			{ text: '1', bbox: [20, 200, 35, 218] },
			{ text: '2026年6月1日', bbox: [60, 200, 145, 218] },
			{ text: '戊银行', bbox: [180, 200, 250, 218] },
			{ text: '贷款审批', bbox: [400, 200, 470, 218] },
			{ text: '2', bbox: [20, 240, 35, 258] },
			{ text: '2026年6月1日', bbox: [60, 240, 145, 258] },
			{ text: '戊银行', bbox: [180, 240, 250, 258] },
			{ text: '贷款审批', bbox: [400, 240, 470, 258] }
		]
	])
	const facts = isolatedFacts({
		queries: [
			{ institution: '戊银行', date: '2026-06-01', reason: '贷款审批' },
			{ institution: '戊银行', date: '2026-06-01', reason: '贷款审批' }
		]
	})
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: fixture.sourceText,
		evidenceContext: {
			...verifiedContext(facts, {
				active_loans: 0,
				credit_card_details: 0,
				query_details: 2
			}),
			documentMeta: fixture.documentMeta
		},
		hashFn: TEST_HASH_FN,
		requirePublishable: true
	})
	const queryNodes = result.evidenceGraph.nodes.filter((node) => node.entityKind === 'query')

	assert.equal(result.publicationGate.publishable, true)
	assert.equal(new Set(queryNodes.map((node) => node.recordBindingId)).size, 2)
	assert.equal(new Set(queryNodes.map((node) => node.entityId)).size, 2)
})

test('a shorter query institution cannot claim the earlier row of a longer prefix institution', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[
			{ text: '1', bbox: [20, 200, 35, 218] },
			{ text: '2026年6月1日', bbox: [60, 200, 145, 218] },
			{ text: '前缀机构分部', bbox: [180, 200, 290, 218] },
			{ text: '贷款审批', bbox: [400, 200, 470, 218] },
			{ text: '2', bbox: [20, 240, 35, 258] },
			{ text: '2026年6月1日', bbox: [60, 240, 145, 258] },
			{ text: '前缀机构', bbox: [180, 240, 250, 258] },
			{ text: '贷款审批', bbox: [400, 240, 470, 258] }
		]
	])
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: fixture.sourceText,
		evidenceContext: {
			...verifiedContext(isolatedFacts({
				queries: [
					{ institution: '前缀机构', date: '2026-06-01', reason: '贷款审批' },
					{ institution: '前缀机构分部', date: '2026-06-01', reason: '贷款审批' }
				]
			}), {
				active_loans: 0,
				credit_card_details: 0,
				query_details: 2
			}),
			documentMeta: fixture.documentMeta
		},
		hashFn: TEST_HASH_FN,
		requirePublishable: true
	})
	const queryNodes = result.evidenceGraph.nodes.filter((node) => node.entityKind === 'query')

	assert.equal(result.publicationGate.publishable, true)
	assert.equal(queryNodes.length, 4)
	assert.equal(new Set(queryNodes.map((node) => node.recordBindingId)).size, 2)
})

test('anonymous MuPDF record bundles are stable across five runs and never publish sentinel source text', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日 姓名：绝密哨兵姓名', bbox: [20, 20, 520, 38] }],
		[
			{ text: '1. 2025年1月1日哨兵甲银行发放的个人住房贷款，人民币。', bbox: [20, 100, 520, 118] },
			{ text: '贷款余额：12,345.67元。', bbox: [20, 122, 520, 140] }
		],
		[
			{ text: '2. 2025年2月2日哨兵乙银行发放的贷记卡（尾号9876）。', bbox: [20, 170, 520, 188] },
			{ text: '币种：人民币，授信额度：40,000元，已用额度：20,000元。', bbox: [20, 192, 520, 210] }
		],
		[
			{ text: '1', bbox: [20, 260, 35, 278] },
			{ text: '2026年6月1日', bbox: [60, 260, 145, 278] },
			{ text: '哨兵丙银行', bbox: [180, 260, 270, 278] }
		],
		[{ text: '贷款审批', bbox: [400, 260, 470, 278] }]
	])
	const facts = isolatedFacts({
		loans: [{ institution: '哨兵甲银行', start_date: '2025-01-01', balance: 12345.67 }],
		cards: [{
			institution: '哨兵乙银行',
			start_date: '2025-02-02',
			card_tail: '9876',
			currency: 'CNY',
			credit_limit: 40000,
			used_limit: 20000
		}],
		queries: [{ institution: '哨兵丙银行', date: '2026-06-01', reason: '贷款审批' }]
	})
	const hashFn = createHmacHashFn('anonymous-record-bundle-stability-secret-32-bytes')
	const results = Array.from({ length: 5 }, () => buildEvidenceFirstCreditAnalysis({
		sourceText: fixture.sourceText,
		evidenceContext: {
			...verifiedContext(facts),
			documentMeta: fixture.documentMeta
		},
		hashFn,
		requirePublishable: true
	}))
	const hashes = results.map((result) => [
		result.manifest.manifestHash,
		result.evidenceGraph.evidenceGraphHash,
		result.factLedger.factLedgerHash,
		result.derivedAnalysis.derivedAnalysisHash
	])

	assert.equal(new Set(hashes.map(JSON.stringify)).size, 1)
	for (const result of results) {
		const serialized = JSON.stringify(result)
		assert.equal(result.publicationGate.publishable, true)
		assert.doesNotMatch(serialized, /绝密哨兵姓名|哨兵甲银行|哨兵乙银行|哨兵丙银行|9876|12,345\.67/)
		assert.doesNotMatch(serialized, /"text"\s*:|"quote"\s*:|"sourceText"\s*:/)
	}
})

test('dated unknown records and unrelated liability continuations are hard account boundaries', () => {
	for (const marker of ['（2）', '２．', '[2]', '②', '']) {
		const fixture = structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			[
				{ text: '1. 2025年1月1日甲银行发放的个人消费贷款，人民币。', bbox: [20, 100, 500, 118] },
				{ text: `${marker} 2025年2月2日乙机构承担担保责任。`, bbox: [20, 140, 500, 158] },
				{ text: '截至2026年6月30日，乙担保机构担保责任余额：99,999元。', bbox: [20, 162, 520, 180] }
			]
		])
		const result = buildEvidenceFirstCreditAnalysis({
			sourceText: fixture.sourceText,
			evidenceContext: {
				...verifiedContext(isolatedFacts({
					loans: [{ institution: '甲银行', start_date: '2025-01-01', balance: 99999 }]
				}), { active_loans: 1, credit_card_details: 0, query_details: 0 }),
				documentMeta: fixture.documentMeta
			},
			hashFn: TEST_HASH_FN
		})
		assert.equal(result.publicationGate.publishable, false, marker || 'unnumbered')
		assert.equal(result.factLedger.facts.some((fact) =>
			fact.entityKind === 'loan' && fact.field === 'balance' && fact.status === FACT_STATUS.ACCEPTED
		), false, marker || 'unnumbered')
	}
})

test('structured line-end money fragments never become complete amounts', () => {
	for (const [leftAmount, rightAmount] of [['15,', '000元。'], ['15', '000元。']]) {
		const fixture = structuredPdfFixture([
			[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
			[
				{ text: `1. 2025年3月3日丙银行发放的贷记卡（尾号4321），人民币，授信额度：30,000元，已使用额度：${leftAmount}`, bbox: [20, 100, 550, 118] },
				{ text: rightAmount, bbox: [20, 122, 180, 140] }
			]
		])
		const result = buildEvidenceFirstCreditAnalysis({
			sourceText: fixture.sourceText,
			evidenceContext: {
				...verifiedContext(isolatedFacts({ cards: [{
					institution: '丙银行', start_date: '2025-03-03', card_tail: '4321',
					currency: 'CNY', credit_limit: 30000, used_limit: 15
				}] }), { active_loans: 0, credit_card_details: 1, query_details: 0 }),
				documentMeta: fixture.documentMeta
			},
			hashFn: TEST_HASH_FN
		})
		assert.equal(result.publicationGate.publishable, false, leftAmount)
		assert.notEqual(result.factLedger.facts.find((fact) => fact.field === 'used_limit')?.status, FACT_STATUS.ACCEPTED)
	}
})

test('a connector at the final atomic line never terminates a money value', () => {
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[{
			text: '1. 2025年1月1日甲银行发放个人消费贷款，人民币，贷款余额：15,',
			bbox: [20, 100, 520, 118]
		}]
	])
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: fixture.sourceText,
		evidenceContext: {
			...verifiedContext(isolatedFacts({
				loans: [{ institution: '甲银行', start_date: '2025-01-01', balance: 15, currency: 'CNY' }]
			}), { active_loans: 1, credit_card_details: 0, query_details: 0 }),
			documentMeta: fixture.documentMeta
		},
		hashFn: TEST_HASH_FN
	})

	assert.equal(result.publicationGate.publishable, false)
	assert.notEqual(
		result.factLedger.facts.find((fact) => fact.entityKind === 'loan' && fact.field === 'balance')?.status,
		FACT_STATUS.ACCEPTED
	)
})

test('line-end shared group fragments are unresolved and never accepted as facility IDs', () => {
	const documentId = `doc_v2_${'8'.repeat(64)}`
	assert.equal(buildSourceSharedGroupId('G-', TEST_HASH_FN, documentId), '')
	const fixture = structuredPdfFixture([
		[{ text: '个人信用报告 报告日期：2026年6月30日', bbox: [20, 20, 420, 38] }],
		[
			{ text: '1. 2025年3月3日丙银行发放的贷记卡（尾号4321），人民币，授信额度：30,000元，已使用额度：15,000元，共享额度组：G', bbox: [20, 100, 550, 118] },
			{ text: '/1。', bbox: [20, 122, 180, 140] }
		]
	])
	const result = buildEvidenceFirstCreditAnalysis({
		sourceText: fixture.sourceText,
		documentId,
		evidenceContext: {
			...verifiedContext(isolatedFacts({ cards: [{
				institution: '丙银行', start_date: '2025-03-03', card_tail: '4321', currency: 'CNY',
				credit_limit: 30000, used_limit: 15000, shared_credit_group: 'G'
			}] }), { active_loans: 0, credit_card_details: 1, query_details: 0 }),
			documentMeta: fixture.documentMeta
		},
		hashFn: TEST_HASH_FN
	})
	assert.equal(result.publicationGate.publishable, false)
	assert.equal(result.evidenceGraph.nodes.some((node) => node.field === 'shared_group_identity'), false)
})
