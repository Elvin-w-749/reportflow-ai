/**
 * 认证服务（HTTP API 版）
 * 使用自建服务端 JWT 体系。
 */
import { request } from './apiClient.js'
import { clearLocalReportCache } from './reportStorage.js'
import { reportError } from './errorReporter.js'
import { clearLocalSessionState } from './sensitiveLocalState.js'

/**
 * 手机号+密码登录
 */
export async function login(phone, password) {
	let data
	try {
		data = await request({ url: '/api/user/login', method: 'POST', data: { phone, password } })
	} catch (e) {
		const fallback = localDevAuthFallback('login', { phone, password, error: e })
		if (fallback) return fallback
		throw e
	}
	const res = { errCode: 0, ...data }
	if (res.errCode === 0 || res.token) {
		_saveAuthData({ ...res, token: res.token || res.accessToken })
	}
	return res
}

/**
 * 手机号+密码注册
 */
export async function register(phone, password, nickname) {
	let data
	try {
		data = await request({ url: '/api/user/register', method: 'POST', data: { phone, password, nickname } })
	} catch (e) {
		const fallback = localDevAuthFallback('register', { phone, password, nickname, error: e })
		if (fallback) return fallback
		throw e
	}
	const res = { errCode: 0, ...data }
	if (res.errCode === 0 || res.token) {
		_saveAuthData({ ...res, token: res.token || res.accessToken })
	}
	return res
}

/**
 * 退出登录
 */
export async function logout() {
	try {
		await request({ url: '/api/user/logout', method: 'POST' })
	} catch (e) {
		reportError({ kind: 'auth-logout-api', message: (e && (e.message || e.errMsg)) || '退出登录请求失败，本地清理', extra: { action: 'logout' } })
	}
	_clearAuthData()
}

/**
 * 注销账号（不可逆）
 * 服务端删除用户及关联数据，客户端清除本地所有状态。
 */
export async function deleteAccount() {
	const data = await request({ url: '/api/user/delete-account', method: 'POST' })
	if (data && data.deleted) {
		_clearAuthData()
		return { errCode: 0 }
	}
	return { errCode: -1, errMsg: '注销失败，请稍后重试' }
}

/**
 * 刷新 Token
 */
export async function refreshToken() {
	const data = await request({ url: '/api/user/refresh-token', method: 'POST' })
	const res = { errCode: 0, ...data }
	if (res.errCode === 0 || res.token) {
		const token = res.token || res.accessToken
		uni.setStorageSync('auth_token', token)
		uni.setStorageSync('uni_id_token', token)
		if (res.tokenExpired) {
			uni.setStorageSync('uni_id_token_expired', res.tokenExpired)
		}
	}
	return res
}

/**
 * 获取当前用户信息（从云端）
 */
export async function getCurrentUser() {
	const data = await request({ url: '/api/user/current', method: 'GET' })
	// 将最新的密码状态/显示字段并入本地缓存，便于设置页等据实展示
	if (data != null && typeof data === 'object') {
		try { _mergeCachedUserInfo(data) } catch (_) {}
	}
	return { errCode: 0, data }
}

/**
 * 合并并写回本地用户信息缓存（更新昵称/手机号等显示态）
 */
function _mergeCachedUserInfo(patch) {
	const cached = getCachedUserInfo() || {}
	const merged = { ...cached, ...patch }
	uni.setStorageSync('userInfo', JSON.stringify(merged))
	if (merged.nickname) uni.setStorageSync('userName', merged.nickname)
	if (merged.mobile) uni.setStorageSync('userPhone', merged.mobile)
	return merged
}

/**
 * 更新个人资料（昵称 / 头像 / 性别 / 城市 / 简介）
 * @param {{ nickname?: string, avatar?: string, gender?: string, city?: string, bio?: string }} profile
 */
export async function updateProfile(profile) {
	const data = await request({ url: '/api/user/update-profile', method: 'POST', data: profile })
	const merged = _mergeCachedUserInfo(data || {})
	return { errCode: 0, data: merged }
}

/**
 * 修改登录密码（已设密码用户需校验原密码；无密码用户可直接设置）
 */
export async function changePassword(oldPassword, newPassword) {
	const data = await request({
		url: '/api/user/change-password',
		method: 'POST',
		data: { oldPassword, newPassword }
	})
	if (data && (data.token || data.accessToken)) {
		_saveAuthData({ ...data, token: data.token || data.accessToken })
	}
	return { errCode: 0, data }
}

