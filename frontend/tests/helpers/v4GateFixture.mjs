import {
  CORE_STRUCTURE_PATHS,
  EXPECTED_TAGS_BY_ID,
  buildSummaryV4,
  canonicalJson,
  ledgerEntrySha256,
  projectManifest,
  recomputeFormulaChecks,
  recomputeSharedDedupChecks,
  sha256
} from '../../scripts/validate-legacy-analysis-consistency-v4.mjs'
import { REQUIRED_ANALYZE_CONTRACT } from '../../scripts/legacy-analysis-response-policy.mjs'

const FOCUS_IDS = new Set([
  'P01', 'P03', 'P04', 'P05', 'P06', 'P07', 'P09', 'P11', 'P13', 'P14', 'P17',
  'P19', 'P20', 'P21', 'P24', 'P25', 'P26', 'P27', 'P28', 'P29', 'P30', 'P31'
])

const metadataChecks = () => ({
  cardMetadataRowsAligned: true,
  normalizedCardRawPreserved: true,
  currencyMetadataPreserved: true,
  cardTailMetadataPreserved: true,
  sharedCreditGroupMetadataPreserved: true,
  utilizationGroupMetadataPreserved: true
})

const multiCnyChecks = () => ({
  multiCnySourceCandidateProven: true,
  multiCnyMappedRowsAligned: true,
  multiCnyMappedSeparationProven: true,
  multiCnyNormalizedMetadataRetained: true,
  multiCnyUtilizationGroupsProven: true,
  multiCnyKeptSeparate: true
})

const emptySharedSide = () => ({
  qualifyingGroupCount: 0,
  explicitGroupCount: 0,
  inferredGroupCount: 0,
  allGroupsHaveMultipleMembers: false,
  allGroupsUseSingleRepresentative: false,
  groups: []
})

const provenSharedSide = () => ({
  qualifyingGroupCount: 1,
  explicitGroupCount: 1,
  inferredGroupCount: 0,
  allGroupsHaveMultipleMembers: true,
  allGroupsUseSingleRepresentative: true,
  groups: [{
    basis: 'explicit',
    memberCount: 2,
    includedMemberCount: 1,
    members: [{ included: true }, { included: false }]
  }]
})

const ownershipEvidence = (verified = false) => ({
  trustedBasicInfoFound: verified,
  nameCredible: verified,
  idCardPresent: verified,
  idCardFormatValid: verified,
  idCardChecksumValid: verified,
  ownershipVerified: verified
})

const metricsFor = (tags) => {
  const credit = tags.includes('credit-utilization')
  const shared = tags.includes('shared-limit-candidate')
  if (!credit) {
    return {
      'credit_debt.credit_cards.total_limit': 0,
      'credit_debt.credit_cards.total_used': 0,
      'credit_debt.credit_cards.usage_rate': 0,
      'credit_debt.credit_cards.raw_total_limit': 0,
      'credit_debt.credit_cards.card_count': 0,
      'credit_debt.credit_cards.utilization_group_count': 0,
      'credit_debt.credit_cards.shared_group_count': 0,
      'credit_card_details.count': 0,
      'rule_engine_warnings.count': 0,
      'web.cardUsed': 0,
      'web.cardLimit': 0,
      'web.cardUsagePct': 0,
      'web.creditCardUsageRatePct': 0,
      'web.cardUtilizationGroupCount': 0,
      'web.cardSharedGroupCount': 0,
      'web.cardInferredSharedGroupCount': 0,
      'web.cardForeignCurrencyAccountCount': 0,
      'web.highUsageCount': 0,
      'web.cardCount': 0,
      'web.loanCount': 0,
      'web.accountCount': 0,
      'web.mapperOk': true
    }
  }
  return {
    'credit_debt.credit_cards.total_limit': 100,
    'credit_debt.credit_cards.total_used': 50,
    'credit_debt.credit_cards.usage_rate': 0.5,
    'credit_debt.credit_cards.raw_total_limit': shared ? 200 : 100,
    'credit_debt.credit_cards.card_count': 2,
    'credit_debt.credit_cards.utilization_group_count': shared ? 1 : 2,
    'credit_debt.credit_cards.shared_group_count': shared ? 1 : 0,
    'credit_card_details.count': 2,
    'rule_engine_warnings.count': 0,
    'web.cardUsed': 50,
    'web.cardLimit': 100,
    'web.cardUsagePct': 50,
    'web.creditCardUsageRatePct': 50,
    'web.cardUtilizationGroupCount': shared ? 1 : 2,
    'web.cardSharedGroupCount': shared ? 1 : 0,
    'web.cardInferredSharedGroupCount': 0,
    'web.cardForeignCurrencyAccountCount': 0,
    'web.highUsageCount': 0,
    'web.cardCount': 2,
    'web.loanCount': 0,
    'web.accountCount': 2,
    'web.mapperOk': true
  }
}

