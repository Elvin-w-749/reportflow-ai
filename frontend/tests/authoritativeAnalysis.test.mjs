import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'

import {
	AUTHORITATIVE_EVIDENCE_PATHS,
	assertAuthoritativeServerAnalysis,
	executeAuthoritativeAnalysisPath,
	getDeterministicDimensions,
	getServerAnalysisAuthority,
	isAuthoritativeServerAnalysis,
	markServerAnalysisResponse
} from '../src/services/authoritativeAnalysis.js'

const ANALYSIS_KEY = `ak_v3_${'a'.repeat(64)}`
const RESULT_HASH = `rh_v1_${'b'.repeat(64)}`
const MANIFEST_HASH = `mh_v2_${'1'.repeat(64)}`
const EVIDENCE_HASH = `eg_v2_${'2'.repeat(64)}`
const FACT_HASH = `fl_v2_${'3'.repeat(64)}`
const METRIC_HASH = `da_v2_${'4'.repeat(64)}`

const extractStringArray = (source, marker) => {
	const markerIndex = source.indexOf(marker)
	assert.notEqual(markerIndex, -1, `missing scope marker: ${marker}`)
	const arrayBody = source.slice(markerIndex + marker.length).match(/^\s*\[([\s\S]*?)\]/)?.[1] || ''
	return [...arrayBody.matchAll(/'([^']+)'/g)].map((match) => match[1])
}

// Mirrors the response contract produced by
// backend/backend/services/analysisCoordinator.js
// after finalizeExtractedCreditFacts().
const backendFixture = () => markServerAnalysisResponse({
	derivation_meta: {
		mode: 'deterministic-v1',
		anchor_date: '2026-06-30',
		model_role: 'raw-facts-only',
		evidence_mode: 'evidence-v2',
		evidence_hash: EVIDENCE_HASH,
		fact_hash: FACT_HASH,
		metric_hash: METRIC_HASH
	},
	analysis_meta: {
		analysisKey: ANALYSIS_KEY,
		resultHash: RESULT_HASH,
		authoritative: true,
		authority: 'server-deterministic',
		authoritativeScope: [...AUTHORITATIVE_EVIDENCE_PATHS],
		cachePolicy: {
			persistent: true,
			stableAcrossRestart: true
		}
	},
	evidence_meta: {
		version: 'evidence-v2',
		status: 'publishable',
		publication_gate: 'passed',
		manifest_hash: MANIFEST_HASH,
		evidence_hash: EVIDENCE_HASH,
		fact_hash: FACT_HASH,
		metric_hash: METRIC_HASH,
		fact_count: 1,
		supported_fact_count: 1,
		authoritative_scope: [...AUTHORITATIVE_EVIDENCE_PATHS]
	},
	deterministic_dimensions: {
		version: 'deterministic-dimensions-v1',
		authority: 'server',
		totalDebt: 90000,
		cardUtilizationRate: 0.5,
		q1: 1,
		q6: 2
	},
	credit_debt: {
		total_debt: 90000,
		debt_ratio: 0.45,
		credit_loans: { total_balance: 40000 },
		credit_cards: {
			total_limit: 100000,
			total_used: 50000,
			utilization_used: 50000,
			usage_rate: 0.5,
			shared_group_count: 0
		}
	},
	query_analysis: {
		summary: {
			last_1m: { total: 1 },
			last_3m: { total: 2 },
			last_6m: { total: 2 },
			last_12m: { total: 2 }
		}
	},
	primary_rule_score: { score: 100 },
	six_dimensions: {
		credit_history: 95,
		query_frequency: 90,
		account_structure: 88,
		repayment_record: 100
	}
})

