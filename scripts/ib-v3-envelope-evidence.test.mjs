// Synthetic only: no real account, credential, network or file write.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ENVELOPE_EVIDENCE_SCOPE,ENVELOPE_ROUTES,ENVELOPE_STEPS,ENVELOPE_MAX_REQUESTS,ENVELOPE_CATEGORIES,ENVELOPE_CHANGES,ENVELOPE_TYPES,
  parseEnvelopeJson,compareEnvelopeBodies,isEnvelopeRouteEvidence,readEnvelopeEvidence,envelopeEvidenceTransport,
  envelopeEvidenceArgs,validateEnvelopeEvidenceEvent,envelopeEvidenceFailure,inspectEnvelopeEvidence,ENVELOPE_TRANSPORT_REFUSALS} from './ib-v3-envelope-evidence.mjs';
import {authorizeEnvelopeEvidence,RECOVERY_METADATA_STAGES,RECOVERY_METADATA_REQUESTS,RECOVERY_METADATA_CATEGORIES,reportHistoricalRecoveryManifest} from './fee-report-producer.mjs';
import {REVISION_DIAGNOSTIC_SCOPE,validateRevisionDiagnosticEvent} from './fee-source-revision-diagnostic.mjs';
import {IB_REVISION_ARTIFACT_SCOPE} from './fee-sync-revision-artifacts.mjs';
import {ratioAdmission,RATIO_OWNER} from './fee-ratio-cloud-runtime.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),MAIN='a'.repeat(40),PID=4242;
const route=label=>ENVELOPE_ROUTES.find(r=>r.label===label);
const evidence=(label,a,b)=>compareEnvelopeBodies(route(label),typeof a==='string'?a:JSON.stringify(a),typeof b==='string'?b:JSON.stringify(b));
const cat=(r,name)=>r.categories.find(c=>c.category===name);
const changed=r=>r.categories.filter(c=>c.changes.length).map(c=>c.category+':'+c.changes.join('+'));

// ---- the plan is the reader's own window, order and query text
test('plan is exactly the reader v3 window for checkpoint 11-04 -> target 11-06, at most 14 requests',()=>{
  assert.deepEqual(ENVELOPE_ROUTES.map(r=>r.label),['HOLDINGS_CATALOG','PERFORMANCE_ANCHOR','PERFORMANCE_PREVIOUS','PERFORMANCE_TARGET','TRADES_WINDOW']);
  assert.deepEqual(ENVELOPE_STEPS,['TOKEN','PORTFOLIOS',...ENVELOPE_ROUTES.map(r=>r.label)]);
  assert.equal(ENVELOPE_MAX_REQUESTS,14);assert.equal(ENVELOPE_EVIDENCE_SCOPE.rounds,2);
  assert.equal(ENVELOPE_EVIDENCE_SCOPE.anchorDate,REVISION_DIAGNOSTIC_SCOPE.anchorDate);assert.equal(ENVELOPE_EVIDENCE_SCOPE.targetDate,REVISION_DIAGNOSTIC_SCOPE.targetDate);
  assert.equal(ENVELOPE_EVIDENCE_SCOPE.previousDate,REVISION_DIAGNOSTIC_SCOPE.previousDate);assert.equal(IB_REVISION_ARTIFACT_SCOPE.anchorDate,'2026-11-04');
  for(const [label,d] of [['PERFORMANCE_ANCHOR','2026-11-04'],['PERFORMANCE_PREVIOUS','2026-11-05'],['PERFORMANCE_TARGET','2026-11-06']]){
    const q=new URLSearchParams({consolidated:'false',end_date:d,grouping:'investment_type',include_limited:'false',include_sales:'false',report_combined:'false',start_date:d});
    assert.equal(route(label).query,q.toString());assert.equal(route(label).path,'performance');
  }
  assert.equal(route('HOLDINGS_CATALOG').path+'?'+route('HOLDINGS_CATALOG').query,'holdings?consolidated=false');
  assert.equal(route('TRADES_WINDOW').path+'?'+route('TRADES_WINDOW').query,'trades.json?consolidated=false&end_date=2026-11-06&start_date=2026-11-05');
  // Bound to the reader's own source text: a reader change must revisit this plan.
  const reader=fs.readFileSync(path.join(ROOT,'scripts/ib-manager-source.mjs'),'utf8');
  for(const literal of ["await this.#json(base+'/holdings?consolidated=false',token)",
    "const query=new URLSearchParams({consolidated:'false',end_date:d,grouping:'investment_type',include_limited:'false',include_sales:'false',report_combined:'false',start_date:d});",
    "await this.#json(base+'/performance?'+query,token)","for(let d=anchor;d<=targetDate;d=add(d,1)){",
    "await this.#json(base+'/trades.json?consolidated=false&end_date='+targetDate+'&start_date='+from,token)",
    "const from=prior?(targetDate===prior.sourceAsOf?targetDate:add(prior.sourceAsOf,1))","const anchor=add(from,-1),count=inclusiveDays(anchor,targetDate);"])
    assert(reader.includes(literal),literal);
  assert(reader.indexOf('/holdings?consolidated=false')<reader.indexOf("'/performance?'")&&reader.indexOf("'/performance?'")<reader.indexOf('/trades.json?consolidated=false'));
});

// ---- strict tree
test('strict JSON tree keeps order, duplicates and number spelling and refuses malformed input',()=>{
  const t=parseEnvelopeJson('{"b":1.0,"a":[true,null,"x"],"b":2}');
  assert.deepEqual(t.m.map(([k])=>k),['b','a','b']);assert.equal(t.m[0][1].v,'1.0');
  for(const bad of ['{"a":1}x','{a:1}','[1,]','{"a":01}','"\u0001"','','{"a":1','[1 2]','tru'])assert.throws(()=>parseEnvelopeJson(bad),/FEE_ENVELOPE_EVIDENCE_PARSE/);
  assert.throws(()=>parseEnvelopeJson('['.repeat(70)+']'.repeat(70)),/PARSE/);
});

