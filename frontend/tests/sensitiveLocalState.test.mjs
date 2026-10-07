import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  SENSITIVE_BUSINESS_STORAGE_KEYS,
  SENSITIVE_SESSION_STORAGE_KEYS,
  captureLocalSessionState,
  clearLocalSessionState,
  clearSensitiveBusinessState,
  isLocalSessionStateCurrent
} from '../src/services/sensitiveLocalState.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const authSource = readFileSync(join(__dirname, '..', 'src', 'services', 'authService.js'), 'utf8')
const apiClientSource = readFileSync(join(__dirname, '..', 'src', 'services', 'apiClient.js'), 'utf8')
const reportStorageSource = readFileSync(join(__dirname, '..', 'src', 'services', 'reportStorage.js'), 'utf8')

describe('sensitive local business state cleanup', () => {
  it('removes records, every outbox, receipts, contexts and scoped material caches', () => {
    const values = new Map()
    for (const key of SENSITIVE_BUSINESS_STORAGE_KEYS) values.set(key, `private:${key}`)
    values.set('rpt_supplement_materials_v1:uid-a:case:report-a', 'private-material')
    values.set('rpt_message_notification_settings', 'device-preference')

    const api = {
      getStorageInfoSync: () => ({ keys: [...values.keys()] }),
      removeStorageSync: (key) => values.delete(key)
    }
    const removed = clearSensitiveBusinessState(api)

    assert.equal(values.has('debt_execution_records'), false)
    assert.equal(values.has('rpt_debt_execution_sync_queue'), false)
    assert.equal(values.has('rpt_consultation_material_sync_queue'), false)
    assert.equal(values.has('rpt_message_action_sync_queue'), false)
    assert.equal(values.has('rpt_user_last_consultation_status'), false)
    assert.equal(values.has('rpt_supplement_materials_v1:uid-a:case:report-a'), false)
    assert.equal(values.get('rpt_message_notification_settings'), 'device-preference')
    assert.ok(removed.length >= SENSITIVE_BUSINESS_STORAGE_KEYS.length)
  })

  it('runs cleanup on logout, account deletion and direct identity changes', () => {
    assert.match(authSource, /export async function logout\(\)[\s\S]*_clearAuthData\(\)/)
    assert.match(authSource, /export async function deleteAccount\(\)[\s\S]*_clearAuthData\(\)/)
    assert.match(authSource, /prevUid && String\(prevUid\) !== String\(res\.uid\)[\s\S]*clearLocalSessionState\(\)/)
    assert.match(authSource, /function _clearAuthData\(\)[\s\S]*clearLocalSessionState\(\)/)
  })

  it('removes identity, reports and business data when a session expires', () => {
    const values = new Map()
    for (const key of SENSITIVE_SESSION_STORAGE_KEYS) values.set(key, `private:${key}`)
    for (const key of SENSITIVE_BUSINESS_STORAGE_KEYS) values.set(key, `private:${key}`)
    values.set('report_REPORT_123', 'private-report')
    values.set('rpt_supplement_materials_v1:uid-a:case-a', 'private-material')
    values.set('rpt_message_notification_settings', 'device-preference')
    const api = {
      getStorageInfoSync: () => ({ keys: [...values.keys()] }),
      removeStorageSync: (key) => values.delete(key)
    }

    clearLocalSessionState(api)

    assert.equal(values.has('auth_token'), false)
    assert.equal(values.has('userInfo'), false)
    assert.equal(values.has('uni_id'), false)
    assert.equal(values.has('report_REPORT_123'), false)
    assert.equal(values.has('debt_execution_records'), false)
    assert.equal(values.has('rpt_supplement_materials_v1:uid-a:case-a'), false)
    assert.equal(values.get('rpt_message_notification_settings'), 'device-preference')
  })

  it('uses the same full cleanup for local expiry and failed 401 refresh', () => {
    assert.match(authSource, /Date\.now\(\) > expiresAt\)[\s\S]*_clearAuthData\(\)/)
    assert.match(apiClientSource, /const clearStoredAuthCredential = \(sessionSnapshot = null\) => \{[\s\S]*clearLocalSessionState\(\)/)
    assert.match(apiClientSource, /buildAuthExpiredError[\s\S]*clearStoredAuthCredential\(sessionSnapshot\)/)
    assert.match(apiClientSource, /const _refreshFlights = new Map\(\)/)
    assert.match(apiClientSource, /_refreshAuthToken\(requestSession\)/)
    assert.match(apiClientSource, /ensureSessionResponseIsCurrent\(requestSession, token\)/)
    assert.match(reportStorageSource, /_listCache\.sessionRevision === getSessionCleanupRevision\(\)/)
    assert.match(reportStorageSource, /_latestCache\.sessionRevision === getSessionCleanupRevision\(\)/)
  })

  it('marks an old refresh snapshot stale after a direct account switch', () => {
    const values = new Map([
      ['auth_token', 'token-a'],
      ['uni_id', 'uid-a'],
      ['report_CASE_A', 'private-a']
    ])
    const api = {
      getStorageSync: (key) => values.get(key) || '',
      getStorageInfoSync: () => ({ keys: [...values.keys()] }),
      removeStorageSync: (key) => values.delete(key)
    }
    const snapshotA = captureLocalSessionState(api)

    clearLocalSessionState(api)
    values.set('auth_token', 'token-b')
    values.set('uni_id', 'uid-b')
    values.set('report_CASE_B', 'private-b')

    assert.equal(isLocalSessionStateCurrent(snapshotA, api), false)
    assert.equal(values.get('auth_token'), 'token-b')
    assert.equal(values.get('report_CASE_B'), 'private-b')
  })
})
