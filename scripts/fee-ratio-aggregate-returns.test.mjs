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
test('calendar-year boundary handles leap dates',()=>{assert.equal(c.oneYearBefore('2024-02-29'),'2023-02-28');assert.equal(c.oneYearBefore('2025-02-28'),'2024-02-28');});
test('supplemental native rows retain the correct workbook identity and hash',()=>{
 const s=fixture();s.reports[0].additionalSources=[ref(4)];s.reports[0].rows[0].sourceFileId=ref(4).libraryFileId;
 const p=build(s).items[0].periods.all;assert.equal(p.nativePct,12.5);assert.equal(p.source.libraryFileId,ref(4).libraryFileId);assert.equal(p.source.sha256,ref(4).sha256);assert.equal(p.source.locator,'Synthetic grouping!O9');
});
test('supplemental rows cannot cite an unregistered or malformed source',()=>{
 for(const edit of [s=>s.reports[0].rows[0].sourceFileId=ref(4).libraryFileId,s=>{s.reports[0].additionalSources=[{...ref(4),sha256:'bad'}]},s=>s.reports[0].additionalSources=[ref(1)],s=>s.reports[0].additionalSources=[],s=>s.reports[0].additionalSources=[ref(3),ref(4)]]){const s=fixture();edit(s);assert.throws(()=>build(s),/REFUSED/);}
});
test('supplemental source identities cannot be reused for a different period',()=>{const s=fixture();for(const r of s.reports)r.additionalSources=[ref(4)];assert.throws(()=>build(s),/REFUSED/);});
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
