import test from 'node:test';import assert from 'node:assert/strict';
import {buildAiExposure,DEFAULT_POLICY} from './xuan-weekly-ai-exposure.mjs';
import {buildAiReviewPriority,renderAiReviewPriority,REVIEW_POLICY,summarizeAiReviewPriority} from './xuan-weekly-ai-review-priority.mjs';
const cutoff='2026-10-02';
const row=(id,symbol,type,value,p='synthetic')=>({portfolioId:p,holdingId:id,instrumentId:id,symbol,assetType:type,custodian:'Synthetic',identityVerified:true,valueDate:cutoff,marketValueMicro:String(Math.round(value*1000000))});
const fund=(id,holdings,complete=true)=>({instrumentId:id,symbol:id.toUpperCase(),fundName:'Synthetic',basis:'physical-holdings',asOf:cutoff,source:'https://issuer.example/',sourceCompositionComplete:complete,holdings});
function build(rows,snapshots,nav=1000){const policy=structuredClone(DEFAULT_POLICY);policy.etfSnapshots=snapshots;
 // This synthetic fixture models the baseline unclassified BE part; the newly reviewed production policy has a separate regression test.
 policy.underlyingIssuers=policy.underlyingIssuers.filter(d=>!['unreviewed-isin-US0937121079','unreviewed-isin-INE018A01030','unreviewed-lt'].includes(d.key));const e={riskConstituents:rows,riskDenominator:{components:[{key:'a',valueMicro:String(nav*800000)},{key:'b',valueMicro:String(nav*100000)},{key:'c',valueMicro:String(nav*100000)}]}};const a=buildAiExposure(e,{cutoff,policy});return {e,a,policy,p:buildAiReviewPriority(e,{cutoff,actualAllocation:a,policy})};}
