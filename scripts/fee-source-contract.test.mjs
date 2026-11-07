import test from 'node:test';
import assert from 'node:assert/strict';
import {createSourceContractValidator,sourceContractInputHash,sourceContractFailureCode} from './fee-source-contract.mjs';

const H=letter=>letter.repeat(64),T0=Date.parse('2026-06-16T02:00:00.000Z');
const iso=n=>new Date(n).toISOString();
function fixture(extra={}){
  let now=T0,seen=null,calls=0;
  const executionId='SYNTH_RUN_1',validatorDependencyHash=H('a');
  const plan={schema:'fee-console.report-plan.v2',kind:'daily',periodFrom:'2026-06-15',
    accountingThrough:'2026-06-15',priceThrough:'2026-06-15',scheduledAt:'2026-06-16T09:00:00+08:00',monthlyCutoffs:[],markets:['NASDAQ','NYSE']};
  const sourceSet=['schwab','webull','ib-manager'].map((role,i)=>({role,identitySha256:H(String(i+1)),
    evidenceSha256:H(String(i+4)),fromDate:'2026-06-14',sourceDate:'2026-06-15'}));
  const bindings={mainSha:'a'.repeat(40),baseDataSha256:H('b'),baseHealthSha256:H('c'),ibBaselineSha256:H('d'),
    ibCheckpointSha256:H('e'),ibCoverageSha256:H('f'),ibAnchorSha256:H('1'),economicVersionSha256:H('2'),benchmarkSha256:H('3'),policySha256:H('4')};
  const inputs={schema:'SYNTH_INPUT_V1',sources:[{id:'SYNTH_A',rows:['SYNTH_ROW']},{id:'SYNTH_B',rows:[]},{id:'SYNTH_C',rows:[]}],unknownFlow:false,complete:true};
  const request={targetDate:'2026-06-15',plan,sourceSet,inputs,bindings,capturedAt:iso(T0-1000),expiresAt:iso(T0+60000)};
  const validate=async context=>{
    calls++;seen=context;
    if(!context.inputs.complete||context.inputs.unknownFlow)throw Error('SYNTH_PRIVATE_ERROR');
    return true;
  };
  const authority=createSourceContractValidator({executionId,validatorDependencyHash,validate,clock:()=>now,...extra});
  const current=()=>({executionId,validatorDependencyHash,targetDate:request.targetDate,plan:structuredClone(request.plan),
    sourceSet:structuredClone(request.sourceSet),inputSha256:sourceContractInputHash(request.inputs),bindings:structuredClone(request.bindings)});
  return {request,authority,current,setTime:n=>{now=n;},seen:()=>seen,calls:()=>calls};
}
const rejected=(promise,code)=>assert.rejects(promise,e=>sourceContractFailureCode(e)==='FEE_SOURCE_CONTRACT_'+code);
const refused=(fn,code)=>assert.throws(fn,e=>sourceContractFailureCode(e)==='FEE_SOURCE_CONTRACT_'+code);
test('fixed contract errors are immutable and cannot be relabelled as private text',()=>{
  const f=fixture();let issued;
  try{f.authority.consumeValidatedInputs(null,f.current());assert.fail('expected refusal');}catch(error){issued=error;}
  assert.ok(Object.isFrozen(issued));assert.throws(()=>{issued.message='SYNTH_PRIVATE_CANARY';},TypeError);
  assert.equal(sourceContractFailureCode(issued),'FEE_SOURCE_CONTRACT_HANDLE');
});

