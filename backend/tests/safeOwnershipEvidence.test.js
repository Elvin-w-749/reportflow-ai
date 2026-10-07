'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { attachSafeScannedOwnershipEvidence } = require('../server.js')

test('verified scan receives boolean-only ownership provenance', () => {
	const output = attachSafeScannedOwnershipEvidence({ meta: { report_type: 'personal' } }, true)
	assert.deepEqual(output._ownership_evidence, {
		version: 1,
		source: 'scanned-pdf-first-page',
		nameRecognized: true,
		identityRecognized: true,
		identityChecksumValid: true,
		verified: true
	})
	assert.doesNotMatch(JSON.stringify(output._ownership_evidence), /name\s*:|identity\s*:/i)
})

test('unverified or non-object result never receives ownership provenance', () => {
	const original = { meta: {} }
	assert.equal(attachSafeScannedOwnershipEvidence(original, false), original)
	assert.equal(attachSafeScannedOwnershipEvidence(null, true), null)
})
