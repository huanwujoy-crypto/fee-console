// End-to-end synthetic tests of the future China sync-date gate through the
// real unified readiness gate, real source projection and real consumption
// handle. Synthetic strings only; no network, credential, account file,
// ledger, encrypted payload or writer is read or used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createUnifiedSourceReadiness,syncReadinessFailureCode,syncReadinessMissingEvidence} from './fee-sync-readiness.mjs';
import {projectSharesightSyncAccount} from './fee-sync-source-projection.mjs';
import {sourceContractInputHash as hash} from './fee-source-contract.mjs';
import {createSyncDatePolicyGate,SYNC_DATE_POLICY_SCHEMA,SYNC_DATE_RECEIPT_SCHEMA,SYNC_DATE_CODES,nyCloseInstant,isSyncDatePolicyGate} from './fee-sync-date-policy.mjs';

const DAY='2026-12-01',PREV='2026-11-30',H=c=>c.repeat(64),iso=n=>new Date(n).toISOString();
const AFTER_CLOSE=Date.parse('2026-12-01T22:00:00.000Z'),PRE_CLOSE=Date.parse('2026-12-01T00:30:00.000Z');
const IDS={'ib-manager':[1,'IB-HK'],schwab:[936249,'Schwab-HK'],webull:[1350094,'Webull']};
const broker={originalDate:PREV,reference:'SYNTH-REF'};
// One synthetic account. events: {trades, payouts, cash:[{id,currency,txns}]}.
function account(role,n,{fromDate=DAY,trades=[],payouts=[],cash=null}={}){
  const [portfolioId,name]=IDS[role],portfolio={id:portfolioId,name},hid=n*10;
  const instrument={id:n*1000,code:'SYNTH'+n,market_code:'NYSE',currency_code:'USD'};
  const accounts=cash??[{id:n*100,currency:'USD',balance:100,txns:[]}];
  const raw={
    performance:JSON.stringify({report:{portfolio_id:portfolioId,start_date:DAY,end_date:DAY,currency:{code:'USD'},portfolio_tz_name:'America/New_York',include_sales:false,value:1000,
      holdings:[{id:hid,portfolio,valid_position:true,instrument,instrument_currency:{code:'USD'},quantity:10,value:900}],
      cash_accounts:accounts.map(c=>({id:c.id,portfolio,currency:{code:c.currency},value:c.balance}))}}),
    cashAccounts:JSON.stringify({cash_accounts:accounts.map(c=>({id:c.id,portfolio_id:portfolioId,portfolio_currency:'USD',currency:c.currency,date:DAY,balance:c.balance,balance_in_portfolio_currency:c.balance}))}),
    trades:JSON.stringify({trades:trades.map(t=>({portfolio_id:portfolioId,holding_id:hid,state:'confirmed',instrument,quantity:1,price:10,value:-10,brokerage:0,description_code:'BUY',...t}))}),
    cashTransactions:Object.fromEntries(accounts.map(c=>[c.id,JSON.stringify({cash_account_transactions:c.txns.map(x=>({cash_account_id:c.id,balance:c.balance,trade_id:null,holding_id:null,payout_id:null,description:'',...x}))})])),
    payouts:Object.fromEntries(payouts.map(p=>[p.id,JSON.stringify({portfolio_id:portfolioId,holding_id:hid,currency:'USD',confirmed:true,state:'confirmed',gross_amount:10,resident_withholding_tax:3,amount:7,tax_credit:0,...p})])),
  };
  return {role,scope:{role,portfolioId,name,targetDate:DAY,fromDate},raw,captureSourceSha256:H(String(n)),validatedInputSha256:H(String(n+3))};
}
// Dividend + linked cash, owner transfer-in, a trade + linked cash, and a second
// same-day deposit, all at IB-HK; the other two accounts have no event.
const t0='T00:00:00.000Z';
const ibEvents=()=>({trades:[{id:10,transaction_date:DAY}],payouts:[{id:20,paid_on:DAY}],
  cash:[{id:100,currency:'USD',balance:100,txns:[
    {id:11,date_time:DAY+t0,amount:-10,cash_account_transaction_type:{name:'BUY TRADE'},trade_id:10,holding_id:10},
    {id:21,date_time:DAY+t0,amount:7,cash_account_transaction_type:{name:'PAYOUT'},payout_id:20,holding_id:10},
    {id:30,date_time:DAY+'T05:00:00.000Z',amount:300,cash_account_transaction_type:{name:'DEPOSIT'},description:'Owner cash contribution'},
    {id:31,date_time:DAY+'T06:00:00.000Z',amount:50,cash_account_transaction_type:{name:'DEPOSIT'},description:'Owner cash contribution'}]}]});

