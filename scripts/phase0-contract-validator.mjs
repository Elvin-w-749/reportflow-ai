const sameMembers = (actual, expected) => JSON.stringify([...(actual || [])].sort()) === JSON.stringify([...expected].sort())
const deepEqual = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected)

export const HARD_GATE_CONDITIONS = Object.freeze([
  'tenant-or-owner-mismatch',
  'job-or-document-identity-mismatch',
  'page-count-or-page-order-mismatch',
  'full-text-coverage-incomplete',
  'document-hash-or-hash-chain-failure',
  'cross-document-or-cross-version-replay'
])

export const FORBIDDEN_OCR_FALLBACKS = Object.freeze([
  'tesseract',
  'rapidocr',
  'moonshot',
  'kimi',
  'client-model'
])

const TASK_CLASS_GROUPS = Object.freeze({
  upstream_transient: [
    'GLM_OCR_HTTP_408',
    'GLM_OCR_RATE_LIMITED',
    'GLM_OCR_PROVIDER_UNAVAILABLE',
    'GLM_OCR_PROVIDER_ERROR',
    'DEEPSEEK_HTTP_408',
    'DEEPSEEK_HTTP_409',
    'DEEPSEEK_HTTP_425',
    'DEEPSEEK_RATE_LIMITED',
    'DEEPSEEK_PROVIDER_UNAVAILABLE',
    'DEEPSEEK_OUTPUT_TRUNCATED'
  ],
  transport_transient: [
    'GLM_OCR_NETWORK_ERROR',
    'GLM_OCR_CONNECT_TIMEOUT',
    'GLM_OCR_PAGE_TIMEOUT',
    'OCR_STAGE_DEADLINE_EXCEEDED',
    'DEEPSEEK_NETWORK_ERROR',
    'DEEPSEEK_TIMEOUT'
  ],
  evidence_permanent: [
    'GLM_OCR_PAGE_COVERAGE_MISMATCH',
    'OCR_RECORD_MEMBERSHIP_UNPROVEN',
    'OCR_READING_ORDER_CONFLICT',
    'EVIDENCE_PUBLICATION_BLOCKED'
  ],
  schema_permanent: [
    'GLM_OCR_RESPONSE_INVALID',
    'DEEPSEEK_RESPONSE_INVALID'
  ],
  input_permanent: [
    'GLM_OCR_BAD_REQUEST',
    'GLM_OCR_INPUT_TOO_LARGE',
    'DEEPSEEK_INPUT_TOO_LARGE',
    'DEEPSEEK_CONTEXT_LIMIT'
  ],
  configuration_permanent: [
    'GLM_OCR_NOT_CONFIGURED',
    'GLM_OCR_CLIENT_ERROR',
    'GLM_OCR_AUTH_FAILED',
    'GLM_OCR_FORBIDDEN',
    'DEEPSEEK_NOT_CONFIGURED',
    'DEEPSEEK_BAD_REQUEST',
    'DEEPSEEK_CLIENT_ERROR',
    'DEEPSEEK_AUTH_FAILED',
    'DEEPSEEK_FORBIDDEN'
  ]
})

export const EXPECTED_ERROR_CODES = Object.freeze(
  Object.values(TASK_CLASS_GROUPS).flat().sort()
)

const TASK_CLASS_BY_CODE = Object.freeze(Object.fromEntries(
  Object.entries(TASK_CLASS_GROUPS).flatMap(([taskClass, codes]) => codes.map((code) => [code, taskClass]))
))

const AUTO_RETRY_CODES = Object.freeze([
  'GLM_OCR_NETWORK_ERROR',
  'GLM_OCR_CONNECT_TIMEOUT',
  'GLM_OCR_PAGE_TIMEOUT',
  'GLM_OCR_HTTP_408',
  'GLM_OCR_RATE_LIMITED',
  'GLM_OCR_PROVIDER_UNAVAILABLE',
  'DEEPSEEK_NETWORK_ERROR',
  'DEEPSEEK_TIMEOUT',
  'DEEPSEEK_RATE_LIMITED',
  'DEEPSEEK_PROVIDER_UNAVAILABLE'
])

const NEW_JOB_RETRY_CODES = Object.freeze([
  ...AUTO_RETRY_CODES,
  'GLM_OCR_PROVIDER_ERROR',
  'OCR_STAGE_DEADLINE_EXCEEDED',
  'DEEPSEEK_HTTP_408',
  'DEEPSEEK_HTTP_409',
  'DEEPSEEK_HTTP_425',
  'DEEPSEEK_OUTPUT_TRUNCATED'
])

const PUBLIC_MESSAGE_GROUPS = Object.freeze({
  'provider-configuration-unavailable': [
    'GLM_OCR_NOT_CONFIGURED', 'GLM_OCR_CLIENT_ERROR', 'GLM_OCR_AUTH_FAILED', 'GLM_OCR_FORBIDDEN',
    'DEEPSEEK_NOT_CONFIGURED', 'DEEPSEEK_BAD_REQUEST', 'DEEPSEEK_CLIENT_ERROR', 'DEEPSEEK_AUTH_FAILED', 'DEEPSEEK_FORBIDDEN'
  ],
  'provider-connection-interrupted': ['GLM_OCR_NETWORK_ERROR', 'DEEPSEEK_NETWORK_ERROR'],
  'provider-timeout': ['GLM_OCR_CONNECT_TIMEOUT', 'GLM_OCR_PAGE_TIMEOUT', 'GLM_OCR_HTTP_408', 'DEEPSEEK_TIMEOUT', 'DEEPSEEK_HTTP_408'],
  'provider-temporarily-unavailable': [
    'GLM_OCR_RATE_LIMITED', 'GLM_OCR_PROVIDER_UNAVAILABLE', 'GLM_OCR_PROVIDER_ERROR',
    'DEEPSEEK_HTTP_409', 'DEEPSEEK_HTTP_425', 'DEEPSEEK_RATE_LIMITED', 'DEEPSEEK_PROVIDER_UNAVAILABLE'
  ],
  'analysis-input-rejected': ['GLM_OCR_BAD_REQUEST', 'GLM_OCR_INPUT_TOO_LARGE', 'DEEPSEEK_INPUT_TOO_LARGE', 'DEEPSEEK_CONTEXT_LIMIT'],
  'provider-response-invalid': ['GLM_OCR_RESPONSE_INVALID', 'DEEPSEEK_RESPONSE_INVALID', 'DEEPSEEK_OUTPUT_TRUNCATED'],
  'evidence-structure-unproven': ['GLM_OCR_PAGE_COVERAGE_MISMATCH', 'OCR_RECORD_MEMBERSHIP_UNPROVEN', 'OCR_READING_ORDER_CONFLICT'],
  'analysis-deadline-exceeded': ['OCR_STAGE_DEADLINE_EXCEEDED'],
  'analysis-publication-blocked': ['EVIDENCE_PUBLICATION_BLOCKED']
})

const PUBLIC_MESSAGE_BY_CODE = Object.freeze(Object.fromEntries(
  Object.entries(PUBLIC_MESSAGE_GROUPS).flatMap(([message, codes]) => codes.map((code) => [code, message]))
))

const EXPECTED_HARD_LIMITS = Object.freeze({
  rawResponseMaxBytesPerPage: 16777216,
  regionsPerPageMax: 5000,
  rawRegionContentMaxChars: 200000,
  htmlMaxBytesPerRegion: 1048576,
  htmlMaxNodesPerRegion: 10000,
  htmlMaxDepth: 32,
  htmlMaxAttributesPerNode: 32,
  htmlMaxAttributeBytes: 2048,
  tableRowsPerRegionMax: 10000,
  tableCellsPerRowMax: 256,
  pageTextMaxChars: 1000000,
  documentTextMaxChars: 1000000,
  rawHtmlAllowedTags: ['table', 'thead', 'tbody', 'tr', 'th', 'td'],
  rawHtmlAllowedAttributes: ['rowspan', 'colspan'],
  rawHtmlNonTableTagsAllowed: false,
  rawHtmlEventAttributesAllowed: false,
  rawHtmlUrlAttributesAllowed: false,
  rawHtmlStyleAllowed: false,
  normalizedHtmlTagsAllowed: false,
  externalResourceFetchAllowed: false,
  activeMarkupAllowed: false
})

const EXPECTED_COORDINATE_CONVERSION = Object.freeze({
  version: 'glm-normalized-region-bbox-to-rendered-pixels-v1',
  internalSpace: 'rendered-image-pixels',
  origin: 'top-left',
  boundsOrder: 'x0-y0-x1-y1',
  providerInputMode: 'normalized-0-to-1-only',
  pageModeFixed: true,
  allRegionCoordinatesMustBeWithinInclusiveRange: [0, 1],
  normalizedXFormula: 'rawX * renderedWidth',
  normalizedYFormula: 'rawY * renderedHeight',
  roundingFormula: 'Math.round(value * 1000) / 1000',
  precisionDecimals: 3,
  negativeZeroNormalized: true,
  postRoundingBoundsAndPositiveExtentRequired: true,
  postRoundingFailureError: 'GLM_OCR_RESPONSE_INVALID',
  clampAllowed: false,
  axisSwapAllowed: false,
  outOfRangeOrMixedModeError: 'GLM_OCR_RESPONSE_INVALID'
})

