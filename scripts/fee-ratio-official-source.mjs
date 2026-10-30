// Pure projection of complete, pinned official workbook rows. This is not
// Sharesight authentication, a financial reader, an approval or a publisher.
export function createOfficialRatioSourceCore(){
  const RAW='sharesight-private-full-v2',INPUT='fee-console.ratio-sources.v2';
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
  const sourceId=s=>{if(!exact(s,['file','sha256','libraryFileId','libraryVersion'])||!text(s.file)||!hex(s.sha256)||!/^libfile_[a-f0-9]{32}$/.test(s.libraryFileId)||!Number.isSafeInteger(s.libraryVersion)||s.libraryVersion<0)fail();};
  function capture(s){
    if(!date(s.asOf)||!instant(s.capturedAt)||s.captureTimeBasis!=='original-download-file-mtime'
      ||!(s.downloadCompletedAt===null||instant(s.downloadCompletedAt))||!(s.serverSuggestedOriginalFilename===null||text(s.serverSuggestedOriginalFilename))
      ||!text(s.dateEvidence)||!Number.isSafeInteger(s.canonicalDataRows)||s.canonicalDataRows<1||!Number.isSafeInteger(s.allWorksheetXmlRows)||s.allWorksheetXmlRows<s.canonicalDataRows)fail();
    const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const observed=[...s.dateEvidence.matchAll(/\b(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4})\b/g)].map(m=>m[3]+'-'+String(months.indexOf(m[2])+1).padStart(2,'0')+'-'+m[1].padStart(2,'0'));
    if(!observed.length||observed.some(d=>d!==s.asOf)||s.asOf>new Date(Date.parse(s.capturedAt)+8*3600000).toISOString().slice(0,10))fail();
  }
  function overview(positions,cash,asOf){
    const all=positions.concat(cash),classes=names.map(name=>({name,totalValueUSD:sum(all.filter(r=>r.fourClass===name))}));
    // Venue-scoped GLD is the previously confirmed physical-gold ETF. Mining
    // companies and unrelated ETF names are not inferred to be gold.
    const gold={rule:'physical-gold-etf.GLD.NYSE.v1',valueUSD:sum(positions.filter(r=>r.securityCode==='GLD'&&r.market==='NYSE'))};
    return {schema:'fee-console.classification-overview.v1',asOf,currency:'USD',basis:'complete-official-classification-row-sum',totalValueUSD:sum(all),classes,gold};
  }
  function build(raw,{sourceSha256,sourceBytes}={}){
    if(!exact(raw,['schemaVersion','source','accounts','sources','classification','exposure','coverage','limitations'])||raw.schemaVersion!==RAW
      ||!exact(raw.source,['provider','view','transport'])||raw.source.provider!=='Sharesight'||raw.source.view!=='All Together'||raw.source.transport!=='official-workbook-exports'
      ||!hex(sourceSha256)||!Number.isSafeInteger(sourceBytes)||sourceBytes<1||sourceBytes>5*1024*1024
      ||!Array.isArray(raw.accounts)||raw.accounts.length!==10||!raw.accounts.every(text)||new Set(raw.accounts).size!==10
      ||!Array.isArray(raw.sources)||raw.sources.length!==3||!Array.isArray(raw.limitations)||!raw.limitations.every(text))fail();
    raw.sources.forEach(sourceId);if(new Set(raw.sources.map(s=>s.file)).size!==3||new Set(raw.sources.map(s=>s.libraryFileId)).size!==3)fail();
    const sources=new Map(raw.sources.map(s=>[s.file,s]));if(!['classification.xlsx','exposure.xlsx','capture-metadata.json'].every(s=>sources.has(s)))fail();
    const cov=raw.coverage;if(!exact(cov,['classificationCombinedComplete','exposureCombinedComplete','groupingSheetsAreDuplicates','closedPositionsIncluded','transactionHistoryIncluded','completeETFUniverseClaimed'])||cov.classificationCombinedComplete!==true||cov.exposureCombinedComplete!==true||cov.groupingSheetsAreDuplicates!==true||cov.closedPositionsIncluded!==false||cov.transactionHistoryIncluded!==false||cov.completeETFUniverseClaimed!==false)fail();
    const c=raw.classification,e=raw.exposure,metadata=['asOf','capturedAt','captureTimeBasis','downloadCompletedAt','serverSuggestedOriginalFilename','dateEvidence','canonicalDataRows','allWorksheetXmlRows'];
    if(!exact(c,[...metadata,'positions','cashAccounts'])||!exact(e,[...metadata,'rows']))fail();
    capture(c);capture(e);if(c.asOf>e.asOf)fail();
    if(!Array.isArray(c.positions)||!Array.isArray(c.cashAccounts)||c.positions.length+c.cashAccounts.length!==c.canonicalDataRows||!Array.isArray(e.rows)||e.rows.length!==e.canonicalDataRows||e.rows.length>100000)fail();
    const accounts=new Set(raw.accounts),positions=[],cash=[],byKey=new Map(),cashByKey=new Map(),sourceRows=new Set();
    const common=r=>{if(!accounts.has(r.account)||!text(r.name)||!Number.isSafeInteger(r.sourceRow)||r.sourceRow<1||sourceRows.has(r.sourceRow)||!text(r.sharesightCategory)||cents(r.valueUSD)<0)fail();sourceRows.add(r.sourceRow);};
    for(const r of c.positions){
      if(!exact(r,['sourceRow','account','name','valueUSD','sharesightCategory','securityCode','market','quantity']))fail();common(r);
      if(!text(r.securityCode)||!text(r.market)||!(r.quantity===null||typeof r.quantity==='number'&&Number.isFinite(r.quantity)&&r.quantity>=0))fail();
      const k=key(r.account,r.securityCode,r.market);if(byKey.has(k))fail();const p={...r,fourClass:four(r.sharesightCategory)};byKey.set(k,p);positions.push(p);
    }
    for(const r of c.cashAccounts){
      if(!exact(r,['sourceRow','account','name','valueUSD','sharesightCategory']))fail();common(r);if(r.sharesightCategory!=='Cash Accounts')fail();
      const k=key(r.account,r.name,'cash');if(cashByKey.has(k))fail();const p={...r,fourClass:'二级市场'};cashByKey.set(k,p);cash.push(p);
    }
    const sourceDates={classification:c.asOf,exposure:e.asOf},classification=overview(positions,cash,c.asOf),rows=[],cash30=[],direct30=new Map(),parents=new Map(),ids=new Set();
    for(const r of e.rows){
      if(!exact(r,['sourceRow','account','securityCode','market','name','withinETF','ownership','valueUSD','sourcePercentage'])||!accounts.has(r.account)||!text(r.name)||!Number.isSafeInteger(r.sourceRow)||r.sourceRow<1||ids.has(r.sourceRow)||!(r.sourcePercentage===null||typeof r.sourcePercentage==='number'&&Number.isFinite(r.sourcePercentage)))fail();ids.add(r.sourceRow);cents(r.valueUSD);
      let owner;
      if(r.ownership==='Cash'){
        if(r.securityCode!==null||r.market!==null||r.withinETF!==null||!cashByKey.has(key(r.account,r.name,'cash'))||r.valueUSD<0)fail();
        cash30.push({...r,fourClass:'二级市场'});rows.push({...r,fourClass:'二级市场'});continue;
      }
      if(!['Direct','Underlying','Residual'].includes(r.ownership)||!text(r.securityCode)||!text(r.market))fail();
      if(r.ownership==='Underlying'){
        if(!text(r.withinETF))fail();owner=positions.find(p=>p.account===r.account&&p.securityCode+'.'+p.market===r.withinETF);
      }else owner=byKey.get(key(r.account,r.securityCode,r.market));
      if(!owner)fail();const item={...r,fourClass:owner.fourClass};rows.push(item);
      if(r.ownership==='Direct'){
        if(r.withinETF!==null||r.valueUSD<0||direct30.has(key(r.account,r.securityCode,r.market)))fail();direct30.set(key(r.account,r.securityCode,r.market),{...owner,valueUSD:r.valueUSD,quantity:null});
      }else{
        const k=key(owner.account,owner.securityCode,owner.market),g=parents.get(k)||{owner,rows:[]};g.rows.push(item);parents.set(k,g);
      }
    }
    if(cash30.length!==cash.length||new Set(cash30.map(r=>key(r.account,r.name,'cash'))).size!==cash.length)fail();
    const positions30=[...direct30.values()];
    for(const [k,g]of parents){
      if(direct30.has(k)||g.rows.filter(r=>r.ownership==='Residual').length!==1||!g.rows.some(r=>r.ownership==='Underlying'))fail();
      const valueUSD=sum(g.rows);if(valueUSD<0)fail();positions30.push({...g.owner,valueUSD,quantity:null,instrumentType:'ETF',valueBasis:'same-export-underlying-plus-residual'});
    }
    if(positions30.length!==positions.length||cents(sum(positions30.concat(cash30)))!==cents(sum(rows)))fail();
    const groups=names.map((name,i)=>{
      let top;
      if(i<3){const grouped=new Map();for(const r of positions30.filter(p=>p.fourClass===name)){const k=key('',r.securityCode,r.market),old=grouped.get(k)||{name:r.name,securityCode:r.securityCode,market:r.market,valueUSD:0};old.valueUSD=(cents(old.valueUSD)+cents(r.valueUSD))/100;grouped.set(k,old);}const values=[...grouped.values()],counts=new Map();for(const r of values)counts.set(r.name,(counts.get(r.name)||0)+1);top=values.map(r=>({name:r.name+(counts.get(r.name)>1?' ['+r.securityCode+' · '+r.market+']':''),valueUSD:r.valueUSD}));}
      else {const selected=new Map();for(const r of rows.filter(p=>p.fourClass===name&&(p.ownership==='Direct'||p.ownership==='Underlying'))){const k=key('',r.securityCode,r.market),old=selected.get(k)||{name:r.name,securityCode:r.securityCode,market:r.market,valueUSD:0};old.valueUSD=(cents(old.valueUSD)+cents(r.valueUSD))/100;selected.set(k,old);}top=[...selected.values()];}
      top=top.sort((a,b)=>b.valueUSD-a.valueUSD||(a.name<b.name?-1:a.name>b.name?1:0)).slice(0,5);if(top.length!==5)fail();
      return {name,totalValueUSD:sum(positions30.concat(cash30).filter(r=>r.fourClass===name)),basis:i===3?'Exposure individual security direct plus ETF look-through, includes cash in class denominator':'direct',...(i===0?{sourceCategory:'VC/PE'}:{}),top5:top};
    });
    const total=sum(rows),residual=sum(rows.filter(r=>r.ownership==='Residual'));
    const exposure={schema:'xuan.sharesight-exposure-ranked.v2',summary:{asOf:e.asOf,currency:'USD',source:{provider:'Sharesight',view:'All Together',report:'Tools Exposure',groupBy:'No grouping',show:'Top 500',classification:'Investments→资产类别',url:null},totalValueUSD:total,accounts:[...raw.accounts],classes:groups,residualETFs:{valueUSD:residual,weightTotalPct:residual/total*100,weightSecondaryClassPct:residual/groups[3].totalValueUSD*100},limitations:[...raw.limitations,e.asOf+' Exposure分组沿用 '+c.asOf+' 资产类别标签；金额和比例分母取 '+e.asOf+' 完整Exposure原表。'],transferStatus:'按Sharesight现有记录显示；不新增或重复任何转仓和认购。',sourceXlsxSHA256:sources.get('exposure.xlsx').sha256},retrievedAt:e.capturedAt,retrievedAtBasis:'原始官方导出文件mtime（非独立下载完成时间）'};
    const ibRows=positions.filter(r=>r.account==='IB-HK'),ibCash=cash.filter(r=>r.account==='IB-HK'),noahCash=cash.filter(r=>r.account==='NOAH-HK');if(!ibRows.length||!ibCash.length||!noahCash.length)fail();
    const provenance={transport:'official-workbooks',observedAtBasis:'original-download-file-mtime',classificationCapturedAt:c.capturedAt,exposureCapturedAt:e.capturedAt,downloadCompletedAt:null,fullSourceBytes:sourceBytes,fullSourceSha256:sourceSha256,transferStatus:exposure.summary.transferStatus,limitations:[...raw.limitations]};
    const book={schema:'fee-console.ratio-sharesight-browser-book.v2',source:'Sharesight',currency:'USD',asOf:c.asOf,retrievedAt:c.capturedAt,sourceSha256,provenance,ib:{name:'IB-HK',holdings:ibRows.map(r=>({code:r.securityCode,market:r.market,group:r.sharesightCategory,valueUSD:r.valueUSD,quantity:r.quantity,name:r.name,valueBasis:'preserved-browser-source'})),holdingsValueUSD:sum(ibRows),cashRows:ibCash.map(r=>({label:r.name,valueUSD:r.valueUSD,valueBasis:'portfolio-usd-converted'})),cashValueUSD:sum(ibCash),totalValueUSD:sum(ibRows.concat(ibCash))},noah:{name:'NOAH-HK',cashValueUSD:sum(noahCash),valueBasis:'portfolio-usd-converted'}};
    return {input:{schema:INPUT,classification,exposure,book},sourceDates,classificationSummary:classification,companyContext:{rows,positions:positions30},capturedAt:[c.capturedAt,e.capturedAt].sort()[0],targetDate:e.asOf};
  }
  return {RAW,INPUT,build,canonical};
}
