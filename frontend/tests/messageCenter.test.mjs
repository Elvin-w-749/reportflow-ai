import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MESSAGE_ACTION_RECEIPT_KEY,
  MESSAGE_ACTION_SYNC_QUEUE_KEY,
  MESSAGE_CENTER_VIEW_STATE_KEY,
  NOTIFICATION_SETTINGS_KEY,
  SYSTEM_PUSH_BINDING_KEY,
  SYSTEM_PUSH_PERMISSION_KEY,
  NOTIFICATION_SYNC_STATE_KEY,
  applyMessageActionReceipts,
  applyNotificationSettings,
  buildConsultationMessages,
  buildDebtExecutionMessages,
  buildDebtProofMessages,
  filterDebtMessagesByViewState,
  getDebtMessageViewState,
  countActiveUnreadMessages,
  countUnreadLocalMessages,
  detectSystemPushPermissionState,
  isQuietHoursActive,
  markNotificationSyncFailed,
  markNotificationSyncPending,
  markNotificationSyncSuccess,
  messageActionReceiptToPayload,
  messageReportDetailActionUrl,
  normalizeMessageCenterViewState,
  normalizeNotificationSettings,
  notificationSettingsToPayload,
  readMessageActionSyncQueue,
  readMessageCenterViewState,
  readSystemPushBindingState,
  readNotificationSettings,
  readNotificationSyncState,
  requestSystemPushPermission,
  resolveMessageCenterReturnViewState,
  retryPendingMessageActionSync,
  syncSystemPushBinding,
  saveLocalNotificationSettings,
  saveMessageActionReceipt,
  saveMessageCenterViewState,
  syncMessageActionReceipt,
  systemPushPermissionToBindingPayload
} from '../src/services/messageCenter.js'

