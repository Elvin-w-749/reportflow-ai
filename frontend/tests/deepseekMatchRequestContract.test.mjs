import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const matchPageSource = readFileSync(resolve(__dirname, '../src/pages/match/Match.vue'), 'utf8')

const server = await createServer({
	mode: 'production',
	define: { __RPT_PROD__: 'true' },
	server: { middlewareMode: true },
	appType: 'custom',
	logLevel: 'silent'
})

const { buildMatchProductsRequest, matchProducts, normalizeMatchProductsResponse } = await server.ssrLoadModule('/src/services/deepseekService.js')

after(async () => {
	await server.close()
})

describe('remote product matching request contract', () => {
	it('sends only an explicit report id and supplement', () => {
		assert.deepEqual(
			buildMatchProductsRequest({ reportId: 'report-1', supplement: { monthlyIncome: 12000 } }),
			{ reportId: 'report-1', supplement: { monthlyIncome: 12000 } }
		)
		assert.deepEqual(
			buildMatchProductsRequest('report-2', { hasProperty: false }),
			{ reportId: 'report-2', supplement: { hasProperty: false } }
		)
	})

	it('rejects legacy report bodies before a network request can be built', () => {
		for (const input of [
			{ id: 'legacy-id', reportData: { report: 'private' } },
			{ reportId: 'report-1', reportData: { report: 'private' } },
			{ reportId: 'report-1', analysisData: { report: 'private' } },
			{ reportId: 'report-1', supplement: { analysisResult: { report: 'private' } } }
		]) {
			assert.throws(
				() => buildMatchProductsRequest(input),
				(error) => ['MATCH_REPORT_ID_REQUIRED', 'MATCH_REPORT_BODY_FORBIDDEN'].includes(error?.code)
			)
		}
	})

	it('rejects non-scalar request and response report ids without string coercion', () => {
		for (const malformed of [[], ['report-1'], {}, 0, true]) {
			assert.throws(
				() => buildMatchProductsRequest({ reportId: malformed }),
				(error) => error?.code === 'MATCH_REPORT_ID_REQUIRED'
			)
			const malformedResponse = normalizeMatchProductsResponse({
				reportId: malformed,
				evidenceVerified: true,
				decisionEligible: true,
				products: [{ id: 'forged' }]
			}, 'report-1')
			assert.equal(malformedResponse.evidenceVerified, false)
			assert.equal(malformedResponse.products.length, 0)

			const malformedExpected = normalizeMatchProductsResponse({
				reportId: 'report-1',
				evidenceVerified: true,
				decisionEligible: true,
				products: [{ id: 'forged' }]
			}, malformed)
			assert.equal(malformedExpected.evidenceVerified, false)
			assert.equal(malformedExpected.products.length, 0)
		}
	})

	it('keeps the complete server decision envelope and binds it to the requested report', () => {
		const trusted = normalizeMatchProductsResponse({
			success: true,
			reportId: 'report-1',
			evidenceVerified: true,
			decisionEligible: true,
			locked: false,
			materialGate: { unlocked: true },
			products: [{ id: 'product-1', matchRate: 88 }]
		}, 'report-1')
		assert.equal(trusted.evidenceVerified, true)
		assert.equal(trusted.decisionEligible, true)
		assert.equal(trusted.products.length, 1)

		for (const forged of [
			{ reportId: 'report-2', evidenceVerified: true, decisionEligible: true, products: [{ id: 'forged' }] },
			{ reportId: 'report-1', evidenceVerified: false, decisionEligible: true, products: [{ id: 'forged' }] },
			{ reportId: 'report-1', evidenceVerified: true, decisionEligible: false, products: [{ id: 'forged' }] }
		]) {
			const blocked = normalizeMatchProductsResponse(forged, 'report-1')
			assert.equal(blocked.decisionEligible, false)
			assert.equal(blocked.products.length, 0)
		}
	})

	it('rejects a product response after the authenticated account changes', async () => {
		const originalUni = globalThis.uni
		const storage = new Map([['auth_token', 'session-a']])
		globalThis.uni = {
			getStorageSync: (key) => storage.get(key) || '',
			setStorageSync: (key, value) => storage.set(key, value),
			removeStorageSync: (key) => storage.delete(key),
			getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
			request: (options) => {
				storage.set('auth_token', 'session-b')
				options.success({
					statusCode: 200,
					data: {
						success: true,
						reportId: 'report-1',
						evidenceVerified: true,
						decisionEligible: true,
						products: [{ id: 'must-not-cross-session' }]
					}
				})
			}
		}
		try {
			await assert.rejects(
				matchProducts({ reportId: 'report-1' }),
				(error) => error?.code === 'STALE_SESSION_RESPONSE' && error?.staleSession === true
			)
		} finally {
			globalThis.uni = originalUni
		}
	})

	it('uses only the owner-scoped server route on the product matching page', () => {
		assert.match(matchPageSource, /import \{ matchProducts \} from '@\/services\/deepseekService\.js'/)
		assert.match(matchPageSource, /await matchProducts\(\{ reportId: serverReportId \}\)/)
		assert.doesNotMatch(matchPageSource, /localMatchProductsWithDiagnostics/)
		assert.doesNotMatch(matchPageSource, /getProductDetailTemplate/)
		assert.match(matchPageSource, /features: Array\.isArray\(p\.features\)/)
		assert.match(matchPageSource, /p\.sourceNote/)
		assert.match(matchPageSource, /p\.eligibilityText/)
		assert.match(matchPageSource, /p\.requiredMaterials/)
	})

	it('fails closed when an explicitly selected report is no longer available', () => {
		assert.match(matchPageSource, /inspectMatchReportContext\(\)/)
		assert.match(matchPageSource, /inspected\.present && inspected\.invalid/)
		assert.match(matchPageSource, /return \{ report: null, context \}/)
		const pinnedBranch = matchPageSource.slice(
			matchPageSource.indexOf('const resolveMatchReport'),
			matchPageSource.indexOf('const serverReportIdOf')
		)
		assert.ok(pinnedBranch.indexOf('return { report: null, context }') < pinnedBranch.indexOf('getLatestReportAsync()'))
		assert.match(matchPageSource, /系统没有自动切换到其他客户或月份/)
	})

	it('drops a late product response after the active report changes', () => {
		assert.match(matchPageSource, /const generation = \+\+loadGeneration/)
		assert.match(matchPageSource, /generation !== loadGeneration \|\| serverReportIdOf\(activeReport\.value\) !== serverReportId/)
		const loadBlock = matchPageSource.slice(matchPageSource.indexOf('const load = async'), matchPageSource.indexOf('const useLatestReport'))
		assert.ok(loadBlock.indexOf('products.value = []') < loadBlock.indexOf('await resolveMatchReport()'))
	})
})
