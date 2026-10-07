import { readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/**
 * 阶段 0 受保护文本文件清单（合同、schema、校验器、CI、包清单、部署示例）。
 *
 * 锚定方式（本仓库不携带上游开发历史，因此不引用任何 commit SHA / ref / blob pin）：
 *   1. 每条受保护路径的 sha256 写进独立数据文件 docs/contracts/phase0-protected.lock.json。
 *   2. 本脚本读当前文件 → 同样的规范化 → 取 sha256 → 与锁比对 → 不一致即 lock-drift:<path> 失败。
 *   3. 锁条目集合必须**恰好等于**硬编码受保护集合：删条目、加条目都判失败，不能靠「少锁一条」过关。
 *
 * 为什么锁写在独立文件而不是本脚本里：校验器给自身字节签名没有意义（改脚本的人一定会顺手改
 * 脚本里的哈希），而独立 JSON 在 review 时是可读的 diff，也与既有 docs/contracts/*.json
 * 和 requirements.lock.txt 的「声明值 + 校验器」同构。信任边界因此是「锁文件的 PR diff」，
 * 不是脚本自证。
 *
 * 规范化：CRLF/CR → LF，去掉起始 BOM 后再取哈希。.gitattributes 里 * text=auto 覆盖到的
 * 无扩展名文件（.gitattributes 自身、backend/.env.example）在不同平台的检出换行不同，
 * 不归一化会让同一份内容在 Windows 与 Linux CI 上得到两个哈希。
 */
const phase0Paths = Object.freeze([
  '.github/workflows/verify.yml',
  'backend/.env.example',
  'docs/PRD.md',
  'docs/architecture/ADR-0001-DUAL-MODEL-CREDIT-ANALYSIS.md',
  'docs/contracts/CREDIT_ANALYSIS_PHASE0_CONTRACT.md',
  'docs/contracts/OCR_STRUCTURED_V1.md',
  'docs/contracts/credit-analysis-phase0.contract.json',
  'docs/contracts/credit-analysis-phase0.schema.json',
  'docs/contracts/ocr-structured-v1.schema.json',
  'docs/product/PRD-DELTA-005-DUAL-MODEL-CREDIT-ANALYSIS.md',
  'docs/security/CREDIT_ANALYSIS_PROVIDER_SECURITY.md',
  'package.json',
  'package-lock.json',
  'scripts/phase0-contract-negative-fixtures.mjs',
  'scripts/phase0-contract-validator.mjs',
  'scripts/secret-scan-policy.mjs',
  'scripts/verify-phase0-contracts.mjs',
  'scripts/verify-repository.mjs'
])

const gitattributesPaths = Object.freeze([
  '.gitattributes',
  'backend/.gitattributes',
  'frontend/.gitattributes'
])

const verifierPath = 'scripts/verify-phase0-contracts.mjs'
// 受保护集合 = 18 条阶段 0 文本 + 3 份 .gitattributes。
const protectedPaths = Object.freeze([...phase0Paths, ...gitattributesPaths])
const EXPECTED_PROTECTED_PATH_COUNT = 21
const lockPath = 'docs/contracts/phase0-protected.lock.json'
const LOCK_ALGORITHM = 'sha256'
const LOCK_NORMALIZATION = 'utf8; CRLF/CR converted to LF; leading BOM removed'
const updateLockRequested = process.argv.includes('--update-lock')
const failures = []

const normalizePathSet = (values) => [...new Set((values || []).map((value) => String(value).replaceAll('\\', '/')))].sort()
const samePathSet = (left, right) => JSON.stringify(normalizePathSet(left)) === JSON.stringify(normalizePathSet(right))

function gitText(args) {
  return execFileSync('git', ['--no-replace-objects', ...args], { cwd: root, encoding: 'utf8' }).trim()
}

function gitPathList(args) {
  const value = gitText(args)
  return value ? value.split(/\r?\n/).filter(Boolean).map((path) => path.replaceAll('\\', '/')) : []
}

function normalizeCheckoutBytes(buffer) {
  let bytes = Buffer.from(buffer)
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3)
  return Buffer.from(bytes.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8')
}

function sha256Hex(buffer) {
  return createHash('sha256').update(normalizeCheckoutBytes(buffer)).digest('hex')
}

function reportFailures() {
  if (!failures.length) return false
  console.error([...new Set(failures)].join('\n'))
  return true
}

// ── 受保护集合自身的形状检查（不依赖锁文件，防止清单被悄悄改短）────────────────
if (
  protectedPaths.length !== EXPECTED_PROTECTED_PATH_COUNT ||
  normalizePathSet(protectedPaths).length !== EXPECTED_PROTECTED_PATH_COUNT
) failures.push('phase0.protected-path-contract')
if (!protectedPaths.includes(verifierPath)) failures.push('phase0.verifier-not-protected')
if (!samePathSet(gitattributesPaths, normalizePathSet(gitattributesPaths))) failures.push('phase0.gitattributes-path-contract')

// ── 现算当前受保护文件的规范化 sha256 ───────────────────────────────────────
const currentDigests = new Map()
for (const path of protectedPaths) {
  try {
    currentDigests.set(path, sha256Hex(await readFile(resolve(root, path))))
  } catch (_) {
    failures.push(`lock-file-missing:${path}`)
  }
}

// ── --update-lock：把现算值写成锁文件（内容冻结后的最后一步，不参与日常校验）──
if (updateLockRequested) {
  if (currentDigests.size !== protectedPaths.length) {
    failures.push('lock.update-refused:protected-file-unreadable')
    if (reportFailures()) process.exit(1)
  }
  const payload = {
    schemaVersion: 1,
    algorithm: LOCK_ALGORITHM,
    normalization: LOCK_NORMALIZATION,
    generatedBy: 'node scripts/verify-phase0-contracts.mjs --update-lock',
    description: '阶段 0 受保护路径的字节锚点。改任一受保护文件必须同时重跑 --update-lock 并复核 diff。',
    files: Object.fromEntries(normalizePathSet(protectedPaths).map((path) => [path, currentDigests.get(path)]))
  }
  await writeFile(resolve(root, lockPath), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({
    ok: true,
    lockWritten: lockPath,
    algorithm: LOCK_ALGORITHM,
    normalization: LOCK_NORMALIZATION,
    protectedPaths: protectedPaths.length,
    lockEntries: Object.keys(payload.files).length
  }, null, 2))
  process.exit(0)
}

// ── 读锁并逐条比对 ─────────────────────────────────────────────────────────
let protectedLock = null
try {
  protectedLock = JSON.parse(normalizeCheckoutBytes(await readFile(resolve(root, lockPath))).toString('utf8'))
} catch (_) {
  failures.push('lock.unreadable')
}

let protectedLockDigestChecks = 0
let trackedGitattributesCount = 0
if (protectedLock) {
  if (protectedLock?.algorithm !== LOCK_ALGORITHM) failures.push('lock.algorithm')
  if (protectedLock?.normalization !== LOCK_NORMALIZATION) failures.push('lock.normalization')
  const lockFiles = protectedLock?.files
  if (!lockFiles || typeof lockFiles !== 'object' || Array.isArray(lockFiles)) {
    failures.push('lock.files-shape')
  } else {
    const lockPaths = Object.keys(lockFiles)
    // 条目集合必须恰好等于硬编码受保护集合：少一条或多一条都判失败。
    if (!samePathSet(lockPaths, protectedPaths)) {
      failures.push('lock.path-set-mismatch')
      for (const path of protectedPaths) {
        if (!lockPaths.includes(path)) failures.push(`lock-entry-missing:${path}`)
      }
      for (const path of lockPaths) {
        if (!protectedPaths.includes(path)) failures.push(`lock-entry-extra:${path}`)
      }
    }
    if (lockPaths.length !== EXPECTED_PROTECTED_PATH_COUNT) failures.push('lock.entry-count')
    for (const path of protectedPaths) {
      const expected = lockFiles[path]
      const actual = currentDigests.get(path)
      protectedLockDigestChecks += 1
      if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) {
        failures.push(`lock-entry-invalid:${path}`)
        continue
      }
      if (!actual || actual !== expected) failures.push(`lock-drift:${path}`)
    }
  }
}

