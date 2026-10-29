import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {CLOUD_ACCOUNTS,parseSourceJson,SharesightCloudReader,normalizeRead} from './fee-cloud-source.mjs';
import {resolveTradeCashEvidence,isControlledWebullPrincipal} from './fee-trade-cash-evidence.mjs';
import {resolveManagementExemptions} from './fee-management-exemption.mjs';
import {buildManagedTransferProof,consumeManagedTransferProof} from './fee-sharesight-transfers.mjs';
import {captureSourceAcceptance,acceptanceTransport,verifySourceAcceptanceMain} from './fee-source-acceptance.mjs';
import {classifyFlow,reconcileFlows} from './daily-core.mjs';
import {reportAddDays} from './fee-report-period.mjs';
import {reportDate,reportWindowDates} from './fee-report-period.mjs';
import {expectedTargetDate} from './fee-cloud-source.mjs';
import {sourceAcceptanceFailure} from './fee-source-acceptance.mjs';
import {BoundedJsonError} from './fee-http-json.mjs';
import vm from 'node:vm';
import {periodReturns} from './fee-engine.mjs';
const D='2026-10-27',wire=v=>parseSourceJson(JSON.stringify(v)),instrument={id:99,code:'SYNTH',market_code:'NYSE',currency_code:'USD'};
function transferFixture(){
 const portfolio={id:1,name:'Webull'},peerPortfolio={id:2,name:'IB-HK'},holding=(id,quantity,value,p)=>({id,quantity,value,instrument,instrument_currency:{code:'USD'},valid_position:true,portfolio:p});
 const report=(p,d,h,cashId)=>({report:{portfolio_id:p.id,start_date:d,end_date:d,include_sales:false,portfolio_tz_name:'America/New_York',currency:{code:'USD'},value:h.reduce((n,r)=>n+r.value,0)+100,holdings:h,cash_accounts:[{id:cashId,value:100,currency:{code:'USD'},portfolio:p}]}});
 const raw=wire({performance:report(portfolio,D,[holding(11,2,200,portfolio)],101),previousPerformance:report(portfolio,reportAddDays(D,-1),[],101),trades:{trades:[{id:21,portfolio_id:1,holding_id:11,transaction_date:D,state:'confirmed',description_code:'OPENING_BALANCE',quantity:2,price:17,value:34,brokerage:0,instrument}]},cashTransactions:{101:{cash_account_transactions:[]}}});
 const peer=wire({performance:report(peerPortfolio,D,[holding(12,1,100,peerPortfolio)],102),previousPerformance:report(peerPortfolio,reportAddDays(D,-1),[holding(12,3,300,peerPortfolio)],102),trades:{trades:[{id:22,portfolio_id:2,holding_id:12,transaction_date:D,state:'confirmed',description_code:'TRANSFER_OUT',quantity:2,price:100,value:200,brokerage:0,instrument}]},cashTransactions:{102:{cash_account_transactions:[]}}});
 // The production parser attaches precision tokens at payload roots.
 for(const p of [raw,peer])for(const k of ['performance','previousPerformance','trades'])p[k]=wire(p[k]);
 return {account:'webull',portfolio,peerPortfolio,raw,peer,targetDate:D};
}
test('paired transfer uses receiving EOD market value, never opening cost, and feeds the original effective/idempotent flow rule',()=>{const f=transferFixture(),p=buildManagedTransferProof(f),flow=consumeManagedTransferProof(p,'webull',D)[0];assert.equal(flow.amount,200);assert.equal(classifyFlow(flow).effective,true);const one=reconcileFlows([],[],[flow]);assert.equal(reconcileFlows(one.auto,[],[flow]).auto.length,1);f.raw.trades.trades[0].value=35;assert.throws(()=>consumeManagedTransferProof(p,'webull',D),/PROOF/);});
test('serialised proof, wrong recipient scope, missing receiver, in-transit or mixed-date record cannot create a managed inflow',()=>{const f=transferFixture(),p=buildManagedTransferProof(f);assert.throws(()=>consumeManagedTransferProof(JSON.parse(JSON.stringify(p)),'webull',D),/PROOF/);assert.throws(()=>consumeManagedTransferProof(p,'schwab',D),/PROOF/);for(const change of [x=>x.peer=null,x=>x.peer.trades.trades=[],x=>x.peer.trades.trades[0].transaction_date=reportAddDays(D,-1),x=>x.raw.performance.report.holdings[0].quantity=1]){const v=transferFixture();change(v);assert.throws(()=>buildManagedTransferProof(v));}});
test('a managed account with no receipt event stays usable without an IB connection',()=>{const f=transferFixture();f.raw.performance=f.raw.previousPerformance=wire({...f.raw.performance,report:{...f.raw.performance.report,holdings:[],value:100}});f.raw.previousPerformance=wire({...f.raw.previousPerformance,report:{...f.raw.previousPerformance.report,start_date:reportAddDays(D,-1),end_date:reportAddDays(D,-1)}});f.raw.trades={trades:[]};f.peer=null;f.peerPortfolio=null;assert.deepEqual(consumeManagedTransferProof(buildManagedTransferProof(f),'webull',D),[]);});
test('cash legs, wrong closing valuation, incomplete cash coverage, unexpected scope and same-day extra activity fail closed',()=>{for(const change of [x=>x.peer.trades.trades[0].price=99,x=>x.raw.cashTransactions={},x=>x.peerPortfolio.name='unknown',x=>x.raw.performance.report.holdings[0].instrument.market_code='OTHER',x=>x.peer.trades.trades.push({...x.peer.trades.trades[0],id:23}),x=>x.raw.cashTransactions[101].cash_account_transactions.push({id:300,cash_account_id:101,date_time:D+'T00:00:00Z',amount:-34,trade_id:21})]){const f=transferFixture();change(f);assert.throws(()=>buildManagedTransferProof(f));}});

