import { randomBytes } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync
} from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm
} from 'node:fs/promises'
import { resolve } from 'node:path'

const OWNER_FILE = 'owner.private.json'
const OWNER_KEYS = ['createdAt', 'ownerId', 'pid', 'targetId', 'version']
const RECOVERY_KEYS = [
  'createdAt', 'observedOwnerId', 'pid', 'recoveryId', 'targetId', 'version'
]
const OWNER_ID_RE = /^[0-9a-f]{64}$/

const sameKeys = (value, expected) => (
  value && typeof value === 'object' && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected)
)

const validOwner = (owner, targetId) => (
  sameKeys(owner, OWNER_KEYS)
  && owner.version === 1
  && OWNER_ID_RE.test(String(owner.ownerId || ''))
  && Number.isInteger(owner.pid)
  && owner.pid > 0
  && Number.isFinite(Date.parse(owner.createdAt))
  && owner.targetId === targetId
)

const sameOwner = (left, right) => (
  left?.version === right?.version
  && left?.ownerId === right?.ownerId
  && left?.pid === right?.pid
  && left?.createdAt === right?.createdAt
  && left?.targetId === right?.targetId
)

const validRecoveryFence = (value, expected) => (
  sameKeys(value, RECOVERY_KEYS)
  && value.version === 1
  && value.recoveryId === expected.recoveryId
  && value.observedOwnerId === expected.observedOwnerId
  && value.pid === expected.pid
  && value.createdAt === expected.createdAt
  && value.targetId === expected.targetId
)

