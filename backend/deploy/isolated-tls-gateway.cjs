'use strict'

const fs = require('fs')
const http = require('http')
const https = require('https')
const path = require('path')

const HOST = String(process.env.GATEWAY_HOST || '0.0.0.0').trim() || '0.0.0.0'
const PORT = Number(process.env.GATEWAY_PORT || 8443)
const API_HOST = String(process.env.API_HOST || '127.0.0.1').trim() || '127.0.0.1'
const API_PORT = Number(process.env.API_PORT || 3200)
const TLS_KEY_PATH = path.resolve(String(process.env.TLS_KEY_PATH || ''))
const TLS_CERT_PATH = path.resolve(String(process.env.TLS_CERT_PATH || ''))
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 910000)

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('Invalid GATEWAY_PORT')
if (!Number.isInteger(API_PORT) || API_PORT < 1 || API_PORT > 65535) throw new Error('Invalid API_PORT')
if (!Number.isInteger(REQUEST_TIMEOUT_MS) || REQUEST_TIMEOUT_MS < 1000) {
	throw new Error('Invalid REQUEST_TIMEOUT_MS')
}
if (!TLS_KEY_PATH || !fs.existsSync(TLS_KEY_PATH)) throw new Error('TLS_KEY_PATH is missing')
if (!TLS_CERT_PATH || !fs.existsSync(TLS_CERT_PATH)) throw new Error('TLS_CERT_PATH is missing')

function isProxyPath(pathname) {
	return pathname === '/health' || pathname === '/api' || pathname.startsWith('/api/') || pathname === '/uploads' || pathname.startsWith('/uploads/')
}

function json(res, statusCode, body) {
	res.writeHead(statusCode, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff',
		'x-rpt-environment': 'legacy-isolated'
	})
	res.end(JSON.stringify(body))
}

function proxy(req, res, upstreamPath) {
	const headers = { ...req.headers }
	delete headers.connection
	delete headers['proxy-connection']
	headers.host = `${API_HOST}:${API_PORT}`
	headers['x-forwarded-proto'] = 'https'
	headers['x-forwarded-host'] = String(req.headers.host || '')
	headers['x-forwarded-for'] = String(req.socket.remoteAddress || '')

	const upstream = http.request(
		{ host: API_HOST, port: API_PORT, method: req.method, path: upstreamPath, headers },
		(upstreamRes) => {
			res.writeHead(upstreamRes.statusCode || 502, {
				...upstreamRes.headers,
				'x-rpt-environment': 'legacy-isolated'
			})
			upstreamRes.pipe(res)
		}
	)

	upstream.setTimeout(REQUEST_TIMEOUT_MS, () => upstream.destroy(new Error('isolated upstream timeout')))
	upstream.on('error', () => {
		if (res.headersSent) return res.destroy()
		json(res, 502, { code: 502, msg: 'isolated legacy backend unavailable' })
	})
	req.pipe(upstream)
}

const server = https.createServer(
	{
		key: fs.readFileSync(TLS_KEY_PATH),
		cert: fs.readFileSync(TLS_CERT_PATH),
		minVersion: 'TLSv1.2'
	},
	(req, res) => {
		let parsed
		try {
			parsed = new URL(req.url || '/', 'https://legacy-isolated.invalid')
		} catch {
			return json(res, 400, { code: 400, msg: 'bad request' })
		}

		if (parsed.pathname === '/legacy-gateway-health') {
			return json(res, 200, { ok: true, service: 'rpt-legacy-isolated-gateway' })
		}
		if (!isProxyPath(parsed.pathname)) return json(res, 404, { code: 404, msg: 'not found' })
		return proxy(req, res, `${parsed.pathname}${parsed.search}`)
	}
)

server.requestTimeout = REQUEST_TIMEOUT_MS
server.headersTimeout = REQUEST_TIMEOUT_MS + 10000
server.keepAliveTimeout = 75000
server.maxHeadersCount = 100
server.listen(PORT, HOST, () => {
	process.stdout.write(`legacy isolated TLS gateway listening on https://${HOST}:${PORT}; api=http://${API_HOST}:${API_PORT}\n`)
})
