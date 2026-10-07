import {
  EXPECTED_ERROR_CODES,
  FORBIDDEN_OCR_FALLBACKS,
  HARD_GATE_CONDITIONS
} from './phase0-contract-validator.mjs'

export const contractMutationFixtures = Object.freeze([
  { name: 'native-glm-call', expected: 'routing.native-zero-glm', mutate: ({ contract }) => { contract.sourceRouting.completeNativeTextPdf.glmCallCount = 1 } },
  { name: 'native-legacy-fallback', expected: 'routing.native-no-legacy-fallback', mutate: ({ contract }) => { contract.sourceRouting.completeNativeTextPdf.legacyOcrFallbackAllowed = true } },
  { name: 'scanned-legacy-fallback', expected: 'routing.scanned-no-hybrid-fallback', mutate: ({ contract }) => { contract.sourceRouting.scannedPdfOrImage.legacyOcrFallbackAllowed = true } },
  { name: 'tesseract-fallback-removed-from-denylist', expected: 'routing.forbidden-fallbacks', mutate: ({ contract }) => { contract.sourceRouting.forbiddenProductionOcrFallbacks = contract.sourceRouting.forbiddenProductionOcrFallbacks.filter((value) => value !== 'tesseract') } },
  { name: 'automatic-fallback-added', expected: 'routing.fallback-empty', mutate: ({ contract }) => { contract.sourceRouting.automaticFallbackProviders.push('rapidocr') } },
  { name: 'deepseek-endpoint-drift', expected: 'provider.deepseek.identity', mutate: ({ contract }) => { contract.targetProviders.factExtraction.endpoint = 'https://example.invalid/v1' } },
  { name: 'ocr-provider-role-drift', expected: 'provider.ocr.identity', mutate: ({ contract }) => { contract.targetProviders.ocr.role = 'authoritative-ocr' } },
  { name: 'ocr-provider-input-drift', expected: 'provider.ocr.identity', mutate: ({ contract }) => { contract.targetProviders.ocr.input = 'public-url' } },
  { name: 'deepseek-provider-role-drift', expected: 'provider.deepseek.identity', mutate: ({ contract }) => { contract.targetProviders.factExtraction.role = 'authoritative-facts' } },
  { name: 'hard-gate-condition-removed', expected: 'hard-gate.conditions', mutate: ({ contract }) => { contract.documentHardGate.conditions.pop() } },
  { name: 'hard-gate-review-opened', expected: 'hard-gate.effect', mutate: ({ contract }) => { contract.documentHardGate.reviewProjectionAllowed = true } },
  { name: 'review-authoritative-cache', expected: 'status.review-required', mutate: ({ contract }) => { contract.terminalStatuses.review_required.cacheClass = 'authoritative' } },
  { name: 'review-artifact-integrity-open', expected: 'status.review-required', mutate: ({ contract }) => { contract.terminalStatuses.review_required.reviewArtifactIntegrity = 'incomplete' } },
  { name: 'review-minimum-accepted-invented', expected: 'status.review-required', mutate: ({ contract }) => { contract.terminalStatuses.review_required.minimumAcceptedFactsRequired = true } },
  { name: 'failed-review-artifact-marked-complete', expected: 'status.failed', mutate: ({ contract }) => { contract.terminalStatuses.failed.reviewArtifactIntegrity = 'complete' } },
  { name: 'succeeded-execution-incomplete', expected: 'status.succeeded', mutate: ({ contract }) => { contract.terminalStatuses.succeeded.executionCompletion = 'incomplete' } },
  { name: 'succeeded-document-gate-drift', expected: 'status.succeeded', mutate: ({ contract }) => { contract.terminalStatuses.succeeded.documentHardGate = 'failed' } },
  { name: 'succeeded-fact-dependencies-open', expected: 'status.succeeded', mutate: ({ contract }) => { contract.terminalStatuses.succeeded.factAndDecisionDependencies = 'partially-open' } },
  { name: 'succeeded-score-disabled', expected: 'status.succeeded', mutate: ({ contract }) => { contract.terminalStatuses.succeeded.scoreRiskMatchAdviceAllowed = false } },
  { name: 'review-document-gate-drift', expected: 'status.review-required', mutate: ({ contract }) => { contract.terminalStatuses.review_required.documentHardGate = 'failed' } },
  { name: 'review-fact-dependencies-closed', expected: 'status.review-required', mutate: ({ contract }) => { contract.terminalStatuses.review_required.factAndDecisionDependencies = 'closed' } },
  { name: 'review-score-enabled', expected: 'status.review-required', mutate: ({ contract }) => { contract.terminalStatuses.review_required.scoreRiskMatchAdviceAllowed = true } },
  { name: 'failed-authoritative-enabled', expected: 'status.failed', mutate: ({ contract }) => { contract.terminalStatuses.failed.authoritativeResult = true } },
  { name: 'failed-numbers-enabled', expected: 'status.failed', mutate: ({ contract }) => { contract.terminalStatuses.failed.analysisNumbersAllowed = true } },
  { name: 'failed-execution-overconstrained', expected: 'status.failed', mutate: ({ contract }) => { contract.terminalStatuses.failed.executionCompletion = 'incomplete-or-failed' } },
  { name: 'failed-provider-cause-removed', expected: 'status.failed', mutate: ({ contract }) => { contract.terminalStatuses.failed.failureCauses = contract.terminalStatuses.failed.failureCauses.filter((value) => value !== 'provider-error') } },
  { name: 'inactive-approved', expected: 'inactive.blocked', mutate: ({ contract }) => { contract.inactiveScoring.approved = true } },
  { name: 'inactive-effect-drift', expected: 'inactive.blocked', mutate: ({ contract }) => { contract.inactiveScoring.effect = 'exclude-without-blocking' } },
  { name: 'glm-attempts-expanded', expected: 'budget.glm.attempts', mutate: ({ contract }) => { contract.executionBudgets.glmOcrPage.maxAttempts = 3 } },
  { name: 'deepseek-page-unit-invented', expected: 'budget.deepseek.behavior', mutate: ({ contract }) => { contract.executionBudgets.deepseekRequestOrChunk.unit = 'page' } },
  { name: 'deepseek-timeout-invented', expected: 'budget.deepseek.timeouts', mutate: ({ contract }) => { contract.executionBudgets.deepseekRequestOrChunk.dedicatedAttemptTimeoutMs = 120000 } },
  { name: 'deepseek-deadline-falsely-enforced', expected: 'budget.deepseek.timeouts', mutate: ({ contract }) => { contract.executionBudgets.deepseekRequestOrChunk.currentDeepSeekDeadlineEnforced = true } },
  { name: 'deepseek-background-cancellation-falsely-guaranteed', expected: 'budget.deepseek.timeouts', mutate: ({ contract }) => { contract.executionBudgets.deepseekRequestOrChunk.backgroundCancellationGuarantee = true } },
  { name: 'deepseek-attempts-drift', expected: 'budget.deepseek.attempts', mutate: ({ contract }) => { contract.executionBudgets.deepseekRequestOrChunk.maxAttemptsDefault = 2 } },
  { name: 'glm-4xx-default-removed', expected: 'http.glmOcr.4xx-default', mutate: ({ contract }) => { delete contract.httpStatusPolicy.glmOcr['4xxDefault'] } },
  { name: 'glm-5xx-default-unknown', expected: 'http.glmOcr.5xx-default', mutate: ({ contract }) => { contract.httpStatusPolicy.glmOcr['5xxDefault'] = 'ANALYSIS_FAILED' } },
  { name: 'deepseek-4xx-default-removed', expected: 'http.deepseek.4xx-default', mutate: ({ contract }) => { delete contract.httpStatusPolicy.deepseek['4xxDefault'] } },
  { name: 'deepseek-5xx-mapping-drift', expected: 'http.deepseek.5xx-default', mutate: ({ contract }) => { contract.httpStatusPolicy.deepseek['5xxDefault'] = 'DEEPSEEK_CLIENT_ERROR' } },
  { name: 'error-code-removed', expected: 'errors.closed-set', mutate: ({ contract }) => { contract.errors.pop() } },
  { name: 'error-code-added', expected: 'errors.closed-set', mutate: ({ contract }) => { contract.errors.push({ ...contract.errors[0], code: 'UNREVIEWED_ERROR' }) } },
  { name: 'error-falls-to-unknown', expected: 'errors.GLM_OCR_BAD_REQUEST.task-class', mutate: ({ contract }) => { contract.errors.find((entry) => entry.code === 'GLM_OCR_BAD_REQUEST').taskErrorClass = 'unknown_permanent' } },
  { name: 'error-terminal-success', expected: 'errors.GLM_OCR_BAD_REQUEST.terminal', mutate: ({ contract }) => { contract.errors.find((entry) => entry.code === 'GLM_OCR_BAD_REQUEST').terminalStatus = 'succeeded' } },
  { name: 'error-public-message-drift', expected: 'errors.GLM_OCR_BAD_REQUEST.public-message', mutate: ({ contract }) => { contract.errors.find((entry) => entry.code === 'GLM_OCR_BAD_REQUEST').publicMessageKey = 'provider-raw-message' } },
  { name: 'error-auto-retry-expanded', expected: 'errors.auto-retry-set', mutate: ({ contract }) => { contract.errors.find((entry) => entry.code === 'GLM_OCR_BAD_REQUEST').automaticRetrySameJob = true } },
  { name: 'normalization-limit-removed', expected: 'normalization.limits', mutate: ({ contract }) => { delete contract.normalizationLimits.rawResponseMaxBytesPerPage } },
  { name: 'blank-page-policy-opened', expected: 'blank-page.policy', mutate: ({ contract }) => { contract.blankPagePolicy.requiresDeterministicBlankDetector = false } },
  { name: 'health-exposes-fingerprint', expected: 'secrets.health-configured-only', mutate: ({ contract }) => { contract.secrets.healthExposure = 'configured-and-fingerprint' } },
  { name: 'provider-review-disabled', expected: 'outbound.review-required', mutate: ({ contract }) => { contract.outboundData.providerReviewRequiredBeforeEnablement = false } },
  { name: 'outbound-zhipu-label-drift', expected: 'outbound.review-required', mutate: ({ contract }) => { contract.outboundData.zhipu = 'anonymous-image' } },
  { name: 'outbound-deepseek-label-drift', expected: 'outbound.review-required', mutate: ({ contract }) => { contract.outboundData.deepseek = 'anonymous-text' } },
  { name: 'downstream-policy-assumed', expected: 'outbound.review-required', mutate: ({ contract }) => { contract.outboundData.downstreamEndUserPolicyCoverageMayBeAssumed = true } },
  { name: 'frontend-secret-value-enabled', expected: 'secrets.frontend-boundary', mutate: ({ contract }) => { contract.secrets.frontend.secretValueExposureAllowed = true } },
  { name: 'unknown-top-level-runtime-implementation', expected: 'contract.keys', mutate: ({ contract }) => { contract.runtimeImplementation = {} } },
  { name: 'unknown-routing-production-fallback', expected: 'routing.keys', mutate: ({ contract }) => { contract.sourceRouting.productionOcrFallbacks = ['tesseract'] } },
  { name: 'unknown-secret-health-raw', expected: 'secrets.keys', mutate: ({ contract }) => { contract.secrets.healthRawSecretAllowed = true } },
  { name: 'unknown-cache-memory-raw', expected: 'cache.keys', mutate: ({ contract }) => { contract.cache.rawProviderResponseMemoryCache = true } },
  { name: 'unknown-error-provider-raw-message', expected: 'errors.entry-keys', mutate: ({ contract }) => { contract.errors[0].providerRawMessage = 'forbidden' } },
  { name: 'raw-html-script-added', expected: 'normalization.limits', mutate: ({ contract }) => { contract.normalizationLimits.rawHtmlAllowedTags.push('script') } },
  { name: 'raw-html-href-added', expected: 'normalization.limits', mutate: ({ contract }) => { contract.normalizationLimits.rawHtmlAllowedAttributes.push('href') } },
  { name: 'coordinate-absolute-mode-enabled', expected: 'normalization.coordinate-conversion', mutate: ({ contract }) => { contract.coordinateConversion.providerInputMode = 'normalized-or-absolute' } },
  { name: 'rounded-extent-check-disabled', expected: 'normalization.coordinate-conversion', mutate: ({ contract }) => { contract.coordinateConversion.postRoundingBoundsAndPositiveExtentRequired = false } },
  { name: 'semantic-overlap-enabled', expected: 'semantic.policy', mutate: ({ contract }) => { contract.semanticValidation.anyCharacterOverlapAllowed = true } },
  { name: 'semantic-source-lines-opened', expected: 'semantic.policy', mutate: ({ contract }) => { contract.semanticValidation.sourceLineOrdinalsMustBeUniqueAndContiguous = false } },
  { name: 'semantic-coordinate-precision-opened', expected: 'semantic.policy', mutate: ({ contract }) => { contract.semanticValidation.internalCoordinatesMaxPrecisionDecimals = 4 } },
  { name: 'semantic-negative-zero-opened', expected: 'semantic.policy', mutate: ({ contract }) => { contract.semanticValidation.internalNegativeZeroAllowed = true } },
  { name: 'rollback-legacy-enabled', expected: 'rollback.no-legacy-ocr', mutate: ({ contract }) => { contract.rollback.fallbackToLegacyOcrAllowed = true } },
  { name: 'rollback-phase0-drift', expected: 'rollback.no-legacy-ocr', mutate: ({ contract }) => { contract.rollback.phase0 = 'deploy-rollback' } },
  { name: 'rollback-glm-drift', expected: 'rollback.no-legacy-ocr', mutate: ({ contract }) => { contract.rollback.futureGlmEnablement = 'fallback-to-tesseract' } },
  { name: 'rollback-review-drift', expected: 'rollback.no-legacy-ocr', mutate: ({ contract }) => { contract.rollback.reviewRequired = 'promote-to-success' } },
  ...HARD_GATE_CONDITIONS.map((condition) => ({
    name: `hard-gate-remove-${condition}`,
    expected: 'hard-gate.conditions',
    mutate: ({ contract }) => { contract.documentHardGate.conditions = contract.documentHardGate.conditions.filter((value) => value !== condition) }
  })),
  ...FORBIDDEN_OCR_FALLBACKS.map((provider) => ({
    name: `fallback-denylist-remove-${provider}`,
    expected: 'routing.forbidden-fallbacks',
    mutate: ({ contract }) => { contract.sourceRouting.forbiddenProductionOcrFallbacks = contract.sourceRouting.forbiddenProductionOcrFallbacks.filter((value) => value !== provider) }
  })),
  ...EXPECTED_ERROR_CODES.map((code) => ({
    name: `error-remove-${code}`,
    expected: 'errors.closed-set',
    mutate: ({ contract }) => { contract.errors = contract.errors.filter((entry) => entry.code !== code) }
  })),
  ...[
    'rawResponseMaxBytesPerPage',
    'regionsPerPageMax',
    'rawRegionContentMaxChars',
    'htmlMaxBytesPerRegion',
    'htmlMaxNodesPerRegion',
    'htmlMaxDepth',
    'htmlMaxAttributesPerNode',
    'htmlMaxAttributeBytes',
    'tableRowsPerRegionMax',
    'tableCellsPerRowMax',
    'pageTextMaxChars',
    'documentTextMaxChars'
  ].map((field) => ({
    name: `normalization-limit-${field}`,
    expected: 'normalization.limits',
    mutate: ({ contract }) => { contract.normalizationLimits[field] += 1 }
  })),
  ...['providerInputMode', 'pageModeFixed', 'allRegionCoordinatesMustBeWithinInclusiveRange', 'normalizedXFormula', 'normalizedYFormula', 'roundingFormula', 'precisionDecimals', 'postRoundingBoundsAndPositiveExtentRequired', 'postRoundingFailureError', 'clampAllowed', 'axisSwapAllowed'].map((field) => ({
    name: `coordinate-conversion-${field}`,
    expected: 'normalization.coordinate-conversion',
    mutate: ({ contract }) => {
      contract.coordinateConversion[field] = typeof contract.coordinateConversion[field] === 'boolean'
        ? !contract.coordinateConversion[field]
        : typeof contract.coordinateConversion[field] === 'number'
          ? contract.coordinateConversion[field] + 1
          : 'drifted'
    }
  })),
  ...[
    'rawProviderResponseCrossRequestCache',
    'rawProviderResponseCrossRunCache',
    'providerCandidateCrossRequestCache',
    'providerCandidateCrossRunCache',
    'requestLocalTransientObjectsAreCache',
    'authoritativeAndReviewNamespaceShared',
    'crossTenantReuseAllowed',
    'crossVersionReuseAllowed',
    'crossDocumentReuseAllowed'
  ].map((field) => ({
    name: `cache-${field}`,
    expected: `cache.${field}`,
    mutate: ({ contract }) => { contract.cache[field] = true }
  }))
].map((fixture) => ({ machineSchemaReject: true, ...fixture })))

