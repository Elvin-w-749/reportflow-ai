import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(__dirname, '..', 'src', 'pages', 'profile', 'DebtManage.vue'), 'utf8')

describe('debt manage page user execution contract', () => {
  it('keeps report context and message route focusing wired', () => {
    assert.match(source, /getLatestReport/)
    assert.match(source, /getReport/)
    assert.match(source, /normalizeReportData/)
    assert.match(source, /messageRouteContext/)
    assert.match(source, /focusedDebtAnchor/)
    assert.match(source, /focusedDebtNavigationKey\.value = queryText\(query\.debtKey\)/)
    assert.match(source, /item\.navigationKey && focusedDebtNavigationKey\.value/)
    assert.match(source, /focusedDebtSourceTitle = computed\(\(\) => routeSource\.value === 'home' \? '首页最近债务'/)
    assert.match(source, /onLoad\(\(query = \{\}\) => \{/)
    assert.match(source, /focusedExecutionRecordId\.value = queryText\(query\.executionRecordId\)/)
  })

  it('anchors due reminders to the selected report date', () => {
    assert.match(source, /const daysUntil = \(value, anchorValue = ''\) => \{/)
    assert.match(source, /const anchor = parseDate\(anchorValue\)/)
    assert.match(source, /const base = anchor \|\| new Date\(today\.getFullYear\(\), today\.getMonth\(\), today\.getDate\(\)\)/)
    assert.match(source, /const anchorDate = reportDateOf\(report\)/)
		assert.match(source, /const debtDisplay = resolveHomeDebtDisplay\(trustedTotalDebt, accounts\)/)
		assert.match(source, /const list = debtDisplay\.rows\.map\(\(\{ account, sourceIndex \}\) => \(\{ account, index: sourceIndex \}\)\)/)
		assert.match(source, /const reportDateOf = \(report\) => getReportAnalysisDate\(report \|\| \{\}\)/)
    assert.match(source, /debts\.value = list\.map\(\(\{ account, index \}\) => makeDebt\(account, index, 'report', anchorDate\)\)/)
		assert.match(source, /const monthlyKnown = !debtDisplay\.archiveConflict/)
    assert.match(source, /dueAnchorDate: anchorDate \|\| ''/)
    assert.doesNotMatch(source, /dueWindowText/)
    assert.doesNotMatch(source, /const dueDays = daysUntil\(endDate\)/)
  })

  it('keeps debt proof upload, review acknowledgement, and cloud retry wired', () => {
    assert.match(source, /uploadLocalFile\(\{ filePath: picked\.path, folder: 'debt-proofs' \}\)/)
    assert.match(source, /syncDebtExecutionRecord\(record, saveDebtExecutionRecordRemote\)/)
    assert.match(source, /acknowledgeDebtProofReview\(executionRecords\.value, target/)
    assert.match(source, /retryPendingDebtExecutionSync\(saveDebtExecutionRecordRemote/)
    assert.match(source, /applyDebtExecutionCloudSnapshot\(executionRecords\.value/)
  })

  it('namespaces execution history by both report and debt id', () => {
    assert.match(source, /const activeReportScopeIds = computed/)
    assert.match(source, /const activeReportKey = computed/)
    assert.match(source, /const recordBelongsToActiveReport = \(record\) => \{/)
    assert.match(source, /recordReportIds\.some\(\(value\) => activeReportScopeIds\.value\.has\(value\)\)/)
    assert.match(source, /recordBelongsToActiveReport\(item\)[\s\S]*currentDebtIds\.value\.has\(String\(item\.debtId\)\)/)
    assert.match(source, /recordBelongsToActiveReport\(record\)[\s\S]*String\(record\.debtId\) === String\(item\.id\)/)
    assert.doesNotMatch(source, /\|\| executionRecords\.value\.find\(\(record\) => String\(record\.id\)/)
  })

  it('namespaces reminders and optimization goals to the selected report', () => {
    assert.match(source, /const activeDebtNamespace = computed/)
    assert.match(source, /const debtReminderKey = \(item\) =>/)
    assert.match(source, /const debtReminderKeys = \(item\) =>/)
    assert.match(source, /const existingDebtReminderEntry = \(item\) =>/)
    assert.match(source, /const reminderKey = debtReminderKey\(item\)/)
    assert.match(source, /delete next\[existingEntry\.key\]/)
    assert.match(source, /\[reminderKey\]: \{/)
    assert.match(source, /normalized\[`\$\{namespace\}::\$\{storedDebtId\}`\]/)
    assert.match(source, /activeReportScopeIds\.value\.has\(savedReportId\)/)
    assert.match(source, /restoreOptimizationGoal\(\)[\s\S]*loading\.value = false/)
    assert.match(source, /const belongsToCurrentReport = currentReportId/)
    assert.match(source, /activeReportScopeIds\.value\.has\(statusReportId\)/)
    assert.match(source, /restoreAdvisorFeedback\(\)[\s\S]*loading\.value = false/)
  })

  it('requires the cloud debt summary to identify its report and accounts', () => {
    assert.match(source, /getDebtSummary\(routeRequestedReportId\.value \? \{ reportId: routeRequestedReportId\.value \} : \{\}\)/)
		assert.match(source, /resolveDecisionReportIdAliases\(\[data\?\.reportId, data\?\.report_id\], \{ requireMatch: true \}\)/)
    assert.match(source, /first\(raw\._id, raw\.id, raw\.accountId, raw\.account_id, `\$\{source\}_\$\{index\}`\)/)
    assert.match(source, /const activeClientReportId = ref\(''\)/)
    assert.match(source, /activeClientReportId\.value = apiClientReportId/)
    assert.match(source, /activeClientReportId\.value,[\s\S]*routeRequestedReportId\.value,/)
    assert.match(source, /const reportMatchesScope = \(report, scopeIds = \[\]\) =>/)
		assert.match(source, /!rawApiDebts\.length && reportAccountsOf\(localCandidate\)\.length && reportMatchesScope\(localCandidate, cloudScopeIds\)/)
    assert.match(source, /if \(data && apiReportId\)/)
		assert.match(source, /const debtDisplay = resolveHomeDebtDisplay\(currentTotal, rawApiDebts\)/)
		assert.match(source, /debts\.value = apiDebts[\s\S]*debtConflictReason\.value = debtDisplay\.conflictReason/)
		assert.match(source, /const monthlyKnown = !debtDisplay\.archiveConflict/)
    assert.match(source, /activeReportId\.value = apiReportId/)
    assert.match(source, /if \(routeRequestedReportId\.value\) \{[\s\S]*activeSource\.value = 'unavailable'/)
  })

  it('keeps latest mode unfiltered across repeated onShow loads', () => {
    assert.match(source, /const routeRequestedReportId = ref\(''\)/)
    assert.match(source, /const requestedReport = routeRequestedReportId\.value \? await getReportAsync\(routeRequestedReportId\.value\) : null/)
		assert.match(source, /resolveDecisionReportIdAliases\(\[query\.reportId, query\.id\], \{ requireMatch: true \}\)/)
    assert.doesNotMatch(source, /getDebtSummary\(activeReportId\.value \?/)
  })

  it('ignores stale summary and debt snapshot responses when onShow overlaps', () => {
    assert.match(source, /let loadRequestId = 0/)
    assert.match(source, /const requestId = \+\+loadRequestId/)
    assert.match(source, /if \(requestId !== loadRequestId\) return/)
    assert.match(source, /syncRemoteDebtExecutionSnapshot\(\{[\s\S]*isCurrent: \(\) => requestId === loadRequestId/)
    assert.match(source, /if \(!isCurrent\(\)\) return/)
  })

  it('keeps message badge refresh and message return actions wired', () => {
    assert.match(source, /notifyMessageUnreadChange\(\{ source: 'debt-execution'/)
    assert.match(source, /notifyMessageUnreadChange\(\{ source: 'debt-proof-review-ack'/)
    assert.match(source, /const goDebtMessages = \(\) => safeSwitchTab\('\/pages\/message\/center'\)/)
    assert.match(source, /if \(routeSource\.value === 'message'\) \{ goDebtMessages\(\); return \}/)
  })

  it('keeps advisor handoff context available from debt actions', () => {
    assert.match(source, /DEBT_ADVISOR_CONTEXT_KEY = 'debt_advisor_context'/)
    assert.match(source, /const buildAdvisorDebtContext = \(item = null\) => \(\{/)
    assert.match(source, /uni\.setStorageSync\(DEBT_ADVISOR_CONTEXT_KEY, context\)/)
    assert.match(source, /url: `\/pages\/profile\/advisor\?\$\{query\}`/)
  })

  it('keeps debt decisions behind current-session same-report owner API trust', () => {
    assert.match(source, /import \{ resolveDebtDecisionPolicy \} from '@\/services\/debtDecisionPolicy\.js'/)
		assert.match(source, /import \{ decisionReportIdOf,[^\n]*resolveDecisionReportIdAliases,[^\n]*trustedDecisionValue \} from '@\/services\/decisionTrust\.js'/)
    assert.match(source, /normalizeReportData\(rd, report\?\.decisionTrust \|\| null, decisionReportIdOf\(report\)\)/)
    assert.match(source, /const activeDecisionTrust = ref\(null\)/)
    assert.match(source, /const activeDecisionReportId = ref\(''\)/)
    assert.match(source, /candidateReportId !== reportId/)
    assert.match(source, /resolveDebtDecisionPolicy\([\s\S]*activeDecisionTrust\.value,[\s\S]*activeDecisionReportId\.value/)
    assert.match(source, /<view v-if="!loading && debts\.length && !hasDecisionGuidance" class="decision-archive-note">/)
    assert.match(source, /const riskGroups = computed\(\(\) => \[\]\)/)
    assert.match(source, /const repaymentPlan = computed\(\(\) => \[\]\)/)
    assert.match(source, /totalDebtLabel: policy\.fields\.totalDebt \? '已验证负债合计' : '档案负债合计'/)
    assert.match(source, /dti: policy\.fields\.debtRatio \? `\$\{policy\.debtRatioPct\.toFixed\(2\)\}%` : '—'/)
    assert.match(source, /if \(!hasDecisionGuidance\.value \|\| !goal\) \{[\s\S]*title: '决策进度未验证',[\s\S]*percent: 0/)
    assert.match(source, /riskLevel: item\.decisionEligible \? item\.riskLevel : null/)
    assert.doesNotMatch(source, /const classifyDebt =/)
    assert.doesNotMatch(source, /sort\(\(a, b\) => b\.riskScore/)
    assert.doesNotMatch(source, /debts\.value\.filter\(\(item\) => item\.overdue\)/)
  })

	it('shows owner/archive conflicts and persists a numeric reminder amount', () => {
		assert.match(source, /const currentDebtConflictCopy = computed\(\(\) => debtEvidenceConflictCopy\(debtConflictReason\.value\)\)/)
		assert.match(source, /v-if="currentDebtConflictCopy"/)
		assert.match(source, /currentDebtConflictCopy\.value\.title/)
		assert.match(source, /currentDebtConflictCopy\.value\.detail/)
		assert.match(source, /const reminderAmount = resolveDebtReminderAmount\(item\)/)
		assert.match(source, /amount: reminderAmount\.amount/)
		assert.match(source, /amountText: reminderAmount\.amountText/)
		assert.doesNotMatch(source, /amount: item\.monthly > 0/)
	})
})
