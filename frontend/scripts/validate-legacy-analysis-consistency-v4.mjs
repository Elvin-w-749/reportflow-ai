import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { REQUIRED_ANALYZE_CONTRACT } from './legacy-analysis-response-policy.mjs'

const LEGACY_BASE_URL = 'http://127.0.0.1:3200/legacy-api'
const ANALYZE_PATH = '/legacy-api/api/analyze'
const SAFE_TARGET_ID = 'legacy-analyze-v4'
const EXPECTED_SERVICE_LINE = 'legacy-isolated-v20260722'
const GATE_VERSION = 4
const MAX_STARTS_PER_HOUR = 28
const MIN_START_INTERVAL_MS = 15_000
const RATE_WINDOW_MS = 60 * 60 * 1_000
const EXPECTED_IN_FLIGHT_TIMEOUT_MS = 620_000
const EXPECTED_MANIFEST_PROJECTION_SHA256 = '6dd8ef66a56be3d4cebd620547e102a3f2ed556f7d4cf507cd8177b85b7cc8c5'

export const EXPECTED_TAGS_BY_ID = Object.freeze({
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

export const CORE_STRUCTURE_PATHS = [
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

const HASH_RE = /^[0-9a-f]{64}$/
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const SAFE_ERROR_CLASSES = new Set([
  'auth', 'upload_too_large', 'rate_limit', 'server_5xx', 'ocr_incomplete',
  'model_response', 'business_error', 'network_or_unknown', 'timeout',
  'redirect_rejected', 'response_target_mismatch', 'service_identity_mismatch', 'validation_failed',
  'uncertain_previous_request', 'unclassified'
])
const SAFE_METRIC_KEYS = new Set([
  'assessment.score', 'assessment.risk_level',
  'credit_debt.total_debt', 'credit_debt.debt_ratio',
  'credit_debt.credit_loans.total_amount', 'credit_debt.credit_loans.total_count',
  'credit_debt.credit_cards.total_limit', 'credit_debt.credit_cards.total_used',
  'credit_debt.credit_cards.usage_rate', 'credit_debt.credit_cards.card_count',
  'credit_debt.credit_cards.raw_total_limit',
  'credit_debt.credit_cards.utilization_group_count',
  'credit_debt.credit_cards.foreign_currency_account_count',
  'credit_debt.credit_cards.shared_group_count',
  'loan_details.total.balance', 'loan_details.total.credit_limit', 'loan_details.total.count',
  'overdue_info.overdue_count', 'overdue_info.current_overdue_count',
  'overdue_info.overdue_account_count',
  'query_analysis.summary.last_1m.total', 'query_analysis.summary.last_3m.total',
  'query_analysis.summary.last_6m.total', 'query_analysis.summary.last_12m.total',
  'query_analysis.summary.last_24m.total',
  'credit_card_details.count', 'rule_engine_warnings.count',
  'web.cardUsed', 'web.cardLimit', 'web.cardUsagePct', 'web.creditCardUsageRatePct',
  'web.cardUtilizationGroupCount', 'web.cardSharedGroupCount',
  'web.cardInferredSharedGroupCount', 'web.cardForeignCurrencyAccountCount',
  'web.highUsageCount', 'web.cardCount', 'web.loanCount', 'web.accountCount', 'web.mapperOk'
])
const REQUIRED_WEB_METRIC_KEYS = [
  'credit_card_details.count', 'rule_engine_warnings.count',
  'web.cardUsed', 'web.cardLimit', 'web.cardUsagePct', 'web.creditCardUsageRatePct',
  'web.cardUtilizationGroupCount', 'web.cardSharedGroupCount',
  'web.cardInferredSharedGroupCount', 'web.cardForeignCurrencyAccountCount',
  'web.highUsageCount', 'web.cardCount', 'web.loanCount', 'web.accountCount', 'web.mapperOk'
]
const INTEGER_METRIC_KEYS = new Set([
  'credit_debt.credit_loans.total_count', 'credit_debt.credit_cards.card_count',
  'credit_debt.credit_cards.utilization_group_count',
  'credit_debt.credit_cards.foreign_currency_account_count',
  'credit_debt.credit_cards.shared_group_count', 'loan_details.total.count',
  'overdue_info.overdue_count', 'overdue_info.current_overdue_count',
  'overdue_info.overdue_account_count', 'query_analysis.summary.last_1m.total',
  'query_analysis.summary.last_3m.total', 'query_analysis.summary.last_6m.total',
  'query_analysis.summary.last_12m.total', 'query_analysis.summary.last_24m.total',
  'credit_card_details.count', 'rule_engine_warnings.count',
  'web.cardUsagePct', 'web.creditCardUsageRatePct', 'web.cardUtilizationGroupCount',
  'web.cardSharedGroupCount', 'web.cardInferredSharedGroupCount',
  'web.cardForeignCurrencyAccountCount', 'web.highUsageCount', 'web.cardCount',
  'web.loanCount', 'web.accountCount'
])
const METADATA_CHECK_KEYS = [
  'cardMetadataRowsAligned', 'normalizedCardRawPreserved', 'currencyMetadataPreserved',
  'cardTailMetadataPreserved', 'sharedCreditGroupMetadataPreserved',
  'utilizationGroupMetadataPreserved'
]
const MULTI_CNY_CHECK_KEYS = [
  'multiCnySourceCandidateProven', 'multiCnyMappedRowsAligned',
  'multiCnyMappedSeparationProven', 'multiCnyNormalizedMetadataRetained',
  'multiCnyUtilizationGroupsProven', 'multiCnyKeptSeparate'
]
const FLAG_KEYS = ['backendSharedLimitSemanticSignal', 'creditCard']
const OWNERSHIP_EVIDENCE_KEYS = [
  'trustedBasicInfoFound', 'nameCredible', 'idCardPresent',
  'idCardFormatValid', 'idCardChecksumValid', 'ownershipVerified'
]
const SAFE_VALIDATION_FAILURE_KEYS = new Set([
  'web_mapper', 'web_timeout', 'backend_shared_limit_semantic_signal',
  'finiteCore', 'utilizationMatches', 'sharedLimitDoesNotIncrease',
  'groupingCountsSane', 'webFiniteCore', 'webUtilizationMatches',
  'backendWebUsageAgree', 'detailUsageFinite', 'detailUsageMatchesExpected',
  'backendCardCountPositive', 'backendCardDetailsPresent', 'webCardCountPositive',
  'creditCardStrict', 'cardMetadataPreserved',
  ...METADATA_CHECK_KEYS,
  'backendSharedMetricPositive', 'webSharedMetricPositive',
  'backendSharedGroupPresent', 'webSharedGroupPresent', 'sharedGroupsNotForeignOnly',
  'backendSharedGroupHasMultipleMembers', 'backendSharedGroupSingleRepresentative',
  'webSharedGroupHasMultipleMembers', 'webSharedGroupSingleRepresentative',
  'sharedDedupEvidenceConsistent', 'sharedCandidateDetected', 'sharedLimitReduced',
  'multiCnyKeptSeparate', 'scanned_ownership',
  ...MULTI_CNY_CHECK_KEYS
])
const COMMON_RUN_KEYS = [
  'fileId', 'round', 'attempt', 'startedAt', 'finishedAt', 'success', 'durationMs',
  'httpStatus', 'code', 'gateVersion', 'inputSha256', 'requestNonceHash',
  'responseTarget', 'webTimeoutExceeded', 'validationFailures', 'rateLimit',
  'ownershipEvidence'
]
const SUCCESS_RUN_KEYS = new Set([
  ...COMMON_RUN_KEYS, 'responseSha256', 'structureSha256', 'coreStructureSha256',
  'coreStructureFields', 'coreStructureFieldHashes', 'metricsSha256', 'metrics',
  'formulaChecks', 'formulaChecksSha256', 'metadataChecks', 'metadataEvidenceSha256',
  'multiCnyChecks', 'multiCnyEvidenceSha256', 'sharedDedupChecks',
  'sharedDedupEvidence', 'sharedDedupEvidenceSha256', 'flags'
])
const FAILURE_RUN_KEYS = new Set([
  ...COMMON_RUN_KEYS, 'errorClass', 'errorMessageSha256'
])
const STATE_KEYS = [
  'analyzePath', 'baseUrl', 'finishedAt', 'inFlight', 'manifestSha256',
  'requestStarts', 'runs', 'serverBackoffUntil', 'startedAt', 'status',
  'targetId', 'updatedAt', 'version'
]
const REQUEST_START_KEYS = ['requestNonceHash', 'startedAt', 'targetId']
const LEDGER_ENTRY_KEYS = [
  'entrySha256', 'manifestSha256', 'previousEntrySha256', 'requestNonceHash',
  'sequence', 'startedAt', 'targetId', 'version'
]
const IN_FLIGHT_KEYS = [
  'attempt', 'fileId', 'inputSha256', 'requestNonceHash', 'round',
  'startedAt', 'targetId', 'timeoutMs'
]
const SAFE_STATE_STATUSES = new Set([
  'running', 'complete', 'stopped', 'paused_after_success_limit',
  'paused_after_target_complete', 'blocked', 'blocked_input_changed',
  'blocked_auth', 'blocked_model_response', 'blocked_response_target',
  'blocked_non_retryable', 'blocked_validation'
])
const safeErrorClass = (value) => SAFE_ERROR_CLASSES.has(value) ? value : 'unclassified'

export const sha256 = (value) => createHash('sha256').update(value).digest('hex')

export const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  return value
}

export const canonicalJson = (value) => JSON.stringify(canonicalize(value))

export const ledgerEntrySha256 = (entry) => sha256(canonicalJson({
  version: entry?.version,
  sequence: entry?.sequence,
  startedAt: entry?.startedAt,
  requestNonceHash: entry?.requestNonceHash,
  targetId: entry?.targetId,
  manifestSha256: entry?.manifestSha256,
  previousEntrySha256: entry?.previousEntrySha256
}))

export const parseRequestLedger = (text) => {
  const source = String(text || '')
  if (!source.trim()) return []
  return source.split(/\r?\n/).filter((line) => line.length > 0).map((line) => JSON.parse(line))
}

export const projectManifest = (manifest) => (Array.isArray(manifest?.files) ? manifest.files : [])
  .map((file) => ({
    id: String(file?.id || ''),
    sha256: String(file?.sha256 || '').toLowerCase(),
    targetRuns: file?.targetRuns,
    tags: [...(Array.isArray(file?.tags) ? file.tags : [])].map(String).sort()
  }))
  .sort((left, right) => left.id.localeCompare(right.id))

const projectionSha256 = (manifest) => sha256(canonicalJson(projectManifest(manifest)))
const sameCanonical = (left, right) => canonicalJson(left) === canonicalJson(right)
const validIso = (value) => typeof value === 'string' && ISO_RE.test(value) && Number.isFinite(Date.parse(value))
const own = (object, name) => Object.prototype.hasOwnProperty.call(object || {}, name)

const objectValue = (value) => value && typeof value === 'object' && !Array.isArray(value)
  ? value
  : null

const firstOwnedText = (object, aliases) => {
  for (const alias of aliases) {
    if (!own(object, alias)) continue
    const text = String(object[alias] == null ? '' : object[alias]).trim()
    if (text) return text
  }
  return ''
}

const NAME_ALIASES = [
  'name', 'real_name', 'realName', 'customer_name', 'customerName',
  'user_name', 'userName', 'client_name', 'clientName', '姓名'
]
const ID_ALIASES = [
  'idCard', 'id_card', 'idNo', 'id_no', 'idNumber', 'id_number',
  'identityNo', 'identity_no', 'certificateNo', 'certificate_no',
  'certNo', 'cert_no', 'credentialNo', 'credential_no', '身份证号', '证件号码'
]
const TRUSTED_ROOT_KEYS = [
  'report', 'details', 'frontendPayload', 'frontend_payload',
  'creditReportV2', 'credit_report_v2', 'credit_report_full',
  'analysisData', 'analysisResult', 'analysis_result', 'result', 'analysis', 'payload', 'data'
]
const TRUSTED_BASIC_KEYS = ['basicInfo', 'basic_info', 'personalInfo', 'personal_info']

const trustedBasicInfoContainers = (data) => {
  const core = objectValue(data)
  if (!core) return []
  const roots = [core]
  for (const key of TRUSTED_ROOT_KEYS) {
    const candidate = objectValue(core[key])
    if (candidate) roots.push(candidate)
  }
  const containers = []
  const seen = new Set()
  const add = (value) => {
    const candidate = objectValue(value)
    if (!candidate || seen.has(candidate)) return
    seen.add(candidate)
    containers.push(candidate)
  }
  for (const root of roots) {
    for (const key of TRUSTED_BASIC_KEYS) add(root[key])
    add(objectValue(root.frontend_payload)?.header)
    add(objectValue(root.frontendPayload)?.header)
  }
  return containers
}

const normalizedIdentity = (value) => String(value == null ? '' : value)
  .replace(/\s+/g, '')
  .toUpperCase()

const credibleName = (value) => {
  const text = String(value == null ? '' : value).trim()
  return /^[\u3400-\u9fff][\u3400-\u9fff·•]{1,29}$/.test(text)
    && !/^(未知|姓名|本人|客户|测试)$/.test(text)
}

export const isValidPrccdId = (value) => {
  const identity = normalizedIdentity(value)
  if (!/^\d{17}[0-9X]$/.test(identity)) return false
  const birth = identity.slice(6, 14)
  const year = Number(birth.slice(0, 4))
  const month = Number(birth.slice(4, 6))
  const day = Number(birth.slice(6, 8))
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return false
  }
  if (identity.slice(0, 6) === '000000' || identity.slice(14, 17) === '000') return false
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
  const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2']
  const total = [...identity.slice(0, 17)]
    .reduce((sum, digit, index) => sum + Number(digit) * weights[index], 0)
  return identity.at(-1) === checks[total % 11]
}

export const extractOwnershipEvidence = (data) => {
  const serviceEvidence = objectValue(data)?._ownership_evidence
  const exactServiceEvidence = serviceEvidence
    && typeof serviceEvidence === 'object'
    && !Array.isArray(serviceEvidence)
    && sameCanonical(Object.keys(serviceEvidence).sort(), [
      'identityChecksumValid', 'identityRecognized', 'nameRecognized',
      'source', 'verified', 'version'
    ])
    && serviceEvidence.version === 1
    && serviceEvidence.source === 'scanned-pdf-first-page'
    && serviceEvidence.nameRecognized === true
    && serviceEvidence.identityRecognized === true
    && serviceEvidence.identityChecksumValid === true
    && serviceEvidence.verified === true
  if (exactServiceEvidence) {
    return {
      trustedBasicInfoFound: true,
      nameCredible: true,
      idCardPresent: true,
      idCardFormatValid: true,
      idCardChecksumValid: true,
      ownershipVerified: true
    }
  }
  const containers = trustedBasicInfoContainers(data)
  let nameCredible = false
  let idCardPresent = false
  let idCardFormatValid = false
  let idCardChecksumValid = false
  let ownershipVerified = false
  for (const container of containers) {
    const name = firstOwnedText(container, NAME_ALIASES)
    const identity = normalizedIdentity(firstOwnedText(container, ID_ALIASES))
    const currentNameCredible = credibleName(name)
    const currentFormatValid = /^\d{17}[0-9X]$/.test(identity)
    const currentChecksumValid = currentFormatValid && isValidPrccdId(identity)
    nameCredible ||= currentNameCredible
    idCardPresent ||= identity.length > 0
    idCardFormatValid ||= currentFormatValid
    idCardChecksumValid ||= currentChecksumValid
    ownershipVerified ||= currentNameCredible && currentChecksumValid
  }
  return {
    trustedBasicInfoFound: containers.length > 0,
    nameCredible,
    idCardPresent,
    idCardFormatValid,
    idCardChecksumValid,
    ownershipVerified
  }
}

const numberMetric = (metrics, name) => Number(metrics?.[name])

const exactBooleanRecord = (value, keys) => value
  && typeof value === 'object'
  && !Array.isArray(value)
  && sameCanonical(Object.keys(value).sort(), [...keys].sort())
  && keys.every((key) => typeof value[key] === 'boolean')

const exactResponseTarget = (target, { allowNullRedirected = false } = {}) => target
  && typeof target === 'object'
  && !Array.isArray(target)
  && sameCanonical(
    Object.keys(target).sort(),
    ['id', 'redirected', 'serviceIdentityMatched', 'urlMatched']
  )
  && target.id === SAFE_TARGET_ID
  && (allowNullRedirected
    ? target.redirected === null || typeof target.redirected === 'boolean'
    : typeof target.redirected === 'boolean')
  && typeof target.urlMatched === 'boolean'
  && (allowNullRedirected
    ? target.serviceIdentityMatched === null || typeof target.serviceIdentityMatched === 'boolean'
    : typeof target.serviceIdentityMatched === 'boolean')

const exactRateLimit = (rateLimit) => rateLimit
  && typeof rateLimit === 'object'
  && !Array.isArray(rateLimit)
  && sameCanonical(
    Object.keys(rateLimit).sort(),
    ['limit', 'remaining', 'resetSeconds', 'retryAfterSeconds']
  )
  && Object.values(rateLimit).every(safeNullableRateValue)

const metricsSchemaOk = (metrics) => {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return false
  const keys = Object.keys(metrics)
  if (keys.some((key) => !SAFE_METRIC_KEYS.has(key))) return false
  if (REQUIRED_WEB_METRIC_KEYS.some((key) => !own(metrics, key))) return false
  for (const [key, value] of Object.entries(metrics)) {
    if (key === 'assessment.risk_level') {
      if (!['low', 'medium', 'high'].includes(value)) return false
      continue
    }
    if (key === 'web.mapperOk') {
      if (value !== true) return false
      continue
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) return false
    if (INTEGER_METRIC_KEYS.has(key) && (!Number.isInteger(value) || value < 0)) return false
  }
  return true
}

export const recomputeSharedDedupChecks = (evidence) => {
  const inspectSide = (side) => {
    const groups = Array.isArray(side?.groups) ? side.groups : []
    const groupSchemaOk = groups.every((group) => {
      const members = Array.isArray(group?.members) ? group.members : []
      return group && typeof group === 'object' && !Array.isArray(group)
        && sameCanonical(
          Object.keys(group).sort(),
          ['basis', 'includedMemberCount', 'memberCount', 'members']
        )
        && ['explicit', 'inferred'].includes(group?.basis)
        && Number.isInteger(group?.memberCount)
        && group.memberCount > 1
        && group.memberCount === members.length
        && Number.isInteger(group?.includedMemberCount)
        && group.includedMemberCount === members.filter((member) => member?.included === true).length
        && members.every((member) => member
          && typeof member === 'object'
          && !Array.isArray(member)
          && sameCanonical(Object.keys(member), ['included'])
          && typeof member.included === 'boolean')
    })
    const calculated = {
      qualifyingGroupCount: groups.length,
      explicitGroupCount: groups.filter((group) => group.basis === 'explicit').length,
      inferredGroupCount: groups.filter((group) => group.basis === 'inferred').length,
      allGroupsHaveMultipleMembers: groups.length > 0 && groups.every((group) => group.memberCount > 1),
      allGroupsUseSingleRepresentative: groups.length > 0
        && groups.every((group) => group.includedMemberCount === 1),
      groups
    }
    return { schemaOk: groupSchemaOk && sameCanonical(side, calculated), calculated }
  }
  const backend = inspectSide(evidence?.backend)
  const web = inspectSide(evidence?.web)
  const checks = {
    backendSharedGroupPresent: backend.calculated.qualifyingGroupCount > 0,
    webSharedGroupPresent: web.calculated.qualifyingGroupCount > 0,
    sharedGroupsNotForeignOnly: backend.calculated.qualifyingGroupCount > 0
      && web.calculated.qualifyingGroupCount > 0,
    backendSharedGroupHasMultipleMembers: backend.calculated.allGroupsHaveMultipleMembers === true,
    backendSharedGroupSingleRepresentative: backend.calculated.allGroupsUseSingleRepresentative === true,
    webSharedGroupHasMultipleMembers: web.calculated.allGroupsHaveMultipleMembers === true,
    webSharedGroupSingleRepresentative: web.calculated.allGroupsUseSingleRepresentative === true
  }
  checks.sharedDedupEvidenceConsistent = Object.values(checks).every((value) => value === true)
  return { checks, schemaOk: backend.schemaOk && web.schemaOk }
}

export const recomputeFormulaChecks = (metrics, tags, metadataChecks, multiCnyChecks, sharedChecks) => {
  const tagSet = new Set(tags)
  const creditFocus = tagSet.has('credit-utilization')
  const sharedFocus = tagSet.has('shared-limit-candidate')
  const multiCnyFocus = tagSet.has('same-day-multi-cny')
  const totalLimit = numberMetric(metrics, 'credit_debt.credit_cards.total_limit')
  const totalUsed = numberMetric(metrics, 'credit_debt.credit_cards.total_used')
  const usageRate = numberMetric(metrics, 'credit_debt.credit_cards.usage_rate')
  const rawTotalLimit = numberMetric(metrics, 'credit_debt.credit_cards.raw_total_limit')
  const cardCount = numberMetric(metrics, 'credit_debt.credit_cards.card_count')
  const detailCount = numberMetric(metrics, 'credit_card_details.count')
  const groupCount = numberMetric(metrics, 'credit_debt.credit_cards.utilization_group_count')
  const sharedGroupCount = numberMetric(metrics, 'credit_debt.credit_cards.shared_group_count')
  const webUsed = numberMetric(metrics, 'web.cardUsed')
  const webLimit = numberMetric(metrics, 'web.cardLimit')
  const webUsagePct = numberMetric(metrics, 'web.cardUsagePct')
  const detailUsagePct = numberMetric(metrics, 'web.creditCardUsageRatePct')
  const webGroupCount = numberMetric(metrics, 'web.cardUtilizationGroupCount')
  const webSharedGroupCount = numberMetric(metrics, 'web.cardSharedGroupCount')
  const webInferredSharedGroupCount = numberMetric(metrics, 'web.cardInferredSharedGroupCount')
  const webCardCount = numberMetric(metrics, 'web.cardCount')
  const backendCardCountPositive = creditFocus ? Number.isFinite(cardCount) && cardCount > 0 : null
  const backendCardDetailsPresent = creditFocus ? Number.isFinite(detailCount) && detailCount > 0 : null
  const webCardCountPositive = creditFocus ? Number.isFinite(webCardCount) && webCardCount > 0 : null
  const creditCardStrict = creditFocus
    ? backendCardCountPositive && backendCardDetailsPresent && webCardCountPositive
    : null
  const finiteCore = creditFocus
    ? [totalLimit, totalUsed, usageRate].every(Number.isFinite)
    : [totalLimit, totalUsed, usageRate].filter((value) => !Number.isNaN(value)).every(Number.isFinite)
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
    ? groupCount >= 0 && groupCount <= Math.max(cardCount, Number.isFinite(detailCount) ? detailCount : 0)
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
  const cardMetadataPreserved = creditFocus || sharedFocus || multiCnyFocus
    ? [
        'cardMetadataRowsAligned',
        'normalizedCardRawPreserved',
        'currencyMetadataPreserved',
        'cardTailMetadataPreserved',
        'sharedCreditGroupMetadataPreserved',
        'utilizationGroupMetadataPreserved'
      ].every((name) => metadataChecks?.[name] === true)
    : null
  const backendSharedMetricPositive = sharedFocus
    ? Number.isFinite(sharedGroupCount) && sharedGroupCount > 0
    : null
  const webSharedMetricPositive = sharedFocus
    ? [webSharedGroupCount, webInferredSharedGroupCount].some((value) => Number.isFinite(value) && value > 0)
    : null
  const backendSharedGroupPresent = sharedFocus
    ? backendSharedMetricPositive && sharedChecks?.backendSharedGroupPresent === true
    : null
  const webSharedGroupPresent = sharedFocus
    ? webSharedMetricPositive && sharedChecks?.webSharedGroupPresent === true
    : null
  const sharedCandidateDetected = sharedFocus
    ? backendSharedGroupPresent && webSharedGroupPresent
    : null
  const sharedLimitReduced = sharedFocus
    ? Number.isFinite(rawTotalLimit) && Number.isFinite(totalLimit) && rawTotalLimit > totalLimit
    : null
  const multiCnyKeptSeparate = multiCnyFocus ? multiCnyChecks?.multiCnyKeptSeparate === true : null
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
    ...(metadataChecks || {}),
    backendSharedMetricPositive,
    webSharedMetricPositive,
    ...(sharedFocus ? (sharedChecks || {}) : {}),
    sharedCandidateDetected,
    sharedLimitReduced,
    multiCnyKeptSeparate,
    ...(multiCnyFocus ? (multiCnyChecks || {}) : {})
  }
}

