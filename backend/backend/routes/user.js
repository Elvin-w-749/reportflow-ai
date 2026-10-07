'use strict'

const logger = require('../utils/logger')
const { isProductionRuntime } = require('../utils/env')

/**
 * 用户体系（手机号 + 密码登录）
 *
 * 前端 services/authService.js 已经在使用以下端点，但旧版后端从未实现，导致登录入口完全跑空。
 * 本路由补全：
 *   POST /api/user/register        手机号 + 密码注册（bcrypt 哈希存储）
 *   POST /api/user/login           手机号 + 密码登录
 *   // (weixin-login endpoint removed — mini-program support dropped)
 *   POST /api/user/logout          客户端清理，服务端 ack（无状态 JWT 无需服务端撤销表，需要黑名单可后续接 Redis）
 *   POST /api/user/refresh-token   带旧 token 刷新（仅延长当前 JWT 的 exp，不发新身份）
 *   GET  /api/user/current         读取当前用户（authRequired）
 *
 * 所有响应均沿用 utils/response.ok/fail 的 { code, msg, data } 包络，与 services/apiClient.js 对齐。
 */

const express = require('express')
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const { ok, fail } = require('../utils/response')
const { authRequired, resolveJwtSecret } = require('../middlewares/auth')
const { normalizedRole } = require('../middlewares/roles')
const store = require('../db/store')
const { sendSms } = require('../services/smsProvider')
const { addMessage } = require('../services/messageService')
const { buildAnalysisScopeHmac } = require('../services/analysisIdentity')
const analysisTaskService = require('../services/analysisTaskService')
const { maskPhone } = require('../utils/mask')

const router = express.Router()

const TOKEN_TTL_SEC = Number(process.env.JWT_TTL_SEC || 7 * 24 * 3600)
const SUPER_ADMIN_PHONES = new Set(String(process.env.SUPER_ADMIN_PHONES || '').split(',').map((item) => item.trim()).filter(Boolean))
const SUPER_ADMIN_UIDS = new Set(String(process.env.SUPER_ADMIN_UIDS || '').split(',').map((item) => item.trim()).filter(Boolean))
const SUPER_ADMIN_USERNAMES = new Set(String(process.env.SUPER_ADMIN_USERNAMES || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))
// 本地演示身份表。号段为人为编造、未分配的占位号码，仓库里不存在、也不应存在任何真实号码；
// 机构字段是与样例产品库同源的合成名称，不指代任何真实机构。
// 仅用于本地/隔离环境免注册跑通角色流程，不代表任何真实用户。
const FIXED_TEST_ACCOUNTS = Object.freeze({
	19600000001: { role: 'user', nickname: '客户测试号', institution: '' },
	19600000002: { role: 'advisor', nickname: '示例银行A经理测试号', institution: '示例银行A' },
	19600000003: { role: 'service', nickname: '客服测试号', institution: '平台客服中心' },
	19600000004: { role: 'admin', nickname: '管理员测试号', institution: '平台管理后台', adminLevel: 'regular' },
	19600000005: { role: 'advisor', nickname: '示例银行B经理测试号', institution: '示例银行B' },
	19600000006: { role: 'advisor', nickname: '示例惠想消费金融经理测试号', institution: '示例惠想消费金融' },
	19600000007: { role: 'publisher', nickname: '内容运营测试号', institution: '平台内容运营' }
})
// 固定测试账号默认只服务本地/测试环境。隔离部署可显式开启；最新生产环境不设置该变量，
// 因此同号账号仍只会按普通用户处理，避免公开注册接口直接提权。
const FIXED_TEST_ACCOUNTS_ENABLED = !isProductionRuntime() || /^(1|true|yes|on)$/i.test(
	String(process.env.ENABLE_FIXED_TEST_ACCOUNTS || '').trim()
)
const USER_ID_GENERATION_MAX_ATTEMPTS = 8

/**
 * 为普通新用户生成不可预测、与手机号解耦且在当前用户库中唯一的永久 UID。
 * 固定测试账号继续走 buildFixedTestUser，不迁移任何存量 UID。
 */
function generateUniqueUserId() {
	for (let attempt = 0; attempt < USER_ID_GENERATION_MAX_ATTEMPTS; attempt++) {
		const candidate = `usr_${crypto.randomUUID().replace(/-/g, '').toLowerCase()}`
		if (!store.findUserById(candidate)) return candidate
	}
	throw new Error(`生成唯一用户标识失败（已重试 ${USER_ID_GENERATION_MAX_ATTEMPTS} 次）`)
}

function tokenVersionOf(user) {
	return Number(user && user.tokenVersion || 0)
}

function bumpTokenVersion(user) {
	user.tokenVersion = tokenVersionOf(user) + 1
	user.tokenInvalidatedAt = new Date().toISOString()
}

