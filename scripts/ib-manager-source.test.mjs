import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {nyDate} from './daily-core.mjs';
import {expectedTargetDate} from './fee-cloud-source.mjs';
import {SharesightIbManagerReader,ibBaselineBusinessHash,ibSourceFailureCode,validateIbBootstrapCoverage,validateIbManagerReportInput} from './ib-manager-source.mjs';
import {buildIbManagerReportBundle,validateIbManagerReportState,buildIbOwnerBaseline,validateIbOwnerBaselineState,buildIbManagerReturnReceipt,buildIbManagerDrawdownReceipt,createIbManagerReturnConsumer,createIbManagerDrawdownConsumer} from './ib-manager-return.mjs';
import {prepareIbManagerReport,loadIbManagerReport,sameIbManagerData,validateIbManagerCoverage} from './ib-manager-report.mjs';
import {buildFeeCalculationReceipt,validateFeeCalculationReceipt} from './fee-receipt-core.mjs';

// Synthetic portfolio/holding/cash IDs. No real source, credentials or NAV.
const baseline={from:'2026-08-31',asOf:'2026-09-02'};
const input=()=>({points:[{d:'2026-08-31',tot:100},{d:'2026-09-01',tot:150},{d:'2026-09-02',tot:135}],openT:100,from:baseline.from,to:baseline.asOf,days:3,flowByDate:{'2026-09-01':50},rate:0,cr:0,cumBefore:0,hwmBefore:0});
const lock=()=>ibBaselineBusinessHash(input());
const add=d=>new Date(Date.parse(d+'T00:00:00Z')+86400000).toISOString().slice(0,10);
function wire({mutate=()=>{},changeSecond=false}={}){
  const calls=[];let capture=0;
  const fetchImpl=async(url,init)=>{
    calls.push({url,method:init.method});const u=new URL(url),p=u.pathname,q=u.searchParams;let body;
    assert.equal(u.origin,'https://api.sharesight.com');assert.equal(init.redirect,'error');
    if(p==='/oauth2/token'){capture++;assert.equal(init.method,'POST');assert.match(init.body,/grant_type=client_credentials/);body={access_token:'synthetic-access-token-123456',token_type:'bearer'};}
    else{
      assert.equal(init.method,'GET');assert.equal(init.headers.Authorization,'Bearer synthetic-access-token-123456');
      if(p==='/api/v2/portfolios.json')body={portfolios:[{id:1,name:'IB-HK',currency_code:'USD'}]};
      else if(p==='/api/v3/portfolios/1/holdings')body={holdings:[{id:2,valid_position:true,portfolio:{id:1,name:'IB-HK'}}]};
      else if(p==='/api/v3/portfolios/1/performance'){
        const d=q.get('end_date');assert.equal(q.get('start_date'),d);
        const value=d<'2026-09-02'?100:d==='2026-09-02'?85:86;
        const cash=d<'2026-09-01'?0:50;
        body={report:{portfolio_id:1,start_date:d,end_date:d,currency:{code:'USD'},portfolio_tz_name:'America/New_York',include_sales:false,value:value+cash,
          holdings:[{id:2,value,quantity:1,valid_position:true,portfolio:{id:1,name:'IB-HK'},instrument_currency:{code:'USD'}}],cash_accounts:[{id:3,value:cash,currency:{code:'USD'},portfolio:{id:1,name:'IB-HK'}}]}};
      }else if(p==='/api/v2/portfolios/1/cash_accounts.json')body={cash_accounts:[{id:3,portfolio_id:1,portfolio_currency:'USD',currency:'USD',date:q.get('date'),balance:50,balance_in_portfolio_currency:50}]};
      else if(p==='/api/v3/portfolios/1/trades.json')body={trades:[]};
      else if(p==='/api/v2/cash_accounts/3/cash_account_transactions.json')body={cash_account_transactions:q.get('from')<='2026-09-01'?[{id:4,cash_account_id:3,date_time:'2026-09-01T12:00:00Z',amount:50,balance:50,cash_account_transaction_type:{name:'DEPOSIT'},description:'Owner cash contribution'}]:[]};
      else if(p==='/api/v2/cash_accounts/5/cash_account_transactions.json')body={cash_account_transactions:[]};
      else assert.fail('unexpected route '+p);
    }
    mutate(body,{p,q,capture});
    if(changeSecond&&capture===2&&body.report)body.report.unstableMarker=true;
    const response=new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});Object.defineProperty(response,'url',{value:url});return response;
  };
  return {calls,reader:new SharesightIbManagerReader({clientId:'synthetic-client',clientSecret:'synthetic-secret',fetchImpl})};
}
const read=(w,extra={})=>w.reader.readStable({targetDate:baseline.asOf,expectedBaselineHash:lock(),baseline,...extra});
const source=async()=>read(wire());
async function frozenFixture(){
  const frozen={schema:'fee-console.ib-manager-return-input.v1',currency:'USD',timezone:'America/New_York',flowTiming:'eod',flowsComplete:true,correctionsConfirmed:true,sourceSha256:'c'.repeat(64),periodReturnsInput:input()};
  const payload={ibManagerReturnReceipt:await buildIbManagerReturnReceipt(frozen),ibManagerDrawdownReceipt:await buildIbManagerDrawdownReceipt(frozen)};
  return {frozen,payload,state:await buildIbOwnerBaseline(payload,frozen,lock())};
}
test('owner-confirmed baseline retains corrected history and appends only reconciled native days',async()=>{
  const {payload,state}=await frozenFixture();payload.ibManagerBaselineState=state;
  assert.deepEqual(await validateIbOwnerBaselineState(payload,lock()),state);
  const w=wire(),s=await read(w,{targetDate:'2026-09-03',ownerBaseline:state});
  assert.equal(s.schema,'fee-console.ib-manager-source.v2');assert.deepEqual(s.periodReturnsInput.points.slice(0,3),input().points);assert.deepEqual(s.ownerBaseline,state);
  assert.equal(w.calls.filter(c=>c.url.includes('/performance?')).length,4); // opening + new day, twice
  const bundle=await buildIbManagerReportBundle(s,lock());assert.equal(bundle.returnReceipt.asOf,'2026-09-03');
  const out={...payload,ibManagerReturnReceipt:bundle.returnReceipt,ibManagerDrawdownReceipt:bundle.drawdownReceipt,ibManagerSourceState:bundle.sourceState};
  assert.deepEqual(await validateIbManagerReportState(out,lock()),s);
  assert.deepEqual((await read(wire(),{targetDate:'2026-09-03',checkpoint:s})).periodReturnsInput,s.periodReturnsInput);
});
test('future normal handoff needs finite audited coverage as well as authenticated history, before any source read',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ib-coverage-synthetic-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const points=[];for(let d='2026-08-01';d<='2026-10-23';d=add(d))points.push({d,tot:136});
  const frozen={schema:'fee-console.ib-manager-return-input.v1',currency:'USD',timezone:'America/New_York',flowTiming:'eod',flowsComplete:true,correctionsConfirmed:true,sourceSha256:'c'.repeat(64),periodReturnsInput:{points,openT:136,from:'2026-08-01',to:'2026-10-23',days:points.length,flowByDate:{},rate:0,cr:0,cumBefore:0,hwmBefore:0}};
  const payload={ibManagerReturnReceipt:await buildIbManagerReturnReceipt(frozen),ibManagerDrawdownReceipt:await buildIbManagerDrawdownReceipt(frozen)},expectedHash=ibBaselineBusinessHash(frozen.periodReturnsInput);
  payload.ibManagerBaselineState=await buildIbOwnerBaseline(payload,frozen,expectedHash);
  const body={schema:'fee-console.ib-manager-coverage.v1',authority:'reviewed-source-reconciliation',baselineInputsHash:expectedHash,from:'2026-10-24',through:'2026-10-30',evidenceSha256:'e'.repeat(64)},coverage={...body,coverageId:await createIbManagerReturnConsumer().digest(body)};
  const environ={IB_MANAGER_READ_ENABLED:'true',IB_MANAGER_BASELINE_SHA256:expectedHash};let calls=0;
  let prep=await prepareIbManagerReport({payload,targetDate:'2026-10-24',outputDir:dir,environ,reader:{readStable(){calls++;assert.fail('known migration coverage must hold');}}});
  assert.equal(prep.reasonCode,'IB_SOURCE_COVERAGE_UNVERIFIED');assert.equal(calls,0);fs.unlinkSync(prep.file);
  for(const mutate of [x=>x.through='2026-10-23',x=>x.through='2026-11-30',x=>x.coverageId='a'.repeat(64),x=>x.baselineInputsHash='a'.repeat(64),x=>x.authority='approved=true',x=>x.extra=true]){
    const bad=structuredClone(coverage);mutate(bad);await assert.rejects(validateIbManagerCoverage(bad,'2026-10-24',expectedHash),/COVERAGE_UNVERIFIED/);
  }
  await assert.rejects(validateIbManagerCoverage(coverage,'2026-10-31',expectedHash),/COVERAGE_UNVERIFIED/);
  await assert.rejects(validateIbManagerCoverage(coverage,'2026-10-30',expectedHash,'2026-10-23'),/COVERAGE_UNVERIFIED/);
  payload.ibManagerCoverageState=coverage;const w=wire();
  prep=await prepareIbManagerReport({payload,targetDate:'2026-10-24',outputDir:dir,environ,reader:w.reader});assert.equal(prep.state,'verified');assert.equal(w.calls.filter(x=>x.url.includes('/performance?')).length,4);
  const request=await loadIbManagerReport(prep.file,{environ});assert.equal(typeof request.apply,'function');assert.equal(payload.ibManagerReturnReceipt.asOf,'2026-10-23');
  const absent=structuredClone(payload);delete absent.ibManagerCoverageState;assert.throws(()=>request.apply(absent,'2026-10-24'),/REFUSED/);
  const raw=fs.readFileSync(prep.file),tampered=JSON.parse(raw);delete tampered.coverage;fs.writeFileSync(prep.file,JSON.stringify(tampered));
  await assert.rejects(loadIbManagerReport(prep.file,{environ}),/REFUSED/);fs.writeFileSync(prep.file,raw);
});
test('baseline digest is not approval; original receipts, full correction and anchor are mandatory',async()=>{
  const {frozen,payload,state}=await frozenFixture(),bad=structuredClone(frozen);bad.periodReturnsInput.points[0].tot++;
  await assert.rejects(buildIbOwnerBaseline(payload,bad,ibBaselineBusinessHash(bad.periodReturnsInput)),/BASELINE_MISMATCH/);
  for(const mutate of [x=>x.input.periodReturnsInput.points[0].tot++,x=>x.stateId='b'.repeat(64),x=>x.input.correctionsConfirmed=false]){
    const copy=structuredClone(state);mutate(copy);await assert.rejects(read(wire(),{targetDate:'2026-09-03',ownerBaseline:copy}),/STATE|BASELINE/);
  }
  const forged=structuredClone(state);forged.returnReceiptId='d'.repeat(64);const {stateId,...body}=forged;forged.stateId=await createIbManagerReturnConsumer().digest(body);
  await assert.rejects(validateIbOwnerBaselineState({...payload,ibManagerBaselineState:forged},lock()),/STATE_INVALID/);
  const changed=wire({mutate:b=>{if(b.report?.end_date==='2026-09-02'){b.report.holdings[0].value++;b.report.value++;}}});
  await assert.rejects(read(changed,{targetDate:'2026-09-03',ownerBaseline:state}),/PAST_POINT_CHANGED/);
  const over=wire();await assert.rejects(read(over,{targetDate:'2026-09-20',ownerBaseline:state}),/HISTORY_LIMIT/);assert.equal(over.calls.length,0);
});