const requiredChecksForTags = (tags) => {
  const tagSet = new Set(tags)
  const required = []
  if (tagSet.has('credit-utilization')) {
    required.push(
      'finiteCore', 'utilizationMatches', 'groupingCountsSane', 'webFiniteCore',
      'webUtilizationMatches', 'backendWebUsageAgree', 'detailUsageFinite',
      'detailUsageMatchesExpected', 'backendCardCountPositive', 'backendCardDetailsPresent',
      'webCardCountPositive', 'creditCardStrict', 'cardMetadataPreserved'
    )
  }
  if (tagSet.has('shared-limit-candidate')) {
    required.push(
      'sharedLimitDoesNotIncrease', 'sharedCandidateDetected', 'sharedLimitReduced',
      'cardMetadataPreserved', 'backendSharedMetricPositive', 'webSharedMetricPositive',
      'backendSharedGroupPresent', 'webSharedGroupPresent', 'sharedGroupsNotForeignOnly',
      'backendSharedGroupHasMultipleMembers', 'backendSharedGroupSingleRepresentative',
      'webSharedGroupHasMultipleMembers', 'webSharedGroupSingleRepresentative',
      'sharedDedupEvidenceConsistent'
    )
  }
  if (tagSet.has('same-day-multi-cny')) {
    required.push(
      'cardMetadataPreserved', 'multiCnySourceCandidateProven', 'multiCnyMappedRowsAligned',
      'multiCnyMappedSeparationProven', 'multiCnyNormalizedMetadataRetained',
      'multiCnyUtilizationGroupsProven', 'multiCnyKeptSeparate'
    )
  }
  return [...new Set(required)]
}

