import { createHash, randomBytes } from 'node:crypto'
import { lstat, open, readFile, realpath, rename, rm, mkdir } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { mapServerAnalyzeDataToClientAnalysis } from '../src/services/serverAnalyzeMapper.js'
import {
  creditCardUsageRatePct,
  normalizeAccountForDetail,
  summarizeAccountsForDetail
} from '../src/utils/reportDetailAggregates.js'
import {
  detectCreditCardCurrency,
  summarizeCreditCardUtilization
} from '../src/utils/creditCardUtilization.js'
import {
  classifyAnalyzeFailure,
  classifyTransportError,
  validAnalyzeData
} from './legacy-analysis-response-policy.mjs'
import {
  buildSummaryV4,
  evaluateGateV4,
  extractOwnershipEvidence,
  ledgerEntrySha256,
  parseRequestLedger,
  validateStateSnapshotV4
} from './validate-legacy-analysis-consistency-v4.mjs'
import {
  acquireExclusiveDirectoryLock,
  releaseExclusiveDirectoryLockSync
} from './legacy-analysis-process-lock.mjs'

const LEGACY_BASE_URL = 'http://127.0.0.1:3200/legacy-api'
const ANALYZE_URL = `${LEGACY_BASE_URL}/api/analyze`
const ANALYZE_PATH = '/legacy-api/api/analyze'
const SAFE_TARGET_ID = 'legacy-analyze-v4'
const EXPECTED_SERVICE_LINE = 'legacy-isolated-v20260722'
// 身份头头名必须与 backend/server.js 的 res.setHeader 完全成对；改名只改一侧会让
// serviceIdentityMatched 恒为 false（读到不存在的头 → null === 期望值），门禁永远过不了却无人察觉。
const SERVICE_IDENTITY_HEADER = 'X-RPT-Service-Line'
const SERVICE_IDENTITY_HEADER_MISSING = 'service_identity_header_missing'
const GATE_VERSION = 4
let processLock = null
const releaseProcessLockSync = () => {
  if (!processLock) return
  if (releaseExclusiveDirectoryLockSync(processLock)) {
    processLock = null
  }
}
let fatalExitInProgress = false
const safeFatalExit = () => {
  if (fatalExitInProgress) return
  fatalExitInProgress = true
  releaseProcessLockSync()
  process.stderr.write('[fatal] legacy analysis runner failed safely\n')
  process.exit(2)
}
process.on('uncaughtException', safeFatalExit)
process.on('unhandledRejection', safeFatalExit)
process.on('exit', releaseProcessLockSync)
// 仅绑定匿名清单投影（id、PDF sha256、目标次数、排序后标签），不绑定本机路径。
// 这使路径可以迁移，同时任何样本、标签或目标次数变化都会被拒绝。
const EXPECTED_MANIFEST_PROJECTION_SHA256 = '6dd8ef66a56be3d4cebd620547e102a3f2ed556f7d4cf507cd8177b85b7cc8c5'
const EXPECTED_TAGS_BY_ID = Object.freeze({
  P01: ['credit-utilization', 'same-day-multi-cny', 'shared-limit-candidate'],
  P02: ['baseline', 'no-target-credit-fields'],
  P03: ['credit-utilization'],
  P04: ['credit-utilization', 'shared-limit-candidate'],
  P05: ['credit-utilization', 'duplicate-d1', 'shared-limit-candidate'],
  P06: ['credit-utilization'],
  P07: ['credit-utilization'],
  P08: ['baseline', 'no-explicit-used-limit'],
  P09: ['credit-utilization', 'same-day-multi-cny', 'shared-limit-candidate'],
  P10: ['baseline', 'no-explicit-used-limit'],
  P11: ['credit-utilization', 'shared-limit-candidate'],
  P12: ['baseline', 'no-explicit-used-limit'],
  P13: ['credit-utilization', 'shared-limit-candidate'],
  P14: ['credit-utilization', 'shared-limit-candidate'],
  P15: ['baseline', 'no-explicit-used-limit'],
  P16: ['baseline', 'no-explicit-used-limit'],
  P17: ['credit-utilization', 'same-day-multi-cny'],
  P18: ['baseline', 'short-sparse-text'],
  P19: ['credit-utilization', 'duplicate-d1', 'shared-limit-candidate'],
  P20: ['credit-utilization', 'shared-limit-candidate'],
  P21: ['credit-utilization'],
  P22: ['baseline', 'no-explicit-used-limit'],
  P23: ['baseline', 'no-explicit-used-limit'],
  P24: ['credit-utilization', 'shared-limit-candidate'],
  P25: ['credit-utilization'],
  P26: ['credit-utilization', 'duplicate-d2', 'shared-limit-candidate'],
  P27: ['credit-utilization', 'duplicate-d2', 'shared-limit-candidate'],
  P28: ['credit-utilization', 'shared-limit-candidate'],
  P29: ['credit-utilization'],
  P30: ['credit-utilization', 'same-day-multi-cny'],
  P31: ['scanned-pdf']
})
const EXPECTED_FOCUS_IDS = new Set([
  'P01', 'P03', 'P04', 'P05', 'P06', 'P07', 'P09', 'P11', 'P13', 'P14', 'P17',
  'P19', 'P20', 'P21', 'P24', 'P25', 'P26', 'P27', 'P28', 'P29', 'P30', 'P31'
])
const EXPECTED_SHARED_IDS = new Set([
  'P01', 'P04', 'P05', 'P09', 'P11', 'P13', 'P14', 'P19', 'P20', 'P24', 'P26', 'P27', 'P28'
])
const EXPECTED_MULTI_CNY_IDS = new Set(['P01', 'P09', 'P17', 'P30'])
const EXPECTED_SCANNED_IDS = new Set(['P31'])
const EXPECTED_DUPLICATE_GROUPS = Object.freeze([
  ['P05', 'P19'],
  ['P26', 'P27']
])
const DEFAULT_TIMEOUT_MS = 620_000
const DEFAULT_MAX_STARTS_PER_HOUR = 28
const DEFAULT_MIN_START_INTERVAL_MS = 15_000
const DEFAULT_MAX_OUTER_ATTEMPTS = 3
const RETRYABLE_ERROR_CLASSES = new Set(['rate_limit', 'server_5xx'])
const BLOCKED_STATUSES = new Set([
  'blocked',
  'blocked_input_changed',
  'blocked_auth',
  'blocked_model_response',
  'blocked_response_target',
  'blocked_non_retryable',
  'blocked_validation'
])

const argv = process.argv.slice(2)
const hasFlag = (flag) => argv.includes(flag)
const argValue = (flag, fallback = '') => {
  const index = argv.indexOf(flag)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback
}
const positiveInt = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

const manifestPath = resolve(argValue('--manifest'))
const statePath = resolve(argValue('--state'))
const summaryPath = resolve(argValue('--summary'))
const requestLedgerPath = resolve(argValue('--request-ledger'))
const dryRun = hasFlag('--dry-run')
const confirmedLiveLegacy = hasFlag('--confirm-live-legacy')
const resumeAfterInflight = hasFlag('--resume-after-inflight')
const resumeAfterReview = hasFlag('--resume-after-review')
const onlyId = String(argValue('--only-id') || '').trim()
const timeoutMs = positiveInt(argValue('--timeout-ms'), DEFAULT_TIMEOUT_MS)
const maxStartsPerHour = Math.min(
  DEFAULT_MAX_STARTS_PER_HOUR,
  positiveInt(argValue('--max-starts-per-hour'), DEFAULT_MAX_STARTS_PER_HOUR)
)
const minStartIntervalMs = Math.max(
  DEFAULT_MIN_START_INTERVAL_MS,
  positiveInt(argValue('--min-start-interval-ms'), DEFAULT_MIN_START_INTERVAL_MS)
)
const maxOuterAttempts = Math.min(
  DEFAULT_MAX_OUTER_ATTEMPTS,
  positiveInt(argValue('--max-outer-attempts'), DEFAULT_MAX_OUTER_ATTEMPTS)
)
const stopAfterRaw = Number(argValue('--stop-after-new-successes'))
const stopAfterNewSuccesses = Number.isFinite(stopAfterRaw) && stopAfterRaw > 0
  ? Math.floor(stopAfterRaw)
  : Number.POSITIVE_INFINITY

if (!argValue('--manifest') || !argValue('--state') || !argValue('--summary') || !argValue('--request-ledger')) {
  throw new Error('必须提供 --manifest、--state、--summary、--request-ledger')
}
if (timeoutMs !== DEFAULT_TIMEOUT_MS) {
  throw new Error('v4批次请求超时必须使用受信固定值')
}
if (!dryRun && !confirmedLiveLegacy) {
  throw new Error('真实运行必须显式提供 --confirm-live-legacy')
}

