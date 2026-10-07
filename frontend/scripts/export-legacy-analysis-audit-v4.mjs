import { randomUUID, createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  readFile,
  realpath,
  unlink,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { evaluateGateV4 } from './validate-legacy-analysis-consistency-v4.mjs'

const EXPORT_SCHEMA_VERSION = 4
const EXPECTED_REPORTS = 31
const EXPECTED_SUCCESSES = 137
const EXPECTED_ORDINARY_REPORTS = 9
const EXPECTED_FOCUS_REPORTS = 22
const EXPECTED_CREDIT_REPORTS = 21
const EXPECTED_SHARED_REPORTS = 13
const EXPECTED_SCANNED_REPORTS = 1
const EXPECTED_SCANNED_SUCCESSES = 5
const EXPECTED_SCAN_PRIVATE_ID = 'P31'
const MAX_JSON_BYTES = 256 * 1024 * 1024

const isPlainObject = (value) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

const exactKeys = (value, keys, label) => {
  if (!isPlainObject(value)) throw new Error(`invalid_${label}`)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`invalid_${label}`)
  }
}

const exactInteger = (value, expected, label) => {
  if (!Number.isSafeInteger(value) || value !== expected) throw new Error(`invalid_${label}`)
}

const nonNegativeInteger = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid_${label}`)
  return value
}

const exactBooleanRecord = (value, keys, label) => {
  exactKeys(value, keys, label)
  for (const key of keys) {
    if (typeof value[key] !== 'boolean') throw new Error(`invalid_${label}`)
  }
}

// JSON.parse silently accepts duplicate object keys. Private audit inputs are
// security-bound evidence, so this small recursive parser rejects duplicates,
// prototype keys, non-JSON numbers and trailing content before the validator
// sees the objects.
export const parseStrictJson = (source) => {
  if (typeof source !== 'string') throw new Error('invalid_json')
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
  let cursor = 0

  const fail = () => { throw new Error('invalid_json') }
  const whitespace = () => {
    while (cursor < text.length && /[\u0009\u000a\u000d\u0020]/.test(text[cursor])) cursor += 1
  }
  const stringValue = () => {
    if (text[cursor] !== '"') fail()
    const start = cursor
    cursor += 1
    while (cursor < text.length) {
      const char = text[cursor]
      if (char === '"') {
        cursor += 1
        try { return JSON.parse(text.slice(start, cursor)) } catch { fail() }
      }
      if (char === '\\') {
        cursor += 1
        if (cursor >= text.length || !/["\\/bfnrtu]/.test(text[cursor])) fail()
        if (text[cursor] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(cursor + 1, cursor + 5))) fail()
          cursor += 4
        }
      } else if (char.charCodeAt(0) < 0x20) {
        fail()
      }
      cursor += 1
    }
    fail()
  }
  const value = () => {
    whitespace()
    const char = text[cursor]
    if (char === '{') {
      cursor += 1
      whitespace()
      const object = {}
      const keys = new Set()
      if (text[cursor] === '}') { cursor += 1; return object }
      while (cursor < text.length) {
        whitespace()
        const key = stringValue()
        if (keys.has(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) fail()
        keys.add(key)
        whitespace()
        if (text[cursor] !== ':') fail()
        cursor += 1
        const parsed = value()
        Object.defineProperty(object, key, {
          value: parsed,
          enumerable: true,
          configurable: true,
          writable: true
        })
        whitespace()
        if (text[cursor] === '}') { cursor += 1; return object }
        if (text[cursor] !== ',') fail()
        cursor += 1
      }
      fail()
    }
    if (char === '[') {
      cursor += 1
      whitespace()
      const array = []
      if (text[cursor] === ']') { cursor += 1; return array }
      while (cursor < text.length) {
        array.push(value())
        whitespace()
        if (text[cursor] === ']') { cursor += 1; return array }
        if (text[cursor] !== ',') fail()
        cursor += 1
      }
      fail()
    }
    if (char === '"') return stringValue()
    for (const [literal, parsed] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, cursor)) { cursor += literal.length; return parsed }
    }
    const number = text.slice(cursor).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)
    if (!number) fail()
    cursor += number[0].length
    const parsed = Number(number[0])
    if (!Number.isFinite(parsed)) fail()
    return parsed
  }

  const parsed = value()
  whitespace()
  if (cursor !== text.length) fail()
  return parsed
}

const readPrivateJson = async (literalPath) => {
  const path = resolve(literalPath)
  if (!path.endsWith('.private.json')) throw new Error('invalid_private_input')
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_JSON_BYTES) {
    throw new Error('invalid_private_input')
  }
  const bytes = await readFile(path)
  return {
    path: await realpath(path),
    digest: createHash('sha256').update(bytes).digest('hex'),
    value: parseStrictJson(bytes.toString('utf8'))
  }
}

const readPrivateLedger = async (literalPath) => {
  const path = resolve(literalPath)
  if (!path.endsWith('.private.jsonl')) throw new Error('invalid_private_ledger')
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_JSON_BYTES) {
    throw new Error('invalid_private_ledger')
  }
  const bytes = await readFile(path)
  const text = bytes.toString('utf8').replace(/\r\n/g, '\n')
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
  if (lines.length === 0 || lines.some((line) => line.length === 0)) throw new Error('invalid_private_ledger')
  return {
    path: await realpath(path),
    digest: createHash('sha256').update(bytes).digest('hex'),
    value: lines.map((line) => parseStrictJson(line))
  }
}

const assertInputsUnchanged = async (inputs) => {
  for (const input of inputs) {
    const bytes = await readFile(input.path)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== input.digest) throw new Error('private_input_changed')
  }
}

const assertNoSensitiveInjection = (value, segments = []) => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveInjection(item, [...segments, String(index)]))
    return
  }
  if (!isPlainObject(value)) return
  for (const [key, child] of Object.entries(value)) {
    const next = [...segments, key]
    const pathKey = next.join('.')
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '')
    const allowedPathKey = /^manifest\.files\.\d+\.path$/.test(pathKey)
      || pathKey === 'state.analyzePath'
      || /^state\.runs\.\d+\.responseTarget\.path$/.test(pathKey)
    if (
      normalizedKey === 'filename'
      || ['name', 'customername', 'realname', 'identity', 'identityno'].includes(normalizedKey)
      || normalizedKey.startsWith('original')
      || normalizedKey.startsWith('raw')
      || (normalizedKey.endsWith('path') && !allowedPathKey)
      || ['pdftext', 'rawresponse', 'rawoutput', 'rawtext', 'rawmodel', 'prompt',
        'modelresponse', 'ocrtext', 'authorization', 'token', 'jwt', 'apikey'].includes(normalizedKey)
    ) throw new Error('sensitive_input_injection')

    if (typeof child === 'string') {
      const manifestPath = /^manifest\.files\.\d+\.path$/.test(pathKey)
      const allowedUrl = pathKey === 'state.baseUrl'
        || pathKey === 'summary.scope.baseUrl'
        || /^state\.runs\.\d+\.responseTarget\.baseUrl$/.test(pathKey)
      const allowedRoute = pathKey === 'state.analyzePath'
        || pathKey === 'summary.scope.endpoint'
        || /^state\.runs\.\d+\.responseTarget\.path$/.test(pathKey)
      const allowedHash = /(?:sha256|requestnoncehash)$/i.test(key)
        || next.slice(0, -1).some((segment) => /(?:sha256|hashes)$/i.test(segment))
      const expectedHashValue = allowedHash && /^[0-9a-f]{64}$/i.test(child)
      if (!manifestPath && /\.pdf\b/i.test(child)) throw new Error('sensitive_input_injection')
      if (!allowedUrl && /https?:\/\//i.test(child)) throw new Error('sensitive_input_injection')
      if (!manifestPath && !allowedUrl && !allowedRoute && (/[A-Za-z]:[\\/]/.test(child) || /\\\\[^\\\s]+\\/.test(child))) {
        throw new Error('sensitive_input_injection')
      }
      if (!allowedHash && /\b[0-9a-f]{64}\b/i.test(child)) throw new Error('sensitive_input_injection')
      if (
        /\bsk-[a-z0-9_-]{12,}\b/i.test(child)
        || /\beyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\./i.test(child)
        || (!expectedHashValue && /(?<!\d)1[3-9]\d{9}(?!\d)/.test(child))
        || (!expectedHashValue && /(?<!\d)\d{17}[0-9Xx](?!\d)/.test(child))
      ) throw new Error('sensitive_input_injection')
    }
    assertNoSensitiveInjection(child, next)
  }
}

export const assertNoSensitiveInputV4 = ({ manifest, state, summary, ledgerEntries } = {}) => {
  assertNoSensitiveInjection({ manifest, state, summary, ledgerEntries })
  return true
}

const successRunsFor = (state, privateId) => (Array.isArray(state?.runs) ? state.runs : [])
  .filter((run) => run?.fileId === privateId && run?.success === true)

const assertScanCoverage = (manifest, state) => {
  const files = Array.isArray(manifest?.files) ? manifest.files : []
  const scanned = files.filter((file) => Array.isArray(file?.tags) && file.tags.includes('scanned-pdf'))
  if (scanned.length !== EXPECTED_SCANNED_REPORTS) throw new Error('invalid_scan_coverage')
  const scan = scanned[0]
  if (
    scan?.id !== EXPECTED_SCAN_PRIVATE_ID
    || scan?.targetRuns !== EXPECTED_SCANNED_SUCCESSES
    || scan.tags.length !== 1
  ) throw new Error('invalid_scan_coverage')

  const successes = successRunsFor(state, EXPECTED_SCAN_PRIVATE_ID)
  if (successes.length !== EXPECTED_SCANNED_SUCCESSES) throw new Error('invalid_scan_coverage')
  const rounds = successes.map((run) => run.round).sort((left, right) => left - right)
  if (rounds.some((round, index) => round !== index + 1)) throw new Error('invalid_scan_coverage')
  for (const run of successes) {
    exactBooleanRecord(run.ownershipEvidence, [
      'trustedBasicInfoFound', 'nameCredible', 'idCardPresent',
      'idCardFormatValid', 'idCardChecksumValid', 'ownershipVerified'
    ], 'scan_ownership_evidence')
    if (!Object.values(run.ownershipEvidence).every((value) => value === true)) {
      throw new Error('invalid_scan_ownership_evidence')
    }
  }
}

const assertZeroCheckRecord = (value) => {
  if (!isPlainObject(value) || Object.keys(value).length === 0) throw new Error('invalid_gate_checks')
  for (const count of Object.values(value)) {
    if (!Number.isSafeInteger(count) || count !== 0) throw new Error('invalid_gate_checks')
  }
}

const assertValidatedFacts = (manifest, state, summary, gate) => {
  if (
    gate?.coreBatchStrictPass !== true
    || gate?.strictPass !== true
    || gate?.snapshotValid !== true
    || gate?.status !== 'complete'
    || gate?.inFlight !== false
  ) {
    throw new Error('v4_gate_not_passed')
  }
  exactInteger(gate?.scope?.fileInstances, EXPECTED_REPORTS, 'report_count')
  exactInteger(gate?.scope?.ordinaryFiles, EXPECTED_ORDINARY_REPORTS, 'ordinary_count')
  exactInteger(gate?.scope?.focusFiles, EXPECTED_FOCUS_REPORTS, 'focus_count')
  exactInteger(gate?.scope?.scannedFiles, EXPECTED_SCANNED_REPORTS, 'scanned_count')
  exactInteger(gate?.scope?.sharedCandidateFiles, EXPECTED_SHARED_REPORTS, 'shared_count')
  exactInteger(gate?.scope?.plannedSuccessfulRuns, EXPECTED_SUCCESSES, 'planned_successes')
  exactInteger(gate?.completion?.successfulRecords, EXPECTED_SUCCESSES, 'success_count')
  exactInteger(gate?.completion?.uniqueSuccessfulRounds, EXPECTED_SUCCESSES, 'unique_success_count')
  exactInteger(gate?.completion?.duplicateSuccessfulRounds, 0, 'duplicate_success_count')
  exactInteger(gate?.completion?.completeFiles, EXPECTED_REPORTS, 'complete_report_count')
  nonNegativeInteger(gate?.completion?.failedAttempts, 'failed_attempt_count')
  exactInteger(gate?.ownership?.scannedSuccessfulRuns, EXPECTED_SCANNED_SUCCESSES, 'scanned_success_count')
  exactInteger(gate?.ownership?.scannedOwnershipVerifiedRuns, EXPECTED_SCANNED_SUCCESSES, 'scanned_ownership_run_count')
  exactInteger(gate?.ownership?.scannedFilesOwnershipVerified, EXPECTED_SCANNED_REPORTS, 'scanned_ownership_file_count')
  exactInteger(gate?.consistency?.metricsStableFiles, EXPECTED_REPORTS, 'metrics_stable_count')
  exactInteger(gate?.consistency?.structureStableFiles, EXPECTED_REPORTS, 'structure_stable_count')
  exactInteger(gate?.consistency?.formulaStableFiles, EXPECTED_REPORTS, 'formula_stable_count')
  exactInteger(gate?.consistency?.formulaPassedFiles, EXPECTED_REPORTS, 'formula_passed_count')
  assertZeroCheckRecord(gate.checks)

  if (manifest?.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length !== EXPECTED_REPORTS) {
    throw new Error('invalid_manifest_scope')
  }
  if (state?.status !== 'complete' || state?.inFlight !== null || !Array.isArray(state.runs)) {
    throw new Error('invalid_state_completion')
  }
  const successfulRuns = state.runs.filter((run) => run?.success === true)
  if (successfulRuns.length !== EXPECTED_SUCCESSES) throw new Error('invalid_state_completion')
  if (
    typeof state.manifestSha256 !== 'string'
    || state.manifestSha256 !== summary?.scope?.manifestSha256
  ) throw new Error('mixed_batch')
  if (
    summary?.progress?.successfulRuns !== EXPECTED_SUCCESSES
    || summary?.progress?.completeFiles !== EXPECTED_REPORTS
    || summary?.progress?.totalFiles !== EXPECTED_REPORTS
    || summary?.progress?.status !== 'complete'
  ) throw new Error('invalid_summary_completion')
  if (
    summary?.provisionalBatchComplete !== true
    || summary?.ownership?.scannedSuccessfulRuns !== EXPECTED_SCANNED_SUCCESSES
    || summary?.ownership?.scannedOwnershipVerifiedRuns !== EXPECTED_SCANNED_SUCCESSES
    || summary?.ownership?.scannedFilesOwnershipVerified !== EXPECTED_SCANNED_REPORTS
  ) throw new Error('invalid_summary_ownership')
  assertScanCoverage(manifest, state)
}

const OUTPUT_KEYS = ['schemaVersion', 'exportId', 'generatedAt', 'verdict', 'coverage', 'execution', 'consistency']

export const assertSanitizedAuditV4 = (audit) => {
  exactKeys(audit, OUTPUT_KEYS, 'sanitized_output')
  exactInteger(audit.schemaVersion, EXPORT_SCHEMA_VERSION, 'schema_version')
  if (typeof audit.exportId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(audit.exportId)) {
    throw new Error('invalid_export_id')
  }
  if (typeof audit.generatedAt !== 'string' || !Number.isFinite(Date.parse(audit.generatedAt))) {
    throw new Error('invalid_generated_at')
  }
  exactKeys(audit.verdict, ['passed'], 'verdict')
  if (audit.verdict.passed !== true) throw new Error('invalid_verdict')
  exactKeys(audit.coverage, ['reportCount', 'ordinary', 'focus', 'creditUtilization', 'sharedLimit', 'scanned'], 'coverage')
  exactInteger(audit.coverage.reportCount, EXPECTED_REPORTS, 'report_count')
  for (const [key, reports, successes] of [
    ['ordinary', EXPECTED_ORDINARY_REPORTS, 27],
    ['focus', EXPECTED_FOCUS_REPORTS, 110],
    ['creditUtilization', EXPECTED_CREDIT_REPORTS, 105],
    ['sharedLimit', EXPECTED_SHARED_REPORTS, 65]
  ]) {
    exactKeys(audit.coverage[key], ['reportCount', 'successes'], `${key}_coverage`)
    exactInteger(audit.coverage[key].reportCount, reports, `${key}_report_count`)
    exactInteger(audit.coverage[key].successes, successes, `${key}_success_count`)
  }
  exactKeys(audit.coverage.scanned, ['coverageCount', 'successes', 'ownershipEvidencePassed'], 'scanned_coverage')
  exactInteger(audit.coverage.scanned.coverageCount, EXPECTED_SCANNED_REPORTS, 'scanned_count')
  exactInteger(audit.coverage.scanned.successes, EXPECTED_SCANNED_SUCCESSES, 'scanned_success_count')
  if (audit.coverage.scanned.ownershipEvidencePassed !== true) throw new Error('invalid_scan_ownership_evidence')
  exactKeys(audit.execution, ['plannedSuccesses', 'successes', 'failedAttempts', 'completeReportCount'], 'execution')
  exactInteger(audit.execution.plannedSuccesses, EXPECTED_SUCCESSES, 'planned_successes')
  exactInteger(audit.execution.successes, EXPECTED_SUCCESSES, 'success_count')
  nonNegativeInteger(audit.execution.failedAttempts, 'failed_attempt_count')
  exactInteger(audit.execution.completeReportCount, EXPECTED_REPORTS, 'complete_report_count')
  exactKeys(audit.consistency, [
    'metricsStableReportCount', 'structureStableReportCount',
    'formulaStableReportCount', 'formulaPassedReportCount'
  ], 'consistency')
  for (const value of Object.values(audit.consistency)) exactInteger(value, EXPECTED_REPORTS, 'consistency_count')

  const serialized = JSON.stringify(audit)
  // Keep the patterns separate and deliberately ASCII-oriented. The output is
  // reconstructed from constants, numbers and booleans; these checks are a
  // final guard against future accidental field additions.
  const leakPatterns = [
    /[A-Za-z]:[\\/]/,
    /\\\\[^\\\s]+\\/,
    /https?:\/\//i,
    /\.pdf\b/i,
    /\b[0-9a-f]{64}\b/i,
    /\bsk-[a-z0-9_-]{12,}\b/i,
    /\beyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\./i,
    /(?<!\d)1[3-9]\d{9}(?!\d)/,
    /(?<!\d)\d{17}[0-9Xx](?!\d)/,
    /(?<!\d)P\d{2}(?!\d)/i,
    /file(name|path)|original(name|path)|pdftext|raw(response|output)|modelresponse|ocrtext|authorization|api[_-]?key|jwt|manifestsha|responsesha|inputsha/i
  ]
  if (leakPatterns.some((pattern) => pattern.test(serialized))) {
    throw new Error('sanitized_output_privacy_failure')
  }
  return true
}

export const buildSanitizedAuditV4 = ({ manifest, state, summary, gate, now, exportId } = {}) => {
  assertValidatedFacts(manifest, state, summary, gate)
  const audit = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportId: exportId || randomUUID(),
    generatedAt: now || new Date().toISOString(),
    verdict: { passed: true },
    coverage: {
      reportCount: EXPECTED_REPORTS,
      ordinary: { reportCount: EXPECTED_ORDINARY_REPORTS, successes: 27 },
      focus: { reportCount: EXPECTED_FOCUS_REPORTS, successes: 110 },
      creditUtilization: { reportCount: EXPECTED_CREDIT_REPORTS, successes: 105 },
      sharedLimit: { reportCount: EXPECTED_SHARED_REPORTS, successes: 65 },
      scanned: {
        coverageCount: EXPECTED_SCANNED_REPORTS,
        successes: EXPECTED_SCANNED_SUCCESSES,
        ownershipEvidencePassed: true
      }
    },
    execution: {
      plannedSuccesses: EXPECTED_SUCCESSES,
      successes: EXPECTED_SUCCESSES,
      failedAttempts: gate.completion.failedAttempts,
      completeReportCount: EXPECTED_REPORTS
    },
    consistency: {
      metricsStableReportCount: EXPECTED_REPORTS,
      structureStableReportCount: EXPECTED_REPORTS,
      formulaStableReportCount: EXPECTED_REPORTS,
      formulaPassedReportCount: EXPECTED_REPORTS
    }
  }
  assertSanitizedAuditV4(audit)
  return audit
}

const writeExclusiveAtomic = async (outputPath, content) => {
  const output = resolve(outputPath)
  if (!basename(output).endsWith('.sanitized.json')) throw new Error('invalid_output_name')
  const parent = dirname(output)
  const absoluteParent = resolve(parent)
  const parsedParent = parse(absoluteParent)
  let current = parsedParent.root
  for (const component of relative(parsedParent.root, absoluteParent).split(sep).filter(Boolean)) {
    current = join(current, component)
    if ((await lstat(current)).isSymbolicLink()) throw new Error('invalid_output_directory')
  }
  try {
    await lstat(output)
    throw new Error('output_exists')
  } catch (error) {
    if (error?.message === 'output_exists') throw error
    if (error?.code !== 'ENOENT') throw new Error('invalid_output_target')
  }
  const temporary = resolve(parent, `.${basename(output)}.${randomUUID()}.tmp`)
  let outputCreated = false
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await copyFile(temporary, output, fsConstants.COPYFILE_EXCL)
    outputCreated = true
    await chmod(output, 0o600)
  } catch (error) {
    if (outputCreated) await unlink(output).catch(() => {})
    throw error
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

export const writeSanitizedAuditV4 = async (audit, outputPath) => {
  assertSanitizedAuditV4(audit)
  await writeExclusiveAtomic(outputPath, `${JSON.stringify(audit, null, 2)}\n`)
  return { exported: true, schemaVersion: EXPORT_SCHEMA_VERSION }
}

export const exportLegacyAnalysisAuditV4 = async ({
  manifestPath,
  statePath,
  summaryPath,
  requestLedgerPath,
  outputPath
}) => {
  if (![manifestPath, statePath, summaryPath, requestLedgerPath, outputPath].every((value) => typeof value === 'string' && value.length > 0)) {
    throw new Error('missing_arguments')
  }
  const privateRoot = await realpath(resolve(process.cwd(), 'tmp'))
  const requestedInputs = [manifestPath, statePath, summaryPath, requestLedgerPath]
    .map((value) => resolve(value))
  if (requestedInputs.some((input) => {
    const child = relative(privateRoot, input)
    return child === '' || child.startsWith('..') || isAbsolute(child)
  })) throw new Error('unsafe_private_input_location')
  const jsonInputs = await Promise.all([
    readPrivateJson(manifestPath),
    readPrivateJson(statePath),
    readPrivateJson(summaryPath)
  ])
  const ledgerInput = await readPrivateLedger(requestLedgerPath)
  const inputs = [...jsonInputs, ledgerInput]
  if (new Set(inputs.map((input) => input.path)).size !== inputs.length) throw new Error('duplicate_private_input')
  if (inputs.some((input) => input.path === resolve(outputPath))) throw new Error('invalid_output_target')
  if (inputs.some((input) => {
    const child = relative(privateRoot, input.path)
    return child === '' || child.startsWith('..') || isAbsolute(child)
  })) throw new Error('unsafe_private_input_location')

  const [manifest, state, summary] = jsonInputs.map((input) => input.value)
  const ledgerEntries = ledgerInput.value
  assertNoSensitiveInputV4({ manifest, state, summary, ledgerEntries })
  const gate = await evaluateGateV4(manifest, state, summary, { verifyInputFiles: true, ledgerEntries })
  const audit = buildSanitizedAuditV4({ manifest, state, summary, gate })
  await assertInputsUnchanged(inputs)
  return writeSanitizedAuditV4(audit, outputPath)
}

const parseCli = (argv) => {
  const allowed = new Set(['--manifest', '--state', '--summary', '--request-ledger', '--output'])
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index]
    const value = argv[index + 1]
    if (!allowed.has(option) || typeof value !== 'string' || value.startsWith('--')) throw new Error('invalid_arguments')
    if (Object.hasOwn(values, option)) throw new Error('invalid_arguments')
    values[option] = value
  }
  if (Object.keys(values).length !== allowed.size) throw new Error('missing_arguments')
  return {
    manifestPath: values['--manifest'],
    statePath: values['--state'],
    summaryPath: values['--summary'],
    requestLedgerPath: values['--request-ledger'],
    outputPath: values['--output']
  }
}

const runCli = async () => {
  try {
    const result = await exportLegacyAnalysisAuditV4(parseCli(process.argv.slice(2)))
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch {
    process.stdout.write(`${JSON.stringify({ exported: false, schemaVersion: EXPORT_SCHEMA_VERSION })}\n`)
    process.exitCode = 2
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (invokedPath === import.meta.url) await runCli()
