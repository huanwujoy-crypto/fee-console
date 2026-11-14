// Fixed-service transport for the manually approved ratio job. No SDK,
// credential-file discovery, Sharesight calls, ledger decoding, or retry loop.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRatioCloudPublisher,RATIO_CLOUD_FILE,validateRatioCloudPlan} from './fee-ratio-cloud-publish.mjs';
import {createFeeRatioCore} from './fee-ratio-management.mjs';
import {createRankedExposureCore} from './xuan-ib-sharesight-exposure.mjs';
import {createLegacyPolicy} from './fee-legacy-policy.mjs';
import {verifyFeeFinalPublication,isFeeFinalPublicationProof,FEE_PUBLICATION_CODES} from './fee-ratio-fee-publication.mjs';
import {sessionUnion} from './fee-market-calendar.mjs';

export const RATIO_BUCKET='family-portfolio-gateway-fee-ratio-private';
export const RATIO_OWNER=283054367;
const REPO='huanwujoy-crypto/fee-console',RECIPIENT='fee-console-ratio-recipient.json';
const MAX=5*1024*1024,API_MAX=16*1024*1024;
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const fail=()=>{throw Error('RATIO_CLOUD_RUNTIME_REFUSED');};
const parse=b=>createLegacyPolicy().parseExactJson(b);
const token=s=>typeof s==='string'&&s.length>=20&&s.length<=8192&&!/[\s\x00-\x1f\x7f]/.test(s);
const hex=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const generation=s=>typeof s==='string'&&/^[1-9][0-9]{0,29}$/.test(s);

// The one thing the publication step may take from the capture step of a
// `publish-api` run: hashes and object generations, bound to this run's plan,
// main and run id. No figure, name or credential.
export const RATIO_CAPTURE_FILE='fee-ratio-capture.safe.json',RATIO_CAPTURE_SCHEMA='fee-console.ratio-api-capture-safe.v1';
export function validateRatioCapture(v,binding){
  const keys=['schema','status','stage','code','requests','planSha256','mainSha','runId','bundleId','original','input'];
  const pinnedObject=(s,name)=>s&&typeof s==='object'&&Object.keys(s).sort().join(',')==='generation,name,sha256'&&s.name===name&&generation(s.generation)&&hex(s.sha256);
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==[...keys].sort().join(',')||v.schema!==RATIO_CAPTURE_SCHEMA||!['CAPTURED','REFUSED'].includes(v.status)
    ||typeof v.stage!=='string'||!/^[A-Z_]{1,40}$/.test(v.stage)||!(v.code===null||typeof v.code==='string'&&/^[A-Z_]{1,80}$/.test(v.code))||!Number.isSafeInteger(v.requests)||v.requests<0||v.requests>1000
    ||!hex(v.planSha256)||!/^[a-f0-9]{40}$/.test(v.mainSha||'')||!/^\d{1,20}$/.test(v.runId||''))fail();
  if(v.status==='CAPTURED'?!(v.stage==='COMPLETE'&&v.code===null&&hex(v.bundleId)&&pinnedObject(v.original,'inputs/'+v.bundleId+'/original.json')&&pinnedObject(v.input,'inputs/'+v.bundleId+'/input.json'))
    :!(v.bundleId===null&&v.original===null&&v.input===null&&v.code!==null))fail();
  if(binding!==undefined&&(v.planSha256!==binding.planSha256||v.mainSha!==binding.mainSha||v.runId!==binding.runId))fail();
  return structuredClone(v);
}
export function ratioAdmission(env,event){
  if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_EVENT_NAME!=='workflow_dispatch'||env.GITHUB_RUN_ATTEMPT!=='1'||env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_REPOSITORY!==REPO||env.GITHUB_ACTOR_ID!==String(RATIO_OWNER)||!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA||'')||event?.sender?.id!==RATIO_OWNER||event?.repository?.full_name!==REPO)fail();
  const i=event.inputs;
  if(!i||i.ratio_main!==env.GITHUB_SHA||typeof i.ratio_plan!=='string'||i.ratio_plan.length>8192||env.RATIO_PLAN!==i.ratio_plan)fail();
  const defaults={ib_envelope_once:'false',ib_envelope_main:'',ib_diagnostic_once:'false',ib_diagnostic_main:'',source_plan_check_only:'false',source_acceptance_once:'false',run_reviewed_once:'false',source_from:'',source_target:'',source_main:'',manual_sync_completed_for:'',confirmed_main:'',recovery_main:'',report_kind:'',report_target:'',report_markets:'',source_probe_once:'false',source_probe_main:'',source_probe_target:''};
  if(Object.keys(i).some(k=>!Object.hasOwn(defaults,k)&&!['ratio_main','ratio_plan'].includes(k))||Object.entries(defaults).some(([k,v])=>Object.hasOwn(i,k)&&i[k]!==v))fail();
  const plan=parse(Buffer.from(i.ratio_plan));validateRatioCloudPlan(plan);return plan;
}

