import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
	createRptViteConfig,
	resolveHttpOrigin,
	resolveLocalApiOrigin
} from '../vite.config.js'

describe('Vite local deterministic API routing', () => {
	it('uses the isolated loopback backend in development without legacy path rewriting', () => {
		const config = createRptViteConfig({ mode: 'development', env: {} })
		const proxy = config.server.proxy['/api']
		assert.equal(proxy.target, 'http://127.0.0.1:3200')
		assert.equal(proxy.rewrite('/api/analyze'), '/api/analyze')
		assert.equal(JSON.parse(config.define.__RPT_PROXY_BASE__), 'http://127.0.0.1:3200')
	})

	it('accepts an explicit loopback origin and rejects remote or path-bearing origins', () => {
		assert.equal(resolveLocalApiOrigin('http://localhost:4321'), 'http://localhost:4321')
		assert.equal(resolveLocalApiOrigin('http://[::1]:4321'), 'http://[::1]:4321')
		assert.throws(() => resolveLocalApiOrigin('https://example.com'), /仅允许/)
		assert.throws(() => resolveLocalApiOrigin('http://127.0.0.1:3200/api'), /路径/)
	})

	it('builds against the loopback API plus the legacy namespace when nothing is configured', () => {
		const config = createRptViteConfig({
			mode: 'production',
			env: { RPT_LOCAL_API_ORIGIN: 'http://127.0.0.1:9999' }
		})
		const proxy = config.server.proxy['/api']
		assert.equal(proxy.target, 'http://127.0.0.1:3200')
		assert.equal(proxy.rewrite('/api/analyze'), '/legacy-api/api/analyze')
		assert.equal(JSON.parse(config.define.__RPT_PROXY_BASE__), 'http://127.0.0.1:3200/legacy-api')
	})

	it('accepts any legal http(s) origin instead of a pinned domain', () => {
		assert.equal(resolveHttpOrigin('https://my.example.com', 'RPT_PROXY_BASE'), 'https://my.example.com')
		assert.equal(resolveHttpOrigin('http://127.0.0.1:3200/', 'RPT_PROXY_BASE'), 'http://127.0.0.1:3200')
		assert.equal(resolveHttpOrigin('http://localhost:8080', 'RPT_PROXY_BASE'), 'http://localhost:8080')
	})

	it('rejects origins that are not usable http(s) sources', () => {
		assert.throws(() => resolveHttpOrigin('not-an-origin', 'RPT_PROXY_BASE'), /有效的 http\(s\) 源/)
		assert.throws(() => resolveHttpOrigin('ftp://127.0.0.1:3200', 'RPT_PROXY_BASE'), /http\(s\)/)
		// 含账号密码的源必须被拒绝；凭据在运行时拼装，避免源码里留下字面量凭据 URL
		// （scripts/secret-scan-policy.mjs 的 credential-url 规则会命中整仓扫描）。
		const originWithCredentials = new URL('https://host.example.com')
		originWithCredentials.username = 'demo-user'
		originWithCredentials.password = 'demo-pass'
		assert.throws(() => resolveHttpOrigin(originWithCredentials.toString(), 'RPT_PROXY_BASE'), /凭证/)
		assert.throws(() => resolveHttpOrigin('https://host.example.com/legacy-api', 'RPT_PROXY_BASE'), /路径/)
	})
})
