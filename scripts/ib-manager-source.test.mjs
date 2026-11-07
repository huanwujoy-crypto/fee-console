import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {nyDate} from './daily-core.mjs';
import {SharesightIbManagerReader,IbManagerSourceError,IB_CASH_RECONCILIATION_SITES,IB_CASH_DATE_ROLES,ibSourceCashSite,ibSourceCashDateRole,ibBaselineBusinessHash,ibSourceFailureCode,validateIbBootstrapCoverage,validateIbManagerReportInput} from './ib-manager-source.mjs';
import {buildIbManagerReportBundle,validateIbManagerReportState,buildIbOwnerBaseline,validateIbOwnerBaselineState,buildIbManagerReturnReceipt,buildIbManagerDrawdownReceipt,createIbManagerReturnConsumer,createIbManagerDrawdownConsumer} from './ib-manager-return.mjs';
import {prepareIbManagerReport,loadIbManagerReport,sameIbManagerData,validateIbManagerCoverage,assertIbManagerConfiguration,assertIbManagerPublication,IB_PUBLICATION_DIAGNOSTIC_PREFIX,validateIbPublicationDiagnostic} from './ib-manager-report.mjs';
import {safeProducerFailureSummary} from './fee-cloud-producer.mjs';
import {IB_DIAGNOSTIC_PLAN,ibDiagnosticTransport,inspectIbDiagnostic,validateIbDiagnosticEvent,verifyIbDiagnosticRun,validateIbDiagnosticBase} from './ib-manager-diagnostic.mjs';
import {buildFeeCalculationReceipt,validateFeeCalculationReceipt} from './fee-receipt-core.mjs';

// Synthetic portfolio/holding/cash IDs. No real source, credentials or NAV.
const baseline={from:'2026-08-31',asOf:'2026-09-02'};
const input=()=>({points:[{d:'2026-08-31',tot:100},{d:'2026-09-01',tot:150},{d:'2026-09-02',tot:135}],openT:100,from:baseline.from,to:baseline.asOf,days:3,flowByDate:{'2026-09-01':50},rate:0,cr:0,cumBefore:0,hwmBefore:0});
const lock=()=>ibBaselineBusinessHash(input());
const add=d=>new Date(Date.parse(d+'T00:00:00Z')+86400000).toISOString().slice(0,10);

