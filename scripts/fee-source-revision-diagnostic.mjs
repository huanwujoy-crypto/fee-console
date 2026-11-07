// Exact-release, read-only diagnosis of the reviewed historical-source revision.
// No report writer, branch creation, once claim, benchmark, or publication call.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {types} from 'node:util';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {boundedJson} from './fee-http-json.mjs';
import {dailyReportPlan} from './fee-report-period.mjs';
import {authorizeHistoricalRevisionDiagnostic,readReportRecoveryRelease,readCurrentSyncRun} from './fee-report-producer.mjs';
import {readPublicationState,decryptCandidate,safeProducerFailureSummary} from './fee-cloud-producer.mjs';
import {fetchEconomicSnapshot,economicSourceDiagnosticCode} from './fee-economic-source.mjs';
import {createFeeSourceRevisionRuntime,sourceRevisionRuntimeFailureCode} from './fee-source-revision-runtime.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const REPO='huanwujoy-crypto/fee-console',OWNER=283054367,OID=/^[a-f0-9]{40}$/,SHA=/^[a-f0-9]{64}$/;
const ERRORS=new WeakMap(),CODES=new Set(['ARGUMENT','ENVIRONMENT','HEAD','EXPIRED','ROUTE','READ','BASE_CHANGED','RESULT','CLEANUP','FAILED']);
export const REVISION_DIAGNOSTIC_SCOPE=Object.freeze({targetDate:'2026-11-06',anchorDate:'2026-11-04',previousDate:'2026-11-05',durationMs:14*60000});
const failure=code=>{const e=new Error('FEE_REVISION_DIAGNOSTIC_'+code);ERRORS.set(e,code);return Object.freeze(e);};
const fail=code=>{throw failure(code);};
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const simple=v=>v&&typeof v==='object'&&!types.isProxy(v)&&Object.getPrototypeOf(v)===Object.prototype;
const credential=v=>typeof v==='string'&&v.length>0&&v.length<=8192&&!/[\r\n\0]/.test(v);
const EMPTY=['ratio_main','ratio_plan','source_from','source_target','source_main','manual_sync_completed_for','confirmed_main','recovery_main','report_kind','report_target','report_markets'];
const DISABLED=['source_plan_check_only','source_acceptance_once','run_reviewed_once'];
const PRIVATE=['FEE_DATA_KEY','FEE_CLOUD_SHARESIGHT_CLIENT_ID','FEE_CLOUD_SHARESIGHT_CLIENT_SECRET','FEE_ECON_GIST_ID'];
const FORBIDDEN=['NODE_OPTIONS','NODE_PATH','GH_TOKEN','GITHUB_TOKEN','FEE_CLOUD_GITHUB_TOKEN','FEE_RATIO_MANAGER_TOKEN','FEE_ECON_GITHUB_TOKEN','FEE_ECON_FILE','FEE_ECON_V3_FILE','FEE_IB_DIAGNOSTIC_ACTIONS_TOKEN'];
const GITHUB_READ_ROUTE=/^(?:git\/ref\/heads\/main|commits\/[a-f0-9]{40}(?:\?per_page=1|\/pulls\?per_page=100)?|git\/commits\/[a-f0-9]{40}|git\/trees\/[a-f0-9]{40}(?:\?recursive=1)?|compare\/[a-f0-9]{40}\.\.\.[a-f0-9]{40}\?per_page=(?:1|100)|contents\/(?:data\.json|fee-data-health\.json)\?ref=[a-f0-9]{40}|git\/matching-refs\/heads\/codex\/fee-daily-20261106-|pulls\/[1-9]\d*|issues\/(?:[1-9]\d*\/comments\?per_page=100|comments\/[1-9]\d*)|actions\/runs\/[1-9]\d*(?:\/jobs\?per_page=100)?|actions\/jobs\/[1-9]\d*\/logs)$/;

