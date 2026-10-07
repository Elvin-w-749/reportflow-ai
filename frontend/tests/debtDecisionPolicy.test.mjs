import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createOwnerApiDecisionTrust } from '../src/services/decisionTrust.js'
import { resolveDebtDecisionPolicy } from '../src/services/debtDecisionPolicy.js'
import { clearSensitiveBusinessState } from '../src/services/sensitiveLocalState.js'

const verifiedProjection = (overrides = {}) => createOwnerApiDecisionTrust({
	id: 'report-a',
	decisionEvidenceLinked: true,
	evidenceVerified: true,
	decisionFlags: {
		totalDebt: true,
		cardUtilizationRate: true,
		cardUtilizationPct: true,
		debtRatio: true,
		overdueCount: true,
		hasOverdue: true,
		accountCount: true,
		highRiskCount: true,
		riskLevel: true
	},
	totalDebt: 488825,
	cardUtilizationRate: 0.9467,
	cardUtilizationPct: 94.67,
	debtRatio: 0.62,
	overdueCount: 2,
	hasOverdue: true,
	accountCount: 17,
	highRiskCount: 3,
	riskLevel: '高风险',
	...overrides
})

describe('debt management owner decision policy', () => {
	it('accepts approved fields but keeps debt ratio disabled despite an owner flag', () => {
		const policy = resolveDebtDecisionPolicy(verifiedProjection(), 'report-a')

		assert.equal(policy.totalDebt, 488825)
		assert.equal(policy.cardUtilizationPct, 94.67)
		assert.equal(policy.debtRatioPct, null)
		assert.equal(policy.overdueCount, 2)
		assert.equal(policy.hasOverdue, true)
		assert.equal(policy.accountCount, 17)
		assert.equal(policy.highRiskCount, 3)
		assert.equal(policy.riskLevel, '高风险')
		assert.deepEqual(policy.fields, {
			totalDebt: true,
			cardUtilization: true,
			debtRatio: false,
			overdue: true,
			accountCount: true,
			highRiskCount: true,
			riskLevel: true
		})
	})

	it('never guesses that a ratio above one is already a percentage', () => {
		const policy = resolveDebtDecisionPolicy(verifiedProjection({ debtRatio: 4.5138 }), 'report-a')

		assert.equal(policy.debtRatioPct, null)
		assert.equal(policy.fields.debtRatio, false)
	})

	it('preserves an evidence-backed over-limit utilization above 100 percent', () => {
		const policy = resolveDebtDecisionPolicy(verifiedProjection({
			cardUtilizationRate: 1.0313,
			cardUtilizationPct: 103.13
		}), 'report-a')

		assert.equal(policy.cardUtilizationPct, 103.13)
		assert.equal(policy.fields.cardUtilization, true)
	})

	it('fails closed when a valid projection is reused for another report', () => {
		const policy = resolveDebtDecisionPolicy(verifiedProjection(), 'report-b')

		assert.equal(policy.totalDebt, null)
		assert.equal(policy.cardUtilizationPct, null)
		assert.equal(policy.debtRatioPct, null)
		assert.equal(policy.hasOverdue, null)
		assert.equal(policy.accountCount, null)
		assert.deepEqual(policy.fields, {
			totalDebt: false,
			cardUtilization: false,
			debtRatio: false,
			overdue: false,
			accountCount: false,
			highRiskCount: false,
			riskLevel: false
		})
	})

	it('does not accept copied JSON or values whose individual flags are false', () => {
		const projection = verifiedProjection({
			decisionFlags: {
				totalDebt: true,
				cardUtilizationRate: false,
				cardUtilizationPct: false,
				debtRatio: false,
				overdueCount: false,
				hasOverdue: false,
				accountCount: false,
				highRiskCount: false,
				riskLevel: false
			}
		})
		const flagged = resolveDebtDecisionPolicy(projection, 'report-a')
		const copied = resolveDebtDecisionPolicy(JSON.parse(JSON.stringify(projection)), 'report-a')

		assert.equal(flagged.totalDebt, 488825)
		assert.equal(flagged.cardUtilizationPct, null)
		assert.equal(flagged.debtRatioPct, null)
		assert.equal(flagged.hasOverdue, null)
		assert.equal(flagged.accountCount, null)
		assert.equal(copied.totalDebt, null)
		assert.equal(copied.cardUtilizationPct, null)
	})

	it('invalidates a projection when the owner session is cleaned up', () => {
		const projection = verifiedProjection()
		assert.equal(resolveDebtDecisionPolicy(projection, 'report-a').cardUtilizationPct, 94.67)

		clearSensitiveBusinessState(null)

		const expired = resolveDebtDecisionPolicy(projection, 'report-a')
		assert.equal(expired.cardUtilizationPct, null)
		assert.equal(expired.hasOverdue, null)
		assert.equal(expired.riskLevel, null)
	})
})
