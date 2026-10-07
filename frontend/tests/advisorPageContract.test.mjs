import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(__dirname, '..', 'src', 'pages', 'profile', 'Advisor.vue'), 'utf8')

describe('advisor page user follow-up contract', () => {
  it('loads local, advisor-my, and contact records into one consultation timeline', () => {
    assert.match(source, /consultationStatusToContactRecord\(readLastConsultationStatus\(\)\)/)
    assert.match(source, /getAdvisorMy\(\)/)
    assert.match(source, /getAdvisorContacts\(\)/)
    assert.match(source, /commitServiceRecords\(uniqueRecords\(rawRecords\.map\(normalizeRecord\)\)\)/)
    assert.match(source, /buildConsultationProgress\(/)
  })

  it('records message landing and material handling receipts', () => {
    assert.match(source, /readMessageCenterViewState\(\)/)
    assert.match(source, /saveMessageActionReceipt\(\{[\s\S]*stage: 'landed'/)
    assert.match(source, /syncMessageActionReceipt\(landedReceipt, saveMessageActionReceiptRemote\)/)
    assert.match(source, /saveMessageActionReceipt\([\s\S]*stage: 'handled'/)
    assert.match(source, /syncMessageActionReceipt\(handledReceipt, saveMessageActionReceiptRemote\)/)
  })

  it('keeps material upload and advisor material sync wired', () => {
    assert.match(source, /uploadLocalFile\(\{ filePath: picked\.path, folder: 'consultation-materials' \}\)/)
    assert.match(source, /markLastConsultationMaterialUploaded\(item, fileMeta\)/)
    assert.match(source, /buildAdvisorMaterialSubmitPayload\(record, item, fileMeta/)
    assert.match(source, /syncConsultationMaterialSubmit\(materialPayload, submitAdvisorContactMaterial\)/)
  })

  it('keeps debt optimization context available while booking through service chat', () => {
    assert.match(source, /DEBT_ADVISOR_CONTEXT_KEY = 'debt_advisor_context'/)
    assert.match(source, /createCustomerServiceContact\(\{[\s\S]*contactIntent: debtContext \? 'debt-optimization' : 'appointment'/)
    assert.match(source, /initialMessage: debtContext \? `我想预约/)
    assert.doesNotMatch(source, /createAdvisorContact\('', reportId/)
    assert.match(source, /debtExecutionRecordsToMaterials\(saved\.executionRecords \|\| \[\]\)/)
  })
})