function signToken(user) {
	const payload = { uid: user.id, phone: user.phone || '', tokenVersion: tokenVersionOf(user) }
	const token = jwt.sign(payload, resolveJwtSecret(), { expiresIn: TOKEN_TTL_SEC })
	return { token, tokenExpired: Date.now() + TOKEN_TTL_SEC * 1000 }
}

function fixedTestAccountProfile(phone) {
	if (!FIXED_TEST_ACCOUNTS_ENABLED) return null
	return FIXED_TEST_ACCOUNTS[String(phone || '').trim()] || null
}

function applyFixedTestAccountProfile(user, opts = {}) {
	if (!user || !user.phone) return false
	const profile = fixedTestAccountProfile(user.phone)
	if (!profile) return false
	let changed = false
	const patch = (key, value) => {
		if (value === undefined) return
		if (user[key] !== value) {
			user[key] = value
			changed = true
		}
	}
	patch('role', profile.role)
	patch('nickname', profile.nickname)
	patch('institution', profile.institution)
	patch('reportUploadUnlimited', true)
	patch('franchiseReportUnlimited', true)
	if (profile.role === 'advisor') patch('bankName', profile.institution)
	if (profile.adminLevel) patch('adminLevel', profile.adminLevel)
	else if (user.adminLevel && profile.role !== 'admin') {
		delete user.adminLevel
		changed = true
	}
	if (opts.markUpdated && changed) user.updatedAt = new Date().toISOString()
	return changed
}

function buildFixedTestUser(phone, passwordHash, nickname = '') {
	const profile = fixedTestAccountProfile(phone) || {}
	const user = {
		id: `u_${phone}`,
		phone,
		passwordHash,
		nickname: nickname || profile.nickname || `用户${String(phone).slice(-4)}`,
		role: profile.role || 'user',
		institution: profile.institution || '',
		reportUploadUnlimited: true,
		franchiseReportUnlimited: true,
		createdAt: new Date().toISOString()
	}
	if (profile.role === 'advisor') user.bankName = profile.institution || ''
	if (profile.adminLevel) user.adminLevel = profile.adminLevel
	return user
}

const ALLOWED_GENDERS = new Set(['male', 'female', 'secret'])

function isSuperAdminUser(user = {}) {
	const role = normalizedRole(user)
	if (role !== 'admin') return false
	if (user.adminLevel === 'super' || user.isSuperAdmin === true) return true
	if (user.phone && SUPER_ADMIN_PHONES.has(String(user.phone))) return true
	if (user.id && SUPER_ADMIN_UIDS.has(String(user.id))) return true
	const names = [user.username, user.loginName, user.account].map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
	if (names.some((name) => SUPER_ADMIN_USERNAMES.has(name))) return true
	if (user.loginNameHash && [...SUPER_ADMIN_USERNAMES].some((name) => hashLoginName(name) === String(user.loginNameHash))) return true
	return false
}

/** 对外暴露的用户信息（统一字段，避免泄露 passwordHash 等敏感字段） */
function publicUser(user) {
	const role = normalizedRole(user)
	const reportUnlimited = user.reportUploadUnlimited === true || user.franchiseReportUnlimited === true || !!fixedTestAccountProfile(user.phone)
	return {
		uid: user.id,
		nickname: user.nickname || '',
		mobile: user.phone || '',
		openid: user.openid || '',
		avatar: user.avatar || '',
		gender: ALLOWED_GENDERS.has(user.gender) ? user.gender : 'secret',
			city: user.city || '',
			bio: user.bio || '',
			institution: user.institution || user.bankName || '',
		// 是否已设置登录密码（仅暴露布尔，不泄露 passwordHash）。
		// 供客户端区分「修改密码 / 首次设置密码」与设置页密码状态展示。
		hasPassword: !!user.passwordHash,
		role,
		reportUploadUnlimited: reportUnlimited,
		franchiseReportUnlimited: reportUnlimited,
		franchiseGrantedAt: user.franchiseGrantedAt || '',
		adminLevel: role === 'admin' ? (isSuperAdminUser(user) ? 'super' : 'regular') : '',
		isSuperAdmin: role === 'admin' && isSuperAdminUser(user)
	}
}

function buildAuthData(user) {
	const { token, tokenExpired } = signToken(user)
	const info = publicUser(user)
	return {
		token,
		accessToken: token,
		tokenExpired,
		uid: user.id,
		userInfo: {
			nickname: info.nickname,
			mobile: info.mobile,
			avatar: info.avatar,
			gender: info.gender,
				city: info.city,
				bio: info.bio,
				institution: info.institution,
				role: info.role,
				reportUploadUnlimited: info.reportUploadUnlimited,
				franchiseReportUnlimited: info.franchiseReportUnlimited,
				franchiseGrantedAt: info.franchiseGrantedAt,
				adminLevel: info.adminLevel,
				isSuperAdmin: info.isSuperAdmin
		}
	}
}

