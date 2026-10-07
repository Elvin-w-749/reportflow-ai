'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { scannedPdfToText } = require('../backend/services/creditAnalysisService')

const buildSyntheticIdentity = () => {
	const body = ['110101', '20000101', '009'].join('')
	const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
	const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2']
	const sum = body.split('').reduce((total, digit, index) => total + Number(digit) * weights[index], 0)
	return `${body}${checks[sum % 11]}`
}

const identity = buildSyntheticIdentity()
const fakeImages = [Buffer.from('page-one').toString('base64'), Buffer.from('page-two').toString('base64')]

const dependencies = ({ firstPageText, secondPageText = '第二页业务明细', recognize }) => ({
	renderPdfToPngBase64: async () => ({ total: 2, images: fakeImages }),
	ocrRenderedPdfPageToText: async (_image, pageNo) =>
		pageNo === 1 ? firstPageText : secondPageText,
	recognizeFirstPageOwnership: recognize
})

test('scanned PDF skips secondary OCR when first-page ownership is complete', async () => {
	let calls = 0
	const result = await scannedPdfToText(Buffer.from('%PDF synthetic'), dependencies({
		firstPageText: `姓名：测试甲证件号码：${identity}`,
		recognize: async () => {
			calls += 1
			return null
		}
	}))

	assert.equal(calls, 0)
	assert.equal(result.ownershipRescued, false)
	assert.equal(result.ownershipVerified, true)
	assert.match(result.text, /姓名：测试甲/)
})

test('scanned PDF invokes secondary OCR once and merges only exact first-page evidence', async () => {
	let calls = 0
	const result = await scannedPdfToText(Buffer.from('%PDF synthetic'), dependencies({
		firstPageText: `证件号码：${identity}`,
		recognize: async (imageBuffer) => {
			calls += 1
			assert.ok(Buffer.isBuffer(imageBuffer))
			return {
				name: '测试甲',
				fullId: identity,
				nameConfidence: 0.99,
				identityConfidence: 0.99
			}
		}
	}))

	assert.equal(calls, 1)
	assert.equal(result.ownershipRescued, true)
	assert.equal(result.ownershipVerified, true)
	assert.match(result.text, /姓名：测试甲/)
})

test('scanned PDF stops before analysis when first-page ownership remains incomplete', async () => {
	await assert.rejects(
		() => scannedPdfToText(Buffer.from('%PDF synthetic'), dependencies({
			firstPageText: '首页身份区域无法识别',
			secondPageText: `第二页业务明细证件号码：${identity}`,
			recognize: async () => ({
				name: '测试甲',
				fullId: identity,
				nameConfidence: 0.99,
				identityConfidence: 0.99
			})
		})),
		(err) => err && err.code === 'OCR_INCOMPLETE' && err.reason === 'ownership'
	)
})

test('scanned PDF streams rendered pages with bounded OCR concurrency and stable page order', async () => {
	let active = 0
	let maximumActive = 0
	const total = 5
	const result = await scannedPdfToText(Buffer.from('%PDF synthetic'), {
		iteratePdfPagesToPngBase64: async function* () {
			for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
				yield {
					total,
					pageNumber,
					base64: Buffer.from(`page-${pageNumber}`).toString('base64')
				}
			}
		},
		renderPdfPageToPngBase64: async (_buffer, pageNumber) => ({
			total,
			pageNumber,
			base64: Buffer.from(`page-${pageNumber}`).toString('base64')
		}),
		ocrRenderedPdfPageToText: async (_image, pageNumber) => {
			active += 1
			maximumActive = Math.max(maximumActive, active)
			await new Promise((resolve) => setTimeout(resolve, pageNumber % 2 ? 8 : 2))
			active -= 1
			return pageNumber === 1
				? `姓名：测试甲证件号码：${identity}`
				: `第${pageNumber}页业务明细`
		},
		recognizeFirstPageOwnership: async () => null
	})

	assert.equal(maximumActive, 3)
	assert.equal(result.rendered, total)
	assert.equal(result.total, total)
	assert.ok(result.text.indexOf('第2页业务明细') < result.text.indexOf('第5页业务明细'))
})