describe('message center unread helpers', () => {
  it('counts unread consultation messages and respects local read ids', () => {
    const messages = buildConsultationMessages(null, {
      id: 'consult-red-dot',
      productName: '红点方案',
      reportTitle: '信用报告',
      requiredMaterials: [{ id: 'income', name: '收入流水', status: 'rejected', reviewedAt: '2026-07-02T10:00:00.000Z' }],
      createdAt: '2026-07-02T08:00:00.000Z',
      savedAt: Date.parse('2026-07-02T10:00:00.000Z')
    })

    assert.equal(messages.length, 1)
    assert.equal(messages[0].category, 'consultation')
    assert.equal(countUnreadLocalMessages(messages, new Set()), 1)
    assert.equal(countUnreadLocalMessages(messages, new Set([messages[0].id])), 0)
  })

  it('keeps customer service chat history reachable after leaving the chat page', () => {
    const messages = buildConsultationMessages({
      list: [{
        contactId: 'c_service_history',
        clientUid: 'uid-service-client',
        clientId: 'legacy-service-client',
        userId: 'shared-local-owner',
        name: '王先生',
        avatarUrl: 'https://example.test/wang.png',
        businessName: '信用报告协助',
        contactType: 'customer-service',
        channel: 'service',
        summary: '客户发起客服咨询',
        messages: [{
          id: 'm_service_1',
          senderType: 'user',
          senderName: '客户测试号',
          content: '我想继续刚才的咨询',
          createdAt: '2026-07-07T09:00:00.000Z'
        }]
      }]
    }, null)

    const chat = messages.find((item) => item.actionUrl === '/pages/chat/conversation?contactId=c_service_history')
    assert.ok(chat)
    assert.equal(chat.category, 'consultation')
    assert.equal(chat.title, '客服聊天记录')
    assert.equal(chat.actionText, '继续沟通')
    assert.equal(chat.messageKind, 'customer-chat')
    assert.equal(chat.clientScoped, true)
    assert.equal(chat.clientUid, 'uid-service-client')
    assert.equal(chat.clientName, '王先生')
    assert.equal(chat.avatar, 'https://example.test/wang.png')
    assert.equal(chat.businessName, '信用报告协助')
    assert.match(chat.content, /我想继续刚才的咨询/)
  })

  it('builds local debt execution messages and respects read ids', () => {
    const messages = buildDebtExecutionMessages([
      {
        id: 'card-a',
        title: '工商银行 · 信用卡',
        amount: '¥ 2,000',
        dueText: '3 天后到期',
        riskLevel: 'high',
        reportId: 'r1',
        createdAt: '2026-07-02T09:00:00.000Z'
      }
    ], {
      key: 'lower-card-util',
      title: '信用卡占用降到 60% 以下',
      sub: '先压降高占用卡片',
      reportId: 'r1',
      updatedAt: '2026-07-02T08:00:00.000Z'
    })

    assert.equal(messages.length, 2)
    assert.equal(messages[0].debt, true)
    assert.equal(messages[0].category, 'advisor')
    assert.equal(messages[0].tag, '债务')
    assert.equal(messages[0].contextText, '关联信用报告')
    assert.equal(messages[1].level, 'warning')
    assert.match(messages[1].actionUrl, /^\/pages\/profile\/debt-manage\?reportId=r1/)
    assert.equal(countUnreadLocalMessages(messages, new Set()), 2)
    assert.equal(countUnreadLocalMessages(messages, new Set(messages.map((item) => item.id))), 0)
  })

  it('builds debt proof review messages for user follow-up', () => {
    const messages = buildDebtProofMessages([
      {
        id: 'proof-a',
        type: 'proof',
        debtId: 'card-a',
        title: '工商银行 · 信用卡',
        reportId: 'r1',
        fileName: 'repay.png',
        status: 'rejected',
        reviewNote: '截图金额不清晰，请重新上传',
        reviewedAt: '2026-07-02T11:00:00.000Z'
      },
      {
        id: 'proof-b',
        type: 'proof',
        debtId: 'loan-b',
        title: '建设银行 · 消费贷',
        reportId: 'r1',
        status: 'confirmed',
        reviewedAt: '2026-07-02T11:10:00.000Z'
      }
    ])

    assert.equal(messages.length, 2)
    assert.equal(messages[0].title, '债务凭证需重传')
    assert.equal(messages[0].level, 'danger')
    assert.equal(messages[0].actionText, '重新上传')
    assert.match(messages[0].actionUrl, /^\/pages\/profile\/debt-manage\?reportId=r1/)
    assert.match(messages[0].actionUrl, /debtId=card-a/)
    assert.match(messages[0].actionUrl, /executionRecordId=proof-a/)
    assert.match(messages[0].actionUrl, /focus=proof-reupload/)
    assert.match(messages[1].actionUrl, /focus=proof-record/)
    assert.equal(messages[1].title, '债务凭证已确认')
    assert.equal(countUnreadLocalMessages(messages, new Set([messages[1].id])), 1)
  })
  it('keeps acknowledged debt proof reviews traceable but not unread', () => {
    const messages = buildDebtProofMessages([
      {
        id: 'proof-ack-reject',
        type: 'proof',
        debtId: 'card-a',
        title: '工商银行 · 信用卡',
        reportId: 'r1',
        status: 'rejected',
        reviewNote: '截图金额不清晰，请重新上传',
        reviewedAt: '2026-07-02T11:00:00.000Z',
        reviewAcknowledgedAt: '2026-07-02T11:05:00.000Z',
        reviewAcknowledgedNote: '用户已查看驳回原因，稍后处理。'
      },
      {
        id: 'proof-ack-confirm',
        type: 'proof',
        debtId: 'loan-b',
        title: '建设银行 · 消费贷',
        reportId: 'r1',
        status: 'confirmed',
        reviewedAt: '2026-07-02T11:10:00.000Z',
        reviewAcknowledgedAt: '2026-07-02T11:12:00.000Z'
      }
    ])

    assert.equal(messages.length, 2)
    assert.equal(messages[0].title, '债务凭证驳回已查看')
    assert.equal(messages[0].level, 'info')
    assert.equal(messages[0].actionText, '继续处理')
    assert.equal(messages[0].autoRead, true)
    assert.equal(messages[0].reviewAcknowledged, true)
    assert.equal(messages[0].receiptText, '已查看复核结果')
    assert.match(messages[0].actionUrl, /focus=proof-reupload/)
    assert.equal(messages[1].title, '债务凭证确认已查看')
    assert.equal(messages[1].autoRead, true)
    assert.match(messages[1].actionUrl, /focus=proof-record/)
    assert.equal(countUnreadLocalMessages(messages, new Set()), 0)
  })
  it('groups debt messages by pending and viewed states', () => {
    const messages = [
      { id: 'debt-pending', debt: true, local: true, read: false, title: '待处理债务消息' },
      { id: 'debt-ack', debt: true, local: true, autoRead: true, reviewAcknowledged: true, title: '已查看复核' },
      { id: 'debt-opened', debt: true, local: true, actionReceipt: { stage: 'opened', openedAt: '2026-07-02T12:00:00.000Z' }, title: '已打开债务消息' },
      { id: 'consult', category: 'consultation', local: true, read: false, title: '咨询消息' }
    ]

    assert.equal(getDebtMessageViewState(messages[0]), 'pending')
    assert.equal(getDebtMessageViewState(messages[1]), 'viewed')
    assert.equal(getDebtMessageViewState(messages[2]), 'viewed')
    assert.equal(getDebtMessageViewState(messages[3]), 'other')
    assert.deepEqual(filterDebtMessagesByViewState(messages, 'pending').map((item) => item.id), ['debt-pending'])
    assert.deepEqual(filterDebtMessagesByViewState(messages, 'viewed').map((item) => item.id), ['debt-ack', 'debt-opened'])
    assert.deepEqual(filterDebtMessagesByViewState(messages, 'all').map((item) => item.id), ['debt-pending', 'debt-ack', 'debt-opened'])
  })
  it('persists message center return state and moves opened debt messages to viewed', () => {
    const store = new Map()
    const api = {
      getStorageSync: (key) => store.get(key) || '',
      setStorageSync: (key, value) => store.set(key, value)
    }

    const saved = saveMessageCenterViewState({
      filterMode: 'debt',
      debtViewMode: 'pending',
      sourceMessageId: 'debt-opened',
      sourceTitle: '债务凭证需重传',
      sourceFocus: 'proof-record',
      reportId: 'r1'
    }, api)
    const resolved = resolveMessageCenterReturnViewState([
      { id: 'debt-opened', debt: true, local: true, actionReceipt: { stage: 'opened', openedAt: '2026-07-02T12:00:00.000Z' }, title: '债务凭证需重传' }
    ], saved)
    const raw = JSON.parse(store.get(MESSAGE_CENTER_VIEW_STATE_KEY))
    const readBack = readMessageCenterViewState(api)
    const normalized = normalizeMessageCenterViewState({ filterMode: 'bad', debtViewMode: 'bad' })

    assert.equal(raw.filterMode, 'debt')
    assert.equal(readBack.sourceMessageId, 'debt-opened')
    assert.equal(readBack.sourceFocus, 'proof-record')
    assert.equal(resolved.filterMode, 'debt')
    assert.equal(resolved.debtViewMode, 'viewed')
    assert.equal(resolved.sourceMessageState, 'viewed')
    assert.equal(normalized.filterMode, 'all')
    assert.equal(normalized.debtViewMode, 'all')
  })

  it('builds report detail message urls with return context', () => {
    const url = messageReportDetailActionUrl('r 1', { messageId: 'msg-r1', focus: 'report' })

    assert.equal(url, '/pages/report/detail?id=r%201&from=message&reportId=r%201&messageId=msg-r1&focus=report')
  })

  it('hides superseded rejected debt proof messages after reupload', () => {
    const messages = buildDebtProofMessages([
      {
        id: 'proof-old',
        type: 'proof',
        debtId: 'card-a',
        title: '工商银行 · 信用卡',
        reportId: 'r1',
        status: 'rejected',
        statusText: '需重传',
        reviewedAt: '2026-07-02T11:00:00.000Z'
      },
      {
        id: 'proof-new',
        type: 'proof',
        debtId: 'card-a',
        title: '工商银行 · 信用卡',
        reportId: 'r1',
        status: 'reviewing',
        reuploadOf: 'proof-old',
        uploadedAt: '2026-07-02T11:05:00.000Z',
        createdAt: '2026-07-02T11:05:00.000Z'
      }
    ])

    assert.equal(messages.length, 1)
    assert.equal(messages[0].title, '债务凭证待复核')
    assert.equal(messages[0].executionRecordId, 'proof-new')
    assert.match(messages[0].actionUrl, /focus=proof-record/)
  })
  it('normalizes and persists notification preferences locally', () => {
    const store = new Map()
    const api = {
      getStorageSync: (key) => store.get(key) || '',
      setStorageSync: (key, value) => store.set(key, value)
    }

    const saved = saveLocalNotificationSettings({
      enabled: false,
      mutedCategories: { consultation: true },
      quietHours: { enabled: true, start: '23:00', end: '07:00' }
    }, api)
    const raw = JSON.parse(store.get(NOTIFICATION_SETTINGS_KEY))
    const readBack = readNotificationSettings(api)

    assert.equal(saved.enabled, false)
    assert.equal(raw.mutedCategories.consultation, true)
    assert.equal(readBack.quietHours.start, '23:00')
    assert.equal(readBack.quietHours.end, '07:00')
  })

  it('silences muted categories while critical consultation can bypass', () => {
    const settings = normalizeNotificationSettings({
      mutedCategories: { consultation: true },
      criticalConsultationBypass: true
    })
    const messages = [
      { id: 'critical', local: true, category: 'consultation', level: 'danger', title: '有材料需要重传', read: false },
      { id: 'normal', local: true, category: 'consultation', level: 'info', title: '顾问处理中', read: false }
    ]
    const applied = applyNotificationSettings(messages, settings)

    assert.equal(applied[0].muted, false)
    assert.equal(applied[1].muted, true)
    assert.equal(countUnreadLocalMessages(messages, new Set(), settings), 1)
  })

  it('tracks pending notification preference sync for retry', () => {
    const store = new Map()
    const api = {
      getStorageSync: (key) => store.get(key) || '',
      setStorageSync: (key, value) => store.set(key, value)
    }
    const settings = normalizeNotificationSettings({
      enabled: false,
      mutedCategories: { consultation: true, system: true }
    })

    const pending = markNotificationSyncPending(settings, api)
    const failed = markNotificationSyncFailed(new Error('network down'), settings, api)
    const savedRaw = JSON.parse(store.get(NOTIFICATION_SYNC_STATE_KEY))
    const readBack = readNotificationSyncState(api)
    const synced = markNotificationSyncSuccess(api)

    assert.equal(pending.status, 'pending')
    assert.equal(pending.pending, true)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.pending, true)
    assert.equal(failed.retryCount, 1)
    assert.equal(failed.error, 'network down')
    assert.equal(savedRaw.settings.enabled, false)
    assert.equal(readBack.settings.mutedCategories.system, true)
    assert.equal(synced.status, 'synced')
    assert.equal(synced.pending, false)
    assert.equal(synced.settings, null)
  })

  it('normalizes server notification preference aliases for sync payloads', () => {
    const settings = normalizeNotificationSettings({
      notificationEnabled: '0',
      silentCategories: ['advisor', 'system'],
      doNotDisturb: { active: 1, startTime: '21:00', endTime: '07:00' },
      importantConsultationEnabled: 'true'
    })
    const payload = notificationSettingsToPayload(settings)

    assert.equal(settings.enabled, false)
    assert.equal(settings.mutedCategories.advisor, true)
    assert.equal(settings.mutedCategories.system, true)
    assert.equal(settings.quietHours.enabled, true)
    assert.equal(settings.quietHours.start, '21:00')
    assert.equal(settings.criticalConsultationBypass, true)
    assert.deepEqual(payload.mutedCategoryKeys, ['advisor', 'system'])
    assert.equal(payload.categories.system, false)
    assert.equal(payload.doNotDisturb.end, '07:00')
  })

  it('records message action receipts and applies receipt text to messages', () => {
    const store = new Map()
    const api = {
      getStorageSync: (key) => store.get(key) || '',
      setStorageSync: (key, value) => store.set(key, value)
    }
    const message = { id: 'consult-receipt', category: 'consultation', level: 'danger', title: '有材料需要重传', reportId: 'r1', statusId: 's1', actionUrl: '/pages/profile/advisor', debtId: 'card-a', executionRecordId: 'proof-a' }

    saveMessageActionReceipt(message, { stage: 'opened', page: '/pages/message/center', at: '2026-07-02T10:00:00.000Z' }, api)
    const landed = saveMessageActionReceipt(message, { stage: 'landed', page: '/pages/profile/advisor', focus: 'materials', at: '2026-07-02T10:01:00.000Z' }, api)
    const raw = JSON.parse(store.get(MESSAGE_ACTION_RECEIPT_KEY))
    const applied = applyMessageActionReceipts([message], raw)

    assert.equal(landed.stage, 'landed')
    assert.equal(raw['consult-receipt'].openedAt, '2026-07-02T10:00:00.000Z')
    assert.equal(raw['consult-receipt'].debtId, 'card-a')
    assert.equal(raw['consult-receipt'].executionRecordId, 'proof-a')
    assert.equal(raw['consult-receipt'].landedAt, '2026-07-02T10:01:00.000Z')
    assert.equal(applied[0].receiptText, '已进入处理页')
  })

  it('preserves source report message metadata through advisor landing', () => {
    const store = new Map()
    const api = {
      getStorageSync: (key) => store.get(key) || '',
      setStorageSync: (key, value) => store.set(key, value)
    }
    const source = { id: 'report-source-msg', category: 'system', title: '信用报告已更新', reportId: 'r1', actionUrl: '/pages/report/detail?id=r1' }

    saveMessageActionReceipt(source, { stage: 'opened', page: '/pages/report/detail', focus: 'report', at: '2026-07-02T10:00:00.000Z' }, api)
    const landed = saveMessageActionReceipt(source, { stage: 'landed', page: '/pages/profile/advisor', focus: 'advisor', at: '2026-07-02T10:02:00.000Z' }, api)

    assert.equal(landed.category, 'system')
    assert.equal(landed.title, '信用报告已更新')
    assert.equal(landed.reportId, 'r1')
    assert.equal(landed.landedAt, '2026-07-02T10:02:00.000Z')
  })
  it('labels handled report receipts as processed and keeps material receipt text', () => {
    const applied = applyMessageActionReceipts([
      { id: 'report-msg', reportId: 'r1', title: '信用报告已更新' },
      { id: 'material-msg', title: '材料待补充' }
    ], {
      'report-msg': { id: 'report-msg', stage: 'handled', page: '/pages/report/detail', focus: 'report-detail' },
      'material-msg': { id: 'material-msg', stage: 'handled', page: '/pages/profile/advisor', focus: 'materials', materialName: '收入流水' }
    })

    assert.equal(applied[0].receiptText, '已处理完成')
    assert.equal(applied[1].receiptText, '已提交材料')
  })
  it('queues message action receipts when server writeback fails', async () => {
    const store = new Map()
    const api = {
      getStorageSync: (key) => store.get(key) || '',
      setStorageSync: (key, value) => store.set(key, value)
    }
    const receipt = saveMessageActionReceipt(
      { id: 'consult-handled', category: 'consultation', statusId: 'contact-1', reportId: 'r1' },
      {
        stage: 'handled',
        page: '/pages/profile/advisor',
        focus: 'materials',
        materialId: 'income',
        materialName: '收入流水',
        uploadUrl: 'https://example.test/income.pdf',
        fileName: 'income.pdf',
        uploadedAt: '2026-07-02T10:02:00.000Z'
      },
      api
    )
    const failed = await syncMessageActionReceipt(receipt, async () => { throw new Error('offline') }, api)
    const queued = readMessageActionSyncQueue(api)
    const storedWhileQueued = JSON.parse(store.get(MESSAGE_ACTION_SYNC_QUEUE_KEY))
    let sent = null
    const retried = await retryPendingMessageActionSync(async (payload) => { sent = payload }, api)

    assert.equal(receipt.materialName, '收入流水')
    assert.equal(messageActionReceiptToPayload(receipt).stage, 'handled')
    assert.equal(failed.queued, true)
    assert.equal(queued.length, 1)
    assert.equal(queued[0].syncKey, 'consult-handled|handled')
    assert.equal(queued[0].retryCount, 1)
    assert.equal(storedWhileQueued.length, 1)
    assert.equal(retried.success, 1)
    assert.equal(sent.materialName, '收入流水')
    assert.equal(readMessageActionSyncQueue(api).length, 0)
  })

  it('detects and requests browser system push permission', async () => {
    const store = new Map()
    const api = {
      getStorageSync: (key) => store.get(key) || '',
      setStorageSync: (key, value) => store.set(key, value)
    }
    const runtime = {
      Notification: {
        permission: 'default',
        requestPermission: async () => 'granted'
      }
    }

    const detected = detectSystemPushPermissionState({ runtime, api })
    const requested = await requestSystemPushPermission({ runtime, api })
    const raw = JSON.parse(store.get(SYSTEM_PUSH_PERMISSION_KEY))

    assert.equal(detected.status, 'prompt')
    assert.equal(detected.canRequest, true)
    assert.equal(detected.platform, 'browser')
    assert.equal(requested.status, 'granted')
    assert.equal(requested.canRequest, false)
    assert.equal(raw.status, 'granted')
  })

  it('syncs system push bindings and keeps failed binding retryable', async () => {
    const store = new Map()
    const api = {
      getStorageSync: (key) => store.get(key) || '',
      setStorageSync: (key, value) => store.set(key, value)
    }
    const binding = systemPushPermissionToBindingPayload({
      status: 'granted',
      platform: 'browser',
      clientId: 'cid-1',
      deviceId: 'device-1'
    }, { templateIds: ['tmpl-a', 'tmpl-a', 'tmpl-b'] })

    const failed = await syncSystemPushBinding(binding, async () => { throw new Error('offline') }, api)
    const failedState = readSystemPushBindingState(api)
    const rawFailed = JSON.parse(store.get(SYSTEM_PUSH_BINDING_KEY))
    let sent = null
    const retried = await syncSystemPushBinding(failedState.binding, async (payload) => { sent = payload }, api)
    const syncedState = readSystemPushBindingState(api)

    assert.equal(binding.clientId, 'cid-1')
    assert.deepEqual(binding.templateIds, ['tmpl-a', 'tmpl-b'])
    assert.equal(failed.queued, true)
    assert.equal(failedState.status, 'failed')
    assert.equal(failedState.pending, true)
    assert.equal(failedState.binding.deviceId, 'device-1')
    assert.equal(rawFailed.error, 'offline')
    assert.equal(retried.ok, true)
    assert.equal(sent.clientId, 'cid-1')
    assert.deepEqual(sent.templateIds, ['tmpl-a', 'tmpl-b'])
    assert.equal(syncedState.status, 'synced')
    assert.equal(syncedState.pending, false)
  })

  it('applies quiet hours to unread badge counts', () => {
    const settings = normalizeNotificationSettings({
      quietHours: { enabled: true, start: '22:00', end: '08:00' },
      criticalConsultationBypass: false
    })
    const messages = [
      { id: 'sys-1', category: 'system', title: '系统通知', read: false },
      { id: 'sys-2', category: 'system', title: '已读通知', read: true }
    ]

    assert.equal(isQuietHoursActive(settings, '23:30'), true)
    assert.equal(isQuietHoursActive(settings, '12:00'), false)
    assert.equal(countActiveUnreadMessages(messages, settings, { now: '23:30' }), 0)
    assert.equal(countActiveUnreadMessages(messages, settings, { now: '12:00' }), 1)
  })
})
