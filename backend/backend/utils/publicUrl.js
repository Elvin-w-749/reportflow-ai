'use strict'

const ALLOWED_UPLOAD_BASES = new Set(['/uploads', '/legacy-uploads'])

function normalizePublicUploadBase(value) {
	const raw = String(value || '').trim().replace(/\/+$/, '')
	return ALLOWED_UPLOAD_BASES.has(raw) ? raw : '/uploads'
}

function buildPublicUploadUrl({ protocol, host, filename, uploadBase } = {}) {
	const scheme = String(protocol || '').toLowerCase() === 'https' ? 'https' : 'http'
	const safeHost = String(host || '').trim().replace(/[\r\n]/g, '')
	if (!safeHost) throw new Error('public upload host is required')
	const safeFilename = encodeURIComponent(String(filename || '').trim())
	if (!safeFilename) throw new Error('public upload filename is required')
	return `${scheme}://${safeHost}${normalizePublicUploadBase(uploadBase)}/${safeFilename}`
}

module.exports = { normalizePublicUploadBase, buildPublicUploadUrl }
