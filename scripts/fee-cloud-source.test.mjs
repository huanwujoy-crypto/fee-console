import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, createCipheriv } from "node:crypto";
import { fileURLToPath } from "node:url";
import { HEALTH_SCHEMA, validateHealth } from "./fee-data-health.mjs";
import test from "node:test";
import { isControlledWebullNetProceeds, expectedTargetDate, previousCalendarDate, latestCommonBenchmarkDate, normalizeRead as normalizeCloudRead, parseTradeJson, selectBenchmark, SharesightCloudReader } from "./fee-cloud-source.mjs";
import { assertCandidateReceiptable, buildUnresolvedFlowDiagnostic, validateUnresolvedFlowDiagnostic, safeProducerFailureSummary, UNRESOLVED_FLOW_DIAGNOSTIC_PREFIX, fetchEconomicWithRetry, readStableWithRetry, verifyWriterOutcome, weekendGapDates, writerFailureCode, producerFailureCode, styleRecoveryLockDigest, matchesPrivateStyleRecoveryLock, verifyStyleRecoveryFirstHeld, produce, isPublishedTarget, isEarlierCandidate, readPublicationState, publishedPreflight } from "./fee-cloud-producer.mjs";
import { boundedJson, BoundedJsonError } from './fee-http-json.mjs';
import { SourceFetchError } from "./fee-economic-source.mjs";
import { checkCashLedger } from './daily-core.mjs';
import { reconcileFlows, flowId } from './daily-core.mjs';
import { buildFeeCalculationReceipt } from './fee-receipt-core.mjs';
import { createFundInvestorCore } from './fund-investor-core.mjs';
import { buildWriterFailureDiagnostic, validateWriterFailureDiagnostic, WRITER_DIAGNOSTIC_PREFIX } from './fee-cloud-producer.mjs';
import { reportFailureCode } from './fee-report-producer.mjs';
import { CLOUD_ACCOUNTS, parseSourceJson } from './fee-cloud-source.mjs';
import { reportAddDays } from './fee-report-period.mjs';

