import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
	buildTeacherSyncMeta,
	buildUserWritebackSyncSummary,
	collectRequiredMissing,
	collectUserWritebackMissing,
	latestTimestampFromItems
} from '../src/services/teacherRealtime.js'

describe('teacherRealtime', () => {
	it('marks a fresh complete teacher payload as realtime', () => {
		const now = Date.parse('2026-07-01T10:00:30Z')
		const meta = buildTeacherSyncMeta({
			source: 'teacher-clients',
			fetchedAt: now - 1000,
			now
		})

		assert.equal(meta.state, 'live')
		assert.equal(meta.label, '实时同步')
		assert.equal(meta.isComplete, true)
		assert.equal(meta.isRealtime, true)
		assert.equal(meta.sourceText, '老师端接口')
	})

	it('surfaces incomplete payloads with missing field names', () => {
		const missing = collectRequiredMissing([
			{ id: 'c1', name: '张先生' },
			{ id: 'c2', status: 'pending' }
		], ['id', 'name', 'status'], 'clients')

		const meta = buildTeacherSyncMeta({
			source: 'teacher-clients',
			missingFields: missing,
			now: Date.parse('2026-07-01T10:00:30Z')
		})

		assert.deepEqual(missing, ['clients[0].status', 'clients[1].name'])
		assert.equal(meta.state, 'incomplete')
		assert.equal(meta.label, '数据不完整')
		assert.equal(meta.isComplete, false)
	})

	it('keeps the newest update timestamp from list items', () => {
		const latest = latestTimestampFromItems([
			{ updateTime: '2026-07-01T09:00:00Z' },
			{ raw: { updatedAt: '2026-07-01T09:10:00Z' } },
			{ createTime: '2026-07-01T08:00:00Z' },
			{ writebackSummary: { latestAt: Date.parse('2026-07-01T09:20:00Z') } }
		])

		assert.equal(latest, Date.parse('2026-07-01T09:20:00Z'))
	})
	it('summarizes complete user writebacks for teacher and monitor reads', () => {
		const summary = buildUserWritebackSyncSummary({
			requiredWritebacks: ['materialSubmit', 'messageAction', 'pushBinding'],
			materialSubmits: [{ materialId: 'income', status: 'uploaded', uploadUrl: 'https://example.test/income.pdf', uploadedAt: '2026-07-02T10:02:00Z' }],
			messageActionReceipt: { messageId: 'msg-1', stage: 'handled', handledAt: '2026-07-02T10:03:00Z' },
			pushBinding: { status: 'synced', binding: { status: 'granted', platform: 'browser', clientId: 'cid-1', updatedAt: '2026-07-02T10:04:00Z' } }
		})

		assert.equal(summary.hasWritebacks, true)
		assert.equal(summary.isComplete, true)
		assert.equal(summary.counts.materialSubmit, 1)
		assert.equal(summary.counts.messageAction, 1)
		assert.equal(summary.counts.pushBinding, 1)
		assert.equal(summary.counts.incomplete, 0)
		assert.equal(summary.latestAt, Date.parse('2026-07-02T10:04:00Z'))
	})

	it('reports incomplete user writeback paths for syncMeta', () => {
		const missing = collectUserWritebackMissing([{
			id: 'client-1',
			name: '张先生',
			status: 'processing',
			requiredWritebacks: ['materialSubmit', 'messageAction', 'pushBinding'],
			materialSubmits: [{ status: 'uploaded' }],
			actionReceipt: { messageId: 'msg-1' },
			pushBinding: { status: 'granted', platform: 'browser' }
		}], 'clients')

		assert.equal(missing.includes('clients[0].writebacks.materialSubmit[0].materialIdOrName'), true)
		assert.equal(missing.includes('clients[0].writebacks.materialSubmit[0].uploadProof'), true)
		assert.equal(missing.includes('clients[0].writebacks.messageAction[0].stage'), true)
		assert.equal(missing.includes('clients[0].writebacks.messageAction[0].actionAt'), true)
		assert.equal(missing.includes('clients[0].writebacks.pushBinding[0].updatedAt'), true)
	})
	it('counts debt proof review acknowledgements as message action writebacks', () => {
		const summary = buildUserWritebackSyncSummary({
			debtExecutionRecords: [{
				id: 'proof-a',
				type: 'proof',
				status: 'confirmed',
				uploadUrl: 'https://example.test/proof.png',
				fileName: 'proof.png',
				uploadedAt: '2026-07-02T10:02:00Z',
				reviewAckStage: 'review_acknowledged',
				reviewAcknowledgedAt: '2026-07-02T10:06:00Z'
			}]
		})

		assert.equal(summary.counts.materialSubmit, 1)
		assert.equal(summary.counts.messageAction, 1)
		assert.equal(summary.messageAction.items[0].stage, 'review_acknowledged')
		assert.equal(summary.messageAction.items[0].actionAt, '2026-07-02T10:06:00Z')
		assert.equal(summary.isComplete, true)
	})
	it('counts debt proof records as material writebacks', () => {
		const summary = buildUserWritebackSyncSummary({
			debtExecutionRecords: [{
				id: 'proof-a',
				status: 'reviewing',
				uploadUrl: 'https://example.test/proof.png',
				fileName: 'proof.png',
				uploadedAt: '2026-07-02T10:02:00Z'
			}]
		})

		assert.equal(summary.hasWritebacks, true)
		assert.equal(summary.counts.materialSubmit, 1)
		assert.equal(summary.materialSubmit.items[0].isComplete, true)
	})
})
