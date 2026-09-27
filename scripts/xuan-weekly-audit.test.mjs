import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWeeklyAbc} from './xuan-weekly-abc.mjs';
import {buildWeeklyAudit,renderWeeklyAudit} from './xuan-weekly-audit.mjs';
function fixture(){
  const dates=['2026-07-31','2026-08-01','2026-08-02','2026-08-03','2026-08-04'];
  return {cutoff:dates.at(-1),nav:[{date:dates[0],usd:1000},{date:dates[3],usd:1500},{date:dates[4],usd:1445}],
    flows:[{id:'SECRET-ID',date:dates[3],usd:400,kind:'external',description:'PRIVATE-ACCOUNT'},
      {id:'SECRET-TRANSFER',date:dates[4],usd:-130,kind:'external',sourceKind:'asset-transfer-daily-net'}],
    coverage:{source:'ib-flex',currency:'USD',from:dates[0],to:dates[4],verified:true,sha256:'a'.repeat(64),closedDates:dates.slice(1,3),unresolvedDates:[]},
    quotes:Object.fromEntries(dates.map((d,i)=>[d,Object.fromEntries(['CSPX','EXUS','EIMI','USSC'].map(s=>[s,i===1||i===2?{status:'closed'}:{status:'close',date:d,usd:i===0?100:i===3?110:115.5,source:'synthetic'}]))]))};
}
test('cash and in-kind transfer separated, daily factors reconcile to engine',()=>{
 const f=fixture(),abc=buildWeeklyAbc(f),a=buildWeeklyAudit(f,abc);
 assert.deepEqual(a.totals,{cashIn:400,cashOut:0,securitiesIn:0,securitiesOut:130,net:270});
 assert(Math.abs(a.summary.A.twr-.155)<1e-12);assert.equal(a.summary.A.gain,175);
 for(const arm of ['B','C']){
   assert(Math.abs(a.simulation.filter(x=>x.arm===arm).reduce((v,x)=>v+x.value,0)-1445)<1e-8);
   assert(Math.abs(a.summary[arm].twr-.155)<1e-12);
 }
 const html=renderWeeklyAudit(a);
 assert.match(html,/证券净转出/);assert.doesNotMatch(html,/SECRET|PRIVATE-ACCOUNT/);
 assert.equal(a.daily.at(-1).flow,-130);
});
test('same-day cash in and out retain gross amounts, duplicate IDs do not double count',()=>{
 const f=fixture();f.flows[0].usd=500;f.flows.push({id:'out',date:'2026-08-03',usd:-100,kind:'external'}, {...f.flows[0]});
 const a=buildWeeklyAudit(f,buildWeeklyAbc(f));assert.equal(a.totals.cashIn,500);assert.equal(a.totals.cashOut,100);assert.equal(a.totals.net,270);
});
test('out of interval records do not leak into summary',()=>{
 const f=fixture();f.flows.push({id:'future',date:'2026-08-05',usd:1000,kind:'external'},{id:'baseline',date:'2026-07-31',usd:1000,kind:'external'});
 const a=buildWeeklyAudit(f,buildWeeklyAbc(f));assert.equal(a.flows.length,2);
});
test('audit rejects altered engine results instead of printing unverified calculation',()=>{
 const f=fixture(),abc=buildWeeklyAbc(f);abc.result.rows.at(-1).endingUsd.B+=1;
 assert.throws(()=>buildWeeklyAudit(f,abc),/audit_/);
});
test('closed-day inflow remains cash until next tradable day',()=>{
 const f=fixture();f.flows[0].date='2026-08-01';f.nav[1].usd=1500;
 const a=buildWeeklyAudit(f,buildWeeklyAbc(f));assert.equal(a.daily[0].B.ending,1400);
 assert.equal(a.daily[0].B.dailyReturn,0);
});
test('B drifts without rebalancing; all ETF units and values independently match',()=>{
 const f=fixture();f.quotes['2026-08-03'].EXUS.usd=120;f.quotes['2026-08-04'].EIMI.usd=90;
 assert.doesNotThrow(()=>buildWeeklyAudit(f,buildWeeklyAbc(f)));
});
