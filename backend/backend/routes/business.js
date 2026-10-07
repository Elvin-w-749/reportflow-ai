'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const express = require('express')
const multer = require('multer')
const { ok, fail } = require('../utils/response')
const { authRequired, resolveJwtSecret } = require('../middlewares/auth')
const { hasRole, normalizedRole } = require('../middlewares/roles')
const store = require('../db/store')
const { addMessage } = require('../services/messageService')
const logger = require('../utils/logger')
const { maskPhone } = require('../utils/mask')
const { buildPublicUploadUrl } = require('../utils/publicUrl')
const { isProductionRuntime } = require('../utils/env')
const {
	contactInstitutionOf,
	firstValidInstitution,
	institutionTextMatches,
	normalizedInstitution
} = require('../utils/institutionPolicy')
const { stableStringify } = require('../services/analysisIdentity')
const { buildDecisionSummary, inspectEvidenceV2 } = require('../services/matchCore')
const analysisTaskService = require('../services/analysisTaskService')

const router = express.Router()

const uploadsRoot = path.join(__dirname, '..', '..', 'uploads')
if (!fs.existsSync(uploadsRoot)) {
	fs.mkdirSync(uploadsRoot, { recursive: true })
}

// 上传文件类型白名单（头像 / 反馈图 / 异议证据）。/uploads 由 server.js 以 Content-Disposition: attachment
// 强制下载（防同域 XSS），此处再做扩展名白名单做纵深防御，拒绝 .html/.svg/.js 等可执行/可渲染类型。
const ALLOWED_UPLOAD_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.pdf'])
const BUSINESS_UPLOAD_MAX_MB = Number(process.env.BUSINESS_UPLOAD_MAX_MB || 30)
const BUSINESS_UPLOAD_LIMIT_BYTES = BUSINESS_UPLOAD_MAX_MB * 1024 * 1024
const SUPER_ADMIN_PHONES = new Set(String(process.env.SUPER_ADMIN_PHONES || '').split(',').map((item) => item.trim()).filter(Boolean))
const SUPER_ADMIN_UIDS = new Set(String(process.env.SUPER_ADMIN_UIDS || '').split(',').map((item) => item.trim()).filter(Boolean))
const SUPER_ADMIN_USERNAMES = new Set(String(process.env.SUPER_ADMIN_USERNAMES || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))
const FIXED_TEST_ACCOUNTS_ENABLED = !isProductionRuntime() || /^(1|true|yes|on)$/i.test(
	String(process.env.ENABLE_FIXED_TEST_ACCOUNTS || '').trim()
)

const storage = multer.diskStorage({
	destination: (_req, _file, cb) => cb(null, uploadsRoot),
	filename: (_req, file, cb) => {
		let ext = path.extname(file.originalname || '').toLowerCase()
		if (!ALLOWED_UPLOAD_EXT.has(ext)) ext = '.bin'
		// 安全基线：文件名作为"能力 URL"的唯一凭证（客户端 <image> 无法带鉴权头，无法做 per-request 鉴权）。
		// 原 `Date.now()_随机6位base36` 可被时间窗 + 暴力枚举猜中；改用 16 字节加密随机数，使 URL 不可枚举。
		cb(null, `${crypto.randomBytes(16).toString('hex')}${ext}`)
	}
})
const upload = multer({
	storage,
	limits: { fileSize: BUSINESS_UPLOAD_LIMIT_BYTES },
	fileFilter: (_req, file, cb) => {
		const ext = path.extname(file.originalname || '').toLowerCase()
		if (ALLOWED_UPLOAD_EXT.has(ext)) return cb(null, true)
		const err = new Error('不支持的文件类型，仅允许图片或 PDF')
		err.code = 'UNSUPPORTED_FILE_TYPE'
		return cb(err)
	}
})

function byUser(items, uid) {
	return items.filter((x) => (x.userId || '') === uid)
}

function reportVisibleToOwner(report = {}) {
	return report.hiddenFromOwner !== true && !report.userDeletedAt
}

function canonicalReportAnalysis(report = {}) {
	const value = report.analysisData || report.analysisResult
	return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

const REPORT_CONTENT_FINGERPRINT_VERSION = 'report-content-v2'
const REPORT_ANALYSIS_KEY_RE = /^ak_v3_[a-f0-9]{64}$/
const REPORT_RESULT_HASH_RE = /^rh_v1_[a-f0-9]{64}$/
const REPORT_RESPONSE_STATE_KEYS = new Set([
	'cacheHit',
	'cache_hit',
	'cacheSource',
	'cache_source',
	'requestId',
	'request_id',
	'requestDurationMs',
	'request_duration_ms',
	'durationMs',
	'duration_ms',
	'elapsedMs',
	'elapsed_ms',
	'latencyMs',
	'latency_ms',
	'reused',
	'reuseReason',
	'reuse_reason'
])

function strictReportAnalysisIdentity(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const analysisKey = String(value.analysisKey || value.analysis_key || '').trim()
	const resultHash = String(value.resultHash || value.result_hash || '').trim()
	if (!REPORT_ANALYSIS_KEY_RE.test(analysisKey) || !REPORT_RESULT_HASH_RE.test(resultHash)) return null
	return { analysisKey, resultHash }
}

function authoritativeReportAnalysisIdentity(analysis) {
	if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) return null
	const identities = []
	const roots = [
		analysis,
		analysis.creditReportV2,
		analysis.credit_report_v2,
		analysis.aiInsight,
		analysis.kimiInsight
	].filter((value) => value && typeof value === 'object' && !Array.isArray(value))
	for (const root of roots) {
		const candidates = [
			root,
			root.analysis_meta,
			root.analysisMeta,
			root.analysisExecution,
			root.analysis_execution,
			root.analysisAuthority,
			root.analysis_authority,
			root.derivation_meta,
			root.derivationMeta
		]
		for (const candidate of candidates) {
			const identity = strictReportAnalysisIdentity(candidate)
			if (identity) identities.push(identity)
		}
	}
	if (!identities.length) return null
	const [first] = identities
	return identities.every((identity) => (
		identity.analysisKey === first.analysisKey && identity.resultHash === first.resultHash
	)) ? first : null
}

function analysisJobReferenceForUser(userId, jobId, expectedAnalysis = null, expectedAuthority = null) {
	const normalizedJobId = String(jobId || '').trim()
	if (!analysisTaskService.JOB_ID_RE.test(normalizedJobId)) {
		return { ok: false, reason: normalizedJobId ? 'invalid-job-id' : 'missing-job-id' }
	}
	let taskPayload
	try {
		taskPayload = analysisTaskService.getAnalysisTaskResult(`user:${userId}`, normalizedJobId)
	} catch (_) {
		return { ok: false, reason: 'result-unavailable' }
	}
	if (!taskPayload) return { ok: false, reason: 'job-not-found' }
	if (!taskPayload.result) {
		return {
			ok: false,
			reason: taskPayload.job && taskPayload.job.status === 'failed' ? 'job-failed' : 'job-not-ready',
			job: taskPayload.job || null
		}
	}
	const canonical = taskPayload.result
	const evidence = inspectEvidenceV2(canonical)
	const identity = authoritativeReportAnalysisIdentity(canonical)
	if (!evidence.verified || !identity) return { ok: false, reason: 'canonical-evidence-invalid' }
	const clientIdentity = expectedAnalysis ? authoritativeReportAnalysisIdentity(expectedAnalysis) : null
	if (expectedAnalysis && (!clientIdentity ||
		clientIdentity.analysisKey !== identity.analysisKey ||
		clientIdentity.resultHash !== identity.resultHash)) {
		return { ok: false, reason: 'client-identity-mismatch', identity }
	}
	const authority = expectedAuthority && typeof expectedAuthority === 'object' ? expectedAuthority : null
	if (authority && (
		String(authority.analysisKey || '') !== identity.analysisKey ||
		String(authority.resultHash || '') !== identity.resultHash
	)) return { ok: false, reason: 'stored-identity-mismatch', identity }
	return {
		ok: true,
		jobId: normalizedJobId,
		canonical,
		identity,
		job: taskPayload.job || null
	}
}

function trustedCanonicalAnalysisForReport(report = {}) {
	const jobId = String(report.analysisJobId || '').trim()
	const authority = report.analysisAuthority
	if (!jobId || !authority) return null
	const resolved = analysisJobReferenceForUser(report.userId, jobId, null, authority)
	return resolved.ok ? resolved.canonical : null
}

const PRIVATE_REPORT_EVIDENCE_KEYS = new Set([
	'evidencev2',
	'manifest',
	'documentmanifest',
	'evidencegraph',
	'factledger',
	'derivedanalysis',
	'publicationgate',
	'evidenceblocks',
	'rawevidence',
	'rawevidenceblocks',
	'sourceevidence',
	'sourceevidenceblocks',
	'sourceblocks',
	'sourcetext',
	'rawtext',
	'rawocrtext',
	'ocrtext',
	'matchedquotes'
])

function withoutPrivateEvidenceArtifacts(value, seen = new WeakMap()) {
	if (!value || typeof value !== 'object') return value
	if (seen.has(value)) return seen.get(value)
	if (Array.isArray(value)) {
		const copy = []
		seen.set(value, copy)
		for (const item of value) copy.push(withoutPrivateEvidenceArtifacts(item, seen))
		return copy
	}
	const copy = {}
	seen.set(value, copy)
	for (const [key, item] of Object.entries(value)) {
		const normalized = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase()
		if (PRIVATE_REPORT_EVIDENCE_KEYS.has(normalized)) continue
		copy[key] = withoutPrivateEvidenceArtifacts(item, seen)
	}
	return copy
}

function withoutReportResponseState(value) {
	if (Array.isArray(value)) return value.map(withoutReportResponseState)
	if (!value || typeof value !== 'object') return value
	const result = {}
	for (const [key, item] of Object.entries(value)) {
		if (REPORT_RESPONSE_STATE_KEYS.has(key)) continue
		result[key] = withoutReportResponseState(item)
	}
	return result
}

function reportContentFingerprint(payload = {}) {
	const analysis = canonicalReportAnalysis(payload)
	const authoritativeIdentity = authoritativeReportAnalysisIdentity(analysis)
	const material = stableStringify({
		analysis: authoritativeIdentity
			? { authoritativeIdentity }
			: withoutReportResponseState(analysis),
		financialSupplement: payload.financialSupplement || null
	})
	const hash = crypto.createHash('sha256').update(material).digest('hex')
	return `rcf_v2_${hash}`
}

function currentStoredReportContentFingerprint(report = {}) {
	const stored = String(report.contentFingerprint || '')
	if (
		report.contentFingerprintVersion === REPORT_CONTENT_FINGERPRINT_VERSION &&
		/^rcf_v2_[a-f0-9]{64}$/.test(stored)
	) {
		return stored
	}
	// Pre-v2 rows either have only uploadFingerprint or have a v1 fingerprint
	// whose material still included volatile analysis response state. Recompute
	// from stored content so the next successful retry can lazily backfill v2.
	return reportContentFingerprint(report)
}

function canonicalReportUploadFingerprint(payload = {}) {
	const analysis = canonicalReportAnalysis(payload)
	const material = stableStringify({
		reportType: String(payload.reportType || ''),
		fileName: String(payload.fileName || ''),
		analysis,
		financialSupplement: payload.financialSupplement || null
	})
	return crypto.createHash('sha256').update(material).digest('hex')
}

function normalizedClientReportId(value) {
	const id = String(value || '').trim()
	if (!id) return ''
	return /^[A-Za-z0-9._:-]{1,160}$/.test(id) ? id : null
}

function ownerReportSummary(report = {}, options = {}) {
	const analysis = canonicalReportAnalysis(report) || {}
	const trustedAnalysis = Object.prototype.hasOwnProperty.call(options, 'trustedAnalysis')
		? options.trustedAnalysis
		: trustedCanonicalAnalysisForReport(report)
	const decisionAnalysis = trustedAnalysis || analysis
	const decision = buildDecisionSummary(
		{ ...report, analysisData: decisionAnalysis },
		{ evidenceTrusted: Boolean(trustedAnalysis) }
	)
	const id = String(firstNonEmpty(report.id, report._id, report.reportId) || '')
	return {
		id,
		_id: id,
		reportId: id,
		clientReportId: String(report.clientReportId || ''),
		fileName: String(report.fileName || ''),
		reportType: String(report.reportType || ''),
		customerName: reportCustomerName(report),
		reportMonth: reportMonthOf(report),
		reportIdentityLast4: String(report.reportIdentityLast4 || ''),
		createdAt: report.createdAt || null,
		updatedAt: report.updatedAt || report.createdAt || null,
		date: report.date || (report.createdAt ? String(report.createdAt).slice(0, 10) : ''),
		_score: decision.score,
		_riskLevel: decision.riskLevel,
		_accountCount: decision.accountCount,
		score: decision.score,
		riskLevel: decision.riskLevel,
		accountCount: decision.accountCount,
		totalDebt: decision.totalDebt,
		totalLoanBalance: decision.totalLoanBalance,
		cardTotalLimit: decision.cardTotalLimit,
		cardTotalUsed: decision.cardTotalUsed,
		cardUtilizationUsed: decision.cardUtilizationUsed,
		cardUtilizationRate: decision.cardUtilizationRate,
		cardUtilizationPct: decision.cardUtilizationPct,
		sharedCreditGroupCount: decision.sharedCreditGroupCount,
		query1mCount: decision.query1mCount,
		query3mCount: decision.query3mCount,
		query6mCount: decision.query6mCount,
		query12mCount: decision.query12mCount,
		archivalScore: decision.archivalScore,
		archivalRiskLevel: decision.archivalRiskLevel,
		archivalAccountCount: decision.archivalAccountCount,
		archivalTotalDebt: decision.archivalTotalDebt,
		archivalQuery6mCount: decision.archivalQuery6mCount,
		decisionFlags: decision.decisionFlags,
		decisionState: decision.decisionState,
		evidenceVerified: decision.evidenceVerified,
		// A stored link is only provenance. It becomes decision evidence for this
		// response after the referenced task result has been revalidated above.
		decisionEvidenceLinked: Boolean(trustedAnalysis),
		detailAvailable: true
	}
}

function ownerReportDetail(report = {}) {
	const storedAnalysis = canonicalReportAnalysis(report)
	const trustedAnalysis = trustedCanonicalAnalysisForReport(report)
	// Older linked report rows were persisted after cachePolicy had been treated
	// as volatile response state. Rehydrate the owner detail from the still-
	// verified canonical job result so those rows regain the stable authority
	// metadata needed by the Web mapper, without mutating the stored report.
	const analysis = withoutPrivateEvidenceArtifacts(
		withoutReportResponseState(trustedAnalysis || storedAnalysis)
	)
	const summary = ownerReportSummary(report, { trustedAnalysis })
	return {
		...summary,
		filePath: String(report.filePath || ''),
		financialSupplement: report.financialSupplement || null,
		uploadPolicy: String(report.uploadPolicy || ''),
		analysisResult: analysis
	}
}

function ensureArray(key) {
	const s = store.state()
	if (!Array.isArray(s[key])) s[key] = []
	return s[key]
}

function ensureObject(key) {
	const s = store.state()
	if (!s[key] || typeof s[key] !== 'object' || Array.isArray(s[key])) s[key] = {}
	return s[key]
}

function nowIso() {
	return new Date().toISOString()
}

function makeId(prefix) {
	return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function cleanId(value) {
	return String(value || '').replace(/^local_/, '').trim()
}

function currentAuthUser(req) {
	return store.findUserById(req.user && req.user.uid)
}

function isSuperAdminUser(user = {}) {
	if (!user || !hasRole(user, ['admin'])) return false
	if (user.adminLevel === 'super' || user.isSuperAdmin === true) return true
	if (user.phone && SUPER_ADMIN_PHONES.has(String(user.phone))) return true
	if (user.id && SUPER_ADMIN_UIDS.has(String(user.id))) return true
	const names = [user.username, user.loginName, user.account].map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
	if (names.some((name) => SUPER_ADMIN_USERNAMES.has(name))) return true
	if (user.loginNameHash && [...SUPER_ADMIN_USERNAMES].some((name) => hashLoginName(name) === String(user.loginNameHash))) return true
	return false
}

function hashLoginName(value) {
	const key = String(process.env.LOGIN_NAME_PEPPER || resolveJwtSecret())
	return crypto.createHmac('sha256', key).update(String(value || '').trim().toLowerCase()).digest('hex')
}

function publicManagedUser(user = {}) {
	const role = normalizedRole(user)
	const reportUnlimited = user.reportUploadUnlimited === true || user.franchiseReportUnlimited === true || isFixedTestReportAccount(user)
	return {
		uid: user.id || user.uid || '',
		phone: user.phone || user.mobile || '',
		nickname: user.nickname || '',
		role,
		institution: user.institution || user.bankName || user.company || '',
		reportUploadUnlimited: reportUnlimited,
		franchiseReportUnlimited: reportUnlimited,
		franchiseGrantedAt: user.franchiseGrantedAt || '',
		franchiseGrantedByName: user.franchiseGrantedByName || '',
		adminLevel: role === 'admin' ? (isSuperAdminUser(user) ? 'super' : 'regular') : '',
		isSuperAdmin: role === 'admin' && isSuperAdminUser(user),
		roleGrantedBy: user.roleGrantedBy || '',
		roleGrantedAt: user.roleGrantedAt || '',
		createdAt: user.createdAt || ''
	}
}

function isProtectedSuperAdminUser(user = {}) {
	if (!isSuperAdminUser(user)) return false
	if (user.adminLevel === 'super' || user.isSuperAdmin === true) return true
	if (user.id && SUPER_ADMIN_UIDS.has(String(user.id))) return true
	if (user.phone && SUPER_ADMIN_PHONES.has(String(user.phone))) return true
	const names = [user.username, user.loginName, user.account].map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
	if (names.some((name) => SUPER_ADMIN_USERNAMES.has(name))) return true
	return !!(user.loginNameHash && [...SUPER_ADMIN_USERNAMES].some((name) => hashLoginName(name) === String(user.loginNameHash)))
}

function isAdvisorActor(req) {
	const user = currentAuthUser(req)
	return !!(user && hasRole(user, ['advisor', 'admin']))
}

function isServiceActor(req) {
	const user = currentAuthUser(req)
	return !!(user && hasRole(user, ['service', 'admin']))
}

function isStaffActor(req) {
	const user = currentAuthUser(req)
	return !!(user && hasRole(user, ['advisor', 'service', 'admin']))
}

function actorRole(req) {
	const user = currentAuthUser(req)
	if (!user) return 'user'
	if (hasRole(user, ['admin'])) return 'admin'
	if (hasRole(user, ['advisor'])) return 'advisor'
	if (hasRole(user, ['service'])) return 'service'
	return 'user'
}

function actorInstitution(req) {
	const user = currentAuthUser(req) || {}
	return firstValidInstitution(
		user.institution,
		user.bankName,
		user.company
	)
}

function institutionMatches(req, contact) {
	if (actorRole(req) === 'admin') return true
	const staffInstitution = normalizedInstitution(actorInstitution(req))
	const contactInstitution = normalizedInstitution(contactInstitutionOf(contact))
	if (!staffInstitution || !contactInstitution) return false
	return institutionTextMatches(staffInstitution, contactInstitution)
}

function contactIdOf(item = {}) {
	return cleanId(item._id || item.id || item.contactId)
}

function contactChannelOf(item = {}) {
	const raw = String(firstNonEmpty(item.channel, item.deskType, item.serviceChannel, '')).trim().toLowerCase()
	if (raw === 'service' || raw === 'support' || raw === 'customer-service') return 'service'
	if (raw === 'bank' || raw === 'advisor' || raw === 'manager') return 'bank'
	if (String(item.contactType || '') === 'customer-service') return 'service'
	return 'bank'
}

function isBankServiceGroup(item = {}) {
	return contactChannelOf(item) === 'bank' && (item.serviceRequired === true || item.groupMode === 'service-bank-customer' || item.contactType === 'match-product')
}

function advisorCanSeeContactLead(req, contact) {
	if (actorRole(req) === 'admin') return true
	return contactChannelOf(contact) === 'bank' && institutionMatches(req, contact)
}

function assignmentEvidenceMatches(contact, role, assigneeId) {
	const actorId = String(assigneeId || '')
	const prefix = role === 'service' ? 'service' : 'advisor'
	const assignedAt = String(contact[`${prefix}AssignedAt`] || '')
	const assigneeName = String(contact[`${prefix}AssigneeName`] || '')
	if (!actorId || !assignedAt || String(contact[`${prefix}Status`] || '').toLowerCase() !== 'assigned') return false
	const modernEvent = `${prefix}-claimed`
	const modernActorKey = `${prefix}Id`
	const legacyContent = role === 'service'
		? `${assigneeName}已接单，可查看授权资料并协助沟通。`
		: `${assigneeName}已接入本机构客户咨询。`
	return (Array.isArray(contact.messages) ? contact.messages : []).some((message = {}) => {
		if (
			String(message.senderType || '') !== 'system' ||
			String(message.senderRole || '') !== 'system' ||
			String(message.senderId || '') !== 'system' ||
			String(message.createdAt || '') !== assignedAt
		) return false
		if (String(message.eventType || '') === modernEvent) {
			return String(message[modernActorKey] || '') === actorId &&
				String(message.claimedAt || '') === assignedAt
		}
		return Boolean(!message.eventType && assigneeName && String(message.content || '') === legacyContent)
	})
}

function advisorAssignmentMatches(req, contact) {
	return assigneeMatches(req, contact.advisorAssigneeId) &&
		assignmentEvidenceMatches(contact, 'advisor', contact.advisorAssigneeId)
}

function serviceAssignmentMatches(req, contact) {
	return assigneeMatches(req, contact.serviceAssigneeId) &&
		assignmentEvidenceMatches(contact, 'service', contact.serviceAssigneeId)
}

function advisorInviteMatches(req, contact, invite = {}) {
	const actorId = req.user && String(req.user.uid || '')
	const inviteId = String(invite.id || invite.inviteId || '')
	if (!actorId || !inviteId || String(invite.advisorId || '') !== actorId) return false
	if (!institutionTextMatches(actorInstitution(req), invite.institution) || !institutionTextMatches(contactInstitutionOf(contact), invite.institution)) return false
	return (Array.isArray(contact.messages) ? contact.messages : []).some((message = {}) => (
		String(message.senderType || '') === 'system' &&
		String(message.senderRole || '') === 'system' &&
		String(message.senderId || '') === 'system' &&
		String(message.eventType || '') === 'advisor-invited' &&
		String(message.inviteId || '') === inviteId
	))
}

function advisorHasValidInvite(req, contact) {
	const actorId = req.user && String(req.user.uid || '')
	if (!actorId || String(contact.invitedAdvisorId || '') !== actorId) return false
	const invites = Array.isArray(contact.advisorInviteRecords) ? contact.advisorInviteRecords : []
	return invites.some((invite) => advisorInviteMatches(req, contact, invite))
}

function advisorDirectTargetMatches(req, contact) {
	return !isBankServiceGroup(contact) && assigneeMatches(req, contact.advisorId)
}

function advisorTargetLocked(contact) {
	if (isBankServiceGroup(contact)) {
		return Boolean(contact.advisorAssigneeId || contact.invitedAdvisorId || (Array.isArray(contact.advisorInviteRecords) && contact.advisorInviteRecords.length))
	}
	return Boolean(contact.advisorAssigneeId || contact.invitedAdvisorId || contact.advisorId || (Array.isArray(contact.advisorInviteRecords) && contact.advisorInviteRecords.length))
}

function advisorHasGroupAccess(req, contact) {
	if (actorRole(req) === 'admin') return true
	if (!isBankServiceGroup(contact)) return false
	if (!advisorCanSeeContactLead(req, contact)) return false
	return advisorAssignmentMatches(req, contact) || advisorHasValidInvite(req, contact)
}

function advisorCanReadContact(req, contact) {
	if (actorRole(req) === 'admin') return true
	if (!advisorCanSeeContactLead(req, contact)) return false
	if (isBankServiceGroup(contact)) return advisorHasGroupAccess(req, contact)
	if (contact.advisorAssigneeId) return advisorAssignmentMatches(req, contact)
	if (contact.invitedAdvisorId || (Array.isArray(contact.advisorInviteRecords) && contact.advisorInviteRecords.length)) return advisorHasValidInvite(req, contact)
	return advisorDirectTargetMatches(req, contact)
}

function advisorCanListContact(req, contact) {
	if (actorRole(req) === 'admin') return true
	if (!advisorCanSeeContactLead(req, contact)) return false
	return !advisorTargetLocked(contact) || advisorCanReadContact(req, contact)
}

function serviceCanSeeContactLead(req, contact) {
	if (actorRole(req) === 'admin') return true
	const channel = contactChannelOf(contact)
	return channel === 'service' || isBankServiceGroup(contact)
}

function serviceCanReadContact(req, contact) {
	if (actorRole(req) === 'admin') return true
	return serviceCanSeeContactLead(req, contact) && serviceAssignmentMatches(req, contact)
}

function serviceCanListContact(req, contact) {
	if (actorRole(req) === 'admin') return true
	if (!serviceCanSeeContactLead(req, contact)) return false
	return !contact.serviceAssigneeId || serviceAssignmentMatches(req, contact)
}

function assigneeMatches(req, value) {
	return value && req.user && String(value) === String(req.user.uid)
}

function staffCanReplyContact(req, contact) {
	const role = actorRole(req)
	if (role === 'admin') return true
	if (role === 'advisor') {
		if (!advisorCanReadContact(req, contact)) return false
		return !isBankServiceGroup(contact) || advisorAssignmentMatches(req, contact)
	}
	if (role === 'service') {
		return serviceAssignmentMatches(req, contact)
	}
	return false
}

function hasMaterialAccess(req, contact) {
	const role = actorRole(req)
	if (role === 'admin') return true
	if (role === 'user') return contact.userId === req.user.uid
	if (role === 'service') {
		return serviceAssignmentMatches(req, contact)
	}
	if (role === 'advisor') {
		if (!advisorCanReadContact(req, contact)) return false
		return !isBankServiceGroup(contact) || advisorAssignmentMatches(req, contact)
	}
	return false
}

function materialBelongsToContactCase(material = {}, contact = {}) {
	if (!materialHasExplicitScope(material)) return true
	const contactFormal = [
		contact.caseId,
		contact.reportId,
		contact.context && contact.context.caseId,
		contact.context && contact.context.reportId
	].map(normalizedScopeId).filter(Boolean)
	const contactAliases = [
		contact.clientReportId,
		contact.sourceReportId,
		contact.context && contact.context.clientReportId,
		contact.context && contact.context.sourceReportId
	].map(normalizedScopeId).filter(Boolean)
	const materialFormal = [
		material.caseId,
		material.materialScopeId,
		material.reportId
	].map(normalizedScopeId).filter(Boolean)
	const materialAliases = [
		material.clientReportId,
		material.sourceReportId
	].map(normalizedScopeId).filter(Boolean)
	if (materialFormal.some((value) => contactFormal.includes(value))) return true
	if (materialFormal.some((value) => contactAliases.includes(value))) return true
	return materialAliases.some((value) => contactAliases.includes(value))
}

function materialProgressTimestamp(item = {}) {
	const reviewFinal = materialProgressStateRank(item) === 3
	const timestamp = Date.parse(reviewFinal
		? firstNonEmpty(item.reviewedAt, item.updatedAt, item.uploadedAt, item.createdAt, item.updateTime, item.createTime)
		: firstNonEmpty(item.updatedAt, item.uploadedAt, item.reviewedAt, item.createdAt, item.updateTime, item.createTime))
	return Number.isFinite(timestamp) ? timestamp : 0
}

function shouldKeepExistingMaterialState(existing = {}, incoming = {}) {
	const existingRank = materialProgressStateRank(existing)
	const incomingRank = materialProgressStateRank(incoming)
	if (existingRank === incomingRank) {
		const existingTimestamp = materialProgressTimestamp(existing)
		const incomingTimestamp = materialProgressTimestamp(incoming)
		return !!(existingTimestamp && incomingTimestamp && existingTimestamp > incomingTimestamp)
	}
	if ([existingRank, incomingRank].includes(3) && [existingRank, incomingRank].includes(2)) {
		const existingTimestamp = materialProgressTimestamp(existing)
		const incomingTimestamp = materialProgressTimestamp(incoming)
		if (existingTimestamp && incomingTimestamp && existingTimestamp !== incomingTimestamp) {
			return existingTimestamp > incomingTimestamp
		}
	}
	return existingRank > incomingRank
}

function materialProgressSummaryForContact(contact = {}) {
	const caseId = normalizedScopeId(firstNonEmpty(contact.caseId, contact.reportId, LEGACY_MATERIAL_CASE_ID))
	const materialMap = new Map()
	;[
		contact.requiredMaterials,
		contact.pendingMaterials,
		contact.materialList,
		contact.materialChecklist,
		contact.documents,
		contact.materials,
		contact.materialSubmits,
		contact.executionRecords,
		contact.debtExecutionRecords,
		contact.debtProofs,
		contact.supplementMaterials,
		contact.materialReviews
	].forEach((list) => {
		;(Array.isArray(list) ? list : []).forEach((item) => {
			if (!item || !materialBelongsToContactCase(item, contact)) return
			// 已确认属于当前联系记录的材料统一使用联系记录的 canonical case，
			// 避免本地报告别名与云端正式 ID 对同一材料重复计数。
			const itemCaseId = caseId
			const materialType = String(firstNonEmpty(item.materialType, item.type, '')).trim().toLowerCase()
			const identity = materialType
				? `type:${materialType}`
				: firstNonEmpty(item.id, item.materialId, item.key, item.code, materialKey(item))
			const key = `${itemCaseId}|${identity}`
			const existing = materialMap.get(key)
			if (!existing) {
				materialMap.set(key, { ...item })
				return
			}
			const next = { ...existing, ...item }
			if ((!Array.isArray(item.attachments) || item.attachments.length === 0) && Array.isArray(existing.attachments)) {
				next.attachments = existing.attachments
			}
			;['fileUrl', 'uploadUrl', 'url', 'fileName', 'fileSize', 'fileType', 'mimeType', 'uploadedAt'].forEach((field) => {
				if (!item[field] && existing[field]) next[field] = existing[field]
			})
			if (shouldKeepExistingMaterialState(existing, item)) {
				;[
					'status',
					'statusKey',
					'statusText',
					'unavailable',
					'hasMaterial',
					'noMaterial',
					'reviewNote',
					'reviewedAt',
					'reviewedBy',
					'reviewerId'
				].forEach((field) => {
					if (Object.prototype.hasOwnProperty.call(existing, field)) next[field] = existing[field]
					else delete next[field]
				})
			}
			materialMap.set(key, next)
		})
	})
	const materials = Array.from(materialMap.values())
	const summary = {
		caseId,
		total: materials.length,
		uploaded: 0,
		pendingReview: 0,
		confirmed: 0,
		rejected: 0,
		unavailable: 0,
		pendingSupplement: 0,
		draft: 0,
		completionState: 'empty'
	}
	materials.forEach((item) => {
		const status = String(firstNonEmpty(item.status, item.statusKey, '')).trim().toLowerCase()
		const statusText = String(firstNonEmpty(item.statusText, '')).trim()
		const hasUpload = attachmentHasFile(item) || (Array.isArray(item.attachments) && item.attachments.some(attachmentHasFile))
		if (
			['unavailable', 'optional', 'unneeded', 'not_required', 'waived', 'none', 'skipped'].includes(status)
			|| item.unavailable === true
			|| item.hasMaterial === false
			|| item.noMaterial === true
			|| /暂无|无需|不需要|免补/.test(statusText)
		) {
			summary.unavailable += 1
			return
		}
		if (['confirmed', 'approved', 'verified', 'completed', 'done'].includes(status) || /已确认|已通过|已完成/.test(statusText)) {
			summary.confirmed += 1
			if (hasUpload) summary.uploaded += 1
			return
		}
		if (['rejected', 'retry', 'reupload', 'invalid'].includes(status) || /需重传|已驳回|未通过/.test(statusText)) {
			summary.rejected += 1
			if (hasUpload) summary.uploaded += 1
			return
		}
		if (['pending', 'draft', 'missing', 'required', 'to-upload', 'queued', 'pending_sync', 'pending-sync', 'upload-error'].includes(status) || /待上传|待补充|本机已保存|同步失败/.test(statusText)) {
			summary.pendingSupplement += 1
			summary.draft += 1
			return
		}
		if (hasUpload) {
			summary.uploaded += 1
			summary.pendingReview += 1
			return
		}
		if (['provided', 'received', 'available'].includes(status)) {
			summary.pendingReview += 1
			return
		}
		summary.pendingSupplement += 1
		summary.draft += 1
	})
	if (summary.total > 0) {
		if (summary.rejected > 0) summary.completionState = 'action-required'
		else if (summary.pendingSupplement > 0) summary.completionState = 'incomplete'
		else if (summary.pendingReview > 0) summary.completionState = 'pending-review'
		else if (summary.confirmed + summary.unavailable === summary.total) summary.completionState = 'completed'
		else summary.completionState = 'incomplete'
	}
	return summary
}

function materialProgressStateRank(item = {}) {
	const status = String(firstNonEmpty(item.status, item.statusKey, '')).trim().toLowerCase()
	const statusText = String(firstNonEmpty(item.statusText, '')).trim()
	if (
		['unavailable', 'optional', 'unneeded', 'not_required', 'waived', 'none', 'skipped'].includes(status)
		|| item.unavailable === true
		|| item.hasMaterial === false
		|| item.noMaterial === true
		|| /暂无|无需|不需要|免补/.test(statusText)
		|| ['confirmed', 'approved', 'verified', 'completed', 'done', 'rejected', 'retry', 'reupload', 'invalid'].includes(status)
		|| /已确认|已通过|已完成|需重传|已驳回|未通过/.test(statusText)
	) return 3
	if (
		attachmentHasFile(item)
		|| (Array.isArray(item.attachments) && item.attachments.some(attachmentHasFile))
		|| ['provided', 'received', 'available'].includes(status)
	) return 2
	return 1
}

function redactMaterialFields(contact = {}) {
	const materialProgressSummary = contact.materialProgressSummary && typeof contact.materialProgressSummary === 'object'
		? contact.materialProgressSummary
		: materialProgressSummaryForContact(contact)
	const materialCount = materialProgressSummary.total
	const context = contact.context && typeof contact.context === 'object'
		? { ...contact.context }
		: contact.context
	if (context && typeof context === 'object') {
		;[
			'materials',
			'supplementMaterials',
			'requiredMaterials',
			'pendingMaterials',
			'materialSubmits',
			'materialReviews',
			'materialList',
			'materialChecklist',
			'documents',
			'executionRecords',
			'debtExecutionRecords',
			'debtProofs'
		].forEach((key) => {
			if (Object.prototype.hasOwnProperty.call(context, key)) context[key] = []
		})
	}
	return {
		...contact,
		context,
		materialAccess: false,
		materialsRedacted: materialCount > 0,
		materialCount,
		materialProgressSummary,
		materials: [],
		supplementMaterials: [],
		requiredMaterials: [],
		pendingMaterials: [],
		materialSubmits: [],
		materialReviews: [],
		materialList: [],
		materialChecklist: [],
		documents: [],
		executionRecords: [],
		debtExecutionRecords: [],
		debtProofs: [],
		materialAccessText: materialCount > 0 ? '接单后可查看客户资料' : '暂无客户资料'
	}
}

function maskedContactName(value) {
	const text = String(value || '').trim()
	if (!text) return '客户'
	return `${text.slice(0, 1)}${'*'.repeat(Math.min(3, Math.max(1, text.length - 1)))}`
}

function redactStaffLeadForList(contact = {}) {
	const id = contactIdOf(contact)
	const phone = firstNonEmpty(contact.phone, contact.mobile)
	const product = contact.product && typeof contact.product === 'object' ? contact.product : {}
	const status = String(contact.status || 'pending')
	const displayName = maskedContactName(firstNonEmpty(contact.clientName, contact.customerName, contact.name, contact.userName))
	return {
		id,
		contactId: id,
		channel: contactChannelOf(contact),
		contactType: String(contact.contactType || ''),
		institution: maskPhoneText(contactInstitutionOf(contact)),
		productId: firstNonEmpty(contact.productId, product.id, product.productId),
		productName: maskPhoneText(firstNonEmpty(contact.productName, product.name, product.productName, '匹配方案')),
		name: displayName,
		clientName: displayName,
		customerName: displayName,
		phone: '',
		mobile: '',
		phoneMasked: phone ? maskPhone(phone) : '',
		status,
		statusText: ({ pending: '待处理', processing: '处理中', completed: '已完成', cancelled: '已取消' })[status] || '待处理',
		createTime: firstNonEmpty(contact.createTime, contact.createdAt),
		updateTime: firstNonEmpty(contact.updateTime, contact.updatedAt, contact.createTime, contact.createdAt),
		groupMode: isBankServiceGroup(contact) ? 'service-bank-customer' : '',
		serviceRequired: isBankServiceGroup(contact),
		leadOnly: true,
		claimRequired: true,
		advisorJoinRequired: isBankServiceGroup(contact),
		chatAccess: false,
		materialAccess: false,
		messages: [],
		visibleMessageCount: 0,
		unreadCount: 0,
		reportScore: null,
		reportScoreVerified: false
	}
}

function maskPhoneText(value) {
	return String(value || '').replace(/(^|[^\d])(1[3-9]\d{9})(?=$|[^\d])/g, (_match, prefix, phone) => `${prefix}${maskPhone(phone)}`)
}

function copyStaffFields(source, target, fields, textFields = []) {
	const text = new Set(textFields)
	fields.forEach((key) => {
		if (!Object.prototype.hasOwnProperty.call(source, key)) return
		const value = source[key]
		if (value === undefined) return
		if (text.has(key)) {
			if (typeof value === 'string' || typeof value === 'number') target[key] = maskPhoneText(String(value))
			return
		}
		if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) target[key] = value
	})
	return target
}