function cashFailure(site,role){return error=>{
  assert.equal(error.message,'IB_SOURCE_CASH_RECONCILIATION');assert.equal(error.code,'CASH_RECONCILIATION');
  assert.equal(ibSourceCashSite(error),site);assert.equal(ibSourceCashDateRole(error),role);
  assert.equal(error.cashSite,site);assert.equal(error.cashDateRole,role);
  assert.equal(JSON.stringify(error),'{"code":"CASH_RECONCILIATION"}');return true;
};}
test('cash diagnostic locations are immutable fixed labels and do not alter ordinary errors or serialization',()=>{
  assert.ok(Object.isFrozen(IB_CASH_RECONCILIATION_SITES));assert.ok(Object.isFrozen(IB_CASH_DATE_ROLES));
  assert.equal(new Set(IB_CASH_RECONCILIATION_SITES).size,IB_CASH_RECONCILIATION_SITES.length);
  for(const site of IB_CASH_RECONCILIATION_SITES)for(const role of IB_CASH_DATE_ROLES){
    assert.match(site,/^[A-Z_]+$/);const error=new IbManagerSourceError('CASH_RECONCILIATION',site,role);
    cashFailure(site,site==='UNCLASSIFIED'?'NONE':role)(error);
    assert.throws(()=>{error.cashSite='PRIVATE_CANARY';},TypeError);
    assert.throws(()=>Object.defineProperty(error,'cashDateRole',{value:'PRIVATE_CANARY'}),TypeError);
    assert.deepEqual({...error},{code:'CASH_RECONCILIATION'});
  }
  const error=new IbManagerSourceError('AMOUNT','TARGET_API_AMOUNT','TARGET');
  assert.equal(ibSourceFailureCode(error),'IB_SOURCE_AMOUNT');assert.equal(Object.hasOwn(error,'cashSite'),false);
  assert.equal(ibSourceCashSite(error),'UNCLASSIFIED');assert.equal(ibSourceCashDateRole(error),'NONE');
});
test('cash diagnostic extraction ignores unknown fields, forged exceptions and hostile getters without exposing source text',()=>{
  let touched=0;const hostile={get cashSite(){touched++;throw Error('PRIVATE_CANARY');},get cashDateRole(){touched++;throw Error('PRIVATE_CANARY');},toString(){touched++;throw Error('PRIVATE_CANARY');}};
  const revoked=Proxy.revocable({},{});revoked.revoke();
  for(const value of [undefined,null,0,'PRIVATE_CANARY',hostile,revoked.proxy,new Proxy({}, {get(){touched++;throw Error('PRIVATE_CANARY');}}),
    {code:'CASH_RECONCILIATION',cashSite:'TARGET_API_AMOUNT',cashDateRole:'TARGET'},
    Object.assign(Object.create(IbManagerSourceError.prototype),{code:'CASH_RECONCILIATION',cashSite:'TARGET_API_AMOUNT',cashDateRole:'TARGET'}),
    new Error('PRIVATE_CANARY account=SYNTH amount=123 date=2026-01-01')]){
    assert.equal(ibSourceCashSite(value),'UNCLASSIFIED');assert.equal(ibSourceCashDateRole(value),'NONE');
  }
  for(const value of ['PRIVATE_CANARY','TARGET_API_AMOUNT\nPRIVATE_CANARY',hostile,revoked.proxy,null]){
    cashFailure('UNCLASSIFIED','NONE')(new IbManagerSourceError('CASH_RECONCILIATION',value,'TARGET'));
    cashFailure('TARGET_API_AMOUNT','NONE')(new IbManagerSourceError('CASH_RECONCILIATION','TARGET_API_AMOUNT',value));
  }
  assert.equal(touched,0);
});
test('every cash rejection has a literal allowlisted site, including separate balance-chain and dated API checks',()=>{
  const text=fs.readFileSync(new URL('./ib-manager-source.mjs',import.meta.url),'utf8');
  const calls=[...text.matchAll(/fail\('CASH_RECONCILIATION','([A-Z_]+)'/g)].map(m=>m[1]);
  assert.equal(text.match(/fail\('CASH_RECONCILIATION'/g).length,calls.length);
  assert.deepEqual([...new Set(calls)].sort(),IB_CASH_RECONCILIATION_SITES.filter(x=>x!=='UNCLASSIFIED').sort());
});
test('target cash mismatch remains rejected at one cent with only a target role',async()=>{
  const w=wire({mutate:b=>{if(b.cash_accounts)b.cash_accounts[0].balance_in_portfolio_currency+=0.01;}});
  await assert.rejects(read(w),cashFailure('TARGET_API_AMOUNT','TARGET'));
  assert.equal(w.calls.filter(c=>c.method==='POST').length,1);
});
test('dated cash failures distinguish count, identity, converted amount, native USD and date role',async t=>{
  for(const [name,date,change,site,role] of [
    ['missing anchor cash','2026-08-30',b=>b.cash_accounts.pop(),'DATED_API_COUNT','ANCHOR'],
    ['wrong window identity','2026-09-01',b=>b.cash_accounts[0].portfolio_id=99,'DATED_API_IDENTITY','WINDOW'],
    ['wrong window currency value','2026-09-01',b=>b.cash_accounts[1].balance_in_portfolio_currency+=0.01,'DATED_API_AMOUNT','WINDOW'],
    ['wrong target native USD','2026-09-02',b=>b.cash_accounts[0].balance+=0.01,'DATED_API_USD_NATIVE','TARGET']
  ])await t.test(name,async()=>{
    const w=cadWire((b,{p,q})=>{if(p==='/api/v2/portfolios/1/cash_accounts.json'&&q.get('date')===date)change(b);});
    await assert.rejects(w.reader.readStable({targetDate:baseline.asOf,baseline,expectedBaselineHash:ibBaselineBusinessHash(cadBusiness())}),cashFailure(site,role));
  });
});
test('cash chain diagnostics distinguish disconnected rows from an invalid endpoint without relaxing conservation',async()=>{
  await assert.rejects(read(wire({mutate:b=>{if(b.cash_account_transactions?.length)b.cash_account_transactions[0].balance++;}})),cashFailure('DAILY_CHAIN_LENGTH','WINDOW'));
  const f=await incomeFixture({dividend:false,change:b=>{if(b.cash_account_transactions?.length){const row=b.cash_account_transactions[0];b.cash_account_transactions=[{...row,id:21,amount:1,balance:51},{...row,id:22,amount:2,balance:52}];}}});
  await assert.rejects(f.run(),cashFailure('DAILY_CHAIN_END','TARGET'));
  const mismatch=await incomeFixture({dividend:false,change:b=>{if(b.cash_account_transactions?.length)b.cash_account_transactions[0].amount-=0.01;}});
  await assert.rejects(mismatch.run(),cashFailure('TRADE_NORMALIZATION_SCOPE','PROOF'));
});
test('historical income proof failures carry only a proof role and keep original guards',async t=>{
  const f=await earlyIncomeFixture(),valid=await f.run();
  for(const [name,change,site] of [
    ['schema',p=>p.extra='PRIVATE_CANARY','INCOME_PROOF_SCHEMA'],
    ['payout cents',p=>p.payout.netCents++,'INCOME_PROOF_PAYOUT'],
    ['cash keys',p=>p.rawAnchor.cashCurrency[99]='USD','SNAPSHOT_CASH_KEYS'],
    ['cash leg identity',p=>p.cashLegs[0].cashId=99,'INCOME_PROOF_LEG_SCHEMA'],
    ['payout balance',p=>p.cashLegs.find(x=>x.type==='PAYOUT').balanceCents++,'INCOME_PROOF_PAYOUT_LEG'],
    ['unsupported companion',p=>p.cashLegs.find(x=>x.type!=='PAYOUT').type='FEE','INCOME_PROOF_OTHER_LEG'],
    ['missing companion',p=>p.cashLegs=p.cashLegs.filter(x=>x.type==='PAYOUT'),'INCOME_PROOF_MOVEMENT'],
    ['disconnected companion',p=>p.cashLegs.find(x=>x.type!=='PAYOUT').balanceCents++,'INCOME_PROOF_CHAIN_LENGTH'],
    ['proof hash',p=>p.proofId='a'.repeat(64),'INCOME_PROOF_HASH']
  ])await t.test(name,()=>{const bad=structuredClone(valid);change(bad.incomeDateNormalizations[0]);assert.throws(()=>validateIbManagerReportInput(bad,f.expected),cashFailure(site,'PROOF'));});
  assert.deepEqual(validateIbManagerReportInput(valid,f.expected),valid);
  assert.equal(JSON.stringify(valid).includes('cashSite'),false);assert.equal(JSON.stringify(valid).includes('cashDateRole'),false);
  const external=await earlyIncomeFixture({change:b=>{if(b.cash_account_transactions?.length)Object.assign(b.cash_account_transactions[0],{cash_account_transaction_type:{name:'DEPOSIT'},description:'Owner capital contribution'});}});
  await assert.rejects(external.run(),cashFailure('INCOME_NORMALIZATION_EXTERNAL','PROOF'));
});
test('historical trade proof failures preserve strict identities, boundaries and cent checks',async t=>{
  const f=await cashDateFixture(),valid=await f.run();
  for(const [name,change,site] of [
    ['schema',p=>p.extra=true,'TRADE_PROOF_SCHEMA'],
    ['leg schema',p=>p.cashLeg.id=0,'TRADE_PROOF_LEG_SCHEMA'],
    ['cash amount',p=>p.cashLeg.amountCents++,'TRADE_PROOF_LINK'],
    ['boundary',p=>p.cashLeg.balanceCents++,'TRADE_PROOF_BOUNDARY'],
    ['proof hash',p=>p.proofId='a'.repeat(64),'TRADE_PROOF_HASH']
  ])await t.test(name,()=>{const bad=structuredClone(valid);change(bad.cashDateNormalizations[0]);assert.throws(()=>validateIbManagerReportInput(bad,f.expected),cashFailure(site,'PROOF'));});
  assert.deepEqual(validateIbManagerReportInput(valid,f.expected),valid);
  assert.equal(JSON.stringify(valid).includes('cashSite'),false);assert.equal(JSON.stringify(valid).includes('cashDateRole'),false);
});

test('one-off diagnostic validates real reader receipts without applying, writing or exposing the report',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ib-readonly-test-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const b=await buildIbManagerReportBundle(await source(),lock());
  const payload={...feeData(),ibManagerReturnReceipt:b.returnReceipt,ibManagerDrawdownReceipt:b.drawdownReceipt,ibManagerSourceState:b.sourceState,ibManagerSourceStatus:{state:'verified',targetDate:baseline.asOf}};
  const original=structuredClone(payload),environ={IB_MANAGER_READ_ENABLED:'true',IB_MANAGER_BASELINE_SHA256:lock()};
  const w=wire({mutate:b=>{if(b.portfolios)b.portfolios.push({id:999,name:'Other synthetic account',currency_code:'USD'});}}),transport=ibDiagnosticTransport({fetchImpl:w.fetchImpl,anchor:baseline.asOf,target:add(baseline.asOf),now:()=>Date.parse(IB_DIAGNOSTIC_PLAN.from)+60000});
  const boundedReader=new SharesightIbManagerReader({clientId:'synthetic-client',clientSecret:'synthetic-secret',fetchImpl:transport.fetch});
  const result=await inspectIbDiagnostic({payload,anchorDate:baseline.asOf,targetDate:add(baseline.asOf),outputDir:dir,environ,reader:boundedReader});transport.stop();
  assert.equal(result.status,'source-and-receipts-verified');assert.equal(result.fullReportVerified,false);assert.equal(result.publicationReady,false);assert.equal(result.temporaryInputsCleaned,true);
  assert.equal(w.calls.filter(c=>c.method==='POST').length,2);assert.equal(w.calls.some(c=>c.url.includes('/999/')),false);assert.equal(transport.counts().oauthGrants,2);assert.deepEqual(payload,original);assert.deepEqual(fs.readdirSync(dir),[]);
  for(const [error,expected,site,role] of [[new IbManagerSourceError('CASH_RECONCILIATION','DAILY_CHAIN_END','TARGET'),'IB_SOURCE_CASH_RECONCILIATION','DAILY_CHAIN_END','TARGET'],[new IbManagerSourceError('CASH_RECONCILIATION','PRIVATE_CANARY','PRIVATE_CANARY'),'IB_SOURCE_CASH_RECONCILIATION','UNCLASSIFIED','NONE'],[new Error('PRIVATE_CANARY amount=123456'),'IB_SOURCE_NETWORK','UNCLASSIFIED','NONE']]){
    let reads=0;const reader={async readStable(){reads++;throw error;}};
    const r=await inspectIbDiagnostic({payload,anchorDate:baseline.asOf,targetDate:add(baseline.asOf),outputDir:dir,environ,reader});assert.equal(reads,1);assert.equal(r.status,'incomplete');assert.equal(r.reasonCode,expected);assert.equal(r.cashSite,site);assert.equal(r.cashDateRole,role);assert.equal(r.temporaryInputsCleaned,true);assert.equal(JSON.stringify(r).includes('PRIVATE_CANARY'),false);assert.deepEqual(payload,original);assert.deepEqual(fs.readdirSync(dir),[]);
  }
  for(const change of [p=>delete p.ibManagerSourceState,p=>p.ibManagerSourceState.stateId='e'.repeat(64)]){
    const p=structuredClone(payload);change(p);const r=await inspectIbDiagnostic({payload:p,anchorDate:baseline.asOf,targetDate:add(baseline.asOf),outputDir:dir,environ,reader:{readStable:()=>assert.fail('bad baseline must not read Sharesight')}});assert.equal(r.status,'incomplete');assert.equal(r.phase,'BASE_STATE');
  }
});

test('diagnostic transport restricts exact dates, methods and budgets before external IO',async()=>{
  let calls=0,clock=Date.parse(IB_DIAGNOSTIC_PLAN.from)+60000;const transport=ibDiagnosticTransport({fetchImpl:async()=>{calls++;return new Response(JSON.stringify({portfolios:[{id:1,name:'IB-HK',currency_code:'USD'}]}));},now:()=>clock});
  const base='https://api.sharesight.com',get={method:'GET'};
  for(const [url,init] of [[base+'/api/v2/portfolios.json',{method:'POST',body:'PRIVATE'}],[base+'/api/v2/portfolios.json?extra=1',get],['https://example.invalid/api/v2/portfolios.json',get],[base+'/api/v3/portfolios/1/trades.json?consolidated=false&start_date=2026-11-03&end_date=2026-11-04',get],[base+'/api/v2/portfolios/1/cash_accounts.json?date=2026-11-04',get],[base+'/api/v2/cash_accounts/3/cash_account_transactions.json?from=2026-11-03&to=2026-11-04',get]])await assert.rejects(transport.fetch(url,init),/ROUTE/);
  assert.equal(calls,0);
  for(let i=0;i<IB_DIAGNOSTIC_PLAN.maxGets;i++)await transport.fetch(base+'/api/v2/portfolios.json',get);
  await assert.rejects(transport.fetch(base+'/api/v2/portfolios.json',get),/BUDGET/);assert.equal(calls,IB_DIAGNOSTIC_PLAN.maxGets);assert.equal(transport.refusal(),'BUDGET');
  for(let i=0;i<IB_DIAGNOSTIC_PLAN.maxGrants;i++)await transport.fetch(base+'/oauth2/token',{method:'POST',body:'synthetic'});
  await assert.rejects(transport.fetch(base+'/oauth2/token',{method:'POST'}),/BUDGET/);assert.deepEqual(transport.counts(),{sourceGets:IB_DIAGNOSTIC_PLAN.maxGets,oauthGrants:IB_DIAGNOSTIC_PLAN.maxGrants});
  transport.stop();await assert.rejects(transport.fetch(base+'/api/v2/portfolios.json',get),/ROUTE/);
  const expired=ibDiagnosticTransport({fetchImpl:()=>assert.fail('expired transport'),now:()=>clock});clock+=14*60000+1;await assert.rejects(expired.fetch(base+'/api/v2/portfolios.json',get),/EXPIRED/);assert.equal(expired.refusal(),'EXPIRED');expired.stop();
});

function diagnosticWire(change=()=>{}){
  const calls=[],base='https://api.sharesight.com',target=IB_DIAGNOSTIC_PLAN.target;
  const transport=ibDiagnosticTransport({now:()=>Date.parse(IB_DIAGNOSTIC_PLAN.from)+60000,fetchImpl:async(url,init)=>{
    calls.push({url,method:init.method});const u=new URL(url),p=u.pathname,q=u.searchParams;
    let body=p==='/api/v2/portfolios.json'?{portfolios:[{id:1,name:'IB-HK',currency_code:'USD'},{id:999,name:'Other synthetic account',currency_code:'USD'}]}:
      p==='/api/v2/portfolios/1/cash_accounts.json'?{cash_accounts:[{id:3,portfolio_id:1,date:q.get('date')}]}:
      p==='/api/v3/portfolios/1/performance'?{report:{portfolio_id:1,end_date:q.get('end_date'),cash_accounts:[{id:3,portfolio:{id:1}}]}}:
      p==='/api/v2/cash_accounts/3/cash_account_transactions.json'?{cash_account_transactions:[{id:4,cash_account_id:3,cash_account_transaction_type:{name:'Payout'},trade_id:null,holding_id:2,payout_id:13,date_time:target+'T00:00:00.000Z'}]}:{};
    change(body,{p,q,calls});const response=new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});Object.defineProperty(response,'url',{value:url});return response;
  }});
  return {calls,transport,get:route=>transport.fetch(base+route,{method:'GET'})};
}
test('diagnostic routes require this read portfolio, cash account and exact target payout references',async()=>{
  const f=diagnosticWire(),target=IB_DIAGNOSTIC_PLAN.target,anchor=IB_DIAGNOSTIC_PLAN.anchor;
  try{
    await assert.rejects(f.get('/api/v3/portfolios/1/holdings?consolidated=false'),/ROUTE/);assert.equal(f.calls.length,0);
    await f.get('/api/v2/portfolios.json');
    await assert.rejects(f.get('/api/v3/portfolios/999/holdings?consolidated=false'),/ROUTE/);
    await assert.rejects(f.get('/api/v2/cash_accounts/3/cash_account_transactions.json?from='+target+'&to='+target),/ROUTE/);
    await f.get('/api/v2/portfolios/1/cash_accounts.json?date='+anchor);
    await f.get('/api/v2/portfolios/1/cash_accounts.json?date='+target);
    await assert.rejects(f.get('/api/v2/cash_accounts/99/cash_account_transactions.json?from='+target+'&to='+target),/ROUTE/);
    await assert.rejects(f.get('/api/v2/payouts/13.json'),/ROUTE/);
    await f.get('/api/v2/cash_accounts/3/cash_account_transactions.json?from='+target+'&to='+target);
    await f.get('/api/v2/payouts/13.json');await assert.rejects(f.get('/api/v2/payouts/99.json'),/ROUTE/);
    await assert.rejects(f.get('/api/v2/payouts/13.json?extra=1'),/ROUTE/);
    await assert.rejects(f.get('/api/v2/cash_accounts/3/cash_account_transactions.json?from='+anchor+'&to='+target),/ROUTE/);
    await f.get('/api/v2/portfolios.json');
    await assert.rejects(f.get('/api/v2/payouts/13.json'),/ROUTE/);
    await assert.rejects(f.get('/api/v2/cash_accounts/3/cash_account_transactions.json?from='+target+'&to='+target),/ROUTE/);
    assert.equal(f.calls.some(c=>/\/999\/|\/99\//.test(c.url)),false);
    const query=new URLSearchParams({consolidated:'false',end_date:anchor,grouping:'investment_type',include_limited:'false',include_sales:'false',report_combined:'false',start_date:anchor});
    await f.get('/api/v3/portfolios/1/performance?'+query);
    await f.get('/api/v2/cash_accounts/3/cash_account_transactions.json?from='+target+'&to='+target);
  }finally{f.transport.stop();}
});
test('diagnostic identity responses and payout aliases cannot broaden the read boundary',async t=>{
  const target=IB_DIAGNOSTIC_PLAN.target;
  for(const [name,change,route] of [
    ['ambiguous IB identity',b=>{if(b.portfolios)b.portfolios.push({id:2,name:'IB-HK',currency_code:'USD'});},'/api/v2/portfolios.json'],
    ['wrong cash portfolio',b=>{if(b.cash_accounts)b.cash_accounts[0].portfolio_id=999;},'/api/v2/portfolios/1/cash_accounts.json?date='+target],
    ['wrong cash date',b=>{if(b.cash_accounts)b.cash_accounts[0].date=IB_DIAGNOSTIC_PLAN.anchor;},'/api/v2/portfolios/1/cash_accounts.json?date='+target],
    ['wrong row account',b=>{if(b.cash_account_transactions)b.cash_account_transactions[0].cash_account_id=999;},'/api/v2/cash_accounts/3/cash_account_transactions.json?from='+target+'&to='+target]
  ])await t.test(name,async()=>{
    const f=diagnosticWire(change);try{
      if(route!=='/api/v2/portfolios.json')await f.get('/api/v2/portfolios.json');
      if(route.includes('/cash_account_transactions.json'))await f.get('/api/v2/portfolios/1/cash_accounts.json?date='+target);
      await assert.rejects(f.get(route),/ROUTE/);assert.equal(f.transport.refusal(),'ROUTE');
    }finally{f.transport.stop();}
  });
  for(const [name,change] of [
    ['wrong day',r=>r.date_time=IB_DIAGNOSTIC_PLAN.anchor+'T00:00:00.000Z'],
    ['nonmidnight',r=>r.date_time=target+'T01:00:00.000Z'],
    ['trade linked',r=>r.trade_id=9],['no holding',r=>r.holding_id=null],
    ['unsafe ID',r=>r.payout_id=Number.MAX_SAFE_INTEGER+1],['wrong type',r=>r.cash_account_transaction_type.name='PAYOUT_EXTRA']
  ])await t.test(name,async()=>{
    const f=diagnosticWire(b=>{if(b.cash_account_transactions)change(b.cash_account_transactions[0]);});try{
      await f.get('/api/v2/portfolios.json');await f.get('/api/v2/portfolios/1/cash_accounts.json?date='+target);
      await f.get('/api/v2/cash_accounts/3/cash_account_transactions.json?from='+target+'&to='+target);
      const count=f.calls.length;await assert.rejects(f.get('/api/v2/payouts/13.json'),/ROUTE/);assert.equal(f.calls.length,count);
    }finally{f.transport.stop();}
  });
});
test('diagnostic absolute deadline and response size fail closed before any following request',async()=>{
  const route='https://api.sharesight.com/api/v2/portfolios.json',get={method:'GET'},expires=Date.parse(IB_DIAGNOSTIC_PLAN.expires);
  let clock=expires,calls=0;const before=ibDiagnosticTransport({now:()=>clock,fetchImpl:async()=>{calls++;return new Response('{}');}});
  await assert.rejects(before.fetch(route,get),/EXPIRED/);assert.equal(calls,0);before.stop();
  clock=expires-1;const after=ibDiagnosticTransport({now:()=>clock,fetchImpl:async()=>{calls++;clock=expires;return new Response('{}');}});
  await assert.rejects(after.fetch(route,get),/EXPIRED/);assert.equal(calls,1);assert.equal(after.refusal(),'EXPIRED');after.stop();
  const large=ibDiagnosticTransport({now:()=>Date.parse(IB_DIAGNOSTIC_PLAN.from)+60000,fetchImpl:async()=>new Response(' '.repeat(2*1024*1024+1))});
  await assert.rejects(large.fetch(route,get),/ROUTE/);assert.equal(large.counts().sourceGets,1);large.stop();
});

test('diagnostic event and metadata reject mixed modes, reruns, duplicates and changed heads',async()=>{
  const head='a'.repeat(40),now=new Date(Date.parse(IB_DIAGNOSTIC_PLAN.from)+3600000),id='50000000000';
  const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'huanwujoy-crypto/fee-console',GITHUB_REF:'refs/heads/main',GITHUB_SHA:head,GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_ACTOR_ID:'283054367',GITHUB_RUN_ATTEMPT:'1',GITHUB_RUN_ID:id,FEE_IB_DIAGNOSTIC_ACTIONS_TOKEN:'synthetic-token-not-a-secret'};
  const event={inputs:{ib_diagnostic_once:'true',ib_diagnostic_main:head}};
  validateIbDiagnosticEvent({env,event,expectedMain:head,now});
  validateIbDiagnosticEvent({env,event:{inputs:{...event.inputs,confirmed_main:''}},expectedMain:head,now});
  for(const confirmed_main of [head,null,false,0])assert.throws(()=>validateIbDiagnosticEvent({env,event:{inputs:{...event.inputs,confirmed_main}},expectedMain:head,now}),/ARGUMENT/);
  for(const [k,v] of [['GITHUB_RUN_ATTEMPT','2'],['GITHUB_EVENT_NAME','schedule'],['GITHUB_ACTOR_ID','1'],['GITHUB_REF','refs/heads/other'],['GITHUB_SHA','b'.repeat(40)]])assert.throws(()=>validateIbDiagnosticEvent({env:{...env,[k]:v},event,expectedMain:head,now}),/ENVIRONMENT/);
  for(const [k,v] of [['ratio_plan','{}'],['run_reviewed_once','true'],['source_acceptance_once','true'],['report_target',IB_DIAGNOSTIC_PLAN.target],['unknown','x']])assert.throws(()=>validateIbDiagnosticEvent({env,event:{inputs:{...event.inputs,[k]:v}},expectedMain:head,now}),/ARGUMENT/);
  for(const at of [Date.parse(IB_DIAGNOSTIC_PLAN.from)-1,Date.parse(IB_DIAGNOSTIC_PLAN.expires)+1])assert.throws(()=>validateIbDiagnosticEvent({env,event,expectedMain:head,now:new Date(at)}),/EXPIRED/);
  const current={id:Number(id),head_sha:head,head_branch:'main',path:'.github/workflows/fee-cloud-producer.yml',event:'workflow_dispatch',actor:{id:283054367},run_attempt:1,status:'in_progress',conclusion:null,display_title:IB_DIAGNOSTIC_PLAN.name,created_at:new Date(now.getTime()-60000).toISOString()};
  const wire=(mutate=()=>{})=>async(url,init)=>{assert.equal(init.method,'GET');assert.equal(init.redirect,'error');let value=url.endsWith('/git/ref/heads/main')?{object:{sha:head}}:url.includes('/commits/')?{sha:head,author:{id:283054367},commit:{verification:{verified:true}}}:url.includes('/actions/runs?')?{total_count:1,workflow_runs:[structuredClone(current)]}:structuredClone(current);mutate(value,url);const r=new Response(JSON.stringify(value));Object.defineProperty(r,'url',{value:url});return r;};
  await verifyIbDiagnosticRun({env,expectedMain:head,now,fetchImpl:wire()});
  for(const [change,reason] of [[v=>{if(v.object)v.object.sha='b'.repeat(40);},/HEAD/],[v=>{if(v.verification)v.verification.verified=false;if(v.commit)v.commit.verification.verified=false;},/HEAD/],[v=>{if(v.run_attempt)v.run_attempt=2;},/RUN/],[v=>{if(v.workflow_runs){v.workflow_runs.unshift({...current,id:Number(id)-1,status:'completed',conclusion:'failure'});v.total_count++;}},/DUPLICATE/],[v=>{if(v.workflow_runs)v.total_count++;},/METADATA/]])await assert.rejects(verifyIbDiagnosticRun({env,expectedMain:head,now,fetchImpl:wire(change)}),reason);
  assert.throws(()=>validateIbDiagnosticBase({data:Buffer.from('{}'),health:Buffer.from('{}'),now}),/BASE_BYTES/);
});

test('diagnostic workflow excludes production and scopes the existing economic locator to read-only execution',()=>{
  const text=fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml',import.meta.url),'utf8');
  const diagnostic=text.split('\n  ib-diagnostic:')[1];assert.ok(diagnostic);
  const original=text.split('\n  ib-diagnostic:')[0];
  for(const job of ['period','once-admit','produce','once-finish','source-plan-check','source-acceptance','ratio-preflight','ratio']){
    const section=original.split('\n  '+job+':')[1].split(/\n  [a-z][a-z-]+:/)[0];assert.match(section,/if: \$\{\{ !inputs\.ib_diagnostic_once && !inputs\.ib_diagnostic_main &&/);
  }
  assert.match(diagnostic,/timeout-minutes: 15/);assert.match(diagnostic,/actions: read/);assert.doesNotMatch(diagnostic,/contents: write|actions: write|FEE_CLOUD_GITHUB_TOKEN|FEE_ECON_GITHUB_TOKEN|FEE_RATIO_MANAGER_TOKEN|upload-artifact|promote|daily\.mjs/);
  assert.ok(diagnostic.indexOf('--check-plan')<diagnostic.indexOf('google-github-actions/auth@'));
  assert.match(diagnostic,/if: always\(\)/);assert.match(text,/group: fee-cloud-producer\n  cancel-in-progress: false/);
  const beforeCredentials=diagnostic.split('      - name: Reuse the existing read identity')[0];
  assert.doesNotMatch(beforeCredentials,/FEE_ECON_GIST_ID|FEE_DATA_KEY|FEE_CLOUD_SHARESIGHT_CLIENT_(?:ID|SECRET)/);
  const privateRead=diagnostic.split('      - name: Inspect Jenny without a writer or publication token')[1].split('      - name: Remove diagnostic temporary inputs')[0];
  assert.equal((diagnostic.match(/FEE_ECON_GIST_ID:/g)||[]).length,1);
  assert.match(privateRead,/FEE_ECON_GIST_ID: \$\{\{ secrets\.FEE_ECON_GIST_ID \}\}/);
  assert.match(privateRead,/node scripts\/fee-source-revision-diagnostic\.mjs --expected-main=/);
  const source=fs.readFileSync(new URL('./fee-source-revision-diagnostic.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/\.apply\(payload|produce\(|produceReportPeriod\(|writeFileSync\(|execFileSync\('(?!git)/);
  assert.match(source,/fetchEconomicSnapshot\(\{fetchImpl:transport\.fetch,tempRoot:storage\.directory,attempts:1\}\)/);
  assert.match(source,/diagnosticOnly:true/);
});
function wire({mutate=()=>{},changeSecond=false}={}){
  const calls=[];let capture=0;
  const fetchImpl=async(url,init)=>{
    calls.push({url,method:init.method});const u=new URL(url),p=u.pathname,q=u.searchParams;let body;
    assert.equal(u.origin,'https://api.sharesight.com');assert.equal(init.redirect,'error');
    if(p==='/oauth2/token'){capture++;assert.equal(init.method,'POST');assert.match(init.body,/grant_type=client_credentials/);body={access_token:'synthetic-access-token-123456',token_type:'bearer'};}
    else{
      assert.equal(init.method,'GET');assert.equal(init.headers.Authorization,'Bearer synthetic-access-token-123456');
      if(p==='/api/v2/portfolios.json')body={portfolios:[{id:1,name:'IB-HK',currency_code:'USD'}]};
      else if(p==='/api/v3/portfolios/1/holdings')body={holdings:[{id:2,valid_position:true,portfolio:{id:1,name:'IB-HK'}}]};
      else if(p==='/api/v3/portfolios/1/performance'){
        const d=q.get('end_date');assert.equal(q.get('start_date'),d);
        const value=d<'2026-09-02'?100:d==='2026-09-02'?85:86;
        const cash=d<'2026-09-01'?0:50;
        body={report:{portfolio_id:1,start_date:d,end_date:d,currency:{code:'USD'},portfolio_tz_name:'America/New_York',include_sales:false,value:value+cash,
          holdings:[{id:2,value,quantity:1,valid_position:true,portfolio:{id:1,name:'IB-HK'},instrument_currency:{code:'USD'}}],cash_accounts:[{id:3,value:cash,currency:{code:'USD'},portfolio:{id:1,name:'IB-HK'}}]}};
      }else if(p==='/api/v2/portfolios/1/cash_accounts.json')body={cash_accounts:[{id:3,portfolio_id:1,portfolio_currency:'USD',currency:'USD',date:q.get('date'),balance:50,balance_in_portfolio_currency:50}]};
      else if(p==='/api/v3/portfolios/1/trades.json')body={trades:[]};
      else if(p==='/api/v2/cash_accounts/3/cash_account_transactions.json')body={cash_account_transactions:q.get('from')<='2026-09-01'?[{id:4,cash_account_id:3,date_time:'2026-09-01T12:00:00Z',amount:50,balance:50,cash_account_transaction_type:{name:'DEPOSIT'},description:'Owner cash contribution'}]:[]};
      else if(p==='/api/v2/cash_accounts/5/cash_account_transactions.json')body={cash_account_transactions:[]};
      else if(/^\/api\/v2\/payouts\/[1-9]\d*\.json$/.test(p))body={};
      else assert.fail('unexpected route '+p);
    }
    mutate(body,{p,q,capture});
    if(changeSecond&&capture===2&&body.report)body.report.unstableMarker=true;
    const response=new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});Object.defineProperty(response,'url',{value:url});return response;
  };
  return {calls,fetchImpl,reader:new SharesightIbManagerReader({clientId:'synthetic-client',clientSecret:'synthetic-secret',fetchImpl})};
}
const read=(w,extra={})=>w.reader.readStable({targetDate:baseline.asOf,expectedBaselineHash:lock(),baseline,...extra});
const source=async()=>read(wire());
// Canonical synchronization format with synthetic account, date and amount.
const bankWireMemo=(display='50',keyAmount='50.00',d='2026-09-01')=>`IBKR U1000001 bank wire USD ${display}, received and available ${d} per Transfer Status & History and IBKR notice; source bank not verified. key=ib.manual|U1000001|wire|${d}|USD|${keyAmount}`;
function bankWireFixture(change=()=>{},changeBody=()=>{}){
  return wire({mutate:(b,c)=>{if(b.cash_account_transactions?.length){const row=b.cash_account_transactions[0];row.description=bankWireMemo();row.foreign_identifier=null;change(row,b,c);}changeBody(b,c);}});
}
test('canonical bank wire is an external cash flow, not investment income, and preserves the source date',async()=>{
  const old=await source(),fresh=await read(bankWireFixture());
  assert.deepEqual(fresh.periodReturnsInput,old.periodReturnsInput);assert.deepEqual(fresh.cashFlowByDate,old.cashFlowByDate);
  assert.equal(fresh.cashFlowByDate['2026-09-01'],50);
  assert.deepEqual(fresh.closingSnapshots,old.closingSnapshots);
  const decimal=await read(bankWireFixture(r=>{r.description=bankWireMemo('50.00');}));
  assert.deepEqual(decimal.periodReturnsInput,fresh.periodReturnsInput);
});
test('canonical grouped bank-wire amount agrees exactly with both native cash and memo key',async()=>{
  const changed=input();changed.flowByDate['2026-09-01']=5000;
  changed.points=changed.points.map(p=>({...p,tot:p.tot+(p.d>='2026-09-01'?4950:0)}));
  const f=bankWireFixture(r=>{r.amount=5000;r.balance=5000;r.description=bankWireMemo('5,000','5000.00');},(b,c)=>{
    if(b.report&&b.report.end_date>='2026-09-01'){b.report.value+=4950;b.report.cash_accounts[0].value+=4950;}
    if(b.cash_accounts&&c.q.get('date')>='2026-09-01')for(const row of b.cash_accounts){row.balance+=4950;row.balance_in_portfolio_currency+=4950;}
  });
  const result=await read(f,{expectedBaselineHash:ibBaselineBusinessHash(changed)});
  assert.equal(result.cashFlowByDate['2026-09-01'],5000);assert.deepEqual(result.periodReturnsInput,changed);
});
test('bank-wire admission requires every identifying field and rejects ambiguous or conflicting formats',async t=>{
  for(const [name,change] of [
    ['memo amount',r=>r.description=bankWireMemo('49.99')],
    ['key amount',r=>r.description=bankWireMemo('50','49.99')],
    ['native cents',r=>r.amount=50.01],
    ['zero movement',r=>r.amount=0],
    ['negative movement',r=>r.amount=-50],
    ['wrong type',r=>r.cash_account_transaction_type.name='WITHDRAWAL'],
    ['unknown type',r=>r.cash_account_transaction_type.name='UNKNOWN'],
    ['trade pointer',r=>r.trade_id=8],
    ['holding pointer',r=>r.holding_id=2],
    ['payout pointer',r=>r.payout_id=13],
    ['foreign identifier',r=>r.foreign_identifier='synthetic-source-reference'],
    ['empty foreign identifier',r=>r.foreign_identifier=''],
    ['memo date',r=>r.description=bankWireMemo().replace('available 2026-09-01','available 2026-09-02')],
    ['key date',r=>r.description=bankWireMemo().replace('|2026-09-01|','|2026-09-02|')],
    ['both dates differ',r=>r.description=bankWireMemo('50','50.00','2026-09-02')],
    ['invalid calendar day',r=>r.description=bankWireMemo('50','50.00','2026-02-30')],
    ['different key account',r=>r.description=bankWireMemo().replace('|U1000001|','|U1000002|')],
    ['leading-zero account',r=>r.description=bankWireMemo().replaceAll('U1000001','U0000001')],
    ['wrong memo currency',r=>r.description=bankWireMemo().replace('wire USD','wire CAD')],
    ['wrong key currency',r=>r.description=bankWireMemo().replace('|USD|','|CAD|')],
    ['bad grouping',r=>r.description=bankWireMemo('0,050')],
    ['leading-zero key amount',r=>r.description=bankWireMemo('50','050.00')],
    ['fraction precision',r=>r.description=bankWireMemo('50.000')],
    ['exponent amount',r=>r.description=bankWireMemo('5e1')],
    ['oversize amount',r=>r.description=bankWireMemo('999999999999999999999999')],
    ['partial memo',r=>r.description='IBKR U1000001 bank wire USD 50'],
    ['generic bank wire',r=>r.description='bank wire received'],
    ['extra owner marker cannot rescue malformed bank memo',r=>r.description='Owner cash contribution; '+bankWireMemo('49.99')],
    ['income conflict',r=>r.description=bankWireMemo()+' DIVIDEND'],
    ['trade conflict',r=>r.description=bankWireMemo()+' SELL PROCEEDS'],
    ['FX conflict',r=>r.description=bankWireMemo()+' FX'],
    ['adjustment conflict',r=>r.description=bankWireMemo()+' AUTOMATIC ADJUSTMENT'],
    ['newline',r=>r.description=bankWireMemo()+'\n'],
    ['embedded control',r=>r.description=bankWireMemo().replace('received','re\u0000ceived')],
    ['Unicode direction control',r=>r.description=bankWireMemo()+'\u202e']
  ])await t.test(name,async()=>{
    await assert.rejects(read(bankWireFixture(change)),e=>{assert.equal(e.message,'IB_SOURCE_UNRESOLVED_FLOW');assert.equal(JSON.stringify(e),'{"code":"UNRESOLVED_FLOW"}');return true;});
  });
});
test('bank wire cannot bypass duplicate, date, portfolio, precision or balance conservation checks',async t=>{
  for(const [name,change,code] of [
    ['duplicate ID',(r,b)=>b.cash_account_transactions.push({...r}),/IB_SOURCE_IDENTITY/],
    ['same key new ID',(r,b)=>b.cash_account_transactions.push({...r,id:40}),/IB_SOURCE_IDENTITY/],
    ['wrong cash account',r=>r.cash_account_id=99,/IB_SOURCE_IDENTITY/],
    ['wrong portfolio link',r=>r.links={portfolio:'https://api.sharesight.com/api/v2/portfolios/99'},/IB_SOURCE_IDENTITY/],
    ['USD subcent',r=>r.amount=50.001,/IB_SOURCE_AMOUNT/],
    ['unproved midnight day carrier',r=>r.date_time='2026-09-01T00:00:00.000Z',/IB_SOURCE_DATE_ALIGNMENT/],
    ['balance mismatch',r=>r.balance+=0.01,/IB_SOURCE_CASH_RECONCILIATION/]
  ])await t.test(name,async()=>{await assert.rejects(read(bankWireFixture(change)),code);});
});
function foreignPassive(body,{p,q}){
  const instrument={id:7,code:'SYNTH',market_code:'TSE',currency_code:'CAD'};
  if(p.endsWith('/holdings'))body.holdings[0].instrument=instrument;
  if(body.report){const h=body.report.holdings[0];h.instrument=instrument;h.instrument_currency={code:'CAD'};h.instrument_price=200;}
}
test('passive foreign-currency holding uses dated portfolio USD value, not native price times quantity',async()=>{
  const a=await source(),b=await read(wire({mutate:foreignPassive}));
  assert.deepEqual(b.periodReturnsInput,a.periodReturnsInput);assert.deepEqual(b.cashFlowByDate,a.cashFlowByDate);
});
test('foreign holding compatibility does not permit FX trades, identity changes or unproved quantity/valuation changes',async()=>{
  for(const [change,code] of [
    [(body,{p})=>{if(p.endsWith('/trades.json'))body.trades=[{id:8,portfolio_id:1,holding_id:2,state:'confirmed',transaction_date:'2026-09-02',description_code:'SELL',value:200,quantity:1}];},/UNSUPPORTED_CURRENCY/],
    [(body)=>{if(body.report)body.report.holdings[0].instrument.currency_code='EUR';},/IDENTITY/],
    [(body)=>{if(body.report)body.report.holdings[0].instrument_currency.code='US';},/IDENTITY/],
    [(body)=>{if(body.report)body.report.holdings[0].value=200;},/AMOUNT/],
    [(body)=>{if(body.report)delete body.report.holdings[0].instrument;},/IDENTITY/]
  ])await assert.rejects(read(wire({mutate:(body,ctx)=>{foreignPassive(body,ctx);change(body,ctx);}})),code);
  const {state}=await frozenFixture();
  await assert.rejects(read(wire({mutate:(body,ctx)=>{foreignPassive(body,ctx);if(body.report?.end_date==='2026-09-03')body.report.holdings[0].quantity=2;}}),{targetDate:'2026-09-03',ownerBaseline:state}),/UNVERIFIED_TRANSFER/);
});
test('foreign holding currency is bound across stable reads and future checkpoints',async()=>{
  const {state}=await frozenFixture(),body={schema:'fee-console.ib-manager-coverage.v2',authority:'reviewed-source-reconciliation',sourceProvider:'Sharesight',baselineInputsHash:lock(),from:'2026-09-03',through:'2026-09-03',evidenceSha256:'e'.repeat(64),events:[],quotes:[]},coverage={...body,coverageId:await createIbManagerReturnConsumer().digest(body)};
  const first=await read(wire({mutate:foreignPassive}),{targetDate:'2026-09-03',ownerBaseline:state,bootstrapCoverage:coverage});
  assert.deepEqual(first.closingSnapshots.map(s=>s.foreignCurrencies),[{'2':'CAD'},{'2':'CAD'}]);
  const next=await read(wire({mutate:foreignPassive}),{targetDate:'2026-09-04',checkpoint:first});
  assert.deepEqual(next.periodReturnsInput.points.slice(0,3),input().points);
  for(const mutate of [s=>s.closingSnapshots[0].foreignCurrencies[2]='EUR',s=>s.closingSnapshots[0].foreignCurrencies[99]='CAD',s=>s.closingSnapshots[0].marks[2]={},s=>s.closingSnapshots.forEach(x=>x.foreignCurrencies[2]='EUR')]){
    const bad=structuredClone(first);mutate(bad);await assert.rejects(read(wire({mutate:foreignPassive}),{targetDate:'2026-09-04',checkpoint:bad}),/STATE|PAST_POINT_CHANGED/);
  }
  await assert.rejects(read(wire({mutate:(b,c)=>{foreignPassive(b,c);if(c.capture===2){if(b.holdings)b.holdings[0].instrument.currency_code='EUR';if(b.report){b.report.holdings[0].instrument_currency.code='EUR';b.report.holdings[0].instrument.currency_code='EUR';}}}})),/UNSTABLE/);
  await assert.rejects(read(wire({mutate:(b,c)=>{foreignPassive(b,c);if(b.report?.end_date==='2026-09-02'){b.report.holdings[0].instrument_currency.code='EUR';b.report.holdings[0].instrument.currency_code='EUR';}}})),/IDENTITY/);
});
test('foreign zero-net trades and transfers remain rejected; explicit USD trade currency cannot conflict',async()=>{
  for(const kinds of [['BUY','SELL'],['TRANSFER_OUT']])await assert.rejects(read(wire({mutate:(b,c)=>{foreignPassive(b,c);if(b.trades)b.trades=kinds.map((kind,n)=>({id:80+n,portfolio_id:1,holding_id:2,state:'confirmed',transaction_date:'2026-09-02',description_code:kind,value:kind==='BUY'?10:-10,quantity:1}));}})),/UNSUPPORTED_CURRENCY/);
  await assert.rejects(read(wire({mutate:b=>{if(b.trades)b.trades=[{id:80,portfolio_id:1,holding_id:2,state:'confirmed',transaction_date:'2026-09-02',description_code:'BUY',value:10,quantity:1,instrument:{currency_code:'CAD'}}];}})),/IDENTITY/);
});
async function frozenFixture(){
  const frozen={schema:'fee-console.ib-manager-return-input.v1',currency:'USD',timezone:'America/New_York',flowTiming:'eod',flowsComplete:true,correctionsConfirmed:true,sourceSha256:'c'.repeat(64),periodReturnsInput:input()};
  const payload={ibManagerReturnReceipt:await buildIbManagerReturnReceipt(frozen),ibManagerDrawdownReceipt:await buildIbManagerDrawdownReceipt(frozen)};
  return {frozen,payload,state:await buildIbOwnerBaseline(payload,frozen,lock())};
}
test('owner-confirmed baseline retains corrected history and appends only reconciled native days',async()=>{
  const {payload,state}=await frozenFixture();payload.ibManagerBaselineState=state;
  assert.deepEqual(await validateIbOwnerBaselineState(payload,lock()),state);
  const w=wire(),s=await read(w,{targetDate:'2026-09-03',ownerBaseline:state});
  assert.equal(s.schema,'fee-console.ib-manager-source.v2');assert.deepEqual(s.periodReturnsInput.points.slice(0,3),input().points);assert.deepEqual(s.ownerBaseline,state);
  assert.equal(w.calls.filter(c=>c.url.includes('/performance?')).length,4); // opening + new day, twice
  const bundle=await buildIbManagerReportBundle(s,lock());assert.equal(bundle.returnReceipt.asOf,'2026-09-03');
  const out={...payload,ibManagerReturnReceipt:bundle.returnReceipt,ibManagerDrawdownReceipt:bundle.drawdownReceipt,ibManagerSourceState:bundle.sourceState};
  assert.deepEqual(await validateIbManagerReportState(out,lock()),s);
  assert.deepEqual((await read(wire(),{targetDate:'2026-09-03',checkpoint:s})).periodReturnsInput,s.periodReturnsInput);
});
test('future normal handoff needs finite audited coverage as well as authenticated history, before any source read',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ib-coverage-synthetic-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const points=[];for(let d='2026-08-01';d<='2026-10-23';d=add(d))points.push({d,tot:136});
  const frozen={schema:'fee-console.ib-manager-return-input.v1',currency:'USD',timezone:'America/New_York',flowTiming:'eod',flowsComplete:true,correctionsConfirmed:true,sourceSha256:'c'.repeat(64),periodReturnsInput:{points,openT:136,from:'2026-08-01',to:'2026-10-23',days:points.length,flowByDate:{},rate:0,cr:0,cumBefore:0,hwmBefore:0}};
  const payload={ibManagerReturnReceipt:await buildIbManagerReturnReceipt(frozen),ibManagerDrawdownReceipt:await buildIbManagerDrawdownReceipt(frozen)},expectedHash=ibBaselineBusinessHash(frozen.periodReturnsInput);
  payload.ibManagerBaselineState=await buildIbOwnerBaseline(payload,frozen,expectedHash);
  const body={schema:'fee-console.ib-manager-coverage.v1',authority:'reviewed-source-reconciliation',baselineInputsHash:expectedHash,from:'2026-10-24',through:'2026-10-30',evidenceSha256:'e'.repeat(64)},coverage={...body,coverageId:await createIbManagerReturnConsumer().digest(body)};
  const environ={IB_MANAGER_READ_ENABLED:'true',IB_MANAGER_BASELINE_SHA256:expectedHash};let calls=0;
  let prep=await prepareIbManagerReport({payload,targetDate:'2026-10-24',outputDir:dir,environ,reader:{readStable(){calls++;assert.fail('known migration coverage must hold');}}});
  assert.equal(prep.reasonCode,'IB_SOURCE_COVERAGE_UNVERIFIED');assert.equal(calls,0);fs.unlinkSync(prep.file);
  for(const mutate of [x=>x.through='2026-10-23',x=>x.through='2026-11-30',x=>x.coverageId='a'.repeat(64),x=>x.baselineInputsHash='a'.repeat(64),x=>x.authority='approved=true',x=>x.extra=true]){
    const bad=structuredClone(coverage);mutate(bad);await assert.rejects(validateIbManagerCoverage(bad,'2026-10-24',expectedHash),/COVERAGE_UNVERIFIED/);
  }
  await assert.rejects(validateIbManagerCoverage(coverage,'2026-10-31',expectedHash),/COVERAGE_UNVERIFIED/);
  await assert.rejects(validateIbManagerCoverage(coverage,'2026-10-30',expectedHash,'2026-10-23'),/COVERAGE_UNVERIFIED/);
  payload.ibManagerCoverageState=coverage;const w=wire();
  prep=await prepareIbManagerReport({payload,targetDate:'2026-10-24',outputDir:dir,environ,reader:w.reader});assert.equal(prep.state,'verified');assert.equal(w.calls.filter(x=>x.url.includes('/performance?')).length,4);
  const request=await loadIbManagerReport(prep.file,{environ});assert.equal(typeof request.apply,'function');assert.equal(payload.ibManagerReturnReceipt.asOf,'2026-10-23');
  const absent=structuredClone(payload);delete absent.ibManagerCoverageState;assert.throws(()=>request.apply(absent,'2026-10-24'),/REFUSED/);
  const raw=fs.readFileSync(prep.file),tampered=JSON.parse(raw);delete tampered.coverage;fs.writeFileSync(prep.file,JSON.stringify(tampered));
  await assert.rejects(loadIbManagerReport(prep.file,{environ}),/REFUSED/);fs.writeFileSync(prep.file,raw);
});
test('normal handoff continues a reviewed later frozen baseline without relabelling its dates or extending audited coverage',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ib-later-baseline-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const points=[];for(let d='2026-08-01';d<='2026-10-30';d=add(d))points.push({d,tot:136});
  const frozen={schema:'fee-console.ib-manager-return-input.v1',currency:'USD',timezone:'America/New_York',flowTiming:'eod',flowsComplete:true,correctionsConfirmed:true,sourceSha256:'c'.repeat(64),periodReturnsInput:{points,openT:136,from:'2026-08-01',to:'2026-10-30',days:points.length,flowByDate:{},rate:0,cr:0,cumBefore:0,hwmBefore:0}};
  const expected=ibBaselineBusinessHash(frozen.periodReturnsInput),environ={IB_MANAGER_READ_ENABLED:'true',IB_MANAGER_BASELINE_SHA256:expected};
  const payload={ibManagerReturnReceipt:await buildIbManagerReturnReceipt(frozen),ibManagerDrawdownReceipt:await buildIbManagerDrawdownReceipt(frozen)};
  payload.ibManagerBaselineState=await buildIbOwnerBaseline(payload,frozen,expected);
  const body={schema:'fee-console.ib-manager-coverage.v2',authority:'reviewed-source-reconciliation',sourceProvider:'Sharesight',baselineInputsHash:expected,from:'2026-10-31',through:'2026-10-31',evidenceSha256:'e'.repeat(64),events:[],quotes:[]};
  payload.ibManagerCoverageState={...body,coverageId:await createIbManagerReturnConsumer().digest(body)};
  const original=structuredClone(payload),w=wire(),targets=[],reader={async readStable(args){targets.push(args.targetDate);assert.deepEqual(args.baseline,{from:'2026-08-01',asOf:'2026-10-30'});return w.reader.readStable(args);}};
  const prep=await prepareIbManagerReport({payload,targetDate:'2026-11-02',outputDir:dir,environ,reader});
  assert.equal(prep.state,'verified');assert.deepEqual(targets,['2026-10-31','2026-11-02']);assert.deepEqual(payload,original);
  const request=JSON.parse(fs.readFileSync(prep.file));assert.equal(request.source.baselineAsOf,'2026-10-30');
  assert.deepEqual(request.source.periodReturnsInput.points.slice(0,points.length),points);assert.deepEqual(request.source.bootstrapCoverage,original.ibManagerCoverageState);
  assert.equal((await loadIbManagerReport(prep.file,{environ})).checkCurrent(),undefined);
  const b=await buildIbManagerReportBundle(request.source,expected),next={...payload,ibManagerReturnReceipt:b.returnReceipt,ibManagerDrawdownReceipt:b.drawdownReceipt,ibManagerSourceState:b.sourceState};
  fs.unlinkSync(prep.file);targets.length=0;
  const later=await prepareIbManagerReport({payload:next,targetDate:'2026-11-03',outputDir:dir,environ,reader});assert.equal(later.state,'verified');assert.deepEqual(targets,['2026-11-03']);
  fs.unlinkSync(later.file);let calls=0;const bad=structuredClone(payload);bad.ibManagerBaselineState.input.periodReturnsInput.to='2026-10-23';
  const refused=await prepareIbManagerReport({payload:bad,targetDate:'2026-11-02',outputDir:dir,environ,reader:{readStable(){calls++;}}});assert.equal(refused.state,'pending');assert.equal(calls,0);
});
test('baseline digest is not approval; original receipts, full correction and anchor are mandatory',async()=>{
  const {frozen,payload,state}=await frozenFixture(),bad=structuredClone(frozen);bad.periodReturnsInput.points[0].tot++;
  await assert.rejects(buildIbOwnerBaseline(payload,bad,ibBaselineBusinessHash(bad.periodReturnsInput)),/BASELINE_MISMATCH/);
  for(const mutate of [x=>x.input.periodReturnsInput.points[0].tot++,x=>x.stateId='b'.repeat(64),x=>x.input.correctionsConfirmed=false]){
    const copy=structuredClone(state);mutate(copy);await assert.rejects(read(wire(),{targetDate:'2026-09-03',ownerBaseline:copy}),/STATE|BASELINE/);
  }
  const forged=structuredClone(state);forged.returnReceiptId='d'.repeat(64);const {stateId,...body}=forged;forged.stateId=await createIbManagerReturnConsumer().digest(body);
  await assert.rejects(validateIbOwnerBaselineState({...payload,ibManagerBaselineState:forged},lock()),/STATE_INVALID/);
  const changed=wire({mutate:b=>{if(b.report?.end_date==='2026-09-02'){b.report.holdings[0].value++;b.report.value++;}}});
  await assert.rejects(read(changed,{targetDate:'2026-09-03',ownerBaseline:state}),/PAST_POINT_CHANGED/);
  const over=wire();await assert.rejects(read(over,{targetDate:'2026-09-20',ownerBaseline:state}),/HISTORY_LIMIT/);assert.equal(over.calls.length,0);
});

