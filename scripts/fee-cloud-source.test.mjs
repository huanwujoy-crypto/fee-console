import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { HEALTH_SCHEMA, validateHealth } from "./fee-data-health.mjs";
import test from "node:test";
import { isControlledWebullNetProceeds, expectedTargetDate, previousCalendarDate, latestCommonBenchmarkDate, normalizeRead as normalizeCloudRead, parseTradeJson, selectBenchmark, SharesightCloudReader } from "./fee-cloud-source.mjs";
import { assertCandidateReceiptable, fetchEconomicWithRetry, readStableWithRetry, verifyWriterOutcome, weekendGapDates, writerFailureCode, producerFailureCode, produce, isPublishedTarget, isEarlierCandidate, readPublicationState, publishedPreflight } from "./fee-cloud-producer.mjs";
import { boundedJson, BoundedJsonError } from './fee-http-json.mjs';
import { SourceFetchError } from "./fee-economic-source.mjs";
import { checkCashLedger } from './daily-core.mjs';

const D = "2026-09-23";
// Synthetic direct inputs follow the same raw-JSON path as the cloud transport.
const wireInput = input => Object.fromEntries(Object.entries(input).map(([account, p]) => {
  const copy = { ...p };
  for (const key of ['trades', 'holdingHistory', 'managementTrades', 'performance', 'terminalPerformance', 'cashAccounts', 'previousCashAccounts']) {
    if (p[key]) copy[key] = parseTradeJson(JSON.stringify(p[key]));
  }
  return [account, copy];
}));
const normalizeRead = (input, ...args) => normalizeCloudRead(wireInput(input), ...args);

test("writer diagnostics expose fixed categories and stage without private child stderr", () => {
  assert.equal(writerFailureCode("error: STYLE_EVIDENCE_REQUIRED — nothing written\n", true),
    "FEE_CLOUD_WRITER_PREFLIGHT_STYLE_EVIDENCE_REQUIRED");
  assert.equal(writerFailureCode("error: duplicate/stale cash in webull on 2026-10-01: balance 123456.78 ignores private movement"),
    "FEE_CLOUD_WRITER_CASH_RECONCILIATION");
  assert.equal(writerFailureCode("error: fee calculation receipt failed: private amount 98765"),
    "FEE_CLOUD_WRITER_FEE_RECEIPT");
  for (const stderr of ["private account U123456 secret=abc 123456.78", "error: STYLE_secret=abc", "", null]) {
    assert.equal(writerFailureCode(stderr), "FEE_CLOUD_WRITER_UNKNOWN");
  }
});
const benchmarkCache = { v: 1, benchmarks: {
  spy: { series: [{ d: "2026-09-22", p: 700 }, { d: D, p: 701, div: 1.5 }] },
  qqq: { series: [{ d: "2026-09-22", p: 600 }, { d: D, p: 602 }] },
} };

const gateNow = () => new Date(`${D}T22:00:00Z`);
function publicationFixture() {
  const data = Buffer.from(JSON.stringify({enc:true,v:3,data:Buffer.alloc(64).toString('base64')}));
  return {mainSha:'a'.repeat(40),finalMainSha:'a'.repeat(40),data,pending:false,health:{
    schema:HEALTH_SCHEMA,checkedAt:`${D}T21:00:00Z`,targetDate:D,
    sourceDates:{schwab:D,webull:D,benchmark:D},outcome:'updated',errorCode:null,
    dataSha256:createHash('sha256').update(data).digest('hex')
  }};
}

test('published preflight accepts only stable main with complete same-target health and ciphertext', async () => {
  const state=publicationFixture(), original=structuredClone(state.health);
  for(const outcome of ['updated','no-op']) {
    state.health.outcome=outcome;
    assert.equal(isPublishedTarget(state,D,gateNow()),true);
    const result=await publishedPreflight({cache:benchmarkCache,now:gateNow,readState:async()=>state});
    assert.equal(result.outcome,'already-published');assert.equal(result.targetDate,D);
  }
  state.health.outcome=original.outcome;assert.deepEqual(state.health,original);
  const mutations=[s=>s.health.targetDate='2026-09-22',s=>s.health.sourceDates.webull='2026-09-22',
    s=>s.health.sourceDates.benchmark=null,s=>s.health.checkedAt='2026-09-20T21:00:00Z',
    s=>s.health.checkedAt=`${D}T22:06:00Z`,s=>s.health.outcome='failed',s=>s.health.errorCode='RUN_FAILED',
    s=>s.health.extra='unexpected',s=>s.health.dataSha256='b'.repeat(64),s=>s.finalMainSha='b'.repeat(40),
    s=>s.data=Buffer.from('{}'),s=>s.mainSha='not-a-sha'];
  for(const mutate of mutations) {const s=publicationFixture();mutate(s);assert.equal(isPublishedTarget(s,D,gateNow()),false);}
  const future=structuredClone(benchmarkCache);
  for(const key of ['spy','qqq'])future.benchmarks[key].series.push({d:'2026-09-24',p:100});
  assert.equal((await publishedPreflight({cache:future,now:gateNow,readState:async()=>state})).outcome,'already-published');
  const badDividend=structuredClone(benchmarkCache);badDividend.benchmarks.spy.series.at(-1).div=-1;
  await assert.rejects(publishedPreflight({cache:badDividend,now:gateNow,readState:async()=>{assert.fail('bad cache must not read publication');}}),/BENCHMARK_PENDING/);
});

test('preflight waits only for publication, bounds pending candidates, and fails an unverifiable wait', async () => {
  let calls=0, waits=0;
  const result=await publishedPreflight({cache:benchmarkCache,now:gateNow,attempts:3,delayMs:0,
    sleep:async()=>{waits++;},readState:async()=>{
      calls++;const state=publicationFixture();if(calls<3){state.health.targetDate='2026-09-22';state.pending=true;}return state;
    }});
  assert.equal(result.outcome,'already-published');assert.equal(calls,3);assert.equal(waits,2);
  const pending=publicationFixture();pending.health.targetDate='2026-09-22';pending.pending=true;
  await assert.rejects(publishedPreflight({cache:benchmarkCache,now:gateNow,attempts:2,delayMs:0,
    sleep:async()=>{},readState:async()=>pending}),/PUBLICATION_WAIT_TIMEOUT/);
  calls=0;
  await assert.rejects(publishedPreflight({cache:benchmarkCache,now:gateNow,attempts:2,delayMs:0,
    sleep:async()=>{},readState:async()=>{if(calls++)throw new Error('private URL');return pending;}}),/PUBLICATION_WAIT_UNVERIFIED/);
  await assert.rejects(publishedPreflight({cache:benchmarkCache,now:gateNow,attempts:2,delayMs:0,sleep:async()=>{},readState:async()=>{throw new Error('private URL');}}),/PUBLICATION_UNVERIFIED/);
  await assert.rejects(publishedPreflight({cache:benchmarkCache,now:gateNow,readState:async()=>{throw new Error('FEE_CLOUD_PUBLICATION_CANDIDATE_FAILED');}}),/PUBLICATION_CANDIDATE_FAILED/);
  const moved=publicationFixture();moved.finalMainSha='b'.repeat(40);
  await assert.rejects(publishedPreflight({cache:benchmarkCache,now:gateNow,attempts:1,readState:async()=>moved}),/PUBLICATION_UNSTABLE/);
});

function earlierCandidateFixture() {
  return {sha:'b'.repeat(40),parents:[{sha:'a'.repeat(40)}],author:{login:'huanwujoy-crypto'},committer:{login:'web-flow'},
    commit:{message:`daily ${D}`,committer:{date:`${D}T21:00:00Z`},verification:{verified:true}},
    files:[{filename:'fee-data-health.json',status:'modified'}]};
}

test('candidate wait is pinned to an earlier signed same-target candidate, excluding later producer queue', () => {
  const branch='codex/fee-daily-20260923-abcdef', startedAt=`${D}T22:00:00Z`;
  assert.equal(isEarlierCandidate(earlierCandidateFixture(),branch,'a'.repeat(40),D,startedAt),true);
  const changes=[c=>c.commit.committer.date=`${D}T22:00:01Z`,c=>c.commit.committer.date='2026-09-20T22:00:00Z',
    c=>c.commit.verification.verified=false,c=>c.author.login='another-user',c=>c.parents.push({sha:'c'.repeat(40)}),
    c=>c.parents[0].sha='c'.repeat(40),c=>c.files.push({filename:'scripts/daily.mjs',status:'modified'}),
    c=>c.files[0].status='added',c=>c.commit.message='daily 2026-09-22'];
  for(const change of changes){const c=earlierCandidateFixture();change(c);assert.equal(isEarlierCandidate(c,branch,'a'.repeat(40),D,startedAt),false);}
  assert.equal(isEarlierCandidate(earlierCandidateFixture(),'codex/fee-daily-20260922-abcdef','a'.repeat(40),D,startedAt),false);
});

test('public reader pins both encrypted files to main and never trusts candidate validation as publication', async () => {
  const state=publicationFixture(),branch='codex/fee-daily-20260923-abcdef',routes=[];
  state.health.targetDate='2026-09-22';
  const request=async route=>{
    routes.push(route);
    if(route==='git/ref/heads/main')return {object:{sha:state.mainSha}};
    if(route.startsWith('contents/')){
      assert.match(route,new RegExp(`ref=${state.mainSha}$`));
      const bytes=route.includes('data.json?')?state.data:Buffer.from(JSON.stringify(state.health));
      return {type:'file',encoding:'base64',size:bytes.length,content:bytes.toString('base64')};
    }
    if(route.startsWith('git/matching-refs/'))return [{ref:`refs/heads/${branch}`,object:{sha:'b'.repeat(40)}}];
    if(route.startsWith('commits/'))return earlierCandidateFixture();
    if(route.startsWith('actions/'))return {workflow_runs:[{id:1,head_sha:'b'.repeat(40),head_branch:branch,event:'push',status:'completed',conclusion:'success'}]};
    assert.fail(route);
  };
  const result=await readPublicationState(D,`${D}T22:00:00Z`,request);
  assert.equal(result.pending,true);assert.equal(isPublishedTarget(result,D,gateNow()),false);
  assert.equal(routes.filter(r=>r==='git/ref/heads/main').length,3);
  assert.equal(routes.some(r=>r.includes('fee-cloud-producer.yml/runs')),false);
  assert.equal((await readPublicationState(D,`${D}T22:00:00Z`,async route=>{
    if(route.startsWith('actions/'))throw new Error('read-only Actions metadata unavailable');
    return request(route);
  })).pending,true);
  await assert.rejects(readPublicationState(D,`${D}T22:00:00Z`,async route=>{
    if(route.startsWith('actions/'))return {workflow_runs:[{id:1,head_sha:'b'.repeat(40),head_branch:branch,event:'push',status:'completed',conclusion:'failure'}]};
    return request(route);
  }),/PUBLICATION_CANDIDATE_FAILED/);
});

test('workflow gates all credential, source and candidate steps before authentication and preserves old health', () => {
  const workflow=fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml',import.meta.url),'utf8');
  const steps=workflow.split('\n      - name: ').slice(1);
  const preflight=steps.findIndex(s=>s.startsWith('Check whether this complete target'));
  const names=['Refresh the producer base','Exchange the trusted workflow identity','Read the isolated cloud Sharesight credentials',
    'Read, calculate and validate','Create a signed owner candidate','Explain shadow mode'];
  for(const name of names){const index=steps.findIndex(s=>s.startsWith(name));assert.ok(index>preflight);assert.match(steps[index],/if:.*steps\.published\.outputs\.outcome == 'produce'/);}
  assert.ok(steps.findIndex(s=>s.startsWith('Read the independent benchmark cache'))<preflight);
  assert.doesNotMatch(steps[preflight],/secrets\.|create-success|create-failure|fee-data-health\.json|FEE_DATA_KEY|SHARESIGHT/);
  assert.match(steps[preflight],/already-published/);assert.match(steps[preflight],/source check time is unchanged/);
  assert.match(workflow,/permissions:\n  contents: read\n  id-token: write/);
  assert.match(workflow,/group: fee-cloud-producer\n  cancel-in-progress: false/);
  assert.match(steps.at(-1),/if:.*always\(\)/);
});

