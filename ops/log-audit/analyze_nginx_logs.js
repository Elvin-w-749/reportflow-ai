const fs = require('fs');
const zlib = require('zlib');

const [cutoffRaw, kind, ...files] = process.argv.slice(2);
const cutoff = new Date(cutoffRaw);
const now = process.env.AUDIT_END ? new Date(process.env.AUDIT_END) : new Date();

function readText(file) {
  const buf = fs.readFileSync(file);
  return file.endsWith('.gz') ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
}

function parseNginxDate(raw) {
  const m = raw.match(/^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})$/);
  if (!m) return null;
  const months = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
  const mon = months[m[2]];
  if (mon === undefined) return null;
  const sign = m[7][0] === '-' ? -1 : 1;
  const offsetMinutes = sign * (Number(m[7].slice(1,3)) * 60 + Number(m[7].slice(3,5)));
  return new Date(Date.UTC(Number(m[3]), mon, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) - offsetMinutes * 60000);
}

function normalizePath(raw) {
  let p = String(raw || '/').split('?')[0];
  try { p = decodeURIComponent(p); } catch {}
  p = p.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/ig, ':uuid');
  p = p.replace(/\bREPORT_[A-Za-z0-9_-]+\b/ig, ':report');
  p = p.replace(/\/\d{4,}(?=\/|$)/g, '/:id');
  p = p.replace(/\/[A-Za-z0-9_-]{20,}(?=\/|$)/g, '/:token');
  if (p.length > 160) p = p.slice(0, 157) + '...';
  return p;
}

function bump(map, key, n = 1) { map.set(key, (map.get(key) || 0) + n); }
function top(map, limit = 20) {
  return [...map.entries()].sort((a,b) => b[1] - a[1]).slice(0, limit).map(([key,count]) => ({key,count}));
}

const result = {
  generatedAt: now.toISOString(), cutoff: cutoff.toISOString(), kind,
  fileCount: files.length, totalBytes: 0, totalLines: 0, parsedLines: 0,
  inWindow: 0, firstTimestamp: null, lastTimestamp: null,
  daily: {}, statusClasses: {}, topStatuses: [], topPaths: [], topErrorsByPath: [],
  levels: {}, topErrorCategories: [], files: []
};
const statuses = new Map(), statusMethods = new Map(), paths = new Map(), errorPaths = new Map(), serverErrors = new Map(), levels = new Map(), categories = new Map();
let first = null, last = null;

for (const file of files) {
  let stat, text;
  try { stat = fs.statSync(file); text = readText(file); } catch (e) {
    result.files.push({file, error: e.code || e.message}); continue;
  }
  result.totalBytes += stat.size;
  const lines = text.split(/\r?\n/).filter(Boolean);
  result.totalLines += lines.length;
  let fileParsed = 0, fileInWindow = 0, fileFirst = null, fileLast = null;
  for (const line of lines) {
    if (kind === 'access') {
      let ts = null, method = '', path = '', status = 0;
      let m = line.match(/^\S+ \S+ \S+ \[([^\]]+)\] "([A-Z]+) ([^ ]+)(?: HTTP\/[^"]+)?" (\d{3}) /);
      if (m) {
        ts = parseNginxDate(m[1]); method = m[2]; path = m[3]; status = Number(m[4]);
      } else {
        m = line.match(/^\S+ \[([^\]]+)\] "([A-Z]+) ([^"]+)" (\d{3}) /);
        if (m) { ts = new Date(m[1]); method = m[2]; path = m[3]; status = Number(m[4]); }
      }
      if (!ts || Number.isNaN(ts.getTime())) continue;
      fileParsed++; result.parsedLines++;
      if (!first || ts < first) first = ts;
      if (!last || ts > last) last = ts;
      if (!fileFirst || ts < fileFirst) fileFirst = ts;
      if (!fileLast || ts > fileLast) fileLast = ts;
      if (ts < cutoff || ts > now) continue;
      fileInWindow++; result.inWindow++;
      const day = new Date(ts.getTime() + 8*3600000).toISOString().slice(0,10);
      result.daily[day] ||= {requests:0, s2xx:0, s3xx:0, s4xx:0, s5xx:0};
      result.daily[day].requests++;
      const klass = `${Math.floor(status/100)}xx`;
      result.daily[day][`s${klass}`] = (result.daily[day][`s${klass}`] || 0) + 1;
      result.statusClasses[klass] = (result.statusClasses[klass] || 0) + 1;
      bump(statuses, String(status));
      bump(statusMethods, `${status} ${method}`);
      const safePath = `${method} ${normalizePath(path)}`;
      bump(paths, safePath);
      if (status >= 400) bump(errorPaths, `${status} ${safePath}`);
      if (status >= 500 && method !== 'OPTIONS') bump(serverErrors, `${status} ${safePath}`);
    } else {
      const m = line.match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2}) \[([^\]]+)\] [^:]+: (.*)$/);
      if (!m) continue;
      const ts = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`);
      if (Number.isNaN(ts.getTime())) continue;
      fileParsed++; result.parsedLines++;
      if (!first || ts < first) first = ts;
      if (!last || ts > last) last = ts;
      if (!fileFirst || ts < fileFirst) fileFirst = ts;
      if (!fileLast || ts > fileLast) fileLast = ts;
      if (ts < cutoff || ts > now) continue;
      fileInWindow++; result.inWindow++;
      const level = m[7].toLowerCase(); bump(levels, level);
      const body = m[8].toLowerCase();
      let cat = 'other';
      if (body.includes('connect() failed')) cat = 'upstream_connect_failed';
      else if (body.includes('upstream timed out')) cat = 'upstream_timeout';
      else if (body.includes('client timed out')) cat = 'client_timeout';
      else if (body.includes('no live upstreams')) cat = 'no_live_upstreams';
      else if (body.includes('prematurely closed')) cat = 'upstream_premature_close';
      else if (body.includes('open()') && body.includes('failed')) cat = 'static_file_not_found';
      else if (body.includes('ssl')) cat = 'tls_ssl';
      else if (body.includes('limiting requests')) cat = 'rate_limited';
      else if (body.includes('rewrite or internal redirection cycle')) cat = 'rewrite_cycle';
      else if (body.includes('permission denied')) cat = 'permission_denied';
      bump(categories, cat);
      const day = new Date(ts.getTime() + 8*3600000).toISOString().slice(0,10);
      result.daily[day] ||= {errors:0}; result.daily[day].errors++;
    }
  }
  result.files.push({
    file: file.replace(/^\/var\/log\/nginx\//, ''), bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(), lines: lines.length, parsed: fileParsed,
    inWindow: fileInWindow,
    firstTimestamp: fileFirst ? fileFirst.toISOString() : null,
    lastTimestamp: fileLast ? fileLast.toISOString() : null
  });
}

result.firstTimestamp = first ? first.toISOString() : null;
result.lastTimestamp = last ? last.toISOString() : null;
result.topStatuses = top(statuses, 20);
result.statusMethods = top(statusMethods, 40);
result.topPaths = top(paths, 20);
result.topErrorsByPath = top(errorPaths, 30);
result.nonPreflightServerErrors = top(serverErrors, 40);
result.levels = Object.fromEntries([...levels.entries()]);
result.topErrorCategories = top(categories, 20);
console.log(JSON.stringify(result, null, 2));
