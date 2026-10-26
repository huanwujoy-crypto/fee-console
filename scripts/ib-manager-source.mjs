// Normal-report IB source only. No credential discovery, writes, scheduler or CLI.
import crypto from 'node:crypto';
import {boundedJson} from './fee-http-json.mjs';
import {isCalendarDate,inclusiveDays} from './fee-engine.mjs';
import {parseSourceJson,cashCents,exactNumberText} from './fee-cloud-source.mjs';
import {ibNoncashMark,buildIbNativeNoncashProof,validateIbNativeNoncashProof} from './ib-manager-noncash.mjs';

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
export function validateIbManagerReportInput(source,expectedHash){
  if(!/^[a-f0-9]{64}$/.test(expectedHash||''))fail('BASELINE_LOCK');
  if(!exact(source,['schema','scope','currency','timezone','flowTiming','baselineFrom','baselineAsOf','baselineInputsHash','portfolioIdentityHash','sourceAsOf','sourceEvidenceHash','cashFlowByDate','noncashProofs','periodReturnsInput'])||source.schema!=='fee-console.ib-manager-source.v1'||source.scope!=='ib-manager'||source.currency!=='USD'||source.timezone!=='America/New_York'||source.flowTiming!=='eod'||!isCalendarDate(source.baselineFrom)||!isCalendarDate(source.baselineAsOf)||source.baselineAsOf<source.baselineFrom||source.baselineInputsHash!==expectedHash||!/^[a-f0-9]{64}$/.test(source.sourceEvidenceHash)||!/^[a-f0-9]{64}$/.test(source.portfolioIdentityHash)||!object(source.cashFlowByDate)||!Array.isArray(source.noncashProofs)||source.noncashProofs.length>1000)fail('SCHEMA');
  const i=source.periodReturnsInput;business(i);
  // The audit commitment normalizes USD cents; executable source inputs must
  // already be canonical cents so hidden subcent values cannot change TWR.
  if([i.openT,...i.points.map(p=>p.tot),...Object.values(i.flowByDate)].some(v=>ibMoneyCents(v)/100!==v))fail('AMOUNT');
  const sums={},events=new Set();
  for(const[d,v]of Object.entries(source.cashFlowByDate)){day(d);if(d<i.from||d>i.to||!ibMoneyCents(v)||ibMoneyCents(v)/100!==v)fail('SCHEMA');sums[d]=BigInt(ibMoneyCents(v));}
  for(const proof of source.noncashProofs){
    try{validateIbNativeNoncashProof(proof,{portfolioIdentityHash:source.portfolioIdentityHash,from:source.baselineFrom,to:source.baselineAsOf});}catch{fail('NONCASH_EVIDENCE');}
    if(events.has(proof.tradeId))fail('NONCASH_EVIDENCE');events.add(proof.tradeId);sums[proof.effectiveDate]=(sums[proof.effectiveDate]||0n)+BigInt(proof.externalFlowCents);
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
  async #read({targetDate,expectedBaselineHash,baseline,checkpoint}){
    day(targetDate);day(baseline.from);day(baseline.asOf);
    if(targetDate<baseline.asOf||baseline.asOf<baseline.from)fail('DATE');
    let prior=null;
    if(checkpoint){prior=validateIbManagerReportInput(checkpoint,expectedBaselineHash);if(prior.baselineFrom!==baseline.from||prior.baselineAsOf!==baseline.asOf||targetDate<prior.sourceAsOf)fail('STATE');}
    const from=prior?(targetDate===prior.sourceAsOf?targetDate:add(prior.sourceAsOf,1)):baseline.from;
    const anchor=add(from,-1),count=inclusiveDays(anchor,targetDate);
    if(count>(prior?9:101))fail('HISTORY_LIMIT');
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
      for(const h of report.holdings){if(datedHoldingIds.has(h.id)||!holdingIds.has(id(h.id))||h.portfolio?.id!==this.#portfolio||h.portfolio?.name!==NAME||h.valid_position!==true||h.instrument_currency?.code!=='USD')fail('IDENTITY');datedHoldingIds.add(h.id);positions[h.id]=quantity(h).toString();try{marks[h.id]=ibNoncashMark(d,h);}catch{marks[h.id]=null;}sum+=ibMoneyCents(h.value);}
      for(const c of report.cash_accounts){id(c.id);if(c.portfolio?.id!==this.#portfolio||c.portfolio?.name!==NAME||typeof c.currency?.code!=='string'||Object.hasOwn(cash,c.id))fail('IDENTITY');cash[c.id]=ibMoneyCents(c.value);cashCurrency[c.id]=c.currency.code;this.#cash.add(c.id);sum+=cash[c.id];}
      const total=ibMoneyCents(report.value);if(!Number.isSafeInteger(sum)||total<=0||Math.abs(sum-total)>report.holdings.length+report.cash_accounts.length)fail('AMOUNT');reports.push({d,totalCents:total,cash,cashCurrency,positions,marks});
    }
    const cashList=rows(await this.#json(API+'/api/v2/portfolios/'+this.#portfolio+'/cash_accounts.json?date='+targetDate,token),'cash_accounts');
    for(const c of cashList){if(c.portfolio_id!==this.#portfolio||c.portfolio_currency!=='USD'||c.date!==targetDate)fail('IDENTITY');this.#cash.add(id(c.id));if((reports.at(-1).cash[c.id]||0)!==cashAmount(c,'balance_in_portfolio_currency'))fail('CASH_RECONCILIATION');}
    const trades=rows(await this.#json(base+'/trades.json?consolidated=false&end_date='+targetDate+'&start_date='+from,token),'trades');
    for(const t of trades){if(t.portfolio_id!==this.#portfolio||!holdingIds.has(id(t.holding_id))||t.state!=='confirmed'||!isCalendarDate(t.transaction_date)||t.transaction_date<from||t.transaction_date>targetDate)fail('IDENTITY');
      if(['BUY','SELL'].includes(t.description_code)&&(!Number.isFinite(t.value)||!Number.isFinite(t.quantity)||t.quantity<=0))fail('SCHEMA');
      if(t.transaction_date>baseline.asOf&&(/transfer|in[ -]?kind|\bFOP\b|转仓/i.test(String(t.comments||''))||!['BUY','SELL','SPLIT'].includes(t.description_code)||(t.description_code!=='SPLIT'&&t.value===0)))fail('UNVERIFIED_TRANSFER');}
    const tradeIds=new Set(trades.map(t=>t.id)),ledger=[],seen=new Set(),flowCents={};
    for(const cashId of this.#cash){
      const all=rows(await this.#json(API+'/api/v2/cash_accounts/'+cashId+'/cash_account_transactions.json?from='+from+'&to='+targetDate,token),'cash_account_transactions');
      for(const row of all){const d=nyBusinessDate(row.date_time);if(d<from||d>targetDate||row.cash_account_id!==cashId||seen.has(row.id))fail('IDENTITY');seen.add(row.id);
        const report=reports.find(p=>p.d===d),currency=report.cashCurrency[cashId]||cashList.find(c=>c.id===cashId)?.currency;
        if(currency!=='USD')fail('UNSUPPORTED_CURRENCY');
        const movement=cashAmount(row,'amount');cashAmount(row,'balance');
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
    for(const t of trades)if(t.transaction_date>baseline.asOf&&['BUY','SELL'].includes(t.description_code)){
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
        if(ts.some(t=>!['BUY','SELL'].includes(t.description_code)))fail('UNVERIFIED_TRANSFER');
        const before=BigInt(previous.positions[holding]||'0'),after=BigInt(current.positions[holding]||'0');
        const change=ts.reduce((sum,t)=>sum+(t.description_code==='BUY'?quantity(t):-quantity(t)),0n);
        if(after-before!==change)fail('UNVERIFIED_TRANSFER');
      }
    }
    for(let n=1;n<reports.length;n++)for(const cashId of this.#cash){
      const current=reports[n],previous=reports[n-1];if((current.cashCurrency[cashId]||previous.cashCurrency[cashId])!=='USD')continue;
      const movements=ledger.filter(p=>p.cashId===cashId&&p.d===current.d).reduce((sum,p)=>sum+BigInt(p.movement),0n);
      if(BigInt(current.cash[cashId]||0)-BigInt(previous.cash[cashId]||0)!==movements)fail('CASH_RECONCILIATION');
      const edges=new Map(),group=ledger.filter(p=>p.cashId===cashId&&p.d===current.d);
      for(const p of group){const before=p.balance-p.movement;if(!edges.has(before))edges.set(before,[]);edges.get(before).push(p.balance);}
      const stack=[previous.cash[cashId]||0],path=[];
      while(stack.length){const out=edges.get(stack.at(-1));if(out?.length)stack.push(out.pop());else path.push(stack.pop());}
      if(path.length!==group.length+1||path[0]!== (current.cash[cashId]||0))fail('CASH_RECONCILIATION');
    }
    if(prior){const previous=prior.periodReturnsInput.points.find(p=>p.d===anchor);if(!previous||ibMoneyCents(previous.tot)!==reports[0].totalCents)fail('PAST_POINT_CHANGED');}
    const identityHash=hash({name:NAME,id:this.#portfolio,currency:'USD'});
    const noncashProofs=prior?prior.noncashProofs.filter(p=>p.effectiveDate<from).map(p=>structuredClone(p)):[];
    for(const t of trades)if(t.transaction_date<=baseline.asOf&&t.description_code==='SELL'&&t.value===0){
      try{noncashProofs.push(buildIbNativeNoncashProof({portfolioId:this.#portfolio,portfolioIdentityHash:identityHash,trade:t,before:reports.find(p=>p.d===add(t.transaction_date,-1))?.marks[t.holding_id],after:reports.find(p=>p.d===t.transaction_date)?.marks[t.holding_id],cashLegs:ledger.filter(p=>p.tradeId===t.id),sameDayTrades:trades.filter(x=>x.holding_id===t.holding_id&&x.transaction_date===t.transaction_date),catalogInstrument:catalog.find(h=>h.id===t.holding_id)?.instrument}));}catch{fail('NONCASH_EVIDENCE');}
    }
    const points=prior?prior.periodReturnsInput.points.filter(p=>p.d<from).map(p=>({...p})):[],flows=prior?{...prior.periodReturnsInput.flowByDate}:{},cashFlowByDate=prior?{...prior.cashFlowByDate}:{};
    for(const d of Object.keys(flows))if(d>=from)delete flows[d];
    for(const d of Object.keys(cashFlowByDate))if(d>=from)delete cashFlowByDate[d];
    for(const p of reports.slice(1))points.push({d:p.d,tot:p.totalCents/100});
    for(const[d,v]of Object.entries(flowCents))if(v){if(v>100000000000000n||v< -100000000000000n)fail('AMOUNT');flows[d]=cashFlowByDate[d]=Number(v)/100;}
    for(const p of noncashProofs)if(p.effectiveDate>=from)flows[p.effectiveDate]=(Math.round((flows[p.effectiveDate]||0)*100)+p.externalFlowCents)/100;
    const input={points,openT:prior?prior.periodReturnsInput.openT:reports[0].totalCents/100,from:baseline.from,to:targetDate,days:inclusiveDays(baseline.from,targetDate),flowByDate:flows,rate:0,cr:0,cumBefore:0,hwmBefore:0};
    const last=reports.at(-1);
    if(prior&&prior.portfolioIdentityHash!==identityHash)fail('IDENTITY');
    const source={schema:'fee-console.ib-manager-source.v1',scope:'ib-manager',currency:'USD',timezone:'America/New_York',flowTiming:'eod',baselineFrom:baseline.from,baselineAsOf:baseline.asOf,baselineInputsHash:expectedBaselineHash,portfolioIdentityHash:identityHash,sourceAsOf:targetDate,sourceEvidenceHash:hash({identityHash,last,ledger:ledger.filter(p=>p.d===targetDate).sort((a,b)=>a.id-b.id),trades:trades.filter(t=>t.transaction_date===targetDate).sort((a,b)=>a.id-b.id)}),cashFlowByDate,noncashProofs,periodReturnsInput:input};
    validateIbManagerReportInput(source,expectedBaselineHash);
    return {source,fingerprint:hash({identityHash,reports,ledger:ledger.sort((a,b)=>a.id-b.id),trades:trades.sort((a,b)=>a.id-b.id),cashList:cashList.sort((a,b)=>a.id-b.id)})};
  }
  async readStable({targetDate,expectedBaselineHash,baseline=IB_BASELINE_WINDOW,checkpoint=null}={}){
    if(!/^[a-f0-9]{64}$/.test(expectedBaselineHash||''))fail('BASELINE_LOCK');
    const a=await this.#read({targetDate,expectedBaselineHash,baseline,checkpoint}),b=await this.#read({targetDate,expectedBaselineHash,baseline,checkpoint});
    if(a.fingerprint!==b.fingerprint)fail('UNSTABLE');return a.source;
  }
}
