'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
	parseQueryDateMs,
	subtractCalendarMonths,
	classifyInstitution,
	classifyLoanInstitution,
	countQueriesByWindow,
	summarizeHardQueryBursts
} = require('../backend/services/queryWindowPolicy')

test('institution classification is explicit-first and never defaults an unknown name to non-bank', () => {
	assert.equal(classifyInstitution({ institution: '甲银行', institution_type: 'non_bank' }), 'non_bank')
	assert.equal(classifyInstitution({ institution: '乙消费金融', institution_type: 'bank' }), 'bank')
	assert.equal(classifyInstitution({ institution: '丙服务中心' }), 'unknown')
	assert.equal(classifyInstitution({ institution: '丁银行', institution_type: '未分类' }), 'unknown')
	assert.equal(classifyInstitution({ institution: '戊消费金融' }), 'non_bank')
	assert.equal(classifyInstitution({ institution: '己银行' }), 'bank')
	assert.equal(classifyInstitution({ institution: '示例银行股份有限公司汽车消费金融中心' }), 'bank')
	assert.equal(classifyInstitution({ institution: '示例消费金融股份有限公司' }), 'non_bank')
})

test('loan classification ignores model type fields and transport buckets', () => {
	assert.equal(classifyLoanInstitution({ institution: '甲银行', institution_type: 'non_bank' }), 'bank')
	assert.equal(classifyLoanInstitution({ institution: '乙消费金融', institution_type: 'bank' }), 'non_bank')
	assert.equal(classifyLoanInstitution({ institution: '丙持牌信贷中心', institution_type: 'bank' }), 'unknown')
})

test('loan classification fails closed on conflicting institution keywords without legal-entity proof', () => {
	assert.equal(classifyLoanInstitution('甲银行汽车金融中心'), 'unknown')
	assert.equal(classifyLoanInstitution('乙银行消费金融事业部'), 'unknown')
	assert.equal(classifyLoanInstitution('某非银行金融机构'), 'unknown')
})

test('loan classification keeps explicit legal bank and non-bank entities deterministic', () => {
	assert.equal(classifyLoanInstitution('甲银行股份有限公司汽车消费金融中心'), 'bank')
	assert.equal(classifyLoanInstitution('乙村镇银行有限责任公司'), 'bank')
	assert.equal(classifyLoanInstitution('丙银行（中国）有限公司汽车金融中心'), 'bank')
	assert.equal(classifyLoanInstitution('丁 银行 股份 有限公司 汽车金融中心'), 'bank')
	assert.equal(classifyLoanInstitution('戊消费金融股份有限公司'), 'non_bank')
	assert.equal(classifyLoanInstitution('己银行小额贷款有限公司'), 'non_bank')
	assert.equal(classifyLoanInstitution('庚金融租赁股份有限公司'), 'non_bank')
})

test('query windows expose bank/non_bank/unknown while retaining total and legacy reason fields', () => {
	const anchor = parseQueryDateMs('2026-06-30')
	const result = countQueriesByWindow([
		{ date: '2026-06-01', institution: '甲银行', reason: '贷款审批' },
		{ date: '2026-06-02', institution: '乙消费金融', reason: '信用卡审批' },
		{ date: '2026-06-03', institution: '丙服务中心', reason: '担保资格审查' },
		{ date: '2026-06-04', institution: '丁银行', institution_type: 'unknown', reason: '贷款审批' },
		{ date: '2026-06-05', institution: '甲银行', reason: '贷后管理' }
	], anchor, 1)

	assert.deepEqual(result, {
		total: 4,
		bank: 1,
		non_bank: 1,
		unknown: 2,
		loan_approval: 3,
		credit_card_approval: 1,
		by_reason: {
			信用卡审批: 1,
			担保资格审查: 1,
			贷款审批: 2
		}
	})
})

test('calendar-month window uses report-date anchor and includes both boundary dates', () => {
	const anchor = parseQueryDateMs('2026-03-31')
	assert.equal(subtractCalendarMonths(anchor, 1), parseQueryDateMs('2026-02-28'))

	const result = countQueriesByWindow([
		{ date: '2026-02-27', institution_type: 'bank', reason: '贷款审批' },
		{ date: '2026-02-28', institution_type: 'bank', reason: '贷款审批' },
		{ date: '2026-03-31', institution_type: 'non_bank', reason: '贷款审批' },
		{ date: '2026-04-01', institution_type: 'bank', reason: '贷款审批' }
	], anchor, 1)

	assert.equal(result.total, 2)
	assert.equal(result.bank, 1)
	assert.equal(result.non_bank, 1)
	assert.equal(result.unknown, 0)
})

test('same-day query bursts count only hard inquiries inside the six-calendar-month window', () => {
	const anchor = parseQueryDateMs('2026-06-30')
	const rows = [
		...Array.from({ length: 4 }, () => ({ date: '2026-06-20', reason: '贷后管理' })),
		...Array.from({ length: 4 }, () => ({ date: '2025-12-29', reason: '贷款审批' })),
		...Array.from({ length: 4 }, () => ({ date: '2025-12-30', reason: '信用卡审批' }))
	]

	assert.deepEqual(summarizeHardQueryBursts(rows, anchor, { months: 6 }), {
		windowMonths: 6,
		total: 4,
		sameDayInquiryDayCount: 1,
		maxSameDayCount: 4
	})
})

test('post-loan management and old approval bursts never trigger same-day scoring', () => {
	const anchor = parseQueryDateMs('2026-06-30')
	for (const rows of [
		Array.from({ length: 4 }, () => ({ date: '2026-06-20', reason: '贷后管理' })),
		Array.from({ length: 4 }, () => ({ date: '2025-01-15', reason: '贷款审批' }))
	]) {
		assert.equal(
			summarizeHardQueryBursts(rows, anchor, { months: 6 }).sameDayInquiryDayCount,
			0
		)
	}
})
