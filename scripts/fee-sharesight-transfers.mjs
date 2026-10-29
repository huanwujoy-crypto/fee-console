// Sharesight-only, same-day in-kind evidence for the original fee composite.
// No IO, approval, cash edits or fee formula. Cost base is never external flow.
import crypto from 'node:crypto';
import {exactNumberText} from './fee-cloud-source.mjs';
import {isCalendarDate} from './fee-engine.mjs';
import {sharesightCashRelations} from './fee-trade-cash-evidence.mjs';
const SCALE=10n**18n,accepted=new WeakMap();
const fail=code=>{throw Error('FEE_NONCASH_'+code);};
const id=n=>{if(!Number.isSafeInteger(n)||n<=0)fail('IDENTITY');return n;};
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const complete=p=>{if(!p||p.links?.next||p.next_page||p.pagination?.next_page||p.truncated||p.has_more||p.complete===false)fail('INCOMPLETE');return p;};
const rows=(p,key)=>{complete(p);const a=p[key];if(!Array.isArray(a)||a.length>10000||new Set(a.map(r=>id(r.id))).size!==a.length)fail('INCOMPLETE');return a;};
const quantity=r=>{const text=exactNumberText(r,'quantity'),m=/^(\d+)e(-?\d+)$/.exec(text);if(Number(text)!==r.quantity||r.quantity<0||r.quantity>1e10)fail('QUANTITY');if(text==='0')return 0n;if(!m||+m[2]<-18||+m[2]>10)fail('QUANTITY');return BigInt(m[1])*10n**BigInt(+m[2]+18);};
const quotedPrice=r=>{const text=exactNumberText(r,'price'),m=/^(\d+)e(-?\d+)$/.exec(text);if(!m||Number(text)!==r.price||r.price<=0||r.price>1e12||+m[2]<-18||+m[2]>12)fail('SOURCE_MARK');return BigInt(m[1])*10n**BigInt(+m[2]+18);};
const instrument=(r,usd=true)=>{const i=r?.instrument;if(!i||!(/^[A-Z]{3}$/.test(i.currency_code))||usd&&i.currency_code!=='USD'||!['code','market_code'].every(k=>typeof i[k]==='string'&&/^[A-Za-z0-9./^-]{1,128}$/.test(i[k])))fail('INSTRUMENT');return JSON.stringify([id(i.id),i.code,i.market_code,i.currency_code]);};
const money=(n,signed=false)=>{if(typeof n!=='number'||!Number.isFinite(n)||!signed&&n<0||Math.abs(n)>1e12||Math.abs(n*100-Math.round(n*100))>1e-5)fail('VALUATION');return BigInt(Math.round(n*100));};
function report(payload,portfolio,d){
 const r=complete(complete(payload).report);if(r.portfolio_id!==portfolio.id||r.start_date!==d||r.end_date!==d||r.currency?.code!=='USD'||r.portfolio_tz_name!=='America/New_York'||r.include_sales!==false)fail('DATE');
 const h=rows(r,'holdings'),cash=rows(r,'cash_accounts');let sum=0n;
 for(const x of [...h,...cash]){if(x.portfolio?.id!==portfolio.id||x.portfolio?.name!==portfolio.name)fail('IDENTITY');sum+=money(x.value,cash.includes(x));}
 if(sum-money(r.value)>BigInt(h.length+cash.length)||money(r.value)-sum>BigInt(h.length+cash.length))fail('VALUATION');
 for(const x of h){if(x.valid_position!==true||x.instrument_currency?.code!==x.instrument?.currency_code)fail('INSTRUMENT');instrument(x,false);quantity(x);}
 return h;
}
const previous=d=>new Date(Date.parse(d+'T00:00:00Z')-86400000).toISOString().slice(0,10);
function trades(payload,portfolio,d){return rows(payload,'trades').filter(t=>{if(t.portfolio_id!==portfolio.id||t.state!=='confirmed'||!isCalendarDate(t.transaction_date)||t.transaction_date>d)fail('TRADE');if(['BUY','SELL'].includes(t.description_code)&&(!['quantity','price','value','brokerage'].every(k=>typeof t[k]==='number'&&Number.isFinite(t[k]))||t.quantity<=0||t.price<0||t.brokerage<0))fail('TRADE');return t.transaction_date===d;});}
function cashResolution(account,portfolio,raw,targetDate,own){
 return sharesightCashRelations({account,portfolioId:portfolio.id,targetDate,trades:own,
  cashRows:Object.values(raw.cashTransactions).flatMap(p=>rows(p,'cash_account_transactions'))});
}
function noCash(payloads,trade,performance,targetDate,resolution){
 if(!payloads||typeof payloads!=='object'||Array.isArray(payloads))fail('CASH_EVIDENCE');
 const ids=rows(performance.report,'cash_accounts').map(c=>String(c.id)).sort();if(JSON.stringify(Object.keys(payloads).sort())!==JSON.stringify(ids))fail('CASH_EVIDENCE');
 for(const [cashId,payload] of Object.entries(payloads))for(const c of rows(payload,'cash_account_transactions')){if(c.cash_account_id!==Number(cashId)||typeof c.date_time!=='string'||c.date_time.slice(0,10)!==targetDate||!Number.isFinite(c.amount))fail('CASH_EVIDENCE');if(resolution.relatedCash.get(trade.id)?.includes(c.id)&&c.amount!==0)fail('CASH_LEG');}
}
// Identities are evidence selectors, never an authorization flag. A caller must
// bind them through the reviewed private input path before real use. All native
// positions, trade fields, zero cash and market valuation checks still apply.
export function validateManagedTransferIdentities(value){
 if(value==null)return null;
 const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===keys.sort().join(',');
 if(!exact(value,['schema','date','account','sourcePortfolioId','destinationPortfolioId','pairs'])||value.schema!=='fee-console.managed-transfer-identities.v1'||!isCalendarDate(value.date)||!['schwab','webull'].includes(value.account)||!Array.isArray(value.pairs)||value.pairs.length<1||value.pairs.length>7)fail('IDENTIFIED_SCOPE');
 id(value.sourcePortfolioId);id(value.destinationPortfolioId);if(value.sourcePortfolioId===value.destinationPortfolioId)fail('IDENTIFIED_SCOPE');
 const source=new Set(),destination=new Set();
 for(const p of value.pairs){if(!exact(p,['sourceTradeId','sourceHoldingId','tradeId','holdingId']))fail('IDENTIFIED_SCOPE');for(const n of Object.values(p))id(n);if(source.has(p.sourceTradeId)||destination.has(p.tradeId)||p.sourceTradeId===p.tradeId)fail('IDENTIFIED_SCOPE');source.add(p.sourceTradeId);destination.add(p.tradeId);}
 return value;
}
export function managedTransferCandidates(raw,identities=null){const selected=validateManagedTransferIdentities(identities);return rows(raw.trades,'trades').filter(t=>['OPENING_BALANCE','TRANSFER_IN','TRANSFER_OUT'].includes(t.description_code)||t.description_code==='BUY'&&selected?.pairs.some(p=>p.tradeId===t.id&&p.holdingId===t.holding_id));}
function activity(before,after,own,candidates){
 // Ordinary holdings/trades/cash are Sharesight facts. Only a selected
 // noncash capital event needs an independent position-delta reconstruction.
 const ids=new Set(candidates.map(t=>t.holding_id));
 for(const t of own.filter(t=>ids.has(t.holding_id)))if(!['BUY','SELL','OPENING_BALANCE','TRANSFER_IN','TRANSFER_OUT'].includes(t.description_code))fail('ACTIVITY_UNVERIFIED');
 for(const holdingId of ids){
  const prior=before.find(h=>h.id===holdingId),current=after.find(h=>h.id===holdingId),ts=own.filter(t=>t.holding_id===holdingId),identity=instrument(current||prior,false);
  if(prior&&current&&instrument(prior,false)!==identity||ts.some(t=>instrument(t,false)!==identity))fail('INSTRUMENT');
  const delta=ts.reduce((n,t)=>n+(['SELL','TRANSFER_OUT'].includes(t.description_code)?-quantity(t):quantity(t)),0n);
  if((current?quantity(current):0n)-(prior?quantity(prior):0n)!==delta)fail('POSITION_DELTA');
 }
}
export function buildManagedTransferProof({account,portfolio,raw,peerPortfolio,peer,targetDate,identifiedTransfers=null,managementExemptionRegistry,referenceSource=false}){
 if(typeof referenceSource!=='boolean')fail('SCOPE');
 if(!['schwab','webull'].includes(account)||!isCalendarDate(targetDate)||!portfolio||portfolio.name!==({schwab:'Schwab-HK',webull:'Webull'})[account]||peerPortfolio&&(peerPortfolio.name!=='IB-HK'||portfolio.id===peerPortfolio.id))fail('SCOPE');id(portfolio.id);if(peerPortfolio)id(peerPortfolio.id);
 const identities=validateManagedTransferIdentities(identifiedTransfers);
 if(identities&&(identities.date!==targetDate||identities.account!==account||identities.destinationPortfolioId!==portfolio.id||identities.sourcePortfolioId!==peerPortfolio?.id))fail('IDENTIFIED_SCOPE');
 const candidates=managedTransferCandidates(raw,identities);if(candidates.some(t=>t.transaction_date!==targetDate))fail('DATE');
 if(identities&&(identities.pairs.length!==candidates.length||identities.pairs.some(p=>!candidates.some(t=>t.id===p.tradeId&&t.holding_id===p.holdingId))))fail('IDENTIFIED_SCOPE');
 if(referenceSource&&!candidates.length){
  trades(raw.trades,portfolio,targetDate);
  // This is only an empty capital-event result. The source normalizer still
  // validates the complete dated report/cash records; ordinary report values
  // must not inherit this transfer-only exact-quantity/valuation contract.
  const evidence=()=>hash([portfolio,raw.performance,raw.trades,raw.cashTransactions]),proof=Object.freeze({account,targetDate,flows:Object.freeze([]),evidenceHash:evidence()});
  accepted.set(proof,()=>evidence()===proof.evidenceHash);return proof;
 }
 const after=report(raw.performance,portfolio,targetDate),own=trades(raw.trades,portfolio,targetDate);
 const before=referenceSource&&!candidates.length?[]:report(raw.previousPerformance,portfolio,previous(targetDate));
 const cashEvidence=cashResolution(account,portfolio,raw,targetDate,own);
 activity(before,after,own,candidates);
 if(!candidates.length){const evidence=()=>hash([portfolio,raw.previousPerformance,raw.performance,raw.trades,raw.cashTransactions]),proof=Object.freeze({account,targetDate,flows:Object.freeze([]),evidenceHash:evidence()});accepted.set(proof,()=>evidence()===proof.evidenceHash);return proof;}
 if(!peer||!peerPortfolio)fail('PEER_REQUIRED');
 const peerBefore=report(peer.previousPerformance,peerPortfolio,previous(targetDate)),peerAfter=report(peer.performance,peerPortfolio,targetDate),other=trades(peer.trades,peerPortfolio,targetDate),used=new Set(),flows=[];
 const peerCash=cashResolution('ib',peerPortfolio,peer,targetDate,other);
 for(const incoming of candidates){
  // TRANSFER_IN is not an accepted observed provider type yet. Do not infer it.
  const selected=identities?.pairs.find(p=>p.tradeId===incoming.id&&p.holdingId===incoming.holding_id);
  if(incoming.description_code!=='OPENING_BALANCE'&&!(incoming.description_code==='BUY'&&selected))fail('UNSUPPORTED_TYPE');
  const key=instrument(incoming),q=quantity(incoming),out=other.filter(t=>t.description_code==='TRANSFER_OUT'&&instrument(t)===key&&quantity(t)===q&&(!selected||t.id===selected.sourceTradeId&&t.holding_id===selected.sourceHoldingId));
  if(q<=0n||out.length!==1||used.has(out[0].id)||incoming.id===out[0].id)fail('PAIR_REQUIRED');const outgoing=out[0];used.add(outgoing.id);
  if(incoming.brokerage!==0||outgoing.brokerage!==0||own.filter(t=>t.holding_id===incoming.holding_id).length!==1||other.filter(t=>t.holding_id===outgoing.holding_id).length!==1)fail('AMBIGUOUS_TRADES');
  noCash(raw.cashTransactions,incoming,raw.performance,targetDate,cashEvidence);noCash(peer.cashTransactions,outgoing,peer.performance,targetDate,peerCash);
  const mark=after.filter(h=>h.id===incoming.holding_id),prior=before.filter(h=>h.id===incoming.holding_id),sourceBefore=peerBefore.filter(h=>h.id===outgoing.holding_id),sourceAfter=peerAfter.filter(h=>h.id===outgoing.holding_id);
  if(mark.length!==1||prior.length>1||sourceBefore.length!==1||sourceAfter.length>1||[...mark,...prior,...sourceBefore,...sourceAfter].some(h=>instrument(h)!==key)||quantity(mark[0])-(prior.length?quantity(prior[0]):0n)!==q||quantity(sourceBefore[0])-(sourceAfter.length?quantity(sourceAfter[0]):0n)!==q)fail('POSITION_DELTA');
  const price=quotedPrice(outgoing),denominator=SCALE*SCALE,valueNumerator=q*price*100n;
  if(valueNumerator%denominator!==0n||valueNumerator/denominator>100000000000000n)fail('VALUATION');
  const valueCents=valueNumerator/denominator;
  // Explicit transfer-out price is valuation, not cash proceeds. An opening
  // balance's price/value can instead be historical cost and is never used here.
  // Price and quantity retain their source decimal tokens. Both transfer value
  // and the independently dated receiver mark must agree exactly in cents;
  // do not round a sub-cent price or introduce a valuation tolerance.
  // Native TRANSFER_OUT may encode its value as a signed disposal. Keep
  // that raw sign in the evidence hash; only this verified transfer type may
  // use either provider convention, and its magnitude must match exactly.
  const sourceValue=money(outgoing.value,true);
  if(sourceValue!==valueCents&&sourceValue!==-valueCents||money(mark[0].value)*denominator!==quantity(mark[0])*price*100n)fail('SOURCE_MARK');
  const amount=Number(valueCents)/100,ticker=incoming.instrument.code;
  flows.push({date:targetDate,acct:account,amount,desc:'Sharesight paired in-kind transfer',type:incoming.description_code,sourceTradeId:outgoing.id,tradeId:incoming.id,holdingId:incoming.holding_id,holdingDelta:Number(q)/Number(SCALE),sourceDate:outgoing.transaction_date,destinationDate:incoming.transaction_date,sourceInstrument:ticker,destinationInstrument:ticker,sourceQuantity:Number(q)/Number(SCALE),destinationQuantity:Number(q)/Number(SCALE),evidence:'external_asset_transfer'});
 }
 const evidence=()=>hash([portfolio,peerPortfolio,raw.previousPerformance,raw.performance,raw.trades,raw.cashTransactions,peer.previousPerformance,peer.performance,peer.trades,peer.cashTransactions,identities]),proof=Object.freeze({account,targetDate,flows:Object.freeze(flows.map(f=>Object.freeze(f))),evidenceHash:evidence()});accepted.set(proof,()=>evidence()===proof.evidenceHash);return proof;
}
export function consumeManagedTransferProof(proof,account,targetDate){if(!accepted.get(proof)?.()||proof.account!==account||proof.targetDate!==targetDate)fail('PROOF');return proof.flows.map(f=>({...f}));}
