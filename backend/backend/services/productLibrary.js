'use strict'

/**
 * 服务端产品库
 *
 * ⚠️ 单一数据源：src/shared/productLibrary.json
 *   前后端（services/matchEngine.js 与 ai-proxy/backend/services/productLibrary.js）
 *   均从此文件读取，改产品时只需改一处。
 */
const path = require('path')
const fs = require('fs')

const PRODUCT_LIBRARY_CANDIDATES = [
	process.env.PRODUCT_LIBRARY_PATH,
	path.join(__dirname, '..', '..', '..', '..', 'src', 'shared', 'productLibrary.json'),
	path.join(__dirname, '..', '..', 'src', 'shared', 'productLibrary.json')
].filter(Boolean)

const SHARED_PRODUCT_LIBRARY_PATH = PRODUCT_LIBRARY_CANDIDATES.find(candidate => fs.existsSync(candidate))

if (!SHARED_PRODUCT_LIBRARY_PATH) {
	throw new Error(`Cannot find productLibrary.json. Checked: ${PRODUCT_LIBRARY_CANDIDATES.join(', ')}`)
}

const PRODUCT_LIBRARY = require(SHARED_PRODUCT_LIBRARY_PATH)

module.exports = { PRODUCT_LIBRARY }
