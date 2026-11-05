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
 function build(s,{expectedAccounts,expectedAsOf,excludedMembers=[],benchmarkMembers=[{account:'Citi-HK & 地产四期',market:'NASDAQ',securityCode:'QQQ'},{account:'Citi-HK & 地产四期',market:'NYSE',securityCode:'SPY'}]}={}){
  if(!exact(s,['schema','provider','currency','asOf','accounts','reports'])||s.schema!==SCHEMA||s.provider!=='Sharesight'||s.currency!=='USD'||!date(s.asOf)||s.asOf!==expectedAsOf)fail();
  const accounts=s.accounts;
  if(!Array.isArray(accounts)||!accounts.length||!accounts.every(text)||new Set(accounts).size!==accounts.length||!Array.isArray(expectedAccounts)||!same([...accounts].sort(),[...expectedAccounts].sort())||!Array.isArray(s.reports)||s.reports.length!==2||!Array.isArray(excludedMembers))fail();
  const member=m=>{if(!exact(m,['account','market','securityCode'])||![m.account,m.market,m.securityCode].every(text))fail();return memberKey(m);};
  if(!Array.isArray(benchmarkMembers))fail();
  const excluded=new Set(excludedMembers.map(member)),benchmarks=new Set(benchmarkMembers.map(member)),periods=new Set(),files=new Set(),items=new Map();
  for(const r of s.reports){
   const reportKeys=['period','startDate','endDate','includeClosed','calculationMethod','currency','cashPerformance','source','rows','unavailable'];
   if(!(exact(r,reportKeys)||exact(r,[...reportKeys,'additionalSources']))||!['all','oneYear'].includes(r.period)||periods.has(r.period)||!date(r.startDate)||r.startDate>r.endDate||r.endDate!==s.asOf||r.includeClosed!==true||r.calculationMethod!=='sharesight-native'||r.currency!=='USD'||!['included','excluded','mixed','unknown'].includes(r.cashPerformance)||!Array.isArray(r.rows)||!Array.isArray(r.unavailable))fail();
   if(r.period==='oneYear'&&r.startDate!==oneYearBefore(s.asOf))fail();ref(r.source);if(files.has(r.source.libraryFileId))fail();files.add(r.source.libraryFileId);periods.add(r.period);
   const sources=new Map([[r.source.libraryFileId,r.source]]);
   if('additionalSources' in r){
    if(!Array.isArray(r.additionalSources)||r.additionalSources.length!==1)fail();
    for(const source of r.additionalSources){ref(source);if(files.has(source.libraryFileId))fail();files.add(source.libraryFileId);sources.set(source.libraryFileId,source);}
   }
   const scopes=new Set(),locations=new Set();
   const put=(scope,p)=>{const k=scopeKey(scope);if(scopes.has(k))fail();scopes.add(k);const item=items.get(k)||{scope:structuredClone(scope),periods:{}};item.periods[r.period]=p;items.set(k,item);};
   for(const row of r.rows){
    const rowKeys=['scope','members','sourceSheet','sourceRow','returnPct','unit','termEvidence'];
    if(!(exact(row,rowKeys)||exact(row,[...rowKeys,'sourceFileId']))||!text(row.sourceSheet)||!Number.isSafeInteger(row.sourceRow)||row.sourceRow<1||!['p.a.','period','unknown','unavailable'].includes(row.unit)||!Array.isArray(row.members)||!row.members.length)fail();
    const rowSource=sources.get('sourceFileId' in row?row.sourceFileId:r.source.libraryFileId);if(!rowSource)fail();
    const k=scopeKey(row.scope),loc=canon([rowSource.libraryFileId,row.sourceSheet,row.sourceRow]);if(locations.has(loc))fail();locations.add(loc);
    if(row.unit==='unavailable'?row.returnPct!==null:typeof row.returnPct!=='number'||!Number.isFinite(row.returnPct)||Math.abs(row.returnPct)>1e9)fail();
    const members=row.members.map(m=>{const k=member(m);if(!accounts.includes(m.account)||excluded.has(k))fail();return {...m};});if(new Set(members.map(memberKey)).size!==members.length)fail();
    const e=row.termEvidence;let short=false;
    if(exact(e,['type'])&&e.type==='unknown'){}
    else{
     if(!exact(e,['type','years','scope','period','endDate','source'])||e.type!=='sharesight-average-years-invested'||!Number.isFinite(e.years)||e.years<0||e.years>1000||scopeKey(e.scope)!==k||e.period!==r.period||e.endDate!==s.asOf)fail();
     ref(e.source);short=e.years<1;if(short&&row.unit==='p.a.'||!short&&row.unit==='period')fail();
    }
    const status=row.unit==='unavailable'?'source-unavailable':short?'under-one-year':row.unit==='p.a.'?'annualised':row.unit==='period'?'period-return':'source-unit-unspecified';
    // Closed holdings can differ between windows. Stable category scope does
    // not require dropping holdings sold before the trailing-year start.
    put(row.scope,{status,nativePct:row.returnPct,startDate:r.startDate,endDate:r.endDate,includeClosed:true,cashPerformance:r.cashPerformance,accounts:[...new Set(members.map(m=>m.account))].sort(),memberCount:members.length,benchmarkMemberCount:members.filter(m=>benchmarks.has(memberKey(m))).length,source:{...structuredClone(rowSource),locator:row.sourceSheet+'!O'+row.sourceRow},termEvidence:structuredClone(e)});
   }
   for(const row of r.unavailable){if(!exact(row,['scope','reason'])||!['benchmark-members-included','native-aggregate-not-provided','cash-scope-unverified'].includes(row.reason))fail();put(row.scope,{status:row.reason,nativePct:null,startDate:r.startDate,endDate:r.endDate,includeClosed:true});}
  }
  return {schema:'fee-console.ratio-performance-view.v2',provider:'Sharesight',asOf:s.asOf,currency:'USD',accounts:[...accounts],items:[...items.values()]};
 }
 function select(v,s){const k=scopeKey(s);return v.items.find(x=>scopeKey(x.scope)===k)||{scope:structuredClone(s),periods:{}};}
 const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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
  const note=cash.includes('unknown')?'现金账户收益覆盖未获来源确认。':cash.includes('mixed')||cash.length>1?'现金收益覆盖分别保留各期原报表设置。':cash[0]==='included'?'含现金账户收益。':cash[0]==='excluded'?'未含现金账户收益。':'';
  return '<details class="ratio-returns"><summary>收益率</summary><div class="ratio-return-pair">'+rows+'</div><p class="ratio-return-scope">'+esc(accounts.join(' · '))+' · USD · Sharesight 原生口径</p><p>只显示组合或分类原生收益；已平仓计入历史，不用当前市值权重或穿透敞口重算。'+note+'</p></details>';
 }
 return {SCHEMA,build,select,render:renderAggregate,scopeKey,oneYearBefore};
}
