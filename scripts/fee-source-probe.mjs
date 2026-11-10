#!/usr/bin/env node
// Read-only Sharesight source probe: one owner-dispatched, exact-main job that
// repeats only the ordinary fixed fee source requests for one target date and
// reports a fixed stage plus the existing value-free transport categories.
//
// Covered: OAuth token, portfolio list and, for each fee account, the dated
// performance, holdings, dated cash accounts, dated trades (fetched together,
// as the ordinary reader does) and each listed cash account's dated
// transactions. NOT covered: payout, historical-trade and IB peer routes,
// which depend on private income, gift-registry or managed-transfer context;
// the IB manager reader; normalization, stability re-read, fee calculation,
// or any acceptance of the three accounts. A success means only that these
// requests answered with complete JSON at that time.
//
// It never reads data.json, the economic source, FEE_DATA_KEY or the
// benchmark cache; writes no file, candidate, issue, label or artifact; never
// retries, follows a redirect or a page; and stops at the first failure.
// Time: each request keeps the ordinary 20 s transport deadline; the whole
// probe (including the two GitHub checks) returns by the 120 s overall
// deadline, which also aborts any request still in flight.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {types} from 'node:util';
import {SharesightCloudReader,CLOUD_ACCOUNTS,feeSourceTransportDiagnostic} from './fee-cloud-source.mjs';
import {boundedJson} from './fee-http-json.mjs';

export const SOURCE_PROBE_TITLE='Fee source probe';
export const SOURCE_PROBE_INPUTS=Object.freeze(['source_probe_once','source_probe_main','source_probe_target']);
export const SOURCE_PROBE_STAGES=Object.freeze(['ADMISSION','LIVE_MAIN','CURRENT_RUN','TOKEN','PORTFOLIOS','ACCOUNT_ROUTES','CASH_TRANSACTIONS','COMPLETE']);
// Two accounts x (4 dated routes + at most 8 cash accounts) + token + list.
export const SOURCE_PROBE_BUDGET=Object.freeze({requests:26,cashAccountsPerPortfolio:8,overallMs:120000,githubRequests:2});
const REPO='huanwujoy-crypto/fee-console',OWNER=283054367,WORKFLOW='.github/workflows/fee-cloud-producer.yml';
const API='https://api.sharesight.com',GITHUB='https://api.github.com/repos/'+REPO;
const OFF=['ib_diagnostic_once','ib_envelope_once','source_plan_check_only','source_acceptance_once','run_reviewed_once'];
const BLANK=['ib_diagnostic_main','ib_envelope_main','ratio_main','ratio_plan','source_from','source_target','source_main','manual_sync_completed_for','confirmed_main','recovery_main','report_kind','report_target','report_markets'];
const PRIVATE=['FEE_CLOUD_SHARESIGHT_CLIENT_ID','FEE_CLOUD_SHARESIGHT_CLIENT_SECRET'];
const FORBIDDEN=['NODE_OPTIONS','NODE_PATH','GH_TOKEN','GITHUB_TOKEN','FEE_DATA_KEY','FEE_ECON_GIST_ID','FEE_ECON_GITHUB_TOKEN','FEE_ECON_FILE','FEE_ECON_V3_FILE',
  'FEE_CLOUD_GITHUB_TOKEN','FEE_RATIO_MANAGER_TOKEN','FEE_IB_DIAGNOSTIC_ACTIONS_TOKEN','IB_MANAGER_READ_ENABLED','IB_MANAGER_BASELINE_SHA256','RATIO_STORAGE_ACCESS_TOKEN',
  'FEE_REPORT_ONCE_MAIN','FEE_AUTOMATIC_DAILY_REQUEST','BENCHMARK_CACHE_PATH'];
