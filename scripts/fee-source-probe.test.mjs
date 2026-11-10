// Offline tests for the read-only source probe. Every value is synthetic. The
// real CLI is started as a child process under a network-less namespace when
// the host allows one (`unshare -rn`), and always behind a preload that denies
// net/tls/dns/http/https, counts every file write and serves only exact,
// synthetic responses. No real account, credential, API or workflow is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {spawnSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {SOURCE_PROBE_TITLE,SOURCE_PROBE_INPUTS,SOURCE_PROBE_BUDGET,SOURCE_PROBE_CODES,SOURCE_PROBE_STAGES,sourceProbeArgs,validateSourceProbeAdmission,runSourceProbe} from './fee-source-probe.mjs';
import {consecutiveFailures,diagnosticBody,isIbReadOnlyDiagnostic} from './fee-cloud-supervisor.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const CLI=path.join(ROOT,'scripts/fee-source-probe.mjs');
const WORKFLOW=fs.readFileSync(path.join(ROOT,'.github/workflows/fee-cloud-producer.yml'),'utf8');
const SUPERVISOR=fs.readFileSync(path.join(ROOT,'.github/workflows/fee-cloud-supervisor.yml'),'utf8');
const MAIN=crypto.randomBytes(20).toString('hex'),RUN_ID='42'+String(crypto.randomInt(100000000,999999999)),OWNER=283054367;
const CANARY='probe-canary-'+crypto.randomBytes(8).toString('hex');
const CLIENT_ID='cid-'+CANARY,CLIENT_SECRET='sec-'+CANARY,ACTIONS_TOKEN='ghs_'+crypto.randomBytes(20).toString('hex');
const ACCESS='synthetic-access-'+crypto.randomBytes(16).toString('hex');
const NOW='2026-11-10T01:00:00Z',TARGET='2026-11-09';
const OFF=['ib_diagnostic_once','ib_envelope_once','source_plan_check_only','source_acceptance_once','run_reviewed_once'];
const BLANK=['ib_diagnostic_main','ib_envelope_main','ratio_main','ratio_plan','source_from','source_target','source_main','manual_sync_completed_for','confirmed_main','recovery_main','report_kind','report_target','report_markets'];

const ISOLATION=(()=>{const r=spawnSync('unshare',['-rn','true'],{encoding:'utf8'});return r.status===0?'unshare':'preload-only';})();
test('isolation mode is recorded; the namespace really has no network when available',t=>{
  t.diagnostic('isolation='+ISOLATION);
  if(ISOLATION!=='unshare')return;
  const r=spawnSync('unshare',['-rn',process.execPath,'-e',`const net=require('node:net'),dns=require('node:dns');
    const s=net.connect(443,'192.0.2.1');s.on('error',e=>{process.stdout.write('tcp:'+e.code+'\\n');dns.lookup('example.invalid',e2=>{process.stdout.write('dns:'+(e2&&e2.code)+'\\n');});});`],{encoding:'utf8',timeout:20000});
  assert.match(r.stdout,/tcp:(ENETUNREACH|EHOSTUNREACH|ECONNREFUSED)/);assert.match(r.stdout,/dns:(EAI_AGAIN|ENOTFOUND)/);
});

// ---- test-only preload (written to a fresh temp directory per run) ----
const PRELOAD=String.raw`
import fs from 'node:fs';import net from 'node:net';import tls from 'node:tls';import dns from 'node:dns';
import http from 'node:http';import https from 'node:https';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const writeOriginal=fs.writeFileSync.bind(fs),LOG=process.env.HARNESS_LOG,scenario=JSON.parse(process.env.HARNESS_SCENARIO);
const log={blocked:0,unexpected:0,writes:0,spawns:0,localInjected:0,injected:0,requests:[]};
const flush=()=>{try{writeOriginal(LOG,JSON.stringify(log));}catch{}};process.on('exit',flush);
const deny=name=>function(){log.blocked++;log.requests.push({route:'DENIED_'+name});flush();throw Error('HARNESS_NETWORK_DENIED');};
net.connect=deny('NET');net.createConnection=deny('NET');net.Socket.prototype.connect=deny('NET_SOCKET');tls.connect=deny('TLS');
for(const k of ['lookup','resolve','resolve4','resolve6','resolveAny','resolveTxt','resolveSrv','resolveCname','lookupService'])if(typeof dns[k]==='function')dns[k]=deny('DNS');
for(const k of Object.keys(dns.promises||{}))if(typeof dns.promises[k]==='function')dns.promises[k]=deny('DNS');
for(const m of [http,https]){m.request=deny('HTTP');m.get=deny('HTTP');}
const write=name=>function(){log.writes++;log.requests.push({route:'WRITE_'+name});flush();throw Error('HARNESS_WRITE_DENIED');};
for(const k of ['writeFileSync','writeFile','appendFileSync','appendFile','mkdirSync','mkdir','createWriteStream','rmSync','rm','unlinkSync','unlink','renameSync','rename','copyFileSync','copyFile','truncateSync','symlinkSync','linkSync'])if(typeof fs[k]==='function')fs[k]=write(k);
for(const k of ['writeFile','appendFile','mkdir','rm','unlink','rename','copyFile','truncate','open'])if(typeof fs.promises[k]==='function')fs.promises[k]=write('promises.'+k);
const openOriginal=fs.openSync.bind(fs);fs.openSync=(p,flags='r',...rest)=>{if(typeof flags!=='string'||flags!=='r')return write('openSync')();return openOriginal(p,flags,...rest);};
for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[k]=function(){log.spawns++;flush();throw Error('HARNESS_SPAWN_DENIED');};
syncBuiltinESMExports();
const RealDate=Date,fixed=RealDate.parse(process.env.HARNESS_NOW);let offset=0;
globalThis.Date=class extends RealDate{constructor(...a){super(...(a.length?a:[fixed+offset]));}static now(){return fixed+offset;}};
const nativeDefine=Object.defineProperty;let localArmed=false;
Object.defineProperty=function(target,key,descriptor){
  if(localArmed&&typeof key==='symbol'&&key.description==='Sharesight number text'&&target&&typeof target==='object'
     &&Object.prototype.hasOwnProperty.call(target,'harness_local_fault_marker')&&target.harness_local_fault_marker===scenario.marker){
    localArmed=false;log.localInjected++;flush();throw new Error('local fault '+scenario.canary);}
  return nativeDefine(target,key,descriptor);};
const enc=new TextEncoder();
const response=(url,{status=200,body='{}',bodyError=null}={})=>({url,status,redirected:false,type:'basic',ok:status>=200&&status<300,
  headers:{get:k=>String(k).toLowerCase()==='content-type'?'application/json; charset=utf-8':null},
  body:{getReader(){let sent=false;return {read:async()=>{if(scenario.kind==='hang-body')return new Promise(()=>{});
    if(bodyError&&!sent){sent=true;return {done:false,value:enc.encode('{"partial":')};}
    if(bodyError)throw bodyError;if(sent)return {done:true};sent=true;return {done:false,value:enc.encode(body)};},cancel:async()=>{},releaseLock(){}};}}});
const cause=code=>{const e=new TypeError('fetch failed '+scenario.canary);if(code)e.cause=Object.assign(new Error('cause '+scenario.canary),{code});return e;};
const routes=JSON.parse(process.env.HARNESS_ROUTES);let sharesight=0;
globalThis.fetch=async(url,init={})=>{
  url=String(url);const route=routes[url];
  if(!route){log.unexpected++;log.requests.push({route:'UNEXPECTED'});flush();throw Error('HARNESS_UNEXPECTED_REQUEST '+scenario.canary);}
  if(init.method!==route.method||init.redirect==='follow'){log.unexpected++;log.requests.push({route:'UNEXPECTED_METHOD'});flush();throw Error('HARNESS_UNEXPECTED_METHOD');}
  if(route.github&&init.headers?.Authorization!=='Bearer '+process.env.HARNESS_ACTIONS_TOKEN){log.unexpected++;flush();throw Error('HARNESS_GITHUB_AUTH');}
  if(!route.github&&route.name!=='TOKEN'&&init.headers?.Authorization!=='Bearer '+process.env.HARNESS_ACCESS){log.unexpected++;flush();throw Error('HARNESS_SOURCE_AUTH');}
  log.requests.push({route:route.name});
  if(!route.github){sharesight++;if(scenario.jumpAfter===sharesight)offset=scenario.jumpMs;}
  if(scenario.route===route.name&&!log.injected){
    log.injected++;flush();
    switch(scenario.kind){
      case 'cause':throw cause(scenario.code);
      case 'unknown':throw new TypeError('fetch failed '+scenario.canary);
      case 'body':return response(url,{bodyError:cause(scenario.code)});
      case 'hang':return new Promise(()=>{});
      case 'http':return response(url,{status:503,body:JSON.stringify({error:scenario.canary})});
      case 'json':return response(url,{body:'{"truncated":'+JSON.stringify(scenario.canary)});
      case 'replace':return response(url,{body:JSON.stringify(scenario.body)});
      case 'local-marker':{const body=JSON.parse(route.body);body.report.harness_local_fault_marker=scenario.marker;localArmed=true;return response(url,{body:JSON.stringify(body)});}
    }
  }
  flush();return response(url,{body:route.body});
};
`;

