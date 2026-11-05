// One reviewed read-only diagnostic. No writer, candidate, Gist, broker or publication.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {boundedJson} from './fee-http-json.mjs';
import {decryptCandidate} from './fee-cloud-producer.mjs';
import {validateHealth} from './fee-data-health.mjs';
import {SharesightIbManagerReader} from './ib-manager-source.mjs';
import {validateIbManagerReportState} from './ib-manager-return.mjs';
import {assertIbManagerPublication,prepareIbManagerReport,loadIbManagerReport,validateIbPublicationDiagnostic} from './ib-manager-report.mjs';

export const IB_DIAGNOSTIC_PLAN=Object.freeze({
  target:'2026-11-04',anchor:'2026-11-03',name:'IB diagnostic 2026-11-04',
  baselineMain:'5923e40afcf4fa17e91a4be8d05aedce0fe8cc28',
  dataSha256:'4243a6e8dacf8b6aec886c8553796285977b6ed15df5aee70bb5a399de0e8f1b',
  dataBlob:'61db90d958fc1bb82cccd37b65ced0d661b0d84a',healthBlob:'45da95da07ff036b7c5fd6aa45694d9db40fe59d',
  from:'2026-11-05T00:00:00Z',expires:'2026-11-05T15:59:59Z',maxGets:32,maxGrants:2,
});
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const REPO='huanwujoy-crypto/fee-console',WORKFLOW='.github/workflows/fee-cloud-producer.yml';
const fail=code=>{throw Error('IB_DIAGNOSTIC_'+code);};
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const gitBlob=b=>crypto.createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
const failures=new Set(['ARGUMENT','ENVIRONMENT','EXPIRED','HEAD','RUN','DUPLICATE','METADATA','BASE_BYTES','BASE_HEALTH','BASE_STATE','BASE_INVALID','WINDOW','ROUTE','BUDGET','CLEANUP','FAILED']);
function safeReason(error){const m=/^IB_DIAGNOSTIC_([A-Z_]+)$/.exec(error?.message||'');return m&&failures.has(m[1])?m[0]:'IB_DIAGNOSTIC_FAILED';}
function sourceReason(code){
  const d={schema:'fee-console.ib-publication-diagnostic.v1',code:'FEE_CLOUD_IB_INCOMPLETE',predicate:'SOURCE_STATE',sourceReason:code,returnReason:'NOT_CHECKED',drawdownReason:'NOT_CHECKED'};
  return validateIbPublicationDiagnostic(d)&&/^IB_SOURCE_/.test(code)?code:'UNKNOWN';
}
const summary=(status,phase,reasonCode)=>({schema:'fee-console.ib-readonly-diagnostic.v1',status,phase,reasonCode,fullReportVerified:false,publicationReady:false});

// The original reader resolves IB-HK and enforces its portfolio/cash identities.
// This additional boundary restricts methods, dates, duration and call counts.
export function ibDiagnosticTransport({fetchImpl=globalThis.fetch,anchor=IB_DIAGNOSTIC_PLAN.anchor,target=IB_DIAGNOSTIC_PLAN.target,now=()=>Date.now()}={}){
  const controller=new AbortController(),started=now();let gets=0,grants=0,closed=false;
  const fetch=async(url,init={})=>{
    const u=new URL(url),q=u.searchParams,p=u.pathname,grant=u.href==='https://api.sharesight.com/oauth2/token';
    if(closed||now()-started>14*60000||u.origin!=='https://api.sharesight.com'||u.username||u.password||u.hash)fail('ROUTE');
    const keys=expected=>[...q.keys()].length===expected.length&&expected.every(k=>q.has(k));
    let allowed=false;
    if(grant)allowed=init.method==='POST';
    else if(init.method==='GET'&&!init.body){
      if(p==='/api/v2/portfolios.json')allowed=keys([]);
      else if(/^\/api\/v3\/portfolios\/[1-9]\d*\/holdings$/.test(p))allowed=keys(['consolidated'])&&q.get('consolidated')==='false';
      else if(/^\/api\/v3\/portfolios\/[1-9]\d*\/performance$/.test(p))allowed=keys(['consolidated','end_date','grouping','include_limited','include_sales','report_combined','start_date'])&&[anchor,target].includes(q.get('end_date'))&&q.get('start_date')===q.get('end_date')&&q.get('grouping')==='investment_type'&&['consolidated','include_limited','include_sales','report_combined'].every(k=>q.get(k)==='false');
      else if(/^\/api\/v3\/portfolios\/[1-9]\d*\/trades\.json$/.test(p))allowed=keys(['consolidated','start_date','end_date'])&&q.get('consolidated')==='false'&&q.get('start_date')===target&&q.get('end_date')===target;
      else if(/^\/api\/v2\/portfolios\/[1-9]\d*\/cash_accounts\.json$/.test(p))allowed=keys(['date'])&&[anchor,target].includes(q.get('date'));
      else if(/^\/api\/v2\/cash_accounts\/[1-9]\d*\/cash_account_transactions\.json$/.test(p))allowed=keys(['from','to'])&&q.get('from')===target&&q.get('to')===target;
    }
    if(!allowed)fail('ROUTE');
    if(grant?grants>=IB_DIAGNOSTIC_PLAN.maxGrants:gets>=IB_DIAGNOSTIC_PLAN.maxGets)fail('BUDGET');
    if(grant)grants++;else gets++;
    return fetchImpl(url,{...init,redirect:'error',signal:init.signal?AbortSignal.any([init.signal,controller.signal]):controller.signal});
  };
  return {fetch,counts:()=>({sourceGets:gets,oauthGrants:grants}),stop(){closed=true;controller.abort();}};
}

