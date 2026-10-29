import './fee-gift-registry-status.test.mjs';
import './fee-source-acceptance.test.mjs';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {CLOUD_ACCOUNTS,parseSourceJson} from './fee-cloud-source.mjs';
import {dailyPublicationPreflight,managedTransferIdentitiesFromFund,periodBenchmark,captureReportRange,publishedReportMatches,reportPublicationPreflight as nativeReportPreflight,readPeriodSourceAttempts,reportPublicationWatch,explicitReportPlan,periodIbRetryAllowed,readPeriodRetryRuns,assertPeriodIbRecheckUnchanged,reviewedSyncConfirmation,sourceAttemptWindowStart,produceReportPeriod,reportFailureCode,reviewedRecoveryConfirmation,readReportRecoveryRelease,validateReportRecoveryEvidence,authorizeReportRecovery} from './fee-report-producer.mjs';
import {producerFailureCode} from './fee-cloud-producer.mjs';
import {SourceFetchError} from './fee-economic-source.mjs';
import {dailyReportPlan,weeklyReportPlan,monthlyReportPlan,reportAddDays} from './fee-report-period.mjs';
import {HEALTH_SCHEMA,validateHealth} from './fee-data-health.mjs';

// Default fetch is forbidden for the entire suite. Individual wire mocks may
// replace it temporarily, but a forgotten injection must fail even if product
// code catches the error. No real request is sent by this tripwire.
const originalDefaultFetch=globalThis.fetch;
let unmockedFetchAttempts=0;
globalThis.fetch=async()=>{unmockedFetchAttempts++;throw Error('OFFLINE_UNMOCKED_FETCH_FORBIDDEN');};
after(()=>{globalThis.fetch=originalDefaultFetch;assert.equal(unmockedFetchAttempts,0,'every network dependency must have an explicit offline mock');});

test('period diagnostics retain only literal noncash failures and fixed stages',()=>{
 const module=fs.readFileSync(new URL('./fee-sharesight-transfers.mjs',import.meta.url),'utf8');
 const codes=new Set([...module.matchAll(/fail\('([A-Z_]+)'\)/g)].map(m=>m[1]));
 assert.equal(codes.size,20);
 for(const code of codes){
  const error=Error('FEE_NONCASH_'+code),fixed='FEE_CLOUD_STAGE_SOURCE_READ_NONCASH_'+code;
  assert.equal(reportFailureCode(error,'SOURCE_READ'),fixed);
  assert.equal(reportFailureCode(Error(fixed)),fixed); // outer CLI must not erase it again
 }
 const hidden='PRIVATE_CANARY amount=123456.78 account=synthetic-private /private/location \u001b[31m\r\n';
 for(const message of [hidden,'FEE_NONCASH_'+hidden,'FEE_NONCASH_NOT_A_REGISTERED_CODE','FEE_NONCASH_POSITION_DELTA\n'+hidden]){
  assert.equal(reportFailureCode(Error(message),'SOURCE_READ'),'FEE_CLOUD_STAGE_SOURCE_READ_UNKNOWN');
 }
 assert.equal(reportFailureCode(Error('FEE_NONCASH_POSITION_DELTA'),hidden),'FEE_CLOUD_STAGE_UNKNOWN_NONCASH_POSITION_DELTA');
 for(const [error,category] of [[new TypeError(hidden),'TYPE'],[new RangeError(hidden),'RANGE'],[new SyntaxError(hidden),'SYNTAX'],[new ReferenceError(hidden),'REFERENCE']]){
  assert.equal(reportFailureCode(error,'SOURCE_READ'),'FEE_CLOUD_STAGE_SOURCE_READ_'+category);
 }
 assert.equal(reportFailureCode(new SourceFetchError('SOURCE_HTTP'),'ECONOMIC_READ'),'SOURCE_HTTP');
 for(const code of ['SOURCE_HTTP','SOURCE_FORBIDDEN','SOURCE_HTTP_PRIVATE_CANARY']){
  assert.equal(reportFailureCode(Error(code),'ECONOMIC_READ'),'FEE_CLOUD_STAGE_ECONOMIC_READ_UNKNOWN');
  assert.equal(reportFailureCode(Object.assign(Error(code),{name:'SourceFetchError'}),'ECONOMIC_READ'),'FEE_CLOUD_STAGE_ECONOMIC_READ_UNKNOWN');
 }
 assert.equal(reportFailureCode(Error('FEE_REPORT_SOURCE_UNSTABLE'),'SOURCE_READ'),'FEE_REPORT_SOURCE_UNSTABLE');
 assert.equal(reportFailureCode(Error('FEE_CLOUD_CASH_BALANCE_STALE'),'SOURCE_READ'),'FEE_CLOUD_CASH_BALANCE_STALE');
 assert.equal(producerFailureCode(Error('FEE_NONCASH_POSITION_DELTA'),'SOURCE_READ'),'FEE_CLOUD_STAGE_SOURCE_READ_NONCASH_POSITION_DELTA');
});

test('actual period error path preserves source/economic stage without IO, candidate or private exception text',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-period-diagnostic-'));fs.chmodSync(dir,0o700);
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const oldKey=process.env.FEE_DATA_KEY,key=crypto.randomBytes(32),iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);
 const bytes=Buffer.from(JSON.stringify({enc:true,v:3,data:Buffer.concat([iv,c.update(JSON.stringify({daily:[{d:'2026-10-22'}]})),c.final(),c.getAuthTag()]).toString('base64')}));
 const source=path.join(dir,'base.json'),benchmark=path.join(dir,'benchmark.json');fs.writeFileSync(source,bytes,{mode:0o600});
 fs.writeFileSync(benchmark,JSON.stringify(cache),{mode:0o600});process.env.FEE_DATA_KEY=key.toString('base64url');
 t.after(()=>{if(oldKey===undefined)delete process.env.FEE_DATA_KEY;else process.env.FEE_DATA_KEY=oldKey;});
 let network=0;const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{network++;throw Error('network forbidden in synthetic test');};t.after(()=>globalThis.fetch=oldFetch);
 const hidden='PRIVATE_CANARY source/body/account/123456.78 \u001b[31m';
 const cases=[
  ['economic',Error(hidden),'FEE_CLOUD_STAGE_ECONOMIC_READ_UNKNOWN'],
  ['economic',new SourceFetchError('SOURCE_FORBIDDEN'),'SOURCE_FORBIDDEN'],
  ['source',Error('FEE_NONCASH_POSITION_DELTA'),'FEE_CLOUD_STAGE_SOURCE_READ_NONCASH_POSITION_DELTA'],
  ['source',Error('FEE_NONCASH_SOURCE_MARK'),'FEE_CLOUD_STAGE_SOURCE_READ_NONCASH_SOURCE_MARK'],
  ['source',Error(hidden),'FEE_CLOUD_STAGE_SOURCE_READ_UNKNOWN'],
  ['source',new TypeError(hidden),'FEE_CLOUD_STAGE_SOURCE_READ_TYPE'],
  ['source',Error('FEE_CLOUD_SOURCE_INCOMPLETE'),'FEE_CLOUD_SOURCE_INCOMPLETE'],
 ];
 for(const [index,[phase,error,expected]]of cases.entries()){
  const out=path.join(dir,'out'+index);fs.mkdirSync(out,{mode:0o700});let reads=0,cleaned=0;
  await assert.rejects(produceReportPeriod({plan:weeklyReportPlan('2026-10-23'),now:new Date('2026-10-26T06:00:00Z'),sourceFile:source,outputDir:out,benchmarkFile:benchmark,
   fetchEconomic:async()=>{if(phase==='economic')throw error;return{envelopeVersion:4,cleanup(){cleaned++;}};},
   readOnce:async()=>{reads++;throw error;}}),actual=>{assert.equal(actual.message,expected);assert.equal(reportFailureCode(actual),expected);assert.equal(actual instanceof SourceFetchError,error instanceof SourceFetchError);assert.equal(actual.message.includes(hidden),false);assert.equal(Object.hasOwn(actual,'cause'),false);return true;});
  assert.equal(reads,phase==='source'?1:0);assert.equal(cleaned,phase==='source'?1:0);
  assert.deepEqual(fs.readdirSync(out),[]);assert.deepEqual(fs.readFileSync(source),bytes);
 }
 assert.equal(network,0);
});

