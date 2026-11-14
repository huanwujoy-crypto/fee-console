import test from 'node:test';import assert from 'node:assert/strict';
import {marketSession,sessionUnion,monthlyArchivesBetween,planDailyFirstAttempt,nextSameDayCheck,sameDaySourceDecision} from './fee-market-calendar.mjs';
const venues=['NYSE','NASDAQ','LSE','SIX','EURONEXT_AMSTERDAM'];
const plan=(now,lastPublished='2026-10-26',scope=venues)=>planDailyFirstAttempt({now,lastPublished,venues:scope});
test('09:00 is not source completion and no financial work is scheduled before10:30',()=>{const p=plan('2026-10-28T09:00:00+08:00');assert.equal(p.state,'not-due');assert.equal(p.publicationReady,false);});
test('10:30 summer-time daily attempt reaches source validation with the correct prior date',()=>{const p=plan('2026-10-28T10:30:00+08:00');assert.equal(p.target,'2026-10-27');assert.equal(p.state,'calendar-ready');assert.equal(p.publicationReady,false);});
test('10:30 winter-time ordinary daily attempt is also calendar ready',()=>{assert.equal(plan('2026-11-04T10:30:00+08:00','2026-11-02').state,'calendar-ready');});
test('actual month-end plans retain summer and winter NY completion boundaries',()=>{for(const [day,last,cutoff] of [['2026-10-01','2026-09-29','12:00:00'],['2026-12-01','2026-11-29','13:00:00']]){assert.equal(plan(day+'T10:30:00+08:00',last).reason,'ACCOUNTING_DAY_NOT_COMPLETE');assert.equal(plan(day+'T'+cutoff+'+08:00',last).state,'calendar-ready');}});
test('European and US DST mismatch week still uses timezone rules rather than fixed offsets',()=>{for(const day of ['2026-10-27','2026-10-28','2026-10-29','2026-10-30']){const p=plan(day+'T10:30:00+08:00','2026-10-23');assert.equal(p.state,'calendar-ready');}});
test('Thanksgiving closed US plus open Europe triggers next-day calendar checking',()=>{const p=plan('2026-11-27T10:30:00+08:00','2026-11-25');assert.equal(p.state,'calendar-ready');assert.equal(p.priceThrough,'2026-11-25');assert.equal(p.sessions.rows.find(x=>x.venue==='NYSE').state,'closed');assert.equal(p.sessions.rows.find(x=>x.venue==='LSE').state,'open');});
test('a UK holiday does not suppress an open US session',()=>{const p=sessionUnion('2026-12-28',venues);assert.equal(p.state,'open');assert.equal(p.rows.find(x=>x.venue==='LSE').state,'closed');assert.equal(p.rows.find(x=>x.venue==='NYSE').state,'open');});
test('all markets closed Christmas yields no report entry',()=>{assert.equal(plan('2026-12-26T13:00:00+08:00','2026-12-24').state,'market-closed');});
test('Sunday and Monday after a wholly closed weekend do not become Tue-Sat inferred sessions',()=>{assert.equal(plan('2026-11-01T13:00:00+08:00','2026-10-30').state,'market-closed');assert.equal(plan('2026-11-02T13:00:00+08:00','2026-10-30').state,'market-closed');});
test('half days count as sessions, not closures',()=>{assert.equal(marketSession('2026-11-27','NYSE').halfDay,true);assert.equal(marketSession('2026-12-24','LSE').state,'open');assert.equal(marketSession('2026-12-24','SIX').state,'closed');});
test('generic EURONEXT is never guessed to be Amsterdam',()=>{assert.equal(marketSession('2026-12-24','EURONEXT').state,'unknown');assert.equal(sessionUnion('2026-12-25',['NYSE','EURONEXT']).state,'unknown');});
test('an open known venue cannot promote an unresolved configured venue to full production readiness',()=>{const p=sessionUnion('2026-10-27',['NYSE','EURONEXT']);assert.equal(p.state,'open');assert.equal(p.rows[1].state,'unknown');assert.equal(plan('2026-10-28T13:00:00+08:00','2026-10-26',['NYSE','EURONEXT']).reason,'CALENDAR_SCOPE_UNVERIFIED');});
test('expired or unverified calendar years cannot activate',()=>{
 assert.equal(plan('2028-01-04T13:00:00+08:00','2027-12-31').state,'waiting');assert.equal(plan('2028-01-04T13:00:00+08:00','2027-12-31').reason,'CALENDAR_SCOPE_UNVERIFIED');
 assert.equal(marketSession('2028-01-03','NYSE').state,'unknown');assert.equal(marketSession('2026-08-28','NYSE').state,'unknown');
 // A venue without a verified table for a year is unknown for that year only, and blocks a scope that names it.
 for(const venue of ['EURONEXT_MILAN','EURONEXT_OSLO']){assert.equal(marketSession('2026-12-23',venue).state,'open');assert.equal(marketSession('2027-01-05',venue).state,'unknown');}
 assert.equal(plan('2027-01-06T13:00:00+08:00','2027-01-04',['NYSE','EURONEXT_MILAN']).reason,'CALENDAR_SCOPE_UNVERIFIED');
});
test('2027 uses its own official tables and never the 2026 dates',()=>{
 const state=(d,v)=>marketSession(d,v).state,half=(d,v)=>marketSession(d,v).halfDay;
 // The year boundary: 31 December 2026 and the first sessions of 2027.
 const yearEnd=plan('2027-01-01T13:30:00+08:00','2026-12-30');assert.equal(yearEnd.target,'2026-12-31');assert.equal(yearEnd.state,'calendar-ready');assert.equal(yearEnd.kind,'daily-monthly');assert.deepEqual(yearEnd.monthlyCutoffs,['2026-12-31']);
 assert.equal(plan('2027-01-01T12:30:00+08:00','2026-12-30').reason,'ACCOUNTING_DAY_NOT_COMPLETE');assert.equal(sessionUnion('2026-12-31',venues).state,'open');
 assert.equal(sessionUnion('2027-01-01',venues).state,'closed');assert.equal(plan('2027-01-02T13:00:00+08:00','2026-12-31').state,'market-closed');
 const first=plan('2027-01-05T13:00:00+08:00','2026-12-31');assert.equal(first.target,'2027-01-04');assert.equal(first.kind,'daily');assert.equal(first.priceThrough,'2027-01-04');
 // U.S.: every 2027 closure, the one half day, and 2026-only dates that are ordinary sessions in 2027.
 for(const d of ['01-01','01-18','02-15','03-26','05-31','06-18','07-05','09-06','11-25','12-24'])for(const v of ['NYSE','NASDAQ'])assert.equal(state('2027-'+d,v),'closed',v+d);
 for(const d of ['01-19','02-16','05-25','07-02','09-07','11-26','12-23','12-27','12-31'])assert.equal(state('2027-'+d,'NYSE'),'open',d);
 assert.equal(half('2027-11-26','NYSE'),true);assert.equal(half('2027-11-27','NYSE'),false);assert.equal(half('2027-12-24','NYSE'),false);
 assert.equal(state('2026-11-26','NYSE'),'closed');assert.equal(state('2026-12-24','NYSE'),'open');
 // London, Zurich and the Euronext venues in scope.
 for(const d of ['01-01','03-26','03-29','05-03','05-31','08-30','12-27','12-28'])assert.equal(state('2027-'+d,'LSE'),'closed','LSE'+d);
 for(const d of ['12-24','12-31'])assert.equal(half('2027-'+d,'LSE'),true);assert.equal(state('2027-08-31','LSE'),'open');
 for(const d of ['01-01','03-26','03-29','05-06','05-17','12-24','12-31'])assert.equal(state('2027-'+d,'SIX'),'closed','SIX'+d);
 for(const d of ['01-04','05-03','05-14','05-25'])assert.equal(state('2027-'+d,'SIX'),'open','SIX'+d);
 for(const v of ['EURONEXT_AMSTERDAM','EURONEXT_BRUSSELS','EURONEXT_PARIS','EURONEXT_LISBON']){
  for(const d of ['01-01','03-26','03-29'])assert.equal(state('2027-'+d,v),'closed',v+d);
  for(const d of ['05-03','05-17','12-27'])assert.equal(state('2027-'+d,v),'open',v+d);
  for(const d of ['12-24','12-31'])assert.equal(half('2027-'+d,v),true);
 }
 for(const d of ['05-03','12-27'])assert.equal(state('2027-'+d,'EURONEXT_DUBLIN'),'closed');
 // The OR rule across the configured scope: a U.S. holiday with Europe open is a report day; Good Friday is not.
 const scope=['NYSE','NASDAQ','LSE','SIX','EURONEXT_AMSTERDAM','EURONEXT_PARIS'];
 for(const d of ['2027-01-18','2027-11-25','2027-07-05'])assert.equal(sessionUnion(d,scope).state,'open',d);
 for(const d of ['2027-01-01','2027-03-26','2027-12-25','2027-12-26'])assert.equal(sessionUnion(d,scope).state,'closed',d);
 assert.equal(sessionUnion('2027-12-24',scope).state,'open');assert.equal(sessionUnion('2027-12-24',['NYSE','SIX']).state,'closed');
 // Every weekday of 2027 is decided for the configured scope; nothing is left unknown.
 for(let t=Date.parse('2027-01-01T00:00Z');t<=Date.parse('2027-12-31T00:00Z');t+=86400000)assert.notEqual(sessionUnion(new Date(t).toISOString().slice(0,10),scope).state,'unknown');
});
test('invalid dates and duplicate scopes fail closed',()=>{assert.throws(()=>marketSession('2026-02-30','NYSE'));assert.throws(()=>sessionUnion('2026-10-27',['NYSE','NYSE']));});
test('month-end archives piggyback the next qualifying daily run, without a second monthly source entry',()=>{const p=plan('2026-11-03T13:00:00+08:00','2026-10-30');assert.equal(p.state,'calendar-ready');assert.equal(p.kind,'daily-monthly');assert.deepEqual(p.monthlyCutoffs,['2026-10-31']);assert.equal(p.accountingThrough,'2026-11-02');});
test('same-day natural month-end has one combined plan and coverage key',()=>{const p=plan('2026-10-01T13:00:00+08:00','2026-09-29');assert.equal(p.kind,'daily-monthly');assert.deepEqual(p.monthlyCutoffs,['2026-09-30']);assert.equal(p.coverageKey,'2026-09-30|2026-09-30');});
test('archive matching does not charge or archive one cutoff twice',()=>{assert.deepEqual(monthlyArchivesBetween('2026-10-31','2026-11-02'),[]);assert.deepEqual(monthlyArchivesBetween('2026-10-30','2026-11-02'),['2026-10-31']);});
test('a ten-day recovery bound stays finite',()=>{assert.throws(()=>monthlyArchivesBetween('2026-10-01','2026-10-27'));});
test('calendar ready never asserts financial readiness or publication success',()=>{const p=plan('2026-10-28T13:00:00+08:00');assert.equal(p.state,'calendar-ready');assert.equal(p.publicationReady,false);assert.equal(p.sourceAcceptanceRequired,true);});
const sha='a'.repeat(40),first=()=>plan('2026-10-28T10:30:00+08:00');
const decision=(now,extra={})=>sameDaySourceDecision({plan:first(),now,mainSha:sha,currentMainSha:sha,sourceAttempts:0,...extra});
test('the 10:30 daily result retains the same target for natural11:30 and14:00 checks',()=>{const p=first();assert.equal(nextSameDayCheck(p,'2026-10-28T10:30:00+08:00'),'2026-10-28T11:30:00+08:00');assert.equal(decision('2026-10-28T13:00:00+08:00').target,p.target);assert.equal(decision('2026-10-28T14:00:00+08:00').state,'ready-for-source-validation');assert.equal(nextSameDayCheck(p,'2026-10-28T14:00:00+08:00'),null);});
test('same-day continuation cannot renew financial attempt budget, rerun approval or frozen code',()=>{for(const [extra,reason]of [[{sourceAttempts:2},'SOURCE_ATTEMPT_BUDGET_EXHAUSTED'],[{inProgress:true},'SOURCE_RUN_IN_PROGRESS'],[{runAttempt:'2'},'RERUN_NOT_AUTHORIZED'],[{currentMainSha:'b'.repeat(40)},'FROZEN_CODE_CHANGED']])assert.equal(decision('2026-10-28T13:00:00+08:00',extra).reason,reason);});
test('the same pending operation cannot silently roll to tomorrow or claim published',()=>{const r=decision('2026-10-29T13:00:00+08:00');assert.equal(r.reason,'FIXED_TARGET_DAY_ENDED');assert.equal(r.published,false);assert.equal(r.publicationReady,false);});

