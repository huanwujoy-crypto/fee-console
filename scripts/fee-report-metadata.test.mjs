import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {buildFeeCalculationReceipt,canonicalJson} from './fee-receipt-core.mjs';
import {dailyReportPlan,weeklyReportPlan,monthlyReportPlan,reportAddDays} from './fee-report-period.mjs';
import {buildReportMetadata,preserveReportMonthLocks,createFeeReportConsumer,REPORT_METADATA_FAILURE_CODES,reportMetadataFailureCode} from './fee-report-metadata.mjs';
import {writerFailureCode,safeProducerFailureSummary,producerFailureCode} from './fee-cloud-producer.mjs';
import {reportFailureCode} from './fee-report-producer.mjs';
import {reviewedUiStage,reviewedNextUiRegion} from './fee-receipt-ui-contract.test.mjs';

function fixture(through='2026-10-23'){
  const economicInput={v:4,settings:{start:'2026-09-01',mgmt:2,carry:20},accounts:[{id:'schwab',opening:60},{id:'webull',opening:40}],months:[],fees:[]};
  const data={daily:[],flowsAuto:[],flowsUnresolved:[],status:{asOf:through,provisional:false,calibrated:false,unresolvedCount:0}};
  for(let d='2026-09-01';d<=through;d=reportAddDays(d,1))data.daily.push({d,schwab:60,webull:40,bd:d,spy:100,qqq:100,bstate:'session'});
  data.feeCalculationReceipt=buildFeeCalculationReceipt({data,economicInput});return {data,economicInput};
}
test('report metadata binds exact fee receipt and separates source cutoff from generation',async()=>{
  const {data}=fixture(),before=structuredClone(data),plan=weeklyReportPlan('2026-10-23'),generatedAt='2026-10-26T06:00:00Z';
  const m=buildReportMetadata({plan,data,generatedAt}),core=createFeeReportConsumer();
  const view=await core.project(m,{state:'verified',asOf:data.feeCalculationReceipt.asOf},data.feeCalculationReceipt,new Date(generatedAt));
  assert.equal(view.state,'updated');assert.equal(view.kindLabel,'周报');assert.equal(view.priceThrough,'2026-10-23');assert.equal(view.accountingThrough,'2026-10-23');assert.equal(view.nonRealtime,true);assert.deepEqual(data,before);
  assert.equal((await core.project(m,{state:'verified',asOf:plan.accountingThrough},data.feeCalculationReceipt,new Date('2026-10-31T16:00Z'))).state,'pending-update');
  for(const change of [{feeReceiptId:'a'.repeat(64)},{plan:{...plan,priceThrough:'2026-10-26'}},{generatedAt:'2026-10-27T06:00Z'},{reportId:'0'.repeat(64)}])assert.equal((await core.project({...m,...change},{state:'verified',asOf:plan.accountingThrough},data.feeCalculationReceipt,new Date(generatedAt))).state,'pending');
  assert.throws(()=>buildReportMetadata({plan:weeklyReportPlan('2026-10-30'),data,generatedAt}));
  assert.throws(()=>buildReportMetadata({plan,data,generatedAt:'2026-10-24T15:00Z'}));
});
test('reviewed early daily metadata keeps the existing receipt and actual generation time, including the published browser factory',async()=>{
  const target='2026-10-28',clock=new Date('2026-10-29T00:50:00Z'),{data}=fixture(target),before=structuredClone(data);
  const plan=dailyReportPlan(target,['NYSE','NASDAQ'],{periodFrom:'2026-10-24',reviewedSyncDate:target});
  const metadata=buildReportMetadata({plan,data,generatedAt:clock.toISOString()}),view={state:'verified',asOf:target};
  const projected=await createFeeReportConsumer().project(metadata,view,data.feeCalculationReceipt,clock);
  assert.equal(projected.state,'updated');assert.equal(projected.generatedAt,clock.toISOString());
  assert.equal(projected.accountingThrough,target);assert.equal(projected.nextScheduledAt,'2026-10-30T10:30:00+08:00');
  assert.deepEqual(data,before);
  const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8'),a='/* fee-report-consumer:start */',b='/* fee-report-consumer:end */';
  const block=html.slice(html.indexOf(a)+a.length,html.indexOf(b)).trim();
  assert.equal(block,createFeeReportConsumer.toString(),'no new browser contract or UI rollout is required');
  const box={crypto:crypto.webcrypto,TextEncoder,structuredClone};vm.createContext(box);vm.runInContext(block+';globalThis.core=createFeeReportConsumer()',box);
  assert.equal((await box.core.project(metadata,view,data.feeCalculationReceipt,clock)).state,'updated');
  assert.throws(()=>buildReportMetadata({plan:dailyReportPlan(target,['NYSE','NASDAQ']),data,generatedAt:clock.toISOString()}),/^Error: FEE_REPORT_PLAN_NOT_DUE$/);
  assert.throws(()=>buildReportMetadata({plan,data,generatedAt:'2026-10-28T19:00:00Z'}),/^Error: FEE_REPORT_PLAN_NOT_DUE$/);
  assert.equal((await createFeeReportConsumer().project({...metadata,generatedAt:'2026-10-29T01:00:00Z'},view,data.feeCalculationReceipt,clock)).state,'pending');
});
test('final monthly locks reject changed NAV, external-flow history or fee economics; payment remains independent',()=>{
  const {data,economicInput}=fixture('2026-09-30');
  const locks=preserveReportMonthLocks({},data,economicInput,{finalCutoff:'2026-09-30'});
  assert.equal(locks.periods.length,1);
  const old={...data,feeReportMonthLocks:locks},later=fixture('2026-10-23').data;
  assert.deepEqual(preserveReportMonthLocks(old,later,economicInput),locks);
  const paid=structuredClone(economicInput);paid.fees=[{id:'synthetic-payment',date:'2026-10-01',amount:5,ccy:'USD'}];
  later.feeCalculationReceipt=buildFeeCalculationReceipt({data:later,economicInput:paid});
  assert.deepEqual(preserveReportMonthLocks(old,later,paid),locks);
  const changed=structuredClone(later);changed.daily.find(p=>p.d==='2026-09-15').schwab=61;changed.feeCalculationReceipt=buildFeeCalculationReceipt({data:changed,economicInput});
  assert.throws(()=>preserveReportMonthLocks(old,changed,economicInput),/LOCKED_MONTH_CHANGED/);
  const rate=structuredClone(economicInput);rate.settings.mgmt=3;
  assert.throws(()=>preserveReportMonthLocks(old,later,rate),/LOCKED_MONTH_CHANGED/);
  assert.throws(()=>preserveReportMonthLocks({},fixture('2026-09-29').data,economicInput,{finalCutoff:'2026-09-29'}));
  assert.throws(()=>buildReportMetadata({plan:monthlyReportPlan('2026-09'),data,generatedAt:'2026-10-01T00:00Z'}));
});
test('snapshots preserve full daily model and subtract all intervening capital/share changes',()=>{
  const points=[];for(let d='2026-10-23';d<='2026-11-01';d=reportAddDays(d,1))points.push({date:d,investors:[{id:'A',valueCents:10000}]});
  points[1].subscription={investorId:'A',netCents:2000};points[3].shareTransfer={fromInvestorId:'B',toInvestorId:'A',basisCents:500};points[7].investors[0].valueCents=12600;
  const before=structuredClone(points),core=createFeeReportConsumer();
  assert.deepEqual(core.snapshotPoints(points).map(p=>p.date),['2026-10-23','2026-10-30','2026-10-31','2026-11-01']);
  assert.deepEqual(core.snapshotChange(points.slice(0,8),'A'),{valueCents:100,from:'2026-10-23',to:'2026-10-30'});assert.deepEqual(points,before);
  points[3].shareTransfer={fromInvestorId:'A',toInvestorId:'B',basisCents:500};assert.equal(core.snapshotChange(points.slice(0,8),'A').valueCents,1100);
  assert.deepEqual(core.snapshotPoints([...points,points[0]]),[]);
});
test('browser uses the exact shared factory and has no private metadata defaults',async()=>{
  const html=fs.readFileSync(process.env.FEE_LEDGER_TEST_INDEX||new URL('../index.html',import.meta.url),'utf8');
  const stage=reviewedUiStage(html);
  const a='/* fee-report-consumer:start */',b='/* fee-report-consumer:end */';
  assert.equal(html.split(a).length,2);assert.equal(html.split(b).length,2);
  const block=html.slice(html.indexOf(a)+a.length,html.indexOf(b)).trim(),reviewed=reviewedNextUiRegion('fee-report-consumer').trim();
  assert.equal(reviewed,createFeeReportConsumer.toString(),'next metadata factory parity always executes');
  if(stage==='prior')assert.notEqual(block,reviewed);else assert.equal(block,reviewed);
  const box={crypto:crypto.webcrypto,TextEncoder,structuredClone};vm.createContext(box);vm.runInContext(block+';globalThis.core=createFeeReportConsumer()',box);
  const nextBox={crypto:crypto.webcrypto,TextEncoder,structuredClone};vm.createContext(nextBox);vm.runInContext(reviewed+';globalThis.core=createFeeReportConsumer()',nextBox);
  const {data}=fixture(),m=buildReportMetadata({plan:weeklyReportPlan('2026-10-23'),data,generatedAt:'2026-10-26T00:00Z'}),fee={state:'verified',asOf:data.feeCalculationReceipt.asOf};
  assert.deepEqual(JSON.parse(JSON.stringify(await box.core.project(m,fee,data.feeCalculationReceipt,new Date('2026-10-26T00:00Z')))),await createFeeReportConsumer().project(m,fee,data.feeCalculationReceipt,new Date('2026-10-26T00:00Z')));
  assert.deepEqual(JSON.parse(JSON.stringify(await nextBox.core.project(m,fee,data.feeCalculationReceipt,new Date('2026-10-26T00:00Z')))),await createFeeReportConsumer().project(m,fee,data.feeCalculationReceipt,new Date('2026-10-26T00:00Z')));
  const daily=fixture('2026-10-27').data,plan=dailyReportPlan('2026-10-27',['NYSE','LSE'],{periodFrom:'2026-10-24'}),clock=new Date('2026-10-28T06:00:00Z'),metadata=buildReportMetadata({plan,data:daily,generatedAt:clock.toISOString()}),view={state:'verified',asOf:plan.accountingThrough};
  assert.equal((await nextBox.core.project(metadata,view,daily.feeCalculationReceipt,clock)).state,'updated');
  assert.equal((await box.core.project(metadata,view,daily.feeCalculationReceipt,clock)).state,stage==='prior'?'pending':'updated',
    'old weekly contract must not claim compatibility with daily v2 metadata');
});

