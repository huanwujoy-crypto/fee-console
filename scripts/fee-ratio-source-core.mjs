// Pure complete-original association and normalization; no IO or authority.
import {createFeeCompanyExposureCore} from './fee-ratio-company-exposure.mjs';
export function createRatioSourceCore(hashScope){
const fail=()=>{throw Error('RATIO_BROWSER_EVIDENCE_REFUSED');};
const exact=(o,k)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===[...k].sort().join(',');
const STOCK_CLASS_TARGETS=new Map([['美国底仓',45],['美国科技',20],['非美发达',23],['新兴市场',12]]);
const key=r=>JSON.stringify([r.securityCode,r.market]);
const signed=n=>{if(typeof n!=='number'||!Number.isFinite(n)||Math.abs(n)>1e15)fail();return n;};
const amount=n=>{signed(n);if(n<0)fail();return n;};
const cents=n=>Math.round(amount(n)*100),near=(a,b)=>Math.abs(a-b)<=1e-7;
const time=s=>{if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(s)||!Number.isFinite(Date.parse(s)))fail();return Date.parse(s);};
const date=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
const total=rows=>rows.reduce((s,r)=>s+signed(r.valueUSD),0);
const normalize=s=>String(s).replaceAll('&amp;','&');
const esc=s=>String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