function isValidPhone(s) {
	return /^1[3-9]\d{9}$/.test(String(s || ''))
}

function isValidLoginName(s) {
	return /^[A-Za-z][A-Za-z0-9_]{2,31}$/.test(String(s || '').trim())
}

function normalizeLoginAccount(value) {
	return String(value || '').trim()
}

function hashLoginName(value) {
	const key = String(process.env.LOGIN_NAME_PEPPER || resolveJwtSecret())
	return crypto.createHmac('sha256', key).update(String(value || '').trim().toLowerCase()).digest('hex')
}

function findUserByLoginAccount(account) {
	const key = normalizeLoginAccount(account)
	if (!key) return null
	if (isValidPhone(key)) return store.findUserByPhone(key)
	if (!isValidLoginName(key)) return null
	const low = key.toLowerCase()
	const hashed = hashLoginName(low)
	const users = Array.isArray(store.state().users) ? store.state().users : []
	return users.find((user) => {
		const names = [user.username, user.loginName, user.account].map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
		return names.includes(low) || (user.loginNameHash && String(user.loginNameHash) === hashed)
	}) || null
}

function protectedAccountFail(res, action = '操作') {
	return fail(res, 3003, `最高权限账号不允许在客户端${action}`, null, 403)
}

/** 短信验证码：无真实短信网关，开发态直接回传 devCode 便于联调；生产请接入运营商/第三方短信服务 */
function genSmsCode() {
	return String(Math.floor(100000 + Math.random() * 900000))
}

function smsKey(uid, scene, phone) {
	return `${uid}:${scene}:${phone}`
}

/** 验证码不落明文：以 HMAC-SHA256(JWT 密钥) 存储，verify 时同样哈希后做定长比较 */
function hashSmsCode(code) {
	return crypto.createHmac('sha256', resolveJwtSecret()).update(String(code)).digest('hex')
}

/** 定长比较，避免逐字符比较带来的时间侧信道 */
function safeEqualHex(a, b) {
	const ba = Buffer.from(String(a || ''), 'utf8')
	const bb = Buffer.from(String(b || ''), 'utf8')
	if (ba.length !== bb.length) return false
	return crypto.timingSafeEqual(ba, bb)
}

// maskPhone 已提取到 ../utils/mask.js（全仓库统一脱敏入口）

const SMS_MAX_ATTEMPTS = Number(process.env.SMS_MAX_ATTEMPTS || 5)

/** 短信场景白名单：避免任意 scene 字符串撑爆 smsCodes 键空间 */
const ALLOWED_SMS_SCENES = new Set(['change-phone', 'login', 'reset-password'])

/**
 * 固定假哈希：登录时若用户不存在，也对它跑一次 bcrypt.compare，
 * 使"手机号未注册"与"密码错误"两条路径耗时一致，消除时间侧信道（手机号枚举）。
 */
const DUMMY_BCRYPT_HASH = bcrypt.hashSync('rpt-timing-equalizer', 10)

/** 生产环境只回通用文案，避免把内部异常细节（堆栈/依赖错误）泄露给客户端；细节仍进服务端日志 */
function prodSafeErr(e, fallback) {
	if (isProductionRuntime()) return fallback
	return `${fallback}：${e && e.message ? e.message : 'unknown'}`
}

router.post('/api/user/register', async (req, res) => {
	const { phone, password, nickname = '' } = req.body || {}
	if (!isValidPhone(phone)) return fail(res, 1001, '手机号格式不正确')
	if (String(password || '').length < 6) return fail(res, 1001, '密码至少 6 位')
	// 上限防护：超长密码会让 bcrypt 长时间阻塞单进程（DoS）。bcrypt 实际仅用前 72 字节。
	if (String(password || '').length > 128) return fail(res, 1001, '密码长度超出限制')
	const users = store.state().users
	if (store.findUserByPhone(phone)) return fail(res, 3001, '该手机号已注册')
	try {
		const passwordHash = await bcrypt.hash(String(password), 10)
		// 复检：bcrypt.hash 为异步，期间可能有并发同号注册抢先写入；提交前再查一次避免重复账号（TOCTOU）。
		if (store.findUserByPhone(phone)) return fail(res, 3001, '该手机号已注册')
		const user = fixedTestAccountProfile(phone)
			? buildFixedTestUser(phone, passwordHash, nickname)
			: {
				id: generateUniqueUserId(),
				phone,
				passwordHash,
				nickname: nickname || `用户${String(phone).slice(-4)}`,
				createdAt: new Date().toISOString()
			}
		users.push(user)
		store.persistSync() // 账户创建是高价值写入，立即落盘，避免 200ms 防抖窗口内崩溃丢失
		return ok(res, buildAuthData(user))
	} catch (e) {
		logger.error({ err: e }, 'user/register failed')
		return fail(res, 5000, prodSafeErr(e, '注册失败'))
	}
})

