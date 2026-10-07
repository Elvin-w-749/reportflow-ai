'use strict'

const path = require('path')
const fs = require('fs')
const test = require('node:test')
const assert = require('node:assert/strict')
const Database = require('better-sqlite3')

process.env.DATA_DIR = path.join(__dirname, '..', 'data-test', `coordinator-${process.pid}`)
process.env.ANALYSIS_CACHE_SECRET = 'local-test-analysis-secret-32-bytes-minimum'

const {
	runCoordinatedAnalysis,
	resetAnalysisCoordinatorForTests,
	cacheRuntimeStatus
} = require('../backend/services/analysisCoordinator')
const { analysisVersions, buildAnalysisIdentity, buildArtifactHash } = require('../backend/services/analysisIdentity')
const { finalizeExtractedCreditFacts } = require('../backend/services/creditAnalysisService')
const { stableCanonicalize } = require('../backend/services/creditEvidenceLedger')
const {
	AUTHORITATIVE_SCOPE,
	attachEvidenceV2,
	rehashEvidenceV2
} = require('./evidenceCanonicalFixture')

function artifactHash(prefix, payload) {
	return buildArtifactHash(prefix, stableCanonicalize(payload))
}

function withoutKey(value, key) {
	const copy = { ...value }
	delete copy[key]
	return copy
}

function canonical(marker, identity) {
	return attachEvidenceV2({
		derivation_meta: {
			mode: 'deterministic-v1',
			anchor_date: '2026-06-30',
			model_role: 'raw-facts-only',
			rules_version: 'credit-rules-deterministic-v3'
		},
		_coverage: {
			truncated: false,
			salvaged_truncated: false,
			llm_output_truncated: false,
			llm_finish_reason: 'stop',
			counts_declared: true,
			counts: {}
		},
		deterministic_dimensions: {
			totalAccountCount: 0,
			activeAccountCount: 0,
			settledAccountCount: 0,
			creditCardCount: 0,
			loanCount: 0,
			nonBankLoanCount: 0,
			totalDebt: 0,
			totalLoanBalance: 0,
			usedCardLimit: 0,
			cardUtilizationUsed: 0,
			debtRatio: 0,
			cardUtilizationRate: 0,
			q1: 0,
			q3: 0,
			q6: 0,
			q12: 0,
			loanQueryCount: 0,
			cardQueryCount: 0,
			overdueCount: 0,
			m1Count: 0,
			m2Count: 0,
			m3Count: 0
		},
		credit_debt: {
			total_debt: 0,
			debt_ratio: 0,
			credit_loans: { total_balance: 0 },
			credit_cards: {
				total_limit: 0,
				total_used: 0,
				utilization_used: 0,
				usage_rate: 0,
				shared_group_count: 0
			}
		},
		query_analysis: {
			summary: {
				last_1m: { total: 0 },
				last_3m: { total: 0 },
				last_6m: { total: 0 },
				last_12m: { total: 0 }
			}
		},
		primary_rule_score: {
			score: 100,
			metrics: {
				totalAccounts: 0,
				activeNonBankLoanCount: 0,
				cardUsageRate: 0,
				bigInstallmentTotal: 0,
				q6: 0,
				sameDayTriggered: false
			}
		},
		six_dimensions: {
			credit_history: 80,
			query_frequency: 90,
			account_structure: 70,
			repayment_record: 100
		},
		basic_info: { name: `SENSITIVE_SENTINEL_${marker}` },
		marker
	}, identity)
}

