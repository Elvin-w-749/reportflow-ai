'use strict'

const logger = require('../utils/logger')

/**
 * 服务端产品匹配
 *
 * 前端调用：
 *   POST /api/match-products  body: { reportId, supplement }
 * 期望响应：
 *   { success: true, products: [{ ..., matchRate, matchReasons, isMatch }] }
 *
 * 该路由复用 backend/services/matchCore.js（与前端 services/matchCore.js 算法一致）
 * 以保证「登录前的离线预览」与「登录后的云端结果」分数稳定一致。
 */

const express = require('express')
// 使用后端本地 CJS 匹配核心，避免服务端加载前端 ESM 文件。
const {
	buildUnifiedMatchProfile,
	inspectEvidenceV2,
	rankProductsByMatch
} = require('../services/matchCore.js')
const { PRODUCT_LIBRARY } = require('../services/productLibrary')
const { isProductionRuntime } = require('../utils/env')
const { authRequired } = require('../middlewares/auth')
const store = require('../db/store')
const analysisTaskService = require('../services/analysisTaskService')

const router = express.Router()

router.get('/api/match-products', (_req, res) => {
	return res.json({
		success: true,
		count: PRODUCT_LIBRARY.length,
		products: PRODUCT_LIBRARY
	})
})

const SERVER_OWNED_MATCH_KEYS = new Set([
	'analysisData',
	'analysisResult',
	'reportData',
	'evidence_meta',
	'evidenceMeta',
	'evidence_v2',
	'evidenceV2',
	'primary_rule_score',
	'primaryRuleScore',
	'derivation_meta',
	'derivationMeta',
	'report',
	'dimensions',
	'deterministic_dimensions',
	'algorithmReport',
	'compositeMeta',
	'__proto__',
	'prototype',
	'constructor'
])

function containsServerOwnedKey(value) {
	if (Array.isArray(value)) return value.some(containsServerOwnedKey)
	if (!value || typeof value !== 'object') return false
	return Object.entries(value).some(([key, child]) => (
		SERVER_OWNED_MATCH_KEYS.has(key) || containsServerOwnedKey(child)
	))
}

const FINAL_MATERIAL_STATUSES = new Set(['confirmed', 'approved', 'verified', 'completed', 'done'])
const UNAVAILABLE_MATERIAL_STATUSES = new Set([
	'unavailable',
	'optional',
	'unneeded',
	'not_required',
	'waived',
	'none',
	'skipped'
])
const MATERIAL_TYPE_ALIASES = Object.freeze({
	education: 'education',
	education_record: 'education',
	education_info: 'education',
	degree: 'education',
	social_security: 'social_security',
	socialsecurity: 'social_security',
	social: 'social_security',
	housing_fund: 'housing_fund',
	housingfund: 'housing_fund',
	provident_fund: 'housing_fund',
	fund: 'housing_fund',
	payroll: 'payroll',
	salary: 'payroll',
	income: 'payroll',
	tax: 'tax',
	individual_tax: 'tax',
	property: 'property',
	house: 'property',
	real_estate: 'property',
	vehicle: 'vehicle',
	car: 'vehicle',
	business_operation: 'business_operation',
	business: 'business_operation',
	business_license: 'business_operation',
	business_flow: 'business_operation',
	merchant: 'business_operation'
})
const SUPPLEMENT_UNLOCK_GROUPS = Object.freeze([
	{ key: 'education', label: '学历信息', types: ['education'] },
	{ key: 'social_or_fund', label: '社保或公积金', types: ['social_security', 'housing_fund'] },
	{ key: 'payroll_or_tax', label: '工资流水或个税', types: ['payroll', 'tax'] },
	{ key: 'property_or_vehicle', label: '房产或车辆资产', types: ['property', 'vehicle'] }
])
const ANALYSIS_KEY_RE = /^ak_v3_[a-f0-9]{64}$/
const RESULT_HASH_RE = /^rh_v1_[a-f0-9]{64}$/

function normalizedScopeId(value) {
	return String(value || '').trim()
}

function normalizedMaterialType(material = {}) {
	const token = String(material.materialType || material.type || material.key || '')
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, '_')
	return MATERIAL_TYPE_ALIASES[token] || token
}

function materialBelongsToReport(material = {}, report = {}, userId = '') {
	if (String(material.userId || '') !== String(userId || '')) return false
	const reportId = normalizedScopeId(report.id || report._id || report.reportId)
	const caseId = normalizedScopeId(report.caseId || reportId)
	const materialCaseId = normalizedScopeId(material.caseId || material.materialScopeId)
	const materialReportId = normalizedScopeId(material.reportId)
	// Historical/unscoped aliases are display-only. A decision requires the
	// server-migrated canonical case AND report binding and fails closed otherwise.
	return Boolean(reportId && caseId && materialReportId && materialCaseId) &&
		materialReportId === reportId && materialCaseId === caseId
}

