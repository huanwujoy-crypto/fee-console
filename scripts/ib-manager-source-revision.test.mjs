import test from 'node:test';
import assert from 'node:assert/strict';
import {SharesightIbManagerReader,ibBaselineBusinessHash,IbManagerSourceError} from './ib-manager-source.mjs';
import {buildIbManagerReportBundle,buildIbOwnerBaseline,buildIbManagerReturnReceipt,buildIbManagerDrawdownReceipt,createIbManagerReturnConsumer} from './ib-manager-return.mjs';
import {createIbSourceRevisionPreparer} from './ib-manager-source-revision.mjs';
import {createSourceContractValidator,sourceContractInputHash} from './fee-source-contract.mjs';

// Entirely synthetic input and transport. No network, credentials or files.
const B='2026-09-01',U='2026-09-02',P='2026-09-03',T='2026-09-04';
const h=c=>c.repeat(64),o=c=>c.repeat(40),clock=()=>Date.parse(T+'T12:00:00.000Z');
const core=createIbManagerReturnConsumer();
function wire({revised=false,change=()=>{},unstable=false,early=false}={}){
  const calls=[];let capture=0;
  const fetchImpl=async(url,init)=>{
    const u=new URL(url),p=u.pathname,q=u.searchParams;calls.push({p,q:new URLSearchParams(q),method:init.method});
    assert.equal(u.origin,'https://api.sharesight.com');assert.equal(init.redirect,'error');
    let body;
    if(p==='/oauth2/token'){
      assert.equal(init.method,'POST');capture++;body={access_token:'synthetic-test-access-000000000',token_type:'bearer'};
    }else{
      assert.equal(init.method,'GET');const d=q.get('end_date')||q.get('date');
      const gain=revised?((d>=P?300:0)+(d>=(early?U:P)?7:0)):0;
      if(p==='/api/v2/portfolios.json')body={portfolios:[{id:1,name:'IB-HK',currency_code:'USD'}]};
      else if(p==='/api/v3/portfolios/1/holdings')body={holdings:[{id:2,valid_position:true,portfolio:{id:1,name:'IB-HK'}}]};
      else if(p==='/api/v3/portfolios/1/performance')body={report:{portfolio_id:1,start_date:d,end_date:d,currency:{code:'USD'},portfolio_tz_name:'America/New_York',include_sales:false,value:1000+gain,
        holdings:[{id:2,value:900,quantity:1,valid_position:true,portfolio:{id:1,name:'IB-HK'},instrument_currency:{code:'USD'}}],
        cash_accounts:[{id:3,value:100+gain,currency:{code:'USD'},portfolio:{id:1,name:'IB-HK'}}]}};
      else if(p==='/api/v2/portfolios/1/cash_accounts.json')body={cash_accounts:[{id:3,portfolio_id:1,portfolio_currency:'USD',currency:'USD',date:d,balance:100+gain,balance_in_portfolio_currency:100+gain}]};
      else if(p==='/api/v3/portfolios/1/trades.json')body={trades:[]};
      else if(p==='/api/v2/cash_accounts/3/cash_account_transactions.json'){
        const active=revised&&q.get('from')<=P&&q.get('to')>=P;
        body={cash_account_transactions:active?[
          {id:12,cash_account_id:3,date_time:P+'T00:00:00.000Z',amount:7,balance:107,cash_account_transaction_type:{name:'Payout'},trade_id:null,holding_id:2,payout_id:13},
          {id:14,cash_account_id:3,date_time:P+'T05:00:00.000Z',amount:300,balance:407,cash_account_transaction_type:{name:'DEPOSIT'},description:'Owner cash contribution',trade_id:null,holding_id:null,payout_id:null}
        ]:[]};
      }else if(p==='/api/v2/payouts/13.json')body={id:13,portfolio_id:1,holding_id:2,symbol:'SYNTH',paid_on:P,currency:'USD',confirmed:true,state:'confirmed',non_taxable:false,tax_credit:0,gross_amount:10,resident_withholding_tax:3,amount:7};
      else assert.fail('unexpected synthetic route');
    }
    change(body,{p,q,capture});
    if(unstable&&capture===2&&body.report)body.report.holdings[0].quantity=2;
    const response=new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});Object.defineProperty(response,'url',{value:url});return response;
  };
  return {calls,reader:new SharesightIbManagerReader({clientId:'synthetic-client',clientSecret:'synthetic-secret',fetchImpl})};
}
const payload=b=>({ibManagerReturnReceipt:b.returnReceipt,ibManagerDrawdownReceipt:b.drawdownReceipt,ibManagerSourceState:b.sourceState,ibManagerCoverageState:b.sourceState.source.bootstrapCoverage,feeDataCanary:{untouched:true},consumedOperations:['synthetic-old-failure']});
async function fixture({target=T,transport={},verify,check,read,now=clock}={}){
  const business={points:[{d:B,tot:1000}],openT:1000,from:B,to:B,days:1,flowByDate:{},rate:0,cr:0,cumBefore:0,hwmBefore:0};
  const hash=ibBaselineBusinessHash(business),input={schema:'fee-console.ib-manager-return-input.v1',currency:'USD',timezone:'America/New_York',flowTiming:'eod',flowsComplete:true,correctionsConfirmed:true,sourceSha256:h('c'),periodReturnsInput:business};
  const owner=await buildIbOwnerBaseline({ibManagerReturnReceipt:await buildIbManagerReturnReceipt(input),ibManagerDrawdownReceipt:await buildIbManagerDrawdownReceipt(input)},input,hash);
  const body={schema:'fee-console.ib-manager-coverage.v2',authority:'reviewed-source-reconciliation',sourceProvider:'Sharesight',baselineInputsHash:hash,from:U,through:U,evidenceSha256:h('e'),events:[],quotes:[]};
  const coverage={...body,coverageId:await core.digest(body)},baseline={from:B,asOf:B};
  const a=await wire().reader.readStable({targetDate:U,expectedBaselineHash:hash,baseline,ownerBaseline:owner,bootstrapCoverage:coverage});
  const b=await wire().reader.readStable({targetDate:P,expectedBaselineHash:hash,baseline,checkpoint:a});
  const anchorPayload=payload(await buildIbManagerReportBundle(a,hash)),currentPayload=payload(await buildIbManagerReportBundle(b,hash));
  const artifact=(id,c)=>({dataSha256:h(c),healthSha256:h(c),producerRunId:id,candidateSha:o(c)});
  const plan={schema:'fee-console.ib-source-revision-plan.v1',targetDate:target,anchorDate:U,baselineSha256:hash,
    currentSourceStateId:currentPayload.ibManagerSourceState.stateId,anchorSourceStateId:anchorPayload.ibManagerSourceState.stateId,
    currentArtifact:artifact(2,'a'),anchorArtifact:artifact(1,'b'),bindings:{mainSha:o('a'),economicRevisionSha256:h('d'),consumptionSha256:h('e'),
      baseDataSha256:h('a'),baseHealthSha256:h('a'),currentSourceStateId:currentPayload.ibManagerSourceState.stateId},expiresAt:T+'T12:05:00.000Z'};
  const w=wire({revised:true,...transport});let reads=0,checks=0,artifactChecks=0;
  const api=createIbSourceRevisionPreparer({clock:now,
    verifyAcceptedArtifacts:async args=>{artifactChecks++;return verify?verify(args):structuredClone(args.expected);},
    checkCurrent:async()=>{checks++;return check?check(checks,plan):structuredClone(plan.bindings);},
    readStable:async args=>{reads++;return read?read(args):w.reader.readStable(args);}});
  return {api,plan,currentPayload,anchorPayload,w,counts:()=>({reads,checks,artifactChecks}),run:()=>api.prepare({plan,currentPayload,anchorPayload})};
}
test('rebuilds a private revision from a real synthetic accepted checkpoint with original strict reader',async()=>{
  const f=await fixture(),old=structuredClone(f.currentPayload),anchor=structuredClone(f.anchorPayload),r=await f.run();
  assert.equal(r.mode,'extend-cutoff');assert.deepEqual(r.changedHistoricalDates,[P]);
  assert.equal(r.replacement.returnReceipt.grossTwrPpm,7000);
  assert.deepEqual(r.replacement.sourceState.source.cashFlowByDate,{[P]:300});
  assert.equal(r.replacement.sourceState.source.periodReturnsInput.points.at(-1).tot,1307);
  assert.equal(r.replacement.drawdownReceipt.returnReceiptId,r.replacement.returnReceipt.receiptId);
  assert.deepEqual(r.superseded.sourceState,old.ibManagerSourceState);assert.deepEqual(r.acceptedAnchor.sourceState,anchor.ibManagerSourceState);
  assert.deepEqual(f.currentPayload,old);assert.deepEqual(f.anchorPayload,anchor);assert.equal(r.publicationReady,false);assert.equal(r.executionAuthorized,false);
  assert.ok(Object.isFrozen(r.replacement.sourceState.source));assert.equal(f.counts().reads,1);
  assert.equal(f.w.calls.filter(x=>x.method==='POST').length,2);
  assert.ok(f.w.calls.filter(x=>x.p.endsWith('cash_account_transactions.json')).every(x=>x.q.get('from')===P&&x.q.get('to')===T));
  const {revisionId,...body}=r;assert.equal(revisionId,await core.digest(body));
});
test('same-cutoff revision is distinct from extending a report and never changes fee or consumption data',async()=>{
  const f=await fixture({target:P}),r=await f.run();assert.equal(r.mode,'same-cutoff');assert.equal(r.targetDate,P);
  assert.equal(r.replacement.returnReceipt.grossTwrPpm,7000);assert.deepEqual(f.currentPayload.consumedOperations,['synthetic-old-failure']);
});
test('artifact evidence mismatch and binding changes stop before source reads',async()=>{
  for(const options of [{verify:()=>({verified:true})},{check:()=>({mainSha:o('f')})}]){
    const f=await fixture(options);await assert.rejects(f.run(),/IB_REVISION_(ARTIFACT|BINDINGS)/);assert.equal(f.counts().reads,0);
  }
});
test('invalid receipts, anchors, span and expiry cannot authorize source reads',async t=>{
  for(const [name,change] of [
    ['receipt',f=>f.currentPayload.ibManagerReturnReceipt.grossTwrPpm++],
    ['same anchor',f=>f.plan.anchorDate=P],['earlier target',f=>f.plan.targetDate=U],
    ['unbounded span',f=>f.plan.targetDate='2026-09-20'],['expired',f=>f.plan.expiresAt=T+'T11:59:00.000Z'],
    ['extra authority flag',f=>f.plan.approved=true],['base not bound to artifact',f=>f.plan.bindings.baseDataSha256=h('f')]
  ])await t.test(name,async()=>{const f=await fixture();change(f);await assert.rejects(f.run());assert.equal(f.counts().reads,0);});
});
test('locked historical month requires separate amendment, before fetching',async()=>{
  const f=await fixture();f.currentPayload.feeReportMonthLocks={schema:'fee-console.report-month-locks.v1',periods:[{ym:'2026-09',digest:h('a')}]};
  await assert.rejects(f.run(),/IB_REVISION_MONTH_LOCK/);assert.equal(f.counts().reads,0);
});
test('late changes to dependencies stop a completed read without returning a candidate',async()=>{
  for(const key of ['mainSha','economicRevisionSha256','consumptionSha256','baseDataSha256','baseHealthSha256','currentSourceStateId']){
    const f=await fixture({check:(n,p)=>({...p.bindings,...(n===2?{[key]:key==='mainSha'?o('f'):h('f')}:{})})});
    await assert.rejects(f.run(),/IB_REVISION_BINDINGS/);assert.equal(f.counts().reads,1);
  }
});
test('unchanged and new-target-only sources cannot masquerade as a historical correction',async()=>{
  const f=await fixture({transport:{revised:false}});await assert.rejects(f.run(),/IB_REVISION_NO_HISTORICAL_CHANGE/);
});
test('missing, duplicated, unknown and misdated source events retain original rejection',async t=>{
  for(const [name,change] of [
    ['missing flow',b=>{if(b.cash_account_transactions?.length)b.cash_account_transactions.pop();}],
    ['duplicate',b=>{if(b.cash_account_transactions?.length)b.cash_account_transactions.push(b.cash_account_transactions[0]);}],
    ['unknown',b=>{if(b.cash_account_transactions?.length)b.cash_account_transactions[1].cash_account_transaction_type.name='UNKNOWN';}],
    ['payout date',b=>{if(b.paid_on)b.paid_on=U;}],
    ['payout amount',b=>{if(b.paid_on)b.amount=8;}]
  ])await t.test(name,async()=>{const f=await fixture({transport:{change}});await assert.rejects(f.run(),/^Error: IB_REVISION_SOURCE_REFUSED:IB_SOURCE_[A-Z_]+$/);assert.equal(f.counts().reads,1);});
});
test('changed U and unsupported earlier-valued income are not repaired by deleting a historical check',async()=>{
  const f=await fixture({transport:{early:true}});await assert.rejects(f.run(),/IB_REVISION_SOURCE_REFUSED/);assert.equal(f.counts().reads,1);
});
test('unstable independent source captures still fail closed',async()=>{
  const f=await fixture({transport:{unstable:true}});await assert.rejects(f.run(),/IB_REVISION_SOURCE_REFUSED/);
});
test('even an internally valid source for a different identity cannot become the accepted anchor',async()=>{
  const f=await fixture(),source=structuredClone(f.anchorPayload.ibManagerSourceState.source);
  source.portfolioIdentityHash=h('f');
  Object.assign(f.anchorPayload,payload(await buildIbManagerReportBundle(source,f.plan.baselineSha256)));
  f.plan.anchorSourceStateId=f.anchorPayload.ibManagerSourceState.stateId;
  await assert.rejects(f.run(),/IB_REVISION_PREFIX/);assert.equal(f.counts().reads,0);
});
test('untrusted callback messages are replaced with fixed reason codes',async()=>{
  const secret='SYNTH_PRIVATE_CANARY';
  for(const callback of ['verify','check','read','now']){
    const f=await fixture({[callback]:()=>{throw Error(secret);}});
    await assert.rejects(f.run(),error=>{
      assert.match(error.message,/^IB_REVISION_(REFUSED|SOURCE_REFUSED:IB_SOURCE_[A-Z_]+)$/);
      assert.equal(error.message.includes(secret),false);assert.equal(error.cause,undefined);return true;
    });
    assert.equal(f.counts().reads,callback==='read'?1:0);
  }
});
test('getters, proxies and cyclic requests are refused without executing accessors',async()=>{
  const f=await fixture();let invoked=0;
  const getter={get plan(){invoked++;return f.plan;}},proxy=new Proxy({}, {ownKeys(){invoked++;return [];}}),cyclic={};cyclic.self=cyclic;
  for(const request of [getter,proxy,cyclic])await assert.rejects(f.api.prepare(request),/IB_REVISION_INPUT/);
  assert.equal(invoked,0);assert.equal(f.counts().reads,0);
});
test('mutable source error codes, accessors and proxies cannot escape or run traps',async()=>{
  let invoked=0;const altered=new IbManagerSourceError('NETWORK');altered.code='SYNTH_PRIVATE_CANARY';
  const getter=new IbManagerSourceError('NETWORK');Object.defineProperty(getter,'code',{get(){invoked++;throw Error('SYNTH_PRIVATE_CANARY');}});
  const proxy=new Proxy(new IbManagerSourceError('NETWORK'),{getPrototypeOf(){invoked++;throw Error('SYNTH_PRIVATE_CANARY');}});
  for(const error of [altered,getter,proxy]){
    const f=await fixture({read:()=>{throw error;}});
    await assert.rejects(f.run(),{message:'IB_REVISION_SOURCE_REFUSED:IB_SOURCE_NETWORK'});
  }
  assert.equal(invoked,0);
});
test('clock rollback, post-read expiration and caller mutation cannot produce a candidate',async()=>{
  let tick=0;
  const backwards=await fixture({now:()=>clock()-(tick++?1:0)});
  await assert.rejects(backwards.run(),/IB_REVISION_CLOCK/);assert.equal(backwards.counts().reads,0);
  tick=0;const expired=await fixture({now:()=>clock()+(++tick===3?300000:0)});
  await assert.rejects(expired.run(),/IB_REVISION_EXPIRED/);assert.equal(expired.counts().reads,1);
  let mutated;mutated=await fixture({check:(n,p)=>{if(n===2)mutated.currentPayload.consumedOperations.push('SYNTH_EXTERNAL_CHANGE');return structuredClone(p.bindings);}});
  await assert.rejects(mutated.run(),/IB_REVISION_INPUT_CHANGED/);assert.equal(mutated.counts().reads,1);
});
test('the final asynchronous digest cannot pass expiry or a changed request',async()=>{
  let tick=0;const expired=await fixture({now:()=>clock()+(++tick===4?300000:0)});
  await assert.rejects(expired.run(),/IB_REVISION_EXPIRED/);
  tick=0;let changed;changed=await fixture({now:()=>{
    if(++tick===3)queueMicrotask(()=>{changed.currentPayload.feeDataCanary.untouched=false;});
    return clock();
  }});
  await assert.rejects(changed.run(),/IB_REVISION_INPUT_CHANGED/);
});
test('issued fixed errors cannot be relabelled and recycled by callbacks',async()=>{
  const first=await fixture({verify:()=>null});let issued;
  try{await first.run();assert.fail('expected refusal');}catch(error){issued=error;}
  assert.ok(Object.isFrozen(issued));assert.throws(()=>{issued.message='SYNTH_PRIVATE_CANARY';},TypeError);
  const second=await fixture({verify:()=>{throw issued;}});
  await assert.rejects(second.run(),error=>error.message===issued.message&&!error.message.includes('CANARY'));
});
test('the shared capability reuses an actual rebuilt bundle validator, never the historical revision authority',async()=>{
  const f=await fixture(),revision=await f.run(),inputs={replacement:revision.replacement};
  const plan={schema:'fee-console.report-plan.v2',kind:'daily',periodFrom:P,accountingThrough:T,priceThrough:T,
    scheduledAt:T+'T09:00:00+08:00',monthlyCutoffs:[],markets:['NASDAQ','NYSE']};
  const sourceSet=['ib-manager','schwab','webull'].map((role,i)=>({role,identitySha256:h(String(i+1)),evidenceSha256:h(String(i+4)),fromDate:P,sourceDate:T}));
  const bindings={mainSha:o('a'),baseDataSha256:h('a'),baseHealthSha256:h('b'),ibBaselineSha256:f.plan.baselineSha256,
    ibCheckpointSha256:revision.superseded.sourceState.stateId,ibCoverageSha256:h('c'),ibAnchorSha256:revision.acceptedAnchor.sourceState.stateId,
    economicVersionSha256:h('d'),benchmarkSha256:h('e'),policySha256:h('f')};
  let validations=0;const executionId='SYNTH_REVIEW_ONLY',validatorDependencyHash=h('a');
  const contract=createSourceContractValidator({executionId,validatorDependencyHash,clock,validate:async context=>{
    validations++;const b=context.inputs.replacement;
    const reconstructed=await buildIbManagerReportBundle(b.sourceState.source,context.bindings.ibBaselineSha256);
    assert.deepEqual(b,reconstructed);assert.equal(b.sourceState.source.sourceAsOf,context.targetDate);return true;
  }});
  const request={targetDate:T,plan,sourceSet,bindings,inputs,capturedAt:new Date(clock()-1000).toISOString(),expiresAt:new Date(clock()+60000).toISOString()};
  const handle=await contract.validateInputs(request);
  const current={executionId,validatorDependencyHash,targetDate:T,plan,sourceSet,bindings,inputSha256:sourceContractInputHash(inputs)};
  const validated=contract.consumeValidatedInputs(handle,current);
  assert.deepEqual(validated,inputs);assert.equal(validations,1);assert.ok(Object.isFrozen(validated.replacement.sourceState));
  assert.equal(revision.publicationReady,false);assert.equal(revision.executionAuthorized,false);
  assert.throws(()=>contract.consumeValidatedInputs(handle,{...current,bindings:{...bindings,ibAnchorSha256:h('9')}}),/BINDING_CHANGED/);
  // Other source roles are synthetic scope only. This tests composition of the
  // IB validator; it is not a completed three-account validation or run signal.
});
