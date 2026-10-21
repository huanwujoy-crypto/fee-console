// Curated Sharesight recorded stocks, not IB position completeness or orders.
import {parseSharesightStockAllocation, STOCK_CLASS_TARGETS} from './xuan-ib-sharesight-allocation.mjs';
import {mapSourceSecurityType,UNMAPPED_ASSET_TYPE,SOURCE_SECURITY_TYPES} from './xuan-ib-ai-risk-input.mjs';
import {buildIbBookIssuerConcentration} from './xuan-weekly-concentration.mjs';
import {fingerprint} from './xuan-ib-run-manifest.mjs';
const fail=()=>{throw new Error('EOD_HOLDINGS_INVALID');};
const exact=(o,keys)=>{if(!o||Object.getPrototypeOf(o)!==Object.prototype||Object.keys(o).sort().join('|')!==keys.sort().join('|'))fail();};
const finite=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1e12;
const symbol=s=>typeof s==='string'&&/^[A-Z][A-Z0-9./-]{0,30}$/.test(s);
const reportOf=raw=>raw?.report??raw?.data?.report??raw?.result?.data?.report;
const unknown=reason=>({status:'unavailable',reason});
function quantity(value){
  if(value===undefined||value===null)return null;
  const n=typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value)?Number(value):value;
  if(!finite(n))fail();return n;
}
export function buildEodHoldings(snapshot,allocation,sourceDate,brokerPositionsPresent=false){
  if(!snapshot||allocation?.status!=='ready')return unknown('SOURCE_UNAVAILABLE');
  try{
    const verified=parseSharesightStockAllocation(snapshot.raw),report=reportOf(snapshot.raw);
    if(verified.dataDate!==sourceDate||Math.abs(verified.total-allocation.total)>.011)fail();
    const grouped=new Map();
    for(const h of report.holdings){
      const category=h.group_name.trim();if(!STOCK_CLASS_TARGETS.has(category))continue;
      const code=h.instrument.code.trim().toUpperCase();if(!symbol(code))fail();
      // A ticker alone does not prove the same instrument/market. Never merge
      // quantities or inflate single-name concentration across ambiguous rows.
      if(grouped.has(code))fail();
      grouped.set(code,{symbol:code,category,quantity:quantity(h.quantity),marketValueUsd:h.value});
    }
    // No silent truncation or completeness claim for a selected subset.
    if(grouped.size<1||grouped.size>60)fail();
    const rows=[...grouped.values()].sort((a,b)=>b.marketValueUsd-a.marketValueUsd||a.symbol.localeCompare(b.symbol))
      .map(r=>({...r,weightPct:r.marketValueUsd/verified.total*100}));
    return validateEodHoldings({status:'ready',source:'sharesight.ibGroupedPerformance',sourceDate,currency:'USD',
      denominator:'classified-stocks-only',total:verified.total,rows,
      concentration:{top1Pct:rows[0].weightPct,top5Pct:rows.slice(0,5).reduce((s,r)=>s+r.weightPct,0)},
      ibEodPositions:brokerPositionsPresent?'present-not-reconciled':'not-provided'},allocation,sourceDate);
  }catch{return unknown('DETAIL_UNSUPPORTED');}
}
export function validateEodHoldings(h,a,sourceDate){
  if(h?.status==='unavailable'){exact(h,['status','reason']);if(!['SOURCE_UNAVAILABLE','DETAIL_UNSUPPORTED'].includes(h.reason))fail();return h;}
  exact(h,['status','source','sourceDate','currency','denominator','total','rows','concentration','ibEodPositions']);
  if(h.status!=='ready'||h.source!=='sharesight.ibGroupedPerformance'||h.sourceDate!==sourceDate||h.currency!=='USD'
    ||h.denominator!=='classified-stocks-only'||a?.status!=='ready'||!finite(h.total)||Math.abs(h.total-a.total)>.011
    ||!['not-provided','present-not-reconciled'].includes(h.ibEodPositions)||!Array.isArray(h.rows)||h.rows.length<1||h.rows.length>60
    ||new Set(h.rows.map(r=>r.symbol)).size!==h.rows.length)fail();
  for(const r of h.rows){exact(r,['symbol','category','quantity','marketValueUsd','weightPct']);
    if(!symbol(r.symbol)||!STOCK_CLASS_TARGETS.has(r.category)||!(r.quantity===null||finite(r.quantity))
      ||!finite(r.marketValueUsd)||!finite(r.weightPct)||r.weightPct>100||Math.abs(r.marketValueUsd/h.total*100-r.weightPct)>1e-8)fail();}
  if(Math.abs(h.rows.reduce((s,r)=>s+r.marketValueUsd,0)-h.total)>.011)fail();
  for(const c of a.categories)if(Math.abs(h.rows.filter(r=>r.category===c.label).reduce((s,r)=>s+r.marketValueUsd,0)-c.marketValue)>.011)fail();
  const sorted=[...h.rows].sort((x,y)=>y.marketValueUsd-x.marketValueUsd||x.symbol.localeCompare(y.symbol));
  if(JSON.stringify(sorted)!==JSON.stringify(h.rows))fail();
  exact(h.concentration,['top1Pct','top5Pct']);
  if(!finite(h.concentration.top1Pct)||!finite(h.concentration.top5Pct)||h.concentration.top5Pct>100+1e-8
    ||Math.abs(h.concentration.top1Pct-h.rows[0].weightPct)>1e-8
    ||Math.abs(h.concentration.top5Pct-h.rows.slice(0,5).reduce((s,r)=>s+r.weightPct,0))>1e-8)fail();
  return h;
}

