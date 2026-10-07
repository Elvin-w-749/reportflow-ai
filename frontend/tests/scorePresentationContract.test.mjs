import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (...parts) => readFileSync(join(__dirname, '..', ...parts), 'utf8')

const scorePresentationSource = read('src', 'utils', 'scorePresentation.js')
const detailSource = read('src', 'pages', 'report', 'Detail.vue')
const manageSource = read('src', 'pages', 'report', 'Manage.vue')
const matchSource = read('src', 'pages', 'match', 'Match.vue')
const advisorSource = read('src', 'pages', 'profile', 'Advisor.vue')
const debtSource = read('src', 'pages', 'profile', 'DebtManage.vue')

const { SCORE_COPY, matchRateLabel, matchRateText, reportScoreText } = await import('../src/utils/scorePresentation.js')

describe('score presentation copy contract', () => {
  it('keeps the user-facing score glossary centralized', () => {
    assert.equal(SCORE_COPY.reportTotal.label, '综合分')
    assert.equal(SCORE_COPY.reportTotal.sourceTitle, '综合分来源')
    assert.equal(SCORE_COPY.reportTotal.overduePriorityLabel, '逾期专项优先')
    assert.equal(SCORE_COPY.reportTotal.riskLevelLabel, '风险等级')
    assert.equal(SCORE_COPY.matchRate.label, '匹配度')
    assert.equal(SCORE_COPY.debtPriority.label, '处理优先级')
    assert.match(scorePresentationSource, /不是信用报告综合分/)
  })

  it('formats score terms without mixing meanings', () => {
    assert.equal(reportScoreText(76), '综合分 76')
    assert.equal(reportScoreText(''), '')
    assert.equal(matchRateText(82), '82%匹配')
    assert.equal(matchRateLabel(82), '匹配度 82%')
  })

  it('keeps report, match, advisor, and debt pages on the same wording contract', () => {
    assert.match(detailSource, /SCORE_COPY\.reportTotal\.label/)
    assert.match(detailSource, /scoreBasis/)
    assert.match(detailSource, /resolveV6ScoreDetails\(raw\.value, reportDecisionTrust\.value, decisionReportId\.value\)/)
    assert.match(detailSource, /source === 'overdue-special'/)
    assert.match(detailSource, /逾期专项扣分/)
    assert.match(detailSource, /SCORE_COPY\.reportTotal\.riskLevelLabel/)
    assert.match(manageSource, /SCORE_COPY\.reportTotal\.summaryLabel/)
    assert.match(manageSource, /综合分高/)
    assert.match(manageSource, /综合分低/)
    assert.doesNotMatch(manageSource, />最新分</)

    assert.match(matchSource, /SCORE_COPY\.matchRate\.maxLabel/)
    assert.match(matchSource, /reportScoreText\(score\)/)
    assert.match(matchSource, /matchRateText\(item\.matchRate\)/)
    assert.doesNotMatch(matchSource, /信用分/)
    assert.doesNotMatch(matchSource, />最高匹配</)

    assert.match(advisorSource, /reportScoreText\(reportScore\)/)
    assert.match(advisorSource, /matchRateLabel\(matchRate\)/)
    assert.doesNotMatch(advisorSource, /信用分/)

    assert.match(debtSource, /SCORE_COPY\.debtPriority\.sectionTitle/)
    assert.match(debtSource, /SCORE_COPY\.debtPriority\.sortNote/)
    assert.doesNotMatch(debtSource, />风险分层</)
    assert.doesNotMatch(debtSource, />按风险排序</)
  })
})
