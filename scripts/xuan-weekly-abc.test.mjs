import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWeeklyAbc, METHOD} from './xuan-weekly-abc.mjs';
import {periodReturns} from './fee-engine.mjs';
const symbols=['CSPX','EXUS','EIMI','USSC'];
function fixture(){
  const quotes={};
  for(const d of ['2026-07-31','2026-08-01','2026-08-02','2026-08-03'])
    quotes[d]=Object.fromEntries(symbols.map(s=>[s,d==='2026-07-31'||d==='2026-08-03'
      ?{status:'close',date:d,usd:100,source:'synthetic USD close'}:{status:'closed'}]));
  return {cutoff:'2026-08-03',nav:[{date:'2026-07-31',usd:1000},{date:'2026-08-03',usd:1500}],
    flows:[{id:'1',date:'2026-08-03',usd:500,kind:'external'}],quotes,
    coverage:{source:'ib-flex',currency:'USD',from:'2026-07-31',to:'2026-08-03',verified:true,
      sha256:'a'.repeat(64),closedDates:['2026-08-01','2026-08-02'],unresolvedDates:[]}};
}
test('IB only, no reserve, August 1 scope with July 31 baseline',()=>{
  const r=buildWeeklyAbc(fixture());assert.equal(r.methodId,METHOD);assert.equal(r.includesNoah,false);
  assert.equal(r.result.stop,null);assert.deepEqual(r.result.rows.at(-1).index,{A:100,B:100,C:100});
  assert.deepEqual(r.result.rows.at(-1).endingUsd,{A:1500,B:1500,C:1500});
});
test('identical duplicate cash ID counted once; conflicts reject',()=>{
  const f=fixture(); f.flows.push({...f.flows[0]});assert.equal(buildWeeklyAbc(f).result.rows.at(-1).cumulativeFlowUsd,500);
  f.flows[1].usd=501;assert.throws(()=>buildWeeklyAbc(f),/Conflicting flow/);
});
test('NOAH to IB is external under IB-only scope',()=>{
  const f=fixture();f.flows[0].id='NOAH-to-IB';assert.equal(buildWeeklyAbc(f).result.rows.at(-1).index.A,100);
});
test('unknown transfer classification rejected',()=>{const f=fixture();f.flows[0].kind='unknown';assert.throws(()=>buildWeeklyAbc(f));});
test('missing NAV must not carry on a trading day',()=>{const f=fixture();f.nav.pop();assert.equal(buildWeeklyAbc(f).result.stop.date,'2026-08-03');});
test('baseline cannot use a later day',()=>{const f=fixture();f.nav.shift();assert.throws(()=>buildWeeklyAbc(f),/July 31/);});
test('unresolved cash evidence stops comparison',()=>{const f=fixture();f.coverage.unresolvedDates=['2026-08-03'];assert.equal(buildWeeklyAbc(f).result.stop.date,'2026-08-03');});
test('missing quote is not a holiday',()=>{const f=fixture();delete f.quotes['2026-08-03'];assert.throws(()=>buildWeeklyAbc(f),/evidence/);});
test('source window must cover cutoff',()=>{const f=fixture();f.coverage.to='2026-08-02';assert.throws(()=>buildWeeklyAbc(f),/coverage/);});
test('weekly A matches fee application gross daily TWR for identical NAV and flows',()=>{
 const f=fixture();f.cutoff='2026-08-04';f.coverage.to=f.cutoff;f.nav[1].usd=1600;f.nav.push({date:f.cutoff,usd:1680});
 f.quotes[f.cutoff]=Object.fromEntries(symbols.map(s=>[s,{status:'close',date:f.cutoff,usd:105,source:'synthetic'}]));
 const fee=periodReturns({points:[{d:'2026-08-01',tot:1000},{d:'2026-08-02',tot:1000},{d:'2026-08-03',tot:1600},{d:f.cutoff,tot:1680}],openT:1000,from:'2026-08-01',to:f.cutoff,days:4,flowByDate:{'2026-08-03':500},rate:.02,cr:.2,cumBefore:0,hwmBefore:0,feesBefore:0});
 const weekly=buildWeeklyAbc(f).result.rows.at(-1).index.A/100-1;
 assert(Math.abs(weekly-fee.rG)<1e-12);assert(Math.abs(weekly-.155)<1e-12);
});
