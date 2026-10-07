import { normalizeAdvisorContactContext } from './teacherContactContext.js'
import { consultationStatusToMessage, readLastConsultationStatus } from './userConsultationStatus.js'
import { activeDebtExecutionRecords, applyDebtExecutionCloudSnapshot, debtProofStatusText, readDebtExecutionRecords, saveDebtExecutionRecords } from './debtExecution.js'

export const LOCAL_MESSAGE_READ_KEY = 'rpt_local_message_read_ids'
export const MESSAGE_UNREAD_EVENT = 'rpt-message-unread-refresh'
export const NOTIFICATION_SETTINGS_KEY = 'rpt_message_notification_settings'
export const SYSTEM_PUSH_PERMISSION_KEY = 'rpt_system_push_permission_state'
export const SYSTEM_PUSH_BINDING_KEY = 'rpt_system_push_binding_state'

export const NOTIFICATION_SYNC_STATE_KEY = 'rpt_message_notification_sync_state'
export const MESSAGE_ACTION_RECEIPT_KEY = 'rpt_message_action_receipts'
export const MESSAGE_ACTION_SYNC_QUEUE_KEY = 'rpt_message_action_sync_queue'
export const MESSAGE_CENTER_VIEW_STATE_KEY = 'rpt_message_center_view_state'
export const DEBT_ITEM_REMINDER_KEY = 'debt_item_repay_reminders'
export const DEBT_OPTIMIZATION_GOAL_KEY = 'debt_optimization_goal'

export const DEFAULT_NOTIFICATION_SETTINGS = Object.freeze({
  enabled: true,
  mutedCategories: Object.freeze({
    consultation: false,
    approval: false,
    advisor: false,
    system: false
  }),
  quietHours: Object.freeze({
    enabled: false,
    start: '22:00',
    end: '08:00'
  }),
  criticalConsultationBypass: true,
  updatedAt: ''
})

export const MESSAGE_CATEGORY_KEYS = Object.freeze(['consultation', 'approval', 'advisor', 'system'])
export const MESSAGE_CENTER_FILTER_KEYS = Object.freeze(['all', 'unread', 'consultation', 'debt', 'muted'])
export const MESSAGE_CENTER_DEBT_VIEW_KEYS = Object.freeze(['all', 'pending', 'viewed'])

const storage = () => (typeof uni !== 'undefined' ? uni : null)
const asArray = (payload) => {
  if (!payload) return []
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload.list)) return payload.list
  if (Array.isArray(payload.records)) return payload.records
  if (Array.isArray(payload.messages)) return payload.messages
  if (Array.isArray(payload.contacts)) return payload.contacts
  if (payload.data) return asArray(payload.data)
  return []
}
const parseStored = (raw, fallback = null) => {
  if (raw == null || raw === '') return fallback
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch (e) { return fallback }
  }
  return raw
}
const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== '')
const unwrapSettingsPayload = (payload) => {
  const raw = parseStored(payload, payload)
  if (!raw || typeof raw !== 'object') return {}
  if (raw.data) return unwrapSettingsPayload(raw.data)
  if (raw.settings) return unwrapSettingsPayload(raw.settings)
  if (raw.notificationSettings) return unwrapSettingsPayload(raw.notificationSettings)
  if (raw.preferences) return unwrapSettingsPayload(raw.preferences)
  return raw
}
const boolOrDefault = (value, fallback) => {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (['true', 'yes', 'on', 'enabled', 'open'].includes(text)) return true
  if (['false', 'no', 'off', 'disabled', 'close', 'closed'].includes(text)) return false
  return fallback
}
const normalizeTimeText = (value, fallback) => {
  const text = String(value || '').trim()
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text)
  if (!match) return fallback
  return `${match[1].padStart(2, '0')}:${match[2]}`
}
const timeToMinutes = (value) => {
  const text = normalizeTimeText(value, '')
  if (!text) return null
  const [h, m] = text.split(':').map((n) => Number(n))
  return h * 60 + m
}
const currentMinutesOf = (now) => {
  if (typeof now === 'number') return ((Math.round(now) % 1440) + 1440) % 1440
  if (typeof now === 'string') {
    const v = timeToMinutes(now)
    if (v != null) return v
  }
  if (now && typeof now === 'object' && typeof now.hours === 'number') {
    return (((now.hours * 60) + (Number(now.minutes) || 0)) % 1440 + 1440) % 1440
  }
  const d = now instanceof Date ? now : new Date()
  return d.getHours() * 60 + d.getMinutes()
}
const categoryListOf = (value) => {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(/[、,，;；\s]+/).map((item) => item.trim()).filter(Boolean)
  return []
}
const normalizeMutedCategories = (raw = {}) => {
  const mutedSource = first(raw.mutedCategories, raw.categoryMute, raw.categoryMuted, raw.silentCategories, raw.silencedCategories, raw.mutedCategoryKeys, null)
  const enabledSource = !mutedSource && raw.categories && typeof raw.categories === 'object' ? raw.categories : null
  const mutedList = categoryListOf(mutedSource)
  return MESSAGE_CATEGORY_KEYS.reduce((acc, key) => {
    if (mutedList.length) {
      acc[key] = mutedList.includes(key)
    } else if (mutedSource && typeof mutedSource === 'object' && Object.prototype.hasOwnProperty.call(mutedSource, key)) {
      acc[key] = boolOrDefault(mutedSource[key], false)
    } else if (enabledSource && Object.prototype.hasOwnProperty.call(enabledSource, key)) {
      acc[key] = !boolOrDefault(enabledSource[key], true)
    } else {
      acc[key] = !!DEFAULT_NOTIFICATION_SETTINGS.mutedCategories[key]
    }
    return acc
  }, {})
}

export function normalizeNotificationSettings(payload = {}) {
  const raw = unwrapSettingsPayload(payload)
  const quietRaw = first(raw.quietHours, raw.doNotDisturb, raw.dnd, raw.noDisturb, {}) || {}
  return {
    enabled: boolOrDefault(
      first(raw.enabled, raw.messageEnabled, raw.pushEnabled, raw.notificationEnabled, raw.notifyEnabled, raw.allowNotification, raw.enableMessage),
      DEFAULT_NOTIFICATION_SETTINGS.enabled
    ),
    mutedCategories: normalizeMutedCategories(raw),
    quietHours: {
      enabled: boolOrDefault(
        first(quietRaw.enabled, quietRaw.active, raw.quietHoursEnabled, raw.dndEnabled, raw.doNotDisturbEnabled, raw.noDisturbEnabled),
        DEFAULT_NOTIFICATION_SETTINGS.quietHours.enabled
      ),
      start: normalizeTimeText(first(quietRaw.start, quietRaw.startTime, raw.quietStart, raw.dndStart, raw.doNotDisturbStart, raw.noDisturbStart), DEFAULT_NOTIFICATION_SETTINGS.quietHours.start),
      end: normalizeTimeText(first(quietRaw.end, quietRaw.endTime, raw.quietEnd, raw.dndEnd, raw.doNotDisturbEnd, raw.noDisturbEnd), DEFAULT_NOTIFICATION_SETTINGS.quietHours.end)
    },
    criticalConsultationBypass: boolOrDefault(
      first(raw.criticalConsultationBypass, raw.criticalBypassDnd, raw.criticalConsultation, raw.criticalAlertsEnabled, raw.importantConsultationEnabled, raw.consultationImportantBypass),
      DEFAULT_NOTIFICATION_SETTINGS.criticalConsultationBypass
    ),
    updatedAt: raw.updatedAt || raw.updateTime || ''
  }
}

