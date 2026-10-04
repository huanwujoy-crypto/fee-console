import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWeeklyConcentration,renderWeeklyConcentration} from './xuan-weekly-concentration.mjs';
import {buildAiExposure,renderAiExposure,DEFAULT_POLICY} from './xuan-weekly-ai-exposure.mjs';
import {resolveLeveragedProduct,LEVERAGED_POLICY} from './xuan-weekly-leveraged-products.mjs';
import {renderWeeklyAudit} from './xuan-weekly-audit.mjs';
const cutoff='2026-10-02';
const row=(portfolioId,holdingId,symbol,type,value,id=holdingId)=>({portfolioId,holdingId,instrumentId:id,symbol,assetType:type,identityVerified:true,valueDate:cutoff,custodian:'Synthetic',marketValueMicro:String(BigInt(value)*1000000n)});
const envelope=rows=>({riskDenominator:{components:[{key:'a',valueMicro:'800000000'},{key:'b',valueMicro:'100000000'},{key:'c',valueMicro:'100000000'}]},riskConstituents:rows});
test('two VSTL holdings merge 2x daily exposure into VST while actual NAV and AI allocation remain unchanged',()=>{
 const rows=[row('936247','29282953','VSTL','ETF',20),row('1350094','29274212','VSTL','ETF',10),row('936247','vst','VST','STK',40,'1753523')];
 const r=buildWeeklyConcentration(envelope(rows),{cutoff}),vst=r.rows.find(x=>x.issuer==='VST');
 assert.equal(r.denominatorCents,'100000');assert.equal(vst.directCents,'4000');assert.equal(vst.leveragedInvestmentCents,'3000');assert.equal(vst.leveragedCents,'6000');assert.equal(vst.equivalentExposureCents,'10000');assert.equal(vst.percent,10);assert.deepEqual(r.missingFunds,[]);
 const ai=buildAiExposure(envelope(rows),{cutoff});assert.equal(ai.groups.find(x=>x.key==='infrastructure').marketValueCents,'7000');assert.equal(ai.cash.marketValueCents,'93000');
 assert.match(renderWeeklyConcentration(r),/每日目标等效敞口/);assert.match(renderWeeklyConcentration(r),/不是多日收益的两倍/);
});
test('product ticker alone, changed source holding, asset type and expired review do not grant mapping',()=>{
 const r=row('936247','29282953','VSTL','ETF',20);
 for(const bad of [{...r,portfolioId:'other'},{...r,holdingId:'other'},{...r,symbol:'NEW2X'},{...r,assetType:'STK'},{...r,identityVerified:false}])assert.equal(resolveLeveragedProduct(bad,{cutoff}),null);
 assert.equal(resolveLeveragedProduct(r,{cutoff:'2027-01-05'}),null);
 const p=structuredClone(LEVERAGED_POLICY);p.products[0].dailyMultiplierBp=0;assert.throws(()=>resolveLeveragedProduct(r,{cutoff,policy:p}),/policy_invalid/);
 p.products[0].dailyMultiplierBp=20000;p.products.push({...p.products[0]});assert.throws(()=>resolveLeveragedProduct(r,{cutoff,policy:p}),/identity_invalid/);
});
test('exposure may exceed NAV; do not cap or renormalize equivalent exposure',()=>{
 const r=buildWeeklyConcentration(envelope([row('936247','29282953','VSTL','ETF',800)]),{cutoff});assert.equal(r.rows[0].percent,160);assert.equal(r.denominatorCents,'100000');assert.match(renderWeeklyConcentration(r),/可能超过 100%/);assert.match(renderWeeklyConcentration(r),/不截断、不重新归一化/);
});
test('exact scoped Cerebras, NVIDIA and Sivers classification cannot spread to other holdings or names',()=>{
 const rows=[row('1350094','29274215','CBRS','STK',100),row('1350094','28701364','NVDA','STK',10),row('other','29274215','CBRS','STK',10),row('1350094','28701364','FAKE','STK',10,'different'),row('936249','29288643','SIVEF','STK',10)];
 const a=buildAiExposure(envelope(rows),{cutoff});assert.equal(a.groups.find(x=>x.key==='infrastructure').marketValueCents,'12000');assert.equal(a.groups.find(x=>x.key==='pending').marketValueCents,'2000');
});
test('partial ETF snapshots disclose unrecorded and recorded unclassified weights without grossing up',()=>{
 const p=structuredClone(DEFAULT_POLICY);p.etfSnapshots=[{instrumentId:'fund',symbol:'FUND',fundName:'Synthetic',basis:'physical-holdings',asOf:cutoff,source:'https://issuer.example/',holdings:[{issuerKey:'nvidia',weightBp:1000},{issuerKey:'unknown',weightBp:2000}]}];
 const a=buildAiExposure(envelope([row('1','fund','FUND','ETF',100)]),{cutoff,policy:p}),r=a.rows[0];assert.equal(r.recordedBp,3000);assert.equal(r.coveredBp,1000);assert.equal(r.unclassifiedBp,2000);assert.equal(r.unrecordedBp,7000);assert.equal(r.uncoveredCents,'9000');
});
test('ABC renders last seven calendar days descending, retains each older day exactly once and leaves full results unchanged',()=>{
 const daily=Array.from({length:30},(_,i)=>({date:new Date(Date.UTC(2026,8,i+1)).toISOString().slice(0,10),flow:0,...Object.fromEntries(['A','B','C'].map(k=>[k,{beginning:100,ending:100,dailyReturn:0,cumulativeReturn:0}]))}));
 const a={cutoff:'2026-09-30',baselineDate:'2026-09-01',totals:{cashIn:0,cashOut:0,securitiesIn:0,securitiesOut:0,net:0},flows:[],summary:Object.fromEntries(['A','B','C'].map(k=>[k,{initial:100,ending:100,gain:0,twr:0}])),initialPurchases:[],simulation:[],daily};
 const before=JSON.stringify(a),html=renderWeeklyAudit(a);assert.equal(JSON.stringify(a),before);
 assert.ok(html.indexOf('2026-09-30 A')<html.indexOf('2026-09-29 A'));assert.ok(html.indexOf('2026-09-24 A')<html.indexOf('class="abc-history-week"'));assert.ok(html.indexOf('2026-09-23 A')>html.indexOf('class="abc-history-week"'));
 for(const d of daily)for(const arm of ['A','B','C'])assert.equal(html.split(d.date+' '+arm).length-1,1);
 assert.doesNotMatch(html,/<details class="abc-history-week" open/);
});