test('10:30 control retains budget, concurrency and month-finalization restrictions',()=>{
 assert.equal(decision('2026-10-28T10:30:00+08:00').state,'ready-for-source-validation');
 for(const [extra,reason]of [[{sourceAttempts:2},'SOURCE_ATTEMPT_BUDGET_EXHAUSTED'],[{inProgress:true},'SOURCE_RUN_IN_PROGRESS'],[{runAttempt:'2'},'RERUN_NOT_AUTHORIZED'],[{currentMainSha:'b'.repeat(40)},'FROZEN_CODE_CHANGED']])assert.equal(decision('2026-10-28T10:30:00+08:00',extra).reason,reason);
 const monthly=plan('2026-10-01T10:30:00+08:00','2026-09-29');
 assert.equal(sameDaySourceDecision({plan:monthly,now:'2026-10-01T10:30:00+08:00',mainSha:sha,currentMainSha:sha,sourceAttempts:0}).reason,'ACCOUNTING_DAY_NOT_COMPLETE');
 for(const p of [{...first(),monthlyCutoffs:undefined},{...first(),kind:'daily-monthly'},{...monthly,kind:'daily'}])assert.equal(sameDaySourceDecision({plan:p,now:p.scheduledAt,mainSha:sha,currentMainSha:sha,sourceAttempts:0}).reason,'ACCOUNTING_DAY_NOT_COMPLETE');
});