const runtimeGlobal = () => (typeof globalThis !== 'undefined' ? globalThis : {})
const normalizePermissionStatus = (value = '') => {
  const text = String(value || '').toLowerCase()
  if (['granted', 'accept', 'accepted', 'authorized', 'on', 'true'].includes(text)) return 'granted'
  if (['denied', 'reject', 'rejected', 'blocked', 'off', 'false'].includes(text)) return 'denied'
  if (['prompt', 'default', 'not determined', 'not_determined'].includes(text)) return 'prompt'
  if (['unsupported', 'unavailable'].includes(text)) return 'unsupported'
  return 'unknown'
}
const normalizeTemplateIds = (value) => Array.from(new Set(categoryListOf(value).map(String).filter(Boolean)))

export function normalizeSystemPushPermissionState(payload = {}) {
  const raw = parseStored(payload, {}) || {}
  const status = normalizePermissionStatus(first(raw.status, raw.permission, raw.authSetting, ''))
  const platform = first(raw.platform, raw.source, '')
  const clientId = first(raw.clientId, raw.clientid, raw.cid, raw.pushClientId, raw.push_client_id, '')
  const deviceId = first(raw.deviceId, raw.deviceID, raw.device_id, raw.udid, '')
  const canRequest = raw.canRequest === undefined
    ? status === 'prompt' || status === 'unknown'
    : !!raw.canRequest
  return {
    status,
    canRequest: status === 'granted' || status === 'denied' || status === 'unsupported' ? false : canRequest,
    platform: platform || 'unknown',
    reason: first(raw.reason, raw.errMsg, raw.message, ''),
    clientId,
    pushClientId: first(raw.pushClientId, raw.push_client_id, clientId, ''),
    deviceId,
    templateIds: normalizeTemplateIds(first(raw.templateIds, raw.tmplIds, raw.acceptedTemplateIds, raw.templates, [])),
    updatedAt: first(raw.updatedAt, '')
  }
}

export function readSystemPushPermissionState(api = storage()) {
  if (!api) return normalizeSystemPushPermissionState()
  try {
    return normalizeSystemPushPermissionState(api.getStorageSync(SYSTEM_PUSH_PERMISSION_KEY))
  } catch (e) {
    return normalizeSystemPushPermissionState()
  }
}

export function saveSystemPushPermissionState(state, api = storage()) {
  const next = normalizeSystemPushPermissionState({ ...(state || {}), updatedAt: new Date().toISOString() })
  if (api) {
    try { api.setStorageSync(SYSTEM_PUSH_PERMISSION_KEY, JSON.stringify(next)) } catch (e) {}
  }
  return next
}

export function systemPushPermissionToBindingPayload(state = readSystemPushPermissionState(), extra = {}) {
  const merged = { ...(state || {}), ...(extra.permission || {}) }
  const normalized = normalizeSystemPushPermissionState(merged)
  const clientId = first(extra.clientId, extra.clientid, extra.cid, extra.pushClientId, normalized.clientId, '')
  const templateIds = normalizeTemplateIds(first(extra.templateIds, extra.tmplIds, normalized.templateIds, []))
  const deviceId = first(extra.deviceId, extra.deviceID, normalized.deviceId, clientId, '')
  return {
    status: normalized.status,
    platform: normalized.platform,
    canRequest: normalized.canRequest,
    reason: normalized.reason,
    clientId,
    pushClientId: first(extra.pushClientId, extra.push_client_id, clientId, ''),
    deviceId,
    templateIds,
    source: first(extra.source, 'user-message-center'),
    updatedAt: first(extra.updatedAt, normalized.updatedAt, new Date().toISOString())
  }
}

export function normalizeSystemPushBindingState(payload = {}) {
  const raw = parseStored(payload, {}) || {}
  const status = ['idle', 'pending', 'failed', 'synced'].includes(raw.status)
    ? raw.status
    : raw.pending
      ? 'pending'
      : 'idle'
  const pending = status === 'pending' || status === 'failed' || !!raw.pending
  const retryCount = Number(raw.retryCount)
  return {
    status: pending && status === 'synced' ? 'pending' : status,
    pending,
    error: raw.error ? String(raw.error) : '',
    retryCount: Number.isFinite(retryCount) && retryCount > 0 ? Math.round(retryCount) : 0,
    lastAttemptAt: raw.lastAttemptAt || '',
    lastSuccessAt: raw.lastSuccessAt || '',
    updatedAt: raw.updatedAt || '',
    binding: raw.binding ? systemPushPermissionToBindingPayload(raw.binding) : null
  }
}

export function readSystemPushBindingState(api = storage()) {
  if (!api) return normalizeSystemPushBindingState()
  try {
    return normalizeSystemPushBindingState(api.getStorageSync(SYSTEM_PUSH_BINDING_KEY))
  } catch (e) {
    return normalizeSystemPushBindingState()
  }
}

export function saveSystemPushBindingState(state, api = storage()) {
  const next = normalizeSystemPushBindingState({ ...(state || {}), updatedAt: new Date().toISOString() })
  if (api) {
    try { api.setStorageSync(SYSTEM_PUSH_BINDING_KEY, JSON.stringify(next)) } catch (e) {}
  }
  return next
}

export async function syncSystemPushBinding(binding = {}, syncer, api = storage()) {
  const payload = systemPushPermissionToBindingPayload(binding)
  if (typeof syncer !== 'function' || payload.status === 'unknown' || payload.status === 'unsupported') {
    return { ok: false, queued: false, skipped: true, payload, state: readSystemPushBindingState(api) }
  }
  const previous = readSystemPushBindingState(api)
  const now = new Date().toISOString()
  saveSystemPushBindingState({
    ...previous,
    status: 'pending',
    pending: true,
    error: '',
    binding: payload,
    lastAttemptAt: now,
    updatedAt: now
  }, api)
  try {
    await syncer(payload)
    const successAt = new Date().toISOString()
    const state = saveSystemPushBindingState({
      ...previous,
      status: 'synced',
      pending: false,
      error: '',
      binding: payload,
      lastAttemptAt: now,
      lastSuccessAt: successAt,
      updatedAt: successAt
    }, api)
    return { ok: true, payload, state }
  } catch (e) {
    const latest = readSystemPushBindingState(api)
    const message = (e && (e.message || e.errMsg)) || '绑定同步失败'
    const state = saveSystemPushBindingState({
      ...latest,
      status: 'failed',
      pending: true,
      error: String(message),
      retryCount: latest.retryCount + 1,
      binding: payload
    }, api)
    return { ok: false, queued: true, payload, state, error: e }
  }
}
export function detectSystemPushPermissionState(options = {}) {
  const api = options.api === undefined ? storage() : options.api
  const runtime = options.runtime || runtimeGlobal()
  const browserNotification = runtime && runtime.Notification
  if (browserNotification && typeof browserNotification.permission === 'string') {
    return saveSystemPushPermissionState({ status: browserNotification.permission, platform: 'browser', canRequest: browserNotification.permission === 'default' }, api)
  }
  const cached = readSystemPushPermissionState(api)
  if (cached.status !== 'unknown') return cached
  return saveSystemPushPermissionState({ status: 'unsupported', platform: 'browser', canRequest: false, reason: '当前浏览器不支持系统通知权限检测' }, api)
}