// Scheduled ratio (owner decision 2026-11-14): the first daily schedule slot may
// also publish the ratio, on its own, with no operator and no fee handoff. It
// is a separate repository opt-in. The target is the Hong Kong date before the
// run, and only when the reviewed calendar proves a session on that date for
// the configured venues; an unknown venue or year refuses rather than guesses.
// The plan it yields is an ordinary `publish-api` plan whose previous-body
// field is a placeholder: the publication step replaces it with the verified
// current snapshot (see `followCurrent`).
export const RATIO_SCHEDULE_CRON='0 1 * * *',RATIO_SCHEDULE_PREVIOUS='0'.repeat(64);
const hkDay=ms=>new Date(ms+8*3600000).toISOString().slice(0,10);
export function ratioScheduledAdmission(env,event,now=new Date()){
  const ms=now instanceof Date?now.getTime():NaN;
  if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_EVENT_NAME!=='schedule'||env.GITHUB_RUN_ATTEMPT!=='1'||env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_REPOSITORY!==REPO
    ||!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA||'')||env.FEE_RATIO_AUTO_ENABLED!=='true'||(env.RATIO_PLAN!==undefined&&env.RATIO_PLAN!=='')
    // The slot is the workflow's own `github.event.schedule`; an event file that names a slot must agree.
    ||env.RATIO_SCHEDULE!==RATIO_SCHEDULE_CRON||!event||typeof event!=='object'||Array.isArray(event)||event.schedule!==undefined&&event.schedule!==RATIO_SCHEDULE_CRON
    ||event.inputs!==undefined&&event.inputs!==null||!Number.isFinite(ms))fail();
  const markets=String(env.FEE_REPORT_MARKETS||'').split(',');
  if(!markets.length||markets.some(m=>!/^[A-Z_]{2,40}$/.test(m)))fail();
  const asOf=new Date(Date.parse(hkDay(ms)+'T00:00:00Z')-86400000).toISOString().slice(0,10);
  let sessions;try{sessions=sessionUnion(asOf,markets);}catch{fail();}
  if(sessions.rows.some(r=>r.state==='unknown'))fail();
  if(sessions.state!=='open')return {scheduled:true,due:false,asOf,plan:null,planText:null};
  const plan={mode:'publish-api',previousBodySha256:RATIO_SCHEDULE_PREVIOUS,asOf,fee:null};
  validateRatioCloudPlan(plan);
  return {scheduled:true,due:true,asOf,plan,planText:JSON.stringify(plan)};
}
// One admission for both steps of a run: the owner's dispatch, or the schedule.
export function ratioRunAdmission(env,event,now=new Date()){
  if(env?.GITHUB_EVENT_NAME==='schedule')return ratioScheduledAdmission(env,event,now);
  const plan=ratioAdmission(env,event);return {scheduled:false,due:true,asOf:plan.asOf??null,plan,planText:env.RATIO_PLAN};
}

