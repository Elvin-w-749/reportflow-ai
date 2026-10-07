import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const originalWarn = console.warn
console.warn = () => {}
const { desensitizeAnalysisForLocal } = await import('../src/utils/privacy.js')
console.warn = originalWarn

describe('privacy helpers', () => {
	it('removes full identifiers from local analysis cache deeply', () => {
		const fullId = '110105198806153219'
		const phone = '13800138000'
		const account = '6222001234567890'
		const original = {
			basicInfo: {
				name: '张先生',
				idCard: fullId,
				phone
			},
			creditReportV2: {
				basic_info: {
					id_card: fullId
				}
			},
			accounts: [
				{
					accountNo: account,
					cardNumber: account,
					mobilePhone: phone
				}
			]
		}

		const safe = desensitizeAnalysisForLocal(original)
		const serialized = JSON.stringify(safe)

		assert.equal(safe.basicInfo.idCard, undefined)
		assert.equal(safe.basicInfo.id_last4, '3219')
		assert.equal(safe.basicInfo.gender, '男')
		assert.match(safe.creditReportV2.basic_info.id_card, /^\*{4}3219$/)
		assert.match(safe.accounts[0].accountNo, /^\*{4}7890$/)
		assert.match(safe.accounts[0].mobilePhone, /^\*{4}8000$/)
		assert.equal(serialized.includes(fullId), false)
		assert.equal(serialized.includes(phone), false)
		assert.equal(serialized.includes(account), false)
		assert.equal(original.basicInfo.idCard, fullId)
	})
})