const API='https://api.sharesight.com',GH='https://api.github.com/repos/huanwujoy-crypto/fee-console';
const ACCOUNTS=[{id:936249,name:'Schwab-HK'},{id:1350094,name:'Webull'}];
function routeTable({cash=1,target=TARGET,run={},ref=MAIN,omit=null}={}){
  const t={};const add=(url,name,body,method='GET',github=false)=>{t[url]={name,method,github,body:JSON.stringify(body)};};
  add(GH+'/git/ref/heads/main','GITHUB_REF',{ref:'refs/heads/main',object:{sha:ref,type:'commit'}},'GET',true);
  add(GH+'/actions/runs/'+RUN_ID,'GITHUB_RUN',{id:Number(RUN_ID),head_sha:MAIN,head_branch:'main',path:'.github/workflows/fee-cloud-producer.yml',event:'workflow_dispatch',
    actor:{id:OWNER},run_attempt:1,status:'in_progress',conclusion:null,display_title:SOURCE_PROBE_TITLE,...run},'GET',true);
  add(API+'/oauth2/token','TOKEN',{access_token:ACCESS,token_type:'bearer',expires_in:1800},'POST');
  add(API+'/api/v2/portfolios.json','PORTFOLIOS',{portfolios:ACCOUNTS.map(a=>({...a,currency_code:'USD',note:CANARY,value:987654.32}))});
  ACCOUNTS.forEach((a,k)=>{
    const b3=`${API}/api/v3/portfolios/${a.id}`,d=target;
    add(`${b3}/performance?consolidated=false&end_date=${d}&grouping=investment_type&include_limited=false&include_sales=false&report_combined=false&start_date=${d}`,'PERFORMANCE',
      {report:{id:a.id,start_date:d,end_date:d,value:'987654.3210',capital_gain:13579.24,label:CANARY}});
    add(`${b3}/holdings?consolidated=false`,'HOLDINGS',{holdings:[{id:7000+k,symbol:'SYN',value:24680.13,note:CANARY}]});
    const ids=Array.from({length:cash},(_,i)=>8100+k*100+i);
    add(`${API}/api/v2/portfolios/${a.id}/cash_accounts.json?date=${d}`,'CASH_ACCOUNTS',{cash_accounts:ids.map(id=>({id,name:CANARY,balance:11223.44}))});
    add(`${b3}/trades.json?consolidated=false&end_date=${d}&start_date=${d}`,'TRADES',{trades:[]});
    for(const id of ids)add(`${API}/api/v2/cash_accounts/${id}/cash_account_transactions.json?from=${d}&to=${d}`,'CASH_TRANSACTIONS',{cash_account_transactions:[{id:id+1,amount:'55.66',description:CANARY}]});
  });
  if(omit)for(const [url,route] of Object.entries(t))if(route.name===omit)delete t[url];
  return t;
}
function baseEnv(dir,{check=false}={}){
  const env={PATH:process.env.PATH,HOME:path.join(dir,'home'),TMPDIR:path.join(dir,'tmp'),LANG:'C',TZ:'UTC',
    GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'huanwujoy-crypto/fee-console',GITHUB_REF:'refs/heads/main',GITHUB_SHA:MAIN,GITHUB_EVENT_NAME:'workflow_dispatch',
    GITHUB_ACTOR_ID:String(OWNER),GITHUB_RUN_ATTEMPT:'1',GITHUB_RUN_ID:RUN_ID,GITHUB_EVENT_PATH:path.join(dir,'event.json'),FEE_REPORT_ACTIONS_TOKEN:ACTIONS_TOKEN,
    GOOGLE_APPLICATION_CREDENTIALS:'',CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE:'',GOOGLE_GHA_CREDS_PATH:''};
  if(!check)Object.assign(env,{FEE_CLOUD_SHARESIGHT_CLIENT_ID:CLIENT_ID,FEE_CLOUD_SHARESIGHT_CLIENT_SECRET:CLIENT_SECRET});
  return env;
}
function probeEvent(inputs={}){
  const i={source_probe_once:'true',source_probe_main:MAIN,source_probe_target:TARGET};
  for(const k of OFF)i[k]='false';for(const k of BLANK)i[k]='';
  return {sender:{id:OWNER},repository:{full_name:'huanwujoy-crypto/fee-console'},inputs:{...i,...inputs}};
}
function listing(dir){const out=[];const walk=p=>{for(const e of fs.readdirSync(p,{withFileTypes:true})){const q=path.join(p,e.name);out.push(path.relative(dir,q));if(e.isDirectory())walk(q);}};walk(dir);return out.sort();}

