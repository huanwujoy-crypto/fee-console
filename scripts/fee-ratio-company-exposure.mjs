// Pure manager-only projection of the SAME verified complete Exposure export.
// No reads, credentials, fee/NAV edits, fuzzy aliases or top-five-only reranking.
export function createFeeCompanyExposureCore(){
  const SCHEMA='fee-console.company-exposure.v1',LEGACY_RULE='company-economic-exposure.2026-10-28.v1',RULE='company-economic-exposure.2026-11-01.v2';
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
  function contribution(r,ruleVersion){
    if(!exact(r,['sourceRow','sourceRows','securityCode','market','name','ownership','product','basis','valueUsd',...(Object.hasOwn(r,'account')?['account']:[])])||!Number.isSafeInteger(r.sourceRow)||r.sourceRow<1||!Array.isArray(r.sourceRows)||!r.sourceRows.length||r.sourceRows[0]!==r.sourceRow||r.sourceRows.some(n=>!Number.isSafeInteger(n)||n<1)||new Set(r.sourceRows).size!==r.sourceRows.length||![r.securityCode,r.market,r.name].every(text)||!['Direct','Underlying','Product'].includes(r.ownership)||!(r.product===null||text(r.product))||!amount(r.valueUsd))fail();
    const own=identity(r),leveragedParent=r.product==='VSTL.NASDAQ';
    const current=ruleVersion===RULE,tqqq=r.securityCode==='TQQQ'&&r.market==='NASDAQ';
    let factor=current&&tqqq?3:own.factor,pending=false,leverage=factor;
    if(r.ownership==='Product'){
      if(r.securityCode!=='VSTL'||r.market!=='NASDAQ'||r.product!=='VSTL.NASDAQ'||r.basis!=='product-asset-replacement'||r.valueUsd<=0)fail();
    }else if(r.ownership==='Direct'){
      if(r.product!==null||!['direct-asset-value','unknown-direct-product-value'].includes(r.basis))fail();
      if(r.basis==='unknown-direct-product-value'){factor=1;pending=true;}
    }else{
      if(r.product===null||!['source-lookthrough','unknown-parent-lookthrough','unknown-leverage-lookthrough',...(current?['tqqq-asset-lookthrough','tqqq-leveraged-lookthrough']:[])].includes(r.basis))fail();
      if(current&&r.product==='TQQQ.NASDAQ'){
        leverage=3;
        if(r.basis==='tqqq-asset-lookthrough')factor=3;
        else if(r.basis==='tqqq-leveraged-lookthrough')factor=1;
        else if(['unknown-parent-lookthrough','unknown-leverage-lookthrough'].includes(r.basis)){factor=1;pending=true;}
        else fail();
      }else if(leveragedParent){
        if(r.basis!=='unknown-leverage-lookthrough')fail();
        factor=1;pending=true;
      }else if(!['source-lookthrough','unknown-parent-lookthrough'].includes(r.basis))fail();
      pending=pending||r.basis==='unknown-parent-lookthrough';
    }
    return {id:own.id,name:own.name,factor,leverage:pending?null:leverage,pending};
  }
  function validate(model,exposure,sourceSha256){
    if(!exact(model,['schema','ruleVersion','asOf','retrievedAt','currency','sourceSha256','sourceXlsxSha256','accounts','portfolioTotalUsd','categoryTotalUsd','components'])||model.schema!==SCHEMA||![LEGACY_RULE,RULE].includes(model.ruleVersion)||model.currency!=='USD'||!Array.isArray(model.components)||model.components.length>100000||!/^[a-f0-9]{64}$/.test(model.sourceSha256||''))fail();
    const s=exposure?.summary;
    if(!s||model.asOf!==s.asOf||model.retrievedAt!==exposure.retrievedAt||model.sourceXlsxSha256!==s.sourceXlsxSHA256||model.portfolioTotalUsd!==s.totalValueUSD||model.categoryTotalUsd!==s.classes[3].totalValueUSD||canonical(model.accounts)!==canonical(accounts(s.accounts))||sourceSha256&&model.sourceSha256!==sourceSha256)fail();
    const ids=new Set(),companies=new Map(),pending=[];
    for(const r of model.components){
      const rule=contribution(r,model.ruleVersion);if(Object.hasOwn(r,'account')&&(!text(r.account)||!model.accounts.includes(r.account.replaceAll('&amp;','&'))))fail();for(const n of r.sourceRows){if(ids.has(n))fail();ids.add(n);}if(rule.pending)pending.push(r.securityCode+' · '+r.product);
      const c=companies.get(rule.id)||{companyId:rule.id,name:rule.name,valueUsd:0,constituents:[]};
      const valueUsd=r.valueUsd*rule.factor;if(!amount(valueUsd))fail();c.valueUsd+=valueUsd;
      c.constituents.push({...(r.account?{account:r.account}:{}),sourceRows:[...r.sourceRows],securityCode:r.securityCode,market:r.market,product:r.product,basis:r.basis,sourceValueUsd:r.valueUsd,multiplier:rule.factor,leverage:rule.leverage,valueUsd});companies.set(rule.id,c);
    }
    const top=[...companies.values()].filter(r=>r.valueUsd>0).sort((a,b)=>b.valueUsd-a.valueUsd||(a.companyId<b.companyId?-1:a.companyId>b.companyId?1:0)).slice(0,5).map(r=>({...r,accounts:[...new Set(r.constituents.map(c=>c.account).filter(Boolean))].sort(),portfolioWeightPct:r.valueUsd/model.portfolioTotalUsd*100,categoryWeightPct:r.valueUsd/model.categoryTotalUsd*100}));
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
      components.push({sourceRow:sourceRows[0],sourceRows,securityCode:'VSTL',market:'NASDAQ',name:'VSTL',account:h.account,ownership:'Product',product:'VSTL.NASDAQ',basis:'product-asset-replacement',valueUsd:h.valueUSD});

    }
    // TQQQ's company legs remain separate from the parent asset. The same
    // export links every underlying and residual to one account/product. A
    // nonnegative residual leaves the unallocated part unassigned to companies.
    // An already-3x complete underlying is retained, never multiplied again.
    const tqqqBasis=new Map();
    for(const h of positions||[]){
      if(h.securityCode!=='TQQQ'||h.market!=='NASDAQ'||h.fourClass!=='二级市场'||!amount(h.valueUSD)||h.valueUSD<=0)continue;
      const assets=(positions||[]).filter(x=>x.account===h.account&&x.securityCode==='TQQQ'&&x.market==='NASDAQ');
      const u=rows.filter(r=>r.account===h.account&&r.ownership==='Underlying'&&r.withinETF==='TQQQ.NASDAQ');
      const residual=rows.filter(r=>r.account===h.account&&r.ownership==='Residual'&&r.securityCode==='TQQQ'&&r.market==='NASDAQ');
      if(assets.length!==1||!u.length||!residual.length||u.some(r=>r.fourClass!=='二级市场'||!amount(r.valueUSD)||r.valueUSD<0)||residual.some(r=>r.fourClass!=='二级市场'||!amount(r.valueUSD)))continue;
      const asset=sourceCents([h.valueUSD]),under=sourceCents(u.map(r=>r.valueUSD)),rest=sourceCents(residual.map(r=>r.valueUSD));
      if(sourceCents([...u,...residual].map(r=>r.valueUSD))!==asset)continue;
      if(residual.every(r=>r.valueUSD>=0)&&under<=asset)tqqqBasis.set(h.account,'tqqq-asset-lookthrough');
      else if(under===asset*3n&&rest===-asset*2n)tqqqBasis.set(h.account,'tqqq-leveraged-lookthrough');
    }
    // A parent ETF and its underlying rows are mutually exclusive contributions.
    const parents=new Set(rows.filter(r=>r.ownership==='Underlying'&&r.withinETF).map(r=>key(r.account,r.withinETF)));
    for(const r of rows){
      if(replaced.has(r.sourceRow))continue;
      if(r.fourClass!=='二级市场'||!['Direct','Underlying'].includes(r.ownership))continue;
      if(r.ownership==='Direct'&&parents.has(key(r.account,r.securityCode+'.'+r.market)))continue;
      const product=r.ownership==='Underlying'?r.withinETF:null;
      let basis=r.ownership==='Direct'?'direct-asset-value':'source-lookthrough',valueUsd=r.valueUSD;
      if(r.ownership==='Direct'&&['VSTL','TQQQ'].includes(r.securityCode)&&r.market==='NASDAQ'&&rows.filter(x=>x.account===r.account&&x.ownership==='Direct'&&x.securityCode===r.securityCode&&x.market===r.market).length!==1)basis='unknown-direct-product-value';
      if(r.ownership==='Direct'&&r.instrumentType==='ETF'){
        const asset=(positions||[]).filter(h=>h.account===r.account&&h.securityCode===r.securityCode&&h.market===r.market);
        const direct=rows.filter(x=>x.account===r.account&&x.ownership==='Direct'&&x.securityCode===r.securityCode&&x.market===r.market);
        if(['VSTL','TQQQ'].includes(r.securityCode)&&r.market==='NASDAQ'&&asset.length===1&&direct.length===1&&asset[0].fourClass==='二级市场'&&asset[0].valuationCurrency==='USD'&&amount(asset[0].valueUSD)&&asset[0].valueUSD>0&&sourceCents([r.valueUSD])===sourceCents([asset[0].valueUSD]))valueUsd=asset[0].valueUSD;
        else basis='unknown-direct-product-value';
      }
      if(r.ownership==='Underlying'&&!(positions||[]).some(h=>h.account===r.account&&h.securityCode+'.'+h.market===product))basis='unknown-parent-lookthrough';
      if(product==='VSTL.NASDAQ')basis='unknown-leverage-lookthrough';
      if(product==='TQQQ.NASDAQ')basis=tqqqBasis.get(r.account)||basis==='unknown-parent-lookthrough'&&basis||'unknown-leverage-lookthrough';
      components.push({sourceRow:r.sourceRow,sourceRows:[r.sourceRow],securityCode:r.securityCode,market:r.market,name:r.name,account:r.account,ownership:r.ownership,product,basis,valueUsd});
    }
    components.sort((a,b)=>a.sourceRow-b.sourceRow);
    const model={schema:SCHEMA,ruleVersion:RULE,asOf:s.asOf,retrievedAt:exposure.retrievedAt,currency:'USD',sourceSha256:b.sourceSha256,sourceXlsxSha256:s.sourceXlsxSHA256,accounts:accounts(s.accounts),portfolioTotalUsd:s.totalValueUSD,categoryTotalUsd:s.classes[3].totalValueUSD,components};
    validate(model,exposure,b.sourceSha256);return model;
  }
  const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const usd=v=>'USD '+v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  function renderCompanyExposure(model,exposure,sourceSha256){
    const v=validate(model,exposure,sourceSha256);
    if(!v.top)return '<p class="ratio-key-status" role="status">公司敞口待核实：原份穿透归属或杠杆倍数依据未完整核实；保留原证券前五，不重复计算杠杆。</p>';
    const tie=(a,b)=>canonical([a.account||'',a.securityCode,a.market,a.product||'',a.sourceRows]).localeCompare(canonical([b.account||'',b.securityCode,b.market,b.product||'',b.sourceRows]));
    const detail=(r,rank)=>{
      const direct=r.constituents.filter(c=>c.product===null||c.basis==='product-asset-replacement').sort((a,b)=>b.sourceValueUsd-a.sourceValueUsd||tie(a,b));
      const underlying=r.constituents.filter(c=>c.product!==null&&c.basis!=='product-asset-replacement').sort((a,b)=>b.valueUsd-a.valueUsd||tie(a,b));
      const groups=[['直接资产价值',direct],['来源穿透 · 经济敞口',underlying]];
      return groups.map(([title,rows],group)=>'<section class="ratio-breakdown-group"><h4>'+esc(title)+'</h4>'+(rows.length?'<ol class="ratio-constituents">'+rows.map((c,i)=>{
        const leveraged=c.leverage>1,base=c.multiplier===1&&leveraged?c.valueUsd/c.leverage:c.sourceValueUsd;
        const value=leveraged?(group===0?'实际市值 ':'单倍等效 ')+usd(base)+' × '+c.leverage+' = '+usd(c.valueUsd)+' 经济敞口'+(c.multiplier===1?'（来源已含杠杆）':''):usd(group===0?c.sourceValueUsd:c.valueUsd);
        return '<li><span class="ratio-constituent-number">'+rank+'.'+(group+1)+'.'+(i+1)+'</span><span class="ratio-constituent-text">'+esc(c.securityCode)+' · '+esc(c.market)+(c.product?'／'+esc(c.product):'')+'：'+value+'<span class="ratio-holding-accounts">'+esc(c.account||'原快照未记录账户')+'</span></span></li>';
      }).join('')+'</ol>':'<p>无</p>')+'</section>').join('');
    };
    const legacy=model.ruleVersion===LEGACY_RULE&&model.components.some(r=>r.product==='TQQQ.NASDAQ'||r.securityCode==='TQQQ')?'<p class="ratio-key-status">当前历史快照保留原TQQQ口径；3倍规则将在更新快照后生效。</p>':'';
    return legacy+'<table><thead><tr><th>公司／组成</th><th>经济敞口 USD</th><th>占总资产／占二级资产</th></tr></thead><tbody>'+v.top.map((r,i)=>'<tr><td>'+(i+1)+'. '+esc(r.name)+(r.accounts.length?'<span class="ratio-holding-accounts">'+esc(r.accounts.join(' · '))+'</span>':'')+'<details><summary>持仓与穿透明细</summary>'+detail(r,i+1)+'</details></td><td>'+usd(r.valueUsd)+'</td><td>'+r.portfolioWeightPct.toFixed(2)+'%／'+r.categoryWeightPct.toFixed(2)+'%</td></tr>').join('')+'</tbody></table>';
  }
  return {SCHEMA,RULE,LEGACY_RULE,build,validate,render:renderCompanyExposure};
}
