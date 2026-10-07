'use strict'

const crypto = require('crypto')
const store = require('../db/store')
const logger = require('../utils/logger')
const { sanitizeAnalysisFailureDiagnostic } = require('../utils/analysisFailureDiagnostic')
const {
	buildTrustedTerminalEvent,
	normalizeTerminalCode,
	terminalCodeDefinition
} = require('../utils/trustedAnalysisEvent')
const {
	analysisVersions,
	buildAnalysisIdentity,
	buildArtifactHash,
	buildResultHash,
	identityRuntimeStatus,
	stableStringify
} = require('./analysisIdentity')
const {
	stableCanonicalize,
	evaluatePublicationGate
} = require('./creditEvidenceLedger')
const {
	parseQueryDateMs,
	countQueriesByWindow,
	summarizeHardQueryBursts
} = require('./queryWindowPolicy')
const {
	calculatePrimaryRuleScore
} = require('../scoringAlgorithms.cjs')

const memoryCache = new Map()
const inFlight = new Map()
let warnedAboutMemoryOnly = false
let lastCleanupAt = 0
const MIN_CACHE_SECRET_BYTES = 32
const DEFAULT_MEMORY_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_MEMORY_MAX_ENTRIES = 128
const DEFAULT_MAX_RESULT_BYTES = 2 * 1024 * 1024
const PERSISTED_IDENTITY_SCHEMA = 'rpt.analysis-cache-binding/1.0'
const REQUIRED_NUMERIC_RESULT_PATHS = Object.freeze([
	'credit_debt.total_debt',
	'credit_debt.credit_loans.total_balance',
	'credit_debt.credit_cards.total_limit',
	'credit_debt.credit_cards.total_used',
	'credit_debt.credit_cards.utilization_used',
	'credit_debt.credit_cards.usage_rate',
	'credit_debt.credit_cards.shared_group_count',
	'query_analysis.summary.last_1m.total',
	'query_analysis.summary.last_3m.total',
	'query_analysis.summary.last_6m.total',
	'query_analysis.summary.last_12m.total',
	'primary_rule_score.score'
])
const AUTHORITATIVE_SCOPE_FIELDS = Object.freeze([
	'credit_debt.total_debt',
	'credit_debt.credit_loans.total_balance',
	'credit_debt.credit_cards.total_limit',
	'credit_debt.credit_cards.total_used',
	'credit_debt.credit_cards.utilization_used',
	'credit_debt.credit_cards.usage_rate',
	'credit_debt.credit_cards.shared_group_count',
	'query_analysis.summary.last_1m.total',
	'query_analysis.summary.last_3m.total',
	'query_analysis.summary.last_6m.total',
	'query_analysis.summary.last_12m.total',
	'primary_rule_score.score'
])
const CURRENT_EVIDENCE_VERSION_FIELDS = Object.freeze([
	'evidenceContract',
	'evidenceBinder',
	'evidenceHash',
	'sharedCreditPolicy'
])

const TRANSIENT_UPSTREAM_ERROR_CODES = new Set([
	'ANALYSIS_OUTPUT_TRUNCATED',
	'ANALYSIS_NON_JSON_OUTPUT'
])
const STATUS_AWARE_UPSTREAM_ERROR_CODES = new Set([
	'ANALYSIS_UPSTREAM_FAILED',
	'OCR_UPSTREAM_FAILED'
])
const TRANSIENT_TRANSPORT_ERROR_CODES = new Set([
	'ANALYSIS_IN_PROGRESS_TIMEOUT',
	'ANALYSIS_LEASE_LOST',
	'ECONNRESET',
	'ECONNREFUSED',
	'ETIMEDOUT',
	'EAI_AGAIN',
	'ENETUNREACH',
	'EPIPE',
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_HEADERS_TIMEOUT',
	'UND_ERR_SOCKET'
])
const CONFIGURATION_ERROR_CODES = new Set([
	'ANALYSIS_TASK_PERSISTENCE_UNAVAILABLE',
	'ANALYSIS_SCOPE_REQUIRED',
	'EVIDENCE_HASH_KEY_REQUIRED'
])
const INTERNAL_PERMANENT_ERROR_CODES = new Set([
	'ANALYSIS_RESULT_UNAVAILABLE',
	'INVALID_CANONICAL_RESULT',
	'NON_AUTHORITATIVE_RESULT',
	'INCOMPLETE_CANONICAL_RESULT',
	'CANONICAL_RESULT_TOO_LARGE',
	'DETERMINISTIC_RULE_ENGINE_FAILED'
])

function normalizedAnalysisErrorCode(errorOrCode) {
	const raw = typeof errorOrCode === 'string'
		? errorOrCode
		: errorOrCode && errorOrCode.code
	return normalizeTerminalCode(raw)
}

/**
 * Retry is deny-by-default. Only explicit network/lease/upstream outcomes are
 * eligible; evidence, schema and deterministic failures for the same
 * analysisKey must not trigger another blind model run.
 */
function classifyAnalysisError(errorOrCode) {
	const code = normalizedAnalysisErrorCode(errorOrCode)
	if (TRANSIENT_UPSTREAM_ERROR_CODES.has(code)) {
		return { code, errorClass: 'upstream_transient', retryable: true }
	}
	if (STATUS_AWARE_UPSTREAM_ERROR_CODES.has(code)) {
		const rawStatus = errorOrCode && typeof errorOrCode === 'object' && errorOrCode.httpStatus
		const status = typeof rawStatus === 'number' ? rawStatus : Number.NaN
		const transientStatus = status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
		return transientStatus
			? { code, errorClass: 'upstream_transient', retryable: true }
			: { code, errorClass: 'configuration_permanent', retryable: false }
	}
	if (TRANSIENT_TRANSPORT_ERROR_CODES.has(code)) {
		return { code, errorClass: 'transport_transient', retryable: true }
	}
	if (CONFIGURATION_ERROR_CODES.has(code)) {
		return { code, errorClass: 'configuration_permanent', retryable: false }
	}
	if (/^EVIDENCE_[A-Z0-9_]+$/.test(code) || code === 'QUERY_EVIDENCE_INCOMPLETE') {
		return { code, errorClass: 'evidence_permanent', retryable: false }
	}
	if (
		code === 'FACT_SCHEMA_INVALID' ||
		/^CHUNK_[A-Z0-9_]+$/.test(code) ||
		/^DETERMINISTIC_[A-Z0-9_]+$/.test(code)
	) {
		return { code, errorClass: 'schema_permanent', retryable: false }
	}
	if (
		code === 'ANALYSIS_INPUT_TOO_LARGE' ||
		code === 'ANALYSIS_CONTEXT_LIMIT' ||
		code === 'INVALID_PDF' ||
		code === 'PDF_TEXT_LAYER_MISSING' ||
		code === 'PDF_EVIDENCE_SOURCE_UNVERIFIED' ||
		code === 'OCR_STRUCTURED_EVIDENCE_UNAVAILABLE' ||
		code === 'OCR_TEXT_TOO_SHORT' ||
		code === 'OCR_FAILED' ||
		code === 'OCR_INCOMPLETE' ||
		code === 'RAPIDOCR_FAILED' ||
		code === 'IMAGE_OCR_INCOMPLETE' ||
		code === 'IMAGE_TEXT_TOO_SHORT' ||
		code === 'ANALYSIS_TASK_INPUT_INVALID' ||
		code === 'ANALYSIS_TASK_SCOPE_INVALID'
	) {
		return { code, errorClass: 'input_permanent', retryable: false }
	}
	if (INTERNAL_PERMANENT_ERROR_CODES.has(code)) {
		return { code, errorClass: 'internal_permanent', retryable: false }
	}
	const closed = terminalCodeDefinition(code)
	return {
		code: closed.code,
		errorClass: closed.errorClass,
		retryable: closed.retryable
	}
}

function diagnosticCount(value) {
	const number = typeof value === 'number' ? value : Number.NaN
	if (!Number.isFinite(number)) return undefined
	return Math.min(1000000, Math.max(0, Math.trunc(number)))
}

function buildSafeAnalysisFailureDiagnostic(error) {
	const diagnostic = { version: 1 }
	const sources = [
		error,
		error && error.analysisDiagnostic,
		error && error.diagnostic
	].filter((value) => value && typeof value === 'object' && !Array.isArray(value))
	const sanitizedNestedSources = [
		error && error.diagnostic,
		error && error.analysisDiagnostic,
		error
	]
		.filter((value) => value && typeof value === 'object' && !Array.isArray(value))
		.map((source) => sanitizeAnalysisFailureDiagnostic(source))
	const scalarKeys = [
		'httpStatus', 'expectedCount', 'actualCount', 'failedCheckCount',
		'evidenceIssueCount', 'coverageIssueCount', 'failedPageCount', 'totalPageCount'
	]
	for (const source of sources) {
		for (const key of scalarKeys) {
			if (Object.prototype.hasOwnProperty.call(diagnostic, key)) continue
			const count = diagnosticCount(source[key])
			if (count !== undefined) diagnostic[key] = count
		}
	}
	const failedCheckSources = [
		error && error.failedChecks,
		error && error.diagnostic && error.diagnostic.failedChecks,
		error && error.analysisDiagnostic && error.analysisDiagnostic.failedChecks
	]
	for (const values of failedCheckSources) {
		if (!Array.isArray(values)) continue
		const safeChecks = sanitizeAnalysisFailureDiagnostic({ failedChecks: values }).failedChecks
		if (!safeChecks || !safeChecks.length) continue
		diagnostic.failedChecks = safeChecks
		break
	}
	if (diagnostic.failedCheckCount === undefined && Array.isArray(diagnostic.failedChecks)) {
		diagnostic.failedCheckCount = diagnosticCount(diagnostic.failedChecks.length)
	}
	if (diagnostic.coverageIssueCount === undefined && Array.isArray(error && error.coverageIssues)) {
		diagnostic.coverageIssueCount = diagnosticCount(error.coverageIssues.length)
	}
	if (diagnostic.failedPageCount === undefined && Array.isArray(error && error.failedPages)) {
		diagnostic.failedPageCount = diagnosticCount(error.failedPages.length)
	}
	if (diagnostic.totalPageCount === undefined) {
		const totalPages = diagnosticCount(error && error.totalPages)
		if (totalPages !== undefined) diagnostic.totalPageCount = totalPages
	}
	for (const key of ['manifest', 'graph', 'ledger', 'derived']) {
		for (const source of sanitizedNestedSources) {
			if (!source[key]) continue
			diagnostic[key] = source[key]
			break
		}
	}
	if (diagnostic.evidenceIssueCount === undefined) {
		const unresolved = diagnosticCount(diagnostic.graph && diagnostic.graph.criticalUnresolvedCount) || 0
		const failures = diagnosticCount(diagnostic.ledger && diagnostic.ledger.criticalFailureCount) || 0
		const blocked = diagnosticCount(diagnostic.derived && diagnostic.derived.blockedMetricCount) || 0
		if (unresolved || failures || blocked) {
			diagnostic.evidenceIssueCount = diagnosticCount(unresolved + failures + blocked)
		}
	}
	return sanitizeAnalysisFailureDiagnostic(diagnostic)
}

