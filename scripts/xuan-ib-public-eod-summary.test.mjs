// Synthetic offline data only; no captured financial/account fixtures.
import test from 'node:test';import assert from 'node:assert/strict';
import {buildPublicEodSummary,validatePublicEodSummary,renderPublicEodSummary} from './xuan-ib-public-eod-summary.mjs';
import {runEodDailyReport} from '../cloud/xuan-preopen/eod_daily.mjs';
import {publishPrepared,publishStoredEodSummary} from '../cloud/xuan-preopen/publish.mjs';
import {digest,SNAPSHOT_SCOPES} from '../cloud/xuan-preopen/eod_sources.mjs';
import {XUAN_ASSET_GROUP} from './xuan-ib-sharesight-allocation.mjs';
import {associationPolicyBlob} from './xuan-ib-account-association.mjs';
import {extractNightActionModel,renderNightActionReport} from './xuan-ib-night-action-view.mjs';
import {validateNightActionHtml} from './xuan-ib-night-action-guard.mjs';
import {classifySleepPublication,canReplaceActionModel} from './xuan-ib-sleep-priority.mjs';
import {selectNewestCandidate} from './xuan-ib-promotion.mjs';
globalThis.fetch=()=>assert.fail('Offline only');
const start=Date.parse('2026-10-09T05:00:00Z'),later=()=>start+2*3600000;
const symbols=['AAA','BBB','CCC','DDD','EEE'];
async function fixture({holdingsKnown=true,saveDuration=0}={}){
 const policy={schemaVersion:1,policyId:'ib-primary-7day-pilot-v1',accountAlias:'IB-HK',basis:'owner-attested-recurring-v1',status:'active',purpose:'xuan-ib-read-only-report',editions:['adhoc','am','pm'],publisher:'codex-verified-candidate-v1',validFrom:'2026-09-11T13:30:00.000Z',expiresAt:'2026-10-10T13:30:00.000Z'};
 const context={association:{policy,policyCommit:'a'.repeat(40),policyBlob:associationPolicyBlob(policy),checkedAt:new Date(later()).toISOString()},previousSourceSha:'c'.repeat(40),reserveHash:'b'.repeat(64),previousHtml:'',reserveLedger:{schemaVersion:1,purpose:'xuan-etf-owner-declared-pending-calls',entries:[{date:'2026-10-01',usd:654321.09}]}};
 const captured=structuredClone(context);captured.association.checkedAt=new Date(start).toISOString();
 const xml='<FlexQueryResponse><FlexStatements><FlexStatement accountId="SYNTHETIC_ACCOUNT" fromDate="20261008" toDate="20261008" whenGenerated="20261009;001530"><CashReport><CashReportCurrency accountId="SYNTHETIC_ACCOUNT" levelOfDetail="BaseCurrency" currency="BASE_SUMMARY" endingCash="9876543.21" endingSettledCash="9876543.21"/></CashReport><CashTransactions/><ConversionRates/></FlexStatement></FlexStatements></FlexQueryResponse>';
 const holdings=symbols.map((code,i)=>({id:i+1,group_name:['美国底仓','美国底仓','美国科技','非美发达','新兴市场'][i],value:[450000,50000,250000,180000,70000][i],quantity:123456.789,instrument:{code}}));
 const batch=[{sourceKey:'sharesight.ibGroupedPerformance',raw:{mode:'read_only',source:'Sharesight User API',data:{report:{portfolio_id:SNAPSHOT_SCOPES['sharesight.ibGroupedPerformance'].portfolioId,currency:{code:'USD'},start_date:'2026-10-08',end_date:'2026-10-08',include_sales:false,grouping:'custom_group_category',custom_group:XUAN_ASSET_GROUP,holdings,cash_accounts:[]}}}},
  {sourceKey:'sharesight.noahPerformance',raw:{mode:'read_only',source:'Sharesight User API',data:{report:{portfolio_id:SNAPSHOT_SCOPES['sharesight.noahPerformance'].portfolioId,currency:{code:'USD'},start_date:'2026-10-08',end_date:'2026-10-08',include_sales:false,grouping:'investment_type',cash_accounts:[{value:7654321.09}]}}}}];
 if(!holdingsKnown)batch[0].raw.data.report.grouping='unsupported';
 let elapsed=0;const objects=new Map(),io={loadFlexToken:async()=>'SYNTHETIC_TOKEN',loadGatewayToken:async()=>'SYNTHETIC_GATEWAY',savePrivate:async(n,v)=>{objects.set(n,v);elapsed+=saveDuration;return {sha256:digest(v),generation:'1'};}};
 const receipt=await runEodDailyReport({sourceDate:'2026-10-08',io,now:()=>start+elapsed,configuration:{configuredQueryId:'12345',baseCurrency:'USD',providerTimezone:null},expectedAccount:'SYNTHETIC_ACCOUNT',loadContext:async()=>structuredClone(captured),fetchArchive:async()=>({bytes:xml,requestedQueryId:'12345'}),readSharesight:async()=>batch});
 const html=objects.get(receipt.artifact.privateObject),model=extractNightActionModel(html),calls=[];
 const request=async p=>{calls.push(p);if(p.query.startsWith('query'))return {data:{viewer:{login:'huanwujoy-crypto'},repository:{id:'synthetic',ref:{target:{oid:'a'.repeat(40)}}}}};if(p.query.includes('CreateRef'))return {data:{createRef:{ref:{name:p.variables.input.name,target:{oid:'a'.repeat(40)}}}}};return {data:{createCommitOnBranch:{commit:{oid:'d'.repeat(40)},ref:{name:p.variables.input.branch.branchName}}}};};
 const receiptText=JSON.stringify(receipt);
 return {model,html,receipt,receiptText,savedReceiptSha256:digest(receiptText),calls,request,now:later,context,loadContext:async()=>structuredClone(context)};
}
test('public projection excludes every absolute value, quantity, symbol, account and original embedded model',async()=>{
 const f=await fixture(),m=buildPublicEodSummary(f.model,f.receipt),html=renderPublicEodSummary(m);
 assert.equal(m.schemaVersion,10);assert.equal(m.concentration.top1Pct,45);assert.equal(m.concentration.top5Pct,100);
 assert.equal(m.captureStartedAt,f.receipt.startedAt);assert.equal(m.captureCompletedAt,f.receipt.completedAt);
 for(const canary of ['9876543','9,876,543','7654321','7,654,321','654321','654,321','123456','123,456','SYNTHETIC_ACCOUNT','SYNTHETIC_TOKEN','report-check/',...symbols]){assert.equal(html.includes(canary),false);assert.equal(JSON.stringify(extractNightActionModel(html)).includes(canary),false);}
 assert.equal(JSON.stringify(extractNightActionModel(html)),JSON.stringify(m));assert.equal(validateNightActionHtml(html,m.dataDate).orderCount,null);
 assert.equal((html.match(/<section class="card">/g)||[]).length,4);assert.equal(/<script|\bdata-|\$/.test(html),false);
 assert(html.includes('原成品 13:00 HKT 生成'));assert(html.includes('不是新的实时取数'));assert(Object.values(m.unknowns).every(v=>v===null));
});
test('unknown/extra/nested fields, noncanonical percentages and invented known budgets fail closed',async()=>{
 const f=await fixture(),m=buildPublicEodSummary(f.model,f.receipt);
 for(const edit of [v=>v.amount=654321.09,v=>v.account='PRIVATE_ACCOUNT',v=>v.risks.text='PRIVATE_HOLDING',v=>v.concentration.symbol='AAA',v=>v.unknowns.orders=0,v=>v.concentration.top1Pct=45.123,v=>v.concentration.top5Pct=101,v=>v.captureCompletedAt='2026-10-10T05:00:00.000Z']){const x=structuredClone(m);edit(x);assert.throws(()=>validatePublicEodSummary(x));}
 assert.throws(()=>validatePublicEodSummary(Object.assign(Object.create({amount:42}),m)));
 assert.throws(()=>validateNightActionHtml(renderPublicEodSummary(m).replace('</main>','<div data-private="9876543"></div></main>'),m.dataDate));
});
test('ordinary EOD freshness stays 30 minutes and cannot be overridden by caller options',async()=>{
 const f=await fixture();await assert.rejects(publishPrepared({...f,storedSummary:true}),/STALE/);assert.equal(f.calls.length,0);
 const g=await fixture();g.now=()=>start+10*60000;g.context.association.checkedAt=new Date(g.now()).toISOString();await publishPrepared(g);
 const published=Buffer.from(g.calls[2].variables.input.fileChanges.additions[0].contents,'base64').toString();assert.equal(extractNightActionModel(published).schemaVersion,10);assert.equal(published.includes('9876543'),false);
});
test('explicit saved-EOD publication keeps original times and signs only anonymous bytes on the same report day',async()=>{
 const f=await fixture(),r=await publishStoredEodSummary(f);assert.equal(r.publication,'candidate-only');assert.equal(f.calls.length,3);
 const additions=f.calls[2].variables.input.fileChanges.additions;assert.deepEqual(additions.map(x=>x.path),['xuan-ib/index.html']);
 const html=Buffer.from(additions[0].contents,'base64').toString(),m=extractNightActionModel(html);assert.equal(m.captureCompletedAt,f.receipt.completedAt);assert.equal(m.sourceDate,'2026-10-08');assert.equal(m.risks.liveSource,'not-called');assert.equal(html.includes('9876543'),false);
});
test('stored contract rejects other modes, tampering, next day, changed reserve/policy/base and live dependencies before mutations',async()=>{
 for(const edit of [f=>f.receipt.mode='private_report_check',f=>f.html+='tamper',f=>f.now=()=>Date.parse('2026-10-10T05:00:00Z'),f=>f.context.reserveLedger.entries[0].usd++,f=>f.context.previousSourceSha='e'.repeat(40),f=>f.context.association.policy.expiresAt='2026-10-09T05:30:00.000Z',f=>f.context.association.checkedAt='2026-10-09T05:00:00.000Z']){const f=await fixture();edit(f);await assert.rejects(publishStoredEodSummary(f));assert.equal(f.calls.length,0);}
 const f=await fixture(),m=structuredClone(f.model);m.orders.buys=[];assert.throws(()=>buildPublicEodSummary(m,f.receipt));
});
test('classifier and promotion bind canonical anonymous contract without claiming financial completeness',async()=>{
 const f=await fixture(),m=buildPublicEodSummary(f.model,f.receipt),html=renderPublicEodSummary(m),p=classifySleepPublication(html);
 assert.equal(p.kind,'eod-public-summary');assert.equal(p.action.schemaVersion,10);assert.equal(p.action.components,0);assert.equal(p.action.orderReadAtEpoch,null);
 assert.equal(canReplaceActionModel(m,f.model),false);
 const old={kind:'other',dataDate:'2026-10-07',priorityKey:null,eligibleAtEpoch:null};
 const meta={schemaVersion:1,sourceSha:'c'.repeat(40),htmlBlob:'b'.repeat(40),dataDate:'2026-10-07',sourceCommitEpoch:1};
 const candidate={ref:'origin/codex/xuan-ib-synthetic-summary',sha:'d'.repeat(40),htmlBlob:p.action.htmlBlob,dataDate:m.dataDate,commitEpoch:3,publication:p};
 assert.equal(selectNewestCandidate([candidate],meta,old)?.sha,candidate.sha);
 const wrong=structuredClone(candidate);wrong.publication.action.components=1;assert.throws(()=>selectNewestCandidate([wrong],meta,old));
 const sameDayMeta={...meta,dataDate:m.dataDate};
 const complete={kind:'complete-pm',dataDate:m.dataDate,priorityKey:null,eligibleAtEpoch:null};
 assert.equal(selectNewestCandidate([candidate],sameDayMeta,complete),null);
 for(const kind of ['intraday-update','limited-readback']){
  const state={...complete,kind};
  assert.equal(selectNewestCandidate([candidate],sameDayMeta,state),null);
 }
 for(const schemaVersion of [7,8,10])assert.equal(canReplaceActionModel(m,{...m,schemaVersion}),false);
 const changed=structuredClone(m);changed.risks.reconciliation='verified';const changedHtml=renderPublicEodSummary(changed),changedState=classifySleepPublication(changedHtml);
 const competing={...candidate,htmlBlob:changedState.action.htmlBlob,commitEpoch:4,publication:changedState};
 assert.equal(selectNewestCandidate([candidate,competing],meta,old),null);
 assert.equal(selectNewestCandidate([competing],{...sameDayMeta,htmlBlob:p.action.htmlBlob},p),null);
 const full={...candidate,sha:'e'.repeat(40),htmlBlob:'f'.repeat(40),commitEpoch:2,publication:complete};
 assert.equal(selectNewestCandidate([candidate,full],meta,old)?.sha,full.sha);
 for(const kind of ['intraday-update','limited-readback','priority']){
  const live={...full,publication:{...complete,kind,...(kind==='priority'?{priorityKey:'pm:'+m.dataDate,eligibleAtEpoch:1}:{})}};
  assert.equal(selectNewestCandidate([candidate,live],meta,old)?.sha,live.sha);
 }
});
test('missing concentration remains unknown and cannot manufacture zero or an observed status',async()=>{
 const f=await fixture({holdingsKnown:false}),m=buildPublicEodSummary(f.model,f.receipt);
 assert.deepEqual(m.concentration,{status:'unknown',top1Pct:null,top5Pct:null});
 const html=renderPublicEodSummary(m);assert(html.includes('集中度比例未知'));assert.equal(html.includes('0.0%'),false);
 const bad=structuredClone(m);bad.concentration.top1Pct=0;assert.throws(()=>validatePublicEodSummary(bad));
});
test('capture contract rejects extended duration, cross-day dates and future timestamps without changing receipt times',async()=>{
 const f=await fixture(),m=buildPublicEodSummary(f.model,f.receipt);
 for(const edit of [x=>x.captureCompletedAt='2026-10-09T05:05:00.001Z',x=>x.captureStartedAt='2026-10-08T15:59:59.999Z',x=>x.sourceDate=x.dataDate]){const bad=structuredClone(m);edit(bad);assert.throws(()=>validatePublicEodSummary(bad));}
 assert.throws(()=>validateNightActionHtml(renderPublicEodSummary(m),m.dataDate,{now:start-1}),/FUTURE/);
 assert.throws(()=>validateNightActionHtml(renderPublicEodSummary(m),m.dataDate,{now:Date.parse('2026-10-09T16:00:00Z'),publication:true}),/PUBLICATION_DAY/);
 assert.doesNotThrow(()=>classifySleepPublication(renderPublicEodSummary(m)));
 assert.throws(()=>validateNightActionHtml(f.html,m.dataDate,{now:later(),publication:true}),/PRIVATE_EOD_REQUIRES_PUBLIC_PROJECTION/);
 assert.deepEqual(buildPublicEodSummary(f.model,f.receipt),m);
});
test('final association/reserve/base refresh blocks report commit after an empty branch only',async()=>{
 for(const edit of [c=>c.association.policyCommit='e'.repeat(40),c=>c.reserveLedger.entries[0].usd++,c=>c.previousSourceSha='e'.repeat(40),c=>c.association.policy.expiresAt='2026-10-09T05:30:00.000Z']){
  const f=await fixture();let reads=0;f.loadContext=async()=>{const c=structuredClone(f.context);if(++reads===2)edit(c);return c;};
  await assert.rejects(publishStoredEodSummary(f));assert.equal(f.calls.length,2);assert.equal(f.calls.some(p=>p.query.includes('CreateCommit')),false);
 }
});
test('pinned saved receipt and immutable source prefix prohibit resetting original capture times',async()=>{
 const f=await fixture();f.receipt.startedAt=new Date(start+3600000).toISOString();f.receipt.completedAt=f.receipt.startedAt;
 assert.throws(()=>buildPublicEodSummary(f.model,f.receipt),/CAPTURE_BINDING/);
 await assert.rejects(publishStoredEodSummary(f),/SAVED_RECEIPT_BINDING/);assert.equal(f.calls.length,0);
 const g=await fixture();g.receipt.completedAt=new Date(start+1000).toISOString();
 await assert.rejects(publishStoredEodSummary(g),/SAVED_RECEIPT_BINDING/);assert.equal(g.calls.length,0);
 for(const savedReceiptSha256 of [null,'0'.repeat(64)]){const h=await fixture();h.savedReceiptSha256=savedReceiptSha256;await assert.rejects(publishStoredEodSummary(h),/SAVED_RECEIPT_BINDING/);assert.equal(h.calls.length,0);}
});
test('legitimate sequential immutable uploads crossing a minute retain the exact original receipt completion',async()=>{
 const f=await fixture({saveDuration:15000}),m=buildPublicEodSummary(f.model,f.receipt);
 assert.notEqual(f.model.asOfHkt.match(/–(\d{2}:\d{2})/)[1],new Date(Date.parse(f.receipt.completedAt)+28800000).toISOString().slice(11,16));
 assert.equal(m.captureStartedAt,f.receipt.startedAt);assert.equal(m.captureCompletedAt,f.receipt.completedAt);
 await publishStoredEodSummary(f);assert.equal(f.calls.length,3);
});