function sharedCreditCanonical(identity) {
	const lines = [
		'个人信用报告 报告日期：2026年6月30日',
		'同一银行 2025年1月1日 尾号1111 人民币 授信额度：20,000.00元 已用额度：10,000.00元 共享额度组：G1',
		'同一银行 2025年2月1日 尾号2222 人民币 授信额度：20,000.00元 已用额度：8,000.00元 共享额度组：G1'
	]
	let pageText = ''
	const structuredLines = lines.map((text, index) => {
		if (index > 0) pageText += '\n'
		const charStart = pageText.length
		pageText += text
		return { text, charStart, charEnd: pageText.length, bbox: [10, 10 + index * 20, 590, 25 + index * 20] }
	})
	const counts = Object.fromEntries([
		['bank_loans', 0], ['non_bank_loans', 0], ['settled_loans', 0],
		['historical_overdue_loans', 0], ['credit_card_details', 2],
		['credit_card_details_cancelled', 0], ['query_details', 0], ['self_queries', 0],
		['overdue_details', 0], ['public_records', 0], ['guarantee_records', 0],
		['loan_history', 0]
	].map(([name, total]) => [name, { total, listed: total }]))
	const facts = {
		meta: { report_date: '2026-06-30' },
		basic_info: {},
		loan_details: { bank_loans: [], non_bank_loans: [], settled_loans: [], historical_overdue_loans: [] },
		credit_card_details: [
			{ institution: '同一银行', start_date: '2025-01-01', card_tail: '1111', currency: 'CNY', credit_limit: 20000, used_limit: 10000, status: '正常' },
			{ institution: '同一银行', start_date: '2025-02-01', card_tail: '2222', currency: 'CNY', credit_limit: 20000, used_limit: 8000, status: '正常' }
		],
		credit_card_details_cancelled: [],
		query_analysis: { query_details: [], self_queries: [] },
		overdue_info: { has_overdue: false, total_overdue_accounts: 0, details: [] },
		public_records: { has_record: false, items: [] },
		guarantee_records: { total_amount: 0, items: [] },
		loan_history: { trend_data: [] },
		_coverage: { truncated: false, counts }
	}
	const result = finalizeExtractedCreditFacts(facts, pageText, {
		evidenceRequired: true,
		inputKind: identity.inputKind,
		documentId: identity.documentId,
		evidenceContext: {
			version: 'pdf-structured-v1',
			sourceMode: 'pdf-text',
			expectedPageCount: 1,
			complete: true,
			pages: [{
				pageNumber: 1,
				bounds: [0, 0, 600, 800],
				text: pageText,
				blocks: structuredLines.map((line) => ({ ...line, lines: [line] }))
			}]
		},
		sourceVerifiedCounts: {
			active_loans: { count: 0, basis: 'source-test-v1' },
			credit_card_details: { count: 2, basis: 'source-test-v1' },
			query_details: { count: 0, basis: 'source-test-v1' }
		}
	})
	result._coverage = {
		...(result._coverage || {}),
		truncated: false,
		salvaged_truncated: false,
		llm_output_truncated: false,
		llm_finish_reason: 'stop'
	}
	return result
}

function foreignLoanCanonical(identity) {
	const lines = [
		'个人信用报告 报告日期：2026年6月30日',
		'1. 2025年1月1日甲银行发放贷款，美元，贷款余额：10,000元。'
	]
	let pageText = ''
	const structuredLines = lines.map((text, index) => {
		if (index > 0) pageText += '\n'
		const charStart = pageText.length
		pageText += text
		return { text, charStart, charEnd: pageText.length, bbox: [10, 10 + index * 20, 590, 25 + index * 20] }
	})
	const counts = Object.fromEntries([
		['bank_loans', 1], ['non_bank_loans', 0], ['settled_loans', 0],
		['historical_overdue_loans', 0], ['credit_card_details', 0],
		['credit_card_details_cancelled', 0], ['query_details', 0], ['self_queries', 0],
		['overdue_details', 0], ['public_records', 0], ['guarantee_records', 0],
		['loan_history', 0]
	].map(([name, total]) => [name, { total, listed: total }]))
	const facts = {
		meta: { report_date: '2026-06-30' },
		basic_info: {},
		loan_details: {
			bank_loans: [{
				institution: '甲银行', start_date: '2025-01-01',
				currency: 'USD', balance: 10000, status: '正常'
			}],
			non_bank_loans: [], settled_loans: [], historical_overdue_loans: []
		},
		credit_card_details: [],
		credit_card_details_cancelled: [],
		query_analysis: { query_details: [], self_queries: [] },
		overdue_info: { has_overdue: false, total_overdue_accounts: 0, details: [] },
		public_records: { has_record: false, items: [] },
		guarantee_records: { total_amount: 0, items: [] },
		loan_history: { trend_data: [] },
		_coverage: { truncated: false, counts }
	}
	const result = finalizeExtractedCreditFacts(facts, pageText, {
		evidenceRequired: true,
		inputKind: identity.inputKind,
		documentId: identity.documentId,
		evidenceContext: {
			version: 'pdf-structured-v1',
			sourceMode: 'pdf-text',
			expectedPageCount: 1,
			complete: true,
			pages: [{
				pageNumber: 1,
				bounds: [0, 0, 600, 800],
				text: pageText,
				blocks: structuredLines.map((line) => ({ ...line, lines: [line] }))
			}]
		},
		sourceVerifiedCounts: {
			active_loans: { count: 1, basis: 'source-test-v1' },
			credit_card_details: { count: 0, basis: 'source-test-v1' },
			query_details: { count: 0, basis: 'source-test-v1' }
		}
	})
	result._coverage = {
		...(result._coverage || {}),
		truncated: false,
		salvaged_truncated: false,
		llm_output_truncated: false,
		llm_finish_reason: 'stop'
	}
	return result
}