function describeAnalysisFailure(error) {
	const classification = classifyAnalysisError(error)
	return {
		...classification,
		diagnostic: buildSafeAnalysisFailureDiagnostic(error)
	}
}

function logTrustedTerminalEvent(event, level = 'info') {
	let trusted
	try { trusted = buildTrustedTerminalEvent(event) } catch (_) { return false }
	const payload = {
		supportRef: trusted.supportRef,
		traceId: trusted.traceId,
		status: trusted.status,
		code: trusted.code,
		errorClass: trusted.errorClass,
		stage: trusted.stage,
		retryable: trusted.retryable,
		safeMessageKey: trusted.safeMessageKey,
		diagnostic: trusted.diagnostic,
		serverTime: trusted.serverTime,
		release: {
			id: trusted.release.id,
			gitCommit: trusted.release.gitCommit
		},
		versions: {
			event: trusted.versions.event,
			pipeline: trusted.versions.pipeline,
			model: trusted.versions.model,
			prompt: trusted.versions.prompt,
			schema: trusted.versions.schema,
			evidenceContract: trusted.versions.evidenceContract,
			evidenceBinder: trusted.versions.evidenceBinder,
			derivedTrace: trusted.versions.derivedTrace,
			rule: trusted.versions.rule,
			ocr: trusted.versions.ocr
		}
	}
	if (level === 'error') logger.error(payload, 'trusted analysis terminal event')
	else logger.info(payload, 'trusted analysis terminal event')
	return true
}

function boundedNumber(value, fallback, min, max) {
	const parsed = Number(value)
	if (!Number.isFinite(parsed)) return fallback
	return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

function cacheSecret() {
	const candidates = [
		process.env.ANALYSIS_CACHE_SECRET,
		process.env.ANALYSIS_KEY_SECRET
	]
	for (const candidate of candidates) {
		const value = String(candidate || '').trim()
		if (Buffer.byteLength(value, 'utf8') >= MIN_CACHE_SECRET_BYTES) return value
	}
	return ''
}

function persistentCacheEnabled() {
	return cacheSecret().length > 0
}

function cacheRuntimeStatus() {
	const identity = identityRuntimeStatus()
	return {
		mode: persistentCacheEnabled() ? 'sqlite-encrypted-cross-process' : 'memory-process-only',
		persistent: persistentCacheEnabled(),
		crossProcessSingleFlight: persistentCacheEnabled(),
		stableAcrossRestart: identity.stableAcrossRestart,
		reason: persistentCacheEnabled()
			? null
			: 'ANALYSIS_CACHE_SECRET/ANALYSIS_KEY_SECRET must contain at least 32 UTF-8 bytes'
	}
}

function encryptionKey() {
	return crypto
		.createHash('sha256')
		.update('reportflow-analysis-cache-aes256gcm-v1\0')
		.update(cacheSecret())
		.digest()
}

function encryptPayload(value) {
	const iv = crypto.randomBytes(12)
	const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv)
	const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
	const tag = cipher.getAuthTag()
	return [iv, tag, ciphertext].map((part) => part.toString('base64url')).join('.')
}

function decryptPayload(value) {
	const parts = String(value || '').split('.')
	if (parts.length !== 3) throw new Error('invalid encrypted analysis payload')
	const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, 'base64url'))
	const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv)
	decipher.setAuthTag(tag)
	return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'))
}

/**
 * 缓存、哈希和首次响应必须基于同一份 JSON 形状。业务对象里可能含有
 * `undefined`；JSON 加密落库时对象字段会被删除、数组项会变成 null。若先对原对象
 * 算哈希，进程重启后解密出的对象就会得到另一个哈希并被误判为缓存损坏。
 */
function normalizeCanonicalResult(value) {
	let serialized
	try {
		serialized = JSON.stringify(value)
	} catch (_) {
		const error = new Error('analysis executor returned a non-JSON canonical result')
		error.code = 'INVALID_CANONICAL_RESULT'
		throw error
	}
	if (typeof serialized !== 'string') {
		const error = new Error('analysis executor returned a non-JSON canonical result')
		error.code = 'INVALID_CANONICAL_RESULT'
		throw error
	}
	return JSON.parse(serialized)
}

function clone(value) {
	return typeof structuredClone === 'function'
		? structuredClone(value)
		: JSON.parse(JSON.stringify(value))
}

function cacheKey(identity) {
	return `${identity.scopeHmac}:${identity.analysisKey}`
}

function memoryTtlMs() {
	return boundedNumber(
		process.env.ANALYSIS_MEMORY_CACHE_TTL_MS,
		DEFAULT_MEMORY_TTL_MS,
		60000,
		30 * 24 * 60 * 60 * 1000
	)
}

/**
 * 持久结果默认不自动过期：版本已进入 analysisKey，规则/提示词/OCR/模型升级会自然
 * 生成新键；旧键继续作为同版本标准答案。若机构有数据留存期限，可显式设置 TTL。
 */
function persistentExpiresAt() {
	const configured = Number(process.env.ANALYSIS_PERSISTENT_CACHE_TTL_MS)
	if (!Number.isFinite(configured) || configured <= 0) return '9999-12-31T23:59:59.999Z'
	const ttlMs = boundedNumber(
		configured,
		365 * 24 * 60 * 60 * 1000,
		60 * 60 * 1000,
		10 * 365 * 24 * 60 * 60 * 1000
	)
	return new Date(Date.now() + ttlMs).toISOString()
}

function setMemory(identity, record) {
	const key = cacheKey(identity)
	memoryCache.delete(key)
	memoryCache.set(key, { ...record, expiresAt: Date.now() + memoryTtlMs() })
	const maxEntries = boundedNumber(
		process.env.ANALYSIS_MEMORY_CACHE_MAX_ENTRIES,
		DEFAULT_MEMORY_MAX_ENTRIES,
		8,
		2048
	)
	while (memoryCache.size > maxEntries) {
		const oldest = memoryCache.keys().next().value
		memoryCache.delete(oldest)
	}
}

function getMemory(identity) {
	const key = cacheKey(identity)
	const record = memoryCache.get(key)
	if (!record) return null
	if (record.expiresAt <= Date.now()) {
		memoryCache.delete(key)
		return null
	}
	return record
}

function valueAtPath(value, dottedPath) {
	return dottedPath
		.split('.')
		.reduce(
			(current, key) => (
				current && typeof current === 'object'
					? current[key]
					: undefined
			),
			value
		)
}

function authoritativeEvidenceError(code, message) {
	const error = new Error(message)
	error.code = code
	return error
}

function artifactPayload(artifact, hashField) {
	if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
		throw authoritativeEvidenceError(
			'EVIDENCE_HASH_CHAIN_INVALID',
			'authoritative evidence artifact is missing or invalid'
		)
	}
	const payload = { ...artifact }
	delete payload[hashField]
	return payload
}

function expectedEvidenceArtifactHash(prefix, artifact, hashField) {
	try {
		return buildArtifactHash(prefix, stableCanonicalize(artifactPayload(artifact, hashField)))
	} catch (error) {
		if (error && error.code === 'EVIDENCE_HASH_CHAIN_INVALID') throw error
		throw authoritativeEvidenceError(
			'EVIDENCE_HASH_CHAIN_INVALID',
			'authoritative evidence artifact cannot be canonicalized'
		)
	}
}

function authoritativeEvidenceHash(prefix, canonicalPayload) {
	return buildArtifactHash(prefix, canonicalPayload)
}

function assertEvidenceArtifactHash(prefix, artifact, hashField) {
	const actual = String(artifact && artifact[hashField] || '')
	const expected = expectedEvidenceArtifactHash(prefix, artifact, hashField)
	if (!actual || actual !== expected) {
		throw authoritativeEvidenceError(
			'EVIDENCE_HASH_CHAIN_INVALID',
			`authoritative evidence artifact hash mismatch: ${hashField}`
		)
	}
}

function canonicalValuesEqual(left, right) {
	try {
		return stableCanonicalize(left) === stableCanonicalize(right)
	} catch (_) {
		return false
	}
}

function artifactHash(prefix, payload) {
	try {
		return buildArtifactHash(prefix, stableCanonicalize(payload))
	} catch (_) {
		throw authoritativeEvidenceError(
			'EVIDENCE_CLOSURE_INVALID',
			`evidence closure payload cannot be hashed: ${prefix}`
		)
	}
}

function finiteRect(value) {
	return Array.isArray(value) &&
		value.length === 4 &&
		value.every(Number.isFinite) &&
		value[2] > value[0] &&
		value[3] > value[1]
}

function validPolygon(value, bounds) {
	if (!Array.isArray(value) || value.length !== 4) return false
	if (!value.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))) {
		return false
	}
	if (!bounds) return true
	if (!finiteRect(bounds)) return false
	const [x0, y0, x1, y1] = bounds
	return value.every(([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1)
}

function uniqueStrings(value) {
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) return null
	return new Set(value).size === value.length ? value : null
}

