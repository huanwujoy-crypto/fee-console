import test from 'node:test';
import assert from 'node:assert/strict';
import {createUnifiedSourceReadiness,syncReadinessFailureCode} from './fee-sync-readiness.mjs';
import {projectSharesightSyncAccount} from './fee-sync-source-projection.mjs';
import {sourceContractInputHash as hash} from './fee-source-contract.mjs';
import {normalizeRead,parseSourceJson} from './fee-cloud-source.mjs';

// Entirely synthetic source strings and trusted-adapter substitutes. Nothing
// here loads account files, credentials, real HTTP or a publication writer.
const DAY='2026-06-15',TIME=Date.parse('2026-06-16T02:00:00.000Z');
const H=c=>c.repeat(64),iso=n=>new Date(n).toISOString();
function account(role,n){
  const [portfolioId,name]=role==='ib-manager'?[1,'IB-HK']:role==='schwab'?[936249,'Schwab-HK']:[1350094,'Webull'];
  const holdingId=n*10,cashId=n*100;
  const portfolio={id:portfolioId,name},instrument={id:n*1000,code:'SYNTH'+n,market_code:'NYSE',currency_code:'USD'};
  const scope={role,portfolioId,name,targetDate:DAY,fromDate:DAY};
  const raw={
    performance:JSON.stringify({report:{portfolio_id:portfolioId,start_date:DAY,end_date:DAY,currency:{code:'USD'},portfolio_tz_name:'America/New_York',include_sales:false,value:1000,
      holdings:[{id:holdingId,portfolio,valid_position:true,instrument,instrument_currency:{code:'USD'},quantity:10,value:900}],
      cash_accounts:[{id:cashId,portfolio,currency:{code:'USD'},value:100}]}}),
    cashAccounts:JSON.stringify({cash_accounts:[{id:cashId,portfolio_id:portfolioId,portfolio_currency:'USD',currency:'USD',date:DAY,balance:100,balance_in_portfolio_currency:100}]}),
    trades:JSON.stringify({trades:[]}),
    cashTransactions:{[cashId]:JSON.stringify({cash_account_transactions:[]})},payouts:{},
  };
  return {role,scope,raw,captureSourceSha256:H(String(n)),validatedInputSha256:H(String(n+3))};
}
function fixture(options={}){
  let now=TIME,originalCalls=0,receiptCalls=0,currentCalls=0;
  const executionId='SYNTH_CYCLE_EXECUTION',validatorDependencyHash=H('a');
  const accounts=['ib-manager','schwab','webull'].map((r,i)=>account(r,i+1));
  const projections=accounts.map(({scope,raw})=>projectSharesightSyncAccount({scope,raw}));
  const history=accounts.map((a,i)=>({role:a.role,through:'2026-06-14',semanticSha256:H(String(i+1))}));
  const plan={schema:'fee-console.report-plan.v2',kind:'daily',periodFrom:DAY,accountingThrough:DAY,priceThrough:DAY,
    scheduledAt:'2026-06-16T09:00:00+08:00',monthlyCutoffs:[],markets:['NASDAQ','NYSE']};
  const bindings={mainSha:'a'.repeat(40),baseDataSha256:H('b'),baseHealthSha256:H('c'),ibBaselineSha256:H('d'),ibCheckpointSha256:H('e'),
    ibCoverageSha256:H('f'),ibAnchorSha256:H('1'),economicVersionSha256:H('2'),benchmarkSha256:H('3'),policySha256:H('4')};
  const request={targetDate:DAY,plan,sourceSet:accounts.map((a,i)=>({role:a.role,identitySha256:hash(projections[i].identity),
    evidenceSha256:projections[i].sourceSha256,fromDate:DAY,sourceDate:DAY})),bindings,
    inputs:{schema:'fee-console.sync-input.v1',cycleId:'SYNTH_CYCLE',accounts,publishedHistory:structuredClone(history)},
    capturedAt:iso(TIME-1000),expiresAt:iso(TIME+60000)};
  const receipt={schema:'fee-console.verified-sync.v1',cycleId:'SYNTH_CYCLE',targetDate:DAY,completedAt:iso(TIME-500),
    accounts:accounts.map((a,i)=>({role:a.role,state:'complete',unresolved:[],projection:structuredClone(projections[i]),captureSourceSha256:a.captureSourceSha256,validatedInputSha256:a.validatedInputSha256})),publishedHistory:structuredClone(history)};
  const current=()=>({executionId,validatorDependencyHash,targetDate:request.targetDate,plan:structuredClone(request.plan),
    sourceSet:structuredClone(request.sourceSet),inputSha256:hash(request.inputs),bindings:structuredClone(request.bindings)});
  const gate=createUnifiedSourceReadiness({executionId,validatorDependencyHash,clock:()=>now,
    verifySynchronization:async c=>{receiptCalls++;return options.receipt?options.receipt(c,receipt):structuredClone(receipt);},
    readCurrentContext:async()=>{currentCalls++;return options.current?options.current(current(),currentCalls):current();},
    validateOriginalSources:async c=>{originalCalls++;if(options.original)return options.original(c);return {schema:'fee-console.prepared-sources.v1',targetDate:c.targetDate,inputSha256:c.inputSha256,calculationInputs:{synthetic:true,sourceSha256:c.inputSha256}};}});
  function updateRaw(index,mutate){
    mutate(request.inputs.accounts[index].raw);
    const {scope,raw}=request.inputs.accounts[index],p=projectSharesightSyncAccount({scope,raw});
    request.sourceSet[index].identitySha256=hash(p.identity);request.sourceSet[index].evidenceSha256=p.sourceSha256;
  }
  return {request,receipt,gate,current,setTime:v=>{now=v;},updateRaw,calls:()=>({originalCalls,receiptCalls,currentCalls})};
}
const rejects=(p,code)=>assert.rejects(p,e=>{assert.equal(syncReadinessFailureCode(e),'FEE_SYNC_READY_'+code);assert(Object.isFrozen(e));return true;});

