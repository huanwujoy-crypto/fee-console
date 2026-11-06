// Aggregate-only native returns. No fetch, writes, averaging or annualisation.
export function createAggregateReturnsCore(){
 const SCHEMA='fee-console.ratio-performance-source.v2';
 const fail=()=>{throw Error('RATIO_PERFORMANCE_REFUSED');};
 const exact=(v,ks)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join('|')===[...ks].sort().join('|');
 const text=v=>typeof v==='string'&&v.length>0&&v.length<=500&&!/[\u0000-\u001f\u007f]/.test(v);
 const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
 const canon=v=>Array.isArray(v)?'['+v.map(canon).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}':JSON.stringify(v);
 const same=(a,b)=>canon(a)===canon(b),memberKey=m=>canon([m.account,m.market,m.securityCode]);
 function scopeKey(s){
  if(!exact(s,['type','name','parent'])||!['portfolio','classification','fund-strategy'].includes(s.type)||!text(s.name))fail();
  if(s.type==='portfolio'&&(s.name!=='All Together'||s.parent!==null)||s.type==='classification'&&s.parent!==null||s.type==='fund-strategy'&&!['常青基金','对冲基金'].includes(s.parent))fail();
  return canon(s);
 }
 function ref(r){if(!exact(r,['libraryFileId','version','sha256','locator'])||!/^libfile_[a-f0-9]{32}$/.test(r.libraryFileId||'')||!Number.isSafeInteger(r.version)||r.version<0||!/^[a-f0-9]{64}$/.test(r.sha256||'')||!text(r.locator))fail();}
 function oneYearBefore(end){if(!date(end))fail();const y=Number(end.slice(0,4))-1,m=Number(end.slice(5,7)),d=Number(end.slice(8,10));return String(y).padStart(4,'0')+'-'+String(m).padStart(2,'0')+'-'+String(Math.min(d,new Date(Date.UTC(y,m,0)).getUTCDate())).padStart(2,'0');}
 const stockScope=s=>s?.type==='classification'&&s.name==='股票市场'&&s.parent===null;
 const stockSourceIds=s=>new Set(s.reports.filter(r=>Array.isArray(r?.additionalSources)&&r.additionalSources.length===2).map(r=>r.additionalSources[1]?.libraryFileId));
 function build(s,{expectedAccounts,expectedAsOf,topTargets:expectedTopTargets=null,excludedMembers=[],benchmarkMembers=[{account:'Citi-HK & 地产四期',market:'NASDAQ',securityCode:'QQQ'},{account:'Citi-HK & 地产四期',market:'NYSE',securityCode:'SPY'}]}={}){
  if(!exact(s,['schema','provider','currency','asOf','accounts','reports',...(Object.hasOwn(s||{},'topHoldings')?['topHoldings']:[])])||s.schema!==SCHEMA||s.provider!=='Sharesight'||s.currency!=='USD'||!date(s.asOf)||s.asOf!==expectedAsOf)fail();
  const accounts=s.accounts;
  if(!Array.isArray(accounts)||!accounts.length||!accounts.every(text)||new Set(accounts).size!==accounts.length||!Array.isArray(expectedAccounts)||!same([...accounts].sort(),[...expectedAccounts].sort())||!Array.isArray(s.reports)||s.reports.length!==2||!Array.isArray(excludedMembers))fail();
  const member=m=>{if(!exact(m,['account','market','securityCode'])||![m.account,m.market,m.securityCode].every(text))fail();return memberKey(m);};
  if(!Array.isArray(benchmarkMembers))fail();
  const excluded=new Set(excludedMembers.map(member)),benchmarks=new Set(benchmarkMembers.map(member)),periods=new Set(),files=new Set(),items=new Map(),stockFiles=stockSourceIds(s);
  for(const r of s.reports){
   const reportKeys=['period','startDate','endDate','includeClosed','calculationMethod','currency','cashPerformance','source','rows','unavailable'];
   if(!(exact(r,reportKeys)||exact(r,[...reportKeys,'additionalSources']))||!['all','oneYear'].includes(r.period)||periods.has(r.period)||!date(r.startDate)||r.startDate>r.endDate||r.endDate!==s.asOf||r.includeClosed!==true||r.calculationMethod!=='sharesight-native'||r.currency!=='USD'||!['included','excluded','mixed','unknown'].includes(r.cashPerformance)||!Array.isArray(r.rows)||!Array.isArray(r.unavailable))fail();
   if(r.period==='oneYear'&&r.startDate!==oneYearBefore(s.asOf))fail();ref(r.source);if(files.has(r.source.libraryFileId))fail();files.add(r.source.libraryFileId);periods.add(r.period);
   const sources=new Map([[r.source.libraryFileId,r.source]]);
   if('additionalSources' in r){
    if(!Array.isArray(r.additionalSources)||![1,2].includes(r.additionalSources.length))fail();
    for(const source of r.additionalSources){ref(source);if(files.has(source.libraryFileId))fail();files.add(source.libraryFileId);sources.set(source.libraryFileId,source);}
   }
   const stockSource=r.additionalSources?.length===2?r.additionalSources[1]:null;
   let stockRow=null;
   const scopes=new Set(),locations=new Set();
   const put=(scope,p)=>{const k=scopeKey(scope);if(scopes.has(k))fail();scopes.add(k);const item=items.get(k)||{scope:structuredClone(scope),periods:{}};item.periods[r.period]=p;items.set(k,item);};
   for(const row of r.rows){
    const rowKeys=['scope','members','sourceSheet','sourceRow','returnPct','unit','termEvidence'];
    if(!(exact(row,rowKeys)||exact(row,[...rowKeys,'sourceFileId']))||!text(row.sourceSheet)||!Number.isSafeInteger(row.sourceRow)||row.sourceRow<1||!['p.a.','period','unknown','unavailable'].includes(row.unit)||!Array.isArray(row.members)||!row.members.length)fail();
    const rowSource=sources.get('sourceFileId' in row?row.sourceFileId:r.source.libraryFileId);if(!rowSource)fail();
    // The third workbook may supply only the exact stock subtotal. Its
    // unrelated totals and holdings cannot silently replace earlier evidence.
    if(stockSource&&rowSource.libraryFileId===stockSource.libraryFileId){if(!stockScope(row.scope)||stockRow)fail();stockRow=row;}
    const k=scopeKey(row.scope),loc=canon([rowSource.libraryFileId,row.sourceSheet,row.sourceRow]);if(locations.has(loc))fail();locations.add(loc);
    if(row.unit==='unavailable'?row.returnPct!==null:typeof row.returnPct!=='number'||!Number.isFinite(row.returnPct)||Math.abs(row.returnPct)>1e9)fail();
    const members=row.members.map(m=>{const k=member(m);if(!accounts.includes(m.account)||excluded.has(k))fail();return {...m};});if(new Set(members.map(memberKey)).size!==members.length)fail();
    const e=row.termEvidence;let short=false;
    if(exact(e,['type'])&&e.type==='unknown'){}
    else{
     if(!exact(e,['type','years','scope','period','endDate','source'])||e.type!=='sharesight-average-years-invested'||!Number.isFinite(e.years)||e.years<0||e.years>1000||scopeKey(e.scope)!==k||e.period!==r.period||e.endDate!==s.asOf)fail();
     ref(e.source);if(stockFiles.has(e.source.libraryFileId)&&(!stockSource||e.source.libraryFileId!==stockSource.libraryFileId||!stockScope(row.scope)))fail();short=e.years<1;if(short&&row.unit==='p.a.'||!short&&row.unit==='period')fail();
    }
    const status=row.unit==='unavailable'?'source-unavailable':short?'under-one-year':row.unit==='p.a.'?'annualised':row.unit==='period'?'period-return':'source-unit-unspecified';
    // Closed holdings can differ between windows. Stable category scope does
    // not require dropping holdings sold before the trailing-year start.
    put(row.scope,{status,nativePct:row.returnPct,startDate:r.startDate,endDate:r.endDate,includeClosed:true,cashPerformance:stockSource&&rowSource.libraryFileId===stockSource.libraryFileId?'unknown':r.cashPerformance,accounts:[...new Set(members.map(m=>m.account))].sort(),memberCount:members.length,benchmarkMemberCount:members.filter(m=>benchmarks.has(memberKey(m))).length,source:{...structuredClone(rowSource),locator:row.sourceSheet+'!O'+row.sourceRow},termEvidence:structuredClone(e)});
   }
   if(stockSource){
    if(!stockRow)fail();
    const expected=[],stockCategories=['美国底仓','美国科技','非美发达','新兴市场'];
    for(const name of stockCategories){
     const original=r.rows.filter(row=>row.scope.type==='classification'&&row.scope.name===name&&row.scope.parent===null);
     if(original.length!==1||original[0].sourceFileId&&original[0].sourceFileId!==r.source.libraryFileId)fail();
     expected.push(...original[0].members.map(memberKey));
    }
    if(new Set(expected).size!==expected.length||!same([...expected].sort(),stockRow.members.map(memberKey).sort()))fail();
    const instruments=new Set(stockRow.members.map(m=>canon([m.market,m.securityCode])));
    if(stockRow.members.some(m=>m.market.trim().toUpperCase()==='CASH'))fail();
    // The broad secondary-market subtotal legitimately overlaps these four
    // categories; defensive, thematic and other asset classes must not.
    for(const row of r.rows.filter(row=>row.scope.type==='classification'&&!stockCategories.includes(row.scope.name)&&!stockScope(row.scope)&&row.scope.name!=='二级市场')){
     if(row.members.some(m=>instruments.has(canon([m.market,m.securityCode]))))fail();
    }
   }
   for(const row of r.unavailable){if(!exact(row,['scope','reason'])||!['benchmark-members-included','native-aggregate-not-provided','cash-scope-unverified'].includes(row.reason))fail();put(row.scope,{status:row.reason,nativePct:null,startDate:r.startDate,endDate:r.endDate,includeClosed:true});}
  }
  return {schema:'fee-console.ratio-performance-view.v2',provider:'Sharesight',asOf:s.asOf,currency:'USD',accounts:[...accounts],items:[...items.values()],...(Object.hasOwn(s,'topHoldings')?{topHoldings:buildTop(s.topHoldings,s,expectedTopTargets)}:{})};
 }

 // Only current ranked entries are eligible. The historical return scope can
 // retain sold members of the same exact product; no display-name fuzzy join.
 const topId=t=>canon([t.category,t.name]);
 function topTargets(exposure,companyTop=null){
  const out=[];
  const clean=m=>({account:m.account.replaceAll('&amp;','&'),market:m.market,securityCode:m.securityCode});
  const unique=xs=>[...new Map(xs.map(m=>[memberKey(m),m])).values()].sort((a,b)=>memberKey(a).localeCompare(memberKey(b)));
  for(const g of exposure.summary.classes.slice(0,3))for(const r of g.top5){
   const members=r.sourceHoldings?.map(clean)||r.accounts?.map(account=>clean({...r,account}));
   if(!members?.length)fail();
   out.push({category:g.name,name:r.name,members:unique(members),basis:'fund-holding'});
  }
  if(companyTop)for(const r of companyTop){
   const members=r.constituents.filter(c=>c.product===null||c.basis==='product-asset-replacement').map(clean);
   out.push({category:'二级市场',name:r.name,members:unique(members),basis:'direct-holdings-only'});
  }
  return out;
 }
 function datedName(r){
  for(const value of [r.securityCode,r.name]){
   const marker=value.match(/(?:^|[-–—_:：/\s])(?=(?:19|20)\d{2}(?:[-/.]|年))/);if(!marker)continue;
   const tail=value.slice(marker.index+marker[0].length);
   const n=tail.match(/^(?:19|20)\d{2}[-/.](?:0[1-9]|1[0-2])(?:\s*[-–—_:：/]\s*|\s+)(\S[\s\S]*)$/)?.[1]||tail.match(/^(?:19|20)\d{2}年(?:0?[1-9]|1[0-2])月\s*(?:[-–—_:：/]\s*)?(\S[\s\S]*)$/)?.[1];
   if(n)return n.trim();
  }return null;
 }
 function buildTop(source,parent,expectedTargets=null){
  if(!exact(source,['schema','targets','reports'])||source.schema!=='fee-console.ratio-top5-source.v1'||!Array.isArray(source.targets)||source.targets.length<15||source.targets.length>20||!Array.isArray(source.reports)||source.reports.length!==2)fail();
  const targets=new Map();
  for(const t of source.targets){
   if(!exact(t,['category','name','members','basis'])||!['PE/VC','对冲基金','常青基金','二级市场'].includes(t.category)||!text(t.name)||t.basis!==(t.category==='二级市场'?'direct-holdings-only':'fund-holding')||!Array.isArray(t.members)||!t.members.length&&t.category!=='二级市场'||targets.has(topId(t)))fail();
   const keys=t.members.map(m=>{if(!exact(m,['account','market','securityCode'])||![m.account,m.market,m.securityCode].every(text)||!parent.accounts.includes(m.account))fail();return memberKey(m);});
   if(new Set(keys).size!==keys.length||!same(keys,[...keys].sort((a,b)=>a.localeCompare(b))))fail();targets.set(topId(t),t);
  }
  for(const category of ['PE/VC','对冲基金','常青基金'])if(source.targets.filter(t=>t.category===category).length!==5)fail();
  const secondary=source.targets.filter(t=>t.category==='二级市场').length;if(secondary!==0&&secondary!==5)fail();
  if(expectedTargets!==null&&!same(source.targets,expectedTargets))fail();
  const stockFiles=stockSourceIds(parent);
  const normalized=structuredClone(parent);delete normalized.topHoldings;
  normalized.reports=source.reports.map(r=>{
   if(!exact(r,['period','startDate','endDate','includeClosed','calculationMethod','currency','cashPerformance','source','additionalSources','rows','unavailable'])||!Array.isArray(r.rows)||!Array.isArray(r.unavailable)||!Array.isArray(r.additionalSources)||r.additionalSources.length>1)fail();
   if(stockFiles.has(r.source?.libraryFileId)||r.additionalSources.some(s=>stockFiles.has(s?.libraryFileId))||r.rows.some(row=>stockFiles.has(row.sourceFileId)||stockFiles.has(row.termEvidence?.source?.libraryFileId)))fail();
   const original=parent.reports.find(p=>p.period===r.period);
   if(!original||!same(r.source,original.source)||r.startDate!==original.startDate||r.endDate!==original.endDate||r.cashPerformance!==original.cashPerformance)fail();
   const seen=new Set(),scope=t=>({type:'classification',name:topId(t),parent:null});
   const take=t=>{if(!exact(t,['category','name'])||!targets.has(topId(t))||seen.has(topId(t)))fail();seen.add(topId(t));return targets.get(topId(t));};
   const rows=r.rows.map(row=>{
    const keys=['target','memberEvidence','sourceSheet','sourceRow','returnPct','unit','termEvidence'];
    if(!(exact(row,keys)||exact(row,[...keys,'sourceFileId']))||!Array.isArray(row.memberEvidence)||!row.memberEvidence.length)fail();
    const t=take(row.target),current=new Set(t.members.map(memberKey)),instruments=new Set(t.members.map(m=>canon([m.market,m.securityCode]))),hist=new Set(),coordinates=new Set();
    const members=row.memberEvidence.map(e=>{
     if(!exact(e,['account','market','securityCode','name','category','sourceRow'])||![e.account,e.market,e.securityCode,e.name,e.category].every(text)||!Number.isSafeInteger(e.sourceRow)||e.sourceRow<1||coordinates.has(e.sourceRow)||hist.has(memberKey(e)))fail();
     if(e.category!==t.category)fail();
     const sameInstrument=instruments.has(canon([e.market,e.securityCode]));
     if(!sameInstrument&&!(t.category==='常青基金'&&datedName(e)===t.name))fail();
     coordinates.add(e.sourceRow);hist.add(memberKey(e));return {account:e.account,market:e.market,securityCode:e.securityCode};
    });
    if(!t.members.length||[...current].some(k=>!hist.has(k)))fail();
    const rowScope=scope(t),term=structuredClone(row.termEvidence);
    if(term?.type==='sharesight-average-years-invested'){
     if(!same(term.scope,row.target))fail();term.scope=rowScope;
    }
    return {scope:rowScope,members,sourceSheet:row.sourceSheet,sourceRow:row.sourceRow,returnPct:row.returnPct,unit:row.unit,termEvidence:term,...(Object.hasOwn(row,'sourceFileId')?{sourceFileId:row.sourceFileId}:{})};
   });
   const unavailable=r.unavailable.map(row=>{if(!exact(row,['target','reason'])||!['native-aggregate-not-provided','no-direct-holding'].includes(row.reason))fail();const t=take(row.target);if(row.reason==='no-direct-holding'&&t.members.length)fail();return {scope:scope(t),reason:'native-aggregate-not-provided'};});
   if(seen.size!==targets.size)fail();
   const result={...r,rows,unavailable};if(!result.additionalSources.length)delete result.additionalSources;return result;
  });
  const view=build(normalized,{expectedAccounts:parent.accounts,expectedAsOf:parent.asOf});
  return {targets:structuredClone(source.targets),items:view.items.map(item=>({...item,target:((value)=>({category:value[0],name:value[1]}))(JSON.parse(item.scope.name))}))};
 }
 function selectTop(view,target){return view?.topHoldings?.items.find(x=>same(x.target,target))||null;}

 function renderCompact(item){
  scopeKey(item.scope);
  const lines=[['all','全部'],['oneYear','近一年']].map(([key,label])=>{
   const p=item.periods[key],has=Number.isFinite(p?.nativePct),badge={annualised:'年化','under-one-year':'未满一年','period-return':'期间收益'}[p?.status]||'';
   const reason=has?(badge||'原报表未注明是否年化'):p?.status==='benchmark-members-included'?'含虚拟持仓，尚无匹配小计':p?.status==='cash-scope-unverified'?'现金收益范围待核实':p?.status==='source-unavailable'?'Sharesight 未提供此范围的收益率':'尚无此范围的官方合并收益率';
   const value=has?p.nativePct.toFixed(2)+'%':'—';
   return '<span class="ratio-return-compact-line" aria-label="'+esc(label+'：'+value+'；'+reason)+'"><span>'+label+'：</span><strong title="'+esc(reason)+'">'+esc(value)+'</strong>'+(badge?'<small>'+badge+'</small>':'')+'</span>';
  }).join('');
  return '<div class="ratio-return-compact">'+lines+'</div>';
 }

 function renderTop(item){
  if(!item)return '';
  const secondary=item.target.category==='二级市场';
  const html=renderInline(item,secondary?'直接持仓收益率':'');
  const note=secondary?'仅对应直接持有的实际产品；不包括 ETF 穿透公司敞口。杠杆产品采用自身原生收益，不按敞口倍数乘算。':'同名合并使用精确成员的 Sharesight 官方小计，不平均各项百分比。';
  return html.replace('只显示组合或分类原生收益；已平仓计入历史，不用当前市值权重或穿透敞口重算。',note+' 已平仓计入历史。');
 }

 function select(v,s){const k=scopeKey(s);return v.items.find(x=>scopeKey(x.scope)===k)||{scope:structuredClone(s),periods:{}};}
 const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function renderInline(item,label=''){
  // The same verified values are readable without opening the evidence panel.
  // Dates, account scope and native-unit caveats remain in its disclosure.
  return '<div class="ratio-returns-inline">'+(label?'<p class="ratio-return-inline-label">'+esc(label)+'</p>':'')+renderCompact(item)+renderAggregate(item).replace('<summary>收益率</summary>','<summary>收益说明</summary>')+'</div>';
 }
 function renderAggregate(item){
  scopeKey(item.scope);
  const reasons={'benchmark-members-included':'原报表范围包含仅作基准的虚拟持仓，尚无剔除后的官方合并收益率。','native-aggregate-not-provided':'尚无这个分类范围的 Sharesight 官方合并收益率。','cash-scope-unverified':'该组合的现金收益覆盖尚未得到来源核实。','source-unavailable':'Sharesight 未提供此范围的收益率。'};
  const rows=[['all','All'],['oneYear','近12个月']].map(([key,label])=>{
   const p=item.periods[key],has=typeof p?.nativePct==='number'&&Number.isFinite(p.nativePct),badge={annualised:'年化','under-one-year':'未满一年','period-return':'期间收益','source-unit-unspecified':'原报表口径'}[p?.status]||'';
   const value=has?p.nativePct.toFixed(2)+'%'+(p.status==='annualised'?' p.a.':''):'暂未提供';
   const reason=!p?'尚无这个分类范围的 Sharesight 官方合并收益率。':reasons[p.status]||(p.status==='source-unit-unspecified'?'原报表未注明此数值是否年化；按原值显示，不推算投资期限。':p.status==='under-one-year'?'Sharesight 资金加权平均投资时间未满一年，显示实际收益率，未换算成年化。':p.status==='period-return'?'显示 Sharesight 原生期间收益率，未换算成年化。':'');
   const benchmarkNote=p?.benchmarkMemberCount>0?'含 '+p.benchmarkMemberCount+' 项用于程序取值的模拟基准，收益率沿用官方合计，未剔除其影响；资产配置仍按原规则排除。':'';
   return '<div class="ratio-return-period"><strong>'+label+'</strong><span>'+esc(value)+(badge?' <small class="ratio-return-badge">'+badge+'</small>':'')+'</span>'+(p?'<small>'+esc(p.startDate)+' 至 '+esc(p.endDate)+' · 含已平仓</small>':'')+(reason?'<small>'+reason+'</small>':'')+(benchmarkNote?'<small class="ratio-return-benchmark-note">'+benchmarkNote+'</small>':'')+'</div>';
  }).join('');
  const accounts=[...new Set(Object.values(item.periods).flatMap(p=>p.accounts||[]))].sort(),cash=[...new Set(Object.values(item.periods).map(p=>p.cashPerformance).filter(Boolean))];
  const note=stockScope(item.scope)?'股票市场小计只包含四个股票分类的历史成员，不含现金账户、防御资产或主题投资。':cash.includes('unknown')?'现金账户收益覆盖未获来源确认。':cash.includes('mixed')||cash.length>1?'现金收益覆盖分别保留各期原报表设置。':cash[0]==='included'?'含现金账户收益。':cash[0]==='excluded'?'未含现金账户收益。':'';
  return '<details class="ratio-returns"><summary>收益率</summary><div class="ratio-return-pair">'+rows+'</div><p class="ratio-return-scope">'+esc(accounts.join(' · '))+' · USD · Sharesight 原生口径</p><p>只显示组合或分类原生收益；已平仓计入历史，不用当前市值权重或穿透敞口重算。'+note+'</p></details>';
 }
 return {SCHEMA,build,select,render:renderAggregate,scopeKey,oneYearBefore,topTargets,buildTop,selectTop,renderTop,renderCompact,renderInline};
}