function syntheticFundTransfer(){
 const gid='a'.repeat(32),key=crypto.randomBytes(32),iv=crypto.randomBytes(12),date='2026-10-27';
 const sourceKeys=Array.from({length:7},(_,i)=>`sharesight:${200+i}->${300+i};holding:${400+i}`);
 const event={id:'synthetic-inkind-group',date,investorId:'B',grossCents:700,feeCents:0,netCents:700,priceDate:date,priceTotalCents:10000,issuedShares:70,sourceRef:'sharesight:synthetic-group',inKindClose:{sourceKeys,sourceBinding:{sourcePortfolioId:2,destinationPortfolioId:1,sourceHoldingIds:Array.from({length:7},(_,i)=>500+i)}}};
 const bundle={schema:'fee-console.fund-remote.v1',gid,updatedAt:'2026-10-28T00:00:00.000Z',profile:{schema:'fee-console.fund-profile.v1',manager:'Synthetic Manager',fundName:'Synthetic Fund',inceptionDate:'2026-10-01',inceptionNoticeDate:'2026-10-01',currency:'USD',initialShares:1000,investors:[{id:'A',name:'Synthetic A',shares:900},{id:'B',name:'Synthetic B',shares:100}],subscriptions:[event]},library:{}};
 const seal=()=>{const c=crypto.createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([iv,c.update(JSON.stringify(bundle)),c.final(),c.getAuthTag()]).toString('base64');return JSON.stringify({enc:true,v:1,data});};
 const economic={fundProfileRaw:seal(),fundProfileStable:true,fundProfileMatchesGist:value=>value===gid};
 return {bundle,key:key.toString('base64url'),economic,seal,date};
}
test('actual period input helper decrypts only the existing same-Gist fund file and selects exact dated identity pairs',()=>{
 const f=syntheticFundTransfer(),r=managedTransferIdentitiesFromFund(f.economic,f.key,f.date);assert.equal(r.pairs.length,7);assert.deepEqual(r.pairs[0],{sourceTradeId:200,sourceHoldingId:500,tradeId:300,holdingId:400});assert.equal(r.date,f.date);assert.equal(r.account,'webull');assert.equal(managedTransferIdentitiesFromFund(f.economic,f.key,'2026-10-28'),null);assert.equal(managedTransferIdentitiesFromFund({},f.key,f.date),null);
});
test('wrong key/Gist, unstable encrypted file, missing binding and profile identity mismatch stop before Sharesight',()=>{
 for(const mutate of [f=>f.key=crypto.randomBytes(32).toString('base64url'),f=>{f.bundle.gid='b'.repeat(32);f.economic.fundProfileRaw=f.seal();},f=>f.economic.fundProfileStable=false,f=>{delete f.bundle.profile.subscriptions[0].inKindClose.sourceBinding;f.economic.fundProfileRaw=f.seal();},f=>{f.bundle.profile.subscriptions[0].investorId='ManagerLabel';f.economic.fundProfileRaw=f.seal();},f=>{f.bundle.profile.subscriptions[0].inKindClose.approved=true;f.economic.fundProfileRaw=f.seal();},f=>f.economic.fundProfileRaw=f.economic.fundProfileRaw.slice(0,-2)]){const f=syntheticFundTransfer();mutate(f);assert.throws(()=>managedTransferIdentitiesFromFund(f.economic,f.key,f.date),/^Error: FEE_REPORT_FUND_TRANSFER_INPUT_UNVERIFIED$/);}
});

// Existing preflight scenarios isolate unrelated public attempt metadata.
const reportPublicationPreflight = args=>nativeReportPreflight({readSourceAttempts:async()=>({attempts:0,inProgress:false}),...args});