test('first normal report can prove a finite bootstrap boundary then extend to its final target without publishing the boundary',async t=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ib-boundary-synthetic-')));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const points=[];for(let d='2026-08-01';d<='2026-10-23';d=add(d))points.push({d,tot:136});
  const frozen={schema:'fee-console.ib-manager-return-input.v1',currency:'USD',timezone:'America/New_York',flowTiming:'eod',flowsComplete:true,correctionsConfirmed:true,sourceSha256:'c'.repeat(64),periodReturnsInput:{points,openT:136,from:'2026-08-01',to:'2026-10-23',days:points.length,flowByDate:{},rate:0,cr:0,cumBefore:0,hwmBefore:0}};
  const payload={ibManagerReturnReceipt:await buildIbManagerReturnReceipt(frozen),ibManagerDrawdownReceipt:await buildIbManagerDrawdownReceipt(frozen)},expectedHash=ibBaselineBusinessHash(frozen.periodReturnsInput);
  payload.ibManagerBaselineState=await buildIbOwnerBaseline(payload,frozen,expectedHash);
  const body={schema:'fee-console.ib-manager-coverage.v2',authority:'reviewed-source-reconciliation',sourceProvider:'Sharesight',baselineInputsHash:expectedHash,from:'2026-10-24',through:'2026-10-24',evidenceSha256:'e'.repeat(64),events:[],quotes:[]};
  payload.ibManagerCoverageState={...body,coverageId:await createIbManagerReturnConsumer().digest(body)};
  const environ={IB_MANAGER_READ_ENABLED:'true',IB_MANAGER_BASELINE_SHA256:expectedHash},w=wire(),before=structuredClone(payload),targets=[];
  const reader={readStable(args){targets.push(args.targetDate);return w.reader.readStable(args);}};
  const prepared=await prepareIbManagerReport({payload,targetDate:'2026-10-25',outputDir:dir,environ,reader});assert.equal(prepared.state,'verified');assert.deepEqual(targets,['2026-10-24','2026-10-25']);
  const request=JSON.parse(fs.readFileSync(prepared.file));assert.equal(request.targetDate,'2026-10-25');assert.equal(request.source.sourceAsOf,'2026-10-25');assert.deepEqual(request.coverage,payload.ibManagerCoverageState);assert.deepEqual(payload,before);
  assert.equal(w.calls.filter(x=>x.url.includes('/performance?')).length,8);assert.equal((await loadIbManagerReport(prepared.file,{environ})).checkCurrent(),undefined);
  fs.unlinkSync(prepared.file);targets.length=0;
  const failed=await prepareIbManagerReport({payload,targetDate:'2026-10-25',outputDir:dir,environ,reader:{async readStable(args){targets.push(args.targetDate);if(args.targetDate==='2026-10-25')throw Error('private-canary');return w.reader.readStable(args);}}});
  assert.equal(failed.state,'pending');assert.deepEqual(payload,before);assert.ok(!fs.readFileSync(failed.file,'utf8').includes('private-canary'));assert.deepEqual(targets,['2026-10-24','2026-10-25']);
});
test('owner baseline preserves original correction precision without downgrading or recertifying old native history',async()=>{
  const {frozen}=await frozenFixture();frozen.periodReturnsInput.points[0].tot=103.456;
  const expectedHash=ibBaselineBusinessHash(frozen.periodReturnsInput),payload={ibManagerReturnReceipt:await buildIbManagerReturnReceipt(frozen),ibManagerDrawdownReceipt:await buildIbManagerDrawdownReceipt(frozen)},state=await buildIbOwnerBaseline(payload,frozen,expectedHash);
  const s=await read(wire(),{targetDate:'2026-09-03',ownerBaseline:state,expectedBaselineHash:expectedHash});
  assert.equal(s.periodReturnsInput.points[0].tot,103.456);assert.equal(s.ownerBaseline.authority,'owner-confirmed-frozen');await buildIbManagerReportBundle(s,expectedHash);
  const edited=structuredClone(s);edited.periodReturnsInput.points[0].tot+=.0001;
  assert.equal(ibBaselineBusinessHash(edited.periodReturnsInput,baseline.asOf),expectedHash);
  await assert.rejects(buildIbManagerReportBundle(edited,expectedHash),/BASELINE_MISMATCH/);
});
test('native future transfer needs typed settlement evidence; a comment or unexplained loss refuses',async()=>{
  const {state}=await frozenFixture(),instrument={id:7,code:'SYNTH',market_code:'NYSE',currency_code:'USD'};
  const make=(code='TRANSFER_OUT',quantity=.5)=>wire({mutate:(b,{q})=>{
    if(b.holdings)b.holdings[0].instrument=instrument;
    if(b.report){const h=b.report.holdings[0];h.instrument=instrument;if(b.report.end_date==='2026-09-03'){h.quantity=quantity;h.value=86*quantity;b.report.value=h.value+50;}}
    if(b.trades)b.trades=[{id:8,portfolio_id:1,holding_id:2,state:'confirmed',transaction_date:'2026-09-03',description_code:code,quantity:.5,value:0,price:0,brokerage:0,instrument,comments:'transfer'}];
  }});
  const s=await read(make(),{targetDate:'2026-09-03',ownerBaseline:state});assert.equal(s.noncashProofs[0].authority,'source-native-transfer');assert.equal(s.periodReturnsInput.flowByDate['2026-09-03'],-43);
  const bundle=await buildIbManagerReportBundle(s,lock());assert.ok(Math.abs(bundle.drawdownReceipt.dailyFactors.at(-1).factor-136/135)<1e-12);
  await assert.rejects(read(make('SELL'),{targetDate:'2026-09-03',ownerBaseline:state}),/UNVERIFIED_TRANSFER/);
  await assert.rejects(read(make('TRANSFER_OUT',0),{targetDate:'2026-09-03',ownerBaseline:state}),/UNVERIFIED_TRANSFER|NONCASH_EVIDENCE/);
  const tampered=structuredClone(s);tampered.noncashProofs[0].authority='audited-baseline-source-native';await assert.rejects(buildIbManagerReportBundle(tampered,lock()),/NONCASH_EVIDENCE/);
});

