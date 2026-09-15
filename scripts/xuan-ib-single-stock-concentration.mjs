// Pure display arithmetic for the family three-account concentration view.
// It reads only the already-normalized AI-risk rows and their cash-inclusive
// denominator. It performs no source reads and never creates a trade action.
const REVIEWED_ORDINARY_STOCKS=new Set([
  'AAOI','APO','AVGO','BE','GOOG','GOOGL','IREN','KKR','META','MRVL','MSFT','ORCL','TSEM','TSLA','VST',
]);
const normalize=value=>String(value??'').trim().toUpperCase().replace(/^BRK[./-]B$/,'BRK.B');
const moneyFromCents=value=>{
  const cents=BigInt(value),whole=(cents/100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g,','),fraction=(cents%100n).toString().padStart(2,'0');
  return `${whole}.${fraction}`;
};

export function ordinaryStockConcentrations(rows,denominatorCents,{aboveHundredths=-1n}={}) {
  const denominator=String(denominatorCents??'').trim();
  if(!Array.isArray(rows)||!/^\d+$/.test(denominator)||denominator==='0'||typeof aboveHundredths!=='bigint')return [];
  const base=BigInt(denominator),totals=new Map();
  for(const row of rows){
    // Concentration is ownership concentration, not AI-tier coverage. An
    // ordinary stock remains in this measure even if its AI coefficient is
    // explicitly excluded; only non-stock assets and BRK.B are omitted.
    if(!row||!['classified','excluded'].includes(row.status)||!/^\d+$/.test(String(row.marketValueCents??'')))continue;
    const symbol=normalize(row.symbol),namespace=String(row.namespace??'').trim().toUpperCase();
    if(!/^[A-Z0-9.]+$/.test(symbol)||symbol==='BRK.B')continue;
    const assetType=String(row.assetType??'').trim().toUpperCase();
    const ordinary=assetType?assetType==='STK':namespace==='AUTO'||REVIEWED_ORDINARY_STOCKS.has(symbol);
    if(!ordinary)continue;
    const cents=BigInt(row.marketValueCents);if(cents<=0n)continue;
    const key=symbol==='GOOGL'?'GOOG':symbol;
    totals.set(key,(totals.get(key)||0n)+cents);
  }
  return [...totals].flatMap(([symbol,cents])=>{
    const hundredths=(cents*10000n+base/2n)/base;
    if(hundredths<=aboveHundredths)return [];
    const percent=Number(hundredths)/100,label=symbol==='GOOG'?'GOOG / GOOGL':symbol;
    return [{symbol,label,percent,hundredths:String(hundredths),amount:moneyFromCents(cents),marketValueCents:String(cents)}];
  }).sort((a,b)=>b.percent-a.percent||a.label.localeCompare(b.label));
}

export const familyOrdinaryConcentrations=(rows,denominatorCents)=>
  ordinaryStockConcentrations(rows,denominatorCents,{aboveHundredths:100n});

export const largestOrdinaryStockConcentration=(rows,denominatorCents)=>
  ordinaryStockConcentrations(rows,denominatorCents)[0]??null;
