const fs=require('fs'),crypto=require('crypto');const files=process.argv.slice(2),out=[];
const allow=new Set(['msg','message','level','status','service','svc','env','provider','model','code','errorCode','ok','success']);
function safe(v){return String(v).replace(/\b(?:sk|ak)-[A-Za-z0-9_-]{8,}\b/gi,'<api-key>').replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g,'<ip>').replace(/\s+/g,' ').slice(0,120)}
for(const file of files){let text;try{text=fs.readFileSync(file,'utf8')}catch(e){out.push({file,error:e.code});continue}const shapes={};
 for(const line of text.split(/\r?\n/).filter(Boolean)){const hash=crypto.createHash('sha256').update(line).digest('hex').slice(0,12);const i=line.indexOf('{');let parsed=null;if(i>=0){try{parsed=JSON.parse(line.slice(i))}catch{}}
  let shape;if(parsed&&typeof parsed==='object'){const values={};for(const [k,v] of Object.entries(parsed))if(allow.has(k)&&(typeof v==='string'||typeof v==='number'||typeof v==='boolean'||v===null))values[k]=typeof v==='string'?safe(v):v;shape={kind:'jsonish',keys:Object.keys(parsed).sort(),safeValues:values};}
  else {const s=line.toLowerCase();shape={kind:/warning|warn/.test(s)?'warning_text':/error|failed|fatal/.test(s)?'error_text':'plain_text',keywordFlags:{timeout:/timeout|timed out/.test(s),connection:/econn|connection|socket/.test(s),deprecation:/deprecated|deprecation/.test(s),startup:/listening|ready|started/.test(s)}};}
  const key=hash;shapes[key] ||= {...shape,count:0};shapes[key].count++;
 }
 out.push({file,bytes:Buffer.byteLength(text),lines:text.split(/\r?\n/).filter(Boolean).length,uniqueShapes:Object.entries(shapes).map(([fingerprint,v])=>({fingerprint,...v}))});
}
console.log(JSON.stringify({files:out},null,2));
