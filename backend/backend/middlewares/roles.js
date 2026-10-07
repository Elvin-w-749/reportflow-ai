'use strict'

const { fail } = require('../utils/response')
const store = require('../db/store')

const ROLE_ALIASES = {
	user: new Set(['', 'user']),
	advisor: new Set(['advisor', 'teacher', 'bank_teacher']),
	service: new Set(['service', 'customer_service', 'support', 'cs']),
	publisher: new Set(['publisher', 'editor', 'content', 'operator']),
	monitor: new Set(['monitor', 'ops']),
	admin: new Set(['admin'])
}

function normalizedRole(user) {
	const role = String((user && user.role) || 'user').trim().toLowerCase()
	if (ROLE_ALIASES.advisor.has(role)) return 'advisor'
	if (ROLE_ALIASES.service.has(role)) return 'service'
	if (ROLE_ALIASES.publisher.has(role)) return 'publisher'
	if (ROLE_ALIASES.monitor.has(role)) return 'monitor'
	if (ROLE_ALIASES.admin.has(role)) return 'admin'
	return 'user'
}

function hasRole(user, roles = []) {
	const current = normalizedRole(user)
	const allowed = new Set((Array.isArray(roles) ? roles : [roles]).map((role) => String(role || '').trim().toLowerCase()))
	if (allowed.has(current)) return true
	if (current === 'admin' && (allowed.has('advisor') || allowed.has('service') || allowed.has('publisher') || allowed.has('monitor') || allowed.has('user'))) return true
	return false
}

function requireRoles(roles, message = '无权访问该功能') {
	return (req, res, next) => {
		const user = store.findUserById(req.user && req.user.uid)
		if (!user) return fail(res, 2001, 'user not found', null, 401)
		if (!hasRole(user, roles)) return fail(res, 3003, message, null, 403)
		req._authUser = user
		req._authRole = normalizedRole(user)
		next()
	}
}

module.exports = {
	normalizedRole,
	hasRole,
	requireRoles
}
