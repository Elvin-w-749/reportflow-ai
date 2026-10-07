const readline = require('readline');

const priorities = ['emerg','alert','crit','error','warning','notice','info','debug'];
const result = {
  total:0, firstTimestamp:null, lastTimestamp:null,
  priorities:{}, units:{}, daily:{}, severeCategories:{},
  ssh:{accepted:0,failedPassword:0,invalidUser:0,publicKeyFailure:0,disconnect:0,handshake:0},
  system:{oom:0,segfault:0,diskOrIo:0,serviceFailed:0,restartOrCrash:0,readOnlyFs:0},
  backup:{starts:0,successes:0,failures:0,verificationSignals:0},
  services:{}
};
const watched = new Set(['nginx.service','pm2-sample.service','pm2-sample-beta.service','ssh.service','cron.service','sample-backup.service','sample-internal-beta-log-retention.service','certbot.service','logrotate.service']);

function bump(obj,key,n=1){obj[key]=(obj[key]||0)+n;}
function dayCst(ts){return new Date(ts.getTime()+8*3600000).toISOString().slice(0,10);}
function classifySevere(msg, unit) {
  const s=msg.toLowerCase();
  if(/out of memory|oom-killer|killed process/.test(s)) return 'oom';
  if(/segfault|core dumped/.test(s)) return 'segfault_or_core_dump';
  if(/read-only file system/.test(s)) return 'read_only_filesystem';
  if(/no space left|disk full|i\/o error|input\/output error/.test(s)) return 'disk_or_io';
  if(/failed password|authentication failure|invalid user/.test(s)) return 'ssh_auth_failure';
  if(/connection closed|disconnected from|banner exchange|kex_exchange_identification/.test(s)) return 'ssh_disconnect_or_handshake';
  if(/ssl|tls|certificate/.test(s)) return 'tls_or_certificate';
  if(/timed out|timeout/.test(s)) return 'timeout';
  if(/failed with result|entered failed state|failed to start|unit .* failed/.test(s)) return 'systemd_service_failure';
  if(/connection refused|connect\(\) failed/.test(s)) return 'connection_refused';
  if(/denied|permission/.test(s)) return 'permission_denied';
  if(unit.includes('kernel')) return 'kernel_other';
  return 'other_warning_or_error';
}

const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
rl.on('line', line => {
  if(!line)return; let o; try{o=JSON.parse(line);}catch{return;}
  result.total++;
  const us=Number(o.__REALTIME_TIMESTAMP); const ts=Number.isFinite(us)?new Date(us/1000):null;
  if(ts&&!Number.isNaN(ts.getTime())){
    const iso=ts.toISOString();
    if(!result.firstTimestamp||iso<result.firstTimestamp)result.firstTimestamp=iso;
    if(!result.lastTimestamp||iso>result.lastTimestamp)result.lastTimestamp=iso;
  }
  const pNum=Number(o.PRIORITY); const p=priorities[pNum]||String(o.PRIORITY??'unknown'); bump(result.priorities,p);
  const unit=String(o._SYSTEMD_UNIT||o.UNIT||o.SYSLOG_IDENTIFIER||o._COMM||'unknown'); bump(result.units,unit);
  const msg=String(o.MESSAGE||''); const lower=msg.toLowerCase();
  if(ts){const d=dayCst(ts);result.daily[d]||={total:0,severe:0,sshFailures:0,serviceFailures:0};result.daily[d].total++;if(pNum<=4)result.daily[d].severe++;}
  const isSsh=unit==='ssh.service'||/sshd/.test(String(o.SYSLOG_IDENTIFIER||o._COMM||''));
  if(isSsh){
    if(/accepted (publickey|password)/.test(lower))result.ssh.accepted++;
    if(/failed password/.test(lower)){result.ssh.failedPassword++;if(ts)result.daily[dayCst(ts)].sshFailures++;}
    if(/invalid user/.test(lower))result.ssh.invalidUser++;
    if(/failed publickey|authentication failure/.test(lower))result.ssh.publicKeyFailure++;
    if(/disconnected from|connection closed/.test(lower))result.ssh.disconnect++;
    if(/banner exchange|kex_exchange_identification|bad protocol version/.test(lower))result.ssh.handshake++;
  }
  if(/out of memory|oom-killer|killed process/.test(lower))result.system.oom++;
  if(/segfault|core dumped/.test(lower))result.system.segfault++;
  if(/no space left|disk full|i\/o error|input\/output error/.test(lower))result.system.diskOrIo++;
  if(/read-only file system/.test(lower))result.system.readOnlyFs++;
  if(/failed with result|entered failed state|failed to start/.test(lower)){result.system.serviceFailed++;if(ts)result.daily[dayCst(ts)].serviceFailures++;}
  if(/main process exited|scheduled restart job|start request repeated too quickly|watchdog/.test(lower))result.system.restartOrCrash++;
  if(unit==='sample-backup.service'){
    if(/starting|started/.test(lower))result.backup.starts++;
    if(/succeeded|finished|completed|deactivated successfully/.test(lower))result.backup.successes++;
    if(/failed|error|fatal/.test(lower))result.backup.failures++;
    if(/verify|verified|integrity|checksum/.test(lower))result.backup.verificationSignals++;
  }
  if(watched.has(unit)){
    result.services[unit] ||= {events:0,severe:0,startSignals:0,stopSignals:0,failSignals:0};
    const s=result.services[unit];s.events++;if(pNum<=4)s.severe++;
    if(/starting|started/.test(lower))s.startSignals++;
    if(/stopping|stopped|deactivated successfully/.test(lower))s.stopSignals++;
    if(/failed|error|fatal|main process exited/.test(lower))s.failSignals++;
  }
  if(pNum<=4)bump(result.severeCategories,classifySevere(msg,unit));
});
rl.on('close',()=>{
  result.units=Object.entries(result.units).sort((a,b)=>b[1]-a[1]).slice(0,30).map(([unit,count])=>({unit,count}));
  result.severeCategories=Object.entries(result.severeCategories).sort((a,b)=>b[1]-a[1]).map(([category,count])=>({category,count}));
  console.log(JSON.stringify(result,null,2));
});