// ── 检出内容一致性：换行必须由 .gitattributes 管住，且不得出现第二份 .gitattributes
try {
  const trackedAttributes = gitPathList(['ls-files']).filter((path) => (
    path === '.gitattributes' || path.endsWith('/.gitattributes')
  ))
  trackedGitattributesCount = trackedAttributes.length
  if (!samePathSet(trackedAttributes, gitattributesPaths)) failures.push('phase0.gitattributes-tracked-path-set')
} catch (_) {
  failures.push('phase0.gitattributes-unavailable')
}

const [ajvModule, secretPolicyModule, validatorModule, fixturesModule] = await Promise.all([
  import('ajv/dist/2020.js'),
  import('./secret-scan-policy.mjs'),
  import('./phase0-contract-validator.mjs'),
  import('./phase0-contract-negative-fixtures.mjs')
])
const Ajv2020 = ajvModule.default
const { detectSecretKinds, SECRET_DETECTOR_NAMES } = secretPolicyModule
const {
  detectPiiKinds,
  normalizeProviderPageBboxes,
  validateOcrStructuredDocument,
  validatePhase0ContractBundle
} = validatorModule
const {
  benignSecretFixtures,
  buildValidOcrDocument,
  contractMutationFixtures,
  contractSchemaCoDriftFixtures,
  ocrSemanticNegativeFixtures,
  piiDetectionFixtures,
  providerBboxNegativeFixtures,
  schemaMutationFixtures,
  secretDetectionFixtures,
  validProviderBboxFixture
} = fixturesModule

