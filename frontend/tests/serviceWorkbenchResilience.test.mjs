import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const sourcePath = new URL('../src/services/teacherService.js', import.meta.url)
const workbenchSource = fs.readFileSync(new URL('../src/pages/service/Workbench.vue', import.meta.url), 'utf8')
const conversationSource = fs.readFileSync(new URL('../src/pages/chat/Conversation.vue', import.meta.url), 'utf8')
const clientDetailSource = fs.readFileSync(new URL('../src/pages/teacher/ClientDetail.vue', import.meta.url), 'utf8')
let source = fs.readFileSync(sourcePath, 'utf8')
source = source
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"]\s*\r?\n/gm, '')
  .replace(/^export\s+\{[^}]+\}\s+from\s+['"][^'"]+['"]\s*\r?\n/gm, '')

const stubs = `
const request = async () => globalThis.__teacherServiceResponse
const getCachedUserInfo = () => ({})
const resolveAuthToken = () => ''
const buildTeacherSyncMeta = (v = {}) => v
const buildUserWritebackSyncSummary = () => ({ counts: {} })
const collectRequiredMissing = () => []
const collectUserWritebackMissing = () => []
const latestTimestampFromItems = () => 0
const normalizeAdvisorContactContext = (v = {}) => ({ ...v, ...(v.context || {}) })
const getLocalTestRole = () => ''
const listLocalConversations = () => []
`
const moduleUrl = `data:text/javascript;base64,${Buffer.from(stubs + source).toString('base64')}`
const {
  applyServiceWorkbenchHiddenWatermarks,
  filterByPort,
  getTeacherClientDetail,
  getTeacherClientsData,
  isTemporaryServiceWorkbenchFailure,
  serviceWorkbenchCustomerWatermark,
  shouldApplyServiceWorkbenchResponse
} = await import(moduleUrl)