// Receipt records as the sync side would declare them from its own read-back.
function declare(projection,role,{entered='2026-12-01T07:20:00+08:00',businessDate=DAY,skip=new Set(),only=null}={}){
  const out=[],add=(kind,e,date)=>{if(date<=PREV||skip.has(kind+'|'+e.id)||only&&!only.has(kind+'|'+e.id))return;
    out.push({role,kind,id:e.id,enteredAt:entered,businessDate,eventSha256:hash(e),broker});};
  for(const t of projection.trades)add('trade',t,t.transactionDate);
  for(const x of projection.payouts)add('payout',x,x.paidOn);
  for(const c of projection.cashEvents)add('cash',c,c.dateTime.slice(0,10));
  return out;
}
const acceptanceOf=p=>({role:p.identity.role,holdingsSha256:hash(p.holdings.map(h=>({id:h.id,instrument:h.instrument,quantity:h.quantity}))),
  cashByCurrency:Object.fromEntries([...new Set(p.cash.map(c=>c.currency))].map(cur=>[cur,hash(p.cash.filter(c=>c.currency===cur).map(c=>({id:c.id,nativeBalance:c.nativeBalance})))])),differences:[]});

function fixture({ib=ibEvents(),through=PREV,cutover=DAY,now=AFTER_CLOSE,gateOptions={},session,noGate=false,mutate}={}){
  const accounts=[account('ib-manager',1,{...ib,fromDate:ib.fromDate??DAY}),account('schwab',2),account('webull',3)];
  const projections=accounts.map(({scope,raw})=>projectSharesightSyncAccount({scope,raw}));
  const history=accounts.map((a,i)=>({role:a.role,through,semanticSha256:H(String(i+1))}));
  const plan={schema:'fee-console.report-plan.v2',kind:'daily',periodFrom:DAY,accountingThrough:DAY,priceThrough:DAY,scheduledAt:'2026-12-02T08:00:00+08:00',monthlyCutoffs:[],markets:['NASDAQ','NYSE']};
  const bindings={mainSha:'a'.repeat(40),baseDataSha256:H('b'),baseHealthSha256:H('c'),ibBaselineSha256:H('d'),ibCheckpointSha256:H('e'),
    ibCoverageSha256:H('f'),ibAnchorSha256:H('1'),economicVersionSha256:H('2'),benchmarkSha256:H('3'),policySha256:H('4')};
  const request={targetDate:DAY,plan,sourceSet:accounts.map((a,i)=>({role:a.role,identitySha256:hash(projections[i].identity),evidenceSha256:projections[i].sourceSha256,fromDate:a.scope.fromDate,sourceDate:DAY})),
    bindings,inputs:{schema:'fee-console.sync-input.v1',cycleId:'SYNTH_CYCLE',accounts,publishedHistory:structuredClone(history)},capturedAt:iso(now-1000),expiresAt:iso(now+60000)};
  const syncSession=session?session(projections):{sessions:[{accountingEffectiveDate:DAY,state:'synced',sessionStartedAt:'2026-12-01T07:05:00+08:00',closedAt:'2026-12-01T07:55:00+08:00',
    records:projections.flatMap(p=>declare(p,p.identity.role))}],acceptance:projections.map(acceptanceOf)};
  const receipt={schema:noGate?'fee-console.verified-sync.v1':SYNC_DATE_RECEIPT_SCHEMA,cycleId:'SYNTH_CYCLE',targetDate:DAY,completedAt:iso(now-500),
    accounts:accounts.map((a,i)=>({role:a.role,state:'complete',unresolved:[],projection:structuredClone(projections[i]),captureSourceSha256:a.captureSourceSha256,validatedInputSha256:a.validatedInputSha256})),
    publishedHistory:structuredClone(history),...(noGate?{}:{syncSession})};
  mutate?.({request,receipt,projections,accounts});
  const current=()=>({executionId:'SYNTH_EXEC',validatorDependencyHash:H('a'),targetDate:request.targetDate,plan:structuredClone(request.plan),
    sourceSet:structuredClone(request.sourceSet),inputSha256:hash(request.inputs),bindings:structuredClone(request.bindings)});
  let originals=0;
  const syncDatePolicy=createSyncDatePolicyGate({policy:{schema:SYNC_DATE_POLICY_SCHEMA,effectiveFromChinaDate:cutover},...gateOptions});
  const gate=createUnifiedSourceReadiness({executionId:'SYNTH_EXEC',validatorDependencyHash:H('a'),clock:()=>now,
    verifySynchronization:async()=>structuredClone(receipt),readCurrentContext:async()=>current(),
    validateOriginalSources:async c=>{originals++;return {schema:'fee-console.prepared-sources.v1',targetDate:c.targetDate,inputSha256:c.inputSha256,calculationInputs:{synthetic:true}};},
    ...(noGate?{}:{syncDatePolicy})});
  return {gate,request,receipt,projections,originals:()=>originals};
}
const code=e=>syncReadinessFailureCode(e);
const refused=async(f,c)=>assert.rejects(f.gate.validateForReport(f.request),e=>{assert.equal(code(e),'FEE_SYNC_READY_SYNC_DATE_'+c);assert.doesNotMatch(e.message,/SYNTH|Owner|\d{4}-\d{2}-\d{2}/);assert.equal(f.originals(),0,'original validation never runs');return true;});

