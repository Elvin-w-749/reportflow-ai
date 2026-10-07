import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
	assertFastPdfOwnershipEvidence,
	isFastPdfOwnershipEvidenceFailure
} from '../src/services/analysisOwnershipEvidence.js'

describe('fast PDF ownership evidence', () => {
	it('accepts a mapped analysis only when both name and identity evidence exist', () => {
		const analysis = {
			report: { totalScore: 72 },
			dimensions: { totalAccountCount: 1 },
			basicInfo: { name: '测试甲', idLast4: '2718' }
		}

		assert.equal(assertFastPdfOwnershipEvidence(analysis), analysis)
	})

	it('throws a dedicated failure when a usable report omits ownership evidence', () => {
		assert.throws(
			() => assertFastPdfOwnershipEvidence({
				report: { totalScore: 72 },
				dimensions: { totalAccountCount: 1 },
				basicInfo: { name: '' }
			}),
			(error) => {
				assert.equal(isFastPdfOwnershipEvidenceFailure(error), true)
				assert.equal(error.code, 'OCR_OWNERSHIP_EVIDENCE_MISSING')
				assert.deepEqual(error.missingEvidence, ['name', 'identity'])
				return true
			}
		)
	})
})
