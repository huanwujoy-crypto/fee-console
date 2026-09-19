import assert from 'node:assert/strict';
import test from 'node:test';
import {TREND_METHOD, ETF_WEIGHTS, ETF_STALE_AFTER_DAYS, simulateEtfTrend, projectEtfTrend, validateTrendProjection, renderEtfTrend, renderEtfTrendCompact, projectOpenEtfTrend, validateOpenEtfTrend, etfTrendAgeDays, zoneDate} from './xuan-ib-etf-trend.mjs';
const syms=Object.keys(ETF_WEIGHTS), clone=v=>structuredClone(v);
const day=(date,actualUsd=1200000,price=100,flows=[])=>({date,actualUsd,actualComplete:true,flowsComplete:true,sourceRef:'synthetic source',flows,
  quotes:Object.fromEntries(syms.map(s=>[s,{status:'close',date,usd:price,source:'synthetic USD close'}]))});
const input=(days=[day('2026-09-01')])=>({methodId:TREND_METHOD,startDate:'2026-09-01',frozenDate:'2026-09-04',initialUsd:1200000,reserveUsd:240000,days});
const run=days=>simulateEtfTrend(input(days));
const eq=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`);
const flow=(date,usd,id='fixture-flow')=>({id,date,usd,kind:'external'});
const closeMarket=d=>{for(const s of syms)d.quotes[s]={status:'closed'};return d;};
const openNow = new Date('2026-09-04T08:00:00Z');
test('open summary is allowlisted and excludes raw financial sources and relative wealth',()=>{
  const result=run([day('2026-09-01'),day('2026-09-02',1300000,100,[flow('2026-09-02',100000)])]);
  const before=JSON.stringify(result),open=projectOpenEtfTrend(result,{now:openNow});
  assert.deepEqual(open.latestBalances,{date:'2026-09-02',usd:result.rows[1].endingUsd});
  assert.equal(JSON.stringify(result),before);
  for(const field of ['sourceRef','relativeWealth','initialUsd','gainUsd','cumulativeFlowUsd','flows','result','positions','holdings'])assert.equal(JSON.stringify(open).includes('"'+field+'"'),false,field);
  assert.equal(JSON.stringify(open).includes('synthetic source'),false);
  const html=renderEtfTrend(open);assert.match(html,/估算余额 USD/);assert.doesNotMatch(html,/访问码|私密信息/);
});
test('open balances use the last complete day while estimates remain on the chart',()=>{
  const d=day('2026-09-02',1210000);d.quotes.EXUS={status:'missing'};
  const result=run([day('2026-09-01'),d]),open=projectOpenEtfTrend(result,{now:openNow});
  assert.equal(open.rows.at(-1).estimated,true);assert.equal(open.latestBalances.date,'2026-09-01');
  assert.deepEqual(open.latestBalances.usd,result.rows[0].endingUsd);
});
test('open schema rejects extra fields, invalid balances, inconsistent dates and metrics',()=>{
  const base=projectOpenEtfTrend(run([day('2026-09-01'),day('2026-09-02',1210000,101)]),{now:openNow});
  for(const mutate of [d=>d.sourceRef='private',d=>d.rows[0].sourceRef='private',d=>d.rows[0].relativeWealth={A:100,B:100,C:100},
    d=>d.latestBalances.usd.account='private',d=>d.latestBalances.usd.A=-1,d=>d.latestBalances.usd.B=NaN,d=>d.latestBalances.usd.C=Infinity,
    d=>d.latestBalances.date='2026-09-01',d=>d.schemaVersion=2,d=>d.purpose='other',d=>d.rows[1].maxDrawdown.A=.5,
    d=>d.rows[1].quoteDates.EXUS='2026-09-03',d=>d.rows[0].index.C=101]){
    const d=clone(base);mutate(d);assert.throws(()=>validateOpenEtfTrend(d,{now:openNow}));
  }
});
test('open summary retains Hong Kong approval, New York source and date rollback gates',()=>{
  const data=projectOpenEtfTrend(run([day('2026-09-01'),day('2026-09-02')]),{now:openNow});
  assert.throws(()=>validateOpenEtfTrend(data,{now:new Date('2026-09-03T15:59:00Z')}),/Future/);
  assert.throws(()=>validateOpenEtfTrend(data,{now:openNow,maxSeenDate:'2026-09-03'}),/older/);
  assert.throws(()=>validateOpenEtfTrend(data,{now:openNow,maxSeenDate:'invalid'}),/Invalid/);
  const future=projectOpenEtfTrend(run([day('2026-09-01'),day('2026-09-02'),day('2026-09-03'),day('2026-09-04')]),{now:openNow});
  assert.throws(()=>validateOpenEtfTrend(future,{now:new Date('2026-09-04T00:30:00Z')}),/business/);
});
test('same baseline; reserve only affects B investment, not initial wealth',()=>{
  const r=run([day('2026-09-01'),day('2026-09-02',1320000,110)]);
  assert.deepEqual(r.rows[0].endingUsd,{A:1200000,B:1200000,C:1200000});
  for(const [a,n] of Object.entries({A:110,B:108,C:110}))eq(r.rows[1].index[a],n);
});
test('flat prices and matched EOD flows have zero return',()=>{
  const r=run([day('2026-09-01'),day('2026-09-02',1300000,100,[flow('2026-09-02',100000)]),day('2026-09-03',1200000,100,[flow('2026-09-03',-100000,'out')])]);
  for(const r0 of r.rows)for(const a of ['A','B','C'])eq(r0.index[a],100);
  assert.deepEqual(r.rows.at(-1).gainUsd,{A:0,B:0,C:0});
});
test('EOD inflow is invested after that day return, not before',()=>{
  const r=run([day('2026-09-01'),day('2026-09-02',1420000,110,[flow('2026-09-02',100000)])]);
  eq(r.rows[1].index.A,110);eq(r.rows[1].index.C,110);eq(r.rows[1].endingUsd.C,1420000);
});
test('same-day net flow is independent of event ordering',()=>{
  const a=day('2026-09-02',1250000,100,[flow('2026-09-02',100000,'in'),flow('2026-09-02',-50000,'out')]);
  const b=clone(a);b.flows.reverse();assert.deepEqual(run([day('2026-09-01'),a]),run([day('2026-09-01'),b]));
});
test('duplicate events and incorrect scope signs rejected',()=>{
  assert.throws(()=>run([day('2026-09-01'),day('2026-09-02',1300000,100,[flow('2026-09-02',50000),flow('2026-09-02',50000)])]),/Duplicate/);
  const d=day('2026-09-02',1200010,100,[{...flow('2026-09-02',10),kind:'scope-out'}]);assert.throws(()=>run([day('2026-09-01'),d]),/sign/);
});
test('ordinary trades and dividends cannot be mislabelled external flow',()=>{
  for(const kind of ['trade','dividend','fee','transfer-internal']){
    const d=day('2026-09-02',1200000,100,[{...flow('2026-09-02',0),kind}]);assert.throws(()=>run([day('2026-09-01'),d]),/Internal/);
  }
});
test('scope crossing is a matched flow, not performance',()=>{
  const d=day('2026-09-02',1180000,100,[{...flow('2026-09-02',-20000),kind:'scope-out'}]);
  for(const n of Object.values(run([day('2026-09-01'),d]).rows[1].index))eq(n,100);
});
test('holiday contribution stays cash until next common real close',()=>{
  const r=run([day('2026-09-01'),closeMarket(day('2026-09-02',1300000,100,[flow('2026-09-02',100000)])),day('2026-09-03',1420000,110)]);
  eq(r.rows[2].endingUsd.C,1420000);eq(r.rows[2].endingUsd.B,1396000);
  assert.equal(r.rows[1].canTrade,false);assert.equal(r.rows[1].quoteDates.CSPX,'2026-09-01');
});
test('holiday withdrawal requiring ETF sale stops atomically',()=>{
  const r=run([day('2026-09-01'),closeMarket(day('2026-09-02',1100000,100,[flow('2026-09-02',-100000)]))]);
  assert.equal(r.rows.length,1);assert.match(r.stop.reason,/real common closing price/);
});
test('B only uses reserve after securities are exhausted',()=>{
  const r=run([day('2026-09-01'),day('2026-09-02',200000,100,[flow('2026-09-02',-1000000)])]);
  eq(r.rows[1].endingUsd.B,200000);assert.equal(r.rows[1].reserveUsed,true);eq(r.rows[1].index.B,100);
});
test('cannot borrow to satisfy a withdrawal larger than wealth',()=>{
  const r=run([day('2026-09-01'),day('2026-09-02',0,100,[flow('2026-09-02',-1300000)])]);
  assert.equal(r.rows.length,1);assert.match(r.stop.reason,/exceeds wealth/);
});
test('zero wealth stops the next interval without divide by zero',()=>{
  const r=run([day('2026-09-01'),day('2026-09-02',0,100,[flow('2026-09-02',-1200000)]),day('2026-09-03',0)]);
  assert.equal(r.rows.length,2);assert.equal(r.stop.date,'2026-09-03');
});
test('B is buy-and-hold, not daily rebalanced',()=>{
  const d2=day('2026-09-02');d2.quotes.CSPX.usd=200;
  const d3=clone(d2);d3.date='2026-09-03';for(const q of Object.values(d3.quotes))q.date=d3.date;d3.quotes.EXUS.usd=200;
  const r=run([day('2026-09-01'),d2,d3]);eq(r.rows[2].endingUsd.B,240000+960000*(.60*2+.23*2+.12+.05));
});
test('missing quote window counts trading misses, not holidays',()=>{
  const days=[day('2026-09-01')];for(let n=2;n<=6;n++){const d=day(`2026-09-0${n}`);d.quotes.EXUS={status:n===4||n===5?'closed':'missing'};days.push(d);}
  const r=run(days);assert.equal(r.stop.date,'2026-09-06');assert.equal(r.rows.length,5);assert.equal(r.latestCompleteDate,'2026-09-01');
});
test('fresh quote never silently repairs unverified prior history; replay does',()=>{
  const d2=day('2026-09-02');d2.quotes.EXUS={status:'missing'};
  const r=run([day('2026-09-01'),d2,day('2026-09-03')]);assert.equal(r.latestCompleteDate,'2026-09-01');assert.equal(projectEtfTrend(r).rows[2].estimated,true);
  const replay=run([day('2026-09-01'),day('2026-09-02'),day('2026-09-03')]);assert.equal(replay.latestCompleteDate,'2026-09-03');
});
test('unknown flows stop, missing dates and future baseline quotes reject',()=>{
  const d2=day('2026-09-02');d2.flowsComplete=false;assert.equal(run([day('2026-09-01'),d2]).rows.length,1);
  assert.throws(()=>run([day('2026-09-01'),day('2026-09-03')]),/contiguous/);
  const d=day('2026-09-01');d.quotes.CSPX.date='2026-09-02';assert.throws(()=>run([d]),/closing quote/);
});
test('EQAC is not a required quote while weight zero; accumulating prices get no duplicated income',()=>{
  assert.equal(run([day('2026-09-01')]).rows.length,1);assert.equal(Object.hasOwn(ETF_WEIGHTS,'EQAC'),false);
  eq(run([day('2026-09-01'),day('2026-09-02',1200000,110)]).rows[1].endingUsd.C,1320000);
});
test('drawdown is derived from index path and cannot decline or contradict',()=>{
  const p=projectEtfTrend(run([day('2026-09-01'),day('2026-09-02',1320000,110),day('2026-09-03',1188000,99)]));
  eq(p.rows[2].maxDrawdown.A,.1);validateTrendProjection(p);
  for(const n of [.9,0]){const bad=clone(p);bad.rows[2].maxDrawdown.A=n;assert.throws(()=>validateTrendProjection(bad),/Drawdown/);}
});
test('view preserves actual price dates and retrospective labels',()=>{
  const p=projectEtfTrend(run([day('2026-09-01'),closeMarket(day('2026-09-02'))]));
  const html=renderEtfTrend(p);assert.match(html,/CSPX 价格日 2026-09-01/);assert.match(html,/2026-09-04 前是回溯模拟/);assert.match(html,/stroke-dasharray/);
  assert.throws(()=>validateTrendProjection({...p,secret:'not allowed'}),/Unexpected/);
});
test('amounts must be bound to the exact chart result',()=>{
  const r=run([day('2026-09-01')]),p=projectEtfTrend(r);const other=clone(r);other.rows[0].endingUsd.A++;
  assert.throws(()=>renderEtfTrend(p,{privateResult:other}),/same result/);assert.match(renderEtfTrend(p,{privateResult:r}),/1,200,000/);
});
test('source caveat appears once inside folded calculation notes without changing data',()=>{
  const r=run([day('2026-09-01'),day('2026-09-02')]),p=projectEtfTrend(r);
  const before=clone({r,p});
  const caveat='<li>流量按可得账表核对；来源更正后从起点重算。本比较不是审计结算。</li>';
  for(const options of [{},{privateResult:r}]){
    const html=renderEtfTrend(p,options);
    const folded=html.match(/<details\b([^>]*)><summary>计算说明与回撤<\/summary>([\s\S]*?)<\/details>/);
    assert.ok(folded,'calculation notes exist');
    assert.doesNotMatch(folded[1],/\bopen\b/);
    assert.ok(folded[2].includes(caveat));
    assert.equal(html.split(caveat).length-1,1);
    assert.ok(!html.replace(folded[0],'').includes(caveat));
  }
  assert.deepEqual({r,p},before);
});
test('a comparison that stopped updating states its age instead of showing a stale balance as current',()=>{
  const open=projectOpenEtfTrend(run([day('2026-09-01'),day('2026-09-02'),day('2026-09-03')]),{now:openNow});
  assert.equal(open.latestCompleteDate,'2026-09-03');
  const frozen=renderEtfTrend(open);
  // A frozen historical artifact states no reading date and keeps its bytes.
  assert.equal(renderEtfTrend(open,{}),frozen);
  assert.doesNotMatch(frozen,/没有更新|数值<\/small>/);
  // A weekend plus one market holiday is still an ordinary gap between closes.
  for(const viewDate of ['2026-09-03','2026-09-08']){
    const html=renderEtfTrend(open,{viewDate});
    assert.doesNotMatch(html,/没有更新/);
    assert.match(html,/估算余额 USD<br><small[^>]*>2026-09-03 数值<\/small>/);
  }
  const stale=renderEtfTrend(open,{viewDate:'2026-09-16'});
  assert.match(stale,/本比较自 2026-09-03 起没有更新，已落后 13 天/);
  assert.match(stale,/之后的转入、转出与行情都没有计入，不能当作当前余额/);
  assert.equal(stale.split('已落后').length-1,1);
  assert.match(renderEtfTrend(open,{viewDate:'2026-09-09'}),/已落后 6 天/);
  assert.equal(etfTrendAgeDays(open,'2026-09-16'),13);
  assert.equal(ETF_STALE_AFTER_DAYS,5);
  // The age is measured against a stated date, never guessed or run backwards.
  assert.throws(()=>renderEtfTrend(open,{viewDate:'2026-09-02'}),/View date precedes/);
  for(const bad of ['2026-9-16','2026-02-30','',null,20260916])assert.throws(()=>etfTrendAgeDays(open,bad),/Invalid view date/);
});
test('the staleness notice adds no value, changes no amount and stays escaped',()=>{
  const result=run([day('2026-09-01'),day('2026-09-02',1300000,100,[flow('2026-09-02',-300000)])]);
  const open=projectOpenEtfTrend(result,{now:openNow}),before=JSON.stringify(open);
  const stale=renderEtfTrend(open,{viewDate:'2026-09-16'});
  assert.equal(JSON.stringify(open),before);
  for(const arm of ['A','B','C'])assert.ok(stale.includes(new Intl.NumberFormat('zh-HK',{maximumFractionDigits:0}).format(open.latestBalances.usd[arm])),arm);
  assert.equal(stale.split('估算余额 USD').length-1,1);
  assert.doesNotMatch(stale,/<script|javascript:/i);
  assert.equal(zoneDate('Asia/Hong_Kong',new Date('2026-09-16T20:00:00Z')),'2026-09-17');
  assert.equal(zoneDate('America/New_York',new Date('2026-09-16T20:00:00Z')),'2026-09-16');
});
test('compact phone card mirrors the fee console: period line, return rows, same-cash-path table with gaps, folded method, no script',()=>{
  const open=projectOpenEtfTrend(run([day('2026-09-01'),day('2026-09-02',1210000,101),day('2026-09-03',1188000,99)]),{now:openNow});
  const fresh=renderEtfTrendCompact(open,{viewDate:'2026-09-03'});
  assert.match(fresh,/id="xuan-etf-trend-v2"/);assert.match(fresh,/ABC 表现比较/);
  assert.match(fresh,/数据至 09-03/);assert.doesNotMatch(fresh,/停在|落后 \d+ 天/);
  assert.match(fresh,/收益率 · 2026-09-01 → 2026-09-03（2 天）/);
  for(const arm of ['A','B','C'])assert.equal((fresh.match(new RegExp(`>${arm}</span>`,'g'))||[]).length,2,arm);
  assert.match(fresh,/实际 <span[^>]*>· 实际持仓 · 剔除出入金<\/span>/);assert.match(fresh,/建议 <span[^>]*>· 模拟<\/span>/);assert.match(fresh,/标普500 <span[^>]*>· 模拟 · CSPX<\/span>/);
  assert.match(fresh,/>-1\.00%<\/b>/);
  assert.match(fresh,/相同资金路径 · 期末金额（2026-09-03 数值）/);
  assert.match(fresh,/<th[^>]*>方案<\/th><th[^>]*>期末金额<\/th><th[^>]*>实际相对模拟<\/th>/);
  assert.match(fresh,/09-03 同日数值/);assert.match(fresh,/\$1,188,000/);
  // 实际相对模拟 = A − simulated, per row, with the fee console's 领先 / 落后 wording.
  const {A,B,C}=open.latestBalances.usd,usd=v=>`$${new Intl.NumberFormat('zh-HK',{maximumFractionDigits:0}).format(Math.abs(v))}`;
  for(const v of [A-B,A-C])assert.match(fresh,new RegExp(`>${Math.abs(v)<0.5?'持平':v>0?'领先':'落后'}</span><span[^>]*>\\${usd(v)}<`));
  assert.ok(A<B&&Math.abs(A-C)<0.5,'fixture: B leads, C ties');assert.match(fresh,/>落后<\/span>/);assert.match(fresh,/>持平<\/span>/);
  assert.equal((fresh.match(/<tr>/g)||[]).length,4);
  assert.equal((fresh.match(/<path /g)||[]).length,6);assert.equal((fresh.match(/<circle /g)||[]).length,3);
  assert.match(fresh,/<details[^>]*><summary[^>]*>查看计算方法与重要说明<\/summary>/);
  assert.match(fresh,/金额差＝实际资产－模拟余额/);assert.match(fresh,/最大回撤：A 1\.82% \/ B/);
  assert.doesNotMatch(fresh,/<script|<form|<button|<a /i);
  assert.doesNotMatch(fresh,/#246ac4|#8b4ab8|#555f6d/);
  const stale=renderEtfTrendCompact(open,{viewDate:'2026-09-18'});
  assert.match(stale,/停在 09-03 · 落后 15 天/);assert.match(stale,/之后的出入金与行情都没有计入/);
  assert.equal(renderEtfTrendCompact(open),renderEtfTrendCompact(open,{viewDate:null}));
  assert.match(renderEtfTrendCompact(open),/数据至 09-03/);
  const stopped=projectOpenEtfTrend(run([day('2026-09-01'),day('2026-09-02'),{...day('2026-09-03'),flowsComplete:false}]),{now:openNow});
  assert.match(renderEtfTrendCompact(stopped,{viewDate:'2026-09-03'}),/09-03 起待补/);
  assert.throws(()=>renderEtfTrendCompact(projectEtfTrend(run([day('2026-09-01')]))),/open summary only/);
  // The legacy renderer is untouched so the frozen archive keeps its bytes.
  assert.match(renderEtfTrend(open),/#246ac4/);
  // A daily-mode comparison names its A definition once, in the folded method.
  const daily=simulateEtfTrend({...input([day('2020-09-01'),day('2020-09-02',1210000,101)]),startDate:'2020-09-01',frozenDate:'2020-09-01'});
  const dailyHtml=renderEtfTrendCompact(projectOpenEtfTrend(daily,{now:openNow}));
  assert.match(dailyHtml,/实际 <span[^>]*>· IB 账户 · 剔除出入金<\/span>/);assert.equal(dailyHtml.split('每日自动更新').length-1,1);
  assert.match(dailyHtml,/收益率 · 2020-09-01 → 2020-09-02（1 天）/);
});
test('a comparison on the v2.1 daily baseline explains its A definition and flow rule; the 09-01 series is unchanged',()=>{
  const legacy=projectOpenEtfTrend(run([day('2026-09-01')]),{now:openNow});
  assert.doesNotMatch(renderEtfTrend(legacy),/每日自动更新|PortfolioAnalyst/);
  const daily=simulateEtfTrend({...input([day('2020-09-01'),day('2020-09-02',1210000,101)]),startDate:'2020-09-01',frozenDate:'2020-09-01'});
  const html=renderEtfTrend(projectOpenEtfTrend(daily,{now:openNow}));
  assert.match(html,/A 为 IB 账户官方日终 NAV（PortfolioAnalyst）/);
  assert.match(html,/比较停在该日并注明，待申报后自动续算/);
  assert.equal(html.split('每日自动更新').length-1,1);
});
