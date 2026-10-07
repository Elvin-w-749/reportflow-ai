'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
	finalizeExtractedCreditFacts
} = require('../backend/services/creditAnalysisService')

function completeCoverage(overrides = {}) {
	const counts = {
		bank_loans: 0,
		non_bank_loans: 0,
		settled_loans: 0,
		historical_overdue_loans: 0,
		credit_card_details: 2,
		credit_card_details_cancelled: 0,
		query_details: 0,
		self_queries: 0,
		overdue_details: 0,
		public_records: 0,
		guarantee_records: 0,
		loan_history: 0,
		...overrides
	}
	return Object.fromEntries(
		Object.entries(counts).map(([name, total]) => [name, { total, listed: total }])
	)
}

function twoCardFacts() {
	return {
		meta: { report_date: '2026-06-30' },
		basic_info: {},
		loan_details: {
			bank_loans: [],
			non_bank_loans: [],
			settled_loans: [],
			historical_overdue_loans: []
		},
		credit_card_details: [
			{
				institution: '同一银行',
				start_date: '2025-01-01',
				card_tail: '1111',
				currency: 'CNY',
				credit_limit: 20000,
				used_limit: 10000,
				status: '正常',
				// A model may still violate the prompt. Sanitization must discard this.
				shared_credit_group: 'MODEL_MUST_NOT_BE_TRUSTED'
			},
			{
				institution: '同一银行',
				start_date: '2025-02-01',
				card_tail: '2222',
				currency: 'CNY',
				credit_limit: 20000,
				used_limit: 8000,
				status: '正常',
				shared_credit_group: 'MODEL_MUST_NOT_BE_TRUSTED'
			}
		],
		credit_card_details_cancelled: [],
		query_analysis: { query_details: [], self_queries: [] },
		overdue_info: { has_overdue: false, total_overdue_accounts: 0, details: [] },
		public_records: { has_record: false, items: [] },
		guarantee_records: { total_amount: 0, items: [] },
		loan_history: { trend_data: [] },
		_coverage: { truncated: false, counts: completeCoverage() }
	}
}

function nativePdfEvidenceContext(lines) {
	let pageText = ''
	const structuredLines = lines.map((text, index) => {
		if (index > 0) pageText += '\n'
		const charStart = pageText.length
		pageText += text
		return {
			text,
			charStart,
			charEnd: pageText.length,
			bbox: [10, 10 + index * 20, 590, 25 + index * 20]
		}
	})
	return {
		version: 'pdf-structured-v1',
		sourceMode: 'pdf-text',
		expectedPageCount: 1,
		complete: true,
		pages: [{
			pageNumber: 1,
			bounds: [0, 0, 600, 800],
			text: pageText,
			blocks: structuredLines.map((line) => ({
				text: line.text,
				charStart: line.charStart,
				charEnd: line.charEnd,
				bbox: line.bbox,
				lines: [line]
			}))
		}]
	}
}

function nativePdfSingleBlockEvidenceContext(lines) {
	let pageText = ''
	const structuredLines = lines.map((text, index) => {
		if (index > 0) pageText += '\n'
		const charStart = pageText.length
		pageText += text
		return {
			text,
			charStart,
			charEnd: pageText.length,
			bbox: [10, 10 + index * 20, 590, 25 + index * 20]
		}
	})
	return {
		version: 'pdf-structured-v1',
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
				bbox: [10, 10, 590, 25 + lines.length * 20],
				lines: structuredLines
			}]
		}]
	}
}

