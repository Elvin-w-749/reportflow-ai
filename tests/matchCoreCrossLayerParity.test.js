'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const apiMatch = require('../backend/backend/services/matchCore.js')

const legacyPayload = (score, debtRatio, riskLevel) => ({
	report: {
		totalScore: score,
		adjustedTotalScore: 99,
		riskLevel,
		scores: {
			credit_history: 99,
			query_frequency: 99,
			account_structure: 99,
			repayment_record: 99
		}
	},
	dimensions: { debtRatio, overdueCount: 0 },
	algorithmReport: { integratedRisk: { score: 1 } },
	compositeMeta: { hasBaseScore: false, adjustedTotalScore: 99 }
})

test('server and Web matching fail closed with the same anonymous legacy fixture', async () => {
	const webModuleUrl = pathToFileURL(path.resolve(__dirname, '../frontend/src/services/matchCore.js')).href
	const webMatch = await import(webModuleUrl)
	const payload = {
		...legacyPayload(42, 0.96, 'high'),
		overdueRecords: [{ status: '当前未逾期', institution: '匿名机构' }]
	}
	const product = { rules: { minScore: 70, maxDebtRatio: 0.6, allowOverdue: false } }
	const apiProfile = apiMatch.buildUnifiedMatchProfile(payload)
	const webProfile = webMatch.buildUnifiedMatchProfile(payload)

	assert.deepEqual(
		{
			totalScore: apiProfile.totalScore,
			debtRatio: apiProfile.debtRatio,
			riskLevel: apiProfile.riskLevel,
			hasOverdue: apiProfile.hasOverdue,
			hasDecisionScore: apiProfile.hasDecisionScore,
			hasDecisionDebtRatio: apiProfile.hasDecisionDebtRatio
		},
		{
			totalScore: webProfile.totalScore,
			debtRatio: webProfile.debtRatio,
			riskLevel: webProfile.riskLevel,
			hasOverdue: webProfile.hasOverdue,
			hasDecisionScore: webProfile.hasDecisionScore,
			hasDecisionDebtRatio: webProfile.hasDecisionDebtRatio
		}
	)
	assert.deepEqual(
		apiMatch.computeProductMatchRate(product, apiProfile),
		webMatch.computeProductMatchRate(product, webProfile)
	)
})
