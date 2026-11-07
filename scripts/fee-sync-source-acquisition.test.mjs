import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createVerifiedSourceAcquisition,sourceAcquisitionFailureCode} from './fee-sync-source-acquisition.mjs';
import {createPublishedBaseVerifier,isPublishedBaseVerifier} from './fee-sync-published-base.mjs';
import {fetchEconomicSnapshot} from './fee-economic-source.mjs';
import {buildFeeCalculationReceipt} from './fee-receipt-core.mjs';
import {buildIbManagerReturnReceipt,buildIbManagerDrawdownReceipt,buildIbOwnerBaseline} from './ib-manager-return.mjs';
import {ibBaselineBusinessHash} from './ib-manager-source.mjs';
import {dailyReportPlan,reportAddDays} from './fee-report-period.mjs';
import {SharesightCloudReader} from './fee-cloud-source.mjs';
import {sourceContractInputHash as hash} from './fee-source-contract.mjs';
import {cloudFixture,seededIbFixture,D} from './fee-sync-test-fixtures.mjs';

// Real base, original financial validators and original source readers. Every
// byte, key, identity and HTTP response below is synthetic; no real IO occurs.
const OWNER='huanwujoy-crypto',MAIN='a'.repeat(40),CACHE='b'.repeat(40),ID='c'.repeat(32),KEY=Buffer.alloc(32,7);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const blob=b=>crypto.createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
const seal=(value,v)=>{const iv=Buffer.alloc(12,v),c=crypto.createCipheriv('aes-256-gcm',KEY,iv),b=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return Buffer.from(JSON.stringify({enc:true,v,data:Buffer.concat([iv,b,c.getAuthTag()]).toString('base64')}));};
const rejects=(p,code)=>assert.rejects(p,e=>{assert.equal(sourceAcquisitionFailureCode(e),'FEE_SYNC_ACQUIRE_'+code);assert(Object.isFrozen(e));assert(!Object.hasOwn(e,'cause'));return true;});
process.env.FEE_ECON_GIST_ID=ID;
process.env.FEE_ECON_GITHUB_TOKEN='github_pat_'+'SYNTHETIC_NOT_REAL_'.repeat(5);
async function fixture(t,{base='2026-09-01',target=D}={}){
  const fee=cloudFixture({quantity:'1'}),ib=await seededIbFixture();
  const business={points:[{d:base,tot:150}],openT:150,from:base,to:base,days:1,flowByDate:{},rate:0,cr:0,cumBefore:0,hwmBefore:0};
  const frozen={schema:'fee-console.ib-manager-return-input.v1',currency:'USD',timezone:'America/New_York',flowTiming:'eod',flowsComplete:true,correctionsConfirmed:true,sourceSha256:'e'.repeat(64),periodReturnsInput:business};
  const baseline=ibBaselineBusinessHash(business),economic={v:4,settings:{start:base,mgmt:2,carry:20},accounts:[{id:'schwab',name:'SYNTH A',opening:100},{id:'webull',name:'SYNTH B',opening:100}],months:[],fees:[]};
  const payload={daily:[{d:base,schwab:100,webull:100}],flowsAuto:[],flowsUnresolved:[],status:{asOf:base,provisional:false,calibrated:false,unresolvedCount:0},ibManagerReturnReceipt:await buildIbManagerReturnReceipt(frozen),ibManagerDrawdownReceipt:await buildIbManagerDrawdownReceipt(frozen)};
  payload.ibManagerBaselineState=await buildIbOwnerBaseline(payload,frozen,baseline);
  payload.feeCalculationReceipt=buildFeeCalculationReceipt({data:payload,economicInput:economic});
  const data=seal(payload,3),econ=seal(economic,4),health=Buffer.from(JSON.stringify({schema:'fee-console.daily-health.v1',checkedAt:reportAddDays(base,1)+'T01:00:00.000Z',targetDate:base,sourceDates:{schwab:base,webull:base,benchmark:base},outcome:'updated',dataSha256:sha(data),errorCode:null}));
  const cache=Buffer.from(JSON.stringify({v:1,benchmarks:Object.fromEntries([['spy','SPY','NYSEArca'],['qqq','QQQ','NasdaqGS']].map(([id,symbol,exchange])=>[id,{symbol,currency:'USD',exchange,series:[base,target].map(d=>({d,p:100,div:0}))}]))}));
  const files={'data.json':data,'fee-data-health.json':health,'benchmark-close.json':cache},state={main:MAIN,now:Date.parse(reportAddDays(target,1)+'T01:00:00.000Z'),githubCalls:0};
  const tempRoot=fs.mkdtempSync(path.join(os.tmpdir(),'sync-acquire-synthetic-'));t.after(()=>fs.rmSync(tempRoot,{recursive:true,force:true}));
  const snapshot=await fetchEconomicSnapshot({tempRoot,timeoutMs:100,attempts:1,fetchImpl:async()=>new Response(JSON.stringify({id:ID,public:false,owner:{login:OWNER},truncated:false,history:[{version:'e'.repeat(40)}],files:{'fee-console-db.json':{filename:'fee-console-db.json',content:econ.toString(),size:econ.length,truncated:false}}}),{headers:{etag:'"synthetic"'}})});
  t.after(()=>snapshot.cleanup());
  const policy=Reflect.apply(SharesightCloudReader.prototype.getPolicyBinding,fee.reader,[]);
  const config={economicSnapshot:snapshot,dataKey:KEY,baselineSha256:baseline,policyProfile:policy,clock:()=>state.now,readGithubJson:async({method,path:p})=>{
    assert.equal(method,'GET');state.githubCalls++;const route=p.slice(('/repos/'+OWNER+'/fee-console/').length);
    if(route==='git/ref/heads/main')return{object:{sha:state.main}};
    if(route==='git/ref/heads/market-data-cache')return{object:{sha:CACHE}};
    if(route.startsWith('git/matching-refs/'))return[];
    if(route.startsWith('commits/'))return{sha:route.slice(8),author:{login:OWNER,id:283054367,type:'User'},committer:{login:OWNER,id:283054367,type:'User'},commit:{verification:{verified:true,reason:'valid'}}};
    if(route.startsWith('contents/')){const name=route.slice(9).split('?')[0],bytes=files[name];return{type:'file',path:name,encoding:'base64',size:bytes.length,sha:blob(bytes),content:bytes.toString('base64')};}
    assert.fail('unexpected synthetic route');
  }};
  const publishedBase=createPublishedBaseVerifier(config),options={feeReader:fee.reader,ibReader:ib.reader,publishedBase,clock:()=>state.now};
  t.after(()=>publishedBase.close());
  return{fee,ib,config,options,state,request:{targetDate:target,plan:dailyReportPlan(target,['NYSE','NASDAQ'],{reviewedSyncDate:target})},api:()=>createVerifiedSourceAcquisition(options)};
}

