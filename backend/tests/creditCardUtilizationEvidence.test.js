'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
	summarizeCreditCardUtilization
} = require('../backend/services/creditCardUtilization')

test('evidence-v2 policy never merges cards from tail or institution/date heuristics', () => {
	const result = summarizeCreditCardUtilization([
		{
			institution: '示例银行',
			start_date: '2026-01-01',
			card_tail: '1234',
			currency: 'CNY',
			credit_limit: 100000,
			used_limit: 60000,
			status: '正常'
		},
		{
			institution: '示例银行',
			start_date: '2026-01-01',
			card_tail: '1234',
			currency: 'CNY',
			credit_limit: 50000,
			used_limit: 10000,
			status: '正常'
		}
	], {
		trustExplicitSharedGroup: true,
		allowHeuristicSharedCredit: false
	})

	assert.equal(result.totalLimit, 150000)
	assert.equal(result.totalUsed, 70000)
	assert.equal(result.sharedGroupCount, 0)
	assert.equal(result.inferredSharedGroupCount, 0)
	assert.ok(result.candidateGroups.some((group) =>
		group.basis === 'tail' &&
		group.affectsCnyAggregation === true &&
		group.memberIndexes.join(',') === '0,1'
	))
	assert.ok(result.candidateGroups.every((group) =>
		!Object.prototype.hasOwnProperty.call(group, 'institution') &&
		!Object.prototype.hasOwnProperty.call(group, 'tail')
	))
})

test('evidence-v2 policy accepts only an explicit trusted shared group', () => {
	const result = summarizeCreditCardUtilization([
		{
			institution: '示例银行',
			shared_credit_group: 'verified-facility-1',
			currency: 'CNY',
			credit_limit: 100000,
			used_limit: 60000,
			status: '正常'
		},
		{
			institution: '示例银行',
			shared_credit_group: 'verified-facility-1',
			currency: 'CNY',
			credit_limit: 100000,
			used_limit: 60000,
			status: '正常'
		}
	], {
		trustExplicitSharedGroup: true,
		allowHeuristicSharedCredit: false
	})

	assert.equal(result.totalLimit, 100000)
	assert.equal(result.totalUsed, 60000)
	assert.equal(result.sharedGroupCount, 1)
	assert.equal(result.inferredSharedGroupCount, 0)
	assert.deepEqual(result.candidateGroups, [])
})

test('legacy shared-credit heuristic requires an explicit opt-in', () => {
	const result = summarizeCreditCardUtilization([
		{
			institution: '示例银行',
			start_date: '2026-01-01',
			currency: 'CNY',
			credit_limit: 100000,
			used_limit: 50000,
			status: '正常'
		},
		{
			institution: '示例银行',
			start_date: '2026-01-01',
			currency: 'USD',
			credit_limit: 700000,
			used_limit: 0,
			status: '正常'
		}
	], {
		allowHeuristicSharedCredit: true
	})

	assert.equal(result.totalLimit, 100000)
	assert.equal(result.totalUsed, 50000)
	assert.equal(result.sharedGroupCount, 1)
	assert.equal(result.inferredSharedGroupCount, 1)
	assert.deepEqual(result.candidateGroups, [])
})

test('default policy never infers a shared group from a CNY and foreign-currency pair', () => {
	const result = summarizeCreditCardUtilization([
		{
			institution: '示例银行',
			start_date: '2026-01-01',
			currency: 'CNY',
			credit_limit: 100000,
			used_limit: 50000,
			status: '正常'
		},
		{
			institution: '示例银行',
			start_date: '2026-01-01',
			currency: 'USD',
			credit_limit: 700000,
			used_limit: 0,
			status: '正常'
		}
	])

	assert.equal(result.totalLimit, 100000)
	assert.equal(result.totalUsed, 50000)
	assert.equal(result.sharedGroupCount, 0)
	assert.equal(result.inferredSharedGroupCount, 0)
})