const EXPECTED_SEMANTIC_VALIDATION = Object.freeze({
  nonWhitespaceCoverageExactlyOnce: true,
  anyCharacterOverlapAllowed: false,
  sourceLineCountMustMatchWithinSourceBlock: true,
  sourceLineOrdinalsMustBeUniqueAndContiguous: true,
  internalCoordinatesMaxPrecisionDecimals: 3,
  internalNegativeZeroAllowed: false,
  internalFailureCodes: {
    pageOverlap: 'ocr.page-overlap',
    sourceLineCount: 'ocr.source-line-count-consistency',
    sourceLineSequence: 'ocr.source-line-sequence',
    pageCoordinateCanonical: 'ocr.page-coordinate-canonical',
    bboxCoordinateCanonical: 'ocr.bbox-coordinate-canonical',
    roundedExtent: 'provider-bbox.rounded-extent'
  },
  publicFailureMappings: {
    pageOverlap: 'GLM_OCR_PAGE_COVERAGE_MISMATCH',
    sourceLineCount: 'GLM_OCR_RESPONSE_INVALID',
    sourceLineSequence: 'GLM_OCR_RESPONSE_INVALID',
    pageCoordinateCanonical: 'GLM_OCR_RESPONSE_INVALID',
    bboxCoordinateCanonical: 'GLM_OCR_RESPONSE_INVALID',
    roundedExtent: 'GLM_OCR_RESPONSE_INVALID'
  }
})

const EXPECTED_TOP_REQUIRED = Object.freeze([
  'version', 'sourceMode', 'provider', 'model', 'complete', 'expectedPageCount', 'metadata', 'pages'
])
const EXPECTED_METADATA_REQUIRED = Object.freeze([
  'adapterVersion', 'readingOrderVersion', 'tableParserVersion', 'canonicalizationVersion',
  'normalizationLimitsVersion', 'providerBboxNormalizationVersion', 'blankPagePolicyVersion',
  'coordinateSpace', 'render'
])
const EXPECTED_PAGE_REQUIRED = Object.freeze(['pageNumber', 'bounds', 'verifiedBlank', 'text', 'blocks'])
const EXPECTED_BLOCK_REQUIRED = Object.freeze([
  'text', 'charStart', 'charEnd', 'bbox', 'sourceBlockOrdinal', 'sourceLineOrdinal',
  'sourceLineCount', 'regionIndex', 'regionLabel', 'geometryGranularity', 'recordMembership', 'logicalTable'
])
const EXPECTED_CELL_REQUIRED = Object.freeze(['text', 'charStart', 'charEnd', 'cellOrdinal', 'cellCount', 'columnRole'])
const EXPECTED_LOGICAL_TABLE_REQUIRED = Object.freeze(['tableOrdinal', 'rowOrdinal', 'rowCount', 'cells'])
const NON_RECORD_LABELS = Object.freeze(['title', 'header', 'footer', 'caption', 'formula', 'figure_text'])
const REGION_LABELS = Object.freeze(['title', 'paragraph', 'list_item', 'table_row', 'header', 'footer', 'caption', 'formula', 'figure_text'])
const RECORD_MEMBERSHIPS = Object.freeze(['single-record', 'logical-table-row', 'non-record'])
const COLUMN_ROLES = Object.freeze(['sequence', 'date', 'institution', 'account_identity', 'currency', 'amount', 'status', 'query_reason', 'other'])
const SAFE_NORMALIZED_TEXT_PATTERN = "^(?![\\s\\S]*<\\s*\\/?\\s*[A-Za-z][^>]*>)(?![\\s\\S]*\\b[oO][nN][A-Za-z0-9_-]*\\s*=)(?![\\s\\S]*\\b(?:[hH][rR][eE][fF]|[sS][rR][cC]|[xX][lL][iI][nN][kK]:[hH][rR][eE][fF])\\s*=)(?![\\s\\S]*\\b[uU][rR][lL]\\s*\\()[^\\u0000]*$"

function add(errors, condition, code) {
  if (!condition) errors.push(code)
}

function exactKeys(errors, value, expected, code) {
  add(
    errors,
    value && typeof value === 'object' && !Array.isArray(value) && sameMembers(Object.keys(value), expected),
    code
  )
}

function validateContractObjectShapes(errors, contract) {
  exactKeys(errors, contract, [
    'schemaVersion', 'contractId', 'approvedDate', 'productionBaseline', 'implementationState',
    'targetProviders', 'authority', 'sourceRouting', 'terminalStatuses', 'factStates',
    'documentHardGate', 'inactiveScoring', 'executionBudgets', 'httpStatusPolicy',
    'normalizationLimits', 'coordinateConversion', 'blankPagePolicy', 'semanticValidation', 'errors',
    'publicFailureProtocol', 'cache', 'secrets', 'outboundData', 'rollback'
  ], 'contract.keys')
  exactKeys(errors, contract?.productionBaseline, ['gitCommit', 'webRelease', 'apiRelease'], 'contract.baseline-keys')
  exactKeys(errors, contract?.implementationState, [
    'phase', 'contractOnly', 'productionBehaviorChanged', 'glmClientImplemented',
    'ocrAdapterImplemented', 'reviewRequiredImplemented', 'productionRouteChanged', 'deployed'
  ], 'contract.implementation-keys')
  exactKeys(errors, contract?.targetProviders, ['ocr', 'factExtraction'], 'provider.keys')
  for (const provider of ['ocr', 'factExtraction']) {
    exactKeys(errors, contract?.targetProviders?.[provider], [
      'provider', 'model', 'endpoint', 'role', 'input', 'authoritative', 'automaticFallbackProviders'
    ].filter((key) => provider === 'ocr' || key !== 'input'), `provider.${provider}.keys`)
  }
  exactKeys(errors, contract?.authority, ['factAcceptance', 'derivedMetrics', 'score', 'modelSelfAttestationAllowed'], 'authority.keys')
  exactKeys(errors, contract?.sourceRouting, [
    'completeNativeTextPdf', 'scannedPdfOrImage', 'mixedNativeAndOcrWithinOneScannedDocument',
    'automaticFallbackProviders', 'forbiddenProductionOcrFallbacks'
  ], 'routing.keys')
  exactKeys(errors, contract?.sourceRouting?.completeNativeTextPdf, [
    'reader', 'glmCallCount', 'factExtractionProvider', 'legacyOcrFallbackAllowed'
  ], 'routing.native-keys')
  exactKeys(errors, contract?.sourceRouting?.scannedPdfOrImage, [
    'renderer', 'ocrProvider', 'ocrModel', 'wholeDocumentSingleOcrProvider', 'legacyOcrFallbackAllowed'
  ], 'routing.scanned-keys')
  exactKeys(errors, contract?.terminalStatuses, ['succeeded', 'review_required', 'failed'], 'status.keys')
  exactKeys(errors, contract?.terminalStatuses?.succeeded, [
    'documentHardGate', 'executionCompletion', 'evidenceArtifactIntegrity', 'reviewArtifactIntegrity',
    'factAndDecisionDependencies', 'authoritativeResult', 'scoreRiskMatchAdviceAllowed', 'cacheClass'
  ], 'status.succeeded-keys')
  exactKeys(errors, contract?.terminalStatuses?.review_required, [
    'documentHardGate', 'executionCompletion', 'evidenceArtifactIntegrity', 'reviewArtifactIntegrity',
    'onlyFieldOrMetricUnresolved', 'minimumAcceptedFactsRequired', 'factAndDecisionDependencies',
    'authoritativeResult', 'scoreRiskMatchAdviceAllowed', 'cacheClass'
  ], 'status.review-required-keys')
  exactKeys(errors, contract?.terminalStatuses?.failed, [
    'documentHardGate', 'executionCompletion', 'reviewArtifactIntegrity', 'failureCauses',
    'authoritativeResult', 'analysisNumbersAllowed', 'cacheClass'
  ], 'status.failed-keys')
  exactKeys(errors, contract?.documentHardGate, ['failureStatus', 'reviewProjectionAllowed', 'analysisNumbersAllowed', 'conditions'], 'hard-gate.keys')
  exactKeys(errors, contract?.inactiveScoring, ['approved', 'effect', 'implicitIncludeOrExcludeAllowed'], 'inactive.keys')
  exactKeys(errors, contract?.executionBudgets, ['targetFullAnalysisDeadlineMs', 'glmOcrPage', 'deepseekRequestOrChunk'], 'budget.keys')
  exactKeys(errors, contract?.executionBudgets?.glmOcrPage, [
    'unit', 'renderDpi', 'imageFormat', 'jpegQuality', 'maxPageBytes', 'defaultPageConcurrency',
    'productionPageConcurrency', 'codeHardConcurrencyCap', 'connectTimeoutMs', 'attemptTimeoutMs',
    'stageDeadlineMs', 'maxAttempts', 'maxAdditionalAttempts', 'retryNetworkFailures',
    'retryHttpStatuses', 'backoff'
  ], 'budget.glm.keys')
  exactKeys(errors, contract?.executionBudgets?.glmOcrPage?.backoff, [
    'strategy', 'fixedMs', 'retryAfterStatus', 'retryAfterCapMs'
  ], 'budget.glm.backoff-keys')
  exactKeys(errors, contract?.executionBudgets?.deepseekRequestOrChunk, [
    'unit', 'behavior', 'maxAttemptsDefault', 'maxAttemptsMinimum', 'maxAttemptsMaximum',
    'dedicatedConnectTimeoutMs', 'dedicatedAttemptTimeoutMs', 'currentDeepSeekDeadlineEnforced',
    'currentTransportBoundedOnly', 'backgroundCancellationGuarantee', 'targetFullAnalysisDeadlineMs',
    'retryNetworkFailures', 'retryHttpStatusRules', 'nonRetryHttpStatusRules', 'backoff',
    'chunkConcurrencyDefault', 'chunkConcurrencyMaximum'
  ], 'budget.deepseek.keys')
  exactKeys(errors, contract?.executionBudgets?.deepseekRequestOrChunk?.backoff, [
    'strategy', 'baseMs', 'formula'
  ], 'budget.deepseek.backoff-keys')
  exactKeys(errors, contract?.httpStatusPolicy, ['glmOcr', 'deepseek'], 'http.keys')
  for (const provider of ['glmOcr', 'deepseek']) {
    exactKeys(errors, contract?.httpStatusPolicy?.[provider], [
      'explicit', '4xxDefault', '5xxDefault', 'unclassified400To599Allowed'
    ], `http.${provider}.keys`)
  }
  exactKeys(errors, contract?.normalizationLimits, Object.keys(EXPECTED_HARD_LIMITS), 'normalization.keys')
  exactKeys(errors, contract?.coordinateConversion, Object.keys(EXPECTED_COORDINATE_CONVERSION), 'normalization.coordinate-keys')
  exactKeys(errors, contract?.blankPagePolicy, [
    'representation', 'requiresRenderedPagePresence', 'requiresProviderPagePresence',
    'requiresZeroNonEmptyRegions', 'requiresDeterministicBlankDetector', 'unprovenEmptyPageError'
  ], 'blank-page.keys')
  exactKeys(errors, contract?.semanticValidation, [
    'nonWhitespaceCoverageExactlyOnce', 'anyCharacterOverlapAllowed',
    'sourceLineCountMustMatchWithinSourceBlock', 'sourceLineOrdinalsMustBeUniqueAndContiguous',
    'internalCoordinatesMaxPrecisionDecimals', 'internalNegativeZeroAllowed',
    'internalFailureCodes', 'publicFailureMappings'
  ], 'semantic.keys')
  exactKeys(errors, contract?.semanticValidation?.internalFailureCodes, [
    'pageOverlap', 'sourceLineCount', 'sourceLineSequence', 'pageCoordinateCanonical',
    'bboxCoordinateCanonical', 'roundedExtent'
  ], 'semantic.internal-code-keys')
  exactKeys(errors, contract?.semanticValidation?.publicFailureMappings, [
    'pageOverlap', 'sourceLineCount', 'sourceLineSequence', 'pageCoordinateCanonical',
    'bboxCoordinateCanonical', 'roundedExtent'
  ], 'semantic.public-mapping-keys')
  for (const entry of Array.isArray(contract?.errors) ? contract.errors : []) {
    exactKeys(errors, entry, [
      'code', 'stage', 'provider', 'class', 'taskErrorClass', 'terminalStatus',
      'publicMessageKey', 'automaticRetrySameJob', 'sameInputNewJobCanRetry'
    ], 'errors.entry-keys')
  }
  exactKeys(errors, contract?.publicFailureProtocol, [
    'allowedTaskErrorClasses', 'forbiddenFallbackTaskErrorClass', 'terminalStatus',
    'allowedPublicMessageKeys', 'providerRawMessageAllowed'
  ], 'failure.keys')
  exactKeys(errors, contract?.cache, [
    'rawProviderResponseCrossRequestCache', 'rawProviderResponseCrossRunCache',
    'providerCandidateCrossRequestCache', 'providerCandidateCrossRunCache',
    'requestLocalTransientObjectsAreCache', 'authoritativeEligibility', 'reviewOnlyEligibility',
    'failureEligibility', 'authoritativeAndReviewNamespaceShared', 'crossTenantReuseAllowed',
    'crossVersionReuseAllowed', 'crossDocumentReuseAllowed'
  ], 'cache.keys')
  exactKeys(errors, contract?.secrets, [
    'manager', 'injection', 'frontend', 'healthExposure', 'providerFallbackCredentialsAllowed', 'variables'
  ], 'secrets.keys')
  exactKeys(errors, contract?.secrets?.frontend, [
    'secretValueExposureAllowed', 'retrievableProviderCredentialConfigAllowed', 'identifierNameMentionAllowed'
  ], 'secrets.frontend-keys')
  exactKeys(errors, contract?.secrets?.variables, ['zhipu', 'deepseek'], 'secrets.variable-keys')
  exactKeys(errors, contract?.outboundData, [
    'zhipu', 'deepseek', 'informedAuthorizationRequired', 'providerReviewRequiredBeforeEnablement',
    'downstreamEndUserPolicyCoverageMayBeAssumed', 'publicImageUrlAllowed', 'providerPayloadLoggingAllowed'
  ], 'outbound.keys')
  exactKeys(errors, contract?.rollback, ['fallbackToLegacyOcrAllowed', 'phase0', 'futureGlmEnablement', 'reviewRequired'], 'rollback.keys')
}

