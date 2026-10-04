// Offline public-source importer. Never fetches an account, source or credential.
import {createHash} from 'node:crypto';
export function importHoldings(raw,{fund,productId,asOf,sha256,bindings}){
  const identities={CSPX:[253743,'iShares Core S&P 500 UCITS ETF'],EIMI:[264659,'iShares Core MSCI EM IMI UCITS ETF']};
  if(!identities[fund]||identities[fund][0]!==productId)throw Error('source_fund_binding_invalid');
  if(createHash('sha256').update(raw).digest('hex')!==sha256)throw Error('source_sha_mismatch');
  const p=JSON.parse(raw),d=p.componentsByNameMap?.holdings?.containersByNameMap?.all?.dataPointsByNameMap;
  if(p.productId!==productId||d?.asOfDate?.value!==Number(asOf.replaceAll('-',''))||p.fundName!==identities[fund][1])throw Error('source_identity_or_date_mismatch');
  const fields=['isin','ticker','issueName','holdingPercent','assetClass'];
  const n=d.isin.value.length;
  if(!n||fields.some(k=>!Array.isArray(d[k]?.value)||d[k].value.length!==n))throw Error('source_columns_invalid');
  const rules=new Map();
  for(const b of bindings.filter(b=>b.fund===fund)){
    if(rules.has(b.isin)||!b.isin||!b.name||(!b.target.issuerKey&&!b.target.instrumentId))throw Error('binding_invalid');
    rules.set(b.isin,b);
  }
  const holdings=new Map(),audit=[];
  let total=0;
  for(let i=0;i<n;i++){
    const row=Object.fromEntries(fields.map(k=>[k,d[k].value[i]]));
    if(typeof row.issueName!=='string'||!Number.isFinite(row.holdingPercent))throw Error('row_invalid');
    total+=row.holdingPercent;
    const bp=Math.floor(row.holdingPercent*100+1e-8);
    let target,kind;
    if(row.assetClass==='Equity'){
      const identityValid=/^[A-Z]{2}[A-Z0-9]{10}$/.test(row.isin??'');
      const binding=identityValid?rules.get(row.isin):null;
      if(row.isin==='DE000A0Q4R85'&&binding)throw Error('nested_etf_binding_requires_underlying');
      if(binding&&binding.name!==row.issueName)throw Error('binding_name_conflict');
      target=binding?.target??{issuerKey:identityValid?'unreviewed-isin-'+row.isin:
        'unreviewed-source-row-'+createHash('sha256').update(fund+':'+asOf+':'+i+':'+row.issueName).digest('hex')};
      kind=!identityValid?'equity-identity-unverified':row.isin==='DE000A0Q4R85'?'nested-etf':'equity';
    }else if(row.assetClass==='Cash'){
      if(bp<0){audit.push({...row,kind:'negative-cash-unallocated',weightBp:bp});continue;}
      target={issuerKey:'public-fund-cash-'+fund.toLowerCase()};kind='cash';
    }else{
      // Collateral, MMF, FX and futures retain source details; never stock-classified.
      audit.push({...row,kind:'non-equity-unclassified',weightBp:bp});continue;
    }
    if(bp<0)throw Error('negative_allocated_weight');
    const key=target.issuerKey??target.instrumentId;
    const entry=holdings.get(key)??{...target,weightBp:0,weightMicroPercent:0,sourceRows:[],kind};
    entry.weightBp+=bp;entry.weightMicroPercent+=Math.round(row.holdingPercent*1_000_000);
    entry.sourceRows.push({isin:row.isin,name:row.issueName,ticker:row.ticker,weightPercent:row.holdingPercent,assetClass:row.assetClass});
    holdings.set(key,entry);audit.push({...row,kind,weightBp:bp,classificationBound:Boolean(rules.get(row.isin))});
  }
  if(Math.abs(total-100)>.01||[...holdings.values()].reduce((s,h)=>s+h.weightMicroPercent,0)>100_000_000)throw Error('source_total_invalid');
  return {holdings:[...holdings.values()],audit,totalWeightPercent:total,sourceRowCount:n,
    recordedBp:[...holdings.values()].reduce((s,h)=>s+h.weightBp,0)};
}
