'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const sharp = require('sharp')

const DEFAULT_TIMEOUT_MS = 45000
const DEFAULT_QUEUE_WAIT_MS = 10000
const DEFAULT_MAX_INPUT_BYTES = 12 * 1024 * 1024
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024
const DEFAULT_MAX_INPUT_PIXELS = 40 * 1000 * 1000
const MIN_CONFIDENCE_FLOOR = 0.9
const TRUSTED_MODEL_MANIFEST = path.join(__dirname, 'ocr', 'models.sha256')
const REQUIRED_MODEL_FILES = Object.freeze({
	RAPIDOCR_DET_MODEL: Object.freeze({
		name: 'PP-OCRv6_det_small.onnx',
		sha256: '090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f'
	}),
	RAPIDOCR_CLS_MODEL: Object.freeze({
		name: 'ch_ppocr_mobile_v2.0_cls_mobile.onnx',
		sha256: 'e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c'
	}),
	RAPIDOCR_REC_MODEL: Object.freeze({
		name: 'PP-OCRv6_rec_small.onnx',
		sha256: '6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884'
	})
})

function positiveInt(value, fallback) {
	const n = Number(value)
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function minimumConfidence(value) {
	const n = Number(value)
	return Number.isFinite(n) ? Math.max(MIN_CONFIDENCE_FLOOR, Math.min(1, n)) : MIN_CONFIDENCE_FLOOR
}

function isValidChineseIdentity(value) {
	const id = String(value || '').replace(/\s+/g, '').toUpperCase()
	if (!/^\d{17}[\dX]$/.test(id)) return false
	const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
	const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2']
	let sum = 0
	for (let index = 0; index < 17; index += 1) sum += Number(id[index]) * weights[index]
	return checks[sum % 11] === id[17]
}

function invalidResult() {
	const err = new Error('rapidocr-invalid-result')
	err.code = 'RAPIDOCR_INVALID_RESULT'
	return err
}

function modelIntegrityError() {
	const err = new Error('rapidocr-model-integrity-error')
	err.code = 'RAPIDOCR_MODEL_INTEGRITY_ERROR'
	return err
}

function configuredModelPaths(options = {}) {
	return {
		RAPIDOCR_DET_MODEL: String(options.detModel || process.env.RAPIDOCR_DET_MODEL || '').trim(),
		RAPIDOCR_CLS_MODEL: String(options.clsModel || process.env.RAPIDOCR_CLS_MODEL || '').trim(),
		RAPIDOCR_REC_MODEL: String(options.recModel || process.env.RAPIDOCR_REC_MODEL || '').trim()
	}
}

function parseModelManifest(value) {
	const entries = new Map()
	for (const rawLine of String(value || '').split(/\r?\n/)) {
		const line = rawLine.trim()
		if (!line) continue
		const match = line.match(/^([a-f0-9]{64})\s{2,}(.+)$/i)
		if (!match) throw modelIntegrityError()
		const fileName = match[2].trim()
		if (!fileName || path.basename(fileName) !== fileName || entries.has(fileName)) {
			throw modelIntegrityError()
		}
		entries.set(fileName, match[1].toLowerCase())
	}
	return entries
}

function sha256File(filePath) {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash('sha256')
		const stream = fs.createReadStream(filePath)
		stream.on('error', reject)
		stream.on('data', (chunk) => hash.update(chunk))
		stream.on('end', () => resolve(hash.digest('hex')))
	})
}

async function verifyModelFiles(options = {}) {
	const models = configuredModelPaths(options)
	const manifestPath = TRUSTED_MODEL_MANIFEST

	try {
		if (!path.isAbsolute(manifestPath) || Object.values(models).some((value) => !path.isAbsolute(value))) {
			throw modelIntegrityError()
		}
		const manifest = parseModelManifest(await fs.promises.readFile(manifestPath, 'utf8'))
		if (manifest.size !== Object.keys(REQUIRED_MODEL_FILES).length) throw modelIntegrityError()
		for (const [environmentKey, expected] of Object.entries(REQUIRED_MODEL_FILES)) {
			const modelPath = models[environmentKey]
			if (path.basename(modelPath) !== expected.name || manifest.get(expected.name) !== expected.sha256) {
				throw modelIntegrityError()
			}
			const stat = await fs.promises.stat(modelPath)
			if (!stat.isFile()) throw modelIntegrityError()
			const actual = await sha256File(modelPath)
			if (actual !== expected.sha256) throw modelIntegrityError()
		}
		return true
	} catch (err) {
		if (err && err.code === 'RAPIDOCR_MODEL_INTEGRITY_ERROR') throw err
		throw modelIntegrityError()
	}
}

