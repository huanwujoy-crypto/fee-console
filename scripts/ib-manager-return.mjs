// Independent, frozen IB history. No source reads, credentials, fees or ledger writes.
import crypto from 'node:crypto';
import { periodReturns, grossTwrDailyFactor, isCalendarDate, inclusiveDays, endOfMonth } from './fee-engine.mjs';
import {validateIbManagerReportInput} from './ib-manager-source.mjs';

// This factory is copied verbatim into the single-file browser shell.
export function createIbManagerReturnConsumer() {
  const schema='fee-console.ib-manager-return-receipt.v1',dailySchema='fee-console.ib-manager-return-receipt.v2';
  const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===[...keys].sort().join(',');
  const date=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
  const next=s=>new Date(Date.parse(s+'T00:00:00Z')+86400000).toISOString().slice(0,10);
  const days=(a,b)=>Math.round((Date.parse(b+'T00:00:00Z')-Date.parse(a+'T00:00:00Z'))/86400000)+1;
  const eom=s=>{const [y,m]=s.split('-').map(Number);return new Date(Date.UTC(y,m,0)).toISOString().slice(0,10);};
  const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
  const digest=async v=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(v))))].map(b=>b.toString(16).padStart(2,'0')).join('');
  const pending=(reason,asOf=null)=>({state:'pending',reason,asOf,value:null,byMonth:{}});
  async function validate(receipt) {
    try {
      const live=receipt?.schema===dailySchema;
      if(!exact(receipt,['schema','scope','currency','timezone','flowTiming','historyMode','start','asOf','periods','spanDays','grossTwrPpm','sourceInputsHash','receiptId',...(live?['baselineAsOf','baselineInputsHash']:[])]))throw Error();
      const r=structuredClone(receipt);
      if(![schema,dailySchema].includes(r.schema)||r.scope!=='ib-manager'||r.currency!=='USD'||r.timezone!=='America/New_York'||r.flowTiming!=='eod'||r.historyMode!==(live?'confirmed-baseline-source-verified-daily':'owner-confirmed-frozen'))throw Error();
      if(!date(r.start)||!date(r.asOf)||r.asOf<r.start||r.spanDays!==days(r.start,r.asOf)||r.spanDays>3660||!Array.isArray(r.periods)||!r.periods.length||r.periods.length>121)throw Error();
      if(!/^[a-f0-9]{64}$/.test(r.sourceInputsHash)||!/^[a-f0-9]{64}$/.test(r.receiptId))throw Error();
      if(live&&(!date(r.baselineAsOf)||r.baselineAsOf<r.start||r.baselineAsOf>r.asOf||!/^[a-f0-9]{64}$/.test(r.baselineInputsHash)))throw Error();
      let from=r.start,index=1;
      for(const p of r.periods){
        const to=from.slice(0,7)===r.asOf.slice(0,7)?r.asOf:eom(from);
        if(!exact(p,['ym','from','to','calendarDayCount','grossTwrPpm'])||p.ym!==from.slice(0,7)||p.from!==from||p.to!==to||p.calendarDayCount!==days(from,to)||!Number.isSafeInteger(p.grossTwrPpm)||p.grossTwrPpm< -1000000)throw Error();
        index*=1+p.grossTwrPpm/1000000;from=next(to);
      }
      if(from!==next(r.asOf)||!Number.isSafeInteger(r.grossTwrPpm)||r.grossTwrPpm!==Math.round((index-1)*1000000))throw Error();
      const {receiptId,...body}=r;if(await digest(body)!==receiptId)throw Error();
      return {ok:true,receipt:structuredClone(r)};
    }catch(_){return {ok:false};}
  }
  async function project(receipt,feeView,sourceStatus){
    if(sourceStatus?.state==='pending')return pending('source-unavailable',receipt?.asOf||null);
    if(!receipt)return pending('missing');
    const checked=await validate(receipt);if(!checked.ok)return pending('invalid');
    const r=checked.receipt;
    if(r.schema===dailySchema&&(sourceStatus?.state!=='verified'||sourceStatus.targetDate!==r.asOf))return pending('source-unavailable',r.asOf);
    if(feeView?.state!=='verified')return pending('fee-pending',r.asOf);
    if(r.start!==feeView.start||r.asOf!==feeView.asOf||!Array.isArray(feeView.periods)||r.periods.length!==feeView.periods.length||r.periods.some((p,i)=>['ym','from','to','calendarDayCount'].some(k=>p[k]!==feeView.periods[i][k])))return pending('period-mismatch',r.asOf);
    return {state:'verified',reason:null,asOf:r.asOf,historyMode:r.historyMode,value:r.grossTwrPpm/1000000,byMonth:Object.fromEntries(r.periods.map(p=>[p.ym,p.grossTwrPpm/1000000]))};
  }
  return {schema,dailySchema,canonical,digest,validate,project};
}

