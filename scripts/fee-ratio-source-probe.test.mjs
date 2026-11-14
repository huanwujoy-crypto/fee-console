// Synthetic identifiers, names, amounts and credentials only. Every request
// below is answered by an in-memory stub; the real network is never reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {runRatioSourceProbe,ratioProbeArgs,validateRatioProbeAdmission,ratioReportShapeFacts,RATIO_PROBE_CODES,RATIO_PROBE_BUDGET,RATIO_PROBE_STAGES,RATIO_PROBE_VIEW,RATIO_PROBE_GROUP,RATIO_PROBE_INPUTS,RATIO_PROBE_PERFORMANCE_GROUPS,ratioPerformanceShapeFacts} from './fee-ratio-source-probe.mjs';
globalThis.fetch=async()=>{throw Error('OFFLINE_TEST_NETWORK_FORBIDDEN');};

const MAIN='a'.repeat(40),TARGET='2026-11-10',NOW=new Date('2026-11-11T02:00:00.000Z'),API='https://api.sharesight.com';
const SECRET='synthetic-client-secret-not-real',CLIENT='synthetic-client-id-not-real',TOKEN='synthetic-access-token-not-real-0123456789';
const env=(extra={})=>({GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'huanwujoy-crypto/fee-console',GITHUB_REF:'refs/heads/main',GITHUB_SHA:MAIN,GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_ACTOR_ID:'283054367',GITHUB_RUN_ATTEMPT:'1',FEE_CLOUD_SHARESIGHT_CLIENT_ID:CLIENT,FEE_CLOUD_SHARESIGHT_CLIENT_SECRET:SECRET,...extra});
const event=(inputs={})=>({sender:{id:283054367},repository:{full_name:'huanwujoy-crypto/fee-console'},inputs:{source_probe_once:'true',source_probe_main:MAIN,source_probe_target:TARGET,run_reviewed_once:'false',ratio_plan:'',report_kind:'',...inputs}});
const argv=['--expected-main='+MAIN,'--target='+TARGET];
const accounts=Array.from({length:10},(_,i)=>({id:500+i,name:'Invented member '+i}));
function report(){
  const portfolio=a=>({id:a.id,consolidated:false,name:a.name});let n=9000;
  const holdings=accounts.slice(0,6).map((a,i)=>({id:n++,instrument:{code:'SYN'+i,market_code:'TEST',name:'Invented security '+i},quantity:3,value:1234.5+i,valid_position:true,limited:false,portfolio:portfolio(a),group_id:7,group_name:i<2?'VC/PE':'美国底仓'}));
  const cash_accounts=accounts.slice(6,8).map(a=>({id:n++,name:'Invented cash',value:77.25,currency:{code:'USD'},portfolio:portfolio(a)}));
  const value=Math.round([...holdings,...cash_accounts].reduce((s,r)=>s+r.value*100,0))/100;
  return {id:'PerformanceReport_39',portfolio_id:39,value,grouping:'custom_group_category',custom_group:{id:88,name:RATIO_PROBE_GROUP},currency:{code:'USD'},start_date:TARGET,end_date:TARGET,include_sales:false,percentages_annualised:false,holdings,sub_totals:[],cash_accounts};
}
const REPORT_URL=`${API}/api/v3/portfolios/39/performance?consolidated=true&custom_group_id=88&end_date=${TARGET}&grouping=custom_group&include_limited=true&include_sales=false&report_combined=false&start_date=${TARGET}`;
// Eight synthetic performance reports: four groups (asset reuses group 88) x two windows.
const PERF_GROUPS=Object.entries(RATIO_PROBE_PERFORMANCE_GROUPS).map(([key,name],i)=>({key,name,id:key==='asset'?88:90+i}));
const PERF_STARTS={all:'2000-01-01',oneYear:'2025-11-10'};
const perfUrl=(g,w)=>`${API}/api/v3/portfolios/39/performance?consolidated=true&custom_group_id=${g.id}&end_date=${TARGET}&grouping=custom_group&include_limited=true&include_sales=true&report_combined=false&start_date=${PERF_STARTS[w]}`;
function perfReport(g,w){
  const base=report();
  return {...base,custom_group:{id:g.id,name:g.name},start_date:PERF_STARTS[w],include_sales:true,percentages_annualised:w==='all',
    holdings:base.holdings.map(h=>({...h,capital_gain:12.5,capital_gain_percent:1.25,total_gain:13.5,total_gain_percent:1.35})),
    sub_totals:[{group_id:7,group_name:'VC/PE',value:10,total_gain:1,total_gain_percent:2.5},{group_id:7,group_name:'美国底仓',value:20,total_gain:2,total_gain_percent:3.5}],
    cash_accounts:base.cash_accounts.map(c=>({...c,total_gain:null,total_gain_percent:null}))};
}
// Holdings listings: the six report positions (ids 9000-9005) each carry a
// first-buy date; one extra sold-out holding carries one too.
const viewHoldingsUrl=API+'/api/v3/portfolios/39/holdings?consolidated=true',memberHoldingsUrl=a=>`${API}/api/v3/portfolios/${a.id}/holdings?consolidated=false`;
const TRADES_URL=`${API}/api/v3/portfolios/${accounts[0].id}/trades.json?consolidated=false&end_date=${TARGET}`;
const listedHolding=(a,hid,when)=>({id:hid,portfolio_id:a.id,inception_date:when,instrument:{code:'SYN',market_code:'TEST'},valid_position:true});
const memberHoldings=a=>{const i=accounts.indexOf(a);return {holdings:i<6?[listedHolding(a,9000+i,'2021-03-0'+(i+1)),...(i===0?[listedHolding(a,9900,'2019-01-02')]:[])]:[]};};
function routes(edit=()=>{}){
  const r=new Map([
    [API+'/oauth2/token',{access_token:TOKEN,token_type:'Bearer'}],
    [API+'/api/v3/portfolios?consolidated=true',{portfolios:[{id:39,name:RATIO_PROBE_VIEW,consolidated:true,currency_code:'USD',portfolio_ids:accounts.map(a=>a.id)},{id:40,name:'Invented other view',consolidated:true,currency_code:'USD'}]}],
    [API+'/api/v2/portfolios.json',{portfolios:[...accounts,{id:777,name:'Invented outsider'}]}],
    [API+'/api/v2/groups.json',{groups:[{id:88,name:RATIO_PROBE_GROUP},{id:89,name:'Invented other group'},...PERF_GROUPS.filter(g=>g.key!=='asset').map(g=>({id:g.id,name:g.name}))]}],
    ...PERF_GROUPS.flatMap(g=>['all','oneYear'].map(w=>[perfUrl(g,w),{report:perfReport(g,w)}])),
    [viewHoldingsUrl,{holdings:accounts.slice(0,6).map((a,i)=>listedHolding(a,9000+i,null))}],
    ...accounts.map(a=>[memberHoldingsUrl(a),memberHoldings(a)]),
    [TRADES_URL,{trades:[{id:1,holding_id:9000,portfolio_id:accounts[0].id,transaction_date:'2021-03-01',description_code:'BUY',state:'confirmed',quantity:3,price:411.5},{id:2,holding_id:9900,portfolio_id:accounts[0].id,transaction_date:'2020-05-05',description_code:'SELL',state:'confirmed',quantity:1,price:9.75}]}],
    [REPORT_URL,{report:report(),api_transaction:{id:1,version:3,action:'/api/v3/example',timestamp:'2026-11-11T02:00:00.000Z'},links:{self:'https://www.example.com/api/v3/example'}}]]);
  edit(r);return r;
}
function stub(map,{status=()=>200}={}){
  const calls=[];
  const fetchImpl=async(url,init)=>{
    calls.push({url,method:init.method,auth:init.headers.Authorization||null,body:init.body||null,redirect:init.redirect});
    if(!map.has(url))throw new TypeError('unexpected synthetic route');
    const body=new TextEncoder().encode(JSON.stringify(map.get(url)));let sent=false;
    return {url,status:status(url),redirected:false,ok:true,headers:{get:k=>k.toLowerCase()==='content-type'?'application/json':null},
      body:{getReader(){return {read:async()=>sent?{done:true}:(sent=true,{done:false,value:body}),cancel:async()=>{},releaseLock(){}};}}};
  };
  return {fetchImpl,calls};
}
const run=(map,options={})=>{const s=stub(map,options.stub);return runRatioSourceProbe({argv,env:env(),event:event(),now:NOW,fetchImpl:s.fetchImpl,...options.run}).then(result=>({result,calls:s.calls}));};
// The reviewed ten-account scope hash is for the real names; synthetic names never match it.
const leakFree=(result)=>{const text=JSON.stringify(result);for(const secret of [SECRET,CLIENT,TOKEN,'Invented','SYN0','1234.5','77.25','39','88'].filter(s=>s.length>3))assert.equal(text.includes(secret),false,secret);};