const CLOUD_CREDENTIAL_PATHS=['GOOGLE_APPLICATION_CREDENTIALS','CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE','GOOGLE_GHA_CREDS_PATH'];
// Fixed public codes only. Any other failure is PROBE_FAILED.
export const SOURCE_PROBE_CODES=Object.freeze([
  ...['ARGUMENT','ENVIRONMENT','EVENT','TARGET_DATE','LIVE_MAIN','RUN','BUDGET','DEADLINE','IDENTITY','INCOMPLETE','SHAPE','FAILED'].map(c=>'PROBE_'+c),
  ...['SOURCE_UNAVAILABLE','AUTH_UNAVAILABLE','AUTH_REJECTED','AUTH_RESPONSE','HTTP_REJECTED','RESPONSE_JSON','RESPONSE_TYPE','RESPONSE_SIZE',
    'RESPONSE_BODY','RESPONSE_CONFIG','RESPONSE_CREDENTIAL','ROUTE_BLOCKED','CREDENTIALS','CONFIG','PORTFOLIO_IDENTITY','DATE','ID'].map(c=>'FEE_CLOUD_'+c)]);
class ProbeError extends Error{constructor(code){super('PROBE_'+code);}}
const fail=code=>{throw new ProbeError(code);};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
const hkDate=ms=>new Date(ms+8*3600000).toISOString().slice(0,10);
const off=v=>v===undefined||v===false||v==='false',blank=v=>v===undefined||v==='';