test('one shared rule function admits complete three-account input and reuses immutable preparation',async()=>{
  const f=fixture();assert.strictEqual(f.gate.validateForSynchronization,f.gate.validateForReport);
  const before=JSON.stringify(f.request),h=await f.gate.validateForSynchronization(f.request);
  const a=await f.gate.consumeForReport(h),b=await f.gate.consumeForReport(h);
  assert.strictEqual(a,b);assert(Object.isFrozen(a.calculationInputs));assert.equal(f.calls().originalCalls,1);
  assert.equal(JSON.stringify(f.request),before);assert.equal(JSON.stringify(h),'{}');
  assert.deepEqual(Object.keys(f.gate).sort(),['consumeForReport','validateForReport','validateForSynchronization']);
});
test('report entry performs the same source and synchronization admission before preparation',async()=>{
  const f=fixture();const h=await f.gate.validateForReport(f.request);await f.gate.consumeForReport(h);
  assert.equal(f.calls().receiptCalls,1);assert.equal(f.calls().originalCalls,1);
});
test('a partial account or unresolved cash item blocks all preparation',async t=>{
  for(const mutate of [r=>r.accounts[0].state='partial',r=>r.accounts[2].unresolved.push('SYNTH_PENDING')])await t.test(String(mutate),async()=>{
    const f=fixture();mutate(f.receipt);await rejects(f.gate.validateForReport(f.request),'SYNC_INCOMPLETE');assert.equal(f.calls().originalCalls,0);
  });
});
test('missing, duplicate and extra roles cannot be interpreted as synchronized',async t=>{
  for(const change of [r=>r.accounts.pop(),r=>r.accounts.push(structuredClone(r.accounts[0])),r=>r.accounts[0].role='webull'])await t.test(String(change),async()=>{
    const f=fixture();change(f.receipt);await rejects(f.gate.validateForReport(f.request),'SCOPE');assert.equal(f.calls().originalCalls,0);
  });
});
test('same total value never hides a changed holding quantity',async()=>{
  const f=fixture();f.updateRaw(1,raw=>{const p=JSON.parse(raw.performance);p.report.holdings[0].quantity=9;raw.performance=JSON.stringify(p);});
  await rejects(f.gate.validateForReport(f.request),'POSITIONS');assert.equal(f.calls().originalCalls,0);
});
test('unchanged USD report never hides changed original cash',async()=>{
  const f=fixture();f.updateRaw(2,raw=>{const c=JSON.parse(raw.cashAccounts);c.cash_accounts[0].balance=99.99;raw.cashAccounts=JSON.stringify(c);});
  await rejects(f.gate.validateForReport(f.request),'NATIVE_CASH');assert.equal(f.calls().originalCalls,0);
});
test('a complete-looking projection with a different source body fails the source binding',async()=>{
  const f=fixture();f.request.inputs.accounts[0].raw.performance+=' ';
  await rejects(f.gate.validateForReport(f.request),'SOURCE_BINDING');
});
test('matching current rows never hide a changed full capture including history or linked payout evidence',async()=>{
  const f=fixture();f.request.inputs.accounts[0].captureSourceSha256=H('9');
  await rejects(f.gate.validateForReport(f.request),'SOURCE_CHANGED');assert.equal(f.calls().originalCalls,0);
});
test('matching raw captures never hide a different validated calculation input',async()=>{
  const f=fixture();f.request.inputs.accounts[0].validatedInputSha256=H('9');
  await rejects(f.gate.validateForReport(f.request),'VALIDATED_INPUT_CHANGED');assert.equal(f.calls().originalCalls,0);
});
test('request text and self-authored success flags cannot stand in for a trusted receipt',async t=>{
  for(const value of ['all synced',true,{matched:true},{schema:'fee-console.verified-sync.v1',approved:true}])await t.test(JSON.stringify(value),async()=>{
    const f=fixture({receipt:()=>value});await rejects(f.gate.validateForReport(f.request),'SYNC_EVIDENCE');
  });
});
test('the accepted history is not silently rebased or corrected',async()=>{
  const f=fixture(),before=JSON.stringify(f.receipt);f.request.inputs.publishedHistory[0].semanticSha256=H('9');
  await rejects(f.gate.validateForReport(f.request),'HISTORY_CHANGED');assert.equal(f.calls().originalCalls,0);assert.equal(JSON.stringify(f.receipt),before);
});
test('missing history and an unbound future history fail closed',async t=>{
  for(const change of [x=>x.pop(),x=>x[0].through='2026-06-16'])await t.test(String(change),async()=>{
    const f=fixture();change(f.request.inputs.publishedHistory);await assert.rejects(f.gate.validateForReport(f.request));assert.equal(f.calls().originalCalls,0);
  });
});
test('the original validators remain mandatory and private failures are not exposed',async t=>{
  for(const original of [()=>false,()=>{throw Error('SYNTH_PRIVATE_ACCOUNT_AMOUNT');},c=>({schema:'fee-console.prepared-sources.v1',targetDate:c.targetDate,inputSha256:H('9'),calculationInputs:{}})])await t.test(String(original),async()=>{
    const f=fixture({original});await rejects(f.gate.validateForReport(f.request),'ORIGINAL_VALIDATION');
  });
});
test('date and cycle identity are real bindings, never replaced with the synchronization day',async t=>{
  for(const mutate of [r=>r.targetDate='2026-06-16',r=>r.cycleId='SYNTH_OTHER'])await t.test(String(mutate),async()=>{
    const f=fixture();mutate(f.receipt);await rejects(f.gate.validateForReport(f.request),'SYNC_EVIDENCE');
  });
  const f=fixture();const h=await f.gate.validateForReport(f.request),r=await f.gate.consumeForReport(h);assert.equal(r.targetDate,DAY);
});
test('a stale or future synchronization receipt is not a new completion signal',async t=>{
  for(const completedAt of [iso(TIME-300001),iso(TIME+1)])await t.test(completedAt,async()=>{
    const f=fixture();f.receipt.completedAt=completedAt;await rejects(f.gate.validateForReport(f.request),'SYNC_EXPIRED');
  });
});
test('current-version checks surround validation and are repeated before report consumption',async t=>{
  for(const driftAt of [1,2,3])await t.test(String(driftAt),async()=>{
    const f=fixture({current:(c,n)=>n===driftAt?{...c,bindings:{...c.bindings,baseDataSha256:H('9')}}:c});
    if(driftAt<3)await rejects(f.gate.validateForReport(f.request),'CURRENT');
    else {const h=await f.gate.validateForReport(f.request);await rejects(f.gate.consumeForReport(h),'CURRENT');}
  });
});
test('expired and serialized handles cannot yield report inputs',async()=>{
  const f=fixture(),h=await f.gate.validateForReport(f.request);
  await rejects(f.gate.consumeForReport(JSON.parse(JSON.stringify(h))),'HANDLE');
  f.setTime(TIME+60000);await rejects(f.gate.consumeForReport(h),'EXPIRED_OR_CHANGED');
});
test('another process-equivalent factory cannot reuse a validation handle',async()=>{
  const a=fixture(),b=fixture(),h=await a.gate.validateForReport(a.request);await rejects(b.gate.consumeForReport(h),'HANDLE');
});
test('unsafe request objects are rejected before accessing or reading evidence',async()=>{
  const f=fixture();let invoked=0;const getter={get inputs(){invoked++;throw Error('SYNTH_SECRET');}};
  await rejects(f.gate.validateForReport(getter),'SCHEMA');
  await rejects(f.gate.validateForReport(new Proxy({}, {ownKeys(){invoked++;return [];}})),'SCHEMA');
  assert.equal(invoked,0);assert.equal(f.calls().receiptCalls,0);
});
test('configuration cannot be selected through request JSON',async()=>{
  const f=fixture();f.request.inputs.approved=true;await rejects(f.gate.validateForReport(f.request),'SCHEMA');
  assert.throws(()=>createUnifiedSourceReadiness({}),e=>syncReadinessFailureCode(e)==='FEE_SYNC_READY_CONFIG');
});
test('malformed top-level requests expose only a fixed safe reason',async t=>{
  for(const request of [null,{},true,[],{targetDate:DAY}])await t.test(JSON.stringify(request),async()=>{
    const f=fixture();await rejects(f.gate.validateForReport(request),'SCHEMA');
    assert.equal(f.calls().receiptCalls,0);assert.equal(f.calls().originalCalls,0);
  });
});