const cache={v:1,benchmarks:{spy: {symbol:'SPY',currency:'USD',exchange:'NYSEArca',series:[{d:'2026-10-22',p:100},{d:'2026-10-23',p:101,div:1}]},qqq: {symbol:'QQQ',currency:'USD',exchange:'NasdaqGS',series:[{d:'2026-10-22',p:200},{d:'2026-10-23',p:202}]}}};
test('real daily preflight waits at10:30, continues the same target at13:00 and keeps bounded source attempts',async()=>{
 const old=state(weeklyReportPlan('2026-10-23')),markets=['NYSE','LSE','SIX','EURONEXT_PARIS'],args={markets,ibEnabled:false,readState:async()=>old,readSourceAttempts:async()=>({attempts:0,inProgress:false})};
 const first=await dailyPublicationPreflight({...args,now:new Date('2026-10-28T10:30:00+08:00')});assert.equal(first.outcome,'waiting');assert.equal(first.reasonCode,'ACCOUNTING_DAY_NOT_COMPLETE');
 const next=await dailyPublicationPreflight({...args,now:new Date('2026-10-28T13:00:00+08:00')});assert.equal(next.outcome,'produce');assert.equal(next.plan.accountingThrough,'2026-10-27');assert.equal(next.plan.periodFrom,'2026-10-24');assert.equal(next.plan.kind,'daily');
 assert.equal((await dailyPublicationPreflight({...args,now:new Date('2026-10-28T14:00:00+08:00'),readSourceAttempts:async()=>({attempts:2,inProgress:false})})).reasonCode,'REPORT_SOURCE_ATTEMPT_BUDGET_EXHAUSTED');
 assert.equal((await dailyPublicationPreflight({...args,now:new Date('2026-10-28T13:00:00+08:00'),runAttempt:'2'})).reasonCode,'REPORT_SOURCE_RERUN_NOT_ALLOWED');
 for(const scope of [[],['NYSE','EURONEXT']])assert.equal((await dailyPublicationPreflight({...args,markets:scope,now:new Date('2026-10-28T13:00:00+08:00'),readState:()=>assert.fail('unresolved market must not access source state')})).reasonCode,'CALENDAR_SCOPE_UNVERIFIED');
});
test('known US session permits only the reviewed one-off calendar qualifier; scheduled scope stays unchanged',async()=>{
 const r=await dailyPublicationPreflight({markets:['NYSE','NASDAQ'],targetDate:'2026-10-27',now:new Date('2026-10-28T13:00:00+08:00'),ibEnabled:false,readState:async()=>state(weeklyReportPlan('2026-10-23')),readSourceAttempts:async()=>({attempts:0,inProgress:false})});
 assert.equal(r.outcome,'produce');assert.equal(r.plan.accountingThrough,'2026-10-27');assert.deepEqual(r.plan.markets,['NASDAQ','NYSE']);
 const workflow=fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml',import.meta.url),'utf8');
 const expression=workflow.match(/REVIEWED_MARKETS:\s*\$\{\{([^\n]+)\}\}/)[1];
 const qualifier=Function('github','inputs','return ('+expression+');');
 assert.equal(qualifier({event_name:'schedule'},{run_reviewed_once:true,report_markets:'NYSE'}),'');
 assert.equal(qualifier({event_name:'workflow_dispatch'},{run_reviewed_once:false,report_markets:'NYSE'}),'');
 assert.equal(qualifier({event_name:'workflow_dispatch'},{run_reviewed_once:true,report_markets:'NYSE'}),'NYSE');
 for(const args of [['--mode=produce','--report-kind=daily','--report-target=2026-10-27'],['--mode=preflight','--report-kind=weekly','--report-target=2026-10-23'],['--mode=preflight']]){
  const result=spawnSync(process.execPath,[new URL('./fee-report-producer.mjs',import.meta.url).pathname,...args,'--report-markets=NYSE'],{encoding:'utf8',env:{PATH:process.env.PATH}});
  assert.equal(result.status,1);assert.match(result.stderr,/FEE_REPORT_ARGUMENT/);
 }
});
function cashOnly(date){
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
function state(plan,checkedAt='2026-10-25T01:00:00Z'){
  const data=Buffer.from(JSON.stringify({enc:true,v:3,data:Buffer.alloc(64).toString('base64')}));
  return {mainSha:'a'.repeat(40),finalMainSha:'a'.repeat(40),data,pending:false,health:{schema:HEALTH_SCHEMA,checkedAt,targetDate:plan.accountingThrough,sourceDates:{schwab:plan.accountingThrough,webull:plan.accountingThrough,benchmark:plan.priceThrough},outcome:'updated',errorCode:null,dataSha256:crypto.createHash('sha256').update(data).digest('hex')}};
}
test('IB period retry is bounded by fixed schedule, candidate wait and original freshness',async()=>{
  const plan=weeklyReportPlan('2026-10-23'),now=new Date('2026-10-25T01:15Z'),s=state(plan,'2026-10-24T16:05Z');
  const run=id=>({id,path:'.github/workflows/fee-cloud-producer.yml',head_branch:'main',head_sha:'a'.repeat(40),event:'schedule',created_at:'2026-10-24T16:00Z'});
  const args={plan,now,ibEnabled:true,currentRunId:'2',readState:async()=>s,readRetryRuns:async()=>[run(1),run(2)]};
  assert.equal((await reportPublicationPreflight(args)).reasonCode,'IB_BOUNDED_SAME_PERIOD_RECHECK');
  assert.equal((await reportPublicationPreflight({...args,readRetryRuns:async()=>[run(1),run(2),run(3)]})).outcome,'already-published');
  assert.equal((await reportPublicationPreflight({...args,readState:async()=>({...s,pending:true})})).outcome,'candidate-pending');
  assert.equal((await reportPublicationPreflight({...args,readRetryRuns:async()=>{throw Error('private-canary');}})).outcome,'already-published');
  assert.equal((await reportPublicationPreflight({...args,now:new Date('2026-10-26T01:15Z')})).outcome,'already-published');
  assert.equal((await reportPublicationPreflight({...args,ibEnabled:false,readRetryRuns:async()=>assert.fail('disabled must not list runs')})).outcome,'already-published');
  for(const runs of [[],[run(1),run(1)],[{...run(1),path:'other'}],[{...run(1),head_branch:'other'}],[{...run(1),created_at:'2026-10-24T15:00Z'}]])assert.equal(periodIbRetryAllowed({runs,scheduledAt:plan.scheduledAt,now,currentRunId:2}),false);
  // A refreshed second health receipt cannot reset the fixed run budget.
  assert.equal((await reportPublicationPreflight({...args,readState:async()=>state(plan,'2026-10-25T01:00Z'),currentRunId:'3',readRetryRuns:async()=>[run(1),run(2),run(3)]})).outcome,'already-published');
});
test('IB retry metadata uses one public fixed route, bounded complete pages, no secrets or logs',async()=>{
  const workflow=fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml',import.meta.url),'utf8');
  assert.match(workflow.slice(workflow.indexOf('  period:'),workflow.indexOf('  produce:')),/IB_MANAGER_READ_ENABLED: \$\{\{ vars.IB_MANAGER_READ_ENABLED \}\}/);
  const now=new Date('2026-10-25T01:15Z');let calls=0;
  const response=(url,value)=>{const r=new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;};
  const fetchImpl=async(url,init)=>{calls++;assert.match(url,/^https:\/\/api.github.com\/repos\/huanwujoy-crypto\/fee-console\/actions\/workflows\/fee-cloud-producer.yml\/runs\?/);assert.equal(init.headers.Authorization,undefined);assert.equal(init.redirect,'error');return response(url,{total_count:0,workflow_runs:[]});};
  assert.deepEqual(await readPeriodRetryRuns({scheduledAt:'2026-10-25T00:00:00+08:00',now,fetchImpl}),[]);assert.equal(calls,1);
  await assert.rejects(readPeriodRetryRuns({scheduledAt:'2026-10-25T00:00:00+08:00',now,fetchImpl:async url=>response(url,{total_count:101,workflow_runs:[]})}),/IB_RETRY_METADATA/);
});
test('same-period IB recheck forbids any fee, benchmark, ledger, report lock or unknown field change',()=>{
  const before={daily:[{d:'2026-10-23',schwab:100,webull:100,spy:100}],feeCalculationReceipt:{receiptId:'a'.repeat(64)},feeReportMonthLocks:{schema:'synthetic'},feeReportPublication:{reportId:'b'.repeat(64)},flowsAuto:[],privateEconomic:{version:4}};
  assert.doesNotThrow(()=>assertPeriodIbRecheckUnchanged(before,{...before,ibManagerSourceStatus:{state:'pending'},updatedAt:'2026-10-25T01:00Z'}));
  for(const change of [x=>x.daily[0].schwab++,x=>x.daily[0].spy++,x=>x.feeCalculationReceipt.receiptId='b'.repeat(64),x=>x.feeReportMonthLocks.schema='changed',x=>x.feeReportPublication.reportId='c'.repeat(64),x=>x.flowsAuto.push({}),x=>x.privateEconomic.version=5,x=>x.ibManagerArbitrary='must not escape strict allowlist']){
    const after=structuredClone(before);change(after);assert.throws(()=>assertPeriodIbRecheckUnchanged(before,after),/IB_RECHECK_CHANGED_FEE_DATA/);
  }
});
test('closed sessions carry only the last reviewed common close, without repeating dividends',()=>{
  assert.deepEqual(periodBenchmark(cache,'2026-10-24'),{sourceDate:'2026-10-23',state:'closed',spy:101,spyd:0,qqq:202,qqqd:0});
  assert.equal(periodBenchmark(cache,'2026-10-23').spyd,1);
  assert.throws(()=>periodBenchmark(cache,'2026-10-26'),/BENCHMARK_PENDING/);
});
test('whole range is double-read in order; identical end-day alone cannot hide an earlier correction',async()=>{
  const dates=['2026-10-22','2026-10-23'],calls=[];
  const out=await captureReportRange({dates,cache,readOnce:async d=>{calls.push(d);return cashOnly(d);}});
  assert.deepEqual(calls,[...dates,...dates]);assert.equal(out.length,2);assert.equal(out[0].flows.length,0);
  let n=0;
  await assert.rejects(captureReportRange({dates,cache,readOnce:async d=>{
    const raw=cashOnly(d);
    if(++n===3){
      const instrument={id:500,code:'SYNTH',market_code:'NYSE',currency_code:'USD'},portfolio={id:CLOUD_ACCOUNTS.schwab.portfolioId,name:CLOUD_ACCOUNTS.schwab.name};
      const holding={id:500,quantity:1,value:1,valid_position:true,instrument,instrument_currency:{code:'USD'},portfolio};
      raw.schwab.performance.report.holdings=[holding];raw.schwab.performance.report.value=101;
      raw.schwab.performance=parseSourceJson(JSON.stringify(raw.schwab.performance));
      raw.schwab.holdings={holdings:[{...holding,inception_date:reportAddDays(d,-1)}]};
    }
    return raw;
  }}),/FEE_REPORT_SOURCE_UNSTABLE/);
  await assert.rejects(captureReportRange({dates:['2026-10-22','2026-10-24'],cache,readOnce:async()=>assert.fail('gap must not read')}),/RANGE/);
});
test('weekly coverage stays valid between reports without weakening fresh candidate health',()=>{
  const p=weeklyReportPlan('2026-10-23'),s=state(p),now=new Date('2026-10-30T06:00Z');
  assert.equal(publishedReportMatches(s,p,now),true);assert.ok(validateHealth(s.health,{now}).includes('health receipt age'));
  for(const mutate of [s=>s.health.dataSha256='b'.repeat(64),s=>s.finalMainSha='b'.repeat(40),s=>s.health.checkedAt='2026-10-24T12:00Z',s=>s.health.sourceDates.webull='2026-10-22',s=>s.data=Buffer.from('{}')]){const bad=state(p);mutate(bad);assert.equal(publishedReportMatches(bad,p,now),false);}
  const month=monthlyReportPlan('2026-10'),early=state(month,'2026-10-31T22:00Z');
  assert.deepEqual(validateHealth(early.health,{now:new Date(early.health.checkedAt)}),[]);
  assert.equal(publishedReportMatches(early,month,new Date('2026-11-01T06:00Z')),false);
  assert.equal(publishedReportMatches(state(month,'2026-11-01T06:00Z'),month,new Date('2026-11-01T07:00Z')),true);
});
test('public preflight deduplicates exact accounting target, waits for incomplete month and never rolls back',async()=>{
  const plan=weeklyReportPlan('2026-10-23');let reads=0;
  assert.equal((await reportPublicationPreflight({plan,now:new Date('2026-10-26T00:00Z'),readState:async()=>{reads++;return state(plan);}})).outcome,'already-published');assert.equal(reads,1);
  const old=state(weeklyReportPlan('2026-10-16'),'2026-10-18T01:00Z');
  assert.equal((await reportPublicationPreflight({plan,now:new Date('2026-10-26T00:00Z'),readState:async()=>old})).outcome,'produce');
  assert.equal((await reportPublicationPreflight({plan,now:new Date('2026-10-26T00:00Z'),readState:async()=>({...old,pending:true})})).outcome,'candidate-pending');
  const monthly=monthlyReportPlan('2026-10');
  assert.equal((await reportPublicationPreflight({plan:monthly,now:new Date('2026-10-31T16:00Z'),readState:async()=>state(plan)})).reasonCode,'ACCOUNTING_DAY_NOT_COMPLETE');
  await assert.rejects(reportPublicationPreflight({plan,now:new Date('2026-11-02T00:00Z'),readState:async()=>state(monthly,'2026-11-01T06:00Z')}),/HISTORY_AHEAD/);
  assert.equal(explicitReportPlan('weekly','2026-07-31').kind,'weekly-monthly');
  assert.throws(()=>explicitReportPlan('monthly','2026-10-23'),/TARGET/);
  assert.equal((await reportPublicationPreflight({plan,now:new Date('2026-10-30T00:00Z'),readState:async()=>old})).outcome,'recovery-required');
});
test('period watchdog accepts existing cycle coverage but rejects missing publication with explicit offline attempt metadata',async t=>{
  let calls=0;const priorFetch=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{
    calls++;assert.match(url,/^https:\/\/api\.github\.com\/repos\/huanwujoy-crypto\/fee-console\/actions\/workflows\/fee-cloud-producer\.yml\/runs\?/);
    assert.equal(init.method,'GET');assert.equal(init.headers.Authorization,undefined);assert.equal(init.redirect,'error');
    const r=new Response(JSON.stringify({total_count:0,workflow_runs:[]}),{headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;
  };t.after(()=>globalThis.fetch=priorFetch);
  const p=weeklyReportPlan('2026-10-23');
  assert.equal((await reportPublicationWatch({...state(p),now:new Date('2026-10-28T00:00Z')})).outcome,'already-published');
  assert.equal(calls,0);
  await assert.rejects(reportPublicationWatch({...state(weeklyReportPlan('2026-10-16'),'2026-10-18T00:00Z'),now:new Date('2026-10-26T00:00Z')}),/PUBLISHED_PERIOD_MISSING/);
  assert.equal(calls,1);
});
test('real period preflight CLI makes only public main GETs and never enters financial sources',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-period-gate-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const s=state(weeklyReportPlan('2026-10-23')),trace=path.join(dir,'trace.json'),preload=path.join(dir,'public-preload.mjs');
  fs.writeFileSync(preload,`import fs from 'node:fs';const D=Date,now=D.parse('2026-10-26T06:00:00Z');globalThis.Date=class extends D{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}};
    const calls=[],data=${JSON.stringify(s.data.toString())},health=${JSON.stringify(s.health)};
    globalThis.fetch=async(url,init={})=>{url=String(url);calls.push(url);fs.writeFileSync(${JSON.stringify(trace)},JSON.stringify(calls));if(init.method&&init.method!=='GET')throw Error('unexpected method');
    const prefix='https://api.github.com/repos/huanwujoy-crypto/fee-console/';if(!url.startsWith(prefix))throw Error('financial or unknown route refused');const route=url.slice(prefix.length);let value;
    if(route==='git/ref/heads/main')value={object:{sha:'a'.repeat(40)}};else if(route.startsWith('contents/')){const text=route.startsWith('contents/data.json?')?data:route.startsWith('contents/fee-data-health.json?')?JSON.stringify(health):null;if(text===null)throw Error('unknown public file');value={type:'file',encoding:'base64',size:Buffer.byteLength(text),content:Buffer.from(text).toString('base64')};}else if(route.startsWith('git/matching-refs/heads/'))value=[];else throw Error('unknown public route');
    const response=new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});Object.defineProperty(response,'url',{value:url});return response;};`);
  const r=spawnSync(process.execPath,['--import',preload,new URL('./fee-report-producer.mjs',import.meta.url).pathname,'--mode=preflight','--report-kind=weekly','--report-target=2026-10-23'],{encoding:'utf8',env:{PATH:process.env.PATH,FEE_DATA_KEY:'must-not-be-used',FEE_ECON_GIST_ID:'must-not-be-used',FEE_CLOUD_SHARESIGHT_CLIENT_ID:'must-not-be-used',FEE_CLOUD_SHARESIGHT_CLIENT_SECRET:'must-not-be-used'}});
  assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).outcome,'already-published');assert.doesNotMatch(r.stdout,/must-not-be-used|"enc"|"data"/);
  const calls=JSON.parse(fs.readFileSync(trace));assert.ok(calls.length>=4);assert.ok(calls.every(u=>u.startsWith('https://api.github.com/repos/huanwujoy-crypto/fee-console/')));
});
test('period producer uses actual sole writer, receipt reporter and health; original ciphertext and fees stay intact',async t=>{
 for(const reviewed of [false,true])await t.test(reviewed?'reviewed early daily':'original weekly',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-period-synthetic-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const root=path.join(dir,'checkout');fs.mkdirSync(root,{mode:0o700});fs.cpSync(new URL('.',import.meta.url),path.join(root,'scripts'),{recursive:true});
  fs.mkdirSync(path.join(root,'claude'));fs.copyFileSync(new URL('../claude/fee-style-mapping.json',import.meta.url),path.join(root,'claude/fee-style-mapping.json'));
  const key=crypto.randomBytes(32),encrypt=(o,v)=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);return JSON.stringify({enc:true,v,data:Buffer.concat([iv,c.update(JSON.stringify(o)),c.final(),c.getAuthTag()]).toString('base64')});};
  const data={daily:[{d:'2026-10-21',schwab:100,webull:100,cash:200,stock:0,other:0,spy:100,qqq:200,bd:'2026-10-21',bstate:'session',acctCash:{schwab:100,webull:100}}],flowsAuto:[],flowsUnresolved:[],status:{asOf:'2026-10-21',provisional:false,calibrated:false,unresolvedCount:0,notes:[],splitDelta:0}};
  const original=encrypt(data,3);fs.writeFileSync(path.join(root,'data.json'),original);
  const econ=path.join(dir,'econ.json');fs.writeFileSync(econ,encrypt({v:4,settings:{start:'2026-10-21',mgmt:2,carry:20},accounts:[{id:'schwab',opening:100},{id:'webull',opening:100}],months:[],fees:[]},4),{mode:0o600});
  const benchmarkFile=path.join(dir,'bench.json');fs.writeFileSync(benchmarkFile,JSON.stringify(cache));
  const snapshots=path.join(dir,'snapshots.json');fs.writeFileSync(snapshots,JSON.stringify(Object.fromEntries(['2026-10-22','2026-10-23'].map(d=>[d,cashOnly(d)]))),{mode:0o600});
  const script=path.join(root,'exercise.mjs');fs.writeFileSync(script,`
    import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
    import {produceReportPeriod} from './scripts/fee-report-producer.mjs';import {weeklyReportPlan,dailyReportPlan} from './scripts/fee-report-period.mjs';import {parseSourceJson} from './scripts/fee-cloud-source.mjs';import {decryptCandidate} from './scripts/fee-cloud-producer.mjs';import {validateFeeCalculationReceiptWithEcon} from './scripts/fee-receipt-core.mjs';
    const plan=${reviewed}?dailyReportPlan('2026-10-23',['NYSE','NASDAQ'],{periodFrom:'2026-10-22',reviewedSyncDate:'2026-10-23'}):weeklyReportPlan('2026-10-23'),reviewedSyncDate=${reviewed}?'2026-10-23':null;
    const dir=path.dirname(process.env.SYNTHETIC_SNAPSHOTS),snapshots=JSON.parse(fs.readFileSync(process.env.SYNTHETIC_SNAPSHOTS)),out=path.join(dir,'out');fs.mkdirSync(out,{mode:0o700});let calls=0,checks=0,cleanups=0;
    const r=await produceReportPeriod({plan,reviewedSyncDate,outputDir:out,benchmarkFile:process.env.SYNTHETIC_BENCHMARK,readOnce:async d=>{calls++;const raw=structuredClone(snapshots[d]);for(const p of Object.values(raw)){for(const key of ['performance','cashAccounts','previousPerformance'])p[key]=parseSourceJson(JSON.stringify(p[key]));for(const key of ['cashTransactions','cashLedgerHistory'])p[key]=Object.fromEntries(Object.entries(p[key]).map(([id,v])=>[id,parseSourceJson(JSON.stringify(v))]));}return raw;},fetchEconomic:async()=>({envelopeVersion:4,sourcePath:process.env.FEE_ECON_FILE,async checkCurrent(){checks++;},cleanup(){cleanups++;}})});
    assert.equal(r.reconstructedDays,2);assert.equal(calls,4);assert.equal(checks,3);assert.equal(cleanups,1);assert.equal(fs.existsSync(path.join(out,'period-private')),false);
    const data=decryptCandidate(r.dataFile,process.env.FEE_DATA_KEY),econ={v:4,settings:{start:'2026-10-21',mgmt:2,carry:20},accounts:[{id:'schwab',opening:100},{id:'webull',opening:100}],months:[],fees:[]};
    assert.deepEqual(data.daily.map(p=>p.d),['2026-10-21','2026-10-22','2026-10-23']);assert.equal(data.feeReportPublication.plan.kind,${reviewed}?'daily':'weekly');assert.equal(data.feeCalculationReceipt.asOf,'2026-10-23');assert.deepEqual(data.feeCalculationReceipt.accountIds,['schwab','webull']);assert.equal(validateFeeCalculationReceiptWithEcon(data.feeCalculationReceipt,data,econ).ok,true);
    assert.equal(fs.statSync(r.dataFile).mode&0o777,0o600);assert.equal(fs.existsSync(r.healthFile),true);
    const repeatedOut=path.join(dir,'repeated');fs.mkdirSync(repeatedOut,{mode:0o700});
    const readOnce=async d=>{const raw=structuredClone(snapshots[d]);for(const p of Object.values(raw)){for(const key of ['performance','cashAccounts','previousPerformance'])p[key]=parseSourceJson(JSON.stringify(p[key]));for(const key of ['cashTransactions','cashLedgerHistory'])p[key]=Object.fromEntries(Object.entries(p[key]).map(([id,v])=>[id,parseSourceJson(JSON.stringify(v))]));}return raw;};
    const repeated=await produceReportPeriod({plan,reviewedSyncDate,sourceFile:r.dataFile,outputDir:repeatedOut,benchmarkFile:process.env.SYNTHETIC_BENCHMARK,readOnce,fetchEconomic:async()=>({envelopeVersion:4,sourcePath:process.env.FEE_ECON_FILE,async checkCurrent(){},cleanup(){}})});
    assert.equal(repeated.outcome,'no-op');assert.deepEqual(fs.readFileSync(repeated.dataFile),fs.readFileSync(r.dataFile));assert.deepEqual(decryptCandidate(repeated.dataFile,process.env.FEE_DATA_KEY).feeCalculationReceipt,data.feeCalculationReceipt);
    const failedOut=path.join(dir,'failed');fs.mkdirSync(failedOut,{mode:0o700});let failureChecks=0;
    await assert.rejects(produceReportPeriod({plan,reviewedSyncDate,outputDir:failedOut,benchmarkFile:process.env.SYNTHETIC_BENCHMARK,readOnce,fetchEconomic:async()=>({envelopeVersion:4,sourcePath:process.env.FEE_ECON_FILE,async checkCurrent(){if(++failureChecks===2)throw Error('synthetic economic revision changed');},cleanup(){}})}));
    assert.equal(fs.existsSync(path.join(failedOut,'data.json')),false);assert.equal(fs.existsSync(path.join(failedOut,'fee-data-health.json')),false);assert.equal(fs.existsSync(path.join(failedOut,'period-private')),false);console.log('SYNTHETIC_PERIOD_CANDIDATE_VERIFIED');
  `);
  // Isolated synthetic subprocess clock only; production has no clock/guard
  // override. Its real writer, reporter and health still enforce every window.
  const clockFile=path.join(dir,'synthetic-clock.mjs');fs.writeFileSync(clockFile,`const RealDate=Date;const now=RealDate.parse('${reviewed?'2026-10-24T00:40:00Z':'2026-10-26T06:00:00Z'}');globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};`);
  const r=spawnSync(process.execPath,[script],{encoding:'utf8',timeout:30000,env:{...process.env,NODE_OPTIONS:'--import='+clockFile,FEE_DATA_KEY:key.toString('base64url'),FEE_ECON_FILE:econ,IB_MANAGER_READ_ENABLED:'',FEE_STYLE_INPUT_FILE:'',FEE_MANAGEMENT_INPUT_FILE:'',SYNTHETIC_SNAPSHOTS:snapshots,SYNTHETIC_BENCHMARK:benchmarkFile}});
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/SYNTHETIC_PERIOD_CANDIDATE_VERIFIED/);assert.equal(fs.readFileSync(path.join(root,'data.json'),'utf8'),original);
 });
});