const validateManifestShape = (manifest, expectedProjectionSha) => {
  const violations = []
  const files = Array.isArray(manifest?.files) ? manifest.files : []
  if (manifest?.version !== 1) violations.push('version')
  if (files.length !== 31) violations.push('file_count')
  const ids = files.map((file) => String(file?.id || ''))
  if (new Set(ids).size !== ids.length) violations.push('duplicate_id')
  if (!sameCanonical([...ids].sort(), Object.keys(EXPECTED_TAGS_BY_ID).sort())) violations.push('id_set')
  for (const file of files) {
    const id = String(file?.id || '')
    const tags = Array.isArray(file?.tags) ? file.tags.map(String) : []
    const expectedTags = EXPECTED_TAGS_BY_ID[id]
    if (!expectedTags || new Set(tags).size !== tags.length || !sameCanonical([...tags].sort(), expectedTags)) {
      violations.push('classification_projection')
    }
    const expectedTarget = EXPECTED_FOCUS_IDS.has(id) ? 5 : 3
    if (file?.targetRuns !== expectedTarget) violations.push('target_projection')
    if (!HASH_RE.test(String(file?.sha256 || ''))) violations.push('content_hash')
    if (EXPECTED_SCANNED_IDS.has(id) !== tags.includes('scanned-pdf')) {
      violations.push('scanned_projection')
    }
    if (EXPECTED_SHARED_IDS.has(id) !== tags.includes('shared-limit-candidate')) {
      violations.push('shared_projection')
    }
    if (EXPECTED_MULTI_CNY_IDS.has(id) !== tags.includes('same-day-multi-cny')) {
      violations.push('multi_cny_projection')
    }
  }
  const duplicateGroups = [...new Set(files.map((file) => file?.sha256))]
    .map((digest) => files.filter((file) => file?.sha256 === digest).map((file) => file.id).sort())
    .filter((group) => group.length > 1)
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
  if (!sameCanonical(duplicateGroups, EXPECTED_DUPLICATE_GROUPS)) violations.push('duplicate_projection')
  if (files.reduce((sum, file) => sum + Number(file?.targetRuns || 0), 0) !== 137) {
    violations.push('planned_runs')
  }
  if (projectionSha256(manifest) !== expectedProjectionSha) violations.push('trusted_projection_hash')
  return { violations: [...new Set(violations)], files, projectionSha: projectionSha256(manifest) }
}

