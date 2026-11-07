// Real financial/economic validators, synthetic ciphertext and HTTP only.
// No real credential, account, source file or network request is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createPublishedBaseVerifier,publishedBaseFailureCode} from './fee-sync-published-base.mjs';
import {fetchEconomicSnapshot} from './fee-economic-source.mjs';
import {buildFeeCalculationReceipt} from './fee-receipt-core.mjs';
import {buildIbManagerReturnReceipt,buildIbManagerDrawdownReceipt,buildIbOwnerBaseline,buildIbManagerReportBundle} from './ib-manager-return.mjs';
import {ibBaselineBusinessHash} from './ib-manager-source.mjs';
import {dailyReportPlan,reportAddDays,monthlyReportPlan} from './fee-report-period.mjs';
import {sourceContractInputHash as hash} from './fee-source-contract.mjs';
import {seededIbFixture} from './fee-sync-test-fixtures.mjs';
import {prepareIbManagerReportInput} from './ib-manager-report.mjs';

const ID='a'.repeat(32),MAIN='a'.repeat(40),CACHE='b'.repeat(40),OWNER='huanwujoy-crypto';
const KEY=Buffer.alloc(32,7),POLICY={schema:'fee-console.sync-policy-profile.v1',sourceMode:'sharesight-reference',configuration:{contractVersion:1}};
process.env.FEE_ECON_GIST_ID=ID;
process.env.FEE_ECON_GITHUB_TOKEN='github_pat_'+'SYNTHETIC_NOT_A_REAL_TOKEN_'.repeat(3);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const blob=b=>crypto.createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
const encrypt=(value,version,key=KEY)=>{
  const iv=Buffer.alloc(12,version),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  const body=Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value))),cipher.final()]);
  return Buffer.from(JSON.stringify({enc:true,v:version,data:Buffer.concat([iv,body,cipher.getAuthTag()]).toString('base64')}));
};
const file=(name,bytes)=>({type:'file',path:name,encoding:'base64',size:bytes.length,sha:blob(bytes),content:bytes.toString('base64')});
const rejected=(p,code)=>assert.rejects(p,e=>{assert.equal(publishedBaseFailureCode(e),'FEE_SYNC_BASE_'+code);assert.equal(e.message,'FEE_SYNC_BASE_'+code);assert.equal(Object.hasOwn(e,'cause'),false);return true;});