test('real preflight CLI performs only public main GETs and never reads financial credentials or creates a candidate', async t => {
  const cases = [
    ['before New York close', '2026-10-08T20:14:59Z', '2026-10-07'],
    ['at New York close', '2026-10-08T20:15:00Z', '2026-10-08'],
    ['after New York close', '2026-10-08T22:40:00Z', '2026-10-08'],
    ['before UTC midnight', '2026-10-08T23:59:59Z', '2026-10-08'],
    ['after UTC midnight', '2026-10-09T00:00:00Z', '2026-10-08'],
    ['stale cache after close stays blocked', '2026-10-08T22:40:00Z', '2026-10-08', '2026-10-07'],
    ['future cache before close stays blocked', '2026-10-08T20:14:59Z', '2026-10-07', '2026-10-08'],
  ];
  for (const [name, now, date, cacheDate = date] of cases) await t.test(name, () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-published-cli-'));fs.chmodSync(dir,0o700);
  try {
    const state=publicationFixture();
    state.health.checkedAt=now;state.health.targetDate=date;
    state.health.sourceDates={schwab:date,webull:date,benchmark:date};
    const cache={v:1,benchmarks:{spy:{series:[{d:cacheDate,p:100}]},qqq:{series:[{d:cacheDate,p:100}]}}};
    const benchmarkFile=path.join(dir,'benchmark.json'),preload=path.join(dir,'public-only.mjs');
    fs.writeFileSync(benchmarkFile,JSON.stringify(cache));
    fs.writeFileSync(preload,`const NativeDate=globalThis.Date,fixedNow=NativeDate.parse(${JSON.stringify(now)});
globalThis.Date=class extends NativeDate {
 constructor(...args){super(...(args.length?args:[fixedNow]));}
 static now(){return fixedNow;}
};
const state=${JSON.stringify({mainSha:state.mainSha,health:state.health,data:state.data.toString('base64')})};
globalThis.fetch=async(url,init)=>{
 if(init.method||init.body||!url.startsWith('https://api.github.com/repos/huanwujoy-crypto/fee-console/'))throw new Error('non-public request');
 let value;
 if(url.endsWith('/git/ref/heads/main'))value={object:{sha:state.mainSha}};
 else if(url.endsWith('/contents/data.json?ref='+state.mainSha))value={type:'file',encoding:'base64',size:Buffer.from(state.data,'base64').length,content:state.data};
 else if(url.endsWith('/contents/fee-data-health.json?ref='+state.mainSha)){const b=Buffer.from(JSON.stringify(state.health));value={type:'file',encoding:'base64',size:b.length,content:b.toString('base64')};}
 else throw new Error('unexpected public route');
 const response=new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});Object.defineProperty(response,'url',{value:url});return response;
};`);
    const result=spawnSync(process.execPath,['--import',preload,new URL('./fee-cloud-producer.mjs',import.meta.url).pathname,
      '--mode=published-preflight',`--benchmark-file=${benchmarkFile}`],{encoding:'utf8',timeout:10_000,
      env:{...process.env,FEE_DATA_KEY:'unusable-synthetic',FEE_ECON_GIST_ID:'unusable-synthetic',
        FEE_CLOUD_SHARESIGHT_CLIENT_ID:'unusable-synthetic',FEE_CLOUD_SHARESIGHT_CLIENT_SECRET:'unusable-synthetic'}});
    if (cacheDate === date) {
      assert.equal(result.status,0,result.stderr);
      const decision=JSON.parse(result.stdout);
      assert.equal(decision.outcome,'already-published');assert.equal(decision.targetDate,date);
    } else {
      assert.equal(result.status,1);assert.equal(result.stderr.trim(),'FEE_CLOUD_BENCHMARK_PENDING');
      assert.equal(result.stdout,'');
    }
    assert.equal(fs.existsSync(path.join(dir,'data.json')),false);assert.equal(fs.existsSync(path.join(dir,'fee-data-health.json')),false);
    assert.deepEqual(fs.readdirSync(dir).sort(),['benchmark.json','public-only.mjs']);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
  });
});

const syntheticInstrument = (holdingId, ticker) => ({ id: 1000 + holdingId, code: ticker,
  market_code: 'NYSE', currency_code: 'USD' });
const portfolio = (account, id, cashId, holdings, transactions = []) => ({
  performance: { report: { portfolio_id: id, start_date: D, end_date: D,
    include_sales: false, portfolio_tz_name: 'America/New_York', currency: { code: "USD" }, value: 1000,
    cash_accounts: [{ id: cashId, value: 400, currency: { code: "USD" }, portfolio: { id, name: account } }],
    holdings: holdings.map(h => ({ id: h.id, quantity: h.id, value: h.value, valid_position: true,
      instrument: syntheticInstrument(h.id, h.ticker), instrument_currency: { code: "USD" }, portfolio: { id, name: account } })) } },
  holdings: { holdings: holdings.map(h => ({ id: h.id, valid_position: true,
    inception_date: '2026-09-22', instrument: syntheticInstrument(h.id, h.ticker),
    instrument_currency: { code: 'USD' }, portfolio: { id, name: account } })) },
  cashAccounts: { cash_accounts: [{ id: cashId, portfolio_id: id, currency: "USD", portfolio_currency: "USD", date: D,
    balance: 400, balance_in_portfolio_currency: 400 }] },
  previousPerformance: {report:{portfolio_id:id,end_date:'2026-09-22',currency:{code:'USD'},cash_accounts:[{id:cashId,value:400-transactions.reduce((n,t)=>n+t.amount,0),currency:{code:'USD'},portfolio:{id,name:account}}]}},
  cashTransactions: { [cashId]: { cash_account_transactions: transactions.map((t,i)=>({id:100+i,...t})) } },
  trades: { trades: transactions.filter(t => t.trade_id).map(t => ({ id: t.trade_id, portfolio_id: id, transaction_date: D, state: "confirmed" })) },
});

function raw() {
  return {
    schwab: portfolio("Schwab-HK", 936249, 142251, [
      { id: 1, ticker: "SGOV", value: 100 }, { id: 2, ticker: "BRK/B", value: 500 },
    ], [{ amount: 50, balance: 400, cash_account_id: 142251, date_time: `${D}T00:00:00.000Z`, description: "Sell trade",
      cash_account_transaction_type: { name: "Sell Trade" }, trade_id: 9, holding_id: 2, foreign_identifier: null }]),
    webull: portfolio("Webull", 1350094, 90250, [
      { id: 3, ticker: "SGOV", value: 50 }, { id: 4, ticker: "GOOG", value: 550 },
    ]),
  };
}

function closedCatalogFixture(account = 'webull', openingType = 'BUY') {
  const fixture = raw(), p = fixture[account], pid = account === 'webull' ? 1350094 : 936249;
  const instrument = syntheticInstrument(700, 'SYNTHC');
  p.holdings.holdings.push({ id: 700, inception_date: '2026-09-21', valid_position: true,
    instrument, instrument_currency: { code: 'USD' }, portfolio: { id: pid, name: account === 'webull' ? 'Webull' : 'Schwab-HK' } });
  const trade = { portfolio_id: pid, holding_id: 700, instrument, quantity: 3,
    state: 'confirmed', company_event_id: null };
  p.holdingHistory = { trades: [
    { ...trade, id: 701, transaction_date: '2026-09-21', description_code: openingType },
    { ...trade, id: 702, transaction_date: '2026-09-22', description_code: 'SELL' },
  ] };
  if (account === 'schwab') {
    p.trades.trades = [{ id: 9, portfolio_id: pid, holding_id: 2,
      instrument: syntheticInstrument(2, 'BRK/B'), transaction_date: D,
      description_code: 'SELL', quantity: 1, state: 'confirmed', company_event_id: null }];
    p.holdingHistory.trades.push(p.trades.trades[0]);
  }
  p.terminalPerformance = { report: { ...p.performance.report, start_date: '2026-09-21',
    include_sales: true, grouping: 'investment_type', currency: { ...p.performance.report.currency },
    cash_accounts: p.performance.report.cash_accounts.map(row => ({ ...row, currency: { ...row.currency }, portfolio: { ...row.portfolio } })), holdings: [
      ...p.performance.report.holdings.map(row => ({ ...row, instrument: { ...row.instrument }, inception_date: null,
        number_of_unconfirmed_transactions: 0 })),
      { ...p.holdings.holdings.at(-1), instrument: { ...instrument }, quantity: 0, value: 0, number_of_unconfirmed_transactions: 0 },
    ] } };
  return fixture;
}

test('catalog-only historical positions require complete target-bound zero quantity proof for either account', () => {
  for (const account of ['schwab', 'webull']) for (const opening of ['BUY', 'OPENING_BALANCE']) {
    const baseline = normalizeRead(raw(), D, selectBenchmark(benchmarkCache, D));
    const input = closedCatalogFixture(account, opening);
    const result = normalizeRead(input, D, selectBenchmark(benchmarkCache, D));
    for (const key of ['accounts', 'splits', 'styleInput', 'flows', 'acctCash', 'prevAcctCash']) {
      assert.deepEqual(result[key], baseline[key]);
    }
    assert.equal(result.styleInput.portfolios.flatMap(p => p.holdings).some(h => h.holdingId === 700), false);
    delete input[account].holdingHistory;
    assert.throws(() => normalizeRead(input, D, selectBenchmark(benchmarkCache, D)), /HOLDING_HISTORY_REQUIRED/);
  }
});

test('closed catalog preserves exact historical instrument codes while active tickers stay strict', () => {
  for (const account of ['schwab', 'webull']) {
    const input = closedCatalogFixture(account), p = input[account];
    p.holdings.holdings.at(-1).instrument.code = 'SYNTHETIC CLOSED POSITION, CLASS A';
    p.terminalPerformance.report.holdings.at(-1).instrument.code = 'SYNTHETIC CLOSED POSITION, CLASS A';
    assert.doesNotThrow(() => normalizeRead(input, D, selectBenchmark(benchmarkCache, D)));
    const first = normalizeRead(input, D, selectBenchmark(benchmarkCache, D));
    p.holdingHistory.trades[0].instrument = { ...p.holdingHistory.trades[0].instrument,
      code: 'SYNTHETIC CLOSED POSITION, CLASS B' };
    assert.throws(() => normalizeRead(input, D, selectBenchmark(benchmarkCache, D)), /HOLDING_HISTORY_UNSUPPORTED/);
    p.holdingHistory.trades[0].instrument.code = 'SYNTHETIC CLOSED POSITION, CLASS A';
    assert.equal(normalizeRead(input, D, selectBenchmark(benchmarkCache, D)).sourceFingerprint, first.sourceFingerprint);
    p.performance.report.holdings[0].instrument.code = 'SYNTHETIC ACTIVE POSITION';
    assert.throws(() => normalizeRead(input, D, selectBenchmark(benchmarkCache, D)), /FEE_CLOUD_HOLDING/);
  }
});

test('historical catalog instrument codes reject empty, oversized and control-character values', () => {
  for (const code of ['', '   ', 'A'.repeat(129), 'SYNTH\nC', 'SYNTH\u0000C', 'SYNTH\u007fC']) {
    const input = closedCatalogFixture(); input.webull.holdings.holdings.at(-1).instrument.code = code;
    assert.throws(() => normalizeRead(input, D, selectBenchmark(benchmarkCache, D)), /HOLDING_IDENTITY/);
  }
});

test('closed catalog proof fails on incomplete, stale, unsupported or contradictory history', () => {
  const changes = [
    p => p.holdingHistory.links = { next: 'next-page' },
    p => p.holdingHistory.trades.push({ ...p.holdingHistory.trades[0] }),
    p => p.holdingHistory.trades[0].portfolio_id = 999,
    p => p.holdingHistory.trades[0].state = 'unconfirmed',
    p => p.holdingHistory.trades[1].transaction_date = '2026-09-24',
    p => p.holdingHistory.trades.pop(),
    p => p.holdingHistory.trades.shift(),
    p => p.holdingHistory.trades[0].description_code = 'SPLIT',
    p => p.holdingHistory.trades[0].company_event_id = 0,
    p => delete p.holdingHistory.trades[0].company_event_id,
    p => p.holdingHistory.trades[1].description_code = 'OPENING_BALANCE',
    p => p.holdingHistory.trades[0].instrument = { ...p.holdingHistory.trades[0].instrument, market_code: 'OTHER' },
    p => p.holdingHistory.trades[0].quantity = 0,
    p => p.terminalPerformance.report.holdings.at(-1).quantity = 1e-18,
    p => p.holdings.holdings.at(-1).inception_date = '2026-09-20',
  ];
  for (const change of changes) {
    const input = closedCatalogFixture(); change(input.webull);
    assert.throws(() => normalizeRead(input, D, selectBenchmark(benchmarkCache, D)),
      /SOURCE_(?:INCOMPLETE|DUPLICATE)|HOLDING_(?:HISTORY|TERMINAL)|FEE_CLOUD_IDENTITY/);
  }
});

