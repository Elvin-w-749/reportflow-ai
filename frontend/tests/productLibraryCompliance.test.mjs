import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const productLibraryPath = join(__dirname, '..', 'src', 'shared', 'productLibrary.json')
const productLibrary = JSON.parse(readFileSync(productLibraryPath, 'utf8'))

// 只校验数据结构与取值口径，不校验具体机构/产品/地域内容：
// 仓库内 productLibrary.json 是合成样例数据（不对应真实机构与真实产品），
// 任何「真实机构名单」「官方域名白名单」「地域必须包含某城市」的断言都不再适用。
// 这里保留的是会让下游查表与统计真正走偏的结构性不变量。

/** 每条产品都必须出现的字段 */
const REQUIRED_FIELDS = [
	'id', 'name', 'institution', 'institutionType', 'serviceArea', 'category',
	'rateText', 'amountText', 'termText', 'tags', 'sourceUrl', 'sourceNote', 'rules'
]
/** 允许出现但并非每条都需要的字段；出现即必须是合法类型 */
const OPTIONAL_ARRAY_FIELDS = ['requiredMaterials']
const OPTIONAL_STRING_FIELDS = ['parentInstitution', 'eligibilityText']
/** 匹配引擎与详情页模板按 category 取模板，取值必须落在这个集合内 */
const ALLOWED_CATEGORIES = new Set(['credit_loan', 'mortgage', 'merchant_loan', 'credit_card'])
/** 每条规则的必备字段：matchEngine/准入判断直接读这些键 */
const REQUIRED_RULE_FLAGS = ['allowLianSan', 'allowOverdue']
const REQUIRED_RULE_NUMBERS = ['minScore', 'maxDebtRatio', 'maxQueryCount', 'maxNonBankRatio', 'maxInstitutions']
/** 编码形状：小写字母/数字分段，末段为三位序号，与查表用的 id 一致 */
const PRODUCT_ID_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*_\d{3}$/
/**
 * 引擎「按字面量查表」的取值点：matchEngine 默认推荐写死了产品编码，
 * 编码不在库里时引擎抛错而不兜底，所以这里把它声明的编码逐个先查一遍。
 * 抽不到任何编码同样算失败，避免改名后这条断言悄悄变成空转。
 */
const DEFAULT_PRODUCT_CODE_RE = /id:\s*'([a-z][a-z0-9_]*_\d{3})'/g
const matchEngineSource = readFileSync(join(__dirname, '..', 'src', 'services', 'matchEngine.js'), 'utf8')
const defaultProductCodes = [...matchEngineSource.matchAll(DEFAULT_PRODUCT_CODE_RE)].map((found) => found[1])
/** 演示数据的来源链接必须落在 RFC 2606 保留域名上，防止真实业务链接回流 */
const DOCUMENTATION_HOSTS = new Set(['example.com', 'example.org', 'example.net', 'example.edu'])

const percentOf = (text, id, field) => {
	const match = /(\d+(?:\.\d+)?)\s*%/.exec(String(text || ''))
	assert.ok(match, `${id} ${field} must carry a percentage number, got: ${text}`)
	return Number(match[1])
}

const numberWithUnitOf = (text, id, field) => {
	const match = /(\d+(?:\.\d+)?)\s*(万|亿)/.exec(String(text || ''))
	assert.ok(match, `${id} ${field} must carry an amount with a 万/亿 unit, got: ${text}`)
	return Number(match[1]) * (match[2] === '亿' ? 10000 : 1)
}

const periodsOf = (text, id, field) => {
	const match = /(\d+(?:\.\d+)?)\s*(?:期|个月|年|月)/.exec(String(text || ''))
	assert.ok(match, `${id} ${field} must carry a term number, got: ${text}`)
	return Number(match[1]) * (/年/.test(String(text || '')) && !/个月/.test(String(text || '')) ? 12 : 1)
}