test('normal read is narrowly scoped, double-read, cent-normalized and baseline locked',async()=>{
  const w=wire(),s=await read(w);assert.deepEqual(s.periodReturnsInput,input());
  assert.equal(w.calls.filter(c=>c.method==='POST').length,2);
  assert.equal(w.calls.filter(c=>c.url.includes('/performance?')).length,8);
  assert.ok(w.calls.every(c=>c.method==='GET'||c.url.endsWith('/oauth2/token')));
  assert.equal(ibBaselineBusinessHash({...input(),flowByDate:{'2026-09-02':0,'2026-09-01':50}}),lock());
  const reversed=input();reversed.points.reverse();assert.equal(ibBaselineBusinessHash(reversed),lock());
  const bad=wire();await assert.rejects(read(bad,{expectedBaselineHash:''}),/BASELINE_LOCK/);assert.equal(bad.calls.length,0);
  await assert.rejects(read(wire(),{expectedBaselineHash:'a'.repeat(64)}),/BASELINE_MISMATCH/);
  const subcent=structuredClone(s);subcent.periodReturnsInput.points[0].tot+=.0001;
  assert.equal(ibBaselineBusinessHash(subcent.periodReturnsInput),lock());
  await assert.rejects(buildIbManagerReportBundle(subcent,lock()),/AMOUNT/);
});
test('scope, transport and dates fail closed without fallback grants or date guessing',async()=>{
  const cases=[
    [b=>{if(b.portfolios)b.portfolios=[];},'SCOPE'],
    [b=>{if(b.portfolios)b.portfolios.push({...b.portfolios[0],id:5});},'SCOPE'],
    [b=>{if(b.portfolios)b.portfolios[0].currency_code='HKD';},'SCOPE'],
    [b=>{if(b.report)b.report.portfolio_id=9;},'IDENTITY'],
    [b=>{if(b.report)b.report.end_date='2026-08-01';},'IDENTITY'],
    [b=>{if(b.report)b.report.complete=false;},'INCOMPLETE'],
    [b=>{if(b.report)b.report.value++;},'AMOUNT'],
    [b=>{if(b.cash_account_transactions?.length)b.cash_account_transactions[0].date_time='2026-09-01T00:00:00Z';},'DATE_ALIGNMENT'],
    [b=>{if(b.cash_account_transactions?.length)b.cash_account_transactions[0].amount='private-canary';},'AMOUNT'],
    [b=>{if(b.holdings)b.links={next:'https://other.invalid'};},'INCOMPLETE'],
  ];
  for(const[mutate,code]of cases)await assert.rejects(read(wire({mutate})),e=>{assert.equal(e.message,'IB_SOURCE_'+code);assert.doesNotMatch(e.message,/private-canary/);return true;});
  const denied=new SharesightIbManagerReader({clientId:'synthetic',clientSecret:'synthetic',fetchImpl:async()=>{throw Error('secret-canary');}});
  await assert.rejects(denied.readStable({targetDate:baseline.asOf,expectedBaselineHash:lock(),baseline}),e=>{assert.equal(ibSourceFailureCode(e),'IB_SOURCE_NETWORK');return true;});
});
test('missing cash, unbalanced ledger and ambiguous automatic cash never become profits or flows',async()=>{
  for(const mutate of [
    b=>{if(b.cash_account_transactions)b.cash_account_transactions=[];},
    b=>{if(b.cash_account_transactions?.length)b.cash_account_transactions[0].balance=40;},
    b=>{if(b.cash_account_transactions?.length)b.cash_account_transactions[0].description='AUTOMATIC SELL settlement';},
    b=>{if(b.cash_account_transactions?.length)b.cash_account_transactions[0].description='Payout from company';},
    b=>{if(b.cash_account_transactions?.length)b.cash_account_transactions[0].description='';},
    b=>{if(b.cash_account_transactions?.length)b.cash_account_transactions[0].cash_account_transaction_type.name='UNKNOWN';},
    b=>{if(b.cash_account_transactions?.length)b.cash_account_transactions[0].trade_id=99;},
    b=>{if(b.report)b.report.cash_accounts[0].currency.code='HKD';},
  ])await assert.rejects(read(wire({mutate})),/IB_SOURCE_(CASH_RECONCILIATION|UNRESOLVED_FLOW|IDENTITY|UNSUPPORTED_CURRENCY)/);
});
test('two snapshots must agree in business evidence; an unrelated field is not a change',async()=>{
  assert.deepEqual((await read(wire({changeSecond:true}))).periodReturnsInput,input());
  await assert.rejects(read(wire({mutate:(b,{capture})=>{if(capture===2&&b.cash_account_transactions?.length)b.cash_account_transactions[0].description+=' changed';}})),/UNSTABLE/);
});
test('audited native-date securities outflow is independent of cash and cannot become a mechanical loss',async()=>{
  const instrument={id:7,code:'SYNTH',market_code:'NYSE',currency_code:'USD'};
  const make=()=>wire({mutate:(b,{q})=>{
    if(b.holdings)b.holdings[0].instrument=instrument;
    if(b.report){const d=b.report.end_date,h=b.report.holdings[0];h.instrument=instrument;h.quantity=d<'2026-09-01'?2:1;h.value=d<'2026-09-01'?100:d==='2026-09-01'?50:45;b.report.cash_accounts[0].value=0;b.report.value=h.value;}
    if(b.cash_accounts){b.cash_accounts[0].balance=0;b.cash_accounts[0].balance_in_portfolio_currency=0;}
    if(b.cash_account_transactions)b.cash_account_transactions=[];
    if(b.trades)b.trades=q.get('start_date')<='2026-09-01'?[{id:8,portfolio_id:1,holding_id:2,state:'confirmed',transaction_date:'2026-09-01',description_code:'SELL',quantity:1,value:0,price:0,brokerage:0,instrument}]:[];
  }});
  const expected=input();expected.points[1].tot=50;expected.points[2].tot=45;expected.flowByDate['2026-09-01']=-50;
  const expectedBaselineHash=ibBaselineBusinessHash(expected),s=await read(make(),{expectedBaselineHash});
  assert.deepEqual(s.periodReturnsInput,expected);assert.deepEqual(s.cashFlowByDate,{});assert.equal(s.noncashProofs.length,1);
  const b=await buildIbManagerReportBundle(s,expectedBaselineHash);assert.deepEqual(b.drawdownReceipt.dailyFactors.map(p=>p.factor),[1,1,.9]);
  await assert.rejects(read(make()),/BASELINE_MISMATCH/);
  const again=await read(make(),{expectedBaselineHash,checkpoint:s});assert.deepEqual(again.noncashProofs,s.noncashProofs);assert.deepEqual(again.periodReturnsInput,s.periodReturnsInput);
  const bad=structuredClone(s);bad.noncashProofs.push(bad.noncashProofs[0]);await assert.rejects(buildIbManagerReportBundle(bad,expectedBaselineHash),/NONCASH_EVIDENCE/);
});
test('persisted checkpoint appends daily history, binds identity and detects changed prior valuation',async()=>{
  const initial=await source(),w=wire();
  const next=await read(w,{targetDate:'2026-09-03',checkpoint:initial});
  assert.equal(next.periodReturnsInput.points.length,4);assert.deepEqual(next.periodReturnsInput.points.slice(0,3),input().points);
  assert.equal(w.calls.filter(c=>c.url.includes('/performance?')).length,4);
  const repeated=await read(wire(),{targetDate:'2026-09-03',checkpoint:next});assert.deepEqual(repeated,next);
  const changed=wire({mutate:b=>{if(b.report?.end_date==='2026-09-02'){b.report.holdings[0].value++;b.report.value++;}}});
  await assert.rejects(read(changed,{targetDate:'2026-09-03',checkpoint:initial}),/PAST_POINT_CHANGED/);
  const bad=structuredClone(initial);bad.portfolioIdentityHash='b'.repeat(64);await assert.rejects(read(wire(),{targetDate:'2026-09-03',checkpoint:bad}),/IDENTITY/);
  const cap=wire();await assert.rejects(read(cap,{targetDate:'2026-09-20',checkpoint:initial}),/HISTORY_LIMIT/);assert.equal(cap.calls.length,0);
  const transfer=wire({mutate:b=>{if(b.trades)b.trades=[{id:9,portfolio_id:1,holding_id:2,state:'confirmed',transaction_date:'2026-09-03',description_code:'SELL',quantity:1,value:1,comments:'in-kind transfer'}];}});
  await assert.rejects(read(transfer,{targetDate:'2026-09-03',checkpoint:initial}),/UNVERIFIED_TRANSFER/);
  const invisible=wire({mutate:b=>{if(b.report?.end_date==='2026-09-03')b.report.holdings[0].quantity=.5;}});
  await assert.rejects(read(invisible,{targetDate:'2026-09-03',checkpoint:initial}),/UNVERIFIED_TRANSFER/);
});
test('source receipts bind TWR and daily drawdown; raw source stays only in private checkpoint',async()=>{
  const s=await source(),b=await buildIbManagerReportBundle(s,lock()),core=createIbManagerReturnConsumer(),fee={state:'verified',start:baseline.from,asOf:baseline.asOf,periods:b.returnReceipt.periods};
  const status={state:'verified',targetDate:baseline.asOf};
  assert.equal(b.returnReceipt.schema,core.dailySchema);assert.equal((await core.project(b.returnReceipt,fee,status)).value,-.1);
  assert.deepEqual(b.drawdownReceipt.dailyFactors.map(p=>p.factor),[1,1,.9]);
  assert.equal((await createIbManagerDrawdownConsumer().project(b.drawdownReceipt,b.returnReceipt,fee,status)).state,'verified');
  for(const bad of [undefined,{state:'pending'},{state:'verified',targetDate:'2026-09-03'}])assert.equal((await core.project(b.returnReceipt,fee,bad)).value,null);
  assert.doesNotMatch(JSON.stringify([b.returnReceipt,b.drawdownReceipt]),/openT|flowByDate|quantity|portfolioId|"tot"|"amount"/);
  const payload={ibManagerReturnReceipt:b.returnReceipt,ibManagerDrawdownReceipt:b.drawdownReceipt,ibManagerSourceState:b.sourceState};
  assert.deepEqual(await validateIbManagerReportState(payload,lock()),s);
  payload.ibManagerSourceState.source.periodReturnsInput.points[0].tot++;await assert.rejects(validateIbManagerReportState(payload,lock()),/STATE_INVALID/);
});
function feeData(){const i=input(),economicInput={v:4,settings:{start:i.from,mgmt:2,carry:20,fx:{USD:1}},accounts:[{id:'schwab',opening:60},{id:'webull',opening:40}],months:[],fees:[]};
  const data={daily:i.points.map(p=>({d:p.d,schwab:60,webull:40})),flowsAuto:[],flowsUnresolved:[],status:{asOf:i.to,provisional:false,calibrated:true,unresolvedCount:0}};data.feeCalculationReceipt=buildFeeCalculationReceipt({data,economicInput});return data;}