router.post('/api/user/login', async (req, res) => {
	const { password } = req.body || {}
	const account = normalizeLoginAccount((req.body && (req.body.phone || req.body.account || req.body.username || req.body.loginName)) || '')
	if (!isValidPhone(account) && !isValidLoginName(account)) return fail(res, 1001, '请输入正确的手机号或账号')
	if (String(password || '').length > 128) return fail(res, 1001, '密码长度超出限制')
	const user = findUserByLoginAccount(account)
	try {
		// 防手机号枚举：用户不存在与密码错误返回完全一致的 code + 文案；
		// 且对不存在的用户也跑一次等价 bcrypt.compare（固定假哈希），消除时间侧信道。
		const hash = user && user.passwordHash ? String(user.passwordHash) : DUMMY_BCRYPT_HASH
		const matched = await bcrypt.compare(String(password || ''), hash)
		if (!user || !matched) return fail(res, 1002, '账号或密码错误', null, 200)
		if (applyFixedTestAccountProfile(user, { markUpdated: true })) store.persistSync()
		return ok(res, buildAuthData(user))
	} catch (e) {
		logger.error({ err: e }, 'user/login failed')
		return fail(res, 5000, prodSafeErr(e, '登录失败'))
	}
})

router.post('/api/user/logout', authRequired, (req, res) => {
	const user = store.findUserById(req.user.uid)
	if (user) {
		bumpTokenVersion(user)
		user.lastLogoutAt = new Date().toISOString()
		store.persistSync()
	}
	return ok(res, { ok: true, invalidated: !!user })
})

router.post('/api/user/refresh-token', authRequired, (req, res) => {
	const user = store.findUserById(req.user.uid)
	if (!user) return fail(res, 2001, 'user not found', null, 401)
	return ok(res, buildAuthData(user))
})

router.get('/api/user/current', authRequired, (req, res) => {
	const user = store.findUserById(req.user.uid)
	if (!user) return fail(res, 2001, 'user not found', null, 401)
	return ok(res, publicUser(user))
})

/**
 * 更新个人资料（昵称 / 头像 / 性别 / 城市 / 简介）
 * 仅允许更新白名单字段；未传字段保持原值，避免空覆盖。
 */
router.post('/api/user/update-profile', authRequired, (req, res) => {
	const user = store.findUserById(req.user.uid)
	if (!user) return fail(res, 2001, 'user not found', null, 401)
	const body = req.body || {}

	if (body.nickname !== undefined) {
		const nn = String(body.nickname).trim()
		if (nn.length < 1 || nn.length > 20) return fail(res, 1001, '昵称需为 1-20 个字符')
		user.nickname = nn
	}
	if (body.avatar !== undefined) {
		user.avatar = String(body.avatar).slice(0, 500)
	}
	if (body.gender !== undefined) {
		const g = String(body.gender)
		if (!ALLOWED_GENDERS.has(g)) return fail(res, 1001, '性别取值非法')
		user.gender = g
	}
	if (body.city !== undefined) {
		user.city = String(body.city).slice(0, 40)
	}
	if (body.bio !== undefined) {
		user.bio = String(body.bio).slice(0, 100)
	}
	user.updatedAt = new Date().toISOString()
	store.persistSync() // 资料更新为可见性高的写入，立即落盘
	return ok(res, publicUser(user))
})

/**
 * 修改登录密码
 * - 已设密码用户需校验原密码
 * - 微信等无密码用户可直接设置（首次设密）
 */
router.post('/api/user/change-password', authRequired, async (req, res) => {
	const { oldPassword = '', newPassword = '' } = req.body || {}
	if (String(newPassword).length < 6) return fail(res, 1001, '新密码至少 6 位')
	if (String(newPassword).length > 128) return fail(res, 1001, '密码长度超出限制')
	const user = store.findUserById(req.user.uid)
	if (!user) return fail(res, 2001, 'user not found', null, 401)
	if (isSuperAdminUser(user) || fixedTestAccountProfile(user.phone)) return protectedAccountFail(res, '修改密码')
	try {
		if (user.passwordHash) {
			const matched = await bcrypt.compare(String(oldPassword || ''), String(user.passwordHash))
			if (!matched) return fail(res, 1002, '原密码不正确', null, 200)
		}
		user.passwordHash = await bcrypt.hash(String(newPassword), 10)
		bumpTokenVersion(user)
		user.updatedAt = new Date().toISOString()
		store.persistSync()
		addMessage(req.user.uid, {
			type: 'security',
			title: '登录密码已修改',
			desc: '您的登录密码于近期被修改，如非本人操作请立即联系客服',
			linkType: 'modal'
		})
		return ok(res, { ok: true, hasPassword: true, ...buildAuthData(user) })
	} catch (e) {
		logger.error({ err: e }, 'user/change-password failed')
		return fail(res, 5000, '修改失败：' + (e && e.message ? e.message : 'unknown'))
	}
})

