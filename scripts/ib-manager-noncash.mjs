// Pure source-evidence math. No reads, credentials, authorization or publication.
import crypto from 'node:crypto';
import {isCalendarDate,inclusiveDays} from './fee-engine.mjs';
import {exactNumberText} from './fee-cloud-source.mjs';

const SCALE=10n**18n;
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const digest=v=>crypto.createHash('sha256').update(canonical(v)).digest('hex');
const fail=()=>{throw Error('IB_NONCASH_EVIDENCE_INVALID');};
const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===[...keys].sort().join(',');
const id=v=>{if(!Number.isSafeInteger(v)||v<=0)fail();return v;};
const hash=v=>{if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))fail();return v;};
const date=d=>{if(!isCalendarDate(d))fail();return d;};
const next=d=>new Date(Date.parse(date(d)+'T00:00:00Z')+86400000).toISOString().slice(0,10);
const atoms=v=>{if(typeof v!=='string'||!/^\d{1,29}$/.test(v)||BigInt(v)>10n**28n)fail();return BigInt(v);};
const cents=v=>{if(!Number.isSafeInteger(v)||Math.abs(v)>1e14)fail();return v;};
export function ibNoncashQuantity(row){
  try{const text=exactNumberText(row,'quantity'),m=/^(\d+)e(-?\d+)$/.exec(text);if(text==='0')return 0n;if(!m||Number(m[2])< -18||Number(m[2])>10||row.quantity<0||row.quantity>1e10)fail();return BigInt(m[1])*10n**BigInt(Number(m[2])+18);}catch{fail();}
}
function instrumentHash(i){
  if(!i||i.currency_code!=='USD'||!['code','market_code'].every(k=>typeof i[k]==='string'&&i[k].length>0&&i[k].length<=128&&!/[\u0000-\u001f\u007f]/.test(i[k])))fail();
  return digest({id:id(i.id),code:i.code,market:i.market_code,currency:i.currency_code});
}
export function ibAuditInstrument(i){
  if(!exact(i,['code','market_code','currency_code'])||i.currency_code!=='USD'||!['code','market_code'].every(k=>typeof i[k]==='string'&&i[k].length>0&&i[k].length<=128&&!/[\u0000-\u001f\u007f]/.test(i[k])))fail();return {...i};
}
const instrumentKey=i=>ibAuditInstrument({code:i.code,market_code:i.market_code,currency_code:i.currency_code});
export function validateIbAuditEvent(e){
  if(!exact(e,['d','instrument','quantityAtoms','evidenceSha256','eventId']))fail();date(e.d);ibAuditInstrument(e.instrument);if(atoms(e.quantityAtoms)<=0n)fail();hash(e.evidenceSha256);
  const {eventId,...body}=e;if(hash(eventId)!==digest(body))fail();return structuredClone(e);
}
export function validateIbAuditQuote(q){
  if(!exact(q,['d','instrument','unitPriceCents','sourceSha256','quoteId']))fail();date(q.d);ibAuditInstrument(q.instrument);if(cents(q.unitPriceCents)<=0)fail();hash(q.sourceSha256);
  const {quoteId,...body}=q;if(hash(quoteId)!==digest(body))fail();return structuredClone(q);
}
export function ibNoncashMark(d,row){
  if(typeof row.value!=='number'||!Number.isFinite(row.value)||row.value<0||row.value>1e12)fail();
  return {d:date(d),holdingId:id(row.id),instrumentIdentityHash:instrumentHash(row.instrument),quantityAtoms:ibNoncashQuantity(row).toString(),valueCents:Math.round((row.value+Number.EPSILON)*100)};
}
function validateMark(m){
  const absent=Object.hasOwn(m||{},'absenceEvidenceHash');
  if(!exact(m,['d','holdingId','instrumentIdentityHash','quantityAtoms','valueCents',...(absent?['absenceEvidenceHash']:[])]))fail();date(m.d);id(m.holdingId);hash(m.instrumentIdentityHash);atoms(m.quantityAtoms);if(cents(m.valueCents)<0)fail();if(absent&&(atoms(m.quantityAtoms)!==0n||m.valueCents!==0||!hash(m.absenceEvidenceHash)))fail();return m;
}
function markPrice(m){
  validateMark(m);const q=atoms(m.quantityAtoms),v=BigInt(cents(m.valueCents))*SCALE;
  // A zero closing position or rounded/ambiguous unit mark is not a quote.
  if(q<=0n||v<=0n||v%q!==0n)fail();const price=v/q;if(price>100000000000000n)fail();return Number(price);
}
function flowCents(q,price){const value=atoms(q)*BigInt(cents(price));if(value<=0n||value%SCALE!==0n||value/SCALE>100000000000000n)fail();return -Number(value/SCALE);}

