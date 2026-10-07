export const TEACHER_REALTIME_POLL_MS = 15000

const FRESH_WINDOW_MS = 45000

const SOURCE_TEXT = {
	'teacher-workbench': '老师端接口',
	'teacher-clients': '老师端接口',
	'teacher-tasks': '老师端接口',
	'teacher-client-detail': '老师端接口',
	'advisor-contacts': '顾问记录',
	'advisor-my': '顾问工作台',
	none: '无数据'
}

export const DEFAULT_TEACHER_SYNC_META = Object.freeze({
	state: 'idle',
	label: '待同步',
	source: '',
	sourceText: '',
	timeText: '',
	updatedText: '',
	fetchedAt: 0,
	updatedAt: 0,
	isComplete: false,
	isRealtime: false,
	missingFields: [],
	errorCount: 0
})

const toTs = (value) => {
	if (value == null || value === '') return 0
	if (typeof value === 'number' && Number.isFinite(value)) return value
	const d = new Date(value)
	const ts = d.getTime()
	return Number.isFinite(ts) ? ts : 0
}

const uniqueStrings = (list) => {
	const out = []
	const seen = new Set()
	for (const item of Array.isArray(list) ? list : []) {
		const s = String(item || '').trim()
		if (!s || seen.has(s)) continue
		seen.add(s)
		out.push(s)
	}
	return out
}
const asObject = (value) => (value && typeof value === 'object' ? value : {})
const asList = (value) => {
	if (!value) return []
	if (Array.isArray(value)) return value
	if (Array.isArray(value.list)) return value.list
	if (Array.isArray(value.records)) return value.records
	if (Array.isArray(value.items)) return value.items
	if (Array.isArray(value.data)) return value.data
	if (value.data && typeof value.data === 'object') return asList(value.data)
	return typeof value === 'object' ? [value] : []
}
const pickFirst = (...values) => values.find((value) => value !== undefined && value !== null && value !== '')
const hasAny = (...values) => values.some((value) => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0))
const toStringList = (value) => uniqueStrings(Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[、,，;；\s]+/) : [])
const compactPath = (prefix, field) => [prefix, field].filter(Boolean).join('.')
const maxTs = (...values) => values.reduce((latest, value) => Math.max(latest, toTs(value)), 0)

const writebackContainersOf = (raw) => [
	asObject(raw.writebacks),
	asObject(raw.userWritebacks),
	asObject(raw.syncWritebacks),
	asObject(raw.sync),
	asObject(raw.context && raw.context.writebacks)
].filter((item) => Object.keys(item).length)

const listFromKeys = (raw, keys = []) => {
	const root = asObject(raw)
	const containers = [root, ...writebackContainersOf(root)]
	return containers.flatMap((container) => keys.flatMap((key) => asList(container[key])))
}

const canonicalWritebackKind = (value) => {
	const text = String(value || '').trim().toLowerCase()
	if (!text) return ''
	if (/material|材料/.test(text)) return 'materialSubmit'
	if (/message|receipt|action|消息|回执/.test(text)) return 'messageAction'
	if (/push|binding|device|推送|绑定/.test(text)) return 'pushBinding'
	return ''
}

const expectedWritebackKindsOf = (raw, options = {}) => {
	const explicit = [
		options.requiredKinds,
		raw.requiredWritebacks,
		raw.expectedWritebacks,
		raw.writebackRequirements,
		raw.syncRequirements,
		raw.requiredSyncKinds
	].flatMap((item) => Array.isArray(item) ? item : typeof item === 'string' ? item.split(/[、,，;；\s]+/) : [])
	const fromBooleans = []
	if (raw.materialSubmitRequired || raw.requireMaterialSubmit) fromBooleans.push('materialSubmit')
	if (raw.messageActionRequired || raw.requireMessageAction) fromBooleans.push('messageAction')
	if (raw.pushBindingRequired || raw.requirePushBinding) fromBooleans.push('pushBinding')
	return uniqueStrings([...explicit, ...fromBooleans].map(canonicalWritebackKind).filter(Boolean))
}