const privateRoot = resolve(process.cwd(), 'tmp')
const trustedRuntimeRoot = resolve(privateRoot, 'real-analysis-v4-20260722-private')
const trustedRuntimeFiles = new Map([
  [manifestPath, resolve(trustedRuntimeRoot, 'manifest.private.json')],
  [statePath, resolve(trustedRuntimeRoot, 'state-v4.private.json')],
  [summaryPath, resolve(trustedRuntimeRoot, 'summary-v4.private.json')],
  [requestLedgerPath, resolve(trustedRuntimeRoot, 'request-ledger-v4.private.jsonl')]
])
for (const [actual, expected] of trustedRuntimeFiles) {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error('v4批次控制文件必须使用唯一受信运行目录与固定文件名')
  }
}
if (new Set([manifestPath, statePath, summaryPath, requestLedgerPath]).size !== 4) {
  throw new Error('private runtime paths must be distinct')
}
for (const [label, path] of [
  ['manifest', manifestPath],
  ['state', statePath],
  ['summary', summaryPath]
]) {
  if (!path.startsWith(`${privateRoot}\\`) || !basename(path).endsWith('.private.json')) {
    throw new Error(`${label} 必须位于当前仓库 tmp/ 下并以 .private.json 结尾`)
  }
}
if (!requestLedgerPath.startsWith(`${privateRoot}\\`)
  || !basename(requestLedgerPath).endsWith('.private.jsonl')) {
  throw new Error('request ledger 必须位于当前仓库 tmp/ 下并以 .private.jsonl 结尾')
}
const privateRootReal = await realpath(privateRoot)
for (const parent of new Set([
  dirname(manifestPath), dirname(statePath), dirname(summaryPath), dirname(requestLedgerPath)
])) {
  const info = await lstat(parent)
  const parentReal = await realpath(parent)
  if (info.isSymbolicLink()
    || (parentReal !== privateRootReal && !parentReal.startsWith(`${privateRootReal}\\`))) {
    throw new Error('private runtime directory is unsafe')
  }
}
processLock = await acquireExclusiveDirectoryLock({
  lockPath: `${requestLedgerPath}.lock`,
  targetId: SAFE_TARGET_ID,
  resumeStale: resumeAfterInflight,
  staleAfterMs: 30_000
})

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const emptyOwnershipEvidence = () => ({
  trustedBasicInfoFound: false,
  nameCredible: false,
  idCardPresent: false,
  idCardFormatValid: false,
  idCardChecksumValid: false,
  ownershipVerified: false
})
let globalLedger = []
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const sleepInterruptibly = async (ms, shouldStop) => {
  const deadline = Date.now() + Math.max(0, ms)
  while (!shouldStop() && Date.now() < deadline) {
    await sleep(Math.min(1_000, deadline - Date.now()))
  }
}
const isoNow = () => new Date().toISOString()

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    )
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  return value
}

const canonicalJson = (value) => JSON.stringify(canonicalize(value))

const manifestProjection = (manifest) => (Array.isArray(manifest?.files) ? manifest.files : [])
  .map((file) => ({
    id: String(file?.id || ''),
    sha256: String(file?.sha256 || '').toLowerCase(),
    targetRuns: file?.targetRuns,
    tags: [...(Array.isArray(file?.tags) ? file.tags : [])].map(String).sort()
  }))
  .sort((left, right) => left.id.localeCompare(right.id))

const manifestProjectionSha256 = (manifest) => sha256(canonicalJson(manifestProjection(manifest)))

const getPath = (value, path) => {
  let current = value
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object' || !(part in current)) return undefined
    current = current[part]
  }
  return current
}

// 只对白名单核心路径记录“类型 + 数组长度”。不展开任意对象键，避免把
// 模型生成的动态键、报告正文或身份字段带入状态文件，同时可按字段哈希定位漂移。
const CORE_STRUCTURE_PATHS = [
  'meta',
  'assessment',
  'credit_debt',
  'credit_debt.credit_loans',
  'credit_debt.credit_cards',
  'loan_details',
  'loan_details.bank_loans',
  'loan_details.non_bank_loans',
  'credit_card_details',
  'overdue_info',
  'overdue_info.details',
  'query_analysis',
  'query_analysis.query_details',
  'query_analysis.summary',
  'public_records',
  'risk_analysis',
  'risk_analysis.risk_hits',
  'rule_engine_warnings',
  'frontend_payload',
  'data_completeness'
]

const structureDescriptor = (value) => {
  if (value === undefined) return { type: 'absent' }
  if (value === null) return { type: 'null' }
  if (Array.isArray(value)) return { type: 'array', length: value.length }
  return { type: typeof value }
}

const extractCoreStructure = (data) => {
  const descriptors = Object.fromEntries(
    CORE_STRUCTURE_PATHS.map((path) => [path, structureDescriptor(getPath(data, path))])
  )
  return {
    sha256: sha256(canonicalJson(descriptors)),
    descriptors,
    fieldHashes: Object.fromEntries(
      CORE_STRUCTURE_PATHS.map((path) => [path, sha256(canonicalJson(descriptors[path]))])
    )
  }
}

const SAFE_METRIC_PATHS = [
  'assessment.score',
  'assessment.risk_level',
  'credit_debt.total_debt',
  'credit_debt.debt_ratio',
  'credit_debt.credit_loans.total_amount',
  'credit_debt.credit_loans.total_count',
  'credit_debt.credit_cards.total_limit',
  'credit_debt.credit_cards.total_used',
  'credit_debt.credit_cards.usage_rate',
  'credit_debt.credit_cards.card_count',
  'credit_debt.credit_cards.raw_total_limit',
  'credit_debt.credit_cards.utilization_group_count',
  'credit_debt.credit_cards.foreign_currency_account_count',
  'credit_debt.credit_cards.shared_group_count',
  'loan_details.total.balance',
  'loan_details.total.credit_limit',
  'loan_details.total.count',
  'overdue_info.overdue_count',
  'overdue_info.current_overdue_count',
  'overdue_info.overdue_account_count',
  'query_analysis.summary.last_1m.total',
  'query_analysis.summary.last_3m.total',
  'query_analysis.summary.last_6m.total',
  'query_analysis.summary.last_12m.total',
  'query_analysis.summary.last_24m.total'
]

const extractMetrics = (data) => {
  const metrics = {}
  for (const path of SAFE_METRIC_PATHS) {
    const value = getPath(data, path)
    if (typeof value === 'number' && Number.isFinite(value)) metrics[path] = value
    if (path === 'assessment.risk_level' && typeof value === 'string') {
      if (/低|low/i.test(value)) metrics[path] = 'low'
      else if (/中|medium|moderate/i.test(value)) metrics[path] = 'medium'
      else if (/高|high/i.test(value)) metrics[path] = 'high'
    }
  }
  metrics['credit_card_details.count'] = Array.isArray(data?.credit_card_details)
    ? data.credit_card_details.length
    : 0
  metrics['rule_engine_warnings.count'] = Array.isArray(data?.rule_engine_warnings)
    ? data.rule_engine_warnings.length
    : 0
  return metrics
}

const CLOSED_CARD_RE = /销户|注销|关闭|销卡|作废|已结清|结清/
const compactText = (value) => String(value == null ? '' : value).replace(/\s+/g, '').trim().toLowerCase()
const firstText = (...values) => {
  for (const value of values) {
    const text = String(value == null ? '' : value).trim()
    if (text) return text
  }
  return ''
}
const explicitCardTail = (row) => firstText(
  row?.card_tail,
  row?.cardTail,
  row?.tail_number,
  row?.tailNumber,
  row?.last4
).replace(/\D/g, '').slice(-4)
const explicitSharedGroup = (row) => firstText(row?.shared_credit_group, row?.sharedCreditGroup)
const explicitUtilizationGroup = (row) => firstText(row?.utilization_group, row?.utilizationGroup)
// 与 summarizeCreditCardUtilization 的显式分组优先级一致：共享额度组优先，
// 其次才采用利用率组。
const effectiveExplicitGroup = (row) => firstText(
  row?.shared_credit_group,
  row?.sharedCreditGroup,
  row?.utilization_group,
  row?.utilizationGroup
)
const accountInstitution = (row) => compactText(firstText(row?.institution, row?.bank, row?.issuer))
const accountOpenDate = (row) => {
  const raw = firstText(
    row?.start_date,
    row?.startDate,
    row?.open_date,
    row?.openDate
  ).replace(/[./]/g, '-')
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
  return raw.slice(0, 10)
}
const activeCardRow = (row) => row
  && typeof row === 'object'
  && row.isLoan !== true
  && row.isSettled !== true
  && row.is_settled !== true
  && !CLOSED_CARD_RE.test(String(row.status || ''))

