// Normal-report IB source only. No credential discovery, writes, scheduler or CLI.
import crypto from 'node:crypto';
import {boundedJson} from './fee-http-json.mjs';
import {isCalendarDate,inclusiveDays} from './fee-engine.mjs';
import {parseSourceJson,cashCents,exactNumberText} from './fee-cloud-source.mjs';
import {ibNoncashMark,buildIbNativeNoncashProof,validateIbNativeNoncashProof,validateIbAuditEvent,validateIbAuditQuote} from './ib-manager-noncash.mjs';

export const IB_BASELINE_WINDOW=Object.freeze({from:'2026-08-01',asOf:'2026-10-23'});
const API='https://api.sharesight.com',NAME='IB-HK';
const codes=new Set(['CONFIG','BASELINE_LOCK','BASELINE_MISMATCH','SCOPE','IDENTITY','INCOMPLETE','DATE','DATE_ALIGNMENT','AMOUNT','SCHEMA','CASH_RECONCILIATION','UNRESOLVED_FLOW','UNVERIFIED_TRANSFER','NONCASH_EVIDENCE','UNSUPPORTED_CURRENCY','UNSTABLE','HISTORY_LIMIT','PAST_POINT_CHANGED','STATE','NETWORK']);
export class IbManagerSourceError extends Error{constructor(code){super('IB_SOURCE_'+(codes.has(code)?code:'NETWORK'));this.code=codes.has(code)?code:'NETWORK';}}
const fail=code=>{throw new IbManagerSourceError(code);};
export const ibSourceFailureCode=e=>e instanceof IbManagerSourceError?'IB_SOURCE_'+e.code:'IB_SOURCE_NETWORK';
export const ibCanonical=v=>Array.isArray(v)?'['+v.map(ibCanonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+ibCanonical(v[k])).join(',')+'}':JSON.stringify(v);
const hash=v=>crypto.createHash('sha256').update(ibCanonical(v)).digest('hex');
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const day=d=>{if(!isCalendarDate(d))fail('DATE');return d;};
const add=(d,n)=>new Date(Date.parse(day(d)+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const id=v=>{if(!Number.isSafeInteger(v)||v<=0)fail('IDENTITY');return v;};
const complete=v=>{if(!object(v)||v.links?.next||v.pagination?.next_page||v.meta?.pagination?.next_page||v.next_page||v.has_more===true||v.complete===false||v.restricted===true||v.limited===true||v.truncated===true)fail('INCOMPLETE');return v;};
const rows=(v,k)=>{complete(v);if(!Array.isArray(v[k])||v[k].some(x=>!object(x)))fail('SCHEMA');const out=v[k];if(new Set(out.map(x=>id(x.id))).size!==out.length)fail('IDENTITY');return out;};
// Same USD-cent boundary as the existing two-account source's round2().
export function ibMoneyCents(v){if(typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>1e12)fail('AMOUNT');return Math.round((v+Number.EPSILON)*100);}
function cashAmount(row,key){try{return Number(cashCents(row,key));}catch{fail('AMOUNT');}}
function quantity(row){try{const text=exactNumberText(row,'quantity'),m=/^(\d+)e(-?\d+)$/.exec(text);if(text==='0')return 0n;if(!m||Number(m[2])< -18||Number(m[2])>10||row.quantity<0||row.quantity>1e10)fail('SCHEMA');return BigInt(m[1])*10n**BigInt(Number(m[2])+18);}catch{fail('SCHEMA');}}
function business(i,to=i.to){
  if(!exact(i,['points','openT','from','to','days','flowByDate','rate','cr','cumBefore','hwmBefore'])||!isCalendarDate(i.from)||!isCalendarDate(i.to)||i.to<i.from||to<i.from||to>i.to||i.days!==inclusiveDays(i.from,i.to)||i.days>3660||!Array.isArray(i.points)||!object(i.flowByDate)||[i.rate,i.cr,i.cumBefore,i.hwmBefore].some(x=>x!==0))fail('SCHEMA');
  const sorted=[...i.points].sort((a,b)=>String(a.d).localeCompare(String(b.d)));let date=i.from;
  const inputCents=ibMoneyCents;
  if(sorted.length!==i.days)fail('INCOMPLETE');
  for(const p of sorted){if(!exact(p,['d','tot'])||p.d!==date||inputCents(p.tot)<=0)fail('INCOMPLETE');date=add(date,1);}
  if(inputCents(i.openT)<=0)fail('AMOUNT');
  const flows=Object.entries(i.flowByDate).map(([d,v])=>{day(d);if(d<i.from||d>i.to)fail('DATE');return {d,cents:inputCents(v)};}).filter(p=>p.cents&&p.d<=to).sort((a,b)=>a.d.localeCompare(b.d));
  return {schema:'fee-console.ib-business-input.v1',currency:'USD',timezone:'America/New_York',flowTiming:'eod',from:i.from,to,openingCents:inputCents(i.openT),points:sorted.filter(p=>p.d<=to).map(p=>({d:p.d,totalCents:inputCents(p.tot)})),flows};
}
export const ibBaselineBusinessHash=(input,asOf=input.to)=>hash(business(input,asOf));
const instrumentKey=i=>({code:i?.code,market_code:i?.market_code,currency_code:i?.currency_code});
export function validateIbBootstrapCoverage(state,expectedHash,{baselineAsOf=IB_BASELINE_WINDOW.asOf}={}){
  if(!exact(state,['schema','authority','sourceProvider','baselineInputsHash','from','through','evidenceSha256','events','quotes','coverageId'])||state.schema!=='fee-console.ib-manager-coverage.v2'||state.authority!=='reviewed-source-reconciliation'||state.sourceProvider!=='Sharesight'||state.baselineInputsHash!==expectedHash||state.from!==add(baselineAsOf,1)||!isCalendarDate(state.through)||state.through<state.from||inclusiveDays(state.from,state.through)>8||!/^[a-f0-9]{64}$/.test(state.evidenceSha256||'')||!Array.isArray(state.events)||state.events.length>100||!Array.isArray(state.quotes)||state.quotes.length>100)fail('STATE');
  const events=new Set(),keys=new Set(),quotes=new Set();
  for(const e of state.events){try{validateIbAuditEvent(e);}catch{fail('NONCASH_EVIDENCE');}const key=e.d+'|'+ibCanonical(e.instrument);if(e.d<state.from||e.d>state.through||events.has(e.eventId)||keys.has(key))fail('NONCASH_EVIDENCE');events.add(e.eventId);keys.add(key);}
  for(const q of state.quotes){try{validateIbAuditQuote(q);}catch{fail('NONCASH_EVIDENCE');}const key=q.d+'|'+ibCanonical(q.instrument);if(!keys.has(key)||quotes.has(key))fail('NONCASH_EVIDENCE');quotes.add(key);}
  const {coverageId,...body}=state;if(hash(body)!==coverageId)fail('STATE');return structuredClone(state);
}
// This object is accepted only inside the existing authenticated encrypted
// payload. Its digest is integrity, never an owner approval or a source grant.
// Receipt IDs are independently rebuilt by ib-manager-return before use.
export function validateIbOwnerBaseline(state,expectedHash){
  if(!exact(state,['schema','authority','input','baselineInputsHash','returnReceiptId','drawdownReceiptId','stateId'])||state.schema!=='fee-console.ib-owner-baseline.v1'||state.authority!=='owner-confirmed-frozen'||state.baselineInputsHash!==expectedHash||!['returnReceiptId','drawdownReceiptId','stateId'].every(k=>/^[a-f0-9]{64}$/.test(state[k]||'')))fail('STATE');
  const i=state.input;
  if(!exact(i,['schema','currency','timezone','flowTiming','flowsComplete','correctionsConfirmed','sourceSha256','periodReturnsInput'])||i.schema!=='fee-console.ib-manager-return-input.v1'||i.currency!=='USD'||i.timezone!=='America/New_York'||i.flowTiming!=='eod'||i.flowsComplete!==true||i.correctionsConfirmed!==true||!/^[a-f0-9]{64}$/.test(i.sourceSha256||''))fail('STATE');
  business(i.periodReturnsInput);
  if(ibBaselineBusinessHash(i.periodReturnsInput)!==expectedHash)fail('BASELINE_MISMATCH');
  const {stateId,...body}=state;if(hash(body)!==stateId)fail('STATE');return structuredClone(state);
}
// A private, source-linked correction of one early cash valuation, never a
// shifted transaction or external flow. Raw snapshots remain in the proof;
// only the derived snapshots enter the daily path and future anchor checks.
function cashDateSnapshot(s){
  const native=Object.hasOwn(s||{},'nativeCash'),foreign=Object.hasOwn(s||{},'foreignCurrencies');
  if(!exact(s,['d','totalCents','cash','cashCurrency','positions','marks',...(native?['nativeCash']:[]),...(foreign?['foreignCurrencies']:[])])||!isCalendarDate(s.d)||!Number.isSafeInteger(s.totalCents)||s.totalCents<=0||!['cash','cashCurrency','positions','marks'].every(k=>object(s[k]))||native&&!object(s.nativeCash)||foreign&&!object(s.foreignCurrencies))fail('CASH_RECONCILIATION');
  if(ibCanonical(Object.keys(s.cash).sort())!==ibCanonical(Object.keys(s.cashCurrency).sort()))fail('CASH_RECONCILIATION');
  for(const[k,v]of Object.entries(s.cash))if(!/^[1-9]\d*$/.test(k)||!Number.isSafeInteger(v)||!/^[A-Z]{3}$/.test(s.cashCurrency[k])||s.cashCurrency[k]!=='USD'&&!Number.isSafeInteger(s.nativeCash?.[k]))fail('CASH_RECONCILIATION');
  for(const[k,v]of Object.entries(s.positions))if(!/^[1-9]\d*$/.test(k)||typeof v!=='string'||!/^\d{1,29}$/.test(v)||BigInt(v)>10n**28n)fail('CASH_RECONCILIATION');
  for(const[k,v]of Object.entries(s.foreignCurrencies||{}))if(!Object.hasOwn(s.positions,k)||!/^[A-Z]{3}$/.test(v)||v==='USD'||s.marks[k]!==null)fail('CASH_RECONCILIATION');
}
function cashDatePassive(a,b,except=null){
  if(ibCanonical(a.cashCurrency)!==ibCanonical(b.cashCurrency)||ibCanonical(a.nativeCash||{})!==ibCanonical(b.nativeCash||{})||ibCanonical(a.foreignCurrencies||{})!==ibCanonical(b.foreignCurrencies||{}))fail('CASH_RECONCILIATION');
  for(const k of Object.keys(a.cash))if(k!==String(except)&&a.cashCurrency[k]==='USD'&&a.cash[k]!==b.cash[k])fail('CASH_RECONCILIATION');
}
function validateCashDateNormalization(p,source){
  if(!exact(p,['schema','portfolioIdentityHash','windowFrom','windowThrough','anchorKind','anchor','rawBefore','rawAfter','trade','cashLeg','proofId'])||p.schema!=='fee-console.ib-cash-date-normalization.v1'||!['window','checkpoint'].includes(p.anchorKind)||![p.windowFrom,p.windowThrough].every(isCalendarDate)||inclusiveDays(p.windowFrom,p.windowThrough)<2||inclusiveDays(p.windowFrom,p.windowThrough)>9)fail('CASH_RECONCILIATION');
  const t=p.trade,l=p.cashLeg,a=p.anchor,b=p.rawBefore,c=p.rawAfter;
  for(const s of [a,b,c])cashDateSnapshot(s);
  if(!exact(t,['id','portfolioId','holdingId','date','kind','quantityAtoms','valueCents','currency'])||!exact(l,['id','cashId','tradeId','holdingId','dateTime','amountCents','balanceCents','type','payoutId'])||![t.id,t.portfolioId,t.holdingId,l.id,l.cashId].every(v=>Number.isSafeInteger(v)&&v>0)||!['BUY','SELL'].includes(t.kind)||t.currency!=='USD'||typeof t.quantityAtoms!=='string'||!/^\d{1,29}$/.test(t.quantityAtoms)||BigInt(t.quantityAtoms)<=0n||BigInt(t.quantityAtoms)>10n**28n||![t.valueCents,l.amountCents,l.balanceCents].every(Number.isSafeInteger))fail('CASH_RECONCILIATION');
  if(p.portfolioIdentityHash!==hash({name:NAME,id:t.portfolioId,currency:'USD'})||l.tradeId!==t.id||l.holdingId!==t.holdingId||l.payoutId!==null||l.dateTime!==t.date+'T00:00:00.000Z'||l.type!==(t.kind==='BUY'?'BUY TRADE':'SELL TRADE')||!l.amountCents||(t.kind==='BUY')!==(l.amountCents<0)||BigInt(l.amountCents)+BigInt(t.valueCents)!==0n||c.d!==t.date||add(b.d,1)!==c.d||b.d<p.windowFrom||c.d>p.windowThrough)fail('CASH_RECONCILIATION');
  const opening=l.balanceCents-l.amountCents;
  if(!Number.isSafeInteger(opening)||[a,b,c].some(s=>s.cashCurrency[l.cashId]!=='USD'||s.foreignCurrencies?.[t.holdingId])||a.cash[l.cashId]!==opening||b.cash[l.cashId]!==l.balanceCents||c.cash[l.cashId]!==l.balanceCents||a.d!==(p.anchorKind==='window'?add(b.d,-1):b.d)||a.d<p.windowFrom)fail('CASH_RECONCILIATION');
  cashDatePassive(a,b,l.cashId);cashDatePassive(b,c,l.cashId);
  if(ibCanonical(a.positions)!==ibCanonical(b.positions))fail('CASH_RECONCILIATION');
  for(const k of new Set([...Object.keys(b.positions),...Object.keys(c.positions)]))if(BigInt(c.positions[k]||'0')-BigInt(b.positions[k]||'0')!==(k===String(t.holdingId)?(t.kind==='BUY'?1n:-1n)*BigInt(t.quantityAtoms):0n))fail('CASH_RECONCILIATION');
  const corrected=structuredClone(b);corrected.cash[l.cashId]=opening;corrected.totalCents+=opening-b.cash[l.cashId];
  cashDateSnapshot(corrected);
  if(p.anchorKind==='checkpoint'&&ibCanonical(corrected)!==ibCanonical(a))fail('PAST_POINT_CHANGED');
  const {proofId,...body}=p;if(hash(body)!==proofId)fail('CASH_RECONCILIATION');
  if(source){
    if(source.schema!=='fee-console.ib-manager-source.v3'||p.portfolioIdentityHash!==source.portfolioIdentityHash||b.d<=source.baselineAsOf||p.windowThrough>source.sourceAsOf||source.noncashProofs.some(x=>x.tradeId===t.id))fail('CASH_RECONCILIATION');
    for(const s of [a,corrected,c])if(ibMoneyCents(source.periodReturnsInput.points.find(x=>x.d===s.d)?.tot)!==s.totalCents)fail('CASH_RECONCILIATION');
    for(const s of source.closingSnapshots)if(s.d===corrected.d&&ibCanonical(s)!==ibCanonical(corrected))fail('CASH_RECONCILIATION');
  }
  return corrected;
}
function normalizeEarlyTradeCash({reports,trades,ledger,rawCashRows,prior,baseline,coverage,portfolioId}){
  const proofs=structuredClone(prior?.cashDateNormalizations||[]),oldAnchor=prior?.closingSnapshots?.find(s=>s.d===reports[0].d);
  let mismatch=oldAnchor&&Object.keys(oldAnchor.cash).some(k=>oldAnchor.cashCurrency[k]==='USD'&&oldAnchor.cash[k]!==reports[0].cash[k]);
  for(let n=1;n<reports.length;n++)for(const k of Object.keys(reports[n].cash))if(reports[n].cashCurrency[k]==='USD'){
    const moved=ledger.filter(l=>l.cashId===Number(k)&&l.d===reports[n].d).reduce((v,l)=>v+BigInt(l.movement),0n);
    if(BigInt(reports[n].cash[k])-BigInt(reports[n-1].cash[k]||0)!==moved)mismatch=true;
  }
  if(!mismatch)return proofs;
  if(!coverage||trades.length!==1||ledger.length!==1)fail('CASH_RECONCILIATION');
  const t=trades[0],l=ledger[0],raw=rawCashRows.get(l.id),n=reports.findIndex(s=>s.d===t.transaction_date),b=reports[n-1],c=reports[n];
  if(!b||!c||b.d<=baseline.asOf||t.state!=='confirmed'||!['BUY','SELL'].includes(t.description_code)||l.external||!raw||raw.date_time!==t.transaction_date+'T00:00:00.000Z'||l.tradeId!==t.id||l.holdingId!==t.holding_id||l.payoutId!==null)fail('CASH_RECONCILIATION');
  const anchor=n>1?reports[n-2]:oldAnchor;if(!anchor)fail('CASH_RECONCILIATION');
  const body={schema:'fee-console.ib-cash-date-normalization.v1',portfolioIdentityHash:hash({name:NAME,id:portfolioId,currency:'USD'}),windowFrom:reports[0].d,windowThrough:reports.at(-1).d,anchorKind:n>1?'window':'checkpoint',anchor:structuredClone(anchor),rawBefore:structuredClone(b),rawAfter:structuredClone(c),
    trade:{id:t.id,portfolioId:t.portfolio_id,holdingId:t.holding_id,date:t.transaction_date,kind:t.description_code,quantityAtoms:quantity(t).toString(),valueCents:ibMoneyCents(t.value),currency:'USD'},
    cashLeg:{id:l.id,cashId:l.cashId,tradeId:l.tradeId,holdingId:l.holdingId,dateTime:raw.date_time,amountCents:l.movement,balanceCents:l.balance,type:l.type,payoutId:l.payoutId}};
  const proof={...body,proofId:hash(body)},corrected=validateCashDateNormalization(proof);
  const existing=proofs.find(p=>p.trade.id===t.id);
  if(existing){
    for(const k of ['rawBefore','rawAfter','trade','cashLeg'])if(ibCanonical(existing[k])!==ibCanonical(proof[k]))fail('PAST_POINT_CHANGED');
    if(ibCanonical(validateCashDateNormalization(existing))!==ibCanonical(corrected))fail('PAST_POINT_CHANGED');
  }else proofs.push(proof);
  reports[n-1]=corrected;
  return proofs;
}
export function validateIbManagerReportInput(source,expectedHash){
  if(!/^[a-f0-9]{64}$/.test(expectedHash||''))fail('BASELINE_LOCK');
  const advanced=source?.schema==='fee-console.ib-manager-source.v3',seeded=advanced||source?.schema==='fee-console.ib-manager-source.v2';
  const normalized=Object.hasOwn(source||{},'cashDateNormalizations');
  if(!exact(source,['schema','scope','currency','timezone','flowTiming','baselineFrom','baselineAsOf','baselineInputsHash','portfolioIdentityHash','sourceAsOf','sourceEvidenceHash','cashFlowByDate','noncashProofs','periodReturnsInput',...(seeded?['ownerBaseline']:[]),...(advanced?['bootstrapCoverage','closingSnapshots']:[]),...(normalized?['cashDateNormalizations']:[])])||!['fee-console.ib-manager-source.v1','fee-console.ib-manager-source.v2','fee-console.ib-manager-source.v3'].includes(source.schema)||source.scope!=='ib-manager'||source.currency!=='USD'||source.timezone!=='America/New_York'||source.flowTiming!=='eod'||!isCalendarDate(source.baselineFrom)||!isCalendarDate(source.baselineAsOf)||source.baselineAsOf<source.baselineFrom||source.baselineInputsHash!==expectedHash||!/^[a-f0-9]{64}$/.test(source.sourceEvidenceHash)||!/^[a-f0-9]{64}$/.test(source.portfolioIdentityHash)||!object(source.cashFlowByDate)||!Array.isArray(source.noncashProofs)||source.noncashProofs.length>1000)fail('SCHEMA');
  const coverage=advanced?validateIbBootstrapCoverage(source.bootstrapCoverage,expectedHash,{baselineAsOf:source.baselineAsOf}):null;
  if(coverage&&source.sourceAsOf<coverage.through)fail('STATE');
  const i=source.periodReturnsInput;business(i);
  // The audit commitment normalizes USD cents; executable source inputs must
  // already be canonical cents so hidden subcent values cannot change TWR.
  const nativeValues=seeded?[...i.points.filter(p=>p.d>source.baselineAsOf).map(p=>p.tot),...Object.entries(i.flowByDate).filter(([d])=>d>source.baselineAsOf).map(([,v])=>v)]:[i.openT,...i.points.map(p=>p.tot),...Object.values(i.flowByDate)];
  if(nativeValues.some(v=>ibMoneyCents(v)/100!==v))fail('AMOUNT');
  const sums={},events=new Set();
  if(seeded){
    const base=validateIbOwnerBaseline(source.ownerBaseline,expectedHash).input.periodReturnsInput;
    const prefix=[...i.points.filter(p=>p.d<=base.to)].sort((a,b)=>a.d.localeCompare(b.d)),original=[...base.points].sort((a,b)=>a.d.localeCompare(b.d));
    if(base.from!==source.baselineFrom||base.to!==source.baselineAsOf||i.openT!==base.openT||ibCanonical(prefix)!==ibCanonical(original)||ibCanonical(Object.fromEntries(Object.entries(i.flowByDate).filter(([d])=>d<=base.to)))!==ibCanonical(base.flowByDate))fail('BASELINE_MISMATCH');
    for(const[d,v]of Object.entries(base.flowByDate))if(ibMoneyCents(v))sums[d]=BigInt(ibMoneyCents(v));
  }
  for(const[d,v]of Object.entries(source.cashFlowByDate)){day(d);if(d<i.from||d>i.to||seeded&&d<=source.baselineAsOf||!ibMoneyCents(v)||ibMoneyCents(v)/100!==v)fail('SCHEMA');sums[d]=BigInt(ibMoneyCents(v));}
  for(const proof of source.noncashProofs){
    try{validateIbNativeNoncashProof(proof,{portfolioIdentityHash:source.portfolioIdentityHash,from:source.baselineFrom,to:source.sourceAsOf,baselineAsOf:source.baselineAsOf});if(seeded&&proof.effectiveDate<=source.baselineAsOf)fail('NONCASH_EVIDENCE');}catch{fail('NONCASH_EVIDENCE');}
    if(events.has(proof.tradeId))fail('NONCASH_EVIDENCE');events.add(proof.tradeId);sums[proof.effectiveDate]=(sums[proof.effectiveDate]||0n)+BigInt(proof.externalFlowCents);
    if(proof.authority==='reviewed-source-transfer'&&(!coverage||!coverage.events.some(e=>ibCanonical(e)===ibCanonical(proof.auditEvent))||proof.auditQuote&&!coverage.quotes.some(q=>ibCanonical(q)===ibCanonical(proof.auditQuote))))fail('NONCASH_EVIDENCE');
  }
  if(coverage){
    for(const e of coverage.events)if(source.noncashProofs.filter(p=>p.auditEvent?.eventId===e.eventId).length!==1)fail('NONCASH_EVIDENCE');
    if(!Array.isArray(source.closingSnapshots)||source.closingSnapshots.length!==2)fail('STATE');
    for(let n=0;n<2;n++){
      const s=source.closingSnapshots[n],d=add(source.sourceAsOf,n-1);
      const native=Object.hasOwn(s||{},'nativeCash'),foreign=Object.hasOwn(s||{},'foreignCurrencies');
      if(!exact(s,['d','totalCents','cash','cashCurrency','positions','marks',...(native?['nativeCash']:[]),...(foreign?['foreignCurrencies']:[])])||s.d!==d||!object(s.cash)||!object(s.cashCurrency)||!object(s.positions)||!object(s.marks)||native&&!object(s.nativeCash)||foreign&&(!object(s.foreignCurrencies)||!Object.keys(s.foreignCurrencies).length)||!Number.isSafeInteger(s.totalCents)||s.totalCents<=0||ibMoneyCents(i.points.find(p=>p.d===d)?.tot)!==s.totalCents)fail('STATE');
      for(const[k,v]of Object.entries(s.positions))if(!/^[1-9]\d*$/.test(k)||typeof v!=='string'||!/^\d{1,29}$/.test(v)||BigInt(v)>10n**28n)fail('STATE');
      if(foreign)for(const[k,v]of Object.entries(s.foreignCurrencies))if(!Object.hasOwn(s.positions,k)||!/^[A-Z]{3}$/.test(v)||v==='USD'||s.marks[k]!==null)fail('STATE');
      for(const[k,v]of Object.entries(s.cash))if(!/^[1-9]\d*$/.test(k)||!Number.isSafeInteger(v)||!/^[A-Z]{3}$/.test(s.cashCurrency[k]||'')||s.cashCurrency[k]!=='USD'&&(!native||!Number.isSafeInteger(s.nativeCash[k])))fail('STATE');
      if(native&&Object.keys(s.nativeCash).some(k=>!Object.hasOwn(s.cash,k)||s.cashCurrency[k]==='USD'||!Number.isSafeInteger(s.nativeCash[k])))fail('STATE');
    }
    const [before,after]=source.closingSnapshots;
    for(const k of new Set([...Object.keys(before.foreignCurrencies||{}),...Object.keys(after.foreignCurrencies||{})]))if(before.foreignCurrencies?.[k]!==after.foreignCurrencies?.[k]||before.positions[k]!==after.positions[k])fail('STATE');
    for(const k of new Set([...Object.keys(before.cashCurrency),...Object.keys(after.cashCurrency)]))if((after.cashCurrency[k]||before.cashCurrency[k])!=='USD'&&(after.cashCurrency[k]!==before.cashCurrency[k]||after.nativeCash?.[k]!==before.nativeCash?.[k]))fail('STATE');
  }
  const totalFlows=Object.fromEntries(Object.entries(sums).filter(([,v])=>v!==0n).map(([d,v])=>[d,v.toString()]));
  if(ibCanonical(totalFlows)!==ibCanonical(Object.fromEntries(Object.entries(i.flowByDate).filter(([,v])=>ibMoneyCents(v)).map(([d,v])=>[d,String(ibMoneyCents(v))]))))fail('NONCASH_EVIDENCE');
  if(i.from!==source.baselineFrom||i.to!==source.sourceAsOf||i.to<source.baselineAsOf||ibBaselineBusinessHash(i,source.baselineAsOf)!==expectedHash)fail('BASELINE_MISMATCH');
  if(normalized){
    if(!advanced||!Array.isArray(source.cashDateNormalizations)||!source.cashDateNormalizations.length||source.cashDateNormalizations.length>1000)fail('CASH_RECONCILIATION');
    const ids=new Set(),dates=new Set();for(const p of source.cashDateNormalizations){validateCashDateNormalization(p,source);if(ids.has(p.trade.id)||dates.has(p.rawBefore.d))fail('CASH_RECONCILIATION');ids.add(p.trade.id);dates.add(p.rawBefore.d);}
  }
  return structuredClone(source);
}
function nyBusinessDate(text){
  if(typeof text!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(text)||!Number.isFinite(Date.parse(text)))fail('DATE');
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(text)).map(x=>[x.type,x.value]));
  const d=p.year+'-'+p.month+'-'+p.day;
  // Never repair a source business date with an assumed +/- one-day shift.
  if(d!==text.slice(0,10))fail('DATE_ALIGNMENT');return day(d);
}

