// 腾讯云短信 provider（TC3-HMAC-SHA256）。独立模块，仅依赖 crypto + 全局 fetch。
const crypto = require('crypto')
const _mask = (p) => { const s = String(p || ''); return s.length >= 7 ? s.slice(0,3) + '****' + s.slice(-2) : s }
const _sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
const _hmac = (key, s) => crypto.createHmac('sha256', key).update(s, 'utf8').digest()

async function tencentSendSms(phone, code, scene) {
  const secretId  = String(process.env.SMS_TENCENT_SECRET_ID || '').trim()
  const secretKey = String(process.env.SMS_TENCENT_SECRET_KEY || '').trim()
  const sdkAppId  = String(process.env.SMS_TENCENT_SDK_APP_ID || '').trim()
  const signName  = String(process.env.SMS_TENCENT_SIGN_NAME || '').trim()
  const loginTpl  = String(process.env.SMS_TENCENT_TEMPLATE_LOGIN || '').trim()
  const changeTpl = String(process.env.SMS_TENCENT_TEMPLATE_CHANGE_PHONE || '').trim()
  const resetTpl  = String(process.env.SMS_TENCENT_TEMPLATE_RESET_PASSWORD || '').trim()
  const region    = String(process.env.SMS_TENCENT_REGION || 'ap-guangzhou').trim()
  const expireMin = String(process.env.SMS_TENCENT_EXPIRE_MIN || '').trim()

  if (!secretId || !secretKey || !sdkAppId || !signName) {
    return { ok: false, error: '腾讯云短信未完整配置（SecretId/SecretKey/SdkAppId/签名缺失）' }
  }
  const templateId = scene === 'change-phone' ? changeTpl : (scene === 'reset-password' ? (resetTpl || loginTpl) : loginTpl)
  if (!templateId) return { ok: false, error: '短信场景 "' + scene + '" 未配置模板' }

  const endpoint = 'sms.tencentcloudapi.com', service = 'sms', action = 'SendSms', version = '2021-01-11'
  const e164 = String(phone).startsWith('+') ? String(phone) : ('+86' + phone)
  const params = expireMin ? [String(code), expireMin] : [String(code)]
  const payload = JSON.stringify({ PhoneNumberSet: [e164], SmsSdkAppId: sdkAppId, SignName: signName, TemplateId: templateId, TemplateParamSet: params })

  const tsNow = Math.floor(Date.now() / 1000)
  const date = new Date(tsNow * 1000).toISOString().slice(0, 10)
  const ct = 'application/json; charset=utf-8'
  const canonicalHeaders = 'content-type:' + ct + '\nhost:' + endpoint + '\nx-tc-action:' + action.toLowerCase() + '\n'
  const signedHeaders = 'content-type;host;x-tc-action'
  const canonicalRequest = 'POST\n/\n\n' + canonicalHeaders + '\n' + signedHeaders + '\n' + _sha256hex(payload)
  const credentialScope = date + '/' + service + '/tc3_request'
  const stringToSign = 'TC3-HMAC-SHA256\n' + tsNow + '\n' + credentialScope + '\n' + _sha256hex(canonicalRequest)
  const kSigning = _hmac(_hmac(_hmac('TC3' + secretKey, date), service), 'tc3_request')
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')
  const authorization = 'TC3-HMAC-SHA256 Credential=' + secretId + '/' + credentialScope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature

  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 10000)
    const res = await fetch('https://' + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': ct, 'Host': endpoint, 'X-TC-Action': action, 'X-TC-Version': version, 'X-TC-Timestamp': String(tsNow), 'X-TC-Region': region, 'Authorization': authorization },
      body: payload, signal: ctrl.signal
    })
    clearTimeout(t)
    const body = await res.json().catch(() => ({}))
    const resp = body && body.Response
    if (resp && resp.Error) { console.error('[sms:tencent] fail', resp.Error.Code, resp.Error.Message, 'phone=' + _mask(phone)); return { ok: false, error: resp.Error.Code + ': ' + resp.Error.Message } }
    const st = resp && Array.isArray(resp.SendStatusSet) ? resp.SendStatusSet[0] : null
    if (st && st.Code === 'Ok') { console.log('[sms:tencent] sent ->', _mask(phone), 'scene=' + scene); return { ok: true } }
    console.error('[sms:tencent] fail', st && st.Code, st && st.Message, 'phone=' + _mask(phone))
    return { ok: false, error: st ? (st.Code + ': ' + st.Message) : ('未知响应 HTTP ' + res.status) }
  } catch (e) { return { ok: false, error: e && e.message ? e.message : '网络请求失败' } }
}
module.exports = { tencentSendSms }