function expectedStage(code) {
  if (code === 'GLM_OCR_NOT_CONFIGURED') return 'ocr-config'
  if (code === 'GLM_OCR_INPUT_TOO_LARGE') return 'ocr-preflight'
  if (['GLM_OCR_RESPONSE_INVALID', 'GLM_OCR_PAGE_COVERAGE_MISMATCH', 'OCR_RECORD_MEMBERSHIP_UNPROVEN', 'OCR_READING_ORDER_CONFLICT'].includes(code)) return 'ocr-normalize'
  if (code.startsWith('GLM_') || code === 'OCR_STAGE_DEADLINE_EXCEEDED') return 'ocr-provider'
  if (code === 'DEEPSEEK_NOT_CONFIGURED') return 'fact-extraction-config'
  if (code === 'DEEPSEEK_INPUT_TOO_LARGE') return 'fact-extraction-preflight'
  if (code.startsWith('DEEPSEEK_')) return 'fact-extraction'
  return 'publication-gate'
}

function expectedProvider(code) {
  if (code.startsWith('DEEPSEEK_')) return 'deepseek'
  if (code === 'EVIDENCE_PUBLICATION_BLOCKED') return 'none'
  return 'zhipu'
}

function expectedDomainClass(taskClass) {
  if (typeof taskClass !== 'string') return ''
  if (taskClass.endsWith('_transient')) return 'transient'
  if (taskClass === 'configuration_permanent') return 'configuration'
  if (taskClass === 'input_permanent') return 'permanent'
  return 'evidence'
}

function mapHttpStatus(policy, status) {
  const explicit = policy?.explicit || {}
  if (Object.prototype.hasOwnProperty.call(explicit, String(status))) return explicit[String(status)]
  return status < 500 ? policy?.['4xxDefault'] : policy?.['5xxDefault']
}

function validateHttpPolicy(errors, contract, name, expectedExplicit, expected4xx, expected5xx) {
  const policy = contract.httpStatusPolicy?.[name]
  add(errors, deepEqual(policy?.explicit, expectedExplicit), `http.${name}.explicit`)
  add(errors, policy?.['4xxDefault'] === expected4xx, `http.${name}.4xx-default`)
  add(errors, policy?.['5xxDefault'] === expected5xx, `http.${name}.5xx-default`)
  add(errors, policy?.unclassified400To599Allowed === false, `http.${name}.closed`)
  for (let status = 400; status <= 599; status += 1) {
    const code = mapHttpStatus(policy, status)
    add(errors, EXPECTED_ERROR_CODES.includes(code), `http.${name}.status-${status}`)
  }
}