export async function requestSystemPushPermission(options = {}) {
  const api = options.api === undefined ? storage() : options.api
  const runtime = options.runtime || runtimeGlobal()
  const browserNotification = runtime && runtime.Notification
  if (browserNotification && typeof browserNotification.requestPermission === 'function') {
    try {
      const result = await browserNotification.requestPermission()
      return saveSystemPushPermissionState({ status: result, platform: 'browser', canRequest: result === 'default' }, api)
    } catch (e) {
      return saveSystemPushPermissionState({ status: 'denied', platform: 'browser', canRequest: true, reason: e && (e.message || e.errMsg) }, api)
    }
  }
  return saveSystemPushPermissionState({ status: 'unsupported', platform: 'browser', canRequest: false, reason: '当前浏览器不支持系统通知权限请求' }, api)
}
export function notificationSettingsToPayload(settings = readNotificationSettings()) {
  const normalized = normalizeNotificationSettings(settings)
  const categories = MESSAGE_CATEGORY_KEYS.reduce((acc, key) => {
    acc[key] = !normalized.mutedCategories[key]
    return acc
  }, {})
  return {
    ...normalized,
    categories,
    mutedCategoryKeys: MESSAGE_CATEGORY_KEYS.filter((key) => normalized.mutedCategories[key]),
    doNotDisturb: { ...normalized.quietHours },
    dnd: { ...normalized.quietHours },
    criticalBypassDnd: normalized.criticalConsultationBypass
  }
}

export function readNotificationSettings(api = storage()) {
  if (!api) return normalizeNotificationSettings()
  try {
    return normalizeNotificationSettings(api.getStorageSync(NOTIFICATION_SETTINGS_KEY))
  } catch (e) {
    return normalizeNotificationSettings()
  }
}

export function saveLocalNotificationSettings(settings, api = storage()) {
  const next = normalizeNotificationSettings({ ...(settings || {}), updatedAt: new Date().toISOString() })
  if (api) {
    try { api.setStorageSync(NOTIFICATION_SETTINGS_KEY, JSON.stringify(next)) } catch (e) {}
  }
  return next
}

export function normalizeNotificationSyncState(payload = {}) {
  const raw = parseStored(payload, {}) || {}
  const status = ['idle', 'pending', 'failed', 'synced'].includes(raw.status)
    ? raw.status
    : raw.pending
      ? 'pending'
      : 'idle'
  const pending = status === 'pending' || status === 'failed' || !!raw.pending
  const retryCount = Number(raw.retryCount)
  return {
    status: pending && status === 'synced' ? 'pending' : status,
    pending,
    error: raw.error ? String(raw.error) : '',
    retryCount: Number.isFinite(retryCount) && retryCount > 0 ? Math.round(retryCount) : 0,
    lastAttemptAt: raw.lastAttemptAt || '',
    lastSuccessAt: raw.lastSuccessAt || '',
    updatedAt: raw.updatedAt || '',
    settings: raw.settings ? normalizeNotificationSettings(raw.settings) : null
  }
}

export function readNotificationSyncState(api = storage()) {
  if (!api) return normalizeNotificationSyncState()
  try {
    return normalizeNotificationSyncState(api.getStorageSync(NOTIFICATION_SYNC_STATE_KEY))
  } catch (e) {
    return normalizeNotificationSyncState()
  }
}

export function saveNotificationSyncState(state, api = storage()) {
  const next = normalizeNotificationSyncState({ ...(state || {}), updatedAt: new Date().toISOString() })
  if (api) {
    try { api.setStorageSync(NOTIFICATION_SYNC_STATE_KEY, JSON.stringify(next)) } catch (e) {}
  }
  return next
}

export function markNotificationSyncPending(settings, api = storage()) {
  const previous = readNotificationSyncState(api)
  const now = new Date().toISOString()
  return saveNotificationSyncState({
    ...previous,
    status: 'pending',
    pending: true,
    error: '',
    lastAttemptAt: now,
    updatedAt: now,
    settings: normalizeNotificationSettings(settings)
  }, api)
}

export function markNotificationSyncFailed(error, settings, api = storage()) {
  const previous = readNotificationSyncState(api)
  const message = (error && (error.message || error.errMsg)) || '同步失败'
  return saveNotificationSyncState({
    ...previous,
    status: 'failed',
    pending: true,
    error: String(message),
    retryCount: previous.retryCount + 1,
    settings: normalizeNotificationSettings(settings)
  }, api)
}

export function markNotificationSyncSuccess(api = storage()) {
  const previous = readNotificationSyncState(api)
  const now = new Date().toISOString()
  return saveNotificationSyncState({
    ...previous,
    status: 'synced',
    pending: false,
    error: '',
    lastSuccessAt: now,
    updatedAt: now,
    settings: null
  }, api)
}

export function hasPendingNotificationSync(state = readNotificationSyncState()) {
  const normalized = normalizeNotificationSyncState(state)
  return !!normalized.pending
}

export function isQuietHoursActive(settings = readNotificationSettings(), now = new Date()) {
  const normalized = normalizeNotificationSettings(settings)
  if (!normalized.quietHours.enabled) return false
  const start = timeToMinutes(normalized.quietHours.start)
  const end = timeToMinutes(normalized.quietHours.end)
  const current = currentMinutesOf(now)
  if (start == null || end == null || start === end) return false
  if (start < end) return current >= start && current < end
  return current >= start || current < end
}

export function isCriticalConsultationMessage(message = {}) {
  if ((message.category || message.type) !== 'consultation') return false
  return ['danger', 'warning'].includes(message.level) || /需处理|重传|补充|确认/.test(String(message.title || message.content || message.actionText || ''))
}

export function getMessageMuteState(message = {}, settings = readNotificationSettings(), options = {}) {
  const normalized = normalizeNotificationSettings(settings)
  const criticalBypass = normalized.criticalConsultationBypass && isCriticalConsultationMessage(message)
  if (criticalBypass) return { muted: false, reason: '' }
  if (!normalized.enabled) return { muted: true, reason: 'all' }
  const category = message.category || message.type || 'system'
  if (normalized.mutedCategories[category]) return { muted: true, reason: 'category' }
  if (isQuietHoursActive(normalized, options.now || new Date())) return { muted: true, reason: 'quiet' }
  return { muted: false, reason: '' }
}

export function applyNotificationSettings(messages = [], settings = readNotificationSettings(), options = {}) {
  return messages.map((message) => {
    const state = getMessageMuteState(message, settings, options)
    return { ...message, muted: state.muted, muteReason: state.reason }
  })
}