test('disabled by default: no gate, a null cutover, or a target before the cutover keeps the v1 contract',async()=>{
  const plain=fixture({noGate:true});assert.equal((await plain.gate.consumeForReport(await plain.gate.validateForReport(plain.request))).syncDateAdmission,undefined);
  const off=createSyncDatePolicyGate();assert.equal(off.enabled,false);assert.equal(off.appliesTo(DAY),false);
  assert.equal(createSyncDatePolicyGate({policy:{schema:SYNC_DATE_POLICY_SCHEMA,effectiveFromChinaDate:null}}).enabled,false);
  const early=fixture({cutover:'2026-12-02'});
  await assert.rejects(early.gate.validateForReport(early.request),e=>code(e)==='FEE_SYNC_READY_SYNC_EVIDENCE','a v2 receipt is not accepted before the cutover');
  assert.throws(()=>createSyncDatePolicyGate({policy:{schema:'fee-console.sync-date-policy.v0',effectiveFromChinaDate:DAY}}));
  assert.equal(isSyncDatePolicyGate({enabled:true,appliesTo:()=>true,check:async()=>null}),false,'a look-alike gate is never accepted');
  assert.throws(()=>createUnifiedSourceReadiness({executionId:'x',validatorDependencyHash:H('a'),verifySynchronization:async()=>0,validateOriginalSources:async()=>0,readCurrentContext:async()=>0,syncDatePolicy:{enabled:true}}),e=>code(e)==='FEE_SYNC_READY_CONFIG');
});