function validateContract(errors, contract) {
  validateContractObjectShapes(errors, contract)
  add(errors, contract?.schemaVersion === 2 && contract?.contractId === 'credit-analysis-phase0-v2', 'contract.identity')
  add(errors, contract?.productionBaseline?.gitCommit === 'abcdef1234567890abcdef1234567890abcdef12', 'contract.baseline.commit')
  add(errors, contract?.productionBaseline?.webRelease === '20260817-125147-evidence-v7-abcdef1-web', 'contract.baseline.web-release')
  add(errors, contract?.productionBaseline?.apiRelease === '20260817-125147-evidence-v7-abcdef1-api', 'contract.baseline.api-release')
  add(errors, contract?.implementationState?.phase === 0 && contract?.implementationState?.contractOnly === true, 'contract.phase0-only')
  for (const field of ['productionBehaviorChanged', 'glmClientImplemented', 'ocrAdapterImplemented', 'reviewRequiredImplemented', 'productionRouteChanged', 'deployed']) {
    add(errors, contract?.implementationState?.[field] === false, `contract.implementation.${field}`)
  }

  add(errors, contract?.targetProviders?.ocr?.provider === 'zhipu-layout-parsing' && contract?.targetProviders?.ocr?.model === 'glm-ocr' && contract?.targetProviders?.ocr?.role === 'scanned-page-layout-candidate-source' && contract?.targetProviders?.ocr?.input === 'in-memory-data-uri', 'provider.ocr.identity')
  add(errors, contract?.targetProviders?.ocr?.endpoint === 'https://open.bigmodel.cn/api/paas/v4/layout_parsing', 'provider.ocr.endpoint')
  add(errors, contract?.targetProviders?.factExtraction?.provider === 'deepseek' && contract?.targetProviders?.factExtraction?.model === 'deepseek-v4-flash' && contract?.targetProviders?.factExtraction?.endpoint === 'https://api.deepseek.com/v1/chat/completions' && contract?.targetProviders?.factExtraction?.role === 'candidate-fact-extraction', 'provider.deepseek.identity')
  add(errors, contract?.targetProviders?.ocr?.authoritative === false && contract?.targetProviders?.factExtraction?.authoritative === false, 'provider.non-authoritative')
  add(errors, deepEqual(contract?.targetProviders?.ocr?.automaticFallbackProviders, []) && deepEqual(contract?.targetProviders?.factExtraction?.automaticFallbackProviders, []), 'provider.no-fallback')
  add(errors, contract?.authority?.factAcceptance === 'evidence-binder' && contract?.authority?.derivedMetrics === 'deterministic-rules' && contract?.authority?.score === 'deterministic-rules', 'authority.components')
  add(errors, contract?.authority?.modelSelfAttestationAllowed === false, 'authority.no-model-self-attestation')

  const routing = contract?.sourceRouting
  add(errors, routing?.completeNativeTextPdf?.reader === 'mupdf' && routing?.completeNativeTextPdf?.glmCallCount === 0 && routing?.completeNativeTextPdf?.factExtractionProvider === 'deepseek', 'routing.native-zero-glm')
  add(errors, routing?.completeNativeTextPdf?.legacyOcrFallbackAllowed === false, 'routing.native-no-legacy-fallback')
  add(errors, sameMembers(routing?.scannedPdfOrImage?.renderer, ['mupdf', 'sharp']) && routing?.scannedPdfOrImage?.ocrProvider === 'zhipu-layout-parsing' && routing?.scannedPdfOrImage?.ocrModel === 'glm-ocr', 'routing.scanned-provider')
  add(errors, routing?.scannedPdfOrImage?.wholeDocumentSingleOcrProvider === true && routing?.scannedPdfOrImage?.legacyOcrFallbackAllowed === false, 'routing.scanned-no-hybrid-fallback')
  add(errors, routing?.mixedNativeAndOcrWithinOneScannedDocument === false, 'routing.no-mixed-source')
  add(errors, deepEqual(routing?.automaticFallbackProviders, []), 'routing.fallback-empty')
  add(errors, sameMembers(routing?.forbiddenProductionOcrFallbacks, FORBIDDEN_OCR_FALLBACKS), 'routing.forbidden-fallbacks')

  add(errors, sameMembers(Object.keys(contract?.terminalStatuses || {}), ['succeeded', 'review_required', 'failed']), 'status.closed-set')
  add(errors, contract?.terminalStatuses?.succeeded?.documentHardGate === 'passed' && contract?.terminalStatuses?.succeeded?.executionCompletion === 'complete' && contract?.terminalStatuses?.succeeded?.evidenceArtifactIntegrity === 'complete' && contract?.terminalStatuses?.succeeded?.reviewArtifactIntegrity === 'not-applicable' && contract?.terminalStatuses?.succeeded?.factAndDecisionDependencies === 'closed' && contract?.terminalStatuses?.succeeded?.authoritativeResult === true && contract?.terminalStatuses?.succeeded?.scoreRiskMatchAdviceAllowed === true && contract?.terminalStatuses?.succeeded?.cacheClass === 'authoritative', 'status.succeeded')
  add(errors, contract?.terminalStatuses?.review_required?.documentHardGate === 'passed' && contract?.terminalStatuses?.review_required?.executionCompletion === 'complete' && contract?.terminalStatuses?.review_required?.evidenceArtifactIntegrity === 'complete' && contract?.terminalStatuses?.review_required?.reviewArtifactIntegrity === 'complete' && contract?.terminalStatuses?.review_required?.onlyFieldOrMetricUnresolved === true && contract?.terminalStatuses?.review_required?.minimumAcceptedFactsRequired === false && contract?.terminalStatuses?.review_required?.factAndDecisionDependencies === 'partially-open' && contract?.terminalStatuses?.review_required?.authoritativeResult === false && contract?.terminalStatuses?.review_required?.scoreRiskMatchAdviceAllowed === false && contract?.terminalStatuses?.review_required?.cacheClass === 'review-only-v1', 'status.review-required')
  add(errors, contract?.terminalStatuses?.failed?.documentHardGate === 'failed-or-not-evaluable' && contract?.terminalStatuses?.failed?.executionCompletion === 'any' && contract?.terminalStatuses?.failed?.reviewArtifactIntegrity === 'incomplete-or-unavailable' && sameMembers(contract?.terminalStatuses?.failed?.failureCauses, ['document-hard-gate-failed', 'execution-incomplete', 'provider-error', 'schema-error', 'complete-review-artifact-unavailable']) && contract?.terminalStatuses?.failed?.authoritativeResult === false && contract?.terminalStatuses?.failed?.analysisNumbersAllowed === false && contract?.terminalStatuses?.failed?.cacheClass === 'none', 'status.failed')
  add(errors, sameMembers(contract?.factStates, ['accepted', 'unknown', 'absent', 'not_applicable', 'conflict']), 'facts.closed-set')
  add(errors, sameMembers(contract?.documentHardGate?.conditions, HARD_GATE_CONDITIONS), 'hard-gate.conditions')
  add(errors, contract?.documentHardGate?.failureStatus === 'failed' && contract?.documentHardGate?.reviewProjectionAllowed === false && contract?.documentHardGate?.analysisNumbersAllowed === false, 'hard-gate.effect')
  add(errors, contract?.inactiveScoring?.approved === false && contract?.inactiveScoring?.effect === 'block-dependent-metrics-score-risk-match-and-advice' && contract?.inactiveScoring?.implicitIncludeOrExcludeAllowed === false, 'inactive.blocked')

  const fullDeadline = contract?.executionBudgets?.targetFullAnalysisDeadlineMs
  const glm = contract?.executionBudgets?.glmOcrPage
  add(errors, fullDeadline === 900000, 'budget.full-analysis')
  add(errors, glm?.unit === 'rendered-page' && glm?.renderDpi === 200 && glm?.imageFormat === 'jpeg' && glm?.jpegQuality === 92 && glm?.maxPageBytes === 9437184, 'budget.glm.render')
  add(errors, glm?.defaultPageConcurrency === 3 && glm?.productionPageConcurrency === 3 && glm?.codeHardConcurrencyCap === 4, 'budget.glm.concurrency')
  add(errors, glm?.connectTimeoutMs === 15000 && glm?.attemptTimeoutMs === 120000 && glm?.stageDeadlineMs === 420000, 'budget.glm.timeouts')
  add(errors, glm?.maxAttempts === 2 && glm?.maxAdditionalAttempts === 1, 'budget.glm.attempts')
  add(errors, glm?.retryNetworkFailures === true && sameMembers(glm?.retryHttpStatuses, [408, 429, 500, 502, 503, 504]), 'budget.glm.retry-set')
  add(errors, glm?.backoff?.strategy === 'fixed-or-retry-after' && glm?.backoff?.fixedMs === 1000 && glm?.backoff?.retryAfterStatus === 429 && glm?.backoff?.retryAfterCapMs === 30000, 'budget.glm.backoff')

  const deepseek = contract?.executionBudgets?.deepseekRequestOrChunk
  add(errors, deepseek?.unit === 'request-or-chunk' && deepseek?.behavior === 'existing-verified-runtime-v1', 'budget.deepseek.behavior')
  add(errors, deepseek?.maxAttemptsDefault === 3 && deepseek?.maxAttemptsMinimum === 1 && deepseek?.maxAttemptsMaximum === 5, 'budget.deepseek.attempts')
  add(errors, deepseek?.dedicatedConnectTimeoutMs === null && deepseek?.dedicatedAttemptTimeoutMs === null && deepseek?.currentDeepSeekDeadlineEnforced === false && deepseek?.currentTransportBoundedOnly === true && deepseek?.backgroundCancellationGuarantee === false && deepseek?.targetFullAnalysisDeadlineMs === 900000, 'budget.deepseek.timeouts')
  add(errors, deepseek?.retryNetworkFailures === true && deepEqual(deepseek?.retryHttpStatusRules, ['429', '500-599']) && deepEqual(deepseek?.nonRetryHttpStatusRules, ['400-428', '430-499']), 'budget.deepseek.retry-set')
  add(errors, deepseek?.backoff?.strategy === 'linear-by-failed-attempt' && deepseek?.backoff?.baseMs === 800 && deepseek?.backoff?.formula === '800 * failedAttemptNumber', 'budget.deepseek.backoff')
  add(errors, deepseek?.chunkConcurrencyDefault === 3 && deepseek?.chunkConcurrencyMaximum === 4, 'budget.deepseek.concurrency')

  validateHttpPolicy(errors, contract, 'glmOcr', {
    400: 'GLM_OCR_BAD_REQUEST', 401: 'GLM_OCR_AUTH_FAILED', 403: 'GLM_OCR_FORBIDDEN',
    408: 'GLM_OCR_HTTP_408', 413: 'GLM_OCR_INPUT_TOO_LARGE', 429: 'GLM_OCR_RATE_LIMITED',
    500: 'GLM_OCR_PROVIDER_UNAVAILABLE', 502: 'GLM_OCR_PROVIDER_UNAVAILABLE',
    503: 'GLM_OCR_PROVIDER_UNAVAILABLE', 504: 'GLM_OCR_PROVIDER_UNAVAILABLE'
  }, 'GLM_OCR_CLIENT_ERROR', 'GLM_OCR_PROVIDER_ERROR')
  validateHttpPolicy(errors, contract, 'deepseek', {
    400: 'DEEPSEEK_BAD_REQUEST', 401: 'DEEPSEEK_AUTH_FAILED', 403: 'DEEPSEEK_FORBIDDEN',
    408: 'DEEPSEEK_HTTP_408', 409: 'DEEPSEEK_HTTP_409', 413: 'DEEPSEEK_INPUT_TOO_LARGE',
    422: 'DEEPSEEK_CONTEXT_LIMIT', 425: 'DEEPSEEK_HTTP_425', 429: 'DEEPSEEK_RATE_LIMITED'
  }, 'DEEPSEEK_CLIENT_ERROR', 'DEEPSEEK_PROVIDER_UNAVAILABLE')

  add(errors, deepEqual(contract?.normalizationLimits, EXPECTED_HARD_LIMITS), 'normalization.limits')
  add(errors, deepEqual(contract?.coordinateConversion, EXPECTED_COORDINATE_CONVERSION), 'normalization.coordinate-conversion')
  const blank = contract?.blankPagePolicy
  add(errors, blank?.representation === 'verifiedBlank=true,text-empty,blocks-empty' && blank?.requiresRenderedPagePresence === true && blank?.requiresProviderPagePresence === true && blank?.requiresZeroNonEmptyRegions === true && blank?.requiresDeterministicBlankDetector === true && blank?.unprovenEmptyPageError === 'GLM_OCR_PAGE_COVERAGE_MISMATCH', 'blank-page.policy')
  add(errors, deepEqual(contract?.semanticValidation, EXPECTED_SEMANTIC_VALIDATION), 'semantic.policy')

  const errorEntries = Array.isArray(contract?.errors) ? contract.errors : []
  const codes = errorEntries.map((entry) => entry?.code)
  add(errors, sameMembers(codes, EXPECTED_ERROR_CODES) && codes.length === new Set(codes).size, 'errors.closed-set')
  const autoRetry = errorEntries.filter((entry) => entry?.automaticRetrySameJob === true).map((entry) => entry.code)
  const newJobRetry = errorEntries.filter((entry) => entry?.sameInputNewJobCanRetry === true).map((entry) => entry.code)
  add(errors, sameMembers(autoRetry, AUTO_RETRY_CODES), 'errors.auto-retry-set')
  add(errors, sameMembers(newJobRetry, NEW_JOB_RETRY_CODES), 'errors.new-job-retry-set')
  for (const entry of errorEntries) {
    const code = entry?.code
    add(errors, TASK_CLASS_BY_CODE[code] === entry?.taskErrorClass, `errors.${code}.task-class`)
    add(errors, expectedDomainClass(TASK_CLASS_BY_CODE[code]) === entry?.class, `errors.${code}.domain-class`)
    add(errors, expectedStage(code) === entry?.stage, `errors.${code}.stage`)
    add(errors, expectedProvider(code) === entry?.provider, `errors.${code}.provider`)
    add(errors, entry?.terminalStatus === 'failed', `errors.${code}.terminal`)
    add(errors, PUBLIC_MESSAGE_BY_CODE[code] === entry?.publicMessageKey, `errors.${code}.public-message`)
  }
  const failure = contract?.publicFailureProtocol
  add(errors, sameMembers(failure?.allowedTaskErrorClasses, ['upstream_transient', 'transport_transient', 'evidence_permanent', 'schema_permanent', 'input_permanent', 'configuration_permanent', 'internal_permanent']), 'failure.allowed-classes')
  add(errors, failure?.forbiddenFallbackTaskErrorClass === 'unknown_permanent' && !errorEntries.some((entry) => entry?.taskErrorClass === 'unknown_permanent'), 'failure.no-unknown-permanent')
  add(errors, failure?.terminalStatus === 'failed' && sameMembers(failure?.allowedPublicMessageKeys, Object.keys(PUBLIC_MESSAGE_GROUPS)) && failure?.providerRawMessageAllowed === false, 'failure.public-protocol')

  const cache = contract?.cache
  for (const field of ['rawProviderResponseCrossRequestCache', 'rawProviderResponseCrossRunCache', 'providerCandidateCrossRequestCache', 'providerCandidateCrossRunCache', 'requestLocalTransientObjectsAreCache', 'authoritativeAndReviewNamespaceShared', 'crossTenantReuseAllowed', 'crossVersionReuseAllowed', 'crossDocumentReuseAllowed']) {
    add(errors, cache?.[field] === false, `cache.${field}`)
  }
  add(errors, deepEqual(cache?.authoritativeEligibility, ['succeeded']) && deepEqual(cache?.reviewOnlyEligibility, ['review_required']) && deepEqual(cache?.failureEligibility, []), 'cache.eligibility')

  const secrets = contract?.secrets
  add(errors, secrets?.manager === 'external-secret-manager' && secrets?.injection === 'server-process-environment', 'secrets.manager')
  add(errors, secrets?.variables?.zhipu === 'ZHIPU_GLM_OCR_API_KEY' && secrets?.variables?.deepseek === 'DEEPSEEK_API_KEY', 'secrets.variables')
  add(errors, secrets?.frontend?.secretValueExposureAllowed === false && secrets?.frontend?.retrievableProviderCredentialConfigAllowed === false && secrets?.frontend?.identifierNameMentionAllowed === true, 'secrets.frontend-boundary')
  add(errors, secrets?.healthExposure === 'configured-boolean-only', 'secrets.health-configured-only')
  add(errors, secrets?.providerFallbackCredentialsAllowed === false, 'secrets.no-provider-fallback')
  const outbound = contract?.outboundData
  add(errors, outbound?.zhipu === 'rendered-page-image-containing-personal-sensitive-credit-information' && outbound?.deepseek === 'normalized-credit-report-text-containing-personal-sensitive-credit-information' && outbound?.informedAuthorizationRequired === true && outbound?.providerReviewRequiredBeforeEnablement === true && outbound?.downstreamEndUserPolicyCoverageMayBeAssumed === false, 'outbound.review-required')
  add(errors, outbound?.publicImageUrlAllowed === false && outbound?.providerPayloadLoggingAllowed === false, 'outbound.no-public-payload')
  add(errors, contract?.rollback?.fallbackToLegacyOcrAllowed === false && contract?.rollback?.phase0 === 'revert-document-and-contract-commit' && contract?.rollback?.futureGlmEnablement === 'disable-scanned-analysis-capability-and-return-explicit-unavailable-error' && contract?.rollback?.reviewRequired === 'disable-review-projection-without-changing-authoritative-results', 'rollback.no-legacy-ocr')
}

