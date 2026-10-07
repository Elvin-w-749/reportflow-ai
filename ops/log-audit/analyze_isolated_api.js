const fs = require('fs');
const [cutoffRaw, ...files] = process.argv.slice(2);
const cutoff = new Date(cutoffRaw), now = process.env.AUDIT_END ? new Date(process.env.AUDIT_END) : new Date();

function bump(o,k,n=1){o[k]=(o[k]||0)+n;}
function cstDay(ts){return new Date(ts.getTime()+8*3600000).toISOString().slice(0,10);}
function walkStrings(obj, path='', out=[]) {
  if (typeof obj === 'string') out.push([path,obj]);
  else if (obj && typeof obj === 'object') for (const [k,v] of Object.entries(obj)) walkStrings(v,path?`${path}.${k}`:k,out);
  return out;
}
function originClass(obj) {
  const entries=walkStrings(obj).filter(([k])=>/origin/i.test(k));
  const raw=entries[0]?.[1];
  if (!raw) return 'missing';
  if (raw==='null') return 'null';
  try {
    const u=new URL(raw); const h=u.hostname.toLowerCase();
    if (h==='example.test'||h==='www.example.test') return 'sample_domain';
    if (h==='127.0.0.1'||h==='localhost'||h==='::1') return 'localhost';
    return 'other_origin';
  } catch { return 'non_url_origin'; }
}

const messageCounts={}, codes={}, daily={}, corsOrigins={}, corsDaily={}, routeFailures={}, levels={};
const fieldShapes={}; let total=0,inWindow=0,first=null,last=null;
for(const file of files){
  const lines=fs.readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean);
  for(const line of lines){
    let o; try{o=JSON.parse(line);}catch{continue;}
    const ts=new Date(o.ts??o.time??o.timestamp??o.date);
    if(Number.isNaN(ts.getTime()))continue;
    total++;if(!first||ts<first)first=ts;if(!last||ts>last)last=ts;
    if(ts<cutoff||ts>now)continue; inWindow++;
    const day=cstDay(ts), msg=String(o.msg??o.message??'').slice(0,160), level=String(o.level??'unknown').toLowerCase();
    bump(messageCounts,msg||'<empty>');bump(levels,level);
    daily[day] ||= {total:0,info:0,warn:0,error:0,corsBlocked:0,unhandled:0,analysisFailed:0,ocrComplete:0,startups:0};
    daily[day].total++;bump(daily[day],level);
    const code=o.code??o.errorCode??o.err?.code??o.error?.code;
    if(code)bump(codes,String(code).slice(0,100));
    if(msg==='CORS blocked origin'){
      daily[day].corsBlocked++;bump(corsDaily,day);bump(corsOrigins,originClass(o));
      fieldShapes[msg] ||= Object.fromEntries(Object.entries(o).map(([k,v])=>[k,Array.isArray(v)?'array':v===null?'null':typeof v]));
    }
    if(msg==='ai-proxy: unhandled error') daily[day].unhandled++;
    if(/api\/analyze failed/i.test(msg)){
      daily[day].analysisFailed++;
      const route=o.route??o.path??o.url??'/api/analyze'; bump(routeFailures,String(route).split('?')[0].replace(/\d{4,}/g,':id'));
    }
    if(/OCR fallback complete|multi-image OCR complete/i.test(msg)) daily[day].ocrComplete++;
    if(/listening/i.test(msg)) daily[day].startups++;
  }
}
function sorted(o){return Object.entries(o).sort((a,b)=>b[1]-a[1]).map(([key,count])=>({key,count}));}
console.log(JSON.stringify({generatedAt:now.toISOString(),cutoff:cutoff.toISOString(),totalParsed:total,inWindow,firstTimestamp:first?.toISOString()||null,lastTimestamp:last?.toISOString()||null,levels,messageCounts:sorted(messageCounts),codes:sorted(codes),daily,cors:{origins:sorted(corsOrigins),daily:corsDaily},routeFailures:sorted(routeFailures),fieldShapes},null,2));