test('1 frozen same-input capability: bound validator runs once and consumer gets its exact immutable snapshot',async()=>{
  const f=fixture(),h=await f.authority.validateInputs(f.request),a=f.authority.consumeValidatedInputs(h,f.current());
  assert.equal(f.calls(),1);assert.strictEqual(a,f.seen().inputs);assert.notStrictEqual(a,f.request.inputs);
  assert.deepEqual(a,f.request.inputs);assert.equal(JSON.stringify(h),'{}');assert(Object.isFrozen(h));
  for(const value of [a,a.sources,a.sources[0],a.sources[0].rows,f.seen(),f.seen().plan,f.seen().sourceSet,f.seen().bindings])assert(Object.isFrozen(value));
  assert.throws(()=>{a.sources[0].rows.push('SYNTH_TAMPER');},TypeError);
  assert.throws(()=>{f.seen().plan.accountingThrough='2026-06-16';},TypeError);
  assert.strictEqual(f.authority.consumeValidatedInputs(h,f.current()),a);
  assert.equal(f.calls(),1,'repeat pure consumption is not another validation or production');
});
test('1 caller mutation during asynchronous validation cannot change frozen validated bytes or bindings',async()=>{
  let release,observed;
  const f=fixture({validate:async x=>{observed=x;await new Promise(resolve=>{release=resolve;});return true;}});
  const original=f.current(),pending=f.authority.validateInputs(f.request);
  f.request.inputs.sources[0].rows.push('SYNTH_CHANGED');f.request.bindings.ibAnchorSha256=H('9');
  release();const h=await pending,a=f.authority.consumeValidatedInputs(h,original);
  assert.strictEqual(a,observed.inputs);assert.deepEqual(a.sources[0].rows,['SYNTH_ROW']);
  refused(()=>f.authority.consumeValidatedInputs(h,f.current()),'INPUT_CHANGED');
});
test('1 canonical hash is order independent and source role ordering is semantically canonical',async()=>{
  assert.equal(sourceContractInputHash({b:2,a:{d:4,c:3}}),sourceContractInputHash({a:{c:3,d:4},b:2}));
  const f=fixture(),h=await f.authority.validateInputs(f.request),c=f.current();c.sourceSet.reverse();
  assert.deepEqual(f.authority.consumeValidatedInputs(h,c),f.request.inputs);
});

test('2 every current dependency field change invalidates the capability, including historical anchor',async()=>{
  const f=fixture(),h=await f.authority.validateInputs(f.request);
  for(const key of Object.keys(f.request.bindings)){
    const c=f.current();c.bindings[key]='9'.repeat(key==='mainSha'?40:64);
    refused(()=>f.authority.consumeValidatedInputs(h,c),'BINDING_CHANGED');
  }
  const c=f.current();c.validatorDependencyHash=H('9');refused(()=>f.authority.consumeValidatedInputs(h,c),'VERSION');
});
test('2 entire source scope, date and plan are bound rather than only target or totals',async()=>{
  const f=fixture(),h=await f.authority.validateInputs(f.request);
  for(const mutate of [c=>{c.plan.markets=['NYSE'];},c=>{c.plan.scheduledAt='2026-06-16T08:00:00+08:00';},
    c=>{c.plan.periodFrom='2026-06-14';},c=>{c.plan.priceThrough='2026-06-14';},
    c=>{c.sourceSet[0].identitySha256=H('9');},c=>{c.sourceSet[0].evidenceSha256=H('9');},c=>{c.sourceSet[0].fromDate='2026-06-13';}]){
    const c=f.current();mutate(c);refused(()=>f.authority.consumeValidatedInputs(h,c),'BINDING_CHANGED');
  }
  const c=f.current();c.targetDate='2026-06-16';refused(()=>f.authority.consumeValidatedInputs(h,c),'PLAN');
});
test('2 malformed hash, omitted bindings and fields pretending to be approval are rejected',async()=>{
  for(const change of [r=>{delete r.bindings.ibCoverageSha256;},r=>{r.bindings.extra=H('5');},r=>{r.bindings.mainSha='g'.repeat(40);},
    r=>{r.bindings.baseHealthSha256='A'.repeat(64);},r=>{r.bindings.policySha256=null;},r=>{r.bindings.mainSha=['a'.repeat(40)];}]){
    const f=fixture();change(f.request);await rejected(f.authority.validateInputs(f.request),'BINDINGS');assert.equal(f.calls(),0);
  }
  const f=fixture();f.request.verified=true;await rejected(f.authority.validateInputs(f.request),'SCHEMA');assert.equal(f.calls(),0);
});

