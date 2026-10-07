import test from 'node:test'
import assert from 'node:assert/strict'
import { getScoreColor, resolveDisplayRiskLevel } from '../src/config/riskLevel.js'

test('score display color follows red yellow blue bands', () => {
	assert.equal(getScoreColor(30), '#F43F5E')
	assert.equal(getScoreColor(49.9), '#F43F5E')
	assert.equal(getScoreColor(50), '#F5B400')
	assert.equal(getScoreColor(65), '#F5B400')
	assert.equal(getScoreColor(70), '#F5B400')
	assert.equal(getScoreColor(71), '#0A7BF5')
	assert.equal(getScoreColor(100), '#0A7BF5')
})

test('risk labels derive only from a decision-eligible visible score', () => {
	assert.equal(resolveDisplayRiskLevel('low', 0, 'overdue-special'), 'high')
	assert.equal(resolveDisplayRiskLevel('medium', 0, 'overdue-special'), 'high')
	assert.equal(resolveDisplayRiskLevel('medium', 100, 'authoritative-primary-rule'), 'low')
	assert.equal(resolveDisplayRiskLevel('high', 88, 'authoritative-primary-rule'), 'low')
	assert.equal(resolveDisplayRiskLevel('low', 60, 'authoritative-primary-rule'), 'medium')
	assert.equal(resolveDisplayRiskLevel('', 88, 'authoritative-primary-rule'), 'low')
	assert.equal(resolveDisplayRiskLevel('high', null, 'legacy-explicit'), 'unknown')
})
