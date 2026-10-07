import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  EXPECTED_TAGS_BY_ID,
  buildSummaryV4,
  canonicalJson,
  evaluateGateV4,
  extractOwnershipEvidence,
  parseRequestLedger,
  projectManifest,
  sha256
} from '../scripts/validate-legacy-analysis-consistency-v4.mjs'
import { makeV4GateFixture } from './helpers/v4GateFixture.mjs'

const makeValidIdentity = (body17) => {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
  const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2']
  const sum = [...body17].reduce((total, digit, index) => total + Number(digit) * weights[index], 0)
  return `${body17}${checks[sum % 11]}`
}

const makeFixture = makeV4GateFixture


const evaluate = (fixture) => evaluateGateV4(
  fixture.manifest,
  fixture.state,
  fixture.summary,
  {
    expectedProjectionSha: fixture.manifestSha256,
    verifyInputFiles: false,
    ledgerEntries: fixture.ledgerEntries
  }
)

const refreshSummary = (fixture) => {
  fixture.summary = buildSummaryV4(fixture.manifest, fixture.state)
}

test('v4 manifest profile adds only the isolated scanned P31 sample', () => {
  assert.equal(Object.keys(EXPECTED_TAGS_BY_ID).length, 31)
  assert.deepEqual(EXPECTED_TAGS_BY_ID.P31, ['scanned-pdf'])
})

test('v4 ownership evidence accepts only explicit trusted basic-info containers', () => {
  const validId = makeValidIdentity('11000019900101001')
  assert.deepEqual(extractOwnershipEvidence({
    basic_info: { customer_name: '测试甲', id_no: validId }
  }), {
    trustedBasicInfoFound: true,
    nameCredible: true,
    idCardPresent: true,
    idCardFormatValid: true,
    idCardChecksumValid: true,
    ownershipVerified: true
  })

  assert.deepEqual(extractOwnershipEvidence({
    accounts: [{ name: '测试甲', id_no: validId }]
  }), {
    trustedBasicInfoFound: false,
    nameCredible: false,
    idCardPresent: false,
    idCardFormatValid: false,
    idCardChecksumValid: false,
    ownershipVerified: false
  })
})

test('v4 trusts only the exact top-level boolean scan evidence contract', () => {
  const serviceEvidence = {
    version: 1,
    source: 'scanned-pdf-first-page',
    nameRecognized: true,
    identityRecognized: true,
    identityChecksumValid: true,
    verified: true
  }
  assert.equal(extractOwnershipEvidence({ _ownership_evidence: serviceEvidence }).ownershipVerified, true)
  assert.equal(extractOwnershipEvidence({
    nested: { _ownership_evidence: serviceEvidence }
  }).ownershipVerified, false)
  assert.equal(extractOwnershipEvidence({
    _ownership_evidence: { ...serviceEvidence, unexpected: true }
  }).ownershipVerified, false)
  assert.equal(extractOwnershipEvidence({
    _ownership_evidence: { ...serviceEvidence, identityChecksumValid: false }
  }).ownershipVerified, false)
})

test('v4 ownership evidence rejects a checksum mismatch and never returns identity values', () => {
  const validId = makeValidIdentity('11000019900101001')
  const invalidId = `${validId.slice(0, 17)}${validId.endsWith('0') ? '1' : '0'}`
  const evidence = extractOwnershipEvidence({
    report: { basicInfo: { realName: '测试乙', idCard: invalidId } }
  })
  assert.equal(evidence.ownershipVerified, false)
  assert.equal(evidence.idCardChecksumValid, false)
  assert.deepEqual(Object.keys(evidence).sort(), [
    'idCardChecksumValid', 'idCardFormatValid', 'idCardPresent',
    'nameCredible', 'ownershipVerified', 'trustedBasicInfoFound'
  ])
  assert.doesNotMatch(canonicalJson(evidence), /测试|110000/)
})