test('new 10:00 start closes the prior month without claiming the latest NY natural day ended',()=>{
 const at='2026-11-03T10:00:00+08:00',p=plan(at,'2026-10-30');
 assert.equal(plan('2026-11-03T09:59:59+08:00','2026-10-30').reason,'BEFORE_1000');
 assert.equal(p.scheduledAt,at);assert.equal(p.target,'2026-11-02');assert.deepEqual(p.monthlyCutoffs,['2026-10-31']);assert.equal(p.state,'calendar-ready');
 assert.equal(new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(new Date(at)),'2026-11-02');
 const control=extra=>sameDaySourceDecision({plan:p,now:at,mainSha:sha,currentMainSha:sha,sourceAttempts:0,...extra});
 assert.equal(control().state,'ready-for-source-validation');assert.equal(control().publicationReady,false);
 assert.equal(nextSameDayCheck(p,at),'2026-11-03T11:30:00+08:00');
 for(const [extra,reason]of [[{sourceAttempts:2},'SOURCE_ATTEMPT_BUDGET_EXHAUSTED'],[{inProgress:true},'SOURCE_RUN_IN_PROGRESS'],[{runAttempt:'2'},'RERUN_NOT_AUTHORIZED'],[{currentMainSha:'b'.repeat(40)},'FROZEN_CODE_CHANGED']])assert.equal(control(extra).reason,reason);
 for(const monthlyCutoffs of [undefined,[],['2026-10-30'],['2026-11-30'],['2026-09-30'],['2026-10-31','2026-10-31'],['invalid']])assert.equal(control({plan:{...p,monthlyCutoffs}}).reason,'ACCOUNTING_DAY_NOT_COMPLETE');
 assert.equal(control({plan:{...p,kind:'daily'}}).reason,'ACCOUNTING_DAY_NOT_COMPLETE');
 assert.throws(()=>control({plan:{...p,scheduledAt:'2026-11-03T09:00:00+08:00'}}),/LOCAL_DAILY_PLAN_INVALID/);
});

