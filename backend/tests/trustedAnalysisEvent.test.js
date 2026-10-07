'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

process.env.NODE_ENV = 'test'
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-trusted-event-log-'))

const {
	SUPPORT_REF_RE,
	TRACE_ID_RE,
	EVENT_CONTRACT_VERSION,
	SAFE_MESSAGE_KEYS,
	TERMINAL_CODE_DEFINITIONS,
	createSupportRef,
	createTraceId,
	currentRuntimeSnapshot,
	createTerminalEventSnapshot,
	buildTrustedTerminalEvent,
	parseTrustedTerminalEventRow
} = require('../backend/utils/trustedAnalysisEvent')

function failureInput(overrides = {}) {
	return {
		supportRef: createSupportRef(),
		traceId: createTraceId(),
		status: 'failed',
		code: 'EVIDENCE_PUBLICATION_BLOCKED',
		errorClass: 'evidence_permanent',
		stage: 'evidence-publication',
		diagnostic: {
			version: 1,
			httpStatus: 422,
			evidenceIssueCount: 2,
			unknownCount: 999,
			extra: 'PRIVATE_REPORT_TEXT_SENTINEL'
		},
		serverTime: '2026-08-18T01:02:03.004Z',
		...overrides
	}
}

test('support references and traces are independent CSPRNG identifiers', () => {
	const refs = new Set()
	const traces = new Set()
	for (let index = 0; index < 256; index += 1) {
		const supportRef = createSupportRef()
		const traceId = createTraceId()
		assert.match(supportRef, SUPPORT_REF_RE)
		assert.match(traceId, TRACE_ID_RE)
		refs.add(supportRef)
		traces.add(traceId)
	}
	assert.equal(refs.size, 256)
	assert.equal(traces.size, 256)
})

test('trusted terminal events retain only the closed safe schema', () => {
	const event = createTerminalEventSnapshot(failureInput())
	assert.deepEqual(Object.keys(event), [
		'schemaVersion', 'supportRef', 'traceId', 'status', 'code', 'errorClass',
		'stage', 'retryable', 'safeMessageKey', 'diagnostic', 'release',
		'versions', 'serverTime'
	])
	assert.equal(event.schemaVersion, EVENT_CONTRACT_VERSION)
	assert.equal(event.retryable, false)
	assert.equal(event.safeMessageKey, 'analysis-publication-blocked')
	assert.deepEqual(event.diagnostic, {
		version: 1,
		httpStatus: 422,
		evidenceIssueCount: 2
	})
	assert.doesNotMatch(JSON.stringify(event), /PRIVATE_REPORT_TEXT|unknownCount|extra/)

	const success = createTerminalEventSnapshot({
		supportRef: createSupportRef(),
		traceId: createTraceId(),
		status: 'succeeded',
		code: null,
		errorClass: null,
		stage: 'succeeded',
		diagnostic: { version: 1, extra: 'PRIVATE_SUCCESS_SENTINEL' },
		serverTime: '2026-08-18T01:02:03.004Z'
	})
	assert.equal(success.code, null)
	assert.equal(success.errorClass, null)
	assert.equal(success.retryable, null)
	assert.equal(success.safeMessageKey, null)
	assert.equal(success.diagnostic, null)
	assert.throws(
		() => buildTrustedTerminalEvent({ ...success, diagnostic: { version: 1 } }),
		(error) => error && error.code === 'TRUSTED_ANALYSIS_EVENT_INVALID'
	)
	const successRow = {
		schema_version: success.schemaVersion,
		support_ref: success.supportRef,
		trace_id: success.traceId,
		status: success.status,
		code: null,
		error_class: null,
		stage: success.stage,
		retryable: null,
		safe_message_key: null,
		diagnostic_json: 'null',
		release_json: JSON.stringify(success.release),
		versions_json: JSON.stringify(success.versions),
		server_time: success.serverTime
	}
	assert.equal(parseTrustedTerminalEventRow(successRow).diagnostic, null)
	assert.equal(parseTrustedTerminalEventRow({ ...successRow, diagnostic_json: '{"version":1}' }), null)
})

