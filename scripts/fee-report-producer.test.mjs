import './fee-gift-registry-status.test.mjs';
import './fee-source-acceptance.test.mjs';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';
import {CLOUD_ACCOUNTS,parseSourceJson} from './fee-cloud-source.mjs';
import {reportPreflightSummary,dailyPublicationPreflight,managedTransferIdentitiesFromFund,periodBenchmark,captureReportRange,publishedReportMatches,reportPublicationPreflight as nativeReportPreflight,readPeriodSourceAttempts,reportPublicationWatch,explicitReportPlan,periodIbRetryAllowed,readPeriodRetryRuns,assertPeriodIbRecheckUnchanged,reviewedSyncConfirmation,sourceAttemptWindowStart,produceReportPeriod,reportFailureCode,reviewedRecoveryConfirmation,readReportRecoveryRelease,validateReportRecoveryEvidence,authorizeReportRecovery} from './fee-report-producer.mjs';
import {producerFailureCode,safeProducerFailureSummary,UNRESOLVED_FLOW_DIAGNOSTIC_PREFIX} from './fee-cloud-producer.mjs';
import {SourceFetchError} from './fee-economic-source.mjs';
import {dailyReportPlan,weeklyReportPlan,monthlyReportPlan,reportAddDays} from './fee-report-period.mjs';
import {HEALTH_SCHEMA,validateHealth} from './fee-data-health.mjs';
import {CLOUD_ONCE,cloudOnceWindow,cloudOnceRequest,admitCloudOnce,confirmCloudOnce,recordCloudOnceCandidate,cloudOnceStatus,pauseCloudOnce,cloudOnceControl,scheduledDailyContext} from './fee-report-producer.mjs';
import {reviewedMainConfirmation,confirmReviewedMainBeforeSource,confirmReviewedRecoveryBeforeSource,isHistoricalRevisionAdmission,readHistoricalRevisionAdmission,reportHistoricalRecoveryManifest,readCurrentSyncRun} from './fee-report-producer.mjs';
import {isHistoricalRevisionDiagnosticAdmission,readHistoricalRevisionDiagnosticAdmission,authorizeHistoricalRevisionDiagnostic} from './fee-report-producer.mjs';
import {authorizeEnvelopeEvidence,isEnvelopeEvidenceAdmission,recoveryMetadataDiagnostic,RECOVERY_METADATA_STAGES,RECOVERY_METADATA_REQUESTS,RECOVERY_METADATA_CATEGORIES} from './fee-report-producer.mjs';

function cloudOnceFixture(){
 const main='a'.repeat(40),candidate='b'.repeat(40),runId=1001,now=new Date('2026-11-03T02:00:10Z');
 const refs=new Map(),tags=new Map(),calls=[],workflows=new Map([[CLOUD_ONCE.producer,'active'],[CLOUD_ONCE.promotion,'active']]);
 const makeRun=id=>({id,workflow_id:CLOUD_ONCE.producer,head_sha:main,head_branch:'main',event:'schedule',run_attempt:1,path:'.github/workflows/fee-cloud-producer.yml',created_at:'2026-11-03T02:00:00Z',status:'in_progress',conclusion:null});
 const f={main,candidate,runId,now,refs,tags,calls,workflows,runs:new Map([[runId,makeRun(runId)],[1002,makeRun(1002)]]),currentMain:main,failDisable:new Set(),unknownRef:false,
  jobs:{total_count:1,jobs:[{id:2001,run_id:runId,head_sha:main,name:'Produce daily 2026-11-02',status:'completed',conclusion:'success'}]},
  commit:{sha:candidate,parents:[{sha:main}],author:{id:283054367},commit:{verification:{verified:true}},files:[{filename:'data.json',status:'modified'},{filename:'fee-data-health.json',status:'modified'}]},
  validation:{total_count:1,workflow_runs:[{id:3001,head_sha:candidate,head_branch:'codex/fee-daily-20261102-abcdef',path:'.github/workflows/validate-fee-data.yml',event:'push',run_attempt:1,status:'completed',conclusion:'success'}]}};
 f.request=async(method,route,body)=>{
  calls.push({method,route,...(body===undefined?{}:{body:structuredClone(body)})});
  if(method==='GET'&&route==='/git/ref/heads/main')return {object:{sha:f.currentMain}};
  if(method==='GET'&&route.startsWith('/git/ref/tags/'))return structuredClone(refs.get(route.slice('/git/ref/'.length))||null);
  if(method==='GET'&&route.startsWith('/git/tags/'))return structuredClone(tags.get(route.slice('/git/tags/'.length)));
  if(method==='GET'&&/\/actions\/runs\/\d+\/jobs\?/.test(route))return structuredClone(f.jobs);
  if(method==='GET'&&/^\/actions\/runs\/\d+$/.test(route))return structuredClone(f.runs.get(Number(route.split('/').at(-1))));
  if(method==='GET'&&route.startsWith('/commits/'))return structuredClone(f.commit);
  if(method==='GET'&&route.startsWith('/actions/workflows/validate-fee-data.yml/runs?'))return structuredClone(f.validation);
  if(method==='GET'&&/^\/actions\/workflows\/\d+$/.test(route)){const id=Number(route.split('/').at(-1));return {id,state:workflows.get(id)};}
  if(method==='POST'&&route==='/git/tags'){
   const sha=crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex');tags.set(sha,{...body,sha,object:{type:body.type,sha:body.object}});return {sha};
  }
  if(method==='POST'&&route==='/git/refs'){
   const key=body.ref.slice('refs/'.length);if(refs.has(key))throw Error('SYNTHETIC_CONFLICT');
   const ref={ref:body.ref,object:{type:tags.has(body.sha)?'tag':'commit',sha:body.sha}};refs.set(key,ref);
   if(f.unknownRef)throw Error('SYNTHETIC_LOST_RESPONSE');return structuredClone(ref);
  }
  if(method==='PUT'&&/^\/actions\/workflows\/\d+\/disable$/.test(route)){
   const id=Number(route.split('/').at(-2));if(f.failDisable.has(id))throw Error('SYNTHETIC_API_DOWN');workflows.set(id,'disabled_manually');return null;
  }
  assert.fail('unexpected synthetic control route');
 };
 f.plan=dailyReportPlan(CLOUD_ONCE.target,['NYSE','NASDAQ'],{periodFrom:CLOUD_ONCE.from});
 f.budget={attempts:0,inProgress:false};f.readBudget=async()=>structuredClone(f.budget);
 f.args={main,head:main,event:'schedule',attempt:'1',runId,plan:f.plan,now,request:f.request,readBudget:f.readBudget};
 f.env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'huanwujoy-crypto/fee-console',GITHUB_REF:'refs/heads/main',GITHUB_SHA:main,GITHUB_EVENT_NAME:'schedule',GITHUB_RUN_ATTEMPT:'1',GITHUB_RUN_ID:String(runId),FEE_REPORT_ONCE_MAIN:main,FEE_CLOUD_MODE:'publish',ONCE_PLAN:JSON.stringify(f.plan)};
 f.control=(mode,extra={},time=now)=>cloudOnceControl(mode,{env:{...f.env,...extra},now:time,request:f.request,readBudget:f.readBudget});
 f.complete=async()=>{await admitCloudOnce(f.args);await recordCloudOnceCandidate({...f.args,candidate});f.runs.get(runId).status='completed';f.runs.get(runId).conclusion='success';};
 return f;
}
function manualCloudOnceFixture(){
 const f=cloudOnceFixture();f.now=new Date('2026-11-03T03:30:10Z');
 f.event={sender:{id:283054367},repository:{full_name:'huanwujoy-crypto/fee-console'},inputs:{run_reviewed_once:'true',report_kind:'daily',report_target:'2026-11-02',report_markets:'NASDAQ,NYSE'}};
 f.env={...f.env,GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_ACTOR_ID:'283054367'};
 f.args={...f.args,event:'workflow_dispatch',reviewedManual:true,now:f.now};
 Object.assign(f.runs.get(f.runId),{event:'workflow_dispatch',actor:{id:283054367},created_at:'2026-11-03T03:30:00Z'});
 f.control=(mode,extra={},time=f.now)=>cloudOnceControl(mode,{env:{...f.env,...extra},now:time,request:f.request,readBudget:f.readBudget,readEvent:()=>structuredClone(f.event)});
 return f;
}
test('reviewed owner manual recovery uses the original claim, October plan and complete protected candidate chain',async()=>{
 const f=manualCloudOnceFixture();
 assert.equal((await f.control('once-scope')).state,'active');assert.equal(f.calls.length,0);
 assert.equal(f.plan.kind,'daily-monthly');assert.deepEqual(f.plan.monthlyCutoffs,['2026-10-31']);
 assert.equal((await f.control('once-admit')).state,'admitted');
 assert.equal((await f.control('once-confirm')).state,'confirmed');
 const claim=[...f.tags.values()][0];assert.equal(claim.tag,CLOUD_ONCE.tag);assert.equal(JSON.parse(claim.message).runId,f.runId);
 assert.equal((await f.control('once-finish',{ONCE_ADMIT_RESULT:'success',ONCE_PRODUCE_RESULT:'success',ONCE_CANDIDATE_SHA:f.candidate})).state,'candidate-recorded');
 Object.assign(f.runs.get(f.runId),{status:'completed',conclusion:'success'});
 assert.deepEqual(await f.control('once-promotion',{GITHUB_EVENT_NAME:'workflow_run',GITHUB_ACTOR_ID:'1'}),{state:'candidate',candidate:f.candidate});
 f.currentMain=f.candidate;
 assert.equal((await f.control('once-cleanup',{GITHUB_EVENT_NAME:'workflow_run',ONCE_PROMOTE_RESULT:'success'})).state,'paused');
 assert([...f.workflows.values()].every(s=>s==='disabled_manually'));
 assert.equal(f.refs.size,2);assert(!f.calls.some(c=>['PATCH','DELETE'].includes(c.method)));
});
test('manual owner input validation rejects every scope mismatch before any control or financial request',async()=>{
 const mutations=[
  f=>f.env.GITHUB_ACTOR_ID='1',f=>f.env.GITHUB_RUN_ATTEMPT='2',f=>f.env.GITHUB_SHA='c'.repeat(40),
  f=>f.event.sender.id=1,f=>f.event.repository.full_name='other/repository',
  f=>f.event.inputs.run_reviewed_once='false',f=>f.event.inputs.report_kind='monthly',
  f=>f.event.inputs.report_target='2026-11-03',f=>f.event.inputs.report_markets='NYSE',
  ...['ib_diagnostic_main','manual_sync_completed_for','confirmed_main','recovery_main','ratio_main','ratio_plan','source_from','source_target','source_main'].map(k=>f=>f.event.inputs[k]='unexpected'),
  ...['ib_diagnostic_once','source_plan_check_only','source_acceptance_once'].map(k=>f=>f.event.inputs[k]='true'),
  f=>f.event.inputs.unrecognized='true',f=>f.event=null
 ];
 for(const mutate of mutations){const f=manualCloudOnceFixture();mutate(f);
  assert.equal((await f.control('once-scope')).state,'closed');
  await assert.rejects(f.control('once-admit'),/ONCE_CONTROL/);assert.equal(f.calls.length,0);
 }
});
test('manual recovery respects exact11:30 start and original13:45 admission end, including native run time',async()=>{
 for(const time of ['2026-11-03T03:29:59.999Z','2026-11-03T05:45:00Z','2026-11-04T03:30:00Z']){
  const f=manualCloudOnceFixture();assert.equal((await f.control('once-scope',{},new Date(time))).state,'closed');
  await assert.rejects(f.control('once-admit',{},new Date(time)),/ONCE_CONTROL/);assert.equal(f.refs.size,0);
 }
 for(const time of ['2026-11-03T03:30:00Z','2026-11-03T05:44:59.999Z']){
  const f=manualCloudOnceFixture();assert.equal((await f.control('once-scope',{},new Date(time))).state,'active');
 }
 for(const mutate of [r=>r.actor.id=1,r=>r.created_at='2026-11-03T03:29:59Z',r=>r.created_at=CLOUD_ONCE.closeAt,r=>r.event='schedule',r=>r.run_attempt=2]){
  const f=manualCloudOnceFixture();mutate(f.runs.get(f.runId));await assert.rejects(f.control('once-admit'),/ONCE_CONTROL/);assert.equal(f.refs.size,0);
 }
});
test('manual and delayed natural admission race shares one immutable opportunity, without another source allowance',async()=>{
 const f=manualCloudOnceFixture();
 const scheduled={...f.args,event:'schedule',reviewedManual:false,runId:1002};
 const r=await Promise.allSettled([f.control('once-admit'),admitCloudOnce(scheduled)]);
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal(f.refs.size,1);
 assert(!f.calls.some(c=>['PATCH','DELETE'].includes(c.method)));
 for(const budget of [{attempts:1,inProgress:false},{attempts:2,inProgress:false},{attempts:0,inProgress:true}]){
  const x=manualCloudOnceFixture();x.budget=budget;await assert.rejects(x.control('once-admit'),/ONCE_CONTROL/);assert.equal(x.refs.size,0);
 }
});
test('manual failure or cancellation consumes the same claim and cleanup never creates a replacement opportunity',async()=>{
 for(const result of ['failure','cancelled','timed_out']){
  const f=manualCloudOnceFixture();await f.control('once-admit');
  assert.equal((await f.control('once-finish',{ONCE_ADMIT_RESULT:'success',ONCE_PRODUCE_RESULT:result})).state,'paused');
  await assert.rejects(f.control('once-admit'),/ONCE_CONTROL/);
  assert.equal(f.refs.size,1);assert([...f.workflows.values()].every(s=>s==='disabled_manually'));
 }
 const f=manualCloudOnceFixture();await f.control('once-admit');f.event.inputs.report_target='2026-11-03';
 await assert.rejects(f.control('once-confirm'),/ONCE_CONTROL/);assert.equal(f.refs.size,1);
});
test('actual event-file path supplies manual evidence while malformed or missing evidence fails closed',async()=>{
 const f=manualCloudOnceFixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-once-event-')),file=path.join(dir,'event.json');
 try{
  fs.writeFileSync(file,JSON.stringify(f.event),{mode:0o600});
  const args={env:{...f.env,GITHUB_EVENT_PATH:file},now:f.now,request:f.request};
  assert.equal((await cloudOnceControl('once-scope',args)).state,'active');
  fs.writeFileSync(file,'{malformed');assert.equal((await cloudOnceControl('once-scope',args)).state,'closed');
  fs.rmSync(file);assert.equal((await cloudOnceControl('once-scope',args)).state,'closed');
  assert.equal(f.calls.length,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('once window admits10:00 but not earlier and rejects wrong date head attempt or mode',async()=>{
 const f=cloudOnceFixture();assert.equal(await f.control('once-scope',{},new Date('2026-11-03T02:00:00Z')).then(x=>x.state),'active');assert.equal(f.calls.length,0);
 await assert.rejects(admitCloudOnce({...f.args,now:new Date('2026-11-03T01:59:59Z')}),/ONCE_CONTROL/);assert.equal(f.calls.length,0);
 for(const change of [{head:'c'.repeat(40)},{event:'workflow_dispatch'},{attempt:'2'},{now:new Date('2026-11-03T05:45:00Z')},{now:new Date('2026-11-04T05:00:00Z')}])assert.equal(cloudOnceWindow({...f.args,...change}),'closed');
 assert.equal(cloudOnceWindow({...f.args,now:new Date('2026-11-03T01:59:59Z')}),'waiting');
 assert.equal((await f.control('once-scope',{FEE_CLOUD_MODE:'shadow'})).state,'closed');
 await assert.rejects(f.control('once-admit',{FEE_CLOUD_MODE:'shadow'}),/ONCE_CONTROL/);
 await assert.rejects(f.control('once-unknown'),/ONCE_CONTROL/);assert.equal(f.calls.length,0);
 for(const plan of [{...f.plan,accountingThrough:'2026-11-03'},{...f.plan,monthlyCutoffs:[]},{...f.plan,markets:['NYSE','LSE']}])await assert.rejects(admitCloudOnce({...f.args,plan}),/ONCE_CONTROL/);
});
test('atomic once reservation precedes producer disable and financial admission; second run cannot consume',async()=>{
 const f=cloudOnceFixture();assert.equal((await f.control('once-admit')).state,'admitted');
 assert.equal(f.refs.size,1);assert.equal(f.workflows.get(CLOUD_ONCE.producer),'disabled_manually');assert.equal(f.workflows.get(CLOUD_ONCE.promotion),'active');
 assert.equal((await f.control('once-confirm')).state,'confirmed');
 assert(f.calls.findIndex(c=>c.method==='POST'&&c.route==='/git/refs')<f.calls.findIndex(c=>c.method==='PUT'));
 const before=f.calls.filter(c=>c.method==='POST').length;
 await assert.rejects(admitCloudOnce({...f.args,runId:1002}),/ONCE_CONTROL/);
 assert.equal(f.calls.filter(c=>c.method==='POST').length,before);
 assert(!f.calls.some(c=>/sharesight|gist|secret|338411790/.test(c.route)));
});
test('once acceptance does not reset or reuse an already spent ordinary target budget',async()=>{
 for(const budget of [{attempts:1,inProgress:false},{attempts:2,inProgress:false},{attempts:0,inProgress:true},null]){
  const f=cloudOnceFixture();f.budget=budget;await assert.rejects(admitCloudOnce(f.args),/ONCE_CONTROL/);assert.equal(f.refs.size,0);assert.equal(f.calls.length,0);
 }
});
test('two simultaneous synthetic admissions have exactly one winner and no mutable ref operation',async()=>{
 const f=cloudOnceFixture();const results=await Promise.allSettled([admitCloudOnce(f.args),admitCloudOnce({...f.args,runId:1002})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.refs.size,1);
 assert.equal(f.calls.filter(c=>c.method==='POST'&&c.route==='/git/refs').length,2);
 assert(!f.calls.some(c=>c.method==='PATCH'||c.method==='DELETE'));
});
test('uncertain ref response is resolved by readback without a second creation request',async()=>{
 const f=cloudOnceFixture();f.unknownRef=true;assert.equal((await admitCloudOnce(f.args)).state,'admitted');
 assert.equal(f.calls.filter(c=>c.route==='/git/refs'&&c.method==='POST').length,1);
});
test('cancelled failed or timed out source leaves the claim consumed and pauses both flows',async()=>{
 for(const result of ['failure','cancelled','timed_out']){
  const f=cloudOnceFixture();await admitCloudOnce(f.args);
  assert.equal((await f.control('once-finish',{ONCE_ADMIT_RESULT:'success',ONCE_PRODUCE_RESULT:result})).state,'paused');
  assert([...f.workflows.values()].every(s=>s==='disabled_manually'));assert.equal(f.refs.size,1);
  await assert.rejects(admitCloudOnce({...f.args,runId:1002}),/ONCE_CONTROL/);
 }
});
test('pause tries both fixed workflows and reports incomplete shutdown without touching the legacy workflow',async()=>{
 const f=cloudOnceFixture();f.failDisable.add(CLOUD_ONCE.producer);
 await assert.rejects(pauseCloudOnce(f.request),/ONCE_CONTROL/);
 assert.equal(f.workflows.get(CLOUD_ONCE.promotion),'disabled_manually');
 assert.deepEqual(f.calls.filter(c=>c.method==='PUT').map(c=>c.route),[CLOUD_ONCE.producer,CLOUD_ONCE.promotion].map(id=>'/actions/workflows/'+id+'/disable'));
});
test('claim failure after reservation cannot enter financial work or grant another attempt',async()=>{
 const f=cloudOnceFixture();f.failDisable.add(CLOUD_ONCE.producer);await assert.rejects(admitCloudOnce(f.args),/ONCE_CONTROL/);
 assert.equal(f.refs.size,1);await assert.rejects(confirmCloudOnce(f.args),/ONCE_CONTROL/);await assert.rejects(admitCloudOnce({...f.args,runId:1002}),/ONCE_CONTROL/);
});
test('candidate association requires the successful source job, signed exact parent and original two files',async()=>{
 for(const mutate of [f=>f.jobs.jobs[0].conclusion='failure',f=>f.jobs.jobs.push({...f.jobs.jobs[0]}),f=>f.commit.parents[0].sha='c'.repeat(40),f=>f.commit.commit.verification.verified=false,f=>f.commit.files[0].filename='index.html',f=>f.commit.author.id=1]){
  const f=cloudOnceFixture();await admitCloudOnce(f.args);mutate(f);await assert.rejects(recordCloudOnceCandidate({...f.args,candidate:f.candidate}),/ONCE_CONTROL/);assert.equal(f.refs.size,1);
 }
});
test('only the bound candidate after successful validation can promote; every terminal outcome pauses',async()=>{
 const f=cloudOnceFixture();await f.complete();
 assert.deepEqual(await cloudOnceStatus(f.args),{state:'candidate',candidate:f.candidate});
 f.validation.workflow_runs[0].status='in_progress';assert.equal((await cloudOnceStatus(f.args)).state,'waiting');
 f.validation.workflow_runs[0].status='completed';f.validation.workflow_runs[0].conclusion='failure';
 assert.equal((await f.control('once-cleanup',{ONCE_PROMOTE_RESULT:'skipped'})).state,'paused');
 assert([...f.workflows.values()].every(s=>s==='disabled_manually'));
 const published=cloudOnceFixture();await published.complete();published.currentMain=published.candidate;
 assert.equal((await published.control('once-cleanup',{ONCE_PROMOTE_RESULT:'success'})).state,'paused');
 const failed=cloudOnceFixture();await failed.complete();assert.equal((await failed.control('once-cleanup',{ONCE_PROMOTE_RESULT:'failure'})).state,'paused');
});
test('waiting gates do not consume; expiry and lost-runner terminal metadata cause shutdown without any second source',async()=>{
 const f=cloudOnceFixture();assert.equal((await f.control('once-finish',{ONCE_ADMIT_RESULT:'skipped',ONCE_PRODUCE_RESULT:'skipped'},new Date('2026-11-03T02:30:00Z'))).state,'waiting');
 assert.equal(f.refs.size,0);assert.equal(f.calls.filter(c=>c.method!=='GET').length,0);
 assert.equal((await f.control('once-cleanup',{ONCE_PROMOTE_RESULT:'skipped'},new Date(CLOUD_ONCE.finishBy))).state,'paused');
 const lost=cloudOnceFixture();await admitCloudOnce(lost.args);lost.runs.get(lost.runId).status='completed';lost.runs.get(lost.runId).conclusion='cancelled';
 assert.equal((await lost.control('once-cleanup',{ONCE_PROMOTE_RESULT:'skipped'})).state,'paused');assert.equal(lost.refs.size,1);
});
test('changed head, rerun, stale native run and uncertain control metadata never confirm source admission',async()=>{
 for(const mutate of [f=>f.currentMain='c'.repeat(40),f=>f.runs.get(f.runId).run_attempt=2,f=>f.runs.get(f.runId).created_at='2026-11-02T05:00:00Z']){
  const f=cloudOnceFixture();mutate(f);await assert.rejects(admitCloudOnce(f.args),/ONCE_CONTROL/);assert.equal(f.refs.size,0);
 }
 const f=cloudOnceFixture();await admitCloudOnce(f.args);await assert.rejects(confirmCloudOnce({...f.args,attempt:'2'}),/ONCE_CONTROL/);
 f.currentMain='c'.repeat(40);await assert.rejects(confirmCloudOnce(f.args),/ONCE_CONTROL/);
});
test('control transport never forwards credentials to redirects, other hosts, legacy workflow or raw error text',async()=>{
 const token='SYNTHETIC_SECRET_CANARY'.repeat(2),calls=[];
 const fetchImpl=async(url,opts)=>{calls.push({url,opts});throw Error(token+' URL account amount body');};
 await assert.rejects(cloudOnceRequest('GET','/git/ref/heads/main',undefined,{token,fetchImpl}),e=>e.message==='FEE_REPORT_ONCE_CONTROL');
 assert.equal(calls.length,1);assert.equal(calls[0].opts.redirect,'error');assert.match(calls[0].url,/^https:\/\/api\.github\.com\/repos\/huanwujoy-crypto\/fee-console\//);
 for(const [method,route] of [['PUT','/actions/workflows/338411790/disable'],['DELETE','/git/ref/tags/'+CLOUD_ONCE.tag],['GET','https://evil.invalid/']])await assert.rejects(cloudOnceRequest(method,route,undefined,{token,fetchImpl}),/ONCE_CONTROL/);
 assert.equal(calls.length,1);
});
test('once workflow wiring isolates short-lived control permissions and gates every financial step',()=>{
 const producer=fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml',import.meta.url),'utf8');
 const promotion=fs.readFileSync(new URL('../.github/workflows/promote-fee-data.yml',import.meta.url),'utf8');
 const block=(text,name)=>text.split('\n  '+name+':\n')[1].split(/\n  [a-z][a-z-]*:\n/)[0];
 for(const name of ['once-admit','once-finish']){
  const b=block(producer,name);assert.match(b,/contents: write\n      actions: write/);assert.doesNotMatch(b,/secrets\.|environment:|id-token:|google-github-actions/);
 }
 const cleanup=block(promotion,'once-cleanup');assert.match(cleanup,/always\(\)/);assert.match(cleanup,/contents: read\n      actions: write/);assert.doesNotMatch(cleanup,/secrets\.|environment:|id-token:/);
 const source=block(producer,'produce');assert.match(source,/needs: \[period, once-admit\]/);assert.match(source,/needs\['once-admit'\]\.result == 'success'/);
 assert(source.indexOf('--mode=once-confirm')<source.indexOf('google-github-actions/auth@'));
 assert.doesNotMatch(source,/contents: write|actions: write/);assert.match(source,/timeout-minutes: 15/);
 assert.match(block(producer,'period'),/github.event_name == 'schedule'.*FEE_REPORT_ONCE_MAIN != ''/);
 assert.match(promotion,/steps.once.outputs.state == 'candidate'/);assert.match(promotion,/git rev-parse "\$candidate_ref"\) != "\$ONCE_CANDIDATE_SHA"/);
 assert(!producer.includes('/enable'));assert(!promotion.includes('/enable'));
});
test('read-only promotion inspection does not attempt a write on metadata failure; the separate cleanup role pauses',async()=>{
 const f=cloudOnceFixture(),request=async(method,route,body)=>{
  if(route==='/git/ref/heads/main')throw Error('SYNTHETIC_PRIVATE_CANARY');
  return f.request(method,route,body);
 };
 await assert.rejects(cloudOnceControl('once-promotion',{env:f.env,now:f.now,request}),e=>e.message==='FEE_REPORT_ONCE_CONTROL');
 assert.equal(f.calls.filter(c=>c.method!=='GET').length,0);
 await assert.rejects(cloudOnceControl('once-cleanup',{env:f.env,now:f.now,request}),e=>e.message==='FEE_REPORT_ONCE_CONTROL');
 assert([...f.workflows.values()].every(s=>s==='disabled_manually'));
});

// Default fetch is forbidden for the entire suite. Individual wire mocks may
// replace it temporarily, but a forgotten injection must fail even if product
// code catches the error. No real request is sent by this tripwire.
const originalDefaultFetch=globalThis.fetch;
let unmockedFetchAttempts=0;
globalThis.fetch=async()=>{unmockedFetchAttempts++;throw Error('OFFLINE_UNMOCKED_FETCH_FORBIDDEN');};
after(()=>{globalThis.fetch=originalDefaultFetch;assert.equal(unmockedFetchAttempts,0,'every network dependency must have an explicit offline mock');});

test('period diagnostics retain only literal noncash failures and fixed stages',()=>{
 const module=fs.readFileSync(new URL('./fee-sharesight-transfers.mjs',import.meta.url),'utf8');
 const codes=new Set([...module.matchAll(/fail\('([A-Z_]+)'\)/g)].map(m=>m[1]));
 assert.equal(codes.size,19);
 for(const code of codes){
  const error=Error('FEE_NONCASH_'+code),fixed='FEE_CLOUD_STAGE_SOURCE_READ_NONCASH_'+code;
  assert.equal(reportFailureCode(error,'SOURCE_READ'),fixed);
  assert.equal(reportFailureCode(Error(fixed)),fixed); // outer CLI must not erase it again
 }
 const hidden='PRIVATE_CANARY amount=123456.78 account=synthetic-private /private/location \u001b[31m\r\n';
 for(const message of [hidden,'FEE_NONCASH_'+hidden,'FEE_NONCASH_NOT_A_REGISTERED_CODE','FEE_NONCASH_POSITION_DELTA\n'+hidden]){
  assert.equal(reportFailureCode(Error(message),'SOURCE_READ'),'FEE_CLOUD_STAGE_SOURCE_READ_UNKNOWN');
 }
 assert.equal(reportFailureCode(Error('FEE_NONCASH_POSITION_DELTA'),hidden),'FEE_CLOUD_STAGE_UNKNOWN_NONCASH_POSITION_DELTA');
 for(const [error,category] of [[new TypeError(hidden),'TYPE'],[new RangeError(hidden),'RANGE'],[new SyntaxError(hidden),'SYNTAX'],[new ReferenceError(hidden),'REFERENCE']]){
  assert.equal(reportFailureCode(error,'SOURCE_READ'),'FEE_CLOUD_STAGE_SOURCE_READ_'+category);
 }
 assert.equal(reportFailureCode(new SourceFetchError('SOURCE_HTTP'),'ECONOMIC_READ'),'SOURCE_HTTP');
 for(const code of ['SOURCE_HTTP','SOURCE_FORBIDDEN','SOURCE_HTTP_PRIVATE_CANARY']){
  assert.equal(reportFailureCode(Error(code),'ECONOMIC_READ'),'FEE_CLOUD_STAGE_ECONOMIC_READ_UNKNOWN');
  assert.equal(reportFailureCode(Object.assign(Error(code),{name:'SourceFetchError'}),'ECONOMIC_READ'),'FEE_CLOUD_STAGE_ECONOMIC_READ_UNKNOWN');
 }
 assert.equal(reportFailureCode(Error('FEE_REPORT_SOURCE_UNSTABLE'),'SOURCE_READ'),'FEE_REPORT_SOURCE_UNSTABLE');
 assert.equal(reportFailureCode(Error('FEE_CLOUD_CASH_BALANCE_STALE'),'SOURCE_READ'),'FEE_CLOUD_CASH_BALANCE_STALE');
 assert.equal(producerFailureCode(Error('FEE_NONCASH_POSITION_DELTA'),'SOURCE_READ'),'FEE_CLOUD_STAGE_SOURCE_READ_NONCASH_POSITION_DELTA');
});

test('actual period error path preserves source/economic stage without IO, candidate or private exception text',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-period-diagnostic-'));fs.chmodSync(dir,0o700);
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const oldKey=process.env.FEE_DATA_KEY,key=crypto.randomBytes(32),iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);
 const bytes=Buffer.from(JSON.stringify({enc:true,v:3,data:Buffer.concat([iv,c.update(JSON.stringify({daily:[{d:'2026-10-22'}]})),c.final(),c.getAuthTag()]).toString('base64')}));
 const source=path.join(dir,'base.json'),benchmark=path.join(dir,'benchmark.json');fs.writeFileSync(source,bytes,{mode:0o600});
 fs.writeFileSync(benchmark,JSON.stringify(cache),{mode:0o600});process.env.FEE_DATA_KEY=key.toString('base64url');
 t.after(()=>{if(oldKey===undefined)delete process.env.FEE_DATA_KEY;else process.env.FEE_DATA_KEY=oldKey;});
 let network=0;const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{network++;throw Error('network forbidden in synthetic test');};t.after(()=>globalThis.fetch=oldFetch);
 const hidden='PRIVATE_CANARY source/body/account/123456.78 \u001b[31m';
 const cases=[
  ['economic',Error(hidden),'FEE_CLOUD_STAGE_ECONOMIC_READ_UNKNOWN'],
  ['economic',new SourceFetchError('SOURCE_FORBIDDEN'),'SOURCE_FORBIDDEN'],
  ['source',Error('FEE_NONCASH_POSITION_DELTA'),'FEE_CLOUD_STAGE_SOURCE_READ_NONCASH_POSITION_DELTA'],
  ['source',Error('FEE_NONCASH_SOURCE_MARK'),'FEE_CLOUD_STAGE_SOURCE_READ_NONCASH_SOURCE_MARK'],
  ['source',Error(hidden),'FEE_CLOUD_STAGE_SOURCE_READ_UNKNOWN'],
  ['source',new TypeError(hidden),'FEE_CLOUD_STAGE_SOURCE_READ_TYPE'],
  ['source',Error('FEE_CLOUD_SOURCE_INCOMPLETE'),'FEE_CLOUD_SOURCE_INCOMPLETE'],
 ];
 for(const [index,[phase,error,expected]]of cases.entries()){
  const out=path.join(dir,'out'+index);fs.mkdirSync(out,{mode:0o700});let reads=0,cleaned=0;
  await assert.rejects(produceReportPeriod({plan:weeklyReportPlan('2026-10-23'),now:new Date('2026-10-26T06:00:00Z'),sourceFile:source,outputDir:out,benchmarkFile:benchmark,
   fetchEconomic:async()=>{if(phase==='economic')throw error;return{envelopeVersion:4,cleanup(){cleaned++;}};},
   readOnce:async()=>{reads++;throw error;}}),actual=>{assert.equal(actual.message,expected);assert.equal(reportFailureCode(actual),expected);assert.equal(actual instanceof SourceFetchError,error instanceof SourceFetchError);assert.equal(actual.message.includes(hidden),false);assert.equal(Object.hasOwn(actual,'cause'),false);return true;});
  assert.equal(reads,phase==='source'?1:0);assert.equal(cleaned,phase==='source'?1:0);
  assert.deepEqual(fs.readdirSync(out),[]);assert.deepEqual(fs.readFileSync(source),bytes);
 }
 assert.equal(network,0);
});

function syntheticFundTransfer(){
 const gid='a'.repeat(32),key=crypto.randomBytes(32),iv=crypto.randomBytes(12),date='2026-10-27';
 const sourceKeys=Array.from({length:7},(_,i)=>`sharesight:${200+i}->${300+i};holding:${400+i}`);
 const event={id:'synthetic-inkind-group',date,investorId:'B',grossCents:700,feeCents:0,netCents:700,priceDate:date,priceTotalCents:10000,issuedShares:70,sourceRef:'sharesight:synthetic-group',inKindClose:{sourceKeys,sourceBinding:{sourcePortfolioId:2,destinationPortfolioId:1,sourceHoldingIds:Array.from({length:7},(_,i)=>500+i)}}};
 const bundle={schema:'fee-console.fund-remote.v1',gid,updatedAt:'2026-10-28T00:00:00.000Z',profile:{schema:'fee-console.fund-profile.v1',manager:'Synthetic Manager',fundName:'Synthetic Fund',inceptionDate:'2026-10-01',inceptionNoticeDate:'2026-10-01',currency:'USD',initialShares:1000,investors:[{id:'A',name:'Synthetic A',shares:900},{id:'B',name:'Synthetic B',shares:100}],subscriptions:[event]},library:{}};
 const seal=()=>{const c=crypto.createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([iv,c.update(JSON.stringify(bundle)),c.final(),c.getAuthTag()]).toString('base64');return JSON.stringify({enc:true,v:1,data});};
 const economic={fundProfileRaw:seal(),fundProfileStable:true,fundProfileMatchesGist:value=>value===gid};
 return {bundle,key:key.toString('base64url'),economic,seal,date};
}
test('actual period input helper decrypts only the existing same-Gist fund file and selects exact dated identity pairs',()=>{
 const f=syntheticFundTransfer(),r=managedTransferIdentitiesFromFund(f.economic,f.key,f.date);assert.equal(r.pairs.length,7);assert.deepEqual(r.pairs[0],{sourceTradeId:200,sourceHoldingId:500,tradeId:300,holdingId:400});assert.equal(r.date,f.date);assert.equal(r.account,'webull');assert.equal(managedTransferIdentitiesFromFund(f.economic,f.key,'2026-10-28'),null);assert.equal(managedTransferIdentitiesFromFund({},f.key,f.date),null);
});
test('wrong key/Gist, unstable encrypted file, missing binding and profile identity mismatch stop before Sharesight',()=>{
 for(const mutate of [f=>f.key=crypto.randomBytes(32).toString('base64url'),f=>{f.bundle.gid='b'.repeat(32);f.economic.fundProfileRaw=f.seal();},f=>f.economic.fundProfileStable=false,f=>{delete f.bundle.profile.subscriptions[0].inKindClose.sourceBinding;f.economic.fundProfileRaw=f.seal();},f=>{f.bundle.profile.subscriptions[0].investorId='ManagerLabel';f.economic.fundProfileRaw=f.seal();},f=>{f.bundle.profile.subscriptions[0].inKindClose.approved=true;f.economic.fundProfileRaw=f.seal();},f=>f.economic.fundProfileRaw=f.economic.fundProfileRaw.slice(0,-2)]){const f=syntheticFundTransfer();mutate(f);assert.throws(()=>managedTransferIdentitiesFromFund(f.economic,f.key,f.date),/^Error: FEE_REPORT_FUND_TRANSFER_INPUT_UNVERIFIED$/);}
});

// Existing preflight scenarios isolate unrelated public attempt metadata.
const reportPublicationPreflight = args=>nativeReportPreflight({readSourceAttempts:async()=>({attempts:0,inProgress:false}),...args});

const cache={v:1,benchmarks:{spy: {symbol:'SPY',currency:'USD',exchange:'NYSEArca',series:[{d:'2026-10-22',p:100},{d:'2026-10-23',p:101,div:1}]},qqq: {symbol:'QQQ',currency:'USD',exchange:'NasdaqGS',series:[{d:'2026-10-22',p:200},{d:'2026-10-23',p:202}]}}};
test('real daily preflight admits10:30, continues the same target and keeps bounded source attempts',async()=>{
 const old=state(weeklyReportPlan('2026-10-23')),markets=['NYSE','LSE','SIX','EURONEXT_PARIS'],args={markets,ibEnabled:false,readState:async()=>old,readSourceAttempts:async()=>({attempts:0,inProgress:false})};
 const first=await dailyPublicationPreflight({...args,now:new Date('2026-10-28T10:30:00+08:00')});assert.equal(first.outcome,'produce');assert.equal(first.plan.accountingThrough,'2026-10-27');assert.equal(first.plan.kind,'daily');
 const next=await dailyPublicationPreflight({...args,now:new Date('2026-10-28T13:00:00+08:00')});assert.equal(next.outcome,'produce');assert.equal(next.plan.accountingThrough,'2026-10-27');assert.equal(next.plan.periodFrom,'2026-10-24');assert.equal(next.plan.kind,'daily');
 assert.equal((await dailyPublicationPreflight({...args,now:new Date('2026-10-28T14:00:00+08:00'),readSourceAttempts:async()=>({attempts:2,inProgress:false})})).reasonCode,'REPORT_SOURCE_ATTEMPT_BUDGET_EXHAUSTED');
 assert.equal((await dailyPublicationPreflight({...args,now:new Date('2026-10-28T13:00:00+08:00'),runAttempt:'2'})).reasonCode,'REPORT_SOURCE_RERUN_NOT_ALLOWED');
 for(const scope of [[],['NYSE','EURONEXT']])assert.equal((await dailyPublicationPreflight({...args,markets:scope,now:new Date('2026-10-28T13:00:00+08:00'),readState:()=>assert.fail('unresolved market must not access source state')})).reasonCode,'CALENDAR_SCOPE_UNVERIFIED');
});
test('scheduled target30 reaches metadata checks at10:30 without a forged manual-sync confirmation',async()=>{
 const old=state(weeklyReportPlan('2026-10-23')),now=new Date('2026-10-31T10:30:00+08:00');
 let metadataCalls=0;const args={now,markets:['NYSE','NASDAQ'],ibEnabled:false,readState:async()=>old,readSourceAttempts:async()=>{metadataCalls++;return {attempts:0,inProgress:false};}};
 const r=await dailyPublicationPreflight(args);assert.equal(r.outcome,'produce');assert.equal(r.plan.accountingThrough,'2026-10-30');assert.equal(r.plan.priceThrough,'2026-10-30');assert.equal(r.plan.scheduledAt,'2026-10-31T10:30:00+08:00');assert.equal(metadataCalls,1);
 assert.equal((await dailyPublicationPreflight({...args,now:new Date('2026-10-31T10:29:59+08:00'),readState:()=>assert.fail('early plan must not read publication state')})).reasonCode,'REPORT_NOT_DUE');
 for(const [budget,reason]of [[{attempts:2,inProgress:false},'REPORT_SOURCE_ATTEMPT_BUDGET_EXHAUSTED'],[{attempts:0,inProgress:true},'REPORT_SOURCE_RUN_IN_PROGRESS']])assert.equal((await dailyPublicationPreflight({...args,readSourceAttempts:async()=>budget})).reasonCode,reason);
 assert.equal((await dailyPublicationPreflight({...args,runAttempt:'2'})).reasonCode,'REPORT_SOURCE_RERUN_NOT_ALLOWED');
 assert.equal((await dailyPublicationPreflight({...args,readSourceAttempts:async()=>{throw Error('synthetic metadata unavailable');}})).reasonCode,'REPORT_SOURCE_ATTEMPT_METADATA_UNVERIFIED');
 assert.equal((await dailyPublicationPreflight({...args,readState:async()=>({...old,pending:true})})).outcome,'candidate-pending');
 for(const markets of [[],['NYSE','EURONEXT']])assert.equal((await dailyPublicationPreflight({...args,markets,readState:()=>assert.fail('unknown calendar must not read publication state')})).reasonCode,'CALENDAR_SCOPE_UNVERIFIED');
 await assert.rejects(dailyPublicationPreflight({...args,reviewedSyncDate:'2026-10-30',readState:()=>assert.fail('scheduled plan cannot impersonate manual confirmation')}),/MANUAL_SYNC_CONFIRMATION/);
});
test('scheduled Nov2 and deferred October archive use one10:00 source admission without manual impersonation',async()=>{
 const old=state(dailyReportPlan('2026-10-30',['NYSE','NASDAQ']),'2026-10-31T09:35:00Z');
 const args={now:new Date('2026-11-03T10:00:00+08:00'),markets:['NYSE','NASDAQ'],ibEnabled:false,readState:async()=>old,readSourceAttempts:async()=>({attempts:0,inProgress:false})};
 const r=await dailyPublicationPreflight(args);assert.equal(r.outcome,'produce');assert.equal(r.plan.scheduledAt,'2026-11-03T10:00:00+08:00');
 assert.equal(r.plan.accountingThrough,'2026-11-02');assert.equal(r.plan.periodFrom,'2026-10-31');assert.equal(r.plan.kind,'daily-monthly');assert.deepEqual(r.plan.monthlyCutoffs,['2026-10-31']);
 assert.equal((await dailyPublicationPreflight({...args,now:new Date('2026-11-03T09:59:59+08:00'),readState:()=>assert.fail('early gate must not read state')})).reasonCode,'REPORT_NOT_DUE');
 assert.equal((await dailyPublicationPreflight({...args,readSourceAttempts:async()=>({attempts:2,inProgress:false})})).reasonCode,'REPORT_SOURCE_ATTEMPT_BUDGET_EXHAUSTED');
 assert.equal((await dailyPublicationPreflight({...args,readState:async()=>({...old,pending:true})})).outcome,'candidate-pending');
 await assert.rejects(dailyPublicationPreflight({...args,reviewedSyncDate:'2026-11-02'}),/MANUAL_SYNC_CONFIRMATION/);
});
test('recurring daily entry is separately enabled and leaves the consumed one-off authoritative',()=>{
 const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'huanwujoy-crypto/fee-console',GITHUB_REF:'refs/heads/main',GITHUB_SHA:'a'.repeat(40),GITHUB_EVENT_NAME:'schedule',GITHUB_RUN_ATTEMPT:'1',GITHUB_RUN_ID:'1001',FEE_REPORT_ONCE_MAIN:'',FEE_REPORT_DAILY_ENABLED:'true',FEE_REPORT_PERIODS_ENABLED:'true',FEE_CLOUD_MODE:'publish',PLANNED_MAIN:'a'.repeat(40)};
 const now=new Date('2026-11-04T09:00:00+08:00'),preflight={mode:'preflight'},produce={mode:'produce','report-kind':'daily','report-target':'2026-11-03'};
 assert.equal(scheduledDailyContext(preflight,{env,now}),true);assert.equal(scheduledDailyContext(produce,{env,now}),true);
 assert.equal(scheduledDailyContext(preflight,{env:{...env,FEE_REPORT_ONCE_MAIN:'b'.repeat(40)},now}),false);
 assert.equal(scheduledDailyContext(preflight,{env:{...env,GITHUB_EVENT_NAME:'workflow_dispatch'},now}),false);
 for(const change of [{FEE_REPORT_DAILY_ENABLED:''},{FEE_REPORT_PERIODS_ENABLED:'false'},{FEE_CLOUD_MODE:'shadow'},{GITHUB_ACTIONS:'false'},{GITHUB_REPOSITORY:'other/repo'},{GITHUB_REF:'refs/heads/other'},{GITHUB_SHA:''},{GITHUB_RUN_ATTEMPT:'2'},{GITHUB_RUN_ID:'0'}])assert.throws(()=>scheduledDailyContext(preflight,{env:{...env,...change},now}),/DAILY_SCOPE/);
 for(const args of [{...preflight,'report-target':'2026-11-03'},{...produce,'report-target':'2026-11-02'},{...produce,'report-kind':'monthly'},{...produce,'manual-sync-completed-for':'2026-11-03'},{...produce,'recovery-main':'a'.repeat(40)}])assert.throws(()=>scheduledDailyContext(args,{env,now}),/DAILY_SCOPE/);
 assert.throws(()=>scheduledDailyContext(produce,{env:{...env,PLANNED_MAIN:'b'.repeat(40)},now}),/DAILY_SCOPE/);
});
function automaticDailyFixture(){
 const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'huanwujoy-crypto/fee-console',GITHUB_REF:'refs/heads/main',GITHUB_SHA:'a'.repeat(40),GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_ACTOR_ID:'283054367',GITHUB_RUN_ATTEMPT:'1',GITHUB_RUN_ID:'1001',FEE_REPORT_ONCE_MAIN:'',FEE_REPORT_DAILY_ENABLED:'true',FEE_REPORT_PERIODS_ENABLED:'true',FEE_CLOUD_MODE:'publish',FEE_AUTOMATIC_DAILY_REQUEST:'true',PLANNED_MAIN:'a'.repeat(40)};
 const event={sender:{id:283054367},repository:{full_name:'huanwujoy-crypto/fee-console'},inputs:{report_kind:'automatic-daily'}};
 return {env,event,now:new Date('2026-11-04T09:00:00+08:00')};
}
test('automatic daily dispatch uses original daily guards without asserting manual review',()=>{
 const f=automaticDailyFixture(),args={mode:'preflight'},readEvent=()=>f.event;
 assert.equal(scheduledDailyContext(args,{...f,readEvent}),true);
 assert.equal(reviewedSyncConfirmation(args,{...f,readEvent}),null);
 assert.equal(scheduledDailyContext({mode:'produce','report-kind':'daily','report-target':'2026-11-03'},{...f,readEvent}),true);
 assert.equal(f.env.GITHUB_EVENT_NAME,'workflow_dispatch');assert.equal(f.event.inputs.run_reviewed_once,undefined);
});
test('automatic daily rejects wrong identity, reruns, disabled mode and old one-off binding',()=>{
 for(const change of [{GITHUB_ACTOR_ID:'1'},{GITHUB_EVENT_NAME:'schedule'},{GITHUB_REF:'refs/heads/topic'},{GITHUB_RUN_ATTEMPT:'2'},{FEE_REPORT_DAILY_ENABLED:'false'},{FEE_REPORT_PERIODS_ENABLED:'false'},{FEE_CLOUD_MODE:'shadow'},{FEE_REPORT_ONCE_MAIN:'b'.repeat(40)}]){
  const f=automaticDailyFixture();assert.throws(()=>scheduledDailyContext({mode:'preflight'},{...f,env:{...f.env,...change},readEvent:()=>f.event}),/DAILY_SCOPE/);
 }
});
test('automatic daily rejects target overrides, human confirmation, mixed operations and unknown inputs',()=>{
 const changes=[{ib_diagnostic_once:'true'},{ib_diagnostic_main:'b'.repeat(40)},{report_kind:'daily'},{report_target:'2026-11-03'},{report_markets:'NYSE'},{manual_sync_completed_for:'2026-11-03'},{recovery_main:'b'.repeat(40)},{run_reviewed_once:'true'},{source_acceptance_once:'true'},{source_plan_check_only:'true'},{source_from:'2026-11-01'},{source_target:'2026-11-03'},{source_main:'b'.repeat(40)},{ratio_plan:'private-canary'},{ratio_main:'b'.repeat(40)},{unexpected:'private-canary'}];
 for(const change of changes){const f=automaticDailyFixture();Object.assign(f.event.inputs,change);assert.throws(()=>scheduledDailyContext({mode:'preflight'},{...f,readEvent:()=>f.event}),/^Error: FEE_REPORT_DAILY_SCOPE$/);}
 const f=automaticDailyFixture();for(const change of [{sender:{id:1}},{repository:{full_name:'other/repo'}}])assert.throws(()=>scheduledDailyContext({mode:'preflight'},{...f,readEvent:()=>({...f.event,...change})}),/DAILY_SCOPE/);
 assert.throws(()=>scheduledDailyContext({mode:'preflight'},{...f,readEvent:()=>{throw Error('private-canary');}}),/^Error: FEE_REPORT_DAILY_SCOPE$/);
});
test('automatic daily accepts GitHub default fields but cannot override preflight arguments',()=>{
 const f=automaticDailyFixture();Object.assign(f.event.inputs,{ib_diagnostic_once:'false',ib_diagnostic_main:'',run_reviewed_once:'false',source_plan_check_only:'false',source_acceptance_once:'false',report_target:'',report_markets:'',manual_sync_completed_for:'',confirmed_main:'',recovery_main:'',ratio_main:'',ratio_plan:'',source_from:'',source_target:'',source_main:''});
 assert.equal(scheduledDailyContext({mode:'preflight'},{...f,readEvent:()=>f.event}),true);
 assert.throws(()=>scheduledDailyContext({mode:'preflight','report-target':'2026-11-03'},{...f,readEvent:()=>f.event}),/DAILY_SCOPE/);
});
test('clock request passes the real automatic admission and retains attempted-source refusal',async()=>{
 const result=spawnSync('python3',['-c',"import json; from runtime import Github\nclass H:\n def request(self,url,**kw):\n  print(json.dumps(kw['body'])); return 204,None\nGithub(http=H(),read_token=lambda:'synthetic-only').dispatch()"],{cwd:new URL('../cloud/fee-clock/',import.meta.url),encoding:'utf8',env:{PATH:process.env.PATH,PYTHONDONTWRITEBYTECODE:'1'}});
 assert.equal(result.status,0,result.stderr);const body=JSON.parse(result.stdout),f=automaticDailyFixture();assert.equal(body.ref,'main');f.event.inputs=body.inputs;
 const automatic=scheduledDailyContext({mode:'preflight'},{...f,readEvent:()=>f.event});
 const prior=state(dailyReportPlan('2026-11-02',['NYSE','NASDAQ']),'2026-11-03T03:47:41Z');
 const outcome=await dailyPublicationPreflight({scheduledDaily:automatic,now:f.now,markets:['NYSE','NASDAQ'],ibEnabled:true,runAttempt:'1',readState:async()=>prior,readSourceAttempts:async()=>({attempts:1,inProgress:false})});
 assert.equal(outcome.reasonCode,'REPORT_DAILY_SOURCE_ALREADY_ATTEMPTED');
});
test('actual workflow admits only the opted-in automatic period path and propagates context before finance',()=>{
 const wf=fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml',import.meta.url),'utf8');
 const condition=(name,inputs,overrides={})=>{
  const block=wf.split('\n  '+name+':\n')[1].split(/\n  [a-z-]+:\n/)[0];
  const expression=/(?:^|\n)    if: \$\{\{ (.+) \}\}/.exec(block)[1];
  const github={event_name:'workflow_dispatch',actor_id:'283054367',ref:'refs/heads/main',run_attempt:1,sha:'a'.repeat(40),...overrides.github};
  const vars={FEE_REPORT_ONCE_MAIN:'',FEE_REPORT_DAILY_ENABLED:'true',FEE_REPORT_PERIODS_ENABLED:'true',FEE_CLOUD_MODE:'publish',...overrides.vars};
  return Boolean(vm.runInNewContext(expression,{inputs,github,vars}));
 };
 const input={report_kind:'automatic-daily'};
 assert.equal(condition('period',input),true);
 for(const change of [{run_reviewed_once:true},{run_reviewed_once:false,ratio_plan:'x'},{source_acceptance_once:true},{source_plan_check_only:true}])assert.equal(condition('period',{...input,...change}),false);
 for(const overrides of [{github:{actor_id:'1'}},{github:{ref:'refs/heads/topic'}},{github:{run_attempt:2}},{vars:{FEE_REPORT_DAILY_ENABLED:'false'}},{vars:{FEE_REPORT_ONCE_MAIN:'b'.repeat(40)}}])assert.equal(condition('period',input,overrides),false);
 for(const job of ['source-plan-check','source-acceptance','ratio-preflight'])assert.equal(condition(job,{...input,source_plan_check_only:true,source_acceptance_once:true,ratio_plan:'x',ratio_main:'a'.repeat(40)}),false);
 assert.equal((wf.match(/FEE_AUTOMATIC_DAILY_REQUEST:/g)||[]).length,3);
 assert.match(wf,/REVIEWED_KIND: \$\{\{ github.event_name == 'workflow_dispatch' && inputs.run_reviewed_once && inputs.report_kind/);
 assert.match(wf,/REVIEWED_TARGET: \$\{\{ github.event_name == 'workflow_dispatch' && inputs.run_reviewed_once && inputs.report_target/);
});
test('Nov4 daily09:00 and11:30 share one target; waiting, failed, pending and published entries do not read finance again',async()=>{
 const prior=state(dailyReportPlan('2026-11-02',['NYSE','NASDAQ']),'2026-11-03T03:47:41Z');
 const args={scheduledDaily:true,markets:['NYSE','NASDAQ'],ibEnabled:true,runAttempt:'1',readState:async()=>prior,readSourceAttempts:async()=>({attempts:0,inProgress:false})};
 for(const clock of ['09:00:00','11:30:00','14:00:00']){
  const result=await dailyPublicationPreflight({...args,now:new Date('2026-11-04T'+clock+'+08:00')});
  assert.equal(result.outcome,'produce');assert.equal(result.plan.accountingThrough,'2026-11-03');assert.equal(result.plan.periodFrom,'2026-11-03');assert.equal(result.plan.scheduledAt,'2026-11-04T09:00:00+08:00');
 }
 const now=new Date('2026-11-04T11:30:00+08:00');
 assert.equal((await dailyPublicationPreflight({...args,now:new Date('2026-11-04T08:59:59+08:00'),readState:()=>assert.fail('early check must be public-only and not consume a source attempt')})).outcome,'waiting');
 for(const [budget,reason] of [[{attempts:1,inProgress:false},'REPORT_DAILY_SOURCE_ALREADY_ATTEMPTED'],[{attempts:2,inProgress:false},'REPORT_SOURCE_ATTEMPT_BUDGET_EXHAUSTED'],[{attempts:0,inProgress:true},'REPORT_SOURCE_RUN_IN_PROGRESS']])assert.equal((await dailyPublicationPreflight({...args,now,readSourceAttempts:async()=>budget})).reasonCode,reason);
 assert.equal((await dailyPublicationPreflight({...args,now,readSourceAttempts:async()=>{throw Error('private-canary');}})).reasonCode,'REPORT_SOURCE_ATTEMPT_METADATA_UNVERIFIED');
 assert.equal((await dailyPublicationPreflight({...args,now,runAttempt:'2'})).reasonCode,'REPORT_SOURCE_RERUN_NOT_ALLOWED');
 assert.equal((await dailyPublicationPreflight({...args,now,readState:async()=>({...prior,pending:true}),readSourceAttempts:()=>assert.fail('pending candidate must wait')})).outcome,'candidate-pending');
 const published=state(dailyReportPlan('2026-11-03',['NYSE','NASDAQ']),'2026-11-04T02:15:00Z');
 assert.equal((await dailyPublicationPreflight({...args,now,readState:async()=>published,readRetryRuns:()=>assert.fail('same-cutoff Jenny recheck is forbidden in unified daily mode'),readSourceAttempts:()=>assert.fail('published report must not enter finance')})).outcome,'already-published');
 await assert.rejects(dailyPublicationPreflight({...args,now,targetDate:'2026-11-03'}),/DAILY_SCOPE/);
 assert.equal((await dailyPublicationPreflight({...args,now:new Date('2026-11-08T10:00:00+08:00'),readState:()=>assert.fail('closed US markets must not read source state')})).outcome,'not-due');
});
test('daily opt-in uses the original serialized producer, unchanged clocks and no extra control permissions',()=>{
 const workflow=fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml',import.meta.url),'utf8');
 assert.match(workflow,/group: fee-cloud-producer\n  cancel-in-progress: false/);
 assert.deepEqual([...workflow.matchAll(/cron: '([^']+)'/g)].map(m=>m[1]),['0 1 * * *','30 3 * * *','0 6 * * *']);
 const period=workflow.split('\n  period:\n')[1].split('\n  once-admit:\n')[0],produce=workflow.split('\n  produce:\n')[1].split('\n  once-finish:\n')[0];
 assert.match(period,/vars.FEE_REPORT_ONCE_MAIN != '' \|\| \(vars.FEE_REPORT_DAILY_ENABLED == 'true' && vars.FEE_CLOUD_MODE == 'publish'\)/);
 assert(period.indexOf('--mode=once-scope')<period.indexOf('args=(--mode=preflight)'));
 assert(produce.indexOf('scheduledDailyContext({mode:')<produce.indexOf('google-github-actions/auth@'));
 assert(produce.indexOf('assertIbManagerConfiguration();')<produce.indexOf('google-github-actions/auth@'));
 assert.doesNotMatch(produce,/contents: write|actions: write/);
 assert.equal((workflow.match(/FEE_REPORT_DAILY_ENABLED: \$\{\{ vars.FEE_REPORT_DAILY_ENABLED \}\}/g)||[]).length,3);
});
test('known US session permits only the reviewed one-off calendar qualifier; scheduled scope stays unchanged',async()=>{
 const r=await dailyPublicationPreflight({markets:['NYSE','NASDAQ'],targetDate:'2026-10-27',now:new Date('2026-10-28T13:00:00+08:00'),ibEnabled:false,readState:async()=>state(weeklyReportPlan('2026-10-23')),readSourceAttempts:async()=>({attempts:0,inProgress:false})});
 assert.equal(r.outcome,'produce');assert.equal(r.plan.accountingThrough,'2026-10-27');assert.deepEqual(r.plan.markets,['NASDAQ','NYSE']);
 const workflow=fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml',import.meta.url),'utf8');
 const expression=workflow.match(/REVIEWED_MARKETS:\s*\$\{\{([^\n]+)\}\}/)[1];
 const qualifier=Function('github','inputs','return ('+expression+');');
 assert.equal(qualifier({event_name:'schedule'},{run_reviewed_once:true,report_markets:'NYSE'}),'');
 assert.equal(qualifier({event_name:'workflow_dispatch'},{run_reviewed_once:false,report_markets:'NYSE'}),'');
 assert.equal(qualifier({event_name:'workflow_dispatch'},{run_reviewed_once:true,report_markets:'NYSE'}),'NYSE');
 for(const args of [['--mode=produce','--report-kind=daily','--report-target=2026-10-27'],['--mode=preflight','--report-kind=weekly','--report-target=2026-10-23'],['--mode=preflight']]){
  const result=spawnSync(process.execPath,[new URL('./fee-report-producer.mjs',import.meta.url).pathname,...args,'--report-markets=NYSE'],{encoding:'utf8',env:{PATH:process.env.PATH}});
  assert.equal(result.status,1);assert.match(result.stderr,/FEE_REPORT_ARGUMENT/);
 }
});
function cashOnly(date){
  const result={};let cashId=100;
  for(const [account,{name,portfolioId}] of Object.entries(CLOUD_ACCOUNTS)){
    cashId++;const cash={id:cashId,value:100,currency:{code:'USD'},portfolio:{id:portfolioId,name}};
    const p={performance:{report:{portfolio_id:portfolioId,start_date:date,end_date:date,include_sales:false,portfolio_tz_name:'America/New_York',currency:{code:'USD'},value:100,holdings:[],cash_accounts:[cash]}},holdings:{holdings:[]},cashAccounts:{cash_accounts:[{id:cashId,portfolio_id:portfolioId,currency:'USD',portfolio_currency:'USD',date,balance:100,balance_in_portfolio_currency:100}]},cashTransactions:{[cashId]:{cash_account_transactions:[]}},trades:{trades:[]},previousPerformance:{report:{portfolio_id:portfolioId,end_date:reportAddDays(date,-1),currency:{code:'USD'},cash_accounts:[cash]}},cashLedgerHistory:{[cashId]:{cash_account_transactions:[{id:1,cash_account_id:cashId,date_time:reportAddDays(date,-1)+'T00:00:00Z',amount:0,balance:100,cash_account_transaction_type:{name:'FEE'}}]}}};
    if(account==='webull')p.managementTrades={trades:[]};
    for(const key of ['performance','cashAccounts','previousPerformance'])p[key]=parseSourceJson(JSON.stringify(p[key]));
    for(const key of ['cashTransactions','cashLedgerHistory'])p[key]=Object.fromEntries(Object.entries(p[key]).map(([id,value])=>[id,parseSourceJson(JSON.stringify(value))]));
    result[account]=p;
  }
  return result;
}
function state(plan,checkedAt='2026-10-25T01:00:00Z'){
  const data=Buffer.from(JSON.stringify({enc:true,v:3,data:Buffer.alloc(64).toString('base64')}));
  return {mainSha:'a'.repeat(40),finalMainSha:'a'.repeat(40),data,pending:false,health:{schema:HEALTH_SCHEMA,checkedAt,targetDate:plan.accountingThrough,sourceDates:{schwab:plan.accountingThrough,webull:plan.accountingThrough,benchmark:plan.priceThrough},outcome:'updated',errorCode:null,dataSha256:crypto.createHash('sha256').update(data).digest('hex')}};
}
test('IB period retry is bounded by fixed schedule, candidate wait and original freshness',async()=>{
  const plan=weeklyReportPlan('2026-10-23'),now=new Date('2026-10-25T01:15Z'),s=state(plan,'2026-10-24T16:05Z');
  const run=id=>({id,path:'.github/workflows/fee-cloud-producer.yml',head_branch:'main',head_sha:'a'.repeat(40),event:'schedule',created_at:'2026-10-24T16:00Z'});
  const args={plan,now,ibEnabled:true,currentRunId:'2',readState:async()=>s,readRetryRuns:async()=>[run(1),run(2)]};
  assert.equal((await reportPublicationPreflight(args)).reasonCode,'IB_BOUNDED_SAME_PERIOD_RECHECK');
  assert.equal((await reportPublicationPreflight({...args,readRetryRuns:async()=>[run(1),run(2),run(3)]})).outcome,'already-published');
  assert.equal((await reportPublicationPreflight({...args,readState:async()=>({...s,pending:true})})).outcome,'candidate-pending');
  assert.equal((await reportPublicationPreflight({...args,readRetryRuns:async()=>{throw Error('private-canary');}})).outcome,'already-published');
  assert.equal((await reportPublicationPreflight({...args,now:new Date('2026-10-26T01:15Z')})).outcome,'already-published');
  assert.equal((await reportPublicationPreflight({...args,ibEnabled:false,readRetryRuns:async()=>assert.fail('disabled must not list runs')})).outcome,'already-published');
  for(const runs of [[],[run(1),run(1)],[{...run(1),path:'other'}],[{...run(1),head_branch:'other'}],[{...run(1),created_at:'2026-10-24T15:00Z'}]])assert.equal(periodIbRetryAllowed({runs,scheduledAt:plan.scheduledAt,now,currentRunId:2}),false);
  // A refreshed second health receipt cannot reset the fixed run budget.
  assert.equal((await reportPublicationPreflight({...args,readState:async()=>state(plan,'2026-10-25T01:00Z'),currentRunId:'3',readRetryRuns:async()=>[run(1),run(2),run(3)]})).outcome,'already-published');
});
test('IB retry metadata uses one public fixed route, bounded complete pages, no secrets or logs',async()=>{
  const workflow=fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml',import.meta.url),'utf8');
  assert.match(workflow.slice(workflow.indexOf('  period:'),workflow.indexOf('  produce:')),/IB_MANAGER_READ_ENABLED: 'true'/);
  const now=new Date('2026-10-25T01:15Z');let calls=0;
  const response=(url,value)=>{const r=new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;};
  const fetchImpl=async(url,init)=>{calls++;assert.match(url,/^https:\/\/api.github.com\/repos\/huanwujoy-crypto\/fee-console\/actions\/workflows\/fee-cloud-producer.yml\/runs\?/);assert.equal(init.headers.Authorization,undefined);assert.equal(init.redirect,'error');return response(url,{total_count:0,workflow_runs:[]});};
  assert.deepEqual(await readPeriodRetryRuns({scheduledAt:'2026-10-25T00:00:00+08:00',now,fetchImpl}),[]);assert.equal(calls,1);
  await assert.rejects(readPeriodRetryRuns({scheduledAt:'2026-10-25T00:00:00+08:00',now,fetchImpl:async url=>response(url,{total_count:101,workflow_runs:[]})}),/IB_RETRY_METADATA/);
});
test('required IB period publication rejects absent configuration before any source or economic read',async()=>{
  const prior=process.env.IB_MANAGER_READ_ENABLED;delete process.env.IB_MANAGER_READ_ENABLED;
  try{
    let calls=0;const forbidden=async()=>{calls++;assert.fail('financial IO must not start');};
    await assert.rejects(produceReportPeriod({plan:dailyReportPlan('2026-11-02',['NYSE','NASDAQ']),now:new Date('2026-11-03T04:00:00Z'),requireIb:true,readOnce:forbidden,ibReader:{readStable:forbidden},fetchEconomic:forbidden}),/^Error: FEE_CLOUD_IB_CONFIG$/);
    assert.equal(calls,0);
    const workflow=fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml',import.meta.url),'utf8');
    assert.ok(workflow.indexOf('Require Jenny IB configuration before financial access')<workflow.indexOf('Exchange the trusted workflow identity'));
    const cli=fs.readFileSync(new URL('./fee-report-producer.mjs',import.meta.url),'utf8');
    assert.match(cli,/const result=await produceReportPeriod\(\{plan,reviewedSyncDate,[^\n]*requireIb:true/);
  }finally{if(prior===undefined)delete process.env.IB_MANAGER_READ_ENABLED;else process.env.IB_MANAGER_READ_ENABLED=prior;}
});
test('same-period IB recheck forbids any fee, benchmark, ledger, report lock or unknown field change',()=>{
  const before={daily:[{d:'2026-10-23',schwab:100,webull:100,spy:100}],feeCalculationReceipt:{receiptId:'a'.repeat(64)},feeReportMonthLocks:{schema:'synthetic'},feeReportPublication:{reportId:'b'.repeat(64)},flowsAuto:[],privateEconomic:{version:4}};
  assert.doesNotThrow(()=>assertPeriodIbRecheckUnchanged(before,{...before,ibManagerSourceStatus:{state:'pending'},updatedAt:'2026-10-25T01:00Z'}));
  for(const change of [x=>x.daily[0].schwab++,x=>x.daily[0].spy++,x=>x.feeCalculationReceipt.receiptId='b'.repeat(64),x=>x.feeReportMonthLocks.schema='changed',x=>x.feeReportPublication.reportId='c'.repeat(64),x=>x.flowsAuto.push({}),x=>x.privateEconomic.version=5,x=>x.ibManagerArbitrary='must not escape strict allowlist']){
    const after=structuredClone(before);change(after);assert.throws(()=>assertPeriodIbRecheckUnchanged(before,after),/IB_RECHECK_CHANGED_FEE_DATA/);
  }
});
test('closed sessions carry only the last reviewed common close, without repeating dividends',()=>{
  assert.deepEqual(periodBenchmark(cache,'2026-10-24'),{sourceDate:'2026-10-23',state:'closed',spy:101,spyd:0,qqq:202,qqqd:0});
  assert.equal(periodBenchmark(cache,'2026-10-23').spyd,1);
  assert.throws(()=>periodBenchmark(cache,'2026-10-26'),/BENCHMARK_PENDING/);
});
test('whole range is double-read in order; identical end-day alone cannot hide an earlier correction',async()=>{
  const dates=['2026-10-22','2026-10-23'],calls=[];
  const out=await captureReportRange({dates,cache,readOnce:async d=>{calls.push(d);return cashOnly(d);}});
  assert.deepEqual(calls,[...dates,...dates]);assert.equal(out.length,2);assert.equal(out[0].flows.length,0);
  let n=0;
  await assert.rejects(captureReportRange({dates,cache,readOnce:async d=>{
    const raw=cashOnly(d);
    if(++n===3){
      const instrument={id:500,code:'SYNTH',market_code:'NYSE',currency_code:'USD'},portfolio={id:CLOUD_ACCOUNTS.schwab.portfolioId,name:CLOUD_ACCOUNTS.schwab.name};
      const holding={id:500,quantity:1,value:1,valid_position:true,instrument,instrument_currency:{code:'USD'},portfolio};
      raw.schwab.performance.report.holdings=[holding];raw.schwab.performance.report.value=101;
      raw.schwab.performance=parseSourceJson(JSON.stringify(raw.schwab.performance));
      raw.schwab.holdings={holdings:[{...holding,inception_date:reportAddDays(d,-1)}]};
    }
    return raw;
  }}),/FEE_REPORT_SOURCE_UNSTABLE/);
  await assert.rejects(captureReportRange({dates:['2026-10-22','2026-10-24'],cache,readOnce:async()=>assert.fail('gap must not read')}),/RANGE/);
});
test('weekly coverage stays valid between reports without weakening fresh candidate health',()=>{
  const p=weeklyReportPlan('2026-10-23'),s=state(p),now=new Date('2026-10-30T06:00Z');
  assert.equal(publishedReportMatches(s,p,now),true);assert.ok(validateHealth(s.health,{now}).includes('health receipt age'));
  for(const mutate of [s=>s.health.dataSha256='b'.repeat(64),s=>s.finalMainSha='b'.repeat(40),s=>s.health.checkedAt='2026-10-24T12:00Z',s=>s.health.sourceDates.webull='2026-10-22',s=>s.data=Buffer.from('{}')]){const bad=state(p);mutate(bad);assert.equal(publishedReportMatches(bad,p,now),false);}
  const month=monthlyReportPlan('2026-10'),early=state(month,'2026-10-31T22:00Z');
  assert.deepEqual(validateHealth(early.health,{now:new Date(early.health.checkedAt)}),[]);
  assert.equal(publishedReportMatches(early,month,new Date('2026-11-01T06:00Z')),false);
  assert.equal(publishedReportMatches(state(month,'2026-11-01T06:00Z'),month,new Date('2026-11-01T07:00Z')),true);
});
test('public preflight deduplicates exact accounting target, waits for incomplete month and never rolls back',async()=>{
  const plan=weeklyReportPlan('2026-10-23');let reads=0;
  assert.equal((await reportPublicationPreflight({plan,now:new Date('2026-10-26T00:00Z'),readState:async()=>{reads++;return state(plan);}})).outcome,'already-published');assert.equal(reads,1);
  const old=state(weeklyReportPlan('2026-10-16'),'2026-10-18T01:00Z');
  assert.equal((await reportPublicationPreflight({plan,now:new Date('2026-10-26T00:00Z'),readState:async()=>old})).outcome,'produce');
  assert.equal((await reportPublicationPreflight({plan,now:new Date('2026-10-26T00:00Z'),readState:async()=>({...old,pending:true})})).outcome,'candidate-pending');
  const monthly=monthlyReportPlan('2026-10');
  assert.equal((await reportPublicationPreflight({plan:monthly,now:new Date('2026-10-31T16:00Z'),readState:async()=>state(plan)})).reasonCode,'ACCOUNTING_DAY_NOT_COMPLETE');
  await assert.rejects(reportPublicationPreflight({plan,now:new Date('2026-11-02T00:00Z'),readState:async()=>state(monthly,'2026-11-01T06:00Z')}),/HISTORY_AHEAD/);
  assert.equal(explicitReportPlan('weekly','2026-07-31').kind,'weekly-monthly');
  assert.throws(()=>explicitReportPlan('monthly','2026-10-23'),/TARGET/);
  assert.equal((await reportPublicationPreflight({plan,now:new Date('2026-10-30T00:00Z'),readState:async()=>old})).outcome,'recovery-required');
});
test('period watchdog accepts existing cycle coverage but rejects missing publication with explicit offline attempt metadata',async t=>{
  let calls=0;const priorFetch=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{
    calls++;assert.match(url,/^https:\/\/api\.github\.com\/repos\/huanwujoy-crypto\/fee-console\/actions\/workflows\/fee-cloud-producer\.yml\/runs\?/);
    assert.equal(init.method,'GET');assert.equal(init.headers.Authorization,undefined);assert.equal(init.redirect,'error');
    const r=new Response(JSON.stringify({total_count:0,workflow_runs:[]}),{headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;
  };t.after(()=>globalThis.fetch=priorFetch);
  const p=weeklyReportPlan('2026-10-23');
  assert.equal((await reportPublicationWatch({...state(p),now:new Date('2026-10-28T00:00Z')})).outcome,'already-published');
  assert.equal(calls,0);
  await assert.rejects(reportPublicationWatch({...state(weeklyReportPlan('2026-10-16'),'2026-10-18T00:00Z'),now:new Date('2026-10-26T00:00Z')}),/PUBLISHED_PERIOD_MISSING/);
  assert.equal(calls,1);
});
test('real period preflight CLI makes only public main GETs and never enters financial sources',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-period-gate-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const s=state(weeklyReportPlan('2026-10-23')),trace=path.join(dir,'trace.json'),preload=path.join(dir,'public-preload.mjs');
  fs.writeFileSync(preload,`import fs from 'node:fs';const D=Date,now=D.parse('2026-10-26T06:00:00Z');globalThis.Date=class extends D{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}};
    const calls=[],data=${JSON.stringify(s.data.toString())},health=${JSON.stringify(s.health)};
    globalThis.fetch=async(url,init={})=>{url=String(url);calls.push(url);fs.writeFileSync(${JSON.stringify(trace)},JSON.stringify(calls));if(init.method&&init.method!=='GET')throw Error('unexpected method');
    const prefix='https://api.github.com/repos/huanwujoy-crypto/fee-console/';if(!url.startsWith(prefix))throw Error('financial or unknown route refused');const route=url.slice(prefix.length);let value;
    if(route==='git/ref/heads/main')value={object:{sha:'a'.repeat(40)}};else if(route.startsWith('contents/')){const text=route.startsWith('contents/data.json?')?data:route.startsWith('contents/fee-data-health.json?')?JSON.stringify(health):null;if(text===null)throw Error('unknown public file');value={type:'file',encoding:'base64',size:Buffer.byteLength(text),content:Buffer.from(text).toString('base64')};}else if(route.startsWith('git/matching-refs/heads/'))value=[];else throw Error('unknown public route');
    const response=new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});Object.defineProperty(response,'url',{value:url});return response;};`);
  const r=spawnSync(process.execPath,['--import',preload,new URL('./fee-report-producer.mjs',import.meta.url).pathname,'--mode=preflight','--report-kind=weekly','--report-target=2026-10-23'],{encoding:'utf8',env:{PATH:process.env.PATH,FEE_DATA_KEY:'must-not-be-used',FEE_ECON_GIST_ID:'must-not-be-used',FEE_CLOUD_SHARESIGHT_CLIENT_ID:'must-not-be-used',FEE_CLOUD_SHARESIGHT_CLIENT_SECRET:'must-not-be-used'}});
  assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).outcome,'already-published');assert.doesNotMatch(r.stdout,/must-not-be-used|"enc"|"data"/);
  const calls=JSON.parse(fs.readFileSync(trace));assert.ok(calls.length>=4);assert.ok(calls.every(u=>u.startsWith('https://api.github.com/repos/huanwujoy-crypto/fee-console/')));
});
test('actual recurring daily CLI freezes tomorrow target with public metadata only and fails before financial access on wrong activation or main',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-daily-gate-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const s=state(dailyReportPlan('2026-11-02',['NYSE','NASDAQ']),'2026-11-03T03:47:41Z'),trace=path.join(dir,'trace.json'),preload=path.join(dir,'preload.mjs');
 fs.writeFileSync(preload,`import fs from 'node:fs';const D=Date,now=D.parse('2026-11-04T02:00:00Z');globalThis.Date=class extends D{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}};
 const calls=[],data=${JSON.stringify(s.data.toString())},health=${JSON.stringify(s.health)};globalThis.fetch=async(url,init={})=>{url=String(url);calls.push(url);fs.writeFileSync(${JSON.stringify(trace)},JSON.stringify(calls));if(init.method&&init.method!=='GET'||init.headers?.Authorization)throw Error('unexpected credential or method');
 const prefix='https://api.github.com/repos/huanwujoy-crypto/fee-console/';if(!url.startsWith(prefix))throw Error('financial route refused');const route=url.slice(prefix.length);let value;
 if(route==='git/ref/heads/main')value={object:{sha:process.env.SYNTHETIC_MAIN||'a'.repeat(40)}};else if(route.startsWith('contents/')){const text=route.startsWith('contents/data.json?')?data:route.startsWith('contents/fee-data-health.json?')?JSON.stringify(health):null;if(text===null)throw Error('unknown file');value={type:'file',encoding:'base64',size:Buffer.byteLength(text),content:Buffer.from(text).toString('base64')};}else if(route.startsWith('git/matching-refs/heads/'))value=[];else if(route.startsWith('actions/workflows/fee-cloud-producer.yml/runs?'))value={total_count:0,workflow_runs:[]};else throw Error('unknown route');
 const response=new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});Object.defineProperty(response,'url',{value:url});return response;};`);
 const env={PATH:process.env.PATH,GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'huanwujoy-crypto/fee-console',GITHUB_REF:'refs/heads/main',GITHUB_SHA:'a'.repeat(40),GITHUB_EVENT_NAME:'schedule',GITHUB_RUN_ATTEMPT:'1',GITHUB_RUN_ID:'1001',FEE_REPORT_DAILY_ENABLED:'true',FEE_REPORT_PERIODS_ENABLED:'true',FEE_CLOUD_MODE:'publish',FEE_REPORT_MARKETS:'NYSE,NASDAQ',IB_MANAGER_READ_ENABLED:'true',FEE_DATA_KEY:'synthetic-secret-canary'};
 const invoke=change=>spawnSync(process.execPath,['--import',preload,new URL('./fee-report-producer.mjs',import.meta.url).pathname,'--mode=preflight'],{encoding:'utf8',env:{...env,...change},timeout:10000});
 const ok=invoke({});assert.equal(ok.status,0,ok.stderr);const decision=JSON.parse(ok.stdout);assert.equal(decision.outcome,'produce');assert.equal(decision.plan.accountingThrough,'2026-11-03');assert.equal(decision.plan.periodFrom,'2026-11-03');assert.equal(decision.mainSha,env.GITHUB_SHA);assert.doesNotMatch(ok.stdout,/synthetic-secret-canary|"enc"/);
 assert(JSON.parse(fs.readFileSync(trace)).some(u=>u.includes('/actions/workflows/fee-cloud-producer.yml/runs?')));
 const changed=invoke({SYNTHETIC_MAIN:'b'.repeat(40)});assert.equal(changed.status,1);assert.equal(changed.stderr.trim(),'FEE_REPORT_DAILY_SCOPE');
 fs.rmSync(trace);const disabled=invoke({FEE_REPORT_DAILY_ENABLED:''});assert.equal(disabled.status,1);assert.equal(disabled.stderr.trim(),'FEE_REPORT_DAILY_SCOPE');assert.equal(fs.existsSync(trace),false);
});
test('period producer uses actual sole writer, receipt reporter and health; original ciphertext and fees stay intact',async t=>{
 for(const scenario of ['weekly','reviewed','reference'])await t.test(scenario,async t=>{
  const reviewed=scenario!=='weekly',reference=scenario==='reference';
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-period-synthetic-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const root=path.join(dir,'checkout');fs.mkdirSync(root,{mode:0o700});fs.cpSync(new URL('.',import.meta.url),path.join(root,'scripts'),{recursive:true});
  fs.mkdirSync(path.join(root,'claude'));fs.copyFileSync(new URL('../claude/fee-style-mapping.json',import.meta.url),path.join(root,'claude/fee-style-mapping.json'));
  const key=crypto.randomBytes(32),encrypt=(o,v)=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);return JSON.stringify({enc:true,v,data:Buffer.concat([iv,c.update(JSON.stringify(o)),c.final(),c.getAuthTag()]).toString('base64')});};
  const data={daily:[{d:'2026-10-21',schwab:100,webull:100,cash:200,stock:0,other:0,spy:100,qqq:200,bd:'2026-10-21',bstate:'session',acctCash:{schwab:100,webull:100}}],flowsAuto:[],flowsUnresolved:[],status:{asOf:'2026-10-21',provisional:false,calibrated:false,unresolvedCount:0,notes:[],splitDelta:0}};
  const original=encrypt(data,3);fs.writeFileSync(path.join(root,'data.json'),original);
  const econ=path.join(dir,'econ.json');fs.writeFileSync(econ,encrypt({v:4,settings:{start:'2026-10-21',mgmt:2,carry:20},accounts:[{id:'schwab',opening:100},{id:'webull',opening:100}],months:[],fees:[]},4),{mode:0o600});
  const benchmarkFile=path.join(dir,'bench.json');fs.writeFileSync(benchmarkFile,JSON.stringify(cache));
  const snapshots=path.join(dir,'snapshots.json');fs.writeFileSync(snapshots,JSON.stringify(Object.fromEntries(['2026-10-22','2026-10-23'].map(d=>{
    const raw=cashOnly(d);
    if(reference)for(const p of Object.values(raw)){
      delete p.previousPerformance;delete p.cashLedgerHistory;
      const cash=p.cashAccounts.cash_accounts[0];cash.balance=cash.balance_in_portfolio_currency=777;
      p.cashTransactions[cash.id]={cash_account_transactions:[{id:cash.id+1000,cash_account_id:cash.id,date_time:d+'T12:00:00Z',amount:7,trade_id:9000+cash.id,cash_account_transaction_type:{name:'DEPOSIT'}}]};
    }
    return[d,raw];
  }))),{mode:0o600});
  const script=path.join(root,'exercise.mjs');fs.writeFileSync(script,`
    import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
    import {produceReportPeriod} from './scripts/fee-report-producer.mjs';import {weeklyReportPlan,dailyReportPlan} from './scripts/fee-report-period.mjs';import {parseSourceJson} from './scripts/fee-cloud-source.mjs';import {decryptCandidate} from './scripts/fee-cloud-producer.mjs';import {validateFeeCalculationReceiptWithEcon} from './scripts/fee-receipt-core.mjs';
    const plan=${reviewed}?dailyReportPlan('2026-10-23',['NYSE','NASDAQ'],{periodFrom:'2026-10-22',reviewedSyncDate:'2026-10-23'}):weeklyReportPlan('2026-10-23'),reviewedSyncDate=${reviewed}?'2026-10-23':null;
    const dir=path.dirname(process.env.SYNTHETIC_SNAPSHOTS),snapshots=JSON.parse(fs.readFileSync(process.env.SYNTHETIC_SNAPSHOTS)),out=path.join(dir,'out');fs.mkdirSync(out,{mode:0o700});let calls=0,checks=0,cleanups=0;
    const readOnce=async d=>{const raw=structuredClone(snapshots[d]);for(const p of Object.values(raw)){for(const key of ['performance','cashAccounts','previousPerformance'])if(p[key]!==undefined)p[key]=parseSourceJson(JSON.stringify(p[key]));for(const key of ['cashTransactions','cashLedgerHistory'])if(p[key]!==undefined)p[key]=Object.fromEntries(Object.entries(p[key]).map(([id,v])=>[id,parseSourceJson(JSON.stringify(v))]));}return raw;};
    const r=await produceReportPeriod({plan,reviewedSyncDate,outputDir:out,benchmarkFile:process.env.SYNTHETIC_BENCHMARK,readOnce:async d=>{calls++;return readOnce(d);},fetchEconomic:async()=>({envelopeVersion:4,sourcePath:process.env.FEE_ECON_FILE,async checkCurrent(){checks++;},cleanup(){cleanups++;}})});
    assert.equal(r.reconstructedDays,2);assert.equal(calls,4);assert.equal(checks,3);assert.equal(cleanups,1);assert.equal(fs.existsSync(path.join(out,'period-private')),false);
    const data=decryptCandidate(r.dataFile,process.env.FEE_DATA_KEY),econ={v:4,settings:{start:'2026-10-21',mgmt:2,carry:20},accounts:[{id:'schwab',opening:100},{id:'webull',opening:100}],months:[],fees:[]};
    assert.deepEqual(data.daily.map(p=>p.d),['2026-10-21','2026-10-22','2026-10-23']);assert.equal(data.feeReportPublication.plan.kind,${reviewed}?'daily':'weekly');assert.equal(data.feeCalculationReceipt.asOf,'2026-10-23');assert.deepEqual(data.feeCalculationReceipt.accountIds,['schwab','webull']);assert.equal(validateFeeCalculationReceiptWithEcon(data.feeCalculationReceipt,data,econ).ok,true);
    if(${reference}){
      for(const point of data.daily.slice(1)){
        assert.equal(point.sourceReference.schema,'fee-console.sharesight-reference.v1');assert.equal(point.sourceReference.cashHistoryReconstructed,false);
        assert.deepEqual(point.sourceReference.cashByAccount,{schwab:100,webull:100});assert.equal(point.cash,200);assert.equal(point.schwab+point.webull,200);
        assert.ok(point.sourceReference.warnings.includes('AUXILIARY_CASH_BALANCE_DIFF'));
      }
      assert.deepEqual(data.flowsAuto,[]);assert.deepEqual(data.flowsUnresolved,[]);
    }
    assert.equal(fs.statSync(r.dataFile).mode&0o777,0o600);assert.equal(fs.existsSync(r.healthFile),true);
    const repeatedOut=path.join(dir,'repeated');fs.mkdirSync(repeatedOut,{mode:0o700});
    const repeated=await produceReportPeriod({plan,reviewedSyncDate,sourceFile:r.dataFile,outputDir:repeatedOut,benchmarkFile:process.env.SYNTHETIC_BENCHMARK,readOnce,fetchEconomic:async()=>({envelopeVersion:4,sourcePath:process.env.FEE_ECON_FILE,async checkCurrent(){},cleanup(){}})});
    assert.equal(repeated.outcome,'no-op');assert.deepEqual(fs.readFileSync(repeated.dataFile),fs.readFileSync(r.dataFile));assert.deepEqual(decryptCandidate(repeated.dataFile,process.env.FEE_DATA_KEY).feeCalculationReceipt,data.feeCalculationReceipt);
    const failedOut=path.join(dir,'failed');fs.mkdirSync(failedOut,{mode:0o700});let failureChecks=0;
    await assert.rejects(produceReportPeriod({plan,reviewedSyncDate,outputDir:failedOut,benchmarkFile:process.env.SYNTHETIC_BENCHMARK,readOnce,fetchEconomic:async()=>({envelopeVersion:4,sourcePath:process.env.FEE_ECON_FILE,async checkCurrent(){if(++failureChecks===2)throw Error('synthetic economic revision changed');},cleanup(){}})}));
    assert.equal(fs.existsSync(path.join(failedOut,'data.json')),false);assert.equal(fs.existsSync(path.join(failedOut,'fee-data-health.json')),false);assert.equal(fs.existsSync(path.join(failedOut,'period-private')),false);console.log('SYNTHETIC_PERIOD_CANDIDATE_VERIFIED');
  `);
  // Isolated synthetic subprocess clock only; production has no clock/guard
  // override. Its real writer, reporter and health still enforce every window.
  const clockFile=path.join(dir,'synthetic-clock.mjs');fs.writeFileSync(clockFile,`const RealDate=Date;const now=RealDate.parse('${reviewed?'2026-10-24T00:40:00Z':'2026-10-26T06:00:00Z'}');globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};`);
  const r=spawnSync(process.execPath,[script],{encoding:'utf8',timeout:30000,env:{...process.env,NODE_OPTIONS:'--import='+clockFile,FEE_DATA_KEY:key.toString('base64url'),FEE_ECON_FILE:econ,IB_MANAGER_READ_ENABLED:'',FEE_STYLE_INPUT_FILE:'',FEE_MANAGEMENT_INPUT_FILE:'',SYNTHETIC_SNAPSHOTS:snapshots,SYNTHETIC_BENCHMARK:benchmarkFile}});
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/SYNTHETIC_PERIOD_CANDIDATE_VERIFIED/);assert.equal(fs.readFileSync(path.join(root,'data.json'),'utf8'),original);
 });
});

test('unresolved diagnostic survives the actual producer, period wrapper and workflow failure branch without private stderr',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-unresolved-path-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const root=path.join(dir,'checkout');fs.mkdirSync(root,{mode:0o700});fs.cpSync(new URL('.',import.meta.url),path.join(root,'scripts'),{recursive:true});
 fs.mkdirSync(path.join(root,'claude'));fs.copyFileSync(new URL('../claude/fee-style-mapping.json',import.meta.url),path.join(root,'claude/fee-style-mapping.json'));
 const key=crypto.randomBytes(32),encrypt=(o,v)=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);return JSON.stringify({enc:true,v,data:Buffer.concat([iv,c.update(JSON.stringify(o)),c.final(),c.getAuthTag()]).toString('base64')});};
 const original=encrypt({daily:[{d:'2026-10-20',schwab:100,webull:100,cash:200,stock:0,other:0,spy:100,qqq:200,bd:'2026-10-20',bstate:'session',acctCash:{schwab:100,webull:100}}],flowsAuto:[],flowsUnresolved:[],status:{asOf:'2026-10-20',provisional:false,calibrated:false,unresolvedCount:0,notes:[],splitDelta:0}},3);
 fs.writeFileSync(path.join(root,'data.json'),original,{mode:0o600});
 const econ=path.join(dir,'econ.json');fs.writeFileSync(econ,encrypt({v:4,settings:{start:'2026-10-20',mgmt:2,carry:20},accounts:[{id:'schwab',opening:100},{id:'webull',opening:100}],months:[],fees:[]},4),{mode:0o600});
 const benchmark=path.join(dir,'benchmark.json');fs.writeFileSync(benchmark,JSON.stringify({v:1,benchmarks:Object.fromEntries(Object.entries(cache.benchmarks).map(([k,v])=>[k,{...v,series:[{d:'2026-10-21',p:k==='spy'?100:200},...v.series]}]))}),{mode:0o600});
 const hidden='PRIVATE_CANARY amount=123456.78 account=opaque /private/path';
 const snapshots=path.join(dir,'snapshots.json');fs.writeFileSync(snapshots,JSON.stringify(Object.fromEntries(['2026-10-21','2026-10-22','2026-10-23'].map(d=>{
  const raw=cashOnly(d);if(d==='2026-10-22'){const cash=raw.webull.cashAccounts.cash_accounts[0];raw.webull.cashTransactions[cash.id]={cash_account_transactions:[{id:765432,cash_account_id:cash.id,date_time:d+'T12:00:00Z',amount:1,description:hidden,foreign_identifier:hidden,cash_account_transaction_type:{name:'DEPOSIT'}}]};}return[d,raw];
 }))),{mode:0o600});
 const script=path.join(root,'exercise.mjs');fs.writeFileSync(script,`
  import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
  import {produceReportPeriod,reportFailureCode} from './scripts/fee-report-producer.mjs';import {weeklyReportPlan} from './scripts/fee-report-period.mjs';import {parseSourceJson} from './scripts/fee-cloud-source.mjs';
  const dir=path.dirname(process.env.SYNTHETIC_SNAPSHOTS),snapshots=JSON.parse(fs.readFileSync(process.env.SYNTHETIC_SNAPSHOTS)),out=path.join(dir,'out');fs.mkdirSync(out,{mode:0o700});let reads=0,checks=0,cleanups=0;
  const readOnce=async d=>{reads++;const raw=structuredClone(snapshots[d]);for(const p of Object.values(raw)){for(const k of ['performance','cashAccounts','previousPerformance'])if(p[k])p[k]=parseSourceJson(JSON.stringify(p[k]));for(const k of ['cashTransactions','cashLedgerHistory'])if(p[k])p[k]=Object.fromEntries(Object.entries(p[k]).map(([id,v])=>[id,parseSourceJson(JSON.stringify(v))]));}return raw;};
  try{await produceReportPeriod({plan:weeklyReportPlan('2026-10-23'),outputDir:out,benchmarkFile:process.env.SYNTHETIC_BENCHMARK,readOnce,fetchEconomic:async()=>({envelopeVersion:4,sourcePath:process.env.FEE_ECON_FILE,async checkCurrent(){checks++;},cleanup(){cleanups++;}})});assert.fail('expected unresolved flow');}
  catch(error){assert.equal(reportFailureCode(error),'FEE_CLOUD_UNRESOLVED_FLOW');assert.equal(error.message,'FEE_CLOUD_UNRESOLVED_FLOW');assert.equal(Object.hasOwn(error,'cause'),false);assert.deepEqual(fs.readdirSync(out),[]);assert.equal(reads,6);assert.equal(checks,1);assert.equal(cleanups,1);console.error(reportFailureCode(error));process.exitCode=1;}
 `);
 const clock=path.join(dir,'clock.mjs');fs.writeFileSync(clock,`const RealDate=Date,now=RealDate.parse('2026-10-26T06:00:00Z');globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};let attempts=0;globalThis.fetch=async()=>{attempts++;throw Error('OFFLINE_UNMOCKED_FETCH_FORBIDDEN');};process.on('exit',()=>{if(attempts)process.exitCode=97;});`);
 const child=spawnSync(process.execPath,[script],{cwd:root,encoding:'utf8',timeout:30000,env:{...process.env,NODE_OPTIONS:[process.env.NODE_OPTIONS||'','--import='+clock].join(' ').trim(),GITHUB_RUN_ID:'123',GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ATTEMPT:'1',FEE_DATA_KEY:key.toString('base64url'),FEE_ECON_FILE:econ,IB_MANAGER_READ_ENABLED:'',FEE_STYLE_INPUT_FILE:'',FEE_MANAGEMENT_INPUT_FILE:'',SYNTHETIC_SNAPSHOTS:snapshots,SYNTHETIC_BENCHMARK:benchmark}});
 assert.equal(child.status,1,child.stderr);assert.equal(child.stdout,'');assert.equal(fs.readFileSync(path.join(root,'data.json'),'utf8'),original);
 assert.equal(child.stderr.trim().split('\n').length,2,child.stderr);assert.equal(child.stderr.trim().split('\n').at(-1),'FEE_CLOUD_UNRESOLVED_FLOW');assert.equal(child.stderr.includes(hidden),false);
 const projection=safeProducerFailureSummary(child.stderr);assert.ok(projection.diagnostic);assert.equal(projection.diagnostic.processingDate,'2026-10-22');assert.equal(projection.diagnostic.processingIndex,2);assert.equal(projection.diagnostic.reportTarget,'2026-10-23');
 assert.equal(projection.diagnostic.overflowCount,0);
 assert.deepEqual(projection.diagnostic.groups,[{flowDate:'2026-10-22',reasonCode:'BARE_DEPOSIT',origin:'NEW',count:1}]);
 assert.deepEqual(Object.keys(projection.diagnostic.facts).sort(),['tradePointer','holdingPointer','payoutPointer','principal','income','dateProof'].sort());
 for(const name of ['tradePointer','holdingPointer','payoutPointer'])assert.deepEqual(projection.diagnostic.facts[name],{true:0,false:1,unknown:0});
 for(const fact of Object.values(projection.diagnostic.facts))assert.equal(fact.true+fact.false+fact.unknown,projection.diagnostic.unresolvedCount);
 const workflow=fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml',import.meta.url),'utf8');
 const failureScript=workflow.match(/node --input-type=module - "\$error_file" <<'NODE'\n([\s\S]+?)\n          NODE/)[1];
 assert.doesNotMatch(failureScript,/console\.(?:log|error)\(privateStderr|process\.stdout\.write\(privateStderr/);assert.doesNotMatch(workflow,/tail -n 1 "\$error_file"/);
 const collapsed={...projection.diagnostic,unresolvedCount:33,overflowCount:33,groups:[{flowDate:'unknown',reasonCode:'UNKNOWN',origin:'UNKNOWN',count:33}],facts:Object.fromEntries(Object.keys(projection.diagnostic.facts).map(name=>[name,{true:0,false:0,unknown:33}]))};
 for(const [name,stderr,wantDiagnostic,wantCode='FEE_CLOUD_UNRESOLVED_FLOW']of [['valid','PRIVATE_CANARY raw account and stack\n'+child.stderr,true],['group-overflow',UNRESOLVED_FLOW_DIAGNOSTIC_PREFIX+JSON.stringify(collapsed)+'\nFEE_CLOUD_UNRESOLVED_FLOW\n',true],['duplicate',child.stderr.split('\n')[0]+'\n'+child.stderr,false],['invalid',UNRESOLVED_FLOW_DIAGNOSTIC_PREFIX+JSON.stringify({...projection.diagnostic,private:'PRIVATE_CANARY'})+'\nFEE_CLOUD_UNRESOLVED_FLOW\n',false],['code-canary','FEE_CLOUD_PRIVATE_CANARY\n',false,'FEE_CLOUD_FAILED'],['overflow','x'.repeat(65537)+'\nFEE_CLOUD_UNRESOLVED_FLOW\n',false,'FEE_CLOUD_FAILED']]){
  const privateFile=path.join(dir,name+'.stderr'),summary=path.join(dir,name+'.summary');fs.writeFileSync(privateFile,stderr,{mode:0o600});fs.writeFileSync(summary,'',{mode:0o600});
  const publicResult=spawnSync(process.execPath,['--input-type=module','-',privateFile],{cwd:new URL('..',import.meta.url),input:failureScript,encoding:'utf8',env:{...process.env,GITHUB_STEP_SUMMARY:summary}});
  assert.equal(publicResult.status,0,publicResult.stderr);assert.equal(publicResult.stderr,'');const publicText=publicResult.stdout+fs.readFileSync(summary,'utf8');assert.equal(publicText.includes('PRIVATE_CANARY'),false);assert.equal(publicText.includes('123456.78'),false);assert.equal(publicText.includes('/private/path'),false);
  assert.equal(publicResult.stdout.includes('fee-console.unresolved-flow-diagnostic.v1'),wantDiagnostic);assert.equal(publicResult.stdout.trim().split('\n').at(-1),wantCode);
  if(name==='group-overflow'){const displayed=JSON.parse(publicResult.stdout.split('\n')[0]);assert.equal(displayed.overflowCount,33);assert.equal(displayed.unresolvedCount,33);assert.equal(displayed.processingDate,'2026-10-22');assert.equal(displayed.processingIndex,2);assert.deepEqual(displayed.groups,collapsed.groups);}
 }
});

// Source-attempt budgets read public metadata only. All data is synthetic.
const budgetPlan=weeklyReportPlan('2026-10-30'),budgetNow=new Date('2026-11-01T06:00:00Z');
const budgetRun=(id=1)=>({id,path:'.github/workflows/fee-cloud-producer.yml',head_branch:'main',head_sha:'a'.repeat(40),event:'schedule',created_at:'2026-10-31T16:00:00Z'});
const budgetJob=(run,id=10,name='Produce weekly 2026-10-30')=>({id,run_id:run.id,head_sha:run.head_sha,name,status:'completed',conclusion:'failure',started_at:'2026-10-31T16:01:00Z'});
test('the exact read-only IB diagnostic leaves production attempts unchanged but cannot hide another source job',async()=>{
 const name='IB diagnostic 2026-11-04',r={...budgetRun(),event:'workflow_dispatch',display_title:name,actor:{id:283054367},run_attempt:1},j=budgetJob(r,31,name);
 assert.deepEqual(await readPeriodSourceAttempts({plan:budgetPlan,now:budgetNow,fetchImpl:budgetWire([r],[j])}),{attempts:0,inProgress:false});
 assert.deepEqual(await readPeriodSourceAttempts({plan:budgetPlan,now:budgetNow,fetchImpl:budgetWire([r],[j,budgetJob(r)])}),{attempts:1,inProgress:false});
 for(const change of [x=>x.event='schedule',x=>x.display_title='other',x=>x.actor.id=1,x=>x.run_attempt=2]){const bad=structuredClone(r);change(bad);await assert.rejects(readPeriodSourceAttempts({plan:budgetPlan,now:budgetNow,fetchImpl:budgetWire([bad],[j])}),/SOURCE_ATTEMPT_METADATA/);}
 const active={...j,status:'in_progress',conclusion:null};assert.deepEqual(await readPeriodSourceAttempts({plan:budgetPlan,now:budgetNow,fetchImpl:budgetWire([r],[active])}),{attempts:0,inProgress:false});
});
test('Nov6 read-only diagnostic preserves ordinary budgets and still counts every real source job',async()=>{
 const name='IB diagnostic 2026-11-06',r={...budgetRun(),event:'workflow_dispatch',display_title:name,actor:{id:283054367},run_attempt:1},j=budgetJob(r,31,name);
 const read=jobs=>readPeriodSourceAttempts({plan:budgetPlan,now:budgetNow,fetchImpl:budgetWire([r],jobs)});
 for(const conclusion of ['failure','success','timed_out','cancelled'])assert.deepEqual(await read([{...j,conclusion}]),{attempts:0,inProgress:false});
 assert.deepEqual(await read([{...j,status:'in_progress',conclusion:null}]),{attempts:0,inProgress:false});
 assert.deepEqual(await read([j,budgetJob(r)]),{attempts:1,inProgress:false});
 assert.deepEqual(await read([j,budgetJob(r),budgetJob(r,11,'produce')]),{attempts:2,inProgress:false});
 assert.deepEqual(await read([j,{...budgetJob(r),status:'in_progress',conclusion:null}]),{attempts:1,inProgress:true});
});
test('Nov6 diagnostic allowance rejects unknown names and retains all run and job identity checks',async()=>{
 const name='IB diagnostic 2026-11-06',r={...budgetRun(),event:'workflow_dispatch',display_title:name,actor:{id:283054367},run_attempt:1},j=budgetJob(r,31,name);
 for(const change of [x=>x.event='schedule',x=>x.display_title='IB diagnostic 2026-11-04',x=>x.actor.id=1,x=>x.actor=null,x=>x.run_attempt=2,x=>delete x.run_attempt,x=>x.head_branch='other',x=>x.path='other']){
  const bad=structuredClone(r);change(bad);await assert.rejects(readPeriodSourceAttempts({plan:budgetPlan,now:budgetNow,fetchImpl:budgetWire([bad],[j])}),/SOURCE_ATTEMPT_METADATA/);
 }
 for(const name of ['IB diagnostic 2026-11-05','IB diagnostic 2026-11-07','IB diagnostic 2026-11-06 ','ib diagnostic 2026-11-06','IB diagnostic 2026-11-06 extra'])await assert.rejects(readPeriodSourceAttempts({plan:budgetPlan,now:budgetNow,fetchImpl:budgetWire([{...r,display_title:name}],[{...j,name}])}),/SOURCE_ATTEMPT_METADATA/);
 for(const jobs of [[{...j,run_id:99}],[{...j,head_sha:'b'.repeat(40)}],[{...j,id:0}],[j,{...j}],[{...j,status:'unknown'}]])await assert.rejects(readPeriodSourceAttempts({plan:budgetPlan,now:budgetNow,fetchImpl:budgetWire([r],jobs)}),/SOURCE_ATTEMPT_METADATA/);
});
function budgetWire(runs,jobs,mutate=()=>{}){return async(url,init)=>{assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,undefined);assert.ok(!url.includes('/logs'));let value;if(url.includes('/workflows/fee-cloud-producer.yml/runs?'))value={total_count:runs.length,workflow_runs:runs};else{assert.match(url,/\/runs\/\d+\/jobs\?filter=all&per_page=100$/);value={total_count:jobs.length,jobs};}value=structuredClone(value);mutate(value,url);const r=new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;};}
test('source budget counts all source job attempts, ignores public and once-control jobs and other cutoff, and excludes current run',async()=>{const r=budgetRun(),p={...budgetJob(r,12,'period'),conclusion:'success'},different=budgetJob(r,13,'Produce monthly 2026-10-31'),controls=['once-admit','once-finish','ratio-preflight','ratio'].map((name,i)=>({...budgetJob(r,20+i,name),conclusion:'success'}));assert.deepEqual(await readPeriodSourceAttempts({plan:budgetPlan,now:budgetNow,fetchImpl:budgetWire([r],[p,different,...controls,budgetJob(r)])}),{attempts:1,inProgress:false});assert.deepEqual(await readPeriodSourceAttempts({plan:budgetPlan,now:budgetNow,currentRunId:1,fetchImpl:budgetWire([r],[])}),{attempts:0,inProgress:false});});
test('a rerun with two failed source jobs consumes two attempts, and an old unlabelled source is conservatively counted',async()=>{const r=budgetRun();assert.deepEqual(await readPeriodSourceAttempts({plan:budgetPlan,now:budgetNow,fetchImpl:budgetWire([r],[budgetJob(r),budgetJob(r,11,'produce')])}),{attempts:2,inProgress:false});});
test('queued or active source reserves the budget, while a skipped source job never entered finance',async()=>{const r=budgetRun(),j={...budgetJob(r),status:'queued',conclusion:null,started_at:null};assert.deepEqual(await readPeriodSourceAttempts({plan:budgetPlan,now:budgetNow,fetchImpl:budgetWire([r],[j])}),{attempts:1,inProgress:true});assert.deepEqual(await readPeriodSourceAttempts({plan:budgetPlan,now:budgetNow,fetchImpl:budgetWire([r],[{...j,status:'completed',conclusion:'skipped'}])}),{attempts:0,inProgress:false});});
test('source budget rejects partial metadata, duplicate jobs, wrong run/head/branch, changed route, future time and unknown job',async()=>{const r=budgetRun();for(const mutate of [v=>{v.total_count++;},v=>{if(v.workflow_runs)v.workflow_runs[0].head_branch='other';},v=>{if(v.workflow_runs)v.workflow_runs[0].path='other';},v=>{if(v.jobs)v.jobs[0].head_sha='b'.repeat(40);},v=>{if(v.jobs)v.jobs[0].run_id=99;},v=>{if(v.jobs)v.jobs[0].name='unknown-source';},v=>{if(v.jobs)v.jobs[0].started_at='2099-01-01T00:00:00Z';},v=>{if(v.jobs){v.jobs.push(v.jobs[0]);v.total_count++;}}])await assert.rejects(readPeriodSourceAttempts({plan:budgetPlan,now:budgetNow,fetchImpl:budgetWire([r],[budgetJob(r)],mutate)}),/SOURCE_ATTEMPT_METADATA/);});
test('preflight blocks exhausted, unknown, active and rerun source budgets without calling a financial reader',async()=>{const old=state(weeklyReportPlan('2026-10-23'),'2026-10-27T01:00:00Z'),args={plan:budgetPlan,now:budgetNow,readState:async()=>old};for(const [budget,reason] of [[{attempts:0,inProgress:false},null],[{attempts:1,inProgress:false},null],[{attempts:2,inProgress:false},'REPORT_SOURCE_ATTEMPT_BUDGET_EXHAUSTED'],[{attempts:1,inProgress:true},'REPORT_SOURCE_RUN_IN_PROGRESS'],[{attempts:-1,inProgress:false},'REPORT_SOURCE_ATTEMPT_METADATA_UNVERIFIED']]){const result=await nativeReportPreflight({...args,readSourceAttempts:async()=>budget});assert.equal(result.outcome,reason?'waiting':'produce');assert.equal(result.reasonCode||null,reason);}assert.equal((await nativeReportPreflight({...args,readSourceAttempts:async()=>{throw Error('private-canary');}})).reasonCode,'REPORT_SOURCE_ATTEMPT_METADATA_UNVERIFIED');assert.equal((await nativeReportPreflight({...args,runAttempt:'2',readSourceAttempts:async()=>assert.fail('rerun must stop before metadata')})).reasonCode,'REPORT_SOURCE_RERUN_NOT_ALLOWED');});
test('source budget never changes an already published fee receipt or incomplete accounting day',async()=>{const p=weeklyReportPlan('2026-10-23');assert.equal((await nativeReportPreflight({plan:p,now:new Date('2026-10-27T01:00Z'),ibEnabled:false,readState:async()=>state(p),readSourceAttempts:()=>assert.fail('covered fee must not query attempts')})).outcome,'already-published');});

test('reviewed daily entry requires exact completed-sync target and preserves source attempts, stale and pending gates',async()=>{
 const target='2026-10-28',now=new Date('2026-10-29T08:40:00+08:00'),markets=['NYSE','NASDAQ'];
 const args={targetDate:target,reviewedSyncDate:target,now,markets,ibEnabled:false,readState:async()=>state(weeklyReportPlan('2026-10-23')),readSourceAttempts:async()=>({attempts:0,inProgress:false})};
 const result=await dailyPublicationPreflight(args);assert.equal(result.outcome,'produce');assert.equal(result.plan.accountingThrough,target);assert.equal(result.plan.periodFrom,'2026-10-24');
 assert.equal((await dailyPublicationPreflight({...args,reviewedSyncDate:null})).reasonCode,'REPORT_NOT_DUE');
 for(const reviewedSyncDate of ['',true,'2026-10-27'])await assert.rejects(dailyPublicationPreflight({...args,reviewedSyncDate,readState:()=>assert.fail('wrong confirmation cannot read state')}));
 assert.equal((await dailyPublicationPreflight({...args,now:new Date('2026-10-29T03:00:00+08:00'),readState:()=>assert.fail('open market cannot read state')})).reasonCode,'SOURCE_DAY_NOT_CLOSED');
 assert.equal((await dailyPublicationPreflight({...args,readSourceAttempts:async()=>({attempts:2,inProgress:false})})).reasonCode,'REPORT_SOURCE_ATTEMPT_BUDGET_EXHAUSTED');
 assert.equal((await dailyPublicationPreflight({...args,runAttempt:'2'})).reasonCode,'REPORT_SOURCE_RERUN_NOT_ALLOWED');
 assert.equal((await dailyPublicationPreflight({...args,readState:async()=>({...state(weeklyReportPlan('2026-10-23')),pending:true})})).outcome,'candidate-pending');
 assert.equal((await dailyPublicationPreflight({...args,now:new Date('2026-11-03T08:40:00+08:00')})).reasonCode,'REPORT_TARGET_OUTSIDE_PROMOTION_WINDOW');
 await assert.rejects(produceReportPeriod({plan:result.plan,now,fetchEconomic:()=>assert.fail('missing confirmation before finance')}),/MANUAL_SYNC_CONFIRMATION/);
 await assert.rejects(nativeReportPreflight({plan:result.plan,now,readState:()=>assert.fail('missing confirmation before public state')}),/MANUAL_SYNC_CONFIRMATION/);
 const broken=cashOnly(target);broken.webull.performance.report.end_date='2026-10-27';
 await assert.rejects(captureReportRange({dates:[target],cache:{v:1,benchmarks:{spy:{symbol:'SPY',currency:'USD',exchange:'NYSEArca',series:[{d:target,p:100}]},qqq:{symbol:'QQQ',currency:'USD',exchange:'NasdaqGS',series:[{d:target,p:200}]}}},readOnce:async()=>broken}),/PERFORMANCE_IDENTITY/);
});

test('completed-sync start admits the exact target before09 and leaves the scheduled fallback unchanged',async()=>{
 const target='2026-11-05',markets=['NYSE','NASDAQ'],now=new Date('2026-11-06T07:30:00+08:00');
 const prior=state(dailyReportPlan('2026-11-04',markets),'2026-11-05T05:45:00Z');
 const args={targetDate:target,reviewedSyncDate:target,markets,now,ibEnabled:true,runAttempt:'1',readState:async()=>prior,readSourceAttempts:async()=>({attempts:0,inProgress:false})};
 const first=await dailyPublicationPreflight(args);assert.equal(first.outcome,'produce');assert.equal(first.plan.accountingThrough,target);assert.equal(first.plan.scheduledAt,'2026-11-06T00:00:00+08:00');
 assert.equal((await dailyPublicationPreflight({...args,reviewedSyncDate:null,readState:()=>assert.fail('ordinary clock still waits for09')})).reasonCode,'REPORT_NOT_DUE');
 assert.equal((await dailyPublicationPreflight({...args,now:new Date('2026-11-06T05:14:59+08:00'),readState:()=>assert.fail('sync declaration cannot close the market')})).reasonCode,'SOURCE_DAY_NOT_CLOSED');
 await assert.rejects(dailyPublicationPreflight({...args,reviewedSyncDate:'2026-11-04',readState:()=>assert.fail('confirmation must match target')}),/MANUAL_SYNC_CONFIRMATION/);
});
test('repeat completed-sync confirmation never rechecks an already published three-account report',async()=>{
 const target='2026-11-05',markets=['NYSE','NASDAQ'],now=new Date('2026-11-06T08:00:00+08:00');
 const plan=dailyReportPlan(target,markets,{reviewedSyncDate:target}),published=state(plan,'2026-11-05T23:45:00Z');let legacyReads=0;
 const args={targetDate:target,reviewedSyncDate:target,markets,now,ibEnabled:true,runAttempt:'1',readState:async()=>published,readRetryRuns:async()=>{legacyReads++;return [];},readSourceAttempts:()=>assert.fail('published target must not consume another source attempt')};
 for(let confirmation=0;confirmation<2;confirmation++)assert.equal((await dailyPublicationPreflight(args)).outcome,'already-published');
 assert.equal(legacyReads,0,'completed-sync must not enter legacy IB retry metadata');
 for(const time of ['09:00:00','11:30:00','14:00:00'])assert.equal((await dailyPublicationPreflight({...args,targetDate:null,reviewedSyncDate:null,scheduledDaily:true,now:new Date('2026-11-06T'+time+'+08:00')})).outcome,'already-published');
});
test('completed-sync start and clock share attempts; failure, cancellation or unknown state never authorize a retry',async()=>{
 const target='2026-11-05',markets=['NYSE','NASDAQ'],now=new Date('2026-11-06T08:00:00+08:00');
 const prior=state(dailyReportPlan('2026-11-04',markets),'2026-11-05T05:45:00Z');
 const args={targetDate:target,reviewedSyncDate:target,markets,now,ibEnabled:true,runAttempt:'1',readState:async()=>prior};
 for(const [budget,reason] of [[{attempts:1,inProgress:false},'REPORT_DAILY_SOURCE_ALREADY_ATTEMPTED'],[{attempts:2,inProgress:false},'REPORT_SOURCE_ATTEMPT_BUDGET_EXHAUSTED'],[{attempts:0,inProgress:true},'REPORT_SOURCE_RUN_IN_PROGRESS']]){
  assert.equal((await dailyPublicationPreflight({...args,readSourceAttempts:async()=>budget})).reasonCode,reason);
  assert.equal((await dailyPublicationPreflight({...args,targetDate:null,reviewedSyncDate:null,scheduledDaily:true,now:new Date('2026-11-06T09:00:00+08:00'),readSourceAttempts:async()=>budget})).reasonCode,reason);
 }
 assert.equal((await dailyPublicationPreflight({...args,readSourceAttempts:async()=>{throw Error('synthetic unavailable');}})).reasonCode,'REPORT_SOURCE_ATTEMPT_METADATA_UNVERIFIED');
 assert.equal((await dailyPublicationPreflight({...args,readState:async()=>({...prior,pending:true}),readSourceAttempts:()=>assert.fail('pending candidate reserves target')})).outcome,'candidate-pending');
 assert.equal((await dailyPublicationPreflight({...args,runAttempt:'2',readSourceAttempts:()=>assert.fail('rerun is not a new confirmation')})).reasonCode,'REPORT_SOURCE_RERUN_NOT_ALLOWED');
 const summary=reportPreflightSummary(await dailyPublicationPreflight({...args,readSourceAttempts:async()=>({attempts:1,inProgress:false})}));assert.match(summary,/REPORT_DAILY_SOURCE_ALREADY_ATTEMPTED/);assert.doesNotMatch(summary,/UNKNOWN/);
});
test('completed-sync month-end waits for actual New York midnight before publication or source metadata',async()=>{
 const target='2026-11-30',markets=['NYSE','NASDAQ'];let reads=0,attemptReads=0;
 const prior=state(dailyReportPlan('2026-11-27',markets),'2026-11-28T02:30:00Z');
 const args={targetDate:target,reviewedSyncDate:target,markets,ibEnabled:false,runAttempt:'1',readState:async()=>{reads++;return prior;},readSourceAttempts:async()=>{attemptReads++;return {attempts:0,inProgress:false};}};
 const early=await dailyPublicationPreflight({...args,now:new Date('2026-12-01T08:00:00+08:00')});assert.equal(early.outcome,'waiting');assert.equal(early.reasonCode,'ACCOUNTING_DAY_NOT_COMPLETE');assert.equal(reads,0);assert.equal(attemptReads,0);
 const due=await dailyPublicationPreflight({...args,now:new Date('2026-12-01T13:00:00+08:00')});assert.equal(due.outcome,'produce');assert.deepEqual(due.plan.monthlyCutoffs,[target]);assert.equal(reads,1);assert.equal(attemptReads,1);
});

test('manual sync flag binds existing reviewed dispatch, main, first attempt and the real event input',()=>{
 const target='2026-10-28',args={mode:'preflight','report-kind':'daily','report-target':target,'manual-sync-completed-for':target};
 const env={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',GITHUB_REF:'refs/heads/main'};
 const event={inputs:{run_reviewed_once:'true',report_kind:'daily',report_target:target,manual_sync_completed_for:target,source_plan_check_only:'false',source_acceptance_once:'false'}};
 const check=(a=args,e=env,v=event)=>reviewedSyncConfirmation(a,{env:e,readEvent:()=>v});
 assert.equal(check(),target);assert.equal(check({...args,mode:'produce'}),target);assert.equal(check({...args,'manual-sync-completed-for':undefined}),null);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-reviewed-event-')),file=path.join(dir,'event.json');
 try{
  fs.writeFileSync(file,JSON.stringify(event));
  assert.equal(reviewedSyncConfirmation(args,{env:{...env,GITHUB_EVENT_PATH:file}}),target);
  fs.writeFileSync(file,'{}');assert.throws(()=>reviewedSyncConfirmation(args,{env:{...env,GITHUB_EVENT_PATH:file}}),/MANUAL_SYNC_CONFIRMATION/);
  fs.writeFileSync(file,'not-json');assert.throws(()=>reviewedSyncConfirmation(args,{env:{...env,GITHUB_EVENT_PATH:file}}),/MANUAL_SYNC_CONFIRMATION/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
 for(const changed of [{GITHUB_ACTIONS:'false'},{GITHUB_EVENT_NAME:'schedule'},{GITHUB_RUN_ATTEMPT:'2'},{GITHUB_REF:'refs/heads/not-main'}])assert.throws(()=>check(args,{...env,...changed}),/MANUAL_SYNC_CONFIRMATION/);
 for(const changed of [{run_reviewed_once:'false'},{manual_sync_completed_for:''},{manual_sync_completed_for:'2026-10-27'},{report_target:'2026-10-27'},{report_kind:'weekly'},{source_plan_check_only:'true'},{source_acceptance_once:'true'}])assert.throws(()=>check(args,env,{inputs:{...event.inputs,...changed}}),/MANUAL_SYNC_CONFIRMATION/);
 assert.throws(()=>check(args,env,{}),/MANUAL_SYNC_CONFIRMATION/);
 assert.throws(()=>check({...args,mode:'watch'}),/MANUAL_SYNC_CONFIRMATION/);
 const wf=fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml',import.meta.url),'utf8');
 const qualifier=Function('github','inputs','return ('+wf.match(/REVIEWED_SYNC_DATE:\s*\$\{\{([^\n]+)\}\}/)[1]+');');
 assert.equal(qualifier({event_name:'schedule'},{run_reviewed_once:true,manual_sync_completed_for:target}),'');
 assert.equal(qualifier({event_name:'workflow_dispatch'},{run_reviewed_once:false,manual_sync_completed_for:target}),'');
 assert.equal(qualifier({event_name:'workflow_dispatch'},{run_reviewed_once:true,manual_sync_completed_for:target}),target);
 for(const cli of [['--mode=preflight','--report-kind=daily','--report-target='+target],['--mode=produce','--report-kind=daily','--report-target='+target]]){
   const r=spawnSync(process.execPath,[new URL('./fee-report-producer.mjs',import.meta.url).pathname,...cli,'--manual-sync-completed-for='+target],{encoding:'utf8',env:{PATH:process.env.PATH}});
   assert.equal(r.status,1);assert.match(r.stderr,/MANUAL_SYNC_CONFIRMATION/);assert.equal(r.stdout,'');
 }
});

function syntheticSyncRun(head='a'.repeat(40),id=1001,created='2026-11-03T23:00:00Z'){
 return {id,workflow_id:365873934,path:'.github/workflows/fee-cloud-producer.yml',head_branch:'main',head_sha:head,
  actor:{id:283054367},triggering_actor:{id:283054367},repository:{full_name:'huanwujoy-crypto/fee-console'},
  event:'workflow_dispatch',run_attempt:1,status:'in_progress',conclusion:null,created_at:created};
}
function confirmedDailyFixture(){
 const target='2026-11-03',head='a'.repeat(40);
 const args={mode:'preflight','report-kind':'daily','report-target':target,'manual-sync-completed-for':target,'confirmed-main':head};
 const env={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',GITHUB_REF:'refs/heads/main',GITHUB_SHA:head,GITHUB_REPOSITORY:'huanwujoy-crypto/fee-console',GITHUB_ACTOR_ID:'283054367',GITHUB_RUN_ID:'1001',PLANNED_MAIN:head};
 const event={sender:{id:283054367},repository:{full_name:env.GITHUB_REPOSITORY},inputs:{run_reviewed_once:'true',report_kind:'daily',report_target:target,manual_sync_completed_for:target,confirmed_main:head}};
 return {target,head,args,env,event};
}
test('confirmed main binds the real event, dispatch head, owner, target and first attempt',()=>{
 const f=confirmedDailyFixture(),check=x=>reviewedMainConfirmation(x.args,{env:x.env,readEvent:()=>x.event});
 assert.equal(check(f),f.head);assert.equal(check({...f,args:{...f.args,mode:'produce'}}),f.head);
 for(const mutate of [x=>delete x.args['confirmed-main'],x=>x.args['confirmed-main']='b'.repeat(40),x=>x.args['confirmed-main']='A'.repeat(40),
  x=>x.args['report-target']='2026-02-30',x=>x.args['manual-sync-completed-for']='2026-11-02',x=>x.args['report-kind']='weekly',x=>x.args.mode='watch',
  x=>x.env.GITHUB_SHA='b'.repeat(40),x=>x.env.GITHUB_RUN_ATTEMPT='2',x=>x.env.GITHUB_EVENT_NAME='schedule',x=>x.env.GITHUB_REF='refs/heads/topic',
  x=>x.env.GITHUB_ACTIONS='false',x=>x.env.GITHUB_REPOSITORY='other/repo',x=>x.env.GITHUB_ACTOR_ID='1',x=>x.env.GITHUB_RUN_ID='0',
  x=>x.env.FEE_REPORT_ONCE_MAIN=f.head,x=>x.env.FEE_AUTOMATIC_DAILY_REQUEST='true',x=>x.event.sender.id=1,x=>x.event.repository.full_name='other/repo',
  x=>x.event.inputs.confirmed_main='b'.repeat(40),x=>delete x.event.inputs.confirmed_main,x=>x.event.inputs.report_target='2026-11-02',
  x=>x.event.inputs.manual_sync_completed_for='2026-11-02',x=>x.event.inputs.run_reviewed_once='false',x=>x.event.inputs.report_kind='automatic-daily',
  x=>x.event.inputs.approved=true,x=>{x.args.mode='produce';x.env.PLANNED_MAIN='b'.repeat(40);}]){
  const x=structuredClone(f);mutate(x);assert.throws(()=>check(x),/^Error: FEE_REPORT_CONFIRMED_MAIN_SCOPE$/);
 }
 for(const name of ['ib_diagnostic_once','source_plan_check_only','source_acceptance_once','ib_diagnostic_main','report_markets','recovery_main','ratio_main','ratio_plan','source_from','source_target','source_main']){
  const x=structuredClone(f);x.event.inputs[name]='nonempty';assert.throws(()=>check(x),/CONFIRMED_MAIN_SCOPE/);
 }
 for(const name of ['recovery-main','report-markets'])assert.throws(()=>check({...f,args:{...f.args,[name]:'nonempty'}}),/CONFIRMED_MAIN_SCOPE/);
});
test('cloud confirmed payload uses one known execution without full history or attempt counting',async()=>{
 const result=spawnSync('python3',['-c',"import json; from runtime import Github\nclass H:\n def request(self,url,**kw):\n  print(json.dumps(kw['body'])); return 204,None\nGithub(http=H(),read_token=lambda:'synthetic-only').dispatch_confirmed({'targetDate':'2026-11-03','confirmedAt':'2026-11-03T23:00:00Z','requestId':'synthetic-only','expectedMain':'a'*40})"],{cwd:new URL('../cloud/fee-clock/',import.meta.url),encoding:'utf8',env:{PATH:process.env.PATH,PYTHONDONTWRITEBYTECODE:'1'}});
 assert.equal(result.status,0,result.stderr);const body=JSON.parse(result.stdout),f=confirmedDailyFixture();assert.equal(body.ref,'main');f.event.inputs=body.inputs;
 assert.deepEqual(body.inputs,{run_reviewed_once:'true',report_kind:'daily',report_target:f.target,manual_sync_completed_for:f.target,confirmed_main:f.head});
 assert.equal(reviewedMainConfirmation(f.args,{env:f.env,readEvent:()=>f.event}),f.head);
 assert.equal(reviewedSyncConfirmation(f.args,{env:f.env,readEvent:()=>f.event}),f.target);
 const prior=state(dailyReportPlan('2026-11-02',['NYSE','NASDAQ']),'2026-11-03T01:00:00Z');
 const outcome=await dailyPublicationPreflight({targetDate:f.target,reviewedSyncDate:f.target,confirmedMain:f.head,now:new Date('2026-11-04T07:00:00+08:00'),markets:['NYSE','NASDAQ'],ibEnabled:false,runAttempt:'1',currentRunId:1001,readCurrentRun:async()=>syntheticSyncRun(),readState:async()=>prior,readSourceAttempts:async()=>assert.fail('confirmed entry must not list history')});
 assert.equal(outcome.outcome,'produce');
});
test('empty confirmed main preserves ordinary, reviewed, automatic and one-off compatibility',async()=>{
 const f=confirmedDailyFixture();delete f.args['confirmed-main'];f.event.inputs.confirmed_main='';
 assert.equal(reviewedMainConfirmation(f.args,{env:f.env,readEvent:()=>f.event}),null);
 assert.equal(reviewedSyncConfirmation(f.args,{env:f.env,readEvent:()=>f.event}),f.target);
 assert.equal(reviewedMainConfirmation({mode:'preflight'},{env:{GITHUB_EVENT_NAME:'schedule'}}),null);
 const a=automaticDailyFixture();a.event.inputs.confirmed_main='';
 assert.equal(scheduledDailyContext({mode:'preflight'},{...a,readEvent:()=>a.event}),true);
 a.event.inputs.confirmed_main=f.head;assert.throws(()=>scheduledDailyContext({mode:'preflight'},{...a,readEvent:()=>a.event}),/DAILY_SCOPE/);
 const once=manualCloudOnceFixture();once.event.inputs.confirmed_main='';assert.equal((await once.control('once-scope')).state,'active');
});
test('confirmed preflight rejects changed public main before querying source attempts',async()=>{
 const f=confirmedDailyFixture(),old=state(dailyReportPlan('2026-11-02',['NYSE','NASDAQ']),'2026-11-03T01:00:00Z');let attempts=0;
 const args={targetDate:f.target,reviewedSyncDate:f.target,confirmedMain:f.head,now:new Date('2026-11-04T07:00:00+08:00'),markets:['NYSE','NASDAQ'],ibEnabled:false,runAttempt:'1',currentRunId:1001,readCurrentRun:async()=>syntheticSyncRun(),readState:async()=>old,readSourceAttempts:async()=>{attempts++;return {attempts:0,inProgress:false};}};
 assert.equal((await dailyPublicationPreflight(args)).outcome,'produce');assert.equal(attempts,0);
 for(const changed of [{mainSha:'b'.repeat(40)},{finalMainSha:'b'.repeat(40)},{mainSha:'b'.repeat(40),finalMainSha:'b'.repeat(40)}]){
  attempts=0;await assert.rejects(dailyPublicationPreflight({...args,readState:async()=>({...old,...changed})}),/CONFIRMED_MAIN_CHANGED/);assert.equal(attempts,0);
 }
 attempts=0;await assert.rejects(nativeReportPreflight({...args,plan:dailyReportPlan(f.target,args.markets,{reviewedSyncDate:f.target}),readState:async()=>({...old,mainSha:'b'.repeat(40)})}),/CONFIRMED_MAIN_CHANGED/);assert.equal(attempts,0);
 for(const changed of [{recoveryMain:f.head},{reviewedSyncDate:null},{confirmedMain:'bad'},{scheduledDaily:true}])await assert.rejects(dailyPublicationPreflight({...args,...changed,readState:()=>assert.fail('invalid scope must not read public state')}),/CONFIRMED_MAIN_SCOPE|DAILY_SCOPE/);
});
test('confirmed source recheck requires frozen checkout and current main before any financial step',async()=>{
 const f=confirmedDailyFixture(),args={...f.args,mode:'produce'};let reads=0;
 const fetchImpl=async(url,init)=>{reads++;assert.equal(url,'https://api.github.com/repos/huanwujoy-crypto/fee-console/git/ref/heads/main');assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,undefined);const r=new Response(JSON.stringify({ref:'refs/heads/main',object:{type:'commit',sha:f.head}}));Object.defineProperty(r,'url',{value:url});return r;};
 const plan=dailyReportPlan(f.target,['NYSE','NASDAQ'],{reviewedSyncDate:f.target});f.env.REPORT_PLAN=JSON.stringify(plan);
 const options={env:f.env,readEvent:()=>f.event,checkedOutMain:f.head,fetchImpl,now:new Date('2026-11-04T00:00:00Z'),readCurrentRun:async()=>syntheticSyncRun(),readState:async()=>state(dailyReportPlan('2026-11-02',['NYSE','NASDAQ']),'2026-11-03T01:00:00Z')};
 assert.equal(await confirmReviewedMainBeforeSource(args,options),f.head);assert.equal(reads,1);
 await assert.rejects(confirmReviewedMainBeforeSource(args,{...options,checkedOutMain:'b'.repeat(40),fetchImpl:()=>assert.fail('wrong checkout must stop before metadata')}),/CONFIRMED_MAIN_CHANGED/);
 await assert.rejects(confirmReviewedMainBeforeSource(args,{...options,env:{...f.env,PLANNED_MAIN:'b'.repeat(40)},fetchImpl:()=>assert.fail('wrong frozen main must stop before metadata')}),/CONFIRMED_MAIN_SCOPE/);
 for(const value of [{ref:'refs/heads/main',object:{type:'commit',sha:'b'.repeat(40)}},{ref:'refs/heads/topic',object:{type:'commit',sha:f.head}},{ref:'refs/heads/main',object:{type:'tag',sha:f.head}}])await assert.rejects(confirmReviewedMainBeforeSource(args,{...options,fetchImpl:async url=>{const r=new Response(JSON.stringify(value));Object.defineProperty(r,'url',{value:url});return r;}}),/CONFIRMED_MAIN_CHANGED/);
 await assert.rejects(confirmReviewedMainBeforeSource(args,{...options,fetchImpl:async()=>{throw Error('private-canary');}}),/^Error: FEE_REPORT_CONFIRMED_MAIN_METADATA$/);
});
test('confirmed workflow wiring blocks mixed jobs and checks the immutable head before secrets',()=>{
 const wf=fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml',import.meta.url),'utf8'),f=confirmedDailyFixture();
 const condition=(name,inputs)=>{const block=wf.split('\n  '+name+':\n')[1].split(/\n  [a-z-]+:\n/)[0],expression=/(?:^|\n)    if: \$\{\{ (.+) \}\}/.exec(block)[1];return Boolean(vm.runInNewContext(expression,{inputs,github:{event_name:'workflow_dispatch',actor_id:'283054367',ref:'refs/heads/main',run_attempt:1,sha:f.head},vars:{FEE_REPORT_ONCE_MAIN:'',FEE_CLOUD_MODE:'publish',FEE_REPORT_DAILY_ENABLED:'true',FEE_REPORT_PERIODS_ENABLED:'true'}}));};
 const inputs={...f.event.inputs,run_reviewed_once:true};assert.equal(condition('period',inputs),true);
 for(const change of [{report_kind:'automatic-daily'},{recovery_main:f.head},{report_markets:'NYSE'},{ib_diagnostic_once:true},{ratio_plan:'nonempty'},{source_acceptance_once:true}])assert.equal(condition('period',{...inputs,...change}),false);
 for(const job of ['once-admit','once-finish','source-plan-check','source-acceptance','ratio-preflight','ratio','ib-diagnostic'])assert.equal(condition(job,{...inputs,source_plan_check_only:true,source_acceptance_once:true,ratio_plan:'nonempty',ratio_main:f.head,ib_diagnostic_once:true,ib_diagnostic_main:f.head}),false);
 const period=wf.split('\n  period:\n')[1].split('\n  once-admit:\n')[0],produce=wf.split('\n  produce:\n')[1].split('\n  once-finish:\n')[0];
 assert.match(period,/ref: \$\{\{ inputs.confirmed_main && github.sha \|\| 'main' \}\}/);
 assert(produce.indexOf('await confirmReviewedMainBeforeSource')<produce.indexOf('google-github-actions/auth@'));
 assert(produce.indexOf('await confirmReviewedMainBeforeSource')<produce.indexOf('get-secretmanager-secrets@'));
 assert.equal((wf.match(/args\+=\("--confirmed-main=\$CONFIRMED_MAIN"\)/g)||[]).length,2);
});
test('confirmed CLI rejects a stale dispatch head without public or financial IO',t=>{
 const f=confirmedDailyFixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-confirmed-head-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const event=path.join(dir,'event.json'),trace=path.join(dir,'network-used'),preload=path.join(dir,'mock-only.mjs');fs.writeFileSync(event,JSON.stringify(f.event));
 fs.writeFileSync(preload,`import fs from 'node:fs';globalThis.fetch=async()=>{fs.writeFileSync(${JSON.stringify(trace)},'unexpected');throw Error('private-canary');};`);
 const args=Object.entries(f.args).map(([key,value])=>'--'+key+'='+value),env={PATH:process.env.PATH,...f.env,GITHUB_SHA:'b'.repeat(40),GITHUB_EVENT_PATH:event};
 const result=spawnSync(process.execPath,['--import',preload,new URL('./fee-report-producer.mjs',import.meta.url).pathname,...args],{encoding:'utf8',env,timeout:10000});
 assert.equal(result.status,1);assert.equal(result.stderr.trim(),'FEE_REPORT_CONFIRMED_MAIN_SCOPE');assert.equal(result.stdout,'');assert.equal(fs.existsSync(trace),false);
});

test('confirmed failures expose only the three fixed safe codes, never arbitrary prefixed details',()=>{
 for(const suffix of ['SCOPE','CHANGED','METADATA']){
  const code='FEE_REPORT_CONFIRMED_MAIN_'+suffix;
  assert.deepEqual(safeProducerFailureSummary(code+'\n'),{code,diagnostic:null});
  for(const text of [code+'_PRIVATE_CANARY',code+' PRIVATE_CANARY',code+'=PRIVATE_CANARY']){
   const result=safeProducerFailureSummary(text+'\n');
   assert.deepEqual(result,{code:'FEE_CLOUD_FAILED',diagnostic:null});
   assert.equal(JSON.stringify(result).includes('PRIVATE_CANARY'),false);
  }
 }
 assert.deepEqual(safeProducerFailureSummary('FEE_REPORT_CONFIRMED_MAIN_UNKNOWN\n'),{code:'FEE_CLOUD_FAILED',diagnostic:null});
});

test('early published coverage deduplicates the later normal cycle without resetting attempts or freshness',async()=>{
 const target='2026-10-28',markets=['NYSE','NASDAQ'],ordinary=dailyReportPlan(target,markets),reviewed=dailyReportPlan(target,markets,{reviewedSyncDate:target});
 assert.equal(sourceAttemptWindowStart(ordinary),sourceAttemptWindowStart(reviewed));
 const s=state(reviewed,'2026-10-29T00:50:00Z'),later=new Date('2026-10-29T05:00:00Z');
 assert.equal(publishedReportMatches(s,ordinary,later),true);
 assert.equal((await nativeReportPreflight({plan:ordinary,now:later,ibEnabled:false,readState:async()=>s,readSourceAttempts:()=>assert.fail('already published no source')})).outcome,'already-published');
 assert.equal(publishedReportMatches(state(reviewed,'2026-10-28T19:00:00Z'),ordinary,later),false);
 const query=[];const response=(url,v)=>{const r=new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;};
 for(const plan of [ordinary,reviewed]){
  const count=await readPeriodSourceAttempts({plan,now:later,currentRunId:'2',fetchImpl:async url=>{query.push(url);return response(url,url.includes('/runs?')?{total_count:1,workflow_runs:[{id:1,head_branch:'main',head_sha:'a'.repeat(40),path:'.github/workflows/fee-cloud-producer.yml',event:'workflow_dispatch',created_at:'2026-10-29T00:40:00Z'}]}:{total_count:1,jobs:[{id:10,run_id:1,head_sha:'a'.repeat(40),name:'Produce daily '+target,status:'completed',conclusion:'failure',started_at:'2026-10-29T00:40:00Z'}]});}});
  assert.deepEqual(count,{attempts:1,inProgress:false});
 }
 assert.equal(new URL(query[0]).searchParams.get('created'),new URL(query[2]).searchParams.get('created'));
});

const recoveryBase='50d6454b062030d4ee6565a4d879c56b68e65911',originalFailureBase='fbb79a694acb232fbdb522939d98a933da03b1f2',oldPolicySupport='b7dd66876b153a5ff8c486c11822d0e07816760a',recoverySupport='aa04fabce3fa29ae48908019c07fb43003776fea',recoveryHead='d'.repeat(40),recoveryId=90000000001;
const recoveryUi=fs.readFileSync(new URL('./fixtures/fee-gift-registry-status-index.html',import.meta.url));
const recoveryUiBlob=crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob '+recoveryUi.length+'\0'),recoveryUi])).digest('hex');
const recoveryNow=new Date('2026-10-29T14:30:00Z');
function recoveryFixture(){
 const plan=dailyReportPlan('2026-10-28',['NYSE','NASDAQ'],{periodFrom:'2026-10-24',reviewedSyncDate:'2026-10-28'});
 const run=(id,head,created)=>({id,head_sha:head,head_branch:'main',path:'.github/workflows/fee-cloud-producer.yml',event:'workflow_dispatch',created_at:created,run_attempt:1,workflow_id:365873934,actor:{id:283054367},status:id===recoveryId?'in_progress':'completed',conclusion:id===recoveryId?null:'failure'});
 const runs=[run(recoveryId,recoveryHead,'2026-10-29T14:00:00Z'),run(40864143294,oldPolicySupport,'2026-10-29T11:15:00Z'),run(40815850578,recoveryBase,'2026-10-29T04:06:22Z'),run(40805169117,originalFailureBase,'2026-10-29T02:14:24Z'),run(40803101364,originalFailureBase,'2026-10-29T01:53:22Z')];
 const job=(r,id,name='Produce daily 2026-10-28',status='completed',conclusion='failure')=>({id,run_id:r.id,head_sha:r.head_sha,name,status,conclusion,started_at:r.created_at});
 runs.push(run(40879617376,recoverySupport,'2026-10-29T13:11:08Z'));
 const jobs={40879617376:[job(runs[5],90000000012,'period','completed','success'),job(runs[5],123467435194)],40864143294:[job(runs[1],90000000010,'period','completed','success'),job(runs[1],123414594502)],40815850578:[job(runs[2],123256663738)],40805169117:[job(runs[3],123222332691)],40803101364:[job(runs[4],123215645936)]};
 const commit={sha:recoveryHead,parents:[{sha:recoverySupport}],author:{id:283054367,login:'huanwujoy-crypto'},committer:{login:'web-flow'},commit:{tree:{sha:'a'.repeat(40)},verification:{verified:true,reason:'valid'}}};
 const supportCommit={...structuredClone(commit),sha:recoverySupport,parents:[{sha:oldPolicySupport}]};
 const comparison={status:'ahead',ahead_by:1,behind_by:0,total_commits:1,base_commit:{sha:recoverySupport},merge_base_commit:{sha:recoverySupport},commits:[{sha:recoveryHead}],files:['docs/daily-data-contract.md','docs/fee-cloud-producer.md','scripts/daily-core.mjs','scripts/daily.mjs','scripts/daily.test.mjs','scripts/fee-cloud-producer.mjs','scripts/fee-cloud-source.mjs','scripts/fee-report-producer.mjs','scripts/fee-report-producer.test.mjs','scripts/fee-sharesight-transfers.mjs','scripts/fee-source-acceptance.test.mjs'].map(filename=>({filename,status:'modified',sha:'b'.repeat(40)}))};
 const tree={sha:commit.commit.tree.sha,truncated:false,tree:[{path:'index.html',type:'blob',mode:'100644',sha:recoveryUiBlob}]};
 return{plan,runs,jobs,commit,supportCommit,comparison,tree,ref:{object:{sha:recoveryHead}},run,job};
}
function recoveryWire(f,trace=[]){return async(url,init)=>{
 assert.equal(init.method,'GET');assert.equal(init.headers.Authorization,undefined);assert.equal(init.redirect,'error');
 const root='https://api.github.com/repos/huanwujoy-crypto/fee-console/';assert.ok(url.startsWith(root));const p=url.slice(root.length);trace.push(p);
 let value;if(p.startsWith('actions/workflows/fee-cloud-producer.yml/runs?'))value={total_count:f.runs.length,workflow_runs:f.runs};
 else if(/^actions\/runs\/\d+\/jobs\?filter=all&per_page=100$/.test(p)){const id=Number(p.match(/runs\/(\d+)/)[1]),jobs=f.jobs[id];assert.ok(jobs);value={total_count:jobs.length,jobs};}
 else if(p==='git/ref/heads/main')value=f.ref;
 else if(p==='commits/'+recoveryHead+'?per_page=1')value=f.commit;else if(p==='commits/'+f.supportCommit.sha+'?per_page=1')value=f.supportCommit;else if(p==='compare/'+f.supportCommit.sha+'...'+recoveryHead+'?per_page=100')value=f.comparison;else if(p==='git/trees/'+'a'.repeat(40))value=f.tree;else assert.fail('unexpected offline metadata route');
 const r=new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;
};}
function recoveryReaders(f){const fetchImpl=recoveryWire(f);return{readSourceAttempts:args=>readPeriodSourceAttempts({...args,fetchImpl}),readRecoveryRelease:sha=>readReportRecoveryRelease(sha,{fetchImpl})};}
test('only the signed complete Sharesight reference repair admits one proposed recovery; five failures and ordinary budget two remain',async()=>{
 const f=recoveryFixture(),readers=recoveryReaders(f),args={plan:f.plan,now:recoveryNow,currentRunId:String(recoveryId),...readers};
 await assert.doesNotReject(authorizeReportRecovery({...args,expectedMain:recoveryHead}));
 assert.deepEqual(await readers.readSourceAttempts(args),{attempts:2,inProgress:false});
 const old=state(weeklyReportPlan('2026-10-23'),'2026-10-27T01:00:00Z');old.mainSha=old.finalMainSha=recoveryHead;
 const ordinary=await nativeReportPreflight({...args,reviewedSyncDate:'2026-10-28',readState:async()=>old});assert.equal(ordinary.reasonCode,'REPORT_SOURCE_ATTEMPT_BUDGET_EXHAUSTED');
 const recovered=await nativeReportPreflight({...args,reviewedSyncDate:'2026-10-28',recoveryMain:recoveryHead,readState:async()=>old});assert.equal(recovered.outcome,'produce');assert.equal(recovered.mainSha,recoveryHead);
});
test('recovery fails closed on scope, missing/changed failures, reruns, actor, current run, consumed admission and competitors',async()=>{
 const f=recoveryFixture(),readers=recoveryReaders(f),budget=await readers.readSourceAttempts({plan:f.plan,now:recoveryNow,currentRunId:recoveryId,recoveryMain:recoveryHead});
 const good={plan:f.plan,expectedMain:recoveryHead,currentRunId:recoveryId,budget,release:{mainSha:recoveryHead,parent:recoverySupport,baseSha:recoveryBase,repairBaseSha:recoverySupport,uiBlob:recoveryUiBlob,signatureVerified:true}};
 const mutations=[x=>x.plan=dailyReportPlan('2026-10-27',['NYSE','NASDAQ'],{reviewedSyncDate:'2026-10-27'}),x=>x.plan=weeklyReportPlan('2026-10-23'),x=>x.expectedMain='e'.repeat(40),x=>x.release.parent='e'.repeat(40),x=>x.release.signatureVerified=false,
  x=>x.budget.attempts=1,x=>x.budget.attempts=2,x=>x.budget.attempts=3,x=>x.budget.attempts=4,x=>x.budget.attempts=6,x=>x.budget.inProgress=true,x=>x.budget.recoveryEvidence.otherSourceActive=true,x=>x.budget.recoveryEvidence.reservations.push(90000000000),
  x=>x.budget.recoveryEvidence.currentRun=null,x=>x.budget.recoveryEvidence.currentRun.head=recoveryBase,x=>x.budget.recoveryEvidence.currentRun.actorId=1,x=>x.budget.recoveryEvidence.currentRun.attempt=2,x=>x.budget.recoveryEvidence.currentRun.event='schedule',x=>x.budget.recoveryEvidence.currentRun.workflowId=1,x=>x.budget.recoveryEvidence.currentRun.status='completed',x=>x.budget.recoveryEvidence.currentRun.conclusion='failure',
  x=>x.budget.recoveryEvidence.entries.pop(),x=>x.budget.recoveryEvidence.entries[0].runId=1,x=>x.budget.recoveryEvidence.entries[0].head=recoveryHead,x=>x.budget.recoveryEvidence.entries[0].attempt=2,x=>x.budget.recoveryEvidence.entries[0].conclusion='success',x=>x.budget.recoveryEvidence.entries[0].name='Produce daily 2026-10-29',x=>x.budget.recoveryEvidence.entries[0].jobId=0,x=>x.budget.recoveryEvidence.entries[0].jobId++,x=>x.budget.recoveryEvidence.entries[0]=structuredClone(x.budget.recoveryEvidence.entries[1])];
 for(const mutate of mutations){const value=structuredClone(good);mutate(value);assert.throws(()=>validateReportRecoveryEvidence(value),/FEE_REPORT_RECOVERY_/);}
});
for(const historicalId of [40803101364,40805169117,40815850578,40864143294,40879617376])for(const [runStatus,runConclusion]of [['in_progress',null],['completed','cancelled']])test('historical run '+historicalId+' must be completed/failure, not '+runStatus+'/'+runConclusion+', even when its source job failed',async()=>{
 const f=recoveryFixture(),historical=f.runs.find(r=>r.id===historicalId);historical.status=runStatus;historical.conclusion=runConclusion;
 const sourceJob=f.jobs[historical.id].find(j=>j.name==='Produce daily 2026-10-28');assert.equal(sourceJob.status,'completed');assert.equal(sourceJob.conclusion,'failure');
 const readers=recoveryReaders(f),budget=await readers.readSourceAttempts({plan:f.plan,now:recoveryNow,currentRunId:recoveryId,recoveryMain:recoveryHead});
 const item=budget.recoveryEvidence.entries.find(x=>x.runId===historical.id);assert.equal(item.runStatus,runStatus);assert.equal(item.runConclusion,runConclusion);
 await assert.rejects(authorizeReportRecovery({plan:f.plan,expectedMain:recoveryHead,now:recoveryNow,currentRunId:recoveryId,...readers}),/FEE_REPORT_RECOVERY_PRIOR_RUNS/);
});
test('complete recovery metadata reserves cancelled admission and scans beyond the ordinary two-entry early return',async()=>{
 for(const kind of ['cancelled-period','queued-period','old-release-cancelled-period','old-release-queued-period','failed-source','other-target-active','skipped-manual','skipped-schedule']){
  const f=recoveryFixture(),r=f.run(90000000000,kind==='other-target-active'?recoveryBase:kind.startsWith('old-release-')?recoverySupport:recoveryHead,'2026-10-29T02:50:00Z');f.runs.push(r);
  let j;if(kind==='failed-source')j=f.job(r,90000000011);else if(kind==='other-target-active')j=f.job(r,90000000011,'Produce daily 2026-10-27','in_progress',null);else j=f.job(r,90000000011,'period',kind.endsWith('queued-period')?'queued':'completed',kind.startsWith('skipped-')?'skipped':kind.endsWith('cancelled-period')?'cancelled':null);
  if(kind.endsWith('cancelled-period')||kind.endsWith('queued-period'))j.started_at=null;if(kind==='skipped-schedule')r.event='schedule';f.jobs[r.id]=[j];
  const readers=recoveryReaders(f),args={plan:f.plan,now:recoveryNow,currentRunId:recoveryId,expectedMain:recoveryHead,...readers};
  if(kind==='skipped-schedule')await assert.doesNotReject(authorizeReportRecovery(args));else await assert.rejects(authorizeReportRecovery(args),/FEE_REPORT_RECOVERY_/);
 }
});
test('recovery metadata release check rejects later versions, unsigned/wrong-owner/multi-parent commits and drift with fixed GET-only routes',async()=>{
 for(const mutate of [f=>f.ref.object.sha='e'.repeat(40),f=>f.commit.sha='e'.repeat(40),f=>f.commit.parents=[{sha:recoveryHead}],f=>f.commit.parents.push({sha:recoveryBase}),f=>f.commit.commit.verification.verified=false,f=>f.commit.author.id=1,f=>f.commit.committer.login='other']){
  const f=recoveryFixture();mutate(f);await assert.rejects(readReportRecoveryRelease(recoveryHead,{fetchImpl:recoveryWire(f)}),/RECOVERY_RELEASE/);
 }
 const f=recoveryFixture(),trace=[];await readReportRecoveryRelease(recoveryHead,{fetchImpl:recoveryWire(f,trace)});assert.equal(trace.length,5);assert.ok(trace.every(p=>!p.includes('/logs')));
});
test('reference release permits exactly eleven contract/code/test modifications and preserves the deployed UI blob',async()=>{
 const changes=[f=>f.supportCommit.parents=[],f=>f.supportCommit.parents.push({sha:recoveryBase}),
  f=>f.supportCommit.commit.verification.verified=false,f=>f.supportCommit.author.id=1,
  f=>f.comparison.total_commits=2,f=>f.comparison.ahead_by=2,f=>f.comparison.behind_by=1,
  f=>f.comparison.base_commit.sha=recoveryBase,f=>f.comparison.merge_base_commit.sha=recoveryBase,
  f=>f.comparison.commits.push({sha:'e'.repeat(40)}),f=>f.comparison.commits[0].sha='e'.repeat(40),
  f=>f.comparison.files.push({filename:'scripts/extra.mjs',status:'modified',sha:'a'.repeat(40)}),
  f=>f.comparison.files[0].filename='data.json',f=>f.comparison.files[0].status='renamed',
  f=>f.comparison.files[0].previous_filename='old.html',f=>f.comparison.files[0].sha='not-a-sha',
  f=>f.comparison.files.pop(),f=>f.comparison.files[1]=structuredClone(f.comparison.files[0]),
  f=>f.tree.sha='e'.repeat(40),f=>f.tree.truncated=true,f=>f.tree.tree=[],f=>f.tree.tree.push({...f.tree.tree[0]}),
  f=>f.tree.tree[0].sha='e'.repeat(40),f=>f.tree.tree[0].mode='120000',f=>f.tree.tree[0].type='tree'];
 for(const change of changes){const f=recoveryFixture();change(f);await assert.rejects(readReportRecoveryRelease(recoveryHead,{fetchImpl:recoveryWire(f)}),/RECOVERY_RELEASE/);}
 const support=recoveryFixture();support.ref.object.sha=recoverySupport;
 await assert.rejects(readReportRecoveryRelease(recoverySupport,{fetchImpl:recoveryWire(support)}),/RECOVERY_RELEASE/,'old release must not bypass the newly approved repair');
});
test('recovery confirmation binds real reviewed event, exact target/head, owner, main and first attempt; JSON claims cannot reset it',()=>{
 const args={mode:'preflight','report-kind':'daily','report-target':'2026-10-28','manual-sync-completed-for':'2026-10-28','recovery-main':recoveryHead};
 const env={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',GITHUB_REF:'refs/heads/main',GITHUB_SHA:recoveryHead,GITHUB_REPOSITORY:'huanwujoy-crypto/fee-console',GITHUB_ACTOR_ID:'283054367',GITHUB_RUN_ID:String(recoveryId)};
 const event={inputs:{run_reviewed_once:'true',report_kind:'daily',report_target:'2026-10-28',manual_sync_completed_for:'2026-10-28',recovery_main:recoveryHead,source_plan_check_only:'false',source_acceptance_once:'false'},sender:{id:283054367},repository:{full_name:'huanwujoy-crypto/fee-console'}};
 assert.equal(reviewedRecoveryConfirmation(args,{env,readEvent:()=>event}),recoveryHead);
 for(const mutate of [x=>x.args['report-target']='2026-10-27',x=>x.args.mode='watch',x=>x.env.GITHUB_SHA='e'.repeat(40),x=>x.env.GITHUB_ACTOR_ID='1',x=>x.env.GITHUB_RUN_ATTEMPT='2',x=>x.env.GITHUB_REF='refs/heads/other',x=>x.env.GITHUB_REPOSITORY='other/repo',x=>x.event.inputs.recovery_main='e'.repeat(40),x=>x.event.inputs.run_reviewed_once='false',x=>x.event.inputs.source_acceptance_once='true',x=>x.event.sender.id=1,x=>x.event.repository.full_name='other/repo']){
  const x=structuredClone({args,env,event});mutate(x);assert.throws(()=>reviewedRecoveryConfirmation(x.args,{env:x.env,readEvent:()=>x.event}),/RECOVERY_CONFIRMATION/);
 }
 assert.equal(reviewedRecoveryConfirmation({mode:'preflight'},{env,readEvent:()=>({...event,approved:true})}),null);
});
test('workflow carries the opt-in exact recovery SHA through both gates without changing timeout, permissions or scheduled activation',()=>{
 const workflow=fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml',import.meta.url),'utf8');
 assert.equal((workflow.match(/REVIEWED_RECOVERY_MAIN:/g)||[]).length,3);assert.equal((workflow.match(/args\+=\("--recovery-main=\$REVIEWED_RECOVERY_MAIN"\)/g)||[]).length,2);
 const expression=workflow.match(/REVIEWED_RECOVERY_MAIN:\s*\$\{\{([^\n]+)\}\}/)[1],value=Function('github','inputs','return ('+expression+');');
 assert.equal(value({event_name:'schedule'},{run_reviewed_once:true,recovery_main:recoveryHead}),'');assert.equal(value({event_name:'workflow_dispatch'},{run_reviewed_once:false,recovery_main:recoveryHead}),'');assert.equal(value({event_name:'workflow_dispatch'},{run_reviewed_once:true,recovery_main:recoveryHead}),recoveryHead);
 assert.match(workflow,/timeout-minutes: 15/);assert.match(workflow,/github\.run_attempt == 1/);assert.match(workflow,/vars\.FEE_REPORT_PERIODS_ENABLED == 'true'/);
});

test('actual recovery preflight and producer CLI use only mocked fixed routes, recheck release before IO and preserve typed source errors through both catches',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-recovery-cli-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const root=path.join(dir,'checkout');fs.mkdirSync(root);fs.cpSync(new URL('.',import.meta.url),path.join(root,'scripts'),{recursive:true});
 const f=recoveryFixture(),key=crypto.randomBytes(32),iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
 const data=JSON.stringify({enc:true,v:3,data:Buffer.concat([iv,cipher.update(JSON.stringify({daily:[{d:'2026-10-23'}]})),cipher.final(),cipher.getAuthTag()]).toString('base64')});fs.writeFileSync(path.join(root,'data.json'),data);
 const health={schema:HEALTH_SCHEMA,checkedAt:'2026-10-27T01:00:00Z',targetDate:'2026-10-23',sourceDates:{schwab:'2026-10-23',webull:'2026-10-23',benchmark:'2026-10-23'},outcome:'updated',errorCode:null,dataSha256:crypto.createHash('sha256').update(data).digest('hex')};
 const cache={v:1,benchmarks:Object.fromEntries([['spy','SPY','NYSEArca'],['qqq','QQQ','NasdaqGS']].map(([k,s,e])=>[k,{symbol:s,currency:'USD',exchange:e,series:['2026-10-23','2026-10-26','2026-10-27','2026-10-28'].map(d=>({d,p:100,div:0}))}]))};
 const benchmark=path.join(dir,'benchmark.json');fs.writeFileSync(benchmark,JSON.stringify(cache));
 const event={inputs:{run_reviewed_once:'true',report_kind:'daily',report_target:'2026-10-28',manual_sync_completed_for:'2026-10-28',recovery_main:recoveryHead,source_plan_check_only:'false',source_acceptance_once:'false'},sender:{id:283054367},repository:{full_name:'huanwujoy-crypto/fee-console'}};
 const eventFile=path.join(dir,'event.json');fs.writeFileSync(eventFile,JSON.stringify(event));
 const trace=path.join(dir,'trace.json'),preload=path.join(dir,'mock-only.mjs');
 fs.writeFileSync(preload,`import fs from 'node:fs';const D=Date,now=D.parse('2026-10-29T14:30:00Z');globalThis.Date=class extends D{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}};
  const f=${JSON.stringify(f)},data=${JSON.stringify(data)},health=${JSON.stringify(health)},calls=[];
  globalThis.fetch=async(url,init={})=>{url=String(url);if(init.method&&init.method!=='GET')throw Error('unexpected method');let value,status=200;
   const api='https://api.github.com/repos/huanwujoy-crypto/fee-console/';
   if(url.startsWith(api)){const p=url.slice(api.length);calls.push('public-metadata');
    if(p==='git/ref/heads/main')value=f.ref;else if(p==='commits/${recoveryHead}?per_page=1'){value=structuredClone(f.commit);if(process.env.SYNTHETIC_REJECT_RELEASE==='true')value.parents=[{sha:'${recoveryBase}'}];}
    else if(p==='commits/${recoverySupport}?per_page=1')value=f.supportCommit;else if(p==='compare/${recoverySupport}...${recoveryHead}?per_page=100')value=f.comparison;else if(p==='git/trees/${'a'.repeat(40)}')value=f.tree;
    else if(p.startsWith('actions/workflows/fee-cloud-producer.yml/runs?'))value={total_count:f.runs.length,workflow_runs:f.runs};
    else if(/^actions\\/runs\\/\\d+\\/jobs\\?filter=all&per_page=100$/.test(p)){const jobs=f.jobs[Number(p.match(/runs\\/(\\d+)/)[1])];if(!jobs)throw Error('unexpected job');value={total_count:jobs.length,jobs};}
    else if(p.startsWith('contents/')){const text=p.startsWith('contents/data.json?')?data:p.startsWith('contents/fee-data-health.json?')?JSON.stringify(health):null;if(text===null)throw Error('unexpected content');value={type:'file',encoding:'base64',size:Buffer.byteLength(text),content:Buffer.from(text).toString('base64')};}
    else if(p.startsWith('git/matching-refs/heads/'))value=[];else throw Error('unexpected public route');
   }else if(url==='https://api.github.com/gists/${'a'.repeat(32)}'){calls.push('economic-mock');status=Number(process.env.SYNTHETIC_HTTP_STATUS);value={message:'PRIVATE_CANARY SOURCE_HTTP amount=123456.78 \\u001b[31m'};}
   else throw Error('all real financial routes forbidden');
   fs.writeFileSync(${JSON.stringify(trace)},JSON.stringify(calls));const r=new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;};`);
 const env={PATH:process.env.PATH,NODE_OPTIONS:'--import='+preload,FEE_DATA_KEY:key.toString('base64url'),FEE_ECON_GIST_ID:'a'.repeat(32),IB_MANAGER_READ_ENABLED:'true',IB_MANAGER_BASELINE_SHA256:'b'.repeat(64),GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',GITHUB_REF:'refs/heads/main',GITHUB_SHA:recoveryHead,GITHUB_REPOSITORY:'huanwujoy-crypto/fee-console',GITHUB_ACTOR_ID:'283054367',GITHUB_RUN_ID:String(recoveryId),GITHUB_EVENT_PATH:eventFile};
 // Node resolves ESM symlinks; pass the canonical temp path so the real CLI
 // entry guard executes rather than silently importing a library module.
 const cli=path.join(fs.realpathSync(root),'scripts/fee-report-producer.mjs'),common=['--report-kind=daily','--report-target=2026-10-28','--manual-sync-completed-for=2026-10-28','--recovery-main='+recoveryHead];
 const gate=spawnSync(process.execPath,[cli,'--mode=preflight',...common,'--report-markets=NYSE,NASDAQ'],{encoding:'utf8',env,timeout:10000});assert.equal(gate.status,0,gate.stderr);assert.equal(JSON.parse(gate.stdout).outcome,'produce');assert.ok(JSON.parse(fs.readFileSync(trace)).every(x=>x==='public-metadata'));
 for(const [status,code]of [[403,'SOURCE_FORBIDDEN'],[503,'SOURCE_HTTP']]){
  const out=path.join(dir,'out'+status);fs.mkdirSync(out,{mode:0o700});
  const result=spawnSync(process.execPath,[cli,'--mode=produce',...common,'--report-plan='+JSON.stringify(f.plan),'--benchmark-file='+benchmark,'--out-dir='+out],{encoding:'utf8',env:{...env,SYNTHETIC_HTTP_STATUS:String(status)},timeout:10000});
  assert.equal(result.status,1);assert.equal(result.stderr.trim(),code);assert.equal(result.stdout,'');assert.doesNotMatch(result.stderr,/PRIVATE_CANARY|123456|SOURCE_HTTP amount/);assert.deepEqual(fs.readdirSync(out),[]);
  const calls=JSON.parse(fs.readFileSync(trace));assert.equal(calls.filter(x=>x==='economic-mock').length,1);assert.ok(calls.indexOf('economic-mock')>0);
 }
 const out=path.join(dir,'rejected');fs.mkdirSync(out,{mode:0o700});
 const rejected=spawnSync(process.execPath,[cli,'--mode=produce',...common,'--report-plan='+JSON.stringify(f.plan),'--benchmark-file='+benchmark,'--out-dir='+out],{encoding:'utf8',env:{...env,SYNTHETIC_REJECT_RELEASE:'true'},timeout:10000});
 assert.equal(rejected.status,1);assert.equal(rejected.stderr.trim(),'FEE_REPORT_RECOVERY_RELEASE');assert.ok(JSON.parse(fs.readFileSync(trace)).every(x=>x==='public-metadata'));assert.deepEqual(fs.readdirSync(out),[]);assert.equal(fs.readFileSync(path.join(root,'data.json'),'utf8'),data);
});

const principalRecoveryBase='2ba1e968e7a5401c9bb90aac967f4e57e34a7078';
const principalRecoveryNow=new Date('2026-10-31T09:30:00Z');
function principalRecoveryFixture(){
 const f=recoveryFixture();f.plan=dailyReportPlan('2026-10-30',['NYSE','NASDAQ'],{periodFrom:'2026-10-30',reviewedSyncDate:'2026-10-30'});
 f.runs=[f.run(recoveryId,recoveryHead,'2026-10-31T09:00:00Z'),
  f.run(41161244083,'b08f45e76ca57323dbfdea6d7c17134c45cfa19c','2026-10-31T02:43:05Z'),
  f.run(41163889615,'bac02b38b9ce52376464556575df9aadb17826ab','2026-10-31T03:19:00Z')];
 f.jobs={41161244083:[f.job(f.runs[1],124419094644,'Produce daily 2026-10-30')],41163889615:[f.job(f.runs[2],124427211645,'Produce daily 2026-10-30')]};
 f.commit.parents=[{sha:principalRecoveryBase}];f.supportCommit.sha=principalRecoveryBase;
 f.supportCommit.parents=['7048510f1138b44113089b37ac112de30d95e105','7171c1a028e6557ae37529655c4d01c6fa9d817c'].map(sha=>({sha}));
 f.comparison.base_commit.sha=f.comparison.merge_base_commit.sha=principalRecoveryBase;
 f.comparison.files=['.github/workflows/fee-cloud-producer.yml','scripts/fee-trade-cash-evidence.mjs','scripts/fee-cloud-source.test.mjs','scripts/fee-source-acceptance.test.mjs','scripts/fee-report-producer.mjs','scripts/fee-report-producer.test.mjs'].map(filename=>({filename,status:'modified',sha:'b'.repeat(40)}));
 f.tree.tree[0].sha='26096fe78ad571d7a8a43476d2fbf72f1194797d';return f;
}
test('October30 principal recovery retains two consumed attempts and permits only the pinned new release',async()=>{
 const f=principalRecoveryFixture(),readers=recoveryReaders(f),args={plan:f.plan,now:principalRecoveryNow,currentRunId:recoveryId,...readers};
 const budget=await readers.readSourceAttempts({...args,recoveryMain:recoveryHead});assert.equal(budget.attempts,2);assert.equal(budget.recoveryEvidence.entries.length,2);
 await assert.doesNotReject(authorizeReportRecovery({...args,expectedMain:recoveryHead}));
 const old=state(dailyReportPlan('2026-10-29',['NYSE','NASDAQ']),'2026-10-30T04:02:32Z');old.mainSha=old.finalMainSha=recoveryHead;
 assert.equal((await nativeReportPreflight({...args,reviewedSyncDate:'2026-10-30',readState:async()=>old})).reasonCode,'REPORT_SOURCE_ATTEMPT_BUDGET_EXHAUSTED');
 assert.equal((await nativeReportPreflight({...args,reviewedSyncDate:'2026-10-30',recoveryMain:recoveryHead,readState:async()=>old})).outcome,'produce');
 const release=await readers.readRecoveryRelease(recoveryHead);
 for(const target of ['2026-10-28','2026-10-29','2026-10-27']){
  const plan=dailyReportPlan(target,['NYSE','NASDAQ'],{reviewedSyncDate:target});
  assert.throws(()=>validateReportRecoveryEvidence({plan,expectedMain:recoveryHead,currentRunId:recoveryId,budget,release}),/RECOVERY_SCOPE/);
 }
});
test('October30 recovery requires both exact failed runs themselves to be completed failures',async()=>{
 for(const historicalId of [41161244083,41163889615])for(const [status,conclusion]of [['in_progress',null],['completed','cancelled'],['completed','success']]){
  const f=principalRecoveryFixture();Object.assign(f.runs.find(r=>r.id===historicalId),{status,conclusion});
  await assert.rejects(authorizeReportRecovery({plan:f.plan,expectedMain:recoveryHead,currentRunId:recoveryId,now:principalRecoveryNow,...recoveryReaders(f)}),/RECOVERY_PRIOR_RUNS/);
 }
 const f=principalRecoveryFixture(),readers=recoveryReaders(f),budget=await readers.readSourceAttempts({plan:f.plan,now:principalRecoveryNow,currentRunId:recoveryId,recoveryMain:recoveryHead}),release=await readers.readRecoveryRelease(recoveryHead);
 const good={plan:f.plan,expectedMain:recoveryHead,currentRunId:recoveryId,budget,release};
 for(const change of [v=>v.budget.attempts=0,v=>v.budget.attempts=1,v=>v.budget.attempts=3,v=>v.budget.inProgress=true,
  v=>v.budget.recoveryEvidence.entries.pop(),v=>v.budget.recoveryEvidence.entries[0].jobId++,v=>v.budget.recoveryEvidence.entries[0].head=recoveryHead,
  v=>v.budget.recoveryEvidence.entries[0].runId++,v=>v.budget.recoveryEvidence.entries[0].attempt=2,
  v=>v.budget.recoveryEvidence.currentRun.attempt=2,v=>v.budget.recoveryEvidence.currentRun.actorId=1,
  v=>v.budget.recoveryEvidence.currentRun.event='schedule',v=>v.budget.recoveryEvidence.currentRun.status='completed',
  v=>v.budget.recoveryEvidence.currentRun.head=principalRecoveryBase,v=>v.budget.recoveryEvidence.otherSourceActive=true]){
  const v=structuredClone(good);change(v);assert.throws(()=>validateReportRecoveryEvidence(v),/RECOVERY_/);
 }
});
test('October30 admission is consumed by queued cancelled skipped or failed starts on the base or final version',async()=>{
 for(const head of [principalRecoveryBase,recoveryHead])for(const [status,conclusion]of [['queued',null],['completed','cancelled'],['completed','skipped'],['completed','failure']]){
  const f=principalRecoveryFixture(),r=f.run(90000000002,head,'2026-10-31T08:45:00Z');Object.assign(r,{status:status==='queued'?'queued':'completed',conclusion});f.runs.push(r);
  f.jobs[r.id]=[{...f.job(r,90000000003,'period',status,conclusion),started_at:null}];
  await assert.rejects(authorizeReportRecovery({plan:f.plan,expectedMain:recoveryHead,currentRunId:recoveryId,now:principalRecoveryNow,...recoveryReaders(f)}),/RECOVERY_CONSUMED/);
 }
 const f=principalRecoveryFixture(),r=f.run(90000000002,recoveryHead,'2026-10-31T08:45:00Z');f.runs.push(r);f.jobs[r.id]=[f.job(r,90000000003,'Produce daily 2026-10-30')];
 await assert.rejects(authorizeReportRecovery({plan:f.plan,expectedMain:recoveryHead,currentRunId:recoveryId,now:principalRecoveryNow,...recoveryReaders(f)}),/RECOVERY_CONSUMED/);
});
test('October30 release rejects unrelated files UI changes later main and unsigned commits',async()=>{
 for(const change of [f=>f.commit.parents=[{sha:recoveryHead}],f=>f.commit.parents.push({sha:principalRecoveryBase}),
  f=>f.supportCommit.parents.pop(),f=>f.supportCommit.parents[0].sha='e'.repeat(40),
  f=>f.commit.commit.verification.verified=false,f=>f.ref.object.sha='e'.repeat(40),
  f=>f.comparison.files.pop(),f=>f.comparison.files[0].filename='data.json',
  f=>f.comparison.files.push({filename:'scripts/other.mjs',status:'modified',sha:'b'.repeat(40)}),
  f=>f.tree.tree[0].sha='e'.repeat(40)]){
  const f=principalRecoveryFixture();change(f);await assert.rejects(readReportRecoveryRelease(recoveryHead,{fetchImpl:recoveryWire(f)}),/RECOVERY_/);
 }
});
test('October30 recovery confirmation uses the original exact reviewed event and no new runtime authority',()=>{
 const args={mode:'preflight','report-kind':'daily','report-target':'2026-10-30','manual-sync-completed-for':'2026-10-30','recovery-main':recoveryHead};
 const env={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',GITHUB_REF:'refs/heads/main',GITHUB_SHA:recoveryHead,GITHUB_REPOSITORY:'huanwujoy-crypto/fee-console',GITHUB_ACTOR_ID:'283054367',GITHUB_RUN_ID:String(recoveryId)};
 const event={inputs:{run_reviewed_once:'true',report_kind:'daily',report_target:'2026-10-30',manual_sync_completed_for:'2026-10-30',recovery_main:recoveryHead,source_plan_check_only:'false',source_acceptance_once:'false'},sender:{id:283054367},repository:{full_name:'huanwujoy-crypto/fee-console'}};
 assert.equal(reviewedRecoveryConfirmation(args,{env,readEvent:()=>event}),recoveryHead);
 for(const change of [v=>v.env.GITHUB_RUN_ATTEMPT='2',v=>v.env.GITHUB_SHA=principalRecoveryBase,v=>v.event.inputs.recovery_main=principalRecoveryBase,
  v=>v.event.inputs.manual_sync_completed_for='2026-10-29',v=>v.event.inputs.source_acceptance_once='true',v=>v.event.sender.id=1]){
  const v=structuredClone({args,env,event});change(v);assert.throws(()=>reviewedRecoveryConfirmation(v.args,{env:v.env,readEvent:()=>v.event}),/RECOVERY_CONFIRMATION/);
 }
 const old=fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml',import.meta.url),'utf8');
 assert.match(old,/timeout-minutes: 15/);assert.match(old,/never resets ordinary budgets/);
});


test('actual daily preflight starts at09:00 without clearing candidate, budget or source gates',async()=>{
 const old=state(dailyReportPlan('2026-11-02',['NYSE','NASDAQ']),'2026-11-03T03:45:00Z');
 const args={now:new Date('2026-11-04T09:00:00+08:00'),markets:['NYSE','NASDAQ'],ibEnabled:false,readState:async()=>old,readSourceAttempts:async()=>({attempts:0,inProgress:false})};
 const result=await dailyPublicationPreflight(args);assert.equal(result.outcome,'produce');assert.equal(result.plan.accountingThrough,'2026-11-03');assert.equal(result.plan.priceThrough,'2026-11-03');assert.equal(result.plan.scheduledAt,'2026-11-04T09:00:00+08:00');
 assert.equal((await dailyPublicationPreflight({...args,now:new Date('2026-11-04T08:59:59+08:00'),readState:()=>assert.fail('early gate must not read publication state')})).reasonCode,'REPORT_NOT_DUE');
 for(const [budget,reason]of [[{attempts:2,inProgress:false},'REPORT_SOURCE_ATTEMPT_BUDGET_EXHAUSTED'],[{attempts:0,inProgress:true},'REPORT_SOURCE_RUN_IN_PROGRESS']])assert.equal((await dailyPublicationPreflight({...args,readSourceAttempts:async()=>budget})).reasonCode,reason);
 assert.equal((await dailyPublicationPreflight({...args,runAttempt:'2'})).reasonCode,'REPORT_SOURCE_RERUN_NOT_ALLOWED');
 assert.equal((await dailyPublicationPreflight({...args,readState:async()=>({...old,pending:true})})).outcome,'candidate-pending');
 await assert.rejects(dailyPublicationPreflight({...args,reviewedSyncDate:'2026-11-03'}),/MANUAL_SYNC_CONFIRMATION/);
});

const incomeRecoveryBase='c4effb80f56c913f4a903a4f016e6ae1cdf6cc97';
const incomeRecoveryNow=new Date('2026-11-05T06:00:00Z');
const incomeRecoveryFiles=['.github/workflows/fee-cloud-producer.yml','scripts/fee-report-producer.mjs','scripts/fee-report-producer.test.mjs'];
function incomeRecoveryFixture(){
 const f=recoveryFixture();f.plan=dailyReportPlan('2026-11-04',['NYSE','NASDAQ'],{periodFrom:'2026-11-04',reviewedSyncDate:'2026-11-04'});
 f.runs=[f.run(recoveryId,recoveryHead,'2026-11-05T05:55:00Z'),
  f.run(41945445626,'5923e40afcf4fa17e91a4be8d05aedce0fe8cc28','2026-11-05T01:00:00Z'),
  f.run(41964614855,'f1d8a9e453e80cb5644749313597fe78faf171c8','2026-11-05T03:55:48Z')];
 f.jobs={41945445626:[f.job(f.runs[1],126976478739,'Produce daily 2026-11-04')],41964614855:[f.job(f.runs[2],127038682646,'Produce daily 2026-11-04')]};
 f.commit.parents=[{sha:incomeRecoveryBase}];f.supportCommit.sha=incomeRecoveryBase;
 f.supportCommit.parents=[{sha:'f1d8a9e453e80cb5644749313597fe78faf171c8'}];
 f.comparison.base_commit.sha=f.comparison.merge_base_commit.sha=incomeRecoveryBase;
 f.comparison.files=incomeRecoveryFiles.map(filename=>({filename,status:'modified',sha:'b'.repeat(40)}));
 f.tree.tree[0].sha='a2c44b8e0e19b875221ccf537141d9435683f72b';return f;
}
test('November4 recovery preserves both failures and ordinary cap, and cannot enter pending or published state',async()=>{
 const f=incomeRecoveryFixture(),before=JSON.parse(JSON.stringify(f)),readers=recoveryReaders(f),args={plan:f.plan,now:incomeRecoveryNow,currentRunId:recoveryId,...readers};
 const budget=await readers.readSourceAttempts({...args,recoveryMain:recoveryHead});assert.equal(budget.attempts,2);assert.deepEqual(budget.recoveryEvidence.entries.map(x=>x.runId),[41945445626,41964614855]);
 await authorizeReportRecovery({...args,expectedMain:recoveryHead});assert.deepEqual(JSON.parse(JSON.stringify(f)),before);
 const old=state(dailyReportPlan('2026-11-03',['NYSE','NASDAQ']),'2026-11-04T04:30:00Z');old.mainSha=old.finalMainSha=recoveryHead;
 const preflight={...args,ibEnabled:false,reviewedSyncDate:'2026-11-04',readState:async()=>old};
 assert.equal((await nativeReportPreflight(preflight)).reasonCode,'REPORT_SOURCE_ATTEMPT_BUDGET_EXHAUSTED');
 assert.equal((await nativeReportPreflight({...preflight,recoveryMain:recoveryHead})).outcome,'produce');
 assert.equal((await nativeReportPreflight({...preflight,recoveryMain:recoveryHead,readState:async()=>({...old,pending:true}),readSourceAttempts:()=>assert.fail('pending must not authorize source')})).outcome,'candidate-pending');
 const published=state(f.plan,'2026-11-05T05:30:00Z');published.mainSha=published.finalMainSha=recoveryHead;
 assert.equal((await nativeReportPreflight({...preflight,recoveryMain:recoveryHead,readState:async()=>published,readSourceAttempts:()=>assert.fail('published must not authorize source')})).outcome,'already-published');
 const release=await readers.readRecoveryRelease(recoveryHead);
 for(const target of ['2026-10-28','2026-10-30','2026-11-03','2026-11-05'])assert.throws(()=>validateReportRecoveryEvidence({plan:dailyReportPlan(target,['NYSE','NASDAQ'],{reviewedSyncDate:target}),expectedMain:recoveryHead,currentRunId:recoveryId,budget,release}),/RECOVERY_SCOPE/);
});
test('November4 recovery rejects altered historical evidence, reruns, wrong identity, missing history and competing source',async()=>{
 const f=incomeRecoveryFixture(),readers=recoveryReaders(f),budget=await readers.readSourceAttempts({plan:f.plan,now:incomeRecoveryNow,currentRunId:recoveryId,recoveryMain:recoveryHead});
 const good={plan:f.plan,expectedMain:recoveryHead,currentRunId:recoveryId,budget,release:await readers.readRecoveryRelease(recoveryHead)};
 for(const change of [x=>x.budget.attempts=1,x=>x.budget.attempts=3,x=>x.budget.inProgress=true,x=>x.budget.recoveryEvidence.otherSourceActive=true,
  x=>x.budget.recoveryEvidence.entries.pop(),x=>x.budget.recoveryEvidence.entries[0].runId++,x=>x.budget.recoveryEvidence.entries[0].jobId++,x=>x.budget.recoveryEvidence.entries[0].head=recoveryHead,
  x=>x.budget.recoveryEvidence.entries[0].attempt=2,x=>x.budget.recoveryEvidence.entries[0].runStatus='in_progress',x=>x.budget.recoveryEvidence.entries[0].runConclusion='cancelled',x=>x.budget.recoveryEvidence.entries[0].conclusion='success',
  x=>x.budget.recoveryEvidence.currentRun.attempt=2,x=>x.budget.recoveryEvidence.currentRun.actorId=1,x=>x.budget.recoveryEvidence.currentRun.workflowId=1,x=>x.budget.recoveryEvidence.currentRun.event='schedule',x=>x.budget.recoveryEvidence.currentRun.head=incomeRecoveryBase]){
  const x=structuredClone(good);change(x);assert.throws(()=>validateReportRecoveryEvidence(x),/RECOVERY_/);
 }
 for(const id of [41945445626,41964614855])for(const conclusion of ['success','cancelled',null]){
  const bad=incomeRecoveryFixture();bad.runs.find(r=>r.id===id).conclusion=conclusion;
  await assert.rejects(authorizeReportRecovery({plan:bad.plan,expectedMain:recoveryHead,now:incomeRecoveryNow,currentRunId:recoveryId,...recoveryReaders(bad)}),/RECOVERY_PRIOR_RUNS/);
 }
});
test('November4 queued cancelled skipped or failed admission burns the extra chance; the earlier diagnostic remains separate',async()=>{
 for(const head of [incomeRecoveryBase,recoveryHead])for(const [status,conclusion]of [['queued',null],['completed','cancelled'],['completed','skipped'],['completed','failure']]){
  const f=incomeRecoveryFixture(),r=f.run(90000000002,head,'2026-11-05T05:00:00Z');Object.assign(r,{status,conclusion});f.runs.push(r);
  f.jobs[r.id]=[{...f.job(r,90000000003,'period',status,conclusion),started_at:null}];
  await assert.rejects(authorizeReportRecovery({plan:f.plan,expectedMain:recoveryHead,currentRunId:recoveryId,now:incomeRecoveryNow,...recoveryReaders(f)}),/RECOVERY_CONSUMED/);
 }
 const f=incomeRecoveryFixture(),r=f.run(41957865621,'757b360de94f4e3b37c10b6fda2cbe79c6d7a2ec','2026-11-05T03:00:00Z');r.display_title='IB diagnostic 2026-11-04';f.runs.push(r);f.jobs[r.id]=[f.job(r,90000000003,r.display_title)];
 const before=JSON.parse(JSON.stringify(f)),args={plan:f.plan,expectedMain:recoveryHead,currentRunId:recoveryId,now:incomeRecoveryNow,...recoveryReaders(f)};
 await authorizeReportRecovery(args);assert.deepEqual(JSON.parse(JSON.stringify(f)),before);
 r.run_attempt=2;await assert.rejects(authorizeReportRecovery(args),/SOURCE_ATTEMPT_METADATA/);
});
test('November4 release requires exactly three reviewed files, immediate signed successor and unchanged deployed UI',async()=>{
 for(const change of [f=>f.commit.parents=[{sha:recoveryHead}],f=>f.commit.parents.push({sha:incomeRecoveryBase}),f=>f.supportCommit.parents=[],
  f=>f.commit.commit.verification.verified=false,f=>f.supportCommit.author.id=1,f=>f.ref.object.sha='e'.repeat(40),
  f=>f.comparison.total_commits=2,f=>f.comparison.files.pop(),f=>f.comparison.files[0].filename='data.json',f=>f.comparison.files[0].status='renamed',
  f=>f.comparison.files.push({filename:'security/approval-tiers.json',status:'modified',sha:'b'.repeat(40)}),f=>f.tree.tree[0].sha='e'.repeat(40)]){
  const f=incomeRecoveryFixture();change(f);await assert.rejects(readReportRecoveryRelease(recoveryHead,{fetchImpl:recoveryWire(f)}),/RECOVERY_/);
 }
});
const fundRecordsRecoveryBase='55f2cc9d60f360944b90ff610aee814589bb7cfc';
const fundRecordsRecoveryParents=['94210904dd95b2ff4496cb68dab6b49950fe4f74','a81d1a20e7214a96f9eafc6e65ee38d31010bc35'];
const fundRecordsRecoveryNow=new Date('2026-11-07T00:30:00Z');
const fundRecordsRecoveryFiles=['scripts/fee-report-producer.mjs','scripts/fee-report-producer.test.mjs'];
function fundRecordsRecoveryFixture(){
 const f=recoveryFixture();f.plan=dailyReportPlan('2026-11-06',['NYSE','NASDAQ'],{periodFrom:'2026-11-06',reviewedSyncDate:'2026-11-06'});
 f.runs=[f.run(recoveryId,recoveryHead,'2026-11-07T00:25:00Z'),f.run(42309848352,fundRecordsRecoveryParents[0],'2026-11-06T23:08:38Z')];
 f.jobs={42309848352:[{...f.job(f.runs[1],128208373197,'Produce daily 2026-11-06'),started_at:'2026-11-06T23:08:55Z'}]};
 f.commit.parents=[{sha:fundRecordsRecoveryBase}];f.supportCommit.sha=fundRecordsRecoveryBase;
 f.supportCommit.parents=fundRecordsRecoveryParents.map(sha=>({sha}));
 f.comparison.base_commit.sha=f.comparison.merge_base_commit.sha=fundRecordsRecoveryBase;
 f.comparison.files=fundRecordsRecoveryFiles.map(filename=>({filename,status:'modified',sha:'b'.repeat(40)}));
 f.tree.tree[0].sha='2bb9f66ac890ba87cec504ef72a5083c07670689';return f;
}
test('November6 recovery alone admits one reviewed source entry and preserves the failed run and ordinary two-attempt ceiling',async()=>{
 const f=fundRecordsRecoveryFixture(),before=JSON.stringify(f),readers=recoveryReaders(f),args={plan:f.plan,now:fundRecordsRecoveryNow,currentRunId:recoveryId,...readers};
 const budget=await readers.readSourceAttempts({...args,recoveryMain:recoveryHead});assert.equal(budget.attempts,1);assert.equal(budget.inProgress,false);
 assert.deepEqual(budget.recoveryEvidence.entries.map(x=>[x.runId,x.jobId,x.head]),[[42309848352,128208373197,fundRecordsRecoveryParents[0]]]);
 await authorizeReportRecovery({...args,expectedMain:recoveryHead});assert.equal(JSON.stringify(f),before);
 const old=state(dailyReportPlan('2026-11-05',['NYSE','NASDAQ']),'2026-11-06T01:00:41.982Z');old.mainSha=old.finalMainSha=recoveryHead;
 const options={...args,ibEnabled:false,runAttempt:'1',reviewedSyncDate:'2026-11-06',readState:async()=>old};
 assert.equal((await nativeReportPreflight(options)).reasonCode,'REPORT_DAILY_SOURCE_ALREADY_ATTEMPTED');
 assert.equal((await nativeReportPreflight({...options,recoveryMain:recoveryHead})).outcome,'produce');
 assert.equal((await nativeReportPreflight({...options,readSourceAttempts:async()=>({attempts:2,inProgress:false})})).reasonCode,'REPORT_SOURCE_ATTEMPT_BUDGET_EXHAUSTED');
 assert.equal((await nativeReportPreflight({...options,recoveryMain:recoveryHead,runAttempt:'2'})).reasonCode,'REPORT_SOURCE_RERUN_NOT_ALLOWED');
 assert.equal(JSON.stringify(f),before);
});
test('November6 pending, published, changed main and unknown history never admit another source read',async()=>{
 const f=fundRecordsRecoveryFixture(),readers=recoveryReaders(f),old=state(dailyReportPlan('2026-11-05',['NYSE','NASDAQ']),'2026-11-06T01:00:41.982Z');old.mainSha=old.finalMainSha=recoveryHead;
 const options={plan:f.plan,now:fundRecordsRecoveryNow,currentRunId:recoveryId,ibEnabled:false,reviewedSyncDate:'2026-11-06',recoveryMain:recoveryHead,...readers,readState:async()=>old};
 const noBudget=()=>assert.fail('pending or published must not request recovery admission');
 assert.equal((await nativeReportPreflight({...options,readState:async()=>({...old,pending:true}),readSourceAttempts:noBudget})).outcome,'candidate-pending');
 const published=state(f.plan,'2026-11-07T00:20:00Z');published.mainSha=published.finalMainSha=recoveryHead;
 assert.equal((await nativeReportPreflight({...options,readState:async()=>published,readSourceAttempts:noBudget})).outcome,'already-published');
 await assert.rejects(nativeReportPreflight({...options,readState:async()=>({...old,mainSha:fundRecordsRecoveryBase,finalMainSha:fundRecordsRecoveryBase})}),/RECOVERY_RELEASE/);
 await assert.rejects(nativeReportPreflight({...options,readSourceAttempts:async()=>{throw Error('unknown');}}),/RECOVERY_METADATA/);
 const f2=fundRecordsRecoveryFixture(),wire=recoveryWire(f2);
 await assert.rejects(readPeriodSourceAttempts({plan:f2.plan,now:fundRecordsRecoveryNow,currentRunId:recoveryId,recoveryMain:recoveryHead,fetchImpl:async(url,init)=>{
  if(url.includes('/actions/'))return new Response('{}',{status:403});return wire(url,init);
 }}),/HTTP_403/);
});
test('November6 recovery rejects changed failure, identity, attempt counts, in-flight source and old scopes',async()=>{
 const f=fundRecordsRecoveryFixture(),readers=recoveryReaders(f),budget=await readers.readSourceAttempts({plan:f.plan,now:fundRecordsRecoveryNow,currentRunId:recoveryId,recoveryMain:recoveryHead});
 const good={plan:f.plan,expectedMain:recoveryHead,currentRunId:recoveryId,budget,release:await readers.readRecoveryRelease(recoveryHead)};
 for(const change of [x=>x.budget.attempts=0,x=>x.budget.attempts=2,x=>x.budget.attempts=3,x=>x.budget.inProgress=true,x=>x.budget.recoveryEvidence.otherSourceActive=true,
  x=>x.budget.recoveryEvidence.entries.pop(),x=>x.budget.recoveryEvidence.entries[0].runId++,x=>x.budget.recoveryEvidence.entries[0].jobId++,x=>x.budget.recoveryEvidence.entries[0].head=recoveryHead,
  x=>x.budget.recoveryEvidence.entries[0].attempt=2,x=>x.budget.recoveryEvidence.entries[0].runStatus='in_progress',x=>x.budget.recoveryEvidence.entries[0].runConclusion='cancelled',x=>x.budget.recoveryEvidence.entries[0].conclusion='success',
  x=>x.budget.recoveryEvidence.currentRun=null,x=>x.budget.recoveryEvidence.currentRun.attempt=2,x=>x.budget.recoveryEvidence.currentRun.actorId=1,x=>x.budget.recoveryEvidence.currentRun.workflowId=1,x=>x.budget.recoveryEvidence.currentRun.event='schedule',x=>x.budget.recoveryEvidence.currentRun.head=fundRecordsRecoveryBase,
  x=>x.release.parent=fundRecordsRecoveryParents[0],x=>x.release.signatureVerified=false]){
  const x=structuredClone(good);change(x);assert.throws(()=>validateReportRecoveryEvidence(x),/RECOVERY_/);
 }
 for(const target of ['2026-10-28','2026-10-30','2026-11-04','2026-11-05','2026-11-09'])assert.throws(()=>validateReportRecoveryEvidence({...good,plan:dailyReportPlan(target,['NYSE','NASDAQ'],{reviewedSyncDate:target})}),/RECOVERY_SCOPE/);
 for(const conclusion of ['success','cancelled',null]){
  const bad=fundRecordsRecoveryFixture();bad.runs[1].conclusion=conclusion;
  await assert.rejects(authorizeReportRecovery({plan:bad.plan,expectedMain:recoveryHead,now:fundRecordsRecoveryNow,currentRunId:recoveryId,...recoveryReaders(bad)}),/RECOVERY_PRIOR_RUNS/);
 }
});
test('November6 queued or terminated prior admission consumes recovery and cannot be reset or retried',async()=>{
 for(const head of [fundRecordsRecoveryBase,recoveryHead])for(const [status,conclusion]of [['queued',null],['completed','cancelled'],['completed','skipped'],['completed','failure']]){
  const f=fundRecordsRecoveryFixture(),r=f.run(90000000002,head,'2026-11-07T00:15:00Z');Object.assign(r,{status,conclusion});f.runs.push(r);
  f.jobs[r.id]=[{...f.job(r,90000000003,'period',status,conclusion),started_at:null}];
  await assert.rejects(authorizeReportRecovery({plan:f.plan,expectedMain:recoveryHead,currentRunId:recoveryId,now:fundRecordsRecoveryNow,...recoveryReaders(f)}),/RECOVERY_CONSUMED/);
 }
 for(const status of ['in_progress','completed']){
  const f=fundRecordsRecoveryFixture(),r=f.run(90000000002,recoveryHead,'2026-11-07T00:15:00Z');r.status=status;r.conclusion=status==='completed'?'failure':null;f.runs.push(r);
  f.jobs[r.id]=[f.job(r,90000000003,'Produce daily 2026-11-06',status,r.conclusion)];
  await assert.rejects(authorizeReportRecovery({plan:f.plan,expectedMain:recoveryHead,currentRunId:recoveryId,now:fundRecordsRecoveryNow,...recoveryReaders(f)}),/RECOVERY_CONSUMED/);
 }
});
test('November6 release pins the exact two-parent repair base, signed single successor, two modified files and deployed UI',async()=>{
 for(const change of [f=>f.commit.parents=[{sha:recoveryHead}],f=>f.commit.parents.push({sha:fundRecordsRecoveryBase}),f=>f.supportCommit.parents=[],
  f=>f.supportCommit.parents.reverse(),f=>f.supportCommit.parents.pop(),f=>f.supportCommit.parents[1].sha='e'.repeat(40),
  f=>f.commit.commit.verification.verified=false,f=>f.commit.author.id=1,f=>f.supportCommit.commit.verification.verified=false,f=>f.supportCommit.author.id=1,f=>f.ref.object.sha='e'.repeat(40),
  f=>f.comparison.ahead_by=2,f=>f.comparison.behind_by=1,f=>f.comparison.total_commits=2,f=>f.comparison.commits.push({sha:'e'.repeat(40)}),
  f=>f.comparison.files.pop(),f=>f.comparison.files[0].filename='data.json',f=>f.comparison.files[0].status='added',f=>f.comparison.files[0].status='renamed',f=>f.comparison.files[0].previous_filename='old.mjs',
  f=>f.comparison.files.push({filename:'scripts/fee-ratio-fee-publication.mjs',status:'added',sha:'b'.repeat(40)}),f=>f.tree.tree[0].sha='e'.repeat(40),f=>f.tree.truncated=true]){
  const f=fundRecordsRecoveryFixture();change(f);await assert.rejects(readReportRecoveryRelease(recoveryHead,{fetchImpl:recoveryWire(f)}),/RECOVERY_/);
 }
});
test('November6 recovery confirmation retains the owner event and never accepts an old target or run replay',()=>{
 const args={mode:'preflight','report-kind':'daily','report-target':'2026-11-06','manual-sync-completed-for':'2026-11-06','recovery-main':recoveryHead};
 const env={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',GITHUB_REF:'refs/heads/main',GITHUB_SHA:recoveryHead,GITHUB_REPOSITORY:'huanwujoy-crypto/fee-console',GITHUB_ACTOR_ID:'283054367',GITHUB_RUN_ID:String(recoveryId)};
 const event={inputs:{run_reviewed_once:'true',report_kind:'daily',report_target:'2026-11-06',manual_sync_completed_for:'2026-11-06',recovery_main:recoveryHead,source_plan_check_only:'false',source_acceptance_once:'false'},sender:{id:283054367},repository:{full_name:'huanwujoy-crypto/fee-console'}};
 assert.equal(reviewedRecoveryConfirmation(args,{env,readEvent:()=>event}),recoveryHead);
 for(const change of [v=>v.env.GITHUB_RUN_ATTEMPT='2',v=>v.env.GITHUB_SHA=fundRecordsRecoveryBase,v=>v.env.GITHUB_ACTOR_ID='1',v=>v.event.sender.id=1,
  v=>v.event.inputs.recovery_main=fundRecordsRecoveryBase,v=>v.args['manual-sync-completed-for']='2026-11-05',v=>v.args['report-target']='2026-11-04',v=>v.event.inputs.source_acceptance_once='true']){
  const v=structuredClone({args,env,event});change(v);assert.throws(()=>reviewedRecoveryConfirmation(v.args,{env:v.env,readEvent:()=>v.event}),/RECOVERY_CONFIRMATION/);
 }
});

const revisionRecoveryBase='d617fdd25315ca09a5f89a81630b04ae19b24d1b';
const revisionRecoveryParents=['4d798c77c9a9a5d459a75af45b4239c7c9cf984a','474e7b5a20f93358193791daf84d175a22e06d9e'];
const revisionContract='ib-source-revision-20261106-v1',revisionReviewedHead='c'.repeat(40);
const revisionActionsToken='synthetic-revision-actions-read-token';
const revisionRecoveryNow=new Date('2026-11-07T01:00:00Z');
function sourceRevisionRecoveryFixture(){
 const f=fundRecordsRecoveryFixture(),files=reportHistoricalRecoveryManifest();
 f.runs=[f.run(recoveryId,recoveryHead,'2026-11-07T00:40:00Z'),
  f.run(42309848352,fundRecordsRecoveryParents[0],'2026-11-06T23:08:38Z'),
  f.run(42318324848,'2c32d695f4f2dc057920fc690046ddf3e1ccdaee','2026-11-07T00:27:25Z')];
 f.jobs={42309848352:[f.job(f.runs[1],128208373197,'Produce daily 2026-11-06')],
  42318324848:[f.job(f.runs[2],90000000015,'period','completed','success'),f.job(f.runs[2],128236468656,'Produce daily 2026-11-06')]};
 f.commit.parents=[{sha:revisionRecoveryBase}];f.supportCommit.sha=revisionRecoveryBase;f.supportCommit.parents=revisionRecoveryParents.map(sha=>({sha}));
 f.comparison.base_commit.sha=f.comparison.merge_base_commit.sha=revisionRecoveryBase;
 f.comparison.files=files.map(x=>({filename:x.path,status:x.status,sha:'b'.repeat(40)}));
 f.tree.tree.push(...files.map(x=>({path:x.path,type:'blob',mode:'100644',sha:'b'.repeat(40)})));
 f.reviewedCommit={...structuredClone(f.commit),sha:revisionReviewedHead};
 f.associated=[{number:9001}];
 f.pr={number:9001,state:'closed',merged:true,draft:false,merge_commit_sha:recoveryHead,
  user:{id:283054367,login:'huanwujoy-crypto'},base:{ref:'main',repo:{full_name:'huanwujoy-crypto/fee-console'}},
  head:{sha:revisionReviewedHead,repo:{full_name:'huanwujoy-crypto/fee-console'}},commits:1,merged_at:'2026-11-07T00:35:00Z'};
 f.comments=[{id:9002,user:{id:283054367,login:'huanwujoy-crypto',type:'User'},issue_url:'https://api.github.com/repos/huanwujoy-crypto/fee-console/issues/9001',
  body:'/approve-xuan-ib-maintenance '+revisionReviewedHead+'\nSYNTHETIC exact version only',created_at:'2026-11-07T00:30:00Z',updated_at:'2026-11-07T00:30:00Z'}];
 return f;
}
function sourceRevisionWire(f,trace=[]){
 const old=recoveryWire(f,trace);return async(url,init)=>{
  assert.equal(init.method,'GET');assert.equal(init.redirect,'error');
  const prefix='https://api.github.com/repos/huanwujoy-crypto/fee-console/';assert(url.startsWith(prefix));const p=url.slice(prefix.length);
  const publicReview=/^(?:commits\/[a-f0-9]{40}\/pulls\?|pulls\/|issues\/)/.test(p);
  assert.equal(init.headers.Authorization,publicReview?undefined:'Bearer '+revisionActionsToken);
  if(f.metadataUnavailable)throw Error('private-canary');
  const extra={['git/trees/'+'a'.repeat(40)+'?recursive=1']:f.tree,
   ['commits/'+recoveryHead+'/pulls?per_page=100']:f.associated,'pulls/9001':f.pr,
   'issues/9001/comments?per_page=100':f.comments,'issues/comments/9002':f.comments.find(c=>c.id===9002),['commits/'+revisionReviewedHead+'?per_page=1']:f.reviewedCommit};
  if(!Object.hasOwn(extra,p))return old(url,{...init,headers:{...init.headers,Authorization:undefined}});
  trace.push(p);const response=new Response(JSON.stringify(extra[p]),{headers:{'content-type':'application/json'}});Object.defineProperty(response,'url',{value:url});return response;
 };
}
function sourceRevisionReaders(f,trace=[]){const fetchImpl=sourceRevisionWire(f,trace);return{
 readRecoveryRelease:(sha,options={})=>readReportRecoveryRelease(sha,{...options,fetchImpl,actionsToken:revisionActionsToken}),
 readSourceAttempts:args=>readPeriodSourceAttempts({...args,fetchImpl,actionsToken:revisionActionsToken})};}
async function sourceRevisionAdmission(f,readers=sourceRevisionReaders(f)){
 return authorizeReportRecovery({plan:f.plan,expectedMain:recoveryHead,currentRunId:recoveryId,now:revisionRecoveryNow,...readers});
}
test('revision recovery validates the actual frozen batch and returns only an authentic opaque admission',async()=>{
 const manifest=reportHistoricalRecoveryManifest();assert(manifest.length>2);assert(manifest.some(x=>x.status==='added'));assert(manifest.some(x=>x.status==='modified'));
 assert(Object.isFrozen(manifest));assert(manifest.every(Object.isFrozen));
 const f=sourceRevisionRecoveryFixture(),trace=[],admission=await sourceRevisionAdmission(f,sourceRevisionReaders(f,trace));
 assert(isHistoricalRevisionAdmission(admission));assert(Object.isFrozen(admission));assert.equal(JSON.stringify(admission),'{}');
 const v=readHistoricalRevisionAdmission(admission);assert(Object.isFrozen(v));
 assert.deepEqual(Object.keys(v).sort(),['approvedHead','approvedTree','consumptionSha256','contractId','currentRunId','mainSha','repairBaseSha','targetDate'].sort());
 assert.equal(v.contractId,revisionContract);assert.equal(v.targetDate,'2026-11-06');assert.equal(v.repairBaseSha,revisionRecoveryBase);
 assert.equal(v.mainSha,recoveryHead);assert.equal(v.approvedHead,revisionReviewedHead);assert.equal(v.currentRunId,recoveryId);assert.match(v.consumptionSha256,/^[a-f0-9]{64}$/);
 assert(trace.indexOf('commits/'+recoveryHead+'/pulls?per_page=100')<trace.findIndex(x=>x.startsWith('actions/')));
 assert.deepEqual(await admission.checkCurrent(),v);
 for(const value of [{},JSON.parse(JSON.stringify(admission)),{...v,checkCurrent:async()=>v},structuredClone(v),new Proxy(admission,{})]){
  assert.equal(isHistoricalRevisionAdmission(value),false);assert.throws(()=>readHistoricalRevisionAdmission(value),/RECOVERY_SCOPE/);
 }
});
test('revision recovery requires branded unmodified results, not callback assertions of a verified release or budget',async()=>{
 for(const which of ['release','budget']){
  const f=sourceRevisionRecoveryFixture(),actual=sourceRevisionReaders(f),fake={...actual};
  if(which==='release')fake.readRecoveryRelease=async(...args)=>structuredClone(await actual.readRecoveryRelease(...args));
  else fake.readSourceAttempts=async args=>structuredClone(await actual.readSourceAttempts(args));
  await assert.rejects(sourceRevisionAdmission(f,fake),/RECOVERY_METADATA/);
 }
 const f=sourceRevisionRecoveryFixture(),actual=sourceRevisionReaders(f);
 await assert.rejects(sourceRevisionAdmission(f,{...actual,readSourceAttempts:async args=>{
  const value=await actual.readSourceAttempts(args);value.recoveryEvidence.currentRun.id++;return value;
 }}),/RECOVERY_RUN|RECOVERY_METADATA/);
});
test('same-target old and revision contracts cannot substitute for each other or reset the two consumed source entries',async()=>{
 const f=sourceRevisionRecoveryFixture(),r=sourceRevisionReaders(f),release=await r.readRecoveryRelease(recoveryHead);
 const args={plan:f.plan,now:revisionRecoveryNow,currentRunId:recoveryId,recoveryMain:recoveryHead};
 const budget=await r.readSourceAttempts({...args,recoveryRelease:release});assert.equal(budget.attempts,2);
 assert.deepEqual(budget.recoveryEvidence.entries.map(x=>[x.runId,x.jobId,x.head]),[
  [42309848352,128208373197,fundRecordsRecoveryParents[0]],[42318324848,128236468656,'2c32d695f4f2dc057920fc690046ddf3e1ccdaee']]);
 assert.equal(validateReportRecoveryEvidence({...args,expectedMain:recoveryHead,budget,release}),true);
 const legacy=await r.readSourceAttempts(args);assert.equal(legacy.attempts,2);
 assert.throws(()=>validateReportRecoveryEvidence({...args,expectedMain:recoveryHead,budget:legacy,release}),/RECOVERY_SCOPE/);
 for(const change of [x=>x.budget.attempts--,x=>x.budget.attempts++,x=>x.budget.recoveryEvidence.entries.pop(),
  x=>x.budget.recoveryEvidence.entries[1].head=fundRecordsRecoveryBase,x=>x.budget.recoveryEvidence.entries[1].jobId++,
  x=>x.budget.recoveryEvidence.entries[1].attempt=2,x=>x.budget.recoveryEvidence.entries[1].conclusion='success',
  x=>x.release.contractId='ib-source-revision-other',x=>x.release.repairBaseSha=fundRecordsRecoveryBase,
  x=>x.budget.recoveryEvidence.contractId='ib-source-revision-other']){
  const v=structuredClone({budget,release});change(v);assert.throws(()=>validateReportRecoveryEvidence({...args,expectedMain:recoveryHead,...v}),/RECOVERY_/);
 }
});
test('revision release enforces exact file/status/mode, both base parents, one signed successor and the approved head tree',async()=>{
 const changes=[f=>f.commit.parents.push({sha:revisionRecoveryBase}),f=>f.supportCommit.parents.reverse(),
  f=>f.commit.commit.verification.verified=false,f=>f.comparison.ahead_by=2,f=>f.comparison.total_commits=2,
  f=>f.comparison.files.pop(),f=>f.comparison.files.push({filename:'data.json',status:'modified',sha:'b'.repeat(40)}),
  f=>f.comparison.files.find(x=>x.status==='added').status='modified',f=>f.comparison.files.find(x=>x.status==='modified').status='added',
  f=>f.comparison.files[0].previous_filename='old',f=>f.comparison.files[0].status='renamed',
  f=>f.tree.tree[1].mode='120000',f=>f.tree.tree[1].type='tree',f=>f.tree.tree[1].sha='e'.repeat(40),f=>f.tree.tree[0].sha='e'.repeat(40),f=>f.tree.truncated=true,
  f=>f.associated.push({number:9003}),f=>f.associated=[],f=>f.associated[0].number='9001',
  f=>f.pr.merged=false,f=>f.pr.merge_commit_sha='e'.repeat(40),f=>f.pr.base.ref='topic',f=>f.pr.head.repo.full_name='other/repo',
  f=>f.pr.user.id=1,f=>f.pr.commits=2,f=>f.pr.draft=true,
  f=>f.reviewedCommit.commit.tree.sha='e'.repeat(40),f=>f.reviewedCommit.parents=[{sha:fundRecordsRecoveryBase}],f=>f.reviewedCommit.commit.verification.verified=false,
  f=>f.comments=[],f=>f.comments[0].user.id=1,f=>f.comments[0].user.type='Bot',f=>f.comments[0].body=f.comments[0].body.slice(1),
  f=>f.comments[0].body='/approve-xuan-ib-maintenance '+recoveryHead,f=>f.comments[0].updated_at='2026-11-07T00:36:00Z',
  f=>f.comments=Array.from({length:100},(_,i)=>({...f.comments[0],id:9002+i}))];
 for(const change of changes){const f=sourceRevisionRecoveryFixture();change(f);await assert.rejects(readReportRecoveryRelease(recoveryHead,{fetchImpl:sourceRevisionWire(f),targetDate:'2026-11-06',actionsToken:revisionActionsToken}),/RECOVERY_/);}
 const f=sourceRevisionRecoveryFixture(),wire=sourceRevisionWire(f);let refs=0;
 await assert.rejects(readReportRecoveryRelease(recoveryHead,{fetchImpl:async(url,init)=>{
  if(url.endsWith('/git/ref/heads/main')&&++refs===2)f.ref.object.sha='e'.repeat(40);return wire(url,init);
 },actionsToken:revisionActionsToken}),/RECOVERY_RELEASE/);
});
test('revision admission burns on an extra queued/finished reservation and stops on all unexpected active sources',async()=>{
 for(const head of [revisionRecoveryBase,recoveryHead])for(const [status,conclusion]of [['queued',null],['completed','cancelled'],['completed','skipped'],['completed','failure']]){
  const f=sourceRevisionRecoveryFixture(),r=f.run(90000000021,head,'2026-11-07T00:38:00Z');Object.assign(r,{status,conclusion});f.runs.push(r);
  f.jobs[r.id]=[{...f.job(r,90000000022,'period',status,conclusion),started_at:null}];
  await assert.rejects(sourceRevisionAdmission(f),/RECOVERY_CONSUMED/);
 }
 for(const name of ['Produce daily 2026-11-06','Produce daily 2026-11-05','Source acceptance 2026-11-06']){
  const f=sourceRevisionRecoveryFixture(),r=f.run(90000000021,'e'.repeat(40),'2026-11-07T00:38:00Z');r.status='in_progress';r.conclusion=null;f.runs.push(r);
  f.jobs[r.id]=[f.job(r,90000000022,name,'in_progress',null)];await assert.rejects(sourceRevisionAdmission(f),/RECOVERY_CONSUMED/);
 }
});
test('revision current-context checks revoke the capability after a new attempt, changed main, changed request or unknown metadata',async()=>{
 for(const kind of ['attempt','main','plan','metadata','comment-edit']){
  const f=sourceRevisionRecoveryFixture(),admission=await sourceRevisionAdmission(f);
  if(kind==='main')f.ref.object.sha='e'.repeat(40);
  if(kind==='plan')f.plan.extra='private-canary';
  if(kind==='metadata')f.metadataUnavailable=true;
  if(kind==='comment-edit')f.comments[0].body+='\nchanged';
  if(kind==='attempt'){const run=f.run(90000000021,recoveryHead,'2026-11-07T00:45:00Z');f.runs.push(run);f.jobs[run.id]=[f.job(run,90000000022,'period','completed','failure')];}
  await assert.rejects(admission.checkCurrent(),e=>{assert.match(e.message,/^FEE_REPORT_RECOVERY_(RELEASE|SCOPE|METADATA|CONSUMED)$/);assert.doesNotMatch(e.message,/private-canary/);return true;});
  assert.equal(isHistoricalRevisionAdmission(admission),false);assert.throws(()=>readHistoricalRevisionAdmission(admission),/RECOVERY_SCOPE/);
  await assert.rejects(admission.checkCurrent(),/RECOVERY_CONSUMED/);
 }
});
test('revision cache reuses only immutable proof while fixed routing keeps token and anonymous request budget bounded',async()=>{
 const f=sourceRevisionRecoveryFixture(),trace=[],admission=await sourceRevisionAdmission(f,sourceRevisionReaders(f,trace));
 const immutable=trace.filter(x=>x.startsWith('commits/')||x.startsWith('git/trees/')||x.startsWith('compare/')||x.startsWith('pulls/')).length;
 assert.equal(admission.readMetadataCounts().anonymous,3);
 for(let i=0;i<29;i++)await admission.checkCurrent();
 assert.equal(admission.readMetadataCounts().anonymous,32);
 assert.equal(trace.filter(x=>x.startsWith('commits/')||x.startsWith('git/trees/')||x.startsWith('compare/')||x.startsWith('pulls/')).length,immutable);
 assert.equal(trace.filter(x=>x==='issues/comments/9002').length,29);
 assert(trace.filter(x=>x.startsWith('actions/workflows/')).length>=30);
 await assert.rejects(admission.checkCurrent(),/RECOVERY_METADATA/);assert.equal(isHistoricalRevisionAdmission(admission),false);
 const second=await sourceRevisionAdmission(sourceRevisionRecoveryFixture());second.close();
 assert.equal(isHistoricalRevisionAdmission(second),false);await assert.rejects(second.checkCurrent(),/RECOVERY_CONSUMED/);
});
test('revision admission closed during metadata IO never returns late bindings or starts another request',async()=>{
 for(const stage of ['git/ref/heads/main','actions/workflows/fee-cloud-producer.yml/runs?',
  'actions/runs/42309848352/jobs?','actions/runs/42318324848/jobs?']){
  const f=sourceRevisionRecoveryFixture(),trace=[],wire=sourceRevisionWire(f,trace);
  let armed=false,releasePending,signalPending;
  const reached=new Promise(resolve=>{signalPending=resolve;}),gate=new Promise(resolve=>{releasePending=resolve;});
  const fetchImpl=async(url,init)=>{
   const response=await wire(url,init),path=url.slice('https://api.github.com/repos/huanwujoy-crypto/fee-console/'.length);
   if(armed&&path.startsWith(stage)){signalPending();await gate;}
   return response;
  };
  const readers={readRecoveryRelease:(sha,options={})=>readReportRecoveryRelease(sha,{...options,fetchImpl,actionsToken:revisionActionsToken}),
   readSourceAttempts:args=>readPeriodSourceAttempts({...args,fetchImpl,actionsToken:revisionActionsToken})};
  const admission=await sourceRevisionAdmission(f,readers);armed=true;
  const pending=admission.checkCurrent();await reached;
  admission.close();const requestsAtClose=trace.length;
  assert.equal(isHistoricalRevisionAdmission(admission),false);
  assert.throws(()=>readHistoricalRevisionAdmission(admission),/RECOVERY_SCOPE/);
  releasePending();
  await assert.rejects(pending,/^Error: FEE_REPORT_RECOVERY_CONSUMED$/);
  assert.equal(trace.length,requestsAtClose,stage+' must stop at the pending request');
  await assert.rejects(admission.checkCurrent(),/RECOVERY_CONSUMED/);
  assert.equal(trace.length,requestsAtClose);
 }
});
test('recovery is rechecked in the original before-financial-access step without adding dispatch inputs or permissions',async()=>{
 const f=sourceRevisionRecoveryFixture(),args={mode:'produce','report-kind':'daily','report-target':'2026-11-06','manual-sync-completed-for':'2026-11-06','recovery-main':recoveryHead};
 const env={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',GITHUB_REF:'refs/heads/main',GITHUB_SHA:recoveryHead,
  GITHUB_REPOSITORY:'huanwujoy-crypto/fee-console',GITHUB_ACTOR_ID:'283054367',GITHUB_RUN_ID:String(recoveryId),PLANNED_MAIN:recoveryHead,REPORT_PLAN:JSON.stringify(f.plan)};
 const event={inputs:{run_reviewed_once:'true',report_kind:'daily',report_target:'2026-11-06',manual_sync_completed_for:'2026-11-06',recovery_main:recoveryHead},sender:{id:283054367},repository:{full_name:env.GITHUB_REPOSITORY}};
 let calls=0;const authorize=async x=>{calls++;assert.equal(x.expectedMain,recoveryHead);assert.deepEqual(x.plan,f.plan);return 'synthetic-no-capability';};
 assert.equal(await confirmReviewedRecoveryBeforeSource(args,{env,readEvent:()=>event,checkedOutMain:recoveryHead,authorize}),'synthetic-no-capability');assert.equal(calls,1);
 for(const change of [x=>x.checkedOutMain='e'.repeat(40),x=>x.env.PLANNED_MAIN='e'.repeat(40),x=>x.env.REPORT_PLAN='{}',x=>x.env.GITHUB_RUN_ATTEMPT='2']){
  const x={env:structuredClone(env),readEvent:()=>event,checkedOutMain:recoveryHead,authorize:()=>assert.fail('invalid context must not authorize')};change(x);await assert.rejects(confirmReviewedRecoveryBeforeSource(args,x),/RECOVERY_/);
 }
 assert.equal(await confirmReviewedRecoveryBeforeSource({mode:'produce'},{authorize:()=>assert.fail('ordinary path unchanged')}),null);
 const wf=fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml',import.meta.url),'utf8'),produce=wf.split('\n  produce:\n')[1].split('\n  once-finish:\n')[0];
 assert(produce.indexOf('await confirmReviewedRecoveryBeforeSource')<produce.indexOf('google-github-actions/auth@'));
 assert(produce.indexOf('await confirmReviewedRecoveryBeforeSource')<produce.indexOf('Complete the frozen price cutoff from Sharesight'));
 assert.match(produce,/permissions:\n      contents: read\n      actions: read\n      id-token: write/);assert.doesNotMatch(wf,/recovery_contract:|recovery_reviewed_head:/);
});
test('period rejects forged, cloned, wrong-target and injected-reader revision admissions before any private or account IO',async()=>{
 const f=sourceRevisionRecoveryFixture(),admission=await sourceRevisionAdmission(f);let io=0;
 const base={plan:f.plan,reviewedSyncDate:'2026-11-06',now:revisionRecoveryNow,requireIb:true,historicalRevisionAdmission:admission,
  fetchEconomic:()=>{io++;assert.fail('economic IO forbidden');},outputDir:'/synthetic/not-accessed',benchmarkFile:'/synthetic/not-accessed'};
 const previous=process.env.GITHUB_SHA;process.env.GITHUB_SHA=recoveryHead;
 try{
  for(const change of [{historicalRevisionAdmission:{}},{historicalRevisionAdmission:structuredClone(readHistoricalRevisionAdmission(admission))},
   {historicalRevisionAdmission:{...readHistoricalRevisionAdmission(admission),checkCurrent:async()=>true}},
   {requireIb:false},{readOnce:()=>{io++;assert.fail('account IO forbidden');}},{ibReader:{readStable:()=>{io++;assert.fail('account IO forbidden');}}},
   {sourceFile:'/synthetic/alternate'},
   {plan:dailyReportPlan('2026-11-05',['NYSE','NASDAQ'],{reviewedSyncDate:'2026-11-05'}),reviewedSyncDate:'2026-11-05'}]){
   await assert.rejects(produceReportPeriod({...base,...change}),/^Error: FEE_REPORT_REVISION_ADMISSION$/);assert.equal(io,0);
  }
  process.env.GITHUB_SHA='e'.repeat(40);await assert.rejects(produceReportPeriod(base),/^Error: FEE_REPORT_REVISION_ADMISSION$/);assert.equal(io,0);
 }finally{if(previous===undefined)delete process.env.GITHUB_SHA;else process.env.GITHUB_SHA=previous;}
});
test('both production admission checks retain their original ephemeral read token and permissions',()=>{
 const wf=fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml',import.meta.url),'utf8');
 const produce=wf.split('\n  produce:\n')[1].split('\n  once-finish:\n')[0];
 const step=produce.split('      - name: Read, calculate and validate the encrypted candidate\n')[1].split('\n      - name:')[0];
 assert.match(produce,/permissions:\n      contents: read\n      actions: read\n      id-token: write/);
 assert.match(step,/FEE_REPORT_ACTIONS_TOKEN: \$\{\{ github.token \}\}/);assert.equal((produce.match(/FEE_REPORT_ACTIONS_TOKEN:/g)||[]).length,2);
 const diagnostic=wf.split('\n  ib-diagnostic:\n');assert.equal(diagnostic.length,2);
 assert.equal((diagnostic[0].match(/FEE_REPORT_ACTIONS_TOKEN:/g)||[]).length,3);
 const envelope=diagnostic[1].split('\n  ib-envelope-evidence:\n');assert.equal(envelope.length,2);
 assert.equal((envelope[0].match(/FEE_REPORT_ACTIONS_TOKEN:/g)||[]).length,2);
 assert.equal((envelope[1].match(/FEE_REPORT_ACTIONS_TOKEN:/g)||[]).length,2);
 assert.doesNotMatch(produce,/contents: write|actions: write/);
 assert.deepEqual([...wf.matchAll(/cron: '([^']+)'/g)].map(m=>m[1]),['0 1 * * *','30 3 * * *','0 6 * * *']);
 assert.match(wf,/group: fee-cloud-producer\n  cancel-in-progress: false/);assert.match(wf,/github\.run_attempt == 1/);
});
test('November4 actual CLI rechecks authenticated recovery metadata before economic access and never leaks the token',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-income-recovery-cli-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const root=path.join(dir,'checkout');fs.mkdirSync(root);fs.cpSync(new URL('.',import.meta.url),path.join(root,'scripts'),{recursive:true});
 const f=incomeRecoveryFixture(),key=crypto.randomBytes(32),iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
 const data=JSON.stringify({enc:true,v:3,data:Buffer.concat([iv,cipher.update(JSON.stringify({daily:[{d:'2026-11-03'}]})),cipher.final(),cipher.getAuthTag()]).toString('base64')});fs.writeFileSync(path.join(root,'data.json'),data);
 const health={...state(dailyReportPlan('2026-11-03',['NYSE','NASDAQ']),'2026-11-04T04:30:00Z').health,dataSha256:crypto.createHash('sha256').update(data).digest('hex')};
 const cache={v:1,benchmarks:Object.fromEntries([['spy','SPY','NYSEArca'],['qqq','QQQ','NasdaqGS']].map(([k,s,e])=>[k,{symbol:s,currency:'USD',exchange:e,series:['2026-11-03','2026-11-04'].map(d=>({d,p:100,div:0}))}]))};
 const benchmark=path.join(dir,'benchmark.json');fs.writeFileSync(benchmark,JSON.stringify(cache));
 const event={inputs:{run_reviewed_once:'true',report_kind:'daily',report_target:'2026-11-04',manual_sync_completed_for:'2026-11-04',recovery_main:recoveryHead,source_plan_check_only:'false',source_acceptance_once:'false'},sender:{id:283054367},repository:{full_name:'huanwujoy-crypto/fee-console'}};
 const eventFile=path.join(dir,'event.json');fs.writeFileSync(eventFile,JSON.stringify(event));
 const trace=path.join(dir,'trace.json'),preload=path.join(dir,'mock-only.mjs'),token='synthetic-recovery-token-canary';
 fs.writeFileSync(preload,`import fs from 'node:fs';const D=Date,now=D.parse('2026-11-05T06:00:00Z');globalThis.Date=class extends D{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}};
 const f=${JSON.stringify(f)},data=${JSON.stringify(data)},health=${JSON.stringify(health)},calls=[];
 globalThis.fetch=async(url,init={})=>{url=String(url);if(init.method&&init.method!=='GET')throw Error('unexpected request');let value,status=200;
 const api='https://api.github.com/repos/huanwujoy-crypto/fee-console/';
 if(url.startsWith(api)){if(init.redirect!=='error')throw Error('metadata redirect');const p=url.slice(api.length);calls.push('metadata');
 if(p.startsWith('actions/')){if(init.headers?.Authorization!=='Bearer '+process.env.FEE_REPORT_ACTIONS_TOKEN)throw Error('auth missing');if(process.env.SYNTHETIC_CASE==='unauthorized')status=401;}else if(init.headers?.Authorization&&init.headers.Authorization!=='Bearer '+process.env.FEE_REPORT_ACTIONS_TOKEN)throw Error('unexpected fixed-repository token');
 if(p.startsWith('actions/workflows/fee-cloud-producer.yml/runs?'))value={total_count:f.runs.length,workflow_runs:f.runs};
 else if(/^actions\\/runs\\/\\d+\\/jobs\\?filter=all&per_page=100$/.test(p)){const jobs=f.jobs[Number(p.match(/runs\\/(\\d+)/)[1])];if(!jobs)throw Error('unexpected jobs');value={total_count:jobs.length,jobs};}
 else if(p==='git/ref/heads/main')value=f.ref;
 else if(p==='commits/${recoveryHead}?per_page=1')value=f.commit;else if(p==='commits/${incomeRecoveryBase}?per_page=1')value=f.supportCommit;
 else if(p==='compare/${incomeRecoveryBase}...${recoveryHead}?per_page=100')value=f.comparison;
 else if(p==='git/trees/${'a'.repeat(40)}'){value=structuredClone(f.tree);if(process.env.SYNTHETIC_CASE==='release-drift')value.tree[0].sha='e'.repeat(40);}
 else if(p.startsWith('contents/')){const text=p.startsWith('contents/data.json?')?data:p.startsWith('contents/fee-data-health.json?')?JSON.stringify(health):null;if(text===null)throw Error('unexpected file');value={type:'file',encoding:'base64',size:Buffer.byteLength(text),content:Buffer.from(text).toString('base64')};}
 else if(p.startsWith('git/matching-refs/heads/'))value=[];else throw Error('unexpected metadata');
 }else if(url==='https://api.github.com/gists/${'a'.repeat(32)}'){if(init.redirect!=='manual'||init.headers?.Authorization)throw Error('economic request scope');calls.push('economic-mock');status=403;value={message:'private-canary'};}
 else throw Error('real financial routes forbidden');
 fs.writeFileSync(${JSON.stringify(trace)},JSON.stringify(calls));const r=new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;};`);
 const env={PATH:process.env.PATH,NODE_OPTIONS:'--import='+preload,FEE_REPORT_ACTIONS_TOKEN:token,FEE_DATA_KEY:key.toString('base64url'),FEE_ECON_GIST_ID:'a'.repeat(32),IB_MANAGER_READ_ENABLED:'true',IB_MANAGER_BASELINE_SHA256:'b'.repeat(64),GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',GITHUB_REF:'refs/heads/main',GITHUB_SHA:recoveryHead,GITHUB_REPOSITORY:'huanwujoy-crypto/fee-console',GITHUB_ACTOR_ID:'283054367',GITHUB_RUN_ID:String(recoveryId),GITHUB_EVENT_PATH:eventFile};
 const cli=path.join(fs.realpathSync(root),'scripts/fee-report-producer.mjs'),common=['--report-kind=daily','--report-target=2026-11-04','--manual-sync-completed-for=2026-11-04','--recovery-main='+recoveryHead];
 const gate=spawnSync(process.execPath,[cli,'--mode=preflight',...common,'--report-markets=NYSE,NASDAQ'],{encoding:'utf8',env,timeout:10000});assert.equal(gate.status,0,gate.stderr);assert.equal(JSON.parse(gate.stdout).outcome,'produce');assert.ok(JSON.parse(fs.readFileSync(trace)).every(x=>x==='metadata'));
 for(const [kind,expected,economicCalls]of [['ok','SOURCE_FORBIDDEN',1],['unauthorized','FEE_REPORT_RECOVERY_METADATA',0],['release-drift','FEE_REPORT_RECOVERY_RELEASE',0]]){
  const out=path.join(dir,kind);fs.mkdirSync(out,{mode:0o700});
  const result=spawnSync(process.execPath,[cli,'--mode=produce',...common,'--report-plan='+JSON.stringify(f.plan),'--benchmark-file='+benchmark,'--out-dir='+out],{encoding:'utf8',env:{...env,SYNTHETIC_CASE:kind},timeout:10000});
  assert.equal(result.status,1);assert.equal(result.stderr.trim(),expected);assert.equal(result.stdout,'');assert.doesNotMatch(result.stdout+result.stderr,/synthetic-recovery-token-canary|private-canary/);
  assert.equal(JSON.parse(fs.readFileSync(trace)).filter(x=>x==='economic-mock').length,economicCalls);assert.deepEqual(fs.readdirSync(out),[]);assert.equal(fs.readFileSync(path.join(root,'data.json'),'utf8'),data);
 }
});

test('period metadata token stays on fixed GET routes and preserves source-entry counting',async()=>{
 const token='synthetic-ephemeral-token-canary',r=budgetRun();let calls=0;
 const fetchImpl=async(url,init)=>{calls++;assert.match(url,/^https:\/\/api\.github\.com\/repos\/huanwujoy-crypto\/fee-console\/actions\//);assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,'Bearer '+token);const value=url.includes('/workflows/')?{total_count:1,workflow_runs:[r]}:{total_count:1,jobs:[budgetJob(r)]};const response=new Response(JSON.stringify(value));Object.defineProperty(response,'url',{value:url});return response;};
 assert.deepEqual(await readPeriodSourceAttempts({plan:budgetPlan,now:budgetNow,actionsToken:token,fetchImpl}),{attempts:1,inProgress:false});assert.equal(calls,2);
 for(const actionsToken of ['',null,'short','a'.repeat(20)+'\n'])await assert.rejects(readPeriodSourceAttempts({plan:budgetPlan,now:budgetNow,actionsToken,fetchImpl:()=>assert.fail('invalid token must stop before network')}),/BOUNDED_JSON_AUTH_REQUIRED/);
});
test('period metadata diagnostics are closed and never render raw exceptions or extra fields',async()=>{
 const {BoundedJsonError}=await import('./fee-http-json.mjs'),old=state(weeklyReportPlan('2026-10-23'),'2026-10-27T01:00:00Z');
 for(const [error,code] of [...['CONFIG','ABORTED','HTTP','HTTP_401','HTTP_403','HTTP_429','TYPE','SIZE','BODY','TIMEOUT','JSON','NETWORK'].map(c=>[new BoundedJsonError(c),c]),[Error('FEE_REPORT_SOURCE_ATTEMPT_METADATA'),'METADATA_INVALID'],[new BoundedJsonError('AUTH_REQUIRED'),'AUTH_REQUIRED'],[Error('private-canary url header token body'),'UNKNOWN'],[new BoundedJsonError('private-canary'),'UNKNOWN']]){
  const r=await nativeReportPreflight({plan:budgetPlan,now:budgetNow,readState:async()=>old,readSourceAttempts:async()=>{throw error;}});assert.equal(r.outcome,'waiting');assert.equal(r.reasonCode,'REPORT_SOURCE_ATTEMPT_METADATA_UNVERIFIED');assert.equal(r.metadataCode,code);
  const summary=reportPreflightSummary({...r,message:'private-canary',stack:'private-canary',url:'private-canary'});assert.match(summary,new RegExp('Metadata result: '+code));assert.doesNotMatch(summary,/private-canary|BOUNDED_JSON_/);
 }
 const summary=reportPreflightSummary({schema:'fee-console.report-preflight.v1',outcome:'waiting',reasonCode:'REPORT_SOURCE_private-canary',metadataCode:'HTTP',plan:{accountingThrough:'private-canary'}});assert.match(summary,/Reason: UNKNOWN/);assert.doesNotMatch(summary,/private-canary|Metadata result/);
});
test('actual period CLI and workflow summary carry the scoped token and safe failure reason end to end',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-period-auth-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const s=state(dailyReportPlan('2026-11-02',['NYSE','NASDAQ']),'2026-11-03T03:47:41Z'),preload=path.join(dir,'preload.mjs'),token='synthetic-ephemeral-token-canary';
 fs.writeFileSync(preload,`const D=Date,now=D.parse('2026-11-04T01:34:52Z');globalThis.Date=class extends D{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}};
 const data=${JSON.stringify(s.data.toString())},health=${JSON.stringify(s.health)};
 globalThis.fetch=async(url,init={})=>{url=String(url);if(init.method&&init.method!=='GET'||init.redirect!=='error')throw Error('method or redirect');
 const prefix='https://api.github.com/repos/huanwujoy-crypto/fee-console/';if(!url.startsWith(prefix))throw Error('financial access forbidden');const route=url.slice(prefix.length);let v,status=200;
 if(route.startsWith('actions/workflows/fee-cloud-producer.yml/runs?')){if(init.headers?.Authorization!=='Bearer '+process.env.FEE_REPORT_ACTIONS_TOKEN)throw Error('missing header');v={total_count:0,workflow_runs:[]};if(/^http[0-9]+$/.test(process.env.SYNTHETIC_CASE||''))status=Number(process.env.SYNTHETIC_CASE.slice(4));if(process.env.SYNTHETIC_CASE==='network')throw Error('private-canary');if(process.env.SYNTHETIC_CASE==='partial')v.total_count=1;}
 else{if(init.headers?.Authorization)throw Error('token escaped action scope');if(route==='git/ref/heads/main')v={object:{sha:'a'.repeat(40)}};else if(route.startsWith('contents/')){const text=route.startsWith('contents/data.json?')?data:route.startsWith('contents/fee-data-health.json?')?JSON.stringify(health):null;if(text===null)throw Error('unknown file');v={type:'file',encoding:'base64',size:Buffer.byteLength(text),content:Buffer.from(text).toString('base64')};}else if(route.startsWith('git/matching-refs/heads/'))v=[];else throw Error('unknown route');}
 const r=new Response(JSON.stringify(v),{status});Object.defineProperty(r,'url',{value:url});return r;};`);
 const workflow=fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml',import.meta.url),'utf8'),period=workflow.split('\n  period:\n')[1].split('\n  once-admit:\n')[0];
 assert.match(period,/permissions:\n      contents: read\n      actions: read/);assert.match(period,/FEE_REPORT_ACTIONS_TOKEN: \$\{\{ github.token \}\}/);
 const workflowJobs=[...workflow.matchAll(/^  ([a-z][a-z-]*):\n([\s\S]*?)(?=^  [a-z][a-z-]*:\n|(?![\s\S]))/gm)];
 const tokenJobs=Object.fromEntries(workflowJobs.map(([,name,body])=>[name,(body.match(/FEE_REPORT_ACTIONS_TOKEN:/g)||[]).length]).filter(([,count])=>count));
 assert.deepEqual(tokenJobs,{period:1,produce:2,'ib-diagnostic':2,'ib-envelope-evidence':2});
 assert.equal((workflow.match(/FEE_REPORT_ACTIONS_TOKEN:/g)||[]).length,7);
 const diagnostic=workflowJobs.find(([,name])=>name==='ib-diagnostic')[2];
 assert.match(diagnostic,/permissions:\n      contents: read\n      actions: read\n      id-token: write/);
 const tokenSteps=[...diagnostic.matchAll(/      - name: ([^\n]+)\n([\s\S]*?)(?=      - name: |(?![\s\S]))/g)].filter(([, ,body])=>body.includes('FEE_REPORT_ACTIONS_TOKEN:'));
 assert.deepEqual(tokenSteps.map(([,name])=>name),['Verify exact one-time diagnostic and frozen baseline before credentials','Inspect Jenny without a writer or publication token']);
 for(const [, ,body]of tokenSteps)assert.equal((body.match(/FEE_REPORT_ACTIONS_TOKEN: \$\{\{ github.token \}\}/g)||[]).length,1);
 assert.doesNotMatch(tokenSteps[0][2],/FEE_DATA_KEY|FEE_CLOUD_SHARESIGHT_CLIENT|FEE_ECON_GIST_ID/);
 const receiver=period.split(`node --input-type=module - "$summary" <<'NODE'\n`)[1].split('\n          NODE')[0].replace(/^          /gm,'');assert.ok(receiver.includes('reportPreflightSummary(r)'));
 const cli=new URL('./fee-report-producer.mjs',import.meta.url).pathname,cwd=path.resolve(path.dirname(cli),'..');
 for(const [kind,expected]of [['ok',null],['http401','HTTP_401'],['http403','HTTP_403'],['http429','HTTP_429'],['http500','HTTP'],['network','NETWORK'],['partial','METADATA_INVALID'],['missing','AUTH_REQUIRED']]){
  const env={PATH:process.env.PATH,FEE_REPORT_ACTIONS_TOKEN:kind==='missing'?'':token,IB_MANAGER_READ_ENABLED:'true',GITHUB_RUN_ID:'1001',GITHUB_RUN_ATTEMPT:'1',SYNTHETIC_CASE:kind};
  const run=spawnSync(process.execPath,['--import',preload,cli,'--mode=preflight','--report-kind=daily','--report-target=2026-11-03','--report-markets=NYSE,NASDAQ'],{env,encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stderr);assert.doesNotMatch(run.stdout+run.stderr,/private-canary|synthetic-ephemeral-token-canary/);const r=JSON.parse(run.stdout);assert.equal(r.outcome,expected?'waiting':'produce');assert.equal(r.metadataCode,expected||undefined);
  const output=path.join(dir,kind+'.output'),summary=path.join(dir,kind+'.summary');
  const received=spawnSync(process.execPath,['--input-type=module','-',run.stdout],{cwd,input:receiver,encoding:'utf8',env:{PATH:process.env.PATH,GITHUB_OUTPUT:output,GITHUB_STEP_SUMMARY:summary},timeout:10000});assert.equal(received.status,0,received.stderr);
  const saved=fs.readFileSync(summary,'utf8');assert.doesNotMatch(saved+received.stdout+received.stderr,/private-canary|synthetic-ephemeral-token-canary/);if(expected){assert.match(saved,new RegExp('Metadata result: '+expected));assert.equal(fs.readFileSync(output,'utf8'),'outcome=waiting\n');}else{assert.match(saved,/Decision: produce/);assert.match(fs.readFileSync(output,'utf8'),/target=2026-11-03/);}
 }
});


const syncRevisionContract='ib-source-revision-20261106-sync-v2',syncRevisionBase='50392c2fb5ec3b1b26e5515cdb0feebb48823d2d';
const wireRevisionContract='ib-source-revision-20261106-sync-v3',wireRevisionBase='b218f264c53e914d6469ec9f43824f48ccb7af18';
const metadataRevisionContract='ib-source-revision-20261106-sync-v4',metadataRevisionBase='ea6ce4dcc6784979a4e5bd526d2a13ac0282ae2e';
function syncRevisionFixture(contractId=syncRevisionContract){
 const metadata=contractId===metadataRevisionContract,wire=contractId===wireRevisionContract,base=metadata?metadataRevisionBase:wire?wireRevisionBase:syncRevisionBase;
 const f=sourceRevisionRecoveryFixture(),manifest=reportHistoricalRecoveryManifest({contractId});
 f.commit.parents=[{sha:base}];f.supportCommit.sha=base;f.supportCommit.parents=[{sha:metadata?'860387709b954fdfc97f040031791258b9fa5b15':wire?'4f98318c73d1727d323febdcc72b7d5fbfb77f01':revisionRecoveryBase}];
 f.comparison.base_commit.sha=f.comparison.merge_base_commit.sha=base;
 f.comparison.files=manifest.map(m=>({filename:m.path,status:m.status,sha:'b'.repeat(40)}));
 f.tree.tree=[f.tree.tree[0],...manifest.map(m=>({path:m.path,type:'blob',mode:'100644',sha:'b'.repeat(40)}))];
 f.reviewedCommit.parents=[{sha:base}];
 f.currentRun=syntheticSyncRun(recoveryHead,recoveryId,'2026-11-07T00:40:00Z');
 f.publication=state(dailyReportPlan('2026-11-05',['NYSE','NASDAQ']),'2026-11-06T01:00:00Z');
 f.publication.mainSha=f.publication.finalMainSha=recoveryHead;f.clock=revisionRecoveryNow;
 return f;
}
function syncRevisionReaders(f,trace=[]){
 const wire=sourceRevisionWire(f,trace),fetchImpl=async(url,init)=>{
  const route=url.split('/fee-console/')[1];
  if(route==='actions/runs/'+recoveryId){
   trace.push(route);assert.equal(init.method,'GET');assert.equal(init.headers.Authorization,'Bearer '+revisionActionsToken);
   const r=new Response(JSON.stringify(f.currentRun));Object.defineProperty(r,'url',{value:url});return r;
  }
  assert(!route?.startsWith('actions/'),'no full Actions listing or fabricated history');return wire(url,init);
 };
 return {readRecoveryRelease:(sha,options)=>readReportRecoveryRelease(sha,{...options,fetchImpl,actionsToken:revisionActionsToken}),
  readCurrentRun:options=>readCurrentSyncRun({...options,fetchImpl,actionsToken:revisionActionsToken}),
  readState:async()=>({...f.publication,data:Buffer.from(f.publication.data)}),clock:()=>f.clock,
  readSourceAttempts:()=>assert.fail('sync admission may not count source attempts')};
}
const syncAdmission=(f,readers=syncRevisionReaders(f))=>authorizeReportRecovery({plan:f.plan,expectedMain:recoveryHead,currentRunId:recoveryId,now:revisionRecoveryNow,actionsToken:revisionActionsToken,...readers});
test('production sync-v4 has exactly six reviewed files and a distinct purpose-free release binding',async()=>{
 const expected=['scripts/fee-report-producer.mjs','scripts/fee-report-producer.test.mjs',
  'scripts/fee-source-revision-runtime.mjs','scripts/fee-source-revision-runtime.test.mjs',
  'scripts/fee-sync-revision-artifacts.mjs','scripts/fee-sync-revision-artifacts.test.mjs'];
 assert.deepEqual(reportHistoricalRecoveryManifest({contractId:metadataRevisionContract}),expected.map(path=>({path,status:'modified'})));
 const f=syncRevisionFixture(metadataRevisionContract),admission=await syncAdmission(f),binding=readHistoricalRevisionAdmission(admission);
 assert.equal(binding.repairBaseSha,metadataRevisionBase);assert.equal(Object.hasOwn(binding,'purpose'),false);
 assert.equal(isHistoricalRevisionDiagnosticAdmission(admission),false);assert.equal(isEnvelopeEvidenceAdmission(admission),false);
 assert.equal(reportHistoricalRecoveryManifest({contractId:wireRevisionContract}).length,10);
 assert.equal(reportHistoricalRecoveryManifest({contractId:rootMetadataDiagnosticContract}).length,6);
 admission.close();
});
test('production sync-v4 rejects wrong base, owner, head, UI and duplicate or changed manifest evidence',async()=>{
 for(const change of [
  f=>f.commit.parents[0].sha='f'.repeat(40),f=>f.commit.author.id=1,f=>f.supportCommit.commit.verification.verified=false,
  f=>f.reviewedCommit.parents[0].sha='860387709b954fdfc97f040031791258b9fa5b15',f=>f.pr.head.sha='f'.repeat(40),
  f=>f.tree.tree[0].sha='f'.repeat(40),f=>f.tree.tree.push({...f.tree.tree[0]}),f=>f.tree.truncated=true,
  f=>f.comparison.files[1]={...f.comparison.files[0]},f=>f.comparison.files[0].sha='f'.repeat(40),
  f=>f.comments[0].body='/approve-xuan-ib-maintenance '+'f'.repeat(40),f=>f.comments[0].body='prefix\n'+f.comments[0].body,
  f=>f.ref.object.sha=metadataRevisionBase,
 ]){
  const f=syncRevisionFixture(metadataRevisionContract);change(f);
  await assert.rejects(syncAdmission(f,{...syncRevisionReaders(f),readCurrentRun:()=>assert.fail('invalid release must stop before run reads')}),/RECOVERY_/);
 }
});
test('production sync-v4 keeps pending, already-published and original UTC freshness boundaries',async()=>{
 for(const change of [f=>f.publication.pending=true,f=>f.publication.health.targetDate='2026-11-06',f=>f.publication.data=Buffer.from('changed')]){
  const f=syncRevisionFixture(metadataRevisionContract);change(f);await assert.rejects(syncAdmission(f),/RECOVERY_SCOPE/);
 }
 const f=syncRevisionFixture(metadataRevisionContract);f.clock=new Date('2026-11-10T23:59:59.999Z');
 const admission=await authorizeReportRecovery({plan:f.plan,expectedMain:recoveryHead,currentRunId:recoveryId,
  now:f.clock,actionsToken:revisionActionsToken,...syncRevisionReaders(f)});
 f.clock=new Date('2026-11-11T00:00:00.000Z');await assert.rejects(admission.checkCurrent(),/RECOVERY_SCOPE/);
 assert.equal(isHistoricalRevisionAdmission(admission),false);
 await assert.rejects(authorizeReportRecovery({plan:f.plan,expectedMain:recoveryHead,currentRunId:recoveryId,
  now:f.clock,actionsToken:revisionActionsToken,...syncRevisionReaders(f)}),/RECOVERY_SCOPE/);
});
for(const contractId of [syncRevisionContract,wireRevisionContract,metadataRevisionContract]){
test(contractId+' sync revision binds real owner release, target, current execution and publication without inventing consumption',async()=>{
 const f=syncRevisionFixture(contractId),trace=[],admission=await syncAdmission(f,syncRevisionReaders(f,trace));
 const binding=readHistoricalRevisionAdmission(admission);assert.equal(binding.contractId,contractId);
 assert.equal(binding.admissionModel,'sync-cycle-v1');assert.match(binding.executionSha256,/^[a-f0-9]{64}$/);
 assert.equal(binding.consumptionSha256,undefined);assert.equal(binding.currentRunId,recoveryId);assert.equal(binding.approvedHead,revisionReviewedHead);
 assert.deepEqual(await admission.checkCurrent(),binding);assert.equal(trace.filter(x=>x==='actions/runs/'+recoveryId).length,2);
 assert(!trace.some(x=>x.includes('/runs?')||x.includes('/jobs')));assert.equal(isHistoricalRevisionAdmission({...admission}),false);
 const release=await syncRevisionReaders(f).readRecoveryRelease(recoveryHead,{actionsToken:revisionActionsToken});
 await assert.rejects(readPeriodSourceAttempts({plan:f.plan,now:revisionRecoveryNow,currentRunId:recoveryId,recoveryMain:recoveryHead,recoveryRelease:release}),/RECOVERY_SCOPE/);
 assert.throws(()=>validateReportRecoveryEvidence({plan:f.plan,expectedMain:recoveryHead,currentRunId:recoveryId,release,budget:{attempts:0,recoveryEvidence:{entries:[],reservations:[]}}}),/RECOVERY_SCOPE/);
 admission.close();await assert.rejects(admission.checkCurrent(),/RECOVERY_CONSUMED/);
});
test(contractId+' new revision release requires exact complete manifest, real approval and unique direct successor',async()=>{
 for(const change of [f=>f.commit.parents.push({sha:revisionRecoveryBase}),f=>f.supportCommit.parents[0].sha='f'.repeat(40),
  f=>f.comparison.files.pop(),f=>f.comparison.files[0].status='added',f=>f.tree.tree[1].mode='120000',
  f=>f.comments=[],f=>f.comments[0].user.id=1,f=>f.reviewedCommit.commit.tree.sha='f'.repeat(40),f=>f.commit.commit.verification.verified=false]){
  const f=syncRevisionFixture(contractId);change(f);await assert.rejects(syncAdmission(f),/RECOVERY_/);
 }
 const f=syncRevisionFixture(contractId),readers=syncRevisionReaders(f),real=readers.readRecoveryRelease;
 await assert.rejects(syncAdmission(f,{...readers,readRecoveryRelease:async(...a)=>structuredClone(await real(...a))}),/RECOVERY_SCOPE/);
});
test(contractId+' sync revision stops on changed publication, run identity, approval, timing or source base and revokes capability',async()=>{
 const mutations=[f=>f.currentRun.id++,f=>f.currentRun.head_sha=revisionRecoveryBase,f=>f.currentRun.actor.id=1,
  f=>f.currentRun.triggering_actor.id=1,f=>f.currentRun.run_attempt=2,f=>f.currentRun.event='schedule',f=>f.currentRun.path='other',
  f=>f.currentRun.repository.full_name='other/repo',f=>f.currentRun.status='completed',f=>f.currentRun.conclusion='failure',
  f=>f.currentRun.created_at='2026-11-08T00:00:00Z',f=>f.publication.pending=true,f=>f.publication.finalMainSha=revisionRecoveryBase,
  f=>f.publication.health.targetDate='2026-11-06',f=>f.publication.data=Buffer.from('changed'),f=>f.publication.health.checkedAt='bad',
  f=>f.comments[0].body+=' changed',f=>f.ref.object.sha=revisionRecoveryBase,f=>f.plan.periodFrom='2026-11-05',f=>f.clock=new Date('2026-11-12T00:00:00Z')];
 for(const mutate of mutations){
  const f=syncRevisionFixture(contractId),admission=await syncAdmission(f);mutate(f);
  await assert.rejects(admission.checkCurrent(),/RECOVERY_/);assert.equal(isHistoricalRevisionAdmission(admission),false);
  await assert.rejects(admission.checkCurrent(),/RECOVERY_CONSUMED/);
 }
});
}
test('confirmed entry preserves published, pending, rerun and current execution identity gates without any history call',async()=>{
 const f=confirmedDailyFixture(),prior=state(dailyReportPlan('2026-11-02',['NYSE','NASDAQ']),'2026-11-03T01:00:00Z'),now=new Date('2026-11-04T00:00:00Z');
 const args={targetDate:f.target,reviewedSyncDate:f.target,confirmedMain:f.head,now,markets:['NYSE','NASDAQ'],ibEnabled:false,runAttempt:'1',currentRunId:1001,
  readState:async()=>prior,readCurrentRun:async()=>syntheticSyncRun(),readSourceAttempts:()=>assert.fail('no history query')};
 assert.equal((await dailyPublicationPreflight({...args,readState:async()=>({...prior,pending:true}),readCurrentRun:()=>assert.fail('pending stops first')})).outcome,'candidate-pending');
 assert.equal((await dailyPublicationPreflight({...args,runAttempt:'2',readCurrentRun:()=>assert.fail('rerun stops first')})).reasonCode,'REPORT_SOURCE_RERUN_NOT_ALLOWED');
 const published=state(dailyReportPlan(f.target,args.markets),'2026-11-04T01:00:00Z');
 assert.equal((await dailyPublicationPreflight({...args,now:new Date('2026-11-04T02:00:00Z'),readState:async()=>published,readCurrentRun:()=>assert.fail('published stops first')})).outcome,'already-published');
 for(const change of [r=>r.actor.id=1,r=>r.head_sha='b'.repeat(40),r=>r.run_attempt=2,r=>r.repository.full_name='other/repo',r=>r.event='schedule',r=>r.status='completed']){
  const run=syntheticSyncRun();change(run);await assert.rejects(dailyPublicationPreflight({...args,readCurrentRun:async()=>run}),/RECOVERY_RUN/);
 }
 await assert.rejects(dailyPublicationPreflight({...args,readCurrentRun:async()=>{throw Error('synthetic unavailable');}}));
});
test('before financial access confirmed publication and current run are rechecked, including pending and already-published',async()=>{
 const f=confirmedDailyFixture(),plan=dailyReportPlan(f.target,['NYSE','NASDAQ'],{reviewedSyncDate:f.target}),prior=state(dailyReportPlan('2026-11-02',['NYSE','NASDAQ']),'2026-11-03T01:00:00Z');
 const args={...f.args,mode:'produce'},options={env:{...f.env,REPORT_PLAN:JSON.stringify(plan)},readEvent:()=>f.event,now:new Date('2026-11-04T00:00:00Z'),
  readCurrentRun:async()=>syntheticSyncRun(),readState:async()=>prior,fetchImpl:async url=>{const r=new Response(JSON.stringify({ref:'refs/heads/main',object:{type:'commit',sha:f.head}}));Object.defineProperty(r,'url',{value:url});return r;}};
 for(const changed of [{pending:true},{finalMainSha:'b'.repeat(40)},{health:{...prior.health,targetDate:f.target}},{data:Buffer.from('changed')}]){
  await assert.rejects(confirmReviewedMainBeforeSource(args,{...options,readState:async()=>({...prior,...changed})}),/RECOVERY_SCOPE/);
 }
});

test('real confirmed CLI and pre-WIF entry use only bound run and public publication reads',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-sync-cycle-cli-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const f=confirmedDailyFixture(),plan=dailyReportPlan(f.target,['NYSE','NASDAQ'],{reviewedSyncDate:f.target});
 const old=state(dailyReportPlan('2026-11-02',['NYSE','NASDAQ']),'2026-11-03T01:00:00Z');
 const eventFile=path.join(dir,'event.json'),trace=path.join(dir,'routes.json'),preload=path.join(dir,'synthetic-only.mjs');
 fs.writeFileSync(eventFile,JSON.stringify(f.event));
 const token='synthetic-single-current-run-token';
 fs.writeFileSync(preload,`import fs from 'node:fs';
 const D=Date,now=D.parse('2026-11-04T00:00:00Z');globalThis.Date=class extends D{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}};
 const main=${JSON.stringify(f.head)},token=${JSON.stringify(token)},routes=[],trace=${JSON.stringify(trace)};
 const originals={'data.json':${JSON.stringify(old.data.toString())},'fee-data-health.json':${JSON.stringify(JSON.stringify(old.health))}};
 const originalRead=fs.readFileSync;fs.readFileSync=function(p,...args){if(String(p)===${JSON.stringify(new URL('../data.json',import.meta.url).pathname)})throw Error('private source access forbidden by synthetic test');return originalRead.call(this,p,...args);};
 globalThis.fetch=async(url,init)=>{
  const prefix='https://api.github.com/repos/huanwujoy-crypto/fee-console/';if(!url.startsWith(prefix)||!['GET',undefined].includes(init.method))throw Error('non-public operation forbidden');
  const route=url.slice(prefix.length);routes.push(route);fs.writeFileSync(trace,JSON.stringify(routes));let value;
  if(route==='git/ref/heads/main')value={ref:'refs/heads/main',object:{type:'commit',sha:main}};
  else if(route.startsWith('contents/')){const name=route.slice(9).split('?')[0],bytes=Buffer.from(originals[name]||'');if(!bytes.length||!route.endsWith('?ref='+main))throw Error('bad artifact');value={type:'file',encoding:'base64',size:bytes.length,content:bytes.toString('base64')};}
  else if(route==='git/matching-refs/heads/codex/fee-daily-20261103-')value=[];
  else if(route==='actions/runs/1001'){if(init.headers.Authorization!=='Bearer '+token)throw Error('wrong scoped token');value=${JSON.stringify(syntheticSyncRun())};}
  else throw Error('collection queries forbidden');
  const r=new Response(JSON.stringify(value));Object.defineProperty(r,'url',{value:url});return r;
 };`);
 const env={PATH:process.env.PATH,...f.env,GITHUB_EVENT_PATH:eventFile,FEE_REPORT_ACTIONS_TOKEN:token,REPORT_PLAN:JSON.stringify(plan),FEE_REPORT_MARKETS:'NYSE,NASDAQ'};
 const cli=Object.entries(f.args).map(([k,v])=>'--'+k+'='+v),file=new URL('./fee-report-producer.mjs',import.meta.url).pathname;
 const preflight=spawnSync(process.execPath,['--import',preload,file,...cli],{env,encoding:'utf8',timeout:10000});
 assert.equal(preflight.status,0,preflight.stderr);assert.equal(JSON.parse(preflight.stdout).outcome,'produce');assert(!preflight.stdout.includes(token));
 const gate=spawnSync(process.execPath,['--import',preload,'--input-type=module','-e',`import {confirmReviewedMainBeforeSource} from ${JSON.stringify(new URL('./fee-report-producer.mjs',import.meta.url).href)};await confirmReviewedMainBeforeSource(${JSON.stringify({...f.args,mode:'produce'})},{checkedOutMain:process.env.PLANNED_MAIN});console.log('verified');`],{env,encoding:'utf8',timeout:10000});
 assert.equal(gate.status,0,gate.stderr);assert.equal(gate.stdout.trim(),'verified');
 const calls=JSON.parse(fs.readFileSync(trace));assert(calls.includes('actions/runs/1001'));assert(calls.includes('git/matching-refs/heads/codex/fee-daily-20261103-'));
 assert(!calls.some(x=>x.includes('/runs?')||x.includes('/jobs')||x.includes('sharesight')));
});


test('closing sync admission during current-run IO stops before the next publication read',async()=>{
 const f=syncRevisionFixture(),readers=syncRevisionReaders(f);let runReads=0,publicationReads=0,releaseRun,enteredRun;
 const entered=new Promise(resolve=>enteredRun=resolve),blocked=new Promise(resolve=>releaseRun=resolve);
 const admission=await syncAdmission(f,{...readers,readCurrentRun:async args=>{if(++runReads===2){enteredRun();await blocked;}return readers.readCurrentRun(args);},
  readState:async(...args)=>{publicationReads++;return readers.readState(...args);}});
 const checking=admission.checkCurrent();await entered;admission.close();releaseRun();
 await assert.rejects(checking,/RECOVERY_CONSUMED/);assert.equal(publicationReads,1);assert.equal(isHistoricalRevisionAdmission(admission),false);
});

const diagnosticRevisionContract='ib-source-revision-20261106-diagnostic-v1';
const diagnosticRevisionBase='4f98318c73d1727d323febdcc72b7d5fbfb77f01';
const economicDiagnosticContract='ib-source-revision-20261106-diagnostic-v2';
const economicDiagnosticBase='22174f04cae8ac18a071930f491598b327e315c5';
const cashDiagnosticContract='ib-source-revision-20261106-diagnostic-v3';
const cashDiagnosticBase='f1d4454d25849e1908ba508f8c7f140389e425bb';
const incomeBoundaryDiagnosticContract='ib-source-revision-20261106-diagnostic-v4';
const incomeBoundaryDiagnosticBase='e30015d7260e43622f8ad63a119b0efbef35acb4';
const sourceStabilityDiagnosticContract='ib-source-revision-20261106-diagnostic-v5';
const sourceStabilityDiagnosticBase='b72cd6895c5990e4bb644b26f181d9f78313ca72';
const recordOrderDiagnosticContract='ib-source-revision-20261106-diagnostic-v6';
const recordOrderDiagnosticBase='05731b04e8a0728a38ae773ea46194879c20fcc4';
const catalogEvidenceDiagnosticContract='ib-source-revision-20261106-diagnostic-v7';
const catalogEvidenceDiagnosticBase='4d569f5c4aacbe4b75a760805de3ca1b5b3d5f6d';
const rootMetadataDiagnosticContract='ib-source-revision-20261106-diagnostic-v8';
const rootMetadataDiagnosticBase='860387709b954fdfc97f040031791258b9fa5b15';
function diagnosticRevisionFixture(contractId=diagnosticRevisionContract){
 const metadata=contractId===rootMetadataDiagnosticContract,catalog=contractId===catalogEvidenceDiagnosticContract,order=contractId===recordOrderDiagnosticContract,stability=contractId===sourceStabilityDiagnosticContract,boundary=contractId===incomeBoundaryDiagnosticContract,cash=contractId===cashDiagnosticContract,economic=contractId===economicDiagnosticContract,base=metadata?rootMetadataDiagnosticBase:catalog?catalogEvidenceDiagnosticBase:order?recordOrderDiagnosticBase:stability?sourceStabilityDiagnosticBase:boundary?incomeBoundaryDiagnosticBase:cash?cashDiagnosticBase:economic?economicDiagnosticBase:diagnosticRevisionBase;
 const f=syncRevisionFixture(),manifest=reportHistoricalRecoveryManifest({contractId});
 f.commit.parents=[{sha:base}];f.supportCommit.sha=base;f.supportCommit.parents=[{sha:metadata?'97101f6f75f7e5295acd232f7d69c32594ec4044':catalog?recordOrderDiagnosticBase:order?sourceStabilityDiagnosticBase:stability?incomeBoundaryDiagnosticBase:boundary?cashDiagnosticBase:cash?economicDiagnosticBase:economic?wireRevisionBase:syncRevisionBase}];
 f.comparison.base_commit.sha=f.comparison.merge_base_commit.sha=base;
 f.comparison.files=manifest.map(m=>({filename:m.path,status:m.status,sha:'b'.repeat(40)}));
 f.tree.tree=[f.tree.tree[0],...manifest.map(m=>({path:m.path,type:'blob',mode:'100644',sha:'b'.repeat(40)}))];
 f.reviewedCommit.parents=[{sha:base}];f.currentRun.display_title='IB diagnostic 2026-11-06';
 return f;
}
const diagnosticAdmission=(f,readers=syncRevisionReaders(f))=>authorizeHistoricalRevisionDiagnostic({plan:f.plan,expectedMain:recoveryHead,
 currentRunId:recoveryId,now:revisionRecoveryNow,actionsToken:revisionActionsToken,...readers});

test('metadata diagnostic v8 binds only the six reviewed code/test files after lexical v4',()=>{
 const expected=['scripts/fee-report-producer.mjs','scripts/fee-report-producer.test.mjs',
  'scripts/fee-source-revision-runtime.mjs','scripts/fee-source-revision-runtime.test.mjs',
  'scripts/fee-sync-revision-artifacts.mjs','scripts/fee-sync-revision-artifacts.test.mjs'];
 const manifest=reportHistoricalRecoveryManifest({contractId:rootMetadataDiagnosticContract});
 assert.deepEqual(manifest,expected.map(path=>({path,status:'modified'})));
 assert(Object.isFrozen(manifest));assert(manifest.every(Object.isFrozen));
 assert(!manifest.some(x=>/lexical|envelope|workflow|security|data\.json/.test(x.path)));
 assert.equal(reportHistoricalRecoveryManifest({contractId:catalogEvidenceDiagnosticContract}).length,13);
});
test('metadata diagnostic v8 rejects duplicate or drifted release evidence before current-run reads',async()=>{
 for(const change of [
  f=>f.comparison.files[1]={...f.comparison.files[0]},f=>f.tree.tree.push({...f.tree.tree[0]}),
  f=>f.tree.tree[0].sha='f'.repeat(40),f=>f.comparison.files[0].sha='f'.repeat(40),
  f=>f.commit.author.id=1,f=>f.supportCommit.author.id=1,f=>f.supportCommit.commit.verification.verified=false,
  f=>f.reviewedCommit.parents[0].sha='97101f6f75f7e5295acd232f7d69c32594ec4044',
  f=>f.comments[0].body='explanation\n'+f.comments[0].body,
 ]){
  const f=diagnosticRevisionFixture(rootMetadataDiagnosticContract);change(f);
  await assert.rejects(diagnosticAdmission(f,{...syncRevisionReaders(f),readCurrentRun:()=>assert.fail('release must reject before run reads')}),/RECOVERY_/);
 }
});
test('metadata diagnostic v8 retains the original four-day UTC target limit',async()=>{
 const f=diagnosticRevisionFixture(rootMetadataDiagnosticContract),readers=syncRevisionReaders(f);
 f.clock=new Date('2026-11-10T23:59:59.999Z');
 const admission=await authorizeHistoricalRevisionDiagnostic({plan:f.plan,expectedMain:recoveryHead,currentRunId:recoveryId,
  now:f.clock,actionsToken:revisionActionsToken,...readers});
 assert.equal(isHistoricalRevisionDiagnosticAdmission(admission),true);
 f.clock=new Date('2026-11-11T00:00:00.000Z');
 await assert.rejects(admission.checkCurrent(),/RECOVERY_SCOPE/);
 assert.equal(isHistoricalRevisionDiagnosticAdmission(admission),false);
 await assert.rejects(authorizeHistoricalRevisionDiagnostic({plan:f.plan,expectedMain:recoveryHead,currentRunId:recoveryId,
  now:f.clock,actionsToken:revisionActionsToken,...syncRevisionReaders(f)}),/RECOVERY_SCOPE/);
});

test('read-only revision release has its own exact fifteen-file manifest and preserves older scopes',()=>{
 const expected=[
  ...['.github/workflows/fee-cloud-producer.yml','.github/workflows/scripts-check.yml','security/approval-tiers.json',
   'docs/fee-source-revision.md','scripts/fee-cloud-producer.mjs','scripts/fee-report-producer.mjs','scripts/fee-report-producer.test.mjs',
   'scripts/fee-source-revision-runtime.mjs','scripts/fee-sync-revision-artifacts.mjs','scripts/fee-sync-revision-artifacts.test.mjs',
   'scripts/fee-sync-revision-github.mjs','scripts/fee-sync-revision-github.test.mjs','scripts/ib-manager-source.test.mjs'].map(path=>({path,status:'modified'})),
  ...['scripts/fee-source-revision-diagnostic.mjs','scripts/fee-source-revision-diagnostic.test.mjs'].map(path=>({path,status:'added'})),
 ];
 const manifest=reportHistoricalRecoveryManifest({contractId:diagnosticRevisionContract});assert.deepEqual(manifest,expected);
 assert.equal(manifest.length,15);assert(Object.isFrozen(manifest));assert(manifest.every(Object.isFrozen));
 assert.equal(reportHistoricalRecoveryManifest().length,17);assert.equal(reportHistoricalRecoveryManifest({contractId:syncRevisionContract}).length,14);
 assert(!reportHistoricalRecoveryManifest({contractId:syncRevisionContract}).some(x=>x.path==='scripts/fee-source-revision-diagnostic.mjs'));
});

test('economic diagnosis has a distinct exact thirteen-file manifest without granting a new production release',()=>{
 const expected=['docs/fee-source-revision.md','scripts/fee-economic-source.mjs','scripts/fee-economic-source.test.mjs',
  'scripts/fee-report-producer.mjs','scripts/fee-report-producer.test.mjs',
  'scripts/fee-source-revision-diagnostic.mjs','scripts/fee-source-revision-diagnostic.test.mjs',
  'scripts/fee-source-revision-runtime.mjs','scripts/fee-source-revision-runtime.test.mjs',
  'scripts/fee-sync-revision-artifacts.mjs','scripts/fee-sync-revision-artifacts.test.mjs',
  'scripts/ib-manager-source.mjs','scripts/ib-manager-source.test.mjs'];
 const manifest=reportHistoricalRecoveryManifest({contractId:economicDiagnosticContract});
 assert.deepEqual(manifest,expected.map(path=>({path,status:'modified'})));assert.equal(manifest.length,13);
 assert(Object.isFrozen(manifest));assert(manifest.every(Object.isFrozen));
 assert.equal(reportHistoricalRecoveryManifest({contractId:diagnosticRevisionContract}).length,15);
 assert.equal(reportHistoricalRecoveryManifest({contractId:wireRevisionContract}).length,10);
 assert.equal(reportHistoricalRecoveryManifest({contractId:syncRevisionContract}).length,14);
 assert.equal(reportHistoricalRecoveryManifest().length,17);
 assert(!manifest.some(x=>/^(?:data\.json|fee-data-health\.json|index\.html|security\/|cloud\/|\.github\/)/.test(x.path)));
});

test('new diagnostic release cannot substitute previous contract, base, tree, manifest or owner approval',async()=>{
 const mutations=[
  f=>f.commit.parents[0].sha=wireRevisionBase,
  f=>f.supportCommit.parents[0].sha=diagnosticRevisionBase,
  f=>f.comparison.files=reportHistoricalRecoveryManifest({contractId:diagnosticRevisionContract}).map(m=>({filename:m.path,status:m.status,sha:'b'.repeat(40)})),
  f=>f.comparison.files=reportHistoricalRecoveryManifest({contractId:wireRevisionContract}).map(m=>({filename:m.path,status:m.status,sha:'b'.repeat(40)})),
  f=>f.comparison.files[0].filename='data.json',f=>f.comparison.files[0].filename='security/approval-tiers.json',
  f=>f.tree.tree[0].sha='f'.repeat(40),f=>f.comparison.total_commits=2,
  f=>f.comments[0].body='/approve-xuan-ib-maintenance '+wireRevisionBase,
  f=>f.reviewedCommit.parents[0].sha=wireRevisionBase,
 ];
 for(const mutate of mutations){const f=diagnosticRevisionFixture(economicDiagnosticContract);mutate(f);
  await assert.rejects(diagnosticAdmission(f,{...syncRevisionReaders(f),readCurrentRun:()=>assert.fail('wrong release must stop before execution or private reads')}),/RECOVERY_/);
 }
 const f=diagnosticRevisionFixture(economicDiagnosticContract),readers=syncRevisionReaders(f),real=readers.readRecoveryRelease;
 for(const contractId of [diagnosticRevisionContract,wireRevisionContract]){
  await assert.rejects(diagnosticAdmission(f,{...readers,readRecoveryRelease:async(...args)=>({...await real(...args),contractId}),
   readCurrentRun:()=>assert.fail('copied contract cannot acquire admission')}),/RECOVERY_SCOPE/);
 }
});

test('cash diagnostic has an exact eleven-file manifest and preserves every prior release',()=>{
 const expected=['docs/fee-source-revision.md','scripts/fee-report-producer.mjs','scripts/fee-report-producer.test.mjs',
  'scripts/fee-source-revision-diagnostic.mjs','scripts/fee-source-revision-diagnostic.test.mjs',
  'scripts/fee-source-revision-runtime.mjs','scripts/fee-source-revision-runtime.test.mjs',
  'scripts/fee-sync-revision-artifacts.mjs','scripts/fee-sync-revision-artifacts.test.mjs',
  'scripts/ib-manager-source-revision.mjs','scripts/ib-manager-source-revision.test.mjs'];
 const manifest=reportHistoricalRecoveryManifest({contractId:cashDiagnosticContract});
 assert.deepEqual(manifest,expected.map(path=>({path,status:'modified'})));assert.equal(manifest.length,11);
 assert(Object.isFrozen(manifest));assert(manifest.every(Object.isFrozen));
 assert.equal(reportHistoricalRecoveryManifest({contractId:economicDiagnosticContract}).length,13);
 assert.equal(reportHistoricalRecoveryManifest({contractId:diagnosticRevisionContract}).length,15);
 assert.equal(reportHistoricalRecoveryManifest({contractId:wireRevisionContract}).length,10);
 assert.equal(reportHistoricalRecoveryManifest({contractId:syncRevisionContract}).length,14);
 assert(!manifest.some(x=>/^(?:data\.json|fee-data-health\.json|index\.html|security\/|cloud\/|\.github\/)/.test(x.path)));
});

test('cash diagnostic cannot relabel old bases, manifests or capabilities as the new reviewed release',async()=>{
 for(const oldContract of [diagnosticRevisionContract,economicDiagnosticContract,wireRevisionContract]){
  const f=diagnosticRevisionFixture(cashDiagnosticContract);
  f.comparison.files=reportHistoricalRecoveryManifest({contractId:oldContract}).map(m=>({filename:m.path,status:m.status,sha:'b'.repeat(40)}));
  await assert.rejects(diagnosticAdmission(f,{...syncRevisionReaders(f),readCurrentRun:()=>assert.fail('old manifest stops before run or private reads')}),/RECOVERY_/);
 }
 for(const mutate of [f=>f.commit.parents[0].sha=economicDiagnosticBase,f=>f.supportCommit.parents[0].sha=wireRevisionBase,
  f=>f.reviewedCommit.parents[0].sha=economicDiagnosticBase,f=>f.comments[0].body='/approve-xuan-ib-maintenance '+economicDiagnosticBase]){
  const f=diagnosticRevisionFixture(cashDiagnosticContract);mutate(f);
  await assert.rejects(diagnosticAdmission(f,{...syncRevisionReaders(f),readCurrentRun:()=>assert.fail('old binding stops before run or private reads')}),/RECOVERY_/);
 }
 const f=diagnosticRevisionFixture(cashDiagnosticContract),readers=syncRevisionReaders(f),real=readers.readRecoveryRelease;
 for(const contractId of [diagnosticRevisionContract,economicDiagnosticContract])await assert.rejects(diagnosticAdmission(f,{...readers,
  readRecoveryRelease:async(...args)=>({...await real(...args),contractId}),readCurrentRun:()=>assert.fail('copied release cannot acquire admission')}),/RECOVERY_SCOPE/);
});

test('catalog-evidence diagnostic v7 is pinned to the real main 4d569f5 and its exact own file manifest',()=>{
 const expected=[
  ['docs/fee-source-revision.md','modified'],
  ['docs/fee-unified-source-readiness.md','modified'],
  ['scripts/fee-report-producer.mjs','modified'],
  ['scripts/fee-report-producer.test.mjs','modified'],
  ['scripts/fee-source-lexical.mjs','modified'],
  ['scripts/fee-source-lexical.test.mjs','modified'],
  ['scripts/fee-source-revision-diagnostic.mjs','modified'],
  ['scripts/fee-source-revision-runtime.mjs','modified'],
  ['scripts/fee-source-revision-runtime.test.mjs','modified'],
  ['scripts/fee-sync-captured-inputs.mjs','modified'],
  ['scripts/fee-sync-revision-artifacts.mjs','modified'],
  ['scripts/fee-sync-revision-artifacts.test.mjs','modified'],
  ['scripts/ib-manager-source.mjs','modified'],
 ];
 const manifest=reportHistoricalRecoveryManifest({contractId:catalogEvidenceDiagnosticContract});
 assert.deepEqual(manifest,expected.map(([path,status])=>({path,status})));
 assert(Object.isFrozen(manifest));assert(manifest.every(Object.isFrozen));
 // The consumed v6 admission keeps its own unchanged 12-file manifest and base.
 assert.equal(reportHistoricalRecoveryManifest({contractId:recordOrderDiagnosticContract}).length,12);
});
test('record-order diagnostic v6 is pinned to the real main 05731b0 and its exact own file manifest',()=>{
 const expected=[
  ['docs/fee-source-revision.md','modified'],
  ['docs/fee-unified-source-readiness.md','modified'],
  ['scripts/fee-report-producer.mjs','modified'],
  ['scripts/fee-report-producer.test.mjs','modified'],
  ['scripts/fee-source-lexical.mjs','modified'],
  ['scripts/fee-source-lexical.test.mjs','modified'],
  ['scripts/fee-source-revision-runtime.mjs','modified'],
  ['scripts/fee-source-revision-runtime.test.mjs','modified'],
  ['scripts/fee-sync-captured-inputs.mjs','modified'],
  ['scripts/fee-sync-revision-artifacts.mjs','modified'],
  ['scripts/fee-sync-revision-artifacts.test.mjs','modified'],
  ['scripts/ib-manager-source.mjs','modified'],
 ];
 const manifest=reportHistoricalRecoveryManifest({contractId:recordOrderDiagnosticContract});
 assert.deepEqual(manifest,expected.map(([path,status])=>({path,status})));
 assert(Object.isFrozen(manifest));assert(manifest.every(Object.isFrozen));
 // The consumed v5 admission keeps its own unchanged 20-file manifest and base.
 assert.equal(reportHistoricalRecoveryManifest({contractId:sourceStabilityDiagnosticContract}).length,20);
});
test('source-stability diagnostic v5 is pinned to the real released main and its exact own file manifest',()=>{
 const expected=[
  ['.github/workflows/scripts-check.yml','modified'],
  ['docs/fee-source-revision.md','modified'],
  ['docs/fee-unified-source-readiness.md','modified'],
  ['scripts/fee-cloud-source.mjs','modified'],
  ['scripts/fee-report-producer.mjs','modified'],
  ['scripts/fee-report-producer.test.mjs','modified'],
  ['scripts/fee-source-lexical.mjs','added'],
  ['scripts/fee-source-lexical.test.mjs','added'],
  ['scripts/fee-source-revision-runtime.mjs','modified'],
  ['scripts/fee-source-revision-runtime.test.mjs','modified'],
  ['scripts/fee-sync-captured-inputs.mjs','modified'],
  ['scripts/fee-sync-date-policy.mjs','added'],
  ['scripts/fee-sync-date-policy.test.mjs','added'],
  ['scripts/fee-sync-readiness.mjs','modified'],
  ['scripts/fee-sync-revision-artifacts.mjs','modified'],
  ['scripts/fee-sync-revision-artifacts.test.mjs','modified'],
  ['scripts/fee-sync-test-fixtures.mjs','modified'],
  ['scripts/ib-manager-source.mjs','modified'],
  ['scripts/ib-manager-source.test.mjs','modified'],
  ['security/approval-tiers.json','modified'],
 ];
 const manifest=reportHistoricalRecoveryManifest({contractId:sourceStabilityDiagnosticContract});
 assert.deepEqual(manifest,expected.map(([path,status])=>({path,status})));
 assert(Object.isFrozen(manifest));assert(manifest.every(Object.isFrozen));
 // The consumed v4 admission keeps its own unchanged manifest and base.
 assert.equal(reportHistoricalRecoveryManifest({contractId:incomeBoundaryDiagnosticContract}).length,10);
});
for(const contractId of [diagnosticRevisionContract,economicDiagnosticContract,cashDiagnosticContract,incomeBoundaryDiagnosticContract,sourceStabilityDiagnosticContract,recordOrderDiagnosticContract,catalogEvidenceDiagnosticContract,rootMetadataDiagnosticContract]){
test(contractId+' diagnostic admission is authentic, read-only, execution-bound and never a production admission',async()=>{
 const f=diagnosticRevisionFixture(contractId),before=JSON.stringify(f),trace=[],readers=syncRevisionReaders(f,trace),admission=await diagnosticAdmission(f,readers);
 assert.equal(isHistoricalRevisionDiagnosticAdmission(admission),true);assert.equal(isHistoricalRevisionAdmission(admission),false);
 assert.equal(Object.isFrozen(admission),true);assert.equal(JSON.stringify(admission),'{}');
 assert.throws(()=>readHistoricalRevisionAdmission(admission),/RECOVERY_SCOPE/);
 const binding=readHistoricalRevisionDiagnosticAdmission(admission);assert.equal(binding.contractId,contractId);
 assert.equal(binding.purpose,'read-only-diagnostic');assert.equal(binding.admissionModel,'sync-cycle-v1');assert.equal(binding.mainSha,recoveryHead);
 assert.equal(binding.repairBaseSha,contractId===rootMetadataDiagnosticContract?rootMetadataDiagnosticBase:contractId===catalogEvidenceDiagnosticContract?catalogEvidenceDiagnosticBase:contractId===recordOrderDiagnosticContract?recordOrderDiagnosticBase:contractId===sourceStabilityDiagnosticContract?sourceStabilityDiagnosticBase:contractId===incomeBoundaryDiagnosticContract?incomeBoundaryDiagnosticBase:contractId===cashDiagnosticContract?cashDiagnosticBase:contractId===economicDiagnosticContract?economicDiagnosticBase:diagnosticRevisionBase);assert.equal(binding.targetDate,'2026-11-06');assert.equal(binding.currentRunId,recoveryId);
 assert.equal(binding.approvedHead,revisionReviewedHead);assert.match(binding.executionSha256,/^[a-f0-9]{64}$/);assert.equal(Object.hasOwn(binding,'consumptionSha256'),false);
 assert(Object.isFrozen(binding));assert.deepEqual(await admission.checkCurrent(),binding);assert.equal(JSON.stringify(f),before);
 assert.equal(trace.filter(x=>x==='actions/runs/'+recoveryId).length,2);
 assert(!trace.some(x=>x.includes('/runs?')||x.includes('/jobs')||x.includes('sharesight')||x.includes('git/refs')));
 for(const forged of [{},{...admission},structuredClone(binding),{...binding,checkCurrent:async()=>binding},new Proxy(admission,{})]){
  assert.equal(isHistoricalRevisionDiagnosticAdmission(forged),false);assert.equal(isHistoricalRevisionAdmission(forged),false);
  assert.throws(()=>readHistoricalRevisionDiagnosticAdmission(forged),/RECOVERY_SCOPE/);
 }
 admission.close();assert.equal(isHistoricalRevisionDiagnosticAdmission(admission),false);assert.throws(()=>readHistoricalRevisionDiagnosticAdmission(admission),/RECOVERY_SCOPE/);
 const calls=trace.length;await assert.rejects(admission.checkCurrent(),/RECOVERY_CONSUMED/);assert.equal(trace.length,calls);
});

test(contractId+' diagnostic scope cannot enter production, legacy attempt enumeration or fabricated consumption validation',async()=>{
 const f=diagnosticRevisionFixture(contractId),trace=[],readers=syncRevisionReaders(f,trace);let attempts=0,runReads=0,stateReads=0;
 await assert.rejects(authorizeReportRecovery({plan:f.plan,expectedMain:recoveryHead,currentRunId:recoveryId,now:revisionRecoveryNow,
  actionsToken:revisionActionsToken,...readers,readSourceAttempts:()=>{attempts++;assert.fail('diagnostic must not enumerate consumption');},
  readCurrentRun:()=>{runReads++;assert.fail('production gate must reject first');},readState:()=>{stateReads++;assert.fail('production gate must reject first');}}),/RECOVERY_SCOPE/);
 assert.equal(attempts+runReads+stateReads,0);assert(!trace.some(x=>x.startsWith('actions/')));
 const release=await readers.readRecoveryRelease(recoveryHead,{targetDate:'2026-11-06'});
 await assert.rejects(readPeriodSourceAttempts({plan:f.plan,now:revisionRecoveryNow,currentRunId:recoveryId,recoveryMain:recoveryHead,recoveryRelease:release,
  fetchImpl:()=>assert.fail('diagnostic has no historical budget query')}),/RECOVERY_SCOPE/);
 assert.throws(()=>validateReportRecoveryEvidence({plan:f.plan,expectedMain:recoveryHead,currentRunId:recoveryId,release,
  budget:{attempts:0,recoveryEvidence:{entries:[],reservations:[]}}}),/RECOVERY_SCOPE/);
});

test(contractId+' production entry refuses diagnostic capability before files, economic source, account reads or writer',async()=>{
 const f=diagnosticRevisionFixture(contractId),admission=await diagnosticAdmission(f);let privateIo=0;
 const options={plan:f.plan,reviewedSyncDate:'2026-11-06',now:revisionRecoveryNow,requireIb:true,historicalRevisionAdmission:admission,
  outputDir:'/synthetic/nonexistent-output',benchmarkFile:'/synthetic/nonexistent-benchmark',fetchEconomic:()=>{privateIo++;assert.fail('economic source forbidden');}};
 for(const value of [admission,structuredClone(readHistoricalRevisionDiagnosticAdmission(admission)),{...admission},new Proxy(admission,{})])
  await assert.rejects(produceReportPeriod({...options,historicalRevisionAdmission:value}),/^Error: FEE_REPORT_REVISION_ADMISSION$/);
 assert.equal(privateIo,0);assert.equal(isHistoricalRevisionDiagnosticAdmission(admission),true);admission.close();
 const ordinary=syncRevisionFixture(),production=await syncAdmission(ordinary);
 assert.equal(isHistoricalRevisionAdmission(production),true);assert.equal(isHistoricalRevisionDiagnosticAdmission(production),false);
 assert.throws(()=>readHistoricalRevisionDiagnosticAdmission(production),/RECOVERY_SCOPE/);production.close();
});

test(contractId+' diagnostic admission rejects old production releases, copied releases and changed exact manifests before run reads',async()=>{
 for(const fixture of [syncRevisionFixture,()=>syncRevisionFixture(wireRevisionContract),()=>syncRevisionFixture(metadataRevisionContract),sourceRevisionRecoveryFixture]){
  const f=fixture();await assert.rejects(diagnosticAdmission(f,{...syncRevisionReaders(f),readCurrentRun:()=>assert.fail('wrong release must stop first')}),/RECOVERY_SCOPE/);
 }
 const f=diagnosticRevisionFixture(contractId),readers=syncRevisionReaders(f),real=readers.readRecoveryRelease;
 await assert.rejects(diagnosticAdmission(f,{...readers,readRecoveryRelease:async(...args)=>structuredClone(await real(...args)),
  readCurrentRun:()=>assert.fail('copied release must stop first')}),/RECOVERY_SCOPE/);
 for(const mutate of [f=>f.commit.parents.push({sha:syncRevisionBase}),f=>f.commit.parents[0].sha=syncRevisionBase,
  f=>f.supportCommit.parents[0].sha=revisionRecoveryBase,f=>f.comparison.files.pop(),f=>f.comparison.files.at(-1).status=f.comparison.files.at(-1).status==='added'?'modified':'added',
  f=>f.comparison.files[0].status='added',f=>f.comparison.files.push({filename:'scripts/other.mjs',status:'added',sha:'b'.repeat(40)}),
  f=>f.tree.tree.at(-1).mode='120000',f=>f.tree.truncated=true,f=>f.comments=[],f=>f.comments[0].user.id=1,
  f=>f.comments[0].body='/approve-xuan-ib-maintenance '+'f'.repeat(40),f=>f.comments[0].updated_at='2026-11-07T00:36:00Z',
  f=>f.pr.commits=2,f=>f.pr.head.sha='f'.repeat(40),f=>f.commit.commit.verification.verified=false,
  f=>f.reviewedCommit.commit.tree.sha='f'.repeat(40),f=>f.ref.object.sha=diagnosticRevisionBase]){
  const bad=diagnosticRevisionFixture(contractId);mutate(bad);await assert.rejects(diagnosticAdmission(bad,{...syncRevisionReaders(bad),
   readCurrentRun:()=>assert.fail('invalid reviewed release must stop before current run')}),/RECOVERY_/);
 }
});

test(contractId+' diagnostic live binding rejects wrong title, target, identity, attempt, owner approval and changed source state',async()=>{
 const mutations=[f=>f.currentRun.id++,f=>f.currentRun.display_title='Produce daily 2026-11-06',f=>delete f.currentRun.display_title,
  f=>f.currentRun.head_sha=diagnosticRevisionBase,f=>f.currentRun.actor.id=1,f=>f.currentRun.triggering_actor.id=1,
  f=>f.currentRun.workflow_id++,f=>f.currentRun.path='other',f=>f.currentRun.repository.full_name='other/repo',f=>f.currentRun.head_branch='other',
  f=>f.currentRun.run_attempt=2,f=>f.currentRun.event='schedule',f=>f.currentRun.status='completed',f=>f.currentRun.conclusion='success',
  f=>f.publication.pending=true,f=>f.publication.finalMainSha=diagnosticRevisionBase,f=>f.publication.health.targetDate='2026-11-06',
  f=>f.publication.data=Buffer.from('synthetic changed'),f=>f.comments[0].body+=' edited',f=>f.ref.object.sha=diagnosticRevisionBase,
  f=>f.plan.periodFrom='2026-11-05',f=>f.plan.accountingThrough='2026-11-05',f=>f.plan.markets=['NYSE'],
  f=>f.clock=new Date('2026-11-12T00:00:00Z')];
 for(const mutate of mutations){
  const f=diagnosticRevisionFixture(contractId),admission=await diagnosticAdmission(f);mutate(f);
  await assert.rejects(admission.checkCurrent(),/RECOVERY_/);assert.equal(isHistoricalRevisionDiagnosticAdmission(admission),false);
  assert.equal(isHistoricalRevisionAdmission(admission),false);await assert.rejects(admission.checkCurrent(),/RECOVERY_CONSUMED/);
 }
 const f=diagnosticRevisionFixture(contractId);delete f.currentRun.display_title;await assert.rejects(diagnosticAdmission(f),/RECOVERY_RUN/);
});

test(contractId+' closing a diagnostic during run IO prevents subsequent publication reads and never creates a reusable capability',async()=>{
 const f=diagnosticRevisionFixture(contractId),readers=syncRevisionReaders(f);let reads=0,publicationReads=0,release,entered;
 const started=new Promise(resolve=>entered=resolve),blocked=new Promise(resolve=>release=resolve);
 const admission=await diagnosticAdmission(f,{...readers,readCurrentRun:async args=>{if(++reads===2){entered();await blocked;}return readers.readCurrentRun(args);},
  readState:async(...args)=>{publicationReads++;return readers.readState(...args);}});
 const checking=admission.checkCurrent();await started;admission.close();release();await assert.rejects(checking,/RECOVERY_CONSUMED/);
 assert.equal(publicationReads,1);assert.equal(isHistoricalRevisionDiagnosticAdmission(admission),false);assert.equal(isHistoricalRevisionAdmission(admission),false);
});

}


test('wire recovery has an exact ten-file scope without changing historical admission manifests',()=>{
 const expected=['docs/fee-source-revision.md','scripts/fee-report-producer.mjs','scripts/fee-report-producer.test.mjs',
  'scripts/fee-source-revision-runtime.mjs','scripts/fee-source-revision-runtime.test.mjs','scripts/fee-sync-capture.test.mjs',
  'scripts/fee-sync-revision-artifacts.mjs','scripts/fee-sync-revision-artifacts.test.mjs','scripts/ib-manager-source.mjs','scripts/ib-manager-source.test.mjs'];
 const manifest=reportHistoricalRecoveryManifest({contractId:wireRevisionContract});
 assert.deepEqual(manifest,expected.map(path=>({path,status:'modified'})));
 assert(Object.isFrozen(manifest));assert(manifest.every(Object.isFrozen));
 assert.equal(reportHistoricalRecoveryManifest({contractId:syncRevisionContract}).length,14);
 assert.equal(reportHistoricalRecoveryManifest({contractId:diagnosticRevisionContract}).length,15);
 assert.equal(reportHistoricalRecoveryManifest().length,17);
});

test('wire recovery cannot substitute old or diagnostic release trees, approvals, targets or private-state claims',async()=>{
 const mutations=[f=>f.commit.parents[0].sha=syncRevisionBase,f=>f.commit.parents[0].sha=diagnosticRevisionBase,
  f=>f.comparison.files=reportHistoricalRecoveryManifest({contractId:syncRevisionContract}).map(m=>({filename:m.path,status:m.status,sha:'b'.repeat(40)})),
  f=>f.comparison.files[0].filename='data.json',f=>f.comparison.files[0].filename='security/approval-tiers.json',
  f=>f.comments[0].body='/approve-xuan-ib-maintenance '+diagnosticRevisionBase,
  f=>f.reviewedCommit.parents[0].sha=diagnosticRevisionBase,f=>f.pr.head.sha=diagnosticRevisionBase,
  f=>f.plan=dailyReportPlan('2026-11-05',['NYSE','NASDAQ'],{reviewedSyncDate:'2026-11-05'}),
  f=>f.tree.tree[0].sha='f'.repeat(40),f=>f.comparison.total_commits=2,
  f=>f.publication.pending=true,f=>f.publication.health.targetDate='2026-11-06',
  f=>f.currentRun.run_attempt=2,f=>f.currentRun.status='completed'];
 for(const mutate of mutations){const f=syncRevisionFixture(wireRevisionContract);mutate(f);await assert.rejects(syncAdmission(f),/RECOVERY_/);}
 const f=syncRevisionFixture(wireRevisionContract),readers=syncRevisionReaders(f),release=await readers.readRecoveryRelease(recoveryHead,{actionsToken:revisionActionsToken});
 assert.equal(release.contractId,wireRevisionContract);assert.equal(release.repairBaseSha,wireRevisionBase);
 await assert.rejects(diagnosticAdmission(f),/RECOVERY_SCOPE/);
 await assert.rejects(syncAdmission(f,{...readers,readRecoveryRelease:async()=>({...release,contractId:syncRevisionContract})}),/RECOVERY_SCOPE/);
 const diagnostic=diagnosticRevisionFixture();await assert.rejects(syncAdmission(diagnostic),/RECOVERY_SCOPE/);
});


test('income-boundary diagnostic binds the exact ten-file successor without changing prior manifests',()=>{
 const expected=['scripts/fee-report-producer.mjs','scripts/fee-report-producer.test.mjs',
  'scripts/fee-source-revision-runtime.mjs','scripts/fee-source-revision-runtime.test.mjs',
  'scripts/fee-sync-revision-artifacts.mjs','scripts/fee-sync-revision-artifacts.test.mjs',
  'scripts/ib-manager-source.mjs','scripts/ib-manager-source.test.mjs',
  'scripts/ib-manager-source-revision.mjs','scripts/ib-manager-source-revision.test.mjs'];
 const manifest=reportHistoricalRecoveryManifest({contractId:incomeBoundaryDiagnosticContract});
 assert.deepEqual(manifest,expected.map(path=>({path,status:'modified'})));
 assert.equal(manifest.length,10);assert(Object.isFrozen(manifest));assert(manifest.every(Object.isFrozen));
 for(const [contractId,count] of [[cashDiagnosticContract,11],[economicDiagnosticContract,13],[diagnosticRevisionContract,15],
  [wireRevisionContract,10],[syncRevisionContract,14]])assert.equal(reportHistoricalRecoveryManifest({contractId}).length,count);
 assert.equal(reportHistoricalRecoveryManifest().length,17);
 assert(!manifest.some(x=>/^(?:data\.json|fee-data-health\.json|index\.html|security\/|cloud\/|\.github\/)/.test(x.path)));
});

test('income-boundary diagnostic rejects old release bindings and a four-file-only manifest before any run read',async()=>{
 const originalFour=['scripts/ib-manager-source.mjs','scripts/ib-manager-source.test.mjs',
  'scripts/ib-manager-source-revision.mjs','scripts/ib-manager-source-revision.test.mjs'];
 const mutations=[
  f=>f.comparison.files=f.comparison.files.filter(x=>originalFour.includes(x.filename)),
  f=>f.commit.parents[0].sha=cashDiagnosticBase,
  f=>f.supportCommit.parents[0].sha=economicDiagnosticBase,
  f=>f.reviewedCommit.parents[0].sha=cashDiagnosticBase,
  f=>f.comments[0].body='/approve-xuan-ib-maintenance '+cashDiagnosticBase,
  ...[cashDiagnosticContract,economicDiagnosticContract,diagnosticRevisionContract,wireRevisionContract].map(contractId=>
    f=>{f.comparison.files=reportHistoricalRecoveryManifest({contractId}).map(x=>({filename:x.path,status:x.status,sha:'b'.repeat(40)}));}),
 ];
 for(const mutate of mutations){const f=diagnosticRevisionFixture(incomeBoundaryDiagnosticContract);mutate(f);
  await assert.rejects(diagnosticAdmission(f,{...syncRevisionReaders(f),
   readCurrentRun:()=>assert.fail('wrong final release stops before run or private reads')}),/RECOVERY_/);
 }
 const f=diagnosticRevisionFixture(incomeBoundaryDiagnosticContract),readers=syncRevisionReaders(f),real=readers.readRecoveryRelease;
 for(const contractId of [cashDiagnosticContract,economicDiagnosticContract,diagnosticRevisionContract])
  await assert.rejects(diagnosticAdmission(f,{...readers,readRecoveryRelease:async(...args)=>({...await real(...args),contractId}),
   readCurrentRun:()=>assert.fail('old contract cannot replace the new authentic release')}),/RECOVERY_SCOPE/);
});

// ---- response-envelope evidence release (read-only, its own purpose) ----
// The admission accepts only the current v2 release (base c64b41a); v1 (base
// 08bb15e) keeps its binding for history and is refused.
const envelopeV1Contract='ib-source-revision-20261106-envelope-evidence-v1',envelopeV1Base='08bb15e1f78ee067cfa8be96e1cfe14018410f0e';
const envelopeContract='ib-source-revision-20261106-envelope-evidence-v2',envelopeBase='c64b41a16ede36e1fadc2a57e231118a5921899a';
function envelopeFixture(version='v2'){
 const v1=version==='v1',contractId=v1?envelopeV1Contract:envelopeContract,base=v1?envelopeV1Base:envelopeBase;
 const f=syncRevisionFixture(),manifest=reportHistoricalRecoveryManifest({contractId});
 f.commit.parents=[{sha:base}];f.supportCommit.sha=base;f.supportCommit.parents=[{sha:v1?catalogEvidenceDiagnosticBase:envelopeV1Base}];
 f.comparison.base_commit.sha=f.comparison.merge_base_commit.sha=base;
 f.comparison.files=manifest.map(m=>({filename:m.path,status:m.status,sha:'b'.repeat(40)}));
 f.tree.tree=[f.tree.tree[0],...manifest.map(m=>({path:m.path,type:'blob',mode:'100644',sha:'b'.repeat(40)}))];
 f.reviewedCommit.parents=[{sha:base}];f.currentRun.display_title='IB diagnostic 2026-11-06';
 return f;
}
const envelopeAdmission=(f,readers=syncRevisionReaders(f))=>authorizeEnvelopeEvidence({expectedMain:recoveryHead,currentRunId:recoveryId,now:revisionRecoveryNow,
 actionsToken:revisionActionsToken,readRecoveryRelease:readers.readRecoveryRelease,readCurrentRun:readers.readCurrentRun,clock:readers.clock});
test('envelope evidence release is pinned to the real main 08bb15e with its own exact ten-file manifest',()=>{
 const expected=[
  ...['.github/workflows/fee-cloud-producer.yml','.github/workflows/scripts-check.yml','docs/fee-source-revision.md',
   'scripts/fee-ratio-cloud-runtime.mjs','scripts/fee-report-producer.mjs','scripts/fee-report-producer.test.mjs',
   'scripts/fee-source-revision-diagnostic.mjs','security/approval-tiers.json'].map(path=>({path,status:'modified'})),
  ...['scripts/ib-v3-envelope-evidence.mjs','scripts/ib-v3-envelope-evidence.test.mjs'].map(path=>({path,status:'added'})),
 ];
 const manifest=reportHistoricalRecoveryManifest({contractId:envelopeV1Contract});
 assert.deepEqual(manifest,expected);assert.equal(manifest.length,10);assert(Object.isFrozen(manifest));assert(manifest.every(Object.isFrozen));
 assert.equal(reportHistoricalRecoveryManifest({contractId:catalogEvidenceDiagnosticContract}).length,13);
});
test('envelope evidence admission binds release, approval and owner run, and is no other admission',async()=>{
 const f=envelopeFixture(),trace=[],admission=await envelopeAdmission(f,syncRevisionReaders(f,trace));
 assert.equal(isEnvelopeEvidenceAdmission(admission),true);assert.equal(isEnvelopeEvidenceAdmission({...admission}),false);
 assert.equal(isHistoricalRevisionDiagnosticAdmission(admission),false);assert.equal(isHistoricalRevisionAdmission(admission),false);
 assert.equal(JSON.stringify(admission),'{}');assert(Object.isFrozen(admission));
 const binding=await admission.checkCurrent();
 assert.deepEqual(Object.keys(binding).sort(),['approvedHead','approvedTree','contractId','currentRunId','executionSha256','mainSha','purpose','repairBaseSha','targetDate']);
 assert.equal(binding.contractId,envelopeContract);assert.equal(binding.purpose,'read-only-envelope-evidence');assert.equal(binding.repairBaseSha,envelopeBase);
 assert.equal(binding.targetDate,'2026-11-06');assert.equal(binding.approvedHead,revisionReviewedHead);assert.equal(binding.currentRunId,recoveryId);
 assert.equal(trace.filter(x=>x==='actions/runs/'+recoveryId).length,2);
 assert(!trace.some(x=>x.includes('/runs?')||x.includes('/jobs')||x.startsWith('contents/')),'no Actions history listing and no publication read');
 admission.close();await assert.rejects(admission.checkCurrent(),/RECOVERY_CONSUMED/);
});
test('envelope evidence refuses a tampered release, approval or run before any credential use',async()=>{
 for(const change of [
  f=>f.reviewedCommit.commit.tree.sha='f'.repeat(40),f=>f.comments[0].body='/approve-xuan-ib-maintenance '+'e'.repeat(40),
  f=>f.comments[0].user.id=1,f=>f.comparison.files.push({filename:'scripts/extra.mjs',status:'added',sha:'b'.repeat(40)}),
  f=>f.comparison.files[0].status='added',f=>f.comparison.files.pop(),f=>f.supportCommit.parents=[{sha:'e'.repeat(40)}],
  f=>f.commit.commit.verification.verified=false,f=>f.reviewedCommit.parents=[{sha:catalogEvidenceDiagnosticBase}],f=>f.pr.merged=false,
  f=>f.tree.tree[0].sha='c'.repeat(40),f=>f.currentRun.run_attempt=2,f=>f.currentRun.display_title='IB diagnostic 2026-11-07',
  f=>f.currentRun.actor.id=1,f=>f.currentRun.head_sha='e'.repeat(40),f=>f.currentRun.event='schedule',f=>f.ref.object.sha='e'.repeat(40)]){
  const f=envelopeFixture();change(f);
  await assert.rejects(envelopeAdmission(f),{message:/^FEE_REPORT_RECOVERY_(RELEASE|RUN|METADATA|SCOPE)$/},String(change));
 }
 // A later edit of the owner comment ends a live admission.
 const f=envelopeFixture(),admission=await envelopeAdmission(f);f.comments[0].updated_at='2026-11-07T00:31:00Z';
 await assert.rejects(admission.checkCurrent(),/RECOVERY_RELEASE/);await assert.rejects(admission.checkCurrent(),/RECOVERY_CONSUMED/);
});
test('envelope release and the diagnostic, recovery and budget paths refuse each other',async()=>{
 const f=envelopeFixture(),readers=syncRevisionReaders(f);
 await assert.rejects(diagnosticAdmission(f,readers),/RECOVERY_SCOPE/);
 await assert.rejects(syncAdmission(f,readers),/RECOVERY_SCOPE/);
 const release=await readers.readRecoveryRelease(recoveryHead,{targetDate:'2026-11-06',actionsToken:revisionActionsToken});
 assert.equal(release.purpose,'read-only-envelope-evidence');assert.equal(release.contractId,envelopeContract);
 await assert.rejects(readPeriodSourceAttempts({plan:f.plan,now:revisionRecoveryNow,currentRunId:recoveryId,recoveryMain:recoveryHead,recoveryRelease:release,actionsToken:revisionActionsToken}),/RECOVERY_SCOPE/);
 assert.throws(()=>validateReportRecoveryEvidence({plan:f.plan,expectedMain:recoveryHead,currentRunId:recoveryId,release,budget:{attempts:0,recoveryEvidence:{entries:[],reservations:[]}}}),/RECOVERY_SCOPE/);
 for(const contractId of [catalogEvidenceDiagnosticContract,recordOrderDiagnosticContract,rootMetadataDiagnosticContract]){
  const d=diagnosticRevisionFixture(contractId);await assert.rejects(envelopeAdmission(d),/RECOVERY_SCOPE/);
 }
 await assert.rejects(envelopeAdmission(syncRevisionFixture()),/RECOVERY_SCOPE/);
 await assert.rejects(envelopeAdmission(syncRevisionFixture(metadataRevisionContract)),/RECOVERY_SCOPE/);
 await assert.rejects(authorizeEnvelopeEvidence({expectedMain:recoveryHead,currentRunId:recoveryId,now:revisionRecoveryNow,actionsToken:revisionActionsToken,
  readRecoveryRelease:async()=>({mainSha:recoveryHead,contractId:envelopeContract,purpose:'read-only-envelope-evidence',targetDate:'2026-11-06'}),
  readCurrentRun:()=>assert.fail('a forged release must stop first')}),/RECOVERY_SCOPE/);
});
test('existing exhaustive dispatch checks accept the envelope fields only while off and blank',()=>{
 const c=confirmedDailyFixture(),check=inputs=>reviewedMainConfirmation(c.args,{env:c.env,readEvent:()=>({...c.event,inputs:{...c.event.inputs,...inputs}})});
 assert.equal(check({ib_envelope_once:'false',ib_envelope_main:''}),c.head);assert.equal(check({ib_envelope_once:false}),c.head);
 for(const inputs of [{ib_envelope_once:'true'},{ib_envelope_once:true},{ib_envelope_main:c.head},{ib_envelope_extra:''}])assert.throws(()=>check(inputs),/CONFIRMED_MAIN_SCOPE/);
 const a=automaticDailyFixture(),daily=inputs=>scheduledDailyContext({mode:'preflight'},{env:a.env,now:a.now,readEvent:()=>({...a.event,inputs:{...a.event.inputs,...inputs}})});
 assert.equal(daily({ib_envelope_once:'false',ib_envelope_main:''}),true);
 for(const inputs of [{ib_envelope_once:'true'},{ib_envelope_main:'a'.repeat(40)}])assert.throws(()=>daily(inputs),/DAILY_SCOPE/);
});
test('workflow: the envelope job is the only job for its fields and gets no fee key, economic source or writer',()=>{
 const wf=fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml',import.meta.url),'utf8'),head='a'.repeat(40);
 const jobs=[...wf.matchAll(/^  ([a-z][a-z-]*):\n([\s\S]*?)(?=^  [a-z][a-z-]*:\n|(?![\s\S]))/gm)].filter(([,name])=>!['schedule','workflow_dispatch'].includes(name));
 const condition=(body,inputs,github={})=>Boolean(vm.runInNewContext(/(?:^|\n)    if: \$\{\{ (.+) \}\}/.exec(body)[1],{inputs,needs:new Proxy({},{get:()=>({result:'success',outputs:{outcome:'produce'}})}),cancelled:()=>false,always:()=>true,
  github:{event_name:'workflow_dispatch',actor_id:'283054367',ref:'refs/heads/main',run_attempt:1,sha:head,...github},
  vars:{FEE_REPORT_ONCE_MAIN:'',FEE_CLOUD_MODE:'publish',FEE_REPORT_DAILY_ENABLED:'true',FEE_REPORT_PERIODS_ENABLED:'true'}}));
 const off={ib_diagnostic_once:false,ib_diagnostic_main:'',ratio_main:'',ratio_plan:'',source_plan_check_only:false,source_acceptance_once:false,source_from:'',source_target:'',source_main:'',
  run_reviewed_once:false,manual_sync_completed_for:'',confirmed_main:'',recovery_main:'',report_kind:'',report_target:'',report_markets:''};
 const envelope={...off,ib_envelope_once:true,ib_envelope_main:head};
 assert.deepEqual(jobs.filter(([,,body])=>condition(body,envelope)).map(([,name])=>name),['ib-envelope-evidence']);
 const job=jobs.find(([,name])=>name==='ib-envelope-evidence')[2].replace(/^ *#.*\n/gm,'');
 for(const github of [{run_attempt:2},{actor_id:'1'},{ref:'refs/heads/topic'},{event_name:'schedule'},{sha:'b'.repeat(40)}])assert.equal(condition(job,envelope,github),false);
 for(const mixed of [{ib_diagnostic_once:true},{ib_diagnostic_main:head},{confirmed_main:head},{ratio_plan:'x'},{ratio_main:head},{recovery_main:head},{run_reviewed_once:true},
  {source_plan_check_only:true},{source_acceptance_once:true},{report_kind:'daily'},{ib_envelope_once:false},{ib_envelope_main:''}])assert.equal(condition(job,{...envelope,...mixed}),false);
 // Every other job is excluded whenever either envelope field is set.
 const everything={...off,ib_diagnostic_once:true,ib_diagnostic_main:head,run_reviewed_once:true,report_kind:'daily',ratio_plan:'{}',ratio_main:head,source_plan_check_only:true,source_acceptance_once:true};
 for(const [,name,body] of jobs)if(name!=='ib-envelope-evidence')for(const field of [{ib_envelope_once:true},{ib_envelope_main:head}])assert.equal(condition(body,{...everything,...field}),false,name);
 assert.match(wf,/run-name: \$\{\{ \(inputs\.ib_diagnostic_once \|\| inputs\.ib_envelope_once\) && 'IB diagnostic 2026-11-06' \|\|/);
 assert.match(job,/^    name: IB diagnostic 2026-11-06\n/m);assert.match(job,/environment: fee-cloud-producer/);
 assert.match(job,/permissions:\n      contents: read\n      actions: read\n      id-token: write\n/);assert.doesNotMatch(job,/contents: write|actions: write|upload-artifact/);
 assert.doesNotMatch(job,/FEE_DATA_KEY|FEE_ECON|IB_MANAGER_|FEE_RATIO|RATIO_STORAGE|secrets\.|access_token_scopes|vars\./);
 const steps=[...job.matchAll(/      - (?:name: ([^\n]+)|uses: ([^\n]+))\n([\s\S]*?)(?=      - |(?![\s\S]))/g)];
 const check=job.indexOf('--check-plan'),auth=job.indexOf('google-github-actions/auth@'),secret=job.indexOf('get-secretmanager-secrets@');
 assert(check>0&&check<auth&&auth<secret,'release gate before WIF and secrets');
 assert.equal((job.match(/sharesight-broker-sync-client-(?:id|secret)\/1/g)||[]).length,2);
 const run=steps.find(([,name])=>name==='Compare the fixed IB v3 responses without a reader, writer or publication token')[3];
 for(const k of ['GOOGLE_APPLICATION_CREDENTIALS','CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE','GOOGLE_GHA_CREDS_PATH'])assert.match(run,new RegExp(k+": ''"));
 assert.match(run,/node scripts\/ib-v3-envelope-evidence\.mjs --expected-main="\$ENVELOPE_MAIN"\n/);
 assert.doesNotMatch(steps.find(([,name])=>name?.startsWith('Verify the exact envelope'))[3],/SHARESIGHT/);
});
test('envelope admission runs through the entry own outer transport with its default readers',async()=>{
 const {envelopeEvidenceTransport}=await import('./ib-v3-envelope-evidence.mjs');
 const f=envelopeFixture(),trace=[],wire=sourceRevisionWire(f,trace);
 const inner=async(url,init)=>{const route=url.split('/fee-console/')[1];
  if(route==='actions/runs/'+recoveryId){trace.push(route);assert.equal(init.headers.Authorization,'Bearer '+revisionActionsToken);const r=new Response(JSON.stringify(f.currentRun));Object.defineProperty(r,'url',{value:url});return r;}
  return wire(url,init);};
 const transport=envelopeEvidenceTransport({fetchImpl:inner});
 try{
  const admission=await authorizeEnvelopeEvidence({expectedMain:recoveryHead,currentRunId:recoveryId,now:revisionRecoveryNow,actionsToken:revisionActionsToken,fetchImpl:transport.fetch,clock:()=>revisionRecoveryNow});
  assert.equal(isEnvelopeEvidenceAdmission(admission),true);assert.equal((await admission.checkCurrent()).contractId,envelopeContract);admission.close();
  assert(trace.length>=8);assert(!trace.some(x=>x.startsWith('contents/')||x.includes('/jobs')||x.includes('/runs?')));
 }finally{transport.close();}
});

// ---- fixed GitHub-verification sub-location (synthetic faults only) ----
const metadataCanary='private-canary-'+'Z'.repeat(12);
function envelopeFaultFetch(f,fault){
 const wire=sourceRevisionWire(f),seen=new Map();
 return async(url,init)=>{
  const p=url.split('/fee-console/')[1],n=(seen.get(p)||0)+1;seen.set(p,n);
  if(fault?.match(p,n))return fault.respond(url,init);
  if(p==='actions/runs/'+recoveryId){const r=new Response(JSON.stringify(f.currentRun));Object.defineProperty(r,'url',{value:url});return r;}
  return wire(url,init);
 };
}
const faultResponse=(url,{status=200,body=JSON.stringify({message:metadataCanary}),headers={},responseUrl=url}={})=>{
 const r=new Response(body,{status,headers:{'content-type':'application/json',...headers}});Object.defineProperty(r,'url',{value:responseUrl});return r;
};
const faultyEnvelope=(fault,options={})=>{const f=envelopeFixture();return authorizeEnvelopeEvidence({expectedMain:recoveryHead,currentRunId:recoveryId,now:revisionRecoveryNow,
 actionsToken:revisionActionsToken,fetchImpl:envelopeFaultFetch(f,fault),clock:()=>revisionRecoveryNow,...options});};
async function metadataFailure(promise){
 let error;try{await promise;}catch(e){error=e;}
 assert(error,'expected a refusal');assert.equal(error.message,'FEE_REPORT_RECOVERY_METADATA');
 const d=recoveryMetadataDiagnostic(error);assert(d&&Object.isFrozen(d));assert.deepEqual(Object.keys(d).sort(),['category','request','stage']);
 assert(RECOVERY_METADATA_STAGES.includes(d.stage)&&RECOVERY_METADATA_REQUESTS.includes(d.request)&&RECOVERY_METADATA_CATEGORIES.includes(d.category));
 assert.doesNotMatch(JSON.stringify(d)+String(error.stack).split('\n')[0],/canary|https?:|Bearer|synthetic-revision|9001|9002|[a-f0-9]{40}/);
 return {...d};
}
test('each GitHub verification stage reports its fixed request and category; the code itself is unchanged',async()=>{
 const at=(path,nth=1)=>(p,n)=>p===path&&n===nth;
 const cases=[
  [at('git/ref/heads/main'),url=>faultResponse(url,{status:403}),['RELEASE_MAIN_COMMIT','MAIN_REF','HTTP_403']],
  [at('commits/'+recoveryHead+'?per_page=1'),url=>faultResponse(url,{status:500}),['RELEASE_MAIN_COMMIT','COMMIT','HTTP_5XX']],
  [at('commits/'+envelopeBase+'?per_page=1'),url=>faultResponse(url,{status:429}),['RELEASE_BASE_COMPARE_TREE','COMMIT','HTTP_429']],
  [at('compare/'+envelopeBase+'...'+recoveryHead+'?per_page=100'),url=>faultResponse(url,{status:404}),['RELEASE_BASE_COMPARE_TREE','COMPARE','HTTP_404']],
  [at('git/trees/'+'a'.repeat(40)+'?recursive=1'),url=>faultResponse(url,{headers:{'content-length':String(600*1024)}}),['RELEASE_BASE_COMPARE_TREE','TREE','SIZE']],
  [at('commits/'+recoveryHead+'/pulls?per_page=100'),()=>{throw Error(metadataCanary+' https://x');},['RELEASE_PR_ASSOCIATION','PR_ASSOCIATION','FETCH_REJECTED']],
  [at('pulls/9001'),url=>faultResponse(url,{status:302}),['RELEASE_PR_COMMENTS','PR','HTTP_3XX']],
  [at('issues/9001/comments?per_page=100'),url=>faultResponse(url,{body:'not json '+metadataCanary}),['RELEASE_PR_COMMENTS','PR_COMMENTS','JSON']],
  [at('commits/'+revisionReviewedHead+'?per_page=1'),url=>faultResponse(url,{status:401}),['RELEASE_REVIEWED_HEAD','COMMIT','HTTP_401']],
  [at('git/ref/heads/main',2),url=>faultResponse(url,{responseUrl:url+'?moved'}),['RELEASE_MAIN_RECHECK','MAIN_REF','RESPONSE_URL']],
  [at('issues/comments/9002'),url=>faultResponse(url,{status:418}),['REFRESH_MAIN_COMMENT','COMMENT','HTTP_4XX']],
  [at('git/ref/heads/main',3),url=>faultResponse(url,{status:204,body:null}),['REFRESH_MAIN_COMMENT','MAIN_REF','HTTP_OTHER']],
  [at('actions/runs/'+recoveryId),url=>{const body=new ReadableStream({start(c){c.error(Error(metadataCanary));}});const r=new Response(body,{headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;},['CURRENT_RUN','RUN','STREAM_FAILED']],
 ];
 for(const [match,respond,[stage,request,category]] of cases)
  assert.deepEqual(await metadataFailure(faultyEnvelope({match,respond})),{stage,request,category},stage+' '+request);
 assert.deepEqual(await metadataFailure(faultyEnvelope(null,{actionsToken:'t'.repeat(4097),fetchImpl:()=>assert.fail('no request with a refused token')})),
  {stage:'RELEASE_SETUP',request:'NONE',category:'TOKEN_FORMAT'});
});
test('a recheck failure after admission keeps its own sub-location, then the admission is consumed',async()=>{
 const admission=await faultyEnvelope({match:(p,n)=>p==='actions/runs/'+recoveryId&&n===2,respond:url=>faultResponse(url,{status:503})});
 assert.deepEqual(await metadataFailure(admission.checkCurrent()),{stage:'CURRENT_RUN',request:'RUN',category:'HTTP_5XX'});
 await assert.rejects(admission.checkCurrent(),/^Error: FEE_REPORT_RECOVERY_CONSUMED$/);
 const comment=await faultyEnvelope({match:(p,n)=>p==='issues/comments/9002'&&n===2,respond:()=>{throw Error(metadataCanary);}});
 assert.deepEqual(await metadataFailure(comment.checkCurrent()),{stage:'REFRESH_MAIN_COMMENT',request:'COMMENT',category:'FETCH_REJECTED'});
});
test('a GitHub timeout is a fixed TIMEOUT at its stage, with no retry',async()=>{
 let calls=0;
 assert.deepEqual(await metadataFailure(faultyEnvelope({match:(p,n)=>p==='git/ref/heads/main'&&n===1&&++calls,respond:()=>new Promise(()=>{})})),
  {stage:'RELEASE_MAIN_COMMIT',request:'MAIN_REF',category:'TIMEOUT'});
 assert.equal(calls,1);
});
test('version, approval and run refusals are unchanged and carry no metadata sub-location',async()=>{
 for(const change of [f=>f.reviewedCommit.commit.tree.sha='f'.repeat(40),f=>f.comparison.files.pop(),f=>f.comments[0].user.id=1,f=>f.currentRun.run_attempt=2]){
  const f=envelopeFixture();change(f);let error;
  try{await authorizeEnvelopeEvidence({expectedMain:recoveryHead,currentRunId:recoveryId,now:revisionRecoveryNow,actionsToken:revisionActionsToken,fetchImpl:envelopeFaultFetch(f,null),clock:()=>revisionRecoveryNow});}catch(e){error=e;}
  assert.match(error?.message,/^FEE_REPORT_RECOVERY_(RELEASE|RUN)$/);assert.equal(recoveryMetadataDiagnostic(error),null);
 }
 const ok=await faultyEnvelope(null);assert.equal(isEnvelopeEvidenceAdmission(ok),true);assert.equal((await ok.checkCurrent()).contractId,envelopeContract);ok.close();
 assert.equal(recoveryMetadataDiagnostic(new Error('FEE_REPORT_RECOVERY_METADATA')),null);assert.equal(recoveryMetadataDiagnostic(null),null);
});

test('envelope v2 release is pinned to the real main c64b41a with its own exact five-file manifest; v1 is refused',async()=>{
 const manifest=reportHistoricalRecoveryManifest({contractId:envelopeContract});
 assert.deepEqual(manifest,['docs/fee-source-revision.md','scripts/fee-report-producer.mjs','scripts/fee-report-producer.test.mjs',
  'scripts/ib-v3-envelope-evidence.mjs','scripts/ib-v3-envelope-evidence.test.mjs'].map(path=>({path,status:'modified'})));
 assert(Object.isFrozen(manifest)&&manifest.every(Object.isFrozen));assert.equal(reportHistoricalRecoveryManifest({contractId:envelopeV1Contract}).length,10);
 // The real v1 release (parent 08bb15e) still selects its own scope, but the admission refuses it.
 const old=envelopeFixture('v1'),oldRelease=await syncRevisionReaders(old).readRecoveryRelease(recoveryHead,{targetDate:'2026-11-06',actionsToken:revisionActionsToken});
 assert.equal(oldRelease.contractId,envelopeV1Contract);assert.equal(oldRelease.repairBaseSha,envelopeV1Base);
 await assert.rejects(envelopeAdmission(old),/^Error: FEE_REPORT_RECOVERY_SCOPE$/);
 const f=envelopeFixture(),release=await syncRevisionReaders(f).readRecoveryRelease(recoveryHead,{targetDate:'2026-11-06',actionsToken:revisionActionsToken});
 assert.deepEqual([release.contractId,release.purpose,release.repairBaseSha,release.parent,release.targetDate],[envelopeContract,'read-only-envelope-evidence',envelopeBase,envelopeBase,'2026-11-06']);
 const admission=await envelopeAdmission(f);assert.equal((await admission.checkCurrent()).repairBaseSha,envelopeBase);admission.close();
 // Exact base, base parents, manifest, tree and reviewed-head parent stay strict for v2.
 for(const change of [x=>x.supportCommit.parents=[{sha:catalogEvidenceDiagnosticBase}],x=>x.comparison.files.push({filename:'scripts/fee-cloud-source.mjs',status:'modified',sha:'b'.repeat(40)}),
  x=>x.comparison.files[0].status='added',x=>x.comparison.files.pop(),x=>x.reviewedCommit.parents=[{sha:envelopeV1Base}],x=>x.tree.tree[1].sha='c'.repeat(40),
  x=>x.supportCommit.commit.verification.verified=false,x=>x.comparison.ahead_by=2]){
  const v=envelopeFixture();change(v);await assert.rejects(envelopeAdmission(v),/^Error: FEE_REPORT_RECOVERY_(RELEASE|METADATA)$/);
 }
 // A main whose parent is no pinned release selects nothing.
 const stray=envelopeFixture();stray.commit.parents=[{sha:'e'.repeat(40)}];await assert.rejects(envelopeAdmission(stray),/^Error: FEE_REPORT_RECOVERY_RELEASE$/);
 // Purpose isolation holds for v2: diagnostic, recovery and budget paths refuse it.
 await assert.rejects(diagnosticAdmission(f,syncRevisionReaders(f)),/RECOVERY_SCOPE/);
 await assert.rejects(syncAdmission(f,syncRevisionReaders(f)),/RECOVERY_SCOPE/);
 await assert.rejects(readPeriodSourceAttempts({plan:f.plan,now:revisionRecoveryNow,currentRunId:recoveryId,recoveryMain:recoveryHead,recoveryRelease:release,actionsToken:revisionActionsToken}),/RECOVERY_SCOPE/);
 assert.throws(()=>validateReportRecoveryEvidence({plan:f.plan,expectedMain:recoveryHead,currentRunId:recoveryId,release,budget:{attempts:0,recoveryEvidence:{entries:[],reservations:[]}}}),/RECOVERY_SCOPE/);
});
