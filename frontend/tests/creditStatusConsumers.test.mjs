import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { buildParsedFromAINormalized } from '../src/services/aiSchemaAdapter.js'

describe('shared overdue status semantics', () => {
	it('does not let the AI schema adapter manufacture overdue days from negated text', () => {
		const parsed = buildParsedFromAINormalized({
			basic_info: {},
			overdue_summary: {},
			query_records: {},
			credit_report_full: {
				loan_details: {
					bank_loans: [{ institution: '甲银行', status: '当前无逾期', balance: 1, credit_limit: 2 }],
					non_bank_loans: []
				},
				credit_card_details: [{ institution: '乙银行', status: '未逾期', credit_limit: 2, used_limit: 1 }]
			}
		})

		assert.deepEqual(parsed.creditAccounts.map((account) => account.overdueDays), [0, 0])
		assert.deepEqual(parsed.creditAccounts.map((account) => account.overdueLevel), ['none', 'none'])
		assert.deepEqual(parsed.creditAccounts.map((account) => account.isOverdue), [false, false])
	})

	it('routes the debt-management page through the shared text classifier', () => {
		const source = readFileSync(new URL('../src/pages/profile/DebtManage.vue', import.meta.url), 'utf8')
		assert.match(source, /import \{ statusIndicatesOverdue, statusIsUnknown \} from '@\/utils\/creditStatus\.js'/)
		assert.match(source, /statusIndicatesOverdue\(raw\.status\)/)
		assert.doesNotMatch(source, /\/逾期\/\.test\(String\(raw\.status/)
	})
})
