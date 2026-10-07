'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

// Importing the app does not bind the production port because server.js guards
// app.listen with require.main === module.
const { app } = require('../server.js')

test('every legacy API response carries the isolated service-line identity', async (t) => {
	const server = app.listen(0, '127.0.0.1')
	await new Promise((resolve, reject) => {
		server.once('listening', resolve)
		server.once('error', reject)
	})
	t.after(() => new Promise((resolve) => server.close(resolve)))

	const address = server.address()
	const response = await fetch(`http://127.0.0.1:${address.port}/__identity_probe__`, {
		redirect: 'error'
	})

	assert.equal(response.status, 404)
	assert.equal(response.headers.get('x-rpt-service-line'), 'legacy-isolated-v20260722')
})