test('full terminal proof requires exact catalog coverage, endpoint scope and matching current positions and cash', () => {
  const changes = [
    p => delete p.terminalPerformance,
    p => p.terminalPerformance.links = { next: 'next-page' },
    p => p.terminalPerformance.report.start_date = '2026-09-20',
    p => p.terminalPerformance.report.end_date = '2026-09-22',
    p => p.terminalPerformance.report.include_sales = false,
    p => p.terminalPerformance.report.portfolio_tz_name = 'UTC',
    p => p.terminalPerformance.report.currency.code = 'HKD',
    p => p.terminalPerformance.report.grouping = 'market',
    p => p.terminalPerformance.report.holdings.pop(),
    p => p.terminalPerformance.report.holdings.push({ ...p.terminalPerformance.report.holdings[0] }),
    p => p.terminalPerformance.report.holdings.at(-1).id = 999,
    p => p.terminalPerformance.report.holdings.at(-1).quantity = 1e-18,
    p => p.terminalPerformance.report.holdings.at(-1).value = 1e-18,
    p => p.terminalPerformance.report.holdings.at(-1).number_of_unconfirmed_transactions = 1,
    p => delete p.terminalPerformance.report.holdings.at(-1).number_of_unconfirmed_transactions,
    p => p.terminalPerformance.report.holdings[0].quantity += 1,
    p => p.terminalPerformance.report.holdings[0].value += 1,
    p => p.terminalPerformance.report.value += 1,
    p => p.terminalPerformance.report.cash_accounts = [],
    p => p.terminalPerformance.report.cash_accounts[0].value += 1,
    p => p.terminalPerformance.report.holdings.at(-1).instrument = syntheticInstrument(999, 'SYNTHC'),
  ];
  for (const change of changes) {
    const input = closedCatalogFixture(); change(input.webull);
    assert.throws(() => normalizeRead(input, D, selectBenchmark(benchmarkCache, D)),
      /HOLDING_TERMINAL|SOURCE_(?:INCOMPLETE|DUPLICATE)/);
  }
});

test('terminal original text rejects underflow-to-zero and same-Number active conflicts', () => {
  for (const key of ['quantity', 'value']) {
    const input = wireInput(closedCatalogFixture()), p = input.webull;
    p.terminalPerformance = parseTradeJson(JSON.stringify(p.terminalPerformance).replace(`"${key}":0`, `"${key}":1e-400`));
    assert.throws(() => normalizeCloudRead(input, D, selectBenchmark(benchmarkCache, D)), /HOLDING_TERMINAL_OPEN/);
  }
  const input = closedCatalogFixture(), p = input.webull;
  p.performance.report.holdings[0].quantity = 1e12;
  p.terminalPerformance.report.holdings[0].quantity = 1e12;
  const parsed = wireInput(input);
  parsed.webull.terminalPerformance = parseTradeJson(JSON.stringify(p.terminalPerformance)
    .replace('"quantity":1000000000000', '"quantity":999999999999.99999'));
  assert.throws(() => normalizeCloudRead(parsed, D, selectBenchmark(benchmarkCache, D)), /HOLDING_TERMINAL_CURRENT/);
});

test('explicit terminal zero supports confirmed split history without reconstructing a split ratio', () => {
  const input = closedCatalogFixture(), p = input.webull, first = p.holdingHistory.trades[0];
  p.holdingHistory.trades = [{ ...first, quantity: 2 },
    { ...first, id: 703, quantity: 6, description_code: 'SPLIT', company_event_id: 800, transaction_date: '2026-09-22' },
    { ...first, id: 702, quantity: 8, description_code: 'SELL', transaction_date: '2026-09-22' }];
  p.terminalPerformance.report.holdings[0].number_of_unconfirmed_transactions = 1;
  for (const row of p.terminalPerformance.report.holdings) row.inception_date = null;
  assert.doesNotThrow(() => normalizeRead(input, D, selectBenchmark(benchmarkCache, D)));
  p.holdingHistory.trades[1].description_code = 'UNKNOWN_EVENT';
  assert.throws(() => normalizeRead(input, D, selectBenchmark(benchmarkCache, D)), /HOLDING_HISTORY_UNSUPPORTED/);
});

test('history retains exact decimal differences as audit while terminal report determines closed quantity', () => {
  const input = closedCatalogFixture(), p = input.webull, first = p.holdingHistory.trades[0];
  p.holdingHistory.trades = [{ ...first, id: 703, quantity: 0.1 },
    { ...first, id: 701, quantity: 0.2 }, { ...first, id: 702, quantity: 0.3, description_code: 'SELL' }];
  assert.doesNotThrow(() => normalizeRead(input, D, selectBenchmark(benchmarkCache, D)));
  p.holdingHistory.trades[2].quantity = 0.29999999999999993;
  assert.doesNotThrow(() => normalizeRead(input, D, selectBenchmark(benchmarkCache, D)));
  p.holdingHistory.trades = [{ ...first, quantity: 1e-18 }];
  assert.throws(() => normalizeRead(input, D, selectBenchmark(benchmarkCache, D)), /HOLDING_HISTORY_INCEPTION/);
});

test('independent full terminal report detects an omitted active holding even when the dated report lowers its total', () => {
  const input = closedCatalogFixture(), p = input.webull;
  const missing = p.performance.report.holdings.pop();
  p.performance.report.value -= missing.value;
  p.holdingHistory.trades.push({ id: 704, portfolio_id: 1350094, holding_id: missing.id,
    instrument: missing.instrument, transaction_date: '2026-09-22', description_code: 'BUY',
    quantity: 5, state: 'confirmed', company_event_id: null });
  assert.throws(() => normalizeRead(input, D, selectBenchmark(benchmarkCache, D)), /HOLDING_TERMINAL_OPEN/);
});

test('target-day history and trade listing must agree and a reopened position cannot count as closed', () => {
  const input = closedCatalogFixture(), p = input.webull;
  const reopen = { ...p.holdingHistory.trades[0], id: 705, transaction_date: D, quantity: 1 };
  p.trades.trades = [reopen];
  assert.throws(() => normalizeRead(input, D, selectBenchmark(benchmarkCache, D)), /HOLDING_HISTORY_CURRENT/);
  p.holdingHistory.trades.push(reopen);
  assert.throws(() => normalizeRead(input, D, selectBenchmark(benchmarkCache, D)), /HOLDING_HISTORY_INCEPTION/);
  p.terminalPerformance.report.holdings.at(-1).quantity = 1;
  assert.throws(() => normalizeRead(input, D, selectBenchmark(benchmarkCache, D)), /HOLDING_TERMINAL_OPEN/);
  p.terminalPerformance.report.holdings.at(-1).quantity = 0;
  p.trades.trades = [];
  assert.throws(() => normalizeRead(input, D, selectBenchmark(benchmarkCache, D)), /HOLDING_HISTORY_CURRENT/);
});

test('latest history date requires a sale, with same-day order left to the exact terminal report', () => {
  const input = closedCatalogFixture(), p = input.webull, first = p.holdingHistory.trades[0];
  p.holdingHistory.trades.push({ ...first, id: 703, transaction_date: '2026-09-22', quantity: 1 });
  assert.doesNotThrow(() => normalizeRead(input, D, selectBenchmark(benchmarkCache, D)));
  p.holdingHistory.trades.at(-1).transaction_date = D;
  p.trades.trades = [{ ...p.holdingHistory.trades.at(-1) }];
  assert.throws(() => normalizeRead(input, D, selectBenchmark(benchmarkCache, D)), /HOLDING_HISTORY_INCEPTION/);
});

test('target-day closed proof rejects conflicting or missing corporate-action markers', () => {
  for (const marker of [999, undefined]) {
    const input = closedCatalogFixture(), p = input.webull;
    p.holdingHistory.trades[1].transaction_date = D;
    p.trades.trades = [{ ...p.holdingHistory.trades[1], company_event_id: marker }];
    assert.throws(() => normalizeRead(input, D, selectBenchmark(benchmarkCache, D)), /HOLDING_HISTORY_CURRENT/);
  }
});

function quantityLexemeReader(fixtures, historyLexemes, dayLexemes = []) {
  const response = (url, value, lexemes) => {
    let body = JSON.stringify(value), index = 0;
    if (lexemes) body = body.replace(/"quantity":3/g, () => `"quantity":${lexemes[index++]}`);
    const r = new Response(body, { headers: { 'content-type': 'application/json' } });
    Object.defineProperty(r, 'url', { value: url }); return r;
  };
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/oauth2/token')) return response(url, { access_token: 'x'.repeat(30), token_type: 'bearer' });
    assert.equal(init.method, 'GET');
    if (url.endsWith('/portfolios.json')) return response(url, { portfolios: [
      { id: 936249, name: 'Schwab-HK', currency_code: 'USD' }, { id: 1350094, name: 'Webull', currency_code: 'USD' },
    ] });
    const account = url.includes('936249') || url.includes('142251') ? 'schwab' : 'webull';
    const p = fixtures[account], params = new URL(url).searchParams;
    if (url.includes('/performance?')) return response(url, params.get('include_sales') === 'true'
      ? p.terminalPerformance : params.get('end_date') === D ? p.performance : p.previousPerformance);
    if (url.includes('/holdings?')) return response(url, p.holdings);
    if (url.includes('/cash_accounts.json')) return response(url, p.cashAccounts);
    if (url.includes('cash_account_transactions')) return response(url, Object.values(p.cashTransactions)[0]);
    if (url.includes('trades.json')) {
      return response(url, params.has('start_date') ? p.trades : (p.holdingHistory || p.trades),
        account === 'webull' ? (params.has('start_date') ? dayLexemes : historyLexemes) : undefined);
    }
    assert.fail('unexpected fixed source route');
  };
  return new SharesightCloudReader({ clientId: 'id', clientSecret: 'secret', fetchImpl });
}

test('reader rejects invalid original history quantity tokens and preserves residuals in its audit fingerprint', async () => {
  for (const [lexemes, error] of [
    [['1000000000000.00001', '1000000000000.00001'], /HOLDING_HISTORY_UNSUPPORTED/],
    [['1e-19', '1e-19'], /HOLDING_HISTORY_UNSUPPORTED/],
    [['"3"', '"3"'], /HOLDING_HISTORY_UNSUPPORTED/],
    [['null', 'null'], /HOLDING_HISTORY_UNSUPPORTED/],
  ]) {
    const reader = quantityLexemeReader(closedCatalogFixture(), lexemes);
    await assert.rejects(reader.readStable(D, selectBenchmark(benchmarkCache, D)), error);
  }
  const input = closedCatalogFixture();
  const residual = await quantityLexemeReader(input, ['1000000000000', '999999999999.99999'])
    .readStable(D, selectBenchmark(benchmarkCache, D));
  const exact = await quantityLexemeReader(input, ['1000000000000', '1000000000000'])
    .readStable(D, selectBenchmark(benchmarkCache, D));
  assert.deepEqual(residual.accounts, exact.accounts);
  assert.notEqual(residual.sourceFingerprint, exact.sourceFingerprint);
});

test('closed proof rejects direct Number-only histories without original quantity tokens', () => {
  const fixture = closedCatalogFixture();
  for (const p of Object.values(fixture)) p.cashAccounts = parseTradeJson(JSON.stringify(p.cashAccounts));
  assert.throws(() => normalizeCloudRead(fixture, D, selectBenchmark(benchmarkCache, D)),
    /HOLDING_TERMINAL_PRECISION/);
});

