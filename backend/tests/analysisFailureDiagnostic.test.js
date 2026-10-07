'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
	sanitizeAnalysisFailureDiagnostic
} = require('../backend/utils/analysisFailureDiagnostic')
const {
	buildSafeEvidenceDiagnostic
} = require('../backend/services/creditEvidenceLedger')

const PRIVATE_SENTINEL = 'PRIVATE_NAME_INSTITUTION_AMOUNT_2026_08_17'
const PRIVATE_HASH = 'cafebabecafebabecafebabecafebabe'

const ALLOWED_KEYS = new Set([
	'version',
	'httpStatus',
	'expectedCount',
	'actualCount',
	'failedCheckCount',
	'evidenceIssueCount',
	'coverageIssueCount',
	'failedPageCount',
	'totalPageCount',
	'failedChecks',
	'manifest',
	'status',
	'declaredPageCount',
	'processedPageCount',
	'completePageCount',
	'rejectedPageCount',
	'missingPageCount',
	'duplicatePageCount',
	'graph',
	'nodeCount',
	'criticalUnresolvedCount',
	'unresolvedReasons',
	'unresolvedByTarget',
	'value',
	'count',
	'name',
	'reasons',
	'ledger',
	'criticalFailureCount',
	'sections',
	'expectedCount',
	'acceptedCount',
	'declaredCount',
	'basis',
	'conflictCodes',
	'derived',
	'blockedMetricCount',
	'blockedReasons',
	'blockedFormulas'
])

function assertOnlyAllowedKeys(value) {
	if (Array.isArray(value)) {
		for (const item of value) assertOnlyAllowedKeys(item)
		return
	}
	if (!value || typeof value !== 'object') return
	for (const [key, child] of Object.entries(value)) {
		assert.ok(ALLOWED_KEYS.has(key), `unexpected diagnostic key: ${key}`)
		assertOnlyAllowedKeys(child)
	}
}

function unsafeDiagnostic() {
	return {
		version: 999,
		httpStatus: 422,
		evidenceIssueCount: 15,
		failedChecks: ['DERIVED_VALIDATED', PRIVATE_SENTINEL, 'EVIDENCE_COMPLETE'],
		message: PRIVATE_SENTINEL,
		reportPath: `C:/private/${PRIVATE_SENTINEL}.pdf`,
		documentId: `doc_v2_${PRIVATE_HASH}`,
		manifest: {
			status: 'complete',
			declaredPageCount: 12,
			processedPageCount: 12,
			completePageCount: 12,
			rejectedPageCount: 0,
			missingPageCount: 0,
			duplicatePageCount: 0,
			pageText: PRIVATE_SENTINEL
		},
		graph: {
			status: 'rejected',
			nodeCount: 120,
			criticalUnresolvedCount: 5,
			unresolvedReasons: [
				{ value: 'AMBIGUOUS_CARD_SOURCE_BUNDLE', count: 4, quote: PRIVATE_SENTINEL },
				{ value: PRIVATE_SENTINEL, count: 91 },
				{ value: 'UNCLAIMED_SOURCE_INSTALLMENT_SIGNAL', count: 1 }
			],
			unresolvedByTarget: [
				{
					name: 'card.credit_limit',
					count: 4,
					reasons: [{ value: 'AMBIGUOUS_CARD_SOURCE_BUNDLE', count: 4 }],
					entityId: PRIVATE_HASH
				},
				{ name: PRIVATE_SENTINEL, count: 1, reasons: [] }
			],
			sourceText: PRIVATE_SENTINEL
		},
		ledger: {
			status: 'blocked',
			criticalFailureCount: 4,
			sections: [
				{
					name: 'credit_card_details',
					expectedCount: 5,
					acceptedCount: 4,
					declaredCount: 5,
					status: 'incomplete',
					basis: 'source-account-overview-pdf-geometry-v2',
					institution: PRIVATE_SENTINEL
				},
				{ name: PRIVATE_SENTINEL, expectedCount: 99 }
			],
			conflictCodes: [
				{ value: 'CARD_FACILITY_RELATION_UNRESOLVED', count: 1 },
				{ value: PRIVATE_SENTINEL, count: 1 }
			],
			amount: 888888
		},
		derived: {
			status: 'blocked',
			blockedMetricCount: 6,
			blockedReasons: [{ value: 'FACT_LEDGER_BLOCKED', count: 6 }],
			blockedFormulas: [{ value: 'total-debt-v2', count: 1 }],
			modelOutput: PRIVATE_SENTINEL
		}
	}
}

