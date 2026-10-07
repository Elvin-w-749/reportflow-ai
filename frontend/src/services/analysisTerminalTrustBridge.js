let trustedJobReader = () => null
let installed = false

// The server-job WeakSet stays private to analysisTaskService. This bridge only
// exposes its read-only projection to uploadFailure; it cannot add an arbitrary
// object to that WeakSet or recreate trust after JSON/clone/localStorage.
export function installTrustedAnalysisJobReader(reader) {
	if (installed || typeof reader !== 'function') throw new Error('trusted analysis job reader already installed')
	trustedJobReader = reader
	installed = true
}

export function readTrustedAnalysisJobContext(value) {
	return trustedJobReader(value)
}
