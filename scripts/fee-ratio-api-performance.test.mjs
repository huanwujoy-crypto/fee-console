// All identifiers, names, dates and figures below are synthetic. No network,
// credential, file or real Sharesight response is used by these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createApiPerformanceCore} from './fee-ratio-api-performance.mjs';
import {createAggregateReturnsCore} from './fee-ratio-aggregate-returns.mjs';
globalThis.fetch=async()=>{throw Error('OFFLINE_TEST_NETWORK_FORBIDDEN');};

const core=createApiPerformanceCore(),ASOF='2026-11-10',ALL='2018-01-01',ONE='2025-11-10';
const accounts=Array.from({length:10},(_,i)=>({id:700+i,name:'Invented member '+i}));
// code, market, asset class, member index, first-buy date, earliest record kind
const POSITIONS=[
  ['VC-A','PRIVATE','VC/PE',2,'2019-01-02','BUY'],
  ['宏观-2020-01-Alpha','PRIVATE','对冲基金',3,'2020-02-03','BUY'],['宏观-2021-05-Beta','PRIVATE','对冲基金',4,'2021-06-07','BUY'],['Legacy hedge fund','PRIVATE','对冲基金',3,'2019-05-06','OPENING_BALANCE'],
  ['多策略-2022-03-Gamma','PRIVATE','对冲基金',3,'2022-04-05','BUY'],
  ['地产-2021-01-Delta','PRIVATE','常青基金',5,'2021-02-03','BUY'],['地产-2021-01-Delta','PRIVATE','常青基金',6,'2021-03-04','BUY'],['No date evergreen','PRIVATE','常青基金',5,'2022-08-09','BUY'],
  ['AAA','NYSE','美国底仓',0,'2019-03-04','OPENING_BALANCE'],['BBB','NASDAQ','美国科技',0,'2023-01-05','BUY'],['BBB','NASDAQ','美国科技',1,'2026-02-03','BUY'],
  ['CCC','LSE','非美发达',0,'2020-07-08','BUY'],['DDD','HKG','新兴市场',1,'2021-09-10','BUY'],['THEME','NYSE','主题投资',0,'2022-11-12','BUY'],['BOND','NYSE','防御资产',0,'2018-06-07','BUY']];
const holdingId=i=>4000+i,pid=p=>accounts[p[3]].id;
// The grouping each custom group puts a position in. Names are arbitrary on purpose.
const GROUPING={
  asset:p=>p[2],
  income:p=>p[2]==='对冲基金'?(p[0].startsWith('多策略')?'Bucket K':'Bucket M'):p[2]==='常青基金'?(p[0]==='No date evergreen'?'Bucket Z':'Bucket R'):p[2]==='VC/PE'?'Bucket V':'Anything else',
  stock:p=>['美国底仓','美国科技','非美发达','新兴市场'].includes(p[2])?'Equities':'Not equities',
  top:p=>p[0]==='地产-2021-01-Delta'?'Top evergreen':p[0]==='BBB'?'Top tech':'Rest'};
