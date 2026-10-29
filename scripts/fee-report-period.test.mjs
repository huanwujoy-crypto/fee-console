import './fee-market-calendar.test.mjs';
test('daily v2 binds the real capture range, markets and deferred month lock without a separate monthly production',()=>{
 const p=dailyReportPlan('2026-11-02',['NYSE','LSE','SIX','EURONEXT_PARIS'],{periodFrom:'2026-10-31'});
 assert.equal(validateReportPlan(p),true);assert.equal(p.kind,'daily-monthly');assert.deepEqual(p.monthlyCutoffs,['2026-10-31']);assert.equal(p.scheduledAt,'2026-11-03T10:30:00+08:00');
 assert.equal(reportPlanReadiness(p,new Date('2026-11-03T10:30:00+08:00')).reasonCode,'ACCOUNTING_DAY_NOT_COMPLETE');assert.equal(reportPlanReadiness(p,new Date('2026-11-03T13:00:00+08:00')).state,'due');
 for(const change of [x=>x.markets.push('EURONEXT'),x=>x.priceThrough='2026-10-30',x=>x.monthlyCutoffs=[],x=>x.scheduledAt='2026-11-03T10:00:00+08:00']){const b=structuredClone(p);change(b);assert.equal(validateReportPlan(b),false);}
});
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {dailyReportPlan,weeklyReportPlan,monthlyReportPlan,coalesceReportPlans,validateReportPlan,reportPlanReadiness,reportPlansAround,reportWindowDates,reportSessionOpen,reportAddDays,isReviewedDailyPlan} from './fee-report-period.mjs';
import {marketOpen} from '../cloud/xuan-preopen/calendar.mjs';

test('standalone NYSE calendar exactly matches existing reviewed calendar for every supported date',()=>{
  for(let d='2026-01-01';d<='2028-12-31';d=reportAddDays(d,1))assert.equal(reportSessionOpen(d),marketOpen(d,'NYSE'),d);
});
test('actual job gates keep legacy automated dispatch and unaccepted cadence stopped',()=>{
  const file=fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml',import.meta.url),'utf8');
  const expression=file.slice(file.indexOf('  period:')).match(/if:\s*\$\{\{([\s\S]*?)\}\}/)[1];
  const evaluate=Function('github','inputs','vars','return ('+expression+');');
  for(const event of ['schedule','workflow_dispatch','push'])for(const enabled of [undefined,'false','true'])for(const run of [false,true])for(const mode of [undefined,'publish','shadow','paused']){
    const actual=evaluate({event_name:event},{run_reviewed_once:run},{FEE_REPORT_PERIODS_ENABLED:enabled,FEE_CLOUD_MODE:mode});
    const expected=['publish','shadow'].includes(mode)&&((event==='schedule'&&enabled==='true')||(event==='workflow_dispatch'&&run));
    assert.equal(actual,expected,JSON.stringify({event,enabled,run,mode}));
  }
  const promote=fs.readFileSync(new URL('../.github/workflows/promote-fee-data.yml',import.meta.url),'utf8');
  const gate=Function('github','vars','return ('+promote.match(/if:\s*>-\s*\$\{\{([\s\S]*?)\}\}/)[1]+');');
  assert.equal(gate({event_name:'schedule'},{}),false);
  assert.equal(gate({event_name:'schedule'},{FEE_REPORT_PERIODS_ENABLED:'true'}),true);
  assert.equal(gate({event_name:'workflow_dispatch'},{}),true);
  for(const [conclusion,event,want] of [['success','push',true],['failure','push',false],['success','pull_request',false]])assert.equal(gate({event_name:'workflow_run',event:{workflow_run:{conclusion,event}}},{}),want);
});