const sameMetadata = (left, right) => compactText(left) === compactText(right)

const verifyCardMetadataPreservation = (data, mappedCardAccounts, normalizedCardAccounts) => {
  const sourceRows = (Array.isArray(data?.credit_card_details) ? data.credit_card_details : [])
    .filter(activeCardRow)
  const rowsAligned = sourceRows.length === mappedCardAccounts.length
    && mappedCardAccounts.length === normalizedCardAccounts.length
  const sourceMappedPairs = rowsAligned
    ? sourceRows.map((source, index) => ({ source, mapped: mappedCardAccounts[index], normalized: normalizedCardAccounts[index] }))
    : []
  const normalizedRawPreserved = rowsAligned && sourceMappedPairs.every(({ mapped, normalized }) => (
    normalized?.raw === mapped
    || canonicalJson(normalized?.raw || {}) === canonicalJson(mapped || {})
  ))
  const currencyPreserved = rowsAligned && sourceMappedPairs.every(({ source, mapped, normalized }) => {
    const sourceValue = firstText(source?.currency, source?.currency_code, source?.currencyCode)
      || detectCreditCardCurrency(source)
    return (!sourceValue || sameMetadata(sourceValue, mapped?.currency))
      && sameMetadata(mapped?.currency, normalized?.currency)
  })
  const cardTailPreserved = rowsAligned && sourceMappedPairs.every(({ source, mapped, normalized }) => {
    const sourceValue = explicitCardTail(source)
    const mappedValue = explicitCardTail(mapped)
    const normalizedValue = explicitCardTail(normalized)
    return (!sourceValue || (sourceValue.length === 4 && sourceValue === mappedValue))
      && mappedValue === normalizedValue
  })
  const sharedCreditGroupPreserved = rowsAligned && sourceMappedPairs.every(({ source, mapped, normalized }) => {
    const sourceValue = explicitSharedGroup(source)
    const mappedValue = explicitSharedGroup(mapped)
    return (!sourceValue || sameMetadata(sourceValue, mappedValue))
      && sameMetadata(mappedValue, explicitSharedGroup(normalized))
  })
  const utilizationGroupPreserved = rowsAligned && sourceMappedPairs.every(({ source, mapped, normalized }) => {
    const sourceValue = explicitUtilizationGroup(source)
    const mappedValue = explicitUtilizationGroup(mapped)
    return (!sourceValue || sameMetadata(sourceValue, mappedValue))
      && sameMetadata(mappedValue, explicitUtilizationGroup(normalized))
  })
  const checks = {
    cardMetadataRowsAligned: rowsAligned,
    normalizedCardRawPreserved: normalizedRawPreserved,
    currencyMetadataPreserved: currencyPreserved,
    cardTailMetadataPreserved: cardTailPreserved,
    sharedCreditGroupMetadataPreserved: sharedCreditGroupPreserved,
    utilizationGroupMetadataPreserved: utilizationGroupPreserved
  }
  return {
    checks,
    evidenceSha256: sha256(canonicalJson(checks)),
    sourceRows
  }
}

const verifySameDayMultiCny = ({ sourceRows, mappedCardAccounts, normalizedCardAccounts }) => {
  const mappedRowsAligned = sourceRows.length === mappedCardAccounts.length
    && mappedCardAccounts.length === normalizedCardAccounts.length
  let sourceCandidateProven = false
  let mappedSeparationProven = false
  let normalizedMetadataRetained = false
  let utilizationGroupsProven = false

  if (mappedRowsAligned) {
    for (let leftIndex = 0; leftIndex < sourceRows.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < sourceRows.length; rightIndex += 1) {
        const left = sourceRows[leftIndex]
        const right = sourceRows[rightIndex]
        const sameInstitutionAndDate = !!accountInstitution(left)
          && accountInstitution(left) === accountInstitution(right)
          && !!accountOpenDate(left)
          && accountOpenDate(left) === accountOpenDate(right)
        const bothExplicitCny = detectCreditCardCurrency(left) === 'CNY'
          && detectCreditCardCurrency(right) === 'CNY'
        const sourceTailSeparated = explicitCardTail(left).length === 4
          && explicitCardTail(right).length === 4
          && explicitCardTail(left) !== explicitCardTail(right)
        const sourceGroupSeparated = !!effectiveExplicitGroup(left)
          && !!effectiveExplicitGroup(right)
          && !sameMetadata(effectiveExplicitGroup(left), effectiveExplicitGroup(right))
        if (!sameInstitutionAndDate || !bothExplicitCny || (!sourceTailSeparated && !sourceGroupSeparated)) continue

        sourceCandidateProven = true
        const mappedLeft = mappedCardAccounts[leftIndex]
        const mappedRight = mappedCardAccounts[rightIndex]
        const mappedIdentityRetained = accountInstitution(mappedLeft) === accountInstitution(left)
          && accountInstitution(mappedRight) === accountInstitution(right)
          && accountOpenDate(mappedLeft) === accountOpenDate(left)
          && accountOpenDate(mappedRight) === accountOpenDate(right)
          && detectCreditCardCurrency(mappedLeft) === 'CNY'
          && detectCreditCardCurrency(mappedRight) === 'CNY'
        const mappedTailSeparated = explicitCardTail(mappedLeft).length === 4
          && explicitCardTail(mappedRight).length === 4
          && explicitCardTail(mappedLeft) !== explicitCardTail(mappedRight)
        const mappedGroupSeparated = !!effectiveExplicitGroup(mappedLeft)
          && !!effectiveExplicitGroup(mappedRight)
          && !sameMetadata(effectiveExplicitGroup(mappedLeft), effectiveExplicitGroup(mappedRight))
        mappedSeparationProven = mappedIdentityRetained && (mappedTailSeparated || mappedGroupSeparated)

        const normalizedLeft = normalizedCardAccounts[leftIndex]
        const normalizedRight = normalizedCardAccounts[rightIndex]
        normalizedMetadataRetained = accountInstitution(normalizedLeft) === accountInstitution(mappedLeft)
          && accountInstitution(normalizedRight) === accountInstitution(mappedRight)
          && accountOpenDate(normalizedLeft) === accountOpenDate(mappedLeft)
          && accountOpenDate(normalizedRight) === accountOpenDate(mappedRight)
          && detectCreditCardCurrency(normalizedLeft) === 'CNY'
          && detectCreditCardCurrency(normalizedRight) === 'CNY'
          && (!mappedTailSeparated || (
            explicitCardTail(normalizedLeft) === explicitCardTail(mappedLeft)
            && explicitCardTail(normalizedRight) === explicitCardTail(mappedRight)
          ))
          && (!mappedGroupSeparated || (
            sameMetadata(effectiveExplicitGroup(normalizedLeft), effectiveExplicitGroup(mappedLeft))
            && sameMetadata(effectiveExplicitGroup(normalizedRight), effectiveExplicitGroup(mappedRight))
          ))
        const targetUtilization = summarizeCreditCardUtilization([normalizedLeft, normalizedRight])
        utilizationGroupsProven = targetUtilization.activeAccountCount === 2
          && targetUtilization.utilizationGroupCount === 2
          && targetUtilization.rowDecisions.length === 2
          && targetUtilization.rowDecisions.every((decision) => decision.included === true)
          && targetUtilization.rowDecisions[0].groupKey !== targetUtilization.rowDecisions[1].groupKey
        if (mappedSeparationProven && normalizedMetadataRetained && utilizationGroupsProven) break
      }
      if (mappedSeparationProven && normalizedMetadataRetained && utilizationGroupsProven) break
    }
  }

  const checks = {
    multiCnySourceCandidateProven: sourceCandidateProven,
    multiCnyMappedRowsAligned: mappedRowsAligned,
    multiCnyMappedSeparationProven: mappedSeparationProven,
    multiCnyNormalizedMetadataRetained: normalizedMetadataRetained,
    multiCnyUtilizationGroupsProven: utilizationGroupsProven,
    multiCnyKeptSeparate: sourceCandidateProven
      && mappedRowsAligned
      && mappedSeparationProven
      && normalizedMetadataRetained
      && utilizationGroupsProven
  }
  return { checks, evidenceSha256: sha256(canonicalJson(checks)) }
}

