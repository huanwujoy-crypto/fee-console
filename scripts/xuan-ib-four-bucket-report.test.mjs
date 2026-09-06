import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTrustedInputs, familyPortfolioIds } from './xuan-ib-four-bucket.mjs';
import { fingerprint } from './xuan-ib-run-manifest.mjs';
import { prepareFourBucketReport, renderFourBucketCard, renderFourBucketReportTransport,
  parseFourBucketReport, validateFourBucketReportHtml } from './xuan-ib-four-bucket-report.mjs';
import { renderClassificationDisclosure, validateClassificationDisclosure } from './xuan-ib-classification-disclosure.mjs';
import { fixture as viewFixture, context as viewContext } from './xuan-ib-report-view.test.mjs';
import { prepareReport } from './xuan-ib-report-prepare.mjs';
import { APPROVED_IB_ACCOUNT_ID } from './xuan-ib-run-manifest.mjs';

// Synthetic native cash-only accounts make the source binding easy to audit.
export function bucketReportFixture(date='2026-09-08') {
  const trusted=loadTrustedInputs(), ids=familyPortfolioIds(trusted.registry);
  const start=`${date}T01:00:00Z`,end=`${date}T01:00:10Z`,now=Date.parse(`${date}T01:01:00Z`);
  const reads=ids.map((portfolioId,i)=>({portfolioId,readStartedAt:start,readCompletedAt:end,
    raw:{result:{mode:'read_only',portfolio:{id:portfolioId,currency_code:'USD'},data:{
      report:{portfolio_id:portfolioId,end_date:date,currency:{code:'USD'},holdings:[],cash_accounts:[{id:i+1,name:'Synthetic cash',value:100,currency:{code:'USD'}}],value:100,include_sales:false},
      links:{self:`https://example.invalid/report?consolidated=false&include_sales=false&include_limited=false&report_combined=false`}}}},
    listing:{readStartedAt:start,readCompletedAt:end,raw:{result:{mode:'read_only',portfolio:{id:portfolioId},data:{holdings:[]}}}}}));
  const evidence={dataDate:date,sources:{sharesight:reads.map(r=>({portfolioId:r.portfolioId,status:'ok',asOf:end,readStartedAt:start,fingerprint:fingerprint(r.raw)}))}};
  return {input:{schemaVersion:1,reads,pendingRedemption:null},context:{trusted,evidence,now,previousHtml:'',
    journal:{stages:[{name:'sharesight-read',status:'ok',startedAt:start,endedAt:end}]}}};
}
const page=result=>`<body>${renderFourBucketCard(result)}${renderClassificationDisclosure(result)}${renderFourBucketReportTransport(result)}</body>`;
const fresh=()=>{const f=bucketReportFixture();return prepareFourBucketReport(f.input,f.context);};

test('source-bound direct computation renders compact numbers with separate canonical notes',()=>{
  const result=fresh(),html=page(result);
  assert.equal(result.status,'fresh');assert.equal(result.snapshot.totals.totalUsdMicro,'700000000');
  assert.match(html,/常青基金/);assert.match(html,/100.00%/);assert.match(html,/不是所有基金的净值日期/);
  assert.deepEqual(parseFourBucketReport(html),result);
  assert.deepEqual(validateFourBucketReportHtml(html),[]);
  assert.deepEqual(validateClassificationDisclosure(html),[]);
  assert.doesNotMatch(html,/Synthetic cash|api_transaction|example.invalid/);
});

test('receipt drift, future/old dates and listing outside real stage abort before rendering',()=>{
  for(const mutate of [
    f=>f.input.reads[0].raw.result.data.report.cash_accounts[0].value++,
    f=>f.input.reads[0].readCompletedAt='2026-09-08T01:00:09Z',
    f=>f.input.reads[0].listing.readCompletedAt='2026-09-08T01:00:11Z',
    f=>f.input.reads[0].listing.readStartedAt='2026-09-07T01:00:00Z',
    f=>f.input.reads.pop(),
    f=>f.input.reads.push(f.input.reads[0]),
    f=>f.context.journal.stages[0].status='failed',
    f=>f.context.now=Date.parse('2026-09-08T00:00:00Z'),
  ]) {const f=bucketReportFixture();mutate(f);assert.throws(()=>prepareFourBucketReport(f.input,f.context));}
});