const submittedMaterialEvidence = (item) => {
	const raw = asObject(item)
	const status = String(pickFirst(raw.status, raw.state, raw.uploadStatus, '')).toLowerCase()
	const statusText = String(pickFirst(raw.statusText, raw.stateText, '')).trim()
	return hasAny(raw.uploadUrl, raw.url, raw.fileUrl, raw.fileName, raw.uploadedAt, raw.uploadTime, raw.submittedAt) ||
		['uploaded', 'submitted', 'reviewing', 'pending_review', 'confirmed', 'approved', 'rejected'].includes(status) ||
		['待确认', '已确认', '需重传'].includes(statusText)
}

const normalizeMaterialWriteback = (item = {}) => {
	const raw = asObject(item.payload || item.material || item)
	const id = pickFirst(raw.materialId, raw.id, raw.key, raw.code, '')
	const name = pickFirst(raw.materialName, raw.name, raw.title, raw.label, raw.documentName, '')
	const status = pickFirst(raw.status, raw.state, raw.uploadStatus, raw.statusText, raw.stateText, '')
	const uploadUrl = pickFirst(raw.uploadUrl, raw.url, raw.fileUrl, '')
	const fileName = pickFirst(raw.fileName, raw.nameOnDisk, raw.uploadName, '')
	const uploadedAt = pickFirst(raw.uploadedAt, raw.uploadTime, raw.submittedAt, raw.submitTime, raw.updatedAt, raw.updateTime, '')
	const missing = []
	if (!id && !name) missing.push('materialIdOrName')
	if (!status) missing.push('status')
	if (!hasAny(uploadUrl, fileName, uploadedAt)) missing.push('uploadProof')
	return {
		id,
		name,
		status,
		uploadUrl,
		fileName,
		uploadedAt,
		latestAt: maxTs(uploadedAt, raw.reviewedAt, raw.reviewTime, raw.updatedAt, raw.updateTime),
		missingFields: missing,
		isComplete: missing.length === 0
	}
}

const normalizeMessageActionWriteback = (item = {}) => {
	const raw = asObject(item.payload || item.receipt || item.actionReceipt || item.reviewReceipt || item)
	const id = pickFirst(raw.messageId, raw.id, raw.receiptId, raw.executionRecordId, '')
	const stage = pickFirst(raw.stage, raw.actionStage, raw.reviewAckStage, raw.ackStage, raw.status, '')
	const actionAt = pickFirst(raw.handledAt, raw.landedAt, raw.openedAt, raw.actionAt, raw.reviewAcknowledgedAt, raw.reviewAckAt, raw.acknowledgedAt, raw.updatedAt, raw.updateTime, raw.createdAt, '')
	const missing = []
	if (!id) missing.push('messageId')
	if (!stage) missing.push('stage')
	if (!actionAt) missing.push('actionAt')
	return {
		id,
		stage,
		actionAt,
		latestAt: maxTs(actionAt),
		missingFields: missing,
		isComplete: missing.length === 0
	}
}

const debtExecutionActionEvidence = (item = {}) => {
	const raw = asObject(item.payload || item.reviewReceipt || item)
	return hasAny(raw.reviewAcknowledgedAt, raw.reviewAckAt, raw.acknowledgedAt, raw.reviewAckStage, raw.ackStage)
}

const normalizePushBindingWriteback = (item = {}) => {
	const raw = asObject(item.binding || item.payload || item.pushBinding || item)
	const status = pickFirst(raw.status, raw.permissionStatus, raw.permission, '')
	const platform = pickFirst(raw.platform, raw.source, '')
	const clientId = pickFirst(raw.clientId, raw.clientid, raw.cid, raw.pushClientId, raw.push_client_id, '')
	const deviceId = pickFirst(raw.deviceId, raw.deviceID, raw.device_id, raw.udid, '')
	const templateIds = toStringList(pickFirst(raw.templateIds, raw.tmplIds, raw.templates, []))
	const updatedAt = pickFirst(raw.updatedAt, raw.updateTime, raw.boundAt, raw.syncedAt, '')
	const normalizedStatus = String(status || '').toLowerCase()
	const normalizedPlatform = String(platform || '').toLowerCase()
	const missing = []
	if (!status) missing.push('status')
	if (!platform) missing.push('platform')
	if (normalizedStatus === 'granted' && normalizedPlatform === 'browser' && !updatedAt) missing.push('updatedAt')
	return {
		status,
		platform,
		clientId,
		deviceId,
		templateIds,
		latestAt: maxTs(updatedAt),
		missingFields: missing,
		isComplete: missing.length === 0
	}
}