test('complete synthetic read makes exactly twenty-five fixed requests, GET-only after the token, and reports value-free facts',async()=>{
  const {result,calls}=await run(routes());
  assert.equal(result.outcome,'REPORT_PROJECTED');assert.equal(result.stage,'COMPLETE');assert.equal(result.code,null);assert.equal(result.requests,25);
  assert.deepEqual(calls.map(c=>[c.method,c.url]),[['POST',API+'/oauth2/token'],['GET',API+'/api/v3/portfolios?consolidated=true'],['GET',API+'/api/v2/portfolios.json'],['GET',API+'/api/v2/groups.json'],['GET',REPORT_URL],...PERF_GROUPS.flatMap(g=>['all','oneYear'].map(w=>['GET',perfUrl(g,w)])),['GET',viewHoldingsUrl],...accounts.map(a=>['GET',memberHoldingsUrl(a)]),['GET',TRADES_URL]]);
  assert.equal(calls[0].auth,null);assert.equal(calls.slice(1).every(c=>c.auth==='Bearer '+TOKEN&&c.body===null),true);assert.equal(calls.every(c=>c.redirect==='error'),true);
  const f=result.facts;
  assert.deepEqual([f.consolidatedViewMatches,f.groupMatches,f.viewCurrencyIsUsd,f.viewDeclaresMembers,f.membersSource,f.memberCountIsTen,f.everyMemberListed,f.observedWithinMembers,f.rootHasOnlyKnownKeys],[1,1,true,true,'view',true,true,true,true]);
  assert.equal(f.scopeMatchesReviewedTen,false);
  assert.deepEqual(f.projection,{responseGrouping:'custom_group_category',reportTotalEqualsRows:true,reportTotalDifference:'NONE',membersWithoutRows:2,categoriesWithinKnownFour:true});
  assert.equal(Object.values(f.shape.anomalies).every(n=>n===0),true);
  assert.equal(f.shape.holding.value,'number');assert.equal(f.shape.instrument.market_code,'string');assert.equal(f.shape.report.combined_holdings,'absent');
  leakFree(result);
});

