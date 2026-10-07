/**
 * 角色服务 - 支持用户端 / 银行经理端 / 客服端 / 管理员端切换
 * 本地缓存 + 后端同步：调用 /api/user/set-role 持久化角色。
 * 值: 'user' | 'advisor' | 'service' | 'admin'
 * 管理员端只允许已授予 admin 的账号进入，不支持普通用户自助升级。
 */

import { request } from './apiClient.js'
import { getCachedUserInfo, isLoggedIn, resolveAuthToken } from './authService.js'

const ROLE_KEY = 'currentRole'
const ADVISOR_MODE_KEY = 'isAdvisorMode'

export function getCurrentRole() {
	return uni.getStorageSync(ROLE_KEY) || 'user'
}

export function setCurrentRole(role) {
	uni.setStorageSync(ROLE_KEY, role)
	uni.setStorageSync(ADVISOR_MODE_KEY, role === 'advisor')
}

export function isAdvisorMode() {
	return getCurrentRole() === 'advisor'
}

export function isServiceMode() {
	return getCurrentRole() === 'service'
}

export function isAdminMode() {
	return getCurrentRole() === 'admin'
}

function isLocalTestAuth() {
	return String(resolveAuthToken() || '').startsWith('local-dev-token-')
}

function testRoleFromCachedUser() {
	const user = getCachedUserInfo() || {}
	const mobile = String(user.mobile || user.phone || '').trim()
	if (/^19600000002$/.test(mobile)) return 'advisor'
	if (/^19600000003$/.test(mobile)) return 'service'
	if (/^19600000004$/.test(mobile)) return 'admin'
	if (/^19600000005$/.test(mobile)) return 'advisor'
	if (/^19600000006$/.test(mobile)) return 'advisor'
	if (/^19600000001$/.test(mobile)) return 'user'
	if (String(user.role || '').trim().toLowerCase() === 'admin') return 'admin'
	return ''
}

function cachedAuthorizedRole() {
	const user = getCachedUserInfo() || {}
	const role = String(user.role || '').trim().toLowerCase()
	return ['advisor', 'service', 'admin'].includes(role) ? role : ''
}

/**
 * 切换到用户端
 */
export function switchToUser() {
	setCurrentRole('user')
	if (isLoggedIn()) {
		request({ url: '/api/user/set-role', method: 'POST', data: { role: 'user' } }).catch(() => {})
	}
}

/**
 * 切换到银行老师端（需后端 TEACHER_ENABLE=true）
 * @returns {Promise<{ ok: boolean, errMsg?: string }>}
 */
export async function switchToAdvisor() {
	if (!isLoggedIn()) return { ok: false, errMsg: '请先登录' }
	const testRole = testRoleFromCachedUser()
	if (testRole && testRole !== 'advisor') return { ok: false, errMsg: '请使用银行经理测试号登录' }
	if (!testRole && !isLocalTestAuth() && cachedAuthorizedRole() !== 'advisor') return { ok: false, errMsg: '银行老师端需要平台认证账号' }
	if (testRole === 'advisor' || isLocalTestAuth()) {
		setCurrentRole('advisor')
		return { ok: true }
	}
	try {
		await request({ url: '/api/user/set-role', method: 'POST', data: { role: 'advisor' } })
		setCurrentRole('advisor')
		return { ok: true }
	} catch (e) {
		return { ok: false, errMsg: e && e.message ? e.message : '切换失败，老师端可能未启用' }
	}
}

/**
 * 切换到客服端
 * @returns {Promise<{ ok: boolean, errMsg?: string }>}
 */
export async function switchToService() {
	if (!isLoggedIn()) return { ok: false, errMsg: '请先登录' }
	const testRole = testRoleFromCachedUser()
	if (testRole && testRole !== 'service') return { ok: false, errMsg: '请使用客服测试号登录' }
	if (!testRole && !isLocalTestAuth() && cachedAuthorizedRole() !== 'service') return { ok: false, errMsg: '客服端需要平台认证账号' }
	if (testRole === 'service' || isLocalTestAuth()) {
		setCurrentRole('service')
		return { ok: true }
	}
	try {
		await request({ url: '/api/user/set-role', method: 'POST', data: { role: 'service' } })
		setCurrentRole('service')
		return { ok: true }
	} catch (e) {
		return { ok: false, errMsg: e && e.message ? e.message : '切换失败，客服端暂不可用' }
	}
}

/**
 * 切换到管理员端
 * @returns {Promise<{ ok: boolean, errMsg?: string }>}
 */
export async function switchToAdmin() {
	if (!isLoggedIn()) return { ok: false, errMsg: '请先登录' }
	const testRole = testRoleFromCachedUser()
	if (testRole && testRole !== 'admin') return { ok: false, errMsg: '请使用管理员测试号登录' }
	const cached = getCachedUserInfo() || {}
	if (testRole === 'admin' || String(cached.role || '').trim().toLowerCase() === 'admin' || isLocalTestAuth()) {
		setCurrentRole('admin')
		return { ok: true }
	}
	return { ok: false, errMsg: '管理员端需要平台授权账号' }
}

export function clearRole() {
	uni.removeStorageSync(ROLE_KEY)
	uni.removeStorageSync(ADVISOR_MODE_KEY)
}