test('v4 runner pins the legacy base URL, rejects redirects, checks the service line, and does not retry unknown transport', async () => {
  const source = await readFile(new URL('../scripts/run-legacy-analysis-consistency.mjs', import.meta.url), 'utf8')
  const lockSource = await readFile(new URL('../scripts/legacy-analysis-process-lock.mjs', import.meta.url), 'utf8')
  assert.match(source, /'http:\/\/127\.0\.0\.1:3200\/legacy-api'/)
  // 反向守卫不写旧值原文（把被禁域名/IP 写进断言等于自己把它们留在仓库里）：
  // runner 内出现的每个 http(s) 字面量都必须落在回环或 RFC-2606 保留域内，
  // 且不得出现任何公网 IPv4 字面量 —— 旧生产网关形态一旦回流，这里立刻失败。
  const offendingRunnerOrigins = [...source.matchAll(/https?:\/\/[A-Za-z0-9.\-_~:/?#@!$&*+,;=%[\]]+/g)]
    .map((match) => match[0])
    .filter((value) => {
      try {
        const host = String(new URL(value).hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
        return !(host === 'localhost' || host === '::1' || host.startsWith('127.') ||
          /(^|\.)(?:invalid|test)$/i.test(host) ||
          /^(?:[a-z0-9-]+\.)*example\.(?:com|org|net)$/i.test(host))
      } catch { return false }
    })
  assert.deepEqual(offendingRunnerOrigins, [], 'v4 runner 不得内嵌非回环、非保留域的 http(s) 字面量')
  const offendingRunnerIpv4 = [...source.matchAll(/(?<![\d.])\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?![\d.])/g)]
    .map((match) => match[0])
    .filter((value) => {
      const [first, second] = value.split('.').map(Number)
      if (first === 127 || first === 10 || first === 0) return false
      if (first === 192 && second === 168) return false
      if (first === 172 && second >= 16 && second <= 31) return false
      return true
    })
  assert.deepEqual(offendingRunnerIpv4, [], 'v4 runner 不得内嵌公网 IPv4 字面量')
  assert.match(source, /redirect:\s*'error'/)
  assert.match(source, /X-RPT-Service-Line/)
  assert.match(source, /legacy-isolated-v20260722/)
  assert.match(source, /serviceIdentityMatched/)
  assert.match(source, /service_identity_mismatch/)
  assert.doesNotMatch(source, /RETRYABLE_ERROR_CLASSES[^\n]*network_or_unknown/)
  assert.doesNotMatch(source, /RETRYABLE_ERROR_CLASSES[^\n]*timeout/)
  assert.match(source, /--request-ledger/)
  assert.match(source, /validateStateSnapshotV4/)
  assert.match(source, /evaluateGateV4/)
  assert.match(source, /real-analysis-v4-20260722-private/)
  assert.match(source, /request-ledger-v4\.private\.jsonl/)
  assert.match(source, /唯一受信运行目录与固定文件名/)
  assert.match(source, /acquireExclusiveDirectoryLock/)
  assert.match(source, /releaseExclusiveDirectoryLockSync/)
  assert.match(source, /timeoutMs !== DEFAULT_TIMEOUT_MS/)
  assert.match(source, /await writeFileDurably\(requestLedgerPath/)
  assert.match(source, /未写入账本的请求预留/)
  assert.match(lockSource, /owner\.private\.json/)
  assert.match(lockSource, /ownerId/)
  assert.match(lockSource, /recovery\.private\.lock/)
  assert.match(lockSource, /acquireRecoveryFence/)
  assert.match(lockSource, /await rename\(canonicalPath, quarantinePath\)/)
  assert.match(lockSource, /renameSync\(lockPath, releasePath\)/)
  assert.match(lockSource, /sameOwner\(movedOwner, owner\)/)
  assert.doesNotMatch(lockSource, /rm\(canonicalPath,\s*\{\s*recursive:/)
  const recoveryFence = lockSource.indexOf('await acquireRecoveryFence(')
  const ownerReread = lockSource.indexOf('const currentOwner = await readOwner(', recoveryFence)
  const staleRename = lockSource.indexOf('await rename(canonicalPath, quarantinePath)', ownerReread)
  assert.ok(recoveryFence >= 0 && ownerReread > recoveryFence && staleRename > ownerReread)
  const releaseRename = lockSource.indexOf('renameSync(lockPath, releasePath)')
  const releasedFlag = lockSource.indexOf('lock.released = true', releaseRename)
  assert.ok(releaseRename >= 0 && releasedFlag > releaseRename)
  assert.match(source, /if \(releaseExclusiveDirectoryLockSync\(processLock\)\)/)
  const reservation = source.indexOf('state.inFlight = {', source.indexOf('while (!stopRequested)'))
  const persisted = source.indexOf('await atomicWriteJson(statePath, state)', reservation)
  const ledgerAppend = source.indexOf('await appendRequestLedger(', reservation)
  assert.ok(reservation >= 0 && persisted > reservation && ledgerAppend > persisted)

  // 身份头「成对守卫」：runner 读取的头名必须与后端设置的头名逐字相同。
  // 这条守卫存在的原因：后端改成 X-RPT-Service-Line 后 runner 仍读旧头名，
  // response.headers.get() 返回 null，serviceIdentityMatched 恒为 false，
  // 而本测试当时断言的也是旧字面量，所以两侧自洽、门禁永不过却测试全绿。
  const serverSource = await readFile(new URL('../../backend/server.js', import.meta.url), 'utf8')
  const emittedHeaderName = (serverSource.match(/setHeader\(\s*['"]([^'"]*service-line)['"]/i) ?? [])[1] ?? ''
  const pinnedHeaderName = (source.match(/SERVICE_IDENTITY_HEADER = '([^']*)'/) ?? [])[1] ?? ''
  assert.ok(emittedHeaderName, 'backend/server.js 必须保留 Service-Line 身份头设置点')
  assert.ok(pinnedHeaderName, 'runner 必须把身份头名集中为 SERVICE_IDENTITY_HEADER 常量')
  assert.equal(pinnedHeaderName.toLowerCase(), emittedHeaderName.toLowerCase())
  assert.match(source, /headers\.get\(SERVICE_IDENTITY_HEADER\)/)
  assert.doesNotMatch(source, /headers\.get\('X-[^']*Service-Line'/)
  const runnerHeaderLiterals = [...source.matchAll(/['"](X-[A-Za-z0-9-]+)['"]/g)].map((item) => item[1])
  assert.ok(runnerHeaderLiterals.length >= 2)
  assert.ok(runnerHeaderLiterals.every((name) => name.startsWith('X-RPT-')), `runner 不得再出现非 X-RPT- 前缀的头部字面量：${runnerHeaderLiterals.join(', ')}`)
  // 读到不存在的头必须显式报错（fail closed），不许静默判 false
  assert.match(source, /if \(serviceIdentityHeaderValue === null\) \{/)
  assert.match(source, /const identityHeaderMissing = errorText\.includes\(SERVICE_IDENTITY_HEADER_MISSING\)/)
  assert.match(source, /\? 'service_identity_mismatch'/)
})

test('v4 projection is bound to 31 files and 137 planned successes', () => {
  const files = Object.entries(EXPECTED_TAGS_BY_ID).map(([id, tags]) => ({
    id,
    path: `private-${id}`,
    sha256: sha256(`content-${id}`),
    targetRuns: id === 'P31' || tags.includes('credit-utilization') ? 5 : 3,
    tags: [...tags]
  }))
  assert.equal(files.length, 31)
  assert.equal(files.reduce((sum, file) => sum + file.targetRuns, 0), 137)
  assert.equal(projectManifest({ version: 1, files }).length, 31)
  assert.equal(typeof buildSummaryV4, 'function')
  assert.equal(typeof evaluateGateV4, 'function')
})

test('v4 synthetic 31-file / 137-success batch passes the strict gate', async () => {
  const fixture = makeFixture()
  const result = await evaluate(fixture)
  assert.equal(result.strictPass, true, JSON.stringify(result.checks))
  assert.equal(result.snapshotValid, true)
  assert.equal(result.scope.fileInstances, 31)
  assert.equal(result.scope.plannedSuccessfulRuns, 137)
  assert.deepEqual(result.ownership, {
    scannedSuccessfulRuns: 5,
    scannedOwnershipVerifiedRuns: 5,
    scannedFilesOwnershipVerified: 1
  })
  assert.equal(fixture.summary.provisionalBatchComplete, true)
  assert.equal(fixture.summary.limitations.scannedCorpusCovered, true)
})

test('v4 rejects P31 when any successful scan lacks checksum-backed ownership evidence', async () => {
  const fixture = makeFixture()
  const scan = fixture.state.runs.find((run) => run.fileId === 'P31')
  scan.ownershipEvidence.idCardChecksumValid = false
  scan.ownershipEvidence.ownershipVerified = false
  refreshSummary(fixture)
  const result = await evaluate(fixture)
  assert.equal(result.strictPass, false)
  assert.ok(result.checks.scannedOwnershipViolations > 0)
  assert.equal(result.ownership.scannedOwnershipVerifiedRuns, 4)
})

test('v4 rejects service-line mismatch even when URL and HTTP status look valid', async () => {
  const fixture = makeFixture()
  fixture.state.runs[0].responseTarget.serviceIdentityMatched = false
  refreshSummary(fixture)
  const result = await evaluate(fixture)
  assert.equal(result.strictPass, false)
  assert.ok(result.checks.serviceIdentityViolations > 0)
  assert.ok(result.checks.successTransportViolations > 0)
})

test('v4 rejects a rewritten or unbound append-only ledger', async () => {
  {
    const fixture = makeFixture()
    fixture.ledgerEntries[1].previousEntrySha256 = sha256('rewritten')
    const result = await evaluate(fixture)
    assert.equal(result.strictPass, false)
    assert.ok(result.checks.ledgerSchemaViolations > 0)
  }
  {
    const fixture = makeFixture()
    fixture.ledgerEntries.pop()
    const result = await evaluate(fixture)
    assert.equal(result.strictPass, false)
    assert.ok(result.checks.ledgerBindingViolations > 0)
  }
})

test('v4 snapshot validation rejects extra state fields before a resume', async () => {
  const fixture = makeFixture()
  fixture.state.status = 'running'
  fixture.state.finishedAt = null
  fixture.state.unexpected = true
  refreshSummary(fixture)
  const result = await evaluate(fixture)
  assert.equal(result.snapshotValid, false)
  assert.ok(result.checks.stateEnvelopeViolations > 0)
})

test('v4 binds an in-flight request to the final request start, input and attempt', async () => {
  const fixture = makeFixture()
  const pending = fixture.state.runs.pop()
  fixture.state.status = 'running'
  fixture.state.finishedAt = null
  fixture.state.inFlight = {
    fileId: pending.fileId,
    round: pending.round,
    attempt: pending.attempt,
    startedAt: pending.startedAt,
    timeoutMs: 620000,
    inputSha256: pending.inputSha256,
    requestNonceHash: pending.requestNonceHash,
    targetId: 'legacy-analyze-v4'
  }
  refreshSummary(fixture)
  const valid = await evaluate(fixture)
  assert.equal(valid.snapshotValid, true, JSON.stringify(valid.checks))

  fixture.state.inFlight.inputSha256 = sha256('wrong-input')
  const wrongInput = await evaluate(fixture)
  assert.equal(wrongInput.snapshotValid, false)
  assert.ok(wrongInput.checks.stateEnvelopeViolations > 0)

  fixture.state.inFlight.inputSha256 = pending.inputSha256
  fixture.state.inFlight.requestNonceHash = sha256('wrong-nonce')
  const wrongStart = await evaluate(fixture)
  assert.equal(wrongStart.snapshotValid, false)
  assert.ok(wrongStart.checks.requestStartViolations > 0)

  fixture.state.inFlight.requestNonceHash = pending.requestNonceHash
  fixture.state.inFlight.timeoutMs = 1
  const wrongTimeout = await evaluate(fixture)
  assert.equal(wrongTimeout.snapshotValid, false)
  assert.ok(wrongTimeout.checks.stateEnvelopeViolations > 0)
})

test('v4 rejects a partially appended request-ledger line', () => {
  const fixture = makeFixture()
  const complete = fixture.ledgerEntries.map((entry) => JSON.stringify(entry)).join('\n')
  assert.throws(() => parseRequestLedger(`${complete}\n{"version":1`), SyntaxError)
})