test('3 sourceSet requires unique exact three roles, complete hashes and actual matching calendar dates',async()=>{
  for(const mutate of [r=>{r.sourceSet.pop();},r=>{r.sourceSet.push(structuredClone(r.sourceSet[0]));},
    r=>{r.sourceSet[0].role='SYNTH_OTHER';},r=>{r.sourceSet[0].role=r.sourceSet[1].role;},
    r=>{r.sourceSet[0].sourceDate='2026-06-14';},r=>{r.sourceSet[0].fromDate='2026-06-16';},
    r=>{r.sourceSet[0].evidenceSha256='bad';},r=>{delete r.sourceSet[0].identitySha256;},r=>{r.sourceSet[0].role=['schwab'];},
    r=>{r.sourceSet[0].identitySha256=[H('1')];},r=>{r.sourceSet[0].evidenceSha256=[H('1')];}]){
    const f=fixture();mutate(f.request);await rejected(f.authority.validateInputs(f.request),'SOURCE_SET');assert.equal(f.calls(),0);
  }
  const f=fixture();f.request.sourceSet[0].sourceDate='2026-02-30';await rejected(f.authority.validateInputs(f.request),'DATE');
});
test('3 full plan is required; structural checking does not replace the bound original plan validator',async()=>{
  for(const mutate of [r=>{delete r.plan.monthlyCutoffs;},r=>{r.plan.verified=true;},r=>{r.plan.kind='SYNTH_OTHER';},
    r=>{r.plan.markets=['NYSE','NASDAQ'];},r=>{r.plan.scheduledAt='2026-02-30T09:00:00+08:00';},
    r=>{r.plan.monthlyCutoffs=['2026-06-15','2026-06-15'];}]){
    const f=fixture();mutate(f.request);await assert.rejects(f.authority.validateInputs(f.request));assert.equal(f.calls(),0);
  }
  const f=fixture({validate:()=>false});await rejected(f.authority.validateInputs(f.request),'VALIDATION');
});
test('3 changing input hash or a missing current comparison never authorizes reuse',async()=>{
  const f=fixture(),h=await f.authority.validateInputs(f.request),c=f.current();
  c.inputSha256=H('9');refused(()=>f.authority.consumeValidatedInputs(h,c),'INPUT_CHANGED');
  delete c.inputSha256;refused(()=>f.authority.consumeValidatedInputs(h,c),'SCHEMA');
});

test('4 changed historical anchor with unchanged target invalidates; no implicit rebase or revision creation',async()=>{
  const f=fixture(),h=await f.authority.validateInputs(f.request),old=f.current(),updated=structuredClone(old);
  updated.bindings.ibAnchorSha256=H('8');updated.bindings.ibCheckpointSha256=H('7');
  refused(()=>f.authority.consumeValidatedInputs(h,updated),'BINDING_CHANGED');
  assert.deepEqual(f.request.bindings,old.bindings);assert.equal(f.calls(),1);
  assert.deepEqual(Object.keys(f.authority).sort(),['consumeValidatedInputs','validateInputs']);
});
test('4 existing unknown-flow and missing-completeness validator failures cannot issue a handle',async()=>{
  for(const change of [r=>{r.inputs.unknownFlow=true;},r=>{r.inputs.complete=false;}]){
    const f=fixture();change(f.request);await rejected(f.authority.validateInputs(f.request),'VALIDATION');assert.equal(f.calls(),1);
  }
});