// ---- classification: positive cases, every one classified, never ignored
const catalog=(extra={},row={})=>({holdings:[{id:11,portfolio:{id:PID,name:'IB-HK'},valid_position:true,quantity:3,value:10.5,instrument_currency:{code:'USD'},
  instrument:{id:7,code:'ABC',market_code:'NASDAQ',currency_code:'USD'},links:{self:'https://example.invalid/h/11'},...row},
  {id:12,portfolio:{id:PID,name:'IB-HK'},valid_position:true,quantity:1,value:2,instrument:{id:8,code:'DEF',market_code:'NYSE',currency_code:'USD'}}],
  api_transaction:{id:1001,timestamp:'2026-11-08T01:00:00Z'},links:{self:'https://example.invalid/holdings'},...extra});
const report=(extra={},h={})=>({report:{portfolio_id:PID,start_date:'2026-11-05',end_date:'2026-11-05',value:100,currency:{code:'USD'},
  holdings:[{id:11,quantity:3,value:50,instrument_currency:{code:'USD'},portfolio:{id:PID,name:'IB-HK'},instrument:{id:7,code:'ABC'},...h}],cash_accounts:[{id:5,value:50}]},
  api_transaction:{id:2001,timestamp:'2026-11-08T01:00:01Z'},...extra});
