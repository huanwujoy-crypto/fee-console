// Report presentation is bound to the existing fee receipt. No ledger rewrite.
import crypto from 'node:crypto';
import {canonicalJson,normalizeDataInputs,normalizeEconomicInputs,validateFeeCalculationReceipt} from './fee-receipt-core.mjs';
import {validateReportPlan,reportPlanReadiness,reportDate,reportAddDays,weeklyReportPlan,monthlyReportPlan} from './fee-report-period.mjs';
import {sessionUnion} from './fee-market-calendar.mjs';

const fail=()=>{throw Error('FEE_REPORT_METADATA_INVALID');};
const hash=value=>crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const monthEnd=ym=>{const d=new Date(ym+'-01T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+1);return reportAddDays(d.toISOString().slice(0,10),-1);};

function monthLockBody(data,economicInput,ym){
  const fee=data.feeCalculationReceipt;
  if(!validateFeeCalculationReceipt(fee,data).ok)fail();
  const p=fee.periods.find(p=>p.ym===ym);
  if(!p||p.to!==monthEnd(ym)||p.state!=='complete')fail();
  const normalized=normalizeDataInputs(data,{start:fee.start,asOf:fee.asOf,accountIds:fee.accountIds});
  const econ=normalizeEconomicInputs(economicInput);
  return {period:p,daily:normalized.daily.filter(p=>p.d>=ym+'-01'&&p.d<=monthEnd(ym)),flowsAuto:normalized.flowsAuto.filter(p=>p.date.slice(0,7)===ym),economic:{settings:econ.settings,accounts:econ.accounts,months:econ.months.filter(p=>p.ym===ym)}};
}
export function preserveReportMonthLocks(previous,next,economicInput,{finalCutoff=null}={}){
  const old=previous.feeReportMonthLocks;
  if(old!==undefined&&(!old||old.schema!=='fee-console.report-month-locks.v1'||Object.keys(old).sort().join(',')!=='periods,schema'||!Array.isArray(old.periods)))fail();
  const locks=structuredClone(old?.periods||[]),seen=new Set();
  for(const lock of locks){
    if(!lock||Object.keys(lock).sort().join(',')!=='digest,ym'||!/^\d{4}-\d{2}$/.test(lock.ym)||!/^[a-f0-9]{64}$/.test(lock.digest)||seen.has(lock.ym))fail();
    seen.add(lock.ym);
    // Verify the old ciphertext state as well as the candidate. A corrupt old
    // lock is not silently replaced by the candidate's recomputed digest.
    if(hash(monthLockBody(previous,economicInput,lock.ym))!==lock.digest||hash(monthLockBody(next,economicInput,lock.ym))!==lock.digest)throw Error('FEE_REPORT_LOCKED_MONTH_CHANGED');
  }
  if(finalCutoff!==null){
    reportDate(finalCutoff);
    if(finalCutoff!==monthEnd(finalCutoff.slice(0,7)))fail();
    for(const p of next.feeCalculationReceipt?.periods||[]){
      if(p.to!==monthEnd(p.ym)||p.to>finalCutoff||seen.has(p.ym))continue;
      locks.push({ym:p.ym,digest:hash(monthLockBody(next,economicInput,p.ym))});seen.add(p.ym);
    }
  }
  return old!==undefined||locks.length?{schema:'fee-console.report-month-locks.v1',periods:locks.sort((a,b)=>a.ym.localeCompare(b.ym))}:undefined;
}
function nextScheduled(plan){
  if(plan.schema==='fee-console.report-plan.v2'){
    for(let i=1;i<=14;i++){const d=reportAddDays(plan.accountingThrough,i),session=sessionUnion(d,plan.markets);if(session.state!=='closed')return reportAddDays(d,1)+'T10:30:00+08:00';}
    fail();
  }
  let friday=reportAddDays(plan.accountingThrough,1);
  while(new Date(friday+'T00:00:00Z').getUTCDay()!==5)friday=reportAddDays(friday,1);
  const weekly=weeklyReportPlan(friday).scheduledAt;
  let ym=plan.accountingThrough.slice(0,7),monthly=monthlyReportPlan(ym);
  if(monthly.accountingThrough<=plan.accountingThrough){const d=new Date(ym+'-01T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+1);monthly=monthlyReportPlan(d.toISOString().slice(0,7));}
  return [weekly,monthly.scheduledAt].sort((a,b)=>Date.parse(a)-Date.parse(b))[0];
}
export function buildReportMetadata({plan,data,generatedAt=new Date().toISOString()}){
  if(!validateReportPlan(plan)||reportPlanReadiness(plan,new Date(generatedAt)).state!=='due')fail();
  const fee=data.feeCalculationReceipt;
  if(!validateFeeCalculationReceipt(fee,data).ok||fee.asOf!==plan.accountingThrough||data.daily.at(-1)?.d!==fee.asOf||data.daily.at(-1)?.bd!==plan.priceThrough)fail();
  const body={schema:'fee-console.report-publication.v1',plan:structuredClone(plan),generatedAt:new Date(generatedAt).toISOString(),nextScheduledAt:nextScheduled(plan),feeReceiptId:fee.receiptId};
  const old=data.feeReportPublication;
  if(old&&Object.keys(old).sort().join(',')==='feeReceiptId,generatedAt,nextScheduledAt,plan,reportId,schema'){
    const {reportId,...prior}=old;
    if(hash(prior)===reportId&&prior.schema===body.schema&&prior.feeReceiptId===body.feeReceiptId&&canonicalJson(prior.plan)===canonicalJson(body.plan)&&prior.nextScheduledAt===body.nextScheduledAt&&Date.parse(prior.generatedAt)<=Date.parse(body.generatedAt)&&reportPlanReadiness(plan,new Date(prior.generatedAt)).state==='due')return structuredClone(old);
  }
  return {...body,reportId:hash(body)};
}

// This exact factory is embedded in index.html. It has no Node dependency.
export function createFeeReportConsumer(){
  const date=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d+'T00:00:00Z'))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
  const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
  const digest=async v=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(v))))).map(b=>b.toString(16).padStart(2,'0')).join('');
  const exact=(o,keys)=>!!o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===keys.split(',').sort().join(',');
  async function project(metadata,feeView,receipt,now=new Date()){
    const pending={state:'pending',kindLabel:'报告类型待更新',message:'报告信息尚未完成核验',nonRealtime:true};
    try{
      if(feeView?.state!=='verified'||!exact(metadata,'schema,plan,generatedAt,nextScheduledAt,feeReceiptId,reportId')||metadata.schema!=='fee-console.report-publication.v1'||metadata.feeReceiptId!==receipt?.receiptId)return pending;
      const p=metadata.plan,labels={weekly:'周报',monthly:'月报','weekly-monthly':'周报／月报（合并）',daily:'日报','daily-monthly':'日报／月末归档（合并）'},daily=p?.schema==='fee-console.report-plan.v2';
      if(!exact(p,'schema,kind,periodFrom,accountingThrough,priceThrough,scheduledAt,monthlyCutoffs'+(daily?',markets':''))||!(daily?['daily','daily-monthly'].includes(p.kind):p.schema==='fee-console.report-plan.v1'&&['weekly','monthly','weekly-monthly'].includes(p.kind))||!labels[p.kind]||![p.periodFrom,p.accountingThrough,p.priceThrough].every(date)||p.periodFrom>p.accountingThrough||p.priceThrough>p.accountingThrough||p.accountingThrough!==feeView.asOf||!Array.isArray(p.monthlyCutoffs)||new Set(p.monthlyCutoffs).size!==p.monthlyCutoffs.length||p.monthlyCutoffs.some(d=>!date(d)||(daily?d<p.periodFrom||d>p.accountingThrough||new Date(Date.parse(d+'T00:00Z')+86400000).getUTCDate()!==1:d!==p.accountingThrough)))return pending;
      if(daily&&(!Array.isArray(p.markets)||!p.markets.length||p.markets.length>16||new Set(p.markets).size!==p.markets.length||p.markets.some(m=>typeof m!=='string'||!['NYSE','NASDAQ','LSE','SIX','EURONEXT_AMSTERDAM','EURONEXT_BRUSSELS','EURONEXT_PARIS','EURONEXT_LISBON','EURONEXT_DUBLIN','EURONEXT_MILAN','EURONEXT_OSLO'].includes(m))))return pending;
      const generated=Date.parse(metadata.generatedAt),scheduled=Date.parse(p.scheduledAt),next=Date.parse(metadata.nextScheduledAt),clock=new Date(now).getTime();
      if(![generated,scheduled,next,clock].every(Number.isFinite)||generated<scheduled||generated>clock+300000||next<=scheduled)return pending;
      const {reportId,...body}=metadata;
      if(!/^[a-f0-9]{64}$/.test(reportId)||await digest(body)!==reportId)return pending;
      return {state:clock>=next?'pending-update':'updated',kindLabel:labels[p.kind],periodFrom:p.periodFrom,accountingThrough:p.accountingThrough,priceThrough:p.priceThrough,generatedAt:metadata.generatedAt,nextScheduledAt:metadata.nextScheduledAt,nonRealtime:true,...(daily?{priceLabel:'SPY／QQQ行情截至'}:{})};
    }catch{return pending;}
  }
  function snapshotPoints(points){
    if(!Array.isArray(points)||points.some(p=>!date(p?.date)))return [];
    const ordered=[...points].sort((a,b)=>a.date.localeCompare(b.date));
    if(new Set(ordered.map(p=>p.date)).size!==ordered.length)return [];
    return ordered.filter((p,i)=>i===0||i===ordered.length-1||new Date(p.date+'T00:00:00Z').getUTCDay()===5||new Date(Date.parse(p.date+'T00:00:00Z')+86400000).getUTCDate()===1);
  }
  function snapshotChange(points,investorId){
    const snapshots=snapshotPoints(points),last=snapshots.at(-1),previous=snapshots.at(-2);
    if(!last||!previous)return {valueCents:null,from:null,to:last?.date||null};
    const a=previous.investors?.find(i=>i.id===investorId),b=last.investors?.find(i=>i.id===investorId);
    if(!Number.isSafeInteger(a?.valueCents)||!Number.isSafeInteger(b?.valueCents))return {valueCents:null,from:previous.date,to:last.date};
    let external=0;
    for(const p of points.filter(p=>p.date>previous.date&&p.date<=last.date)){
      const capital=p.subscription?.investorId===investorId?p.subscription.netCents:0;
      const transfer=p.shareTransfer?.toInvestorId===investorId?p.shareTransfer.basisCents:p.shareTransfer?.fromInvestorId===investorId?-p.shareTransfer.basisCents:0;
      if(!Number.isSafeInteger(capital)||!Number.isSafeInteger(transfer))return {valueCents:null,from:previous.date,to:last.date};
      external+=capital+transfer;
      if(!Number.isSafeInteger(external))return {valueCents:null,from:previous.date,to:last.date};
    }
    const valueCents=b.valueCents-a.valueCents-external;
    return {valueCents:Number.isSafeInteger(valueCents)?valueCents:null,from:previous.date,to:last.date};
  }
  return {project,snapshotPoints,snapshotChange};
}