test('original quantity tokens handle exponent notation and escaped numeric descriptions canonically', async () => {
  const input = closedCatalogFixture();
  for (const trade of input.webull.holdingHistory.trades) {
    trade.comments = '123 \\ "quantity":999999999999.99999 \\u0033 "quoted"';
  }
  const first = await quantityLexemeReader(input, ['3E-1', '0.30'])
    .readStable(D, selectBenchmark(benchmarkCache, D));
  const second = await quantityLexemeReader(input, ['0.3', '3e-1'])
    .readStable(D, selectBenchmark(benchmarkCache, D));
  assert.equal(first.sourceFingerprint, second.sourceFingerprint);
});

test('target-day original quantity conflict stops even when both JSON Numbers round to the same value', async () => {
  const input = closedCatalogFixture(), p = input.webull;
  p.holdingHistory.trades[1].transaction_date = D;
  p.trades.trades = [{ ...p.holdingHistory.trades[1] }];
  const reader = quantityLexemeReader(input, ['1000000000000', '1000000000000'], ['999999999999.99999']);
  await assert.rejects(reader.readStable(D, selectBenchmark(benchmarkCache, D)), /HOLDING_HISTORY_CURRENT/);
});

test('target-day exact quantity comparison also covers active report holdings', async () => {
  const input = closedCatalogFixture(), p = input.webull;
  const active = { ...p.holdingHistory.trades[0], id: 706, holding_id: 4,
    instrument: syntheticInstrument(4, 'GOOG'), transaction_date: D };
  p.holdingHistory.trades.push(active); p.trades.trades = [{ ...active }];
  const reader = quantityLexemeReader(input, ['3', '3', '1000000000000'], ['999999999999.99999']);
  await assert.rejects(reader.readStable(D, selectBenchmark(benchmarkCache, D)), /HOLDING_HISTORY_CURRENT/);
});

test('source fingerprint binds canonical closed history rather than only its zero result', () => {
  const input = closedCatalogFixture(), p = input.webull;
  const before = normalizeRead(input, D, selectBenchmark(benchmarkCache, D));
  p.holdingHistory.trades.reverse();
  assert.equal(normalizeRead(input, D, selectBenchmark(benchmarkCache, D)).sourceFingerprint, before.sourceFingerprint);
  for (const trade of p.holdingHistory.trades) trade.quantity = 4;
  const after = normalizeRead(input, D, selectBenchmark(benchmarkCache, D));
  assert.deepEqual(after.accounts, before.accounts);
  assert.notEqual(after.sourceFingerprint, before.sourceFingerprint);
});

test('dated holdings must match catalog instrument, market and currency identities', () => {
  for (const key of ['id', 'code', 'market_code', 'currency_code']) {
    const input = raw(); input.webull.performance.report.holdings[0].instrument[key] = key === 'id' ? 999 : 'OTHER';
    assert.throws(() => normalizeRead(input, D, selectBenchmark(benchmarkCache, D)), /HOLDING_IDENTITY/);
  }
  for (const change of [r => r.start_date = '2026-09-22', r => r.include_sales = true,
    r => r.portfolio_tz_name = 'UTC']) {
    const input = raw(); change(input.webull.performance.report);
    assert.throws(() => normalizeRead(input, D, selectBenchmark(benchmarkCache, D)), /PERFORMANCE_IDENTITY/);
  }
});

test("benchmark requires a complete same-date pair", () => {
  assert.equal(latestCommonBenchmarkDate(benchmarkCache), D);
  assert.deepEqual(selectBenchmark(benchmarkCache, D), { spy: 701, spyd: 1.5, qqq: 602, qqqd: 0 });
  const broken = structuredClone(benchmarkCache); broken.benchmarks.qqq.series.pop();
  assert.throws(() => selectBenchmark(broken, D), /BENCHMARK_PENDING/);
});

test('target is a completed New York weekday, independent of stale/future cache and DST', async () => {
  const cases = [
    ['2026-10-08T14:00:00Z','2026-10-07'], ['2026-10-08T20:14:59Z','2026-10-07'],
    ['2026-10-08T20:15:00Z','2026-10-08'], ['2026-10-12T14:00:00Z','2026-10-09'],
    ['2026-10-08T23:59:59Z','2026-10-08'], ['2026-10-09T00:00:00Z','2026-10-08'],
    ['2026-11-02T21:14:59Z','2026-10-30'], ['2026-11-02T21:15:00Z','2026-11-02'],
    ['2026-03-09T20:14:59Z','2026-03-06'], ['2026-03-09T20:15:00Z','2026-03-09'],
    ['2027-01-01T14:00:00Z','2026-12-31'],
  ];
  for (const [now, day] of cases) assert.equal(expectedTargetDate(new Date(now)),day);
  assert.equal(previousCalendarDate('2026-03-01'),'2026-02-28');
  assert.equal(previousCalendarDate('2028-03-01'),'2028-02-29');
  assert.throws(()=>expectedTargetDate(new Date('invalid')),/DATE/);
  let reads=0;
  await assert.rejects(publishedPreflight({cache:benchmarkCache,now:()=>new Date('2026-10-08T14:00:00Z'),
    readState:async()=>{reads++;}}),/BENCHMARK_PENDING/);
  assert.equal(reads,0);
  let attempts=0;
  const result=await publishedPreflight({cache:benchmarkCache,now:gateNow,attempts:2,delayMs:0,sleep:async()=>{},
    readState:async()=>{if(++attempts===1)throw new Error('private transport detail');return publicationFixture();}});
  assert.equal(result.outcome,'already-published');assert.equal(attempts,2);
});

function jsonResponse(url, value) {
  const response=new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
  Object.defineProperty(response,'url',{value:url});return response;
}

test('bounded transport covers stalled headers/body even when abort is ignored', async () => {
  for (const bodyOnly of [false,true]) {
    let signal, cancelled=false;
    const start=Date.now();
    await assert.rejects(boundedJson(async(url,init)=>{
      signal=init.signal;
      if(!bodyOnly)return new Promise(()=>{});
      return {url,status:200,body:{getReader(){return {read:()=>new Promise(()=>{}),cancel(){cancelled=true;},releaseLock(){}};}}};
    },'https://synthetic.test/json',{}, {timeoutMs:30}),error=>error instanceof BoundedJsonError&&error.code==='TIMEOUT');
    assert.ok(Date.now()-start<1000);assert.equal(signal.aborted,true);
    if(bodyOnly)assert.equal(cancelled,true);
  }
});

test('bounded transport stops oversized/slow streams, rejects malformed responses and preserves valid JSON', async () => {
  const url='https://synthetic.test/json';let pulled=0,cancelled=false;
  const body={getReader(){return {async read(){pulled++;return {done:false,value:Buffer.alloc(30)};},cancel(){cancelled=true;},releaseLock(){}};}};
  await assert.rejects(boundedJson(async()=>({url,status:200,body}),url,{}, {maxBytes:50,timeoutMs:100}),/SIZE/);
  assert.equal(pulled,2);assert.equal(cancelled,true);
  const slow={getReader(){return {async read(){await new Promise(r=>setTimeout(r,50));return {done:false,value:Buffer.from(' ')};},cancel(){},releaseLock(){}};}};
  await assert.rejects(boundedJson(async()=>({url,status:200,body:slow}),url,{}, {timeoutMs:10}),/TIMEOUT/);
  const bad=[['HTTP',()=>({url,status:401})],['HTTP',()=>({url:url+'/redirect',status:200})],
    ['TYPE',()=>{const r=jsonResponse(url,{});Object.defineProperty(r,'headers',{value:{get:()=> 'text/html'}});return r;}],
    ['JSON',()=>{const r=new Response('{bad');Object.defineProperty(r,'url',{value:url});return r;}]];
  for(const [code,create]of bad)await assert.rejects(boundedJson(async()=>create(),url,{}, {requireJsonType:code==='TYPE'}),new RegExp(code));
  assert.deepEqual(await boundedJson(async()=>jsonResponse(url,{ok:true}),url),{ok:true});
});

test('every source collection rejects pagination, restricted results and duplicate identities', () => {
  const paths=[r=>r.schwab.holdings,r=>r.schwab.cashAccounts,r=>r.schwab.cashTransactions[142251],
    r=>r.schwab.trades,r=>r.schwab.performance,r=>r.schwab.previousPerformance];
  for(const select of paths)for(const mark of [p=>p.links={next:'synthetic'},p=>p.pagination={next_page:2},
    p=>p.meta={pagination:{next_page:2}},p=>p.restricted=true,p=>p.complete=false]) {
    const r=raw();mark(select(r));assert.throws(()=>normalizeRead(r,D,selectBenchmark(benchmarkCache,D)),/SOURCE_INCOMPLETE/);
  }
  for(const select of [r=>r.schwab.holdings.holdings,r=>r.schwab.performance.report.holdings,
    r=>r.schwab.cashAccounts.cash_accounts,r=>r.schwab.cashTransactions[142251].cash_account_transactions,r=>r.schwab.trades.trades]) {
    const r=raw(),list=select(r);list.push({...list[0]});assert.throws(()=>normalizeRead(r,D,selectBenchmark(benchmarkCache,D)),/SOURCE_DUPLICATE/);
  }
  for(const mutate of [r=>r.schwab.trades.trades[0].portfolio_id=1,r=>r.schwab.trades.trades[0].state='pending',
    r=>delete r.schwab.cashTransactions[142251],r=>r.schwab.performance.report.restricted=true]) {
    const r=raw();mutate(r);assert.throws(()=>normalizeRead(r,D,selectBenchmark(benchmarkCache,D)));
  }
});

test('cash proof is independent: missing, stale, conflicting, omitted and wrong terminal movements stop', () => {
  const baseline=raw();assert.equal(baseline.schwab.previousPerformance.report.cash_accounts[0].value,350);
  for(const mutate of [r=>delete r.schwab.previousPerformance,
    r=>r.schwab.previousPerformance.report.end_date=D,
    r=>r.schwab.previousPerformance.report.portfolio_id=1,
    r=>r.schwab.previousPerformance.report.cash_accounts[0].value=400,
    r=>r.schwab.cashTransactions[142251].cash_account_transactions[0].amount=49,
    r=>r.schwab.cashTransactions[142251].cash_account_transactions=[],
    r=>r.schwab.cashTransactions[142251].cash_account_transactions[0].balance=399,
    r=>{r.schwab.performance.report.cash_accounts[0].value=450;r.schwab.performance.report.value=1050;},
    r=>r.schwab.cashTransactions[142251].cash_account_transactions.push({id:101,cash_account_id:142251,
      date_time:D+'T01:00:00Z',amount:0,balance:399,cash_account_transaction_type:{name:'FEE'}})]) {
    const r=structuredClone(baseline);mutate(r);assert.throws(()=>normalizeRead(r,D,selectBenchmark(benchmarkCache,D)));
  }
  const ordered=raw();ordered.schwab.cashTransactions[142251].cash_account_transactions=[
    {id:111,cash_account_id:142251,date_time:D+'T02:00:00Z',amount:-20,balance:400,cash_account_transaction_type:{name:'FEE'}},
    {id:110,cash_account_id:142251,date_time:D+'T01:00:00Z',amount:70,balance:420,cash_account_transaction_type:{name:'DEPOSIT'}}];
  assert.equal(normalizeRead(ordered,D,selectBenchmark(benchmarkCache,D)).prevAcctCash.schwab,350);
  ordered.schwab.cashTransactions[142251].cash_account_transactions[1].balance=400;
  assert.throws(()=>normalizeRead(ordered,D,selectBenchmark(benchmarkCache,D)),/CASH_CHAIN/);
});

test('same-time cash balances prove a chain independently of IDs and reject contradictions or ambiguity', () => {
  const fixture=raw(),cashId=fixture.schwab.cashAccounts.cash_accounts[0].id;
  const tx=(id,amount,balance)=>({id,cash_account_id:cashId,date_time:D+'T01:00:00Z',amount,balance,
    cash_account_transaction_type:{name:'FEE'}});
  const rows=[tx(110,-20,400),tx(111,70,420)];
  fixture.schwab.cashTransactions[cashId].cash_account_transactions=rows;
  assert.equal(normalizeRead(fixture,D,selectBenchmark(benchmarkCache,D)).prevAcctCash.schwab,350);
  fixture.schwab.cashTransactions[cashId].cash_account_transactions=[rows[1],rows[0]];
  assert.equal(normalizeRead(fixture,D,selectBenchmark(benchmarkCache,D)).acctCash.schwab,400);
  rows[1].balance=999;
  assert.throws(()=>normalizeRead(fixture,D,selectBenchmark(benchmarkCache,D)),/CASH_CHAIN/);
  fixture.schwab.cashTransactions[cashId].cash_account_transactions=[tx(110,70,420),tx(111,-70,350),tx(112,50,400)];
  assert.throws(()=>normalizeRead(fixture,D,selectBenchmark(benchmarkCache,D)),/CASH_CHAIN_AMBIGUOUS/);
});