const structureRecordOk = (run) => {
  const fields = run?.coreStructureFields
  const hashes = run?.coreStructureFieldHashes
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return false
  if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes)) return false
  if (!sameCanonical(Object.keys(fields).sort(), [...CORE_STRUCTURE_PATHS].sort())) return false
  if (!sameCanonical(Object.keys(hashes).sort(), [...CORE_STRUCTURE_PATHS].sort())) return false
  for (const path of CORE_STRUCTURE_PATHS) {
    const descriptor = fields[path]
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) return false
    if (typeof descriptor.type !== 'string') return false
    const expectedKeys = descriptor.type === 'array' ? ['length', 'type'] : ['type']
    if (!sameCanonical(Object.keys(descriptor).sort(), expectedKeys)) return false
    if (descriptor.type === 'array' && (!Number.isInteger(descriptor.length) || descriptor.length < 0)) return false
    if (hashes[path] !== sha256(canonicalJson(descriptor))) return false
  }
  const aggregate = sha256(canonicalJson(fields))
  return run.coreStructureSha256 === aggregate
    && run.structureSha256 === aggregate
    && HASH_RE.test(aggregate)
}

const analysisContractStructureOk = (run) => REQUIRED_ANALYZE_CONTRACT.every(
  ([path, expectedType]) => run?.coreStructureFields?.[path]?.type === expectedType
)

const safeFormulaTypes = (formulaChecks) => formulaChecks
  && typeof formulaChecks === 'object'
  && !Array.isArray(formulaChecks)
  && Object.values(formulaChecks).every((value) => value === null || typeof value === 'boolean')

const strictSuccessTransportOk = (run) => run?.success === true
  && run.httpStatus === 200
  && run.code === 0
  && Array.isArray(run.validationFailures)
  && run.validationFailures.length === 0
  && run.webTimeoutExceeded === false
  && !own(run, 'errorClass')
  && run.gateVersion === GATE_VERSION
  && exactResponseTarget(run.responseTarget)
  && run.responseTarget.redirected === false
  && run.responseTarget.urlMatched === true
  && run.responseTarget.serviceIdentityMatched === true
  && exactRateLimit(run.rateLimit)

const safeNullableRateValue = (value) => value === null
  || (typeof value === 'number' && Number.isFinite(value) && value >= 0)

const failureRecordOk = (run) => {
  const target = run?.responseTarget
  const rateLimit = run?.rateLimit
  return run?.success === false
    && run.gateVersion === GATE_VERSION
    && Number.isInteger(run.httpStatus)
    && run.httpStatus >= 0
    && run.httpStatus <= 599
    && (run.code === null || (typeof run.code === 'number' && Number.isFinite(run.code)))
    && SAFE_ERROR_CLASSES.has(run.errorClass)
    && HASH_RE.test(String(run.errorMessageSha256 || ''))
    && exactResponseTarget(target, { allowNullRedirected: true })
    && typeof run.webTimeoutExceeded === 'boolean'
    && Array.isArray(run.validationFailures)
    && run.validationFailures.length <= SAFE_VALIDATION_FAILURE_KEYS.size
    && new Set(run.validationFailures).size === run.validationFailures.length
    && run.validationFailures.every((value) => SAFE_VALIDATION_FAILURE_KEYS.has(value))
    && exactRateLimit(rateLimit)
}

const runFormulaOk = (run, file) => {
  const shared = recomputeSharedDedupChecks(run?.sharedDedupEvidence)
  const expected = recomputeFormulaChecks(
    run?.metrics,
    file?.tags || [],
    run?.metadataChecks,
    run?.multiCnyChecks,
    shared.checks
  )
  const required = requiredChecksForTags(file?.tags || [])
  return {
    shared,
    expected,
    recomputed: sameCanonical(run?.formulaChecks, expected),
    requiredPassed: required.every((name) => run?.formulaChecks?.[name] === true),
    allTypesSafe: safeFormulaTypes(run?.formulaChecks),
    allChecksPassed: Object.values(run?.formulaChecks || {}).every((value) => value !== false),
    hashOk: run?.formulaChecksSha256 === sha256(canonicalJson(run?.formulaChecks || {}))
  }
}

