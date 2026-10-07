import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
	terminalPolicySignatures,
	validTerminalFailureEnvelope
} from '../src/services/analysisTerminalPolicy.js'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const { TERMINAL_CODE_DEFINITIONS } = require(
	path.join(root, 'backend/backend/utils/trustedAnalysisEvent.js')
)

const backendSignatures = Object.fromEntries(
	Object.entries(TERMINAL_CODE_DEFINITIONS).map(([code, configured]) => [
		code,
		(Array.isArray(configured) ? configured : [configured])
			.map((item) => `${item.errorClass}\0${item.stage}\0${item.retryable ? '1' : '0'}\0${item.safeMessageKey}`)
			.sort()
	])
)

test('frontend terminal tuples are in byte-for-byte parity with the backend closed policy', () => {
	assert.deepEqual(terminalPolicySignatures(), backendSignatures)
	for (const [code, configured] of Object.entries(TERMINAL_CODE_DEFINITIONS)) {
		for (const item of (Array.isArray(configured) ? configured : [configured])) {
			assert.equal(validTerminalFailureEnvelope({
				code,
				errorClass: item.errorClass,
				stage: item.stage,
				retryable: item.retryable,
				safeMessageKey: item.safeMessageKey
			}), true, code)
			assert.equal(validTerminalFailureEnvelope({
				code,
				errorClass: item.errorClass === 'schema_permanent' ? 'evidence_permanent' : 'schema_permanent',
				stage: item.stage,
				retryable: item.retryable,
				safeMessageKey: item.safeMessageKey
			}), false, `${code}:wrong-class`)
		}
	}
})

test('regex-shaped PII codes and stages can never become a branded terminal tuple', () => {
	assert.equal(validTerminalFailureEnvelope({
		code: 'PRIVATE_CUSTOMER_13800138000',
		errorClass: 'schema_permanent',
		stage: 'private_customer_20260818',
		retryable: false,
		safeMessageKey: 'provider-response-invalid'
	}), false)
})