export async function buildIbManagerReturnReceipt(source) {
  const core=createIbManagerReturnConsumer(),exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===[...keys].sort().join(',');
  const refuse=()=>{throw new Error('IB_RETURN_INPUT_INVALID');};
  if(!exact(source,['schema','currency','timezone','flowTiming','flowsComplete','correctionsConfirmed','sourceSha256','periodReturnsInput'])||source.schema!=='fee-console.ib-manager-return-input.v1'||source.currency!=='USD'||source.timezone!=='America/New_York'||source.flowTiming!=='eod'||source.flowsComplete!==true||source.correctionsConfirmed!==true||!/^[a-f0-9]{64}$/.test(source.sourceSha256))refuse();
  const i=source.periodReturnsInput;
  if(!exact(i,['points','openT','from','to','days','flowByDate','rate','cr','cumBefore','hwmBefore'])||!isCalendarDate(i.from)||!isCalendarDate(i.to)||i.to<i.from||i.days!==inclusiveDays(i.from,i.to)||i.days>3660||!Number.isFinite(i.openT)||i.openT<=0||!Array.isArray(i.points)||i.points.length!==i.days||!exact(i.flowByDate,Object.keys(i.flowByDate||{}))||[i.rate,i.cr,i.cumBefore,i.hwmBefore].some(v=>v!==0))refuse();
  if(i.points.some(p=>!exact(p,['d','tot'])||!isCalendarDate(p.d)||p.d<i.from||p.d>i.to||!Number.isFinite(p.tot)||p.tot<=0)||new Set(i.points.map(p=>p.d)).size!==i.days)refuse();
  if(Object.entries(i.flowByDate).some(([d,v])=>!isCalendarDate(d)||d<i.from||d>i.to||!Number.isFinite(v)))refuse();
  return buildValidatedIbReturn(i,crypto.createHash('sha256').update(core.canonical(source)).digest('hex'));
}

async function buildValidatedIbReturn(i,sourceInputsHash,live=null){
  const core=createIbManagerReturnConsumer(),refuse=()=>{throw Error('IB_RETURN_INPUT_INVALID');};
  const points=[...i.points].sort((a,b)=>a.d.localeCompare(b.d)),periods=[];let from=i.from,opening=i.openT;
  while(from<=i.to){
    const to=from.slice(0,7)===i.to.slice(0,7)?i.to:endOfMonth(from.slice(0,7));
    const result=periodReturns({points:points.filter(p=>p.d>=from&&p.d<=to),openT:opening,from,to,days:inclusiveDays(from,to),flowByDate:Object.fromEntries(Object.entries(i.flowByDate).filter(([d])=>d>=from&&d<=to)),rate:0,cr:0,cumBefore:0,hwmBefore:0});
    if(result.issues.length||!Number.isFinite(result.rG))refuse();
    periods.push({ym:from.slice(0,7),from,to,calendarDayCount:inclusiveDays(from,to),grossTwrPpm:Math.round(result.rG*1000000)});
    opening=result.closeT;from=new Date(Date.parse(to+'T00:00:00Z')+86400000).toISOString().slice(0,10);
  }
  const body={schema:live?core.dailySchema:core.schema,scope:'ib-manager',currency:'USD',timezone:'America/New_York',flowTiming:'eod',historyMode:live?'confirmed-baseline-source-verified-daily':'owner-confirmed-frozen',start:i.from,asOf:i.to,periods,spanDays:i.days,grossTwrPpm:Math.round((periods.reduce((n,p)=>n*(1+p.grossTwrPpm/1000000),1)-1)*1000000),sourceInputsHash,...(live?{baselineAsOf:live.baselineAsOf,baselineInputsHash:live.baselineInputsHash}:{})};
  const receipt={...body,receiptId:await core.digest(body)};
  if(!(await core.validate(receipt)).ok)refuse();return receipt;
}