test('listing failure falls back to exact prior data/date; no prior means unavailable, never zero',()=>{
  const before=fresh(),f=bucketReportFixture('2026-09-09');
  f.input.reads[0].listing.raw.result.portfolio.id=1;
  f.context.previousHtml=page(before);
  const fallback=prepareFourBucketReport(f.input,f.context);
  assert.equal(fallback.status,'fallback');assert.deepEqual(fallback.snapshot,before.snapshot);
  assert.deepEqual(validateFourBucketReportHtml(page(fallback),{previousHtml:page(before)}),[]);
  assert.match(page(fallback),/沿用上次/);assert.match(page(fallback),/2026-09-08/);
  f.context.previousHtml='';
  const unavailable=prepareFourBucketReport(f.input,f.context);
  assert.equal(unavailable.status,'unavailable');assert.equal(unavailable.snapshot,null);
  assert.doesNotMatch(renderFourBucketCard(unavailable),/\$0/);
});

test('canonical guard rejects changed numbers, hidden/duplicated card, stale fresh or fabricated fallback',()=>{
  const result=fresh(),html=page(result);
  for(const bad of [html.replace('$700','$701'),html.replace('<section id="xuan-ib-four-bucket-card-v1"','<section hidden id="xuan-ib-four-bucket-card-v1"'),
    html+renderFourBucketCard(result),html.replace('本次重算','已完成'),html.replace('常青基金展示毛值','常青基金展示净值')]) {
    assert.ok(validateClassificationDisclosure(bad).length);
  }
  assert.ok(validateFourBucketReportHtml(html,{previousHtml:html}).length);
  assert.deepEqual(validateFourBucketReportHtml(html,{previousHtml:html,recordsUpdate:true}),[]);
  assert.ok(validateFourBucketReportHtml(page({...result,status:'fallback',reason:'TEST_FAILURE'})).length);
  assert.ok(validateFourBucketReportHtml('<body>removed</body>',{previousHtml:html}).length);
  assert.ok(validateFourBucketReportHtml(page({status:'unavailable',reason:'TEST_FAILURE',snapshot:null}),{previousHtml:html}).length);
});

test('legacy canonical disclosure remains valid but cannot claim current figures without transport',()=>{
  assert.deepEqual(validateClassificationDisclosure(renderClassificationDisclosure()),[]);
  assert.ok(validateClassificationDisclosure(renderFourBucketCard(fresh())+renderClassificationDisclosure()).length);
  assert.ok(validateClassificationDisclosure(page(fresh()).replace('股份','股份')+'<p>四桶已实时重算</p>').length);
});

test('real prepare/render/guard path carries computed buckets without changing receipt or cash transport',()=>{
  const view=viewFixture(),f=bucketReportFixture(view.dataDate),registry=f.context.trusted.registry;
  const source={status:'ok',asOf:f.input.reads[0].readCompletedAt,retries:0,fingerprint:fingerprint('synthetic')};
  const evidence={schemaVersion:1,edition:'adhoc',dataDate:view.dataDate,previousSourceSha:viewContext.previousMeta.sourceSha,
    sources:{ib:{accountId:APPROVED_IB_ACCOUNT_ID,accountScopeConfirmed:true,...Object.fromEntries(['accountSummary','balances','positions','orders','trades'].map(k=>[k,source]))},
      sharesight:registry.portfolios.filter(p=>p.requiredEachReport).map(p=>({portfolioId:p.portfolioId,role:p.role,...source,
        ...(f.context.evidence.sources.sharesight.find(s=>s.portfolioId===p.portfolioId)??{}),...(p.portfolioId===936247?{completedUsTradingDayLag:0}:{})}))}};
  evidence.sources.sharesight.forEach(s=>delete s.readStartedAt); // Native-account evidence schema has no start field.
  const result=prepareReport(view,evidence,{...viewContext,registry,fourBucketInput:f.input,now:f.context.now});
  assert.equal(result.result.status,'prepared-not-published');assert.equal(result.result.fourBucket.status,'fresh');
  assert.match(result.html,/四桶 · 本次重算/);
  const state=html=>html.match(/<template id="xuan-ib-decision-state-v1"[\s\S]*?<\/template>/)[0];
  assert.equal(state(result.html),state(viewContext.previousHtml));
  assert.deepEqual(view.cashPlan,{schemaVersion:2,status:'unavailable'});
});