test('target30 metadata partitions the original rejection predicates without mutating input',()=>{
  const target='2026-10-30',plan=dailyReportPlan(target,['NYSE','NASDAQ'],{reviewedSyncDate:target}),generatedAt='2026-10-31T06:00:00Z';
  const invoke=(data,p=plan)=>buildReportMetadata({plan:p,data,generatedAt});
  const normal=fixture(target),before=structuredClone(normal),metadata=invoke(normal.data);
  assert.equal(metadata.feeReceiptId,normal.data.feeCalculationReceipt.receiptId);assert.equal(metadata.plan.accountingThrough,target);
  assert.equal(metadata.nextScheduledAt,'2026-11-03T10:30:00+08:00');assert.deepEqual(normal,before);
  // Frozen synthetic outputs generated by the exact pre-change main bac02b38.
  const digest=value=>crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
  assert.equal(digest(metadata),'bcab00eb1457bc855179509f687db625d0acbb28a7fbb00770aed22b1c1df413');
  assert.equal(digest(normal.data.feeCalculationReceipt),'e740ff860add22b166146c036b06e3a274ae0d3549ef7917038ad42012dc2f09');
  const sep=fixture('2026-09-30');
  assert.equal(digest(preserveReportMonthLocks({},sep.data,sep.economicInput,{finalCutoff:'2026-09-30'})),'1c1c8b5123a659bbc451585a162b33bc629d8fc0ad517135aae597ca7be33ab2');
  const cases=[
    ['RECEIPT_MISSING',x=>delete x.feeCalculationReceipt],
    ['RECEIPT_MISSING',x=>x.feeCalculationReceipt=null],
    ['RECEIPT_INVALID',x=>x.feeCalculationReceipt.receiptId='0'.repeat(64)],
    ['DAILY_DATE_MISMATCH',x=>{const last=x.daily.pop();x.daily.splice(-1,0,last);} ],
    ['BENCHMARK_DATE_MISMATCH',x=>delete x.daily.at(-1).bd],
    ['BENCHMARK_DATE_MISMATCH',x=>x.daily.at(-1).bd='2026-10-29'],
  ];
  for(const [suffix,mutate] of cases){const {data}=fixture(target);mutate(data);const frozen=structuredClone(data);assert.throws(()=>invoke(data),{message:'FEE_REPORT_'+suffix});assert.deepEqual(data,frozen);}
  assert.throws(()=>invoke(fixture('2026-10-29').data),{message:'FEE_REPORT_RECEIPT_DATE_MISMATCH'});
  assert.throws(()=>invoke(normal.data,{...plan,extra:true}),{message:'FEE_REPORT_PLAN_INPUT_INVALID'});
  assert.throws(()=>buildReportMetadata({plan,data:normal.data,generatedAt:'2026-10-30T12:00:00Z'}),{message:'FEE_REPORT_PLAN_NOT_DUE'});
});