/**
 * 发送忘记密码验证码（无需登录态）。
 * 为避免手机号枚举，不存在的手机号也返回 sent:true，但不会写入有效验证码。
 */
router.post('/api/user/send-reset-password-sms-code', async (req, res) => {
	const phone = String((req.body && req.body.phone) || '').trim()
	if (!isValidPhone(phone)) return fail(res, 1001, '手机号格式不正确')
	const scene = 'reset-password'
	const s = store.state()
	if (!s.smsResetCooldowns) s.smsResetCooldowns = {}
	const cd = s.smsResetCooldowns[phone]
	if (cd && cd > Date.now()) {
		const remain = Math.ceil((cd - Date.now()) / 1000)
		return fail(res, 1004, `请 ${remain} 秒后重试`, null, 200)
	}
	const user = store.findUserByPhone(phone)
	const payload = { sent: true, expireIn: 300 }
	if (!user || isSuperAdminUser(user) || fixedTestAccountProfile(phone)) {
		s.smsResetCooldowns[phone] = Date.now() + 60 * 1000
		store.persistSync()
		return ok(res, payload)
	}
	const code = genSmsCode()
	if (!s.smsCodes) s.smsCodes = {}
	const key = smsKey('*reset', scene, phone)
	s.smsCodes[key] = {
		codeHash: hashSmsCode(code),
		expireAt: Date.now() + 5 * 60 * 1000,
		sentAt: Date.now(),
		attempts: 0
	}
	s.smsResetCooldowns[phone] = Date.now() + 60 * 1000
	store.persistSync()
	console.log(`[sms] scene=${scene} phone=${maskPhone(phone)} sent`)
	const smsResult = await sendSms(phone, code, scene)
	if (!smsResult.ok) {
		delete s.smsCodes[key]
		delete s.smsResetCooldowns[phone]
		store.persistSync()
		return fail(res, 5001, isProductionRuntime() ? '短信发送失败，请稍后重试' : `短信发送失败：${smsResult.error || 'unknown'}`)
	}
	if (!isProductionRuntime()) payload.devCode = code
	return ok(res, payload)
})

router.post('/api/user/reset-password', async (req, res) => {
	const phone = String((req.body && req.body.phone) || '').trim()
	const code = String((req.body && req.body.code) || '').trim()
	const newPassword = String((req.body && req.body.newPassword) || '').trim()
	if (!isValidPhone(phone)) return fail(res, 1001, '手机号格式不正确')
	if (!code) return fail(res, 1001, '验证码不能为空')
	if (newPassword.length < 6) return fail(res, 1001, '新密码至少 6 位')
	if (newPassword.length > 128) return fail(res, 1001, '密码长度超出限制')
	try {
		const scene = 'reset-password'
		const key = smsKey('*reset', scene, phone)
		const s = store.state()
		const rec = s.smsCodes && s.smsCodes[key]
		if (!rec || rec.expireAt < Date.now()) {
			if (rec && s.smsCodes) delete s.smsCodes[key]
			return fail(res, 1003, '验证码已过期，请重新获取', null, 200)
		}
		if (Number(rec.attempts || 0) >= SMS_MAX_ATTEMPTS) {
			delete s.smsCodes[key]
			store.persistSync()
			return fail(res, 1003, '验证码错误次数过多，请重新获取', null, 200)
		}
		const expectedHash = rec.codeHash || (rec.code != null ? hashSmsCode(rec.code) : '')
		if (!expectedHash || !safeEqualHex(expectedHash, hashSmsCode(code))) {
			rec.attempts = Number(rec.attempts || 0) + 1
			if (rec.attempts >= SMS_MAX_ATTEMPTS) delete s.smsCodes[key]
			store.persistSync()
			return fail(res, 1003, rec.attempts >= SMS_MAX_ATTEMPTS ? '验证码错误次数过多，请重新获取' : '验证码不正确', null, 200)
		}
		const user = store.findUserByPhone(phone)
		if (!user) {
			delete s.smsCodes[key]
			store.persistSync()
			return fail(res, 1003, '验证码已过期，请重新获取', null, 200)
		}
		if (isSuperAdminUser(user) || fixedTestAccountProfile(user.phone)) return protectedAccountFail(res, '重置密码')
		user.passwordHash = await bcrypt.hash(newPassword, 10)
		bumpTokenVersion(user)
		user.passwordResetAt = new Date().toISOString()
		user.updatedAt = user.passwordResetAt
		delete s.smsCodes[key]
		if (s.smsResetCooldowns && s.smsResetCooldowns[phone]) delete s.smsResetCooldowns[phone]
		store.persistSync()
		addMessage(user.id, {
			type: 'security',
			title: '登录密码已重置',
			desc: '您的登录密码已通过短信验证重置，如非本人操作请立即联系客服',
			linkType: 'modal'
		})
		return ok(res, { ok: true, hasPassword: true, ...buildAuthData(user) })
	} catch (e) {
		logger.error({ err: e }, 'user/reset-password failed')
		return fail(res, 5000, prodSafeErr(e, '重置密码失败'))
	}
})

