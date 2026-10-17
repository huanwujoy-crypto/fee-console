// Entirely synthetic offline fixtures. Never read the actual private report,
// registration artifact inputs, credentials, broker, IAM or cloud storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {buildEodActionModel} from '../../scripts/xuan-ib-eod-action-model.mjs';
import {renderNightActionReport,NIGHT_ACTION_MARKER} from '../../scripts/xuan-ib-night-action-view.mjs';
import {fingerprint} from '../../scripts/xuan-ib-run-manifest.mjs';
import {readAiRiskAccounts} from '../../scripts/xuan-ib-ai-coefficient-resolver.mjs';
import {SNAPSHOT_SCOPES,digest} from './eod_sources.mjs';
import {resolveCurrentCall} from './call_record.mjs';
import {OWNER_BINDING,SOURCE_IDENTITY_SHA256,prepareOwnerStaticDisplay} from './owner_latest_admission.mjs';
import {OWNER_SCOPE,LATEST_TARGET,DEADLINE_MS} from './owner_latest.mjs';
import {createOwnerPreflightLease,FINANCIAL_ADMISSION_TTL_MS,FULL_PREFLIGHT_TTL_MS} from './owner_preview_access.mjs';
import {acceptedPreviewRegistrationText,buildAcceptedPreviewMetadata,renderAcceptedPreviewDisplay,
  prepareAcceptedPreviewDisplay,createProtectedOwnerPreviewVerifier,createAcceptedPreviewPublisher,previewMetadataSha256,ACCEPTED_PREVIEW_DEADLINE_MS} from './owner_accepted_preview.mjs';

