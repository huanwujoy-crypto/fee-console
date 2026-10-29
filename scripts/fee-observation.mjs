#!/usr/bin/env node
// GET-only, amount-free observation. No dispatch, notification or financial secrets.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {spawnSync,execFile} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {validateHealth} from './fee-data-health.mjs';
import {latestCommonBenchmarkDate} from './fee-cloud-source.mjs';
const REPO='huanwujoy-crypto/fee-console',PUBLIC='https://huanwujoy-crypto.github.io/fee-console/';
const WORKFLOW_ID=365873934,MAX_BYTES=3*1024*1024;
const fail=code=>{throw new Error(code);};
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const sealed=bytes=>{try{const v=JSON.parse(bytes);return v&&Object.keys(v).sort().join(',')==='data,enc,v'&&v.enc===true&&v.v===3&&typeof v.data==='string'&&v.data.length>=40&&/^[A-Za-z0-9+/]+={0,2}$/.test(v.data)&&Buffer.from(v.data,'base64').toString('base64')===v.data;}catch{return false;}};
const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const hkt=instant=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',weekday:'short',hourCycle:'h23'}).formatToParts(instant).reduce((out,p)=>(out[p.type]=p.value,out),{});
const STATUSES=new Set(['queued','in_progress','waiting','pending','requested','completed']),CONCLUSIONS=new Set(['success','failure','cancelled','timed_out','action_required','neutral','skipped','stale']);
const runSummary=r=>r?{id:r.id,event:r.event,status:STATUSES.has(r.status)?r.status:'unknown',conclusion:CONCLUSIONS.has(r.conclusion)?r.conclusion:null,createdAt:new Date(r.created_at).toISOString(),url:`https://github.com/${REPO}/actions/runs/${r.id}`} : null;
export function observeFee({workflow,runs,expectedDate,now=new Date().toISOString(),publicHealth,publicData,mainHealth,mainData,mainSha,graceMinutes=30}={}) {
 if(!date(expectedDate)||!Number.isFinite(Date.parse(now))||!Number.isInteger(graceMinutes)||graceMinutes<0||graceMinutes>120||!Array.isArray(runs)||workflow?.id!==WORKFLOW_ID)fail('OBSERVATION_INPUT_INVALID');
 const instant=new Date(now),local=hkt(instant),today=`${local.year}-${local.month}-${local.day}`,eligibleDay=['Tue','Wed','Thu','Fri','Sat'].includes(local.weekday);
 const slotDue=eligibleDay&&(Number(local.hour)*60+Number(local.minute)>=11*60+30+graceMinutes);
 const eligible=runs.filter(r=>r?.workflow_id===WORKFLOW_ID&&r.head_branch==='main'&&['schedule','workflow_dispatch'].includes(r.event)&&Number.isSafeInteger(r.id)&&Number.isFinite(Date.parse(r.created_at))).sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at));
 const todayRuns=eligible.filter(r=>{const p=hkt(new Date(r.created_at));return `${p.year}-${p.month}-${p.day}`===today;}),scheduled=todayRuns.filter(r=>r.event==='schedule');
 const diagnostics=[];
 const add=(stage,code)=>diagnostics.push({stage,code});
 let trigger=workflow.state==='active'?(slotDue&&!scheduled.length?'no-scheduled-run-observed':scheduled.length?'scheduled-run-observed':eligibleDay?'before-observation-deadline':'not-scheduled-today'):'workflow-inactive';
 if(trigger==='workflow-inactive')add('trigger','WORKFLOW_INACTIVE');
 if(trigger==='no-scheduled-run-observed')add('trigger','NO_SCHEDULED_RUN_OBSERVED');
 const last=todayRuns[0]||null;
 let producer=last?last.status!=='completed'?'in-progress':last.conclusion==='success'?'success':last.conclusion==='failure'?'failed':CONCLUSIONS.has(last.conclusion)?last.conclusion:'unknown':'not-observed-today';
 if(producer==='failed')add('producer',Date.parse(last.created_at)<Date.parse(publicHealth?.checkedAt)?'FAILED_BEFORE_PUBLIC_REFRESH':'LATEST_PRODUCER_FAILED');
 const healthErrors=validateHealth(publicHealth,{now:instant}),mainHealthErrors=validateHealth(mainHealth,{now:instant});
 let publication='current';
 if(healthErrors.length){publication='invalid-health';add('public-health','PUBLIC_HEALTH_INVALID');}
 if(mainHealthErrors.length)add('main-health','MAIN_HEALTH_INVALID');
 if(!Buffer.isBuffer(publicData)||!Buffer.isBuffer(mainData))fail('OBSERVATION_BYTES_INVALID');
 if(!sealed(publicData)){publication='invalid-envelope';add('public-data','PUBLIC_ENVELOPE_INVALID');}
 if(!sealed(mainData))add('main-data','MAIN_ENVELOPE_INVALID');
 if(hash(publicData)!==publicHealth?.dataSha256){publication='hash-mismatch';add('public-data','PUBLIC_HEALTH_DATA_HASH_MISMATCH');}
 if(hash(mainData)!==mainHealth?.dataSha256)add('main-data','MAIN_HEALTH_DATA_HASH_MISMATCH');
 if(!publicData.equals(mainData)||JSON.stringify(publicHealth)!==JSON.stringify(mainHealth)){publication='differs-from-main';add('publication','PUBLIC_DIFFERS_FROM_MAIN');}
 if(date(publicHealth?.targetDate)&&publicHealth.targetDate<expectedDate){publication='target-date-lag';add('publication','PUBLIC_TARGET_DATE_LAG');}
 if(date(publicHealth?.targetDate)&&publicHealth.targetDate>expectedDate){publication='target-date-conflict';add('publication','EXPECTED_TARGET_BEHIND_PUBLIC');}
 if(publicHealth?.outcome==='failed'){publication='failed-health';add('publication','PUBLIC_RUN_FAILED');}
 const checked=Number.isFinite(Date.parse(publicHealth?.checkedAt))?hkt(new Date(publicHealth.checkedAt)):null;
 if(slotDue&&checked&&`${checked.year}-${checked.month}-${checked.day}`!==today){publication='no-fresh-health-today';add('publication','NO_FRESH_PUBLIC_HEALTH_TODAY');}
 return {schema:'fee-console.observation.v1',observedAt:instant.toISOString(),hktDate:today,expectedDate,mainSha:/^[a-f0-9]{40}$/.test(mainSha||'')?mainSha:null,trigger:{state:trigger,scheduledRunsToday:scheduled.length,graceMinutes,cause:'not-inferred'},producer:{state:producer,lastRun:runSummary(last)},publication:{state:publication,targetDate:date(publicHealth?.targetDate)?publicHealth.targetDate:null,checkedAt:Number.isFinite(Date.parse(publicHealth?.checkedAt))?new Date(publicHealth.checkedAt).toISOString():null,outcome:['updated','no-op','failed'].includes(publicHealth?.outcome)?publicHealth.outcome:null,dataSha256:hash(publicData),matchesMain:publicData.equals(mainData)&&JSON.stringify(publicHealth)===JSON.stringify(mainHealth)},diagnostics,needsAttention:diagnostics.length>0,privateReceiptAndInvestorAcceptance:'not-tested-by-this-public-only-tool'};
}
function github(route){
 // Hardcoded read-only endpoint allowlist. Existing gh auth stays inside gh.
 if(!new RegExp(`^repos/${REPO}/(?:actions/workflows/(?:fee-cloud-producer\\.yml(?:/runs\\?branch=main&per_page=100&page=\\d+)?)|git/ref/heads/main|contents/(?:data\\.json|fee-data-health\\.json)\\?ref=[a-f0-9]{40}|contents/benchmark-close\\.json\\?ref=market-data-cache)$`).test(route))fail('COLLECTION_ROUTE_REJECTED');
 const r=spawnSync('gh',['api',route],{encoding:'utf8',timeout:30000,maxBuffer:MAX_BYTES});if(r.status!==0)fail('COLLECTION_GITHUB_READ_FAILED');
 try{return JSON.parse(r.stdout);}catch{fail('COLLECTION_GITHUB_RESPONSE_INVALID');}
}
function content(value){if(value?.encoding!=='base64'||typeof value.content!=='string'||value.size>MAX_BYTES)fail('COLLECTION_CONTENT_INVALID');return Buffer.from(value.content.replace(/\s/g,''),'base64');}
async function publicGet(file){
 if(!['data.json','fee-data-health.json'].includes(file))fail('COLLECTION_ROUTE_REJECTED');
 // System curl uses the existing OS proxy/CA configuration; no secret is passed.
 const args=['--request','GET','--fail','--silent','--show-error','--proto','=https','--max-redirs','0','--connect-timeout','10','--max-time','25','--write-out','%{http_code}',PUBLIC+file];
 const bytes=await new Promise((resolve,reject)=>execFile('/usr/bin/curl',args,{encoding:'buffer',timeout:30000,maxBuffer:MAX_BYTES+3},(error,stdout)=>error?reject(new Error('COLLECTION_PUBLIC_READ_FAILED')):resolve(stdout)));
 if(bytes.subarray(-3).toString()!=='200')fail('COLLECTION_PUBLIC_HTTP_REJECTED');
 return bytes.subarray(0,-3);
}
export async function collectFeeObservation({expectedDate,now}={}) {
 const workflow=github(`repos/${REPO}/actions/workflows/fee-cloud-producer.yml`),mainSha=github(`repos/${REPO}/git/ref/heads/main`).object?.sha;
 if(!/^[a-f0-9]{40}$/.test(mainSha||''))fail('COLLECTION_MAIN_INVALID');
 const instant=now||new Date().toISOString(),local=hkt(new Date(instant)),today=`${local.year}-${local.month}-${local.day}`,runs=[];
 let covered=false;
 for(let page=1;page<=10;page++){
  const payload=github(`repos/${REPO}/actions/workflows/fee-cloud-producer.yml/runs?branch=main&per_page=100&page=${page}`);
  if(!Array.isArray(payload.workflow_runs))fail('COLLECTION_RUNS_INVALID');runs.push(...payload.workflow_runs);
  if(payload.workflow_runs.length<100||payload.workflow_runs.some(r=>{const p=hkt(new Date(r.created_at));return `${p.year}-${p.month}-${p.day}`<today;})){covered=true;break;}
 }
 if(!covered)fail('COLLECTION_RUN_HISTORY_INCOMPLETE');
 const target=expectedDate||latestCommonBenchmarkDate(JSON.parse(content(github(`repos/${REPO}/contents/benchmark-close.json?ref=market-data-cache`))));
 const mainData=content(github(`repos/${REPO}/contents/data.json?ref=${mainSha}`)),mainHealth=JSON.parse(content(github(`repos/${REPO}/contents/fee-data-health.json?ref=${mainSha}`)));
 const [publicData,publicHealthBytes]=await Promise.all([publicGet('data.json'),publicGet('fee-data-health.json')]);
 // A concurrent publication is an observation race, never proof of corruption.
 if(github(`repos/${REPO}/git/ref/heads/main`).object?.sha!==mainSha)fail('COLLECTION_MAIN_CHANGED_RETRY');
 let publicHealth;try{publicHealth=JSON.parse(publicHealthBytes);}catch{fail('COLLECTION_PUBLIC_HEALTH_INVALID');}
 return observeFee({workflow,runs,expectedDate:target,now:instant,publicHealth,publicData,mainHealth,mainData,mainSha});
}
async function main(){
 const args={};for(const a of process.argv.slice(2)){const m=/^--(input|target-date|now)=([^\0\r\n]+)$/.exec(a);if(!m||args[m[1]])fail('OBSERVATION_ARGUMENT_INVALID');args[m[1]]=m[2];}
 const result=args.input?(()=>{const input=JSON.parse(fs.readFileSync(args.input));return observeFee({...input,expectedDate:args['target-date']||input.expectedDate,now:args.now||input.now,publicData:Buffer.from(input.publicDataBase64||'','base64'),mainData:Buffer.from(input.mainDataBase64||'','base64')});})():await collectFeeObservation({expectedDate:args['target-date'],now:args.now});
 console.log(JSON.stringify(result,null,2));if(result.needsAttention)process.exitCode=2;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{const codes=new Set(['OBSERVATION_INPUT_INVALID','OBSERVATION_BYTES_INVALID','OBSERVATION_ARGUMENT_INVALID','COLLECTION_ROUTE_REJECTED','COLLECTION_GITHUB_READ_FAILED','COLLECTION_GITHUB_RESPONSE_INVALID','COLLECTION_CONTENT_INVALID','COLLECTION_PUBLIC_READ_FAILED','COLLECTION_PUBLIC_HTTP_REJECTED','COLLECTION_MAIN_INVALID','COLLECTION_RUNS_INVALID','COLLECTION_RUN_HISTORY_INCOMPLETE','COLLECTION_MAIN_CHANGED_RETRY','COLLECTION_PUBLIC_HEALTH_INVALID']);console.log(JSON.stringify({schema:'fee-console.observation.v1',stage:'collection',code:codes.has(error.message)?error.message:'OBSERVATION_COLLECTION_FAILED',cause:'not-inferred'}));process.exitCode=1;});