const fileSummary = (file, runs) => {
  const successes = runs.filter((run) => run.fileId === file.id && run.success === true)
  const failures = runs.filter((run) => run.fileId === file.id && run.success !== true)
  const metricHashes = new Set(successes.map((run) => run.metricsSha256))
  const structureHashes = new Set(successes.map((run) => run.coreStructureSha256))
  const responseHashes = new Set(successes.map((run) => run.responseSha256))
  const formulaHashes = new Set(successes.map((run) => run.formulaChecksSha256))
  const distinctRounds = new Set(successes.map((run) => run.round))
  const durations = successes.map((run) => run.durationMs).filter(Number.isFinite)
  const failedFormulaChecks = successes
    .flatMap((run) => Object.entries(run.formulaChecks || {}))
    .filter(([, value]) => value === false)
  const errorClasses = Object.fromEntries(
    [...new Set(failures.map((run) => run.errorClass))]
      .sort()
      .map((name) => [name, failures.filter((run) => run.errorClass === name).length])
  )
  return {
    id: file.id,
    tags: [...file.tags].sort(),
    targetRuns: file.targetRuns,
    successfulRuns: successes.length,
    failedAttempts: failures.length,
    complete: successes.length === file.targetRuns && distinctRounds.size === file.targetRuns,
    metricsStable: successes.length > 0 && metricHashes.size === 1,
    structureStable: successes.length > 0 && structureHashes.size === 1,
    formulaStable: successes.length > 0 && formulaHashes.size === 1,
    fullResponseStable: successes.length > 0 && responseHashes.size === 1,
    formulaChecksPassed: successes.length > 0 && failedFormulaChecks.length === 0,
    failedFormulaChecks: [...new Set(failedFormulaChecks.map(([name]) => name))].sort(),
    backendSharedLimitSemanticSignal: successes.some(
      (run) => run.flags?.backendSharedLimitSemanticSignal === true
    ),
    ownershipVerifiedRuns: successes.filter(
      (run) => run.ownershipEvidence?.ownershipVerified === true
    ).length,
    ownershipVerified: successes.length > 0
      && successes.every((run) => run.ownershipEvidence?.ownershipVerified === true),
    durationMs: durations.length
      ? {
          min: Math.min(...durations),
          max: Math.max(...durations),
          average: Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
        }
      : null,
    errorClasses
  }
}

export const buildSummaryV4 = (manifest, state) => {
  const files = [...manifest.files]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((file) => fileSummary(file, state.runs || []))
  const successes = (state.runs || []).filter((run) => run.success === true)
  const failures = (state.runs || []).filter((run) => run.success !== true)
  const duplicateContentGroups = EXPECTED_DUPLICATE_GROUPS.map((members) => {
    const memberRuns = members.flatMap((id) => successes.filter((run) => run.fileId === id))
    const complete = members.every((id) => files.find((file) => file.id === id)?.complete === true)
    return {
      members,
      complete,
      semanticConsistent: complete
        && new Set(memberRuns.map((run) => run.metricsSha256)).size === 1
        && new Set(memberRuns.map((run) => run.coreStructureSha256)).size === 1
        && new Set(memberRuns.map((run) => run.formulaChecksSha256)).size === 1
        && new Set(memberRuns.map((run) => run.metadataEvidenceSha256)).size === 1
        && new Set(memberRuns.map((run) => run.multiCnyEvidenceSha256)).size === 1
        && new Set(memberRuns.map((run) => run.sharedDedupEvidenceSha256)).size === 1
    }
  })
  const completeFiles = files.filter((file) => file.complete).length
  const metricsStableFiles = files.filter((file) => file.complete && file.metricsStable).length
  const structureStableFiles = files.filter((file) => file.complete && file.structureStable).length
  const formulaStableFiles = files.filter((file) => file.complete && file.formulaStable).length
  const formulaPassedFiles = files.filter((file) => file.complete && file.formulaChecksPassed).length
  const scannedSuccesses = successes.filter((run) => EXPECTED_SCANNED_IDS.has(run.fileId))
  const scannedOwnershipVerifiedRuns = scannedSuccesses.filter(
    (run) => run.ownershipEvidence?.ownershipVerified === true
  ).length
  const scannedFilesOwnershipVerified = files.filter(
    (file) => EXPECTED_SCANNED_IDS.has(file.id)
      && file.complete
      && file.ownershipVerifiedRuns === file.targetRuns
  ).length
  const provisionalBatchComplete = state.status === 'complete'
    && state.inFlight === null
    && successes.length === 137
    && completeFiles === 31
    && metricsStableFiles === 31
    && structureStableFiles === 31
    && formulaStableFiles === 31
    && formulaPassedFiles === 31
    && scannedOwnershipVerifiedRuns === 5
    && scannedFilesOwnershipVerified === 1
    && duplicateContentGroups.every((group) => group.semanticConsistent)
  return {
    version: GATE_VERSION,
    generatedAt: new Date().toISOString(),
    targetId: SAFE_TARGET_ID,
    scope: {
      baseUrl: LEGACY_BASE_URL,
      endpoint: ANALYZE_PATH,
      serviceLine: EXPECTED_SERVICE_LINE,
      fileCount: manifest.files.length,
      focusFiles: EXPECTED_FOCUS_IDS.size,
      ordinaryFiles: manifest.files.length - EXPECTED_FOCUS_IDS.size,
      sharedCandidateFiles: EXPECTED_SHARED_IDS.size,
      multiCnyFiles: EXPECTED_MULTI_CNY_IDS.size,
      scannedFiles: EXPECTED_SCANNED_IDS.size,
      plannedSuccessfulRuns: manifest.files.reduce((sum, file) => sum + file.targetRuns, 0),
      manifestSha256: state.manifestSha256
    },
    progress: {
      successfulRuns: successes.length,
      failedAttempts: failures.length,
      completeFiles,
      totalFiles: files.length,
      status: state.status
    },
    consistency: {
      metricsStableFiles,
      structureStableFiles,
      fullResponseStableFiles: files.filter((file) => file.complete && file.fullResponseStable).length,
      formulaStableFiles,
      formulaPassedFiles,
      duplicateContentGroupsConsistent: duplicateContentGroups.filter((group) => group.semanticConsistent).length
    },
    ownership: {
      scannedSuccessfulRuns: scannedSuccesses.length,
      scannedOwnershipVerifiedRuns,
      scannedFilesOwnershipVerified
    },
    duplicateContentGroups,
    provisionalBatchComplete,
    limitations: {
      scannedCorpusCovered: scannedFilesOwnershipVerified === EXPECTED_SCANNED_IDS.size,
      nineGroupSemanticAndVisiblePromptCovered: false,
      fullUiFlowCoveredByThisBatch: false,
      completeAcceptance: false
    },
    files
  }
}

const percentile = (values, fraction) => {
  if (!values.length) return null
  const index = Math.max(0, Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1))
  return values[index]
}

