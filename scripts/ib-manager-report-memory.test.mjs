import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepareIbManagerReportInput,prepareIbManagerReport} from './ib-manager-report.mjs';
import {IbManagerSourceError,ibBaselineBusinessHash} from './ib-manager-source.mjs';
import {buildIbManagerReportBundle} from './ib-manager-return.mjs';

// Synthetic source only. No account access, credentials or captured private data.
function fixture(){
  const business={points:[{d:'2026-08-31',tot:100},{d:'2026-09-01',tot:150},{d:'2026-09-02',tot:135}],
    openT:100,from:'2026-08-31',to:'2026-09-02',days:3,flowByDate:{'2026-09-01':50},rate:0,cr:0,cumBefore:0,hwmBefore:0};
  const lock=ibBaselineBusinessHash(business);
  const source={schema:'fee-console.ib-manager-source.v1',scope:'ib-manager',currency:'USD',timezone:'America/New_York',flowTiming:'eod',
    baselineFrom:business.from,baselineAsOf:business.to,baselineInputsHash:lock,portfolioIdentityHash:'a'.repeat(64),
    sourceAsOf:business.to,sourceEvidenceHash:'b'.repeat(64),cashFlowByDate:{'2026-09-01':50},noncashProofs:[],periodReturnsInput:business};
  const calls=[],reader={async readStable(args){assert.equal(this,reader);calls.push(args);return structuredClone(source);}};
  return {source,calls,reader,args:{payload:{},targetDate:business.to,environ:{IB_MANAGER_READ_ENABLED:'true',IB_MANAGER_BASELINE_SHA256:lock},reader}};
}
function privateDir(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ib-report-memory-synthetic-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}

test('explicit source preparation runs the real bundle validation without filesystem, network or credential discovery',async()=>{
  const f=fixture(),before=structuredClone(f.args.payload),saved=new Map(),originalFetch=globalThis.fetch;
  for(const method of ['readFileSync','writeFileSync','realpathSync','statSync','openSync','mkdirSync']){saved.set(method,fs[method]);fs[method]=()=>assert.fail('source preparation attempted filesystem IO');}
  globalThis.fetch=()=>assert.fail('source preparation attempted network IO');
  for(const name of ['FEE_CLOUD_SHARESIGHT_CLIENT_ID','FEE_CLOUD_SHARESIGHT_CLIENT_SECRET'])Object.defineProperty(f.args.environ,name,{get(){assert.fail('source preparation inspected a credential');}});
  let prepared;
  try{prepared=await prepareIbManagerReportInput(f.args);}finally{for(const [k,v]of saved)fs[k]=v;globalThis.fetch=originalFetch;}
  assert.equal(f.calls.length,1);assert.equal(prepared.state,'verified');
  assert.deepEqual(prepared,{schema:'fee-console.ib-manager-report-request.v1',targetDate:f.args.targetDate,state:'verified',source:f.source});
  assert.deepEqual(f.args.payload,before);
  const bundle=await buildIbManagerReportBundle(prepared.source,f.args.environ.IB_MANAGER_BASELINE_SHA256);
  assert.equal(bundle.returnReceipt.asOf,f.args.targetDate);assert.equal(bundle.drawdownReceipt.asOf,f.args.targetDate);
});

test('memory entry requires explicit dependencies even when process environment enables IB',async()=>{
  const f=fixture();
  for(const args of [undefined,{}, {environ:f.args.environ}, {...f.args,environ:undefined}, {...f.args,reader:undefined}, {...f.args,reader:{}}])
    await assert.rejects(prepareIbManagerReportInput(args),{message:'IB_REPORT_INPUT_REFUSED'});
  assert.equal(f.calls.length,0);
});

test('disabled, malformed date, missing lock and missing coverage stop before invoking the reader',async()=>{
  const f=fixture();
  assert.equal(await prepareIbManagerReportInput({...f.args,environ:{}}),null);
  for(const targetDate of [undefined,'private-canary','2026-9-2'])await assert.rejects(prepareIbManagerReportInput({...f.args,targetDate}),{message:'IB_REPORT_INPUT_REFUSED'});
  const missing=await prepareIbManagerReportInput({...f.args,environ:{IB_MANAGER_READ_ENABLED:'true'}});
  assert.equal(missing.reasonCode,'IB_SOURCE_BASELINE_LOCK');
  const uncovered=await prepareIbManagerReportInput({...f.args,targetDate:'2026-10-24'});
  assert.equal(uncovered.reasonCode,'IB_SOURCE_COVERAGE_UNVERIFIED');assert.equal(f.calls.length,0);
});

test('actual source schema, amount, baseline and target validation are not bypassed by a reader result',async t=>{
  for(const [name,change,target,reason]of [
    ['schema',s=>s.extra='private-canary',null,'IB_SOURCE_SCHEMA'],
    ['cent precision',s=>s.periodReturnsInput.points[2].tot+=0.001,null,'IB_SOURCE_AMOUNT'],
    ['baseline',s=>s.baselineInputsHash='f'.repeat(64),null,'IB_SOURCE_SCHEMA'],
    ['target',()=>{},'2026-09-03','IB_SOURCE_STATE_INVALID']
  ])await t.test(name,async()=>{
    const f=fixture();change(f.source);const result=await prepareIbManagerReportInput({...f.args,...(target?{targetDate:target}:{})});
    assert.equal(result.state,'pending');assert.equal(result.reasonCode,reason);assert.equal(Object.hasOwn(result,'source'),false);
    assert.doesNotMatch(JSON.stringify(result),/private-canary/);
  });
});