test('the synthetic per-request api_transaction id is classified as exactly that preset path',()=>{
  const r=evidence('HOLDINGS_CATALOG',catalog(),catalog({api_transaction:{id:1002,timestamp:'2026-11-08T01:00:00Z'}}));
  assert.deepEqual(changed(r),['ROOT_API_TRANSACTION_ID:VALUE']);assert.equal(r.bytes,'DIFF');assert.equal(r.structure,'DIFF');
  assert.deepEqual(cat(r,'ROOT_API_TRANSACTION_ID').types,['number']);
  const p=evidence('PERFORMANCE_TARGET',report(),report({api_transaction:{id:2002,timestamp:'2026-11-08T01:00:09Z'}}));
  assert.deepEqual(changed(p),['ROOT_API_TRANSACTION_ID:VALUE','ROOT_API_TRANSACTION_TIMESTAMP:VALUE']);
});
test('competing explanations are told apart, not merged',()=>{
  const cases=[
    [catalog({links:{self:'https://example.invalid/holdings?t=2'}}),['ROOT_LINKS_SELF:VALUE']],
    [catalog({links:{self:'https://example.invalid/holdings',next:'n'}}),['ROOT_LINKS_OTHER:ADDED']],
    [catalog({},{links:{self:'https://example.invalid/h/11?t=2'}}),['BODY_LINKS:VALUE']],
    [catalog({api_transaction:{id:1001,timestamp:'2026-11-08T01:00:00Z',trace:'x'}}),['ROOT_API_TRANSACTION_OTHER:ADDED']],
    [catalog({api_transaction:'1001'}),['ROOT_API_TRANSACTION:TYPE','ROOT_API_TRANSACTION_ID:REMOVED','ROOT_API_TRANSACTION_TIMESTAMP:REMOVED']],
    [catalog({request_id:'r'}),['ROOT_OTHER:ADDED']],
    [catalog({pagination:{next_page:null}}),['ROOT_PAGING:ADDED']],
    [catalog({},{api_transaction:{id:9}}),['BODY_API_TRANSACTION:ADDED']],
    [catalog({},{fresh_member:1}),['BODY_OTHER:ADDED']],
    [catalog({},{updated_at:'2026-11-08T00:00:00Z'}),['BODY_TIMESTAMP:ADDED']],
  ];
  for(const [b,expected] of cases)assert.deepEqual(changed(evidence('HOLDINGS_CATALOG',catalog(),b)),expected,JSON.stringify(expected));
});
test('real business members are classified, never ignored; catalog-only members keep their own category',()=>{
  assert.deepEqual(changed(evidence('HOLDINGS_CATALOG',catalog(),catalog({},{quantity:4}))),['BODY_CATALOG_UNCONSUMED:VALUE']);
  assert.deepEqual(changed(evidence('HOLDINGS_CATALOG',catalog(),catalog({},{instrument_currency:{code:'HKD'}}))),['BODY_CATALOG_UNCONSUMED:VALUE']);
  assert.deepEqual(changed(evidence('HOLDINGS_CATALOG',catalog(),catalog({},{valid_position:false}))),['BODY_STATE:VALUE']);
  assert.deepEqual(changed(evidence('HOLDINGS_CATALOG',catalog(),catalog({},{instrument:{id:7,code:'ABD',market_code:'NASDAQ',currency_code:'USD'}}))),['BODY_INSTRUMENT:VALUE']);
  assert.deepEqual(changed(evidence('PERFORMANCE_TARGET',report(),report({},{quantity:4}))),['BODY_QUANTITY:VALUE']);
  assert.deepEqual(changed(evidence('PERFORMANCE_TARGET',report(),report({},{value:51}))),['BODY_AMOUNT:VALUE']);
  assert.deepEqual(changed(evidence('PERFORMANCE_TARGET',report(),report({},{instrument_currency:{code:'HKD'}}))),['BODY_CURRENCY:VALUE']);
  assert.deepEqual(changed(evidence('PERFORMANCE_TARGET',report(),report({},{portfolio:{id:PID,name:'X'}}))),['BODY_PORTFOLIO:VALUE']);
  const date=report();date.report.end_date='2026-11-06';assert.deepEqual(changed(evidence('PERFORMANCE_TARGET',report(),date)),['BODY_DATE:VALUE']);
  assert.deepEqual(changed(evidence('PERFORMANCE_TARGET','{"report":{"value":100.0}}','{"report":{"value":100.00}}')),['BODY_AMOUNT:VALUE']);
  assert.deepEqual(changed(evidence('PERFORMANCE_TARGET','{"report":{"value":100}}','{"report":{"value":"100"}}')),['BODY_AMOUNT:TYPE']);
  const trade={trades:[{id:1,holding_id:11,transaction_date:'2026-11-05',description_code:'BUY',quantity:1,value:5,state:'confirmed'}]};
  const moved=structuredClone(trade);moved.trades[0].description_code='SELL';moved.trades[0].holding_id=12;
  assert.deepEqual(changed(evidence('TRADES_WINDOW',trade,moved)),['BODY_ID:VALUE','BODY_KIND:VALUE']);
});
test('row sets, row order, member order, duplicates and type changes are distinct natures',()=>{
  const swapped=catalog();swapped.holdings.reverse();
  assert.deepEqual(changed(evidence('HOLDINGS_CATALOG',catalog(),swapped)),['BODY_ROWSET:ORDER']);
  const fewer=catalog();fewer.holdings.pop();
  assert.deepEqual(changed(evidence('HOLDINGS_CATALOG',catalog(),fewer)).filter(x=>x.startsWith('BODY_ROWSET')),['BODY_ROWSET:REMOVED']);
  assert.deepEqual(changed(evidence('HOLDINGS_CATALOG',fewer,catalog())).filter(x=>x.startsWith('BODY_ROWSET')),['BODY_ROWSET:ADDED']);
  assert.deepEqual(changed(evidence('TRADES_WINDOW','{"trades":[],"a":1,"b":2}','{"trades":[],"b":2,"a":1}')),['ROOT:MEMBER_ORDER']);
  assert.deepEqual(changed(evidence('TRADES_WINDOW','{"trades":[]}','{"trades":[],"trades":[]}')),['ROOT:DUPLICATE_MEMBER']);
  const unkeyed=evidence('TRADES_WINDOW','{"trades":[{"x":1},{"x":2}]}','{"trades":[{"x":2},{"x":1}]}');
  assert.deepEqual(unkeyed.arrayKeying,['POSITION']);assert.deepEqual(changed(unkeyed),['BODY_OTHER:VALUE']);
  assert.deepEqual(evidence('HOLDINGS_CATALOG',catalog(),swapped).arrayKeying,['ID']);
  assert.deepEqual(changed(evidence('TRADES_WINDOW','[]','{"trades":[]}')),['ROOT:TYPE','BODY:ADDED']);
});
test('identical and whitespace-only bodies show no structural change',()=>{
  const text=JSON.stringify(catalog()),same=evidence('HOLDINGS_CATALOG',text,text);
  assert.equal(same.bytes,'SAME');assert.equal(same.structure,'SAME');assert.deepEqual(changed(same),[]);
  const spaced=evidence('HOLDINGS_CATALOG',text,JSON.stringify(catalog(),null,2));
  assert.equal(spaced.bytes,'DIFF');assert.equal(spaced.structure,'SAME');assert.deepEqual(changed(spaced),[]);
  assert(same.categories.some(c=>c.category==='ROOT_API_TRANSACTION_ID'),'presence of a preset path is visible even when unchanged');
});
test('evidence carries literals only: no value, id, key name, count, position, URL or hash',()=>{
  const canary={holdings:[{id:987654321,portfolio:{id:5550001,name:'CANARY_PORTFOLIO'},canary_private_key:'CANARY_TEXT',value:123456.78,
    links:{self:'https://canary.invalid/CANARY_URL'}}],api_transaction:{id:31415926,timestamp:'2026-11-08T09:09:09Z',canary_member:'CANARY_TX'},
    canary_root_key:{deep:['CANARY_ARRAY',4242]}};
  const other=structuredClone(canary);other.api_transaction.id=27182818;other.holdings[0].value=654321.12;other.holdings[0].canary_private_key='CANARY_OTHER';
  other.canary_root_key.deep.push('CANARY_MORE');other.holdings.push({id:111222333,canary_new_row:'CANARY_ROW'});
  const routes=ENVELOPE_ROUTES.map(r=>compareEnvelopeBodies(r,JSON.stringify(canary),JSON.stringify(other)));
  assert.equal(isEnvelopeRouteEvidence(routes),true);
  const text=JSON.stringify(routes);
  assert.doesNotMatch(text,/\d/);assert.doesNotMatch(text,/canary|https?:|987654321|31415926|123456/i);assert.doesNotMatch(text,/portfolio|deep|holdings|api_transaction|links|value|quantity/);
  const strings=[];JSON.parse(text,(k,v)=>{if(typeof v==='string')strings.push(v);if(k)strings.push(k);return v;});
  const allowed=new Set([...ENVELOPE_CATEGORIES,...ENVELOPE_CHANGES,...ENVELOPE_TYPES,'ID','POSITION','SAME','DIFF',...ENVELOPE_ROUTES.map(r=>r.label),
    'route','bytes','structure','arrayKeying','categories','category','types','changes']);
  assert.deepEqual(strings.filter(s=>!/^\d+$/.test(s)&&!allowed.has(s)),[]);
  // A forged or widened evidence object is refused.
  for(const forge of [r=>r[0].categories.push({category:'canary_key',types:['string'],changes:[]}),r=>r[0].route='OTHER',r=>r[0].categories[0].types.push('bigint'),
    r=>r[0].extra=1,r=>r.pop(),r=>r[0].categories[0].changes.push('VALUE','VALUE'),r=>{r[0].structure='SAME';}])
  {const copy=JSON.parse(text);forge(copy);assert.equal(isEnvelopeRouteEvidence(copy),false);}
});