const D = "2026-09-23";
// Legacy synthetic cases already state an independent opening in their prior
// fixture. Give those fixtures an explicit predecessor record. New ledger tests
// supply their own frozen history and never derive it from target or closing.
function fixtureCashHistory(p, cashId) {
  if (Object.hasOwn(p, 'cashLedgerHistory')) return p.cashLedgerHistory?.[cashId];
  const previous = p.previousPerformance?.report?.cash_accounts?.find(row => row.id === Number(cashId));
  return { cash_account_transactions: previous ? [{ id: 900000 + Number(cashId), cash_account_id: Number(cashId),
    date_time: `${previousCalendarDate(D)}T00:00:00.000Z`, amount: 0, balance: previous.value,
    cash_account_transaction_type: { name: 'FEE' } }, ...(p.cashTransactions[cashId]?.cash_account_transactions || [])] : [] };
}
// Synthetic direct inputs follow the same raw-JSON path as the cloud transport.
const wireInput = input => Object.fromEntries(Object.entries(input).map(([account, p]) => {
  const copy = { ...p };
  for (const key of ['trades', 'holdingHistory', 'managementTrades', 'performance', 'previousPerformance', 'terminalPerformance', 'cashAccounts', 'previousCashAccounts']) {
    if (p[key]) copy[key] = parseTradeJson(JSON.stringify(p[key]));
  }
  copy.cashTransactions = Object.fromEntries(Object.entries(p.cashTransactions).map(([key, value]) =>
    [key, parseTradeJson(JSON.stringify(value))]));
  copy.cashLedgerHistory = p.cashLedgerHistory === null ? null : Object.fromEntries(
    (Object.hasOwn(p, 'cashLedgerHistory') ? Object.entries(p.cashLedgerHistory || {})
      : (p.cashAccounts?.cash_accounts || []).filter(row => row.currency === 'USD').map(row => [row.id, fixtureCashHistory(p, row.id)]))
      .map(([key, value]) => [key, value === undefined ? undefined : parseTradeJson(JSON.stringify(value))]));
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
test('writer diagnostics distinguish exact daily failures from process termination without private text', () => {
  const hidden='PRIVATE_CANARY amount=123456.78 account=opaque token=secret /private/path \u001b[31m';
  const fixed=['FEE_REPORT_METADATA_INVALID','FEE_REPORT_LOCKED_MONTH_CHANGED','MANAGEMENT_EXEMPTION_INVALID','MANAGEMENT_EXEMPTION_INPUT_REQUIRED','SOURCE_FILE_CHANGED'];
  for(const literal of fixed) for(const preflight of [false,true]) {
    const category=literal.replace(/^FEE_/,''),code='FEE_CLOUD_WRITER_'+(preflight?'PREFLIGHT_':'')+category;
    assert.equal(writerFailureCode('error: '+literal+' — nothing written\n',preflight,{status:1}),code);
    assert.equal(reportFailureCode(Error(producerFailureCode(Error(code),'WRITER'))),code);
    assert.equal(safeProducerFailureSummary(code+'\n').code,code);
    for(const text of ['error: '+literal+'_'+hidden+' — nothing written','error: '+literal+' — nothing written '+hidden])
      assert.equal(writerFailureCode(text,preflight),'FEE_CLOUD_WRITER_'+(preflight?'PREFLIGHT_':'')+'UNKNOWN');
  }
  const known='error: FEE_REPORT_METADATA_INVALID — nothing written\n';
  for(const [result,category,termination] of [
    [{error:{code:'ETIMEDOUT',message:hidden,path:hidden,spawnargs:[hidden]},signal:'SIGTERM',status:null},'PROCESS_TIMEOUT','TIMEOUT'],
    [{error:{code:hidden,message:hidden},status:null},'PROCESS_ERROR','SPAWN_ERROR'],
    [{signal:hidden,status:null},'PROCESS_SIGNAL','SIGNAL'],
    [{status:1},'REPORT_METADATA_INVALID','EXIT'],
  ]) {
    const code=writerFailureCode(known,false,result);
    assert.equal(code,'FEE_CLOUD_WRITER_'+category);
    const diagnostic=buildWriterFailureDiagnostic({code,stage:'WRITER',termination});
    assert.equal(validateWriterFailureDiagnostic(diagnostic),true);
    assert.deepEqual(safeProducerFailureSummary(WRITER_DIAGNOSTIC_PREFIX+JSON.stringify(diagnostic)+'\n'+reportFailureCode(Error(code))+'\n'),{code,diagnostic});
    assert.equal(JSON.stringify(diagnostic).includes(hidden),false);
  }
  // Only a bounded class plus the Node stack shape is classified; none of its
  // message, path or frames are returned. These are real synthetic child exits.
  for(const [name,category] of [['TypeError','TYPE'],['ReferenceError','REFERENCE'],['SyntaxError','SYNTAX'],['RangeError','RANGE']]) {
    const result=spawnSync(process.execPath,['--eval',`throw new ${name}(${JSON.stringify(hidden)})`],{encoding:'utf8',env:{PATH:process.env.PATH}});
    assert.equal(result.status,1);
    const code=writerFailureCode(result.stderr,false,result);
    assert.equal(code,'FEE_CLOUD_WRITER_UNCAUGHT_'+category);
    assert.equal(safeProducerFailureSummary(reportFailureCode(Error(code))+'\n').code,code);
  }
  for(const [result,category] of [
    [spawnSync(process.execPath,['--eval','setInterval(()=>{},1000)'],{timeout:40,encoding:'utf8',env:{PATH:process.env.PATH}}),'PROCESS_TIMEOUT'],
    [spawnSync(process.execPath,['--eval',"process.kill(process.pid,'SIGTERM')"],{encoding:'utf8',env:{PATH:process.env.PATH}}),'PROCESS_SIGNAL'],
    [spawnSync('/nonexistent/PRIVATE_CANARY',[hidden],{encoding:'utf8',env:{PATH:process.env.PATH}}),'PROCESS_ERROR'],
  ]) assert.equal(writerFailureCode(result.stderr,false,result),'FEE_CLOUD_WRITER_'+category);
  // Text mentioning a process error or class is not native process/stack evidence.
  for(const stderr of ['ETIMEDOUT '+hidden,'TypeError: '+hidden,'error: unregistered first failure\nerror: '+hidden])
    assert.equal(writerFailureCode(stderr,false,{status:1}),'FEE_CLOUD_WRITER_UNKNOWN');
});
test('writer diagnostic projection rejects forged context, unknown fields, duplicate records and private suffixes', () => {
  const code='FEE_CLOUD_WRITER_REPORT_METADATA_INVALID',context={reportTarget:'2026-10-30',processingDate:'2026-10-29',processingIndex:2};
  const diagnostic=buildWriterFailureDiagnostic({code,stage:'WRITER',termination:'EXIT',context,targetDate:'2026-10-29'});
  assert.equal(validateWriterFailureDiagnostic(diagnostic),true);
  assert.deepEqual([diagnostic.reportTarget,diagnostic.processingDate,diagnostic.processingIndex],['2026-10-30','2026-10-29',2]);
  const unbound=buildWriterFailureDiagnostic({code,stage:'WRITER',termination:'EXIT',context,targetDate:'2026-10-30'});
  assert.deepEqual([unbound.reportTarget,unbound.processingDate,unbound.processingIndex],['unknown','unknown','unknown']);
  const line=value=>WRITER_DIAGNOSTIC_PREFIX+JSON.stringify(value),stderr=line(diagnostic)+'\n'+code+'\n';
  assert.deepEqual(safeProducerFailureSummary('PRIVATE_CANARY\n'+stderr),{code,diagnostic});
  for(const mutate of [v=>v.private='PRIVATE_CANARY',v=>v.code+='PRIVATE_CANARY',v=>v.stage='PRIVATE_CANARY',v=>v.stage='STYLE_PREFLIGHT',v=>v.termination='PRIVATE_CANARY',v=>v.termination='TIMEOUT',v=>v.reportTarget='PRIVATE_CANARY',v=>v.processingDate='2026-02-30',v=>v.processingDate='2026-10-31',v=>v.processingIndex=11,v=>v.processingIndex='unknown',v=>v.schema='PRIVATE_CANARY']) {
    const bad=structuredClone(diagnostic);mutate(bad);assert.equal(validateWriterFailureDiagnostic(bad),false);
    assert.deepEqual(safeProducerFailureSummary(line(bad)+'\n'+code+'\n'),{code,diagnostic:null});
  }
  for(const text of [line(diagnostic)+'\n'+stderr,'prefix '+stderr,line(diagnostic).replace('{','{"schema":"PRIVATE_CANARY",')+'\n'+code+'\n',UNRESOLVED_FLOW_DIAGNOSTIC_PREFIX+'{}\n'+stderr,stderr.replace(code+'\n','FEE_CLOUD_WRITER_UNKNOWN\n')])
    assert.equal(safeProducerFailureSummary(text).diagnostic,null);
});
test('private recovery lock digest binds every field and ignores only object key order', () => {
  const lock={schema:'synthetic',targetDate:D,proposalSha256:'a'.repeat(64),portfolioId:123,holdingId:456,ticker:'SYNTH',style:'growth',firstHeldOn:D,effectiveFrom:D};
  const digest=styleRecoveryLockDigest(lock);
  assert.match(digest,/^[a-f0-9]{64}$/);
  assert.equal(styleRecoveryLockDigest(Object.fromEntries(Object.entries(lock).reverse())),digest);
  for(const key of Object.keys(lock))assert.notEqual(styleRecoveryLockDigest({...lock,[key]:String(lock[key])+'changed'}),digest);
  assert.equal(matchesPrivateStyleRecoveryLock(lock,D),false);
  assert.equal(matchesPrivateStyleRecoveryLock({...lock,targetDate:'2020-01-01'},D),false);
  assert.equal(matchesPrivateStyleRecoveryLock(null,D),false);
});
test('scoped recovery first-held proof requires the same dated holding and complete confirmed source history', () => {
  const proposal={portfolioId:1350094,holdingId:123,ticker:'SYNTH',firstHeldOn:D,effectiveFrom:D};
  const input={targetDate:D,managementInput:{date:D,historyComplete:true,holdings:[{account:'webull',portfolioId:1350094,holdingId:123,ticker:'SYNTH',sourceDate:D}],trades:[{portfolioId:1350094,holdingId:123,type:'BUY',date:D,confirmed:true}]}};
  assert.doesNotThrow(()=>verifyStyleRecoveryFirstHeld(input,proposal));
  for(const mutate of [x=>x.managementInput.historyComplete=false,x=>x.managementInput.holdings[0].holdingId=456,x=>x.managementInput.holdings[0].sourceDate='2020-01-01',x=>x.managementInput.trades[0].date='2020-01-01',x=>x.managementInput.trades[0].date='2099-01-01',x=>x.managementInput.trades[0].confirmed=false,x=>x.managementInput.holdings[0].ticker='WRONG',x=>x.managementInput.trades=[]]){
    const copy=structuredClone(input);mutate(copy);assert.throws(()=>verifyStyleRecoveryFirstHeld(copy,proposal),/^Error: FEE_CLOUD_STYLE_PROPOSAL_FIRST_HELD$/);
  }
  assert.throws(()=>verifyStyleRecoveryFirstHeld(input,{...proposal,firstHeldOn:'2020-01-01'}),/FIRST_HELD/);
});

const benchmarkCache = { v: 1, benchmarks: {
  spy: {symbol:'SPY',currency:'USD',exchange:'NYSEArca',series: [{ d: "2026-09-22", p: 700 }, { d: D, p: 701, div: 1.5 }] },
  qqq: {symbol:'QQQ',currency:'USD',exchange:'NasdaqGS',series: [{ d: "2026-09-22", p: 600 }, { d: D, p: 602 }] },
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

test('enabled independent IB cannot rely on composite health or race an earlier pending candidate',async()=>{
  const state=publicationFixture();
  assert.equal((await publishedPreflight({cache:benchmarkCache,now:gateNow,ibEnabled:true,readState:async()=>state})).reason,'ib-verification-required');
  await assert.rejects(publishedPreflight({cache:benchmarkCache,now:gateNow,ibEnabled:true,attempts:1,readState:async()=>({...state,pending:true})}),/WAIT_TIMEOUT/);
  let calls=0;const result=await publishedPreflight({cache:benchmarkCache,now:gateNow,ibEnabled:true,attempts:2,delayMs:0,sleep:async()=>{},readState:async()=>{
    if(!calls++)return {...state,pending:true};return {...state,mainSha:'c'.repeat(40),finalMainSha:'c'.repeat(40)};
  }});assert.equal(result.outcome,'produce');assert.equal(calls,2);
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
  state.health.targetDate=D;
  assert.equal((await readPublicationState(D,`${D}T22:00:00Z`,request,{requireIb:true})).pending,true);
  state.health.targetDate='2026-09-22';
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
  const gate=workflow.slice(workflow.indexOf('  period:'),workflow.indexOf('  produce:'));
  const production=workflow.slice(workflow.indexOf('  produce:'));
  assert.match(production,/needs: period/);assert.match(production,/if:.*needs\.period\.outputs\.outcome == 'produce'/);
  assert.doesNotMatch(gate,/secrets\.|create-success|create-failure|FEE_DATA_KEY|SHARESIGHT/);
  assert.match(gate,/already-published/);assert.match(gate,/candidate-pending/);
  assert.ok(production.indexOf('Confirm the frozen period base')<production.indexOf('Exchange the trusted workflow identity'));
  assert.ok(production.indexOf('Read the independent benchmark cache')<production.indexOf('Exchange the trusted workflow identity'));
  assert.match(workflow,/permissions:\n  contents: read\n  id-token: write/);
  assert.match(workflow,/group: fee-cloud-producer\n  cancel-in-progress: false/);
  assert.match(production,/Remove private runtime files[\s\S]*if:.*always\(\)/);
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
    const cache={v:1,benchmarks:{spy: {symbol:'SPY',currency:'USD',exchange:'NYSEArca',series:[{d:cacheDate,p:100}]},qqq: {symbol:'QQQ',currency:'USD',exchange:'NasdaqGS',series:[{d:cacheDate,p:100}]}}};
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

function futureCatalogFixture(account = 'webull') {
  const fixture = closedCatalogFixture(account), p = fixture[account];
  p.holdings.holdings.at(-1).inception_date = '2026-09-24';
  p.holdingHistory.trades = p.holdingHistory.trades.filter(t => t.holding_id !== 700);
  p.terminalPerformance.report.start_date = '2026-09-22';
  p.terminalPerformance.report.holdings = p.terminalPerformance.report.holdings.filter(h => h.id !== 700);
  return fixture;
}

test('later catalog entries are not historical positions when dated reports and complete history agree', async () => {
  for (const account of ['schwab', 'webull']) {
    const baseline = normalizeRead(raw(), D, selectBenchmark(benchmarkCache, D));
    for (const explicitZero of [false, true]) {
      const input = futureCatalogFixture(account), p = input[account];
      if (explicitZero) p.terminalPerformance.report.holdings.push({ ...p.holdings.holdings.at(-1),
        quantity: 0, value: 0, number_of_unconfirmed_transactions: 0 });
      const result = normalizeRead(input, D, selectBenchmark(benchmarkCache, D));
      for (const key of ['accounts', 'splits', 'styleInput', 'flows', 'acctCash', 'prevAcctCash'])
        assert.deepEqual(result[key], baseline[key]);
      assert.equal(result.styleInput.portfolios.flatMap(p => p.holdings).some(h => h.holdingId === 700), false);
      assert.notEqual(result.sourceFingerprint, baseline.sourceFingerprint);
    }
    const liveShape = await quantityLexemeReader(futureCatalogFixture(account)).readStable(D, selectBenchmark(benchmarkCache, D));
    assert.deepEqual(liveShape.accounts, baseline.accounts);
  }
});

test('future catalog exclusion cannot hide current positions, prior events or ambiguous inception', () => {
  const changes = [
    p => p.holdings.holdings.at(-1).inception_date = '2026-09-22',
    p => delete p.holdings.holdings.at(-1).inception_date,
    p => p.holdings.holdings.at(-1).inception_date = 'not-a-date',
    p => p.holdingHistory.trades.push({ id: 703, portfolio_id: 1350094, holding_id: 700,
      transaction_date: '2026-09-22', state: 'confirmed' }),
    p => p.holdingHistory.trades.push({ id: 703, portfolio_id: 1350094, holding_id: 700,
      transaction_date: D, state: 'confirmed' }),
    p => p.holdingHistory.trades.push({ id: 703, portfolio_id: 1350094, holding_id: 700,
      transaction_date: '2026-09-24', state: 'confirmed' }),
    p => p.performance.report.holdings.push({ ...p.holdings.holdings.at(-1), quantity: 3, value: 60 }),
  ];
  for (const change of changes) {
    const input = futureCatalogFixture(); change(input.webull);
    assert.throws(() => normalizeRead(input, D, selectBenchmark(benchmarkCache, D)),
      /HOLDING_(?:TERMINAL|CATALOG_DATE_CONFLICT|HISTORY_IDENTITY)|FEE_CLOUD_DATE/);
  }
});

test('future scope still rejects incomplete catalogs, terminal reports, histories and duplicate identities', () => {
  for (const key of ['holdings', 'terminalPerformance', 'holdingHistory']) {
    for (const mark of [p => p.links = {next: 'next'}, p => p.meta = {pagination: {next_page: 2}}, p => p.meta = {next_page: 2},
      p => p.restricted = true, p => p.limited = true, p => p.truncated = true, p => p.complete = false]) {
      const input = futureCatalogFixture(); mark(input.webull[key]);
      assert.throws(() => normalizeRead(input, D, selectBenchmark(benchmarkCache, D)), /SOURCE_INCOMPLETE/);
    }
  }
  const missing = futureCatalogFixture(); delete missing.webull.holdingHistory;
  assert.throws(() => normalizeRead(missing, D, selectBenchmark(benchmarkCache, D)), /HOLDING_HISTORY_REQUIRED/);
  const duplicate = futureCatalogFixture(); duplicate.webull.holdings.holdings.push({...duplicate.webull.holdings.holdings.at(-1)});
  assert.throws(() => normalizeRead(duplicate, D, selectBenchmark(benchmarkCache, D)), /SOURCE_DUPLICATE/);
});

test('future scope preserves dated identity, terminal-zero, NAV and cash reconciliation gates', () => {
  const changes = [
    p => p.terminalPerformance.report.portfolio_id = 999,
    p => p.terminalPerformance.report.end_date = '2026-09-24',
    p => p.terminalPerformance.report.holdings.pop(),
    p => p.terminalPerformance.report.holdings[0].instrument.id = 999,
    p => p.terminalPerformance.report.holdings[0].quantity += 1,
    p => p.terminalPerformance.report.value += 1,
    p => p.terminalPerformance.report.cash_accounts[0].value += 1,
    p => p.terminalPerformance.report.cash_accounts = [],
    p => p.terminalPerformance.report.holdings.push({...p.holdings.holdings.at(-1),quantity:1,value:0,number_of_unconfirmed_transactions:0}),
    p => p.terminalPerformance.report.holdings.push({...p.holdings.holdings.at(-1),quantity:0,value:1,number_of_unconfirmed_transactions:0}),
    p => p.terminalPerformance.report.holdings.push({...p.holdings.holdings.at(-1),quantity:0,value:0,number_of_unconfirmed_transactions:1}),
  ];
  for (const change of changes) {
    const input = futureCatalogFixture(); change(input.webull);
    assert.throws(() => normalizeRead(input, D, selectBenchmark(benchmarkCache, D)), /HOLDING_TERMINAL/);
  }
});

test('a later catalog entry never excuses another missing historical holding', () => {
  const input = closedCatalogFixture(), p = input.webull;
  p.holdings.holdings.push({ ...p.holdings.holdings.at(-1), id: 800, inception_date: '2026-09-24',
    instrument: syntheticInstrument(800, 'SYNTHF') });
  p.terminalPerformance.report.holdings = p.terminalPerformance.report.holdings.filter(h => h.id !== 700);
  assert.throws(() => normalizeRead(input, D, selectBenchmark(benchmarkCache, D)),
    /^Error: FEE_CLOUD_HOLDING_TERMINAL_COVERAGE_WEBULL_20260923_MISSING_ID$/);
});

test('coverage diagnostics reveal only fixed account/date/reason, never holding identity or money', () => {
  for (const account of ['schwab', 'webull']) for (const unknown of [false, true]) {
    const input = closedCatalogFixture(account), p = input[account];
    p.holdings.holdings.at(-1).instrument.code = 'SYNTH PRIVATE LABEL';
    p.terminalPerformance.report.holdings.pop();
    if (unknown) p.terminalPerformance.report.holdings.push({id: 987654321});
    let error; try {normalizeRead(input, D, selectBenchmark(benchmarkCache, D));} catch(e) {error=e;}
    assert.equal(error?.message, `FEE_CLOUD_HOLDING_TERMINAL_COVERAGE_${account.toUpperCase()}_20260923_${unknown?'UNKNOWN_ID':'MISSING_ID'}`);
    assert.equal(error.message.includes('987654321'), false);
    assert.equal(error.message.includes('PRIVATE'), false);
    assert.equal(producerFailureCode(error, 'SOURCE'), error.message);
  }
});

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

function quantityLexemeReader(fixtures, historyLexemes, dayLexemes = [], observeRequest = null) {
  const response = (url, value, lexemes) => {
    let body = JSON.stringify(value), index = 0;
    if (lexemes) body = body.replace(/"quantity":3/g, () => `"quantity":${lexemes[index++]}`);
    const r = new Response(body, { headers: { 'content-type': 'application/json' } });
    Object.defineProperty(r, 'url', { value: url }); return r;
  };
  const fetchImpl = async (url, init) => {
    observeRequest?.(url);
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
    if (url.includes('cash_account_transactions')) {
      const cashId = new URL(url).pathname.split('/')[4];
      return response(url, params.has('from') ? p.cashTransactions[cashId] : fixtureCashHistory(p, cashId));
    }
    if (url.includes('trades.json')) {
      return response(url, params.has('start_date') ? p.trades : (p.holdingHistory || p.trades),
        account === 'webull' ? (params.has('start_date') ? dayLexemes : historyLexemes) : undefined);
    }
    assert.fail('unexpected fixed source route');
  };
  return new SharesightCloudReader({ clientId: 'id', clientSecret: 'secret', fetchImpl });
}

test('an all-future catalog uses a valid target-bounded terminal query and retains only target cash', async () => {
  const input = futureCatalogFixture(), p = input.webull, requests = [];
  p.holdings.holdings = [p.holdings.holdings.at(-1)];
  p.performance.report.holdings = [];
  p.performance.report.value = 400;
  p.terminalPerformance.report.holdings = [];
  p.terminalPerformance.report.value = 400;
  p.terminalPerformance.report.start_date = D;
  const result = await quantityLexemeReader(input, undefined, [], url => requests.push(url))
    .readStable(D, selectBenchmark(benchmarkCache, D));
  const terminalRequests = requests.map(url => new URL(url)).filter(url =>
    url.pathname.includes('/1350094/performance') && url.searchParams.get('include_sales') === 'true');
  assert.equal(terminalRequests.length, 2);
  assert.ok(terminalRequests.every(url => url.searchParams.get('start_date') === D && url.searchParams.get('end_date') === D));
  assert.equal(result.styleInput.portfolios.find(p => p.account === 'webull').holdings.length, 0);
  assert.equal(result.accounts.webull, 400);
});

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
  const fixture = wireInput(closedCatalogFixture());
  fixture.webull.holdingHistory = JSON.parse(JSON.stringify(fixture.webull.holdingHistory));
  fixture.webull.terminalPerformance = JSON.parse(JSON.stringify(fixture.webull.terminalPerformance));
  assert.throws(() => normalizeCloudRead(fixture, D, selectBenchmark(benchmarkCache, D)),
    /HOLDING_TERMINAL_PRECISION/);
});

function frozenCashLedgerFixture() {
  const fixture = raw();
  for (const p of Object.values(fixture)) p.cashLedgerHistory = Object.fromEntries(
    p.cashAccounts.cash_accounts.map(row => [row.id, structuredClone(fixtureCashHistory(p, row.id))]));
  const p = fixture.schwab, cashId = 142251;
  const amounts = [-10, -20, -30, -40], balances = [490, 470, 440, 400];
  const target = amounts.map((amount, i) => ({ id: 200 + i, cash_account_id: cashId,
    date_time: `${D}T00:00:00.000Z`, amount, balance: balances[i], trade_id: 9 + i, holding_id: 2,
    payout_id: null, foreign_identifier: `synthetic-BUY-${i}`, description: `Buy trade synthetic ${i}`,
    cash_account_transaction_type: { name: 'Buy Trade' } }));
  p.cashTransactions[cashId] = { cash_account_transactions: structuredClone(target) };
  p.trades.trades = target.map(row => ({ id: row.trade_id, portfolio_id: 936249,
    transaction_date: D, state: 'confirmed' }));
  // Independently stated predecessor; it is not computed from any target row.
  p.cashLedgerHistory[cashId] = { cash_account_transactions: [{ id: 40, cash_account_id: cashId,
    date_time: '2026-09-13T04:00:00.000Z', amount: 30, balance: 500,
    description: 'Synthetic prior record', cash_account_transaction_type: { name: 'DEPOSIT' } },
    ...structuredClone(target)] };
  // The disputed report has already included the four debits.
  p.previousPerformance.report.cash_accounts[0].value = 400;
  return fixture;
}

test('independent predecessor fixes the already-debited prior report without re-dating or recording cash', () => {
  const fixture = frozenCashLedgerFixture(), result = normalizeRead(fixture, D, selectBenchmark(benchmarkCache, D));
  assert.deepEqual(result.accounts, { schwab: 1000, webull: 1000 });
  assert.deepEqual(result.splits, { cash: 800, stock: 1050, other: 150 });
  assert.equal(result.prevAcctCash.schwab, 500); assert.equal(result.acctCash.schwab, 400);
  assert.equal(result.flows.length, 4); assert.equal(result.flows.reduce((n,row)=>n+row.amount,0), -100);
  assert.ok(result.flows.every(row => row.date === D && row.tradeId != null));
  assert.equal(new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'})
    .format(new Date(fixture.schwab.cashTransactions[142251].cash_account_transactions[0].date_time)), previousCalendarDate(D));
  assert.deepEqual(checkCashLedger({ date:D, acctCash:result.acctCash, prevAcctCash:result.prevAcctCash, movements:result.flows }), []);
  const classified = reconcileFlows([], [], result.flows);
  assert.deepEqual(classified.errors, []); assert.deepEqual(classified.auto, []); assert.deepEqual(classified.unresolved, []);
  const ordinary = frozenCashLedgerFixture(); ordinary.schwab.previousPerformance.report.cash_accounts[0].value = 500;
  const baseline = normalizeRead(ordinary, D, selectBenchmark(benchmarkCache, D));
  for (const key of ['accounts','splits','sourceDates','styleInput','flows','acctCash','prevAcctCash','benchmark'])
    assert.deepEqual(result[key], baseline[key], key);
  assert.notEqual(result.sourceFingerprint, baseline.sourceFingerprint);
});

test('ledger independently detects target omissions, zero-net omissions and conflicting identities', async t => {
  const cases = [
    ['missing row', f=>f.schwab.cashTransactions[142251].cash_account_transactions.pop(), /CASH_HISTORY_TARGET/],
    ['empty target', f=>f.schwab.cashTransactions[142251].cash_account_transactions=[], /CASH_HISTORY_TARGET/],
    ['missing history', f=>f.schwab.cashLedgerHistory={}, /CASH_HISTORY_EVIDENCE/],
    ['extra cash key', f=>f.schwab.cashLedgerHistory[999]={cash_account_transactions:[]}, /CASH_HISTORY_EVIDENCE/],
    ['no predecessor', f=>f.schwab.cashLedgerHistory[142251].cash_account_transactions.shift(), /CASH_ANCHOR_MISSING/],
    ['wrong predecessor', f=>f.schwab.cashLedgerHistory[142251].cash_account_transactions[0].balance=499, /CASH_RECONCILIATION/],
    ['amount conflict', f=>f.schwab.cashLedgerHistory[142251].cash_account_transactions[1].amount-=0.01, /CASH_HISTORY_TARGET/],
    ['balance conflict', f=>f.schwab.cashLedgerHistory[142251].cash_account_transactions[1].balance-=0.01, /CASH_HISTORY_TARGET/],
    ['raw time conflict', f=>f.schwab.cashLedgerHistory[142251].cash_account_transactions[1].date_time=`${D}T01:00:00Z`, /CASH_HISTORY_TARGET/],
    ['trade conflict', f=>f.schwab.cashLedgerHistory[142251].cash_account_transactions[1].trade_id=99, /CASH_HISTORY_TARGET/],
    ['holding conflict', f=>f.schwab.cashLedgerHistory[142251].cash_account_transactions[1].holding_id=99, /CASH_HISTORY_TARGET/],
    ['payout conflict', f=>f.schwab.cashLedgerHistory[142251].cash_account_transactions[1].payout_id=99, /CASH_HISTORY_TARGET/],
    ['description conflict', f=>f.schwab.cashLedgerHistory[142251].cash_account_transactions[1].description='changed', /CASH_HISTORY_TARGET/],
    ['foreign ID conflict', f=>f.schwab.cashLedgerHistory[142251].cash_account_transactions[1].foreign_identifier='changed', /CASH_HISTORY_TARGET/],
    ['type conflict', f=>f.schwab.cashLedgerHistory[142251].cash_account_transactions[1].cash_account_transaction_type.name='FEE', /CASH_HISTORY_TARGET/],
    ['wrong cash identity', f=>f.schwab.cashLedgerHistory[142251].cash_account_transactions[0].cash_account_id=999, /CASH_TRANSACTION_IDENTITY/],
    ['wrong portfolio link', f=>f.schwab.cashLedgerHistory[142251].cash_account_transactions[0].links={portfolio:'https://api.sharesight.com/api/v2/portfolios/1350094'}, /CASH_TRANSACTION_IDENTITY/],
    ['duplicate ID', f=>f.schwab.cashLedgerHistory[142251].cash_account_transactions.push({...f.schwab.cashLedgerHistory[142251].cash_account_transactions[0]}), /SOURCE_DUPLICATE/],
    ['stale report and list', f=>{f.schwab.performance.report.cash_accounts[0].value=500;f.schwab.performance.report.value=1100;
      f.schwab.cashAccounts.cash_accounts[0].balance=f.schwab.cashAccounts.cash_accounts[0].balance_in_portfolio_currency=500;}, /CASH_RECONCILIATION/],
  ];
  for (const [name, mutate, error] of cases) await t.test(name,()=>{
    const fixture=frozenCashLedgerFixture();mutate(fixture);
    assert.throws(()=>normalizeRead(fixture,D,selectBenchmark(benchmarkCache,D)),error);
  });
  const fixture=frozenCashLedgerFixture(), p=fixture.schwab;
  const zero=[{id:300,cash_account_id:142251,date_time:`${D}T01:00:00Z`,amount:50,balance:450,cash_account_transaction_type:{name:'DEPOSIT'}},
    {id:301,cash_account_id:142251,date_time:`${D}T02:00:00Z`,amount:-50,balance:400,cash_account_transaction_type:{name:'WITHDRAWAL'}}];
  p.cashLedgerHistory[142251].cash_account_transactions.push(...zero);
  assert.throws(()=>normalizeRead(fixture,D,selectBenchmark(benchmarkCache,D)),/CASH_HISTORY_TARGET/);
  p.cashTransactions[142251].cash_account_transactions.push(...structuredClone(zero));
  assert.equal(normalizeRead(fixture,D,selectBenchmark(benchmarkCache,D)).flows.length,6);
});

test('target cash must be a complete timestamp suffix, including offset and same-time boundaries', async t => {
  for (const [time,error] of [
    ['2026-09-22T23:00:00-02:00',/CASH_HISTORY_BOUNDARY/],
    ['2026-09-22T20:00:00-04:00',/CASH_HISTORY_BOUNDARY/],
    ['2026-09-24T00:00:00Z',/CASH_TRANSACTION_IDENTITY/],
  ]) await t.test(time,()=>{
    const fixture=frozenCashLedgerFixture();fixture.schwab.cashLedgerHistory[142251].cash_account_transactions[0].date_time=time;
    assert.throws(()=>normalizeRead(fixture,D,selectBenchmark(benchmarkCache,D)),error);
  });
});

test('predecessor group needs an independent unique terminal and consumes all its edges', async t => {
  const row=(id,amount,balance)=>({id,cash_account_id:142251,date_time:'2026-09-13T04:00:00Z',amount,balance,cash_account_transaction_type:{name:'FEE'}});
  const cases=[
    ['reversed unique path',[row(41,-30,500),row(42,60,530)],true],
    ['one balance self loops',[row(41,0,500),row(42,0,500)],true],
    ['multi-balance cycle',[row(41,30,530),row(42,-30,500)],false],
    ['disconnected cycle',[row(41,30,500),row(42,20,700),row(43,-20,680)],false],
    ['two open paths',[row(41,30,500),row(42,20,700)],false],
    ['duplicate edges incompatible',[row(41,30,500),row(42,30,500)],false],
  ];
  for(const [name,prior,pass]of cases)await t.test(name,()=>{
    const fixture=frozenCashLedgerFixture(), p=fixture.schwab;
    p.cashLedgerHistory[142251].cash_account_transactions=[...prior,...p.cashTransactions[142251].cash_account_transactions];
    if(pass)assert.equal(normalizeRead(fixture,D,selectBenchmark(benchmarkCache,D)).prevAcctCash.schwab,500);
    else assert.throws(()=>normalizeRead(fixture,D,selectBenchmark(benchmarkCache,D)),/CASH_ANCHOR_(?:AMBIGUOUS|CHAIN)/);
  });
});

test('empty target still requires history and independent terminal balance',()=>{
  const fixture=frozenCashLedgerFixture();
  // Webull has no target transactions; the frozen ledger opening is 400.
  assert.doesNotThrow(()=>normalizeRead(fixture,D,selectBenchmark(benchmarkCache,D)));
  fixture.webull.cashLedgerHistory[90250].cash_account_transactions[0].balance=401;
  assert.throws(()=>normalizeRead(fixture,D,selectBenchmark(benchmarkCache,D)),/CASH_RECONCILIATION/);
  fixture.webull.cashLedgerHistory[90250].cash_account_transactions=[];
  assert.throws(()=>normalizeRead(fixture,D,selectBenchmark(benchmarkCache,D)),/CASH_ANCHOR_MISSING/);
  const parsed=wireInput(frozenCashLedgerFixture());delete parsed.schwab.cashLedgerHistory;
  assert.throws(()=>normalizeCloudRead(parsed,D,selectBenchmark(benchmarkCache,D)),/CASH_HISTORY_EVIDENCE/);
});

test('complete ledger evidence is canonical and bound to stable reads including prior reports and settings',async()=>{
  const fixture=frozenCashLedgerFixture(), original=normalizeRead(fixture,D,selectBenchmark(benchmarkCache,D));
  fixture.schwab.cashLedgerHistory[142251].cash_account_transactions.reverse();
  fixture.schwab.cashTransactions[142251].cash_account_transactions.reverse();
  assert.equal(normalizeRead(fixture,D,selectBenchmark(benchmarkCache,D)).sourceFingerprint,original.sourceFingerprint);
  fixture.schwab.cashLedgerHistory[142251].cash_account_transactions.find(row=>row.id===40).description='revised predecessor';
  assert.notEqual(normalizeRead(fixture,D,selectBenchmark(benchmarkCache,D)).sourceFingerprint,original.sourceFingerprint);
  for(const key of ['amount','balance'])for(const token of ['500.001','1e-400','"500"']) {
    const parsed=wireInput(frozenCashLedgerFixture()), payload=parsed.schwab.cashLedgerHistory[142251];
    const text=JSON.stringify(payload).replace(new RegExp(`"${key}":(?:30|500)`),`"${key}":${token}`);
    parsed.schwab.cashLedgerHistory[142251]=parseTradeJson(text);
    assert.throws(()=>normalizeCloudRead(parsed,D,selectBenchmark(benchmarkCache,D)),/CASH_PRECISION/);
  }
  for(const mark of [p=>p.links={next:'https://untrusted.test'},p=>p.pagination={next_page:2},p=>p.has_more=true,
    p=>p.complete=false,p=>p.limited=true,p=>p.restricted=true,p=>p.truncated=true]) {
    const f=frozenCashLedgerFixture();mark(f.schwab.cashLedgerHistory[142251]);
    assert.throws(()=>normalizeRead(f,D,selectBenchmark(benchmarkCache,D)),/SOURCE_INCOMPLETE/);
  }
  let round=0;
  const changedReader=datedCashReader(frozenCashLedgerFixture());
  const readOnce=changedReader.readOnce.bind(changedReader);
  changedReader.readOnce=async date=>{const raw=await readOnce(date);if(++round===2)raw.schwab.cashSettings.tz_name='UTC';return raw;};
  await assert.rejects(changedReader.readStable(D,selectBenchmark(benchmarkCache,D)),/SOURCE_UNSTABLE/);
  const calls=[];await datedCashReader(frozenCashLedgerFixture(),{},calls).readStable(D,selectBenchmark(benchmarkCache,D));
  const history=calls.filter(c=>new URL(c.url).pathname.endsWith('/cash_account_transactions.json')&&!new URL(c.url).searchParams.has('from'));
  assert.equal(history.length,4);assert.ok(history.every(c=>c.method==='GET'&&new URL(c.url).searchParams.size===1&&new URL(c.url).searchParams.get('to')===D));
});

test('distinct equal-value trades remain four records and currency identity stays strict',()=>{
  const fixture=frozenCashLedgerFixture(), p=fixture.schwab;
  for(const [i,row]of p.cashTransactions[142251].cash_account_transactions.entries()) {
    row.amount=-25;row.balance=500-25*(i+1);
    Object.assign(p.cashLedgerHistory[142251].cash_account_transactions.find(item=>item.id===row.id),row);
  }
  const result=normalizeRead(fixture,D,selectBenchmark(benchmarkCache,D));
  assert.equal(result.flows.length,4);assert.equal(new Set(result.flows.map(row=>row.tradeId)).size,4);
  assert.deepEqual(checkCashLedger({date:D,acctCash:result.acctCash,prevAcctCash:result.prevAcctCash,movements:result.flows}),[]);
  p.cashAccounts.cash_accounts[0].currency='HKD';p.performance.report.cash_accounts[0].currency.code='HKD';
  delete p.cashLedgerHistory[142251];
  assert.throws(()=>normalizeRead(fixture,D,selectBenchmark(benchmarkCache,D)),/NON_USD_MOVEMENT/);
});

test('each USD account reconciles before aggregation, even when wrong anchors cancel',()=>{
  const fixture=frozenCashLedgerFixture(),p=fixture.schwab;
  const portfolio={id:936249,name:'Schwab-HK'},cashId=142253;
  p.cashAccounts.cash_accounts.push({id:cashId,portfolio_id:936249,currency:'USD',portfolio_currency:'USD',date:D,balance:300,balance_in_portfolio_currency:300});
  p.performance.report.cash_accounts.push({id:cashId,value:300,currency:{code:'USD'},portfolio});p.performance.report.value+=300;
  p.previousPerformance.report.cash_accounts.push({id:cashId,value:300,currency:{code:'USD'},portfolio});
  const row={id:400,cash_account_id:cashId,date_time:`${D}T00:00:00Z`,amount:10,balance:300,cash_account_transaction_type:{name:'FEE'}};
  p.cashTransactions[cashId]={cash_account_transactions:[row]};
  p.cashLedgerHistory[cashId]={cash_account_transactions:[{...row,id:399,date_time:'2026-09-13T00:00:00Z',amount:0,balance:290},structuredClone(row)]};
  const result=normalizeRead(fixture,D,selectBenchmark(benchmarkCache,D));
  assert.equal(result.acctCash.schwab,700);assert.equal(result.prevAcctCash.schwab,790);
  p.cashLedgerHistory[142251].cash_account_transactions[0].balance=499;
  p.cashLedgerHistory[cashId].cash_account_transactions[0].balance=291;
  assert.throws(()=>normalizeRead(fixture,D,selectBenchmark(benchmarkCache,D)),/CASH_RECONCILIATION/);
});

test('history transport failures, oversized responses and changed proofs never become zero cash',async()=>{
  for(const failure of ['FEE_CLOUD_SOURCE_UNAVAILABLE','FEE_CLOUD_HTTP_REJECTED']) {
    const reader=datedCashReader(frozenCashLedgerFixture()),get=reader.get.bind(reader);
    reader.get=async(url,token)=>{if(url.includes('cash_account_transactions.json?to='))throw new Error(failure);return get(url,token);};
    await assert.rejects(reader.readStable(D,selectBenchmark(benchmarkCache,D)),new RegExp(failure));
  }
  const oversized=datedCashReader(frozenCashLedgerFixture()),fetch=oversized.http.fetchImpl;
  oversized.http.fetchImpl=async(url,init)=>url.includes('cash_account_transactions.json?to=')
    ? jsonResponse(url,{cash_account_transactions:[],padding:'x'.repeat(2*1024*1024)}) : fetch(url,init);
  await assert.rejects(oversized.readStable(D,selectBenchmark(benchmarkCache,D)),/RESPONSE_SIZE/);
  for(const mutate of [raw=>raw.schwab.cashLedgerHistory[142251].cash_account_transactions[0].description='changed proof',
    raw=>{const payload=JSON.parse(JSON.stringify(raw.schwab.previousPerformance));payload.report.cash_accounts[0].value=401;
      raw.schwab.previousPerformance=parseTradeJson(JSON.stringify(payload));}]) {
    let round=0;const reader=datedCashReader(frozenCashLedgerFixture()),readOnce=reader.readOnce.bind(reader);
    reader.readOnce=async date=>{const raw=await readOnce(date);if(++round===2)mutate(raw);return raw;};
    await assert.rejects(reader.readStable(D,selectBenchmark(benchmarkCache,D)),/SOURCE_UNSTABLE/);
  }
});

test('cash authority change preserves full fee receipt, TWR, Carry/HWM and investor valuation inputs',()=>{
  const corrected=normalizeRead(frozenCashLedgerFixture(),D,selectBenchmark(benchmarkCache,D));
  const normal=frozenCashLedgerFixture();normal.schwab.previousPerformance.report.cash_accounts[0].value=500;
  const baseline=normalizeRead(normal,D,selectBenchmark(benchmarkCache,D));
  const makeData=input=>({daily:[{d:previousCalendarDate(D),schwab:950,webull:950},
    {d:D,...input.accounts,...input.splits}],flowsAuto:[],flowsUnresolved:[],
    status:{asOf:D,provisional:false,calibrated:false,unresolvedCount:0}});
  const economicInput={v:4,settings:{start:previousCalendarDate(D),mgmt:2,carry:20,who:'Synthetic manager'},
    accounts:[{id:'schwab',name:'Synthetic Schwab',opening:950},{id:'webull',name:'Synthetic Webull',opening:950}],months:[],fees:[]};
  const expected=buildFeeCalculationReceipt({data:makeData(baseline),economicInput});
  const actual=buildFeeCalculationReceipt({data:makeData(corrected),economicInput});
  assert.deepEqual(actual,expected);assert.ok(actual.totals.managementFeeCents>0);assert.ok(actual.totals.carryCents>0);
  const profile={schema:'fee-console.fund-profile.v1',manager:'Synthetic manager',fundName:'Synthetic fund',
    inceptionDate:previousCalendarDate(D),inceptionNoticeDate:previousCalendarDate(D),currency:'USD',initialShares:1000000,
    investors:[{id:'A',name:'Synthetic A',shares:900000},{id:'B',name:'Synthetic B',shares:100000}]};
  const core=createFundInvestorCore();
  const value=input=>core.calculate({profile,data:makeData(input),feeView:{state:'verified',start:previousCalendarDate(D),asOf:D,
    status:{provisional:false},benchmarkInputs:{openingCents:190000,flows:[]}}});
  assert.equal(value(corrected).status,'ready');assert.deepEqual(value(corrected),value(baseline));
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
    if (u.pathname.endsWith('/cash_account_transactions.json')) {
      const cashId = u.pathname.split('/')[4];
      return response(url, u.searchParams.has('from') ? p.cashTransactions[cashId] : fixtureCashHistory(p, cashId));
    }
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

test("Sharesight's supported principal declaration is internal without a second matching trade amount", () => {
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
  assert.equal(flow.evidence, "internal_trade");
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
    if (url.includes("cash_account_transactions")) {
      const u = new URL(url), cashId = u.pathname.split('/')[4], p = fixtures[account];
      return response(url, u.searchParams.has('from') ? p.cashTransactions[cashId] : fixtureCashHistory(p, cashId));
    }
    if (url.includes("trades.json")) return response(url, fixtures[account].trades);
    throw new Error(`unexpected ${init.method} ${url}`);
  };
  const reader = new SharesightCloudReader({ clientId: "id", clientSecret: "secret", fetchImpl });
  const result = await reader.readStable(D, selectBenchmark(benchmarkCache, D));
  assert.equal(result.targetDate, D);
  assert.equal(calls, 34);
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
      if (url.includes('cash_account_transactions')) {
        const u = new URL(url), cashId = u.pathname.split('/')[4];
        return response(url, u.searchParams.has('from') ? p.cashTransactions[cashId] : fixtureCashHistory(p, cashId));
      }
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

test('unresolved diagnostic projects only fixed reasons, origins and three-state counts from memory', () => {
  const hidden='PRIVATE_CANARY account=opaque amount=123456.78 /private/path\r\n\u001b[31m';
  const baseline={id:'baseline-private',date:D,acct:hidden,amount:123456.78,desc:hidden,reason:'bare DEPOSIT with no trade or transfer evidence'};
  const reclassified={date:D,acct:'webull',amount:3,desc:hidden,type:'DEPOSIT',evidence:'internal_trade',tradeId:null,holdingId:null,payoutPointerPresent:false};
  assert.equal(flowId({...reclassified,payoutPointerPresent:true}),flowId(reclassified),'diagnostic pointer presence cannot change a flow identity');
  const pending={id:'pending-private',date:D,acct:'webull',amount:1,type:'DEPOSIT',evidence:'internal_income_pending_date',incomeRole:'dividend',sourcePayoutId:7,cashPostingDate:D,incomeDateVerified:false};
  const fresh={id:'new-private',date:D,acct:'webull',amount:-1,type:'WITHDRAWAL',desc:hidden};
  const rows=[baseline,{id:flowId(reclassified),date:D,reason:'bare DEPOSIT with no trade or transfer evidence'},
    {id:fresh.id,date:D,reason:'bare WITHDRAWAL with no trade or transfer evidence'},
    {id:pending.id,date:D,reason:'verified dividend cash/collection fee awaits cash-posting date evidence'},
    {id:'opaque-private',date:'2026-02-30',reason:'verified external asset transfer '+hidden},
    {id:'inconsistent-private',date:D,reason:'dividend cash evidence is incomplete or inconsistent'},
    {id:'external-private',date:D,reason:'external asset transfer lacks paired source/destination trade evidence'}];
  const payload={flowsUnresolved:rows},original=structuredClone(payload),input={flows:[reclassified,fresh,pending]};
  const value=buildUnresolvedFlowDiagnostic({payload,input,context:{baselineUnresolvedIds:[baseline.id,flowId(reclassified)],reportTarget:'2026-09-25',processingDate:D,processingIndex:2},env:{GITHUB_RUN_ID:'123',GITHUB_SHA:'a'.repeat(40)}});
  assert.equal(validateUnresolvedFlowDiagnostic(value),true);assert.deepEqual(payload,original);
  assert.equal(value.overflowCount,0);
  assert.equal(value.processingIndex,2);assert.equal(value.processingDate,D);assert.equal(value.reportTarget,'2026-09-25');
  assert.ok(value.groups.some(g=>g.origin==='BASELINE'&&g.reasonCode==='BARE_DEPOSIT'));
  assert.ok(value.groups.some(g=>g.origin==='PERSISTED_AFTER_RECLASSIFICATION'));
  assert.ok(value.groups.some(g=>g.origin==='NEW'&&g.reasonCode==='BARE_WITHDRAWAL'));
  for(const code of ['INCOME_DATE_PENDING','INCOME_EVIDENCE_INCONSISTENT','EXTERNAL_PROOF_MISSING','UNKNOWN'])assert.ok(value.groups.some(g=>g.reasonCode===code));
  assert.deepEqual(value.facts.principal,{true:1,false:1,unknown:5});assert.deepEqual(value.facts.dateProof,{true:0,false:1,unknown:6});
  for(const name of ['tradePointer','holdingPointer','payoutPointer'])assert.deepEqual(value.facts[name],{true:0,false:1,unknown:6});
  const text=JSON.stringify(value);for(const privateText of [hidden,'baseline-private','pending-private','new-private','123456.78','webull','verified external asset transfer','desc','sourcePayoutId'])assert.equal(text.includes(privateText),false);
  const absent=buildUnresolvedFlowDiagnostic({payload,env:{GITHUB_RUN_ID:hidden,GITHUB_SHA:hidden}});
  assert.equal(absent.runId,'unknown');assert.equal(absent.headSha,'unknown');assert.equal(absent.processingDate,'unknown');assert.equal(absent.processingIndex,'unknown');assert.equal(absent.reportTarget,'unknown');
  assert.ok(absent.groups.every(g=>g.origin==='UNKNOWN'));for(const name of ['tradePointer','holdingPointer','payoutPointer'])assert.deepEqual(absent.facts[name],{true:0,false:0,unknown:7});
  // A duplicate ordinary diagnostic id cannot supply reclassification evidence.
  const duplicate=buildUnresolvedFlowDiagnostic({payload:{flowsUnresolved:[rows[1]]},input:{flows:[reclassified,{...reclassified}]},context:{baselineUnresolvedIds:[rows[1].id]}});
  assert.equal(duplicate.groups[0].origin,'UNKNOWN');assert.equal(duplicate.facts.principal.unknown,1);
  const duplicateBaseline=buildUnresolvedFlowDiagnostic({payload:{flowsUnresolved:[rows[1]]},input:{flows:[reclassified]},context:{baselineUnresolvedIds:[rows[1].id,rows[1].id]}});
  assert.equal(duplicateBaseline.groups[0].origin,'UNKNOWN');for(const fact of Object.values(duplicateBaseline.facts))assert.deepEqual(fact,{true:0,false:0,unknown:1});
  const missing=buildUnresolvedFlowDiagnostic({payload:{flowsUnresolved:[baseline]},input:{flows:[{id:baseline.id,date:D,amount:1,type:'DEPOSIT'}]},context:{baselineUnresolvedIds:[baseline.id]}});
  for(const fact of Object.values(missing.facts))assert.deepEqual(fact,{true:0,false:0,unknown:1});
  const explicit=buildUnresolvedFlowDiagnostic({payload:{flowsUnresolved:[baseline]},input:{flows:[{id:baseline.id,date:D,amount:1,type:'DEPOSIT',tradeId:null,holdingId:null,payoutPointerPresent:false,evidence:null,incomeDateVerified:false}]}});
  for(const fact of Object.values(explicit.facts))assert.deepEqual(fact,{true:0,false:1,unknown:0});
  const nativePointers=buildUnresolvedFlowDiagnostic({payload:{flowsUnresolved:[baseline]},input:{flows:[{id:baseline.id,date:D,amount:1,type:'DEPOSIT',tradeId:7,holdingId:null,payoutPointerPresent:true,sourcePayoutId:999}]}});
  assert.deepEqual(nativePointers.facts.tradePointer,{true:1,false:0,unknown:0});assert.deepEqual(nativePointers.facts.holdingPointer,{true:0,false:1,unknown:0});assert.deepEqual(nativePointers.facts.payoutPointer,{true:1,false:0,unknown:0});
  for(const payoutPointerPresent of [undefined,null,0,'false','PRIVATE_CANARY']){
    const invalidPointer=buildUnresolvedFlowDiagnostic({payload:{flowsUnresolved:[baseline]},input:{flows:[{id:baseline.id,date:D,amount:1,type:'DEPOSIT',sourcePayoutId:999,...(payoutPointerPresent===undefined?{}:{payoutPointerPresent})}]}});
    assert.deepEqual(invalidPointer.facts.payoutPointer,{true:0,false:0,unknown:1});
  }
  // An external classification is not a claim of persisted internal cash.
  const external=buildUnresolvedFlowDiagnostic({payload:{flowsUnresolved:[baseline]},input:{flows:[{...baseline,evidence:'external_transfer',externalRef:'private'}]},context:{baselineUnresolvedIds:[baseline.id]}});
  assert.equal(external.groups[0].origin,'BASELINE');
  const unknownRow={id:'unsupported-private',date:D,reason:'no evidence either way'};
  for(const type of ['INTEREST','DIVIDEND','PRIVATE_CANARY /private/path amount=123456.78']){
    const unsupported=buildUnresolvedFlowDiagnostic({payload:{flowsUnresolved:[unknownRow]},input:{flows:[{id:unknownRow.id,date:D,amount:1,type}]}});
    assert.equal(validateUnresolvedFlowDiagnostic(unsupported),true);assert.equal(unsupported.groups[0].reasonCode,'UNSUPPORTED_SOURCE_TYPE');assert.equal(JSON.stringify(unsupported).includes(type),false);
  }
  for(const type of [undefined,null,'','  ','DEPOSIT','WITHDRAWAL',' deposit ','withdrawal']){
    const unknown=buildUnresolvedFlowDiagnostic({payload:{flowsUnresolved:[unknownRow]},input:{flows:[{id:unknownRow.id,date:D,amount:1,...(type===undefined?{}:{type})}]}});
    assert.equal(unknown.groups[0].reasonCode,'UNKNOWN');
  }
  const noRaw=buildUnresolvedFlowDiagnostic({payload:{flowsUnresolved:[unknownRow]}});assert.equal(noRaw.groups[0].reasonCode,'UNKNOWN');
  const nowInternal=buildUnresolvedFlowDiagnostic({payload:{flowsUnresolved:[unknownRow]},input:{flows:[{id:unknownRow.id,date:D,amount:1,type:'INTEREST',evidence:'internal_trade'}]},context:{baselineUnresolvedIds:[unknownRow.id]}});
  assert.equal(nowInternal.groups[0].reasonCode,'UNKNOWN');assert.equal(nowInternal.groups[0].origin,'PERSISTED_AFTER_RECLASSIFICATION');
  const changedReason=buildUnresolvedFlowDiagnostic({payload:{flowsUnresolved:[{...unknownRow,reason:'no evidence either way PRIVATE_CANARY'}]},input:{flows:[{id:unknownRow.id,date:D,amount:1,type:'INTEREST'}]}});assert.equal(changedReason.groups[0].reasonCode,'UNKNOWN');
});

test('unresolved diagnostic validator and private stderr reader reject unknown keys, canaries, dates, counts and duplicates', () => {
  const valid=buildUnresolvedFlowDiagnostic({payload:{flowsUnresolved:[{id:'private',date:D,reason:'no evidence either way'}]},env:{}});
  const line=value=>UNRESOLVED_FLOW_DIAGNOSTIC_PREFIX+JSON.stringify(value),code='FEE_CLOUD_UNRESOLVED_FLOW';
  assert.deepEqual(safeProducerFailureSummary('PRIVATE_CANARY raw stderr\n'+line(valid)+'\n'+code+'\n'),{code,diagnostic:valid});
  const cases=[v=>v.private='PRIVATE_CANARY',v=>v.groups[0].account='PRIVATE_CANARY',v=>v.facts.tradePointer.private='PRIVATE_CANARY',v=>v.facts.pointer={true:0,false:0,unknown:1},
    v=>v.runId='PRIVATE_CANARY',v=>v.headSha='PRIVATE_CANARY',v=>v.reportTarget='2026-02-30',v=>v.processingDate='PRIVATE_CANARY',v=>v.processingIndex=11,
    v=>v.stage='PRIVATE_CANARY',v=>v.code='FEE_CLOUD_PRIVATE_CANARY',v=>v.schema='PRIVATE_CANARY',v=>v.groups[0].flowDate='2026-02-30',
    v=>v.groups[0].reasonCode='bare DEPOSIT with no trade or transfer evidence',v=>v.groups[0].origin='PRIVATE_CANARY',
    v=>v.unresolvedCount=10001,v=>v.groups[0].count=10001,v=>v.groups[0].count=-1,v=>v.facts.tradePointer.unknown=2,v=>v.facts.payoutPointer.false=1,
    v=>delete v.overflowCount,v=>v.overflowCount=-1,v=>v.overflowCount=2,v=>{v.overflowCount=1;v.groups[0].flowDate=D;},v=>{v.overflowCount=1;v.groups[0].origin='BASELINE';},
    v=>v.groups.push({...v.groups[0]}),v=>v.groups=Array.from({length:33},()=>({...v.groups[0]}))];
  for(const mutate of cases){const value=structuredClone(valid);mutate(value);assert.equal(validateUnresolvedFlowDiagnostic(value),false);const result=safeProducerFailureSummary(line(value)+'\n'+code+'\n');assert.equal(result.diagnostic,null);assert.equal(JSON.stringify(result).includes('PRIVATE_CANARY'),false);}
  for(const stderr of [line(valid)+'\n'+line(valid)+'\n'+code+'\n',line(valid)+'\n'+UNRESOLVED_FLOW_DIAGNOSTIC_PREFIX+'bad\n'+code+'\n',
    'prefix '+line(valid)+'\n'+code+'\n',line(valid).replace('{','{"schema":"PRIVATE_CANARY",')+'\n'+code+'\n',
    'x'.repeat(65537),line(valid)+'\nSOURCE_HTTP\n'])assert.equal(safeProducerFailureSummary(stderr).diagnostic,null);
  assert.equal(buildUnresolvedFlowDiagnostic({payload:{flowsUnresolved:Array.from({length:10001},()=>({}))}}),null);
  const collapsed=buildUnresolvedFlowDiagnostic({payload:{flowsUnresolved:Array.from({length:33},(_,i)=>({date:`2026-01-${String(i%31+1).padStart(2,'0')}`,reason:i<31?'no evidence either way':'bare DEPOSIT with no trade or transfer evidence'}))},context:{processingDate:D,processingIndex:2,reportTarget:'2026-09-25'}});
  assert.equal(validateUnresolvedFlowDiagnostic(collapsed),true);assert.equal(collapsed.unresolvedCount,33);assert.equal(collapsed.overflowCount,33);assert.equal(collapsed.processingDate,D);assert.equal(collapsed.processingIndex,2);assert.equal(collapsed.reportTarget,'2026-09-25');
  assert.deepEqual(collapsed.groups,[{flowDate:'unknown',reasonCode:'UNKNOWN',origin:'UNKNOWN',count:33}]);for(const fact of Object.values(collapsed.facts))assert.deepEqual(fact,{true:0,false:0,unknown:33});
  assert.deepEqual(safeProducerFailureSummary(line(collapsed)+'\n'+code+'\n'),{code,diagnostic:collapsed});
  const partialOverflow=structuredClone(collapsed);partialOverflow.overflowCount=32;assert.equal(validateUnresolvedFlowDiagnostic(partialOverflow),false);
  const falseReason=structuredClone(collapsed);falseReason.groups[0].reasonCode='BARE_DEPOSIT';assert.equal(validateUnresolvedFlowDiagnostic(falseReason),false);
  for(const code of ['FEE_CLOUD_PRIVATE_CANARY','FEE_REPORT_PRIVATE_CANARY','SOURCE_PRIVATE_CANARY','FEE_CLOUD_STAGE_SOURCE_READ_PRIVATE_CANARY','FEE_CLOUD_WRITER_STYLE_PRIVATE_CANARY']){
    assert.deepEqual(safeProducerFailureSummary(code+'\n'),{code:'FEE_CLOUD_FAILED',diagnostic:null});
  }
  for(const code of ['SOURCE_HTTP','SOURCE_FORBIDDEN','FEE_CLOUD_STAGE_SOURCE_READ_TYPE','FEE_CLOUD_STAGE_ECONOMIC_READ_SYSTEM_ENOENT','FEE_CLOUD_STAGE_SOURCE_READ_NONCASH_POSITION_DELTA','FEE_CLOUD_WRITER_STYLE_FILE_CHANGED','FEE_CLOUD_WRITER_PREFLIGHT_CASH_EVIDENCE','FEE_CLOUD_CASH_BALANCE_STALE','FEE_REPORT_RECOVERY_CONSUMED'])assert.equal(safeProducerFailureSummary(code+'\n').code,code);
  for(const [file,prefix]of [['fee-cloud-producer.mjs','FEE_CLOUD_'],['fee-cloud-source.mjs','FEE_CLOUD_'],['fee-report-producer.mjs','FEE_REPORT_']]){
    const source=fs.readFileSync(new URL('./'+file,import.meta.url),'utf8');
    for(const [,suffix]of source.matchAll(/\bfail\(['"]([A-Z0-9_]+)['"]/g))assert.equal(safeProducerFailureSummary(prefix+suffix+'\n').code,prefix+suffix,'literal failure must retain its safe code');
  }
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
  assert.match(workflow, /cron: '30 2 \* \* \*'/, 'public market gate first checks at HKT10:30');
  assert.match(workflow, /cron: '0 5,6 \* \* \*'/, 'same-day HKT13:00/14:00 continuation remains bounded');
  assert.doesNotMatch(workflow, /cron: '[^']+ \* \* 2-6'/);
  assert.match(workflow, /needs: period/);
  assert.match(workflow, /needs\.period\.outputs\.outcome == 'produce'/);
  assert.match(workflow, /inputs\.run_reviewed_once/);
  assert.match(workflow, /github\.event_name == 'schedule' && vars\.FEE_REPORT_PERIODS_ENABLED == 'true'/);
  const publicGate=workflow.slice(workflow.indexOf('  period:'),workflow.indexOf('  produce:'));
  assert.doesNotMatch(publicGate, /secrets\.|get-secretmanager|FEE_DATA_KEY|client_secret/);
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
    const data = Buffer.from(JSON.stringify({enc:true,v:3,data:Buffer.alloc(64).toString("base64")})), hash = createHash("sha256").update(data).digest("hex");
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
    const watchScript=path.join(directory,'period-watch.mjs');
    fs.writeFileSync(watchScript,`import fs from 'node:fs';import {reportPublicationWatch} from ${JSON.stringify(new URL('./fee-report-producer.mjs',import.meta.url).href)};try{console.log(JSON.stringify(await reportPublicationWatch({mainSha:'a'.repeat(40),data:fs.readFileSync('data.json'),health:JSON.parse(fs.readFileSync('fee-data-health.json'))})));}catch(error){console.error(error.message);process.exitCode=1;}`);
    const script = `set -euo pipefail
base_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
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
node() { echo "receipt-validation $*" >&2; if [[ "$1" == scripts/fee-report-producer.mjs ]]; then "$TEST_NODE" --import "$TEST_CLOCK" "$TEST_PERIOD_WATCH" "\${@:2}"; else "$TEST_NODE" --import "$TEST_CLOCK" "$TEST_VALIDATOR" "\${@:2}"; fi; }
${workflow.slice(start, end)}
echo candidate-path`;
    const result = spawnSync("bash", ["-c", script], {cwd: directory, encoding: "utf8", env: {...process.env,
      TZ: "America/Los_Angeles", GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: path.join(directory, "output"), TEST_NOW: iso,
      TEST_TODAY: hkt, TEST_WEEKDAY: String(weekdayNumber), TEST_CYCLE_START: cycleStart, TEST_RECEIPT_DATE: checkedDay,
      TEST_NODE: process.execPath, TEST_CLOCK: clock, TEST_PERIOD_WATCH: watchScript, TEST_VALIDATOR: fileURLToPath(new URL("./fee-data-health.mjs", import.meta.url))}});
    return {...result, output: fs.existsSync(path.join(directory, "output")) ? fs.readFileSync(path.join(directory, "output"), "utf8") : ""};
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
}

test("scheduled period watchdog accepts this weekly receipt across the whole week", () => {
  const receipt={checkedAt:'2026-10-04T01:00:00Z',targetDate:'2026-10-02'};
  for(const iso of ['2026-10-04T11:06:24Z','2026-10-05T16:00:00Z','2026-10-06T05:15:00Z','2026-10-07T05:15:00Z','2026-10-08T05:15:00Z','2026-10-09T05:15:00Z','2026-10-10T07:45:00Z']){
    const result=scheduledReceiptDecision(iso,'schedule',receipt);
    assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/already-published/);assert.equal(result.output,'sha=\n');
  }
});
test("next weekly cycle still fails until the new target is independently published", () => {
  const old={checkedAt:'2026-10-04T01:00:00Z',targetDate:'2026-10-02'};
  const result=scheduledReceiptDecision('2026-10-11T05:15:00Z','schedule',old);
  assert.equal(result.status,1);assert.match(result.stderr,/PUBLISHED_PERIOD_MISSING/);
  assert.equal(scheduledReceiptDecision('2026-10-11T05:15:00Z','schedule',{checkedAt:'2026-10-11T01:00:00Z',targetDate:'2026-10-09'}).status,0);
});
test("manual/event no-candidate receipts retain same-day and fresh-health protections", () => {
  for(const event of ['workflow_dispatch','workflow_run']){
    assert.equal(scheduledReceiptDecision('2026-10-06T05:15:00Z',event).status,1);
    assert.equal(scheduledReceiptDecision('2026-10-06T05:15:00Z',event,{checkedAt:'2026-10-04T01:00:00Z',targetDate:'2026-10-02'}).status,1);
    assert.equal(scheduledReceiptDecision('2026-10-06T05:15:00Z',event,{date:'2026-10-06',valid:true}).status,0);
  }
});
test("period no-op cannot hide a rejected candidate, corrupt envelope/receipt, missing report or source mismatch", () => {
  const good={checkedAt:'2026-10-04T01:00:00Z',targetDate:'2026-10-02'};
  for(const [receipt,options] of [[null,{}],[{...good,valid:false},{}],[{...good,badHash:true},{}],[{...good,outcome:'failed'},{}],[{...good,checkedAt:'2026-10-05T12:22:40.904Z'},{}],[{...good,sourceDates:{schwab:'2026-10-02',webull:'2026-10-01',benchmark:'2026-10-02'}},{}],[good,{recentCandidate:true}]]){
    const result=scheduledReceiptDecision('2026-10-05T12:16:40.904Z','schedule',receipt,options);assert.equal(result.status,1);assert.equal(result.output,'');
  }
  const candidate=scheduledReceiptDecision('2026-10-05T12:16:40.904Z','schedule',null,{candidateCount:1});assert.equal(candidate.status,0);assert.equal(candidate.stdout,'candidate-path\n');assert.equal(candidate.output,'');
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


// One-time opt-in integration remains on the formal CI path.
{
test('period workflow cannot reuse old one-time style authority and preserves protected runtime identity',()=>{
  const workflow=fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml',import.meta.url),'utf8');
  assert.doesNotMatch(workflow,/apply_style_proposal|secrets\.FEE_STYLE_PROPOSAL/);
  assert.match(workflow,/run_reviewed_once:[\s\S]*?type: boolean[\s\S]*?default: false/);
  assert.match(workflow,/permissions:\n  contents: read\n  id-token: write/);
  assert.match(workflow,/environment: fee-cloud-producer/);
  assert.match(workflow,/service_account: fee-cloud-producer@family-portfolio-gateway\.iam\.gserviceaccount\.com/);
  assert.match(workflow,/--mode=produce/);
  const producer=fs.readFileSync(new URL('./fee-cloud-producer.mjs',import.meta.url),'utf8');
  assert.match(producer,/delete env\.FEE_STYLE_PROPOSAL_JSON/);
  assert.match(producer,/delete env\.FEE_STYLE_PROPOSAL_LOCK/);
  assert.match(workflow,/Remove private runtime files[\s\S]*if: \$\{\{ always\(\) \}\}[\s\S]*shred -u/);
});
test('published-preflight CLI cannot consume proposal or bypass its no-credential stage',()=>{
  const cli=fileURLToPath(new URL('./fee-cloud-producer.mjs',import.meta.url));
  const r=spawnSync(process.execPath,[cli,'--mode=published-preflight','--benchmark-file=/nonexistent',
    '--style-proposal-file=/nonexistent-private'],{encoding:'utf8',env:{PATH:process.env.PATH}});
  assert.notEqual(r.status,0);assert.equal(r.stderr.trim(),'FEE_CLOUD_ARGUMENT');
});
test('all workflow literal shell blocks pass bash syntax without executing them',()=>{
  const lines=fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml',import.meta.url),'utf8').split('\n');
  for(let i=0;i<lines.length;i++){
    if(lines[i].trim()!=='run: |')continue;
    const indent=lines[i].length-lines[i].trimStart().length,body=[];
    for(const line of lines.slice(i+1)){
      if(line.trim() && line.length-line.trimStart().length<=indent)break;
      body.push(line.trim()?line.slice(indent+2):'');
    }
    const r=spawnSync('/bin/bash',['-n'],{input:body.join('\n')+'\n',encoding:'utf8',env:{PATH:process.env.PATH}});
    assert.equal(r.status,0,r.stderr);
  }
});


}

// Cache labels remain authoritative at the consumer boundary, even with valid rows.
test('benchmark consumers reject wrong or absent ETF, currency and venue labels', () => {
  for (const key of ['spy','qqq']) for (const [field,bad] of [['symbol','SP500'],['currency','EUR'],['exchange','OTHER']]) {
    for (const missing of [false,true]) {
      const cache=structuredClone(benchmarkCache); if(missing)delete cache.benchmarks[key][field];else cache.benchmarks[key][field]=bad;
      assert.throws(()=>selectBenchmark(cache,D),/BENCHMARK_IDENTITY/);
      assert.throws(()=>latestCommonBenchmarkDate(cache),/BENCHMARK_IDENTITY/);
    }
  }
});

test('asset type: dated Sharesight native type reaches the writer without changing economic values', () => {
  const input = raw(), benchmark = selectBenchmark(benchmarkCache, D);
  const before = normalizeRead(input, D, benchmark, {sourceMode: 'sharesight-reference'});
  input.schwab.performance.report.holdings.find(h => h.id === 2).instrument.friendly_instrument_description_code = 'ordinary_shares';
  input.webull.performance.report.holdings.find(h => h.id === 4).instrument.friendly_instrument_description_code = 'exchange_traded_fund';
  // Contradictory current catalogue type cannot replace the dated report type.
  input.schwab.holdings.holdings.find(h => h.id === 2).instrument.friendly_instrument_description_code = 'exchange_traded_fund';
  input.webull.holdings.holdings.find(h => h.id === 4).instrument.friendly_instrument_description_code = 'ordinary_shares';
  const next = normalizeRead(input, D, benchmark, {sourceMode: 'sharesight-reference'});
  assert.equal(next.styleInput.schemaVersion, 2);
  assert.equal(next.styleInput.mode, 'sharesight-asset-type-v1');
  assert.deepEqual(next.styleInput.proposals, []);
  assert.equal(next.styleInput.portfolios[0].holdings[0].sourceAssetType, 'ordinary_shares');
  assert.equal(next.styleInput.portfolios[1].holdings[0].sourceAssetType, 'exchange_traded_fund');
  for (const key of ['accounts','splits','flows','acctCash','prevAcctCash','benchmark','sourceReference'])
    assert.deepEqual(next[key], before[key], key);
  assert.notEqual(next.sourceFingerprint, before.sourceFingerprint, 'type changes must participate in stable source reads');
  assert.equal(normalizeRead(input, D, benchmark, {sourceMode: 'sharesight-reference'}).sourceFingerprint, next.sourceFingerprint);
});

test('asset type: missing and unfamiliar native metadata never becomes an inferred ordinary share', () => {
  const input = raw(), benchmark = selectBenchmark(benchmarkCache, D);
  input.schwab.holdings.holdings.find(h => h.id === 2).instrument.friendly_instrument_description_code = 'ordinary_shares';
  input.webull.performance.report.holdings.find(h => h.id === 4).instrument.friendly_instrument_description_code = 'future_provider_type';
  const normalized = normalizeRead(input, D, benchmark, {sourceMode: 'sharesight-reference'});
  assert.equal(normalized.styleInput.portfolios[0].holdings[0].sourceAssetType, null);
  assert.equal(normalized.styleInput.portfolios[1].holdings[0].sourceAssetType, 'future_provider_type');
  assert.deepEqual(normalized.splits, {cash: 800, stock: 1050, other: 150});
  assert.equal(normalized.styleInput.portfolios[0].holdings[0].valueUsd, 500);
  assert.equal(normalized.styleInput.portfolios[1].holdings[0].valueUsd, 550);
  for (const invalid of [42, {}, [], 'x'.repeat(129)]) {
    input.schwab.performance.report.holdings.find(h => h.id === 2).instrument.friendly_instrument_description_code = invalid;
    const result = normalizeRead(input, D, benchmark, {sourceMode: 'sharesight-reference'});
    assert.equal(result.styleInput.portfolios[0].holdings[0].sourceAssetType, null);
    assert.deepEqual(result.splits, normalized.splits);
  }
});

function writerDiagnosticCashOnly(date){
  const result={};let cashId=100;
  for(const [account,{name,portfolioId}] of Object.entries(CLOUD_ACCOUNTS)){
    cashId++;const cash={id:cashId,value:100,currency:{code:'USD'},portfolio:{id:portfolioId,name}};
    const p={performance:{report:{portfolio_id:portfolioId,start_date:date,end_date:date,include_sales:false,portfolio_tz_name:'America/New_York',currency:{code:'USD'},value:100,holdings:[],cash_accounts:[cash]}},holdings:{holdings:[]},cashAccounts:{cash_accounts:[{id:cashId,portfolio_id:portfolioId,currency:'USD',portfolio_currency:'USD',date,balance:100,balance_in_portfolio_currency:100}]},cashTransactions:{[cashId]:{cash_account_transactions:[]}},trades:{trades:[]},previousPerformance:{report:{portfolio_id:portfolioId,end_date:reportAddDays(date,-1),currency:{code:'USD'},cash_accounts:[cash]}},cashLedgerHistory:{[cashId]:{cash_account_transactions:[{id:1,cash_account_id:cashId,date_time:reportAddDays(date,-1)+'T00:00:00Z',amount:0,balance:100,cash_account_transaction_type:{name:'FEE'}}]}}};
    if(account==='webull')p.managementTrades={trades:[]};
    for(const key of ['performance','cashAccounts','previousPerformance'])p[key]=parseSourceJson(JSON.stringify(p[key]));
    for(const key of ['cashTransactions','cashLedgerHistory'])p[key]=Object.fromEntries(Object.entries(p[key]).map(([id,value])=>[id,parseSourceJson(JSON.stringify(value))]));
    result[account]=p;
  }
  return result;
}

test('writer failure diagnostic survives real daily and period execution and the unchanged workflow filter',async t=>{
 const cache={v:1,benchmarks:{spy:{symbol:'SPY',currency:'USD',exchange:'NYSEArca',series:[{d:'2026-10-22',p:100},{d:'2026-10-23',p:101}]},qqq:{symbol:'QQQ',currency:'USD',exchange:'NasdaqGS',series:[{d:'2026-10-22',p:200},{d:'2026-10-23',p:202}]}}};
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-unresolved-path-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const root=path.join(dir,'checkout');fs.mkdirSync(root,{mode:0o700});fs.cpSync(new URL('.',import.meta.url),path.join(root,'scripts'),{recursive:true});
 fs.mkdirSync(path.join(root,'claude'));fs.copyFileSync(new URL('../claude/fee-style-mapping.json',import.meta.url),path.join(root,'claude/fee-style-mapping.json'));
 const key=randomBytes(32),encrypt=(o,v)=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);return JSON.stringify({enc:true,v,data:Buffer.concat([iv,c.update(JSON.stringify(o)),c.final(),c.getAuthTag()]).toString('base64')});};
 const original=encrypt({daily:[{d:'2026-10-20',schwab:100,webull:100,cash:200,stock:0,other:0,spy:100,qqq:200,bd:'2026-10-20',bstate:'session',acctCash:{schwab:100,webull:100}}],flowsAuto:[],flowsUnresolved:[],status:{asOf:'2026-10-20',provisional:false,calibrated:false,unresolvedCount:0,notes:[],splitDelta:0}},3);
 fs.writeFileSync(path.join(root,'data.json'),original,{mode:0o600});
 const econ=path.join(dir,'econ.json');fs.writeFileSync(econ,encrypt({v:4,settings:{start:'2026-10-20',mgmt:2,carry:20},accounts:[{id:'schwab',opening:100},{id:'webull',opening:100}],months:[],fees:[]},4),{mode:0o600});
 const benchmark=path.join(dir,'benchmark.json');fs.writeFileSync(benchmark,JSON.stringify({v:1,benchmarks:Object.fromEntries(Object.entries(cache.benchmarks).map(([k,v])=>[k,{...v,series:[{d:'2026-10-21',p:k==='spy'?100:200},...v.series]}]))}),{mode:0o600});
 const hidden='PRIVATE_CANARY amount=123456.78 account=opaque /private/path';
 const snapshots=path.join(dir,'snapshots.json');fs.writeFileSync(snapshots,JSON.stringify(Object.fromEntries(['2026-10-21','2026-10-22','2026-10-23'].map(d=>{
  const raw=writerDiagnosticCashOnly(d);if(d==='2026-10-23'){const cash=raw.webull.cashAccounts.cash_accounts[0];raw.webull.cashTransactions[cash.id]={cash_account_transactions:[{id:765432,cash_account_id:cash.id,date_time:d+'T12:00:00Z',amount:1,description:hidden,foreign_identifier:hidden,cash_account_transaction_type:{name:'DEPOSIT'}}]};}return[d,raw];
 }))),{mode:0o600});
 const script=path.join(root,'exercise.mjs');fs.writeFileSync(script,`
  import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
  import {produceReportPeriod,reportFailureCode} from './scripts/fee-report-producer.mjs';import {dailyReportPlan} from './scripts/fee-report-period.mjs';import {parseSourceJson} from './scripts/fee-cloud-source.mjs';
  const dir=path.dirname(process.env.SYNTHETIC_SNAPSHOTS),snapshots=JSON.parse(fs.readFileSync(process.env.SYNTHETIC_SNAPSHOTS)),out=path.join(dir,'out');fs.mkdirSync(out,{mode:0o700});let reads=0,checks=0,cleanups=0;
  const readOnce=async d=>{reads++;const raw=structuredClone(snapshots[d]);for(const p of Object.values(raw)){for(const k of ['performance','cashAccounts','previousPerformance'])if(p[k])p[k]=parseSourceJson(JSON.stringify(p[k]));for(const k of ['cashTransactions','cashLedgerHistory'])if(p[k])p[k]=Object.fromEntries(Object.entries(p[k]).map(([id,v])=>[id,parseSourceJson(JSON.stringify(v))]));}return raw;};
  try{await produceReportPeriod({plan:dailyReportPlan('2026-10-23',['NYSE','NASDAQ'],{periodFrom:'2026-10-21',reviewedSyncDate:'2026-10-23'}),reviewedSyncDate:'2026-10-23',outputDir:out,benchmarkFile:process.env.SYNTHETIC_BENCHMARK,readOnce,fetchEconomic:async()=>({envelopeVersion:4,sourcePath:process.env.FEE_ECON_FILE,async checkCurrent(){checks++;},cleanup(){cleanups++;}})});assert.fail('expected unresolved flow');}
  catch(error){assert.equal(reportFailureCode(error),'FEE_CLOUD_WRITER_REPORT_METADATA_INVALID');assert.equal(error.message,'FEE_CLOUD_WRITER_REPORT_METADATA_INVALID');assert.equal(Object.hasOwn(error,'cause'),false);assert.deepEqual(fs.readdirSync(out),[]);assert.equal(reads,6);assert.equal(checks,2);assert.equal(cleanups,1);console.error(reportFailureCode(error));process.exitCode=1;}
 `);
 const clock=path.join(dir,'clock.mjs');fs.writeFileSync(clock,`const RealDate=Date,now=RealDate.parse('2026-10-26T06:00:00Z');globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};let attempts=0;globalThis.fetch=async()=>{attempts++;throw Error('OFFLINE_UNMOCKED_FETCH_FORBIDDEN');};process.on('exit',()=>{if(attempts)process.exitCode=97;});`);
 const child=spawnSync(process.execPath,[script],{cwd:root,encoding:'utf8',timeout:30000,env:{...process.env,NODE_OPTIONS:[process.env.NODE_OPTIONS||'','--import='+clock].join(' ').trim(),GITHUB_RUN_ID:'123',GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ATTEMPT:'1',FEE_DATA_KEY:key.toString('base64url'),FEE_ECON_FILE:econ,IB_MANAGER_READ_ENABLED:'',FEE_STYLE_INPUT_FILE:'',FEE_MANAGEMENT_INPUT_FILE:'',SYNTHETIC_SNAPSHOTS:snapshots,SYNTHETIC_BENCHMARK:benchmark}});
 assert.equal(child.status,1,child.stderr);assert.equal(child.stdout,'');assert.equal(fs.readFileSync(path.join(root,'data.json'),'utf8'),original);
 assert.equal(child.stderr.trim().split('\n').length,2,child.stderr);assert.equal(child.stderr.trim().split('\n').at(-1),'FEE_CLOUD_WRITER_REPORT_METADATA_INVALID');assert.equal(child.stderr.includes(hidden),false);
 const projection=safeProducerFailureSummary(child.stderr);
 assert.deepEqual(projection.diagnostic,{schema:'fee-console.writer-diagnostic.v1',code:'FEE_CLOUD_WRITER_REPORT_METADATA_INVALID',stage:'WRITER',termination:'EXIT',reportTarget:'2026-10-23',processingDate:'2026-10-23',processingIndex:3});
 const workflow=fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml',import.meta.url),'utf8');
 const failureScript=workflow.match(/node --input-type=module - \"\$error_file\" <<'NODE'\n([\s\S]+?)\n          NODE/)[1];
 const prefix=WRITER_DIAGNOSTIC_PREFIX,code=projection.code,line=prefix+JSON.stringify(projection.diagnostic);
 for(const [name,stderr,wantDiagnostic,wantCode=code] of [
   ['valid',hidden+'\n'+child.stderr,true],
   ['duplicate',line+'\n'+child.stderr,false],
   ['extra-property',prefix+JSON.stringify({...projection.diagnostic,account:hidden})+'\n'+code+'\n',false],
   ['wrong-date',prefix+JSON.stringify({...projection.diagnostic,processingDate:'2026-10-24'})+'\n'+code+'\n',false],
   ['unknown-code','FEE_CLOUD_WRITER_PRIVATE_CANARY\n',false,'FEE_CLOUD_FAILED'],
   ['overflow','x'.repeat(65537)+'\n'+code+'\n',false,'FEE_CLOUD_FAILED'],
 ]) {
   const privateFile=path.join(dir,name+'.stderr'),summary=path.join(dir,name+'.summary');fs.writeFileSync(privateFile,stderr,{mode:0o600});fs.writeFileSync(summary,'',{mode:0o600});
   const result=spawnSync(process.execPath,['--input-type=module','-',privateFile],{cwd:new URL('..',import.meta.url),input:failureScript,encoding:'utf8',env:{PATH:process.env.PATH,GITHUB_STEP_SUMMARY:summary}});
   assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');
   const publicText=result.stdout+fs.readFileSync(summary,'utf8');
   for(const value of ['PRIVATE_CANARY','123456.78','opaque','/private/path'])assert.equal(publicText.includes(value),false);
   assert.equal(result.stdout.includes('fee-console.writer-diagnostic.v1'),wantDiagnostic);
   assert.equal(result.stdout.trim().split('\n').at(-1),wantCode);
 }
});