const pathExists = async (path) => {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

const processIsAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

const writeOwnerDurably = async (directory, owner) => {
  const path = resolve(directory, OWNER_FILE)
  const handle = await open(path, 'wx')
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const readOwner = async (directory, targetId) => {
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('全局请求锁不是受信目录')
  }
  const owner = JSON.parse(await readFile(resolve(directory, OWNER_FILE), 'utf8'))
  if (!validOwner(owner, targetId)) {
    throw new Error('全局请求锁缺少可验证的所有者信息')
  }
  return owner
}

const readOwnerSync = (directory, targetId) => {
  try {
    const owner = JSON.parse(readFileSync(resolve(directory, OWNER_FILE), 'utf8'))
    return validOwner(owner, targetId) ? owner : null
  } catch {
    return null
  }
}

const prepareCandidate = async (candidatePath, owner) => {
  await mkdir(candidatePath)
  try {
    await writeOwnerDurably(candidatePath, owner)
  } catch (error) {
    await rm(candidatePath, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

const publishCandidate = async (candidatePath, lockPath) => {
  try {
    await rename(candidatePath, lockPath)
    return true
  } catch (error) {
    const occupied = await pathExists(lockPath)
    await rm(candidatePath, { recursive: true, force: true }).catch(() => {})
    if (occupied) return false
    throw error
  }
}

const acquireRecoveryFence = async (path, observedOwner, targetId) => {
  const fence = {
    version: 1,
    recoveryId: randomBytes(32).toString('hex'),
    observedOwnerId: observedOwner.ownerId,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    targetId
  }
  let handle
  try {
    handle = await open(path, 'wx')
    await handle.writeFile(`${JSON.stringify(fence)}\n`, 'utf8')
    await handle.sync()
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error('另一恢复进程已持有全局请求锁恢复栅栏')
    }
    throw error
  } finally {
    if (handle) await handle.close()
  }
  return fence
}

const releaseRecoveryFence = async (path, fence) => {
  try {
    const current = JSON.parse(await readFile(path, 'utf8'))
    if (!validRecoveryFence(current, fence)) return false
    await rm(path, { force: false })
    return true
  } catch {
    return false
  }
}

export async function acquireExclusiveDirectoryLock({
  lockPath,
  targetId,
  resumeStale = false,
  staleAfterMs = 30_000,
  testHooks = null
}) {
  const canonicalPath = resolve(lockPath)
  if (!targetId || !Number.isInteger(staleAfterMs) || staleAfterMs < 0) {
    throw new Error('全局请求锁参数无效')
  }

  const owner = {
    version: 1,
    ownerId: randomBytes(32).toString('hex'),
    pid: process.pid,
    createdAt: new Date().toISOString(),
    targetId
  }
  const candidatePath = `${canonicalPath}.candidate-${owner.ownerId}`
  const quarantinePath = `${canonicalPath}.stale-${owner.ownerId}`
  const recoveryFencePath = `${canonicalPath}.recovery.private.lock`

  if (await pathExists(recoveryFencePath)) {
    throw new Error('全局请求锁恢复栅栏仍存在，拒绝自动运行')
  }

  await prepareCandidate(candidatePath, owner)
  if (await publishCandidate(candidatePath, canonicalPath)) {
    return { lockPath: canonicalPath, owner, released: false }
  }

  if (!resumeStale) throw new Error('另一批次进程已持有全局请求锁')

  let observedOwner
  try {
    observedOwner = await readOwner(canonicalPath, targetId)
  } catch {
    throw new Error('全局请求锁缺少可验证的所有者信息，拒绝自动恢复')
  }
  if (processIsAlive(observedOwner.pid)) throw new Error('另一批次进程仍在运行')
  if (Date.now() - Date.parse(observedOwner.createdAt) < staleAfterMs) {
    throw new Error('失效锁尚未达到安全恢复等待时间')
  }

  if (typeof testHooks?.afterObservedStale === 'function') {
    await testHooks.afterObservedStale()
  }

  const recoveryFence = await acquireRecoveryFence(
    recoveryFencePath,
    observedOwner,
    targetId
  )
  let canonicalSafe = false
  let quarantined = false
  try {
    // The fixed recovery fence is the election. Re-read after winning it so a
    // delayed observer can never rename a lock published by another recovery.
    const currentOwner = await readOwner(canonicalPath, targetId)
    if (!sameOwner(observedOwner, currentOwner)) {
      canonicalSafe = true
      throw new Error('全局请求锁在恢复栅栏建立前已变化，拒绝继续')
    }
    if (processIsAlive(currentOwner.pid)) {
      canonicalSafe = true
      throw new Error('另一批次进程仍在运行')
    }
    await rename(canonicalPath, quarantinePath)
    quarantined = true

    const quarantinedOwner = await readOwner(quarantinePath, targetId)
    if (!sameOwner(observedOwner, quarantinedOwner)) {
      throw new Error('失效锁在原子隔离期间发生变化，拒绝继续')
    }

    await prepareCandidate(candidatePath, owner)
    const acquired = await publishCandidate(candidatePath, canonicalPath)
    if (!acquired) {
      canonicalSafe = await pathExists(canonicalPath)
      await rm(quarantinePath, { recursive: true, force: true }).catch(() => {})
      quarantined = false
      throw new Error('另一批次进程已完成全局请求锁接管')
    }
    canonicalSafe = true
    // The active canonical lock is already safe. Cleanup must never turn a
    // successful acquisition into an unowned live lock.
    await rm(quarantinePath, { recursive: true, force: true }).catch(() => {})
    quarantined = false
    return { lockPath: canonicalPath, owner, released: false }
  } catch (error) {
    if (quarantined && !await pathExists(canonicalPath)) {
      try {
        await rename(quarantinePath, canonicalPath)
        quarantined = false
        canonicalSafe = true
      } catch {}
    } else if (await pathExists(canonicalPath)) {
      canonicalSafe = true
    }
    throw error
  } finally {
    // If canonical safety could not be re-established, keep the fence as a
    // fail-closed marker that requires manual review.
    if (canonicalSafe) {
      await releaseRecoveryFence(recoveryFencePath, recoveryFence)
    }
  }
}

export function releaseExclusiveDirectoryLockSync(lock) {
  if (!lock || lock.released === true) return false
  const { lockPath, owner } = lock
  const currentOwner = readOwnerSync(lockPath, owner?.targetId)
  if (!currentOwner || !sameOwner(currentOwner, owner)) return false

  const releasePath = `${lockPath}.release-${owner.ownerId}-${randomBytes(8).toString('hex')}`
  try {
    renameSync(lockPath, releasePath)
  } catch {
    return false
  }

  const movedOwner = readOwnerSync(releasePath, owner.targetId)
  if (!movedOwner || !sameOwner(movedOwner, owner)) {
    try {
      if (!existsSync(lockPath)) renameSync(releasePath, lockPath)
    } catch {}
    return false
  }

  // The canonical path is no longer owned after the verified rename, so the
  // release itself succeeded even if best-effort artifact cleanup fails.
  lock.released = true
  try {
    rmSync(releasePath, { recursive: true, force: false })
  } catch {}
  return true
}