// Source-attempt budgets read public metadata only. All data is synthetic.
const budgetPlan=weeklyReportPlan('2026-10-30'),budgetNow=new Date('2026-11-01T06:00:00Z');
const budgetRun=(id=1)=>({id,path:'.github/workflows/fee-cloud-producer.yml',head_branch:'main',head_sha:'a'.repeat(40),event:'schedule',created_at:'2026-10-31T16:00:00Z'});
const budgetJob=(run,id=10,name='Produce weekly 2026-10-30')=>({id,run_id:run.id,head_sha:run.head_sha,name,status:'completed',conclusion:'failure',started_at:'2026-10-31T16:01:00Z'});
function budgetWire(runs,jobs,mutate=()=>{}){return async(url,init)=>{assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,undefined);assert.ok(!url.includes('/logs'));let value;if(url.includes('/workflows/fee-cloud-producer.yml/runs?'))value={total_count:runs.length,workflow_runs:runs};else{assert.match(url,/\/runs\/\d+\/jobs\?filter=all&per_page=100$/);value={total_count:jobs.length,jobs};}value=structuredClone(value);mutate(value,url);const r=new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;};}
test('source budget counts all source job attempts, ignores the public gate and other cutoff, and excludes current run',async()=>{const r=budgetRun(),p={...budgetJob(r,12,'period'),conclusion:'success'},different=budgetJob(r,13,'Produce monthly 2026-10-31');assert.deepEqual(await readPeriodSourceAttempts({plan:budgetPlan,now:budgetNow,fetchImpl:budgetWire([r],[p,different,budgetJob(r)])}),{attempts:1,inProgress:false});assert.deepEqual(await readPeriodSourceAttempts({plan:budgetPlan,now:budgetNow,currentRunId:1,fetchImpl:budgetWire([r],[])}),{attempts:0,inProgress:false});});
test('a rerun with two failed source jobs consumes two attempts, and an old unlabelled source is conservatively counted',async()=>{const r=budgetRun();assert.deepEqual(await readPeriodSourceAttempts({plan:budgetPlan,now:budgetNow,fetchImpl:budgetWire([r],[budgetJob(r),budgetJob(r,11,'produce')])}),{attempts:2,inProgress:false});});
test('queued or active source reserves the budget, while a skipped source job never entered finance',async()=>{const r=budgetRun(),j={...budgetJob(r),status:'queued',conclusion:null,started_at:null};assert.deepEqual(await readPeriodSourceAttempts({plan:budgetPlan,now:budgetNow,fetchImpl:budgetWire([r],[j])}),{attempts:1,inProgress:true});assert.deepEqual(await readPeriodSourceAttempts({plan:budgetPlan,now:budgetNow,fetchImpl:budgetWire([r],[{...j,status:'completed',conclusion:'skipped'}])}),{attempts:0,inProgress:false});});
test('source budget rejects partial metadata, duplicate jobs, wrong run/head/branch, changed route, future time and unknown job',async()=>{const r=budgetRun();for(const mutate of [v=>{v.total_count++;},v=>{if(v.workflow_runs)v.workflow_runs[0].head_branch='other';},v=>{if(v.workflow_runs)v.workflow_runs[0].path='other';},v=>{if(v.jobs)v.jobs[0].head_sha='b'.repeat(40);},v=>{if(v.jobs)v.jobs[0].run_id=99;},v=>{if(v.jobs)v.jobs[0].name='unknown-source';},v=>{if(v.jobs)v.jobs[0].started_at='2099-01-01T00:00:00Z';},v=>{if(v.jobs){v.jobs.push(v.jobs[0]);v.total_count++;}}])await assert.rejects(readPeriodSourceAttempts({plan:budgetPlan,now:budgetNow,fetchImpl:budgetWire([r],[budgetJob(r)],mutate)}),/SOURCE_ATTEMPT_METADATA/);});
test('preflight blocks exhausted, unknown, active and rerun source budgets without calling a financial reader',async()=>{const old=state(weeklyReportPlan('2026-10-23'),'2026-10-27T01:00:00Z'),args={plan:budgetPlan,now:budgetNow,readState:async()=>old};for(const [budget,reason] of [[{attempts:0,inProgress:false},null],[{attempts:1,inProgress:false},null],[{attempts:2,inProgress:false},'REPORT_SOURCE_ATTEMPT_BUDGET_EXHAUSTED'],[{attempts:1,inProgress:true},'REPORT_SOURCE_RUN_IN_PROGRESS'],[{attempts:-1,inProgress:false},'REPORT_SOURCE_ATTEMPT_METADATA_UNVERIFIED']]){const result=await nativeReportPreflight({...args,readSourceAttempts:async()=>budget});assert.equal(result.outcome,reason?'waiting':'produce');assert.equal(result.reasonCode||null,reason);}assert.equal((await nativeReportPreflight({...args,readSourceAttempts:async()=>{throw Error('private-canary');}})).reasonCode,'REPORT_SOURCE_ATTEMPT_METADATA_UNVERIFIED');assert.equal((await nativeReportPreflight({...args,runAttempt:'2',readSourceAttempts:async()=>assert.fail('rerun must stop before metadata')})).reasonCode,'REPORT_SOURCE_RERUN_NOT_ALLOWED');});
test('source budget never changes an already published fee receipt or incomplete accounting day',async()=>{const p=weeklyReportPlan('2026-10-23');assert.equal((await nativeReportPreflight({plan:p,now:new Date('2026-10-27T01:00Z'),ibEnabled:false,readState:async()=>state(p),readSourceAttempts:()=>assert.fail('covered fee must not query attempts')})).outcome,'already-published');});