export const schemaMutationFixtures = Object.freeze([
  { name: 'top-required-complete-removed', expected: 'schema.top.required', mutate: ({ schema }) => { schema.required = schema.required.filter((value) => value !== 'complete') } },
  { name: 'metadata-coordinate-required-removed', expected: 'schema.metadata.required', mutate: ({ schema }) => { schema.$defs.metadata.required = schema.$defs.metadata.required.filter((value) => value !== 'coordinateSpace') } },
  { name: 'page-verified-blank-required-removed', expected: 'schema.page.required', mutate: ({ schema }) => { schema.$defs.page.required = schema.$defs.page.required.filter((value) => value !== 'verifiedBlank') } },
  { name: 'blank-page-condition-removed', expected: 'schema.page.blank-condition', mutate: ({ schema }) => { schema.$defs.page.allOf = [] } },
  { name: 'block-logical-table-required-removed', expected: 'schema.block.required', mutate: ({ schema }) => { schema.$defs.block.required = schema.$defs.block.required.filter((value) => value !== 'logicalTable') } },
  { name: 'table-condition-removed', expected: 'schema.block.table-condition', mutate: ({ schema }) => { schema.$defs.block.allOf.shift() } },
  { name: 'non-record-condition-removed', expected: 'schema.block.non-record-condition', mutate: ({ schema }) => { schema.$defs.block.allOf.pop() } },
  { name: 'header-record-condition-opened', expected: 'schema.block.non-record-condition', mutate: ({ schema }) => { schema.$defs.block.allOf[1].if.properties.regionLabel.enum = ['title'] } },
  { name: 'cell-bbox-added', expected: 'schema.cell.property-keys', mutate: ({ schema }) => { schema.$defs.tableCell.properties.bbox = { $ref: '#/$defs/bounds' } } },
  { name: 'active-markup-pattern-opened', expected: 'schema.safe-text.security', mutate: ({ schema }) => { schema.$defs.safeText.pattern = '^[^\\u0000]*$'; schema.$defs.safeBlockText.pattern = '^[^\\u0000]*$' } },
  { name: 'safe-pattern-parity-drift', expected: 'schema.safe-text.pattern-parity', mutate: ({ schema }) => { schema.$defs.safeBlockText.pattern = '^.*$' } },
  { name: 'coordinate-precision-drift', expected: 'schema.coordinate-space', mutate: ({ schema }) => { schema.$defs.metadata.properties.coordinateSpace.properties.precisionDecimals.const = 2 } },
  { name: 'schema-limit-drift', expected: 'schema.limit-parity', mutate: ({ schema }) => { schema.$defs.page.properties.blocks.maxItems = 6000 } },
  { name: 'complete-type-drift', expected: 'schema.complete.type', mutate: ({ schema }) => { schema.properties.complete.type = 'string' } },
  { name: 'region-label-unknown-added', expected: 'schema.block.region-label', mutate: ({ schema }) => { schema.$defs.block.properties.regionLabel.enum.push('unknown') } },
  { name: 'record-membership-unknown-added', expected: 'schema.block.record-membership', mutate: ({ schema }) => { schema.$defs.block.properties.recordMembership.enum.push('unknown') } },
  { name: 'column-role-unreviewed-added', expected: 'schema.cell.column-role', mutate: ({ schema }) => { schema.$defs.tableCell.properties.columnRole.enum.push('unreviewed') } },
  { name: 'adapter-version-pattern-opened', expected: 'schema.metadata.adapter-version', mutate: ({ schema }) => { schema.$defs.metadata.properties.adapterVersion.pattern = '^.*$' } },
  { name: 'reading-version-pattern-opened', expected: 'schema.metadata.reading-version', mutate: ({ schema }) => { schema.$defs.metadata.properties.readingOrderVersion.pattern = '^.*$' } },
  { name: 'table-version-pattern-opened', expected: 'schema.metadata.table-version', mutate: ({ schema }) => { schema.$defs.metadata.properties.tableParserVersion.pattern = '^.*$' } },
  { name: 'canonicalization-version-drift', expected: 'schema.metadata.canonicalization-version', mutate: ({ schema }) => { schema.$defs.metadata.properties.canonicalizationVersion.const = 'unreviewed' } },
  { name: 'render-engine-opened', expected: 'schema.render-identity', mutate: ({ schema }) => { schema.$defs.metadata.properties.render.properties.engine.enum.push('unknown') } },
  { name: 'render-dpi-drift', expected: 'schema.render-identity', mutate: ({ schema }) => { schema.$defs.metadata.properties.render.properties.dpi.const = 72 } },
  { name: 'render-format-drift', expected: 'schema.render-identity', mutate: ({ schema }) => { schema.$defs.metadata.properties.render.properties.format.const = 'png' } },
  { name: 'render-quality-drift', expected: 'schema.render-identity', mutate: ({ schema }) => { schema.$defs.metadata.properties.render.properties.quality.const = 80 } },
  { name: 'safe-block-max-drift', expected: 'schema.safe-block-text.definition', mutate: ({ schema }) => { schema.$defs.safeBlockText.maxLength = 300000 } },
  { name: 'safe-text-max-drift', expected: 'schema.safe-text.definition', mutate: ({ schema }) => { schema.$defs.safeText.maxLength = 2000000 } },
  { name: 'page-number-max-drift', expected: 'schema.page.number', mutate: ({ schema }) => { schema.$defs.page.properties.pageNumber.maximum = 101 } },
  { name: 'block-char-max-drift', expected: 'schema.block.char-limits', mutate: ({ schema }) => { schema.$defs.block.properties.charEnd.maximum = 2000000 } },
  { name: 'cell-char-max-drift', expected: 'schema.cell.char-limits', mutate: ({ schema }) => { schema.$defs.tableCell.properties.charEnd.maximum = 2000000 } },
  { name: 'cell-ordinal-max-drift', expected: 'schema.cell.ordinal-limits', mutate: ({ schema }) => { schema.$defs.tableCell.properties.cellOrdinal.maximum = 257 } },
  { name: 'table-ordinal-max-drift', expected: 'schema.logical-table.table-ordinal', mutate: ({ schema }) => { schema.$defs.logicalTable.properties.tableOrdinal.maximum = 1001 } },
  { name: 'table-row-max-drift', expected: 'schema.logical-table.row-limits', mutate: ({ schema }) => { schema.$defs.logicalTable.properties.rowCount.maximum = 10001 } },
  { name: 'table-cells-max-drift', expected: 'schema.logical-table.cells-array', mutate: ({ schema }) => { schema.$defs.logicalTable.properties.cells.maxItems = 257 } },
  { name: 'source-block-ordinal-max-drift', expected: 'schema.block.sourceBlockOrdinal-limits', mutate: ({ schema }) => { schema.$defs.block.properties.sourceBlockOrdinal.maximum = 10001 } },
  { name: 'source-line-ordinal-max-drift', expected: 'schema.block.sourceLineOrdinal-limits', mutate: ({ schema }) => { schema.$defs.block.properties.sourceLineOrdinal.maximum = 10001 } },
  { name: 'source-line-count-max-drift', expected: 'schema.block.sourceLineCount-limits', mutate: ({ schema }) => { schema.$defs.block.properties.sourceLineCount.maximum = 10001 } },
  { name: 'region-index-max-drift', expected: 'schema.block.regionIndex-limits', mutate: ({ schema }) => { schema.$defs.block.properties.regionIndex.maximum = 10001 } },
  { name: 'top-additional-properties-opened', expected: 'schema.top.required', mutate: ({ schema }) => { schema.additionalProperties = true } },
  { name: 'metadata-additional-properties-opened', expected: 'schema.metadata.required', mutate: ({ schema }) => { schema.$defs.metadata.additionalProperties = true } },
  { name: 'page-additional-properties-opened', expected: 'schema.page.required', mutate: ({ schema }) => { schema.$defs.page.additionalProperties = true } },
  { name: 'block-additional-properties-opened', expected: 'schema.block.required', mutate: ({ schema }) => { schema.$defs.block.additionalProperties = true } },
  { name: 'cell-additional-properties-opened', expected: 'schema.cell.required-no-bbox', mutate: ({ schema }) => { schema.$defs.tableCell.additionalProperties = true } },
  { name: 'logical-table-additional-properties-opened', expected: 'schema.logical-table', mutate: ({ schema }) => { schema.$defs.logicalTable.additionalProperties = true } }
])

