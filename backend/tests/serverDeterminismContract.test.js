'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const assert = require('node:assert/strict')

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')

function sourceBetween(start, end) {
	const startAt = serverSource.indexOf(start)
	const endAt = serverSource.indexOf(end, startAt + start.length)
	assert.notEqual(startAt, -1, start)
	assert.notEqual(endAt, -1, end)
	return serverSource.slice(startAt, endAt)
}

test('every report analysis entry point uses the coordinator before OCR or AI', () => {
	const textHandler = sourceBetween(
		'const analyzeTextHandler',
		'async function parsePdfHandler'
	)
	const singleImage = sourceBetween(
		"app.post('/api/analyze-image'",
		"app.post('/api/ocr-image-text'"
	)
	const pdf = sourceBetween(
		"app.post('/api/analyze'",
		'const analyzeImagesMem'
	)
	const images = sourceBetween(
		"app.post('/api/analyze-images'",
		"app.post('/api/ai/analyze'"
	)

	for (const block of [textHandler, singleImage, pdf, images]) {
		assert.match(block, /runCoordinatedAnalysis\s*\(\s*\{/)
		assert.match(block, /scope:\s*req\.analysisScope/)
		assert.match(block, /documentId:\s*identity\.documentId/)
	}
	assert.match(singleImage, /content:\s*\{\s*buffer:\s*buf/)
	assert.match(pdf, /content:\s*buf/)
	assert.match(images, /content:\s*files\.map/)
	assert.match(
		singleImage,
		/executeCreditTextAnalysis\(text,\s*\{[\s\S]*?inputKind:\s*'credit-report-image'/
	)
	assert.match(
		images,
		/executeCreditTextAnalysis\(text,\s*\{[\s\S]*?inputKind:\s*'credit-report-images-ordered'/
	)
})

test('unsupported OCR analysis stops before OCR, coordination, or model execution', () => {
	const pdfExecution = sourceBetween(
		'async function executePdfAnalysisBuffer',
		'analysisTaskService.configureAnalysisTaskExecutor'
	)
	const singleImage = sourceBetween(
		"app.post('/api/analyze-image'",
		"app.post('/api/ocr-image-text'"
	)
	const images = sourceBetween(
		"app.post('/api/analyze-images'",
		"app.post('/api/ai/analyze'"
	)

	assert.ok(pdfExecution.indexOf('assertCreditEvidenceSourceSupported') < pdfExecution.indexOf('scannedPdfToText'))
	for (const block of [singleImage, images]) {
		assert.ok(block.indexOf('assertCreditEvidenceSourceSupported') < block.indexOf('runCoordinatedAnalysis'))
		assert.ok(block.indexOf('assertCreditEvidenceSourceSupported') < block.indexOf('ocrImageBufferToText'))
	}
})

test('primary and fallback static bearer share one stable tenant scope', () => {
	const auth = sourceBetween(
		'function optionalAnalyzeBearer',
		"app.post('/api/parse-pdf'"
	)

	assert.match(auth, /ANALYSIS_STATIC_TENANT_ID/)
	assert.match(auth, /const serviceScope = `service:\$\{staticTenantId\}`/)
	assert.doesNotMatch(auth, /service:primary|service:fallback|development:anonymous/)
	assert.equal((auth.match(/req\.analysisScope = serviceScope/g) || []).length, 2)
})

test('production refuses process-local analysis identity/cache mode', () => {
	const gate = sourceBetween(
		'function ensureProductionSecurityConfigured',
		'ensureProductionSecurityConfigured()'
	)

	assert.match(gate, /ANALYSIS_CACHE_SECRET/)
	assert.match(gate, /ANALYSIS_KEY_SECRET/)
	assert.match(gate, />= 32/)
	assert.match(gate, /ANALYSIS_STATIC_TENANT_ID/)
	assert.match(gate, /RPT_RELEASE_ID/)
	assert.match(gate, /RPT_GIT_COMMIT/)
	assert.match(gate, /releaseRuntimeDeclared\s*&&\s*!isProductionRuntime/)
})

test('release markers refuse a dotenv-shadowing non-production process environment', () => {
	const result = spawnSync(process.execPath, ['-e', "require('./server')"], {
		cwd: path.join(__dirname, '..'),
		encoding: 'utf8',
		env: {
			...process.env,
			NODE_ENV: 'development',
			RPT_RELEASE_ID: 'release-env-shadow-test',
			RPT_GIT_COMMIT: 'a'.repeat(40)
		}
	})
	assert.notEqual(result.status, 0)
	assert.match(String(result.stderr), /NODE_ENV.*production/)
})

test('health publishes a safe immutable release identity', () => {
	const health = sourceBetween(
		"app.get('/health'",
		"app.get('/api/time'"
	)

	assert.match(serverSource, /resolveApiReleaseIdentity\(configuredReleaseId, configuredGitCommit\)/)
	assert.match(serverSource, /currentRuntimeSnapshot\(\)/)
	assert.match(serverSource, /trusted terminal release\/version identity is invalid/)
	assert.match(health, /release:\s*releaseIdentity/)
	assert.match(health, /production:\s*isProductionRuntime/)
	assert.match(health, /releaseConfigured:\s*releaseRuntimeDeclared/)
	assert.match(health, /runtimeReady\s*=\s*!releaseRuntimeDeclared\s*\|\|\s*runtime\.production\s*===\s*true/)
	assert.match(health, /runtime,\s*\n\s*analysisCache/)
})

test('analysis task acknowledgement accepts only terminal success or failure', () => {
	const ackRoute = sourceBetween(
		"app.post('/api/analysis/jobs/:jobId/ack'",
		"app.get('/api/analysis/jobs/:jobId'"
	)

	assert.match(ackRoute, /\['succeeded', 'failed'\]\.includes\(job\.status\)/)
	assert.match(ackRoute, /acknowledgeAnalysisTask\(req\.analysisScope, req\.params\.jobId\)/)
	assert.match(ackRoute, /supportRef:\s*job\.supportRef/)
	assert.match(ackRoute, /serverTime:\s*job\.serverTime/)
})

test('support lookup separates owner scope from authenticated operations trace access', () => {
	assert.match(
		serverSource,
		/app\.get\('\/api\/analysis\/support\/:supportRef', optionalAnalyzeBearer, requireJwtAnalysisTask/
	)
	assert.match(serverSource, /getAnalysisSupportEvent\(\s*req\.analysisScope,\s*req\.params\.supportRef/)
	assert.match(serverSource, /'\/api\/ops\/analysis\/support\/:supportRef'/)
	assert.match(serverSource, /requireRoles\(\['monitor'\]/)
	assert.match(serverSource, /getAnalysisSupportEventForOps\(req\.params\.supportRef\)/)
	const ownerProjection = sourceBetween('function ownerSupportEvent', '// An owner can re-read')
	assert.doesNotMatch(ownerProjection, /traceId|scopeHmac|jobId|analysisKey|documentId|resultHash/)
})

test('overview count mismatch has a closed public message and legacy preserves HTTP 422 in its body code', () => {
	const publicErrors = sourceBetween(
		'const PUBLIC_ANALYSIS_ERRORS',
		'function analysisExecutionError'
	)
	const executionBridge = sourceBetween(
		'function analysisExecutionError',
		'function assertCreditEvidenceSourceSupported'
	)
	const legacyAnalyze = sourceBetween(
		"app.post('/api/analyze'",
		'// Persisted async PDF analysis'
	)

	assert.match(
		publicErrors,
		/CHUNK_SOURCE_OVERVIEW_MISMATCH:\s*'报告概要与账户明细无法一致核验，已安全停止评分'/
	)
	assert.match(executionBridge, /error\.httpStatus = Number\(out && out\.httpStatus\) \|\| 502/)
	assert.match(legacyAnalyze, /const status = Number\(e && e\.httpStatus\) \|\| 500/)
	assert.match(legacyAnalyze, /code:\s*status >= 500 \? 500 : status/)
})