function deriveServerSupplementProfile(report, userId) {
	const materials = (Array.isArray(store.state().supplementMaterials) ? store.state().supplementMaterials : [])
		.filter((material) => materialBelongsToReport(material, report, userId))
		.map((material) => {
			const status = String(material.status || material.statusKey || '').trim().toLowerCase()
			const unavailable = UNAVAILABLE_MATERIAL_STATUSES.has(status) ||
				material.unavailable === true || material.hasMaterial === false || material.noMaterial === true
			const final = FINAL_MATERIAL_STATUSES.has(status)
			return {
				type: normalizedMaterialType(material),
				answered: unavailable || final
			}
		})
	const groupStates = SUPPLEMENT_UNLOCK_GROUPS.map((group) => ({
		...group,
		answered: materials.some((material) => group.types.includes(material.type) && material.answered)
	}))
	const completedUnlockGroups = groupStates.filter((group) => group.answered).map((group) => group.key)
	const productUnlockMissing = groupStates.filter((group) => !group.answered).map((group) => group.label)
	return {
		profileVersion: 'server-reviewed-materials-v1',
		productMatchUnlocked: productUnlockMissing.length === 0,
		productUnlockMissing,
		completedUnlockGroups,
		// The current material rows do not bind an immutable upload receipt,
		// attachment hash, material revision and reviewer attestation. A completed
		// workflow can unlock the page, but neither a mutable URL nor a status label
		// is sufficient financial evidence for product scoring.
		hasStableIncomeEvidence: false,
		hasAssetEvidence: false,
		hasBusinessEvidence: false,
		// Claimed amounts and derived booleans are likewise outside a signed,
		// structured contract and remain neutral until that contract exists.
		stableMonths: 0,
		monthlyIncome: 0,
		socialMonths: 0,
		fundMonths: 0,
		socialBase: 0,
		fundBase: 0,
		educationScore: 0,
		taxAnalysis: {
			hasFullYearTaxView: false,
			jobChangeLikely: false
		}
	}
}

function publicMaterialGate(profile = {}) {
	return {
		version: profile.profileVersion || 'server-reviewed-materials-v1',
		unlocked: profile.productMatchUnlocked === true,
		completedGroups: Array.isArray(profile.completedUnlockGroups) ? profile.completedUnlockGroups : [],
		missing: Array.isArray(profile.productUnlockMissing) ? profile.productUnlockMissing : [],
		evidence: {
			stableIncome: profile.hasStableIncomeEvidence === true,
			asset: profile.hasAssetEvidence === true,
			business: profile.hasBusinessEvidence === true
		}
	}
}

function strictAnalysisIdentity(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const analysisKey = String(value.analysisKey || value.analysis_key || '').trim()
	const resultHash = String(value.resultHash || value.result_hash || '').trim()
	return ANALYSIS_KEY_RE.test(analysisKey) && RESULT_HASH_RE.test(resultHash)
		? { analysisKey, resultHash }
		: null
}

function canonicalAnalysisIdentity(analysis) {
	if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) return null
	const identities = [
		analysis,
		analysis.analysis_meta,
		analysis.analysisMeta,
		analysis.analysisExecution,
		analysis.analysis_execution,
		analysis.analysisAuthority,
		analysis.analysis_authority
	].map(strictAnalysisIdentity).filter(Boolean)
	if (!identities.length) return null
	const [first] = identities
	return identities.every((identity) => (
		identity.analysisKey === first.analysisKey && identity.resultHash === first.resultHash
	)) ? first : null
}

function linkedCanonicalAnalysis(report, userId) {
	const jobId = String(report && report.analysisJobId || '').trim()
	const authority = report && report.analysisAuthority
	if (
		!analysisTaskService.JOB_ID_RE.test(jobId) ||
		!authority || authority.version !== 'analysis-job-link-v1'
	) return { ok: false, reason: 'missing-link' }
	let payload
	try {
		payload = analysisTaskService.getAnalysisTaskResult(`user:${userId}`, jobId)
	} catch (_) {
		return { ok: false, reason: 'result-unavailable' }
	}
	if (!payload || !payload.result || !payload.analysis) {
		return { ok: false, reason: payload && payload.job ? 'result-not-ready' : 'job-not-found' }
	}
	const taskIdentity = strictAnalysisIdentity(payload.analysis)
	const canonicalIdentity = canonicalAnalysisIdentity(payload.result)
	if (!taskIdentity || !canonicalIdentity ||
		taskIdentity.analysisKey !== String(authority.analysisKey || '') ||
		taskIdentity.resultHash !== String(authority.resultHash || '') ||
		canonicalIdentity.analysisKey !== taskIdentity.analysisKey ||
		canonicalIdentity.resultHash !== taskIdentity.resultHash
	) return { ok: false, reason: 'identity-mismatch' }
	const evidence = inspectEvidenceV2(payload.result)
	return evidence.verified
		? { ok: true, analysis: payload.result }
		: { ok: false, reason: 'evidence-invalid' }
}

