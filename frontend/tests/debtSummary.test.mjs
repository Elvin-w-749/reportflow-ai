import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  debtAccountsFromAnalysis,
  debtAggregateTotalFromAnalysis,
  debtBalanceOf,
  debtLimitOf,
  debtMonthlyOf,
  debtNavigationKey,
  debtUtilizationPct,
  isDebtAccountIncluded,
  isSettledDebtAccount,
  resolveDebtTotalFromEvidence,
  selectDebtAccountSource
} from '../src/services/debtSummary.js'

describe('legacy debt summary normalization', () => {
  it('keeps cloud credit-card utilization on the reported limit instead of balance', () => {
    const card = {
      remainingAmount: 5000,
      creditLimit: 10000,
      monthlyPayment: 500
    }

    assert.equal(debtBalanceOf(card), 5000)
    assert.equal(debtLimitOf(card), 10000)
    assert.equal(debtMonthlyOf(card), 500)
    assert.equal(debtUtilizationPct(card), 50)
  })

  it('reads all legacy used-balance aliases consistently', () => {
    for (const field of ['usedLimit', 'used_limit', 'used_card_limit', 'usedAmount', 'used_amount', 'loan_balance']) {
      assert.equal(debtBalanceOf({ [field]: 4800 }), 4800, field)
    }
    assert.equal(debtUtilizationPct({ used_limit: 4800, credit_limit: 12000 }), 40)
  })

  it('does not invent a 100 percent utilization when the limit is unknown', () => {
		assert.equal(debtLimitOf({ balance: 5000 }), null)
		assert.equal(debtUtilizationPct({ balance: 5000 }), null)
  })

  it('recognizes English and Chinese settled account states', () => {
    for (const status of ['settled', 'closed', '结清', '已结清', '已还清', '销户', '销卡', '已销卡']) {
      assert.equal(isSettledDebtAccount({ status }), true, status)
    }
    for (const status of ['未结清', '尚未结清', '未还清', '未关闭', '尚未销户', '未销卡', '未注销']) {
      assert.equal(isSettledDebtAccount({ status }), false, status)
    }
    assert.equal(isSettledDebtAccount({ status: '正常' }), false)
  })

  it('does not let a placeholder account array hide a populated legacy source', () => {
    const selected = selectDebtAccountSource(
      [{}],
      [{ id: 'legacy-real', used_limit: 5000, credit_limit: 10000 }]
    )

    assert.deepEqual(selected.map((item) => item.id), ['legacy-real'])
  })

  it('prefers a complete CV2 card source over an equal-size legacy skeleton', () => {
    const selected = selectDebtAccountSource(
      [{ accountId: 'card-1', type: '信用卡', usedLimit: 5000 }],
      [{ account_id: 'card-1', card_type: '信用卡', used_limit: 5000, credit_limit: 10000 }]
    )

    assert.equal(selected[0].credit_limit, 10000)
    assert.equal(debtUtilizationPct(selected[0]), 50)
  })

  it('respects an earlier authoritative settled state over a stale active alias', () => {
    const selected = selectDebtAccountSource(
      [{ accountId: 'card-1', status: '已结清', usedLimit: 5000 }],
      [{ account_id: 'card-1', status: '正常', used_limit: 5000, credit_limit: 10000 }]
    )

    assert.equal(isSettledDebtAccount(selected[0]), true)
  })

  it('keeps authoritative settlement when old accounts have no stable id', () => {
    const selected = selectDebtAccountSource(
      [{ institution: '旧格式银行', card_type: '信用卡', status: '已结清', used_limit: 5000 }],
      [{ institution: '旧格式银行', card_type: '信用卡', status: '正常', used_limit: 5000, credit_limit: 10000 }]
    )

    assert.equal(isSettledDebtAccount(selected[0]), true)
  })

  it('excludes shared or foreign-currency companion rows explicitly marked out of utilization', () => {
    const selected = selectDebtAccountSource([
      { account_id: 'card-main', used_limit: 5000, credit_limit: 10000, utilization_included: true },
      { account_id: 'card-companion', used_limit: 5000, credit_limit: 10000, utilization_included: false }
    ])
    const active = selected.filter((account) => isDebtAccountIncluded(account) && !isSettledDebtAccount(account) && debtBalanceOf(account) > 0)

    assert.deepEqual(active.map((account) => account.account_id), ['card-main'])
    assert.equal(active.reduce((sum, account) => sum + debtBalanceOf(account), 0), 5000)
    assert.equal(debtUtilizationPct(active[0]), 50)
  })

  it('extracts old CV2 card and loan balances for the home and debt pages', () => {
    const accounts = debtAccountsFromAnalysis({
      creditReportV2: {
        credit_card_details: [{
          account_id: 'legacy-card',
          card_type: '信用卡',
          used_limit: 7200,
          credit_limit: 14400,
          status: '未结清'
        }],
        loan_details: {
          bank_loans: [{
            account_id: 'legacy-loan',
            type: '消费贷',
            loan_balance: 2500,
            status: '正常'
          }]
        }
      }
    })
    const active = accounts.filter((account) => isDebtAccountIncluded(account) && !isSettledDebtAccount(account) && debtBalanceOf(account) > 0)

    assert.deepEqual(active.map((account) => account.account_id), ['legacy-card', 'legacy-loan'])
    assert.equal(active.reduce((sum, account) => sum + debtBalanceOf(account), 0), 9700)
    assert.equal(debtUtilizationPct(active[0]), 50)
  })

  it('keeps a trusted CV2 aggregate when old reports have no account details', () => {
    assert.equal(debtAggregateTotalFromAnalysis({
      creditReportV2: {
        credit_debt: { total_debt: 50000 }
      }
    }), 50000)
  })

  it('does not let an account shell hide the trusted old-report aggregate', () => {
    const accounts = [{ accountId: 'summary-shell', type: '信用卡' }]
		assert.deepEqual(resolveDebtTotalFromEvidence(accounts, 50000), {
			known: true,
			total: 50000,
      source: 'aggregate',
      explicitZero: false
    })
  })

  it('lets explicit settled account evidence override a stale aggregate with zero', () => {
    const accounts = [{ accountId: 'closed-card', status: '已结清' }]
		assert.deepEqual(resolveDebtTotalFromEvidence(accounts, 50000), {
			known: true,
      total: 0,
      source: 'accounts',
      explicitZero: true
    })
  })

  it('builds anonymous, stable and distinct navigation keys for legacy accounts without ids', () => {
    const account = { institution: '旧格式银行', type: '信用卡', used_limit: 5000, credit_limit: 10000 }
    const same = { ...account }
    const serverShape = {
      id: 'report_0',
      sourceIndex: 0,
      bank: '旧格式银行',
      debtName: '信用卡',
      balance: 5000,
      creditLimit: 10000
    }

    assert.equal(debtNavigationKey(account, 0), debtNavigationKey(same, 0))
    assert.equal(debtNavigationKey(account, 0), debtNavigationKey(serverShape, 99))
    assert.notEqual(debtNavigationKey(account, 0), debtNavigationKey(account, 1))
    assert.match(debtNavigationKey(account, 0), /^debt-nav-0-[a-z0-9]+$/)
    assert.doesNotMatch(debtNavigationKey(account, 0), /旧格式银行|信用卡/)
  })
})
