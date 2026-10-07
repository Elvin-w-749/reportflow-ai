import { parseIdCardAgeGender } from './reportDetailAggregates.js'

const ID_KEYS = new Set([
	'idCard',
	'id_card',
	'idNo',
	'id_no',
	'idNumber',
	'id_number',
	'identityNo',
	'identity_no',
	'certificateNo',
	'certificate_no',
	'certNo',
	'cert_no',
	'credentialNo',
	'credential_no'
])

const PHONE_KEYS = new Set([
	'phone',
	'mobile',
	'mobilePhone',
	'mobile_phone',
	'phoneNumber',
	'phone_number',
	'tel',
	'telephone'
])

const ACCOUNT_KEYS = new Set([
	'accountNo',
	'account_no',
	'accountNumber',
	'account_number',
	'cardNo',
	'card_no',
	'cardNumber',
	'card_number',
	'bankCardNo',
	'bank_card_no',
	'creditCardNo',
	'credit_card_no',
	'loanAccountNo',
	'loan_account_no'
])

const keyOf = (key) => String(key || '').trim()

const sensitiveTypeOf = (key) => {
	const k = keyOf(key)
	if (ID_KEYS.has(k)) return 'id'
	if (PHONE_KEYS.has(k)) return 'phone'
	if (ACCOUNT_KEYS.has(k)) return 'account'
	return ''
}

const last4 = (value) => {
	const normalized = String(value || '').replace(/[^\dA-Za-zXx]/g, '')
	return normalized.length >= 4 ? normalized.slice(-4) : ''
}

const maskSensitive = (value) => {
	const suffix = last4(value)
	if (!suffix) return ''
	return `****${suffix}`
}

const sanitizeNode = (node) => {
	if (Array.isArray(node)) return node.map((item) => sanitizeNode(item))
	if (!node || typeof node !== 'object') return node
	const out = {}
	Object.keys(node).forEach((key) => {
		const type = sensitiveTypeOf(key)
		if (type) {
			out[key] = maskSensitive(node[key])
			return
		}
		out[key] = sanitizeNode(node[key])
	})
	return out
}

const findIdCard = (bi) => {
	if (!bi || typeof bi !== 'object') return ''
	return bi.idCard || bi.id_card || bi.idNo || bi.id_no || bi.idNumber || bi.id_number || ''
}

const enrichBasicInfo = (targetBi, sourceBi) => {
	if (!targetBi || typeof targetBi !== 'object') return targetBi
	const full = findIdCard(sourceBi)
	if (!full) return targetBi
	const { age, gender } = parseIdCardAgeGender(full)
	const next = { ...targetBi }
	if ((next.age == null || next.age === '') && age != null) next.age = age
	if (!next.gender && gender) next.gender = gender
	if (!next.id_last4) next.id_last4 = last4(full)
	delete next.idCard
	delete next.id_card
	delete next.idNo
	delete next.id_no
	delete next.idNumber
	delete next.id_number
	return next
}

export const desensitizeAnalysisForLocal = (analysisData) => {
	if (!analysisData || typeof analysisData !== 'object') return analysisData
	const safe = sanitizeNode(analysisData)
	if (safe.basicInfo && typeof safe.basicInfo === 'object') {
		safe.basicInfo = enrichBasicInfo(safe.basicInfo, analysisData.basicInfo)
	}
	if (safe.basic_info && typeof safe.basic_info === 'object') {
		safe.basic_info = enrichBasicInfo(safe.basic_info, analysisData.basic_info)
	}
	return safe
}

export default {
	desensitizeAnalysisForLocal
}