test('phase 0 public message keys and every public/runtime producer code stay closed', () => {
	assert.deepEqual([...SAFE_MESSAGE_KEYS].sort(), [
		'analysis-deadline-exceeded',
		'analysis-input-rejected',
		'analysis-publication-blocked',
		'evidence-structure-unproven',
		'provider-configuration-unavailable',
		'provider-connection-interrupted',
		'provider-response-invalid',
		'provider-temporarily-unavailable',
		'provider-timeout'
	])
	const serverSource = fs.readFileSync(path.resolve(__dirname, '../server.js'), 'utf8')
	const publicBlock = serverSource.slice(
		serverSource.indexOf('const PUBLIC_ANALYSIS_ERRORS'),
		serverSource.indexOf('function analysisExecutionError')
	)
	const publicCodes = [...publicBlock.matchAll(/^\s*([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1])
	for (const code of publicCodes) {
		assert.ok(TERMINAL_CODE_DEFINITIONS[code], `missing public terminal code: ${code}`)
	}
	for (const code of [
		'DETERMINISTIC_INPUT_INCOMPLETE', 'DETERMINISTIC_OUTPUT_INCOMPLETE',
		'PDF_PAGE_OUT_OF_RANGE', 'RAPIDOCR_CONFIG_ERROR', 'RAPIDOCR_DISABLED',
		'RAPIDOCR_INVALID_INPUT', 'RAPIDOCR_INVALID_RESULT',
		'RAPIDOCR_MODEL_INTEGRITY_ERROR', 'RAPIDOCR_QUEUE_TIMEOUT'
	]) assert.ok(TERMINAL_CODE_DEFINITIONS[code], code)
})

test('unknown fields and scalar type confusion fail closed', () => {
	for (const key of [
		'extra', 'details', 'meta', 'userId', 'scopeHmac', 'jobId', 'analysisKey',
		'documentId', 'resultHash', 'fileName', 'filePath', 'amount', 'reportDate'
	]) {
		assert.throws(
			() => createTerminalEventSnapshot({ ...failureInput(), [key]: 'PII_SENTINEL' }),
			(error) => error && error.code === 'TRUSTED_ANALYSIS_EVENT_INVALID',
			key
		)
	}

	for (const key of [
		'supportRef', 'traceId', 'status', 'code', 'errorClass', 'stage', 'serverTime'
	]) {
		const original = failureInput()
		assert.throws(
			() => createTerminalEventSnapshot({ ...original, [key]: [original[key]] }),
			(error) => error && error.code === 'TRUSTED_ANALYSIS_EVENT_INVALID',
			key
		)
	}

	const runtime = currentRuntimeSnapshot()
	const complete = createTerminalEventSnapshot(failureInput(), runtime)
	for (const key of Object.keys(complete.release)) {
		assert.throws(
			() => buildTrustedTerminalEvent({
				...complete,
				release: { ...complete.release, [key]: [complete.release[key]] }
			}),
			(error) => error && error.code === 'TRUSTED_ANALYSIS_EVENT_INVALID'
		)
	}
	for (const key of Object.keys(complete.versions)) {
		assert.throws(
			() => buildTrustedTerminalEvent({
				...complete,
				versions: { ...complete.versions, [key]: [complete.versions[key]] }
			}),
			(error) => error && error.code === 'TRUSTED_ANALYSIS_EVENT_INVALID'
		)
	}
})

test('untrusted release and version environment values become null, never trusted text', () => {
	const previous = {
		release: process.env.RPT_RELEASE_ID,
		commit: process.env.RPT_GIT_COMMIT,
		model: process.env.DEEPSEEK_TEXT_MODEL,
		pipeline: process.env.CREDIT_ANALYSIS_PIPELINE_VERSION
	}
	try {
		process.env.RPT_RELEASE_ID = 'PRIVATE_CUSTOMER_13800138000'
		process.env.RPT_GIT_COMMIT = 'not-a-commit-PRIVATE_SENTINEL'
		process.env.DEEPSEEK_TEXT_MODEL = 'deepseek-13800138000'
		process.env.CREDIT_ANALYSIS_PIPELINE_VERSION = 'credit-analysis-C:\\PRIVATE\\REPORT.pdf'
		const runtime = currentRuntimeSnapshot()
		assert.deepEqual(runtime.release, { id: null, gitCommit: null })
		assert.equal(runtime.versions.model, null)
		assert.equal(runtime.versions.pipeline, null)
		assert.doesNotMatch(JSON.stringify(runtime), /PRIVATE|13800138000|REPORT\.pdf/)
	} finally {
		for (const [key, value] of Object.entries({
			RPT_RELEASE_ID: previous.release,
			RPT_GIT_COMMIT: previous.commit,
			DEEPSEEK_TEXT_MODEL: previous.model,
			CREDIT_ANALYSIS_PIPELINE_VERSION: previous.pipeline
		})) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
	}
})

test('persisted runtime envelopes with parallel unknown fields are rejected', () => {
	const event = createTerminalEventSnapshot(failureInput())
	const row = {
		schema_version: event.schemaVersion,
		support_ref: event.supportRef,
		trace_id: event.traceId,
		status: event.status,
		code: event.code,
		error_class: event.errorClass,
		stage: event.stage,
		retryable: 0,
		safe_message_key: event.safeMessageKey,
		diagnostic_json: JSON.stringify(event.diagnostic),
		release_json: JSON.stringify({ ...event.release, extra: 'PII_SENTINEL' }),
		versions_json: JSON.stringify(event.versions),
		server_time: event.serverTime
	}
	assert.equal(parseTrustedTerminalEventRow(row), null)
})

test('persisted rows from earlier releases parse; unknown version strings stay rejected', () => {
	// Production still holds immutable terminal events written by the previous
	// release (binder v7). A newer release must keep reading them during the
	// boot migration and support lookups, preserving the historical string.
	const event = createTerminalEventSnapshot(failureInput())
	const row = (versions) => ({
		schema_version: event.schemaVersion,
		support_ref: event.supportRef,
		trace_id: event.traceId,
		status: event.status,
		code: event.code,
		error_class: event.errorClass,
		stage: event.stage,
		retryable: 0,
		safe_message_key: event.safeMessageKey,
		diagnostic_json: JSON.stringify(event.diagnostic),
		release_json: JSON.stringify(event.release),
		versions_json: JSON.stringify(versions),
		server_time: event.serverTime
	})

	const v7Versions = {
		...event.versions,
		pipeline: 'credit-analysis-v14-global-card-binding-currency-closed',
		evidenceBinder: 'deterministic-global-card-binding-v7'
	}
	const parsedV7 = parseTrustedTerminalEventRow(row(v7Versions))
	assert.ok(parsedV7, 'v7-era persisted event must stay parseable')
	assert.equal(parsedV7.versions.evidenceBinder, 'deterministic-global-card-binding-v7')

	// The 2026-08 support migration backfilled legacy jobs with all-null
	// versions (unknown runtime); those rows must also stay parseable.
	const nullVersions = Object.fromEntries(
		Object.keys(event.versions).map((field) => [field, field === 'event' ? event.versions.event : null])
	)
	assert.ok(parseTrustedTerminalEventRow(row(nullVersions)))

	// Version strings never shipped by any release remain corruption.
	assert.equal(parseTrustedTerminalEventRow(row({
		...event.versions,
		evidenceBinder: 'deterministic-global-card-binding-v999-forged'
	})), null)
	assert.equal(parseTrustedTerminalEventRow(row({
		...event.versions,
		pipeline: 'credit-analysis-v1-unknown'
	})), null)

	// buildTrustedTerminalEvent (the write-side constructor) accepts the
	// historical set too, but new events can never carry a historical string:
	// runtimeVersionSnapshot coerces anything non-current to null first.
	const rebuilt = buildTrustedTerminalEvent({ ...event, versions: v7Versions })
	assert.equal(rebuilt.versions.evidenceBinder, 'deterministic-global-card-binding-v7')
})

test('PM2 terminal logging accepts only the validated safe envelope', () => {
	const { logTrustedTerminalEvent } = require('../backend/services/analysisCoordinator')
	const event = createTerminalEventSnapshot(failureInput())
	const success = createTerminalEventSnapshot({
		supportRef: createSupportRef(),
		traceId: createTraceId(),
		status: 'succeeded',
		code: null,
		errorClass: null,
		stage: 'succeeded',
		diagnostic: null,
		serverTime: '2026-08-18T01:02:03.004Z'
	})
	const originalWrite = process.stderr.write
	let output = ''
	process.stderr.write = function capture(chunk, ...args) {
		output += String(chunk)
		return true
	}
	try {
		assert.equal(logTrustedTerminalEvent(event, 'error'), true)
		assert.equal(logTrustedTerminalEvent(success, 'error'), true)
		assert.equal(logTrustedTerminalEvent({ ...event, extra: 'PRIVATE_LOG_SENTINEL' }, 'error'), false)
	} finally {
		process.stderr.write = originalWrite
	}
	const records = output.trim().split(/\r?\n/).map((line) => JSON.parse(line))
	const failedRecord = records.find((record) => record.supportRef === event.supportRef)
	const successRecord = records.find((record) => record.supportRef === success.supportRef)
	assert.equal(failedRecord.traceId, event.traceId)
	assert.equal(failedRecord.status, 'failed')
	assert.deepEqual(failedRecord.diagnostic, {
		version: 1,
		httpStatus: 422,
		evidenceIssueCount: 2
	})
	assert.equal(successRecord.status, 'succeeded')
	assert.equal(successRecord.diagnostic, null)
	assert.equal(successRecord.jobId, undefined)
	assert.doesNotMatch(JSON.stringify(records), /PRIVATE|unknownCount|extra|scopeHmac|analysisKey|documentId|resultHash|filePath|amount/)
})