/**
 * 发送短信验证码（用于更换手机号等场景）
 * 无真实短信网关：开发态在响应里回传 devCode，生产环境只返回 sent:true。
 */
router.post('/api/user/send-sms-code', authRequired, async (req, res) => {
	const phone = String((req.body && req.body.phone) || '').trim()
	const scene = String((req.body && req.body.scene) || 'change-phone')
	if (!isValidPhone(phone)) return fail(res, 1001, '手机号格式不正确')
	const currentUser = store.findUserById(req.user.uid)
	if (currentUser && fixedTestAccountProfile(currentUser.phone)) return protectedAccountFail(res, '更换手机号')
	// scene 白名单：拒绝任意字符串，避免 smsCodes 键空间被任意 scene 撑爆
	if (!ALLOWED_SMS_SCENES.has(scene)) return fail(res, 1001, '不支持的验证码场景')
	if (scene === 'change-phone') {
		const used = (() => { const f = store.findUserByPhone(phone); return f && f.id !== req.user.uid ? f : null })()
		if (used) return fail(res, 3001, '该手机号已被其他账号绑定')
	}
	const code = genSmsCode()
	const s = store.state()
	if (!s.smsCodes) s.smsCodes = {}
	s.smsCodes[smsKey(req.user.uid, scene, phone)] = {
		codeHash: hashSmsCode(code),
		expireAt: Date.now() + 5 * 60 * 1000,
		sentAt: Date.now(),
		attempts: 0
	}
	store.persistSync()
	// 安全基线：日志绝不打印验证码 / 明文手机号；devCode 仅经响应体在非生产环境回传，便于联调。
	console.log(`[sms] uid=${req.user.uid} scene=${scene} phone=${maskPhone(phone)} sent`)
	const smsLoginResult = await sendSms(phone, code, scene)
	if (!smsLoginResult.ok) {
		// 回滚刚写入的验证码记录：必须删除与写入时一致的 key（uid+scene+phone），
		// 否则孤儿记录残留。此端点为登录态改绑场景，与登录冷却（smsLoginCooldowns）无关。
		delete s.smsCodes[smsKey(req.user.uid, scene, phone)]
		store.persistSync()
		return fail(res, 5001, isProductionRuntime() ? '短信发送失败，请稍后重试' : `短信发送失败：${smsLoginResult.error || 'unknown'}`)
	}
	const payload = { sent: true, expireIn: 300 }
	if (!isProductionRuntime()) payload.devCode = code
	return ok(res, payload)
})

/**
 * 更换手机号（需先获取并校验短信验证码）
 * 成功后重新签发 JWT（payload 内含 phone，旧 token 仍有效但信息过期）。
 */
router.post('/api/user/change-phone', authRequired, (req, res) => {
	const phone = String((req.body && req.body.phone) || '').trim()
	const code = String((req.body && req.body.code) || '').trim()
	if (!isValidPhone(phone)) return fail(res, 1001, '手机号格式不正确')
	try {
		const s = store.state()
	const used = (() => { const f = store.findUserByPhone(phone); return f && f.id !== req.user.uid ? f : null })()
	if (used) return fail(res, 3001, '该手机号已被其他账号绑定')
	const key = smsKey(req.user.uid, 'change-phone', phone)
	const rec = s.smsCodes && s.smsCodes[key]
	if (!rec || rec.expireAt < Date.now()) {
		if (rec && s.smsCodes) delete s.smsCodes[key]
		return fail(res, 1003, '验证码已过期，请重新获取', null, 200)
	}
	// 防爆破：6 位验证码在 5 分钟有效期内可被穷举，限制尝试次数并在超限后立即作废。
	if (Number(rec.attempts || 0) >= SMS_MAX_ATTEMPTS) {
		delete s.smsCodes[key]
		store.persistSync()
		return fail(res, 1003, '验证码错误次数过多，请重新获取', null, 200)
	}
	// 兼容历史明文记录（rec.code）与新版哈希记录（rec.codeHash）
	const expectedHash = rec.codeHash || (rec.code != null ? hashSmsCode(rec.code) : '')
	if (!expectedHash || !safeEqualHex(expectedHash, hashSmsCode(code))) {
		rec.attempts = Number(rec.attempts || 0) + 1
		// 达到错误上限即作废验证码：6 位码不可在同一份码上无限次试错
		if (rec.attempts >= SMS_MAX_ATTEMPTS) {
			delete s.smsCodes[key]
			store.persistSync()
			return fail(res, 1003, '验证码错误次数过多，请重新获取', null, 200)
		}
		store.persistSync()
		return fail(res, 1003, '验证码不正确', null, 200)
	}
	const user = store.findUserById(req.user.uid)
	if (!user) return fail(res, 2001, 'user not found', null, 401)
	if (isSuperAdminUser(user) || fixedTestAccountProfile(user.phone)) return protectedAccountFail(res, '更换手机号')
		user.phone = phone
		bumpTokenVersion(user)
		user.updatedAt = new Date().toISOString()
		delete s.smsCodes[key]
		store.persistSync()
		return ok(res, buildAuthData(user))
	} catch (e) {
		logger.error({ err: e }, 'user/change-phone failed')
		return fail(res, 5000, '更换手机号失败')
	}
})