test('normal handoff preserves fee accounts, amounts and receipt; pending suppresses stale IB',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ib-source-synthetic-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const environ={IB_MANAGER_READ_ENABLED:'true',IB_MANAGER_BASELINE_SHA256:lock()},data=feeData(),original=structuredClone(data),s=await source();
  let calls=0;const prep=await prepareIbManagerReport({payload:data,targetDate:baseline.asOf,outputDir:dir,environ,reader:{async readStable(){calls++;return s;}}});assert.equal(calls,1);assert.equal(prep.state,'verified');
  const loaded=await loadIbManagerReport(prep.file,{environ}),out=loaded.apply(data,baseline.asOf);assert.equal(out.ibManagerSourceStatus.state,'verified');assert.deepEqual(data,original);
  const rest={...out};for(const k of ['ibManagerReturnReceipt','ibManagerDrawdownReceipt','ibManagerSourceState','ibManagerSourceStatus'])delete rest[k];assert.deepEqual(rest,data);assert.equal(validateFeeCalculationReceipt(data.feeCalculationReceipt,out).ok,true);
  assert.equal(sameIbManagerData(data,out),false);assert.equal(sameIbManagerData(out,structuredClone(out)),true);
  fs.unlinkSync(prep.file);const failed=await prepareIbManagerReport({payload:out,targetDate:baseline.asOf,outputDir:dir,environ,reader:{async readStable(){throw Error('private-account-canary');}}});assert.deepEqual({state:failed.state,code:failed.reasonCode},{state:'pending',code:'IB_SOURCE_NETWORK'});
  const pending=(await loadIbManagerReport(failed.file,{environ})).apply(out,baseline.asOf);assert.deepEqual(pending.ibManagerReturnReceipt,out.ibManagerReturnReceipt);assert.equal(pending.ibManagerSourceStatus.state,'pending');assert.equal((await createIbManagerReturnConsumer().project(pending.ibManagerReturnReceipt,{state:'verified',...pending.feeCalculationReceipt},pending.ibManagerSourceStatus)).value,null);
  fs.appendFileSync(failed.file,' ');assert.throws(loaded.checkCurrent,/REFUSED/);
});
test('disabled path performs no read or file write; missing lock does not use credentials',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ib-source-disabled-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let calls=0;
  const args={payload:feeData(),targetDate:baseline.asOf,outputDir:dir,reader:{async readStable(){calls++;throw Error();}}};
  assert.equal(await prepareIbManagerReport({...args,environ:{}}),null);assert.deepEqual(fs.readdirSync(dir),[]);
  const result=await prepareIbManagerReport({...args,environ:{IB_MANAGER_READ_ENABLED:'true'}});assert.equal(result.reasonCode,'IB_SOURCE_BASELINE_LOCK');assert.equal(calls,0);
  fs.chmodSync(result.file,0o644);await assert.rejects(loadIbManagerReport(result.file,{environ:{IB_MANAGER_READ_ENABLED:'true'}}),/REFUSED/);
});