// A native Payout's exact UTC-midnight timestamp is a date carrier only when
// the independently read, confirmed Sharesight payout proves that same date,
// holding, portfolio, USD currency and net cash. No memo or +/- day heuristic.
function nativePayoutDateProof(p,row,portfolioId){
  complete(p);
  if(p.id!==row.payout_id||p.portfolio_id!==portfolioId||p.holding_id!==row.holding_id
    ||p.currency!=='USD'||p.confirmed!==true||p.state!=='confirmed'
    ||p.non_taxable!==false||p.tax_credit!==0||!isCalendarDate(p.paid_on)
    ||row.date_time!==p.paid_on+'T00:00:00.000Z')fail('DATE_ALIGNMENT');
  const gross=cashAmount(p,'gross_amount'),tax=cashAmount(p,'resident_withholding_tax'),net=cashAmount(p,'amount');
  if(gross<=0||tax<0||net<=0||cashAmount(p,'tax_credit')!==0||gross-tax!==net||net!==cashAmount(row,'amount'))fail('AMOUNT');
  return {id:p.id,portfolioId,holdingId:p.holding_id,paidOn:p.paid_on,currency:p.currency,
    grossCents:gross,taxCents:tax,netCents:net,cashId:row.cash_account_id,cashRecordId:row.id,dateTime:row.date_time};
}