const buildSharedDedupSideEvidence = (rows) => {
  const utilization = summarizeCreditCardUtilization(rows)
  const groups = []
  for (const group of utilization.groups || []) {
    const decisions = (utilization.rowDecisions || [])
      .filter((decision) => decision.groupKey === group.key)
      .map((decision) => ({ included: decision.included === true }))
    const basis = String(group.key || '').startsWith('explicit:')
      ? 'explicit'
      : (String(group.key || '').startsWith('date:') ? 'inferred' : 'other')
    // 共享额度证据必须是显式组或“机构+开户日”推断组，且实际包含多个成员。
    // 纯外币、未纳入整体口径的组不能替代共享额度证据。
    if (basis === 'other' || group.memberCount < 2 || group.included !== true) continue
    groups.push({
      basis,
      memberCount: Number(group.memberCount),
      includedMemberCount: decisions.filter((decision) => decision.included).length,
      members: decisions
    })
  }
  return {
    qualifyingGroupCount: groups.length,
    explicitGroupCount: groups.filter((group) => group.basis === 'explicit').length,
    inferredGroupCount: groups.filter((group) => group.basis === 'inferred').length,
    allGroupsHaveMultipleMembers: groups.length > 0 && groups.every((group) => group.memberCount > 1),
    allGroupsUseSingleRepresentative: groups.length > 0
      && groups.every((group) => group.includedMemberCount === 1),
    groups
  }
}

const buildSharedDedupEvidence = (sourceRows, normalizedCardAccounts) => {
  const evidence = {
    backend: buildSharedDedupSideEvidence(sourceRows),
    web: buildSharedDedupSideEvidence(normalizedCardAccounts)
  }
  const checks = {
    backendSharedGroupPresent: evidence.backend.qualifyingGroupCount > 0,
    webSharedGroupPresent: evidence.web.qualifyingGroupCount > 0,
    sharedGroupsNotForeignOnly: evidence.backend.qualifyingGroupCount > 0
      && evidence.web.qualifyingGroupCount > 0,
    backendSharedGroupHasMultipleMembers: evidence.backend.allGroupsHaveMultipleMembers === true,
    backendSharedGroupSingleRepresentative: evidence.backend.allGroupsUseSingleRepresentative === true,
    webSharedGroupHasMultipleMembers: evidence.web.allGroupsHaveMultipleMembers === true,
    webSharedGroupSingleRepresentative: evidence.web.allGroupsUseSingleRepresentative === true
  }
  checks.sharedDedupEvidenceConsistent = Object.values(checks).every((value) => value === true)
  return {
    checks,
    evidence,
    evidenceSha256: sha256(canonicalJson(evidence))
  }
}

const extractWebValidation = (data) => {
  try {
    const mapped = mapServerAnalyzeDataToClientAnalysis(data)
    const rawAccounts = Array.isArray(mapped?.report?.creditAccounts)
      ? mapped.report.creditAccounts
      : (Array.isArray(mapped?.accounts) ? mapped.accounts : [])
    const accounts = rawAccounts.map(normalizeAccountForDetail)
    const summary = summarizeAccountsForDetail(accounts)
    const mappedCardAccounts = rawAccounts.filter((account, index) => (
      !accounts[index]?.isLoan && accounts[index]?.active
    ))
    const normalizedCardAccounts = accounts.filter((account) => !account.isLoan && account.active)
    const creditDebt = mapped?.creditReportV2?.credit_debt
      || mapped?.credit_debt
      || mapped?.creditDebt
      || {}
    const detailUsagePct = creditCardUsageRatePct(
      creditDebt?.credit_cards || creditDebt?.creditCards || {},
      mapped?.dimensions || {},
      rawAccounts
    )
    const metadata = verifyCardMetadataPreservation(data, mappedCardAccounts, normalizedCardAccounts)
    const multiCny = verifySameDayMultiCny({
      sourceRows: metadata.sourceRows,
      mappedCardAccounts,
      normalizedCardAccounts
    })
    const sharedDedup = buildSharedDedupEvidence(metadata.sourceRows, normalizedCardAccounts)
    return {
      metrics: {
        'web.cardUsed': summary.cardUsed,
        'web.cardLimit': summary.cardLimit,
        'web.cardUsagePct': summary.cardUsagePct,
        'web.creditCardUsageRatePct': detailUsagePct,
        'web.cardUtilizationGroupCount': summary.cardUtilizationGroupCount,
        'web.cardSharedGroupCount': summary.cardSharedGroupCount,
        'web.cardInferredSharedGroupCount': summary.cardInferredSharedGroupCount,
        'web.cardForeignCurrencyAccountCount': summary.cardForeignCurrencyAccountCount,
        'web.highUsageCount': summary.highUsage,
        'web.cardCount': summary.card,
        'web.loanCount': summary.loan,
        'web.accountCount': summary.total,
        'web.mapperOk': true
      },
      metadataChecks: metadata.checks,
      metadataEvidenceSha256: metadata.evidenceSha256,
      multiCnyChecks: multiCny.checks,
      multiCnyEvidenceSha256: multiCny.evidenceSha256,
      sharedDedupChecks: sharedDedup.checks,
      sharedDedupEvidence: sharedDedup.evidence,
      sharedDedupEvidenceSha256: sharedDedup.evidenceSha256
    }
  } catch {
    return {
      metrics: { 'web.mapperOk': false },
      metadataChecks: {},
      metadataEvidenceSha256: sha256('web_mapper_failed'),
      multiCnyChecks: {},
      multiCnyEvidenceSha256: sha256('web_mapper_failed'),
      sharedDedupChecks: {},
      sharedDedupEvidence: { backend: {}, web: {} },
      sharedDedupEvidenceSha256: sha256('web_mapper_failed')
    }
  }
}

// 这是后台响应的共享额度语义信号，不代表 Web 页面出现过可见 UI 提示。
const containsBackendSharedLimitSemanticSignal = (data) => {
  const texts = []
  if (typeof data?._coverage?.notes === 'string') texts.push(data._coverage.notes)
  if (Array.isArray(data?.rule_engine_warnings)) {
    texts.push(...data.rule_engine_warnings.map((value) => (
      typeof value === 'string' ? value : JSON.stringify(value)
    )))
  }
  return /共享额度|共享授信|去重|不重复计入/.test(texts.join('\n'))
}

