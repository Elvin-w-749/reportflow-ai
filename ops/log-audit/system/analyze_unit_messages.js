const readline=require('readline');const counts={},categories={};let total=0;
function bump(o,k){o[k]=(o[k]||0)+1}
function safe(s){return String(s||'')
 .replace(/\b(?:sk|ak)-[A-Za-z0-9_-]{8,}\b/gi,'<api-key>')
 .replace(/(?:token|password|secret|key)\s*[:=]\s*[^\s,;]+/gi,'$1=<redacted>')
 .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g,'<ip>')
 .replace(/\b[0-9a-f]{24,}\b/gi,'<hash>')
 .replace(/\/[A-Za-z0-9_.@%+,:=-]+(?:\/[A-Za-z0-9_.@%+,:=-]+)+/g,'<path>')
 .replace(/20\d{2}[-/]\d{2}[-/]\d{2}(?:[T _-]\d{2}[:_-]\d{2}(?::\d{2})?)?/g,'<datetime>')
 .replace(/\b\d{4,}\b/g,'<n>')
 .replace(/\s+/g,' ').trim().slice(0,240)}
function cat(s){const x=s.toLowerCase();
 if(/integrity|quick_check|checksum|verified|verification/.test(x))return'integrity_or_verification';
 if(/encrypted|encryption|gpg|openssl/.test(x))return'encryption';
 if(/upload|remote|offsite|object storage/.test(x))return'offsite_upload';
 if(/retention|prune|delete old|expired/.test(x))return'retention';
 if(/success|succeed|complete|finished|ok\b/.test(x))return'success_or_complete';
 if(/fail|error|fatal/.test(x))return'failure';
 if(/start|begin|running/.test(x))return'start';
 return'other'}
const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});rl.on('line',l=>{if(!l)return;let o;try{o=JSON.parse(l)}catch{return}total++;const m=String(o.MESSAGE||'');bump(categories,cat(m));bump(counts,safe(m)||'<empty>')});rl.on('close',()=>console.log(JSON.stringify({total,categories:Object.entries(categories).sort((a,b)=>b[1]-a[1]).map(([category,count])=>({category,count})),topTemplates:Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,30).map(([template,count])=>({template,count}))},null,2)));