test('first normal report can prove a finite bootstrap boundary then extend to its final target without publishing the boundary',async t=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ib-boundary-synthetic-')));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const points=[];for(let d='2026-08-01';d<='2026-10-23';d=add(d))points.push({d,tot:136});
  const frozen={schema:'fee-console.ib-manager-return-input.v1',currency:'USD',timezone:'America/New_York',flowTiming:'eod',flowsComplete:true,correctionsConfirmed:true,sourceSha256:'c'.repeat(64),periodReturnsInput:{points,openT:136,from:'2026-08-01',to:'2026-10-23',days:points.length,flowByDate:{},rate:0,cr:0,cumBefore:0,hwmBefore:0}};
  const payload={ibManagerReturnReceipt:await buildIbManagerReturnReceipt(frozen),ibManagerDrawdownReceipt:await buildIbManagerDrawdownReceipt(frozen)},expectedHash=ibBaselineBusinessHash(frozen.periodReturnsInput);
  payload.ibManagerBaselineState=await buildIbOwnerBaseline(payload,frozen,expectedHash);
  const body={schema:'fee-console.ib-manager-coverage.v2',authority:'reviewed-source-reconciliation',sourceProvider:'Sharesight',baselineInputsHash:expectedHash,from:'2026-10-24',through:'2026-10-24',evidenceSha256:'e'.repeat(64),events:[],quotes:[]};
  payload.ibManagerCoverageState={...body,coverageId:await createIbManagerReturnConsumer().digest(body)};
  const environ={IB_MANAGER_READ_ENABLED:'true',IB_MANAGER_BASELINE_SHA256:expectedHash},w=wire(),before=structuredClone(payload),targets=[];
  const reader={readStable(args){targets.push(args.targetDate);return w.reader.readStable(args);}};
  const prepared=await prepareIbManagerReport({payload,targetDate:'2026-10-25',outputDir:dir,environ,reader});assert.equal(prepared.state,'verified');assert.deepEqual(targets,['2026-10-24','2026-10-25']);
  const request=JSON.parse(fs.readFileSync(prepared.file));assert.equal(request.targetDate,'2026-10-25');assert.equal(request.source.sourceAsOf,'2026-10-25');assert.deepEqual(request.coverage,payload.ibManagerCoverageState);assert.deepEqual(payload,before);
  assert.equal(w.calls.filter(x=>x.url.includes('/performance?')).length,8);assert.equal((await loadIbManagerReport(prepared.file,{environ})).checkCurrent(),undefined);
  fs.unlinkSync(prepared.file);targets.length=0;
  const failed=await prepareIbManagerReport({payload,targetDate:'2026-10-25',outputDir:dir,environ,reader:{async readStable(args){targets.push(args.targetDate);if(args.targetDate==='2026-10-25')throw Error('private-canary');return w.reader.readStable(args);}}});
  assert.equal(failed.state,'pending');assert.deepEqual(payload,before);assert.ok(!fs.readFileSync(failed.file,'utf8').includes('private-canary'));assert.deepEqual(targets,['2026-10-24','2026-10-25']);
});
test('owner baseline preserves original correction precision without downgrading or recertifying old native history',async()=>{
  const {frozen}=await frozenFixture();frozen.periodReturnsInput.points[0].tot=103.456;
  const expectedHash=ibBaselineBusinessHash(frozen.periodReturnsInput),payload={ibManagerReturnReceipt:await buildIbManagerReturnReceipt(frozen),ibManagerDrawdownReceipt:await buildIbManagerDrawdownReceipt(frozen)},state=await buildIbOwnerBaseline(payload,frozen,expectedHash);
  const s=await read(wire(),{targetDate:'2026-09-03',ownerBaseline:state,expectedBaselineHash:expectedHash});
  assert.equal(s.periodReturnsInput.points[0].tot,103.456);assert.equal(s.ownerBaseline.authority,'owner-confirmed-frozen');await buildIbManagerReportBundle(s,expectedHash);
  const edited=structuredClone(s);edited.periodReturnsInput.points[0].tot+=.0001;
  assert.equal(ibBaselineBusinessHash(edited.periodReturnsInput,baseline.asOf),expectedHash);
  await assert.rejects(buildIbManagerReportBundle(edited,expectedHash),/BASELINE_MISMATCH/);
});
test('native future transfer needs typed settlement evidence; a comment or unexplained loss refuses',async()=>{
  const {state}=await frozenFixture(),instrument={id:7,code:'SYNTH',market_code:'NYSE',currency_code:'USD'};
  const make=(code='TRANSFER_OUT',quantity=.5)=>wire({mutate:(b,{q})=>{
    if(b.holdings)b.holdings[0].instrument=instrument;
    if(b.report){const h=b.report.holdings[0];h.instrument=instrument;if(b.report.end_date==='2026-09-03'){h.quantity=quantity;h.value=86*quantity;b.report.value=h.value+50;}}
    if(b.trades)b.trades=[{id:8,portfolio_id:1,holding_id:2,state:'confirmed',transaction_date:'2026-09-03',description_code:code,quantity:.5,value:0,price:0,brokerage:0,instrument,comments:'transfer'}];
  }});
  const s=await read(make(),{targetDate:'2026-09-03',ownerBaseline:state});assert.equal(s.noncashProofs[0].authority,'source-native-transfer');assert.equal(s.periodReturnsInput.flowByDate['2026-09-03'],-43);
  const bundle=await buildIbManagerReportBundle(s,lock());assert.ok(Math.abs(bundle.drawdownReceipt.dailyFactors.at(-1).factor-136/135)<1e-12);
  await assert.rejects(read(make('SELL'),{targetDate:'2026-09-03',ownerBaseline:state}),/UNVERIFIED_TRANSFER/);
  await assert.rejects(read(make('TRANSFER_OUT',0),{targetDate:'2026-09-03',ownerBaseline:state}),/UNVERIFIED_TRANSFER|NONCASH_EVIDENCE/);
  const tampered=structuredClone(s);tampered.noncashProofs[0].authority='audited-baseline-source-native';await assert.rejects(buildIbManagerReportBundle(tampered,lock()),/NONCASH_EVIDENCE/);
});
test('the real reader full-disposal gate accepts both native value signs before the independent proof checks',async()=>{
  const {state}=await frozenFixture(),instrument={id:7,code:'SYNTH',market_code:'NYSE',currency_code:'USD'};
  for(const sign of [-1,1]){
    const w=wire({mutate:b=>{
      if(b.holdings)b.holdings=[];
      if(b.report){for(const h of b.report.holdings)h.instrument=instrument;if(b.report.end_date==='2026-09-03'){b.report.holdings=[];b.report.value=50;}}
      if(b.trades)b.trades=[{id:8,portfolio_id:1,holding_id:2,state:'confirmed',transaction_date:'2026-09-03',description_code:'TRANSFER_OUT',quantity:1,price:86,value:sign*86,brokerage:0,instrument}];
    }});
    const source=await read(w,{targetDate:'2026-09-03',ownerBaseline:state});assert.equal(source.noncashProofs[0].externalFlowCents,-8600);assert.equal(source.periodReturnsInput.flowByDate['2026-09-03'],-86);assert.ok((await buildIbManagerReportBundle(source,lock())).returnReceipt);
    const privateSentinel='SYNTHETIC_PRIVATE_RAW_RESPONSE';
    for(const key of ['originalResponseBody','pairedTransferEvidence','fundProfileEnvelope','holdings','trades','cashTransactions']){
      const bad=structuredClone(source);bad[key]=privateSentinel;
      await assert.rejects(buildIbManagerReportBundle(bad,lock()),error=>{assert.doesNotMatch(error.message,new RegExp(privateSentinel));return /SCHEMA/.test(error.message);});
    }
    const bad=structuredClone(source);bad.noncashProofs[0].originalTrade=privateSentinel;
    await assert.rejects(buildIbManagerReportBundle(bad,lock()),error=>{assert.doesNotMatch(error.message,new RegExp(privateSentinel));return /NONCASH_EVIDENCE/.test(error.message);});
  }
});

