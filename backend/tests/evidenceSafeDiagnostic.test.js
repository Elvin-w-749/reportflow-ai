'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
	buildSafeEvidenceDiagnostic,
	assertPublicationGate
} = require('../backend/services/creditEvidenceLedger')

const PRIVATE_SENTINEL = 'PRIVATE_SENTINEL_INSTITUTION_AMOUNT'
const PRIVATE_DATE = '2026-08-13'
const PRIVATE_TAIL = '5414'
const PRIVATE_HASH = 'cafebabecafebabecafebabecafebabe'

function blockedArtifacts() {
	return {
		manifest: {
			status: 'rejected',
			documentId: `doc_v2_${PRIVATE_SENTINEL}`,
			manifestHash: `mh_v2_${PRIVATE_HASH}`,
			pages: [
				{ status: 'complete', textDigest: PRIVATE_SENTINEL, quote: PRIVATE_DATE },
				{ status: 'rejected', pageId: `pg_v2_${PRIVATE_TAIL}`, span: [0, 22] }
			],
			coverage: {
				declaredPageCount: 3,
				processedPageCount: 2,
				missingPageNos: [3],
				duplicatePageNos: [1]
			}
		},
		evidenceGraph: {
			status: 'rejected',
			manifestHash: `mh_v2_${PRIVATE_HASH}`,
			evidenceGraphHash: `eg_v2_${PRIVATE_HASH}`,
			nodes: [
				{ nodeId: `ev_v2_${PRIVATE_SENTINEL}`, value: PRIVATE_TAIL },
				{ nodeId: `ev_v2_${PRIVATE_HASH}`, sourceText: PRIVATE_DATE }
			],
			unresolved: [
				{ targetKey: 'loan:91:balance', critical: true, reason: 'ENTITY_SOURCE_ROW_MISMATCH', quote: PRIVATE_SENTINEL },
				{ critical: true, reason: PRIVATE_SENTINEL, blockId: `blk_v2_${PRIVATE_TAIL}` },
				{ critical: false, reason: 'SOURCE_MATCH_MISSING', sourceSpan: [0, 9] }
			]
		},
		factLedger: {
			status: 'blocked',
			evidenceGraphHash: `eg_v2_${PRIVATE_HASH}`,
			factLedgerHash: `fl_v2_${PRIVATE_HASH}`,
			facts: [
				{ critical: true, status: 'unknown', institution: PRIVATE_SENTINEL, amount: 999999 },
				{ critical: false, status: 'accepted', date: PRIVATE_DATE }
			],
			sections: [
				{
					name: 'active_loans',
					expectedCount: 8,
					acceptedEntityCount: 7,
					declaredEntityCount: 8,
					status: 'incomplete',
					basis: 'source-account-overview-pdf-geometry-v2'
				},
				{
					name: 'query_details',
					expectedCount: 85,
					acceptedEntityCount: 84,
					declaredEntityCount: 85,
					status: 'incomplete',
					basis: `source-${PRIVATE_SENTINEL}`
				},
				{ name: PRIVATE_SENTINEL, basis: PRIVATE_DATE }
			],
			conflicts: [
				{ code: 'CARD_FACILITY_RELATION_UNRESOLVED', entityIds: [PRIVATE_SENTINEL] },
				{ code: PRIVATE_SENTINEL, relationId: `rel_v2_${PRIVATE_HASH}` }
			]
		},
		derivedAnalysis: {
			status: 'blocked',
			inputs: { anchorDate: PRIVATE_DATE, factLedgerHash: `fl_v2_${PRIVATE_HASH}` },
			derivedAnalysisHash: `da_v2_${PRIVATE_HASH}`,
			metrics: {
				totalDebt: {
					status: 'blocked',
					formulaId: 'total-debt-v2',
					reason: 'FACT_LEDGER_BLOCKED',
					value: PRIVATE_SENTINEL
				},
				privateMetric: {
					status: 'blocked',
					formulaId: PRIVATE_SENTINEL,
					reason: PRIVATE_DATE,
					value: PRIVATE_TAIL
				},
				ignoredMetric: {
					status: 'computed',
					formulaId: PRIVATE_SENTINEL,
					value: PRIVATE_HASH
				}
			}
		}
	}
}