test('same scope/content/version is single-flight and reuses the canonical success', async () => {
	resetAnalysisCoordinatorForTests()
	let executions = 0
	const request = {
		content: Buffer.from('same-pdf-bytes'),
		scope: 'user:A',
		inputKind: 'credit-report-pdf',
		execute: async (identity) => {
			executions += 1
			await new Promise((resolve) => setTimeout(resolve, 30))
			return canonical(101, identity)
		}
	}
	const results = await Promise.all(
		Array.from({ length: 8 }, () => runCoordinatedAnalysis(request))
	)

	assert.equal(executions, 1)
	assert.equal(new Set(results.map((item) => item.analysis.analysisKey)).size, 1)
	assert.equal(new Set(results.map((item) => item.analysis.resultHash)).size, 1)
	assert.equal(results.filter((item) => item.analysis.cacheHit === false).length, 1)
	assert.equal(results[0].data.analysis_meta.authoritative, true)
	assert.equal(typeof results[0].data.analysis_meta.cacheHit, 'boolean')
	assert.equal(results[0].data.analysis_meta.cacheSource, 'generated')
	assert.equal(results[0].data.analysis_meta.authority, 'server-deterministic')
	assert.deepEqual(results[0].analysis.authoritativeScope, AUTHORITATIVE_SCOPE)
	assert.deepEqual(results[0].data.analysis_meta.authoritativeScope, AUTHORITATIVE_SCOPE)
	assert.equal(results[0].analysis.authoritativeScope.includes('six_dimensions.credit_history'), false)
	assert.equal(results[0].data.analysis_meta.versions.model, 'deepseek-v4-flash')

	resetAnalysisCoordinatorForTests()
	const persisted = await runCoordinatedAnalysis({
		...request,
		execute: async () => {
			throw new Error('persistent cache should have prevented execution')
		}
	})
	assert.equal(persisted.analysis.cacheHit, true)
	assert.equal(persisted.data.marker, 101)
	assert.equal(persisted.analysis.resultHash, results[0].analysis.resultHash)
	const sqliteBytes = fs.readFileSync(path.join(process.env.DATA_DIR, 'db.sqlite'))
	assert.equal(sqliteBytes.includes(Buffer.from('SENSITIVE_SENTINEL_101')), false)
})

test('two user scopes cannot read each other canonical result for the same bytes', async () => {
	resetAnalysisCoordinatorForTests()
	let executions = 0
	const run = (scope) => runCoordinatedAnalysis({
		content: Buffer.from('scope-isolation-pdf'),
		scope,
		inputKind: 'credit-report-pdf',
		execute: async (identity) => canonical(++executions, identity)
	})
	const first = await run('user:A')
	const second = await run('user:B')

	assert.equal(executions, 2)
	assert.notEqual(first.analysis.analysisKey, second.analysis.analysisKey)
	assert.notEqual(first.analysis.resultHash, second.analysis.resultHash)
})

test('failed work is never cached and can be retried safely', async () => {
	resetAnalysisCoordinatorForTests()
	let executions = 0
	const request = {
		content: Buffer.from('retry-after-failure-pdf'),
		scope: 'user:A',
		inputKind: 'credit-report-pdf'
	}
	await assert.rejects(
		runCoordinatedAnalysis({
			...request,
			execute: async () => {
				executions += 1
				const error = new Error('upstream failed')
				error.code = 'ANALYSIS_UPSTREAM_FAILED'
				throw error
			}
		}),
		/failed/
	)
	const success = await runCoordinatedAnalysis({
		...request,
		execute: async (identity) => {
			executions += 1
			return canonical(202, identity)
		}
	})
	assert.equal(executions, 2)
	assert.equal(success.analysis.cacheHit, false)
})

test('a foreign waiter observes a permanent failure without rerunning the model', async () => {
	resetAnalysisCoordinatorForTests()
	let executions = 0
	let releaseExecution
	let markStarted
	const started = new Promise((resolve) => { markStarted = resolve })
	const gate = new Promise((resolve) => { releaseExecution = resolve })
	const request = {
		content: Buffer.from('foreign-waiter-permanent-failure-pdf'),
		scope: 'user:foreign-waiter',
		inputKind: 'credit-report-pdf'
	}
	const first = runCoordinatedAnalysis({
		...request,
		execute: async () => {
			executions += 1
			markStarted()
			await gate
			throw Object.assign(new Error('schema rejected'), { code: 'FACT_SCHEMA_INVALID' })
		}
	})
	await started
	// Simulate a second process, which has no access to this process's inFlight map.
	resetAnalysisCoordinatorForTests()
	const waiter = runCoordinatedAnalysis({
		...request,
		execute: async () => {
			executions += 1
			throw new Error('foreign waiter must not execute')
		}
	})
	releaseExecution()
	await assert.rejects(first, (error) => error.code === 'FACT_SCHEMA_INVALID')
	await assert.rejects(waiter, (error) => error.code === 'FACT_SCHEMA_INVALID')
	assert.equal(executions, 1)
})