function assertEvidenceIdentity(identity, canonicalResult, artifacts) {
	if (
		!identity ||
		!/^doc_v2_[a-f0-9]{64}$/.test(String(identity.documentId || '')) ||
		!identity.versions ||
		!String(identity.inputKind || '')
	) {
		throw authoritativeEvidenceError(
			'EVIDENCE_IDENTITY_MISMATCH',
			'current analysis identity is missing evidence binding fields'
		)
	}
	const manifest = artifacts.manifest
	const graph = artifacts.evidenceGraph
	const ledger = artifacts.factLedger
	const derived = artifacts.derivedAnalysis
	if (
		manifest.documentId !== identity.documentId ||
		graph.documentId !== identity.documentId ||
		ledger.documentId !== identity.documentId ||
		manifest.input?.kind !== identity.inputKind
	) {
		throw authoritativeEvidenceError(
			'EVIDENCE_IDENTITY_MISMATCH',
			'evidence artifacts do not belong to the current document and input kind'
		)
	}
	const manifestVersions = { ...(manifest.versions || {}) }
	delete manifestVersions.manifestSchema
	delete manifestVersions.segmentation
	if (
		manifest.versions?.manifestSchema !== '2.0' ||
		manifest.versions?.segmentation !== 'line-blocks-v1' ||
		CURRENT_EVIDENCE_VERSION_FIELDS.some((field) => !identity.versions[field]) ||
		stableStringify(manifestVersions) !== stableStringify(identity.versions)
	) {
		throw authoritativeEvidenceError(
			'EVIDENCE_IDENTITY_MISMATCH',
			'evidence artifacts were produced by a different analysis version'
		)
	}
	const ruleVersion = String(canonicalResult.derivation_meta?.rules_version || '')
	if (!ruleVersion || derived.inputs?.ruleVersion !== ruleVersion) {
		throw authoritativeEvidenceError(
			'EVIDENCE_IDENTITY_MISMATCH',
			'derived evidence rule version does not match the canonical result'
		)
	}
}

function assertDocumentEvidenceClosure(identity, artifacts) {
	const manifest = artifacts.manifest
	const graph = artifacts.evidenceGraph
	const ledger = artifacts.factLedger
	const fail = (message) => {
		throw authoritativeEvidenceError('EVIDENCE_CLOSURE_INVALID', message)
	}
	const pages = Array.isArray(manifest.pages) ? manifest.pages : []
	const pageMap = new Map()
	for (const page of pages) {
		const pageNo = Number(page?.pageNo)
		if (!Number.isInteger(pageNo) || pageNo < 1 || pageMap.has(pageNo)) fail('manifest page identity is invalid')
		if (!Number.isInteger(page.textLength) || page.textLength < 0) fail('manifest page text length is invalid')
		if (!Number.isInteger(page.blockCount) || page.blockCount < 0) fail('manifest page block count is invalid')
		if (page.bounds != null && !finiteRect(page.bounds)) fail('manifest page bounds are invalid')
		if (
			page.status !== 'complete' || page.textCoverageComplete !== true ||
			page.sourceMode === 'pdf-parse-legacy' ||
			!/^pt_v2_[a-f0-9]{64}$/.test(String(page.textDigest || ''))
		) fail('manifest page is not a complete current-source page')
		const expectedPageId = artifactHash('pg_v2', {
			documentId: identity.documentId,
			pageNo,
			textDigest: page.textDigest
		})
		if (page.pageId !== expectedPageId) fail('manifest page hash is not bound to the current document')
		pageMap.set(pageNo, page)
	}
	const coverage = manifest.coverage || {}
	const processedPageNos = pages.map((page) => page.pageNo).sort((a, b) => a - b)
	const expectedPageNos = Array.from({ length: pages.length }, (_, index) => index + 1)
	if (
		pages.length === 0 ||
		coverage.declaredPageCount !== pages.length ||
		coverage.processedPageCount !== pages.length ||
		!canonicalValuesEqual(coverage.processedPageNos, processedPageNos) ||
		!canonicalValuesEqual(processedPageNos, expectedPageNos) ||
		!canonicalValuesEqual(coverage.missingPageNos, []) ||
		!canonicalValuesEqual(coverage.duplicatePageNos, []) ||
		coverage.readerComplete !== true || coverage.complete !== true
	) fail('manifest page coverage does not close over the page list')

	const blocks = Array.isArray(graph.blocks) ? graph.blocks : []
	const blockMap = new Map()
	const perPageBlockCount = new Map()
	for (const block of blocks) {
		const page = pageMap.get(block?.pageNo)
		const span = block?.span
		if (!page || blockMap.has(block.blockId)) fail('evidence block page or identity is invalid')
		if (!Number.isInteger(block.ordinal) || block.ordinal < 1) fail('evidence block ordinal is invalid')
		if (
			!span ||
			!Number.isInteger(span.offset) || span.offset < 0 ||
			!Number.isInteger(span.length) || span.length < 1 ||
			span.offset + span.length > page.textLength ||
			!Number.isInteger(block.textLength) || block.textLength < 1
		) fail('evidence block span is outside its page')
		if (
			block.sourceMode !== page.sourceMode ||
			!/^bt_v2_[a-f0-9]{64}$/.test(String(block.textDigest || ''))
		) fail('evidence block is not bound to its manifest page source')
		if (block.geometryState === 'available') {
			if (!validPolygon(block.polygon, page.bounds)) fail('evidence block polygon is outside its page')
		} else if (block.geometryState !== 'unavailable' || block.polygon != null) {
			fail('evidence block geometry state is inconsistent')
		}
		const expectedBlockId = artifactHash('blk_v2', {
			documentId: identity.documentId,
			pageNo: block.pageNo,
			ordinal: block.ordinal,
			charStart: span.offset,
			charEnd: span.offset + span.length,
			textDigest: block.textDigest,
			polygon: block.polygon
		})
		if (block.blockId !== expectedBlockId) fail('evidence block hash is invalid')
		blockMap.set(block.blockId, block)
		perPageBlockCount.set(block.pageNo, (perPageBlockCount.get(block.pageNo) || 0) + 1)
	}
	for (const page of pages) {
		if (page.blockCount < (perPageBlockCount.get(page.pageNo) || 0)) {
			fail('retained evidence blocks exceed the manifest source block count')
		}
	}

	const nodes = Array.isArray(graph.nodes) ? graph.nodes : []
	const nodeMap = new Map()
	const targetKeys = new Set()
	const retainedBlockRefs = new Set()
	const recordBindingByEntity = new Map()
	for (const node of nodes) {
		if (
			!node?.nodeId || nodeMap.has(node.nodeId) ||
			!node.targetKey || targetKeys.has(node.targetKey) ||
			!node.targetId || !node.entityId || !node.entityKind || !node.field ||
			!/^rbd_v3_[a-f0-9]{64}$/.test(String(node.recordBindingId || ''))
		) fail('evidence node identity is invalid')
		const existingBinding = recordBindingByEntity.get(node.entityId)
		if (existingBinding && existingBinding !== node.recordBindingId) {
			fail('one evidence entity spans multiple record bindings')
		}
		recordBindingByEntity.set(node.entityId, node.recordBindingId)
		if (node.valueDigest !== artifactHash('val_v2', node.value)) fail('evidence node value digest is invalid')
		const expectedTargetId = artifactHash('tgt_v2', {
			entityId: node.entityId,
			field: node.field,
			valueDigest: node.value?.type === 'absence' ? null : node.valueDigest
		})
		if (node.targetId !== expectedTargetId) fail('evidence node target is invalid')
		if (node.nodeId !== artifactHash('ev_v2', artifactPayload(node, 'nodeId'))) {
			fail('evidence node hash is invalid')
		}
		if (!Array.isArray(node.evidenceRefs) || node.evidenceRefs.length === 0) {
			fail('evidence node has no source reference')
		}
		for (const ref of node.evidenceRefs) {
			const block = blockMap.get(ref?.blockId)
			const normalized = ref?.normalizedSpan
			const absenceRef = node.value?.type === 'absence'
			const normalizedSpanValid = absenceRef
				? normalized == null
				: Boolean(
					block && normalized && Number.isInteger(normalized.start) && normalized.start >= 0 &&
					Number.isInteger(normalized.end) && normalized.end > normalized.start &&
					normalized.end <= block.textLength
				)
			const expectedQuoteDigest = artifactHash('qt_v2', absenceRef
				? {
					documentId: identity.documentId,
					absence: 'installment',
					blockId: ref.blockId,
					normalizedSpan: null
				}
				: {
					documentId: identity.documentId,
					blockId: ref.blockId,
					normalizedSpan: normalized
				})
			if (
				!block || ref.pageNo !== block.pageNo || ref.ordinal !== block.ordinal ||
				!canonicalValuesEqual(ref.span, block.span) ||
				ref.geometryState !== block.geometryState ||
				!canonicalValuesEqual(ref.polygon, block.polygon) ||
				!normalizedSpanValid || ref.quoteDigest !== expectedQuoteDigest
			) fail('evidence node reference does not resolve to a real block span')
			retainedBlockRefs.add(ref.blockId)
		}
		nodeMap.set(node.nodeId, node)
		targetKeys.add(node.targetKey)
	}
	const unresolved = Array.isArray(graph.unresolved) ? graph.unresolved : []
	for (const item of unresolved) {
		const signalBlockIds = uniqueStrings(item?.signalBlockIds)
		if (
			!item?.targetId || !item.targetKey || !item.entityId || targetKeys.has(item.targetKey) ||
			item.critical === true || !signalBlockIds
		) fail('unresolved evidence record is invalid for a publishable graph')
		for (const blockId of signalBlockIds) {
			if (!blockMap.has(blockId)) fail('unresolved evidence signal does not resolve to a retained block')
			retainedBlockRefs.add(blockId)
		}
		targetKeys.add(item.targetKey)
	}
	if (!canonicalValuesEqual([...retainedBlockRefs].sort(), [...blockMap.keys()].sort())) {
		fail('retained evidence blocks are not closed over nodes and blocking signals')
	}
	if (
		graph.coverage?.blockCount !== blocks.length ||
		graph.coverage?.retainedBlockCount !== blocks.length ||
		graph.coverage?.totalSourceBlockCount !== pages.reduce((sum, page) => sum + page.blockCount, 0) ||
		graph.coverage?.nodeCount !== nodes.length ||
		graph.coverage?.criticalUnresolvedCount !== (
			unresolved.filter((item) => item?.critical === true).length
		)
	) fail('evidence graph coverage counters are inconsistent')

	const facts = Array.isArray(ledger.facts) ? ledger.facts : []
	const factMap = new Map()
	const entities = new Map()
	for (const entity of Array.isArray(ledger.entities) ? ledger.entities : []) {
		if (!entity?.entityId || entities.has(entity.entityId) || !entity.kind) fail('fact ledger entity is invalid')
		entities.set(entity.entityId, entity)
	}
	const allowedFactStatuses = new Set(['accepted', 'unknown', 'absent', 'not_applicable', 'conflict'])
	for (const fact of facts) {
		if (!fact?.factId || factMap.has(fact.factId)) fail('fact ledger contains duplicate facts')
		if (!allowedFactStatuses.has(fact.status)) fail('fact ledger contains an unsupported status')
		if (fact.factId !== artifactHash('fact_v2', artifactPayload(fact, 'factId'))) fail('fact id is invalid')
		const entity = entities.get(fact.entityId)
		if (
			!entity || entity.kind !== fact.entityKind ||
			(entity.subtype || null) !== (fact.entitySubtype || null)
		) fail('fact does not resolve to its declared entity')
		const evidenceNodeIds = uniqueStrings(fact.evidenceNodeIds)
		if (!evidenceNodeIds) fail('fact evidence references are invalid')
		if (fact.status === 'accepted') {
			if (fact.critical === true && evidenceNodeIds.length === 0) {
				fail('critical accepted fact has no evidence node')
			}
			for (const nodeId of evidenceNodeIds) {
				const node = nodeMap.get(nodeId)
				if (
					!node || node.targetId !== fact.targetId || node.entityId !== fact.entityId ||
					node.entityKind !== fact.entityKind ||
					node.field !== fact.field ||
					node.critical !== fact.critical ||
					!canonicalValuesEqual(node.value, fact.value)
				) fail('accepted fact and evidence node do not form a closed binding')
			}
		} else if (fact.status === 'absent' && fact.entityKind === 'card' && fact.field === 'installment') {
			if (evidenceNodeIds.length !== 1) fail('card installment absence must cite exactly one evidence node')
			const node = nodeMap.get(evidenceNodeIds[0])
			if (
				!node || node.targetId !== fact.targetId || node.entityId !== fact.entityId ||
				node.entityKind !== fact.entityKind || node.field !== fact.field ||
				node.value?.type !== 'absence' || fact.value !== null || fact.critical !== false
			) fail('card installment absence does not close over its evidence node')
		}
		factMap.set(fact.factId, fact)
	}
	const sharedNodes = nodes.filter((node) => node.field === 'shared_group_identity')
	const sharedNodeByEntity = new Map()
	const sharedMembersByGroup = new Map()
	for (const node of sharedNodes) {
		const entity = entities.get(node.entityId)
		const groupId = String(node.value?.id || '')
		const primaryNode = nodes.find((candidate) =>
			candidate.entityId === node.entityId && candidate.field === 'credit_limit'
		)
		if (
			node.entityKind !== 'card' || entity?.kind !== 'card' ||
			node.value?.type !== 'opaque-group' || !/^grp_v2_[a-f0-9]{64}$/.test(groupId) ||
			sharedNodeByEntity.has(node.entityId) || node.evidenceRefs.length !== 1 ||
			!primaryNode || primaryNode.recordBindingId !== node.recordBindingId
		) fail('shared credit evidence node is not bound to one card source row')
		sharedNodeByEntity.set(node.entityId, node)
		if (!sharedMembersByGroup.has(groupId)) sharedMembersByGroup.set(groupId, new Set())
		sharedMembersByGroup.get(groupId).add(node.entityId)
	}
	const expectedRelations = []
	for (const membersSet of sharedMembersByGroup.values()) {
		const members = [...membersSet].sort()
		if (members.length < 2) fail('shared credit evidence group has fewer than two card members')
		for (let left = 0; left < members.length; left += 1) {
			for (let right = left + 1; right < members.length; right += 1) {
				const relationBase = {
					type: 'same-credit-facility',
					members: [members[left], members[right]],
					status: 'accepted',
					basis: 'explicit-source-group'
				}
				expectedRelations.push({
					relationId: artifactHash('rel_v2', relationBase),
					...relationBase
				})
			}
		}
	}
	expectedRelations.sort((left, right) => {
		const a = String(left.relationId || '')
		const b = String(right.relationId || '')
		return a < b ? -1 : (a > b ? 1 : 0)
	})
	const actualRelations = Array.isArray(ledger.relations) ? ledger.relations : []
	if (
		!canonicalValuesEqual(actualRelations, expectedRelations) ||
		!canonicalValuesEqual(ledger.conflicts, []) ||
		!canonicalValuesEqual(ledger.gate?.conflictCodes, [])
	) fail('shared credit relation ledger does not close over source evidence nodes')
	const relationMap = new Map(expectedRelations.map((relation) => [relation.relationId, relation]))
	for (const node of nodes.filter((item) => item.critical === true)) {
		if (![...factMap.values()].some(
			(fact) => fact.status === 'accepted' && fact.evidenceNodeIds.includes(node.nodeId)
		)) fail('critical evidence node is not consumed by an accepted fact')
	}
	for (const entityId of entities.keys()) {
		if (![...factMap.values()].some((fact) => fact.entityId === entityId)) {
			fail('fact ledger contains an entity with no facts')
		}
	}
	return { factMap, relationMap }
}