export function revisionDiagnosticArgs(argv){
  let expectedMain,checkOnly=false;
  for(const arg of argv)if(arg==='--check-plan'&&!checkOnly)checkOnly=true;
  else if(typeof arg==='string'&&/^--expected-main=[a-f0-9]{40}$/.test(arg)&&expectedMain===undefined)expectedMain=arg.slice(16);
  else fail('ARGUMENT');
  if(!OID.test(expectedMain||''))fail('ARGUMENT');return Object.freeze({expectedMain,checkOnly});
}

export function validateRevisionDiagnosticEvent({env,event,expectedMain,checkOnly=false,execArgv=[]}={}){
  if(!simple(env)||!simple(event)||!OID.test(expectedMain||'')||typeof checkOnly!=='boolean'
    ||!Array.isArray(execArgv)||execArgv.length||FORBIDDEN.some(k=>Object.hasOwn(env,k))
    ||Object.keys(env).some(k=>/^(LD_|DYLD_)/.test(k))
    ||env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!==REPO||env.GITHUB_REF!=='refs/heads/main'
    ||env.GITHUB_SHA!==expectedMain||env.GITHUB_EVENT_NAME!=='workflow_dispatch'||env.GITHUB_ACTOR_ID!==String(OWNER)
    ||env.GITHUB_ACTOR!=='huanwujoy-crypto'||env.GITHUB_TRIGGERING_ACTOR!==undefined&&env.GITHUB_TRIGGERING_ACTOR!=='huanwujoy-crypto'
    ||env.GITHUB_RUN_ATTEMPT!=='1'||!/^[1-9]\d{7,15}$/.test(env.GITHUB_RUN_ID||'')
    ||!credential(env.FEE_REPORT_ACTIONS_TOKEN)||!/^[A-Za-z0-9_.-]{20,8192}$/.test(env.FEE_REPORT_ACTIONS_TOKEN)
    ||event.sender?.id!==OWNER||event.sender?.login!=='huanwujoy-crypto'||event.sender?.type!=='User'
    ||event.repository?.full_name!==REPO||event.repository?.owner?.id!==OWNER||event.repository?.default_branch!=='main')fail('ENVIRONMENT');
  const i=event.inputs;
  if(!simple(i)||![true,'true'].includes(i.ib_diagnostic_once)||i.ib_diagnostic_main!==expectedMain
    ||Object.keys(i).some(k=>!['ib_diagnostic_once','ib_diagnostic_main',...EMPTY,...DISABLED].includes(k))
    ||EMPTY.some(k=>i[k]!==undefined&&i[k]!=='')||DISABLED.some(k=>i[k]!==undefined&&![false,'false'].includes(i[k])))fail('ARGUMENT');
  if(checkOnly){if(PRIVATE.some(k=>Object.hasOwn(env,k)))fail('ENVIRONMENT');}
  else if(PRIVATE.some(k=>!credential(env[k]))||!SHA.test(env.IB_MANAGER_BASELINE_SHA256||'')
    ||env.IB_MANAGER_READ_ENABLED!=='true'||! /^(?:[a-f0-9]{20}|[a-f0-9]{32})$/.test(env.FEE_ECON_GIST_ID))fail('ENVIRONMENT');
  return true;
}