describe('Product library structural contract', () => {
	it('parses as a non-empty array of uniform records', () => {
		assert.ok(Array.isArray(productLibrary), 'product library must be an array')
		assert.ok(productLibrary.length >= 12, `product library looks too small: ${productLibrary.length}`)

		for (const product of productLibrary) {
			assert.ok(product && typeof product === 'object' && !Array.isArray(product), 'each record must be an object')
			for (const field of REQUIRED_FIELDS) {
				assert.ok(Object.prototype.hasOwnProperty.call(product, field), `${product.id} is missing required field ${field}`)
			}
			const unknown = Object.keys(product).filter((field) => (
				!REQUIRED_FIELDS.includes(field)
				&& !OPTIONAL_ARRAY_FIELDS.includes(field)
				&& !OPTIONAL_STRING_FIELDS.includes(field)
			))
			assert.deepEqual(unknown, [], `${product.id} carries undeclared fields: ${unknown.join(', ')}`)
		}
	})

	it('keeps ids unique and shaped like the codes the match engine looks up', () => {
		const ids = new Set()
		for (const product of productLibrary) {
			assert.match(product.id, PRODUCT_ID_RE, `${product.id} is not a well-shaped product code`)
			assert.equal(ids.has(product.id), false, `${product.id} is duplicated`)
			ids.add(product.id)
			assert.ok(product.name.trim().length >= 2, `${product.id} name is too short to render`)
			assert.ok(product.institution.trim(), `${product.id} institution must be non-empty`)
		}
		assert.ok(defaultProductCodes.length >= 4,
			`the default recommendation table should declare its product codes, found ${defaultProductCodes.length}`)
		for (const code of defaultProductCodes) {
			assert.ok(ids.has(code), `matchEngine looks up ${code} but productLibrary.json carries no such id`)
		}
	})

	it('keeps required text fields non-empty and typed', () => {
		for (const product of productLibrary) {
			for (const field of REQUIRED_FIELDS.filter((key) => key !== 'tags' && key !== 'rules')) {
				assert.equal(typeof product[field], 'string', `${product.id} ${field} must be a string`)
				assert.ok(product[field].trim(), `${product.id} ${field} must not be blank`)
			}
			assert.ok(Array.isArray(product.tags), `${product.id} tags must be an array`)
			assert.ok(product.tags.length > 0, `${product.id} tags must not be empty`)
			assert.ok(product.tags.every((tag) => typeof tag === 'string' && tag.trim()), `${product.id} tags must be non-empty strings`)

			for (const field of OPTIONAL_STRING_FIELDS) {
				if (field in product) assert.equal(typeof product[field], 'string', `${product.id} ${field} must be a string`)
			}
			for (const field of OPTIONAL_ARRAY_FIELDS) {
				if (field in product) {
					assert.ok(Array.isArray(product[field]), `${product.id} ${field} must be an array`)
					assert.ok(product[field].every((item) => typeof item === 'string' && item.trim()), `${product.id} ${field} items must be strings`)
				}
			}
		}
	})

	it('keeps category values inside the enum the detail templates resolve', () => {
		for (const product of productLibrary) {
			assert.ok(ALLOWED_CATEGORIES.has(product.category), `${product.id} has unknown category ${product.category}`)
		}
		assert.ok(ALLOWED_CATEGORIES.size >= 2 && new Set(productLibrary.map((p) => p.category)).size >= 2,
			'library must span more than one category for the templates to be exercised')
	})

	it('keeps rate, amount and term texts machine-readable and inside plausible ranges', () => {
		for (const product of productLibrary) {
			const rate = percentOf(product.rateText, product.id, 'rateText')
			assert.ok(rate > 0 && rate <= 36, `${product.id} rate ${rate}% is outside the plausible 0-36% band`)

			if (/分期费率/.test(product.rateText)) {
				assert.ok(rate <= 1, `${product.id} installment rate ${rate}% should be a monthly fee rate below 1%`)
			}

			const amount = numberWithUnitOf(product.amountText, product.id, 'amountText')
			assert.ok(amount >= 0.1 && amount <= 100000, `${product.id} amount ${amount}万 is outside the plausible credit band`)

			const term = periodsOf(product.termText, product.id, 'termText')
			assert.ok(term >= 1 && term <= 360, `${product.id} term ${term} months is outside the plausible 1-360 band`)
		}
	})

	it('keeps admission rules complete and within sane numeric bounds', () => {
		for (const product of productLibrary) {
			const rules = product.rules
			assert.ok(rules && typeof rules === 'object' && !Array.isArray(rules), `${product.id} rules must be an object`)

			for (const flag of REQUIRED_RULE_FLAGS) {
				assert.equal(typeof rules[flag], 'boolean', `${product.id} rules.${flag} must be a boolean`)
			}
			for (const key of REQUIRED_RULE_NUMBERS) {
				const value = rules[key]
				assert.equal(typeof value, 'number', `${product.id} rules.${key} must be a number`)
				assert.ok(Number.isFinite(value), `${product.id} rules.${key} must be finite`)
			}
			assert.ok(rules.minScore >= 0 && rules.minScore <= 100, `${product.id} rules.minScore ${rules.minScore} out of 0-100`)
			assert.ok(rules.maxDebtRatio >= 0 && rules.maxDebtRatio <= 1, `${product.id} rules.maxDebtRatio ${rules.maxDebtRatio} out of 0-1`)
			assert.ok(rules.maxNonBankRatio >= 0 && rules.maxNonBankRatio <= 1, `${product.id} rules.maxNonBankRatio ${rules.maxNonBankRatio} out of 0-1`)
			assert.ok(Number.isInteger(rules.maxQueryCount) && rules.maxQueryCount >= 0, `${product.id} rules.maxQueryCount must be a non-negative integer`)
			assert.ok(Number.isInteger(rules.maxInstitutions) && rules.maxInstitutions >= 0, `${product.id} rules.maxInstitutions must be a non-negative integer`)

			for (const [key, value] of Object.entries(rules)) {
				if (key.endsWith('Ratio')) assert.ok(value >= 0 && value <= 1, `${product.id} rules.${key} must stay a 0-1 ratio`)
				if (key.startsWith('prefer')) assert.equal(typeof value, 'boolean', `${product.id} rules.${key} must be a boolean`)
				if (key.startsWith('require')) assert.equal(typeof value, 'boolean', `${product.id} rules.${key} must be a boolean`)
			}
		}
	})

	it('keeps an https source link on a reserved documentation host plus a source note', () => {
		for (const product of productLibrary) {
			const url = new URL(product.sourceUrl)
			assert.equal(url.protocol, 'https:', `${product.id} source must use HTTPS`)
			assert.ok(DOCUMENTATION_HOSTS.has(url.hostname), `${product.id} source host ${url.hostname} is not a reserved documentation host`)
			assert.ok(product.sourceNote.trim(), `${product.id} sourceNote is required`)
		}
	})

	it('spans several institutions and institution types instead of a single issuer', () => {
		const institutions = new Set(productLibrary.map((p) => p.institution))
		const types = new Set(productLibrary.map((p) => p.institutionType))
		assert.ok(institutions.size >= 5, `library should cover multiple institutions, got ${institutions.size}`)
		assert.ok(types.size >= 2, `library should cover multiple institution types, got ${types.size}`)
		for (const product of productLibrary) {
			assert.ok(product.institutionType.trim().length >= 2, `${product.id} institutionType is too short`)
		}
	})
})