function assertDerivedFactClosure(artifacts, factMap, relationMap) {
	const derived = artifacts.derivedAnalysis
	const metrics = derived.metrics && typeof derived.metrics === 'object' ? derived.metrics : {}
	const accepted = [...factMap.values()].filter((fact) => fact.status === 'accepted')
	const acceptedIds = new Set(accepted.map((fact) => fact.factId))
	const ids = (predicate) => accepted.filter(predicate).map((fact) => fact.factId).sort()
	const cardFacts = new Map()
	for (const fact of accepted.filter((item) => item.entityKind === 'card')) {
		if (!cardFacts.has(fact.entityId)) cardFacts.set(fact.entityId, {})
		cardFacts.get(fact.entityId)[fact.field] = fact
	}
	// PRD-DECISION-001：已证明未激活的卡只允许携带激活状态事实，
	// 计入账户数但排除在货币闭合/授信设施/使用率之外。
	const notActivatedCardEntities = new Set([...cardFacts.entries()]
		.filter(([, row]) =>
			row.activation_state?.value?.type === 'card-state' &&
			row.activation_state.value.state === 'not_activated'
		)
		.map(([entityId]) => entityId))
	for (const [entityId, row] of cardFacts.entries()) {
		if (notActivatedCardEntities.has(entityId)) {
			if (row.credit_limit || row.used_limit || row.currency || row.installment) {
				throw authoritativeEvidenceError(
					'EVIDENCE_DERIVATION_INVALID',
					'a not-activated card must not carry accepted monetary facts'
				)
			}
			continue
		}
		const code = row.currency?.value?.code
		if (
			!code ||
			row.credit_limit?.value?.currency !== code ||
			row.used_limit?.value?.currency !== code ||
			(row.installment?.value?.type === 'money' && row.installment.value.currency !== code)
		) {
			throw authoritativeEvidenceError(
				'EVIDENCE_DERIVATION_INVALID',
				'card money facts do not close over the accepted currency fact'
			)
		}
	}
	const loanFacts = new Map()
	for (const fact of accepted.filter((item) => item.entityKind === 'loan')) {
		if (!loanFacts.has(fact.entityId)) loanFacts.set(fact.entityId, {})
		loanFacts.get(fact.entityId)[fact.field] = fact
	}
	for (const row of loanFacts.values()) {
		if (
			row.currency?.value?.code &&
			row.balance?.value?.currency !== row.currency.value.code
		) {
			throw authoritativeEvidenceError(
				'EVIDENCE_DERIVATION_INVALID',
				'loan balance money does not close over the accepted currency fact'
			)
		}
	}
	const cnyCardEntities = new Set([...cardFacts.entries()]
		.filter(([, row]) => row.currency?.value?.code === 'CNY')
		.map(([entityId]) => entityId))
	const primaryInstallmentFactIds = [...factMap.values()].filter((fact) =>
		fact.entityKind === 'card' &&
		fact.field === 'installment' &&
		cnyCardEntities.has(fact.entityId) && (
			(fact.status === 'accepted' && fact.value?.currency === 'CNY') ||
			fact.status === 'absent'
		)
	).map((fact) => fact.factId)
	const specifications = {
		totalLoanBalance: {
			formulaId: 'loan-balance-sum-v2',
			inputFactIds: ids((fact) => fact.entityKind === 'loan' && fact.field === 'balance' && fact.value?.currency === 'CNY')
		},
		cardUtilization: {
			formulaId: 'card-utilization-cny-v2',
			inputFactIds: ids((fact) => cnyCardEntities.has(fact.entityId) &&
				['credit_limit', 'used_limit', 'currency'].includes(fact.field))
		},
		cardOutstanding: {
			formulaId: 'card-outstanding-cny-v1',
			inputFactIds: ids((fact) => cnyCardEntities.has(fact.entityId) &&
				['credit_limit', 'used_limit', 'currency'].includes(fact.field))
		},
		totalDebt: {
			formulaId: 'total-debt-v2',
			inputFactIds: ids((fact) =>
				(fact.entityKind === 'loan' && fact.field === 'balance' && fact.value?.currency === 'CNY') ||
				(cnyCardEntities.has(fact.entityId) && fact.field === 'used_limit')
			)
		},
		queryCounts: {
			formulaId: 'hard-query-calendar-window-v2',
			inputFactIds: ids((fact) =>
				(fact.entityKind === 'document' && fact.field === 'report_date') ||
				(fact.entityKind === 'query' && ['date', 'reason'].includes(fact.field))
			)
		},
		primaryScore: {
			formulaId: 'primary-score-deterministic-v3',
			inputFactIds: [
				...ids((fact) => fact.critical === true && !(
					fact.entityKind === 'card' && fact.field === 'installment'
				)),
				...primaryInstallmentFactIds
			].sort()
		}
	}
	if (!canonicalValuesEqual(Object.keys(metrics).sort(), Object.keys(specifications).sort())) {
		throw authoritativeEvidenceError('EVIDENCE_DERIVATION_INVALID', 'derived metric set is not current')
	}
	for (const [name, specification] of Object.entries(specifications)) {
		const metric = metrics[name]
		const inputFactIds = uniqueStrings(metric?.inputFactIds)
		const allowedInputIds = name === 'primaryScore'
			? new Set(specification.inputFactIds)
			: acceptedIds
		if (
			!metric || metric.formulaId !== specification.formulaId || !inputFactIds ||
			inputFactIds.some((factId) => !allowedInputIds.has(factId)) ||
			!canonicalValuesEqual([...inputFactIds].sort(), specification.inputFactIds)
		) {
			throw authoritativeEvidenceError(
				'EVIDENCE_DERIVATION_INVALID',
				`derived metric fact closure is invalid: ${name}`
			)
		}
	}

	const cardEntityIds = [...cardFacts.keys()]
		.filter((entityId) => !notActivatedCardEntities.has(entityId))
		.sort()
	const parent = new Map(cardEntityIds.map((entityId) => [entityId, entityId]))
	const find = (entityId) => {
		let current = entityId
		while (parent.has(current) && parent.get(current) !== current) current = parent.get(current)
		return current
	}
	const union = (left, right) => {
		const a = find(left)
		const b = find(right)
		if (!parent.has(a) || !parent.has(b) || a === b) return
		if (a < b) parent.set(b, a)
		else parent.set(a, b)
	}
	for (const relation of relationMap.values()) union(relation.members[0], relation.members[1])
	const facilities = new Map()
	for (const entityId of cardEntityIds) {
		const root = find(entityId)
		if (!facilities.has(root)) facilities.set(root, [])
		facilities.get(root).push(entityId)
	}
	const expectedExclusions = [...notActivatedCardEntities].sort().map((entityId) => ({
		entityId,
		reason: 'CARD_NOT_ACTIVATED'
	}))
	const expectedFacilityTrace = []
	for (const [facilityId, memberIds] of facilities.entries()) {
		const cnyMemberIds = memberIds.filter((entityId) => {
			const isCny = cardFacts.get(entityId)?.currency?.value?.code === 'CNY'
			if (!isCny) expectedExclusions.push({ entityId, reason: 'NON_CNY_WITHOUT_EQUIVALENT' })
			return isCny
		}).sort()
		if (!cnyMemberIds.length) continue
		const cnySet = new Set(cnyMemberIds)
		const inputRelationIds = [...relationMap.values()]
			.filter((relation) => relation.members.every((entityId) => cnySet.has(entityId)))
			.map((relation) => relation.relationId)
			.sort()
		if (cnyMemberIds.length > 1 && inputRelationIds.length === 0) {
			throw authoritativeEvidenceError(
				'EVIDENCE_DERIVATION_INVALID',
				'shared facility trace has no accepted source relation'
			)
		}
		const limitMinor = Math.max(...cnyMemberIds.map((entityId) =>
			Number(cardFacts.get(entityId)?.credit_limit?.value?.minor)
		))
		const usedMinor = Math.max(...cnyMemberIds.map((entityId) =>
			Number(cardFacts.get(entityId)?.used_limit?.value?.minor)
		))
		if (!Number.isSafeInteger(limitMinor) || !Number.isSafeInteger(usedMinor)) {
			throw authoritativeEvidenceError(
				'EVIDENCE_DERIVATION_INVALID',
				'card facility trace contains non-integer money inputs'
			)
		}
		expectedFacilityTrace.push({
			facilityId,
			memberEntityIds: cnyMemberIds,
			inputRelationIds,
			limitMinor,
			usedMinor,
			policy: cnyMemberIds.length > 1 ? 'accepted-shared-max-v1' : 'single-account-v1'
		})
	}
	const outstanding = metrics.cardOutstanding
	const totalOutstandingMinor = expectedFacilityTrace.reduce((sum, facility) => sum + facility.usedMinor, 0)
	if (
		outstanding?.status !== 'computed' ||
		!canonicalValuesEqual(outstanding?.facilityTrace, expectedFacilityTrace) ||
		outstanding?.value?.type !== 'money' ||
		outstanding?.value?.currency !== 'CNY' ||
		outstanding?.value?.minor !== totalOutstandingMinor
	) {
		throw authoritativeEvidenceError(
			'EVIDENCE_DERIVATION_INVALID',
			'card outstanding does not close over accepted card facilities'
		)
	}
	const positiveFacilityTrace = expectedFacilityTrace.filter((facility) => facility.limitMinor > 0)
	const utilizationExclusions = [
		...expectedExclusions,
		...expectedFacilityTrace
			.filter((facility) => facility.limitMinor <= 0)
			.map((facility) => ({
				facilityId: facility.facilityId,
				memberEntityIds: facility.memberEntityIds,
				reason: 'NO_POSITIVE_CNY_LIMIT'
			}))
	]
	const utilization = metrics.cardUtilization
	if (
		!canonicalValuesEqual(utilization?.facilityTrace, positiveFacilityTrace) ||
		!canonicalValuesEqual(utilization?.exclusions, utilizationExclusions)
	) {
		throw authoritativeEvidenceError(
			'EVIDENCE_DERIVATION_INVALID',
			'card utilization facility trace does not close over accepted relations'
		)
	}
	const totalLimitMinor = positiveFacilityTrace.reduce((sum, facility) => sum + facility.limitMinor, 0)
	const utilizationUsedMinor = positiveFacilityTrace.reduce((sum, facility) => sum + facility.usedMinor, 0)
	if (totalLimitMinor > 0) {
		if (
			utilization?.status !== 'computed' ||
			utilization?.value?.type !== 'rate-bps' ||
			utilization.value.value !== Math.round(utilizationUsedMinor * 10000 / totalLimitMinor) ||
			utilization?.numerator?.minor !== utilizationUsedMinor ||
			utilization?.denominator?.minor !== totalLimitMinor
		) {
			throw authoritativeEvidenceError(
				'EVIDENCE_DERIVATION_INVALID',
				'card utilization values do not close over facility trace'
			)
		}
	} else if (utilization?.status !== 'not_applicable' || utilization?.value !== null) {
		throw authoritativeEvidenceError(
			'EVIDENCE_DERIVATION_INVALID',
			'zero-limit card utilization must be not applicable'
		)
	}
	const totalLoanMinor = accepted
		.filter((fact) => fact.entityKind === 'loan' && fact.field === 'balance' && fact.value?.currency === 'CNY')
		.reduce((sum, fact) => sum + Number(fact.value?.minor || 0), 0)
	if (
		metrics.totalLoanBalance?.value?.minor !== totalLoanMinor ||
		metrics.totalDebt?.value?.minor !== totalLoanMinor + totalOutstandingMinor
	) {
		throw authoritativeEvidenceError(
			'EVIDENCE_DERIVATION_INVALID',
			'debt values do not close over accepted loan and facility facts'
		)
	}

	// Hash integrity only proves that the persisted artifacts agree with their
	// signatures. It does not prove that a caller did not edit both the derived
	// values and the canonical projection before recomputing every hash. Replay
	// the decision-bearing query windows and score directly from the closed fact
	// ledger so the derived artifact remains a verifiable projection, not an
	// authority of its own.
	const reportFacts = accepted.filter(
		(fact) => fact.entityKind === 'document' && fact.field === 'report_date'
	)
	if (reportFacts.length !== 1) {
		throw authoritativeEvidenceError(
			'EVIDENCE_DERIVATION_INVALID',
			'query replay requires exactly one accepted report date fact'
		)
	}
	const reportFact = reportFacts[0]
	if (
		artifacts.factLedger.anchorDate !== reportFact.value?.value ||
		derived.inputs?.anchorDate !== reportFact.value?.value
	) {
		throw authoritativeEvidenceError(
			'EVIDENCE_DERIVATION_INVALID',
			'query replay anchor does not match the accepted report date fact'
		)
	}
	const anchor = parseQueryDateMs(reportFact.value?.value)
	if (!anchor) {
		throw authoritativeEvidenceError(
			'EVIDENCE_DERIVATION_INVALID',
			'query replay report date is invalid'
		)
	}
	const acceptedByEntity = (kind) => {
		const rows = new Map()
		for (const fact of accepted.filter((item) => item.entityKind === kind)) {
			if (!rows.has(fact.entityId)) rows.set(fact.entityId, {})
			rows.get(fact.entityId)[fact.field] = fact
		}
		return rows
	}
	const queryEntities = acceptedByEntity('query')
	const queryRows = []
	for (const row of queryEntities.values()) {
		if (!row.date || !row.reason) continue
		queryRows.push({
			date: row.date.value?.value,
			reason: row.reason.value?.value,
			institution_type: row.date.entitySubtype || row.reason.entitySubtype || 'unknown'
		})
	}
	const windows = {}
	const windowBreakdown = {}
	for (const months of [1, 3, 6, 12]) {
		const key = `last_${months}m`
		const bucket = countQueriesByWindow(queryRows, anchor, months, { hardOnly: true })
		windows[key] = bucket.total
		windowBreakdown[key] = {
			total: bucket.total,
			bank: bucket.bank,
			non_bank: bucket.non_bank,
			unknown: bucket.unknown
		}
	}
	const expectedQueryCounts = {
		status: 'computed',
		formulaId: specifications.queryCounts.formulaId,
		inputFactIds: specifications.queryCounts.inputFactIds,
		value: {
			type: 'query-window-counts',
			...windows,
			by_window: windowBreakdown
		},
		anchorDate: reportFact.value.value
	}
	if (!canonicalValuesEqual(metrics.queryCounts, expectedQueryCounts)) {
		throw authoritativeEvidenceError(
			'EVIDENCE_DERIVATION_INVALID',
			'query windows do not replay from accepted query facts'
		)
	}

	const loanEntities = acceptedByEntity('loan')
	const scoreCardEntities = acceptedByEntity('card')
	const totalAccountCount = loanEntities.size + scoreCardEntities.size
	const nonBankLoanCount = [...loanEntities.values()].filter(
		(row) => row.balance?.entitySubtype === 'non_bank_loan'
	).length
	const bigInstallmentMinor = [...scoreCardEntities.values()].reduce(
		(total, row) => total + (
			row.currency?.value?.code === 'CNY' && row.installment?.value?.currency === 'CNY'
				? Number(row.installment.value.minor || 0)
				: 0
		),
		0
	)
	if (!Number.isSafeInteger(bigInstallmentMinor)) {
		throw authoritativeEvidenceError(
			'EVIDENCE_DERIVATION_INVALID',
			'primary score replay contains non-integer installment inputs'
		)
	}
	const scoringInputs = {
		totalAccountCount,
		nonBankLoanCount,
		cardUtilizationRate: totalLimitMinor > 0
			? Math.round(utilizationUsedMinor * 10000 / totalLimitMinor) / 10000
			: 0,
		hasBigInstallment: bigInstallmentMinor > 0,
		q6: windows.last_6m,
		sameDayInquiryDayCount: summarizeHardQueryBursts(queryRows, anchor, { months: 6 })
			.sameDayInquiryDayCount
	}
	const scoreProjection = calculatePrimaryRuleScore(scoringInputs)
	const expectedPrimaryScore = {
		status: 'computed',
		formulaId: specifications.primaryScore.formulaId,
		inputFactIds: specifications.primaryScore.inputFactIds,
		value: {
			type: 'internal-credit-score',
			value: scoreProjection.score,
			scale: 100
		},
		label: '分析报告工作台内部评估分',
		baseScore: scoreProjection.baseScore,
		totalDeduction: scoreProjection.totalDeduction,
		inputMetrics: {
			...scoringInputs,
			bigInstallment: {
				type: 'money',
				currency: 'CNY',
				minor: bigInstallmentMinor,
				scale: 2
			}
		},
		deductionTrace: scoreProjection.deductions.map((item) => ({
			ruleId: item.code,
			points: Number(item.points)
		}))
	}
	if (!canonicalValuesEqual(metrics.primaryScore, expectedPrimaryScore)) {
		throw authoritativeEvidenceError(
			'EVIDENCE_DERIVATION_INVALID',
			'primary score inputs or deduction trace do not replay from accepted facts'
		)
	}
}