/**
 * 通过短信验证码重置登录密码（忘记密码场景，无需登录态）
 * 约定：服务端校验 phone+code 后将密码更新为 newPassword。
 * 若服务端返回 token/userInfo，则顺带写入登录态（重置后免登录）。
 * @param {string} phone 手机号
 * @param {string} code 短信验证码（scene=reset-password）
 * @param {string} newPassword 新密码
 */
export async function resetPassword(phone, code, newPassword) {
	const data = await request({
		url: '/api/user/reset-password',
		method: 'POST',
		data: { phone, code, newPassword }
	})
	const res = { errCode: 0, ...data }
	if (res.token || res.accessToken) {
		_saveAuthData({ ...res, token: res.token || res.accessToken })
	}
	return res
}

/**
 * 发送登录短信验证码
 * @returns {Promise<{ errCode: number, data: any }>} 开发态 data.devCode 可直接回填
 */
export async function sendLoginSmsCode(phone) {
	let data
	try {
		data = await request({
			url: '/api/user/send-login-sms-code',
			method: 'POST',
			data: { phone, scene: 'login' }
		})
	} catch (e) {
		const fallback = localDevSmsFallback(phone, e)
		if (fallback) return fallback
		throw e
	}
	return { errCode: 0, data }
}

/**
 * 手机号+验证码登录（首次登录自动注册）
 */
export async function loginBySmsCode(phone, code) {
	let data
	try {
		data = await request({
			url: '/api/user/sms-login',
			method: 'POST',
			data: { phone, code }
		})
	} catch (e) {
		const fallback = localDevAuthFallback('sms-login', { phone, code, error: e })
		if (fallback) return fallback
		throw e
	}
	const res = { errCode: 0, ...data }
	if (res.errCode === 0 || res.token) {
		_saveAuthData({ ...res, token: res.token || res.accessToken })
	}
	return res
}

/**
 * 发送短信验证码（默认更换手机号场景）
 * @returns {Promise<{ errCode: number, data: any }>} 开发态 data.devCode 可直接回填
 */
export async function sendSmsCode(phone, scene = 'change-phone') {
	if (scene === 'reset-password') {
		const data = await request({
			url: '/api/user/send-reset-password-sms-code',
			method: 'POST',
			data: { phone, scene }
		})
		return { errCode: 0, data }
	}
	const data = await request({
		url: '/api/user/send-sms-code',
		method: 'POST',
		data: { phone, scene }
	})
	return { errCode: 0, data }
}

/**
 * 更换手机号（校验验证码，成功后服务端重新签发 token）
 */
export async function changePhone(phone, code) {
	const data = await request({ url: '/api/user/change-phone', method: 'POST', data: { phone, code } })
	const res = { errCode: 0, ...data }
	// 服务端返回新 token + userInfo：刷新登录态与本地缓存，保证手机号显示即时生效
	if (res.token || res.accessToken) {
		_saveAuthData({ ...res, token: res.token || res.accessToken })
	}
	return res
}

/**
 * 检查是否已登录（本地判断）
 */
export function isLoggedIn() {
	const token = resolveAuthToken()
	if (!token) return false
	const expired = uni.getStorageSync('uni_id_token_expired')
	const expiresAt = Number(expired) || Date.parse(String(expired || ''))
	if (expired && Number.isFinite(expiresAt) && Date.now() > expiresAt) {
		_clearAuthData()
		return false
	}
	return true
}

/**
 * 统一读取登录态 JWT Token（双键容错，与刷新/登录写入保持一致）。
 *
 * 所有需要 Bearer Token 的模块（apiClient / deepseekService / pdfParser 等）
 * 均应通过此函数获取 token，避免各模块各自实现双键回退逻辑导致口径不一致。
 *
 * @returns {string} token 字符串，未登录时返回空字符串
 */
export function resolveAuthToken() {
	try {
		const token = uni.getStorageSync('auth_token') || uni.getStorageSync('uni_id_token')
		return typeof token === 'string' ? token.trim() : ''
	} catch (e) {
		// 静默降级：storage 读取失败时不阻塞调用方，由上层按需 reportError
		return ''
	}
}

/**
 * 获取当前用户ID
 */
export function getUserId() {
	return uni.getStorageSync('uni_id') || ''
}