describe('service workbench resilience', () => {
  it('keeps all service-required and tri-party product work items in service port', () => {
    const list = [
      { id: 'direct', channel: 'service' },
      { id: 'required', channel: 'bank', serviceRequired: true },
      { id: 'group', channel: 'bank', groupMode: 'service-bank-customer' },
      { id: 'product', channel: 'bank', contactType: 'match-product' },
      { id: 'bank-only', channel: 'bank', contactType: 'bank-advisor' }
    ]

    assert.deepEqual(filterByPort(list, 'service').map((item) => item.id), [
      'direct',
      'required',
      'group',
      'product'
    ])
  })

  it('rejects stale request sequence results', () => {
    assert.equal(shouldApplyServiceWorkbenchResponse(4, 5), false)
    assert.equal(shouldApplyServiceWorkbenchResponse(5, 5), true)
  })

  it('keeps temporary failures distinct from auth and contract failures', () => {
    assert.equal(isTemporaryServiceWorkbenchFailure({ statusCode: 503 }), true)
    assert.equal(isTemporaryServiceWorkbenchFailure(new Error('network timeout')), true)
    assert.equal(isTemporaryServiceWorkbenchFailure({ statusCode: 401 }), false)
    assert.equal(isTemporaryServiceWorkbenchFailure(new Error('invalid payload')), false)
  })

  it('invalidates sensitive snapshots on logout, role failure, and non-temporary errors', () => {
    assert.match(workbenchSource, /if \(!loggedIn\.value\) \{\s*clearSensitiveWorkbenchState\(\)/)
    assert.match(workbenchSource, /if \(!switched\.ok\) \{\s*clearSensitiveWorkbenchState\(\)/)
    assert.match(workbenchSource, /status === 401 \|\| status === 403 \|\| !isTemporaryServiceWorkbenchFailure\(e\)/)
    assert.match(workbenchSource, /latestRequestId \+= 1[\s\S]*loadPromise = null[\s\S]*items\.value = \[\]/)
  })

  it('keeps every contact at the real getTeacherClientsData service layer', async () => {
    globalThis.__teacherServiceResponse = [
      {
        id: 'contact-report-a',
        clientName: '同一客户',
        phone: '13800000000',
        channel: 'service',
        contactType: 'customer-service',
        reportId: 'report-a',
        createTime: '2026-07-28T01:00:00Z'
      },
      {
        id: 'contact-report-b',
        clientName: '同一客户',
        phone: '13800000000',
        channel: 'service',
        contactType: 'customer-service',
        reportId: 'report-b',
        createTime: '2026-07-28T02:00:00Z'
      }
    ]

    const result = await getTeacherClientsData({ port: 'service' })
    assert.equal(result.clients.length, 2)
    assert.deepEqual(result.clients.map((item) => item.contactId).sort(), [
      'contact-report-a',
      'contact-report-b'
    ])

    const detail = await getTeacherClientDetail('contact-report-a', { port: 'service' })
    assert.equal(detail.history.length, 1)
    assert.equal(detail.history[0].id, 'contact-report-a')
    assert.equal(detail.history[0].reportId, 'report-a')
  })

  it('keeps client identity, avatar, and business context without using the contact id as a UID', async () => {
    globalThis.__teacherServiceResponse = [
      {
        id: 'contact-with-client',
        userId: 'user-priority-001',
        uid: 'uid-secondary-001',
        clientUid: 'client-uid-secondary-001',
        customerUid: 'customer-uid-secondary-001',
        clientId: 'legacy-client-001',
        clientName: '身份客户',
        avatarUrl: 'https://example.test/client-avatar.png',
        channel: 'service',
        contactType: 'customer-service',
        source: 'profile-page',
        contactIntent: 'debt-optimization',
        businessType: 'debt-service',
        businessName: '债务优化服务',
        createTime: '2026-07-28T03:00:00Z'
      },
      {
        id: 'contact-without-client-identity',
        clientName: '待同步客户',
        channel: 'service',
        contactType: 'customer-service',
        createTime: '2026-07-28T04:00:00Z'
      }
    ]

    const result = await getTeacherClientsData({ port: 'service' })
    const identified = result.clients.find((item) => item.contactId === 'contact-with-client')
    const contactOnly = result.clients.find((item) => item.contactId === 'contact-without-client-identity')

    assert.equal(identified.clientUid, 'user-priority-001')
    assert.equal(identified.clientId, 'legacy-client-001')
    assert.equal(identified.userId, 'user-priority-001')
    assert.equal(identified.avatar, 'https://example.test/client-avatar.png')
    assert.equal(identified.source, 'profile-page')
    assert.equal(identified.contactIntent, 'debt-optimization')
    assert.equal(identified.businessType, 'debt-service')
    assert.equal(identified.businessName, '债务优化服务')
    assert.equal(contactOnly.clientUid, '')
    assert.notEqual(contactOnly.clientUid, contactOnly.contactId)
  })

  it('renders real client avatars with fallback, UID, and mapped business context', () => {
    assert.match(workbenchSource, /<image[\s\S]*v-if="avatarUrlOf\(item\) && !avatarFailed\(item\)"[\s\S]*:src="avatarUrlOf\(item\)"[\s\S]*@error="handleAvatarError\(item\)"/)
    assert.match(workbenchSource, /<text v-else class="avatar-text">\{\{ avatarOf\(item\.name\) \}\}<\/text>/)
    assert.match(workbenchSource, /const avatarIdentityOf = \(item = \{\}\) => clientUidOf\(item\) \|\| firstText\(item\.contactId, item\.id, item\.name, 'unknown-client'\)/)
    assert.match(workbenchSource, /const avatarFailureKey = \(item = \{\}\) => \{[\s\S]*JSON\.stringify\(\[identity, url\]\)/)
    assert.match(workbenchSource, /const handleAvatarError = \(item = \{\}\) => \{[\s\S]*failedAvatarKeys\.value = \[\.\.\.failedAvatarKeys\.value, key\]/)
    assert.match(workbenchSource, /const refresh = async \(\) => \{[\s\S]*const result = await load\(\{ silent: true \}\)[\s\S]*if \(result && result\.ok\) failedAvatarKeys\.value = \[\]/)
    assert.match(workbenchSource, /UID：\{\{ clientUidOf\(item\) \|\| '暂未同步' \}\}/)
    assert.match(workbenchSource, /const BUSINESS_LABELS = Object\.freeze\(\{[\s\S]*'debt-optimization': '债务优化'[\s\S]*'product-consultation': '产品咨询'/)
    assert.match(workbenchSource, /const businessText = \(item = \{\}\) => \{[\s\S]*item\.businessName[\s\S]*item\.contactIntent, item\.source, item\.businessType, item\.serviceType, item\.contactType/)
    assert.match(workbenchSource, /if \(label === '客户服务'\) \{[\s\S]*genericLabel = genericLabel \|\| label[\s\S]*continue[\s\S]*return label/)
    const loadBlock = workbenchSource.slice(workbenchSource.indexOf('const load = async'), workbenchSource.indexOf('const refresh = async'))
    assert.doesNotMatch(loadBlock, /failedAvatarKeys\.value = \[\]/)
  })

  it('routes claimed service materials to the case-specific review page', () => {
    assert.match(workbenchSource, /client-detail\?id=\$\{encodeURIComponent\(id\)\}&port=service/)
    assert.match(conversationSource, /currentRole\.value === 'service'[\s\S]*client-detail\?id=\$\{encodeURIComponent\(id\)\}&port=service/)
    assert.match(clientDetailSource, /switchToAdvisor, switchToService/)
    assert.match(clientDetailSource, /getTeacherClientDetail\(clientId\.value, \{ port: activePort\.value \}\)/)
    assert.match(clientDetailSource, /claimAdvisorContact\(id, isServicePort\.value \? 'service' : 'advisor'\)/)
    assert.match(clientDetailSource, /isServicePort\.value[\s\S]*!item\.serviceAssigneeId[\s\S]*item\.materialAccess === false/)
  })

  it('keeps a deleted contact hidden until a new customer message reopens it', () => {
    const oldItem = {
      contactId: 'contact-1',
      latestMessage: { id: 'message-1', senderType: 'user', content: '旧消息', createdAt: '2026-07-28T01:00:00Z' }
    }
    const watermark = serviceWorkbenchCustomerWatermark(oldItem)
    const hidden = new Map([['contact-1', {
      customerMessageKey: watermark.key,
      customerMessageAt: watermark.at,
      hiddenAt: Date.parse('2026-07-28T01:01:00Z')
    }]])

    assert.equal(applyServiceWorkbenchHiddenWatermarks([oldItem], hidden).items.length, 0)

    const newItem = {
      ...oldItem,
      latestMessage: { id: 'message-2', senderType: 'user', content: '新消息', createdAt: '2026-07-28T01:02:00Z' }
    }
    const result = applyServiceWorkbenchHiddenWatermarks([newItem], hidden)
    assert.equal(result.items.length, 1)
    assert.deepEqual(result.reopenedIds, ['contact-1'])
    assert.equal(result.items[0].reopenedByCustomer, true)
  })
})