export function buildIbNativeNoncashProof({portfolioId,portfolioIdentityHash,trade,before,after,cashLegs,sameDayTrades,catalogInstrument,authority='audited-baseline-source-native',closingMark=null,auditEvent=null,auditQuote=null}={}){
  validateMark(before);validateMark(after);const q=ibNoncashQuantity(trade),identity=instrumentHash(trade.instrument);
  const reviewed=authority==='reviewed-source-transfer',future=reviewed||authority==='source-native-transfer';
  if(!future&&authority!=='audited-baseline-source-native'||trade.portfolio_id!==id(portfolioId)||trade.state!=='confirmed'||!(reviewed?['SELL','TRANSFER_OUT']:[future?'TRANSFER_OUT':'SELL']).includes(trade.description_code)||trade.value!==0||trade.price!==0||trade.brokerage!==0||q<=0n||trade.holding_id!==before.holdingId||before.holdingId!==after.holdingId||identity!==before.instrumentIdentityHash||identity!==after.instrumentIdentityHash||identity!==instrumentHash(catalogInstrument)||trade.transaction_date!==after.d||next(before.d)!==after.d||atoms(before.quantityAtoms)-atoms(after.quantityAtoms)!==q)fail();
  if(!Array.isArray(cashLegs)||cashLegs.some(x=>x.tradeId!==trade.id||x.movement!==0)||!Array.isArray(sameDayTrades)||sameDayTrades.length!==1||sameDayTrades[0].id!==trade.id)fail();
  // Full disposal needs an independent positive position of the *same*
  // instrument in the same dated portfolio response. Zero NAV is not a quote.
  // No external quote route or yesterday-price fallback is invented here.
  if(closingMark){validateMark(closingMark);if(!future||atoms(after.quantityAtoms)!==0n||closingMark.holdingId===after.holdingId||closingMark.d!==after.d||closingMark.instrumentIdentityHash!==identity)fail();}
  if(reviewed){validateIbAuditEvent(auditEvent);if(auditEvent.d!==after.d||auditEvent.quantityAtoms!==q.toString()||canonical(auditEvent.instrument)!==canonical(instrumentKey(trade.instrument)))fail();}else if(auditEvent||auditQuote)fail();
  if(auditQuote){validateIbAuditQuote(auditQuote);if(!reviewed||closingMark||atoms(after.quantityAtoms)!==0n||auditQuote.d!==after.d||canonical(auditQuote.instrument)!==canonical(auditEvent.instrument))fail();}
  const price=auditQuote?auditQuote.unitPriceCents:markPrice(closingMark||after);
  const body={schema:'fee-console.ib-manager-noncash-proof.v1',authority,portfolioIdentityHash:hash(portfolioIdentityHash),tradeId:id(trade.id),holdingId:id(trade.holding_id),instrumentIdentityHash:identity,recordedDate:date(trade.transaction_date),effectiveDate:after.d,quantityAtoms:q.toString(),before:structuredClone(before),after:structuredClone(after),unitPriceCents:price,externalFlowCents:flowCents(q.toString(),price),...(closingMark?{closingMark:structuredClone(closingMark)}:{}),...(reviewed?{auditEvent:structuredClone(auditEvent),instrument:structuredClone(trade.instrument)}:{}),...(auditQuote?{auditQuote:structuredClone(auditQuote)}:{})};
  return {...body,proofId:digest(body)};
}
export function validateIbNativeNoncashProof(proof,{portfolioIdentityHash,from,to,baselineAsOf=to}={}){
  try{
    const p=structuredClone(proof);
    const reviewed=p.authority==='reviewed-source-transfer',future=reviewed||p.authority==='source-native-transfer',closing=Object.hasOwn(p,'closingMark'),quoted=Object.hasOwn(p,'auditQuote');
    if(!exact(p,['schema','authority','portfolioIdentityHash','tradeId','holdingId','instrumentIdentityHash','recordedDate','effectiveDate','quantityAtoms','before','after','unitPriceCents','externalFlowCents','proofId',...(closing?['closingMark']:[]),...(reviewed?['auditEvent','instrument']:[]),...(quoted?['auditQuote']:[])])||p.schema!=='fee-console.ib-manager-noncash-proof.v1'||!future&&p.authority!=='audited-baseline-source-native'||p.portfolioIdentityHash!==hash(portfolioIdentityHash)||p.effectiveDate<date(from)||p.effectiveDate>date(to)||p.recordedDate!==p.effectiveDate||future!==(p.effectiveDate>date(baselineAsOf)))fail();
    id(p.tradeId);id(p.holdingId);hash(p.instrumentIdentityHash);validateMark(p.before);validateMark(p.after);
    if(closing){validateMark(p.closingMark);if(!future||atoms(p.after.quantityAtoms)!==0n||p.closingMark.holdingId===p.holdingId||p.closingMark.d!==p.effectiveDate||p.closingMark.instrumentIdentityHash!==p.instrumentIdentityHash)fail();}
    if(reviewed){validateIbAuditEvent(p.auditEvent);if(instrumentHash(p.instrument)!==p.instrumentIdentityHash||canonical(instrumentKey(p.instrument))!==canonical(p.auditEvent.instrument)||p.auditEvent.d!==p.effectiveDate||p.auditEvent.quantityAtoms!==p.quantityAtoms)fail();}
    if(quoted){validateIbAuditQuote(p.auditQuote);if(!reviewed||closing||atoms(p.after.quantityAtoms)!==0n||p.auditQuote.d!==p.effectiveDate||canonical(p.auditQuote.instrument)!==canonical(p.auditEvent.instrument))fail();}
    if(p.before.holdingId!==p.holdingId||p.after.holdingId!==p.holdingId||p.before.instrumentIdentityHash!==p.instrumentIdentityHash||p.after.instrumentIdentityHash!==p.instrumentIdentityHash||next(p.before.d)!==p.effectiveDate||p.after.d!==p.effectiveDate||atoms(p.before.quantityAtoms)-atoms(p.after.quantityAtoms)!==atoms(p.quantityAtoms)||p.unitPriceCents!==(quoted?p.auditQuote.unitPriceCents:markPrice(p.closingMark||p.after))||p.externalFlowCents!==flowCents(p.quantityAtoms,p.unitPriceCents))fail();
    const {proofId,...body}=p;if(hash(proofId)!==digest(body))fail();return p;
  }catch{fail();}
}