test("normalization reconciles cash, SGOV, stock, flow evidence and style input", () => {
  const result = normalizeRead(raw(), D, selectBenchmark(benchmarkCache, D));
  assert.deepEqual(result.accounts, { schwab: 1000, webull: 1000 });
  assert.deepEqual(result.splits, { cash: 800, stock: 1050, other: 150 });
  assert.equal(result.styleInput.portfolios[0].holdings.some(row => row.ticker === "SGOV"), false);
  assert.equal(result.flows[0].tradeId, 9);
  assert.deepEqual(result.acctCash, { schwab: 400 });
  assert.deepEqual(result.prevAcctCash, { schwab: 350 });
  assert.match(result.sourceFingerprint, /^[a-f0-9]{64}$/);
});

function foreignCashFixture(account = 'schwab', fixture = raw()) {
  const p = fixture[account], cashId = account === 'schwab' ? 142252 : 90251;
  const portfolio = account === 'schwab' ? { id: 936249, name: 'Schwab-HK' } : { id: 1350094, name: 'Webull' };
  p.performance.report.cash_accounts.push({ id: cashId, value: 13, currency: { code: 'HKD' },
    portfolio });
  p.performance.report.value += 13;
  p.cashAccounts.cash_accounts.push({ id: cashId, portfolio_id: portfolio.id, currency: 'HKD',
    portfolio_currency: 'USD', date: D, balance: 100, balance_in_portfolio_currency: 13 });
  p.cashTransactions[cashId] = { cash_account_transactions: [] };
  p.previousPerformance.report.cash_accounts.push({ id: cashId, value: 12.85,
    currency: { code: 'HKD' }, portfolio });
  const previousUsd = p.previousPerformance.report.cash_accounts[0].value;
  p.previousCashAccounts = { cash_accounts: p.cashAccounts.cash_accounts.map(row => ({ ...row,
    date: previousCalendarDate(D), balance: row.currency === 'USD' ? previousUsd : row.balance,
    balance_in_portfolio_currency: row.currency === 'USD' ? previousUsd : 12.85 })) };
  return fixture;
}

test('foreign FX valuation remains in assets while only USD cash reconciles with USD flows and writer', () => {
  const result = normalizeRead(foreignCashFixture(), D, selectBenchmark(benchmarkCache, D));
  assert.equal(result.accounts.schwab, 1013);
  assert.equal(result.splits.cash, 813);
  assert.deepEqual(result.acctCash, { schwab: 400 });
  assert.deepEqual(result.prevAcctCash, { schwab: 350 });
  assert.equal(result.flows.length, 1);
  assert.deepEqual(checkCashLedger({ date: D, acctCash: result.acctCash,
    prevAcctCash: result.prevAcctCash, movements: result.flows }), []);
  // Passing the old all-currency totals would falsely reject the same USD flow.
  assert.equal(checkCashLedger({ date: D, acctCash: { schwab: 413 },
    prevAcctCash: { schwab: 362.85 }, movements: result.flows }).length, 1);
  const noFlow = foreignCashFixture();
  noFlow.schwab.cashTransactions[142251].cash_account_transactions = [];
  noFlow.schwab.previousPerformance.report.cash_accounts[0].value = 400;
  Object.assign(noFlow.schwab.previousCashAccounts.cash_accounts[0], { balance: 400, balance_in_portfolio_currency: 400 });
  const empty = normalizeRead(noFlow, D, selectBenchmark(benchmarkCache, D));
  assert.equal(empty.splits.cash, 813); assert.deepEqual(empty.flows, []);
  assert.deepEqual(empty.acctCash, {});
});

test('foreign cash rejects omitted movements, missing independent dates and altered identities or values', async t => {
  const changes = [
    ['missing prior', p => delete p.previousCashAccounts, /CASH_PREVIOUS_EVIDENCE/],
    ['empty prior', p => p.previousCashAccounts.cash_accounts = [], /CASH_PREVIOUS_EVIDENCE/],
    ['omitted foreign movement', p => p.previousCashAccounts.cash_accounts[1].balance = 99.99, /NON_USD_BALANCE_CHANGED/],
    ['current date missing', p => delete p.cashAccounts.cash_accounts[1].date, /CASH_IDENTITY/],
    ['current date ignored', p => p.cashAccounts.cash_accounts[1].date = previousCalendarDate(D), /CASH_IDENTITY/],
    ['prior date ignored', p => p.previousCashAccounts.cash_accounts[1].date = D, /CASH_IDENTITY/],
    ['prior foreign currency changed', p => p.previousCashAccounts.cash_accounts[1].currency = 'EUR', /CASH_PREVIOUS_EVIDENCE/],
    ['prior account changed', p => p.previousCashAccounts.cash_accounts[1].portfolio_id = 1350094, /CASH_IDENTITY/],
    ['current conversion conflicts', p => p.cashAccounts.cash_accounts[1].balance_in_portfolio_currency = 13.02, /CASH_REPORT_BALANCE/],
    ['prior conversion conflicts', p => p.previousCashAccounts.cash_accounts[1].balance_in_portfolio_currency = 12.87, /CASH_PREVIOUS_EVIDENCE/],
    ['current raw balance missing', p => delete p.cashAccounts.cash_accounts[1].balance, /CASH_PRECISION/],
    ['prior raw balance missing', p => delete p.previousCashAccounts.cash_accounts[1].balance, /CASH_PRECISION/],
    ['non-2dp balance', p => p.previousCashAccounts.cash_accounts[1].balance = 100.001, /CASH_PRECISION/],
    ['paginated prior', p => p.previousCashAccounts.links = { next: 'synthetic' }, /SOURCE_INCOMPLETE/],
    ['duplicate prior', p => p.previousCashAccounts.cash_accounts.push({ ...p.previousCashAccounts.cash_accounts[1] }), /SOURCE_DUPLICATE/],
    ['swapped prior cash ID', p => p.previousCashAccounts.cash_accounts[1].id = 142253, /CASH_PREVIOUS_EVIDENCE/],
  ];
  for (const [name, mutate, error] of changes) await t.test(name, () => {
    const fixture = foreignCashFixture(); mutate(fixture.schwab);
    assert.throws(() => normalizeRead(fixture, D, selectBenchmark(benchmarkCache, D)), error);
  });
  const nonUsd = foreignCashFixture();
  nonUsd.schwab.cashTransactions[142252].cash_account_transactions = [{ id: 102, cash_account_id: 142252,
    date_time: D + 'T01:00:00Z', amount: 1, balance: 100, cash_account_transaction_type: { name: 'DEPOSIT' } }];
  assert.throws(() => normalizeRead(nonUsd, D, selectBenchmark(benchmarkCache, D)), /NON_USD_MOVEMENT/);
});

test('foreign original balances and both dated conversions remain bound to the A/B fingerprint', () => {
  const first = foreignCashFixture(), changed = foreignCashFixture();
  changed.schwab.cashAccounts.cash_accounts[1].balance = 100.01;
  changed.schwab.previousCashAccounts.cash_accounts[1].balance = 100.01;
  const a = normalizeRead(first, D, selectBenchmark(benchmarkCache, D));
  const b = normalizeRead(changed, D, selectBenchmark(benchmarkCache, D));
  for (const key of ['accounts', 'splits', 'flows', 'acctCash', 'prevAcctCash']) assert.deepEqual(a[key], b[key]);
  assert.notEqual(a.sourceFingerprint, b.sourceFingerprint);
  const priorValuation = foreignCashFixture();
  priorValuation.schwab.previousPerformance.report.cash_accounts[1].value = 12.84;
  priorValuation.schwab.previousCashAccounts.cash_accounts[1].balance_in_portfolio_currency = 12.84;
  assert.notEqual(a.sourceFingerprint, normalizeRead(priorValuation, D, selectBenchmark(benchmarkCache, D)).sourceFingerprint);
  first.schwab.cashAccounts.cash_accounts.reverse(); first.schwab.previousCashAccounts.cash_accounts.reverse();
  assert.equal(a.sourceFingerprint, normalizeRead(first, D, selectBenchmark(benchmarkCache, D)).sourceFingerprint);
});

function datedCashReader(fixtures, { ignoredDate = false, unstable = false, unstablePriorValuation = false, cashToken } = {}, calls = []) {
  let round = 0;
  const response = (url, value) => {
    let body = JSON.stringify(value);
    if (cashToken && url.includes('/cash_accounts.json')) body = body.replace('"balance":100', `"balance":${cashToken}`);
    const r = new Response(body, { headers: { 'content-type': 'application/json' } });
    Object.defineProperty(r, 'url', { value: url }); return r;
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method });
    if (url.endsWith('/oauth2/token')) { round++; return response(url, { access_token: 'x'.repeat(30), token_type: 'bearer' }); }
    assert.equal(init.method, 'GET');
    if (url.endsWith('/portfolios.json')) return response(url, { portfolios: [
      { id: 936249, name: 'Schwab-HK', currency_code: 'USD' }, { id: 1350094, name: 'Webull', currency_code: 'USD' },
    ] });
    const u = new URL(url), account = /(?:936249|14225[12])/.test(u.pathname) ? 'schwab' : 'webull', p = fixtures[account];
    if (u.pathname.endsWith('/performance')) {
      const prior = u.searchParams.get('end_date') !== D;
      const value = structuredClone(prior ? p.previousPerformance : p.performance);
      if (prior && unstablePriorValuation && round === 2)
        for (const row of value.report.cash_accounts) if (row.currency.code === 'HKD') row.value += 0.01;
      return response(url, value);
    }
    if (u.pathname.endsWith('/holdings')) return response(url, p.holdings);
    if (u.pathname.endsWith('/cash_accounts.json')) {
      const day = u.searchParams.get('date'); assert.ok([D, previousCalendarDate(D)].includes(day));
      const value = structuredClone(day === D || ignoredDate ? p.cashAccounts : p.previousCashAccounts);
      if (unstable && round === 2) for (const row of value.cash_accounts) if (row.currency === 'HKD') row.balance += 0.01;
      if (day !== D && unstablePriorValuation && round === 2)
        for (const row of value.cash_accounts) if (row.currency === 'HKD') row.balance_in_portfolio_currency += 0.01;
      return response(url, value);
    }
    if (u.pathname.endsWith('/cash_account_transactions.json')) return response(url, p.cashTransactions[u.pathname.split('/')[4]]);
    if (u.pathname.endsWith('/trades.json')) return response(url, p.trades);
    assert.fail('unexpected synthetic fixed source route');
  };
  return new SharesightCloudReader({ clientId: 'id', clientSecret: 'secret', fetchImpl });
}

test('transport reads fixed target cash dates and a prior list only for foreign cash in both stable rounds', async () => {
  const calls = [], reader = datedCashReader(foreignCashFixture(), {}, calls);
  const result = await reader.readStable(D, selectBenchmark(benchmarkCache, D));
  assert.equal(result.splits.cash, 813);
  const lists = calls.filter(c => new URL(c.url).pathname.endsWith('/cash_accounts.json'));
  assert.equal(lists.length, 6);
  assert.equal(lists.filter(c => c.url.endsWith(`date=${D}`)).length, 4);
  assert.equal(lists.filter(c => c.url.endsWith(`date=${previousCalendarDate(D)}`)).length, 2);
  assert.ok(lists.filter(c => c.url.endsWith(`date=${previousCalendarDate(D)}`)).every(c => c.url.includes('/936249/')));
  await assert.rejects(datedCashReader(foreignCashFixture(), { ignoredDate: true }).readStable(D, selectBenchmark(benchmarkCache, D)), /CASH_IDENTITY/);
  await assert.rejects(datedCashReader(foreignCashFixture(), { unstable: true }).readStable(D, selectBenchmark(benchmarkCache, D)), /SOURCE_UNSTABLE/);
});

