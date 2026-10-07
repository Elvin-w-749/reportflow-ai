import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { generateReport } from '../src/services/aiAnalysis/report.js'

describe('AI report risk priority', () => {
	it('does not let integrated risk hide severe overdue blockers', () => {
		const report = generateReport({
			'信用历史': 100,
			'查询频率': 100,
			'账户结构': 100,
			'还款记录': 100
		}, {
			totalAccountCount: 4,
			nonBankLoanCount: 0,
			cardUtilizationRate: 0.2,
			q1: 0,
			q3: 0,
			q6: 0,
			q12: 0,
			loanCount: 1,
			debtRatio: 0.2,
			debtRatioExceeds70: false,
			overdueCount: 1,
			totalOverdueAmt: 2000,
			maxOverdueDays: 95,
			m1Count: 0,
			m2Count: 0,
			m3Count: 1,
			hasOverdue: true,
			hasLianSan: false,
			hasLeiLiu: false,
			hasPublicRecord: false
		}, null, null, null, {
			integratedRisk: { risk_level: '低', score: 92, factors: ['负债规模正常'], confidence: 'normal' }
		})

		assert.equal(report.riskLevel, 'high')
		assert.match(report.summary, /严重风险标记/)
	})
})