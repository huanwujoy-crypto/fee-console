import test from 'node:test';import assert from 'node:assert/strict';
import {buildAiExposure,DEFAULT_POLICY} from './xuan-weekly-ai-exposure.mjs';
import {buildAiDualExposure,renderAiDualExposure} from './xuan-weekly-ai-dual-exposure.mjs';
import {LEVERAGED_POLICY} from './xuan-weekly-leveraged-products.mjs';
const cutoff='2026-10-02';
const row=(p,h,s,t,value,id=h)=>({portfolioId:p,holdingId:h,instrumentId:id,symbol:s,assetType:t,custodian:p==='936247'?'Synthetic A':'Synthetic B',identityVerified:true,valueDate:cutoff,marketValueMicro:String(BigInt(value)*1000000n)});
const envelope=rows=>({riskConstituents:rows,riskDenominator:{components:[{key:'a',valueMicro:'800000000'},{key:'b',valueMicro:'100000000'},{key:'c',valueMicro:'100000000'}]}});
const leveraged=[row('936247','29282953','VSTL','ETF',20),row('1350094','29274212','VSTL','ETF',10)];
function pair(rows,options={}){const e=envelope(rows),actual=buildAiExposure(e,{cutoff,policy:options.policy||DEFAULT_POLICY});return {e,actual,dual:buildAiDualExposure(e,{cutoff,actualAllocation:actual,...options})};}
test('two VSTL holdings use reviewed 2x VST business category; actual remains unchanged and direct/ETF match count once',()=>{
 const policy=structuredClone(DEFAULT_POLICY);policy.etfSnapshots=[{instrumentId:'fund',symbol:'FUND',fundName:'Synthetic',basis:'physical-holdings',asOf:cutoff,source:'https://issuer.example/',holdings:[{instrumentId:'1753523',symbol:'VST',weightBp:5000}]}];
 const rows=[...leveraged,row('936247','vst','VST','STK',40,'1753523'),row('936247','fund','FUND','ETF',20)];
 const {actual,dual}=pair(rows,{policy});assert.equal(actual.groups.find(g=>g.key==='infrastructure').marketValueCents,'8000');assert.equal(dual.primaryEquivalent.groups.find(g=>g.key==='infrastructure').marketValueCents,'11000');
 assert.equal(dual.denominatorCents,'100000');assert.equal(dual.primaryEquivalent.extraExposureCents,'3000');assert.equal(dual.primaryEquivalent.grossEquivalentCents,'103000');
 assert.deepEqual(dual.actualAllocation.groups,actual.groups);assert.equal(dual.leveragedProducts.length,1);assert.equal(dual.leveragedProducts[0].investedCents,'3000');assert.equal(dual.leveragedProducts[0].equivalentCents,'6000');assert.equal(dual.leveragedProducts[0].underlying,'VST');
 const sum=dual.primaryEquivalent.groups.reduce((s,g)=>s+BigInt(g.marketValueCents),0n)+BigInt(actual.cash.marketValueCents)+BigInt(dual.primaryEquivalent.displayRoundingResidualCents);assert.equal(String(sum),dual.primaryEquivalent.grossEquivalentCents);
});
test('risk can exceed NAV while actual value, cash and NAV stay 1x; no cap or renormalization',()=>{
 const {actual,dual}=pair([row('936247','29282953','VSTL','ETF',800),row('936247','vst','VST','STK',100,'1753523')]);assert.equal(actual.groups.find(g=>g.key==='infrastructure').percent,90);assert.equal(dual.primaryEquivalent.groups.find(g=>g.key==='infrastructure').percent,170);assert.equal(actual.cash.marketValueCents,'10000');assert.equal(dual.denominatorCents,'100000');
});
test('only explicit reviewed scope can supply leverage; ticker alone/wrong type/identity/expiry cannot',()=>{
 for(const bad of [{...leveraged[0],portfolioId:'other'},{...leveraged[0],symbol:'NEW2X'},{...leveraged[0],assetType:'STK'}]){const {dual}=pair([bad]);assert.equal(dual.primaryEquivalent.extraExposureCents,'0');}
 const e=envelope([{...leveraged[0],identityVerified:false}]);assert.throws(()=>buildAiExposure(e,{cutoff}),/source_invalid/);
 const leveragePolicy=structuredClone(LEVERAGED_POLICY);leveragePolicy.reviewedOn='2026-09-01';leveragePolicy.reviewBy='2026-10-01';assert.equal(pair(leveraged,{leveragePolicy}).dual.primaryEquivalent.extraExposureCents,'0');
});
test('future approved multiplier is read from verified registry, not hard-coded 2x',()=>{
 const leveragePolicy=structuredClone(LEVERAGED_POLICY);leveragePolicy.products[0].dailyMultiplierBp=30000;const {actual,dual}=pair(leveraged,{leveragePolicy});assert.equal(actual.groups.find(g=>g.key==='infrastructure').marketValueCents,'3000');assert.equal(dual.primaryEquivalent.groups.find(g=>g.key==='infrastructure').marketValueCents,'9000');assert.equal(dual.leveragedProducts[0].equivalentCents,'9000');
 leveragePolicy.products[0].dailyMultiplierBp=0;assert.throws(()=>pair(leveraged,{leveragePolicy}),/policy_invalid/);
});
test('new risk history is versioned; old allocation, same week and changed classification hash never become comparable',()=>{
 const first=pair(leveraged);for(const previous of [first.actual,{...first.dual,cutoff:'2026-10-01'},{...first.dual,cutoff:'2026-09-25',policyHash:'different'}])assert.equal(pair(leveraged,{previous}).dual.comparisonDate,null);
 const previous=structuredClone(first.dual);previous.cutoff='2026-09-25';previous.primaryEquivalent.groups.find(g=>g.key==='infrastructure').percent=5;
 const next=pair(leveraged,{previous}).dual;assert.equal(next.comparisonDate,'2026-09-25');assert.equal(next.primaryEquivalent.groups.find(g=>g.key==='infrastructure').changePp,1);
});
test('actual row linkage/denominator/business mismatch and expired business classification fail closed',()=>{
 const {e,actual}=pair(leveraged);const bad=structuredClone(actual);bad.rows[0].symbol='OTHER';assert.throws(()=>buildAiDualExposure(e,{cutoff,actualAllocation:bad}),/row_identity_invalid/);
 const changed=structuredClone(e);changed.riskConstituents[0].marketValueMicro='21000000';assert.throws(()=>buildAiDualExposure(changed,{cutoff,actualAllocation:actual}),/row_identity_invalid/);
 bad.rows[0].symbol='VSTL';bad.denominatorCents='99999';assert.throws(()=>buildAiDualExposure(e,{cutoff,actualAllocation:bad}),/denominator_invalid/);
 const p=structuredClone(DEFAULT_POLICY);p.reviewedOn='2026-09-01';p.reviewBy='2026-10-01';const a=buildAiExposure(e,{cutoff,policy:p});const d=buildAiDualExposure(e,{cutoff,actualAllocation:a,policy:p});assert.equal(d.primaryEquivalent.extraExposureCents,'0');assert.equal(a.groups.find(g=>g.key==='etfUncovered').marketValueCents,'3000');
});
test('public paired display leads with equivalent exposure, keeps actual/unknown/history and hides private holding ids',()=>{
 const {actual,dual}=pair(leveraged);const html=renderAiDualExposure(actual,dual);assert.match(html,/AI 相关等效敞口/);assert.match(html,/实际配置对照/);assert.match(html,/VSTL → VST/);assert.match(html,/2\.0×/);assert.match(html,/不截断、不归一化/);assert.match(html,/旧报告保留实际配置口径/);assert.doesNotMatch(html,/29282953|29274212|936247|1350094/);
});