test('from November4 ordinary reports start at09:00 and unverified or closed calendars still stop',()=>{
 assert.equal(plan('2026-11-04T08:59:59+08:00','2026-11-02').state,'not-due');
 assert.equal(plan('2026-11-04T09:00:00+08:00','2026-11-02').state,'calendar-ready');
 assert.equal(plan('2026-11-04T09:00:00+08:00','2026-11-02',['NYSE','EURONEXT']).reason,'CALENDAR_SCOPE_UNVERIFIED');
 assert.equal(plan('2026-12-26T09:00:00+08:00','2026-12-24').state,'market-closed');
});

test('11:30 replaces13:00 without changing target, budget, rerun or14:00 boundary',()=>{
 const p=plan('2026-11-03T10:00:00+08:00','2026-10-30');
 assert.equal(nextSameDayCheck(p,'2026-11-03T11:29:59+08:00'),'2026-11-03T11:30:00+08:00');
 for(const now of ['2026-11-03T11:30:00+08:00','2026-11-03T13:00:00+08:00'])assert.equal(nextSameDayCheck(p,now),'2026-11-03T14:00:00+08:00');
 assert.equal(nextSameDayCheck(p,'2026-11-03T14:00:00+08:00'),null);
 const check=extra=>sameDaySourceDecision({plan:p,now:'2026-11-03T11:30:00+08:00',mainSha:sha,currentMainSha:sha,sourceAttempts:0,...extra});
 assert.equal(check().target,'2026-11-02');assert.equal(check().state,'ready-for-source-validation');
 assert.equal(check({sourceAttempts:2}).reason,'SOURCE_ATTEMPT_BUDGET_EXHAUSTED');
 assert.equal(check({runAttempt:'2'}).reason,'RERUN_NOT_AUTHORIZED');
});