function publicStaffDisplayList(value) {
	return (Array.isArray(value) ? value : []).map((item) => {
		if (typeof item === 'string') return maskPhoneText(item)
		if (!item || typeof item !== 'object') return item
		return copyStaffFields(item, {},
			['id', 'key', 'code', 'type', 'title', 'name', 'label', 'desc', 'description', 'reason', 'status', 'statusText'],
			['title', 'name', 'label', 'desc', 'description', 'reason', 'statusText'])
	})
}

function publicStaffProduct(value = {}) {
	const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
	const out = copyStaffFields(source, {}, [
		'id', 'productId', 'name', 'title', 'productName', 'institution', 'bankName', 'parentInstitution',
		'rateText', 'interestRate', 'rate', 'aprText', 'amountText', 'amount', 'creditLimitText',
		'termText', 'term', 'periodText', 'businessName', 'serviceName', 'source'
	], [
		'name', 'title', 'productName', 'institution', 'bankName', 'parentInstitution',
		'rateText', 'interestRate', 'rate', 'aprText', 'amountText', 'amount', 'creditLimitText',
		'termText', 'term', 'periodText', 'businessName', 'serviceName'
	])
	if (Array.isArray(source.tags)) out.tags = publicStaffDisplayList(source.tags)
	if (Array.isArray(source.matchReasons)) out.matchReasons = publicStaffDisplayList(source.matchReasons)
	if (Array.isArray(source.requiredMaterials)) out.requiredMaterials = source.requiredMaterials.map(publicStaffMaterial)
	if (Array.isArray(source.materials)) out.materials = source.materials.map(publicStaffMaterial)
	if (Array.isArray(source.materialChecklist)) out.materialChecklist = source.materialChecklist.map(publicStaffMaterial)
	return out
}

function publicStaffReport(value = {}) {
	const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
	return copyStaffFields(source, {}, [
		'id', 'reportId', 'cloudReportId', 'clientReportId', 'sourceReportId',
		'title', 'fileName', 'reportType', 'date', 'reportDate', 'createdAt', 'updatedAt'
	], ['title', 'fileName', 'reportType'])
}

function publicStaffPayload(value = {}) {
	const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
	const out = copyStaffFields(source, {}, [
		'id', 'messageId', 'contactId', 'statusId', 'associationId', 'reportId', 'caseId', 'clientReportId', 'sourceReportId',
		'productId', 'materialId', 'executionRecordId', 'debtId', 'inviteId', 'feedbackId', 'completionId',
		'actionId', 'stage', 'status', 'statusText', 'source', 'type', 'action', 'linkType', 'url', 'actionUrl',
		'route', 'page', 'section', 'filter', 'title', 'label', 'name', 'desc', 'description', 'note', 'content',
		'summary', 'createdAt', 'updatedAt', 'openedAt', 'landedAt', 'handledAt', 'sequence', 'messageSequence',
		'count', 'total', 'required', 'acknowledged'
	], ['statusText', 'action', 'title', 'label', 'name', 'desc', 'description', 'note', 'content', 'summary'])
	if (source.product && typeof source.product === 'object') out.product = publicStaffProduct(source.product)
	if (source.report && typeof source.report === 'object') out.report = publicStaffReport(source.report)
	return out
}

function publicStaffMessage(value = {}) {
	const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
	const out = copyStaffFields(source, {}, [
		'id', 'messageId', 'contactId', 'userId', 'reportId', 'caseId', 'clientReportId', 'sourceReportId',
		'channel', 'senderType', 'senderRole', 'senderId', 'senderName',
		'content', 'createdAt', 'updatedAt', 'updateTime', 'messageSequence', 'sequence', 'eventType',
		'advisorId', 'serviceId', 'assigneeId', 'claimedAt', 'inviteId', 'feedbackId', 'completionId',
		'previousGroupName', 'groupName', 'readByCount', 'readStatus', 'readStatusText', 'localPending'
	], ['senderName', 'content', 'previousGroupName', 'groupName', 'readStatusText'])
	if (Array.isArray(source.mentions)) {
		out.mentions = source.mentions.map((item) => copyStaffFields(item || {}, {}, ['role', 'label'], ['label']))
	}
	if (Array.isArray(source.readBy)) {
		out.readBy = source.readBy.map((item) => copyStaffFields(item || {}, {}, ['actorId', 'actorRole', 'actorName', 'readAt'], ['actorName']))
	}
	if (source.product && typeof source.product === 'object') out.product = publicStaffProduct(source.product)
	if (source.report && typeof source.report === 'object') out.report = publicStaffReport(source.report)
	if (source.payload && typeof source.payload === 'object') out.payload = publicStaffPayload(source.payload)
	return out
}

function publicStaffAttachment(value = {}) {
	const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
	return copyStaffFields(source, {}, [
		'id', 'attachmentId', 'materialId', 'uploadUrl', 'fileUrl', 'url', 'fileName', 'fileSize',
		'fileType', 'mimeType', 'uploadedAt', 'createdAt', 'updatedAt', 'source'
	], ['fileName'])
}

function publicStaffMaterial(value = {}, index = 0) {
	if (typeof value === 'string') return maskPhoneText(value)
	const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
	const out = copyStaffFields(source, {}, [
		'id', 'materialId', 'key', 'code', 'type', 'materialType', 'name', 'materialName', 'title', 'label',
		'userId', 'contactId', 'institution',
		'group', 'status', 'statusKey', 'statusText', 'required', 'unavailable', 'hasMaterial', 'noMaterial',
		'note', 'desc', 'description', 'remark', 'reviewNote', 'rejectReason', 'reason', 'reviewRemark',
		'reviewedAt', 'reviewTime', 'reviewedBy', 'reviewerId', 'reviewAckStage', 'reviewAcknowledgedAt',
		'reviewAcknowledgedNote', 'uploadUrl', 'fileUrl', 'url', 'fileName', 'fileSize', 'fileType', 'mimeType',
		'uploadedAt', 'createdAt', 'updatedAt', 'source', 'reportId', 'caseId', 'materialScopeId', 'clientReportId',
		'sourceReportId', 'messageId', 'executionRecordId', 'debtId', 'productName', 'months', 'sameEmployerMonths',
		'employerCount', 'monthlyIncome', 'annualTaxableIncome', 'declaredValue', 'companyName', 'educationLevel',
		'attachmentCount'
	], [
		'name', 'materialName', 'title', 'label', 'group', 'statusText', 'note', 'desc', 'description', 'remark',
		'reviewNote', 'rejectReason', 'reason', 'reviewRemark', 'reviewedBy', 'reviewAcknowledgedNote', 'fileName',
		'productName', 'companyName', 'educationLevel', 'institution'
	])
	if (!out.id && !out.materialId && index >= 0) out.id = `material_${index}`
	if (Array.isArray(source.attachments)) out.attachments = source.attachments.map(publicStaffAttachment)
	if (source.reviewReceipt && typeof source.reviewReceipt === 'object') out.reviewReceipt = publicStaffPayload(source.reviewReceipt)
	return out
}

function publicStaffProgressSummary(value = {}) {
	const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
	return copyStaffFields(source, {}, [
		'caseId', 'total', 'uploaded', 'pendingReview', 'confirmed', 'rejected', 'unavailable',
		'pendingSupplement', 'draft', 'completionState'
	])
}

function publicStaffInvite(value = {}) {
	const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
	return copyStaffFields(source, {}, [
		'id', 'inviteId', 'contactId', 'userId', 'advisorId', 'advisorName', 'institution', 'invitedById',
		'invitedByRole', 'invitedByName', 'note', 'createdAt'
	], ['advisorName', 'institution', 'invitedByName', 'note'])
}

function publicStaffFeedback(value = {}) {
	const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
	const out = copyStaffFields(source, {}, [
		'id', 'feedbackId', 'contactId', 'userId', 'customerName', 'rating', 'content',
		'serviceAssigneeId', 'serviceAssigneeName', 'advisorAssigneeId', 'advisorAssigneeName', 'channel', 'createdAt'
	], ['customerName', 'content', 'serviceAssigneeName', 'advisorAssigneeName'])
	if (Array.isArray(source.tags)) out.tags = publicStaffDisplayList(source.tags)
	return out
}

function publicStaffCompletion(value = {}) {
	const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
	return copyStaffFields(source, {}, [
		'id', 'completionId', 'contactId', 'userId', 'completedById', 'completedByRole', 'completedByName',
		'businessConfirmed', 'note', 'createdAt'
	], ['completedByName', 'note'])
}

function publicStaffClear(value = {}) {
	const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
	return copyStaffFields(source, {}, [
		'id', 'contactId', 'userId', 'actorId', 'actorRole', 'actorName', 'clearedAt', 'createdAt',
		'clearSequence', 'sequence', 'reopenedByCustomer', 'reopenedAt', 'reopenedMessageId'
	], ['actorName'])
}

function publicStaffReadState(value = {}) {
	const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
	return copyStaffFields(source, {}, [
		'id', 'contactId', 'actorId', 'actorRole', 'actorName', 'readAt', 'createdAt', 'updatedAt', 'sequence'
	], ['actorName'])
}

function publicStaffNote(value = {}) {
	const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
	return copyStaffFields(source, {}, [
		'id', 'noteId', 'contactId', 'userId', 'actorId', 'actorRole', 'actorName', 'text', 'note',
		'content', 'createdAt', 'updatedAt'
	], ['actorName', 'text', 'note', 'content'])
}

function publicStaffAdvisorInfo(value = {}) {
	const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
	return copyStaffFields(source, {}, [
		'id', 'uid', 'advisorId', 'name', 'realName', 'institution', 'bank', 'role', 'avatar', 'avatarUrl'
	], ['name', 'realName', 'institution', 'bank'])
}

function publicStaffContext(value = {}) {
	const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
	const out = copyStaffFields(source, {}, [
		'userId', 'clientUid', 'clientId', 'reportId', 'caseId', 'clientReportId', 'sourceReportId',
		'productId', 'productName', 'institution', 'parentInstitution', 'rateText', 'amountText', 'termText',
		'contactType', 'channel', 'deskType', 'source', 'contactSource', 'entrySource', 'sourceType', 'origin',
		'contactIntent', 'consultIntent', 'businessIntent', 'intent', 'businessType', 'serviceType', 'businessCode',
		'serviceCode', 'businessName', 'serviceName', 'businessLabel', 'summary', 'avatar', 'avatarUrl',
		'createdAt', 'updatedAt'
	], [
		'productName', 'institution', 'parentInstitution', 'rateText', 'amountText', 'termText', 'businessName',
		'serviceName', 'businessLabel', 'summary'
	])
	if (source.product && typeof source.product === 'object') out.product = publicStaffProduct(source.product)
	if (source.productInfo && typeof source.productInfo === 'object') out.productInfo = publicStaffProduct(source.productInfo)
	if (source.report && typeof source.report === 'object') out.report = publicStaffReport(source.report)
	if (source.reportInfo && typeof source.reportInfo === 'object') out.reportInfo = publicStaffReport(source.reportInfo)
	if (source.messageContext && typeof source.messageContext === 'object') out.messageContext = publicStaffPayload(source.messageContext)
	if (source.advisorInfo && typeof source.advisorInfo === 'object') out.advisorInfo = publicStaffAdvisorInfo(source.advisorInfo)
	if (Array.isArray(source.messages)) out.messages = source.messages.map(publicStaffMessage)
	for (const key of [
		'materials', 'supplementMaterials', 'requiredMaterials', 'pendingMaterials', 'materialSubmits',
		'materialReviews', 'materialList', 'materialChecklist', 'documents', 'executionRecords',
		'debtExecutionRecords', 'debtProofs'
	]) {
		if (Array.isArray(source[key])) out[key] = source[key].map(publicStaffMaterial)
	}
	if (source.materialProgressSummary && typeof source.materialProgressSummary === 'object') {
		out.materialProgressSummary = publicStaffProgressSummary(source.materialProgressSummary)
	}
	return out
}

function publicStaffContact(value = {}, options = {}) {
	const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
	const out = copyStaffFields(source, {}, [
		'_id', 'id', 'contactId', 'userId', 'uid', 'clientUid', 'clientId', 'reportId', 'caseId', 'clientReportId',
		'sourceReportId', 'sourceMessageId', 'messageId', 'name', 'clientName', 'userName', 'customerName',
		'reportCustomerName', 'avatar', 'avatarUrl', 'status', 'statusText', 'createTime', 'createdAt', 'updateTime',
		'updatedAt', 'channel', 'deskType', 'contactType', 'contactIntent', 'institution', 'parentInstitution',
		'productId', 'productName', 'rateText', 'amountText', 'termText', 'source', 'businessType', 'serviceType',
		'businessName', 'summary', 'reportTitle', 'reportDate', 'reportType', 'groupMode', 'groupName', 'groupTitle',
		'displayTitle', 'serviceRequired', 'serviceStatus', 'serviceAssigneeId', 'serviceAssigneeName',
		'serviceAssignedAt', 'serviceCompletedAt', 'advisorStatus', 'advisorId', 'advisorAssigneeId',
		'advisorAssigneeName', 'advisorAssignedAt', 'advisorCompletedAt', 'invitedAdvisorId', 'invitedAdvisorName',
		'invitedAdvisorInstitution', 'advisorInvitedAt', 'advisorJoinRequired', 'advisorAccessText', 'chatAccess',
		'materialAccess', 'materialsRedacted', 'materialAccessText', 'materialCount', 'orderStatus', 'orderCreatedAt',
		'orderAssignedAt', 'customerChatClosed', 'customerChatClosedAt', 'customerChatClosedReason',
		'reopenedByCustomer', 'reopenedAt', 'reopenedMessageId', 'clearSequence', 'totalMessageCount',
		'visibleMessageCount', 'unreadCount', 'hasUnread', 'feedbackCount', 'completionCount'
	], [
		'name', 'clientName', 'userName', 'customerName', 'reportCustomerName', 'statusText', 'institution',
		'parentInstitution', 'productName', 'rateText', 'amountText', 'termText', 'businessName', 'summary',
		'reportTitle', 'reportType', 'groupName', 'groupTitle', 'displayTitle', 'serviceAssigneeName',
		'advisorAssigneeName', 'invitedAdvisorName', 'invitedAdvisorInstitution', 'advisorAccessText',
		'materialAccessText', 'customerChatClosedReason'
	])
	out.phone = ''
	out.mobile = ''
	out.phoneMasked = options.phone ? maskPhone(options.phone) : ''
	out.reportScore = null
	out.reportScoreVerified = false
	if (source.product && typeof source.product === 'object') out.product = publicStaffProduct(source.product)
	if (source.report && typeof source.report === 'object') out.report = publicStaffReport(source.report)
	if (source.context && typeof source.context === 'object') out.context = publicStaffContext(source.context)
	if (source.advisorInfo && typeof source.advisorInfo === 'object') out.advisorInfo = publicStaffAdvisorInfo(source.advisorInfo)
	if (Array.isArray(source.messages)) out.messages = source.messages.map(publicStaffMessage)
	if (source.latestMessage && typeof source.latestMessage === 'object') out.latestMessage = publicStaffMessage(source.latestMessage)
	if (source.chatReadState && typeof source.chatReadState === 'object') out.chatReadState = publicStaffReadState(source.chatReadState)
	if (Array.isArray(source.chatReadStates)) out.chatReadStates = source.chatReadStates.map(publicStaffReadState)
	if (Array.isArray(source.chatClears)) out.chatClears = source.chatClears.map(publicStaffClear)
	if (Array.isArray(source.advisorInviteRecords)) out.advisorInviteRecords = source.advisorInviteRecords.map(publicStaffInvite)
	if (Array.isArray(source.serviceFeedbacks)) out.serviceFeedbacks = source.serviceFeedbacks.map(publicStaffFeedback)
	if (source.latestFeedback && typeof source.latestFeedback === 'object') out.latestFeedback = publicStaffFeedback(source.latestFeedback)
	if (Array.isArray(source.completionRecords)) out.completionRecords = source.completionRecords.map(publicStaffCompletion)
	if (source.latestCompletion && typeof source.latestCompletion === 'object') out.latestCompletion = publicStaffCompletion(source.latestCompletion)
	if (Array.isArray(source.notes)) out.notes = source.notes.map(publicStaffNote)
	if (Array.isArray(source.serviceNotes)) out.serviceNotes = source.serviceNotes.map(publicStaffNote)
	if (Array.isArray(source.messageActionReceipts)) out.messageActionReceipts = source.messageActionReceipts.map(publicStaffPayload)
	for (const key of [
		'materials', 'supplementMaterials', 'requiredMaterials', 'pendingMaterials', 'materialSubmits',
		'materialReviews', 'materialList', 'materialChecklist', 'documents', 'executionRecords',
		'debtExecutionRecords', 'debtProofs'
	]) {
		if (Array.isArray(source[key])) out[key] = source[key].map(publicStaffMaterial)
	}
	if (source.materialProgressSummary && typeof source.materialProgressSummary === 'object') {
		out.materialProgressSummary = publicStaffProgressSummary(source.materialProgressSummary)
	}
	const pushBinding = publicPushBindingForStaff(options.pushBinding)
	if (pushBinding) {
		out.pushBinding = pushBinding
		out.pushBindings = [pushBinding]
		out.systemPushBinding = pushBinding
	}
	return out
}

function publicPushBindingForStaff(value = {}) {
	const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
	const status = String(firstNonEmpty(source.status, source.permissionStatus, source.permission, '')).trim().toLowerCase()
	const platform = String(firstNonEmpty(source.platform, '')).trim().toLowerCase()
	const updatedAtRaw = firstNonEmpty(source.updatedAt, source.updateTime, source.boundAt, source.syncedAt, '')
	const updatedAtMs = Date.parse(updatedAtRaw)
	const safeStatus = new Set(['granted', 'denied', 'prompt', 'pending', 'unsupported', 'revoked']).has(status) ? status : ''
	const safePlatform = new Set(['browser', 'web', 'h5', 'android', 'ios', 'harmony', 'wechat', 'mini-program']).has(platform) ? platform : ''
	if (!safeStatus && !safePlatform && !Number.isFinite(updatedAtMs)) return null
	return {
		status: safeStatus,
		platform: safePlatform,
		updatedAt: Number.isFinite(updatedAtMs) ? new Date(updatedAtMs).toISOString() : ''
	}
}

function canStaffReadContact(req, contact) {
	const role = actorRole(req)
	if (role === 'admin') return true
	if (role === 'advisor') {
		return advisorCanReadContact(req, contact)
	}
	if (role === 'service') {
		return serviceCanReadContact(req, contact)
	}
	return false
}

function canStaffListContact(req, contact) {
	const role = actorRole(req)
	if (role === 'admin') return true
	if (role === 'advisor') return advisorCanListContact(req, contact)
	if (role === 'service') return serviceCanListContact(req, contact)
	return false
}

function contactEventSequence(contact = {}) {
	const values = [Number(contact.eventSequence || 0)]
	;(Array.isArray(contact.messages) ? contact.messages : []).forEach((message) => {
		values.push(Number(message && firstNonEmpty(message.messageSequence, message.sequence, 0)))
	})
	;(Array.isArray(contact.chatClears) ? contact.chatClears : []).forEach((record) => {
		values.push(Number(record && firstNonEmpty(record.clearSequence, record.sequence, 0)))
	})
	return Math.max(0, ...values.filter((value) => Number.isFinite(value)))
}

function nextContactEventSequence(contact = {}) {
	const next = contactEventSequence(contact) + 1
	contact.eventSequence = next
	return next
}

function latestClearRecordForActor(req, contact) {
	const role = actorRole(req)
	const actorId = req.user && req.user.uid
	if (!actorId) return null
	const clears = Array.isArray(contact.chatClears) ? contact.chatClears : []
	return clears
		.filter((item) => item.actorRole === role && String(item.actorId || '') === String(actorId))
		.slice()
		.sort((a, b) => {
			const sequenceDiff = Number(b.clearSequence || b.sequence || 0) - Number(a.clearSequence || a.sequence || 0)
			if (sequenceDiff) return sequenceDiff
			return String(b.clearedAt || b.createdAt || '').localeCompare(String(a.clearedAt || a.createdAt || ''))
		})[0] || null
}

function messageOccursAfterClear(message = {}, clear = {}) {
	const messageSequence = Number(firstNonEmpty(message.messageSequence, message.sequence, 0))
	const clearSequence = Number(firstNonEmpty(clear.clearSequence, clear.sequence, 0))
	if (messageSequence > 0 && clearSequence > 0) return messageSequence > clearSequence
	const messageTs = new Date(message.createdAt || message.updateTime || 0).getTime()
	const clearTs = new Date(clear.clearedAt || clear.createdAt || 0).getTime()
	if (!Number.isFinite(messageTs) || !Number.isFinite(clearTs)) return false
	// 旧版清除记录没有 sequence。新版本消息必定带 sequence，时间恰好落在同一毫秒时
	// 仍可确认该消息是在本次请求中追加，使用 >= 兼容旧数据。
	return messageSequence > 0 && clearSequence === 0 ? messageTs >= clearTs : messageTs > clearTs
}

function incomingMessageReopensForRole(message = {}, role = 'user', actorId = '') {
	if (!message || message.senderType === 'system') return false
	if (actorId && message.senderId && String(message.senderId) === String(actorId)) return false
	if (role === 'service' || role === 'advisor') return message.senderType === 'user'
	return message.senderType !== senderTypeForRole(role)
}

function reopenStateForActor(req, contact) {
	const clear = latestClearRecordForActor(req, contact)
	if (!clear) return { reopenedByCustomer: false, reopenedAt: '', reopenedMessageId: '', clearSequence: 0 }
	const role = actorRole(req)
	const actorId = req.user && req.user.uid
	const messages = Array.isArray(contact.messages) ? contact.messages : []
	const reopeningMessage = messages
		.filter((message) => incomingMessageReopensForRole(message, role, actorId) && messageOccursAfterClear(message, clear))
		.sort((a, b) => {
			const sequenceDiff = Number(b.messageSequence || b.sequence || 0) - Number(a.messageSequence || a.sequence || 0)
			if (sequenceDiff) return sequenceDiff
			return String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
		})[0]
	return {
		reopenedByCustomer: !!reopeningMessage,
		reopenedAt: reopeningMessage ? reopeningMessage.createdAt || '' : '',
		reopenedMessageId: reopeningMessage ? reopeningMessage.id || '' : '',
		clearSequence: Number(clear.clearSequence || clear.sequence || 0) || 0
	}
}

function markCustomerReopenRecords(contact, message) {
	if (!message || message.senderType !== 'user') return []
	const updated = []
	;(Array.isArray(contact.chatClears) ? contact.chatClears : []).forEach((clear) => {
		if (!['service', 'advisor'].includes(String(clear.actorRole || ''))) return
		if (!messageOccursAfterClear(message, clear)) return
		clear.reopenedByCustomer = true
		clear.reopenedAt = message.createdAt || nowIso()
		clear.reopenedMessageId = message.id || ''
		clear.reopenedSequence = Number(message.messageSequence || message.sequence || 0) || 0
		updated.push(clear)
	})
	if (updated.length) {
		contact.lastCustomerReopenAt = message.createdAt || nowIso()
		contact.lastCustomerReopenMessageId = message.id || ''
	}
	return updated
}

function shouldHideContactForActor(req, contact) {
	const role = actorRole(req)
	if (role === 'admin') return false
	if (role === 'user' && contact.customerChatClosed === true) return true
	const latestClear = latestClearRecordForActor(req, contact)
	if (!latestClear) return false
	const messages = Array.isArray(contact.messages) ? contact.messages : []
	const actorId = req.user && req.user.uid
	const hasIncomingAfterClear = messages.some((message) => {
		return incomingMessageReopensForRole(message, role, actorId) && messageOccursAfterClear(message, latestClear)
	})
	return !hasIncomingAfterClear
}

function findAdvisorContact(req, contactId, opts = {}) {
	const id = cleanId(contactId)
	if (!id) return null
	const allowAdvisor = !!opts.allowAdvisor && isAdvisorActor(req)
	const allowStaff = !!opts.allowStaff && isStaffActor(req)
		return ensureArray('advisorContacts').find((item) => {
			if (contactIdOf(item) !== id) return false
			const advisorCanRead = allowAdvisor && advisorCanReadContact(req, item)
			return item.userId === req.user.uid || advisorCanRead || (allowStaff && canStaffListContact(req, item))
		}) || null
	}

function visibleAdvisorContacts(req) {
	const all = ensureArray('advisorContacts')
	if (isStaffActor(req)) return all.filter((item) => canStaffListContact(req, item) && !shouldHideContactForActor(req, item))
	return byUser(all, req.user.uid).filter((item) => !shouldHideContactForActor(req, item))
}