export const contractSchemaCoDriftFixtures = Object.freeze([
  {
    name: 'provider-role-co-drift', expected: 'provider.ocr.identity',
    mutateSchema: (schema) => { schema.$defs.ocrProvider.allOf[1].properties.role.const = 'authoritative-ocr' },
    mutateContract: (contract) => { contract.targetProviders.ocr.role = 'authoritative-ocr' }
  },
  {
    name: 'provider-input-co-drift', expected: 'provider.ocr.identity',
    mutateSchema: (schema) => { schema.$defs.ocrProvider.allOf[1].properties.input.const = 'public-url' },
    mutateContract: (contract) => { contract.targetProviders.ocr.input = 'public-url' }
  },
  {
    name: 'succeeded-score-co-drift', expected: 'status.succeeded',
    mutateSchema: (schema) => { schema.$defs.succeededStatus.properties.scoreRiskMatchAdviceAllowed.const = false },
    mutateContract: (contract) => { contract.terminalStatuses.succeeded.scoreRiskMatchAdviceAllowed = false }
  },
  {
    name: 'review-dependency-co-drift', expected: 'status.review-required',
    mutateSchema: (schema) => { schema.$defs.reviewStatus.properties.factAndDecisionDependencies.const = 'closed' },
    mutateContract: (contract) => { contract.terminalStatuses.review_required.factAndDecisionDependencies = 'closed' }
  },
  {
    name: 'failed-authority-co-drift', expected: 'status.failed',
    mutateSchema: (schema) => { schema.$defs.failedStatus.properties.authoritativeResult.const = true },
    mutateContract: (contract) => { contract.terminalStatuses.failed.authoritativeResult = true }
  },
  {
    name: 'inactive-effect-co-drift', expected: 'inactive.blocked',
    mutateSchema: (schema) => { schema.$defs.inactiveScoring.properties.effect.const = 'exclude-without-blocking' },
    mutateContract: (contract) => { contract.inactiveScoring.effect = 'exclude-without-blocking' }
  },
  {
    name: 'outbound-label-co-drift', expected: 'outbound.review-required',
    mutateSchema: (schema) => { schema.$defs.outboundData.properties.zhipu.const = 'anonymous-image' },
    mutateContract: (contract) => { contract.outboundData.zhipu = 'anonymous-image' }
  },
  {
    name: 'rollback-co-drift', expected: 'rollback.no-legacy-ocr',
    mutateSchema: (schema) => { schema.$defs.rollback.properties.phase0.const = 'deploy-rollback' },
    mutateContract: (contract) => { contract.rollback.phase0 = 'deploy-rollback' }
  },
  {
    name: 'top-additional-property-co-drift', expected: 'contract.keys',
    mutateSchema: (schema) => { schema.additionalProperties = true },
    mutateContract: (contract) => { contract.runtimeImplementation = {} }
  }
])