export function readLocalMessageIds(api = storage()) {
  if (!api) return new Set()
  try {
    const raw = api.getStorageSync(LOCAL_MESSAGE_READ_KEY)
    const list = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw
    return new Set(Array.isArray(list) ? list.map(String) : [])
  } catch (e) {
    return new Set()
  }
}

export function saveLocalMessageIds(ids, api = storage()) {
  if (!api) return
  try { api.setStorageSync(LOCAL_MESSAGE_READ_KEY, JSON.stringify(Array.from(ids).map(String))) } catch (e) {}
}

const normalizeMessageCenterKey = (value, allowed, fallback) => {
  const text = String(value || '').trim()
  return allowed.includes(text) ? text : fallback
}

export function normalizeMessageCenterViewState(payload = {}) {
  const raw = parseStored(payload, {}) || {}
  return {
    filterMode: normalizeMessageCenterKey(raw.filterMode, MESSAGE_CENTER_FILTER_KEYS, 'all'),
    debtViewMode: normalizeMessageCenterKey(raw.debtViewMode, MESSAGE_CENTER_DEBT_VIEW_KEYS, 'all'),
    sourceMessageId: String(first(raw.sourceMessageId, raw.messageId, raw.id, '') || ''),
    sourceTitle: String(first(raw.sourceTitle, raw.title, '') || ''),
    sourceCategory: String(first(raw.sourceCategory, raw.category, '') || ''),
    sourceDebt: boolOrDefault(first(raw.sourceDebt, raw.debt), false),
    sourceFocus: String(first(raw.sourceFocus, raw.focus, '') || ''),
    reportId: String(first(raw.reportId, raw.report_id, '') || ''),
    debtId: String(first(raw.debtId, raw.debt_id, '') || ''),
    executionRecordId: String(first(raw.executionRecordId, raw.execution_record_id, '') || ''),
    actionUrl: String(first(raw.actionUrl, raw.url, '') || ''),
    sourceOpenedAt: String(first(raw.sourceOpenedAt, raw.openedAt, '') || ''),
    returnedAt: String(first(raw.returnedAt, '') || ''),
    updatedAt: String(first(raw.updatedAt, '') || '')
  }
}

export function readMessageCenterViewState(api = storage()) {
  if (!api) return normalizeMessageCenterViewState()
  try {
    return normalizeMessageCenterViewState(api.getStorageSync(MESSAGE_CENTER_VIEW_STATE_KEY))
  } catch (e) {
    return normalizeMessageCenterViewState()
  }
}

export function saveMessageCenterViewState(state = {}, api = storage()) {
  const next = normalizeMessageCenterViewState({
    ...readMessageCenterViewState(api),
    ...(state || {}),
    updatedAt: new Date().toISOString()
  })
  if (api) {
    try { api.setStorageSync(MESSAGE_CENTER_VIEW_STATE_KEY, JSON.stringify(next)) } catch (e) {}
  }
  return next
}

export function resolveMessageCenterReturnViewState(messages = [], state = readMessageCenterViewState()) {
  const normalized = normalizeMessageCenterViewState(state)
  const source = (Array.isArray(messages) ? messages : []).find((item) => item && String(item.id) === normalized.sourceMessageId) || null
  const sourceMessageState = source && source.debt ? getDebtMessageViewState(source) : ''
  const next = { ...normalized }
  if (next.filterMode === 'debt' && next.debtViewMode === 'pending' && sourceMessageState === 'viewed') {
    next.debtViewMode = 'viewed'
  }
  return { ...next, sourceMessage: source, sourceMessageState }
}
const normalizeReceiptStore = (raw) => {
  const parsed = parseStored(raw, {})
  if (Array.isArray(parsed)) {
    return parsed.reduce((acc, item) => {
      if (item && item.id) acc[String(item.id)] = item
      return acc
    }, {})
  }
  return parsed && typeof parsed === 'object' ? parsed : {}
}

export function readMessageActionReceipts(api = storage()) {
  if (!api) return {}
  try {
    return normalizeReceiptStore(api.getStorageSync(MESSAGE_ACTION_RECEIPT_KEY))
  } catch (e) {
    return {}
  }
}

export function saveMessageActionReceipt(message, patch = {}, api = storage()) {
  const id = String((message && (message.id || message.messageId)) || message || '')
  if (!id) return null
  const now = patch.at || new Date().toISOString()
  const stage = patch.stage || 'opened'
  const receipts = readMessageActionReceipts(api)
  const previous = receipts[id] || {}
  const next = {
    ...previous,
    id,
    category: first(patch.category, message && message.category, previous.category, ''),
    level: first(patch.level, message && message.level, previous.level, ''),
    title: first(patch.title, message && message.title, previous.title, ''),
    statusId: first(patch.statusId, message && message.statusId, previous.statusId, ''),
    reportId: first(patch.reportId, message && message.reportId, previous.reportId, ''),
    actionUrl: first(patch.actionUrl, message && message.actionUrl, previous.actionUrl, ''),
    page: first(patch.page, previous.page, ''),
    focus: first(patch.focus, previous.focus, ''),
    materialId: first(patch.materialId, message && message.materialId, previous.materialId, ''),
    materialName: first(patch.materialName, message && message.materialName, previous.materialName, ''),
    debtId: first(patch.debtId, message && message.debtId, previous.debtId, ''),
    executionRecordId: first(patch.executionRecordId, message && message.executionRecordId, previous.executionRecordId, ''),
    uploadUrl: first(patch.uploadUrl, message && message.uploadUrl, previous.uploadUrl, ''),
    fileName: first(patch.fileName, message && message.fileName, previous.fileName, ''),
    uploadedAt: first(patch.uploadedAt, message && message.uploadedAt, previous.uploadedAt, ''),
    stage,
    updatedAt: now
  }
  next[`${stage}At`] = now
  receipts[id] = next
  if (api) {
    try { api.setStorageSync(MESSAGE_ACTION_RECEIPT_KEY, JSON.stringify(receipts)) } catch (e) {}
  }
  return next
}

export function messageActionReceiptToPayload(receipt = {}, patch = {}) {
  const raw = receipt && receipt.actionReceipt ? receipt.actionReceipt : receipt || {}
  const id = String(first(patch.id, patch.messageId, raw.id, raw.messageId, ''))
  const stage = first(patch.stage, raw.stage, 'opened')
  return {
    id,
    messageId: id,
    category: first(patch.category, raw.category, ''),
    level: first(patch.level, raw.level, ''),
    title: first(patch.title, raw.title, ''),
    statusId: first(patch.statusId, raw.statusId, ''),
    reportId: first(patch.reportId, raw.reportId, ''),
    actionUrl: first(patch.actionUrl, raw.actionUrl, ''),
    page: first(patch.page, raw.page, ''),
    focus: first(patch.focus, raw.focus, ''),
    stage,
    openedAt: first(patch.openedAt, raw.openedAt, ''),
    landedAt: first(patch.landedAt, raw.landedAt, ''),
    handledAt: first(patch.handledAt, raw.handledAt, ''),
    materialId: first(patch.materialId, raw.materialId, ''),
    materialName: first(patch.materialName, raw.materialName, ''),
    debtId: first(patch.debtId, raw.debtId, ''),
    executionRecordId: first(patch.executionRecordId, raw.executionRecordId, ''),
    uploadUrl: first(patch.uploadUrl, raw.uploadUrl, ''),
    fileName: first(patch.fileName, raw.fileName, ''),
    uploadedAt: first(patch.uploadedAt, raw.uploadedAt, ''),
    updatedAt: first(patch.updatedAt, raw.updatedAt, patch.at, raw.at, new Date().toISOString()),
    source: first(patch.source, raw.source, 'user-message-center')
  }
}

