export const SENSITIVE_BUSINESS_STORAGE_KEYS = Object.freeze([
  'debt_execution_records',
  'rpt_debt_execution_sync_queue',
  'debt_repay_reminder',
  'debt_item_repay_reminders',
  'debt_optimization_goal',
  'debt_advisor_context',
  'rpt_user_last_consultation_status',
  'rpt_consultation_material_sync_queue',
  'rpt_message_action_receipts',
  'rpt_message_action_sync_queue',
  'rpt_local_message_read_ids',
  'rpt_message_center_view_state',
  'rpt_message_notification_sync_state',
  'rpt_system_push_binding_state',
  'rpt_local_test_conversations',
  'report_match_context',
  'report_manage_view_state',
  'report_manage_detail_context',
  'teacher_application',
  'currentRole',
  'isAdvisorMode'
])

export const SENSITIVE_BUSINESS_STORAGE_PREFIXES = Object.freeze([
  'rpt_supplement_materials_v1'
])

export const SENSITIVE_SESSION_STORAGE_KEYS = Object.freeze([
  'auth_token',
  'uni_id_token',
  'uni_id_token_expired',
  'uni_id',
  'userId',
  'userInfo',
  'userName',
  'userPhone',
  'report_list',
  'currentTaskId',
  'analysisResult'
])

export const SENSITIVE_SESSION_STORAGE_PREFIXES = Object.freeze([
  'report_'
])

// Vite SSR/HMR can evaluate this module through more than one module graph.
// Keep the invalidation counter on the JS realm so every graph observes the
// same logout/business-state cleanup boundary.
const SESSION_CLEANUP_STATE_KEY = Symbol.for('reportflow.web.session-cleanup-state.v1')
const sessionCleanupState = globalThis[SESSION_CLEANUP_STATE_KEY] || { revision: 0 }
if (!globalThis[SESSION_CLEANUP_STATE_KEY]) {
  Object.defineProperty(globalThis, SESSION_CLEANUP_STATE_KEY, {
    value: sessionCleanupState,
    configurable: false,
    enumerable: false,
    writable: false
  })
}

const bumpSessionCleanupRevision = () => {
  sessionCleanupState.revision += 1
}

export const getSessionCleanupRevision = () => sessionCleanupState.revision

export const captureLocalSessionState = (api = typeof uni !== 'undefined' ? uni : null) => {
  let token = ''
  try {
    token = api && typeof api.getStorageSync === 'function'
      ? String(api.getStorageSync('auth_token') || api.getStorageSync('uni_id_token') || '').trim()
      : ''
  } catch (_) {}
  return { token, revision: sessionCleanupState.revision }
}

export const isLocalSessionStateCurrent = (snapshot = {}, api = typeof uni !== 'undefined' ? uni : null) => {
  if (!snapshot || typeof snapshot !== 'object') return false
  const current = captureLocalSessionState(api)
  return current.token === String(snapshot.token || '') && current.revision === Number(snapshot.revision)
}

const clearSensitiveBusinessStateInternal = (api, invalidateTrust) => {
  if (invalidateTrust) bumpSessionCleanupRevision()
  if (!api || typeof api.removeStorageSync !== 'function') return []
  const keys = new Set(SENSITIVE_BUSINESS_STORAGE_KEYS)
  try {
    const info = typeof api.getStorageInfoSync === 'function' ? api.getStorageInfoSync() : null
    const storedKeys = info && Array.isArray(info.keys) ? info.keys : []
    storedKeys.forEach((key) => {
      const text = String(key || '')
      if (SENSITIVE_BUSINESS_STORAGE_PREFIXES.some((prefix) => text === prefix || text.startsWith(`${prefix}:`))) {
        keys.add(text)
      }
    })
  } catch (_) {}

  const removed = []
  keys.forEach((key) => {
    try {
      api.removeStorageSync(key)
      removed.push(key)
    } catch (_) {}
  })
  return removed
}

export function clearSensitiveBusinessState(api = typeof uni !== 'undefined' ? uni : null) {
  return clearSensitiveBusinessStateInternal(api, true)
}

export function clearLocalSessionState(api = typeof uni !== 'undefined' ? uni : null) {
  bumpSessionCleanupRevision()
  if (!api || typeof api.removeStorageSync !== 'function') return []
  const keys = new Set(SENSITIVE_SESSION_STORAGE_KEYS)
  try {
    const info = typeof api.getStorageInfoSync === 'function' ? api.getStorageInfoSync() : null
    const storedKeys = info && Array.isArray(info.keys) ? info.keys : []
    storedKeys.forEach((key) => {
      const text = String(key || '')
      if (SENSITIVE_SESSION_STORAGE_PREFIXES.some((prefix) => text.startsWith(prefix))) keys.add(text)
    })
  } catch (_) {}

  clearSensitiveBusinessStateInternal(api, false).forEach((key) => keys.add(key))
  const removed = []
  keys.forEach((key) => {
    try {
      api.removeStorageSync(key)
      removed.push(key)
    } catch (_) {}
  })
  return removed
}

export default {
  clearSensitiveBusinessState,
  clearLocalSessionState,
  getSessionCleanupRevision,
  captureLocalSessionState,
  isLocalSessionStateCurrent
}