test('native PDF explicit shared-credit relation is source-bound, opaque, and deduplicated', () => {
	const lines = [
		'个人信用报告 报告日期：2026年6月30日',
		'同一银行 2025年1月1日 尾号1111 人民币 授信额度：20,000.00元 已用额度：10,000.00元 共享额度组：G1',
		'同一银行 2025年2月1日 尾号2222 人民币 授信额度：20,000.00元 已用额度：8,000.00元 共享额度组：G1'
	]
	const evidenceContext = nativePdfEvidenceContext(lines)
	const sourceText = evidenceContext.pages[0].text
	const result = finalizeExtractedCreditFacts(twoCardFacts(), sourceText, {
		evidenceRequired: true,
		inputKind: 'credit-report-pdf',
		documentId: `doc_v2_${'b'.repeat(64)}`,
		evidenceContext,
		sourceVerifiedCounts: {
			active_loans: { count: 0, basis: 'source-test-v1' },
			credit_card_details: { count: 2, basis: 'source-test-v1' },
			query_details: { count: 0, basis: 'source-test-v1' }
		}
	})

	const cards = result.credit_card_details
	assert.equal(cards.length, 2)
	assert.match(cards[0].shared_credit_group, /^grp_v2_[a-f0-9]{64}$/)
	assert.equal(cards[0].shared_credit_group, cards[1].shared_credit_group)
	assert.equal(result.credit_debt.credit_cards.raw_total_limit, 40000)
	assert.equal(result.credit_debt.credit_cards.raw_total_used, 18000)
	assert.equal(result.credit_debt.credit_cards.total_limit, 20000)
	assert.equal(result.credit_debt.credit_cards.total_used, 10000)
	assert.equal(result.credit_debt.credit_cards.usage_rate, 0.5)
	assert.equal(result.credit_debt.credit_cards.shared_group_count, 1)
	assert.equal(result.credit_debt.credit_loans.total_balance, 0)
	assert.equal(result.deterministic_dimensions.totalLoanBalance, 0)
	assert.equal(result.evidence_v2.status, 'publishable')
	for (const versionKey of [
		'rule', 'ruleHash', 'evidenceContract', 'evidenceBinder',
		'evidenceHash', 'sharedCreditPolicy', 'derivedTrace'
	]) {
		assert.ok(result.evidence_v2.manifest.versions[versionKey], versionKey)
	}
	assert.deepEqual(result.evidence_meta.authoritative_scope, [
		'credit_debt.total_debt',
		'credit_debt.credit_loans.total_balance',
		'credit_debt.credit_cards.total_limit',
		'credit_debt.credit_cards.total_used',
		'credit_debt.credit_cards.utilization_used',
		'credit_debt.credit_cards.usage_rate',
		'credit_debt.credit_cards.shared_group_count',
		'query_analysis.summary.last_1m.total',
		'query_analysis.summary.last_3m.total',
		'query_analysis.summary.last_6m.total',
		'query_analysis.summary.last_12m.total',
		'primary_rule_score.score'
	])
	assert.equal(
		result.evidence_v2.evidenceGraph.nodes.filter((node) =>
			node.entityKind === 'card' && node.field === 'shared_group_identity'
		).length,
		2
	)
	assert.equal(
		result.evidence_v2.factLedger.relations.filter((relation) =>
			relation.type === 'same-credit-facility' &&
			relation.status === 'accepted' &&
			relation.basis === 'explicit-source-group'
		).length,
		1
	)
	assert.equal(JSON.stringify(result).includes('G1'), false)
	assert.equal(JSON.stringify(result).includes('MODEL_MUST_NOT_BE_TRUSTED'), false)
})

test('a source-proved shared group remains auditable when its label wraps across lines', () => {
	const lines = [
		'个人信用报告 报告日期：2026年6月30日',
		'1. 2025年1月1日同一银行发放的贷记卡（尾号1111），人民币，授信额度：20,000.00元 已用额度：10,000.00元 共享额',
		'度组：G1',
		'2. 2025年2月1日同一银行发放的贷记卡（尾号2222），人民币，授信额度：20,000.00元 已用额度：8,000.00元 共享额',
		'度组：G1'
	]
	const evidenceContext = nativePdfSingleBlockEvidenceContext(lines)
	const result = finalizeExtractedCreditFacts(twoCardFacts(), evidenceContext.pages[0].text, {
		evidenceRequired: true,
		inputKind: 'credit-report-pdf',
		documentId: `doc_v2_${'d'.repeat(64)}`,
		evidenceContext,
		sourceVerifiedCounts: {
			active_loans: { count: 0, basis: 'source-test-v1' },
			credit_card_details: { count: 2, basis: 'source-test-v1' },
			query_details: { count: 0, basis: 'source-test-v1' }
		}
	})

	assert.equal(result.evidence_v2.status, 'publishable')
	assert.equal(result.credit_debt.credit_cards.shared_group_count, 1)
	assert.equal(result.credit_debt.credit_cards.total_limit, 20000)
	assert.equal(result.credit_debt.credit_cards.total_used, 10000)
	assert.equal(JSON.stringify(result).includes('G1'), false)
	assert.equal(result.evidence_v2.evidenceGraph.nodes.filter((node) =>
		node.field === 'shared_group_identity' && node.evidenceRefs.length === 2
	).length, 2)
})