const buffers = new Map(await Promise.all(phase0Paths.map(async (path) => [
  path,
  await readFile(resolve(root, path))
])))
const currentDeepSeekRuntime = await readFile(
  resolve(root, 'backend/backend/services/creditAnalysisService.js'),
  'utf8'
)
const decoder = new TextDecoder('utf-8', { fatal: true })
const sources = new Map()

for (const marker of [
  'const DEFAULT_CREDIT_CHUNK_CONCURRENCY = 3',
  'process.env.DEEPSEEK_MAX_ATTEMPTS',
  'Math.min(5, Math.max(1, Math.trunc(configuredAttempts)))',
  'resp.status === 429',
  'resp.status >= 500',
  'setTimeout(r, 800 * attempt)',
  'DEFAULT_CREDIT_CHUNK_CONCURRENCY,\n\t\t\t1,\n\t\t\t4'
]) {
  if (!currentDeepSeekRuntime.includes(marker)) failures.push('deepseek-runtime-parity')
}
const deepseekSingleCall = currentDeepSeekRuntime.slice(
  currentDeepSeekRuntime.indexOf('async function callCreditChatStreamOnce'),
  currentDeepSeekRuntime.indexOf('async function callCreditChatStream(', currentDeepSeekRuntime.indexOf('async function callCreditChatStreamOnce'))
)
if (/\bsignal\s*:|AbortController/.test(deepseekSingleCall)) failures.push('deepseek-runtime-unreviewed-timeout')

for (const [path, buffer] of buffers) {
  const extension = extname(path).toLowerCase()
  if (!['.md', '.json', '.mjs', '.yml', '.example'].includes(extension)) {
    failures.push(`phase0.file-extension:${path}`)
    continue
  }
  if (buffer.includes(0)) {
    failures.push(`phase0.binary:${path}`)
    continue
  }
  let source
  try { source = decoder.decode(buffer) } catch (_) {
    failures.push(`phase0.invalid-utf8:${path}`)
    continue
  }
  sources.set(path, source)
  const secretKinds = detectSecretKinds(source)
  if (secretKinds.length) failures.push(`phase0.secret:${path}:${secretKinds.join(',')}`)
  const piiKinds = detectPiiKinds(source)
  if (piiKinds.length) failures.push(`phase0.pii:${path}:${piiKinds.join(',')}`)
}

const contractPath = 'docs/contracts/credit-analysis-phase0.contract.json'
const contractSchemaPath = 'docs/contracts/credit-analysis-phase0.schema.json'
const schemaPath = 'docs/contracts/ocr-structured-v1.schema.json'
let contract
let contractSchema
let schema
try { contract = JSON.parse(sources.get(contractPath)) } catch (_) { failures.push('contract.invalid-json') }
try { contractSchema = JSON.parse(sources.get(contractSchemaPath)) } catch (_) { failures.push('contract-schema.invalid-json') }
try { schema = JSON.parse(sources.get(schemaPath)) } catch (_) { failures.push('schema.invalid-json') }