async function fixture(t,{base='2026-09-01',target='2026-09-02',markets=['NASDAQ','NYSE'],checkpoint=false,mutatePayload,mutateEconomic,mutateHealth}={}){
  const start=checkpoint?'2026-09-01':base;
  const economic={v:4,settings:{start,mgmt:2,carry:20},accounts:[{id:'schwab',name:'SYNTHETIC A',opening:100},{id:'webull',name:'SYNTHETIC B',opening:100}],months:[],fees:[]};
  const business={points:[{d:base,tot:150}],openT:150,from:base,to:base,days:1,flowByDate:{},rate:0,cr:0,cumBefore:0,hwmBefore:0};
  const input={schema:'fee-console.ib-manager-return-input.v1',currency:'USD',timezone:'America/New_York',flowTiming:'eod',flowsComplete:true,correctionsConfirmed:true,sourceSha256:'e'.repeat(64),periodReturnsInput:business};
  let baselineSha256=ibBaselineBusinessHash(business);const payload={daily:[{d:base,schwab:100,webull:100}],flowsAuto:[],flowsUnresolved:[],status:{asOf:base,provisional:false,calibrated:false,unresolvedCount:0},
    ibManagerReturnReceipt:await buildIbManagerReturnReceipt(input),ibManagerDrawdownReceipt:await buildIbManagerDrawdownReceipt(input)};
  payload.ibManagerBaselineState=await buildIbOwnerBaseline(payload,input,baselineSha256);
  if(checkpoint){
    assert.equal(base,'2026-09-02');const seed=await seededIbFixture(),source=await seed.reader.readStable(seed.args);
    baselineSha256=seed.args.expectedBaselineHash;const bundle=await buildIbManagerReportBundle(source,baselineSha256);
    Object.assign(payload,{ibManagerBaselineState:seed.payload.ibManagerBaselineState,ibManagerReturnReceipt:bundle.returnReceipt,
      ibManagerDrawdownReceipt:bundle.drawdownReceipt,ibManagerSourceState:bundle.sourceState,ibManagerSourceStatus:{state:'verified',targetDate:base}});
    payload.daily.unshift({d:start,schwab:100,webull:100});
  }
  payload.feeCalculationReceipt=buildFeeCalculationReceipt({data:payload,economicInput:economic});
  mutatePayload?.(payload);mutateEconomic?.(economic);
  const dataBytes=encrypt(payload,3),economicBytes=encrypt(economic,4);
  const health={schema:'fee-console.daily-health.v1',checkedAt:reportAddDays(base,1)+'T01:00:00.000Z',targetDate:base,
    sourceDates:{schwab:base,webull:base,benchmark:base},outcome:'updated',dataSha256:sha(dataBytes),errorCode:null};
  mutateHealth?.(health);
  const healthBytes=Buffer.from(JSON.stringify(health,null,2)+'\n');
  const cache={v:1,benchmarks:Object.fromEntries([['spy','SPY','NYSEArca'],['qqq','QQQ','NasdaqGS']].map(([id,symbol,exchange])=>[id,{symbol,currency:'USD',exchange,
    series:[...new Set([base,target])].map(d=>({d,p:d===base?100:id==='spy'?101:102,div:0}))}]))};
  const cacheBytes=Buffer.from(JSON.stringify(cache,null,2)+'\n');
  const state={main:MAIN,cache:CACHE,revision:'e'.repeat(40),now:Date.parse(reportAddDays(target,1)+'T01:00:00.000Z'),githubCalls:[],economicCalls:0,mutateResponse:null};
  const tempRoot=fs.mkdtempSync(path.join(os.tmpdir(),'fee-base-synthetic-'));
  t.after(()=>fs.rmSync(tempRoot,{recursive:true,force:true}));
  const economicSnapshot=await fetchEconomicSnapshot({tempRoot,timeoutMs:100,attempts:1,fetchImpl:async(url,init)=>{
    assert.equal(url,'https://api.github.com/gists/'+ID);assert.equal(init.method,'GET');state.economicCalls++;
    return new Response(JSON.stringify({id:ID,public:false,owner:{login:OWNER},truncated:false,history:[{version:state.revision}],files:{'fee-console-db.json':{filename:'fee-console-db.json',content:economicBytes.toString(),size:economicBytes.length,truncated:false}}}),{headers:{etag:'"synthetic-etag"','content-type':'application/json'}});
  }});
  t.after(()=>economicSnapshot.cleanup());
  const files={'data.json':dataBytes,'fee-data-health.json':healthBytes,'benchmark-close.json':cacheBytes};
  const config={economicSnapshot,dataKey:Buffer.from(KEY),baselineSha256,policyProfile:POLICY,clock:()=>state.now,readGithubJson:async request=>{
    assert.deepEqual(Object.keys(request).sort(),['method','path']);assert.equal(request.method,'GET');assert.equal(Object.isFrozen(request),true);
    assert.ok(request.path.startsWith('/repos/'+OWNER+'/fee-console/'));const route=request.path.slice(('/repos/'+OWNER+'/fee-console/').length);state.githubCalls.push(route);let response;
    if(route==='git/ref/heads/main')response={object:{sha:state.main}};
    else if(route==='git/ref/heads/market-data-cache')response={object:{sha:state.cache}};
    else if(route.startsWith('git/matching-refs/'))response=[];
    else if(route.startsWith('commits/'))response={sha:route.slice(8),author:{login:OWNER,id:283054367,type:'User'},committer:{login:OWNER,id:283054367,type:'User'},commit:{verification:{verified:true,reason:'valid'}}};
    else if(route.startsWith('contents/')){const [name,ref]=route.slice(9).split('?ref=');assert.equal(ref,name==='benchmark-close.json'?CACHE:MAIN);response=file(name,files[name]);}
    else assert.fail('unexpected synthetic GitHub route');
    return state.mutateResponse?.(route,response)??response;
  }};
  const context={targetDate:target,plan:dailyReportPlan(target,markets,{reviewedSyncDate:target})};
  return {config,context,state,payload,economic,files,healthBytes,cacheBytes,adapter:()=>createPublishedBaseVerifier(config)};
}