/**
 * 切换用户角色（user / advisor / service）
 * 前端 roleService.js 调用此端点持久化角色。
 * - 切换到 advisor 需 TEACHER_ENABLE=true，否则拒绝
 * - 切换到 service 用于客服处理端
 * - 切换到 user 始终允许（降级回用户端）
 * - monitor/admin 不支持用户自助切换，需服务器侧授予
 */
router.post('/api/user/set-role', authRequired, (req, res) => {
	const role = String((req.body && req.body.role) || '').trim().toLowerCase()
	if (!role || !['user', 'advisor', 'service'].includes(role)) {
		return fail(res, 1001, '无效的角色值，仅支持 user / advisor / service')
	}
	const teacherEnabled = String(process.env.TEACHER_ENABLE || 'false').toLowerCase() === 'true'
	if (role === 'advisor' && !teacherEnabled) {
		return fail(res, 3003, '老师端功能未启用，请联系管理员', null, 403)
	}
	try {
		const user = store.findUserById(req.user.uid)
		if (!user) return fail(res, 2001, 'user not found', null, 401)
		const fixedProfile = fixedTestAccountProfile(user.phone)
		if (fixedProfile && role !== fixedProfile.role) {
			applyFixedTestAccountProfile(user, { markUpdated: true })
			store.persistSync()
			return fail(res, 3003, role === 'advisor' ? '银行老师端需要平台认证账号' : role === 'service' ? '客服端需要平台认证账号' : '固定测试账号不支持切换为该角色', null, 403)
		}
		const currentRole = normalizedRole(user.role || '')
		if (role !== 'user' && (!fixedProfile || fixedProfile.role !== role) && currentRole !== role) {
			return fail(res, 3003, role === 'advisor' ? '银行老师端需要平台认证账号' : '客服端需要平台认证账号', null, 403)
		}
		user.role = role
		user.updatedAt = new Date().toISOString()
		store.persistSync()
		console.log(`[user] role set: uid=${req.user.uid} role=${role}`)
		return ok(res, publicUser(user))
	} catch (e) {
		logger.error({ err: e }, 'user/set-role failed')
		return fail(res, 5000, '设置角色失败')
	}
})

/**
 * 发送登录短信验证码（无需登录态）
 * 按手机号限频，防短信轰炸。开发态回传 devCode。
 */
router.post('/api/user/send-login-sms-code', async (req, res) => {
	const phone = String((req.body && req.body.phone) || '').trim()
	if (!isValidPhone(phone)) return fail(res, 1001, '手机号格式不正确')
	const scene = 'login'

	// 按手机号限频：60 秒内同一手机号不可重复发送
	const s = store.state()
	if (!s.smsLoginCooldowns) s.smsLoginCooldowns = {}
	const cd = s.smsLoginCooldowns[phone]
	if (cd && cd > Date.now()) {
		const remain = Math.ceil((cd - Date.now()) / 1000)
		return fail(res, 1004, `请 ${remain} 秒后重试`, null, 200)
	}

	const code = genSmsCode()
	if (!s.smsCodes) s.smsCodes = {}
	// 登录场景用 phone 作为 key 的一部分（无 uid）
	const key = smsKey('*login', scene, phone)
	s.smsCodes[key] = {
		codeHash: hashSmsCode(code),
		expireAt: Date.now() + 5 * 60 * 1000,
		sentAt: Date.now(),
		attempts: 0
	}
	s.smsLoginCooldowns[phone] = Date.now() + 60 * 1000
	store.persistSync()
	console.log(`[sms] scene=${scene} phone=${maskPhone(phone)} sent`)
	const smsLoginResult = await sendSms(phone, code, scene)
	if (!smsLoginResult.ok) {
		delete s.smsCodes[smsKey('*login', scene, phone)]
		if (s.smsLoginCooldowns && s.smsLoginCooldowns[phone]) delete s.smsLoginCooldowns[phone]
		store.persistSync()
		return fail(res, 5001, isProductionRuntime() ? '短信发送失败，请稍后重试' : `短信发送失败：${smsLoginResult.error || 'unknown'}`)
	}
	const payload = { sent: true, expireIn: 300 }
	if (!isProductionRuntime()) payload.devCode = code
	return ok(res, payload)
})