test('normal read is narrowly scoped, double-read, cent-normalized and baseline locked',async()=>{
  const w=wire(),s=await read(w);assert.deepEqual(s.periodReturnsInput,input());
  assert.equal(w.calls.filter(c=>c.method==='POST').length,2);
  assert.equal(w.calls.filter(c=>c.url.includes('/performance?')).length,8);
  assert.ok(w.calls.every(c=>c.method==='GET'||c.url.endsWith('/oauth2/token')));
  assert.equal(ibBaselineBusinessHash({...input(),flowByDate:{'2026-09-02':0,'2026-09-01':50}}),lock());
  const reversed=input();reversed.points.reverse();assert.equal(ibBaselineBusinessHash(reversed),lock());
  const bad=wire();await assert.rejects(read(bad,{expectedBaselineHash:''}),/BASELINE_LOCK/);assert.equal(bad.calls.length,0);
  await assert.rejects(read(wire(),{expectedBaselineHash:'a'.repeat(64)}),/BASELINE_MISMATCH/);
  const subcent=structuredClone(s);subcent.periodReturnsInput.points[0].tot+=.0001;
  assert.equal(ibBaselineBusinessHash(subcent.periodReturnsInput),lock());
  await assert.rejects(buildIbManagerReportBundle(subcent,lock()),/AMOUNT/);
});
test('scope, transport and dates fail closed without fallback grants or date guessing',async()=>{
  const cases=[
    [b=>{if(b.portfolios)b.portfolios=[];},'SCOPE'],
    [b=>{if(b.portfolios)b.portfolios.push({...b.portfolios[0],id:5});},'SCOPE'],
    [b=>{if(b.portfolios)b.portfolios[0].currency_code='HKD';},'SCOPE'],
    [b=>{if(b.report)b.report.portfolio_id=9;},'IDENTITY'],
    [b=>{if(b.report)b.report.end_date='2026-08-01';},'IDENTITY'],
    [b=>{if(b.report)b.report.complete=false;},'INCOMPLETE'],
    [b=>{if(b.report)b.report.value++;},'AMOUNT'],
    [b=>{if(b.cash_account_transactions?.length)b.cash_account_transactions[0].date_time='2026-09-01T00:00:00Z';},'DATE_ALIGNMENT'],
    [b=>{if(b.cash_account_transactions?.length)b.cash_account_transactions[0].amount='private-canary';},'AMOUNT'],
    [b=>{if(b.holdings)b.links={next:'https://other.invalid'};},'INCOMPLETE'],
  ];
  for(const[mutate,code]of cases)await assert.rejects(read(wire({mutate})),e=>{assert.equal(e.message,'IB_SOURCE_'+code);assert.doesNotMatch(e.message,/private-canary/);return true;});
  const denied=new SharesightIbManagerReader({clientId:'synthetic',clientSecret:'synthetic',fetchImpl:async()=>{throw Error('secret-canary');}});
  await assert.rejects(denied.readStable({targetDate:baseline.asOf,expectedBaselineHash:lock(),baseline}),e=>{assert.equal(ibSourceFailureCode(e),'IB_SOURCE_NETWORK');return true;});
});
test('missing cash, unbalanced ledger and ambiguous automatic cash never become profits or flows',async()=>{
  for(const mutate of [
    b=>{if(b.cash_account_transactions)b.cash_account_transactions=[];},
    b=>{if(b.cash_account_transactions?.length)b.cash_account_transactions[0].balance=40;},
    b=>{if(b.cash_account_transactions?.length)b.cash_account_transactions[0].description='AUTOMATIC SELL settlement';},
    b=>{if(b.cash_account_transactions?.length)b.cash_account_transactions[0].description='Payout from company';},
    b=>{if(b.cash_account_transactions?.length)b.cash_account_transactions[0].description='';},
    b=>{if(b.cash_account_transactions?.length)b.cash_account_transactions[0].cash_account_transaction_type.name='UNKNOWN';},
    b=>{if(b.cash_account_transactions?.length)b.cash_account_transactions[0].trade_id=99;},
    b=>{if(b.report)b.report.cash_accounts[0].currency.code='HKD';},
  ])await assert.rejects(read(wire({mutate})),/IB_SOURCE_(CASH_RECONCILIATION|UNRESOLVED_FLOW|IDENTITY|UNSUPPORTED_CURRENCY)/);
});
test('two snapshots must agree in business evidence; an unrelated field is not a change',async()=>{
  assert.deepEqual((await read(wire({changeSecond:true}))).periodReturnsInput,input());
  await assert.rejects(read(wire({mutate:(b,{capture})=>{if(capture===2&&b.cash_account_transactions?.length)b.cash_account_transactions[0].description+=' changed';}})),/UNSTABLE/);
});
test('audited native-date securities outflow is independent of cash and cannot become a mechanical loss',async()=>{
  const instrument={id:7,code:'SYNTH',market_code:'NYSE',currency_code:'USD'};
  const make=()=>wire({mutate:(b,{q})=>{
    if(b.holdings)b.holdings[0].instrument=instrument;
    if(b.report){const d=b.report.end_date,h=b.report.holdings[0];h.instrument=instrument;h.quantity=d<'2026-09-01'?2:1;h.value=d<'2026-09-01'?100:d==='2026-09-01'?50:45;b.report.cash_accounts[0].value=0;b.report.value=h.value;}
    if(b.cash_accounts){b.cash_accounts[0].balance=0;b.cash_accounts[0].balance_in_portfolio_currency=0;}
    if(b.cash_account_transactions)b.cash_account_transactions=[];
    if(b.trades)b.trades=q.get('start_date')<='2026-09-01'?[{id:8,portfolio_id:1,holding_id:2,state:'confirmed',transaction_date:'2026-09-01',description_code:'SELL',quantity:1,value:0,price:0,brokerage:0,instrument}]:[];
  }});
  const expected=input();expected.points[1].tot=50;expected.points[2].tot=45;expected.flowByDate['2026-09-01']=-50;
  const expectedBaselineHash=ibBaselineBusinessHash(expected),s=await read(make(),{expectedBaselineHash});
  assert.deepEqual(s.periodReturnsInput,expected);assert.deepEqual(s.cashFlowByDate,{});assert.equal(s.noncashProofs.length,1);
  const b=await buildIbManagerReportBundle(s,expectedBaselineHash);assert.deepEqual(b.drawdownReceipt.dailyFactors.map(p=>p.factor),[1,1,.9]);
  await assert.rejects(read(make()),/BASELINE_MISMATCH/);
  const again=await read(make(),{expectedBaselineHash,checkpoint:s});assert.deepEqual(again.noncashProofs,s.noncashProofs);assert.deepEqual(again.periodReturnsInput,s.periodReturnsInput);
  const bad=structuredClone(s);bad.noncashProofs.push(bad.noncashProofs[0]);await assert.rejects(buildIbManagerReportBundle(bad,expectedBaselineHash),/NONCASH_EVIDENCE/);
});
test('persisted checkpoint appends daily history, binds identity and detects changed prior valuation',async()=>{
  const initial=await source(),w=wire();
  const next=await read(w,{targetDate:'2026-09-03',checkpoint:initial});
  assert.equal(next.periodReturnsInput.points.length,4);assert.deepEqual(next.periodReturnsInput.points.slice(0,3),input().points);
  assert.equal(w.calls.filter(c=>c.url.includes('/performance?')).length,4);
  const repeated=await read(wire(),{targetDate:'2026-09-03',checkpoint:next});assert.deepEqual(repeated,next);
  const changed=wire({mutate:b=>{if(b.report?.end_date==='2026-09-02'){b.report.holdings[0].value++;b.report.value++;}}});
  await assert.rejects(read(changed,{targetDate:'2026-09-03',checkpoint:initial}),/PAST_POINT_CHANGED/);
  const bad=structuredClone(initial);bad.portfolioIdentityHash='b'.repeat(64);await assert.rejects(read(wire(),{targetDate:'2026-09-03',checkpoint:bad}),/IDENTITY/);
  const cap=wire();await assert.rejects(read(cap,{targetDate:'2026-09-20',checkpoint:initial}),/HISTORY_LIMIT/);assert.equal(cap.calls.length,0);
  const transfer=wire({mutate:b=>{if(b.trades)b.trades=[{id:9,portfolio_id:1,holding_id:2,state:'confirmed',transaction_date:'2026-09-03',description_code:'SELL',quantity:1,value:1,comments:'in-kind transfer'}];}});
  await assert.rejects(read(transfer,{targetDate:'2026-09-03',checkpoint:initial}),/UNVERIFIED_TRANSFER/);
  const invisible=wire({mutate:b=>{if(b.report?.end_date==='2026-09-03')b.report.holdings[0].quantity=.5;}});
  await assert.rejects(read(invisible,{targetDate:'2026-09-03',checkpoint:initial}),/UNVERIFIED_TRANSFER/);
});
test('source receipts bind TWR and daily drawdown; raw source stays only in private checkpoint',async()=>{
  const s=await source(),b=await buildIbManagerReportBundle(s,lock()),core=createIbManagerReturnConsumer(),fee={state:'verified',start:baseline.from,asOf:baseline.asOf,periods:b.returnReceipt.periods};
  const status={state:'verified',targetDate:baseline.asOf};
  assert.equal(b.returnReceipt.schema,core.dailySchema);assert.equal((await core.project(b.returnReceipt,fee,status)).value,-.1);
  assert.deepEqual(b.drawdownReceipt.dailyFactors.map(p=>p.factor),[1,1,.9]);
  assert.equal((await createIbManagerDrawdownConsumer().project(b.drawdownReceipt,b.returnReceipt,fee,status)).state,'verified');
  for(const bad of [undefined,{state:'pending'},{state:'verified',targetDate:'2026-09-03'}])assert.equal((await core.project(b.returnReceipt,fee,bad)).value,null);
  assert.doesNotMatch(JSON.stringify([b.returnReceipt,b.drawdownReceipt]),/openT|flowByDate|quantity|portfolioId|"tot"|"amount"/);
  const payload={ibManagerReturnReceipt:b.returnReceipt,ibManagerDrawdownReceipt:b.drawdownReceipt,ibManagerSourceState:b.sourceState};
  assert.deepEqual(await validateIbManagerReportState(payload,lock()),s);
  payload.ibManagerSourceState.source.periodReturnsInput.points[0].tot++;await assert.rejects(validateIbManagerReportState(payload,lock()),/STATE_INVALID/);
});
function feeData(){const i=input(),economicInput={v:4,settings:{start:i.from,mgmt:2,carry:20,fx:{USD:1}},accounts:[{id:'schwab',opening:60},{id:'webull',opening:40}],months:[],fees:[]};
  const data={daily:i.points.map(p=>({d:p.d,schwab:60,webull:40})),flowsAuto:[],flowsUnresolved:[],status:{asOf:i.to,provisional:false,calibrated:true,unresolvedCount:0}};data.feeCalculationReceipt=buildFeeCalculationReceipt({data,economicInput});return data;}