function addSegment(state, text, block) {
  const charStart = state.text.length
  state.text += text
  const charEnd = state.text.length
  state.blocks.push({ ...block, text, charStart, charEnd })
  return { charStart, charEnd }
}

export function buildValidOcrDocument() {
  const state = { text: '', blocks: [] }
  addSegment(state, '征信报告\n', {
    bbox: [10, 10, 300, 30], sourceBlockOrdinal: 1, sourceLineOrdinal: 1, sourceLineCount: 1,
    regionIndex: 1, regionLabel: 'header', geometryGranularity: 'region', recordMembership: 'non-record', logicalTable: null
  })
  addSegment(state, '账户摘要\n', {
    bbox: [10, 40, 300, 60], sourceBlockOrdinal: 2, sourceLineOrdinal: 1, sourceLineCount: 1,
    regionIndex: 2, regionLabel: 'paragraph', geometryGranularity: 'region', recordMembership: 'non-record', logicalTable: null
  })
  const rowParts = ['1', '匿名机构', '人民币', '100']
  const rowStart = state.text.length
  const rowSpan = addSegment(state, `${rowParts.join('')}\n`, {
    bbox: [10, 70, 500, 100], sourceBlockOrdinal: 3, sourceLineOrdinal: 1, sourceLineCount: 1,
    regionIndex: 3, regionLabel: 'table_row', geometryGranularity: 'region', recordMembership: 'logical-table-row', logicalTable: null
  })
  let cellStart = rowStart
  const cells = rowParts.map((text, index) => {
    const cell = {
      text,
      charStart: cellStart,
      charEnd: cellStart + text.length,
      cellOrdinal: index + 1,
      cellCount: rowParts.length,
      columnRole: ['sequence', 'institution', 'currency', 'amount'][index]
    }
    cellStart += text.length
    return cell
  })
  state.blocks[2].logicalTable = { tableOrdinal: 1, rowOrdinal: 1, rowCount: 1, cells }
  state.blocks[2].charStart = rowSpan.charStart
  state.blocks[2].charEnd = rowSpan.charEnd
  return {
    version: 'ocr-structured-v1',
    sourceMode: 'ocr-structured',
    provider: 'zhipu-layout-parsing',
    model: 'glm-ocr',
    complete: true,
    expectedPageCount: 2,
    metadata: {
      adapterVersion: 'glm-layout-adapter-v1',
      readingOrderVersion: 'ocr-reading-order-v1',
      tableParserVersion: 'ocr-table-parser-v1',
      canonicalizationVersion: 'credit-ocr-canonical-json-v1',
      normalizationLimitsVersion: 'ocr-normalization-limits-v1',
      providerBboxNormalizationVersion: 'glm-normalized-region-bbox-to-rendered-pixels-v1',
      blankPagePolicyVersion: 'verified-blank-page-v1',
      coordinateSpace: {
        name: 'rendered-image-pixels', origin: 'top-left', xAxis: 'right', yAxis: 'down',
        boundsOrder: 'x0-y0-x1-y1', precisionDecimals: 3
      },
      render: { engine: 'mupdf', dpi: 200, format: 'jpeg', quality: 92 }
    },
    pages: [
      { pageNumber: 1, bounds: [0, 0, 600, 800], verifiedBlank: false, text: state.text, blocks: state.blocks },
      { pageNumber: 2, bounds: [0, 0, 600, 800], verifiedBlank: true, text: '', blocks: [] }
    ]
  }
}