test('real normal daily CLI encrypts independent IB only, preserves fees and repeats as byte no-op',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ib-daily-synthetic-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const key=crypto.randomBytes(32),target=[nyDate(new Date()),'2026-10-23'].sort()[0],file=path.join(dir,'data.json'),econFile=path.join(dir,'econ.json');
  const encrypt=(data,v=3)=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);return JSON.stringify({enc:true,v,data:Buffer.concat([iv,c.update(JSON.stringify(data)),c.final(),c.getAuthTag()]).toString('base64')});};
  const decrypt=()=>{const b=Buffer.from(JSON.parse(fs.readFileSync(file)).data,'base64'),d=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(-16));return JSON.parse(Buffer.concat([d.update(b.subarray(12,-16)),d.final()]));};
  const data=feeData();for(let d=add(baseline.asOf);d<=target;d=add(d))data.daily.push({d,schwab:60,webull:40});data.status={asOf:target,provisional:false,calibrated:true,unresolvedCount:0,splitDelta:0,notes:[]};
  fs.writeFileSync(file,encrypt(data));fs.writeFileSync(econFile,encrypt({v:4,settings:{start:baseline.from,mgmt:2,carry:20,fx:{USD:1}},accounts:[{id:'schwab',opening:60},{id:'webull',opening:40}],months:[],fees:[]},4),{mode:0o600});
  const environ={...process.env,FEE_DATA_KEY:key.toString('base64url'),FEE_ECON_FILE:econFile,FEE_STYLE_INPUT_FILE:'',FEE_MANAGEMENT_INPUT_FILE:'',IB_MANAGER_READ_ENABLED:'true',IB_MANAGER_BASELINE_SHA256:lock()};
  const cli=[new URL('./daily.mjs',import.meta.url).pathname,`--file=${file}`,`--date=${target}`,'--schwab=60','--webull=40',`--src-schwab=${target}`,`--src-webull=${target}`,'--cash=0','--stock=100','--other=0'];
  const run=extra=>spawnSync(process.execPath,[...cli,...extra],{encoding:'utf8',env:environ});
  const ordinary=run([]);assert.equal(ordinary.status,0,ordinary.stderr);const before=decrypt();
  const s=await source();for(let d=add(baseline.asOf);d<=target;d=add(d))s.periodReturnsInput.points.push({d,tot:135});s.periodReturnsInput.to=target;s.sourceAsOf=target;s.periodReturnsInput.days=s.periodReturnsInput.points.length;
  const prepared=await prepareIbManagerReport({payload:before,targetDate:target,outputDir:dir,environ,reader:{async readStable(){return s;}}});
  const result=run([`--ib-manager-input=${prepared.file}`]);assert.equal(result.status,0,result.stderr);const out=decrypt();assert.equal(out.ibManagerSourceStatus.state,'verified');assert.deepEqual(out.feeCalculationReceipt,before.feeCalculationReceipt);
  const strip=o=>Object.fromEntries(Object.entries(o).filter(([k])=>!k.startsWith('ibManager')&&k!=='updatedAt'));assert.deepEqual(strip(out),strip(before));
  const bytes=fs.readFileSync(file),repeat=run([`--ib-manager-input=${prepared.file}`]);assert.equal(repeat.status,0,repeat.stderr);assert.match(repeat.stdout,/no-op/);assert.deepEqual(fs.readFileSync(file),bytes);
  const refused=spawnSync(process.execPath,[...cli,`--ib-manager-input=${prepared.file}`],{encoding:'utf8',env:{...environ,IB_MANAGER_READ_ENABLED:''}});assert.notEqual(refused.status,0);assert.deepEqual(fs.readFileSync(file),bytes);
  fs.unlinkSync(prepared.file);const pending=await prepareIbManagerReport({payload:out,targetDate:target,outputDir:dir,environ,reader:{async readStable(){throw Error('private-canary');}}});
  const p=run([`--ib-manager-input=${pending.file}`]);assert.equal(p.status,0,p.stderr);const after=decrypt();assert.equal(after.ibManagerSourceStatus.state,'pending');assert.deepEqual(after.feeCalculationReceipt,before.feeCalculationReceipt);assert.deepEqual(after.ibManagerReturnReceipt,out.ibManagerReturnReceipt);
});