// Pure dependency-injected inspection for synthetic tests; the CLI below pins
// dates, bytes, identity and the reader before using any real credential.
export async function inspectIbDiagnostic({payload,anchorDate,targetDate,outputDir,environ,reader}={}){
  let phase='BASE_STATE',result;const input=path.join(outputDir,'ib-manager-input.json');
  const st=fs.lstatSync(outputDir),relative=path.relative(ROOT,fs.realpathSync(outputDir));
  if(st.isSymbolicLink()||!st.isDirectory()||st.uid!==process.getuid()||(st.mode&0o777)!==0o700||!(relative==='..'||relative.startsWith('..'+path.sep))||fs.readdirSync(outputDir).length)fail('ENVIRONMENT');
  try{
    const checkpoint=await validateIbManagerReportState(payload,environ.IB_MANAGER_BASELINE_SHA256);
    if(!checkpoint||checkpoint.sourceAsOf!==anchorDate||new Date(Date.parse(anchorDate+'T00:00:00Z')+86400000).toISOString().slice(0,10)!==targetDate)fail('BASE_STATE');
    phase='BASE_PUBLICATION';await assertIbManagerPublication(payload,anchorDate,environ);
    phase='SOURCE_PREPARE';
    const boundedReader={async readStable(options){
      if(options.targetDate!==targetDate||options.checkpoint?.sourceAsOf!==anchorDate||options.ownerBaseline||options.bootstrapCoverage)fail('WINDOW');
      return reader.readStable(options);
    }};
    const prepared=await prepareIbManagerReport({payload,targetDate,outputDir,environ,reader:boundedReader});
    if(prepared?.state==='pending')result=summary('incomplete',phase,sourceReason(prepared.reasonCode));
    else{
      phase='RECEIPTS';const loaded=await loadIbManagerReport(input,{environ});loaded.checkCurrent();
      // Do not apply to the old fee receipt or fabricate a new fee cutoff.
      result=summary('source-and-receipts-verified',phase,'NONE');
    }
  }catch(error){result=summary('incomplete',phase,phase==='BASE_PUBLICATION'?'IB_DIAGNOSTIC_BASE_INVALID':safeReason(error));}
  finally{
    try{if(fs.existsSync(input)){const s=fs.lstatSync(input);if(s.isSymbolicLink()||!s.isFile())fail('CLEANUP');fs.unlinkSync(input);}if(fs.readdirSync(outputDir).length)fail('CLEANUP');}
    catch{result=summary('incomplete','CLEANUP','IB_DIAGNOSTIC_CLEANUP');}
  }
  return {...result,temporaryInputsCleaned:result.phase!=='CLEANUP'};
}