test('tampered authenticated history fails before the reader; original payload and source stay unchanged',async()=>{
  const f=fixture(),b=await buildIbManagerReportBundle(f.source,f.args.environ.IB_MANAGER_BASELINE_SHA256);
  f.args.payload={ibManagerReturnReceipt:b.returnReceipt,ibManagerDrawdownReceipt:b.drawdownReceipt,ibManagerSourceState:b.sourceState};
  f.args.payload.ibManagerSourceState.stateId='f'.repeat(64);
  const before=structuredClone(f.args.payload),source=structuredClone(f.source),result=await prepareIbManagerReportInput(f.args);
  assert.equal(result.reasonCode,'IB_SOURCE_STATE_INVALID');assert.equal(f.calls.length,0);
  assert.deepEqual(f.args.payload,before);assert.deepEqual(f.source,source);
});

test('original reader error categories remain fixed pending reasons without leaking private exception text',async t=>{
  const codes=['CONFIG','BASELINE_LOCK','BASELINE_MISMATCH','SCOPE','IDENTITY','INCOMPLETE','DATE','DATE_ALIGNMENT','AMOUNT','SCHEMA','CASH_RECONCILIATION','UNRESOLVED_FLOW','UNVERIFIED_TRANSFER','NONCASH_EVIDENCE','UNSUPPORTED_CURRENCY','UNSTABLE','HISTORY_LIMIT','PAST_POINT_CHANGED','STATE','NETWORK'];
  for(const code of codes)await t.test(code,async()=>{
    const f=fixture();let calls=0;
    const result=await prepareIbManagerReportInput({...f.args,reader:{async readStable(){calls++;throw new IbManagerSourceError(code);}}});
    assert.deepEqual(result,{schema:'fee-console.ib-manager-report-request.v1',targetDate:f.args.targetDate,state:'pending',reasonCode:'IB_SOURCE_'+code});assert.equal(calls,1);
  });
  const f=fixture(),result=await prepareIbManagerReportInput({...f.args,reader:{async readStable(){throw Error('private-canary amount=123');}}});
  assert.equal(result.reasonCode,'IB_SOURCE_NETWORK');assert.doesNotMatch(JSON.stringify(result),/private-canary|123/);
});

test('existing private file wrapper writes exactly the shared verified request and still forbids overwrite',async t=>{
  const f=fixture(),dir=privateDir(t),memory=await prepareIbManagerReportInput(f.args);
  const result=await prepareIbManagerReport({...f.args,outputDir:dir});
  assert.equal(result.state,'verified');assert.equal(fs.statSync(result.file).mode&0o777,0o600);
  assert.equal(fs.readFileSync(result.file,'utf8'),JSON.stringify(memory));
  const before=fs.readFileSync(result.file);await assert.rejects(prepareIbManagerReport({...f.args,outputDir:dir}),{code:'EEXIST'});
  assert.deepEqual(fs.readFileSync(result.file),before);
});

test('existing wrapper retains disabled and private-directory checks, plus lazy credential access',async t=>{
  const f=fixture(),dir=privateDir(t);let credentialReads=0;
  const environ={IB_MANAGER_READ_ENABLED:'true'};
  for(const k of ['FEE_CLOUD_SHARESIGHT_CLIENT_ID','FEE_CLOUD_SHARESIGHT_CLIENT_SECRET'])Object.defineProperty(environ,k,{get(){credentialReads++;throw Error('private-canary');}});
  assert.equal(await prepareIbManagerReport({environ:{}}),null);
  const result=await prepareIbManagerReport({payload:{},targetDate:f.args.targetDate,outputDir:dir,environ});
  assert.equal(result.reasonCode,'IB_SOURCE_BASELINE_LOCK');assert.equal(credentialReads,0);
  fs.unlinkSync(result.file);fs.chmodSync(dir,0o755);
  await assert.rejects(prepareIbManagerReport({...f.args,outputDir:dir}),{message:'IB_REPORT_INPUT_REFUSED'});assert.equal(f.calls.length,0);
  fs.chmodSync(dir,0o700);
});

test('existing private file wrapper emits the identical sanitized pending request',async t=>{
  const f=fixture(),dir=privateDir(t),reader={async readStable(){throw new IbManagerSourceError('CASH_RECONCILIATION');}},args={...f.args,reader};
  const memory=await prepareIbManagerReportInput(args),result=await prepareIbManagerReport({...args,outputDir:dir});
  assert.equal(result.reasonCode,'IB_SOURCE_CASH_RECONCILIATION');assert.equal(fs.readFileSync(result.file,'utf8'),JSON.stringify(memory));
});