test('actual authenticated ciphertext and original financial validators derive every binding',async t=>{
  const f=await fixture(t),a=f.adapter(),v=await a.readVerifiedBase(f.context);
  assert.equal(Object.isFrozen(v),true);assert.equal(Object.isFrozen(v.payload.daily),true);
  assert.deepEqual(v.payload,f.payload);assert.deepEqual(v.benchmark,{sourceDate:'2026-09-02',state:'session',spy:101,spyd:0,qqq:102,qqqd:0});
  assert.deepEqual(v.bindings,{mainSha:MAIN,baseDataSha256:sha(f.files['data.json']),baseHealthSha256:sha(f.healthBytes),
    ibBaselineSha256:f.config.baselineSha256,ibCheckpointSha256:hash(null),ibCoverageSha256:hash(null),
    ibAnchorSha256:hash({ownerBaseline:f.payload.ibManagerBaselineState,closingSnapshots:null}),economicVersionSha256:f.config.economicSnapshot.getVersionBinding().sha256,
    benchmarkSha256:sha(f.cacheBytes),policySha256:hash(POLICY)});
  assert.notEqual(v.bindings.baseHealthSha256,sha(JSON.stringify(JSON.parse(f.healthBytes))),'bind original health bytes, not reserialization');
  assert.equal(await a.verifyPublishedBase({...f.context,...v}),true);
  assert.equal(f.state.githubCalls.filter(p=>p.startsWith('contents/')).length,3,'recheck uses fixed refs and original economic capability, not reread plaintext');
  assert.equal(f.state.economicCalls,8);assert.deepEqual(f.config.dataKey,KEY,'owned key copy only');
  a.close();await rejected(a.readVerifiedBase(f.context),'CLOSED');assert.deepEqual(f.config.dataKey,KEY);
});

test('ordinary Monday target accepts authentic Friday base without relabelling its historical dates',async t=>{
  const f=await fixture(t,{base:'2026-09-11',target:'2026-09-14'}),v=await f.adapter().readVerifiedBase(f.context);
  assert.equal(v.payload.feeCalculationReceipt.asOf,'2026-09-11');assert.equal(v.payload.ibManagerReturnReceipt.asOf,'2026-09-11');assert.equal(v.benchmark.sourceDate,'2026-09-14');
});

test('multi-market Friday-to-Monday gap requires every configured venue closed and keeps the historical cutoff',async t=>{
  const f=await fixture(t,{base:'2026-09-11',target:'2026-09-14',markets:['NYSE','LSE','SIX','EURONEXT_PARIS']}),v=await f.adapter().readVerifiedBase(f.context);
  assert.equal(v.payload.feeCalculationReceipt.asOf,'2026-09-11');assert.equal(v.payload.daily.length,1,'no valuations manufactured for intervening closed days');
  assert.equal(Object.hasOwn(v,'synchronized'),false);assert.equal(Object.hasOwn(v,'published'),false);
});

for(const [name,options,code] of [
  ['missing intervening trading day',{base:'2026-09-01',target:'2026-09-03'},'RECOVERY_REQUIRED'],
  ['US holiday does not hide an open LSE session',{base:'2026-11-25',target:'2026-11-27',markets:['NYSE','LSE']},'RECOVERY_REQUIRED'],
  ['proven US holiday still needs the original period recovery path',{base:'2026-11-25',target:'2026-11-27',markets:['NASDAQ','NYSE']},'RECOVERY_REQUIRED'],
  ['closed weekend spanning a natural month end still needs an archive plan',{base:'2026-10-30',target:'2026-11-02',markets:['NYSE','LSE']},'RECOVERY_REQUIRED'],
  ['weekend outside official calendar coverage is not guessed closed',{base:'2026-08-28',target:'2026-09-01',markets:['NYSE','LSE']},'CALENDAR_SCOPE'],
])test(name+' is refused in the single-target handoff',async t=>{
  const f=await fixture(t,options),a=f.adapter();await rejected(a.readVerifiedBase(f.context),code);
  assert.equal(f.state.economicCalls,4,'historical bytes only; no final success/freshness stage');
  await rejected(a.readVerifiedBase(f.context),'CLOSED');
});