function safePatternAccepts(pattern, value) {
  try { return new RegExp(pattern, 'u').test(value) } catch (_) { return false }
}

function validateSchema(errors, schema, contract) {
  exactKeys(errors, schema, ['$schema', '$id', 'title', 'description', 'type', 'additionalProperties', 'required', 'properties', '$defs'], 'schema.keys')
  add(errors, schema?.$schema === 'https://json-schema.org/draft/2020-12/schema' && schema?.$id === 'urn:reportflow:credit-analysis:ocr-structured-v1', 'schema.identity')
  add(errors, schema?.type === 'object' && schema?.additionalProperties === false && sameMembers(schema?.required, EXPECTED_TOP_REQUIRED), 'schema.top.required')
  exactKeys(errors, schema?.properties, EXPECTED_TOP_REQUIRED, 'schema.top.property-keys')
  add(errors, deepEqual(schema?.properties?.version, { const: 'ocr-structured-v1' }) && deepEqual(schema?.properties?.sourceMode, { const: 'ocr-structured' }) && deepEqual(schema?.properties?.provider, { const: 'zhipu-layout-parsing' }) && deepEqual(schema?.properties?.model, { const: 'glm-ocr' }), 'schema.top.constants')
  add(errors, deepEqual(schema?.properties?.complete, { type: 'boolean' }), 'schema.complete.type')
  add(errors, deepEqual(schema?.properties?.expectedPageCount, { type: 'integer', minimum: 1, maximum: 100 }), 'schema.expected-page-count')
  add(errors, deepEqual(schema?.properties?.metadata, { $ref: '#/$defs/metadata' }), 'schema.metadata-ref')
  add(errors, deepEqual(schema?.properties?.pages, { type: 'array', minItems: 1, maxItems: 100, items: { $ref: '#/$defs/page' } }), 'schema.pages-array')
  const defs = schema?.$defs || {}
  exactKeys(errors, defs, ['coordinate', 'pageExtent', 'bounds', 'pageBounds', 'safeText', 'safeBlockText', 'metadata', 'page', 'tableCell', 'logicalTable', 'block'], 'schema.defs.keys')
  add(errors, deepEqual(defs.coordinate, { type: 'number', minimum: 0, maximum: 20000 }), 'schema.coordinate-definition')
  add(errors, deepEqual(defs.pageExtent, { type: 'number', exclusiveMinimum: 0, maximum: 20000 }), 'schema.page-extent-definition')
  add(errors, deepEqual(defs.bounds, {
    type: 'array',
    prefixItems: [
      { $ref: '#/$defs/coordinate' }, { $ref: '#/$defs/coordinate' },
      { $ref: '#/$defs/pageExtent' }, { $ref: '#/$defs/pageExtent' }
    ],
    items: false, minItems: 4, maxItems: 4
  }), 'schema.bounds-definition')
  add(errors, deepEqual(defs.pageBounds, {
    type: 'array',
    prefixItems: [{ const: 0 }, { const: 0 }, { $ref: '#/$defs/pageExtent' }, { $ref: '#/$defs/pageExtent' }],
    items: false, minItems: 4, maxItems: 4
  }), 'schema.page-bounds-definition')
  add(errors, deepEqual(defs.safeText, { type: 'string', minLength: 0, maxLength: 1000000, pattern: SAFE_NORMALIZED_TEXT_PATTERN }), 'schema.safe-text.definition')
  add(errors, deepEqual(defs.safeBlockText, { type: 'string', minLength: 1, maxLength: 200000, pattern: SAFE_NORMALIZED_TEXT_PATTERN }), 'schema.safe-block-text.definition')

  add(errors, defs.metadata?.type === 'object' && defs.metadata?.additionalProperties === false && sameMembers(defs.metadata?.required, EXPECTED_METADATA_REQUIRED), 'schema.metadata.required')
  exactKeys(errors, defs.metadata?.properties, EXPECTED_METADATA_REQUIRED, 'schema.metadata.property-keys')
  add(errors, deepEqual(defs.metadata?.properties?.adapterVersion, { type: 'string', pattern: '^glm-layout-adapter-v[1-9][0-9]*$', maxLength: 64 }), 'schema.metadata.adapter-version')
  add(errors, deepEqual(defs.metadata?.properties?.readingOrderVersion, { type: 'string', pattern: '^ocr-reading-order-v[1-9][0-9]*$', maxLength: 64 }), 'schema.metadata.reading-version')
  add(errors, deepEqual(defs.metadata?.properties?.tableParserVersion, { type: 'string', pattern: '^ocr-table-parser-v[1-9][0-9]*$', maxLength: 64 }), 'schema.metadata.table-version')
  add(errors, deepEqual(defs.metadata?.properties?.canonicalizationVersion, { const: 'credit-ocr-canonical-json-v1' }), 'schema.metadata.canonicalization-version')
  add(errors, deepEqual(defs.metadata?.properties?.normalizationLimitsVersion, { const: 'ocr-normalization-limits-v1' }) && deepEqual(defs.metadata?.properties?.providerBboxNormalizationVersion, { const: 'glm-normalized-region-bbox-to-rendered-pixels-v1' }) && deepEqual(defs.metadata?.properties?.blankPagePolicyVersion, { const: 'verified-blank-page-v1' }), 'schema.metadata.versions')
  const coordinate = defs.metadata?.properties?.coordinateSpace
  add(errors, coordinate?.type === 'object' && coordinate?.additionalProperties === false && sameMembers(coordinate?.required, ['name', 'origin', 'xAxis', 'yAxis', 'boundsOrder', 'precisionDecimals']) && deepEqual(coordinate?.properties, {
    name: { const: 'rendered-image-pixels' }, origin: { const: 'top-left' }, xAxis: { const: 'right' },
    yAxis: { const: 'down' }, boundsOrder: { const: 'x0-y0-x1-y1' }, precisionDecimals: { const: 3 }
  }), 'schema.coordinate-space')
  const render = defs.metadata?.properties?.render
  add(errors, render?.type === 'object' && render?.additionalProperties === false && sameMembers(render?.required, ['engine', 'dpi', 'format', 'quality']) && deepEqual(render?.properties, {
    engine: { enum: ['mupdf', 'sharp'] }, dpi: { const: 200 }, format: { const: 'jpeg' }, quality: { const: 92 }
  }), 'schema.render-identity')

  add(errors, defs.page?.type === 'object' && defs.page?.additionalProperties === false && sameMembers(defs.page?.required, EXPECTED_PAGE_REQUIRED), 'schema.page.required')
  exactKeys(errors, defs.page?.properties, EXPECTED_PAGE_REQUIRED, 'schema.page.property-keys')
  add(errors, deepEqual(defs.page?.properties?.pageNumber, { type: 'integer', minimum: 1, maximum: 100 }), 'schema.page.number')
  add(errors, deepEqual(defs.page?.properties?.bounds, { $ref: '#/$defs/pageBounds' }), 'schema.page.bounds')
  add(errors, deepEqual(defs.page?.properties?.verifiedBlank, { type: 'boolean' }), 'schema.page.verified-blank-type')
  add(errors, deepEqual(defs.page?.properties?.text, { $ref: '#/$defs/safeText' }), 'schema.page.text-ref')
  add(errors, deepEqual(defs.page?.properties?.blocks, { type: 'array', minItems: 0, maxItems: 5000, items: { $ref: '#/$defs/block' } }), 'schema.page.blocks-array')
  const pageCondition = defs.page?.allOf
  add(errors, deepEqual(pageCondition, [{
    if: { properties: { verifiedBlank: { const: true } }, required: ['verifiedBlank'] },
    then: { properties: { text: { type: 'string', const: '' }, blocks: { type: 'array', maxItems: 0 } } },
    else: { properties: { text: { type: 'string', minLength: 1 }, blocks: { type: 'array', minItems: 1 } } }
  }]), 'schema.page.blank-condition')

  add(errors, defs.tableCell?.type === 'object' && defs.tableCell?.additionalProperties === false && sameMembers(defs.tableCell?.required, EXPECTED_CELL_REQUIRED), 'schema.cell.required-no-bbox')
  exactKeys(errors, defs.tableCell?.properties, EXPECTED_CELL_REQUIRED, 'schema.cell.property-keys')
  add(errors, deepEqual(defs.tableCell?.properties?.text, { $ref: '#/$defs/safeBlockText' }), 'schema.cell.text-ref')
  add(errors, deepEqual(defs.tableCell?.properties?.charStart, { type: 'integer', minimum: 0, maximum: 1000000 }) && deepEqual(defs.tableCell?.properties?.charEnd, { type: 'integer', minimum: 1, maximum: 1000000 }), 'schema.cell.char-limits')
  add(errors, deepEqual(defs.tableCell?.properties?.cellOrdinal, { type: 'integer', minimum: 1, maximum: 256 }) && deepEqual(defs.tableCell?.properties?.cellCount, { type: 'integer', minimum: 1, maximum: 256 }), 'schema.cell.ordinal-limits')
  add(errors, sameMembers(defs.tableCell?.properties?.columnRole?.enum, COLUMN_ROLES), 'schema.cell.column-role')

  add(errors, defs.logicalTable?.type === 'object' && defs.logicalTable?.additionalProperties === false && sameMembers(defs.logicalTable?.required, EXPECTED_LOGICAL_TABLE_REQUIRED) && defs.logicalTable?.$comment?.includes('OCR_RECORD_MEMBERSHIP_UNPROVEN'), 'schema.logical-table')
  exactKeys(errors, defs.logicalTable?.properties, EXPECTED_LOGICAL_TABLE_REQUIRED, 'schema.logical-table.property-keys')
  add(errors, deepEqual(defs.logicalTable?.properties?.tableOrdinal, { type: 'integer', minimum: 1, maximum: 1000 }), 'schema.logical-table.table-ordinal')
  add(errors, deepEqual(defs.logicalTable?.properties?.rowOrdinal, { type: 'integer', minimum: 1, maximum: 10000 }) && deepEqual(defs.logicalTable?.properties?.rowCount, { type: 'integer', minimum: 1, maximum: 10000 }), 'schema.logical-table.row-limits')
  add(errors, deepEqual(defs.logicalTable?.properties?.cells, { type: 'array', minItems: 1, maxItems: 256, items: { $ref: '#/$defs/tableCell' } }), 'schema.logical-table.cells-array')

  add(errors, defs.block?.type === 'object' && defs.block?.additionalProperties === false && sameMembers(defs.block?.required, EXPECTED_BLOCK_REQUIRED), 'schema.block.required')
  exactKeys(errors, defs.block?.properties, EXPECTED_BLOCK_REQUIRED, 'schema.block.property-keys')
  add(errors, deepEqual(defs.block?.properties?.text, { $ref: '#/$defs/safeBlockText' }), 'schema.block.text-ref')
  add(errors, deepEqual(defs.block?.properties?.charStart, { type: 'integer', minimum: 0, maximum: 1000000 }) && deepEqual(defs.block?.properties?.charEnd, { type: 'integer', minimum: 1, maximum: 1000000 }), 'schema.block.char-limits')
  add(errors, deepEqual(defs.block?.properties?.bbox, { $ref: '#/$defs/bounds' }) && deepEqual(defs.block?.properties?.geometryGranularity, { const: 'region' }), 'schema.block.geometry')
  for (const field of ['sourceBlockOrdinal', 'sourceLineOrdinal', 'sourceLineCount', 'regionIndex']) {
    add(errors, deepEqual(defs.block?.properties?.[field], { type: 'integer', minimum: 1, maximum: 10000 }), `schema.block.${field}-limits`)
  }
  add(errors, sameMembers(defs.block?.properties?.regionLabel?.enum, REGION_LABELS) && !defs.block?.properties?.regionLabel?.enum?.includes('unknown'), 'schema.block.region-label')
  add(errors, sameMembers(defs.block?.properties?.recordMembership?.enum, RECORD_MEMBERSHIPS), 'schema.block.record-membership')
  add(errors, deepEqual(defs.block?.properties?.logicalTable, { oneOf: [{ type: 'null' }, { $ref: '#/$defs/logicalTable' }] }), 'schema.block.logical-table-union')
  const blockConditions = defs.block?.allOf
  add(errors, deepEqual(blockConditions?.[0], {
    if: { properties: { regionLabel: { const: 'table_row' } }, required: ['regionLabel'] },
    then: { properties: { recordMembership: { const: 'logical-table-row' }, logicalTable: { $ref: '#/$defs/logicalTable' } } },
    else: { properties: { recordMembership: { enum: ['single-record', 'non-record'] }, logicalTable: { type: 'null' } } }
  }), 'schema.block.table-condition')
  add(errors, deepEqual(blockConditions?.[1], {
    if: { properties: { regionLabel: { enum: [...NON_RECORD_LABELS] } }, required: ['regionLabel'] },
    then: { properties: { recordMembership: { const: 'non-record' } } }
  }), 'schema.block.non-record-condition')
  add(errors, Array.isArray(blockConditions) && blockConditions.length === 2, 'schema.block.condition-count')
  add(errors, defs.page?.properties?.blocks?.maxItems === contract?.normalizationLimits?.regionsPerPageMax && defs.safeText?.maxLength === contract?.normalizationLimits?.pageTextMaxChars && defs.safeBlockText?.maxLength === contract?.normalizationLimits?.rawRegionContentMaxChars && defs.logicalTable?.properties?.rowCount?.maximum === contract?.normalizationLimits?.tableRowsPerRegionMax && defs.logicalTable?.properties?.cells?.maxItems === contract?.normalizationLimits?.tableCellsPerRowMax, 'schema.limit-parity')
  add(errors, defs.safeText?.pattern === SAFE_NORMALIZED_TEXT_PATTERN && defs.safeBlockText?.pattern === SAFE_NORMALIZED_TEXT_PATTERN, 'schema.safe-text.pattern-parity')
  const pattern = defs.safeText?.pattern
  const malicious = [
    '<SCRIPT>alert(1)</SCRIPT>', '<iFrAmE src=x>', '<OBJECT></OBJECT>', '<EmBeD>', '<STYLE></STYLE>', '<LiNk>',
    'ONCLICK=run', 'onload = run', 'href=https://outside.invalid', 'SRC = //outside.invalid', 'xlink:href=data:text/plain,x', 'URL(https://outside.invalid/x)'
  ]
  add(errors, safePatternAccepts(pattern, '普通征信文本 0 元') && malicious.every((value) => !safePatternAccepts(pattern, value)), 'schema.safe-text.security')
}

