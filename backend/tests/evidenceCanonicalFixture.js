'use strict'

const {
	analysisVersions,
	buildArtifactHash
} = require('../backend/services/analysisIdentity')
const {
	stableCanonicalize,
	evaluatePublicationGate,
	buildEvidenceFirstCreditAnalysis
} = require('../backend/services/creditEvidenceLedger')

const AUTHORITATIVE_SCOPE = Object.freeze([
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

function evidenceHashFn(prefix, canonicalPayload) {
	return buildArtifactHash(prefix, canonicalPayload)
}

function artifactHash(prefix, payload) {
	return buildArtifactHash(prefix, stableCanonicalize(payload))
}

function fixtureIdentity(identity = {}) {
	return {
		documentId: identity.documentId,
		inputKind: identity.inputKind || 'credit-report-pdf',
		versions: identity.versions || analysisVersions()
	}
}

function attachEvidenceV2(canonicalResult, suppliedIdentity) {
	const canonicalCards = canonicalResult?.credit_debt?.credit_cards
	if (canonicalCards && !Object.prototype.hasOwnProperty.call(canonicalCards, 'utilization_used')) {
		const limit = Number(canonicalCards.total_limit)
		const rate = Number(canonicalCards.usage_rate)
		canonicalCards.utilization_used = Number.isFinite(limit) && Number.isFinite(rate)
			? Math.round(limit * rate * 100) / 100
			: Number(canonicalCards.total_used || 0)
	}
	const identity = fixtureIdentity(suppliedIdentity)
	if (!/^doc_v2_[a-f0-9]{64}$/.test(String(identity.documentId || ''))) {
		throw new TypeError('fixture identity must contain the coordinator documentId')
	}
	const pageText = '报告日期 2026-06-30'
	const sourceText = `【第1页】\n${pageText}`
	const facts = {
		meta: { report_date: '2026-06-30' },
		basic_info: { report_date: '2026-06-30' },
		loan_details: { bank_loans: [], non_bank_loans: [] },
		credit_card_details: [],
		query_analysis: { query_details: [], self_queries: [] },
		primary_rule_score: canonicalResult.primary_rule_score
	}
	const versions = identity.versions
	const artifacts = buildEvidenceFirstCreditAnalysis({
		sourceText,
		documentId: identity.documentId,
		inputKind: identity.inputKind,
		declaredPageCount: 1,
		evidenceContext: {
			facts,
			sourceVerifiedCounts: {
				active_loans: { count: 0, basis: 'source-enumerated' },
				credit_card_details: { count: 0, basis: 'source-enumerated' },
				query_details: { count: 0, basis: 'source-enumerated' }
			},
			documentMeta: {
				complete: true,
				sourceMode: 'pdf-text',
				expectedPageCount: 1,
				pages: [{
					pageNumber: 1,
					bounds: [0, 0, 300, 200],
					text: pageText,
					sourceMode: 'pdf-text',
					blocks: [{
						text: pageText,
						charStart: 0,
						charEnd: pageText.length,
						bbox: [20, 20, 180, 40]
					}]
				}]
			}
		},
		versions: {
			...versions
		},
		ruleVersion: canonicalResult.derivation_meta.rules_version,
		hashFn: evidenceHashFn,
		requirePublishable: true
	})
	const evidenceMeta = {
		version: 'evidence-v2',
		status: artifacts.status,
		manifest_hash: artifacts.manifest.manifestHash,
		evidence_hash: artifacts.evidenceGraph.evidenceGraphHash,
		fact_hash: artifacts.factLedger.factLedgerHash,
		metric_hash: artifacts.derivedAnalysis.derivedAnalysisHash,
		publication_gate: artifacts.publicationGate.status,
		fact_count: artifacts.factLedger.facts.length,
		supported_fact_count: artifacts.factLedger.facts.filter((fact) => fact.status === 'accepted').length,
		authoritative_scope: [...AUTHORITATIVE_SCOPE]
	}
	return {
		...canonicalResult,
		derivation_meta: {
			...(canonicalResult.derivation_meta || {}),
			evidence_mode: 'evidence-v2',
			evidence_hash: evidenceMeta.evidence_hash,
			fact_hash: evidenceMeta.fact_hash,
			metric_hash: evidenceMeta.metric_hash
		},
		evidence_v2: artifacts,
		evidence_meta: evidenceMeta
	}
}

function rehashEvidenceV2(canonicalResult) {
	const artifacts = canonicalResult.evidence_v2
	const manifest = artifacts.manifest
	const graphPayload = { ...artifacts.evidenceGraph }
	delete graphPayload.evidenceGraphHash
	artifacts.evidenceGraph = {
		...graphPayload,
		evidenceGraphHash: artifactHash('eg_v2', graphPayload)
	}
	const ledgerPayload = {
		...artifacts.factLedger,
		evidenceGraphHash: artifacts.evidenceGraph.evidenceGraphHash
	}
	delete ledgerPayload.factLedgerHash
	artifacts.factLedger = {
		...ledgerPayload,
		factLedgerHash: artifactHash('fl_v2', ledgerPayload)
	}
	const derivedPayload = {
		...artifacts.derivedAnalysis,
		inputs: {
			...artifacts.derivedAnalysis.inputs,
			documentManifestHash: manifest.manifestHash,
			evidenceGraphHash: artifacts.evidenceGraph.evidenceGraphHash,
			factLedgerHash: artifacts.factLedger.factLedgerHash
		}
	}
	delete derivedPayload.derivedAnalysisHash
	artifacts.derivedAnalysis = {
		...derivedPayload,
		derivedAnalysisHash: artifactHash('da_v2', derivedPayload)
	}
	artifacts.publicationGate = evaluatePublicationGate({
		manifest,
		evidenceGraph: artifacts.evidenceGraph,
		factLedger: artifacts.factLedger,
		derivedAnalysis: artifacts.derivedAnalysis
	}, { hashFn: evidenceHashFn })
	artifacts.status = artifacts.publicationGate.publishable ? 'publishable' : 'blocked'
	canonicalResult.evidence_meta = {
		...canonicalResult.evidence_meta,
		status: artifacts.status,
		evidence_hash: artifacts.evidenceGraph.evidenceGraphHash,
		fact_hash: artifacts.factLedger.factLedgerHash,
		metric_hash: artifacts.derivedAnalysis.derivedAnalysisHash,
		publication_gate: artifacts.publicationGate.status,
		fact_count: artifacts.factLedger.facts.length,
		supported_fact_count: artifacts.factLedger.facts.filter((fact) => fact.status === 'accepted').length
	}
	canonicalResult.derivation_meta = {
		...canonicalResult.derivation_meta,
		evidence_hash: canonicalResult.evidence_meta.evidence_hash,
		fact_hash: canonicalResult.evidence_meta.fact_hash,
		metric_hash: canonicalResult.evidence_meta.metric_hash
	}
	return canonicalResult
}

module.exports = {
	AUTHORITATIVE_SCOPE,
	attachEvidenceV2,
	rehashEvidenceV2
}