test('an open known market cannot hide an unknown configured market in the plan',async t=>{
  const f=await fixture(t);f.context.plan.markets=['NYSE','UNRESOLVED'];
  await rejected(f.adapter().readVerifiedBase(f.context),'PLAN');assert.equal(f.state.githubCalls.length,0);
  assert.equal(f.state.economicCalls,2,'factory fixture acquisition only; adapter took no source action');
});

test('actual synthetic reader produces a daily checkpoint that validates and binds all original source state',async t=>{
  const f=await fixture(t,{base:'2026-09-02',target:'2026-09-03',checkpoint:true}),v=await f.adapter().readVerifiedBase(f.context);
  assert.equal(v.payload.ibManagerReturnReceipt.schema,'fee-console.ib-manager-return-receipt.v2');
  assert.equal(v.bindings.ibCheckpointSha256,hash(f.payload.ibManagerSourceState));
  assert.equal(v.bindings.ibAnchorSha256,hash({ownerBaseline:f.payload.ibManagerBaselineState,closingSnapshots:f.payload.ibManagerSourceState.source.closingSnapshots??null}));
});

test('daily checkpoint source status remains mandatory',async t=>{
  const f=await fixture(t,{base:'2026-09-02',target:'2026-09-03',checkpoint:true,mutatePayload:p=>delete p.ibManagerSourceStatus});
  await rejected(f.adapter().readVerifiedBase(f.context),'IB_RECEIPT');
});

test('the original unsigned Actions-bot cache path stays supported while main keeps promotion identity checks',async t=>{
  const f=await fixture(t);f.state.mutateResponse=(route,r)=>route==='commits/'+CACHE?{...r,author:{login:'github-actions[bot]'},committer:{login:'github-actions[bot]'},commit:{verification:{verified:false}}}:r;
  const v=await f.adapter().readVerifiedBase(f.context);assert.equal(v.bindings.benchmarkSha256,sha(f.cacheBytes));
  assert.equal(f.state.githubCalls.includes('commits/'+CACHE),false);assert.equal(f.state.githubCalls.includes('commits/'+MAIN),true);
});

test('historical base authenticity does not grant new-target coverage or imply synchronization completion',async t=>{
  const f=await fixture(t,{base:'2026-11-05',target:'2026-11-06'}),v=await f.adapter().readVerifiedBase(f.context);
  let reads=0;const result=await prepareIbManagerReportInput({payload:v.payload,targetDate:f.context.targetDate,
    environ:{IB_MANAGER_READ_ENABLED:'true',IB_MANAGER_BASELINE_SHA256:f.config.baselineSha256},reader:{async readStable(){reads++;throw Error('must not read');}}});
  assert.equal(result.state,'pending');assert.equal(result.reasonCode,'IB_SOURCE_COVERAGE_UNVERIFIED');assert.equal(reads,0);
});

for(const [name,options,code] of [
  ['future health time',{mutateHealth:h=>h.checkedAt='2026-09-04T01:00:00.000Z'},'HEALTH'],
  ['failed prior publication',{mutateHealth:h=>{h.outcome='failed';h.errorCode='RUN_FAILED';}},'HEALTH'],
  ['wrong raw data hash',{mutateHealth:h=>h.dataSha256='0'.repeat(64)},'HEALTH'],
  ['health source date mismatch',{mutateHealth:h=>h.sourceDates.webull='2026-08-31'},'HEALTH'],
  ['invalid fee receipt',{mutatePayload:p=>p.feeCalculationReceipt.receiptId='0'.repeat(64)},'FEE_RECEIPT'],
  ['unresolved real-data branch',{mutatePayload:p=>p.flowsUnresolved.push({synthetic:true})},'FEE_RECEIPT'],
  ['economic amounts changed',{mutateEconomic:e=>e.accounts[0].opening=101},'FEE_RECEIPT'],
  ['missing IB history',{mutatePayload:p=>{delete p.ibManagerBaselineState;delete p.ibManagerReturnReceipt;delete p.ibManagerDrawdownReceipt;}},'IB_BASELINE'],
  ['invalid IB return',{mutatePayload:p=>p.ibManagerReturnReceipt.grossTwrPpm=123},'IB_RECEIPT'],
  ['invalid IB drawdown',{mutatePayload:p=>p.ibManagerDrawdownReceipt.dailyFactors[0].factor=2},'IB_RECEIPT'],
  ['same-target already published',{base:'2026-09-02',target:'2026-09-02'},'HEALTH'],
  ['more than original ten-day recovery window',{base:'2026-09-01',target:'2026-09-14'},'RECOVERY_REQUIRED'],
])test(name+' fails closed without account requests',async t=>{
  const f=await fixture(t,options),a=f.adapter();await rejected(a.readVerifiedBase(f.context),code);await rejected(a.readVerifiedBase(f.context),'CLOSED');
});