// All component readers still enforce their own narrower identity/path rules.
// This outer boundary adds a single deadline, GET-only non-OAuth calls, and an
// explicit ban on complete Actions listings, writes, and arbitrary hosts.
export function revisionDiagnosticTransport({fetchImpl=globalThis.fetch,clock=Date.now,durationMs=REVISION_DIAGNOSTIC_SCOPE.durationMs}={}){
  if(typeof fetchImpl!=='function'||typeof clock!=='function'||!Number.isSafeInteger(durationMs)||durationMs<1||durationMs>REVISION_DIAGNOSTIC_SCOPE.durationMs)fail('ENVIRONMENT');
  const started=clock(),controller=new AbortController();let closed=false,last=started;
  if(!Number.isSafeInteger(started)||started<0)fail('ENVIRONMENT');
  const timer=setTimeout(()=>controller.abort(),durationMs);timer.unref?.();
  const active=()=>{const now=clock();if(closed||controller.signal.aborted||!Number.isSafeInteger(now)||now<last||now-started>=durationMs)fail('EXPIRED');last=now;};
  const fetch=async(url,init={})=>{
    active();let u;try{u=new URL(url);}catch{fail('ROUTE');}
    const method=init.method||'GET',oauth=u.href==='https://api.sharesight.com/oauth2/token';
    const prefix='/repos/'+REPO+'/';
    const github=u.origin==='https://api.github.com'&&(u.pathname.startsWith(prefix)&&GITHUB_READ_ROUTE.test(u.pathname.slice(prefix.length)+u.search)
      ||/^\/gists\/(?:[a-f0-9]{20}|[a-f0-9]{32})$/.test(u.pathname)&&u.search==='');
    const logs=/^productionresultssa\d+\.blob\.core\.windows\.net$/.test(u.hostname)&&u.pathname.startsWith('/actions-results/');
    const sharesight=u.origin==='https://api.sharesight.com'&&/^\/api\/v[23]\//.test(u.pathname);
    if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||!(oauth||github||logs||sharesight)
      ||(oauth?method!=='POST':method!=='GET'||init.body!==undefined))fail('ROUTE');
    if(sharesight){
      if(new Set(u.searchParams.keys()).size!==u.searchParams.size)fail('ROUTE');
      for(const name of ['date','start_date','end_date','from','to'])if(u.searchParams.has(name)){
        const date=u.searchParams.get(name);if(!/^2026-11-0[456]$/.test(date))fail('ROUTE');
      }
    }
    const signal=init.signal?AbortSignal.any([init.signal,controller.signal]):controller.signal;
    let listener;
    const aborted=new Promise((_,reject)=>{listener=()=>reject(failure('EXPIRED'));if(signal.aborted)listener();else signal.addEventListener('abort',listener,{once:true});});
    try{const result=await Promise.race([fetchImpl(url,{...init,redirect:init.redirect==='manual'?'manual':'error',signal}),aborted]);active();return result;}
    finally{signal.removeEventListener('abort',listener);}
  };
  return Object.freeze({fetch,assertCurrent:active,close(){closed=true;clearTimeout(timer);controller.abort();}});
}

export function revisionDiagnosticFailureCode(error){
  const economic=economicSourceDiagnosticCode(error);
  if(economic!=='UNKNOWN')return 'FEE_REVISION_DIAGNOSTIC_ECON_INITIAL_'+economic.replace(/^SOURCE_/,'');
  const own=ERRORS.get(error);if(CODES.has(own))return 'FEE_REVISION_DIAGNOSTIC_'+own;
  const runtime=sourceRevisionRuntimeFailureCode(error);
  if(runtime!=='FEE_REPORT_SOURCE_REVISION_REFUSED')return safeProducerFailureSummary(runtime).code;
  let message;try{if(error&&!types.isProxy(error))message=Object.getOwnPropertyDescriptor(error,'message')?.value;}catch{}
  const safe=safeProducerFailureSummary(typeof message==='string'?message:'').code;
  return safe==='FEE_CLOUD_FAILED'?'FEE_REVISION_DIAGNOSTIC_FAILED':safe;
}
const result=(status,code)=>Object.freeze({schema:'fee-console.source-revision-diagnostic-result.v1',status,targetDate:REVISION_DIAGNOSTIC_SCOPE.targetDate,
  reasonCode:code,reportGenerated:false,publicationReady:false});