test('dividend, transfer, trade and two same-day deposits: admitted once with separate dates',async()=>{
  const f=fixture(),h=await f.gate.validateForReport(f.request),p=await f.gate.consumeForReport(h);
  const a=p.syncDateAdmission;
  assert.equal(a.accountingEffectiveDate,DAY);assert.equal(a.lastSyncedEffectiveDate,DAY);
  assert.equal(a.sourceCapturedAt,f.request.capturedAt,'capture instant is its own field');
  assert.deepEqual(a.valuation,{basis:'sharesight-dated-report',valuationDate:DAY,valuationAsOf:null,priceInstantStated:false},'no price instant is claimed');
  assert.deepEqual(a.reportPeriod,{day:DAY,month:'2026-12'},'a 11/30 broker event synced 12/01 belongs to December');
  assert.ok(f.receipt.syncSession.sessions[0].records.every(r=>r.broker.originalDate===PREV),'broker originals kept for audit only');
  assert.equal(f.originals(),1);
});

test('continuation past China midnight keeps earlier records; a later record needs the new date',async()=>{
  const cont=fixture({session:ps=>({sessions:[{accountingEffectiveDate:DAY,state:'synced',sessionStartedAt:'2026-12-01T07:05:00+08:00',closedAt:'2026-12-02T00:20:00+08:00',
    records:ps.flatMap(p=>declare(p,p.identity.role,{entered:'2026-12-01T23:55:00+08:00'}))}],acceptance:ps.map(acceptanceOf)})});
  assert.ok((await cont.gate.consumeForReport(await cont.gate.validateForReport(cont.request))).syncDateAdmission);
  await refused(fixture({session:ps=>({sessions:[{accountingEffectiveDate:DAY,state:'synced',sessionStartedAt:'2026-12-01T07:05:00+08:00',closedAt:'2026-12-02T00:20:00+08:00',
    records:ps.flatMap(p=>declare(p,p.identity.role,{entered:'2026-12-02T00:05:00+08:00'}))}],acceptance:ps.map(acceptanceOf)})}),'AFTER_MIDNIGHT_OLD_DATE');
  await refused(fixture({session:ps=>({sessions:[{accountingEffectiveDate:DAY,state:'synced',sessionStartedAt:'2026-12-01T07:05:00+08:00',closedAt:null,records:[]}],acceptance:ps.map(acceptanceOf)})}),'SESSION_OPEN');
});

test('every new event is declared exactly once and unchanged; keys include account and kind',async()=>{
  await refused(fixture({session:ps=>({sessions:[{accountingEffectiveDate:DAY,state:'synced',sessionStartedAt:'2026-12-01T07:05:00+08:00',closedAt:'2026-12-01T07:55:00+08:00',
    records:ps.flatMap(p=>declare(p,p.identity.role,{skip:new Set(['cash|31'])}))}],acceptance:ps.map(acceptanceOf)})}),'UNDECLARED_EVENT');
  const changed=fixture({mutate:({receipt})=>{receipt.syncSession.sessions[0].records.find(r=>r.id===30).eventSha256=H('9');}});
  await refused(changed,'ID_CONFLICT');
  const dup=fixture({mutate:({receipt})=>{const r=receipt.syncSession.sessions[0].records;r.push({...r[0]});}});
  await refused(dup,'ID_CONFLICT');
  const extra=fixture({mutate:({receipt})=>{receipt.syncSession.sessions[0].records.push({role:'schwab',kind:'cash',id:30,enteredAt:'2026-12-01T07:20:00+08:00',businessDate:DAY,eventSha256:H('8'),broker});}});
  await refused(extra,'RECORD_MISSING');
  // The same numeric id in another account is a different event.
  const ib=ibEvents(),cross=fixture({ib});
  cross.receipt.syncSession.sessions[0].records.forEach(r=>assert.notEqual(r.role+r.kind+r.id,'schwabcash30'));
  assert.ok(await cross.gate.validateForReport(cross.request));
  await refused(fixture({mutate:({receipt})=>{receipt.syncSession.sessions[0].records[0].broker={originalDate:PREV,reference:''};}}),'BROKER_AUDIT_MISSING');
});

test('linked cash is counted once and only with its own trade or payout',async()=>{
  const twoCredits=ibEvents();twoCredits.cash[0].txns.push({id:22,date_time:DAY+t0,amount:7,cash_account_transaction_type:{name:'PAYOUT'},payout_id:20,holding_id:10});
  await refused(fixture({ib:twoCredits}),'LINK_DOUBLE_COUNT');
  const noLeg=ibEvents();noLeg.cash[0].txns=noLeg.cash[0].txns.filter(x=>x.id!==11);
  await refused(fixture({ib:noLeg}),'LINK_MISSING');
});