function nearlyEqual(left, right, tolerance = 0.0001) {
	return Number.isFinite(Number(left)) &&
		Number.isFinite(Number(right)) &&
		Math.abs(Number(left) - Number(right)) <= tolerance
}

function hasOwnValue(container, key) {
	return container !== null &&
		typeof container === 'object' &&
		Object.prototype.hasOwnProperty.call(container, key)
}

function assertEvidenceDerivedProjection(canonicalResult, derivedAnalysis) {
	const metrics = derivedAnalysis && derivedAnalysis.metrics && typeof derivedAnalysis.metrics === 'object'
		? derivedAnalysis.metrics
		: {}
	const mismatch = (path) => {
		throw authoritativeEvidenceError(
			'EVIDENCE_DERIVATION_MISMATCH',
			`authoritative evidence derivation mismatch: ${path}`
		)
	}
	if (canonicalResult.derivation_meta?.anchor_date !== derivedAnalysis?.inputs?.anchorDate) {
		mismatch('derivation_meta.anchor_date')
	}

	const totalDebt = Number(metrics.totalDebt?.value?.minor) / 100
	if (!nearlyEqual(totalDebt, canonicalResult.credit_debt?.total_debt, 0.001)) {
		mismatch('credit_debt.total_debt')
	}
	if (
		hasOwnValue(canonicalResult.deterministic_dimensions, 'totalDebt') &&
		!nearlyEqual(totalDebt, canonicalResult.deterministic_dimensions.totalDebt, 0.001)
	) {
		mismatch('deterministic_dimensions.totalDebt')
	}
	const totalLoanBalance = Number(metrics.totalLoanBalance?.value?.minor) / 100
	if (!nearlyEqual(totalLoanBalance, canonicalResult.credit_debt?.credit_loans?.total_balance, 0.001)) {
		mismatch('credit_debt.credit_loans.total_balance')
	}
	if (
		hasOwnValue(canonicalResult.deterministic_dimensions, 'totalLoanBalance') &&
		!nearlyEqual(totalLoanBalance, canonicalResult.deterministic_dimensions.totalLoanBalance, 0.001)
	) {
		mismatch('deterministic_dimensions.totalLoanBalance')
	}

	const utilization = metrics.cardUtilization
	const outstanding = metrics.cardOutstanding
	const expectedOutstanding = Number(outstanding?.value?.minor) / 100
	const expectedRate = utilization?.status === 'computed'
		? Number(utilization?.value?.value) / 10000
		: 0
	if (!nearlyEqual(expectedRate, canonicalResult.credit_debt?.credit_cards?.usage_rate)) {
		mismatch('credit_debt.credit_cards.usage_rate')
	}
	if (
		hasOwnValue(canonicalResult.deterministic_dimensions, 'cardUtilizationRate') &&
		!nearlyEqual(expectedRate, canonicalResult.deterministic_dimensions.cardUtilizationRate)
	) {
		mismatch('deterministic_dimensions.cardUtilizationRate')
	}
	const expectedUtilizationUsed = utilization?.status === 'computed'
		? Number(utilization?.numerator?.minor) / 100
		: 0
	const expectedLimit = utilization?.status === 'computed'
		? Number(utilization?.denominator?.minor) / 100
		: 0
	if (!nearlyEqual(expectedOutstanding, canonicalResult.credit_debt?.credit_cards?.total_used, 0.001)) {
		mismatch('credit_debt.credit_cards.total_used')
	}
	if (
		hasOwnValue(canonicalResult.deterministic_dimensions, 'usedCardLimit') &&
		!nearlyEqual(expectedOutstanding, canonicalResult.deterministic_dimensions.usedCardLimit, 0.001)
	) {
		mismatch('deterministic_dimensions.usedCardLimit')
	}
	if (!nearlyEqual(expectedUtilizationUsed, canonicalResult.credit_debt?.credit_cards?.utilization_used, 0.001)) {
		mismatch('credit_debt.credit_cards.utilization_used')
	}
	if (
		hasOwnValue(canonicalResult.deterministic_dimensions, 'cardUtilizationUsed') &&
		!nearlyEqual(expectedUtilizationUsed, canonicalResult.deterministic_dimensions.cardUtilizationUsed, 0.001)
	) {
		mismatch('deterministic_dimensions.cardUtilizationUsed')
	}
	if (!nearlyEqual(expectedLimit, canonicalResult.credit_debt?.credit_cards?.total_limit, 0.001)) {
		mismatch('credit_debt.credit_cards.total_limit')
	}
	const sharedGroupCount = Array.isArray(outstanding?.facilityTrace)
		? outstanding.facilityTrace.filter(
			(facility) => Array.isArray(facility?.memberEntityIds) && facility.memberEntityIds.length > 1
		).length
		: 0
	if (!nearlyEqual(sharedGroupCount, canonicalResult.credit_debt?.credit_cards?.shared_group_count, 0)) {
		mismatch('credit_debt.credit_cards.shared_group_count')
	}

	const queryCounts = metrics.queryCounts?.value || {}
	for (const months of [1, 3, 6, 12]) {
		const key = `last_${months}m`
		if (!nearlyEqual(queryCounts[key], canonicalResult.query_analysis?.summary?.[key]?.total, 0)) {
			mismatch(`query_analysis.summary.${key}.total`)
		}
	}

	if (!nearlyEqual(metrics.primaryScore?.value?.value, canonicalResult.primary_rule_score?.score, 0)) {
		mismatch('primary_rule_score.score')
	}
	const scoreInputs = metrics.primaryScore?.inputMetrics || {}
	const canonicalScoreInputs = canonicalResult.primary_rule_score?.metrics
	const scoreInputPairs = [
		['totalAccountCount', scoreInputs.totalAccountCount, 'totalAccounts'],
		['nonBankLoanCount', scoreInputs.nonBankLoanCount, 'activeNonBankLoanCount'],
		['cardUtilizationRate', scoreInputs.cardUtilizationRate, 'cardUsageRate'],
		['q6', scoreInputs.q6, 'q6']
	]
	for (const [name, expected, projectedKey] of scoreInputPairs) {
		if (
			hasOwnValue(canonicalScoreInputs, projectedKey) &&
			!nearlyEqual(expected, canonicalScoreInputs[projectedKey], name === 'cardUtilizationRate' ? 0.0001 : 0)
		) {
			mismatch(`primary_rule_score.metrics.${name}`)
		}
	}
	const expectedBigInstallment = Number(scoreInputs.bigInstallment?.minor || 0) / 100
	if (
		hasOwnValue(canonicalScoreInputs, 'bigInstallmentTotal') &&
		!nearlyEqual(expectedBigInstallment, canonicalScoreInputs.bigInstallmentTotal, 0.001)
	) {
		mismatch('primary_rule_score.metrics.bigInstallmentTotal')
	}
	if (
		hasOwnValue(canonicalScoreInputs, 'bigInstallmentTotal') &&
		Boolean(scoreInputs.hasBigInstallment) !== (Number(canonicalScoreInputs.bigInstallmentTotal) > 0)
	) {
		mismatch('primary_rule_score.metrics.hasBigInstallment')
	}
	if (
		hasOwnValue(canonicalScoreInputs, 'sameDayTriggered') &&
		Boolean(Number(scoreInputs.sameDayInquiryDayCount) > 0) !== Boolean(canonicalScoreInputs.sameDayTriggered)
	) {
		mismatch('primary_rule_score.metrics.sameDayTriggered')
	}
}

