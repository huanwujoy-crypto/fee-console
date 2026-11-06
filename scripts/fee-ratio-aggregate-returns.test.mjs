import test from 'node:test';
import assert from 'node:assert/strict';
import {createAggregateReturnsCore} from './fee-ratio-aggregate-returns.mjs';
const c=createAggregateReturnsCore(),end='2026-11-04',accounts=['Account A','Account B'];
const scope=(name='Synthetic category',parent=null)=>({type:parent?'fund-strategy':name==='All Together'?'portfolio':'classification',name,parent});
const member=(account='Account A',securityCode='SYNTHETIC-A')=>({account,market:'SYNTHETIC',securityCode});
const ref=i=>({libraryFileId:'libfile_'+String(i).repeat(32),version:0,sha256:String(i).repeat(64),locator:'Synthetic original'});
function fixture(){return {schema:c.SCHEMA,provider:'Sharesight',currency:'USD',asOf:end,accounts:[...accounts],reports:['all','oneYear'].map((period,i)=>({period,startDate:i?'2025-11-04':'2020-01-02',endDate:end,includeClosed:true,calculationMethod:'sharesight-native',currency:'USD',cashPerformance:'excluded',source:ref(i+1),rows:[{scope:scope(),members:[member()],sourceSheet:'Synthetic grouping',sourceRow:9,returnPct:i?-1.25:12.5,unit:'unknown',termEvidence:{type:'unknown'}}],unavailable:[]}))};}
const opts={expectedAccounts:accounts,expectedAsOf:end};
const build=s=>c.build(s,opts),html=s=>c.render(c.select(build(s),scope()));
function term(r,years){return {type:'sharesight-average-years-invested',years,scope:structuredClone(r.rows[0].scope),period:r.period,endDate:end,source:ref(3)};}
test('only native aggregate values; unknown unit is transparent, not hidden or falsely short',()=>{
 const s=fixture(),before=structuredClone(s),h=html(s);assert.deepEqual(s,before);assert.match(h,/12.50%/);assert.match(h,/-1.25%/);assert.match(h,/原报表口径/);assert.match(h,/未注明此数值是否年化/);assert.doesNotMatch(h,/p.a.|未满一年|未确认|SYNTHETIC-A/);
});
test('reliably less than one year displays actual native rate and short label',()=>{
 const s=fixture();s.reports[0].rows[0].termEvidence=term(s.reports[0],0.75);const v=build(s);assert.equal(v.items[0].periods.all.status,'under-one-year');const h=html(s);assert.match(h,/12.50%/);assert.match(h,/未满一年/);assert.doesNotMatch(h,/未确认|12.50% p.a./);
});
test('one year exact is not less than a year',()=>{const s=fixture();s.reports[0].rows[0].termEvidence=term(s.reports[0],1);assert.doesNotMatch(html(s),/未满一年/);});
test('short query dates alone never prove short investment time',()=>{const s=fixture();s.reports[0].startDate='2026-10-01';assert.doesNotMatch(html(s),/未满一年/);});
test('dated names never prove term',()=>{const s=fixture();for(const r of s.reports)r.rows[0].scope=scope('2026-10-Example');const h=c.render(c.select(build(s),scope('2026-10-Example')));assert.doesNotMatch(h,/未满一年/);});
test('explicit annualised values retain exact magnitude and sign',()=>{const s=fixture();s.reports[0].rows[0].unit='p.a.';assert.match(html(s),/12.50% p.a./);assert.equal(build(s).items[0].periods.all.nativePct,12.5);});
test('explicit period return without a term does not claim under one year',()=>{const s=fixture();s.reports[0].rows[0].unit='period';assert.match(html(s),/12.50%/);assert.match(html(s),/期间收益/);assert.doesNotMatch(html(s),/未满一年|12.50% p.a./);});
test('zero remains a genuine value, absent remains absent',()=>{const s=fixture();s.reports[0].rows[0].returnPct=0;s.reports[1].rows[0].returnPct=null;s.reports[1].rows[0].unit='unavailable';assert.match(html(s),/0.00%/);assert.match(html(s),/暂未提供/);});
test('term evidence binds exact category, period and cutoff',()=>{
 for(const edit of [e=>e.scope=scope('Other'),e=>e.period='oneYear',e=>e.endDate='2026-11-03',e=>e.years=-1,e=>e.source.sha256='bad']){const s=fixture(),e=term(s.reports[0],0.5);edit(e);s.reports[0].rows[0].termEvidence=e;assert.throws(()=>build(s),/REFUSED/);}
});
test('inconsistent explicit annualisation and official term are refused',()=>{for(const [unit,years]of [['p.a.',0.99],['period',1]]){const s=fixture();s.reports[0].rows[0].unit=unit;s.reports[0].rows[0].termEvidence=term(s.reports[0],years);assert.throws(()=>build(s),/REFUSED/);}});
test('no per-holding source, fallback, or render path',()=>{const s=fixture();s.reports[0].rows[0].scope={type:'holding',name:'SYNTHETIC-A',parent:null};assert.throws(()=>build(s),/REFUSED/);assert.equal(c.selectHoldingGroup,undefined);});
test('aggregate membership may differ across periods when closed before the later period',()=>{const s=fixture();s.reports[0].rows[0].members.push(member('Account B','SOLD-B'));const v=build(s);assert.equal(v.items.length,1);assert.equal(v.items[0].periods.all.memberCount,2);assert.equal(v.items[0].periods.oneYear.memberCount,1);assert.match(html(s),/含已平仓/);assert.doesNotMatch(html(s),/SOLD-B/);});
test('two strategies with same name but different fund parents stay separate',()=>{const s=fixture();for(const r of s.reports){r.rows[0].scope=scope('Synthetic strategy','常青基金');r.rows.push({...structuredClone(r.rows[0]),scope:scope('Synthetic strategy','对冲基金'),sourceRow:10,returnPct:77});}const v=build(s);assert.equal(c.select(v,scope('Synthetic strategy','常青基金')).periods.all.nativePct,12.5);assert.equal(c.select(v,scope('Synthetic strategy','对冲基金')).periods.all.nativePct,77);});
test('no percent subtraction or benchmark-containing totals',()=>{const s=fixture(),b=member('Account B','BENCHMARK');s.reports[0].rows[0].members.push(b);assert.throws(()=>c.build(s,{...opts,excludedMembers:[b]}),/REFUSED/);});
test('blocked aggregate explains the missing native filtered scope without leaking its return',()=>{const s=fixture();s.reports[0].rows=[];s.reports[0].unavailable=[{scope:scope(),reason:'benchmark-members-included'}];const h=html(s);assert.match(h,/虚拟持仓/);assert.doesNotMatch(h,/12.50%/);});
test('same ticker in another real account is not excluded',()=>{const s=fixture();const b=member('Account B');assert.doesNotThrow(()=>c.build(s,{...opts,excludedMembers:[b]}));});
test('accepted benchmark members retain native returns with per-period disclosure',()=>{
 const s=fixture(),b=member('Account B','SYNTHETIC-BENCHMARK');s.reports[0].rows[0].members.push(b);const before=structuredClone(s);
 const v=c.build(s,{...opts,benchmarkMembers:[b]}),item=c.select(v,scope()),h=c.render(item);
 assert.deepEqual(s,before);assert.equal(item.periods.all.nativePct,12.5);assert.equal(item.periods.oneYear.nativePct,-1.25);
 assert.equal(item.periods.all.benchmarkMemberCount,1);assert.equal(item.periods.oneYear.benchmarkMemberCount,0);
 assert.match(h,/含 1 项用于程序取值的模拟基准/);assert.match(h,/未剔除其影响/);assert.match(h,/资产配置仍按原规则排除/);
 assert.equal((h.match(/ratio-return-benchmark-note/g)||[]).length,1);
});
test('benchmark disclosure matches the complete account and market identity',()=>{
 const s=fixture(),m=member();for(const b of [{...m,account:'Account B'},{...m,market:'OTHER'}]){
  const v=c.build(s,{...opts,benchmarkMembers:[b]});assert.equal(v.items[0].periods.all.benchmarkMemberCount,0);assert.doesNotMatch(c.render(v.items[0]),/模拟基准/);
 }
});
test('explicit exclusions still fail even when the same benchmark is disclosed',()=>{
 const s=fixture(),b=member();assert.throws(()=>c.build(s,{...opts,benchmarkMembers:[b],excludedMembers:[b]}),/REFUSED/);
});
test('benchmark count cannot be injected into a native source row',()=>{
 const s=fixture();s.reports[0].rows[0].benchmarkMemberCount=0;assert.throws(()=>build(s),/REFUSED/);
});
test('unknown cash scope is stated explicitly',()=>{const s=fixture();s.reports[0].cashPerformance='unknown';assert.match(html(s),/现金账户收益覆盖未获来源确认/);});
test('missing official union is not calculated from categories',()=>{const v=build(fixture());const h=c.render(c.select(v,scope('All Together')));assert.match(h,/尚无这个分类范围/);assert.doesNotMatch(h,/12.50%/);});
test('duplicate scopes, locations, members and periods rejected',()=>{for(const edit of [s=>s.reports[0].rows.push(structuredClone(s.reports[0].rows[0])),s=>s.reports[0].unavailable.push({scope:scope(),reason:'native-aggregate-not-provided'}),s=>s.reports[1].period='all',s=>s.reports[0].rows[0].members.push(member())]){const s=fixture();edit(s);assert.throws(()=>build(s),/REFUSED/);}});
test('source identities, dates, scope and native units strictly validated',()=>{for(const edit of [s=>s.accounts=['Account A'],s=>s.reports[1].startDate='2025-11-05',s=>s.reports[0].source.sha256='bad',s=>s.reports[0].rows[0].unit='estimated',s=>s.reports[0].includeClosed=false,s=>s.reports[0].rows[0].returnPct=NaN]){const s=fixture();edit(s);assert.throws(()=>build(s),/REFUSED/);}});
test('different sheets may use same total row number',()=>{const s=fixture();for(const r of s.reports)r.rows.push({...structuredClone(r.rows[0]),scope:scope('Other category'),sourceSheet:'Other sheet'});assert.equal(build(s).items.length,2);});
test('HTML escapes account text and starts folded',()=>{const s=fixture();s.accounts[0]='<img src=x>';for(const r of s.reports)r.rows[0].members[0].account=s.accounts[0];const h=c.render(c.select(c.build(s,{...opts,expectedAccounts:s.accounts}),scope()));assert.match(h,/&lt;img/);assert.doesNotMatch(h,/<img|<details[^>]*open/);});
test('inline native returns are readable before the closed evidence panel without changing the source',()=>{
 const s=fixture(),before=structuredClone(s),item=c.select(build(s),scope()),h=c.renderInline(item),visible=h.slice(0,h.indexOf('<details'));
 assert.deepEqual(s,before);assert.match(visible,/全部：/);assert.match(visible,/近一年：/);assert.match(visible,/12.50%/);assert.match(visible,/-1.25%/);
 assert.doesNotMatch(visible,/未满一年|p\.a\.|<small>原报表口径/);assert.match(visible,/原报表未注明是否年化/);
 assert.match(h,/<details class="ratio-returns"><summary>收益说明<\/summary>/);assert.doesNotMatch(h,/<details[^>]*open/);
 assert.match(h,/2020-01-02 至 2026-11-04/);assert.match(h,/Account A/);assert.match(h,/含已平仓/);
});
test('inline zero, missing and evidenced short or annualised returns retain distinct meanings',()=>{
 const s=fixture();s.reports[0].rows[0].returnPct=0;s.reports[0].rows[0].termEvidence=term(s.reports[0],0.5);s.reports[1].rows[0].returnPct=null;s.reports[1].rows[0].unit='unavailable';
 let h=c.renderInline(c.select(build(s),scope())).split('<details')[0];assert.match(h,/0.00%/);assert.match(h,/未满一年/);assert.match(h,/近一年：[^]*?—/);assert.doesNotMatch(h,/年化<\/small>/);
 s.reports[0].rows[0].termEvidence=term(s.reports[0],2);s.reports[0].rows[0].unit='p.a.';h=c.renderInline(c.select(build(s),scope())).split('<details')[0];assert.match(h,/<small>年化<\/small>/);assert.doesNotMatch(h,/未满一年/);
});
test('inline absent scope never inherits another classification value and escapes its optional label',()=>{
 const h=c.renderInline(c.select(build(fixture()),scope('Missing')),'<img src=x>'),visible=h.split('<details')[0];
 assert.equal((visible.match(/<strong[^>]*>—<\/strong>/g)||[]).length,2);assert.doesNotMatch(visible,/12.50%|<img/);assert.match(h,/&lt;img src=x&gt;/);
});
test('calendar-year boundary handles leap dates',()=>{assert.equal(c.oneYearBefore('2024-02-29'),'2023-02-28');assert.equal(c.oneYearBefore('2025-02-28'),'2024-02-28');});
test('supplemental native rows retain the correct workbook identity and hash',()=>{
 const s=fixture();s.reports[0].additionalSources=[ref(4)];s.reports[0].rows[0].sourceFileId=ref(4).libraryFileId;
 const p=build(s).items[0].periods.all;assert.equal(p.nativePct,12.5);assert.equal(p.source.libraryFileId,ref(4).libraryFileId);assert.equal(p.source.sha256,ref(4).sha256);assert.equal(p.source.locator,'Synthetic grouping!O9');
});
test('supplemental rows cannot cite an unregistered or malformed source',()=>{
 for(const edit of [s=>s.reports[0].rows[0].sourceFileId=ref(4).libraryFileId,s=>{s.reports[0].additionalSources=[{...ref(4),sha256:'bad'}]},s=>s.reports[0].additionalSources=[ref(1)],s=>s.reports[0].additionalSources=[],s=>s.reports[0].additionalSources=[ref(3),ref(4)]]){const s=fixture();edit(s);assert.throws(()=>build(s),/REFUSED/);}
});
test('supplemental source identities cannot be reused for a different period',()=>{const s=fixture();for(const r of s.reports)r.additionalSources=[ref(4)];assert.throws(()=>build(s),/REFUSED/);});
function stockFixture(){
 const s=fixture();
 for(const [i,r]of s.reports.entries()){
  r.additionalSources=[ref(i+4),ref(i+6)];
  r.rows=['美国底仓','美国科技','非美发达','新兴市场'].map((name,j)=>({...structuredClone(r.rows[0]),scope:scope(name),members:[member(j%2?'Account B':'Account A','STOCK-'+j)],sourceRow:10+j,returnPct:10+j}));
  r.rows.push({...structuredClone(r.rows[0]),scope:scope('Synthetic strategy','常青基金'),members:[member('Account A','FUND')],sourceFileId:r.additionalSources[0].libraryFileId,sourceRow:30,returnPct:99});
  r.rows.push({...structuredClone(r.rows[0]),scope:scope('股票市场'),members:structuredClone(r.rows.slice(0,4).flatMap(row=>row.members)),sourceFileId:r.additionalSources[1].libraryFileId,sourceRow:60,returnPct:i?-2.43:17.23});
 }return s;
}
test('third official workbook is bound only to the exact four-category historical stock subtotal',()=>{
 const s=stockFixture(),before=structuredClone(s),v=build(s),stock=c.select(v,scope('股票市场'));
 assert.deepEqual(s,before);assert.equal(stock.periods.all.nativePct,17.23);assert.equal(stock.periods.oneYear.nativePct,-2.43);
 assert.equal(stock.periods.all.memberCount,4);assert.equal(stock.periods.all.status,'source-unit-unspecified');assert.equal(stock.periods.all.source.libraryFileId,ref(6).libraryFileId);
 const old=structuredClone(s);for(const r of old.reports){r.additionalSources.pop();r.rows.pop();r.unavailable=[{scope:scope('股票市场'),reason:'native-aggregate-not-provided'}];}
 const oldView=build(old);for(const item of oldView.items.filter(x=>x.scope.name!=='股票市场'))assert.deepEqual(c.select(v,item.scope),item);
 assert.doesNotMatch(c.render(stock),/17.23% p.a.|未满一年/);
 assert.equal(stock.periods.all.cashPerformance,'unknown');
 assert.match(c.render(stock),/四个股票分类/);assert.doesNotMatch(c.render(stock),/未含现金账户收益|现金账户收益覆盖未获来源确认/);
});
test('stock supplement rejects missing original categories, wrong members and classification overlap',()=>{
 for(const edit of [r=>r.rows.splice(2,1),r=>r.rows[0].scope.parent='常青基金',r=>r.rows[0].sourceFileId=r.additionalSources[0].libraryFileId,r=>r.rows.at(-1).members.pop(),r=>r.rows.at(-1).members.push(member('Account A','DEFENSIVE')),r=>r.rows[1].members=structuredClone(r.rows[0].members),r=>r.rows.at(-1).members[0].account='Account B']){
  const s=stockFixture();edit(s.reports[0]);assert.throws(()=>build(s),/REFUSED/);
 }
});
test('stock supplement cannot replace the total, other categories or evidence and cannot remain unused',()=>{
 for(const edit of [r=>r.rows.at(-1).scope=scope('All Together'),r=>r.rows.at(-1).scope=scope('防御资产'),r=>r.rows[0].sourceFileId=r.additionalSources[1].libraryFileId,r=>r.rows.at(-1).sourceFileId=r.source.libraryFileId,r=>r.rows.pop(),r=>r.additionalSources.push(ref(9)),r=>{r.rows[0].termEvidence={type:'sharesight-average-years-invested',years:2,scope:r.rows[0].scope,period:r.period,endDate:r.endDate,source:r.additionalSources[1]};}]){
  const s=stockFixture();edit(s.reports[0]);assert.throws(()=>build(s),/REFUSED/);
 }
 const cross=stockFixture();cross.reports[1].rows.at(-1).sourceFileId=cross.reports[0].additionalSources[1].libraryFileId;assert.throws(()=>build(cross),/REFUSED/);
});
test('stock subtotal refuses cash and instruments assigned to a non-stock category in any account',()=>{
 for(const market of ['CASH','cash',' CASH ']){const s=stockFixture(),r=s.reports[0];r.rows[0].members[0].market=market;r.rows.at(-1).members[0].market=market;assert.throws(()=>build(s),/REFUSED/);}
 for(const name of ['防御资产','主题投资','Cash Accounts','常青基金','未分类'])for(const account of accounts){
  const s=stockFixture(),r=s.reports[0];r.rows.push({...structuredClone(r.rows[0]),scope:scope(name),members:[{...r.rows[0].members[0],account}],sourceRow:99});assert.throws(()=>build(s),/REFUSED/);
 }
 const s=stockFixture();for(const r of s.reports)r.rows.push({...structuredClone(r.rows.at(-1)),scope:scope('二级市场'),sourceFileId:r.additionalSources[0].libraryFileId,sourceRow:100});assert.doesNotThrow(()=>build(s));
});
test('same sheet and total coordinate in different original workbooks stay distinct',()=>{
 const s=fixture(),r=s.reports[0];r.additionalSources=[ref(4)];r.rows.push({...structuredClone(r.rows[0]),scope:scope('Second native scope'),sourceFileId:ref(4).libraryFileId,returnPct:3.25});
 const v=build(s);assert.equal(v.items.length,2);assert.equal(v.items[1].periods.all.nativePct,3.25);assert.equal(v.items[0].periods.all.source.libraryFileId,ref(1).libraryFileId);
 r.rows.push({...structuredClone(r.rows[1]),scope:scope('Duplicate source coordinate')});assert.throws(()=>build(s),/REFUSED/);
});

