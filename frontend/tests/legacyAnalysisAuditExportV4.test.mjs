import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { makeV4GateFixture } from './helpers/v4GateFixture.mjs'
import {
  assertNoSensitiveInputV4,
  assertSanitizedAuditV4,
  buildSanitizedAuditV4,
  exportLegacyAnalysisAuditV4,
  parseStrictJson,
  writeSanitizedAuditV4
} from '../scripts/export-legacy-analysis-audit-v4.mjs'
import { evaluateGateV4 } from '../scripts/validate-legacy-analysis-consistency-v4.mjs'

const allTrueOwnership = () => ({
  trustedBasicInfoFound: true,
  nameCredible: true,
  idCardPresent: true,
  idCardFormatValid: true,
  idCardChecksumValid: true,
  ownershipVerified: true
})

const fixture = () => {
  const files = Array.from({ length: 31 }, (_, index) => {
    const id = `P${String(index + 1).padStart(2, '0')}`
    const targetRuns = index < 9 ? 3 : 5
    return {
      id,
      path: `C:\\private\\${id}.pdf`,
      sha256: String(index + 1).padStart(64, 'a').slice(-64),
      targetRuns,
      tags: id === 'P31' ? ['scanned-pdf'] : (targetRuns === 5 ? ['credit-utilization'] : ['baseline']),
      pageCount: 1,
      textChars: id === 'P31' ? 0 : 100
    }
  })
  const runs = files.flatMap((file) => Array.from({ length: file.targetRuns }, (_, index) => ({
    fileId: file.id,
    round: index + 1,
    success: true,
    ...(file.id === 'P31' ? { ownershipEvidence: allTrueOwnership() } : {})
  })))
  const manifestSha256 = 'a'.repeat(64)
  const manifest = { version: 1, files }
  const state = {
    status: 'complete',
    inFlight: null,
    manifestSha256,
    runs
  }
  const summary = {
    scope: { manifestSha256 },
    progress: {
      successfulRuns: 137,
      completeFiles: 31,
      totalFiles: 31,
      status: 'complete'
    },
    ownership: {
      scannedSuccessfulRuns: 5,
      scannedOwnershipVerifiedRuns: 5,
      scannedFilesOwnershipVerified: 1
    },
    provisionalBatchComplete: true
  }
  const gate = {
    coreBatchStrictPass: true,
    strictPass: true,
    snapshotValid: true,
    status: 'complete',
    inFlight: false,
    scope: {
      fileInstances: 31,
      ordinaryFiles: 9,
      focusFiles: 22,
      scannedFiles: 1,
      sharedCandidateFiles: 13,
      plannedSuccessfulRuns: 137
    },
    completion: {
      successfulRecords: 137,
      uniqueSuccessfulRounds: 137,
      duplicateSuccessfulRounds: 0,
      completeFiles: 31,
      failedAttempts: 2
    },
    ownership: {
      scannedSuccessfulRuns: 5,
      scannedOwnershipVerifiedRuns: 5,
      scannedFilesOwnershipVerified: 1
    },
    checks: { manifestViolations: 0, summaryViolations: 0 },
    consistency: {
      metricsStableFiles: 31,
      structureStableFiles: 31,
      formulaStableFiles: 31,
      formulaPassedFiles: 31
    }
  }
  return { manifest, state, summary, gate }
}

test('v4 exporter emits only fixed aggregate coverage and one random export id', () => {
  const input = fixture()
  const audit = buildSanitizedAuditV4({
    ...input,
    now: '2026-07-22T00:00:00.000Z',
    exportId: '123e4567-e89b-42d3-a456-426614174000'
  })
  assert.deepEqual(audit.coverage.scanned, {
    coverageCount: 1,
    successes: 5,
    ownershipEvidencePassed: true
  })
  assert.deepEqual(audit.execution, {
    plannedSuccesses: 137,
    successes: 137,
    failedAttempts: 2,
    completeReportCount: 31
  })
  assert.equal(audit.coverage.ordinary.successes, 27)
  assert.equal(audit.coverage.focus.successes, 110)
  assert.equal(audit.coverage.creditUtilization.successes, 105)
  assert.equal(audit.coverage.sharedLimit.successes, 65)
  const serialized = JSON.stringify(audit)
  assert.doesNotMatch(serialized, /P\d{2}|\.pdf|[A-Za-z]:[\\/]|\b[0-9a-f]{64}\b/i)
  assert.doesNotMatch(serialized, /path|fileName|original|raw|prompt|token|jwt|api.?key|modelResponse|ocrText/i)
})

