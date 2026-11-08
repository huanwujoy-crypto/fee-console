#!/usr/bin/env node
// Weekly/monthly orchestration of the existing daily writer. This module never
// publishes financial data, finds credentials or changes the economic book.
// The bounded once-control modes only reserve public refs and disable the two
// original workflows using an explicitly scoped ephemeral Actions token.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {SharesightCloudReader,normalizeRead} from './fee-cloud-source.mjs';
import {produce,decryptCandidate,readPublicationState,producerFailureCode} from './fee-cloud-producer.mjs';
import {assertIbManagerConfiguration,assertIbManagerPublication} from './ib-manager-report.mjs';
import {fetchEconomicSnapshot,SourceFetchError} from './fee-economic-source.mjs';
import {incomeDateEvidenceFromData} from './fee-income-date-policy.mjs';
import {canonicalJson} from './fee-receipt-core.mjs';
import {validateHealth} from './fee-data-health.mjs';
import {boundedJson,BoundedJsonError} from './fee-http-json.mjs';
import {createFundInvestorCore} from './fund-investor-core.mjs';
import {validateManagedTransferIdentities} from './fee-sharesight-transfers.mjs';
import {reportDate,reportAddDays,selectReportBenchmark,weeklyReportPlan,monthlyReportPlan,coalesceReportPlans,validateReportPlan,reportPlanReadiness,reportPlansAround,reportWindowDates,dailyReportPlan,isReviewedDailyPlan} from './fee-report-period.mjs';
import {sessionUnion} from './fee-market-calendar.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fail=code=>{throw Error('FEE_REPORT_'+code);};
const hash=v=>crypto.createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:canonicalJson(v)).digest('hex');
const freshTarget=(plan,now)=>{const age=Math.floor((Date.parse(now.toISOString().slice(0,10)+'T00:00:00Z')-Date.parse(plan.accountingThrough+'T00:00:00Z'))/86400000);return age>=0&&age<=4;};
// One bounded cloud acceptance, not a recurring permission or a budget reset.
// Git reference creation is the atomic reservation. Neither ref is ever moved
// or deleted. These refs hold only run/code identifiers, never financial data.
export const CLOUD_ONCE=Object.freeze({target:'2026-11-02',from:'2026-10-31',
  checkAt:'2026-11-03T02:00:00Z',openAt:'2026-11-03T02:00:00Z',
  closeAt:'2026-11-03T05:45:00Z',finishBy:'2026-11-03T06:15:00Z',
  tag:'fee-cloud-once-20261102',producer:365873934,promotion:336677756});