// This composes the real two-account normalizer with the admission gate using
// synthetic catalog evidence. It proves validator reuse, not live source or
// synchronization authentication. IB's actual memory preparation has separate
// original-reader tests; no stub can stand in for that adapter in production.
function normalizeSyntheticAccounts(c,mutate=()=>{}){
  const raw={};
  for(const a of c.inputs.accounts.filter(x=>x.role!=='ib-manager')){
    const p=parseSourceJson(a.raw.performance);
    raw[a.role]={performance:p,holdings:{holdings:p.report.holdings.map(h=>({...h}))},
      cashAccounts:parseSourceJson(a.raw.cashAccounts),trades:parseSourceJson(a.raw.trades),
      cashTransactions:Object.fromEntries(Object.entries(a.raw.cashTransactions).map(([k,v])=>[k,parseSourceJson(v)]))};
  }
  mutate(raw);
  return normalizeRead(raw,c.targetDate,{spy:100,spyd:0,qqq:200,qqqd:0},{sourceMode:'sharesight-reference'});
}
test('the actual original two-account validator composes without replacing its source policy',async()=>{
  const f=fixture({original:c=>({schema:'fee-console.prepared-sources.v1',targetDate:c.targetDate,inputSha256:c.inputSha256,
    calculationInputs:{fee:normalizeSyntheticAccounts(c)}})});
  const h=await f.gate.validateForSynchronization(f.request),r=await f.gate.consumeForReport(h);
  assert.deepEqual(r.calculationInputs.fee.accounts,{schwab:1000,webull:1000});
  assert.equal(r.calculationInputs.fee.sourceReference.cashHistoryReconstructed,false);
  assert.equal(f.calls().originalCalls,1);
});
test('an original source rejection still blocks a matching complete-looking synchronization receipt',async()=>{
  const f=fixture({original:c=>({schema:'fee-console.prepared-sources.v1',targetDate:c.targetDate,inputSha256:c.inputSha256,
    calculationInputs:{fee:normalizeSyntheticAccounts(c,raw=>raw.webull.holdings.holdings[0].portfolio.id=999)}})});
  await rejects(f.gate.validateForReport(f.request),'ORIGINAL_VALIDATION');
});