test('both production reader rounds date cash lists for either or both foreign-cash portfolios', async t => {
  for (const accounts of [['schwab'], ['webull'], ['schwab', 'webull']]) await t.test(accounts.join('+'), async () => {
    const fixtures = accounts.reduce((value, account) => foreignCashFixture(account, value), raw());
    const calls = [];
    const result = await datedCashReader(fixtures, {}, calls).readStable(D, selectBenchmark(benchmarkCache, D));
    assert.equal(result.splits.cash, 800 + accounts.length * 13);
    const lists = calls.filter(c => new URL(c.url).pathname.endsWith('/cash_accounts.json'));
    assert.equal(lists.length, 4 + accounts.length * 2);
    for (const [account, portfolioId] of [['schwab', 936249], ['webull', 1350094]]) {
      const scoped = lists.filter(c => new URL(c.url).pathname.includes(`/portfolios/${portfolioId}/`));
      assert.equal(scoped.filter(c => new URL(c.url).searchParams.get('date') === D).length, 2);
      assert.equal(scoped.filter(c => new URL(c.url).searchParams.get('date') === previousCalendarDate(D)).length,
        accounts.includes(account) ? 2 : 0);
      assert.ok(scoped.every(c => c.method === 'GET' && new URL(c.url).searchParams.size === 1));
    }
    assert.equal(calls.filter(c => c.url.endsWith('/oauth2/token')).length, 2);
    assert.deepEqual(result.acctCash, { schwab: 400 });
    assert.deepEqual(result.prevAcctCash, { schwab: 350 });
    await assert.rejects(datedCashReader(fixtures, { unstablePriorValuation: true })
      .readStable(D, selectBenchmark(benchmarkCache, D)), /SOURCE_UNSTABLE/);
  });
});

test('original cash number tokens reject sub-cent balances and underflow without relaxing the two-decimal contract', async () => {
  for (const cashToken of ['100.001', '1e-400', '"100"', '1000000000000.01']) {
    await assert.rejects(datedCashReader(foreignCashFixture(), { cashToken }).readStable(D, selectBenchmark(benchmarkCache, D)), /CASH_PRECISION|AMOUNT/);
  }
  const canonical = await datedCashReader(foreignCashFixture(), { cashToken: '1e2' }).readStable(D, selectBenchmark(benchmarkCache, D));
  const ordinary = await datedCashReader(foreignCashFixture()).readStable(D, selectBenchmark(benchmarkCache, D));
  assert.equal(canonical.sourceFingerprint, ordinary.sourceFingerprint);
});

test("controlled Webull principal cash legs remain internal trades", () => {
  const fixture = raw();
  const foreignIdentifier = "webullhk-10205226-email-946332324153d3d2466a2cf7a2ccfcda-cash";
  fixture.webull.cashTransactions[90250].cash_account_transactions.push({
    id:701, amount: -125, balance: 400, cash_account_id: 90250, date_time: `${D}T00:00:00.000Z`,
    description: `Webull AAOI BUY securities principal; NOT external funding; ${foreignIdentifier}`,
    cash_account_transaction_type: { name: "WITHDRAWAL" }, trade_id: null, holding_id: null,
    foreign_identifier: foreignIdentifier,
  });
  fixture.webull.previousPerformance.report.cash_accounts[0].value = fixture.webull.cashTransactions[90250].cash_account_transactions[0]?.amount === -9650 ? 10050 : 525;
  const result = normalizeRead(fixture, D, selectBenchmark(benchmarkCache, D));
  const flow = result.flows.find(row => row.foreignIdentifier === foreignIdentifier);
  assert.equal(flow.evidence, "internal_trade");
});

test("account-bound Webull principal cash legs match the unique live Sharesight trade", () => {
  const fixture = raw();
  const orderId = "0387IJ3B2S80O0K7Q9BC000000";
  fixture.webull.cashTransactions[90250].cash_account_transactions.push({
    id:702, amount: -9650, balance: 400, cash_account_id: 90250, date_time: `${D}T04:00:00.000Z`,
    description: `Webull VSTL BUY securities principal; NOT external funding; order ${orderId}; holding 29274212; ${D} 09:55:50 EDT; source fee USD 0.00.`,
    cash_account_transaction_type: { name: "WITHDRAWAL" }, trade_id: null, holding_id: null,
    foreign_identifier: null,
  });
  fixture.webull.trades.trades.push({
    id: 138761041, portfolio_id: 1350094, transaction_date: D, state: "confirmed",
    description_code: "BUY", holding_id: 29274212, value: 9650,
    instrument: { code: "VSTL" },
    comments: `Webull account 10205226; ${D} 09:55:50 EDT fill; order ${orderId}; 500 VSTL @ USD 19.30; source commission/fees USD 0.00.`,
  });
  fixture.webull.previousPerformance.report.cash_accounts[0].value = fixture.webull.cashTransactions[90250].cash_account_transactions[0]?.amount === -9650 ? 10050 : 525;
  const result = normalizeRead(fixture, D, selectBenchmark(benchmarkCache, D));
  const flow = result.flows.find(row => row.desc.includes(orderId));
  assert.equal(flow.evidence, "internal_trade");
});

test("Webull principal text alone stays unresolved when its trade evidence does not match", () => {
  const fixture = raw();
  const orderId = "0387IJ3B2S80O0K7Q9BC000000";
  fixture.webull.cashTransactions[90250].cash_account_transactions.push({
    id:702, amount: -9650, balance: 400, cash_account_id: 90250, date_time: `${D}T04:00:00.000Z`,
    description: `Webull VSTL BUY securities principal; NOT external funding; order ${orderId}; holding 29274212; ${D} 09:55:50 EDT; source fee USD 0.00.`,
    cash_account_transaction_type: { name: "WITHDRAWAL" }, trade_id: null, holding_id: null,
    foreign_identifier: null,
  });
  fixture.webull.trades.trades.push({
    id: 138761041, portfolio_id: 1350094, transaction_date: D, state: "confirmed",
    description_code: "BUY", holding_id: 29274212, value: 9651,
    instrument: { code: "VSTL" },
    comments: `Webull account 10205226; ${D} 09:55:50 EDT fill; order ${orderId}; 500 VSTL @ USD 19.30; source commission/fees USD 0.00.`,
  });
  fixture.webull.previousPerformance.report.cash_accounts[0].value = fixture.webull.cashTransactions[90250].cash_account_transactions[0]?.amount === -9650 ? 10050 : 525;
  const result = normalizeRead(fixture, D, selectBenchmark(benchmarkCache, D));
  const flow = result.flows.find(row => row.desc.includes(orderId));
  assert.equal(Object.hasOwn(flow, "evidence"), false);
});

test("a generic Webull withdrawal is not promoted to internal without the controlled evidence", () => {
  const fixture = raw();
  fixture.webull.cashTransactions[90250].cash_account_transactions.push({
    id:701, amount: -125, balance: 400, cash_account_id: 90250, date_time: `${D}T00:00:00.000Z`,
    description: "manual withdrawal", cash_account_transaction_type: { name: "WITHDRAWAL" },
    trade_id: null, holding_id: null, foreign_identifier: "manual-1",
  });
  fixture.webull.previousPerformance.report.cash_accounts[0].value = fixture.webull.cashTransactions[90250].cash_account_transactions[0]?.amount === -9650 ? 10050 : 525;
  const result = normalizeRead(fixture, D, selectBenchmark(benchmarkCache, D));
  const flow = result.flows.find(row => row.foreignIdentifier === "manual-1");
  assert.equal(Object.hasOwn(flow, "evidence"), false);
});

test("unlisted performance holding and non-USD movement fail closed", () => {
  const missing = raw(); missing.schwab.holdings.holdings.pop();
  assert.throws(() => normalizeRead(missing, D, selectBenchmark(benchmarkCache, D)), /HOLDING_IDENTITY/);
  const fx = raw(); fx.schwab.cashAccounts.cash_accounts[0].currency = "HKD";
  fx.schwab.performance.report.cash_accounts[0].currency.code = 'HKD';
  assert.throws(() => normalizeRead(fx, D, selectBenchmark(benchmarkCache, D)), /NON_USD_MOVEMENT/);
});

test("reader allows only fixed GET routes and proves two identical reads", async () => {
  const fixtures = raw();
  const response = (url, value) => {const r=new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;};
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++;
    if (url.endsWith("/oauth2/token")) return response(url, { access_token: "x".repeat(30), token_type: "bearer" });
    if (url.endsWith("/portfolios.json")) return response(url, { portfolios: [
      { id: 936249, name: "Schwab-HK", currency_code: "USD" }, { id: 1350094, name: "Webull", currency_code: "USD" },
    ] });
    const account = url.includes("936249") || url.includes("142251") ? "schwab" : "webull";
    if (url.includes("/performance?")) return response(url, new URL(url).searchParams.get("end_date") === D ? fixtures[account].performance : fixtures[account].previousPerformance);
    if (url.includes("/holdings?")) return response(url, fixtures[account].holdings);
    if (url.includes("/cash_accounts.json") && !url.includes("cash_account_transactions")) return response(url, fixtures[account].cashAccounts);
    if (url.includes("cash_account_transactions")) return response(url, Object.values(fixtures[account].cashTransactions)[0]);
    if (url.includes("trades.json")) return response(url, fixtures[account].trades);
    throw new Error(`unexpected ${init.method} ${url}`);
  };
  const reader = new SharesightCloudReader({ clientId: "id", clientSecret: "secret", fetchImpl });
  const result = await reader.readStable(D, selectBenchmark(benchmarkCache, D));
  assert.equal(result.targetDate, D);
  assert.equal(calls, 30);
  assert.equal(result.managementInput.historyComplete, true);
});

test('reader conditionally obtains Schwab as-of history and reuses the existing Webull history route', async () => {
  for (const extraAccount of ['schwab', 'webull']) {
    const fixtures = closedCatalogFixture(extraAccount), historyCalls = { schwab: 0, webull: 0 };
    const response = (url, value) => {
      const r = new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
      Object.defineProperty(r, 'url', { value: url }); return r;
    };
    const fetchImpl = async (url, init) => {
      if (url.endsWith('/oauth2/token')) return response(url, { access_token: 'x'.repeat(30), token_type: 'bearer' });
      assert.equal(init.method, 'GET');
      if (url.endsWith('/portfolios.json')) return response(url, { portfolios: [
        { id: 936249, name: 'Schwab-HK', currency_code: 'USD' }, { id: 1350094, name: 'Webull', currency_code: 'USD' },
      ] });
      const account = url.includes('936249') || url.includes('142251') ? 'schwab' : 'webull';
      const p = fixtures[account], params = new URL(url).searchParams;
      if (url.includes('/performance?')) return response(url, params.get('include_sales') === 'true'
        ? p.terminalPerformance : params.get('end_date') === D ? p.performance : p.previousPerformance);
      if (url.includes('/holdings?')) return response(url, p.holdings);
      if (url.includes('/cash_accounts.json')) return response(url, p.cashAccounts);
      if (url.includes('cash_account_transactions')) return response(url, Object.values(p.cashTransactions)[0]);
      if (url.includes('trades.json')) {
        assert.equal(params.get('end_date'), D);
        if (params.has('start_date')) return response(url, p.trades);
        historyCalls[account]++;
        return response(url, p.holdingHistory || p.trades);
      }
      assert.fail('unexpected fixed source route');
    };
    const reader = new SharesightCloudReader({ clientId: 'id', clientSecret: 'secret', fetchImpl });
    const result = await reader.readStable(D, selectBenchmark(benchmarkCache, D));
    assert.equal(result.targetDate, D);
    assert.equal(historyCalls.webull, 2);
    assert.equal(historyCalls.schwab, extraAccount === 'schwab' ? 2 : 0);
  }
});

test("cloud producer accepts the real updated and no-op writer contracts", () => {
  assert.equal(verifyWriterOutcome("a".repeat(64), "b".repeat(64),
    "ok 2026-09-24 points=56 status-as-of=2026-09-24 provisional", "2026-09-24"), "updated");
  assert.equal(verifyWriterOutcome("a".repeat(64), "a".repeat(64), "no-op 2026-09-24", "2026-09-24"), "no-op");
  assert.throws(() => verifyWriterOutcome("a".repeat(64), "b".repeat(64),
    "no-op 2026-09-24", "2026-09-24"), /FEE_CLOUD_WRITER_OUTCOME/);
  assert.equal(verifyWriterOutcome("a".repeat(64), "b".repeat(64),
    "no-op 2026-09-28", "2026-09-28", true), "updated");
});