test('actual base and original preflight acquire three account sources without granting synchronization or publication',async t=>{
  const f=await fixture(t),api=f.api(),handle=await api.capture(f.request),initial=f.fee.calls.length+f.ib.calls.length;
  assert.equal(JSON.stringify(handle),'{}');const value=await handle.readCapturedInputs();
  assert.equal(value.projected.length,3);assert(Object.isFrozen(value.projected));
  assert.deepEqual(value.scopes.map(s=>s.role),['ib-manager','schwab','webull']);
  assert.equal(value.bindings.policySha256,hash(f.config.policyProfile));
  assert.equal(value.ibCaptures[0].input.sourceAsOf,D);
  assert(f.fee.calls.length+f.ib.calls.length>initial,'freshness uses actual fixed GET set');
  assert(!Object.hasOwn(value,'synchronized'));assert(!Object.hasOwn(value,'executionAuthorized'));
  assert(!Object.hasOwn(value,'publishedHistory'));
  // Acquisition never consumes the real source capability or grants a retry.
  assert.strictEqual(f.fee.reader.consumeCapturedRead(value.feeCapture,D,value.benchmark),value.feeCapture.input);
  await rejects(api.capture(f.request),'ALREADY_STARTED');
  api.close();await rejects(handle.readCapturedInputs(),'CLOSED');
});
test('original coverage preflight rejects before either real source reader starts',async t=>{
  const f=await fixture(t,{base:'2026-11-05',target:'2026-11-06'});
  await rejects(f.api().capture(f.request),'IB_PREFLIGHT');assert.equal(f.fee.calls.length+f.ib.calls.length,0);
});
test('actual policy mismatch rejects before any account read',async t=>{
  const f=await fixture(t);f.fee.reader.incomeDateEvidence={synthetic:'changed'};
  await rejects(f.api().capture(f.request),'POLICY');assert.equal(f.fee.calls.length+f.ib.calls.length,0);
});
test('unsigned base refuses without source reads and permanently closes acquisition',async t=>{
  const f=await fixture(t),old=f.config.readGithubJson;
  f.config.readGithubJson=async q=>q.path.includes('/commits/')?{sha:MAIN}:old(q);
  const invalid=createPublishedBaseVerifier(f.config),api=createVerifiedSourceAcquisition({...f.options,publishedBase:invalid});t.after(()=>invalid.close());
  await rejects(api.capture(f.request),'VALIDATION');await rejects(api.capture(f.request),'CLOSED');
  assert.equal(f.fee.calls.length+f.ib.calls.length,0);
});
test('source change after capture rejects instead of relabelling or recapturing',async t=>{
  const f=await fixture(t);let changed=false;const fetch=f.ib.reader.fetch;
  f.ib.reader.fetch=async(...args)=>{const response=await fetch(...args);if(changed&&new URL(args[0]).pathname.endsWith('/performance')){const text=await response.text();return new Response(text.replace('"value":150','"value":151'),{headers:{'content-type':'application/json'}});}return response;};
  const api=f.api(),handle=await api.capture(f.request);changed=true;
  await rejects(handle.readCapturedInputs(),'CHANGED');await rejects(handle.readCapturedInputs(),'CLOSED');
});
test('main, policy and expiration changes cannot reuse acquisition',async t=>{
  for(const kind of ['main','policy','expiry'])await t.test(kind,async t=>{
    const f=await fixture(t),handle=await f.api().capture(f.request),before=f.fee.calls.length+f.ib.calls.length;
    if(kind==='main')f.state.main='f'.repeat(40);
    if(kind==='policy')f.fee.reader.incomeDateEvidence={synthetic:'changed'};
    if(kind==='expiry')f.state.now+=300000;
    await rejects(handle.readCapturedInputs(),kind==='expiry'?'EXPIRED':'CHANGED');
    assert.equal(f.fee.calls.length+f.ib.calls.length,before);
  });
});
test('fake base, reader, dependency getters and request traps cannot execute',async t=>{
  const f=await fixture(t);let touched=0;
  assert(isPublishedBaseVerifier(f.options.publishedBase));assert(!isPublishedBaseVerifier({}));
  for(const publishedBase of [{readVerifiedBase(){touched++;}},new Proxy(f.options.publishedBase,{get(){touched++;}})])assert.throws(()=>createVerifiedSourceAcquisition({...f.options,publishedBase}),/FEE_SYNC_ACQUIRE_CONFIG/);
  for(const key of ['feeReader','ibReader'])assert.throws(()=>createVerifiedSourceAcquisition({...f.options,[key]:{}}),/FEE_SYNC_ACQUIRE_CONFIG/);
  const options={...f.options};Object.defineProperty(options,'clock',{enumerable:true,get(){touched++;}});
  assert.throws(()=>createVerifiedSourceAcquisition(options),/FEE_SYNC_ACQUIRE_CONFIG/);
  await rejects(f.api().capture({get targetDate(){touched++;},plan:f.request.plan}),'INPUT');
  assert.equal(touched,0);assert.equal(f.fee.calls.length+f.ib.calls.length,0);
});
test('instance method overrides cannot replace original source acquisition',async t=>{
  const f=await fixture(t);f.fee.reader.readStableWithEvidence=()=>assert.fail('override');f.ib.reader.readStableWithEvidence=()=>assert.fail('override');
  const h=await f.api().capture(f.request);assert.equal((await h.readCapturedInputs()).projected.length,3);
});
test('expiry or close during fee freshness never starts the next IB freshness read',async t=>{
  for(const kind of ['expiry','close'])await t.test(kind,async t=>{
    const f=await fixture(t),fetch=f.fee.reader.http.fetchImpl;let change=false,api;
    f.fee.reader.http.fetchImpl=async(...args)=>{
      const result=await fetch(...args);
      if(change&&args[1].method==='GET'){
        change=false;if(kind==='expiry')f.state.now+=300000;else api.close();
      }
      return result;
    };
    api=f.api();const handle=await api.capture(f.request),before=f.ib.calls.length;change=true;
    await rejects(handle.readCapturedInputs(),kind==='expiry'?'EXPIRED':'CLOSED');
    assert.equal(f.ib.calls.length,before);
    await rejects(handle.readCapturedInputs(),'CLOSED');
  });
});
test('concurrent handle reads do not start parallel source freshness passes',async t=>{
  const f=await fixture(t),handle=await f.api().capture(f.request);
  const first=handle.readCapturedInputs();await rejects(handle.readCapturedInputs(),'BUSY');
  assert.equal((await first).projected.length,3);
});
