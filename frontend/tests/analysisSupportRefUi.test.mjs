import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const upload = fs.readFileSync(path.join(root, 'src/pages/report/Upload.vue'), 'utf8')
const pipeline = fs.readFileSync(path.join(root, 'src/services/aiAnalysis/pipeline.js'), 'utf8')
const taskService = fs.readFileSync(path.join(root, 'src/services/analysisTaskService.js'), 'utf8')

test('upload terminal error card renders only server-bound support reference and time', () => {
	assert.match(upload, /支持编号：\{\{ errorSupportRef \}\}/)
	assert.match(upload, /服务端时间：\{\{ errorServerTime \}\}/)
	assert.match(upload, /errorSupportRef\.value = failure\.supportRef \|\| ''/)
	assert.match(upload, /errorServerTime\.value = failure\.serverTime \|\| ''/)
	assert.match(upload, /acknowledgeAnalysisJob\(remoteJobId, supportRef\)/)
	assert.match(upload, /acknowledgeTerminalAnalysisFailure\(failedJobId, e\.supportRef\)/)
})

test('recovery binds local state to server support identity before terminal/result use', () => {
	assert.match(taskService, /supportRefTrusted: false/)
	assert.match(taskService, /let boundSupportRef = stableSupportRef\(options\.supportRef\)/)
	assert.match(taskService, /if \(!boundSupportRef\) boundSupportRef = status\.supportRef/)
	assert.match(taskService, /responseJob\(row\.job, id, expectedSupportRef\)/)
	assert.doesNotMatch(taskService, /return\s*\{\s*\.\.\.row,\s*jobId/)
	assert.match(pipeline, /supportRef: remoteJob\.supportRefTrusted === false \? '' : remoteJob\.supportRef/)
	assert.match(pipeline, /getAnalysisJobResult\(remoteJob\.jobId, terminal\.supportRef\)/)
	assert.match(pipeline, /resultPayload\?\.job\?\.status === 'failed'/)
	assert.match(pipeline, /createTerminalAnalysisFailure\(resultPayload\.job, remoteJob\.jobId\)/)
})
