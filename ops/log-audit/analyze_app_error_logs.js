const fs = require('fs');
const [cutoffRaw, ...files] = process.argv.slice(2);
const cutoff = new Date(cutoffRaw);
const now = process.env.AUDIT_END ? new Date(process.env.AUDIT_END) : new Date();

function bump(map, key, n=1) { map.set(key, (map.get(key)||0)+n); }
function top(map, limit=30) { return [...map].sort((a,b)=>b[1]-a[1]).slice(0,limit).map(([key,count])=>({key,count})); }
function redact(s) {
  return String(s || '')
    .replace(/\b(?:sk|ak)-[A-Za-z0-9_-]{8,}\b/gi, '<api-key>')
    .replace(/(?:authorization|token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=<redacted>')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>')
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '<phone>')
    .replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, '<id>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>')
    .replace(/\bREPORT_[A-Za-z0-9_-]+\b/g, '<report>')
    .replace(/\b[0-9a-f]{32,}\b/gi, '<hash>');
}
function classify(text) {
  const s = text.toLowerCase();
  if (/cors|origin/.test(s)) return 'cors_or_origin';
  if (/timeout|timed out|etimedout/.test(s)) return 'timeout';
  if (/ocr|scan|scanned|pdf.*image|image.*pdf/.test(s)) return 'ocr_or_scanned_pdf';
  if (/output.*trunc|截断|incomplete.*output/.test(s)) return 'model_output_truncated';
  if (/too large|input.*large|context.*length|token.*limit|超出/.test(s)) return 'input_or_context_too_large';
  if (/json|parse|syntaxerror/.test(s)) return 'json_or_parse';
  if (/deepseek|kimi|moonshot|model|llm|ai[- ]?proxy/.test(s)) return 'model_provider_or_ai';
  if (/401|403|auth|login|token|unauthorized|forbidden|鉴权/.test(s)) return 'authentication_or_authorization';
  if (/404|not found|missing|不存在/.test(s)) return 'not_found';
  if (/network|fetch|econn|socket|connection/.test(s)) return 'network_or_connection';
  if (/validation|invalid|bad request|400|校验|格式/.test(s)) return 'validation_or_bad_request';
  if (/upload|file|pdf|report|报告/.test(s)) return 'report_or_file_flow';
  if (/database|sqlite|sql|constraint/.test(s)) return 'database';
  return 'other';
}

const categories=new Map(), codes=new Map(), levels=new Map(), safeMessages=new Map();
const daily={}; const fileStats=[];
let totalLines=0, jsonLines=0, inWindow=0, first=null, last=null;
for (const file of files) {
  let stat,text;
  try { stat=fs.statSync(file); text=fs.readFileSync(file,'utf8'); } catch(e) { fileStats.push({file,error:e.code}); continue; }
  const lines=text.split(/\r?\n/).filter(Boolean); totalLines += lines.length;
  let fJson=0,fIn=0,fFirst=null,fLast=null;
  for (const line of lines) {
    let obj=null; try { obj=JSON.parse(line); } catch {}
    if (obj && typeof obj==='object') { jsonLines++; fJson++; }
    const rawTs = obj?.ts ?? obj?.time ?? obj?.timestamp ?? obj?.createdAt ?? obj?.date ?? line.match(/20\d{2}-\d{2}-\d{2}[T ][0-9:.+-Z]+/)?.[0];
    let ts=rawTs ? new Date(rawTs) : null;
    if (!ts || Number.isNaN(ts.getTime())) {
      const dm=file.match(/(20\d{2}-\d{2}-\d{2})/); ts=dm ? new Date(`${dm[1]}T12:00:00+08:00`) : null;
    }
    if (ts && !Number.isNaN(ts.getTime())) {
      if(!first||ts<first)first=ts;if(!last||ts>last)last=ts;
      if(!fFirst||ts<fFirst)fFirst=ts;if(!fLast||ts>fLast)fLast=ts;
    }
    if (!ts || ts<cutoff || ts>now) continue;
    inWindow++; fIn++;
    const day=new Date(ts.getTime()+8*3600000).toISOString().slice(0,10); daily[day]=(daily[day]||0)+1;
    const level=String(obj?.level ?? obj?.severity ?? 'error').toLowerCase(); bump(levels, level);
    const code=obj?.code ?? obj?.errorCode ?? obj?.status ?? obj?.statusCode;
    if(code!==undefined && code!==null) bump(codes,String(code).slice(0,80));
    const rawMessage=obj?.msg ?? obj?.message ?? obj?.error?.message ?? obj?.error ?? line;
    const safe=redact(typeof rawMessage==='string'?rawMessage:JSON.stringify(rawMessage));
    bump(categories,classify(safe));
    const compact=safe.replace(/\s+/g,' ').trim();
    if(compact && compact.length<=180 && !/[{}\[\]]/.test(compact)) bump(safeMessages,compact);
  }
  fileStats.push({file:file.replace(/^\/opt\/sample-app\/storage\/logs\//,''),bytes:stat.size,lines:lines.length,jsonLines:fJson,inWindow:fIn,firstTimestamp:fFirst?.toISOString()||null,lastTimestamp:fLast?.toISOString()||null});
}
console.log(JSON.stringify({generatedAt:now.toISOString(),cutoff:cutoff.toISOString(),fileCount:files.length,totalLines,jsonLines,inWindow,firstTimestamp:first?.toISOString()||null,lastTimestamp:last?.toISOString()||null,daily,levels:Object.fromEntries(levels),topCodes:top(codes),categories:top(categories),topSafeMessages:top(safeMessages,15),files:fileStats},null,2));