function report(group,period,edit=()=>{}){
  const holdings=POSITIONS.map((p,i)=>({id:holdingId(i),instrument:{code:p[0],market_code:p[1],name:'Invented '+p[0]},quantity:1,value:100+i,total_gain:10+i,total_gain_percent:1+i/4,limited:false,valid_position:true,portfolio:{id:pid(p),name:accounts[p[3]].name,consolidated:false},group_id:9,group_name:GROUPING[group](p)}));
  const names=[...new Set(holdings.map(h=>h.group_name))];
  const sub_totals=names.map((group_name,n)=>({group_id:9,group_name,value:500+n,total_gain:50+n,total_gain_percent:(period==='all'?5:2)+n/10+GROUPS.indexOf(group)}));
  const cash_accounts=[{id:8001,name:'Invented cash',value:25.5,total_gain:null,total_gain_percent:null,currency:{code:'USD'},portfolio:{id:accounts[0].id,name:accounts[0].name}},{id:8002,name:'Invented cash',value:30,total_gain:1.25,total_gain_percent:.5,currency:{code:'USD'},portfolio:{id:accounts[1].id,name:accounts[1].name}}];
  const r={portfolio_id:39,start_date:period==='all'?ALL:ONE,end_date:ASOF,include_sales:true,currency:{code:'USD'},percentages_annualised:period==='all',value:9999.99,total_gain:1234.56,total_gain_percent:period==='all'?6.78:3.21,holdings,sub_totals,cash_accounts};
  edit(r);return r;
}
const GROUPS=['asset','income','top','stock'];
function capture(edit=()=>{}){
  const c={schema:core.CAPTURE,asOf:ASOF,allStartDate:ALL,accounts:structuredClone(accounts),
    reports:Object.fromEntries(GROUPS.flatMap((g,gi)=>['all','oneYear'].map((p,pi)=>[g+'.'+p,{report:report(g,p),sha256:String((gi*2+pi+1)%10).repeat(64)}]))),
    holdings:{sha256:'a'.repeat(64),capturedAt:'2026-11-10T09:00:00.000Z',rows:POSITIONS.map((p,i)=>({portfolioId:pid(p),holding:{id:holdingId(i),inception_date:p[4]}}))},
    trades:{rows:POSITIONS.flatMap((p,i)=>[{portfolioId:pid(p),trade:{holding_id:holdingId(i),transaction_date:p[4],description_code:p[5],state:'confirmed'}},{portfolioId:pid(p),trade:{holding_id:holdingId(i),transaction_date:'2026-06-01',description_code:'BUY',state:'confirmed'}}])},
    cash:{sha256:'b'.repeat(64),capturedAt:'2026-11-10T09:01:00.000Z',accounts:[{portfolioId:accounts[0].id,cashAccountId:8001},{portfolioId:accounts[1].id,cashAccountId:8002}],
      transactions:[{cashAccountId:8001,dateTime:'2018-02-03T00:00:00.000Z'},{cashAccountId:8001,dateTime:'2024-01-01T00:00:00.000Z'},{cashAccountId:8002,dateTime:'2019-04-05T00:00:00.000Z'}]}};
  edit(c);return c;
}
const member=(i,code,market)=>({account:accounts[i].name,market,securityCode:code});
// The existing contract wants five targets for each of the three fund classes and none or five for the secondary market.
const absent=(category,n)=>({category,name:'Invented absent '+category+' '+n,members:[member(9,'ABSENT-'+category+'-'+n,'PRIVATE')],basis:'fund-holding'});
const FUND_TARGETS=[{category:'PE/VC',name:'Invented VC-A',members:[member(2,'VC-A','PRIVATE')],basis:'fund-holding'},...[1,2,3,4].map(n=>absent('PE/VC',n)),
  {category:'对冲基金',name:'Invented Gamma',members:[member(3,'多策略-2022-03-Gamma','PRIVATE')],basis:'fund-holding'},...[1,2,3,4].map(n=>absent('对冲基金',n)),
  {category:'常青基金',name:'Delta',members:[member(5,'地产-2021-01-Delta','PRIVATE'),member(6,'地产-2021-01-Delta','PRIVATE')],basis:'fund-holding'},...[1,2,3,4].map(n=>absent('常青基金',n))];
const SECONDARY_TARGETS=[
  {category:'二级市场',name:'Invented BBB',members:[member(0,'BBB','NASDAQ'),member(1,'BBB','NASDAQ')],basis:'direct-holdings-only'},
  {category:'二级市场',name:'Invented AAA',members:[member(0,'AAA','NYSE')],basis:'direct-holdings-only'},
  {category:'二级市场',name:'Invented CCC',members:[member(0,'CCC','LSE')],basis:'direct-holdings-only'},
  {category:'二级市场',name:'Invented gone',members:[member(0,'GONE','NYSE')],basis:'direct-holdings-only'},
  {category:'二级市场',name:'Invented none',members:[],basis:'direct-holdings-only'}];
const TARGETS=[...FUND_TARGETS,...SECONDARY_TARGETS];
const build=(edit,targets=[])=>core.build(capture(edit),{topTargets:targets});
const rowOf=(p,period,name,parent=null)=>p.reports.find(r=>r.period===period).rows.find(r=>r.scope.name===name&&r.scope.parent===parent);
const each=(c,fn)=>{for(const k of Object.keys(c.reports))fn(c.reports[k].report,k);};