// ---- the network sequence, synthetic transport only
const response=(url,body,{status=200,type='application/json',redirected=false,responseUrl=url}={})=>{
  const r=new Response(typeof body==='string'?body:JSON.stringify(body),{status,headers:{'content-type':type}});
  Object.defineProperty(r,'url',{value:responseUrl});Object.defineProperty(r,'redirected',{value:redirected});return r;
};
function source({identity=()=>PID,body=(label,round)=>label==='HOLDINGS_CATALOG'?catalog({api_transaction:{id:round+1,timestamp:'t'}}):label==='TRADES_WINDOW'?{trades:[],api_transaction:{id:round+7}}:report({api_transaction:{id:round+3}}),hook=()=>null}={}){
  const calls=[];let round=-1;
  const fetchImpl=async(url,init)=>{
    calls.push({url,method:init.method,auth:init.headers?.Authorization||null,body:init.body??null,redirect:init.redirect});
    const special=hook(url,init,calls.length);if(special)return special;
    if(url==='https://api.sharesight.com/oauth2/token'){round++;return response(url,{access_token:'synthetic_access_token_'+round+'_abcdefgh',token_type:'Bearer'});}
    if(url==='https://api.sharesight.com/api/v2/portfolios.json')return response(url,{portfolios:[{id:identity(round),name:'IB-HK',currency_code:'USD'},{id:9,name:'OTHER',currency_code:'USD'}]});
    const r=ENVELOPE_ROUTES.find(r=>url==='https://api.sharesight.com/api/v3/portfolios/'+identity(round)+'/'+r.path+'?'+r.query);
    if(!r)throw Error('unplanned request '+url);
    return response(url,body(r.label,round));
  };
  return {calls,fetchImpl};
}
const creds={clientId:'synthetic-client-id',clientSecret:'synthetic-client-secret'};
test('exact sequence: two rounds of token, identity and five v3 GETs, nothing else',async()=>{
  const s=source(),seen=[];const result=await readEnvelopeEvidence({...creds,fetchImpl:s.fetchImpl,beforeRound:async n=>seen.push('round'+n),afterRead:async()=>seen.push('after')});
  assert.equal(result.requestsUsed,14);assert.deepEqual(seen,['round0','round1','after']);
  const expected=[0,1].flatMap(n=>['https://api.sharesight.com/oauth2/token','https://api.sharesight.com/api/v2/portfolios.json',
    ...ENVELOPE_ROUTES.map(r=>'https://api.sharesight.com/api/v3/portfolios/'+PID+'/'+r.path+'?'+r.query)]);
  assert.deepEqual(s.calls.map(c=>c.url),expected);
  assert.deepEqual(s.calls.map(c=>c.method),expected.map(u=>u.endsWith('/oauth2/token')?'POST':'GET'));
  assert(s.calls.every(c=>c.redirect==='error'));
  assert(s.calls.filter(c=>c.method==='GET').every((c,n)=>c.auth==='Bearer synthetic_access_token_'+(n<6?0:1)+'_abcdefgh'));
  assert(s.calls.filter(c=>c.method==='POST').every(c=>c.auth===null&&new URLSearchParams(c.body).get('grant_type')==='client_credentials'));
  assert(!s.calls.some(c=>/cash_account|payout|\/api\/v2\/portfolios\/\d/.test(c.url)),'no v2 cash, payout or other-account route');
  assert.deepEqual(result.routes.map(r=>changed(r)),[['ROOT_API_TRANSACTION_ID:VALUE'],['ROOT_API_TRANSACTION_ID:VALUE'],['ROOT_API_TRANSACTION_ID:VALUE'],['ROOT_API_TRANSACTION_ID:VALUE'],['ROOT_API_TRANSACTION_ID:VALUE']]);
});
test('a pagination hint is classified and never followed',async()=>{
  const s=source({body:(label,round)=>({trades:[],links:{next:'https://api.sharesight.com/api/v3/next?page='+(round+2)}})});
  const result=await readEnvelopeEvidence({...creds,fetchImpl:s.fetchImpl});
  assert.equal(s.calls.length,14);assert.deepEqual(changed(result.routes[4]),['ROOT_LINKS_OTHER:VALUE']);
});
test('any refusal stops at once with a fixed code and step: no retry, no partial evidence',async()=>{
  const run=async options=>{const s=source(options);let error;try{await readEnvelopeEvidence({...creds,fetchImpl:s.fetchImpl});}catch(e){error=e;}return {s,f:envelopeEvidenceFailure(error)};};
  let r=await run({hook:(url,init,n)=>n===12?response(url,'{}',{status:500}):null});
  assert.deepEqual(r.f,{reasonCode:'FEE_ENVELOPE_EVIDENCE_READ',failedStep:'PERFORMANCE_PREVIOUS',readCode:'HTTP'});assert.equal(r.s.calls.length,12);
  r=await run({hook:(url,init,n)=>n===3?response(url,'{}',{redirected:true}):null});assert.deepEqual(r.f,{reasonCode:'FEE_ENVELOPE_EVIDENCE_READ',failedStep:'HOLDINGS_CATALOG',readCode:'HTTP'});assert.equal(r.s.calls.length,3);
  r=await run({hook:(url,init,n)=>n===3?response(url,'<html/>',{type:'text/html'}):null});assert.deepEqual(r.f,{reasonCode:'FEE_ENVELOPE_EVIDENCE_READ',failedStep:'HOLDINGS_CATALOG',readCode:'TYPE'});
  r=await run({hook:(url,init,n)=>n===4?(()=>{throw Error('private-canary');})():null});assert.deepEqual(r.f,{reasonCode:'FEE_ENVELOPE_EVIDENCE_READ',failedStep:'PERFORMANCE_ANCHOR',readCode:'NETWORK'});
  r=await run({identity:n=>n===1?PID+1:PID,hook:(url)=>url.includes('/portfolios/'+(PID+1)+'/')?assert.fail('stops before the changed identity is used'):null});
  assert.deepEqual(r.f,{reasonCode:'FEE_ENVELOPE_EVIDENCE_IDENTITY_CHANGED',failedStep:'PORTFOLIOS'});assert.equal(r.s.calls.length,9);
  r=await run({hook:(url,init,n)=>n===2?response(url,{portfolios:[{id:PID,name:'IB-HK',currency_code:'USD'},{id:PID+1,name:'IB-HK',currency_code:'USD'}]}):null});
  assert.deepEqual(r.f,{reasonCode:'FEE_ENVELOPE_EVIDENCE_IDENTITY',failedStep:'PORTFOLIOS'});
  r=await run({hook:(url,init,n)=>n===1?response(url,{access_token:'short',token_type:'Bearer'}):null});assert.deepEqual(r.f,{reasonCode:'FEE_ENVELOPE_EVIDENCE_AUTH',failedStep:'TOKEN'});
  r=await run({body:()=>({trades:[],echo:'synthetic-client-secret'})});assert.deepEqual(r.f,{reasonCode:'FEE_ENVELOPE_EVIDENCE_SCOPE',failedStep:'HOLDINGS_CATALOG'});
  r=await run({body:()=>'{"trades":[1,]}'});assert.deepEqual(r.f,{reasonCode:'FEE_ENVELOPE_EVIDENCE_READ',failedStep:'HOLDINGS_CATALOG',readCode:'JSON'});
  for(const x of Object.values(r.f))assert.doesNotMatch(String(x),/canary|synthetic|https?:|\d{3}/i);
  await assert.rejects(readEnvelopeEvidence({clientId:'',clientSecret:'x',fetchImpl:()=>assert.fail('no request without credentials')}),/ENVIRONMENT/);
});
test('the outer transport admits only the planned hosts, methods and routes',async()=>{
  const seen=[],ok=async(url,init)=>{seen.push([url,init.method,init.redirect]);return response(url,{});};
  const t=envelopeEvidenceTransport({fetchImpl:ok});
  try{
    const allowed=[['https://api.sharesight.com/oauth2/token','POST'],['https://api.sharesight.com/api/v2/portfolios.json','GET'],
      ...ENVELOPE_ROUTES.map(r=>['https://api.sharesight.com/api/v3/portfolios/'+PID+'/'+r.path+'?'+r.query,'GET']),
      ['https://api.github.com/repos/huanwujoy-crypto/fee-console/git/ref/heads/main','GET'],['https://api.github.com/repos/huanwujoy-crypto/fee-console/actions/runs/123456789','GET']];
    for(const [url,method] of allowed)await t.fetch(url,{method,...(method==='POST'?{body:'x'}:{})});
    assert.equal(seen.length,allowed.length);assert(seen.every(x=>x[2]==='error'));
    const refused=[['https://api.sharesight.com/api/v2/portfolios/'+PID+'/cash_accounts.json?date=2026-11-06'],['https://api.sharesight.com/api/v2/cash_accounts/5/cash_account_transactions.json?from=2026-11-05&to=2026-11-06'],
      ['https://api.sharesight.com/api/v2/payouts/9.json'],['https://api.sharesight.com/api/v3/portfolios/'+PID+'/performance?'+route('PERFORMANCE_TARGET').query.replaceAll('2026-11-06','2026-11-07')],
      ['https://api.sharesight.com/api/v3/portfolios/'+PID+'/holdings?consolidated=true'],['https://api.sharesight.com/api/v3/portfolios/'+PID+'/trades.json?consolidated=false&end_date=2026-11-06&start_date=2026-11-01'],
      ['https://api.sharesight.com/api/v3/portfolios/'+PID+'/holdings?consolidated=false&page=2'],['https://api.sharesight.com/api/v2/portfolios.json?page=2'],
      ['https://api.sharesight.com/oauth2/token','GET'],['https://api.sharesight.com/api/v2/portfolios.json','POST'],['https://api.sharesight.com:444/api/v2/portfolios.json'],
      ['http://api.sharesight.com/api/v2/portfolios.json'],['https://gist.github.com/x'],['https://api.github.com/gists/'+'a'.repeat(32)],
      ['https://api.github.com/repos/huanwujoy-crypto/fee-console/contents/data.json?ref='+MAIN],['https://api.github.com/repos/huanwujoy-crypto/fee-console/actions/runs?per_page=100'],
      ['https://storage.googleapis.com/x'],['https://api.github.com/repos/huanwujoy-crypto/fee-console/git/ref/heads/main','PATCH']];
    for(const [url,method='GET'] of refused)await assert.rejects(t.fetch(url,{method}),/FEE_ENVELOPE_EVIDENCE_ROUTE/,url+' '+method);
    await assert.rejects(t.fetch('https://api.sharesight.com/api/v2/portfolios.json',{method:'GET',body:'x'}),/ROUTE/);
    assert.equal(seen.length,allowed.length);
  }finally{t.close();}
  let now=0;const late=envelopeEvidenceTransport({fetchImpl:ok,clock:()=>now});now=ENVELOPE_EVIDENCE_SCOPE.durationMs;
  await assert.rejects(late.fetch('https://api.sharesight.com/api/v2/portfolios.json',{method:'GET'}),/EXPIRED/);late.close();
});