test("cloud producer reports unresolved cash before the generic receipt gate", () => {
  assert.doesNotThrow(() => assertCandidateReceiptable({ flowsUnresolved: [] }));
  assert.throws(() => assertCandidateReceiptable({ flowsUnresolved: [{ id: "review" }] }),
    /FEE_CLOUD_UNRESOLVED_FLOW/);
});

test("cloud producer retries one transient stable-read failure only", async () => {
  let calls = 0, sleeps = 0;
  const reader = { readStable: async () => {
    calls++;
    if (calls === 1) throw new Error("FEE_CLOUD_SOURCE_UNSTABLE");
    return { targetDate: D };
  } };
  const result = await readStableWithRetry(reader, D, {}, { delayMs: 0, sleep: async () => { sleeps++; } });
  assert.deepEqual(result, { input: { targetDate: D }, retryCount: 1 });
  assert.equal(sleeps, 1);
  const permanent = { readStable: async () => { throw new Error("FEE_CLOUD_IDENTITY"); } };
  await assert.rejects(readStableWithRetry(permanent, D, {}, { delayMs: 0 }), /FEE_CLOUD_IDENTITY/);
});

test("cloud producer retries one transient economic-source stability failure only", async () => {
  let calls = 0, sleeps = 0;
  const result = await fetchEconomicWithRetry(async () => {
    calls++;
    if (calls === 1) throw new SourceFetchError("SOURCE_CHANGED");
    return { envelopeVersion: 4 };
  }, { delayMs: 0, sleep: async () => { sleeps++; } });
  assert.deepEqual(result, { economic: { envelopeVersion: 4 }, retryCount: 1 });
  assert.equal(sleeps, 1);
  await assert.rejects(fetchEconomicWithRetry(async () => {
    throw new SourceFetchError("SOURCE_IDENTITY");
  }, { delayMs: 0 }), /SOURCE_IDENTITY/);
});

test("cloud producer bridges only a contiguous weekend before the next market session", () => {
  assert.deepEqual(weekendGapDates([{ d: "2026-09-25" }], "2026-09-28"),
    ["2026-09-26", "2026-09-27"]);
  assert.deepEqual(weekendGapDates([{ d: "2026-09-27" }], "2026-09-28"), []);
  assert.throws(() => weekendGapDates([{ d: "2026-09-25" }], "2026-09-29"), /WEEKEND_GAP/);
});

test("cloud workflow uses main-bound Google OIDC instead of stored Sharesight secrets", () => {
  const workflow = fs.readFileSync(new URL("../.github/workflows/fee-cloud-producer.yml", import.meta.url), "utf8");
  assert.match(workflow, /cron: '30,40,55 3 \* \* 2-6'/,
    "the first cloud attempt must be 11:30 HKT with independent early retries");
  assert.match(workflow, /cron: '20,50 4 \* \* 2-6'/,
    "the early recovery window must continue through 12:50 HKT");
  assert.match(workflow, /permissions:\n  contents: read\n  id-token: write/);
  assert.match(workflow, /google-github-actions\/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093/);
  assert.match(workflow, /workloadIdentityPools\/fee-console-github\/providers\/fee-console-main/);
  assert.match(workflow, /service_account: fee-cloud-producer@family-portfolio-gateway\.iam\.gserviceaccount\.com/);
  assert.match(workflow, /google-github-actions\/get-secretmanager-secrets@bc9c54b29fdffb8a47776820a7d26e77b379d262/);
  assert.match(workflow, /sharesight-broker-sync-client-id\/1/);
  assert.match(workflow, /sharesight-broker-sync-client-secret\/1/);
  assert.match(workflow, /steps\.sharesight_credentials\.outputs\.client_id/);
  assert.match(workflow, /steps\.sharesight_credentials\.outputs\.client_secret/);
  assert.doesNotMatch(workflow, /secrets\.FEE_CLOUD_SHARESIGHT_CLIENT_/);
});


test('normalized dividend legs use confirmed payout economics and retain the posting-date gate', () => {
  const fixture=raw(),key='webull.dividend:12345678:GOOG:2026-09-22:900';
  fixture.webull.cashTransactions[90250].cash_account_transactions=[
    {id:901,cash_account_id:90250,date_time:D+'T04:00:00Z',amount:70,balance:400.4,cash_account_transaction_type:{name:'DEPOSIT'},description:`GOOG dividend: gross100.00 WHT30.00 net70.00; fee0.40 separately. INTERNAL_DIVIDEND_CASH, not external funding. Notice; ledger date unverified. key=${key}:net`},
    {id:902,cash_account_id:90250,date_time:D+'T04:00:00Z',amount:-0.4,balance:400,cash_account_transaction_type:{name:'FEE'},description:`GOOG dividend collection fee: gross100.00 x0.4%, min0.30, rounded0.40. NOT WHT. Official Webull schedule + exact net69.60 cash match; rule-authorized. key=${key}:fee`},
  ];
  fixture.webull.incomePayouts={900:{id:900,portfolio_id:1350094,holding_id:4,symbol:'GOOG',paid_on:'2026-09-22',currency:'USD',confirmed:true,state:'confirmed',non_taxable:false,tax_credit:0,gross_amount:100,resident_withholding_tax:30,amount:70}};
  fixture.webull.previousPerformance.report.cash_accounts[0].value=330.4;
  let result=normalizeRead(fixture,D,selectBenchmark(benchmarkCache,D));
  assert.equal(result.flows.filter(f=>f.evidence==='internal_income_pending_date').length,2);
  fixture.webull.incomeDateEvidence={[key]:{cashDate:D,verified:true,authority:'broker-cash-ledger',sourceRef:'synthetic ledger'}};
  result=normalizeRead(fixture,D,selectBenchmark(benchmarkCache,D));
  assert.equal(result.flows.filter(f=>f.evidence==='internal_income').length,2);
  fixture.webull.incomePayouts[900].portfolio_id=936249;
  result=normalizeRead(fixture,D,selectBenchmark(benchmarkCache,D));
  assert.equal(result.flows.some(f=>f.evidence==='internal_income'),false);
});

// Execute the actual trusted-workflow shell branch and actual validator CLI.
// Only the clock and git-candidate enumeration are fixed; no financial sources.
function scheduledReceiptDecision(iso, event = "schedule", receipt = null, {recentCandidate = false, candidateCount = 0} = {}) {
  const workflow = fs.readFileSync(new URL("../.github/workflows/promote-fee-data.yml", import.meta.url), "utf8");
  const start = workflow.indexOf("          if (( ${#candidates[@]} == 0 )); then");
  const end = workflow.indexOf("          if (( ${#candidates[@]} != 1 )); then", start);
  assert.ok(start >= 0 && end > start);
  const day = value => new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date(value));
  const shiftDay = (value, days) => {const date = new Date(value + "T00:00:00Z");date.setUTCDate(date.getUTCDate() + days);return date.toISOString().slice(0,10);};
  const hkt = day(iso), weekday = new Intl.DateTimeFormat("en-US", {timeZone: "Asia/Hong_Kong", weekday: "short"}).format(new Date(iso));
  const weekdayNumber = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(weekday) + 1;
  const cycleStart = shiftDay(hkt, -((weekdayNumber + 1) % 7));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fee-watchdog-test-"));
  try {
    const data = Buffer.from('{"synthetic":true}'), hash = createHash("sha256").update(data).digest("hex");
    fs.writeFileSync(path.join(directory, "data.json"), data);
    let checkedDay = "";
    if (receipt) {
      const checkedAt = receipt.checkedAt || `${receipt.date}T06:00:00+08:00`;
      try { checkedDay = day(checkedAt); } catch {}
      const targetDate = receipt.targetDate || shiftDay(checkedDay || hkt, -1);
      const value = {schema: receipt.valid === false ? "invalid" : HEALTH_SCHEMA, checkedAt, targetDate,
        sourceDates: receipt.sourceDates || {schwab: targetDate, webull: targetDate, benchmark: targetDate},
        outcome: receipt.outcome || "no-op", dataSha256: receipt.badHash ? "a".repeat(64) : hash,
        errorCode: receipt.outcome === "failed" ? "SHARESIGHT_UNSTABLE" : null};
      fs.writeFileSync(path.join(directory, "fee-data-health.json"), JSON.stringify(value));
    }
    const clock = path.join(directory, "clock.mjs");
    fs.writeFileSync(clock, `const OriginalDate=Date, now=OriginalDate.parse(process.env.TEST_NOW);globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};`);
    const script = `set -euo pipefail
candidates=(${candidateCount ? "verified-candidate" : ""})
recent_unpromoted_candidate=${recentCandidate}
date() {
  [[ "$TZ" == Asia/Hong_Kong ]] || return 1
  if [[ "$*" == '+%u' ]]; then echo "$TEST_WEEKDAY";
  elif [[ "$*" == *'last Saturday'* ]]; then echo "$TEST_CYCLE_START";
  elif [[ "$*" == *'-d '* ]]; then [[ -n "$TEST_RECEIPT_DATE" ]] && echo "$TEST_RECEIPT_DATE";
  else echo "$TEST_TODAY"; fi
}
jq() { "$TEST_NODE" -e 'const fs=require("fs"),value=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));console.log(value[process.argv[1].includes("checkedAt")?"checkedAt":"outcome"]||"");' "$2" "$3"; }
node() { echo "receipt-validation $*" >&2; "$TEST_NODE" --import "$TEST_CLOCK" "$TEST_VALIDATOR" "\${@:2}"; }
${workflow.slice(start, end)}
echo candidate-path`;
    const result = spawnSync("bash", ["-c", script], {cwd: directory, encoding: "utf8", env: {...process.env,
      TZ: "America/Los_Angeles", GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: path.join(directory, "output"), TEST_NOW: iso,
      TEST_TODAY: hkt, TEST_WEEKDAY: String(weekdayNumber), TEST_CYCLE_START: cycleStart, TEST_RECEIPT_DATE: checkedDay,
      TEST_NODE: process.execPath, TEST_CLOCK: clock, TEST_VALIDATOR: fileURLToPath(new URL("./fee-data-health.mjs", import.meta.url))}});
    return {...result, output: fs.existsSync(path.join(directory, "output")) ? fs.readFileSync(path.join(directory, "output"), "utf8") : ""};
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
}

test("scheduled watchdog skips only Hong Kong non-production Sun/Mon with no candidate", () => {
  for (const iso of ["2026-10-04T11:06:24Z", "2026-10-04T16:00:00Z", "2026-10-05T07:45:00Z"]) {
    const result = scheduledReceiptDecision(iso, "schedule", {date: "2026-10-03", valid: true});
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No producer is scheduled today/);
    assert.equal(result.output, "sha=\n");
    assert.match(result.stderr, /receipt-validation/);
  }
});

test("all Hong Kong Tue-Sat production days still fail without a verified same-day receipt", () => {
  for (const iso of ["2026-10-05T16:00:00Z", "2026-10-06T05:15:00Z", "2026-10-07T05:15:00Z", "2026-10-08T05:15:00Z", "2026-10-09T05:15:00Z", "2026-10-10T07:45:00Z"]) {
    const result = scheduledReceiptDecision(iso);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No verified Codex fee-data producer receipt exists for today/);
    assert.equal(result.output, "");
  }
});

test("same-day validation and manual/event receipt protections remain enforced", () => {
  for (const event of ["workflow_dispatch", "workflow_run"]) {
    const missing = scheduledReceiptDecision("2026-10-04T11:06:24Z", event);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /No verified Codex fee-data producer receipt/);
  }
  const valid = scheduledReceiptDecision("2026-10-06T05:15:00Z", "schedule", {date: "2026-10-06", valid: true});
  assert.equal(valid.status, 0);
  assert.match(valid.stderr, /receipt-validation/);
  assert.match(valid.stdout, /verified producer receipt/);
  for (const receipt of [{date: "2026-10-05", valid: true}, {date: "2026-10-06", valid: false}]) {
    assert.equal(scheduledReceiptDecision("2026-10-06T05:15:00Z", "schedule", receipt).status, 1);
  }
});