export async function evaluateGateV4(manifest, state, summary, options = {}) {
  const expectedProjectionSha = options.expectedProjectionSha || EXPECTED_MANIFEST_PROJECTION_SHA256
  const verifyInputFiles = options.verifyInputFiles === true
  const ledgerEntries = options.ledgerEntries
  const manifestCheck = validateManifestShape(manifest, expectedProjectionSha)
  let inputFileViolations = 0
  if (verifyInputFiles) {
    for (const file of manifestCheck.files) {
      try {
        const bytes = await readFile(file.path)
        if (sha256(bytes) !== file.sha256) inputFileViolations += 1
      } catch {
        inputFileViolations += 1
      }
    }
  }

  const files = manifestCheck.files
  const fileById = new Map(files.map((file) => [String(file.id), file]))
  const runs = Array.isArray(state?.runs) ? state.runs : []
  const successes = runs.filter((run) => run?.success === true)
  const failures = runs.filter((run) => run?.success !== true)
  const checkCounts = {
    manifestViolations: manifestCheck.violations.length,
    inputFileViolations,
    stateEnvelopeViolations: 0,
    runSchemaViolations: 0,
    successBooleanViolations: 0,
    runIdentityViolations: 0,
    attemptSequenceViolations: 0,
    successTransportViolations: 0,
    failureSchemaViolations: 0,
    responseTargetViolations: 0,
    inputShaViolations: 0,
    requestNonceViolations: 0,
    responseHashViolations: 0,
    metricsSchemaViolations: 0,
    metricsHashViolations: 0,
    coreStructureViolations: 0,
    analysisContractViolations: 0,
    formulaTypeViolations: 0,
    formulaHashViolations: 0,
    formulaRecomputeViolations: 0,
    requiredFormulaViolations: 0,
    metadataEvidenceViolations: 0,
    multiCnyEvidenceViolations: 0,
    evidenceSchemaViolations: 0,
    sharedDedupEvidenceViolations: 0,
    creditCardEvidenceViolations: 0,
    backendSharedSemanticSignalViolations: 0,
    durationViolations: 0,
    timingConsistencyViolations: 0,
    requestStartViolations: 0,
    rateLimitViolations: 0,
    ledgerSchemaViolations: 0,
    ledgerBindingViolations: 0,
    serviceIdentityViolations: 0,
    ownershipEvidenceViolations: 0,
    scannedOwnershipViolations: 0,
    duplicateContentGroupViolations: 0,
    summaryEnvelopeViolations: 0,
    summaryFilesViolations: 0
  }

  if (
    !state || typeof state !== 'object' || Array.isArray(state)
    || !sameCanonical(Object.keys(state).sort(), STATE_KEYS)
    || state?.version !== GATE_VERSION
    || state?.baseUrl !== LEGACY_BASE_URL
    || state?.analyzePath !== ANALYZE_PATH
    || state?.targetId !== SAFE_TARGET_ID
    || state?.manifestSha256 !== manifestCheck.projectionSha
    || state?.manifestSha256 !== expectedProjectionSha
    || !Array.isArray(state?.requestStarts)
    || !Array.isArray(state?.runs)
    || !validIso(state?.startedAt)
    || !validIso(state?.updatedAt)
    || !(state?.finishedAt === null || validIso(state?.finishedAt))
    || !(state?.serverBackoffUntil === null || validIso(state?.serverBackoffUntil))
    || !SAFE_STATE_STATUSES.has(state?.status)
    || (state?.status === 'complete' && !validIso(state?.finishedAt))
  ) checkCounts.stateEnvelopeViolations += 1

  if (state?.inFlight !== null) {
    const inFlight = state?.inFlight
    const inFlightFile = fileById.get(String(inFlight?.fileId))
    const priorAttempts = runs.filter(
      (run) => run?.fileId === inFlight?.fileId && run?.round === inFlight?.round
    ).length
    if (!inFlight || typeof inFlight !== 'object' || Array.isArray(inFlight)
      || !sameCanonical(Object.keys(inFlight).sort(), IN_FLIGHT_KEYS)
      || !inFlightFile
      || !Number.isInteger(inFlight.round) || inFlight.round < 1
      || inFlight.round > Number(inFlightFile?.targetRuns || 0)
      || !Number.isInteger(inFlight.attempt) || inFlight.attempt < 1 || inFlight.attempt > 3
      || inFlight.attempt !== priorAttempts + 1
      || !validIso(inFlight.startedAt)
      || inFlight.timeoutMs !== EXPECTED_IN_FLIGHT_TIMEOUT_MS
      || !HASH_RE.test(String(inFlight.inputSha256 || ''))
      || inFlight.inputSha256 !== inFlightFile?.sha256
      || !HASH_RE.test(String(inFlight.requestNonceHash || ''))
      || inFlight.targetId !== SAFE_TARGET_ID) {
      checkCounts.stateEnvelopeViolations += 1
    }
  }

  const successKeys = []
  const validFormulaRun = new Map()
  for (const run of runs) {
    const expectedRunKeys = run?.success === true
      ? SUCCESS_RUN_KEYS
      : (run?.success === false ? FAILURE_RUN_KEYS : null)
    if (!run || typeof run !== 'object' || Array.isArray(run)
      || !expectedRunKeys
      || !sameCanonical(Object.keys(run).sort(), [...expectedRunKeys].sort())) {
      checkCounts.runSchemaViolations += 1
    }
    if (typeof run?.success !== 'boolean') checkCounts.successBooleanViolations += 1
    const file = fileById.get(String(run?.fileId))
    const identityOk = file
      && Number.isInteger(run?.round)
      && run.round >= 1
      && run.round <= file.targetRuns
      && Number.isInteger(run?.attempt)
      && run.attempt >= 1
      && run.attempt <= 3
      && validIso(run?.startedAt)
      && validIso(run?.finishedAt)
      && Date.parse(run.finishedAt) >= Date.parse(run.startedAt)
    if (!identityOk) checkCounts.runIdentityViolations += 1
    if (run?.success === true && file) successKeys.push(`${file.id}|${run.round}`)
    if (!file || run?.inputSha256 !== file.sha256 || !HASH_RE.test(String(run?.inputSha256 || ''))) {
      checkCounts.inputShaViolations += 1
    }
    if (!HASH_RE.test(String(run?.requestNonceHash || ''))) checkCounts.requestNonceViolations += 1
    if (run?.success === true && !HASH_RE.test(String(run?.responseSha256 || ''))) {
      checkCounts.responseHashViolations += 1
    }
    if (run?.responseTarget?.id !== SAFE_TARGET_ID) checkCounts.responseTargetViolations += 1
    if (!Number.isFinite(run?.durationMs) || run.durationMs < 0
      || (run?.success === true && run.durationMs > 600_000)) {
      checkCounts.durationViolations += 1
    }
    if (validIso(run?.startedAt) && validIso(run?.finishedAt)
      && Number.isFinite(run?.durationMs)) {
      const elapsedMs = Date.parse(run.finishedAt) - Date.parse(run.startedAt)
      if (Math.abs(elapsedMs - run.durationMs) > 5_000) {
        checkCounts.timingConsistencyViolations += 1
      }
    }
    if (own(run, 'metrics') && !metricsSchemaOk(run.metrics)) {
      checkCounts.metricsSchemaViolations += 1
    }
    if (own(run, 'metadataChecks') && !exactBooleanRecord(run.metadataChecks, METADATA_CHECK_KEYS)) {
      checkCounts.evidenceSchemaViolations += 1
    }
    if (own(run, 'multiCnyChecks') && !exactBooleanRecord(run.multiCnyChecks, MULTI_CNY_CHECK_KEYS)) {
      checkCounts.evidenceSchemaViolations += 1
    }
    if (own(run, 'flags') && !exactBooleanRecord(run.flags, FLAG_KEYS)) {
      checkCounts.evidenceSchemaViolations += 1
    }
    if (!exactBooleanRecord(run?.ownershipEvidence, OWNERSHIP_EVIDENCE_KEYS)) {
      checkCounts.ownershipEvidenceViolations += 1
    }
    if (run?.success !== true) {
      if (!failureRecordOk(run)) checkCounts.failureSchemaViolations += 1
      continue
    }
    if (!strictSuccessTransportOk(run)) checkCounts.successTransportViolations += 1
    if (run?.responseTarget?.redirected !== false || run?.responseTarget?.urlMatched !== true) {
      checkCounts.responseTargetViolations += 1
    }
    if (run?.responseTarget?.serviceIdentityMatched !== true) {
      checkCounts.serviceIdentityViolations += 1
    }
    if (!metricsSchemaOk(run?.metrics)
      || run.metricsSha256 !== sha256(canonicalJson(run.metrics))) {
      checkCounts.metricsHashViolations += 1
    }
    if (!structureRecordOk(run)) checkCounts.coreStructureViolations += 1
    if (!analysisContractStructureOk(run)) checkCounts.analysisContractViolations += 1
    if (!safeFormulaTypes(run?.formulaChecks)) checkCounts.formulaTypeViolations += 1
    const formula = runFormulaOk(run, file)
    if (!formula.hashOk) checkCounts.formulaHashViolations += 1
    if (!formula.recomputed) checkCounts.formulaRecomputeViolations += 1
    if (!formula.requiredPassed) checkCounts.requiredFormulaViolations += 1
    const metadataHashOk = exactBooleanRecord(run.metadataChecks, METADATA_CHECK_KEYS)
      && run.metadataEvidenceSha256 === sha256(canonicalJson(run.metadataChecks))
    if (!metadataHashOk) checkCounts.metadataEvidenceViolations += 1
    const multiHashOk = exactBooleanRecord(run.multiCnyChecks, MULTI_CNY_CHECK_KEYS)
      && run.multiCnyEvidenceSha256 === sha256(canonicalJson(run.multiCnyChecks))
    if (!multiHashOk) checkCounts.multiCnyEvidenceViolations += 1
    const sharedEvidenceOk = formula.shared.schemaOk
      && run.sharedDedupEvidenceSha256 === sha256(canonicalJson(run.sharedDedupEvidence))
      && sameCanonical(run.sharedDedupChecks, formula.shared.checks)
    if (!sharedEvidenceOk) checkCounts.sharedDedupEvidenceViolations += 1
    if ((file.tags || []).includes('credit-utilization') && run.flags?.creditCard !== true) {
      checkCounts.creditCardEvidenceViolations += 1
    }
    if (typeof run.flags?.creditCard !== 'boolean') checkCounts.creditCardEvidenceViolations += 1
    if ((file.tags || []).includes('shared-limit-candidate')
      && run.flags?.backendSharedLimitSemanticSignal !== true) {
      checkCounts.backendSharedSemanticSignalViolations += 1
    }
    if (typeof run.flags?.backendSharedLimitSemanticSignal !== 'boolean') {
      checkCounts.backendSharedSemanticSignalViolations += 1
    }
    const ownership = run?.ownershipEvidence
    const ownershipSemanticallyValid = exactBooleanRecord(ownership, OWNERSHIP_EVIDENCE_KEYS)
      && ownership.ownershipVerified === (
        ownership.trustedBasicInfoFound
        && ownership.nameCredible
        && ownership.idCardPresent
        && ownership.idCardFormatValid
        && ownership.idCardChecksumValid
      )
    if (!ownershipSemanticallyValid) checkCounts.ownershipEvidenceViolations += 1
    const scannedOwnershipValid = !EXPECTED_SCANNED_IDS.has(file.id)
      || ownership?.ownershipVerified === true
    if (!scannedOwnershipValid) checkCounts.scannedOwnershipViolations += 1
    validFormulaRun.set(
      run,
      formula.hashOk
        && formula.recomputed
        && formula.requiredPassed
        && formula.allTypesSafe
        && formula.allChecksPassed
        && analysisContractStructureOk(run)
        && scannedOwnershipValid
    )
  }

  const attemptsByRound = new Map()
  for (const run of runs) {
    const key = `${run?.fileId}|${run?.round}`
    if (!attemptsByRound.has(key)) attemptsByRound.set(key, [])
    attemptsByRound.get(key).push(run)
  }
  for (const attempts of attemptsByRound.values()) {
    const attemptsSequential = attempts.every((run, index) => run?.attempt === index + 1)
    const successIndexes = attempts
      .map((run, index) => run?.success === true ? index : -1)
      .filter((index) => index >= 0)
    const successTerminal = successIndexes.length <= 1
      && (successIndexes.length === 0 || successIndexes[0] === attempts.length - 1)
    if (attempts.length > 3 || !attemptsSequential || !successTerminal) {
      checkCounts.attemptSequenceViolations += 1
    }
  }

  const nonceValues = runs.map((run) => run?.requestNonceHash).filter((value) => typeof value === 'string')
  if (new Set(nonceValues).size !== nonceValues.length) checkCounts.requestNonceViolations += 1
  const requestStarts = Array.isArray(state?.requestStarts) ? state.requestStarts : []
  if (requestStarts.length !== runs.length + (state?.inFlight ? 1 : 0)) {
    checkCounts.requestStartViolations += 1
  }
  const requestStartNonces = requestStarts.map((entry) => entry?.requestNonceHash)
  if (new Set(requestStartNonces).size !== requestStartNonces.length) {
    checkCounts.requestNonceViolations += 1
  }
  let priorStartedAt = -Infinity
  const requestKeys = new Set()
  const requestStartTimes = []
  for (const entry of requestStarts) {
    const parsed = Date.parse(entry?.startedAt || '')
    const key = `${entry?.startedAt}|${entry?.requestNonceHash}`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || !sameCanonical(Object.keys(entry).sort(), REQUEST_START_KEYS)
      || !validIso(entry?.startedAt) || parsed <= priorStartedAt
      || !HASH_RE.test(String(entry?.requestNonceHash || ''))
      || entry?.targetId !== SAFE_TARGET_ID
      || requestKeys.has(key)) {
      checkCounts.requestStartViolations += 1
    }
    if (Number.isFinite(parsed)) requestStartTimes.push(parsed)
    priorStartedAt = parsed
    requestKeys.add(key)
  }
  for (let index = 1; index < requestStartTimes.length; index += 1) {
    if (requestStartTimes[index] - requestStartTimes[index - 1] < MIN_START_INTERVAL_MS) {
      checkCounts.rateLimitViolations += 1
    }
  }
  for (let index = 0; index + MAX_STARTS_PER_HOUR < requestStartTimes.length; index += 1) {
    if (requestStartTimes[index + MAX_STARTS_PER_HOUR] - requestStartTimes[index] < RATE_WINDOW_MS) {
      checkCounts.rateLimitViolations += 1
    }
  }
  for (const run of runs) {
    if (!requestKeys.has(`${run?.startedAt}|${run?.requestNonceHash}`)) {
      checkCounts.requestStartViolations += 1
    }
  }
  if (state?.inFlight) {
    const lastStart = requestStarts.at(-1)
    if (!lastStart
      || lastStart.startedAt !== state.inFlight.startedAt
      || lastStart.requestNonceHash !== state.inFlight.requestNonceHash
      || lastStart.targetId !== state.inFlight.targetId) {
      checkCounts.requestStartViolations += 1
    }
  }

  const ledger = Array.isArray(ledgerEntries) ? ledgerEntries : []
  if (!Array.isArray(ledgerEntries)) checkCounts.ledgerSchemaViolations += 1
  let priorLedgerStartedAt = -Infinity
  let priorEntrySha256 = null
  const ledgerNonces = new Set()
  const currentManifestLedgerEntries = []
  const ledgerStartTimes = []
  for (let index = 0; index < ledger.length; index += 1) {
    const entry = ledger[index]
    const parsed = Date.parse(entry?.startedAt || '')
    const entrySchemaOk = entry
      && typeof entry === 'object'
      && !Array.isArray(entry)
      && sameCanonical(Object.keys(entry).sort(), LEDGER_ENTRY_KEYS)
      && entry.version === 1
      && entry.sequence === index + 1
      && validIso(entry.startedAt)
      && parsed > priorLedgerStartedAt
      && HASH_RE.test(String(entry.requestNonceHash || ''))
      && entry.targetId === SAFE_TARGET_ID
      && HASH_RE.test(String(entry.manifestSha256 || ''))
      && entry.previousEntrySha256 === priorEntrySha256
      && HASH_RE.test(String(entry.entrySha256 || ''))
      && entry.entrySha256 === ledgerEntrySha256(entry)
      && !ledgerNonces.has(entry.requestNonceHash)
    if (!entrySchemaOk) checkCounts.ledgerSchemaViolations += 1
    if (Number.isFinite(parsed)) ledgerStartTimes.push(parsed)
    if (entry?.manifestSha256 === expectedProjectionSha) currentManifestLedgerEntries.push(entry)
    if (typeof entry?.requestNonceHash === 'string') ledgerNonces.add(entry.requestNonceHash)
    priorLedgerStartedAt = parsed
    priorEntrySha256 = entry?.entrySha256 ?? null
  }
  for (let index = 1; index < ledgerStartTimes.length; index += 1) {
    if (ledgerStartTimes[index] - ledgerStartTimes[index - 1] < MIN_START_INTERVAL_MS) {
      checkCounts.rateLimitViolations += 1
    }
  }
  for (let index = 0; index + MAX_STARTS_PER_HOUR < ledgerStartTimes.length; index += 1) {
    if (ledgerStartTimes[index + MAX_STARTS_PER_HOUR] - ledgerStartTimes[index] < RATE_WINDOW_MS) {
      checkCounts.rateLimitViolations += 1
    }
  }
  if (currentManifestLedgerEntries.length !== requestStarts.length) {
    checkCounts.ledgerBindingViolations += 1
  }
  for (let index = 0; index < requestStarts.length; index += 1) {
    const local = requestStarts[index]
    const global = currentManifestLedgerEntries[index]
    if (!global
      || local?.startedAt !== global.startedAt
      || local?.requestNonceHash !== global.requestNonceHash
      || local?.targetId !== global.targetId) {
      checkCounts.ledgerBindingViolations += 1
    }
  }

  const uniqueSuccessKeys = new Set(successKeys)
  const duplicateSuccessRounds = successKeys.length - uniqueSuccessKeys.size
  const perFile = files.map((file) => {
    const fileRuns = successes.filter((run) => run.fileId === file.id)
    const distinctRounds = new Set(fileRuns.map((run) => run.round))
    const complete = fileRuns.length === file.targetRuns && distinctRounds.size === file.targetRuns
    const metricsStable = complete && new Set(fileRuns.map((run) => run.metricsSha256)).size === 1
    const structureStable = complete && new Set(fileRuns.map((run) => run.coreStructureSha256)).size === 1
    const formulaStable = complete && new Set(fileRuns.map((run) => run.formulaChecksSha256)).size === 1
    const formulaPassed = complete && fileRuns.every((run) => validFormulaRun.get(run) === true)
    return { id: file.id, complete, metricsStable, structureStable, formulaStable, formulaPassed }
  })
  const completeFiles = perFile.filter((file) => file.complete).length
  const metricsStableFiles = perFile.filter((file) => file.metricsStable).length
  const structureStableFiles = perFile.filter((file) => file.structureStable).length
  const formulaStableFiles = perFile.filter((file) => file.formulaStable).length
  const formulaPassedFiles = perFile.filter((file) => file.formulaPassed).length

  let duplicateContentGroupsConsistent = 0
  for (const members of EXPECTED_DUPLICATE_GROUPS) {
    const memberRuns = members.flatMap((id) => successes.filter((run) => run.fileId === id))
    const complete = members.every((id) => perFile.find((file) => file.id === id)?.complete === true)
    const consistent = complete
      && new Set(memberRuns.map((run) => run.metricsSha256)).size === 1
      && new Set(memberRuns.map((run) => run.coreStructureSha256)).size === 1
      && new Set(memberRuns.map((run) => run.formulaChecksSha256)).size === 1
      && new Set(memberRuns.map((run) => run.metadataEvidenceSha256)).size === 1
      && new Set(memberRuns.map((run) => run.multiCnyEvidenceSha256)).size === 1
      && new Set(memberRuns.map((run) => run.sharedDedupEvidenceSha256)).size === 1
    if (consistent) duplicateContentGroupsConsistent += 1
    else if (state?.status === 'complete') checkCounts.duplicateContentGroupViolations += 1
  }

  const expectedSummary = buildSummaryV4({ ...manifest, files }, state || { runs: [] })
  const summaryEnvelopeOk = summary?.version === GATE_VERSION
    && summary?.targetId === SAFE_TARGET_ID
    && summary?.scope?.baseUrl === LEGACY_BASE_URL
    && summary?.scope?.endpoint === ANALYZE_PATH
    && summary?.scope?.serviceLine === EXPECTED_SERVICE_LINE
    && summary?.scope?.manifestSha256 === manifestCheck.projectionSha
    && validIso(summary?.generatedAt)
  if (!summaryEnvelopeOk) checkCounts.summaryEnvelopeViolations += 1
  const summaryWithoutGeneratedAt = summary && typeof summary === 'object'
    ? Object.fromEntries(Object.entries(summary).filter(([key]) => key !== 'generatedAt'))
    : summary
  const expectedWithoutGeneratedAt = Object.fromEntries(
    Object.entries(expectedSummary).filter(([key]) => key !== 'generatedAt')
  )
  if (!sameCanonical(summaryWithoutGeneratedAt, expectedWithoutGeneratedAt)) {
    checkCounts.summaryFilesViolations += 1
  }

  const allViolationCount = Object.values(checkCounts).reduce((sum, value) => sum + value, 0)
  const scannedSuccesses = successes.filter((run) => EXPECTED_SCANNED_IDS.has(run.fileId))
  const scannedOwnershipVerifiedRuns = scannedSuccesses.filter(
    (run) => run.ownershipEvidence?.ownershipVerified === true
  ).length
  const scannedFilesOwnershipVerified = [...EXPECTED_SCANNED_IDS].filter((id) => {
    const file = files.find((candidate) => candidate.id === id)
    const fileRuns = successes.filter((run) => run.fileId === id)
    return file
      && fileRuns.length === file.targetRuns
      && fileRuns.every((run) => run.ownershipEvidence?.ownershipVerified === true)
  }).length
  const completedStateConsistent = state?.status !== 'complete'
    || (
      state?.inFlight === null
      && successes.length === 137
      && uniqueSuccessKeys.size === 137
      && completeFiles === 31
      && metricsStableFiles === 31
      && structureStableFiles === 31
      && formulaStableFiles === 31
      && formulaPassedFiles === 31
      && duplicateContentGroupsConsistent === 2
      && scannedOwnershipVerifiedRuns === 5
      && scannedFilesOwnershipVerified === 1
    )
  const snapshotValid = allViolationCount === 0
    && duplicateSuccessRounds === 0
    && completedStateConsistent
  const coreBatchStrictPass = snapshotValid
    && state?.status === 'complete'
    && state?.inFlight === null
    && successes.length === 137
    && uniqueSuccessKeys.size === 137
    && completeFiles === 31
    && metricsStableFiles === 31
    && structureStableFiles === 31
    && formulaStableFiles === 31
    && formulaPassedFiles === 31
    && duplicateContentGroupsConsistent === 2
    && scannedOwnershipVerifiedRuns === 5
    && scannedFilesOwnershipVerified === 1

  const durations = successes.map((run) => run.durationMs).filter(Number.isFinite).sort((a, b) => a - b)
  const failureClasses = Object.fromEntries(
    [...new Set(failures.map((run) => safeErrorClass(run?.errorClass)))]
      .sort()
      .map((name) => [name, failures.filter((run) => safeErrorClass(run?.errorClass) === name).length])
  )
  return {
    coreBatchStrictPass,
    strictPass: coreBatchStrictPass,
    snapshotValid,
    status: state?.status || 'invalid',
    inFlight: state?.inFlight != null,
    scope: {
      serviceLine: EXPECTED_SERVICE_LINE,
      fileInstances: files.length,
      uniqueContentHashes: new Set(files.map((file) => file.sha256)).size,
      focusFiles: files.filter((file) => EXPECTED_FOCUS_IDS.has(file.id)).length,
      ordinaryFiles: files.filter((file) => !EXPECTED_FOCUS_IDS.has(file.id)).length,
      scannedFiles: files.filter((file) => EXPECTED_SCANNED_IDS.has(file.id)).length,
      sharedCandidateFiles: files.filter((file) => EXPECTED_SHARED_IDS.has(file.id)).length,
      multiCnyFiles: files.filter((file) => EXPECTED_MULTI_CNY_IDS.has(file.id)).length,
      plannedSuccessfulRuns: files.reduce((sum, file) => sum + Number(file.targetRuns || 0), 0)
    },
    completion: {
      successfulRecords: successes.length,
      uniqueSuccessfulRounds: uniqueSuccessKeys.size,
      duplicateSuccessfulRounds: duplicateSuccessRounds,
      completeFiles,
      failedAttempts: failures.length,
      requestStarts: requestStarts.length
    },
    ownership: {
      scannedSuccessfulRuns: scannedSuccesses.length,
      scannedOwnershipVerifiedRuns,
      scannedFilesOwnershipVerified
    },
    checks: checkCounts,
    consistency: {
      metricsStableFiles,
      structureStableFiles,
      formulaStableFiles,
      formulaPassedFiles,
      duplicateContentGroupsConsistent
    },
    latencyMs: {
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      max: durations.length ? durations.at(-1) : null
    },
    failureClasses,
    limitations: {
      scannedCorpusCovered: scannedFilesOwnershipVerified === EXPECTED_SCANNED_IDS.size,
      scannedCorpusCount: EXPECTED_SCANNED_IDS.size,
      nineGroupSemanticAndVisiblePromptCovered: false,
      fullUiFlowCoveredByThisBatch: false,
      completeAcceptance: false,
      note: 'v4批次覆盖一个扫描件样本，但不等于9组可见提示或完整UI流程验收。'
    }
  }
}