describe('authoritative report analysis routing', () => {
	it('keeps the frontend field registry in parity with the backend evidence contract', () => {
		const producerSource = readFileSync(new URL('../../backend/backend/services/creditAnalysisService.js', import.meta.url), 'utf8')
		const coordinatorSource = readFileSync(new URL('../../backend/backend/services/analysisCoordinator.js', import.meta.url), 'utf8')
		const producerScope = extractStringArray(producerSource, 'authoritative_scope:')
		const coordinatorScope = extractStringArray(coordinatorSource, 'const AUTHORITATIVE_SCOPE_FIELDS = Object.freeze(')

		assert.deepEqual(AUTHORITATIVE_EVIDENCE_PATHS, producerScope)
		assert.deepEqual(AUTHORITATIVE_EVIDENCE_PATHS, coordinatorScope)
		assert.equal(AUTHORITATIVE_EVIDENCE_PATHS.includes('credit_debt.credit_cards.utilization_used'), true)
	})

	it('recognizes deterministic-v1 through supported response wrappers', () => {
		const response = {
			data: {
				result: {
					credit_report_full: backendFixture()
				}
			}
		}

		const authority = getServerAnalysisAuthority(response)
		assert.equal(isAuthoritativeServerAnalysis(response), true)
		assert.equal(authority.authoritative, true)
		assert.equal(authority.compatibility, false)
		assert.equal(authority.mode, 'deterministic-v1')
		assert.equal(authority.wholeObjectAuthoritative, false)
		assert.equal(authority.fieldScoped, true)
		assert.equal(authority.scopeComplete, true)
		assert.deepEqual(authority.authoritativeScope, AUTHORITATIVE_EVIDENCE_PATHS)
		assert.equal(authority.anchorDate, '2026-06-30')
		assert.equal(authority.modelRole, 'raw-facts-only')
		assert.equal(authority.analysisKey, ANALYSIS_KEY)
		assert.equal(authority.resultHash, RESULT_HASH)
		assert.equal(authority.cachePolicy.persistent, true)
		assert.equal(authority.cachePolicy.stableAcrossRestart, true)
		assert.equal(assertAuthoritativeServerAnalysis(response), response)
	})

	it('routes both PDF and image successes through the same server-only contract', async () => {
		let pdfCalls = 0
		let imageCalls = 0
		const pdf = await executeAuthoritativeAnalysisPath({
			fileType: 'pdf',
			runPdfServer: async () => {
				pdfCalls += 1
				return backendFixture()
			},
			runImageServer: async () => {
				imageCalls += 1
				return backendFixture()
			}
		})
		const image = await executeAuthoritativeAnalysisPath({
			fileType: 'image',
			runPdfServer: async () => {
				pdfCalls += 1
				return backendFixture()
			},
			runImageServer: async () => {
				imageCalls += 1
				return backendFixture()
			}
		})
		assert.equal(pdf.derivation_meta.mode, 'deterministic-v1')
		assert.equal(image.derivation_meta.mode, 'deterministic-v1')
		assert.deepEqual({ pdfCalls, imageCalls }, { pdfCalls: 1, imageCalls: 1 })
	})

	it('labels historical responses as compatibility data instead of deterministic output', () => {
		const response = { derivation_meta: { mode: 'legacy-v2' }, report: { totalScore: 72 } }
		const authority = getServerAnalysisAuthority(response)

		assert.equal(authority.authoritative, false)
		assert.equal(authority.compatibility, true)
		assert.equal(authority.mode, 'legacy-compatible')
		assert.equal(authority.serverMode, 'legacy-v2')
		assert.throws(
			() => assertAuthoritativeServerAnalysis(response),
			(error) => error.code === 'NON_AUTHORITATIVE_ANALYSIS_RESULT'
		)
	})

	it('reads optional deterministic_dimensions without requiring that field', () => {
		assert.deepEqual(getDeterministicDimensions({ derivation_meta: { mode: 'deterministic-v1' } }), {})
		assert.deepEqual(
			getDeterministicDimensions({
				data: {
					deterministic_dimensions: {
						total_debt: 88000,
						card_utilization_rate: 0.42
					}
				}
			}),
			{ total_debt: 88000, card_utilization_rate: 0.42 }
		)
	})

	it('does not call the legacy AI fallback when PDF server analysis rejects', async () => {
		let aiFallbackCalls = 0
		await assert.rejects(
			executeAuthoritativeAnalysisPath({
				fileType: 'pdf',
				runPdfServer: async () => {
					throw new Error('authoritative server unavailable')
				},
				runImageServer: async () => ({ ok: true }),
				runLegacy: async () => {
					aiFallbackCalls += 1
				}
			}),
			/authoritative server unavailable/
		)
		assert.equal(aiFallbackCalls, 0)
	})

	it('propagates timeout and HTTP 500 failures without invoking a legacy runner', async () => {
		for (const failure of [
			Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
			Object.assign(new Error('server failed'), { status: 500 })
		]) {
			let legacyCalls = 0
			await assert.rejects(executeAuthoritativeAnalysisPath({
				fileType: 'pdf',
				runPdfServer: async () => { throw failure },
				runImageServer: async () => backendFixture(),
				runLegacy: async () => { legacyCalls += 1 }
			}), failure)
			assert.equal(legacyCalls, 0)
		}
	})

	it('rejects non-authoritative and incomplete deterministic payloads without fallback', async () => {
		const malformed = [
			{ report: { totalScore: 99 } },
			{ derivation_meta: { mode: 'deterministic-v1' } }
		]
		for (const payload of malformed) {
			let legacyCalls = 0
			await assert.rejects(executeAuthoritativeAnalysisPath({
				fileType: 'image',
				runPdfServer: async () => backendFixture(),
				runImageServer: async () => payload,
				runLegacy: async () => { legacyCalls += 1 }
			}), (error) => (
				error.code === 'NON_AUTHORITATIVE_ANALYSIS_RESULT' ||
				error.code === 'INCOMPLETE_AUTHORITATIVE_ANALYSIS_RESULT'
			))
			assert.equal(legacyCalls, 0)
		}
	})

	it('rejects deterministic markers without persistent audit identity', () => {
		const missingAnalysisKey = backendFixture()
		delete missingAnalysisKey.analysis_meta.analysisKey
		const missingResultHash = backendFixture()
		delete missingResultHash.analysis_meta.resultHash
		const malformedAuditIdentity = backendFixture()
		malformedAuditIdentity.analysis_meta.analysisKey = 'anything'
		malformedAuditIdentity.analysis_meta.resultHash = 'anything'
		const volatileCache = backendFixture()
		volatileCache.analysis_meta.cachePolicy.stableAcrossRestart = false
		const missingServerAttestation = backendFixture()
		delete missingServerAttestation.analysis_meta.authoritative
		const wrongAuthority = backendFixture()
		wrongAuthority.analysis_meta.authority = 'client-deterministic'

		for (const payload of [
			missingAnalysisKey,
			missingResultHash,
			malformedAuditIdentity,
			volatileCache,
			missingServerAttestation,
			wrongAuthority
		]) {
			const authority = getServerAnalysisAuthority(payload)
			assert.equal(authority.authoritative, false)
			assert.equal(authority.compatibility, true)
			assert.equal(authority.mode, 'deterministic-incomplete')
			assert.throws(
				() => assertAuthoritativeServerAnalysis(payload),
				(error) => error.code === 'INCOMPLETE_AUTHORITATIVE_ANALYSIS_RESULT'
			)
		}
	})

	it('requires a publishable compact evidence gate from the same branded root', () => {
		const missingEvidence = backendFixture()
		delete missingEvidence.evidence_meta
		const blockedEvidence = backendFixture()
		blockedEvidence.evidence_meta.publication_gate = 'blocked'
		const mismatchedEvidence = backendFixture()
		mismatchedEvidence.derivation_meta.metric_hash = `da_v2_${'9'.repeat(64)}`

		for (const payload of [missingEvidence, blockedEvidence, mismatchedEvidence]) {
			const authority = getServerAnalysisAuthority(payload)
			assert.equal(authority.evidenceComplete, false)
			assert.equal(authority.authoritative, false)
		}
	})

	it('never lets copied JSON self-declare server authority', () => {
		const copied = JSON.parse(JSON.stringify(backendFixture()))
		const authority = getServerAnalysisAuthority(copied)
		assert.equal(authority.responseTrusted, false)
		assert.equal(authority.authoritative, false)
		assert.throws(
			() => assertAuthoritativeServerAnalysis(copied),
			(error) => error.code === 'INCOMPLETE_AUTHORITATIVE_ANALYSIS_RESULT'
		)
	})

	it('does not promote structural completeness when authoritative scope is missing or partial', () => {
		const missingScope = backendFixture()
		delete missingScope.analysis_meta.authoritativeScope
		delete missingScope.evidence_meta.authoritative_scope
		const partialScope = backendFixture()
		partialScope.analysis_meta.authoritativeScope = ['primary_rule_score.score']

		for (const payload of [missingScope, partialScope]) {
			const authority = getServerAnalysisAuthority(payload)
			assert.equal(authority.envelopeValid, true)
			assert.equal(authority.scopeComplete, false)
			assert.equal(authority.authoritative, false)
			assert.throws(
				() => assertAuthoritativeServerAnalysis(payload),
				(error) => error.code === 'INCOMPLETE_AUTHORITATIVE_ANALYSIS_RESULT'
			)
		}
		assert.deepEqual(getServerAnalysisAuthority(partialScope).authoritativeScope, ['primary_rule_score.score'])
	})

	it('does not require non-scope debt ratio, dimensions, or four-dimension display fields', () => {
		const payload = backendFixture()
		delete payload.credit_debt.debt_ratio
		delete payload.deterministic_dimensions
		delete payload.six_dimensions

		const authority = getServerAnalysisAuthority(payload)
		assert.equal(authority.envelopeValid, true)
		assert.equal(authority.scopeValuesComplete, true)
		assert.equal(authority.contractComplete, false)
		assert.equal(authority.authoritative, true)
		assert.equal(assertAuthoritativeServerAnalysis(payload), payload)
	})

	it('rejects null deterministic numeric fields instead of coercing them to zero', () => {
		const mutate = [
			(value) => { value.credit_debt.total_debt = null },
			(value) => { value.primary_rule_score.score = null },
			(value) => { value.query_analysis.summary.last_1m.total = null }
		]
		for (const change of mutate) {
			const payload = backendFixture()
			change(payload)
			assert.throws(
				() => assertAuthoritativeServerAnalysis(payload),
				(error) => error.code === 'INCOMPLETE_AUTHORITATIVE_ANALYSIS_RESULT'
			)
		}
	})

	it('rejects out-of-range, string, and non-monotonic scoped values', () => {
		const negativeDebt = backendFixture()
		negativeDebt.credit_debt.total_debt = -1
		const stringScore = backendFixture()
		stringScore.primary_rule_score.score = '100'
		const fractionalQuery = backendFixture()
		fractionalQuery.query_analysis.summary.last_3m.total = 1.5
		const nonMonotonicQuery = backendFixture()
		nonMonotonicQuery.query_analysis.summary.last_3m.total = 0

		for (const payload of [negativeDebt, stringScore, fractionalQuery, nonMonotonicQuery]) {
			const authority = getServerAnalysisAuthority(payload)
			assert.equal(authority.scopeValuesComplete, false)
			assert.equal(authority.authoritative, false)
		}
	})

	it('does not call the legacy AI fallback when image analysis returns no result', async () => {
		let aiFallbackCalls = 0
		await assert.rejects(
			executeAuthoritativeAnalysisPath({
				fileType: 'image',
				runPdfServer: async () => ({ ok: true }),
				runImageServer: async () => null,
				runLegacy: async () => {
					aiFallbackCalls += 1
				}
			}),
			(error) => error.code === 'EMPTY_AUTHORITATIVE_ANALYSIS_RESULT'
		)
		assert.equal(aiFallbackCalls, 0)
	})

	it('fails closed for unsupported file types', async () => {
		let serverCalls = 0
		let aiFallbackCalls = 0
		await assert.rejects(
			executeAuthoritativeAnalysisPath({
				fileType: 'text',
				runPdfServer: async () => {
					serverCalls += 1
				},
				runImageServer: async () => {
					serverCalls += 1
				},
				runLegacy: async () => {
					aiFallbackCalls += 1
				}
			}),
			(error) => error.code === 'UNSUPPORTED_REPORT_FILE_TYPE'
		)
		assert.equal(serverCalls, 0)
		assert.equal(aiFallbackCalls, 0)
	})
})