const summarizeWritebackItems = (items, normalizer, kind) => {
	const normalized = (Array.isArray(items) ? items : []).map(normalizer)
	const missingFields = normalized.flatMap((item, index) => item.missingFields.map((field) => `${kind}[${index}].${field}`))
	return {
		total: normalized.length,
		complete: normalized.filter((item) => item.isComplete).length,
		incomplete: normalized.filter((item) => !item.isComplete).length,
		latestAt: latestTimestampFromItems(normalized),
		missingFields,
		items: normalized
	}
}

export function buildUserWritebackSyncSummary(payload = {}, options = {}) {
	const raw = asObject(payload)
	const debtExecutionCandidates = listFromKeys(raw, ['debtProofs', 'debtProofSubmits', 'debtExecutionRecords'])
	const materialCandidates = [
		...listFromKeys(raw, ['materialSubmits', 'materialSubmit', 'materialSubmissions', 'userMaterialSubmits']),
		...debtExecutionCandidates,
		...(Array.isArray(options.materials) ? options.materials.filter(submittedMaterialEvidence) : [])
	]
	const messageCandidates = [
		...listFromKeys(raw, ['messageActionReceipts', 'messageActionReceipt', 'actionReceipts', 'actionReceipt', 'messageReceipts', 'messageReceipt', 'latestMessageActionReceipt', 'latestActionReceipt']),
		...debtExecutionCandidates.filter(debtExecutionActionEvidence)
	]
	const pushCandidates = [
		...listFromKeys(raw, ['pushBindings', 'pushBinding', 'systemPushBindings', 'systemPushBinding', 'notificationBindings', 'notificationBinding']),
		...listFromKeys(asObject(raw.user), ['pushBindings', 'pushBinding', 'systemPushBinding']),
		...listFromKeys(asObject(raw.clientInfo), ['pushBindings', 'pushBinding', 'systemPushBinding']),
		...listFromKeys(asObject(raw.customer), ['pushBindings', 'pushBinding', 'systemPushBinding'])
	]
	const groups = {
		materialSubmit: summarizeWritebackItems(materialCandidates, normalizeMaterialWriteback, 'materialSubmit'),
		messageAction: summarizeWritebackItems(messageCandidates, normalizeMessageActionWriteback, 'messageAction'),
		pushBinding: summarizeWritebackItems(pushCandidates, normalizePushBindingWriteback, 'pushBinding')
	}
	const requiredKinds = expectedWritebackKindsOf(raw, options)
	const requiredMissing = requiredKinds
		.filter((kind) => groups[kind] && groups[kind].total === 0)
		.map((kind) => `${kind}.required`)
	const missingFields = uniqueStrings([
		...groups.materialSubmit.missingFields,
		...groups.messageAction.missingFields,
		...groups.pushBinding.missingFields,
		...requiredMissing
	])
	const latestAt = latestTimestampFromItems([
		{ updatedAt: groups.materialSubmit.latestAt },
		{ updatedAt: groups.messageAction.latestAt },
		{ updatedAt: groups.pushBinding.latestAt }
	])
	const total = groups.materialSubmit.total + groups.messageAction.total + groups.pushBinding.total
	return {
		hasWritebacks: total > 0 || requiredKinds.length > 0,
		isComplete: missingFields.length === 0,
		latestAt,
		missingFields,
		materialSubmit: groups.materialSubmit,
		messageAction: groups.messageAction,
		pushBinding: groups.pushBinding,
		counts: {
			materialSubmit: groups.materialSubmit.total,
			messageAction: groups.messageAction.total,
			pushBinding: groups.pushBinding.total,
			incomplete: groups.materialSubmit.incomplete + groups.messageAction.incomplete + groups.pushBinding.incomplete
		}
	}
}

export function collectUserWritebackMissing(items, scope = 'items') {
	if (!Array.isArray(items)) return []
	return uniqueStrings(items.flatMap((item, index) => {
		const summary = item && item.writebackSummary ? item.writebackSummary : buildUserWritebackSyncSummary(item)
		if (!summary || !summary.hasWritebacks) return []
		return summary.missingFields.map((field) => compactPath(`${scope}[${index}].writebacks`, field))
	}))
}

