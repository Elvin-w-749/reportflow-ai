import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  acquireExclusiveDirectoryLock,
  releaseExclusiveDirectoryLockSync
} from '../scripts/legacy-analysis-process-lock.mjs'

const targetId = 'legacy-analyze-v4-test'

const runChild = (
  lockPath,
  startAt,
  holdMs,
  barrierDirectory = '',
  childId = ''
) => new Promise((resolveChild, rejectChild) => {
  const helper = fileURLToPath(new URL('./helpers/acquire-v4-lock-child.mjs', import.meta.url))
  const child = spawn(process.execPath, [
    helper,
    lockPath,
    String(startAt),
    String(holdMs),
    barrierDirectory,
    childId
  ], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.once('error', rejectChild)
  child.once('exit', (code) => {
    if (code !== 0) {
      rejectChild(new Error(`lock child failed safely: ${code}; stderr-bytes=${stderr.length}`))
      return
    }
    resolveChild(JSON.parse(stdout.trim()))
  })
})

const waitForPath = async (path, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await access(path)
      return
    } catch {
      await delay(10)
    }
  }
  throw new Error('timed out waiting for deterministic lock barrier')
}

test('exclusive directory lock rejects a live owner and releases only itself', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'rpt-v4-lock-'))
  const lockPath = resolve(root, 'request.lock')
  try {
    const first = await acquireExclusiveDirectoryLock({ lockPath, targetId })
    await assert.rejects(
      acquireExclusiveDirectoryLock({ lockPath, targetId }),
      /另一批次进程已持有全局请求锁/
    )
    assert.equal(releaseExclusiveDirectoryLockSync(first), true)

    const second = await acquireExclusiveDirectoryLock({ lockPath, targetId })
    const ownerPath = resolve(lockPath, 'owner.private.json')
    const owner = JSON.parse(await readFile(ownerPath, 'utf8'))
    owner.ownerId = 'f'.repeat(64)
    await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, 'utf8')
    assert.equal(releaseExclusiveDirectoryLockSync(second), false)
    assert.equal(second.released, false)
    assert.equal((await readdir(lockPath)).includes('owner.private.json'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('two fresh cross-process candidates publish exactly one live owner', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'rpt-v4-lock-fresh-'))
  const lockPath = resolve(root, 'request.lock')
  try {
    const startAt = Date.now() + 500
    const results = await Promise.all([
      runChild(lockPath, startAt, 2_000),
      runChild(lockPath, startAt, 2_000)
    ])
    assert.equal(results.filter((result) => result.status === 'acquired').length, 1)
    assert.equal(results.filter((result) => result.status === 'blocked').length, 1)
    assert.equal(results.find((result) => result.status === 'acquired')?.released, true)
    assert.deepEqual(await readdir(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a residual recovery fence fails closed even with stale-resume approval', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'rpt-v4-lock-fence-'))
  const lockPath = resolve(root, 'request.lock')
  try {
    await writeFile(`${lockPath}.recovery.private.lock`, '{}\n', 'utf8')
    await assert.rejects(
      acquireExclusiveDirectoryLock({
        lockPath,
        targetId,
        resumeStale: true,
        staleAfterMs: 0
      }),
      /恢复栅栏仍存在/
    )
    assert.equal((await readdir(root)).includes('request.lock'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a delayed stale observer cannot rename a newly recovered live lock', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'rpt-v4-lock-race-'))
  const lockPath = resolve(root, 'request.lock')
  const barrierDirectory = resolve(root, 'barrier')
  try {
    await mkdir(lockPath)
    await mkdir(barrierDirectory)
    await writeFile(resolve(lockPath, 'owner.private.json'), `${JSON.stringify({
      version: 1,
      ownerId: 'a'.repeat(64),
      pid: 2147483647,
      createdAt: '2000-01-01T00:00:00.000Z',
      targetId
    })}\n`, 'utf8')

    const startAt = Date.now() + 500
    const first = runChild(lockPath, startAt, 2_500, barrierDirectory, 'first')
    const delayed = runChild(lockPath, startAt, 2_500, barrierDirectory, 'delayed')
    await Promise.all([
      waitForPath(resolve(barrierDirectory, 'ready-first')),
      waitForPath(resolve(barrierDirectory, 'ready-delayed'))
    ])

    await writeFile(resolve(barrierDirectory, 'go-first'), '', { flag: 'wx' })
    await waitForPath(resolve(barrierDirectory, 'acquired-first'))
    await writeFile(resolve(barrierDirectory, 'go-delayed'), '', { flag: 'wx' })
    const delayedResult = await delayed
    assert.equal(delayedResult.status, 'blocked')
    assert.equal((await readdir(lockPath)).includes('owner.private.json'), true)
    const firstResult = await first
    const results = [firstResult, delayedResult]
    assert.equal(results.filter((result) => result.status === 'acquired').length, 1)
    assert.equal(results.filter((result) => result.status === 'blocked').length, 1)
    assert.equal(results.find((result) => result.status === 'acquired')?.released, true)
    await rm(barrierDirectory, { recursive: true, force: true })
    assert.deepEqual(await readdir(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