test('normal producer validates synthetic encrypted IB candidate through the existing reporter and health path',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ib-producer-synthetic-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const root=path.join(dir,'checkout');fs.mkdirSync(root,{mode:0o700});fs.cpSync(new URL('.',import.meta.url),path.join(root,'scripts'),{recursive:true});
  fs.mkdirSync(path.join(root,'claude'));fs.copyFileSync(new URL('../claude/fee-style-mapping.json',import.meta.url),path.join(root,'claude/fee-style-mapping.json'));
  const target=[expectedTargetDate(new Date()),'2026-10-23'].sort()[0],key=crypto.randomBytes(32);
  const encrypt=(o,v)=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);return JSON.stringify({enc:true,v,data:Buffer.concat([iv,c.update(JSON.stringify(o)),c.final(),c.getAuthTag()]).toString('base64')});};
  const data=feeData();for(let d=add(baseline.asOf);d<=target;d=add(d))data.daily.push({d,schwab:60,webull:40});
  Object.assign(data.status,{asOf:target,notes:[],splitDelta:0});for(const p of data.daily)Object.assign(p,{cash:100,stock:0,other:0,spy:100,qqq:100,acctCash:{schwab:60,webull:40}});
  const original=encrypt(data,3);fs.writeFileSync(path.join(root,'data.json'),original);
  const econ=path.join(dir,'econ.json');fs.writeFileSync(econ,encrypt({v:4,settings:{start:baseline.from,mgmt:2,carry:20,fx:{USD:1}},accounts:[{id:'schwab',opening:60},{id:'webull',opening:40}],months:[],fees:[]},4),{mode:0o600});
  const cache=path.join(dir,'benchmark.json');fs.writeFileSync(cache,JSON.stringify({v:1,benchmarks:{spy: {symbol:'SPY',currency:'USD',exchange:'NYSEArca',series:[{d:target,p:100}]},qqq: {symbol:'QQQ',currency:'USD',exchange:'NasdaqGS',series:[{d:target,p:100}]}}}));
  const s=await source();for(let d=add(baseline.asOf);d<=target;d=add(d))s.periodReturnsInput.points.push({d,tot:135});s.sourceAsOf=target;s.periodReturnsInput.to=target;s.periodReturnsInput.days=s.periodReturnsInput.points.length;
  const ibFile=path.join(dir,'synthetic-source.json');fs.writeFileSync(ibFile,JSON.stringify(s),{mode:0o600});
  const script=path.join(root,'exercise.mjs');fs.writeFileSync(script,`
    import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import assert from 'node:assert/strict';
    import {produce} from './scripts/fee-cloud-producer.mjs';import {STYLE_ACCOUNTS} from './scripts/fee-style-registry.mjs';
    const source=JSON.parse(fs.readFileSync(process.env.SYNTHETIC_IB_FILE)),target=source.sourceAsOf,dir=path.dirname(process.env.SYNTHETIC_IB_FILE),key=Buffer.from(process.env.FEE_DATA_KEY,'base64url');
    const decode=file=>{const b=Buffer.from(JSON.parse(fs.readFileSync(file)).data,'base64'),d=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(-16));return JSON.parse(Buffer.concat([d.update(b.subarray(12,-16)),d.final()]));};
    let ibReads=0,feeReads=0,cleanups=0;const results=[],checkedAt=new Date().toISOString();
    for(const enabled of [false,true]){
      process.env.IB_MANAGER_READ_ENABLED=enabled?'true':'';const output=path.join(dir,enabled?'enabled':'disabled');fs.mkdirSync(output,{mode:0o700});
      const result=await produce({cli:{'benchmark-file':process.env.SYNTHETIC_CACHE,'target-date':target,'out-dir':output,'checked-at':checkedAt},
        fetchEconomic:async()=>({envelopeVersion:4,sourcePath:process.env.FEE_ECON_FILE,async checkCurrent(){},cleanup(){cleanups++;}}),
        ibReader:{async readStable(){ibReads++;return structuredClone(source);}},
        reader:{async readStable(_target,benchmark){feeReads++;return {targetDate:target,accounts:{schwab:60,webull:40},splits:{cash:100,stock:0,other:0},acctCash:{schwab:60,webull:40},prevAcctCash:{schwab:60,webull:40},sourceDates:{schwab:target,webull:target},benchmark:{...benchmark,sourceDate:target,state:'session'},sourceFingerprint:'a'.repeat(64),flows:[],styleInput:{schemaVersion:1,date:target,portfolios:Object.entries(STYLE_ACCOUNTS).map(([account,portfolioId])=>({account,portfolioId,sourceDate:target,stockTotalUsd:0,holdings:[]})),proposals:[]}};}}});
      results.push(decode(result.dataFile));assert.equal(fs.existsSync(path.join(output,'ib-manager-input.json')),false);assert.equal(fs.existsSync(result.healthFile),true);
    }
    assert.equal(ibReads,1);assert.equal(feeReads,2);assert.equal(cleanups,2);assert.equal(results[1].ibManagerSourceStatus.state,'verified');assert.deepEqual(results[1].feeCalculationReceipt,results[0].feeCalculationReceipt);
    const strip=o=>Object.fromEntries(Object.entries(o).filter(([k])=>!k.startsWith('ibManager')&&k!=='updatedAt'));assert.deepEqual(strip(results[0]),strip(results[1]));
    console.log('SYNTHETIC_NORMAL_PRODUCER_VERIFIED');
  `);
  const result=spawnSync(process.execPath,[script],{encoding:'utf8',env:{...process.env,FEE_DATA_KEY:key.toString('base64url'),FEE_ECON_FILE:econ,FEE_STYLE_INPUT_FILE:'',FEE_MANAGEMENT_INPUT_FILE:'',IB_MANAGER_READ_ENABLED:'',IB_MANAGER_BASELINE_SHA256:lock(),SYNTHETIC_IB_FILE:ibFile,SYNTHETIC_CACHE:cache},timeout:20000});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/SYNTHETIC_NORMAL_PRODUCER_VERIFIED/);assert.equal(fs.readFileSync(path.join(root,'data.json'),'utf8'),original);
});