test('reviewed daily entry requires exact completed-sync target and preserves source attempts, stale and pending gates',async()=>{
 const target='2026-10-28',now=new Date('2026-10-29T08:40:00+08:00'),markets=['NYSE','NASDAQ'];
 const args={targetDate:target,reviewedSyncDate:target,now,markets,ibEnabled:false,readState:async()=>state(weeklyReportPlan('2026-10-23')),readSourceAttempts:async()=>({attempts:0,inProgress:false})};
 const result=await dailyPublicationPreflight(args);assert.equal(result.outcome,'produce');assert.equal(result.plan.accountingThrough,target);assert.equal(result.plan.periodFrom,'2026-10-24');
 assert.equal((await dailyPublicationPreflight({...args,reviewedSyncDate:null})).reasonCode,'REPORT_NOT_DUE');
 for(const reviewedSyncDate of ['',true,'2026-10-27'])await assert.rejects(dailyPublicationPreflight({...args,reviewedSyncDate,readState:()=>assert.fail('wrong confirmation cannot read state')}));
 assert.equal((await dailyPublicationPreflight({...args,now:new Date('2026-10-29T03:00:00+08:00'),readState:()=>assert.fail('open market cannot read state')})).reasonCode,'SOURCE_DAY_NOT_CLOSED');
 assert.equal((await dailyPublicationPreflight({...args,readSourceAttempts:async()=>({attempts:2,inProgress:false})})).reasonCode,'REPORT_SOURCE_ATTEMPT_BUDGET_EXHAUSTED');
 assert.equal((await dailyPublicationPreflight({...args,runAttempt:'2'})).reasonCode,'REPORT_SOURCE_RERUN_NOT_ALLOWED');
 assert.equal((await dailyPublicationPreflight({...args,readState:async()=>({...state(weeklyReportPlan('2026-10-23')),pending:true})})).outcome,'candidate-pending');
 assert.equal((await dailyPublicationPreflight({...args,now:new Date('2026-11-03T08:40:00+08:00')})).reasonCode,'REPORT_TARGET_OUTSIDE_PROMOTION_WINDOW');
 await assert.rejects(produceReportPeriod({plan:result.plan,now,fetchEconomic:()=>assert.fail('missing confirmation before finance')}),/MANUAL_SYNC_CONFIRMATION/);
 await assert.rejects(nativeReportPreflight({plan:result.plan,now,readState:()=>assert.fail('missing confirmation before public state')}),/MANUAL_SYNC_CONFIRMATION/);
 const broken=cashOnly(target);broken.webull.performance.report.end_date='2026-10-27';
 await assert.rejects(captureReportRange({dates:[target],cache:{v:1,benchmarks:{spy:{symbol:'SPY',currency:'USD',exchange:'NYSEArca',series:[{d:target,p:100}]},qqq:{symbol:'QQQ',currency:'USD',exchange:'NasdaqGS',series:[{d:target,p:200}]}}},readOnce:async()=>broken}),/PERFORMANCE_IDENTITY/);
});