test('month lock diagnostics keep shape, receipt, period and changed-lock gates distinct',()=>{
  const {data,economicInput}=fixture('2026-09-30'),locks=preserveReportMonthLocks({},data,economicInput,{finalCutoff:'2026-09-30'});
  const old={...data,feeReportMonthLocks:locks},later=fixture('2026-10-30').data;
  const cases=[
    ['MONTH_LOCK_SHAPE',x=>x.feeReportMonthLocks=null],
    ['MONTH_LOCK_SHAPE',x=>x.feeReportMonthLocks.extra='PRIVATE_CANARY'],
    ['MONTH_LOCK_ENTRY',x=>delete x.feeReportMonthLocks.periods[0].digest],
    ['MONTH_LOCK_ENTRY',x=>x.feeReportMonthLocks.periods.push({...x.feeReportMonthLocks.periods[0]})],
    ['MONTH_LOCK_PREVIOUS_RECEIPT_MISSING',x=>delete x.feeCalculationReceipt],
    ['MONTH_LOCK_PREVIOUS_RECEIPT_INVALID',x=>x.feeCalculationReceipt.receiptId='0'.repeat(64)],
    ['MONTH_LOCK_PREVIOUS_PERIOD_INVALID',x=>x.feeReportMonthLocks.periods[0].ym='2026-08'],
    ['LOCKED_MONTH_CHANGED',x=>x.feeReportMonthLocks.periods[0].digest='0'.repeat(64)],
  ];
  for(const [suffix,mutate] of cases){const source=structuredClone(old);mutate(source);const frozen=structuredClone(source);assert.throws(()=>preserveReportMonthLocks(source,later,economicInput),{message:'FEE_REPORT_'+suffix});assert.deepEqual(source,frozen);}
  for(const cutoff of ['2026-09-29','not-a-date'])assert.throws(()=>preserveReportMonthLocks({},data,economicInput,{finalCutoff:cutoff}),{message:'FEE_REPORT_MONTH_LOCK_CUTOFF_INVALID'});
  const next=structuredClone(later);delete next.feeCalculationReceipt;
  assert.throws(()=>preserveReportMonthLocks(old,next,economicInput),{message:'FEE_REPORT_MONTH_LOCK_NEXT_RECEIPT_MISSING'});
  const badOld=structuredClone(old);badOld.feeCalculationReceipt.receiptId='0'.repeat(64);
  assert.throws(()=>preserveReportMonthLocks(badOld,next,economicInput),{message:'FEE_REPORT_MONTH_LOCK_PREVIOUS_RECEIPT_INVALID'});
  const missingOld=structuredClone(old);delete missingOld.feeCalculationReceipt;
  assert.throws(()=>preserveReportMonthLocks(missingOld,next,economicInput),{message:'FEE_REPORT_MONTH_LOCK_PREVIOUS_RECEIPT_MISSING'});
  const badNext=structuredClone(later);badNext.feeCalculationReceipt.receiptId='0'.repeat(64);
  assert.throws(()=>preserveReportMonthLocks(old,badNext,economicInput),{message:'FEE_REPORT_MONTH_LOCK_NEXT_RECEIPT_INVALID'});
  assert.throws(()=>preserveReportMonthLocks(old,fixture('2026-09-29').data,economicInput),{message:'FEE_REPORT_MONTH_LOCK_NEXT_PERIOD_INVALID'});
  assert.deepEqual(preserveReportMonthLocks(old,later,economicInput),locks);
});