test('5 TTL starts at capture, not validator completion; exact expiry and expiry during validation refuse',async()=>{
  const f=fixture(),h=await f.authority.validateInputs(f.request);
  f.setTime(T0+59999);f.authority.consumeValidatedInputs(h,f.current());
  f.setTime(T0+60000);refused(()=>f.authority.consumeValidatedInputs(h,f.current()),'EXPIRED');
  let g;g=fixture({validate:()=>{g.setTime(T0+60000);return true;}});
  await rejected(g.authority.validateInputs(g.request),'EXPIRED');
});
test('5 future, invalid, expired or extended capture intervals do not mint capabilities',async()=>{
  for(const [mutate,code] of [
    [r=>{r.capturedAt=iso(T0+1);},'TIME'],[r=>{r.expiresAt=iso(T0-1);},'EXPIRED'],
    [r=>{r.expiresAt=iso(T0+300000);},'TIME'],[r=>{r.expiresAt=r.capturedAt;},'TIME'],
    [r=>{r.capturedAt='2026-06-16T02:00:00Z';},'TIME'],[r=>{r.capturedAt='2026-02-30T02:00:00.000Z';},'TIME']]){
    const f=fixture();mutate(f.request);await rejected(f.authority.validateInputs(f.request),code);assert.equal(f.calls(),0);
  }
});
test('5 trusted clock must remain finite, safe and monotonic; error text is discarded',async()=>{
  for(const clock of [()=>NaN,()=>Infinity,()=>-1,()=>1.5,()=>Number.MAX_SAFE_INTEGER+1,()=>{throw Error('SYNTH_SECRET');}]){
    const f=fixture({clock});await rejected(f.authority.validateInputs(f.request),'CLOCK');
  }
  const f=fixture(),h=await f.authority.validateInputs(f.request);f.setTime(T0-1);
  refused(()=>f.authority.consumeValidatedInputs(h,f.current()),'CLOCK');
});
test('5 maxAgeMs configuration has bounded positive integer scope',()=>{
  for(const maxAgeMs of [null,0,-1,1.5,900001,Infinity,'300000'])refused(()=>fixture({maxAgeMs}),'CONFIG');
  refused(()=>fixture({clock:null}),'CONFIG');
});

test('6 handles cannot cross factories, execution ids, serialize or be recreated from fields',async()=>{
  const f=fixture(),g=fixture(),h=await f.authority.validateInputs(f.request);
  refused(()=>g.authority.consumeValidatedInputs(h,g.current()),'HANDLE');
  const c=f.current();c.executionId='SYNTH_RUN_2';refused(()=>f.authority.consumeValidatedInputs(h,c),'EXECUTION');
  for(const fake of [{verified:true},JSON.parse(JSON.stringify(h)),structuredClone(h),Object.freeze({}),Object.create(h),null,undefined,1,'SYNTH_HANDLE'])
    refused(()=>f.authority.consumeValidatedInputs(fake,f.current()),'HANDLE');
});
test('6 asynchronous validation must really finish and return exactly true before a handle exists',async()=>{
  for(const result of [false,undefined,null,1,'true',{verified:true}]){
    const f=fixture({validate:async()=>result});await rejected(f.authority.validateInputs(f.request),'VALIDATION');
  }
  let release;const f=fixture({validate:()=>new Promise(resolve=>{release=resolve;})});
  const pending=f.authority.validateInputs(f.request);refused(()=>f.authority.consumeValidatedInputs(pending,f.current()),'HANDLE');
  release(true);const h=await pending;assert.deepEqual(f.authority.consumeValidatedInputs(h,f.current()),f.request.inputs);
});

