import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from './xuan-weekly-build.mjs';
function fixture(){
  const date='2026-08-03', stamp='2026-08-04T01:00:00Z';
  const sharesight=[936247,936249,1350094].map(id=>({status:'ok',startedAt:stamp,completedAt:stamp,raw:{result:{mode:'read_only',
    portfolio:{id,currency_code:'USD'},data:{report:{portfolio_id:id,value:100,start_date:date,end_date:date,
      percentages_annualised:false,include_sales:false,currency:{code:'USD'},cash_accounts:[],holdings:[{
        id:id+10,portfolio:{id},instrument:{id:id+10,code:'TESTSTK',market_code:'TEST',name:'Synthetic',currency_code:'USD',
          friendly_instrument_description_code:'ordinary_shares'},instrument_currency:{code:'USD'},valid_position:true,
        quantity:1,value:100,instrument_price:100,labels:[],group_name:'Ordinary Shares',number_of_unconfirmed_transactions:0}]},
        links:{self:'https://example.invalid/performance?consolidated=false&include_sales=false&report_combined=false'}}}}}));
  const quotes={};for(const d of ['2026-07-31','2026-08-01','2026-08-02',date])quotes[d]=Object.fromEntries(['CSPX','EXUS','EIMI','USSC'].map(s=>[s,d===date||d==='2026-07-31'?{status:'close',date:d,usd:100,source:'synthetic'}:{status:'closed'}]));
  return {riskCutoff:date,sharesight,abc:{cutoff:date,quotes,nav:[{date:'2026-07-31',usd:100},{date,usd:100}],flows:[],
    coverage:{source:'ib-flex',currency:'USD',from:'2026-07-31',to:date,verified:true,sha256:'a'.repeat(64),closedDates:['2026-08-01','2026-08-02'],unresolvedDates:[]}}};
}
test('complete weekly artifact has no overview or old method wording',()=>{
  const r=build(fixture());assert.equal(r.receipt.complete,true);assert.equal(r.receipt.abcRows,4);
  assert.match(r.html,/不扣待 CALL/);assert.match(r.html,/ABC · 同资金路径/);assert.doesNotMatch(r.html,/<h2>持仓|<h2>总览/);
});
test('previous private identity records survive subsequent run',()=>{
  const f=fixture(),first=build(f);f.previousRecords=first.records;
  assert.equal(build(f).receipt.previousManifest.status,'present');
});
test('different source cutoff cannot masquerade as current risk',()=>{
  const f=fixture();f.riskCutoff='2026-08-04';assert.throws(()=>build(f),/cutoff/);
});