// Whole IB-HK book portfolio, separately from the four-class stock denominator.
// Current Sharesight values; the existing weekly issuer engine supplies the
// look-through calculation. Historical metadata supplies identity/type only.
function bookInstrumentIdentity(h,raw,sourceDate){
  const i=h.instrument;
  let metadata=i,identitySourceDate=sourceDate;
  if(raw.classification){
    const prior=raw.classification,r=reportOf(prior.raw);
    const matches=r?.holdings?.filter(old=>old.id===h.id&&old.instrument?.id===i.id
      &&old.instrument.code===i.code&&old.instrument.market_code===i.market_code
      &&(old.instrument.currency_code??old.instrument.currency?.code)===(i.currency_code??i.currency?.code));
    if(r?.portfolio_id!==936247||r.end_date!==prior.provenance?.sourceDate||r.end_date>sourceDate||matches?.length!==1)metadata=null;
    else{metadata=matches[0].instrument;identitySourceDate=r.end_date;}
  }
  const id=metadata?.id;
  const type=mapSourceSecurityType(metadata?.friendly_instrument_description_code??metadata?.friendly_instrument_description);
  return {instrumentId:Number.isSafeInteger(id)&&id>0?String(id):null,
    assetType:type.assetType,identitySourceDate:metadata?identitySourceDate:null};
}

export function bookIssuerConcentration(c){
  const micro=n=>String(BigInt(Math.round(n*100))*10000n);
  return buildIbBookIssuerConcentration({riskDenominator:{components:[{key:'ib-hk',valueMicro:micro(c.total)}]},
    riskConstituents:c.rows.filter(r=>r.instrumentId!==null&&['STK','ETF'].includes(r.assetType)).map(r=>({
      portfolioId:'936247',custodian:'IB-HK',holdingId:String(r.holdingId),instrumentId:r.instrumentId,
      symbol:r.symbol,assetType:r.assetType,identityVerified:true,valueDate:c.sourceDate,marketValueMicro:micro(r.marketValueUsd),
    }))},{cutoff:c.sourceDate});
}

