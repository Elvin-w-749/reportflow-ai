import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { inspectMatchReportContext, saveMatchReportContext } from '../src/services/reportMatchContext.js'

const originalUni = globalThis.uni

afterEach(() => {
	if (originalUni === undefined) delete globalThis.uni
	else globalThis.uni = originalUni
})

const installStorage = (value) => {
	globalThis.uni = {
		getStorageSync: () => value,
		removeStorageSync: () => {}
	}
}

describe('pinned match report context inspection', () => {
	it('distinguishes an absent context from an invalid pinned context', () => {
		installStorage('')
		assert.deepEqual(inspectMatchReportContext(), {
			present: false,
			invalid: false,
			reason: '',
			context: null
		})

		installStorage('{broken-json')
		assert.deepEqual(inspectMatchReportContext(), {
			present: true,
			invalid: true,
			reason: 'malformed',
			context: null
		})

		for (const malformedId of [[], ['REPORT_CURRENT'], {}, 0, true]) {
			installStorage(JSON.stringify({ reportId: malformedId, savedAt: Date.now() }))
			assert.deepEqual(inspectMatchReportContext(), {
				present: true,
				invalid: true,
				reason: 'malformed',
				context: null
			})
		}
	})

	it('keeps an expired pinned report identifiable instead of treating it as absent', () => {
		installStorage(JSON.stringify({ reportId: 'REPORT_PINNED', savedAt: Date.now() - 31 * 60 * 1000 }))
		const result = inspectMatchReportContext()
		assert.equal(result.present, true)
		assert.equal(result.invalid, true)
		assert.equal(result.reason, 'expired')
		assert.equal(result.context.reportId, 'REPORT_PINNED')
	})

	it('returns a valid pinned context without mutation', () => {
		const context = { reportId: 'REPORT_CURRENT', savedAt: Date.now(), source: 'detail' }
		installStorage(JSON.stringify(context))
		assert.deepEqual(inspectMatchReportContext(), {
			present: true,
			invalid: false,
			reason: '',
			context
		})
	})

	it('does not persist an array or object report id as a scalar match context', () => {
		let saved = null
		globalThis.uni = {
			setStorageSync: (_key, value) => { saved = value },
			getStorageSync: () => saved,
			removeStorageSync: () => {}
		}
		for (const malformed of [[], ['REPORT_CURRENT'], {}, 0, true]) {
			assert.equal(saveMatchReportContext({ id: malformed }), false)
		}
		assert.equal(saveMatchReportContext({ id: 'REPORT_CURRENT' }), true)
		assert.equal(JSON.parse(saved).reportId, 'REPORT_CURRENT')
	})
})