function topFixture(){
 const s=fixture(),targets=[];
 for(const category of ['PE/VC','对冲基金','常青基金','二级市场'])for(let i=0;i<5;i++)targets.push({category,name:category+' Synthetic '+i,members:[member('Account A',category+'-'+i)],basis:category==='二级市场'?'direct-holdings-only':'fund-holding'});
 s.topHoldings={schema:'fee-console.ratio-top5-source.v1',targets,reports:s.reports.map(r=>({...structuredClone(r),additionalSources:[],rows:targets.map((t,i)=>({target:{category:t.category,name:t.name},memberEvidence:t.members.map(m=>({...m,name:t.name,category:t.category,sourceRow:i+30})),sourceSheet:'Combined',sourceRow:i+30,returnPct:i+0.25,unit:'unknown',termEvidence:{type:'unknown'}})),unavailable:[]}))};return s;
}
const topBuild=s=>c.build(s,{...opts,topTargets:s.topHoldings.targets});
test('stock-only supplemental source cannot be reused by top-five or its annualisation evidence',()=>{
 const make=()=>{const s=stockFixture();s.topHoldings=topFixture().topHoldings;return s;};
 const baseline=make();assert.equal(topBuild(baseline).topHoldings.items.length,20);
 for(const edit of [(r,stock)=>r.source=stock,(r,stock)=>r.additionalSources=[stock],(r,stock)=>r.rows[0].sourceFileId=stock.libraryFileId,(r,stock)=>r.rows[0].termEvidence={type:'sharesight-average-years-invested',years:2,scope:r.rows[0].target,period:r.period,endDate:r.endDate,source:stock}]){
  for(const period of [0,1]){const s=make();edit(s.topHoldings.reports[0],s.reports[period].additionalSources[1]);assert.throws(()=>topBuild(s),/REFUSED/);}
 }
});
test('top-five has exactly twenty selected scopes and two native periods, no percent arithmetic',()=>{
 const s=topFixture(),before=structuredClone(s),v=topBuild(s);assert.deepEqual(s,before);assert.equal(v.topHoldings.items.length,20);
 const last=v.topHoldings.items.at(-1),h=c.renderTop(last);assert.match(h,/直接持仓收益率/);assert.match(h,/19.25%/);assert.match(h,/不包括 ETF 穿透/);assert.doesNotMatch(h,/38.50%|57.75%|未满一年|未确认/);
 assert.equal(c.selectTop(v,{category:'二级市场',name:'二级市场 Synthetic 4'}),last);
});
test('top-five exact target and current member binding refuses a sixth item, missing or changed account',()=>{
 for(const change of [s=>s.topHoldings.targets.push(structuredClone(s.topHoldings.targets[0])),s=>s.topHoldings.targets.pop(),s=>s.topHoldings.targets[0].members[0].account='Account B']){
  const s=topFixture(),expected=structuredClone(s.topHoldings.targets);change(s);assert.throws(()=>c.build(s,{...opts,topTargets:expected}),/REFUSED/);
 }
});
test('top-five each period must cover every target once, including explicit missing source',()=>{
 for(const change of [s=>s.topHoldings.reports[0].rows.pop(),s=>s.topHoldings.reports[0].rows.push(structuredClone(s.topHoldings.reports[0].rows[0])),s=>s.topHoldings.reports[0].unavailable.push({target:s.topHoldings.reports[0].rows[0].target,reason:'native-aggregate-not-provided'})]){const s=topFixture();change(s);assert.throws(()=>topBuild(s),/REFUSED/);}
 const s=topFixture(),row=s.topHoldings.reports[0].rows.pop();s.topHoldings.reports[0].unavailable.push({target:row.target,reason:'native-aggregate-not-provided'});assert.match(c.renderTop(topBuild(s).topHoldings.items.find(r=>r.target.name===row.target.name)),/暂未提供/);
});
test('same instrument sold in another account stays in its exact native scope',()=>{
 const s=topFixture(),r=s.topHoldings.reports[0].rows[0];r.memberEvidence.push({...r.memberEvidence[0],account:'Account B',sourceRow:90});const p=topBuild(s).topHoldings.items[0].periods.all;assert.equal(p.memberCount,2);assert.deepEqual(p.accounts,accounts);
});
test('unrelated instrument, account, category and duplicate evidence are refused',()=>{
 for(const change of [r=>r.memberEvidence[0].securityCode='different',r=>r.memberEvidence[0].account='Stranger',r=>r.memberEvidence[0].category='常青基金',r=>r.memberEvidence.push(structuredClone(r.memberEvidence[0]))]){const s=topFixture();change(s.topHoldings.reports[0].rows[0]);assert.throws(()=>topBuild(s),/REFUSED/);}
});
test('evergreen exact dated name admits closed members but preserves share classes and hyphens',()=>{
 const s=topFixture(),t=s.topHoldings.targets[10];t.name='Synthetic Alt E-1';t.members[0].securityCode='2021-01-Synthetic Alt E-1';
 for(const r of s.topHoldings.reports){const x=r.rows[10];x.target.name=t.name;x.memberEvidence[0]={...x.memberEvidence[0],securityCode:t.members[0].securityCode,name:t.name};x.memberEvidence.push({...x.memberEvidence[0],sourceRow:99,securityCode:'Strategy-2020-01-Synthetic Alt E-1'});}
 assert.equal(topBuild(s).topHoldings.items[10].periods.all.memberCount,2);
 for(const code of ['Strategy-2020-01-Synthetic Alt E-2','Strategy-2020-01-Synthetic Alt E1']){const bad=structuredClone(s);bad.topHoldings.reports[0].rows[10].memberEvidence[1].securityCode=code;assert.throws(()=>topBuild(bad),/REFUSED/);}
});
test('top-five merges only an official native subtotal with exact source identity',()=>{
 const s=topFixture(),r=s.topHoldings.reports[0],t=s.topHoldings.targets[0];t.members.push(member('Account B',t.members[0].securityCode));
 for(const report of s.topHoldings.reports){report.rows[0].memberEvidence.push({...report.rows[0].memberEvidence[0],account:'Account B',sourceRow:91});report.additionalSources=[ref(report.period==='all'?5:6)];report.rows[0].sourceFileId=report.additionalSources[0].libraryFileId;report.rows[0].sourceSheet='Synthetic subtotal';report.rows[0].sourceRow=7;report.rows[0].returnPct=17.43;}
 assert.equal(topBuild(s).topHoldings.items[0].periods.all.nativePct,17.43);assert.equal(topBuild(s).topHoldings.items[0].periods.all.source.libraryFileId,ref(5).libraryFileId);
 r.rows[0].sourceFileId=ref(9).libraryFileId;assert.throws(()=>topBuild(s),/REFUSED/);
});
test('top-five source scope and cutoff cannot replace the aggregate source',()=>{
 for(const change of [r=>r.source=ref(9),r=>r.startDate='2021-01-01',r=>r.endDate='2026-11-03',r=>r.includeClosed=false]){const s=topFixture();change(s.topHoldings.reports[0]);assert.throws(()=>topBuild(s),/REFUSED/);}
});
test('top-five annualisation uses its own exact evidence only',()=>{
 const s=topFixture(),r=s.topHoldings.reports[0],x=r.rows[0];x.termEvidence={type:'sharesight-average-years-invested',years:0.5,scope:structuredClone(x.target),period:r.period,endDate:end,source:ref(7)};
 assert.match(c.renderTop(topBuild(s).topHoldings.items[0]),/未满一年/);assert.match(c.renderTop(topBuild(s).topHoldings.items[0]),/0.25%/);
 x.termEvidence.scope.name='Another';assert.throws(()=>topBuild(s),/REFUSED/);
});
test('no-direct-holding cannot conceal an actual holding or supply a false rate',()=>{
 const s=topFixture(),t=s.topHoldings.targets.at(-1);for(const r of s.topHoldings.reports){const x=r.rows.pop();r.unavailable.push({target:x.target,reason:'no-direct-holding'});}assert.throws(()=>topBuild(s),/REFUSED/);t.members=[];assert.doesNotThrow(()=>topBuild(s));
});

