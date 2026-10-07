import assert from 'node:assert/strict'
import { describe, it, afterEach } from 'node:test'

const originalWindow = globalThis.window

afterEach(() => {
	if (originalWindow === undefined) {
		delete globalThis.window
	} else {
		globalThis.window = originalWindow
	}
})

const loadProxy = async () => import(`../src/config/proxy.js?case=${Date.now()}-${Math.random()}`)

describe('proxy url resolution', () => {
	it('keeps the built-in API base outside local web preview', async () => {
		delete globalThis.window
		const { buildProxyApiUrl, PROXY_BASE } = await loadProxy()

		assert.equal(PROXY_BASE, 'http://127.0.0.1:3200/legacy-api')
		assert.equal(buildProxyApiUrl('/api/user/login'), 'http://127.0.0.1:3200/legacy-api/api/user/login')
	})

	it('uses same-origin API paths for LAN phone preview', async () => {
		globalThis.window = {
			location: new URL('http://192.168.31.232:8910/#/pages/login/index')
		}
		const { buildProxyApiUrl, isLocalWebPreviewRuntime } = await loadProxy()

		assert.equal(isLocalWebPreviewRuntime(), true)
		assert.equal(buildProxyApiUrl('/api/user/login'), '/api/user/login')
		assert.equal(buildProxyApiUrl('/user/register'), '/api/user/register')
	})

	it('uses same-origin API paths for public preview tunnels', async () => {
		globalThis.window = {
			location: new URL('https://mas-personal-pdas-fires.trycloudflare.com/#/pages/report/upload')
		}
		const { buildProxyApiUrl, isLocalWebPreviewRuntime } = await loadProxy()

		assert.equal(isLocalWebPreviewRuntime(), true)
		assert.equal(buildProxyApiUrl('/api/analyze'), '/api/analyze')
	})

	it('does not treat bare localhost without a preview port as Vite preview', async () => {
		globalThis.window = {
			location: new URL('http://localhost/#/pages/login/index')
		}
		const { buildProxyApiUrl, isLocalWebPreviewRuntime } = await loadProxy()

		assert.equal(isLocalWebPreviewRuntime(), false)
		assert.equal(buildProxyApiUrl('/api/user/login'), 'http://127.0.0.1:3200/legacy-api/api/user/login')
	})

	it('keeps the production HTTP gate for non-loopback gateways while allowing the local default', async () => {
		delete globalThis.window
		const originalProd = globalThis.__RPT_PROD__
		const originalBase = globalThis.__RPT_PROXY_BASE__
		globalThis.__RPT_PROD__ = true
		try {
			globalThis.__RPT_PROXY_BASE__ = 'http://127.0.0.1:3200/legacy-api'
			const loopback = await loadProxy()
			assert.equal(loopback.getProxyBaseMisconfigReason(), '')

			globalThis.__RPT_PROXY_BASE__ = 'http://gateway.invalid/legacy-api'
			const publicHttp = await loadProxy()
			assert.match(publicHttp.getProxyBaseMisconfigReason(), /生产构建禁止使用 HTTP 网关/)

			globalThis.__RPT_PROXY_BASE__ = 'https://gateway.invalid/legacy-api'
			const publicHttps = await loadProxy()
			assert.equal(publicHttps.getProxyBaseMisconfigReason(), '')
		} finally {
			if (originalProd === undefined) delete globalThis.__RPT_PROD__
			else globalThis.__RPT_PROD__ = originalProd
			if (originalBase === undefined) delete globalThis.__RPT_PROXY_BASE__
			else globalThis.__RPT_PROXY_BASE__ = originalBase
		}
	})
})
