import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {CLOUD_ACCOUNTS,parseSourceJson} from './fee-cloud-source.mjs';
import {periodBenchmark,captureReportRange,publishedReportMatches,reportPublicationPreflight,reportPublicationWatch,explicitReportPlan} from './fee-report-producer.mjs';
import {weeklyReportPlan,monthlyReportPlan,reportAddDays} from './fee-report-period.mjs';
import {HEALTH_SCHEMA,validateHealth} from './fee-data-health.mjs';

const cache={v:1,benchmarks:{spy:{series:[{d:'2026-10-22',p:100},{d:'2026-10-23',p:101,div:1}]},qqq:{series:[{d:'2026-10-22',p:200},{d:'2026-10-23',p:202}]}}};
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
test('period watchdog accepts existing cycle coverage but rejects missing publication',async()=>{
  const p=weeklyReportPlan('2026-10-23');
  assert.equal((await reportPublicationWatch({...state(p),now:new Date('2026-10-28T00:00Z')})).outcome,'already-published');
  await assert.rejects(reportPublicationWatch({...state(weeklyReportPlan('2026-10-16'),'2026-10-18T00:00Z'),now:new Date('2026-10-26T00:00Z')}),/PUBLISHED_PERIOD_MISSING/);
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
    import {produceReportPeriod} from './scripts/fee-report-producer.mjs';import {weeklyReportPlan} from './scripts/fee-report-period.mjs';import {parseSourceJson} from './scripts/fee-cloud-source.mjs';import {decryptCandidate} from './scripts/fee-cloud-producer.mjs';import {validateFeeCalculationReceiptWithEcon} from './scripts/fee-receipt-core.mjs';
    const dir=path.dirname(process.env.SYNTHETIC_SNAPSHOTS),snapshots=JSON.parse(fs.readFileSync(process.env.SYNTHETIC_SNAPSHOTS)),out=path.join(dir,'out');fs.mkdirSync(out,{mode:0o700});let calls=0,checks=0,cleanups=0;
    const r=await produceReportPeriod({plan:weeklyReportPlan('2026-10-23'),outputDir:out,benchmarkFile:process.env.SYNTHETIC_BENCHMARK,readOnce:async d=>{calls++;const raw=structuredClone(snapshots[d]);for(const p of Object.values(raw)){for(const key of ['performance','cashAccounts','previousPerformance'])p[key]=parseSourceJson(JSON.stringify(p[key]));for(const key of ['cashTransactions','cashLedgerHistory'])p[key]=Object.fromEntries(Object.entries(p[key]).map(([id,v])=>[id,parseSourceJson(JSON.stringify(v))]));}return raw;},fetchEconomic:async()=>({envelopeVersion:4,sourcePath:process.env.FEE_ECON_FILE,async checkCurrent(){checks++;},cleanup(){cleanups++;}})});
    assert.equal(r.reconstructedDays,2);assert.equal(calls,4);assert.equal(checks,3);assert.equal(cleanups,1);assert.equal(fs.existsSync(path.join(out,'period-private')),false);
    const data=decryptCandidate(r.dataFile,process.env.FEE_DATA_KEY),econ={v:4,settings:{start:'2026-10-21',mgmt:2,carry:20},accounts:[{id:'schwab',opening:100},{id:'webull',opening:100}],months:[],fees:[]};
    assert.deepEqual(data.daily.map(p=>p.d),['2026-10-21','2026-10-22','2026-10-23']);assert.equal(data.feeReportPublication.plan.kind,'weekly');assert.equal(data.feeCalculationReceipt.asOf,'2026-10-23');assert.deepEqual(data.feeCalculationReceipt.accountIds,['schwab','webull']);assert.equal(validateFeeCalculationReceiptWithEcon(data.feeCalculationReceipt,data,econ).ok,true);
    assert.equal(fs.statSync(r.dataFile).mode&0o777,0o600);assert.equal(fs.existsSync(r.healthFile),true);
    const repeatedOut=path.join(dir,'repeated');fs.mkdirSync(repeatedOut,{mode:0o700});
    const readOnce=async d=>{const raw=structuredClone(snapshots[d]);for(const p of Object.values(raw)){for(const key of ['performance','cashAccounts','previousPerformance'])p[key]=parseSourceJson(JSON.stringify(p[key]));for(const key of ['cashTransactions','cashLedgerHistory'])p[key]=Object.fromEntries(Object.entries(p[key]).map(([id,v])=>[id,parseSourceJson(JSON.stringify(v))]));}return raw;};
    const repeated=await produceReportPeriod({plan:weeklyReportPlan('2026-10-23'),sourceFile:r.dataFile,outputDir:repeatedOut,benchmarkFile:process.env.SYNTHETIC_BENCHMARK,readOnce,fetchEconomic:async()=>({envelopeVersion:4,sourcePath:process.env.FEE_ECON_FILE,async checkCurrent(){},cleanup(){}})});
    assert.equal(repeated.outcome,'no-op');assert.deepEqual(fs.readFileSync(repeated.dataFile),fs.readFileSync(r.dataFile));assert.deepEqual(decryptCandidate(repeated.dataFile,process.env.FEE_DATA_KEY).feeCalculationReceipt,data.feeCalculationReceipt);
    const failedOut=path.join(dir,'failed');fs.mkdirSync(failedOut,{mode:0o700});let failureChecks=0;
    await assert.rejects(produceReportPeriod({plan:weeklyReportPlan('2026-10-23'),outputDir:failedOut,benchmarkFile:process.env.SYNTHETIC_BENCHMARK,readOnce,fetchEconomic:async()=>({envelopeVersion:4,sourcePath:process.env.FEE_ECON_FILE,async checkCurrent(){if(++failureChecks===2)throw Error('synthetic economic revision changed');},cleanup(){}})}));
    assert.equal(fs.existsSync(path.join(failedOut,'data.json')),false);assert.equal(fs.existsSync(path.join(failedOut,'fee-data-health.json')),false);assert.equal(fs.existsSync(path.join(failedOut,'period-private')),false);console.log('SYNTHETIC_PERIOD_CANDIDATE_VERIFIED');
  `);
  // Isolated synthetic subprocess clock only; production has no clock/guard
  // override. Its real writer, reporter and health still enforce every window.
  const clockFile=path.join(dir,'synthetic-clock.mjs');fs.writeFileSync(clockFile,`const RealDate=Date;const now=RealDate.parse('2026-10-26T06:00:00Z');globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};`);
  const r=spawnSync(process.execPath,[script],{encoding:'utf8',timeout:30000,env:{...process.env,NODE_OPTIONS:'--import='+clockFile,FEE_DATA_KEY:key.toString('base64url'),FEE_ECON_FILE:econ,IB_MANAGER_READ_ENABLED:'',FEE_STYLE_INPUT_FILE:'',FEE_MANAGEMENT_INPUT_FILE:'',SYNTHETIC_SNAPSHOTS:snapshots,SYNTHETIC_BENCHMARK:benchmarkFile}});
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/SYNTHETIC_PERIOD_CANDIDATE_VERIFIED/);assert.equal(fs.readFileSync(path.join(root,'data.json'),'utf8'),original);
});