test('cannot authenticate user JSON, a proxy or a true-returning economic lookalike',async t=>{
  const f=await fixture(t);let calls=0;
  const fake={get checkCurrent(){calls++;return()=>true;},getVersionBinding(){calls++;return{schema:'fee-console.economic-source-version.v1',sha256:'a'.repeat(64)};}};
  for(const economicSnapshot of [{},fake,new Proxy(f.config.economicSnapshot,{get(){calls++;}})])assert.throws(()=>createPublishedBaseVerifier({...f.config,economicSnapshot}),{message:'FEE_SYNC_BASE_CONFIG'});
  assert.equal(calls,0);assert.equal(f.state.githubCalls.length,0);
});

test('explicit dependencies only: configuration and request accessors/proxies never execute',async t=>{
  const f=await fixture(t);let calls=0;
  assert.throws(()=>createPublishedBaseVerifier(),{message:'FEE_SYNC_BASE_CONFIG'});
  for(const key of Object.keys(f.config)){const c={...f.config};delete c[key];assert.throws(()=>createPublishedBaseVerifier(c),{message:'FEE_SYNC_BASE_CONFIG'});}
  const c={...f.config};Object.defineProperty(c,'dataKey',{enumerable:true,get(){calls++;return KEY;}});
  assert.throws(()=>createPublishedBaseVerifier(c),{message:'FEE_SYNC_BASE_CONFIG'});
  const hostile={};Object.defineProperty(hostile,'targetDate',{enumerable:true,get(){calls++;return f.context.targetDate;}});
  await rejected(f.adapter().readVerifiedBase(hostile),'INPUT');
  await rejected(f.adapter().readVerifiedBase(new Proxy(f.context,{ownKeys(){calls++;return[];}})),'INPUT');
  assert.equal(calls,0);assert.equal(f.state.githubCalls.length,0);
});

for(const field of ['payload','benchmark','bindings'])test('caller '+field+' cannot replace the authenticated artifact',async t=>{
  const f=await fixture(t),a=f.adapter(),v=await a.readVerifiedBase(f.context),claim=structuredClone({...f.context,...v});
  if(field==='payload')claim.payload.daily[0].schwab=999;
  else if(field==='benchmark')claim.benchmark.spy=999;
  else claim.bindings.baseDataSha256='f'.repeat(64);
  await rejected(a.verifyPublishedBase(claim),'BINDINGS');
});

for(const kind of ['main','cache','economic'])test(kind+' changed after acquisition invalidates the base',async t=>{
  const f=await fixture(t),a=f.adapter(),v=await a.readVerifiedBase(f.context);
  if(kind==='economic')f.state.revision='f'.repeat(40);else f.state[kind]='f'.repeat(40);
  await rejected(a.verifyPublishedBase({...f.context,...v}),kind==='economic'?'ECONOMIC_CHANGED':'CHANGED');
});

for(const name of ['data.json','fee-data-health.json','benchmark-close.json'])test(name+' verifies actual Git blob bytes and exact path',async t=>{
  const f=await fixture(t);f.state.mutateResponse=(route,r)=>route.startsWith('contents/'+name+'?')?{...r,sha:'f'.repeat(40)}:r;
  await rejected(f.adapter().readVerifiedBase(f.context),'TRANSPORT');
});

test('bad GCM ciphertext is refused even when health and Git blob hashes agree',async t=>{
  const f=await fixture(t),outer=JSON.parse(f.files['data.json']),raw=Buffer.from(outer.data,'base64');raw[12]^=1;outer.data=raw.toString('base64');f.files['data.json']=Buffer.from(JSON.stringify(outer));
  const health=JSON.parse(f.files['fee-data-health.json']);health.dataSha256=sha(f.files['data.json']);f.files['fee-data-health.json']=Buffer.from(JSON.stringify(health));
  await rejected(f.adapter().readVerifiedBase(f.context),'DECRYPT');
});

