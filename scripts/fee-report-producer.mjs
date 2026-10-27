#!/usr/bin/env node
// Weekly/monthly orchestration of the existing daily writer. This module never
// publishes, finds credentials or changes the economic book. The public gate
// runs before any financial environment is entered.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {SharesightCloudReader,normalizeRead} from './fee-cloud-source.mjs';
import {produce,decryptCandidate,readPublicationState,producerFailureCode} from './fee-cloud-producer.mjs';
import {fetchEconomicSnapshot} from './fee-economic-source.mjs';
import {incomeDateEvidenceFromData} from './fee-income-date-policy.mjs';
import {canonicalJson} from './fee-receipt-core.mjs';
import {validateHealth} from './fee-data-health.mjs';
import {boundedJson} from './fee-http-json.mjs';
import {reportDate,reportAddDays,selectReportBenchmark,weeklyReportPlan,monthlyReportPlan,coalesceReportPlans,validateReportPlan,reportPlanReadiness,reportPlansAround,reportWindowDates} from './fee-report-period.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fail=code=>{throw Error('FEE_REPORT_'+code);};
const hash=v=>crypto.createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:canonicalJson(v)).digest('hex');
const freshTarget=(plan,now)=>{const age=Math.floor((Date.parse(now.toISOString().slice(0,10)+'T00:00:00Z')-Date.parse(plan.accountingThrough+'T00:00:00Z'))/86400000);return age>=0&&age<=4;};
export function periodBenchmark(cache,date){
  return selectReportBenchmark(cache,date);
}
export function normalizePeriodRead(raw,date,cache){
  const benchmark=periodBenchmark(cache,date),input=normalizeRead(raw,date,{spy:benchmark.spy,qqq:benchmark.qqq,spyd:benchmark.spyd,qqqd:benchmark.qqqd});
  return {...input,benchmark,sourceFingerprint:hash({sourceFingerprint:input.sourceFingerprint,benchmark})};
}
export async function captureReportRange({dates,cache,readOnce}){
  if(!Array.isArray(dates)||!dates.length||dates.length>10||typeof readOnce!=='function'||dates.some((d,i)=>!reportDate(d)||(i&&d!==reportAddDays(dates[i-1],1))))fail('RANGE');
  const capture=async()=>{
    const result=[];
    for(const date of dates)result.push(normalizePeriodRead(await readOnce(date),date,cache));
    return result;
  };
  const first=await capture(),second=await capture();
  if(canonicalJson(first)!==canonicalJson(second))fail('SOURCE_UNSTABLE');
  return first;
}
export function publishedReportMatches(state,plan,now=new Date()){
  try{
    if(!validateReportPlan(plan)||reportPlanReadiness(plan,now).state!=='due'||!state||!/^[a-f0-9]{40}$/.test(state.mainSha)||state.mainSha!==state.finalMainSha||!Buffer.isBuffer(state.data)||state.data.length<1||state.data.length>=2*1024*1024)return false;
    const h=state.health,checked=new Date(h?.checkedAt);
    // This is coverage/dedup of an existing weekly receipt, not permission to
    // promote an old candidate. Fresh candidate health still has its 36h gate.
    if(validateHealth(h,{now:checked}).length||checked.getTime()>now.getTime()+300000||reportPlanReadiness(plan,checked).state!=='due'||h.targetDate!==plan.accountingThrough||!['updated','no-op'].includes(h.outcome)||h.dataSha256!==hash(state.data)||h.sourceDates.schwab!==plan.accountingThrough||h.sourceDates.webull!==plan.accountingThrough||h.sourceDates.benchmark!==plan.priceThrough)return false;
    const e=JSON.parse(state.data.toString());
    return Object.keys(e).sort().join(',')==='data,enc,v'&&e.enc===true&&e.v===3&&typeof e.data==='string'&&e.data.length>=40&&Buffer.from(e.data,'base64').toString('base64')===e.data;
  }catch{return false;}
}
export function explicitReportPlan(kind,target){
  reportDate(target);
  if(kind==='weekly'){
    const weekly=weeklyReportPlan(target),monthly=monthlyReportPlan(target.slice(0,7));
    return coalesceReportPlans(monthly.accountingThrough===target?[weekly,monthly]:[weekly])[0];
  }
  if(kind==='monthly'){
    const monthly=monthlyReportPlan(target.slice(0,7));if(monthly.accountingThrough!==target)fail('TARGET');
    const weekly=new Date(target+'T00:00:00Z').getUTCDay()===5?weeklyReportPlan(target):null;
    return coalesceReportPlans(weekly?[weekly,monthly]:[monthly])[0];
  }
  fail('TARGET');
}
// At most one additional financial entry for a newly published period. This
// public metadata budget carries no independent account fields or raw logs.
// Counts are conservative: unrelated runs in the narrow window consume budget.
export async function readPeriodRetryRuns({scheduledAt,now,fetchImpl=globalThis.fetch}={}){
  const from=new Date(Date.parse(scheduledAt)).toISOString();
  const query=new URLSearchParams({branch:'main',created:from+'..'+now.toISOString(),per_page:'100'});
  const url='https://api.github.com/repos/huanwujoy-crypto/fee-console/actions/workflows/fee-cloud-producer.yml/runs?'+query;
  const listing=await boundedJson(fetchImpl,url,{headers:{Accept:'application/vnd.github+json'}},{timeoutMs:15000,maxBytes:2*1024*1024});
  if(!Number.isSafeInteger(listing.total_count)||!Array.isArray(listing.workflow_runs)||listing.total_count!==listing.workflow_runs.length||listing.total_count>100)fail('IB_RETRY_METADATA');
  return listing.workflow_runs;
}
export function periodIbRetryAllowed({runs,currentRunId=null,scheduledAt,now}={}){
  if(!Array.isArray(runs)||!Number.isFinite(Date.parse(scheduledAt))||!Number.isFinite(now?.getTime()))return false;
  const current=String(currentRunId||''),seen=new Set();let previous=0;
  for(const r of runs){
    if(!Number.isSafeInteger(r.id)||r.id<=0||seen.has(r.id)||r.head_branch!=='main'||r.path!=='.github/workflows/fee-cloud-producer.yml'||!/^[a-f0-9]{40}$/.test(r.head_sha||'')||!['schedule','workflow_dispatch'].includes(r.event)||!Number.isFinite(Date.parse(r.created_at)))return false;
    seen.add(r.id);const time=Date.parse(r.created_at);
    if(time<Date.parse(scheduledAt)||time>now.getTime())return false;
    if(String(r.id)!==current)previous++;
  }
  return previous===1;
}
export async function reportPublicationPreflight({now=new Date(),plan=null,ibEnabled=process.env.IB_MANAGER_READ_ENABLED==='true',currentRunId=process.env.GITHUB_RUN_ID,readRetryRuns=readPeriodRetryRuns,readState}={}){
  readState||=((target,start)=>readPublicationState(target,start,undefined,{requireIb:ibEnabled}));
  const plans=plan?[plan]:reportPlansAround(now);
  if(!plans.length)return {schema:'fee-console.report-preflight.v1',outcome:'not-due',plan:null};
  if(plans.some(p=>!validateReportPlan(p)))fail('PLAN');
  const latest=plans.at(-1),startedAt=now.toISOString();
  let state=await readState(latest.accountingThrough,startedAt);
  if(state.mainSha!==state.finalMainSha||validateHealth(state.health,{now:new Date(state.health?.checkedAt)}).length||Date.parse(state.health?.checkedAt)>now.getTime()+300000||state.health?.dataSha256!==hash(state.data))fail('PUBLICATION_READ');
  if(plan&&state.health.targetDate>plan.accountingThrough)fail('HISTORY_AHEAD_OF_TARGET');
  const pending=plans.filter(p=>p.accountingThrough>=state.health.targetDate&&!publishedReportMatches(state,p,now));
  if(!pending.length){
    const covered={schema:'fee-console.report-preflight.v1',outcome:'already-published',plan:latest,mainSha:state.mainSha};
    // Between reports coverage remains valid; this bounded IB retry never
    // rejuvenates stale health, changes target windows or retries every day.
    if(!ibEnabled||state.health.targetDate!==latest.accountingThrough||!freshTarget(latest,now)||validateHealth(state.health,{now}).length||now.getTime()-Date.parse(state.health.checkedAt)>12*3600000)return covered;
    if(state.pending)return {...covered,outcome:'candidate-pending'};
    try{
      const runs=await readRetryRuns({scheduledAt:latest.scheduledAt,now});
      if(periodIbRetryAllowed({runs,currentRunId,scheduledAt:latest.scheduledAt,now}))return {...covered,outcome:'produce',reasonCode:'IB_BOUNDED_SAME_PERIOD_RECHECK'};
    }catch{/* IB metadata uncertainty cannot block or invalidate fee coverage. */}
    return covered;
  }
  const next=pending[0],readiness=reportPlanReadiness(next,now);
  if(readiness.state!=='due')return {schema:'fee-console.report-preflight.v1',outcome:'waiting',reasonCode:readiness.reasonCode,plan:next,mainSha:state.mainSha};
  if(!freshTarget(next,now))return {schema:'fee-console.report-preflight.v1',outcome:'recovery-required',reasonCode:'REPORT_TARGET_OUTSIDE_PROMOTION_WINDOW',plan:next,mainSha:state.mainSha};
  if(next.accountingThrough!==latest.accountingThrough)state=await readState(next.accountingThrough,startedAt);
  if(state.mainSha!==state.finalMainSha||validateHealth(state.health,{now:new Date(state.health?.checkedAt)}).length||state.health?.dataSha256!==hash(state.data)||state.health.targetDate>next.accountingThrough)fail('PUBLICATION_READ');
  if(publishedReportMatches(state,next,now))return {schema:'fee-console.report-preflight.v1',outcome:'already-published',plan:next,mainSha:state.mainSha};
  if(state.pending)return {schema:'fee-console.report-preflight.v1',outcome:'candidate-pending',plan:next,mainSha:state.mainSha};
  return {schema:'fee-console.report-preflight.v1',outcome:'produce',plan:next,mainSha:state.mainSha};
}
export async function reportPublicationWatch({mainSha,health,data,now=new Date()}={}){
  if(!/^[a-f0-9]{40}$/.test(mainSha||''))fail('PUBLICATION_READ');
  const state={mainSha,finalMainSha:mainSha,health,data,pending:false};
  const result=await reportPublicationPreflight({now,ibEnabled:false,readState:async()=>state});
  if(!['already-published','not-due'].includes(result.outcome)&&!(result.outcome==='waiting'&&result.reasonCode==='ACCOUNTING_DAY_NOT_COMPLETE'))fail('PUBLISHED_PERIOD_MISSING');
  return {schema:'fee-console.report-watch.v1',outcome:result.outcome,accountingThrough:health.targetDate};
}
function outputDirectory(file){
  if(!path.isAbsolute(file||''))fail('OUTPUT_DIR');
  const st=fs.lstatSync(file),real=fs.realpathSync(file),r=path.relative(ROOT,real);
  if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)!==0||st.uid!==process.getuid()||!(r==='..'||r.startsWith('..'+path.sep)))fail('OUTPUT_DIR');
  return real;
}
export function assertPeriodIbRecheckUnchanged(before,after){
  const strip=o=>Object.fromEntries(Object.entries(o).filter(([k])=>!['ibManagerReturnReceipt','ibManagerDrawdownReceipt','ibManagerSourceState','ibManagerSourceStatus','ibManagerBaselineState','ibManagerCoverageState','updatedAt'].includes(k)));
  if(canonicalJson(strip(before))!==canonicalJson(strip(after)))fail('IB_RECHECK_CHANGED_FEE_DATA');
}
export async function produceReportPeriod({plan,outputDir,benchmarkFile,now=new Date(),readOnce,ibReader,fetchEconomic=fetchEconomicSnapshot,sourceFile=path.join(ROOT,'data.json')}={}){
  if(!validateReportPlan(plan)||reportPlanReadiness(plan,now).state!=='due')fail('NOT_READY');
  if(!freshTarget(plan,now))fail('RECOVERY_REQUIRED');
  const output=outputDirectory(outputDir),originalBytes=fs.readFileSync(sourceFile),payload=decryptCandidate(sourceFile,process.env.FEE_DATA_KEY);
  const latest=payload.daily?.map(p=>p.d).sort().at(-1),dates=reportWindowDates(latest,plan.accountingThrough);
  const cache=JSON.parse(fs.readFileSync(benchmarkFile));
  dates.forEach(date=>periodBenchmark(cache,date));
  if(periodBenchmark(cache,plan.accountingThrough).sourceDate!==plan.priceThrough)fail('BENCHMARK');
  let economic;const runtime=path.join(output,'period-private');
  if(fs.existsSync(runtime)||['data.json','fee-data-health.json'].some(f=>fs.existsSync(path.join(output,f))))fail('OUTPUT_EXISTS');
  fs.mkdirSync(runtime,{mode:0o700});
  try{
    // Freeze one private economic revision for the entire range. No intermediate
    // candidate can escape. Recheck again after all daily receipts are proved.
    economic=await fetchEconomic();if(economic.envelopeVersion!==4)fail('ECON_VERSION');
    const reads=await captureReportRange({dates,cache,readOnce:readOnce||(async date=>new SharesightCloudReader({clientId:process.env.FEE_CLOUD_SHARESIGHT_CLIENT_ID,clientSecret:process.env.FEE_CLOUD_SHARESIGHT_CLIENT_SECRET,incomeDateEvidence:incomeDateEvidenceFromData(payload,date)}).readOnce(date))});
    let base=sourceFile,result;
    for(let i=0;i<reads.length;i++){
      const input=reads[i],final=i===reads.length-1,dayDir=path.join(runtime,input.targetDate);fs.mkdirSync(dayDir,{mode:0o700});
      result=await produce({cli:{'benchmark-file':benchmarkFile,'target-date':input.targetDate,'checked-at':now.toISOString(),'out-dir':dayDir},periodMode:true,baseDataFile:base===sourceFile?undefined:base,
        // The root source is fixed; a caller-provided synthetic source is
        // accepted only by the test/library entry, never the CLI/workflow.
        ...(base===sourceFile&&sourceFile!==path.join(ROOT,'data.json')?{baseDataFile:base}:{}),
        reader:{async readStable(target){if(target!==input.targetDate)fail('RANGE');return structuredClone(input);}},
        fetchEconomic:async()=>({...economic,cleanup(){}}),includeIb:final,ibReader,...(final?{reportPlan:plan}:{})});
      base=result.dataFile;
    }
    await economic.checkCurrent();
    if(!fs.readFileSync(sourceFile).equals(originalBytes))fail('BASE_CHANGED');
    if(process.env.IB_MANAGER_READ_ENABLED==='true'&&latest===plan.accountingThrough){
      assertPeriodIbRecheckUnchanged(payload,decryptCandidate(result.dataFile,process.env.FEE_DATA_KEY));
    }
    for(const name of ['data.json','fee-data-health.json'])fs.copyFileSync(path.join(path.dirname(result.dataFile),name),path.join(output,name),fs.constants.COPYFILE_EXCL);
    fs.chmodSync(path.join(output,'data.json'),0o600);
    return {...result,dataFile:path.join(output,'data.json'),healthFile:path.join(output,'fee-data-health.json'),reportKind:plan.kind,accountingThrough:plan.accountingThrough,priceThrough:plan.priceThrough,reconstructedDays:dates.length};
  }catch(error){
    for(const name of ['data.json','fee-data-health.json'])try{fs.unlinkSync(path.join(output,name));}catch{}
    throw error;
  }finally{
    fs.rmSync(runtime,{recursive:true,force:true});
    try{economic?.cleanup();}catch{for(const name of ['data.json','fee-data-health.json'])try{fs.unlinkSync(path.join(output,name));}catch{}fail('CLEANUP');}
  }
}
function cliArgs(argv){
  const out={};for(const arg of argv){const m=/^--([a-z-]+)=([\s\S]+)$/.exec(arg);if(!m||out[m[1]]!==undefined)fail('ARGUMENT');out[m[1]]=m[2];}
  if(Object.keys(out).some(k=>!['mode','report-kind','report-target','benchmark-file','out-dir','main-sha'].includes(k)))fail('ARGUMENT');
  if((out['report-kind']===undefined)!==(out['report-target']===undefined))fail('ARGUMENT');return out;
}
async function main(){
  const args=cliArgs(process.argv.slice(2)),plan=args['report-target']?explicitReportPlan(args['report-kind'],args['report-target']):null;
  if(args.mode==='watch'){
    if(Object.keys(args).sort().join(',')!=='main-sha,mode')fail('ARGUMENT');
    const data=fs.readFileSync(path.join(ROOT,'data.json')),bytes=fs.readFileSync(path.join(ROOT,'fee-data-health.json'));
    const result=await reportPublicationWatch({mainSha:args['main-sha'],health:JSON.parse(bytes),data});
    if(!fs.readFileSync(path.join(ROOT,'data.json')).equals(data)||!fs.readFileSync(path.join(ROOT,'fee-data-health.json')).equals(bytes))fail('PUBLICATION_READ');
    console.log(JSON.stringify(result));return;
  }
  if(args['main-sha'])fail('ARGUMENT');
  if(args.mode==='preflight'){
    if(args['out-dir']||args['benchmark-file'])fail('ARGUMENT');
    console.log(JSON.stringify(await reportPublicationPreflight({plan})));return;
  }
  if(args.mode!=='produce'||!plan)fail('ARGUMENT');
  const result=await produceReportPeriod({plan,outputDir:args['out-dir'],benchmarkFile:args['benchmark-file']});
  console.log(JSON.stringify({schema:'fee-console.cloud-producer.v1',targetDate:result.targetDate,outcome:result.outcome,retryCount:result.retryCount,sourceDates:result.sourceDates,dataSha256:result.dataSha256,reportKind:result.reportKind,priceThrough:result.priceThrough,accountingThrough:result.accountingThrough,reconstructedDays:result.reconstructedDays,...(result.ibManager?{ibManager:result.ibManager}:{})}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{const code=/^FEE_REPORT_[A-Z_]{1,64}$/.test(error?.message||'')?error.message:producerFailureCode(error,'UNKNOWN');console.error(code);process.exitCode=1;});
