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
export function validateIbManagerReportInput(source,expectedHash){
  if(!/^[a-f0-9]{64}$/.test(expectedHash||''))fail('BASELINE_LOCK');
  const advanced=source?.schema==='fee-console.ib-manager-source.v3',seeded=advanced||source?.schema==='fee-console.ib-manager-source.v2';
  if(!exact(source,['schema','scope','currency','timezone','flowTiming','baselineFrom','baselineAsOf','baselineInputsHash','portfolioIdentityHash','sourceAsOf','sourceEvidenceHash','cashFlowByDate','noncashProofs','periodReturnsInput',...(seeded?['ownerBaseline']:[]),...(advanced?['bootstrapCoverage','closingSnapshots']:[])])||!['fee-console.ib-manager-source.v1','fee-console.ib-manager-source.v2','fee-console.ib-manager-source.v3'].includes(source.schema)||source.scope!=='ib-manager'||source.currency!=='USD'||source.timezone!=='America/New_York'||source.flowTiming!=='eod'||!isCalendarDate(source.baselineFrom)||!isCalendarDate(source.baselineAsOf)||source.baselineAsOf<source.baselineFrom||source.baselineInputsHash!==expectedHash||!/^[a-f0-9]{64}$/.test(source.sourceEvidenceHash)||!/^[a-f0-9]{64}$/.test(source.portfolioIdentityHash)||!object(source.cashFlowByDate)||!Array.isArray(source.noncashProofs)||source.noncashProofs.length>1000)fail('SCHEMA');
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
      const native=Object.hasOwn(s||{},'nativeCash');
      if(!exact(s,['d','totalCents','cash','cashCurrency','positions','marks',...(native?['nativeCash']:[])])||s.d!==d||!object(s.cash)||!object(s.cashCurrency)||!object(s.positions)||!object(s.marks)||native&&!object(s.nativeCash)||!Number.isSafeInteger(s.totalCents)||s.totalCents<=0||ibMoneyCents(i.points.find(p=>p.d===d)?.tot)!==s.totalCents)fail('STATE');
      for(const[k,v]of Object.entries(s.positions))if(!/^[1-9]\d*$/.test(k)||typeof v!=='string'||!/^\d{1,29}$/.test(v)||BigInt(v)>10n**28n)fail('STATE');
      for(const[k,v]of Object.entries(s.cash))if(!/^[1-9]\d*$/.test(k)||!Number.isSafeInteger(v)||!/^[A-Z]{3}$/.test(s.cashCurrency[k]||'')||s.cashCurrency[k]!=='USD'&&(!native||!Number.isSafeInteger(s.nativeCash[k])))fail('STATE');
      if(native&&Object.keys(s.nativeCash).some(k=>!Object.hasOwn(s.cash,k)||s.cashCurrency[k]==='USD'||!Number.isSafeInteger(s.nativeCash[k])))fail('STATE');
    }
    const [before,after]=source.closingSnapshots;
    for(const k of new Set([...Object.keys(before.cashCurrency),...Object.keys(after.cashCurrency)]))if((after.cashCurrency[k]||before.cashCurrency[k])!=='USD'&&(after.cashCurrency[k]!==before.cashCurrency[k]||after.nativeCash?.[k]!==before.nativeCash?.[k]))fail('STATE');
  }
  const totalFlows=Object.fromEntries(Object.entries(sums).filter(([,v])=>v!==0n).map(([d,v])=>[d,v.toString()]));
  if(ibCanonical(totalFlows)!==ibCanonical(Object.fromEntries(Object.entries(i.flowByDate).filter(([,v])=>ibMoneyCents(v)).map(([d,v])=>[d,String(ibMoneyCents(v))]))))fail('NONCASH_EVIDENCE');
  if(i.from!==source.baselineFrom||i.to!==source.sourceAsOf||i.to<source.baselineAsOf||ibBaselineBusinessHash(i,source.baselineAsOf)!==expectedHash)fail('BASELINE_MISMATCH');
  return structuredClone(source);
}
function nyBusinessDate(text){
  if(typeof text!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(text)||!Number.isFinite(Date.parse(text)))fail('DATE');
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(text)).map(x=>[x.type,x.value]));
  const d=p.year+'-'+p.month+'-'+p.day;
  // Never repair a source business date with an assumed +/- one-day shift.
  if(d!==text.slice(0,10))fail('DATE_ALIGNMENT');return day(d);
}

