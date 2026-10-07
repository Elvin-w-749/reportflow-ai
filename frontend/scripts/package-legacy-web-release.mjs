import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const dist = resolve(root, process.env.LEGACY_WEB_OUTDIR || 'dist')
const releaseId = String(process.env.LEGACY_RELEASE_ID || '').trim()
const releaseRoot = resolve(root, 'release-work')
// 与 build-legacy-web.mjs / verify-legacy-web-build.mjs 同一派生口径：
// RPT_PROXY_BASE 为完整 origin，未设置即本机默认后端；API 命名空间恒为 /legacy-api。
const DEFAULT_API_ORIGIN = 'http://127.0.0.1:3200'
const apiOrigin = String(process.env.RPT_PROXY_BASE || '').trim() || DEFAULT_API_ORIGIN
const expectedApiBase = apiOrigin + '/legacy-api'

if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(releaseId)) {
  throw new Error('请设置安全的 LEGACY_RELEASE_ID，例如 20260722-legacy-web')
}
if (!existsSync(dist)) throw new Error('未找到 dist；请先运行 npm run build:legacy')

const gitStatus = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).trim()
if (gitStatus) throw new Error('工作区不干净；请提交或移除源码变更后重新构建')

const verify = spawnSync(process.execPath, ['scripts/verify-legacy-web-build.mjs', '--dir', dist], {
  cwd: root,
  stdio: 'inherit'
})
if (verify.error || verify.status !== 0) process.exit(verify.status ?? 1)

const output = resolve(releaseRoot, releaseId)
if (relative(releaseRoot, output).startsWith('..') || output === releaseRoot) {
  throw new Error('发布目录必须位于 release-work 内')
}
if (existsSync(output)) throw new Error('发布目录已存在：' + output)

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(full))
    else files.push(full)
  }
  return files
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const lockfileSha256 = sha256(await readFile(resolve(root, 'package-lock.json')))
const buildProvenancePath = resolve(dist, '.legacy-build-provenance.json')
if (!existsSync(buildProvenancePath)) {
  throw new Error('构建产物缺少 .legacy-build-provenance.json；请重新运行 npm run build:legacy')
}
const buildProvenance = JSON.parse(await readFile(buildProvenancePath, 'utf8'))
if (buildProvenance.gitCommit !== gitCommit) {
  throw new Error('构建产物不属于当前 Git 提交；请重新运行 npm run build:legacy')
}
if (buildProvenance.lockfileSha256 !== lockfileSha256) {
  throw new Error('构建产物与当前 package-lock.json 不一致；请重新运行 npm run build:legacy')
}
if (buildProvenance.apiBase !== expectedApiBase) {
  throw new Error('构建产物 API 基址证明不匹配')
}
if (existsSync(resolve(dist, 'release.json'))) {
  throw new Error('dist 不得预置 release.json；发布身份只能由打包步骤生成')
}
const releaseInfo = {
  schemaVersion: 1,
  service: 'rpt-legacy-web',
  releaseId,
  gitCommit,
  apiBase: expectedApiBase,
  lockfileSha256
}
const releaseInfoBytes = Buffer.from(JSON.stringify(releaseInfo, null, 2) + '\n')
const files = await listFiles(dist)
const manifestFiles = []
for (const file of files) {
  const bytes = await readFile(file)
  manifestFiles.push({
    path: relative(dist, file).replaceAll('\\', '/'),
    bytes: bytes.length,
    sha256: sha256(bytes)
  })
}
manifestFiles.push({
  path: 'release.json',
  bytes: releaseInfoBytes.length,
  sha256: sha256(releaseInfoBytes)
})
manifestFiles.sort((a, b) => a.path.localeCompare(b.path))

const manifest = {
  schemaVersion: 1,
  releaseId,
  gitCommit,
  apiBase: expectedApiBase,
  lockfileSha256,
  artifact: {
    fileCount: manifestFiles.length,
    files: manifestFiles
  }
}

await mkdir(output, { recursive: true })
await cp(dist, output, { recursive: true })
await writeFile(resolve(output, 'release.json'), releaseInfoBytes)
await writeFile(resolve(output, '.legacy-release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

console.log(JSON.stringify({
  ok: true,
  output,
  releaseId,
  gitCommit,
  fileCount: manifestFiles.length,
  apiBase: expectedApiBase
}, null, 2))
