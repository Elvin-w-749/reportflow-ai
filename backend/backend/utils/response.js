'use strict'

function ok(res, data = {}, message = 'ok') {
	return res.json({ code: 0, message, data })
}

function fail(res, code = 5000, message = 'failed', data = null, httpStatus = 200) {
	return res.status(httpStatus).json({ code, message, data })
}

module.exports = { ok, fail }