export function sourceProbeArgs(argv){
  let expectedMain,target,checkOnly=false;
  for(const arg of argv){
    if(arg==='--check-plan'&&!checkOnly)checkOnly=true;
    else if(typeof arg==='string'&&/^--expected-main=[a-f0-9]{40}$/.test(arg)&&expectedMain===undefined)expectedMain=arg.slice(16);
    else if(typeof arg==='string'&&/^--target=\d{4}-\d{2}-\d{2}$/.test(arg)&&target===undefined)target=arg.slice(9);
    else fail('ARGUMENT');
  }
  if(!expectedMain||!date(target))fail('ARGUMENT');
  return Object.freeze({expectedMain,target,checkOnly});
}
// Exact owner dispatch of this job only, at the exact main, first attempt; the
// target is the owner's own input, at most four Hong Kong days old, not future.
export function validateSourceProbeAdmission({args,env,event,now}){
  if(!simpleEnv(env)||env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!==REPO||env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_SHA!==args.expectedMain
    ||env.GITHUB_EVENT_NAME!=='workflow_dispatch'||env.GITHUB_ACTOR_ID!==String(OWNER)||env.GITHUB_RUN_ATTEMPT!=='1'||!/^\d{8,16}$/.test(env.GITHUB_RUN_ID||'')
    ||typeof env.FEE_REPORT_ACTIONS_TOKEN!=='string'||env.FEE_REPORT_ACTIONS_TOKEN.length<20||env.FEE_REPORT_ACTIONS_TOKEN.length>4096||/\s/.test(env.FEE_REPORT_ACTIONS_TOKEN)
    ||FORBIDDEN.some(k=>env[k]!==undefined)||CLOUD_CREDENTIAL_PATHS.some(k=>env[k]!==undefined&&env[k]!=='')
    ||(args.checkOnly?PRIVATE.some(k=>env[k]!==undefined):PRIVATE.some(k=>typeof env[k]!=='string'||!env[k]||env[k].length>8192||/[\r\n\0]/.test(env[k]))))fail('ENVIRONMENT');
  const i=event?.inputs;
  if(!object(event)||event.sender?.id!==OWNER||event.repository?.full_name!==REPO||!object(i)
    ||Object.keys(i).some(k=>![...SOURCE_PROBE_INPUTS,...OFF,...BLANK].includes(k))
    ||![true,'true'].includes(i.source_probe_once)||i.source_probe_main!==args.expectedMain||i.source_probe_target!==args.target
    ||OFF.some(k=>!off(i[k]))||BLANK.some(k=>!blank(i[k])))fail('EVENT');
  const clock=now.getTime();if(!Number.isFinite(clock))fail('TARGET_DATE');
  const age=(Date.parse(hkDate(clock)+'T00:00:00Z')-Date.parse(args.target+'T00:00:00Z'))/86400000;
  if(!Number.isInteger(age)||age<0||age>4)fail('TARGET_DATE');
}
function simpleEnv(env){return !!env&&typeof env==='object'&&!types.isProxy(env);}
async function githubChecks({args,env,githubFetch}){
  let calls=0;const get=async route=>{if(++calls>SOURCE_PROBE_BUDGET.githubRequests)fail('BUDGET');
    try{return await boundedJson(githubFetch,GITHUB+route,{method:'GET',headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',Authorization:'Bearer '+env.FEE_REPORT_ACTIONS_TOKEN}},{timeoutMs:10000,maxBytes:1024*1024});}
    catch{return null;}};
  const ref=await get('/git/ref/heads/main');if(ref?.object?.sha!==args.expectedMain)fail('LIVE_MAIN');
  return get;
}
// The same pagination / incomplete markers the ordinary reader rejects
// (fee-cloud-source assertComplete), shared by every listed payload and by
// the performance payload and its report, exactly as the ordinary reader does.
function complete(payload){
  if(!object(payload))return;
  if(payload.links?.next||payload.pagination?.next_page||payload.meta?.pagination?.next_page||payload.meta?.next_page
    ||payload.next_page||payload.has_more===true||payload.complete===false||payload.restricted===true||payload.limited===true||payload.truncated===true)fail('INCOMPLETE');
}
function listed(payload,key){
  if(!object(payload))fail('SHAPE');complete(payload);
  if(!Array.isArray(payload[key]))fail('SHAPE');return payload[key];
}
const safeCode=error=>{const m=String(error?.message||'');return SOURCE_PROBE_CODES.includes(m)?m:'PROBE_FAILED';};

// The overall deadline is a hard bound on the returned result: a timer from
// the start aborts every in-flight source request (linked signal) and the
// result is returned at the deadline even if a transport ignores the abort.
// No new request is started once the deadline has passed.
export async function runSourceProbe(options={}){
  const state={budgetExceeded:false,deadlineExceeded:false},deadline=new AbortController(),result=newResult();
  let timer;
  const expired=new Promise(resolve=>{timer=setTimeout(()=>{state.deadlineExceeded=true;deadline.abort();resolve();},SOURCE_PROBE_BUDGET.overallMs);});
  const work=probeWork(options,result,state,deadline.signal);
  try{
    const done=await Promise.race([work.then(()=>true),expired.then(()=>false)]);
    if(done)return result;
    work.catch(()=>{});
    return {...result,outcome:'FAILED',code:'PROBE_DEADLINE',diagnostic:null};
  }finally{clearTimeout(timer);}
}
const newResult=()=>({schema:'fee-console.source-probe.v1',mode:'probe',outcome:'FAILED',stage:'ADMISSION',code:null,diagnostic:null,requests:0,requestBudget:SOURCE_PROBE_BUDGET.requests});
async function probeWork({argv,env,event,now=new Date(),fetchImpl=globalThis.fetch,githubFetch=globalThis.fetch,clock=()=>Date.now()}={},result,state,deadlineSignal){
  const started=clock();
  try{
    const args=sourceProbeArgs(argv);result.mode=args.checkOnly?'check-plan':'probe';
    validateSourceProbeAdmission({args,env,event,now});
    result.stage='LIVE_MAIN';const get=await githubChecks({args,env,githubFetch});
    result.stage='CURRENT_RUN';
    const run=await get('/actions/runs/'+env.GITHUB_RUN_ID);
    if(String(run?.id)!==env.GITHUB_RUN_ID||run.head_sha!==args.expectedMain||run.head_branch!=='main'||run.path!==WORKFLOW||run.event!=='workflow_dispatch'
      ||run.actor?.id!==OWNER||run.run_attempt!==1||run.status!=='in_progress'||run.conclusion!==null||run.display_title!==SOURCE_PROBE_TITLE)fail('RUN');
    if(args.checkOnly){result.stage='COMPLETE';result.outcome='PLAN_OK';return result;}
    // Fixed request set; the cap and the overall deadline are enforced before
    // each request is handed to the transport, which never retries.
    const budgeted=async(url,init)=>{
      if(result.requests>=SOURCE_PROBE_BUDGET.requests){state.budgetExceeded=true;throw new TypeError('probe budget');}
      if(state.deadlineExceeded||deadlineSignal.aborted||clock()-started>SOURCE_PROBE_BUDGET.overallMs){state.deadlineExceeded=true;throw new TypeError('probe deadline');}
      result.requests++;
      const signal=init?.signal?AbortSignal.any([init.signal,deadlineSignal]):deadlineSignal;
      return fetchImpl(url,{...init,signal});
    };
    const reader=new SharesightCloudReader({clientId:env.FEE_CLOUD_SHARESIGHT_CLIENT_ID,clientSecret:env.FEE_CLOUD_SHARESIGHT_CLIENT_SECRET,fetchImpl:budgeted,sourceMode:'sharesight-reference'});
    result.stage='TOKEN';let token=await reader.token();
    result.stage='PORTFOLIOS';
    let rows=listed(await reader.get(API+'/api/v2/portfolios.json',token),'portfolios');
    const accounts=Object.values(CLOUD_ACCOUNTS).map(expected=>{
      const matches=rows.filter(row=>object(row)&&String(row.id)===String(expected.portfolioId)&&row.name===expected.name);
      if(matches.length!==1||matches[0].currency_code!=='USD')fail('IDENTITY');return expected.portfolioId;});
    rows=null;
    for(const portfolioId of accounts){
      result.stage='ACCOUNT_ROUTES';
      const base3=`${API}/api/v3/portfolios/${portfolioId}`,d=args.target;
      const [performance,holdings,cashAccounts,trades]=await Promise.all([
        reader.get(`${base3}/performance?consolidated=false&end_date=${d}&grouping=investment_type&include_limited=false&include_sales=false&report_combined=false&start_date=${d}`,token),
        reader.get(`${base3}/holdings?consolidated=false`,token),
        reader.get(`${API}/api/v2/portfolios/${portfolioId}/cash_accounts.json?date=${d}`,token),
        reader.get(`${base3}/trades.json?consolidated=false&end_date=${d}&start_date=${d}`,token)]);
      if(!object(performance))fail('SHAPE');complete(performance);if(!object(performance.report))fail('SHAPE');complete(performance.report);listed(holdings,'holdings');listed(trades,'trades');
      const cashIds=listed(cashAccounts,'cash_accounts').map(row=>Number(row?.id));
      if(cashIds.length>SOURCE_PROBE_BUDGET.cashAccountsPerPortfolio||cashIds.some(id=>!Number.isSafeInteger(id)||id<=0)||new Set(cashIds).size!==cashIds.length)fail('SHAPE');
      result.stage='CASH_TRANSACTIONS';
      for(const cashId of cashIds)listed(await reader.get(`${API}/api/v2/cash_accounts/${cashId}/cash_account_transactions.json?from=${d}&to=${d}`,token),'cash_account_transactions');
    }
    token=null;
    result.stage='COMPLETE';result.outcome='ROUTES_READ';return result;
  }catch(error){
    result.code=state.budgetExceeded?'PROBE_BUDGET':state.deadlineExceeded?'PROBE_DEADLINE':safeCode(error);
    const t=state.budgetExceeded||state.deadlineExceeded?null:feeSourceTransportDiagnostic(error);
    result.diagnostic=t?{route:t.route,phase:t.phase,category:t.category}:null;
    return result;
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  (async()=>{
    let event=null;try{const p=process.env.GITHUB_EVENT_PATH;if(p&&fs.statSync(p).size<=256*1024)event=JSON.parse(fs.readFileSync(p,'utf8'));}catch{event=null;}
    const result=await runSourceProbe({argv:process.argv.slice(2),env:process.env,event});
    console.log(JSON.stringify(result));
    process.exitCode=['PLAN_OK','ROUTES_READ'].includes(result.outcome)?0:1;
  })().catch(()=>{console.log(JSON.stringify({schema:'fee-console.source-probe.v1',outcome:'FAILED',code:'PROBE_FAILED'}));process.exitCode=1;});
}
