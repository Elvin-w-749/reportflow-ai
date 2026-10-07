import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectSecretKinds } from './secret-scan-policy.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
const tracked = git('ls-files', '-z').split('\0').filter(Boolean)
const errors = []

if (!tracked.length) errors.push('仓库没有已跟踪文件')

const forbiddenSegments = new Set([
  'node_modules', 'dist', 'dist-ssr', 'coverage', '.tmp', '.cache',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '__pycache__', '.venv',
  'venv', 'env', 'release-work', 'release-artifacts', 'audit'
])
const forbiddenExtensions = new Set([
  '.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.db', '.sqlite',
  '.sqlite3', '.log', '.jsonl', '.pdf', '.onnx', '.ort', '.whl', '.apk',
  '.aab', '.ipa', '.tgz', '.tar', '.gz', '.zip', '.bundle'
])
const backendImageExtensions = new Set([
  '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp'
])
const backendRuntimePrefixes = [
  'backend/data/', 'backend/data-local/', 'backend/data-test/',
  'backend/uploads/', 'backend/logs/', 'backend/tmp/', 'backend/wheelhouse/',
  'backend/models/', 'backend/ocr/models/'
]

for (const path of tracked) {
  const normalized = path.replaceAll('\\', '/')
  const segments = normalized.split('/')
  const base = segments.at(-1) || ''
  const extension = extname(base).toLowerCase()
  const envFile = base === '.env' || (base.startsWith('.env.') && base !== '.env.example')
  if (segments.some((segment) => forbiddenSegments.has(segment))) errors.push(`禁止目录：${normalized}`)
  if (envFile || base === '.npmrc') errors.push(`禁止配置：${normalized}`)
  if (forbiddenExtensions.has(extension) || /\.(?:db|sqlite)-/i.test(base)) errors.push(`禁止文件：${normalized}`)
  if (backendRuntimePrefixes.some((prefix) => normalized.startsWith(prefix))) errors.push(`后端运行文件：${normalized}`)
  if (normalized.startsWith('backend/') && backendImageExtensions.has(extension)) errors.push(`后端图片材料：${normalized}`)
  if (/\.(?:token|private)(?:\.|$)/i.test(base)) errors.push(`私密文件：${normalized}`)
  const fullPath = resolve(root, normalized)
  if (statSync(fullPath).size > 10 * 1024 * 1024) errors.push(`文件超过 10 MiB：${normalized}`)
}

const indexEntries = git('ls-files', '-s', '-z').split('\0').filter(Boolean)
for (const entry of indexEntries) {
  if (entry.startsWith('120000 ') || entry.startsWith('160000 ')) {
    errors.push(`禁止符号链接或子模块：${entry.split('\t').at(-1)}`)
  }
}

for (const path of tracked) {
  const extension = extname(path).toLowerCase()
  if (backendImageExtensions.has(extension) || extension === '.pdf') continue
  const buffer = readFileSync(resolve(root, path))
  if (buffer.includes(0)) continue
  let source = buffer.toString('utf8')
  if (path === 'backend/tests/deploymentSecurityBlockers.test.js') {
    source = source.replace(/\bsk-upstream-[A-Za-z0-9_-]+\b/g, '')
  }
  const secretKinds = detectSecretKinds(source)
  if (secretKinds.length) errors.push(`疑似凭据(${secretKinds.join(',')})：${path}`)
}

const frontendLibrary = readFileSync(resolve(root, 'frontend/src/shared/productLibrary.json'))
const backendLibrary = readFileSync(resolve(root, 'backend/src/shared/productLibrary.json'))
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const frontendLibraryHash = sha256(frontendLibrary)
const backendLibraryHash = sha256(backendLibrary)
if (frontendLibraryHash !== backendLibraryHash) errors.push('前后端 productLibrary.json 已发生漂移')

if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}

console.log(JSON.stringify({
  ok: true,
  trackedFiles: tracked.length,
  productLibrarySha256: frontendLibraryHash
}, null, 2))
