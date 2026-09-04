import assert from 'node:assert/strict';
import test from 'node:test';
import {TREND_METHOD, ETF_WEIGHTS, simulateEtfTrend, projectEtfTrend, validateTrendProjection, renderEtfTrend} from './xuan-ib-etf-trend.mjs';
const syms=Object.keys(ETF_WEIGHTS), clone=v=>structuredClone(v);
const day=(date,actualUsd=1200000,price=100,flows=[])=>({date,actualUsd,actualComplete:true,flowsComplete:true,sourceRef:'synthetic source',flows,
  quotes:Object.fromEntries(syms.map(s=>[s,{status:'close',date,usd:price,source:'synthetic USD close'}]))});
const input=(days=[day('2026-09-01')])=>({methodId:TREND_METHOD,startDate:'2026-09-01',frozenDate:'2026-09-04',initialUsd:1200000,reserveUsd:240000,days});
const run=days=>simulateEtfTrend(input(days));
const eq=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`);
const flow=(date,usd,id='fixture-flow')=>({id,date,usd,kind:'external'});
const closeMarket=d=>{for(const s of syms)d.quotes[s]={status:'closed'};return d;};
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