function assertEvidenceV2Publication(canonicalResult, identity) {
	if (canonicalResult.derivation_meta?.evidence_mode !== 'evidence-v2') {
		throw authoritativeEvidenceError(
			'NON_AUTHORITATIVE_RESULT',
			'only evidence-v2 results may enter the authoritative cache'
		)
	}

	const artifacts = canonicalResult.evidence_v2
	const manifest = artifacts?.manifest
	const evidenceGraph = artifacts?.evidenceGraph
	const factLedger = artifacts?.factLedger
	const derivedAnalysis = artifacts?.derivedAnalysis
	if (
		artifacts?.contract !== 'rpt.credit/evidence-first-analysis/2.0' ||
		manifest?.schema !== 'rpt.credit/document-manifest/2.0' ||
		evidenceGraph?.schema !== 'rpt.credit/evidence-graph/2.0' ||
		factLedger?.schema !== 'rpt.credit/fact-ledger/2.0' ||
		derivedAnalysis?.schema !== 'rpt.credit/derived-analysis/2.0'
	) {
		throw authoritativeEvidenceError(
			'EVIDENCE_PUBLICATION_BLOCKED',
			'evidence-v2 publication artifacts are missing or use an unsupported contract'
		)
	}
	assertEvidenceIdentity(identity, canonicalResult, artifacts)

	assertEvidenceArtifactHash('mh_v2', manifest, 'manifestHash')
	assertEvidenceArtifactHash('eg_v2', evidenceGraph, 'evidenceGraphHash')
	assertEvidenceArtifactHash('fl_v2', factLedger, 'factLedgerHash')
	assertEvidenceArtifactHash('da_v2', derivedAnalysis, 'derivedAnalysisHash')

	const linked = Boolean(
		manifest.manifestHash &&
		evidenceGraph.manifestHash === manifest.manifestHash &&
		factLedger.evidenceGraphHash === evidenceGraph.evidenceGraphHash &&
		derivedAnalysis.inputs?.documentManifestHash === manifest.manifestHash &&
		derivedAnalysis.inputs?.evidenceGraphHash === evidenceGraph.evidenceGraphHash &&
		derivedAnalysis.inputs?.factLedgerHash === factLedger.factLedgerHash
	)
	const evidenceMeta = canonicalResult.evidence_meta
	const derivationMeta = canonicalResult.derivation_meta
	const metadataLinked = Boolean(
		evidenceMeta?.version === 'evidence-v2' &&
		evidenceMeta?.manifest_hash === manifest.manifestHash &&
		evidenceMeta?.evidence_hash === evidenceGraph.evidenceGraphHash &&
		evidenceMeta?.fact_hash === factLedger.factLedgerHash &&
		evidenceMeta?.metric_hash === derivedAnalysis.derivedAnalysisHash &&
		derivationMeta?.evidence_hash === evidenceGraph.evidenceGraphHash &&
		derivationMeta?.fact_hash === factLedger.factLedgerHash &&
		derivationMeta?.metric_hash === derivedAnalysis.derivedAnalysisHash
	)
	if (!linked || !metadataLinked) {
		throw authoritativeEvidenceError(
			'EVIDENCE_HASH_CHAIN_INVALID',
			'evidence-v2 hash chain is incomplete or inconsistent'
		)
	}

	const recomputedGate = evaluatePublicationGate({
		manifest,
		evidenceGraph,
		factLedger,
		derivedAnalysis
	}, { hashFn: authoritativeEvidenceHash })
	if (
		artifacts.status !== 'publishable' ||
		artifacts.publicationGate?.status !== 'passed' ||
		artifacts.publicationGate?.publishable !== true ||
		evidenceMeta?.status !== 'publishable' ||
		evidenceMeta?.publication_gate !== 'passed' ||
		!recomputedGate.publishable ||
		stableStringify(artifacts.publicationGate) !== stableStringify(recomputedGate)
	) {
		throw authoritativeEvidenceError(
			'EVIDENCE_PUBLICATION_BLOCKED',
			'evidence-v2 publication gate did not pass completely'
		)
	}

	const facts = Array.isArray(factLedger.facts) ? factLedger.facts : []
	const supportedFacts = facts.filter((fact) => fact?.status === 'accepted').length
	if (!canonicalValuesEqual(evidenceMeta.authoritative_scope, AUTHORITATIVE_SCOPE_FIELDS)) {
		throw authoritativeEvidenceError(
			'EVIDENCE_SCOPE_INVALID',
			'evidence-v2 authoritative scope must match the fixed field allowlist'
		)
	}
	if (
		Number(evidenceMeta.fact_count) !== facts.length ||
		Number(evidenceMeta.supported_fact_count) !== supportedFacts
	) {
		throw authoritativeEvidenceError(
			'EVIDENCE_HASH_CHAIN_INVALID',
			'evidence-v2 fact ledger metadata does not match the hashed ledger'
		)
	}

	const { factMap, relationMap } = assertDocumentEvidenceClosure(identity, artifacts)
	assertDerivedFactClosure(artifacts, factMap, relationMap)
	assertEvidenceDerivedProjection(canonicalResult, derivedAnalysis)
}