// ---- exact owner event, no fee key, economic source or cloud credential path
const env=()=>({GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'huanwujoy-crypto/fee-console',GITHUB_REF:'refs/heads/main',GITHUB_SHA:MAIN,GITHUB_EVENT_NAME:'workflow_dispatch',
  GITHUB_ACTOR_ID:'283054367',GITHUB_ACTOR:'huanwujoy-crypto',GITHUB_RUN_ATTEMPT:'1',GITHUB_RUN_ID:'123456789',FEE_REPORT_ACTIONS_TOKEN:'synthetic_read_token_123456789'});
const off={ib_diagnostic_once:'false',ib_diagnostic_main:'',ratio_main:'',ratio_plan:'',source_plan_check_only:'false',source_acceptance_once:'false',source_from:'',source_target:'',
  source_main:'',run_reviewed_once:'false',manual_sync_completed_for:'',confirmed_main:'',recovery_main:'',report_kind:'',report_target:'',report_markets:''};
const event=()=>({sender:{id:283054367,login:'huanwujoy-crypto',type:'User'},repository:{full_name:'huanwujoy-crypto/fee-console',owner:{id:283054367},default_branch:'main'},
  inputs:{...off,ib_envelope_once:'true',ib_envelope_main:MAIN}});
const runEnv=()=>({...env(),FEE_CLOUD_SHARESIGHT_CLIENT_ID:'synthetic-client',FEE_CLOUD_SHARESIGHT_CLIENT_SECRET:'synthetic-secret',GOOGLE_APPLICATION_CREDENTIALS:'',CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE:'',GOOGLE_GHA_CREDS_PATH:''});
test('the event gate admits only the exact owner dispatch with every other field off',()=>{
  assert.deepEqual(envelopeEvidenceArgs(['--check-plan','--expected-main='+MAIN]),{checkOnly:true,expectedMain:MAIN});
  for(const argv of [[],['--expected-main='+MAIN,'--expected-main='+MAIN],['--expected-main=abc'],['--out=/tmp/x','--expected-main='+MAIN],['--check-plan','--check-plan','--expected-main='+MAIN]])
    assert.throws(()=>envelopeEvidenceArgs(argv),/ARGUMENT/);
  assert.equal(validateEnvelopeEvidenceEvent({env:env(),event:event(),expectedMain:MAIN,checkOnly:true}),true);
  assert.equal(validateEnvelopeEvidenceEvent({env:runEnv(),event:event(),expectedMain:MAIN}),true);
  const minimal={...event(),inputs:{ib_envelope_once:true,ib_envelope_main:MAIN}};assert.equal(validateEnvelopeEvidenceEvent({env:env(),event:minimal,expectedMain:MAIN,checkOnly:true}),true);
  for(const [k,v] of [...Object.keys(off).map(k=>[k,k.endsWith('_once')||k.endsWith('_only')?'true':MAIN]),['ib_envelope_once','false'],['ib_envelope_main','b'.repeat(40)],['unknown_field','']])
    assert.throws(()=>validateEnvelopeEvidenceEvent({env:env(),event:{...event(),inputs:{...event().inputs,[k]:v}},expectedMain:MAIN,checkOnly:true}),/ARGUMENT/,k);
  const envChanges=[e=>e.FEE_DATA_KEY='x',e=>e.FEE_ECON_GIST_ID='x',e=>e.FEE_RATIO_MANAGER_TOKEN='x',e=>e.GITHUB_TOKEN='x',e=>e.IB_MANAGER_BASELINE_SHA256='x',e=>e.NODE_OPTIONS='--require x',
    e=>e.GOOGLE_APPLICATION_CREDENTIALS='/home/runner/gha-creds-1.json',e=>e.GOOGLE_GHA_CREDS_PATH='/x',e=>e.LD_PRELOAD='x',e=>e.GITHUB_RUN_ATTEMPT='2',e=>e.GITHUB_ACTOR_ID='1',
    e=>e.GITHUB_SHA='b'.repeat(40),e=>e.GITHUB_REF='refs/heads/topic',e=>e.GITHUB_EVENT_NAME='schedule',e=>e.FEE_REPORT_ACTIONS_TOKEN='',e=>e.GITHUB_TRIGGERING_ACTOR='someone'];
  for(const change of envChanges){const e=runEnv();change(e);assert.throws(()=>validateEnvelopeEvidenceEvent({env:e,event:event(),expectedMain:MAIN}),/ENVIRONMENT/,String(change));}
  assert.throws(()=>validateEnvelopeEvidenceEvent({env:runEnv(),event:event(),expectedMain:MAIN,checkOnly:true}),/ENVIRONMENT/,'no Sharesight pair before the release gate');
  assert.throws(()=>validateEnvelopeEvidenceEvent({env:env(),event:event(),expectedMain:MAIN}),/ENVIRONMENT/,'run needs the pair');
  assert.throws(()=>validateEnvelopeEvidenceEvent({env:env(),event:event(),expectedMain:MAIN,checkOnly:true,execArgv:['--inspect']}),/ENVIRONMENT/);
  for(const change of [e=>e.sender.id=1,e=>e.sender.type='Bot',e=>e.repository.full_name='other/repo',e=>e.repository.default_branch='dev'])
  {const e=event();change(e);assert.throws(()=>validateEnvelopeEvidenceEvent({env:env(),event:e,expectedMain:MAIN,checkOnly:true}),/ENVIRONMENT/);}
});
test('the other exhaustive dispatch checks accept the envelope fields only while off and blank',()=>{
  const diag=inputs=>validateRevisionDiagnosticEvent({env:env(),event:{...event(),inputs:{ib_diagnostic_once:'true',ib_diagnostic_main:MAIN,...inputs}},expectedMain:MAIN,checkOnly:true});
  assert.equal(diag({ib_envelope_once:'false',ib_envelope_main:''}),true);
  for(const inputs of [{ib_envelope_once:'true'},{ib_envelope_main:MAIN}])assert.throws(()=>diag(inputs),/ARGUMENT/);
  const ratioEnv={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'huanwujoy-crypto/fee-console',GITHUB_ACTOR_ID:String(RATIO_OWNER),GITHUB_SHA:MAIN,RATIO_PLAN:'{'};
  const ratio=inputs=>{try{ratioAdmission(ratioEnv,{sender:{id:RATIO_OWNER},repository:{full_name:'huanwujoy-crypto/fee-console'},inputs:{ratio_main:MAIN,ratio_plan:'{',...inputs}});}catch(e){return e;}};
  // A plan that fails only at parse proves the input-field gate itself passed.
  const parseOnly=ratio({});const offFields=ratio({ib_envelope_once:'false',ib_envelope_main:''});
  assert.equal(String(offFields),String(parseOnly));
  const gate=ratio({unknown_field:''});assert.notEqual(gate,undefined);
  for(const inputs of [{ib_envelope_once:'true'},{ib_envelope_main:MAIN}])assert.equal(String(ratio(inputs)),String(gate));
});

