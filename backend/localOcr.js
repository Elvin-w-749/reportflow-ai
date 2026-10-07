'use strict'

const { spawn } = require('child_process')

const DEFAULT_TIMEOUT_MS = 120000
const DEFAULT_MAX_OUTPUT_CHARS = 1000000
const DEFAULT_MAX_INPUT_BYTES = 25 * 1024 * 1024

function positiveInt(value, fallback) {
	const n = Number(value)
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function normalizeProvider(configured, hasVisionApiKey) {
	const provider = String(configured || '').trim().toLowerCase()
	if (provider === 'tesseract') return 'local'
	if (provider) return provider
	return hasVisionApiKey ? 'moonshot' : 'local'
}

function normalizeOcrText(value) {
	return String(value || '')
		.replace(/\0/g, '')
		.replace(/\r\n?/g, '\n')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
}

function buildTesseractArgs(options = {}) {
	const lang = String(options.lang || 'chi_sim+eng').trim() || 'chi_sim+eng'
	const psm = Math.min(13, positiveInt(options.psm, 6))
	return ['stdin', 'stdout', '-l', lang, '--psm', String(psm), '-c', 'preserve_interword_spaces=1']
}

/**
 * Run the system Tesseract binary without temporary files. The rendered report
 * page is passed through stdin and only OCR text is collected from stdout.
 */
function ocrImageBufferToText(input, options = {}) {
	const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || '')
	if (!buffer.length) return Promise.resolve('')

	const maxInputBytes = positiveInt(
		options.maxInputBytes || process.env.LOCAL_OCR_MAX_INPUT_BYTES,
		DEFAULT_MAX_INPUT_BYTES
	)
	if (buffer.length > maxInputBytes) {
		return Promise.reject(new Error(`本地 OCR 图片过大（${buffer.length} bytes）`))
	}

	const binary = String(options.binary || process.env.TESSERACT_BIN || 'tesseract').trim() || 'tesseract'
	const timeoutMs = positiveInt(
		options.timeoutMs || process.env.LOCAL_OCR_TIMEOUT_MS,
		DEFAULT_TIMEOUT_MS
	)
	const maxOutputChars = positiveInt(
		options.maxOutputChars || process.env.LOCAL_OCR_MAX_OUTPUT_CHARS,
		DEFAULT_MAX_OUTPUT_CHARS
	)
	const args = buildTesseractArgs({
		lang: options.lang || process.env.TESSERACT_LANG,
		psm: options.psm || process.env.TESSERACT_PSM
	})

	return new Promise((resolve, reject) => {
		let settled = false
		let timedOut = false
		let stdout = ''
		let stderr = ''
		const child = spawn(binary, args, {
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
			env: {
				...process.env,
				OMP_THREAD_LIMIT: String(process.env.OCR_TESSERACT_THREADS || '1')
			}
		})

		const finish = (err, text = '') => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			if (err) reject(err)
			else resolve(normalizeOcrText(text))
		}

		const timer = setTimeout(() => {
			timedOut = true
			child.kill('SIGKILL')
		}, timeoutMs)

		child.on('error', (err) => {
			finish(new Error(`本地 OCR 启动失败：${err && err.message ? err.message : err}`))
		})
		child.stdout.setEncoding('utf8')
		child.stderr.setEncoding('utf8')
		child.stdout.on('data', (chunk) => {
			stdout += chunk
			if (stdout.length > maxOutputChars) {
				child.kill('SIGKILL')
				finish(new Error('本地 OCR 输出超过安全上限'))
			}
		})
		child.stderr.on('data', (chunk) => {
			if (stderr.length < 4000) stderr += chunk
		})
		child.on('close', (code, signal) => {
			if (timedOut) {
				return finish(new Error(`本地 OCR 超时（${timeoutMs}ms）`))
			}
			if (code !== 0) {
				const detail = normalizeOcrText(stderr).slice(0, 500)
				return finish(new Error(`本地 OCR 失败（code=${code}, signal=${signal || 'none'}）：${detail}`))
			}
			return finish(null, stdout)
		})

		child.stdin.on('error', (err) => {
			if (err && err.code !== 'EPIPE') finish(new Error(`本地 OCR 输入失败：${err.message}`))
		})
		child.stdin.end(buffer)
	})
}

module.exports = {
	ocrImageBufferToText,
	normalizeProvider,
	buildTesseractArgs,
	normalizeOcrText
}