// A separate daily-path contract leaves the published monthly-return v1 intact.
// Copied verbatim into the browser; it never reads a source or computes fees.
export function createIbManagerDrawdownConsumer() {
  const core=createIbManagerReturnConsumer(),schema='fee-console.ib-manager-drawdown-receipt.v1';
  const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===[...keys].sort().join(',');
  const next=d=>new Date(Date.parse(d+'T00:00:00Z')+86400000).toISOString().slice(0,10);
  const pending=reason=>({state:'pending',reason,start:null,asOf:null,anchorDate:null,factors:null});
  async function validate(receipt,returnReceipt){
    try{
      const checked=await core.validate(returnReceipt);if(!checked.ok)throw Error();
      const r=structuredClone(receipt),ret=checked.receipt;
      if(!exact(r,['schema','scope','currency','timezone','flowTiming','historyMode','start','asOf','anchorDate','spanDays','returnReceiptId','sourceInputsHash','dailyFactors','receiptId']))throw Error();
      if(r.schema!==schema||r.scope!=='ib-manager'||r.currency!==ret.currency||r.timezone!==ret.timezone||r.flowTiming!==ret.flowTiming||r.historyMode!==ret.historyMode||r.start!==ret.start||r.asOf!==ret.asOf||r.spanDays!==ret.spanDays||r.returnReceiptId!==ret.receiptId||r.sourceInputsHash!==ret.sourceInputsHash)throw Error();
      if(r.anchorDate!==new Date(Date.parse(r.start+'T00:00:00Z')-86400000).toISOString().slice(0,10)||!Array.isArray(r.dailyFactors)||r.dailyFactors.length!==r.spanDays)throw Error();
      let date=r.start;
      for(const p of r.dailyFactors){if(!exact(p,['d','factor'])||p.d!==date||!Number.isFinite(p.factor)||p.factor<0)throw Error();date=next(date);}
      if(date!==next(r.asOf))throw Error();
      for(const p of ret.periods){let index=1;for(const f of r.dailyFactors)if(f.d>=p.from&&f.d<=p.to)index*=f.factor;if(!Number.isFinite(index)||Math.round((index-1)*1000000)!==p.grossTwrPpm)throw Error();}
      const {receiptId,...body}=r;if(await core.digest(body)!==receiptId)throw Error();
      return {ok:true,receipt:r};
    }catch(_){return {ok:false};}
  }
  async function project(receipt,returnReceipt,feeView,sourceStatus){
    if(!receipt)return pending('missing-daily-path');
    const checked=await validate(receipt,returnReceipt);if(!checked.ok)return pending('invalid-daily-path');
    const view=await core.project(returnReceipt,feeView,sourceStatus);if(view.state!=='verified')return pending(view.reason);
    const r=checked.receipt;return {state:'verified',reason:null,start:r.start,asOf:r.asOf,anchorDate:r.anchorDate,factors:structuredClone(r.dailyFactors)};
  }
  return {schema,validate,project};
}

export async function buildIbManagerDrawdownReceipt(source) {
  return buildValidatedIbDrawdown(source.periodReturnsInput,await buildIbManagerReturnReceipt(source));
}
async function buildValidatedIbDrawdown(i,ret){
  const core=createIbManagerReturnConsumer(),daily=[];let previous=i.openT;
  for(const p of [...i.points].sort((a,b)=>a.d.localeCompare(b.d))){
    const factor=grossTwrDailyFactor(p.tot,i.flowByDate[p.d]||0,previous);
    if(!Number.isFinite(factor)||factor<0)throw Error('IB_DRAWDOWN_INPUT_INVALID');
    daily.push({d:p.d,factor});previous=p.tot;
  }
  const body={schema:'fee-console.ib-manager-drawdown-receipt.v1',scope:'ib-manager',currency:ret.currency,timezone:ret.timezone,flowTiming:ret.flowTiming,historyMode:ret.historyMode,start:ret.start,asOf:ret.asOf,anchorDate:new Date(Date.parse(ret.start+'T00:00:00Z')-86400000).toISOString().slice(0,10),spanDays:ret.spanDays,returnReceiptId:ret.receiptId,sourceInputsHash:ret.sourceInputsHash,dailyFactors:daily};
  const receipt={...body,receiptId:await core.digest(body)};
  if(!(await createIbManagerDrawdownConsumer().validate(receipt,ret)).ok)throw Error('IB_DRAWDOWN_INPUT_INVALID');
  return receipt;
}

export async function buildIbManagerReportBundle(input,expectedBaselineHash){
  const source=validateIbManagerReportInput(input,expectedBaselineHash),core=createIbManagerReturnConsumer();
  const ret=await buildValidatedIbReturn(source.periodReturnsInput,crypto.createHash('sha256').update(core.canonical(source)).digest('hex'),source);
  const drawdown=await buildValidatedIbDrawdown(source.periodReturnsInput,ret);
  const body={schema:'fee-console.ib-manager-source-state.v1',returnReceiptId:ret.receiptId,source};
  return {returnReceipt:ret,drawdownReceipt:drawdown,sourceState:{...body,stateId:await core.digest(body)}};
}
export async function validateIbManagerReportState(payload,expectedBaselineHash){
  if(!Object.hasOwn(payload,'ibManagerSourceState'))return null;
  try{
    const state=payload.ibManagerSourceState,core=createIbManagerReturnConsumer();
    if(!state||Object.keys(state).sort().join(',')!=='returnReceiptId,schema,source,stateId'||state.schema!=='fee-console.ib-manager-source-state.v1')throw Error();
    const {stateId,...body}=state;if(await core.digest(body)!==stateId)throw Error();
    const bundle=await buildIbManagerReportBundle(state.source,expectedBaselineHash);
    if(core.canonical(bundle.sourceState)!==core.canonical(state)||core.canonical(bundle.returnReceipt)!==core.canonical(payload.ibManagerReturnReceipt)||core.canonical(bundle.drawdownReceipt)!==core.canonical(payload.ibManagerDrawdownReceipt))throw Error();
    return structuredClone(state.source);
  }catch{throw Error('IB_SOURCE_STATE_INVALID');}
}