test('7 runtime gates are not represented by source approval or writable flags',async()=>{
  const f=fixture(),h=await f.authority.validateInputs(f.request),current=f.current();
  assert.deepEqual(Reflect.ownKeys(h),[]);
  for(const key of ['publicationReady','approved','attempts','sourceUnchanged','monthClosed','expiresAt']){
    const c=structuredClone(current);c[key]=true;refused(()=>f.authority.consumeValidatedInputs(h,c),'SCHEMA');
  }
  assert.equal(f.calls(),1);
});
test('7 valid monthly plan stays fully bound without claiming the month has closed',async()=>{
  const f=fixture();f.request.targetDate='2026-05-31';
  f.request.plan={schema:'fee-console.report-plan.v1',kind:'monthly',periodFrom:'2026-05-01',accountingThrough:'2026-05-31',priceThrough:'2026-05-29',scheduledAt:'2026-06-01T00:00:00+08:00',monthlyCutoffs:['2026-05-31']};
  for(const s of f.request.sourceSet){s.fromDate='2026-04-30';s.sourceDate='2026-05-31';}
  const h=await f.authority.validateInputs(f.request);assert.deepEqual(f.authority.consumeValidatedInputs(h,f.current()),f.request.inputs);
  const c=f.current();c.plan.monthlyCutoffs=[];refused(()=>f.authority.consumeValidatedInputs(h,c),'BINDING_CHANGED');
});

test('8 unsafe JSON cannot run accessors, Proxy traps or silently drop extra properties',async()=>{
  let sideEffects=0;
  const getter=Object.defineProperty({},'secret',{enumerable:true,get(){sideEffects++;throw Error('SYNTH_SECRET');}});
  const proxy=new Proxy({}, {ownKeys(){sideEffects++;return [];},get(){sideEffects++;throw Error('SYNTH_SECRET');}});
  const array=['SYNTH'];array.extra=true;
  const hidden=Object.defineProperty({},'hidden',{value:'SYNTH'}),symbol={[Symbol('SYNTH')]:1};
  const cycle={};cycle.self=cycle;
  const sparse=[];sparse.length=1;
  const bad=[getter,proxy,array,hidden,symbol,cycle,sparse,new Date(),new Map(),new Uint8Array([1]),/SYNTH/,Object.create({inherited:true}),
    {toJSON(){sideEffects++;return 'SYNTH';}},{n:NaN},{n:Infinity},{n:-0},{n:1n},{n:undefined},{n:()=>true},JSON.parse('{"__proto__":{"SYNTH":true}}')];
  for(const inputs of bad){const f=fixture();f.request.inputs=inputs;await rejected(f.authority.validateInputs(f.request),'JSON');assert.equal(f.calls(),0);}
  assert.equal(sideEffects,0);
});
test('8 oversized/deep inputs reject before validation and only fixed error codes escape',async()=>{
  let deep={};for(let i=0;i<70;i++)deep={next:deep};
  for(const inputs of [deep,{s:'x'.repeat(4*1024*1024+1)},Array(100001).fill(1)]){
    const f=fixture();f.request.inputs=inputs;await rejected(f.authority.validateInputs(f.request),'JSON');assert.equal(f.calls(),0);
  }
  const f=fixture({validate:()=>{throw Object.defineProperty({},'message',{get(){throw Error('SYNTH_LEAK');}});}});
  await assert.rejects(f.authority.validateInputs(f.request),e=>{
    assert.equal(e.message,'FEE_SOURCE_CONTRACT_VALIDATION');assert.equal(e.cause,undefined);
    assert.equal(JSON.stringify(e),'{}');return true;
  });
  assert.equal(sourceContractFailureCode(Error('FEE_SOURCE_CONTRACT_TIME')),'FEE_SOURCE_CONTRACT_REFUSED');
});
test('8 invalid factory function/config accessors are not invoked',()=>{
  let calls=0;const options=Object.defineProperty({},'validate',{enumerable:true,get(){calls++;return ()=>true;}});
  refused(()=>createSourceContractValidator(options),'CONFIG');
  refused(()=>createSourceContractValidator(new Proxy({}, {get(){calls++;}})),'CONFIG');
  refused(()=>fixture({validate:new Proxy(()=>true,{apply(){calls++;}})}),'CONFIG');
  refused(()=>fixture({validate:undefined}),'CONFIG');assert.equal(calls,0);
});