test('scopes follow which positions a sub-total covers, never the name of the custom group',()=>{
  const p=build();
  assert.equal(p.transport,'official-api');assert.deepEqual(p.reports.map(r=>[r.period,r.startDate,r.endDate,r.cashPerformance,r.additionalSources.length]),[['all',ALL,ASOF,'included',2],['oneYear',ONE,ASOF,'included',2]]);
  const all=p.reports[0],names=all.rows.map(r=>[r.scope.type,r.scope.name,r.scope.parent,r.members.length]);
  assert.deepEqual(names,[['classification','PE/VC',null,1],['classification','对冲基金',null,4],['classification','常青基金',null,3],['classification','美国底仓',null,1],['classification','美国科技',null,2],['classification','非美发达',null,1],['classification','新兴市场',null,1],['classification','主题投资',null,1],['classification','防御资产',null,1],
    ['portfolio','All Together',null,17],
    // "Bucket M" holds two dated 宏观 funds and one undated legacy fund: one strategy name, taken from the dated ones.
    ['fund-strategy','宏观','对冲基金',3],['fund-strategy','多策略','对冲基金',1],['fund-strategy','地产','常青基金',2],
    // No member of "Bucket Z" carries a dated name.
    ['fund-strategy','未分类','常青基金',1],
    ['classification','二级市场',null,7],['classification','股票市场',null,5]]);
  // Figures are the provider's own, with API identities and field locators.
  const view=createAggregateReturnsCore().build(p,{expectedAccounts:p.accounts,expectedAsOf:ASOF}),item=(name,parent=null)=>view.items.find(i=>i.scope.name===name&&i.scope.parent===parent).periods;
  assert.equal(item('对冲基金').all.nativePct,rowOf(p,'all','对冲基金').returnPct);
  assert.match(item('对冲基金').all.source.apiReportId,/^apireport_[a-f0-9]{32}$/);assert.equal(item('对冲基金').all.source.locator,'report.sub_totals[2].total_gain_percent');
  assert.deepEqual([item('All Together').all.nativePct,item('All Together').all.nativeAmountUSD,item('All Together').all.memberCount],[6.78,1234.56,17]);
  assert.equal(item('All Together').all.source.locator,'report[1].total_gain_percent');
  assert.doesNotMatch(JSON.stringify(p),/libfile_|Bucket|Anything else|Equities|workbook/);
});

test('a rate is annualised only on the provider flag and a full year held; start dates and opening balances come from the listing and trades',()=>{
  const p=build(),unit=(period,name,parent=null)=>rowOf(p,period,name,parent).unit;
  // 美国科技 has a member first bought within the last year.
  assert.deepEqual([unit('all','对冲基金'),unit('all','美国科技'),unit('oneYear','对冲基金'),unit('oneYear','美国科技')],['p.a.','unknown','period','period']);
  assert.equal(build(c=>each(c,(r,k)=>{if(k.endsWith('.all'))r.percentages_annualised=false;})).reports[0].rows.every(r=>r.unit==='unknown'),true);
  assert.equal(build(c=>each(c,(r,k)=>{if(k.endsWith('.oneYear'))r.percentages_annualised=true;})).reports[1].rows.every(r=>r.unit==='unknown'),true);
  const e=p.inceptionEvidence,kind=code=>e.members.find(m=>m.securityCode===code).dateKind;
  assert.equal(e.schema,'fee-console.ratio-inception-source.v2');assert.deepEqual(e.sourceCaptures.map(s=>s.sourceKind),['sharesight-api-holdings','sharesight-api-holdings']);
  assert.deepEqual([kind('AAA'),kind('Legacy hedge fund'),kind('BBB'),kind('Invented cash')],['holding-opening-balance','holding-opening-balance','holding-inception','cash-first-transaction']);
  assert.deepEqual(e.members.filter(m=>m.market==='CASH').map(m=>m.startDate).sort(),['2018-02-03','2019-04-05']);
  const view=createAggregateReturnsCore().build(p,{expectedAccounts:p.accounts,expectedAsOf:ASOF}),period=name=>view.items.find(i=>i.scope.name===name&&i.scope.parent===null).periods.all;
  assert.deepEqual([period('美国底仓').investmentStartDate,period('美国底仓').investmentStartBasis],['2019-03-04','opening-balance-record']);
  // The whole portfolio starts with a cash transaction, which is not an opening-balance holding.
  assert.deepEqual([period('All Together').investmentStartDate,Object.hasOwn(period('All Together'),'investmentStartBasis')],['2018-02-03',false]);
});