const actionSyncKeyOf = (payload = {}) => [payload.id || payload.messageId || '', payload.stage || 'opened'].join('|')

const normalizeActionSyncQueue = (raw) => {
  const parsed = parseStored(raw, [])
  const list = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? Object.values(parsed) : [])
  return list
    .map((item) => item && typeof item === 'object' ? item : null)
    .filter(Boolean)
    .map((item) => {
      const payload = messageActionReceiptToPayload(item.payload || item)
      return {
        ...payload,
        syncKey: item.syncKey || actionSyncKeyOf(payload),
        pending: item.pending !== false,
        status: item.status || 'failed',
        error: item.error ? String(item.error) : '',
        retryCount: Number.isFinite(Number(item.retryCount)) ? Math.max(0, Math.round(Number(item.retryCount))) : 0
      }
    })
}

export function readMessageActionSyncQueue(api = storage()) {
  if (!api) return []
  try {
    return normalizeActionSyncQueue(api.getStorageSync(MESSAGE_ACTION_SYNC_QUEUE_KEY))
  } catch (e) {
    return []
  }
}

export function saveMessageActionSyncQueue(queue = [], api = storage()) {
  const next = normalizeActionSyncQueue(queue)
  if (api) {
    try { api.setStorageSync(MESSAGE_ACTION_SYNC_QUEUE_KEY, JSON.stringify(next)) } catch (e) {}
  }
  return next
}

export function enqueueMessageActionSync(receipt = {}, error = '', api = storage()) {
  const payload = messageActionReceiptToPayload(receipt)
  const syncKey = actionSyncKeyOf(payload)
  const queue = readMessageActionSyncQueue(api)
  const previous = queue.find((item) => item.syncKey === syncKey) || {}
  const next = {
    ...previous,
    ...payload,
    syncKey,
    pending: true,
    status: 'failed',
    error: error && (error.message || error.errMsg) ? String(error.message || error.errMsg) : String(error || '同步失败'),
    retryCount: (previous.retryCount || 0) + 1
  }
  const saved = queue.filter((item) => item.syncKey !== syncKey)
  saved.unshift(next)
  saveMessageActionSyncQueue(saved, api)
  return next
}

export function removeMessageActionSync(receiptOrKey, api = storage()) {
  const key = typeof receiptOrKey === 'string' ? receiptOrKey : actionSyncKeyOf(messageActionReceiptToPayload(receiptOrKey || {}))
  const next = readMessageActionSyncQueue(api).filter((item) => item.syncKey !== key)
  saveMessageActionSyncQueue(next, api)
  return next
}

export async function syncMessageActionReceipt(receipt = {}, syncer, api = storage()) {
  const payload = messageActionReceiptToPayload(receipt)
  if (!payload.id || typeof syncer !== 'function') return { ok: false, queued: false, payload }
  try {
    await syncer(payload)
    removeMessageActionSync(payload, api)
    return { ok: true, payload }
  } catch (e) {
    const queued = enqueueMessageActionSync(payload, e, api)
    return { ok: false, queued: true, payload: queued, error: e }
  }
}
export async function retryPendingMessageActionSync(syncer, api = storage(), options = {}) {
  const queue = readMessageActionSyncQueue(api)
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0 ? Math.round(Number(options.limit)) : queue.length
  let success = 0
  let failed = 0
  let skipped = 0
  for (const item of queue.slice(0, limit)) {
    const result = await syncMessageActionReceipt(item, syncer, api)
    if (result.ok) success += 1
    else if (result.queued) failed += 1
    else skipped += 1
  }
  return { total: queue.length, attempted: Math.min(queue.length, limit), success, failed, skipped, remaining: readMessageActionSyncQueue(api).length }
}
export function getMessageActionReceipt(messageOrId, receipts = readMessageActionReceipts()) {
  const id = String((messageOrId && (messageOrId.id || messageOrId.messageId)) || messageOrId || '')
  return id && receipts ? receipts[id] || null : null
}

const receiptTextOf = (receipt) => {
  if (!receipt) return ''
  if (receipt.stage === 'handled') {
    const page = String(receipt.page || '')
    const focus = String(receipt.focus || '')
    if (page.includes('/pages/report/detail') || focus.includes('report')) return '已处理完成'
    return '已提交材料'
  }
  if (receipt.stage === 'landed') return '已进入处理页'
  if (receipt.stage === 'opened') return '已打开'
  return ''
}

export function applyMessageActionReceipts(messages = [], receipts = readMessageActionReceipts()) {
  return messages.map((message) => {
    const receipt = getMessageActionReceipt(message, receipts)
    return receipt ? { ...message, actionReceipt: receipt, receiptText: receiptTextOf(receipt) } : message
  })
}

export function notifyMessageUnreadChange(payload = null) {
  const api = storage()
  if (api && typeof api.$emit === 'function') api.$emit(MESSAGE_UNREAD_EVENT, payload)
}

export function readDebtReminderItems(api = storage()) {
  if (!api) return []
  try {
    const parsed = parseStored(api.getStorageSync(DEBT_ITEM_REMINDER_KEY), {})
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    return Object.values(parsed).filter((item) => item && typeof item === 'object')
  } catch (e) {
    return []
  }
}

export function readDebtOptimizationGoal(api = storage()) {
  if (!api) return null
  try {
    const parsed = parseStored(api.getStorageSync(DEBT_OPTIMIZATION_GOAL_KEY), null)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch (e) {
    return null
  }
}

const debtReminderMessageTime = (item) => first(item.nextAt, item.remindAt, item.updatedAt, item.createdAt, Date.now())
const debtReminderMessageId = (item, index) => `debt_reminder_${item.id || index}_${String(first(item.updatedAt, item.createdAt, '')).replace(/[^\w-]/g, '')}`
const debtGoalMessageId = (goal) => `debt_goal_${goal.key || 'current'}_${String(first(goal.updatedAt, goal.title, '')).replace(/[^\w-]/g, '')}`
const debtProofMessageId = (record) => `debt_proof_${record.id || record.debtId || 'record'}_${String(debtProofStatusText(record)).replace(/[^\w\u4e00-\u9fa5-]/g, '')}_${String(first(record.reviewedAt, record.updatedAt, record.uploadedAt, record.createdAt, '')).replace(/[^\w-]/g, '')}`
const debtProofAcknowledged = (record = {}) => !!first(record.reviewAcknowledgedAt, record.reviewAckAt, record.acknowledgedAt, '')
const debtReportContextText = (item = {}) => first(item.reportTitle, item.reportName, item.creditReportTitle, item.reportId ? '关联信用报告' : '')
export const messageReportDetailActionUrl = (reportId = '', params = {}) => {
  const query = ['from=message']
  const normalizedReportId = first(reportId, params && params.reportId, '')
  if (normalizedReportId) {
    query.unshift(`id=${encodeURIComponent(normalizedReportId)}`)
    query.push(`reportId=${encodeURIComponent(normalizedReportId)}`)
  }
  Object.entries(params || {}).forEach(([key, value]) => {
    if (key === 'id' || key === 'from' || key === 'reportId') return
    if (value !== undefined && value !== null && value !== '') query.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
  })
  return `/pages/report/detail?${query.join('&')}`
}
const debtManageActionUrl = (reportId = '', params = {}) => {
  const query = ['from=message']
  if (reportId) query.unshift(`reportId=${encodeURIComponent(reportId)}`)
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') query.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
  })
  return `/pages/profile/debt-manage?${query.join('&')}`
}