export function createRatioTransport({fetchImpl=fetch,gistId,managerToken,accessToken,saveReceipt}){
  if(typeof gistId!=='string'||!/^(?:[a-f0-9]{20}|[a-f0-9]{32})$/.test(gistId)||!token(managerToken))fail();
  const github={'Authorization':'Bearer '+managerToken,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
  const storage=()=>{if(!token(accessToken))fail();return {'Authorization':'Bearer '+accessToken};};
  const held=[];let patchCalls=0;
  async function request(url,{method='GET',headers={},body,max=MAX,expectedSize,statuses=[200]}={}){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),60000);let reader;
    try{
      const r=await fetchImpl(url,{method,headers,body,signal:controller.signal,redirect:'error',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});
      if(r.redirected||r.url!==url||!statuses.includes(r.status))fail();
      if(r.status===204||r.status===412){await r.body?.cancel();return {status:r.status,bytes:Buffer.alloc(0)};}
      const declared=r.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>max))fail();
      if(!r.body?.getReader)fail();reader=r.body.getReader();const parts=[];let n=0;
      for(;;){const v=await reader.read();if(v.done)break;if(!(v.value instanceof Uint8Array)||!v.value.length)fail();n+=v.value.length;if(n>max||expectedSize!==undefined&&n>expectedSize)fail();parts.push(v.value);}
      if(expectedSize!==undefined&&n!==expectedSize)fail();
      const bytes=Buffer.concat(parts,n);held.push(bytes);return {status:r.status,bytes};
    }finally{clearTimeout(timer);try{await reader?.cancel();}catch{}reader?.releaseLock();}
  }
  async function json(url,options){return parse((await request(url,options)).bytes);}
  async function completeFile(gist,name){
    const f=gist.files?.[name];if(!f||f.filename!==name||!Number.isSafeInteger(f.size)||f.size<1||f.size>MAX)fail();
    if(f.truncated!==true){if(f.truncated!==false||typeof f.content!=='string')fail();const b=Buffer.from(f.content);if(b.length!==f.size)fail();held.push(b);return b;}
    // Never forward the manager token to the raw-file host. A file revision
    // can legitimately precede the latest multi-file Gist revision.
    if(typeof f.raw_url!=='string')fail();const u=new URL(f.raw_url),rev=u.pathname.split('/')[4];
    const exact='https://gist.githubusercontent.com/'+gist.owner.login+'/'+gistId+'/raw/'+rev+'/'+name;
    if(!/^[a-f0-9]{40,64}$/.test(rev||'')||f.raw_url!==exact||u.href!==exact||u.port||u.username||u.password||u.search||u.hash)fail();
    return (await request(exact,{expectedSize:f.size})).bytes;
  }
  function pinned(s){if(!s||!/^inputs\/[a-f0-9]{64}\/(original|input)\.json$/.test(s.name)||!generation(s.generation)||!hex(s.sha256))fail();}
  const object=s=>'https://storage.googleapis.com/storage/v1/b/'+RATIO_BUCKET+'/o/'+encodeURIComponent(s.name)+'?generation='+s.generation;
  return {
    async readDestination(file){
      if(file!==RATIO_CLOUD_FILE)fail();
      const user=await json('https://api.github.com/user',{headers:github,max:65536});
      if(user.id!==RATIO_OWNER||typeof user.login!=='string'||!/^[A-Za-z0-9-]{1,39}$/.test(user.login))fail();
      const g=await json('https://api.github.com/gists/'+gistId,{headers:github,max:API_MAX});
      if(g.id!==gistId||g.public!==false||g.owner?.id!==RATIO_OWNER||g.owner?.login!==user.login||!/^[a-f0-9]{40,64}$/.test(g.history?.[0]?.version||''))fail();
      return {id:g.id,ownerId:g.owner.id,authenticatedUserId:user.id,public:false,revision:g.history[0].version,recipientBytes:await completeFile(g,RECIPIENT),snapshotBytes:await completeFile(g,RATIO_CLOUD_FILE)};
    },
    async readInput(s){
      pinned(s);const u=object(s),m=await json(u,{headers:storage(),max:65536});
      if(m.bucket!==RATIO_BUCKET||m.name!==s.name||m.generation!==s.generation||!/^\d+$/.test(m.size)||Number(m.size)<1||Number(m.size)>MAX)fail();
      const {bytes}=await request(u+'&alt=media',{headers:storage(),expectedSize:Number(m.size)});
      if(sha(bytes)!==s.sha256)fail();return {generation:m.generation,bytes};
    },
    async claimOnce(name,body,options){
      if(!/^claims\/[a-f0-9]{64}\.json$/.test(name)||options?.ifGenerationMatch!==0||Object.keys(options).length!==1||Object.keys(body).sort().join(',')!=='bodySha256,contentSha256'||!hex(body.bodySha256)||!hex(body.contentSha256))fail();
      const u='https://storage.googleapis.com/upload/storage/v1/b/'+RATIO_BUCKET+'/o?uploadType=media&name='+encodeURIComponent(name)+'&ifGenerationMatch=0';
      const r=await request(u,{method:'POST',headers:{...storage(),'Content-Type':'application/json'},body:JSON.stringify(body),max:65536,statuses:[200,201,412]});
      if(r.status===412)return 'EXISTS';const v=parse(r.bytes);if(v.bucket!==RATIO_BUCKET||v.name!==name||!generation(v.generation))fail();return 'CREATED';
    },
    async patchSnapshot(body){
      if(patchCalls++!==0||Object.keys(body).join(',')!=='files'||Object.keys(body.files||{}).join(',')!==RATIO_CLOUD_FILE||Object.keys(body.files[RATIO_CLOUD_FILE]).join(',')!=='content'||typeof body.files[RATIO_CLOUD_FILE].content!=='string'||Buffer.byteLength(body.files[RATIO_CLOUD_FILE].content)>MAX)fail();
      // Response content is discarded; exact authenticated readback is mandatory.
      await request('https://api.github.com/gists/'+gistId,{method:'PATCH',headers:{...github,'Content-Type':'application/json'},body:JSON.stringify(body),max:API_MAX});
    },
    async deleteInputs(specs){
      if(!Array.isArray(specs)||specs.length!==2||new Set(specs.map(s=>s.name)).size!==2)fail();
      for(const s of specs){pinned(s);await request(object(s)+'&ifGenerationMatch='+s.generation,{method:'DELETE',headers:storage(),statuses:[204]});}
    },
    async cleanupLocal(){for(const b of held)b.fill(0);held.length=0;},
    saveReceipt
  };
}

