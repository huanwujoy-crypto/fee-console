// Curated Sharesight recorded stocks, not IB position completeness or orders.
import {parseSharesightStockAllocation, STOCK_CLASS_TARGETS} from './xuan-ib-sharesight-allocation.mjs';
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