export function buildDebtReminderMessages(reminders = readDebtReminderItems()) {
  return (Array.isArray(reminders) ? reminders : [])
    .filter((item) => item && typeof item === 'object')
    .map((item, index) => {
      const title = first(item.title, item.debtName, item.product, '单笔债务')
      const amount = first(item.amount, item.monthlyLabel, item.balanceLabel, '')
      const dueText = first(item.dueText, item.remindText, item.due, '按账单日提醒')
      const risk = String(item.riskLevel || '').toLowerCase()
      const level = risk === 'high' || risk === 'danger' ? 'warning' : 'info'
      const content = [title, amount, dueText].filter(Boolean).join(' · ')
      return {
        id: debtReminderMessageId(item, index),
        local: true,
        debt: true,
        category: 'advisor',
        tag: '债务',
        level,
        title: level === 'warning' ? '高优先级债务提醒' : '债务还款提醒',
        content: content || '已设置单笔债务提醒，请按计划处理。',
        actionText: '查看债务',
        actionUrl: debtManageActionUrl(item.reportId),
        reportId: item.reportId || '',
        contextText: debtReportContextText(item),
        debtId: item.id || '',
        createdAt: debtReminderMessageTime(item)
      }
    })
}

export function buildDebtProofMessages(records = readDebtExecutionRecords()) {
  return activeDebtExecutionRecords(Array.isArray(records) ? records : [])
    .filter((item) => item && item.type === 'proof')
    .map((record) => {
      const statusText = debtProofStatusText(record)
      const rejected = statusText === '需重传'
      const confirmed = statusText === '已确认'
      const acknowledged = debtProofAcknowledged(record)
      const ackNote = first(record.reviewAcknowledgedNote, acknowledged && rejected ? '已记录用户查看驳回原因，可继续重新上传。' : '', acknowledged && confirmed ? '已记录用户查看确认结果。' : '')
      const level = acknowledged && rejected ? 'info' : rejected ? 'danger' : confirmed ? 'success' : 'info'
      const title = acknowledged
        ? rejected ? '债务凭证驳回已查看' : confirmed ? '债务凭证确认已查看' : '债务凭证复核已查看'
        : rejected ? '债务凭证需重传' : confirmed ? '债务凭证已确认' : '债务凭证待复核'
      const content = acknowledged
        ? `${record.title || '债务'} · ${ackNote || record.reviewNote || '已记录查看复核结果。'}`
        : rejected
          ? `${record.title || '债务'} · ${record.reviewNote || '凭证未通过复核，请重新上传清晰完整凭证。'}`
          : confirmed
            ? `${record.title || '债务'} · 顾问已确认${record.fileName ? ` ${record.fileName}` : '该凭证'}。`
            : `${record.title || '债务'} · ${record.fileName || '凭证已上传'}，等待顾问复核。`
      return {
        id: debtProofMessageId(record),
        local: true,
        debt: true,
        category: 'advisor',
        tag: '债务',
        level,
        title,
        content,
        actionText: acknowledged && rejected ? '继续处理' : rejected ? '重新上传' : '查看记录',
        actionUrl: debtManageActionUrl(record.reportId, { debtId: record.debtId || '', executionRecordId: record.id || '', focus: rejected ? 'proof-reupload' : 'proof-record' }),
        reportId: record.reportId || '',
        debtId: record.debtId || '',
        executionRecordId: record.id || '',
        contextText: debtReportContextText(record),
        reviewAcknowledged: acknowledged,
        reviewAcknowledgedAt: first(record.reviewAcknowledgedAt, record.reviewAckAt, record.acknowledgedAt, ''),
        autoRead: acknowledged,
        receiptText: acknowledged ? '已查看复核结果' : '',
        createdAt: first(record.reviewedAt, record.updatedAt, record.uploadedAt, record.createdAt, Date.now())
      }
    })
}
export function buildDebtExecutionMessages(reminders = readDebtReminderItems(), goal = readDebtOptimizationGoal(), executionRecords = readDebtExecutionRecords()) {
  const messages = []
  if (goal && typeof goal === 'object' && goal.title) {
    messages.push({
      id: debtGoalMessageId(goal),
      local: true,
      debt: true,
      category: 'advisor',
      tag: '债务',
      level: 'info',
      title: '债务优化目标已更新',
      content: `${goal.title}${goal.sub ? `：${goal.sub}` : ''}`,
      actionText: '查看进度',
      actionUrl: debtManageActionUrl(goal.reportId),
      reportId: goal.reportId || '',
      contextText: debtReportContextText(goal),
      createdAt: first(goal.updatedAt, goal.createdAt, Date.now())
    })
  }
  return [...messages, ...buildDebtProofMessages(executionRecords), ...buildDebtReminderMessages(reminders)]
}
const advisorContactToStatus = (record, index) => {
  const context = normalizeAdvisorContactContext(record)
  if (!context.productName && !context.reportId && !context.materials.length) return null
  return {
    id: record.id || record._id || record.contactId || `contact_${index}`,
    status: record.status || 'processing',
    statusText: record.statusText || record.stateText || '顾问处理中',
    productId: context.productId,
    productName: context.productName || record.productName || '匹配方案',
    institution: context.institution || record.institution || '',
    matchRate: context.matchRate,
    reportId: context.reportId || record.reportId || '',
    reportTitle: context.reportTitle || record.reportTitle || '信用报告',
    reportScore: context.reportScore,
    reportDate: context.reportDate,
    materials: context.materials,
    createdAt: record.createdAt || record.createTime || record.time || record.updatedAt || record.updateTime || '',
    savedAt: Date.now()
  }
}