test('analysis failure diagnostic preserves the closed evidence structure only', () => {
	const diagnostic = sanitizeAnalysisFailureDiagnostic(unsafeDiagnostic())
	assert.equal(diagnostic.version, 1)
	assert.equal(diagnostic.httpStatus, 422)
	assert.equal(diagnostic.evidenceIssueCount, 15)
	assert.deepEqual(diagnostic.failedChecks, ['EVIDENCE_COMPLETE', 'DERIVED_VALIDATED'])
	assert.equal(diagnostic.manifest.completePageCount, 12)
	assert.equal(diagnostic.graph.criticalUnresolvedCount, 5)
	assert.deepEqual(diagnostic.graph.unresolvedReasons, [
		{ value: 'AMBIGUOUS_CARD_SOURCE_BUNDLE', count: 4 },
		{ value: 'UNCLAIMED_SOURCE_INSTALLMENT_SIGNAL', count: 1 }
	])
	assert.deepEqual(diagnostic.graph.unresolvedByTarget, [{
		name: 'card.credit_limit',
		count: 4,
		reasons: [{ value: 'AMBIGUOUS_CARD_SOURCE_BUNDLE', count: 4 }]
	}])
	assert.equal(diagnostic.ledger.sections.length, 1)
	assert.equal(diagnostic.ledger.sections[0].name, 'credit_card_details')
	assert.equal(diagnostic.derived.blockedMetricCount, 6)
	assertOnlyAllowedKeys(diagnostic)
	assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE|cafebabe|documentId|reportPath|sourceText|institution|amount/)
})

test('analysis failure diagnostic is stable when persisted and sanitized again', () => {
	const first = sanitizeAnalysisFailureDiagnostic(unsafeDiagnostic())
	const second = sanitizeAnalysisFailureDiagnostic(JSON.stringify(first))
	assert.deepEqual(second, first)
	assert.deepEqual(sanitizeAnalysisFailureDiagnostic('not-json'), { version: 1 })
	assert.deepEqual(sanitizeAnalysisFailureDiagnostic(null), { version: 1 })
	assert.deepEqual(sanitizeAnalysisFailureDiagnostic({ httpStatus: 888888 }), { version: 1 })
	assert.deepEqual(
		sanitizeAnalysisFailureDiagnostic({
			failedCheckCount: 2,
			failedChecks: ['EVIDENCE_COMPLETE', PRIVATE_SENTINEL]
		}),
		{ version: 1, failedCheckCount: 1, failedChecks: ['EVIDENCE_COMPLETE'] }
	)
	assert.deepEqual(
		sanitizeAnalysisFailureDiagnostic({ failedCheckCount: 999, failedChecks: [] }),
		{ version: 1, failedCheckCount: 0 }
	)
})

test('blocked formula diagnostics retain legacy v2 while accepting the current v3 formula', () => {
	const diagnostic = sanitizeAnalysisFailureDiagnostic({
		derived: {
			status: 'blocked',
			blockedMetricCount: 2,
			blockedReasons: [{ value: 'FACT_LEDGER_BLOCKED', count: 2 }],
			blockedFormulas: [
				{ value: 'primary-score-deterministic-v2', count: 1 },
				{ value: 'primary-score-deterministic-v3', count: 1 },
				{ value: PRIVATE_SENTINEL, count: 99 }
			]
		}
	})
	assert.deepEqual(diagnostic.derived.blockedFormulas, [
		{ value: 'primary-score-deterministic-v2', count: 1 },
		{ value: 'primary-score-deterministic-v3', count: 1 }
	])
})

test('the persisted schema losslessly accepts the evidence ledger safe diagnostic', () => {
	const artifacts = {
		manifest: {
			status: 'rejected',
			pages: [{ status: 'complete' }, { status: 'rejected' }],
			coverage: {
				declaredPageCount: 3,
				processedPageCount: 2,
				missingPageNos: [3],
				duplicatePageNos: [1]
			}
		},
		evidenceGraph: {
			status: 'rejected',
			nodes: [{}, {}],
			unresolved: [
				{ targetKey: 'card:1:credit_limit', critical: true, reason: 'AMBIGUOUS_CARD_SOURCE_BUNDLE' },
				{ targetKey: 'source-installment-signal:1', critical: true, reason: 'UNCLAIMED_SOURCE_INSTALLMENT_SIGNAL' }
			]
		},
		factLedger: {
			status: 'blocked',
			facts: [{ critical: true, status: 'unknown' }],
			sections: [{
				name: 'credit_card_details',
				expectedCount: 5,
				acceptedEntityCount: 4,
				declaredEntityCount: 5,
				status: 'incomplete',
				basis: 'source-account-overview-pdf-geometry-v2'
			}],
			conflicts: [{ code: 'CARD_FACILITY_RELATION_UNRESOLVED' }]
		},
		derivedAnalysis: {
			status: 'blocked',
			metrics: {
				totalDebt: {
					status: 'blocked',
					reason: 'FACT_LEDGER_BLOCKED',
					formulaId: 'total-debt-v2'
				}
			}
		}
	}
	const safeEvidence = buildSafeEvidenceDiagnostic(artifacts)
	assert.deepEqual(
		sanitizeAnalysisFailureDiagnostic(safeEvidence),
		{ version: 1, ...safeEvidence }
	)
})