export class SharesightIbManagerReader{
  #portfolio=null;#cash=new Set();#payouts=new Set();
  constructor({clientId,clientSecret,fetchImpl=globalThis.fetch,timeoutMs=20000}={}){
    if(![clientId,clientSecret].every(v=>typeof v==='string'&&v.length>0&&v.length<=8192&&!/[\r\n\0]/.test(v))||typeof fetchImpl!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>30000)fail('CONFIG');
    this.clientId=clientId;this.clientSecret=clientSecret;this.fetch=fetchImpl;this.timeoutMs=timeoutMs;
  }
  async #json(url,token,body){
    const p=new URL(url),base='/api/v3/portfolios/'+this.#portfolio;
    const allowed=url===API+'/oauth2/token'||url===API+'/api/v2/portfolios.json'||p.origin===API&&this.#portfolio&&([base+'/performance',base+'/holdings',base+'/trades.json','/api/v2/portfolios/'+this.#portfolio+'/cash_accounts.json'].includes(p.pathname)||[...this.#cash].some(n=>p.pathname==='/api/v2/cash_accounts/'+n+'/cash_account_transactions.json')||[...this.#payouts].some(n=>url===API+'/api/v2/payouts/'+n+'.json'));
    if(!allowed||body&&url!==API+'/oauth2/token')fail('SCOPE');
    try{const response=await boundedJson(this.fetch,url,{method:body?'POST':'GET',headers:{Accept:'application/json',...(body?{'Content-Type':'application/x-www-form-urlencoded'}:{Authorization:'Bearer '+token})},...(body?{body}:{})},{timeoutMs:this.timeoutMs,maxBytes:2*1024*1024,requireJsonType:true,includeBytes:true});return parseSourceJson(response.bytes.toString('utf8'));}catch{fail('NETWORK');}
  }
  async #read({targetDate,expectedBaselineHash,baseline,checkpoint,ownerBaseline,bootstrapCoverage}){
    day(targetDate);day(baseline.from);day(baseline.asOf);
    if(targetDate<baseline.asOf||baseline.asOf<baseline.from)fail('DATE');
    let prior=null;
    if(checkpoint){prior=validateIbManagerReportInput(checkpoint,expectedBaselineHash);if(prior.baselineFrom!==baseline.from||prior.baselineAsOf!==baseline.asOf||targetDate<prior.sourceAsOf)fail('STATE');}
    if(ownerBaseline){ownerBaseline=validateIbOwnerBaseline(ownerBaseline,expectedBaselineHash);const i=ownerBaseline.input.periodReturnsInput;if(prior||i.from!==baseline.from||i.to!==baseline.asOf||targetDate<=baseline.asOf)fail('STATE');}
    const frozen=prior?.ownerBaseline||ownerBaseline||null;
    const coverage=prior?.bootstrapCoverage||(bootstrapCoverage?validateIbBootstrapCoverage(bootstrapCoverage,expectedBaselineHash,{baselineAsOf:baseline.asOf}):null);
    if(bootstrapCoverage&&(prior||!ownerBaseline||targetDate!==coverage.through))fail('STATE');
    const from=prior?(targetDate===prior.sourceAsOf?targetDate:add(prior.sourceAsOf,1)):ownerBaseline?add(baseline.asOf,1):baseline.from;
    const anchor=add(from,-1),count=inclusiveDays(anchor,targetDate);
    if(count>(prior||ownerBaseline?9:101))fail('HISTORY_LIMIT');
    const auth=await this.#json(API+'/oauth2/token',null,new URLSearchParams({grant_type:'client_credentials',client_id:this.clientId,client_secret:this.clientSecret}).toString());
    if(typeof auth.access_token!=='string'||!/^[A-Za-z0-9._~+/=-]{20,16384}$/.test(auth.access_token)||String(auth.token_type).toLowerCase()!=='bearer')fail('SCOPE');
    const token=auth.access_token,listing=rows(await this.#json(API+'/api/v2/portfolios.json',token),'portfolios').filter(p=>p.name===NAME);
    if(listing.length!==1||listing[0].currency_code!=='USD')fail('SCOPE');this.#portfolio=id(listing[0].id);this.#cash.clear();this.#payouts.clear();
    const base=API+'/api/v3/portfolios/'+this.#portfolio;
    const catalog=rows(await this.#json(base+'/holdings?consolidated=false',token),'holdings');
    const holdingIds=new Set(catalog.map(h=>{if(h.portfolio?.id!==this.#portfolio||h.portfolio?.name!==NAME||h.valid_position!==true)fail('IDENTITY');return id(h.id);}));
    const reports=[],foreignHoldings=new Set(),holdingCurrencies=new Map();
    for(let d=anchor;d<=targetDate;d=add(d,1)){
      const query=new URLSearchParams({consolidated:'false',end_date:d,grouping:'investment_type',include_limited:'false',include_sales:'false',report_combined:'false',start_date:d});
      const report=complete(complete(await this.#json(base+'/performance?'+query,token)).report);
      if(report.portfolio_id!==this.#portfolio||report.start_date!==d||report.end_date!==d||report.currency?.code!=='USD'||report.portfolio_tz_name!=='America/New_York'||report.include_sales!==false)fail('IDENTITY');
      if(!Array.isArray(report.holdings)||!Array.isArray(report.cash_accounts))fail('SCHEMA');
      let sum=0;const cash={},cashCurrency={},positions={},marks={},foreignCurrencies={},datedHoldingIds=new Set();
      for(const h of report.holdings){
        const currency=h.instrument_currency?.code;
        if(datedHoldingIds.has(h.id)||h.portfolio?.id!==this.#portfolio||h.portfolio?.name!==NAME||h.valid_position!==true||!/^[A-Z]{3}$/.test(currency||''))fail('IDENTITY');
        id(h.id);
        if(holdingCurrencies.has(h.id)&&holdingCurrencies.get(h.id)!==currency)fail('IDENTITY');holdingCurrencies.set(h.id,currency);
        if(currency!=='USD'){
          // The dated report is USD; value is its already converted position
          // value, not instrument_price * quantity in the trading currency.
          // This narrow path accepts passive positions only. FX trade/transfer
          // amounts still need their own proof and are rejected below.
          const listed=catalog.find(x=>x.id===h.id),a=h.instrument,b=listed?.instrument;
          if(!a||!b||a.currency_code!==currency||!['id','code','market_code','currency_code'].every(k=>a[k]!==undefined&&a[k]===b[k]))fail('IDENTITY');
          foreignHoldings.add(h.id);foreignCurrencies[h.id]=currency;
        }
        if(!holdingIds.has(h.id)){try{ibNoncashMark(d,h);}catch{fail('IDENTITY');}holdingIds.add(h.id);}datedHoldingIds.add(h.id);positions[h.id]=quantity(h).toString();try{marks[h.id]=ibNoncashMark(d,h);}catch{marks[h.id]=null;}sum+=ibMoneyCents(h.value);
      }
      for(const c of report.cash_accounts){id(c.id);if(c.portfolio?.id!==this.#portfolio||c.portfolio?.name!==NAME||!/^[A-Z]{3}$/.test(c.currency?.code||'')||Object.hasOwn(cash,c.id))fail('IDENTITY');cash[c.id]=ibMoneyCents(c.value);cashCurrency[c.id]=c.currency.code;this.#cash.add(c.id);sum+=cash[c.id];}
      const total=ibMoneyCents(report.value);if(!Number.isSafeInteger(sum)||total<=0||Math.abs(sum-total)>report.holdings.length+report.cash_accounts.length)fail('AMOUNT');reports.push({d,totalCents:total,cash,cashCurrency,positions,marks,...(Object.keys(foreignCurrencies).length?{foreignCurrencies}:{})});
    }
    const auditedEvent=t=>coverage?.events.find(e=>e.d===t.transaction_date&&e.quantityAtoms===quantity(t).toString()&&ibCanonical(e.instrument)===ibCanonical(instrumentKey(t.instrument))&&['SELL','TRANSFER_OUT'].includes(t.description_code)&&t.value===0&&t.price===0&&t.brokerage===0);
    const cashList=rows(await this.#json(API+'/api/v2/portfolios/'+this.#portfolio+'/cash_accounts.json?date='+targetDate,token),'cash_accounts');
    for(const c of cashList){if(c.portfolio_id!==this.#portfolio||c.portfolio_currency!=='USD'||c.date!==targetDate)fail('IDENTITY');this.#cash.add(id(c.id));if((reports.at(-1).cash[c.id]||0)!==cashAmount(c,'balance_in_portfolio_currency'))fail('CASH_RECONCILIATION');}
    for(const report of reports)if(Object.values(report.cashCurrency).some(c=>c!=='USD')){
      const dated=report.d===targetDate?cashList:rows(await this.#json(API+'/api/v2/portfolios/'+this.#portfolio+'/cash_accounts.json?date='+report.d,token),'cash_accounts');
      if(dated.length!==Object.keys(report.cash).length)fail('CASH_RECONCILIATION');report.nativeCash={};
      for(const c of dated){if(c.portfolio_id!==this.#portfolio||c.portfolio_currency!=='USD'||c.date!==report.d||c.currency!==report.cashCurrency[c.id]||cashAmount(c,'balance_in_portfolio_currency')!==report.cash[c.id])fail('CASH_RECONCILIATION');if(c.currency!=='USD')report.nativeCash[c.id]=cashAmount(c,'balance');else if(cashAmount(c,'balance')!==report.cash[c.id])fail('CASH_RECONCILIATION');}
    }
    const trades=rows(await this.#json(base+'/trades.json?consolidated=false&end_date='+targetDate+'&start_date='+from,token),'trades');
    for(const t of trades){if(t.portfolio_id!==this.#portfolio||!holdingIds.has(id(t.holding_id))||t.state!=='confirmed'||!isCalendarDate(t.transaction_date)||t.transaction_date<from||t.transaction_date>targetDate)fail('IDENTITY');
      if(t.instrument?.currency_code!==undefined&&t.instrument.currency_code!==holdingCurrencies.get(t.holding_id))fail('IDENTITY');
      if(foreignHoldings.has(t.holding_id))fail('UNSUPPORTED_CURRENCY');
      if(['BUY','SELL'].includes(t.description_code)&&(!Number.isFinite(t.value)||!Number.isFinite(t.quantity)||t.quantity<=0))fail('SCHEMA');
      if(t.transaction_date>baseline.asOf&&(!['BUY','SELL','SPLIT','TRANSFER_OUT'].includes(t.description_code)||(['BUY','SELL'].includes(t.description_code)&&!auditedEvent(t)&&(/transfer|in[ -]?kind|\bFOP\b|转仓/i.test(String(t.comments||''))||t.value===0))))fail('UNVERIFIED_TRANSFER');}
    const tradeIds=new Set(trades.map(t=>t.id)),tradeById=new Map(trades.map(t=>[t.id,t])),ledger=[],seen=new Set(),flowCents={},rawCashRows=new Map(),payoutProofs=[],payoutRefs=new Map();
    for(const cashId of this.#cash){
      const all=rows(await this.#json(API+'/api/v2/cash_accounts/'+cashId+'/cash_account_transactions.json?from='+from+'&to='+targetDate,token),'cash_account_transactions');
      for(const row of all){
        const movement=cashAmount(row,'amount'),linked=tradeById.get(row.trade_id),type=String(row.cash_account_transaction_type?.name||'').toUpperCase();
        // Sharesight's native trade cash uses exact UTC midnight as a business
        // date carrier. Accept it only with the independent confirmed trade's
        // same date/holding/type/direction and a USD cash account. Other cash
        // timestamps retain the original NY alignment rule; never shift a day.
        const tradeDateCarrier=typeof row.date_time==='string'&&/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(row.date_time)
          &&linked&&row.date_time.slice(0,10)===linked.transaction_date&&row.holding_id===linked.holding_id&&row.payout_id==null
          &&(linked.description_code==='BUY'&&type==='BUY TRADE'&&movement<0||linked.description_code==='SELL'&&type==='SELL TRADE'&&movement>0)
          &&reports.find(p=>p.d===linked.transaction_date)?.cashCurrency[cashId]==='USD';
        if(row.payout_id!=null)payoutRefs.set(id(row.payout_id),(payoutRefs.get(row.payout_id)||0)+1);
        let payoutDate=null;
        const rawDay=typeof row.date_time==='string'?row.date_time.slice(0,10):null;
        if(type==='PAYOUT'&&row.date_time===rawDay+'T00:00:00.000Z'&&isCalendarDate(rawDay)
          &&rawDay>=from&&rawDay<=targetDate&&row.trade_id==null&&row.payout_id!=null
          &&holdingIds.has(row.holding_id)&&movement>0&&row.cash_account_id===cashId
          &&reports.find(p=>p.d===rawDay)?.cashCurrency[cashId]==='USD'){
          if(seen.has(row.id)||payoutRefs.get(row.payout_id)!==1
            ||row.links?.portfolio&&row.links.portfolio!==API+'/api/v2/portfolios/'+this.#portfolio)fail('IDENTITY');
          this.#payouts.add(row.payout_id);
          const proof=nativePayoutDateProof(await this.#json(API+'/api/v2/payouts/'+row.payout_id+'.json',token),row,this.#portfolio);
          payoutProofs.push(proof);payoutDate=proof.paidOn;
        }
        const d=tradeDateCarrier?day(linked.transaction_date):payoutDate||nyBusinessDate(row.date_time);if(d<from||d>targetDate||row.cash_account_id!==cashId||seen.has(row.id))fail('IDENTITY');seen.add(row.id);rawCashRows.set(row.id,row);
        const report=reports.find(p=>p.d===d),currency=report.cashCurrency[cashId]||cashList.find(c=>c.id===cashId)?.currency;
        cashAmount(row,'balance');
        if(currency!=='USD'){
          // Unchanged native cash can reprice in USD inside NAV. Native cash
          // movement needs a separate proved FX/flow contract, never a guess.
          if(!/^[A-Z]{3}$/.test(currency||'')||movement!==0||report.nativeCash?.[cashId]!==cashAmount(row,'balance'))fail('UNSUPPORTED_CURRENCY');
          ledger.push({id:row.id,cashId,d,movement:0,balance:cashAmount(row,'balance'),currency,tradeId:row.trade_id??null,holdingId:row.holding_id??null,payoutId:row.payout_id??null,type:'ZERO_NATIVE_CASH',description:'',external:false});continue;
        }
        if(row.links?.portfolio&&row.links.portfolio!==API+'/api/v2/portfolios/'+this.#portfolio)fail('IDENTITY');
        const description=String(row.description||'');let external=false;
        if(row.trade_id!=null){if(!tradeIds.has(id(row.trade_id)))fail('IDENTITY');}
        else if(row.payout_id!=null||row.holding_id!=null){if(row.holding_id!=null&&!holdingIds.has(id(row.holding_id)))fail('IDENTITY');}
        else if(['DIVIDEND','INTEREST','FEE','TAX','COMMISSION'].includes(type)){}
        else if(type==='INTEREST_PAYMENT'){if(movement<0)fail('UNRESOLVED_FLOW');}
        else if(['DEPOSIT','WITHDRAWAL'].includes(type)){
          if(movement&&(!/\bexternal\b|\bowner\b|\bcapital (?:contribution|withdrawal)\b|\bcash contribution\b/i.test(description)||/\bBUY\b|\bSELL\b|PROCEEDS|SETTLEMENT|DIVIDEND|DISTRIBUTION|COUPON|PAYOUT|INTEREST|\bFX\b|COMMISSION|AUTOMATIC|ADJUSTMENT|GENERATED/i.test(description+' '+String(row.foreign_identifier||'')))||type==='DEPOSIT'&&movement<0||type==='WITHDRAWAL'&&movement>0)fail('UNRESOLVED_FLOW');external=true;
        }else if(movement!==0)fail('UNRESOLVED_FLOW');
        if(external)flowCents[d]=(flowCents[d]||0n)+BigInt(movement);
        ledger.push({id:row.id,cashId,d,movement,balance:cashAmount(row,'balance'),tradeId:row.trade_id??null,holdingId:row.holding_id??null,payoutId:row.payout_id??null,type,description,external});
      }
    }
    // One confirmed payout cannot prove multiple credits, including a later
    // non-midnight row or another cash account. The cash balance chain also
    // remains mandatory; neither proof supplies or adjusts a missing amount.
    if(payoutProofs.some(p=>payoutRefs.get(p.id)!==1))fail('IDENTITY');
    // A new buy/sell without matching cash could be an in-kind transfer. Never
    // treat the resulting NAV change as performance merely because it has a price.
    for(const t of trades)if(t.transaction_date>baseline.asOf&&['BUY','SELL'].includes(t.description_code)&&!auditedEvent(t)){
      const legs=ledger.filter(p=>p.tradeId===t.id);
      const net=legs.reduce((sum,p)=>sum+BigInt(p.movement),0n)+BigInt(ibMoneyCents(t.value));
      if(!legs.length||legs.some(p=>p.d!==t.transaction_date)||net>1n||net< -1n)fail('UNVERIFIED_TRANSFER');
    }
    // Future quantity changes also need complete, cash-settled trade evidence.
    // Unsupported splits/asset transfers stay unavailable rather than becoming loss.
    for(let n=1;n<reports.length;n++)if(reports[n].d>baseline.asOf){
      const current=reports[n],previous=reports[n-1];
      for(const holding of holdingIds){
        const ts=trades.filter(t=>t.holding_id===holding&&t.transaction_date===current.d);
        if(ts.some(t=>!['BUY','SELL','TRANSFER_OUT'].includes(t.description_code)))fail('UNVERIFIED_TRANSFER');
        const before=BigInt(previous.positions[holding]||'0'),after=BigInt(current.positions[holding]||'0');
        const change=ts.reduce((sum,t)=>sum+(t.description_code==='BUY'?quantity(t):-quantity(t)),0n);
        if(after-before!==change)fail('UNVERIFIED_TRANSFER');
      }
    }
    const cashDateNormalizations=normalizeEarlyTradeCash({reports,trades,ledger,rawCashRows,prior,baseline,coverage,portfolioId:this.#portfolio});
    for(let n=1;n<reports.length;n++)for(const cashId of this.#cash){
      const current=reports[n],previous=reports[n-1];if((current.cashCurrency[cashId]||previous.cashCurrency[cashId])!=='USD'){
        if(current.cashCurrency[cashId]!==previous.cashCurrency[cashId]||current.nativeCash?.[cashId]!==previous.nativeCash?.[cashId])fail('UNSUPPORTED_CURRENCY');continue;
      }
      const movements=ledger.filter(p=>p.cashId===cashId&&p.d===current.d).reduce((sum,p)=>sum+BigInt(p.movement),0n);
      if(BigInt(current.cash[cashId]||0)-BigInt(previous.cash[cashId]||0)!==movements)fail('CASH_RECONCILIATION');
      const edges=new Map(),group=ledger.filter(p=>p.cashId===cashId&&p.d===current.d);
      for(const p of group){const before=p.balance-p.movement;if(!edges.has(before))edges.set(before,[]);edges.get(before).push(p.balance);}
      const stack=[previous.cash[cashId]||0],path=[];
      while(stack.length){const out=edges.get(stack.at(-1));if(out?.length)stack.push(out.pop());else path.push(stack.pop());}
      if(path.length!==group.length+1||path[0]!== (current.cash[cashId]||0))fail('CASH_RECONCILIATION');
    }
    if(prior){const previous=prior.periodReturnsInput.points.find(p=>p.d===anchor);if(!previous||ibMoneyCents(previous.tot)!==reports[0].totalCents)fail('PAST_POINT_CHANGED');}
    if(prior?.closingSnapshots){const old=prior.closingSnapshots.find(p=>p.d===anchor);if(!old||ibCanonical(old)!==ibCanonical(reports[0]))fail('PAST_POINT_CHANGED');}
    if(ownerBaseline&&ibMoneyCents(ownerBaseline.input.periodReturnsInput.points.find(p=>p.d===anchor)?.tot)!==reports[0].totalCents)fail('PAST_POINT_CHANGED');
    const identityHash=hash({name:NAME,id:this.#portfolio,currency:'USD'});
    const noncashProofs=prior?prior.noncashProofs.filter(p=>p.effectiveDate<from).map(p=>structuredClone(p)):[];
    for(const t of trades)if(t.transaction_date<=baseline.asOf&&t.description_code==='SELL'&&t.value===0||t.transaction_date>baseline.asOf&&(t.description_code==='TRANSFER_OUT'||auditedEvent(t))){
      try{
        const current=reports.find(p=>p.d===t.transaction_date),before=reports.find(p=>p.d===add(t.transaction_date,-1))?.marks[t.holding_id];
        const after=current?.marks[t.holding_id]||before&&{...before,d:t.transaction_date,quantityAtoms:'0',valueCents:0,absenceEvidenceHash:hash(current)};
        const event=auditedEvent(t),auditQuote=event?coverage.quotes.find(q=>q.d===event.d&&ibCanonical(q.instrument)===ibCanonical(event.instrument))||null:null;
        let closingMark=null;
        if(after?.quantityAtoms==='0'&&!auditQuote){
          const others=Object.values(reports.find(p=>p.d===t.transaction_date)?.marks||{}).filter(m=>m&&m.holdingId!==t.holding_id&&m.instrumentIdentityHash===after.instrumentIdentityHash&&BigInt(m.quantityAtoms)>0n);
          const nativePriced=t.description_code==='TRANSFER_OUT'&&t.price>0&&Number.isFinite(t.value)&&t.value!==0&&t.brokerage===0;
          if(others.length===1)closingMark=others[0];else if(others.length!==0||!nativePriced)fail('NONCASH_EVIDENCE');
        }
        noncashProofs.push(buildIbNativeNoncashProof({portfolioId:this.#portfolio,portfolioIdentityHash:identityHash,trade:t,before,after,closingMark,...(event?{auditEvent:event,auditQuote:after?.quantityAtoms==='0'?auditQuote:null}:{}),cashLegs:ledger.filter(p=>p.tradeId===t.id),sameDayTrades:trades.filter(x=>x.holding_id===t.holding_id&&x.transaction_date===t.transaction_date),catalogInstrument:catalog.find(h=>h.id===t.holding_id)?.instrument||t.instrument,authority:event?'reviewed-source-transfer':t.transaction_date>baseline.asOf?'source-native-transfer':'audited-baseline-source-native'}));
      }catch{fail('NONCASH_EVIDENCE');}
    }
    const previousInput=prior?.periodReturnsInput||ownerBaseline?.input.periodReturnsInput;
    const points=previousInput?previousInput.points.filter(p=>p.d<from).map(p=>({...p})):[],flows=previousInput?{...previousInput.flowByDate}:{},cashFlowByDate=prior?{...prior.cashFlowByDate}:{};
    for(const d of Object.keys(flows))if(d>=from)delete flows[d];
    for(const d of Object.keys(cashFlowByDate))if(d>=from)delete cashFlowByDate[d];
    for(const p of reports.slice(1))points.push({d:p.d,tot:p.totalCents/100});
    for(const[d,v]of Object.entries(flowCents))if(v){if(v>100000000000000n||v< -100000000000000n)fail('AMOUNT');flows[d]=cashFlowByDate[d]=Number(v)/100;}
    for(const p of noncashProofs)if(p.effectiveDate>=from)flows[p.effectiveDate]=(Math.round((flows[p.effectiveDate]||0)*100)+p.externalFlowCents)/100;
    const input={points,openT:previousInput?previousInput.openT:reports[0].totalCents/100,from:baseline.from,to:targetDate,days:inclusiveDays(baseline.from,targetDate),flowByDate:flows,rate:0,cr:0,cumBefore:0,hwmBefore:0};
    const last=reports.at(-1);
    if(prior&&prior.portfolioIdentityHash!==identityHash)fail('IDENTITY');
    const payoutEvidence=payoutProofs.length?{payoutDateProofs:payoutProofs.sort((a,b)=>a.id-b.id)}:{};
    const source={schema:coverage?'fee-console.ib-manager-source.v3':frozen?'fee-console.ib-manager-source.v2':'fee-console.ib-manager-source.v1',scope:'ib-manager',currency:'USD',timezone:'America/New_York',flowTiming:'eod',baselineFrom:baseline.from,baselineAsOf:baseline.asOf,baselineInputsHash:expectedBaselineHash,portfolioIdentityHash:identityHash,sourceAsOf:targetDate,sourceEvidenceHash:hash({identityHash,last,ledger:ledger.filter(p=>p.d===targetDate).sort((a,b)=>a.id-b.id),trades:trades.filter(t=>t.transaction_date===targetDate).sort((a,b)=>a.id-b.id),...payoutEvidence}),cashFlowByDate,noncashProofs,periodReturnsInput:input,...(frozen?{ownerBaseline:frozen}:{}),...(coverage?{bootstrapCoverage:coverage,closingSnapshots:reports.slice(-2)}:{}),...(cashDateNormalizations.length?{cashDateNormalizations}:{})};
    validateIbManagerReportInput(source,expectedBaselineHash);
    return {source,fingerprint:hash({identityHash,reports,ledger:ledger.sort((a,b)=>a.id-b.id),trades:trades.sort((a,b)=>a.id-b.id),cashList:cashList.sort((a,b)=>a.id-b.id),...payoutEvidence,...(cashDateNormalizations.length?{cashDateNormalizations}:{})})};
  }
  async readStable({targetDate,expectedBaselineHash,baseline=IB_BASELINE_WINDOW,checkpoint=null,ownerBaseline=null,bootstrapCoverage=null}={}){
    if(!/^[a-f0-9]{64}$/.test(expectedBaselineHash||''))fail('BASELINE_LOCK');
    const a=await this.#read({targetDate,expectedBaselineHash,baseline,checkpoint,ownerBaseline,bootstrapCoverage}),b=await this.#read({targetDate,expectedBaselineHash,baseline,checkpoint,ownerBaseline,bootstrapCoverage});
    if(a.fingerprint!==b.fingerprint)fail('UNSTABLE');return a.source;
  }
}