test('publication requires authenticated same-cutoff IB returns and daily drawdown visible to the real UI consumers',async()=>{
  const environ={IB_MANAGER_READ_ENABLED:'true',IB_MANAGER_BASELINE_SHA256:lock()};
  assert.throws(()=>assertIbManagerConfiguration({}),/^Error: FEE_CLOUD_IB_CONFIG$/);
  assert.throws(()=>assertIbManagerConfiguration({IB_MANAGER_READ_ENABLED:'true'}),/^Error: FEE_CLOUD_IB_BASELINE_LOCK$/);
  const b=await buildIbManagerReportBundle(await source(),lock());
  const data={...feeData(),ibManagerReturnReceipt:b.returnReceipt,ibManagerDrawdownReceipt:b.drawdownReceipt,ibManagerSourceState:b.sourceState,ibManagerSourceStatus:{state:'verified',targetDate:baseline.asOf}};
  const before=structuredClone(data);await assertIbManagerPublication(data,baseline.asOf,environ);assert.deepEqual(data,before);
  const frozen=await frozenFixture();
  await assertIbManagerPublication({...feeData(),...frozen.payload},baseline.asOf,environ);
  for(const mutate of [x=>delete x.ibManagerReturnReceipt,x=>delete x.ibManagerDrawdownReceipt,x=>delete x.ibManagerSourceState,
    x=>x.ibManagerSourceStatus.state='pending',x=>x.ibManagerSourceStatus.targetDate='2026-09-01',
    x=>x.ibManagerReturnReceipt.asOf='2026-09-01',x=>x.ibManagerReturnReceipt.periods[0].grossTwrPpm++,
    x=>x.ibManagerDrawdownReceipt.dailyFactors[1].factor=0,x=>x.ibManagerSourceState.source.sourceAsOf='2026-09-01',
    x=>x.feeCalculationReceipt.asOf='2026-09-01']){
    const bad=structuredClone(data);mutate(bad);await assert.rejects(assertIbManagerPublication(bad,baseline.asOf,environ),/^Error: FEE_CLOUD_IB_INCOMPLETE$/);
  }
  // A valid old receipt is not a fresh report, and a flag/hash cannot create evidence.
  await assert.rejects(assertIbManagerPublication(data,'2026-09-03',environ),/IB_INCOMPLETE/);
  await assert.rejects(assertIbManagerPublication(data,baseline.asOf,{...environ,IB_MANAGER_BASELINE_SHA256:'e'.repeat(64)}),/IB_INCOMPLETE/);
});
test('real producer CLI refuses missing IB activation or baseline before source IO',()=>{
  for(const env of [{},{IB_MANAGER_READ_ENABLED:'true'},{IB_MANAGER_READ_ENABLED:'true',IB_MANAGER_BASELINE_SHA256:'not-a-hash'}]){
    const result=spawnSync(process.execPath,[new URL('./fee-cloud-producer.mjs',import.meta.url).pathname],{encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH,...env}});
    assert.equal(result.status,1);assert.equal(result.stdout,'');assert.match(result.stderr,/^FEE_CLOUD_IB_(CONFIG|BASELINE_LOCK)\n$/);
  }
});

test('IB publication diagnostics preserve rejection, predicate order and payload while exposing only finite reasons',async()=>{
  const environ={IB_MANAGER_READ_ENABLED:'true',IB_MANAGER_BASELINE_SHA256:lock()},b=await buildIbManagerReportBundle(await source(),lock());
  const live={...feeData(),ibManagerReturnReceipt:b.returnReceipt,ibManagerDrawdownReceipt:b.drawdownReceipt,ibManagerSourceState:b.sourceState,ibManagerSourceStatus:{state:'verified',targetDate:baseline.asOf}};
  const frozen={...feeData(),...(await frozenFixture()).payload};
  const later=structuredClone(live),laterDate=add(baseline.asOf);
  later.daily.push({d:laterDate,schwab:60,webull:40});later.status.asOf=laterDate;
  later.feeCalculationReceipt=buildFeeCalculationReceipt({data:later,economicInput:{v:4,settings:{start:baseline.from,mgmt:2,carry:20,fx:{USD:1}},accounts:[{id:'schwab',opening:60},{id:'webull',opening:40}],months:[],fees:[]}});
  const cases=[
    [live,x=>x.feeCalculationReceipt.asOf='2026-09-01','FEE_CUTOFF','NONE','NOT_CHECKED','NOT_CHECKED'],
    [live,x=>x.feeCalculationReceipt.receiptId='e'.repeat(64),'FEE_RECEIPT','NONE','NOT_CHECKED','NOT_CHECKED'],
    [live,x=>x.ibManagerSourceState.stateId='e'.repeat(64),'SOURCE_STATE','NONE','NOT_CHECKED','NOT_CHECKED'],
    [live,x=>delete x.ibManagerSourceState,'SOURCE_CUTOFF','NONE','NOT_CHECKED','NOT_CHECKED'],
    [live,x=>x.ibManagerSourceStatus={state:'pending',targetDate:baseline.asOf,reasonCode:'IB_SOURCE_CASH_RECONCILIATION'},'RETURN_RECEIPT','IB_SOURCE_CASH_RECONCILIATION','source-unavailable','source-unavailable'],
    [live,x=>x.ibManagerSourceStatus={state:'pending',reasonCode:'IB_SOURCE_PRIVATE_CANARY account=123 amount=456.78'},'RETURN_RECEIPT','UNKNOWN','source-unavailable','source-unavailable'],
    [frozen,x=>delete x.ibManagerReturnReceipt,'RETURN_RECEIPT','NONE','missing','invalid-daily-path'],
    [frozen,x=>delete x.ibManagerDrawdownReceipt,'DRAWDOWN_RECEIPT','NONE','VERIFIED','missing-daily-path'],
    [later,x=>x.ibManagerSourceStatus={state:'pending',targetDate:laterDate,reasonCode:'IB_SOURCE_PAST_POINT_CHANGED'},'SOURCE_CUTOFF','IB_SOURCE_PAST_POINT_CHANGED','NOT_CHECKED','NOT_CHECKED',laterDate],
  ];
  for(const [base,mutate,predicate,sourceReason,returnReason,drawdownReason,target=baseline.asOf] of cases){
    const data=structuredClone(base);mutate(data);const before=structuredClone(data);let stderr='';const write=process.stderr.write;
    try{process.stderr.write=chunk=>{stderr+=String(chunk);return true;};await assert.rejects(assertIbManagerPublication(data,target,environ),{message:'FEE_CLOUD_IB_INCOMPLETE'});}
    finally{process.stderr.write=write;}
    assert.deepEqual(data,before);assert.equal(stderr.trim().split('\n').length,1);
    const expected={schema:'fee-console.ib-publication-diagnostic.v1',code:'FEE_CLOUD_IB_INCOMPLETE',predicate,sourceReason,returnReason,drawdownReason};
    assert.equal(stderr,IB_PUBLICATION_DIAGNOSTIC_PREFIX+JSON.stringify(expected)+'\n');
    assert.equal(validateIbPublicationDiagnostic(expected),true);
    assert.deepEqual(safeProducerFailureSummary(stderr+'FEE_CLOUD_IB_INCOMPLETE\n'),{code:'FEE_CLOUD_IB_INCOMPLETE',diagnostic:expected});
    for(const hidden of ['PRIVATE_CANARY','123','456.78',baseline.asOf,lock()])assert.equal(stderr.includes(hidden),false);
  }
  // Success is silent; an unavailable diagnostic sink still refuses publication.
  let stderr='';const write=process.stderr.write;
  try{
    process.stderr.write=chunk=>{stderr+=String(chunk);return true;};await assertIbManagerPublication(live,baseline.asOf,environ);assert.equal(stderr,'');
    process.stderr.write=()=>{throw Error('PRIVATE_CANARY');};
    await assert.rejects(assertIbManagerPublication({},baseline.asOf,environ),{message:'FEE_CLOUD_IB_INCOMPLETE'});
  }finally{process.stderr.write=write;}
});

test('all existing IB source failure categories survive pending handoff without exposing raw errors',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ib-diagnostic-synthetic-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const environ={IB_MANAGER_READ_ENABLED:'true',IB_MANAGER_BASELINE_SHA256:lock()},data=feeData();
  const codes=['CONFIG','BASELINE_LOCK','BASELINE_MISMATCH','SCOPE','IDENTITY','INCOMPLETE','DATE','DATE_ALIGNMENT','AMOUNT','SCHEMA','CASH_RECONCILIATION','UNRESOLVED_FLOW','UNVERIFIED_TRANSFER','NONCASH_EVIDENCE','UNSUPPORTED_CURRENCY','UNSTABLE','HISTORY_LIMIT','PAST_POINT_CHANGED','STATE','NETWORK'];
  for(const code of codes){
    let reads=0;const prep=await prepareIbManagerReport({payload:data,targetDate:baseline.asOf,outputDir:dir,environ,reader:{async readStable(){reads++;throw new IbManagerSourceError(code);}}});
    assert.equal(reads,1);const pending=(await loadIbManagerReport(prep.file,{environ})).apply(data,baseline.asOf);let stderr='';const write=process.stderr.write;
    try{process.stderr.write=chunk=>{stderr+=String(chunk);return true;};await assert.rejects(assertIbManagerPublication(pending,baseline.asOf,environ),/IB_INCOMPLETE/);}finally{process.stderr.write=write;}
    assert.equal(safeProducerFailureSummary(stderr+'FEE_CLOUD_IB_INCOMPLETE\n').diagnostic.sourceReason,'IB_SOURCE_'+code);fs.unlinkSync(prep.file);
  }
});
test('normal handoff preserves fee accounts, amounts and receipt; pending suppresses stale IB',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ib-source-synthetic-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const environ={IB_MANAGER_READ_ENABLED:'true',IB_MANAGER_BASELINE_SHA256:lock()},data=feeData(),original=structuredClone(data),s=await source();
  let calls=0;const prep=await prepareIbManagerReport({payload:data,targetDate:baseline.asOf,outputDir:dir,environ,reader:{async readStable(){calls++;return s;}}});assert.equal(calls,1);assert.equal(prep.state,'verified');
  const loaded=await loadIbManagerReport(prep.file,{environ}),out=loaded.apply(data,baseline.asOf);assert.equal(out.ibManagerSourceStatus.state,'verified');assert.deepEqual(data,original);
  const rest={...out};for(const k of ['ibManagerReturnReceipt','ibManagerDrawdownReceipt','ibManagerSourceState','ibManagerSourceStatus'])delete rest[k];assert.deepEqual(rest,data);assert.equal(validateFeeCalculationReceipt(data.feeCalculationReceipt,out).ok,true);
  assert.equal(sameIbManagerData(data,out),false);assert.equal(sameIbManagerData(out,structuredClone(out)),true);
  fs.unlinkSync(prep.file);const failed=await prepareIbManagerReport({payload:out,targetDate:baseline.asOf,outputDir:dir,environ,reader:{async readStable(){throw Error('private-account-canary');}}});assert.deepEqual({state:failed.state,code:failed.reasonCode},{state:'pending',code:'IB_SOURCE_NETWORK'});
  const pending=(await loadIbManagerReport(failed.file,{environ})).apply(out,baseline.asOf);assert.deepEqual(pending.ibManagerReturnReceipt,out.ibManagerReturnReceipt);assert.equal(pending.ibManagerSourceStatus.state,'pending');assert.equal((await createIbManagerReturnConsumer().project(pending.ibManagerReturnReceipt,{state:'verified',...pending.feeCalculationReceipt},pending.ibManagerSourceStatus)).value,null);
  fs.appendFileSync(failed.file,' ');assert.throws(loaded.checkCurrent,/REFUSED/);
});
test('disabled path performs no read or file write; missing lock does not use credentials',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ib-source-disabled-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let calls=0;
  const args={payload:feeData(),targetDate:baseline.asOf,outputDir:dir,reader:{async readStable(){calls++;throw Error();}}};
  assert.equal(await prepareIbManagerReport({...args,environ:{}}),null);assert.deepEqual(fs.readdirSync(dir),[]);
  const result=await prepareIbManagerReport({...args,environ:{IB_MANAGER_READ_ENABLED:'true'}});assert.equal(result.reasonCode,'IB_SOURCE_BASELINE_LOCK');assert.equal(calls,0);
  fs.chmodSync(result.file,0o644);await assert.rejects(loadIbManagerReport(result.file,{environ:{IB_MANAGER_READ_ENABLED:'true'}}),/REFUSED/);
});

test('real normal daily CLI encrypts independent IB only, preserves fees and repeats as byte no-op',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ib-daily-synthetic-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const key=crypto.randomBytes(32),target='2026-10-23',file=path.join(dir,'data.json'),econFile=path.join(dir,'econ.json'),clock=path.join(dir,'clock.mjs');
  // Freeze only the synthetic CLI child at the last instant within its real 10-day window.
  const withinWindow='2026-11-03T04:59:59.999Z',outsideWindow='2026-11-03T05:00:00.000Z';
  assert.equal(nyDate(new Date(withinWindow)),'2026-11-02');assert.equal(nyDate(new Date(outsideWindow)),'2026-11-03');
  fs.writeFileSync(clock,`const RealDate=Date,now=RealDate.parse(process.env.TEST_NOW);globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};`,{mode:0o600});
  const encrypt=(data,v=3)=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);return JSON.stringify({enc:true,v,data:Buffer.concat([iv,c.update(JSON.stringify(data)),c.final(),c.getAuthTag()]).toString('base64')});};
  const decrypt=()=>{const b=Buffer.from(JSON.parse(fs.readFileSync(file)).data,'base64'),d=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(-16));return JSON.parse(Buffer.concat([d.update(b.subarray(12,-16)),d.final()]));};
  const data=feeData();for(let d=add(baseline.asOf);d<=target;d=add(d))data.daily.push({d,schwab:60,webull:40});data.status={asOf:target,provisional:false,calibrated:true,unresolvedCount:0,splitDelta:0,notes:[]};
  fs.writeFileSync(file,encrypt(data));fs.writeFileSync(econFile,encrypt({v:4,settings:{start:baseline.from,mgmt:2,carry:20,fx:{USD:1}},accounts:[{id:'schwab',opening:60},{id:'webull',opening:40}],months:[],fees:[]},4),{mode:0o600});
  const environ={...process.env,TEST_NOW:withinWindow,FEE_DATA_KEY:key.toString('base64url'),FEE_ECON_FILE:econFile,FEE_STYLE_INPUT_FILE:'',FEE_MANAGEMENT_INPUT_FILE:'',IB_MANAGER_READ_ENABLED:'true',IB_MANAGER_BASELINE_SHA256:lock()};
  const cli=['--import',clock,new URL('./daily.mjs',import.meta.url).pathname,`--file=${file}`,`--date=${target}`,'--schwab=60','--webull=40',`--src-schwab=${target}`,`--src-webull=${target}`,'--cash=0','--stock=100','--other=0'];
  const run=extra=>spawnSync(process.execPath,[...cli,...extra],{encoding:'utf8',env:environ});
  const ordinary=run([]);assert.equal(ordinary.status,0,ordinary.stderr);const before=decrypt();
  const s=await source();for(let d=add(baseline.asOf);d<=target;d=add(d))s.periodReturnsInput.points.push({d,tot:135});s.periodReturnsInput.to=target;s.sourceAsOf=target;s.periodReturnsInput.days=s.periodReturnsInput.points.length;
  const prepared=await prepareIbManagerReport({payload:before,targetDate:target,outputDir:dir,environ,reader:{async readStable(){return s;}}});
  const result=run([`--ib-manager-input=${prepared.file}`]);assert.equal(result.status,0,result.stderr);const out=decrypt();assert.equal(out.ibManagerSourceStatus.state,'verified');assert.deepEqual(out.feeCalculationReceipt,before.feeCalculationReceipt);
  const strip=o=>Object.fromEntries(Object.entries(o).filter(([k])=>!k.startsWith('ibManager')&&k!=='updatedAt'));assert.deepEqual(strip(out),strip(before));
  const bytes=fs.readFileSync(file),repeat=run([`--ib-manager-input=${prepared.file}`]);assert.equal(repeat.status,0,repeat.stderr);assert.match(repeat.stdout,/no-op/);assert.deepEqual(fs.readFileSync(file),bytes);
  const expired=spawnSync(process.execPath,[...cli,`--ib-manager-input=${prepared.file}`],{encoding:'utf8',env:{...environ,TEST_NOW:outsideWindow}});
  assert.equal(expired.status,1);assert.match(expired.stderr,/11 days behind the New York date 2026-11-03; the calibration window is 10 days/);assert.deepEqual(fs.readFileSync(file),bytes);
  const refused=spawnSync(process.execPath,[...cli,`--ib-manager-input=${prepared.file}`],{encoding:'utf8',env:{...environ,IB_MANAGER_READ_ENABLED:''}});assert.notEqual(refused.status,0);assert.deepEqual(fs.readFileSync(file),bytes);
  fs.unlinkSync(prepared.file);const pending=await prepareIbManagerReport({payload:out,targetDate:target,outputDir:dir,environ,reader:{async readStable(){throw Error('private-canary');}}});
  const p=run([`--ib-manager-input=${pending.file}`]);assert.equal(p.status,0,p.stderr);const after=decrypt();assert.equal(after.ibManagerSourceStatus.state,'pending');assert.deepEqual(after.feeCalculationReceipt,before.feeCalculationReceipt);assert.deepEqual(after.ibManagerReturnReceipt,out.ibManagerReturnReceipt);
});