test('business category is not fund look-through; IVAI disclosed ten and absent composition are stated separately',()=>{
 const a=buildAiExposure(envelope([row('1','ivai','IVAI','ETF',100,'2992325')]),{cutoff});
 assert.equal(a.rows[0].coveredBp,3152);assert.equal(a.rows[0].unclassifiedBp,0);assert.equal(a.rows[0].unrecordedBp,6848);assert.equal(a.coverageComplete,false);
 const html=renderAiExposure(a);assert.match(html,/基金名称、主题或行业类别不能代替/);assert.match(html,/本次快照未纳入/);assert.match(html,/剩余 68.48% 的同日完整成分及权重尚未在本流程取得并核对/);
 const p=structuredClone(DEFAULT_POLICY);p.etfSnapshots.find(s=>s.symbol==='IVAI').asOf='2026-09-01';
 assert.doesNotMatch(renderAiExposure(buildAiExposure(envelope([row('1','ivai','IVAI','ETF',100,'2992325')]),{cutoff,policy:p})),/IVAI 当前仅纳入 2026-08-31/);
});

test('new issuer business evidence resolves recorded weights without changing snapshot dates or creating direct identity mappings',()=>{
 const expected=[['SMH','1965968',6744,0,3256],['INDA','1975404',2967,404,6629],['USSC','792072',477,51,9472],['VCN','1028072',3820,0,6180]];
 for(const [symbol,id,covered,unclassified,unrecorded] of expected){
  const a=buildAiExposure(envelope([row('synthetic',id,symbol,'ETF',100,id)]),{cutoff});
  assert.equal(a.rows[0].coveredBp,covered,symbol);assert.equal(a.rows[0].unclassifiedBp,unclassified,symbol);assert.equal(a.rows[0].unrecordedBp,unrecorded,symbol);
 }
 const a=buildAiExposure(envelope([row('synthetic','not-reviewed','TXN','STK',100)]),{cutoff});assert.equal(a.groups.find(g=>g.key==='pending').marketValueCents,'10000');
});