export const ocrSemanticNegativeFixtures = Object.freeze([
  { name: 'page-count-mismatch', expected: 'ocr.page-count', mutate: (doc) => { doc.expectedPageCount = 3 } },
  { name: 'page-order-mismatch', expected: 'ocr.page-order', mutate: (doc) => { doc.pages[0].pageNumber = 2 } },
  { name: 'document-incomplete', expected: 'ocr.complete', mutate: (doc) => { doc.complete = false } },
  { name: 'uppercase-script', expected: 'ocr.block-text', mutate: (doc) => { doc.pages[0].blocks[1].text = '<ScRiPt>alert(1)</sCrIpT>' } },
  { name: 'mixed-case-iframe', expected: 'ocr.block-text', mutate: (doc) => { doc.pages[0].blocks[1].text = '<iFrAmE src=x>' } },
  { name: 'event-attribute', expected: 'ocr.block-text', mutate: (doc) => { doc.pages[0].blocks[1].text = 'ONCLICK=run' } },
  { name: 'external-link-attribute', expected: 'ocr.block-text', mutate: (doc) => { doc.pages[0].blocks[1].text = 'href=https://outside.invalid' } },
  { name: 'css-url', expected: 'ocr.block-text', mutate: (doc) => { doc.pages[0].blocks[1].text = 'URL(https://outside.invalid/x)' } },
  { name: 'bbox-outside-page', expected: 'ocr.bbox', mutate: (doc) => { doc.pages[0].blocks[0].bbox[2] = 700 } },
  { name: 'header-single-record', expected: 'ocr.non-record-label', mutate: (doc) => { doc.pages[0].blocks[0].recordMembership = 'single-record' } },
  { name: 'table-logical-missing', expected: 'ocr.table-membership', mutate: (doc) => { doc.pages[0].blocks[2].logicalTable = null } },
  { name: 'non-table-logical-added', expected: 'ocr.non-table-logical-null', mutate: (doc) => { doc.pages[0].blocks[1].logicalTable = doc.pages[0].blocks[2].logicalTable } },
  { name: 'cell-bbox-forbidden', expected: 'ocr.cell-shape', mutate: (doc) => { doc.pages[0].blocks[2].logicalTable.cells[0].bbox = [1, 1, 2, 2] } },
  { name: 'block-span-mismatch', expected: 'ocr.block-span', mutate: (doc) => { doc.pages[0].blocks[1].charEnd -= 1 } },
  { name: 'cell-span-mismatch', expected: 'ocr.cell-span', mutate: (doc) => { doc.pages[0].blocks[2].logicalTable.cells[1].charEnd += 1 } },
  { name: 'region-index-duplicate', expected: 'ocr.region-index', mutate: (doc) => { doc.pages[0].blocks[2].regionIndex = 2 } },
  { name: 'blank-page-has-text', expected: 'ocr.blank-page', mutate: (doc) => { doc.pages[1].text = '未证明为空' } },
  { name: 'unverified-page-empty', expected: 'ocr.nonblank-page', mutate: (doc) => { doc.pages[1].verifiedBlank = false } },
  { name: 'page-coverage-gap', expected: 'ocr.page-coverage', mutate: (doc) => { doc.pages[0].blocks.splice(1, 1); doc.pages[0].blocks[1].regionIndex = 2 } },
  { name: 'table-row-ordinal-gap', expected: 'ocr.table-row-ordinal', mutate: (doc) => { doc.pages[0].blocks[2].logicalTable.rowOrdinal = 2 } },
  { name: 'unknown-region-label', expected: 'ocr.region-label', mutate: (doc) => { doc.pages[0].blocks[1].regionLabel = 'unknown' } },
  { name: 'unreviewed-column-role', expected: 'ocr.column-role', mutate: (doc) => { doc.pages[0].blocks[2].logicalTable.cells[0].columnRole = 'unreviewed' } },
  { name: 'render-unknown-engine', expected: 'ocr.render', mutate: (doc) => { doc.metadata.render.engine = 'unknown' } },
  { name: 'render-72-dpi', expected: 'ocr.render', mutate: (doc) => { doc.metadata.render.dpi = 72 } },
  { name: 'render-png', expected: 'ocr.render', mutate: (doc) => { doc.metadata.render.format = 'png' } },
  { name: 'render-quality-drift', expected: 'ocr.render', mutate: (doc) => { doc.metadata.render.quality = 80 } },
  { name: 'block-over-200k', expected: 'ocr.block-text', mutate: (doc) => { doc.pages[0].blocks[1].text = 'A'.repeat(200001) } },
  { name: 'adapter-version-invalid', expected: 'ocr.metadata-adapter-version', mutate: (doc) => { doc.metadata.adapterVersion = 'adapter-latest' } },
  { name: 'reading-version-invalid', expected: 'ocr.metadata-reading-version', mutate: (doc) => { doc.metadata.readingOrderVersion = 'reading-latest' } },
  { name: 'table-version-invalid', expected: 'ocr.metadata-table-version', mutate: (doc) => { doc.metadata.tableParserVersion = 'table-latest' } },
  { name: 'canonicalization-version-invalid', expected: 'ocr.metadata-versions', mutate: (doc) => { doc.metadata.canonicalizationVersion = 'latest' } },
  { name: 'bbox-version-invalid', expected: 'ocr.metadata-versions', mutate: (doc) => { doc.metadata.providerBboxNormalizationVersion = 'latest' } },
  { name: 'source-block-ordinal-over-limit', expected: 'ocr.source-line', mutate: (doc) => { doc.pages[0].blocks[0].sourceBlockOrdinal = 10001 } },
  { name: 'region-index-over-limit', expected: 'ocr.region-index-range', mutate: (doc) => { doc.pages[0].blocks[2].regionIndex = 10001 } },
  { name: 'cell-ordinal-over-limit', expected: 'ocr.cell-ordinal', mutate: (doc) => { doc.pages[0].blocks[2].logicalTable.cells[0].cellOrdinal = 257 } },
  { name: 'table-ordinal-over-limit', expected: 'ocr.table-limits', mutate: (doc) => { doc.pages[0].blocks[2].logicalTable.tableOrdinal = 1001 } },
  { name: 'page-bounds-over-limit', expected: 'ocr.page-bounds', mutate: (doc) => { doc.pages[0].bounds[2] = 20001 } },
  { name: 'complete-type-invalid', expected: 'ocr.complete', mutate: (doc) => { doc.complete = 'true' } },
  { name: 'metadata-unknown-field', expected: 'ocr.metadata-shape', mutate: (doc) => { doc.metadata.unreviewed = true } },
  { name: 'block-unknown-field', expected: 'ocr.block-shape', mutate: (doc) => { doc.pages[0].blocks[0].unreviewed = true } },
  { name: 'blocks-array-over-limit', expected: 'ocr.block-limit', mutate: (doc) => { doc.pages[0].blocks = new Array(5001).fill(doc.pages[0].blocks[0]) } },
  { name: 'cells-array-over-limit', expected: 'ocr.table-limits', mutate: (doc) => { doc.pages[0].blocks[2].logicalTable.cells = new Array(257).fill(doc.pages[0].blocks[2].logicalTable.cells[0]) } },
  { name: 'whitespace-overlap', expected: 'ocr.page-overlap', mutate: (doc) => {
    const page = doc.pages[0]
    const newlineStart = page.blocks[0].charEnd - 1
    page.blocks.splice(1, 0, {
      ...page.blocks[0], text: '\n', charStart: newlineStart, charEnd: newlineStart + 1,
      sourceBlockOrdinal: 4, sourceLineOrdinal: 1, sourceLineCount: 1, regionIndex: 2
    })
    page.blocks.forEach((block, index) => { block.regionIndex = index + 1 })
  } },
  { name: 'source-line-duplicate-line1', expected: 'ocr.source-line-sequence', mutate: (doc) => {
    doc.pages[0].blocks[1].sourceBlockOrdinal = 1
    doc.pages[0].blocks[1].sourceLineOrdinal = 1
    doc.pages[0].blocks[1].sourceLineCount = 1
  } },
  { name: 'source-line-count-drift', expected: 'ocr.source-line-count-consistency', mutate: (doc) => {
    doc.pages[0].blocks[1].sourceBlockOrdinal = 1
    doc.pages[0].blocks[1].sourceLineOrdinal = 2
    doc.pages[0].blocks[1].sourceLineCount = 2
  } },
  { name: 'source-line-gap', expected: 'ocr.source-line-sequence', mutate: (doc) => {
    doc.pages[0].blocks[0].sourceLineCount = 3
    doc.pages[0].blocks[1].sourceBlockOrdinal = 1
    doc.pages[0].blocks[1].sourceLineOrdinal = 3
    doc.pages[0].blocks[1].sourceLineCount = 3
  } },
  { name: 'bbox-four-decimals', expected: 'ocr.bbox-coordinate-canonical', mutate: (doc) => { doc.pages[0].blocks[0].bbox[0] = 10.1234 } },
  { name: 'bbox-negative-zero', expected: 'ocr.bbox-coordinate-canonical', mutate: (doc) => { doc.pages[0].blocks[0].bbox[0] = -0 } },
  { name: 'page-bounds-four-decimals', expected: 'ocr.page-coordinate-canonical', mutate: (doc) => { doc.pages[0].bounds[2] = 600.1234 } },
  { name: 'page-bounds-negative-zero', expected: 'ocr.page-coordinate-canonical', mutate: (doc) => { doc.pages[0].bounds[0] = -0 } }
].map((fixture) => ({
  schemaReject: [
    'uppercase-script', 'mixed-case-iframe', 'event-attribute', 'external-link-attribute', 'css-url',
    'header-single-record', 'table-logical-missing', 'non-table-logical-added', 'cell-bbox-forbidden',
    'blank-page-has-text', 'unverified-page-empty', 'unknown-region-label', 'unreviewed-column-role',
    'render-unknown-engine', 'render-72-dpi', 'render-png', 'render-quality-drift', 'block-over-200k',
    'adapter-version-invalid', 'reading-version-invalid', 'table-version-invalid',
    'canonicalization-version-invalid', 'bbox-version-invalid', 'source-block-ordinal-over-limit',
    'region-index-over-limit', 'cell-ordinal-over-limit', 'table-ordinal-over-limit',
    'page-bounds-over-limit', 'complete-type-invalid', 'metadata-unknown-field', 'block-unknown-field',
    'blocks-array-over-limit', 'cells-array-over-limit'
  ].includes(fixture.name),
  ...fixture
})))

