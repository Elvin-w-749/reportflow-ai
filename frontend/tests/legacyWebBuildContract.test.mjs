import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('legacy Web build derives the old-version API prefix from an overridable loopback default', async () => {
  const buildScript = await read('../scripts/build-legacy-web.mjs')
  const verifyScript = await read('../scripts/verify-legacy-web-build.mjs')
  const packageScript = await read('../scripts/package-legacy-web-release.mjs')
  assert.match(buildScript, /'http:\/\/127\.0\.0\.1:3200'/)
  assert.match(buildScript, /apiOrigin \+ '\/legacy-api'/)
  assert.match(buildScript, /RPT_PROXY_BASE/)
  assert.match(buildScript, /\.legacy-build-provenance\.json/)
  assert.match(buildScript, /gitStatusBefore/)
  assert.match(buildScript, /gitStatusAfter/)
  assert.match(buildScript, /gitCommitAfter !== gitCommitBefore/)
  assert.match(buildScript, /lockfileSha256After !== lockfileSha256Before/)
  assert.match(verifyScript, /apiOrigin \+ '\/api'/)
  assert.match(verifyScript, /'localhost:3000'/)
  assert.match(verifyScript, /'127\.0\.0\.1:3000'/)
  assert.match(verifyScript, /产物包含禁止地址/)
  assert.match(verifyScript, /legacy-api/)
  assert.match(verifyScript, /构建验证目录必须位于仓库内/)
  assert.match(packageScript, /apiOrigin \+ '\/legacy-api'/)
  assert.match(packageScript, /status', '--porcelain', '--untracked-files=all/)
  assert.match(packageScript, /\.legacy-build-provenance\.json/)
  assert.match(packageScript, /buildProvenance\.gitCommit !== gitCommit/)
  assert.match(packageScript, /service: 'rpt-legacy-web'/)
  assert.match(packageScript, /resolve\(output, 'release\.json'\)/)
  assert.match(packageScript, /manifestFiles\.push\(\{/)
})

// 反向守卫不能把被禁的旧主机名/旧公网 IP 原文写进断言——那等于亲手把它们留在仓库里。
// 这里换成通用判据：源码里出现的每个 http(s) 字面量，其主机必须是回环地址或
// RFC-2606 保留域（.invalid / .test / example.*）；任何真实公网主机名或公网 IPv4 字面量都判失败。
const LOCAL_LITERAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

const isAllowedLiteralHost = (rawHost) => {
  const host = String(rawHost || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/:\d+$/, '')
  if (LOCAL_LITERAL_HOSTS.has(host) || host.startsWith('127.')) return true
  if (/(^|\.)invalid$/i.test(host) || /(^|\.)test$/i.test(host)) return true
  if (/^(?:[a-z0-9-]+\.)*example\.(?:com|org|net)$/i.test(host)) return true
  return false
}

export const offendingHttpLiterals = (source) => [...String(source).matchAll(/https?:\/\/[A-Za-z0-9.\-_~:/?#@!$&*+,;=%[\]]+/g)]
  .map((match) => match[0])
  .filter((value) => {
    try { return !isAllowedLiteralHost(new URL(value).hostname) } catch { return false }
  })

const offendingPublicIpv4Literals = (source) => [...String(source).matchAll(/(?<![\d.])\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?![\d.])/g)]
  .map((match) => match[0])
  .filter((value) => {
    const [first, second] = value.split('.').map(Number)
    if (first === 127 || first === 10 || first === 0) return false
    if (first === 192 && second === 168) return false
    if (first === 172 && second >= 16 && second <= 31) return false
    return true
  })

test('legacy Web sources carry only loopback or reserved-domain http(s) literals', async () => {
  const sources = await Promise.all([
    read('../scripts/build-legacy-web.mjs'),
    read('../scripts/verify-legacy-web-build.mjs'),
    read('../scripts/package-legacy-web-release.mjs'),
    read('../src/config/proxy.js'),
    read('../vite.config.js')
  ])
  for (const source of sources) {
    assert.deepEqual(offendingHttpLiterals(source), [], '源码含非回环、非保留域的 http(s) 字面量')
    assert.deepEqual(offendingPublicIpv4Literals(source), [], '源码含公网 IPv4 字面量')
  }
})

test('legacy Web source constrains build-time API injection to the legacy namespace', async () => {
  const proxy = await read('../src/config/proxy.js')
  const vite = await read('../vite.config.js')
  assert.match(proxy, /__RPT_PROXY_BASE__/)
  assert.match(proxy, /'http:\/\/127\.0\.0\.1:3200\/legacy-api'/)
  assert.match(vite, /'http:\/\/127\.0\.0\.1:3200'/)
  assert.match(vite, /LEGACY_WEB_ORIGIN \+ '\/legacy-api'/)
  assert.match(vite, /publicDir:\s*'web-public'/)
  // 旧的隔离网关端口不得回流；非回环字面量由上面的通用守卫负责（不把旧 IP 原文写进断言）。
  assert.doesNotMatch(proxy, /9443/)
  assert.deepEqual(offendingHttpLiterals(proxy), [], 'proxy.js 含非回环、非保留域的 http(s) 字面量')
  assert.deepEqual(offendingPublicIpv4Literals(proxy), [], 'proxy.js 含公网 IPv4 字面量')
})

test('legacy Web loads Vant base styles before project theme overrides', async () => {
  const main = await read('../src/main.js')
  const verifyScript = await read('../scripts/verify-legacy-web-build.mjs')
  const vantStyleIndex = main.indexOf("import 'vant/lib/index.css'")
  const globalStyleIndex = main.indexOf("import './styles/global.css'")
  const responsiveStyleIndex = main.indexOf("import './styles/responsive.css'")

  assert.notEqual(vantStyleIndex, -1)
  assert.notEqual(globalStyleIndex, -1)
  assert.notEqual(responsiveStyleIndex, -1)
  assert.ok(vantStyleIndex < globalStyleIndex)
  assert.ok(globalStyleIndex < responsiveStyleIndex)
  for (const selector of ['.van-checkbox', '.van-dialog', '.van-overlay', '.van-popup', '.van-toast']) {
    assert.match(verifyScript, new RegExp(selector.replace('.', '\\.')))
  }
})

test('local fallback authentication is explicit, loopback-only and secret-free by default', async () => {
  const auth = await read('../src/services/authService.js')
  assert.match(auth, /VITE_ENABLE_LOCAL_DEV_AUTH/)
  assert.match(auth, /VITE_LOCAL_DEV_TEST_PASSWORD/)
  assert.match(auth, /VITE_LOCAL_DEV_SMS_CODE/)
  assert.match(auth, /!import\.meta\.env\.DEV \|\| !LOCAL_DEV_AUTH_ENABLED/)
  assert.doesNotMatch(auth, /trycloudflare|loca\.lt/)
  assert.doesNotMatch(auth, /LOCAL_DEV_TEST_PASSWORD\s*=\s*['"][^'"]+['"]/)
  assert.doesNotMatch(auth, /LOCAL_DEV_SMS_CODE\s*=\s*['"][^'"]+['"]/)
})