const ALLOWED_DIAGNOSTIC_KEYS = new Set([
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
	'reasons',
	'value',
	'count',
	'ledger',
	'criticalFailureCount',
	'sections',
	'name',
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

function assertOnlyAllowlistedKeys(value) {
	if (Array.isArray(value)) {
		for (const item of value) assertOnlyAllowlistedKeys(item)
		return
	}
	if (!value || typeof value !== 'object') return
	for (const [key, child] of Object.entries(value)) {
		assert.ok(ALLOWED_DIAGNOSTIC_KEYS.has(key), `unexpected diagnostic key: ${key}`)
		assertOnlyAllowlistedKeys(child)
	}
}

function assertNoPrivateMaterial(value) {
	const serialized = JSON.stringify(value)
	for (const secret of [
		PRIVATE_SENTINEL,
		PRIVATE_DATE,
		PRIVATE_TAIL,
		PRIVATE_HASH,
		'doc_v2_',
		'pg_v2_',
		'blk_v2_',
		'ev_v2_',
		'rel_v2_',
		'mh_v2_',
		'eg_v2_',
		'fl_v2_',
		'da_v2_'
	]) {
		assert.equal(serialized.includes(secret), false, `diagnostic leaked ${secret}`)
	}
}

test('safe evidence diagnostic exposes only allowlisted aggregate counts and enums', () => {
	const diagnostic = buildSafeEvidenceDiagnostic(blockedArtifacts())

	assertOnlyAllowlistedKeys(diagnostic)
	assertNoPrivateMaterial(diagnostic)
	assert.deepEqual(diagnostic.graph.unresolvedReasons, [
		{ value: 'ENTITY_SOURCE_ROW_MISMATCH', count: 1 },
		{ value: 'SOURCE_MATCH_MISSING', count: 1 },
		{ value: 'OTHER', count: 1 }
	])
	assert.deepEqual(diagnostic.graph.unresolvedByTarget, [
		{
			name: 'loan.balance',
			count: 1,
			reasons: [{ value: 'ENTITY_SOURCE_ROW_MISMATCH', count: 1 }]
		},
		{
			name: 'OTHER',
			count: 2,
			reasons: [
				{ value: 'SOURCE_MATCH_MISSING', count: 1 },
				{ value: 'OTHER', count: 1 }
			]
		}
	])
	assert.deepEqual(diagnostic.failedChecks, [
		'MANIFEST_COMPLETE',
		'EVIDENCE_COMPLETE',
		'LEDGER_READY',
		'DERIVED_VALIDATED',
		'HASH_INTEGRITY_VALID'
	])
	assert.equal(diagnostic.manifest.missingPageCount, 1)
	assert.equal(diagnostic.manifest.duplicatePageCount, 1)
	assert.deepEqual(diagnostic.ledger.conflictCodes, [
		{ value: 'CARD_FACILITY_RELATION_UNRESOLVED', count: 1 },
		{ value: 'OTHER', count: 1 }
	])
	assert.equal(diagnostic.ledger.sections[1].basis, 'other-source-basis')
	assert.deepEqual(diagnostic.derived.blockedReasons, [
		{ value: 'FACT_LEDGER_BLOCKED', count: 1 },
		{ value: 'OTHER', count: 1 }
	])
	assert.deepEqual(diagnostic.derived.blockedFormulas, [
		{ value: 'total-debt-v2', count: 1 },
		{ value: 'OTHER', count: 1 }
	])
})

test('safe evidence diagnostic is byte-stable across five builds', () => {
	const serialized = Array.from({ length: 5 }, () =>
		JSON.stringify(buildSafeEvidenceDiagnostic(blockedArtifacts()))
	)
	assert.equal(new Set(serialized).size, 1)
})

test('publication gate error carries the same safe diagnostic', () => {
	const artifacts = blockedArtifacts()
	let error
	try {
		assertPublicationGate(artifacts)
	} catch (caught) {
		error = caught
	}
	assert.equal(error?.code, 'EVIDENCE_PUBLICATION_BLOCKED')
	assert.ok(error?.diagnostic)
	assertOnlyAllowlistedKeys(error.diagnostic)
	assertNoPrivateMaterial(error.diagnostic)
	assert.equal(JSON.stringify(error.diagnostic), JSON.stringify(buildSafeEvidenceDiagnostic(artifacts)))
})
