'use strict'

const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const { fail } = require('../utils/response')
const store = require('../db/store')
const { isProductionRuntime } = require('../utils/env')

const FORBIDDEN_PRODUCTION_SECRETS = new Set(['', 'dev-jwt-secret', 'dev', 'changeme', 'change-me', 'secret', 'test123', 'password', '123456'])

// 不再内置任何默认 JWT 密钥：仓库里写死的密钥等于公开密钥，任何人都能自签 admin token。
// 非生产环境缺少 JWT_SECRET 时，改为每个进程临时随机生成一次（进程内稳定，重启即失效），
// 并在启动日志打一行提示；提示只说明来源，绝不打印密钥本身。生产环境保持 fail-closed 抛错。
let ephemeralJwtSecret = null
let ephemeralNoticePrinted = false

function getEphemeralJwtSecret() {
	if (!ephemeralJwtSecret) ephemeralJwtSecret = crypto.randomBytes(32).toString('hex')
	if (!ephemeralNoticePrinted) {
		ephemeralNoticePrinted = true
		console.warn(
			'[auth] 未设置 JWT_SECRET，已为本进程随机生成临时密钥。'
			+ '该密钥不落盘：进程重启后旧 Token 全部失效，本地数据里按密钥派生的登录名索引也会失效，'
			+ '如需稳定请在 .env 里设置一个强随机 JWT_SECRET。生产环境禁止走此分支。'
		)
	}
	return ephemeralJwtSecret
}

function resolveJwtSecret() {
	const raw = String(process.env.JWT_SECRET || '').trim()
	if (isProductionRuntime()) {
		if (FORBIDDEN_PRODUCTION_SECRETS.has(raw.toLowerCase())) {
			throw new Error('[安全门禁] 生产环境必须配置非默认的 JWT_SECRET（环境变量），请在部署时注入')
		}
		return raw
	}
	return raw || getEphemeralJwtSecret()
}

if (isProductionRuntime()) {
	resolveJwtSecret()
}

function verifyAuthToken(token) {
	const secret = resolveJwtSecret()
	const payload = jwt.verify(token, secret, { algorithms: ['HS256'] })
	const uid = payload.uid || payload.userId
	if (!uid || typeof uid !== 'string') {
		throw new Error('invalid token uid')
	}

	const user = store.findUserById(uid)
	if (!user) {
		throw new Error('user not found')
	}

	const expectedVersion = Number(user.tokenVersion || 0)
	const actualVersion = Number(payload.tokenVersion || 0)
	if (actualVersion !== expectedVersion) {
		throw new Error('stale token')
	}

	return { uid, phone: payload.phone || user.phone || '', tokenVersion: expectedVersion }
}

function authRequired(req, res, next) {
	const header = req.headers.authorization || ''
	if (!header.startsWith('Bearer ')) {
		return fail(res, 1002, 'unauthorized', null, 401)
	}

	const token = header.slice(7)
	try {
		req.user = verifyAuthToken(token)
		return next()
	} catch (_) {
		return fail(res, 1002, 'invalid token', null, 401)
	}
}

module.exports = { authRequired, resolveJwtSecret, verifyAuthToken }