test('compact overview keeps two native values and moves unknown-basis text out of visible lines',()=>{
 const s=fixture(),v=build(s),before=structuredClone(v),h=c.renderCompact(c.select(v,scope()));
 assert.equal((h.match(/class="ratio-return-compact-line"/g)||[]).length,2);
 assert.match(h,/>12\.50%<\/strong>/);assert.match(h,/>-1\.25%<\/strong>/);
 assert.doesNotMatch(h,/<small>|p\.a\.|未满一年/);assert.match(h,/aria-label="全部：12\.50%；原报表未注明是否年化"/);
 assert.deepEqual(v,before);
});
test('compact overview never turns a missing value into zero or suppresses its reason',()=>{
 for(const status of ['benchmark-members-included','cash-scope-unverified','source-unavailable','native-aggregate-not-provided']){
  const h=c.renderCompact({scope:scope(),periods:{all:{status,nativePct:null},oneYear:{status:'source-unit-unspecified',nativePct:0}}});
  assert.match(h,/>—<\/strong>/);assert.match(h,/>0\.00%<\/strong>/);assert.doesNotMatch(h,/<small>/);
  assert.match(h,/aria-label="全部：—；[^"]+"/);
 }
});
test('compact overview preserves each proven return basis without inventing investment duration',()=>{
 for(const [status,label]of [['annualised','年化'],['period-return','期间收益'],['under-one-year','未满一年']]){
  const h=c.renderCompact({scope:scope(),periods:{all:{status,nativePct:7.125}}});
  assert.match(h,/>7\.13%<\/strong>/);assert.ok(h.includes('<small>'+label+'</small>'));
  assert.equal((h.match(/<small>/g)||[]).length,1);
 }
 const absent=c.renderCompact({scope:scope(),periods:{}});assert.equal((absent.match(/>—<\/strong>/g)||[]).length,2);
});