test('eight performance reports are described by field names and kinds only; one unreadable report does not stop the rest',async()=>{
  const {result}=await run(routes());const p=result.facts.performance;
  assert.equal(p.complete,true);assert.deepEqual(Object.keys(p.reports),['asset.all','asset.oneYear','income.all','income.oneYear','top.all','top.oneYear','stock.all','stock.oneYear']);
  const first=p.reports['asset.all'];
  assert.deepEqual(first.echoes,{startDate:true,endDate:true,includeSales:true,groupId:true,groupName:true,currencyIsUsd:true});
  assert.equal(first.percentagesAnnualised,true);assert.equal(p.reports['asset.oneYear'].percentagesAnnualised,false);
  assert.deepEqual(first.has,{holdings:true,subTotals:true,cash:true,oneSubTotalPerGroupName:true});
  assert.equal(first.holding.fields.total_gain_percent,'number');assert.equal(first.cash.fields.total_gain,'null');assert.equal(first.subTotal.fields.total_gain_percent,'number');assert.equal(first.report.fields.percentages_annualised,'boolean');
  assert.equal(Object.values(p.reports).slice(1).every(r=>r.read&&r.sameFieldsAsFirst===true&&!Object.hasOwn(r,'holding')),true);
  leakFree(result);for(const amount of ['12.5','1.25','13.5','1.35','2.5','3.5'])assert.equal(JSON.stringify(p).includes(':'+amount),false,amount);
  // A different field set is printed in full; a refused or missing report is one fixed code.
  const g=PERF_GROUPS.find(x=>x.key==='top'),s=PERF_GROUPS.find(x=>x.key==='stock');
  const mixed=await run(routes(r=>{r.get(perfUrl(g,'all')).report.holdings[0].total_gain=null;r.get(perfUrl(g,'all')).report.holdings[0]['Odd Key']=1;r.delete(perfUrl(g,'oneYear'));r.get(perfUrl(s,'all')).report.limited=true;r.get(API+'/api/v2/groups.json').groups.pop();}));
  const m=mixed.result.facts.performance;
  assert.equal(mixed.result.outcome,'REPORT_PROJECTED');assert.equal(m.complete,false);
  assert.equal(m.reports['top.all'].sameFieldsAsFirst,false);assert.equal(m.reports['top.all'].holding.fields.total_gain,'null|number');assert.equal(m.reports['top.all'].holding.unlisted,true);assert.equal(JSON.stringify(m).includes('Odd Key'),false);
  assert.deepEqual(m.reports['top.oneYear'],{read:false,code:'RATIO_PROBE_TRANSPORT',httpCode:'OTHER'});
  const last=PERF_GROUPS.at(-1).key;
  assert.deepEqual(m.reports[last+'.all'],{read:false,code:'RATIO_PROBE_GROUP_IDENTITY'});assert.deepEqual(m.reports[last+'.oneYear'],{read:false,code:'RATIO_PROBE_GROUP_IDENTITY'});
  if(last!=='stock')assert.deepEqual(m.reports['stock.all'],{read:false,code:'RATIO_PROBE_INCOMPLETE'});
  leakFree(mixed.result);
  assert.equal(ratioPerformanceShapeFacts(undefined,{start:'a',end:'b',groupId:'1',groupName:'x'}).has.holdings,false);
});