test('normal producer validates IB and carries a failed handoff through the actual safe workflow summary',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ib-producer-synthetic-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const root=path.join(dir,'checkout');fs.mkdirSync(root,{mode:0o700});fs.cpSync(new URL('.',import.meta.url),path.join(root,'scripts'),{recursive:true});
  fs.mkdirSync(path.join(root,'claude'));fs.copyFileSync(new URL('../claude/fee-style-mapping.json',import.meta.url),path.join(root,'claude/fee-style-mapping.json'));
  const target='2026-10-23',key=crypto.randomBytes(32),clock=path.join(dir,'clock.mjs');
  // The synthetic producer and each writer/reporter/health child share the fixture clock.
  fs.writeFileSync(clock,`const RealDate=Date,now=RealDate.parse('2026-10-24T06:00:00Z');globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};globalThis.fetch=async()=>{process.exitCode=97;throw Error('UNMOCKED_FETCH_FORBIDDEN');};`,{mode:0o600});
  const encrypt=(o,v)=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);return JSON.stringify({enc:true,v,data:Buffer.concat([iv,c.update(JSON.stringify(o)),c.final(),c.getAuthTag()]).toString('base64')});};
  const data=feeData();for(let d=add(baseline.asOf);d<=target;d=add(d))data.daily.push({d,schwab:60,webull:40});
  Object.assign(data.status,{asOf:target,notes:[],splitDelta:0});for(const p of data.daily)Object.assign(p,{cash:100,stock:0,other:0,spy:100,qqq:100,acctCash:{schwab:60,webull:40}});
  const original=encrypt(data,3);fs.writeFileSync(path.join(root,'data.json'),original);
  const econ=path.join(dir,'econ.json');fs.writeFileSync(econ,encrypt({v:4,settings:{start:baseline.from,mgmt:2,carry:20,fx:{USD:1}},accounts:[{id:'schwab',opening:60},{id:'webull',opening:40}],months:[],fees:[]},4),{mode:0o600});
  const cache=path.join(dir,'benchmark.json');fs.writeFileSync(cache,JSON.stringify({v:1,benchmarks:{spy: {symbol:'SPY',currency:'USD',exchange:'NYSEArca',series:[{d:target,p:100}]},qqq: {symbol:'QQQ',currency:'USD',exchange:'NasdaqGS',series:[{d:target,p:100}]}}}));
  const s=await source();for(let d=add(baseline.asOf);d<=target;d=add(d))s.periodReturnsInput.points.push({d,tot:135});s.sourceAsOf=target;s.periodReturnsInput.to=target;s.periodReturnsInput.days=s.periodReturnsInput.points.length;
  const ibFile=path.join(dir,'synthetic-source.json');fs.writeFileSync(ibFile,JSON.stringify(s),{mode:0o600});
  const script=path.join(root,'exercise.mjs');fs.writeFileSync(script,`
    import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import assert from 'node:assert/strict';
    import {produce,producerFailureCode} from './scripts/fee-cloud-producer.mjs';import {STYLE_ACCOUNTS} from './scripts/fee-style-registry.mjs';import {IbManagerSourceError} from './scripts/ib-manager-source.mjs';
    const source=JSON.parse(fs.readFileSync(process.env.SYNTHETIC_IB_FILE)),target=source.sourceAsOf,dir=path.dirname(process.env.SYNTHETIC_IB_FILE),key=Buffer.from(process.env.FEE_DATA_KEY,'base64url');
    const decode=file=>{const b=Buffer.from(JSON.parse(fs.readFileSync(file)).data,'base64'),d=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(-16));return JSON.parse(Buffer.concat([d.update(b.subarray(12,-16)),d.final()]));};
    let ibReads=0,feeReads=0,cleanups=0;const results=[],checkedAt=new Date().toISOString();
    for(const mode of ['disabled','enabled','failed']){
      const enabled=mode!=='disabled';process.env.IB_MANAGER_READ_ENABLED=enabled?'true':'';const output=path.join(dir,mode);fs.mkdirSync(output,{mode:0o700});
      const options={requireIb:enabled,cli:{'benchmark-file':process.env.SYNTHETIC_CACHE,'target-date':target,'out-dir':output,'checked-at':checkedAt},
        fetchEconomic:async()=>({envelopeVersion:4,sourcePath:process.env.FEE_ECON_FILE,async checkCurrent(){},cleanup(){cleanups++;}}),
        ibReader:{async readStable(){ibReads++;if(mode==='failed')throw new IbManagerSourceError('CASH_RECONCILIATION');return structuredClone(source);}},
        reader:{async readStable(_target,benchmark){feeReads++;return {targetDate:target,accounts:{schwab:60,webull:40},splits:{cash:100,stock:0,other:0},acctCash:{schwab:60,webull:40},prevAcctCash:{schwab:60,webull:40},sourceDates:{schwab:target,webull:target},benchmark:{...benchmark,sourceDate:target,state:'session'},sourceFingerprint:'a'.repeat(64),flows:[],styleInput:{schemaVersion:1,date:target,portfolios:Object.entries(STYLE_ACCOUNTS).map(([account,portfolioId])=>({account,portfolioId,sourceDate:target,stockTotalUsd:0,holdings:[]})),proposals:[]}};}}};
      if(mode==='failed'){
        await assert.rejects(produce(options),error=>{assert.equal(error.message,'FEE_CLOUD_IB_INCOMPLETE');console.error(producerFailureCode(error,'UNKNOWN'));return true;});
        assert.equal(fs.existsSync(path.join(output,'ib-manager-input.json')),false);assert.equal(fs.existsSync(path.join(output,'fee-data-health.json')),false);continue;
      }
      const result=await produce(options);
      results.push(decode(result.dataFile));assert.equal(fs.existsSync(path.join(output,'ib-manager-input.json')),false);assert.equal(fs.existsSync(result.healthFile),true);
    }
    assert.equal(ibReads,2);assert.equal(feeReads,3);assert.equal(cleanups,3);assert.equal(results[1].ibManagerSourceStatus.state,'verified');assert.deepEqual(results[1].feeCalculationReceipt,results[0].feeCalculationReceipt);
    const strip=o=>Object.fromEntries(Object.entries(o).filter(([k])=>!k.startsWith('ibManager')&&k!=='updatedAt'));assert.deepEqual(strip(results[0]),strip(results[1]));
    console.log('SYNTHETIC_NORMAL_PRODUCER_VERIFIED');
  `);
  const result=spawnSync(process.execPath,[script],{encoding:'utf8',env:{...process.env,NODE_OPTIONS:[process.env.NODE_OPTIONS||'','--import='+clock].join(' ').trim(),FEE_DATA_KEY:key.toString('base64url'),FEE_ECON_FILE:econ,FEE_STYLE_INPUT_FILE:'',FEE_MANAGEMENT_INPUT_FILE:'',IB_MANAGER_READ_ENABLED:'',IB_MANAGER_BASELINE_SHA256:lock(),SYNTHETIC_IB_FILE:ibFile,SYNTHETIC_CACHE:cache},timeout:20000});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/SYNTHETIC_NORMAL_PRODUCER_VERIFIED/);assert.equal(fs.readFileSync(path.join(root,'data.json'),'utf8'),original);
  assert.equal(result.stderr.trim().split('\n').length,2);const projection=safeProducerFailureSummary(result.stderr);
  assert.deepEqual(projection,{code:'FEE_CLOUD_IB_INCOMPLETE',diagnostic:{schema:'fee-console.ib-publication-diagnostic.v1',code:'FEE_CLOUD_IB_INCOMPLETE',predicate:'RETURN_RECEIPT',sourceReason:'IB_SOURCE_CASH_RECONCILIATION',returnReason:'source-unavailable',drawdownReason:'missing-daily-path'}});
  const workflow=fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml',import.meta.url),'utf8');
  const failureScript=workflow.match(/node --input-type=module - \"\$error_file\" <<'NODE'\n([\s\S]+?)\n          NODE/)[1];
  const errorFile=path.join(dir,'private.stderr'),summary=path.join(dir,'safe-summary.md');fs.writeFileSync(errorFile,'PRIVATE_CANARY amount=123456.78 /private/path\n'+result.stderr,{mode:0o600});fs.writeFileSync(summary,'',{mode:0o600});
  const published=spawnSync(process.execPath,['--input-type=module','-',errorFile],{cwd:new URL('..',import.meta.url),input:failureScript,encoding:'utf8',env:{PATH:process.env.PATH,GITHUB_STEP_SUMMARY:summary}});
  assert.equal(published.status,0,published.stderr);assert.equal(published.stderr,'');
  const safeText=published.stdout+fs.readFileSync(summary,'utf8');assert.match(safeText,/IB_SOURCE_CASH_RECONCILIATION/);assert.match(safeText,/RETURN_RECEIPT/);
  for(const hidden of ['PRIVATE_CANARY','123456.78','/private/path',key.toString('base64url')])assert.equal(safeText.includes(hidden),false);
  assert.equal(published.stdout.trim().split('\n').at(-1),'FEE_CLOUD_IB_INCOMPLETE');
});

// A reported in-transit migration cannot be proved complete by two identical
// stale snapshots. This independent hold must never fail the fee composite.
test('post-baseline coverage hold performs no IB read and preserves original fee report',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ib-coverage-synthetic-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let calls=0;const environ={IB_MANAGER_READ_ENABLED:'true',IB_MANAGER_BASELINE_SHA256:lock()},data=feeData(),before=structuredClone(data);
  const request=await prepareIbManagerReport({payload:data,targetDate:'2026-10-26',outputDir:dir,environ,reader:{async readStable(){calls++;throw Error('must not read');}}});
  assert.equal(calls,0);assert.equal(request.reasonCode,'IB_SOURCE_COVERAGE_UNVERIFIED');
  const result=(await loadIbManagerReport(request.file,{environ})).apply(data,'2026-10-26');
  assert.deepEqual(result.feeCalculationReceipt,data.feeCalculationReceipt);assert.deepEqual(data,before);assert.equal(result.ibManagerSourceStatus.state,'pending');
});

test('source-native checkpoint extends beyond its one-time bootstrap audit without reusing an old period',async()=>{
  const {state}=await frozenFixture(),body={schema:'fee-console.ib-manager-coverage.v2',authority:'reviewed-source-reconciliation',sourceProvider:'Sharesight',baselineInputsHash:lock(),from:'2026-09-03',through:'2026-09-03',evidenceSha256:'e'.repeat(64),events:[],quotes:[]},coverage={...body,coverageId:await createIbManagerReturnConsumer().digest(body)};
  validateIbBootstrapCoverage(coverage,lock(),{baselineAsOf:baseline.asOf});
  const first=await read(wire(),{targetDate:'2026-09-03',ownerBaseline:state,bootstrapCoverage:coverage});assert.equal(first.schema,'fee-console.ib-manager-source.v3');assert.equal(first.closingSnapshots.length,2);
  const next=await read(wire(),{targetDate:'2026-09-04',checkpoint:first});assert.equal(next.sourceAsOf,'2026-09-04');assert.deepEqual(next.bootstrapCoverage,coverage);assert.equal(next.periodReturnsInput.to,'2026-09-04');await buildIbManagerReportBundle(next,lock());
  const moved=wire({mutate:(b,{q})=>{if(b.report)b.report.holdings[0].quantity=2;}});
  await assert.rejects(read(moved,{targetDate:'2026-09-04',checkpoint:first}),/PAST_POINT_CHANGED/);
  for(const mutate of [x=>x.sourceProvider='Broker',x=>x.through='2026-09-12',x=>x.coverageId='a'.repeat(64),x=>x.from='2026-09-02',x=>x.quotes=[{}]]){const bad=structuredClone(coverage);mutate(bad);assert.throws(()=>validateIbBootstrapCoverage(bad,lock(),{baselineAsOf:baseline.asOf}));}
  const bad=structuredClone(first);bad.closingSnapshots[0].totalCents++;assert.throws(()=>validateIbManagerReportInput(bad,lock()),/STATE/);
  const skipped=wire();await assert.rejects(read(skipped,{targetDate:'2026-09-04',ownerBaseline:state,bootstrapCoverage:coverage}),/STATE/);assert.equal(skipped.calls.length,0);
});

import {attachIbBootstrap} from './fee-ratio-packet.mjs';

test('existing encrypted carrier seeds confirmed IB history and finite source audit without changing returns or fee fields',async()=>{
  const {frozen,payload}=await frozenFixture(),before={...payload,feeCalculationReceipt:{synthetic:'unchanged'},other:{synthetic:'unchanged'}},body={schema:'fee-console.ib-manager-coverage.v2',authority:'reviewed-source-reconciliation',sourceProvider:'Sharesight',baselineInputsHash:lock(),from:'2026-09-03',through:'2026-09-03',evidenceSha256:'e'.repeat(64),events:[],quotes:[]},coverage={...body,coverageId:await createIbManagerReturnConsumer().digest(body)};
  const after=await attachIbBootstrap(before,frozen,coverage),{ibManagerBaselineState,ibManagerCoverageState,...rest}=after;assert.deepEqual(rest,before);assert.equal(ibManagerBaselineState.authority,'owner-confirmed-frozen');assert.deepEqual(ibManagerCoverageState,coverage);
  await assert.rejects(attachIbBootstrap(after,frozen,coverage));const edited=structuredClone(frozen);edited.periodReturnsInput.points[0].tot++;await assert.rejects(attachIbBootstrap(before,edited,coverage));await assert.rejects(attachIbBootstrap(before,frozen,{...coverage,sourceProvider:'Broker'}));
});

function cadWire(extra=()=>{}){return wire({mutate(body,context){const {p,q}=context,d=q.get('end_date')||q.get('date');if(body.report){const value=d<'2026-09-02'?10:11;body.report.cash_accounts.push({id:5,value,currency:{code:'CAD'},portfolio:{id:1,name:'IB-HK'}});body.report.value+=value;}if(p==='/api/v2/portfolios/1/cash_accounts.json'){body.cash_accounts[0].balance=body.cash_accounts[0].balance_in_portfolio_currency=d<'2026-09-01'?0:50;body.cash_accounts.push({id:5,portfolio_id:1,portfolio_currency:'USD',currency:'CAD',date:d,balance:200,balance_in_portfolio_currency:d<'2026-09-02'?10:11});}extra(body,context);}});}
const cadBusiness=()=>({points:[{d:'2026-08-31',tot:110},{d:'2026-09-01',tot:160},{d:'2026-09-02',tot:146}],openT:110,from:baseline.from,to:baseline.asOf,days:3,flowByDate:{'2026-09-01':50},rate:0,cr:0,cumBefore:0,hwmBefore:0});
test('unchanged CAD native cash uses dated USD valuations, treats only its FX repricing as NAV return and never creates an external CAD flow',async()=>{const w=cadWire(),expected=ibBaselineBusinessHash(cadBusiness()),s=await w.reader.readStable({targetDate:baseline.asOf,baseline,expectedBaselineHash:expected});assert.deepEqual(s.periodReturnsInput,cadBusiness());assert.deepEqual(s.cashFlowByDate,{'2026-09-01':50});assert.ok(w.calls.some(c=>c.url.includes('cash_accounts.json?date=2026-08-30')));assert.ok((await buildIbManagerReportBundle(s,expected)).returnReceipt);});
test('CAD native movement, missing dated balance, wrong FX valuation and changed currency cannot be silently converted or ignored',async()=>{const expected=ibBaselineBusinessHash(cadBusiness());for(const change of [(b,{p,q})=>{if(b.cash_accounts&&p.includes('/portfolios/')&&q.get('date')==='2026-09-01')b.cash_accounts.find(c=>c.id===5).balance=201;},(b,{p})=>{if(p==='/api/v2/cash_accounts/5/cash_account_transactions.json')b.cash_account_transactions.push({id:80,cash_account_id:5,date_time:'2026-09-01T12:00:00Z',amount:1,balance:201,cash_account_transaction_type:{name:'DEPOSIT'}});},(b,{p})=>{if(b.cash_accounts&&p.includes('/portfolios/'))b.cash_accounts.find(c=>c.id===5).balance_in_portfolio_currency=99;},(b,{p})=>{if(b.cash_accounts&&p.includes('/portfolios/'))b.cash_accounts.find(c=>c.id===5).currency='EUR';}])await assert.rejects(cadWire(change).reader.readStable({targetDate:baseline.asOf,baseline,expectedBaselineHash:expected}),/IB_SOURCE_(UNSUPPORTED_CURRENCY|CASH_RECONCILIATION)/);});
test('CAD native balances are carried and revalidated in an authenticated future checkpoint without changing the frozen baseline',async()=>{const business=cadBusiness(),expected=ibBaselineBusinessHash(business),frozen={schema:'fee-console.ib-manager-return-input.v1',currency:'USD',timezone:'America/New_York',flowTiming:'eod',flowsComplete:true,correctionsConfirmed:true,sourceSha256:'f'.repeat(64),periodReturnsInput:business};const payload={ibManagerReturnReceipt:await buildIbManagerReturnReceipt(frozen),ibManagerDrawdownReceipt:await buildIbManagerDrawdownReceipt(frozen)};const owner=await buildIbOwnerBaseline(payload,frozen,expected),body={schema:'fee-console.ib-manager-coverage.v2',authority:'reviewed-source-reconciliation',sourceProvider:'Sharesight',baselineInputsHash:expected,from:'2026-09-03',through:'2026-09-03',evidenceSha256:'e'.repeat(64),events:[],quotes:[]},coverage={...body,coverageId:await createIbManagerReturnConsumer().digest(body)};const first=await cadWire().reader.readStable({targetDate:'2026-09-03',baseline,expectedBaselineHash:expected,ownerBaseline:owner,bootstrapCoverage:coverage});assert.equal(first.closingSnapshots[0].nativeCash[5],20000);assert.equal(first.closingSnapshots[1].cashCurrency[5],'CAD');const second=await cadWire().reader.readStable({targetDate:'2026-09-04',baseline,expectedBaselineHash:expected,checkpoint:first});assert.equal(second.closingSnapshots[0].nativeCash[5],20000);assert.deepEqual(second.periodReturnsInput.points.slice(0,3),business.points);const bad=structuredClone(first);bad.closingSnapshots[0].nativeCash[5]++;await assert.rejects(cadWire().reader.readStable({targetDate:'2026-09-04',baseline,expectedBaselineHash:expected,checkpoint:bad}),/IB_SOURCE_(STATE|PAST_POINT_CHANGED)/);});

async function nativeMidnightFixture(d='2026-11-02',kind='BUY',change=()=>{}){
  const prev=new Date(Date.parse(d+'T00:00:00Z')-86400000).toISOString().slice(0,10),base={from:prev,asOf:prev};
  const business={points:[{d:prev,tot:136}],openT:136,from:prev,to:prev,days:1,flowByDate:{},rate:0,cr:0,cumBefore:0,hwmBefore:0};
  const expected=ibBaselineBusinessHash(business),frozen={schema:'fee-console.ib-manager-return-input.v1',currency:'USD',timezone:'America/New_York',flowTiming:'eod',flowsComplete:true,correctionsConfirmed:true,sourceSha256:'c'.repeat(64),periodReturnsInput:business};
  const owner=await buildIbOwnerBaseline({ibManagerReturnReceipt:await buildIbManagerReturnReceipt(frozen),ibManagerDrawdownReceipt:await buildIbManagerDrawdownReceipt(frozen)},frozen,expected),buy=kind==='BUY',movement=buy?-10:10;
  const w=wire({mutate:(b,c)=>{
    if(b.report){const current=b.report.end_date===d;b.report.value=136;b.report.holdings[0].value=86-(current?movement:0);b.report.holdings[0].quantity=2+(current?(buy?1:-1):0);b.report.cash_accounts[0].value=50+(current?movement:0);}
    if(b.cash_accounts)for(const a of b.cash_accounts)a.balance=a.balance_in_portfolio_currency=50+movement;
    if(b.trades)b.trades=[{id:8,portfolio_id:1,holding_id:2,state:'confirmed',transaction_date:d,description_code:kind,value:-movement,quantity:1,instrument:{currency_code:'USD'}}];
    if(b.cash_account_transactions)b.cash_account_transactions=[{id:9,cash_account_id:3,date_time:d+'T00:00:00.000Z',amount:movement,balance:50+movement,trade_id:8,holding_id:2,cash_account_transaction_type:{name:buy?'Buy Trade':'Sell Trade'}}];
    change(b,c);
  }});
  return w.reader.readStable({targetDate:d,expectedBaselineHash:expected,baseline:base,ownerBaseline:owner});
}
test('native UTC-midnight BUY/SELL cash carries independently proved trade date in summer and winter',async()=>{
  for(const d of ['2026-09-03','2026-11-02'])for(const kind of ['BUY','SELL']){
    const s=await nativeMidnightFixture(d,kind);assert.equal(s.sourceAsOf,d);assert.deepEqual(s.cashFlowByDate,{});assert.equal(s.periodReturnsInput.points.at(-1).tot,136);
  }
});
test('midnight exception requires exact carrier, trade identity, type and direction without weakening ledger checks',async()=>{
  for(const change of [r=>delete r.trade_id,r=>r.trade_id=88,r=>r.holding_id=99,r=>r.payout_id=1,r=>r.cash_account_transaction_type.name='DEPOSIT',r=>r.amount=10,r=>r.date_time='2026-11-01T00:00:00.000Z',r=>r.date_time='2026-11-02T00:00:00.001Z',r=>r.date_time='2026-11-02T00:00:00Z',r=>r.date_time='2026-11-02T00:00:00.000+00:00']){
    await assert.rejects(nativeMidnightFixture('2026-11-02','BUY',b=>{if(b.cash_account_transactions)change(b.cash_account_transactions[0]);}),/DATE_ALIGNMENT/);
  }
  for(const change of [rows=>rows.push({...rows[0]}),rows=>rows.length=0,rows=>rows[0].amount=-9,rows=>rows[0].balance=41])await assert.rejects(nativeMidnightFixture('2026-11-02','BUY',b=>{if(b.cash_account_transactions)change(b.cash_account_transactions);}),/IDENTITY|UNVERIFIED_TRANSFER|CASH_RECONCILIATION/);
});