export function buildBookConcentration(snapshot,sourceDate,{issuer=true}={}){
  try{
    if(!['verified','date-verified'].includes(snapshot?.status))fail();
    const r=reportOf(snapshot.raw);
    if(r?.portfolio_id!==936247||r.currency?.code!=='USD'||r.end_date!==sourceDate
      ||!Array.isArray(r.holdings)||!r.holdings.length||r.holdings.length>5000
      ||!Array.isArray(r.cash_accounts)||!r.cash_accounts.length||!finite(r.value)||r.value<=0)fail();
    const rows=r.holdings.map(h=>{
      const i=h.instrument;
      if(!Number.isSafeInteger(h.id)||h.id<=0||!symbol(i.code)||typeof i.market_code!=='string'
        ||! /^[A-Z]{3}$/.test(i.currency_code||i.currency?.code||'')||!finite(h.value))fail();
      return {holdingId:h.id,symbol:i.code,market:i.market_code,currency:i.currency_code??i.currency.code,
        marketValueUsd:h.value,weightPct:h.value/r.value*100,...(issuer?{...bookInstrumentIdentity(h,snapshot.raw,sourceDate),quantity:quantity(h.quantity),price:finite(h.instrument_price)?h.instrument_price:null}:{})};
    }).sort((a,b)=>b.marketValueUsd-a.marketValueUsd||a.holdingId-b.holdingId);
    const cash=r.cash_accounts.reduce((n,c)=>{if(!finite(c.value))fail();return n+c.value;},0);
    const c={status:'ready',source:'sharesight.ibGroupedPerformance',sourceDate,
      basis:'direct-holdings-whole-book-portfolio',currency:'USD',total:r.value,cash,rows,
      top1Pct:rows[0].weightPct,top5Pct:rows.slice(0,5).reduce((n,r)=>n+r.weightPct,0)};
    if(issuer)c.issuerResultFingerprint=fingerprint(bookIssuerConcentration(c));
    return validateBookConcentration(c,sourceDate);
  }catch{return {status:'unavailable',reason:'BOOK_CONCENTRATION_SOURCE_INCOMPLETE'};}
}
export function validateBookConcentration(c,sourceDate){
  if(c?.status==='unavailable'){
    exact(c,['status','reason']);if(c.reason!=='BOOK_CONCENTRATION_SOURCE_INCOMPLETE')fail();return c;
  }
  const issuer=Object.hasOwn(c??{},'issuerResultFingerprint');
  exact(c,['status','source','sourceDate','basis','currency','total','cash','rows','top1Pct','top5Pct',...(issuer?['issuerResultFingerprint']:[])]);
  if(c.status!=='ready'||c.source!=='sharesight.ibGroupedPerformance'||c.sourceDate!==sourceDate
    ||c.basis!=='direct-holdings-whole-book-portfolio'||c.currency!=='USD'||!finite(c.total)||c.total<=0
    ||!finite(c.cash)||!Array.isArray(c.rows)||!c.rows.length||c.rows.length>5000)fail();
  const identities=new Set(),instruments=new Set();
  for(const r of c.rows){
    exact(r,['holdingId','symbol','market','currency','marketValueUsd','weightPct',...(issuer?['instrumentId','assetType','identitySourceDate','quantity','price']:[])]);
    const key=JSON.stringify([r.holdingId,r.market,r.currency]);
    if(!Number.isSafeInteger(r.holdingId)||r.holdingId<=0||!symbol(r.symbol)||typeof r.market!=='string'
      ||! /^[A-Z0-9][A-Z0-9 ._-]{0,39}$/.test(r.market)||! /^[A-Z]{3}$/.test(r.currency)||!finite(r.marketValueUsd)||!finite(r.weightPct)
      ||Math.abs(r.weightPct-r.marketValueUsd/c.total*100)>1e-8||identities.has(key))fail();
    identities.add(key);
    if(issuer){
      if(!(r.quantity===null||finite(r.quantity))||!(r.price===null||finite(r.price))
        ||!(r.instrumentId===null||/^[1-9][0-9]{0,17}$/.test(r.instrumentId))
        ||![UNMAPPED_ASSET_TYPE,...Object.values(SOURCE_SECURITY_TYPES)].includes(r.assetType)
        ||!(r.identitySourceDate===null||/^\d{4}-\d{2}-\d{2}$/.test(r.identitySourceDate)&&r.identitySourceDate<=sourceDate))fail();
      if(r.instrumentId!==null){if(instruments.has(r.instrumentId))fail();instruments.add(r.instrumentId);}
    }
  }
  if(Math.abs(c.rows.reduce((n,r)=>n+r.marketValueUsd,c.cash)-c.total)>.011
    ||JSON.stringify(c.rows)!==JSON.stringify([...c.rows].sort((a,b)=>b.marketValueUsd-a.marketValueUsd||a.holdingId-b.holdingId))
    ||!finite(c.top1Pct)||!finite(c.top5Pct)||Math.abs(c.top1Pct-c.rows[0].weightPct)>1e-8
    ||Math.abs(c.top5Pct-c.rows.slice(0,5).reduce((n,r)=>n+r.weightPct,0))>1e-8)fail();
  if(issuer&&fingerprint(bookIssuerConcentration(c))!==c.issuerResultFingerprint)fail();
  return c;
}