const NOW=Date.parse('2026-10-17T07:00:00.000Z'),LATER=Date.parse('2026-10-19T07:00:00.000Z'),COMMIT='c'.repeat(40);
const START='2026-10-17T06:00:00.000Z',END='2026-10-17T06:02:00.000Z',DONE='2026-10-17T06:03:00.000Z';
const ORDER_START='2026-10-17T06:00:02.000Z',ORDER_END='2026-10-17T06:00:15.000Z';
const encode=s=>new TextEncoder().encode(s),decode=b=>new TextDecoder().decode(b),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
globalThis.fetch=()=>assert.fail('Accepted preview tests must never access the network');
function snapshot(key,readAt){
  const scope=SNAPSHOT_SCOPES[key],h=(id,group_name,value,code)=>({id,group_name,value,quantity:10,instrument:{code,currency:{code:'USD'}}});
  const raw={mode:'read_only',source:'Sharesight User API',data:{report:{portfolio_id:scope.portfolioId,currency:{code:'USD'},start_date:'2026-10-16',end_date:'2026-10-16',include_sales:false,
    ...(key==='sharesight.ibGroupedPerformance'?{grouping:'custom_group_category',custom_group:{id:Number(scope.grouping),name:'资产类别'},holdings:[h(1,'美国底仓',450,'CSPX'),h(2,'美国底仓',50,'USSC'),h(3,'美国科技',250,'GOOG'),h(4,'非美发达',180,'EXUS'),h(5,'新兴市场',70,'EIMI')]}:{grouping:scope.grouping}),cash_accounts:[{value:200}]}}};
  return {sourceKey:key,status:'date-verified',raw,rawFingerprint:digest(raw),completion:null,
    provenance:{sourceDate:'2026-10-16',readAt,syncCompletedAt:null,snapshotGeneration:null,receiptSha256:null}};
}
function fixture({concentrationInput=null,completedAt=DONE}={}){
  const sources=[['ib.accountSummary',START,'2026-10-17T06:00:10.000Z'],['ib.positions','2026-10-17T06:00:01.000Z','2026-10-17T06:00:12.000Z'],['ib.orders',ORDER_START,ORDER_END],
    ['sharesight.ibGroupedPerformance','2026-10-17T06:01:00.000Z','2026-10-17T06:01:30.000Z'],['sharesight.noahPerformance','2026-10-17T06:01:01.000Z',END]]
    .map(([sourceKey,startedAt,completedAt])=>({sourceKey,startedAt,completedAt,sha256:hash(encode('SYNTHETIC '+sourceKey)),
      ...(sourceKey.startsWith('sharesight.')?{sourceDate:'2026-10-16',status:'date-verified',syncCompletion:'not-provided'}:{})}));
  const manifest={sources,sourceHead:'a'.repeat(40),associationPolicySha256:'b'.repeat(64),callLedgerSha256:'c'.repeat(64)};
  const rawOrders={orders:[{order_id:1,order_status:'NEW',order_type:'LIMIT',side:'BUY',limit_price:'10',total_shares_qty:'4',cum_shares_qty:'0',remaining_shares_qty:'4',primary_description:'Buy 4 EXUS',secondary_description:'Synthetic instrument',order_time:'2026-10-16T14:00:00Z'}]};
  const rawByKey={'ib.accountSummary':{currency:'USD',total_cash_value:123},'ib.positions':{positions:[]},'ib.orders':rawOrders};
  const live={status:'captured',sources:sources.slice(0,3).map(s=>({...s,raw:rawByKey[s.sourceKey],rawFingerprint:fingerprint(rawByKey[s.sourceKey])}))};
  const snapshots=[snapshot('sharesight.ibGroupedPerformance',sources[3].completedAt),snapshot('sharesight.noahPerformance',END)];
  const outcomes=[{sourceKey:'ib.flexEod',status:'not-called',rawFingerprint:null},...snapshots.map(s=>({sourceKey:s.sourceKey,status:s.status,rawFingerprint:s.rawFingerprint})),{sourceKey:'ib.optionalLive',status:'captured',rawFingerprint:digest(live)}];
  const call=resolveCurrentCall({schemaVersion:1,purpose:'xuan-etf-owner-declared-pending-calls',entries:[{date:'2026-09-01',usd:100}]},'2026-10-17');
  const model=buildEodActionModel({fieldMode:true,dataDate:'2026-10-17',sourceDate:'2026-10-16',asOfHkt:'2026-10-17 14:00–14:02 HKT · 数据至 2026-10-16',
    snapshots,live,reserve:call.amountUsd,callRecord:call,sourceOutcomes:outcomes,captureStartedAt:START,captureCompletedAt:END,concentrationInput});
  model.sourceManifestSha256=digest(sources);model.evidenceSha256=digest({sourceOutcomes:model.sourceOutcomes,sourceManifestSha256:model.sourceManifestSha256});
  const html=encode(renderNightActionReport(model)),modelBytes=encode(JSON.stringify(model,null,2)+'\n'),manifestBytes=encode(JSON.stringify(manifest,null,2)+'\n');
  const registration={schema:'xuan.owner-accepted-preview-registration.v1',registrationId:'synthetic-saturday-preview',scope:OWNER_SCOPE,ownerBinding:OWNER_BINDING,sourceIdentitySha256:SOURCE_IDENTITY_SHA256,
    dataDate:'2026-10-17',sourceDate:'2026-10-16',captureStartedAt:START,captureEndedAt:END,completedAt,ordersCaptureStartedAt:ORDER_START,ordersCaptureEndedAt:ORDER_END,
    sourceHead:manifest.sourceHead,artifactSha256:hash(html),modelSha256:hash(modelBytes),sourceManifestSha256:hash(manifestBytes),sourceManifestContentSha256:digest(sources),displaySha256:'0'.repeat(64),financialStatus:'partial',unknownFields:['cash','orders','prices']};
  const displayBytes=renderAcceptedPreviewDisplay(html,{registration});registration.displaySha256=hash(displayBytes);
  const f={model,html,modelBytes,manifest,manifestBytes,registration,displayBytes};refreshMetadata(f);return f;
}
function refreshMetadata(f){f.registrationSha256=hash(acceptedPreviewRegistrationText(f.registration));f.metadata=buildAcceptedPreviewMetadata({registration:f.registration,registrationSha256:f.registrationSha256,registrationPolicyCommit:COMMIT});}
const candidate=f=>({metadata:f.metadata,displayBytes:f.displayBytes});
function verifier(f,{now=()=>NOW,loadContext}={}){
  const reads=[];
  return {reads,verify:createProtectedOwnerPreviewVerifier({now,loadContext:loadContext??(async opts=>{reads.push(opts);assert.equal(typeof opts.now,'function');return {previewRegistration:{registration:structuredClone(f.registration),sha256:f.registrationSha256,policyCommit:COMMIT}};})})};
}
const args=(f,phase='candidate-admission')=>({...candidate(f),phase,now:NOW});