test('analysis identity separates release versions while document identity stays bound to tenant and ordered bytes', () => {
	const originalRuleVersion = process.env.CREDIT_RULE_VERSION
	process.env.CREDIT_RULE_VERSION = 'rules-A'
	const first = buildAnalysisIdentity({
		content: [
			{ label: 'image/jpeg', buffer: Buffer.from('page-1') },
			{ label: 'image/jpeg', buffer: Buffer.from('page-2') }
		],
		scope: 'user:A',
		inputKind: 'credit-report-images'
	})
	process.env.CREDIT_RULE_VERSION = 'rules-B'
	const versionChanged = buildAnalysisIdentity({
		content: [
			{ label: 'image/jpeg', buffer: Buffer.from('page-1') },
			{ label: 'image/jpeg', buffer: Buffer.from('page-2') }
		],
		scope: 'user:A',
		inputKind: 'credit-report-images'
	})
	process.env.CREDIT_RULE_VERSION = 'rules-A'
	const orderChanged = buildAnalysisIdentity({
		content: [
			{ label: 'image/jpeg', buffer: Buffer.from('page-2') },
			{ label: 'image/jpeg', buffer: Buffer.from('page-1') }
		],
		scope: 'user:A',
		inputKind: 'credit-report-images'
	})
	const tenantChanged = buildAnalysisIdentity({
		content: [
			{ label: 'image/jpeg', buffer: Buffer.from('page-1') },
			{ label: 'image/jpeg', buffer: Buffer.from('page-2') }
		],
		scope: 'user:B',
		inputKind: 'credit-report-images'
	})
	if (originalRuleVersion === undefined) delete process.env.CREDIT_RULE_VERSION
	else process.env.CREDIT_RULE_VERSION = originalRuleVersion

	assert.notEqual(first.analysisKey, versionChanged.analysisKey)
	assert.notEqual(first.analysisKey, orderChanged.analysisKey)
	assert.match(first.documentId, /^doc_v2_[a-f0-9]{64}$/)
	assert.equal(first.documentId, versionChanged.documentId)
	assert.notEqual(first.documentId, orderChanged.documentId)
	assert.notEqual(first.documentId, tenantChanged.documentId)
	assert.equal(cacheRuntimeStatus().crossProcessSingleFlight, true)
})

test('global card binding v14 pipeline invalidates the v13 cache key without changing the public evidence schema', () => {
	const originalPipelineVersion = process.env.CREDIT_ANALYSIS_PIPELINE_VERSION
	const originalSchemaVersion = process.env.CREDIT_SCHEMA_VERSION
	const originalRuleVersion = process.env.CREDIT_RULE_VERSION
	let versions
	let globalBindingIdentity
	let v13PipelineIdentity
	try {
		delete process.env.CREDIT_ANALYSIS_PIPELINE_VERSION
		delete process.env.CREDIT_SCHEMA_VERSION
		delete process.env.CREDIT_RULE_VERSION
		versions = analysisVersions()
		const request = {
			content: Buffer.from('same-credit-report-bytes'),
			scope: 'user:record-bundle-cache-isolation',
			inputKind: 'credit-report-pdf'
		}
		globalBindingIdentity = buildAnalysisIdentity(request)
		process.env.CREDIT_ANALYSIS_PIPELINE_VERSION = 'credit-analysis-v13-parenthetical-cny-account'
		v13PipelineIdentity = buildAnalysisIdentity(request)
	} finally {
		if (originalPipelineVersion === undefined) delete process.env.CREDIT_ANALYSIS_PIPELINE_VERSION
		else process.env.CREDIT_ANALYSIS_PIPELINE_VERSION = originalPipelineVersion
		if (originalSchemaVersion === undefined) delete process.env.CREDIT_SCHEMA_VERSION
		else process.env.CREDIT_SCHEMA_VERSION = originalSchemaVersion
		if (originalRuleVersion === undefined) delete process.env.CREDIT_RULE_VERSION
		else process.env.CREDIT_RULE_VERSION = originalRuleVersion
	}

	assert.equal(versions.pipeline, 'credit-analysis-v14-global-card-binding-currency-closed')
	assert.equal(versions.evidenceBinder, 'deterministic-global-card-binding-v8-notactivated-closed-state')
	assert.equal(versions.evidenceContract, 'evidence-ledger-v2.1')
	assert.equal(versions.derivedTrace, 'derived-analysis-provenance-v4')
	assert.equal(versions.rule, 'credit-rules-deterministic-v3')
	assert.equal(versions.schema, 'credit-facts-schema-v6-evidence-closure')
	assert.match(versions.evidenceHash, /^[a-f0-9]{64}$/)
	assert.equal(globalBindingIdentity.documentId, v13PipelineIdentity.documentId)
	assert.notEqual(globalBindingIdentity.analysisKey, v13PipelineIdentity.analysisKey)
})

test('authoritative cache rejects a valid evidence chain replayed from another document', async () => {
	resetAnalysisCoordinatorForTests()
	const scope = 'user:replay-owner'
	const inputKind = 'credit-report-pdf'
	const foreignIdentity = buildAnalysisIdentity({
		content: Buffer.from('foreign-document-bytes'),
		scope,
		inputKind
	})
	const replay = canonical(501, foreignIdentity)

	await assert.rejects(
		runCoordinatedAnalysis({
			content: Buffer.from('current-document-bytes'),
			scope,
			inputKind,
			execute: async () => replay
		}),
		(error) => error && error.code === 'EVIDENCE_IDENTITY_MISMATCH'
	)
})