test('a day without any event still needs every quantity and every native currency',async()=>{
  const quiet=fixture({ib:{},session:ps=>({sessions:[{accountingEffectiveDate:DAY,state:'synced',sessionStartedAt:'2026-12-01T07:05:00+08:00',closedAt:'2026-12-01T07:55:00+08:00',records:[]}],acceptance:ps.map(acceptanceOf)})});
  assert.ok(await quiet.gate.validateForReport(quiet.request));
  for(const [m,c] of [[a=>{a.holdingsSha256=H('7');},'RECONCILIATION_PAUSED'],[a=>{a.cashByCurrency={};},'ACCEPTANCE_INCOMPLETE'],[a=>{a.differences=['cash'];},'RECONCILIATION_PAUSED'],[a=>{a.cashByCurrency.USD=H('6');},'RECONCILIATION_PAUSED']])
    await refused(fixture({ib:{},session:ps=>({sessions:[{accountingEffectiveDate:DAY,state:'synced',sessionStartedAt:'2026-12-01T07:05:00+08:00',closedAt:'2026-12-01T07:55:00+08:00',records:[]}],acceptance:ps.map((p,i)=>{const a=acceptanceOf(p);if(i===0)m(a);return a;})})}),c);
});

test('a non-USD native cash movement keeps the existing stop',async()=>{
  const hkd={cash:[{id:100,currency:'USD',balance:100,txns:[]},{id:101,currency:'HKD',balance:80,txns:[{id:40,date_time:DAY+'T05:00:00.000Z',amount:80,cash_account_transaction_type:{name:'INTEREST'}}]}]};
  await refused(fixture({ib:hkd}),'NON_USD_MOVEMENT_UNSUPPORTED');
});

test('old records keep their dates; a backfill or a changed history stops',async()=>{
  const old={...ibEvents(),fromDate:'2026-11-29'};old.cash[0].txns.push({id:50,date_time:'2026-11-29T05:00:00.000Z',amount:5,cash_account_transaction_type:{name:'DEPOSIT'},description:'Owner cash contribution'});
  const keep=fixture({ib:old});assert.ok(await keep.gate.validateForReport(keep.request),'an already accepted older record is left as it is');
  const back=fixture({ib:old,mutate:({receipt})=>{receipt.syncSession.sessions[0].records.push({role:'ib-manager',kind:'cash',id:50,enteredAt:'2026-12-01T07:20:00+08:00',businessDate:DAY,eventSha256:H('5'),broker});}});
  await refused(back,'BACKFILL_REFUSED');
  const hist=fixture({mutate:({receipt})=>{receipt.publishedHistory[0].semanticSha256=H('0');}});
  await assert.rejects(hist.gate.validateForReport(hist.request),e=>code(e)==='FEE_SYNC_READY_HISTORY_CHANGED');
});

test('skipped days need an explicit closed declaration, and an event on a no-sync day stops',async()=>{
  const gap=fixture({through:'2026-11-29',cutover:'2026-11-30'});
  await refused(gap,'SESSION_MISSING');
  const declared=fixture({through:'2026-11-29',cutover:'2026-11-30',mutate:({receipt})=>{receipt.syncSession.sessions.unshift({accountingEffectiveDate:PREV,state:'no-sync',sessionStartedAt:null,closedAt:null,records:[]});}});
  assert.ok(await declared.gate.validateForReport(declared.request));
  const ev={...ibEvents(),fromDate:'2026-11-30'};ev.cash[0].txns.push({id:60,date_time:'2026-11-30T05:00:00.000Z',amount:5,cash_account_transaction_type:{name:'DEPOSIT'},description:'Owner cash contribution'});
  await refused(fixture({ib:ev,through:'2026-11-29',cutover:'2026-11-30',mutate:({receipt})=>{receipt.syncSession.sessions.unshift({accountingEffectiveDate:PREV,state:'no-sync',sessionStartedAt:null,closedAt:null,records:[]});}}),'UNDECLARED_EVENT');
});