export function validatePhase0ContractBundle({ contract, schema }) {
  const errors = []
  validateContract(errors, contract)
  validateSchema(errors, schema, contract)
  return [...new Set(errors)]
}

function objectHasOnly(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key))
}

function markSpan(coverage, start, end) {
  for (let index = start; index < end; index += 1) coverage[index] += 1
}

function isCanonicalCoordinate(value) {
  if (!Number.isFinite(value) || Object.is(value, -0)) return false
  const rounded = Math.round(value * 1000) / 1000
  return Math.abs(value - rounded) <= Number.EPSILON * Math.max(1, Math.abs(value)) * 4
}

export function validateOcrStructuredDocument(document, schema, contract) {
  const errors = []
  const topAllowed = Object.keys(schema?.properties || {})
  add(errors, objectHasOnly(document, topAllowed) && schema.required.every((key) => Object.prototype.hasOwnProperty.call(document || {}, key)), 'ocr.top-shape')
  add(errors, document?.version === 'ocr-structured-v1' && document?.sourceMode === 'ocr-structured' && document?.provider === 'zhipu-layout-parsing' && document?.model === 'glm-ocr', 'ocr.identity')
  add(errors, document?.complete === true, 'ocr.complete')
  add(errors, Number.isInteger(document?.expectedPageCount) && document.expectedPageCount >= 1 && document.expectedPageCount <= 100 && document?.pages?.length === document.expectedPageCount, 'ocr.page-count')
  const metadata = document?.metadata
  add(errors, objectHasOnly(metadata, Object.keys(schema?.$defs?.metadata?.properties || {})) && schema.$defs.metadata.required.every((key) => Object.prototype.hasOwnProperty.call(metadata || {}, key)), 'ocr.metadata-shape')
  const metadataSchema = schema.$defs.metadata.properties
  add(errors, typeof metadata?.adapterVersion === 'string' && metadata.adapterVersion.length <= 64 && safePatternAccepts(metadataSchema.adapterVersion.pattern, metadata.adapterVersion), 'ocr.metadata-adapter-version')
  add(errors, typeof metadata?.readingOrderVersion === 'string' && metadata.readingOrderVersion.length <= 64 && safePatternAccepts(metadataSchema.readingOrderVersion.pattern, metadata.readingOrderVersion), 'ocr.metadata-reading-version')
  add(errors, typeof metadata?.tableParserVersion === 'string' && metadata.tableParserVersion.length <= 64 && safePatternAccepts(metadataSchema.tableParserVersion.pattern, metadata.tableParserVersion), 'ocr.metadata-table-version')
  add(errors, metadata?.canonicalizationVersion === 'credit-ocr-canonical-json-v1' && metadata?.normalizationLimitsVersion === 'ocr-normalization-limits-v1' && metadata?.providerBboxNormalizationVersion === 'glm-normalized-region-bbox-to-rendered-pixels-v1' && metadata?.blankPagePolicyVersion === 'verified-blank-page-v1', 'ocr.metadata-versions')
  add(errors, objectHasOnly(metadata?.coordinateSpace, Object.keys(metadataSchema.coordinateSpace.properties)) && metadata?.coordinateSpace?.name === 'rendered-image-pixels' && metadata?.coordinateSpace?.origin === 'top-left' && metadata?.coordinateSpace?.xAxis === 'right' && metadata?.coordinateSpace?.yAxis === 'down' && metadata?.coordinateSpace?.boundsOrder === 'x0-y0-x1-y1' && metadata?.coordinateSpace?.precisionDecimals === 3, 'ocr.coordinate-space')
  add(errors, objectHasOnly(metadata?.render, ['engine', 'dpi', 'format', 'quality']) && ['mupdf', 'sharp'].includes(metadata?.render?.engine) && metadata?.render?.dpi === 200 && metadata?.render?.format === 'jpeg' && metadata?.render?.quality === 92, 'ocr.render')
  const safePattern = schema?.$defs?.safeText?.pattern
  let documentChars = 0
  const tableRows = new Map()
  for (let pageIndex = 0; pageIndex < (document?.pages || []).length; pageIndex += 1) {
    const page = document.pages[pageIndex]
    add(errors, objectHasOnly(page, Object.keys(schema.$defs.page.properties)) && schema.$defs.page.required.every((key) => Object.prototype.hasOwnProperty.call(page || {}, key)), 'ocr.page-shape')
    add(errors, page?.pageNumber === pageIndex + 1 && page.pageNumber >= 1 && page.pageNumber <= 100, 'ocr.page-order')
    const bounds = page?.bounds
    const validBounds = Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite) && bounds[0] === 0 && bounds[1] === 0 && bounds[2] > 0 && bounds[3] > 0 && bounds[2] <= 20000 && bounds[3] <= 20000
    add(errors, validBounds, 'ocr.page-bounds')
    add(errors, Array.isArray(bounds) && bounds.every(isCanonicalCoordinate), 'ocr.page-coordinate-canonical')
    const text = typeof page?.text === 'string' ? page.text : ''
    documentChars += text.length
    add(errors, typeof page?.text === 'string' && text.length <= contract.normalizationLimits.pageTextMaxChars && safePatternAccepts(safePattern, text), 'ocr.text.safe')
    const blocks = Array.isArray(page?.blocks) ? page.blocks : []
    add(errors, Array.isArray(page?.blocks) && typeof page?.verifiedBlank === 'boolean', 'ocr.page-types')
    if (page?.verifiedBlank === true) {
      add(errors, text === '' && blocks.length === 0, 'ocr.blank-page')
      continue
    }
    add(errors, page?.verifiedBlank === false && text.length > 0 && blocks.length > 0, 'ocr.nonblank-page')
    add(errors, blocks.length <= contract.normalizationLimits.regionsPerPageMax, 'ocr.block-limit')
    const coverage = new Uint16Array(text.length)
    const regionIndexes = []
    const sourceGroups = new Map()
    let previousStart = -1
    let previousEnd = -1
    for (const block of blocks) {
      add(errors, objectHasOnly(block, Object.keys(schema.$defs.block.properties)) && schema.$defs.block.required.every((key) => Object.prototype.hasOwnProperty.call(block || {}, key)), 'ocr.block-shape')
      const start = block?.charStart
      const end = block?.charEnd
      const spanValid = Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= 1000000 && end > start && end <= 1000000 && end <= text.length && text.slice(start, end) === block?.text
      add(errors, spanValid, 'ocr.block-span')
      if (spanValid) markSpan(coverage, start, end)
      add(errors, typeof block?.text === 'string' && block.text.length >= 1 && block.text.length <= contract.normalizationLimits.rawRegionContentMaxChars && safePatternAccepts(safePattern, block.text), 'ocr.block-text')
      add(errors, previousStart < start || (previousStart === start && previousEnd <= end), 'ocr.reading-order')
      previousStart = start
      previousEnd = end
      regionIndexes.push(block?.regionIndex)
      const bbox = block?.bbox
      add(errors, validBounds && Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite) && bbox.every((value) => value >= 0 && value <= 20000) && bbox[2] > bbox[0] && bbox[3] > bbox[1] && bbox[2] <= bounds[2] && bbox[3] <= bounds[3], 'ocr.bbox')
      add(errors, Array.isArray(bbox) && bbox.every(isCanonicalCoordinate), 'ocr.bbox-coordinate-canonical')
      add(errors, block?.geometryGranularity === 'region', 'ocr.geometry-granularity')
      add(errors, Number.isInteger(block?.sourceBlockOrdinal) && block.sourceBlockOrdinal >= 1 && block.sourceBlockOrdinal <= 10000 && Number.isInteger(block?.sourceLineOrdinal) && Number.isInteger(block?.sourceLineCount) && block.sourceLineOrdinal >= 1 && block.sourceLineOrdinal <= 10000 && block.sourceLineCount >= 1 && block.sourceLineCount <= 10000 && block.sourceLineOrdinal <= block.sourceLineCount, 'ocr.source-line')
      if (Number.isInteger(block?.sourceBlockOrdinal)) {
        const members = sourceGroups.get(block.sourceBlockOrdinal) || []
        members.push({ lineOrdinal: block.sourceLineOrdinal, lineCount: block.sourceLineCount })
        sourceGroups.set(block.sourceBlockOrdinal, members)
      }
      add(errors, Number.isInteger(block?.regionIndex) && block.regionIndex >= 1 && block.regionIndex <= 10000, 'ocr.region-index-range')
      add(errors, REGION_LABELS.includes(block?.regionLabel), 'ocr.region-label')
      add(errors, RECORD_MEMBERSHIPS.includes(block?.recordMembership), 'ocr.record-membership')
      if (block?.regionLabel === 'table_row') {
        add(errors, block?.recordMembership === 'logical-table-row' && block?.logicalTable && typeof block.logicalTable === 'object', 'ocr.table-membership')
        const logical = block?.logicalTable
        if (logical && typeof logical === 'object') {
          add(errors, objectHasOnly(logical, Object.keys(schema.$defs.logicalTable.properties)) && schema.$defs.logicalTable.required.every((key) => Object.prototype.hasOwnProperty.call(logical, key)), 'ocr.table-shape')
          const cells = Array.isArray(logical.cells) ? logical.cells : []
          add(errors, Number.isInteger(logical.tableOrdinal) && logical.tableOrdinal >= 1 && logical.tableOrdinal <= 1000 && Number.isInteger(logical.rowOrdinal) && logical.rowOrdinal >= 1 && logical.rowOrdinal <= 10000 && Number.isInteger(logical.rowCount) && logical.rowCount >= 1 && logical.rowCount <= 10000 && cells.length >= 1 && cells.length <= 256, 'ocr.table-limits')
          const cellCoverage = new Uint16Array(Math.max(0, end - start))
          for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
            const cell = cells[cellIndex]
            add(errors, objectHasOnly(cell, Object.keys(schema.$defs.tableCell.properties)) && schema.$defs.tableCell.required.every((key) => Object.prototype.hasOwnProperty.call(cell || {}, key)), 'ocr.cell-shape')
            const cellSpan = Number.isInteger(cell?.charStart) && Number.isInteger(cell?.charEnd) && cell.charStart >= start && cell.charStart <= 1000000 && cell.charEnd > cell.charStart && cell.charEnd <= 1000000 && cell.charEnd <= end && text.slice(cell.charStart, cell.charEnd) === cell.text
            add(errors, cellSpan, 'ocr.cell-span')
            add(errors, cell?.cellOrdinal === cellIndex + 1 && cell?.cellCount === cells.length && cell.cellOrdinal <= 256 && cell.cellCount <= 256, 'ocr.cell-ordinal')
            add(errors, typeof cell?.text === 'string' && cell.text.length >= 1 && cell.text.length <= 200000 && safePatternAccepts(safePattern, cell.text), 'ocr.cell-text')
            add(errors, COLUMN_ROLES.includes(cell?.columnRole), 'ocr.column-role')
            if (cellSpan) markSpan(cellCoverage, cell.charStart - start, cell.charEnd - start)
          }
          for (let index = 0; index < block.text.length; index += 1) {
            if (/\S/u.test(block.text[index])) add(errors, cellCoverage[index] === 1, 'ocr.cell-coverage')
          }
          const key = `${page.pageNumber}:${logical.tableOrdinal}`
          const rows = tableRows.get(key) || []
          rows.push({ rowOrdinal: logical.rowOrdinal, rowCount: logical.rowCount })
          tableRows.set(key, rows)
        }
      } else {
        add(errors, block?.logicalTable === null && block?.recordMembership !== 'logical-table-row', 'ocr.non-table-logical-null')
        if (NON_RECORD_LABELS.includes(block?.regionLabel)) add(errors, block?.recordMembership === 'non-record', 'ocr.non-record-label')
      }
    }
    add(errors, regionIndexes.every((value, index) => value === index + 1), 'ocr.region-index')
    for (const members of sourceGroups.values()) {
      const counts = new Set(members.map((member) => member.lineCount))
      add(errors, counts.size === 1, 'ocr.source-line-count-consistency')
      const lineCount = counts.size === 1 ? members[0].lineCount : 0
      const ordinals = members.map((member) => member.lineOrdinal).sort((left, right) => left - right)
      add(errors, Number.isInteger(lineCount) && lineCount === members.length && ordinals.every((value, index) => value === index + 1), 'ocr.source-line-sequence')
    }
    for (let index = 0; index < text.length; index += 1) {
      add(errors, coverage[index] <= 1, 'ocr.page-overlap')
      if (/\S/u.test(text[index])) add(errors, coverage[index] === 1, 'ocr.page-coverage')
    }
  }
  for (const rows of tableRows.values()) {
    const ordered = [...rows].sort((left, right) => left.rowOrdinal - right.rowOrdinal)
    add(errors, ordered.every((row, index) => row.rowOrdinal === index + 1 && row.rowCount === ordered.length), 'ocr.table-row-ordinal')
  }
  add(errors, documentChars <= contract.normalizationLimits.documentTextMaxChars, 'ocr.document-limit')
  return [...new Set(errors)]
}