function sourceWire({mutate=()=>{},unstable=false}={}){
 const calls=[],portfolios=[...Object.values(CLOUD_ACCOUNTS).map(p=>({id:p.portfolioId,name:p.name,currency_code:'USD'})),{id:77,name:'IB-HK',currency_code:'USD'}];let grants=0;
 const response=(url,payload)=>{const r=new Response(JSON.stringify(payload),{headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;};
 const fetchImpl=async(url,init)=>{
  calls.push({url,method:init.method});const u=new URL(url),p=u.pathname,q=u.searchParams;let body;
  assert.equal(u.origin,'https://api.sharesight.com');assert.equal(init.redirect,'error');
  if(p==='/oauth2/token'){grants++;body={access_token:'synthetic-access-token-source-123',token_type:'bearer'};}
  else if(p==='/api/v2/portfolios.json')body={portfolios};
  else if(p.includes('/portfolios/')){
   const pid=Number(p.split('/')[4]),portfolio=portfolios.find(x=>x.id===pid);assert.ok(portfolio);const cashId=100+portfolios.indexOf(portfolio),d=q.get('end_date')||q.get('date');
   if(p.endsWith('/performance'))body={report:{portfolio_id:pid,start_date:d,end_date:d,include_sales:false,portfolio_tz_name:'America/New_York',currency:{code:'USD'},value:100,holdings:[],cash_accounts:[{id:cashId,value:100,currency:{code:'USD'},portfolio:{id:pid,name:portfolio.name}}]}};
   else if(p.endsWith('/holdings'))body={holdings:[]};
   else if(p.endsWith('/trades.json'))body={trades:[]};
   else if(p.endsWith('/cash_accounts.json'))body={cash_accounts:[{id:cashId,portfolio_id:pid,currency:'USD',portfolio_currency:'USD',date:d,balance:100,balance_in_portfolio_currency:100}]};
   else assert.fail('fixed source endpoint');
  }else if(p.includes('/cash_accounts/')){const cashId=Number(p.split('/')[4]);body={cash_account_transactions:q.has('from')?[]:[{id:cashId+1000,cash_account_id:cashId,date_time:reportAddDays(q.get('to'),-1)+'T00:00:00Z',amount:0,balance:100,cash_account_transaction_type:{name:'FEE'}}]};}
  else assert.fail('fixed source endpoint');
  if(unstable&&grants>2&&body.report)body.report.value=101;
  mutate(body,p);return response(url,body);
 };
 return {fetchImpl,calls};
}
function privateOut(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fee-source-accept-synthetic-')));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('fixed source field acceptance captures both complete passes with real parsers, no fee key or publication claim, and only private 0600 bytes',async t=>{const dir=privateOut(t),w=sourceWire(),r=await captureSourceAcceptance({fromDate:'2026-10-24',targetDate:D,outputDir:dir,clientId:'synthetic-client',clientSecret:'synthetic-secret-never-persist',now:new Date('2026-10-28T00:00Z'),fetchImpl:w.fetchImpl});assert.equal(r.status,'fields-captured');assert.equal(r.oauthGrants,10);assert.ok(r.sourceGets<300);assert.equal(r.publicationReady,false);assert.equal(r.financialCalculationVerified,false);for(const name of fs.readdirSync(path.join(dir,'source-field-acceptance'))){const file=path.join(dir,'source-field-acceptance',name);assert.equal(fs.statSync(file).mode&0o777,0o600);const s=fs.readFileSync(file,'utf8');assert.ok(!s.includes('synthetic-secret-never-persist'));assert.ok(!s.includes('synthetic-access-token-source-123'));}await assert.rejects(captureSourceAcceptance({fromDate:'2026-10-24',targetDate:D,outputDir:dir,clientId:'synthetic',clientSecret:'synthetic',now:new Date('2026-10-28T00:00Z'),fetchImpl:w.fetchImpl}),/OUTPUT_EXISTS/);});
test('partial pages, wrong scope, unstable source and raw errors produce fixed incomplete results, never publishable output',async t=>{for(const options of [{mutate:b=>{if(b.portfolios)b.portfolios[0].name='wrong';}},{mutate:b=>{if(b.portfolios)b.has_more=true;}},{unstable:true},{mutate:()=>{throw Error('private-token-canary');}}]){const r=await captureSourceAcceptance({fromDate:D,targetDate:D,outputDir:privateOut(t),clientId:'synthetic-client',clientSecret:'synthetic-secret-never-persist',now:new Date('2026-10-28T00:00Z'),fetchImpl:sourceWire(options).fetchImpl});assert.equal(r.status,'incomplete');assert.equal(r.publicationReady,false);assert.ok(!JSON.stringify(r).includes('private-token-canary'));}});
test('source acceptance transport blocks all non-GET source actions, non-provider origins and excess grant/call budgets',async()=>{let calls=0;const x=acceptanceTransport({fetchImpl:async()=>{calls++;return new Response('{}');}});await assert.rejects(x.fetch('https://evil.invalid/api/v2/portfolios.json',{method:'GET'}));await assert.rejects(x.fetch('https://api.sharesight.com/api/v2/portfolios.json',{method:'POST'}));for(let i=0;i<10;i++)await x.fetch('https://api.sharesight.com/oauth2/token',{method:'POST'});await assert.rejects(x.fetch('https://api.sharesight.com/oauth2/token',{method:'POST'}),/CALL_BUDGET/);assert.equal(calls,10);});

test('source validation checks exact public main and verified owner commit twice, never loads credentials or logs',async()=>{const head='a'.repeat(40);for(const mode of ['valid','moved','unsigned','wrong-owner']){let reads=0;const fetchImpl=async(url,init)=>{assert.equal(init.method,'GET');assert.equal(init.headers.Authorization,undefined);let value;if(url.endsWith('/git/ref/heads/main'))value={object:{sha:mode==='moved'&&++reads>1?'b'.repeat(40):head}};else{assert.ok(url.endsWith('/commits/'+head));value={sha:head,author:{id:mode==='wrong-owner'?1:283054367},commit:{verification:{verified:mode!=='unsigned'}}};}const r=new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;};if(mode==='valid')await verifySourceAcceptanceMain(head,{fetchImpl});else await assert.rejects(verifySourceAcceptanceMain(head,{fetchImpl}),/CODE_CHANGED/);}});

// Exercise the actual private CLI body with only external IO replaced. The
// parsed arguments, environment, Git/date/main gates and call order are product
// code; this fixture cannot acquire credentials, call Sharesight or write files.
const cliSource=fs.readFileSync(new URL('./fee-source-acceptance.mjs',import.meta.url),'utf8');
const cliBody=cliSource.slice(cliSource.indexOf('async function main(){'),cliSource.indexOf('\nif(process.argv[1]&&'));
const cliDates=/function dates\(from,to,now\)\{[^\n]+\}/.exec(cliSource)[0];
const MAIN='a'.repeat(40),CLI_NOW='2026-10-28T04:24:58.321Z';
const cliArgs=()=>['--check-plan','--expected-main='+MAIN,'--from-date=2026-10-26','--target-date=2026-10-27','--out-dir=/home/runner/work/_temp/fee-source-acceptance'];
function publicReply(url,value,status=200,headers={}){const r=new Response(typeof value==='string'?value:JSON.stringify(value),{status,headers:{'content-type':'application/json',...headers}});Object.defineProperty(r,'url',{value:url});return r;}
async function replayCli({args=cliArgs(),env={},execArgv=[],gitHead=MAIN,tracked='',untracked='',gitError=false,now=CLI_NOW,publicMode='valid',captureError=false}={}){
 const events=[],logs=[],counts={publicGets:0,capture:0};let refs=0;
 const fetchImpl=async(url,init)=>{
  counts.publicGets++;assert.equal(init.method,'GET');assert.equal(init.headers.Authorization,undefined);assert.ok(url.startsWith('https://api.github.com/repos/huanwujoy-crypto/fee-console/'));
  if(publicMode==='network')throw Error('SYNTHETIC_PRIVATE_CANARY');
  if(publicMode==='timeout')throw new BoundedJsonError('TIMEOUT');
  if(publicMode==='rate')return publicReply(url,'{}',403,{'x-ratelimit-remaining':'0'});
  if(publicMode==='forbidden')return publicReply(url,'{}',403);
  if(publicMode==='json')return publicReply(url,'{"partial":');
  if(publicMode==='size')return publicReply(url,'{}',200,{'content-length':String(2*1024*1024)});
  if(url.endsWith('/git/ref/heads/main'))return publicReply(url,{object:{sha:publicMode==='moved'&&++refs>1?'b'.repeat(40):MAIN}});
  return publicReply(url,{sha:MAIN,author:{id:publicMode==='wrong-owner'?1:283054367},commit:{verification:{verified:publicMode!=='unsigned'}}});
 };
 class ClockDate extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return Date.parse(now);}}
 const context={cliStage:'arguments',ROOT:'/synthetic/checkout',process:{argv:['/synthetic/node','/synthetic/checkout/scripts/fee-source-acceptance.mjs',...args],env:{GITHUB_RUN_ATTEMPT:'1',...env},execArgv},Date:ClockDate,
  reportDate,reportAddDays,reportWindowDates,expectedTargetDate,console:{log:value=>logs.push(value)},fail:code=>{throw Error('FEE_SOURCE_ACCEPTANCE_'+code);},
  execFileSync:(command,argv,options)=>{assert.equal(command,'git');assert.equal(options.cwd,'/synthetic/checkout');const call=argv.join(' ');events.push(call);if(gitError)throw Error('SYNTHETIC_PRIVATE_CANARY');if(call==='rev-parse HEAD')return gitHead;if(call==='diff --name-only HEAD')return tracked;if(call==='ls-files --others --exclude-standard')return untracked;assert.fail('Unexpected Git operation');},
  verifySourceAcceptanceMain:expected=>{events.push('public-main');return verifySourceAcceptanceMain(expected,{fetchImpl});},
  captureSourceAcceptance:async()=>{counts.capture++;if(captureError)throw Error('SYNTHETIC_PRIVATE_CANARY');assert.fail('An offline plan must never enter source capture');}};
 let failure=null;try{await vm.runInNewContext(cliDates+'\n'+cliBody+';main',context)();}catch(error){failure=sourceAcceptanceFailure(error,context.cliStage);}
 return {failure,events,logs,counts};
}
test('actual CLI replays the workflow arguments and clean attempt without source or credential access',async()=>{const r=await replayCli();assert.equal(r.failure,null);assert.deepEqual(r.logs,['SOURCE_ACCEPTANCE_PLAN_READY']);assert.deepEqual(r.events,['rev-parse HEAD','diff --name-only HEAD','ls-files --others --exclude-standard','public-main']);assert.equal(r.counts.publicGets,3);assert.equal(r.counts.capture,0);});
test('actual CLI preserves argument and every forbidden environment gate before Git or public/source requests',async t=>{
 for(const name of ['FEE_DATA_KEY','FEE_ECON_GIST_ID','FEE_CLOUD_GITHUB_TOKEN','GH_TOKEN','GITHUB_TOKEN','NODE_OPTIONS','NODE_PATH','LD_PRELOAD','LD_LIBRARY_PATH','DYLD_INSERT_LIBRARIES'])await t.test(name,async()=>{for(const value of ['','SYNTHETIC_PRIVATE_CANARY']){const r=await replayCli({env:{[name]:value}});assert.equal(r.failure.stage,'environment');assert.equal(r.failure.reasonCode,'FEE_SOURCE_ACCEPTANCE_ENVIRONMENT');assert.equal(r.events.length,0);assert.equal(r.counts.capture+r.counts.publicGets,0);assert.ok(!JSON.stringify(r.failure).includes('CANARY'));}});
 for(const args of [[...cliArgs(),'--check-plan'],[...cliArgs(),'--unexpected=value'],cliArgs().filter(x=>!x.startsWith('--expected-main='))]){const r=await replayCli({args});assert.ok(r.failure);assert.equal(r.events.length,0);assert.equal(r.counts.capture+r.counts.publicGets,0);}
 const debug=await replayCli({execArgv:['--inspect']});assert.equal(debug.failure.stage,'environment');assert.equal(debug.counts.publicGets+debug.counts.capture,0);
});
test('actual CLI identifies rerun, HEAD, tracked/untracked and date branches without weakening refusals',async()=>{
 for(const [options,stage,code]of [[{env:{GITHUB_RUN_ATTEMPT:'2'}},'attempt','RERUN'],[{gitHead:'b'.repeat(40)},'git-head','CODE_CHANGED'],[{tracked:'scripts/changed.mjs'},'git-tracked','CODE_CHANGED'],[{untracked:'unknown.json'},'git-untracked','CODE_CHANGED'],[{untracked:'gha-creds-nothex.json'},'git-untracked','CODE_CHANGED'],[{gitError:true},'git-head','GIT_CHECK_FAILED'],[{now:'2026-11-01T04:24:58Z'},'dates','DATE']]){const r=await replayCli(options);assert.equal(r.failure.stage,stage);assert.equal(r.failure.reasonCode,'FEE_SOURCE_ACCEPTANCE_'+code);assert.equal(r.counts.publicGets+r.counts.capture,0);assert.equal(r.failure.sourceGets,0);assert.equal(r.failure.oauthGrants,0);}
 assert.equal((await replayCli({untracked:'gha-creds-a1b2.json'})).failure,null);
});
test('actual CLI distinguishes public HTTP/rate/JSON/size/network/timeout and identity failures; no retry or source follows',async()=>{
 for(const [mode,reason]of [['rate','PUBLIC_RATE_LIMIT'],['forbidden','PUBLIC_HTTP'],['json','PUBLIC_JSON'],['size','PUBLIC_SIZE'],['network','PUBLIC_NETWORK'],['timeout','PUBLIC_TIMEOUT'],['moved','CODE_CHANGED'],['unsigned','CODE_CHANGED'],['wrong-owner','CODE_CHANGED']]){const r=await replayCli({publicMode:mode});assert.equal(r.failure.stage,'public-main');assert.equal(r.failure.reasonCode,'FEE_SOURCE_ACCEPTANCE_'+reason);assert.equal(r.counts.capture,0);assert.equal(r.failure.sourceGets+r.failure.oauthGrants,0);assert.ok(r.counts.publicGets<=3);if(['rate','forbidden'].includes(mode))assert.equal(r.failure.httpStatus,403);if(!['moved','unsigned','wrong-owner'].includes(mode))assert.equal(r.counts.publicGets,1);assert.ok(!JSON.stringify(r.failure).includes('CANARY'));}
});
test('finite diagnostics do not invoke getters or serialize values; capture errors never invent zero-call evidence',async()=>{
 let reads=0;const error={get message(){reads++;return 'SYNTHETIC_PRIVATE_CANARY';},toJSON(){throw Error('Must not serialize');}};const r=sourceAcceptanceFailure(error,'public-main');assert.equal(reads,0);assert.ok(!JSON.stringify(r).includes('CANARY'));assert.equal(r.reasonCode,'FEE_SOURCE_ACCEPTANCE_REFUSED');
 for(const stage of ['SYNTHETIC_PRIVATE_CANARY',null,{}])assert.equal(sourceAcceptanceFailure(Error('SYNTHETIC_PRIVATE_CANARY'),stage).stage,'unknown');
 const captured=await replayCli({args:cliArgs().filter(x=>x!=='--check-plan'),captureError:true});assert.equal(captured.failure.stage,'capture');assert.equal(captured.failure.sourceGets,null);assert.equal(captured.failure.oauthGrants,null);assert.equal(captured.failure.publicationReady,false);assert.ok(!JSON.stringify(captured.failure).includes('CANARY'));
});
test('metadata-only workflow mode has no financial environment/identity and excludes every financial entry',()=>{
 const workflow=fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml',import.meta.url),'utf8');const block=name=>{const start=workflow.indexOf('\n  '+name+':\n');assert.ok(start>=0);const rest=workflow.slice(start+1);return rest.slice(0,rest.slice(1).search(/\n  [a-z][a-z-]*:\n/)+1||undefined);};
 const plan=block('source-plan-check');assert.match(plan,/permissions:\n      contents: read/);assert.doesNotMatch(plan,/\n    environment:|id-token:|google-github-actions\/|secrets\.|source_credentials|fee-data-health|--execute/);assert.match(plan,/--check-plan/);assert.match(plan,/timeout-minutes: 3/);
 const condition=name=>{const text=block(name),expression=/\n    if: \$\{\{ (.+) \}\}/.exec(text)[1];return inputs=>vm.runInNewContext(expression,{inputs,github:{event_name:'workflow_dispatch',run_attempt:1},vars:{FEE_REPORT_PERIODS_ENABLED:'true',FEE_CLOUD_MODE:'publish'},needs:{period:{outputs:{outcome:'produce'}}}});};
 for(const source of [false,true])for(const report of [false,true]){const inputs={source_plan_check_only:true,source_acceptance_once:source,run_reviewed_once:report};assert.equal(condition('period')(inputs),false);assert.equal(condition('produce')(inputs),false);assert.equal(condition('source-acceptance')(inputs),false);assert.equal(condition('source-plan-check')(inputs),!source&&!report);}
 assert.equal(condition('source-acceptance')({source_plan_check_only:false,source_acceptance_once:true,run_reviewed_once:false}),true);
});

// Local finite in-kind design regression; synthetic data only.
{
const {managedTransferCandidates}=await import('./fee-sharesight-transfers.mjs');
const wire=v=>parseSourceJson(JSON.stringify(v)),D='2026-10-27';
function fixture(){
 const portfolio={id:1,name:'Webull'},peerPortfolio={id:2,name:'IB-HK'},instrument={id:99,code:'SYNTH',market_code:'NYSE',currency_code:'USD'};
 const holding=(p,id,q)=>({id,quantity:q,value:q*100,instrument,instrument_currency:{code:'USD'},valid_position:true,portfolio:p});
 const report=(p,d,h,c)=>wire({report:{portfolio_id:p.id,start_date:d,end_date:d,include_sales:false,portfolio_tz_name:'America/New_York',currency:{code:'USD'},value:h.reduce((n,x)=>n+x.value,100),holdings:h,cash_accounts:[{id:c,value:100,currency:{code:'USD'},portfolio:p}]}});
 const raw={performance:report(portfolio,D,[holding(portfolio,11,3)],101),previousPerformance:report(portfolio,'2026-10-26',[holding(portfolio,11,1)],101),trades:wire({trades:[{id:21,portfolio_id:1,holding_id:11,transaction_date:D,state:'confirmed',description_code:'BUY',quantity:2,price:17,value:34,brokerage:0,instrument,comments:'noncash transfer'}]}),cashTransactions:{101:wire({cash_account_transactions:[]})}};
 const peer={performance:report(peerPortfolio,D,[holding(peerPortfolio,12,1)],102),previousPerformance:report(peerPortfolio,'2026-10-26',[holding(peerPortfolio,12,3)],102),trades:wire({trades:[{id:22,portfolio_id:2,holding_id:12,transaction_date:D,state:'confirmed',description_code:'TRANSFER_OUT',quantity:2,price:100,value:200,brokerage:0,instrument}]}),cashTransactions:{102:wire({cash_account_transactions:[]})}};
 return {account:'webull',targetDate:D,portfolio,peerPortfolio,raw,peer,identifiedTransfers:{schema:'fee-console.managed-transfer-identities.v1',date:D,account:'webull',sourcePortfolioId:2,destinationPortfolioId:1,pairs:[{sourceTradeId:22,sourceHoldingId:12,tradeId:21,holdingId:11}]}};
}
test('exact native identity plus positions, zero cash and EOD mark allow only the identified cost-preserving Buy',()=>{const f=fixture(),p=buildManagedTransferProof(f),flow=consumeManagedTransferProof(p,'webull',D)[0];assert.equal(flow.amount,200);assert.equal(flow.type,'BUY');assert.equal(f.raw.trades.trades[0].value,34);assert.equal(f.raw.performance.report.holdings[0].quantity,3);const r=reconcileFlows([],[],[flow]);assert.equal(r.auto[0].effective,true);assert.equal(reconcileFlows(r.auto,[],[flow]).auto.length,1);});
test('an ordinary Buy stays a source position, while a comment alone creates no transfer or capital',()=>{const f=fixture();delete f.identifiedTransfers;assert.equal(managedTransferCandidates(f.raw).length,0);assert.deepEqual(consumeManagedTransferProof(buildManagedTransferProof(f),'webull',D),[]);});
test('wrong IDs, account scope, date and unknown authorization-shaped fields fail closed',()=>{for(const change of [x=>x.identifiedTransfers.pairs[0].sourceTradeId++,x=>x.identifiedTransfers.pairs[0].sourceHoldingId++,x=>x.identifiedTransfers.pairs[0].tradeId++,x=>x.identifiedTransfers.pairs[0].holdingId++,x=>x.identifiedTransfers.sourcePortfolioId++,x=>x.identifiedTransfers.destinationPortfolioId++,x=>x.identifiedTransfers.account='schwab',x=>x.identifiedTransfers.date='2026-10-28',x=>x.identifiedTransfers.approved=true]){const f=fixture();change(f);assert.throws(()=>buildManagedTransferProof(f));}});
test('a selected Buy still rejects any real linked cash leg, missing cash coverage or failed mark',()=>{for(const change of [x=>x.raw.cashTransactions[101].cash_account_transactions.push({id:33,cash_account_id:101,date_time:D+'T00:00:00Z',amount:-34,trade_id:21}),x=>x.raw.cashTransactions={},x=>x.peer.trades.trades[0].price=17,x=>x.raw.performance.report.holdings[0].quantity=2,x=>x.peer.trades.trades[0].transaction_date='2026-10-26']){const f=fixture();change(f);assert.throws(()=>buildManagedTransferProof(f));}});
test('partial mapping, duplicate source pair and extra activity cannot broaden a reviewed group',()=>{for(const change of [x=>x.identifiedTransfers.pairs.push({...x.identifiedTransfers.pairs[0]}),x=>x.identifiedTransfers.pairs=[],x=>x.raw.trades.trades.push({...x.raw.trades.trades[0],id:23}),x=>x.peer=null]){const f=fixture();change(f);assert.throws(()=>buildManagedTransferProof(f));}});
test('mutating identified pair evidence invalidates an already built proof',()=>{const f=fixture(),p=buildManagedTransferProof(f);f.identifiedTransfers.pairs[0].sourceTradeId++;assert.throws(()=>consumeManagedTransferProof(p,'webull',D),/PROOF/);});
test('source sub-cent quotes retain exact decimals without rounding market-value evidence',()=>{const f=fixture();const price=12.3456;for(const [packet,q]of [[f.raw,200],[f.peer,200]]){const t=packet.trades.trades[0];t.quantity=q;if(packet===f.peer){t.price=price;t.value=2469.12;}packet.trades=wire(packet.trades);}for(const [packet,before,after]of [[f.raw,100,300],[f.peer,300,100]]){for(const [key,q]of [['previousPerformance',before],['performance',after]]){packet[key].report.holdings[0].quantity=q;packet[key].report.holdings[0].value=q*price;packet[key].report.value=q*price+100;packet[key]=wire(packet[key]);}}const p=buildManagedTransferProof(f);assert.equal(consumeManagedTransferProof(p,'webull',D)[0].amount,2469.12);f.peer.trades.trades[0].price=12.35;assert.throws(()=>buildManagedTransferProof(f),/SOURCE_MARK/);});
test('signed native disposal is still a positive receiver noncash flow, never cash or cost',()=>{
 const f=fixture();f.peer.trades.trades[0].value=-200;f.peer.trades=wire(f.peer.trades);
 const p=buildManagedTransferProof(f);assert.equal(consumeManagedTransferProof(p,'webull',D)[0].amount,200);
 for(const mutate of [x=>x.peer.trades.trades[0].value=-199,x=>x.peer.trades.trades[0].description_code='SELL',x=>x.peer.trades.trades[0].price=-100,x=>x.raw.cashTransactions[101].cash_account_transactions.push({id:34,cash_account_id:101,date_time:D+'T00:00:00Z',amount:-34,trade_id:21})]){
  const bad=fixture();bad.peer.trades.trades[0].value=-200;mutate(bad);bad.peer.trades=wire(bad.peer.trades);assert.throws(()=>buildManagedTransferProof(bad));
 }
});

}

// Shared paid-cash association regressions execute on the existing formal source path.
{
const D='2026-10-28',P='2026-10-27',wire=x=>parseSourceJson(JSON.stringify(x));
const instrument={id:99,code:'SYNTH',market_code:'NYSE',currency_code:'USD'};
function fixture(side='BUY',kind='short',fee=1){
 const portfolio={id:CLOUD_ACCOUNTS.webull.portfolioId,name:'Webull'},quantity=2,price=10,gross=20;
 const movement=side==='BUY'?-(gross+fee):gross-fee;
 const key=`webull.manual|10205226|aaaaaaaaaaaaaaaa|${side}|SYNTH|2|10`;
 const t={id:222,portfolio_id:portfolio.id,holding_id:4,transaction_date:D,state:'confirmed',description_code:side,
  instrument,quantity,price,price_currency_code:'USD',brokerage:fee,brokerage_currency_code:'USD',value:side==='BUY'?-movement:-movement,
  comments:`Synthetic confirmed source; key=${key}.`};
 const row={id:333,cash_account_id:8,date_time:D+'T04:00:00Z',amount:movement,balance:100+movement,
  cash_account_transaction_type:{name:side==='BUY'?'WITHDRAWAL':'DEPOSIT'},trade_id:null,holding_id:null,payout_id:null,foreign_identifier:null,
  description:`Webull SYNTH ${side} 2@10; NOT external funding. Trade222; Gmailaaaaaaaaaaaaaaaa; gross20, fee${fee}, cash${movement}. key=${key}|cash`};
 if(kind==='long')row.description=`Webull SYNTH ${side} securities principal; NOT external funding. Trade222; Gmailaaaaaaaaaaaaaaaa; filled 2026/10/28 09:30:00 EDT; 2@USD10, actual transaction fee${fee}. Source phone cash matched by exact six-trade bridge. key=webull.manual|10205226|...`;
 if(kind==='native'||kind==='string-native'){row.description='native source';row.trade_id=kind==='native'?t.id:String(t.id);}
 if(kind==='net'){
  const order='ABCDEF0123456789ABCD';
  t.comments=`Webull SYNTH SELL 2 shares on ${D} at USD10; order ${order}. Commission USD0; actual fee USD1.00 recorded in trade fees. Gross USD20.00; net USD19.00.`;
  row.description=`Webull SYNTH SELL net proceeds; NOT external funding. Order ${order}; Sharesight trade 222; ${D}; gross USD20.00 less fee USD1.00 = net USD19.00. Fee included, no separate fee debit.`;
 }
 if(kind==='principal'){
  const order='ABCDEF0123456789ABCD';
  t.comments=`Webull account 10205226; ${D} source; order ${order}; synthetic.`;
  row.description=`Webull SYNTH ${side} securities principal; NOT external funding; order ${order}; Sharesight trade 222; ${D} 09:30:00 EDT; source fee USD 0.00.`;
 }
 const holding=(q,p=portfolio,id=4)=>({id,quantity:q,value:q*10,instrument,instrument_currency:{code:'USD'},valid_position:true,portfolio:p});
 const report=(date,q,cash)=>({report:{portfolio_id:portfolio.id,start_date:date,end_date:date,include_sales:false,
  portfolio_tz_name:'America/New_York',currency:{code:'USD'},value:q*10+cash,holdings:[holding(q)],
  cash_accounts:[{id:8,value:cash,currency:{code:'USD'},portfolio}]}});
 const before=side==='BUY'?1:3,after=side==='BUY'?3:1;
 const raw={previousPerformance:report(P,before,100),performance:report(D,after,100+movement),
  trades:{trades:[t]},cashTransactions:{8:{cash_account_transactions:[row]}}};
 for(const k of ['previousPerformance','performance','trades'])raw[k]=wire(raw[k]);
 return {account:'webull',portfolio,targetDate:D,raw};
}
const resolve=f=>resolveTradeCashEvidence({account:f.account,portfolioId:f.portfolio.id,targetDate:f.targetDate,
 trades:f.raw.trades.trades,cashRows:Object.values(f.raw.cashTransactions).flatMap(p=>p.cash_account_transactions),cashAccounts:f.raw.performance.report.cash_accounts});
function assertNotMatched(f,message){
 try{assert.equal(resolve(f).cashForTrade.size,0,message);}catch(error){
  if(error.message!=='FEE_NONCASH_TRADE_CASH_UNVERIFIED')throw error;
 }
}
test('shared resolver accepts observed short BUY/SELL, explicit abbreviated form and both legacy formats',()=>{
 for(const [side,kind,fee]of [['BUY','short',1],['SELL','short',1],['BUY','long',1],['BUY','principal',0],['SELL','net',1],['BUY','native',1],['BUY','string-native',1]]){
  const f=fixture(side,kind,fee),r=resolve(f);assert.equal(r.cashForTrade.get(222),333,kind);
  assert.equal(r.tradeForCash.get(333),222);const proof=buildManagedTransferProof(f);
  assert.equal(consumeManagedTransferProof(proof,'webull',D).length,0,'ordinary paid cash is not a transfer');
  assert.equal(consumeManagedTransferProof(buildManagedTransferProof(f),'webull',D).length,0,'repeat creates no transfer');
 }
});
test('new manual association rejects account/date/side/security/quantity/price/fee/net/key mismatches',()=>{
 const changes=[f=>f.account='schwab',f=>f.raw.trades.trades[0].portfolio_id++,
  f=>f.raw.trades.trades[0].transaction_date=P,f=>f.raw.cashTransactions[8].cash_account_transactions[0].date_time=P+'T04:00Z',
  f=>f.raw.trades.trades[0].state='pending',f=>f.raw.trades.trades[0].description_code='SELL',
  f=>f.raw.trades.trades[0].instrument.code='OTHER',f=>f.raw.trades.trades[0].quantity=3,
  f=>f.raw.trades.trades[0].price=11,f=>f.raw.trades.trades[0].brokerage=2,
  f=>f.raw.trades.trades[0].value=String(f.raw.trades.trades[0].value),
  f=>f.raw.trades.trades[0].brokerage=String(f.raw.trades.trades[0].brokerage),
  f=>f.raw.cashTransactions[8].cash_account_transactions[0].amount=String(f.raw.cashTransactions[8].cash_account_transactions[0].amount),
  f=>f.raw.cashTransactions[8].cash_account_transactions[0].amount=-22,
  f=>f.raw.cashTransactions[8].cash_account_transactions[0].description=f.raw.cashTransactions[8].cash_account_transactions[0].description.replace('fee1','fee2'),
  f=>f.raw.cashTransactions[8].cash_account_transactions[0].description=f.raw.cashTransactions[8].cash_account_transactions[0].description.replace('cash-21','cash-22'),
  f=>f.raw.cashTransactions[8].cash_account_transactions[0].description=f.raw.cashTransactions[8].cash_account_transactions[0].description.replace('Trade222','Trade223'),
  f=>f.raw.cashTransactions[8].cash_account_transactions[0].description=f.raw.cashTransactions[8].cash_account_transactions[0].description.replace('Gmailaaaaaaaaaaaaaaaa','Gmailbbbbbbbbbbbbbbbb'),
  f=>f.raw.cashTransactions[8].cash_account_transactions[0].description+=' unknown',
  f=>f.raw.cashTransactions[8].cash_account_transactions[0].cash_account_id++,
  f=>f.raw.cashTransactions[8].cash_account_transactions[0].payout_id=1,
  f=>f.raw.cashTransactions[8].cash_account_transactions[0].holding_id=5,
  f=>f.raw.trades.trades[0].brokerage_currency_code='HKD',
  f=>f.raw.performance.report.cash_accounts[0].currency.code='HKD'];
 for(const change of changes){const f=fixture();change(f);assertNotMatched(f,change.toString());}
});
test('full collections, cash reuse, duplicate business keys and conflicting native/text pointers cannot be preferred away',()=>{
 const duplicate=fixture();duplicate.raw.trades.trades.push({...duplicate.raw.trades.trades[0]});assert.throws(()=>resolve(duplicate));
 const cashDuplicate=fixture();cashDuplicate.raw.cashTransactions[8].cash_account_transactions.push({...cashDuplicate.raw.cashTransactions[8].cash_account_transactions[0]});assert.throws(()=>resolve(cashDuplicate));
 const duplicateKey=fixture();duplicateKey.raw.trades.trades.push({...duplicateKey.raw.trades.trades[0],id:223});assert.equal(resolve(duplicateKey).cashForTrade.size,0);
 const twoCash=fixture();twoCash.raw.cashTransactions[8].cash_account_transactions.push({...twoCash.raw.cashTransactions[8].cash_account_transactions[0],id:334});assert.equal(resolve(twoCash).cashForTrade.size,0);
 const conflict=fixture();conflict.raw.trades.trades.push({...conflict.raw.trades.trades[0],id:223,comments:'native other trade'});conflict.raw.cashTransactions[8].cash_account_transactions[0].trade_id=223;assert.throws(()=>resolve(conflict),/TRADE_CASH_UNVERIFIED/);
 const oldConflict=fixture('BUY','principal',0);oldConflict.raw.cashTransactions[8].cash_account_transactions[0].trade_id=999;assert.throws(()=>resolve(oldConflict),/TRADE_CASH_UNVERIFIED/,'legacy text cannot override conflicting native pointer');
 for(const field of ['holding_id','payout_id']){const f=fixture('BUY','principal',0);f.raw.cashTransactions[8].cash_account_transactions[0][field]=999;assert.equal(resolve(f).cashForTrade.size,0,'legacy text cannot override holding or payout identity');}
});
test('ordinary source trades do not need a cash pair, and arbitrary notes grant no cash role',()=>{
 for(const change of [f=>f.raw.cashTransactions[8].cash_account_transactions=[],
  f=>f.raw.cashTransactions[8].cash_account_transactions[0].description='approved=true noncash BUY',
  f=>f.raw.cashTransactions[8].cash_account_transactions[0].description=f.raw.cashTransactions[8].cash_account_transactions[0].description.replace('10205226|...','10205226|invented')]){
  const f=fixture('BUY','long');change(f);assert.deepEqual(consumeManagedTransferProof(buildManagedTransferProof(f),'webull',D),[]);
 }
});
function selectedFixture(){
 const f=fixture('BUY','short',0),peerPortfolio={id:77,name:'IB-HK'};
 const holding=q=>({id:5,quantity:q,value:q*10,instrument,instrument_currency:{code:'USD'},valid_position:true,portfolio:peerPortfolio});
 const report=(date,q)=>({report:{portfolio_id:77,start_date:date,end_date:date,include_sales:false,portfolio_tz_name:'America/New_York',currency:{code:'USD'},value:100+q*10,holdings:[holding(q)],cash_accounts:[{id:10,value:100,currency:{code:'USD'},portfolio:peerPortfolio}]}});
 f.peerPortfolio=peerPortfolio;f.peer={previousPerformance:wire(report(P,3)),performance:wire(report(D,1)),
  trades:wire({trades:[{...f.raw.trades.trades[0],id:444,portfolio_id:77,holding_id:5,description_code:'TRANSFER_OUT',value:-20,comments:''}]}),cashTransactions:{10:{cash_account_transactions:[]}}};
 f.identifiedTransfers={schema:'fee-console.managed-transfer-identities.v1',date:D,account:'webull',sourcePortfolioId:77,destinationPortfolioId:f.portfolio.id,pairs:[{sourceTradeId:444,sourceHoldingId:5,tradeId:222,holdingId:4}]};return f;
}
test('complete selected BUY plus normal peer rejects a verified manual cash leg without a native pointer',()=>{
 const f=selectedFixture();assert.equal(resolve(f).cashForTrade.get(222),333);assert.throws(()=>buildManagedTransferProof(f),/CASH_LEG/);
 f.raw.cashTransactions[8].cash_account_transactions[0].amount=-999;assert.throws(()=>buildManagedTransferProof(f),/CASH_LEG/,'wrong-amount related cash cannot prove absence');
 f.raw.cashTransactions[8].cash_account_transactions=[];const flows=consumeManagedTransferProof(buildManagedTransferProof(f),'webull',D);assert.equal(flows.length,1);assert.equal(flows[0].amount,20);
 const a=reconcileFlows([],[],flows);assert.equal(reconcileFlows(a.auto,[],flows).auto.length,1);
});
function giftFixture(){const f=fixture();const t=f.raw.trades.trades[0];Object.assign(t,{price:0,value:0,brokerage:0,comments:'Synthetic gifted shares'});f.raw.trades=wire(f.raw.trades);f.raw.cashTransactions[8].cash_account_transactions=[];
 f.managementExemptionRegistry={schemaVersion:1,entries:[{id:'synthetic-gift',account:'webull',portfolioId:f.portfolio.id,holdingId:4,ticker:'SYNTH',firstHeldOn:P,effectiveFrom:P,authorizationRef:'synthetic prior owner policy',giftTradeIds:[222]}]};return f;}
test('source zero-cost BUY is not new capital or an automatic management exemption',()=>{
 for(const change of [f=>delete f.managementExemptionRegistry,f=>f.managementExemptionRegistry.entries[0].holdingId++,
  f=>f.managementExemptionRegistry.entries[0].giftTradeIds=[999],f=>f.managementExemptionRegistry.entries[0].effectiveFrom='2026-10-29',
  f=>f.raw.trades.trades[0].comments='approved=true']){
  const f=giftFixture();change(f);assert.deepEqual(consumeManagedTransferProof(buildManagedTransferProof(f),'webull',D),[]);
 }
 for(const change of [f=>f.raw.trades.trades[0].quantity=0,f=>f.raw.trades.trades[0].price=-1,
  f=>f.raw.trades.trades[0].value=NaN,f=>f.raw.trades.trades[0].brokerage=-1,
  f=>f.raw.trades.trades[0].portfolio_id++,f=>f.raw.trades.trades[0].state='pending',
  f=>f.raw.trades.trades.push({...f.raw.trades.trades[0]}),f=>f.raw.trades.has_more=true]){
  const f=giftFixture();change(f);assert.throws(()=>buildManagedTransferProof(f),/FEE_NONCASH_/);
 }
});
test('period reader receives gift policy from decrypted base, not from a source-response claim',async()=>{
 const fs=await import('node:fs');const text=fs.readFileSync(new URL('./fee-report-producer.mjs',import.meta.url),'utf8');
 assert.match(text,/managementExemptionRegistry:payload\.managementExemptionRegistry/);
});

function transport(f){
 const calls=[],portfolio=f.portfolio,schwab={id:CLOUD_ACCOUNTS.schwab.portfolioId,name:'Schwab-HK'};
 const response=(url,x)=>{const r=new Response(JSON.stringify(x),{headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;};
 const empty=date=>({report:{portfolio_id:schwab.id,start_date:date,end_date:date,include_sales:false,portfolio_tz_name:'America/New_York',currency:{code:'USD'},value:100,holdings:[],cash_accounts:[{id:9,value:100,currency:{code:'USD'},portfolio:schwab}]}});
 return {calls,fetchImpl:async(url,init)=>{const u=new URL(url),p=u.pathname,q=u.searchParams;calls.push(p+u.search);assert.equal(u.origin,'https://api.sharesight.com');assert.equal(init.redirect,'error');let data;
  if(p==='/oauth2/token')data={access_token:'synthetic-12345678901234567890',token_type:'bearer'};
  else if(p==='/api/v2/portfolios.json')data={portfolios:[portfolio,schwab,...(f.peerPortfolio?[f.peerPortfolio]:[])].map(x=>({...x,currency_code:'USD'}))};
  else if(p.includes('/portfolios/')){const pid=Number(p.split('/')[4]),isWebull=pid===portfolio.id,isPeer=pid===f.peerPortfolio?.id,date=q.get('end_date')||q.get('date');assert.ok(isWebull||isPeer||pid===schwab.id);
   if(p.endsWith('/performance'))data=isWebull?(date===D?f.raw.performance:f.raw.previousPerformance):isPeer?(date===D?f.peer.performance:f.peer.previousPerformance):empty(date);
   else if(p.endsWith('/holdings'))data={holdings:isWebull?[...f.raw.performance.report.holdings.map(h=>({...h,inception_date:P})),...(f.extraCatalog||[])]:[]};
   else if(p.endsWith('/trades.json'))data=isWebull?(!q.has('start_date')&&f.history?f.history:f.raw.trades):isPeer?f.peer.trades:{trades:[]};
   else if(p.endsWith('/cash_accounts.json')){const amount=isWebull?f.raw.performance.report.cash_accounts[0].value:100;data={cash_accounts:[{id:isWebull?8:isPeer?10:9,portfolio_id:pid,currency:isWebull?(f.cashCurrency||'USD'):'USD',portfolio_currency:'USD',date,balance:isWebull?(f.cashNativeBalance??amount)+(f.cashAuxiliaryOffset||0):amount,balance_in_portfolio_currency:isWebull?amount+(f.cashAuxiliaryOffset||0):amount}]};}
   else assert.fail('unexpected fixed route');
  }else if(p.includes('/cash_accounts/')){const cashId=Number(p.split('/')[4]);assert.ok([8,9,10].includes(cashId));const own=cashId===8?f.raw.cashTransactions[8].cash_account_transactions:cashId===10?f.peer.cashTransactions[10].cash_account_transactions:[];
   if(q.has('from'))data={...(cashId===8?f.raw.cashTransactions[8]:cashId===10?f.peer.cashTransactions[10]:{}),cash_account_transactions:own};
   else{const opening=cashId===8?f.raw.previousPerformance.report.cash_accounts[0].value:100;data={cash_account_transactions:[{id:999+cashId,cash_account_id:cashId,date_time:P+'T00:00Z',amount:0,balance:opening,cash_account_transaction_type:{name:'FEE'}},...own]};}}
  else assert.fail('unexpected endpoint');return response(url,data);
 }};
}
test('actual reader → normalizer follows the Sharesight principal declaration without manufacturing a trade ID',async()=>{
 for(const [side,kind]of [['BUY','short'],['SELL','short'],['BUY','long'],['SELL','net']]){
  const f=fixture(side,kind),io=transport(f),reader=new SharesightCloudReader({clientId:'synthetic',clientSecret:'synthetic',fetchImpl:io.fetchImpl,reconcileInKind:true});
  const raw=await reader.readOnce(D),out=normalizeRead(raw,D,{spy:100,qqq:100,spyd:0,qqqd:0});
  const cash=out.flows.find(x=>x.acct==='webull');assert.equal(cash.evidence,'internal_trade');assert.equal(cash.tradeId,null);assert.equal(classifyFlow(cash).kind,'internal');
  assert.equal(out.flows.filter(x=>x.evidence==='external_asset_transfer').length,0);assert.ok(!io.calls.some(p=>p.includes('/77/')));
 }
});
test('ordinary cash keeps its native source role without joining it to the same-day trade list',async()=>{
 for(const change of [row=>row.description=row.description.replace('Trade222','Trade999'),
  row=>row.description='ordinary native cash; settled trade from an earlier day']){
  const f=fixture();f.raw.cashTransactions[8].cash_account_transactions[0].trade_id=999;
  change(f.raw.cashTransactions[8].cash_account_transactions[0]);
  const reader=new SharesightCloudReader({clientId:'synthetic',clientSecret:'synthetic',fetchImpl:transport(f).fetchImpl,reconcileInKind:true});
  const out=normalizeRead(await reader.readOnce(D),D,{spy:100,qqq:100,spyd:0,qqqd:0});
  const flow=out.flows.find(x=>x.acct==='webull');assert.equal(flow.tradeId,999);
  assert.equal(classifyFlow(flow).kind,'internal');assert.equal(out.flows.filter(x=>x.evidence==='external_asset_transfer').length,0);
 }
});
test('source gifts remain readable while the existing mixed-lot exemption policy is unchanged',async()=>{
 const f=giftFixture();f.raw.performance.report.cash_accounts[0].value=100;f.raw.performance.report.value=130;
 f.history={trades:[{...f.raw.trades.trades[0],id:111,transaction_date:P,description_code:'OPENING_BALANCE',quantity:1,price:10,value:10,comments:'paid pre-existing lot'},f.raw.trades.trades[0]]};
 const io=transport(f),reader=new SharesightCloudReader({clientId:'synthetic',clientSecret:'synthetic',fetchImpl:io.fetchImpl,reconcileInKind:true,managementExemptionRegistry:f.managementExemptionRegistry});
 const raw=await reader.readOnce(D),out=normalizeRead(raw,D,{spy:100,qqq:100,spyd:0,qqqd:0});
 const {proposals,...input}=out.managementInput;
 const result=resolveManagementExemptions({registry:f.managementExemptionRegistry,input,date:D,accounts:out.accounts});
 assert.equal(result.rows[0].valueUsd,20,'only the registered gifted lot is exempt, not the pre-existing paid lot');
 assert.equal(out.flows.length,0);assert.equal(consumeManagedTransferProof(raw.webull.managedTransferProof,'webull',D).length,0);
 const unknown=new SharesightCloudReader({clientId:'synthetic',clientSecret:'synthetic',fetchImpl:transport(f).fetchImpl,reconcileInKind:true});
 const sourceOnly=normalizeRead(await unknown.readOnce(D),D,{spy:100,qqq:100,spyd:0,qqqd:0});assert.equal(sourceOnly.flows.length,0);
});
function useHoldingPrincipal(f,amount,opening=2000){
 const t=f.raw.trades.trades[0],order='ABCDEF0123456789ABCD';
 t.comments=`Webull account 10205226; ${D} source; order ${order}; synthetic gifted-or-paid identity.`;
 const row=f.raw.cashTransactions[8].cash_account_transactions[0]||{id:333,cash_account_id:8,date_time:D+'T04:00Z',cash_account_transaction_type:{name:'WITHDRAWAL'},trade_id:null,payout_id:null};
 Object.assign(row,{amount,balance:opening+amount,holding_id:4,
  description:`Webull SYNTH BUY securities principal; NOT external funding; order ${order}; holding 4; ${D} 09:30:00 EDT; source fee USD 0.00.`});
 f.raw.cashTransactions[8].cash_account_transactions=[row];
 f.raw.previousPerformance.report.cash_accounts[0].value=opening;
 f.raw.previousPerformance.report.value=opening+f.raw.previousPerformance.report.holdings[0].value;
 f.raw.performance.report.cash_accounts[0].value=opening+amount;
 f.raw.performance.report.value=opening+amount+f.raw.performance.report.holdings[0].value;
 return row;
}
test('holding plus unique legacy order remains related when economics fail, and selected BUY cannot hide that cash',async()=>{
 for(const amount of [-20,-999]){
  const f=selectedFixture();useHoldingPrincipal(f,amount);
  assert.deepEqual(resolve(f).relatedCash.get(222),[333]);
  assert.equal(resolve(f).cashForTrade.has(222),amount===-20);
  assert.throws(()=>buildManagedTransferProof(f),/CASH_LEG/);
  const reader=new SharesightCloudReader({clientId:'synthetic',clientSecret:'synthetic',fetchImpl:transport(f).fetchImpl,reconcileInKind:true,managedTransferIdentities:f.identifiedTransfers});
  await assert.rejects(reader.readOnce(D),/CASH_LEG/);
 }
 const none=selectedFixture();useHoldingPrincipal(none,0);none.raw.cashTransactions[8].cash_account_transactions=[];
 const reader=new SharesightCloudReader({clientId:'synthetic',clientSecret:'synthetic',fetchImpl:transport(none).fetchImpl,reconcileInKind:true,managedTransferIdentities:none.identifiedTransfers});
 const raw=await reader.readOnce(D),out=normalizeRead(raw,D,{spy:100,qqq:100,spyd:0,qqqd:0});
 assert.equal(out.flows.length,1);assert.equal(out.flows[0].evidence,'external_asset_transfer');assert.equal(out.flows[0].amount,20);
});
test('same holding alone never turns an unrelated dividend into trade principal',()=>{
 const f=selectedFixture(),row=useHoldingPrincipal(f,5);
 Object.assign(row,{description:'Synthetic confirmed dividend',payout_id:7,cash_account_transaction_type:{name:'DEPOSIT'}});
 assert.equal(resolve(f).relatedCash.has(222),false);
 assert.equal(consumeManagedTransferProof(buildManagedTransferProof(f),'webull',D).length,1,'separate income evidence is outside this transfer relation');
});
test('source cash remains a cash expense beside a zero-cost BUY, without making external capital',async()=>{
 const f=giftFixture();useHoldingPrincipal(f,-0.01);
 f.history={trades:[{...f.raw.trades.trades[0],id:111,transaction_date:P,description_code:'OPENING_BALANCE',quantity:1,price:10,value:10,comments:'paid prior lot'},f.raw.trades.trades[0]]};
 delete f.managementExemptionRegistry;
 const reader=new SharesightCloudReader({clientId:'synthetic',clientSecret:'synthetic',fetchImpl:transport(f).fetchImpl,reconcileInKind:true});
 const out=normalizeRead(await reader.readOnce(D),D,{spy:100,qqq:100,spyd:0,qqqd:0});
 assert.equal(out.flows.length,1);assert.equal(out.flows[0].amount,-0.01);
 assert.equal(classifyFlow(out.flows[0]).kind,'internal');
 assert.equal(out.flows.some(x=>x.evidence==='external_asset_transfer'),false);
});
test('actual source zero-cost BUY is chargeable unless an existing exemption explicitly covers its lot; fees and TWR are unchanged',async()=>{
 const f=giftFixture();f.raw.performance.report.cash_accounts[0].value=100;f.raw.performance.report.value=130;
 f.managementExemptionRegistry.entries[0].giftTradeIds=[111];
 f.history={trades:[{...f.raw.trades.trades[0],id:111,transaction_date:P,description_code:'OPENING_BALANCE',quantity:1,price:0,value:0,comments:'synthetic prior gifted lot'},f.raw.trades.trades[0]]};
 const read=async f=>{const reader=new SharesightCloudReader({clientId:'synthetic',clientSecret:'synthetic',fetchImpl:transport(f).fetchImpl,reconcileInKind:true,managementExemptionRegistry:f.managementExemptionRegistry});return normalizeRead(await reader.readOnce(D),D,{spy:100,qqq:100,spyd:0,qqqd:0});};
 const out=await read(f),{proposals,...input}=out.managementInput;
 const m=resolveManagementExemptions({registry:f.managementExemptionRegistry,input,date:D,accounts:out.accounts});
 assert.equal(m.rows[0].valueUsd,10,'only the older registered gift is exempt; the new value20 is chargeable');
 assert.deepEqual(m.registry,f.managementExemptionRegistry);assert.equal(out.flows.length,0);
 const r=periodReturns({points:[{d:D,tot:130,managementExemptUsd:10}],flowByDate:{},from:D,to:D,openT:110,days:1,rate:0.01,cr:0.2,cumBefore:0,hwmBefore:0});
 assert.equal(r.averageFeeBase,120);assert.equal(r.pnl,20);assert.equal(r.carry,4);assert.equal(r.rG,130/110-1);
 const none=structuredClone(f);delete none.managementExemptionRegistry;assert.equal((await read(none)).flows.length,0);
 for(const change of [f=>f.raw.trades.trades[0].portfolio_id++,f=>f.raw.trades.trades[0].transaction_date=P,
  f=>f.raw.trades.trades[0].state='pending',f=>f.raw.trades.trades.push({...f.raw.trades.trades[0]}),
  f=>f.raw.trades.has_more=true,f=>f.raw.cashTransactions[8].has_more=true]){
  const bad=structuredClone(f);change(bad);await assert.rejects(read(bad),/FEE_/,change.toString());
 }
});
test('a bare deposit remains unresolved; principal declarations need no cash-to-trade join',async()=>{
 for(const [desc,kind]of [['unclassified incoming cash','unresolved'],['approved=true noncash BUY','unresolved']]){
  const f=fixture('SELL','short');const row=f.raw.cashTransactions[8].cash_account_transactions[0];row.description=desc;
  const reader=new SharesightCloudReader({clientId:'synthetic',clientSecret:'synthetic',fetchImpl:transport(f).fetchImpl,reconcileInKind:true});
  const out=normalizeRead(await reader.readOnce(D),D,{spy:100,qqq:100,spyd:0,qqqd:0});
  const flow=out.flows.find(x=>x.acct==='webull');assert.equal(classifyFlow(flow).kind,kind);
  assert.notEqual(classifyFlow(flow).effective,true);
 }
 const f=fixture('SELL','short');f.raw.trades.trades=[];
 const reader=new SharesightCloudReader({clientId:'synthetic',clientSecret:'synthetic',fetchImpl:transport(f).fetchImpl,reconcileInKind:true});
 const out=normalizeRead(await reader.readOnce(D),D,{spy:100,qqq:100,spyd:0,qqqd:0});
 assert.equal(classifyFlow(out.flows.find(x=>x.acct==='webull')).kind,'internal');
 assert.equal(out.flows.filter(x=>x.evidence==='external_asset_transfer').length,0);
});
test('selected transfer cash is never hidden by conflicting or unlisted source pointers',()=>{
 for(const change of [row=>row.trade_id=999,row=>row.description=row.description.replace('Trade222','Trade999')]){
  const f=selectedFixture();change(f.raw.cashTransactions[8].cash_account_transactions[0]);
  if(f.raw.cashTransactions[8].cash_account_transactions[0].trade_id==null)f.raw.cashTransactions[8].cash_account_transactions[0].trade_id=222;
  assert.throws(()=>buildManagedTransferProof(f),/CASH_LEG/);
 }
 const malformed=selectedFixture();malformed.raw.cashTransactions[8].cash_account_transactions[0].description+=' unknown source suffix';
 assert.throws(()=>buildManagedTransferProof(malformed),/CASH_LEG/,'a related cash leg remains a leg even when its principal-role declaration is malformed');
});
test('the actual reader cannot turn an unmapped opening balance into new capital or request a transfer peer',async()=>{
 const f=selectedFixture();f.raw.trades.trades[0].description_code='OPENING_BALANCE';delete f.identifiedTransfers;
 const io=transport(f),reader=new SharesightCloudReader({clientId:'synthetic',clientSecret:'synthetic',fetchImpl:io.fetchImpl,reconcileInKind:true});
 await assert.rejects(reader.readOnce(D),/IDENTIFIED_SCOPE/);
 assert.ok(!io.calls.some(p=>p.includes('/77/')),'unknown capital semantics stop before an additional peer read');
});

const refRead=async f=>{const io=transport(f),reader=new SharesightCloudReader({clientId:'synthetic',clientSecret:'synthetic',fetchImpl:io.fetchImpl,reconcileInKind:true,managedTransferIdentities:f.identifiedTransfers,managementExemptionRegistry:f.managementExemptionRegistry,sourceMode:'sharesight-reference'});const raw=await reader.readOnce(D);return {raw,input:normalizeRead(raw,D,{spy:100,qqq:100,spyd:0,qqqd:0},{sourceMode:'sharesight-reference'}),io};};
test('reference actual reader uses complete current NAV/cash without predecessor, running balances, cash history or ordinary catalog replay',async()=>{
 const f=fixture();delete f.raw.previousPerformance;delete f.raw.cashTransactions[8].cash_account_transactions[0].balance;
 f.extraCatalog=[{...f.raw.performance.report.holdings[0],id:999,inception_date:'2026-10-29'}];
 const {raw,input,io}=await refRead(f);
 assert.equal(input.accounts.webull,f.raw.performance.report.value);assert.equal(input.acctCash.webull,f.raw.performance.report.cash_accounts[0].value);
 assert.deepEqual(input.prevAcctCash,{});assert.equal(input.sourceReference.cashHistoryReconstructed,false);
 assert.ok(input.sourceReference.warnings.includes('CATALOG_SCOPE_DIFF'));assert.equal(input.flows.length,1);
 assert.ok(io.calls.filter(p=>p.includes('/cash_account_transactions.json')).every(p=>p.includes('from='+D)&&p.includes('to='+D)));
 assert.ok(!io.calls.some(p=>p.includes('include_sales=true')||p.includes('start_date='+P)));
 assert.deepEqual(raw.webull.cashLedgerHistory,{});assert.equal(raw.webull.previousPerformance,undefined);
 assert.throws(()=>normalizeRead(raw,D,{spy:100,qqq:100,spyd:0,qqqd:0}),/CASH_HISTORY_EVIDENCE/,'raw source data cannot silently select reference mode');
});
test('reference auxiliary balance differences warn without recalculating the report NAV or cash',async()=>{
 const f=fixture('SELL','net');f.cashAuxiliaryOffset=3;f.raw.cashTransactions[8].cash_account_transactions[0].balance=-999;
 const {input}=await refRead(f);assert.equal(input.accounts.webull,f.raw.performance.report.value);
 assert.equal(input.sourceReference.cashByAccount.webull,f.raw.performance.report.cash_accounts[0].value);
 assert.ok(input.sourceReference.warnings.includes('AUXILIARY_CASH_BALANCE_DIFF'));
 assert.equal(input.flows.length,1);assert.equal(input.flows[0].amount,f.raw.cashTransactions[8].cash_account_transactions[0].amount);
});
test('reference unknown current cash is preserved and still blocks financial publication',async()=>{
 const f=fixture('SELL');f.raw.cashTransactions[8].cash_account_transactions[0].description='unknown source cash';
 const {input}=await refRead(f),r=reconcileFlows([],[],input.flows,{reference:true});assert.equal(r.unresolved.length,1);
 const {assertCandidateReceiptable}=await import('./fee-cloud-producer.mjs');assert.throws(()=>assertCandidateReceiptable({flowsUnresolved:r.unresolved}),/UNRESOLVED_FLOW/);
});
test('reference preserves internal foreign-currency source amounts and rejects unvalued external or unknown foreign cash',async()=>{
 const f=fixture('BUY','native');f.cashCurrency='HKD';f.cashNativeBalance=800;f.raw.performance.report.cash_accounts[0].currency.code='HKD';
 const {input}=await refRead(f);assert.equal(input.flows[0].currency,'HKD');assert.equal(input.flows[0].amount,f.raw.cashTransactions[8].cash_account_transactions[0].amount);
 assert.equal(input.sourceReference.cashByAccount.webull,f.raw.performance.report.cash_accounts[0].value);
 for(const desc of ['unclassified source cash','external bank transfer']){const bad=structuredClone(f),row=bad.raw.cashTransactions[8].cash_account_transactions[0];row.trade_id=null;row.description=desc;await assert.rejects(refRead(bad),/NON_USD_EXTERNAL_FLOW/);}
});
test('reference zero-valued source cash stays present but cannot manufacture external capital',async()=>{
 const f=fixture();f.raw.cashTransactions[8].cash_account_transactions[0].amount=0;f.raw.cashTransactions[8].cash_account_transactions[0].description='source zero record';
 const {input}=await refRead(f);assert.equal(input.flows.length,1);assert.equal(input.flows[0].amount,0);
 const r=reconcileFlows([],[],input.flows,{reference:true});assert.equal(r.auto.length,0);assert.equal(r.unresolved.length,0);
});
test('reference never converts a nonzero sub-cent native source movement into a zero internal flow',async()=>{
 for(const currency of ['USD','HKD'])for(const amount of [0.004,-0.004,0.0001,-0.0001]){
  const f=fixture(),row=f.raw.cashTransactions[8].cash_account_transactions[0];
  f.cashCurrency=currency;f.raw.performance.report.cash_accounts[0].currency.code=currency;
  Object.assign(row,{amount,trade_id:null,holding_id:null,description:'unknown sub-cent source cash',cash_account_transaction_type:{name:'DEPOSIT'}});
  await assert.rejects(refRead(f),/^Error: FEE_CLOUD_AMOUNT$/);
 }
 for(const original of ['1e-400','-1e-400']){
  const f=fixture();f.raw.cashTransactions[8].cash_account_transactions[0].amount=0;
  const {raw}=await refRead(f),text=JSON.stringify(raw.webull.cashTransactions[8]).replace('"amount":0','"amount":'+original);
  raw.webull.cashTransactions[8]=parseSourceJson(text);
  assert.throws(()=>normalizeRead(raw,D,{spy:100,qqq:100,spyd:0,qqqd:0},{sourceMode:'sharesight-reference'}),/^Error: FEE_CLOUD_AMOUNT$/);
 }
 const f=fixture(),row=f.raw.cashTransactions[8].cash_account_transactions[0];
 Object.assign(row,{amount:0.01,trade_id:null,holding_id:null,description:'unknown explicit one-cent source cash',cash_account_transaction_type:{name:'DEPOSIT'}});
 const {input}=await refRead(f),r=reconcileFlows([],[],input.flows,{reference:true});
 assert.equal(input.flows[0].amount,0.01);assert.equal(r.unresolved.length,1);
});
test('reference selected transfer still requires dated positions, valuation and absence of any related cash; replays add no capital',async()=>{
 const f=selectedFixture();useHoldingPrincipal(f,0);f.raw.cashTransactions[8].cash_account_transactions=[];
 const {input,io}=await refRead(f);assert.equal(input.flows.length,1);assert.equal(input.flows[0].evidence,'external_asset_transfer');
 assert.ok(io.calls.some(p=>p.includes('/77/')&&p.includes('start_date='+P)));
 const r=reconcileFlows([],[],input.flows,{reference:true});assert.equal(reconcileFlows(r.auto,[],input.flows,{reference:true}).auto.length,1);
 for(const change of [x=>useHoldingPrincipal(x,-20),x=>x.peer.trades.trades[0].price=1,x=>x.identifiedTransfers.pairs[0].sourceTradeId++,x=>x.raw.previousPerformance.report.end_date=D]){
  const bad=structuredClone(f);change(bad);await assert.rejects(refRead(bad),/FEE_/);
 }
});
test('reference retains full history solely for an existing gift exemption, with unchanged lot arithmetic',async()=>{
 const f=giftFixture();f.raw.performance.report.cash_accounts[0].value=100;f.raw.performance.report.value=130;
 f.history={trades:[{...f.raw.trades.trades[0],id:111,transaction_date:P,description_code:'OPENING_BALANCE',quantity:1,price:10,value:10,comments:'prior paid lot'},f.raw.trades.trades[0]]};
 const {input,io}=await refRead(f),{proposals,...m}=input.managementInput;
 assert.equal(resolveManagementExemptions({registry:f.managementExemptionRegistry,input:m,date:D,accounts:input.accounts}).rows[0].valueUsd,20);
 assert.ok(io.calls.some(p=>p.includes('/trades.json?')&&!p.includes('start_date=')));
 assert.ok(io.calls.filter(p=>p.includes('/cash_account_transactions.json')).every(p=>p.includes('from=')));
 assert.equal(input.flows.length,0);
});
test('reference still rejects incomplete, duplicate, wrong-date/identity, missing and nonfinite actually used source fields',async()=>{
 for(const change of [x=>x.raw.performance.has_more=true,x=>x.raw.performance.report.end_date=P,x=>delete x.raw.performance.report.cash_accounts,
  x=>x.raw.performance.report.value=null,x=>x.raw.trades.trades[0].portfolio_id++,x=>x.raw.cashTransactions[8].has_more=true,
  x=>x.raw.cashTransactions[8].cash_account_transactions[0].amount=null,x=>x.raw.cashTransactions[8].cash_account_transactions[0].date_time=P+'T00:00Z',
  x=>x.raw.cashTransactions[8].cash_account_transactions.push({...x.raw.cashTransactions[8].cash_account_transactions[0]})]){
  const f=fixture();change(f);await assert.rejects(refRead(f),/FEE_/);
 }
});
}
