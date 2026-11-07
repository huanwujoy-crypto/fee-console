import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createFeeSourceRevisionRuntime,sourceRevisionRuntimeFailureCode} from './fee-source-revision-runtime.mjs';
import {fetchEconomicSnapshot} from './fee-economic-source.mjs';
import {IB_SOURCE_REVISION_FAILURE_CODES} from './ib-manager-source-revision.mjs';
import {dailyReportPlan} from './fee-report-period.mjs';
import {produce,safeProducerFailureSummary,producerFailureCode} from './fee-cloud-producer.mjs';

const KEY=Buffer.alloc(32,6),ID='a'.repeat(32),DATE='2026-11-06';
const now=()=>Date.parse('2026-11-07T06:30:00.000Z');
const sealed=()=>{const iv=Buffer.alloc(12,7),cipher=crypto.createCipheriv('aes-256-gcm',KEY,iv);
 const data=Buffer.concat([cipher.update('{"v":4}'),cipher.final()]);return JSON.stringify({enc:true,v:4,data:Buffer.concat([iv,data,cipher.getAuthTag()]).toString('base64')});};
async function fixture(t){
 const oldId=process.env.FEE_ECON_GIST_ID,oldToken=process.env.FEE_ECON_GITHUB_TOKEN;
 process.env.FEE_ECON_GIST_ID=ID;delete process.env.FEE_ECON_GITHUB_TOKEN;
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'revision-runtime-synthetic-')),bytes=sealed();
 const economicSnapshot=await fetchEconomicSnapshot({tempRoot:dir,attempts:1,fetchImpl:async()=>new Response(JSON.stringify({id:ID,public:false,owner:{login:'huanwujoy-crypto'},truncated:false,history:[{version:'e'.repeat(40)}],files:{'fee-console-db.json':{filename:'fee-console-db.json',content:bytes,size:Buffer.byteLength(bytes),truncated:false}}}),{headers:{etag:'"synthetic"'}})});
 let calls=0;const config={plan:dailyReportPlan(DATE,['NYSE','NASDAQ'],{reviewedSyncDate:DATE}),admission:Object.freeze({}),economicSnapshot,
  sourceBytes:Buffer.from('synthetic encrypted bytes'),sourcePayload:{feeCalculationReceipt:{asOf:'2026-11-05'}},healthBytes:Buffer.from('synthetic health'),
  githubToken:'SYNTHETIC_TOKEN',clientId:'synthetic-client',clientSecret:'synthetic-secret',keyText:KEY.toString('base64url'),
  baselineSha256:'b'.repeat(64),legacySourcePath:null,fetchImpl:async()=>{calls++;assert.fail('no real or synthetic source request allowed');},clock:now};
 t.after(()=>{economicSnapshot.cleanup();fs.rmSync(dir,{recursive:true,force:true});
  if(oldId===undefined)delete process.env.FEE_ECON_GIST_ID;else process.env.FEE_ECON_GIST_ID=oldId;
  if(oldToken===undefined)delete process.env.FEE_ECON_GITHUB_TOKEN;else process.env.FEE_ECON_GITHUB_TOKEN=oldToken;});
 return{config,calls:()=>calls};
}
const rejects=(promise,code)=>assert.rejects(promise,e=>{assert.equal(sourceRevisionRuntimeFailureCode(e),'FEE_REPORT_SOURCE_REVISION_'+code);assert(Object.isFrozen(e));assert(!Object.hasOwn(e,'cause'));return true;});