test('09:00 keeps historical dates, unchanged follow-ups and source admission guards',()=>{
 const now='2026-11-04T09:00:00+08:00',p=plan(now,'2026-11-02',['NYSE','NASDAQ']);
 assert.equal(p.target,'2026-11-03');assert.equal(p.scheduledAt,now);assert.equal(p.publicationReady,false);assert.equal(p.sourceAcceptanceRequired,true);
 assert.equal(new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(new Date(now)),'2026-11-03');
 assert.equal(nextSameDayCheck(p,'2026-11-04T08:59:59+08:00'),now);
 assert.equal(nextSameDayCheck(p,now),'2026-11-04T11:30:00+08:00');
 assert.equal(nextSameDayCheck(p,'2026-11-04T11:30:00+08:00'),'2026-11-04T14:00:00+08:00');
 assert.equal(nextSameDayCheck(p,'2026-11-04T14:00:00+08:00'),null);
 const decision=extra=>sameDaySourceDecision({plan:p,now,mainSha:sha,currentMainSha:sha,sourceAttempts:0,...extra});
 assert.equal(decision().state,'ready-for-source-validation');
 for(const [extra,reason]of [[{sourceAttempts:2},'SOURCE_ATTEMPT_BUDGET_EXHAUSTED'],[{inProgress:true},'SOURCE_RUN_IN_PROGRESS'],[{runAttempt:'2'},'RERUN_NOT_AUTHORIZED'],[{currentMainSha:'b'.repeat(40)},'FROZEN_CODE_CHANGED']])assert.equal(decision(extra).reason,reason);
 assert.equal(decision({now:'2026-11-04T08:59:59+08:00'}).reason,'BEFORE_0900');
 assert.equal(plan('2026-12-01T09:00:00+08:00','2026-11-29').reason,'ACCOUNTING_DAY_NOT_COMPLETE');
 assert.equal(plan('2026-12-01T13:00:00+08:00','2026-11-29').state,'calendar-ready');
 assert.equal(plan('2026-11-03T09:00:00+08:00','2026-10-30').reason,'BEFORE_1000');
 assert.equal(plan('2026-10-31T09:00:00+08:00','2026-10-29').reason,'BEFORE_1030');
});
