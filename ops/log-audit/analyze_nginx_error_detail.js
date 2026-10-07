const fs=require('fs'),zlib=require('zlib');
const [cutoffRaw,...files]=process.argv.slice(2);const cutoff=new Date(cutoffRaw),now=process.env.AUDIT_END?new Date(process.env.AUDIT_END):new Date();
const counts={},daily={},upstreamDetails={};let total=0;
function bump(k){counts[k]=(counts[k]||0)+1}
function read(f){const b=fs.readFileSync(f);return f.endsWith('.gz')?zlib.gunzipSync(b).toString():b.toString()}
for(const f of files)for(const line of read(f).split(/\r?\n/).filter(Boolean)){
 const m=line.match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2}) \[([^\]]+)\].*?: (.*)$/);if(!m)continue;
 const ts=new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`);if(ts<cutoff||ts>now)continue;total++;const s=m[8].toLowerCase();let c='other';
 if(s.includes('ssl_do_handshake() failed'))c='tls_handshake_probe_or_failure';
 else if(s.includes('client sent invalid method'))c='invalid_http_method';
 else if(s.includes('client sent invalid request'))c='invalid_http_request';
 else if(s.includes('client sent plain http request to https port'))c='plain_http_to_https';
 else if(s.includes('connect() failed'))c='upstream_connect_failed';
 else if(s.includes('upstream timed out'))c='upstream_timeout';
 else if(s.includes('open()')&&s.includes('failed'))c='static_file_not_found';
 else if(s.includes('directory index of'))c='directory_index_forbidden';
 else if(s.includes('access forbidden by rule'))c='access_forbidden_by_rule';
 else if(s.includes('too large body'))c='request_body_too_large';
 else if(s.includes('limiting requests'))c='rate_limited';
 bump(c);const d=`${m[1]}-${m[2]}-${m[3]}`;daily[d]||={};daily[d][c]=(daily[d][c]||0)+1;
 if(c==='upstream_connect_failed'){
   const req=m[8].match(/request: "([A-Z]+) ([^ ?"]+)/i);const up=m[8].match(/upstream: "https?:\/\/[^:\/"]+:(\d+)/i);
   let p=req?req[2]:'/unknown';p=p.replace(/\d{4,}/g,':id').replace(/\/[A-Za-z0-9_-]{20,}(?=\/|$)/g,'/:token');
   const k=`${d} ${req?req[1]:'?'} ${p} -> port ${up?up[1]:'unknown'}`;upstreamDetails[k]=(upstreamDetails[k]||0)+1;
 }
}
console.log(JSON.stringify({total,categories:Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([category,count])=>({category,count})),daily,upstreamDetails},null,2));
