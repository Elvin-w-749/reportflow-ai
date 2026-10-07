const fs=require('fs');const files=process.argv.slice(2);const out=[];
for(const file of files){let text;try{text=fs.readFileSync(file,'utf8')}catch(e){out.push({file,error:e.code});continue}const lines=text.split(/\r?\n/).filter(Boolean);const c={};
 for(const line of lines){const s=line.toLowerCase();let k='other';
  if(/deprecationwarning|deprecated/.test(s))k='deprecation_warning';
  else if(/experimentalwarning/.test(s))k='experimental_warning';
  else if(/unhandledrejection/.test(s)&&/timeout|timed out/.test(s))k='unhandled_timeout';
  else if(/unhandledrejection/.test(s)&&/econn|connection|socket/.test(s))k='unhandled_connection';
  else if(/unhandledrejection/.test(s))k='unhandled_rejection_other';
  else if(/uncaughtexception/.test(s))k='uncaught_exception';
  else if(/econnrefused|connection refused/.test(s))k='connection_refused';
  else if(/timeout|timed out/.test(s))k='timeout';
  else if(/listening|started|ready/.test(s))k='startup_or_ready';
  else if(/warning|warn/.test(s))k='warning_other';
  else if(/error|failed|fatal/.test(s))k='error_other';
  c[k]=(c[k]||0)+1;
 }
 out.push({file,bytes:Buffer.byteLength(text),lines:lines.length,categories:Object.entries(c).sort((a,b)=>b[1]-a[1]).map(([category,count])=>({category,count}))});
}
console.log(JSON.stringify({files:out},null,2));
