import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAiExposure,renderAiExposure,DEFAULT_POLICY} from './xuan-weekly-ai-exposure.mjs';
const cutoff='2026-09-25';
function row(id,symbol,usd,assetType='STK',portfolioId='1'){
 return {instrumentId:id,symbol,assetType,portfolioId,holdingId:id,custodian:'Synthetic',identityVerified:true,valueDate:cutoff,marketValueMicro:String(BigInt(usd)*1000000n)};
}
function fixture(rows){return {riskDenominator:{components:[{key:'IB-HK',valueMicro:'800000000'},{key:'Schwab-HK',valueMicro:'100000000'},{key:'Webull',valueMicro:'100000000'}]},riskConstituents:rows};}
const group=(r,k)=>r.groups.find(g=>g.key===k);
test('actual values, no subjective coefficients; dual share classes and accounts combined',()=>{
 const r=buildAiExposure(fixture([row('1879420','AVGO',100),row('670422','GOOG',100),row('24449','GOOGL',50),row('670422','GOOG',50,'STK','2')]),{cutoff});
 assert.equal(group(r,'infrastructure').percent,10);assert.equal(group(r,'platform').percent,20);
 assert.equal(r.contributors.find(x=>x.label==='GOOG / GOOGL').marketValueCents,'20000');
 assert.equal(r.cash.marketValueCents,'70000');assert.equal(r.coverageComplete,true);
});
test('unknown stocks, old explicit exceptions and mismatched identities never become 80% or zero-risk',()=>{
 const r=buildAiExposure(fixture([row('123','NEW',100),row('34421','MSTR',50),row('670422','FAKE',50)]),{cutoff});
 assert.equal(group(r,'pending').percent,20);assert.equal(group(r,'platform').percent,0);assert.equal(r.coverageComplete,false);
 assert.match(renderAiExposure(r),/未覆盖不等于零风险/);
});
test('ETF including old pseudo-stock entry is unpenetrated, not automatic AI',()=>{
 const r=buildAiExposure(fixture([row('1965968','SMH',200,'ETF'),row('1310832','CSPX',100,'ETF')]),{cutoff});
 assert.equal(group(r,'etfUncovered').percent,30);assert.equal(group(r,'infrastructure').percent,0);
});
test('ETF verified partial look-through allocates once and retains unknown remainder',()=>{
 const policy=structuredClone(DEFAULT_POLICY);
 policy.etfSnapshots=[{instrumentId:'10',asOf:'2026-09-24',source:'https://issuer.example/holdings',holdings:[{instrumentId:'670422',symbol:'GOOG',weightBp:1000},{instrumentId:'1879420',symbol:'AVGO',weightBp:2000},{instrumentId:'999',symbol:'UNKNOWN',weightBp:1000}]}];
 const r=buildAiExposure(fixture([row('10','FUND',500,'ETF'),row('670422','GOOG',100)]),{cutoff,policy});
 assert.equal(group(r,'platform').percent,15);assert.equal(group(r,'infrastructure').percent,10);assert.equal(group(r,'etfUncovered').percent,35);
 assert.equal(r.rows[0].uncoveredCents,'35000');assert.equal(r.contributors.find(x=>x.label==='GOOG / GOOGL').marketValueCents,'15000');
});
test('stale and future ETF snapshots are uncovered; overweight and duplicate constituents rejected',()=>{
 for(const asOf of ['2026-01-01','2026-09-26']){
  const policy=structuredClone(DEFAULT_POLICY);policy.etfSnapshots=[{instrumentId:'10',asOf,source:'https://issuer.example',holdings:[]}];
  assert.equal(group(buildAiExposure(fixture([row('10','FUND',100,'ETF')]),{cutoff,policy}),'etfUncovered').percent,10);
 }
 for(const holdings of [[{instrumentId:'670422',symbol:'GOOG',weightBp:10001}],[{instrumentId:'670422',symbol:'GOOG',weightBp:500},{instrumentId:'670422',symbol:'GOOG',weightBp:500}]]){
  const policy=structuredClone(DEFAULT_POLICY);policy.etfSnapshots=[{instrumentId:'10',asOf:cutoff,source:'https://issuer.example',holdings}];
  assert.throws(()=>buildAiExposure(fixture([row('10','FUND',100,'ETF')]),{cutoff,policy}),/weights_invalid/);
 }
});
test('only comparable previous week; method changes reset the comparison',()=>{
 const f=fixture([row('1879420','AVGO',100)]),first=buildAiExposure(f,{cutoff});
 assert.equal(group(buildAiExposure(f,{cutoff,previous:first}),'infrastructure').changePp,null);
 const previous={...first,cutoff:'2026-09-18'};previous.groups=first.groups.map(g=>({...g,percent:0}));
 assert.equal(group(buildAiExposure(f,{cutoff,previous}),'infrastructure').changePp,10);
 previous.policyHash='changed';assert.equal(group(buildAiExposure(f,{cutoff,previous}),'infrastructure').changePp,null);
});
test('expired classification becomes pending without hiding amount',()=>{
 const policy=structuredClone(DEFAULT_POLICY);policy.reviewedOn='2026-01-01';policy.reviewBy='2026-09-24';
 const r=buildAiExposure(fixture([row('1879420','AVGO',100)]),{cutoff,policy});
 assert.equal(r.reviewOverdue,true);assert.equal(group(r,'pending').percent,10);assert.match(renderAiExposure(r),/分类待复核/);
});
test('identity, same-date, denominator and duplicate guards remain',()=>{
 const r=row('1879420','AVGO',100);
 for(const rows of [[{...r,identityVerified:false}],[{...r,valueDate:'2026-09-24'}],[r,r],[row('1879420','AVGO',1001)]])assert.throws(()=>buildAiExposure(fixture(rows),{cutoff}));
 const f=fixture([r]);f.riskDenominator.components[1].key='IB-HK';assert.throws(()=>buildAiExposure(f,{cutoff}),/accounts_invalid/);
});
test('public renderer escapes unknown symbols and never exposes internal ids or old model',()=>{
 const r=buildAiExposure(fixture([row('999','<script>',50)]),{cutoff});const html=renderAiExposure(r);
 assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|instrumentId|portfolioId|policyHash|压力金额|中情景/);
});