// Synthetic income amounts and IDs, retaining only native type/date shapes.
// Payout date authority comes from its independently fetched confirmed record.
async function incomeFixture({date='2026-11-04',dividend=true,interest=true,checkpoint=null,target=date,baseDate=null,change=()=>{}}={}){
  const prev=baseDate||new Date(Date.parse(date+'T00:00:00Z')-86400000).toISOString().slice(0,10),base={from:prev,asOf:prev};
  const business={points:[{d:prev,tot:136}],openT:136,from:prev,to:prev,days:1,flowByDate:{},rate:0,cr:0,cumBefore:0,hwmBefore:0};
  const expected=ibBaselineBusinessHash(business),frozen={schema:'fee-console.ib-manager-return-input.v1',currency:'USD',timezone:'America/New_York',flowTiming:'eod',flowsComplete:true,correctionsConfirmed:true,sourceSha256:'c'.repeat(64),periodReturnsInput:business};
  const owner=await buildIbOwnerBaseline({ibManagerReturnReceipt:await buildIbManagerReturnReceipt(frozen),ibManagerDrawdownReceipt:await buildIbManagerDrawdownReceipt(frozen)},frozen,expected);
  const coverageBody={schema:'fee-console.ib-manager-coverage.v2',authority:'reviewed-source-reconciliation',sourceProvider:'Sharesight',baselineInputsHash:expected,from:add(prev),through:target,evidenceSha256:'e'.repeat(64),events:[],quotes:[]};
  const coverage={...coverageBody,coverageId:await createIbManagerReturnConsumer().digest(coverageBody)},gain=(dividend?7:0)+(interest?3:0),captured=[];
  const w=wire({mutate:(b,c)=>{
    const d=c.q.get('end_date')||c.q.get('date');
    if(b.report){b.report.value=136+(d>=date?gain:0);b.report.holdings[0].value=86;b.report.cash_accounts[0].value=50+(d>=date?gain:0);}
    if(b.cash_accounts)for(const a of b.cash_accounts)a.balance=a.balance_in_portfolio_currency=50+(d>=date?gain:0);
    if(b.cash_account_transactions){
      const active=c.q.get('from')<=date&&c.q.get('to')>=date;
      b.cash_account_transactions=active?[
        ...(interest?[{id:11,cash_account_id:3,date_time:date+'T12:00:00.000Z',amount:3,balance:50+gain,cash_account_transaction_type:{name:'INTEREST_PAYMENT'},description:'Synthetic net interest; NOT external capital',trade_id:null,holding_id:null,payout_id:null}]:[]),
        ...(dividend?[{id:12,cash_account_id:3,date_time:date+'T00:00:00.000Z',amount:7,balance:57,cash_account_transaction_type:{name:'Payout'},description:'Synthetic native income',trade_id:null,holding_id:2,payout_id:13,links:{portfolio:'https://api.sharesight.com/api/v2/portfolios/1'}}]:[])
      ]:[];
    }
    if(c.p==='/api/v2/payouts/13.json')Object.assign(b,{id:13,portfolio_id:1,holding_id:2,symbol:'SYNTH',paid_on:date,currency:'USD',confirmed:true,state:'confirmed',non_taxable:false,tax_credit:0,gross_amount:10,resident_withholding_tax:3,amount:7});
    change(b,c);captured.push({path:c.p,body:structuredClone(b)});
  }});
  const args={targetDate:target,expectedBaselineHash:expected,baseline:base,...(checkpoint?{checkpoint}:{ownerBaseline:owner,bootstrapCoverage:coverage})};
  return {w,args,expected,owner,captured,run:()=>w.reader.readStable(args)};
}

test('native interest payment is income, never external capital, with no payout lookup',async()=>{
  const f=await incomeFixture({dividend:false}),s=await f.run();
  assert.deepEqual(s.cashFlowByDate,{});assert.deepEqual(s.periodReturnsInput.flowByDate,{});
  assert.deepEqual(s.periodReturnsInput.points.map(p=>p.tot),[136,139]);
  assert.equal(f.w.calls.some(c=>c.url.includes('/payouts/')),false);
  assert.deepEqual(s.ownerBaseline,f.owner);await buildIbManagerReportBundle(s,f.expected);
});
test('interest alias does not admit negative income, unknown types, vague deposits or malformed money',async t=>{
  for(const [name,mutate,reason] of [
    ['negative payment',r=>r.amount=-3,/UNRESOLVED_FLOW/],
    ['unknown type',r=>r.cash_account_transaction_type.name='INTEREST_PAYMENT_UNKNOWN',/UNRESOLVED_FLOW/],
    ['whitespace type',r=>r.cash_account_transaction_type.name=' INTEREST_PAYMENT ',/UNRESOLVED_FLOW/],
    ['generic deposit',r=>r.cash_account_transaction_type.name='DEPOSIT',/UNRESOLVED_FLOW/],
    ['subcent amount',r=>r.amount=3.001,/AMOUNT/],
    ['missing trade',r=>r.trade_id=999,/IDENTITY/],
    ['wrong account',r=>r.cash_account_id=99,/IDENTITY/]
  ])await t.test(name,async()=>{const f=await incomeFixture({dividend:false,change:b=>{if(b.cash_account_transactions)mutate(b.cash_account_transactions[0]);}});await assert.rejects(f.run(),reason);});
});
test('confirmed native payout proves its literal business date across DST; income reconciles without altering source rows',async()=>{
  for(const date of ['2026-09-03','2026-11-04']){
    const f=await incomeFixture({date}),s=await f.run();
    assert.deepEqual(s.periodReturnsInput.points.map(p=>p.tot),[136,146]);assert.deepEqual(s.cashFlowByDate,{});
    assert.equal(s.cashDateNormalizations,undefined);assert.deepEqual(s.ownerBaseline,f.owner);
    assert.deepEqual(s.closingSnapshots.map(p=>p.cash[3]),[5000,6000]);
    assert.equal(f.w.calls.filter(c=>c.url.endsWith('/payouts/13.json')).length,2);
    assert.equal(f.w.calls.filter(c=>c.method==='POST').length,2);
    for(const {body:b} of f.captured)if(b.cash_account_transactions?.length){assert.equal(b.cash_account_transactions[1].date_time,date+'T00:00:00.000Z');assert.equal(b.cash_account_transactions[1].amount,7);}
    const bundle=await buildIbManagerReportBundle(s,f.expected);assert.equal(bundle.returnReceipt.asOf,date);assert.equal(bundle.drawdownReceipt.asOf,date);
  }
});
test('payout proof rejects absent, pending, cross-account, wrong-date, wrong-currency and unequal cash evidence',async t=>{
  for(const [name,mutate] of [
    ['missing payout',p=>{for(const k of Object.keys(p))delete p[k];}],
    ['wrong payout',p=>p.id=14],['wrong portfolio',p=>p.portfolio_id=99],['wrong holding',p=>p.holding_id=99],
    ['pending',p=>p.state='pending'],['unconfirmed',p=>p.confirmed=false],['missing confirmation',p=>delete p.confirmed],
    ['previous day',p=>p.paid_on='2026-11-03'],['next day',p=>p.paid_on='2026-11-05'],['invalid date',p=>p.paid_on='2026-02-30'],
    ['other currency',p=>p.currency='CAD'],['tax credit',p=>p.tax_credit=1],['unsupported tax mode',p=>p.non_taxable=true],
    ['net mismatch',p=>p.amount=6],['gross mismatch',p=>p.gross_amount=11],['tax mismatch',p=>p.resident_withholding_tax=4],
    ['negative tax',p=>p.resident_withholding_tax=-3],['subcent net',p=>p.amount=7.001],
    ['truncated',p=>p.truncated=true],['paged',p=>p.links={next:'https://example.invalid'}]
  ])await t.test(name,async()=>{const f=await incomeFixture({change:(b,{p})=>{if(p.includes('/payouts/'))mutate(b);}});await assert.rejects(f.run(),/IB_SOURCE_(DATE_ALIGNMENT|AMOUNT|INCOMPLETE)/);});
});
test('payout date exception cannot be granted by a memo, another link or a near-midnight timestamp',async t=>{
  for(const [name,mutate] of [
    ['no payout',r=>r.payout_id=null],['no holding',r=>r.holding_id=null],['unknown holding',r=>r.holding_id=99],
    ['trade pointer',r=>r.trade_id=8],['generic deposit',r=>r.cash_account_transaction_type.name='DEPOSIT'],
    ['negative cash',r=>r.amount=-7],['zero cash',r=>r.amount=0],['wrong cash account',r=>r.cash_account_id=99],
    ['millisecond shift',r=>r.date_time='2026-11-04T00:00:00.001Z'],['missing millis',r=>r.date_time='2026-11-04T00:00:00Z'],
    ['offset spelling',r=>r.date_time='2026-11-04T00:00:00.000+00:00'],['out of window',r=>r.date_time='2026-11-03T00:00:00.000Z']
  ])await t.test(name,async()=>{
    const f=await incomeFixture({change:b=>{if(b.cash_account_transactions)mutate(b.cash_account_transactions[1]);}});
    await assert.rejects(f.run(),/DATE_ALIGNMENT/);assert.equal(f.w.calls.some(c=>c.url.includes('/payouts/')),false);
  });
  const wrongPortfolio=await incomeFixture({change:b=>{if(b.cash_account_transactions)b.cash_account_transactions[1].links.portfolio='https://api.sharesight.com/api/v2/portfolios/99';}});
  await assert.rejects(wrongPortfolio.run(),/IDENTITY/);assert.equal(wrongPortfolio.w.calls.some(c=>c.url.includes('/payouts/')),false);
});
test('native income retains duplicate guards and complete cash balance chain',async t=>{
  for(const [name,mutate,reason] of [
    ['duplicate record',rows=>rows.push({...rows[1]}),/IDENTITY/],
    ['second midnight payout',rows=>rows.push({...rows[1],id:14}),/IDENTITY/],
    ['second timed credit',rows=>rows.push({...rows[1],id:14,date_time:'2026-11-04T12:00:00.000Z'}),/IDENTITY/],
    ['earlier timed credit',rows=>rows.unshift({...rows[1],id:14,date_time:'2026-11-04T12:00:00.000Z'}),/IDENTITY/],
    ['missing interest',rows=>rows.shift(),/CASH_RECONCILIATION/],
    ['missing dividend',rows=>rows.pop(),/CASH_RECONCILIATION/],
    ['wrong intermediate balance',rows=>rows[1].balance=56,/CASH_RECONCILIATION/],
    ['wrong final balance',rows=>rows[0].balance=61,/CASH_RECONCILIATION/]
  ])await t.test(name,async()=>{const f=await incomeFixture({change:b=>{if(b.cash_account_transactions)mutate(b.cash_account_transactions);}});await assert.rejects(f.run(),reason);});
});
test('independent payout evidence is bound to stable reads and the next checkpoint, without double-counting income',async()=>{
  const f=await incomeFixture(),s=await f.run();
  const next=await incomeFixture({checkpoint:s,target:'2026-11-05'}),after=await next.run();
  assert.deepEqual(after.periodReturnsInput.points.map(p=>p.tot),[136,146,146]);assert.deepEqual(after.cashFlowByDate,{});
  assert.equal(next.w.calls.some(c=>c.url.includes('/payouts/')),false);await buildIbManagerReportBundle(after,f.expected);
  const changed=await incomeFixture({change:(b,{p,capture})=>{if(p.includes('/payouts/')&&capture===2){b.gross_amount=11;b.resident_withholding_tax=4;}}});
  await assert.rejects(changed.run(),/UNSTABLE/);
  const conflict=structuredClone(s);conflict.closingSnapshots[1].cash[3]++;
  await assert.rejects((await incomeFixture({checkpoint:conflict,target:'2026-11-05'})).run(),/CASH_RECONCILIATION|PAST_POINT_CHANGED/);
});

