const fs=require('fs'),path=require('path');const [cutoffRaw,...dirs]=process.argv.slice(2);const cutoff=new Date(cutoffRaw),now=new Date();
const out=[];
for(const dir of dirs){let st;try{st=fs.statSync(dir)}catch{continue}if(!st.isDirectory())continue;const name=path.basename(dir);const m=name.match(/deploy-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/);if(!m)continue;const ts=new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`);if(ts<cutoff||ts>now)continue;
 const files=fs.readdirSync(dir);let healthFiles=0,healthOk=0,healthFailed=0,http2xx=0,httpOther=0,nginxChecks=0,nginxOk=0,pm2Signals={online:0,errored:0};
 for(const f of files){const p=path.join(dir,f);if(!fs.statSync(p).isFile())continue;
  if(/health.*\.json$/i.test(f)){healthFiles++;try{const o=JSON.parse(fs.readFileSync(p,'utf8'));const ok=o.ok===true||o.status==='ok'||o.healthy===true||o.success===true;ok?healthOk++:healthFailed++;}catch{healthFailed++;}}
  if(/\.headers$/i.test(f)){const first=fs.readFileSync(p,'utf8').split(/\r?\n/)[0]||'';const sm=first.match(/\s(\d{3})\s/);if(sm){const s=Number(sm[1]);s>=200&&s<300?http2xx++:httpOther++;}}
  if(/nginx.*\.log$/i.test(f)){nginxChecks++;const s=fs.readFileSync(p,'utf8').toLowerCase();if(/syntax is ok|test is successful/.test(s))nginxOk++;}
  if(/pm2.*\.log$/i.test(f)){const s=fs.readFileSync(p,'utf8').toLowerCase();pm2Signals.online+=(s.match(/online/g)||[]).length;pm2Signals.errored+=(s.match(/errored|stopped/g)||[]).length;}
 }
 out.push({deployment:name,startedAt:ts.toISOString(),healthFiles,healthOk,healthFailed,http2xx,httpOther,nginxChecks,nginxOk,pm2Signals});
}
console.log(JSON.stringify({deploymentCount:out.length,deployments:out},null,2));
