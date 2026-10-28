// Pure reviewed-calendar planning. No credentials, source IO or publication.
// Finite official coverage; unknown scope/years never grant source readiness.
const DAY=86400000;
export const calendarCoverage={from:'2026-08-31',through:'2026-12-31'};
export const calendarSources={
 US:'https://www.nyse.com/markets/hours-calendars',
 NASDAQ:'https://www.nasdaqtrader.com/trader.aspx?id=calendar',
 LSE:'https://www.londonstockexchange.com/en/resources/markets-products/business-days',
 SIX:'https://www.six-group.com/dam/download/the-swiss-stock-exchange/trading/trading-provisions/regulation/trading-guides/trading-calendar-2026.pdf',
 EURONEXT:'https://www.euronext.com/en/trading/trading-hours-holidays'
};
const us=['01-01','01-19','02-16','04-03','05-25','06-19','07-03','09-07','11-26','12-25'];
const en=['01-01','04-03','04-06','05-01','12-25'];
const markets={
 NYSE:{zone:'America/New_York',closed:us,half:['11-27','12-24']},
 NASDAQ:{zone:'America/New_York',closed:us,half:['11-27','12-24']},
 LSE:{zone:'Europe/London',closed:['08-31','12-25','12-28'],half:['12-24','12-31']},
 SIX:{zone:'Europe/Zurich',closed:['01-01','01-02','04-03','04-06','05-01','05-14','05-25','12-24','12-25','12-31'],half:[]},
 EURONEXT_AMSTERDAM:{zone:'Europe/Amsterdam',closed:en,half:['12-24','12-31']},
 EURONEXT_BRUSSELS:{zone:'Europe/Brussels',closed:en,half:['12-24','12-31']},
 EURONEXT_PARIS:{zone:'Europe/Paris',closed:en,half:['12-24','12-31']},
 EURONEXT_LISBON:{zone:'Europe/Lisbon',closed:en,half:['12-24','12-31']},
 EURONEXT_DUBLIN:{zone:'Europe/Dublin',closed:[...en,'05-04','12-28'],half:['12-24','12-31']},
 EURONEXT_MILAN:{zone:'Europe/Rome',closed:[...en,'12-24','12-31'],half:[]},
 EURONEXT_OSLO:{zone:'Europe/Oslo',closed:[...en,'04-02','05-14','05-25','12-24','12-31'],half:['04-01']}
};
const fail=()=>{throw Error('LOCAL_DAILY_PLAN_INVALID');};
function date(d){if(typeof d!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(d)||new Date(d+'T00:00Z').toISOString().slice(0,10)!==d)fail();return d;}
const add=(d,n)=>new Date(Date.parse(date(d)+'T00:00Z')+n*DAY).toISOString().slice(0,10);
const local=(now,zone)=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
const within=d=>d>=calendarCoverage.from&&d<=calendarCoverage.through;
export function marketSession(d,venue){
 date(d);const m=markets[venue];
 if(!m)return {state:'unknown',reason:'VENUE_UNRESOLVED'};
 if(!within(d))return {state:'unknown',reason:'OFFICIAL_CALENDAR_UNAVAILABLE'};
 const weekend=[0,6].includes(new Date(d+'T00:00Z').getUTCDay());
 return {state:weekend||m.closed.includes(d.slice(5))?'closed':'open',halfDay:!weekend&&m.half.includes(d.slice(5)),zone:m.zone};
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
 const hktDay=local(now,'Asia/Hong_Kong'),target=add(hktDay,-1),scheduledAt=hktDay+'T10:30:00+08:00';
 const base={schema:'fee-console.daily-calendar-plan.v1',target,scheduledAt,publicationReady:false,sourceAcceptanceRequired:true};
 if(now.getTime()<Date.parse(scheduledAt))return {...base,state:'not-due',reason:'BEFORE_1030'};
 const sessions=sessionUnion(target,venues);
 if(sessions.state==='closed')return {...base,sessions,state:'market-closed',reason:'ALL_RELEVANT_MARKETS_CLOSED'};
 if(sessions.rows.some(row=>row.state==='unknown'))return {...base,sessions,state:'waiting',reason:'CALENDAR_SCOPE_UNVERIFIED'};
 const priceThrough=lastUsSession(target);
 if(!priceThrough)return {...base,sessions,state:'waiting',reason:'BENCHMARK_CALENDAR_UNVERIFIED'};
 const monthlyCutoffs=monthlyArchivesBetween(lastPublished,target);
 const plan={...base,sessions,accountingThrough:target,priceThrough,monthlyCutoffs,kind:monthlyCutoffs.length?'daily-monthly':'daily',coverageKey:target+'|'+priceThrough};
 // Retain the actual current reportPlanReadiness NY-accounting-date constraint.
 if(local(now,'America/New_York')<=target)return {...plan,state:'waiting',reason:'ACCOUNTING_DAY_NOT_COMPLETE'};
 // This is only calendar readiness. It cannot authorize or prove source capture.
 return {...plan,state:'calendar-ready',reason:'REAL_SOURCE_VALIDATION_REQUIRED'};
}
export function nextSameDayCheck(plan,now){
 if(plan?.schema!=='fee-console.daily-calendar-plan.v1')fail();
 now=new Date(now);if(!Number.isFinite(now.getTime()))fail();
 const day=add(date(plan.target),1);
 if(plan.scheduledAt!==day+'T10:30:00+08:00'||local(now,'Asia/Hong_Kong')!==day)return null;
 return ['10:30','13:00','14:00'].map(t=>day+'T'+t+':00+08:00').find(t=>Date.parse(t)>now.getTime())||null;
}
export function sameDaySourceDecision({plan,now,mainSha,currentMainSha,sourceAttempts,inProgress=false,runAttempt='1'}={}){
 now=new Date(now);if(!Number.isFinite(now.getTime())||plan?.schema!=='fee-console.daily-calendar-plan.v1'||!Number.isSafeInteger(sourceAttempts)||sourceAttempts<0||typeof inProgress!=='boolean')fail();
 const base={schema:'fee-console.daily-control.v1',target:date(plan.target),publicationReady:false,published:false};
 if(!/^[a-f0-9]{40}$/.test(mainSha||'')||mainSha!==currentMainSha)return {...base,state:'waiting',reason:'FROZEN_CODE_CHANGED'};
 if(String(runAttempt)!=='1')return {...base,state:'waiting',reason:'RERUN_NOT_AUTHORIZED'};
 if(local(now,'Asia/Hong_Kong')!==add(plan.target,1))return {...base,state:'waiting',reason:'FIXED_TARGET_DAY_ENDED'};
 if(now.getTime()<Date.parse(plan.scheduledAt))return {...base,state:'waiting',reason:'BEFORE_1030'};
 if(plan.sessions?.rows?.some(row=>row.state==='unknown')||!plan.accountingThrough)return {...base,state:'waiting',reason:'CALENDAR_SCOPE_UNVERIFIED'};
 if(local(now,'America/New_York')<=plan.target)return {...base,state:'waiting',reason:'ACCOUNTING_DAY_NOT_COMPLETE',nextCheckAt:nextSameDayCheck(plan,now)};
 if(inProgress||sourceAttempts>=2)return {...base,state:'waiting',reason:inProgress?'SOURCE_RUN_IN_PROGRESS':'SOURCE_ATTEMPT_BUDGET_EXHAUSTED'};
 // Calendar/budget readiness alone cannot authorize a source call or report.
 // Publication is observable only via the existing real signed-publication verifier.
 return {...base,state:'ready-for-source-validation',reason:'REAL_SOURCE_VALIDATION_REQUIRED',nextCheckAt:nextSameDayCheck(plan,now)};
}