// Spawns the real CLI once. Returns its public output and the preload log.
async function cli({scenario={},routes={},env:envPatch={},event=probeEvent(),args,check=false,timeout=60000}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-source-probe-'));
  try{
    for(const d of ['home','tmp','work'])fs.mkdirSync(path.join(dir,d),{mode:0o700});
    const preload=path.join(dir,'preload.mjs'),logFile=path.join(dir,'log.json');
    fs.writeFileSync(preload,PRELOAD);fs.writeFileSync(path.join(dir,'event.json'),JSON.stringify(event));
    const env={...baseEnv(dir,{check}),...envPatch,HARNESS_LOG:logFile,HARNESS_NOW:NOW,HARNESS_ACTIONS_TOKEN:ACTIONS_TOKEN,HARNESS_ACCESS:ACCESS,
      HARNESS_SCENARIO:JSON.stringify({canary:CANARY,marker:'m-'+crypto.randomBytes(6).toString('hex'),...scenario}),HARNESS_ROUTES:JSON.stringify(routeTable(routes))};
    for(const [k,v] of Object.entries(env))if(v===undefined)delete env[k];
    const argv=args||[...(check?['--check-plan']:[]),'--expected-main='+MAIN,'--target='+TARGET];
    const before=listing(dir);
    const cmd=ISOLATION==='unshare'?['unshare',['-rn',process.execPath,'--import='+preload,CLI,...argv]]:[process.execPath,['--import='+preload,CLI,...argv]];
    const started=Date.now();
    const {status,stdout,stderr}=await new Promise(resolve=>{
      const child=spawn(cmd[0],cmd[1],{cwd:path.join(dir,'work'),env,stdio:['ignore','pipe','pipe']});let out='',err='';
      const timer=setTimeout(()=>child.kill('SIGKILL'),timeout);
      child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('close',code=>{clearTimeout(timer);resolve({status:code,stdout:out,stderr:err});});});
    const after=listing(dir).filter(p=>p!=='log.json');
    const log=JSON.parse(fs.readFileSync(logFile,'utf8'));
    return {status,stdout,stderr,log,elapsed:Date.now()-started,created:after.filter(p=>!before.includes(p))};
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
const KEYS=['schema','mode','outcome','stage','code','diagnostic','requests','requestBudget'];
function publicResult(r){
  assert.equal(r.stderr,'','stderr must stay empty');
  const lines=r.stdout.split('\n').filter(Boolean);assert.equal(lines.length,1,'exactly one public line');
  const value=JSON.parse(lines[0]);assert.deepEqual(Object.keys(value),KEYS);
  assert.equal(value.schema,'fee-console.source-probe.v1');assert.equal(value.requestBudget,26);
  assert.ok(SOURCE_PROBE_STAGES.includes(value.stage));if(value.code!==null)assert.ok(SOURCE_PROBE_CODES.includes(value.code),value.code);
  if(value.diagnostic!==null)assert.deepEqual(Object.keys(value.diagnostic),['route','phase','category']);
  // Privacy canaries: nothing private, raw, dated or identifying is printed.
  for(const secret of [CANARY,CLIENT_ID,CLIENT_SECRET,ACTIONS_TOKEN,ACCESS,MAIN,RUN_ID,TARGET,'936249','1350094','8100','8200','987654','13579','24680','11223','55.66','https:','api.','github','sharesight.com','Error','    at '])
    assert.ok(!r.stdout.includes(secret),'public output leaked '+secret);
  assert.equal(r.log.blocked,0,'no real network attempt');assert.equal(r.log.writes,0,'no file write');assert.equal(r.log.spawns,0,'no subprocess');
  assert.deepEqual(r.created,[],'no file created');
  return value;
}
const names=r=>r.log.requests.map(x=>x.route);
const perAccount=cash=>['PERFORMANCE','HOLDINGS','CASH_ACCOUNTS','TRADES',...Array(cash).fill('CASH_TRANSACTIONS')];

test('real CLI: ordinary fixed routes read once each, exactly in order, within the budget',async()=>{
  for(const cash of [1,8]){
    const r=await cli({routes:{cash}}),v=publicResult(r);
    assert.equal(r.status,0);assert.deepEqual([v.outcome,v.stage,v.code,v.diagnostic,v.mode],['ROUTES_READ','COMPLETE',null,null,'probe']);
    assert.equal(v.requests,2+2*(4+cash));assert.ok(v.requests<=SOURCE_PROBE_BUDGET.requests);
    const seen=names(r);assert.deepEqual(seen.slice(0,4),['GITHUB_REF','GITHUB_RUN','TOKEN','PORTFOLIOS']);
    const rest=seen.slice(4);assert.equal(rest.length,2*(4+cash));
    for(const k of [0,1]){const block=rest.slice(k*(4+cash),(k+1)*(4+cash));assert.deepEqual([...block.slice(0,4)].sort(),['CASH_ACCOUNTS','HOLDINGS','PERFORMANCE','TRADES']);assert.deepEqual(block.slice(4),Array(cash).fill('CASH_TRANSACTIONS'));}
    assert.equal(r.log.unexpected,0);
  }
  assert.equal(SOURCE_PROBE_BUDGET.requests,2+2*(4+SOURCE_PROBE_BUDGET.cashAccountsPerPortfolio),'the fixed maximum equals the budget exactly');
});
test('real CLI: a ninth cash account is a shape refusal before any extra request (budget cannot be exceeded)',async()=>{
  const r=await cli({routes:{cash:9}}),v=publicResult(r);
  assert.equal(r.status,1);assert.deepEqual([v.outcome,v.stage,v.code,v.diagnostic],['FAILED','ACCOUNT_ROUTES','PROBE_SHAPE',null]);
  assert.equal(v.requests,6);assert.ok(!names(r).includes('CASH_TRANSACTIONS'));
});
test('real CLI: check-plan proves only the exact main and run, with no Sharesight request or credential',async()=>{
  const r=await cli({check:true}),v=publicResult(r);
  assert.equal(r.status,0);assert.deepEqual([v.mode,v.outcome,v.stage,v.code,v.requests],['check-plan','PLAN_OK','COMPLETE',null,0]);
  assert.deepEqual(names(r),['GITHUB_REF','GITHUB_RUN']);
  const leaked=await cli({check:true,env:{FEE_CLOUD_SHARESIGHT_CLIENT_ID:CLIENT_ID}}),lv=publicResult(leaked);
  assert.equal(leaked.status,1);assert.deepEqual([lv.stage,lv.code],['ADMISSION','PROBE_ENVIRONMENT']);assert.deepEqual(names(leaked),[]);
});

const failures=[
  ['ECONNRESET at trades',{route:'TRADES',kind:'cause',code:'ECONNRESET'},'ACCOUNT_ROUTES','FEE_CLOUD_SOURCE_UNAVAILABLE',{route:'TRADES',phase:'FETCH',category:'ECONNRESET'}],
  ['ENOTFOUND at token',{route:'TOKEN',kind:'cause',code:'ENOTFOUND'},'TOKEN','FEE_CLOUD_AUTH_UNAVAILABLE',{route:'TOKEN',phase:'FETCH',category:'ENOTFOUND'}],
  ['response body interrupted at performance',{route:'PERFORMANCE',kind:'body',code:'UND_ERR_SOCKET'},'ACCOUNT_ROUTES','FEE_CLOUD_SOURCE_UNAVAILABLE',{route:'PERFORMANCE',phase:'BODY',category:'UND_ERR_SOCKET'}],
  ['connect timeout at cash accounts',{route:'CASH_ACCOUNTS',kind:'cause',code:'UND_ERR_CONNECT_TIMEOUT'},'ACCOUNT_ROUTES','FEE_CLOUD_SOURCE_UNAVAILABLE',{route:'CASH_ACCOUNTS',phase:'FETCH',category:'UND_ERR_CONNECT_TIMEOUT'}],
  ['HTTP 503 at holdings',{route:'HOLDINGS',kind:'http'},'ACCOUNT_ROUTES','FEE_CLOUD_HTTP_REJECTED',null],
  ['HTTP 503 at token',{route:'TOKEN',kind:'http'},'TOKEN','FEE_CLOUD_AUTH_REJECTED',null],
  ['bad JSON at cash transactions',{route:'CASH_TRANSACTIONS',kind:'json'},'CASH_TRANSACTIONS','FEE_CLOUD_RESPONSE_JSON',null],
  ['controlled local runtime fault at performance',{route:'PERFORMANCE',kind:'local-marker'},'ACCOUNT_ROUTES','FEE_CLOUD_SOURCE_UNAVAILABLE',{route:'PERFORMANCE',phase:'LOCAL',category:'NON_TRANSPORT'}],
  ['pagination marker at holdings',{route:'HOLDINGS',kind:'replace',body:{holdings:[],links:{next:'/page/2'}}},'ACCOUNT_ROUTES','PROBE_INCOMPLETE',null],
  ['pagination marker at portfolios',{route:'PORTFOLIOS',kind:'replace',body:{portfolios:[],meta:{pagination:{next_page:2}}}},'PORTFOLIOS','PROBE_INCOMPLETE',null],
  ['empty portfolio list',{route:'PORTFOLIOS',kind:'replace',body:{portfolios:[]}},'PORTFOLIOS','PROBE_IDENTITY',null],
  ['wrong portfolio currency',{route:'PORTFOLIOS',kind:'replace',body:{portfolios:[{id:936249,name:'Schwab-HK',currency_code:'HKD'},{id:1350094,name:'Webull',currency_code:'USD'}]}},'PORTFOLIOS','PROBE_IDENTITY',null],
  ['duplicate portfolio',{route:'PORTFOLIOS',kind:'replace',body:{portfolios:[...ACCOUNTS,...ACCOUNTS].map(a=>({...a,currency_code:'USD'}))}},'PORTFOLIOS','PROBE_IDENTITY',null],
  ['token response without a bearer token',{route:'TOKEN',kind:'replace',body:{access_token:'short',token_type:'bearer'}},'TOKEN','FEE_CLOUD_AUTH_RESPONSE',null],
  ['pagination marker on the performance payload',{route:'PERFORMANCE',kind:'replace',body:{report:{id:1},links:{next:'/page/2'}}},'ACCOUNT_ROUTES','PROBE_INCOMPLETE',null],
  ['has_more on the performance payload',{route:'PERFORMANCE',kind:'replace',body:{report:{id:1},has_more:true}},'ACCOUNT_ROUTES','PROBE_INCOMPLETE',null],
  ['next page inside the performance report',{route:'PERFORMANCE',kind:'replace',body:{report:{id:1,meta:{pagination:{next_page:2}}}}},'ACCOUNT_ROUTES','PROBE_INCOMPLETE',null],
  ['limited performance report',{route:'PERFORMANCE',kind:'replace',body:{report:{id:1,limited:true}}},'ACCOUNT_ROUTES','PROBE_INCOMPLETE',null],
  ['incomplete performance report',{route:'PERFORMANCE',kind:'replace',body:{report:{id:1,complete:false}}},'ACCOUNT_ROUTES','PROBE_INCOMPLETE',null],
  ['performance that is an array',{route:'PERFORMANCE',kind:'replace',body:[{report:{}}]},'ACCOUNT_ROUTES','PROBE_SHAPE',null],
  ['performance without a report',{route:'PERFORMANCE',kind:'replace',body:{other:true}},'ACCOUNT_ROUTES','PROBE_SHAPE',null],
];
for(const [label,scenario,stage,code,diagnostic] of failures)test('real CLI classifies '+label+' and stops at the first failure',async()=>{
  const r=await cli({scenario}),v=publicResult(r);
  assert.equal(r.status,1);assert.equal(r.log.injected,1,'the fault was reached exactly once');
  assert.deepEqual({outcome:v.outcome,stage:v.stage,code:v.code,diagnostic:v.diagnostic},{outcome:'FAILED',stage,code,diagnostic});
  if(scenario.kind==='local-marker')assert.equal(r.log.localInjected,1);
  const seen=names(r),at=seen.indexOf(scenario.route);assert.ok(at>=0);
  // Nothing after the failing request except its already-issued parallel siblings.
  const siblings=['PERFORMANCE','HOLDINGS','CASH_ACCOUNTS','TRADES'];
  for(const later of seen.slice(at+1))assert.ok(siblings.includes(scenario.route)&&siblings.includes(later),'request after failure: '+later);
  assert.equal(seen.filter(x=>x==='PERFORMANCE').length<=1,true,'never reaches the second account');
  assert.equal(r.log.unexpected,0);
});
test('real CLI: an unknown or unserved request is a classified failure, never a success',async()=>{
  const r=await cli({routes:{omit:'HOLDINGS'}}),v=publicResult(r);
  assert.equal(r.status,1);assert.equal(r.log.unexpected,1);
  assert.deepEqual([v.outcome,v.stage,v.code,v.diagnostic?.route,v.diagnostic?.phase],['FAILED','ACCOUNT_ROUTES','FEE_CLOUD_SOURCE_UNAVAILABLE','HOLDINGS','FETCH']);
  assert.ok(!names(r).includes('CASH_TRANSACTIONS'));
});
test('real CLI: the overall deadline stops before the next request, without a transport label',async()=>{
  const r=await cli({scenario:{jumpAfter:2,jumpMs:SOURCE_PROBE_BUDGET.overallMs+1000}}),v=publicResult(r);
  assert.equal(r.status,1);assert.deepEqual([v.stage,v.code,v.diagnostic,v.requests],['ACCOUNT_ROUTES','PROBE_DEADLINE',null,2]);
  assert.ok(!names(r).includes('PERFORMANCE'));
});
test('real CLI: a hanging request ends at the existing per-request deadline as a fixed category',{timeout:90000},async()=>{
  const r=await cli({scenario:{route:'TRADES',kind:'hang'},timeout:80000}),v=publicResult(r);
  assert.equal(r.status,1);assert.deepEqual([v.stage,v.code,v.diagnostic],['ACCOUNT_ROUTES','FEE_CLOUD_SOURCE_UNAVAILABLE',{route:'TRADES',phase:'FETCH',category:'DEADLINE'}]);
  assert.ok(r.elapsed<60000);
});

const admissionCases=[
  ['live main moved',{routes:{ref:'f'.repeat(40)}},'LIVE_MAIN','PROBE_LIVE_MAIN',['GITHUB_REF']],
  ['run title is the old IB diagnostic',{routes:{run:{display_title:'IB diagnostic 2026-11-06'}}},'CURRENT_RUN','PROBE_RUN',['GITHUB_REF','GITHUB_RUN']],
  ['run is a rerun',{routes:{run:{run_attempt:2}}},'CURRENT_RUN','PROBE_RUN',['GITHUB_REF','GITHUB_RUN']],
  ['run at another head',{routes:{run:{head_sha:'e'.repeat(40)}}},'CURRENT_RUN','PROBE_RUN',['GITHUB_REF','GITHUB_RUN']],
  ['run already completed',{routes:{run:{status:'completed',conclusion:'success'}}},'CURRENT_RUN','PROBE_RUN',['GITHUB_REF','GITHUB_RUN']],
  ['run in another workflow',{routes:{run:{path:'.github/workflows/other.yml'}}},'CURRENT_RUN','PROBE_RUN',['GITHUB_REF','GITHUB_RUN']],
  ['GitHub attempt 2',{env:{GITHUB_RUN_ATTEMPT:'2'}},'ADMISSION','PROBE_ENVIRONMENT',[]],
  ['checked-out sha differs',{env:{GITHUB_SHA:'e'.repeat(40)}},'ADMISSION','PROBE_ENVIRONMENT',[]],
  ['schedule event',{env:{GITHUB_EVENT_NAME:'schedule'}},'ADMISSION','PROBE_ENVIRONMENT',[]],
  ['other actor',{env:{GITHUB_ACTOR_ID:'1'}},'ADMISSION','PROBE_ENVIRONMENT',[]],
  ['other ref',{env:{GITHUB_REF:'refs/heads/topic'}},'ADMISSION','PROBE_ENVIRONMENT',[]],
  ['fee data key present',{env:{FEE_DATA_KEY:'k-'+CANARY}},'ADMISSION','PROBE_ENVIRONMENT',[]],
  ['economic gist present',{env:{FEE_ECON_GIST_ID:'g-'+CANARY}},'ADMISSION','PROBE_ENVIRONMENT',[]],
  ['benchmark cache present',{env:{BENCHMARK_CACHE_PATH:'/tmp/x'}},'ADMISSION','PROBE_ENVIRONMENT',[]],
  ['once main present',{env:{FEE_REPORT_ONCE_MAIN:''}},'ADMISSION','PROBE_ENVIRONMENT',[]],
  ['node options present',{env:{NODE_OPTIONS:''}},'ADMISSION','PROBE_ENVIRONMENT',[]],
  ['cloud credential file present',{env:{GOOGLE_APPLICATION_CREDENTIALS:'/tmp/creds.json'}},'ADMISSION','PROBE_ENVIRONMENT',[]],
  ['missing Sharesight secret in probe mode',{env:{FEE_CLOUD_SHARESIGHT_CLIENT_SECRET:undefined}},'ADMISSION','PROBE_ENVIRONMENT',[]],
  ['missing actions token',{env:{FEE_REPORT_ACTIONS_TOKEN:undefined}},'ADMISSION','PROBE_ENVIRONMENT',[]],
  ['event target differs',{event:probeEvent({source_probe_target:'2026-11-08'})},'ADMISSION','PROBE_EVENT',[]],
  ['event main differs',{event:probeEvent({source_probe_main:'e'.repeat(40)})},'ADMISSION','PROBE_EVENT',[]],
  ['probe flag off',{event:probeEvent({source_probe_once:'false'})},'ADMISSION','PROBE_EVENT',[]],
  ['mixed reviewed production',{event:probeEvent({run_reviewed_once:'true'})},'ADMISSION','PROBE_EVENT',[]],
  ['mixed ratio plan',{event:probeEvent({ratio_plan:'{}'})},'ADMISSION','PROBE_EVENT',[]],
  ['mixed report kind',{event:probeEvent({report_kind:'automatic-daily'})},'ADMISSION','PROBE_EVENT',[]],
  ['mixed envelope',{event:probeEvent({ib_envelope_once:'true'})},'ADMISSION','PROBE_EVENT',[]],
  ['unknown input',{event:probeEvent({extra:'x'})},'ADMISSION','PROBE_EVENT',[]],
  ['other sender',{event:{...probeEvent(),sender:{id:1}}},'ADMISSION','PROBE_EVENT',[]],
  ['future target',{args:['--expected-main='+MAIN,'--target=2026-11-11'],event:probeEvent({source_probe_target:'2026-11-11'})},'ADMISSION','PROBE_TARGET_DATE',[]],
  ['five-day-old target',{args:['--expected-main='+MAIN,'--target=2026-11-05'],event:probeEvent({source_probe_target:'2026-11-05'})},'ADMISSION','PROBE_TARGET_DATE',[]],
  ['impossible date',{args:['--expected-main='+MAIN,'--target=2026-02-30']},'ADMISSION','PROBE_ARGUMENT',[]],
  ['duplicate argument',{args:['--expected-main='+MAIN,'--expected-main='+MAIN,'--target='+TARGET]},'ADMISSION','PROBE_ARGUMENT',[]],
  ['unknown argument',{args:['--expected-main='+MAIN,'--target='+TARGET,'--publish']},'ADMISSION','PROBE_ARGUMENT',[]],
];
for(const [label,options,stage,code,expected] of admissionCases)test('real CLI refuses '+label+' before any source request',async()=>{
  const r=await cli(options),v=publicResult(r);
  assert.equal(r.status,1);assert.deepEqual([v.outcome,v.stage,v.code,v.diagnostic,v.requests],['FAILED',stage,code,null,0]);
  assert.deepEqual(names(r),expected);
});
test('real CLI accepts every target from today back to four Hong Kong days',async()=>{
  for(const target of ['2026-11-10','2026-11-06']){
    const r=await cli({routes:{target},args:['--expected-main='+MAIN,'--target='+target],event:probeEvent({source_probe_target:target})});
    assert.equal(r.status,0,r.stdout);assert.equal(JSON.parse(r.stdout).outcome,'ROUTES_READ');
    assert.ok(!r.stdout.includes(target));
  }
});
test('harness negative control: the preload really detects writes, network and unknown routes',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-source-probe-ctl-'));
  try{
    const preload=path.join(dir,'p.mjs'),logFile=path.join(dir,'l.json');fs.writeFileSync(preload,PRELOAD);
    const env={PATH:process.env.PATH,HARNESS_LOG:logFile,HARNESS_NOW:NOW,HARNESS_SCENARIO:'{}',HARNESS_ROUTES:'{}'};
    spawnSync(process.execPath,['--import='+preload,'-e',`const fs=require('node:fs');try{fs.writeFileSync('x','y')}catch{};try{require('node:net').connect(1,'127.0.0.1')}catch{};fetch('https://example.invalid/').catch(()=>{});`],{cwd:dir,env,encoding:'utf8'});
    const log=JSON.parse(fs.readFileSync(logFile,'utf8'));assert.equal(log.writes,1);assert.equal(log.blocked,1);assert.equal(log.unexpected,1);
    assert.ok(!fs.existsSync(path.join(dir,'x')));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

// ---- in-process unit checks of the same entry ----
test('argument and admission helpers are closed and reveal nothing',async()=>{
  assert.deepEqual(sourceProbeArgs(['--expected-main='+MAIN,'--target='+TARGET]),{expectedMain:MAIN,target:TARGET,checkOnly:false});
  for(const argv of [[],['--target='+TARGET],['--expected-main='+MAIN],['--expected-main='+MAIN.toUpperCase(),'--target='+TARGET],['--check-plan','--check-plan','--expected-main='+MAIN,'--target='+TARGET]])
    assert.throws(()=>sourceProbeArgs(argv),/^Error: PROBE_ARGUMENT$/);
  const env={...baseEnv('/nonexistent')},event=probeEvent(),args=sourceProbeArgs(['--expected-main='+MAIN,'--target='+TARGET]);
  assert.doesNotThrow(()=>validateSourceProbeAdmission({args,env,event,now:new Date(NOW)}));
  assert.throws(()=>validateSourceProbeAdmission({args,env:new Proxy(env,{}),event,now:new Date(NOW)}),/PROBE_ENVIRONMENT/);
  assert.throws(()=>validateSourceProbeAdmission({args,env,event,now:new Date(NaN)}),/PROBE_TARGET_DATE/);
  const thrown=await runSourceProbe({argv:['--expected-main='+MAIN,'--target='+TARGET],env,event,now:new Date(NOW),
    githubFetch:async()=>{throw Error(CANARY);},fetchImpl:()=>assert.fail('no source request before the live main is proven')});
  assert.deepEqual([thrown.stage,thrown.code,thrown.requests],['LIVE_MAIN','PROBE_LIVE_MAIN',0]);assert.ok(!JSON.stringify(thrown).includes(CANARY));
  assert.deepEqual(SOURCE_PROBE_INPUTS,['source_probe_once','source_probe_main','source_probe_target']);
});

// ---- workflow wiring (static evaluation of the actual expressions) ----
const jobs=[...WORKFLOW.matchAll(/^  ([a-z][a-z-]*):\n([\s\S]*?)(?=^  [a-z][a-z-]*:\n|(?![\s\S]))/gm)].filter(([,n])=>!['schedule','workflow_dispatch'].includes(n)).map(([,n,b])=>[n,b]);
const off={};for(const k of OFF)off[k]=false;for(const k of BLANK)off[k]='';Object.assign(off,{source_probe_once:false,source_probe_main:'',source_probe_target:''});
const probeInputs={...off,source_probe_once:true,source_probe_main:MAIN,source_probe_target:TARGET};
function condition(body,inputs,{github={},vars={},needs}={}){
  return Boolean(vm.runInNewContext(/(?:^|\n)    if: \$\{\{ (.+) \}\}/.exec(body)[1].replace(/needs\.([a-z]+(?:-[a-z]+)+)\./g,"needs['$1']."),{inputs,
    needs:needs||new Proxy({},{get:()=>({result:'success',outputs:{outcome:'produce',kind:'daily',target:TARGET}})}),cancelled:()=>false,always:()=>true,success:()=>true,failure:()=>false,
    github:{event_name:'workflow_dispatch',actor_id:'283054367',ref:'refs/heads/main',run_attempt:1,sha:MAIN,...github},
    vars:{FEE_REPORT_ONCE_MAIN:'',FEE_CLOUD_MODE:'publish',FEE_REPORT_DAILY_ENABLED:'true',FEE_REPORT_PERIODS_ENABLED:'true',...vars}}));
}
test('workflow: the probe job is the only job for probe fields, under every vars combination and always()',()=>{
  assert.equal(jobs.length,11);for(const [,body] of jobs)assert.match(body,/(?:^|\n)    if: \$\{\{ /);
  for(const vars of [{},{FEE_REPORT_ONCE_MAIN:'b'.repeat(40)},{FEE_REPORT_ONCE_MAIN:MAIN},{FEE_CLOUD_MODE:'shadow'}])
    assert.deepEqual(jobs.filter(([,b])=>condition(b,probeInputs,{vars})).map(([n])=>n),['source-probe'],JSON.stringify(vars));
  // Any single probe field excludes all ten other jobs, even when the rest of the inputs would admit them.
  const admitting=[{report_kind:'automatic-daily'},{...off,run_reviewed_once:true,report_kind:'daily',report_target:TARGET,manual_sync_completed_for:TARGET},{ratio_plan:'{}',ratio_main:MAIN},
    {source_plan_check_only:true},{source_acceptance_once:true},{ib_diagnostic_once:true,ib_diagnostic_main:MAIN},{ib_envelope_once:true,ib_envelope_main:MAIN}];
  for(const base of admitting){
    const others=jobs.filter(([n])=>n!=='source-probe');
    assert.ok(others.some(([,b])=>condition(b,{...off,...base},{vars:{FEE_REPORT_ONCE_MAIN:'b'.repeat(40)}}))||others.some(([,b])=>condition(b,{...off,...base})),'control: '+JSON.stringify(base));
    for(const probe of [{source_probe_once:true},{source_probe_main:MAIN},{source_probe_target:TARGET}])for(const vars of [{},{FEE_REPORT_ONCE_MAIN:'b'.repeat(40)}])
      assert.deepEqual(others.filter(([,b])=>condition(b,{...off,...base,...probe},{vars})).map(([n])=>n),[],JSON.stringify({base,probe,vars}));
  }
  const finish=jobs.find(([n])=>n==='once-finish')[1];
  assert.equal(condition(finish,off,{vars:{FEE_REPORT_ONCE_MAIN:'b'.repeat(40)}}),true,'control: once-finish runs under always()');
  for(const probe of [{source_probe_once:true},{source_probe_main:MAIN},{source_probe_target:TARGET}])assert.equal(condition(finish,{...off,...probe},{vars:{FEE_REPORT_ONCE_MAIN:'b'.repeat(40)}}),false);
});
test('workflow: the probe job refuses mixed inputs and wrong dispatch context',()=>{
  const job=jobs.find(([n])=>n==='source-probe')[1];
  assert.equal(condition(job,probeInputs),true);
  for(const github of [{run_attempt:2},{actor_id:'1'},{ref:'refs/heads/topic'},{event_name:'schedule'},{sha:'b'.repeat(40)}])assert.equal(condition(job,probeInputs,{github}),false);
  for(const k of OFF)assert.equal(condition(job,{...probeInputs,[k]:true}),false,k);
  for(const k of BLANK)assert.equal(condition(job,{...probeInputs,[k]:'x'}),false,k);
  for(const change of [{source_probe_once:false},{source_probe_main:''},{source_probe_main:'b'.repeat(40)},{source_probe_target:''}])assert.equal(condition(job,{...probeInputs,...change}),false);
  assert.equal(condition(job,{}, {github:{event_name:'schedule'}}),false);
});
test('workflow: the probe job reuses the existing identity and receives only two Sharesight values',()=>{
  const job=jobs.find(([n])=>n==='source-probe')[1].replace(/^ *#.*\n/gm,''),produce=jobs.find(([n])=>n==='produce')[1];
  assert.match(job,/^    name: Fee source probe\n/);assert.match(job,/\n    timeout-minutes: 10\n/);assert.match(job,/\n    environment: fee-cloud-producer\n/);
  assert.match(job,/\n    permissions:\n      contents: read\n      actions: read\n      id-token: write\n    steps:\n/);
  for(const key of ['workload_identity_provider','service_account','project_id']){const value=new RegExp('\\n +'+key+': (.+)\\n');assert.equal(value.exec(job)[1],value.exec(produce)[1],key);}
  assert.equal((job.match(/^\s+(client_id|client_secret):family-portfolio-gateway\/sharesight-broker-sync-client-(id|secret)\/1$/gm)||[]).length,2);
  assert.equal((job.match(/secretmanager/g)||[]).length,1);
  const run=[...job.matchAll(/\n        run: (.+)/g)].map(m=>m[1]);
  const pin='test "$(git rev-parse HEAD)" = "$PROBE_MAIN" && ';
  assert.deepEqual(run,[pin+'node scripts/fee-source-probe.mjs --check-plan --expected-main="$PROBE_MAIN" --target="$PROBE_TARGET"',pin+'node scripts/fee-source-probe.mjs --expected-main="$PROBE_MAIN" --target="$PROBE_TARGET"']);
  for(const forbidden of ['FEE_DATA_KEY','FEE_ECON','secrets.','benchmark','data.json','upload-artifact','cache','GH_TOKEN','GITHUB_TOKEN:','contents: write','issues','pull-requests','git push','daily.mjs','fee-report-producer','FEE_CLOUD_GITHUB_TOKEN','RATIO_','IB_MANAGER','concurrency'])
    assert.ok(!job.includes(forbidden),forbidden);
  const probeStep=job.split('- name: Probe the fixed ordinary source routes')[1];
  assert.deepEqual([...probeStep.matchAll(/\n          ([A-Z_]+):/g)].map(m=>m[1]),['PROBE_MAIN','PROBE_TARGET','FEE_REPORT_ACTIONS_TOKEN','FEE_CLOUD_SHARESIGHT_CLIENT_ID','FEE_CLOUD_SHARESIGHT_CLIENT_SECRET','GOOGLE_APPLICATION_CREDENTIALS','CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE','GOOGLE_GHA_CREDS_PATH']);
  const checkStep=job.split('- name: Verify the exact probe main')[1].split('- name:')[0];
  assert.ok(!checkStep.includes('SHARESIGHT'));assert.ok(job.indexOf('--check-plan')<job.indexOf('google-github-actions/auth'),'check-plan before any credential');
});
test('workflow: one shared producer concurrency group serializes the probe with every production run',()=>{
  assert.match(WORKFLOW,/\nconcurrency:\n  group: fee-cloud-producer\n  cancel-in-progress: false\n/);
  assert.match(WORKFLOW,/\npermissions:\n  contents: read\n  id-token: write\n/);
  const inputs=WORKFLOW.split('  workflow_dispatch:\n    inputs:\n')[1].split('\npermissions:')[0];
  assert.equal([...inputs.matchAll(/^      ([a-z_]+):$/gm)].length,21);
  for(const name of SOURCE_PROBE_INPUTS)assert.match(inputs,new RegExp('\\n      '+name+':\\n'));
});
test('workflow: the run title is distinct from the old IB diagnostic title and from production',()=>{
  const expr=/^run-name: \$\{\{ (.+) \}\}$/m.exec(WORKFLOW)[1],title=inputs=>vm.runInNewContext(expr,{inputs,github:{workflow:'Fee console cloud producer'}});
  assert.equal(title(probeInputs),'Fee source probe');assert.equal(title({...off,ib_envelope_once:true}),'IB diagnostic 2026-11-06');assert.equal(title(off),'Fee console cloud producer');
  assert.notEqual(SOURCE_PROBE_TITLE,'IB diagnostic 2026-11-06');assert.notEqual(SOURCE_PROBE_TITLE,'IB diagnostic 2026-11-04');
});

// ---- supervisor isolation (trigger and later historical classification) ----
const supRun=(conclusion,id,event='schedule')=>({id,status:'completed',conclusion,event,producerValidated:conclusion==='success',created_at:`2026-10-01T0${id}:00:00Z`,html_url:`https://github.test/runs/${id}`});
const trustedProbe={...supRun('failure',9,'workflow_dispatch'),display_title:'Fee source probe',head_branch:'main',head_sha:'0123456789abcdef0123456789abcdef01234567',
  path:'.github/workflows/fee-cloud-producer.yml',actor:{id:283054367},run_attempt:1};
test('supervisor: a trusted probe at any old head neither escalates nor resets failures; impostors still count',()=>{
  const prior=[supRun('failure',2),supRun('failure',1)];
  assert.equal(isIbReadOnlyDiagnostic(trustedProbe),true,'historical identity does not require the old head to equal a current main');
  for(const conclusion of ['failure','timed_out','success','cancelled']){const d={...trustedProbe,conclusion,producerValidated:true};
    assert.equal(consecutiveFailures([d,...prior]),2);assert.doesNotMatch(diagnosticBody([d,...prior]),/runs\/9/);}
  for(const change of [d=>d.event='schedule',d=>d.head_branch='other',d=>d.path='other',d=>d.actor.id=1,d=>d.actor=null,d=>d.run_attempt=2,d=>d.head_sha='invalid',
    ...['fee source probe','Fee source probe ','Fee source probe 2026-11-09','Fee source'].map(n=>d=>d.display_title=n)]){
    const d=structuredClone(trustedProbe);change(d);assert.equal(isIbReadOnlyDiagnostic(d),false);assert.equal(consecutiveFailures([d,...prior]),3);assert.match(diagnosticBody([d,...prior]),/runs\/9/);
  }
  const expression=SUPERVISOR.match(/    if: \$\{\{ (.+) \}\}/)[1],eligible=Function('github','return ('+expression+')');
  assert.equal(eligible({event:{workflow_run:trustedProbe}}),false);
  for(const change of [{actor:{id:1}},{run_attempt:2},{event:'schedule'},{head_branch:'topic'},{path:'.github/workflows/other.yml'},{display_title:'Fee console cloud producer'}])
    assert.equal(eligible({event:{workflow_run:{...trustedProbe,...change}}}),true,JSON.stringify(change));
});

test('workflow: the probe job checks out the exact dispatched commit and re-verifies it before each step runs repository code',()=>{
  const job=jobs.find(([n])=>n==='source-probe')[1].replace(/^ *#.*\n/gm,'');
  const checkout=/- uses: actions\/checkout@[0-9a-f]{40}\n        with:\n          ref: (.+)\n          persist-credentials: false\n/.exec(job);
  assert.equal(checkout?.[1],'${{ github.sha }}','never ref: main');assert.ok(!/ref: main/.test(job));
  assert.match(job,/inputs\.source_probe_main == github\.sha/,'the dispatched commit is the approved input');
  const steps=[...job.matchAll(/\n        run: (.+)/g)].map(m=>m[1]);assert.equal(steps.length,2);
  for(const step of steps)assert.ok(step.startsWith('test "$(git rev-parse HEAD)" = "$PROBE_MAIN" && node scripts/fee-source-probe.mjs '));
  // Every other job keeps its original checkout unchanged.
  assert.equal((WORKFLOW.match(/\n          ref: main\n/g)||[]).length,5);
});
test('performance completeness: a complete payload and report pass; the shared markers fail at either level without extra requests',async()=>{
  const ok=await cli({scenario:{route:'PERFORMANCE',kind:'replace',body:{report:{id:1,complete:true,has_more:false,links:{self:'/x'}},links:{self:'/x'}}}}),v=publicResult(ok);
  assert.equal(v.outcome,'ROUTES_READ');
  const bad=await cli({scenario:{route:'PERFORMANCE',kind:'replace',body:{report:{id:1,truncated:true}}}}),b=publicResult(bad);
  assert.deepEqual([b.code,b.requests],['PROBE_INCOMPLETE',6]);assert.ok(!names(bad).includes('CASH_TRANSACTIONS'));
});
test('hard overall deadline: the result returns by 120 s even if an in-flight request would run longer, and that request is aborted',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.parse(NOW)});
  const routes=routeTable({cash:8}),signals=[],started=Date.now();let calls=0;
  const fetchImpl=(url,init)=>{calls++;signals.push(init.signal);const route=routes[String(url)];
    // Every source request answers after 19 s (inside the 20 s transport limit) and ignores abort.
    return new Promise(resolve=>setTimeout(()=>resolve({url:String(url),status:200,redirected:false,type:'basic',headers:{get:k=>String(k).toLowerCase()==='content-type'?'application/json':null},
      body:{getReader(){let sent=false;return {read:async()=>sent?{done:true}:(sent=true,{done:false,value:new TextEncoder().encode(route.body)}),cancel:async()=>{},releaseLock(){}};}}}),19000));};
  const githubFetch=async url=>{const route=routes[String(url)];return {url:String(url),status:200,redirected:false,headers:{get:k=>String(k).toLowerCase()==='content-type'?'application/json':null},
    body:{getReader(){let sent=false;return {read:async()=>sent?{done:true}:(sent=true,{done:false,value:new TextEncoder().encode(route.body)}),cancel:async()=>{},releaseLock(){}};}}};};
  let finished=null;
  const pending=runSourceProbe({argv:['--expected-main='+MAIN,'--target='+TARGET],env:baseEnv('/nonexistent'),event:probeEvent(),now:new Date(NOW),fetchImpl,githubFetch}).then(v=>{finished={v,at:Date.now()-started};});
  for(let i=0;i<200&&!finished;i++){t.mock.timers.tick(1000);for(let k=0;k<20;k++)await new Promise(r=>setImmediate(r));}
  await pending;
  assert.equal(finished.v.code,'PROBE_DEADLINE');assert.equal(finished.v.outcome,'FAILED');assert.equal(finished.v.diagnostic,null);
  assert.ok(finished.at>=SOURCE_PROBE_BUDGET.overallMs&&finished.at<=SOURCE_PROBE_BUDGET.overallMs+1000,'returned at '+finished.at);
  // Token 0 s, list 19 s, four parallel 38 s, cash 57/76/95/114 s: ten requests start before 120 s;
  // the one started at 114 s would only answer at 133 s.
  assert.equal(finished.v.requests,calls);assert.equal(calls,10);assert.equal(signals.at(-1).aborted,true,'the in-flight request is aborted');
  assert.ok(finished.v.requests<=SOURCE_PROBE_BUDGET.requests);
});
test('hard overall deadline is not reached by an ordinary fast probe, and the timer is cleared',async()=>{
  const r=await cli({routes:{cash:8}});assert.equal(JSON.parse(r.stdout).outcome,'ROUTES_READ');assert.ok(r.elapsed<15000,'process exits promptly: '+r.elapsed);
});