let validateMachineContract = null
let validateOcrSchema = null
if (contract && contractSchema && schema) {
  try {
    const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false })
    validateMachineContract = ajv.compile(contractSchema)
    validateOcrSchema = ajv.compile(schema)
  } catch (_) {
    failures.push('ajv.schema-compile-failed')
  }
  if (validateMachineContract && !validateMachineContract(contract)) failures.push('ajv.machine-contract-invalid')
  for (const code of validatePhase0ContractBundle({ contract, schema })) failures.push(`baseline:${code}`)

  for (const fixture of [...contractMutationFixtures, ...schemaMutationFixtures]) {
    const mutated = structuredClone({ contract, schema })
    fixture.mutate(mutated)
    const errors = validatePhase0ContractBundle(mutated)
    if (!errors.includes(fixture.expected)) failures.push(`mutation-not-rejected:${fixture.name}:${fixture.expected}`)
    if (fixture.machineSchemaReject === true && validateMachineContract && validateMachineContract(mutated.contract)) {
      failures.push(`machine-schema-mutation-not-rejected:${fixture.name}`)
    }
  }
  for (const fixture of contractSchemaCoDriftFixtures) {
    const mutatedContract = structuredClone(contract)
    const mutatedContractSchema = structuredClone(contractSchema)
    fixture.mutateContract(mutatedContract)
    fixture.mutateSchema(mutatedContractSchema)
    try {
      const coDriftAjv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false })
      const validateCoDrift = coDriftAjv.compile(mutatedContractSchema)
      if (!validateCoDrift(mutatedContract)) failures.push(`contract-schema-codrift-not-exercised:${fixture.name}`)
    } catch (_) {
      failures.push(`contract-schema-codrift-compile-failed:${fixture.name}`)
    }
    const semanticErrors = validatePhase0ContractBundle({ contract: mutatedContract, schema })
    if (!semanticErrors.includes(fixture.expected)) failures.push(`contract-schema-codrift-not-rejected:${fixture.name}`)
  }

  const validOcr = buildValidOcrDocument()
  if (validateOcrSchema && !validateOcrSchema(validOcr)) failures.push('ajv.ocr-valid-rejected')
  const validErrors = validateOcrStructuredDocument(validOcr, schema, contract)
  if (validErrors.length) failures.push(`ocr-valid-rejected:${validErrors.join(',')}`)
  for (const fixture of ocrSemanticNegativeFixtures) {
    const mutated = structuredClone(validOcr)
    fixture.mutate(mutated)
    const errors = validateOcrStructuredDocument(mutated, schema, contract)
    if (!errors.includes(fixture.expected)) failures.push(`ocr-negative-not-rejected:${fixture.name}:${fixture.expected}`)
    if (fixture.schemaReject === true && validateOcrSchema && validateOcrSchema(mutated)) {
      failures.push(`ocr-schema-negative-not-rejected:${fixture.name}`)
    }
  }
}

for (const fixture of secretDetectionFixtures) {
  const kinds = detectSecretKinds(fixture.makeValue())
  if (!kinds.includes(fixture.expected)) failures.push(`secret-fixture-not-detected:${fixture.name}`)
}
for (const [index, value] of benignSecretFixtures.entries()) {
  if (detectSecretKinds(value).length) failures.push(`secret-benign-rejected:${index + 1}`)
}
for (const fixture of piiDetectionFixtures) {
  const kinds = detectPiiKinds(fixture.makeValue())
  if (!kinds.includes(fixture.expected)) failures.push(`pii-fixture-not-detected:${fixture.name}`)
}
if (contract) {
  const validBbox = normalizeProviderPageBboxes(
    validProviderBboxFixture.rawBboxes,
    validProviderBboxFixture.renderedBounds,
    contract
  )
  if (!validBbox.ok || JSON.stringify(validBbox.bboxes) !== JSON.stringify(validProviderBboxFixture.expected)) {
    failures.push('provider-bbox-valid-rejected')
  }
  for (const fixture of providerBboxNegativeFixtures) {
    const result = normalizeProviderPageBboxes(
      fixture.rawBboxes,
      fixture.renderedBounds || validProviderBboxFixture.renderedBounds,
      contract
    )
    if (!result.errors.includes(fixture.expected)) failures.push(`provider-bbox-negative-not-rejected:${fixture.name}`)
  }
}

function requireText(path, markers, forbidden = []) {
  const source = sources.get(path) || ''
  for (const marker of markers) {
    if (!source.includes(marker)) failures.push(`document-marker-missing:${path}:${marker}`)
  }
  for (const marker of forbidden) {
    if (source.includes(marker)) failures.push(`document-forbidden-marker:${path}:${marker}`)
  }
}