test('a split source group remains authoritative when the model omits it', () => {
	const facts = twoCardFacts()
	for (const card of facts.credit_card_details) delete card.shared_credit_group
	const lines = [
		'个人信用报告 报告日期：2026年6月30日',
		'1. 2025年1月1日同一银行发放的贷记卡（尾号1111），人民币，授信额度：20,000.00元 已用额度：10,000.00元 共享额',
		'度组：G1',
		'2. 2025年2月1日同一银行发放的贷记卡（尾号2222），人民币，授信额度：20,000.00元 已用额度：8,000.00元 共享额',
		'度组：G1'
	]
	const evidenceContext = nativePdfSingleBlockEvidenceContext(lines)
	const result = finalizeExtractedCreditFacts(facts, evidenceContext.pages[0].text, {
			evidenceRequired: true,
			inputKind: 'credit-report-pdf',
			documentId: `doc_v2_${'e'.repeat(64)}`,
			evidenceContext,
			sourceVerifiedCounts: {
				active_loans: { count: 0, basis: 'source-test-v1' },
				credit_card_details: { count: 2, basis: 'source-test-v1' },
				query_details: { count: 0, basis: 'source-test-v1' }
			}
		})
	assert.equal(result.evidence_v2.status, 'publishable')
	assert.equal(result.credit_debt.credit_cards.shared_group_count, 1)
	assert.equal(result.credit_debt.credit_cards.total_limit, 20000)
	assert.equal(result.credit_debt.credit_cards.total_used, 10000)
})

test('a three-line source group is reconstructed only within one consecutive source block', () => {
	const build = (evidenceContext, nibble) => {
		const facts = twoCardFacts()
		for (const card of facts.credit_card_details) delete card.shared_credit_group
		return finalizeExtractedCreditFacts(facts, evidenceContext.pages[0].text, {
			evidenceRequired: true,
			inputKind: 'credit-report-pdf',
			documentId: `doc_v2_${nibble.repeat(64)}`,
			evidenceContext,
			sourceVerifiedCounts: {
				active_loans: { count: 0, basis: 'source-test-v1' },
				credit_card_details: { count: 2, basis: 'source-test-v1' },
				query_details: { count: 0, basis: 'source-test-v1' }
			}
		})
	}
	const lines = [
		'个人信用报告 报告日期：2026年6月30日',
		'1. 2025年1月1日同一银行发放的贷记卡（尾号1111），人民币，授信额度：20,000.00元 已用额度：10,000.00元 共享额',
		'度组：',
		'G1。',
		'2. 2025年2月1日同一银行发放的贷记卡（尾号2222），人民币，授信额度：20,000.00元 已用额度：8,000.00元 共享额',
		'度组：',
		'G1。'
	]
	const valid = build(nativePdfSingleBlockEvidenceContext(lines), 'a')
	assert.equal(valid.evidence_v2.status, 'publishable')
	assert.equal(valid.credit_debt.credit_cards.shared_group_count, 1)
	assert.equal(valid.credit_debt.credit_cards.total_limit, 20000)

	const crossBlock = nativePdfEvidenceContext(lines)
	assert.throws(() => build(crossBlock, 'b'), (error) =>
		error?.code === 'EVIDENCE_PUBLICATION_BLOCKED' &&
		error?.diagnostic?.graph?.unresolvedReasons?.some((item) =>
			item.value === 'UNCLAIMED_SOURCE_SHARED_CREDIT_SIGNAL'
		)
	)
})

test('explicit no-shared sentinels remain separate card facilities', () => {
	for (const [index, sentinel] of ['无', '未共享', '无共享', '未设置', '不共享', 'N/A'].entries()) {
		const lines = [
			'个人信用报告 报告日期：2026年6月30日',
			`同一银行 2025年1月1日 尾号1111 人民币 授信额度：20,000.00元 已用额度：10,000.00元 共享额度组：${sentinel}`,
			`同一银行 2025年2月1日 尾号2222 人民币 授信额度：20,000.00元 已用额度：8,000.00元 共享额度组：${sentinel}`
		]
		const evidenceContext = nativePdfEvidenceContext(lines)
		const documentNibble = (index + 4).toString(16)
		const result = finalizeExtractedCreditFacts(twoCardFacts(), evidenceContext.pages[0].text, {
			evidenceRequired: true,
			inputKind: 'credit-report-pdf',
			documentId: `doc_v2_${documentNibble.repeat(64)}`,
			evidenceContext,
			sourceVerifiedCounts: {
				active_loans: { count: 0, basis: 'source-test-v1' },
				credit_card_details: { count: 2, basis: 'source-test-v1' },
				query_details: { count: 0, basis: 'source-test-v1' }
			}
		})

		assert.equal(result.credit_debt.credit_cards.raw_total_limit, 40000, sentinel)
		assert.equal(result.credit_debt.credit_cards.raw_total_used, 18000, sentinel)
		assert.equal(result.credit_debt.credit_cards.total_limit, 40000, sentinel)
		assert.equal(result.credit_debt.credit_cards.total_used, 18000, sentinel)
		assert.equal(result.credit_debt.credit_cards.shared_group_count, 0, sentinel)
		assert.equal(result.credit_card_details.some((card) => card.shared_credit_group), false, sentinel)
		assert.equal(result.evidence_v2.status, 'publishable', sentinel)
	}
})