function serverMatchPayload(analysis, supplement) {
	const safeReport = analysis.report && typeof analysis.report === 'object' && !Array.isArray(analysis.report)
		? { ...analysis.report }
		: {}
	delete safeReport.adjustedTotalScore
	delete safeReport.adjusted_total_score
	const safe = {
		...analysis,
		report: safeReport,
		supplementMaterialProfile: supplement
	}
	// composite/adjusted values from historical client uploads are not part of
	// the evidence-v2 HMAC chain and must not affect a server decision.
	delete safe.compositeMeta
	delete safe.composite_meta
	return safe
}

router.post('/api/match-products', authRequired, (req, res) => {
	try {
		const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
		if (Object.prototype.hasOwnProperty.call(body, 'reportData')) {
			return res.status(400).json({
				success: false,
				errCode: 'CLIENT_REPORT_DATA_REJECTED',
				errMsg: '仅接受当前登录用户的 reportId；不接受客户端报告正文',
				products: []
			})
		}
		const extraKeys = Object.keys(body).filter((key) => !['reportId', 'supplement'].includes(key))
		if (extraKeys.length || containsServerOwnedKey(body.supplement)) {
			return res.status(400).json({
				success: false,
				errCode: 'SERVER_OWNED_MATCH_INPUT',
				errMsg: '请求包含仅允许由服务端读取的分析字段',
				products: []
			})
		}
		const reportId = String(body.reportId || '').trim()
		if (!reportId || !/^[A-Za-z0-9._:-]{1,160}$/.test(reportId)) {
			return res.status(400).json({
				success: false,
				errCode: 'REPORT_ID_REQUIRED',
				errMsg: 'reportId is required',
				products: []
			})
		}
		const report = (Array.isArray(store.state().reports) ? store.state().reports : []).find((item) => (
			String(item && (item.id || item._id || item.reportId) || '') === reportId &&
			String(item && item.userId || '') === String(req.user.uid) &&
			item.hiddenFromOwner !== true && !item.userDeletedAt
		))
		if (!report) {
			return res.status(404).json({
				success: false,
				errCode: 'REPORT_NOT_FOUND',
				errMsg: 'report not found',
				products: []
			})
		}
		const linked = linkedCanonicalAnalysis(report, req.user.uid)
		if (!linked.ok) {
			return res.status(422).json({
				success: false,
				errCode: 'REPORT_EVIDENCE_NOT_VERIFIED',
				errMsg: '该历史报告没有可验证的完整 evidence-v2 账本，无法用于产品决策；请重新分析报告',
				reportId,
				decisionEligible: false,
				products: []
			})
		}
		const analysis = linked.analysis
		// `body.supplement` is intentionally UI-only. Every decision-bearing
		// material fact is reconstructed from the current owner's server row.
		const serverSupplement = deriveServerSupplementProfile(report, req.user.uid)
		const profile = buildUnifiedMatchProfile(serverMatchPayload(analysis, serverSupplement))
		if (profile.hasVerifiedEvidenceV2 !== true || profile.hasDecisionScore !== true) {
			return res.status(422).json({
				success: false,
				errCode: 'REPORT_DECISION_NOT_REPRODUCIBLE',
				errMsg: '报告证据无法重建匹配决策，请重新分析报告',
				reportId,
				decisionEligible: false,
				products: []
			})
		}
		const supplement = profile.supplementMaterialProfile || {}
		const materialGate = publicMaterialGate(supplement)
		if (supplement.productMatchUnlocked !== true) {
			return res.json({
				success: true,
				locked: true,
				reportId,
				evidenceVerified: true,
				decisionEligible: true,
				materialGate,
				products: [],
				notice: {
					title: '已读取征信问题，待确认材料情况',
					summary: '仅凭征信报告不能直接精准匹配产品；请先确认三金、个税、学历和资产材料，有就上传，没有就选择暂无。',
					missing: Array.isArray(supplement.productUnlockMissing) ? supplement.productUnlockMissing : ['学历信息', '社保或公积金', '工资流水或个税', '房产或车辆资产']
				}
			})
		}
		const products = rankProductsByMatch(PRODUCT_LIBRARY, profile, { minRate: 30, limit: 6 })
		return res.json({
			success: true,
			locked: false,
			reportId,
			evidenceVerified: true,
			decisionEligible: true,
			materialGate,
			products
		})
	} catch (e) {
		logger.error({ err: e }, 'match-products failed')
		const isProd = isProductionRuntime()
		return res.status(500).json({
			success: false,
			// 生产环境不回显原始异常细节（可能含内部实现信息）；细节仅进服务端日志。
			errMsg: isProd ? 'match-products failed' : ((e && e.message) || 'match-products failed'),
			products: []
		})
	}
})

module.exports = router