const TOP_LEVEL_SERVER_OWNED_INPUT_FIELDS = new Set([
	'_id', 'id', 'userId', 'uid',
	'createTime', 'createdAt', 'updateTime', 'updatedAt'
])

const SERVER_OWNED_INPUT_FIELDS = new Set([
	'advisorId',
	'advisorAssigneeId', 'advisorAssigneeName', 'advisorAssignedAt', 'advisorCompletedAt',
	'serviceAssigneeId', 'serviceAssigneeName', 'serviceAssignedAt', 'serviceCompletedAt',
	'invitedAdvisorId', 'invitedAdvisorName', 'invitedAdvisorInstitution', 'advisorInvitedAt',
	'advisorInviteRecords', 'advisorStatus', 'serviceStatus',
	'advisorJoinRequired', 'advisorAccessText', 'chatAccess',
	'materialAccess', 'materialsRedacted', 'materialAccessText',
	'groupMode', 'serviceRequired',
	'orderStatus', 'orderCreatedAt', 'orderAssignedAt',
	'messages', 'chatReadStates', 'chatClears', 'eventSequence',
	'notes', 'serviceNotes', 'messageActionReceipts',
	'materials', 'supplementMaterials', 'requiredMaterials', 'pendingMaterials',
	'materialSubmits', 'materialReviews', 'documents', 'executionRecords',
	'debtExecutionRecords', 'debtProofs',
	'localFilePath', 'localPath', 'tempFilePath'
])

function stripServerOwnedFields(value = {}, depth = 0) {
	if (Array.isArray(value)) return value.map((item) => stripServerOwnedFields(item, depth + 1))
	if (!value || typeof value !== 'object') return value
	const out = {}
	Object.keys(value).forEach((key) => {
		if (SERVER_OWNED_INPUT_FIELDS.has(key) || (depth === 0 && TOP_LEVEL_SERVER_OWNED_INPUT_FIELDS.has(key))) return
		out[key] = stripServerOwnedFields(value[key], depth + 1)
	})
	return out
}

function stripLocalPathFields(value) {
	if (Array.isArray(value)) return value.map(stripLocalPathFields)
	if (!value || typeof value !== 'object') return value
	const out = {}
	Object.keys(value).forEach((key) => {
		if (['localFilePath', 'localPath', 'tempFilePath'].includes(key)) return
		out[key] = stripLocalPathFields(value[key])
	})
	return out
}

function firstNonEmpty(...values) {
	for (const value of values) {
		if (value !== undefined && value !== null && value !== '') return value
	}
	return ''
}

function isPublisherActor(req) {
	const user = currentAuthUser(req)
	return !!(user && hasRole(user, ['publisher', 'admin']))
}

