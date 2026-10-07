'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
	normalizeProvider,
	buildTesseractArgs,
	normalizeOcrText
} = require('../localOcr')

test('local OCR is the default when no vision API key is configured', () => {
	assert.equal(normalizeProvider('', false), 'local')
	assert.equal(normalizeProvider('', true), 'moonshot')
	assert.equal(normalizeProvider('tesseract', true), 'local')
	assert.equal(normalizeProvider('local', true), 'local')
	assert.equal(normalizeProvider('kimi', false), 'kimi')
})

test('Tesseract args keep Chinese, English and dense-page spacing', () => {
	assert.deepEqual(buildTesseractArgs(), [
		'stdin',
		'stdout',
		'-l',
		'chi_sim+eng',
		'--psm',
		'6',
		'-c',
		'preserve_interword_spaces=1'
	])
	assert.equal(buildTesseractArgs({ psm: 99 })[5], '13')
})

test('OCR text normalization removes binary and excessive line noise', () => {
	assert.equal(normalizeOcrText(' 第一行  \r\n\0第二行\r\n\r\n\r\n第三行 '), '第一行\n第二行\n\n第三行')
})

test('local OCR keeps a normal rendered A4 page intact', async () => {
	const sharp = require('sharp')
	const modulePath = require.resolve('../moonshotVision')
	const previousProvider = process.env.OCR_PROVIDER
	process.env.OCR_PROVIDER = 'local'
	delete require.cache[modulePath]
	try {
		const { splitImageForOcr } = require('../moonshotVision')
		const page = await sharp({
			create: {
				width: 1190,
				height: 1684,
				channels: 3,
				background: '#ffffff'
			}
		}).png().toBuffer()
		const tiles = await splitImageForOcr(page, 'image/png')
		assert.equal(tiles.length, 1)
	} finally {
		if (previousProvider === undefined) delete process.env.OCR_PROVIDER
		else process.env.OCR_PROVIDER = previousProvider
		delete require.cache[modulePath]
	}
})

test('cloud OCR query rescue shifts tile boundaries without gaps or overlap', async () => {
	const sharp = require('sharp')
	const modulePath = require.resolve('../moonshotVision')
	const previousProvider = process.env.OCR_PROVIDER
	const previousTileHeight = process.env.OCR_TILE_MAX_HEIGHT
	process.env.OCR_PROVIDER = 'kimi'
	process.env.OCR_TILE_MAX_HEIGHT = '900'
	delete require.cache[modulePath]
	try {
		const { splitImageForOcr } = require('../moonshotVision')
		const page = await sharp({
			create: {
				width: 1190,
				height: 1684,
				channels: 3,
				background: '#ffffff'
			}
		}).png().toBuffer()
		const tiles = await splitImageForOcr(page, 'image/png', { tileOffset: 450 })
		const heights = []
		for (const tile of tiles) {
			const metadata = await sharp(Buffer.from(tile.base64, 'base64')).metadata()
			heights.push(metadata.height)
		}
		assert.deepEqual(heights, [450, 900, 334])
		assert.equal(heights.reduce((sum, height) => sum + height, 0), 1684)
	} finally {
		if (previousProvider === undefined) delete process.env.OCR_PROVIDER
		else process.env.OCR_PROVIDER = previousProvider
		if (previousTileHeight === undefined) delete process.env.OCR_TILE_MAX_HEIGHT
		else process.env.OCR_TILE_MAX_HEIGHT = previousTileHeight
		delete require.cache[modulePath]
	}
})
