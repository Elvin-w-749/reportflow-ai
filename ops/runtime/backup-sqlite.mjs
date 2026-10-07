import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(new URL('../../backend/package.json', import.meta.url))
const Database = require('better-sqlite3')
const [sourceArg, destinationArg] = process.argv.slice(2)

if (!sourceArg || !destinationArg) {
  console.error('Usage: node ops/runtime/backup-sqlite.mjs SOURCE_DB DESTINATION_DB')
  process.exit(64)
}

const source = resolve(root, sourceArg)
const destination = resolve(root, destinationArg)
if (!existsSync(source)) throw new Error(`源数据库不存在：${source}`)
if (existsSync(destination)) throw new Error(`目标数据库已存在：${destination}`)

const sourceDb = new Database(source, { readonly: true, fileMustExist: true })
try {
  await sourceDb.backup(destination)
} finally {
  sourceDb.close()
}

const backupDb = new Database(destination, { readonly: true, fileMustExist: true })
try {
  const integrity = backupDb.pragma('integrity_check', { simple: true })
  const tables = backupDb.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map((row) => row.name)
  const counts = Object.fromEntries(tables.map((table) => {
    const quoted = `"${table.replaceAll('"', '""')}"`
    return [table, backupDb.prepare(`SELECT COUNT(*) AS count FROM ${quoted}`).get().count]
  }))
  if (integrity !== 'ok') throw new Error(`备份数据库完整性失败：${integrity}`)
  console.log(JSON.stringify({ ok: true, source, destination, integrity, tables, counts }, null, 2))
} finally {
  backupDb.close()
}