/**
 * 获取本地缓存的用户信息
 */
export function getCachedUserInfo() {
	const info = uni.getStorageSync('userInfo')
	if (!info) return null
	if (typeof info !== 'string') return info
	try {
		return JSON.parse(info)
	} catch (e) {
		// 缓存损坏：清理脏数据，避免反复抛错
		try { uni.removeStorageSync('userInfo') } catch (_) {}
		return null
	}
}

/**
 * 要求登录，未登录则跳转登录页
 */
export function requireLogin() {
	if (!isLoggedIn()) {
		uni.navigateTo({ url: '/pages/login/index' })
		return false
	}
	return true
}

function _saveAuthData(res) {
	// 隐私基线：账号切换（A 未登出直接登 B）时，清空上一账号残留的本地征信报告缓存（明文），
	// 防跨账号读到他人报告。仅在 uid 确实变化且存在旧 uid 时清理，避免同账号重复登录误清。
	if (res.uid) {
		try {
			const prevUid = uni.getStorageSync('uni_id')
			if (prevUid && String(prevUid) !== String(res.uid)) {
				try {
					clearLocalSessionState()
				} catch (cleanupError) {
					reportError({ kind: 'auth-switch-business-cleanup', message: (cleanupError && (cleanupError.message || cleanupError.errMsg)) || '账号切换清理本地业务缓存失败', extra: { action: 'switchAccount' } })
				}
				clearLocalReportCache()
			}
		} catch (e) {
			reportError({ kind: 'auth-switch-cleanup', message: (e && (e.message || e.errMsg)) || '账号切换清理本地报告缓存失败', extra: { action: 'switchAccount' } })
		}
	}
	if (res.token) {
		uni.setStorageSync('auth_token', res.token)
		uni.setStorageSync('uni_id_token', res.token)
	}
	if (res.tokenExpired) {
		uni.setStorageSync('uni_id_token_expired', res.tokenExpired)
	}
	if (res.uid) {
		uni.setStorageSync('uni_id', res.uid)
		uni.setStorageSync('userId', res.uid)
	}
	if (res.userInfo) {
		uni.setStorageSync('userInfo', JSON.stringify(res.userInfo))
		if (res.userInfo.role) {
			uni.setStorageSync('currentRole', res.userInfo.role)
			uni.setStorageSync('isAdvisorMode', res.userInfo.role === 'advisor')
		}
		if (res.userInfo.nickname) {
			uni.setStorageSync('userName', res.userInfo.nickname)
		}
		if (res.userInfo.mobile) {
			uni.setStorageSync('userPhone', res.userInfo.mobile)
			if (LOCAL_DEV_TEST_PHONE_RE.test(String(res.userInfo.mobile)) && !res.userInfo.role) {
				const role = localDevRoleForPhone(res.userInfo.mobile)
				uni.setStorageSync('currentRole', role)
				uni.setStorageSync('isAdvisorMode', role === 'advisor')
			}
		}
	}
}

const LOCAL_DEV_TEST_PHONE_RE = /^196000000\d{2}$/
const LOCAL_DEV_AUTH_ENABLED = String(import.meta.env.VITE_ENABLE_LOCAL_DEV_AUTH || '').trim().toLowerCase() === 'true'
const LOCAL_DEV_TEST_PASSWORD = String(import.meta.env.VITE_LOCAL_DEV_TEST_PASSWORD || '').trim()
const LOCAL_DEV_SMS_CODE = String(import.meta.env.VITE_LOCAL_DEV_SMS_CODE || '').trim()

function isLocalDevAuthFallbackAllowed() {
	try {
		if (!import.meta.env.DEV || !LOCAL_DEV_AUTH_ENABLED) return false
		const host = typeof window !== 'undefined' && window.location ? window.location.hostname : ''
		const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
		return isLoopback
	} catch (_) {
		return false
	}
}

function isFallbackEligibleAuthError(error) {
	const msg = String((error && (error.message || error.errMsg)) || error || '')
	return /request:fail|network|timeout|Failed to fetch|NetworkError|访问套接字|ERR_|手机号或密码错误|验证码|用户不存在/i.test(msg)
}

function localDevRoleForPhone(phone) {
	const suffix = String(phone || '').slice(-2)
	if (suffix === '02') return 'advisor'
	if (suffix === '03') return 'service'
	if (suffix === '04') return 'admin'
	if (suffix === '05' || suffix === '06') return 'advisor'
	return 'user'
}

