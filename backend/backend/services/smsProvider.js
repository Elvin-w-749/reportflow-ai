const { tencentSendSms } = require("./smsProviderTencent")
'use strict'

const logger = require('../utils/logger')
const { maskPhone } = require('../utils/mask')

/**
 * 短信服务商抽象层
 *
 * 通过 SMS_PROVIDER 环境变量切换实现：
 *   - dev（默认）：console.log 打印验证码，非生产环境回传 devCode；仅用于本地联调，严禁用于生产
 *   - aliyun：阿里云短信服务（国内常用）
 *   - custom：自定义 HTTP 回调（内部通知系统等）
 *
 * 所有 Provider 必须实现：
 *   sendSms(phone, code, scene, opts?) → Promise<{ ok: boolean, error?: string }>
 *
 * scene 取值为 'login' | 'change-phone' | 'reset-password'，用于选择对应的短信模板。
 */

const crypto = require('crypto')

const PROVIDER = String(process.env.SMS_PROVIDER || 'dev').toLowerCase()

// ──────────────────────────────────────────────
// 安全提示：dev provider 会把验证码明文写进日志/响应体，仅供本地联调。
// 模块加载时打一次显式警告，避免误把 SMS_PROVIDER 默认值带上线。
// ──────────────────────────────────────────────
let devProviderNoticePrinted = false
function warnOnceAboutDevProvider() {
	if (devProviderNoticePrinted || PROVIDER !== 'dev') return
	devProviderNoticePrinted = true
	console.warn(
		'[sms] 开发模式：SMS_PROVIDER=dev，验证码将以明文写入日志并在非生产响应体里回传 devCode，严禁用于生产。'
		+ '部署前必须显式设置 SMS_PROVIDER=aliyun|custom（或 tencent）并配置对应密钥。'
	)
}
warnOnceAboutDevProvider()

// ──────────────────────────────────────────────
// DevProvider — 开发/联调用
// ──────────────────────────────────────────────

/** @returns {Promise<{ ok: boolean, error?: string }>} */
async function devSendSms(phone, code, scene) {
	const label = scene === 'login' ? '登录验证码' : '短信验证码'
	// 安全基线：日志不打印完整手机号
	const masked = maskPhone(phone)
	console.log(`[sms:dev] 开发模式：验证码以明文返回，严禁用于生产 | ${label} → ${masked} | code = ${code}`)
	return { ok: true }
}

// ──────────────────────────────────────────────
// AliyunProvider — 阿里云短信服务
// ──────────────────────────────────────────────

/**
 * 阿里云短信 API 签名（POP 签名协议 v1）
 * 文档：https://help.aliyun.com/document_detail/101300.html
 */
function aliyunSign(params, accessKeySecret) {
	const sortedKeys = Object.keys(params).sort()
	const canonical = sortedKeys
		.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
		.join('&')
	const stringToSign = `GET&${encodeURIComponent('/')}&${encodeURIComponent(canonical)}`
	const key = `${accessKeySecret}&`
	return crypto.createHmac('sha1', key).update(stringToSign).digest('base64')
}