// The `top` grouping read again with report_combined=true: the same report plus the provider's own row per security.
function withCombined(c,{ids='object',edit=()=>{}}={}){
  for(const [n,period] of ['all','oneYear'].entries()){
    const r=structuredClone(c.reports['top.'+period].report),merged=new Map();
    for(const h of r.holdings){const k=h.instrument.market_code+'|'+h.instrument.code,old=merged.get(k)||{instrument:{...h.instrument},portfolios:[],value:0,quantity:0,group_name:h.group_name,total_gain_percent:(period==='all'?40:4)+merged.size/8,id:null,limited:null,valid_position:null};
      old.portfolios.push(ids==='object'?{id:h.portfolio.id,name:h.portfolio.name}:h.portfolio.id);old.value+=h.value;merged.set(k,old);}
    r.report_combined=true;r.combined_holdings=[...merged.values()];edit(r,period);
    c.reports['topCombined.'+period]={report:r,sha256:String(8+n).repeat(64)};
  }
}
const noBucket=c=>each(c,(r,k)=>{if(k.startsWith('top.')){for(const h of r.holdings)if(h.group_name==='Top tech')h.group_name='Rest';r.sub_totals=r.sub_totals.filter(x=>x.group_name!=='Top tech');}});
test('a security held in several accounts takes the provider\'s own combined row; nothing else changes',()=>{
  // BBB sits in two accounts and, here, in no bucket of its own: without the combined reading it has no figure.
  const before=core.build(capture(noBucket),{topTargets:TARGETS});
  assert.ok(before.topHoldings.reports[0].unavailable.some(u=>u.target.name==='Invented BBB'));
  for(const ids of ['object','bare']){
    const p=core.build(capture(c=>{noBucket(c);withCombined(c,{ids});}),{topTargets:TARGETS});
    for(const [n,period] of ['all','oneYear'].entries()){
      const top=p.topHoldings.reports[n],row=top.rows.find(r=>r.target.name==='Invented BBB');
      assert.ok(row,period);assert.equal(row.sourceSheet,'report.combined_holdings');assert.equal(row.memberEvidence.length,2);assert.deepEqual(row.memberEvidence.map(e=>e.account).sort(),[accounts[0].name,accounts[1].name].sort());
      // The provider's figure for the merged security, taken as given: not either account's own row, nor a mean of them.
      assert.equal(row.returnPct,capture(c=>{noBucket(c);withCombined(c);}).reports['topCombined.'+period].report.combined_holdings.find(h=>h.instrument.code==='BBB').total_gain_percent);
      const own=report('top',period).holdings.filter(h=>h.instrument.code==='BBB').map(h=>h.total_gain_percent);assert.equal(own.length,2);assert.equal(own.includes(row.returnPct),false);assert.notEqual(row.returnPct,(own[0]+own[1])/2);
      // One additional source per period, and it is the combined reading for every row that needs one.
      assert.equal(top.additionalSources.length,1);assert.equal(top.additionalSources[0].locator,'api-v3-performance-custom-group topCombined.'+period);
      assert.deepEqual([...new Set(top.rows.filter(r=>r.sourceFileId).map(r=>r.sourceFileId))],[top.additionalSources[0].apiReportId]);
      // The fund sub-total and every single-account row are exactly what they were.
      const same=r=>({...r,sourceFileId:undefined}),old=before.topHoldings.reports[n];
      for(const name of ['Invented VC-A','Invented Gamma','Delta','Invented AAA','Invented CCC'])assert.deepEqual(same(top.rows.find(r=>r.target.name===name)),same(old.rows.find(r=>r.target.name===name)),name);
      assert.equal(top.unavailable.length,old.unavailable.length-1);
    }
    // The viewer's own core accepts it against the same targets and shows the figure.
    const view=createAggregateReturnsCore().build(p,{expectedAccounts:p.accounts,expectedAsOf:ASOF,topTargets:TARGETS});
    assert.equal(Number.isFinite(view.topHoldings.items.find(i=>i.target.name==='Invented BBB').periods.all.nativePct),true);
  }
  // With a bucket of its own, the matching sub-total stays the figure, exactly as before; the combined row only fills a gap.
  const withBucket=core.build(capture(),{topTargets:TARGETS}).topHoldings.reports[0],both=core.build(capture(c=>withCombined(c)),{topTargets:TARGETS}).topHoldings.reports[0];
  for(const name of ['Invented BBB','Delta']){const a=both.rows.find(r=>r.target.name===name),b=withBucket.rows.find(r=>r.target.name===name);assert.equal(a.sourceSheet,'report.sub_totals');assert.equal(a.returnPct,b.returnPct);assert.equal(a.sourceRow,b.sourceRow);}
  assert.equal(both.additionalSources.length,1);
});
test('a combined reading that is not an exact repeat, or a combined row that does not fit, changes nothing',()=>{
  const plain=core.build(capture(noBucket),{topTargets:TARGETS});
  const sameAsPlain=edit=>assert.deepEqual(core.build(capture(c=>{noBucket(c);withCombined(c,{edit});}),{topTargets:TARGETS}),plain);
  // Not an exact repeat of the plain `top` report: ignored as a whole.
  sameAsPlain(r=>{r.holdings[0].total_gain_percent+=1;});sameAsPlain(r=>{r.sub_totals[0].total_gain_percent+=1;});sameAsPlain(r=>{r.holdings[13].group_name='Elsewhere';r.sub_totals.push({group_id:9,group_name:'Elsewhere',value:1,total_gain:1,total_gain_percent:1});});
  sameAsPlain(r=>{delete r.combined_holdings;});sameAsPlain(r=>{r.combined_holdings='x';});
  // The row for the security does not fit: no return, two rows, an account missing or unknown, an unlisted holder, a bad shape.
  const bbb=r=>r.combined_holdings.find(h=>h?.instrument?.code==='BBB');
  for(const edit of [r=>{bbb(r).total_gain_percent=null;},r=>{bbb(r).total_gain_percent='7';},r=>{r.combined_holdings.push(structuredClone(bbb(r)));},r=>{bbb(r).portfolios.pop();},
    r=>{bbb(r).portfolios.push({id:999999});},r=>{bbb(r).portfolios.push({id:accounts[4].id});},r=>{bbb(r).portfolios=[];},r=>{bbb(r).portfolios='x';},r=>{bbb(r).portfolios.push(bbb(r).portfolios[0]);},
    r=>{bbb(r).instrument.code='OTHER';},r=>{r.combined_holdings=r.combined_holdings.filter(h=>h.instrument.code!=='BBB');},r=>{r.combined_holdings.unshift(null,7,'x');bbb(r).total_gain_percent=NaN;}]){
    const got=core.build(capture(c=>{noBucket(c);withCombined(c,{edit});}),{topTargets:TARGETS});
    for(const n of [0,1]){assert.equal(got.topHoldings.reports[n].rows.some(r=>r.target.name==='Invented BBB'),false);assert.ok(got.topHoldings.reports[n].unavailable.some(u=>u.target.name==='Invented BBB'&&u.reason==='native-aggregate-not-provided'));
      assert.deepEqual(got.reports[n],plain.reports[n]);}
  }
  // Half a pair, or a combined entry that is not a report of the same window, is refused like any other bad report.
  assert.throws(()=>core.build(capture(c=>{withCombined(c);delete c.reports['topCombined.oneYear'];}),{topTargets:TARGETS}),{message:'RATIO_API_PERFORMANCE_REPORT'});
  assert.throws(()=>core.build(capture(c=>{withCombined(c);c.reports['topCombined.all'].report.start_date='2001-01-01';}),{topTargets:TARGETS}),{message:'RATIO_API_PERFORMANCE_REPORT'});
  assert.throws(()=>core.build(capture(c=>{withCombined(c);c.reports['topCombined.all'].sha256='x';}),{topTargets:TARGETS}),{message:'RATIO_API_PERFORMANCE_REPORT'});
});
test('top five: one holding uses its own row, several accounts use the matching sub-total, anything else is unavailable',()=>{
  const p=core.build(capture(),{topTargets:TARGETS}),top=p.topHoldings.reports[0];
  assert.deepEqual(top.rows.map(r=>[r.target.name,r.sourceSheet,r.memberEvidence.length,Boolean(r.sourceFileId),r.unit]),[['Invented VC-A','report.holdings',1,false,'p.a.'],['Invented Gamma','report.holdings',1,false,'p.a.'],['Delta','report.sub_totals',2,true,'p.a.'],
    ['Invented BBB','report.sub_totals',2,true,'unknown'],['Invented AAA','report.holdings',1,false,'p.a.'],['Invented CCC','report.holdings',1,false,'p.a.']]);
  assert.equal(top.unavailable.length,14);
  assert.deepEqual(top.unavailable.slice(-2),[{target:{category:'二级市场',name:'Invented gone'},reason:'native-aggregate-not-provided'},{target:{category:'二级市场',name:'Invented none'},reason:'no-direct-holding'}]);
  assert.equal(top.rows[4].returnPct,report('asset','all').holdings[8].total_gain_percent);assert.equal(top.additionalSources.length,1);
  // The viewer's own core accepts it against the same targets.
  const view=createAggregateReturnsCore().build(p,{expectedAccounts:p.accounts,expectedAsOf:ASOF,topTargets:TARGETS});assert.equal(view.topHoldings.targets.length,20);
  // A sub-total that also covers another instrument is not that target's figure.
  const mixed=core.build(capture(c=>each(c,(r,k)=>{if(k.startsWith('top.'))r.holdings[13].group_name='Top tech';})),{topTargets:TARGETS});
  assert.equal(mixed.topHoldings.reports[0].rows.some(r=>r.target.name==='Invented BBB'),false);
  assert.ok(mixed.topHoldings.reports[0].unavailable.some(u=>u.target.name==='Invented BBB'&&u.reason==='native-aggregate-not-provided'));
  // Without targets there is no top-five section at all.
  assert.equal(Object.hasOwn(build(),'topHoldings'),false);
});