test('exact synthetic local artifacts produce only static visible facts; the full model and hidden observation state are absent',()=>{
  const f=fixture(),before=[f.html.slice(),f.modelBytes.slice(),f.manifestBytes.slice()];
  const display=prepareAcceptedPreviewDisplay(f.html,{modelBytes:f.modelBytes,manifestBytes:f.manifestBytes,registration:f.registration});
  assert.deepEqual(display,f.displayBytes);assert.deepEqual([f.html,f.modelBytes,f.manifestBytes],before);
  const text=decode(display);assert.ok(!text.includes(NIGHT_ACTION_MARKER));assert.ok(!/data-order-(key|first-price)|<script\b|<iframe\b|(?:href|src)=/i.test(text));
  for(const id of ['card-plan','card-orders','card-cash','card-allocation'])assert.equal(text.split(`id="${id}"`).length,2);
  assert.ok(text.includes('2026-10-17 周六验收稿'));assert.ok(text.includes('市场数据日：2026-10-16'));
  assert.ok(text.includes('真实采集：14:00:00.000–14:02:00.000 HKT'));assert.ok(text.includes('挂单读取：14:00:02.000–14:00:15.000 HKT'));
  assert.ok(text.includes('USD·推定'));assert.ok(text.includes('重新打开不会更新取值'));assert.equal(f.model.cash.planning,null);
});
test('accepted first screen uses the actual orders snapshot minute; exact provenance and generation time stay folded',()=>{
  const outputs=[];
  for(const completedAt of [DONE,'2026-10-17T06:30:00.000Z']){
    const f=fixture({completedAt}),staticStage=prepareOwnerStaticDisplay(f.html);
    assert.ok(staticStage.length>0);
    const canonical=decode(f.html);
    assert.match(canonical,/<details><summary>口径与来源<\/summary>[\s\S]*挂单读取：14:00:02.000–14:00:15.000 HKT/);
    const display=renderAcceptedPreviewDisplay(f.html,{registration:f.registration});
    assert.deepEqual(prepareAcceptedPreviewDisplay(f.html,{modelBytes:f.modelBytes,manifestBytes:f.manifestBytes,registration:f.registration}),display);
    const text=decode(display),notice=text.match(/<aside class="notes" id="accepted-preview-notice"[\s\S]*?<\/aside>/)?.[0];
    assert.ok(notice);const visible=notice.replace(/<details>[\s\S]*?<\/details>/g,'');
    assert.match(visible,/市场数据日：2026-10-16；挂单快照：14:00 HKT/);
    assert.match(visible,/周六参考 · 非实时/);
    assert.doesNotMatch(visible,/真实采集|挂单读取|原稿生成|\d\d:\d\d:\d\d/);
    assert.match(notice,/<details><summary>采集与生成时间<\/summary>[\s\S]*真实采集：14:00:00.000–14:02:00.000 HKT；挂单读取：14:00:02.000–14:00:15.000 HKT/);
    assert.ok(notice.includes(`原稿生成：${completedAt.includes('06:30')?'14:30:00.000':'14:03:00.000'} HKT`));
    assert.match(text,/<h1>XUAN · 行动版 · 私有预览 · 周六参考<\/h1>/);
    outputs.push(visible);
  }
  assert.equal(outputs[0],outputs[1]);
});
test('concentration-enabled five-card report passes the unchanged pure accepted static export without source links or private identifiers',()=>{
  const sourceKeys=['sharesight.ibGroupedPerformance','sharesight.schwabPerformance','sharesight.webullPerformance'];
  const sources=readAiRiskAccounts().map((account,index)=>{
    const id=Number(account.portfolioId);
    const rows=index===0?[['NVDA',80,9900001,9000001,'ordinary_shares'],['CSPX',400,9900002,1310832,'etf'],['VSTL',30,29282953,9000003,'etf']]:[];
    const holdings=rows.map(([code,value,holdingId,instrumentId,type])=>({id:holdingId,portfolio:{id},quantity:1,instrument_price:value,value,labels:[],instrument_currency:{code:'USD'},
      instrument:{id:instrumentId,code,name:'Synthetic instrument',market_code:'TEST',currency_code:'USD',friendly_instrument_description_code:type}}));
    const raw={ok:true,mode:'read_only',route:'gateway',portfolio:{id,name:account.custodian,currency_code:'USD'},data:{report:{portfolio_id:id,value:1000,start_date:'2026-10-16',end_date:'2026-10-16',include_sales:false,percentages_annualised:false,currency:{code:'USD'},holdings,
      cash_accounts:[{id:8800000+index,name:'Synthetic cash',value:1000-rows.reduce((sum,row)=>sum+row[1],0),currency:{code:'USD'}}]}}};
    const bytes=JSON.stringify(raw);return {bytes,receipt:{sourceKey:sourceKeys[index],route:'gateway',status:'date-verified',sourceDate:'2026-10-16',startedAt:START,completedAt:END,sha256:hash(bytes),bytes:Buffer.byteLength(bytes)}};
  });
  const f=fixture({concentrationInput:{sources,cutoff:'2026-10-16'}}),staticStage=prepareOwnerStaticDisplay(f.html);
  assert.equal(f.model.concentration.status,'recorded');assert.ok(staticStage.length>0);
  const direct=renderAcceptedPreviewDisplay(f.html,{registration:f.registration});
  const bound=prepareAcceptedPreviewDisplay(f.html,{modelBytes:f.modelBytes,manifestBytes:f.manifestBytes,registration:f.registration});
  assert.deepEqual(bound,direct);assert.deepEqual(bound,f.displayBytes);
  const text=decode(bound);assert.equal((text.match(/<h2>/g)||[]).length,5);
  for(const title of ['本轮补仓','挂单提醒','现金优先补仓参考','股票四类配置','单票集中度'])assert.ok(text.includes(title));
  for(const label of ['发行方目标','发行方资料','发行方前十'])assert.ok(text.includes(`<span class="concentration-source-label">${label}</span>`));
  assert.match(text,/原生挂单未返回币种或合约标识/);assert.match(text,/覆盖未核实|全部覆盖未核实/);assert.match(text,/USD·推定/);
  assert.equal(f.model.cash.planning,null);assert.equal(f.model.cash.orderReserve,null);
  assert.doesNotMatch(text,/<a\b|(?:href|src)\s*=|<script\b|<iframe\b|\son[a-z]+\s*=|portfolio_?id|account_?id|order_?id|contract_?id/i);
  assert.ok(!text.includes(NIGHT_ACTION_MARKER));assert.ok(!text.includes(Buffer.from(JSON.stringify(f.model)).toString('base64url')));
  for(const account of readAiRiskAccounts())assert.ok(!text.includes(account.portfolioId));
});
test('local input bytes and protected registration are exact; alternate files or financial registry fields do not confer admission',()=>{
  for(const kind of ['html','model','manifest','display-hash','scope','financial-field']){
    const f=fixture();if(kind==='html')f.html=encode(decode(f.html)+' ');if(kind==='model')f.modelBytes=encode(decode(f.modelBytes)+' ');if(kind==='manifest')f.manifestBytes=encode(decode(f.manifestBytes)+' ');
    if(kind==='display-hash')f.registration.displaySha256='d'.repeat(64);if(kind==='scope')f.registration.scope='foreign-scope';if(kind==='financial-field')f.registration.cash=123;
    assert.throws(()=>prepareAcceptedPreviewDisplay(f.html,{modelBytes:f.modelBytes,manifestBytes:f.manifestBytes,registration:f.registration}),/OWNER_PREVIEW_/);
  }
});
test('Saturday admission and historical authenticity both read actual trusted registration twice without pretending daily freshness',async()=>{
  const f=fixture(),v=verifier(f);const proof=await v.verify(args(f));assert.equal(proof.displaySha256,hash(f.displayBytes));
  assert.equal(proof.metadataSha256,await previewMetadataSha256(f.metadata));assert.equal(v.reads.length,2);
  assert.ok(v.reads.every(o=>o.phase==='accepted-preview-admission'&&o.policyCommit===COMMIT));
  const later=verifier(f,{now:()=>LATER});assert.equal((await later.verify({...args(f,'historical-authenticity'),now:LATER})).registrationPolicyCommit,COMMIT);
  assert.ok(later.reads.every(o=>o.phase==='accepted-preview-historical'));assert.equal(later.reads.length,2);
});
test('caller flags, wrong phase, unknown policy, raw registration-byte mismatch and future metadata fail closed',async()=>{
  for(const kind of ['flag','phase','policy','registration-sha','raw-hash','future']){
    const f=fixture();if(kind==='flag')f.metadata.approved=true;if(kind==='policy')f.metadata.registrationPolicyCommit='d'.repeat(40);if(kind==='registration-sha')f.metadata.registrationSha256='d'.repeat(64);
    const v=verifier(f,{...(kind==='future'?{now:()=>Date.parse('2026-10-17T06:01:00.000Z')}:{}),...(kind==='raw-hash'?{loadContext:async()=>({previewRegistration:{registration:f.registration,sha256:'d'.repeat(64),policyCommit:COMMIT}})}:{})});
    await assert.rejects(v.verify({...args(f),...(kind==='phase'?{phase:'daily-candidate'}:{})}),/OWNER_PREVIEW_/);
  }
  assert.throws(()=>createProtectedOwnerPreviewVerifier(),/CAPABILITIES_REQUIRED/);
});
test('stored display hashes are independently bound to trusted registration, never to supplied display metadata',async()=>{
  const f=fixture(),v=verifier(f);f.displayBytes=encode(decode(f.displayBytes)+' ');
  await assert.rejects(v.verify(args(f)),/DISPLAY_HASH/);
});
test('active content, raw identifiers or restored reversible model are rejected even if a context claims their changed display hash',async()=>{
  for(const extra of ['<script>synthetic()</script>','<a href="https://example.invalid">link</a>','<p>U1234567</p>','<p>account_id</p>',`<!-- ${NIGHT_ACTION_MARKER}:e30 -->`]){
    const f=fixture();f.displayBytes=encode(decode(f.displayBytes)+extra);f.registration.displaySha256=hash(f.displayBytes);refreshMetadata(f);
    await assert.rejects(verifier(f).verify(args(f)),/STATIC_DISPLAY/);
  }
});
test('late registration changes, invalid time shapes and provenance relabelling cannot pass',async()=>{
  const f=fixture();let calls=0;
  await assert.rejects(verifier(f,{loadContext:async()=>({previewRegistration:{registration:structuredClone(f.registration),sha256:++calls===1?f.registrationSha256:'d'.repeat(64),policyCommit:COMMIT}})}).verify(args(f)),/REGISTRATION/);
  assert.equal(calls,2);
  for(const key of ['captureStartedAt','ordersCaptureEndedAt','completedAt']){const other=fixture();other.registration[key]='2026-10-17T06:00:00+00:00';assert.throws(()=>acceptedPreviewRegistrationText(other.registration),/REGISTRATION_TIME/);}
  const other=fixture();other.registration.dataDate='2026-10-18';assert.throws(()=>acceptedPreviewRegistrationText(other.registration),/REGISTRATION_DATE/);
});
test('metadata and Buffer inputs are detached before trusted context awaits',async()=>{
  const f=fixture();let entered,release,calls=0;
  const started=new Promise(r=>{entered=r;}),pause=new Promise(r=>{release=r;});
  const v=verifier(f,{loadContext:async()=>{if(++calls===1){entered();await pause;}return {previewRegistration:{registration:structuredClone(f.registration),sha256:f.registrationSha256,policyCommit:COMMIT}};}});
  const input={...args(f),metadata:structuredClone(f.metadata),displayBytes:Buffer.from(f.displayBytes)},pending=v.verify(input);
  await started;input.metadata.scope='foreign';input.displayBytes.fill(0);release();assert.equal((await pending).displaySha256,hash(f.displayBytes));
});
function publisher(f,{existing=false,access,probe,write,readback,setTimer,clearTimer,now=()=>NOW,publisherOptions={}}={}){
  const events=[];let saved;
  const p=createAcceptedPreviewPublisher({...publisherOptions,now,verifyProtectedPreview:async options=>{events.push('verify');return verifier(f,{now}).verify(options);},
    verifyDestinationAccess:async options=>{events.push('access');assert.equal(options.target,LATEST_TARGET);if(access)return access(options);},
    ...(setTimer?{setTimer,clearTimer}:{}),io:{async probeLatestExists(options){events.push('head');if(probe)return probe(options);return {state:existing?'present':'absent'};},
      async createAcceptedPreview(options){events.push('create');saved=structuredClone(options);if(write)return write(options);return {...LATEST_TARGET,generation:'1',size:options.bytes.length};},
      async readLatestGeneration(options){events.push('readback');assert.equal(options.generation,'1');assert.equal(options.metadata.displaySha256,hash(f.displayBytes));if(readback)return readback(options);return new Uint8Array(saved.bytes);}}});
  return {p,events};
}
test('preview publication has no default access capability; construction performs no I/O',async()=>{
  const f=fixture();let reads=0;const p=createAcceptedPreviewPublisher({approved:true,io:{probeLatestExists(){reads++;}},verifyProtectedPreview:()=>assert.fail()});
  assert.deepEqual(await p.publish(candidate(f)),{status:'blocked',code:'PREVIEW_CAPABILITIES_REQUIRED'});assert.equal(reads,0);
});
test('existing target, denied readers, permission denial or an asserted JSON grant permit zero create calls',async()=>{
  for(const options of [{existing:true},{access:()=>{throw Error('SYNTHETIC_READERS_DENIED');}},{probe:()=>{throw Object.assign(Error('SYNTHETIC_DENIED'),{status:403});}},{access:()=>({approved:true})}]){
    const f=fixture(),t=publisher(f,options);assert.equal((await t.p.publish(candidate(f))).status,'blocked');assert.ok(!t.events.includes('create'));
    assert.equal((await t.p.publish(candidate(f))).code,'PREVIEW_ONE_SHOT_CLOSED');
  }
});
test('one accepted fixed artifact requires access checks and independent generation readback before success',async()=>{
  const f=fixture(),t=publisher(f);const result=await t.p.publish(candidate(f));assert.equal(result.status,'published-verified');
  assert.deepEqual(t.events,['access','head','verify','access','create','readback']);assert.equal(result.sha256,hash(f.displayBytes));
  assert.equal((await t.p.publish(candidate(f))).code,'PREVIEW_ONE_SHOT_CLOSED');
});
test('CAS conflict, concurrent existing target and uncertain writes never retry',async()=>{
  for(const [error,status] of [[Object.assign(Error('race'),{status:412}),'conflict'],[Object.assign(Error('exists'),{safeCode:'LATEST_ALREADY_EXISTS'}),'blocked'],[Error('disconnect'),'unknown']]){
    const f=fixture(),t=publisher(f,{write:()=>{throw error;}});assert.equal((await t.p.publish(candidate(f))).status,status);
    assert.equal(t.events.filter(x=>x==='create').length,1);assert.equal((await t.p.publish(candidate(f))).code,'PREVIEW_ONE_SHOT_CLOSED');assert.ok(!t.events.includes('readback'));
  }
});
test('wrong acknowledgement, altered readback or failed readback is unknown and never reported verified',async()=>{
  for(const options of [{write:()=>({...LATEST_TARGET,generation:'1',size:1})},{readback:()=>encode('wrong')},{readback:()=>{throw Error('denied');}}]){
    const f=fixture(),t=publisher(f,options);assert.equal((await t.p.publish(candidate(f))).status,'unknown');assert.equal(t.events.filter(x=>x==='create').length,1);
  }
});
test('accepted preview has a fixed 45 second budget while daily and access lease limits remain unchanged',async()=>{
  assert.equal(ACCEPTED_PREVIEW_DEADLINE_MS,45000);assert.equal(DEADLINE_MS,10000);
  assert.equal(FINANCIAL_ADMISSION_TTL_MS,5000);assert.equal(FULL_PREFLIGHT_TTL_MS,60000);
  const lease=createOwnerPreflightLease();lease.install({roles:new Map()},NOW);
  lease.mintAdmission(NOW);lease.consumeAdmission(NOW+5000);
  lease.mintAdmission(NOW);assert.throws(()=>lease.consumeAdmission(NOW+5001),/FINANCIAL_ADMISSION_REQUIRED/);
  assert.throws(()=>lease.consumeAdmission(NOW+5002),/FINANCIAL_ADMISSION_REQUIRED/);
  lease.current(NOW+60000);assert.throws(()=>lease.current(NOW+60001),/PREFLIGHT_EXPIRED/);
  const f=fixture();let scheduled,cleared;
  const t=publisher(f,{publisherOptions:{deadlineMs:1,acceptedPreviewDeadlineMs:1},setTimer:(fn,ms)=>{scheduled=ms;return 7;},clearTimer:id=>{cleared=id;}});
  assert.equal((await t.p.publish(candidate(f))).status,'published-verified');assert.equal(scheduled,45000);assert.equal(cleared,7);
});
test('verified preview may exceed the daily ten second budget while retaining the same signal and checks',async()=>{
  const f=fixture();let time=NOW;const signals=[];
  const track=(options,elapsed)=>{signals.push(options.signal);assert.equal(options.signal.aborted,false);time+=elapsed;};
  const t=publisher(f,{now:()=>time,
    access:options=>{track(options,6000);},probe:options=>{track(options,1000);return {state:'absent'};},
    write:options=>{track(options,2000);return {...LATEST_TARGET,generation:'1',size:options.bytes.length};},
    readback:options=>{track(options,3000);return new Uint8Array(f.displayBytes);}});
  assert.equal((await t.p.publish(candidate(f))).status,'published-verified');assert.equal(time-NOW,18000);
  assert.ok(time-NOW>DEADLINE_MS&&time-NOW<ACCEPTED_PREVIEW_DEADLINE_MS);
  assert.deepEqual(t.events,['access','head','verify','access','create','readback']);
  assert.equal(new Set(signals).size,1);assert.equal(signals[0].aborted,true);
});
test('45 second elapsed boundary blocks before create without reopening the transaction',async()=>{
  for(const elapsed of [45000,45001]){
    const f=fixture();let time=NOW;
    const t=publisher(f,{now:()=>time,probe:()=>{time=NOW+elapsed;return {state:'absent'};}});
    assert.equal((await t.p.publish(candidate(f))).status,'blocked');assert.ok(!t.events.includes('create'));
    assert.equal((await t.p.publish(candidate(f))).code,'PREVIEW_ONE_SHOT_CLOSED');
  }
});
test('deadline before create prevents delayed continuation; a deadline during create or readback remains unknown',async()=>{
  for(const phase of ['probe','write','readback']){
    const f=fixture();let fire,release,entered,signal,cleared;
    const pause=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});
    const delay=async options=>{signal=options.signal;entered();await pause;};
    const t=publisher(f,{setTimer:(fn,ms)=>{assert.equal(ms,45000);fire=fn;return 1;},clearTimer:id=>{cleared=id;},
      ...(phase==='write'?{write:async options=>{await delay(options);return {...LATEST_TARGET,generation:'1',size:options.bytes.length};}}:
        phase==='readback'?{readback:async options=>{await delay(options);return new Uint8Array(f.displayBytes);}}:
          {probe:async options=>{await delay(options);return {state:'absent'};}})});
    const pending=t.p.publish(candidate(f));await started;fire();assert.equal((await pending).status,phase==='probe'?'blocked':'unknown');
    assert.equal(signal.aborted,true);assert.equal(cleared,1);assert.equal((await t.p.publish(candidate(f))).code,'PREVIEW_ONE_SHOT_CLOSED');
    release();await new Promise(r=>setImmediate(r));assert.equal(t.events.filter(x=>x==='create').length,phase==='probe'?0:1);
    assert.equal(t.events.filter(x=>x==='readback').length,phase==='readback'?1:0);
  }
});