/** @returns {Promise<{ ok: boolean, error?: string }>} */
async function aliyunSendSms(phone, code, scene) {
	const accessKeyId = String(process.env.SMS_ALIYUN_ACCESS_KEY_ID || '').trim()
	const accessKeySecret = String(process.env.SMS_ALIYUN_ACCESS_KEY_SECRET || '').trim()
	const signName = String(process.env.SMS_ALIYUN_SIGN_NAME || '').trim()
	const loginTemplate = String(process.env.SMS_ALIYUN_TEMPLATE_LOGIN || '').trim()
	const changePhoneTemplate = String(process.env.SMS_ALIYUN_TEMPLATE_CHANGE_PHONE || '').trim()
	const resetPasswordTemplate = String(process.env.SMS_ALIYUN_TEMPLATE_RESET_PASSWORD || '').trim()

	if (!accessKeyId || !accessKeySecret || !signName) {
		return { ok: false, error: '阿里云短信未完整配置（AccessKey/签名缺失），请检查环境变量' }
	}

	const templateCode = scene === 'change-phone'
		? changePhoneTemplate
		: scene === 'reset-password'
			? (resetPasswordTemplate || loginTemplate)
			: loginTemplate
	if (!templateCode) {
		return { ok: false, error: `短信场景 "${scene}" 未配置模板` }
	}

	const params = {
		AccessKeyId: accessKeyId,
		Action: 'SendSms',
		Format: 'JSON',
		PhoneNumbers: phone,
		SignName: signName,
		SignatureMethod: 'HMAC-SHA1',
		SignatureNonce: crypto.randomBytes(16).toString('hex'),
		SignatureVersion: '1.0',
		TemplateCode: templateCode,
		TemplateParam: JSON.stringify({ code }),
		Timestamp: new Date().toISOString().replace(/\.\d{3}/, ''),
		Version: '2017-05-25'
	}

	params.Signature = aliyunSign(params, accessKeySecret)

	const qs = Object.keys(params)
		.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
		.join('&')

	try {
		const url = `https://dysmsapi.aliyuncs.com/?${qs}`
		const ctrl = new AbortController()
		const t = setTimeout(() => ctrl.abort(), 10000)
		const res = await fetch(url, { method: 'GET', signal: ctrl.signal })
		clearTimeout(t)

		const body = await res.json().catch(() => ({}))
		if (body.Code === 'OK') {
			console.log(`[sms:aliyun] sent → ${maskPhone(phone)} scene=${scene}`)
			return { ok: true }
		}
		const errMsg = body.Message || body.Code || `HTTP ${res.status}`
		logger.error({ errMsg, phone: maskPhone(phone), scene }, 'sms:aliyun send failed')
		return { ok: false, error: errMsg }
	} catch (e) {
		const errMsg = e && e.message ? e.message : '网络请求失败'
		logger.error({ errMsg, phone: maskPhone(phone), scene }, 'sms:aliyun request error')
		return { ok: false, error: errMsg }
	}
}

// ──────────────────────────────────────────────
// CustomProvider — 自定义 HTTP 回调
// ──────────────────────────────────────────────

/** @returns {Promise<{ ok: boolean, error?: string }>} */
async function customSendSms(phone, code, scene) {
	const url = String(process.env.SMS_CUSTOM_URL || '').trim()
	if (!url) return { ok: false, error: 'SMS_CUSTOM_URL 未配置' }

	const token = String(process.env.SMS_CUSTOM_BEARER || '').trim()
	const headers = { 'Content-Type': 'application/json' }
	if (token) headers['Authorization'] = `Bearer ${token}`

	try {
		const ctrl = new AbortController()
		const t = setTimeout(() => ctrl.abort(), 10000)
		const res = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify({ phone, code, scene }),
			signal: ctrl.signal
		})
		clearTimeout(t)
		if (res.ok) {
			console.log(`[sms:custom] sent → ${maskPhone(phone)} scene=${scene}`)
			return { ok: true }
		}
		const text = await res.text().catch(() => '')
		return { ok: false, error: `HTTP ${res.status}: ${String(text).slice(0, 200)}` }
	} catch (e) {
		return { ok: false, error: e && e.message ? e.message : '网络请求失败' }
	}
}

// ──────────────────────────────────────────────
// 路由分发
// ──────────────────────────────────────────────

const providerMap = {
  tencent: tencentSendSms,
	dev: devSendSms,
	aliyun: aliyunSendSms,
	custom: customSendSms
}

const sendFn = providerMap[PROVIDER]

if (!sendFn) {
	logger.warn({ provider: PROVIDER }, 'sms: unknown SMS_PROVIDER, falling back to dev mode')
}

/**
 * 发送短信验证码
 * @param {string} phone 手机号
 * @param {string} code  6 位验证码
 * @param {string} scene 场景标识：'login' | 'change-phone' | 'reset-password'
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function sendSms(phone, code, scene) {
	const fn = sendFn || devSendSms
	try {
		return await fn(phone, code, scene)
	} catch (e) {
		logger.error({ err: e }, 'sms: unexpected provider exception')
		return { ok: false, error: '短信服务异常' }
	}
}

module.exports = { sendSms, PROVIDER }
