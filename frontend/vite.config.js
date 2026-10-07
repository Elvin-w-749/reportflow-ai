import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

// 旧页面使用的 Web 自定义标签：由 src/styles/global.css 还原盒模型行为。
// scroll-view / image 走全局组件（需要行为而不仅是样式），不在此列。
const LEGACY_WEB_CUSTOM_ELEMENTS = new Set([
  'view',
  'text',
  'swiper',
  'swiper-item',
  'rich-text'
])

const DEFAULT_LOCAL_API_ORIGIN = 'http://127.0.0.1:3200'

/**
 * 校验「合法 http(s) 源」：可解析、协议为 http/https、不含凭证/路径/查询/片段。
 * 返回规范化后的 origin；非法才抛错。不再要求配置值等于任何固定域名，
 * 这样任何人 clone 后不填配置即可构建与运行。
 */
export const resolveHttpOrigin = (raw, label = 'API 源') => {
  const value = String(raw || '').trim()
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(label + ' 必须是有效的 http(s) 源（如 http://127.0.0.1:3200 或 https://your.domain.invalid）')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error(label + ' 只允许不含凭证、路径、查询或片段的 http(s) 源')
  }
  return url.origin
}

// RPT_PROXY_BASE = 部署用的完整 origin（如 https://your.domain.invalid）；未设置即用本机默认后端。
// 取值来源见 resolveBuildEnv：shell 环境变量优先，其次 .env / .env.local / .env.<mode> 文件。
const buildProductionWarning = (() => {
  let warned = false
  return ({ mode, env }) => {
    if (warned) return
    const isProduction = String(mode || '') === 'production' ||
      String(env?.NODE_ENV || process.env.NODE_ENV || '').trim().toLowerCase() === 'production'
    if (!isProduction) return
    if (String(env?.RPT_PROXY_BASE || '').trim()) return
    warned = true
    // 不改成硬失败：CI 与本地演示构建都依赖「不配置也能出包」。但这一步必须显眼，
    // 因为忘配 RPT_PROXY_BASE 的产物会指向访客本机的 127.0.0.1:3200（proxy.js 对回环放行）。
    console.warn(
      [
        '',
        '┌──────────────────────────────────────────────────────────────────────────',
        '│ [build warning] RPT_PROXY_BASE 未设置，本次生产构建的 API 基址将回落到',
        '│                   ' + DEFAULT_LOCAL_API_ORIGIN + '/legacy-api',
        '│ 该地址只在构建机上可达；发布到公网前请显式指定你自己的 origin，例如',
        '│   RPT_PROXY_BASE=https://your.domain.invalid npm run build:legacy',
        '│ 并确认 src/config/proxy.js 的生产 HTTP 门禁（非回环 http 一律拒绝）仍然生效。',
        '└──────────────────────────────────────────────────────────────────────────',
        ''
      ].join('\n')
    )
  }
})()

/**
 * 读取构建期输入：`loadEnv` 会把 .env / .env.local / .env.<mode>[.local] 里的
 * `VITE_`/`RPT_` 前缀键载入（已存在的 shell 环境变量优先，不会被 .env 覆盖）。
 * 没有这一步，写进 .env.local 的 RPT_PROXY_BASE / RPT_LOCAL_API_ORIGIN 会静默失效，
 * 而 README 与 frontend/.env.example 都把它们登记在 .env 模板里。
 */
export const resolveBuildEnv = ({ mode, cwd = process.cwd(), base = process.env }) => ({
  ...loadEnv(mode, cwd, ['VITE_', 'RPT_']),
  NODE_ENV: String(base.NODE_ENV || '').trim()
})

export const resolveLocalApiOrigin = (raw = process.env.RPT_LOCAL_API_ORIGIN) => {
  const value = String(raw || DEFAULT_LOCAL_API_ORIGIN).trim()
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('RPT_LOCAL_API_ORIGIN 必须是有效的本机 http(s) 地址')
  }
  const host = String(url.hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error('RPT_LOCAL_API_ORIGIN 仅允许 localhost、127.0.0.1 或 ::1')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error('RPT_LOCAL_API_ORIGIN 只允许不含凭证、路径、查询或片段的 http(s) 源')
  }
  return url.origin
}

const createApiProxy = ({ target, legacyNamespace }) => ({
  target,
  changeOrigin: true,
  secure: target.startsWith('https://'),
  rewrite: legacyNamespace ? (path) => '/legacy-api' + path : (path) => path,
  configure(proxy) {
    proxy.on('proxyReq', (proxyReq) => {
      proxyReq.removeHeader('origin')
      proxyReq.removeHeader('referer')
    })
  }
})

export const createRptViteConfig = ({ mode, env = process.env }) => {
  const isDevelopment = mode === 'development'
  const localApiOrigin = isDevelopment ? resolveLocalApiOrigin(env.RPT_LOCAL_API_ORIGIN) : ''
  const LEGACY_WEB_ORIGIN = env.RPT_PROXY_BASE
    ? resolveHttpOrigin(env.RPT_PROXY_BASE, 'RPT_PROXY_BASE')
    : DEFAULT_LOCAL_API_ORIGIN
  const LEGACY_WEB_API_BASE = LEGACY_WEB_ORIGIN + '/legacy-api'
  const buildProxyBase = isDevelopment ? localApiOrigin : LEGACY_WEB_API_BASE
  const apiProxy = isDevelopment
    ? createApiProxy({ target: localApiOrigin, legacyNamespace: false })
    : createApiProxy({ target: LEGACY_WEB_ORIGIN, legacyNamespace: true })

  return {
  // 独立 Web 仅发布页面实际使用的公共资源，不携带原生应用图标和启动图。
  publicDir: 'web-public',
  // 注入全局生产标志：
  // - aiAnalysis/constants.js 据此关闭 dlog（避免征信数据打到 console）
  // - config/proxy.js 据此启用生产安全门禁（禁 HTTP 网关 / 禁内置 Bearer）
  // `vite build` 默认 mode==='production'，`vite`(dev) 为 'development'。
  define: {
    __RPT_PROD__: JSON.stringify(mode === 'production'),
    __RPT_PROXY_BASE__: JSON.stringify(buildProxyBase)
  },
  plugins: [
    vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag) => LEGACY_WEB_CUSTOM_ELEMENTS.has(tag)
        }
      }
    })
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    host: true,
    allowedHosts: true,
    port: 5173,
    proxy: {
      '/api': apiProxy
    }
  },
  preview: {
    host: true,
    allowedHosts: true,
    port: 8910,
    proxy: {
      '/api': apiProxy
    }
  }
  }
}

export default defineConfig(({ mode }) => {
  const env = resolveBuildEnv({ mode })
  buildProductionWarning({ mode, env })
  return createRptViteConfig({ mode, env })
})
