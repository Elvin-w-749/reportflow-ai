import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { summarizeCreditCardUtilization } from '../src/utils/creditCardUtilization.js'

describe('credit card utilization evidence policy', () => {
	it('keeps rows independent when only institution, opening date and card tail match', () => {
		const result = summarizeCreditCardUtilization([
			{ institution: '测试银行', start_date: '2020-01-01', type: '贷记卡（人民币账户，尾号8744）', credit_limit: 100000, used_limit: 60000 },
			{ institution: '测试银行', start_date: '2020-01-01', type: '贷记卡（人民币账户，尾号8744）', credit_limit: 50000, used_limit: 15000 }
		])

		assert.equal(result.status, 'computed')
		assert.equal(result.decisionEligible, true)
		assert.equal(result.totalLimit, 150000)
		assert.equal(result.totalUsed, 75000)
		assert.equal(result.usageRate, 0.5)
		assert.equal(result.utilizationGroupCount, 2)
		assert.equal(result.sharedGroupCount, 0)
		assert.equal(result.inferredSharedGroupCount, 0)
	})

	it('deduplicates only an explicitly identified shared-credit group', () => {
		const result = summarizeCreditCardUtilization([
			{ currency: 'CNY', shared_credit_group: 'facility-8744', utilization_included: true, credit_limit: 48000, used_limit: 44975 },
			{ currency: 'USD', shared_credit_group: 'facility-8744', utilization_included: false, credit_limit: 58993, used_limit: 0 }
		])

		assert.equal(result.status, 'computed')
		assert.equal(result.decisionEligible, true)
		assert.equal(result.totalLimit, 48000)
		assert.equal(result.totalUsed, 44975)
		assert.equal(result.sharedGroupCount, 1)
		assert.equal(result.excludedAccountCount, 1)
		assert.deepEqual(result.rowDecisions.map((row) => row.status), ['included', 'excluded'])
	})

	it('uses an explicit parent-child relationship without counting the child twice', () => {
		const result = summarizeCreditCardUtilization([
			{ account_id: 'facility-parent', shared_limit_role: 'parent', currency: 'CNY', credit_limit: 80000, used_limit: 20000 },
			{ parent_account_id: 'facility-parent', shared_limit_role: 'child', currency: 'CNY', credit_limit: 80000, used_limit: 5000 }
		])

		assert.equal(result.status, 'computed')
		assert.equal(result.totalLimit, 80000)
		assert.equal(result.totalUsed, 20000)
		assert.equal(result.sharedGroupCount, 1)
		assert.deepEqual(result.rowDecisions.map((row) => row.status), ['included', 'excluded'])
	})

	it('marks a standalone foreign-currency row unknown without CNY conversion evidence', () => {
		const result = summarizeCreditCardUtilization([
			{ currency: 'USD', credit_limit: 1000, used_limit: 500 }
		])

		assert.equal(result.status, 'unknown')
		assert.equal(result.decisionEligible, false)
		assert.equal(result.totalLimit, 0)
		assert.equal(result.totalUsed, 0)
		assert.equal(result.rawTotalLimit, 1000)
		assert.equal(result.rawTotalUsed, 500)
		assert.equal(result.usageRate, null)
		assert.equal(result.unknownAccountCount, 1)
	})

	it('does not treat explicit inclusion as an exchange rate for a known foreign currency', () => {
		const result = summarizeCreditCardUtilization([
			{ currency: 'USD', utilization_included: true, credit_limit: 1000, used_limit: 500 }
		])

		assert.equal(result.status, 'unknown')
		assert.equal(result.decisionEligible, false)
		assert.equal(result.usageRate, null)
	})

	it('honors an explicit foreign-currency exclusion without publishing a false usage rate', () => {
		const result = summarizeCreditCardUtilization([
			{ currency: 'USD', utilization_included: false, credit_limit: 1000, used_limit: 500 }
		])

		assert.equal(result.status, 'not_applicable')
		assert.equal(result.decisionEligible, true)
		assert.equal(result.excludedAccountCount, 1)
		assert.equal(result.groups[0].status, 'excluded')
		assert.equal(result.totalLimit, 0)
	})

	it('converts a foreign-currency row only with an explicit CNY exchange rate', () => {
		const result = summarizeCreditCardUtilization([
			{ currency: 'USD', exchange_rate_to_cny: 7.2, credit_limit: 1000, used_limit: 500 }
		])

		assert.equal(result.status, 'computed')
		assert.equal(result.totalLimit, 7200)
		assert.equal(result.totalUsed, 3600)
		assert.equal(result.usageRate, 0.5)
		assert.equal(result.rowDecisions[0].conversionBasis, 'explicit-cny-exchange-rate')
	})

	it('requires explicit inclusion before an unknown-currency row can enter the CNY aggregate', () => {
		const unknown = summarizeCreditCardUtilization([
			{ credit_limit: 30000, used_limit: 12000 }
		])
		const explicitlyIncluded = summarizeCreditCardUtilization([
			{ utilization_included: true, credit_limit: 30000, used_limit: 12000 }
		])

		assert.equal(unknown.status, 'unknown')
		assert.equal(unknown.usageRate, null)
		assert.equal(explicitlyIncluded.status, 'computed')
		assert.equal(explicitlyIncluded.usageRate, 0.4)
	})

	it('ignores generated legacy tail/date groups as relationship evidence', () => {
		for (const utilizationGroup of ['tail:8744', 'date:2020-01-01', 'row:0']) {
			const result = summarizeCreditCardUtilization([
				{ currency: 'CNY', utilization_group: utilizationGroup, credit_limit: 10000, used_limit: 2000 },
				{ currency: 'CNY', utilization_group: utilizationGroup, credit_limit: 20000, used_limit: 6000 }
			])

			assert.equal(result.totalLimit, 30000, utilizationGroup)
			assert.equal(result.totalUsed, 8000, utilizationGroup)
			assert.equal(result.utilizationGroupCount, 2, utilizationGroup)
			assert.equal(result.sharedGroupCount, 0, utilizationGroup)
		}
	})

	it('normalizes negative relationship sentinels across group and parent aliases', () => {
		const sentinels = ['无', '未共享', '无共享', '未设置', '不共享', '不适用', 'N/A', 'none', 'null', '-', '--']
		const relationFields = [
			'shared_credit_group',
			'utilization_group',
			'parent_account_id',
			'parent_card_id',
			'shared_limit_parent_id'
		]

		for (const field of relationFields) {
			for (const sentinel of sentinels) {
				const result = summarizeCreditCardUtilization([
					{ currency: 'CNY', [field]: sentinel, credit_limit: 10000, used_limit: 2000 },
					{ currency: 'CNY', [field]: sentinel, credit_limit: 20000, used_limit: 6000 }
				])

				assert.equal(result.totalLimit, 30000, `${field}=${sentinel}`)
				assert.equal(result.totalUsed, 8000, `${field}=${sentinel}`)
				assert.equal(result.utilizationGroupCount, 2, `${field}=${sentinel}`)
				assert.equal(result.sharedGroupCount, 0, `${field}=${sentinel}`)
			}
		}
	})
})
