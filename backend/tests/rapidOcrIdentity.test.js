'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { PassThrough } = require('node:stream')

const {
	validateIdentityResult,
	verifyModelFiles,
	createSingleConcurrencyGate,
	runIdentityHelper
} = require('../rapidOcrIdentity')

const buildSyntheticIdentity = () => {
	const body = ['110101', '20000101', '019'].join('')
	const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
	const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2']
	const sum = body.split('').reduce((total, digit, index) => total + Number(digit) * weights[index], 0)
	return `${body}${checks[sum % 11]}`
}

const identity = buildSyntheticIdentity()

const fakeSpawn = ({ output = '', delayMs = 0, exitCode = 0 }) => () => {
	const child = new EventEmitter()
	child.stdin = new PassThrough()
	child.stdout = new PassThrough()
	child.stderr = new PassThrough()
	let closed = false
	const close = (code) => {
		if (closed) return
		closed = true
		child.stdout.end()
		child.stderr.end()
		child.emit('close', code)
	}
	child.kill = () => {
		setImmediate(() => close(137))
		return true
	}
	setTimeout(() => {
		if (closed) return
		if (output) child.stdout.write(output)
		close(exitCode)
	}, delayMs)
	return child
}

const helperOptions = (overrides = {}) => ({
	python: 'isolated-python',
	scriptPath: 'fixed-helper.py',
	detModel: 'detector.onnx',
	clsModel: 'classifier.onnx',
	recModel: 'recognizer.onnx',
	verifyModels: async () => true,
	...overrides
})

test('RapidOCR helper result must contain one credible name and checksum-valid identity', () => {
	const result = validateIdentityResult({
		ok: true,
		name: '测试甲',
		fullId: identity,
		nameConfidence: 0.98,
		identityConfidence: 0.99
	})

	assert.equal(result.name, '测试甲')
	assert.equal(result.fullId, identity)
	const wrongCheck = identity.endsWith('0') ? '1' : '0'
	assert.throws(() => validateIdentityResult({
		ok: true,
		name: '测试甲',
		fullId: `${identity.slice(0, -1)}${wrongCheck}`,
		nameConfidence: 0.99,
		identityConfidence: 0.99
	}), /invalid-result/)
	assert.throws(() => validateIdentityResult({
		ok: true,
		name: '测试甲',
		fullId: identity,
		nameConfidence: 0.2,
		identityConfidence: 0.99
	}), /invalid-result/)
})

test('RapidOCR gate never runs more than one child task concurrently', async () => {
	const gate = createSingleConcurrencyGate({ maxQueueWaitMs: 1000 })
	let active = 0
	let peak = 0
	const run = (value) => gate(async () => {
		active += 1
		peak = Math.max(peak, active)
		await new Promise((resolve) => setTimeout(resolve, 20))
		active -= 1
		return value
	})

	const values = await Promise.all([run(1), run(2), run(3)])
	assert.deepEqual(values, [1, 2, 3])
	assert.equal(peak, 1)
})

test('a replacement manifest cannot authorize unreviewed same-name models', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rapidocr-model-test-'))
	const names = [
		'PP-OCRv6_det_small.onnx',
		'ch_ppocr_mobile_v2.0_cls_mobile.onnx',
		'PP-OCRv6_rec_small.onnx'
	]
	try {
		const paths = names.map((name, index) => {
			const filePath = path.join(root, name)
			fs.writeFileSync(filePath, Buffer.from(`synthetic-model-${index}`))
			return filePath
		})
		const manifestPath = path.join(root, 'models.sha256')
		const manifest = paths.map((filePath, index) => {
			const digest = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
			return `${digest}  ${names[index]}`
		}).join('\n')
		fs.writeFileSync(manifestPath, `${manifest}\n`, 'utf8')

		const options = {
			detModel: paths[0],
			clsModel: paths[1],
			recModel: paths[2],
			modelManifest: manifestPath
		}
		await assert.rejects(
			() => verifyModelFiles(options),
			(err) => err && err.code === 'RAPIDOCR_MODEL_INTEGRITY_ERROR' && !err.message.includes(root)
		)
	} finally {
		fs.rmSync(root, { recursive: true, force: true })
	}
})

test('helper process accepts only bounded valid JSON and never exposes raw output in errors', async () => {
	const validJson = JSON.stringify({
		ok: true,
		name: '测试甲',
		fullId: identity,
		nameConfidence: 0.99,
		identityConfidence: 0.99
	})
	const valid = await runIdentityHelper(Buffer.from('image'), helperOptions({
		spawnImpl: fakeSpawn({ output: validJson })
	}))
	assert.equal(valid.fullId, identity)

	await assert.rejects(
		() => runIdentityHelper(Buffer.from('image'), helperOptions({
			spawnImpl: fakeSpawn({ output: 'sensitive-invalid-json' })
		})),
		(err) => err && err.code === 'RAPIDOCR_INVALID_RESULT' && !err.message.includes('sensitive')
	)
})

test('helper process timeout fails closed', async () => {
	await assert.rejects(
		() => runIdentityHelper(Buffer.from('image'), helperOptions({
			spawnImpl: fakeSpawn({ output: '{}', delayMs: 100 }),
			timeoutMs: 10
		})),
		(err) => err && err.code === 'RAPIDOCR_TIMEOUT'
	)
})

test('output-limit kill holds the single-concurrency gate until the child closes', async () => {
	const gate = createSingleConcurrencyGate({ maxQueueWaitMs: 1000 })
	let firstClosed = false
	let secondStartedBeforeClose = null
	const spawnImpl = () => {
		const child = new EventEmitter()
		child.pid = 12345
		child.stdin = new PassThrough()
		child.stdout = new PassThrough()
		child.stderr = new PassThrough()
		let killed = false
		child.kill = () => {
			if (killed) return true
			killed = true
			setTimeout(() => {
				firstClosed = true
				child.stdout.end()
				child.stderr.end()
				child.emit('close', 137)
			}, 35)
			return true
		}
		setImmediate(() => child.stdout.write(Buffer.alloc(32, 1)))
		return child
	}

	const first = gate(() => runIdentityHelper(Buffer.from('image'), helperOptions({
		spawnImpl,
		maxOutputBytes: 8
	})))
	const second = gate(async () => {
		secondStartedBeforeClose = !firstClosed
		return 'second-finished'
	})
	const [firstResult, secondResult] = await Promise.allSettled([first, second])

	assert.equal(firstResult.status, 'rejected')
	assert.equal(firstResult.reason.code, 'RAPIDOCR_OUTPUT_LIMIT')
	assert.equal(secondResult.status, 'fulfilled')
	assert.equal(secondResult.value, 'second-finished')
	assert.equal(secondStartedBeforeClose, false)
})

test('stdout stream errors fail closed without exposing stream content', async () => {
	const spawnImpl = () => {
		const child = new EventEmitter()
		child.pid = 12346
		child.stdin = new PassThrough()
		child.stdout = new PassThrough()
		child.stderr = new PassThrough()
		let closed = false
		child.kill = () => {
			if (!closed) {
				closed = true
				setImmediate(() => child.emit('close', 137))
			}
			return true
		}
		setImmediate(() => child.stdout.emit('error', new Error('sensitive-stream-content')))
		return child
	}

	await assert.rejects(
		() => runIdentityHelper(Buffer.from('image'), helperOptions({ spawnImpl })),
		(err) => err && err.code === 'RAPIDOCR_PROCESS_ERROR' && !err.message.includes('sensitive')
	)
})