test('anything that does not fit exactly is refused with a fixed code',()=>{
  const refused=(edit,code,targets=[])=>assert.throws(()=>build(edit,targets),{message:'RATIO_API_PERFORMANCE_'+code},code);
  refused(c=>{c.schema='other';},'CAPTURE');refused(c=>{c.accounts.pop();},'CAPTURE');refused(c=>{c.allStartDate='2026-12-01';},'CAPTURE');
  refused(c=>{delete c.reports['top.oneYear'];},'REPORT');refused(c=>{c.reports['asset.all'].report.include_sales=false;},'REPORT');refused(c=>{c.reports['asset.all'].report.end_date='2026-11-09';},'REPORT');
  refused(c=>{c.reports['asset.all'].report.currency.code='HKD';},'REPORT');refused(c=>{c.reports['asset.all'].report.sub_totals.pop();},'REPORT');refused(c=>{c.reports['asset.all'].report.sub_totals[0].total_gain_percent=null;},'REPORT');
  refused(c=>{c.reports['asset.all'].report.holdings[0].limited=true;},'MEMBER');refused(c=>{c.reports['asset.all'].report.holdings[0].portfolio.id=999;},'MEMBER');
  refused(c=>{const h=c.reports['asset.all'].report.holdings;h.push({...h[0],id:4999});},'MEMBER');
  // The income grouping covers one position fewer than the asset grouping.
  refused(c=>{c.reports['income.all'].report.holdings.pop();},'MEMBER');
  // One income sub-total mixing two fund classes, or two strategies.
  refused(c=>each(c,(r,k)=>{if(k.startsWith('income.'))r.holdings[5].group_name='Bucket M';}),'STRATEGY');
  refused(c=>each(c,(r,k)=>{if(k.startsWith('income.')){r.holdings[4].group_name='Bucket M';r.sub_totals=r.sub_totals.filter(s=>s.group_name!=='Bucket K');}}),'STRATEGY');
  // Two sub-totals that would both be the same strategy of the same class.
  refused(c=>each(c,(r,k)=>{if(k.startsWith('income.')){r.holdings[2].group_name='Bucket M2';r.sub_totals.push({group_name:'Bucket M2',total_gain_percent:1});}}),'STRATEGY');
  // The secondary market split in two.
  refused(c=>each(c,(r,k)=>{if(k.startsWith('income.')){r.holdings[14].group_name='Other half';r.sub_totals.push({group_name:'Other half',total_gain_percent:1});}}),'SECONDARY');
  // No stock sub-total is exactly the four stock classes.
  refused(c=>each(c,(r,k)=>{if(k.startsWith('stock.'))r.holdings[13].group_name='Equities';}),'STOCK');
  refused(c=>{c.holdings.rows.pop();},'INCEPTION');refused(c=>{c.holdings.rows[0].holding.inception_date='2026-12-01';},'INCEPTION');
  // The listed date must be the earliest confirmed record's date.
  refused(c=>{c.trades.rows[0].trade.transaction_date='2018-12-31';},'INCEPTION');
  refused(c=>{c.cash.accounts.pop();},'CASH');refused(c=>{c.cash.transactions=c.cash.transactions.filter(t=>t.cashAccountId!==8002);},'CASH');refused(c=>{c.cash.transactions[0].dateTime='not a date';},'CASH');
  // A position bought before the requested all-time window fails the existing source contract.
  refused(c=>{c.allStartDate='2019-06-01';each(c,(r,k)=>{if(k.endsWith('.all'))r.start_date='2019-06-01';});},'CONTRACT');
  assert.equal(new Set(core.CODES).size,core.CODES.length);
});