function cleanText(value = '', max = 2000) {
	return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function normalizeAudience(value) {
	const allowed = new Set(['user', 'advisor', 'service', 'admin'])
	const raw = Array.isArray(value) ? value : String(value || '').split(',')
	const list = raw.map((item) => String(item || '').trim().toLowerCase()).filter((item) => allowed.has(item))
	return list.length ? [...new Set(list)] : ['user', 'advisor', 'service', 'admin']
}

function normalizeContentArticlePayload(body = {}, req, existing = {}) {
	const author = currentAuthUser(req) || {}
	const now = nowIso()
	const title = cleanText(firstNonEmpty(body.title, existing.title), 60)
	const content = String(firstNonEmpty(body.content, existing.content, '')).trim().slice(0, 12000)
	const summary = cleanText(firstNonEmpty(body.summary, existing.summary, content), 140)
	const status = ['draft', 'published', 'hidden'].includes(String(body.status || '').trim())
		? String(body.status).trim()
		: firstNonEmpty(existing.status, 'published')
	return {
		...existing,
		id: existing.id || makeId('article'),
		title,
		summary,
		content,
		category: cleanText(firstNonEmpty(body.category, existing.category, '信用热点'), 20),
		level: ['normal', 'important'].includes(String(body.level || '').trim()) ? String(body.level).trim() : firstNonEmpty(existing.level, 'normal'),
		tags: Array.isArray(body.tags)
			? body.tags.map((item) => cleanText(item, 12)).filter(Boolean).slice(0, 6)
			: (Array.isArray(existing.tags) ? existing.tags : []),
		source: cleanText(firstNonEmpty(body.source, existing.source, '分析报告工作台内容中心'), 40),
		coverUrl: cleanText(firstNonEmpty(body.coverUrl, existing.coverUrl), 500),
		audience: normalizeAudience(firstNonEmpty(body.audience, existing.audience)),
		status,
		authorId: existing.authorId || req.user.uid,
		authorName: firstNonEmpty(existing.authorName, author.nickname, author.phone, '内容运营'),
		createdAt: existing.createdAt || now,
		updatedAt: now,
		publishedAt: status === 'published' ? firstNonEmpty(body.publishedAt, existing.publishedAt, now) : existing.publishedAt || ''
	}
}

function publicArticle(article = {}) {
	return {
		id: article.id,
		title: article.title || '',
		summary: article.summary || '',
		content: article.content || '',
		category: article.category || '信用热点',
		level: article.level || 'normal',
		tags: Array.isArray(article.tags) ? article.tags : [],
		source: article.source || '分析报告工作台内容中心',
		coverUrl: article.coverUrl || '',
		audience: Array.isArray(article.audience) ? article.audience : ['user', 'advisor', 'service', 'admin'],
		status: article.status || 'published',
		authorName: article.authorName || '内容运营',
		publishedAt: article.publishedAt || article.createdAt || '',
		updatedAt: article.updatedAt || article.createdAt || ''
	}
}

function sortedArticles(list = []) {
	return list.slice().sort((a, b) => String(b.publishedAt || b.updatedAt || b.createdAt || '').localeCompare(String(a.publishedAt || a.updatedAt || a.createdAt || '')))
}

function materialKey(item = {}) {
	return [
		item.materialId || item.id || item.key || item.code || '',
		item.materialName || item.name || item.title || item.label || '',
		item.uploadUrl || item.url || item.fileUrl || '',
		item.executionRecordId || '',
		item.debtId || ''
	].map((v) => String(v || '')).join('|')
}

function upsertByKey(list, item, keyFn) {
	const key = keyFn(item)
	const idx = key ? list.findIndex((row) => keyFn(row) === key) : -1
	if (idx >= 0) list[idx] = { ...list[idx], ...item }
	else list.unshift(item)
}

function normalizeMaterialPayload(body = {}) {
	const uploadedAt = firstNonEmpty(body.uploadedAt, body.updatedAt, nowIso())
	const materialId = firstNonEmpty(body.materialId, body.id, body.key, body.code)
	const materialName = firstNonEmpty(body.materialName, body.name, body.title, body.label)
	return {
		id: materialId || makeId('mat'),
		materialId,
		name: materialName || '补充材料',
		materialName: materialName || '补充材料',
		status: 'uploaded',
		statusText: '待确认',
		reviewNote: '',
		rejectReason: '',
		reason: '',
		reviewRemark: '',
		reviewedAt: '',
		reviewTime: '',
		reviewedBy: '',
		reviewerId: '',
		uploadUrl: firstNonEmpty(body.uploadUrl, body.url, body.fileUrl),
		fileName: firstNonEmpty(body.fileName, body.nameOnDisk, body.uploadName),
		fileSize: body.fileSize === undefined ? '' : body.fileSize,
		uploadedAt,
		reportId: firstNonEmpty(body.reportId),
		productName: firstNonEmpty(body.productName),
		messageId: firstNonEmpty(body.messageId),
		source: firstNonEmpty(body.source, 'user-advisor-material'),
		updatedAt: uploadedAt
	}
}

function attachMaterial(contact, material) {
	if (!Array.isArray(contact.materials)) contact.materials = []
	if (!Array.isArray(contact.materialSubmits)) contact.materialSubmits = []
	upsertByKey(contact.materials, material, materialKey)
	upsertByKey(contact.materialSubmits, material, materialKey)
	contact.updateTime = nowIso()
}

function patchReviewedMaterial(contact, body = {}) {
	const materialType = firstNonEmpty(body.materialType, body.type)
	const review = {
		id: firstNonEmpty(body.materialId, body.id, body.key, body.code, makeId('mat')),
		materialId: firstNonEmpty(body.materialId, body.id, body.key, body.code),
		type: materialType,
		materialType,
		name: firstNonEmpty(body.materialName, body.name, body.title, body.label, '补充材料'),
		materialName: firstNonEmpty(body.materialName, body.name, body.title, body.label, '补充材料'),
		status: firstNonEmpty(body.status, 'confirmed'),
		statusText: firstNonEmpty(body.statusText, body.status === 'rejected' ? '需重传' : '已确认'),
		reviewNote: firstNonEmpty(body.reviewNote, body.rejectReason, body.reason, body.note),
		reviewedAt: firstNonEmpty(body.reviewedAt, nowIso()),
		source: firstNonEmpty(body.source),
		executionRecordId: firstNonEmpty(body.executionRecordId),
		debtId: firstNonEmpty(body.debtId),
		reportId: firstNonEmpty(body.reportId),
		caseId: firstNonEmpty(body.caseId, body.materialScopeId),
		materialScopeId: firstNonEmpty(body.materialScopeId, body.caseId),
		clientReportId: firstNonEmpty(body.clientReportId, body.sourceReportId),
		sourceReportId: firstNonEmpty(body.sourceReportId, body.clientReportId),
		uploadUrl: firstNonEmpty(body.uploadUrl, body.url, body.fileUrl),
		fileName: firstNonEmpty(body.fileName, body.nameOnDisk, body.uploadName),
		updatedAt: nowIso()
	}
	if (!Array.isArray(contact.materials)) contact.materials = []
	if (!Array.isArray(contact.materialReviews)) contact.materialReviews = []
	const material = patchMaterialList(contact.materials, review, true)
	patchMaterialList(contact.materialReviews, material, true)
	contact.updateTime = nowIso()
	contact.updatedAt = contact.updateTime
	return material
}

function materialReferenceValues(item = {}, keys = []) {
	return keys
		.map((key) => cleanId(item[key]))
		.filter(Boolean)
		.map((value) => value.toLowerCase())
}

function materialReferencesMatch(left = {}, right = {}) {
	const groups = [
		['id', 'materialId', 'key', 'code'],
		['type', 'materialType'],
		['name', 'materialName', 'title', 'label']
	]
	return groups.some((keys) => {
		const a = materialReferenceValues(left, keys)
		const b = materialReferenceValues(right, keys)
		return a.length > 0 && b.length > 0 && a.some((value) => b.includes(value))
	})
}

function mergeMaterialReview(existing = {}, review = {}) {
	const merged = { ...existing }
	Object.entries(review).forEach(([key, value]) => {
		if (value === undefined || value === null || value === '') return
		merged[key] = value
	})
	return merged
}

function patchMaterialList(list, review, addIfMissing = false) {
	if (!Array.isArray(list)) return review
	const index = list.findIndex((item) => materialReferencesMatch(item, review))
	if (index >= 0) {
		list[index] = mergeMaterialReview(list[index], review)
		return list[index]
	}
	if (addIfMissing) {
		list.unshift(review)
		return review
	}
	return null
}

function normalizeMessageReceipt(body = {}, uid) {
	const id = cleanId(firstNonEmpty(body.id, body.messageId, makeId('msg_receipt')))
	const stage = firstNonEmpty(body.stage, 'opened')
	return {
		...stripServerOwnedFields(body),
		id,
		messageId: id,
		userId: uid,
		stage,
		openedAt: firstNonEmpty(body.openedAt, stage === 'opened' ? nowIso() : ''),
		landedAt: firstNonEmpty(body.landedAt, stage === 'landed' ? nowIso() : ''),
		handledAt: firstNonEmpty(body.handledAt, stage === 'handled' ? nowIso() : ''),
		updatedAt: firstNonEmpty(body.updatedAt, nowIso()),
		source: firstNonEmpty(body.source, 'user-message-center')
	}
}

function attachReceiptToContacts(uid, receipt) {
	const contacts = ensureArray('advisorContacts').filter((item) => item.userId === uid)
	const related = contacts.filter((item) => {
		const cid = contactIdOf(item)
		return (receipt.statusId && cleanId(receipt.statusId) === cid) ||
			(receipt.contactId && cleanId(receipt.contactId) === cid) ||
			(receipt.reportId && item.reportId && String(receipt.reportId) === String(item.reportId))
	})
	const targets = related.length ? related : contacts.slice(0, 1)
	targets.forEach((contact) => {
		if (!Array.isArray(contact.messageActionReceipts)) contact.messageActionReceipts = []
		upsertByKey(contact.messageActionReceipts, receipt, (row) => `${row.id || row.messageId || ''}|${row.stage || ''}`)
		contact.updateTime = nowIso()
	})
}

function normalizeDebtExecutionRecord(body = {}, uid, reportScope = debtReportScopeFor(uid, body)) {
	const id = cleanId(firstNonEmpty(body.id, body.executionRecordId, makeId('debt_exec')))
	const existing = ensureArray('debtExecutionRecords').find((record) => (
		record.userId === uid &&
		String(record.id || record.executionRecordId || '') === String(id) &&
		debtReportScopesOverlap(reportScope, debtReportScopeFor(uid, record))
	)) || null
	const incomingHasFile = !!firstNonEmpty(body.uploadUrl, body.url, body.fileUrl, body.fileName)
	const type = firstNonEmpty(existing && existing.type, incomingHasFile ? 'proof' : '', body.type, 'handled')
	const existingTerminalProof = type === 'proof' && existing && (
		[
			'confirmed', 'approved', 'verified', 'completed', 'done',
			'unneeded', 'optional', 'not_required', 'waived', 'skipped',
			'rejected', 'invalid', 'reupload'
		].includes(String(existing.status || '').toLowerCase()) ||
		/已确认|已完成|无需|需重传|已驳回|未通过/.test(String(existing.statusText || ''))
	)
	const safeBody = existingTerminalProof ? { ...existing } : stripServerOwnedFields(body)
	;[
		'status',
		'statusText',
		'reviewedAt',
		'reviewTime',
		'reviewNote',
		'rejectReason',
		'reason',
		'reviewRemark',
		'reviewedBy',
		'reviewerId',
		'reviewAckStage',
		'ackStage',
		'userReviewAckStage',
		'reviewAcknowledgedAt',
		'reviewAckAt',
		'acknowledgedAt',
		'userAcknowledgedAt',
		'reviewAcknowledgedNote',
		'reviewAckNote',
		'ackNote',
		'userReviewNote',
		'reviewReceipt'
	].forEach((key) => { delete safeBody[key] })
	const ackPatch = existingTerminalProof ? {
		reviewAckStage: firstNonEmpty(body.reviewAckStage, body.ackStage, body.userReviewAckStage, existing.reviewAckStage),
		reviewAcknowledgedAt: firstNonEmpty(
			body.reviewAcknowledgedAt,
			body.reviewAckAt,
			body.acknowledgedAt,
			body.userAcknowledgedAt,
			existing.reviewAcknowledgedAt
		),
		reviewAcknowledgedNote: firstNonEmpty(
			body.reviewAcknowledgedNote,
			body.reviewAckNote,
			body.ackNote,
			body.userReviewNote,
			existing.reviewAcknowledgedNote
		),
		reviewReceipt: body.reviewReceipt && typeof body.reviewReceipt === 'object'
			? stripServerOwnedFields(body.reviewReceipt)
			: existing.reviewReceipt
	} : {}
	return {
		...safeBody,
		id,
		executionRecordId: id,
		userId: uid,
		debtId: existingTerminalProof
			? existing.debtId
			: firstNonEmpty(body.debtId, body.accountId, body.itemId, existing && existing.debtId),
		caseId: existingTerminalProof ? existing.caseId : firstNonEmpty(reportScope.caseId, body.caseId),
		reportId: existingTerminalProof ? existing.reportId : firstNonEmpty(reportScope.reportId, body.reportId),
		clientReportId: existingTerminalProof
			? existing.clientReportId
			: firstNonEmpty(reportScope.clientReportId, body.clientReportId, body.sourceReportId),
		sourceReportId: existingTerminalProof
			? existing.sourceReportId
			: firstNonEmpty(reportScope.clientReportId, body.sourceReportId, body.clientReportId),
		type,
		status: existingTerminalProof ? existing.status : (type === 'proof' ? 'reviewing' : 'handled'),
		statusText: existingTerminalProof ? existing.statusText : (type === 'proof' ? '待复核' : '已记录'),
		...(existingTerminalProof ? {
			reviewNote: firstNonEmpty(existing.reviewNote),
			reviewedAt: firstNonEmpty(existing.reviewedAt),
			reviewedBy: firstNonEmpty(existing.reviewedBy),
			reviewerId: firstNonEmpty(existing.reviewerId)
		} : {
			reviewNote: '',
			reviewedAt: '',
			reviewedBy: '',
			reviewerId: ''
		}),
		...ackPatch,
		uploadUrl: existingTerminalProof
			? existing.uploadUrl
			: firstNonEmpty(body.uploadUrl, body.url, body.fileUrl, existing && existing.uploadUrl, existing && existing.url),
		url: existingTerminalProof
			? existing.url
			: firstNonEmpty(body.url, body.uploadUrl, body.fileUrl, existing && existing.url, existing && existing.uploadUrl),
		fileName: existingTerminalProof ? existing.fileName : firstNonEmpty(body.fileName, existing && existing.fileName),
		fileSize: existingTerminalProof ? existing.fileSize : firstNonEmpty(body.fileSize, existing && existing.fileSize),
		createdAt: existingTerminalProof ? existing.createdAt : firstNonEmpty(existing && existing.createdAt, body.createdAt, nowIso()),
		updatedAt: nowIso(),
		source: existingTerminalProof ? existing.source : firstNonEmpty(body.source, 'user-debt-execution')
	}
}

function attachmentHasFile(item = {}) {
	return !!(item && firstRemoteFileReference(item.fileUrl, item.uploadUrl, item.url))
}

function normalizeRemoteFileReference(value = '') {
	const text = String(value || '').trim()
	if (!text || /\s/.test(text)) return ''
	if (/^https?:\/\/[^/]/i.test(text)) return text
	if (/^\/\/[^/]/.test(text)) return text
	if (/^\/(?!\/)/.test(text)) return text
	return ''
}

function firstRemoteFileReference(...values) {
	for (const value of values) {
		const normalized = normalizeRemoteFileReference(value)
		if (normalized) return normalized
	}
	return ''
}

function normalizeSupplementAttachment(raw = {}, fallbackTime = nowIso(), index = 0) {
	const uploadUrl = firstRemoteFileReference(raw.uploadUrl, raw.fileUrl, raw.url)
	const fileUrl = firstRemoteFileReference(raw.fileUrl, raw.uploadUrl, raw.url)
	const fileName = firstNonEmpty(raw.fileName, raw.nameOnDisk, raw.uploadName, raw.name)
	const uploadedAt = firstNonEmpty(raw.uploadedAt, raw.updatedAt, raw.createdAt, fallbackTime)
	const id = cleanId(firstNonEmpty(raw.id, raw.attachmentId, fileUrl, uploadUrl, fileName ? `${fileName}_${raw.fileSize || index}` : `${uploadedAt}_${index}`)) || makeId('sup_att')
	return {
		id,
		attachmentId: id,
		uploadUrl,
		fileUrl,
		fileName,
		fileSize: raw.fileSize === undefined ? '' : raw.fileSize,
		fileType: firstNonEmpty(raw.fileType, raw.typeOfFile),
		mimeType: firstNonEmpty(raw.mimeType, raw.contentType),
		uploadError: firstNonEmpty(raw.uploadError, raw.errMsg),
		ocrText: firstNonEmpty(raw.ocrText),
		ocrConfidence: firstNonEmpty(raw.ocrConfidence),
		detectedSummary: firstNonEmpty(raw.detectedSummary),
		ocrError: firstNonEmpty(raw.ocrError),
		uploadedAt,
		createdAt: firstNonEmpty(raw.createdAt, uploadedAt),
		updatedAt: firstNonEmpty(raw.updatedAt, uploadedAt)
	}
}

function normalizeSupplementAttachments(body = {}, uploadedAt = nowIso()) {
	const rawList = Array.isArray(body.attachments) ? body.attachments : []
	const legacy = attachmentHasFile(body) ? [body] : []
	const seen = new Set()
	const out = []
	;[...rawList, ...legacy].forEach((raw, index) => {
		const item = normalizeSupplementAttachment(raw, uploadedAt, index)
		if (!attachmentHasFile(item)) return
		const key = firstNonEmpty(item.fileUrl, item.uploadUrl, item.id, `${item.fileName || ''}:${item.fileSize || ''}`)
		if (seen.has(key)) return
		seen.add(key)
		out.push(item)
	})
	return out
}

const LEGACY_MATERIAL_CASE_ID = 'legacy'

function normalizedScopeId(value = '') {
	return String(value || '').trim().slice(0, 180)
}

function scopeIdsEqual(left, right) {
	const a = normalizedScopeId(left)
	const b = normalizedScopeId(right)
	if (!a || !b) return false
	return a === b
}

function reportFormalIds(report = {}) {
	return [
		report.id,
		report._id,
		report.reportId,
		report.caseId
	].map(normalizedScopeId).filter(Boolean)
}

function reportClientAliases(report = {}) {
	return [
		report.clientReportId,
		report.sourceReportId
	].map(normalizedScopeId).filter(Boolean)
}

function reportsForUser(uid) {
	return ensureArray('reports').filter((item) => String(item.userId || '') === String(uid || ''))
}

function findReportByFormalId(reports, value) {
	const id = normalizedScopeId(value)
	if (!id) return null
	return reports.find((report) => reportFormalIds(report).some((candidate) => candidate === id)) || null
}

function findReportsByClientAlias(reports, value) {
	const alias = normalizedScopeId(value)
	if (!alias) return []
	return reports.filter((report) => reportClientAliases(report).some((candidate) => candidate === alias))
}

function canonicalCaseFor(uid, input = {}) {
	const requestedReportId = normalizedScopeId(firstNonEmpty(input.serverReportId, input.reportId))
	const requestedClientReportId = normalizedScopeId(firstNonEmpty(input.clientReportId, input.sourceReportId))
	const requestedCaseId = normalizedScopeId(firstNonEmpty(input.caseId, input.materialScopeId, input.customerCaseId))
	const reports = reportsForUser(uid)
	// 正式 reportId/caseId 必须精确优先。即使历史脏数据里另一个报告把相同字符串
	// 保存成 clientReportId，也不能让别名夺走正式 ID 的归属。
	let report = findReportByFormalId(reports, requestedReportId) ||
		findReportByFormalId(reports, requestedCaseId)
	// 兼容旧客户端把本地 ID 放在 reportId/caseId：仅在没有命中任何正式 ID 后，
	// 才按 clientReportId 别名精确回退。若请求中的多个别名分别指向不同报告，
	// 必须拒绝而不能按字段顺序任选其一，否则材料可能被写入另一个 case。
	if (!report) {
		const aliasReports = []
		for (const value of [requestedClientReportId, requestedReportId, requestedCaseId].filter(Boolean)) {
			const formalConflict = value === requestedClientReportId
				? findReportByFormalId(reports, value)
				: null
			const matches = findReportsByClientAlias(reports, value)
			if (formalConflict || matches.length > 1) {
				return {
					caseId: '',
					reportId: '',
					clientReportId: value,
					report: null,
					conflict: true,
					conflictMessage: formalConflict
						? 'clientReportId 与已有正式报告 ID 或别名冲突'
						: '报告别名存在重复，无法确定唯一 case'
				}
			}
			if (matches.length === 1 && !aliasReports.includes(matches[0])) aliasReports.push(matches[0])
		}
		if (aliasReports.length > 1) {
			return {
				caseId: '',
				reportId: '',
				clientReportId: requestedClientReportId,
				report: null,
				conflict: true,
				conflictMessage: '请求中的报告别名指向不同 case'
			}
		}
		report = aliasReports[0] || null
	}
	if (report) {
		const reportId = normalizedScopeId(firstNonEmpty(report.id, report._id, report.reportId))
		return {
			caseId: normalizedScopeId(firstNonEmpty(report.caseId, reportId)),
			reportId,
			clientReportId: normalizedScopeId(firstNonEmpty(report.clientReportId, report.sourceReportId)),
			report
		}
	}
	return {
		caseId: requestedCaseId || requestedReportId || requestedClientReportId || LEGACY_MATERIAL_CASE_ID,
		reportId: requestedReportId,
		clientReportId: requestedClientReportId,
		report: null
	}
}

function debtReportScopeFor(uid, input = {}) {
	const requestedIds = [
		input.serverReportId,
		input.reportId,
		input.clientReportId,
		input.sourceReportId,
		input.caseId,
		input.materialScopeId
	].map(normalizedScopeId).filter(Boolean)
	const scope = canonicalCaseFor(uid, input)
	// 一旦解析到正式报告，只信任该报告自身的正式号和旧版别名。
	// 请求里被“正式 ID 优先”忽略的陈旧别名不能参与后续 overlap 判断。
	const acceptedIds = new Set(scope.report ? [] : requestedIds)
	if (scope.report) {
		reportFormalIds(scope.report).forEach((value) => acceptedIds.add(value))
		reportClientAliases(scope.report).forEach((value) => acceptedIds.add(value))
	}
	return {
		...scope,
		explicit: requestedIds.length > 0,
		notFound: requestedIds.length > 0 && !scope.report && !scope.conflict,
		acceptedIds: Array.from(acceptedIds)
	}
}

function debtReportScopesOverlap(left = {}, right = {}) {
	if (!left.reportId && !right.reportId) {
		return normalizedScopeId(firstNonEmpty(left.caseId, LEGACY_MATERIAL_CASE_ID)) ===
			normalizedScopeId(firstNonEmpty(right.caseId, LEGACY_MATERIAL_CASE_ID))
	}
	const leftIds = Array.isArray(left.acceptedIds) ? left.acceptedIds : []
	const rightIds = Array.isArray(right.acceptedIds) ? right.acceptedIds : []
	if (!leftIds.length || !rightIds.length) return !leftIds.length && !rightIds.length
	return leftIds.some((value) => rightIds.includes(value))
}

function debtReportScopeUnavailableToOwner(scope = {}) {
	return !!scope.notFound || (!!scope.report && !reportVisibleToOwner(scope.report))
}

function debtExecutionScopeKey(record = {}) {
	const scope = debtReportScopeFor(record.userId, record)
	return normalizedScopeId(firstNonEmpty(scope.reportId, record.reportId, LEGACY_MATERIAL_CASE_ID))
}

function projectDebtExecutionRecordForRead(record = {}, uid) {
	const scope = debtReportScopeFor(uid, record)
	if (!scope.report || !scope.reportId) return record
	return {
		...record,
		caseId: firstNonEmpty(scope.caseId, record.caseId),
		reportId: scope.reportId,
		clientReportId: firstNonEmpty(scope.clientReportId, record.clientReportId, record.sourceReportId),
		sourceReportId: firstNonEmpty(scope.clientReportId, record.sourceReportId, record.clientReportId)
	}
}

function mergeDebtExecutionRecordsForContact(contact = {}, uid, contactScope = debtReportScopeFor(uid, contact)) {
	const nested = Array.isArray(contact.debtExecutionRecords) ? contact.debtExecutionRecords : []
	const globalRecords = ensureArray('debtExecutionRecords').filter((item) => item.userId === uid)
	const merged = []
	;[...nested, ...globalRecords].forEach((raw) => {
		const item = projectDebtExecutionRecordForRead(raw, uid)
		const itemScope = debtReportScopeFor(uid, item)
		if (!debtReportScopesOverlap(contactScope, itemScope)) return
		const key = `${debtExecutionScopeKey({ ...item, userId: uid })}|${item.id || item.executionRecordId || ''}`
		const existingIndex = merged.findIndex((entry) => entry.key === key)
		if (existingIndex < 0) {
			merged.push({ key, item })
			return
		}
		const existing = merged[existingIndex].item
		const existingAt = String(firstNonEmpty(existing.updatedAt, existing.reviewedAt, existing.uploadedAt, existing.createdAt))
		const nextAt = String(firstNonEmpty(item.updatedAt, item.reviewedAt, item.uploadedAt, item.createdAt))
		if (nextAt >= existingAt) merged[existingIndex] = { key, item: { ...existing, ...item } }
	})
	return merged.map((entry) => entry.item)
}

function contactCaseMatches(contact = {}, scope = {}) {
	const formalCandidates = [
		contact.caseId,
		contact.reportId,
		contact.context && contact.context.caseId,
		contact.context && contact.context.reportId
	].map(normalizedScopeId).filter(Boolean)
	const aliasCandidates = [
		contact.clientReportId,
		contact.sourceReportId,
		contact.context && contact.context.clientReportId,
		contact.context && contact.context.sourceReportId
	].map(normalizedScopeId).filter(Boolean)
	if (!formalCandidates.length && !aliasCandidates.length) {
		return scopeIdsEqual(scope.caseId, LEGACY_MATERIAL_CASE_ID)
	}
	if (formalCandidates.some((value) => value === scope.caseId || value === scope.reportId)) return true
	return !!scope.clientReportId && aliasCandidates.some((value) => value === scope.clientReportId)
}

function normalizeSupplementMaterialPayload(body = {}, uid, scope = canonicalCaseFor(uid, body)) {
	const materialType = firstNonEmpty(body.materialType, body.type, body.key, 'other')
	const uploadedAt = firstNonEmpty(body.uploadedAt, body.updatedAt, nowIso())
	const id = cleanId(firstNonEmpty(body.id, body.materialId, materialType)) || makeId('sup_mat')
	const unavailable = body.unavailable === true || body.hasMaterial === false || body.noMaterial === true || body.status === 'unavailable'
	const attachments = unavailable ? [] : normalizeSupplementAttachments(body, uploadedAt)
	const primary = attachments[0] || {}
	const uploadUrl = firstRemoteFileReference(primary.uploadUrl, body.uploadUrl, body.fileUrl, body.url)
	const fileUrl = firstRemoteFileReference(primary.fileUrl, body.fileUrl, body.uploadUrl, body.url)
	const hasUpload = attachments.length > 0 || !!uploadUrl || !!fileUrl
	const requestedStatus = String(firstNonEmpty(body.status, '')).trim().toLowerCase()
	const localOnlyUpload = !hasUpload && ['uploaded', 'reviewing', 'submitted'].includes(requestedStatus)
	const storedStatus = unavailable ? 'unavailable' : (hasUpload ? 'uploaded' : localOnlyUpload ? 'queued' : 'draft')
	const storedStatusText = unavailable ? '暂无' : (hasUpload ? '待确认' : localOnlyUpload ? '本机已保存' : '待上传')
	const safeBody = stripServerOwnedFields(body)
	;[
		'status',
		'statusText',
		'reviewedAt',
		'reviewTime',
		'reviewNote',
		'rejectReason',
		'reason',
		'reviewRemark',
		'reviewedBy',
		'reviewerId'
	].forEach((key) => { delete safeBody[key] })
	return {
		...safeBody,
		id,
		materialId: id,
		userId: uid,
		caseId: scope.caseId,
		materialScopeId: scope.caseId,
		reportId: scope.reportId,
		clientReportId: scope.clientReportId,
		sourceReportId: scope.clientReportId,
		type: materialType,
		materialType,
		name: firstNonEmpty(body.name, body.materialName, '补充材料'),
		materialName: firstNonEmpty(body.materialName, body.name, '补充材料'),
		group: firstNonEmpty(body.group, '补充材料'),
		unavailable,
		status: storedStatus,
		statusText: storedStatusText,
		reviewNote: '',
		rejectReason: '',
		reason: '',
		reviewRemark: '',
		reviewedAt: '',
		reviewTime: '',
		reviewedBy: '',
		reviewerId: '',
		months: Number(body.months || 0) || 0,
		sameEmployerMonths: Number(body.sameEmployerMonths || 0) || 0,
		employerCount: Number(body.employerCount || 0) || 0,
		monthlyIncome: Number(body.monthlyIncome || 0) || 0,
		annualTaxableIncome: Number(body.annualTaxableIncome || body.taxAnnualIncome || 0) || 0,
		declaredValue: Number(body.declaredValue || body.assetValue || 0) || 0,
		companyName: firstNonEmpty(body.companyName, body.employerName, body.unitName),
		educationLevel: firstNonEmpty(body.educationLevel, body.education),
		note: firstNonEmpty(body.note, body.remark),
		uploadUrl,
		fileUrl,
		url: firstRemoteFileReference(body.url, fileUrl, uploadUrl),
		fileName: firstNonEmpty(primary.fileName, body.fileName, body.nameOnDisk, body.uploadName),
		fileSize: firstNonEmpty(primary.fileSize, body.fileSize === undefined ? '' : body.fileSize),
		fileType: firstNonEmpty(primary.fileType, body.fileType, body.typeOfFile),
		mimeType: firstNonEmpty(primary.mimeType, body.mimeType, body.contentType),
		uploadError: firstNonEmpty(body.uploadError, body.errMsg),
		attachments,
		attachmentCount: attachments.length,
		uploadedAt,
		createdAt: firstNonEmpty(body.createdAt, uploadedAt),
		updatedAt: firstNonEmpty(body.updatedAt, uploadedAt),
		source: firstNonEmpty(body.source, 'supplement-material')
	}
}

function supplementMaterialKey(item = {}) {
	return `${item.userId || ''}|${item.caseId || item.materialScopeId || LEGACY_MATERIAL_CASE_ID}|${item.materialType || item.type || ''}|${item.id || item.materialId || ''}`
}

function supplementMaterialsForCase(uid, caseId) {
	return ensureArray('supplementMaterials')
		.filter((item) => String(item.userId || '') === String(uid || ''))
		.filter((item) => scopeIdsEqual(firstNonEmpty(item.caseId, item.materialScopeId, LEGACY_MATERIAL_CASE_ID), caseId))
		.map((item) => stripLocalPathFields(item))
}

function mergeSupplementMaterialsForCase(contact, uid, caseId) {
	if (!Array.isArray(contact.supplementMaterials)) contact.supplementMaterials = []
	supplementMaterialsForCase(uid, caseId).forEach((item) => {
		upsertByKey(contact.supplementMaterials, { ...item }, supplementMaterialKey)
	})
	return contact.supplementMaterials
}

function materialHasExplicitScope(item = {}) {
	return !!firstNonEmpty(
		item.caseId,
		item.materialScopeId,
		item.reportId,
		item.clientReportId,
		item.sourceReportId
	)
}

function materialScopeMatches(item = {}, value = '') {
	const target = normalizedScopeId(value)
	if (!target) return false
	return [
		item.caseId,
		item.materialScopeId,
		item.reportId,
		item.clientReportId,
		item.sourceReportId
	].map(normalizedScopeId).filter(Boolean).some((candidate) => candidate === target)
}

function scopedMaterialIdentityKey(item = {}) {
	const caseId = firstNonEmpty(item.caseId, item.materialScopeId, LEGACY_MATERIAL_CASE_ID)
	const identity = firstNonEmpty(
		item.id,
		item.materialId,
		item.key,
		item.code,
		materialKey(item)
	)
	return `${caseId}|${item.materialType || item.type || ''}|${identity}`
}

function migrateNestedMaterialList(list, clientCaseId, caseId, reportId, uid, migrateUnscoped = false) {
	if (!Array.isArray(list)) return 0
	let migrated = 0
	const rebuilt = []
	list.forEach((item) => {
		const shouldMigrate = materialScopeMatches(item, clientCaseId) ||
			(migrateUnscoped && !materialHasExplicitScope(item))
		const next = shouldMigrate
			? {
				...item,
				userId: firstNonEmpty(item.userId, uid),
				caseId,
				materialScopeId: caseId,
				reportId,
				clientReportId: clientCaseId,
				sourceReportId: clientCaseId
			}
			: item
		if (shouldMigrate) migrated += 1
		const key = scopedMaterialIdentityKey(next)
		const duplicateIndex = key ? rebuilt.findIndex((existing) => scopedMaterialIdentityKey(existing) === key) : -1
		if (duplicateIndex < 0) {
			rebuilt.push(next)
			return
		}
		const existing = rebuilt[duplicateIndex]
		const existingTs = String(firstNonEmpty(existing.updatedAt, existing.uploadedAt, existing.createdAt))
		const nextTs = String(firstNonEmpty(next.updatedAt, next.uploadedAt, next.createdAt))
		rebuilt[duplicateIndex] = nextTs >= existingTs
			? { ...existing, ...next }
			: { ...next, ...existing }
	})
	list.splice(0, list.length, ...rebuilt)
	return migrated
}

function migrateClientCaseMaterials(uid, clientReportId, canonicalCaseId, reportId) {
	const clientCaseId = normalizedScopeId(clientReportId)
	const caseId = normalizedScopeId(canonicalCaseId)
	if (!clientCaseId || !caseId || scopeIdsEqual(clientCaseId, caseId)) return 0
	const list = ensureArray('supplementMaterials')
	let migrated = 0
	const rebuilt = []
	list.forEach((item) => {
		const belongsToUser = String(item.userId || '') === String(uid || '')
		const itemCaseId = firstNonEmpty(item.caseId, item.materialScopeId, LEGACY_MATERIAL_CASE_ID)
		const shouldMigrate = belongsToUser && scopeIdsEqual(itemCaseId, clientCaseId)
		const next = shouldMigrate
			? {
				...item,
				caseId,
				materialScopeId: caseId,
				reportId,
				clientReportId: clientCaseId,
				sourceReportId: clientCaseId,
				updatedAt: firstNonEmpty(item.updatedAt, item.uploadedAt, nowIso())
			}
			: item
		if (shouldMigrate) migrated += 1
		const key = supplementMaterialKey(next)
		const duplicateIndex = key ? rebuilt.findIndex((existing) => supplementMaterialKey(existing) === key) : -1
		if (duplicateIndex < 0) {
			rebuilt.push(next)
			return
		}
		const existing = rebuilt[duplicateIndex]
		const existingTs = String(firstNonEmpty(existing.updatedAt, existing.uploadedAt, existing.createdAt))
		const nextTs = String(firstNonEmpty(next.updatedAt, next.uploadedAt, next.createdAt))
		rebuilt[duplicateIndex] = nextTs >= existingTs
			? { ...existing, ...next }
			: { ...next, ...existing }
	})
	if (migrated) list.splice(0, list.length, ...rebuilt)

	const contactScopeFields = (contact) => [
		contact.caseId,
		contact.reportId,
		contact.clientReportId,
		contact.sourceReportId,
		contact.context && contact.context.caseId,
		contact.context && contact.context.reportId,
		contact.context && contact.context.clientReportId,
		contact.context && contact.context.sourceReportId
	].map(normalizedScopeId).filter(Boolean)
	ensureArray('advisorContacts')
		.filter((contact) => String(contact.userId || '') === String(uid || ''))
		.filter((contact) => contactScopeFields(contact).some((value) => value === clientCaseId))
		.forEach((contact) => {
			contact.caseId = caseId
			contact.reportId = reportId
			contact.clientReportId = clientCaseId
			contact.sourceReportId = clientCaseId
			contact.context = {
				...(contact.context && typeof contact.context === 'object' ? contact.context : {}),
				caseId,
				reportId,
				clientReportId: clientCaseId,
				sourceReportId: clientCaseId
			}
			;[
				'supplementMaterials',
				'materials',
				'materialSubmits',
				'materialReviews',
				'requiredMaterials',
				'pendingMaterials'
			].forEach((key) => {
				migrateNestedMaterialList(contact[key], clientCaseId, caseId, reportId, uid, true)
			})
			mergeSupplementMaterialsForCase(contact, uid, caseId)
			contact.updateTime = nowIso()
			contact.updatedAt = contact.updateTime
		})
	return migrated
}

function applyMaterialReviewAcrossCase(contact, body = {}) {
	const uid = contact.userId
	const scope = canonicalCaseFor(uid, contact)
	const reviewInput = {
		...body,
		caseId: scope.caseId,
		materialScopeId: scope.caseId,
		reportId: firstNonEmpty(scope.reportId, contact.reportId),
		clientReportId: firstNonEmpty(scope.clientReportId, contact.clientReportId),
		sourceReportId: firstNonEmpty(scope.clientReportId, contact.sourceReportId)
	}
	const scopedContacts = ensureArray('advisorContacts')
		.filter((item) => String(item.userId || '') === String(uid || ''))
		.filter((item) => contactCaseMatches(item, scope))
	if (!scopedContacts.some((item) => contactIdOf(item) === contactIdOf(contact))) scopedContacts.push(contact)

	let resolved = null
	const supplementMaterials = ensureArray('supplementMaterials')
	supplementMaterials.forEach((item, index) => {
		if (String(item.userId || '') !== String(uid || '')) return
		if (!scopeIdsEqual(firstNonEmpty(item.caseId, item.materialScopeId, LEGACY_MATERIAL_CASE_ID), scope.caseId)) return
		if (!materialReferencesMatch(item, reviewInput)) return
		supplementMaterials[index] = mergeMaterialReview(item, reviewInput)
		resolved = supplementMaterials[index]
	})

	const review = mergeMaterialReview(reviewInput, resolved || {})
	scopedContacts.forEach((item) => {
		if (!Array.isArray(item.supplementMaterials)) item.supplementMaterials = []
		const supplement = patchMaterialList(item.supplementMaterials, review, false)
		const material = patchReviewedMaterial(item, supplement || review)
		if (contactIdOf(item) === contactIdOf(contact)) resolved = supplement || material
	})
	return resolved || patchReviewedMaterial(contact, review)
}

function upsertDebtExecutionRecord(record, reportScope = debtReportScopeFor(record.userId, record)) {
	const list = ensureArray('debtExecutionRecords')
	upsertByKey(list, record, (row) => `${row.userId || ''}|${debtExecutionScopeKey(row)}|${row.id || row.executionRecordId || ''}`)
	const contacts = ensureArray('advisorContacts').filter((item) => item.userId === record.userId)
	const related = reportScope.reportId ? contacts.filter((item) => contactCaseMatches(item, reportScope)) : []
	const targets = reportScope.reportId
		? related
		: contacts.filter((item) => contactCaseMatches(item, { caseId: LEGACY_MATERIAL_CASE_ID })).slice(0, 1)
	targets.forEach((contact) => {
		if (!Array.isArray(contact.debtExecutionRecords)) contact.debtExecutionRecords = []
		upsertByKey(contact.debtExecutionRecords, record, (row) => row.id || row.executionRecordId || '')
		contact.updateTime = nowIso()
	})
	return record
}

function decorateContactForRead(contact, req = null) {
	const role = req ? actorRole(req) : ''
	if (req && role === 'advisor' && !advisorCanReadContact(req, contact)) return redactStaffLeadForList(contact)
	if (req && role === 'service' && !serviceCanReadContact(req, contact)) return redactStaffLeadForList(contact)
	const uid = contact.userId
	const bindings = ensureObject('pushBindings')
	const pushBinding = uid && bindings[uid] ? bindings[uid] : null
	const messageActionReceipts = ensureArray('messageActionReceipts').filter((item) => item.userId === uid)
	const contactDebtScope = debtReportScopeFor(uid, contact)
	const debtExecutionRecords = mergeDebtExecutionRecordsForContact(contact, uid, contactDebtScope)
	const allMessages = Array.isArray(contact.messages) ? contact.messages : []
	const visibleMessages = req ? visibleMessagesForActor(req, contact, allMessages) : allMessages
	const unreadCount = req ? unreadCountForActor(req, contact, visibleMessages) : 0
	const readState = req ? readStateForActor(req, contact) : null
	const reopenState = req ? reopenStateForActor(req, contact) : {
		reopenedByCustomer: false,
		reopenedAt: '',
		reopenedMessageId: '',
		clearSequence: 0
	}
	const advisorJoinRequired = !!(req && role === 'advisor' && isBankServiceGroup(contact) && advisorCanSeeContactLead(req, contact) && !advisorCanReadContact(req, contact))
	const materialDebtExecutionRecords = debtExecutionRecords.filter((item) => (
		String(item.type || '').toLowerCase() === 'proof' ||
		!!firstNonEmpty(item.uploadUrl, item.url, item.fileUrl, item.fileName)
	))
	const decorated = {
		...contact,
		institution: firstNonEmpty(contact.institution, contactInstitutionOf(contact)),
		groupMode: contact.groupMode || (isBankServiceGroup(contact) ? 'service-bank-customer' : ''),
		serviceRequired: contact.serviceRequired === true || isBankServiceGroup(contact),
		materialAccess: req ? hasMaterialAccess(req, contact) : true,
		materialProgressSummary: materialProgressSummaryForContact({ ...contact, debtExecutionRecords: materialDebtExecutionRecords }),
		advisorJoinRequired,
		chatAccess: !advisorJoinRequired,
		advisorAccessText: advisorJoinRequired ? '待客服确认邀请后可进入群聊' : firstNonEmpty(contact.advisorAccessText, ''),
		messages: req ? decorateMessagesForActor(req, contact, visibleMessages) : visibleMessages,
		totalMessageCount: allMessages.length,
		visibleMessageCount: visibleMessages.length,
		unreadCount,
		hasUnread: unreadCount > 0,
		...reopenState,
		...(readState ? { chatReadState: readState } : {}),
		...(pushBinding ? { pushBinding, pushBindings: [pushBinding], systemPushBinding: pushBinding } : {}),
		messageActionReceipts: Array.isArray(contact.messageActionReceipts) ? contact.messageActionReceipts : messageActionReceipts,
		debtExecutionRecords,
		feedbackCount: Array.isArray(contact.serviceFeedbacks) ? contact.serviceFeedbacks.length : Number(contact.feedbackCount || 0) || 0,
		completionCount: Array.isArray(contact.completionRecords) ? contact.completionRecords.length : Number(contact.completionCount || 0) || 0
	}
	const safeDecorated = stripLocalPathFields(decorated)
	const materialSafe = req && !hasMaterialAccess(req, contact) ? redactMaterialFields(safeDecorated) : safeDecorated
	if (req && ['advisor', 'service', 'admin'].includes(role)) {
		const phone = firstNonEmpty(contact.phone, contact.mobile)
		const staffPushBindingSource = (
			pushBinding || contact.pushBinding || contact.systemPushBinding ||
			(Array.isArray(contact.pushBindings) ? contact.pushBindings[0] : null)
		)
		return publicStaffContact(materialSafe, { phone, pushBinding: staffPushBindingSource })
	}
	return materialSafe
}

// ─── 热点内容发布 ──────────────────────────────────────────

router.get('/api/content/articles', (req, res) => {
	try {
		const limit = Math.min(50, Math.max(1, Math.floor(Number((req.query && req.query.limit) || (req.body && req.body.limit) || 20)) || 20))
		const audience = String((req.query && req.query.audience) || (req.body && req.body.audience) || '').trim().toLowerCase()
		const list = sortedArticles(ensureArray('contentArticles'))
			.filter((article) => article.status === 'published')
			.filter((article) => {
				if (!audience) return true
				const audiences = Array.isArray(article.audience) ? article.audience : []
				return audiences.length === 0 || audiences.includes(audience)
			})
			.slice(0, limit)
			.map(publicArticle)
		return ok(res, { list, total: list.length, source: 'content-articles' })
	} catch (e) {
		logger.error({ err: e }, 'business/content/articles failed')
		return fail(res, 5000, '获取热点内容失败')
	}
})

router.get('/api/content/article/:id', (req, res) => {
	try {
		const id = cleanId(req.params.id)
		const article = ensureArray('contentArticles').find((item) => cleanId(item.id) === id)
		if (!article || article.status !== 'published') return fail(res, 2001, 'article not found')
		return ok(res, publicArticle(article))
	} catch (e) {
		logger.error({ err: e }, 'business/content/article failed')
		return fail(res, 5000, '获取文章详情失败')
	}
})

router.get('/api/content/manage', authRequired, (req, res) => {
	try {
		if (!isPublisherActor(req)) return fail(res, 3003, '仅内容运营可访问发布端', null, 403)
		const list = sortedArticles(ensureArray('contentArticles')).map(publicArticle)
		return ok(res, { list, total: list.length, source: 'content-manage' })
	} catch (e) {
		logger.error({ err: e }, 'business/content/manage failed')
		return fail(res, 5000, '获取发布列表失败')
	}
})

router.post('/api/content/article', authRequired, (req, res) => {
	const body = req.body || {}
	try {
		if (!isPublisherActor(req)) return fail(res, 3003, '仅内容运营可发布文章', null, 403)
		const title = cleanText(body.title, 60)
		const content = String(body.content || '').trim()
		if (!title) return fail(res, 1001, '标题不能为空')
		if (title.length < 2) return fail(res, 1001, '标题至少 2 个字符')
		if (!content || content.length < 10) return fail(res, 1001, '正文至少 10 个字符')
		const list = ensureArray('contentArticles')
		const articleId = cleanId(firstNonEmpty(body.id, body.articleId))
		const existing = articleId ? list.find((item) => cleanId(item.id) === articleId) : null
		const article = normalizeContentArticlePayload(body, req, existing || {})
		if (existing) {
			Object.assign(existing, article)
		} else {
			list.unshift(article)
		}
		store.persistSync()
		return ok(res, { ok: true, article: publicArticle(article) })
	} catch (e) {
		logger.error({ err: e }, 'business/content/article publish failed')
		return fail(res, 5000, '发布文章失败')
	}
})

router.post('/api/content/article/status', authRequired, (req, res) => {
	const body = req.body || {}
	const id = cleanId(firstNonEmpty(body.id, body.articleId))
	const status = String(body.status || '').trim()
	if (!id) return fail(res, 1001, 'articleId is required')
	if (!['draft', 'published', 'hidden'].includes(status)) return fail(res, 1001, 'status 仅支持 draft/published/hidden')
	try {
		if (!isPublisherActor(req)) return fail(res, 3003, '仅内容运营可更新文章状态', null, 403)
		const article = ensureArray('contentArticles').find((item) => cleanId(item.id) === id)
		if (!article) return fail(res, 2001, 'article not found')
		article.status = status
		article.updatedAt = nowIso()
		if (status === 'published' && !article.publishedAt) article.publishedAt = article.updatedAt
		store.persistSync()
		return ok(res, { ok: true, article: publicArticle(article) })
	} catch (e) {
		logger.error({ err: e }, 'business/content/article status failed')
		return fail(res, 5000, '更新文章状态失败')
	}
})

// ─── 报告 CRUD ──────────────────────────────────────────────

function clientReportIdFromPayload(payload = {}) {
	return normalizedScopeId(firstNonEmpty(payload.clientReportId, payload.sourceReportId))
}

function stableJsonValue(value) {
	if (Array.isArray(value)) return value.map(stableJsonValue)
	if (!value || typeof value !== 'object') return value
	return Object.keys(value).sort().reduce((out, key) => {
		out[key] = stableJsonValue(value[key])
		return out
	}, {})
}

function legacyReportUploadFingerprint(payload = {}) {
	const strongHash = [
		payload.fileSha256,
		payload.sha256,
		payload.contentHash,
		payload.pdfHash,
		payload.documentHash
	].map((value) => String(value || '').trim().toLowerCase())
		.find((value) => /^[a-f0-9]{32,128}$/.test(value)) || ''
	const analysisResult = payload.analysisResult || payload.analysisData || null
	const reportDraft = {
		...payload,
		analysisData: analysisResult,
		analysisResult
	}
	const identity = reportIdentityInfo(reportDraft)
	const basis = {
		version: 1,
		reportType: String(payload.reportType || '').trim().toLowerCase(),
		fileName: String(payload.fileName || '').replace(/\s+/g, ' ').trim().toLowerCase(),
		fileSize: Number(payload.fileSize || 0) || 0,
		reportMonth: reportMonthOf(reportDraft),
		reportIdentityFingerprint: identity.fingerprint || '',
		reportIdentityLast4: identity.last4 || '',
		strongHash,
		// 没有客户端文件哈希时，使用完整分析结果的稳定 JSON。这样仅复用完全相同的
		// 重试请求，不会把同名、同月份但内容已变化的真实报告误合并。
		analysisResult: strongHash ? null : stableJsonValue(analysisResult)
	}
	return crypto.createHash('sha256').update(JSON.stringify(basis)).digest('hex')
}

function ensureStoredReportUploadFingerprint(report = {}) {
	if (report.uploadFingerprint) return String(report.uploadFingerprint)
	const analysisResult = firstNonEmpty(report.analysisResult, report.analysisData, report.rawAnalysis, report.data, null)
	if (!analysisResult) return ''
	const fingerprint = legacyReportUploadFingerprint({
		reportType: report.reportType,
		fileName: report.fileName,
		fileSize: report.fileSize,
		fileSha256: report.fileSha256,
		sha256: report.sha256,
		contentHash: report.contentHash,
		pdfHash: report.pdfHash,
		documentHash: report.documentHash,
		reportMonth: report.reportMonth,
		reportPeriod: report.reportPeriod,
		reportDate: report.reportDate,
		reportIdentityLast4: report.reportIdentityLast4,
		analysisResult
	})
	report.uploadFingerprint = fingerprint
	return fingerprint
}

function clientReportAliasResolution(uid, clientReportId) {
	const alias = normalizedScopeId(clientReportId)
	if (!alias) return { alias: '', report: null, conflict: false }
	const reports = reportsForUser(uid)
	const formalConflict = findReportByFormalId(reports, alias)
	const aliasMatches = findReportsByClientAlias(reports, alias)
	if (formalConflict || aliasMatches.length > 1) {
		return {
			alias,
			report: null,
			conflict: true,
			message: 'clientReportId 与已有正式报告 ID 或别名冲突'
		}
	}
	return { alias, report: aliasMatches[0] || null, conflict: false }
}

function ensureReportServiceContact(report = {}, req) {
	const userId = String(report.userId || (req.user && req.user.uid) || '')
	const reportId = normalizedScopeId(firstNonEmpty(report.id, report._id, report.reportId))
	const caseId = normalizedScopeId(firstNonEmpty(report.caseId, reportId))
	const clientReportId = normalizedScopeId(firstNonEmpty(report.clientReportId, report.sourceReportId))
	const contacts = ensureArray('advisorContacts')
	let contact = contacts.find((item) => {
		if (String(item.userId || '') !== userId) return false
		if (contactChannelOf(item) !== 'service' || String(item.contactType || '') !== 'customer-service') return false
		return contactCaseMatches(item, { caseId, reportId, clientReportId })
	})
	if (contact) {
		const previousClientReportId = normalizedScopeId(firstNonEmpty(
			contact.clientReportId,
			contact.sourceReportId,
			!scopeIdsEqual(contact.caseId, caseId) ? contact.caseId : ''
		))
		contact.caseId = caseId
		contact.reportId = reportId
		contact.clientReportId = clientReportId || previousClientReportId
		contact.sourceReportId = contact.clientReportId
		contact.context = {
			...(contact.context && typeof contact.context === 'object' ? contact.context : {}),
			caseId,
			reportId,
			clientReportId: contact.clientReportId,
			sourceReportId: contact.clientReportId
		}
		contact.reportServiceWorkItem = true
		contact.serviceRequired = true
		mergeSupplementMaterialsForCase(contact, userId, caseId)
		report.serviceContactId = contactIdOf(contact)
		return { contact, created: false }
	}

	const currentUser = currentAuthUser(req) || {}
	const createdAt = nowIso()
	const id = makeId('c')
	const customerName = firstNonEmpty(
		report.reportCustomerName,
		report.customerName,
		currentUser.nickname,
		currentUser.realName,
		currentUser.phone ? `用户${String(currentUser.phone).slice(-4)}` : '客户'
	)
	const scopedMaterials = supplementMaterialsForCase(userId, caseId)
	contact = {
		_id: id,
		id,
		contactId: id,
		userId,
		name: customerName,
		clientName: customerName,
		userName: customerName,
		customerName,
		reportCustomerName: firstNonEmpty(report.reportCustomerName, report.customerName),
		phone: firstNonEmpty(report.phone, currentUser.phone, currentUser.mobile),
		mobile: firstNonEmpty(report.phone, currentUser.phone, currentUser.mobile),
		reportId,
		caseId,
		clientReportId,
		sourceReportId: clientReportId,
		contactType: 'customer-service',
		contactIntent: 'report-review',
		channel: 'service',
		deskType: 'service',
		reportServiceWorkItem: true,
		serviceRequired: true,
		serviceStatus: 'open',
		orderStatus: 'open',
		orderCreatedAt: createdAt,
		status: 'pending',
		createTime: createdAt,
		createdAt,
		updateTime: createdAt,
		updatedAt: createdAt,
		context: {
			reportId,
			caseId,
			clientReportId,
			sourceReportId: clientReportId,
			contactIntent: 'report-review',
			reportType: report.reportType || '',
			fileName: report.fileName || ''
		},
		messages: [],
		supplementMaterials: scopedMaterials.map((item) => ({ ...item })),
		advisorInfo: advisorInfoFor('service')
	}
	appendSystemContactMessage(contact, '客户已提交信用报告，等待客服接单处理。', {
		eventType: 'report-uploaded',
		reportId,
		caseId
	})
	contacts.unshift(contact)
	report.serviceContactId = id
	return { contact, created: true }
}

router.post('/api/report/upload', authRequired, (req, res) => {
	const payload = req.body || {}
	const analysis = canonicalReportAnalysis(payload)
	if (!payload.reportType || !payload.fileName || !analysis) {
		return fail(res, 1001, 'invalid report payload')
	}
	try {
		const requestedAnalysisJobId = String(payload.analysisJobId || payload.analysis_job_id || '').trim()
		let trustedJobReference = null
		if (requestedAnalysisJobId) {
			trustedJobReference = analysisJobReferenceForUser(
				req.user.uid,
				requestedAnalysisJobId,
				analysis
			)
			if (!trustedJobReference.ok) {
				const notReady = trustedJobReference.reason === 'job-not-ready'
				const invalidId = trustedJobReference.reason === 'invalid-job-id'
				return fail(
					res,
					1001,
					notReady
						? '分析任务尚未完成，请稍后再保存'
						: (invalidId
							? 'analysisJobId 格式无效'
							: '分析任务结果已失效、非当前用户所有或与报告不一致，请重新分析'),
					{ reason: trustedJobReference.reason },
					invalidId ? 400 : (notReady ? 409 : 422)
				)
			}
		}
		const storedAnalysis = withoutPrivateEvidenceArtifacts(
			trustedJobReference
				? withoutReportResponseState(trustedJobReference.canonical)
				: analysis
		)
		const policyAnalysis = trustedJobReference ? trustedJobReference.canonical : storedAnalysis
		const clientReportId = normalizedClientReportId(clientReportIdFromPayload(payload))
		if (clientReportId === null) return fail(res, 1001, 'clientReportId 格式无效')
		const canonicalUploadFingerprint = canonicalReportUploadFingerprint({
			reportType: payload.reportType,
			fileName: payload.fileName,
			analysisData: storedAnalysis,
			financialSupplement: payload.financialSupplement
		})
		const legacyUploadFingerprint = legacyReportUploadFingerprint(payload)
		const contentFingerprint = reportContentFingerprint({
			analysisData: storedAnalysis,
			financialSupplement: payload.financialSupplement
		})
		const aliasResolution = clientReportAliasResolution(req.user.uid, clientReportId)
		if (aliasResolution.conflict) {
			return fail(res, 1001, aliasResolution.message, {
				field: 'clientReportId',
				clientReportId
			}, 409)
		}
		const existing = aliasResolution.report || (!clientReportId
			? reportsForUser(req.user.uid).find((report) => {
				const legacyMatch = ensureStoredReportUploadFingerprint(report) === legacyUploadFingerprint
				const canonicalMatch = String(report.canonicalUploadFingerprint || '') === canonicalUploadFingerprint
				const contentMatch = String(report.reportType || '') === String(payload.reportType || '')
					&& String(report.fileName || '') === String(payload.fileName || '')
					&& currentStoredReportContentFingerprint(report) === contentFingerprint
				return legacyMatch || canonicalMatch || contentMatch
			})
			: null)
		if (existing) {
			const existingContentFingerprint = currentStoredReportContentFingerprint(existing)
			const existingLegacyFingerprint = ensureStoredReportUploadFingerprint(existing)
			const hiddenContentMismatch = clientReportId
				&& !reportVisibleToOwner(existing)
				&& existingLegacyFingerprint !== legacyUploadFingerprint
			if (clientReportId && (existingContentFingerprint !== contentFingerprint || hiddenContentMismatch)) {
				return fail(res, 1001, 'clientReportId 已绑定到不同报告内容，请使用新的本地报告 ID', {
					field: 'clientReportId',
					clientReportId,
					reason: 'idempotency-content-mismatch'
				}, 409)
			}
			const existingReportId = normalizedScopeId(firstNonEmpty(existing.id, existing._id, existing.reportId))
			const restored = !reportVisibleToOwner(existing)
			if (restored) {
				existing.hiddenFromOwner = false
				existing.userDeletedAt = ''
				existing.archivedAt = ''
				existing.archiveReason = ''
				existing.archivedByUserId = ''
				existing.updatedAt = nowIso()
			}
			existing.caseId = normalizedScopeId(firstNonEmpty(existing.caseId, existingReportId))
			existing.clientReportId = normalizedScopeId(firstNonEmpty(existing.clientReportId, existing.sourceReportId, clientReportId))
			existing.sourceReportId = existing.clientReportId
			existing.uploadFingerprint = existing.uploadFingerprint || legacyUploadFingerprint
			existing.canonicalUploadFingerprint = canonicalUploadFingerprint
			existing.contentFingerprintVersion = REPORT_CONTENT_FINGERPRINT_VERSION
			existing.contentFingerprint = existingContentFingerprint
			if (trustedJobReference) {
				existing.analysisJobId = trustedJobReference.jobId
				existing.analysisAuthority = {
					version: 'analysis-job-link-v1',
					analysisKey: trustedJobReference.identity.analysisKey,
					resultHash: trustedJobReference.identity.resultHash
				}
				// A linked row is a server-owned projection of the trusted job result.
				// Never retain the client's compact/mapped object as the canonical row.
				existing.analysisData = storedAnalysis
				delete existing.analysisResult
				delete existing.rawAnalysis
			}
			const migratedMaterials = migrateClientCaseMaterials(
				req.user.uid,
				existing.clientReportId,
				existing.caseId,
				existingReportId
			)
			const ensured = ensureReportServiceContact(existing, req)
			store.persistSync()
			return ok(res, {
				reportId: existingReportId,
				id: existingReportId,
				caseId: existing.caseId,
				clientReportId: existing.clientReportId,
				analysisJobId: existing.analysisJobId || '',
				decisionEvidenceLinked: Boolean(trustedJobReference),
				contactId: contactIdOf(ensured.contact),
				reused: true,
				restored,
				reuseReason: clientReportId ? 'client-report-id' : 'upload-fingerprint',
				workItemCreated: ensured.created,
				migratedMaterials
			})
		}
		const policy = reportUploadPolicyFor(req, { ...payload, analysisResult: policyAnalysis, analysisData: null })
		if (!policy.allowed) return fail(res, 3003, policy.message || '当前账号不能继续上传征信报告', null, 403)
		const id = `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
		const reportDraft = {
			reportType: payload.reportType,
			filePath: payload.filePath || '',
			fileName: payload.fileName,
			fileSize: Number(payload.fileSize || 0) || 0,
			fileSha256: payload.fileSha256 || payload.sha256 || '',
			analysisData: storedAnalysis,
			financialSupplement: payload.financialSupplement || null,
			clientReportId: clientReportId || '',
			analysisJobId: trustedJobReference ? trustedJobReference.jobId : '',
			analysisAuthority: trustedJobReference
				? {
					version: 'analysis-job-link-v1',
					analysisKey: trustedJobReference.identity.analysisKey,
					resultHash: trustedJobReference.identity.resultHash
				}
				: null
		}
		const trustedIdentityDraft = trustedJobReference
			? { ...reportDraft, analysisData: trustedJobReference.canonical }
			: reportDraft
		const customerName = reportCustomerName(trustedIdentityDraft)
		const reportMonth = reportMonthOf(trustedIdentityDraft)
		const reportIdentity = reportIdentityInfo(trustedIdentityDraft)
		// 只保存一个规范 analysisData；服务端归属字段在客户端字段之后写入，
		// 同时恢复 case/material/work-item 工作流并保留 v2 内容指纹。
		const report = {
			...reportDraft,
			customerName,
			reportCustomerName: customerName,
			reportMonth,
			reportPeriod: reportMonth,
			reportIdentityLast4: reportIdentity.last4 || policy.reportIdentityLast4 || '',
			reportIdentityFingerprint: reportIdentity.fingerprint || policy.reportIdentityFingerprint || '',
			phone: req.user.phone || (currentAuthUser(req) && currentAuthUser(req).phone) || '',
			uploadPolicy: policy.mode || 'personal',
			uploadFingerprint: legacyUploadFingerprint,
			canonicalUploadFingerprint,
			contentFingerprintVersion: REPORT_CONTENT_FINGERPRINT_VERSION,
			contentFingerprint,
			sourceReportId: clientReportId || '',
			caseId: id,
			id,
			_id: id,
			userId: req.user.uid,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString()
		}
		store.state().reports.unshift(report)
		const migratedMaterials = migrateClientCaseMaterials(req.user.uid, clientReportId, report.caseId, id)
		const ensured = ensureReportServiceContact(report, req)
		store.persistSync() // 报告分析结果是高价值写入，立即落盘
		return ok(res, {
			reportId: id,
			id,
			caseId: report.caseId,
			clientReportId,
			analysisJobId: report.analysisJobId || '',
			decisionEvidenceLinked: Boolean(trustedJobReference),
			contactId: contactIdOf(ensured.contact),
			reused: false,
			restored: false,
			workItemCreated: ensured.created,
			migratedMaterials
		})
	} catch (e) {
		logger.error({ err: e }, 'business/report/upload failed')
		return fail(res, 5000, '报告上传失败')
	}
})

router.post('/api/report/list', authRequired, (req, res) => {
	try {
		const page = Math.max(1, Math.floor(Number((req.body && req.body.page) || 1)) || 1)
		// 封顶 50：避免客户端传入超大 pageSize 一次性切出全部报告（响应放大 / 内存压力）
		const pageSize = Math.min(50, Math.max(1, Math.floor(Number((req.body && req.body.pageSize) || 20)) || 20))
		const all = byUser(store.state().reports, req.user.uid).filter(reportVisibleToOwner)
		const start = (page - 1) * pageSize
		// Never return the canonical analysis (or historical aliases/raw text) in
		// list responses. Mobile clients fetch a single owner-scoped detail only
		// when the user opens/restores that report.
		const list = all.slice(start, start + pageSize).map(ownerReportSummary)
		return ok(res, { list, total: all.length, page, pageSize })
	} catch (e) {
		logger.error({ err: e }, 'business/report/list failed')
		return fail(res, 5000, '获取报告列表失败')
	}
})

router.get('/api/report/stats', authRequired, (req, res) => {
	try {
		const list = byUser(store.state().reports, req.user.uid).filter(reportVisibleToOwner)
		const summaries = list.map(ownerReportSummary)
		const latest = summaries[0] || null
		const knownScores = summaries
			.map((item) => item.score)
			.filter((score) => typeof score === 'number' && Number.isFinite(score))
		const averageScore = knownScores.length
			? Math.round((knownScores.reduce((sum, score) => sum + score, 0) / knownScores.length) * 100) / 100
			: null
		return ok(res, {
			totalCount: list.length,
			latestScore: latest ? latest.score : null,
			averageScore,
			knownScoreCount: knownScores.length,
			unknownScoreCount: summaries.length - knownScores.length,
			archivalLatestScore: latest ? latest.archivalScore : null,
			decisionState: latest ? latest.decisionState : 'unknown'
		})
	} catch (e) {
		logger.error({ err: e }, 'business/report/stats failed')
		return fail(res, 5000, '获取报告统计失败')
	}
})

router.get('/api/report/:id', authRequired, (req, res) => {
	try {
		const item = byUser(store.state().reports, req.user.uid)
			.filter(reportVisibleToOwner)
			.find((x) => x.id === req.params.id || x._id === req.params.id)
		if (!item) return fail(res, 2001, 'report not found')
		return ok(res, ownerReportDetail(item))
	} catch (e) {
		logger.error({ err: e }, 'business/report/get failed')
		return fail(res, 5000, '获取报告详情失败')
	}
})

router.post('/api/report/detail', authRequired, (req, res) => {
	try {
		const reportId = String(req.body && req.body.reportId || '').trim()
		if (!reportId) return fail(res, 1001, 'reportId is required')
		const item = byUser(store.state().reports, req.user.uid)
			.filter(reportVisibleToOwner)
			.find((x) => x.id === reportId || x._id === reportId)
		if (!item) return fail(res, 2001, 'report not found')
		return ok(res, ownerReportDetail(item))
	} catch (e) {
		logger.error({ err: e }, 'business/report/detail failed')
		return fail(res, 5000, '获取报告详情失败')
	}
})

router.delete('/api/report/:id', authRequired, (req, res) => {
	try {
			const reports = store.state().reports
			const item = reports.find(
				(x) => x.userId === req.user.uid && (x.id === req.params.id || x._id === req.params.id)
			)
			if (!item) return fail(res, 2001, 'report not found')
			const now = nowIso()
			item.hiddenFromOwner = true
			item.userDeletedAt = item.userDeletedAt || now
			item.archivedAt = item.archivedAt || now
			item.archiveReason = 'user-removed-report'
			item.archivedByUserId = req.user.uid
			item.updatedAt = now
			store.persistSync()
			return ok(res, { ok: true, archived: true, reportId: item.id || item._id })
		} catch (e) {
			logger.error({ err: e }, 'business/report/delete failed')
		return fail(res, 5000, '删除报告失败')
	}
})

// ─── 顾问联系 ──────────────────────────────────────────────

router.get('/api/advisor/my', authRequired, (req, res) => {
	try {
		// 返回用户的实际联系记录（非硬编码假数据）
		const contacts = byUser(store.state().advisorContacts, req.user.uid)
		return ok(res, {
			advisor: { name: '平台顾问', phone: '', rating: null, reviewCount: 0 },
			serviceRecords: contacts.map((c) => ({
				id: c._id,
				advisorId: c.advisorId,
				reportId: c.reportId,
				contactType: c.contactType,
				channel: contactChannelOf(c),
				status: c.status,
				time: c.createTime,
				createTime: c.createTime,
				updateTime: c.updateTime || c.createTime,
				advisorInfo: c.advisorInfo || null
			}))
		})
	} catch (e) {
		logger.error({ err: e }, 'business/advisor/my failed')
		return fail(res, 5000, '获取顾问信息失败')
	}
})

const ALLOWED_CONTACT_TYPES = new Set(['phone', 'wechat', 'appointment', 'match-product', 'debt-optimization', 'customer-service'])
const CONTACT_CHANNELS = new Set(['bank', 'service'])

function resolveContactChannel(body = {}, contactType = '') {
	const explicit = String(firstNonEmpty(body.channel, body.deskType, body.serviceChannel, '')).trim().toLowerCase()
	if (CONTACT_CHANNELS.has(explicit)) return explicit
	if (explicit === 'support' || explicit === 'customer-service') return 'service'
	if (contactType === 'customer-service') return 'service'
	if (contactType === 'match-product') return 'bank'
	return 'bank'
}

function advisorInfoFor(channel, context = {}) {
	if (channel === 'service') {
		return { name: '平台客服', role: 'service', bank: '平台客服中心', avatar: '/static/logo.png' }
	}
	const institution = firstNonEmpty(context.institution, context.product && context.product.institution, '合作银行')
	return { name: `${institution}客户经理`, role: 'advisor', bank: institution, avatar: '/static/logo.png' }
}

function isRoleUser(user = {}, role = '') {
	const roles = Array.isArray(user.roles) ? user.roles : [user.role]
	return roles.map((item) => String(item || '').trim()).includes(role)
}

function advisorCandidates() {
	return ensureArray('users')
		.filter((user) => isRoleUser(user, 'advisor'))
		.map((user) => ({
			id: user.id || user._id || user.uid || '',
			uid: user.id || user._id || user.uid || '',
			name: firstNonEmpty(
				user.nickname,
				user.realName,
				user.name,
				firstNonEmpty(user.phone, user.mobile) ? `银行老师${String(firstNonEmpty(user.phone, user.mobile)).slice(-4)}` : '',
				'银行老师'
			),
			institution: firstValidInstitution(user.institution, user.bankName, user.company),
			role: 'advisor'
		}))
		.filter((item) => item.uid && item.institution)
}

function advisorCandidatesForInstitution(institution) {
	return advisorCandidates().filter((advisor) => institutionTextMatches(advisor.institution, institution))
}

function notifyInstitutionAdvisorsOfLead(contact) {
	if (!isBankServiceGroup(contact)) return
	const institution = contactInstitutionOf(contact)
	if (!institution) return
	const candidates = advisorCandidatesForInstitution(institution)
	candidates.forEach((advisor) => {
		addMessage(advisor.uid, {
			type: 'product',
			title: '有新的本机构匹配客户',
			desc: `${maskedContactName(firstNonEmpty(contact.clientName, contact.name, '客户'))}匹配到${firstNonEmpty(contact.productName, contact.product && contact.product.name, institution + '方案')}，待客服确认后可进入群聊。`,
			linkType: 'page',
			url: '/pages/bank/workbench',
			actionUrl: '/pages/bank/workbench',
			action: '查看本机构线索',
			contactId: contactIdOf(contact)
		})
	})
}

function normalizeConversationMessage(body = {}, req, contact, opts = {}) {
	const senderRole = firstNonEmpty(opts.senderRole, actorRole(req))
	const senderType = senderRole === 'advisor' ? 'bank' : senderRole === 'service' ? 'service' : senderRole === 'admin' ? 'admin' : 'user'
	const user = currentAuthUser(req) || {}
	const text = String(firstNonEmpty(body.content, body.text, body.message, body.summary, '')).trim()
	const message = {
		id: makeId('cm'),
		contactId: contactIdOf(contact),
		userId: contact.userId,
		channel: contactChannelOf(contact),
		senderType,
		senderRole,
		senderId: req.user.uid,
		senderName: firstNonEmpty(body.senderName, user.nickname, user.phone, senderType === 'bank' ? '银行客户经理' : senderType === 'service' ? '客服' : senderType === 'admin' ? '管理员' : '用户'),
		content: text,
		createdAt: nowIso(),
		messageSequence: nextContactEventSequence(contact)
	}
	message.sequence = message.messageSequence
	const mentions = extractMentions(text)
	if (mentions.length) message.mentions = mentions
	return message
}

function extractMentions(text = '') {
	const source = String(text || '')
	const hits = []
	const add = (role, label) => {
		if (!hits.some((item) => item.role === role)) hits.push({ role, label })
	}
	if (/@(客服|平台客服)/.test(source)) add('service', '客服')
	if (/@(银行老师|银行经理|客户经理)/.test(source)) add('advisor', '银行老师')
	if (/@(管理员|平台|监控)/.test(source)) add('admin', '管理员')
	if (/@(客户|用户)/.test(source)) add('user', '客户')
	return hits
}

function appendSystemContactMessage(contact, content, extra = {}) {
	if (!Array.isArray(contact.messages)) contact.messages = []
	const createdAt = nowIso()
	const message = {
		id: makeId('cm'),
		contactId: contactIdOf(contact),
		userId: contact.userId,
		channel: contactChannelOf(contact),
		senderType: 'system',
		senderRole: 'system',
		senderId: 'system',
		senderName: '系统',
		content,
		createdAt,
		messageSequence: nextContactEventSequence(contact),
		...extra
	}
	message.sequence = message.messageSequence
	contact.messages.push(message)
	contact.updateTime = createdAt
	contact.updatedAt = createdAt
	return message
}

function actorDisplayName(req, fallback = '当前账号') {
	const user = currentAuthUser(req) || {}
	const phone = firstNonEmpty(user.phone, user.mobile)
	return firstNonEmpty(user.nickname, user.realName, user.name, phone ? `${fallback}${String(phone).slice(-4)}` : '', fallback)
}

function canCloseoutContact(req, contact) {
	const role = actorRole(req)
	if (role === 'admin') return true
	if (role === 'user') return contact.userId === req.user.uid
	return staffCanReplyContact(req, contact)
}

function visibleMessagesForActor(req, contact, messages = []) {
	const role = actorRole(req)
	if (role === 'admin') return messages
	if (role === 'advisor' && !advisorCanReadContact(req, contact)) return []
	if (role === 'service' && !serviceCanReadContact(req, contact)) return []
	if (role === 'user' && contact.customerChatClosed === true) return []
	const latestClear = latestClearRecordForActor(req, contact)
	if (!latestClear) return messages
	return messages.filter((message) => messageOccursAfterClear(message, latestClear))
}

function messageReadReceiptsFor(contact, message = {}) {
	const createdTs = new Date(message.createdAt || message.updateTime || 0).getTime()
	if (!Number.isFinite(createdTs) || !createdTs) return []
	const states = Array.isArray(contact.chatReadStates) ? contact.chatReadStates : []
	return states
		.filter((state) => {
			if (!state || state.actorRole === 'admin') return false
			if (message.senderRole && state.actorRole === message.senderRole) return false
			if (message.senderId && state.actorId && String(state.actorId) === String(message.senderId)) return false
			const readTs = new Date(state.readAt || 0).getTime()
			return Number.isFinite(readTs) && readTs >= createdTs
		})
		.map((state) => ({
			actorId: state.actorId,
			actorRole: state.actorRole,
			actorName: state.actorName,
			readAt: state.readAt
		}))
}

function decorateMessagesForActor(req, contact, messages = []) {
	const role = actorRole(req)
	const actorId = req.user && String(req.user.uid || '')
	const decorated = messages.map((message) => {
		const readBy = messageReadReceiptsFor(contact, message)
		const mine = !!(
			actorId && message.senderId && String(message.senderId) === actorId
		) || (
			message.senderRole && message.senderRole === role
		) || (
			senderTypeForRole(role) === message.senderType && role !== 'user'
		)
		const showReceipt = mine && !message.localPending && message.senderType !== 'system'
		const readByCount = readBy.length
		return {
			...message,
			readBy,
			readByCount,
			readStatus: showReceipt ? (readByCount > 0 ? 'read' : 'unread') : '',
			readStatusText: showReceipt ? (readByCount > 0 ? '已读' : '未读') : ''
		}
	})
	return ['advisor', 'service', 'admin'].includes(role)
		? decorated.map(publicStaffMessage)
		: decorated
}

function canClearContactView(req, contact) {
	const role = actorRole(req)
	if (role === 'user') return contact.userId === req.user.uid
	if (role === 'service') return serviceCanReadContact(req, contact)
	if (role === 'advisor') return advisorCanReadContact(req, contact)
	return false
}

function senderTypeForRole(role = 'user') {
	if (role === 'advisor') return 'bank'
	if (role === 'service') return 'service'
	if (role === 'admin') return 'admin'
	return 'user'
}

function readStateForActor(req, contact) {
	const role = actorRole(req)
	const actorId = req.user && req.user.uid
	const states = Array.isArray(contact.chatReadStates) ? contact.chatReadStates : []
	return states.find((item) => item.actorRole === role && String(item.actorId || '') === String(actorId)) || null
}

function markContactReadForActor(req, contact, readAt = nowIso()) {
	const role = actorRole(req)
	const actorId = req.user && req.user.uid
	if (!actorId) return null
	if (!Array.isArray(contact.chatReadStates)) contact.chatReadStates = []
	const current = readStateForActor(req, contact)
	const patch = {
		actorId,
		actorRole: role,
		actorName: actorDisplayName(req, role),
		readAt,
		updatedAt: nowIso()
	}
	if (current) Object.assign(current, patch)
	else contact.chatReadStates.push(patch)
	return patch
}

function unreadCountForActor(req, contact, visibleMessages = null) {
	const role = actorRole(req)
	if (role === 'admin') return 0
	if (role === 'user' && contact.customerChatClosed === true) return 0
	const ownType = senderTypeForRole(role)
	const actorId = req.user && req.user.uid
	const read = readStateForActor(req, contact)
	const lastReadTs = new Date((read && read.readAt) || 0).getTime() || 0
	const messages = Array.isArray(visibleMessages) ? visibleMessages : visibleMessagesForActor(req, contact, Array.isArray(contact.messages) ? contact.messages : [])
	return messages.filter((message) => {
		if (!message || message.senderType === 'system') return false
		if (message.senderType === ownType) return false
		if (actorId && message.senderId && String(message.senderId) === String(actorId)) return false
		const ts = new Date(message.createdAt || message.updateTime || 0).getTime()
		return Number.isFinite(ts) && ts > lastReadTs
	}).length
}

function cleanReportCustomerName(value) {
	let s = String(value || '').replace(/\s+/g, '').trim()
	if (!s) return ''
	s = s.replace(/^姓名[:：]?/, '')
	s = s.split(/证件类型|证件号码|身份证|证件|出生|婚姻|手机|电话|报告/)[0]
	s = s.replace(/[0-9Xx]{4,}/g, '')
	const masked = s.match(/[\u4e00-\u9fa5·][*＊×Xx]{1,4}[\u4e00-\u9fa5·]{0,3}/)
	if (masked) return masked[0].replace(/[＊×Xx]/g, '*').slice(0, 6)
	const match = s.match(/[\u4e00-\u9fa5·]{2,8}/)
	return match ? match[0].slice(0, 4) : ''
}

function objectAt(value) {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function reportCustomerName(report = {}) {
	const ad = objectAt(report.analysisData || report.analysisResult || report.rawAnalysis || report.data)
	const cv2 = objectAt(ad.creditReportV2 || ad.credit_report_full || ad.credit_report_v2 || ad.cv2)
	const fp = objectAt(ad.frontendPayload || ad.frontend_payload)
	const basicCandidates = [
		objectAt(report.basic_info),
		objectAt(report.basicInfo),
		objectAt(report.report && report.report.basicInfo),
		objectAt(report.report && report.report.basic_info),
		objectAt(report.personalInfo),
		objectAt(report.personal_info),
		objectAt(ad.basic_info),
		objectAt(ad.basicInfo),
		objectAt(ad.report && ad.report.basicInfo),
		objectAt(ad.report && ad.report.basic_info),
		objectAt(ad.personalInfo),
		objectAt(ad.personal_info),
		objectAt(cv2.basic_info),
		objectAt(cv2.basicInfo),
		objectAt(fp.basic_info),
		objectAt(fp.basicInfo)
	]
	const candidates = [
		report.customerName,
		report.customer_name,
		report.clientName,
		report.userName,
		report.name,
		ad.customerName,
		ad.customer_name,
		ad.clientName,
		ad.userName,
		ad.name,
		...basicCandidates.flatMap((info) => [info.name, info.customer_name, info.customerName, info.user_name, info.clientName, info['姓名']])
	]
	for (const item of candidates) {
		const cleaned = cleanReportCustomerName(item)
		if (cleaned) return cleaned
	}
	return ''
}

function normalizeReportIdCard(value) {
	const s = String(value || '').replace(/[^\dXx]/g, '').toUpperCase()
	if (/^\d{17}[\dX]$/.test(s) || /^\d{15}$/.test(s)) return s
	return ''
}

function cleanReportIdLast4(value) {
	const full = normalizeReportIdCard(value)
	if (full) return full.slice(-4)
	const s = String(value || '').replace(/[^\dXx]/g, '').toUpperCase()
	return s.length >= 4 ? s.slice(-4) : ''
}

function reportIdentityFingerprint(fullIdCard) {
	const full = normalizeReportIdCard(fullIdCard)
	if (!full) return ''
	return crypto.createHash('sha256').update(`rpt-report-holder:${full}`).digest('hex')
}

function reportIdentityInfo(report = {}) {
	const ad = objectAt(report.analysisData || report.analysisResult || report.rawAnalysis || report.data)
	const cv2 = objectAt(ad.creditReportV2 || ad.credit_report_full || ad.credit_report_v2 || ad.cv2)
	const fp = objectAt(ad.frontendPayload || ad.frontend_payload)
	const basicCandidates = [
		objectAt(report.basic_info),
		objectAt(report.basicInfo),
		objectAt(report.report && report.report.basicInfo),
		objectAt(report.report && report.report.basic_info),
		objectAt(report.personalInfo),
		objectAt(report.personal_info),
		objectAt(ad.basic_info),
		objectAt(ad.basicInfo),
		objectAt(ad.report && ad.report.basicInfo),
		objectAt(ad.report && ad.report.basic_info),
		objectAt(ad.personalInfo),
		objectAt(ad.personal_info),
		objectAt(cv2.basic_info),
		objectAt(cv2.basicInfo),
		objectAt(fp.basic_info),
		objectAt(fp.basicInfo)
	]
	const storedFingerprint = firstNonEmpty(
		report.reportIdentityFingerprint,
		report.identityFingerprint,
		report.idFingerprint,
		report.reportIdentity && report.reportIdentity.fingerprint
	)
	if (storedFingerprint) {
		const last4 = cleanReportIdLast4(firstNonEmpty(report.reportIdentityLast4, report.idLast4, report.id_last4, report.reportIdentity && report.reportIdentity.last4))
		return { key: `fingerprint:${storedFingerprint}`, fingerprint: String(storedFingerprint), last4, precise: true }
	}
	const fullCandidates = [
		report.idCard,
		report.id_card,
		report.idNo,
		report.id_no,
		report.idNumber,
		report.id_number,
		report.identityNo,
		report.identity_no,
		report.certificateNo,
		report.certificate_no,
		report.certNo,
		report.cert_no,
		report.credentialNo,
		report.credential_no,
		report['身份证号'],
		report['证件号码'],
		ad.idCard,
		ad.id_card,
		ad.idNo,
		ad.id_no,
		ad.idNumber,
		ad.id_number,
		ad.identityNo,
		ad.identity_no,
		ad.certificateNo,
		ad.certificate_no,
		ad.certNo,
		ad.cert_no,
		ad.credentialNo,
		ad.credential_no,
		ad['身份证号'],
		ad['证件号码'],
		...basicCandidates.flatMap((info) => [
			info.idCard,
			info.id_card,
			info.idNo,
			info.id_no,
			info.idNumber,
			info.id_number,
			info.identityNo,
			info.identity_no,
			info.certificateNo,
			info.certificate_no,
			info.certNo,
			info.cert_no,
			info.credentialNo,
			info.credential_no,
			info['身份证号'],
			info['证件号码']
		])
	]
	for (const item of fullCandidates) {
		const full = normalizeReportIdCard(item)
		if (full) {
			const fingerprint = reportIdentityFingerprint(full)
			return { key: `fingerprint:${fingerprint}`, fingerprint, last4: full.slice(-4), precise: true }
		}
	}
	const last4Candidates = [
		report.reportIdentityLast4,
		report.idLast4,
		report.id_last4,
		report.reportIdentity && report.reportIdentity.last4,
		ad.idLast4,
		ad.id_last4,
		...fullCandidates,
		...basicCandidates.flatMap((info) => [info.idLast4, info.id_last4])
	]
	for (const item of last4Candidates) {
		const last4 = cleanReportIdLast4(item)
		if (last4) return { key: `last4:${last4}`, last4, precise: false }
	}
	return { key: '', last4: '', precise: false }
}

function sameReportIdentity(a = {}, b = {}) {
	if (!a.key || !b.key) return false
	if (a.fingerprint && b.fingerprint) return a.fingerprint === b.fingerprint
	return Boolean(a.last4 && b.last4 && a.last4 === b.last4)
}

function reportIdentityLabel(info = {}) {
	return info.last4 ? `身份证尾号${info.last4}` : '身份证信息'
}

function cleanReportMonth(value = '') {
	const s = String(value || '').trim()
	if (!s) return ''
	let m = s.match(/(20\d{2})[-/.年](0?[1-9]|1[0-2])(?:[-/.月]|$)/)
	if (!m) m = s.match(/(20\d{2})(0[1-9]|1[0-2])(?:\d{2})?/)
	if (!m) return ''
	const month = String(m[2]).padStart(2, '0')
	return `${m[1]}-${month}`
}

function reportMonthOf(report = {}) {
	const ad = objectAt(report.analysisData || report.analysisResult || report.rawAnalysis || report.data)
	const cv2 = objectAt(ad.creditReportV2 || ad.credit_report_full || ad.credit_report_v2 || ad.cv2)
	const fp = objectAt(ad.frontendPayload || ad.frontend_payload)
	const meta = objectAt(ad.meta || cv2.meta || fp.meta)
	const basic = objectAt(ad.basic_info || ad.basicInfo || cv2.basic_info || cv2.basicInfo || fp.basic_info || fp.basicInfo)
	const candidates = [
		report.reportMonth,
		report.reportPeriod,
		report.reportDate,
		report.report_date,
		report.date,
		report.fileName,
		report.name,
		ad.reportMonth,
		ad.reportPeriod,
		ad.reportDate,
		ad.report_date,
		meta.report_month,
		meta.reportMonth,
		meta.report_date,
		meta.reportDate,
		meta.query_date,
		meta.queryDate,
		basic.report_month,
		basic.reportMonth,
		basic.report_date,
		basic.reportDate,
		basic.query_date,
		basic.queryDate
	]
	for (const item of candidates) {
		const month = cleanReportMonth(item)
		if (month) return month
	}
	return ''
}

function isFranchiseReportUser(user = {}) {
	return isFixedTestReportAccount(user) || user.reportUploadUnlimited === true || user.franchiseReportUnlimited === true || user.franchiseReportPermission === 'unlimited'
}

function isFixedTestReportAccount(user = {}) {
	return FIXED_TEST_ACCOUNTS_ENABLED && /^1960000000[1-7]$/.test(String(user.phone || user.mobile || '').trim())
}

function reportUploadPolicyFor(req, payload = {}) {
	const user = currentAuthUser(req) || {}
	if (isFranchiseReportUser(user)) return { allowed: true, mode: 'franchise' }
	const draft = {
		...payload,
		analysisData: payload.analysisResult || payload.analysisData,
		analysisResult: payload.analysisResult || payload.analysisData
	}
	const nextName = reportCustomerName(draft)
	if (!nextName) {
		return { allowed: false, message: '未识别到征信报告姓名，请上传清晰完整的本人征信报告。' }
	}
	const nextIdentity = reportIdentityInfo(draft)
	if (!nextIdentity.key) {
		return { allowed: false, message: '未识别到征信报告身份证信息，请上传清晰完整的本人征信报告。' }
	}
	const reports = ensureArray('reports').filter((report) => String(report.userId || '') === String(req.user.uid || ''))
	const nextMonth = reportMonthOf(draft)
	if (!reports.length) {
		return { allowed: true, mode: 'first', customerName: nextName, reportMonth: nextMonth, reportIdentityLast4: nextIdentity.last4, reportIdentityFingerprint: nextIdentity.fingerprint }
	}
	const existingNames = reports.map(reportCustomerName).filter(Boolean)
	if (existingNames.length && !existingNames.some((name) => name === nextName)) {
		return { allowed: false, message: `当前手机号已绑定${existingNames[0]}的征信档案，不能上传其他人的征信报告。` }
	}
	if (!existingNames.length) {
		return { allowed: false, message: '当前账号已有历史征信报告但缺少姓名，需管理员核验后再上传更新报告。' }
	}
	const existingIdentities = reports
		.map((report) => ({ name: reportCustomerName(report), identity: reportIdentityInfo(report) }))
		.filter((item) => item.name && item.identity && item.identity.key)
	if (!existingIdentities.length) {
		return { allowed: false, message: '当前账号已有历史征信报告但缺少身份证信息，需管理员核验后再上传更新报告。' }
	}
	const sameHolder = existingIdentities.some((item) => item.name === nextName && sameReportIdentity(item.identity, nextIdentity))
	if (!sameHolder) {
		const bound = existingIdentities.find((item) => item.name === nextName) || existingIdentities[0]
		return { allowed: false, message: `当前手机号已绑定${bound.name}${reportIdentityLabel(bound.identity)}的征信档案，不能上传其他人的征信报告。` }
	}
	return { allowed: true, mode: 'same-person-update', customerName: nextName, reportMonth: nextMonth, reportIdentityLast4: nextIdentity.last4, reportIdentityFingerprint: nextIdentity.fingerprint }
}

function customerNameFromUploadedReport(contact = {}) {
	const reports = ensureArray('reports')
	const contactReportId = firstNonEmpty(contact.reportId, contact.sourceReportId, contact.context && contact.context.reportId)
	const userReports = reports
		.filter((report) => String(report.userId || '') === String(contact.userId || ''))
		.sort((a, b) => String(b.createdAt || b.updatedAt || '').localeCompare(String(a.createdAt || a.updatedAt || '')))
	const ordered = contactReportId
		? [
			...userReports.filter((report) => String(report.id || report._id || '') === String(contactReportId)),
			...userReports.filter((report) => String(report.id || report._id || '') !== String(contactReportId))
		]
		: userReports
	for (const report of ordered) {
		const name = reportCustomerName(report)
		if (name) return name
	}
	return ''
}

function normalizedReusableValue(value = '') {
	return String(value || '').replace(/\s+/g, '').trim().toLowerCase()
}

function productIdentityOf(item = {}) {
	const ctx = item.context && typeof item.context === 'object' ? item.context : {}
	const product = item.product && typeof item.product === 'object' ? item.product : {}
	const ctxProduct = ctx.product && typeof ctx.product === 'object' ? ctx.product : {}
	return {
		productId: normalizedReusableValue(firstNonEmpty(item.productId, product.id, ctx.productId, ctxProduct.id)),
		productName: normalizedReusableValue(firstNonEmpty(item.productName, product.name, ctx.productName, ctxProduct.name)),
		institution: normalizedReusableValue(contactInstitutionOf(item))
	}
}

function reusableContactMatches(input, item) {
	if (!item || item.customerChatClosed === true) return false
	if (['completed', 'done', 'resolved'].includes(String(item.status || '').toLowerCase())) return false
	if (['completed', 'done', 'resolved'].includes(String(item.orderStatus || '').toLowerCase())) return false
	if (contactChannelOf(item) !== input.channel) return false
	if (String(item.contactType || '') !== input.contactType) return false
	if (input.advisorId && String(item.advisorId || '') !== input.advisorId) return false
	const reportId = normalizedReusableValue(input.reportId)
	const itemReportId = normalizedReusableValue(firstNonEmpty(item.reportId, item.sourceReportId, item.context && item.context.reportId))
	if (reportId && itemReportId !== reportId) return false
	const intent = normalizedReusableValue(input.contactIntent)
	const itemIntent = normalizedReusableValue(firstNonEmpty(item.contactIntent, item.context && item.context.contactIntent))
	if (intent && itemIntent && itemIntent !== intent) return false
	if (input.contactType === 'match-product') {
		const existingProduct = productIdentityOf(item)
		if (input.productId && existingProduct.productId && existingProduct.productId !== input.productId) return false
		if (!input.productId && input.productName && existingProduct.productName !== input.productName) return false
		if (input.institution && existingProduct.institution && !institutionTextMatches(input.institution, existingProduct.institution, true)) return false
	}
	return !!(reportId || intent || input.productId || input.productName || input.advisorId)
}

function findReusableAdvisorContact(req, input = {}) {
	const userId = req.user && req.user.uid
	if (!userId) return null
	const normalized = {
		channel: input.channel,
		contactType: input.contactType,
		reportId: firstNonEmpty(input.reportId),
		contactIntent: firstNonEmpty(input.contactIntent),
		productId: normalizedReusableValue(input.productId),
		productName: normalizedReusableValue(input.productName),
		institution: firstNonEmpty(input.institution),
		advisorId: cleanId(input.advisorId)
	}
	return ensureArray('advisorContacts')
		.filter((item) => String(item.userId || '') === String(userId))
		.filter((item) => reusableContactMatches(normalized, item))
		.sort((a, b) => String(b.updateTime || b.updatedAt || b.createdAt || '').localeCompare(String(a.updateTime || a.updatedAt || a.createdAt || '')))[0] || null
}

function adminReportSummary(report = {}) {
	const ad = objectAt(report.analysisData || report.analysisResult || report.rawAnalysis || report.data)
	const assessment = objectAt(ad.assessment)
	const trustedAnalysis = trustedCanonicalAnalysisForReport(report)
	const decisionAnalysis = trustedAnalysis || ad
	const decision = buildDecisionSummary(
		{ ...report, analysisData: decisionAnalysis },
		{ evidenceTrusted: Boolean(trustedAnalysis) }
	)
	return {
		id: firstNonEmpty(report.id, report._id, report.reportId),
		reportId: firstNonEmpty(report.id, report._id, report.reportId),
		fileName: firstNonEmpty(report.fileName, report.name, report.originalName, '信用报告'),
		reportType: firstNonEmpty(report.reportType, report.type, 'credit'),
		customerName: reportCustomerName(report),
		score: decision.score,
		riskLevel: decision.riskLevel,
		riskText: null,
		totalDebt: decision.totalDebt,
		totalLoanBalance: decision.totalLoanBalance,
		cardTotalLimit: decision.cardTotalLimit,
		cardTotalUsed: decision.cardTotalUsed,
		cardUtilizationUsed: decision.cardUtilizationUsed,
		cardUtilizationRate: decision.cardUtilizationRate,
		cardUtilizationPct: decision.cardUtilizationPct,
		sharedCreditGroupCount: decision.sharedCreditGroupCount,
		query1mCount: decision.query1mCount,
		query3mCount: decision.query3mCount,
		query6mCount: decision.query6mCount,
		query12mCount: decision.query12mCount,
		archivalScore: decision.archivalScore,
		archivalRiskLevel: decision.archivalRiskLevel,
		archivalAccountCount: decision.archivalAccountCount,
		archivalTotalDebt: decision.archivalTotalDebt,
		archivalQuery6mCount: decision.archivalQuery6mCount,
		decisionFlags: decision.decisionFlags,
		decisionState: decision.decisionState,
		evidenceVerified: decision.evidenceVerified,
		analysisSummary: firstNonEmpty(ad.aiSuggestion, ad.suggestion, assessment.suggestion, report.summary),
		createdAt: firstNonEmpty(report.createdAt, report.createTime, report.updatedAt),
		archivedAt: firstNonEmpty(report.archivedAt, report.userDeletedAt),
		hiddenFromOwner: report.hiddenFromOwner === true,
		archiveReason: report.archiveReason || ''
	}
}

function isCustomerUser(user = {}) {
	return !hasRole(user, ['advisor', 'service', 'admin', 'publisher', 'monitor'])
}

function buildCustomerDocuments(conversations = [], materials = [], reports = [], users = []) {
	const map = new Map()
	const ensureDoc = (contact = {}) => {
		const userId = firstNonEmpty(contact.userId, contact.uid, contact.id, contact.clientId, contact.name, contactIdOf(contact))
		const account = users.find((user) => String(user.id || user.uid || '') === String(userId)) || {}
		const reportName = customerNameFromUploadedReport(contact)
		if (!map.has(userId)) {
			map.set(userId, {
				id: `customer-doc-${userId}`,
				userId,
				name: firstNonEmpty(reportName, contact.clientName, contact.name, account.nickname, account.realName, account.phone ? `用户${String(account.phone).slice(-4)}` : '', '客户'),
				reportCustomerName: reportName,
				phone: firstNonEmpty(contact.phone, contact.mobile, account.phone, account.mobile),
				conversationCount: 0,
				materialCount: 0,
				reportCount: 0,
				messageCount: 0,
				feedbackCount: 0,
				completionCount: 0,
				clearCount: 0,
				closedChatCount: 0,
				latestTs: '',
				conversations: [],
				materials: [],
				reports: [],
				feedbacks: [],
				completions: [],
				chatClears: [],
				notes: [],
				latestReport: null
			})
		}
		const doc = map.get(userId)
		if (reportName && !doc.reportCustomerName) {
			doc.reportCustomerName = reportName
			doc.name = reportName
		}
		if (reportName && doc.name !== reportName) doc.name = reportName
		return doc
	}
	conversations.forEach((contact) => {
		const doc = ensureDoc(contact)
		const messages = Array.isArray(contact.messages) ? contact.messages : []
		const feedbacks = Array.isArray(contact.serviceFeedbacks) ? contact.serviceFeedbacks : []
		const completions = Array.isArray(contact.completionRecords) ? contact.completionRecords : []
		const clears = Array.isArray(contact.chatClears) ? contact.chatClears : []
		const notes = Array.isArray(contact.notes) ? contact.notes : []
		doc.conversationCount += 1
		doc.messageCount += messages.length
		doc.feedbackCount += feedbacks.length
		doc.completionCount += completions.length
		doc.clearCount += clears.length
		doc.closedChatCount += contact.customerChatClosed ? 1 : 0
		doc.latestTs = [doc.latestTs, contact.updateTime, contact.updatedAt, contact.createdAt, contact.createTime].filter(Boolean).sort().pop() || doc.latestTs
		doc.conversations.push(contact)
		doc.feedbacks.push(...feedbacks)
		doc.completions.push(...completions)
		doc.chatClears.push(...clears.map((item) => ({ ...item, contactId: contactIdOf(contact) })))
		doc.notes.push(...notes.map((item) => ({ ...item, contactId: contactIdOf(contact) })))
	})
	reports.forEach((report) => {
		const userId = firstNonEmpty(report.userId, report.uid)
		if (!userId) return
		const doc = ensureDoc({ userId })
		const summary = adminReportSummary(report)
		doc.reports.push(summary)
		doc.reportCount += 1
		doc.latestTs = [doc.latestTs, summary.createdAt].filter(Boolean).sort().pop() || doc.latestTs
		if (summary.customerName) {
			doc.reportCustomerName = summary.customerName
			doc.name = summary.customerName
		}
		if (!doc.latestReport || String(summary.createdAt || '').localeCompare(String(doc.latestReport.createdAt || '')) >= 0) {
			doc.latestReport = summary
		}
	})
	materials.forEach((material) => {
		const contact = conversations.find((item) => String(contactIdOf(item)) === String(material.contactId || ''))
		const doc = contact ? ensureDoc(contact) : (material.userId ? ensureDoc({ userId: material.userId, name: material.customerName }) : null)
		if (!doc) return
		doc.materials.push(material)
		doc.materialCount += 1
	})
	users.filter(isCustomerUser).forEach((user) => {
		const uid = firstNonEmpty(user.id, user.uid)
		if (!uid) return
		ensureDoc({ userId: uid, name: user.nickname || user.realName, phone: user.phone || user.mobile })
	})
	return [...map.values()].sort((a, b) => String(b.latestTs || '').localeCompare(String(a.latestTs || '')))
}

router.post('/api/advisor/contact', authRequired, (req, res) => {
	const body = req.body || {}
	const { reportId: inputReportId = '', contactType = 'phone' } = body
	if (!ALLOWED_CONTACT_TYPES.has(contactType)) return fail(res, 1001, 'contactType 仅支持 phone/wechat/appointment/match-product/debt-optimization/customer-service')
	try {
			const id = makeId('c')
			const context = stripServerOwnedFields(body)
			const currentUser = currentAuthUser(req) || {}
			const createdAt = nowIso()
			const scope = canonicalCaseFor(req.user.uid, {
				...body,
				reportId: inputReportId
			})
			if (scope.conflict) return fail(res, 1001, scope.conflictMessage, { field: 'clientReportId' }, 409)
			const reportId = firstNonEmpty(scope.reportId, inputReportId)
			const caseId = scope.caseId
			const clientReportId = firstNonEmpty(scope.clientReportId, body.clientReportId, body.sourceReportId)
			const channel = resolveContactChannel(body, contactType)
			const institution = firstNonEmpty(context.institution, context.product && context.product.institution, context.context && context.context.institution, context.context && context.context.product && context.context.product.institution)
			const parentInstitution = firstNonEmpty(context.parentInstitution, context.product && context.product.parentInstitution, context.context && context.context.parentInstitution, context.context && context.context.product && context.context.product.parentInstitution)
			const isProductGroup = channel === 'bank' && contactType === 'match-product'
			const requestedAdvisorId = cleanId(body.advisorId)
			if (requestedAdvisorId && (isProductGroup || channel !== 'bank')) {
				return fail(res, 1001, '三方群或客服会话不接受客户指定银行老师')
			}
			const directAdvisor = requestedAdvisorId
				? advisorCandidates().find((candidate) => cleanId(candidate.uid) === requestedAdvisorId)
				: null
			if (requestedAdvisorId && !directAdvisor) return fail(res, 2001, '银行老师不存在或未关联机构')
			if (directAdvisor && !institutionTextMatches(directAdvisor.institution, institution)) {
				return fail(res, 3003, '只能联系该机构已备案的银行老师', null, 403)
			}
			const initialContent = String(firstNonEmpty(body.initialMessage, body.message, body.question, body.summary, '')).trim()
			const reportName = customerNameFromUploadedReport({ userId: req.user.uid, reportId })
			const customerName = firstNonEmpty(context.reportCustomerName, context.customerName, reportName, context.clientName, context.name, context.userName, currentUser.nickname, currentUser.realName, currentUser.mobile ? `用户${String(currentUser.mobile).slice(-4)}` : '客户')
			const customerPhone = firstNonEmpty(context.phone, context.mobile, currentUser.mobile, currentUser.phone)
			const reusable = findReusableAdvisorContact(req, {
				channel,
				contactType,
				reportId,
				contactIntent: context.contactIntent,
				productId: firstNonEmpty(context.productId, context.product && context.product.id),
				productName: firstNonEmpty(context.productName, context.product && context.product.name),
				institution,
				advisorId: directAdvisor && directAdvisor.uid
			})
			if (reusable) {
				if (initialContent) {
					const reusableId = contactIdOf(reusable)
					const messages = Array.isArray(reusable.messages) ? reusable.messages : []
					const createdMs = Date.parse(createdAt)
					const hasFreshDuplicate = messages.some((message) => {
						if (!message) return false
						if (String(message.senderId || '') !== String(req.user.uid || '')) return false
						if (String(message.content || '').trim() !== initialContent) return false
						const messageMs = Date.parse(message.createdAt || message.createTime || '')
						return Number.isFinite(createdMs) && Number.isFinite(messageMs) && Math.abs(createdMs - messageMs) < 15000
					})
					if (!hasFreshDuplicate) {
						const messageSequence = nextContactEventSequence(reusable)
						const message = {
							id: makeId('cm'),
							contactId: reusableId,
							userId: req.user.uid,
							channel,
							senderType: 'user',
							senderRole: 'user',
							senderId: req.user.uid,
							senderName: customerName || '客户',
							content: initialContent,
							createdAt,
							messageSequence,
							sequence: messageSequence
						}
						messages.push(message)
						markCustomerReopenRecords(reusable, message)
						reusable.messages = messages
					}
				}
				reusable.lastReusedAt = createdAt
				reusable.updateTime = createdAt
				reusable.updatedAt = createdAt
				store.persist()
				return ok(res, { ok: true, reused: true, contactId: contactIdOf(reusable), id: contactIdOf(reusable), record: decorateContactForRead(reusable, req) })
			}
			const record = {
				...context,
			_id: id,
			id,
			contactId: id,
			userId: req.user.uid,
			name: customerName,
			clientName: customerName,
			userName: customerName,
			customerName,
			reportCustomerName: reportName || context.reportCustomerName || context.customerName || '',
			phone: customerPhone,
			mobile: customerPhone,
			advisorId: directAdvisor ? directAdvisor.uid : '',
			advisorAssigneeId: '',
			advisorAssigneeName: '',
			advisorAssignedAt: '',
			advisorCompletedAt: '',
			serviceAssigneeId: '',
			serviceAssigneeName: '',
			serviceAssignedAt: '',
			serviceCompletedAt: '',
			invitedAdvisorId: '',
			invitedAdvisorName: '',
			invitedAdvisorInstitution: '',
			advisorInvitedAt: '',
			advisorInviteRecords: [],
			reportId,
			caseId,
			clientReportId,
			sourceReportId: clientReportId,
				contactType,
				channel,
				deskType: channel,
				institution,
				parentInstitution,
				groupMode: isProductGroup ? 'service-bank-customer' : '',
				serviceRequired: isProductGroup,
				serviceStatus: channel === 'service' || isProductGroup ? 'open' : '',
				advisorStatus: channel === 'bank' ? 'lead' : '',
				advisorAccessText: isProductGroup ? '待客服确认邀请后可进入群聊' : '',
				advisorJoinRequired: isProductGroup,
				chatAccess: !isProductGroup,
				materialAccess: false,
				orderStatus: 'open',
				orderCreatedAt: createdAt,
				status: 'pending',
			createTime: createdAt,
			createdAt,
			updateTime: createdAt,
			updatedAt: createdAt,
			context: {
				...(context.context && typeof context.context === 'object' ? context.context : context),
				reportId,
				caseId,
				clientReportId,
				sourceReportId: clientReportId
			},
			messages: [],
			chatReadStates: [],
			chatClears: [],
			supplementMaterials: supplementMaterialsForCase(req.user.uid, caseId).map((item) => ({ ...item })),
				advisorInfo: advisorInfoFor(channel, { ...context, institution })
			}
		if (initialContent) {
			const messageSequence = nextContactEventSequence(record)
			record.messages.push({
				id: makeId('cm'),
				contactId: id,
				userId: req.user.uid,
				channel,
				senderType: 'user',
				senderRole: 'user',
				senderId: req.user.uid,
				senderName: customerName || '客户',
				content: initialContent,
				createdAt,
				messageSequence,
				sequence: messageSequence
			})
		}
		ensureArray('advisorContacts').unshift(record)
		notifyInstitutionAdvisorsOfLead(record)
		store.persist()
		return ok(res, { ok: true, contactId: record._id, id: record._id, record })
	} catch (e) {
		logger.error({ err: e }, 'business/advisor/contact failed')
		return fail(res, 5000, '创建联系记录失败')
	}
})

router.get('/api/advisor/contacts', authRequired, (req, res) => {
	try {
		return ok(res, { list: visibleAdvisorContacts(req).map((item) => decorateContactForRead(item, req)) })
	} catch (e) {
		logger.error({ err: e }, 'business/advisor/contacts failed')
		return fail(res, 5000, '获取联系记录失败')
	}
})

router.get('/api/advisor/bank-teachers', authRequired, (req, res) => {
	try {
		const role = actorRole(req)
		if (!['service', 'admin'].includes(role)) return fail(res, 3003, '仅客服可邀请银行老师', null, 403)
		const contactId = cleanId(firstNonEmpty(req.query && req.query.contactId, req.query && req.query.id))
		if (!contactId) {
			return ok(res, {
				list: role === 'admin' ? advisorCandidates().map(publicStaffAdvisorInfo) : [],
				contactId: '',
				institution: '',
				institutionBindingRequired: true
			})
		}
		const item = findAdvisorContact(req, contactId, { allowStaff: true })
		if (!item) return fail(res, 2001, 'contact not found')
		const institution = contactInstitutionOf(item)
		return ok(res, {
			list: (normalizedInstitution(institution)
				? advisorCandidatesForInstitution(institution)
				: advisorCandidates()).map(publicStaffAdvisorInfo),
			contactId: contactIdOf(item),
			institution,
			institutionBindingRequired: !normalizedInstitution(institution)
		})
	} catch (e) {
		logger.error({ err: e }, 'business/advisor/bank-teachers failed')
		return fail(res, 5000, '获取银行老师列表失败')
	}
})

function materialItemsForAdmin(contact = {}) {
	const groups = [
		Array.isArray(contact.materials) ? contact.materials : [],
		Array.isArray(contact.supplementMaterials) ? contact.supplementMaterials : [],
		Array.isArray(contact.requiredMaterials) ? contact.requiredMaterials : []
	]
	return groups.flat().map((item, index) => ({
		...(typeof item === 'string' ? { name: item } : item),
		id: (item && (item.id || item.materialId || item.key)) || `${contactIdOf(contact)}-${index}`,
		contactId: contactIdOf(contact),
		userId: contact.userId || '',
		customerName: firstNonEmpty(contact.clientName, contact.name, '客户'),
		productName: firstNonEmpty(contact.productName, contact.context && contact.context.productName),
		institution: contactInstitutionOf(contact),
		statusText: item && item.statusText ? item.statusText : '待确认'
	}))
}

function supplementMaterialItemsForAdmin(materials = [], users = []) {
	return materials.map((item = {}) => {
		const user = users.find((row) => String(row.id || row.uid || '') === String(item.userId || '')) || {}
		const safeItem = publicStaffMaterial(item)
		const customerName = firstNonEmpty(item.customerName, user.nickname, user.realName, user.phone ? `用户${String(user.phone).slice(-4)}` : '')
		return {
			...safeItem,
			id: firstNonEmpty(safeItem.id, safeItem.materialId, `${safeItem.userId || ''}-${safeItem.materialType || safeItem.type || safeItem.name || 'material'}`),
			contactId: firstNonEmpty(safeItem.contactId),
			userId: firstNonEmpty(safeItem.userId),
			customerName: typeof customerName === 'string' ? maskPhoneText(customerName) : '客户',
			name: firstNonEmpty(safeItem.name, safeItem.materialName, '补充材料'),
			productName: firstNonEmpty(safeItem.productName),
			institution: firstNonEmpty(safeItem.institution),
			statusText: firstNonEmpty(safeItem.statusText, '待确认')
		}
	})
}

function dedupeAdminMaterials(items = []) {
	const map = new Map()
	items.forEach((item = {}) => {
		const key = [
			item.userId || '',
			item.materialType || item.type || '',
			item.id || item.materialId || item.key || item.name || '',
			item.fileUrl || item.uploadUrl || item.url || ''
		].join('|')
		const existing = map.get(key)
		map.set(key, existing ? { ...item, ...existing, contactId: existing.contactId || item.contactId || '' } : item)
	})
	return [...map.values()]
}

const GRANTABLE_ROLES = new Set(['admin', 'service', 'advisor', 'publisher', 'monitor', 'user'])

function isValidGrantPhone(value) {
	return /^1[3-9]\d{9}$/.test(String(value || '').trim())
}

function defaultNicknameForRole(role, phone) {
	const suffix = String(phone || '').slice(-4)
	if (role === 'admin') return `管理员${suffix}`
	if (role === 'service') return `客服${suffix}`
	if (role === 'advisor') return `银行老师${suffix}`
	if (role === 'publisher') return `内容运营${suffix}`
	if (role === 'monitor') return `监测账号${suffix}`
	return `用户${suffix}`
}

function managedUsersList() {
	const users = Array.isArray(store.state().users) ? store.state().users : []
	return users
		.filter((user) => user && GRANTABLE_ROLES.has(normalizedRole(user)) && normalizedRole(user) !== 'user' && !isProtectedSuperAdminUser(user))
		.map(publicManagedUser)
		.sort((a, b) => {
			if (a.isSuperAdmin !== b.isSuperAdmin) return a.isSuperAdmin ? -1 : 1
			return String(b.roleGrantedAt || b.createdAt || '').localeCompare(String(a.roleGrantedAt || a.createdAt || ''))
		})
}

function franchiseReportUsersList() {
	const users = Array.isArray(store.state().users) ? store.state().users : []
	return users
		.filter((user) => user && isFranchiseReportUser(user) && !isProtectedSuperAdminUser(user))
		.map(publicManagedUser)
		.sort((a, b) => String(b.franchiseGrantedAt || b.createdAt || '').localeCompare(String(a.franchiseGrantedAt || a.createdAt || '')))
}

router.get('/api/admin/role-grants', authRequired, (req, res) => {
	try {
		if (actorRole(req) !== 'admin') return fail(res, 3003, '仅管理员可访问此功能', null, 403)
		const currentAdmin = currentAuthUser(req) || {}
		const canManageAdmins = isSuperAdminUser(currentAdmin)
		return ok(res, {
			currentAdmin: {
				...publicManagedUser(currentAdmin),
				canManageAdmins
			},
			list: canManageAdmins ? managedUsersList() : []
		})
	} catch (e) {
		logger.error({ err: e }, 'business/admin/role-grants list failed')
		return fail(res, 5000, '获取权限备案失败')
	}
})

router.post('/api/admin/role-grant', authRequired, (req, res) => {
	const body = req.body || {}
	const phone = String(firstNonEmpty(body.phone, body.mobile)).trim()
	const role = String(firstNonEmpty(body.role, 'admin')).trim().toLowerCase()
	const nickname = String(firstNonEmpty(body.nickname, body.name, '')).trim().slice(0, 24)
	const institution = String(firstNonEmpty(body.institution, body.bankName, body.company, '')).trim().slice(0, 60)
	try {
		const admin = currentAuthUser(req) || {}
		if (actorRole(req) !== 'admin' || !isSuperAdminUser(admin)) return fail(res, 3003, '仅总管理员可备案账号权限', null, 403)
		if (!isValidGrantPhone(phone)) return fail(res, 1001, '手机号格式不正确')
		if (!GRANTABLE_ROLES.has(role)) return fail(res, 1001, '角色仅支持 admin/service/advisor/publisher/monitor/user')
		const s = store.state()
		if (!Array.isArray(s.users)) s.users = []
		let user = store.findUserByPhone(phone)
		if (user && isProtectedSuperAdminUser(user)) return fail(res, 3003, '最高权限账号不允许通过后台变更', null, 403)
		const advisorInstitution = role === 'advisor'
			? firstValidInstitution(institution, user && user.institution, user && user.bankName, user && user.company)
			: ''
		if (role === 'advisor' && !normalizedInstitution(advisorInstitution)) {
			return fail(res, 1001, '银行老师必须关联机构')
		}
		const now = nowIso()
		if (!user) {
			user = {
				id: `u_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
				phone,
				nickname: nickname || defaultNicknameForRole(role, phone),
				createdAt: now
			}
			s.users.push(user)
		}
		user.phone = phone
		user.nickname = nickname || user.nickname || defaultNicknameForRole(role, phone)
		user.role = role
		user.institution = role === 'advisor' ? advisorInstitution : (institution || user.institution || '')
		user.bankName = role === 'advisor' ? advisorInstitution : (user.bankName || '')
		if (role === 'admin') {
			user.adminLevel = SUPER_ADMIN_PHONES.has(phone) || SUPER_ADMIN_UIDS.has(user.id) ? 'super' : 'regular'
		} else {
			delete user.adminLevel
			delete user.isSuperAdmin
		}
		user.roleGrantedBy = admin.id || req.user.uid
		user.roleGrantedByName = firstNonEmpty(admin.nickname, admin.phone, '总管理员')
		user.roleGrantedAt = now
		user.updatedAt = now
		store.persistSync()
		return ok(res, { ok: true, user: publicManagedUser(user), list: managedUsersList() })
	} catch (e) {
		logger.error({ err: e }, 'business/admin/role-grant failed')
		return fail(res, 5000, '保存权限备案失败')
	}
})

