import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcRoot = join(__dirname, '..', 'src')
const routerFile = join(srcRoot, 'router', 'index.js')

const routerText = readFileSync(routerFile, 'utf8')
const routes = new Set(
  [...routerText.matchAll(/path:\s*['"]([^'"]+)['"]/g)]
    .map((m) => m[1])
    .filter((path) => path.startsWith('/pages/'))
)

const refs = new Map()

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name)
    const stat = statSync(file)
    if (stat.isDirectory()) {
      walk(file)
      continue
    }
    if (!['.js', '.vue'].includes(extname(file))) continue
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/['"](\/pages\/[A-Za-z0-9_/-]+)(?:\?[^'"]*)?['"]/g)) {
      const path = match[1]
      if (!refs.has(path)) refs.set(path, new Set())
      refs.get(path).add(relative(srcRoot, file).replace(/\\/g, '/'))
    }
  }
}

walk(srcRoot)

let failed = false
for (const [path, files] of [...refs.entries()].sort()) {
  if (routes.has(path)) continue
  failed = true
  console.error(`[routes] missing ${path} referenced by ${[...files].join(', ')}`)
}

if (failed) process.exit(1)
console.log(`[routes] ok: ${refs.size} referenced /pages paths, ${routes.size} registered page routes`)
