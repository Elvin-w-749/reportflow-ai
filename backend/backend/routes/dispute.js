'use strict'

/**
 * 异议申诉后端 API（与 services/disputeService.js 的客户端调用一一对应）。
 *
 *   POST   /api/dispute                  创建（草稿）
 *   POST   /api/dispute/list             分页列表
 *   GET    /api/dispute/:id              详情
 *   GET    /api/dispute/:id/progress     进度
 *   POST   /api/dispute/:id/submit       草稿 → 已提交 → 自动进入审核中
 *   POST   /api/dispute/:id/supplement   补充材料 → 审核中
 *   DELETE /api/dispute/:id              删除（草稿/已驳回可删；进行中需要先撤销，暂以 403 阻拦）
 *
 * 状态机严格匹配前端常量 DisputeStatus / StateTransitions。
 * 真实的银行 / 央行回执需要异步流转，这里先用纯客户端触发的状态机
 * 留出 progress 时间线供 UI 展示，后续接入真实通道时只需在内部触发 transition。
 */

const express = require('express')
const { ok, fail } = require('../utils/response')
const { authRequired } = require('../middlewares/auth')
const store = require('../db/store')

const router = express.Router()

const STATES = {
	DRAFT: 'draft',
	SUBMITTED: 'submitted',
	REVIEWING: 'reviewing',
	PENDING_SUPPLEMENT: 'pending_supplement',
	ACCEPTED: 'accepted',
	COMPLETED: 'completed',
	REJECTED: 'rejected'
}

const ALLOWED_TRANSITIONS = {
	[STATES.DRAFT]: [STATES.SUBMITTED],
	[STATES.SUBMITTED]: [STATES.REVIEWING],
	[STATES.REVIEWING]: [STATES.PENDING_SUPPLEMENT, STATES.ACCEPTED, STATES.REJECTED],
	[STATES.PENDING_SUPPLEMENT]: [STATES.REVIEWING],
	[STATES.ACCEPTED]: [STATES.COMPLETED],
	[STATES.COMPLETED]: [],
	[STATES.REJECTED]: []
}

const DELETABLE_STATES = new Set([STATES.DRAFT, STATES.REJECTED, STATES.COMPLETED])

function genId() {
	return `d_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function findById(uid, id) {
	return store.state().disputes.find((d) => d.userId === uid && d.id === id)
}

function pushProgress(item, status, note) {
	item.status = status
	item.updatedAt = new Date().toISOString()
	item.progress = item.progress || []
	item.progress.push({ at: item.updatedAt, status, note: note || '' })
}

function transition(item, next, note) {
	const allowed = ALLOWED_TRANSITIONS[item.status] || []
	if (!allowed.includes(next)) {
		const err = new Error(`非法状态流转：${item.status} → ${next}`)
		err.code = 1001
		throw err
	}
	pushProgress(item, next, note)
}

router.post('/api/dispute', authRequired, (req, res) => {
	const body = req.body || {}
	if (!body.type) return fail(res, 1001, '缺少异议类型 type')
	if (String(body.description || '').trim().length < 5) {
		return fail(res, 1001, '请输入更详细的异议描述（至少 5 个字）')
	}
	// 注意：服务端独占字段（id/userId/status/progress）必须在 ...body 之后赋值，
	// 否则客户端可在 body 中传入这些字段覆盖归属或伪造进度，向他人账户注入异议。
	const now = new Date().toISOString()
	const item = {
		...body,
		id: genId(),
		userId: req.user.uid,
		status: STATES.DRAFT,
		progress: [
			{ at: now, status: STATES.DRAFT, note: '已创建草稿' }
		],
		createdAt: now,
		updatedAt: now
	}
	store.state().disputes.unshift(item)
	store.persist()
	return ok(res, { dispute: item })
})

router.post('/api/dispute/list', authRequired, (req, res) => {
	const { page = 1, pageSize = 50, status = 'all' } = req.body || {}
	const safePage = Math.max(1, Math.floor(Number(page)) || 1)
	// 封顶 50：避免超大 pageSize 一次性切出全部异议
	const safePageSize = Math.min(50, Math.max(1, Math.floor(Number(pageSize)) || 50))
	const all = store.state().disputes.filter(
		(d) => d.userId === req.user.uid && (status === 'all' || d.status === status)
	)
	const start = (safePage - 1) * safePageSize
	const list = all.slice(start, start + safePageSize)
	return ok(res, { list, total: all.length, page: safePage, pageSize: safePageSize })
})

router.get('/api/dispute/:id', authRequired, (req, res) => {
	const item = findById(req.user.uid, req.params.id)
	if (!item) return fail(res, 2001, 'dispute not found')
	return ok(res, item)
})

router.get('/api/dispute/:id/progress', authRequired, (req, res) => {
	const item = findById(req.user.uid, req.params.id)
	if (!item) return fail(res, 2001, 'dispute not found')
	return ok(res, { status: item.status, progress: item.progress || [] })
})

router.post('/api/dispute/:id/submit', authRequired, (req, res) => {
	const item = findById(req.user.uid, req.params.id)
	if (!item) return fail(res, 2001, 'dispute not found')
	try {
		transition(item, STATES.SUBMITTED, '用户提交申请')
		transition(item, STATES.REVIEWING, '系统受理，进入审核')
		store.persist()
		return ok(res, item)
	} catch (e) {
		return fail(res, e.code || 5000, e.message || '提交失败')
	}
})

router.post('/api/dispute/:id/supplement', authRequired, (req, res) => {
	const item = findById(req.user.uid, req.params.id)
	if (!item) return fail(res, 2001, 'dispute not found')
	const newEvidence = (req.body && req.body.newEvidence) || []
	if (!Array.isArray(newEvidence) || newEvidence.length === 0) {
		return fail(res, 1001, '请提供至少 1 项补充材料')
	}
	item.evidence = [...(item.evidence || []), ...newEvidence]
	try {
		if (item.status === STATES.PENDING_SUPPLEMENT) {
			transition(item, STATES.REVIEWING, '已补充材料，重新进入审核')
		} else {
			pushProgress(item, item.status, `补充了 ${newEvidence.length} 项材料`)
		}
		store.persist()
		return ok(res, item)
	} catch (e) {
		return fail(res, e.code || 5000, e.message || '补充失败')
	}
})

router.delete('/api/dispute/:id', authRequired, (req, res) => {
	const list = store.state().disputes
	const idx = list.findIndex((d) => d.userId === req.user.uid && d.id === req.params.id)
	if (idx < 0) return fail(res, 2001, 'dispute not found')
	if (!DELETABLE_STATES.has(list[idx].status)) {
		return fail(res, 1003, '该状态下不允许删除，请先撤销或等待审核结束')
	}
	list.splice(idx, 1)
	store.persist()
	return ok(res, { ok: true })
})

module.exports = router
