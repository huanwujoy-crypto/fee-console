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
import {fetchEconomicSnapshot,SourceFetchError} from './fee-economic-source.mjs';
import {incomeDateEvidenceFromData} from './fee-income-date-policy.mjs';
import {canonicalJson} from './fee-receipt-core.mjs';
import {validateHealth} from './fee-data-health.mjs';
import {boundedJson} from './fee-http-json.mjs';
import {createFundInvestorCore} from './fund-investor-core.mjs';
import {validateManagedTransferIdentities} from './fee-sharesight-transfers.mjs';
import {reportDate,reportAddDays,selectReportBenchmark,weeklyReportPlan,monthlyReportPlan,coalesceReportPlans,validateReportPlan,reportPlanReadiness,reportPlansAround,reportWindowDates,dailyReportPlan,isReviewedDailyPlan} from './fee-report-period.mjs';
import {sessionUnion} from './fee-market-calendar.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fail=code=>{throw Error('FEE_REPORT_'+code);};
const hash=v=>crypto.createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:canonicalJson(v)).digest('hex');
const freshTarget=(plan,now)=>{const age=Math.floor((Date.parse(now.toISOString().slice(0,10)+'T00:00:00Z')-Date.parse(plan.accountingThrough+'T00:00:00Z'))/86400000);return age>=0&&age<=4;};
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
// Rebind the same unconsumed admission after the one-gift repair. This is not a
// fourth historical source attempt or another recovery allocation.
const RECOVERY_REPAIR_BASE='451efca392e474f434b7ac7891eb6f5570cf7108';
const RECOVERY_REPAIR_FILES=Object.freeze(['scripts/fee-sharesight-transfers.mjs','scripts/fee-source-acceptance.test.mjs','scripts/fee-report-producer.mjs','scripts/fee-report-producer.test.mjs']);
const RECOVERY_TARGET='2026-10-28';
const RECOVERY_FAILED_RUNS=Object.freeze([
  {id:40803101364,head:'fbb79a694acb232fbdb522939d98a933da03b1f2'},
  {id:40805169117,head:'fbb79a694acb232fbdb522939d98a933da03b1f2'},
  {id:40815850578,head:RECOVERY_BASE},
]);
// Filled from the final index-only candidate bytes before this package freezes.
const RECOVERY_UI_BLOB='1f1218943293e035bbfe07fa56e9b74341c22177';
const RECOVERY_OWNER=283054367;
export async function readPeriodSourceAttempts({plan,now,currentRunId=null,recoveryMain=null,fetchImpl=globalThis.fetch}={}){
  if(!validateReportPlan(plan)||!Number.isFinite(now?.getTime()))fail('SOURCE_ATTEMPT_METADATA');
  if(recoveryMain!==null&&!/^[a-f0-9]{40}$/.test(recoveryMain))fail('RECOVERY_METADATA');
  const root='https://api.github.com/repos/huanwujoy-crypto/fee-console/actions',from=new Date(sourceAttemptWindowStart(plan)).toISOString();
  const query=new URLSearchParams({branch:'main',created:from+'..'+now.toISOString(),per_page:'100'});
  const get=url=>boundedJson(fetchImpl,url,{method:'GET',headers:{Accept:'application/vnd.github+json'}},{timeoutMs:5000,maxBytes:512*1024});
  const listing=await get(root+'/workflows/fee-cloud-producer.yml/runs?'+query),seen=new Set(),jobsSeen=new Set();
  if(!Number.isSafeInteger(listing.total_count)||!Array.isArray(listing.workflow_runs)||listing.total_count!==listing.workflow_runs.length||listing.total_count>32)fail('SOURCE_ATTEMPT_METADATA');
  const runs=listing.workflow_runs;
  for(const r of runs){
    if(!Number.isSafeInteger(r.id)||r.id<=0||seen.has(r.id)||r.head_branch!=='main'||r.path!=='.github/workflows/fee-cloud-producer.yml'||!/^[a-f0-9]{40}$/.test(r.head_sha||'')||!['schedule','workflow_dispatch'].includes(r.event)||!Number.isFinite(Date.parse(r.created_at))||Date.parse(r.created_at)<Date.parse(from)||Date.parse(r.created_at)>now.getTime())fail('SOURCE_ATTEMPT_METADATA');
    seen.add(r.id);
  }
  const expected='Produce '+(plan.kind.startsWith('daily')?'daily':plan.kind==='monthly'?'monthly':'weekly')+' '+plan.accountingThrough;
  let attempts=0,inProgress=false;
  const evidence=recoveryMain===null?null:{currentRun:null,entries:[],reservations:[],otherSourceActive:false};
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
      if(j.conclusion==='skipped'){if(j.status!=='completed')fail('SOURCE_ATTEMPT_METADATA');continue;}
      if(evidence&&j.started_at!==null&&(!Number.isFinite(Date.parse(j.started_at))||Date.parse(j.started_at)<Date.parse(r.created_at)||Date.parse(j.started_at)>now.getTime()+300000))fail('RECOVERY_METADATA');
      // Reserve on admission, including cancellation before financial entry.
      if(evidence&&j.name==='period'&&[recoveryMain,RECOVERY_REPAIR_BASE].includes(r.head_sha))evidence.reservations.push(r.id);
      if(['period','watch','source-plan-check'].includes(j.name))continue;
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
  return {attempts,inProgress,...(evidence?{recoveryEvidence:evidence}:{})};
}
export async function readReportRecoveryRelease(expectedMain,{fetchImpl=globalThis.fetch}={}){
  if(!/^[a-f0-9]{40}$/.test(expectedMain||''))fail('RECOVERY_RELEASE');
  const root='https://api.github.com/repos/huanwujoy-crypto/fee-console/';
  const get=p=>boundedJson(fetchImpl,root+p,{method:'GET',headers:{Accept:'application/vnd.github+json'}},{timeoutMs:5000,maxBytes:512*1024});
  let ref,commit;try{[ref,commit]=await Promise.all([get('git/ref/heads/main'),get('commits/'+expectedMain+'?per_page=1')]);}catch{fail('RECOVERY_METADATA');}
  const signed=c=>c.author?.id===RECOVERY_OWNER&&c.author?.login==='huanwujoy-crypto'
    &&['huanwujoy-crypto','web-flow'].includes(c.committer?.login)
    &&c.commit?.verification?.verified===true&&c.commit.verification.reason==='valid';
  if(ref.object?.sha!==expectedMain||commit.sha!==expectedMain||commit.parents?.length!==1
      ||commit.parents[0].sha!==RECOVERY_REPAIR_BASE||!signed(commit)||!/^[a-f0-9]{40}$/.test(commit.commit?.tree?.sha||''))fail('RECOVERY_RELEASE');
  let base,comparison,tree;
  try{[base,comparison,tree]=await Promise.all([get('commits/'+RECOVERY_REPAIR_BASE+'?per_page=1'),get('compare/'+RECOVERY_REPAIR_BASE+'...'+expectedMain+'?per_page=100'),get('git/trees/'+commit.commit.tree.sha)]);}catch{fail('RECOVERY_METADATA');}
  // No new UI version: the already deployed reviewed blob must remain exact.
  // Only the four reviewed repair/test files may differ from the protected UI.
  const files=comparison.files,indices=Array.isArray(tree.tree)?tree.tree.filter(f=>f.path==='index.html'):[];
  if(base.sha!==RECOVERY_REPAIR_BASE||base.parents?.length!==1||!signed(base)
    ||comparison.status!=='ahead'||comparison.ahead_by!==1||comparison.behind_by!==0||comparison.total_commits!==1
    ||comparison.base_commit?.sha!==RECOVERY_REPAIR_BASE||comparison.merge_base_commit?.sha!==RECOVERY_REPAIR_BASE
    ||comparison.commits?.length!==1||comparison.commits[0].sha!==expectedMain
    ||!Array.isArray(files)||files.length!==RECOVERY_REPAIR_FILES.length||new Set(files.map(f=>f.filename)).size!==files.length
    ||files.some(f=>!RECOVERY_REPAIR_FILES.includes(f.filename)||f.status!=='modified'||f.previous_filename!==undefined||!/^[a-f0-9]{40}$/.test(f.sha||''))
    ||tree.sha!==commit.commit.tree.sha||tree.truncated!==false||indices.length!==1||indices[0].mode!=='100644'||indices[0].type!=='blob'||indices[0].sha!==RECOVERY_UI_BLOB)fail('RECOVERY_RELEASE');
  return {mainSha:expectedMain,parent:RECOVERY_REPAIR_BASE,baseSha:RECOVERY_BASE,repairBaseSha:RECOVERY_REPAIR_BASE,uiBlob:RECOVERY_UI_BLOB,signatureVerified:true};
}
export function validateReportRecoveryEvidence({plan,expectedMain,currentRunId,budget,release}={}){
  const e=budget?.recoveryEvidence,c=e?.currentRun;
  if(!validateReportPlan(plan)||!isReviewedDailyPlan(plan)||plan.accountingThrough!==RECOVERY_TARGET||plan.kind!=='daily'||plan.markets.join(',')!=='NASDAQ,NYSE'
      ||!/^[a-f0-9]{40}$/.test(expectedMain||'')||expectedMain===RECOVERY_BASE||release?.mainSha!==expectedMain||release.baseSha!==RECOVERY_BASE
      ||release.repairBaseSha!==RECOVERY_REPAIR_BASE||release.parent!==RECOVERY_REPAIR_BASE||expectedMain===RECOVERY_REPAIR_BASE||release.uiBlob!==RECOVERY_UI_BLOB||release.signatureVerified!==true)fail('RECOVERY_SCOPE');
  if(!Number.isSafeInteger(Number(currentRunId))||Number(currentRunId)<=0||c?.id!==Number(currentRunId)||c.head!==expectedMain||c.attempt!==1||c.event!=='workflow_dispatch'||c.workflowId!==365873934||c.actorId!==RECOVERY_OWNER||c.status!=='in_progress'||c.conclusion!==null)fail('RECOVERY_RUN');
  if(budget.attempts!==3||budget.inProgress!==false||!Array.isArray(e.entries)||e.entries.length!==3||!Array.isArray(e.reservations)||e.reservations.length||e.otherSourceActive!==false)fail('RECOVERY_CONSUMED');
  if(e.entries.some(x=>!RECOVERY_FAILED_RUNS.some(r=>r.id===x.runId&&r.head===x.head)||!Number.isSafeInteger(x.jobId)||x.jobId<=0||x.attempt!==1||x.event!=='workflow_dispatch'||x.runStatus!=='completed'||x.runConclusion!=='failure'||x.name!=='Produce daily '+RECOVERY_TARGET||x.status!=='completed'||x.conclusion!=='failure')
      ||new Set(e.entries.map(x=>x.runId)).size!==3||new Set(e.entries.map(x=>x.jobId)).size!==3)fail('RECOVERY_PRIOR_RUNS');
  return true;
}
export async function authorizeReportRecovery({plan,expectedMain,now=new Date(),currentRunId=process.env.GITHUB_RUN_ID,readSourceAttempts=readPeriodSourceAttempts,readRecoveryRelease=readReportRecoveryRelease}={}){
  let budget,release;try{[budget,release]=await Promise.all([readSourceAttempts({plan,now,currentRunId,recoveryMain:expectedMain}),readRecoveryRelease(expectedMain)]);}catch(error){
    if(['FEE_REPORT_RECOVERY_RELEASE','FEE_REPORT_RECOVERY_METADATA','FEE_REPORT_SOURCE_ATTEMPT_METADATA'].includes(error?.message))throw error;
    fail('RECOVERY_METADATA');
  }
  validateReportRecoveryEvidence({plan,expectedMain,currentRunId,budget,release});
}
export async function reportPublicationPreflight({now=new Date(),plan=null,reviewedSyncDate=null,recoveryMain=null,ibEnabled=process.env.IB_MANAGER_READ_ENABLED==='true',currentRunId=process.env.GITHUB_RUN_ID,runAttempt=process.env.GITHUB_RUN_ATTEMPT,readRetryRuns=readPeriodRetryRuns,readSourceAttempts=readPeriodSourceAttempts,readRecoveryRelease=readReportRecoveryRelease,readState}={}){
  readState||=((target,start)=>readPublicationState(target,start,undefined,{requireIb:ibEnabled}));
  const plans=plan?[plan]:reportPlansAround(now);
  if(!plans.length)return {schema:'fee-console.report-preflight.v1',outcome:'not-due',plan:null};
  if(plans.some(p=>!validateReportPlan(p)))fail('PLAN');
  if(recoveryMain!==null&&(!plan||!isReviewedDailyPlan(plan)||plan.accountingThrough!==RECOVERY_TARGET))fail('RECOVERY_SCOPE');
  if(plans.some(p=>isReviewedDailyPlan(p)&&reviewedSyncDate!==p.accountingThrough)
      ||reviewedSyncDate!==null&&(!plan||!isReviewedDailyPlan(plan)||reviewedSyncDate!==plan.accountingThrough))fail('MANUAL_SYNC_CONFIRMATION');
  const latest=plans.at(-1),startedAt=now.toISOString();
  let state=await readState(latest.accountingThrough,startedAt);
  if(state.mainSha!==state.finalMainSha||validateHealth(state.health,{now:new Date(state.health?.checkedAt)}).length||Date.parse(state.health?.checkedAt)>now.getTime()+300000||state.health?.dataSha256!==hash(state.data))fail('PUBLICATION_READ');
  if(plan&&state.health.targetDate>plan.accountingThrough)fail('HISTORY_AHEAD_OF_TARGET');
  const pending=plans.filter(p=>p.accountingThrough>=state.health.targetDate&&!publishedReportMatches(state,p,now));
  if(!pending.length){
    const covered={schema:'fee-console.report-preflight.v1',outcome:'already-published',plan:latest,mainSha:state.mainSha};
    if(recoveryMain!==null)return covered;
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
  if(state.mainSha!==state.finalMainSha||validateHealth(state.health,{now:new Date(state.health?.checkedAt)}).length||state.health?.dataSha256!==hash(state.data)||state.health.targetDate>next.accountingThrough)fail('PUBLICATION_READ');
  if(publishedReportMatches(state,next,now))return {schema:'fee-console.report-preflight.v1',outcome:'already-published',plan:next,mainSha:state.mainSha};
  if(state.pending)return {schema:'fee-console.report-preflight.v1',outcome:'candidate-pending',plan:next,mainSha:state.mainSha};
  // Old workflow reruns can retain a creation date before this period. They
  // cannot be used to evade its metadata budget or replay one-time execution.
  if(runAttempt!==undefined&&String(runAttempt)!=='1')return {schema:'fee-console.report-preflight.v1',outcome:'waiting',reasonCode:'REPORT_SOURCE_RERUN_NOT_ALLOWED',plan:next,mainSha:state.mainSha};
  if(recoveryMain!==null){
    if(state.mainSha!==recoveryMain)fail('RECOVERY_RELEASE');
    await authorizeReportRecovery({plan:next,expectedMain:recoveryMain,now,currentRunId,readSourceAttempts,readRecoveryRelease});
    return {schema:'fee-console.report-preflight.v1',outcome:'produce',plan:next,mainSha:state.mainSha};
  }
  try{
    const budget=await readSourceAttempts({plan:next,now,currentRunId});
    if(!budget||!Number.isSafeInteger(budget.attempts)||budget.attempts<0||typeof budget.inProgress!=='boolean')throw Error();
    if(budget.inProgress||budget.attempts>=2)return {schema:'fee-console.report-preflight.v1',outcome:'waiting',reasonCode:budget.inProgress?'REPORT_SOURCE_RUN_IN_PROGRESS':'REPORT_SOURCE_ATTEMPT_BUDGET_EXHAUSTED',plan:next,mainSha:state.mainSha};
  }catch{return {schema:'fee-console.report-preflight.v1',outcome:'waiting',reasonCode:'REPORT_SOURCE_ATTEMPT_METADATA_UNVERIFIED',plan:next,mainSha:state.mainSha};}
  return {schema:'fee-console.report-preflight.v1',outcome:'produce',plan:next,mainSha:state.mainSha};
}
export async function dailyPublicationPreflight({now=new Date(),targetDate=null,reviewedSyncDate=null,markets=String(process.env.FEE_REPORT_MARKETS||'').split(',').filter(Boolean),readState,...options}={}){
  const localDate=(zone)=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const target=targetDate||reportAddDays(localDate('Asia/Hong_Kong'),-1),base={schema:'fee-console.report-preflight.v1',plan:null};reportDate(target);
  if(reviewedSyncDate!==null&&(!targetDate||reportDate(reviewedSyncDate)!==target))fail('MANUAL_SYNC_CONFIRMATION');
  let sessions;try{sessions=sessionUnion(target,markets);}catch{return {...base,outcome:'waiting',reasonCode:'CALENDAR_SCOPE_UNVERIFIED'};}
  if(sessions.rows.some(row=>row.state==='unknown'))return {...base,outcome:'waiting',reasonCode:'CALENDAR_SCOPE_UNVERIFIED'};
  if(sessions.state==='closed')return {...base,outcome:'not-due',reasonCode:'ALL_RELEVANT_MARKETS_CLOSED'};
  const initial=dailyReportPlan(target,markets,{reviewedSyncDate}),readiness=reportPlanReadiness(initial,now);
  if(reviewedSyncDate!==null&&readiness.state!=='due'||reviewedSyncDate===null&&now.getTime()<Date.parse(initial.scheduledAt))return {...base,outcome:'waiting',reasonCode:readiness.reasonCode};
  readState||=((target,start)=>readPublicationState(target,start,undefined,{requireIb:options.ibEnabled??process.env.IB_MANAGER_READ_ENABLED==='true'}));
  const state=await readState(target,now.toISOString());
  if(!state.health||state.health.targetDate>target)fail('HISTORY_AHEAD_OF_TARGET');
  let plan;try{plan=dailyReportPlan(target,markets,{periodFrom:state.health.targetDate===target?target:reportAddDays(state.health.targetDate,1),reviewedSyncDate});}catch{return {...base,outcome:'recovery-required',reasonCode:'REPORT_SOURCE_RANGE_UNVERIFIED'};}
  return reportPublicationPreflight({...options,now,plan,reviewedSyncDate,readState:async()=>state});
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
async function produceReportPeriodRun({plan,reviewedSyncDate=null,outputDir,benchmarkFile,now=new Date(),readOnce,ibReader,fetchEconomic=fetchEconomicSnapshot,sourceFile=path.join(ROOT,'data.json')},setStage){
  if(process.env.GITHUB_RUN_ATTEMPT!==undefined&&process.env.GITHUB_RUN_ATTEMPT!=='1')fail('SOURCE_RERUN_NOT_ALLOWED');
  if(!validateReportPlan(plan)||reportPlanReadiness(plan,now).state!=='due')fail('NOT_READY');
  if(isReviewedDailyPlan(plan)?reviewedSyncDate!==plan.accountingThrough:reviewedSyncDate!==null)fail('MANUAL_SYNC_CONFIRMATION');
  if(!freshTarget(plan,now))fail('RECOVERY_REQUIRED');
  const output=outputDirectory(outputDir),originalBytes=fs.readFileSync(sourceFile),payload=decryptCandidate(sourceFile,process.env.FEE_DATA_KEY);
  const latest=payload.daily?.map(p=>p.d).sort().at(-1),dates=reportWindowDates(latest,plan.accountingThrough);
  setStage('BENCHMARK');
  const cache=JSON.parse(fs.readFileSync(benchmarkFile));
  dates.forEach(date=>periodBenchmark(cache,date));
  if(periodBenchmark(cache,plan.accountingThrough).sourceDate!==plan.priceThrough)fail('BENCHMARK');
  let economic;const runtime=path.join(output,'period-private');
  setStage('PREPARE');
  if(fs.existsSync(runtime)||['data.json','fee-data-health.json'].some(f=>fs.existsSync(path.join(output,f))))fail('OUTPUT_EXISTS');
  fs.mkdirSync(runtime,{mode:0o700});
  try{
    // Freeze one private economic revision for the entire range. No intermediate
    // candidate can escape. Recheck again after all daily receipts are proved.
    setStage('ECONOMIC_READ');
    economic=await fetchEconomic();if(economic.envelopeVersion!==4)fail('ECON_VERSION');
    setStage('READER_SETUP');
    const transferInputs=new Map(dates.map(date=>[date,managedTransferIdentitiesFromFund(economic,process.env.FEE_DATA_KEY,date)]));
    const needsFund=Array.from(transferInputs.values()).some(Boolean);
    setStage('SOURCE_READ');
    const reads=await captureReportRange({dates,cache,readOnce:readOnce||(async date=>new SharesightCloudReader({clientId:process.env.FEE_CLOUD_SHARESIGHT_CLIENT_ID,clientSecret:process.env.FEE_CLOUD_SHARESIGHT_CLIENT_SECRET,incomeDateEvidence:incomeDateEvidenceFromData(payload,date),reconcileInKind:true,managedTransferIdentities:transferInputs.get(date),managementExemptionRegistry:payload.managementExemptionRegistry}).readOnce(date))});
    let base=sourceFile,result;
    for(let i=0;i<reads.length;i++){
      setStage('PREPARE');
      const input=reads[i],final=i===reads.length-1,dayDir=path.join(runtime,input.targetDate);fs.mkdirSync(dayDir,{mode:0o700});
      setStage('WRITER');
      result=await produce({cli:{'benchmark-file':benchmarkFile,'target-date':input.targetDate,'checked-at':now.toISOString(),'out-dir':dayDir},periodMode:true,baseDataFile:base===sourceFile?undefined:base,
        // The root source is fixed; a caller-provided synthetic source is
        // accepted only by the test/library entry, never the CLI/workflow.
        ...(base===sourceFile&&sourceFile!==path.join(ROOT,'data.json')?{baseDataFile:base}:{}),
        reader:{async readStable(target){if(target!==input.targetDate)fail('RANGE');return structuredClone(input);}},
        fetchEconomic:async()=>({...economic,cleanup(){}}),includeIb:final,ibReader,...(final?{reportPlan:plan}:{})});
      base=result.dataFile;
    }
    setStage('ECONOMIC_RECHECK');
    await economic.checkCurrent(needsFund?{requireFundProfile:true}:{});
    if(!fs.readFileSync(sourceFile).equals(originalBytes))fail('BASE_CHANGED');
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
    try{fs.rmSync(runtime,{recursive:true,force:true});}catch(error){setStage('CLEANUP');throw error;}
    try{economic?.cleanup();}catch{for(const name of ['data.json','fee-data-health.json'])try{fs.unlinkSync(path.join(output,name));}catch{}fail('CLEANUP');}
  }
}
function cliArgs(argv){
  const out={};for(const arg of argv){const m=/^--([a-z-]+)=([\s\S]+)$/.exec(arg);if(!m||out[m[1]]!==undefined)fail('ARGUMENT');out[m[1]]=m[2];}
  if(Object.keys(out).some(k=>!['mode','report-kind','report-target','report-markets','report-plan','benchmark-file','out-dir','main-sha','manual-sync-completed-for','recovery-main'].includes(k)))fail('ARGUMENT');
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
    if(!/^[a-f0-9]{40}$/.test(value)||value===RECOVERY_BASE||reviewedSyncConfirmation(args,{env,readEvent})!==RECOVERY_TARGET
        ||args['report-target']!==RECOVERY_TARGET||env.GITHUB_SHA!==value||env.GITHUB_REPOSITORY!=='huanwujoy-crypto/fee-console'
        ||env.GITHUB_ACTOR_ID!==String(RECOVERY_OWNER)||!/^[1-9]\d{0,15}$/.test(env.GITHUB_RUN_ID||''))throw Error();
    const event=readEvent?readEvent():(()=>{const p=env.GITHUB_EVENT_PATH;if(!p||fs.statSync(p).size>256*1024)throw Error();return JSON.parse(fs.readFileSync(p,'utf8'));})();
    if(event.inputs.recovery_main!==value||event.sender?.id!==RECOVERY_OWNER||event.repository?.full_name!=='huanwujoy-crypto/fee-console')throw Error();
    return value;
  }catch{fail('RECOVERY_CONFIRMATION');}
}
async function main(){
  const args=cliArgs(process.argv.slice(2));let plan=null;
  if(args['report-plan']){try{plan=JSON.parse(args['report-plan']);}catch{fail('PLAN');}if(!validateReportPlan(plan)||args['report-target']!==plan.accountingThrough||args['report-kind']!==(plan.kind.startsWith('daily')?'daily':plan.kind==='monthly'?'monthly':'weekly'))fail('PLAN');}
  else if(args['report-target']&&args['report-kind']!=='daily')plan=explicitReportPlan(args['report-kind'],args['report-target']);
  const reviewedSyncDate=reviewedSyncConfirmation(args);
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
  if(args.mode==='preflight'){
    if(args['out-dir']||args['benchmark-file']||args['report-plan'])fail('ARGUMENT');
    console.log(JSON.stringify(await(!args['report-kind']||args['report-kind']==='daily'?dailyPublicationPreflight({targetDate:args['report-target']||null,reviewedSyncDate,recoveryMain,...(args['report-markets']?{markets:args['report-markets'].split(',')}:{} )}):reportPublicationPreflight({plan}))));return;
  }
  if(args.mode!=='produce'||!plan)fail('ARGUMENT');
  // Recheck admission before economic/source IO, including the same-run owner,
  // signed release, prior failures and absence of any earlier recovery admission.
  if(recoveryMain!==null)await authorizeReportRecovery({plan,expectedMain:recoveryMain});
  const result=await produceReportPeriod({plan,reviewedSyncDate,outputDir:args['out-dir'],benchmarkFile:args['benchmark-file']});
  console.log(JSON.stringify({schema:'fee-console.cloud-producer.v1',targetDate:result.targetDate,outcome:result.outcome,retryCount:result.retryCount,sourceDates:result.sourceDates,dataSha256:result.dataSha256,reportKind:result.reportKind,priceThrough:result.priceThrough,accountingThrough:result.accountingThrough,reconstructedDays:result.reconstructedDays,...(result.ibManager?{ibManager:result.ibManager}:{})}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(reportFailureCode(error));process.exitCode=1;});