test('the receipt binds the exact captured bytes: a source changed after verification stops',async()=>{
  const f=fixture({mutate:({request,accounts})=>{
    const raw=accounts[0].raw;raw.trades=JSON.stringify(JSON.parse(raw.trades),null,2);
    const p=projectSharesightSyncAccount({scope:accounts[0].scope,raw});request.sourceSet[0].evidenceSha256=p.sourceSha256;}});
  await assert.rejects(f.gate.validateForReport(f.request),e=>code(e)==='FEE_SYNC_READY_SOURCE_CHANGED','formatting is tolerated only at capture; the receipt binds one original');
  const amount=fixture({mutate:({request,accounts})=>{
    const raw=accounts[0].raw;raw.cashTransactions[100]=raw.cashTransactions[100].replace('"amount":300','"amount":301');
    const p=projectSharesightSyncAccount({scope:accounts[0].scope,raw});request.sourceSet[0].evidenceSha256=p.sourceSha256;}});
  await assert.rejects(amount.gate.validateForReport(amount.request),e=>code(e)==='FEE_SYNC_READY_EVENTS');
});

test('before the New York close: WAITING with named missing evidence, never a fabricated valuation',async()=>{
  assert.equal(new Date(nyCloseInstant(DAY)).toISOString(),'2026-12-01T21:00:00.000Z');
  const none=fixture({now:PRE_CLOSE});
  await assert.rejects(none.gate.validateForReport(none.request),e=>{assert.equal(code(e),'FEE_SYNC_READY_SYNC_DATE_WAITING_OFFICIAL_EVIDENCE');
    assert.deepEqual([...syncReadinessMissingEvidence(e)],['effectiveDateQueryAccepted','quantitiesForEffectiveDate','cashByCurrencyForEffectiveDate','valuationInstantStated']);return true;});
  const future=fixture({now:PRE_CLOSE,gateOptions:{readOfficialEvidence:async()=>({effectiveDateQueryAccepted:true,quantitiesForEffectiveDate:true,cashByCurrencyForEffectiveDate:true,valuationInstantStated:'2026-12-01T21:00:00.000Z'})}});
  await assert.rejects(future.gate.validateForReport(future.request),e=>{assert.deepEqual([...syncReadinessMissingEvidence(e)],['valuationInstantStated'],'an unclosed price instant is not evidence');return true;});
  const full=fixture({now:PRE_CLOSE,gateOptions:{readOfficialEvidence:async()=>({effectiveDateQueryAccepted:true,quantitiesForEffectiveDate:true,cashByCurrencyForEffectiveDate:true,valuationInstantStated:'2026-11-30T21:00:00.000Z'})}});
  await assert.rejects(full.gate.validateForReport(full.request),e=>{assert.equal(code(e),'FEE_SYNC_READY_SYNC_DATE_WAITING_WRITER_PRE_CLOSE','the writer path is not implemented');return true;});
  const broken=fixture({now:PRE_CLOSE,gateOptions:{readOfficialEvidence:async()=>{throw Error('SYNTH adapter failure');}}});
  await assert.rejects(broken.gate.validateForReport(broken.request),e=>code(e)==='FEE_SYNC_READY_SYNC_DATE_WAITING_OFFICIAL_EVIDENCE');
});

test('a sync re-read after publication exits; it never becomes a second publication',async()=>{
  let publications=0;const publish=prepared=>{assert.ok(prepared.syncDateAdmission);publications++;};
  const first=fixture();publish(await first.gate.consumeForReport(await first.gate.validateForReport(first.request)));
  const again=fixture({through:DAY});
  await refused(again,'ALREADY_PUBLISHED');
  assert.equal(publications,1);
  assert.deepEqual(SYNC_DATE_CODES.filter(c=>/\d|[a-z]/.test(c)),[],'fixed upper-case codes only');
});