test('weekly source dates are frozen independently of generation date',()=>{
  const p=weeklyReportPlan('2026-10-23');
  assert.equal(p.scheduledAt,'2026-10-25T00:00:00+08:00');
  assert.equal(p.accountingThrough,'2026-10-23');assert.equal(p.priceThrough,'2026-10-23');
  assert.equal(reportPlanReadiness(p,new Date('2026-10-24T15:59Z')).state,'waiting');
  assert.equal(reportPlanReadiness(p,new Date('2026-10-24T16:00Z')).state,'due');
  assert.equal(validateReportPlan(p),true);
});
test('reviewed Friday holiday uses Thursday price but Friday accounting',()=>{
  const p=weeklyReportPlan('2026-07-03');assert.equal(p.priceThrough,'2026-07-02');
  assert.equal(p.accountingThrough,'2026-07-03');
  assert.throws(()=>weeklyReportPlan('2029-07-06'),/CALENDAR_UNAVAILABLE/);
});
test('month-end waits both synchronization day and natural month end',()=>{
  const oct=monthlyReportPlan('2026-10');
  assert.equal(oct.priceThrough,'2026-10-30');assert.equal(oct.accountingThrough,'2026-10-31');
  assert.equal(oct.scheduledAt,'2026-11-01T00:00:00+08:00');
  assert.equal(reportPlanReadiness(oct,new Date('2026-10-31T16:00Z')).reasonCode,'ACCOUNTING_DAY_NOT_COMPLETE');
  assert.equal(reportPlanReadiness(oct,new Date('2026-11-01T03:59:59Z')).reasonCode,'ACCOUNTING_DAY_NOT_COMPLETE');
  // Current guard clears at HKT noon, not at 13:00: the latter is only
  // the next existing cron slot. Neither the guard nor schedule is changed.
  assert.equal(reportPlanReadiness(oct,new Date('2026-11-01T04:00Z')).state,'due');
  const july=monthlyReportPlan('2026-07');assert.equal(july.scheduledAt,'2026-08-02T00:00:00+08:00');
  const may=monthlyReportPlan('2026-05');assert.equal(may.scheduledAt,'2026-06-01T00:00:00+08:00');
  assert.equal(may.accountingThrough,'2026-05-31');
});
test('same accounting and price cutoff coalesces; same price with another fee day does not',()=>{
  const p=coalesceReportPlans([weeklyReportPlan('2026-07-31'),monthlyReportPlan('2026-07')]);
  assert.equal(p.length,1);assert.equal(p[0].kind,'weekly-monthly');assert.equal(validateReportPlan(p[0]),true);
  assert.equal(validateReportPlan(weeklyReportPlan('2026-07-31')),false);
  assert.equal(validateReportPlan(monthlyReportPlan('2026-07')),false);
  assert.equal(coalesceReportPlans([weeklyReportPlan('2026-10-30'),monthlyReportPlan('2026-10')]).length,2);
});
test('nightly planning includes only due windows and freezes month despite later date',()=>{
  const p=reportPlansAround(new Date('2026-11-01T04:00Z'));
  assert.equal(p.at(-1).kind,'monthly');assert.equal(p.at(-1).accountingThrough,'2026-10-31');
  assert.equal(p.some(x=>x.accountingThrough>'2026-10-31'),false);
});
test('batch contains every actual calendar day, bounded by existing lookback',()=>{
  assert.deepEqual(reportWindowDates('2026-10-23','2026-10-30'),['2026-10-24','2026-10-25','2026-10-26','2026-10-27','2026-10-28','2026-10-29','2026-10-30']);
  assert.deepEqual(reportWindowDates('2026-10-23','2026-10-23'),['2026-10-23']);
  assert.throws(()=>reportWindowDates('2026-10-26','2026-10-23'),/RECOVERY_REQUIRED/);
  assert.throws(()=>reportWindowDates('2026-10-01','2026-10-23'),/RECOVERY_REQUIRED/);
});
test('forged/extra plan fields and malformed dates cannot change target',()=>{
  const p=weeklyReportPlan('2026-10-23');
  for(const change of [{accountingThrough:'2026-10-26'},{priceThrough:'2026-10-26'},{scheduledAt:'2026-10-24T00:00:00+08:00'},{allowEarly:true},{kind:'daily'}])assert.equal(validateReportPlan({...p,...change}),false);
  assert.throws(()=>monthlyReportPlan('2026-13'));
});
test('reviewed synchronized daily entry uses the same v2 shape and waits for the real completed market day',()=>{
  const target='2026-10-28',markets=['NYSE','NASDAQ'];
  const ordinary=dailyReportPlan(target,markets),reviewed=dailyReportPlan(target,markets,{reviewedSyncDate:target});
  assert.equal(validateReportPlan(reviewed),true);assert.equal(isReviewedDailyPlan(reviewed),true);
  assert.deepEqual(Object.keys(reviewed),Object.keys(ordinary));
  assert.equal(ordinary.scheduledAt,'2026-10-29T10:30:00+08:00');
  assert.equal(reviewed.scheduledAt,'2026-10-29T00:00:00+08:00');
  assert.equal(reportPlanReadiness(reviewed,new Date('2026-10-29T03:59:00+08:00')).reasonCode,'SOURCE_DAY_NOT_CLOSED');
  for(const time of ['2026-10-29T04:15:00+08:00','2026-10-29T08:40:00+08:00'])assert.equal(reportPlanReadiness(reviewed,new Date(time)).state,'due');
  assert.equal(reportPlanReadiness(ordinary,new Date('2026-10-29T08:40:00+08:00')).reasonCode,'REPORT_NOT_DUE');
  assert.equal(reportPlanReadiness(ordinary,new Date('2026-10-29T10:30:00+08:00')).reasonCode,'ACCOUNTING_DAY_NOT_COMPLETE');
  const winter=dailyReportPlan('2026-11-23',markets,{reviewedSyncDate:'2026-11-23'});
  assert.equal(reportPlanReadiness(winter,new Date('2026-11-24T05:14:59+08:00')).reasonCode,'SOURCE_DAY_NOT_CLOSED');
  assert.equal(reportPlanReadiness(winter,new Date('2026-11-24T05:15:00+08:00')).state,'due');
  for(const reviewedSyncDate of ['',true,'2026-10-27','invalid'])assert.throws(()=>dailyReportPlan(target,markets,{reviewedSyncDate}));
  for(const change of [{scheduledAt:'2026-10-29T01:00:00+08:00'},{syncCompleted:true},{priceThrough:'2026-10-27'}])assert.equal(validateReportPlan({...reviewed,...change}),false);
  assert.throws(()=>dailyReportPlan('2026-11-01',markets,{reviewedSyncDate:'2026-11-01'}),/CALENDAR_SCOPE_UNVERIFIED/);
});
