import test from 'node:test'
import assert from 'node:assert/strict'

import { summarizeCreditCardUtilization } from '../src/utils/creditCardUtilization.js'
import { mapServerAnalyzeDataToClientAnalysis } from '../src/services/serverAnalyzeMapper.js'

const cards = [
	{ institution: '甲银行', currency: 'CNY', credit_limit: 0, used_limit: 150385, status: '正常' },
	{ institution: '乙银行', currency: 'CNY', credit_limit: 23280, used_limit: 4717, status: '正常' }
]

test('Web mapper separates card outstanding from the positive-limit utilization numerator', () => {
	const utilization = summarizeCreditCardUtilization(cards)
	assert.equal(utilization.totalLimit, 23280)
	assert.equal(utilization.totalUsed, 4717)
	assert.equal(utilization.cardOutstanding, 155102)
	assert.equal(Math.round(utilization.usageRate * 10000), 2026)

	const mapped = mapServerAnalyzeDataToClientAnalysis({
		credit_debt: {
			total_debt: 155102,
			credit_loans: {},
			credit_cards: {
				total_limit: 23280,
				total_used: 155102,
				utilization_used: 4717,
				usage_rate: 0.2026,
				card_count: 2
			}
		},
		credit_card_details: cards,
		loan_details: { bank_loans: [], non_bank_loans: [] },
		query_analysis: { summary: {} }
	})

	assert.equal(mapped.dimensions.totalCreditLine, 23280)
	assert.equal(mapped.dimensions.usedCardLimit, 155102)
	assert.equal(mapped.dimensions.cardUtilizationUsed, 4717)
	assert.equal(mapped.dimensions.totalDebt, 155102)
	assert.equal(mapped.dimensions.cardUtilizationRate, 0.20262027491408935)
})