function verifyBrowserSourceAssociations(raw,input,{scopeHash,now=new Date()}={}){
  if(!exact(input,['schema','exposure','book'])||input.schema!=='fee-console.ratio-sources.v1'||input.book?.schema!=='fee-console.ratio-sharesight-browser-book.v1')fail();
  const b=input.book,s=input.exposure?.summary,p=b.provenance;
  if(!raw||raw.schemaVersion!=='sharesight-private-full-v1'||raw.source?.provider!=='Sharesight'||raw.source.apiResponse!==false||raw.source.view!=='All Together'||!Array.isArray(raw.accounts)||raw.accounts.length!==10||hashScope(raw.accounts)!==scopeHash||hashScope(s.accounts)!==scopeHash)fail();
  const snap=raw.snapshot,coverage=raw.coverage;
  if(!snap||!date(snap.asOf)||snap.asOf!==b.asOf||snap.asOf!==s.asOf||snap.currency!=='USD'||b.currency!=='USD'||s.currency!=='USD'||!p||time(snap.observedAt)!==time(b.retrievedAt)||time(snap.observedAt)!==time(input.exposure.retrievedAt)||time(snap.exportCreatedAt)!==time(p.exportCreatedAt)||time(snap.exportReceivedAtFilesystem)!==time(p.exportLastWrittenAt)||time(snap.classificationSnapshotSavedAt)!==time(p.classificationSavedAt)||Math.floor(time(p.exportLastWrittenAt)/1000)*1000!==time(b.retrievedAt))fail();
  const clock=now.getTime(),captured=time(snap.observedAt);if(!Number.isFinite(clock)||clock<captured||clock-captured>36*3600000||[p.exportCreatedAt,p.exportLastWrittenAt,p.classificationSavedAt].some(t=>time(t)>clock))fail();
  if(!coverage||coverage.originalDirectPositionTableCompleteForObservedOpenScope!==true||coverage.allExportRowsIncluded!==true||coverage.closedPositionsIncluded!==false||coverage.transactionHistoryIncluded!==false||coverage.completeETFUniverseClaimed!==false||raw.readOnlySupplement?.mustNotSilentlyMergeIntoOriginalSnapshot!==true)fail();
  for(const k of ['directHoldingsConsolidated','directPositionsByAccount','cashAccounts','classTotals','fourClassTotals'])if(!Array.isArray(raw[k])||raw[k].length>5000)fail();
  if(raw.directHoldingsConsolidated.length!==coverage.directConsolidatedSecurities||raw.directPositionsByAccount.length!==coverage.directAccountPositions||raw.cashAccounts.length!==coverage.cashAccounts||raw.directPositionsByAccount.some(r=>r.holdingId!==null||r.valuationCurrency!=='USD'||!raw.accounts.includes(r.account))||raw.cashAccounts.some(r=>r.valuationCurrency!=='USD'||!raw.accounts.includes(r.account)))fail();
  const combined=new Map();for(const r of raw.directPositionsByAccount){amount(r.valueUSD);combined.set(key(r),(combined.get(key(r))||0)+r.valueUSD);}
  const consolidated=new Map(raw.directHoldingsConsolidated.map(r=>[key(r),r]));if(consolidated.size!==raw.directHoldingsConsolidated.length||consolidated.size!==combined.size||[...combined].some(([k,v])=>!consolidated.has(k)||cents(v)!==cents(consolidated.get(k).valueUSD)))fail();
  const original=raw.directPositionsByAccount.filter(r=>r.account==='IB-HK'),byKey=new Map(original.map(r=>[key(r),r]));
  if(b.ib===null||b.noah===null||original.length!==byKey.size||original.length!==b.ib.holdings.length)fail();
  for(const h of b.ib.holdings){const r=byKey.get(JSON.stringify([h.code,h.market]));if(!r||h.group!==r.sharesightCategory||cents(h.valueUSD)!==cents(r.valueUSD)||h.quantity!==r.quantity||h.name!==null&&h.name!==r.name)fail();}
  const ibCash=raw.cashAccounts.filter(r=>r.account==='IB-HK'),cashMap=new Map(ibCash.map(r=>[r.name,r]));
  if(ibCash.length!==cashMap.size||ibCash.length!==b.ib.cashRows.length||b.ib.cashRows.some(r=>!cashMap.has(r.label)||r.valueBasis!=='portfolio-usd-converted'||cents(r.valueUSD)!==cents(cashMap.get(r.label).valueUSD)))fail();
  const noah=raw.cashAccounts.filter(r=>r.account==='NOAH-HK');
  if(cents(total(original))!==cents(b.ib.holdingsValueUSD)||cents(total(ibCash))!==cents(b.ib.cashValueUSD)||cents(total(original)+total(ibCash))!==cents(b.ib.totalValueUSD)||!noah.length||b.noah.name!=='NOAH-HK'||b.noah.valueBasis!=='portfolio-usd-converted'||cents(total(noah))!==cents(b.noah.cashValueUSD))fail();
  const e=raw.exposure;if(!e||!Array.isArray(e.rows)||e.rows.length>100000||!Array.isArray(e.securitiesAggregatedFromExport)||e.securitiesAggregatedFromExport.length>100000||e.rows.length!==coverage.exposureExportRows||e.securitiesAggregatedFromExport.length!==coverage.exposureSecurityAggregateCount)fail();
  const counts={Direct:0,Underlying:0,Residual:0,Cash:0},agg=new Map(),rowIds=new Set();
  for(const r of e.rows){if(!Object.hasOwn(counts,r.ownership)||!raw.accounts.includes(r.account)||!Number.isSafeInteger(r.sourceRow)||r.sourceRow<1||rowIds.has(r.sourceRow))fail();rowIds.add(r.sourceRow);counts[r.ownership]++;signed(r.valueUSD);if(['Direct','Underlying'].includes(r.ownership)){const k=key(r);agg.set(k,(agg.get(k)||0)+r.valueUSD);}}
  for(const [k,v]of Object.entries(counts))if(v!==coverage['exposure'+k+'Rows'])fail();
  const sourceAgg=new Map(e.securitiesAggregatedFromExport.map(r=>[key(r),r]));if(sourceAgg.size!==agg.size||sourceAgg.size!==e.securitiesAggregatedFromExport.length||[...agg].some(([k,v])=>!sourceAgg.has(k)||!near(v,sourceAgg.get(k).valueUSD)))fail();
  for(const h of b.ib.holdings)if(h.valueBasis==='same-export-underlying-plus-residual'){
    const linked=e.rows.filter(r=>r.account==='IB-HK'&&(r.ownership==='Underlying'&&String(r.withinETF||'').split('.')[0]===h.code||r.ownership==='Residual'&&key(r)===JSON.stringify([h.code,h.market])));
    if(!linked.length||cents(total(linked))!==cents(h.valueUSD))fail();
  }
  const xlsx=Object.entries(raw.sourceFileSHA256||{}).filter(([k])=>k.toLowerCase().endsWith('.xlsx'));
  if(xlsx.length!==1||s.sourceXlsxSHA256!==xlsx[0][1]||s.source.url!==raw.source.exposureURL||cents(s.totalValueUSD)!==cents(snap.totalValueUSD))fail();
  const four=new Map(raw.fourClassTotals.map(r=>[r.name,r]));if(four.size!==4||s.classes.some(g=>!four.has(g.name)||cents(g.totalValueUSD)!==cents(four.get(g.name).valueUSD)))fail();
  for(const g of s.classes.slice(0,3)){
    const rows=raw.directHoldingsConsolidated.filter(r=>r.fourClass===g.name),top=[...rows].sort((a,b)=>b.valueUSD-a.valueUSD).slice(0,5),linked=[];
    for(const old of g.top5){const display=normalize(old.name).toLowerCase(),matches=rows.filter(r=>new RegExp('(?<![\\w])'+esc(String(r.securityCode).toLowerCase())+'(?![\\w])','u').test(display));if(matches.length!==1||cents(matches[0].valueUSD)!==cents(old.valueUSD))fail();linked.push(key(matches[0]));}
    if(new Set(linked).size!==5||top.some(r=>!linked.includes(key(r))))fail();
  }
  const secondary=new Map();for(const r of e.rows)if(r.fourClass==='二级市场'&&['Direct','Underlying'].includes(r.ownership))secondary.set(key(r),(secondary.get(key(r))||0)+r.valueUSD);
  const known=new Map((e.uiKnownAggregateDifferences||[]).map(r=>[key(r),r]));
  for(const r of known.values())if(!sourceAgg.has(key(r))||cents(sourceAgg.get(key(r)).valueUSD)!==cents(r.exportSumValueUSD))fail();
  const secondaryKeys=s.classes[3].top5.map(r=>key(r));if(new Set(secondaryKeys).size!==5||[...secondary].sort((a,b)=>b[1]-a[1]).slice(0,5).some(([k])=>!secondaryKeys.includes(k)))fail();
  for(const old of s.classes[3].top5){const k=key(old),v=secondary.get(k),ui=known.get(k);if(v===undefined||cents(old.valueUSD)!==cents(v)&&(!ui||cents(ui.originalUIValueUSD)!==cents(old.valueUSD)||cents(ui.exportSumValueUSD)!==cents(v)))fail();}
  if(cents(s.residualETFs.valueUSD)!==cents(e.residualValueUSD)||Math.abs(s.residualETFs.weightTotalPct-e.residualWeightTotalPct)>.0051||Math.abs(s.residualETFs.weightSecondaryClassPct-e.residualWeightSecondaryPct)>.0051||cents(total(e.rows))!==cents(e.exportRowsTotalUSD)||Math.round((total(e.rows)-snap.totalValueUSD)*100)!==Math.round(e.roundingDeltaVersusOriginalPortfolioUSD*100)||cents(total([...raw.directPositionsByAccount,...raw.cashAccounts]))!==cents(coverage.directPlusCashRowsValueUSD)||Math.round((total(raw.classTotals)-snap.totalValueUSD)*100)!==Math.round(coverage.directPlusCashRoundingDeltaVersusReportedTotalUSD*100))fail();
  return {observedAt:new Date(captured).toISOString(),asOf:snap.asOf,migrationPending:raw.transferReconciliation?.receiptConfirmed!==true,classificationDeltaCents:Math.round((total(raw.classTotals)-snap.totalValueUSD)*100),exposureDeltaCents:Math.round(e.roundingDeltaVersusOriginalPortfolioUSD*100),companyExposure:createFeeCompanyExposureCore().build(raw,input)};
}