const hashString = (value = '') => Array.from(String(value)).reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0)
const contactIdOf = (record = {}) => String(first(record.contactId, record.id, record._id, record.statusId, '') || '').trim()
const latestContactMessageOf = (record = {}, context = {}) => {
  const messages = Array.isArray(context.messages) ? context.messages : asArray(record.messages)
  return messages.length ? messages[messages.length - 1] : null
}
const contactChannelOf = (record = {}, context = {}) => {
  const raw = String(first(context.channel, record.channel, record.deskType, record.serviceChannel, '') || '').toLowerCase()
  if (raw === 'service' || raw === 'support' || raw === 'customer-service') return 'service'
  if (String(first(context.contactType, record.contactType, '') || '') === 'customer-service') return 'service'
  return 'bank'
}
const contactMessageTimeOf = (message = {}) => first(message.createdAt, message.updateTime, message.updatedAt, message.time, message.ts, '')
const contactClientContextOf = (record = {}, context = {}, contactId = '') => {
  const normalizedContactId = String(contactId || '').trim()
  const identifier = (...values) => {
    for (const candidate of values) {
      const value = String(candidate || '').trim()
      if (value && value !== normalizedContactId) return value
    }
    return ''
  }
  const clientUid = identifier(record.clientUid, record.uid, record.userId, record.customerUid, context.clientUid)
  const clientId = identifier(context.clientId, record.clientId, record.customerId)
  const clientName = String(first(
    record.clientName,
    record.name,
    record.realName,
    record.customerName,
    record.clientInfo && (record.clientInfo.name || record.clientInfo.nickname),
    record.userInfo && (record.userInfo.name || record.userInfo.nickname),
    record.customer && (record.customer.name || record.customer.nickname),
    '客户'
  ) || '客户').trim()
  const clientGroupKey = clientUid
    ? `uid:${clientUid}`
    : clientId
      ? `client:${clientId}`
      : `contact:${normalizedContactId}`
  return {
    clientScoped: true,
    clientGroupKey,
    clientUid,
    clientId,
    clientName,
    avatar: String(first(context.avatar, record.avatar, record.avatarUrl, record.avatarURL, '') || '').trim(),
    phone: String(first(record.phone, record.mobile, '') || '').trim(),
    businessName: String(first(context.businessName, record.businessName, '') || '').trim(),
    businessType: String(first(context.businessType, record.businessType, '') || '').trim(),
    serviceType: String(first(context.serviceType, record.serviceType, '') || '').trim(),
    contactIntent: String(first(context.contactIntent, record.contactIntent, '') || '').trim(),
    source: String(first(context.source, record.source, '') || '').trim(),
    contactType: String(first(context.contactType, record.contactType, '') || '').trim(),
    institution: String(first(context.institution, record.institution, '') || '').trim(),
    productName: String(first(context.productName, record.productName, '') || '').trim()
  }
}
const advisorContactToChatMessage = (record, index) => {
  const contactId = contactIdOf(record)
  if (!contactId) return null
  const context = normalizeAdvisorContactContext(record)
  const clientContext = contactClientContextOf(record, context, contactId)
  const latestMessage = latestContactMessageOf(record, context) || {}
  const remoteUnreadCount = Number(record.unreadCount || record.unread_count || 0)
  const unreadCount = Number.isFinite(remoteUnreadCount) && remoteUnreadCount > 0 ? Math.round(remoteUnreadCount) : 0
  const hasUnread = record.hasUnread === true || unreadCount > 0
  const channel = contactChannelOf(record, context)
  const isGroup = channel === 'bank' && (record.serviceRequired === true || record.groupMode === 'service-bank-customer' || context.contactType === 'match-product' || record.contactType === 'match-product')
  const title = channel === 'service' ? '客服聊天记录' : isGroup ? '三方沟通记录' : '产品咨询记录'
  const productText = [context.institution || record.institution || '', context.productName || record.productName || ''].filter(Boolean).join(' · ')
  const latestText = first(latestMessage.content, latestMessage.text, latestMessage.message, context.summary, record.summary, '')
  const sender = first(latestMessage.senderName, latestMessage.senderType === 'service' ? '客服' : latestMessage.senderType === 'bank' ? '银行老师' : latestMessage.senderType === 'admin' ? '管理员' : '', '')
  const time = first(
    contactMessageTimeOf(latestMessage),
    record.updateTime,
    record.updatedAt,
    record.latestTime,
    record.createTime,
    record.createdAt,
    record.time,
    Date.now()
  )
  const messageKey = [
    contactId,
    latestMessage.id,
    contactMessageTimeOf(latestMessage),
    latestText,
    record.updateTime || record.updatedAt || ''
  ].join('|')
  const id = `chat_${Math.abs(hashString(messageKey || `${contactId}_${index}`))}`
  return {
    id,
    local: true,
    category: 'consultation',
    tag: '咨询',
    title,
    content: [productText, sender && latestText ? `${sender}: ${latestText}` : latestText || '点击查看聊天记录'].filter(Boolean).join(' · '),
    createdAt: time,
    time,
    read: !hasUnread,
    unreadCount,
    hasUnread,
    actionText: '继续沟通',
    actionUrl: `/pages/chat/conversation?contactId=${encodeURIComponent(contactId)}`,
    statusId: contactId,
    contactId,
    focus: 'chat',
    messageKind: 'customer-chat',
    ...clientContext
  }
}

export function buildCustomerChatMessages(contactsData = null) {
  return asArray(contactsData)
    .map(advisorContactToChatMessage)
    .filter(Boolean)
}

export function buildConsultationMessages(contactsData = null, localStatus = readLastConsultationStatus()) {
  const local = consultationStatusToMessage(localStatus, 'local')
  const contacts = asArray(contactsData)
  const contactMessages = contacts
    .map(advisorContactToStatus)
    .filter(Boolean)
    .map((item, index) => consultationStatusToMessage(item, item.id || index))
    .filter(Boolean)
  const chatMessages = buildCustomerChatMessages(contacts)
  const map = new Map()
  ;[local, ...contactMessages, ...chatMessages].filter(Boolean).forEach((item) => {
    if (!map.has(item.id)) map.set(item.id, item)
  })
  return Array.from(map.values())
}

export function getDebtMessageViewState(message = {}) {
  if (!message || !message.debt) return 'other'
  const receipt = message.actionReceipt && typeof message.actionReceipt === 'object' ? message.actionReceipt : {}
  const stage = String(first(message.stage, receipt.stage, '')).toLowerCase()
  const viewed = !!(message.reviewAcknowledged || message.autoRead || message.read || message.receiptText || receipt.openedAt || receipt.landedAt || receipt.handledAt || ['opened', 'landed', 'handled'].includes(stage))
  return viewed ? 'viewed' : 'pending'
}

export function filterDebtMessagesByViewState(messages = [], viewState = 'all') {
  const list = (Array.isArray(messages) ? messages : []).filter((item) => item && item.debt)
  if (viewState === 'pending') return list.filter((item) => getDebtMessageViewState(item) === 'pending')
  if (viewState === 'viewed') return list.filter((item) => getDebtMessageViewState(item) === 'viewed')
  return list
}

export function countUnreadLocalMessages(messages = [], localReadIds = readLocalMessageIds(), settings = readNotificationSettings(), options = {}) {
  return applyNotificationSettings(messages, settings, options)
    .filter((item) => {
      if (!item || !item.local || item.autoRead || item.reviewAcknowledged || item.muted) return false
      if (Number(item.unreadCount || 0) > 0 || item.hasUnread === true) return true
      return !localReadIds.has(String(item.id)) && item.read !== true
    }).length
}

