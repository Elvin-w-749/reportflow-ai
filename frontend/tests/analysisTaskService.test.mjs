import { after, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

const originalUni = globalThis.uni
const storage = new Map([['auth_token', 'task-test-token']])
let uploadCall = null
let progressListener = null
let throwOnStorageWrite = null
let uploadAbortCount = 0
let requestCall = null
const SUPPORT_REF = `sr_${'a'.repeat(24)}`
const OTHER_SUPPORT_REF = `sr_${'b'.repeat(24)}`
const SERVER_TIME = '2026-08-18T01:02:03.004Z'

globalThis.uni = {
	getStorageSync: (key) => storage.get(key) ?? '',
	setStorageSync: (key, value) => {
		if (throwOnStorageWrite) throw throwOnStorageWrite
		storage.set(key, value)
	},
	removeStorageSync: (key) => storage.delete(key),
	getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
	uploadFile: (options) => {
		uploadCall = options
		return {
			abort() {
				uploadAbortCount += 1
				options.fail?.({ code: 'UPLOAD_ABORTED', errMsg: 'uploadFile:fail abort', aborted: true })
			},
			onProgressUpdate(listener) { progressListener = listener }
		}
	},
	request: (options) => {
		requestCall = options
	}
}

const server = await createServer({
	mode: 'production',
	define: { __RPT_PROD__: 'true', __RPT_PROXY_BASE__: JSON.stringify('') },
	server: { middlewareMode: true },
	appType: 'custom',
	logLevel: 'silent'
})

const service = await server.ssrLoadModule('/src/services/analysisTaskService.js')
const {
	buildUploadTelemetryExtra,
	classifyUploadFailure,
	createTerminalAnalysisFailure
} = await server.ssrLoadModule('/src/services/uploadFailure.js')

after(async () => {
	await server.close()
	if (originalUni === undefined) delete globalThis.uni
	else globalThis.uni = originalUni
})

beforeEach(() => {
	storage.clear()
	storage.set('auth_token', 'task-test-token')
	uploadCall = null
	progressListener = null
	throwOnStorageWrite = null
	uploadAbortCount = 0
	requestCall = null
})

describe('analysisTaskService', () => {
	it('writes the small recovery record and verifies it immediately', () => {
		const stored = service.saveActiveAnalysisTask({
			jobId: 'job_1234567890abcdef',
			supportRef: SUPPORT_REF,
			status: 'queued',
			stage: 'queued',
			progress: 5,
			cacheHit: true,
			fileName: '报告.pdf',
			reportFormat: { type: 'PDF', source: '人行信用报告', version: 'v2015' }
		})

		assert.equal(stored.jobId, 'job_1234567890abcdef')
		assert.equal(service.loadActiveAnalysisTask().cacheHit, true)
		assert.equal(service.loadActiveAnalysisTask().jobId, stored.jobId)
		assert.deepEqual(service.loadActiveAnalysisTask().reportFormat, {
			type: 'PDF',
			source: '人行信用报告',
			version: 'v2015'
		})
		assert.equal(service.clearActiveAnalysisTask(stored.jobId), true)
		assert.equal(service.loadActiveAnalysisTask(), null)
	})

	it('does not swallow QuotaExceededError while saving recovery state', () => {
		const quotaError = Object.assign(new Error('quota exceeded'), { name: 'QuotaExceededError' })
		throwOnStorageWrite = quotaError
		assert.throws(
			() => service.saveActiveAnalysisTask({
				jobId: 'job_1234567890abcdef',
				supportRef: SUPPORT_REF,
				status: 'queued',
				stage: 'queued',
				progress: 5
			}),
			(error) => error === quotaError
		)
	})

	it('drops a malformed report format when recovery storage is read back', () => {
		storage.set('currentTaskId', JSON.stringify({
			jobId: 'job_1234567890abcdef',
			status: 'running',
			reportFormat: { type: 'PDF', source: '伪造机构', version: '<script>' }
		}))

		const restored = service.loadActiveAnalysisTask()
		assert.equal(restored.jobId, 'job_1234567890abcdef')
		assert.equal(restored.reportFormat, undefined)
	})

	it('uses real upload byte progress and accepts an HTTP 202 task response', async () => {
		const seen = []
		const pending = service.createAnalysisJob('/tmp/report.pdf', {
			onUploadProgress: (progress) => seen.push(progress)
		})
		assert.ok(uploadCall)
		assert.match(uploadCall.url, /\/api\/analysis\/jobs$/)
		assert.equal(uploadCall.header.Authorization, 'Bearer task-test-token')
		assert.equal(uploadCall.timeout, 900000)
		progressListener({ progress: 37, totalBytesSent: 370, totalBytesExpectedToSend: 1000 })
		uploadCall.success({
			statusCode: 202,
			data: JSON.stringify({
				code: 0,
				data: { jobId: 'job_1234567890abcdef', supportRef: SUPPORT_REF, status: 'queued', stage: 'queued', progress: 5 }
			})
		})

		const job = await pending
		assert.deepEqual(seen, [37])
		assert.equal(job.jobId, 'job_1234567890abcdef')
		assert.equal(job.progress, 5)
	})

	it('preserves an explicit upload timeout override', async () => {
		const pending = service.createAnalysisJob('/tmp/report.pdf', { uploadTimeout: 321000 })
		assert.equal(uploadCall.timeout, 321000)
		uploadCall.success({
			statusCode: 202,
			data: JSON.stringify({
				code: 0,
				data: { jobId: 'job_abcdef1234567890', supportRef: SUPPORT_REF, status: 'queued', stage: 'queued', progress: 5 }
			})
		})
		assert.equal((await pending).jobId, 'job_abcdef1234567890')
	})

	it('preserves raw HTTP 413 separately from a status-0 network interruption', async () => {
		const tooLarge = service.createAnalysisJob('/tmp/large.pdf').then(
			() => null,
			(error) => error
		)
		uploadCall.success({ statusCode: 413, data: JSON.stringify({ code: 413, msg: 'too large' }) })
		const tooLargeError = await tooLarge
		assert.equal(tooLargeError.httpStatus, 413)
		assert.equal(tooLargeError.transportKind, 'http')

		const disconnected = service.createAnalysisJob('/tmp/large.pdf').then(
			() => null,
			(error) => error
		)
		uploadCall.fail({ errMsg: 'uploadFile:fail network error' })
		const networkError = await disconnected
		assert.equal(networkError.httpStatus, 0)
		assert.equal(networkError.transportKind, 'network')
	})

	it('classifies non-JSON gateway responses by the real HTTP status only', async () => {
		const html413 = service.createAnalysisJob('/tmp/large.pdf').then(
			() => null,
			(error) => error
		)
		uploadCall.success({ statusCode: 413, data: '<html><body>Request Entity Too Large</body></html>' })
		const html413Error = await html413
		assert.equal(html413Error.httpStatus, 413)
		assert.equal(html413Error.statusCode, 413)
		assert.equal(html413Error.transportKind, 'http')
		const html413Failure = classifyUploadFailure(html413Error)
		assert.equal(html413Failure.category, 'file-too-large')
		assert.equal(html413Failure.title, '上传上限过小')

		const html502 = service.createAnalysisJob('/tmp/report.pdf').then(
			() => null,
			(error) => error
		)
		uploadCall.success({ statusCode: 502, data: '<html><body>Bad Gateway</body></html>' })
		const html502Error = await html502
		assert.equal(html502Error.httpStatus, 502)
		assert.equal(html502Error.statusCode, 502)
		assert.equal(html502Error.transportKind, 'http')
		const html502Failure = classifyUploadFailure(html502Error)
		assert.equal(html502Failure.category, 'server')
		assert.equal(html502Failure.title, '分析服务异常')
		assert.doesNotMatch(`${html502Failure.title} ${html502Failure.message}`, /文件过大|上传上限过小/)
	})

	it('aborts only the client upload when its lifecycle signal is cancelled', async () => {
		const controller = new AbortController()
		const pending = service.createAnalysisJob('/tmp/report.pdf', { signal: controller.signal }).then(
			() => null,
			(error) => error
		)
		controller.abort()
		const error = await pending
		assert.equal(uploadAbortCount, 1)
		assert.equal(error.code, 'UPLOAD_ABORTED')
		assert.equal(error.transportKind, 'abort')
	})

	it('rejects a status response for another job without turning it into a terminal failure', async () => {
		const expectedJobId = 'job_expected_1234567890'
		service.saveActiveAnalysisTask({ jobId: expectedJobId, supportRef: SUPPORT_REF, status: 'processing', stage: 'analysis', progress: 40 })
		const pending = service.getAnalysisJobStatus(expectedJobId).then(
			() => null,
			(error) => error
		)
		assert.match(requestCall.url, new RegExp(`/api/analysis/jobs/${expectedJobId}$`))
		requestCall.success({
			statusCode: 200,
			data: {
				code: 0,
				data: {
					jobId: 'job_unexpected_12345678',
					supportRef: SUPPORT_REF,
					status: 'failed',
					stage: 'failed',
					progress: 80,
					errorCode: 'EVIDENCE_PUBLICATION_BLOCKED',
					errorClass: 'evidence_permanent',
					failureStage: 'publication-gate',
					safeMessageKey: 'analysis-publication-blocked',
					retryable: false,
					serverTime: SERVER_TIME
				}
			}
		})
		const error = await pending
		assert.equal(error.code, 'ANALYSIS_TASK_RESPONSE_MISMATCH')
		assert.equal(error.terminalAnalysisFailure, undefined)
		assert.equal(service.loadActiveAnalysisTask().jobId, expectedJobId)
	})

	it('keeps the recovery pointer when an acknowledgement response belongs to another job', async () => {
		const expectedJobId = 'job_expected_1234567890'
		service.saveActiveAnalysisTask({ jobId: expectedJobId, supportRef: SUPPORT_REF, status: 'processing', stage: 'analysis', progress: 40 })
		const pending = service.acknowledgeAnalysisJob(expectedJobId).then(
			() => null,
			(error) => error
		)
		requestCall.success({
			statusCode: 200,
			data: { code: 0, data: { acknowledged: true, jobId: 'job_unexpected_12345678', supportRef: SUPPORT_REF, serverTime: SERVER_TIME } }
		})
		const error = await pending
		assert.equal(error.code, 'ANALYSIS_TASK_RESPONSE_MISMATCH')
		assert.equal(service.loadActiveAnalysisTask().jobId, expectedJobId)
	})

	it('does not let a late acknowledgement for A clear a newer local job B', async () => {
		const oldJobId = 'job_old_task_1234567890'
		const currentJobId = 'job_new_task_12345678'
		service.saveActiveAnalysisTask({ jobId: currentJobId, supportRef: OTHER_SUPPORT_REF, status: 'processing', stage: 'analysis', progress: 40 })
		const pending = service.acknowledgeAnalysisJob(oldJobId)
		requestCall.success({
			statusCode: 200,
			data: { code: 0, data: { acknowledged: true, jobId: oldJobId, supportRef: SUPPORT_REF, serverTime: SERVER_TIME } }
		})
		assert.equal(await pending, true)
		assert.equal(service.clearActiveAnalysisTask(oldJobId), false)
		assert.equal(service.loadActiveAnalysisTask().jobId, currentJobId)
	})

	it('keeps the recovery pointer when acknowledgement transport fails', async () => {
		const jobId = 'job_failed_task_1234567'
		service.saveActiveAnalysisTask({ jobId, supportRef: SUPPORT_REF, status: 'processing', stage: 'analysis', progress: 40 })
		const pending = service.acknowledgeAnalysisJob(jobId).then(
			() => null,
			(error) => error
		)
		requestCall.fail({ errMsg: 'request:fail network disconnected' })
		const error = await pending
		assert.equal(error.transportKind, 'network')
		assert.equal(service.loadActiveAnalysisTask().jobId, jobId)
	})

	it('projects only known response fields and rejects scalar type confusion', async () => {
		const pending = service.createAnalysisJob('/tmp/report.pdf')
		uploadCall.success({
			statusCode: 202,
			data: JSON.stringify({
				code: 0,
				data: {
					jobId: 'job_1234567890abcdef',
					supportRef: SUPPORT_REF,
					status: 'queued',
					stage: 'queued',
					progress: 5,
					traceId: `tr_${'x'.repeat(24)}`,
					extra: 'PRIVATE_REPORT_TEXT',
					userId: 'PRIVATE_USER_ID',
					diagnostic: { extra: 'PRIVATE_AMOUNT' }
				}
			})
		})
		const projected = await pending
		assert.deepEqual(Object.keys(projected), [
			'jobId', 'supportRef', 'status', 'stage', 'progress', 'resultReady',
			'errorCode', 'errorClass', 'failureStage', 'safeMessageKey', 'diagnostic', 'retryable',
			'attemptCount', 'createdAt', 'updatedAt', 'finishedAt', 'serverTime',
			'supportRefTrusted'
		])
		assert.doesNotMatch(JSON.stringify(projected), /PRIVATE|traceId|extra|userId/)

		for (const [field, value] of [
			['jobId', ['job_1234567890abcdef']],
			['supportRef', [SUPPORT_REF]],
			['status', ['queued']],
			['stage', ['queued']],
			['progress', [5]]
		]) {
			const rejected = service.createAnalysisJob('/tmp/report.pdf').then(
				() => null,
				(error) => error
			)
			uploadCall.success({
				statusCode: 202,
				data: JSON.stringify({
					code: 0,
					data: {
						jobId: 'job_1234567890abcdef',
						supportRef: SUPPORT_REF,
						status: 'queued',
						stage: 'queued',
						progress: 5,
						[field]: value
					}
				})
			})
			assert.equal((await rejected).code, 'ANALYSIS_TASK_RESPONSE_MISMATCH', field)
		}
	})

	it('binds an untrusted local support ref to the first server status and rejects later drift', async () => {
		const jobId = 'job_rebind_1234567890ab'
		storage.set('currentTaskId', JSON.stringify({
			jobId,
			supportRef: OTHER_SUPPORT_REF,
			status: 'processing',
			stage: 'analysis',
			progress: 50,
			extra: 'PRIVATE_LOCAL_VALUE'
		}))
		const local = service.loadActiveAnalysisTask()
		assert.equal(local.supportRef, OTHER_SUPPORT_REF)
		assert.equal(local.supportRefTrusted, false)
		assert.equal(local.extra, undefined)

		const terminalPending = service.waitForAnalysisJob(jobId, { supportRef: '' })
		requestCall.success({
			statusCode: 200,
			data: {
				code: 0,
				data: {
					jobId,
					supportRef: SUPPORT_REF,
					status: 'failed',
					stage: 'failed',
					progress: 75,
					errorCode: 'FACT_SCHEMA_INVALID',
					errorClass: 'schema_permanent',
					failureStage: 'fact-extraction',
					safeMessageKey: 'provider-response-invalid',
					diagnostic: { version: 1, unknownCount: 7, extra: 'PRIVATE_TEXT' },
					retryable: false,
					serverTime: SERVER_TIME
				}
			}
		})
		const terminal = await terminalPending
		assert.equal(terminal.supportRef, SUPPORT_REF)
		assert.deepEqual(terminal.diagnostic, { version: 1 })

		const drift = service.getAnalysisJobStatus(jobId, SUPPORT_REF).then(
			() => null,
			(error) => error
		)
		requestCall.success({
			statusCode: 200,
			data: {
				code: 0,
				data: { jobId, supportRef: OTHER_SUPPORT_REF, status: 'processing', stage: 'analysis', progress: 80 }
			}
		})
		assert.equal((await drift).code, 'ANALYSIS_TASK_RESPONSE_MISMATCH')
	})

	it('brands only strict server terminal jobs and carries cache-result failure context on first display', async () => {
		const jobId = 'job_cache_result_123456'
		const pending = service.getAnalysisJobResult(jobId, SUPPORT_REF)
		requestCall.success({
			statusCode: 200,
			data: {
				code: 0,
				data: {
					result: null,
					analysis: null,
					job: {
						jobId,
						supportRef: SUPPORT_REF,
						status: 'failed',
						stage: 'failed',
						progress: 99,
						errorCode: 'CACHE_INTEGRITY_FAILED',
						errorClass: 'internal_permanent',
						failureStage: 'cache',
						safeMessageKey: 'provider-response-invalid',
						diagnostic: { version: 1, extra: 'PRIVATE_CACHE_TEXT' },
						retryable: false,
						serverTime: SERVER_TIME
					}
				}
			}
		})
		const payload = await pending
		const error = createTerminalAnalysisFailure(payload.job, jobId)
		const failure = classifyUploadFailure(error)
		assert.equal(failure.supportRef, SUPPORT_REF)
		assert.equal(failure.serverTime, SERVER_TIME)
		assert.doesNotMatch(JSON.stringify(failure), /PRIVATE_CACHE_TEXT/)
		assert.deepEqual(buildUploadTelemetryExtra({
			category: failure.category,
			fileType: 'pdf',
			stage: 'analysis',
			error
		}).clientSupportRef, SUPPORT_REF)

		assert.throws(
			() => createTerminalAnalysisFailure(JSON.parse(JSON.stringify(payload.job)), jobId),
			(error) => error.code === 'ANALYSIS_TASK_RESPONSE_MISMATCH'
		)
		const local = Object.assign(new Error('network local failure'), {
			transportKind: 'network',
			supportRef: SUPPORT_REF,
			serverTime: SERVER_TIME,
			terminalAnalysisFailure: true,
			authoritativeAnalysisFailure: true
		})
		const localFailure = classifyUploadFailure(local)
		assert.equal(localFailure.supportRef, undefined)
		assert.equal(localFailure.serverTime, undefined)
		assert.equal(buildUploadTelemetryExtra({ error: local }).clientSupportRef, undefined)

		const piiShaped = service.getAnalysisJobStatus(jobId).then(
			() => null,
			(error) => error
		)
		requestCall.success({
			statusCode: 200,
			data: {
				code: 0,
				data: {
					jobId,
					supportRef: SUPPORT_REF,
					status: 'failed',
					stage: 'failed',
					progress: 99,
					errorCode: 'PRIVATE_CUSTOMER_13800138000',
					errorClass: 'schema_permanent',
					failureStage: 'private_customer_20260818',
					safeMessageKey: 'provider-response-invalid',
					retryable: false,
					serverTime: SERVER_TIME
				}
			}
		})
		assert.equal((await piiShaped).code, 'ANALYSIS_TASK_RESPONSE_MISMATCH')
	})
})