export const formatTeacherSyncClock = (value) => {
	const ts = toTs(value)
	if (!ts) return ''
	const d = new Date(ts)
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

export function buildTeacherSyncMeta(options = {}) {
	const now = toTs(options.now) || Date.now()
	const fetchedAt = toTs(options.fetchedAt) || now
	const updatedAt = toTs(options.updatedAt)
	const source = String(options.source || '').trim()
	const missingFields = uniqueStrings(options.missingFields)
	const errors = Array.isArray(options.errors) ? options.errors : []
	const hasSource = !!source && source !== 'none'
	const isComplete = hasSource && missingFields.length === 0
	const isFresh = fetchedAt > 0 && (now - fetchedAt) <= FRESH_WINDOW_MS
	let state = 'idle'
	if (!hasSource) state = 'offline'
	else if (!isComplete) state = 'incomplete'
	else if (isFresh) state = 'live'
	else state = 'stale'

	const labelMap = {
		idle: '待同步',
		offline: '同步失败',
		incomplete: '数据不完整',
		live: '实时同步',
		stale: '等待同步'
	}

	return {
		state,
		label: labelMap[state] || labelMap.idle,
		source,
		sourceText: SOURCE_TEXT[source] || (hasSource ? '实时数据源' : ''),
		timeText: fetchedAt ? `${formatTeacherSyncClock(fetchedAt)} 同步` : '',
		updatedText: updatedAt ? `${formatTeacherSyncClock(updatedAt)} 更新` : '',
		fetchedAt,
		updatedAt,
		isComplete,
		isRealtime: isComplete && isFresh,
		missingFields,
		errorCount: errors.length
	}
}

export function collectRequiredMissing(items, requiredFields, scope) {
	if (!Array.isArray(items)) return [`${scope || 'items'}.list`]
	const missing = []
	items.forEach((item, index) => {
		const row = item && typeof item === 'object' ? item : {}
		requiredFields.forEach((field) => {
			const value = row[field]
			if (value == null || value === '') missing.push(`${scope || 'items'}[${index}].${field}`)
		})
	})
	return uniqueStrings(missing)
}

export function latestTimestampFromItems(items, extraCandidates = []) {
	let latest = 0
	const scan = (row) => {
		if (!row || typeof row !== 'object') return
		const candidates = [
			row.latestAt,
			row.latestMessageAt,
			row.latestMessage && row.latestMessage.createdAt,
			row.latestMessage && row.latestMessage.updateTime,
			row.latestMessage && row.latestMessage.updatedAt,
			row.updatedAt,
			row.updateTime,
			row.latestTime,
			row.lastTime,
			row.createdAt,
			row.createTime,
			row.time,
			row.raw && row.raw.updatedAt,
			row.raw && row.raw.updateTime,
			row.raw && row.raw.createdAt,
			row.raw && row.raw.createTime,
			row.writebackSummary && row.writebackSummary.latestAt
		]
		for (const value of candidates) {
			const ts = toTs(value)
			if (ts > latest) latest = ts
		}
	}
	if (Array.isArray(items)) items.forEach(scan)
	else scan(items)
	for (const value of Array.isArray(extraCandidates) ? extraCandidates : []) {
		const ts = toTs(value)
		if (ts > latest) latest = ts
	}
	return latest
}

export function startTeacherRealtimeRefresh(callback, options = {}) {
	if (typeof callback !== 'function' || typeof setInterval !== 'function') return () => {}
	const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : TEACHER_REALTIME_POLL_MS
	let active = true
	let busy = false
	const run = async () => {
		if (!active || busy) return
		if (typeof document !== 'undefined' && document.hidden) return
		busy = true
		try {
			await callback()
		} finally {
			busy = false
		}
	}
	const timer = setInterval(run, intervalMs)
	return () => {
		active = false
		clearInterval(timer)
	}
}

export default {
	TEACHER_REALTIME_POLL_MS,
	DEFAULT_TEACHER_SYNC_META,
	buildTeacherSyncMeta,
	collectRequiredMissing,
	buildUserWritebackSyncSummary,
	collectUserWritebackMissing,
	latestTimestampFromItems,
	startTeacherRealtimeRefresh
}
