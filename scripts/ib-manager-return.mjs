// Independent, frozen IB history. No source reads, credentials, fees or ledger writes.
import crypto from 'node:crypto';
import { periodReturns, isCalendarDate, inclusiveDays, endOfMonth } from './fee-engine.mjs';

// This factory is copied verbatim into the single-file browser shell.
export function createIbManagerReturnConsumer() {
  const schema='fee-console.ib-manager-return-receipt.v1';
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
      if(!exact(receipt,['schema','scope','currency','timezone','flowTiming','historyMode','start','asOf','periods','spanDays','grossTwrPpm','sourceInputsHash','receiptId']))throw Error();
      const r=structuredClone(receipt);
      if(r.schema!==schema||r.scope!=='ib-manager'||r.currency!=='USD'||r.timezone!=='America/New_York'||r.flowTiming!=='eod'||r.historyMode!=='owner-confirmed-frozen')throw Error();
      if(!date(r.start)||!date(r.asOf)||r.asOf<r.start||r.spanDays!==days(r.start,r.asOf)||r.spanDays>3660||!Array.isArray(r.periods)||!r.periods.length||r.periods.length>121)throw Error();
      if(!/^[a-f0-9]{64}$/.test(r.sourceInputsHash)||!/^[a-f0-9]{64}$/.test(r.receiptId))throw Error();
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
  async function project(receipt,feeView){
    if(!receipt)return pending('missing');
    const checked=await validate(receipt);if(!checked.ok)return pending('invalid');
    const r=checked.receipt;
    if(feeView?.state!=='verified')return pending('fee-pending',r.asOf);
    if(r.start!==feeView.start||r.asOf!==feeView.asOf||!Array.isArray(feeView.periods)||r.periods.length!==feeView.periods.length||r.periods.some((p,i)=>['ym','from','to','calendarDayCount'].some(k=>p[k]!==feeView.periods[i][k])))return pending('period-mismatch',r.asOf);
    return {state:'verified',reason:null,asOf:r.asOf,value:r.grossTwrPpm/1000000,byMonth:Object.fromEntries(r.periods.map(p=>[p.ym,p.grossTwrPpm/1000000]))};
  }
  return {schema,canonical,digest,validate,project};
}

export async function buildIbManagerReturnReceipt(source) {
  const core=createIbManagerReturnConsumer(),exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===[...keys].sort().join(',');
  const refuse=()=>{throw new Error('IB_RETURN_INPUT_INVALID');};
  if(!exact(source,['schema','currency','timezone','flowTiming','flowsComplete','correctionsConfirmed','sourceSha256','periodReturnsInput'])||source.schema!=='fee-console.ib-manager-return-input.v1'||source.currency!=='USD'||source.timezone!=='America/New_York'||source.flowTiming!=='eod'||source.flowsComplete!==true||source.correctionsConfirmed!==true||!/^[a-f0-9]{64}$/.test(source.sourceSha256))refuse();
  const i=source.periodReturnsInput;
  if(!exact(i,['points','openT','from','to','days','flowByDate','rate','cr','cumBefore','hwmBefore'])||!isCalendarDate(i.from)||!isCalendarDate(i.to)||i.to<i.from||i.days!==inclusiveDays(i.from,i.to)||i.days>3660||!Number.isFinite(i.openT)||i.openT<=0||!Array.isArray(i.points)||i.points.length!==i.days||!exact(i.flowByDate,Object.keys(i.flowByDate||{}))||[i.rate,i.cr,i.cumBefore,i.hwmBefore].some(v=>v!==0))refuse();
  if(i.points.some(p=>!exact(p,['d','tot'])||!isCalendarDate(p.d)||p.d<i.from||p.d>i.to||!Number.isFinite(p.tot)||p.tot<=0)||new Set(i.points.map(p=>p.d)).size!==i.days)refuse();
  if(Object.entries(i.flowByDate).some(([d,v])=>!isCalendarDate(d)||d<i.from||d>i.to||!Number.isFinite(v)))refuse();
  const points=[...i.points].sort((a,b)=>a.d.localeCompare(b.d)),periods=[];let from=i.from,opening=i.openT;
  while(from<=i.to){
    const to=from.slice(0,7)===i.to.slice(0,7)?i.to:endOfMonth(from.slice(0,7));
    const result=periodReturns({points:points.filter(p=>p.d>=from&&p.d<=to),openT:opening,from,to,days:inclusiveDays(from,to),flowByDate:Object.fromEntries(Object.entries(i.flowByDate).filter(([d])=>d>=from&&d<=to)),rate:0,cr:0,cumBefore:0,hwmBefore:0});
    if(result.issues.length||!Number.isFinite(result.rG))refuse();
    periods.push({ym:from.slice(0,7),from,to,calendarDayCount:inclusiveDays(from,to),grossTwrPpm:Math.round(result.rG*1000000)});
    opening=result.closeT;from=new Date(Date.parse(to+'T00:00:00Z')+86400000).toISOString().slice(0,10);
  }
  const body={schema:core.schema,scope:'ib-manager',currency:'USD',timezone:'America/New_York',flowTiming:'eod',historyMode:'owner-confirmed-frozen',start:i.from,asOf:i.to,periods,spanDays:i.days,grossTwrPpm:Math.round((periods.reduce((n,p)=>n*(1+p.grossTwrPpm/1000000),1)-1)*1000000),sourceInputsHash:crypto.createHash('sha256').update(core.canonical(source)).digest('hex')};
  const receipt={...body,receiptId:await core.digest(body)};
  if(!(await core.validate(receipt)).ok)refuse();return receipt;
}