// ---- orchestration: admission before and between rounds, cleanup always
test('orchestration re-proves the admission before each round and after the reads, and always cleans up',async()=>{
  const log=[];const admission={async checkCurrent(){log.push('check');},close(){log.push('close');}};
  const base={authorize:async()=>admission,checkCheckout:()=>log.push('checkout'),cleanup:()=>log.push('cleanup')};
  const plan=await inspectEnvelopeEvidence({...base,checkOnly:true,read:()=>assert.fail('check-plan never reads')});
  assert.equal(plan.status,'plan-verified');assert.deepEqual(log,['checkout','check','checkout','close','cleanup']);
  log.length=0;const s=source();
  const ok=await inspectEnvelopeEvidence({...base,read:hooks=>readEnvelopeEvidence({...creds,fetchImpl:s.fetchImpl,...hooks})});
  assert.equal(ok.status,'verified');assert.equal(ok.requestsUsed,14);assert.equal(ok.stabilityDecisionChanged,false);assert.equal(ok.reportGenerated,false);assert.equal(ok.publicationReady,false);
  assert.deepEqual(log,['checkout','check','checkout','check','checkout','check','checkout','check','checkout','close','cleanup']);
  assert.equal(isEnvelopeRouteEvidence(ok.routes),true);assert.doesNotMatch(JSON.stringify(ok.routes),/\d/);
  const denied=await inspectEnvelopeEvidence({...base,authorize:async()=>{throw new Error('FEE_REPORT_RECOVERY_RELEASE');},read:()=>assert.fail('no read without admission')});
  assert.deepEqual([denied.status,denied.reasonCode],['incomplete','FEE_REPORT_RECOVERY_RELEASE']);
  const opaque=await inspectEnvelopeEvidence({...base,authorize:async()=>{throw new Error('FEE_REPORT_RECOVERY_RELEASE private-canary');},read:()=>assert.fail()});
  assert.equal(opaque.reasonCode,'FEE_ENVELOPE_EVIDENCE_FAILED');assert.doesNotMatch(JSON.stringify(opaque),/canary/);
  let checks=0;const revoked={async checkCurrent(){if(++checks===3)throw new Error('FEE_REPORT_RECOVERY_CONSUMED');},close(){}};
  const s2=source(),stopped=await inspectEnvelopeEvidence({...base,authorize:async()=>revoked,read:hooks=>readEnvelopeEvidence({...creds,fetchImpl:s2.fetchImpl,...hooks})});
  assert.deepEqual([stopped.status,stopped.reasonCode],['incomplete','FEE_REPORT_RECOVERY_CONSUMED']);assert.equal(s2.calls.length,7,'second round never starts');
  const badCleanup=await inspectEnvelopeEvidence({...base,checkOnly:true,cleanup:()=>{throw Error('x');},read:()=>assert.fail()});
  assert.equal(badCleanup.reasonCode,'FEE_ENVELOPE_EVIDENCE_CLEANUP');
  const forged=await inspectEnvelopeEvidence({...base,read:async()=>({routes:[{route:'HOLDINGS_CATALOG',value:123}],requestsUsed:14})});
  assert.equal(forged.reasonCode,'FEE_ENVELOPE_EVIDENCE_RESULT');
});

