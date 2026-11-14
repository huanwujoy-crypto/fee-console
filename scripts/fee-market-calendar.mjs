// Pure reviewed-calendar planning. No credentials, source IO or publication.
// Finite official coverage; unknown scope/years never grant source readiness.
const DAY=86400000;
export const calendarCoverage={from:'2026-08-31',through:'2027-12-31'};
export const calendarSources={
 US:'https://www.nyse.com/markets/hours-calendars',
 NASDAQ:'https://www.nasdaqtrader.com/trader.aspx?id=calendar',
 LSE:'https://www.londonstockexchange.com/en/resources/markets-products/business-days',
 SIX:'https://www.six-group.com/dam/download/the-swiss-stock-exchange/trading/trading-provisions/regulation/trading-guides/trading-calendar-2027.pdf',
 EURONEXT:'https://www.euronext.com/en/trading/trading-hours-holidays'
};
// Weekday closures and half days, per venue and per calendar year, as MM-DD.
// A venue with no table for a year is unknown for that year: it is never
// assumed to follow another year's or another venue's holidays.
const us26={closed:['01-01','01-19','02-16','04-03','05-25','06-19','07-03','09-07','11-26','12-25'],half:['11-27','12-24']};
// 2027, read from the NYSE holiday table on 2026-11-14. Nasdaq had not yet
// published its own 2027 schedule; it is given the same U.S. equities table.
const us27={closed:['01-01','01-18','02-15','03-26','05-31','06-18','07-05','09-06','11-25','12-24'],half:['11-26']};
const en26=['01-01','04-03','04-06','05-01','12-25'],enHalf=['12-24','12-31'];
// 2027: 1 May and 25 December fall on a Saturday.
const en27=['01-01','03-26','03-29'];
const markets={
 NYSE:{zone:'America/New_York',years:{2026:us26,2027:us27}},
 NASDAQ:{zone:'America/New_York',years:{2026:us26,2027:us27}},
 LSE:{zone:'Europe/London',years:{2026:{closed:['08-31','12-25','12-28'],half:['12-24','12-31']},
  2027:{closed:['01-01','03-26','03-29','05-03','05-31','08-30','12-27','12-28'],half:['12-24','12-31']}}},
 SIX:{zone:'Europe/Zurich',years:{2026:{closed:['01-01','01-02','04-03','04-06','05-01','05-14','05-25','12-24','12-25','12-31'],half:[]},
  2027:{closed:['01-01','03-26','03-29','05-06','05-17','12-24','12-31'],half:[]}}},
 EURONEXT_AMSTERDAM:{zone:'Europe/Amsterdam',years:{2026:{closed:en26,half:enHalf},2027:{closed:en27,half:enHalf}}},
 EURONEXT_BRUSSELS:{zone:'Europe/Brussels',years:{2026:{closed:en26,half:enHalf},2027:{closed:en27,half:enHalf}}},
 EURONEXT_PARIS:{zone:'Europe/Paris',years:{2026:{closed:en26,half:enHalf},2027:{closed:en27,half:enHalf}}},
 EURONEXT_LISBON:{zone:'Europe/Lisbon',years:{2026:{closed:en26,half:enHalf},2027:{closed:en27,half:enHalf}}},
 EURONEXT_DUBLIN:{zone:'Europe/Dublin',years:{2026:{closed:[...en26,'05-04','12-28'],half:enHalf},2027:{closed:[...en27,'05-03','12-27'],half:enHalf}}},
 // Milan and Oslo: 2027 not yet verified here, so unknown from 2027-01-01.
 EURONEXT_MILAN:{zone:'Europe/Rome',years:{2026:{closed:[...en26,'12-24','12-31'],half:[]}}},
 EURONEXT_OSLO:{zone:'Europe/Oslo',years:{2026:{closed:[...en26,'04-02','05-14','05-25','12-24','12-31'],half:['04-01']}}}
};
const fail=()=>{throw Error('LOCAL_DAILY_PLAN_INVALID');};
function date(d){if(typeof d!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(d)||new Date(d+'T00:00Z').toISOString().slice(0,10)!==d)fail();return d;}
const add=(d,n)=>new Date(Date.parse(date(d)+'T00:00Z')+n*DAY).toISOString().slice(0,10);
const local=(now,zone)=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
// Preserve the schedule encoded in accepted historical receipts. The new
// next-day 09:00 start applies from the November 3 accounting target onward.
// The consumed November 2 acceptance and earlier reports keep their old times.
export function ordinaryDailyStartTime(target){const d=date(target);return d>='2026-11-03'?'09:00':d>='2026-11-02'?'10:00':'10:30';}
export function ordinaryDailyScheduledAt(target){return add(target,1)+'T'+ordinaryDailyStartTime(target)+':00+08:00';}
const within=d=>d>=calendarCoverage.from&&d<=calendarCoverage.through;
export function marketSession(d,venue){
 date(d);const m=markets[venue];
 if(!m)return {state:'unknown',reason:'VENUE_UNRESOLVED'};
 if(!within(d))return {state:'unknown',reason:'OFFICIAL_CALENDAR_UNAVAILABLE'};
 const year=m.years[d.slice(0,4)];
 if(!year)return {state:'unknown',reason:'OFFICIAL_CALENDAR_UNAVAILABLE'};
 const weekend=[0,6].includes(new Date(d+'T00:00Z').getUTCDay());
 return {state:weekend||year.closed.includes(d.slice(5))?'closed':'open',halfDay:!weekend&&year.half.includes(d.slice(5)),zone:m.zone};
}
export function sessionUnion(d,venues){
 date(d);if(!Array.isArray(venues)||!venues.length||venues.length>16||new Set(venues).size!==venues.length||venues.some(v=>typeof v!=='string'))fail();
 const rows=venues.map(venue=>({venue,...marketSession(d,venue)}));
 // An unknown venue cannot turn every known venue's holiday into a closed claim.
 // A proved open venue is independently enough for the user's OR condition.
 return {state:rows.some(r=>r.state==='open')?'open':rows.some(r=>r.state==='unknown')?'unknown':'closed',rows};
}
export function monthlyArchivesBetween(lastPublished,target){
 date(lastPublished);date(target);if(lastPublished>target||Date.parse(target)-Date.parse(lastPublished)>10*DAY)fail();
 const out=[];for(let d=add(lastPublished,1);d<=target;d=add(d,1))if(add(d,1).slice(8)==='01')out.push(d);return out;
}
function lastUsSession(d){for(let i=0;i<8;i++){const p=add(d,-i),state=marketSession(p,'NYSE');if(state.state==='unknown')return null;if(state.state==='open')return p;}return null;}
export function planDailyFirstAttempt({now,venues,lastPublished}={}){
 now=new Date(now);if(!Number.isFinite(now.getTime()))fail();
 const hktDay=local(now,'Asia/Hong_Kong'),target=add(hktDay,-1),scheduledAt=ordinaryDailyScheduledAt(target);
 const base={schema:'fee-console.daily-calendar-plan.v1',target,scheduledAt,publicationReady:false,sourceAcceptanceRequired:true};
 if(now.getTime()<Date.parse(scheduledAt))return {...base,state:'not-due',reason:'BEFORE_'+ordinaryDailyStartTime(target).replace(':','')};
 const sessions=sessionUnion(target,venues);
 if(sessions.state==='closed')return {...base,sessions,state:'market-closed',reason:'ALL_RELEVANT_MARKETS_CLOSED'};
 if(sessions.rows.some(row=>row.state==='unknown'))return {...base,sessions,state:'waiting',reason:'CALENDAR_SCOPE_UNVERIFIED'};
 const priceThrough=lastUsSession(target);
 if(!priceThrough)return {...base,sessions,state:'waiting',reason:'BENCHMARK_CALENDAR_UNVERIFIED'};
 const monthlyCutoffs=monthlyArchivesBetween(lastPublished,target);
 const plan={...base,sessions,accountingThrough:target,priceThrough,monthlyCutoffs,kind:monthlyCutoffs.length?'daily-monthly':'daily',coverageKey:target+'|'+priceThrough};
 // A deferred archive closes its actual month, not the later daily target.
 // A genuine current month-end still waits until that NY natural day ends.
 if(monthlyCutoffs.length&&local(now,'America/New_York')<=monthlyCutoffs.at(-1))return {...plan,state:'waiting',reason:'ACCOUNTING_DAY_NOT_COMPLETE'};
 // This is only calendar readiness. It cannot authorize or prove source capture.
 return {...plan,state:'calendar-ready',reason:'REAL_SOURCE_VALIDATION_REQUIRED'};
}
export function nextSameDayCheck(plan,now){
 if(plan?.schema!=='fee-console.daily-calendar-plan.v1')fail();
 now=new Date(now);if(!Number.isFinite(now.getTime()))fail();
 const day=add(date(plan.target),1);
 if(plan.scheduledAt!==ordinaryDailyScheduledAt(plan.target)||local(now,'Asia/Hong_Kong')!==day)return null;
 return [ordinaryDailyStartTime(plan.target),'11:30','14:00'].map(t=>day+'T'+t+':00+08:00').find(t=>Date.parse(t)>now.getTime())||null;
}
export function sameDaySourceDecision({plan,now,mainSha,currentMainSha,sourceAttempts,inProgress=false,runAttempt='1'}={}){
 now=new Date(now);if(!Number.isFinite(now.getTime())||plan?.schema!=='fee-console.daily-calendar-plan.v1'||!Number.isSafeInteger(sourceAttempts)||sourceAttempts<0||typeof inProgress!=='boolean')fail();
 const base={schema:'fee-console.daily-control.v1',target:date(plan.target),publicationReady:false,published:false};
 if(!/^[a-f0-9]{40}$/.test(mainSha||'')||mainSha!==currentMainSha)return {...base,state:'waiting',reason:'FROZEN_CODE_CHANGED'};
 if(String(runAttempt)!=='1')return {...base,state:'waiting',reason:'RERUN_NOT_AUTHORIZED'};
 if(local(now,'Asia/Hong_Kong')!==add(plan.target,1))return {...base,state:'waiting',reason:'FIXED_TARGET_DAY_ENDED'};
 if(plan.scheduledAt!==ordinaryDailyScheduledAt(plan.target))fail();
 if(now.getTime()<Date.parse(plan.scheduledAt))return {...base,state:'waiting',reason:'BEFORE_'+ordinaryDailyStartTime(plan.target).replace(':','')};
 if(plan.sessions?.rows?.some(row=>row.state==='unknown')||!plan.accountingThrough)return {...base,state:'waiting',reason:'CALENDAR_SCOPE_UNVERIFIED'};
 const ordinaryDaily=plan.kind==='daily'&&Array.isArray(plan.monthlyCutoffs)&&plan.monthlyCutoffs.length===0;
 let monthCutoff=null;
 if(!ordinaryDaily){
  try{
   const cutoffs=plan.monthlyCutoffs;
   if(plan.kind!=='daily-monthly'||plan.accountingThrough!==plan.target||!Array.isArray(cutoffs)||!cutoffs.length)fail();
   for(const [i,d]of cutoffs.entries())if(add(date(d),1).slice(8)!=='01'||d>plan.target||Date.parse(plan.target)-Date.parse(d)>10*DAY||(i&&d<=cutoffs[i-1]))fail();
   monthCutoff=cutoffs.at(-1);
  }catch{return {...base,state:'waiting',reason:'ACCOUNTING_DAY_NOT_COMPLETE',nextCheckAt:nextSameDayCheck(plan,now)};}
 }
 if(monthCutoff&&local(now,'America/New_York')<=monthCutoff)return {...base,state:'waiting',reason:'ACCOUNTING_DAY_NOT_COMPLETE',nextCheckAt:nextSameDayCheck(plan,now)};
 if(inProgress||sourceAttempts>=2)return {...base,state:'waiting',reason:inProgress?'SOURCE_RUN_IN_PROGRESS':'SOURCE_ATTEMPT_BUDGET_EXHAUSTED'};
 // Calendar/budget readiness alone cannot authorize a source call or report.
 // Publication is observable only via the existing real signed-publication verifier.
 return {...base,state:'ready-for-source-validation',reason:'REAL_SOURCE_VALIDATION_REQUIRED',nextCheckAt:nextSameDayCheck(plan,now)};
}
