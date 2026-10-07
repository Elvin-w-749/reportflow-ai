import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildAnalysisExecutionViews } from '../src/services/analysisExecution.js'

describe('async analysis execution metadata', () => {
	it('keeps cache transport state in the UI view and out of persisted report data', () => {
		const analysisKey = `ak_v3_${'a'.repeat(64)}`
		const resultHash = `rh_v1_${'b'.repeat(64)}`
		const serverExecution = {
			analysisKey,
			resultHash,
			cacheHit: false,
			cacheSource: 'async-job',
			internalDiagnostic: 'not-for-persistence'
		}
		const first = buildAnalysisExecutionViews(serverExecution, { cacheHit: false })
		const reused = buildAnalysisExecutionViews(serverExecution, { cacheHit: true })

		assert.deepEqual(first.persisted, reused.persisted)
		assert.deepEqual(first.persisted, {
			analysisKey,
			resultHash
		})
		assert.equal(first.ui.cacheHit, false)
		assert.equal(reused.ui.cacheHit, true)
		assert.equal(reused.persisted.cacheHit, undefined)
		assert.equal(reused.persisted.cacheSource, undefined)
		assert.equal(reused.persisted.internalDiagnostic, undefined)
	})

	it('does not persist malformed or unversioned audit identities', () => {
		const views = buildAnalysisExecutionViews({
			analysisKey: 'ak_v3_short',
			resultHash: 'not-a-result-hash'
		})

		assert.deepEqual(views.persisted, {})
	})
})