// A reported in-transit migration cannot be proved complete by two identical
// stale snapshots. This independent hold must never fail the fee composite.
test('post-baseline coverage hold performs no IB read and preserves original fee report',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ib-coverage-synthetic-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let calls=0;const environ={IB_MANAGER_READ_ENABLED:'true',IB_MANAGER_BASELINE_SHA256:lock()},data=feeData(),before=structuredClone(data);
  const request=await prepareIbManagerReport({payload:data,targetDate:'2026-10-26',outputDir:dir,environ,reader:{async readStable(){calls++;throw Error('must not read');}}});
  assert.equal(calls,0);assert.equal(request.reasonCode,'IB_SOURCE_COVERAGE_UNVERIFIED');
  const result=(await loadIbManagerReport(request.file,{environ})).apply(data,'2026-10-26');
  assert.deepEqual(result.feeCalculationReceipt,data.feeCalculationReceipt);assert.deepEqual(data,before);assert.equal(result.ibManagerSourceStatus.state,'pending');
});

test('source-native checkpoint extends beyond its one-time bootstrap audit without reusing an old period',async()=>{
  const {state}=await frozenFixture(),body={schema:'fee-console.ib-manager-coverage.v2',authority:'reviewed-source-reconciliation',sourceProvider:'Sharesight',baselineInputsHash:lock(),from:'2026-09-03',through:'2026-09-03',evidenceSha256:'e'.repeat(64),events:[],quotes:[]},coverage={...body,coverageId:await createIbManagerReturnConsumer().digest(body)};
  validateIbBootstrapCoverage(coverage,lock(),{baselineAsOf:baseline.asOf});
  const first=await read(wire(),{targetDate:'2026-09-03',ownerBaseline:state,bootstrapCoverage:coverage});assert.equal(first.schema,'fee-console.ib-manager-source.v3');assert.equal(first.closingSnapshots.length,2);
  const next=await read(wire(),{targetDate:'2026-09-04',checkpoint:first});assert.equal(next.sourceAsOf,'2026-09-04');assert.deepEqual(next.bootstrapCoverage,coverage);assert.equal(next.periodReturnsInput.to,'2026-09-04');await buildIbManagerReportBundle(next,lock());
  const moved=wire({mutate:(b,{q})=>{if(b.report)b.report.holdings[0].quantity=2;}});
  await assert.rejects(read(moved,{targetDate:'2026-09-04',checkpoint:first}),/PAST_POINT_CHANGED/);
  for(const mutate of [x=>x.sourceProvider='Broker',x=>x.through='2026-09-12',x=>x.coverageId='a'.repeat(64),x=>x.from='2026-09-02',x=>x.quotes=[{}]]){const bad=structuredClone(coverage);mutate(bad);assert.throws(()=>validateIbBootstrapCoverage(bad,lock(),{baselineAsOf:baseline.asOf}));}
  const bad=structuredClone(first);bad.closingSnapshots[0].totalCents++;assert.throws(()=>validateIbManagerReportInput(bad,lock()),/STATE/);
  const skipped=wire();await assert.rejects(read(skipped,{targetDate:'2026-09-04',ownerBaseline:state,bootstrapCoverage:coverage}),/STATE/);assert.equal(skipped.calls.length,0);
});