test('authoritative cache rejects a fully rehashed evidence chain from another version', async () => {
	resetAnalysisCoordinatorForTests()
	const request = {
		content: Buffer.from('cross-version-replay-bytes'),
		scope: 'user:version-owner',
		inputKind: 'credit-report-pdf'
	}
	const currentIdentity = buildAnalysisIdentity(request)
	const previousVersionIdentity = {
		...currentIdentity,
		versions: {
			...currentIdentity.versions,
			evidenceHash: `previous-${currentIdentity.versions.evidenceHash}`
		}
	}
	const replay = canonical(502, previousVersionIdentity)

	await assert.rejects(
		runCoordinatedAnalysis({
			...request,
			execute: async () => replay
		}),
		(error) => error && error.code === 'EVIDENCE_IDENTITY_MISMATCH'
	)
})

test('empty graph cannot support an accepted critical fact even after every top-level hash is refreshed', async () => {
	resetAnalysisCoordinatorForTests()
	await assert.rejects(
		runCoordinatedAnalysis({
			content: Buffer.from('empty-graph-accepted-fact'),
			scope: 'user:A',
			inputKind: 'credit-report-pdf',
			execute: async (identity) => {
				const result = canonical(503, identity)
				result.evidence_v2.evidenceGraph.blocks = []
				result.evidence_v2.evidenceGraph.nodes = []
				result.evidence_v2.evidenceGraph.coverage.blockCount = 0
				result.evidence_v2.evidenceGraph.coverage.retainedBlockCount = 0
				result.evidence_v2.evidenceGraph.coverage.nodeCount = 0
				return rehashEvidenceV2(result)
			}
		}),
		(error) => error && error.code === 'EVIDENCE_CLOSURE_INVALID'
	)
})

test('accepted shared-credit relations require their source identity nodes', async () => {
	resetAnalysisCoordinatorForTests()
	await assert.rejects(
		runCoordinatedAnalysis({
			content: Buffer.from('shared-credit-node-removal-pdf'),
			scope: 'user:shared-node-removal',
			inputKind: 'credit-report-pdf',
			execute: async (identity) => {
				const tampered = sharedCreditCanonical(identity)
				tampered.evidence_v2.evidenceGraph.nodes = tampered.evidence_v2.evidenceGraph.nodes.filter(
					(node) => node.field !== 'shared_group_identity'
				)
				tampered.evidence_v2.evidenceGraph.coverage.nodeCount = tampered.evidence_v2.evidenceGraph.nodes.length
				return rehashEvidenceV2(tampered)
			}
		}),
		(error) => error && error.code === 'EVIDENCE_CLOSURE_INVALID'
	)
})

test('shared facility trace must consume its accepted relation IDs', async () => {
	resetAnalysisCoordinatorForTests()
	await assert.rejects(
		runCoordinatedAnalysis({
			content: Buffer.from('shared-credit-trace-relation-removal-pdf'),
			scope: 'user:shared-trace-removal',
			inputKind: 'credit-report-pdf',
			execute: async (identity) => {
				const tampered = sharedCreditCanonical(identity)
				tampered.evidence_v2.derivedAnalysis.metrics.cardUtilization.facilityTrace[0].inputRelationIds = []
				return rehashEvidenceV2(tampered)
			}
		}),
		(error) => error && error.code === 'EVIDENCE_DERIVATION_INVALID'
	)
})

test('fully rehashed query windows are replayed from accepted query facts', async () => {
	resetAnalysisCoordinatorForTests()
	await assert.rejects(
		runCoordinatedAnalysis({
			content: Buffer.from('rehashed-forged-query-windows-pdf'),
			scope: 'user:forged-query-windows',
			inputKind: 'credit-report-pdf',
			execute: async (identity) => {
				const tampered = canonical(503.5, identity)
				const queryMetric = tampered.evidence_v2.derivedAnalysis.metrics.queryCounts
				const forged = { last_1m: 1, last_3m: 3, last_6m: 7, last_12m: 13 }
				for (const [key, total] of Object.entries(forged)) {
					queryMetric.value[key] = total
					queryMetric.value.by_window[key] = {
						total,
						bank: 0,
						non_bank: 0,
						unknown: total
					}
					tampered.query_analysis.summary[key].total = total
				}
				return rehashEvidenceV2(tampered)
			}
		}),
		(error) => error && error.code === 'EVIDENCE_DERIVATION_INVALID'
	)
})

test('fully rehashed primary score inputs and deduction trace are replayed from facts', async () => {
	resetAnalysisCoordinatorForTests()
	await assert.rejects(
		runCoordinatedAnalysis({
			content: Buffer.from('rehashed-forged-primary-score-pdf'),
			scope: 'user:forged-primary-score',
			inputKind: 'credit-report-pdf',
			execute: async (identity) => {
				const tampered = canonical(503.75, identity)
				const scoreMetric = tampered.evidence_v2.derivedAnalysis.metrics.primaryScore
				scoreMetric.value.value = 97
				scoreMetric.totalDeduction = 3
				scoreMetric.inputMetrics.totalAccountCount = 4
				scoreMetric.deductionTrace = [{ ruleId: 'ACC_GT_3', points: 3 }]
				tampered.primary_rule_score.score = 97
				tampered.primary_rule_score.metrics.totalAccounts = 4
				return rehashEvidenceV2(tampered)
			}
		}),
		(error) => error && error.code === 'EVIDENCE_DERIVATION_INVALID'
	)
})