// Dependency injection is for synthetic tests only. The executable below pins
// every dependency to the original readers and does not accept modules or URLs.
export async function inspectRevisionDiagnostic({checkOnly=false,authorize,checkCheckout,readPrivate,createRuntime,cleanup,assertCurrent=()=>{}}={}){
  let admission,privateInput,runtime,answer,error,cleanupFailed=false;
  try{
    assertCurrent();checkCheckout();admission=await authorize();assertCurrent();
    await admission.checkCurrent();assertCurrent();checkCheckout();
    if(checkOnly)answer=result('plan-verified','NONE');
    else{
      privateInput=await readPrivate();assertCurrent();checkCheckout();
      runtime=await createRuntime(admission,privateInput);assertCurrent();
      if(!runtime||typeof runtime.diagnose!=='function'||typeof runtime.close!=='function'
        ||Object.keys(runtime).sort().join(',')!=='close,diagnose')fail('RESULT');
      const verified=await runtime.diagnose();assertCurrent();checkCheckout();
      if(!verified||verified.schema!=='fee-console.source-revision-diagnostic-result.v1'||verified.status!=='verified'
        ||verified.targetDate!==REVISION_DIAGNOSTIC_SCOPE.targetDate||Object.keys(verified).sort().join(',')!=='schema,status,targetDate')fail('RESULT');
      answer=result('verified','NONE');
    }
  }catch(e){error=e;}
  finally{
    try{runtime?.close();}catch{cleanupFailed=true;}
    try{admission?.close();}catch{cleanupFailed=true;}
    try{await cleanup(privateInput);}catch{cleanupFailed=true;}
    privateInput=null;runtime=null;admission=null;
  }
  if(cleanupFailed)return result('incomplete','FEE_REVISION_DIAGNOSTIC_CLEANUP');
  return error?result('incomplete',revisionDiagnosticFailureCode(error)):answer;
}

function readRegular(filename,max){
  let fd;try{fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const before=fs.fstatSync(fd);
    if(!before.isFile()||before.size<1||before.size>max)fail('READ');const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd);
    if(bytes.length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)fail('READ');return bytes;
  }finally{if(fd!==undefined)fs.closeSync(fd);}
}
function checkout(expectedMain){
  const git=args=>execFileSync('git',args,{cwd:ROOT,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000,maxBuffer:1024*1024}).trim();
  if(git(['rev-parse','HEAD'])!==expectedMain||git(['diff','--name-only','HEAD'])
    ||git(['ls-files','--others','--exclude-standard']).split('\n').filter(Boolean).some(f=>!/^gha-creds-[a-f0-9]+\.json$/.test(f)))fail('HEAD');
}
export function createRevisionDiagnosticDirectory(runnerTemp){
  if(typeof runnerTemp!=='string'||!path.isAbsolute(runnerTemp))fail('ENVIRONMENT');
  const parent=fs.realpathSync(runnerTemp),stat=fs.lstatSync(parent);
  if(!stat.isDirectory()||stat.uid!==process.getuid())fail('ENVIRONMENT');
  for(let at=parent;;at=path.dirname(at)){if(fs.existsSync(path.join(at,'.git')))fail('ENVIRONMENT');if(at===path.dirname(at))break;}
  const directory=path.join(parent,'fee-ib-diagnostic');if(fs.existsSync(directory))fail('ENVIRONMENT');
  fs.mkdirSync(directory,{mode:0o700});const identity=fs.lstatSync(directory);
  return {directory,cleanup(){const current=fs.lstatSync(directory);if(current.isSymbolicLink()||!current.isDirectory()||current.ino!==identity.ino||current.dev!==identity.dev||fs.readdirSync(directory).length)fail('CLEANUP');fs.rmdirSync(directory);}};
}