const validateCreditCardFormula = (data, metrics, tags = [], webValidation = {}) => {
  const tagSet = new Set(tags)
  const creditFocus = tagSet.has('credit-utilization')
  const sharedFocus = tagSet.has('shared-limit-candidate')
  const multiCnyFocus = tagSet.has('same-day-multi-cny')
  const totalLimit = Number(metrics['credit_debt.credit_cards.total_limit'])
  const totalUsed = Number(metrics['credit_debt.credit_cards.total_used'])
  const usageRate = Number(metrics['credit_debt.credit_cards.usage_rate'])
  const rawTotalLimit = Number(metrics['credit_debt.credit_cards.raw_total_limit'])
  const cardCount = Number(metrics['credit_debt.credit_cards.card_count'])
  const groupCount = Number(metrics['credit_debt.credit_cards.utilization_group_count'])
  const sharedGroupCount = Number(metrics['credit_debt.credit_cards.shared_group_count'])
  const webUsed = Number(metrics['web.cardUsed'])
  const webLimit = Number(metrics['web.cardLimit'])
  const webUsagePct = Number(metrics['web.cardUsagePct'])
  const detailUsagePct = Number(metrics['web.creditCardUsageRatePct'])
  const webGroupCount = Number(metrics['web.cardUtilizationGroupCount'])
  const webSharedGroupCount = Number(metrics['web.cardSharedGroupCount'])
  const webInferredSharedGroupCount = Number(metrics['web.cardInferredSharedGroupCount'])
  const webCardCount = Number(metrics['web.cardCount'])
  const cardRows = Array.isArray(data?.credit_card_details) ? data.credit_card_details : []
  const backendCardCountPositive = creditFocus ? Number.isFinite(cardCount) && cardCount > 0 : null
  const backendCardDetailsPresent = creditFocus ? cardRows.length > 0 : null
  const webCardCountPositive = creditFocus ? Number.isFinite(webCardCount) && webCardCount > 0 : null
  const creditCardStrict = creditFocus
    ? backendCardCountPositive && backendCardDetailsPresent && webCardCountPositive
    : null
  const finiteCore = creditFocus
    ? [totalLimit, totalUsed, usageRate].every(Number.isFinite)
    : [totalLimit, totalUsed, usageRate]
        .filter((value) => !Number.isNaN(value))
        .every(Number.isFinite)
  const expectedRate = Number.isFinite(totalLimit) && Number.isFinite(totalUsed)
    ? (totalLimit > 0 ? totalUsed / totalLimit : (totalUsed === 0 ? 0 : null))
    : null
  const utilizationMatches = expectedRate === null || !Number.isFinite(usageRate)
    ? (creditFocus ? false : null)
    : Math.abs(usageRate - expectedRate) <= 0.00015
  const sharedLimitDoesNotIncrease = Number.isFinite(rawTotalLimit) && Number.isFinite(totalLimit)
    ? totalLimit <= rawTotalLimit
    : null
  const groupingCountsSane = Number.isFinite(groupCount) && Number.isFinite(cardCount)
    ? groupCount >= 0 && groupCount <= Math.max(cardCount, cardRows.length)
    : (creditFocus ? false : null)
  const webFiniteCore = creditFocus
    ? [webUsed, webLimit, webUsagePct, webGroupCount].every(Number.isFinite)
    : null
  const webExpectedPct = Number.isFinite(webLimit) && Number.isFinite(webUsed)
    ? (webLimit > 0 ? Math.round((webUsed / webLimit) * 100) : (webUsed === 0 ? 0 : null))
    : null
  const webUtilizationMatches = webExpectedPct === null || !Number.isFinite(webUsagePct)
    ? (creditFocus ? false : null)
    : webExpectedPct === webUsagePct
  const backendWebUsageAgree = Number.isFinite(usageRate) && Number.isFinite(webUsagePct)
    ? Math.round(usageRate * 100) === webUsagePct
    : (creditFocus ? false : null)
  const detailUsageFinite = creditFocus ? Number.isFinite(detailUsagePct) : null
  const detailUsageMatchesExpected = webExpectedPct === null || !Number.isFinite(detailUsagePct)
    ? (creditFocus ? false : null)
    : detailUsagePct === webExpectedPct
  const sharedDedupChecks = webValidation?.sharedDedupChecks || {}
  const backendSharedMetricPositive = sharedFocus
    ? Number.isFinite(sharedGroupCount) && sharedGroupCount > 0
    : null
  const webSharedMetricPositive = sharedFocus
    ? [webSharedGroupCount, webInferredSharedGroupCount]
        .some((value) => Number.isFinite(value) && value > 0)
    : null
  const backendSharedGroupPresent = sharedFocus
    ? backendSharedMetricPositive && sharedDedupChecks.backendSharedGroupPresent === true
    : null
  const webSharedGroupPresent = sharedFocus
    ? webSharedMetricPositive && sharedDedupChecks.webSharedGroupPresent === true
    : null
  const sharedCandidateDetected = sharedFocus
    ? backendSharedGroupPresent && webSharedGroupPresent
    : null
  const sharedLimitReduced = sharedFocus
    ? Number.isFinite(rawTotalLimit) && Number.isFinite(totalLimit) && rawTotalLimit > totalLimit
    : null
  const cardMetadataChecks = webValidation?.metadataChecks || {}
  const cardMetadataPreserved = creditFocus || sharedFocus || multiCnyFocus
    ? [
        'cardMetadataRowsAligned',
        'normalizedCardRawPreserved',
        'currencyMetadataPreserved',
        'cardTailMetadataPreserved',
        'sharedCreditGroupMetadataPreserved',
        'utilizationGroupMetadataPreserved'
      ].every((name) => cardMetadataChecks[name] === true)
    : null
  const multiCnyChecks = webValidation?.multiCnyChecks || {}
  const multiCnyKeptSeparate = multiCnyFocus
    ? multiCnyChecks.multiCnyKeptSeparate === true
    : null
  return {
    finiteCore,
    utilizationMatches,
    sharedLimitDoesNotIncrease,
    groupingCountsSane,
    webFiniteCore,
    webUtilizationMatches,
    backendWebUsageAgree,
    detailUsageFinite,
    detailUsageMatchesExpected,
    backendCardCountPositive,
    backendCardDetailsPresent,
    webCardCountPositive,
    creditCardStrict,
    cardMetadataPreserved,
    ...cardMetadataChecks,
    backendSharedMetricPositive,
    webSharedMetricPositive,
    ...(sharedFocus ? sharedDedupChecks : {}),
    sharedCandidateDetected,
    sharedLimitReduced,
    multiCnyKeptSeparate,
    ...(multiCnyFocus ? multiCnyChecks : {})
  }
}

const parseRateLimit = (headers) => {
  const raw = String(headers.get('ratelimit') || '')
  const standardLimit = headers.get('ratelimit-limit')
  const standardRemaining = headers.get('ratelimit-remaining')
  const standardReset = headers.get('ratelimit-reset')
  const legacyLimit = standardLimit || headers.get('x-ratelimit-limit')
  const legacyRemaining = standardRemaining || headers.get('x-ratelimit-remaining')
  const retryAfter = headers.get('retry-after')
  const pick = (name) => {
    const match = raw.match(new RegExp(`${name}\\s*=\\s*(\\d+)`, 'i'))
    return match ? Number(match[1]) : null
  }
  return {
    limit: pick('limit') ?? (legacyLimit ? Number(legacyLimit) : null),
    remaining: pick('remaining') ?? (legacyRemaining ? Number(legacyRemaining) : null),
    resetSeconds: pick('reset') ?? (standardReset && /^\d+$/.test(standardReset) ? Number(standardReset) : null),
    retryAfterSeconds: retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null
  }
}