test('first-buy dates: member holdings listings are matched to the report positions by counts and field names only',async()=>{
  const {result}=await run(routes());const n=result.facts.inception;
  assert.deepEqual([n.consolidated.read,n.consolidated.inceptionDates,n.consolidated.fields.inception_date],[true,'NONE','null']);
  assert.deepEqual([n.membersRead,n.memberCodes],[10,[]]);
  assert.equal(n.holding.fields.inception_date,'string');
  assert.deepEqual(n.anomalies,{listedWithoutInceptionDate:0,inceptionAfterTarget:0,listedWithoutId:0});
  assert.deepEqual(n.classification,{everyPositionListed:true,positionsNotListed:0,listedPositionsWithoutDate:0});
  assert.deepEqual([n.trades.read,n.trades.hasRows,n.trades.descriptionCodes,n.trades.states,n.trades.transactionDates,n.trades.withHoldingId],[true,true,['BUY','SELL'],['confirmed'],'ALL','ALL']);
  assert.equal(n.trades.fields.price,'number');
  leakFree(result);for(const secret of ['2021-03','2019-01','2020-05','411.5','9.75','9900'])assert.equal(JSON.stringify(n).includes(secret),false,secret);
  // Gaps are counted, unreadable members are one fixed code each, and odd codes are not echoed.
  const gaps=await run(routes(r=>{
    r.get(memberHoldingsUrl(accounts[1])).holdings[0].inception_date=null;r.get(memberHoldingsUrl(accounts[2])).holdings=[];
    r.get(memberHoldingsUrl(accounts[3])).holdings[0].inception_date='2026-12-01';r.delete(memberHoldingsUrl(accounts[9]));r.get(memberHoldingsUrl(accounts[8])).links={next:'x'};
    r.get(TRADES_URL).trades[0].description_code='Invented free text 123';r.get(TRADES_URL).trades[1].holding_id=null;}));
  const g=gaps.result.facts.inception;
  assert.equal(gaps.result.outcome,'REPORT_PROJECTED');
  assert.deepEqual([g.membersRead,g.memberCodes],[8,['RATIO_PROBE_INCOMPLETE','RATIO_PROBE_TRANSPORT']]);
  assert.deepEqual(g.anomalies,{listedWithoutInceptionDate:1,inceptionAfterTarget:1,listedWithoutId:0});
  assert.deepEqual(g.classification,{everyPositionListed:false,positionsNotListed:1,listedPositionsWithoutDate:1});
  assert.deepEqual([g.trades.descriptionCodes,g.trades.withHoldingId],[['OTHER','SELL'],'NOT_ALL']);leakFree(gaps.result);
});

