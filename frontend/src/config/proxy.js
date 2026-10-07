// 旧版 Web 只调用后端 API 的旧版命名空间。
// 默认指向本机后端（clone 后无需任何配置即可运行）；部署时用 vite.config.js 的
// RPT_PROXY_BASE（完整 origin）覆盖，构建期由 __RPT_PROXY_BASE__ 注入下方常量之外的值。
// 本仓库只有浏览器 Web，不保留任何原生客户端专用网关。
const LEGACY_WEB_API_BASE = 'http://127.0.0.1:3200/legacy-api'
// eslint-disable-next-line no-undef
const BUILD_PROXY_BASE = typeof __RPT_PROXY_BASE__ !== 'undefined'
	// eslint-disable-next-line no-undef
	? String(__RPT_PROXY_BASE__ || '').trim()
	: ''
export const PROXY_BASE = BUILD_PROXY_BASE || LEGACY_WEB_API_BASE
export const FORCE_HTTP_PROXY_ONLY = false

const LOCAL_PREVIEW_PORTS = new Set(['5173', '8910'])

const isLocalPreviewHost = (host = '') => {
	const h = String(host || '').toLowerCase()
	return (
		h === 'localhost' ||
		h === '127.0.0.1' ||
		h === '::1' ||
		h.startsWith('192.168.') ||
		h.startsWith('10.') ||
		/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)
	)
}

const isPreviewTunnelHost = (host = '') => {
	const h = String(host || '').toLowerCase()
	return /\.trycloudflare\.com$/i.test(h) || /\.loca\.lt$/i.test(h)
}

export const isLocalWebPreviewRuntime = () => {
	try {
		if (typeof window === 'undefined' || !window.location) return false
		const { protocol, hostname, port } = window.location
		const isLocalPreview = protocol === 'http:' && LOCAL_PREVIEW_PORTS.has(String(port || '')) && isLocalPreviewHost(hostname)
		const isTunnelPreview = protocol === 'https:' && isPreviewTunnelHost(hostname)
		return isLocalPreview || isTunnelPreview
	} catch {
		return false
	}
}

const runtimeProxyBase = () => (isLocalWebPreviewRuntime() ? '' : PROXY_BASE)

/**
 * 拼接 PROXY_BASE + /api/... 完整请求 URL。
 * @param {string} path 以 / 开头的路径；若未含 /api/ 前缀则自动补上（如 /analyze → /api/analyze）
 */
export const buildProxyApiUrl = (path = '') => {
	const base = String(runtimeProxyBase() || '').replace(/\/+$/, '')
	let p = String(path || '').trim()
	if (!p.startsWith('/')) p = `/${p}`
	if (!/^\/api(\/|$)/i.test(p)) p = `/api${p}`
	return base ? base + p : p
}

/**
 * 旧版 Web 统一后端网关。
 *
 * 生产/联调约定：
 * - 浏览器接口统一走 PROXY_BASE。
 * - 本地调试默认就是本机地址（如 http://127.0.0.1:3200/legacy-api）。
 * - 部署到其它源时用构建期的 RPT_PROXY_BASE 覆盖（值为完整 origin）。
 * - 对外发布必须使用已备案 + 配置证书的 HTTPS 域名；HTTP 只允许本机回环与开发构建。
 *
 * 上线安全门禁（详见底部 isProductionBuild）：
 * - 生产构建禁止非回环的 HTTP 网关（内置默认是 http://127.0.0.1:3200，回环例外）
 * - 生产构建禁止在客户端内置静态 Bearer
 *   触发即在所有走代理的请求入口拒绝执行（getProxyBaseMisconfigReason 返回非空）。
 */

/**
 * 仅用于本地联调的静态兜底 Bearer。
 *
 * 安全基线：
 * - 默认必须留空（仓库不落明文密钥）
 * - 生产流量仅使用登录态 JWT
 * - 如需本地临时联调，可在本机改为随机值，但禁止提交到仓库
 */
export const DEV_ANALYZE_BEARER_TOKEN = ''

/**
 * 是否生产构建。
 *
 * 实际启用「生产门禁」必须在构建期通过下列任一方式注入：
 *
 *   1) Vite：在 vite.config.js 的 define 注入
 *        define: { '__RPT_PROD__': JSON.stringify(true) }
 *   2) Node 工具链（如 strict-gate）：通过 process.env.NODE_ENV=production 直接命中
 *
 * 任一命中即认为是生产构建。
 */
// eslint-disable-next-line no-undef
const __RPT_PROD_FLAG__ = typeof __RPT_PROD__ !== 'undefined' ? !!__RPT_PROD__ : false

const isProductionBuild = (() => {
	if (__RPT_PROD_FLAG__) return true
	try {
		if (
			typeof globalThis !== 'undefined' &&
			globalThis.__RPT_PROD__ === true
		) {
			return true
		}
	} catch {}
	try {
		if (typeof process !== 'undefined' && process && process.env && process.env.NODE_ENV === 'production') {
			return true
		}
	} catch {}
	return false
})()