test('scanned PDF rejects missing, duplicate, and changing stream page metadata', async () => {
	const cases = [
		{
			name: 'missing page',
			pages: [
				{ total: 3, pageNumber: 1 },
				{ total: 3, pageNumber: 3 }
			],
			failedPages: [2]
		},
		{
			name: 'duplicate page',
			pages: [
				{ total: 3, pageNumber: 1 },
				{ total: 3, pageNumber: 1 }
			]
		},
		{
			name: 'changing total',
			pages: [
				{ total: 3, pageNumber: 1 },
				{ total: 4, pageNumber: 2 }
			]
		}
	]

	for (const scenario of cases) {
		await assert.rejects(
			() => scannedPdfToText(Buffer.from('%PDF synthetic'), {
				iteratePdfPagesToPngBase64: async function* () {
					for (const page of scenario.pages) {
						yield {
							...page,
							base64: Buffer.from(`page-${page.pageNumber}`).toString('base64')
						}
					}
				},
				ocrRenderedPdfPageToText: async (_image, pageNumber) => pageNumber === 1
					? `姓名：测试甲证件号码：${identity}`
					: `第${pageNumber}页业务明细`,
				recognizeFirstPageOwnership: async () => null
			}),
			(error) => {
				assert.equal(error && error.code, 'OCR_INCOMPLETE', scenario.name)
				assert.equal(error && error.reason, 'pages', scenario.name)
				assert.equal(error && error.totalPages, 3, scenario.name)
				if (scenario.failedPages) {
					assert.deepEqual(error.failedPages, scenario.failedPages, scenario.name)
				}
				return true
			}
		)
	}
})

test('scanned PDF settles pending OCR before returning a renderer failure', async () => {
	let active = 0
	let completed = 0
	const renderError = new Error('synthetic render failure')
	renderError.code = 'PDF_RENDER_FAILED'

	await assert.rejects(
		() => scannedPdfToText(Buffer.from('%PDF synthetic'), {
			iteratePdfPagesToPngBase64: async function* () {
				yield {
					total: 3,
					pageNumber: 1,
					base64: Buffer.from('page-1').toString('base64')
				}
				yield {
					total: 3,
					pageNumber: 2,
					base64: Buffer.from('page-2').toString('base64')
				}
				throw renderError
			},
			ocrRenderedPdfPageToText: async () => {
				active += 1
				try {
					await new Promise((resolve) => setTimeout(resolve, 20))
					return 'synthetic OCR text'
				} finally {
					active -= 1
					completed += 1
				}
			},
			recognizeFirstPageOwnership: async () => null
		}),
		(error) => error === renderError
	)

	assert.equal(active, 0)
	assert.equal(completed, 2)
})

test('scanned PDF maps renderer page-limit failures to a safe OCR_INCOMPLETE error', async () => {
	await assert.rejects(
		() => scannedPdfToText(Buffer.from('%PDF synthetic'), {
			iteratePdfPagesToPngBase64: async function* () {
				const error = new Error('too many pages')
				error.code = 'PDF_PAGE_LIMIT_EXCEEDED'
				error.total = 81
				error.maxPages = 80
				throw error
			},
			ocrRenderedPdfPageToText: async () => 'unused',
			recognizeFirstPageOwnership: async () => null
		}),
		(error) => error &&
			error.code === 'OCR_INCOMPLETE' &&
			error.reason === 'page-limit' &&
			error.totalPages === 81
	)
})

test('scanned PDF retries only the query page when numbered rows are structurally incomplete', async () => {
	const images = [
		Buffer.from('page-one').toString('base64'),
		Buffer.from('page-two').toString('base64'),
		Buffer.from('page-three').toString('base64')
	]
	let pageTwoCalls = 0
	const result = await scannedPdfToText(Buffer.from('%PDF synthetic'), {
		renderPdfToPngBase64: async () => ({ total: 3, images }),
		ocrRenderedPdfPageToText: async (_image, pageNo) => {
			if (pageNo === 1) return `姓名：测试甲证件号码：${identity}`
			if (pageNo === 2) {
				pageTwoCalls += 1
				return pageTwoCalls === 1
					? [
						'机构查询记录明细',
						'1 2026年6月1日 甲银行 贷款审批',
						'2 2026年5月1日 乙银行 无法识别的原因',
						'3 2026年4月1日 丙银行 贷后管理'
					].join('\n')
					: [
						'机构查询记录明细',
						'1 2026年6月1日 甲银行 贷款审批',
						'2 2026年5月1日 乙银行 信用卡审批',
						'3 2026年4月1日 丙银行 贷后管理'
					].join('\n')
			}
			return [
				'个人查询记录明细',
				'1 2026年4月1日 本人 本人查询（自助查询机）'
			].join('\n')
		},
		recognizeFirstPageOwnership: async () => null
	})

	assert.equal(pageTwoCalls, 3)
	assert.equal(result.queryEvidence.query_details_total, 3)
	assert.equal(result.queryEvidence.query_details.length, 3)
	assert.equal(result.queryEvidence.query_details[1].reason, '信用卡审批')
	assert.equal(result.rendered, 3)
})