export function validateIbDiagnosticEvent({env,event,expectedMain,now=new Date()}={}){
  if(!/^[a-f0-9]{40}$/.test(expectedMain||'')||env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!==REPO||env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_SHA!==expectedMain||env.GITHUB_EVENT_NAME!=='workflow_dispatch'||env.GITHUB_ACTOR_ID!=='283054367'||env.GITHUB_RUN_ATTEMPT!=='1'||!/^\d{8,16}$/.test(env.GITHUB_RUN_ID||''))fail('ENVIRONMENT');
  if(!Number.isFinite(now.getTime())||now<Date.parse(IB_DIAGNOSTIC_PLAN.from)||now>Date.parse(IB_DIAGNOSTIC_PLAN.expires))fail('EXPIRED');
  const inputs=event?.inputs;if(!inputs||![true,'true'].includes(inputs.ib_diagnostic_once)||inputs.ib_diagnostic_main!==expectedMain)fail('ARGUMENT');
  const empty=['ratio_main','ratio_plan','source_from','source_target','source_main','manual_sync_completed_for','recovery_main','report_kind','report_target','report_markets'];
  const disabled=['source_plan_check_only','source_acceptance_once','run_reviewed_once'];
  if(Object.keys(inputs).some(k=>!['ib_diagnostic_once','ib_diagnostic_main',...empty,...disabled].includes(k))||empty.some(k=>inputs[k]!==undefined&&inputs[k]!=='')||disabled.some(k=>inputs[k]!==undefined&&![false,'false'].includes(inputs[k])))fail('ARGUMENT');
}

export async function verifyIbDiagnosticRun({env,expectedMain,now=new Date(),fetchImpl=globalThis.fetch}={}){
  const token=env.FEE_IB_DIAGNOSTIC_ACTIONS_TOKEN;if(typeof token!=='string'||token.length<20||token.length>4096||/\s/.test(token))fail('ENVIRONMENT');
  const root='https://api.github.com/repos/'+REPO;
  const get=route=>boundedJson(fetchImpl,root+route,{method:'GET',headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+token}},{timeoutMs:10000,maxBytes:1024*1024});
  if((await get('/git/ref/heads/main')).object?.sha!==expectedMain)fail('HEAD');
  const commit=await get('/commits/'+expectedMain);if(commit.sha!==expectedMain||commit.author?.id!==283054367||commit.commit?.verification?.verified!==true)fail('HEAD');
  const current=await get('/actions/runs/'+env.GITHUB_RUN_ID);
  if(String(current.id)!==env.GITHUB_RUN_ID||current.head_sha!==expectedMain||current.head_branch!=='main'||current.path!==WORKFLOW||current.event!=='workflow_dispatch'||current.actor?.id!==283054367||current.run_attempt!==1||current.status!=='in_progress'||current.conclusion!==null||current.display_title!==IB_DIAGNOSTIC_PLAN.name)fail('RUN');
  const q=new URLSearchParams({created:IB_DIAGNOSTIC_PLAN.from+'..'+now.toISOString(),per_page:'100'});
  const all=await get('/actions/runs?'+q),seen=new Set();
  if(!Number.isSafeInteger(all.total_count)||!Array.isArray(all.workflow_runs)||all.total_count!==all.workflow_runs.length||all.total_count>100)fail('METADATA');
  let matched=false;
  for(const run of all.workflow_runs){
    if(!Number.isSafeInteger(run.id)||run.id<=0||seen.has(run.id)||typeof run.path!=='string'||!Number.isFinite(Date.parse(run.created_at)))fail('METADATA');seen.add(run.id);
    if(run.path!==WORKFLOW||run.head_branch!=='main'||run.display_title!==IB_DIAGNOSTIC_PLAN.name)continue;
    if(String(run.id)===env.GITHUB_RUN_ID)matched=true;
    else if(run.id<current.id)fail('DUPLICATE');
  }
  if(!matched||(await get('/git/ref/heads/main')).object?.sha!==expectedMain)fail('HEAD');
}

export function validateIbDiagnosticBase({data,health,now=new Date()}={}){
  if(!Buffer.isBuffer(data)||data.length>=2*1024*1024||gitBlob(data)!==IB_DIAGNOSTIC_PLAN.dataBlob||hash(data)!==IB_DIAGNOSTIC_PLAN.dataSha256||!Buffer.isBuffer(health)||health.length>65536||gitBlob(health)!==IB_DIAGNOSTIC_PLAN.healthBlob)fail('BASE_BYTES');
  const h=JSON.parse(health);if(validateHealth(h,{now}).length||h.targetDate!==IB_DIAGNOSTIC_PLAN.anchor||h.dataSha256!==hash(data))fail('BASE_HEALTH');
}