function amountFixture(){
 const s=fixture();for(const [i,r]of s.reports.entries()){
  r.additionalSources=[ref(i+4)];r.rows[0].scope=scope('All Together');
  r.rows[0].sourceFileId=r.additionalSources[0].libraryFileId;
  r.rows[0].returnAmountUSD=i?-2345.67:1234567.89;
 }return s;
}
test('portfolio period amounts preserve the exact native total row and supplemental workbook',()=>{
 const s=amountFixture(),before=structuredClone(s),item=c.select(build(s),scope('All Together'));
 assert.deepEqual(s,before);
 for(const [i,key]of ['all','oneYear'].entries()){
  const r=s.reports[i],p=item.periods[key];
  assert.equal(p.nativeAmountUSD,r.rows[0].returnAmountUSD);
  assert.deepEqual(p.amountSource,{...r.additionalSources[0],locator:'Synthetic grouping!N9'});
  assert.deepEqual(p.source,{...r.additionalSources[0],locator:'Synthetic grouping!O9'});
  assert.equal(p.startDate,r.startDate);assert.equal(p.endDate,r.endDate);assert.equal(p.includeClosed,true);
  assert.deepEqual(p.accounts,['Account A']);assert.equal(p.memberCount,1);assert.equal(p.cashPerformance,'excluded');
 }
 const h=c.renderCompact(item,{showAmount:true});
 assert.match(h,/收益 USD 1,234,567\.89/);assert.match(h,/收益 USD -2,345\.67/);
 assert.match(h,/期间收益金额（非年化），含已平仓/);assert.match(h,/12\.50%/);assert.match(h,/-1\.25%/);
});
test('legacy sources keep the identical view shape and never manufacture a zero amount',()=>{
 const s=amountFixture();for(const r of s.reports)delete r.rows[0].returnAmountUSD;
 const before=structuredClone(s),item=c.select(build(s),scope('All Together'));
 for(const p of Object.values(item.periods)){assert.equal(Object.hasOwn(p,'nativeAmountUSD'),false);assert.equal(Object.hasOwn(p,'amountSource'),false);}
 assert.deepEqual(s,before);assert.doesNotMatch(c.renderCompact(item),/收益 USD|ratio-return-amount/);
 const h=c.renderCompact(item,{showAmount:true});assert.equal((h.match(/>收益 —<\/span>/g)||[]).length,2);assert.match(h,/不代表零/);assert.doesNotMatch(h,/收益 USD 0/);
});
test('zero, negative, null and missing portfolio amounts remain distinct from percentage availability',()=>{
 const s=amountFixture();s.reports[0].rows[0].returnAmountUSD=0;s.reports[1].rows[0].returnAmountUSD=null;
 s.reports[0].rows[0].returnPct=null;s.reports[0].rows[0].unit='unavailable';
 const item=c.select(build(s),scope('All Together')),h=c.renderCompact(item,{showAmount:true});
 assert.equal(item.periods.all.nativeAmountUSD,0);assert.equal(item.periods.oneYear.nativeAmountUSD,null);
 assert.match(h,/收益 USD 0\.00/);assert.match(h,/收益 —/);assert.match(h,/>—<\/strong>/);assert.match(h,/-1\.25%/);
});
test('amounts are portfolio-only and cannot introduce independent currency, date, members or source coordinates',()=>{
 for(const edit of [
  row=>row.scope=scope(),row=>row.scope=scope('Synthetic strategy','常青基金'),
  row=>row.returnAmountUSD='12.34',row=>row.returnAmountUSD=undefined,row=>row.returnAmountUSD=NaN,
  row=>row.returnAmountUSD=Infinity,row=>row.returnAmountUSD=-Infinity,row=>row.returnAmountUSD=1e12+1,
  row=>row.returnAmountUSD=0.001,row=>row.returnAmountUSD={value:12.34,currency:'USD'},
  row=>row.amountSource=ref(8),row=>row.amountCurrency='HKD',row=>row.amountDate=end,
  row=>row.amountMembers=[member('Account B')],row=>row.amountSourceRow=10,
 ]){const s=amountFixture();edit(s.reports[0].rows[0]);assert.throws(()=>build(s),/REFUSED/);}
 for(const edit of [r=>r.currency='HKD',r=>r.includeClosed=false,r=>r.endDate='2026-11-03',r=>r.rows[0].sourceFileId=ref(9).libraryFileId,r=>r.rows[0].members[0].account='Outside']){
  const s=amountFixture();edit(s.reports[0]);assert.throws(()=>build(s),/REFUSED/);
 }
 const stock=stockFixture();stock.reports[0].rows.at(-1).returnAmountUSD=100;assert.throws(()=>build(stock),/REFUSED/);
 const top=topFixture();top.topHoldings.reports[0].rows[0].returnAmountUSD=100;assert.throws(()=>topBuild(top),/REFUSED/);
});
test('amount display is opt-in for the portfolio and independent of rate magnitude or annualisation',()=>{
 const s=amountFixture();s.reports[0].rows[0].unit='p.a.';
 const item=c.select(build(s),scope('All Together')),h=c.renderCompact(item,{showAmount:true});
 assert.match(h,/<small>年化<\/small>/);assert.match(h,/收益 USD 1,234,567\.89/);assert.match(h,/期间收益金额（非年化）/);
 assert.doesNotMatch(c.renderCompact(item),/ratio-return-amount/);
 const classification={...structuredClone(item),scope:scope()};assert.doesNotMatch(c.renderCompact(classification,{showAmount:true}),/ratio-return-amount/);
 s.reports[0].rows[0].returnPct=98765.43;
 assert.equal(c.select(build(s),scope('All Together')).periods.all.nativeAmountUSD,1234567.89);
});
test('native amount formatting preserves cents, large values and negative zero without NaN or Infinity',()=>{
 for(const [value,shown]of [[0.29,'0.29'],[-0.29,'-0.29'],[123456789012.34,'123,456,789,012.34'],[1e12,'1,000,000,000,000.00'],[-0,'0.00']]){
  const s=amountFixture();s.reports[0].rows[0].returnAmountUSD=value;
  const h=c.renderCompact(c.select(build(s),scope('All Together')),{showAmount:true});assert.ok(h.includes('收益 USD '+shown));assert.doesNotMatch(h,/NaN|Infinity|USD -0\.00/);
 }
 for(const value of [NaN,Infinity,-Infinity,undefined,null]){
  const h=c.renderCompact({scope:scope('All Together'),periods:{all:{nativePct:1,nativeAmountUSD:value}}},{showAmount:true});
  assert.match(h,/收益 —/);assert.doesNotMatch(h,/NaN|Infinity|收益 USD/);
 }
});
