import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { aiToInternalDimensions } from '../src/services/aiSchemaAdapter.js'
import {
	enrichDimensions,
	applyVisionAIAccountOverview,
	fuseDeterministicCoreWithAISemantics
} from '../src/services/aiAnalysis/dimensions.js'

describe('AI dimension fusion', () => {
	it('keeps account-level AI overdue signals when record details are absent', () => {
		const aiDim = aiToInternalDimensions({
			debt_summary: {},
			overdue_summary: { current_overdue_count: 0, current_overdue_amount: 0, max_overdue_days: 0, m1_count: 0, m2_count: 0, m3_plus_count: 0 },
			query_records: {},
			account_overview: {},
			credit_cards: { overdue_count: 1 },
			loan_accounts: { overdue_count: 0 },
			public_records: { has_record: false }
		})

		const fused = fuseDeterministicCoreWithAISemantics({
			overdueCount: 0,
			m1Count: 0,
			m2Count: 0,
			m3Count: 0,
			debtRatio: 0,
			hasLianSan: false,
			hasLeiLiu: false,
			hasPublicRecord: false,
			isHighRisk: false
		}, aiDim)

		assert.equal(aiDim.overdueCount, 1)
		assert.equal(fused.overdueCount, 1)
		assert.equal(fused.hasOverdue, true)
	})

	it('applies vision summary overdue counts before risk scoring', () => {
		const dim = applyVisionAIAccountOverview({ overdueCount: 0, hasOverdue: false }, {
			credit_cards: { overdue_count: 1 },
			loan_accounts: { overdue_count: 0 },
			overdue_summary: { current_overdue_count: 0, current_overdue_amount: 1200, max_overdue_days: 12 }
		})

		assert.equal(dim.overdueCount, 1)
		assert.equal(dim.hasOverdue, true)
		assert.equal(dim.totalOverdueAmt, 1200)
	})

	it('derives non-bank loan count from structured accounts', () => {
		const dim = enrichDimensions({
			creditAccounts: [
				{ bank: '兴业消费金融', isLoan: true, isSettled: false, balance: 12000, loanAmount: 20000 },
				{ bank: '招商银行', isLoan: true, isSettled: false, balance: 30000, loanAmount: 50000 }
			],
			overdueRecords: [],
			queryRecords: {},
			consecutiveOverdue: {},
			publicRecords: {}
		})

		assert.equal(dim.loanCount, 2)
		assert.equal(dim.nonBankLoanCount, 1)
	})
})