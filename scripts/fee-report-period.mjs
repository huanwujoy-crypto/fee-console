// Pure scheduling/coverage contract. No credentials, source reads or publication.
import {selectBenchmark,expectedTargetDate} from './fee-cloud-source.mjs';
import {sessionUnion,monthlyArchivesBetween} from './fee-market-calendar.mjs';

// Same reviewed NYSE dates as cloud/xuan-preopen/calendar.mjs, copied here to
// keep the standalone fee writer independent of the other application's tree.
// A fixture compares every date in all supported years. No inferred holidays.
const nyseHolidays={
  2026:['01-01','01-19','02-16','04-03','05-25','06-19','07-03','09-07','11-26','12-25'],
  2027:['01-01','01-18','02-15','03-26','05-31','06-18','07-05','09-06','11-25','12-24'],
  2028:['01-17','02-21','04-14','05-29','06-19','07-04','09-04','11-23','12-25'],
};
export const reportCalendarSource='https://www.nyse.com/trade/hours-calendars';
export function reportSessionOpen(date){
  reportDate(date);const holidays=nyseHolidays[date.slice(0,4)];
  if(!holidays)throw Error('OFFICIAL_CALENDAR_UNAVAILABLE');
  return ![0,6].includes(new Date(date+'T00:00:00Z').getUTCDay())&&!holidays.includes(date.slice(5));
}

