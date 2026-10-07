'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
	extractRawOwnershipProof,
	resolveFirstPageOwnershipEvidence,
	assertReportOwnershipEvidence
} = require('../backend/services/creditAnalysisService')

const buildSyntheticIdentity = (sequence = '001') => {
	const body = ['110101', '20000101', String(sequence).padStart(3, '0')].join('')
	const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
	const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2']
	const sum = body.split('').reduce((total, digit, index) => total + Number(digit) * weights[index], 0)
	return `${body}${checks[sum % 11]}`
}

const identity = buildSyntheticIdentity()
const header = (name, id = identity) =>
	`报告时间：2026-04-27 16:01:32 姓名：${name}证件类型：身份证证件号码：${id}未婚`

test('raw ownership proof requires a labelled name and checksum-valid full identity', () => {
	const proof = extractRawOwnershipProof(header('测试甲'))
	assert.equal(proof.rawName, '测试甲')
	assert.equal(proof.fullId, identity)
	assert.equal(proof.complete, true)

	const wrongCheck = identity.endsWith('0') ? '1' : '0'
	const invalid = extractRawOwnershipProof(header('测试甲', `${identity.slice(0, -1)}${wrongCheck}`))
	assert.equal(invalid.fullId, '')
	assert.equal(invalid.complete, false)
})

test('complete first-page evidence passes without a secondary OCR candidate', () => {
	const source = header('测试甲')
	const result = resolveFirstPageOwnershipEvidence(source)

	assert.equal(result.rescued, false)
	assert.equal(result.reason, 'already-complete')
	assert.equal(result.text, source)
	assert.doesNotThrow(() => assertReportOwnershipEvidence(result.text))
})

test('secondary OCR rescues a missing name only with the same full identity', () => {
	const firstPageText = `证件类型：身份证证件号码：${identity}未婚`
	const result = resolveFirstPageOwnershipEvidence(firstPageText, {
		name: '测试甲',
		fullId: identity,
		nameConfidence: 0.99,
		identityConfidence: 0.99
	})

	assert.equal(result.rescued, true)
	assert.equal(result.reason, 'secondary-header')
	assert.equal(result.proof.rawName, '测试甲')
	assert.equal(result.proof.fullId, identity)
	assert.match(result.text, /姓名：测试甲/)
})

test('a secondary candidate with another full identity is rejected', () => {
	const otherIdentity = buildSyntheticIdentity('002')
	const firstPageText = `证件号码：${identity}`
	const result = resolveFirstPageOwnershipEvidence(firstPageText, {
		name: '测试乙',
		fullId: otherIdentity,
		nameConfidence: 0.99,
		identityConfidence: 0.99
	})

	assert.equal(result.rescued, false)
	assert.equal(result.reason, 'identity-mismatch')
	assert.throws(
		() => assertReportOwnershipEvidence(result.text),
		(err) => err && err.code === 'OCR_INCOMPLETE' && err.reason === 'ownership'
	)
})

test('a name-only candidate can never borrow an identity from another OCR result', () => {
	const firstPageText = `证件号码：${identity}`
	const result = resolveFirstPageOwnershipEvidence(firstPageText, {
		name: '测试甲',
		fullId: '',
		nameConfidence: 0.99,
		identityConfidence: 0
	})

	assert.equal(result.rescued, false)
	assert.equal(result.reason, 'candidate-incomplete')
})

test('an identity found outside the first page cannot authorize a rescue', () => {
	const firstPageText = '个人信用报告 姓名识别失败'
	const laterPageText = `第二页业务明细证件号码：${identity}`
	const result = resolveFirstPageOwnershipEvidence(firstPageText, {
		name: '测试甲',
		fullId: identity,
		nameConfidence: 0.99,
		identityConfidence: 0.99
	})

	assert.equal(result.rescued, false)
	assert.equal(result.reason, 'first-page-identity-missing')
	assert.doesNotMatch(result.text, new RegExp(laterPageText))
})

test('an existing first-page name must agree with the secondary OCR name', () => {
	const firstPageText = header('测试甲')
	const result = resolveFirstPageOwnershipEvidence(firstPageText, {
		name: '测试乙',
		fullId: identity,
		nameConfidence: 0.99,
		identityConfidence: 0.99
	}, { forceCandidateCheck: true })

	assert.equal(result.rescued, false)
	assert.equal(result.reason, 'name-mismatch')
})
