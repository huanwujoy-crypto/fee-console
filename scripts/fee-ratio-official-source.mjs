// Pure projection of complete, pinned official rows: downloaded workbooks or,
// as a separately labelled source, one Sharesight API report. This is not
// Sharesight authentication, a financial reader, an approval or a publisher.
export function createOfficialRatioSourceCore(){
  const RAW='sharesight-private-full-v2',RAW_API='sharesight-api-full-v1',INPUT='fee-console.ratio-sources.v2';
  const fail=()=>{throw Error('RATIO_OFFICIAL_SOURCE_REFUSED');};
  const exact=(o,k)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join('|')===[...k].sort().join('|');
  const text=s=>typeof s==='string'&&s.length>0&&s.length<=1000&&!/[\u0000-\u001f\u007f]/.test(s);
  const date=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
  const instant=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)&&Number.isFinite(Date.parse(s));
  const hex=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
  const canonical=o=>Array.isArray(o)?'['+o.map(canonical).join(',')+']':o&&typeof o==='object'?'{'+Object.keys(o).sort().map(k=>JSON.stringify(k)+':'+canonical(o[k])).join(',')+'}':JSON.stringify(o);
  const cents=n=>{if(typeof n!=='number'||!Number.isFinite(n)||Math.abs(n)>1e12||!/^[-]?\d+(?:\.\d{1,2})?$/.test(String(n)))fail();const c=Math.round(n*100);if(!Number.isSafeInteger(c))fail();return c;};
  const sum=rows=>{let total=0;for(const r of rows){total+=cents(r.valueUSD);if(!Number.isSafeInteger(total))fail();}return total/100;};
  const key=(a,c,m)=>JSON.stringify([a,c,m]);
  const four=s=>s==='VC/PE'?'PE/VC':s==='对冲基金'||s==='常青基金'?s:'二级市场';
  const names=['PE/VC','对冲基金','常青基金','二级市场'];
  const ETF_TYPES=new Set(['exchange_traded_fund','exchange_traded_funds','etf']);
  const BENCHMARK_EXCLUDED_BASIS='complete-official-classification-excluding-benchmark-only.v1';
  const LOOK_THROUGH_SECONDARY_BASIS='Exposure individual security direct plus ETF look-through, includes cash in class denominator';
  const benchmarkOnly=r=>r.account.replaceAll('&amp;','&')==='Citi-HK & 地产四期'&&['QQQ.NASDAQ','SPY.NYSE'].includes(r.securityCode+'.'+r.market);
  // Exact Sharesight dated-name suffix, not a fuzzy product/share-class alias.
  function evergreenName(r){
    for(const value of [r.securityCode,r.name]){
      const marker=value.match(/(?:^|[-–—_:：/\s])(?=(?:19|20)\d{2}(?:[-/.]|年))/);
      if(!marker)continue;
      const tail=value.slice(marker.index+marker[0].length);
      const name=tail.match(/^(?:19|20)\d{2}[-/.](?:0[1-9]|1[0-2])(?:\s*[-–—_:：/]\s*|\s+)(\S[\s\S]*)$/)?.[1]
        ||tail.match(/^(?:19|20)\d{2}年(?:0?[1-9]|1[0-2])月\s*(?:[-–—_:：/]\s*)?(\S[\s\S]*)$/)?.[1];
      if(name)return name.trim();
    }
    return null;
  }
  // Strategy is the first field of the original dated custom holding name.
  // Official exports preserve that name in securityCode, not the display alias.
  function strategyName(r){
    for(const value of [r.securityCode,r.name]){
      if(typeof value!=='string')continue;
      const dated=value.match(/^(.*?)((?:19|20)\d{2}[-/.](?:0[1-9]|1[0-2])[-–—_:：/\s]|(?:19|20)\d{2}年(?:0?[1-9]|1[0-2])月)/);
      if(!dated)continue;
      const first=dated[1].trim().split(/[-–—_:：/]+/u)[0].trim();
      return first||'未分类';
    }
    return '未分类';
  }
  function fundDistributions(positions,includeFundHoldings){
    return ['常青基金','对冲基金'].map(name=>{
      const grouped=new Map();let totalCents=0;
      for(const r of positions.filter(p=>p.fourClass===name)){
        const category=strategyName(r),valueCents=cents(r.valueUSD);
        const group=grouped.get(category)||{name:category,valueCents:0,...(includeFundHoldings?{holdings:[]}: {})};
        totalCents+=valueCents;group.valueCents+=valueCents;
        if(includeFundHoldings)group.holdings.push({sourceRow:r.sourceRow,account:r.account,name:r.name,securityCode:r.securityCode,market:r.market,valueCents});
        grouped.set(category,group);
      }
      if(!Number.isSafeInteger(totalCents))fail();
      const groups=[...grouped.values()].sort((a,b)=>b.valueCents-a.valueCents||a.name.localeCompare(b.name));
      for(const g of groups)if(g.holdings)g.holdings.sort((a,b)=>b.valueCents-a.valueCents||a.account.localeCompare(b.account)||a.sourceRow-b.sourceRow);
      return {name,totalCents,groups};
    });
  }
  function assetAllocation(positions,cash){
    const labels=['PE/VC','对冲基金','常青基金','股票市场','现金类','主题投资'],targets=[0,15,35,40,8,2];
    const categories=new Map([['VC/PE',0],['对冲基金',1],['常青基金',2],['美国底仓',3],['美国科技',3],['非美发达',3],['新兴市场',3],['防御资产',4],['Cash Accounts',4],['主题投资',5]]);
    const groups=labels.map((name,i)=>({name,valueCents:0,targetPct:targets[i],accounts:new Map()}));
    // Use each direct classification row exactly once. Exposure, leverage and
    // reference targets never change actual assets or the account denominator.
    for(const r of positions.concat(cash)){
      const i=categories.get(r.sharesightCategory);if(i===undefined)fail();
      const g=groups[i],value=cents(r.valueUSD);g.valueCents+=value;
      g.accounts.set(r.account,(g.accounts.get(r.account)||0)+value);
      if(!Number.isSafeInteger(g.valueCents))fail();
    }
    const totalCents=groups.reduce((n,g)=>n+g.valueCents,0);if(!Number.isSafeInteger(totalCents))fail();
    return {totalCents,groups:groups.map(g=>({...g,accounts:[...g.accounts].map(([name,valueCents])=>({name,valueCents})).sort((a,b)=>b.valueCents-a.valueCents||a.name.localeCompare(b.name))}))};
  }
  const sourceId=s=>{if(!exact(s,['file','sha256','libraryFileId','libraryVersion'])||!text(s.file)||!hex(s.sha256)||!/^libfile_[a-f0-9]{32}$/.test(s.libraryFileId)||!Number.isSafeInteger(s.libraryVersion)||s.libraryVersion<0)fail();};
  function capture(s){
    if(!date(s.asOf)||!instant(s.capturedAt)||s.captureTimeBasis!=='original-download-file-mtime'
      ||!(s.downloadCompletedAt===null||instant(s.downloadCompletedAt))||!(s.serverSuggestedOriginalFilename===null||text(s.serverSuggestedOriginalFilename))
      ||!text(s.dateEvidence)||!Number.isSafeInteger(s.canonicalDataRows)||s.canonicalDataRows<1||!Number.isSafeInteger(s.allWorksheetXmlRows)||s.allWorksheetXmlRows<s.canonicalDataRows)fail();
    const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const observed=[...s.dateEvidence.matchAll(/\b(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4})\b/g)].map(m=>m[3]+'-'+String(months.indexOf(m[2])+1).padStart(2,'0')+'-'+m[1].padStart(2,'0'));
    if(!observed.length||observed.some(d=>d!==s.asOf)||s.asOf>new Date(Date.parse(s.capturedAt)+8*3600000).toISOString().slice(0,10))fail();
  }
  function overview(positions,cash,asOf,includeFundDistributions,includeAssetAllocation,excludeBenchmarkOnly,includeFundHoldings){
    const all=positions.concat(cash),classes=names.map(name=>({name,totalValueUSD:sum(all.filter(r=>r.fourClass===name))}));
    // Venue-scoped GLD is the previously confirmed physical-gold ETF. Mining
    // companies and unrelated ETF names are not inferred to be gold.
    const goldRows=positions.filter(r=>r.securityCode==='GLD'&&r.market==='NYSE');
    const gold={rule:'physical-gold-etf.GLD.NYSE.v1',valueUSD:sum(goldRows),secondaryIncluded:goldRows.every(r=>r.fourClass==='二级市场')};
    return {schema:'fee-console.classification-overview.v1',asOf,currency:'USD',basis:excludeBenchmarkOnly?BENCHMARK_EXCLUDED_BASIS:'complete-official-classification-row-sum',totalValueUSD:sum(all),classes,gold,...(includeFundDistributions?{fundDistributions:fundDistributions(positions,includeFundHoldings)}:{}),...(includeAssetAllocation?{assetAllocation:assetAllocation(positions,cash)}:{})};
  }
  function build(raw,{sourceSha256,sourceBytes,includeFundDistributions=true,includeAssetAllocation=true,excludeBenchmarkOnly=true,includeFundHoldings=true,directSecondary=true}={}){
    if(typeof includeFundDistributions!=='boolean'||typeof includeAssetAllocation!=='boolean'||typeof excludeBenchmarkOnly!=='boolean'||typeof includeFundHoldings!=='boolean'||typeof directSecondary!=='boolean')fail();
    // The same projection serves two honestly distinct sources. An API source
    // is one consolidated classification report: it has no Exposure export, so
    // its direct and cash rows are the report's own rows at the same date, and
    // it can only ever produce the direct secondary ranking.
    const api=raw?.schemaVersion===RAW_API;let c,e,sources;
    if(api){
      if(!exact(raw,['schemaVersion','source','accounts','sources','classification','coverage','limitations'])
        ||!exact(raw.source,['provider','view','transport'])||raw.source.provider!=='Sharesight'||raw.source.view!=='All Together'||raw.source.transport!=='official-api'
        ||!hex(sourceSha256)||!Number.isSafeInteger(sourceBytes)||sourceBytes<1||sourceBytes>5*1024*1024||directSecondary!==true
        ||!Array.isArray(raw.accounts)||raw.accounts.length!==10||!raw.accounts.every(text)||new Set(raw.accounts).size!==10
        ||!Array.isArray(raw.sources)||raw.sources.length!==1||!exact(raw.sources[0],['report','route','sha256'])||raw.sources[0].report!=='classification'||raw.sources[0].route!=='api-v3-performance-custom-group'||!hex(raw.sources[0].sha256)
        ||!Array.isArray(raw.limitations)||!raw.limitations.every(text))fail();
      const cov=raw.coverage;if(!exact(cov,['classificationComplete','limitedHoldingsIncluded','closedPositionsIncluded','transactionHistoryIncluded','etfLookThroughIncluded'])||cov.classificationComplete!==true||cov.limitedHoldingsIncluded!==false||cov.closedPositionsIncluded!==false||cov.transactionHistoryIncluded!==false||cov.etfLookThroughIncluded!==false)fail();
      c=raw.classification;
      // The report's own total may differ from the sum of its rows by rounding
      // only; the difference is carried and disclosed, never absorbed.
      if(!exact(c,['asOf','capturedAt','captureTimeBasis','reportTotalDeltaCents','positions','cashAccounts'])||!date(c.asOf)||!instant(c.capturedAt)||c.captureTimeBasis!=='api-response-received'
        ||c.asOf>new Date(Date.parse(c.capturedAt)+8*3600000).toISOString().slice(0,10)||!Number.isSafeInteger(c.reportTotalDeltaCents)||Math.abs(c.reportTotalDeltaCents)>100
        ||!Array.isArray(c.positions)||!Array.isArray(c.cashAccounts)||c.positions.length<1||c.positions.length+c.cashAccounts.length>100000)fail();
      const row=(r,ownership)=>({sourceRow:r?.sourceRow,account:r?.account,securityCode:ownership==='Cash'?null:r?.securityCode,market:ownership==='Cash'?null:r?.market,name:r?.name,withinETF:null,ownership,valueUSD:r?.valueUSD,sourcePercentage:null});
      e={asOf:c.asOf,capturedAt:c.capturedAt,rows:[...c.positions.map(r=>row(r,'Direct')),...c.cashAccounts.map(r=>row(r,'Cash'))]};
    }else{
    if(!exact(raw,['schemaVersion','source','accounts','sources','classification','exposure','coverage','limitations'])||raw.schemaVersion!==RAW
      ||!exact(raw.source,['provider','view','transport'])||raw.source.provider!=='Sharesight'||raw.source.view!=='All Together'||raw.source.transport!=='official-workbook-exports'
      ||!hex(sourceSha256)||!Number.isSafeInteger(sourceBytes)||sourceBytes<1||sourceBytes>5*1024*1024
      ||!Array.isArray(raw.accounts)||raw.accounts.length!==10||!raw.accounts.every(text)||new Set(raw.accounts).size!==10
      ||!Array.isArray(raw.sources)||raw.sources.length!==3||!Array.isArray(raw.limitations)||!raw.limitations.every(text))fail();
    raw.sources.forEach(sourceId);if(new Set(raw.sources.map(s=>s.file)).size!==3||new Set(raw.sources.map(s=>s.libraryFileId)).size!==3)fail();
    sources=new Map(raw.sources.map(s=>[s.file,s]));if(!['classification.xlsx','exposure.xlsx','capture-metadata.json'].every(s=>sources.has(s)))fail();
    const cov=raw.coverage;if(!exact(cov,['classificationCombinedComplete','exposureCombinedComplete','groupingSheetsAreDuplicates','closedPositionsIncluded','transactionHistoryIncluded','completeETFUniverseClaimed'])||cov.classificationCombinedComplete!==true||cov.exposureCombinedComplete!==true||cov.groupingSheetsAreDuplicates!==true||cov.closedPositionsIncluded!==false||cov.transactionHistoryIncluded!==false||cov.completeETFUniverseClaimed!==false)fail();
    c=raw.classification;e=raw.exposure;const metadata=['asOf','capturedAt','captureTimeBasis','downloadCompletedAt','serverSuggestedOriginalFilename','dateEvidence','canonicalDataRows','allWorksheetXmlRows'];
    if(!exact(c,[...metadata,'positions','cashAccounts'])||!exact(e,[...metadata,'rows']))fail();
    capture(c);capture(e);if(c.asOf>e.asOf)fail();
    if(!Array.isArray(c.positions)||!Array.isArray(c.cashAccounts)||c.positions.length+c.cashAccounts.length!==c.canonicalDataRows||!Array.isArray(e.rows)||e.rows.length!==e.canonicalDataRows||e.rows.length>100000)fail();
    }
    const accounts=new Set(raw.accounts),positions=[],cash=[],byKey=new Map(),cashByKey=new Map(),sourceRows=new Set();
    const common=r=>{if(!accounts.has(r.account)||!text(r.name)||!Number.isSafeInteger(r.sourceRow)||r.sourceRow<1||sourceRows.has(r.sourceRow)||!text(r.sharesightCategory)||cents(r.valueUSD)<0)fail();sourceRows.add(r.sourceRow);};
    // An API original carries the provider's own asset type per position.
    // Either every position declares it or none does (an earlier original).
    const typed=api&&c.positions.length>0&&c.positions.some(r=>Object.hasOwn(r||{},'assetType'));
    for(const r of c.positions){
      if(!exact(r,['sourceRow','account','name','valueUSD','sharesightCategory','securityCode','market','quantity',...(typed?['assetType']:[])]))fail();common(r);
      if(typed&&!(r.assetType===null||text(r.assetType)&&r.assetType.length<=128))fail();
      if(!text(r.securityCode)||!text(r.market)||!(r.quantity===null||typeof r.quantity==='number'&&Number.isFinite(r.quantity)&&r.quantity>=0))fail();
      const k=key(r.account,r.securityCode,r.market);if(byKey.has(k))fail();const p={...r,fourClass:four(r.sharesightCategory)};byKey.set(k,p);positions.push(p);
    }
    for(const r of c.cashAccounts){
      if(!exact(r,['sourceRow','account','name','valueUSD','sharesightCategory']))fail();common(r);if(r.sharesightCategory!=='Cash Accounts')fail();
      const k=key(r.account,r.name,'cash');if(cashByKey.has(k))fail();const p={...r,fourClass:'二级市场'};cashByKey.set(k,p);cash.push(p);
    }
    const sourceDates={classification:c.asOf,exposure:e.asOf},assetPositions=excludeBenchmarkOnly?positions.filter(r=>!benchmarkOnly(r)):positions,classification=overview(assetPositions,cash,c.asOf,includeFundDistributions,includeAssetAllocation,excludeBenchmarkOnly,includeFundHoldings),allRows=[],cash30=[],direct30=new Map(),parents=new Map(),ids=new Set(),benchmarkRows=new Set();
    for(const r of e.rows){
      if(!exact(r,['sourceRow','account','securityCode','market','name','withinETF','ownership','valueUSD','sourcePercentage'])||!accounts.has(r.account)||!text(r.name)||!Number.isSafeInteger(r.sourceRow)||r.sourceRow<1||ids.has(r.sourceRow)||!(r.sourcePercentage===null||typeof r.sourcePercentage==='number'&&Number.isFinite(r.sourcePercentage)))fail();ids.add(r.sourceRow);cents(r.valueUSD);
      let owner;
      if(r.ownership==='Cash'){
        if(r.securityCode!==null||r.market!==null||r.withinETF!==null||!cashByKey.has(key(r.account,r.name,'cash'))||r.valueUSD<0)fail();
        cash30.push({...r,fourClass:'二级市场'});allRows.push({...r,fourClass:'二级市场'});continue;
      }
      if(!['Direct','Underlying','Residual'].includes(r.ownership)||!text(r.securityCode)||!text(r.market))fail();
      if(r.ownership==='Underlying'){
        if(!text(r.withinETF))fail();owner=positions.find(p=>p.account===r.account&&p.securityCode+'.'+p.market===r.withinETF);
      }else owner=byKey.get(key(r.account,r.securityCode,r.market));
      if(!owner)fail();const item={...r,fourClass:owner.fourClass};allRows.push(item);if(benchmarkOnly(owner))benchmarkRows.add(r.sourceRow);
      if(r.ownership==='Direct'){
        if(r.withinETF!==null||r.valueUSD<0||direct30.has(key(r.account,r.securityCode,r.market)))fail();direct30.set(key(r.account,r.securityCode,r.market),{...owner,valueUSD:r.valueUSD,quantity:null});
      }else{
        const k=key(owner.account,owner.securityCode,owner.market),g=parents.get(k)||{owner,rows:[]};g.rows.push(item);parents.set(k,g);
      }
    }
    if(cash30.length!==cash.length||new Set(cash30.map(r=>key(r.account,r.name,'cash'))).size!==cash.length)fail();
    const allPositions30=[...direct30.values()];
    for(const [k,g]of parents){
      if(direct30.has(k)||g.rows.filter(r=>r.ownership==='Residual').length!==1||!g.rows.some(r=>r.ownership==='Underlying'))fail();
      const valueUSD=sum(g.rows);if(valueUSD<0)fail();allPositions30.push({...g.owner,valueUSD,quantity:null,instrumentType:'ETF',valueBasis:'same-export-underlying-plus-residual'});
    }
    // Validate every original row and its complete ETF association before
    // excluding benchmark-only assets from the derived investment view.
    if(allPositions30.length!==positions.length||cents(sum(allPositions30.concat(cash30)))!==cents(sum(allRows)))fail();
    const positions30=excludeBenchmarkOnly?allPositions30.filter(r=>!benchmarkOnly(r)):allPositions30,rows=excludeBenchmarkOnly?allRows.filter(r=>!benchmarkRows.has(r.sourceRow)):allRows;
    if(cents(sum(positions30.concat(cash30)))!==cents(sum(rows)))fail();
    const groups=names.map((name,i)=>{
      let top;
      // By default all four classes rank actually held positions at their
      // asset value, merged per security across accounts: an ETF ranks as the
      // ETF itself. An input prepared under the earlier secondary basis (ETF
      // look-through rows) is still reproduced exactly when it declares it.
      if(i<3||directSecondary){
        const grouped=new Map();
        // Owner rule (2026-11-14): the secondary-market ranking never lists an
        // ETF. Only the provider's own asset type decides; a position whose type
        // is unknown or anything else still ranks. ETFs stay in the class total.
        const ranked=positions30.filter(p=>p.fourClass===name);
        if(i===3&&typed&&!ranked.some(p=>p.assetType!==null))fail();
        for(const r of ranked.filter(p=>!(i===3&&typed&&ETF_TYPES.has(String(p.assetType).toLowerCase())))){
          const suffix=i===2?evergreenName(r):null,k=suffix?JSON.stringify(['dated-fund-name',suffix]):key('',r.securityCode,r.market);
          const old=grouped.get(k)||{name:suffix||r.name,securityCode:r.securityCode,market:r.market,accounts:[],valueUSD:0,...(i===2?{sourceHoldings:[]}: {})};
          if(!old.accounts.includes(r.account))old.accounts.push(r.account);old.accounts.sort();
          old.valueUSD=(cents(old.valueUSD)+cents(r.valueUSD))/100;
          if(i===2)old.sourceHoldings.push({account:r.account,name:r.name,securityCode:r.securityCode,market:r.market,valueUSD:r.valueUSD});
          grouped.set(k,old);
        }
        const values=[...grouped.values()],counts=new Map();for(const r of values)counts.set(r.name,(counts.get(r.name)||0)+1);
        top=values.map(r=>({...r,name:r.name+(counts.get(r.name)>1?' ['+r.securityCode+' · '+r.market+']':'')}));
        for(const r of top)if(r.sourceHoldings)r.sourceHoldings.sort((a,b)=>b.valueUSD-a.valueUSD||canonical(a).localeCompare(canonical(b)));
      }
      else {const selected=new Map();for(const r of rows.filter(p=>p.fourClass===name&&(p.ownership==='Direct'||p.ownership==='Underlying'))){const k=key('',r.securityCode,r.market),old=selected.get(k)||{name:r.name,securityCode:r.securityCode,market:r.market,accounts:[],valueUSD:0};if(!old.accounts.includes(r.account))old.accounts.push(r.account);old.accounts.sort();old.valueUSD=(cents(old.valueUSD)+cents(r.valueUSD))/100;selected.set(k,old);}top=[...selected.values()];}
      top=top.sort((a,b)=>b.valueUSD-a.valueUSD||(a.name<b.name?-1:a.name>b.name?1:0)).slice(0,5);if(top.length!==5)fail();
      return {name,totalValueUSD:sum(positions30.concat(cash30).filter(r=>r.fourClass===name)),basis:i===3&&!directSecondary?LOOK_THROUGH_SECONDARY_BASIS:'direct',...(i===0?{sourceCategory:'VC/PE'}:{}),top5:top};
    });
    const total=sum(rows),residual=sum(rows.filter(r=>r.ownership==='Residual'));
    const exposure={schema:'xuan.sharesight-exposure-ranked.v2',summary:{asOf:e.asOf,currency:'USD',source:{provider:'Sharesight',view:'All Together',...(api?{report:'API V3 Performance',groupBy:'Custom group',show:'All holdings'}:{report:'Tools Exposure',groupBy:'No grouping',show:'Top 500'}),classification:'Investments→资产类别',url:null},totalValueUSD:total,accounts:[...raw.accounts],classes:groups,residualETFs:{valueUSD:residual,weightTotalPct:residual/total*100,weightSecondaryClassPct:residual/groups[3].totalValueUSD*100},limitations:[...raw.limitations,api?c.asOf+' 持仓与现金取自同一份Sharesight API分类报表；不含ETF穿透。':e.asOf+' Exposure分组沿用 '+c.asOf+' 资产类别标签；金额和比例分母取 '+e.asOf+' 完整Exposure原表。'],transferStatus:'按Sharesight现有记录显示；不新增或重复任何转仓和认购。',...(api?{sourceReportSHA256:raw.sources[0].sha256}:{sourceXlsxSHA256:sources.get('exposure.xlsx').sha256})},retrievedAt:e.capturedAt,retrievedAtBasis:api?'Sharesight API 响应接收时间':'原始官方导出文件mtime（非独立下载完成时间）'};
    const ibRows=positions.filter(r=>r.account==='IB-HK'),ibCash=cash.filter(r=>r.account==='IB-HK'),noahCash=cash.filter(r=>r.account==='NOAH-HK');if(!ibRows.length||!ibCash.length||!noahCash.length)fail();
    const provenance=api?{transport:'official-api',observedAtBasis:'api-response-received',classificationCapturedAt:c.capturedAt,reportTotalDeltaCents:c.reportTotalDeltaCents,fullSourceBytes:sourceBytes,fullSourceSha256:sourceSha256,transferStatus:exposure.summary.transferStatus,limitations:[...raw.limitations]}:{transport:'official-workbooks',observedAtBasis:'original-download-file-mtime',classificationCapturedAt:c.capturedAt,exposureCapturedAt:e.capturedAt,downloadCompletedAt:null,fullSourceBytes:sourceBytes,fullSourceSha256:sourceSha256,transferStatus:exposure.summary.transferStatus,limitations:[...raw.limitations]};
    const book={schema:'fee-console.ratio-sharesight-browser-book.v2',source:'Sharesight',currency:'USD',asOf:c.asOf,retrievedAt:c.capturedAt,sourceSha256,provenance,ib:{name:'IB-HK',holdings:ibRows.map(r=>({code:r.securityCode,market:r.market,group:r.sharesightCategory,valueUSD:r.valueUSD,quantity:r.quantity,name:r.name,valueBasis:api?'api-report-value':'preserved-browser-source'})),holdingsValueUSD:sum(ibRows),cashRows:ibCash.map(r=>({label:r.name,valueUSD:r.valueUSD,valueBasis:'portfolio-usd-converted'})),cashValueUSD:sum(ibCash),totalValueUSD:sum(ibRows.concat(ibCash))},noah:{name:'NOAH-HK',cashValueUSD:sum(noahCash),valueBasis:'portfolio-usd-converted'}};
    return {input:{schema:INPUT,classification,exposure,book},sourceDates,classificationSummary:classification,companyContext:{rows,positions:positions30},capturedAt:[c.capturedAt,e.capturedAt].sort()[0],targetDate:e.asOf};
  }
  return {RAW,RAW_API,INPUT,BENCHMARK_EXCLUDED_BASIS,LOOK_THROUGH_SECONDARY_BASIS,build,canonical};
}
