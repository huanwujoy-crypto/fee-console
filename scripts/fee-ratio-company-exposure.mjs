// Pure manager-only projection of the SAME verified complete Exposure export.
// No reads, credentials, fee/NAV edits, fuzzy aliases or top-five-only reranking.
export function createFeeCompanyExposureCore(){
  const SCHEMA='fee-console.company-exposure.v1',RULE='company-economic-exposure.2026-10-28.v1';
  const fail=()=>{throw Error('RATIO_COMPANY_EXPOSURE_REFUSED');};
  const exact=(o,k)=>o&&Object.getPrototypeOf(o)===Object.prototype&&Object.keys(o).sort().join('|')===[...k].sort().join('|');
  const text=s=>typeof s==='string'&&s.length>0&&s.length<=500&&!/[\u0000-\u001f\u007f]/.test(s);
  const amount=n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<1e15;
  // This export's association contract compares USD amounts at aggregate-cent
  // precision. Sum decimal representations exactly BEFORE rounding to cents;
  // never round each constituent, compare binary floats or add an epsilon.
  function sourceCents(values){
    let numerator=0n,scale=0;
    for(const v of values){
      if(!amount(v))fail();
      const m=String(v).match(/^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/);if(!m)fail();
      let n=BigInt(m[2]+(m[3]||''))*(m[1]?-1n:1n),s=(m[3]||'').length-Number(m[4]||0)-2;
      if(s<0){n*=10n**BigInt(-s);s=0;}
      if(s>scale){numerator*=10n**BigInt(s-scale);scale=s;}
      numerator+=n*10n**BigInt(scale-s);
    }
    const d=10n**BigInt(scale),floor=numerator>=0n?numerator/d:-((-numerator+d-1n)/d),remainder=numerator-floor*d;
    return floor+(remainder*2n>=d?1n:0n);
  }
  const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
  const key=(code,market)=>JSON.stringify([code,market]);
  const accounts=xs=>xs.map(s=>s.replaceAll('&amp;','&')).sort();
  // Explicit venue-scoped aliases only. Future products require a reviewed rule.
  const rules=new Map([
    [key('VST','NYSE'),{id:'vistra',name:'Vistra',factor:1}],
    [key('VSTL','NASDAQ'),{id:'vistra',name:'Vistra',factor:2}],
    [key('GOOG','NASDAQ'),{id:'alphabet',name:'Alphabet',factor:1}],
    [key('GOOGL','NASDAQ'),{id:'alphabet',name:'Alphabet',factor:1}]
  ]);
  const identity=r=>rules.get(key(r.securityCode,r.market))||{id:'security:'+key(r.securityCode,r.market),name:r.name,factor:1};
  function contribution(r){
    if(!exact(r,['sourceRow','sourceRows','securityCode','market','name','ownership','product','basis','valueUsd'])||!Number.isSafeInteger(r.sourceRow)||r.sourceRow<1||!Array.isArray(r.sourceRows)||!r.sourceRows.length||r.sourceRows[0]!==r.sourceRow||r.sourceRows.some(n=>!Number.isSafeInteger(n)||n<1)||new Set(r.sourceRows).size!==r.sourceRows.length||![r.securityCode,r.market,r.name].every(text)||!['Direct','Underlying','Product'].includes(r.ownership)||!(r.product===null||text(r.product))||!amount(r.valueUsd))fail();
    const own=identity(r),leveragedParent=r.product==='VSTL.NASDAQ';
    let factor=own.factor,pending=false;
    if(r.ownership==='Product'){
      if(r.securityCode!=='VSTL'||r.market!=='NASDAQ'||r.product!=='VSTL.NASDAQ'||r.basis!=='product-asset-replacement'||r.valueUsd<=0)fail();
    }else if(r.ownership==='Direct'){
      if(r.product!==null||!['direct-asset-value','unknown-direct-product-value'].includes(r.basis))fail();
      if(r.basis==='unknown-direct-product-value'){factor=1;pending=true;}
    }else{
      if(r.product===null||!['source-lookthrough','unknown-parent-lookthrough','unknown-leverage-lookthrough'].includes(r.basis))fail();
      if(leveragedParent){
        if(r.basis!=='unknown-leverage-lookthrough')fail();
        factor=1;pending=true;
      }else if(!['source-lookthrough','unknown-parent-lookthrough'].includes(r.basis))fail();
      pending=pending||r.basis==='unknown-parent-lookthrough';
    }
    return {id:own.id,name:own.name,factor,pending};
  }
  function validate(model,exposure,sourceSha256){
    if(!exact(model,['schema','ruleVersion','asOf','retrievedAt','currency','sourceSha256','sourceXlsxSha256','accounts','portfolioTotalUsd','categoryTotalUsd','components'])||model.schema!==SCHEMA||model.ruleVersion!==RULE||model.currency!=='USD'||!Array.isArray(model.components)||model.components.length>100000||!/^[a-f0-9]{64}$/.test(model.sourceSha256||''))fail();
    const s=exposure?.summary;
    if(!s||model.asOf!==s.asOf||model.retrievedAt!==exposure.retrievedAt||model.sourceXlsxSha256!==s.sourceXlsxSHA256||model.portfolioTotalUsd!==s.totalValueUSD||model.categoryTotalUsd!==s.classes[3].totalValueUSD||canonical(model.accounts)!==canonical(accounts(s.accounts))||sourceSha256&&model.sourceSha256!==sourceSha256)fail();
    const ids=new Set(),companies=new Map(),pending=[];
    for(const r of model.components){
      const rule=contribution(r);for(const n of r.sourceRows){if(ids.has(n))fail();ids.add(n);}if(rule.pending)pending.push(r.securityCode+' · '+r.product);
      const c=companies.get(rule.id)||{companyId:rule.id,name:rule.name,valueUsd:0,constituents:[]};
      const valueUsd=r.valueUsd*rule.factor;if(!amount(valueUsd))fail();c.valueUsd+=valueUsd;
      c.constituents.push({sourceRows:[...r.sourceRows],securityCode:r.securityCode,market:r.market,product:r.product,basis:r.basis,sourceValueUsd:r.valueUsd,multiplier:rule.factor,valueUsd});companies.set(rule.id,c);
    }
    const top=[...companies.values()].filter(r=>r.valueUsd>0).sort((a,b)=>b.valueUsd-a.valueUsd||(a.companyId<b.companyId?-1:a.companyId>b.companyId?1:0)).slice(0,5).map(r=>({...r,portfolioWeightPct:r.valueUsd/model.portfolioTotalUsd*100,categoryWeightPct:r.valueUsd/model.categoryTotalUsd*100}));
    return {state:pending.length?'pending-source-basis':'projection-complete',pending:[...new Set(pending)].sort(),top:pending.length?null:top};
  }
  function build(raw,input,officialContext=null){
    const exposure=input?.exposure,s=exposure?.summary,b=input?.book;
    const official=raw?.schemaVersion==='sharesight-private-full-v2';
    if(!['sharesight-private-full-v1','sharesight-private-full-v2'].includes(raw?.schemaVersion)||!s||(official?raw.exposure?.asOf:raw.snapshot?.asOf)!==s.asOf||(!official&&raw.snapshot?.currency!=='USD')||s.currency!=='USD'||!Array.isArray(raw.exposure?.rows)||!Array.isArray(raw.accounts)||canonical(accounts(raw.accounts))!==canonical(accounts(s.accounts))||b?.sourceSha256!==b?.provenance?.fullSourceSha256||official&&(!officialContext||!Array.isArray(officialContext.rows)||!Array.isArray(officialContext.positions)))fail();
    const rows=official?officialContext.rows:raw.exposure.rows,positions=official?officialContext.positions:raw.directPositionsByAccount,components=[],replaced=new Set();
    // Establish a leveraged product's basis only by SAME-export linkage at the
    // existing aggregate USD-cent precision:
    // one direct asset value, its VST underlying and all its residual rows.
    // No caller flag or guessed product ratio can authorize another multiplier.
    for(const h of positions||[]){
      if(h.securityCode!=='VSTL'||h.market!=='NASDAQ'||h.fourClass!=='二级市场'||!amount(h.valueUSD)||h.valueUSD<=0)continue;
      const holdings=(positions||[]).filter(x=>x.account===h.account&&x.securityCode==='VSTL'&&x.market==='NASDAQ');
      const direct=rows.filter(r=>r.account===h.account&&r.ownership==='Direct'&&r.securityCode==='VSTL'&&r.market==='NASDAQ');
      const underlying=rows.filter(r=>r.account===h.account&&r.ownership==='Underlying'&&r.withinETF==='VSTL.NASDAQ');
      const residual=rows.filter(r=>r.account===h.account&&r.ownership==='Residual'&&r.securityCode==='VSTL'&&r.market==='NASDAQ');
      if(holdings.length!==1||direct.length>1||!underlying.length||underlying.some(r=>r.securityCode!=='VST'||r.market!=='NYSE'||r.fourClass!=='二级市场'||!amount(r.valueUSD))||residual.some(r=>r.fourClass!=='二级市场'||!amount(r.valueUSD)))continue;
      if(sourceCents([...underlying,...residual].map(r=>r.valueUSD))!==sourceCents([h.valueUSD]))continue;
      // Replace the complete product contribution with 2x its independently
      // associated asset value, INCLUDING when the old underlying already
      // contains leverage. Never add another 2x to the existing contribution.
      const sourceRows=[...underlying,...residual].map(r=>r.sourceRow).sort((a,b)=>a-b);
      if(sourceRows.some(n=>replaced.has(n)))fail();sourceRows.forEach(n=>replaced.add(n));
      components.push({sourceRow:sourceRows[0],sourceRows,securityCode:'VSTL',market:'NASDAQ',name:'VSTL',ownership:'Product',product:'VSTL.NASDAQ',basis:'product-asset-replacement',valueUsd:h.valueUSD});

    }
    // A parent ETF and its underlying rows are mutually exclusive contributions.
    const parents=new Set(rows.filter(r=>r.ownership==='Underlying'&&r.withinETF).map(r=>key(r.account,r.withinETF)));
    for(const r of rows){
      if(replaced.has(r.sourceRow))continue;
      if(r.fourClass!=='二级市场'||!['Direct','Underlying'].includes(r.ownership))continue;
      if(r.ownership==='Direct'&&parents.has(key(r.account,r.securityCode+'.'+r.market)))continue;
      const product=r.ownership==='Underlying'?r.withinETF:null;
      let basis=r.ownership==='Direct'?'direct-asset-value':'source-lookthrough',valueUsd=r.valueUSD;
      if(r.ownership==='Direct'&&r.securityCode==='VSTL'&&r.market==='NASDAQ'&&rows.filter(x=>x.account===r.account&&x.ownership==='Direct'&&x.securityCode===r.securityCode&&x.market===r.market).length!==1)basis='unknown-direct-product-value';
      if(r.ownership==='Direct'&&r.instrumentType==='ETF'){
        const asset=(positions||[]).filter(h=>h.account===r.account&&h.securityCode===r.securityCode&&h.market===r.market);
        const direct=rows.filter(x=>x.account===r.account&&x.ownership==='Direct'&&x.securityCode===r.securityCode&&x.market===r.market);
        if(r.securityCode==='VSTL'&&r.market==='NASDAQ'&&asset.length===1&&direct.length===1&&asset[0].fourClass==='二级市场'&&asset[0].valuationCurrency==='USD'&&amount(asset[0].valueUSD)&&asset[0].valueUSD>0&&sourceCents([r.valueUSD])===sourceCents([asset[0].valueUSD]))valueUsd=asset[0].valueUSD;
        else basis='unknown-direct-product-value';
      }
      if(r.ownership==='Underlying'&&!(positions||[]).some(h=>h.account===r.account&&h.securityCode+'.'+h.market===product))basis='unknown-parent-lookthrough';
      if(product==='VSTL.NASDAQ')basis='unknown-leverage-lookthrough';
      components.push({sourceRow:r.sourceRow,sourceRows:[r.sourceRow],securityCode:r.securityCode,market:r.market,name:r.name,ownership:r.ownership,product,basis,valueUsd});
    }
    components.sort((a,b)=>a.sourceRow-b.sourceRow);
    const model={schema:SCHEMA,ruleVersion:RULE,asOf:s.asOf,retrievedAt:exposure.retrievedAt,currency:'USD',sourceSha256:b.sourceSha256,sourceXlsxSha256:s.sourceXlsxSHA256,accounts:accounts(s.accounts),portfolioTotalUsd:s.totalValueUSD,categoryTotalUsd:s.classes[3].totalValueUSD,components};
    validate(model,exposure,b.sourceSha256);return model;
  }
  const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const usd=v=>'USD '+v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  function renderCompanyExposure(model,exposure,sourceSha256){
    const v=validate(model,exposure,sourceSha256);
    if(!v.top)return '<p class="ratio-key-status" role="status">公司敞口待核实：原份穿透归属或杠杆倍数依据未完整核实；保留原证券前五，不重复乘二。</p>';
    return '<table><thead><tr><th>公司／组成</th><th>经济敞口 USD</th><th>占总资产／占二级资产</th></tr></thead><tbody>'+v.top.map((r,i)=>'<tr><td>'+(i+1)+'. '+esc(r.name)+'<details><summary>组成与计算依据</summary><ul>'+r.constituents.map(c=>'<li>'+esc(c.securityCode)+' · '+esc(c.market)+(c.product?'／'+esc(c.product):'')+'：'+usd(c.sourceValueUsd)+' × '+c.multiplier+' = '+usd(c.valueUsd)+'；'+esc(({'direct-asset-value':'直接资产价值','unknown-direct-product-value':'产品资产价值／穿透依据待核实','product-asset-replacement':'整项替换：原底层＋残余已关联','source-lookthrough':'来源穿透','unknown-parent-lookthrough':'穿透归属待核实','unknown-leverage-lookthrough':'杠杆倍数待核实'})[c.basis])+'</li>').join('')+'</ul></details></td><td>'+usd(r.valueUsd)+'</td><td>'+r.portfolioWeightPct.toFixed(2)+'%／'+r.categoryWeightPct.toFixed(2)+'%</td></tr>').join('')+'</tbody></table>';
  }
  return {SCHEMA,RULE,build,validate,render:renderCompanyExposure};
}