test('members fall back to the report rows when the view declares none; a different count stops at MEMBERS',async()=>{
  const some=routes(r=>{delete r.get(API+'/api/v3/portfolios?consolidated=true').portfolios[0].portfolio_ids;});
  const a=await run(some);assert.equal(a.result.code,'RATIO_PROBE_MEMBERS');assert.equal(a.result.stage,'PROJECTION');assert.equal(a.result.facts.membersSource,'report-rows');assert.equal(a.result.facts.memberCountIsTen,false);
  const unlisted=routes(r=>{r.get(API+'/api/v2/portfolios.json').portfolios.shift();});
  const b=await run(unlisted);assert.equal(b.result.code,'RATIO_PROBE_MEMBERS');assert.equal(b.result.facts.everyMemberListed,false);leakFree(b.result);
});

test('each stage stops with its own fixed code and never issues a later request',async()=>{
  const cases=[
    [r=>r.set(API+'/oauth2/token',{access_token:'short',token_type:'Bearer'}),'TOKEN','RATIO_PROBE_AUTH_RESPONSE',1],
    [r=>r.get(API+'/api/v3/portfolios?consolidated=true').portfolios[0].name='Renamed view','VIEWS','RATIO_PROBE_VIEW_IDENTITY',2],
    [r=>r.get(API+'/api/v3/portfolios?consolidated=true').portfolios.push({id:41,name:RATIO_PROBE_VIEW,consolidated:true}),'VIEWS','RATIO_PROBE_VIEW_IDENTITY',2],
    [r=>r.get(API+'/api/v3/portfolios?consolidated=true').links={next:'x'},'VIEWS','RATIO_PROBE_INCOMPLETE',2],
    [r=>r.set(API+'/api/v2/portfolios.json',{rows:[]}),'PORTFOLIOS','RATIO_PROBE_SHAPE',3],
    [r=>r.get(API+'/api/v2/groups.json').groups[0].name='Renamed group','GROUPS','RATIO_PROBE_GROUP_IDENTITY',4],
    [r=>r.set(REPORT_URL,{report:null}),'REPORT','RATIO_PROBE_SHAPE',5],
    [r=>r.get(REPORT_URL).report.limited=true,'REPORT','RATIO_PROBE_INCOMPLETE',5],
    [r=>r.get(REPORT_URL).report.holdings[0].limited=true,'PROJECTION','RATIO_API_SOURCE_HOLDING_LIMITED',5],
    [r=>r.get(REPORT_URL).report.holdings[0].value=10.005,'PROJECTION','RATIO_API_SOURCE_HOLDING_VALUE',5],
    [r=>r.get(REPORT_URL).report.currency.code='HKD','PROJECTION','RATIO_API_SOURCE_CURRENCY',5],
    [r=>r.get(REPORT_URL).report.holdings[0].portfolio.id=777,'PROJECTION','RATIO_API_SOURCE_HOLDING_ACCOUNT',5]];
  for(const [edit,stage,code,requests]of cases){
    const {result}=await run(routes(edit));
    assert.deepEqual([result.outcome,result.stage,result.code,result.requests],['FAILED',stage,code,requests],code);assert.ok(RATIO_PROBE_CODES.includes(result.code));leakFree(result);
  }
  // A refused projection still reports which rows would be refused, without values.
  const precise=await run(routes(r=>{const h=r.get(REPORT_URL).report.holdings;h[0].value=10.005;h[1].value=3.14159;}));
  assert.equal(precise.result.facts.shape.anomalies.holdingValuesBeyondCents,2);
});

test('transport failures, unknown routes and remote error text become one fixed code with no remote text',async()=>{
  const missing=routes(r=>r.delete(API+'/api/v2/groups.json')),a=await run(missing);
  assert.deepEqual([a.result.stage,a.result.code,a.result.requests],['GROUPS','RATIO_PROBE_TRANSPORT',4]);assert.equal(a.result.diagnostic.phase,'FETCH');
  const denied=await run(routes(),{stub:{status:url=>url.endsWith('/performance?consolidated=true&custom_group_id=88&end_date='+TARGET+'&grouping=custom_group&include_limited=true&include_sales=false&report_combined=false&start_date='+TARGET)?403:200}});
  assert.deepEqual([denied.result.stage,denied.result.code,denied.result.diagnostic.httpCode],['REPORT','RATIO_PROBE_TRANSPORT','HTTP']);
  const text=routes(r=>r.set(API+'/api/v3/portfolios?consolidated=true',{error:'Invented remote message with account 1234567'})),c=await run(text);
  assert.equal(c.result.code,'RATIO_PROBE_SHAPE');leakFree(c.result);assert.equal(JSON.stringify(c.result).includes('remote message'),false);
});

