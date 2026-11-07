import test from 'node:test';
import assert from 'node:assert/strict';
import {createCapturedSyncCycle,syncCycleFailureCode} from './fee-sync-cycle.mjs';
import {projectCapturedSharesightAccount} from './fee-sync-captured-inputs.mjs';
import {sourceContractInputHash as hash} from './fee-source-contract.mjs';
import {dailyReportPlan} from './fee-report-period.mjs';
import {D,B,cloudFixture,seededIbFixture} from './fee-sync-test-fixtures.mjs';

// The actual three-account readers and original validators run against synthetic
// transport. Authentication/version adapters below are test doubles, not proof
// of production authentication. No credentials, real requests or writers exist.
const H=c=>c.repeat(64),TIME=Date.parse('2026-09-03T01:00:00.000Z'),iso=n=>new Date(n).toISOString();
async function fixture({verifyBase,receiptChange,currentChange}={}){
  const fee=cloudFixture({quantity:'1'}),ib=await seededIbFixture();
  const feeCapture=await fee.reader.readStableWithEvidence(D,B),ibCapture=await ib.reader.readStableWithEvidence(ib.args);
  let now=TIME,currentCalls=0,baseCalls=0,syncCalls=0;
  const executionId='SYNTH_SYNC_CYCLE',validatorDependencyHash=H('a');
  const scopes=[ib.scope,fee.scope('schwab'),fee.scope('webull')];
  const projected=scopes.map(scope=>projectCapturedSharesightAccount({scope,
    reader:scope.role==='ib-manager'?ib.reader:fee.reader,captured:scope.role==='ib-manager'?ibCapture:feeCapture}));
  const publishedHistory=scopes.map((s,i)=>({role:s.role,through:'2026-09-01',semanticSha256:H(String(i+1))}));
  const request={targetDate:D,plan:dailyReportPlan(D,['NASDAQ','NYSE'],{reviewedSyncDate:D}),
    bindings:{mainSha:'a'.repeat(40),baseDataSha256:H('b'),baseHealthSha256:H('c'),ibBaselineSha256:ib.args.expectedBaselineHash,
      ibCheckpointSha256:H('d'),ibCoverageSha256:H('e'),ibAnchorSha256:H('f'),economicVersionSha256:H('1'),benchmarkSha256:H('2'),policySha256:H('3')},
    capturedAt:iso(TIME-1000),expiresAt:iso(TIME+60000),cycleId:'SYNTH_SYNC',publishedHistory};
  const accounts=projected.map(p=>({role:p.scope.role,scope:p.scope,raw:p.raw,captureSourceSha256:p.captureSourceSha256,validatedInputSha256:p.validatedInputSha256}));
  const sourceSet=projected.map(p=>({role:p.scope.role,identitySha256:hash(p.projection.identity),evidenceSha256:p.projection.sourceSha256,fromDate:p.scope.fromDate,sourceDate:p.scope.targetDate}));
  const input={schema:'fee-console.sync-input.v1',cycleId:request.cycleId,accounts,publishedHistory};
  const expected={executionId,validatorDependencyHash,targetDate:D,plan:request.plan,sourceSet,inputSha256:hash(input),bindings:request.bindings};
  const receipt={schema:'fee-console.verified-sync.v1',cycleId:request.cycleId,targetDate:D,completedAt:iso(TIME-500),publishedHistory,
    accounts:projected.map(p=>({role:p.scope.role,state:'complete',unresolved:[],projection:p.projection,captureSourceSha256:p.captureSourceSha256,validatedInputSha256:p.validatedInputSha256}))};
  const payloadHash=hash(ib.payload);
  const config={feeReader:fee.reader,ibReader:ib.reader,executionId,validatorDependencyHash,clock:()=>now,
    verifySynchronization:async()=>{syncCalls++;const r=structuredClone(receipt);receiptChange?.(r);return r;},
    verifyPublishedBase:async x=>{baseCalls++;return verifyBase?verifyBase(x):hash(x.payload)===payloadHash&&hash(x.bindings)===hash(request.bindings)&&hash(x.benchmark)===hash(B)&&x.targetDate===D;},
    readCurrentContext:async()=>{currentCalls++;const c=structuredClone(expected);return currentChange?currentChange(c,currentCalls):c;}};
  const args={request,feeCapture,ibCaptures:[ibCapture],scopes,benchmark:B,ibPayload:ib.payload,ibEnviron:ib.environ};
  return {fee,ib,args,config,api:createCapturedSyncCycle(config),counts:()=>({baseCalls,syncCalls,currentCalls,network:fee.calls.length+ib.calls.length}),setTime:v=>{now=v;}};
}
const rejects=(p,code)=>assert.rejects(p,e=>{assert.equal(syncCycleFailureCode(e),code);assert(Object.isFrozen(e));return true;});