test('fully rehashed card money cannot disagree with its accepted currency fact', async () => {
	resetAnalysisCoordinatorForTests()
	await assert.rejects(
		runCoordinatedAnalysis({
			content: Buffer.from('rehashed-card-money-currency-mismatch-pdf'),
			scope: 'user:card-money-currency-mismatch',
			inputKind: 'credit-report-pdf',
			execute: async (identity) => {
				const tampered = sharedCreditCanonical(identity)
				const artifacts = tampered.evidence_v2
				const node = artifacts.evidenceGraph.nodes.find((item) =>
					item.entityKind === 'card' && item.field === 'credit_limit'
				)
				const fact = artifacts.factLedger.facts.find((item) =>
					item.status === 'accepted' && item.targetId === node.targetId
				)
				const oldFactId = fact.factId
				node.value = { ...node.value, currency: 'USD' }
				node.valueDigest = artifactHash('val_v2', node.value)
				node.targetId = artifactHash('tgt_v2', {
					entityId: node.entityId,
					field: node.field,
					valueDigest: node.valueDigest
				})
				node.nodeId = artifactHash('ev_v2', withoutKey(node, 'nodeId'))
				fact.targetId = node.targetId
				fact.value = { ...node.value }
				fact.evidenceNodeIds = [node.nodeId]
				fact.factId = artifactHash('fact_v2', withoutKey(fact, 'factId'))
				for (const metric of Object.values(artifacts.derivedAnalysis.metrics)) {
					if (!Array.isArray(metric?.inputFactIds)) continue
					metric.inputFactIds = metric.inputFactIds
						.map((factId) => factId === oldFactId ? fact.factId : factId)
						.sort()
				}
				return rehashEvidenceV2(tampered)
			}
		}),
		(error) => error && error.code === 'EVIDENCE_DERIVATION_INVALID'
	)
})

test('fully rehashed loan balance cannot disagree with its accepted currency fact', async () => {
	resetAnalysisCoordinatorForTests()
	await assert.rejects(
		runCoordinatedAnalysis({
			content: Buffer.from('rehashed-loan-money-currency-mismatch-pdf'),
			scope: 'user:loan-money-currency-mismatch',
			inputKind: 'credit-report-pdf',
			execute: async (identity) => {
				const tampered = foreignLoanCanonical(identity)
				const artifacts = tampered.evidence_v2
				const node = artifacts.evidenceGraph.nodes.find((item) =>
					item.entityKind === 'loan' && item.field === 'balance'
				)
				const fact = artifacts.factLedger.facts.find((item) =>
					item.status === 'accepted' && item.targetId === node.targetId
				)
				const oldFactId = fact.factId
				node.value = { ...node.value, currency: 'CNY' }
				node.valueDigest = artifactHash('val_v2', node.value)
				node.targetId = artifactHash('tgt_v2', {
					entityId: node.entityId,
					field: node.field,
					valueDigest: node.valueDigest
				})
				node.nodeId = artifactHash('ev_v2', withoutKey(node, 'nodeId'))
				fact.targetId = node.targetId
				fact.value = { ...node.value }
				fact.evidenceNodeIds = [node.nodeId]
				fact.factId = artifactHash('fact_v2', withoutKey(fact, 'factId'))
				for (const metric of Object.values(artifacts.derivedAnalysis.metrics)) {
					if (!Array.isArray(metric?.inputFactIds)) continue
					metric.inputFactIds = metric.inputFactIds
						.map((factId) => factId === oldFactId ? fact.factId : factId)
						.sort()
				}
				return rehashEvidenceV2(tampered)
			}
		}),
		(error) => error && error.code === 'EVIDENCE_DERIVATION_INVALID'
	)
})

test('authoritative publication requires a configured secret stable across restart', async () => {
	const oldCacheSecret = process.env.ANALYSIS_CACHE_SECRET
	const oldKeySecret = process.env.ANALYSIS_KEY_SECRET
	delete process.env.ANALYSIS_CACHE_SECRET
	delete process.env.ANALYSIS_KEY_SECRET
	resetAnalysisCoordinatorForTests()
	try {
		await assert.rejects(
			runCoordinatedAnalysis({
				content: Buffer.from('process-local-secret-result'),
				scope: 'user:A',
				inputKind: 'credit-report-pdf',
				execute: async (identity) => canonical(504, identity)
			}),
			(error) => error && error.code === 'ANALYSIS_STABLE_SECRET_REQUIRED'
		)
	} finally {
		if (oldCacheSecret === undefined) delete process.env.ANALYSIS_CACHE_SECRET
		else process.env.ANALYSIS_CACHE_SECRET = oldCacheSecret
		if (oldKeySecret === undefined) delete process.env.ANALYSIS_KEY_SECRET
		else process.env.ANALYSIS_KEY_SECRET = oldKeySecret
		resetAnalysisCoordinatorForTests()
	}
})

