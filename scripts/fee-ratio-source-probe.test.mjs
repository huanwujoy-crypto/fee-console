// Synthetic identifiers, names, amounts and credentials only. Every request
// below is answered by an in-memory stub; the real network is never reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {runRatioSourceProbe,ratioProbeArgs,validateRatioProbeAdmission,ratioReportShapeFacts,RATIO_PROBE_CODES,RATIO_PROBE_BUDGET,RATIO_PROBE_STAGES,RATIO_PROBE_VIEW,RATIO_PROBE_GROUP,RATIO_PROBE_INPUTS} from './fee-ratio-source-probe.mjs';
globalThis.fetch=async()=>{throw Error('OFFLINE_TEST_NETWORK_FORBIDDEN');};

const MAIN='a'.repeat(40),TARGET='2026-11-10',NOW=new Date('2026-11-11T02:00:00.000Z'),API='https://api.sharesight.com';
const SECRET='synthetic-client-secret-not-real',CLIENT='synthetic-client-id-not-real',TOKEN='synthetic-access-token-not-real-0123456789';
const env=(extra={})=>({GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'huanwujoy-crypto/fee-console',GITHUB_REF:'refs/heads/main',GITHUB_SHA:MAIN,GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_ACTOR_ID:'283054367',GITHUB_RUN_ATTEMPT:'1',FEE_CLOUD_SHARESIGHT_CLIENT_ID:CLIENT,FEE_CLOUD_SHARESIGHT_CLIENT_SECRET:SECRET,...extra});
const event=(inputs={})=>({sender:{id:283054367},repository:{full_name:'huanwujoy-crypto/fee-console'},inputs:{ratio_probe_main:MAIN,ratio_probe_target:TARGET,...inputs}});
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
function routes(edit=()=>{}){
  const r=new Map([
    [API+'/oauth2/token',{access_token:TOKEN,token_type:'Bearer'}],
    [API+'/api/v3/portfolios?consolidated=true',{portfolios:[{id:39,name:RATIO_PROBE_VIEW,consolidated:true,currency_code:'USD',portfolio_ids:accounts.map(a=>a.id)},{id:40,name:'Invented other view',consolidated:true,currency_code:'USD'}]}],
    [API+'/api/v2/portfolios.json',{portfolios:[...accounts,{id:777,name:'Invented outsider'}]}],
    [API+'/api/v2/groups.json',{groups:[{id:88,name:RATIO_PROBE_GROUP},{id:89,name:'Invented other group'}]}],
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

test('complete synthetic read makes exactly five fixed GET-only requests and reports value-free facts',async()=>{
  const {result,calls}=await run(routes());
  assert.equal(result.outcome,'REPORT_PROJECTED');assert.equal(result.stage,'COMPLETE');assert.equal(result.code,null);assert.equal(result.requests,5);
  assert.deepEqual(calls.map(c=>[c.method,c.url]),[['POST',API+'/oauth2/token'],['GET',API+'/api/v3/portfolios?consolidated=true'],['GET',API+'/api/v2/portfolios.json'],['GET',API+'/api/v2/groups.json'],['GET',REPORT_URL]]);
  assert.equal(calls[0].auth,null);assert.equal(calls.slice(1).every(c=>c.auth==='Bearer '+TOKEN&&c.body===null),true);assert.equal(calls.every(c=>c.redirect==='error'),true);
  const f=result.facts;
  assert.deepEqual([f.consolidatedViewMatches,f.groupMatches,f.viewCurrencyIsUsd,f.viewDeclaresMembers,f.membersSource,f.memberCountIsTen,f.everyMemberListed,f.observedWithinMembers,f.rootHasOnlyKnownKeys],[1,1,true,true,'view',true,true,true,true]);
  assert.equal(f.scopeMatchesReviewedTen,false);
  assert.deepEqual(f.projection,{responseGrouping:'custom_group_category',reportTotalEqualsRows:true,membersWithoutRows:2,categoriesWithinKnownFour:true});
  assert.equal(Object.values(f.shape.anomalies).every(n=>n===0),true);
  assert.equal(f.shape.holding.value,'number');assert.equal(f.shape.instrument.market_code,'string');assert.equal(f.shape.report.combined_holdings,'absent');
  leakFree(result);
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

test('admission accepts only the exact owner dispatch, main, first attempt, two inputs and a recent date',async()=>{
  const args=ratioProbeArgs(argv);validateRatioProbeAdmission({args,env:env(),event:event(),now:NOW});
  for(const bad of [[],['--target='+TARGET],[...argv,'--force'],['--expected-main=main','--target='+TARGET],[...argv,'--target='+TARGET],['--expected-main='+MAIN,'--target=2026-02-30']])assert.throws(()=>ratioProbeArgs(bad),{message:'RATIO_PROBE_ARGUMENT'});
  for(const e of [{GITHUB_REF:'refs/heads/other'},{GITHUB_SHA:'b'.repeat(40)},{GITHUB_ACTOR_ID:'1'},{GITHUB_RUN_ATTEMPT:'2'},{GITHUB_EVENT_NAME:'schedule'},{GITHUB_REPOSITORY:'someone/fork'},{FEE_DATA_KEY:'x'},{FEE_RATIO_MANAGER_TOKEN:'x'},{RATIO_PLAN:'{}'},{GITHUB_TOKEN:'x'},{GOOGLE_APPLICATION_CREDENTIALS:'/tmp/x'},{FEE_CLOUD_SHARESIGHT_CLIENT_SECRET:''}])
    assert.throws(()=>validateRatioProbeAdmission({args,env:env(e),event:event(),now:NOW}),{message:'RATIO_PROBE_ENVIRONMENT'},JSON.stringify(Object.keys(e)));
  for(const i of [{ratio_probe_main:'b'.repeat(40)},{ratio_probe_target:'2026-11-09'},{ratio_plan:''},{source_probe_once:'true'}])assert.throws(()=>validateRatioProbeAdmission({args,env:env(),event:event(i),now:NOW}),{message:'RATIO_PROBE_EVENT'});
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
  assert.deepEqual(RATIO_PROBE_BUDGET,{requests:5,overallMs:120000,requestMs:30000,reportBytes:8388608});
  assert.deepEqual(RATIO_PROBE_STAGES,['ADMISSION','TOKEN','VIEWS','PORTFOLIOS','GROUPS','REPORT','PROJECTION','COMPLETE']);
  assert.equal(new Set(RATIO_PROBE_CODES).size,RATIO_PROBE_CODES.length);
  const facts=ratioReportShapeFacts({holdings:[null,{value:'9',limited:true}],cash_accounts:'none',value:1.001});
  assert.deepEqual([facts.anomalies.holdingsNotUnlimited,facts.anomalies.holdingValuesNotNumeric,facts.anomalies.reportValueBeyondCents,facts.hasCash,facts.grouping],[2,2,1,false,'OTHER']);
  assert.deepEqual(ratioReportShapeFacts(undefined).report.holdings,'absent');
  const source=fs.readFileSync(new URL('./fee-ratio-source-probe.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/writeFile|appendFile|createWriteStream|child_process|method:'(?:PUT|PATCH|DELETE)'|gist\.github|storage\.googleapis/);
  assert.equal((source.match(/method:'POST'/g)||[]).length,1,'the token exchange is the only POST');
  const workflow=fs.readFileSync(new URL('../.github/workflows/fee-ratio-source-probe.yml',import.meta.url),'utf8');
  assert.match(workflow,/^on:\n  workflow_dispatch:\n/m);assert.doesNotMatch(workflow,/schedule:|pull_request|push:|workflow_run|contents: write|FEE_DATA_KEY|FEE_RATIO_MANAGER_TOKEN|FEE_ECON|upload-artifact|devstorage/);
  for(const input of RATIO_PROBE_INPUTS)assert.ok(workflow.includes('      '+input+':'),input);
  assert.match(workflow,/github\.actor_id == '283054367'/);assert.match(workflow,/github\.ref == 'refs\/heads\/main'/);assert.match(workflow,/github\.run_attempt == 1/);
  assert.equal((workflow.match(/uses: /g)||[]).every?.call(workflow.match(/uses: [^\n]+/g),u=>/@[a-f0-9]{40}$/.test(u)),true,'every action is pinned to a full commit');
  assert.equal(crypto.createHash('sha256').update('x').digest('hex').length,64);
});
