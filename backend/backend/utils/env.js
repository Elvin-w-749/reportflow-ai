'use strict'

/**
 * 运行时环境判定（单一真相源）
 *
 * production / prod 均视为生产环境。此前 server.js / auth.js / user.js / match.js
 * 各自内联同一段 NODE_ENV 判定，极易漂移（例如某处漏掉 'prod' 别名导致鉴权裂缝），
 * 统一收敛到此处。
 */
function isProductionRuntime() {
	return ['production', 'prod'].includes(String(process.env.NODE_ENV || '').toLowerCase())
}

module.exports = { isProductionRuntime }