test('missing or anonymous scope is rejected before cache lookup', () => {
	for (const scope of [undefined, '', 'anonymous', 'development:anonymous']) {
		assert.throws(
			() => buildAnalysisIdentity({
				content: Buffer.from('same-private-report'),
				scope,
				inputKind: 'credit-report-pdf'
			}),
			(error) => error && error.code === 'ANALYSIS_SCOPE_REQUIRED'
		)
	}
})

test('incomplete or non-authoritative results cannot become standard answers', async () => {
	resetAnalysisCoordinatorForTests()
	await assert.rejects(
		runCoordinatedAnalysis({
			content: Buffer.from('truncated-result-pdf'),
			scope: 'user:A',
			inputKind: 'credit-report-pdf',
			execute: async (identity) => ({
				...canonical(303, identity),
				_coverage: {
					truncated: false,
					llm_output_truncated: true,
					llm_finish_reason: 'length'
				}
			})
		}),
		(error) => error && error.code === 'INCOMPLETE_CANONICAL_RESULT'
	)
})

test('legacy-v1 text analysis is rejected by the authoritative cache', async () => {
	resetAnalysisCoordinatorForTests()
	await assert.rejects(
		runCoordinatedAnalysis({
			content: 'legacy-v1-result-text',
			scope: 'user:A',
			inputKind: 'credit-report-text',
			execute: async (identity) => {
				const legacy = canonical(305, identity)
				delete legacy.evidence_v2
				delete legacy.evidence_meta
				delete legacy.derivation_meta.evidence_mode
				delete legacy.derivation_meta.evidence_hash
				delete legacy.derivation_meta.fact_hash
				delete legacy.derivation_meta.metric_hash
				return legacy
			}
		}),
		(error) => error && error.code === 'NON_AUTHORITATIVE_RESULT'
	)
})

test('self-declared publication pass is rejected when the complete gate record is blocked', async () => {
	resetAnalysisCoordinatorForTests()
	await assert.rejects(
		runCoordinatedAnalysis({
			content: Buffer.from('blocked-publication-gate-pdf'),
			scope: 'user:A',
			inputKind: 'credit-report-pdf',
			execute: async (identity) => {
				const blocked = canonical(305.5, identity)
				blocked.evidence_v2.publicationGate.status = 'blocked'
				blocked.evidence_v2.publicationGate.publishable = false
				blocked.evidence_v2.publicationGate.failedChecks = ['LEDGER_READY']
				return blocked
			}
		}),
		(error) => error && error.code === 'EVIDENCE_PUBLICATION_BLOCKED'
	)
})

test('authoritative scope rejects unverified legacy and six-dimension fields', async () => {
	resetAnalysisCoordinatorForTests()
	await assert.rejects(
		runCoordinatedAnalysis({
			content: Buffer.from('expanded-authoritative-scope-pdf'),
			scope: 'user:A',
			inputKind: 'credit-report-pdf',
			execute: async (identity) => {
				const expanded = canonical(305.75, identity)
				expanded.evidence_meta.authoritative_scope.push('six_dimensions.credit_history')
				return expanded
			}
		}),
		(error) => error && error.code === 'EVIDENCE_SCOPE_INVALID'
	)
})

test('tampered evidence artifact content is rejected even when linked hashes were not changed', async () => {
	resetAnalysisCoordinatorForTests()
	await assert.rejects(
		runCoordinatedAnalysis({
			content: Buffer.from('tampered-evidence-hash-pdf'),
			scope: 'user:A',
			inputKind: 'credit-report-pdf',
			execute: async (identity) => {
				const tampered = canonical(306, identity)
				tampered.evidence_v2.manifest.input.textLength += 1
				return tampered
			}
		}),
		(error) => error && error.code === 'EVIDENCE_HASH_CHAIN_INVALID'
	)
})

test('canonical score inputs cannot diverge from the hashed evidence derivation', async () => {
	resetAnalysisCoordinatorForTests()
	await assert.rejects(
		runCoordinatedAnalysis({
			content: Buffer.from('tampered-score-input-pdf'),
			scope: 'user:A',
			inputKind: 'credit-report-pdf',
			execute: async (identity) => {
				const tampered = canonical(307, identity)
				tampered.primary_rule_score.metrics.q6 = 1
				return tampered
			}
		}),
		(error) => error && error.code === 'EVIDENCE_DERIVATION_MISMATCH'
	)
})

