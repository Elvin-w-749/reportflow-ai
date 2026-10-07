import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(__dirname, '../src/services/reportStorage.js'), 'utf8')
const uploadSource = readFileSync(resolve(__dirname, '../src/pages/report/Upload.vue'), 'utf8')

test('report archive policy is keyed by report-holder name and id-card identity', () => {
	assert.match(source, /export const getReportIdentityInfo/)
	assert.match(source, /idCard/)
	assert.match(source, /id_card/)
	assert.match(source, /身份证号/)
	assert.match(source, /证件号码/)
	assert.match(source, /mode: 'same-person-update'/)
	assert.doesNotMatch(source, /重复上传同月报告/)
	assert.match(source, /未识别到征信报告身份证信息/)
})

test('report archive policy keeps local persistence to id-card suffix only', () => {
	assert.match(source, /reportIdentityLast4: getReportIdentityInfo\(safeData\)\.last4/)
	assert.doesNotMatch(source, /reportIdentityFull/)
})

test('report archive policy accepts masked report-holder names from credit reports', () => {
	assert.match(source, /const masked = s\.match\(/)
	assert.ok(source.includes('[*＊×Xx]{1,4}[\\u4e00-\\u9fa5·]{0,3}'))
	assert.match(source, /masked\[0\]\.replace\(\s*\/\[＊×Xx\]\/g,\s*'\*'\s*\)/)
	assert.match(source, /if \(!existing\.length\) return \{ allowed: true, mode: 'first', customerName: nextName/)
})

test('report upload still enforces owner policy before saving locally', () => {
	assert.match(uploadSource, /validateReportArchivePolicy\(draftReport/)
	assert.match(uploadSource, /currentUserCanUploadUnlimitedReports\(\)/)
	assert.match(uploadSource, /FIXED_TEST_ACCOUNT_RE/)
	assert.match(uploadSource, /REPORT_OWNER_POLICY/)
})

test('cloud report upload carries the stable local report id as its idempotency alias', () => {
	assert.match(source, /const clientIds = resolveDecisionReportIdAliases\(\[/)
	assert.match(source, /reportData\.clientReportId,[\s\S]*reportData\.localReportId,[\s\S]*reportData\.id/)
	assert.match(source, /const clientReportId = clientIds\[0\] \|\| ''/)
	assert.match(source, /url: '\/api\/report\/upload'/)
	assert.match(source, /clientReportId/)
})

test('credit report screenshots can be selected as multiple pages for one analysis', () => {
	assert.match(uploadSource, /MAX_REPORT_IMAGE_PAGES = 30/)
	assert.match(uploadSource, /count:\s*Math\.max\(1, Math\.min\(MAX_REPORT_IMAGE_PAGES/)
	assert.match(uploadSource, /继续添加/)
	assert.match(uploadSource, /开始解析/)
	assert.match(uploadSource, /showModal/)
	assert.match(uploadSource, /picked\.files/)
	assert.match(uploadSource, /按报告页顺序/)
	assert.match(uploadSource, /截图版征信请按页面顺序多选/)
})
