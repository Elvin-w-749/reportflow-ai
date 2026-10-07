import { setTimeout as delay } from 'node:timers/promises'
import { access, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  acquireExclusiveDirectoryLock,
  releaseExclusiveDirectoryLockSync
} from '../../scripts/legacy-analysis-process-lock.mjs'

const [lockPath, startAtRaw, holdMsRaw, barrierDirectory = '', childId = ''] = process.argv.slice(2)
const startAt = Number(startAtRaw)
const holdMs = Number(holdMsRaw)

await delay(Math.max(0, startAt - Date.now()))

try {
  const waitForFile = async (path) => {
    for (;;) {
      try {
        await access(path)
        return
      } catch {
        await delay(10)
      }
    }
  }
  const testHooks = barrierDirectory && childId
    ? {
        afterObservedStale: async () => {
          await writeFile(resolve(barrierDirectory, `ready-${childId}`), '', { flag: 'wx' })
          await waitForFile(resolve(barrierDirectory, `go-${childId}`))
        }
      }
    : null
  const lock = await acquireExclusiveDirectoryLock({
    lockPath,
    targetId: 'legacy-analyze-v4-test',
    resumeStale: true,
    staleAfterMs: 0,
    testHooks
  })
  if (barrierDirectory && childId) {
    await writeFile(resolve(barrierDirectory, `acquired-${childId}`), '', { flag: 'wx' })
  }
  await delay(holdMs)
  const released = releaseExclusiveDirectoryLockSync(lock)
  process.stdout.write(`${JSON.stringify({ status: 'acquired', released })}\n`)
} catch {
  process.stdout.write(`${JSON.stringify({ status: 'blocked', released: false })}\n`)
}