test('canonical shared credit group count cannot exceed the hashed facility trace', async () => {
	resetAnalysisCoordinatorForTests()
	await assert.rejects(
		runCoordinatedAnalysis({
			content: Buffer.from('tampered-shared-group-count-pdf'),
			scope: 'user:A',
			inputKind: 'credit-report-pdf',
			execute: async (identity) => {
				const tampered = canonical(307.5, identity)
				tampered.credit_debt.credit_cards.shared_group_count = 1
				return tampered
			}
		}),
		(error) => error && error.code === 'EVIDENCE_DERIVATION_MISMATCH'
	)
})

test('authoritative cache rejects results missing required deterministic numeric fields', async () => {
	resetAnalysisCoordinatorForTests()
	await assert.rejects(
		runCoordinatedAnalysis({
			content: Buffer.from('missing-authoritative-number-pdf'),
			scope: 'user:A',
			inputKind: 'credit-report-pdf',
			execute: async (identity) => {
				const incomplete = canonical(304, identity)
				delete incomplete.query_analysis.summary.last_6m.total
				return incomplete
			}
		}),
		(error) => error && error.code === 'INCOMPLETE_CANONICAL_RESULT'
	)
})

test('authoritative cache rejects a missing zero-loan balance before projection', async () => {
	resetAnalysisCoordinatorForTests()
	await assert.rejects(
		runCoordinatedAnalysis({
			content: Buffer.from('missing-zero-loan-balance-pdf'),
			scope: 'user:A',
			inputKind: 'credit-report-pdf',
			execute: async (identity) => {
				const incomplete = canonical(304.5, identity)
				delete incomplete.credit_debt.credit_loans.total_balance
				return incomplete
			}
		}),
		(error) => error && error.code === 'INCOMPLETE_CANONICAL_RESULT'
	)
})

test('authoritative cache does not require archival metrics outside the evidence scope', async () => {
	resetAnalysisCoordinatorForTests()
	const result = await runCoordinatedAnalysis({
		content: Buffer.from('scope-only-authoritative-fields-pdf'),
		scope: 'user:A',
		inputKind: 'credit-report-pdf',
		execute: async (identity) => {
			const scoped = canonical(304.75, identity)
			delete scoped.credit_debt.debt_ratio
			delete scoped.deterministic_dimensions
			delete scoped.six_dimensions
			delete scoped.primary_rule_score.metrics
			return scoped
		}
	})

	assert.deepEqual(result.analysis.authoritativeScope, AUTHORITATIVE_SCOPE)
	assert.equal(result.data.credit_debt.debt_ratio, undefined)
	assert.equal(result.data.deterministic_dimensions, undefined)
	assert.equal(result.data.six_dimensions, undefined)
	assert.equal(result.data.primary_rule_score.metrics, undefined)
})

test('tampered ciphertext is invalidated and recomputed, never returned', async () => {
	resetAnalysisCoordinatorForTests()
	let executions = 0
	const request = {
		content: Buffer.from('tamper-detection-pdf'),
		scope: 'user:A',
		inputKind: 'credit-report-pdf',
		execute: async (identity) => canonical(++executions, identity)
	}
	const first = await runCoordinatedAnalysis(request)
	const database = new Database(path.join(process.env.DATA_DIR, 'db.sqlite'))
	database.prepare(
		'UPDATE analysis_results SET encrypted_payload = ? WHERE analysis_key = ?'
	).run('tampered', first.analysis.analysisKey)
	database.close()

	resetAnalysisCoordinatorForTests()
	const second = await runCoordinatedAnalysis(request)
	assert.equal(executions, 2)
	assert.notEqual(second.analysis.resultHash, first.analysis.resultHash)
	assert.equal(second.data.marker, 2)
})

test('JSON normalization keeps nested undefined results stable across coordinator reset', async () => {
	resetAnalysisCoordinatorForTests()
	let executions = 0
	const request = {
		content: Buffer.from('nested-undefined-persistence-pdf'),
		scope: 'user:A',
		inputKind: 'credit-report-pdf'
	}
	const first = await runCoordinatedAnalysis({
		...request,
		execute: async (identity) => {
			executions += 1
			return {
				...canonical(404, identity),
				qa: {
					coverage_counts: {
						loan_details_total: undefined,
						retained: 1,
						nested: { omitted: undefined, retained: 2 }
					},
					items: [undefined, { omitted: undefined, retained: 3 }]
				}
			}
		}
	})

	assert.equal(executions, 1)
	assert.equal('loan_details_total' in first.data.qa.coverage_counts, false)
	assert.equal('omitted' in first.data.qa.coverage_counts.nested, false)
	assert.deepEqual(first.data.qa.items, [null, { retained: 3 }])

	resetAnalysisCoordinatorForTests()
	const persisted = await runCoordinatedAnalysis({
		...request,
		execute: async () => {
			executions += 1
			throw new Error('normalized persistent cache should have prevented execution')
		}
	})

	assert.equal(executions, 1)
	assert.equal(persisted.analysis.cacheHit, true)
	assert.equal(persisted.analysis.cacheSource, 'sqlite')
	assert.equal(persisted.analysis.resultHash, first.analysis.resultHash)
	assert.deepEqual(persisted.data.qa, first.data.qa)
})