/**
 * 是否生产构建（供客户端按需收敛日志/脱敏）。
 * 构建期注入 __RPT_PROD__ 或 NODE_ENV=production 均视为生产。
 */
export const IS_PRODUCTION_BUILD = isProductionBuild

const parseProxyHost = (raw) => {
	try {
		const s = String(raw || '').trim()
		const m = s.match(/^https?:\/\/([^/?#]+)/i)
		return m ? String(m[1]).toLowerCase() : ''
	} catch {
		return ''
	}
}

/**
 * 回环地址判定：127.x / localhost / ::1（带不带端口都算）。
 * 内置默认网关就是本机回环 http 源，明文传输的风险来自跨网链路，回环不出本机，
 * 因此生产 HTTP 门禁对回环放行；任何非回环（= 真实部署）的 http 网关仍然一律拒绝。
 */
const isLoopbackProxyBase = (raw) => {
	const withPort = String(parseProxyHost(raw) || '').toLowerCase().replace(/^\[|\]$/g, '')
	const host = withPort.replace(/:\d+$/, '')
	return host === 'localhost' || host === '::1' || host.startsWith('127.')
}

/**
 * 发起请求前自检：占位域名、常见钓鱼/广告域、非法配置、生产硬约束。
 * @returns {string} 空字符串表示通过；否则为可直接展示给用户的中文原因
 */
export const getProxyBaseMisconfigReason = () => {
	const base = String(PROXY_BASE || '').trim()
	if (!/^https?:\/\//i.test(base)) {
		return 'PROXY_BASE 须为 http(s):// 开头的网关地址，请在 config/proxy.js 中修改'
	}
	const host = parseProxyHost(base)
	if (!host) return 'PROXY_BASE 无法解析出主机名，请检查 config/proxy.js'
	if (/(^|\.)yourdomain\.com$/i.test(host)) {
		return 'PROXY_BASE 仍为占位域名 api.yourdomain.com：请改为你的真实服务器域名，否则请求可能被劫持到无关站点'
	}
	if (/^example\.(com|org|net)$/i.test(host) || /\.example\.(com|org|net)$/i.test(host)) {
		return 'PROXY_BASE 不能使用 example.* 占位域名，请在 config/proxy.js 中改为你的网关地址'
	}
	if (/bedpage\.com$/i.test(host)) {
		return 'PROXY_BASE 指向 bedpage.com，属于异常配置；请改为你自己的 API 域名'
	}

	if (isProductionBuild) {
		if (/^http:\/\//i.test(base) && !isLoopbackProxyBase(base)) {
			return '[安全门禁] 生产构建禁止使用 HTTP 网关，请改为已备案 + 已配置证书的 HTTPS 域名'
		}
		const token = String(DEV_ANALYZE_BEARER_TOKEN || '').trim()
		if (token) {
			return '[安全门禁] 生产构建禁止在客户端内置 DEV_ANALYZE_BEARER_TOKEN，请仅使用登录态 JWT'
		}
	}

	return ''
}

/**
 * 安全告警（不阻断 dev 构建，仅用于面板/日志可视化）。
 * 即使是 dev 构建，也会把"HTTP 网关""默认 Token"作为待办上报，以避免发布前忘记改。
 */
export const getSecurityHardeningWarnings = () => {
	const warnings = []
	const base = String(PROXY_BASE || '').trim()
	if (/^http:\/\//i.test(base)) {
		warnings.push('当前 PROXY_BASE 仍为 HTTP，上线前必须切换到 HTTPS')
	}
	const token = String(DEV_ANALYZE_BEARER_TOKEN || '').trim()
	if (token) {
		warnings.push('检测到 DEV_ANALYZE_BEARER_TOKEN 非空：该值会明文打包到客户端，建议立即移除并改用登录态 JWT')
	} else {
		warnings.push('当前未启用客户端静态 Bearer：AI 端点依赖登录态 JWT，发布前请验证未登录流程已正确拦截')
	}
	return warnings
}

if (!isProductionBuild) {
	try {
		const warnings = getSecurityHardeningWarnings()
		if (warnings.length && typeof console !== 'undefined' && typeof console.warn === 'function') {
			warnings.forEach((w) => console.warn('[proxy.js] 安全告警：' + w))
		}
	} catch {}
}

/**
 * 是否强制 AI 成功后才允许出报告。
 * - true：严格模式，必须 AI 分析成功才生成报告（符合"上传→AI分析→展示"流程）。
 * - false：AI 失败时降级为规则解析结果（仅建议本地调试使用）。
 */
export const REQUIRE_AI_FOR_REPORT = true
export const REQUIRE_KIMI_AI_FOR_REPORT = REQUIRE_AI_FOR_REPORT

export default PROXY_BASE
