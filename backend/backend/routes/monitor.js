'use strict'

/**
 * 监控数据路由
 *
 * 接收 dev-terminal 推送的监控快照，提供查询接口。
 *
 * POST   /api/monitor/sync              — 接收监控快照（含完整报告详情）
 * GET    /api/monitor/latest            — 获取最新快照
 * GET    /api/monitor/history           — 获取历史快照
 * GET    /api/monitor/reports           — 获取最新报告详情列表
 * GET    /api/monitor/reports/stats     — 报告统计摘要
 * GET    /api/monitor/reports/:id       — 获取指定报告详情
 * GET    /api/monitor/reports/user/:uid — 获取指定用户的报告详情列表
 */

const express = require('express')
const { ok, fail } = require('../utils/response')
const { authRequired } = require('../middlewares/auth')
const { requireRoles } = require('../middlewares/roles')
const store = require('../db/store')
const logger = require('../utils/logger')

const router = express.Router()

router.use('/api/monitor', authRequired, requireRoles(['monitor', 'admin'], '仅监控端可访问此功能'))

/**
 * POST /api/monitor/sync
 * 接收 dev-terminal 推送的监控快照。
 * 鉴权：JWT + monitor/admin 角色。
 */
router.post('/api/monitor/sync', (req, res) => {
	try {
		const payload = req.body
		if (!payload || !payload.snapshotTime) {
			return fail(res, 1001, 'snapshotTime required')
		}

		// 基础校验：关键字段存在
		if (!payload.users || typeof payload.users.total !== 'number') {
			return fail(res, 1001, 'invalid payload: users.total missing')
		}

		const result = store.insertMonitorSnapshot(payload)

		// 异步清理旧快照（不阻塞响应）
		setImmediate(() => {
			try { store.cleanupMonitorSnapshots() } catch (e) {
				logger.warn({ err: e }, 'monitor cleanup failed')
			}
		})

		return ok(res, { id: result.id, timestamp: result.timestamp }, 'synced')
	} catch (e) {
		logger.error({ err: e }, 'monitor/sync failed')
		return fail(res, 5000, 'internal error')
	}
})

/**
 * GET /api/monitor/latest
 * 获取最新一条监控快照（含完整 data）。
 */
router.get('/api/monitor/latest', (req, res) => {
	try {
		const snapshot = store.getLatestMonitorSnapshot()
		if (!snapshot) {
			return fail(res, 4004, 'no snapshots available', null, 404)
		}
		return ok(res, snapshot)
	} catch (e) {
		logger.error({ err: e }, 'monitor/latest failed')
		return fail(res, 5000, 'internal error')
	}
})

/**
 * GET /api/monitor/history?hours=24&limit=500
 * 获取历史快照列表（不含 data 字段，仅元信息）。
 */
router.get('/api/monitor/history', (req, res) => {
	try {
		const hours = Math.min(720, Math.max(1, parseInt(req.query.hours, 10) || 24))
		const limit = Math.min(1000, Math.max(10, parseInt(req.query.limit, 10) || 500))
		const rows = store.getMonitorSnapshotHistory(hours, limit)
		return ok(res, rows)
	} catch (e) {
		logger.error({ err: e }, 'monitor/history failed')
		return fail(res, 5000, 'internal error')
	}
})

/**
 * GET /api/monitor/reports
 * 获取最新一批报告详情列表。支持过滤参数。
 * ?limit=50&minScore=60&riskLevel=high
 */
router.get('/api/monitor/reports', (req, res) => {
	try {
		const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50))
		const minScore = req.query.minScore ? parseFloat(req.query.minScore) : undefined
		const riskLevel = req.query.riskLevel || undefined
		const rows = store.getLatestMonitorReportDetails(limit, minScore, riskLevel)
		return ok(res, rows)
	} catch (e) {
		logger.error({ err: e }, 'monitor/reports failed')
		return fail(res, 5000, 'internal error')
	}
})

/**
 * GET /api/monitor/reports/stats
 * 获取监控报告统计摘要。
 * ?hours=24
 */
router.get('/api/monitor/reports/stats', (req, res) => {
	try {
		const hours = Math.min(720, Math.max(1, parseInt(req.query.hours, 10) || 24))
		const stats = store.getMonitorReportStats(hours)
		return ok(res, stats)
	} catch (e) {
		logger.error({ err: e }, 'monitor/reports/stats failed')
		return fail(res, 5000, 'internal error')
	}
})

/**
 * GET /api/monitor/reports/:reportId
 * 获取指定报告的最新详情。
 */
router.get('/api/monitor/reports/:reportId', (req, res) => {
	try {
		const detail = store.getMonitorReportDetail(req.params.reportId)
		if (!detail) {
			return fail(res, 4004, 'report not found in monitor data', null, 404)
		}
		return ok(res, detail)
	} catch (e) {
		logger.error({ err: e }, 'monitor/reports/:id failed')
		return fail(res, 5000, 'internal error')
	}
})

/**
 * GET /api/monitor/reports/user/:userId
 * 获取指定用户的所有监控报告详情。
 */
router.get('/api/monitor/reports/user/:userId', (req, res) => {
	try {
		const rows = store.getMonitorReportsByUser(req.params.userId)
		return ok(res, rows)
	} catch (e) {
		logger.error({ err: e }, 'monitor/reports/user/:uid failed')
		return fail(res, 5000, 'internal error')
	}
})

module.exports = router