/**
 * 手机号+验证码登录（首次登录自动注册）
 * 无密码体系：仅校验短信验证码，通过即签发 JWT。
 */
router.post('/api/user/sms-login', (req, res) => {
	const phone = String((req.body && req.body.phone) || '').trim()
	const code = String((req.body && req.body.code) || '').trim()
	if (!isValidPhone(phone)) return fail(res, 1001, '手机号格式不正确')
	if (!code) return fail(res, 1001, '验证码不能为空')

	try {
		const scene = 'login'
		const key = smsKey('*login', scene, phone)
		const s = store.state()
		const rec = s.smsCodes && s.smsCodes[key]

		if (!rec || rec.expireAt < Date.now()) {
			if (rec && s.smsCodes) delete s.smsCodes[key]
			return fail(res, 1003, '验证码已过期，请重新获取', null, 200)
		}
		if (Number(rec.attempts || 0) >= SMS_MAX_ATTEMPTS) {
			delete s.smsCodes[key]
			store.persistSync()
			return fail(res, 1003, '验证码错误次数过多，请重新获取', null, 200)
		}

		const expectedHash = rec.codeHash || (rec.code != null ? hashSmsCode(rec.code) : '')
		if (!expectedHash || !safeEqualHex(expectedHash, hashSmsCode(code))) {
			rec.attempts = Number(rec.attempts || 0) + 1
			if (rec.attempts >= SMS_MAX_ATTEMPTS) {
				delete s.smsCodes[key]
			}
			store.persistSync()
			return fail(res, 1003, '验证码不正确', null, 200)
		}

		// 验证通过：消费验证码
		delete s.smsCodes[key]
		// 清理冷却记录
		if (s.smsLoginCooldowns && s.smsLoginCooldowns[phone]) {
			delete s.smsLoginCooldowns[phone]
		}
		store.persistSync()

		// 查找已有用户，不存在则自动注册
		const users = s.users
		let user = store.findUserByPhone(phone)
		if (!user) {
			user = fixedTestAccountProfile(phone)
				? buildFixedTestUser(phone, '', '')
				: {
					id: generateUniqueUserId(),
					phone,
					nickname: `用户${String(phone).slice(-4)}`,
					createdAt: new Date().toISOString()
				}
			users.push(user)
			store.persistSync()
		} else if (applyFixedTestAccountProfile(user, { markUpdated: true })) {
			store.persistSync()
		}

		return ok(res, buildAuthData(user))
	} catch (e) {
		logger.error({ err: e }, 'user/sms-login failed')
		return fail(res, 5000, '登录失败，请稍后重试')
	}
})

/**
 * 账号注销（需登录态）
 * 删除用户及关联数据（报告/短信记录），不可逆。
 */
router.post('/api/user/delete-account', authRequired, (req, res) => {
	const uid = String(req.user.uid || req.user.userId || '')
	if (!uid) return fail(res, 1001, '用户标识缺失')

	try {
		const s = store.state()

		// 删除用户（先取手机号，供清理以 phone 为后缀的登录验证码 key）
		const users = s.users || []
		const idx = users.findIndex((u) => u.id === uid)
		const phone = idx >= 0 ? String(users[idx].phone || '') : ''
		if (idx >= 0 && (isSuperAdminUser(users[idx]) || fixedTestAccountProfile(phone))) return protectedAccountFail(res, '注销')
		if (idx >= 0) users.splice(idx, 1)

		// 删除关联报告
		if (s.reports) {
			s.reports = (s.reports || []).filter((r) => r && (r.userId || r.uid) !== uid)
		}

		// 删除短信验证码记录：
		//   - 改绑场景 key 形如 `${uid}:change-phone:${phone}`，按 uid 命中
		//   - 登录场景 key 形如 `*login:login:${phone}`，无 uid，需按手机号后缀命中
		if (s.smsCodes) {
			const keys = Object.keys(s.smsCodes)
			for (const k of keys) {
				if (k.includes(uid) || (phone && k.endsWith(':' + phone))) delete s.smsCodes[k]
			}
		}

		// 缓存 scope 使用不可逆 HMAC。先删除缓存任务/结果，再提交账号注销；
		// 即使当时有分析任务在跑，其 lease 行被删除后也无法重新写入成功结果。
		const deletedAnalysis = store.deleteAnalysisScope(buildAnalysisScopeHmac(`user:${uid}`))
		analysisTaskService.removeAnalysisSpoolFiles(deletedAnalysis.inputFiles)
		store.persistSync()
		console.log('[user] account deleted uid=' + uid)
		return ok(res, { deleted: true, uid })
	} catch (e) {
		logger.error({ err: e }, 'user/delete-account failed')
		return fail(res, 5000, '注销账号失败')
	}
})

module.exports = router
