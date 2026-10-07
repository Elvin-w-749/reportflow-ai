'use strict'

const fs = require('fs')

const [cutoffRaw, ...files] = process.argv.slice(2)
const cutoff = Date.parse(cutoffRaw)
const auditEnd = process.env.AUDIT_END ? Date.parse(process.env.AUDIT_END) : Date.now()
if (!Number.isFinite(cutoff) || files.length === 0) process.exit(2)

function redact(value) {
  return String(value || '')
    .replace(/-----BEGIN[\s\S]*?PRIVATE KEY-----/gi, '[redacted-private-key]')
    .replace(/\b(?:sk|ak)-[A-Za-z0-9_-]{8,}\b/gi, '[redacted-key]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}=*/gi, 'Bearer [redacted-token]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted-token]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\b1[3-9]\d{9}\b/g, '[redacted-phone]')
    .replace(/\b\d{17}[\dXx]\b/g, '[redacted-id]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-ip]')
    .replace(/\b(?:REPORT|LOCAL|USR|U)_[A-Za-z0-9_-]{6,}\b/gi, '[redacted-id]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[redacted-hash]')
    .replace(/\b\d{8,}\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220)
}

function levelName(level) {
  const n = Number(level)
  if (n >= 60) return 'fatal'
  if (n >= 50) return 'error'
  if (n >= 40) return 'warn'
  if (n >= 30) return 'info'
  if (n >= 20) return 'debug'
  if (n >= 10) return 'trace'
  return String(level || 'unknown').toLowerCase()
}

function timestampOf(obj, line) {
  for (const key of ['ts', 'time', 'timestamp', 'date']) {
    const value = obj && obj[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      const ms = value < 1e12 ? value * 1000 : value
      if (Number.isFinite(ms)) return ms
    }
    if (typeof value === 'string') {
      const ms = Date.parse(value)
      if (Number.isFinite(ms)) return ms
    }
  }
  const match = String(line).match(/(?:^|\[)(20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/)
  if (match) {
    const ms = Date.parse(match[1])
    if (Number.isFinite(ms)) return ms
  }
  return null
}

function classifyNonJson(line) {
  const s = String(line).toLowerCase()
  if (/timeout|timed out|aborterror/.test(s)) return 'timeout'
  if (/econnreset|socket hang up|broken pipe|epipe/.test(s)) return 'connection_reset'
  if (/econnrefused|connection refused/.test(s)) return 'connection_refused'
  if (/out of memory|heap limit|oom/.test(s)) return 'memory'
  if (/uncaught|unhandled/.test(s)) return 'uncaught_or_unhandled'
  if (/syntaxerror|typeerror|referenceerror|rangeerror/.test(s)) return 'runtime_exception'
  if (/error/.test(s)) return 'other_error_text'
  if (/warn/.test(s)) return 'warning_text'
  return 'other_non_json'
}

function inc(map, key, amount = 1) {
  map[key] = (map[key] || 0) + amount
}

const results = []
for (const file of files) {
  let content
  let stat
  try {
    stat = fs.statSync(file)
    content = fs.readFileSync(file, 'utf8')
  } catch (error) {
    results.push({ file, readError: error.code || 'READ_FAILED' })
    continue
  }
  const lines = content.split(/\r?\n/).filter(Boolean)
  const levels7d = {}
  const messages7d = {}
  const codes7d = {}
  const nonJsonAll = {}
  let jsonLines = 0
  let timestampedLines = 0
  let inWindow = 0
  let nonJsonLines = 0
  let minTs = null
  let maxTs = null

  for (const line of lines) {
    let obj = null
    try { obj = JSON.parse(line) } catch {}
    if (obj && typeof obj === 'object') jsonLines += 1
    else {
      nonJsonLines += 1
      inc(nonJsonAll, classifyNonJson(line))
    }
    const ts = timestampOf(obj, line)
    if (ts == null) continue
    timestampedLines += 1
    minTs = minTs == null ? ts : Math.min(minTs, ts)
    maxTs = maxTs == null ? ts : Math.max(maxTs, ts)
    if (ts < cutoff || ts > auditEnd) continue
    inWindow += 1
    const level = levelName(obj && obj.level)
    inc(levels7d, level)
    const code = redact(obj && (obj.code || obj.errorCode || obj.errCode))
    if (code) inc(codes7d, code)
    const msg = redact(obj && (obj.msg || obj.message || (obj.err && (obj.err.code || obj.err.type || obj.err.message))))
    if (msg) inc(messages7d, msg)
  }

  const top = (map, limit = 20) => Object.entries(map)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }))

  results.push({
    file,
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    totalLines: lines.length,
    jsonLines,
    nonJsonLines,
    timestampedLines,
    timestampCoverageRate: lines.length ? timestampedLines / lines.length : 1,
    firstTimestamp: minTs == null ? null : new Date(minTs).toISOString(),
    lastTimestamp: maxTs == null ? null : new Date(maxTs).toISOString(),
    timestampedLinesInWindow: inWindow,
    levels7d,
    topCodes7d: top(codes7d),
    topMessages7d: top(messages7d),
    nonJsonCategoriesAllTime: top(nonJsonAll)
  })
}

process.stdout.write(JSON.stringify({
  generatedAt: new Date(auditEnd).toISOString(),
  cutoff: new Date(cutoff).toISOString(),
  files: results
}, null, 2))
