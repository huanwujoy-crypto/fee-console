import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {authenticated} from './fee-ratio-official-source.test.mjs';
import {createRatioCloudPublisher} from './fee-ratio-cloud-publish.mjs';
import {syntheticFeePublicationFixture} from './fee-ratio-fee-publication.test.mjs';
import {ratioAdmission,ratioScheduledAdmission,ratioRunAdmission,RATIO_SCHEDULE_CRON,RATIO_SCHEDULE_PREVIOUS,createRatioTransport,executeRatioCloud,saveRatioReceipt,safeRatioReceipt,RATIO_BUCKET,RATIO_OWNER} from './fee-ratio-cloud-runtime.mjs';
const gid='0'.repeat(32),managerToken='synthetic-manager-token-not-real-123',accessToken='synthetic-google-token-not-real-123',repositoryToken='synthetic-repository-token-not-real-123',head='a'.repeat(40),canary='CANARY_PRIVATE_TOKEN_NEVER_LOG';
const mainUrl='https://api.github.com/repos/huanwujoy-crypto/fee-console/git/ref/heads/main';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const response=(url,value,status=200)=>{const r=new Response(status===204||status===412?null:typeof value==='string'?value:JSON.stringify(value),{status});Object.defineProperty(r,'url',{value:url});return r;};
const plan=()=>({mode:'verify-current',previousBodySha256:'b'.repeat(64),bundleId:null,original:null,input:null,library:null,fee:null});
function admission(p=plan()){
 const event={sender:{id:RATIO_OWNER},repository:{full_name:'huanwujoy-crypto/fee-console'},inputs:{ratio_main:head,ratio_plan:JSON.stringify(p)}};
 const env={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'huanwujoy-crypto/fee-console',GITHUB_ACTOR_ID:String(RATIO_OWNER),GITHUB_SHA:head,GITHUB_TOKEN:repositoryToken,RATIO_PLAN:event.inputs.ratio_plan,FEE_ECON_GIST_ID:gid,FEE_DATA_KEY:Buffer.alloc(32,7).toString('base64url'),FEE_RATIO_MANAGER_TOKEN:managerToken};return {event,env};
}
function forbidFinancialAccess(env){
 let reads=0;for(const key of ['FEE_ECON_GIST_ID','FEE_DATA_KEY','FEE_RATIO_MANAGER_TOKEN','RATIO_STORAGE_ACCESS_TOKEN'])Object.defineProperty(env,key,{get(){reads++;throw Error(canary);}});
 return ()=>reads;
}
const safe=()=>({schema:'fee-console.ratio-cloud-safe-result.v1',status:'REFUSED',stage:'ADMISSION',claim:'NOT_ATTEMPTED',patchAttempts:0,bodySha256:null,contentSha256:null,cleanup:'NO_INPUTS_READ'});
test('exact manual owner/main/attempt and closed plan; fee inputs cannot be mixed',()=>{
 assert.equal(ratioAdmission(admission().env,admission().event).mode,'verify-current');
 const inactive=admission();Object.assign(inactive.event.inputs,{ib_diagnostic_once:'false',ib_diagnostic_main:'',confirmed_main:''});assert.equal(ratioAdmission(inactive.env,inactive.event).mode,'verify-current');
 for(const patch of [{ib_diagnostic_once:'true'},{ib_diagnostic_main:head},...['a'.repeat(40),null,false,0].map(confirmed_main=>({confirmed_main}))]){const f=admission();Object.assign(f.event.inputs,patch);assert.throws(()=>ratioAdmission(f.env,f.event),/REFUSED/);}
 for(const change of [f=>f.env.GITHUB_EVENT_NAME='schedule',f=>f.env.GITHUB_RUN_ATTEMPT='2',f=>f.env.GITHUB_REF='refs/heads/other',f=>f.env.GITHUB_ACTOR_ID='1',f=>f.event.sender.id=1,f=>f.event.inputs.ratio_main='c'.repeat(40),f=>f.event.inputs.run_reviewed_once='true',f=>f.event.inputs.manual_sync_completed_for='2026-11-02',f=>f.event.inputs.bad=canary,f=>f.env.RATIO_PLAN='{}']){const f=admission();change(f);assert.throws(()=>ratioAdmission(f.env,f.event),/REFUSED/);}
});
test('full read-only entry authenticates exact packet; no storage, claims, PATCH or financial API',async t=>{
 const f=await authenticated(t),p=plan();p.previousBodySha256=await f.ratio.digest(f.signed.body);const a=admission(p),calls=[],saved=[],files={};
 for(const [name,value]of [['fee-console-ratio-recipient.json',f.manager.recipient],['fee-console-ratio-snapshot.json',f.signed]]){const content=JSON.stringify(value);files[name]={filename:name,size:Buffer.byteLength(content),content,truncated:false};}
 const fetchImpl=async(url,o)=>{calls.push({url,method:o.method||'GET'});assert.equal(o.redirect,'error');if(url===mainUrl){assert.equal(o.headers.Authorization,'Bearer '+repositoryToken);return response(url,{object:{sha:head}});}assert.equal(o.headers.Authorization,'Bearer '+managerToken);if(url.endsWith('/user'))return response(url,{id:RATIO_OWNER,login:'synthetic-owner'});assert.equal(url,'https://api.github.com/gists/'+gid);return response(url,{id:gid,public:false,owner:{id:RATIO_OWNER,login:'synthetic-owner'},history:[{version:'d'.repeat(40)}],files});};
 const r=await executeRatioCloud({...a,fetchImpl,publisher:createRatioCloudPublisher({exposureCore:f.exposure}),clock:()=>f.now,saveReceipt:async v=>saved.push(structuredClone(v))});assert.equal(r.status,'VERIFIED_CURRENT_NO_WRITE');assert.equal(r.patchAttempts,0);assert.deepEqual(saved.at(-1),r);assert.equal(calls.length,3);assert.ok(calls.every(c=>c.method==='GET'&&!c.url.includes('storage')));
});
test('public preflight main mismatch and unknown inputs fail before credentials, preserving fixed receipt',async()=>{
 for(const change of [false,true]){const a=admission(),calls=[],saved=[];const r=await executeRatioCloud({...a,env:{...a.env,FEE_RATIO_MANAGER_TOKEN:undefined},preflight:true,fetchImpl:async url=>{calls.push(url);return response(url,{object:{sha:change?'b'.repeat(40):head}});},saveReceipt:async v=>saved.push(v)});assert.equal(calls.length,1);assert.equal(change?r.stage:r.preflight,change?'MAIN_HEAD':true);if(change)assert.equal(saved.length,1);}
 const a=admission();a.event.inputs.bad=canary;const saved=[];const r=await executeRatioCloud({...a,fetchImpl:()=>{throw Error('NO_CALL')},saveReceipt:async v=>saved.push(v)});assert.equal(r.stage,'ADMISSION');assert.ok(!JSON.stringify(saved).includes(canary));
});
test('authenticated main preflight avoids synthetic anonymous rate limiting without financial access',async()=>{
 const a=admission(),reads=forbidFinancialAccess(a.env),calls=[];
 const fetchImpl=async(url,o)=>{calls.push({url,authorization:o.headers.Authorization});assert.equal(url,mainUrl);return o.headers.Authorization==='Bearer '+repositoryToken?response(url,{object:{sha:head}}):response(url,{message:canary},403);};
 assert.equal((await fetchImpl(mainUrl,{headers:{}})).status,403);calls.length=0;
 const r=await executeRatioCloud({...a,preflight:true,fetchImpl,saveReceipt:async()=>assert.fail('successful preflight has no failure receipt')});
 assert.deepEqual(r,{preflight:true,mode:'verify-current',due:true});assert.deepEqual(calls,[{url:mainUrl,authorization:'Bearer '+repositoryToken}]);assert.equal(reads(),0);
});
test('missing or malformed repository token refuses before fetch, publisher or financial-secret access',async()=>{
 for(const preflight of [true,false])for(const value of [undefined,null,false,42,'','short','a'.repeat(8193),' '+repositoryToken,repositoryToken+'\n',repositoryToken+'\0',repositoryToken+'\x7f',repositoryToken+'é']){
  const a=admission(),reads=forbidFinancialAccess(a.env),saved=[];a.env.GITHUB_TOKEN=value;let calls=0,publishes=0;
  const r=await executeRatioCloud({...a,preflight,fetchImpl:async()=>{calls++;throw Error(canary);},publisher:{async run(){publishes++;throw Error(canary);}},saveReceipt:async v=>saved.push(v)});
  assert.deepEqual(r,{...safe(),stage:'MAIN_TOKEN'});assert.deepEqual(saved,[r]);assert.equal(calls,0);assert.equal(publishes,0);assert.equal(reads(),0);assert.ok(!JSON.stringify(saved).includes(canary));
 }
});
test('main failures retain bounded fixed diagnostics, stop before private reads, and never retry',async t=>{
 const cases=[
  ['network','MAIN_FETCH',()=>{throw Error(canary);}],
  ['HTTP 403','MAIN_HTTP',()=>response(mainUrl,{message:canary},403)],
  ['HTTP 429','MAIN_HTTP',()=>response(mainUrl,{message:canary},429)],
  ['redirect','MAIN_RESPONSE',()=>{const r=response(mainUrl,{});Object.defineProperty(r,'redirected',{value:true});return r;}],
  ['wrong URL','MAIN_RESPONSE',()=>response('https://example.invalid/'+canary,{object:{sha:head}})],
  ['body failure','MAIN_RESPONSE',()=>({status:200,redirected:false,url:mainUrl,text:async()=>{throw Error(canary);}})],
  ['oversized body','MAIN_RESPONSE',()=>response(mainUrl,canary+'x'.repeat(65537))],
  ['invalid JSON','MAIN_RESPONSE',()=>response(mainUrl,canary)],
  ['changed main','MAIN_HEAD',()=>response(mainUrl,{object:{sha:'b'.repeat(40)}})],
  ['missing main','MAIN_HEAD',()=>response(mainUrl,{message:canary})]
 ];
 for(const [name,stage,makeResponse]of cases)await t.test(name,async()=>{
  for(const preflight of [true,false]){
   const a=admission(),reads=forbidFinancialAccess(a.env),saved=[];let calls=0,publishes=0;
   const r=await executeRatioCloud({...a,preflight,fetchImpl:async(url,o)=>{calls++;assert.equal(url,mainUrl);assert.equal(o.headers.Authorization,'Bearer '+repositoryToken);assert.equal(o.redirect,'error');assert.equal(o.credentials,'omit');return makeResponse();},publisher:{async run(){publishes++;throw Error(canary);}},saveReceipt:async v=>saved.push(v)});
   assert.deepEqual(r,{...safe(),stage});assert.deepEqual(saved,[r]);assert.equal(calls,1);assert.equal(publishes,0);assert.equal(reads(),0);
   for(const secret of [canary,repositoryToken,managerToken,accessToken])assert.ok(!JSON.stringify(saved).includes(secret));
  }
 });
});
function transportFixture({truncated=false,mutate=()=>{},extra}={}){
 const body=Buffer.from('{"synthetic":"snapshot"}'),raw='https://gist.githubusercontent.com/synthetic-owner/'+gid+'/raw/'+'c'.repeat(40)+'/fee-console-ratio-snapshot.json';
 const files={'fee-console-ratio-recipient.json':{filename:'fee-console-ratio-recipient.json',content:'{}',size:2,truncated:false},'fee-console-ratio-snapshot.json':{filename:'fee-console-ratio-snapshot.json',content:body.toString(),size:body.length,truncated,raw_url:raw}};
 const gist={id:gid,public:false,owner:{id:RATIO_OWNER,login:'synthetic-owner'},history:[{version:'d'.repeat(40)}],files};mutate(gist);const calls=[];
 const io=createRatioTransport({gistId:gid,managerToken,accessToken,saveReceipt:async()=>{},fetchImpl:async(url,o)=>{calls.push({url,o});assert.equal(o.redirect,'error');assert.equal(o.credentials,'omit');if(url.endsWith('/user'))return response(url,{id:RATIO_OWNER,login:'synthetic-owner'});if(url==='https://api.github.com/gists/'+gid)return response(url,gist);if(url===raw){assert.equal(o.headers.Authorization,undefined);return response(url,body.toString());}if(extra)return extra(url,o);throw Error(canary);}});return {io,calls,body,raw,gist};
}
test('truncated exact older file revision; no credential to raw host; cleanup clears held bytes',async()=>{
 const f=transportFixture({truncated:true}),r=await f.io.readDestination('fee-console-ratio-snapshot.json');assert.ok(r.snapshotBytes.equals(f.body));assert.equal(f.calls.length,3);await f.io.cleanupLocal();assert.ok(r.snapshotBytes.every(x=>x===0));
});
test('wrong owner/public/id/raw URL/filename/size fail closed',async()=>{
 for(const mutate of [g=>g.owner.id=1,g=>g.public=true,g=>g.id='1'.repeat(32),g=>g.files['fee-console-ratio-snapshot.json'].filename='fee-console-db.json',g=>g.files['fee-console-ratio-snapshot.json'].size++,g=>g.files['fee-console-ratio-snapshot.json'].raw_url='https://example.invalid/'+canary]){const f=transportFixture({truncated:true,mutate});await assert.rejects(f.io.readDestination('fee-console-ratio-snapshot.json'),/REFUSED/);assert.ok(f.calls.every(c=>c.o.method==='GET'));}
});
test('redirect, oversized stream and transport failure do not retry',async()=>{
 for(const kind of ['redirect','oversize','throw']){let calls=0;const io=createRatioTransport({gistId:gid,managerToken,saveReceipt:async()=>{},fetchImpl:async(url)=>{calls++;if(kind==='throw')throw Error(canary);const r=response(url,kind==='oversize'?'x'.repeat(65537):{});if(kind==='redirect')Object.defineProperty(r,'redirected',{value:true});return r;}});await assert.rejects(io.readDestination('fee-console-ratio-snapshot.json'));assert.equal(calls,1);}
});
test('pinned input exact metadata and hash; no object listing',async()=>{
 const bytes=Buffer.from('{}'),s={name:'inputs/'+'a'.repeat(64)+'/original.json',generation:'101',sha256:hash(bytes)};
 const f=transportFixture({extra:async(url,o)=>{assert.equal(o.headers.Authorization,'Bearer '+accessToken);assert.ok(url.includes(encodeURIComponent(s.name)));assert.ok(url.includes('generation=101'));return response(url,url.endsWith('&alt=media')?'{}':{bucket:RATIO_BUCKET,name:s.name,generation:s.generation,size:'2'});}});
 assert.ok((await f.io.readInput(s)).bytes.equals(bytes));assert.equal(f.calls.length,2);await assert.rejects(f.io.readInput({...s,name:'claims/x.json'}),/REFUSED/);assert.equal(f.calls.length,2);
});
test('create-only claims conflict without retry; no claim deletion or reset',async()=>{
 const name='claims/'+'b'.repeat(64)+'.json',body={bodySha256:'a'.repeat(64),contentSha256:'b'.repeat(64)};
 const f=transportFixture({extra:async(url,o)=>{if(o.method==='DELETE'){assert.match(url,/generation=101&ifGenerationMatch=101$/);assert.ok(url.includes('inputs%2F'));return response(url,null,204);}assert.equal(o.method,'POST');assert.ok(url.endsWith('&ifGenerationMatch=0'));return response(url,null,412);}});
 assert.equal(await f.io.claimOnce(name,body,{ifGenerationMatch:0}),'EXISTS');assert.equal(f.calls.length,1);await assert.rejects(f.io.claimOnce(name,body,{ifGenerationMatch:1}),/REFUSED/);
 const spec=n=>({name:'inputs/'+'a'.repeat(64)+'/'+n+'.json',generation:'101',sha256:'a'.repeat(64)});await f.io.deleteInputs([spec('original'),spec('input')]);assert.equal(f.calls.length,3);await assert.rejects(f.io.deleteInputs([{...spec('input'),name}]),/REFUSED/);
});
test('one fixed-file PATCH only; no fee/health/recipient/ledger write',async()=>{
 const f=transportFixture(),body={files:{'fee-console-ratio-snapshot.json':{content:'{}'}}};await f.io.patchSnapshot(body);await assert.rejects(f.io.patchSnapshot(body),/REFUSED/);assert.equal(f.calls.filter(c=>c.o.method==='PATCH').length,1);
 for(const name of ['fee-console-db.json','fee-console-fund.json','fee-console-ratio-recipient.json','data.json','fee-data-health.json']){const g=transportFixture();await assert.rejects(g.io.patchSnapshot({files:{[name]:{content:'{}'}}}),/REFUSED/);assert.equal(g.calls.length,0);}
});
test('outer error cannot erase a possibly issued PATCH outcome',async()=>{
 const a=admission(),saved=[],publisher={async run({io}){await io.saveReceipt({...safe(),stage:'READBACK',status:'WRITE_UNCONFIRMED',patchAttempts:1});throw Error(canary);}};
 const r=await executeRatioCloud({...a,publisher,fetchImpl:async url=>response(url,{object:{sha:head}}),saveReceipt:async v=>saved.push(v)});assert.equal(r.patchAttempts,1);assert.equal(r.status,'WRITE_UNCONFIRMED');assert.equal(saved.at(-1).patchAttempts,1);
});
test('safe receipt atomic save refuses extra fields and cannot overwrite pending evidence',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ratio-safe-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'result.json');saveRatioReceipt(file,safe());assert.equal(fs.statSync(file).mode&0o777,0o600);assert.deepEqual(JSON.parse(fs.readFileSync(file)),safe());assert.throws(()=>safeRatioReceipt({...safe(),secret:canary}),/REFUSED/);fs.writeFileSync(file+'.pending','pending');assert.throws(()=>saveRatioReceipt(file,safe()));assert.deepEqual(JSON.parse(fs.readFileSync(file)),safe());
});
test('fee gate statuses and fixed stage:code pairs are closed; free text is refused',()=>{
 assert.deepEqual(safeRatioReceipt({...safe(),status:'WAITING_FEE_READBACK_NO_WRITE',stage:'FEE_READBACK:FEE_PUBLICATION_LIVE'}).stage,'FEE_READBACK:FEE_PUBLICATION_LIVE');
 for(const stage of ['FEE_READBACK','FEE_RECHECK','FEE_RECHECK:FEE_PUBLICATION_CHANGED'])assert.equal(safeRatioReceipt({...safe(),stage}).stage,stage);
 for(const stage of ['FEE_READBACK:'+canary,'FEE_RECHECK:FEE_PUBLICATION_EXPIRED','FEE_PUBLICATION_LIVE'])assert.throws(()=>safeRatioReceipt({...safe(),stage}),/REFUSED/);
});
test('main diagnostic stages remain a closed enum and legacy MAIN receipts remain readable',()=>{
 for(const stage of ['MAIN','MAIN_TOKEN','MAIN_FETCH','MAIN_HTTP','MAIN_RESPONSE','MAIN_HEAD'])assert.deepEqual(safeRatioReceipt({...safe(),stage}),{...safe(),stage});
 assert.throws(()=>safeRatioReceipt({...safe(),stage:'MAIN_'+canary}),/REFUSED/);assert.throws(()=>safeRatioReceipt({...safe(),stage:'MAIN_HTTP',response:canary}),/REFUSED/);
});
test('actual final command fails admission without networking and saves before displaying',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ratio-entry-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.writeFileSync(path.join(dir,'event.json'),JSON.stringify({bad:canary}));
 const r=spawnSync(process.execPath,['scripts/fee-ratio-cloud-runtime.mjs','--preflight'],{cwd:new URL('..',import.meta.url),env:{...process.env,GITHUB_EVENT_PATH:path.join(dir,'event.json'),RUNNER_TEMP:dir,GITHUB_ACTIONS:'false'},encoding:'utf8'});assert.equal(r.status,1);assert.ok(!r.stdout.includes(canary));assert.ok(!r.stderr.includes(canary));assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'fee-ratio-result.safe.json'))).stage,'ADMISSION');
});
test('scheduled ratio admission: first slot only, opt-in, a proved session on the previous Hong Kong date, no operator plan',()=>{
 const env=(extra={})=>({GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'schedule',GITHUB_RUN_ATTEMPT:'1',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'huanwujoy-crypto/fee-console',GITHUB_SHA:head,
  FEE_RATIO_AUTO_ENABLED:'true',RATIO_SCHEDULE:RATIO_SCHEDULE_CRON,FEE_REPORT_MARKETS:'NYSE,NASDAQ,LSE,SIX,EURONEXT_AMSTERDAM,EURONEXT_PARIS',RATIO_PLAN:'',...extra});
 const event=()=>({schedule:RATIO_SCHEDULE_CRON}),at=t=>new Date(t);
 // Tuesday 09:00 Hong Kong: the target is Monday, a session.
 const due=ratioScheduledAdmission(env(),event(),at('2026-11-17T01:00:05Z'));
 assert.deepEqual(due,{scheduled:true,due:true,asOf:'2026-11-16',plan:{mode:'publish-api',previousBodySha256:RATIO_SCHEDULE_PREVIOUS,asOf:'2026-11-16',fee:null},planText:JSON.stringify(due.plan)});
 assert.deepEqual(ratioRunAdmission(env(),event(),at('2026-11-17T01:00:05Z')),due);
 // A late delivery the same Hong Kong day keeps the same target; the next day moves on.
 assert.equal(ratioScheduledAdmission(env(),event(),at('2026-11-17T15:59:00Z')).asOf,'2026-11-16');assert.equal(ratioScheduledAdmission(env(),event(),at('2026-11-17T16:00:00Z')).asOf,'2026-11-17');
 // Sunday and Monday mornings follow a closed day: nothing is due and no plan exists.
 for(const t of ['2026-11-15T01:00:00Z','2026-11-16T01:00:00Z','2026-12-26T01:00:00Z'])assert.deepEqual(ratioScheduledAdmission(env(),event(),at(t)),{scheduled:true,due:false,asOf:new Date(Date.parse(t)+8*3600000-86400000).toISOString().slice(0,10),plan:null,planText:null});
 // U.S. Thanksgiving with Europe open is a session for the configured scope; with a U.S.-only scope it is not.
 assert.equal(ratioScheduledAdmission(env(),event(),at('2026-11-27T01:00:00Z')).due,true);assert.equal(ratioScheduledAdmission(env({FEE_REPORT_MARKETS:'NYSE,NASDAQ'}),event(),at('2026-11-27T01:00:00Z')).due,false);
 // The slot comes from the workflow's own value; an event file without the field is accepted, one that disagrees is not.
 assert.equal(ratioScheduledAdmission(env(),{},at('2026-11-17T01:00:05Z')).due,true);
 // Refused: not opted in, another slot, a rerun, another ref or repository, an operator plan, an unknown venue or year, a bad clock.
 for(const [e,ev,t] of [[env({FEE_RATIO_AUTO_ENABLED:'false'}),event()],[env({FEE_RATIO_AUTO_ENABLED:undefined}),event()],[env(),{schedule:'30 3 * * *'}],[env(),{schedule:'0 6 * * *'}],[env({RATIO_SCHEDULE:'30 3 * * *'}),event()],[env({RATIO_SCHEDULE:'0 6 * * *'}),{}],[env({RATIO_SCHEDULE:''}),event()],[env({RATIO_SCHEDULE:undefined}),event()],[env(),null],[env(),[]],
   [env({GITHUB_RUN_ATTEMPT:'2'}),event()],[env({GITHUB_REF:'refs/heads/other'}),event()],[env({GITHUB_REPOSITORY:'someone/fork'}),event()],[env({GITHUB_SHA:'x'}),event()],
   [env({RATIO_PLAN:'{}'}),event()],[env(),{...event(),inputs:{ratio_plan:'{}'}}],[env({FEE_REPORT_MARKETS:''}),event()],[env({FEE_REPORT_MARKETS:'NYSE,EURONEXT'}),event()],
   [env({FEE_REPORT_MARKETS:'NYSE,NYSE'}),event()],[env(),event(),'2028-01-05T01:00:00Z'],[env(),event(),'not a date']])
  assert.throws(()=>ratioScheduledAdmission(e,ev,at(t||'2026-11-17T01:00:05Z')),/REFUSED/);
 // A manual dispatch never becomes a scheduled admission, and a scheduled event never passes the manual one.
 assert.equal(ratioRunAdmission(admission().env,admission().event).scheduled,false);assert.throws(()=>ratioAdmission(env(),event()),/REFUSED/);
 assert.throws(()=>ratioScheduledAdmission(admission().env,admission().event,at('2026-11-17T01:00:05Z')),/REFUSED/);
});
test('a scheduled run publishes on its own, follows the verified current snapshot, and a day without a session reads nothing',async()=>{
 const env={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'schedule',GITHUB_RUN_ATTEMPT:'1',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'huanwujoy-crypto/fee-console',GITHUB_SHA:head,GITHUB_RUN_ID:'4300000001',GITHUB_TOKEN:repositoryToken,
  FEE_RATIO_AUTO_ENABLED:'true',RATIO_SCHEDULE:RATIO_SCHEDULE_CRON,FEE_REPORT_MARKETS:'NYSE,NASDAQ,LSE',RATIO_PLAN:'',FEE_ECON_GIST_ID:gid,FEE_DATA_KEY:Buffer.alloc(32,7).toString('base64url'),FEE_RATIO_MANAGER_TOKEN:managerToken,RATIO_STORAGE_ACCESS_TOKEN:'synthetic-storage-token-not-real-123'};
 const event={schedule:RATIO_SCHEDULE_CRON},now=new Date('2026-11-17T01:00:05Z'),fetchImpl=async url=>response(url,{object:{sha:head}});
 const admitted=ratioScheduledAdmission(env,event,now),bundleId='a'.repeat(64);
 const capture={schema:'fee-console.ratio-api-capture-safe.v1',status:'CAPTURED',stage:'COMPLETE',code:null,requests:54,planSha256:hash(Buffer.from(admitted.planText)),mainSha:head,runId:env.GITHUB_RUN_ID,
  bundleId,original:{name:'inputs/'+bundleId+'/original.json',generation:'101',sha256:'1'.repeat(64)},input:{name:'inputs/'+bundleId+'/input.json',generation:'102',sha256:'2'.repeat(64)}};
 const seen=[],ok={schema:'fee-console.ratio-cloud-safe-result.v1',status:'PUBLISHED_CONFIRMED',stage:'COMPLETE',claim:'OWNED',patchAttempts:1,bodySha256:'c'.repeat(64),contentSha256:'d'.repeat(64),cleanup:'LOCAL_AND_PINNED_INPUTS'};
 const run=(extra={})=>executeRatioCloud({env,event,fetchImpl,clock:()=>now,saveReceipt:async()=>{},readCapture:async()=>structuredClone(capture),publisher:{run:async a=>{seen.push(a);return ok;}},...extra});
 const pre=await run({preflight:true});assert.deepEqual(pre,{preflight:true,mode:'publish-api',due:true});
 const r=await run();assert.equal(r.status,'PUBLISHED_CONFIRMED');assert.equal(seen.length,1);
 assert.deepEqual(seen[0].plan,{mode:'publish',previousBodySha256:RATIO_SCHEDULE_PREVIOUS,bundleId,original:capture.original,input:capture.input,library:null,fee:null});
 assert.deepEqual(seen[0].followCurrent,{asOf:'2026-11-16'});
 // A capture made for another plan (for example a manual one) is not accepted by the scheduled run.
 seen.length=0;const other=await run({readCapture:async()=>({...capture,planSha256:'0'.repeat(64)})});assert.deepEqual([other.status,other.stage,seen.length],['REFUSED','PLAN',0]);
 // A closed day: the preflight says not due without a single request; the publication entry refuses if it is reached anyway.
 const closed=new Date('2026-11-16T01:00:00Z');let calls=0;const none=async()=>{calls++;throw Error('NO_CALL');};
 assert.deepEqual(await run({preflight:true,clock:()=>closed,fetchImpl:none}),{preflight:true,mode:'not-due',due:false});
 const refused=await run({clock:()=>closed,fetchImpl:none});assert.deepEqual([refused.status,refused.stage],['REFUSED','ADMISSION']);assert.equal(calls,0);assert.equal(seen.length,0);
 // A manual dispatch never asks the publisher to follow the current snapshot.
 const a=admission({mode:'publish-api',previousBodySha256:'b'.repeat(64),asOf:'2026-11-16',fee:null}),manual=[];
 const cap2={...capture,planSha256:hash(Buffer.from(a.env.RATIO_PLAN)),runId:'4300000002'};
 await executeRatioCloud({env:{...a.env,GITHUB_RUN_ID:'4300000002',RATIO_STORAGE_ACCESS_TOKEN:'synthetic-storage-token-not-real-123'},event:a.event,fetchImpl,clock:()=>now,saveReceipt:async()=>{},readCapture:async()=>cap2,publisher:{run:async x=>{manual.push(x);return ok;}}});
 assert.equal(manual.length,1);assert.equal(Object.hasOwn(manual[0],'followCurrent'),false);assert.equal(manual[0].plan.previousBodySha256,'b'.repeat(64));
});
test('the scheduled ratio branch is gated in the workflow and adds no job, input, title or secret',()=>{
 const wf=fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml',import.meta.url),'utf8');
 const job=name=>wf.split('\n  '+name+':\n')[1].split(/\n  [a-z-]+:\n/)[0],pre=job('ratio-preflight'),ratio=job('ratio');
 const gate="(github.event_name == 'schedule' && github.event.schedule == '0 1 * * *' && vars.FEE_RATIO_AUTO_ENABLED == 'true')";
 for(const body of [pre,ratio]){const line=body.split('\n').find(l=>l.startsWith('    if: '));assert.ok(line.includes(gate));assert.ok(line.includes("github.ref == 'refs/heads/main' && github.run_attempt == 1 && ("));assert.ok(line.startsWith('    if: ${{ !inputs.ib_diagnostic_once && !inputs.ib_diagnostic_main && '));}
 // The manual branch keeps every earlier condition, including the owner check and the exact main.
 assert.ok(pre.includes("github.event_name == 'workflow_dispatch' && github.actor_id == '283054367' && inputs.report_kind != 'automatic-daily' && inputs.ratio_plan != '' && inputs.ratio_main == github.sha"));
 assert.ok(ratio.includes("!cancelled() && needs.ratio-preflight.result == 'success' && needs.ratio-preflight.outputs.due == 'true'"));
 // The ratio waits for the fee source job of the same run, so the two never read Sharesight at once; it runs whatever that job's outcome.
 assert.ok(ratio.startsWith('    # Also after the fee source job'));assert.ok(ratio.includes('\n    needs: [ratio-preflight, produce]\n'));assert.equal(pre.includes('needs:'),false);
 assert.equal(wf.split('RATIO_SCHEDULE: ${{ github.event.schedule }}').length-1,3);assert.ok(ratio.includes("github.event_name == 'workflow_dispatch' && inputs.ratio_main == github.sha"));
 assert.ok(pre.includes('    outputs:\n      due: ${{ steps.ratio_admission.outputs.ratio_due }}\n'));
 // Only the first of the three slots, and only this one new opt-in variable; the other slots and jobs are untouched.
 assert.equal(wf.split("github.event.schedule == '0 1 * * *'").length-1,2);assert.equal(wf.split('vars.FEE_RATIO_AUTO_ENABLED').length-1,5);
 assert.equal(wf.includes("github.event.schedule == '30 3 * * *'"),false);assert.equal(wf.includes("github.event.schedule == '0 6 * * *'"),false);
 assert.deepEqual([...wf.matchAll(/^  ([a-z][a-z-]*):\n/gm)].map(m=>m[1]).filter(n=>n.startsWith('ratio')),['ratio-preflight','ratio']);
 assert.match(wf,/^run-name: \$\{\{ inputs\.source_probe_once && 'Fee source probe' \|\| \(inputs\.ib_diagnostic_once \|\| inputs\.ib_envelope_once\) && 'IB diagnostic 2026-11-06' \|\| \(inputs\.ratio_plan != '' \|\| inputs\.ratio_main != ''\) && 'Manual ratio snapshot' \|\| github\.workflow \}\}$/m);
 // A scheduled ratio failure does not fail the scheduled fee run; a manual one still fails. No other job has this.
 for(const body of [pre,ratio])assert.ok(body.includes("\n    continue-on-error: ${{ github.event_name == 'schedule' }}\n"));assert.equal(wf.split('continue-on-error:').length-1,2);
 // An empty manual plan can never be parsed on a scheduled run.
 assert.equal(wf.includes('fromJSON(inputs.ratio_plan)'),false);assert.equal(wf.split("fromJSON(inputs.ratio_plan || '{}')").length-1,5);
});
test('workflow isolates all fee jobs, preserves schedule/concurrency and never exposes SS credentials to ratio',()=>{
 const wf=fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml',import.meta.url),'utf8');for(const job of ['period','once-admit','produce','once-finish','source-plan-check','source-acceptance']){const body=wf.split('\n  '+job+':\n')[1].split(/\n  [a-z-]+:\n/)[0];assert.match(body,/    if: \$\{\{ !inputs\.ib_diagnostic_once && !inputs\.ib_diagnostic_main && !inputs\.ratio_plan && !inputs\.ratio_main && /,job);}
 assert.match(wf,/group: fee-cloud-producer\n  cancel-in-progress: false/);assert.match(wf,/cron: '0 1 \* \* \*'/);assert.deepEqual([...wf.matchAll(/- cron: '([^']+)'/g)].map(m=>m[1]),['0 1 * * *','30 3 * * *','0 6 * * *']);
 const ratio=wf.split('\n  ratio:\n')[1].split(/\n  [a-z-]+:\n/)[0];const ratioSteps=ratio.split(/\n      - /).slice(1),publishStep=ratioSteps.find(s=>s.includes('fee-ratio-cloud-runtime.mjs --run')),captureStep=ratioSteps.find(s=>s.includes('fee-ratio-api-capture.mjs --capture'));
 // Owner decision 2026-11-14: Sharesight values and publication secrets are separated by step, no longer by job.
 // The publication step never receives a Sharesight value; the capture step never receives a publication secret.
 assert.ok(publishStep&&captureStep);assert.ok(!publishStep.includes('SHARESIGHT'));assert.ok(!publishStep.includes('ratio_capture_credentials'));
 for(const secret of ['FEE_RATIO_MANAGER_TOKEN','FEE_DATA_KEY','FEE_ECON_GIST_ID','IB_MANAGER_BASELINE_SHA256','GITHUB_TOKEN','secrets.'])assert.ok(!captureStep.includes(secret),secret);
 assert.deepEqual([...captureStep.matchAll(/^          ([A-Z_]+):/gm)].map(m=>m[1]),['RATIO_PLAN','FEE_RATIO_AUTO_ENABLED','RATIO_SCHEDULE','FEE_REPORT_MARKETS','RATIO_STORAGE_ACCESS_TOKEN','FEE_CLOUD_SHARESIGHT_CLIENT_ID','FEE_CLOUD_SHARESIGHT_CLIENT_SECRET','GOOGLE_APPLICATION_CREDENTIALS','CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE','GOOGLE_GHA_CREDS_PATH']);
 assert.equal(ratioSteps.filter(s=>s.includes('SHARESIGHT')).length,1);assert.equal(ratioSteps.filter(s=>s.includes('sharesight-broker-sync')).length,1);
 // Every API-capture step runs only for the publish-api mode, and the capture precedes the publication.
 for(const s of ratioSteps.filter(s=>/API capture|fee-ratio-api-capture/.test(s)))assert.ok(s.includes("\n        if: ${{ github.event_name == 'schedule' || fromJSON(inputs.ratio_plan || '{}').mode == 'publish-api' }}\n"));
 assert.ok(ratioSteps.indexOf(captureStep)<ratioSteps.indexOf(publishStep));assert.equal(ratioSteps.filter(s=>/API capture|fee-ratio-api-capture/.test(s)).length,3);
 for(const key of ['GOOGLE_APPLICATION_CREDENTIALS','CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE','GOOGLE_GHA_CREDS_PATH'])assert.ok(publishStep.includes(key+": ''"),key);assert.ok(!ratio.includes('fee-report-producer.mjs'));assert.match(ratio,/create_credentials_file: false/);assert.match(ratio,/access_token_scopes: https:\/\/www.googleapis.com\/auth\/devstorage.read_write/);assert.ok(ratio.includes("fromJSON(inputs.ratio_plan || '{}').mode == 'publish'"));assert.equal((wf.match(/secrets.FEE_RATIO_MANAGER_TOKEN/g)||[]).length,1);assert.match(ratio,/path: \$\{\{ runner.temp \}\}\/fee-ratio-result.safe.json/);
 for(const job of ['ratio-preflight','ratio']){const body=wf.split('\n  '+job+':\n')[1].split(/\n  [a-z-]+:\n/)[0];assert.equal((body.match(/GITHUB_TOKEN: \$\{\{ github.token \}\}/g)||[]).length,1);assert.match(body,/GITHUB_TOKEN: \$\{\{ github.token \}\}\n          RATIO_PLAN: \$\{\{ inputs.ratio_plan \}\}/);assert.match(body,/permissions:\n      contents: read\n/);assert.ok(!body.includes('contents: write'));}
 const preflight=wf.split('\n  ratio-preflight:\n')[1].split(/\n  [a-z-]+:\n/)[0];assert.ok(!preflight.includes('secrets.'));assert.ok(!preflight.includes('id-token: write'));
 // The fee readback needs only the existing non-secret baseline variable; no new secret or scope.
 assert.equal((ratio.match(/IB_MANAGER_BASELINE_SHA256: \$\{\{ vars.IB_MANAGER_BASELINE_SHA256 \}\}/g)||[]).length,1);assert.ok(!preflight.includes('IB_MANAGER_BASELINE_SHA256'));
 assert.equal((ratio.match(/secrets\./g)||[]).length,3);assert.match(ratio,/permissions:\n      contents: read\n      id-token: write\n/);
});

test('complete publish entry: pinned storage, real crypto, durable intent, one PATCH, exact readback and cleanup',async t=>{
 const {createOfficialRatioSourceCore}=await import('./fee-ratio-official-source.mjs');const f=await authenticated(t),raw=structuredClone(f.raw);raw.classification.capturedAt='2026-10-30T05:45:00.000Z';raw.exposure.capturedAt='2026-10-30T05:44:00.000Z';
 const original=Buffer.from(JSON.stringify(raw)),input=Buffer.from(JSON.stringify(createOfficialRatioSourceCore().build(raw,{sourceSha256:hash(original),sourceBytes:original.length}).input));
 const bundleId=hash(Buffer.concat([original,input])),spec=(file,b,generation)=>({name:'inputs/'+bundleId+'/'+file+'.json',generation,sha256:hash(b)});
 const p={mode:'publish',previousBodySha256:await f.ratio.digest(f.signed.body),bundleId,original:spec('original',original,'101'),input:spec('input',input,'102'),library:{fileId:'libfile_'+'9'.repeat(32),version:0},fee:null};
 // The fee report was promoted at another main; its cutoff is not the ratio date.
 const fee=await syntheticFeePublicationFixture({targetDate:'2026-10-27',reviewedMain:head,feeMain:'c'.repeat(40),repoToken:repositoryToken,clock:()=>f.now});
 p.fee=fee.handoff;assert.notEqual(p.fee.accountingThrough,JSON.parse(input).classification.asOf);
 const a=admission(p);a.env.RATIO_STORAGE_ACCESS_TOKEN=accessToken;a.env.IB_MANAGER_BASELINE_SHA256=fee.ibBaselineSha256;assert.equal(a.env.FEE_DATA_KEY,fee.feeDataKey);
 let current=JSON.stringify(f.signed),revision='d'.repeat(40),patches=0,claims=0;const events=[],saved=[],objects=new Map([[p.original.name,{spec:p.original,bytes:original}],[p.input.name,{spec:p.input,bytes:input}]]);
 const fetchImpl=async(url,o)=>{
  const u=new URL(url);events.push(o.method||'GET');
  // Repository API reads (main check and fee readback) carry only the existing
  // read-only token; Pages reads carry none. Both are checked by the fixture.
  if(url.startsWith('https://api.github.com/repos/huanwujoy-crypto/fee-console/')||url.startsWith('https://huanwujoy-crypto.github.io/fee-console/'))
   return fee.args.fetchImpl(url,{...o,method:o.method||'GET',cache:'no-store'});
  if(u.host==='api.github.com'){
   assert.equal(o.headers.Authorization,'Bearer '+managerToken);
   if(url.endsWith('/user'))return response(url,{id:RATIO_OWNER,login:'synthetic-owner'});
   assert.equal(url,'https://api.github.com/gists/'+gid);
   if(o.method==='PATCH'){assert.equal(saved.at(-1).stage,'WRITE_INTENT');patches++;current=JSON.parse(o.body).files['fee-console-ratio-snapshot.json'].content;revision='e'.repeat(40);}
   const files={};for(const [name,content]of [['fee-console-ratio-recipient.json',JSON.stringify(f.manager.recipient)],['fee-console-ratio-snapshot.json',current]])files[name]={filename:name,content,size:Buffer.byteLength(content),truncated:false};
   return response(url,{id:gid,public:false,owner:{id:RATIO_OWNER,login:'synthetic-owner'},history:[{version:revision}],files});
  }
  assert.equal(u.host,'storage.googleapis.com');assert.equal(o.headers.Authorization,'Bearer '+accessToken);
  if(o.method==='POST'){claims++;assert.equal(u.searchParams.get('ifGenerationMatch'),'0');assert.match(u.searchParams.get('name'),/^claims\/[a-f0-9]{64}\.json$/);return response(url,{bucket:RATIO_BUCKET,name:u.searchParams.get('name'),generation:'301'});}
  const name=decodeURIComponent(u.pathname.split('/o/')[1]),obj=objects.get(name);assert.ok(obj);assert.equal(u.searchParams.get('generation'),obj.spec.generation);
  if(o.method==='DELETE'){assert.equal(u.searchParams.get('ifGenerationMatch'),obj.spec.generation);objects.delete(name);return response(url,null,204);}
  return response(url,u.searchParams.get('alt')==='media'?obj.bytes.toString():{bucket:RATIO_BUCKET,name,generation:obj.spec.generation,size:String(obj.bytes.length)});
 };
 const r=await executeRatioCloud({...a,fetchImpl,publisher:createRatioCloudPublisher({exposureCore:f.exposure}),clock:()=>f.now,saveReceipt:async v=>{saved.push(structuredClone(v));events.push('saved');}});
 assert.equal(r.status,'PUBLISHED_CONFIRMED');assert.equal(patches,1);assert.equal(claims,1);assert.equal(objects.size,0);assert.equal(r.cleanup,'LOCAL_AND_PINNED_INPUTS');assert.equal(events.at(-1),'saved');assert.equal(JSON.parse(current).body.version,2);assert.ok(!JSON.stringify(saved).includes(managerToken));
 // Two complete fee readbacks: before the claim and again before durable intent.
 assert.equal(fee.calls.filter(c=>c.url.endsWith('/contents/data.json?ref='+'c'.repeat(40))).length,2);
 assert.equal(fee.calls.filter(c=>c.url.startsWith('https://huanwujoy-crypto.github.io/')).length,4);
 assert.ok(!JSON.stringify(saved).includes(repositoryToken));
});
test('unpublished or superseded fee stops before the claim; a change after the claim stops before PATCH',async t=>{
 const {createOfficialRatioSourceCore}=await import('./fee-ratio-official-source.mjs');
 for(const kind of ['pages','live','recheck']){
  const f=await authenticated(t),raw=structuredClone(f.raw);raw.classification.capturedAt='2026-10-30T05:45:00.000Z';raw.exposure.capturedAt='2026-10-30T05:44:00.000Z';
  const original=Buffer.from(JSON.stringify(raw)),input=Buffer.from(JSON.stringify(createOfficialRatioSourceCore().build(raw,{sourceSha256:hash(original),sourceBytes:original.length}).input));
  const bundleId=hash(Buffer.concat([original,input])),spec=(file,b,generation)=>({name:'inputs/'+bundleId+'/'+file+'.json',generation,sha256:hash(b)});
  let pageReads=0;
  const fee=await syntheticFeePublicationFixture({targetDate:'2026-10-27',reviewedMain:head,repoToken:repositoryToken,clock:()=>f.now,
   editPageData:b=>(++pageReads,kind==='pages'||kind==='recheck'&&pageReads===2)?Buffer.concat([b,Buffer.from('\n')]):b,
   editRoot:r=>kind==='live'?r.map(x=>x.name==='data.json'?{...x,sha:'9'.repeat(40)}:x):r});
  const p={mode:'publish',previousBodySha256:await f.ratio.digest(f.signed.body),bundleId,original:spec('original',original,'101'),input:spec('input',input,'102'),library:{fileId:'libfile_'+'9'.repeat(32),version:0},fee:fee.handoff};
  const a=admission(p);a.env.RATIO_STORAGE_ACCESS_TOKEN=accessToken;a.env.IB_MANAGER_BASELINE_SHA256=fee.ibBaselineSha256;
  let claims=0,patches=0;const saved=[],objects=new Map([[p.original.name,{spec:p.original,bytes:original}],[p.input.name,{spec:p.input,bytes:input}]]);
  const fetchImpl=async(url,o)=>{
   if(url.startsWith('https://api.github.com/repos/huanwujoy-crypto/fee-console/')||url.startsWith('https://huanwujoy-crypto.github.io/fee-console/'))return fee.args.fetchImpl(url,{...o,method:o.method||'GET',cache:'no-store'});
   const u=new URL(url);
   if(u.host==='api.github.com'){
    if(url.endsWith('/user'))return response(url,{id:RATIO_OWNER,login:'synthetic-owner'});
    if(o.method==='PATCH')patches++;
    const files={};for(const [name,content]of [['fee-console-ratio-recipient.json',JSON.stringify(f.manager.recipient)],['fee-console-ratio-snapshot.json',JSON.stringify(f.signed)]])files[name]={filename:name,content,size:Buffer.byteLength(content),truncated:false};
    return response(url,{id:gid,public:false,owner:{id:RATIO_OWNER,login:'synthetic-owner'},history:[{version:'d'.repeat(40)}],files});
   }
   if(o.method==='POST'){claims++;return response(url,{bucket:RATIO_BUCKET,name:u.searchParams.get('name'),generation:'301'});}
   const name=decodeURIComponent(u.pathname.split('/o/')[1]),obj=objects.get(name);
   if(o.method==='DELETE'){objects.delete(name);return response(url,null,204);}
   return response(url,u.searchParams.get('alt')==='media'?obj.bytes.toString():{bucket:RATIO_BUCKET,name,generation:obj.spec.generation,size:String(obj.bytes.length)});
  };
  const r=await executeRatioCloud({...a,fetchImpl,publisher:createRatioCloudPublisher({exposureCore:f.exposure}),clock:()=>f.now,saveReceipt:async v=>saved.push(structuredClone(v))});
  assert.equal(patches,0,kind);
  if(kind==='recheck'){assert.equal(r.status,'REFUSED');assert.equal(r.stage,'FEE_RECHECK:FEE_PUBLICATION_PAGES_DATA');assert.equal(claims,1);assert.equal(r.claim,'OWNED');}
  else{assert.equal(r.status,'WAITING_FEE_READBACK_NO_WRITE');assert.equal(r.stage,'FEE_READBACK:FEE_PUBLICATION_'+(kind==='pages'?'PAGES_DATA':'LIVE'));assert.equal(claims,0);assert.equal(r.claim,'NOT_ATTEMPTED');}
  assert.deepEqual(safeRatioReceipt(r),r);assert.ok(!JSON.stringify(saved).includes(repositoryToken)&&!JSON.stringify(saved).includes(canary));
 }
});


test('ratio-only runs do not wake fee failure diagnosis or candidate promotion',()=>{
 const root=new URL('../.github/workflows/',import.meta.url),producer=fs.readFileSync(new URL('fee-cloud-producer.yml',root),'utf8'),supervisor=fs.readFileSync(new URL('fee-cloud-supervisor.yml',root),'utf8'),promotion=fs.readFileSync(new URL('promote-fee-data.yml',root),'utf8');
 assert.match(producer,/run-name:.*inputs.ratio_plan.*inputs.ratio_main.*Manual ratio snapshot.*github.workflow/);
 const expression=supervisor.match(/    if: \$\{\{ (.+) \}\}/)[1],eligible=Function('github','return ('+expression+')');
 assert.equal(eligible({event:{workflow_run:{display_title:'Manual ratio snapshot'}}}),false);
 assert.equal(eligible({event:{workflow_run:{display_title:'Fee cloud producer'}}}),true);
 assert.ok(!promotion.includes('- Fee console cloud producer'));
});

test('fee-first critical section: only the two publishing jobs share one queued job-level group, outer groups unchanged',()=>{
 const root=new URL('../.github/workflows/',import.meta.url),read=n=>fs.readFileSync(new URL(n,root),'utf8');
 const producer=read('fee-cloud-producer.yml'),promotion=read('promote-fee-data.yml');
 const block='    concurrency:\n      group: fee-publication-critical\n      cancel-in-progress: false\n      queue: max\n';
 const job=(wf,name)=>wf.split('\n  '+name+':\n')[1].split(/\n  [a-z-]+:\n/)[0];
 assert.ok(job(producer,'ratio').includes(block));assert.ok(job(promotion,'promote').includes(block));
 // Exactly these two jobs, across every workflow, and never at workflow level.
 const all=fs.readdirSync(root).filter(n=>n.endsWith('.yml')).map(n=>[n,read(n)]);
 assert.deepEqual(all.flatMap(([n,t])=>Array(t.split('fee-publication-critical').length-1).fill(n)).sort(),['fee-cloud-producer.yml','promote-fee-data.yml']);
 for(const name of ['period','produce','ratio-preflight','once-admit','once-finish','ib-diagnostic','ib-envelope-evidence'])assert.ok(!job(producer,name).includes('fee-publication-critical'),name);
 assert.match(producer,/\nconcurrency:\n  group: fee-cloud-producer\n  cancel-in-progress: false\n\n/);
 assert.match(promotion,/\nconcurrency:\n  group: promote-fee-data\n  cancel-in-progress: false\n\n/);
 // A holder never waits: no sleeps, polls or run watches inside either critical job.
 for(const body of [job(producer,'ratio'),job(promotion,'promote')])assert.doesNotMatch(body.replace(/^ *#.*$/gm,''),/\bsleep\b|gh run watch|until\s|timeout-minutes: (?:[2-9]\d|\d{3,})/);
 // The cron schedules and the ratio job's own permissions stay as reviewed.
 assert.deepEqual([...producer.matchAll(/- cron: '([^']+)'/g)].map(m=>m[1]),['0 1 * * *','30 3 * * *','0 6 * * *']);
 assert.deepEqual([...promotion.matchAll(/- cron: '([^']+)'/g)].map(m=>m[1]),['45 2 * * *','15 5,6 * * *']);
 assert.match(job(producer,'ratio'),/permissions:\n      contents: read\n      id-token: write\n/);
});
test('ratio admission accepts the inert source-probe defaults and refuses any active probe field',()=>{
 const inert=admission();Object.assign(inert.event.inputs,{source_probe_once:'false',source_probe_main:'',source_probe_target:''});assert.equal(ratioAdmission(inert.env,inert.event).mode,'verify-current');
 for(const patch of [{source_probe_once:'true'},{source_probe_once:true},{source_probe_main:head},{source_probe_target:'2026-11-09'}]){const f=admission();Object.assign(f.event.inputs,patch);assert.throws(()=>ratioAdmission(f.env,f.event),/REFUSED/);}
});