export function resolvePhase0DiffScope({ baselineSha, originMainSha, prBaseSha, baseRefName = 'main' }) {
  const shaPattern = /^[a-f0-9]{40}$/
  if (!shaPattern.test(String(baselineSha || '')) || baseRefName !== 'main') {
    return { ok: false, enforce: false, reason: 'phase0-base-unavailable' }
  }
  const candidates = [originMainSha, prBaseSha].filter((value) => value != null && String(value).trim())
  if (!candidates.length || candidates.some((value) => !shaPattern.test(String(value)))) {
    return { ok: false, enforce: false, reason: 'phase0-base-unavailable' }
  }
  if (new Set(candidates.map(String)).size !== 1) {
    return { ok: false, enforce: false, reason: 'phase0-base-mismatch' }
  }
  const baseSha = String(candidates[0])
  return { ok: true, enforce: baseSha === baselineSha, baseSha }
}

export function normalizeProviderPageBboxes(rawBboxes, renderedBounds, contract) {
  const errors = []
  const conversion = contract?.coordinateConversion
  add(errors, conversion?.providerInputMode === 'normalized-0-to-1-only' && conversion?.pageModeFixed === true, 'provider-bbox.mode')
  const boundsValid = Array.isArray(renderedBounds) && renderedBounds.length === 4 && renderedBounds[0] === 0 && renderedBounds[1] === 0 && Number.isFinite(renderedBounds[2]) && Number.isFinite(renderedBounds[3]) && renderedBounds[2] > 0 && renderedBounds[3] > 0 && renderedBounds[2] <= 20000 && renderedBounds[3] <= 20000
  add(errors, boundsValid, 'provider-bbox.rendered-bounds')
  add(errors, Array.isArray(rawBboxes) && rawBboxes.length <= contract?.normalizationLimits?.regionsPerPageMax, 'provider-bbox.region-limit')
  const normalized = []
  for (const raw of Array.isArray(rawBboxes) ? rawBboxes : []) {
    const valid = Array.isArray(raw) && raw.length === 4 && raw.every((value) => Number.isFinite(value) && value >= 0 && value <= 1) && raw[2] > raw[0] && raw[3] > raw[1]
    add(errors, valid, 'provider-bbox.normalized-range')
    if (!valid || !boundsValid) continue
    const values = [
      raw[0] * renderedBounds[2], raw[1] * renderedBounds[3],
      raw[2] * renderedBounds[2], raw[3] * renderedBounds[3]
    ].map((value) => {
      const rounded = Math.round(value * 1000) / 1000
      return Object.is(rounded, -0) ? 0 : rounded
    })
    const roundedValid = values.every(Number.isFinite) &&
      values.every((value) => !Object.is(value, -0)) &&
      values[0] >= 0 && values[1] >= 0 &&
      values[2] > values[0] && values[3] > values[1] &&
      values[2] <= renderedBounds[2] && values[3] <= renderedBounds[3]
    add(errors, roundedValid, 'provider-bbox.rounded-extent')
    if (roundedValid) normalized.push(values)
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)], bboxes: normalized }
}

function luhnValid(value) {
  const digits = String(value).split('').map(Number)
  let sum = 0
  let double = false
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits[index]
    if (double) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    double = !double
  }
  return sum % 10 === 0
}

export function detectPiiKinds(value) {
  const source = String(value || '')
  const kinds = new Set()
  if (/(?:^|\D)1[3-9]\d{9}(?:\D|$)/.test(source)) kinds.add('cn-mobile')
  if (/(?:^|\D)[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx](?:\D|$)/.test(source)) kinds.add('cn-id')
  const numericCandidates = source.match(/(?:^|\D)(\d{16,19})(?=\D|$)/g) || []
  if (numericCandidates.some((candidate) => {
    const digits = candidate.replace(/\D/g, '')
    return digits.length >= 16 && digits.length <= 19 && luhnValid(digits)
  })) kinds.add('payment-card')
  return [...kinds].sort()
}