export function countActiveUnreadMessages(messages = [], settings = readNotificationSettings(), options = {}) {
  return applyNotificationSettings(messages, settings, options).filter((item) => item && !item.muted && !item.read).length
}

const pickRemoteUnreadCount = (payload) => {
  if (typeof payload === 'number') return payload
  const data = payload && payload.data ? payload.data : payload
  const value = data && (data.count ?? data.unreadCount ?? data.unread_count ?? data.total)
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

const hasActiveSilencingRules = (settings) => {
  const normalized = normalizeNotificationSettings(settings)
  return !normalized.enabled || Object.values(normalized.mutedCategories).some(Boolean) || isQuietHoursActive(normalized)
}

const remoteMessageToUnreadItem = (message, index) => ({
  id: String(message.id || message._id || message.messageId || `remote_${index}`),
  category: message.category || message.type || 'system',
  level: message.level || '',
  title: message.title || message.subject || message.type || '',
  content: message.content || message.body || message.text || message.message || '',
  actionText: message.actionText || '',
  read: !!(message.read || message.isRead || message.is_read || message.status === 'read')
})

export async function getMessageUnreadSummary() {
  const { getUserId, isLoggedIn } = await import('./authService.js')
  if (!isLoggedIn()) return { total: 0, remote: 0, local: 0, consultation: 0 }
  const { getCurrentRole } = await import('./roleService.js')
  if (getCurrentRole() === 'service') {
    try {
      const { getTeacherClientsData } = await import('./teacherService.js')
      const data = await getTeacherClientsData({ port: 'service' })
      const actorId = String(getUserId() || '')
      const clients = (data && Array.isArray(data.clients) ? data.clients : []).filter((item) => (
        !item.serviceAssigneeId || (actorId && String(item.serviceAssigneeId) === actorId)
      ))
      const customerChats = buildCustomerChatMessages(clients)
      const total = customerChats.reduce((sum, message) => {
        const count = Number(message.unreadCount || 0)
        if (Number.isFinite(count) && count > 0) return sum + count
        return sum + (message.hasUnread === true || message.read === false ? 1 : 0)
      }, 0)
      return { total, remote: 0, local: total, consultation: total, debt: 0 }
    } catch (e) {
      return { total: 0, remote: 0, local: 0, consultation: 0, debt: 0 }
    }
  }
  const settings = readNotificationSettings()
  const { getAdvisorContacts, getDebtExecutionRecords, getMessageList, getUnreadCount } = await import('./profileService.js')
  let remote = 0
  let contactsData = null
  if (hasActiveSilencingRules(settings)) {
    try {
      const remoteMessages = asArray(await getMessageList('all')).map(remoteMessageToUnreadItem)
      remote = countActiveUnreadMessages(remoteMessages, settings)
    } catch (e) {
      remote = 0
    }
  } else {
    try {
      remote = pickRemoteUnreadCount(await getUnreadCount())
    } catch (e) {
      remote = 0
    }
  }
  try {
    contactsData = await getAdvisorContacts()
  } catch (e) {
    contactsData = null
  }
  const consultationMessages = buildConsultationMessages(contactsData)
  let debtRecords = readDebtExecutionRecords()
  try {
    const cloudDebtRecords = await getDebtExecutionRecords()
    const synced = applyDebtExecutionCloudSnapshot(debtRecords, { remoteRecords: cloudDebtRecords, contactRecords: contactsData })
    debtRecords = synced.records
    if (synced.changed) saveDebtExecutionRecords(debtRecords)
  } catch (e) {
    const synced = applyDebtExecutionCloudSnapshot(debtRecords, { contactRecords: contactsData })
    debtRecords = synced.records
    if (synced.changed) saveDebtExecutionRecords(debtRecords)
  }
  const debtMessages = buildDebtExecutionMessages(undefined, undefined, debtRecords)
  const localIds = readLocalMessageIds()
  const consultationLocal = countUnreadLocalMessages(consultationMessages, localIds, settings)
  const debtLocal = countUnreadLocalMessages(debtMessages, localIds, settings)
  const local = consultationLocal + debtLocal
  return { total: remote + local, remote, local, consultation: consultationLocal, debt: debtLocal }
}

export default {
  LOCAL_MESSAGE_READ_KEY,
  MESSAGE_UNREAD_EVENT,
  NOTIFICATION_SETTINGS_KEY,
  SYSTEM_PUSH_PERMISSION_KEY,
  SYSTEM_PUSH_BINDING_KEY,
  NOTIFICATION_SYNC_STATE_KEY,
  MESSAGE_ACTION_RECEIPT_KEY,
  MESSAGE_ACTION_SYNC_QUEUE_KEY,
  MESSAGE_CENTER_VIEW_STATE_KEY,
  DEBT_ITEM_REMINDER_KEY,
  DEBT_OPTIMIZATION_GOAL_KEY,
  DEFAULT_NOTIFICATION_SETTINGS,
  MESSAGE_CATEGORY_KEYS,
  MESSAGE_CENTER_FILTER_KEYS,
  MESSAGE_CENTER_DEBT_VIEW_KEYS,
  readLocalMessageIds,
  saveLocalMessageIds,
  normalizeMessageCenterViewState,
  readMessageCenterViewState,
  saveMessageCenterViewState,
  resolveMessageCenterReturnViewState,
  notifyMessageUnreadChange,
  normalizeNotificationSettings,
  normalizeSystemPushPermissionState,
  readSystemPushPermissionState,
  saveSystemPushPermissionState,
  systemPushPermissionToBindingPayload,
  normalizeSystemPushBindingState,
  readSystemPushBindingState,
  saveSystemPushBindingState,
  syncSystemPushBinding,
  detectSystemPushPermissionState,
  requestSystemPushPermission,
  notificationSettingsToPayload,
  readNotificationSettings,
  saveLocalNotificationSettings,
  normalizeNotificationSyncState,
  readNotificationSyncState,
  saveNotificationSyncState,
  markNotificationSyncPending,
  markNotificationSyncFailed,
  markNotificationSyncSuccess,
  hasPendingNotificationSync,
  isQuietHoursActive,
  isCriticalConsultationMessage,
  getMessageMuteState,
  applyNotificationSettings,
  readMessageActionReceipts,
  saveMessageActionReceipt,
  messageActionReceiptToPayload,
  messageReportDetailActionUrl,
  readMessageActionSyncQueue,
  saveMessageActionSyncQueue,
  enqueueMessageActionSync,
  removeMessageActionSync,
  syncMessageActionReceipt,
  retryPendingMessageActionSync,
  getMessageActionReceipt,
  applyMessageActionReceipts,
  readDebtReminderItems,
  readDebtOptimizationGoal,
  buildDebtReminderMessages,
  buildDebtProofMessages,
  buildDebtExecutionMessages,
  getDebtMessageViewState,
  filterDebtMessagesByViewState,
  buildCustomerChatMessages,
  buildConsultationMessages,
  countUnreadLocalMessages,
  countActiveUnreadMessages,
  getMessageUnreadSummary
}
