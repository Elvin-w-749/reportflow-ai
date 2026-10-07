import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(__dirname, '..', 'src', 'pages', 'message', 'Center.vue'), 'utf8')
const masterDetailSource = readFileSync(join(__dirname, '..', 'src', 'components', 'layout', 'MasterDetailLayout.vue'), 'utf8')
const tabBarSource = readFileSync(join(__dirname, '..', 'src', 'components', 'TabBar.vue'), 'utf8')
const messageCenterServiceSource = readFileSync(join(__dirname, '..', 'src', 'services', 'messageCenter.js'), 'utf8')
const chatSource = readFileSync(join(__dirname, '..', 'src', 'pages', 'chat', 'Conversation.vue'), 'utf8')

describe('message center page integration contract', () => {
  it('keeps user-side local consultation, debt, and remote messages merged', () => {
    assert.match(source, /buildConsultationMessages\(contactsData\)/)
    assert.match(source, /buildDebtExecutionMessages\(undefined, undefined, debtRecords\)/)
    assert.match(source, /\.\.\.debtMessages\.map/)
    assert.match(source, /\.\.\.consultationMessages\.map/)
    assert.match(source, /\.\.\.serverMessages\.map/)
    assert.match(source, /messages\.value = applyMessageActionReceipts\(applyNotificationSettings\(nextMessages, settings\)\)/)
  })

  it('renders the service-role bottom message tab as customer accordion groups', () => {
    assert.match(source, /activeRole\.value = getCurrentRole\(\)/)
    assert.match(source, /getTeacherClientsData\(\{ port: 'service' \}\)/)
    assert.match(source, /buildCustomerChatMessages\(clients\)/)
    assert.match(source, /buildMessageInboxEntries\(visibleMessages\.value, \{ groupClients: isServiceInbox\.value \}\)/)
    assert.match(source, /v-for="entry in visibleInboxEntries"/)
    assert.match(source, /entry\.kind === 'client-group'/)
    assert.match(source, /UID：\{\{ clientUid\(entry\) \|\| '暂未同步' \}\}/)
    assert.match(source, /clientBusiness\(entry\)/)
    assert.match(source, /@click="toggleClientGroup\(entry\.key\)"/)
    assert.match(source, /v-for="m in entryMessages\(entry\)"/)
  })

  it('keeps the message center single-column at every viewport width', () => {
    assert.match(source, /<MasterDetailLayout[\s\S]*single-column/)
    assert.match(masterDetailSource, /singleColumn:\s*\{\s*type:\s*Boolean,\s*default:\s*false\s*\}/)
    assert.match(masterDetailSource, /md-single-column/)
    assert.match(masterDetailSource, /\.md-single-column\.md-active-master \.md-detail\s*\{\s*display:\s*none;\s*\}/)
    assert.match(masterDetailSource, /\.md-single-column\.md-active-detail \.md-master\s*\{\s*display:\s*none;\s*\}/)
    assert.match(masterDetailSource, /\.md-layout:not\(\.md-single-column\)\s*\{[\s\S]*grid-template-columns/)
  })

  it('provides a deterministic return path from the single-column detail pane', () => {
    assert.match(source, /<RptBackButton label="返回消息列表" @click="closePreviewMessage"\s*\/>/)
    assert.match(source, /const closePreviewMessage = \(\) => \{\s*previewMessage\.value = null\s*\}/)
  })

  it('keeps customer-group headers passive and chat deletion scoped to explicit chat messages', () => {
    assert.match(source, /const isChatMessage = \(m = \{\}\) => m\.messageKind === 'customer-chat' \|\| m\.focus === 'chat' \|\| String\(m\.actionUrl \|\| ''\)\.includes\('\/pages\/chat\/conversation'\)/)
    assert.doesNotMatch(source, /const isChatMessage[\s\S]{0,240}m\.category === 'consultation'/)
    assert.match(source, /@content-click="openMsg\(m\)"[\s\S]*@delete="deleteMessage\(m\)"/)
  })

  it('keeps message action receipts and return state wired from page clicks', () => {
    assert.match(source, /saveMessageCenterViewState/)
    assert.match(source, /resolveMessageCenterReturnViewState\(messages\.value, readMessageCenterViewState\(\)\)/)
    assert.match(source, /saveMessageActionReceipt\(m, \{ stage: 'opened'/)
    assert.match(source, /syncMessageActionReceipt\(openedReceipt, saveMessageActionReceiptRemote\)/)
    assert.match(source, /uni\.navigateTo\(\{ url: m\.actionUrl/)
  })

  it('keeps failed writebacks retryable from the notification preference panel', () => {
    assert.match(source, /readMessageActionSyncQueue\(\)\.length \+ readConsultationMaterialSyncQueue\(\)\.length \+ readDebtExecutionSyncQueue\(\)\.length/)
    assert.match(source, /retryPendingMessageActionSync\(saveMessageActionReceiptRemote\)/)
    assert.match(source, /retryPendingConsultationMaterialSync\(submitAdvisorContactMaterial\)/)
    assert.match(source, /retryPendingDebtExecutionSync\(saveDebtExecutionRecordRemote\)/)
  })

  it('keeps the message page scroll area stable under the floating tab bar', () => {
    assert.match(source, /height: 100dvh/)
    assert.match(source, /height: 0 !important/)
    assert.match(source, /-webkit-overflow-scrolling: touch/)
    assert.match(source, /height: calc\(98px \+ var\(--rpt-safe-bottom\)\)/)
  })

  it('keeps a lightweight skeleton state for smoother first-load feedback', () => {
    assert.match(source, /inbox-skeleton/)
    assert.match(source, /skeleton-row/)
    assert.match(source, /skeleton-shimmer/)
    assert.match(source, /@keyframes skeletonShimmer/)
  })

  it('uses server contact unread counters for visible badges and tab polling', () => {
    assert.match(messageCenterServiceSource, /record\.unreadCount/)
    assert.match(messageCenterServiceSource, /hasUnread/)
    assert.match(source, /m\.unreadCount > 0/)
    assert.match(source, /msg-unread-count/)
    assert.match(tabBarSource, /TAB_UNREAD_POLL_MS/)
    assert.match(tabBarSource, /setInterval\(refreshMsgCount, TAB_UNREAD_POLL_MS\)/)
  })

  it('keeps the conversation screen simple while preserving receipts and tools', () => {
    assert.match(chatSource, /quiet-tools/)
    assert.match(chatSource, /actionPanelOpen/)
    assert.match(chatSource, /action-panel/)
    assert.match(chatSource, /readReceiptText/)
    assert.match(chatSource, /msg-read-receipt/)
  })
})