test('admission accepts only the exact owner dispatch, main, first attempt, the probe inputs alone and a recent date',async()=>{
  const args=ratioProbeArgs(argv);validateRatioProbeAdmission({args,env:env(),event:event(),now:NOW});
  for(const bad of [[],['--target='+TARGET],[...argv,'--force'],['--expected-main=main','--target='+TARGET],[...argv,'--target='+TARGET],['--expected-main='+MAIN,'--target=2026-02-30']])assert.throws(()=>ratioProbeArgs(bad),{message:'RATIO_PROBE_ARGUMENT'});
  for(const e of [{GITHUB_REF:'refs/heads/other'},{GITHUB_SHA:'b'.repeat(40)},{GITHUB_ACTOR_ID:'1'},{GITHUB_RUN_ATTEMPT:'2'},{GITHUB_EVENT_NAME:'schedule'},{GITHUB_REPOSITORY:'someone/fork'},{FEE_DATA_KEY:'x'},{FEE_RATIO_MANAGER_TOKEN:'x'},{RATIO_PLAN:'{}'},{GITHUB_TOKEN:'x'},{GOOGLE_APPLICATION_CREDENTIALS:'/tmp/x'},{FEE_CLOUD_SHARESIGHT_CLIENT_SECRET:''}])
    assert.throws(()=>validateRatioProbeAdmission({args,env:env(e),event:event(),now:NOW}),{message:'RATIO_PROBE_ENVIRONMENT'},JSON.stringify(Object.keys(e)));
  for(const i of [{source_probe_main:'b'.repeat(40)},{source_probe_target:'2026-11-09'},{source_probe_once:'false'},{ratio_plan:'{}'},{ratio_main:MAIN},{report_kind:'daily'},{run_reviewed_once:true},{ib_envelope_once:'true'},{unknown_input:''}])assert.throws(()=>validateRatioProbeAdmission({args,env:env(),event:event(i),now:NOW}),{message:'RATIO_PROBE_EVENT'});
  assert.throws(()=>validateRatioProbeAdmission({args,env:env(),event:{...event(),sender:{id:1}},now:NOW}),{message:'RATIO_PROBE_EVENT'});
  for(const now of ['2026-11-09T15:59:59.000Z','2026-11-14T16:00:00.000Z'])assert.throws(()=>validateRatioProbeAdmission({args,env:env(),event:event(),now:new Date(now)}),{message:'RATIO_PROBE_TARGET_DATE'});
  validateRatioProbeAdmission({args,env:env(),event:event(),now:new Date('2026-11-14T15:59:59.000Z')});
  // The plan check runs before any credential exists and makes no request.
  const s=stub(routes()),checkEnv=env();delete checkEnv.FEE_CLOUD_SHARESIGHT_CLIENT_ID;delete checkEnv.FEE_CLOUD_SHARESIGHT_CLIENT_SECRET;
  const plan=await runRatioSourceProbe({argv:['--check-plan',...argv],env:checkEnv,event:event(),now:NOW,fetchImpl:s.fetchImpl});
  assert.deepEqual([plan.outcome,plan.mode,plan.requests,s.calls.length],['PLAN_OK','check-plan',0,0]);
  const withSecrets=await runRatioSourceProbe({argv:['--check-plan',...argv],env:env(),event:event(),now:NOW,fetchImpl:s.fetchImpl});assert.equal(withSecrets.code,'RATIO_PROBE_ENVIRONMENT');
  const refused=await runRatioSourceProbe({argv,env:env({GITHUB_ACTOR_ID:'1'}),event:event(),now:NOW,fetchImpl:s.fetchImpl});assert.deepEqual([refused.stage,refused.code,s.calls.length],['ADMISSION','RATIO_PROBE_ENVIRONMENT',0]);
});