function localDevInstitutionForPhone(phone) {
	const suffix = String(phone || '').slice(-2)
	if (suffix === '02') return '示例银行A'
	if (suffix === '03') return '平台客服中心'
	if (suffix === '04') return '平台管理后台'
	if (suffix === '05') return '示例银行B'
	if (suffix === '06') return '示例惠想消费金融'
	return ''
}

function localDevNicknameForPhone(phone, nickname = '') {
	if (nickname) return nickname
	const suffix = String(phone || '').slice(-2)
	if (suffix === '02') return '示例银行A经理测试号'
	if (suffix === '05') return '示例银行B经理测试号'
	if (suffix === '06') return '示例惠想消费金融经理测试号'
	const role = localDevRoleForPhone(phone)
	if (role === 'advisor') return '银行经理测试号'
	if (role === 'service') return '客服测试号'
	if (role === 'admin') return '管理员测试号'
	return '客户测试号'
}

function buildLocalDevAuth(phone, nickname = '') {
	const mobile = String(phone || '').trim()
	const uid = `local-dev-${mobile}`
	const role = localDevRoleForPhone(mobile)
	const isSuperAdmin = mobile === '19600000004'
	return {
		errCode: 0,
		token: `local-dev-token-${mobile}-${Date.now()}`,
		tokenExpired: Date.now() + 7 * 24 * 60 * 60 * 1000,
		uid,
		userInfo: {
			uid,
				mobile,
				nickname: localDevNicknameForPhone(mobile, nickname),
				role,
				institution: localDevInstitutionForPhone(mobile),
				adminLevel: role === 'admin' ? (isSuperAdmin ? 'super' : 'regular') : '',
				isSuperAdmin,
				hasPassword: true
			},
		devFallback: true
	}
}

function localDevAuthFallback(scene, payload = {}) {
	if (!isLocalDevAuthFallbackAllowed() || !isFallbackEligibleAuthError(payload.error)) return null
	const phone = String(payload.phone || '').trim()
	if (!LOCAL_DEV_TEST_PHONE_RE.test(phone)) return null
	if (scene === 'login' && (!LOCAL_DEV_TEST_PASSWORD || payload.password !== LOCAL_DEV_TEST_PASSWORD)) return null
	if (scene === 'register' && (!payload.password || String(payload.password).length < 6)) return null
	if (scene === 'sms-login' && (!LOCAL_DEV_SMS_CODE || String(payload.code || '') !== LOCAL_DEV_SMS_CODE)) return null
	const res = buildLocalDevAuth(phone, payload.nickname || '')
	_saveAuthData(res)
	try {
		const role = res.userInfo && res.userInfo.role ? res.userInfo.role : 'user'
		uni.setStorageSync('currentRole', role)
		uni.setStorageSync('isAdvisorMode', role === 'advisor')
	} catch (_) {}
	return res
}

function localDevSmsFallback(phone, error) {
	if (!isLocalDevAuthFallbackAllowed() || !isFallbackEligibleAuthError(error)) return null
	if (!LOCAL_DEV_TEST_PHONE_RE.test(String(phone || '').trim())) return null
	if (!LOCAL_DEV_SMS_CODE) return null
	return { errCode: 0, data: { devCode: LOCAL_DEV_SMS_CODE, devFallback: true } }
}
function _clearAuthData() {
	try {
		clearLocalSessionState()
	} catch (e) {
		reportError({ kind: 'auth-session-cleanup', message: (e && (e.message || e.errMsg)) || '清理本地会话缓存失败', extra: { action: 'logout' } })
	}
	// 隐私基线：退出登录同时清空本地缓存的征信报告（明文），防共享设备残留。
	try {
		clearLocalReportCache()
	} catch (e) {
		reportError({ kind: 'auth-logout-report-cleanup', message: (e && (e.message || e.errMsg)) || '清理本地报告缓存失败', extra: { action: 'logout' } })
	}
}

export default {
	login,
	register,
	loginBySmsCode,
	sendLoginSmsCode,
	logout,
	deleteAccount,
	refreshToken,
	getCurrentUser,
	updateProfile,
	changePassword,
	resetPassword,
	sendSmsCode,
	changePhone,
	isLoggedIn,
	resolveAuthToken,
	getUserId,
	getCachedUserInfo,
	requireLogin
}
