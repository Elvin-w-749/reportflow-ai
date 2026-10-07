import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

const originalUni = globalThis.uni
const storage = new Map()
const removedKeys = []
globalThis.uni = {
  getStorageSync: (key) => storage.get(key) ?? '',
  setStorageSync: (key, value) => storage.set(key, value),
  removeStorageSync: (key) => {
    removedKeys.push(key)
    storage.delete(key)
  },
  getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
  $emit: () => {}
}

const server = await createServer({
  mode: 'production',
  define: { __RPT_PROD__: 'true' },
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent'
})
const {
  cleanInvalidReports,
	compactAnalysisForCloudUpload,
	deleteReport,
	getCloudReportList,
	getReport,
	getReportAsync,
	getReportList,
  getLatestReport,
	 hasMeaningfulAnalysisData,
	 isValidReport,
	 migrateLegacyReportBodiesToCloud,
	 normalizeReportData,
	 restoreCloudReportToLocal,
	 retryReportCloudSync,
	 saveReport,
	 saveReportDurable,
	 unlinkCloudReportFromLocal
} = await server.ssrLoadModule('/src/services/reportStorage.js')
const { resolveV6ScoreDetails, resolveV6TotalFromAnalysis } = await server.ssrLoadModule('/src/services/scoreV6.js')
const { createOwnerApiDecisionTrust } = await server.ssrLoadModule('/src/services/decisionTrust.js')
const { clearSensitiveBusinessState } = await server.ssrLoadModule('/src/services/sensitiveLocalState.js')
const {
	AUTHORITATIVE_EVIDENCE_PATHS,
	isAuthoritativeServerAnalysis
} = await server.ssrLoadModule('/src/services/authoritativeAnalysis.js')

const canonicalEnvelope = (score = 99) => ({
	derivation_meta: {
		mode: 'deterministic-v1',
		evidence_mode: 'evidence-v2',
		evidence_hash: `eg_v2_${'2'.repeat(64)}`,
		fact_hash: `fl_v2_${'3'.repeat(64)}`,
		metric_hash: `da_v2_${'4'.repeat(64)}`
	},
	analysis_meta: {
		analysisKey: `ak_v3_${'a'.repeat(64)}`,
		resultHash: `rh_v1_${'b'.repeat(64)}`,
		authoritative: true,
		authority: 'server-deterministic',
		authoritativeScope: [...AUTHORITATIVE_EVIDENCE_PATHS],
		cachePolicy: { persistent: true, stableAcrossRestart: true }
	},
	evidence_meta: {
		version: 'evidence-v2',
		status: 'publishable',
		publication_gate: 'passed',
		manifest_hash: `mh_v2_${'1'.repeat(64)}`,
		evidence_hash: `eg_v2_${'2'.repeat(64)}`,
		fact_hash: `fl_v2_${'3'.repeat(64)}`,
		metric_hash: `da_v2_${'4'.repeat(64)}`,
		fact_count: 1,
		supported_fact_count: 1,
		authoritative_scope: [...AUTHORITATIVE_EVIDENCE_PATHS]
	},
	credit_debt: {
		total_debt: 0,
		credit_loans: { total_balance: 0 },
		credit_cards: {
			total_limit: 0,
			total_used: 0,
			utilization_used: 0,
			usage_rate: 0,
			shared_group_count: 0
		}
	},
	query_analysis: {
		summary: {
			last_1m: { total: 0 },
			last_3m: { total: 0 },
			last_6m: { total: 0 },
			last_12m: { total: 0 }
		}
	},
	primary_rule_score: { score }
})

after(async () => {
  await server.close()
  if (originalUni === undefined) delete globalThis.uni
  else globalThis.uni = originalUni
})