test('budget, shape facts and the dispatch workflow stay fixed and read-only',()=>{
  assert.deepEqual(RATIO_PROBE_BUDGET,{requests:25,overallMs:300000,requestMs:30000,reportBytes:8388608});
  assert.deepEqual(RATIO_PROBE_STAGES,['ADMISSION','TOKEN','VIEWS','PORTFOLIOS','GROUPS','REPORT','PROJECTION','PERFORMANCE','INCEPTION','COMPLETE']);
  assert.equal(new Set(RATIO_PROBE_CODES).size,RATIO_PROBE_CODES.length);
  const facts=ratioReportShapeFacts({holdings:[null,{value:'9',limited:true}],cash_accounts:'none',value:1.001});
  assert.deepEqual([facts.anomalies.holdingsNotUnlimited,facts.anomalies.holdingValuesNotNumeric,facts.anomalies.reportValueBeyondCents,facts.hasCash,facts.grouping],[2,2,1,false,'OTHER']);
  assert.deepEqual(ratioReportShapeFacts(undefined).report.holdings,'absent');
  const source=fs.readFileSync(new URL('./fee-ratio-source-probe.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/writeFile|appendFile|createWriteStream|child_process|method:'(?:PUT|PATCH|DELETE)'|gist\.github|storage\.googleapis/);
  assert.equal((source.match(/method:'POST'/g)||[]).length,1,'the token exchange is the only POST');
  // The probe is one step of the existing read-only source-probe job: the
  // Workload Identity provider admits no other workflow file, and no input,
  // job or run title is added, so production run classification is unchanged.
  assert.equal(fs.existsSync(new URL('../.github/workflows/fee-ratio-source-probe.yml',import.meta.url)),false);
  const workflow=fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml',import.meta.url),'utf8');
  assert.deepEqual(RATIO_PROBE_INPUTS,['source_probe_once','source_probe_main','source_probe_target']);
  assert.doesNotMatch(workflow,/ratio_probe|ratio-source-probe:/);
  const jobs=[...workflow.matchAll(/^  ([a-z][a-z-]*):\n([\s\S]*?)(?=^  [a-z][a-z-]*:\n|(?![\s\S]))/gm)].filter(([,n])=>!['schedule','workflow_dispatch'].includes(n));
  assert.equal(jobs.length,11);
  assert.deepEqual(jobs.filter(([,,b])=>b.includes('fee-ratio-source-probe.mjs')).map(([,n])=>n),['source-probe']);
  const job=jobs.find(([,n])=>n==='source-probe')[2],steps=job.split(/\n      - /).slice(1);
  const step=steps.filter(s=>s.includes('fee-ratio-source-probe.mjs'));
  assert.equal(step.length,1);assert.equal(steps.indexOf(step[0]),steps.length-1,'after the credentials and the fee probe');
  assert.match(step[0],/^name: Probe the fixed ratio classification routes with the same pair and nothing else\n/);
  assert.match(step[0],/\n        if: \$\{\{ !cancelled\(\) && steps\.probe_credentials\.outcome == 'success' \}\}\n/);
  assert.deepEqual([...step[0].matchAll(/^          ([A-Z_]+):/gm)].map(m=>m[1]),['PROBE_MAIN','PROBE_TARGET','FEE_CLOUD_SHARESIGHT_CLIENT_ID','FEE_CLOUD_SHARESIGHT_CLIENT_SECRET','GOOGLE_APPLICATION_CREDENTIALS','CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE','GOOGLE_GHA_CREDS_PATH']);
  assert.doesNotMatch(step[0],/github\.token|secrets\.|FEE_REPORT_ACTIONS_TOKEN|FEE_DATA_KEY|uses:|continue-on-error/);
  assert.ok(step[0].endsWith('run: test "$(git rev-parse HEAD)" = "$PROBE_MAIN" && node scripts/fee-ratio-source-probe.mjs --expected-main="$PROBE_MAIN" --target="$PROBE_TARGET"\n'));
  assert.match(job,/github\.actor_id == '283054367'/);assert.match(job,/github\.ref == 'refs\/heads\/main'/);assert.match(job,/github\.run_attempt == 1/);
  assert.equal(crypto.createHash('sha256').update('x').digest('hex').length,64);
});
