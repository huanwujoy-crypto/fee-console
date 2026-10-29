import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {buildFeeCalculationReceipt} from './fee-receipt-core.mjs';
import {dailyReportPlan,weeklyReportPlan,monthlyReportPlan,reportAddDays} from './fee-report-period.mjs';
import {buildReportMetadata,preserveReportMonthLocks,createFeeReportConsumer} from './fee-report-metadata.mjs';
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
  assert.throws(()=>buildReportMetadata({plan:dailyReportPlan(target,['NYSE','NASDAQ']),data,generatedAt:clock.toISOString()}),/METADATA_INVALID/);
  assert.throws(()=>buildReportMetadata({plan,data,generatedAt:'2026-10-28T19:00:00Z'}),/METADATA_INVALID/);
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