function validateIdentityResult(value, options = {}) {
	const input = value && typeof value === 'object' ? value : {}
	const name = String(input.name || '').replace(/\s+/g, '').trim()
	const fullId = String(input.fullId || input.full_id || '').replace(/\s+/g, '').toUpperCase()
	const nameConfidence = Number(input.nameConfidence ?? input.name_confidence)
	const identityConfidence = Number(input.identityConfidence ?? input.identity_confidence)
	const threshold = minimumConfidence(options.minConfidence ?? process.env.RAPIDOCR_IDENTITY_MIN_CONFIDENCE)

	if (
		input.ok !== true ||
		input.ambiguous === true ||
		!(/^[\u3400-\u9fff·]{2,8}$/u.test(name)) ||
		!isValidChineseIdentity(fullId) ||
		!Number.isFinite(nameConfidence) ||
		!Number.isFinite(identityConfidence) ||
		nameConfidence < threshold ||
		identityConfidence < threshold
	) {
		throw invalidResult()
	}

	return { name, fullId, nameConfidence, identityConfidence }
}

function createSingleConcurrencyGate(options = {}) {
	const maxQueueWaitMs = positiveInt(options.maxQueueWaitMs, DEFAULT_QUEUE_WAIT_MS)
	let active = false
	const queue = []

	const startNext = () => {
		if (active || queue.length === 0) return
		const job = queue.shift()
		if (!job || job.expired) return startNext()
		active = true
		clearTimeout(job.timer)
		Promise.resolve()
			.then(job.task)
			.then(job.resolve, job.reject)
			.finally(() => {
				active = false
				startNext()
			})
	}

	return (task) => new Promise((resolve, reject) => {
		if (typeof task !== 'function') return reject(new TypeError('rapidocr-task-required'))
		const job = { task, resolve, reject, expired: false, timer: null }
		job.timer = setTimeout(() => {
			job.expired = true
			const index = queue.indexOf(job)
			if (index >= 0) queue.splice(index, 1)
			const err = new Error('rapidocr-queue-timeout')
			err.code = 'RAPIDOCR_QUEUE_TIMEOUT'
			reject(err)
		}, maxQueueWaitMs)
		queue.push(job)
		startNext()
	})
}

const runExclusive = createSingleConcurrencyGate({
	maxQueueWaitMs: positiveInt(process.env.RAPIDOCR_QUEUE_WAIT_MS, DEFAULT_QUEUE_WAIT_MS)
})

async function prepareHeaderImage(input, options = {}) {
	const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || '')
	const maxInputBytes = positiveInt(options.maxInputBytes, DEFAULT_MAX_INPUT_BYTES)
	if (!buffer.length || buffer.length > maxInputBytes) {
		const err = new Error('rapidocr-invalid-input')
		err.code = 'RAPIDOCR_INVALID_INPUT'
		throw err
	}

	const maxInputPixels = positiveInt(options.maxInputPixels, DEFAULT_MAX_INPUT_PIXELS)
	const image = sharp(buffer, { limitInputPixels: maxInputPixels }).rotate()
	const metadata = await image.metadata()
	const width = Number(metadata.width || 0)
	const height = Number(metadata.height || 0)
	if (!width || !height) {
		const err = new Error('rapidocr-invalid-image')
		err.code = 'RAPIDOCR_INVALID_INPUT'
		throw err
	}

	const headerHeight = Math.max(1, Math.min(height, Math.ceil(height * 0.45)))
	return image
		.extract({ left: 0, top: 0, width, height: headerHeight })
		.resize({ width: Math.min(width, 1800), withoutEnlargement: true })
		.png({ compressionLevel: 6 })
		.toBuffer()
}

function helperEnvironment(options = {}) {
	const requiredModels = configuredModelPaths(options)
	if (Object.values(requiredModels).some((value) => !String(value || '').trim())) {
		const err = new Error('rapidocr-models-not-configured')
		err.code = 'RAPIDOCR_CONFIG_ERROR'
		throw err
	}

	const inherited = {}
	for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LD_LIBRARY_PATH']) {
		if (process.env[key]) inherited[key] = process.env[key]
	}
	return {
		...inherited,
		...requiredModels,
		RAPIDOCR_MODEL_MANIFEST: TRUSTED_MODEL_MANIFEST,
		RAPIDOCR_MIN_CONFIDENCE: String(minimumConfidence(options.minConfidence ?? process.env.RAPIDOCR_IDENTITY_MIN_CONFIDENCE)),
		PYTHONIOENCODING: 'utf-8',
		PYTHONUNBUFFERED: '1',
		PYTHONNOUSERSITE: '1',
		PYTHONDONTWRITEBYTECODE: '1',
		OMP_NUM_THREADS: '1',
		OMP_THREAD_LIMIT: '1',
		MKL_NUM_THREADS: '1',
		OPENBLAS_NUM_THREADS: '1'
	}
}

