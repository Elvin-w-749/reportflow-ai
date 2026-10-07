import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(__dirname, '..', 'src', 'services', 'profileService.js'), 'utf8')
const conversationSource = readFileSync(join(__dirname, '..', 'src', 'pages', 'chat', 'Conversation.vue'), 'utf8')

describe('profile service user writeback endpoints', () => {
	it('keeps user action feedback endpoints wired to cloud api paths', () => {
		const expected = [
			'/api/profile/push-binding',
			'/api/profile/debt-execution-records',
			'/api/profile/debt-execution-record',
			'/api/profile/debt-execution-records/sync',
			'/api/message/action-receipt',
			'/api/advisor/contact/material-submit',
			'/api/advisor/contact/message',
			'/api/advisor/contact/feedback',
			'/api/advisor/contact/complete',
			'/api/advisor/contact/end',
			'/api/advisor/contact/clear-view',
			'/api/advisor/contact/read',
			'/api/advisor/bank-teachers',
			'/api/advisor/contact/invite-advisor',
			'/api/advisor/contact/rename'
		]

		for (const path of expected) {
			assert.match(source, new RegExp(path.replace(/[/-]/g, (char) => `\\${char}`)))
		}
	})

	it('passes an optional report scope to the cloud debt summary', () => {
		assert.match(source, /export function getDebtSummary\(params = \{\}\)/)
		assert.match(source, /url: '\/api\/profile\/debt-summary', method: 'GET', data: params/)
	})

	it('passes rich consultation context through createAdvisorContact', () => {
		assert.match(source, /export function createAdvisorContact\(advisorId, reportId, contactType = 'phone', context = \{\}\)/)
		assert.match(source, /Object\.assign\(data, context\)/)
		assert.match(source, /data\.context = context/)
		assert.match(source, /contactType/)
	})

	it('exposes customer service and conversation message APIs', () => {
		assert.match(source, /export function createCustomerServiceContact\(context = \{\}\)/)
		assert.match(source, /contactType: 'customer-service'/)
		assert.match(source, /channel: 'service'/)
		assert.match(source, /export function resolveAdvisorContactId\(payload = \{\}\)/)
		assert.match(source, /export function openAdvisorConversation\(payload\)/)
		assert.match(source, /export function getAdvisorContactMessages\(contactId\)/)
		assert.match(source, /\/api\/advisor\/contact\/\$\{encodeURIComponent\(contactId\)\}\/messages/)
		assert.match(source, /export function sendAdvisorContactMessage\(contactId, content\)/)
		assert.match(source, /export function submitAdvisorContactFeedback\(contactId, feedback = \{\}\)/)
		assert.match(source, /export function completeAdvisorContact\(contactId, payload = \{\}\)/)
		assert.match(source, /export function endAdvisorContact\(contactId, payload = \{\}\)/)
		assert.match(source, /export function clearAdvisorContactView\(contactId\)/)
		assert.match(source, /export function markAdvisorContactRead\(contactId\)/)
		assert.match(source, /export function getBankAdvisorCandidates\(contactId = ''\)/)
		assert.match(source, /data: scopedContactId \? \{ contactId: scopedContactId \} : \{\}/)
		assert.match(conversationSource, /getBankAdvisorCandidates\(contactId\.value\)/)
		assert.match(source, /export function inviteAdvisorToContact\(contactId, payload = \{\}\)/)
		assert.match(source, /export function renameAdvisorContactGroup\(contactId, groupName\)/)
	})
})