test("non-production no-op cannot hide recent rejected candidates or an invalid published receipt", () => {
  for (const [receipt, options] of [[null, {}], [{date: "2026-10-03", valid: false}, {}], [{date: "2026-10-03", valid: true}, {recentCandidate: true}]]) {
    const result = scheduledReceiptDecision("2026-10-04T11:06:24Z", "schedule", receipt, options);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Non-production-day no-op refused/);
    assert.equal(result.output, "");
  }
  const candidate = scheduledReceiptDecision("2026-10-04T11:06:24Z", "schedule", null, {candidateCount: 1});
  assert.equal(candidate.status, 0);
  assert.equal(candidate.stdout, "candidate-path\n");
  assert.doesNotMatch(candidate.stderr, /receipt-validation/);
  assert.equal(candidate.output, "");
});

test("recent outstanding branch detection separates rejected attempts from promoted and old branches", () => {
  const workflow = fs.readFileSync(new URL("../.github/workflows/promote-fee-data.yml", import.meta.url), "utf8");
  const start = workflow.indexOf("            # A rejected recent outstanding candidate");
  const end = workflow.indexOf('            if [[ ! "$branch_name"', start);
  assert.ok(start > 0 && end > start);
  for (const [promoted, timestamp, expected] of [[false, 100, "true"], [false, 99, "false"], [true, 101, "false"]]) {
    const result = spawnSync("bash", ["-c", `set -euo pipefail
recent_unpromoted_candidate=false
candidate_ref=origin/codex/fee-daily-20261002-abcdef
cutoff_epoch=100
git() { if [[ "$1" == merge-base ]]; then return ${promoted ? 0 : 1}; else echo ${timestamp}; fi; }
${workflow.slice(start, end)}
echo "$recent_unpromoted_candidate"`], {encoding: "utf8"});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected);
  }
});


test("real validator accepts the observed Monday 49-hour receipt only in the scheduled off-day branch", () => {
  const receipt = {checkedAt: "2026-10-03T10:38:26.828Z", targetDate: "2026-10-02"};
  const iso = "2026-10-05T12:16:40.904Z", result = scheduledReceiptDecision(iso, "schedule", receipt);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /health ok 2026-10-02 no-op/);
  assert.match(result.stderr, /--max-age-hours=72/);
  assert.equal(result.output, "sha=\n");
  const health = {schema: HEALTH_SCHEMA, checkedAt: receipt.checkedAt, targetDate: receipt.targetDate, sourceDates: {schwab: receipt.targetDate, webull: receipt.targetDate, benchmark: receipt.targetDate}, outcome: "no-op", dataSha256: "a".repeat(64), errorCode: null};
  assert.deepEqual(validateHealth(health, {now: new Date(iso)}), ["health receipt age"]);
  for (const event of ["workflow_dispatch", "workflow_run"]) {
    const strict = scheduledReceiptDecision(iso, event, receipt);
    assert.equal(strict.status, 1);
    assert.doesNotMatch(strict.stderr, /--max-age-hours=72/);
  }
});

test("latest Saturday cycle is mandatory even when a Friday or older receipt is within 72 hours", () => {
  for (const checkedAt of ["2026-10-02T15:59:59.999Z", "2026-09-26T10:38:26.828Z"]) {
    const result = scheduledReceiptDecision("2026-10-05T07:45:00Z", "schedule", {checkedAt});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /latest production cycle/);
  }
  const failed = scheduledReceiptDecision("2026-10-05T07:45:00Z", "schedule", {date: "2026-10-03", outcome: "failed"});
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /latest production cycle/);
  // A real later successful receipt may resolve the cycle; do not invent one.
  assert.equal(scheduledReceiptDecision("2026-10-05T07:45:00Z", "schedule", {date: "2026-10-05", outcome: "updated"}).status, 0);
});

test("earliest Saturday receipt survives late Monday but Tuesday HKT restores strict production freshness", () => {
  const receipt = {checkedAt: "2026-10-02T16:00:00.000Z", targetDate: "2026-10-01"};
  const monday = scheduledReceiptDecision("2026-10-05T15:59:59.999Z", "schedule", receipt);
  assert.equal(monday.status, 0, monday.stderr);
  assert.match(monday.stderr, /--max-age-hours=72/);
  const tuesday = scheduledReceiptDecision("2026-10-05T16:00:00.000Z", "schedule", receipt);
  assert.equal(tuesday.status, 1);
  assert.doesNotMatch(tuesday.stderr, /--max-age-hours=72/);
  // UTC Sunday 16:00 is already HKT Monday; UTC Monday 16:00 is HKT Tuesday.
  assert.equal(scheduledReceiptDecision("2026-10-04T16:00:00Z", "schedule", receipt).status, 0);
});

test("off-day real CLI still blocks corrupt structure, failed hash, future time and source-date mismatch", () => {
  const iso = "2026-10-05T12:16:40.904Z";
  for (const receipt of [{date: "2026-10-03", valid: false}, {date: "2026-10-03", badHash: true},
    {checkedAt: "2026-10-05T12:22:40.904Z"}, {date: "2026-10-03", sourceDates: {schwab: "2026-10-03", webull: "2026-10-02", benchmark: "2026-10-02"}}]) {
    const result = scheduledReceiptDecision(iso, "schedule", receipt);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /latest production cycle/);
  }
});

test("real validator has an inclusive 72-hour cap; default 36-hour validation stays unchanged", () => {
  const health = {schema: HEALTH_SCHEMA, checkedAt: "2026-10-02T16:00:00.000Z", targetDate: "2026-10-01", sourceDates: {schwab: "2026-10-01", webull: "2026-10-01", benchmark: "2026-10-01"}, outcome: "no-op", dataSha256: "a".repeat(64), errorCode: null};
  assert.deepEqual(validateHealth(health, {now: new Date("2026-10-05T16:00:00.000Z"), maxAgeHours: 72}), []);
  assert.deepEqual(validateHealth(health, {now: new Date("2026-10-05T16:00:00.001Z"), maxAgeHours: 72}), ["health receipt age"]);
  assert.deepEqual(validateHealth(health, {now: new Date("2026-10-05T16:00:00.000Z")}), ["health receipt age"]);
});


test('producer diagnostics expose fixed stages and exception categories only', () => {
  const hidden = 'account PRIVATE_ACCOUNT amount 987654.32 /private/path https://secret.example/token';
  for (const [error, category] of [[new TypeError(hidden), 'TYPE'], [new RangeError(hidden), 'RANGE'],
    [new SyntaxError(hidden), 'SYNTAX'], [new ReferenceError(hidden), 'REFERENCE'], [new Error(hidden), 'UNKNOWN']]) {
    assert.equal(producerFailureCode(error, 'SOURCE_READ'), `FEE_CLOUD_STAGE_SOURCE_READ_${category}`);
    assert.equal(producerFailureCode(error, hidden), `FEE_CLOUD_STAGE_UNKNOWN_${category}`);
  }
  assert.equal(producerFailureCode(Object.assign(new Error(hidden), {code:'ENOENT'}), 'PREPARE'), 'FEE_CLOUD_STAGE_PREPARE_SYSTEM_ENOENT');
  assert.equal(producerFailureCode(Object.assign(new Error(hidden), {code:hidden}), 'PREPARE'), 'FEE_CLOUD_STAGE_PREPARE_UNKNOWN');
  assert.equal(producerFailureCode(new Error('FEE_CLOUD_CASH_BALANCE_STALE'), 'SOURCE_READ'), 'FEE_CLOUD_CASH_BALANCE_STALE');
  assert.equal(producerFailureCode(new Error('FEE_CLOUD_' + 'A'.repeat(81)), 'SOURCE_READ'), 'FEE_CLOUD_STAGE_SOURCE_READ_UNKNOWN');
});

test('real producer source exception reports its stage and cleans up without any network', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-diagnostic-')); fs.chmodSync(dir,0o700);
  const cache=path.join(dir,'benchmark.json');fs.writeFileSync(cache,JSON.stringify(benchmarkCache));
  let cleaned=false, reads=0;
  try {
    await assert.rejects(produce({cli:{'benchmark-file':cache,'out-dir':dir,'target-date':D},
      fetchEconomic:async()=>({envelopeVersion:4,cleanup(){cleaned=true;}}),
      reader:{async readStable(){reads++;throw new TypeError('private account amount URL /path');}}}),
      {message:'FEE_CLOUD_STAGE_SOURCE_READ_TYPE'});
    assert.equal(reads,1);assert.equal(cleaned,true);
    assert.equal(fs.existsSync(path.join(dir,'data.json')),false);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});


function netProceedsFixture() {
  const order='ABCDEF0123456789ABCD';
  const row={id:77,amount:99.75,balance:400,cash_account_id:90250,date_time:`${D}T00:00:00.000Z`,
    cash_account_transaction_type:{name:'DEPOSIT'},trade_id:null,holding_id:null,payout_id:null,foreign_identifier:null,
    description:`Webull GOOG SELL net proceeds; NOT external funding. Order ${order}; Sharesight trade 222; ${D}; gross USD100.00 less fee USD0.25 = net USD99.75. Fee included, no separate fee debit.`};
  const trade={id:222,portfolio_id:1350094,holding_id:4,transaction_date:D,state:'confirmed',description_code:'SELL',
    instrument:{code:'GOOG',currency_code:'USD'},quantity:10,price:10,price_currency_code:null,brokerage:0.25,brokerage_currency_code:'USD',value:-99.75,
    comments:`Webull GOOG SELL 10 shares on ${D} at USD10.00; order ${order}. Commission USD0; actual fee USD0.25 recorded in trade fees. Gross USD100.00; net USD99.75.`};
  return {account:'webull',row,movement:row.amount,targetDate:D,trades:[trade]};
}

test('strict net-proceeds evidence maps a unique confirmed fee-inclusive sell to internal trade', () => {
  const f=netProceedsFixture();assert.equal(isControlledWebullNetProceeds(f),true);
  const source=raw();source.webull.cashTransactions[90250].cash_account_transactions=[f.row];source.webull.trades.trades=f.trades;
  source.webull.previousPerformance.report.cash_accounts[0].value=300.25;
  const result=normalizeRead(source,D,selectBenchmark(benchmarkCache,D));
  assert.equal(result.flows.find(r=>r.acct==='webull').evidence,'internal_trade');
  f.trades[0].price_currency_code='USD';assert.equal(isControlledWebullNetProceeds(f),true);
});

test('net-proceeds mapping rejects mismatched identity, money, currency, links and duplicates', () => {
  const changes=[f=>f.account='schwab',f=>f.row.cash_account_transaction_type.name='WITHDRAWAL',
    f=>f.row.payout_id=7,f=>f.movement=-99.75,f=>f.movement=99.76,f=>f.targetDate='2026-09-22',
    f=>f.row.description=f.row.description.replace('GOOG','OTHER'),f=>f.row.description=f.row.description.replace('trade 222','trade 223'),
    f=>f.row.description=f.row.description.replace('100.00','100.01'),f=>f.row.description=f.row.description.replace('fee USD0.25','fee USD0.26'),
    f=>f.row.description='bare deposit',f=>f.trades[0].portfolio_id=936249,f=>f.trades[0].state='pending',
    f=>f.trades[0].description_code='BUY',f=>f.trades[0].transaction_date='2026-09-22',
    f=>f.trades[0].instrument.code='OTHER',f=>f.trades[0].instrument.currency_code='HKD',
    f=>f.trades[0].price_currency_code='HKD',f=>f.trades[0].brokerage_currency_code='HKD',
    f=>f.trades[0].quantity=11,f=>f.trades[0].price=11,f=>f.trades[0].brokerage=0.24,
    f=>f.trades[0].value=-100,f=>f.trades[0].value=99.75,f=>f.row.trade_id=223,f=>f.row.holding_id=5,
    f=>f.trades[0].comments=f.trades[0].comments.replace('ABCDEF0123456789ABCD','ABCDEF0123456789ABCE'),
    f=>f.trades[0].comments=f.trades[0].comments.replace('Commission USD0','Commission USD1'),
    f=>f.trades.push({...f.trades[0]}),f=>f.trades.push({...f.trades[0],id:223})];
  for(const change of changes){const f=netProceedsFixture();change(f);assert.equal(isControlledWebullNetProceeds(f),false,change.toString());}
});
