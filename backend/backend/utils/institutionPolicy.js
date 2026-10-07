'use strict'

const PLACEHOLDER_INSTITUTIONS = new Set([
	'合作银行',
	'合作机构',
	'未知机构',
	'待确认',
	'银行',
	'未知',
	'未填写',
	'暂无',
	'无',
	'null',
	'undefined',
	'-',
	'--'
])

const INSTITUTION_FAMILIES = [
	['平安', ['平安银行', '平安消费金融', '中国平安']],
	['兴业', ['兴业银行', '兴业消费金融']],
	['中国银行', ['中国银行', '中银消费金融', '中银']],
	['建设银行', ['中国建设银行', '建设银行', '建行', '建信']],
	['工商银行', ['中国工商银行', '工商银行', '工行']],
	['农业银行', ['中国农业银行', '农业银行', '农行']],
	['交通银行', ['交通银行', '交银']],
	['招商银行', ['招商银行', '招联消费金融', '招联']],
	['邮储银行', ['邮储银行', '中邮消费金融', '中邮']],
	['浦发银行', ['浦发银行', '浦银']],
	['上海银行', ['上海银行', '尚诚消费金融', '尚诚']],
	['上海农商银行', ['上海农商银行', '沪农商']],
	['中信银行', ['中信银行']],
	['海尔消费金融', ['海尔消费金融', '海尔']],
	['金美信消费金融', ['金美信消费金融', '金美信']]
]

function normalizedInstitution(value) {
	const text = String(value || '')
		.replace(/\s+/g, '')
		.replace(/股份有限公司|集团有限公司|有限责任公司|有限公司|集团公司|集团/g, '')
		.trim()
		.toLowerCase()
	return PLACEHOLDER_INSTITUTIONS.has(text) ? '' : text
}

function firstValidInstitution(...values) {
	for (const value of values) {
		if (normalizedInstitution(value)) return String(value).trim()
	}
	return ''
}

function institutionFamily(value) {
	const text = normalizedInstitution(value)
	if (!text) return ''
	const hit = INSTITUTION_FAMILIES.find(([, aliases]) => (
		aliases.some((alias) => {
			const normalizedAlias = normalizedInstitution(alias)
			if (text === normalizedAlias) return true
			if (!text.startsWith(normalizedAlias)) return false
			const branch = text.slice(normalizedAlias.length)
			return Boolean(branch && ['分行', '支行', '分公司', '营业部', '中心'].some((suffix) => branch.endsWith(suffix)))
		})
	))
	return hit ? hit[0] : ''
}

function institutionTextMatches(left, right) {
	const a = normalizedInstitution(left)
	const b = normalizedInstitution(right)
	if (!a || !b) return false
	if (a === b) return true
	const fa = institutionFamily(a)
	const fb = institutionFamily(b)
	return Boolean(fa && fb && fa === fb)
}

function contactInstitutionOf(item = {}) {
	const ctx = item.context && typeof item.context === 'object' ? item.context : {}
	const product = item.product && typeof item.product === 'object' ? item.product : {}
	const ctxProduct = ctx.product && typeof ctx.product === 'object' ? ctx.product : {}
	return firstValidInstitution(
		item.institution,
		item.parentInstitution,
		item.productInstitution,
		item.bankName,
		product.parentInstitution,
		product.institution,
		ctx.institution,
		ctx.parentInstitution,
		ctx.productInstitution,
		ctxProduct.parentInstitution,
		ctxProduct.institution,
		item.advisorInfo && item.advisorInfo.bank
	)
}

module.exports = {
	contactInstitutionOf,
	firstValidInstitution,
	institutionFamily,
	institutionTextMatches,
	normalizedInstitution
}
