import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, relative, sep } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_API_ORIGIN = 'http://127.0.0.1:3200'
const requestedApiOrigin = String(process.env.RPT_PROXY_BASE || '').trim()
// RPT_PROXY_BASE 值为完整 origin（如 https://your.domain.invalid）；未设置即用本机默认后端。
// 这里只校验「是不是合法 http(s) origin」，不再要求等于任何固定域名。
const resolveHttpOrigin = (raw, label) => {
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
const apiOrigin = requestedApiOrigin
  ? resolveHttpOrigin(requestedApiOrigin, 'RPT_PROXY_BASE')
  : DEFAULT_API_ORIGIN
// 忘配 RPT_PROXY_BASE 时产物会静默指向构建机的回环地址（src/config/proxy.js 对回环 HTTP
// 放行），公网用户拿到包就打不开接口。这里只告警不硬失败：CI 与本地演示构建都依赖
// 「不配置也能出包」，但必须让人在构建日志里看见这一次回落。
if (!requestedApiOrigin) {
  console.warn(
    [
      '',
      '┌──────────────────────────────────────────────────────────────────────────',
      '│ [build warning] RPT_PROXY_BASE 未设置，本次产物 API 基址回落为',
      '│                   ' + DEFAULT_API_ORIGIN + '/legacy-api',
      '│ 该地址只在构建机上可达。对外发布前请显式指定你自己的 origin：',
      '│   RPT_PROXY_BASE=https://your.domain.invalid npm run build:legacy',
      '└──────────────────────────────────────────────────────────────────────────',
      ''
    ].join('\n')
  )
}
const expectedApiBase = apiOrigin + '/legacy-api'
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const gitText = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

const gitCommitBefore = gitText('rev-parse', 'HEAD')
const gitStatusBefore = gitText('status', '--porcelain', '--untracked-files=all')
if (gitStatusBefore) throw new Error('工作区不干净；请先提交或移除源码变更再构建')
const lockfileSha256Before = sha256(await readFile(resolve(root, 'package-lock.json')))

const outputDir = resolve(root, process.env.LEGACY_WEB_OUTDIR || 'dist')
const outputRelative = relative(root, outputDir)
if (!outputRelative || outputRelative.startsWith('..' + sep) || outputRelative === '..') {
  throw new Error('LEGACY_WEB_OUTDIR 必须位于仓库内')
}

const viteBin = resolve(root, 'node_modules', 'vite', 'bin', 'vite.js')
if (!existsSync(viteBin)) {
  throw new Error('未找到 Vite。请先运行 npm ci')
}

const result = spawnSync(
  process.execPath,
  [viteBin, 'build', '--outDir', outputDir],
  {
    cwd: root,
    env: { ...process.env, RPT_PROXY_BASE: apiOrigin },
    stdio: 'inherit'
  }
)

if (result.error || result.status !== 0) process.exit(result.status ?? 1)

const verify = spawnSync(process.execPath, ['scripts/verify-legacy-web-build.mjs', '--dir', outputDir], {
  cwd: root,
  env: { ...process.env, RPT_PROXY_BASE: apiOrigin },
  stdio: 'inherit'
})

if (verify.error || verify.status !== 0) process.exit(verify.status ?? 1)

const gitCommitAfter = gitText('rev-parse', 'HEAD')
const gitStatusAfter = gitText('status', '--porcelain', '--untracked-files=all')
const lockfileSha256After = sha256(await readFile(resolve(root, 'package-lock.json')))
if (gitCommitAfter !== gitCommitBefore) throw new Error('构建期间 Git 提交发生变化；拒绝写入构建证明')
if (gitStatusAfter) throw new Error('构建期间工作区发生变化；拒绝写入构建证明')
if (lockfileSha256After !== lockfileSha256Before) throw new Error('构建期间 package-lock.json 发生变化；拒绝写入构建证明')
await writeFile(resolve(outputDir, '.legacy-build-provenance.json'), JSON.stringify({
  schemaVersion: 1,
  gitCommit: gitCommitBefore,
  lockfileSha256: lockfileSha256Before,
  apiBase: expectedApiBase
}, null, 2) + '\n')
