import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const detailSource = readFileSync(join(__dirname, '..', 'src', 'pages', 'report', 'Detail.vue'), 'utf8')

describe('legacy report detail UX contract', () => {
  it('keeps one bottom primary action instead of two advisor actions', () => {
    const footer = detailSource.match(/<view v-if="hasReport && !missingDetail" class="footer">([\s\S]*?)<\/view>\s*<\/view>\s*<\/template>/)?.[1] || ''
    assert.match(footer, /class="footer-primary"/)
    assert.doesNotMatch(footer, /footer-secondary/)
    assert.doesNotMatch(footer, />问顾问</)
    assert.match(detailSource, /if \(hasReport\.value && !hasTrustedScore\.value\) return ACTION_KEYS\.UPLOAD/)
    assert.match(detailSource, /重新上传分析/)
    assert.match(detailSource, /hasMeaningfulAnalysisData\(report\.analysisData\)/)
    assert.match(detailSource, /class="quick-action" @click="runPrimaryAction"/)
  })

  it('keeps the fixed footer full-width while aligning its actions with report content', () => {
    const footer = detailSource.match(/<view v-if="hasReport && !missingDetail" class="footer">([\s\S]*?)<\/view>\s*<\/view>\s*<\/template>/)?.[1] || ''
    assert.match(detailSource, /class="wrap rpt-content-narrow"/)
    assert.match(detailSource, /class="footer-actions rpt-content-narrow"/)
    assert.match(detailSource, /\.footer \{[^}]*left: 0;[^}]*right: 0;[^}]*padding: 10px 0 calc\(10px \+ var\(--rpt-safe-bottom\)\);[^}]*background:/)
    assert.match(detailSource, /\.footer-actions \{[^}]*padding: 0 14px;[^}]*flex-direction: row;[^}]*gap: 10px;/)
    assert.doesNotMatch(detailSource, /\.footer \{[^}]*max-width:/)
    assert.doesNotMatch(detailSource, /\.footer \{[^}]*(?:left: 50%|transform: translateX)/)
    assert.match(detailSource, /\.footer-export \{[^}]*width: auto;[^}]*flex: 3 1 0;[^}]*min-width: 112px;[^}]*height: 44px;/)
    assert.match(detailSource, /\.footer-primary \{[^}]*flex: 7 1 0;[^}]*min-width: 0;[^}]*height: 44px;/)
    assert.match(footer, /class="footer-export"/)
    assert.match(footer, /:class="\{ 'footer-export-disabled': exporting \}"/)
    assert.match(footer, /role="button"/)
    assert.match(footer, /tabindex="0"/)
    assert.match(footer, /:aria-disabled="exporting"/)
    assert.match(footer, /@click="chooseReportExport"/)
    assert.match(footer, /@keydown\.enter\.prevent="chooseReportExport"/)
    assert.match(footer, /@keydown\.space\.prevent="chooseReportExport"/)
    assert.match(footer, /class="footer-primary"[\s\S]*?role="button"[\s\S]*?tabindex="0"[\s\S]*?:aria-label="conversionButtonText"/)
    assert.match(footer, /@click="runPrimaryAction"/)
    assert.match(footer, /@keydown\.enter\.prevent="runPrimaryAction"/)
    assert.match(footer, /@keydown\.space\.prevent="runPrimaryAction"/)
  })

  it('explains the visible total score from stored scoring evidence', () => {
    assert.match(detailSource, /const scoreBasisQuestion = computed/)
    assert.match(detailSource, /scoreBasisExpanded/)
    assert.match(detailSource, /resolveV6ScoreDetails\(raw\.value, reportDecisionTrust\.value, decisionReportId\.value\)/)
    assert.match(detailSource, /const source = String\(resolution\.source/)
    assert.match(detailSource, /source === 'overdue-special'/)
    assert.match(detailSource, /source === 'owner-api-decision-score'/)
    assert.match(detailSource, /tag = '服务端证据口径'/)
    assert.match(detailSource, /已通过证据发布门禁/)
    assert.match(detailSource, /source === 'primary-rule-stored'/)
    assert.match(detailSource, /source === 'assessment-stored'/)
    assert.match(detailSource, /source\.startsWith\('four-dimension'\)/)
    assert.match(detailSource, /规则基准分/)
    assert.match(detailSource, /主评分输出/)
    assert.match(detailSource, /主评分规则复算/)
    assert.match(detailSource, /formulaWarning/)
    assert.match(detailSource, /ruleNote/)
    assert.match(detailSource, /实际 \$\{Math\.round\(pct\)\}%/)
    assert.match(detailSource, /scoreBasis\.dimensions/)
    assert.match(detailSource, /scoreBasis\.rules/)
    assert.match(detailSource, /不会把空维度当作 100 分/)
    assert.doesNotMatch(detailSource, /resolveOverdueScore\(raw\.value\)/)
    assert.match(detailSource, /scoreResolution\.value\.dimensions/)
    assert.match(detailSource, /ad\.report\?\.dimensions/)
    assert.match(detailSource, /mergeCompatObjects\(ad\.frontend_payload, ad\.frontendPayload\)/)
    assert.match(detailSource, /mergeCompatObjects\(ad\.cv2, ad\.credit_report_v2\)/)
  })

  it('keeps archival scores visible only as non-decision history', () => {
    assert.match(detailSource, /scoreResolution\.value\.auditable === true/)
    assert.match(detailSource, /scoreResolution\.value\.decisionEligible === true/)
    assert.match(detailSource, /const archivalScore = computed/)
    assert.match(detailSource, /历史存档分（不用于决策）/)
    assert.match(detailSource, /不参与风险等级、产品匹配或行动建议/)
    assert.match(detailSource, /const totalScore = computed\(\(\) => \(hasTrustedScore\.value \? resolvedTotalScore\.value : null\)\)/)
    assert.match(detailSource, /trustedDecisionValue\(reportDecisionTrust\.value, 'advice', 'advice', decisionReportId\.value\)/)
    assert.match(detailSource, /trustedDecisionValue\(reportDecisionTrust\.value, 'riskLevel', 'riskLevel', decisionReportId\.value\)/)
    assert.match(detailSource, /trustedDecisionValue\(\s*reportDecisionTrust\.value,\s*'suggestions',\s*'suggestions',\s*decisionReportId\.value\s*\)/)
    assert.match(detailSource, /const reportInterpretation = computed\(\(\) => null\)/)
    assert.match(detailSource, /label: '历史活跃账户',[\s\S]*?warn: false/)
    assert.match(detailSource, /label: '历史活跃授信机构',[\s\S]*?warn: false/)
    assert.match(detailSource, /if \(hasReport\.value && !hasTrustedScore\.value\) return ACTION_KEYS\.UPLOAD/)
  })

  it('does not describe a high score as stable while the risk level is unknown', () => {
    assert.match(detailSource, /const hasTrustedRiskLevel = computed\(\(\) => trustedRiskLevel\.value !== 'unknown'\)/)
    assert.match(detailSource, /if \(!hasTrustedRiskLevel\.value\) \{[\s\S]*?整体风险等级仍待核对[\s\S]*?不应仅凭分数判断信用状态/)
    const unknownGuard = detailSource.indexOf('if (!hasTrustedRiskLevel.value)')
    const stableHeadline = detailSource.indexOf('整体信用状态较稳')
    assert.ok(unknownGuard >= 0 && unknownGuard < stableHeadline)
  })

  it('fails closed for legacy debt ratios and labels an attested ratio accurately', () => {
		assert.match(detailSource, /resolveDecisionTotalDebt, resolveEvidenceBackedDebtRatio/)
    assert.match(detailSource, /const debtRatioDecision = computed\(\(\) => resolveEvidenceBackedDebtRatio\(raw\.value, reportDecisionTrust\.value, decisionReportId\.value\)\)/)
    assert.match(detailSource, /const DEBT_RATIO_DECISION_ENABLED = false/)
    assert.match(detailSource, /const hasEvidenceBackedDebtRatio = computed/)
    assert.doesNotMatch(detailSource, /ratioEvidenceScope|compactAttestation/)
    assert.match(detailSource, /hasEvidenceBackedDebtRatio\.value && debtRatioDecision\.value\.value != null/)
    assert.match(detailSource, /return debtRatioRaw\.value != null \? '待核对' : '不可计算'/)
    assert.match(detailSource, /const debtRatioLabel = computed\(\(\) => \(hasEvidenceBackedDebtRatio\.value \? '授信占用率' : '授信占用率（待核对）'\)\)/)
    assert.match(detailSource, /分母证据待闭合，不参与风险或决策/)
    assert.doesNotMatch(detailSource, /label: '负债率'/)
  })

  it('keeps debt, utilization, overdue and query hero metrics on same-report owner evidence', () => {
		assert.match(detailSource, /resolveDecisionTotalDebt\(raw\.value, reportDecisionTrust\.value, decisionReportId\.value\)/)
    assert.match(detailSource, /trustedDecisionValue\(reportDecisionTrust\.value, 'cardUtilizationPct', 'cardUtilizationPct', decisionReportId\.value\)/)
    assert.match(detailSource, /const overdueDecisionMetric = computed\(\(\) => resolveOverdueAccountMetric\(raw\.value, reportDecisionTrust\.value, decisionReportId\.value\)\)/)
    assert.match(detailSource, /known: trustedTotal != null/)
    assert.doesNotMatch(detailSource, /creditCardUsageRatePct\(/)
    assert.match(detailSource, /历史账户合计/)
    assert.match(detailSource, /历史卡片明细仅供核对/)
  })

  it('passes evidence-known flags into the report action policy', () => {
    assert.match(detailSource, /scoreKnown: hasTrustedScore\.value/)
    assert.match(detailSource, /highRiskKnown: highRiskMetric\.known/)
    assert.match(detailSource, /overdueKnown: overdueMetric\.known/)
    assert.match(detailSource, /queryKnown: queryMetric\.known/)
  })

  it('uses normalized query window breakdowns and never renders missing parts as 0/0', () => {
    assert.match(detailSource, /qr\.windowSummaries \|\| qr\.window_summaries/)
    assert.match(detailSource, /const queryBreakdownText = \(row\) =>/)
    assert.match(detailSource, /known: trustedTotal != null/)
    assert.match(detailSource, /row\.known \? row\.total : '—'/)
    assert.match(detailSource, /历史明细仅供核对/)
    assert.match(detailSource, /row\.breakdownAvailable === false/)
    assert.match(detailSource, /机构分类待核对/)
    assert.match(detailSource, /未分类/)
    assert.doesNotMatch(detailSource, /银行 \{\{ row\.bank \}\} · 非银 \{\{ row\.nonBank \}\}/)
  })

  it('renders the overview as an ordered category summary while category tabs stay isolated', () => {
    const categorySections = ['sec-risk', 'sec-score', 'sec-debt', 'sec-query', 'sec-accounts']
    const navSource = detailSource.match(/const navSections = computed\(\(\) => \[([\s\S]*?)\]\.filter/)?.[1] || ''
    const navOrder = [...navSource.matchAll(/\{ id: '(sec-[^']+)'/g)].map((match) => match[1])
    const templateOrder = [
      ...detailSource.matchAll(/<view v-if="sectionVisible\('(sec-(?:risk|score|debt|query|accounts))'\)" id="\1"/g)
    ].map((match) => match[1])
    const visibilityExpression = detailSource.match(/const sectionVisible = \(id\) => ([^\r\n]+)/)?.[1] || ''

    assert.deepEqual(navOrder, ['sec-profile', ...categorySections])
    assert.deepEqual(templateOrder, categorySections)
    assert.equal(
      visibilityExpression,
      "exportMode.value || activeAnchor.value === 'sec-profile' || activeAnchor.value === id"
    )

    const evaluateVisibility = new Function('id', 'exportMode', 'activeAnchor', `return ${visibilityExpression}`)
    const isVisible = (activeSection, candidateSection, exportMode = false) => Boolean(evaluateVisibility(
      candidateSection,
      { value: exportMode },
      { value: activeSection }
    ))

    assert.deepEqual(
      categorySections.filter((section) => isVisible('sec-profile', section)),
      categorySections
    )
    for (const selectedSection of categorySections) {
      assert.deepEqual(
        categorySections.filter((section) => isVisible(selectedSection, section)),
        [selectedSection]
      )
      assert.equal(isVisible(selectedSection, 'sec-profile'), false)
    }
    assert.deepEqual(
      categorySections.filter((section) => isVisible('sec-score', section, true)),
      categorySections
    )

    for (const section of categorySections) {
      assert.match(detailSource, new RegExp(`v-if="sectionVisible\\('${section}'\\)"[^>]*id="${section}"`))
    }
    assert.match(detailSource, /v-if="sectionVisible\('sec-profile'\) && sourceNotice"/)
    assert.match(detailSource, /@tap\.stop="scrollTo\(item\.id\)"/)
  })

  it('uses one selectable risk bucket in the summary', () => {
    assert.match(detailSource, /class="risk-select"/)
    assert.match(detailSource, /riskDropdownOpen/)
    assert.match(detailSource, /v-for="item in riskBucketOptions"/)
    assert.match(detailSource, /selectRiskBucket\(item\.key\)/)
    assert.doesNotMatch(detailSource, /class="risk-strip"/)
    assert.doesNotMatch(detailSource, /topRiskHits/)
  })

  it('accepts only whitelisted home deep-link sections and filters', () => {
    assert.match(detailSource, /const REPORT_SECTION_ALIASES = Object\.freeze\(\{/)
    assert.match(detailSource, /const ACCOUNT_FILTER_KEYS = new Set\(/)
    assert.match(detailSource, /const QUERY_WINDOW_KEYS = new Set\(/)
    assert.match(detailSource, /normalizeReportSection\(first\(query\.section, query\.tab\)\)/)
    assert.match(detailSource, /ACCOUNT_FILTER_KEYS\.has\(requestedAccountFilter\)/)
    assert.match(detailSource, /QUERY_WINDOW_KEYS\.has\(requestedQueryWindow\)/)
    assert.match(detailSource, /applyRouteSelection\(query \|\| \{\}\)/)
  })
})