const writeFileDurably = async (path, value, flag = 'w') => {
  const handle = await open(path, flag)
  try {
    await handle.writeFile(value, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const syncExistingFile = async (path) => {
  const handle = await open(path, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const atomicWriteJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.tmp`
  const backupPath = `${path}.bak`
  await writeFileDurably(tempPath, `${JSON.stringify(value, null, 2)}\n`)
  await rm(backupPath, { force: true })
  try {
    await rename(path, backupPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  try {
    await rename(tempPath, path)
    await syncExistingFile(path)
    await rm(backupPath, { force: true })
  } catch (error) {
    try {
      await rm(path, { force: true })
      await rename(backupPath, path)
    } catch {}
    throw error
  }
}

const readJson = async (path) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (primaryError) {
    const backupPath = `${path}.bak`
    try {
      const recovered = JSON.parse(await readFile(backupPath, 'utf8'))
      await rm(path, { force: true })
      await rename(backupPath, path)
      return recovered
    } catch {
      throw primaryError
    }
  }
}

const readRequestLedger = async () => {
  try {
    return parseRequestLedger(await readFile(requestLedgerPath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

const appendRequestLedger = async ({ startedAt, requestNonceHash, manifestSha256 }) => {
  const previous = globalLedger.at(-1)
  const entry = {
    version: 1,
    sequence: globalLedger.length + 1,
    startedAt,
    requestNonceHash,
    targetId: SAFE_TARGET_ID,
    manifestSha256,
    previousEntrySha256: previous?.entrySha256 || null
  }
  entry.entrySha256 = ledgerEntrySha256(entry)
  // Do not allow analyzeOnce to run until the append has reached durable storage.
  await writeFileDurably(requestLedgerPath, `${JSON.stringify(entry)}\n`, 'a')
  globalLedger.push(entry)
}

const validateManifest = async (manifest) => {
  if (manifest?.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error('manifest 格式无效')
  }
  if (manifest.files.length !== 31) throw new Error('本批次必须且只能包含31份指定PDF')
  const ids = new Set()
  const expectedIds = Object.keys(EXPECTED_TAGS_BY_ID).sort()
  for (const file of manifest.files) {
    const id = String(file?.id || '')
    if (!/^P\d{2}$/.test(id) || !(id in EXPECTED_TAGS_BY_ID)) {
      throw new Error('manifest 含非本批次匿名 ID')
    }
    if (ids.has(id)) throw new Error(`manifest ID 重复: ${id}`)
    ids.add(id)
    if (!file.path || !/^[0-9a-f]{64}$/.test(String(file.sha256 || '')) || !Number.isInteger(file.targetRuns)) {
      throw new Error(`manifest 项不完整: ${id}`)
    }
    const tags = Array.isArray(file.tags) ? file.tags.map(String) : []
    const sortedTags = [...tags].sort()
    const expectedTags = EXPECTED_TAGS_BY_ID[id]
    if (new Set(tags).size !== tags.length || canonicalJson(sortedTags) !== canonicalJson(expectedTags)) {
      throw new Error(`${id} 匿名分类标签不匹配`)
    }
    const expectedRuns = EXPECTED_FOCUS_IDS.has(id) ? 5 : 3
    if (file.targetRuns !== expectedRuns) throw new Error(`${id} 目标次数不匹配`)
    if (EXPECTED_SHARED_IDS.has(id) !== tags.includes('shared-limit-candidate')) {
      throw new Error(`${id} 共享额度分类不匹配`)
    }
    if (EXPECTED_MULTI_CNY_IDS.has(id) !== tags.includes('same-day-multi-cny')) {
      throw new Error(`${id} 同日多人民币账户分类不匹配`)
    }
    if (EXPECTED_SCANNED_IDS.has(id) !== tags.includes('scanned-pdf')) {
      throw new Error(`${id} 扫描件分类不匹配`)
    }
    let bytes
    try {
      bytes = await readFile(file.path)
    } catch {
      throw new Error(`anonymous input unreadable: ${id}`)
    }
    if (sha256(bytes) !== file.sha256) throw new Error(`文件校验失败: ${id}`)
  }
  if (canonicalJson([...ids].sort()) !== canonicalJson(expectedIds)) {
    throw new Error('manifest 匿名 ID 集合不匹配')
  }
  for (const [left, right] of EXPECTED_DUPLICATE_GROUPS) {
    const leftSha = manifest.files.find((file) => file.id === left)?.sha256
    const rightSha = manifest.files.find((file) => file.id === right)?.sha256
    if (!leftSha || leftSha !== rightSha) throw new Error(`匿名重复组 ${left}/${right} 不匹配`)
  }
  const duplicateGroups = [...new Map(manifest.files.map((file) => [file.sha256, []])).keys()]
    .map((digest) => manifest.files.filter((file) => file.sha256 === digest).map((file) => file.id).sort())
    .filter((group) => group.length > 1)
    .sort((left, right) => left[0].localeCompare(right[0]))
  if (canonicalJson(duplicateGroups) !== canonicalJson(EXPECTED_DUPLICATE_GROUPS)) {
    throw new Error('manifest 匿名重复内容组不匹配')
  }
  if (manifestProjectionSha256(manifest) !== EXPECTED_MANIFEST_PROJECTION_SHA256) {
    throw new Error('manifest 受信匿名投影不匹配')
  }
  const planned = manifest.files.reduce((sum, file) => sum + file.targetRuns, 0)
  if (planned !== 137) throw new Error(`本批次目标成功次数应为137，实际为${planned}`)
  if (onlyId && !manifest.files.some((file) => file.id === onlyId)) {
    throw new Error(`--only-id 不在清单中: ${onlyId}`)
  }
}

const initialState = (manifestDigest) => ({
  version: GATE_VERSION,
  baseUrl: LEGACY_BASE_URL,
  analyzePath: ANALYZE_PATH,
  targetId: SAFE_TARGET_ID,
  manifestSha256: manifestDigest,
  startedAt: isoNow(),
  updatedAt: isoNow(),
  finishedAt: null,
  status: 'running',
  inFlight: null,
  serverBackoffUntil: null,
  requestStarts: [],
  runs: []
})

const successfulRun = (state, fileId, round) => state.runs.some(
  (run) => run.fileId === fileId && run.round === round && run.success === true
)

const attemptsForRun = (state, fileId, round) => state.runs.filter(
  (run) => run.fileId === fileId && run.round === round
).length

const buildQueue = (manifest, state, { respectOnlyId = true } = {}) => {
  const queue = []
  const maxTarget = Math.max(...manifest.files.map((file) => file.targetRuns))
  for (let round = 1; round <= maxTarget; round += 1) {
    const roundFiles = manifest.files
      .filter((file) => file.targetRuns >= round && (!respectOnlyId || !onlyId || file.id === onlyId))
      .sort((a, b) => sha256(`${round}:${a.id}`).localeCompare(sha256(`${round}:${b.id}`)))
    for (const file of roundFiles) {
      if (!successfulRun(state, file.id, round)) queue.push({ file, round })
    }
  }
  return queue
}

const waitForGlobalRateBudget = async (state) => {
  const cutoff = Date.now() - 60 * 60 * 1000
  const parsed = globalLedger
    .map((entry) => Date.parse(entry?.startedAt || ''))
    .filter((stamp) => Number.isFinite(stamp) && stamp > cutoff)
    .sort((a, b) => a - b)
  let waitMs = 0
  const serverBackoffUntil = Date.parse(state.serverBackoffUntil || '')
  if (Number.isFinite(serverBackoffUntil)) {
    waitMs = Math.max(waitMs, serverBackoffUntil - Date.now())
  }
  if (parsed.length >= maxStartsPerHour) {
    waitMs = Math.max(waitMs, parsed[0] + 60 * 60 * 1000 - Date.now() + 2_000)
  }
  const last = parsed.at(-1)
  if (last) waitMs = Math.max(waitMs, last + minStartIntervalMs - Date.now())
  if (waitMs > 0) {
    process.stdout.write(`[pace] waiting ${Math.ceil(waitMs / 1000)}s\n`)
    await sleepInterruptibly(waitMs, () => stopRequested)
  }
}

const analyzeOnce = async (file, token, { bytes, inputSha256, requestNonceHash }) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), `${file.id}.pdf`)
    const response = await fetch(ANALYZE_URL, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'rpt-legacy-consistency-audit/4.0',
        'X-RPT-Audit-Nonce': requestNonceHash
      },
      body: form,
      signal: controller.signal
    })
    const serviceIdentityHeaderValue = response.headers.get(SERVICE_IDENTITY_HEADER)
    if (serviceIdentityHeaderValue === null) {
      throw new Error(`${SERVICE_IDENTITY_HEADER_MISSING}：响应未携带 ${SERVICE_IDENTITY_HEADER} 头，无法核实服务身份（读不存在的头不等于不匹配，禁止静默判 false）`)
    }
    const responseTarget = {
      id: SAFE_TARGET_ID,
      redirected: response.redirected === true,
      urlMatched: response.url === ANALYZE_URL,
      serviceIdentityMatched: serviceIdentityHeaderValue === EXPECTED_SERVICE_LINE
    }
    const responseTargetOk = responseTarget.redirected === false
      && responseTarget.urlMatched === true
      && responseTarget.serviceIdentityMatched === true
    const raw = await response.text()
    let payload = null
    let payloadParsed = false
    try {
      payload = JSON.parse(raw)
      payloadParsed = true
    } catch {}
    const code = typeof payload?.code === 'number' ? payload.code : null
    const data = payload?.data
    const transportSuccess = responseTargetOk
      && response.status === 200
      && response.ok
      && code === 0
      && validAnalyzeData(data)
    const rateLimit = parseRateLimit(response.headers)
    if (!transportSuccess) {
      const message = String(payload?.msg || payload?.message || payload?.errMsg || '')
      return {
        success: false,
        gateVersion: GATE_VERSION,
        durationMs: Date.now() - started,
        httpStatus: response.status,
        code,
        errorClass: responseTarget.serviceIdentityMatched !== true
          ? 'service_identity_mismatch'
          : classifyAnalyzeFailure({
              responseTargetOk,
              status: response.status,
              code,
              payloadParsed,
              data,
              message
            }),
        errorMessageSha256: sha256(message || raw.slice(0, 512)),
        inputSha256,
        requestNonceHash,
        responseTarget,
        ownershipEvidence: emptyOwnershipEvidence(),
        webTimeoutExceeded: false,
        validationFailures: [],
        rateLimit
      }
    }
    const webValidation = extractWebValidation(data)
    const ownershipEvidence = extractOwnershipEvidence(data)
    const metrics = { ...extractMetrics(data), ...webValidation.metrics }
    const formulaChecks = validateCreditCardFormula(data, metrics, file.tags, webValidation)
    const coreStructure = extractCoreStructure(data)
    const tags = new Set(Array.isArray(file.tags) ? file.tags : [])
    const requiredChecks = []
    if (tags.has('credit-utilization')) {
      requiredChecks.push(
        'finiteCore',
        'utilizationMatches',
        'groupingCountsSane',
        'webFiniteCore',
        'webUtilizationMatches',
        'backendWebUsageAgree',
        'detailUsageFinite',
        'detailUsageMatchesExpected',
        'backendCardCountPositive',
        'backendCardDetailsPresent',
        'webCardCountPositive',
        'creditCardStrict',
        'cardMetadataPreserved'
      )
    }
    if (tags.has('shared-limit-candidate')) {
      requiredChecks.push(
        'sharedLimitDoesNotIncrease',
        'sharedCandidateDetected',
        'sharedLimitReduced',
        'cardMetadataPreserved',
        'backendSharedMetricPositive',
        'webSharedMetricPositive',
        'backendSharedGroupPresent',
        'webSharedGroupPresent',
        'sharedGroupsNotForeignOnly',
        'backendSharedGroupHasMultipleMembers',
        'backendSharedGroupSingleRepresentative',
        'webSharedGroupHasMultipleMembers',
        'webSharedGroupSingleRepresentative',
        'sharedDedupEvidenceConsistent'
      )
    }
    if (tags.has('same-day-multi-cny')) {
      requiredChecks.push(
        'cardMetadataPreserved',
        'multiCnySourceCandidateProven',
        'multiCnyMappedRowsAligned',
        'multiCnyMappedSeparationProven',
        'multiCnyNormalizedMetadataRetained',
        'multiCnyUtilizationGroupsProven',
        'multiCnyKeptSeparate'
      )
    }
    const durationMs = Date.now() - started
    const validationFailures = []
    const backendSharedLimitSemanticSignal = containsBackendSharedLimitSemanticSignal(data)
    if (metrics['web.mapperOk'] !== true) validationFailures.push('web_mapper')
    if (durationMs > 600_000) validationFailures.push('web_timeout')
    if (tags.has('shared-limit-candidate') && backendSharedLimitSemanticSignal !== true) {
      validationFailures.push('backend_shared_limit_semantic_signal')
    }
    if (tags.has('scanned-pdf') && ownershipEvidence.ownershipVerified !== true) {
      validationFailures.push('scanned_ownership')
    }
    for (const check of requiredChecks) {
      if (formulaChecks[check] !== true) validationFailures.push(check)
    }
    for (const [check, value] of Object.entries(formulaChecks)) {
      if (value === false && !validationFailures.includes(check)) validationFailures.push(check)
    }
    const qualitySuccess = validationFailures.length === 0
    if (!qualitySuccess) {
      return {
        success: false,
        durationMs,
        httpStatus: response.status,
        code,
        gateVersion: GATE_VERSION,
        inputSha256,
        requestNonceHash,
        responseTarget,
        ownershipEvidence,
        validationFailures,
        errorClass: 'validation_failed',
        errorMessageSha256: sha256(validationFailures.join(',')),
        webTimeoutExceeded: durationMs > 600_000,
        rateLimit
      }
    }
    return {
      success: true,
      durationMs,
      httpStatus: response.status,
      code,
      gateVersion: GATE_VERSION,
      inputSha256,
      requestNonceHash,
      responseTarget,
      ownershipEvidence,
      responseSha256: sha256(canonicalJson(data)),
      structureSha256: coreStructure.sha256,
      coreStructureSha256: coreStructure.sha256,
      coreStructureFields: coreStructure.descriptors,
      coreStructureFieldHashes: coreStructure.fieldHashes,
      metricsSha256: sha256(canonicalJson(metrics)),
      metrics,
      formulaChecks,
      formulaChecksSha256: sha256(canonicalJson(formulaChecks)),
      metadataChecks: webValidation.metadataChecks,
      metadataEvidenceSha256: webValidation.metadataEvidenceSha256,
      multiCnyChecks: webValidation.multiCnyChecks,
      multiCnyEvidenceSha256: webValidation.multiCnyEvidenceSha256,
      sharedDedupChecks: webValidation.sharedDedupChecks,
      sharedDedupEvidence: webValidation.sharedDedupEvidence,
      sharedDedupEvidenceSha256: webValidation.sharedDedupEvidenceSha256,
      validationFailures: [],
      flags: {
        creditCard: formulaChecks.creditCardStrict === true,
        backendSharedLimitSemanticSignal
      },
      webTimeoutExceeded: durationMs > 600_000,
      rateLimit
    }
  } catch (error) {
    const timedOut = error?.name === 'AbortError'
    const errorText = `${error?.message || ''} ${error?.cause?.message || ''}`
    const redirectRejected = /redirect/i.test(errorText)
    const identityHeaderMissing = errorText.includes(SERVICE_IDENTITY_HEADER_MISSING)
    return {
      success: false,
      gateVersion: GATE_VERSION,
      durationMs: Date.now() - started,
      httpStatus: 0,
      code: null,
      errorClass: redirectRejected
        ? 'redirect_rejected'
        : identityHeaderMissing
          ? 'service_identity_mismatch'
          : classifyTransportError({ status: 0, code: null, message: errorText, timedOut }),
      errorMessageSha256: sha256(String(error?.message || error || 'unknown')),
      inputSha256,
      requestNonceHash,
      responseTarget: {
        id: SAFE_TARGET_ID,
        redirected: null,
        urlMatched: false,
        serviceIdentityMatched: null
      },
      ownershipEvidence: emptyOwnershipEvidence(),
      webTimeoutExceeded: timedOut,
      validationFailures: [],
      rateLimit: { limit: null, remaining: null, resetSeconds: null, retryAfterSeconds: null }
    }
  } finally {
    clearTimeout(timer)
  }
}

const manifest = await readJson(manifestPath)
await validateManifest(manifest)
const manifestDigest = manifestProjectionSha256(manifest)
globalLedger = await readRequestLedger()

let state
try {
  state = await readJson(statePath)
  if (
    state.version !== GATE_VERSION
    || state.baseUrl !== LEGACY_BASE_URL
    || state.analyzePath !== ANALYZE_PATH
    || state.targetId !== SAFE_TARGET_ID
    || state.manifestSha256 !== manifestDigest
  ) {
    throw new Error('现有 state 与 manifest 不匹配，拒绝混跑')
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
  state = initialState(manifestDigest)
  await atomicWriteJson(statePath, state)
}

// Request reservation is persisted to state before its append-only ledger entry.
// If power is lost in that narrow interval, analyzeOnce has not been called yet.
// With explicit recovery approval, remove exactly that one undispatched reservation
// only when the remaining snapshot independently passes the full v4 validator.
const manifestLedger = globalLedger.filter((entry) => entry?.manifestSha256 === manifestDigest)
if (state.inFlight && state.requestStarts.length === manifestLedger.length + 1) {
  if (!resumeAfterInflight) {
    throw new Error('发现未写入账本的请求预留；人工确认后使用 --resume-after-inflight 恢复')
  }
  const reservation = state.requestStarts.at(-1)
  const inFlight = state.inFlight
  const file = manifest.files.find((entry) => entry.id === inFlight?.fileId)
  const priorAttempts = state.runs.filter(
    (run) => run.fileId === inFlight?.fileId && run.round === inFlight?.round
  ).length
  const reservationMatches = file
    && reservation?.startedAt === inFlight?.startedAt
    && reservation?.requestNonceHash === inFlight?.requestNonceHash
    && reservation?.targetId === inFlight?.targetId
    && inFlight?.targetId === SAFE_TARGET_ID
    && inFlight?.inputSha256 === file.sha256
    && Number.isInteger(inFlight?.round)
    && inFlight.round >= 1
    && inFlight.round <= file.targetRuns
    && inFlight?.attempt === priorAttempts + 1
  if (!reservationMatches) throw new Error('未写入账本的请求预留无法安全对账')
  const reconciled = {
    ...state,
    status: 'stopped',
    inFlight: null,
    requestStarts: state.requestStarts.slice(0, -1),
    updatedAt: isoNow()
  }
  const reconciliationGate = await validateStateSnapshotV4(manifest, reconciled, globalLedger, {
    expectedProjectionSha: EXPECTED_MANIFEST_PROJECTION_SHA256,
    verifyInputFiles: false
  })
  if (!reconciliationGate.valid) throw new Error('请求预留对账未通过 v4 校验')
  state = reconciled
  await atomicWriteJson(statePath, state)
}

const startupValidation = await validateStateSnapshotV4(manifest, state, globalLedger, {
  expectedProjectionSha: EXPECTED_MANIFEST_PROJECTION_SHA256,
  verifyInputFiles: false
})
if (!startupValidation.valid) {
  throw new Error('现有 state 或全局请求账本未通过 v4 完整校验，拒绝继续')
}

if (BLOCKED_STATUSES.has(state.status) && !resumeAfterReview) {
  throw new Error('历史阻断状态必须人工复核后使用 --resume-after-review 恢复')
}

if (state.inFlight) {
  const ageMs = Date.now() - Date.parse(state.inFlight.startedAt || '')
  const safeAgeMs = Number(state.inFlight.timeoutMs || timeoutMs) + 120_000
  if (!Number.isFinite(ageMs) || ageMs < safeAgeMs) {
    throw new Error('发现未决请求；必须等待服务端超时窗口结束后再恢复')
  }
  if (!resumeAfterInflight) {
    throw new Error('发现历史未决请求；人工确认后使用 --resume-after-inflight 恢复')
  }
  state.runs.push({
    fileId: state.inFlight.fileId,
    round: state.inFlight.round,
    attempt: state.inFlight.attempt,
    startedAt: state.inFlight.startedAt,
    finishedAt: isoNow(),
    success: false,
    gateVersion: GATE_VERSION,
    durationMs: ageMs,
    httpStatus: 0,
    code: null,
    inputSha256: state.inFlight.inputSha256,
    requestNonceHash: state.inFlight.requestNonceHash,
    responseTarget: {
      id: SAFE_TARGET_ID,
      redirected: null,
      urlMatched: false,
      serviceIdentityMatched: null
    },
    ownershipEvidence: emptyOwnershipEvidence(),
    webTimeoutExceeded: false,
    validationFailures: [],
    errorClass: 'uncertain_previous_request',
    errorMessageSha256: sha256('uncertain_previous_request'),
    rateLimit: { limit: null, remaining: null, resetSeconds: null, retryAfterSeconds: null }
  })
  state.inFlight = null
  state.updatedAt = isoNow()
  await atomicWriteJson(statePath, state)
}

if (dryRun) {
  const queue = buildQueue(manifest, state)
  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: 'dry-run',
    targetId: SAFE_TARGET_ID,
    files: manifest.files.length,
    plannedSuccessfulRuns: manifest.files.reduce((sum, file) => sum + file.targetRuns, 0),
    pendingRuns: queue.length,
    maxStartsPerHour,
    minStartIntervalMs
  })}\n`)
  process.exit(0)
}

const token = String(process.env.RPT_LEGACY_TOKEN || '').trim()
delete process.env.RPT_LEGACY_TOKEN
if (!token) throw new Error('缺少 RPT_LEGACY_TOKEN')

let stopRequested = false
let reachedSuccessLimit = false
let newSuccesses = 0
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { stopRequested = true })
}

state.status = 'running'
state.updatedAt = isoNow()
await atomicWriteJson(statePath, state)

while (!stopRequested) {
  const queue = buildQueue(manifest, state)
  if (!queue.length) break
  const { file, round } = queue[0]
  const priorAttempts = attemptsForRun(state, file.id, round)
  if (priorAttempts >= maxOuterAttempts) {
    state.status = 'blocked'
    state.updatedAt = isoNow()
    await atomicWriteJson(statePath, state)
    await atomicWriteJson(summaryPath, buildSummaryV4(manifest, state))
    process.stderr.write(`[blocked] ${file.id} round ${round} exhausted attempts\n`)
    break
  }

  await waitForGlobalRateBudget(state)
  if (stopRequested) break
  let inputBytes
  try {
    inputBytes = await readFile(file.path)
  } catch {
    state.status = 'blocked_input_changed'
    state.updatedAt = isoNow()
    await atomicWriteJson(statePath, state)
    await atomicWriteJson(summaryPath, buildSummaryV4(manifest, state))
    process.stderr.write(`[blocked] ${file.id} input unreadable\n`)
    break
  }
  const inputSha256 = sha256(inputBytes)
  if (inputSha256 !== file.sha256) {
    state.status = 'blocked_input_changed'
    state.updatedAt = isoNow()
    await atomicWriteJson(statePath, state)
    await atomicWriteJson(summaryPath, buildSummaryV4(manifest, state))
    process.stderr.write(`[blocked] ${file.id} input hash changed before request\n`)
    break
  }
  const startedAt = isoNow()
  const requestNonceHash = sha256(randomBytes(32))
  state.requestStarts.push({ startedAt, requestNonceHash, targetId: SAFE_TARGET_ID })
  state.inFlight = {
    fileId: file.id,
    round,
    attempt: priorAttempts + 1,
    startedAt,
    timeoutMs,
    inputSha256,
    requestNonceHash,
    targetId: SAFE_TARGET_ID
  }
  state.updatedAt = isoNow()
  await atomicWriteJson(statePath, state)
  await appendRequestLedger({ startedAt, requestNonceHash, manifestSha256: manifestDigest })

  process.stdout.write(`[start] ${file.id} round ${round} attempt ${priorAttempts + 1}\n`)
  const result = await analyzeOnce(file, token, {
    bytes: inputBytes,
    inputSha256,
    requestNonceHash
  })
  const record = {
    fileId: file.id,
    round,
    attempt: priorAttempts + 1,
    startedAt,
    finishedAt: isoNow(),
    ...result
  }
  state.inFlight = null
  state.runs.push(record)
  state.updatedAt = isoNow()

  if (
    Number.isFinite(result.rateLimit?.remaining)
    && result.rateLimit.remaining <= 2
    && Number.isFinite(result.rateLimit?.resetSeconds)
  ) {
    state.serverBackoffUntil = new Date(Date.now() + (result.rateLimit.resetSeconds + 2) * 1000).toISOString()
  } else if (state.serverBackoffUntil && Date.parse(state.serverBackoffUntil) <= Date.now()) {
    state.serverBackoffUntil = null
  }

  if (!result.success && result.errorClass === 'auth') {
    state.status = 'blocked_auth'
    await atomicWriteJson(statePath, state)
    await atomicWriteJson(summaryPath, buildSummaryV4(manifest, state))
    process.stderr.write('[blocked] authentication expired\n')
    break
  }

  // 旧服务在“模型返回非 JSON 且修复失败”时可能把模型片段写入服务端日志。
  // 一旦出现该错误立即停批，避免重复请求扩大潜在的征信信息日志暴露。
  if (!result.success && result.errorClass === 'model_response') {
    state.status = 'blocked_model_response'
    await atomicWriteJson(statePath, state)
    await atomicWriteJson(summaryPath, buildSummaryV4(manifest, state))
    process.stderr.write('[blocked] model response requires log-safety review\n')
    break
  }

  if (!result.success
    && ['response_target_mismatch', 'redirect_rejected', 'service_identity_mismatch'].includes(result.errorClass)) {
    state.status = 'blocked_response_target'
    await atomicWriteJson(statePath, state)
    await atomicWriteJson(summaryPath, buildSummaryV4(manifest, state))
    process.stderr.write('[blocked] response target requires isolation review\n')
    break
  }


  if (!result.success && result.errorClass === 'validation_failed') {
    state.status = 'blocked_validation'
    await atomicWriteJson(statePath, state)
    await atomicWriteJson(summaryPath, buildSummaryV4(manifest, state))
    process.stderr.write('[blocked] result failed old-Web validation gate\n')
    break
  }

  if (!result.success && !RETRYABLE_ERROR_CLASSES.has(result.errorClass)) {
    state.status = 'blocked_non_retryable'
    await atomicWriteJson(statePath, state)
    await atomicWriteJson(summaryPath, buildSummaryV4(manifest, state))
    process.stderr.write('[blocked] non-retryable analysis failure requires review\n')
    break
  }

  await atomicWriteJson(statePath, state)
  await atomicWriteJson(summaryPath, buildSummaryV4(manifest, state))
  process.stdout.write(
    result.success
      ? `[ok] ${file.id} round ${round} ${result.durationMs}ms\n`
      : `[fail] ${file.id} round ${round} ${result.errorClass}\n`
  )

  if (result.success) {
    newSuccesses += 1
    if (newSuccesses >= stopAfterNewSuccesses) {
      reachedSuccessLimit = true
      break
    }
  }

  if (!result.success) {
    const waitSeconds = result.rateLimit?.retryAfterSeconds
      ?? result.rateLimit?.resetSeconds
      ?? (result.errorClass === 'rate_limit' ? 3_600 : 30)
    await sleepInterruptibly(Math.max(5, waitSeconds) * 1000, () => stopRequested)
  }
}

if (stopRequested) {
  state.status = 'stopped'
} else if (reachedSuccessLimit) {
  state.status = 'paused_after_success_limit'
} else if (buildQueue(manifest, state, { respectOnlyId: false }).length === 0) {
  state.status = 'complete'
  state.finishedAt = isoNow()
} else if (onlyId && buildQueue(manifest, state).length === 0) {
  state.status = 'paused_after_target_complete'
}
state.updatedAt = isoNow()
await atomicWriteJson(statePath, state)
let finalSummary = buildSummaryV4(manifest, state)
await atomicWriteJson(summaryPath, finalSummary)
const finalGate = await evaluateGateV4(manifest, state, finalSummary, {
  expectedProjectionSha: EXPECTED_MANIFEST_PROJECTION_SHA256,
  verifyInputFiles: true,
  ledgerEntries: globalLedger
})
if (finalGate.snapshotValid !== true
  || (state.status === 'complete' && finalGate.strictPass !== true)) {
  process.stderr.write('[blocked] v4 final gate rejected the persisted audit state\n')
  process.exitCode = 2
}
process.stdout.write(`[gate] snapshot=${finalGate.snapshotValid === true} strict=${finalGate.strictPass === true}\n`)
process.stdout.write(`[done] status=${state.status}\n`)
if (state.status !== 'complete') process.exitCode = 2
releaseProcessLockSync()