test('legacy and non-structured inputs never trust an apparent shared-credit label', () => {
	const sourceText = [
		'个人信用报告 报告日期：2026年6月30日',
		'同一银行 2025年1月1日 尾号1111 人民币 授信额度：20,000.00元 已用额度：10,000.00元 共享额度组：G1',
		'同一银行 2025年2月1日 尾号2222 人民币 授信额度：20,000.00元 已用额度：8,000.00元 共享额度组：G1'
	].join('\n')
	const result = finalizeExtractedCreditFacts(twoCardFacts(), sourceText)

	assert.equal(result.credit_debt.credit_cards.total_limit, 40000)
	assert.equal(result.credit_debt.credit_cards.total_used, 18000)
	assert.equal(result.credit_debt.credit_cards.shared_group_count, 0)
	assert.equal(result.credit_card_details.some((card) => card.shared_credit_group), false)
})

test('an explicit source relation that cannot bind at least two cards fails closed', () => {
	const lines = [
		'个人信用报告 报告日期：2026年6月30日',
		'同一银行 2025年1月1日 尾号1111 人民币 授信额度：20,000.00元 已用额度：10,000.00元 共享授信组：ONLY_ONE',
		'同一银行 2025年2月1日 尾号2222 人民币 授信额度：20,000.00元 已用额度：8,000.00元'
	]
	const evidenceContext = nativePdfEvidenceContext(lines)
	assert.throws(
		() => finalizeExtractedCreditFacts(twoCardFacts(), evidenceContext.pages[0].text, {
			evidenceRequired: true,
			inputKind: 'credit-report-pdf',
			documentId: `doc_v2_${'c'.repeat(64)}`,
			evidenceContext,
			sourceVerifiedCounts: {
				active_loans: { count: 0, basis: 'source-test-v1' },
				credit_card_details: { count: 2, basis: 'source-test-v1' },
				query_details: { count: 0, basis: 'source-test-v1' }
			}
		}),
		(error) => error &&
			error.code === 'EVIDENCE_PUBLICATION_BLOCKED' &&
			Array.isArray(error.failedChecks) &&
			error.failedChecks.includes('EVIDENCE_COMPLETE')
	)
})

test('the finalized service excludes a source-proved foreign loan from CNY debt', () => {
	const lines = [
		'个人信用报告 报告日期：2026年6月30日',
		'甲银行 美元 贷款余额：10,000.00元'
	]
	const evidenceContext = nativePdfEvidenceContext(lines)
	const facts = {
		meta: { report_date: '2026-06-30' },
		basic_info: {},
		loan_details: {
			bank_loans: [{ institution: '甲银行', currency: 'USD', balance: 10000, status: '正常' }],
			non_bank_loans: [],
			settled_loans: [],
			historical_overdue_loans: []
		},
		credit_card_details: [],
		credit_card_details_cancelled: [],
		query_analysis: { query_details: [], self_queries: [] },
		overdue_info: { has_overdue: false, total_overdue_accounts: 0, details: [] },
		public_records: { has_record: false, items: [] },
		guarantee_records: { total_amount: 0, items: [] },
		loan_history: { trend_data: [] },
		_coverage: {
			truncated: false,
			counts: completeCoverage({ bank_loans: 1, credit_card_details: 0 })
		}
	}
	const result = finalizeExtractedCreditFacts(facts, evidenceContext.pages[0].text, {
		evidenceRequired: true,
		inputKind: 'credit-report-pdf',
		documentId: `doc_v2_${'e'.repeat(64)}`,
		evidenceContext,
		sourceVerifiedCounts: {
			active_loans: { count: 1, basis: 'source-test-v1' },
			credit_card_details: { count: 0, basis: 'source-test-v1' },
			query_details: { count: 0, basis: 'source-test-v1' }
		}
	})
	const balanceFact = result.evidence_v2.factLedger.facts.find((fact) =>
		fact.entityKind === 'loan' && fact.field === 'balance'
	)

	assert.equal(result.credit_debt.credit_loans.total_balance, 0)
	assert.equal(result.credit_debt.total_debt, 0)
	assert.equal(result.deterministic_dimensions.totalLoanBalance, 0)
	assert.equal(balanceFact.value.currency, 'USD')
	assert.equal(result.evidence_v2.status, 'publishable')
})