export class SharesightIbManagerReader{
  #portfolio=null;#cash=new Set();
  constructor({clientId,clientSecret,fetchImpl=globalThis.fetch,timeoutMs=20000}={}){
    if(![clientId,clientSecret].every(v=>typeof v==='string'&&v.length>0&&v.length<=8192&&!/[\r\n\0]/.test(v))||typeof fetchImpl!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>30000)fail('CONFIG');
    this.clientId=clientId;this.clientSecret=clientSecret;this.fetch=fetchImpl;this.timeoutMs=timeoutMs;
  }
  async #json(url,token,body){
    const p=new URL(url),base='/api/v3/portfolios/'+this.#portfolio;
    const allowed=url===API+'/oauth2/token'||url===API+'/api/v2/portfolios.json'||p.origin===API&&this.#portfolio&&([base+'/performance',base+'/holdings',base+'/trades.json','/api/v2/portfolios/'+this.#portfolio+'/cash_accounts.json'].includes(p.pathname)||[...this.#cash].some(n=>p.pathname==='/api/v2/cash_accounts/'+n+'/cash_account_transactions.json'));
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
    if(listing.length!==1||listing[0].currency_code!=='USD')fail('SCOPE');this.#portfolio=id(listing[0].id);this.#cash.clear();
    const base=API+'/api/v3/portfolios/'+this.#portfolio;
    const catalog=rows(await this.#json(base+'/holdings?consolidated=false',token),'holdings');
    const holdingIds=new Set(catalog.map(h=>{if(h.portfolio?.id!==this.#portfolio||h.portfolio?.name!==NAME||h.valid_position!==true)fail('IDENTITY');return id(h.id);}));
    const reports=[];
    for(let d=anchor;d<=targetDate;d=add(d,1)){
      const query=new URLSearchParams({consolidated:'false',end_date:d,grouping:'investment_type',include_limited:'false',include_sales:'false',report_combined:'false',start_date:d});
      const report=complete(complete(await this.#json(base+'/performance?'+query,token)).report);
      if(report.portfolio_id!==this.#portfolio||report.start_date!==d||report.end_date!==d||report.currency?.code!=='USD'||report.portfolio_tz_name!=='America/New_York'||report.include_sales!==false)fail('IDENTITY');
      if(!Array.isArray(report.holdings)||!Array.isArray(report.cash_accounts))fail('SCHEMA');
      let sum=0;const cash={},cashCurrency={},positions={},marks={},datedHoldingIds=new Set();
      for(const h of report.holdings){if(datedHoldingIds.has(h.id)||h.portfolio?.id!==this.#portfolio||h.portfolio?.name!==NAME||h.valid_position!==true||h.instrument_currency?.code!=='USD')fail('IDENTITY');id(h.id);if(!holdingIds.has(h.id)){try{ibNoncashMark(d,h);}catch{fail('IDENTITY');}holdingIds.add(h.id);}datedHoldingIds.add(h.id);positions[h.id]=quantity(h).toString();try{marks[h.id]=ibNoncashMark(d,h);}catch{marks[h.id]=null;}sum+=ibMoneyCents(h.value);}
      for(const c of report.cash_accounts){id(c.id);if(c.portfolio?.id!==this.#portfolio||c.portfolio?.name!==NAME||!/^[A-Z]{3}$/.test(c.currency?.code||'')||Object.hasOwn(cash,c.id))fail('IDENTITY');cash[c.id]=ibMoneyCents(c.value);cashCurrency[c.id]=c.currency.code;this.#cash.add(c.id);sum+=cash[c.id];}
      const total=ibMoneyCents(report.value);if(!Number.isSafeInteger(sum)||total<=0||Math.abs(sum-total)>report.holdings.length+report.cash_accounts.length)fail('AMOUNT');reports.push({d,totalCents:total,cash,cashCurrency,positions,marks});
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
      if(['BUY','SELL'].includes(t.description_code)&&(!Number.isFinite(t.value)||!Number.isFinite(t.quantity)||t.quantity<=0))fail('SCHEMA');
      if(t.transaction_date>baseline.asOf&&(!['BUY','SELL','SPLIT','TRANSFER_OUT'].includes(t.description_code)||(['BUY','SELL'].includes(t.description_code)&&!auditedEvent(t)&&(/transfer|in[ -]?kind|\bFOP\b|转仓/i.test(String(t.comments||''))||t.value===0))))fail('UNVERIFIED_TRANSFER');}
    const tradeIds=new Set(trades.map(t=>t.id)),ledger=[],seen=new Set(),flowCents={};
    for(const cashId of this.#cash){
      const all=rows(await this.#json(API+'/api/v2/cash_accounts/'+cashId+'/cash_account_transactions.json?from='+from+'&to='+targetDate,token),'cash_account_transactions');
      for(const row of all){const d=nyBusinessDate(row.date_time);if(d<from||d>targetDate||row.cash_account_id!==cashId||seen.has(row.id))fail('IDENTITY');seen.add(row.id);
        const report=reports.find(p=>p.d===d),currency=report.cashCurrency[cashId]||cashList.find(c=>c.id===cashId)?.currency;
        const movement=cashAmount(row,'amount');cashAmount(row,'balance');
        if(currency!=='USD'){
          // Unchanged native cash can reprice in USD inside NAV. Native cash
          // movement needs a separate proved FX/flow contract, never a guess.
          if(!/^[A-Z]{3}$/.test(currency||'')||movement!==0||report.nativeCash?.[cashId]!==cashAmount(row,'balance'))fail('UNSUPPORTED_CURRENCY');
          ledger.push({id:row.id,cashId,d,movement:0,balance:cashAmount(row,'balance'),currency,tradeId:row.trade_id??null,holdingId:row.holding_id??null,payoutId:row.payout_id??null,type:'ZERO_NATIVE_CASH',description:'',external:false});continue;
        }
        if(row.links?.portfolio&&row.links.portfolio!==API+'/api/v2/portfolios/'+this.#portfolio)fail('IDENTITY');
        const type=String(row.cash_account_transaction_type?.name||'').toUpperCase(),description=String(row.description||'');let external=false;
        if(row.trade_id!=null){if(!tradeIds.has(id(row.trade_id)))fail('IDENTITY');}
        else if(row.payout_id!=null||row.holding_id!=null){if(row.holding_id!=null&&!holdingIds.has(id(row.holding_id)))fail('IDENTITY');}
        else if(['DIVIDEND','INTEREST','FEE','TAX','COMMISSION'].includes(type)){}
        else if(['DEPOSIT','WITHDRAWAL'].includes(type)){
          if(movement&&(!/\bexternal\b|\bowner\b|\bcapital (?:contribution|withdrawal)\b|\bcash contribution\b/i.test(description)||/\bBUY\b|\bSELL\b|PROCEEDS|SETTLEMENT|DIVIDEND|DISTRIBUTION|COUPON|PAYOUT|INTEREST|\bFX\b|COMMISSION|AUTOMATIC|ADJUSTMENT|GENERATED/i.test(description+' '+String(row.foreign_identifier||'')))||type==='DEPOSIT'&&movement<0||type==='WITHDRAWAL'&&movement>0)fail('UNRESOLVED_FLOW');external=true;
        }else if(movement!==0)fail('UNRESOLVED_FLOW');
        if(external)flowCents[d]=(flowCents[d]||0n)+BigInt(movement);
        ledger.push({id:row.id,cashId,d,movement,balance:cashAmount(row,'balance'),tradeId:row.trade_id??null,holdingId:row.holding_id??null,payoutId:row.payout_id??null,type,description,external});
      }
    }
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
    const source={schema:coverage?'fee-console.ib-manager-source.v3':frozen?'fee-console.ib-manager-source.v2':'fee-console.ib-manager-source.v1',scope:'ib-manager',currency:'USD',timezone:'America/New_York',flowTiming:'eod',baselineFrom:baseline.from,baselineAsOf:baseline.asOf,baselineInputsHash:expectedBaselineHash,portfolioIdentityHash:identityHash,sourceAsOf:targetDate,sourceEvidenceHash:hash({identityHash,last,ledger:ledger.filter(p=>p.d===targetDate).sort((a,b)=>a.id-b.id),trades:trades.filter(t=>t.transaction_date===targetDate).sort((a,b)=>a.id-b.id)}),cashFlowByDate,noncashProofs,periodReturnsInput:input,...(frozen?{ownerBaseline:frozen}:{}),...(coverage?{bootstrapCoverage:coverage,closingSnapshots:reports.slice(-2)}:{})};
    validateIbManagerReportInput(source,expectedBaselineHash);
    return {source,fingerprint:hash({identityHash,reports,ledger:ledger.sort((a,b)=>a.id-b.id),trades:trades.sort((a,b)=>a.id-b.id),cashList:cashList.sort((a,b)=>a.id-b.id)})};
  }
  async readStable({targetDate,expectedBaselineHash,baseline=IB_BASELINE_WINDOW,checkpoint=null,ownerBaseline=null,bootstrapCoverage=null}={}){
    if(!/^[a-f0-9]{64}$/.test(expectedBaselineHash||''))fail('BASELINE_LOCK');
    const a=await this.#read({targetDate,expectedBaselineHash,baseline,checkpoint,ownerBaseline,bootstrapCoverage}),b=await this.#read({targetDate,expectedBaselineHash,baseline,checkpoint,ownerBaseline,bootstrapCoverage});
    if(a.fingerprint!==b.fingerprint)fail('UNSTABLE');return a.source;
  }
}