async function main(){
  const options=revisionDiagnosticArgs(process.argv.slice(2)),env=process.env;
  const event=JSON.parse(readRegular(env.GITHUB_EVENT_PATH,65536));
  validateRevisionDiagnosticEvent({env:{...env},event,...options,execArgv:process.execArgv});
  const transport=revisionDiagnosticTransport(),plan=dailyReportPlan(REVISION_DIAGNOSTIC_SCOPE.targetDate,['NASDAQ','NYSE'],{reviewedSyncDate:REVISION_DIAGNOSTIC_SCOPE.targetDate});
  let economic,storage,sourceBytes,healthBytes,payload,initial;
  const checkCheckout=()=>{checkout(options.expectedMain);const current=[readRegular(path.join(ROOT,'data.json'),2*1024*1024-1),readRegular(path.join(ROOT,'fee-data-health.json'),65536)].map(hash);
    if(initial&&current.some((h,i)=>h!==initial[i]))fail('BASE_CHANGED');initial??=current;};
  const publicationGet=route=>boundedJson(transport.fetch,'https://api.github.com/repos/'+REPO+'/'+route,{method:'GET',headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+env.FEE_REPORT_ACTIONS_TOKEN}},{timeoutMs:10000,maxBytes:8*1024*1024});
  try{
    const answer=await inspectRevisionDiagnostic({checkOnly:options.checkOnly,checkCheckout,assertCurrent:transport.assertCurrent,
      authorize:()=>authorizeHistoricalRevisionDiagnostic({plan,expectedMain:options.expectedMain,now:new Date(),currentRunId:env.GITHUB_RUN_ID,actionsToken:env.FEE_REPORT_ACTIONS_TOKEN,
        readRecoveryRelease:(sha,args)=>readReportRecoveryRelease(sha,{...args,fetchImpl:transport.fetch}),
        readCurrentRun:args=>readCurrentSyncRun({...args,fetchImpl:transport.fetch}),
        readState:(target,start)=>readPublicationState(target,start,publicationGet,{requireIb:true,strictCandidates:true})}),
      async readPrivate(){
        storage=createRevisionDiagnosticDirectory(env.RUNNER_TEMP);
        economic=await fetchEconomicSnapshot({fetchImpl:transport.fetch,tempRoot:storage.directory,attempts:1});
        if(economic.envelopeVersion!==4)fail('READ');
        sourceBytes=readRegular(path.join(ROOT,'data.json'),2*1024*1024-1);healthBytes=readRegular(path.join(ROOT,'fee-data-health.json'),65536);
        payload=decryptCandidate(path.join(ROOT,'data.json'),env.FEE_DATA_KEY);
        if(hash(sourceBytes)!==initial[0]||hash(healthBytes)!==initial[1]||payload.feeCalculationReceipt?.asOf!==REVISION_DIAGNOSTIC_SCOPE.previousDate)fail('BASE_CHANGED');
        return {economic};
      },
      createRuntime:admission=>createFeeSourceRevisionRuntime({plan,admission,diagnosticOnly:true,economicSnapshot:economic,
        sourceBytes,sourcePayload:payload,healthBytes,githubToken:env.FEE_REPORT_ACTIONS_TOKEN,
        clientId:env.FEE_CLOUD_SHARESIGHT_CLIENT_ID,clientSecret:env.FEE_CLOUD_SHARESIGHT_CLIENT_SECRET,keyText:env.FEE_DATA_KEY,
        baselineSha256:env.IB_MANAGER_BASELINE_SHA256,legacySourcePath:null,fetchImpl:transport.fetch,clock:Date.now}),
      cleanup(){let refused=false;try{economic?.cleanup();}catch{refused=true;}try{storage?.cleanup();}catch{refused=true;}
        sourceBytes?.fill(0);healthBytes?.fill(0);sourceBytes=null;healthBytes=null;payload=null;economic=null;storage=null;
        for(const name of [...PRIVATE,'FEE_REPORT_ACTIONS_TOKEN'])delete env[name];if(refused)fail('CLEANUP');},
    });
    console.log(JSON.stringify(answer));if(!['verified','plan-verified'].includes(answer.status))process.exitCode=1;
  }finally{transport.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(JSON.stringify(result('incomplete',revisionDiagnosticFailureCode(error))));process.exitCode=1;});
