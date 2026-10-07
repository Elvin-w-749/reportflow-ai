import { after, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

const originalUni = globalThis.uni
let uploadCall = null

globalThis.uni = {
	getStorageSync: (key) => key === 'auth_token' ? 'test-token' : '',
	setStorageSync: () => {},
	removeStorageSync: () => {},
	getStorageInfoSync: () => ({ keys: [] }),
	uploadFile: (options) => {
		uploadCall = options
		return { abort: () => {} }
	}
}

const server = await createServer({
	mode: 'production',
	define: { __RPT_PROD__: 'true' },
	server: { middlewareMode: true },
	appType: 'custom',
	logLevel: 'silent'
})
const { parsePDF } = await server.ssrLoadModule('/src/services/pdfParser.js')

const pdfBlob = () => new Blob(['%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF'], { type: 'application/pdf' })

const waitForUploadCall = async () => {
	for (let i = 0; i < 20 && !uploadCall; i += 1) {
		await new Promise((resolve) => setImmediate(resolve))
	}
	assert.ok(uploadCall, 'expected multipart upload to start')
	return uploadCall
}

beforeEach(() => {
	uploadCall = null
})

after(async () => {
	await server.close()
	if (originalUni === undefined) delete globalThis.uni
	else globalThis.uni = originalUni
})

describe('legacy PDF multipart transport classification', () => {
	it('preserves a real HTTP 413 as the only upload-limit signal', async () => {
		const pending = parsePDF(pdfBlob()).then(() => null, (error) => error)
		const call = await waitForUploadCall()
		call.success({ statusCode: 413, data: '<html>Request Entity Too Large</html>' })
		const error = await pending
		assert.equal(error.httpStatus, 413)
		assert.equal(error.statusCode, 413)
		assert.equal(error.transportKind, 'http')
		assert.match(error.message, /上传上限过小/)
	})

	it('does not infer file-too-large from an HTML 502 body', async () => {
		const pending = parsePDF(pdfBlob()).then(() => null, (error) => error)
		const call = await waitForUploadCall()
		call.success({ statusCode: 502, data: '<html>Request Entity Too Large</html>' })
		const error = await pending
		assert.equal(error.httpStatus, 502)
		assert.equal(error.statusCode, 502)
		assert.equal(error.transportKind, 'http')
		assert.match(error.message, /PDF 解析服务异常/)
		assert.doesNotMatch(error.message, /文件过大|上传上限过小/)
	})
})