test('runtime rejects fabricated admission before any GitHub or Sharesight request and retains caller bytes',async t=>{
 const f=await fixture(t),before=Buffer.from(f.config.sourceBytes);
 await rejects(createFeeSourceRevisionRuntime(f.config),'ADMISSION');assert.equal(f.calls(),0);assert(f.config.sourceBytes.equals(before));
});
test('a serialized sync-cycle execution binding cannot replace the producer WeakMap admission',async t=>{
 const f=await fixture(t);let called=0;
 for(const contractId of ['ib-source-revision-20261106-sync-v2','ib-source-revision-20261106-sync-v3']){
  const binding={contractId,targetDate:DATE,mainSha:'a'.repeat(40),repairBaseSha:'b'.repeat(40),
   approvedHead:'c'.repeat(40),approvedTree:'d'.repeat(40),currentRunId:90000000001,admissionModel:'sync-cycle-v1',executionSha256:'e'.repeat(64)};
  for(const admission of [binding,{...binding,checkCurrent(){called++;return binding;},close(){called++;}}])
   await rejects(createFeeSourceRevisionRuntime({...f.config,admission}),'ADMISSION');
 }
 assert.equal(called,0);assert.equal(f.calls(),0);
});
test('all read-only diagnostic contracts require genuine separate admissions and cannot authorize production by serialized flags',async t=>{
 const f=await fixture(t);let called=0;
 for(const contractId of ['ib-source-revision-20261106-diagnostic-v1','ib-source-revision-20261106-diagnostic-v2','ib-source-revision-20261106-diagnostic-v3','ib-source-revision-20261106-diagnostic-v4']){
  const binding={contractId,purpose:'read-only-diagnostic',targetDate:DATE,mainSha:'a'.repeat(40),repairBaseSha:'b'.repeat(40),
   approvedHead:'c'.repeat(40),approvedTree:'d'.repeat(40),currentRunId:90000000001,admissionModel:'sync-cycle-v1',executionSha256:'e'.repeat(64)};
  for(const admission of [binding,{...binding,checkCurrent(){called++;return binding;},close(){called++;}},new Proxy(binding,{get(){called++;throw Error('PRIVATE_CANARY');}})]){
   await rejects(createFeeSourceRevisionRuntime({...f.config,admission,diagnosticOnly:true}),'ADMISSION');
   await rejects(createFeeSourceRevisionRuntime({...f.config,admission}),'ADMISSION');
  }
 }
 assert.equal(called,0);assert.equal(f.calls(),0);
});
test('runtime binds the one reviewed date and rejects ordinary, same-cutoff and other target plans before IO',async t=>{
 const f=await fixture(t);
 const variants=[{...f.config,plan:dailyReportPlan(DATE,['NYSE','NASDAQ'])},
  {...f.config,plan:dailyReportPlan(DATE,['NYSE'],{reviewedSyncDate:DATE})},
  {...f.config,plan:dailyReportPlan('2026-11-05',['NYSE','NASDAQ'],{reviewedSyncDate:'2026-11-05'})},
  {...f.config,plan:dailyReportPlan(DATE,['NYSE','NASDAQ'],{periodFrom:'2026-11-05',reviewedSyncDate:DATE})},
  {...f.config,sourcePayload:{feeCalculationReceipt:{asOf:DATE}}}];
 for(const x of variants)await rejects(createFeeSourceRevisionRuntime(x),'SCOPE');assert.equal(f.calls(),0);
});
test('runtime rejects getters/proxies, unknown settings and forged economic objects without evaluating private getters',async t=>{
 const f=await fixture(t);let getters=0;
 const bad={...f.config};Object.defineProperty(bad,'keyText',{enumerable:true,get(){getters++;throw Error('PRIVATE_TOKEN');}});
 for(const x of [bad,new Proxy(f.config,{}),{...f.config,extra:true},{...f.config,economicSnapshot:{...f.config.economicSnapshot}}])
  await rejects(createFeeSourceRevisionRuntime(x),'CONFIG');
 assert.equal(getters,0);assert.equal(f.calls(),0);
});
test('runtime refuses malformed credentials and source containers, emitting fixed non-secret errors only',async t=>{
 const f=await fixture(t);
 for(const x of [{...f.config,keyText:'PRIVATE_KEY_BAD'}, {...f.config,githubToken:'PRIVATE_TOKEN\n'},
  {...f.config,sourceBytes:Buffer.alloc(0)}, {...f.config,healthBytes:Buffer.alloc(2*1024*1024+1)},
  {...f.config,baselineSha256:'PRIVATE_ID'}])await rejects(createFeeSourceRevisionRuntime(x),'CONFIG');
 assert.equal(sourceRevisionRuntimeFailureCode({get message(){throw Error('PRIVATE');}}),'FEE_REPORT_SOURCE_REVISION_REFUSED');assert.equal(f.calls(),0);
});
test('cloud producer refuses revision on ordinary/nonfinal paths before any financial call',async()=>{
 let calls=0;const base={ibRevision:{candidate:{},artifacts:{},basePayload:{}},reader:{readStable(){calls++;throw Error('PRIVATE');}},fetchEconomic:async()=>{calls++;throw Error('PRIVATE');}};
 for(const extra of [{},{periodMode:true,includeIb:false,requireIb:true},{periodMode:true,includeIb:true,requireIb:false},
  {periodMode:true,includeIb:true,requireIb:true,reportPlan:dailyReportPlan(DATE,['NYSE','NASDAQ']),ibReader:{}}])
  await assert.rejects(produce({...base,...extra}),{message:'FEE_CLOUD_IB_REVISION_SCOPE'});
 assert.equal(calls,0);
});
test('cloud producer refuses duck-typed revision capability and unregistered candidate before any financial call',async()=>{
 let calls=0;
 await assert.rejects(produce({periodMode:true,includeIb:true,requireIb:true,
  reportPlan:dailyReportPlan(DATE,['NYSE','NASDAQ'],{reviewedSyncDate:DATE}),
  ibRevision:{candidate:{mode:'extend-cutoff',oldThrough:'2026-11-05',targetDate:DATE},artifacts:{verifyCandidate(){calls++;return true;}},basePayload:{}},
  fetchEconomic:async()=>{calls++;throw Error('PRIVATE');}}),{message:'FEE_CLOUD_IB_REVISION_SCOPE'});
 assert.equal(calls,0);
});