async function main(){
  let expectedMain,checkOnly=false;
  for(const a of process.argv.slice(2))if(a==='--check-plan'&&!checkOnly)checkOnly=true;else if(/^--expected-main=[a-f0-9]{40}$/.test(a)&&expectedMain===undefined)expectedMain=a.slice(16);else fail('ARGUMENT');
  const env=process.env,now=new Date();
  if(process.execArgv.length||['NODE_OPTIONS','NODE_PATH','FEE_ECON_GIST_ID','FEE_ECON_FILE','FEE_CLOUD_GITHUB_TOKEN','FEE_RATIO_MANAGER_TOKEN','GH_TOKEN','GITHUB_TOKEN'].some(k=>Object.hasOwn(env,k))||Object.keys(env).some(k=>/^(DYLD_|LD_)/.test(k)))fail('ENVIRONMENT');
  if(checkOnly&&['FEE_DATA_KEY','FEE_CLOUD_SHARESIGHT_CLIENT_ID','FEE_CLOUD_SHARESIGHT_CLIENT_SECRET'].some(k=>Object.hasOwn(env,k)))fail('ENVIRONMENT');
  const eventFile=env.GITHUB_EVENT_PATH;if(!eventFile||fs.statSync(eventFile).size>65536)fail('ENVIRONMENT');
  validateIbDiagnosticEvent({env,event:JSON.parse(fs.readFileSync(eventFile)),expectedMain,now});
  const git=args=>execFileSync('git',args,{cwd:ROOT,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  if(git(['rev-parse','HEAD'])!==expectedMain||git(['diff','--name-only','HEAD']))fail('HEAD');
  if(git(['ls-files','--others','--exclude-standard']).split('\n').filter(Boolean).some(f=>!/^gha-creds-[a-f0-9]+\.json$/.test(f)))fail('HEAD');
  validateIbDiagnosticBase({data:fs.readFileSync(path.join(ROOT,'data.json')),health:fs.readFileSync(path.join(ROOT,'fee-data-health.json')),now});
  await verifyIbDiagnosticRun({env,expectedMain,now});
  if(checkOnly){console.log('IB_DIAGNOSTIC_PLAN_READY');return;}
  const output=path.join(env.RUNNER_TEMP||'', 'fee-ib-diagnostic');
  if(!path.isAbsolute(output)||!env.RUNNER_TEMP||fs.existsSync(output))fail('ENVIRONMENT');fs.mkdirSync(output,{mode:0o700});
  const transport=ibDiagnosticTransport();let result;
  try{
    const payload=decryptCandidate(path.join(ROOT,'data.json'),env.FEE_DATA_KEY);
    const reader=new SharesightIbManagerReader({clientId:env.FEE_CLOUD_SHARESIGHT_CLIENT_ID,clientSecret:env.FEE_CLOUD_SHARESIGHT_CLIENT_SECRET,fetchImpl:transport.fetch});
    result=await inspectIbDiagnostic({payload,anchorDate:IB_DIAGNOSTIC_PLAN.anchor,targetDate:IB_DIAGNOSTIC_PLAN.target,outputDir:output,environ:env,reader});
  }catch(error){result={...summary('incomplete','PREFLIGHT',safeReason(error)),temporaryInputsCleaned:false};}
  finally{transport.stop();try{if(fs.readdirSync(output).length===0){fs.rmdirSync(output);result.temporaryInputsCleaned=true;}else result={...summary('incomplete','CLEANUP','IB_DIAGNOSTIC_CLEANUP'),temporaryInputsCleaned:false};}catch{result={...summary('incomplete','CLEANUP','IB_DIAGNOSTIC_CLEANUP'),temporaryInputsCleaned:false};}}
  console.log(JSON.stringify({...result,...transport.counts()}));
  if(result.status!=='source-and-receipts-verified')process.exitCode=1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(JSON.stringify({...summary('incomplete','PREFLIGHT',safeReason(error)),sourceGets:0,oauthGrants:0}));process.exitCode=1;});