const makeStructure = () => {
  const requiredTypes = new Map(REQUIRED_ANALYZE_CONTRACT)
  const fields = Object.fromEntries(CORE_STRUCTURE_PATHS.map((path) => [
    path,
    requiredTypes.get(path) === 'array' ? { type: 'array', length: 0 } : { type: 'object' }
  ]))
  return {
    fields,
    fieldHashes: Object.fromEntries(
      CORE_STRUCTURE_PATHS.map((path) => [path, sha256(canonicalJson(fields[path]))])
    ),
    aggregate: sha256(canonicalJson(fields))
  }
}

const makeFixture = () => {
  const files = Object.entries(EXPECTED_TAGS_BY_ID).map(([id, tags]) => ({
    id,
    path: `private-${id}`,
    sha256: sha256(`content:${id === 'P19' ? 'P05' : (id === 'P27' ? 'P26' : id)}`),
    targetRuns: FOCUS_IDS.has(id) ? 5 : 3,
    tags: [...tags]
  }))
  const manifest = { version: 1, files }
  const manifestSha256 = sha256(canonicalJson(projectManifest(manifest)))
  const state = {
    version: 4,
    baseUrl: 'http://127.0.0.1:3200/legacy-api',
    analyzePath: '/legacy-api/api/analyze',
    targetId: 'legacy-analyze-v4',
    manifestSha256,
    startedAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T06:00:00.000Z',
    finishedAt: '2026-07-22T06:00:00.000Z',
    status: 'complete',
    inFlight: null,
    serverBackoffUntil: null,
    requestStarts: [],
    runs: []
  }
  const ledgerEntries = []
  const structure = makeStructure()
  let sequence = 0
  for (const file of files) {
    for (let round = 1; round <= file.targetRuns; round += 1) {
      sequence += 1
      const slot = sequence - 1
      const windowIndex = Math.floor(slot / 28)
      const windowOffset = slot % 28
      const startedMs = Date.parse('2026-07-22T00:00:00.000Z')
        + windowIndex * (60 * 60 * 1_000 + 2_000)
        + windowOffset * 15_000
      const startedAt = new Date(startedMs).toISOString()
      const requestNonceHash = sha256(`nonce:${sequence}`)
      const shared = file.tags.includes('shared-limit-candidate')
      const sharedDedupEvidence = {
        backend: shared ? provenSharedSide() : emptySharedSide(),
        web: shared ? provenSharedSide() : emptySharedSide()
      }
      const sharedChecks = recomputeSharedDedupChecks(sharedDedupEvidence).checks
      const metrics = metricsFor(file.tags)
      const formulaChecks = recomputeFormulaChecks(
        metrics,
        file.tags,
        metadataChecks(),
        multiCnyChecks(),
        sharedChecks
      )
      const run = {
        fileId: file.id,
        round,
        attempt: 1,
        startedAt,
        finishedAt: new Date(startedMs + 100).toISOString(),
        success: true,
        durationMs: 100,
        httpStatus: 200,
        code: 0,
        gateVersion: 4,
        inputSha256: file.sha256,
        requestNonceHash,
        responseTarget: {
          id: 'legacy-analyze-v4',
          redirected: false,
          urlMatched: true,
          serviceIdentityMatched: true
        },
        ownershipEvidence: ownershipEvidence(file.id === 'P31'),
        responseSha256: sha256(`response:${file.id}`),
        structureSha256: structure.aggregate,
        coreStructureSha256: structure.aggregate,
        coreStructureFields: structuredClone(structure.fields),
        coreStructureFieldHashes: structuredClone(structure.fieldHashes),
        metricsSha256: sha256(canonicalJson(metrics)),
        metrics,
        formulaChecks,
        formulaChecksSha256: sha256(canonicalJson(formulaChecks)),
        metadataChecks: metadataChecks(),
        metadataEvidenceSha256: sha256(canonicalJson(metadataChecks())),
        multiCnyChecks: multiCnyChecks(),
        multiCnyEvidenceSha256: sha256(canonicalJson(multiCnyChecks())),
        sharedDedupChecks: sharedChecks,
        sharedDedupEvidence,
        sharedDedupEvidenceSha256: sha256(canonicalJson(sharedDedupEvidence)),
        validationFailures: [],
        flags: {
          creditCard: file.tags.includes('credit-utilization'),
          backendSharedLimitSemanticSignal: shared
        },
        webTimeoutExceeded: false,
        rateLimit: { limit: 30, remaining: 29, resetSeconds: 3600, retryAfterSeconds: null }
      }
      state.requestStarts.push({ startedAt, requestNonceHash, targetId: 'legacy-analyze-v4' })
      state.runs.push(run)
      const ledgerEntry = {
        version: 1,
        sequence,
        startedAt,
        requestNonceHash,
        targetId: 'legacy-analyze-v4',
        manifestSha256,
        previousEntrySha256: ledgerEntries.at(-1)?.entrySha256 || null
      }
      ledgerEntry.entrySha256 = ledgerEntrySha256(ledgerEntry)
      ledgerEntries.push(ledgerEntry)
    }
  }
  const summary = buildSummaryV4(manifest, state)
  return { manifest, state, summary, ledgerEntries, manifestSha256 }
}

export const makeV4GateFixture = makeFixture