import {attachIbBootstrap} from './fee-ratio-packet.mjs';

test('existing encrypted carrier seeds confirmed IB history and finite source audit without changing returns or fee fields',async()=>{
  const {frozen,payload}=await frozenFixture(),before={...payload,feeCalculationReceipt:{synthetic:'unchanged'},other:{synthetic:'unchanged'}},body={schema:'fee-console.ib-manager-coverage.v2',authority:'reviewed-source-reconciliation',sourceProvider:'Sharesight',baselineInputsHash:lock(),from:'2026-09-03',through:'2026-09-03',evidenceSha256:'e'.repeat(64),events:[],quotes:[]},coverage={...body,coverageId:await createIbManagerReturnConsumer().digest(body)};
  const after=await attachIbBootstrap(before,frozen,coverage),{ibManagerBaselineState,ibManagerCoverageState,...rest}=after;assert.deepEqual(rest,before);assert.equal(ibManagerBaselineState.authority,'owner-confirmed-frozen');assert.deepEqual(ibManagerCoverageState,coverage);
  await assert.rejects(attachIbBootstrap(after,frozen,coverage));const edited=structuredClone(frozen);edited.periodReturnsInput.points[0].tot++;await assert.rejects(attachIbBootstrap(before,edited,coverage));await assert.rejects(attachIbBootstrap(before,frozen,{...coverage,sourceProvider:'Broker'}));
});

function cadWire(extra=()=>{}){return wire({mutate(body,context){const {p,q}=context,d=q.get('end_date')||q.get('date');if(body.report){const value=d<'2026-09-02'?10:11;body.report.cash_accounts.push({id:5,value,currency:{code:'CAD'},portfolio:{id:1,name:'IB-HK'}});body.report.value+=value;}if(p==='/api/v2/portfolios/1/cash_accounts.json'){body.cash_accounts[0].balance=body.cash_accounts[0].balance_in_portfolio_currency=d<'2026-09-01'?0:50;body.cash_accounts.push({id:5,portfolio_id:1,portfolio_currency:'USD',currency:'CAD',date:d,balance:200,balance_in_portfolio_currency:d<'2026-09-02'?10:11});}extra(body,context);}});}
const cadBusiness=()=>({points:[{d:'2026-08-31',tot:110},{d:'2026-09-01',tot:160},{d:'2026-09-02',tot:146}],openT:110,from:baseline.from,to:baseline.asOf,days:3,flowByDate:{'2026-09-01':50},rate:0,cr:0,cumBefore:0,hwmBefore:0});
test('unchanged CAD native cash uses dated USD valuations, treats only its FX repricing as NAV return and never creates an external CAD flow',async()=>{const w=cadWire(),expected=ibBaselineBusinessHash(cadBusiness()),s=await w.reader.readStable({targetDate:baseline.asOf,baseline,expectedBaselineHash:expected});assert.deepEqual(s.periodReturnsInput,cadBusiness());assert.deepEqual(s.cashFlowByDate,{'2026-09-01':50});assert.ok(w.calls.some(c=>c.url.includes('cash_accounts.json?date=2026-08-30')));assert.ok((await buildIbManagerReportBundle(s,expected)).returnReceipt);});
test('CAD native movement, missing dated balance, wrong FX valuation and changed currency cannot be silently converted or ignored',async()=>{const expected=ibBaselineBusinessHash(cadBusiness());for(const change of [(b,{p,q})=>{if(b.cash_accounts&&p.includes('/portfolios/')&&q.get('date')==='2026-09-01')b.cash_accounts.find(c=>c.id===5).balance=201;},(b,{p})=>{if(p==='/api/v2/cash_accounts/5/cash_account_transactions.json')b.cash_account_transactions.push({id:80,cash_account_id:5,date_time:'2026-09-01T12:00:00Z',amount:1,balance:201,cash_account_transaction_type:{name:'DEPOSIT'}});},(b,{p})=>{if(b.cash_accounts&&p.includes('/portfolios/'))b.cash_accounts.find(c=>c.id===5).balance_in_portfolio_currency=99;},(b,{p})=>{if(b.cash_accounts&&p.includes('/portfolios/'))b.cash_accounts.find(c=>c.id===5).currency='EUR';}])await assert.rejects(cadWire(change).reader.readStable({targetDate:baseline.asOf,baseline,expectedBaselineHash:expected}),/IB_SOURCE_(UNSUPPORTED_CURRENCY|CASH_RECONCILIATION)/);});
test('CAD native balances are carried and revalidated in an authenticated future checkpoint without changing the frozen baseline',async()=>{const business=cadBusiness(),expected=ibBaselineBusinessHash(business),frozen={schema:'fee-console.ib-manager-return-input.v1',currency:'USD',timezone:'America/New_York',flowTiming:'eod',flowsComplete:true,correctionsConfirmed:true,sourceSha256:'f'.repeat(64),periodReturnsInput:business};const payload={ibManagerReturnReceipt:await buildIbManagerReturnReceipt(frozen),ibManagerDrawdownReceipt:await buildIbManagerDrawdownReceipt(frozen)};const owner=await buildIbOwnerBaseline(payload,frozen,expected),body={schema:'fee-console.ib-manager-coverage.v2',authority:'reviewed-source-reconciliation',sourceProvider:'Sharesight',baselineInputsHash:expected,from:'2026-09-03',through:'2026-09-03',evidenceSha256:'e'.repeat(64),events:[],quotes:[]},coverage={...body,coverageId:await createIbManagerReturnConsumer().digest(body)};const first=await cadWire().reader.readStable({targetDate:'2026-09-03',baseline,expectedBaselineHash:expected,ownerBaseline:owner,bootstrapCoverage:coverage});assert.equal(first.closingSnapshots[0].nativeCash[5],20000);assert.equal(first.closingSnapshots[1].cashCurrency[5],'CAD');const second=await cadWire().reader.readStable({targetDate:'2026-09-04',baseline,expectedBaselineHash:expected,checkpoint:first});assert.equal(second.closingSnapshots[0].nativeCash[5],20000);assert.deepEqual(second.periodReturnsInput.points.slice(0,3),business.points);const bad=structuredClone(first);bad.closingSnapshots[0].nativeCash[5]++;await assert.rejects(cadWire().reader.readStable({targetDate:'2026-09-04',baseline,expectedBaselineHash:expected,checkpoint:bad}),/IB_SOURCE_(STATE|PAST_POINT_CHANGED)/);});