test('only literal metadata codes survive daily producer period and workflow sanitizers',()=>{
  const hidden='PRIVATE_CANARY amount=123456.78 account=opaque token=secret /private/path';
  assert.equal(new Set(REPORT_METADATA_FAILURE_CODES).size,REPORT_METADATA_FAILURE_CODES.length);
  for(const code of REPORT_METADATA_FAILURE_CODES){
    assert.equal(reportMetadataFailureCode(Error(code)),code);
    const writer=writerFailureCode('error: '+code+' — nothing written\n');
    assert.equal(writer,'FEE_CLOUD_WRITER_'+code.slice(4));
    assert.equal(safeProducerFailureSummary(reportFailureCode(Error(producerFailureCode(Error(writer),'WRITER')))+'\n').code,writer);
    for(const suffix of ['_'+hidden,'\n'+hidden])assert.equal(reportMetadataFailureCode(Error(code+suffix)),'FEE_REPORT_METADATA_INVALID');
  }
  for(const error of [Error(hidden),new TypeError(hidden),Error('FEE_REPORT_PRIVATE_CANARY'),null])assert.equal(reportMetadataFailureCode(error),'FEE_REPORT_METADATA_INVALID');
  assert.equal(writerFailureCode('error: FEE_REPORT_PRIVATE_CANARY — nothing written'),'FEE_CLOUD_WRITER_UNKNOWN');
});