const DAY=86400000;
const fail=()=>{throw Error('FEE_REPORT_PERIOD_INVALID');};
export function reportDate(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))fail();
  const d=new Date(value+'T00:00:00Z');
  if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==value)fail();
  return value;
}
export function reportAddDays(value,n){reportDate(value);if(!Number.isSafeInteger(n)||Math.abs(n)>366)fail();return new Date(Date.parse(value+'T00:00:00Z')+n*DAY).toISOString().slice(0,10);}
const localDate=(now,timeZone)=>new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
const instant=value=>{const d=new Date(value);if(!Number.isFinite(d.getTime()))fail();return d;};
const midnight=date=>date+'T00:00:00+08:00';
export function lastReportSession(on){
  reportDate(on);
  for(let i=0;i<8;i++){const d=reportAddDays(on,-i);if(reportSessionOpen(d))return d;}
  fail();
}
export function selectReportBenchmark(cache,date){
  reportDate(date);const sourceDate=lastReportSession(date),values=selectBenchmark(cache,sourceDate);
  return {sourceDate,state:sourceDate===date?'session':'closed',...values,...(sourceDate!==date?{spyd:0,qqqd:0}:{})};
}
export function weeklyReportPlan(friday){
  reportDate(friday);if(new Date(friday+'T00:00:00Z').getUTCDay()!==5)fail();
  return {schema:'fee-console.report-plan.v1',kind:'weekly',periodFrom:reportAddDays(friday,-6),accountingThrough:friday,priceThrough:lastReportSession(friday),scheduledAt:midnight(reportAddDays(friday,2)),monthlyCutoffs:[]};
}
export function monthlyReportPlan(month){
  if(typeof month!=='string'||!/^\d{4}-\d{2}$/.test(month))fail();
  const first=reportDate(month+'-01'),next=new Date(first+'T00:00:00Z');next.setUTCMonth(next.getUTCMonth()+1);
  const nextFirst=next.toISOString().slice(0,10),through=reportAddDays(nextFirst,-1),priceThrough=lastReportSession(through);
  const date=[reportAddDays(priceThrough,2),nextFirst].sort().at(-1);
  return {schema:'fee-console.report-plan.v1',kind:'monthly',periodFrom:first,accountingThrough:through,priceThrough,scheduledAt:midnight(date),monthlyCutoffs:[through]};
}
export function coalesceReportPlans(plans){
  const groups=new Map();
  for(const plan of plans){
    const key=plan.accountingThrough+'|'+plan.priceThrough;
    if(!groups.has(key)){groups.set(key,structuredClone(plan));continue;}
    const prior=groups.get(key);
    if(prior.kind!==plan.kind)prior.kind='weekly-monthly';
    prior.periodFrom=[prior.periodFrom,plan.periodFrom].sort()[0];
    prior.scheduledAt=[prior.scheduledAt,plan.scheduledAt].sort((a,b)=>Date.parse(a)-Date.parse(b)).at(-1);
    prior.monthlyCutoffs=[...new Set([...prior.monthlyCutoffs,...plan.monthlyCutoffs])].sort();
  }
  return [...groups.values()].sort((a,b)=>a.accountingThrough.localeCompare(b.accountingThrough));
}
export function validateReportPlan(plan){
  try{
    if(plan?.schema==='fee-console.report-plan.v2'){
      if(Object.keys(plan).sort().join(',')!=='accountingThrough,kind,markets,monthlyCutoffs,periodFrom,priceThrough,scheduledAt,schema')return false;
      const expected=dailyReportPlan(plan.accountingThrough,plan.markets,{periodFrom:plan.periodFrom,
        reviewedSyncDate:isReviewedDailyPlan(plan)?plan.accountingThrough:null});
      return Object.keys(expected).every(k=>JSON.stringify(expected[k])===JSON.stringify(plan[k]));
    }
    if(!plan||Object.keys(plan).sort().join(',')!=='accountingThrough,kind,monthlyCutoffs,periodFrom,priceThrough,scheduledAt,schema'||plan.schema!=='fee-console.report-plan.v1')return false;
    if(!['weekly','monthly','weekly-monthly'].includes(plan.kind))return false;
    reportDate(plan.accountingThrough);const candidates=[];
    if(new Date(plan.accountingThrough+'T00:00:00Z').getUTCDay()===5)candidates.push(weeklyReportPlan(plan.accountingThrough));
    const monthly=monthlyReportPlan(plan.accountingThrough.slice(0,7));
    if(monthly.accountingThrough===plan.accountingThrough)candidates.push(monthly);
    const expected=coalesceReportPlans(candidates)[0];
    return !!expected&&Object.keys(expected).every(k=>JSON.stringify(expected[k])===JSON.stringify(plan[k]));
  }catch{return false;}
}
export function isReviewedDailyPlan(plan){
  return plan?.schema==='fee-console.report-plan.v2'&&typeof plan.accountingThrough==='string'
    && plan.scheduledAt===midnight(reportAddDays(plan.accountingThrough,1));
}
export function dailyReportPlan(target,markets,{periodFrom=target,reviewedSyncDate=null}={}){
  reportDate(target);reportDate(periodFrom);
  if(reviewedSyncDate!==null&&reportDate(reviewedSyncDate)!==target)fail();
  const sessions=sessionUnion(target,markets);
  if(sessions.state!=='open'||sessions.rows.some(r=>r.state==='unknown'))throw Error('FEE_REPORT_CALENDAR_SCOPE_UNVERIFIED');
  if(periodFrom>target)fail();const monthlyCutoffs=monthlyArchivesBetween(reportAddDays(periodFrom,-1),target);
  // The existing v2 shape remains compatible with the receipt/UI consumer.
  // Midnight is only the reviewed entry's date anchor, not a claim that the
  // source was complete then. Readiness still requires the real market close.
  return {schema:'fee-console.report-plan.v2',kind:monthlyCutoffs.length?'daily-monthly':'daily',periodFrom,accountingThrough:target,priceThrough:lastReportSession(target),scheduledAt:reviewedSyncDate?midnight(reportAddDays(target,1)):reportAddDays(target,1)+'T10:30:00+08:00',monthlyCutoffs,markets:[...markets].sort()};
}
export function reportPlanReadiness(plan,now=new Date()){
  if(!validateReportPlan(plan))fail();now=instant(now);
  if(now.getTime()<Date.parse(plan.scheduledAt))return {state:'waiting',reasonCode:'REPORT_NOT_DUE'};
  if(isReviewedDailyPlan(plan)){
    if(localDate(now,'Asia/Hong_Kong')<=plan.accountingThrough||expectedTargetDate(now)<plan.accountingThrough)
      return {state:'waiting',reasonCode:'SOURCE_DAY_NOT_CLOSED'};
    return {state:'due',reasonCode:null};
  }
  // A final monthly cutoff includes all natural days. HKT midnight can still
  // be the prior New York afternoon; neither a price nor cash poll completes it.
  if(localDate(now,'America/New_York')<=plan.accountingThrough)return {state:'waiting',reasonCode:'ACCOUNTING_DAY_NOT_COMPLETE'};
  return {state:'due',reasonCode:null};
}
export function reportPlansAround(now=new Date()){
  now=instant(now);const day=localDate(now,'Asia/Hong_Kong'),plans=[];
  for(let i=0;i<40;i++){
    const d=reportAddDays(day,-i);
    if(new Date(d+'T00:00:00Z').getUTCDay()===5)plans.push(weeklyReportPlan(d));
    if(reportAddDays(d,1).slice(5)!=='01-01'&&reportAddDays(d,1).slice(8)!=='01')continue;
    plans.push(monthlyReportPlan(d.slice(0,7)));
  }
  return coalesceReportPlans(plans).filter(p=>Date.parse(p.scheduledAt)<=now.getTime());
}
export function reportWindowDates(lastDate,targetDate,{limit=10}={}){
  reportDate(lastDate);reportDate(targetDate);
  const days=(Date.parse(targetDate+'T00:00:00Z')-Date.parse(lastDate+'T00:00:00Z'))/DAY;
  if(!Number.isInteger(days)||days<0||days>limit||!Number.isSafeInteger(limit)||limit<1||limit>10)throw Error('FEE_REPORT_RECOVERY_REQUIRED');
  // A same-target format refresh re-reads that day's source. It never rolls a
  // newer ledger backwards, and a missing trading day is never interpolated.
  return days===0?[targetDate]:Array.from({length:days},(_,i)=>reportAddDays(lastDate,i+1));
}
