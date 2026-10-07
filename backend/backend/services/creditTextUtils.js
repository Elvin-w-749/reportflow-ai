'use strict'

/**
 * 征信文本处理工具集（从 server.js 提取）
 *
 * 纯函数，零依赖，可独立单测。提供：
 *   - looksLikeTokenLimitErr — 判断 API 错误是否为 token 超限
 *   - compressCreditText     — 长文本智能压缩（头部+关键行+尾部）
 *   - stripJsonFence         — 去除 markdown 代码围栏
 *   - extractJsonObject      — 从模型输出中提取 JSON 对象
 *   - closeAndParse           — 截断 JSON 抢救（补全闭合括号）
 *   - repairTruncatedJson    — 综合截断修复（逐字符回溯 + 闭合）
 */

// ── Token 限制检测 ──────────────────────────

const TOKEN_LIMIT_MARKERS = [
	'token limit',
	'exceeded model token limit',
	'context length',
	'maximum context length'
]

function looksLikeTokenLimitErr(errMsg) {
	const s = String(errMsg || '').toLowerCase()
	return TOKEN_LIMIT_MARKERS.some((k) => s.includes(k))
}

// ── 文本压缩 ────────────────────────────────

/**
 * 征信文本压缩 / 抽样：
 *  - DeepSeek-V4-Flash 当前上下文足以容纳普通征信报告，默认
 *    maxChars 为 240000，避免历史 40000 字符门槛误拒完整报告。
 *  - 仅当超出 maxChars 才走"头部 + 关键行 + 尾部"裁切，并保留至少 65% 的关键行。
 *  - 返回 { text, truncated, original_length }；调用方再写入 _coverage 供前端做诊断。
 */
function compressCreditText(rawText, maxChars = 240000) {
	const raw = String(rawText || '').replace(/\0/g, '')
	if (raw.length <= maxChars) return { text: raw, truncated: false, original_length: raw.length }

	const lines = raw.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
	const keyRe = /(姓名|证件|身份证|报告(编号|时间|日期)|手机|住址|工作|户籍|账户|贷款|信用卡|贷记卡|准贷记卡|余额|已使用|授信|额度|逾期|连三|累六|M[1-7]|当前逾期|查询|机构|分期|担保|被担保|公共记录|强制执行|欠税|民事判决|行政处罚|结清|到期|月还款|月供|负债|审批|发卡|放款|首付|按揭|经营贷|消费贷|车贷|房贷)/i
	const picked = []
	for (const line of lines) {
		if (keyRe.test(line)) picked.push(line)
		if (picked.join('\n').length >= Math.floor(maxChars * 0.7)) break
	}

	const head = raw.slice(0, Math.floor(maxChars * 0.2))
	const tail = raw.slice(-Math.floor(maxChars * 0.1))
	let merged = `【征信文本-头部】\n${head}\n\n【征信关键片段（命中 ${picked.length} 行）】\n${picked.join('\n')}\n\n【征信文本-尾部】\n${tail}\n\n【注意】原文长度 ${raw.length} 字符，已按规则裁切，请在 _coverage.truncated 置 true。`
	if (merged.length > maxChars) merged = merged.slice(0, maxChars)
	return { text: merged, truncated: true, original_length: raw.length }
}

// ── JSON 提取与修复 ──────────────────────────

function stripJsonFence(s) {
	let t = String(s || '').trim()
	const m = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
	if (m) t = m[1].trim()
	return t
}

/**
 * 从模型输出中尽力提取一段合法 JSON 对象字符串。
 * 处理：markdown 围栏、前后缀解说文字、裸 JSON。
 * 通过扫描首个 `{` 起的平衡括号（识别字符串与转义），截取最外层对象。
 * @param {string} content 模型原始 content
 * @returns {string} 最可能为 JSON 的子串（无法定位时返回去围栏后的原串）
 */
function extractJsonObject(content) {
	const t = stripJsonFence(content)
	const start = t.indexOf('{')
	if (start < 0) return t
	let depth = 0
	let inStr = false
	let esc = false
	for (let i = start; i < t.length; i++) {
		const ch = t[i]
		if (inStr) {
			if (esc) { esc = false }
			else if (ch === '\\') { esc = true }
			else if (ch === '"') { inStr = false }
			continue
		}
		if (ch === '"') { inStr = true; continue }
		if (ch === '{') depth++
		else if (ch === '}') {
			depth--
			if (depth === 0) return t.slice(start, i + 1)
		}
	}
	// 未闭合（疑似截断）：返回从首个 { 起的剩余串，交由上层 JSON.parse 失败处理
	return t.slice(start)
}

/**
 * 截断 JSON 抢救：模型输出被 max_tokens 截断（finish_reason=length）时，
 * 从末尾向前找到可安全闭合的边界，丢弃最后一条不完整条目并补全闭合括号。
 * 救回的对象会标记 _coverage.salvaged_truncated=true。
 * @returns {object|null} 成功返回对象，失败返回 null
 */
function closeAndParse(candidate) {
	const stack = []
	let inStr = false
	let esc = false
	for (let i = 0; i < candidate.length; i++) {
		const c = candidate[i]
		if (inStr) {
			if (esc) esc = false
			else if (c === '\\') esc = true
			else if (c === '"') inStr = false
			continue
		}
		if (c === '"') inStr = true
		else if (c === '{') stack.push('}')
		else if (c === '[') stack.push(']')
		else if (c === '}' || c === ']') stack.pop()
	}
	if (inStr) {
		return closeAndParse(candidate + '"')
	}
	let fixed = candidate
		.replace(/,\s*$/, '')
		.replace(/,?\s*"[^"]*"\s*:\s*$/, '')
		.replace(/([,{])\s*"[^"]*"\s*$/, '$1')
		.replace(/,?\s*[a-zA-Z_]\w*\s*$/, '')
	for (let i = stack.length - 1; i >= 0; i--) fixed += stack[i]
	try { return JSON.parse(fixed) } catch { return null }
}

function repairTruncatedJson(content) {
	const str = String(extractJsonObject(content) || '').trim()
	if (!str || str[0] !== '{') return null
	const full = closeAndParse(str)
	if (full && typeof full === 'object') return full
	for (let end = str.length; end > 2; end--) {
		const ch = str[end - 1]
		if (ch === '}' || ch === ']' || ch === '"' || ch === ',') {
			const r = closeAndParse(str.slice(0, end))
			if (r && typeof r === 'object') return r
		}
	}
	return null
}

module.exports = {
	looksLikeTokenLimitErr,
	compressCreditText,
	stripJsonFence,
	extractJsonObject,
	closeAndParse,
	repairTruncatedJson
}