// Offline candidate only. Its dates must come from separately authorized private
// audit evidence. No reader, CLI, receipt builder or private input channel calls it.
export function buildIbNoncashCorrectionCandidate({rawInput,nativeProof,marks,effectiveDate}={}){
  if(!exact(rawInput,['points','openT','from','to','days','flowByDate','rate','cr','cumBefore','hwmBefore'])||!isCalendarDate(rawInput.from)||!isCalendarDate(rawInput.to)||rawInput.to<rawInput.from||rawInput.days!==inclusiveDays(rawInput.from,rawInput.to)||rawInput.days>3660||!Number.isFinite(rawInput.openT)||rawInput.openT<=0||!rawInput.flowByDate||typeof rawInput.flowByDate!=='object'||Array.isArray(rawInput.flowByDate)||[rawInput.rate,rawInput.cr,rawInput.cumBefore,rawInput.hwmBefore].some(x=>x!==0))fail();
  for(const[d,v]of Object.entries(rawInput.flowByDate))if(!isCalendarDate(d)||d<rawInput.from||d>rawInput.to||!Number.isFinite(v)||Math.abs(v)>1e12)fail();
  const p=validateIbNativeNoncashProof(nativeProof,{portfolioIdentityHash:nativeProof?.portfolioIdentityHash,from:rawInput?.from,to:rawInput?.to});
  if(date(effectiveDate)>=p.recordedDate||effectiveDate<rawInput.from||!Array.isArray(marks)||!Array.isArray(rawInput.points)||rawInput.flowByDate?.[p.recordedDate])fail();
  let expected=date(rawInput.from);date(rawInput.to);
  for(const point of [...rawInput.points].sort((a,b)=>String(a.d).localeCompare(String(b.d)))){if(point.d!==expected||!Number.isFinite(point.tot)||point.tot<=0)fail();expected=next(expected);}
  if(expected!==next(rawInput.to))fail();
  const out=structuredClone(rawInput),window=[];let d=effectiveDate;
  while(d<p.recordedDate){
    const found=marks.filter(m=>m.d===d&&m.holdingId===p.holdingId);if(found.length!==1)fail();const mark=validateMark(found[0]);
    if(mark.instrumentIdentityHash!==p.instrumentIdentityHash||atoms(mark.quantityAtoms)<atoms(p.quantityAtoms))fail();
    const removed=-flowCents(p.quantityAtoms,markPrice(mark)),points=out.points.filter(x=>x.d===d);
    if(points.length!==1||!Number.isFinite(points[0].tot))fail();points[0].tot=(Math.round((points[0].tot+Number.EPSILON)*100)-removed)/100;if(points[0].tot<=0)fail();
    window.push({...mark,removedValueCents:removed});d=next(d);
  }
  const {removedValueCents,...firstMark}=window[0];
  const externalFlowCents=flowCents(p.quantityAtoms,markPrice(firstMark));
  out.flowByDate={...out.flowByDate,[effectiveDate]:(Math.round((out.flowByDate[effectiveDate]||0)*100)+externalFlowCents)/100};
  return {periodReturnsInput:out,correctionCandidate:{schema:'fee-console.ib-manager-noncash-correction-candidate.v1',authority:'unattached-private-audit-candidate',nativeProofId:p.proofId,effectiveDate,recordedDate:p.recordedDate,externalFlowCents,window}};
}