test('query-page evidence trusts the complete two-pass consensus instead of a single initial OCR row', async () => {
	const images = [
		Buffer.from('page-one').toString('base64'),
		Buffer.from('page-two').toString('base64'),
		Buffer.from('page-three').toString('base64')
	]
	let pageTwoCalls = 0
	const result = await scannedPdfToText(Buffer.from('%PDF synthetic'), {
		renderPdfToPngBase64: async () => ({ total: 3, images }),
		ocrRenderedPdfPageToText: async (_image, pageNo) => {
			if (pageNo === 1) return `姓名：测试甲证件号码：${identity}`
			if (pageNo === 2) {
				pageTwoCalls += 1
				return pageTwoCalls === 1
					? [
						'机构查询记录明细',
						'1 2026年6月1日 甲银行 贷款审批',
						'2 2026年5月1日 乙银行 无法识别的原因',
						'3 2026年4月1日 丙银行 贷后管理'
					].join('\n')
					: [
						'机构查询记录明细',
						'1 2026年6月1日 被改动的银行 贷款审批',
						'2 2026年5月1日 乙银行 信用卡审批',
						'3 2026年4月1日 丙银行 贷后管理'
					].join('\n')
			}
			return [
				'个人查询记录明细',
				'1 2026年4月1日 本人 本人查询（自助查询机）'
			].join('\n')
		},
		recognizeFirstPageOwnership: async () => null
	})

	assert.equal(pageTwoCalls, 3)
	assert.equal(result.queryEvidence.query_details.length, 3)
	assert.equal(result.queryEvidence.complete, true)
	assert.equal(result.queryEvidence.query_details[0].institution, '被改动的银行')
	assert.equal(result.queryEvidence.query_details[1].institution, '乙银行')
})

test('query-page rescue rejects two OCR passes that disagree about the missing row', async () => {
	const images = [
		Buffer.from('page-one').toString('base64'),
		Buffer.from('page-two').toString('base64'),
		Buffer.from('page-three').toString('base64')
	]
	let pageTwoCalls = 0
	const result = await scannedPdfToText(Buffer.from('%PDF synthetic'), {
		renderPdfToPngBase64: async () => ({ total: 3, images }),
		ocrRenderedPdfPageToText: async (_image, pageNo) => {
			if (pageNo === 1) return `姓名：测试甲证件号码：${identity}`
			if (pageNo === 2) {
				pageTwoCalls += 1
				const reason = pageTwoCalls === 1
					? '无法识别的原因'
					: pageTwoCalls === 2
						? '信用卡审批'
						: '贷款审批'
				return [
					'机构查询记录明细',
					'1 2026年6月1日 甲银行 贷款审批',
					`2 2026年5月1日 乙银行 ${reason}`,
					'3 2026年4月1日 丙银行 贷后管理'
				].join('\n')
			}
			return [
				'个人查询记录明细',
				'1 2026年4月1日 本人 本人查询（自助查询机）'
			].join('\n')
		},
		recognizeFirstPageOwnership: async () => null
	})

	assert.equal(pageTwoCalls, 3)
	assert.equal(result.queryEvidence.complete, false)
	assert.equal(result.queryEvidence.reason, 'two-pass-query-consensus-mismatch')
	assert.deepEqual(result.queryEvidence.query_details, [])
})

test('query evidence verifies every page across a table longer than four pages', async () => {
	const total = 8
	const images = Array.from(
		{ length: total },
		(_value, index) => Buffer.from(`page-${index + 1}`).toString('base64')
	)
	const calls = new Map()
	const stablePageText = (pageNo) => {
		if (pageNo === 1) return `姓名：测试甲证件号码：${identity}`
		if (pageNo === 8) return '本 人 查 询 记 录 明 细'
		const seq = pageNo - 1
		return [
			pageNo === 2 ? '机 构 查 询 记 录 明 细' : '',
			`${seq}2026.${String(7 - seq).padStart(2, '0')}.01 第${seq}银行 贷款审批`
		].filter(Boolean).join('\n')
	}
	const result = await scannedPdfToText(Buffer.from('%PDF synthetic'), {
		renderPdfToPngBase64: async () => ({ total, images }),
		ocrRenderedPdfPageToText: async (_image, pageNo) => {
			const count = (calls.get(pageNo) || 0) + 1
			calls.set(pageNo, count)
			if (count === 1 && pageNo === 4) {
				return '3 2026.04.01 第3银行 无法识别的原因'
			}
			if (count === 1 && pageNo === 5) {
				return '3 2026 年 03 月 01 日 重复序号银行 贷款审批'
			}
			return stablePageText(pageNo)
		},
		recognizeFirstPageOwnership: async () => null
	})

	assert.equal(result.queryEvidence.complete, true)
	assert.equal(result.queryEvidence.query_details_total, 6)
	assert.deepEqual(result.queryEvidence.query_details.map((row) => row.seq), [1, 2, 3, 4, 5, 6])
	assert.equal(calls.get(1), 1)
	for (let pageNo = 2; pageNo <= 8; pageNo += 1) assert.equal(calls.get(pageNo), 3)
})