test('duplicate JSON keys and false commit verification fail, never accept echoed claims',async t=>{
  await t.test('duplicate health key',async t=>{const f=await fixture(t);f.files['fee-data-health.json']=Buffer.from(f.healthBytes.toString().replace('{','{"outcome":"updated",'));await rejected(f.adapter().readVerifiedBase(f.context),'ARTIFACT');});
  await t.test('unsigned commit',async t=>{const f=await fixture(t);f.state.mutateResponse=(route,r)=>route.startsWith('commits/')?{...r,commit:{verification:{verified:false}}}:r;await rejected(f.adapter().readVerifiedBase(f.context),'COMMIT');});
  await t.test('same login different immutable owner',async t=>{const f=await fixture(t);f.state.mutateResponse=(route,r)=>route.startsWith('commits/')?{...r,author:{login:OWNER,id:1}}:r;await rejected(f.adapter().readVerifiedBase(f.context),'COMMIT');});
  await t.test('same owner id wrong account type',async t=>{const f=await fixture(t);f.state.mutateResponse=(route,r)=>route.startsWith('commits/')?{...r,author:{...r.author,type:'Bot'}}:r;await rejected(f.adapter().readVerifiedBase(f.context),'COMMIT');});
  await t.test('invalid verification reason',async t=>{const f=await fixture(t);f.state.mutateResponse=(route,r)=>route.startsWith('commits/')?{...r,commit:{verification:{verified:true,reason:'unknown_key'}}}:r;await rejected(f.adapter().readVerifiedBase(f.context),'COMMIT');});
  await t.test('same committer login wrong id',async t=>{const f=await fixture(t);f.state.mutateResponse=(route,r)=>route.startsWith('commits/')?{...r,committer:{login:'web-flow',id:1}}:r;await rejected(f.adapter().readVerifiedBase(f.context),'COMMIT');});
  await t.test('true transport',async t=>{const f=await fixture(t);f.config.readGithubJson=async()=>true;await rejected(f.adapter().readVerifiedBase(f.context),'REFUSED');});
});

test('not-due, monthly, multi-day, future time and expired contexts cannot gain a capability',async t=>{
  await t.test('not yet closed',async t=>{const f=await fixture(t);f.state.now=Date.parse('2026-09-02T00:00:00Z');await rejected(f.adapter().readVerifiedBase(f.context),'NOT_READY');});
  await t.test('monthly',async t=>{const f=await fixture(t);await rejected(f.adapter().readVerifiedBase({targetDate:'2026-09-30',plan:monthlyReportPlan('2026-09')}),'PLAN');});
  await t.test('multi-day plan',async t=>{const f=await fixture(t);await rejected(f.adapter().readVerifiedBase({...f.context,plan:dailyReportPlan(f.context.targetDate,['NASDAQ','NYSE'],{periodFrom:'2026-09-01'})}),'PLAN');});
  await t.test('time went backwards',async t=>{const f=await fixture(t),a=f.adapter();await a.readVerifiedBase(f.context);f.state.now--;await rejected(a.readVerifiedBase(f.context),'CLOCK');});
  await t.test('expiry',async t=>{const f=await fixture(t),a=f.adapter();await a.readVerifiedBase(f.context);f.state.now+=300000;await rejected(a.readVerifiedBase(f.context),'EXPIRED');});
});

test('closed capability and nonmatching baseline never weaken the original financial guards',async t=>{
  await t.test('closed snapshot',async t=>{const f=await fixture(t);f.config.economicSnapshot.cleanup();await rejected(f.adapter().readVerifiedBase(f.context),'REFUSED');});
  await t.test('baseline',async t=>{const f=await fixture(t);f.config.baselineSha256='f'.repeat(64);await rejected(f.adapter().readVerifiedBase(f.context),'IB_RECEIPT');});
  await t.test('unapproved close during I/O',async t=>{const f=await fixture(t);let release,entered;const gate=new Promise(r=>release=r),seen=new Promise(r=>entered=r),original=f.config.readGithubJson;f.config.readGithubJson=async r=>{entered();await gate;return original(r);};const a=f.adapter(),pending=a.readVerifiedBase(f.context);await seen;a.close();release();await rejected(pending,'TRANSPORT');});
});
