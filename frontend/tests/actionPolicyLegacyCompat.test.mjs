import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTION_KEYS,
  resolveActionKey,
  resolveHighRiskCount,
  resolveOverdueAccountCount,
  resolveQuery6mCount
} from '../src/services/actionPolicy.js'

describe('legacy home action policy compatibility', () => {
  it('does not let modern empty shells hide populated legacy aliases', () => {
    const analysis = {
      frontendPayload: {},
      frontend_payload: {
        risk_summary: { high: 2 },
        dimensions: { q6: 11 }
      },
      overdueRecords: [],
      report: { overdueRecords: [{ level: 'M1' }] }
    }
    const highRiskCount = resolveHighRiskCount(analysis)
    const query6mCount = resolveQuery6mCount(analysis)
    const overdueAccountCount = resolveOverdueAccountCount(analysis)

    assert.equal(highRiskCount, 2)
    assert.equal(query6mCount, 11)
    assert.equal(overdueAccountCount, 1)
    assert.equal(resolveActionKey({
      hasReport: true,
      score: 85,
      highRiskCount,
      overdueAccountCount,
      query6mCount
    }), ACTION_KEYS.RISK_FIX)
  })

  it('does not let zero placeholders hide stronger legacy action signals', () => {
    assert.equal(resolveQuery6mCount({
      dimensions: { q6: 0 },
      report: { dimensionSnapshot: { q6: 11 } }
    }), 11)
    assert.equal(resolveOverdueAccountCount({
      report: { overdueSummary: { total_overdue_count: 0 }, overdueRecords: [{}] }
    }), 0)
    assert.equal(resolveOverdueAccountCount({
      credit_report_full: { overdue_info: { details: [{ overdue_level: 'M1' }] } }
    }), 1)
    assert.equal(resolveHighRiskCount({
      frontendPayload: {
        risk_summary: { high: 0 },
        risk_cards: [{ level: '风险' }]
      }
    }), 1)
  })

  it('keeps explicit no-overdue statuses out while preserving numeric evidence', () => {
    for (const status of ['未逾期', '无逾期', '从未逾期', '逾期次数为0', 'not overdue']) {
      assert.equal(resolveOverdueAccountCount({ overdueRecords: [{ status, institution: '匿名机构' }] }), 0, status)
    }
    assert.equal(resolveOverdueAccountCount({
      overdueRecords: [{ status: '当前无逾期', overdueDays: 3 }]
    }), 1)
  })
})
