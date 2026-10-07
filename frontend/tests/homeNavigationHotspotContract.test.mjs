import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (...parts) => readFileSync(join(__dirname, '..', ...parts), 'utf8')
const homeSource = read('src', 'pages', 'home', 'Home.vue')

describe('legacy home navigation contract', () => {
  it('routes the three home metrics to distinct report categories', () => {
    assert.match(homeSource, /goReportSection\('debt'\)/)
    assert.match(homeSource, /goReportSection\('accounts', \{ accountFilter: 'abnormal' \}\)/)
    assert.match(homeSource, /goReportSection\('query', \{ queryWindow: '6m' \}\)/)
    assert.match(homeSource, /const HOME_REPORT_SECTIONS = new Set\(/)
    assert.match(homeSource, /latestReportId\.value \? `id=\$\{encodeURIComponent\(latestReportId\.value\)\}`/)
    assert.match(homeSource, /`section=\$\{encodeURIComponent\(safeSection\)\}`/)
  })

  it('opens recent debt in debt context and never invents an index debt id', () => {
    assert.match(homeSource, /@click="goDebtItem\(item\)"/)
    assert.match(homeSource, /const debtId = firstAccountValue\(acc\._id, acc\.id, acc\.accountId, acc\.account_id, ''\)/)
    assert.match(homeSource, /debtKey: debtNavigationKey\(acc, sourceIndex\)/)
    assert.match(homeSource, /if \(item\.debtId \|\| item\.debtKey\) \{[\s\S]*goDebtManage\(item\.debtId, item\.debtKey\)/)
    assert.match(homeSource, /safeDebtKey \? `debtKey=\$\{encodeURIComponent\(safeDebtKey\)\}`/)
    assert.match(homeSource, /goReportSection\('accounts', \{ accountFilter: item\.accountFilter \|\| 'active' \}\)/)
    assert.doesNotMatch(homeSource, /debtId:\s*`report_\$\{index\}`/)
  })

	it('keeps current debt count independent from archival account rows', () => {
    assert.match(homeSource, /debtAccountsFromAnalysis\(rd, normalized\.creditAccounts\)/)
		assert.match(homeSource, /resolveHomeDebtDisplay\(totalDebtValue\.value, accounts\)/)
		assert.match(homeSource, /debtCount\.value = debtDisplay\.debtCountKnown \? debtDisplay\.debtCount : null/)
		assert.match(homeSource, /debtConflictReason\.value = debtDisplay\.conflictReason/)
    assert.match(homeSource, /debtList\.value = currentAccounts\.slice\(0, 3\)/)
  })

  it('keeps report existence separate from trusted score availability', () => {
    assert.match(homeSource, /const hasReport\s+= ref\(false\)/)
    assert.match(homeSource, /const hasScore\s+= ref\(false\)/)
    assert.match(homeSource, /const hasDebtEvidence = ref\(false\)/)
    assert.match(homeSource, /const hasOverdueEvidence = ref\(false\)/)
    assert.match(homeSource, /const hasQueryEvidence = ref\(false\)/)
    assert.match(homeSource, /hasReport\.value = true/)
    assert.match(homeSource, /hasScore\.value = validScore != null/)
    assert.match(homeSource, /if \(hasReport\.value && !hasScore\.value\) return ACTION_KEYS\.UPLOAD/)
    assert.match(homeSource, /scoreDisplay = computed\(\(\) => hasScore\.value/)
		assert.match(homeSource, /\{\{ hasDebtEvidence && debtCount != null \? debtCount : '--' \}\}/)
    assert.match(homeSource, /\{\{ hasOverdueEvidence \? overdueCount : '--' \}\}/)
    assert.match(homeSource, /\{\{ hasQueryEvidence \? query6mCount : '--' \}\}/)
    assert.match(homeSource, /getRiskMeta\(reportRiskLevel\.value\)\.creditLabel/)
    assert.match(homeSource, /const expectedReportId = decisionReportIdOf\(report\)/)
    assert.match(homeSource, /const normalized = normalizeReportData\(rd, decisionTrust, expectedReportId\)/)
    assert.match(homeSource, /const scoreResolution = resolveV6ScoreDetails\(rd, decisionTrust, expectedReportId\)/)
    assert.match(homeSource, /reportRiskLevel\.value = normalized\.riskLevel \|\| 'unknown'/)
    assert.doesNotMatch(homeSource, /resolveDisplayRiskLevel/)
    assert.match(homeSource, /hasMeaningfulAnalysisData\(rd\)/)
		assert.match(homeSource, /resolveDecisionTotalDebt\(rd, decisionTrust, expectedReportId\)/)
		assert.match(homeSource, /debtValue: debtMetric\.value/)
    assert.match(homeSource, /@click="handleMatchStep"/)
    assert.match(homeSource, /homeActionKey\.value === ACTION_KEYS\.MATCH && hasScore\.value/)
    assert.doesNotMatch(homeSource, /resolveV6TotalFromAnalysis\(rd\) \?\? rd\?\.report\?\.totalScore/)
  })
})
