'use strict'

const RELEASE_BASE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/
const API_RELEASE_RE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,95})-([0-9a-f]{7})-api$/
const GIT_COMMIT_RE = /^[0-9a-f]{40}$/
const FORBIDDEN_RELEASE_CONTEXT = /(?:private|customer|phone|idcard|identity|token|secret|credential|password|filepath|file_path)/i
const PHONE_LIKE = /(?:^|[^0-9])1[3-9][0-9]{9}(?:[^0-9]|$)/
const LONG_ACCOUNT_LIKE = /[0-9]{12,}/

function validReleaseBaseId(value) {
	if (typeof value !== 'string' || !RELEASE_BASE_RE.test(value)) return false
	if (value.includes('..') || FORBIDDEN_RELEASE_CONTEXT.test(value)) return false
	if (PHONE_LIKE.test(value) || LONG_ACCOUNT_LIKE.test(value)) return false
	return true
}

function resolveApiReleaseIdentity(releaseId, gitCommit) {
	if (typeof releaseId !== 'string' || typeof gitCommit !== 'string') {
		return { id: null, gitCommit: null }
	}
	const normalizedId = releaseId.trim()
	const normalizedCommit = gitCommit.trim().toLowerCase()
	const match = normalizedId.match(API_RELEASE_RE)
	if (
		!match || !validReleaseBaseId(match[1]) || !GIT_COMMIT_RE.test(normalizedCommit) ||
		match[2] !== normalizedCommit.slice(0, 7)
	) return { id: null, gitCommit: null }
	return { id: normalizedId, gitCommit: normalizedCommit }
}

module.exports = {
	RELEASE_BASE_RE,
	API_RELEASE_RE,
	GIT_COMMIT_RE,
	validReleaseBaseId,
	resolveApiReleaseIdentity
}