describe('report asset validity is independent from score availability', () => {
  it('preserves a file-backed report whose analysis has no trusted score', () => {
    const report = {
      id: 'no-score-report',
      fileName: '待重新分析.pdf',
      createdAt: '2026-07-28T10:00:00.000Z',
      analysisResult: { dimensions: {}, report: { creditAccounts: [] } }
    }
    const anchoredReport = {
      id: 'anchored-overdue-report',
      fileName: '历史逾期.pdf',
      createdAt: '2025-01-01T00:00:00.000Z',
      analysisData: {
        overdueRecords: [{ date: '2024-12-20', level: 'M1' }],
        report: { creditAccounts: [] }
      }
    }
    storage.clear()
    removedKeys.length = 0
    storage.set('report_list', JSON.stringify([report, anchoredReport]))

    assert.equal(isValidReport(report), true)
    assert.equal(normalizeReportData(report.analysisResult).totalScore, null)
    assert.equal(cleanInvalidReports(), 0)
    assert.deepEqual(removedKeys, [])
		// 兼容旧胖列表：在云端未核验前不删除其唯一正文，也不再复制一份到新 key。
		assert.equal(storage.has('report_no-score-report'), false)

		const legacyRows = JSON.parse(storage.get('report_list'))
		assert.equal(legacyRows.length, 2)
		assert.ok(legacyRows[0].analysisResult)
		const summaries = getReportList()
		assert.equal(summaries[0]._summary, true)
		assert.equal(summaries[0].analysisResult, undefined)
		assert.equal(summaries[0]._score, null)
		assert.equal(summaries.find((item) => item.id === anchoredReport.id)._score, null)
    const latest = getLatestReport()
    assert.deepEqual(
      { ...latest.analysisData, evaluationTime: undefined },
      { ...report.analysisResult, evaluationTime: undefined }
    )
    assert.equal(latest.analysisData.evaluationTime, report.createdAt)
  })

	it('persists only verified summaries while retaining full detail in the current session', () => {
		storage.clear()
		const reportId = saveReport({
			id: 'summary-only-report',
			fileName: 'long-report.pdf',
			reportType: '人行信用报告',
			analysisData: {
				basicInfo: { name: '测试用户', reportDate: '2026-08-04' },
				report: { totalScore: 72, creditAccounts: [{ id: 'card-1' }] },
				dimensions: { totalAccountCount: 1 }
			}
		}, { skipCloudSync: true })

		assert.equal(reportId, 'summary-only-report')
		const persistedDetail = JSON.parse(storage.get('report_summary-only-report'))
		const persistedList = JSON.parse(storage.get('report_list'))
		assert.equal(persistedDetail._summary, true)
		assert.equal(persistedDetail.analysisData, undefined)
		assert.equal(persistedList[0]._summary, true)
		assert.equal(persistedList[0].analysisData, undefined)
		assert.equal(getReport(reportId).analysisData.report.totalScore, 72)
	})

	it('rejects malformed local report ids before any storage write and normalizes valid scalars', () => {
		const analysisData = { report: { creditAccounts: [] }, dimensions: {} }
		const invalidInputs = [
			{ id: [] },
			{ id: {} },
			{ id: true },
			{ id: false },
			{ id: 0 },
			{ id: Number.NaN },
			{ id: Number.POSITIVE_INFINITY },
			{ id: Number.NEGATIVE_INFINITY },
			{ id: 'valid-id', clientReportId: [] },
			{ id: 'valid-id', clientReportId: true },
			{ id: 'valid-id', clientReportId: 0 },
			{ id: 'valid-id', localReportId: {} },
			{ id: 'valid-id', clientReportId: 'other-id' },
			{ id: 'valid-id', clientReportId: 'valid-id', localReportId: 'other-id' },
			{ id: 'valid-id', cloudReportId: [] },
			{ id: 'valid-id', cloudReportId: 'cloud-a', serverReportId: 'cloud-b' },
			{ id: 'valid-id', syncMeta: { cloudReportId: {} } }
		]
		for (const input of invalidInputs) {
			storage.clear()
			assert.throws(
				() => saveReport({ ...input, analysisData }, { skipCloudSync: true }),
				(error) => error?.code === 'REPORT_ID_INVALID' && error?.reportIdentityFailure === true,
				JSON.stringify(input)
			)
			assert.deepEqual([...storage.keys()], [], JSON.stringify(input))
			assert.equal(getReport('valid-id'), null, JSON.stringify(input))
		}

		for (const absentId of [{}, { id: undefined }, { id: null }, { id: '' }, { id: '   ' }]) {
			storage.clear()
			const generated = saveReport({ ...absentId, analysisData }, { skipCloudSync: true })
			assert.match(generated, /^REPORT_/)
			assert.equal(getReport(generated).id, generated)
			assert.equal(getReport(generated).clientReportId, generated)
		}

		storage.clear()
		assert.equal(saveReport({ id: 27, analysisData }, { skipCloudSync: true }), '27')
		assert.equal(getReport('27').id, '27')
		assert.equal(getReport('27').clientReportId, '27')

		storage.clear()
		assert.equal(saveReport({
			id: 'stable-local-id',
			clientReportId: 'stable-local-id',
			localReportId: 'stable-local-id',
			analysisData
		}, { skipCloudSync: true }), 'stable-local-id')
		assert.equal(getReport('stable-local-id').clientReportId, 'stable-local-id')

		storage.clear()
		const blankAlias = saveReport({
			id: 'blank-alias-id', clientReportId: '  ', localReportId: '', analysisData
		}, { skipCloudSync: true })
		assert.equal(blankAlias, 'blank-alias-id')
		assert.equal(getReport(blankAlias).clientReportId, 'blank-alias-id')

		storage.clear()
		storage.set('report_list', JSON.stringify([
			{ id: ['dirty-id'], _summary: true, createdAt: '2026-08-17T00:00:00Z' },
			{ id: 'dirty-cloud-id', cloudReportId: [], analysisData, createdAt: '2026-08-17T00:00:00Z' },
			{ id: 'readable-id', clientReportId: 'readable-id', _summary: true, createdAt: '2026-08-16T00:00:00Z' }
		]))
		assert.deepEqual(getReportList().map((item) => item.id), ['readable-id'])
		assert.equal(getReport('dirty-cloud-id'), null)
	})

	it('binds stored bodies and cache entries to the exact requested local report id', async () => {
		const analysisData = {
			evaluationTime: '2026-08-17',
			report: { creditAccounts: [] },
			dimensions: {}
		}
		const tampered = [
			['stored-array-id', { id: ['stored-array-id'] }],
			['stored-object-id', { id: {} }],
			['stored-zero-id', { id: 0 }],
			['stored-other-id', { id: 'another-local-id' }],
			['stored-client-conflict', { id: 'stored-client-conflict', clientReportId: 'another-local-id' }],
			['stored-local-invalid', { id: 'stored-local-invalid', localReportId: [] }],
			['stored-cloud-invalid', { id: 'stored-cloud-invalid', cloudReportId: [] }],
			['stored-cloud-conflict', { id: 'stored-cloud-conflict', cloudReportId: 'cloud-a', serverReportId: 'cloud-b' }],
			['stored-sync-invalid', { id: 'stored-sync-invalid', syncMeta: { cloudReportId: {} } }]
		]
		for (const [requestedId, body] of tampered) {
			storage.clear()
			storage.set(`report_${requestedId}`, JSON.stringify({ ...body, fileName: 'tampered.pdf', analysisData }))
			assert.equal(getReport(requestedId), null, requestedId)
			assert.equal(await getReportAsync(requestedId), null, requestedId)
		}

		storage.clear()
		storage.set('report_valid-dual-id', JSON.stringify({
			id: 'valid-dual-id',
			clientReportId: 'valid-dual-id',
			cloudReportId: 'canonical-cloud-id',
			serverReportId: 'canonical-cloud-id',
			syncMeta: { status: 'synced', cloudReportId: 'canonical-cloud-id' },
			fileName: 'valid.pdf',
			analysisData
		}))
		const dual = getReport('valid-dual-id')
		assert.equal(dual.id, 'valid-dual-id')
		assert.equal(dual.cloudReportId, 'canonical-cloud-id')

		storage.clear()
		storage.set('report_cache-bound-id', JSON.stringify({
			id: 'cache-bound-id', fileName: 'cache.pdf', analysisData
		}))
		assert.equal(getReport('cache-bound-id').id, 'cache-bound-id')
		const cached = getReport('cache-bound-id')
		cached.id = 'tampered-cache-id'
		assert.equal(getReport('cache-bound-id').id, 'cache-bound-id')
		const cachedAgain = getReport('cache-bound-id')
		cachedAgain.cloudReportId = []
		assert.equal(getReport('cache-bound-id').id, 'cache-bound-id')

		storage.clear()
		saveReport({ id: 'list-cache-bound-id', fileName: 'list-cache.pdf', analysisData }, { skipCloudSync: true })
		const cachedList = getReportList()
		cachedList[0].id = ['list-cache-bound-id']
		assert.equal(getReportList()[0].id, 'list-cache-bound-id')
		const latestCached = getLatestReport()
		latestCached.id = { invalid: true }
		assert.equal(getLatestReport().id, 'list-cache-bound-id')
		const latestCachedAgain = getLatestReport()
		latestCachedAgain.cloudReportId = []
		assert.equal(getLatestReport().id, 'list-cache-bound-id')

		storage.clear()
		saveReport({ id: 'delete-safe-id', fileName: 'delete.pdf', analysisData }, { skipCloudSync: true })
		const storedBefore = storage.get('report_delete-safe-id')
		const listBefore = storage.get('report_list')
		for (const invalidId of [['delete-safe-id'], {}, 0, true]) {
			assert.equal(deleteReport(invalidId), false)
			assert.equal(unlinkCloudReportFromLocal(invalidId), false)
			assert.equal(await retryReportCloudSync(invalidId), false)
			assert.equal(storage.get('report_delete-safe-id'), storedBefore)
			assert.equal(storage.get('report_list'), listBefore)
			assert.equal(getReport('delete-safe-id').id, 'delete-safe-id')
		}
		assert.equal(isValidReport({ id: ['delete-safe-id'], fileName: 'invalid.pdf' }), false)
		assert.equal(deleteReport('delete-safe-id'), true)
		assert.equal(storage.has('report_delete-safe-id'), false)
	})

	it('keeps only the compact projection when linking a report to the private evidence ledger', () => {
		const compact = compactAnalysisForCloudUpload({
			report: { totalScore: 72 },
			evidence_meta: { version: 'evidence-v2' },
			evidence_v2: { factLedger: { facts: [{ value: 'private' }] } },
			creditReportV2: {
				basic_info: { report_date: '2026-08-04' },
				factLedger: { facts: [{ value: 'private-nested' }] }
			}
		})

		assert.deepEqual(compact.report, { totalScore: 72 })
		assert.deepEqual(compact.evidence_meta, { version: 'evidence-v2' })
		assert.equal(compact.evidence_v2, undefined)
		assert.equal(compact.creditReportV2.factLedger, undefined)
	})

	it('throws a stable error when quota prevents the verified local summary write', () => {
		storage.clear()
		const originalSet = globalThis.uni.setStorageSync
		globalThis.uni.setStorageSync = () => {
			const error = new Error('quota exceeded')
			error.name = 'QuotaExceededError'
			throw error
		}
		try {
			assert.throws(
				() => saveReport({ id: 'quota-report', fileName: 'report.pdf', analysisData: { basicInfo: { name: '测试' } } }, { skipCloudSync: true }),
				(error) => error && error.code === 'REPORT_LOCAL_PERSIST_FAILED' && error.storageErrorName === 'QuotaExceededError'
			)
			assert.equal(storage.has('report_quota-report'), false)
		} finally {
			globalThis.uni.setStorageSync = originalSet
		}
	})

	it('rolls back the detail summary when the list write cannot be read back', () => {
		storage.clear()
		const originalSet = globalThis.uni.setStorageSync
		globalThis.uni.setStorageSync = (key, value) => {
			if (key !== 'report_list') storage.set(key, value)
		}
		try {
			assert.throws(
				() => saveReport({ id: 'list-readback-fail', fileName: 'report.pdf', analysisData: { basicInfo: { name: '测试' } } }, { skipCloudSync: true }),
				(error) => error && error.code === 'REPORT_LOCAL_PERSIST_FAILED'
			)
			assert.equal(storage.has('report_list-readback-fail'), false)
		} finally {
			globalThis.uni.setStorageSync = originalSet
		}
	})

	it('durable save confirms cloud persistence before writing the verified local summary', async () => {
		storage.clear()
		storage.set('auth_token', 'test-token')
		const originalRequest = globalThis.uni.request
		globalThis.uni.request = (options) => {
			assert.match(options.url, /api\/report\/upload/)
			assert.equal(options.timeout, 120000)
			assert.equal(options.data.analysisJobId, 'analysis-job-1')
			assert.equal(options.data.clientReportId, 'durable-local-1')
			assert.equal(JSON.stringify(options.data).includes('evidence_v2'), false)
			assert.equal(JSON.stringify(options.data).includes('private-ledger-value'), false)
			options.success({ statusCode: 200, data: { code: 0, data: { reportId: 'cloud-report-1' } } })
		}
		try {
			const reportId = await saveReportDurable({
				id: 'durable-local-1',
				analysisJobId: 'analysis-job-1',
				fileName: 'long-report.pdf',
				reportType: '人行信用报告',
				analysisData: {
					basicInfo: { name: '测试用户', reportDate: '2026-08-04' },
					report: { totalScore: 75, creditAccounts: [] },
					dimensions: { totalAccountCount: 0 },
					evidence_v2: { factLedger: { facts: [{ value: 'private-ledger-value' }] } }
				}
			})
			assert.equal(reportId, 'durable-local-1')
			const summary = JSON.parse(storage.get('report_durable-local-1'))
			assert.equal(summary.analysisJobId, 'analysis-job-1')
			assert.equal(summary.cloudReportId, 'cloud-report-1')
			assert.equal(summary.syncStatus, 'synced')
			assert.equal(summary.analysisData, undefined)
		} finally {
			globalThis.uni.request = originalRequest
			storage.delete('auth_token')
		}
	})

	it('durable save leaves no local asset when cloud persistence fails', async () => {
		storage.clear()
		storage.set('auth_token', 'test-token')
		const originalRequest = globalThis.uni.request
		globalThis.uni.request = (options) => options.fail({ errMsg: 'request:fail network' })
		try {
			await assert.rejects(
				saveReportDurable({ id: 'cloud-fail-local', fileName: 'report.pdf', analysisData: { basicInfo: { name: '测试' } } }),
				(error) => error &&
					error.code === 'REPORT_CLOUD_PERSIST_FAILED' &&
					error.cloudCauseCode === 'REQUEST_NETWORK_ERROR' &&
					error.transportKind === 'network' &&
					error.networkFailure === true
			)
			assert.equal(storage.has('report_cloud-fail-local'), false)
			assert.equal(storage.has('report_list'), false)
		} finally {
			globalThis.uni.request = originalRequest
			storage.delete('auth_token')
		}
	})

	it('preserves timeout metadata while keeping the cloud-save error stable', async () => {
		storage.clear()
		storage.set('auth_token', 'test-token')
		const originalRequest = globalThis.uni.request
		globalThis.uni.request = (options) => options.fail({ errMsg: 'request:fail timeout' })
		try {
			await assert.rejects(
				saveReportDurable({ id: 'cloud-timeout-local', fileName: 'report.pdf', analysisData: { basicInfo: { name: '测试' } } }),
				(error) => error &&
					error.code === 'REPORT_CLOUD_PERSIST_FAILED' &&
					error.cloudCauseCode === 'REQUEST_TIMEOUT' &&
					error.transportKind === 'timeout' &&
					error.timedOut === true
			)
		} finally {
			globalThis.uni.request = originalRequest
			storage.delete('auth_token')
		}
	})

	it('preserves real HTTP 413 and safe HTTP 403 permission details', async () => {
		storage.clear()
		storage.set('auth_token', 'test-token')
		const originalRequest = globalThis.uni.request
		try {
			globalThis.uni.request = (options) => options.success({
				statusCode: 413,
				data: { code: 5000, message: '请求体超过限制' }
			})
			await assert.rejects(
				saveReportDurable({ id: 'cloud-413-local', fileName: 'report.pdf', analysisData: { basicInfo: { name: '测试' } } }),
				(error) => error &&
					error.code === 'REPORT_CLOUD_PERSIST_FAILED' &&
					error.transportKind === 'http' &&
					error.httpStatus === 413 &&
					error.statusCode === 413
			)

			globalThis.uni.request = (options) => options.success({
				statusCode: 403,
				data: { code: 3003, message: '当前角色无权保存该报告' }
			})
			await assert.rejects(
				saveReportDurable({ id: 'cloud-403-local', fileName: 'report.pdf', analysisData: { basicInfo: { name: '测试' } } }),
				(error) => error &&
					error.code === 'REPORT_CLOUD_PERSIST_FAILED' &&
					error.httpStatus === 403 &&
					error.message === '当前角色无权保存该报告'
			)
		} finally {
			globalThis.uni.request = originalRequest
			storage.delete('auth_token')
		}
	})

	it('preserves safe HTTP 409 content conflicts and HTTP-200 business failures', async () => {
		storage.clear()
		storage.set('auth_token', 'test-token')
		const originalRequest = globalThis.uni.request
		try {
			globalThis.uni.request = (options) => options.success({
				statusCode: 409,
				data: { code: 1001, message: 'clientReportId 已绑定到不同报告内容' }
			})
			await assert.rejects(
				saveReportDurable({ id: 'cloud-409-local', fileName: 'report.pdf', analysisData: { basicInfo: { name: '测试' } } }),
				(error) => error &&
					error.code === 'REPORT_CLOUD_PERSIST_FAILED' &&
					error.httpStatus === 409 &&
					error.businessCode === 1001 &&
					error.message === 'clientReportId 已绑定到不同报告内容'
			)

			globalThis.uni.request = (options) => options.success({
				statusCode: 200,
				data: { code: 5000, message: '报告上传失败' }
			})
			await assert.rejects(
				saveReportDurable({ id: 'cloud-5000-local', fileName: 'report.pdf', analysisData: { basicInfo: { name: '测试' } } }),
				(error) => error &&
					error.code === 'REPORT_CLOUD_PERSIST_FAILED' &&
					error.httpStatus === 200 &&
					error.businessCode === 5000
			)
		} finally {
			globalThis.uni.request = originalRequest
			storage.delete('auth_token')
		}
	})

	it('hydrates a summary from cloud detail without writing the full body back to localStorage', async () => {
		storage.clear()
		storage.set('auth_token', 'test-token')
		storage.set('report_cloud-fallback-local', JSON.stringify({
			id: 'cloud-fallback-local',
			clientReportId: 'cloud-fallback-local',
			cloudReportId: 'cloud-detail-2',
			fileName: 'long-report.pdf',
			_summary: true
		}))
		storage.set('report_list', JSON.stringify([{
			id: 'cloud-fallback-local',
			clientReportId: 'cloud-fallback-local',
			cloudReportId: 'cloud-detail-2',
			fileName: 'long-report.pdf',
			_summary: true
		}]))
		const originalRequest = globalThis.uni.request
		globalThis.uni.request = (options) => options.success({
			statusCode: 200,
			data: {
				code: 0,
				data: {
					id: 'cloud-detail-2',
					clientReportId: 'cloud-fallback-local',
					fileName: 'long-report.pdf',
					analysisData: {
						basicInfo: { name: '测试用户', reportDate: '2026-08-04' },
						report: { totalScore: 77, creditAccounts: [] },
						dimensions: { totalAccountCount: 0 }
					}
				}
			}
		})
		try {
			const detail = await getReportAsync('cloud-fallback-local')
			assert.equal(detail.analysisData.report.totalScore, 77)
			const persisted = JSON.parse(storage.get('report_cloud-fallback-local'))
			assert.equal(persisted._summary, true)
			assert.equal(persisted.analysisData, undefined)
		} finally {
			globalThis.uni.request = originalRequest
			storage.delete('auth_token')
		}
	})

	it('adopts a validated client id when a canonical cloud link has no local row', async () => {
		storage.clear()
		storage.set('auth_token', 'test-token')
		const originalRequest = globalThis.uni.request
		const responses = new Map([
			['cloud-direct-id', { id: 'cloud-direct-id', clientReportId: 'local-direct-id' }],
			['local-message-id', { id: 'cloud-message-id', clientReportId: 'local-message-id' }]
		])
		globalThis.uni.request = (options) => {
			if (/\/api\/log\/error/.test(options.url)) {
				options.success({ statusCode: 200, data: { code: 0 } })
				return
			}
			const requested = decodeURIComponent(String(options.url).split('/').pop())
			const identity = responses.get(requested)
			options.success({
				statusCode: 200,
				data: {
					code: 0,
					data: {
						...identity,
						fileName: `${requested}.pdf`,
						analysisResult: { report: { creditAccounts: [] }, dimensions: {} }
					}
				}
			})
		}
		try {
			const direct = await getReportAsync('cloud-direct-id')
			assert.equal(direct.id, 'local-direct-id')
			assert.equal(direct.clientReportId, 'local-direct-id')
			assert.equal(direct.cloudReportId, 'cloud-direct-id')
			assert.equal(storage.has('report_cloud-direct-id'), false)
			assert.equal(JSON.parse(storage.get('report_local-direct-id')).id, 'local-direct-id')

			const message = await getReportAsync('local-message-id')
			assert.equal(message.id, 'local-message-id')
			assert.equal(message.cloudReportId, 'cloud-message-id')
			assert.equal(JSON.parse(storage.get('report_local-message-id')).cloudReportId, 'cloud-message-id')
		} finally {
			globalThis.uni.request = originalRequest
			storage.delete('auth_token')
		}
	})

	it('rejects cloud/client identity mismatches without replacing an existing local row', async () => {
		storage.clear()
		storage.set('auth_token', 'test-token')
		storage.set('report_existing-local-id', JSON.stringify({
			id: 'existing-local-id',
			clientReportId: 'existing-local-id',
			cloudReportId: 'existing-cloud-id',
			syncMeta: { status: 'synced', cloudReportId: 'existing-cloud-id' },
			fileName: 'existing.pdf',
			_summary: true
		}))
		storage.set('report_list', JSON.stringify([JSON.parse(storage.get('report_existing-local-id'))]))
		const originalRequest = globalThis.uni.request
		globalThis.uni.request = (options) => {
			if (/\/api\/log\/error/.test(options.url)) {
				options.success({ statusCode: 200, data: { code: 0 } })
				return
			}
			const requested = decodeURIComponent(String(options.url).split('/').pop())
			const body = requested === 'malformed-client-cloud'
				? { id: 'malformed-client-cloud', clientReportId: [] }
				: requested === 'wrong-cloud-request'
					? { id: 'another-cloud-id', clientReportId: 'another-local-id' }
					: { id: 'existing-cloud-id', clientReportId: 'another-local-id' }
			options.success({
				statusCode: 200,
				data: { code: 0, data: { ...body, fileName: 'wrong.pdf', analysisResult: { report: { creditAccounts: [] } } } }
			})
		}
		try {
			assert.equal(await getReportAsync('wrong-cloud-request'), null)
			assert.equal(await getReportAsync('malformed-client-cloud'), null)
			const existing = await getReportAsync('existing-local-id')
			assert.equal(existing.id, 'existing-local-id')
			assert.equal(existing.analysisData, undefined)
			assert.equal(existing.cloudReportId, 'existing-cloud-id')
			assert.equal(JSON.parse(storage.get('report_existing-local-id')).fileName, 'existing.pdf')
		} finally {
			globalThis.uni.request = originalRequest
			storage.delete('auth_token')
		}
	})

	it('prevents a canonical response from hijacking an existing client alias', async () => {
		const originalRequest = globalThis.uni.request
		const responses = new Map()
		globalThis.uni.request = (options) => {
			if (/\/api\/log\/error/.test(options.url)) {
				options.success({ statusCode: 200, data: { code: 0 } })
				return
			}
			const requested = options.data?.reportId || decodeURIComponent(String(options.url).split('/').pop())
			const identity = responses.get(requested)
			options.success({
				statusCode: 200,
				data: {
					code: 0,
					data: {
						...identity,
						fileName: `${requested}-fresh.pdf`,
						analysisResult: { report: { creditAccounts: [] }, dimensions: {}, refreshedFrom: requested }
					}
				}
			})
		}
		const installExisting = (localId, cloudReportId, extra = {}) => {
			const body = {
				id: localId,
				clientReportId: localId,
				cloudReportId,
				syncMeta: { status: cloudReportId ? 'synced' : 'local', cloudReportId },
				fileName: `${localId}-old.pdf`,
				createdAt: '2026-08-01T00:00:00Z',
				analysisData: { evaluationTime: '2026-08-01', report: { creditAccounts: [] }, old: true },
				...extra
			}
			storage.set(`report_${localId}`, JSON.stringify(body))
			storage.set('report_list', JSON.stringify([body]))
			return body
		}
		try {
			storage.clear()
			storage.set('auth_token', 'test-token')
			responses.set('new-cloud-id', { id: 'new-cloud-id', clientReportId: 'existing-local-id' })
			installExisting('existing-local-id', 'old-cloud-id')
			getReport('existing-local-id')
			const oldBody = storage.get('report_existing-local-id')
			const oldList = storage.get('report_list')
			assert.equal(await getReportAsync('new-cloud-id'), null)
			assert.equal(storage.get('report_existing-local-id'), oldBody)
			assert.equal(storage.get('report_list'), oldList)
			assert.equal(storage.has('report_new-cloud-id'), false)
			assert.equal(getReport('existing-local-id').cloudReportId, 'old-cloud-id')

			storage.clear()
			storage.set('auth_token', 'test-token')
			responses.set('memory-new-cloud', { id: 'memory-new-cloud', clientReportId: 'memory-local-id' })
			saveReport({
				id: 'memory-local-id',
				cloudReportId: 'memory-old-cloud',
				syncMeta: { status: 'synced', cloudReportId: 'memory-old-cloud' },
				fileName: 'memory-old.pdf',
				analysisData: { evaluationTime: '2026-08-01', report: { creditAccounts: [] } }
			}, { skipCloudSync: true })
			getLatestReport()
			storage.delete('report_memory-local-id')
			storage.delete('report_list')
			assert.equal(await getReportAsync('memory-new-cloud'), null)
			assert.equal(storage.has('report_memory-local-id'), false)
			assert.equal(storage.has('report_list'), false)

			storage.clear()
			storage.set('auth_token', 'test-token')
			responses.set('same-cloud-id', { id: 'same-cloud-id', clientReportId: 'same-local-id' })
			installExisting('same-local-id', 'same-cloud-id')
			const same = await getReportAsync('same-cloud-id')
			assert.equal(same.id, 'same-local-id')
			assert.equal(same.cloudReportId, 'same-cloud-id')
			assert.equal(JSON.parse(storage.get('report_same-local-id')).fileName, 'same-cloud-id-fresh.pdf')

			storage.clear()
			storage.set('auth_token', 'test-token')
			responses.set('bind-cloud-id', { id: 'bind-cloud-id', clientReportId: 'legacy-unbound-id' })
			installExisting('legacy-unbound-id', '')
			const bound = await getReportAsync('bind-cloud-id')
			assert.equal(bound.id, 'legacy-unbound-id')
			assert.equal(bound.cloudReportId, 'bind-cloud-id')
			assert.equal(JSON.parse(storage.get('report_legacy-unbound-id')).cloudReportId, 'bind-cloud-id')

			storage.clear()
			storage.set('auth_token', 'test-token')
			responses.set('malformed-binding-cloud', { id: 'malformed-binding-cloud', clientReportId: 'malformed-local-id' })
			const malformed = installExisting('malformed-local-id', 'old-cloud-id', { cloudReportId: [] })
			const malformedBody = storage.get('report_malformed-local-id')
			assert.equal(await getReportAsync('malformed-binding-cloud'), null)
			assert.equal(storage.get('report_malformed-local-id'), malformedBody)
			assert.equal(storage.has('report_malformed-binding-cloud'), false)
			assert.deepEqual(JSON.parse(storage.get('report_malformed-local-id')).cloudReportId, malformed.cloudReportId)

			storage.clear()
			storage.set('auth_token', 'test-token')
			responses.set('repeat-cloud-id', { id: 'repeat-cloud-id', clientReportId: 'repeat-local-id' })
			assert.equal((await getReportAsync('repeat-cloud-id')).id, 'repeat-local-id')
			assert.equal((await getReportAsync('repeat-cloud-id')).id, 'repeat-local-id')
			const repeatedList = JSON.parse(storage.get('report_list'))
			assert.equal(repeatedList.length, 1)
			assert.equal(repeatedList[0].id, 'repeat-local-id')
			assert.equal(repeatedList[0].cloudReportId, 'repeat-cloud-id')
		} finally {
			globalThis.uni.request = originalRequest
			storage.delete('auth_token')
		}
	})

	it('applies the client-alias collision guard to cloud restore and generic save paths', async () => {
		const originalRequest = globalThis.uni.request
		const responses = new Map()
		globalThis.uni.request = (options) => {
			if (/\/api\/log\/error/.test(options.url)) {
				options.success({ statusCode: 200, data: { code: 0 } })
				return
			}
			const requested = options.data?.reportId || decodeURIComponent(String(options.url).split('/').pop())
			const identity = responses.get(requested)
			options.success({
				statusCode: 200,
				data: {
					code: 0,
					data: {
						...identity,
						fileName: `${requested}-restore.pdf`,
						analysisResult: { report: { creditAccounts: [] }, restoredFrom: requested }
					}
				}
			})
		}
		const cloudObject = (cloudId, localId, fileName = `${cloudId}.pdf`) => ({
			id: cloudId,
			clientReportId: localId,
			fileName,
			analysisResult: { report: { creditAccounts: [] }, cloudId }
		})
		const installExisting = (localId, cloudReportId, extra = {}) => {
			const body = {
				id: localId,
				clientReportId: localId,
				cloudReportId,
				syncMeta: { status: cloudReportId ? 'synced' : 'local', cloudReportId },
				fileName: `${localId}-existing.pdf`,
				createdAt: '2026-08-01T00:00:00Z',
				analysisData: { evaluationTime: '2026-08-01', report: { creditAccounts: [] }, existing: true },
				...extra
			}
			storage.set(`report_${localId}`, JSON.stringify(body))
			storage.set('report_list', JSON.stringify([body]))
			return body
		}
		try {
			storage.clear()
			storage.set('auth_token', 'test-token')
			installExisting('restore-other-local', 'restore-old-cloud')
			getReport('restore-other-local')
			const otherBody = storage.get('report_restore-other-local')
			const otherList = storage.get('report_list')
			assert.equal(await restoreCloudReportToLocal(cloudObject('restore-new-cloud', 'restore-other-local')), null)
			assert.equal(storage.get('report_restore-other-local'), otherBody)
			assert.equal(storage.get('report_list'), otherList)
			assert.equal(getReport('restore-other-local').cloudReportId, 'restore-old-cloud')

			storage.clear()
			storage.set('auth_token', 'test-token')
			installExisting('restore-same-local', 'restore-same-cloud')
			assert.equal(await restoreCloudReportToLocal(cloudObject('restore-same-cloud', 'restore-same-local', 'same-fresh.pdf')), 'restore-same-local')
			assert.equal(JSON.parse(storage.get('report_restore-same-local')).fileName, 'same-fresh.pdf')

			storage.clear()
			storage.set('auth_token', 'test-token')
			installExisting('restore-unbound-local', '')
			assert.equal(await restoreCloudReportToLocal(cloudObject('restore-bind-cloud', 'restore-unbound-local')), 'restore-unbound-local')
			assert.equal(JSON.parse(storage.get('report_restore-unbound-local')).cloudReportId, 'restore-bind-cloud')

			storage.clear()
			storage.set('auth_token', 'test-token')
			installExisting('restore-malformed-local', 'old-cloud', { cloudReportId: [] })
			const malformedBody = storage.get('report_restore-malformed-local')
			assert.equal(await restoreCloudReportToLocal(cloudObject('restore-malformed-cloud', 'restore-malformed-local')), null)
			assert.equal(storage.get('report_restore-malformed-local'), malformedBody)

			storage.clear()
			storage.set('auth_token', 'test-token')
			responses.set('restore-id-cloud', { id: 'restore-id-cloud', clientReportId: 'restore-id-local' })
			assert.equal(await restoreCloudReportToLocal('restore-id-cloud'), 'restore-id-local')
			assert.equal(JSON.parse(storage.get('report_restore-id-local')).cloudReportId, 'restore-id-cloud')
			assert.equal(await restoreCloudReportToLocal('restore-id-cloud'), 'restore-id-local')
			assert.equal(JSON.parse(storage.get('report_list')).length, 1)

			storage.clear()
			storage.set('auth_token', 'test-token')
			installExisting('restore-id-collision-local', 'restore-id-old-cloud')
			responses.set('restore-id-new-cloud', { id: 'restore-id-new-cloud', clientReportId: 'restore-id-collision-local' })
			const idCollisionBody = storage.get('report_restore-id-collision-local')
			assert.equal(await restoreCloudReportToLocal('restore-id-new-cloud'), null)
			assert.equal(storage.get('report_restore-id-collision-local'), idCollisionBody)

			storage.clear()
			installExisting('generic-save-local', 'generic-old-cloud')
			const genericBody = storage.get('report_generic-save-local')
			assert.throws(
				() => saveReport({
					id: 'generic-save-local',
					clientReportId: 'generic-save-local',
					cloudReportId: 'generic-new-cloud',
					syncMeta: { status: 'synced', cloudReportId: 'generic-new-cloud' },
					fileName: 'generic-new.pdf',
					analysisData: { report: { creditAccounts: [] } }
				}, { skipCloudSync: true }),
				(error) => error?.code === 'REPORT_ID_INVALID'
			)
			assert.equal(storage.get('report_generic-save-local'), genericBody)
			assert.equal(saveReport({
				id: 'generic-save-local',
				clientReportId: 'generic-save-local',
				fileName: 'generic-update.pdf',
				analysisData: { report: { creditAccounts: [] }, updated: true }
			}, { skipCloudSync: true }), 'generic-save-local')
			assert.equal(JSON.parse(storage.get('report_generic-save-local')).cloudReportId, 'generic-old-cloud')
		} finally {
			globalThis.uni.request = originalRequest
			storage.delete('auth_token')
		}
	})

	it('keeps background queue and retry cloud-link patches behind the shared collision guard', async () => {
		const originalRequest = globalThis.uni.request
		let uploadResponse = null
		globalThis.uni.request = (options) => {
			if (/\/api\/log\/error/.test(options.url)) {
				options.success({ statusCode: 200, data: { code: 0 } })
				return
			}
			assert.match(options.url, /\/api\/report\/upload/)
			options.success({ statusCode: 200, data: { code: 0, data: uploadResponse } })
		}
		const analysisData = { evaluationTime: '2026-08-01', report: { creditAccounts: [] }, dimensions: {} }
		const ownerTrust = (reportId) => createOwnerApiDecisionTrust({
			id: reportId,
			decisionEvidenceLinked: true,
			evidenceVerified: false,
			decisionFlags: {}
		})
		const saveBound = (localId, cloudReportId, options = { skipCloudSync: true }) => saveReport({
			id: localId,
			clientReportId: localId,
			cloudReportId,
			syncMeta: { status: cloudReportId ? 'synced' : 'local', cloudReportId },
			decisionTrust: ownerTrust(cloudReportId || localId),
			fileName: `${localId}.pdf`,
			analysisData
		}, options)
		const waitForQueue = () => new Promise((resolve) => setTimeout(resolve, 30))
		try {
			storage.clear()
			storage.set('auth_token', 'test-token')
			saveBound('queue-other-local', 'queue-old-cloud')
			uploadResponse = { reportId: 'queue-new-cloud', clientReportId: 'queue-other-local' }
			saveBound('queue-other-local', 'queue-old-cloud', {})
			getReportList()
			getLatestReport()
			const queueBody = storage.get('report_queue-other-local')
			const queueList = storage.get('report_list')
			await waitForQueue()
			assert.equal(storage.get('report_queue-other-local'), queueBody)
			assert.equal(storage.get('report_list'), queueList)
			assert.equal(getReport('queue-other-local').cloudReportId, 'queue-old-cloud')
			assert.equal(getReportList()[0].cloudReportId, 'queue-old-cloud')
			assert.equal(getLatestReport().cloudReportId, 'queue-old-cloud')

			storage.clear()
			storage.set('auth_token', 'test-token')
			saveBound('queue-client-mismatch-local', 'queue-client-cloud')
			uploadResponse = { reportId: 'queue-client-cloud', clientReportId: 'another-client-id' }
			saveBound('queue-client-mismatch-local', 'queue-client-cloud', {})
			const clientMismatchBody = storage.get('report_queue-client-mismatch-local')
			const clientMismatchList = storage.get('report_list')
			await waitForQueue()
			assert.equal(storage.get('report_queue-client-mismatch-local'), clientMismatchBody)
			assert.equal(storage.get('report_list'), clientMismatchList)

			storage.clear()
			storage.set('auth_token', 'test-token')
			saveBound('queue-same-local', 'queue-same-cloud')
			uploadResponse = { reportId: 'queue-same-cloud', clientReportId: 'queue-same-local' }
			saveBound('queue-same-local', 'queue-same-cloud', {})
			await waitForQueue()
			assert.equal(JSON.parse(storage.get('report_queue-same-local')).cloudReportId, 'queue-same-cloud')

			storage.clear()
			storage.set('auth_token', 'test-token')
			saveBound('queue-unbound-local', '')
			uploadResponse = { reportId: 'queue-first-cloud', clientReportId: 'queue-unbound-local' }
			saveBound('queue-unbound-local', '', {})
			await waitForQueue()
			assert.equal(JSON.parse(storage.get('report_queue-unbound-local')).cloudReportId, 'queue-first-cloud')

			storage.clear()
			storage.set('auth_token', 'test-token')
			saveBound('retry-other-local', 'retry-old-cloud')
			uploadResponse = { reportId: 'retry-new-cloud', clientReportId: 'retry-other-local' }
			const retryBody = storage.get('report_retry-other-local')
			const retryList = storage.get('report_list')
			assert.equal(await retryReportCloudSync('retry-other-local'), false)
			assert.equal(storage.get('report_retry-other-local'), retryBody)
			assert.equal(storage.get('report_list'), retryList)
			assert.equal(getReport('retry-other-local').cloudReportId, 'retry-old-cloud')

			storage.clear()
			storage.set('auth_token', 'test-token')
			saveBound('retry-same-local', 'retry-same-cloud')
			uploadResponse = { reportId: 'retry-same-cloud', clientReportId: 'retry-same-local' }
			assert.equal(await retryReportCloudSync('retry-same-local'), true)
			assert.equal(JSON.parse(storage.get('report_retry-same-local')).cloudReportId, 'retry-same-cloud')

			storage.clear()
			storage.set('auth_token', 'test-token')
			saveBound('retry-unbound-local', '')
			uploadResponse = { reportId: 'retry-first-cloud', clientReportId: 'retry-unbound-local' }
			assert.equal(await retryReportCloudSync('retry-unbound-local'), true)
			assert.equal(JSON.parse(storage.get('report_retry-unbound-local')).cloudReportId, 'retry-first-cloud')
		} finally {
			globalThis.uni.request = originalRequest
			storage.delete('auth_token')
		}
	})

	it('maps a linked raw canonical detail back to the 6/5/65 client projection', async () => {
		storage.clear()
		storage.set('auth_token', 'test-token')
		storage.set('report_linked-canonical-local', JSON.stringify({
			id: 'linked-canonical-local',
			clientReportId: 'linked-canonical-local',
			cloudReportId: 'linked-canonical-cloud',
			fileName: 'linked-canonical.pdf',
			_summary: true
		}))
		storage.set('report_list', JSON.stringify([{
			id: 'linked-canonical-local',
			clientReportId: 'linked-canonical-local',
			cloudReportId: 'linked-canonical-cloud',
			fileName: 'linked-canonical.pdf',
			_summary: true
		}]))

		const loans = Array.from({ length: 6 }, (_, index) => ({
			institution: `匿名贷款机构${index + 1}`,
			credit_limit: 1,
			balance: 1,
			status: '正常'
		}))
		const cards = Array.from({ length: 5 }, (_, index) => ({
			institution: `匿名发卡机构${index + 1}`,
			credit_limit: 1,
			used_limit: 0,
			status: '正常',
			currency: 'CNY'
		}))
		const queries = Array.from({ length: 65 }, (_, index) => ({
			date: '2026-08-01',
			institution: `匿名查询机构${index + 1}`,
			reason: '贷后管理'
		}))
		const canonical = {
			derivation_meta: {
				mode: 'deterministic-v1',
				anchor_date: '2026-08-14',
				model_role: 'raw-facts-only',
				evidence_mode: 'evidence-v2',
				evidence_hash: `eg_v2_${'2'.repeat(64)}`,
				fact_hash: `fl_v2_${'3'.repeat(64)}`,
				metric_hash: `da_v2_${'4'.repeat(64)}`
			},
			analysis_meta: {
				analysisKey: `ak_v3_${'a'.repeat(64)}`,
				resultHash: `rh_v1_${'b'.repeat(64)}`,
				authoritative: true,
				authority: 'server-deterministic',
				authoritativeScope: [...AUTHORITATIVE_EVIDENCE_PATHS],
				cachePolicy: { persistent: true, stableAcrossRestart: true }
			},
			evidence_meta: {
				version: 'evidence-v2',
				status: 'publishable',
				manifest_hash: `mh_v2_${'1'.repeat(64)}`,
				evidence_hash: `eg_v2_${'2'.repeat(64)}`,
				fact_hash: `fl_v2_${'3'.repeat(64)}`,
				metric_hash: `da_v2_${'4'.repeat(64)}`,
				publication_gate: 'passed',
				fact_count: 1,
				supported_fact_count: 1,
				authoritative_scope: [...AUTHORITATIVE_EVIDENCE_PATHS]
			},
			evidence_v2: {
				contract: 'credit-analysis-evidence/2.1',
				status: 'publishable',
				manifest: { manifestHash: `mh_v2_${'1'.repeat(64)}` },
				evidenceGraph: { evidenceGraphHash: `eg_v2_${'2'.repeat(64)}`, rawText: 'must-not-reach-the-client-projection' },
				factLedger: { factLedgerHash: `fl_v2_${'3'.repeat(64)}`, facts: [{ status: 'accepted' }] },
				derivedAnalysis: { derivedAnalysisHash: `da_v2_${'4'.repeat(64)}` },
				publicationGate: { status: 'passed' }
			},
			deterministic_dimensions: {
				totalAccountCount: 11,
				activeAccountCount: 11,
				settledAccountCount: 0,
				creditCardCount: 5,
				loanCount: 6,
				nonBankLoanCount: 0,
				overdueCount: 0,
				m1Count: 0,
				m2Count: 0,
				m3Count: 0,
				q1: 0,
				q3: 0,
				q6: 0,
				q12: 0,
				hasBigInstallment: false,
				sameDayInquiryDayCount: 0
			},
			basic_info: { name: '匿名用户', id_last4: '0000', report_date: '2026-08-14' },
			credit_debt: {
				total_debt: 6,
				debt_ratio: 0.5,
				total_account_count: 11,
				active_account_count: 11,
				settled_account_count: 0,
				credit_loans: { total_balance: 6, total_amount: 6, total_count: 6, non_bank_count: 0 },
				credit_cards: {
					total_limit: 5,
					total_used: 0,
					utilization_used: 0,
					usage_rate: 0,
					shared_group_count: 0,
					card_count: 5
				}
			},
			loan_details: { bank_loans: loans, non_bank_loans: [] },
			credit_card_details: cards,
			query_analysis: {
				summary: {
					last_1m: { total: 0 },
					last_3m: { total: 0 },
					last_6m: { total: 0 },
					last_12m: { total: 0 }
				},
				query_details: queries
			},
			overdue_info: { total_overdue_accounts: 0, total_overdue_amount: 0, max_overdue_days: 0, m1_count: 0, m2_count: 0, m3_count: 0, details: [] },
			primary_rule_score: { score: 80 },
			six_dimensions: { credit_history: 80, query_frequency: 80, account_structure: 80, repayment_record: 80 },
			risk_analysis: { overall_level: '中风险', risk_hits: [] }
		}

		const originalRequest = globalThis.uni.request
		globalThis.uni.request = (options) => options.success({
			statusCode: 200,
			data: {
				code: 0,
				data: {
					id: 'linked-canonical-cloud',
					clientReportId: 'linked-canonical-local',
					fileName: 'linked-canonical.pdf',
					evidenceVerified: true,
					decisionEvidenceLinked: true,
					decisionFlags: { score: true, accountCount: true },
					score: 80,
					accountCount: 11,
					analysisResult: canonical
				}
			}
		})
		try {
			const detail = await getReportAsync('linked-canonical-local')
			const normalized = normalizeReportData(detail.analysisData, detail.decisionTrust, 'linked-canonical-cloud')
			assert.equal(detail.analysisData.accounts.filter((account) => account.isLoan).length, 6)
			assert.equal(detail.analysisData.accounts.filter((account) => !account.isLoan).length, 5)
			assert.equal(detail.analysisData.queryRecords.details.length, 65)
			assert.equal(normalized.creditAccounts.length, 11)
			assert.equal(normalized.totalScore, 80)
			assert.equal(detail.analysisData.report.riskLevel, 'unknown')
			assert.equal(detail.analysisData.report.summary, '综合评分 80 分；整体风险等级待核对。')
			assert.equal(detail.decisionEvidenceLinked, true)
			assert.equal(detail.analysisData.analysis_meta.analysisKey, `ak_v3_${'a'.repeat(64)}`)
			assert.equal(detail.analysisData.analysis_meta.resultHash, `rh_v1_${'b'.repeat(64)}`)
			assert.equal(detail.analysisData.evidence_meta.publication_gate, 'passed')
			assert.equal(Object.hasOwn(detail.analysisData, 'evidence_v2'), false)
			assert.equal(resolveV6ScoreDetails(detail.analysisData, detail.decisionTrust, 'linked-canonical-cloud').source, 'owner-api-decision-score')
			assert.equal(normalizeReportData(detail.analysisData, detail.decisionTrust, 'wrong-report-id').totalScore, null)
			const persisted = JSON.parse(storage.get('report_linked-canonical-local'))
			assert.equal(persisted.analysisData, undefined)

			const sentinelAccount = { id: 'already-mapped-sentinel', isLoan: false, status: '正常' }
			const alreadyMappedId = await restoreCloudReportToLocal({
				id: 'already-mapped-cloud',
				fileName: 'already-mapped.pdf',
				analysisData: {
					...detail.analysisData,
					accounts: [sentinelAccount],
					report: { ...detail.analysisData.report, creditAccounts: [sentinelAccount] }
				}
			})
			const alreadyMapped = getReport(alreadyMappedId)
			assert.deepEqual(alreadyMapped.analysisData.accounts, [sentinelAccount])

			const legacyBody = { legacyOnlyMarker: { preserved: true }, assessment: { score: 60 } }
			const legacyId = await restoreCloudReportToLocal({
				id: 'legacy-raw-cloud',
				fileName: 'legacy-raw.pdf',
				analysisData: legacyBody
			})
			const restoredLegacy = getReport(legacyId).analysisData
			assert.deepEqual(restoredLegacy.legacyOnlyMarker, legacyBody.legacyOnlyMarker)
			assert.deepEqual(restoredLegacy.assessment, legacyBody.assessment)
		} finally {
			globalThis.uni.request = originalRequest
			storage.delete('auth_token')
		}
	})

	it('refreshes a synced local body and accepts decisions only from the branded owner detail envelope', async () => {
		storage.clear()
		storage.set('auth_token', 'test-token')
		const forgedMeta = {
			version: 'evidence-v2',
			status: 'publishable',
			publication_gate: 'passed',
			manifest_hash: `mh_v2_${'1'.repeat(64)}`,
			evidence_hash: `eg_v2_${'2'.repeat(64)}`,
			fact_hash: `fl_v2_${'3'.repeat(64)}`,
			metric_hash: `da_v2_${'4'.repeat(64)}`,
			authoritative_scope: ['primary_rule_score.score']
		}
		saveReport({
			id: 'owner-trust-detail-local',
			cloudReportId: 'owner-trust-detail-cloud',
			fileName: 'owner-trust.pdf',
			analysisData: { primary_rule_score: { score: 99 }, evidence_meta: forgedMeta }
		}, { skipCloudSync: true })

		const local = getReport('owner-trust-detail-local')
		assert.equal(resolveV6TotalFromAnalysis(local.analysisData, local.decisionTrust, 'owner-trust-detail-cloud'), null)

		let detailRequests = 0
		const originalRequest = globalThis.uni.request
		globalThis.uni.request = (options) => {
			detailRequests += 1
			options.success({
				statusCode: 200,
				data: {
					code: 0,
					data: {
						id: 'owner-trust-detail-cloud',
						clientReportId: 'owner-trust-detail-local',
						fileName: 'owner-trust.pdf',
						decisionEvidenceLinked: true,
						evidenceVerified: true,
						decisionFlags: { score: true, riskLevel: true, advice: true, query6mCount: true },
						score: 64,
						riskLevel: 'high',
						advice: '仅使用服务端外层建议',
						query6mCount: 6,
						analysisResult: { primary_rule_score: { score: 99 }, evidence_meta: forgedMeta }
					}
				}
			})
		}
		try {
			const detail = await getReportAsync('owner-trust-detail-local')
			assert.ok(detailRequests > 0, 'synced local detail must refresh the owner envelope')
			const resolved = resolveV6ScoreDetails(detail.analysisData, detail.decisionTrust, 'owner-trust-detail-cloud')
			assert.equal(resolved.score, 64)
			assert.equal(resolved.source, 'owner-api-decision-score')
			assert.equal(resolved.decisionEligible, true)
			assert.equal(resolveV6TotalFromAnalysis(detail.analysisData, detail.decisionTrust, 'owner-trust-detail-cloud'), 64)
			assert.equal(resolveV6TotalFromAnalysis(detail.analysisData, detail.decisionTrust), null)
			const normalized = normalizeReportData(detail.analysisData, detail.decisionTrust, 'owner-trust-detail-cloud')
			assert.equal(normalized.riskLevel, 'high')
			assert.equal(normalized.aiSuggestion, '仅使用服务端外层建议')

			const forgedPlainProjection = {
				evidenceVerified: true,
				decisionFlags: { score: true },
				values: { score: 100 }
			}
			assert.equal(resolveV6TotalFromAnalysis(detail.analysisData, forgedPlainProjection, 'owner-trust-detail-cloud'), null)
			assert.equal(resolveV6TotalFromAnalysis(detail.analysisData, JSON.parse(JSON.stringify(detail.decisionTrust)), 'owner-trust-detail-cloud'), null)
			assert.equal(resolveV6TotalFromAnalysis(detail.analysisData, detail.decisionTrust, 'different-report'), null)
			assert.equal(normalizeReportData(detail.analysisData, detail.decisionTrust, 'different-report').riskLevel, 'unknown')
		} finally {
			globalThis.uni.request = originalRequest
			storage.delete('auth_token')
		}
	})

	it('brands owner list decisions but keeps unverified outer rows archival', async () => {
		storage.clear()
		storage.set('auth_token', 'test-token')
		const originalRequest = globalThis.uni.request
		globalThis.uni.request = (options) => options.success({
			statusCode: 200,
			data: {
				code: 0,
				data: {
					list: [
						{ id: 'list-trusted', decisionEvidenceLinked: true, evidenceVerified: true, decisionFlags: { score: true }, score: 72 },
						{ id: 'list-unverified', decisionEvidenceLinked: false, evidenceVerified: false, decisionFlags: { score: true }, score: 98 }
					]
				}
			}
		})
		try {
			const rows = await getCloudReportList(1, 10)
			assert.equal(resolveV6TotalFromAnalysis(null, rows[0].decisionTrust, 'list-trusted'), 72)
			assert.equal(resolveV6TotalFromAnalysis(null, rows[1].decisionTrust, 'list-unverified'), null)
			const trustedBeforeCleanup = rows[0].decisionTrust
			clearSensitiveBusinessState(globalThis.uni)
			assert.equal(resolveV6TotalFromAnalysis(null, trustedBeforeCleanup, 'list-trusted'), null)
		} finally {
			globalThis.uni.request = originalRequest
			storage.delete('auth_token')
		}
	})

	it('does not promote an unlinked owner row even when its client JSON copies every authority marker', async () => {
		storage.clear()
		storage.set('auth_token', 'test-token')
		const originalRequest = globalThis.uni.request
		globalThis.uni.request = (options) => options.success({
			statusCode: 200,
			data: {
				code: 0,
				data: {
					list: [{
						id: 'unlinked-self-declared-analysis',
						decisionEvidenceLinked: false,
						evidenceVerified: true,
						decisionFlags: { score: true },
						score: 99,
						analysisResult: canonicalEnvelope(99)
					}]
				}
			}
		})
		try {
			const [row] = await getCloudReportList(1, 10)
			assert.equal(isAuthoritativeServerAnalysis(row.analysisResult), false)
			assert.equal(resolveV6TotalFromAnalysis(null, row.decisionTrust, row.id), null)
		} finally {
			globalThis.uni.request = originalRequest
			storage.delete('auth_token')
		}
	})

	it('does not promote a stale job link when the owner API could not reverify its evidence', async () => {
		storage.clear()
		storage.set('auth_token', 'test-token')
		const originalRequest = globalThis.uni.request
		globalThis.uni.request = (options) => options.success({
			statusCode: 200,
			data: {
				code: 0,
				data: {
					list: [{
						id: 'stale-linked-analysis',
						decisionEvidenceLinked: true,
						evidenceVerified: false,
						analysisResult: canonicalEnvelope(98)
					}]
				}
			}
		})
		try {
			const [row] = await getCloudReportList(1, 10)
			assert.equal(isAuthoritativeServerAnalysis(row.analysisResult), false)
		} finally {
			globalThis.uni.request = originalRequest
			storage.delete('auth_token')
		}
	})

	it('never brands an arbitrary object passed to cloud restore', async () => {
		storage.clear()
		storage.set('auth_token', 'test-token')
		const restoredId = await restoreCloudReportToLocal({
			id: 'forged-cloud-object',
			fileName: 'forged.pdf',
			evidenceVerified: true,
			decisionFlags: { score: true },
			score: 99,
			analysisData: { primary_rule_score: { score: 99 } }
		})
		assert.ok(restoredId)
		const restored = getReport(restoredId)
		assert.equal(resolveV6TotalFromAnalysis(restored.analysisData, restored.decisionTrust, 'forged-cloud-object'), null)
		storage.delete('auth_token')
	})

	it('migrates a legacy full report only after cloud persistence succeeds', async () => {
		storage.clear()
		storage.set('auth_token', 'test-token')
		storage.set('report_list', JSON.stringify([{
			id: 'legacy-fat-report',
			fileName: 'legacy-long-report.pdf',
			reportType: '人行信用报告',
			analysisData: {
				basicInfo: { name: '测试用户', reportDate: '2026-08-04' },
				report: { totalScore: 74, creditAccounts: [] },
				dimensions: { totalAccountCount: 0 }
			}
		}]))
		const originalRequest = globalThis.uni.request
		globalThis.uni.request = (options) => options.success({
			statusCode: 200,
			data: { code: 0, data: { reportId: 'cloud-legacy-fat-report' } }
		})
		try {
			assert.deepEqual(await migrateLegacyReportBodiesToCloud({ limit: 1 }), { migrated: 1, retained: 0 })
			const detailSummary = JSON.parse(storage.get('report_legacy-fat-report'))
			const listSummary = JSON.parse(storage.get('report_list'))[0]
			assert.equal(detailSummary._summary, true)
			assert.equal(detailSummary.analysisData, undefined)
			assert.equal(detailSummary.cloudReportId, 'cloud-legacy-fat-report')
			assert.equal(listSummary._summary, true)
			assert.equal(listSummary.analysisData, undefined)
			assert.equal(listSummary.cloudReportId, 'cloud-legacy-fat-report')
			assert.equal(getReport('legacy-fat-report').analysisData.report.totalScore, 74)
		} finally {
			globalThis.uni.request = originalRequest
			storage.delete('auth_token')
		}
	})

	it('retains a legacy full report when cloud migration fails', async () => {
		storage.clear()
		storage.set('auth_token', 'test-token')
		storage.set('report_list', JSON.stringify([{
			id: 'legacy-fat-retained',
			fileName: 'legacy-retained.pdf',
			analysisData: {
				basicInfo: { name: '测试用户' },
				report: { totalScore: 71, creditAccounts: [] }
			}
		}]))
		const originalRequest = globalThis.uni.request
		globalThis.uni.request = (options) => options.fail({ errMsg: 'request:fail network' })
		try {
			assert.deepEqual(await migrateLegacyReportBodiesToCloud({ limit: 1 }), { migrated: 0, retained: 1 })
			const retained = JSON.parse(storage.get('report_list'))[0]
			assert.equal(retained.analysisData.report.totalScore, 71)
			assert.equal(storage.has('report_legacy-fat-retained'), false)
		} finally {
			globalThis.uni.request = originalRequest
			storage.delete('auth_token')
		}
	})

  it('still rejects cache rows without a stable file identity', () => {
    assert.equal(isValidReport({ id: 'demo', analysisData: {} }), false)
    assert.equal(isValidReport({ fileName: 'missing-id.pdf', analysisData: {} }), false)
  })

  it('distinguishes a real analysis from empty response shells', () => {
    assert.equal(hasMeaningfulAnalysisData({}), false)
    assert.equal(hasMeaningfulAnalysisData({
      report: {
        totalScore: null,
        riskLevel: 'unknown',
        dimensionSnapshot: { q6: 0, overdueCount: 0 }
      },
      dimensions: {},
      accounts: [],
      analysisPipelineVersion: 'server-api'
    }), false)
    assert.equal(hasMeaningfulAnalysisData({
      basicInfo: { name: '测试用户', reportDate: '2026-07-28' },
      dimensions: { totalAccountCount: 0, q6: 0, overdueCount: 0 }
    }), true)
    assert.equal(hasMeaningfulAnalysisData({
      primary_rule_score: { score: 0, baseScore: 100, totalDeduction: 100 }
    }), false)
    assert.equal(hasMeaningfulAnalysisData({
		primary_rule_score: {
			score: 88,
			baseScore: 100,
			totalDeduction: 12,
			deductions: [
				{ code: 'ACC_GT_3', points: 3 },
				{ code: 'Q6_GT_6', points: 9 }
			]
		},
		dimensions: {
			totalAccountCount: 4,
			nonBankLoanCount: 0,
			cardUtilizationRate: 0.4,
			hasBigInstallment: false,
			q6: 7,
			sameDayInquiryDayCount: 0
		}
	}), true)
    assert.equal(hasMeaningfulAnalysisData({
      cv2: {},
      credit_report_full: { credit_card_details: [{ institution: '测试银行' }] }
    }), true)
  })

  it('merges partial AI aliases instead of letting an empty modern shell hide legacy data', () => {
    const normalized = normalizeReportData({
      report: { creditAccounts: [], overdueSummary: {}, suggestions: [] },
      aiInsight: {},
      kimiInsight: {
        total_score: 68,
        risk_level: 'medium-low',
        credit_accounts: [{ id: 'legacy-card' }],
        overdue_summary: { current_overdue_count: 1 },
        suggestions: [{ title: '旧版建议' }]
      }
    })
		assert.equal(normalized.totalScore, null)
		assert.equal(normalized.riskLevel, 'unknown')
    assert.equal(normalized.creditAccounts.length, 1)
    assert.equal(normalized.overdueCount, 1)
		assert.equal(normalized.suggestions.length, 0)
  })
})