requireText('docs/product/PRD-DELTA-005-DUAL-MODEL-CREDIT-ANALYSIS.md', [
  '阶段 0 不调用真实模型',
  '`review_required`',
  'document hard gate',
  '`inactive / not_activated`',
  '不代表已批准上线'
])
requireText('docs/architecture/ADR-0001-DUAL-MODEL-CREDIT-ANALYSIS.md', [
  '阶段 0 不改变生产行为',
  'OCR_RECORD_MEMBERSHIP_UNPROVEN',
  'existing-verified-runtime-v1',
  'unknown_permanent',
  'currentDeepSeekDeadlineEnforced=false',
  'executionCompletion` 为 `any`'
])
requireText('docs/contracts/CREDIT_ANALYSIS_PHASE0_CONTRACT.md', [
  'GLM page attempt',
  'DeepSeek request/chunk attempt',
  'existing-verified-runtime-v1',
  'unknown_permanent',
  'raw/candidate',
  'backgroundCancellationGuarantee=false'
])
requireText('docs/contracts/OCR_STRUCTURED_V1.md', [
  'rendered-image-pixels',
  'glm-normalized-region-bbox-to-rendered-pixels-v1',
  'rawResponseMaxBytesPerPage',
  'verifiedBlank=true',
  'OCR_RECORD_MEMBERSHIP_UNPROVEN',
  'table/thead/tbody/tr/th/td',
  'rowspan/colspan',
  'provider-bbox.rounded-extent',
  'ocr.page-overlap',
  'ocr.source-line-count-consistency',
  '最多 3 位小数'
])
requireText('docs/security/CREDIT_ANALYSIS_PROVIDER_SECURITY.md', [
  '下游应用终端用户数据',
  '去标识化',
  '不可逆',
  'nearest-rank',
  '25 次'
], [
  '公开隐私政策明确覆盖 API/open-platform 服务'
])
requireText('.github/workflows/verify.yml', ['npm ci --no-audit --no-fund', 'node scripts/verify-phase0-contracts.mjs'])
requireText('package.json', ['"verify:phase0-contracts": "node scripts/verify-phase0-contracts.mjs"', '"ajv": "8.20.0"'])

const envLines = (sources.get('backend/.env.example') || '').split(/\r?\n/)
for (const variable of ['DEEPSEEK_API_KEY', 'ZHIPU_GLM_OCR_API_KEY']) {
  const lines = envLines.filter((line) => line.startsWith(`${variable}=`))
  if (lines.length !== 1 || lines[0] !== `${variable}=`) failures.push(`env-secret-not-blank:${variable}`)
}

const markdownPaths = [...buffers.keys()].filter((path) => path.endsWith('.md'))
for (const path of markdownPaths) {
  const source = sources.get(path) || ''
  for (const match of source.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1]
    if (/^(?:https?:|mailto:|#)/.test(target)) continue
    const resolved = resolve(root, path, '..', decodeURIComponent(target.split('#')[0]))
    try { await readFile(resolved) } catch (_) { failures.push(`markdown-link-missing:${path}:${target}`) }
  }
}

if (reportFailures()) process.exit(1)

console.log(JSON.stringify({
  ok: true,
  contractId: contract.contractId,
  ajvDraft202012SchemasCompiled: 2,
  phase0TextFiles: phase0Paths.length,
  protectedPaths: protectedPaths.length,
  protectedPathBytesLocked: protectedLockDigestChecks,
  protectedLockPath: lockPath,
  protectedLockEntries: protectedLock?.files ? Object.keys(protectedLock.files).length : 0,
  trackedGitattributesCount,
  contractMutationFixtures: contractMutationFixtures.length,
  contractSchemaCoDriftFixtures: contractSchemaCoDriftFixtures.length,
  schemaMutationFixtures: schemaMutationFixtures.length,
  ocrSemanticNegativeFixtures: ocrSemanticNegativeFixtures.length,
  ocrSchemaNegativeFixtures: ocrSemanticNegativeFixtures.filter((fixture) => fixture.schemaReject).length,
  providerBboxNegativeFixtures: providerBboxNegativeFixtures.length,
  secretDetectorFixtures: secretDetectionFixtures.length,
  secretDetectorKinds: SECRET_DETECTOR_NAMES.length,
  piiDetectorFixtures: piiDetectionFixtures.length,
  providerErrors: contract.errors.length
}, null, 2))