const statuses=['REFUSED','VERIFIED_CURRENT_NO_WRITE','UNCHANGED_SOURCE_NO_WRITE','WAITING_FEE_READBACK_NO_WRITE','PUBLISHED_CONFIRMED','WRITE_UNCONFIRMED'];
const stages=['ADMISSION','MAIN','MAIN_TOKEN','MAIN_FETCH','MAIN_HTTP','MAIN_RESPONSE','MAIN_HEAD','CREDENTIALS','PLAN','CURRENT','INPUT','SOURCE','SOURCE_ROUND','FEE_READBACK','CLAIM','PREWRITE','FEE_RECHECK','WRITE_INTENT','READBACK','COMPLETE',
  ...['FEE_READBACK','FEE_RECHECK'].flatMap(stage=>FEE_PUBLICATION_CODES.map(code=>stage+':'+code))];
export function safeRatioReceipt(v){
  const keys=['schema','status','stage','claim','patchAttempts','bodySha256','contentSha256','cleanup'];
  if(!v||Object.keys(v).sort().join(',')!==keys.sort().join(',')||v.schema!=='fee-console.ratio-cloud-safe-result.v1'||!statuses.includes(v.status)||!stages.includes(v.stage)||!['NOT_ATTEMPTED','UNKNOWN','EXISTS','OWNED'].includes(v.claim)||![0,1].includes(v.patchAttempts)||![v.bodySha256,v.contentSha256].every(x=>x===null||hex(x))||!['NOT_RUN','LOCAL_AND_PINNED_INPUTS','LOCAL_ONLY','NO_INPUTS_READ','INCOMPLETE'].includes(v.cleanup))fail();
  return structuredClone(v);
}
export function saveRatioReceipt(file,value){
  const safe=safeRatioReceipt(value),tmp=file+'.pending';fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(safe)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);
}
export async function executeRatioCloud({env,event,fetchImpl=fetch,saveReceipt,publisher=createRatioCloudPublisher(),preflight=false,clock,readCapture}){
  let result={schema:'fee-console.ratio-cloud-safe-result.v1',status:'REFUSED',stage:'ADMISSION',claim:'NOT_ATTEMPTED',patchAttempts:0,bodySha256:null,contentSha256:null,cleanup:'NO_INPUTS_READ'},io;
  try{
    const admitted=ratioRunAdmission(env,event,clock?clock():new Date());let plan=admitted.plan;
    // A scheduled day without a session has nothing to publish and reads nothing.
    if(!admitted.due){if(preflight)return {preflight:true,mode:'not-due',due:false};fail();}
    result.stage='MAIN_TOKEN';
    // Only the existing ephemeral contents:read token may authenticate this
    // fixed repository request. Financial credentials remain untouched here.
    const repositoryToken=env.GITHUB_TOKEN;
    if(!token(repositoryToken)||/[^\x21-\x7e]/.test(repositoryToken))fail();
    const url='https://api.github.com/repos/'+REPO+'/git/ref/heads/main';
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
    try{
      // Literal stages are the complete diagnostic: never log remote bodies,
      // headers, tokens or exception text. Retain MAIN for earlier receipts.
      result.stage='MAIN_FETCH';
      const r=await fetchImpl(url,{signal:controller.signal,redirect:'error',headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',Authorization:'Bearer '+repositoryToken},credentials:'omit'});
      result.stage='MAIN_HTTP';if(r.status!==200)fail();
      result.stage='MAIN_RESPONSE';if(r.redirected||r.url!==url)fail();
      const text=await r.text();if(text.length>65536)fail();
      const liveMain=JSON.parse(text)?.object?.sha;
      result.stage='MAIN_HEAD';if(liveMain!==env.GITHUB_SHA)fail();
    }finally{clearTimeout(timer);}
    if(preflight)return {preflight:true,mode:plan.mode,due:true};
    if(plan.mode==='publish-api'){
      // Complete the plan only from this same run's capture step: same plan
      // bytes, same main, same run. Its hashes and generations are then pinned
      // exactly as a hand-prepared publish plan would pin them.
      result.stage='PLAN';
      if(typeof readCapture!=='function'||!/^\d{1,20}$/.test(env.GITHUB_RUN_ID||''))fail();
      const capture=validateRatioCapture(await readCapture(),{planSha256:sha(Buffer.from(admitted.planText)),mainSha:env.GITHUB_SHA,runId:env.GITHUB_RUN_ID});
      if(capture.status!=='CAPTURED')fail();
      plan={mode:'publish',previousBodySha256:plan.previousBodySha256,bundleId:capture.bundleId,original:capture.original,input:capture.input,library:null,fee:plan.fee};
      validateRatioCloudPlan(plan);
    }
    result.stage='CREDENTIALS';
    const ratio=createFeeRatioCore(createRankedExposureCore(),crypto.webcrypto),manager=await ratio.deriveSnapshotManager(env.FEE_ECON_GIST_ID,env.FEE_DATA_KEY,env.FEE_RATIO_MANAGER_TOKEN);
    if(plan.mode==='publish'&&!token(env.RATIO_STORAGE_ACCESS_TOKEN))fail();
    io=createRatioTransport({fetchImpl,gistId:env.FEE_ECON_GIST_ID,managerToken:env.FEE_RATIO_MANAGER_TOKEN,accessToken:env.RATIO_STORAGE_ACCESS_TOKEN,saveReceipt:async v=>{result=safeRatioReceipt(v);await saveReceipt(result);}});
    // Fee-first gate: the same existing read-only repository token as the main
    // check, sent only to fixed repository API URLs; Pages reads are anonymous.
    io.verifyFeePublication=async({handoff,previousProof})=>{
      if(previousProof!==undefined&&!isFeeFinalPublicationProof(previousProof))fail();
      const proof=await verifyFeeFinalPublication({handoff,runMain:env.GITHUB_SHA,repositoryToken,
        feeDataKey:env.FEE_DATA_KEY,ibBaselineSha256:env.IB_MANAGER_BASELINE_SHA256,
        fetchImpl,...(clock?{clock}:{}),...(previousProof!==undefined?{previousProof}:{})});
      if(!isFeeFinalPublicationProof(proof))fail();return proof;
    };
    result=await publisher.run({plan,identity:{gistId:env.FEE_ECON_GIST_ID,ownerId:RATIO_OWNER},manager,io,...(clock?{clock}:{}),...(admitted.scheduled?{followCurrent:{asOf:admitted.asOf}}:{})});
  }catch{if(io)try{await io.cleanupLocal();}catch{}/* No exception text can reach logs. */}
  // Save before the caller prints anything. Saving failure is not a publication retry.
  await saveReceipt(safeRatioReceipt(result));return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==3||!['--preflight','--run'].includes(process.argv[2]))fail();
    const eventBytes=fs.readFileSync(process.env.GITHUB_EVENT_PATH);if(eventBytes.length>1024*1024)fail();
    const event=parse(eventBytes),preflight=process.argv[2]==='--preflight';
    const captureFile=path.join(process.env.RUNNER_TEMP||'',RATIO_CAPTURE_FILE);
    if(!process.env.RUNNER_TEMP||!path.isAbsolute(process.env.RUNNER_TEMP))fail();
    const file=path.join(process.env.RUNNER_TEMP,'fee-ratio-result.safe.json');
    const result=await executeRatioCloud({env:process.env,event,preflight,saveReceipt:v=>saveRatioReceipt(file,v),readCapture:()=>{const b=fs.readFileSync(captureFile);if(b.length>65536)fail();return parse(b);}});
    console.log(JSON.stringify(result));if(preflight&&result.preflight!==true)process.exitCode=1;
    // The only value handed to the next job: whether there is anything to publish.
    if(preflight&&result.preflight===true&&process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,'ratio_due='+(result.due===true?'true':'false')+'\n');if(!preflight&&!['VERIFIED_CURRENT_NO_WRITE','UNCHANGED_SOURCE_NO_WRITE','PUBLISHED_CONFIRMED'].includes(result.status))process.exitCode=1;
  }catch{console.error('RATIO_CLOUD_ENTRY_REFUSED');process.exitCode=1;}
}