test('actual three-account validated capture feeds sync and reusable report inputs with no additional source IO',async()=>{
  const f=await fixture(),before=f.counts().network,base=structuredClone(f.args.ibPayload);
  const prepared=await f.api.prepare(f.args),a=await prepared.consumeForReport(),b=await prepared.consumeForReport();
  assert.strictEqual(a,b);assert(Object.isFrozen(a.calculationInputs));
  assert.deepEqual(a.calculationInputs.fee.accounts,{schwab:150,webull:150});
  assert.equal(a.calculationInputs.fee.sourceReference.cashHistoryReconstructed,false);
  assert.equal(a.calculationInputs.ib.state,'verified');assert.equal(a.calculationInputs.ib.source.sourceAsOf,D);
  assert.deepEqual(a.calculationInputs.ib.source,f.args.ibCaptures[0].input);
  assert.equal(f.counts().network,before);assert.deepEqual(f.args.ibPayload,base);
  assert.equal(f.counts().baseCalls,1);assert.equal(f.counts().syncCalls,1);
  assert.equal(JSON.stringify(prepared),'{}');
  await rejects(f.api.prepare(f.args),'FEE_SYNC_CYCLE_ALREADY_PREPARED');
});
test('same stable sources do not override a partial synchronization or an unresolved item',async t=>{
  for(const change of [r=>r.accounts[0].state='partial',r=>r.accounts[2].unresolved.push('SYNTH_PENDING')])await t.test(String(change),async()=>{
    const f=await fixture({receiptChange:change}),before=f.counts().network;
    await rejects(f.api.prepare(f.args),'FEE_SYNC_CYCLE_READINESS_SYNC_INCOMPLETE');
    assert.equal(f.counts().baseCalls,0);assert.equal(f.counts().network,before);
  });
});
test('history differences pause ordinary handoff and cannot silently invoke historical revision',async()=>{
  const f=await fixture({receiptChange:r=>r.publishedHistory[0].semanticSha256=H('9')});
  await rejects(f.api.prepare(f.args),'FEE_SYNC_CYCLE_READINESS_HISTORY_CHANGED');assert.equal(f.counts().baseCalls,0);
});
test('false, unauthenticated or changed published base cannot prepare report inputs',async t=>{
  for(const verifyBase of [()=>false,()=>({matched:true}),()=>{throw Error('PRIVATE_CANARY');}])await t.test(String(verifyBase),async()=>{
    const f=await fixture({verifyBase});await rejects(f.api.prepare(f.args),'FEE_SYNC_CYCLE_READINESS_ORIGINAL_VALIDATION');
  });
  const f=await fixture();f.args.ibPayload.extra='SYNTH_TAMPER';
  await rejects(f.api.prepare(f.args),'FEE_SYNC_CYCLE_READINESS_ORIGINAL_VALIDATION');
});
test('captured result copies and different source read arguments cannot be substituted',async t=>{
  for(const mutate of [f=>f.args.feeCapture=structuredClone(f.args.feeCapture),f=>f.args.ibCaptures=[structuredClone(f.args.ibCaptures[0])]])await t.test(String(mutate),async()=>{
    const f=await fixture();mutate(f);await rejects(f.api.prepare(f.args),'FEE_SYNC_CYCLE_CAPTURE');
  });
  const f=await fixture();f.args.benchmark={...B,spy:101};
  await rejects(f.api.prepare(f.args),'FEE_SYNC_CYCLE_READINESS_ORIGINAL_VALIDATION');
});
test('same official GET evidence with a new benchmark cannot reuse the old authenticated synchronization binding',async()=>{
  const f=await fixture(),changed={spy:999,qqq:999};
  const replacement=await f.fee.reader.readStableWithEvidence(D,changed);
  assert.equal(replacement.evidence.sourceSha256,f.args.feeCapture.evidence.sourceSha256);
  assert.notEqual(hash(replacement.input),hash(f.args.feeCapture.input));
  f.args.feeCapture=replacement;f.args.benchmark=changed;
  await rejects(f.api.prepare(f.args),'FEE_SYNC_CYCLE_READINESS_CURRENT');assert.equal(f.counts().baseCalls,0);
});
test('historical plan, calendar, cutoff and baseline are checked before source consumption',async()=>{
  const f=await fixture();f.args.request.plan={...f.args.request.plan,scheduledAt:'2026-09-03T03:00:00Z'};
  await rejects(f.api.prepare(f.args),'FEE_SYNC_CYCLE_PLAN');assert.equal(f.counts().syncCalls,0);
  const early=await fixture();early.setTime(Date.parse('2026-09-02T16:00:00.000Z'));
  await rejects(early.api.prepare(early.args),'FEE_SYNC_CYCLE_NOT_READY');
  const lock=await fixture();lock.args.ibEnviron={...lock.args.ibEnviron,IB_MANAGER_BASELINE_SHA256:H('9')};
  await rejects(lock.api.prepare(lock.args),'FEE_SYNC_CYCLE_BASE');
});
test('latest context is checked again before report reuse and expiry refuses reuse',async()=>{
  const f=await fixture({currentChange:(c,n)=>n>=3?{...c,bindings:{...c.bindings,baseDataSha256:H('9')}}:c});
  const prepared=await f.api.prepare(f.args);await assert.rejects(prepared.consumeForReport(),/FEE_SYNC_READY_CURRENT/);
  const expired=await fixture(),p=await expired.api.prepare(expired.args);expired.setTime(TIME+60000);
  await assert.rejects(p.consumeForReport(),/FEE_SYNC_READY_EXPIRED_OR_CHANGED/);
});
test('instance overrides cannot replace original capture consumption',async()=>{
  const f=await fixture();f.fee.reader.consumeCapturedRead=()=>assert.fail('override called');f.ib.reader.consumeCapturedRead=()=>assert.fail('override called');
  const p=await f.api.prepare(f.args);assert.equal((await p.consumeForReport()).calculationInputs.ib.state,'verified');
});
test('unsafe request properties and fake readers are refused without executing traps',async()=>{
  const f=await fixture();let touched=0;
  await rejects(f.api.prepare({get request(){touched++;throw Error('PRIVATE_CANARY');}}),'FEE_SYNC_CYCLE_INPUT');
  assert.equal(touched,0);
  assert.throws(()=>createCapturedSyncCycle({...f.config,feeReader:{sourceMode:'sharesight-reference',verifyCapturedRead:()=>true,consumeCapturedRead:()=>({})}}),/FEE_SYNC_CYCLE_CONFIG/);
});
test('capture list accessors, custom iterators and bootstrap lists are refused without execution',async t=>{
  for(const kind of ['getter','some','iterator','bootstrap'])await t.test(kind,async()=>{
    const f=await fixture();let touched=0;
    const values=[f.args.ibCaptures[0]];
    if(kind==='getter')Object.defineProperty(values,'0',{enumerable:true,get(){touched++;return f.args.ibCaptures[0];}});
    if(kind==='some')values.some=()=>{touched++;return false;};
    if(kind==='iterator')values[Symbol.iterator]=()=>{touched++;return [][Symbol.iterator]();};
    if(kind==='bootstrap')values.push(values[0]);
    f.args.ibCaptures=values;
    await rejects(f.api.prepare(f.args),'FEE_SYNC_CYCLE_CAPTURE');assert.equal(touched,0);
  });
});
test('multi-day recovery plans are explicitly outside the one-day reuse path',async()=>{
  const f=await fixture();f.args.request.plan=dailyReportPlan(D,['NASDAQ','NYSE'],{reviewedSyncDate:D,periodFrom:'2026-09-01'});
  await rejects(f.api.prepare(f.args),'FEE_SYNC_CYCLE_PLAN_SCOPE');assert.equal(f.counts().syncCalls,0);
});