export async function validateStateSnapshotV4(manifest, state, ledgerEntries, options = {}) {
  const summary = buildSummaryV4(manifest, state)
  const result = await evaluateGateV4(manifest, state, summary, {
    ...options,
    verifyInputFiles: options.verifyInputFiles === true,
    ledgerEntries
  })
  return { valid: result.snapshotValid === true, result }
}

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))

const runCli = async () => {
  const argv = process.argv.slice(2)
  const arg = (name) => {
    const index = argv.indexOf(name)
    return index >= 0 ? argv[index + 1] : ''
  }
  const manifestPath = arg('--manifest')
  const statePath = arg('--state')
  const summaryPath = arg('--summary')
  const requestLedgerPath = arg('--request-ledger')
  if (!manifestPath || !statePath || !summaryPath || !requestLedgerPath) throw new Error('missing arguments')
  const privateRoot = resolve(process.cwd(), 'tmp')
  for (const candidate of [manifestPath, statePath, summaryPath, requestLedgerPath]) {
    const absolute = resolve(candidate)
    if (!absolute.startsWith(`${privateRoot}\\`)) throw new Error('unsafe runtime path')
  }
  if (!requestLedgerPath.endsWith('.private.jsonl')) throw new Error('unsafe ledger name')
  const [manifest, state, summary, ledgerText] = await Promise.all([
    readJson(resolve(manifestPath)),
    readJson(resolve(statePath)),
    readJson(resolve(summaryPath)),
    readFile(resolve(requestLedgerPath), 'utf8').catch((error) => {
      if (error?.code === 'ENOENT') return ''
      throw error
    })
  ])
  const result = await evaluateGateV4(manifest, state, summary, {
    verifyInputFiles: true,
    ledgerEntries: parseRequestLedger(ledgerText)
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!result.coreBatchStrictPass) process.exitCode = 2
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (invokedPath === import.meta.url) {
  runCli().catch(() => {
    process.stdout.write(`${JSON.stringify({
      coreBatchStrictPass: false,
      strictPass: false,
      status: 'validator_error',
      limitations: {
        scannedCorpusCovered: false,
        scannedCorpusCount: 1,
        nineGroupSemanticAndVisiblePromptCovered: false,
        fullUiFlowCoveredByThisBatch: false,
        completeAcceptance: false
      }
    }, null, 2)}\n`)
    process.exitCode = 2
  })
}
