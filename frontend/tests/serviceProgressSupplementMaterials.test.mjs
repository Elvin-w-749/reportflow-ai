import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildServiceProgress,
  materialStatusText
} from '../src/services/serviceProgress.js'

describe('service progress supplement material states', () => {
  it('reads supplementMaterials instead of leaving the material stage gray', () => {
    const progress = buildServiceProgress({
      status: 'processing',
      serviceAssigneeId: 'service-1',
      supplementMaterials: [
        { id: 'income', name: '工资流水', status: 'uploaded' },
        { id: 'tax', name: '个税记录', status: 'confirmed' }
      ]
    })

    assert.equal(progress.materialStats.total, 2)
    assert.equal(progress.materialStats.reviewing, 1)
    assert.equal(progress.materialStats.done, 1)
    assert.equal(progress.stages.find((stage) => stage.key === 'materials').state, 'current')
  })

  it('maps uploaded, reviewing, confirmed, reupload and unavailable states', () => {
    assert.equal(materialStatusText({ status: 'uploaded' }), '待确认')
    assert.equal(materialStatusText({ status: 'reviewing' }), '待确认')
    assert.equal(materialStatusText({ status: 'confirmed' }), '已确认')
    assert.equal(materialStatusText({ status: 'reupload' }), '需重传')
    assert.equal(materialStatusText({ status: 'unavailable' }), '无需')
    assert.equal(materialStatusText({ status: 'draft', statusText: '待上传' }), '待补充')
    assert.equal(materialStatusText({ status: 'uploaded', statusText: '已确认' }), '已确认')
    assert.equal(materialStatusText({ status: 'provided', statusText: '本科' }), '待确认')
  })

  it('lets a supplement record override a stale checklist state of the same material', () => {
    const progress = buildServiceProgress({
      materialChecklist: [{ name: '工资流水', status: 'pending' }],
      supplementMaterials: [{ name: '工资流水', type: 'payroll', status: 'uploaded' }]
    })

    assert.equal(progress.materialStats.total, 1)
    assert.equal(progress.materialStats.pending, 0)
    assert.equal(progress.materialStats.reviewing, 1)
  })

  it('merges the same typed material even when checklist and upload names differ', () => {
    const progress = buildServiceProgress({
      materialChecklist: [{ id: 'material-0', type: 'payroll', name: '近六个月工资流水', status: 'pending' }],
      supplementMaterials: [{ id: 'payroll-upload', materialType: 'payroll', name: '工资卡明细.pdf', status: 'confirmed' }]
    })

    assert.equal(progress.materialStats.total, 1)
    assert.equal(progress.materialStats.done, 1)
    assert.equal(progress.materials[0].name, '工资卡明细.pdf')
  })

  it('uses redacted server progress summary before the service agent claims the ticket', () => {
    const progress = buildServiceProgress({
      status: 'pending',
      materialCount: 3,
      materialsRedacted: true,
      materials: [],
      supplementMaterials: [],
      materialProgressSummary: {
        total: 3,
        uploaded: 3,
        pendingReview: 3,
        confirmed: 0,
        rejected: 0,
        unavailable: 0,
        draft: 0,
        completionState: 'pending-review'
      }
    })

    assert.deepEqual(progress.materialStats, {
      total: 3,
      pending: 0,
      reviewing: 3,
      done: 0,
      reupload: 0
    })
    assert.equal(progress.stages.find((stage) => stage.key === 'materials').state, 'current')
  })

  it('treats provided summary records as awaiting confirmation, not completed', () => {
    const progress = buildServiceProgress({
      materialCount: 2,
      materialProgressSummary: { total: 2, providedCount: 2 }
    })

    assert.equal(progress.materialStats.reviewing, 2)
    assert.equal(progress.materialStats.done, 0)
    assert.equal(progress.materialSummary, '0/2 已确认')
  })

  it('maps the backend pendingSupplement aggregate to materials still required', () => {
    const progress = buildServiceProgress({
      materialCount: 2,
      materialProgressSummary: {
        total: 2,
        pendingSupplement: 1,
        pendingReview: 1
      }
    })

    assert.equal(progress.materialStats.pending, 1)
    assert.equal(progress.materialStats.reviewing, 1)
    assert.equal(progress.stages.find((stage) => stage.key === 'materials').state, 'action')
  })

  it('does not let the server uploaded evidence count override a completed summary', () => {
    const progress = buildServiceProgress({
      materialCount: 2,
      materialProgressSummary: {
        total: 2,
        uploaded: 2,
        pendingReview: 0,
        confirmed: 1,
        unavailable: 1,
        rejected: 0,
        draft: 0,
        completionState: 'completed'
      }
    })

    assert.equal(progress.materialStats.reviewing, 0)
    assert.equal(progress.materialStats.done, 2)
    assert.equal(progress.stages.find((stage) => stage.key === 'materials').state, 'done')
  })
})
