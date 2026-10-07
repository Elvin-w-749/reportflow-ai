'use strict'

require('dotenv').config()

const { verifyModelFiles } = require('../rapidOcrIdentity')

verifyModelFiles()
	.then(() => {
		process.stdout.write('rapidocr-models-ok\n')
	})
	.catch(() => {
		process.stderr.write('rapidocr-model-integrity-error\n')
		process.exitCode = 1
	})
