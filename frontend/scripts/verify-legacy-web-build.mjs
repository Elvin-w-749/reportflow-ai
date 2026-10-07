import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, extname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const argIndex = process.argv.indexOf('--dir')
const outputDir = resolve(root, argIndex >= 0 ? process.argv[argIndex + 1] : (process.env.LEGACY_WEB_OUTDIR || 'dist'))
const outputRelative = relative(root, outputDir)
const DEFAULT_API_ORIGIN = 'http://127.0.0.1:3200'
// 与 build-legacy-web.mjs / package-legacy-web-release.mjs 同一派生口径：
// RPT_PROXY_BASE 是完整 origin，未设置即校验本机默认后端；API 命名空间恒为 /legacy-api。
const apiOrigin = String(process.env.RPT_PROXY_BASE || '').trim() || DEFAULT_API_ORIGIN
const expectedApiBase = apiOrigin + '/legacy-api'
const readableExtensions = new Set(['.html', '.js', '.css', '.json', '.map'])

if (!outputRelative || outputRelative.startsWith('..' + sep) || outputRelative === '..') {
  throw new Error('构建验证目录必须位于仓库内')
}
if (!existsSync(outputDir)) throw new Error('未找到构建目录：' + outputDir)
if (!existsSync(resolve(outputDir, 'index.html'))) throw new Error('构建目录缺少 index.html')

async function filesUnder(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) files.push(...await filesUnder(full))
    else files.push(full)
  }
  return files
}

const files = await filesUnder(outputDir)
let source = ''
for (const file of files) {
  if (!readableExtensions.has(extname(file).toLowerCase())) continue
  source += await readFile(file, 'utf8')
}

const failures = []
if (!source.includes(expectedApiBase)) failures.push('产物未注入旧版 API 基址')
for (const selector of ['.van-checkbox', '.van-dialog', '.van-overlay', '.van-popup', '.van-toast']) {
  if (!source.includes(selector)) failures.push('产物缺少 Vant 基础样式：' + selector)
}
// 反向断言：产物只能带上一条网关串（expectedApiBase）。凡是不该出现的网关形态——
// 旧原生/最新版命名空间 <origin>/api、以及退役的 3000 旧网关端口——一律判失败。
// 若允许基址本身恰好覆盖了某条禁止串，则跳过该条，避免检查自相矛盾。
const forbiddenAddresses = [
  apiOrigin + '/api',
  'localhost:3000',
  '127.0.0.1:3000'
].filter((address) => !expectedApiBase.includes(address))
for (const forbidden of forbiddenAddresses) {
  if (source.includes(forbidden)) failures.push('产物包含禁止地址：' + forbidden)
}

if (failures.length) throw new Error(failures.join('\n'))

console.log(JSON.stringify({
  ok: true,
  outputDir,
  fileCount: files.length,
  apiBase: expectedApiBase
}, null, 2))