test('manual sync flag binds existing reviewed dispatch, main, first attempt and the real event input',()=>{
 const target='2026-10-28',args={mode:'preflight','report-kind':'daily','report-target':target,'manual-sync-completed-for':target};
 const env={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',GITHUB_REF:'refs/heads/main'};
 const event={inputs:{run_reviewed_once:'true',report_kind:'daily',report_target:target,manual_sync_completed_for:target,source_plan_check_only:'false',source_acceptance_once:'false'}};
 const check=(a=args,e=env,v=event)=>reviewedSyncConfirmation(a,{env:e,readEvent:()=>v});
 assert.equal(check(),target);assert.equal(check({...args,mode:'produce'}),target);assert.equal(check({...args,'manual-sync-completed-for':undefined}),null);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-reviewed-event-')),file=path.join(dir,'event.json');
 try{
  fs.writeFileSync(file,JSON.stringify(event));
  assert.equal(reviewedSyncConfirmation(args,{env:{...env,GITHUB_EVENT_PATH:file}}),target);
  fs.writeFileSync(file,'{}');assert.throws(()=>reviewedSyncConfirmation(args,{env:{...env,GITHUB_EVENT_PATH:file}}),/MANUAL_SYNC_CONFIRMATION/);
  fs.writeFileSync(file,'not-json');assert.throws(()=>reviewedSyncConfirmation(args,{env:{...env,GITHUB_EVENT_PATH:file}}),/MANUAL_SYNC_CONFIRMATION/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
 for(const changed of [{GITHUB_ACTIONS:'false'},{GITHUB_EVENT_NAME:'schedule'},{GITHUB_RUN_ATTEMPT:'2'},{GITHUB_REF:'refs/heads/not-main'}])assert.throws(()=>check(args,{...env,...changed}),/MANUAL_SYNC_CONFIRMATION/);
 for(const changed of [{run_reviewed_once:'false'},{manual_sync_completed_for:''},{manual_sync_completed_for:'2026-10-27'},{report_target:'2026-10-27'},{report_kind:'weekly'},{source_plan_check_only:'true'},{source_acceptance_once:'true'}])assert.throws(()=>check(args,env,{inputs:{...event.inputs,...changed}}),/MANUAL_SYNC_CONFIRMATION/);
 assert.throws(()=>check(args,env,{}),/MANUAL_SYNC_CONFIRMATION/);
 assert.throws(()=>check({...args,mode:'watch'}),/MANUAL_SYNC_CONFIRMATION/);
 const wf=fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml',import.meta.url),'utf8');
 const qualifier=Function('github','inputs','return ('+wf.match(/REVIEWED_SYNC_DATE:\s*\$\{\{([^\n]+)\}\}/)[1]+');');
 assert.equal(qualifier({event_name:'schedule'},{run_reviewed_once:true,manual_sync_completed_for:target}),'');
 assert.equal(qualifier({event_name:'workflow_dispatch'},{run_reviewed_once:false,manual_sync_completed_for:target}),'');
 assert.equal(qualifier({event_name:'workflow_dispatch'},{run_reviewed_once:true,manual_sync_completed_for:target}),target);
 for(const cli of [['--mode=preflight','--report-kind=daily','--report-target='+target],['--mode=produce','--report-kind=daily','--report-target='+target]]){
   const r=spawnSync(process.execPath,[new URL('./fee-report-producer.mjs',import.meta.url).pathname,...cli,'--manual-sync-completed-for='+target],{encoding:'utf8',env:{PATH:process.env.PATH}});
   assert.equal(r.status,1);assert.match(r.stderr,/MANUAL_SYNC_CONFIRMATION/);assert.equal(r.stdout,'');
 }
});

test('early published coverage deduplicates the later normal cycle without resetting attempts or freshness',async()=>{
 const target='2026-10-28',markets=['NYSE','NASDAQ'],ordinary=dailyReportPlan(target,markets),reviewed=dailyReportPlan(target,markets,{reviewedSyncDate:target});
 assert.equal(sourceAttemptWindowStart(ordinary),sourceAttemptWindowStart(reviewed));
 const s=state(reviewed,'2026-10-29T00:50:00Z'),later=new Date('2026-10-29T05:00:00Z');
 assert.equal(publishedReportMatches(s,ordinary,later),true);
 assert.equal((await nativeReportPreflight({plan:ordinary,now:later,ibEnabled:false,readState:async()=>s,readSourceAttempts:()=>assert.fail('already published no source')})).outcome,'already-published');
 assert.equal(publishedReportMatches(state(reviewed,'2026-10-28T19:00:00Z'),ordinary,later),false);
 const query=[];const response=(url,v)=>{const r=new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;};
 for(const plan of [ordinary,reviewed]){
  const count=await readPeriodSourceAttempts({plan,now:later,currentRunId:'2',fetchImpl:async url=>{query.push(url);return response(url,url.includes('/runs?')?{total_count:1,workflow_runs:[{id:1,head_branch:'main',head_sha:'a'.repeat(40),path:'.github/workflows/fee-cloud-producer.yml',event:'workflow_dispatch',created_at:'2026-10-29T00:40:00Z'}]}:{total_count:1,jobs:[{id:10,run_id:1,head_sha:'a'.repeat(40),name:'Produce daily '+target,status:'completed',conclusion:'failure',started_at:'2026-10-29T00:40:00Z'}]});}});
  assert.deepEqual(count,{attempts:1,inProgress:false});
 }
 assert.equal(new URL(query[0]).searchParams.get('created'),new URL(query[2]).searchParams.get('created'));
});

const recoveryBase='50d6454b062030d4ee6565a4d879c56b68e65911',originalFailureBase='fbb79a694acb232fbdb522939d98a933da03b1f2',recoverySupport='451efca392e474f434b7ac7891eb6f5570cf7108',recoveryHead='d'.repeat(40),recoveryId=90000000001;
const recoveryUi=fs.readFileSync(new URL('./fixtures/fee-gift-registry-status-index.html',import.meta.url));
const recoveryUiBlob=crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob '+recoveryUi.length+'\0'),recoveryUi])).digest('hex');
const recoveryNow=new Date('2026-10-29T06:30:00Z');
function recoveryFixture(){
 const plan=dailyReportPlan('2026-10-28',['NYSE','NASDAQ'],{periodFrom:'2026-10-24',reviewedSyncDate:'2026-10-28'});
 const run=(id,head,created)=>({id,head_sha:head,head_branch:'main',path:'.github/workflows/fee-cloud-producer.yml',event:'workflow_dispatch',created_at:created,run_attempt:1,workflow_id:365873934,actor:{id:283054367},status:id===recoveryId?'in_progress':'completed',conclusion:id===recoveryId?null:'failure'});
 const runs=[run(recoveryId,recoveryHead,'2026-10-29T06:00:00Z'),run(40815850578,recoveryBase,'2026-10-29T04:06:22Z'),run(40805169117,originalFailureBase,'2026-10-29T02:14:24Z'),run(40803101364,originalFailureBase,'2026-10-29T01:53:22Z')];
 const job=(r,id,name='Produce daily 2026-10-28',status='completed',conclusion='failure')=>({id,run_id:r.id,head_sha:r.head_sha,name,status,conclusion,started_at:r.created_at});
 const jobs={40815850578:[job(runs[1],123256663738)],40805169117:[job(runs[2],123222332691)],40803101364:[job(runs[3],123215645936)]};
 const commit={sha:recoveryHead,parents:[{sha:recoverySupport}],author:{id:283054367,login:'huanwujoy-crypto'},committer:{login:'web-flow'},commit:{tree:{sha:'a'.repeat(40)},verification:{verified:true,reason:'valid'}}};
 const supportCommit={...structuredClone(commit),sha:recoverySupport,parents:[{sha:recoveryBase}]};
 const comparison={status:'ahead',ahead_by:1,behind_by:0,total_commits:1,base_commit:{sha:recoverySupport},merge_base_commit:{sha:recoverySupport},commits:[{sha:recoveryHead}],files:['scripts/fee-sharesight-transfers.mjs','scripts/fee-source-acceptance.test.mjs','scripts/fee-report-producer.mjs','scripts/fee-report-producer.test.mjs'].map(filename=>({filename,status:'modified',sha:'b'.repeat(40)}))};
 const tree={sha:commit.commit.tree.sha,truncated:false,tree:[{path:'index.html',type:'blob',mode:'100644',sha:recoveryUiBlob}]};
 return{plan,runs,jobs,commit,supportCommit,comparison,tree,ref:{object:{sha:recoveryHead}},run,job};
}
function recoveryWire(f,trace=[]){return async(url,init)=>{
 assert.equal(init.method,'GET');assert.equal(init.headers.Authorization,undefined);assert.equal(init.redirect,'error');
 const root='https://api.github.com/repos/huanwujoy-crypto/fee-console/';assert.ok(url.startsWith(root));const p=url.slice(root.length);trace.push(p);
 let value;if(p.startsWith('actions/workflows/fee-cloud-producer.yml/runs?'))value={total_count:f.runs.length,workflow_runs:f.runs};
 else if(/^actions\/runs\/\d+\/jobs\?filter=all&per_page=100$/.test(p)){const id=Number(p.match(/runs\/(\d+)/)[1]),jobs=f.jobs[id];assert.ok(jobs);value={total_count:jobs.length,jobs};}
 else if(p==='git/ref/heads/main')value=f.ref;
 else if(p==='commits/'+recoveryHead+'?per_page=1')value=f.commit;else if(p==='commits/'+recoverySupport+'?per_page=1')value=f.supportCommit;else if(p==='compare/'+recoverySupport+'...'+recoveryHead+'?per_page=100')value=f.comparison;else if(p==='git/trees/'+'a'.repeat(40))value=f.tree;else assert.fail('unexpected offline metadata route');
 const r=new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;
};}
function recoveryReaders(f){const fetchImpl=recoveryWire(f);return{readSourceAttempts:args=>readPeriodSourceAttempts({...args,fetchImpl}),readRecoveryRelease:sha=>readReportRecoveryRelease(sha,{fetchImpl})};}
test('only the signed one-gift repair of the deployed UI rebinds the same recovery; three failures and ordinary budget two remain',async()=>{
 const f=recoveryFixture(),readers=recoveryReaders(f),args={plan:f.plan,now:recoveryNow,currentRunId:String(recoveryId),...readers};
 await assert.doesNotReject(authorizeReportRecovery({...args,expectedMain:recoveryHead}));
 assert.deepEqual(await readers.readSourceAttempts(args),{attempts:2,inProgress:false});
 const old=state(weeklyReportPlan('2026-10-23'),'2026-10-27T01:00:00Z');old.mainSha=old.finalMainSha=recoveryHead;
 const ordinary=await nativeReportPreflight({...args,reviewedSyncDate:'2026-10-28',readState:async()=>old});assert.equal(ordinary.reasonCode,'REPORT_SOURCE_ATTEMPT_BUDGET_EXHAUSTED');
 const recovered=await nativeReportPreflight({...args,reviewedSyncDate:'2026-10-28',recoveryMain:recoveryHead,readState:async()=>old});assert.equal(recovered.outcome,'produce');assert.equal(recovered.mainSha,recoveryHead);
});
test('recovery fails closed on scope, missing/changed failures, reruns, actor, current run, consumed admission and competitors',async()=>{
 const f=recoveryFixture(),readers=recoveryReaders(f),budget=await readers.readSourceAttempts({plan:f.plan,now:recoveryNow,currentRunId:recoveryId,recoveryMain:recoveryHead});
 const good={plan:f.plan,expectedMain:recoveryHead,currentRunId:recoveryId,budget,release:{mainSha:recoveryHead,parent:recoverySupport,baseSha:recoveryBase,repairBaseSha:recoverySupport,uiBlob:recoveryUiBlob,signatureVerified:true}};
 const mutations=[x=>x.plan=dailyReportPlan('2026-10-27',['NYSE','NASDAQ'],{reviewedSyncDate:'2026-10-27'}),x=>x.plan=weeklyReportPlan('2026-10-23'),x=>x.expectedMain='e'.repeat(40),x=>x.release.parent='e'.repeat(40),x=>x.release.signatureVerified=false,
  x=>x.budget.attempts=1,x=>x.budget.attempts=2,x=>x.budget.attempts=4,x=>x.budget.inProgress=true,x=>x.budget.recoveryEvidence.otherSourceActive=true,x=>x.budget.recoveryEvidence.reservations.push(90000000000),
  x=>x.budget.recoveryEvidence.currentRun=null,x=>x.budget.recoveryEvidence.currentRun.head=recoveryBase,x=>x.budget.recoveryEvidence.currentRun.actorId=1,x=>x.budget.recoveryEvidence.currentRun.attempt=2,x=>x.budget.recoveryEvidence.currentRun.event='schedule',x=>x.budget.recoveryEvidence.currentRun.workflowId=1,x=>x.budget.recoveryEvidence.currentRun.status='completed',x=>x.budget.recoveryEvidence.currentRun.conclusion='failure',
  x=>x.budget.recoveryEvidence.entries.pop(),x=>x.budget.recoveryEvidence.entries[0].runId=1,x=>x.budget.recoveryEvidence.entries[0].head=recoveryHead,x=>x.budget.recoveryEvidence.entries[0].attempt=2,x=>x.budget.recoveryEvidence.entries[0].conclusion='success',x=>x.budget.recoveryEvidence.entries[0].name='Produce daily 2026-10-29',x=>x.budget.recoveryEvidence.entries[0].jobId=0,x=>x.budget.recoveryEvidence.entries[0]=structuredClone(x.budget.recoveryEvidence.entries[1])];
 for(const mutate of mutations){const value=structuredClone(good);mutate(value);assert.throws(()=>validateReportRecoveryEvidence(value),/FEE_REPORT_RECOVERY_/);}
});
for(const historicalId of [40803101364,40805169117,40815850578])for(const [runStatus,runConclusion]of [['in_progress',null],['completed','cancelled']])test('historical run '+historicalId+' must be completed/failure, not '+runStatus+'/'+runConclusion+', even when its source job failed',async()=>{
 const f=recoveryFixture(),historical=f.runs.find(r=>r.id===historicalId);historical.status=runStatus;historical.conclusion=runConclusion;
 assert.equal(f.jobs[historical.id][0].status,'completed');assert.equal(f.jobs[historical.id][0].conclusion,'failure');
 const readers=recoveryReaders(f),budget=await readers.readSourceAttempts({plan:f.plan,now:recoveryNow,currentRunId:recoveryId,recoveryMain:recoveryHead});
 const item=budget.recoveryEvidence.entries.find(x=>x.runId===historical.id);assert.equal(item.runStatus,runStatus);assert.equal(item.runConclusion,runConclusion);
 await assert.rejects(authorizeReportRecovery({plan:f.plan,expectedMain:recoveryHead,now:recoveryNow,currentRunId:recoveryId,...readers}),/FEE_REPORT_RECOVERY_PRIOR_RUNS/);
});
test('complete recovery metadata reserves cancelled admission and scans beyond the ordinary two-entry early return',async()=>{
 for(const kind of ['cancelled-period','queued-period','old-release-cancelled-period','old-release-queued-period','failed-source','other-target-active','skipped-schedule']){
  const f=recoveryFixture(),r=f.run(90000000000,kind==='other-target-active'?recoveryBase:kind.startsWith('old-release-')?recoverySupport:recoveryHead,'2026-10-29T02:50:00Z');f.runs.push(r);
  let j;if(kind==='failed-source')j=f.job(r,90000000011);else if(kind==='other-target-active')j=f.job(r,90000000011,'Produce daily 2026-10-27','in_progress',null);else j=f.job(r,90000000011,'period',kind.endsWith('queued-period')?'queued':'completed',kind==='skipped-schedule'?'skipped':kind.endsWith('cancelled-period')?'cancelled':null);
  if(kind.endsWith('cancelled-period')||kind.endsWith('queued-period'))j.started_at=null;if(kind==='skipped-schedule')r.event='schedule';f.jobs[r.id]=[j];
  const readers=recoveryReaders(f),args={plan:f.plan,now:recoveryNow,currentRunId:recoveryId,expectedMain:recoveryHead,...readers};
  if(kind==='skipped-schedule')await assert.doesNotReject(authorizeReportRecovery(args));else await assert.rejects(authorizeReportRecovery(args),/FEE_REPORT_RECOVERY_/);
 }
});
test('recovery metadata release check rejects later versions, unsigned/wrong-owner/multi-parent commits and drift with fixed GET-only routes',async()=>{
 for(const mutate of [f=>f.ref.object.sha='e'.repeat(40),f=>f.commit.sha='e'.repeat(40),f=>f.commit.parents=[{sha:recoveryHead}],f=>f.commit.parents.push({sha:recoveryBase}),f=>f.commit.commit.verification.verified=false,f=>f.commit.author.id=1,f=>f.commit.committer.login='other']){
  const f=recoveryFixture();mutate(f);await assert.rejects(readReportRecoveryRelease(recoveryHead,{fetchImpl:recoveryWire(f)}),/RECOVERY_RELEASE/);
 }
 const f=recoveryFixture(),trace=[];await readReportRecoveryRelease(recoveryHead,{fetchImpl:recoveryWire(f,trace)});assert.equal(trace.length,5);assert.ok(trace.every(p=>!p.includes('/logs')));
});
test('repair release permits exactly four code/test modifications and preserves the deployed UI blob',async()=>{
 const changes=[f=>f.supportCommit.parents=[],f=>f.supportCommit.parents.push({sha:recoveryBase}),
  f=>f.supportCommit.commit.verification.verified=false,f=>f.supportCommit.author.id=1,
  f=>f.comparison.total_commits=2,f=>f.comparison.ahead_by=2,f=>f.comparison.behind_by=1,
  f=>f.comparison.base_commit.sha=recoveryBase,f=>f.comparison.merge_base_commit.sha=recoveryBase,
  f=>f.comparison.commits.push({sha:'e'.repeat(40)}),f=>f.comparison.commits[0].sha='e'.repeat(40),
  f=>f.comparison.files.push({filename:'scripts/extra.mjs',status:'modified',sha:'a'.repeat(40)}),
  f=>f.comparison.files[0].filename='data.json',f=>f.comparison.files[0].status='renamed',
  f=>f.comparison.files[0].previous_filename='old.html',f=>f.comparison.files[0].sha='not-a-sha',
  f=>f.comparison.files.pop(),f=>f.comparison.files[1]=structuredClone(f.comparison.files[0]),
  f=>f.tree.sha='e'.repeat(40),f=>f.tree.truncated=true,f=>f.tree.tree=[],f=>f.tree.tree.push({...f.tree.tree[0]}),
  f=>f.tree.tree[0].sha='e'.repeat(40),f=>f.tree.tree[0].mode='120000',f=>f.tree.tree[0].type='tree'];
 for(const change of changes){const f=recoveryFixture();change(f);await assert.rejects(readReportRecoveryRelease(recoveryHead,{fetchImpl:recoveryWire(f)}),/RECOVERY_RELEASE/);}
 const support=recoveryFixture();support.ref.object.sha=recoverySupport;
 await assert.rejects(readReportRecoveryRelease(recoverySupport,{fetchImpl:recoveryWire(support)}),/RECOVERY_RELEASE/,'old release must not bypass the newly approved repair');
});
test('recovery confirmation binds real reviewed event, exact target/head, owner, main and first attempt; JSON claims cannot reset it',()=>{
 const args={mode:'preflight','report-kind':'daily','report-target':'2026-10-28','manual-sync-completed-for':'2026-10-28','recovery-main':recoveryHead};
 const env={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',GITHUB_REF:'refs/heads/main',GITHUB_SHA:recoveryHead,GITHUB_REPOSITORY:'huanwujoy-crypto/fee-console',GITHUB_ACTOR_ID:'283054367',GITHUB_RUN_ID:String(recoveryId)};
 const event={inputs:{run_reviewed_once:'true',report_kind:'daily',report_target:'2026-10-28',manual_sync_completed_for:'2026-10-28',recovery_main:recoveryHead,source_plan_check_only:'false',source_acceptance_once:'false'},sender:{id:283054367},repository:{full_name:'huanwujoy-crypto/fee-console'}};
 assert.equal(reviewedRecoveryConfirmation(args,{env,readEvent:()=>event}),recoveryHead);
 for(const mutate of [x=>x.args['report-target']='2026-10-27',x=>x.args.mode='watch',x=>x.env.GITHUB_SHA='e'.repeat(40),x=>x.env.GITHUB_ACTOR_ID='1',x=>x.env.GITHUB_RUN_ATTEMPT='2',x=>x.env.GITHUB_REF='refs/heads/other',x=>x.env.GITHUB_REPOSITORY='other/repo',x=>x.event.inputs.recovery_main='e'.repeat(40),x=>x.event.inputs.run_reviewed_once='false',x=>x.event.inputs.source_acceptance_once='true',x=>x.event.sender.id=1,x=>x.event.repository.full_name='other/repo']){
  const x=structuredClone({args,env,event});mutate(x);assert.throws(()=>reviewedRecoveryConfirmation(x.args,{env:x.env,readEvent:()=>x.event}),/RECOVERY_CONFIRMATION/);
 }
 assert.equal(reviewedRecoveryConfirmation({mode:'preflight'},{env,readEvent:()=>({...event,approved:true})}),null);
});
test('workflow carries the opt-in exact recovery SHA through both gates without changing timeout, permissions or scheduled activation',()=>{
 const workflow=fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml',import.meta.url),'utf8');
 assert.equal((workflow.match(/REVIEWED_RECOVERY_MAIN:/g)||[]).length,2);assert.equal((workflow.match(/args\+=\("--recovery-main=\$REVIEWED_RECOVERY_MAIN"\)/g)||[]).length,2);
 const expression=workflow.match(/REVIEWED_RECOVERY_MAIN:\s*\$\{\{([^\n]+)\}\}/)[1],value=Function('github','inputs','return ('+expression+');');
 assert.equal(value({event_name:'schedule'},{run_reviewed_once:true,recovery_main:recoveryHead}),'');assert.equal(value({event_name:'workflow_dispatch'},{run_reviewed_once:false,recovery_main:recoveryHead}),'');assert.equal(value({event_name:'workflow_dispatch'},{run_reviewed_once:true,recovery_main:recoveryHead}),recoveryHead);
 assert.match(workflow,/timeout-minutes: 15/);assert.match(workflow,/github\.run_attempt == 1/);assert.match(workflow,/vars\.FEE_REPORT_PERIODS_ENABLED == 'true'/);
});

test('actual recovery preflight and producer CLI use only mocked fixed routes, recheck release before IO and preserve typed source errors through both catches',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-recovery-cli-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const root=path.join(dir,'checkout');fs.mkdirSync(root);fs.cpSync(new URL('.',import.meta.url),path.join(root,'scripts'),{recursive:true});
 const f=recoveryFixture(),key=crypto.randomBytes(32),iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
 const data=JSON.stringify({enc:true,v:3,data:Buffer.concat([iv,cipher.update(JSON.stringify({daily:[{d:'2026-10-23'}]})),cipher.final(),cipher.getAuthTag()]).toString('base64')});fs.writeFileSync(path.join(root,'data.json'),data);
 const health={schema:HEALTH_SCHEMA,checkedAt:'2026-10-27T01:00:00Z',targetDate:'2026-10-23',sourceDates:{schwab:'2026-10-23',webull:'2026-10-23',benchmark:'2026-10-23'},outcome:'updated',errorCode:null,dataSha256:crypto.createHash('sha256').update(data).digest('hex')};
 const cache={v:1,benchmarks:Object.fromEntries([['spy','SPY','NYSEArca'],['qqq','QQQ','NasdaqGS']].map(([k,s,e])=>[k,{symbol:s,currency:'USD',exchange:e,series:['2026-10-23','2026-10-26','2026-10-27','2026-10-28'].map(d=>({d,p:100,div:0}))}]))};
 const benchmark=path.join(dir,'benchmark.json');fs.writeFileSync(benchmark,JSON.stringify(cache));
 const event={inputs:{run_reviewed_once:'true',report_kind:'daily',report_target:'2026-10-28',manual_sync_completed_for:'2026-10-28',recovery_main:recoveryHead,source_plan_check_only:'false',source_acceptance_once:'false'},sender:{id:283054367},repository:{full_name:'huanwujoy-crypto/fee-console'}};
 const eventFile=path.join(dir,'event.json');fs.writeFileSync(eventFile,JSON.stringify(event));
 const trace=path.join(dir,'trace.json'),preload=path.join(dir,'mock-only.mjs');
 fs.writeFileSync(preload,`import fs from 'node:fs';const D=Date,now=D.parse('2026-10-29T06:30:00Z');globalThis.Date=class extends D{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}};
  const f=${JSON.stringify(f)},data=${JSON.stringify(data)},health=${JSON.stringify(health)},calls=[];
  globalThis.fetch=async(url,init={})=>{url=String(url);if(init.method&&init.method!=='GET')throw Error('unexpected method');let value,status=200;
   const api='https://api.github.com/repos/huanwujoy-crypto/fee-console/';
   if(url.startsWith(api)){const p=url.slice(api.length);calls.push('public-metadata');
    if(p==='git/ref/heads/main')value=f.ref;else if(p==='commits/${recoveryHead}?per_page=1'){value=structuredClone(f.commit);if(process.env.SYNTHETIC_REJECT_RELEASE==='true')value.parents=[{sha:'${recoveryBase}'}];}
    else if(p==='commits/${recoverySupport}?per_page=1')value=f.supportCommit;else if(p==='compare/${recoverySupport}...${recoveryHead}?per_page=100')value=f.comparison;else if(p==='git/trees/${'a'.repeat(40)}')value=f.tree;
    else if(p.startsWith('actions/workflows/fee-cloud-producer.yml/runs?'))value={total_count:f.runs.length,workflow_runs:f.runs};
    else if(/^actions\\/runs\\/\\d+\\/jobs\\?filter=all&per_page=100$/.test(p)){const jobs=f.jobs[Number(p.match(/runs\\/(\\d+)/)[1])];if(!jobs)throw Error('unexpected job');value={total_count:jobs.length,jobs};}
    else if(p.startsWith('contents/')){const text=p.startsWith('contents/data.json?')?data:p.startsWith('contents/fee-data-health.json?')?JSON.stringify(health):null;if(text===null)throw Error('unexpected content');value={type:'file',encoding:'base64',size:Buffer.byteLength(text),content:Buffer.from(text).toString('base64')};}
    else if(p.startsWith('git/matching-refs/heads/'))value=[];else throw Error('unexpected public route');
   }else if(url==='https://api.github.com/gists/${'a'.repeat(32)}'){calls.push('economic-mock');status=Number(process.env.SYNTHETIC_HTTP_STATUS);value={message:'PRIVATE_CANARY SOURCE_HTTP amount=123456.78 \\u001b[31m'};}
   else throw Error('all real financial routes forbidden');
   fs.writeFileSync(${JSON.stringify(trace)},JSON.stringify(calls));const r=new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;};`);
 const env={PATH:process.env.PATH,NODE_OPTIONS:'--import='+preload,FEE_DATA_KEY:key.toString('base64url'),FEE_ECON_GIST_ID:'a'.repeat(32),IB_MANAGER_READ_ENABLED:'',GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',GITHUB_REF:'refs/heads/main',GITHUB_SHA:recoveryHead,GITHUB_REPOSITORY:'huanwujoy-crypto/fee-console',GITHUB_ACTOR_ID:'283054367',GITHUB_RUN_ID:String(recoveryId),GITHUB_EVENT_PATH:eventFile};
 // Node resolves ESM symlinks; pass the canonical temp path so the real CLI
 // entry guard executes rather than silently importing a library module.
 const cli=path.join(fs.realpathSync(root),'scripts/fee-report-producer.mjs'),common=['--report-kind=daily','--report-target=2026-10-28','--manual-sync-completed-for=2026-10-28','--recovery-main='+recoveryHead];
 const gate=spawnSync(process.execPath,[cli,'--mode=preflight',...common,'--report-markets=NYSE,NASDAQ'],{encoding:'utf8',env,timeout:10000});assert.equal(gate.status,0,gate.stderr);assert.equal(JSON.parse(gate.stdout).outcome,'produce');assert.ok(JSON.parse(fs.readFileSync(trace)).every(x=>x==='public-metadata'));
 for(const [status,code]of [[403,'SOURCE_FORBIDDEN'],[503,'SOURCE_HTTP']]){
  const out=path.join(dir,'out'+status);fs.mkdirSync(out,{mode:0o700});
  const result=spawnSync(process.execPath,[cli,'--mode=produce',...common,'--report-plan='+JSON.stringify(f.plan),'--benchmark-file='+benchmark,'--out-dir='+out],{encoding:'utf8',env:{...env,SYNTHETIC_HTTP_STATUS:String(status)},timeout:10000});
  assert.equal(result.status,1);assert.equal(result.stderr.trim(),code);assert.equal(result.stdout,'');assert.doesNotMatch(result.stderr,/PRIVATE_CANARY|123456|SOURCE_HTTP amount/);assert.deepEqual(fs.readdirSync(out),[]);
  const calls=JSON.parse(fs.readFileSync(trace));assert.equal(calls.filter(x=>x==='economic-mock').length,1);assert.ok(calls.indexOf('economic-mock')>0);
 }
 const out=path.join(dir,'rejected');fs.mkdirSync(out,{mode:0o700});
 const rejected=spawnSync(process.execPath,[cli,'--mode=produce',...common,'--report-plan='+JSON.stringify(f.plan),'--benchmark-file='+benchmark,'--out-dir='+out],{encoding:'utf8',env:{...env,SYNTHETIC_REJECT_RELEASE:'true'},timeout:10000});
 assert.equal(rejected.status,1);assert.equal(rejected.stderr.trim(),'FEE_REPORT_RECOVERY_RELEASE');assert.ok(JSON.parse(fs.readFileSync(trace)).every(x=>x==='public-metadata'));assert.deepEqual(fs.readdirSync(out),[]);assert.equal(fs.readFileSync(path.join(root,'data.json'),'utf8'),data);
});