test('v4 output schema rejects per-report identifiers and unlisted fields', () => {
  const audit = buildSanitizedAuditV4(fixture())
  audit.coverage.scanned.reportId = 'P31'
  assert.throws(() => assertSanitizedAuditV4(audit), /invalid_scanned_coverage/)
})

test('strict JSON parser rejects duplicate and prototype keys', () => {
  assert.deepEqual(parseStrictJson('{"safe":1,"nested":[true,null]}'), { safe: 1, nested: [true, null] })
  assert.throws(() => parseStrictJson('{"safe":1,"safe":2}'), /invalid_json/)
  assert.throws(() => parseStrictJson('{"__proto__":{}}'), /invalid_json/)
  assert.throws(() => parseStrictJson('{"value":NaN}'), /invalid_json/)
})

test('v4 aggregate builder fails closed for failed gate, mixed batch, scan tamper and incomplete counts', () => {
  const failedGate = fixture()
  failedGate.gate.strictPass = false
  assert.throws(() => buildSanitizedAuditV4(failedGate), /v4_gate_not_passed/)

  const mixed = fixture()
  mixed.summary.scope.manifestSha256 = 'b'.repeat(64)
  assert.throws(() => buildSanitizedAuditV4(mixed), /mixed_batch/)

  const scanTamper = fixture()
  scanTamper.state.runs.find((run) => run.fileId === 'P31').ownershipEvidence.ownershipVerified = false
  assert.throws(() => buildSanitizedAuditV4(scanTamper), /invalid_scan_ownership_evidence/)

  const incomplete = fixture()
  incomplete.gate.completion.successfulRecords = 136
  assert.throws(() => buildSanitizedAuditV4(incomplete), /invalid_success_count/)
})

test('official v4 gate result feeds the aggregate exporter without exposing private evidence', async () => {
  const input = makeV4GateFixture()
  const gate = await evaluateGateV4(input.manifest, input.state, input.summary, {
    expectedProjectionSha: input.manifestSha256,
    verifyInputFiles: false,
    ledgerEntries: input.ledgerEntries
  })
  assert.equal(gate.strictPass, true)
  assert.equal(assertNoSensitiveInputV4({
    manifest: input.manifest,
    state: input.state,
    summary: input.summary,
    ledgerEntries: input.ledgerEntries
  }), true)
  const audit = buildSanitizedAuditV4({
    manifest: input.manifest,
    state: input.state,
    summary: input.summary,
    gate
  })
  const serialized = JSON.stringify(audit)
  assert.equal(audit.coverage.scanned.ownershipEvidencePassed, true)
  assert.doesNotMatch(serialized, /P\d{2}|\.pdf|\b[0-9a-f]{64}\b|https?:\/\//i)
})

test('sanitized writer is exclusive and exports contain no stable per-report identifier', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rpt-v4-export-'))
  const input = fixture()
  const firstPath = join(root, 'first.sanitized.json')
  const secondPath = join(root, 'second.sanitized.json')
  await writeSanitizedAuditV4(buildSanitizedAuditV4(input), firstPath)
  await writeSanitizedAuditV4(buildSanitizedAuditV4(input), secondPath)
  const first = JSON.parse(await readFile(firstPath, 'utf8'))
  const second = JSON.parse(await readFile(secondPath, 'utf8'))
  assert.notEqual(first.exportId, second.exportId)
  await assert.rejects(
    writeSanitizedAuditV4(buildSanitizedAuditV4(input), firstPath),
    /output_exists/
  )
})

test('sensitive fields and missing private ledger fail closed before an official export', async () => {
  const input = fixture()
  const injectedState = structuredClone(input.state)
  injectedState.rawModelResponse = 'synthetic-secret'
  assert.throws(
    () => assertNoSensitiveInputV4({
      manifest: input.manifest,
      state: injectedState,
      summary: input.summary,
      ledgerEntries: []
    }),
    /sensitive_input_injection/
  )

  const pathInjectedSummary = structuredClone(input.summary)
  pathInjectedSummary.sourcePath = 'synthetic'
  assert.throws(
    () => assertNoSensitiveInputV4({
      manifest: input.manifest,
      state: input.state,
      summary: pathInjectedSummary,
      ledgerEntries: []
    }),
    /sensitive_input_injection/
  )
  await assert.rejects(exportLegacyAnalysisAuditV4({}), /missing_arguments/)
})