test('whole issuer across two direct accounts and funds determines priority; only unknown subparts count improvement',()=>{
 const h={issuerKey:'unreviewed-isin-US0937121079',weightBp:10000,sourceRows:[{name:'Bloom Energy'}]};
 // Use existing explicit business classification for BE direct via its registered id.
 const policy=structuredClone(DEFAULT_POLICY),be=policy.stocks.find(s=>s.symbols.includes('BE'));assert.ok(be);
 const r=build([row(be.id,'BE','STK',40,'a'),row(be.id,'BE','STK',40,'b'),row('fund1','FUND1','ETF',.1),row('fund2','FUND2','ETF',.1),row('unknown','X','STK',.1)],[fund('fund1',[h]),fund('fund2',[h])]);
 assert.equal(r.p.priorityCount,1);assert.equal(r.p.priorityMergedTotal.marketValueCents,'8020');assert.equal(r.p.priorityUnknown.marketValueCents,'20');assert.equal(r.p.smallUnreviewed.marketValueCents,'10');assert.equal(r.p.priorityRows[0].identity,'priority-link-needs-review');assert.equal(r.a.groups.find(g=>g.key==='etfUncovered').marketValueCents,'20');
});
test('NAV changes threshold with exact inclusive boundary; cent display never selects rounded amount',()=>{
 const r=build([row('u','U','STK',.25)],[]);assert.equal(r.p.thresholdCents,'25');assert.equal(r.p.priorityCount,1);assert.equal(build([row('u','U','STK',.249999)],[]).p.priorityCount,0);assert.equal(build([row('u','U','STK',.25)],[],2000).p.priorityCount,0);
});
test('partial/unavailable compositions stay large separate blocks; complete residual is a third category',()=>{
 const rows=[row('partial','PARTIAL','ETF',100),row('absent','ABSENT','ETF',40),row('complete','COMPLETE','ETF',10)];const snapshots=[fund('partial',[{issuerKey:'unknown',weightBp:1000}],false),fund('complete',[{issuerKey:'unknown2',weightBp:9900}],true)];const {p,a}=build(rows,snapshots);
 assert.equal(p.unobtainedComposition.marketValueCents,'13000');assert.equal(p.completeSourceBalance.marketValueCents,'10');assert.equal(p.recordedUnknown.marketValueCents,'1990');assert.equal(p.smallUnreviewed.marketValueCents,'0');assert.equal(a.groups.find(g=>g.key==='etfUncovered').marketValueCents,'15000');assert.equal(p.missingCompositionBlocks.length,2);
});
test('exact source keys and candidate identity links merge unknown cross-fund parts but never approve business classification',()=>{
 const {p,a}=build([row('one','ONE','ETF',.2),row('two','TWO','ETF',.2)],[fund('one',[{issuerKey:'unreviewed-isin-INE018A01030',weightBp:10000}]),fund('two',[{issuerKey:'unreviewed-lt',weightBp:10000}])]);assert.equal(p.priorityCount,1);assert.equal(p.priorityUnknown.marketValueCents,'40');assert.equal(p.priorityRows[0].identity,'priority-link-needs-review');assert.equal(a.groups.find(g=>g.key==='etfUncovered').marketValueCents,'40');
});
test('wrong scope/amount, expired snapshot and altered rule fail closed or stay unavailable',()=>{
 const {e,a,policy}=build([row('u','U','STK',1)],[]);e.riskConstituents[0].identityVerified=false;assert.throws(()=>buildAiReviewPriority(e,{cutoff,actualAllocation:a,policy}),/source_invalid/);e.riskConstituents[0].identityVerified=true;e.riskConstituents[0].marketValueMicro='2000000';assert.throws(()=>buildAiReviewPriority(e,{cutoff,actualAllocation:a,policy}),/source_invalid/);assert.throws(()=>buildAiReviewPriority(e,{cutoff,actualAllocation:a,policy,reviewPolicy:{...REVIEW_POLICY,navPartsPerMillion:500}}),/rule_invalid/);
 const f=fund('old',[{issuerKey:'unknown',weightBp:10000}]);f.asOf='2025-01-01';assert.equal(build([row('old','OLD','ETF',10)],[f]).p.unobtainedComposition.marketValueCents,'1000');
});
test('version/hash/snapshot dates persist; display separates total and unknown, discloses tail and large missing, no identifiers',()=>{
 const {p}=build([row('u','U','STK',1),row('v','V','STK',.1),row('absent','ABSENT','ETF',30)],[]);const html=renderAiReviewPriority(p);assert.match(html,/0\.025%/);assert.match(html,/合并总敞口/);assert.match(html,/其中待审未知份额/);assert.match(html,/小额未逐项核实/);assert.match(html,/不能称作小额尾部/);assert.match(html,/旧报告不倒算/);assert.equal(p.methodId,'weekly-ai-review-priority-v1');assert.equal(p.cutoff,cutoff);assert.match(p.policyHash,/^[0-9a-f]{64}$/);assert.doesNotMatch(html,/portfolioId|holdingId|instrumentId/);
 const first=p.policyHash;const changed=summarizeAiReviewPriority({cutoff,actualAllocation:{cutoff,denominatorCents:p.denominatorCents,policyHash:'new',methodId:'actual-v-new'},navMicro:'1000000000',identityGroups:[]});assert.notEqual(first,changed.policyHash);
});
test('expired underlying business review cannot disappear behind a still verified leveraged identity',()=>{
 const policy=structuredClone(DEFAULT_POLICY);policy.reviewedOn='2026-09-01';policy.reviewBy='2026-10-01';const e={riskConstituents:[row('29282953','VSTL','ETF',20,'936247')],riskDenominator:{components:[{key:'a',valueMicro:'800000000'},{key:'b',valueMicro:'100000000'},{key:'c',valueMicro:'100000000'}]}};const a=buildAiExposure(e,{cutoff,policy}),p=buildAiReviewPriority(e,{cutoff,actualAllocation:a,policy});assert.equal(p.priorityUnknown.marketValueCents,'2000');assert.equal(p.unobtainedComposition.marketValueCents,'0');assert.equal(a.groups.find(g=>g.key==='etfUncovered').marketValueCents,'2000');
});
test('stock id without matching constituent symbol supplies neither business classification nor a disappearing unknown amount',()=>{
 const {p,a}=build([row('one','ONE','ETF',10)],[fund('one',[{instrumentId:'1753523',symbol:'WRONG',weightBp:10000}])]);assert.equal(p.priorityUnknown.marketValueCents,'1000');assert.equal(a.groups.find(g=>g.key==='etfUncovered').marketValueCents,'1000');
});