function assertCacheableCanonicalResult(canonicalResult, identity) {
	if (!canonicalResult || typeof canonicalResult !== 'object' || Array.isArray(canonicalResult)) {
		const error = new Error('analysis executor returned an invalid canonical result')
		error.code = 'INVALID_CANONICAL_RESULT'
		throw error
	}
	if (!identityRuntimeStatus().stableAcrossRestart) {
		throw authoritativeEvidenceError(
			'ANALYSIS_STABLE_SECRET_REQUIRED',
			'a stable analysis secret is required for authoritative publication and caching'
		)
	}
	if (canonicalResult.derivation_meta?.mode !== 'deterministic-v1') {
		const error = new Error('only deterministic-v1 results may enter the authoritative cache')
		error.code = 'NON_AUTHORITATIVE_RESULT'
		throw error
	}
	const coverage = canonicalResult._coverage && typeof canonicalResult._coverage === 'object'
		? canonicalResult._coverage
		: {}
	if (
		coverage.truncated === true ||
		coverage.salvaged_truncated === true ||
		coverage.llm_output_truncated === true ||
		String(coverage.llm_finish_reason || '') !== 'stop'
	) {
		const error = new Error('incomplete model output cannot enter the authoritative cache')
		error.code = 'INCOMPLETE_CANONICAL_RESULT'
		throw error
	}
	const invalidNumericPaths = REQUIRED_NUMERIC_RESULT_PATHS.filter(
		(path) => !Number.isFinite(valueAtPath(canonicalResult, path))
	)
	if (invalidNumericPaths.length > 0) {
		const error = new Error('authoritative deterministic result is missing required numeric fields')
		error.code = 'INCOMPLETE_CANONICAL_RESULT'
		throw error
	}
	assertEvidenceV2Publication(canonicalResult, identity)
	const maxBytes = boundedNumber(
		process.env.ANALYSIS_CACHE_MAX_RESULT_BYTES,
		DEFAULT_MAX_RESULT_BYTES,
		64 * 1024,
		16 * 1024 * 1024
	)
	const size = Buffer.byteLength(JSON.stringify(canonicalResult), 'utf8')
	if (size > maxBytes) {
		const error = new Error('canonical analysis result exceeds the cache safety limit')
		error.code = 'CANONICAL_RESULT_TOO_LARGE'
		throw error
	}
	return true
}

function validateCanonicalRecord(identity, payload, storedHash) {
	if (!payload || typeof payload !== 'object' || !payload.canonicalResult) return null
	if (payload.analysisKey !== identity.analysisKey) return null
	if (stableStringify(payload.versions) !== stableStringify(identity.versions)) return null
	assertCacheableCanonicalResult(payload.canonicalResult, identity)
	const resultHash = buildResultHash(payload.canonicalResult)
	if (resultHash !== payload.resultHash || resultHash !== storedHash) return null
	return { canonicalResult: payload.canonicalResult, resultHash }
}

function persistedIdentityBinding(identity) {
	return {
		schema: PERSISTED_IDENTITY_SCHEMA,
		analysisKey: identity.analysisKey,
		scopeHmac: identity.scopeHmac,
		documentId: identity.documentId,
		inputKind: identity.inputKind,
		versions: identity.versions
	}
}

function validateTaskCanonicalRecord(job, payload, storedHash, serializedBinding) {
	if (!job || typeof job !== 'object') return null
	let binding
	try {
		binding = JSON.parse(String(serializedBinding || ''))
	} catch (_) {
		return null
	}
	const currentVersions = analysisVersions()
	if (
		binding?.schema !== PERSISTED_IDENTITY_SCHEMA ||
		binding.analysisKey !== job.analysis_key ||
		binding.scopeHmac !== job.scope_hmac ||
		!/^doc_v2_[a-f0-9]{64}$/.test(String(job.document_id || '')) ||
		binding.documentId !== job.document_id ||
		binding.inputKind !== job.input_kind ||
		stableStringify(binding.versions) !== stableStringify(currentVersions)
	) return null
	const record = validateCanonicalRecord({
		analysisKey: binding.analysisKey,
		scopeHmac: binding.scopeHmac,
		documentId: binding.documentId,
		inputKind: binding.inputKind,
		versions: currentVersions
	}, payload, storedHash)
	return record ? { ...record, versions: currentVersions } : null
}