router.get('/api/admin/franchise-report-grants', authRequired, (req, res) => {
	try {
		if (actorRole(req) !== 'admin') return fail(res, 3003, '仅管理员可访问此功能', null, 403)
		const currentAdmin = currentAuthUser(req) || {}
		const canManageAdmins = isSuperAdminUser(currentAdmin)
		return ok(res, {
			currentAdmin: {
				...publicManagedUser(currentAdmin),
				canManageAdmins
			},
			list: canManageAdmins ? franchiseReportUsersList() : []
		})
	} catch (e) {
		logger.error({ err: e }, 'business/admin/franchise-report-grants list failed')
		return fail(res, 5000, '获取加盟商权限失败')
	}
})

router.post('/api/admin/franchise-report-grant', authRequired, (req, res) => {
	const body = req.body || {}
	const phone = String(firstNonEmpty(body.phone, body.mobile)).trim()
	const nickname = String(firstNonEmpty(body.nickname, body.name, '')).trim().slice(0, 24)
	const institution = String(firstNonEmpty(body.institution, body.company, body.bankName, '')).trim().slice(0, 60)
	try {
		const admin = currentAuthUser(req) || {}
		if (actorRole(req) !== 'admin' || !isSuperAdminUser(admin)) return fail(res, 3003, '仅总管理员可备案加盟商权限', null, 403)
		if (!isValidGrantPhone(phone)) return fail(res, 1001, '手机号格式不正确')
		const s = store.state()
		if (!Array.isArray(s.users)) s.users = []
		let user = store.findUserByPhone(phone)
		if (user && isProtectedSuperAdminUser(user)) return fail(res, 3003, '最高权限账号不允许通过后台变更', null, 403)
		const now = nowIso()
		if (!user) {
			user = {
				id: `u_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
				phone,
				role: 'user',
				nickname: nickname || `加盟商${String(phone).slice(-4)}`,
				createdAt: now
			}
			s.users.push(user)
		}
		user.phone = phone
		user.nickname = nickname || user.nickname || `加盟商${String(phone).slice(-4)}`
		user.institution = institution || user.institution || ''
		user.reportUploadUnlimited = true
		user.franchiseReportUnlimited = true
		user.franchiseGrantedBy = admin.id || req.user.uid
		user.franchiseGrantedByName = firstNonEmpty(admin.nickname, admin.phone, '总管理员')
		user.franchiseGrantedAt = now
		user.updatedAt = now
		store.persistSync()
		return ok(res, { ok: true, user: publicManagedUser(user), list: franchiseReportUsersList() })
	} catch (e) {
		logger.error({ err: e }, 'business/admin/franchise-report-grant failed')
		return fail(res, 5000, '保存加盟商权限失败')
	}
})

router.delete('/api/admin/franchise-report-grant', authRequired, (req, res) => {
	const body = req.body || {}
	const phone = String(firstNonEmpty(body.phone, body.mobile, req.query && req.query.phone)).trim()
	try {
		const admin = currentAuthUser(req) || {}
		if (actorRole(req) !== 'admin' || !isSuperAdminUser(admin)) return fail(res, 3003, '仅总管理员可撤回加盟商权限', null, 403)
		if (!isValidGrantPhone(phone)) return fail(res, 1001, '手机号格式不正确')
		const user = store.findUserByPhone(phone)
		if (!user) return fail(res, 2001, '未找到该手机号备案')
		if (isProtectedSuperAdminUser(user)) return fail(res, 3003, '最高权限账号不允许通过后台撤回', null, 403)
		user.reportUploadUnlimited = false
		user.franchiseReportUnlimited = false
		user.franchiseRevokedBy = admin.id || req.user.uid
		user.franchiseRevokedAt = nowIso()
		user.updatedAt = user.franchiseRevokedAt
		store.persistSync()
		return ok(res, { ok: true, user: publicManagedUser(user), list: franchiseReportUsersList() })
	} catch (e) {
		logger.error({ err: e }, 'business/admin/franchise-report-grant revoke failed')
		return fail(res, 5000, '撤回加盟商权限失败')
	}
})

router.delete('/api/admin/role-grant', authRequired, (req, res) => {
	const body = req.body || {}
	const phone = String(firstNonEmpty(body.phone, body.mobile, req.query && req.query.phone)).trim()
	try {
		const admin = currentAuthUser(req) || {}
		if (actorRole(req) !== 'admin' || !isSuperAdminUser(admin)) return fail(res, 3003, '仅总管理员可撤回账号权限', null, 403)
		if (!isValidGrantPhone(phone)) return fail(res, 1001, '手机号格式不正确')
		const user = store.findUserByPhone(phone)
		if (!user) return fail(res, 2001, '未找到该手机号备案')
		if (isProtectedSuperAdminUser(user)) return fail(res, 3003, '最高权限账号不允许通过后台撤回', null, 403)
		user.role = 'user'
		user.adminLevel = ''
		user.roleRevokedBy = admin.id || req.user.uid
		user.roleRevokedAt = nowIso()
		user.updatedAt = user.roleRevokedAt
		store.persistSync()
		return ok(res, { ok: true, user: publicManagedUser(user), list: managedUsersList() })
	} catch (e) {
		logger.error({ err: e }, 'business/admin/role-grant revoke failed')
		return fail(res, 5000, '撤回权限失败')
	}
})

router.get('/api/admin/overview', authRequired, (req, res) => {
	try {
		if (actorRole(req) !== 'admin') return fail(res, 3003, '仅管理员可访问此功能', null, 403)
		const s = store.state()
		const reports = Array.isArray(s.reports) ? s.reports : []
		const users = Array.isArray(s.users) ? s.users : []
		const supplementMaterials = Array.isArray(s.supplementMaterials) ? s.supplementMaterials : []
		const currentAdmin = currentAuthUser(req) || {}
		const conversations = ensureArray('advisorContacts')
			.map((item) => decorateContactForRead(item, req))
			.sort((a, b) => String(b.updateTime || b.createdAt || '').localeCompare(String(a.updateTime || a.createdAt || '')))
		const materials = dedupeAdminMaterials([
			...conversations.flatMap(materialItemsForAdmin),
			...supplementMaterialItemsForAdmin(supplementMaterials, users)
		])
		const messageCount = conversations.reduce((sum, item) => sum + (Array.isArray(item.messages) ? item.messages.length : 0), 0)
		const activeGroups = conversations.filter((item) => item.groupMode === 'service-bank-customer' || item.serviceRequired === true).length
		const feedbackCount = conversations.reduce((sum, item) => sum + (Array.isArray(item.serviceFeedbacks) ? item.serviceFeedbacks.length : 0), 0)
		const completedOrders = conversations.filter((item) => item.status === 'completed' || item.orderStatus === 'completed').length
		const closedChats = conversations.filter((item) => item.customerChatClosed === true).length
		const customerDocuments = buildCustomerDocuments(conversations, materials, reports, users)
		const franchiseReportUsers = franchiseReportUsersList()
		return ok(res, {
			stats: {
				users: users.length,
				reports: reports.length,
				conversations: conversations.length,
				materials: materials.length,
				messages: messageCount,
				activeGroups,
				feedbacks: feedbackCount,
				completedOrders,
				closedChats,
				customerDocuments: customerDocuments.length,
				franchiseReportUsers: franchiseReportUsers.length
			},
			conversations,
			materials,
			customerDocuments,
			franchiseReportUsers,
			currentAdmin: {
				...publicManagedUser(currentAdmin),
				canManageAdmins: isSuperAdminUser(currentAdmin)
			},
			source: 'admin-overview'
		})
	} catch (e) {
		logger.error({ err: e }, 'business/admin/overview failed')
		return fail(res, 5000, '获取管理员总览失败')
	}
})

router.get('/api/advisor/contact/:contactId/messages', authRequired, (req, res) => {
	try {
		const item = findAdvisorContact(req, req.params.contactId, { allowStaff: true })
		if (!item) return fail(res, 2001, 'contact not found')
		const role = actorRole(req)
		if (role === 'user' && item.userId !== req.user.uid) return fail(res, 3003, '无权读取该会话', null, 403)
		if (role === 'advisor' && !advisorCanReadContact(req, item)) return fail(res, 3003, '需客服确认邀请后才能查看聊天记录', null, 403)
		if (role !== 'user' && role !== 'advisor' && !canStaffReadContact(req, item)) return fail(res, 3003, '无权读取该会话', null, 403)
		const messages = Array.isArray(item.messages) ? item.messages : []
		const visibleMessages = visibleMessagesForActor(req, item, messages)
			.slice()
			.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
		const readState = markContactReadForActor(req, item)
		store.persist()
		return ok(res, {
			contact: decorateContactForRead(item, req),
			messages: decorateMessagesForActor(req, item, visibleMessages),
			unreadCount: unreadCountForActor(req, item, visibleMessages),
			readState
		})
	} catch (e) {
		logger.error({ err: e }, 'business/advisor/contact/messages failed')
		return fail(res, 5000, '获取会话消息失败')
	}
})

router.post('/api/advisor/contact/read', authRequired, (req, res) => {
	const body = req.body || {}
	const contactId = cleanId(firstNonEmpty(body.contactId, body.statusId, body.id))
	if (!contactId) return fail(res, 1001, 'contactId is required')
	try {
		const item = findAdvisorContact(req, contactId, { allowStaff: true })
		if (!item) return fail(res, 2001, 'contact not found')
		const role = actorRole(req)
		if (role === 'user' && item.userId !== req.user.uid) return fail(res, 3003, '无权读取该会话', null, 403)
		if (role === 'advisor' && !advisorCanReadContact(req, item)) return fail(res, 3003, '需客服确认邀请后才能查看聊天记录', null, 403)
		if (role !== 'user' && !canStaffReadContact(req, item)) return fail(res, 3003, '无权读取该会话', null, 403)
		const readState = markContactReadForActor(req, item)
		store.persist()
		return ok(res, { ok: true, contactId: contactIdOf(item), unreadCount: 0, readState, contact: decorateContactForRead(item, req) })
	} catch (e) {
		logger.error({ err: e }, 'business/advisor/contact/read failed')
		return fail(res, 5000, '标记已读失败')
	}
})

router.post('/api/advisor/contact/clear-view', authRequired, (req, res) => {
	const body = req.body || {}
	const contactId = cleanId(firstNonEmpty(body.contactId, body.statusId, body.id))
	if (!contactId) return fail(res, 1001, 'contactId is required')
	try {
		const item = findAdvisorContact(req, contactId, { allowStaff: true })
		if (!item) return fail(res, 2001, 'contact not found')
		if (!canClearContactView(req, item)) return fail(res, 3003, '无权清空该会话窗口', null, 403)
		const clearedAt = nowIso()
		const role = actorRole(req)
		const clearSequence = nextContactEventSequence(item)
		const clearRecord = {
			id: makeId('clear'),
			contactId: contactIdOf(item),
			userId: item.userId,
			actorId: req.user.uid,
			actorRole: role,
			actorName: actorDisplayName(req, role === 'user' ? '客户' : role === 'advisor' ? '银行老师' : '客服'),
			clearedAt,
			createdAt: clearedAt,
			clearSequence,
			sequence: clearSequence,
			reopenedByCustomer: false,
			reopenedAt: '',
			reopenedMessageId: ''
		}
		if (!Array.isArray(item.chatClears)) item.chatClears = []
		item.chatClears.push(clearRecord)
		markContactReadForActor(req, item, clearedAt)
		store.persistSync()
		return ok(res, {
			ok: true,
			contactId: contactIdOf(item),
			clearRecord,
			reopenedByCustomer: false,
			messages: [],
			contact: decorateContactForRead(item, req)
		})
	} catch (e) {
		logger.error({ err: e }, 'business/advisor/contact/clear-view failed')
		return fail(res, 5000, '清空聊天窗口失败')
	}
})

router.post('/api/advisor/contact/claim', authRequired, (req, res) => {
	const body = req.body || {}
	const contactId = cleanId(firstNonEmpty(body.contactId, body.statusId, body.id))
	if (!contactId) return fail(res, 1001, 'contactId is required')
	try {
		const item = findAdvisorContact(req, contactId, { allowStaff: true })
		if (!item) return fail(res, 2001, 'contact not found')
		const role = actorRole(req) === 'admin' && body.role ? String(body.role).trim().toLowerCase() : actorRole(req)
		if (!['advisor', 'service'].includes(role)) return fail(res, 3003, '当前账号不能接单', null, 403)
		if (role === 'advisor' && !advisorCanSeeContactLead(req, item)) return fail(res, 3003, '只能接入本机构匹配客户', null, 403)
		if (role === 'advisor' && isBankServiceGroup(item) && !advisorCanReadContact(req, item)) return fail(res, 3003, '需客服确认邀请后才能接单', null, 403)
		if (role === 'service' && !serviceCanSeeContactLead(req, item)) return fail(res, 3003, '客服无权接入该会话', null, 403)
		if (role === 'service' && contactChannelOf(item) === 'bank' && !isBankServiceGroup(item)) return fail(res, 3003, '该会话不需要客服接单', null, 403)
		if (role === 'advisor' && item.advisorAssigneeId && String(item.advisorAssigneeId) !== String(req.user.uid)) return fail(res, 3003, '该客户已由其他银行经理接单', null, 403)
		if (role === 'service' && item.serviceAssigneeId && String(item.serviceAssigneeId) !== String(req.user.uid)) return fail(res, 3003, '该客户已由其他客服接单', null, 403)
		const user = currentAuthUser(req) || {}
		const assigneeName = actorDisplayName(req, role === 'advisor' ? '银行客户经理' : '客服')
		const claimedAt = nowIso()
		if (role === 'advisor') {
			item.advisorStatus = 'assigned'
			item.advisorAssigneeId = req.user.uid
			item.advisorAssigneeName = assigneeName
			item.advisorAssignedAt = claimedAt
		} else {
			item.serviceStatus = 'assigned'
			item.serviceAssigneeId = req.user.uid
			item.serviceAssigneeName = assigneeName
			item.serviceAssignedAt = claimedAt
		}
		if (!Array.isArray(item.messages)) item.messages = []
		const messageSequence = nextContactEventSequence(item)
		const message = {
			id: makeId('cm'),
			contactId: contactIdOf(item),
			userId: item.userId,
			channel: contactChannelOf(item),
			senderType: 'system',
			senderRole: 'system',
			senderId: 'system',
			senderName: '系统',
			content: role === 'advisor' ? `${assigneeName}已接入本机构客户咨询。` : `${assigneeName}已接单，可查看授权资料并协助沟通。`,
			createdAt: claimedAt,
			eventType: `${role}-claimed`,
			...(role === 'advisor' ? { advisorId: req.user.uid } : { serviceId: req.user.uid }),
			assigneeId: req.user.uid,
			claimedAt,
			messageSequence,
			sequence: messageSequence
		}
		item.messages.push(message)
		item.status = item.status === 'pending' ? 'processing' : item.status
		item.orderStatus = 'assigned'
		item.orderAssignedAt = item.orderAssignedAt || claimedAt
		item.updateTime = claimedAt
		item.updatedAt = claimedAt
		store.persist()
		return ok(res, { ok: true, contactId: contactIdOf(item), contact: decorateContactForRead(item, req), message })
	} catch (e) {
		logger.error({ err: e }, 'business/advisor/contact/claim failed')
		return fail(res, 5000, '接单失败')
	}
})

router.post('/api/advisor/contact/invite-advisor', authRequired, (req, res) => {
	const body = req.body || {}
	const contactId = cleanId(firstNonEmpty(body.contactId, body.statusId, body.id))
	const advisorId = cleanId(firstNonEmpty(body.advisorId, body.teacherId, body.uid))
	const requestedInstitution = firstNonEmpty(body.institution, body.bankName, body.company)
	const note = String(firstNonEmpty(body.note, body.remark, '')).trim()
	if (!contactId) return fail(res, 1001, 'contactId is required')
	if (note.length > 300) return fail(res, 1001, '邀请说明不超过 300 字')
	try {
		const role = actorRole(req)
		if (!['service', 'admin'].includes(role)) return fail(res, 3003, '仅客服可邀请银行老师', null, 403)
		const item = findAdvisorContact(req, contactId, { allowStaff: true })
		if (!item) return fail(res, 2001, 'contact not found')
		if (role === 'service' && !staffCanReplyContact(req, item)) return fail(res, 3003, '请先接单后再邀请银行老师', null, 403)
		if (item.advisorAssigneeId) return fail(res, 3003, `该会话已由${item.advisorAssigneeName || '银行老师'}接入`, null, 403)
		if (!advisorId) return fail(res, 1001, '请选择银行老师')
		const candidates = advisorCandidates()
		const target = candidates.find((user) => cleanId(user.uid) === advisorId || cleanId(user.id) === advisorId)
		if (!target) return fail(res, 2001, '银行老师不存在或未关联机构')
		const contactInstitution = contactInstitutionOf(item)
		if (contactInstitution && !institutionTextMatches(target.institution, contactInstitution)) {
			return fail(res, 3003, '只能邀请该联系记录所属机构的银行老师', null, 403)
		}
		const institution = contactInstitution || target.institution
		if (requestedInstitution && !institutionTextMatches(requestedInstitution, institution)) {
			return fail(res, 1001, '邀请机构与联系记录所属机构不一致')
		}
		const invitedAt = nowIso()
		const inviterName = actorDisplayName(req, '客服')
		const inviteRecord = {
			id: makeId('invite'),
			contactId: contactIdOf(item),
			userId: item.userId,
			advisorId: target ? target.uid : advisorId,
			advisorName: target ? target.name : '',
			institution,
			invitedById: req.user.uid,
			invitedByRole: role,
			invitedByName: inviterName,
			note,
			createdAt: invitedAt
		}
		item.channel = 'bank'
		item.deskType = 'bank'
		item.contactType = item.contactType === 'customer-service' ? 'match-product' : item.contactType
		item.groupMode = 'service-bank-customer'
		item.serviceRequired = true
		item.serviceStatus = item.serviceStatus || 'assigned'
		item.advisorStatus = 'invited'
		if (!contactInstitution) item.institution = institution
		item.invitedAdvisorId = inviteRecord.advisorId
		item.invitedAdvisorName = inviteRecord.advisorName
		item.invitedAdvisorInstitution = institution
		item.advisorInvitedAt = invitedAt
		if (!Array.isArray(item.advisorInviteRecords)) item.advisorInviteRecords = []
		item.advisorInviteRecords.unshift(inviteRecord)
		const label = inviteRecord.advisorName ? `${institution}${inviteRecord.advisorName}` : `${institution}银行老师`
		const systemMessage = appendSystemContactMessage(item, `${inviterName}已邀请${label}进入群聊。${note ? `说明：${note}` : ''}`, {
			eventType: 'advisor-invited',
			inviteId: inviteRecord.id
		})
		if (inviteRecord.advisorId) {
			addMessage(inviteRecord.advisorId, {
				type: 'product',
				title: '客服邀请你进入群聊',
				desc: `${firstNonEmpty(item.clientName, item.name, '客户')}正在咨询${firstNonEmpty(item.productName, '匹配方案')}`,
				linkType: 'page',
				url: `/pages/chat/conversation?contactId=${encodeURIComponent(contactIdOf(item))}`,
				actionUrl: `/pages/chat/conversation?contactId=${encodeURIComponent(contactIdOf(item))}`,
				action: '进入群聊',
				contactId: contactIdOf(item)
			})
		}
		store.persist()
		return ok(res, {
			ok: true,
			contactId: contactIdOf(item),
			invite: publicStaffInvite(inviteRecord),
			message: publicStaffMessage(systemMessage),
			contact: decorateContactForRead(item, req)
		})
	} catch (e) {
		logger.error({ err: e }, 'business/advisor/contact/invite-advisor failed')
		return fail(res, 5000, '邀请银行老师失败')
	}
})

router.post('/api/advisor/contact/rename', authRequired, (req, res) => {
	const body = req.body || {}
	const contactId = cleanId(firstNonEmpty(body.contactId, body.statusId, body.id))
	const groupName = String(firstNonEmpty(body.groupName, body.name, body.title, '')).replace(/\s+/g, ' ').trim()
	if (!contactId) return fail(res, 1001, 'contactId is required')
	if (groupName.length < 2 || groupName.length > 30) return fail(res, 1001, '群名称需为 2-30 个字')
	try {
		const role = actorRole(req)
		if (!['service', 'advisor', 'admin'].includes(role)) return fail(res, 3003, '仅客服或银行老师可修改群名称', null, 403)
		const item = findAdvisorContact(req, contactId, { allowStaff: true })
		if (!item) return fail(res, 2001, 'contact not found')
		if (!isBankServiceGroup(item)) return fail(res, 3003, '仅三方群聊可修改群名称', null, 403)
		if (role !== 'admin' && !staffCanReplyContact(req, item)) return fail(res, 3003, '请先接单后再修改群名称', null, 403)
		const previousGroupName = firstNonEmpty(item.groupName, item.groupTitle, item.displayTitle)
		item.groupName = groupName
		item.groupTitle = groupName
		item.displayTitle = groupName
		const actorName = actorDisplayName(req, role === 'advisor' ? '银行老师' : role === 'service' ? '客服' : '管理员')
		const message = appendSystemContactMessage(item, `${actorName}将群名称修改为「${groupName}」。`, {
			eventType: 'group-renamed',
			previousGroupName,
			groupName
		})
		store.persist()
		return ok(res, { ok: true, contactId: contactIdOf(item), groupName, previousGroupName, message, contact: decorateContactForRead(item, req) })
	} catch (e) {
		logger.error({ err: e }, 'business/advisor/contact/rename failed')
		return fail(res, 5000, '修改群名称失败')
	}
})

router.post('/api/advisor/contact/message', authRequired, (req, res) => {
	const body = req.body || {}
	const contactId = cleanId(firstNonEmpty(body.contactId, body.statusId, body.id))
	const content = String(firstNonEmpty(body.content, body.text, body.message, '')).trim()
	if (!contactId) return fail(res, 1001, 'contactId is required')
	if (!content) return fail(res, 1001, '消息内容不能为空')
	if (content.length > 1000) return fail(res, 1001, '消息内容不超过 1000 字')
	try {
		const item = findAdvisorContact(req, contactId, { allowStaff: true })
		if (!item) return fail(res, 2001, 'contact not found')
			const role = actorRole(req)
			if (role === 'user' && item.userId !== req.user.uid) return fail(res, 3003, '无权回复该会话', null, 403)
			if (role === 'user' && item.customerChatClosed === true) return fail(res, 3003, '客户已结束该会话', null, 403)
			if (role !== 'user' && !canStaffReadContact(req, item)) return fail(res, 3003, '无权回复该会话', null, 403)
			if (role !== 'user' && !staffCanReplyContact(req, item)) return fail(res, 3003, '请先接单后再回复该会话', null, 403)
		if (!Array.isArray(item.messages)) item.messages = []
		const message = normalizeConversationMessage({ ...body, content }, req, item, { senderRole: role })
		item.messages.push(message)
		const reopenedClearRecords = markCustomerReopenRecords(item, message)
		markContactReadForActor(req, item, message.createdAt)
		item.status = item.status === 'pending' ? 'processing' : item.status
		item.updateTime = nowIso()
		item.updatedAt = item.updateTime
			if (message.senderType !== 'user') {
				const channel = contactChannelOf(item)
				const title = message.senderType === 'service' ? '客服已回复' : message.senderType === 'admin' ? '管理员已留痕' : '银行客户经理已回复'
				addMessage(item.userId, {
					type: channel === 'service' || message.senderType === 'admin' ? 'system' : 'product',
					title,
				desc: content.slice(0, 80),
				linkType: 'page',
				url: `/pages/chat/conversation?contactId=${encodeURIComponent(contactIdOf(item))}`,
				actionUrl: `/pages/chat/conversation?contactId=${encodeURIComponent(contactIdOf(item))}`,
				action: '查看回复',
				contactId: contactIdOf(item)
			})
		}
		store.persist()
		return ok(res, {
			ok: true,
			message,
			contactId: contactIdOf(item),
			reopenedByCustomer: reopenedClearRecords.length > 0,
			reopenedAt: reopenedClearRecords.length ? message.createdAt : '',
			reopenedClearCount: reopenedClearRecords.length
		})
	} catch (e) {
		logger.error({ err: e }, 'business/advisor/contact/message failed')
		return fail(res, 5000, '发送会话消息失败')
	}
})

router.post('/api/advisor/contact/feedback', authRequired, (req, res) => {
	const body = req.body || {}
	const contactId = cleanId(firstNonEmpty(body.contactId, body.statusId, body.id))
	const rating = Math.max(1, Math.min(5, Math.round(Number(body.rating || body.score || 0))))
	const content = String(firstNonEmpty(body.content, body.comment, body.feedback, '')).trim()
	if (!contactId) return fail(res, 1001, 'contactId is required')
	if (!rating) return fail(res, 1001, 'rating is required')
	if (content.length > 500) return fail(res, 1001, '评价内容不超过 500 字')
	try {
		const item = findAdvisorContact(req, contactId, { allowStaff: true })
		if (!item) return fail(res, 2001, 'contact not found')
		if (actorRole(req) !== 'user' || item.userId !== req.user.uid) return fail(res, 3003, '仅客户本人可评价服务', null, 403)
		const createdAt = nowIso()
		const feedback = {
			id: makeId('fb'),
			contactId: contactIdOf(item),
			userId: item.userId,
			customerName: firstNonEmpty(item.clientName, item.name, '客户'),
			rating,
			score: rating,
			content,
			tags: Array.isArray(body.tags) ? body.tags.slice(0, 8) : [],
			serviceAssigneeId: item.serviceAssigneeId || '',
			serviceAssigneeName: item.serviceAssigneeName || '',
			advisorAssigneeId: item.advisorAssigneeId || '',
			advisorAssigneeName: item.advisorAssigneeName || '',
			channel: contactChannelOf(item),
			createdAt
		}
		if (!Array.isArray(item.serviceFeedbacks)) item.serviceFeedbacks = []
		item.serviceFeedbacks.unshift(feedback)
		item.latestFeedback = feedback
		item.feedbackCount = item.serviceFeedbacks.length
		ensureArray('feedbacks').unshift({ ...feedback, type: 'service-rating', source: 'advisor-contact' })
		appendSystemContactMessage(item, `客户提交服务评价：${rating}分${content ? `，${content}` : ''}`, { eventType: 'service-feedback', feedbackId: feedback.id })
		store.persist()
		return ok(res, { ok: true, contactId: contactIdOf(item), feedback, contact: decorateContactForRead(item, req) })
	} catch (e) {
		logger.error({ err: e }, 'business/advisor/contact/feedback failed')
		return fail(res, 5000, '提交服务评价失败')
	}
})

router.post('/api/advisor/contact/complete', authRequired, (req, res) => {
	const body = req.body || {}
	const contactId = cleanId(firstNonEmpty(body.contactId, body.statusId, body.id))
	const note = String(firstNonEmpty(body.note, body.remark, body.content, '')).trim()
	if (!contactId) return fail(res, 1001, 'contactId is required')
	if (note.length > 500) return fail(res, 1001, '完成说明不超过 500 字')
	try {
		const item = findAdvisorContact(req, contactId, { allowStaff: true })
		if (!item) return fail(res, 2001, 'contact not found')
		if (!canCloseoutContact(req, item)) return fail(res, 3003, '无权完成该订单', null, 403)
		const completedAt = nowIso()
		const role = actorRole(req)
		const completion = {
			id: makeId('done'),
			contactId: contactIdOf(item),
			userId: item.userId,
			completedById: req.user.uid,
			completedByRole: role,
			completedByName: actorDisplayName(req, role === 'user' ? '客户' : '处理人'),
			businessConfirmed: body.businessConfirmed !== false,
			note,
			createdAt: completedAt
		}
		if (!Array.isArray(item.completionRecords)) item.completionRecords = []
		item.completionRecords.unshift(completion)
		item.latestCompletion = completion
		item.completionCount = item.completionRecords.length
		item.status = 'completed'
		item.statusText = '已完成'
		item.orderStatus = 'completed'
		item.completedAt = completedAt
		item.completedById = completion.completedById
		item.completedByRole = completion.completedByRole
		item.completedByName = completion.completedByName
		if (item.serviceAssigneeId) item.serviceCompletedAt = completedAt
		if (item.advisorAssigneeId) item.advisorCompletedAt = completedAt
		const actorText = role === 'user' ? '客户确认愿意办理，订单已完成。' : `${completion.completedByName}标记服务完成。`
		appendSystemContactMessage(item, note ? `${actorText}说明：${note}` : actorText, { eventType: 'service-completed', completionId: completion.id })
		if (role !== 'user') {
			addMessage(item.userId, {
				type: 'system',
				title: '服务已完成',
				desc: note || '本次咨询服务已标记完成',
				linkType: 'page',
				url: `/pages/chat/conversation?contactId=${encodeURIComponent(contactIdOf(item))}`,
				actionUrl: `/pages/chat/conversation?contactId=${encodeURIComponent(contactIdOf(item))}`,
				action: '查看详情',
				contactId: contactIdOf(item)
			})
		}
		store.persist()
		return ok(res, { ok: true, contactId: contactIdOf(item), completion, contact: decorateContactForRead(item, req) })
	} catch (e) {
		logger.error({ err: e }, 'business/advisor/contact/complete failed')
		return fail(res, 5000, '完成订单失败')
	}
})

router.post('/api/advisor/contact/end', authRequired, (req, res) => {
	const body = req.body || {}
	const contactId = cleanId(firstNonEmpty(body.contactId, body.statusId, body.id))
	const reason = String(firstNonEmpty(body.reason, body.note, '')).trim()
	if (!contactId) return fail(res, 1001, 'contactId is required')
	if (reason.length > 300) return fail(res, 1001, '结束说明不超过 300 字')
	try {
		const item = findAdvisorContact(req, contactId)
		if (!item) return fail(res, 2001, 'contact not found')
		if (item.userId !== req.user.uid) return fail(res, 3003, '仅客户本人可结束聊天', null, 403)
		const closedAt = nowIso()
		item.customerChatClosed = true
		item.customerChatClosedAt = closedAt
		item.customerVisibleMessagesCleared = true
		item.chatStatus = 'customer_closed'
		item.orderStatus = item.orderStatus === 'completed' ? item.orderStatus : 'customer_closed'
		appendSystemContactMessage(item, reason ? `客户已结束聊天，原因：${reason}` : '客户已结束聊天。', { eventType: 'customer-chat-ended' })
		store.persist()
		return ok(res, { ok: true, contactId: contactIdOf(item), customerChatClosed: true, contact: decorateContactForRead(item, req) })
	} catch (e) {
		logger.error({ err: e }, 'business/advisor/contact/end failed')
		return fail(res, 5000, '结束聊天失败')
	}
})

const ALLOWED_CONTACT_STATUSES = new Set(['pending', 'processing', 'completed', 'cancelled'])
router.post('/api/advisor/contact/status', authRequired, (req, res) => {
	const { contactId, status } = req.body || {}
	if (status && !ALLOWED_CONTACT_STATUSES.has(status)) return fail(res, 1001, 'status 仅支持 pending/processing/completed/cancelled')
	try {
		const item = findAdvisorContact(req, contactId, { allowStaff: true })
			if (!item) return fail(res, 2001, 'contact not found')
			if (actorRole(req) !== 'user' && !staffCanReplyContact(req, item)) return fail(res, 3003, '请先接单后再更新状态', null, 403)
			item.status = status || item.status
			if (item.status === 'completed') {
				item.orderStatus = 'completed'
				item.completedAt = item.completedAt || nowIso()
			}
		item.updateTime = new Date().toISOString()
		store.persist()
		// 状态变更后通知用户
		const statLabel = { pending: '待处理', processing: '处理中', completed: '已完成', cancelled: '已取消' }
		addMessage(item.userId, {
			type: 'system',
			title: '咨询状态更新',
			desc: '您的咨询请求已更新为"' + (statLabel[item.status] || item.status) + '"',
			linkType: 'modal'
		})
		return ok(res, { ok: true })
	} catch (e) {
		logger.error({ err: e }, 'business/advisor/contact/status failed')
		return fail(res, 5000, '更新联系状态失败')
	}
})

/** 客户备注：为联系记录追加备注。返回完整备注列表。 */
router.post('/api/advisor/contact/notes', authRequired, (req, res) => {
	const { contactId, note = '' } = req.body || {}
	const text = String(note).trim()
	if (!text) return fail(res, 1001, '备注内容不能为空')
	if (text.length > 500) return fail(res, 1001, '备注内容不超过 500 字')
	try {
		const item = findAdvisorContact(req, contactId, { allowStaff: true })
			if (!item) return fail(res, 2001, 'contact not found')
			if (actorRole(req) !== 'user' && !staffCanReplyContact(req, item)) return fail(res, 3003, '请先接单后再添加备注', null, 403)
			if (!Array.isArray(item.notes)) item.notes = []
		item.notes.unshift({
			text,
			createdAt: new Date().toISOString()
		})
		item.updateTime = new Date().toISOString()
		store.persist()
		return ok(res, {
			notes: ['advisor', 'service', 'admin'].includes(actorRole(req))
				? item.notes.map(publicStaffNote)
				: item.notes
		})
	} catch (e) {
		logger.error({ err: e }, 'business/advisor/contact/notes failed')
		return fail(res, 5000, '添加备注失败')
	}
})

// ─── 用户端回写：材料、消息、推送、债务 ─────────────────────

router.post('/api/advisor/contact/material-submit', authRequired, (req, res) => {
	const body = req.body || {}
	const contactId = cleanId(firstNonEmpty(body.contactId, body.statusId, body.sourceId, body.id))
	if (!contactId) return fail(res, 1001, 'contactId is required')
	try {
		const contact = findAdvisorContact(req, contactId)
		if (!contact) return fail(res, 2001, 'contact not found')
		const material = normalizeMaterialPayload(body)
		attachMaterial(contact, material)
		store.persist()
		return ok(res, { ok: true, contactId: contact._id, material })
	} catch (e) {
		logger.error({ err: e }, 'business/advisor/contact/material-submit failed')
		return fail(res, 5000, '材料提交失败')
	}
})

router.post('/api/advisor/contact/material-review', authRequired, (req, res) => {
	const body = req.body || {}
	if (!isStaffActor(req)) return fail(res, 3003, '仅客服或银行老师可复核材料', null, 403)
	const contactId = cleanId(firstNonEmpty(body.contactId, body.statusId, body.sourceId, body.id))
	if (!contactId) return fail(res, 1001, 'contactId is required')
	try {
		const contact = findAdvisorContact(req, contactId, { allowStaff: true })
		if (!contact) return fail(res, 2001, 'contact not found')
		if (!hasMaterialAccess(req, contact)) return fail(res, 3003, '请先接单后再复核材料', null, 403)
		const hasRequestedScope = !!firstNonEmpty(
			body.serverReportId,
			body.reportId,
			body.clientReportId,
			body.sourceReportId,
			body.caseId,
			body.materialScopeId
		)
		if (hasRequestedScope) {
			const requestedScope = debtReportScopeFor(contact.userId, body)
			const contactScope = debtReportScopeFor(contact.userId, contact)
			if (requestedScope.conflict || requestedScope.notFound || !debtReportScopesOverlap(requestedScope, contactScope)) {
				return fail(res, 1001, '复核报告范围与当前工单不一致', { field: 'reportId' }, 409)
			}
		}
		const material = applyMaterialReviewAcrossCase(contact, body)
		if (material.executionRecordId || material.debtId) {
			const records = ensureArray('debtExecutionRecords')
			const reviewScope = debtReportScopeFor(contact.userId, contact)
			const exactCandidates = material.executionRecordId
				? records.filter((record) => (
					record.userId === contact.userId &&
					String(record.id || record.executionRecordId || '') === String(material.executionRecordId)
				))
				: []
			records.forEach((record) => {
				if (record.userId !== contact.userId) return
				const recordScope = debtReportScopeFor(record.userId, record)
				const sameScopedReport = !!reviewScope.reportId && recordScope.reportId === reviewScope.reportId
				const sameLegacyScope = !reviewScope.reportId && !recordScope.reportId &&
					normalizedScopeId(firstNonEmpty(reviewScope.caseId, LEGACY_MATERIAL_CASE_ID)) ===
						normalizedScopeId(firstNonEmpty(recordScope.caseId, LEGACY_MATERIAL_CASE_ID))
				const sameExecutionId = material.executionRecordId && String(record.id || record.executionRecordId || '') === String(material.executionRecordId)
				const sameExecution = sameExecutionId && (
					sameScopedReport ||
					sameLegacyScope ||
					(!recordScope.reportId && !reviewScope.reportId && exactCandidates.length === 1)
				)
				const sameDebt = !material.executionRecordId && (sameScopedReport || sameLegacyScope) &&
					material.debtId && record.debtId && String(record.debtId) === String(material.debtId)
				if (!sameExecution && !sameDebt) return
				record.status = material.status
				record.statusText = material.statusText
				record.reviewNote = material.reviewNote
				record.reviewedAt = material.reviewedAt
				record.updatedAt = nowIso()
			})
		}
		addMessage(contact.userId, {
			type: 'system',
			title: '材料复核结果更新',
			desc: `${material.name || '补充材料'}：${material.statusText || '已复核'}`,
			linkType: 'modal'
		})
		store.persistSync()
		return ok(res, { ok: true, contactId: contact._id, material: publicStaffMaterial(material) })
	} catch (e) {
		logger.error({ err: e }, 'business/advisor/contact/material-review failed')
		return fail(res, 5000, '材料复核失败')
	}
})

router.post('/api/message/action-receipt', authRequired, (req, res) => {
	try {
		const receipt = normalizeMessageReceipt(req.body || {}, req.user.uid)
		const list = ensureArray('messageActionReceipts')
		upsertByKey(list, receipt, (row) => `${row.userId || ''}|${row.id || row.messageId || ''}|${row.stage || ''}`)
		attachReceiptToContacts(req.user.uid, receipt)
		store.persist()
		return ok(res, { ok: true, receipt })
	} catch (e) {
		logger.error({ err: e }, 'business/message/action-receipt failed')
		return fail(res, 5000, '消息回执保存失败')
	}
})

router.post('/api/profile/push-binding', authRequired, (req, res) => {
	try {
		const binding = {
			...stripServerOwnedFields(req.body || {}),
			userId: req.user.uid,
			updatedAt: firstNonEmpty(req.body && req.body.updatedAt, nowIso()),
			source: firstNonEmpty(req.body && req.body.source, 'user-message-center')
		}
		const bindings = ensureObject('pushBindings')
		bindings[req.user.uid] = binding
		ensureArray('advisorContacts').filter((item) => item.userId === req.user.uid).forEach((contact) => {
			contact.pushBinding = binding
			contact.pushBindings = [binding]
			contact.systemPushBinding = binding
			contact.updateTime = nowIso()
		})
		store.persist()
		return ok(res, { ok: true, binding })
	} catch (e) {
		logger.error({ err: e }, 'business/profile/push-binding failed')
		return fail(res, 5000, '推送绑定保存失败')
	}
})

router.post('/api/profile/repayment-sms-consent', authRequired, (req, res) => {
	try {
		const body = req.body || {}
		const consent = {
			...stripServerOwnedFields(body),
			userId: req.user.uid,
			phone: req.user.phone || '',
			enabled: body.enabled === true,
			smsEnabled: body.smsEnabled === true,
			smsConsentAccepted: body.smsConsentAccepted === true,
			day: Math.max(0, Math.min(28, Number(body.day) || 0)),
			smsConsentVersion: firstNonEmpty(body.smsConsentVersion, '2026-07-07'),
			smsConsentAt: firstNonEmpty(body.smsConsentAt, nowIso()),
			source: firstNonEmpty(body.source, 'repayment-reminder'),
			updatedAt: nowIso()
		}
		const list = ensureArray('repaymentSmsConsents')
		upsertByKey(list, consent, (row) => String(row.userId || ''))
		store.persist()
		return ok(res, { ok: true, consent })
	} catch (e) {
		logger.error({ err: e }, 'business/profile/repayment-sms-consent failed')
		return fail(res, 5000, '还款短信授权保存失败')
	}
})

router.get('/api/profile/supplement-materials', authRequired, (req, res) => {
	try {
		const query = req.query || {}
		const hasScopeFilter = !!firstNonEmpty(query.caseId, query.materialScopeId, query.reportId, query.clientReportId, query.sourceReportId)
		const requestedScope = hasScopeFilter ? canonicalCaseFor(req.user.uid, query) : null
		if (requestedScope && requestedScope.conflict) {
			return fail(res, 1001, requestedScope.conflictMessage, { field: 'clientReportId' }, 409)
		}
		let list = byUser(ensureArray('supplementMaterials'), req.user.uid)
		if (requestedScope) {
			list = list.filter((item) => scopeIdsEqual(firstNonEmpty(item.caseId, item.materialScopeId, LEGACY_MATERIAL_CASE_ID), requestedScope.caseId))
		}
		list = list
			.map((item) => stripLocalPathFields({
				...item,
				caseId: firstNonEmpty(item.caseId, item.materialScopeId, LEGACY_MATERIAL_CASE_ID),
				materialScopeId: firstNonEmpty(item.materialScopeId, item.caseId, LEGACY_MATERIAL_CASE_ID)
			}))
			.sort((a, b) => String(b.updatedAt || b.uploadedAt || '').localeCompare(String(a.updatedAt || a.uploadedAt || '')))
		return ok(res, {
			list,
			materials: list,
			total: list.length,
			caseId: requestedScope ? requestedScope.caseId : '',
			reportId: requestedScope ? requestedScope.reportId : '',
			clientReportId: requestedScope ? requestedScope.clientReportId : ''
		})
	} catch (e) {
		logger.error({ err: e }, 'business/profile/supplement-materials failed')
		return fail(res, 5000, '获取补充材料失败')
	}
})

router.post('/api/profile/supplement-material', authRequired, (req, res) => {
	try {
		const body = req.body || {}
		const scope = canonicalCaseFor(req.user.uid, body)
		if (scope.conflict) return fail(res, 1001, scope.conflictMessage, { field: 'clientReportId' }, 409)
		const material = normalizeSupplementMaterialPayload(body, req.user.uid, scope)
		const list = ensureArray('supplementMaterials')
		upsertByKey(list, material, supplementMaterialKey)
		const contacts = ensureArray('advisorContacts')
			.filter((item) => item.userId === req.user.uid)
			.filter((item) => contactCaseMatches(item, scope))
		contacts.forEach((contact) => {
			if (!Array.isArray(contact.supplementMaterials)) contact.supplementMaterials = []
			upsertByKey(contact.supplementMaterials, material, supplementMaterialKey)
			contact.updateTime = nowIso()
			contact.updatedAt = contact.updateTime
		})
		store.persistSync()
		return ok(res, {
			ok: true,
			material: stripLocalPathFields(material),
			id: material.id,
			materialId: material.materialId,
			caseId: scope.caseId,
			reportId: scope.reportId,
			clientReportId: scope.clientReportId,
			syncedContactIds: contacts.map(contactIdOf)
		})
	} catch (e) {
		logger.error({ err: e }, 'business/profile/supplement-material failed')
		return fail(res, 5000, '保存补充材料失败')
	}
})

router.get('/api/profile/debt-execution-records', authRequired, (req, res) => {
	try {
		const q = req.query || {}
		const hasReportFilter = !!firstNonEmpty(q.serverReportId, q.reportId, q.clientReportId, q.sourceReportId, q.caseId, q.materialScopeId)
		const reportScope = hasReportFilter ? debtReportScopeFor(req.user.uid, q) : null
		if (reportScope && reportScope.conflict) {
			return fail(res, 1001, reportScope.conflictMessage, { field: 'reportId' }, 409)
		}
		if (reportScope && debtReportScopeUnavailableToOwner(reportScope)) {
			return fail(res, 2001, '报告不存在或无权访问', { field: 'reportId' }, 404)
		}
		let list = byUser(ensureArray('debtExecutionRecords'), req.user.uid)
			.map((item) => projectDebtExecutionRecordForRead(item, req.user.uid))
			.filter((item) => {
				const itemScope = debtReportScopeFor(req.user.uid, item)
				return !itemScope.report || reportVisibleToOwner(itemScope.report)
			})
		if (reportScope) list = list.filter((item) => String(item.reportId || '') === String(reportScope.reportId || ''))
		if (q.debtId) list = list.filter((item) => String(item.debtId || '') === String(q.debtId))
		list = list.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
		return ok(res, { list, records: list, total: list.length })
	} catch (e) {
		logger.error({ err: e }, 'business/profile/debt-execution-records failed')
		return fail(res, 5000, '获取债务执行记录失败')
	}
})

router.post('/api/profile/debt-execution-record', authRequired, (req, res) => {
	try {
		const body = req.body || {}
		const reportScope = debtReportScopeFor(req.user.uid, body)
		if (reportScope.conflict) {
			return fail(res, 1001, reportScope.conflictMessage, { field: 'reportId' }, 409)
		}
		if (debtReportScopeUnavailableToOwner(reportScope)) {
			return fail(res, 2001, '报告不存在或无权访问', { field: 'reportId' }, 404)
		}
		const record = upsertDebtExecutionRecord(normalizeDebtExecutionRecord(body, req.user.uid, reportScope), reportScope)
		store.persist()
		return ok(res, { ok: true, record, id: record.id, executionRecordId: record.executionRecordId })
	} catch (e) {
		logger.error({ err: e }, 'business/profile/debt-execution-record failed')
		return fail(res, 5000, '保存债务执行记录失败')
	}
})

router.post('/api/profile/debt-execution-records/sync', authRequired, (req, res) => {
	try {
		const body = req.body || {}
		const rawRecords = Array.isArray(body.records) ? body.records : []
		const prepared = rawRecords.map((item, index) => ({
			index,
			item,
			reportScope: debtReportScopeFor(req.user.uid, item)
		}))
		const invalid = prepared.find((entry) => (
			entry.reportScope.conflict || debtReportScopeUnavailableToOwner(entry.reportScope)
		))
		if (invalid) {
			return invalid.reportScope.conflict
				? fail(res, 1001, invalid.reportScope.conflictMessage, { field: 'reportId', index: invalid.index }, 409)
				: fail(res, 2001, '报告不存在或无权访问', { field: 'reportId', index: invalid.index }, 404)
		}
		const records = prepared.map(({ item, reportScope }) => (
			upsertDebtExecutionRecord(normalizeDebtExecutionRecord(item, req.user.uid, reportScope), reportScope)
		))
		store.persist()
		return ok(res, { ok: true, records, success: records.length, failed: 0, total: rawRecords.length })
	} catch (e) {
		logger.error({ err: e }, 'business/profile/debt-execution-records/sync failed')
		return fail(res, 5000, '同步债务执行记录失败')
	}
})
// ─── 负债摘要 ──────────────────────────────────────────────

router.get('/api/profile/debt-summary', authRequired, (req, res) => {
	try {
		// 无筛选时读取最新报告；显式报告编号必须精确解析，不能静默回退。
		const reports = byUser(store.state().reports, req.user.uid).filter(reportVisibleToOwner)
		const q = req.query || {}
		const hasReportFilter = !!firstNonEmpty(q.serverReportId, q.reportId, q.clientReportId, q.sourceReportId, q.caseId, q.materialScopeId)
		const reportScope = hasReportFilter ? debtReportScopeFor(req.user.uid, q) : null
		if (reportScope && reportScope.conflict) {
			return fail(res, 1001, reportScope.conflictMessage, { field: 'reportId' }, 409)
		}
		if (reportScope && debtReportScopeUnavailableToOwner(reportScope)) {
			return fail(res, 2001, '报告不存在或无权访问', { field: 'reportId' }, 404)
		}
		const latest = reportScope ? reportScope.report : reports[0]
		const reportId = String((latest && (latest.id || latest._id || latest.reportId)) || '')
		const clientReportId = String((latest && (latest.clientReportId || latest.sourceReportId)) || '')
		const reportDate = String((latest && (latest.date || latest.createdAt || latest.updatedAt)) || '').slice(0, 10)
		const ad = (latest && (latest.analysisData || latest.analysisResult)) || null
		const cv2Containers = ad ? [
			ad.creditReportV2,
			ad.credit_report_full,
			ad.credit_report_v2,
			ad.cv2
		].filter((value) => value && typeof value === 'object' && !Array.isArray(value)) : []
		const creditDebtSources = ad ? [
			ad.credit_debt,
			ad.creditDebt,
			...cv2Containers.flatMap((cv2) => [cv2.credit_debt, cv2.creditDebt])
		].filter((value) => value && typeof value === 'object' && !Array.isArray(value)) : []
		const dimensionSources = ad ? [
			ad.dimensions,
			ad.report && ad.report.dimensions,
			...cv2Containers.map((cv2) => cv2.dimensions)
		].filter((value) => value && typeof value === 'object' && !Array.isArray(value)) : []
		const aggregateTotalRemaining = [
			...creditDebtSources.flatMap((source) => [
				source.total_debt,
				source.totalDebt,
				source.total_remaining,
				source.totalRemaining,
				source.remaining_amount,
				source.remainingAmount
			]),
			...dimensionSources.flatMap((source) => [
				source.totalDebt,
				source.total_debt,
				source.debtTotal,
				source.debt_total,
				source.totalRemaining,
				source.total_remaining
			])
		]
			.map((value) => Number(value))
			.filter((value) => Number.isFinite(value) && value > 0)[0] || 0
		const accountBalance = (account = {}) => Number(firstNonEmpty(
			account.remainingAmount,
			account.remaining_amount,
			account.balance,
			account.currentBalance,
			account.current_balance,
			account.loanBalance,
			account.loan_balance,
			account.usedLimit,
			account.used_limit,
			account.usedAmount,
			account.used_amount,
			account.used_card_limit,
			account.amount,
			0
		)) || 0
		const accountMonthly = (account = {}) => Number(firstNonEmpty(
			account.monthly_payment,
			account.monthlyPayment,
			account.monthlyPay,
			account.monthly_pay,
			account.monthlyRepayment,
			account.monthly_repayment,
			account.repayAmount,
			account.repay_amount,
			0
		)) || 0
		const accountLimit = (account = {}) => Number(firstNonEmpty(
			account.limit,
			account.creditLimit,
			account.credit_limit,
			account.totalLimit,
			account.total_limit,
			account.loanAmount,
			account.loan_amount,
			account.totalAmount,
			account.total_amount,
			0
		)) || 0
		const accountIsSettled = (account = {}) => (
			account.isSettled === true ||
			account.settled === true ||
			((status) => {
				if (/(?:未|尚未)(?:结清|还清|关闭|销户|销卡|注销)/.test(status)) return false
				return ['paid_off', 'paid-off', 'settled', 'closed', 'written_off'].includes(status) ||
					/结清|已还清|关闭|销户|销卡|注销/.test(status)
			})(String(firstNonEmpty(account.status, account.accountStatus, account.account_status)).trim().toLowerCase())
		)
		const accountIsIncluded = (account = {}) => (
			account.utilizationIncluded !== false && account.utilization_included !== false
		)
		const cv2Sources = cv2Containers.flatMap((cv2) => {
			const loanDetails = cv2.loan_details || cv2.loanDetails || {}
			const cardRows = Array.isArray(cv2.credit_card_details)
				? cv2.credit_card_details
				: Array.isArray(cv2.creditCardDetails) ? cv2.creditCardDetails : []
			const bankLoans = Array.isArray(loanDetails.bank_loans)
				? loanDetails.bank_loans
				: Array.isArray(loanDetails.bankLoans) ? loanDetails.bankLoans : []
			const nonBankLoans = Array.isArray(loanDetails.non_bank_loans)
				? loanDetails.non_bank_loans
				: Array.isArray(loanDetails.nonBankLoans) ? loanDetails.nonBankLoans : []
			const detailAccounts = [
				...cardRows.map((account) => ({
					...account,
					isLoan: false,
					type: firstNonEmpty(account.type, account.accountType, account.account_type, account.cardType, account.card_type, '信用卡')
				})),
				...bankLoans.map((account) => ({ ...account, isLoan: true })),
				...nonBankLoans.map((account) => ({ ...account, isLoan: true }))
			]
			return [
				cv2.accounts,
				cv2.credit_accounts,
				cv2.creditAccounts,
				detailAccounts.length ? detailAccounts : null
			]
		})
		const accountSources = (ad ? [
			ad.accounts,
			ad.creditAccounts,
			ad.credit_accounts,
			ad.report && ad.report.creditAccounts,
			ad.report && ad.report.credit_accounts,
			ad.aiInsight && ad.aiInsight.credit_accounts,
			ad.kimiInsight && ad.kimiInsight.credit_accounts,
			...cv2Sources
		] : [])
			.map((value) => Array.isArray(value)
				? value.filter((account) => account && typeof account === 'object' && Object.keys(account).length > 0)
				: [])
		const accountCompleteness = (account = {}) => {
			let score = 0
			if (accountLimit(account) > 0) score += 16
			if (accountBalance(account) > 0) score += 8
			if (accountMonthly(account) > 0) score += 4
			if (firstNonEmpty(account.endDate, account.end_date, account.dueDate, account.due_date, account.repayDate, account.repay_date)) score += 2
			if (firstNonEmpty(account.overdueDays, account.overdue_days, account.maxOverdueDays, account.max_overdue_days) !== '') score += 1
			if (firstNonEmpty(account.accountId, account.account_id, account.id, account._id)) score += 1
			return score
		}
		const accountIdentity = (account = {}) => cleanId(firstNonEmpty(
			account.accountId,
			account.account_id,
			account.id,
			account._id,
			account.accountNo,
			account.account_no
		))
		const accountSourceSettlementConflict = (left = {}, right = {}) => {
			const leftById = new Map(
				left.accounts
					.map((account) => [accountIdentity(account), account])
					.filter(([id]) => id)
			)
			const directConflict = right.accounts.some((account) => {
				const id = accountIdentity(account)
				if (!id || !leftById.has(id)) return false
				return accountIsSettled(leftById.get(id)) !== accountIsSettled(account)
			})
			if (directConflict) return true
			const leftSettled = left.accounts.filter(accountIsSettled).length
			const rightSettled = right.accounts.filter(accountIsSettled).length
			return leftSettled !== rightSettled
		}
		// 旧报告可能在顶层保留简略账户，同时把额度等完整字段放在 CV2 别名中。
		// 先看实质账户覆盖；同一账户的结清状态冲突时尊重靠前权威来源，其余再按字段完整度择优。
		const rawAccounts = accountSources
			.map((accounts, index) => ({
				accounts,
				index,
				accountCount: accounts.length,
				inclusionMetadataCount: accounts.filter((account) => (
					typeof account.utilizationIncluded === 'boolean' || typeof account.utilization_included === 'boolean'
				)).length,
				limitCount: accounts.filter((account) => accountIsIncluded(account) && accountLimit(account) > 0).length,
				completeness: accounts.reduce((sum, account) => sum + accountCompleteness(account), 0)
			}))
			.filter((source) => source.accounts.length > 0)
			.sort((left, right) => (
				right.accountCount - left.accountCount ||
				(accountSourceSettlementConflict(left, right) ? left.index - right.index : 0) ||
				right.inclusionMetadataCount - left.inclusionMetadataCount ||
				right.limitCount - left.limitCount ||
				right.completeness - left.completeness ||
				left.index - right.index
			))[0]?.accounts || []
		const loanAccounts = rawAccounts
			.map((account, sourceIndex) => ({ account, sourceIndex }))
			.filter(({ account }) => account && accountIsIncluded(account) && !accountIsSettled(account) && accountBalance(account) > 0)
		const accountTotalRemaining = loanAccounts.reduce((sum, item) => sum + accountBalance(item.account), 0)
		// 某些旧版报告只保留账户“外壳”（编号/类型），真实总负债仅在 CV2 聚合字段中。
		// 只有明细出现正余额，或所有明细都明确结清/排除时，才让明细覆盖聚合值。
		const explicitAccountZero = rawAccounts.length > 0 && rawAccounts.every((account) => (
			!accountIsIncluded(account) || accountIsSettled(account)
		))
		const useAccountTotal = accountTotalRemaining > 0 || explicitAccountZero
		const totalRemaining = Math.round(
			useAccountTotal ? accountTotalRemaining : aggregateTotalRemaining
		)
		const totalMonthly = Math.round(
			loanAccounts.reduce((sum, item) => sum + accountMonthly(item.account), 0) ||
			0
		)
		const dtiRatio = totalMonthly > 0 && ad && ad.basic_info && ad.basic_info.monthly_income
			? Math.round((totalMonthly / Math.max(1, Number(ad.basic_info.monthly_income) || 10000)) * 100)
			: null
		const statusIndicatesOverdue = (status) => {
			const remaining = String(status || '')
				.replace(/(?:未|无|从未|从无|没有|不存在|未发生|未出现)(?:任何|过)?逾期/gi, ' ')
				.replace(/逾期(?:记录|情况|账户|月份|月数|次数)?(?:为|共|合计)?\s*(?:0|零|无)(?:个|次|月|笔)?/gi, ' ')
				.replace(/(?:not|never|no)\s+overdue/gi, ' ')
			return /逾期|overdue/i.test(remaining)
		}
		const debts = loanAccounts.map(({ account: a, sourceIndex }) => ({
			id: String(a._id || a.id || a.accountId || a.account_id || '') || `report_${sourceIndex}`,
			accountId: String(a.accountId || a.account_id || a._id || a.id || ''),
			accountNoLast4: a.accountNoLast4 || a.account_no_last4 || '',
			openDate: a.openDate || a.open_date || '',
			endDate: firstNonEmpty(a.endDate, a.end_date, a.dueDate, a.due_date, a.repayDate, a.repay_date),
			sourceIndex,
			bank: firstNonEmpty(a.institution, a.bank, a.orgName, a.org_name, a.bankName, a.bank_name, a.lender),
			debtName: firstNonEmpty(
				a.type,
				a.debtName,
				a.accountType,
				a.account_type,
				a.productName,
				a.cardType,
				a.card_type,
				a.isLoan === false ? '信用卡' : '信贷账户'
			),
			remainingAmount: accountBalance(a),
			monthlyPayment: accountMonthly(a),
			limit: accountLimit(a),
			creditLimit: accountLimit(a),
			isLoan: a.isLoan === false ? false : a.isLoan === true ? true : undefined,
			overdueDays: Number(firstNonEmpty(a.overdueDays, a.overdue_days, a.maxOverdueDays, a.max_overdue_days, 0)) || 0,
			isOverdue: a.isOverdue === true || Number(firstNonEmpty(a.overdueDays, a.overdue_days, a.maxOverdueDays, a.max_overdue_days, 0)) > 0 || statusIndicatesOverdue(a.status),
			status: a.status || 'active',
			progress: a.progress || 0
		}))
		return ok(res, {
			reportId,
			clientReportId,
			reportDate,
			totalRemaining,
			totalMonthly,
			dtiRatio,
			debts,
			reportCount: reports.length
		})
	} catch (e) {
		logger.error({ err: e }, 'business/profile/debt-summary failed')
		return fail(res, 5000, '获取负债摘要失败')
	}
})

// ─── 银行卡 ─────────────────────────────────────────────────

router.get('/api/profile/bank-cards', authRequired, (req, res) => {
	try {
		return ok(res, { list: byUser(store.state().bankCards, req.user.uid) })
	} catch (e) {
		logger.error({ err: e }, 'business/profile/bank-cards failed')
		return fail(res, 5000, '获取银行卡列表失败')
	}
})

router.post('/api/profile/bank-cards/add', authRequired, (req, res) => {
	const cardNumber = String((req.body && req.body.cardNumber) || '').replace(/\s/g, '')
	if (!/^\d{15,19}$/.test(cardNumber)) {
		return fail(res, 1001, 'invalid card number')
	}
	try {
		const item = {
			_id: `b_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
			userId: req.user.uid,
			bankName: req.body.bankName || '银行卡',
			cardType: req.body.cardType || 'debit',
			last4: cardNumber.slice(-4),
			statusText: '已验证',
			statusKey: 'ok'
		}
		store.state().bankCards.unshift(item)
		store.persist()
		return ok(res, { ok: true, cardId: item._id })
	} catch (e) {
		logger.error({ err: e }, 'business/profile/bank-cards/add failed')
		return fail(res, 5000, '添加银行卡失败')
	}
})

router.post('/api/profile/bank-cards/delete', authRequired, (req, res) => {
	const cardId = req.body && req.body.cardId
	try {
		const cards = store.state().bankCards
		const idx = cards.findIndex((x) => x.userId === req.user.uid && x._id === cardId)
		if (idx < 0) return fail(res, 2001, 'card not found')
		cards.splice(idx, 1)
		store.persist()
		return ok(res, { ok: true })
	} catch (e) {
		logger.error({ err: e }, 'business/profile/bank-cards/delete failed')
		return fail(res, 5000, '删除银行卡失败')
	}
})

// ─── 合同 / 反馈 ────────────────────────────────────────────

router.get('/api/profile/contracts', authRequired, (req, res) => {
	try {
		const list = byUser(store.state().contracts, req.user.uid)
		return ok(res, { list })
	} catch (e) {
		logger.error({ err: e }, 'business/profile/contracts failed')
		return fail(res, 5000, '获取合同列表失败')
	}
})

router.post('/api/profile/feedback', authRequired, (req, res) => {
	const { type = 'other', content = '', images = [], contactInfo = '' } = req.body || {}
	if (String(content).trim().length < 10) return fail(res, 1001, 'content too short')
	try {
		store.state().feedbacks.unshift({
			_id: `f_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
			userId: req.user.uid,
			type,
			content,
			images,
			contactInfo,
			createTime: new Date().toISOString()
		})
		store.persist()
		return ok(res, { ok: true })
	} catch (e) {
		logger.error({ err: e }, 'business/profile/feedback failed')
		return fail(res, 5000, '提交反馈失败')
	}
})

// ─── 优化方案 ───────────────────────────────────────────────

router.get('/api/optimize/plans', authRequired, (_req, res) => {
	try {
		return ok(res, { list: store.state().optimizePlans })
	} catch (e) {
		logger.error({ err: e }, 'business/optimize/plans failed')
		return fail(res, 5000, '获取优化方案失败')
	}
})

// ─── 消息 ───────────────────────────────────────────────────

const ALLOWED_MSG_TYPES = new Set(['all', 'analysis', 'product', 'system', 'security'])
router.post('/api/message/list', authRequired, (req, res) => {
	const type = (req.body && req.body.type) || 'all'
	if (!ALLOWED_MSG_TYPES.has(type)) return fail(res, 1001, 'type 仅支持 all/analysis/product/system/security')
	try {
		let list = byUser(store.state().messages, req.user.uid)
		if (!list.length) {
			list = [
				{
					id: 'm1',
					userId: req.user.uid,
					type: 'system',
					title: '欢迎使用分析报告工作台',
					desc: '已接入新后端模板',
					isRead: false,
					dateGroup: '今天',
					timeShort: '刚刚',
					linkType: 'modal'
				}
			]
		}
		if (type !== 'all') list = list.filter((m) => m.type === type)
		return ok(res, { list })
	} catch (e) {
		logger.error({ err: e }, 'business/message/list failed')
		return fail(res, 5000, '获取消息列表失败')
	}
})

router.post('/api/message/read', authRequired, (req, res) => {
	const messageId = req.body && req.body.messageId
	try {
		const msg = store.state().messages.find((m) => m.userId === req.user.uid && m.id === messageId)
		if (msg) {
			msg.isRead = true
			store.persist()
		}
		return ok(res, { ok: true })
	} catch (e) {
		logger.error({ err: e }, 'business/message/read failed')
		return fail(res, 5000, '标记消息失败')
	}
})

router.post('/api/message/read-all', authRequired, (req, res) => {
	try {
		let changed = false
		store.state().messages.forEach((m) => {
			if (m.userId === req.user.uid && !m.isRead) {
				m.isRead = true
				changed = true
			}
		})
		if (changed) store.persist()
		return ok(res, { ok: true })
	} catch (e) {
		logger.error({ err: e }, 'business/message/read-all failed')
		return fail(res, 5000, '全部标记已读失败')
	}
})

/** 底栏角标：与 /api/message/list 默认列表规则一致 */
router.get('/api/message/unread-count', authRequired, (req, res) => {
	try {
		let list = byUser(store.state().messages, req.user.uid)
		if (!list.length) {
			list = [{ id: 'm1', userId: req.user.uid, isRead: false }]
		}
		const count = list.filter((m) => !m.isRead).length
		return ok(res, { count })
	} catch (e) {
		logger.error({ err: e }, 'business/message/unread-count failed')
		return fail(res, 5000, '获取未读计数失败')
	}
})

// ─── 文件上传（multer） ──────────────────────────────────────

router.post('/api/upload', authRequired, (req, res) => {
	upload.single('file')(req, res, (err) => {
		if (err) {
			const tooBig = err.code === 'LIMIT_FILE_SIZE'
			const badType = err.code === 'UNSUPPORTED_FILE_TYPE'
			const msg = tooBig
				? `文件超过 ${BUSINESS_UPLOAD_MAX_MB}MB 上限`
				: badType
					? '不支持的文件类型，仅允许图片或 PDF'
					: '上传失败'
			return fail(res, 1001, msg)
		}
		if (!req.file) return fail(res, 1001, 'file is required')
		try {
			const fileUrl = buildPublicUploadUrl({
				protocol: req.protocol,
				host: req.get('host'),
				filename: req.file.filename,
				uploadBase: req.get('x-public-upload-base')
			})
			return ok(res, { url: fileUrl })
		} catch (e) {
			logger.error({ err: e }, 'business/upload failed')
			return fail(res, 5000, '上传失败')
		}
	})
})

// ─── 通知偏好设置 ──────────────────────────────────────────

router.get('/api/profile/notification-settings', authRequired, (req, res) => {
	try {
		const s = store.state()
		if (!s.notificationSettings) s.notificationSettings = {}
		const settings = s.notificationSettings[req.user.uid] || {
			analysis: true,
			product: true,
			system: true,
			security: true
		}
		return ok(res, settings)
	} catch (e) {
		logger.error({ err: e }, 'business/profile/notification-settings failed')
		return fail(res, 5000, '获取通知设置失败')
	}
})

router.post('/api/profile/notification-settings', authRequired, (req, res) => {
	const body = req.body || {}
	const allowedKeys = ['analysis', 'product', 'system', 'security']
	try {
		const s = store.state()
		if (!s.notificationSettings) s.notificationSettings = {}
		const current = s.notificationSettings[req.user.uid] || {
			analysis: true, product: true, system: true, security: true
		}
		for (const k of allowedKeys) {
			if (typeof body[k] === 'boolean') current[k] = body[k]
		}
		s.notificationSettings[req.user.uid] = current
		store.persist()
		return ok(res, current)
	} catch (e) {
		logger.error({ err: e }, 'business/profile/notification-settings/save failed')
		return fail(res, 5000, '保存通知设置失败')
	}
})

// ─── 授权项列表（配置驱动，后续可按用户状态动态调整） ──

const AUTHORIZATION_ITEMS = [
	{ id: 'credit_report',   title: '征信报告解析',   desc: '上传并深度解析您的个人征信报告',           icon: '📄', required: true,  granted: true },
	{ id: 'identity',        title: '身份信息',       desc: '获取您的姓名、身份证号等基本身份信息',     icon: '🪪', required: true,  granted: true },
	{ id: 'phone',           title: '手机号码',       desc: '用于登录验证、安全通知和客服联系',         icon: '📱', required: true,  granted: true },
	{ id: 'storage',         title: '本地存储',       desc: '在您的设备上缓存征信分析结果以加速访问',   icon: '💾', required: false, granted: true },
	{ id: 'recommend',       title: '个性化推荐',     desc: '基于您的信用画像推荐合适的金融产品',       icon: '🎯', required: false, granted: false },
	{ id: 'share_data',      title: '匿名数据共享',   desc: '脱敏后用于信用评估模型优化（不包含个人身份信息）', icon: '📊', required: false, granted: false },
]

router.get('/api/profile/authorization-items', authRequired, (req, res) => {
	// 后续可从 store 读取用户级别的授权状态覆盖
	return ok(res, { items: AUTHORIZATION_ITEMS })
})

module.exports = router