test('public recovery failure summary preserves only literal revision codes',()=>{
 for(const code of ['FEE_REPORT_SOURCE_REVISION_BASE_MISMATCH','FEE_REPORT_SOURCE_REVISION_ARTIFACT_HISTORY','FEE_CLOUD_IB_REVISION_SCOPE']){
  const result=safeProducerFailureSummary(code+'\n');assert.equal(result.code,code);
 }
 const hidden=safeProducerFailureSummary('FEE_REPORT_SOURCE_REVISION_PRIVATE_ACCOUNT_123\n');
 assert.notEqual(hidden.code,'FEE_REPORT_SOURCE_REVISION_PRIVATE_ACCOUNT_123');
});

test('writer handoff refusal retains a fixed IB input reason without private text',()=>{
 assert.equal(producerFailureCode(new Error('IB_REPORT_INPUT_REFUSED'),'REVISION_PREPARE'),'FEE_CLOUD_IB_INPUT');
 assert.equal(safeProducerFailureSummary('FEE_CLOUD_IB_INPUT\n').code,'FEE_CLOUD_IB_INPUT');
 assert.equal(producerFailureCode(new Error('IB_REPORT_INPUT_REFUSED PRIVATE_CANARY'),'REVISION_PREPARE'),'FEE_CLOUD_STAGE_REVISION_PREPARE_UNKNOWN');
});

test('branded historical source reasons preserve finite detailed diagnostics without arbitrary suffixes',()=>{
 for(const raw of IB_SOURCE_REVISION_FAILURE_CODES.filter(c=>c!=='IB_REVISION_REFUSED')){
  const suffix=raw.startsWith('IB_REVISION_SOURCE_REFUSED_IB_SOURCE_')?'SOURCE_'+raw.slice('IB_REVISION_SOURCE_REFUSED_IB_SOURCE_'.length):'REVISION_'+raw.slice('IB_REVISION_'.length);
  const code='FEE_REPORT_SOURCE_REVISION_ARTIFACT_'+suffix;
  assert.match(code,/^FEE_REPORT_[A-Z_]{1,64}$/);
  assert.equal(safeProducerFailureSummary(code+'\n').code,code);
 }
 assert.notEqual(safeProducerFailureSummary('FEE_REPORT_SOURCE_REVISION_ARTIFACT_SOURCE_PRIVATE_VALUE\n').code,'FEE_REPORT_SOURCE_REVISION_ARTIFACT_SOURCE_PRIVATE_VALUE');
});