const ONCE_REPO='huanwujoy-crypto/fee-console',ONCE_SHA=/^[a-f0-9]{40}$/;
const onceFail=()=>fail('ONCE_CONTROL');
const onceId=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):onceFail();
const ONCE_MANUAL_FROM='2026-11-03T03:30:00Z';
function reviewedCloudOnceManual(env,readEvent){
  try{
    if(env.GITHUB_EVENT_NAME!=='workflow_dispatch'||env.GITHUB_ACTOR_ID!==String(RECOVERY_OWNER)
      ||env.GITHUB_RUN_ATTEMPT!=='1'||env.GITHUB_SHA!==env.FEE_REPORT_ONCE_MAIN)return false;
    const event=readEvent?readEvent():(()=>{const p=env.GITHUB_EVENT_PATH;if(!p||fs.statSync(p).size>256*1024)throw Error();return JSON.parse(fs.readFileSync(p,'utf8'));})();
    const i=event?.inputs,off=v=>v===undefined||v===false||v==='false',blank=v=>v===undefined||v==='';
    const keys=['ib_envelope_once','ib_envelope_main','ib_diagnostic_once','ib_diagnostic_main','run_reviewed_once','report_kind','report_target','report_markets','manual_sync_completed_for','confirmed_main','recovery_main','ratio_main','ratio_plan','source_plan_check_only','source_acceptance_once','source_from','source_target','source_main'];
    return event.sender?.id===RECOVERY_OWNER&&event.repository?.full_name===ONCE_REPO&&i&&!Array.isArray(i)
      &&Object.keys(i).every(k=>keys.includes(k))&&[true,'true'].includes(i.run_reviewed_once)
      &&i.report_kind==='daily'&&i.report_target===CLOUD_ONCE.target&&i.report_markets==='NASDAQ,NYSE'
      &&['manual_sync_completed_for','confirmed_main','recovery_main','ratio_main','ratio_plan','source_from','source_target','source_main'].every(k=>blank(i[k]))
      &&off(i.source_plan_check_only)&&off(i.source_acceptance_once)&&off(i.ib_diagnostic_once)&&blank(i.ib_diagnostic_main)&&off(i.ib_envelope_once)&&blank(i.ib_envelope_main);
  }catch{return false;}
}
export function cloudOnceWindow({main,head,event,attempt,reviewedManual=false,now=new Date()}={}){
  if(!main)return 'inactive';
  if(!ONCE_SHA.test(main)||!Number.isFinite(now.getTime()))onceFail();
  if(head!==main||String(attempt)!=='1')return 'closed';
  if(event!=='schedule'&&(event!=='workflow_dispatch'||reviewedManual!==true||now<Date.parse(ONCE_MANUAL_FROM)))return 'closed';
  if(now<Date.parse(CLOUD_ONCE.checkAt))return 'waiting';
  return now<Date.parse(CLOUD_ONCE.closeAt)?'active':'closed';
}
export async function cloudOnceRequest(method,route,body,{token,fetchImpl=globalThis.fetch}={}){
  // All callers construct routes from fixed names, validated SHA/run IDs.
  const fixed=['/git/tags','/git/refs','/git/ref/heads/main',
    '/git/ref/tags/'+CLOUD_ONCE.tag,'/git/ref/tags/'+CLOUD_ONCE.tag+'-candidate'];
  const allowed=method==='GET'&&(fixed.slice(2).includes(route)||/^\/git\/tags\/[a-f0-9]{40}$/.test(route)
    ||/^\/actions\/runs\/[1-9]\d{0,15}(?:\/jobs\?filter=all&per_page=100)?$/.test(route)
    ||/^\/actions\/workflows\/validate-fee-data\.yml\/runs\?head_sha=[a-f0-9]{40}&event=push&per_page=100$/.test(route)
    ||/^\/commits\/[a-f0-9]{40}\?per_page=100$/.test(route)
    ||[CLOUD_ONCE.producer,CLOUD_ONCE.promotion].some(id=>route==='/actions/workflows/'+id))
    ||method==='POST'&&fixed.slice(0,2).includes(route)
    ||method==='PUT'&&[CLOUD_ONCE.producer,CLOUD_ONCE.promotion].some(id=>route==='/actions/workflows/'+id+'/disable');
  if(!allowed||typeof token!=='string'||token.length<20||/[\r\n\0]/.test(token))onceFail();
  try{
    const response=await fetchImpl('https://api.github.com/repos/'+ONCE_REPO+route,{method,redirect:'error',
      headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+token,'Content-Type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
    if(method==='GET'&&response.status===404&&route.startsWith('/git/ref/tags/'))return null;
    if(method==='PUT'){if(response.status!==204)onceFail();return null;}
    if(![200,201].includes(response.status))onceFail();
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>256*1024)onceFail();chunks.push(value);}}
    finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
  }catch{onceFail();}
}
async function onceClaimRecord(request,main){
  const ref=await request('GET','/git/ref/tags/'+CLOUD_ONCE.tag);
  if(ref===null)return null;
  if(ref.ref!=='refs/tags/'+CLOUD_ONCE.tag||ref.object?.type!=='tag'||!ONCE_SHA.test(ref.object.sha))onceFail();
  const tag=await request('GET','/git/tags/'+ref.object.sha);let record;
  try{record=JSON.parse(tag.message);}catch{onceFail();}
  if(tag.tag!==CLOUD_ONCE.tag||tag.object?.type!=='commit'||tag.object.sha!==main
    ||!record||Array.isArray(record)||Object.keys(record).sort().join(',')!=='main,runId,schema,target'
    ||record.schema!=='fee-console.cloud-once.v1'||record.main!==main
    ||record.target!==CLOUD_ONCE.target||record.runId!==onceId(record.runId))onceFail();
  return record;
}
async function onceRun(request,record){
  const run=await request('GET','/actions/runs/'+record.runId);
  const manual=run.event==='workflow_dispatch'&&run.actor?.id===RECOVERY_OWNER;
  if(run.id!==record.runId||run.workflow_id!==CLOUD_ONCE.producer||run.head_sha!==record.main
    ||run.head_branch!=='main'||(run.event!=='schedule'&&!manual)||run.run_attempt!==1
    ||run.path!=='.github/workflows/fee-cloud-producer.yml'
    ||!Number.isFinite(Date.parse(run.created_at))||Date.parse(run.created_at)<Date.parse(manual?ONCE_MANUAL_FROM:CLOUD_ONCE.checkAt)
    ||Date.parse(run.created_at)>=Date.parse(CLOUD_ONCE.closeAt))onceFail();
  return run;
}
async function onceCreateRef(request,name,sha){
  try{await request('POST','/git/refs',{ref:'refs/tags/'+name,sha});}catch{/* Unknown mutation: read back, never repeat POST. */}
  const actual=await request('GET','/git/ref/tags/'+name);
  if(actual?.ref!=='refs/tags/'+name||actual.object?.sha!==sha)onceFail();
}
export async function pauseCloudOnce(request,ids=[CLOUD_ONCE.producer,CLOUD_ONCE.promotion]){
  let failed=false;
  for(const id of ids){
    if(![CLOUD_ONCE.producer,CLOUD_ONCE.promotion].includes(id))onceFail();
    try{await request('PUT','/actions/workflows/'+id+'/disable');}catch{/* Read the actual state even after an uncertain response. */}
    try{const w=await request('GET','/actions/workflows/'+id);if(w.id!==id||w.state!=='disabled_manually')failed=true;}catch{failed=true;}
  }
  if(failed)onceFail();
  return {state:'paused',workflows:ids};
}
export async function admitCloudOnce({main,head,event,attempt,reviewedManual=false,runId,plan,now=new Date(),request,readBudget=readPeriodSourceAttempts}={}){
  if(cloudOnceWindow({main,head,event,attempt,reviewedManual,now})!=='active'||now<Date.parse(CLOUD_ONCE.openAt)
    ||!validateReportPlan(plan)||plan.accountingThrough!==CLOUD_ONCE.target||plan.priceThrough!==CLOUD_ONCE.target
    ||plan.periodFrom!==CLOUD_ONCE.from||plan.kind!=='daily-monthly'
    ||JSON.stringify(plan.monthlyCutoffs)!=='["2026-10-31"]'
    ||JSON.stringify(plan.markets)!=='["NASDAQ","NYSE"]'||reportPlanReadiness(plan,now).state!=='due')onceFail();
  const record={schema:'fee-console.cloud-once.v1',target:CLOUD_ONCE.target,main,runId:onceId(runId)};
  const budget=await readBudget({plan,now,currentRunId:record.runId});
  if(budget?.attempts!==0||budget.inProgress!==false)onceFail();
  const run=await onceRun(request,record),current=await request('GET','/git/ref/heads/main');
  if(run.event!==event||run.status!=='in_progress'||current.object?.sha!==main||await onceClaimRecord(request,main)!==null)onceFail();
  const tag=await request('POST','/git/tags',{tag:CLOUD_ONCE.tag,message:JSON.stringify(record),object:main,type:'commit'});
  if(!ONCE_SHA.test(tag?.sha||''))onceFail();
  await onceCreateRef(request,CLOUD_ONCE.tag,tag.sha);
  const saved=await onceClaimRecord(request,main);
  if(canonicalJson(saved)!==canonicalJson(record))onceFail();
  await pauseCloudOnce(request,[CLOUD_ONCE.producer]);
  return {state:'admitted',runId:record.runId};
}
export async function confirmCloudOnce({main,head,event,reviewedManual=false,runId,attempt,now=new Date(),request}={}){
  if(cloudOnceWindow({main,head,event,attempt,reviewedManual,now})!=='active')onceFail();
  const r=await onceClaimRecord(request,main);if(!r||r.runId!==onceId(runId))onceFail();
  const [run,current,w]=await Promise.all([onceRun(request,r),request('GET','/git/ref/heads/main'),request('GET','/actions/workflows/'+CLOUD_ONCE.producer)]);
  if(run.event!==event||run.status!=='in_progress'||current.object?.sha!==main||w.state!=='disabled_manually')onceFail();
  return {state:'confirmed'};
}
export async function recordCloudOnceCandidate({main,runId,candidate,request}={}){
  const r=await onceClaimRecord(request,main);if(!r||r.runId!==onceId(runId)||!ONCE_SHA.test(candidate||''))onceFail();
  await onceRun(request,r);
  const jobs=await request('GET','/actions/runs/'+r.runId+'/jobs?filter=all&per_page=100');
  const source=jobs.jobs?.filter(j=>j.name==='Produce daily '+CLOUD_ONCE.target);
  if(jobs.total_count!==jobs.jobs?.length||jobs.total_count>100||source?.length!==1
    ||source[0].head_sha!==main||source[0].run_id!==r.runId||source[0].conclusion!=='success'||source[0].status!=='completed')onceFail();
  const c=await request('GET','/commits/'+candidate+'?per_page=100');
  if(c.sha!==candidate||c.parents?.length!==1||c.parents[0].sha!==main
    ||c.author?.id!==RECOVERY_OWNER||c.commit?.verification?.verified!==true
    ||!Array.isArray(c.files)||!c.files.length||c.files.length>2
    ||!c.files.some(f=>f.filename==='fee-data-health.json')
    ||c.files.some(f=>!['data.json','fee-data-health.json'].includes(f.filename)||f.status!=='modified'))onceFail();
  if(await request('GET','/git/ref/tags/'+CLOUD_ONCE.tag+'-candidate')!==null)onceFail();
  await onceCreateRef(request,CLOUD_ONCE.tag+'-candidate',candidate);
  return {state:'candidate-recorded',candidate};
}
export async function cloudOnceStatus({main,now=new Date(),request}={}){
  if(!ONCE_SHA.test(main||'')||!Number.isFinite(now.getTime()))onceFail();
  const record=await onceClaimRecord(request,main);
  const candidateRef=await request('GET','/git/ref/tags/'+CLOUD_ONCE.tag+'-candidate');
  let candidate=null;
  if(candidateRef!==null){
    if(!record||candidateRef.ref!=='refs/tags/'+CLOUD_ONCE.tag+'-candidate'
      ||candidateRef.object?.type!=='commit'||!ONCE_SHA.test(candidateRef.object.sha))onceFail();
    candidate=candidateRef.object.sha;
  }
  const current=await request('GET','/git/ref/heads/main');
  if(candidate&&current.object?.sha===candidate)return {state:'terminal',reason:'published'};
  if(current.object?.sha!==main||now>=Date.parse(CLOUD_ONCE.finishBy))return {state:'terminal',reason:'closed'};
  if(!record)return {state:now>=Date.parse(CLOUD_ONCE.closeAt)?'terminal':'waiting',reason:'unclaimed'};
  const run=await onceRun(request,record);
  if(run.status!=='completed')return {state:'waiting',reason:'producer-running'};
  if(run.conclusion!=='success'||!candidate)return {state:'terminal',reason:'producer-failed-or-unbound'};
  const validation=await request('GET','/actions/workflows/validate-fee-data.yml/runs?head_sha='+candidate+'&event=push&per_page=100');
  if(!Array.isArray(validation.workflow_runs)||validation.total_count!==validation.workflow_runs.length||validation.total_count>1)onceFail();
  if(!validation.total_count)return {state:'waiting',reason:'validation-pending'};
  const v=validation.workflow_runs[0];
  if(v.head_sha!==candidate||v.path!=='.github/workflows/validate-fee-data.yml'||v.event!=='push'||v.run_attempt!==1
    ||!/^codex\/fee-daily-20261102-[a-z0-9]{6}$/.test(v.head_branch||''))onceFail();
  if(v.status!=='completed')return {state:'waiting',reason:'validation-pending'};
  if(v.conclusion!=='success')return {state:'terminal',reason:'validation-failed'};
  return {state:'candidate',candidate};
}
export async function cloudOnceControl(mode,{env=process.env,now=new Date(),request,readBudget,readEvent}={}){
  if(!['once-scope','once-admit','once-confirm','once-finish','once-promotion','once-cleanup'].includes(mode))onceFail();
  const main=env.FEE_REPORT_ONCE_MAIN||'';
  if(!main)return {state:'inactive'};
  if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!==ONCE_REPO||env.GITHUB_REF!=='refs/heads/main')onceFail();
  request||=((method,route,body)=>cloudOnceRequest(method,route,body,{token:env.GITHUB_TOKEN}));
  const reviewedManual=['once-scope','once-admit','once-confirm'].includes(mode)&&reviewedCloudOnceManual(env,readEvent);
  const args={main,head:env.GITHUB_SHA,event:env.GITHUB_EVENT_NAME,attempt:env.GITHUB_RUN_ATTEMPT,runId:env.GITHUB_RUN_ID,reviewedManual,now,request};
  if(mode==='once-scope')return {state:env.FEE_CLOUD_MODE==='publish'?cloudOnceWindow(args):'closed'};
  if(['once-admit','once-confirm'].includes(mode)&&env.FEE_CLOUD_MODE!=='publish')onceFail();
  if(mode==='once-admit')return admitCloudOnce({...args,plan:JSON.parse(env.ONCE_PLAN||'null'),readBudget});
  if(mode==='once-confirm')return confirmCloudOnce(args);
  if(mode==='once-finish'&&env.ONCE_PRODUCE_RESULT==='success'){
    try{return await recordCloudOnceCandidate({...args,candidate:env.ONCE_CANDIDATE_SHA});}
    catch{await pauseCloudOnce(request);onceFail();}
  }
  if(mode==='once-finish'&&env.ONCE_ADMIT_RESULT!=='skipped'&&env.ONCE_PRODUCE_RESULT!=='success')return pauseCloudOnce(request);
  let status;
  try{status=await cloudOnceStatus(args);}catch{if(mode!=='once-promotion')await pauseCloudOnce(request);onceFail();}
  const relevantValidationFailure=env.GITHUB_EVENT_NAME==='workflow_run'&&status.candidate
    &&env.ONCE_EVENT_HEAD===status.candidate&&env.ONCE_EVENT_CONCLUSION!=='success';
  if(mode==='once-cleanup'&&(relevantValidationFailure||['failure','cancelled','timed_out'].includes(env.ONCE_PROMOTE_RESULT)))return pauseCloudOnce(request);
  if(status.state==='terminal'&&mode!=='once-promotion')return pauseCloudOnce(request);
  if(!['once-finish','once-promotion','once-cleanup'].includes(mode))onceFail();
  return status;
}
// Read-only use of the existing encrypted private fund file from the *same*
// stable economic Gist snapshot. No new URL, key, storage or approval field.
export function managedTransferIdentitiesFromFund(economic,keyText,targetDate){
  if(economic?.fundProfileRaw==null)return null;
  try{
    if(economic.fundProfileStable!==true||typeof economic.fundProfileMatchesGist!=='function')throw Error();
    const raw=economic.fundProfileRaw;if(typeof raw!=='string'||Buffer.byteLength(raw)>1024*1024)throw Error();
    const outer=JSON.parse(raw),keys=[...raw.matchAll(/"((?:\\.|[^"\\])*)"\s*:/g)].map(m=>JSON.parse('"'+m[1]+'"'));
    if(Object.keys(outer).sort().join(',')!=='data,enc,v'||keys.length!==3||new Set(keys).size!==3||outer.enc!==true||outer.v!==1||typeof outer.data!=='string')throw Error();
    const bytes=Buffer.from(outer.data,'base64'),key=Buffer.from(String(keyText||'').replace(/-/g,'+').replace(/_/g,'/'),'base64');
    if(bytes.length<29||bytes.toString('base64')!==outer.data||key.length!==32)throw Error();
    const decipher=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(-16));
    const bundle=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()])));
    if(Object.keys(bundle).sort().join(',')!=='gid,library,profile,schema,updatedAt'||bundle.schema!=='fee-console.fund-remote.v1'||!economic.fundProfileMatchesGist(bundle.gid)||typeof bundle.updatedAt!=='string'||new Date(bundle.updatedAt).toISOString()!==bundle.updatedAt)throw Error();
    const checked=createFundInvestorCore().validateProfile(bundle.profile);if(!checked.ok)throw Error();
    const events=(checked.profile.subscriptions||[]).filter(e=>e.date===targetDate&&e.inKindClose);
    if(!events.length)return null;if(events.length!==1||!events[0].inKindClose.sourceBinding)throw Error();
    const {sourceKeys,sourceBinding:b}=events[0].inKindClose;
    return structuredClone(validateManagedTransferIdentities({schema:'fee-console.managed-transfer-identities.v1',date:targetDate,account:'webull',sourcePortfolioId:b.sourcePortfolioId,destinationPortfolioId:b.destinationPortfolioId,pairs:sourceKeys.map((key,i)=>{
      const m=/^sharesight:(\d+)->(\d+);holding:(\d+)$/.exec(key);return {sourceTradeId:Number(m[1]),sourceHoldingId:b.sourceHoldingIds[i],tradeId:Number(m[2]),holdingId:Number(m[3])};
    })}));
  }catch{fail('FUND_TRANSFER_INPUT_UNVERIFIED');}
}
export function periodBenchmark(cache,date){
  return selectReportBenchmark(cache,date);
}
export function normalizePeriodRead(raw,date,cache,{sourceMode='legacy-reconstruction'}={}){
  const benchmark=periodBenchmark(cache,date),input=normalizeRead(raw,date,{spy:benchmark.spy,qqq:benchmark.qqq,spyd:benchmark.spyd,qqqd:benchmark.qqqd},{sourceMode});
  return {...input,benchmark,sourceFingerprint:hash({sourceFingerprint:input.sourceFingerprint,benchmark})};
}
export async function captureReportRange({dates,cache,readOnce,sourceMode='legacy-reconstruction'}){
  if(!Array.isArray(dates)||!dates.length||dates.length>10||typeof readOnce!=='function'||dates.some((d,i)=>!reportDate(d)||(i&&d!==reportAddDays(dates[i-1],1))))fail('RANGE');
  const capture=async()=>{
    const result=[];
    for(const date of dates)result.push(normalizePeriodRead(await readOnce(date),date,cache,{sourceMode}));
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
    // Existing protected coverage may have come from the explicitly reviewed
    // early entry. Dedup it under the same closed target, without authorizing a
    // new early run or extending candidate-health freshness.
    const checkedPlan=plan.schema==='fee-console.report-plan.v2'?dailyReportPlan(plan.accountingThrough,plan.markets,{periodFrom:plan.periodFrom,reviewedSyncDate:plan.accountingThrough}):plan;
    if(validateHealth(h,{now:checked}).length||checked.getTime()>now.getTime()+300000||reportPlanReadiness(checkedPlan,checked).state!=='due'||h.targetDate!==plan.accountingThrough||!['updated','no-op'].includes(h.outcome)||h.dataSha256!==hash(state.data)||h.sourceDates.schwab!==plan.accountingThrough||h.sourceDates.webull!==plan.accountingThrough||h.sourceDates.benchmark!==plan.priceThrough)return false;
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
// Count source entries, not the four daily public-only gate executions. Job
// metadata includes every rerun attempt; no logs, secrets or new storage are used.
// Two is a hard per-kind/cutoff ceiling, not permission to retry financial IO.
export function sourceAttemptWindowStart(plan){
  return plan.schema==='fee-console.report-plan.v2'?reportAddDays(plan.accountingThrough,1)+'T00:00:00+08:00':plan.scheduledAt;
}
// One reviewed recovery only, on the unique immediate successor of this main.
// The parent pin avoids a self-referential SHA; dispatch also pins the actual
// signed merge SHA. Every later main is ineligible without a new policy review.
const RECOVERY_BASE='50d6454b062030d4ee6565a4d879c56b68e65911';
// Proposed admission for the complete Sharesight reference repair. It requires
// separate exact-head OWNER/runtime approval before deployment or execution.
// The old recovery was consumed. Keep all five failures and ordinary budget 2;
// this exception belongs only to the exact signed successor of this base.
const RECOVERY_REPAIR_BASE='aa04fabce3fa29ae48908019c07fb43003776fea';
const RECOVERY_REPAIR_FILES=Object.freeze(['docs/daily-data-contract.md','docs/fee-cloud-producer.md','scripts/daily-core.mjs','scripts/daily.mjs','scripts/daily.test.mjs','scripts/fee-cloud-producer.mjs','scripts/fee-cloud-source.mjs','scripts/fee-report-producer.mjs','scripts/fee-report-producer.test.mjs','scripts/fee-sharesight-transfers.mjs','scripts/fee-source-acceptance.test.mjs']);
const RECOVERY_TARGET='2026-10-28';
const RECOVERY_FAILED_RUNS=Object.freeze([
  {id:40803101364,jobId:123215645936,head:'fbb79a694acb232fbdb522939d98a933da03b1f2'},
  {id:40805169117,jobId:123222332691,head:'fbb79a694acb232fbdb522939d98a933da03b1f2'},
  {id:40815850578,jobId:123256663738,head:RECOVERY_BASE},
  {id:40864143294,jobId:123414594502,head:'b7dd66876b153a5ff8c486c11822d0e07816760a'},
  {id:40879617376,jobId:123467435194,head:RECOVERY_REPAIR_BASE},
]);
// Filled from the final index-only candidate bytes before this package freezes.
const RECOVERY_UI_BLOB='1f1218943293e035bbfe07fa56e9b74341c22177';
const RECOVERY_OWNER=283054367;
// Exact local integration batch. These bytes and successful synthetic tests
// do not replace approval of the final signed head or a one-time execution.
const REVISION_RECOVERY_FILES=Object.freeze([
  {path:'.github/workflows/fee-cloud-producer.yml',status:'modified'},
  {path:'.github/workflows/scripts-check.yml',status:'modified'},
  {path:'docs/fee-source-revision.md',status:'modified'},
  {path:'scripts/daily.mjs',status:'modified'},
  {path:'scripts/fee-cloud-producer.mjs',status:'modified'},
  {path:'scripts/fee-report-producer.mjs',status:'modified'},
  {path:'scripts/fee-report-producer.test.mjs',status:'modified'},
  {path:'scripts/fee-source-revision-runtime.mjs',status:'added'},
  {path:'scripts/fee-source-revision-runtime.test.mjs',status:'added'},
  {path:'scripts/fee-sync-revision-artifacts.mjs',status:'added'},
  {path:'scripts/fee-sync-revision-artifacts.test.mjs',status:'added'},
  {path:'scripts/fee-sync-revision-github.mjs',status:'added'},
  {path:'scripts/fee-sync-revision-github.test.mjs',status:'added'},
  {path:'scripts/ib-manager-report.mjs',status:'modified'},
  {path:'scripts/ib-manager-source-revision.mjs',status:'modified'},
  {path:'scripts/ib-manager-source-revision.test.mjs',status:'modified'},
  {path:'security/approval-tiers.json',status:'modified'},
].map(Object.freeze));
// END REVISION_RECOVERY_FILES
const SYNC_REVISION_CONTRACT='ib-source-revision-20261106-sync-v2';
const SYNC_REVISION_FILES=Object.freeze(["cloud/fee-clock/clock.py", "cloud/fee-clock/test_clock.py", "docs/fee-independent-clock.md", "docs/fee-source-revision.md", "scripts/fee-cloud-producer.mjs", "scripts/fee-cloud-source.test.mjs", "scripts/fee-report-producer.mjs", "scripts/fee-report-producer.test.mjs", "scripts/fee-source-revision-runtime.mjs", "scripts/fee-source-revision-runtime.test.mjs", "scripts/fee-sync-revision-artifacts.mjs", "scripts/fee-sync-revision-artifacts.test.mjs", "scripts/ib-manager-source-revision.mjs", "scripts/ib-manager-source-revision.test.mjs"].map(path=>Object.freeze({path,status:'modified'})));
// This new reviewed repair gets its own release binding. Historical v2 and
// diagnostic admissions remain tied to their original immutable releases.
const WIRE_REVISION_CONTRACT='ib-source-revision-20261106-sync-v3';
const WIRE_REVISION_FILES=Object.freeze([
  'docs/fee-source-revision.md','scripts/fee-report-producer.mjs','scripts/fee-report-producer.test.mjs',
  'scripts/fee-source-revision-runtime.mjs','scripts/fee-source-revision-runtime.test.mjs',
  'scripts/fee-sync-capture.test.mjs','scripts/fee-sync-revision-artifacts.mjs','scripts/fee-sync-revision-artifacts.test.mjs',
  'scripts/ib-manager-source.mjs','scripts/ib-manager-source.test.mjs',
].map(path=>Object.freeze({path,status:'modified'})));
// Production binding after the lexical v4 repair and diagnostic v8 release.
// Same target, historical artifacts and execution-bound sync model. This is
// neither diagnostic nor envelope admission and resets no prior consumption.
// Exact-head approval, protected merge and separate execution approval remain.
const METADATA_REVISION_CONTRACT='ib-source-revision-20261106-sync-v4';
const METADATA_REVISION_FILES=Object.freeze([
  'scripts/fee-report-producer.mjs','scripts/fee-report-producer.test.mjs',
  'scripts/fee-source-revision-runtime.mjs','scripts/fee-source-revision-runtime.test.mjs',
  'scripts/fee-sync-revision-artifacts.mjs','scripts/fee-sync-revision-artifacts.test.mjs',
].map(path=>Object.freeze({path,status:'modified'})));
const isProductionSyncRevision=contractId=>contractId===SYNC_REVISION_CONTRACT||contractId===WIRE_REVISION_CONTRACT||contractId===METADATA_REVISION_CONTRACT;
const DIAGNOSTIC_REVISION_CONTRACT='ib-source-revision-20261106-diagnostic-v1';
const ECONOMIC_DIAGNOSTIC_CONTRACT='ib-source-revision-20261106-diagnostic-v2';
const CASH_DIAGNOSTIC_CONTRACT='ib-source-revision-20261106-diagnostic-v3';
const INCOME_BOUNDARY_DIAGNOSTIC_CONTRACT='ib-source-revision-20261106-diagnostic-v4';
// Source-stability release: the same 2026-11-06 target and read-only purpose,
// pinned to the real main it would be released on. It is not the consumed v4
// admission and grants nothing until owner approval, merge and an owner run.
const SOURCE_STABILITY_DIAGNOSTIC_CONTRACT='ib-source-revision-20261106-diagnostic-v5';
// Record-order release: same 2026-11-06 target and read-only purpose, pinned to
// the real main 05731b0 it would be released on. Not the consumed v5 admission;
// grants nothing until owner approval, merge and an owner-started run.
const RECORD_ORDER_DIAGNOSTIC_CONTRACT='ib-source-revision-20261106-diagnostic-v6';
// Catalog-member/evidence release: same 2026-11-06 target and read-only purpose,
// pinned to the real main 4d569f5. Not the consumed v6 admission; grants nothing
// until owner approval, merge and an owner-started run. Once is procedural only.
const CATALOG_EVIDENCE_DIAGNOSTIC_CONTRACT='ib-source-revision-20261106-diagnostic-v7';
// Rebind the original diagnostic after the lexical v4 repair. Same target,
// artifact history and read-only purpose; no recovery, envelope or publication
// admission. Exact-head owner approval, merge and separate run authorization
// are still required. Once remains procedural, with no new attempt budget.
const ROOT_METADATA_DIAGNOSTIC_CONTRACT='ib-source-revision-20261106-diagnostic-v8';
const ROOT_METADATA_DIAGNOSTIC_FILES=Object.freeze([
  'scripts/fee-report-producer.mjs','scripts/fee-report-producer.test.mjs',
  'scripts/fee-source-revision-runtime.mjs','scripts/fee-source-revision-runtime.test.mjs',
  'scripts/fee-sync-revision-artifacts.mjs','scripts/fee-sync-revision-artifacts.test.mjs',
].map(path=>Object.freeze({path,status:'modified'})));
// Response-envelope evidence release: same 2026-11-06 window, its own purpose,
// pinned to the real main 08bb15e. It reads only the IB v3 envelope, decides no
// stability and has no writer; no diagnostic or recovery path accepts it and
// its admission accepts none of theirs. Once is procedural only.
const ENVELOPE_EVIDENCE_V1_CONTRACT='ib-source-revision-20261106-envelope-evidence-v1';
// The sub-located release: same purpose, window and 14-request limit, pinned to
// the real main c64b41a (parent 08bb15e) and its own exact five-file manifest.
// It is the only envelope release the admission accepts; the v1 binding stays
// for history and is refused. It grants nothing until the owner's exact-head
// approval, required checks, protected merge and a separately approved run.
const ENVELOPE_EVIDENCE_CONTRACT='ib-source-revision-20261106-envelope-evidence-v2';
const ENVELOPE_EVIDENCE_V2_FILES=Object.freeze(['docs/fee-source-revision.md','scripts/fee-report-producer.mjs','scripts/fee-report-producer.test.mjs',
  'scripts/ib-v3-envelope-evidence.mjs','scripts/ib-v3-envelope-evidence.test.mjs'].map(path=>Object.freeze({path,status:'modified'})));
const ENVELOPE_EVIDENCE_PURPOSE='read-only-envelope-evidence';
const ENVELOPE_EVIDENCE_FILES=Object.freeze([
  ...['.github/workflows/fee-cloud-producer.yml','.github/workflows/scripts-check.yml','docs/fee-source-revision.md',
    'scripts/fee-ratio-cloud-runtime.mjs','scripts/fee-report-producer.mjs','scripts/fee-report-producer.test.mjs',
    'scripts/fee-source-revision-diagnostic.mjs','security/approval-tiers.json'].map(path=>Object.freeze({path,status:'modified'})),
  ...['scripts/ib-v3-envelope-evidence.mjs','scripts/ib-v3-envelope-evidence.test.mjs'].map(path=>Object.freeze({path,status:'added'})),
]);
const isDiagnosticRevision=contractId=>contractId===DIAGNOSTIC_REVISION_CONTRACT||contractId===ECONOMIC_DIAGNOSTIC_CONTRACT||contractId===CASH_DIAGNOSTIC_CONTRACT||contractId===INCOME_BOUNDARY_DIAGNOSTIC_CONTRACT||contractId===SOURCE_STABILITY_DIAGNOSTIC_CONTRACT||contractId===RECORD_ORDER_DIAGNOSTIC_CONTRACT||contractId===CATALOG_EVIDENCE_DIAGNOSTIC_CONTRACT||contractId===ROOT_METADATA_DIAGNOSTIC_CONTRACT;
const DIAGNOSTIC_REVISION_PURPOSE='read-only-diagnostic';
const DIAGNOSTIC_REVISION_FILES=Object.freeze([
  ...['.github/workflows/fee-cloud-producer.yml','.github/workflows/scripts-check.yml','security/approval-tiers.json',
    'docs/fee-source-revision.md','scripts/fee-cloud-producer.mjs','scripts/fee-report-producer.mjs','scripts/fee-report-producer.test.mjs',
    'scripts/fee-source-revision-runtime.mjs','scripts/fee-sync-revision-artifacts.mjs','scripts/fee-sync-revision-artifacts.test.mjs',
    'scripts/fee-sync-revision-github.mjs','scripts/fee-sync-revision-github.test.mjs','scripts/ib-manager-source.test.mjs'].map(path=>Object.freeze({path,status:'modified'})),
  ...['scripts/fee-source-revision-diagnostic.mjs','scripts/fee-source-revision-diagnostic.test.mjs'].map(path=>Object.freeze({path,status:'added'})),
]);
const ECONOMIC_DIAGNOSTIC_FILES=Object.freeze([
  'docs/fee-source-revision.md','scripts/fee-economic-source.mjs','scripts/fee-economic-source.test.mjs',
  'scripts/fee-report-producer.mjs','scripts/fee-report-producer.test.mjs',
  'scripts/fee-source-revision-diagnostic.mjs','scripts/fee-source-revision-diagnostic.test.mjs',
  'scripts/fee-source-revision-runtime.mjs','scripts/fee-source-revision-runtime.test.mjs',
  'scripts/fee-sync-revision-artifacts.mjs','scripts/fee-sync-revision-artifacts.test.mjs',
  'scripts/ib-manager-source.mjs','scripts/ib-manager-source.test.mjs',
].map(path=>Object.freeze({path,status:'modified'})));
const CASH_DIAGNOSTIC_FILES=Object.freeze([
  'docs/fee-source-revision.md','scripts/fee-report-producer.mjs','scripts/fee-report-producer.test.mjs',
  'scripts/fee-source-revision-diagnostic.mjs','scripts/fee-source-revision-diagnostic.test.mjs',
  'scripts/fee-source-revision-runtime.mjs','scripts/fee-source-revision-runtime.test.mjs',
  'scripts/fee-sync-revision-artifacts.mjs','scripts/fee-sync-revision-artifacts.test.mjs',
  'scripts/ib-manager-source-revision.mjs','scripts/ib-manager-source-revision.test.mjs',
].map(path=>Object.freeze({path,status:'modified'})));
const INCOME_BOUNDARY_DIAGNOSTIC_FILES=Object.freeze([
  'scripts/fee-report-producer.mjs','scripts/fee-report-producer.test.mjs',
  'scripts/fee-source-revision-runtime.mjs','scripts/fee-source-revision-runtime.test.mjs',
  'scripts/fee-sync-revision-artifacts.mjs','scripts/fee-sync-revision-artifacts.test.mjs',
  'scripts/ib-manager-source.mjs','scripts/ib-manager-source.test.mjs',
  'scripts/ib-manager-source-revision.mjs','scripts/ib-manager-source-revision.test.mjs',
].map(path=>Object.freeze({path,status:'modified'})));
// BEGIN CATALOG_EVIDENCE_DIAGNOSTIC_FILES
const CATALOG_EVIDENCE_DIAGNOSTIC_FILES=Object.freeze([
  Object.freeze({path:'docs/fee-source-revision.md',status:'modified'}),
  Object.freeze({path:'docs/fee-unified-source-readiness.md',status:'modified'}),
  Object.freeze({path:'scripts/fee-report-producer.mjs',status:'modified'}),
  Object.freeze({path:'scripts/fee-report-producer.test.mjs',status:'modified'}),
  Object.freeze({path:'scripts/fee-source-lexical.mjs',status:'modified'}),
  Object.freeze({path:'scripts/fee-source-lexical.test.mjs',status:'modified'}),
  Object.freeze({path:'scripts/fee-source-revision-diagnostic.mjs',status:'modified'}),
  Object.freeze({path:'scripts/fee-source-revision-runtime.mjs',status:'modified'}),
  Object.freeze({path:'scripts/fee-source-revision-runtime.test.mjs',status:'modified'}),
  Object.freeze({path:'scripts/fee-sync-captured-inputs.mjs',status:'modified'}),
  Object.freeze({path:'scripts/fee-sync-revision-artifacts.mjs',status:'modified'}),
  Object.freeze({path:'scripts/fee-sync-revision-artifacts.test.mjs',status:'modified'}),
  Object.freeze({path:'scripts/ib-manager-source.mjs',status:'modified'}),
]);
// END CATALOG_EVIDENCE_DIAGNOSTIC_FILES
// BEGIN RECORD_ORDER_DIAGNOSTIC_FILES
const RECORD_ORDER_DIAGNOSTIC_FILES=Object.freeze([
  Object.freeze({path:'docs/fee-source-revision.md',status:'modified'}),
  Object.freeze({path:'docs/fee-unified-source-readiness.md',status:'modified'}),
  Object.freeze({path:'scripts/fee-report-producer.mjs',status:'modified'}),
  Object.freeze({path:'scripts/fee-report-producer.test.mjs',status:'modified'}),
  Object.freeze({path:'scripts/fee-source-lexical.mjs',status:'modified'}),
  Object.freeze({path:'scripts/fee-source-lexical.test.mjs',status:'modified'}),
  Object.freeze({path:'scripts/fee-source-revision-runtime.mjs',status:'modified'}),
  Object.freeze({path:'scripts/fee-source-revision-runtime.test.mjs',status:'modified'}),
  Object.freeze({path:'scripts/fee-sync-captured-inputs.mjs',status:'modified'}),
  Object.freeze({path:'scripts/fee-sync-revision-artifacts.mjs',status:'modified'}),
  Object.freeze({path:'scripts/fee-sync-revision-artifacts.test.mjs',status:'modified'}),
  Object.freeze({path:'scripts/ib-manager-source.mjs',status:'modified'}),
]);
// END RECORD_ORDER_DIAGNOSTIC_FILES
// BEGIN SOURCE_STABILITY_DIAGNOSTIC_FILES
const SOURCE_STABILITY_DIAGNOSTIC_FILES=Object.freeze([
  Object.freeze({path:'.github/workflows/scripts-check.yml',status:'modified'}),
  Object.freeze({path:'docs/fee-source-revision.md',status:'modified'}),
  Object.freeze({path:'docs/fee-unified-source-readiness.md',status:'modified'}),
  Object.freeze({path:'scripts/fee-cloud-source.mjs',status:'modified'}),
  Object.freeze({path:'scripts/fee-report-producer.mjs',status:'modified'}),
  Object.freeze({path:'scripts/fee-report-producer.test.mjs',status:'modified'}),
  Object.freeze({path:'scripts/fee-source-lexical.mjs',status:'added'}),
  Object.freeze({path:'scripts/fee-source-lexical.test.mjs',status:'added'}),
  Object.freeze({path:'scripts/fee-source-revision-runtime.mjs',status:'modified'}),
  Object.freeze({path:'scripts/fee-source-revision-runtime.test.mjs',status:'modified'}),
  Object.freeze({path:'scripts/fee-sync-captured-inputs.mjs',status:'modified'}),
  Object.freeze({path:'scripts/fee-sync-date-policy.mjs',status:'added'}),
  Object.freeze({path:'scripts/fee-sync-date-policy.test.mjs',status:'added'}),
  Object.freeze({path:'scripts/fee-sync-readiness.mjs',status:'modified'}),
  Object.freeze({path:'scripts/fee-sync-revision-artifacts.mjs',status:'modified'}),
  Object.freeze({path:'scripts/fee-sync-revision-artifacts.test.mjs',status:'modified'}),
  Object.freeze({path:'scripts/fee-sync-test-fixtures.mjs',status:'modified'}),
  Object.freeze({path:'scripts/ib-manager-source.mjs',status:'modified'}),
  Object.freeze({path:'scripts/ib-manager-source.test.mjs',status:'modified'}),
  Object.freeze({path:'security/approval-tiers.json',status:'modified'}),
]);
// END SOURCE_STABILITY_DIAGNOSTIC_FILES
// Preserve each consumed contract and its evidence. Each independently reviewed
// admission belongs only to its signed immediate successor; it neither resets
// ordinary attempts nor grants a future target/version a retry.
const RECOVERY_SCOPES=Object.freeze([
 Object.freeze({contractId:METADATA_REVISION_CONTRACT,admissionModel:'sync-cycle-v1',target:'2026-11-06',
  baseSha:'ea6ce4dcc6784979a4e5bd526d2a13ac0282ae2e',repairBase:'ea6ce4dcc6784979a4e5bd526d2a13ac0282ae2e',
  baseParents:Object.freeze(['860387709b954fdfc97f040031791258b9fa5b15']),fileManifest:METADATA_REVISION_FILES,
  uiBlob:'2bb9f66ac890ba87cec504ef72a5083c07670689'}),
 Object.freeze({contractId:ROOT_METADATA_DIAGNOSTIC_CONTRACT,purpose:DIAGNOSTIC_REVISION_PURPOSE,admissionModel:'sync-cycle-v1',target:'2026-11-06',
  baseSha:'860387709b954fdfc97f040031791258b9fa5b15',repairBase:'860387709b954fdfc97f040031791258b9fa5b15',
  baseParents:Object.freeze(['97101f6f75f7e5295acd232f7d69c32594ec4044']),fileManifest:ROOT_METADATA_DIAGNOSTIC_FILES,
  uiBlob:'2bb9f66ac890ba87cec504ef72a5083c07670689'}),
 Object.freeze({contractId:ENVELOPE_EVIDENCE_CONTRACT,purpose:ENVELOPE_EVIDENCE_PURPOSE,admissionModel:'envelope-evidence-v1',target:'2026-11-06',
  baseSha:'c64b41a16ede36e1fadc2a57e231118a5921899a',repairBase:'c64b41a16ede36e1fadc2a57e231118a5921899a',
  baseParents:Object.freeze(['08bb15e1f78ee067cfa8be96e1cfe14018410f0e']),fileManifest:ENVELOPE_EVIDENCE_V2_FILES,
  uiBlob:'2bb9f66ac890ba87cec504ef72a5083c07670689'}),
 Object.freeze({contractId:ENVELOPE_EVIDENCE_V1_CONTRACT,purpose:ENVELOPE_EVIDENCE_PURPOSE,admissionModel:'envelope-evidence-v1',target:'2026-11-06',
  baseSha:'08bb15e1f78ee067cfa8be96e1cfe14018410f0e',repairBase:'08bb15e1f78ee067cfa8be96e1cfe14018410f0e',
  baseParents:Object.freeze(['4d569f5c4aacbe4b75a760805de3ca1b5b3d5f6d']),fileManifest:ENVELOPE_EVIDENCE_FILES,
  uiBlob:'2bb9f66ac890ba87cec504ef72a5083c07670689'}),
 Object.freeze({contractId:CATALOG_EVIDENCE_DIAGNOSTIC_CONTRACT,purpose:DIAGNOSTIC_REVISION_PURPOSE,admissionModel:'sync-cycle-v1',target:'2026-11-06',
  baseSha:'4d569f5c4aacbe4b75a760805de3ca1b5b3d5f6d',repairBase:'4d569f5c4aacbe4b75a760805de3ca1b5b3d5f6d',
  baseParents:Object.freeze(['05731b04e8a0728a38ae773ea46194879c20fcc4']),fileManifest:CATALOG_EVIDENCE_DIAGNOSTIC_FILES,
  uiBlob:'2bb9f66ac890ba87cec504ef72a5083c07670689'}),
 Object.freeze({contractId:RECORD_ORDER_DIAGNOSTIC_CONTRACT,purpose:DIAGNOSTIC_REVISION_PURPOSE,admissionModel:'sync-cycle-v1',target:'2026-11-06',
  baseSha:'05731b04e8a0728a38ae773ea46194879c20fcc4',repairBase:'05731b04e8a0728a38ae773ea46194879c20fcc4',
  baseParents:Object.freeze(['b72cd6895c5990e4bb644b26f181d9f78313ca72']),fileManifest:RECORD_ORDER_DIAGNOSTIC_FILES,
  uiBlob:'2bb9f66ac890ba87cec504ef72a5083c07670689'}),
 Object.freeze({contractId:SOURCE_STABILITY_DIAGNOSTIC_CONTRACT,purpose:DIAGNOSTIC_REVISION_PURPOSE,admissionModel:'sync-cycle-v1',target:'2026-11-06',
  baseSha:'b72cd6895c5990e4bb644b26f181d9f78313ca72',repairBase:'b72cd6895c5990e4bb644b26f181d9f78313ca72',
  baseParents:Object.freeze(['e30015d7260e43622f8ad63a119b0efbef35acb4']),fileManifest:SOURCE_STABILITY_DIAGNOSTIC_FILES,
  uiBlob:'2bb9f66ac890ba87cec504ef72a5083c07670689'}),
 Object.freeze({contractId:INCOME_BOUNDARY_DIAGNOSTIC_CONTRACT,purpose:DIAGNOSTIC_REVISION_PURPOSE,admissionModel:'sync-cycle-v1',target:'2026-11-06',
  baseSha:'e30015d7260e43622f8ad63a119b0efbef35acb4',repairBase:'e30015d7260e43622f8ad63a119b0efbef35acb4',
  baseParents:Object.freeze(['f1d4454d25849e1908ba508f8c7f140389e425bb']),fileManifest:INCOME_BOUNDARY_DIAGNOSTIC_FILES,
  uiBlob:'2bb9f66ac890ba87cec504ef72a5083c07670689'}),
 Object.freeze({contractId:CASH_DIAGNOSTIC_CONTRACT,purpose:DIAGNOSTIC_REVISION_PURPOSE,admissionModel:'sync-cycle-v1',target:'2026-11-06',
  baseSha:'f1d4454d25849e1908ba508f8c7f140389e425bb',repairBase:'f1d4454d25849e1908ba508f8c7f140389e425bb',
  baseParents:Object.freeze(['22174f04cae8ac18a071930f491598b327e315c5']),fileManifest:CASH_DIAGNOSTIC_FILES,
  uiBlob:'2bb9f66ac890ba87cec504ef72a5083c07670689'}),
 Object.freeze({contractId:ECONOMIC_DIAGNOSTIC_CONTRACT,purpose:DIAGNOSTIC_REVISION_PURPOSE,admissionModel:'sync-cycle-v1',target:'2026-11-06',
  baseSha:'22174f04cae8ac18a071930f491598b327e315c5',repairBase:'22174f04cae8ac18a071930f491598b327e315c5',
  baseParents:Object.freeze(['b218f264c53e914d6469ec9f43824f48ccb7af18']),fileManifest:ECONOMIC_DIAGNOSTIC_FILES,
  uiBlob:'2bb9f66ac890ba87cec504ef72a5083c07670689'}),
 Object.freeze({contractId:WIRE_REVISION_CONTRACT,admissionModel:'sync-cycle-v1',target:'2026-11-06',
  baseSha:'b218f264c53e914d6469ec9f43824f48ccb7af18',repairBase:'b218f264c53e914d6469ec9f43824f48ccb7af18',
  baseParents:Object.freeze(['4f98318c73d1727d323febdcc72b7d5fbfb77f01']),fileManifest:WIRE_REVISION_FILES,
  uiBlob:'2bb9f66ac890ba87cec504ef72a5083c07670689'}),
 Object.freeze({contractId:DIAGNOSTIC_REVISION_CONTRACT,purpose:DIAGNOSTIC_REVISION_PURPOSE,admissionModel:'sync-cycle-v1',target:'2026-11-06',
  baseSha:'4f98318c73d1727d323febdcc72b7d5fbfb77f01',repairBase:'4f98318c73d1727d323febdcc72b7d5fbfb77f01',
  baseParents:Object.freeze(['50392c2fb5ec3b1b26e5515cdb0feebb48823d2d']),fileManifest:DIAGNOSTIC_REVISION_FILES,
  uiBlob:'2bb9f66ac890ba87cec504ef72a5083c07670689'}),
 Object.freeze({contractId:SYNC_REVISION_CONTRACT,admissionModel:'sync-cycle-v1',target:'2026-11-06',
  baseSha:'50392c2fb5ec3b1b26e5515cdb0feebb48823d2d',repairBase:'50392c2fb5ec3b1b26e5515cdb0feebb48823d2d',
  baseParents:Object.freeze(['d617fdd25315ca09a5f89a81630b04ae19b24d1b']),
  fileManifest:SYNC_REVISION_FILES,uiBlob:'2bb9f66ac890ba87cec504ef72a5083c07670689'}),
 Object.freeze({target:RECOVERY_TARGET,baseSha:RECOVERY_BASE,repairBase:RECOVERY_REPAIR_BASE,files:RECOVERY_REPAIR_FILES,failures:RECOVERY_FAILED_RUNS,uiBlob:RECOVERY_UI_BLOB}),
 Object.freeze({target:'2026-10-30',baseSha:'2ba1e968e7a5401c9bb90aac967f4e57e34a7078',repairBase:'2ba1e968e7a5401c9bb90aac967f4e57e34a7078',
  baseParents:Object.freeze(['7048510f1138b44113089b37ac112de30d95e105','7171c1a028e6557ae37529655c4d01c6fa9d817c']),
  files:Object.freeze(['.github/workflows/fee-cloud-producer.yml','scripts/fee-trade-cash-evidence.mjs','scripts/fee-cloud-source.test.mjs','scripts/fee-source-acceptance.test.mjs','scripts/fee-report-producer.mjs','scripts/fee-report-producer.test.mjs']),
  failures:Object.freeze([
   {id:41161244083,jobId:124419094644,head:'b08f45e76ca57323dbfdea6d7c17134c45cfa19c'},
   {id:41163889615,jobId:124427211645,head:'bac02b38b9ce52376464556575df9aadb17826ab'},
  ]),uiBlob:'26096fe78ad571d7a8a43476d2fbf72f1194797d'}),
 Object.freeze({target:'2026-11-04',baseSha:'c4effb80f56c913f4a903a4f016e6ae1cdf6cc97',repairBase:'c4effb80f56c913f4a903a4f016e6ae1cdf6cc97',
  files:Object.freeze(['.github/workflows/fee-cloud-producer.yml','scripts/fee-report-producer.mjs','scripts/fee-report-producer.test.mjs']),
  failures:Object.freeze([
   {id:41945445626,jobId:126976478739,head:'5923e40afcf4fa17e91a4be8d05aedce0fe8cc28'},
   {id:41964614855,jobId:127038682646,head:'f1d8a9e453e80cb5644749313597fe78faf171c8'},
  ]),uiBlob:'a2c44b8e0e19b875221ccf537141d9435683f72b'}),
 // One separately approved recovery after the Fund Records repair. Preserve
 // the failed completed-sync run and its clock intent; no automatic retry.
 Object.freeze({target:'2026-11-06',baseSha:'55f2cc9d60f360944b90ff610aee814589bb7cfc',repairBase:'55f2cc9d60f360944b90ff610aee814589bb7cfc',
  baseParents:Object.freeze(['94210904dd95b2ff4496cb68dab6b49950fe4f74','a81d1a20e7214a96f9eafc6e65ee38d31010bc35']),
  files:Object.freeze(['scripts/fee-report-producer.mjs','scripts/fee-report-producer.test.mjs']),
  failures:Object.freeze([
   {id:42309848352,jobId:128208373197,head:'94210904dd95b2ff4496cb68dab6b49950fe4f74'},
  ]),uiBlob:'2bb9f66ac890ba87cec504ef72a5083c07670689'}),
 Object.freeze({contractId:'ib-source-revision-20261106-v1',target:'2026-11-06',
  baseSha:'d617fdd25315ca09a5f89a81630b04ae19b24d1b',repairBase:'d617fdd25315ca09a5f89a81630b04ae19b24d1b',
  baseParents:Object.freeze(['4d798c77c9a9a5d459a75af45b4239c7c9cf984a','474e7b5a20f93358193791daf84d175a22e06d9e']),
  fileManifest:REVISION_RECOVERY_FILES,
  failures:Object.freeze([
   {id:42309848352,jobId:128208373197,head:'94210904dd95b2ff4496cb68dab6b49950fe4f74'},
   {id:42318324848,jobId:128236468656,head:'2c32d695f4f2dc057920fc690046ddf3e1ccdaee'},
  ]),uiBlob:'2bb9f66ac890ba87cec504ef72a5083c07670689'}),
]);
const uniqueRecoveryScope=matches=>matches.length===1?matches[0]:null;
const recoveryTargetKnown=target=>RECOVERY_SCOPES.some(s=>s.target===target);
const recoveryReleaseRecords=new WeakMap(),recoveryBudgetRecords=new WeakMap(),historicalAdmissions=new WeakMap(),diagnosticAdmissions=new WeakMap();
export const isHistoricalRevisionAdmission=value=>historicalAdmissions.get(value)?.active===true;
export function readHistoricalRevisionAdmission(value){
  const record=historicalAdmissions.get(value);if(!record?.active)fail('RECOVERY_SCOPE');return record.bindings;
}
export const isHistoricalRevisionDiagnosticAdmission=value=>diagnosticAdmissions.get(value)?.active===true;
export function readHistoricalRevisionDiagnosticAdmission(value){
  const record=diagnosticAdmissions.get(value);if(!record?.active)fail('RECOVERY_SCOPE');return record.bindings;
}
// No "first target wins": a repeated accounting date is selected only by its
// verified release parent/contract. The no-release fallback is for historical
// read-only accounting callers and cannot select the new revision contract.
const recoveryScope=(target,release)=>uniqueRecoveryScope(RECOVERY_SCOPES.filter(s=>s.target===target&&(release
  ?s.repairBase===release.repairBaseSha&&(s.contractId?s.contractId===release.contractId:release.contractId===undefined)
  :!s.contractId)));
function recoveryFileManifest(scope){
  if(!scope?.contractId)return scope?.files?.map(path=>({path,status:'modified'}))||[];
  const files=scope.fileManifest;
  if(!Array.isArray(files)||!files.length||files.length>64||new Set(files.map(f=>f?.path)).size!==files.length
      ||files.some(f=>!f||Object.keys(f).sort().join(',')!=='path,status'||typeof f.path!=='string'
        ||!/^(?:scripts|docs|security|cloud\/fee-clock|\.github\/workflows)\/[A-Za-z0-9._/-]+$/.test(f.path)
        ||f.path.split('/').some(x=>!x||x==='.'||x==='..')||!['added','modified'].includes(f.status)))fail('RECOVERY_RELEASE');
  return files;
}
// Public code/configuration only; this cannot create an admission capability.
export function reportHistoricalRecoveryManifest({contractId='ib-source-revision-20261106-v1'}={}){
  const scope=RECOVERY_SCOPES.find(s=>s.contractId===contractId);
  if(!scope?.contractId)fail('RECOVERY_SCOPE');
  return Object.freeze(recoveryFileManifest(scope).map(f=>Object.freeze({...f})));
}
export async function readPeriodSourceAttempts({plan,now,currentRunId=null,recoveryMain=null,recoveryRelease=null,actionsToken=process.env.FEE_REPORT_ACTIONS_TOKEN,fetchImpl=globalThis.fetch,assertAdmissionActive=null}={}){
  if(!validateReportPlan(plan)||!Number.isFinite(now?.getTime()))fail('SOURCE_ATTEMPT_METADATA');
  if(assertAdmissionActive!==null&&typeof assertAdmissionActive!=='function')fail('RECOVERY_METADATA');
  if(recoveryMain!==null&&!/^[a-f0-9]{40}$/.test(recoveryMain))fail('RECOVERY_METADATA');
  const scope=recoveryScope(plan.accountingThrough,recoveryRelease);
  if(scope?.admissionModel==='sync-cycle-v1'||scope?.purpose!==undefined)fail('RECOVERY_SCOPE');
  if(recoveryRelease!==null&&(recoveryMain===null||recoveryRelease.mainSha!==recoveryMain||!scope))fail('RECOVERY_METADATA');
  const root='https://api.github.com/repos/huanwujoy-crypto/fee-console/actions',from=new Date(sourceAttemptWindowStart(plan)).toISOString();
  const query=new URLSearchParams({branch:'main',created:from+'..'+now.toISOString(),per_page:'100'});
  // Only period and producer rechecks opt into their ephemeral actions:read token. An empty
  // configured token fails closed; unrelated public observers stay unchanged.
  if(actionsToken!==undefined&&(typeof actionsToken!=='string'||actionsToken.length<20||actionsToken.length>4096||/\s/.test(actionsToken)))throw new BoundedJsonError('AUTH_REQUIRED');
  if(scope?.contractId&&actionsToken===undefined)fail('RECOVERY_METADATA');
  const headers={Accept:'application/vnd.github+json',...(actionsToken===undefined?{}:{Authorization:'Bearer '+actionsToken})};
  const get=async url=>{
    assertAdmissionActive?.();
    const value=await boundedJson(async(target,init)=>{
      assertAdmissionActive?.();
      const response=await fetchImpl(target,init);
      if([401,403,429].includes(response?.status))throw new BoundedJsonError('HTTP_'+response.status);
      return response;
    },url,{method:'GET',headers},{timeoutMs:5000,maxBytes:512*1024});
    assertAdmissionActive?.();
    return value;
  };
  const listing=await get(root+'/workflows/fee-cloud-producer.yml/runs?'+query),seen=new Set(),jobsSeen=new Set();
  if(!Number.isSafeInteger(listing.total_count)||!Array.isArray(listing.workflow_runs)||listing.total_count!==listing.workflow_runs.length||listing.total_count>32)fail('SOURCE_ATTEMPT_METADATA');
  const runs=listing.workflow_runs;
  for(const r of runs){
    if(!Number.isSafeInteger(r.id)||r.id<=0||seen.has(r.id)||r.head_branch!=='main'||r.path!=='.github/workflows/fee-cloud-producer.yml'||!/^[a-f0-9]{40}$/.test(r.head_sha||'')||!['schedule','workflow_dispatch'].includes(r.event)||!Number.isFinite(Date.parse(r.created_at))||Date.parse(r.created_at)<Date.parse(from)||Date.parse(r.created_at)>now.getTime())fail('SOURCE_ATTEMPT_METADATA');
    seen.add(r.id);
  }
  const expected='Produce '+(plan.kind.startsWith('daily')?'daily':plan.kind==='monthly'?'monthly':'weekly')+' '+plan.accountingThrough;
  let attempts=0,inProgress=false;
  const evidence=recoveryMain===null?null:{currentRun:null,entries:[],reservations:[],otherSourceActive:false,...(scope?.contractId?{contractId:scope.contractId}:{})};
  for(const r of runs){
    if(String(r.id)===String(currentRunId||'')){
      if(evidence)evidence.currentRun={id:r.id,head:r.head_sha,attempt:r.run_attempt,event:r.event,workflowId:r.workflow_id,actorId:r.actor?.id,status:r.status,conclusion:r.conclusion};
      continue;
    }
    const payload=await get(root+'/runs/'+r.id+'/jobs?filter=all&per_page=100');
    if(!Number.isSafeInteger(payload.total_count)||!Array.isArray(payload.jobs)||!payload.jobs.length||payload.total_count!==payload.jobs.length||payload.total_count>100)fail('SOURCE_ATTEMPT_METADATA');
    for(const j of payload.jobs){
      if(!Number.isSafeInteger(j.id)||j.id<=0||jobsSeen.has(j.id)||j.run_id!==r.id||j.head_sha!==r.head_sha||typeof j.name!=='string'||!['queued','in_progress','completed','waiting','pending','requested'].includes(j.status))fail('SOURCE_ATTEMPT_METADATA');
      jobsSeen.add(j.id);
      // Burn a new manual admission even if cancelled/queued/skipped before
      // source entry. Only the exact failures in this target's contract are historical;
      // their already-consumed admission cannot reserve this new exception.
      if(evidence&&j.name==='period'&&r.event==='workflow_dispatch'&&[recoveryMain,scope?.repairBase].includes(r.head_sha)
          &&!scope?.failures.some(old=>old.id===r.id&&old.head===r.head_sha))evidence.reservations.push(r.id);
      if(j.conclusion==='skipped'){if(j.status!=='completed')fail('SOURCE_ATTEMPT_METADATA');continue;}
      if(evidence&&j.started_at!==null&&(!Number.isFinite(Date.parse(j.started_at))||Date.parse(j.started_at)<Date.parse(r.created_at)||Date.parse(j.started_at)>now.getTime()+300000))fail('RECOVERY_METADATA');
      // These two reviewed diagnostics cannot call the writer or publisher.
      // Keep their histories without consuming or resetting production attempts.
      if(j.name==='IB diagnostic 2026-11-04'||j.name==='IB diagnostic 2026-11-06'){
        if(r.event!=='workflow_dispatch'||r.display_title!==j.name||r.actor?.id!==RECOVERY_OWNER||r.run_attempt!==1)fail('SOURCE_ATTEMPT_METADATA');
        continue;
      }
      if(['period','watch','source-plan-check','once-admit','once-finish','ratio-preflight','ratio'].includes(j.name))continue;
      if(j.name!=='produce'&&!/^Produce (daily|weekly|monthly) \d{4}-\d{2}-\d{2}$/.test(j.name)&&!/^Source acceptance \d{4}-\d{2}-\d{2}$/.test(j.name))fail('SOURCE_ATTEMPT_METADATA');
      if(evidence&&j.status!=='completed')evidence.otherSourceActive=true;
      // A legacy unlabelled source job conservatively consumes either budget.
      if(j.name!==expected&&j.name!=='produce'&&j.name!=='Source acceptance '+plan.accountingThrough)continue;
      if(j.status==='completed'&&typeof j.conclusion!=='string')fail('SOURCE_ATTEMPT_METADATA');
      if(j.started_at!==null&&(!Number.isFinite(Date.parse(j.started_at))||Date.parse(j.started_at)<Date.parse(r.created_at)||Date.parse(j.started_at)>now.getTime()+300000))fail('SOURCE_ATTEMPT_METADATA');
      if(j.status!=='completed')inProgress=true;
      if(j.started_at!==null||j.status!=='completed'){
        attempts++;
        if(evidence)evidence.entries.push({runId:r.id,jobId:j.id,head:r.head_sha,attempt:r.run_attempt,event:r.event,runStatus:r.status,runConclusion:r.conclusion,name:j.name,status:j.status,conclusion:j.conclusion});
      }
    }
    if(attempts>=2&&!evidence)return {attempts,inProgress};
  }
  const result={attempts,inProgress,...(evidence?{recoveryEvidence:evidence}:{})};
  if(evidence)recoveryBudgetRecords.set(result,{scope,main:recoveryMain,currentRunId:Number(currentRunId),planHash:hash(plan),snapshot:hash(result)});
  return result;
}
async function reviewedRevisionHead(get,{expectedMain,commit,scope,signed}){
  // The approved head cannot be embedded into its own commit. Bind the exact
  // signed squash tree to the actual merged PR and its owner's precise comment.
  // Completeness is conservative: a full page is unknown, not permission.
  let associated;
  try{associated=await get('commits/'+expectedMain+'/pulls?per_page=100');}catch(error){metadataFrom('RELEASE_PR_ASSOCIATION',error);}
  if(!Array.isArray(associated)||associated.length!==1||!Number.isSafeInteger(associated[0]?.number)||associated[0].number<=0)fail('RECOVERY_RELEASE');
  const number=associated[0].number;let pr,comments;
  try{[pr,comments]=await Promise.all([get('pulls/'+number),get('issues/'+number+'/comments?per_page=100')]);}catch(error){metadataFrom('RELEASE_PR_COMMENTS',error);}
  const repo='huanwujoy-crypto/fee-console',head=pr.head?.sha,merged=Date.parse(pr.merged_at);
  if(pr.number!==number||pr.state!=='closed'||pr.merged!==true||pr.draft!==false||pr.merge_commit_sha!==expectedMain
      ||pr.user?.id!==RECOVERY_OWNER||pr.user?.login!=='huanwujoy-crypto'||pr.base?.ref!=='main'||pr.base?.repo?.full_name!==repo
      ||pr.head?.repo?.full_name!==repo||pr.commits!==1||!Number.isFinite(merged)||!/^[a-f0-9]{40}$/.test(head||'')
      ||head===expectedMain||!Array.isArray(comments)||comments.length>=100
      ||comments.some(c=>!Number.isSafeInteger(c?.id)||c.id<=0)||new Set(comments.map(c=>c.id)).size!==comments.length)fail('RECOVERY_RELEASE');
  const approvals=comments.filter(c=>c.user?.id===RECOVERY_OWNER&&c.user?.login==='huanwujoy-crypto'&&c.user?.type==='User'
    &&typeof c.body==='string'&&c.body.length<=16384&&c.body.split(/\r?\n/)[0].trim()==='/approve-xuan-ib-maintenance '+head
    &&Number.isFinite(Date.parse(c.created_at))&&Number.isFinite(Date.parse(c.updated_at))
    &&Date.parse(c.created_at)<=Date.parse(c.updated_at)&&Date.parse(c.updated_at)<=merged);
  if(!approvals.length)fail('RECOVERY_RELEASE');
  let reviewed;try{reviewed=await get('commits/'+head+'?per_page=1');}catch(error){metadataFrom('RELEASE_REVIEWED_HEAD',error);}
  if(reviewed.sha!==head||reviewed.parents?.length!==1||reviewed.parents[0].sha!==scope.repairBase
      ||!signed(reviewed)||reviewed.commit?.tree?.sha!==commit.commit.tree.sha)fail('RECOVERY_RELEASE');
  const chosen=[...approvals].sort((a,b)=>a.id-b.id)[0];
  return {approvedHead:head,approvedTree:commit.commit.tree.sha,approvedPullRequest:number,ownerApprovalCommentId:chosen.id,
    ownerApprovalCommentSha256:hash({id:chosen.id,user:chosen.user,body:chosen.body,created_at:chosen.created_at,updated_at:chosen.updated_at,issue_url:chosen.issue_url})};
}
// Fixed GitHub-verification sub-location for RECOVERY_METADATA, carried by
// error identity only: the message and every existing code stay unchanged. A
// stage names one call site. For a concurrent batch it names the request whose
// rejection settled first, not the only request sent: siblings may have been
// sent, succeeded or failed later. HTTP statuses map to fixed classes; nothing
// from a URL, query, header, token, body, stack or exception text is retained.
export const RECOVERY_METADATA_STAGES=Object.freeze(['RELEASE_SETUP','RELEASE_MAIN_COMMIT','RELEASE_TOKEN','RELEASE_BASE_COMPARE_TREE',
  'RELEASE_PR_ASSOCIATION','RELEASE_PR_COMMENTS','RELEASE_REVIEWED_HEAD','RELEASE_MAIN_RECHECK','REFRESH_RECORD','REFRESH_MAIN_COMMENT',
  'CURRENT_RUN','ADMISSION_RECHECK','UNKNOWN']);
export const RECOVERY_METADATA_REQUESTS=Object.freeze(['NONE','MAIN_REF','COMMIT','COMPARE','TREE','PR_ASSOCIATION','PR','PR_COMMENTS','COMMENT','RUN','OTHER']);
export const RECOVERY_METADATA_CATEGORIES=Object.freeze(['TOKEN_FORMAT','TOKEN_MISSING','ANONYMOUS_LIMIT','RECORD','FETCH_REJECTED','STREAM_FAILED',
  'TIMEOUT','ABORTED','RESPONSE_URL','HTTP_3XX','HTTP_401','HTTP_403','HTTP_404','HTTP_429','HTTP_4XX','HTTP_5XX','HTTP_OTHER',
  'SIZE','BODY','TYPE','JSON','CONFIG','UNKNOWN']);
const metadataRequestDiagnostics=new WeakMap(),metadataDiagnostics=new WeakMap();
export const recoveryMetadataDiagnostic=error=>error&&typeof error==='object'?metadataDiagnostics.get(error)||null:null;
const failMetadata=(stage,request='NONE',category='UNKNOWN')=>{
  const error=Error('FEE_REPORT_RECOVERY_METADATA');
  metadataDiagnostics.set(error,Object.freeze({stage,request,category}));throw error;
};
// The caught GET failure keeps its fixed request class and category; the call
// site supplies the stage. Anything unattributed is UNKNOWN, never a guess.
const metadataFrom=(stage,error)=>{
  const own=recoveryMetadataDiagnostic(error),request=error&&typeof error==='object'?metadataRequestDiagnostics.get(error):undefined;
  failMetadata(stage,own?.request||request?.request||'NONE',own?.category||request?.category||'UNKNOWN');
};
const metadataRequestClass=p=>p==='git/ref/heads/main'?'MAIN_REF':/^commits\/[a-f0-9]{40}\/pulls\?/.test(p)?'PR_ASSOCIATION'
  :/^commits\/[a-f0-9]{40}\?/.test(p)?'COMMIT':p.startsWith('compare/')?'COMPARE':p.startsWith('git/trees/')?'TREE'
  :/^pulls\/\d+$/.test(p)?'PR':/^issues\/\d+\/comments\?/.test(p)?'PR_COMMENTS':/^issues\/comments\/\d+$/.test(p)?'COMMENT'
  :/^actions\/runs\/\d+$/.test(p)?'RUN':'OTHER';
function metadataCategory(error,status,rejected){
  let code;try{if(error instanceof BoundedJsonError)code=Object.getOwnPropertyDescriptor(error,'code')?.value;}catch{}
  if(code==='HTTP'){
    if(!Number.isInteger(status))return 'HTTP_OTHER';
    if(status===200)return 'RESPONSE_URL';
    if(status>=300&&status<400)return 'HTTP_3XX';
    if([401,403,404,429].includes(status))return 'HTTP_'+status;
    return status>=400&&status<500?'HTTP_4XX':status>=500&&status<600?'HTTP_5XX':'HTTP_OTHER';
  }
  if(code==='NETWORK')return rejected?'FETCH_REJECTED':'STREAM_FAILED';
  return ['TIMEOUT','ABORTED','SIZE','BODY','TYPE','JSON','CONFIG'].includes(code)?code:'UNKNOWN';
}
function recoveryMetadataGet(fetchImpl,actionsToken){
  if(actionsToken!==undefined&&(typeof actionsToken!=='string'||actionsToken.length<20||actionsToken.length>4096||/\s/.test(actionsToken)))failMetadata('RELEASE_SETUP','NONE','TOKEN_FORMAT');
  const root='https://api.github.com/repos/huanwujoy-crypto/fee-console/';
  const counts={authenticated:0,anonymous:0};
  // Existing Actions permissions cover commits/trees/main/actions. Public PR
  // review endpoints deliberately use anonymous GET from the outset: this is
  // not an HTTP-error fallback and never grants extra token permissions.
  const get=p=>{
    const publicReview=/^(?:commits\/[a-f0-9]{40}\/pulls\?per_page=100|pulls\/[1-9]\d*|issues\/(?:[1-9]\d*\/comments\?per_page=100|comments\/[1-9]\d*))$/.test(p);
    const authenticated=!publicReview&&actionsToken!==undefined;
    const request=metadataRequestClass(p);
    if(authenticated)counts.authenticated++;else{if(counts.anonymous>=32)failMetadata('UNKNOWN',request,'ANONYMOUS_LIMIT');counts.anonymous++;}
    const headers={Accept:'application/vnd.github+json',...(authenticated?{Authorization:'Bearer '+actionsToken}:{})};
    // Observe only the numeric status and whether the transport rejected; the
    // response itself and every request option pass through unchanged.
    let status,rejected=false;
    const observed=async(target,init)=>{
      try{const response=await fetchImpl(target,init);status=typeof response?.status==='number'?response.status:undefined;return response;}
      catch(error){rejected=true;throw error;}
    };
    return boundedJson(observed,root+p,{method:'GET',headers},{timeoutMs:5000,maxBytes:512*1024}).catch(error=>{
      if(error&&typeof error==='object'&&!recoveryMetadataDiagnostic(error))metadataRequestDiagnostics.set(error,Object.freeze({request,category:metadataCategory(error,status,rejected)}));
      throw error;
    });
  };
  return {get,counts};
}
export async function readReportRecoveryRelease(expectedMain,{fetchImpl=globalThis.fetch,targetDate=null,actionsToken}={}){
  if(!/^[a-f0-9]{40}$/.test(expectedMain||''))fail('RECOVERY_RELEASE');
  if(targetDate!==null&&!recoveryTargetKnown(targetDate))fail('RECOVERY_RELEASE');
  const transport=recoveryMetadataGet(fetchImpl,actionsToken),get=transport.get;
  let ref,commit;try{[ref,commit]=await Promise.all([get('git/ref/heads/main'),get('commits/'+expectedMain+'?per_page=1')]);}catch(error){metadataFrom('RELEASE_MAIN_COMMIT',error);}
  const signed=c=>c.author?.id===RECOVERY_OWNER&&c.author?.login==='huanwujoy-crypto'
    &&['huanwujoy-crypto','web-flow'].includes(c.committer?.login)
    &&c.commit?.verification?.verified===true&&c.commit.verification.reason==='valid';
  const scope=uniqueRecoveryScope(RECOVERY_SCOPES.filter(s=>s.repairBase===commit.parents?.[0]?.sha&&(targetDate===null||s.target===targetDate)));
  if(ref.object?.sha!==expectedMain||commit.sha!==expectedMain||commit.parents?.length!==1
      ||!scope||!signed(commit)||!/^[a-f0-9]{40}$/.test(commit.commit?.tree?.sha||''))fail('RECOVERY_RELEASE');
  if(scope.contractId&&actionsToken===undefined)failMetadata('RELEASE_TOKEN','NONE','TOKEN_MISSING');
  const manifest=recoveryFileManifest(scope);
  let base,comparison,tree;
  try{[base,comparison,tree]=await Promise.all([get('commits/'+scope.repairBase+'?per_page=1'),get('compare/'+scope.repairBase+'...'+expectedMain+'?per_page=100'),get('git/trees/'+commit.commit.tree.sha+(scope.contractId?'?recursive=1':''))]);}catch(error){metadataFrom('RELEASE_BASE_COMPARE_TREE',error);}
  // No new UI version: the already deployed reviewed blob must remain exact.
  // Only this contract's reviewed files may differ from its pinned main.
  const files=comparison.files,indices=Array.isArray(tree.tree)?tree.tree.filter(f=>f.path==='index.html'):[];
  if(base.sha!==scope.repairBase||(scope.baseParents?(!Array.isArray(base.parents)||JSON.stringify(base.parents.map(p=>p.sha))!==JSON.stringify(scope.baseParents)):base.parents?.length!==1)||!signed(base)
    ||comparison.status!=='ahead'||comparison.ahead_by!==1||comparison.behind_by!==0||comparison.total_commits!==1
    ||comparison.base_commit?.sha!==scope.repairBase||comparison.merge_base_commit?.sha!==scope.repairBase
    ||comparison.commits?.length!==1||comparison.commits[0].sha!==expectedMain
    ||!Array.isArray(files)||files.length!==manifest.length||new Set(files.map(f=>f.filename)).size!==files.length
    ||files.some(f=>!manifest.some(m=>m.path===f.filename&&m.status===f.status)||f.previous_filename!==undefined||!/^[a-f0-9]{40}$/.test(f.sha||''))
    ||tree.sha!==commit.commit.tree.sha||tree.truncated!==false||indices.length!==1||indices[0].mode!=='100644'||indices[0].type!=='blob'||indices[0].sha!==scope.uiBlob)fail('RECOVERY_RELEASE');
  let reviewed={};
  if(scope.contractId){
    if(files.some(f=>{const matches=tree.tree.filter(t=>t.path===f.filename);return matches.length!==1||matches[0].mode!=='100644'||matches[0].type!=='blob'||matches[0].sha!==f.sha;}))fail('RECOVERY_RELEASE');
    reviewed=await reviewedRevisionHead(get,{expectedMain,commit,scope,signed});
    // Re-read main after PR/approval IO. Approval or tree hashes are bindings,
    // never a substitute for the caller's separate permission to execute.
    let current;try{current=await get('git/ref/heads/main');}catch(error){metadataFrom('RELEASE_MAIN_RECHECK',error);}
    if(current.object?.sha!==expectedMain)fail('RECOVERY_RELEASE');
  }
  const result=Object.freeze({mainSha:expectedMain,parent:scope.repairBase,baseSha:scope.baseSha,repairBaseSha:scope.repairBase,uiBlob:scope.uiBlob,signatureVerified:true,
    ...(scope.contractId?{contractId:scope.contractId,targetDate:scope.target,...reviewed}:{}),...(scope.purpose?{purpose:scope.purpose}:{})});
  recoveryReleaseRecords.set(result,{scope,snapshot:hash(result),get,counts:transport.counts});return result;
}
async function refreshHistoricalRelease(release){
  const record=recoveryReleaseRecords.get(release);
  if(!record?.scope.contractId||typeof record.get!=='function'||record.snapshot!==hash(release))failMetadata('REFRESH_RECORD','NONE','RECORD');
  let main,comment;
  try{[main,comment]=await Promise.all([record.get('git/ref/heads/main'),record.get('issues/comments/'+release.ownerApprovalCommentId)]);}catch(error){metadataFrom('REFRESH_MAIN_COMMENT',error);}
  if(main.object?.sha!==release.mainSha)fail('RECOVERY_RELEASE');
  // Git commit/tree identities and the merged squash relation are immutable.
  // The mutable owner comment is still re-read on every current-context check;
  // deletion/editing cannot be hidden by the per-admission immutable cache.
  if(comment?.id!==release.ownerApprovalCommentId||comment.user?.id!==RECOVERY_OWNER||comment.user?.login!=='huanwujoy-crypto'
      ||comment.user?.type!=='User'||comment.issue_url!=='https://api.github.com/repos/huanwujoy-crypto/fee-console/issues/'+release.approvedPullRequest
      ||typeof comment.body!=='string'||comment.body.length>16384||comment.body.split(/\r?\n/)[0].trim()!=='/approve-xuan-ib-maintenance '+release.approvedHead
      ||!Number.isFinite(Date.parse(comment.created_at))||!Number.isFinite(Date.parse(comment.updated_at))
      ||Date.parse(comment.created_at)>Date.parse(comment.updated_at)
      ||hash({id:comment.id,user:comment.user,body:comment.body,created_at:comment.created_at,updated_at:comment.updated_at,issue_url:comment.issue_url})!==release.ownerApprovalCommentSha256)fail('RECOVERY_RELEASE');
  return release;
}
export function validateReportRecoveryEvidence({plan,expectedMain,currentRunId,budget,release}={}){
  const e=budget?.recoveryEvidence,c=e?.currentRun,scope=recoveryScope(plan?.accountingThrough,release);
  if(scope?.admissionModel==='sync-cycle-v1'||scope?.purpose!==undefined)fail('RECOVERY_SCOPE');
  if(!validateReportPlan(plan)||!isReviewedDailyPlan(plan)||!scope||plan.kind!=='daily'||plan.markets.join(',')!=='NASDAQ,NYSE'
      ||!/^[a-f0-9]{40}$/.test(expectedMain||'')||expectedMain===scope.baseSha||release?.mainSha!==expectedMain||release.baseSha!==scope.baseSha
      ||release.repairBaseSha!==scope.repairBase||release.parent!==scope.repairBase||expectedMain===scope.repairBase||release.uiBlob!==scope.uiBlob||release.signatureVerified!==true)fail('RECOVERY_SCOPE');
  if(scope.contractId){
    recoveryFileManifest(scope);
    if(release.targetDate!==scope.target||e?.contractId!==scope.contractId||!/^[a-f0-9]{40}$/.test(release.approvedHead||'')
        ||!/^[a-f0-9]{40}$/.test(release.approvedTree||'')||release.approvedHead===expectedMain
        ||!/^[a-f0-9]{64}$/.test(release.ownerApprovalCommentSha256||'')
        ||!Number.isSafeInteger(release.approvedPullRequest)||release.approvedPullRequest<=0
        ||!Number.isSafeInteger(release.ownerApprovalCommentId)||release.ownerApprovalCommentId<=0)fail('RECOVERY_SCOPE');
  }
  if(!Number.isSafeInteger(Number(currentRunId))||Number(currentRunId)<=0||c?.id!==Number(currentRunId)||c.head!==expectedMain||c.attempt!==1||c.event!=='workflow_dispatch'||c.workflowId!==365873934||c.actorId!==RECOVERY_OWNER||c.status!=='in_progress'||c.conclusion!==null)fail('RECOVERY_RUN');
  if(budget.attempts!==scope.failures.length||budget.inProgress!==false||!Array.isArray(e.entries)||e.entries.length!==scope.failures.length||!Array.isArray(e.reservations)||e.reservations.length||e.otherSourceActive!==false)fail('RECOVERY_CONSUMED');
  if(e.entries.some(x=>!scope.failures.some(r=>r.id===x.runId&&r.head===x.head&&r.jobId===x.jobId)||x.attempt!==1||x.event!=='workflow_dispatch'||x.runStatus!=='completed'||x.runConclusion!=='failure'||x.name!=='Produce daily '+scope.target||x.status!=='completed'||x.conclusion!=='failure')
      ||new Set(e.entries.map(x=>x.runId)).size!==scope.failures.length||new Set(e.entries.map(x=>x.jobId)).size!==scope.failures.length)fail('RECOVERY_PRIOR_RUNS');
  return true;
}
// One known execution is checked, never a fabricated empty history. Production
// callers first validate the owner event and exact dispatch inputs. The existing
// workflow concurrency group serializes source work; pending publication blocks
// every new cycle until its outcome is resolved.
export async function readCurrentSyncRun({currentRunId,actionsToken=process.env.FEE_REPORT_ACTIONS_TOKEN,fetchImpl=globalThis.fetch}={}){
  if(!Number.isSafeInteger(Number(currentRunId))||Number(currentRunId)<=0||!/^\d+$/.test(String(currentRunId))||!actionsToken)fail('RECOVERY_RUN');
  try{return await recoveryMetadataGet(fetchImpl,actionsToken).get('actions/runs/'+currentRunId);}
  catch(error){metadataFrom('CURRENT_RUN',error);}
}
function currentSyncRunBinding(run,{currentRunId,expectedMain,now,diagnostic=false}){
  if(!Number.isFinite(now?.getTime())||!Number.isSafeInteger(Number(currentRunId))||Number(currentRunId)<=0
      ||run?.id!==Number(currentRunId)||run.workflow_id!==365873934||run.path!=='.github/workflows/fee-cloud-producer.yml'
      ||run.head_branch!=='main'||run.head_sha!==expectedMain||run.actor?.id!==RECOVERY_OWNER
      ||run.triggering_actor!==undefined&&run.triggering_actor?.id!==RECOVERY_OWNER
      ||run.repository?.full_name!==ONCE_REPO||run.event!=='workflow_dispatch'||run.run_attempt!==1
      ||run.status!=='in_progress'||run.conclusion!==null||!Number.isFinite(Date.parse(run.created_at))
      ||Date.parse(run.created_at)>now.getTime()+300000||diagnostic&&run.display_title!=='IB diagnostic 2026-11-06')fail('RECOVERY_RUN');
  return Object.freeze({id:run.id,workflowId:run.workflow_id,mainSha:run.head_sha,actorId:run.actor.id,
    attempt:run.run_attempt,event:run.event,createdAt:run.created_at,repository:run.repository.full_name,
    ...(diagnostic?{displayTitle:run.display_title}:{})});
}
function syncPublicationBinding(state,{plan,expectedMain,now}){
  if(!validateReportPlan(plan)||!isReviewedDailyPlan(plan)||reportPlanReadiness(plan,now).state!=='due'||!freshTarget(plan,now)
      ||state?.mainSha!==expectedMain||state.finalMainSha!==expectedMain||!Buffer.isBuffer(state.data)||!state.data.length
      ||state.data.length>=2*1024*1024||validateHealth(state.health,{now:new Date(state.health?.checkedAt)}).length
      ||Date.parse(state.health.checkedAt)>now.getTime()+300000||state.health.dataSha256!==hash(state.data)
      ||state.health.targetDate>=plan.accountingThrough||plan.periodFrom!==reportAddDays(state.health.targetDate,1)
      ||state.pending!==false)fail('RECOVERY_SCOPE');
  return Object.freeze({mainSha:expectedMain,dataSha256:hash(state.data),healthSha256:hash(state.health),publishedTarget:state.health.targetDate});
}
async function authorizeSyncRevision({release,plan,expectedMain,now,currentRunId,actionsToken,readCurrentRun,readState,clock,diagnostic=false}){
  const rr=recoveryReleaseRecords.get(release),scope=recoveryScope(plan?.accountingThrough,release);
  if(!rr||rr.scope!==scope||rr.snapshot!==hash(release)||scope?.admissionModel!=='sync-cycle-v1'
      ||(diagnostic?!isDiagnosticRevision(release.contractId):!isProductionSyncRevision(release.contractId))
      ||(diagnostic?scope.purpose!==DIAGNOSTIC_REVISION_PURPOSE||release.purpose!==DIAGNOSTIC_REVISION_PURPOSE:scope.purpose!==undefined||release.purpose!==undefined)
      ||release.mainSha!==expectedMain||release.targetDate!==plan?.accountingThrough
      ||plan?.kind!=='daily'||plan.markets.join(',')!=='NASDAQ,NYSE')fail('RECOVERY_SCOPE');
  readState||=((target,start)=>readPublicationState(target,start,undefined,{requireIb:true,strictCandidates:true}));
  const planHash=hash(plan);let active=true,checking=false,token=actionsToken;
  const assertActive=()=>{if(!active||typeof rr.get!=='function')fail('RECOVERY_CONSUMED');};
  const load=async at=>{
    assertActive();
    await refreshHistoricalRelease(release);assertActive();
    const run=currentSyncRunBinding(await readCurrentRun({currentRunId,actionsToken:token}),{currentRunId,expectedMain,now:at,diagnostic});assertActive();
    const publication=syncPublicationBinding(await readState(plan.accountingThrough,at.toISOString()),{plan,expectedMain,now:at});
    if(!active||hash(plan)!==planHash)fail('RECOVERY_CONSUMED');
    return hash({schema:diagnostic?'fee-console.ib-revision-diagnostic-execution.v1':'fee-console.sync-execution.v1',release,plan,run,publication});
  };
  const executionSha256=await load(now),bindings=Object.freeze({contractId:release.contractId,admissionModel:'sync-cycle-v1',
    ...(diagnostic?{purpose:DIAGNOSTIC_REVISION_PURPOSE}:{}),
    targetDate:release.targetDate,mainSha:expectedMain,repairBaseSha:release.repairBaseSha,
    approvedHead:release.approvedHead,approvedTree:release.approvedTree,currentRunId:Number(currentRunId),executionSha256});
  const record={bindings,active:true};
  const close=()=>{active=false;record.active=false;token=null;rr.get=null;};
  const admission=Object.freeze({async checkCurrent(){
    if(!active||checking)fail('RECOVERY_CONSUMED');checking=true;
    try{if(await load(clock())!==executionSha256)fail('RECOVERY_CONSUMED');return bindings;}
    catch(error){close();const codes=['RECOVERY_SCOPE','RECOVERY_RELEASE','RECOVERY_METADATA','RECOVERY_RUN','RECOVERY_CONSUMED'];
      let message;try{message=Object.getOwnPropertyDescriptor(error,'message')?.value;}catch{}
      fail(codes.find(c=>message==='FEE_REPORT_'+c)||'RECOVERY_METADATA');
    }finally{checking=false;}
  },close,readMetadataCounts(){return Object.freeze({...rr.counts});}});
  (diagnostic?diagnosticAdmissions:historicalAdmissions).set(admission,record);return admission;
}
// Separate read-only capability. It is never branded as a production admission;
// the dedicated CLI must additionally validate its exact diagnostic event inputs.
export async function authorizeHistoricalRevisionDiagnostic({plan,expectedMain,now=new Date(),currentRunId=process.env.GITHUB_RUN_ID,readRecoveryRelease=readReportRecoveryRelease,actionsToken=process.env.FEE_REPORT_ACTIONS_TOKEN,readCurrentRun=readCurrentSyncRun,readState,clock=()=>new Date()}={}){
  const release=await readRecoveryRelease(expectedMain,{targetDate:plan?.accountingThrough,actionsToken});
  if(!isDiagnosticRevision(release?.contractId)||release.purpose!==DIAGNOSTIC_REVISION_PURPOSE)fail('RECOVERY_SCOPE');
  return authorizeSyncRevision({release,plan,expectedMain,now,currentRunId,actionsToken,readCurrentRun,readState,clock,diagnostic:true});
}
// Separate read-only capability for the envelope evidence entry only. It binds
// the exact signed release, the owner's exact-head approval comment and the
// current owner run; it is never a diagnostic, recovery or production admission.
const envelopeAdmissions=new WeakMap();
export const isEnvelopeEvidenceAdmission=value=>envelopeAdmissions.get(value)?.active===true;
export async function authorizeEnvelopeEvidence({expectedMain,now=new Date(),currentRunId=process.env.GITHUB_RUN_ID,actionsToken=process.env.FEE_REPORT_ACTIONS_TOKEN,fetchImpl=globalThis.fetch,
  readRecoveryRelease=(sha,args)=>readReportRecoveryRelease(sha,{...args,fetchImpl}),readCurrentRun=args=>readCurrentSyncRun({...args,fetchImpl}),clock=()=>new Date()}={}){
  const release=await readRecoveryRelease(expectedMain,{targetDate:'2026-11-06',actionsToken}),rr=recoveryReleaseRecords.get(release);
  if(!rr||rr.snapshot!==hash(release)||rr.scope.contractId!==ENVELOPE_EVIDENCE_CONTRACT||rr.scope.purpose!==ENVELOPE_EVIDENCE_PURPOSE
      ||release.contractId!==ENVELOPE_EVIDENCE_CONTRACT||release.purpose!==ENVELOPE_EVIDENCE_PURPOSE||release.mainSha!==expectedMain
      ||release.targetDate!=='2026-11-06'||release.repairBaseSha!==rr.scope.repairBase)fail('RECOVERY_SCOPE');
  let active=true,checking=false,token=actionsToken;
  const load=async at=>{
    if(!active||typeof rr.get!=='function')fail('RECOVERY_CONSUMED');
    await refreshHistoricalRelease(release);
    const run=currentSyncRunBinding(await readCurrentRun({currentRunId,actionsToken:token}),{currentRunId,expectedMain,now:at,diagnostic:true});
    if(!active)fail('RECOVERY_CONSUMED');
    return hash({schema:'fee-console.ib-envelope-evidence-execution.v1',release,run});
  };
  const executionSha256=await load(now),bindings=Object.freeze({contractId:release.contractId,purpose:ENVELOPE_EVIDENCE_PURPOSE,
    targetDate:release.targetDate,mainSha:expectedMain,repairBaseSha:release.repairBaseSha,approvedHead:release.approvedHead,
    approvedTree:release.approvedTree,currentRunId:Number(currentRunId),executionSha256});
  const record={bindings,active:true};
  const close=()=>{active=false;record.active=false;token=null;rr.get=null;};
  const admission=Object.freeze({async checkCurrent(){
    if(!active||checking)fail('RECOVERY_CONSUMED');checking=true;
    try{if(await load(clock())!==executionSha256)fail('RECOVERY_CONSUMED');return bindings;}
    catch(error){close();const codes=['RECOVERY_SCOPE','RECOVERY_RELEASE','RECOVERY_METADATA','RECOVERY_RUN','RECOVERY_CONSUMED'];
      let message;try{message=Object.getOwnPropertyDescriptor(error,'message')?.value;}catch{}
      const code=codes.find(c=>message==='FEE_REPORT_'+c)||'RECOVERY_METADATA';
      // The fixed sub-location travels with the code; an unattributed failure
      // of this recheck is labelled as such, never given a guessed request.
      if(code==='RECOVERY_METADATA'){const own=recoveryMetadataDiagnostic(error);failMetadata(own?.stage||'ADMISSION_RECHECK',own?.request||'NONE',own?.category||'UNKNOWN');}
      fail(code);
    }finally{checking=false;}
  },close});
  envelopeAdmissions.set(admission,record);return admission;
}
export async function authorizeReportRecovery({plan,expectedMain,now=new Date(),currentRunId=process.env.GITHUB_RUN_ID,readSourceAttempts=readPeriodSourceAttempts,readRecoveryRelease=readReportRecoveryRelease,actionsToken=process.env.FEE_REPORT_ACTIONS_TOKEN,readCurrentRun=readCurrentSyncRun,readState,clock=()=>new Date()}={}){
  let cachedRelease=null,token=actionsToken;
  const initialRelease=await readRecoveryRelease(expectedMain,{targetDate:plan?.accountingThrough,actionsToken:token});
  if(isDiagnosticRevision(initialRelease?.contractId)||initialRelease?.purpose!==undefined)fail('RECOVERY_SCOPE');
  if(isProductionSyncRevision(initialRelease.contractId))return authorizeSyncRevision({release:initialRelease,plan,expectedMain,now,currentRunId,actionsToken:token,readCurrentRun,readState,clock});
  let initialPending=true;
  const load=async(at,reuseImmutable=false,assertAdmissionActive=null)=>{
    let budget,release;
    try{
      assertAdmissionActive?.();
      release=reuseImmutable?await refreshHistoricalRelease(cachedRelease):initialPending?initialRelease:await readRecoveryRelease(expectedMain,{targetDate:plan?.accountingThrough,actionsToken:token});initialPending=false;
      assertAdmissionActive?.();
      budget=await readSourceAttempts({plan,now:at,currentRunId,recoveryMain:expectedMain,recoveryRelease:release,actionsToken:token,assertAdmissionActive});
      assertAdmissionActive?.();
    }catch(error){
      assertAdmissionActive?.();
      let code;try{code=Object.getOwnPropertyDescriptor(error,'message')?.value;}catch{}
      if(['FEE_REPORT_RECOVERY_RELEASE','FEE_REPORT_RECOVERY_METADATA','FEE_REPORT_SOURCE_ATTEMPT_METADATA'].includes(code))fail(code.slice('FEE_REPORT_'.length));
      fail('RECOVERY_METADATA');
    }
    validateReportRecoveryEvidence({plan,expectedMain,currentRunId,budget,release});
    return {budget,release};
  };
  const first=await load(now);
  if(!first.release.contractId)return first.release;
  const bindingsOf=({budget,release})=>{
    const r=recoveryReleaseRecords.get(release),b=recoveryBudgetRecords.get(budget);
    if(!r||!b||r.scope!==b.scope||r.snapshot!==hash(release)||b.snapshot!==hash(budget)||b.main!==expectedMain
        ||b.currentRunId!==Number(currentRunId)||b.planHash!==hash(plan))fail('RECOVERY_METADATA');
    const evidence=budget.recoveryEvidence;
    const consumption={attempts:budget.attempts,inProgress:budget.inProgress,recoveryEvidence:{...evidence,
      entries:[...evidence.entries].sort((a,b)=>a.runId-b.runId||a.jobId-b.jobId),reservations:[...evidence.reservations].sort((a,b)=>a-b)}};
    return Object.freeze({contractId:release.contractId,targetDate:release.targetDate,mainSha:expectedMain,repairBaseSha:release.repairBaseSha,
      approvedHead:release.approvedHead,approvedTree:release.approvedTree,currentRunId:Number(currentRunId),consumptionSha256:hash(consumption)});
  };
  const bindings=bindingsOf(first),planSnapshot=hash(plan),record={bindings,active:true},counts=recoveryReleaseRecords.get(first.release).counts;let checking=false;cachedRelease=first.release;
  const close=()=>{record.active=false;token=null;const r=recoveryReleaseRecords.get(cachedRelease);if(r)r.get=null;cachedRelease=null;};
  const assertAdmissionActive=()=>{if(!record.active||cachedRelease===null||typeof recoveryReleaseRecords.get(cachedRelease)?.get!=='function')fail('RECOVERY_CONSUMED');};
  const admission=Object.freeze({async checkCurrent(){
    if(!record.active||checking)fail('RECOVERY_CONSUMED');checking=true;
    try{
      if(hash(plan)!==planSnapshot)fail('RECOVERY_SCOPE');
      const loaded=await load(new Date(),true,assertAdmissionActive);
      assertAdmissionActive();
      const current=bindingsOf(loaded);
      if(hash(current)!==hash(bindings))fail('RECOVERY_CONSUMED');return bindings;
    }catch(error){
      close();let code;try{code=Object.getOwnPropertyDescriptor(error,'message')?.value;}catch{}
      const safe=['RECOVERY_SCOPE','RECOVERY_RELEASE','RECOVERY_METADATA','RECOVERY_RUN','RECOVERY_CONSUMED','RECOVERY_PRIOR_RUNS','SOURCE_ATTEMPT_METADATA'];
      fail(safe.find(c=>code==='FEE_REPORT_'+c)||'RECOVERY_METADATA');
    }finally{checking=false;}
  },close,readMetadataCounts(){return Object.freeze({...counts});}});
  historicalAdmissions.set(admission,record);return admission;
}
const PERIOD_REASONS=new Set(['REPORT_NOT_DUE','ACCOUNTING_DAY_NOT_COMPLETE','SOURCE_DAY_NOT_CLOSED','CALENDAR_SCOPE_UNVERIFIED','ALL_RELEVANT_MARKETS_CLOSED','REPORT_SOURCE_RANGE_UNVERIFIED','REPORT_TARGET_OUTSIDE_PROMOTION_WINDOW','REPORT_SOURCE_RERUN_NOT_ALLOWED','REPORT_SOURCE_RUN_IN_PROGRESS','REPORT_SOURCE_ATTEMPT_BUDGET_EXHAUSTED','REPORT_DAILY_SOURCE_ALREADY_ATTEMPTED','REPORT_SOURCE_ATTEMPT_METADATA_UNVERIFIED','IB_BOUNDED_SAME_PERIOD_RECHECK']);
const METADATA_ERRORS=new Set(['CONFIG','ABORTED','HTTP','HTTP_401','HTTP_403','HTTP_429','TYPE','SIZE','BODY','TIMEOUT','JSON','NETWORK','METADATA_INVALID','AUTH_REQUIRED','UNKNOWN']);
function periodMetadataError(error){
  if(error instanceof BoundedJsonError&&METADATA_ERRORS.has(error.code))return error.code;
  if(error?.message==='FEE_REPORT_SOURCE_ATTEMPT_METADATA')return 'METADATA_INVALID';
  return 'UNKNOWN';
}
// The workflow uses this same projection; never render exception text or raw
// API fields. Reason/error enums describe a gate, not a source-read receipt.
export function reportPreflightSummary(result){
  if(result?.schema!=='fee-console.report-preflight.v1'||!['produce','already-published','not-due','waiting','candidate-pending','recovery-required'].includes(result.outcome))fail('PLAN');
  const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)?value:'not due';
  const reason=result.reasonCode===undefined?'NONE':PERIOD_REASONS.has(result.reasonCode)?result.reasonCode:'UNKNOWN';
  const metadata=result.reasonCode==='REPORT_SOURCE_ATTEMPT_METADATA_UNVERIFIED'&&METADATA_ERRORS.has(result.metadataCode)?result.metadataCode:null;
  return `## Fee report period\n\n- Decision: ${result.outcome}\n- Reason: ${reason}\n- Accounting cutoff: ${date(result.plan?.accountingThrough)}\n- Price cutoff: ${date(result.plan?.priceThrough)}\n${metadata?'- Metadata stage: SOURCE_ATTEMPTS\n- Metadata result: '+metadata+'\n':''}\nNo financial source or encrypted economic book is read by this gate.\n`;
}
export async function reportPublicationPreflight({now=new Date(),plan=null,reviewedSyncDate=null,confirmedMain=null,recoveryMain=null,scheduledDaily=false,ibEnabled=process.env.IB_MANAGER_READ_ENABLED==='true',currentRunId=process.env.GITHUB_RUN_ID,runAttempt=process.env.GITHUB_RUN_ATTEMPT,readRetryRuns=readPeriodRetryRuns,readSourceAttempts=readPeriodSourceAttempts,readRecoveryRelease=readReportRecoveryRelease,readCurrentRun=readCurrentSyncRun,readState}={}){
  readState||=((target,start)=>readPublicationState(target,start,undefined,{requireIb:ibEnabled,strictCandidates:confirmedMain!==null||recoveryMain!==null}));
  const plans=plan?[plan]:reportPlansAround(now);
  if(!plans.length)return {schema:'fee-console.report-preflight.v1',outcome:'not-due',plan:null};
  if(plans.some(p=>!validateReportPlan(p)))fail('PLAN');
  if(confirmedMain!==null&&(!ONCE_SHA.test(confirmedMain)||!plan||!isReviewedDailyPlan(plan)||reviewedSyncDate!==plan.accountingThrough||recoveryMain!==null||scheduledDaily))fail('CONFIRMED_MAIN_SCOPE');
  if(scheduledDaily&&(reviewedSyncDate!==null||recoveryMain!==null||!plan||!plan.kind.startsWith('daily')||isReviewedDailyPlan(plan)))fail('DAILY_SCOPE');
  if(recoveryMain!==null&&(!plan||!isReviewedDailyPlan(plan)||!recoveryTargetKnown(plan.accountingThrough)))fail('RECOVERY_SCOPE');
  if(plans.some(p=>isReviewedDailyPlan(p)&&reviewedSyncDate!==p.accountingThrough)
      ||reviewedSyncDate!==null&&(!plan||!isReviewedDailyPlan(plan)||reviewedSyncDate!==plan.accountingThrough))fail('MANUAL_SYNC_CONFIRMATION');
  const latest=plans.at(-1),startedAt=now.toISOString();
  let state=await readState(latest.accountingThrough,startedAt);
  if(confirmedMain!==null&&(state.mainSha!==confirmedMain||state.finalMainSha!==confirmedMain))fail('CONFIRMED_MAIN_CHANGED');
  if(state.mainSha!==state.finalMainSha||validateHealth(state.health,{now:new Date(state.health?.checkedAt)}).length||Date.parse(state.health?.checkedAt)>now.getTime()+300000||state.health?.dataSha256!==hash(state.data))fail('PUBLICATION_READ');
  if(plan&&state.health.targetDate>plan.accountingThrough)fail('HISTORY_AHEAD_OF_TARGET');
  const pending=plans.filter(p=>p.accountingThrough>=state.health.targetDate&&!publishedReportMatches(state,p,now));
  if(!pending.length){
    const covered={schema:'fee-console.report-preflight.v1',outcome:'already-published',plan:latest,mainSha:state.mainSha};
    // A completed-sync confirmation starts the same daily report once. It is
    // not consent to repeat the legacy same-period IB-only source check.
    if(recoveryMain!==null||scheduledDaily||reviewedSyncDate!==null)return covered;
    // Between reports coverage remains valid; this bounded IB retry never
    // rejuvenates stale health, changes target windows or retries every day.
    if(runAttempt!==undefined&&String(runAttempt)!=='1'||!ibEnabled||state.health.targetDate!==latest.accountingThrough||!freshTarget(latest,now)||validateHealth(state.health,{now}).length||now.getTime()-Date.parse(state.health.checkedAt)>12*3600000)return covered;
    if(state.pending)return {...covered,outcome:'candidate-pending'};
    try{
      const scheduledAt=sourceAttemptWindowStart(latest),runs=await readRetryRuns({scheduledAt,now});
      if(periodIbRetryAllowed({runs,currentRunId,scheduledAt,now}))return {...covered,outcome:'produce',reasonCode:'IB_BOUNDED_SAME_PERIOD_RECHECK'};
    }catch{/* IB metadata uncertainty cannot block or invalidate fee coverage. */}
    return covered;
  }
  const next=pending[0],readiness=reportPlanReadiness(next,now);
  if(readiness.state!=='due')return {schema:'fee-console.report-preflight.v1',outcome:'waiting',reasonCode:readiness.reasonCode,plan:next,mainSha:state.mainSha};
  if(!freshTarget(next,now))return {schema:'fee-console.report-preflight.v1',outcome:'recovery-required',reasonCode:'REPORT_TARGET_OUTSIDE_PROMOTION_WINDOW',plan:next,mainSha:state.mainSha};
  if(next.accountingThrough!==latest.accountingThrough)state=await readState(next.accountingThrough,startedAt);
  if(confirmedMain!==null&&(state.mainSha!==confirmedMain||state.finalMainSha!==confirmedMain))fail('CONFIRMED_MAIN_CHANGED');
  if(state.mainSha!==state.finalMainSha||validateHealth(state.health,{now:new Date(state.health?.checkedAt)}).length||state.health?.dataSha256!==hash(state.data)||state.health.targetDate>next.accountingThrough)fail('PUBLICATION_READ');
  if(publishedReportMatches(state,next,now))return {schema:'fee-console.report-preflight.v1',outcome:'already-published',plan:next,mainSha:state.mainSha};
  if(state.pending)return {schema:'fee-console.report-preflight.v1',outcome:'candidate-pending',plan:next,mainSha:state.mainSha};
  // Old workflow reruns can retain a creation date before this period. They
  // cannot be used to evade its metadata budget or replay one-time execution.
  if(runAttempt!==undefined&&String(runAttempt)!=='1')return {schema:'fee-console.report-preflight.v1',outcome:'waiting',reasonCode:'REPORT_SOURCE_RERUN_NOT_ALLOWED',plan:next,mainSha:state.mainSha};
  if(recoveryMain!==null){
    if(state.mainSha!==recoveryMain)fail('RECOVERY_RELEASE');
    await authorizeReportRecovery({plan:next,expectedMain:recoveryMain,now,currentRunId,readSourceAttempts,readRecoveryRelease,readCurrentRun,readState});
    return {schema:'fee-console.report-preflight.v1',outcome:'produce',plan:next,mainSha:state.mainSha};
  }
  if(confirmedMain!==null){
    currentSyncRunBinding(await readCurrentRun({currentRunId}),{currentRunId,expectedMain:confirmedMain,now});
    return {schema:'fee-console.report-preflight.v1',outcome:'produce',plan:next,mainSha:state.mainSha};
  }
  try{
    const budget=await readSourceAttempts({plan:next,now,currentRunId});
    if(!budget||!Number.isSafeInteger(budget.attempts)||budget.attempts<0||typeof budget.inProgress!=='boolean')throw Error();
    if(budget.inProgress||budget.attempts>=2)return {schema:'fee-console.report-preflight.v1',outcome:'waiting',reasonCode:budget.inProgress?'REPORT_SOURCE_RUN_IN_PROGRESS':'REPORT_SOURCE_ATTEMPT_BUDGET_EXHAUSTED',plan:next,mainSha:state.mainSha};
    // Repeated sync confirmations and later clocks are fallbacks for an
    // unstarted target, not permission to retry after financial entry. Keep
    // the ordinary 2-attempt accounting; explicit recovery is checked above.
    if((scheduledDaily||reviewedSyncDate!==null)&&budget.attempts!==0)return {schema:'fee-console.report-preflight.v1',outcome:'waiting',reasonCode:'REPORT_DAILY_SOURCE_ALREADY_ATTEMPTED',plan:next,mainSha:state.mainSha};
  }catch(error){return {schema:'fee-console.report-preflight.v1',outcome:'waiting',reasonCode:'REPORT_SOURCE_ATTEMPT_METADATA_UNVERIFIED',metadataCode:periodMetadataError(error),plan:next,mainSha:state.mainSha};}
  return {schema:'fee-console.report-preflight.v1',outcome:'produce',plan:next,mainSha:state.mainSha};
}
export async function dailyPublicationPreflight({now=new Date(),targetDate=null,reviewedSyncDate=null,markets=String(process.env.FEE_REPORT_MARKETS||'').split(',').filter(Boolean),readState,...options}={}){
  if(options.scheduledDaily&&(targetDate!==null||reviewedSyncDate!==null||options.confirmedMain!=null||options.recoveryMain!=null))fail('DAILY_SCOPE');
  if(options.confirmedMain!=null&&(!ONCE_SHA.test(options.confirmedMain)||!targetDate||reviewedSyncDate!==targetDate||options.recoveryMain!=null))fail('CONFIRMED_MAIN_SCOPE');
  const localDate=(zone)=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const target=targetDate||reportAddDays(localDate('Asia/Hong_Kong'),-1),base={schema:'fee-console.report-preflight.v1',plan:null};reportDate(target);
  if(reviewedSyncDate!==null&&(!targetDate||reportDate(reviewedSyncDate)!==target))fail('MANUAL_SYNC_CONFIRMATION');
  let sessions;try{sessions=sessionUnion(target,markets);}catch{return {...base,outcome:'waiting',reasonCode:'CALENDAR_SCOPE_UNVERIFIED'};}
  if(sessions.rows.some(row=>row.state==='unknown'))return {...base,outcome:'waiting',reasonCode:'CALENDAR_SCOPE_UNVERIFIED'};
  if(sessions.state==='closed')return {...base,outcome:'not-due',reasonCode:'ALL_RELEVANT_MARKETS_CLOSED'};
  const initial=dailyReportPlan(target,markets,{reviewedSyncDate}),readiness=reportPlanReadiness(initial,now);
  if(reviewedSyncDate!==null&&readiness.state!=='due'||reviewedSyncDate===null&&now.getTime()<Date.parse(initial.scheduledAt))return {...base,outcome:'waiting',reasonCode:readiness.reasonCode};
  readState||=((target,start)=>readPublicationState(target,start,undefined,{requireIb:options.ibEnabled??process.env.IB_MANAGER_READ_ENABLED==='true',strictCandidates:options.confirmedMain!=null||options.recoveryMain!=null}));
  const state=await readState(target,now.toISOString());
  if(options.confirmedMain!=null&&(state.mainSha!==options.confirmedMain||state.finalMainSha!==options.confirmedMain))fail('CONFIRMED_MAIN_CHANGED');
  if(!state.health||state.health.targetDate>target)fail('HISTORY_AHEAD_OF_TARGET');
  let plan;try{plan=dailyReportPlan(target,markets,{periodFrom:state.health.targetDate===target?target:reportAddDays(state.health.targetDate,1),reviewedSyncDate});}catch{return {...base,outcome:'recovery-required',reasonCode:'REPORT_SOURCE_RANGE_UNVERIFIED'};}
  return reportPublicationPreflight({...options,now,plan,reviewedSyncDate,readState:async()=>state});
}
// A distinct opt-in reuses the original daily producer and promotion path.
// The consumed one-off remains authoritative until its active binding is
// explicitly retired; its immutable tags and attempt history are never reset.
export function scheduledDailyContext(args,{env=process.env,now=new Date(),readEvent}={}){
  const automatic=env.FEE_AUTOMATIC_DAILY_REQUEST==='true';
  if(automatic){
    try{
      if(env.GITHUB_EVENT_NAME!=='workflow_dispatch'||env.GITHUB_ACTOR_ID!==String(RECOVERY_OWNER)||env.FEE_REPORT_ONCE_MAIN)throw Error();
      const event=readEvent?readEvent():(()=>{const p=env.GITHUB_EVENT_PATH;if(!p||fs.statSync(p).size>256*1024)throw Error();return JSON.parse(fs.readFileSync(p,'utf8'));})();
      const i=event?.inputs,off=v=>v===undefined||v===false||v==='false',blank=v=>v===undefined||v==='';
      const bools=['ib_envelope_once','ib_diagnostic_once','run_reviewed_once','source_plan_check_only','source_acceptance_once'];
      const strings=['ib_envelope_main','ib_diagnostic_main','report_target','report_markets','manual_sync_completed_for','confirmed_main','recovery_main','ratio_main','ratio_plan','source_from','source_target','source_main'];
      if(event.sender?.id!==RECOVERY_OWNER||event.repository?.full_name!==ONCE_REPO||!i||Array.isArray(i)
          ||i.report_kind!=='automatic-daily'||Object.keys(i).some(k=>!['report_kind',...bools,...strings].includes(k))
          ||!bools.every(k=>off(i[k]))||!strings.every(k=>blank(i[k])))throw Error();
    }catch{fail('DAILY_SCOPE');}
  }else if(env.GITHUB_EVENT_NAME!=='schedule'||env.FEE_REPORT_ONCE_MAIN)return false;
  if(env.FEE_REPORT_DAILY_ENABLED!=='true'||env.FEE_REPORT_PERIODS_ENABLED!=='true'||env.FEE_CLOUD_MODE!=='publish'
      ||env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!=='huanwujoy-crypto/fee-console'||env.GITHUB_REF!=='refs/heads/main'
      ||env.GITHUB_RUN_ATTEMPT!=='1'||!/^\d+$/.test(env.GITHUB_RUN_ID||'')||!Number.isSafeInteger(Number(env.GITHUB_RUN_ID))||Number(env.GITHUB_RUN_ID)<=0
      ||!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA||'')||!['preflight','produce'].includes(args.mode))fail('DAILY_SCOPE');
  if(args.mode==='preflight'){
    if(Object.keys(args).join(',')!=='mode')fail('DAILY_SCOPE');
  }else{
    const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
    if(args['report-kind']!=='daily'||args['report-target']!==reportAddDays(day,-1)
        ||args['manual-sync-completed-for']||args['confirmed-main']||args['recovery-main']||env.PLANNED_MAIN!==env.GITHUB_SHA)fail('DAILY_SCOPE');
  }
  return true;
}
export async function reportPublicationWatch({mainSha,health,data,now=new Date(),daily=false,markets}={}){
  if(!/^[a-f0-9]{40}$/.test(mainSha||''))fail('PUBLICATION_READ');
  const state={mainSha,finalMainSha:mainSha,health,data,pending:false};
  const result=await(daily?dailyPublicationPreflight({now,markets,ibEnabled:false,readState:async()=>state}):reportPublicationPreflight({now,ibEnabled:false,readState:async()=>state}));
  if(daily){
    const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
    if(result.outcome==='already-published')return {schema:'fee-console.report-watch.v1',outcome:'published',accountingThrough:health.targetDate};
    if(result.outcome==='not-due'||result.outcome==='waiting'&&['REPORT_NOT_DUE','ACCOUNTING_DAY_NOT_COMPLETE'].includes(result.reasonCode))return {schema:'fee-console.report-watch.v1',outcome:result.outcome,reasonCode:result.reasonCode,accountingThrough:health.targetDate};
    if(result.outcome==='produce'&&now.getTime()<Date.parse(day+'T14:00:00+08:00'))return {schema:'fee-console.report-watch.v1',outcome:'waiting',reasonCode:'AWAITING_SAME_DAY_SOURCE_CHECK',accountingThrough:health.targetDate};
    fail('PUBLISHED_PERIOD_MISSING');
  }
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
export function reportFailureCode(error,stage='UNKNOWN'){
  return /^FEE_REPORT_[A-Z_]{1,64}$/.test(error?.message||'')?error.message:producerFailureCode(error,stage);
}
export async function produceReportPeriod(options={}){
  let stage='CONFIG';
  try{return await produceReportPeriodRun(options,value=>{stage=value;});}
  catch(error){if(error instanceof SourceFetchError)throw error;throw Error(reportFailureCode(error,stage));}
}
async function produceReportPeriodRun({plan,reviewedSyncDate=null,outputDir,benchmarkFile,now=new Date(),readOnce,ibReader,requireIb=false,fetchEconomic=fetchEconomicSnapshot,sourceFile=path.join(ROOT,'data.json'),historicalRevisionAdmission=null},setStage){
  if(process.env.GITHUB_RUN_ATTEMPT!==undefined&&process.env.GITHUB_RUN_ATTEMPT!=='1')fail('SOURCE_RERUN_NOT_ALLOWED');
  if(!validateReportPlan(plan)||reportPlanReadiness(plan,now).state!=='due')fail('NOT_READY');
  if(isReviewedDailyPlan(plan)?reviewedSyncDate!==plan.accountingThrough:reviewedSyncDate!==null)fail('MANUAL_SYNC_CONFIRMATION');
  if(!freshTarget(plan,now))fail('RECOVERY_REQUIRED');
  // A caller-supplied JSON approval or reader cannot activate historical repair.
  // The new recovery contract must have passed the real release/budget reader.
  if(historicalRevisionAdmission!==null&&(!isHistoricalRevisionAdmission(historicalRevisionAdmission)
    ||!requireIb||readOnce!==undefined||ibReader!==undefined||sourceFile!==path.join(ROOT,'data.json')))fail('REVISION_ADMISSION');
  if(historicalRevisionAdmission!==null){
    const admitted=readHistoricalRevisionAdmission(historicalRevisionAdmission);
    if(admitted.targetDate!==plan.accountingThrough||admitted.mainSha!==process.env.GITHUB_SHA
      ||!isReviewedDailyPlan(plan))fail('REVISION_ADMISSION');
    await historicalRevisionAdmission.checkCurrent();
  }
  if(requireIb)assertIbManagerConfiguration();
  const output=outputDirectory(outputDir),originalBytes=fs.readFileSync(sourceFile),payload=decryptCandidate(sourceFile,process.env.FEE_DATA_KEY);
  // Reuse only this existing in-memory plaintext. These ids associate a safe
  // failure diagnostic, not Sharesight event identity or reconciliation
  // authority. Preserve duplicates so ambiguous ids remain explicitly unknown.
  const baselineRows=payload.flowsUnresolved;
  const baselineUnresolvedIds=Array.isArray(baselineRows)&&baselineRows.every(row=>typeof row?.id==='string'&&row.id!=='')
    ?baselineRows.map(row=>row.id):null;
  const latest=payload.daily?.map(p=>p.d).sort().at(-1),dates=reportWindowDates(latest,plan.accountingThrough);
  setStage('BENCHMARK');
  const cache=JSON.parse(fs.readFileSync(benchmarkFile));
  dates.forEach(date=>periodBenchmark(cache,date));
  if(periodBenchmark(cache,plan.accountingThrough).sourceDate!==plan.priceThrough)fail('BENCHMARK');
  let economic,revisionRuntime,ibRevision;const runtime=path.join(output,'period-private');
  setStage('PREPARE');
  if(fs.existsSync(runtime)||['data.json','fee-data-health.json'].some(f=>fs.existsSync(path.join(output,f))))fail('OUTPUT_EXISTS');
  fs.mkdirSync(runtime,{mode:0o700});
  try{
    // Freeze one private economic revision for the entire range. No intermediate
    // candidate can escape. Recheck again after all daily receipts are proved.
    setStage('ECONOMIC_READ');
    economic=await fetchEconomic();if(economic.envelopeVersion!==4)fail('ECON_VERSION');
    if(historicalRevisionAdmission!==null){
      setStage('REVISION_PREPARE');
      const {createFeeSourceRevisionRuntime}=await import('./fee-source-revision-runtime.mjs');
      revisionRuntime=await createFeeSourceRevisionRuntime({plan,admission:historicalRevisionAdmission,economicSnapshot:economic,
        sourceBytes:originalBytes,sourcePayload:payload,healthBytes:fs.readFileSync(path.join(ROOT,'fee-data-health.json')),
        githubToken:process.env.FEE_REPORT_ACTIONS_TOKEN,clientId:process.env.FEE_CLOUD_SHARESIGHT_CLIENT_ID,
        clientSecret:process.env.FEE_CLOUD_SHARESIGHT_CLIENT_SECRET,keyText:process.env.FEE_DATA_KEY,
        baselineSha256:process.env.IB_MANAGER_BASELINE_SHA256,legacySourcePath:process.env.FEE_ECON_V3_FILE||null,
        fetchImpl:globalThis.fetch,clock:Date.now});
      ibRevision=await revisionRuntime.prepare();
    }
    setStage('READER_SETUP');
    const transferInputs=new Map(dates.map(date=>[date,managedTransferIdentitiesFromFund(economic,process.env.FEE_DATA_KEY,date)]));
    const needsFund=Array.from(transferInputs.values()).some(Boolean);
    setStage('SOURCE_READ');
    const reads=await captureReportRange({dates,cache,sourceMode:'sharesight-reference',readOnce:readOnce||(async date=>new SharesightCloudReader({clientId:process.env.FEE_CLOUD_SHARESIGHT_CLIENT_ID,clientSecret:process.env.FEE_CLOUD_SHARESIGHT_CLIENT_SECRET,incomeDateEvidence:incomeDateEvidenceFromData(payload,date),reconcileInKind:true,managedTransferIdentities:transferInputs.get(date),managementExemptionRegistry:payload.managementExemptionRegistry,sourceMode:'sharesight-reference'}).readOnce(date))});
    let base=sourceFile,result;
    for(let i=0;i<reads.length;i++){
      setStage('PREPARE');
      const input=reads[i],final=i===reads.length-1,dayDir=path.join(runtime,input.targetDate);fs.mkdirSync(dayDir,{mode:0o700});
      setStage('WRITER');
      result=await produce({cli:{'benchmark-file':benchmarkFile,'target-date':input.targetDate,'checked-at':now.toISOString(),'out-dir':dayDir},periodMode:true,baseDataFile:base===sourceFile?undefined:base,
        flowDiagnosticContext:{baselineUnresolvedIds,processingDate:input.targetDate,processingIndex:i+1,reportTarget:plan.accountingThrough},
        // The root source is fixed; a caller-provided synthetic source is
        // accepted only by the test/library entry, never the CLI/workflow.
        ...(base===sourceFile&&sourceFile!==path.join(ROOT,'data.json')?{baseDataFile:base}:{}),
        reader:{async readStable(target){if(target!==input.targetDate)fail('RANGE');return structuredClone(input);}},
        fetchEconomic:async()=>({...economic,cleanup(){}}),includeIb:final,requireIb:requireIb&&final,ibReader,
        ...(final?{reportPlan:plan,...(ibRevision?{ibRevision}:{})}:{})});
      base=result.dataFile;
    }
    setStage('ECONOMIC_RECHECK');
    await economic.checkCurrent(needsFund?{requireFundProfile:true}:{});
    if(revisionRuntime)await revisionRuntime.checkCurrent();
    if(!fs.readFileSync(sourceFile).equals(originalBytes))fail('BASE_CHANGED');
    if(requireIb)await assertIbManagerPublication(decryptCandidate(result.dataFile,process.env.FEE_DATA_KEY),plan.accountingThrough);
    if(process.env.IB_MANAGER_READ_ENABLED==='true'&&latest===plan.accountingThrough){
      assertPeriodIbRecheckUnchanged(payload,decryptCandidate(result.dataFile,process.env.FEE_DATA_KEY));
    }
    setStage('PREPARE');
    for(const name of ['data.json','fee-data-health.json'])fs.copyFileSync(path.join(path.dirname(result.dataFile),name),path.join(output,name),fs.constants.COPYFILE_EXCL);
    fs.chmodSync(path.join(output,'data.json'),0o600);
    return {...result,dataFile:path.join(output,'data.json'),healthFile:path.join(output,'fee-data-health.json'),reportKind:plan.kind,accountingThrough:plan.accountingThrough,priceThrough:plan.priceThrough,reconstructedDays:dates.length};
  }catch(error){
    for(const name of ['data.json','fee-data-health.json'])try{fs.unlinkSync(path.join(output,name));}catch{}
    throw error;
  }finally{
    let cleanupFailed=false;
    try{revisionRuntime?.close();}catch{cleanupFailed=true;}
    try{fs.rmSync(runtime,{recursive:true,force:true});}catch{cleanupFailed=true;}
    try{economic?.cleanup();}catch{cleanupFailed=true;}
    if(cleanupFailed){
      for(const name of ['data.json','fee-data-health.json'])try{fs.unlinkSync(path.join(output,name));}catch{}
      setStage('CLEANUP');fail('CLEANUP');
    }
  }
}
function cliArgs(argv){
  const out={};for(const arg of argv){const m=/^--([a-z-]+)=([\s\S]+)$/.exec(arg);if(!m||out[m[1]]!==undefined)fail('ARGUMENT');out[m[1]]=m[2];}
  if(Object.keys(out).some(k=>!['mode','report-kind','report-target','report-markets','report-plan','benchmark-file','out-dir','main-sha','manual-sync-completed-for','confirmed-main','recovery-main'].includes(k)))fail('ARGUMENT');
  if(out['report-markets']&&(out.mode!=='preflight'||out['report-kind']!=='daily'||!out['report-target']))fail('ARGUMENT');
  if((out['report-kind']===undefined)!==(out['report-target']===undefined))fail('ARGUMENT');return out;
}
export function reviewedSyncConfirmation(args,{env=process.env,readEvent}={}){
  const value=args['manual-sync-completed-for'];if(value===undefined)return null;
  try{
    if(!['preflight','produce'].includes(args.mode)||args['report-kind']!=='daily'||reportDate(value)!==args['report-target']
        ||env.GITHUB_ACTIONS!=='true'||env.GITHUB_EVENT_NAME!=='workflow_dispatch'||env.GITHUB_RUN_ATTEMPT!=='1'||env.GITHUB_REF!=='refs/heads/main')throw Error();
    const event=readEvent?readEvent():(()=>{const p=env.GITHUB_EVENT_PATH;if(!p||fs.statSync(p).size>256*1024)throw Error();return JSON.parse(fs.readFileSync(p,'utf8'));})();
    const i=event?.inputs,off=v=>v===undefined||v===false||v==='false';
    if(!i||![true,'true'].includes(i.run_reviewed_once)||i.report_kind!=='daily'||i.report_target!==value
        ||i.manual_sync_completed_for!==value||!off(i.source_plan_check_only)||!off(i.source_acceptance_once))throw Error();
    return value;
  }catch{fail('MANUAL_SYNC_CONFIRMATION');}
}
export function reviewedRecoveryConfirmation(args,{env=process.env,readEvent}={}){
  const value=args['recovery-main'];if(value===undefined)return null;
  try{
    const scopes=RECOVERY_SCOPES.filter(s=>s.target===args['report-target']);
    if(!scopes.length||!/^[a-f0-9]{40}$/.test(value)||scopes.some(s=>value===s.baseSha||value===s.repairBase)||reviewedSyncConfirmation(args,{env,readEvent})!==args['report-target']
        ||env.GITHUB_SHA!==value||env.GITHUB_REPOSITORY!=='huanwujoy-crypto/fee-console'
        ||env.GITHUB_ACTOR_ID!==String(RECOVERY_OWNER)||!/^[1-9]\d{0,15}$/.test(env.GITHUB_RUN_ID||''))throw Error();
    const event=readEvent?readEvent():(()=>{const p=env.GITHUB_EVENT_PATH;if(!p||fs.statSync(p).size>256*1024)throw Error();return JSON.parse(fs.readFileSync(p,'utf8'));})();
    if(event.inputs.recovery_main!==value||event.sender?.id!==RECOVERY_OWNER||event.repository?.full_name!=='huanwujoy-crypto/fee-console')throw Error();
    return value;
  }catch{fail('RECOVERY_CONFIRMATION');}
}
// The period gate can wait in a queue. Reprove its exact release and admission
// before WIF, secret access or the benchmark's first financial source request.
export async function confirmReviewedRecoveryBeforeSource(args,{env=process.env,readEvent,checkedOutMain,authorize=authorizeReportRecovery}={}){
  const main=reviewedRecoveryConfirmation(args,{env,readEvent});if(main===null)return null;
  if(checkedOutMain!==main||env.PLANNED_MAIN!==main)fail('RECOVERY_RELEASE');
  let plan;try{plan=JSON.parse(env.REPORT_PLAN||'null');}catch{fail('RECOVERY_SCOPE');}
  if(!validateReportPlan(plan)||!isReviewedDailyPlan(plan)||plan.accountingThrough!==args['report-target'])fail('RECOVERY_SCOPE');
  return authorize({plan,expectedMain:main,currentRunId:env.GITHUB_RUN_ID});
}
// This binds a caller-reviewed request to the real Actions head. Parameters and
// event metadata do not establish human consent; the existing caller owns it.
export function reviewedMainConfirmation(args,{env=process.env,readEvent}={}){
  const value=args['confirmed-main'];
  if(value===undefined&&env.GITHUB_EVENT_NAME!=='workflow_dispatch')return null;
  try{
    const event=readEvent?readEvent():(()=>{const p=env.GITHUB_EVENT_PATH;if(!p||fs.statSync(p).size>256*1024)throw Error();return JSON.parse(fs.readFileSync(p,'utf8'));})();
    const i=event?.inputs,off=v=>v===undefined||v===false||v==='false',blank=v=>v===undefined||v==='';
    if(value===undefined&&blank(i?.confirmed_main))return null;
    const bools=['ib_envelope_once','ib_diagnostic_once','source_plan_check_only','source_acceptance_once'];
    const strings=['ib_envelope_main','ib_diagnostic_main','report_markets','recovery_main','ratio_main','ratio_plan','source_from','source_target','source_main'];
    if(typeof value!=='string'||!ONCE_SHA.test(value)||env.GITHUB_SHA!==value
        ||env.GITHUB_ACTIONS!=='true'||env.GITHUB_EVENT_NAME!=='workflow_dispatch'||env.GITHUB_REF!=='refs/heads/main'
        ||env.GITHUB_REPOSITORY!==ONCE_REPO||env.GITHUB_ACTOR_ID!==String(RECOVERY_OWNER)||env.GITHUB_RUN_ATTEMPT!=='1'
        ||!Number.isSafeInteger(Number(env.GITHUB_RUN_ID))||Number(env.GITHUB_RUN_ID)<=0||!/^\d+$/.test(env.GITHUB_RUN_ID||'')
        ||env.FEE_REPORT_ONCE_MAIN||env.FEE_AUTOMATIC_DAILY_REQUEST==='true'||!['preflight','produce'].includes(args.mode)
        ||args['report-kind']!=='daily'||args['report-markets']!==undefined||args['recovery-main']!==undefined
        ||reportDate(args['report-target'])!==args['manual-sync-completed-for']
        ||!i||Array.isArray(i)||event.sender?.id!==RECOVERY_OWNER||event.repository?.full_name!==ONCE_REPO
        ||Object.keys(i).some(k=>!['run_reviewed_once','report_kind','report_target','manual_sync_completed_for','confirmed_main',...bools,...strings].includes(k))
        ||![true,'true'].includes(i.run_reviewed_once)||i.report_kind!=='daily'||i.report_target!==args['report-target']
        ||i.manual_sync_completed_for!==args['report-target']||i.confirmed_main!==value
        ||!bools.every(k=>off(i[k]))||!strings.every(k=>blank(i[k]))
        ||args.mode==='produce'&&env.PLANNED_MAIN!==value)throw Error();
    return value;
  }catch{fail('CONFIRMED_MAIN_SCOPE');}
}
export async function confirmReviewedMainBeforeSource(args,{env=process.env,readEvent,checkedOutMain,fetchImpl=globalThis.fetch,readCurrentRun=readCurrentSyncRun,readState,now=new Date()}={}){
  const value=reviewedMainConfirmation(args,{env,readEvent});
  if(value===null)return null;
  if(args.mode!=='produce'||checkedOutMain!==undefined&&checkedOutMain!==value)fail('CONFIRMED_MAIN_CHANGED');
  let ref;
  try{ref=await boundedJson(fetchImpl,'https://api.github.com/repos/'+ONCE_REPO+'/git/ref/heads/main',
    {method:'GET',headers:{Accept:'application/vnd.github+json'}},{timeoutMs:5000,maxBytes:64*1024});}
  catch{fail('CONFIRMED_MAIN_METADATA');}
  if(ref?.ref!=='refs/heads/main'||ref.object?.type!=='commit'||ref.object?.sha!==value)fail('CONFIRMED_MAIN_CHANGED');
  let plan;try{plan=JSON.parse(env.REPORT_PLAN||args['report-plan']);}catch{fail('PLAN');}
  if(plan?.accountingThrough!==args['report-target'])fail('PLAN');
  currentSyncRunBinding(await readCurrentRun({currentRunId:env.GITHUB_RUN_ID,actionsToken:env.FEE_REPORT_ACTIONS_TOKEN,fetchImpl}),{currentRunId:env.GITHUB_RUN_ID,expectedMain:value,now});
  readState||=((target,start)=>readPublicationState(target,start,undefined,{requireIb:true,strictCandidates:true}));
  syncPublicationBinding(await readState(plan.accountingThrough,now.toISOString()),{plan,expectedMain:value,now});
  return value;
}
async function main(){
  const args=cliArgs(process.argv.slice(2));let plan=null;
  if(args.mode?.startsWith('once-')){
    if(Object.keys(args).join(',')!=='mode')onceFail();
    const result=await cloudOnceControl(args.mode);
    if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,`state=${result.state}\ncandidate=${result.candidate||''}\n`);
    console.log(JSON.stringify(result));return;
  }
  if(args['report-plan']){try{plan=JSON.parse(args['report-plan']);}catch{fail('PLAN');}if(!validateReportPlan(plan)||args['report-target']!==plan.accountingThrough||args['report-kind']!==(plan.kind.startsWith('daily')?'daily':plan.kind==='monthly'?'monthly':'weekly'))fail('PLAN');}
  else if(args['report-target']&&args['report-kind']!=='daily')plan=explicitReportPlan(args['report-kind'],args['report-target']);
  const reviewedSyncDate=reviewedSyncConfirmation(args);
  const confirmedMain=reviewedMainConfirmation(args);
  const recoveryMain=reviewedRecoveryConfirmation(args);
  if(plan&&isReviewedDailyPlan(plan)&&reviewedSyncDate!==plan.accountingThrough)fail('MANUAL_SYNC_CONFIRMATION');
  if(args.mode==='watch'){
    if(Object.keys(args).sort().join(',')!=='main-sha,mode')fail('ARGUMENT');
    const data=fs.readFileSync(path.join(ROOT,'data.json')),bytes=fs.readFileSync(path.join(ROOT,'fee-data-health.json'));
    const result=await reportPublicationWatch({mainSha:args['main-sha'],health:JSON.parse(bytes),data,daily:true});
    if(!fs.readFileSync(path.join(ROOT,'data.json')).equals(data)||!fs.readFileSync(path.join(ROOT,'fee-data-health.json')).equals(bytes))fail('PUBLICATION_READ');
    console.log(JSON.stringify(result));return;
  }
  if(args['main-sha'])fail('ARGUMENT');
  const scheduledDaily=scheduledDailyContext(args);
  if(args.mode==='preflight'){
    if(args['out-dir']||args['benchmark-file']||args['report-plan'])fail('ARGUMENT');
    const result=await(!args['report-kind']||args['report-kind']==='daily'?dailyPublicationPreflight({targetDate:args['report-target']||null,reviewedSyncDate,confirmedMain,recoveryMain,scheduledDaily,...(args['report-markets']?{markets:args['report-markets'].split(',')}:{} )}):reportPublicationPreflight({plan}));
    if(scheduledDaily&&result.outcome==='produce'&&result.mainSha!==process.env.GITHUB_SHA)fail('DAILY_SCOPE');
    console.log(JSON.stringify(result));return;
  }
  if(args.mode!=='produce'||!plan)fail('ARGUMENT');
  if(confirmedMain!==null)await confirmReviewedMainBeforeSource(args);
  // Recheck admission before economic/source IO, including the same-run owner,
  // signed release, prior failures and absence of any earlier recovery admission.
  const recoveryAdmission=recoveryMain!==null?await authorizeReportRecovery({plan,expectedMain:recoveryMain}):null;
  const result=await produceReportPeriod({plan,reviewedSyncDate,outputDir:args['out-dir'],benchmarkFile:args['benchmark-file'],requireIb:true,
    ...(isHistoricalRevisionAdmission(recoveryAdmission)?{historicalRevisionAdmission:recoveryAdmission}:{})});
  console.log(JSON.stringify({schema:'fee-console.cloud-producer.v1',targetDate:result.targetDate,outcome:result.outcome,retryCount:result.retryCount,sourceDates:result.sourceDates,dataSha256:result.dataSha256,reportKind:result.reportKind,priceThrough:result.priceThrough,accountingThrough:result.accountingThrough,reconstructedDays:result.reconstructedDays,...(result.ibManager?{ibManager:result.ibManager}:{})}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(reportFailureCode(error));process.exitCode=1;});