function loadPersistent(identity) {
	if (!persistentCacheEnabled()) return null
	const row = store.getAnalysisResult(identity.scopeHmac, identity.analysisKey)
	if (!row) return null
	try {
		const record = validateCanonicalRecord(
			identity,
			decryptPayload(row.encrypted_payload),
			row.result_hash
		)
		if (record) return record
	} catch (_) {
		// 不记录密文、原文或解密错误细节。
	}
	const terminalEvent = store.invalidateAnalysisResult(
		identity.scopeHmac,
		identity.analysisKey,
		'CACHE_INTEGRITY_FAILED'
	)
	if (terminalEvent) logTrustedTerminalEvent(terminalEvent, 'error')
	return null
}

function stableCompleteness(canonicalResult) {
	const coverage = canonicalResult && canonicalResult._coverage && typeof canonicalResult._coverage === 'object'
		? canonicalResult._coverage
		: {}
	const query = canonicalResult && canonicalResult.query_analysis && typeof canonicalResult.query_analysis === 'object'
		? canonicalResult.query_analysis
		: {}
	const loans = canonicalResult && canonicalResult.loan_details && typeof canonicalResult.loan_details === 'object'
		? canonicalResult.loan_details
		: {}
	return {
		input: coverage.truncated === true ? 'incomplete' : 'complete',
		modelOutput: coverage.llm_output_truncated === true ? 'incomplete' : 'complete',
		facts: coverage.salvaged_truncated === true ? 'incomplete' : 'complete',
		authority: 'server-deterministic',
		detailCounts: {
			bankLoans: Array.isArray(loans.bank_loans) ? loans.bank_loans.length : 0,
			nonBankLoans: Array.isArray(loans.non_bank_loans) ? loans.non_bank_loans.length : 0,
			cards: Array.isArray(canonicalResult && canonicalResult.credit_card_details)
				? canonicalResult.credit_card_details.length
				: 0,
			queries: Array.isArray(query.query_details) ? query.query_details.length : 0
		}
	}
}

function authoritativeScope(canonicalResult) {
	const declared = canonicalResult?.evidence_meta?.authoritative_scope
	const fields = Array.isArray(declared)
		? declared
		: Array.isArray(declared?.fields) ? declared.fields : []
	const requested = new Set(fields.filter((field) => typeof field === 'string'))
	return AUTHORITATIVE_SCOPE_FIELDS.filter((field) => requested.has(field))
}

function responseRecord(identity, record, cacheHit, cacheSource) {
	const completeness = stableCompleteness(record.canonicalResult)
	const runtime = cacheRuntimeStatus()
	const stableMeta = {
		analysisKey: identity.analysisKey,
		resultHash: record.resultHash,
		versions: identity.versions,
		inputKind: identity.inputKind,
		authoritative: true,
		authority: 'server-deterministic',
		authoritativeScope: authoritativeScope(record.canonicalResult),
		completeness,
		cachePolicy: {
			mode: runtime.mode,
			persistent: runtime.persistent,
			stableAcrossRestart: runtime.stableAcrossRestart
		}
	}
	const data = clone(record.canonicalResult)
	data.analysisKey = identity.analysisKey
	data.resultHash = record.resultHash
	data.derivation_meta = {
		...(data.derivation_meta || {}),
		analysis_key: identity.analysisKey,
		result_hash: record.resultHash,
		versions: identity.versions
	}
	data.analysis_meta = stableMeta
	// cacheHit/cacheSource describe this response, not the canonical result, so
	// attach them only after cloning. This keeps resultHash stable while clients
	// that consume `data` can still distinguish reuse from a newly generated run.
	data.analysis_meta.cacheHit = cacheHit
	data.analysis_meta.cacheSource = cacheSource
	return {
		data,
		analysis: {
			...stableMeta,
			cacheHit,
			cacheSource,
			cacheMode: runtime.mode
		}
	}
}

async function wait(ms) {
	await new Promise((resolve) => setTimeout(resolve, ms))
}

async function runWithPersistentLease(identity, execute) {
	const leaseMs = boundedNumber(
		process.env.ANALYSIS_JOB_LEASE_MS,
		20 * 60 * 1000,
		120000,
		60 * 60 * 1000
	)
	const waitMaxMs = boundedNumber(
		process.env.ANALYSIS_JOB_WAIT_MS,
		leaseMs + 60000,
		leaseMs,
		2 * 60 * 60 * 1000
	)
	const pollMs = boundedNumber(process.env.ANALYSIS_JOB_POLL_MS, 500, 100, 5000)
	const waitDeadline = Date.now() + waitMaxMs
	let observedForeignLease = false

	for (;;) {
		const cached = loadPersistent(identity)
		if (cached) {
			setMemory(identity, cached)
			return { ...cached, cacheHit: true, cacheSource: 'sqlite' }
		}

		const leaseOwner = crypto.randomUUID()
		const claim = store.claimAnalysisJob(
			identity.scopeHmac,
			identity.analysisKey,
			leaseOwner,
			leaseMs,
			{ allowFailedRetry: observedForeignLease === false }
		)
		if (!claim.claimed) {
			if (claim.state === 'failed') {
				const error = new Error('analysis attempt already reached a terminal failure')
				error.code = normalizedAnalysisErrorCode(claim.errorCode)
				error.errorClass = claim.errorClass
				error.failureStage = claim.errorStage
				try { error.diagnostic = JSON.parse(String(claim.diagnosticJson || '')) } catch (_) {}
				throw error
			}
			if (Date.now() >= waitDeadline) {
				const error = new Error('同一报告正在分析，请稍后重试')
				error.code = 'ANALYSIS_IN_PROGRESS_TIMEOUT'
				error.httpStatus = 503
				throw error
			}
			if (claim.state === 'processing') observedForeignLease = true
			await wait(pollMs)
			continue
		}

		const heartbeatMs = Math.max(30000, Math.floor(leaseMs / 3))
		const heartbeat = setInterval(() => {
			try {
				store.renewAnalysisJobLease(
					identity.scopeHmac,
					identity.analysisKey,
					leaseOwner,
					leaseMs
				)
			} catch (_) {}
		}, heartbeatMs)
		if (typeof heartbeat.unref === 'function') heartbeat.unref()
		try {
			const coordinatorIdentity = {
				...identity,
				supportRef: claim.supportRef,
				traceId: claim.traceId
			}
			const canonicalResult = normalizeCanonicalResult(await execute(coordinatorIdentity))
			assertCacheableCanonicalResult(canonicalResult, identity)
			const resultHash = buildResultHash(canonicalResult)
			const encryptedPayload = encryptPayload({
				analysisKey: identity.analysisKey,
				versions: identity.versions,
				resultHash,
				canonicalResult
			})
			const terminalEvent = store.completeAnalysisJob({
				scopeHmac: identity.scopeHmac,
				analysisKey: identity.analysisKey,
				leaseOwner,
				encryptedPayload,
				resultHash,
				versionsJson: stableStringify(persistedIdentityBinding(identity)),
				expiresAt: persistentExpiresAt()
			})
			logTrustedTerminalEvent(terminalEvent, 'info')
			const record = { canonicalResult, resultHash }
			setMemory(identity, record)
			return { ...record, cacheHit: false, cacheSource: 'generated' }
		} catch (error) {
			const failure = describeAnalysisFailure(error)
			const transitioned = store.failAnalysisJob(
				identity.scopeHmac,
				identity.analysisKey,
				leaseOwner,
				failure.code,
				failure
			)
			if (transitioned) {
				logTrustedTerminalEvent(
					store.getTrustedAnalysisEventBySupportRef(claim.supportRef),
					'error'
				)
			}
			throw error
		} finally {
			clearInterval(heartbeat)
		}
	}
}

async function runWithoutPersistentLease(identity, execute) {
	if (!warnedAboutMemoryOnly) {
		warnedAboutMemoryOnly = true
		logger.warn(
			{ mode: 'memory-process-only' },
			'analysis cache secret missing/short; restart and PM2 cross-process reuse are disabled'
		)
	}
	const canonicalResult = normalizeCanonicalResult(await execute(identity))
	assertCacheableCanonicalResult(canonicalResult, identity)
	const record = { canonicalResult, resultHash: buildResultHash(canonicalResult) }
	setMemory(identity, record)
	return { ...record, cacheHit: false, cacheSource: 'generated-memory-only' }
}

/**
 * 同一 scope + 内容 + 全版本键只允许一次执行。成功结果才进入缓存；
 * execute 抛错时既不写成功结果，也不留下不可重试的 processing job。
 */
async function runCoordinatedAnalysis({ content, scope, inputKind, execute }) {
	if (typeof execute !== 'function') throw new TypeError('analysis execute must be a function')
	const identity = buildAnalysisIdentity({ content, scope, inputKind })
	const memory = getMemory(identity)
	if (memory) return responseRecord(identity, memory, true, 'memory')

	const key = cacheKey(identity)
	const pending = inFlight.get(key)
	if (pending) {
		const record = await pending
		return responseRecord(identity, record, true, 'single-flight')
	}

	const task = (
		persistentCacheEnabled()
			? runWithPersistentLease(identity, execute)
			: runWithoutPersistentLease(identity, execute)
	)
	inFlight.set(key, task)
	try {
		const record = await task
		if (persistentCacheEnabled() && Date.now() - lastCleanupAt > 3600000) {
			lastCleanupAt = Date.now()
			try { store.cleanupAnalysisCache() } catch (_) {}
		}
		return responseRecord(
			identity,
			record,
			record.cacheHit === true,
			record.cacheSource || 'generated'
		)
	} finally {
		if (inFlight.get(key) === task) inFlight.delete(key)
	}
}

function resetAnalysisCoordinatorForTests() {
	memoryCache.clear()
	inFlight.clear()
	warnedAboutMemoryOnly = false
	lastCleanupAt = 0
}

module.exports = {
	runCoordinatedAnalysis,
	cacheRuntimeStatus,
	validateTaskCanonicalRecord,
	classifyAnalysisError,
	buildSafeAnalysisFailureDiagnostic,
	describeAnalysisFailure,
	logTrustedTerminalEvent,
	resetAnalysisCoordinatorForTests
}
