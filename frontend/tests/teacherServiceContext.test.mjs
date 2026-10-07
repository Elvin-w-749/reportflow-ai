import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeAdvisorContactContext } from '../src/services/teacherContactContext.js'

describe('teacher service consultation context', () => {
	it('keeps report and product context from advisor contacts', () => {
		const contact = normalizeAdvisorContactContext({
			id: 'contact-1',
			clientName: '张三',
			phone: '13800000000',
			status: 'pending',
			createTime: '2026-07-02T10:00:00+08:00',
			context: {
				source: 'match-page',
				summary: '优先咨询经营周转贷',
				report: { id: 'REPORT_1', title: '7月信用报告', scoreText: '718', date: '2026-07-01' },
				product: { id: 'local_001', name: '经营周转贷', institution: '示例银行', rateText: '年化 3.2%-4.8% 浮动', amountText: '最高 100 万', termText: '12-36 期', matchRate: 86 },
				materialChecklist: ['收入流水', { name: '负债明细', status: 'uploaded' }, { name: '身份证明', status: 'confirmed' }]
			}
		}, 0)

		assert.equal(contact.reportId, 'REPORT_1')
		assert.equal(contact.reportTitle, '7月信用报告')
		assert.equal(contact.reportScore, 718)
		assert.equal(contact.productName, '经营周转贷')
		assert.equal(contact.institution, '示例银行')
		assert.equal(contact.businessName, '')
		assert.equal(contact.rateText, '年化 3.2%-4.8% 浮动')
		assert.equal(contact.amountText, '最高 100 万')
		assert.equal(contact.termText, '12-36 期')
		assert.equal(contact.matchRate, 86)
		assert.equal(contact.summary, '优先咨询经营周转贷')
		assert.equal(contact.riskText, '信用分 718')
		assert.deepEqual(contact.matchSuggestions, [{ title: '经营周转贷', desc: '示例银行 · 参考利率 年化 3.2%-4.8% 浮动 · 额度 最高 100 万 · 期限 12-36 期 · 匹配度 86%' }])
		assert.deepEqual(contact.materials.map((item) => [item.name, item.statusText]), [[ '收入流水', '待补充' ], [ '负债明细', '待确认' ], [ '身份证明', '已确认' ]])
	})
	it('normalizes client identity, avatar aliases, and business context without reusing the contact id', () => {
		const contact = normalizeAdvisorContactContext({
			contactId: 'contact-business-1',
			userId: 'user-priority-1',
			uid: 'uid-secondary-1',
			clientUid: 'client-uid-secondary-1',
			customerUid: 'customer-uid-secondary-1',
			clientId: 'legacy-client-1',
			clientInfo: {
				uid: 'nested-client-uid',
				avatar_url: 'https://example.test/nested-avatar.png'
			},
			context: {
				source: 'advisor-profile',
				contactIntent: 'debt-optimization',
				serviceType: 'debt-service',
				serviceName: '债务优化服务'
			}
		})
		const nestedIdentity = normalizeAdvisorContactContext({
			contactId: 'contact-business-2',
			clientId: 'legacy-client-2',
			user: { uid: 'nested-user-uid' }
		})
		const contactOnly = normalizeAdvisorContactContext({
			contactId: 'contact-is-not-client-uid'
		})

		assert.equal(contact.clientUid, 'user-priority-1')
		assert.equal(contact.clientId, 'legacy-client-1')
		assert.equal(contact.userId, 'user-priority-1')
		assert.equal(contact.avatar, 'https://example.test/nested-avatar.png')
		assert.equal(contact.source, 'advisor-profile')
		assert.equal(contact.contactIntent, 'debt-optimization')
		assert.equal(contact.businessType, 'debt-service')
		assert.equal(contact.serviceType, 'debt-service')
		assert.equal(contact.businessName, '债务优化服务')
		assert.equal(nestedIdentity.clientUid, 'nested-user-uid')
		assert.equal(contactOnly.clientUid, '')
		assert.equal(contactOnly.clientId, '')
		assert.notEqual(contactOnly.clientUid, contactOnly.contactId)
	})
	it('maps debt proof execution records into review materials', () => {
		const contact = normalizeAdvisorContactContext({
			id: 'contact-debt',
			context: {
				source: 'debt-manage',
				reportId: 'REPORT_2',
				productName: '债务优化方案',
				executionRecords: [{
					id: 'proof-a',
					type: 'proof',
					debtId: 'card-a',
					title: '工商银行 · 信用卡',
					status: 'reviewing',
					url: 'https://example.test/proof.png',
					fileName: 'proof.png',
					uploadedAt: '2026-07-02T10:00:00.000Z',
					reviewAckStage: 'review_acknowledged',
					reviewAcknowledgedAt: '2026-07-02T10:06:00.000Z'
				}]
			}
		})

		assert.equal(contact.materials.length, 1)
		assert.equal(contact.materials[0].source, 'debt-proof')
		assert.equal(contact.materials[0].statusText, '待确认')
		assert.equal(contact.materials[0].fileName, 'proof.png')
		assert.equal(contact.materials[0].executionRecordId, 'proof-a')
		assert.equal(contact.materials[0].reviewAckStage, 'review_acknowledged')
		assert.equal(contact.materials[0].reviewAcknowledgedAt, '2026-07-02T10:06:00.000Z')
	})
	it('shows case supplement materials and lets the reviewed state replace a stale checklist item', () => {
		const contact = normalizeAdvisorContactContext({
			id: 'contact-supplement',
			caseId: 'case-a',
			materialChecklist: [{
				id: 'income',
				materialType: 'income',
				name: '收入证明',
				status: 'pending'
			}],
			supplementMaterials: [{
				id: 'income',
				materialType: 'income',
				name: '收入证明（客户上传）',
				status: 'confirmed',
				statusText: '已确认',
				attachments: [{ fileName: 'income.pdf', uploadUrl: 'https://files.invalid/income.pdf' }],
				attachmentCount: 1,
				reviewNote: '清晰完整'
			}]
		})

		assert.equal(contact.materials.length, 1)
		assert.equal(contact.materials[0].name, '收入证明（客户上传）')
		assert.equal(contact.materials[0].statusText, '已确认')
		assert.equal(contact.materials[0].reviewNote, '清晰完整')
		assert.equal(contact.materials[0].attachments[0].fileName, 'income.pdf')
	})
})
