const toPlainQuery = (query) => {
	const normalized = {}
	Object.keys(query || {}).forEach((key) => {
		const value = query[key]
		normalized[key] = Array.isArray(value) ? value[value.length - 1] : value
	})
	return normalized
}

const readCurrentPageOptions = () => {
	try {
		if (typeof getCurrentPages !== 'function') return {}
		const pages = getCurrentPages()
		const current = pages && pages.length ? pages[pages.length - 1] : null
		return current?.options || current?.$page?.options || current?.$vm?.$page?.options || {}
	} catch (e) {
		return {}
	}
}

const readHashQuery = () => {
	try {
		const hash = String(globalThis?.location?.hash || '')
		const queryIndex = hash.indexOf('?')
		if (queryIndex < 0) return {}
		const search = hash.slice(queryIndex + 1)
		const query = {}
		new URLSearchParams(search).forEach((value, key) => {
			query[key] = value
		})
		return query
	} catch (e) {
		return {}
	}
}

export const mergeH5RouteOptions = (options = {}) => {
	const direct = toPlainQuery(options)
	if (Object.keys(direct).length) return direct
	const hashQuery = toPlainQuery(readHashQuery())
	if (Object.keys(hashQuery).length) return hashQuery
	const pageOptions = toPlainQuery(readCurrentPageOptions())
	if (Object.keys(pageOptions).length) return pageOptions
	return {}
}

export const decodeMaybeTwice = (value) => {
	let text = value == null ? '' : String(value)
	for (let i = 0; i < 2; i++) {
		try {
			const decoded = decodeURIComponent(text)
			if (decoded === text) break
			text = decoded
		} catch (e) {
			break
		}
	}
	return text
}
