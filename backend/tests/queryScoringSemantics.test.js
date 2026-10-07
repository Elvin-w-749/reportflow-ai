'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
	FACT_STATUS,
	buildDerivedAnalysis
} = require('../backend/services/creditEvidenceLedger')

function acceptedFact(factId, entityId, entityKind, field, value) {
	return {
		factId,
		entityId,
		entityKind,
		field,
		critical: true,
		status: FACT_STATUS.ACCEPTED,
		value
	}
}

function evidenceDerivedForQueries(queryRows) {
	const facts = [acceptedFact(
		'fact-report-date',
		'document-1',
		'document',
		'report_date',
		{ type: 'date', value: '2026-06-30' }
	)]
	for (const [index, row] of queryRows.entries()) {
		const entityId = `query-${index + 1}`
		facts.push(
			acceptedFact(`fact-query-date-${index + 1}`, entityId, 'query', 'date', { type: 'date', value: row.date }),
			acceptedFact(`fact-query-reason-${index + 1}`, entityId, 'query', 'reason', { type: 'string', value: row.reason })
		)
	}
	return buildDerivedAnalysis({
		manifest: { manifestHash: 'manifest-hash' },
		evidenceGraph: { manifestHash: 'manifest-hash', evidenceGraphHash: 'graph-hash' },
		factLedger: {
			status: 'ready',
			evidenceGraphHash: 'graph-hash',
			factLedgerHash: 'ledger-hash',
			anchorDate: '2026-06-30',
			facts,
			relations: []
		},
		facts: { primary_rule_score: { score: 100 } }
	})
}

test('evidence-derived score ignores four same-day post-loan-management rows', () => {
	const result = evidenceDerivedForQueries(
		Array.from({ length: 4 }, () => ({ date: '2026-06-20', reason: '贷后管理' }))
	)

	assert.equal(result.metrics.queryCounts.value.last_6m, 0)
	assert.equal(result.metrics.primaryScore.inputMetrics.sameDayInquiryDayCount, 0)
	assert.equal(result.metrics.primaryScore.value.value, 100)
})

test('evidence-derived score ignores a same-day hard-query burst outside six calendar months', () => {
	const result = evidenceDerivedForQueries(
		Array.from({ length: 4 }, () => ({ date: '2025-01-15', reason: '贷款审批' }))
	)

	assert.equal(result.metrics.queryCounts.value.last_6m, 0)
	assert.equal(result.metrics.primaryScore.inputMetrics.sameDayInquiryDayCount, 0)
	assert.equal(result.metrics.primaryScore.value.value, 100)
})