test('normal target30 report plan crosses the real daily argument gate without any data or credential access',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-plan-gate-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const clock=path.join(dir,'clock.mjs');fs.writeFileSync(clock,"const D=Date,n=D.parse('2026-10-31T06:00:00Z');globalThis.Date=class extends D{constructor(...a){super(...(a.length?a:[n]));}static now(){return n;}};globalThis.fetch=()=>{throw Error('NETWORK_FORBIDDEN');};");
  const target='2026-10-30',base=['--date='+target,'--schwab=100','--webull=100','--cash=200','--stock=0','--other=0','--src-schwab='+target,'--src-webull='+target];
  for(const reviewedSyncDate of [null,target]){
    const plan=dailyReportPlan(target,['NYSE','NASDAQ'],{reviewedSyncDate});
    const call=(p,flags=[])=>spawnSync(process.execPath,['--import',clock,new URL('./daily.mjs',import.meta.url).pathname,...base,'--report-plan='+JSON.stringify(p),...flags],{cwd:dir,encoding:'utf8',env:{PATH:process.env.PATH}});
    const result=call(plan);assert.equal(result.status,1);assert.equal(result.stderr.trim(),'error: FEE_DATA_KEY is not set (32-byte base64url key required)');
    for(const [p,flags] of [[{...plan,extra:true},[]],[plan,['--calibrated']],[plan,['--weekend-carry']],[plan,['--style-preflight']]]){
      const denied=call(p,flags);assert.equal(denied.status,1);assert.equal(denied.stderr.trim(),'error: FEE_REPORT_PLAN_INPUT_INVALID — nothing written');
    }
  }
  assert.deepEqual(fs.readdirSync(dir),['clock.mjs']);
});