function syntheticEntropy(length, seed) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'
  let state = seed >>> 0
  let output = ''
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    output += alphabet[state % alphabet.length]
  }
  return output
}

function syntheticLetters(length, seed) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  let state = seed >>> 0
  let output = ''
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    output += alphabet[state % alphabet.length]
  }
  return output
}

function syntheticLowercase(length, seed) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz'
  let state = seed >>> 0
  let output = ''
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 22695477) + 1) >>> 0
    output += alphabet[state % alphabet.length]
  }
  return output
}

export const secretDetectionFixtures = Object.freeze([
  { name: 'zhipu-id-secret', expected: 'zhipu-id-secret', makeValue: () => `${syntheticEntropy(24, 11)}.${syntheticEntropy(48, 29)}` },
  { name: 'zhipu-letters-only-bare', expected: 'zhipu-id-secret', makeValue: () => `${syntheticLetters(24, 59)}.${syntheticLetters(48, 61)}` },
  { name: 'zhipu-lowercase-bare', expected: 'zhipu-id-secret', makeValue: () => `${syntheticLowercase(24, 73)}.${syntheticLowercase(48, 79)}` },
  { name: 'zhipu-letters-only-assignment', expected: 'zhipu-id-secret', makeValue: () => `ZHIPU_GLM_OCR_API_KEY=${syntheticLetters(24, 67)}.${syntheticLetters(48, 71)}` },
  { name: 'jwt', expected: 'jwt', makeValue: () => `eyJ${syntheticEntropy(16, 37)}.${syntheticEntropy(32, 41)}.${syntheticEntropy(40, 43)}` },
  { name: 'authorization', expected: 'authorization-high-entropy', makeValue: () => `Authorization: Bearer ${syntheticEntropy(56, 47)}` },
  { name: 'cookie', expected: 'cookie-high-entropy', makeValue: () => `Cookie: session=${syntheticEntropy(56, 53)}` },
  { name: 'percent-encoded-cookie', expected: 'cookie-high-entropy', makeValue: () => `Cookie: session=${encodeURIComponent(`${syntheticEntropy(40, 83)}+/=${syntheticEntropy(24, 89)}`)}` }
])