// ---- executable: refuses before any IO, and is wired into nothing else
test('CLI refuses a wrong or mixed environment before any request and prints only a fixed code',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-envelope-cli-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const trace=path.join(dir,'network-used'),preload=path.join(dir,'mock-only.mjs'),eventPath=path.join(dir,'event.json');
  fs.writeFileSync(preload,`import fs from 'node:fs';globalThis.fetch=async()=>{fs.writeFileSync(${JSON.stringify(trace)},'unexpected');throw Error('private-canary');};`);
  fs.writeFileSync(eventPath,JSON.stringify(event()));
  const cli=path.join(ROOT,'scripts/ib-v3-envelope-evidence.mjs');
  for(const [args,extra,code] of [[['--check-plan','--expected-main='+MAIN],{FEE_DATA_KEY:'private-canary-key'},'ENVIRONMENT'],
    [['--expected-main='+MAIN],{FEE_ECON_GIST_ID:'b'.repeat(32),FEE_CLOUD_SHARESIGHT_CLIENT_ID:'c',FEE_CLOUD_SHARESIGHT_CLIENT_SECRET:'d'},'ENVIRONMENT'],
    [['--check-plan','--expected-main='+MAIN],{GITHUB_SHA:'b'.repeat(40)},'ENVIRONMENT'],[['--expected-main=nope'],{},'ARGUMENT']]){
    const result=spawnSync(process.execPath,['--import',preload,cli,...args],{encoding:'utf8',timeout:20000,
      env:{PATH:process.env.PATH,...env(),GITHUB_EVENT_PATH:eventPath,...extra}});
    assert.equal(result.status,1);assert.equal(result.stdout,'');
    const out=JSON.parse(result.stderr.trim());assert.equal(out.reasonCode,'FEE_ENVELOPE_EVIDENCE_'+code);assert.equal(out.status,'incomplete');
    assert.doesNotMatch(result.stderr,/canary|synthetic/);assert.equal(fs.existsSync(trace),false);
  }
});
test('the entry has no writer, no file output and is imported by no reader, writer or revision module',()=>{
  const text=fs.readFileSync(path.join(ROOT,'scripts/ib-v3-envelope-evidence.mjs'),'utf8');
  assert.doesNotMatch(text,/writeFile|appendFile|mkdir|rmSync|unlink|createWriteStream|spawn\(|(?<!\.)exec\(|process\.env\.[A-Z_]+\s*=|upload|decrypt|FEE_DATA_KEY'\)|fetchEconomicSnapshot/);
  assert.deepEqual([...text.matchAll(/^import .* from '([^']+)';$/gm)].map(m=>m[1]),['node:fs','node:path','node:util','node:url','node:child_process','./fee-http-json.mjs','./fee-report-producer.mjs']);
  assert.deepEqual([...text.matchAll(/git\(\[('[^']+')/g)].map(m=>m[1]),["'rev-parse'","'diff'","'ls-files'"]);
  const importers=fs.readdirSync(path.join(ROOT,'scripts')).filter(f=>f.endsWith('.mjs')&&!f.endsWith('.test.mjs')&&!f.startsWith('ib-v3-envelope-evidence'))
    .filter(f=>/from '\.\/ib-v3-envelope-evidence\.mjs'|import\('\.\/ib-v3-envelope-evidence\.mjs'\)/.test(fs.readFileSync(path.join(ROOT,'scripts',f),'utf8')));
  assert.deepEqual(importers,[]);
});

// ---- GitHub verification sub-location reaches the fixed entry result
const metaKeys=r=>Object.keys(r).filter(k=>k.startsWith('metadata')||k==='transportRefusal').sort();
const githubAuthorize=(fetchImpl,options={})=>()=>authorizeEnvelopeEvidence({expectedMain:'d'.repeat(40),currentRunId:'123456789',actionsToken:'synthetic_read_token_123456789',fetchImpl,...options});
const quiet={checkOnly:true,checkCheckout:()=>{},read:()=>assert.fail('check-plan never reads'),cleanup:()=>{}};
test('a GitHub verification failure reaches the entry result as fixed stage, request and category only',async()=>{
  const canary='private-canary-'+'Q'.repeat(10);
  const forbidden=new RegExp(canary+'|https?:|Bearer|synthetic_read_token|[a-f0-9]{40}|123456789');
  const denied=async(url)=>{const r=new Response(JSON.stringify({message:canary,documentation_url:'https://x.invalid'}),{status:403,headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;};
  const r403=await inspectEnvelopeEvidence({...quiet,authorize:githubAuthorize(denied)});
  assert.equal(r403.status,'incomplete');assert.equal(r403.reasonCode,'FEE_REPORT_RECOVERY_METADATA');
  assert.equal(r403.metadataStage,'RELEASE_MAIN_COMMIT');assert(['MAIN_REF','COMMIT'].includes(r403.metadataRequest),'first settled request of the concurrent batch');
  assert.equal(r403.metadataCategory,'HTTP_403');assert.deepEqual(metaKeys(r403),['metadataCategory','metadataRequest','metadataStage']);
  assert.doesNotMatch(JSON.stringify(r403),forbidden);
  const token=await inspectEnvelopeEvidence({...quiet,authorize:githubAuthorize(()=>assert.fail('no request'),{actionsToken:'t'.repeat(4097)})});
  assert.deepEqual([token.metadataStage,token.metadataRequest,token.metadataCategory],['RELEASE_SETUP','NONE','TOKEN_FORMAT']);
  const thrown=await inspectEnvelopeEvidence({...quiet,authorize:githubAuthorize(async()=>{throw Error(canary+' https://api.github.com/secret');})});
  assert.equal(thrown.metadataCategory,'FETCH_REJECTED');assert.doesNotMatch(JSON.stringify(thrown),forbidden);
  for(const r of [r403,token,thrown])for(const [k,list] of [['metadataStage',RECOVERY_METADATA_STAGES],['metadataRequest',RECOVERY_METADATA_REQUESTS],['metadataCategory',RECOVERY_METADATA_CATEGORIES]])assert(list.includes(r[k]),k);
});
test('the outer transport reports its own refusal as a fixed literal next to the producer category',async()=>{
  let now=0;const t=envelopeEvidenceTransport({fetchImpl:()=>assert.fail('expired before any request'),clock:()=>now});now=ENVELOPE_EVIDENCE_SCOPE.durationMs;
  try{
    const r=await inspectEnvelopeEvidence({...quiet,assertCurrent:()=>{},authorize:githubAuthorize(t.fetch),transportRefusal:t.refusal});
    assert.deepEqual([r.reasonCode,r.metadataStage,r.metadataCategory,r.transportRefusal],['FEE_REPORT_RECOVERY_METADATA','RELEASE_MAIN_COMMIT','FETCH_REJECTED','EXPIRED']);
  }finally{t.close();}
  const route=envelopeEvidenceTransport({fetchImpl:()=>assert.fail('refused routes never reach the network')});
  try{
    await assert.rejects(route.fetch('https://api.github.com/repos/huanwujoy-crypto/fee-console/contents/data.json?ref='+MAIN,{method:'GET'}),/ROUTE/);
    assert.equal(route.refusal(),'ROUTE');assert.deepEqual(ENVELOPE_TRANSPORT_REFUSALS,['ROUTE','EXPIRED']);
    const r=await inspectEnvelopeEvidence({...quiet,authorize:async()=>{throw new Error('FEE_REPORT_RECOVERY_RELEASE');},transportRefusal:route.refusal});
    assert.equal(r.transportRefusal,'ROUTE');assert.equal(r.metadataStage,undefined);
  }finally{route.close();}
  const clean=envelopeEvidenceTransport({fetchImpl:async url=>response(url,{})});
  try{await clean.fetch('https://api.github.com/repos/huanwujoy-crypto/fee-console/git/ref/heads/main',{method:'GET'});assert.equal(clean.refusal(),null);}finally{clean.close();}
  const odd=await inspectEnvelopeEvidence({...quiet,authorize:async()=>{throw new Error('FEE_REPORT_RECOVERY_RELEASE');},transportRefusal:()=>'canary'});
  assert.equal(odd.transportRefusal,undefined);
});
test('forged, other and unattributed failures add no metadata fields; success output is unchanged',async()=>{
  const forged=Object.assign(new Error('FEE_REPORT_RECOVERY_METADATA'),{stage:'RELEASE_SETUP',request:'NONE',category:'TOKEN_FORMAT'});
  assert.deepEqual(envelopeEvidenceFailure(forged),{reasonCode:'FEE_REPORT_RECOVERY_METADATA'});
  assert.deepEqual(envelopeEvidenceFailure(new Error('FEE_REPORT_RECOVERY_RELEASE')),{reasonCode:'FEE_REPORT_RECOVERY_RELEASE'});
  assert.deepEqual(envelopeEvidenceFailure(new Error('FEE_REPORT_RECOVERY_METADATA canary')),{reasonCode:'FEE_ENVELOPE_EVIDENCE_FAILED'});
  const admission={async checkCurrent(){},close(){}},s=source();
  const ok=await inspectEnvelopeEvidence({authorize:async()=>admission,checkCheckout:()=>{},cleanup:()=>{},transportRefusal:()=>'ROUTE',
    read:hooks=>readEnvelopeEvidence({...creds,fetchImpl:s.fetchImpl,...hooks})});
  assert.equal(ok.status,'verified');assert.deepEqual(metaKeys(ok),[]);
  assert.deepEqual(Object.keys(ok).sort(),['contractId','publicationReady','reasonCode','reportGenerated','requestsUsed','routes','schema','stabilityDecisionChanged','status','targetDate']);
  const plan=await inspectEnvelopeEvidence({...quiet,authorize:async()=>admission});
  assert.deepEqual(Object.keys(plan).sort(),['contractId','publicationReady','reasonCode','reportGenerated','schema','stabilityDecisionChanged','status','targetDate']);
});

test('the entry labels results with the one contract the producer binds and accepts',()=>{
  assert.equal(ENVELOPE_EVIDENCE_SCOPE.contractId,'ib-source-revision-20261106-envelope-evidence-v2');
  const manifest=reportHistoricalRecoveryManifest({contractId:ENVELOPE_EVIDENCE_SCOPE.contractId});
  assert(manifest.some(f=>f.path==='scripts/ib-v3-envelope-evidence.mjs'));assert.equal(manifest.length,5);
});