async function earlyIncomeFixture({date='2026-11-04',early=true,interest=true,checkpoint=null,target=date,change=()=>{}}={}){
  const prev=new Date(Date.parse(date+'T00:00:00Z')-86400000).toISOString().slice(0,10),baseDate=new Date(Date.parse(date+'T00:00:00Z')-2*86400000).toISOString().slice(0,10);
  const seed=checkpoint||await(await incomeFixture({date,baseDate,target:prev})).run();
  const f=await incomeFixture({date,baseDate,target,interest,checkpoint:seed,change:(b,c)=>{
    const d=c.q.get('end_date')||c.q.get('date');
    if(early&&d===prev){
      if(b.report){b.report.cash_accounts[0].value+=7;b.report.value+=7;}
      if(b.cash_accounts)for(const a of b.cash_accounts)a.balance=a.balance_in_portfolio_currency=57;
    }
    change(b,c);
  }});
  return {...f,seed,prev};
}
test('early payout cash is restored only to the authenticated full anchor; raw cash, income and endpoint remain intact',async()=>{
  for(const date of ['2026-07-15','2026-11-04'])for(const interest of [true,false]){
    const f=await earlyIncomeFixture({date,interest}),before=structuredClone(f.seed),s=await f.run(),normal=await(await earlyIncomeFixture({date,interest,early:false})).run();
    assert.deepEqual(f.seed,before);assert.deepEqual(s.periodReturnsInput,normal.periodReturnsInput);assert.deepEqual(s.closingSnapshots,normal.closingSnapshots);
    assert.deepEqual(s.ownerBaseline,before.ownerBaseline);assert.deepEqual(s.bootstrapCoverage,before.bootstrapCoverage);assert.deepEqual(s.cashFlowByDate,{});
    assert.equal(s.incomeDateNormalizations.length,1);assert.equal(s.cashDateNormalizations,undefined);
    const p=s.incomeDateNormalizations[0];assert.equal(p.rawAnchor.cash[3],5700);assert.equal(p.anchor.cash[3],5000);assert.equal(p.payout.netCents,700);
    assert.deepEqual(p.anchor,before.closingSnapshots.at(-1));assert.equal(p.rawClosing.cash[3],interest?6000:5700);assert.equal(p.payout.paidOn,date);
    assert.deepEqual(s.periodReturnsInput.points.slice(0,-1),before.periodReturnsInput.points);
    assert.equal(f.w.calls.filter(c=>c.url.endsWith('/payouts/13.json')).length,2);
    for(const {body:b}of f.captured){
      if(b.report?.end_date===f.prev){assert.equal(b.report.value,143);assert.equal(b.report.cash_accounts[0].value,57);}
      if(b.cash_account_transactions?.length)assert.equal(b.cash_account_transactions.find(r=>r.id===12).amount,7);
    }
    assert.deepEqual(validateIbManagerReportInput(s,f.expected),s);const bundle=await buildIbManagerReportBundle(s,f.expected);assert.equal(bundle.returnReceipt.asOf,date);assert.equal(bundle.drawdownReceipt.asOf,date);
  }
});
test('income date proof continues through same-day checks and later checkpoints without adding income twice',async()=>{
  const f=await earlyIncomeFixture(),s=await f.run();
  const again=await(await earlyIncomeFixture({checkpoint:s})).run();assert.deepEqual(again,s);
  const next=await earlyIncomeFixture({checkpoint:s,target:'2026-11-05'}),after=await next.run();
  assert.deepEqual(after.incomeDateNormalizations,s.incomeDateNormalizations);assert.deepEqual(after.periodReturnsInput.points.slice(0,-1),s.periodReturnsInput.points);
  assert.equal(after.periodReturnsInput.points.at(-1).tot,146);assert.deepEqual(after.cashFlowByDate,{});
  assert.equal(next.w.calls.some(c=>c.url.includes('/payouts/')),false);await buildIbManagerReportBundle(after,f.expected);
});
test('income date projection does not waive incomplete, duplicate, ambiguous or unlinked cash records',async t=>{
  for(const [name,change]of [
    ['missing payout',b=>{if(b.cash_account_transactions)b.cash_account_transactions.pop();}],
    ['missing interest',b=>{if(b.cash_account_transactions)b.cash_account_transactions.shift();}],
    ['duplicate payout',b=>{if(b.cash_account_transactions)b.cash_account_transactions.push({...b.cash_account_transactions[1],id:19});}],
    ['broken payout balance',b=>{if(b.cash_account_transactions)b.cash_account_transactions[1].balance++;}],
    ['broken interest balance',b=>{if(b.cash_account_transactions)b.cash_account_transactions[0].balance++;}],
    ['unknown income',b=>{if(b.cash_account_transactions)b.cash_account_transactions[0].cash_account_transaction_type.name='UNKNOWN';}],
    ['external deposit instead',b=>{if(b.cash_account_transactions)Object.assign(b.cash_account_transactions[0],{cash_account_transaction_type:{name:'DEPOSIT'},description:'Owner capital contribution'});}],
    ['unproved payout',b=>{if(b.paid_on)b.confirmed=false;}],
    ['wrong payout amount',b=>{if(b.paid_on)b.amount++;}],
    ['wrong payout account',b=>{if(b.paid_on)b.portfolio_id=99;}],
    ['wrong payout date',b=>{if(b.paid_on)b.paid_on='2026-11-03';}]
  ])await t.test(name,async()=>{const f=await earlyIncomeFixture({change});await assert.rejects(f.run(),/IB_SOURCE_/);});
});
test('a full checkpoint is mandatory and unrelated historical changes remain rejected, including one cent',async t=>{
  const noCheckpoint=await incomeFixture({change:b=>{if(b.report?.end_date==='2026-11-03'){b.report.value+=7;b.report.cash_accounts[0].value+=7;}}});
  await assert.rejects(noCheckpoint.run(),/CASH_RECONCILIATION|PAST_POINT_CHANGED/);
  for(const [name,change]of [
    ['cash one cent',b=>{if(b.report?.end_date==='2026-11-03'){b.report.cash_accounts[0].value+=0.01;b.report.value+=0.01;}}],
    ['holding repricing',b=>{if(b.report?.end_date==='2026-11-03'){b.report.holdings[0].value++;b.report.value++;}}],
    ['holding quantity',b=>{if(b.report?.end_date==='2026-11-03')b.report.holdings[0].quantity++;}],
    ['endpoint conflict',b=>{if(b.cash_accounts)b.cash_accounts[0].balance_in_portfolio_currency++;}],
    ['target missing cent',b=>{if(b.report?.end_date==='2026-11-04'){b.report.cash_accounts[0].value-=0.01;b.report.value-=0.01;}}],
    ['trade mixed into income day',b=>{if(b.trades)b.trades.push({id:30,portfolio_id:1,holding_id:2,state:'confirmed',transaction_date:'2026-11-04',description_code:'BUY',value:1,quantity:1});}]
  ])await t.test(name,async()=>{const f=await earlyIncomeFixture({change});await assert.rejects(f.run(),/IB_SOURCE_/);});
});
test('persisted income date proof rejects tampering even after rehashing and binds source snapshots and points',async()=>{
  const f=await earlyIncomeFixture(),s=await f.run();
  const rehash=async p=>{const {proofId,...body}=p;p.proofId=await createIbManagerReturnConsumer().digest(body);};
  for(const change of [
    p=>p.schema='untrusted',p=>p.extra=true,p=>p.anchor.d='2026-11-02',p=>p.rawClosing.d='2026-11-05',p=>p.portfolioIdentityHash='a'.repeat(64),
    p=>p.payout.netCents++,p=>p.payout.taxCents++,p=>p.payout.portfolioId++,p=>p.payout.holdingId++,p=>p.payout.cashId++,p=>p.payout.cashRecordId++,p=>p.payout.paidOn='2026-11-03',
    p=>p.rawAnchor.totalCents++,p=>p.rawAnchor.cash[3]++,p=>p.anchor.cash[3]++,p=>p.rawClosing.cash[3]++,
    p=>p.cashLegs.pop(),p=>p.cashLegs.push({...p.cashLegs[0]}),p=>p.cashLegs[0].amountCents++,p=>p.cashLegs[0].balanceCents++,
    p=>p.cashLegs[0].tradeId=99,p=>p.cashLegs[0].payoutId=99,p=>p.cashLegs[0].dateTime='2026-11-03T12:00:00.000Z'
  ]){const bad=structuredClone(s);change(bad.incomeDateNormalizations[0]);await rehash(bad.incomeDateNormalizations[0]);assert.throws(()=>validateIbManagerReportInput(bad,f.expected),/IB_SOURCE_/);}
  for(const change of [
    x=>x.incomeDateNormalizations=[],x=>x.incomeDateNormalizations.push(structuredClone(x.incomeDateNormalizations[0])),
    x=>x.closingSnapshots[0].cash[3]++,x=>x.periodReturnsInput.points.at(-2).tot++,x=>x.incomeDateNormalizations[0].proofId='a'.repeat(64)
  ]){const bad=structuredClone(s);change(bad);assert.throws(()=>validateIbManagerReportInput(bad,f.expected),/IB_SOURCE_/);}
});
test('early-income proof is stable across two reads and rejects later changes to its evidence',async()=>{
  const f=await earlyIncomeFixture({change:(b,c)=>{if(c.capture===2&&b.paid_on){b.gross_amount++;b.resident_withholding_tax++;}}});await assert.rejects(f.run(),/UNSTABLE/);
  const seed=await(await earlyIncomeFixture()).run();
  const changed=await earlyIncomeFixture({checkpoint:seed,change:b=>{if(b.paid_on){b.gross_amount++;b.resident_withholding_tax++;}}});await assert.rejects(changed.run(),/PAST_POINT_CHANGED/);
});
test('two different payouts are ambiguous for this narrow historical correction even with correct total cash',async()=>{
  const f=await earlyIncomeFixture({change:(b,{p,q})=>{
    if(b.report?.end_date==='2026-11-03'){b.report.value+=4;b.report.cash_accounts[0].value+=4;}
    if(b.report?.end_date==='2026-11-04'){b.report.value+=4;b.report.cash_accounts[0].value+=4;}
    if(b.cash_accounts&&q.get('date')==='2026-11-04')for(const c of b.cash_accounts)c.balance=c.balance_in_portfolio_currency=64;
    if(b.cash_account_transactions){b.cash_account_transactions[0].balance=64;b.cash_account_transactions.push({...b.cash_account_transactions[1],id:22,payout_id:23,amount:4,balance:61});}
    if(p==='/api/v2/payouts/23.json')Object.assign(b,{id:23,portfolio_id:1,holding_id:2,paid_on:'2026-11-04',currency:'USD',confirmed:true,state:'confirmed',non_taxable:false,tax_credit:0,gross_amount:5,resident_withholding_tax:1,amount:4});
  }});
  await assert.rejects(f.run(),/CASH_RECONCILIATION/);
});
test('a later separately proved payout preserves the earlier proof and cannot reuse old payout or cash IDs',async()=>{
  const firstFixture=await earlyIncomeFixture(),first=await firstFixture.run();
  const later=async({early=true,reuse=null}={})=>incomeFixture({date:'2026-11-05',baseDate:'2026-11-02',checkpoint:first,change:(b,{p,q})=>{
    const d=q.get('end_date')||q.get('date');
    if(b.report){b.report.value+=10;b.report.cash_accounts[0].value+=10;if(early&&d==='2026-11-04'){b.report.value+=7;b.report.cash_accounts[0].value+=7;}}
    if(b.cash_accounts)for(const a of b.cash_accounts){a.balance+=10;a.balance_in_portfolio_currency+=10;if(early&&d==='2026-11-04'){a.balance+=7;a.balance_in_portfolio_currency+=7;}}
    if(b.cash_account_transactions)for(const l of b.cash_account_transactions){l.balance+=10;l.id+=reuse==='cash'?0:10;if(l.payout_id)l.payout_id=reuse==='payout'?13:23;}
    if(p==='/api/v2/payouts/23.json')Object.assign(b,{id:23,portfolio_id:1,holding_id:2,paid_on:'2026-11-05',currency:'USD',confirmed:true,state:'confirmed',non_taxable:false,tax_credit:0,gross_amount:10,resident_withholding_tax:3,amount:7});
  }});
  const f=await later(),second=await f.run();
  assert.equal(second.incomeDateNormalizations.length,2);assert.deepEqual(second.incomeDateNormalizations[0],first.incomeDateNormalizations[0]);
  assert.deepEqual(second.periodReturnsInput.points.map(p=>p.tot),[136,136,146,156]);assert.deepEqual(second.closingSnapshots[0],first.closingSnapshots[1]);
  await buildIbManagerReportBundle(second,f.expected);
  for(const early of [true,false])for(const reuse of ['cash','payout'])await assert.rejects((await later({early,reuse})).run(),/PAST_POINT_CHANGED/);
});
test('income normalization retains passive foreign cash and rejects an unrelated native balance change',async()=>{
  const foreign=(b,{p,q})=>{
    if(b.report){b.report.holdings[0].value-=20;b.report.cash_accounts.push({id:5,value:20,currency:{code:'CAD'},portfolio:{id:1,name:'IB-HK'}});}
    if(b.cash_accounts)b.cash_accounts.push({id:5,portfolio_id:1,portfolio_currency:'USD',currency:'CAD',date:q.get('date'),balance:30,balance_in_portfolio_currency:20});
    if(p==='/api/v2/cash_accounts/5/cash_account_transactions.json')b.cash_account_transactions=[];
  };
  const first=await(await incomeFixture({baseDate:'2026-11-02',target:'2026-11-03',change:foreign})).run();
  const f=await earlyIncomeFixture({checkpoint:first,change:foreign}),s=await f.run();
  assert.deepEqual(s.closingSnapshots.map(x=>x.nativeCash),[{'5':3000},{'5':3000}]);assert.deepEqual(s.periodReturnsInput.points.map(x=>x.tot),[136,136,146]);
  assert.deepEqual(s.incomeDateNormalizations[0].anchor,first.closingSnapshots[1]);await buildIbManagerReportBundle(s,f.expected);
  const bad=await earlyIncomeFixture({checkpoint:first,change:(b,c)=>{foreign(b,c);if(b.cash_accounts&&c.q.get('date')==='2026-11-04')b.cash_accounts[1].balance++;}});
  await assert.rejects(bad.run(),/CASH_RECONCILIATION|UNSUPPORTED_CURRENCY/);
});

async function cashDateFixture({events=[{d:'2026-11-02',kind:'BUY'}],target='2026-11-02',baseDate='2026-10-30',early=true,checkpoint=null,mutate=()=>{}}={}){
  const base={from:baseDate,asOf:baseDate},business={points:[{d:baseDate,tot:136}],openT:136,from:baseDate,to:baseDate,days:1,flowByDate:{},rate:0,cr:0,cumBefore:0,hwmBefore:0};
  const expected=ibBaselineBusinessHash(business),frozen={schema:'fee-console.ib-manager-return-input.v1',currency:'USD',timezone:'America/New_York',flowTiming:'eod',flowsComplete:true,correctionsConfirmed:true,sourceSha256:'c'.repeat(64),periodReturnsInput:business};
  const owner=await buildIbOwnerBaseline({ibManagerReturnReceipt:await buildIbManagerReturnReceipt(frozen),ibManagerDrawdownReceipt:await buildIbManagerDrawdownReceipt(frozen)},frozen,expected);
  const body={schema:'fee-console.ib-manager-coverage.v2',authority:'reviewed-source-reconciliation',sourceProvider:'Sharesight',baselineInputsHash:expected,from:add(baseDate),through:target,evidenceSha256:'e'.repeat(64),events:[],quotes:[]},coverage={...body,coverageId:await createIbManagerReturnConsumer().digest(body)};
  const prev=d=>new Date(Date.parse(d+'T00:00:00Z')-86400000).toISOString().slice(0,10),move=e=>e.kind==='BUY'?-10:10;
  const cash=d=>50+events.filter(e=>(early?prev(e.d):e.d)<=d).reduce((v,e)=>v+move(e),0),held=d=>events.filter(e=>e.d<=d).reduce((v,e)=>v-move(e),0);
  const captured=[];
  const w=wire({mutate:(b,c)=>{
    const d=c.q.get('end_date')||c.q.get('date');
    if(b.report){const h=b.report.holdings[0];h.value=86+held(d);h.quantity=2+held(d)/10;b.report.cash_accounts[0].value=cash(d);b.report.value=h.value+cash(d);}
    if(b.cash_accounts)for(const a of b.cash_accounts)a.balance=a.balance_in_portfolio_currency=cash(d);
    const active=events.map((e,n)=>({...e,n})).filter(e=>e.d>=(c.q.get('start_date')||c.q.get('from'))&&e.d<=(c.q.get('end_date')||c.q.get('to')));
    if(b.trades)b.trades=active.map(e=>({id:8+e.n,portfolio_id:1,holding_id:2,state:'confirmed',transaction_date:e.d,description_code:e.kind,value:-move(e),quantity:1,instrument:{currency_code:'USD'}}));
    if(b.cash_account_transactions)b.cash_account_transactions=active.map(e=>({id:18+e.n,cash_account_id:3,date_time:e.d+'T00:00:00.000Z',amount:move(e),balance:50+events.filter(x=>x.d<=e.d).reduce((v,x)=>v+move(x),0),trade_id:8+e.n,holding_id:2,cash_account_transaction_type:{name:e.kind==='BUY'?'Buy Trade':'Sell Trade'}}));
    mutate(b,c);if(b.report)captured.push(structuredClone(b.report));
  }});
  const args={targetDate:target,baseline:base,expectedBaselineHash:expected,...(checkpoint?{checkpoint}:{ownerBaseline:owner,bootstrapCoverage:coverage})};
  return {expected,owner,coverage,captured,args,w,run:()=>w.reader.readStable(args)};
}
test('one early USD trade cash valuation is explicitly proved without shifting trades, flows, endpoints or raw snapshots',async()=>{
  for(const kind of ['BUY','SELL']){
    const f=await cashDateFixture({events:[{d:'2026-11-02',kind}]}),s=await f.run(),normal=await(await cashDateFixture({events:[{d:'2026-11-02',kind}],early:false})).run();
    const {cashDateNormalizations,...rest}=s;assert.deepEqual(rest,normal);assert.equal(cashDateNormalizations.length,1);
    const p=cashDateNormalizations[0],movement=kind==='BUY'?-1000:1000;
    assert.equal(p.rawBefore.d,'2026-11-01');assert.equal(p.rawBefore.totalCents,13600+movement);assert.equal(p.rawBefore.cash[3],5000+movement);
    assert.equal(p.rawAfter.d,'2026-11-02');assert.equal(p.rawAfter.totalCents,13600);assert.equal(p.anchor.d,'2026-10-31');
    assert.equal(p.trade.date,'2026-11-02');assert.deepEqual(s.cashFlowByDate,{});assert.deepEqual(s.periodReturnsInput.points.map(x=>x.tot),[136,136,136,136]);
    assert.equal(f.captured.find(x=>x.end_date==='2026-11-01').value,136+movement/100);
    assert.equal(s.closingSnapshots[0].cash[3],5000);assert.equal(s.closingSnapshots[0].totalCents,13600);
    assert.equal(s.baselineInputsHash,f.expected);assert.deepEqual(s.ownerBaseline,f.owner);assert.deepEqual(s.bootstrapCoverage,f.coverage);
    assert.deepEqual(validateIbManagerReportInput(s,f.expected),s);await buildIbManagerReportBundle(s,f.expected);
    const again=await(await cashDateFixture({events:[{d:'2026-11-02',kind}],checkpoint:s})).run();
    assert.deepEqual(again.cashDateNormalizations,s.cashDateNormalizations);assert.deepEqual(again.periodReturnsInput,s.periodReturnsInput);
  }
});
test('a later trade may reprice the raw checkpoint anchor only when its canonical snapshot still matches in full',async()=>{
  const first=await(await cashDateFixture()).run(),events=[{d:'2026-11-02',kind:'BUY'},{d:'2026-11-03',kind:'BUY'}];
  const f=await cashDateFixture({events,target:'2026-11-03',checkpoint:first}),next=await f.run();
  assert.equal(f.captured[0].end_date,'2026-11-02');assert.equal(f.captured[0].value,126);
  assert.deepEqual(next.closingSnapshots[0],first.closingSnapshots[1]);assert.equal(next.cashDateNormalizations.length,2);
  assert.deepEqual(next.cashDateNormalizations[0],first.cashDateNormalizations[0]);assert.equal(next.cashDateNormalizations[1].anchorKind,'checkpoint');
  const same=await(await cashDateFixture({events,target:'2026-11-03',checkpoint:next})).run();assert.deepEqual(same.cashDateNormalizations,next.cashDateNormalizations);
  const later=await(await cashDateFixture({events,target:'2026-11-04',checkpoint:next})).run();assert.deepEqual(later.cashDateNormalizations,next.cashDateNormalizations);assert.deepEqual(later.periodReturnsInput.points.slice(0,-1),next.periodReturnsInput.points);
  await assert.rejects((await cashDateFixture({events,target:'2026-11-03',checkpoint:first,mutate:b=>{if(b.report?.end_date==='2026-11-02'){b.report.holdings[0].value++;b.report.value++;}}})).run(),/PAST_POINT_CHANGED/);
});
test('cash-date normalization rejects absent anchors, extra events, nonmatching amounts and all unrelated anomalies',async()=>{
  const changes=[
    b=>{if(b.report?.end_date==='2026-11-01'){b.report.cash_accounts[0].value++;b.report.value++;}},
    b=>{if(b.report?.end_date==='2026-10-31'){b.report.cash_accounts[0].value++;b.report.value++;}},
    b=>{if(b.report?.end_date==='2026-11-02')b.report.holdings[0].quantity++;},
    b=>{if(b.trades)b.trades.push({...b.trades[0],id:99,quantity:.1,value:1});},
    b=>{if(b.cash_account_transactions)b.cash_account_transactions.push({id:99,cash_account_id:3,date_time:'2026-11-01T12:00:00Z',amount:0,balance:50,cash_account_transaction_type:{name:'FEE'}});},
    b=>{if(b.cash_account_transactions)b.cash_account_transactions[0].amount=-9.99;},
    b=>{if(b.trades)b.trades[0].instrument.currency_code='CAD';},
    b=>{if(b.cash_account_transactions)b.cash_account_transactions[0].balance=41;},
    b=>{if(b.report?.end_date==='2026-11-01')b.report.complete=false;},
    b=>{if(b.cash_account_transactions)b.cash_account_transactions[0].payout_id=99;}
  ];
  for(const mutate of changes)await assert.rejects((await cashDateFixture({mutate})).run(),/IB_SOURCE_/);
  await assert.rejects((await cashDateFixture({baseDate:'2026-11-01'})).run(),/CASH_RECONCILIATION/);
  await assert.rejects((await cashDateFixture({events:[{d:'2026-11-02',kind:'BUY'},{d:'2026-11-04',kind:'BUY'}],target:'2026-11-04'})).run(),/CASH_RECONCILIATION/);
});
test('normalization proofs remain bound to the private source, arithmetic, native identities and daily path',async()=>{
  const f=await cashDateFixture(),s=await f.run(),canonical=createIbManagerReturnConsumer().canonical;
  const rehash=p=>{const {proofId,...body}=p;p.proofId=crypto.createHash('sha256').update(canonical(body)).digest('hex');};
  for(const mutate of [
    p=>p.cashLeg.amountCents++,p=>p.cashLeg.tradeId++,p=>p.cashLeg.dateTime='2026-11-01T00:00:00.000Z',p=>p.cashLeg.payoutId=99,
    p=>p.rawBefore.cash[3]++,p=>p.rawBefore.totalCents++,p=>p.rawAfter.cash[3]++,p=>p.anchor.cash[3]++,
    p=>p.trade.currency='CAD',p=>p.trade.quantityAtoms='2000000000000000000',p=>p.rawBefore.positions[2]='1000000000000000000',
    p=>p.windowThrough='2026-11-10',p=>p.anchorKind='checkpoint',p=>p.portfolioIdentityHash='a'.repeat(64)
  ]){const bad=structuredClone(s);mutate(bad.cashDateNormalizations[0]);rehash(bad.cashDateNormalizations[0]);assert.throws(()=>validateIbManagerReportInput(bad,f.expected),/IB_SOURCE_/);}
  for(const mutate of [x=>x.cashDateNormalizations.push(structuredClone(x.cashDateNormalizations[0])),x=>x.cashDateNormalizations=[],x=>x.closingSnapshots[0].cash[3]++,x=>x.periodReturnsInput.points.find(p=>p.d==='2026-11-01').tot++]){const bad=structuredClone(s);mutate(bad);assert.throws(()=>validateIbManagerReportInput(bad,f.expected),/IB_SOURCE_/);}
  const before=structuredClone(s);await buildIbManagerReportBundle(s,f.expected);assert.deepEqual(s,before);
});