export const benignSecretFixtures = Object.freeze([
  'Authorization: Bearer ${token}',
  'Bearer test-token',
  'ZHIPU_GLM_OCR_API_KEY=',
  'https://open.bigmodel.cn/api/paas/v4/layout_parsing',
  'https://documentation.example.com/versioning/reference',
  'credit-analysis-v14.global-card-binding-v7',
  'exampledocumentation.domainconfiguration',
  'documentationarchitectureanalysis.configurationmanagementreference',
  'releaseversiondocumentation.contractversiondocumentation'
])

export const piiDetectionFixtures = Object.freeze([
  { name: 'cn-mobile', expected: 'cn-mobile', makeValue: () => ['138', '0013', '8000'].join('') },
  { name: 'cn-id', expected: 'cn-id', makeValue: () => ['110105', '19491231', '002X'].join('') },
  { name: 'payment-card', expected: 'payment-card', makeValue: () => ['4111', '1111', '1111', '1111'].join('') }
])

export const validProviderBboxFixture = Object.freeze({
  rawBboxes: [[0.1, 0.2, 0.5, 0.6]],
  renderedBounds: [0, 0, 600, 800],
  expected: [[60, 160, 300, 480]]
})

export const providerBboxNegativeFixtures = Object.freeze([
  { name: 'absolute-coordinate-rejected', rawBboxes: [[10, 20, 50, 60]], expected: 'provider-bbox.normalized-range' },
  { name: 'mixed-page-mode-rejected', rawBboxes: [[0.1, 0.2, 0.5, 0.6], [10, 20, 50, 60]], expected: 'provider-bbox.normalized-range' },
  { name: 'over-one-rejected', rawBboxes: [[0.1, 0.2, 1.1, 0.6]], expected: 'provider-bbox.normalized-range' },
  { name: 'negative-rejected', rawBboxes: [[-0.1, 0.2, 0.5, 0.6]], expected: 'provider-bbox.normalized-range' },
  { name: 'reversed-rejected', rawBboxes: [[0.5, 0.2, 0.1, 0.6]], expected: 'provider-bbox.normalized-range' },
  { name: 'nonfinite-rejected', rawBboxes: [[0.1, 0.2, Number.NaN, 0.6]], expected: 'provider-bbox.normalized-range' },
  { name: 'rounded-x-collapse-rejected', rawBboxes: [[0.10001, 0.2, 0.10002, 0.3]], renderedBounds: [0, 0, 1, 1], expected: 'provider-bbox.rounded-extent' },
  { name: 'rounded-y-collapse-rejected', rawBboxes: [[0.1, 0.20001, 0.2, 0.20002]], renderedBounds: [0, 0, 1, 1], expected: 'provider-bbox.rounded-extent' },
  { name: 'oversize-rendered-bounds-rejected', rawBboxes: [[0.1, 0.2, 0.5, 0.6]], renderedBounds: [0, 0, 20001, 1], expected: 'provider-bbox.rendered-bounds' }
])