function buildBrowserRatioBook(input,targetDate){
  if(!exact(input,['schema','source','currency','asOf','retrievedAt','sourceSha256','provenance','ib','noah'])||input.schema!=='fee-console.ratio-sharesight-browser-book.v1'||input.source!=='Sharesight'||input.currency!=='USD'||input.asOf!==targetDate||!/^[a-f0-9]{64}$/.test(input.sourceSha256||''))fail();
  const instant=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(s)&&Number.isFinite(Date.parse(s));
  const text=s=>typeof s==='string'&&s.length>0&&s.length<=500&&!/[\u0000-\u001f\u007f]/.test(s);
  const money=v=>{if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>1e12||Math.abs(v*100-Math.round(v*100))>0.00001)fail();return Math.round(v*100);};
  const p=input.provenance;
  if(!exact(p,['transport','observedAtBasis','exportCreatedAt','exportLastWrittenAt','classificationSavedAt','fullSourceBytes','fullSourceSha256','transferStatus','limitations'])||p.transport!=='browser-export-and-ui'||p.observedAtBasis!=='original-export-download-time'||![input.retrievedAt,p.exportCreatedAt,p.exportLastWrittenAt,p.classificationSavedAt].every(instant)||Date.parse(p.exportCreatedAt)>Date.parse(p.exportLastWrittenAt)||Date.parse(input.retrievedAt)!==Math.floor(Date.parse(p.exportLastWrittenAt)/1000)*1000||p.fullSourceSha256!==input.sourceSha256||!Number.isSafeInteger(p.fullSourceBytes)||p.fullSourceBytes<1||p.fullSourceBytes>5*1024*1024||!text(p.transferStatus)||!Array.isArray(p.limitations)||p.limitations.length>50||!p.limitations.every(text))fail();
  let holdings=null,allocation=null,ibCashCents=null,noahCashCents=null;
  const ib=input.ib;
  if(ib!==null){
    if(!exact(ib,['name','holdings','holdingsValueUSD','cashRows','cashValueUSD','totalValueUSD'])||ib.name!=='IB-HK'||!Array.isArray(ib.holdings)||!ib.holdings.length||ib.holdings.length>5000||!Array.isArray(ib.cashRows)||ib.cashRows.length>100)fail();
    const seen=new Set(),groups=new Map([...STOCK_CLASS_TARGETS.keys()].map(k=>[k,0])),cashLike=new Map(),symbolGroups=new Map();let usscCents=0,holdingsTotal=0;
    holdings=ib.holdings.map(h=>{
      if(!exact(h,['code','market','group','valueUSD','quantity','name','valueBasis'])||![h.code,h.market,h.group].every(text)||!(h.name===null||text(h.name))||!(h.quantity===null||typeof h.quantity==='number'&&Number.isFinite(h.quantity)&&h.quantity>=0)||!['preserved-browser-source','same-export-underlying-plus-residual'].includes(h.valueBasis))fail();
      const key=h.code+'|'+h.market,symbol=h.code.toUpperCase().split('.')[0],valueCents=money(h.valueUSD);
      if(seen.has(key)||symbolGroups.has(symbol)&&symbolGroups.get(symbol)!==h.group)fail();seen.add(key);symbolGroups.set(symbol,h.group);holdingsTotal+=valueCents;
      if(groups.has(h.group))groups.set(h.group,groups.get(h.group)+valueCents);else if(!['主题投资','防御资产'].includes(h.group))fail();
      if(symbol==='USSC'){if(h.group!=='美国底仓')fail();usscCents+=valueCents;}
      if(['VGSH','VGIT','TLT'].includes(symbol)){if(h.group!=='防御资产')fail();cashLike.set(symbol,(cashLike.get(symbol)||0)+valueCents);}
      return {name:h.name||h.code,symbol:h.code,valueCents,category:h.group,market:h.market,quantity:h.quantity,valueBasis:h.valueBasis,nameBasis:h.name===null?'source-code-only':'source-name'};
    });
    const cashSeen=new Set();ibCashCents=ib.cashRows.reduce((sum,c)=>{if(!exact(c,['label','valueUSD','valueBasis'])||!text(c.label)||cashSeen.has(c.label)||c.valueBasis!=='portfolio-usd-converted')fail();cashSeen.add(c.label);return sum+money(c.valueUSD);},0);
    if(holdingsTotal!==money(ib.holdingsValueUSD)||ibCashCents!==money(ib.cashValueUSD)||holdingsTotal+ibCashCents!==money(ib.totalValueUSD))fail();
    const totalCents=[...groups.values()].reduce((a,b)=>a+b,0);if(totalCents<=0)fail();
    allocation={totalCents,categories:[...STOCK_CLASS_TARGETS].map(([label,targetPct])=>({label,valueCents:groups.get(label),targetPct})),usscCents,cashLike:[...cashLike].filter(([,v])=>v>0).map(([symbol,valueCents])=>({symbol,valueCents}))};
  }
  if(input.noah!==null){if(!exact(input.noah,['name','cashValueUSD','valueBasis'])||input.noah.name!=='NOAH-HK'||input.noah.valueBasis!=='portfolio-usd-converted')fail();noahCashCents=money(input.noah.cashValueUSD);}
  return {source:'Sharesight',asOf:input.asOf,retrievedAt:input.retrievedAt,sourceSha256:input.sourceSha256,ibCashCents,noahCashCents,allocation,holdings,browserEvidence:{...structuredClone(p),integrity:'declared-not-verified-on-this-device'}};
}
return {verifyBrowserSourceAssociations,buildBrowserRatioBook};
}