async function runIdentityHelper(input, options = {}) {
	const binary = String(options.python || process.env.RAPIDOCR_PYTHON || '').trim()
	const scriptPath = String(options.scriptPath || path.join(__dirname, 'ocr', 'rapidocr_identity.py')).trim()
	if (!binary) {
		const err = new Error('rapidocr-python-not-configured')
		err.code = 'RAPIDOCR_CONFIG_ERROR'
		throw err
	}

	const timeoutMs = positiveInt(options.timeoutMs || process.env.RAPIDOCR_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
	const maxOutputBytes = positiveInt(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES)
	let env
	try {
		env = helperEnvironment(options)
	} catch (err) {
		throw err
	}
	const verifyModels = typeof options.verifyModels === 'function' ? options.verifyModels : verifyModelFiles
	await verifyModels(options)
	const spawnProcess = typeof options.spawnImpl === 'function' ? options.spawnImpl : spawn

	return new Promise((resolve, reject) => {
		let settled = false
		let closed = false
		let pendingFailure = null
		let stdout = Buffer.alloc(0)
		let stderrBytes = 0
		let timer = null
		let child

		const finish = (err, value) => {
			if (settled) return
			settled = true
			if (timer) clearTimeout(timer)
			if (err) reject(err)
			else resolve(value)
		}
		const failure = (code, message) => {
			const err = new Error(message)
			err.code = code
			return err
		}
		const failAfterClose = (code, message, kill = true) => {
			if (settled || closed) return
			if (!pendingFailure) pendingFailure = failure(code, message)
			if (kill) {
				try { child.kill('SIGKILL') } catch { /* fail closed until close */ }
			}
		}

		try {
			child = spawnProcess(binary, [scriptPath], {
				stdio: ['pipe', 'pipe', 'pipe'],
				shell: false,
				windowsHide: true,
				env
			})
		} catch {
			return finish(failure('RAPIDOCR_PROCESS_ERROR', 'rapidocr-process-error'))
		}

		timer = setTimeout(() => {
			failAfterClose('RAPIDOCR_TIMEOUT', 'rapidocr-timeout')
		}, timeoutMs)

		child.on('error', () => {
			const err = failure('RAPIDOCR_PROCESS_ERROR', 'rapidocr-process-error')
			if (!child.pid) return finish(err)
			if (!pendingFailure) pendingFailure = err
			try { child.kill('SIGKILL') } catch { /* fail closed until close */ }
		})
		child.stdout.on('data', (chunk) => {
			if (pendingFailure) return
			const data = Buffer.from(chunk)
			if (stdout.length + data.length > maxOutputBytes) {
				return failAfterClose('RAPIDOCR_OUTPUT_LIMIT', 'rapidocr-output-limit')
			}
			stdout = Buffer.concat([stdout, data])
		})
		child.stderr.on('data', (chunk) => {
			stderrBytes += Buffer.byteLength(chunk)
			if (stderrBytes > maxOutputBytes) {
				failAfterClose('RAPIDOCR_PROCESS_ERROR', 'rapidocr-process-error')
			}
		})
		child.stdout.on('error', () => {
			failAfterClose('RAPIDOCR_PROCESS_ERROR', 'rapidocr-process-error')
		})
		child.stderr.on('error', () => {
			failAfterClose('RAPIDOCR_PROCESS_ERROR', 'rapidocr-process-error')
		})
		child.on('close', (code) => {
			closed = true
			if (pendingFailure) return finish(pendingFailure)
			if (code !== 0 || stderrBytes > maxOutputBytes) {
				return finish(failure('RAPIDOCR_PROCESS_ERROR', 'rapidocr-process-error'))
			}
			let parsed
			try {
				parsed = JSON.parse(stdout.toString('utf8'))
			} catch {
				return finish(failure('RAPIDOCR_INVALID_RESULT', 'rapidocr-invalid-result'))
			}
			try {
				return finish(null, validateIdentityResult(parsed, options))
			} catch (err) {
				return finish(err)
			}
		})
		child.stdin.on('error', (err) => {
			if (err && err.code !== 'EPIPE') {
				failAfterClose('RAPIDOCR_PROCESS_ERROR', 'rapidocr-process-error')
			}
		})
		try {
			child.stdin.end(input)
		} catch {
			failAfterClose('RAPIDOCR_PROCESS_ERROR', 'rapidocr-process-error')
		}
	})
}

async function recognizeFirstPageOwnership(input, options = {}) {
	const configured = options.enabled ?? process.env.RAPIDOCR_IDENTITY_ENABLED ?? 'false'
	const enabled = String(configured).toLowerCase() === 'true'
	if (!enabled) {
		const err = new Error('rapidocr-disabled')
		err.code = 'RAPIDOCR_DISABLED'
		throw err
	}
	return runExclusive(async () => {
		const headerImage = await prepareHeaderImage(input, options)
		return runIdentityHelper(headerImage, options)
	})
}

module.exports = {
	isValidChineseIdentity,
	validateIdentityResult,
	parseModelManifest,
	verifyModelFiles,
	createSingleConcurrencyGate,
	prepareHeaderImage,
	runIdentityHelper,
	recognizeFirstPageOwnership
}
