// One dated, read-only diagnosis of an IB past-point refusal. It repeats the
// ordinary IB manager read for one target day against the exact published
// baseline bytes and reports only where the reader refused and which field
// categories of the anchor day differ. No writer, candidate, receipt, economic
// source, benchmark, issue, artifact or publication; nothing is retried.
//
// Output is one line of fixed-vocabulary JSON: two plan dates, closed enums and
// request counts. Never an amount, quantity, price, identifier, name or hash.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {decryptCandidate} from './fee-cloud-producer.mjs';
import {SharesightIbManagerReader,ibSourcePastPoint,IB_PAST_POINT_SITES,IB_PAST_POINT_FIELDS} from './ib-manager-source.mjs';
import {ibDiagnosticTransport,inspectIbDiagnostic} from './ib-manager-diagnostic.mjs';

// The exact published baseline (daily 2026-11-12) that the refused 2026-11-13
// production read was compared with. Any other data.json refuses BASE_BYTES.
export const IB_PAST_POINT_PLAN=Object.freeze({
  target:'2026-11-13',anchor:'2026-11-12',
  dataSha256:'27676b5ff7d1443eac82eff5f408c9af79831be11c84f77a878c4bc6dbac8875',
  dataBlob:'5507e402b62c927ea3f5e3a56d85a4fdfd2bc15c',healthBlob:'2d8736ae43e5acaad066467cff85ae70643d7456',
  from:'2026-11-14T00:00:00Z',expires:'2026-11-17T15:59:59Z',
});
export const IB_PAST_POINT_SCHEMA='fee-console.ib-past-point-diagnostic.v1';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const CODES=new Set(['ENVIRONMENT','EXPIRED','BASE_BYTES','BASE_HEALTH','CLEANUP','FAILED']);
const ERRORS=new WeakMap();
const fail=code=>{const e=new Error('IB_PAST_POINT_DIAGNOSTIC_'+code);ERRORS.set(e,code);throw e;};
const failureCode=error=>'IB_PAST_POINT_DIAGNOSTIC_'+(CODES.has(ERRORS.get(error))?ERRORS.get(error):'FAILED');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const gitBlob=b=>crypto.createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
const REASON=/^(?:NONE|UNKNOWN|IB_SOURCE_[A-Z_]{1,40}|IB_DIAGNOSTIC_[A-Z_]{1,40}|IB_PAST_POINT_DIAGNOSTIC_[A-Z_]{1,40})$/;
const PHASES=new Set(['PREFLIGHT','BASE_STATE','BASE_PUBLICATION','SOURCE_PREPARE','RECEIPTS','CLEANUP']);
const STATUSES=new Set(['incomplete','source-and-receipts-verified','plan-verified']);
const TRANSPORT=new Set(['NONE','ROUTE','BUDGET','EXPIRED']);

export function ibPastPointDiagnosticActive(nowMs){
  return Number.isSafeInteger(nowMs)&&nowMs>=Date.parse(IB_PAST_POINT_PLAN.from)&&nowMs<=Date.parse(IB_PAST_POINT_PLAN.expires);
}
export function validateIbPastPointBase({data,health}={}){
  if(!Buffer.isBuffer(data)||data.length<1||data.length>=2*1024*1024||gitBlob(data)!==IB_PAST_POINT_PLAN.dataBlob||hash(data)!==IB_PAST_POINT_PLAN.dataSha256
    ||!Buffer.isBuffer(health)||health.length<1||health.length>65536||gitBlob(health)!==IB_PAST_POINT_PLAN.healthBlob)fail('BASE_BYTES');
  let h;try{h=JSON.parse(health.toString('utf8'));}catch{fail('BASE_HEALTH');}
  if(!h||typeof h!=='object'||h.targetDate!==IB_PAST_POINT_PLAN.anchor||h.dataSha256!==hash(data)||!['updated','no-op'].includes(h.outcome))fail('BASE_HEALTH');
  return true;
}
// Rebuilt literal by literal from closed vocabularies; anything else becomes a
// fixed placeholder, so a forged or unexpected value cannot reach the log.
export function ibPastPointSummary(value={}){
  const count=v=>Number.isSafeInteger(v)&&v>=0&&v<=64?v:0;
  const site=IB_PAST_POINT_SITES.includes(value.pastPointSite)?value.pastPointSite:'NONE';
  const fields=Array.isArray(value.pastPointFields)?IB_PAST_POINT_FIELDS.filter(k=>value.pastPointFields.includes(k)):[];
  return {schema:IB_PAST_POINT_SCHEMA,
    status:STATUSES.has(value.status)?value.status:'incomplete',phase:PHASES.has(value.phase)?value.phase:'PREFLIGHT',
    reasonCode:typeof value.reasonCode==='string'&&REASON.test(value.reasonCode)?value.reasonCode:'UNKNOWN',
    anchorDate:IB_PAST_POINT_PLAN.anchor,targetDate:IB_PAST_POINT_PLAN.target,
    pastPointSite:site,pastPointFields:site==='NONE'?[]:fields,
    transportReason:TRANSPORT.has(value.transportReason)?value.transportReason:'NONE',
    sourceGets:count(value.sourceGets),oauthGrants:count(value.oauthGrants),
    reportGenerated:false,publicationReady:false};
}
// Dependency-injected for synthetic tests. The reader's own refusal is read by
// error identity; the ordinary preparation and receipt checks are unchanged.
export async function inspectIbPastPoint({payload,outputDir,environ,reader,anchorDate=IB_PAST_POINT_PLAN.anchor,targetDate=IB_PAST_POINT_PLAN.target}={}){
  let detail=null;
  const observed={async readStable(options){
    try{return await reader.readStable(options);}catch(error){detail=ibSourcePastPoint(error);throw error;}
  }};
  const result=await inspectIbDiagnostic({payload,anchorDate,targetDate,outputDir,environ,reader:observed});
  const refused=result.reasonCode==='IB_SOURCE_PAST_POINT_CHANGED'&&detail;
  return {status:result.status,phase:result.phase,reasonCode:result.reasonCode,
    pastPointSite:refused?detail.site:'NONE',pastPointFields:refused?[...detail.fields]:[]};
}

// Called only by the existing exact-main, owner-dispatched diagnostic entry,
// after that entry has validated the event, the actor and the environment.
export async function runIbPastPointDiagnostic({checkOnly=false,env,checkCheckout,readRegular,now=Date.now,fetchImpl=globalThis.fetch,log=console.log}={}){
  let transport,output,answer;
  try{
    if(!env||typeof env!=='object'||typeof checkCheckout!=='function'||typeof readRegular!=='function')fail('ENVIRONMENT');
    if(!ibPastPointDiagnosticActive(now()))fail('EXPIRED');
    checkCheckout();
    validateIbPastPointBase({data:readRegular(path.join(ROOT,'data.json'),2*1024*1024-1),health:readRegular(path.join(ROOT,'fee-data-health.json'),65536)});
    if(checkOnly)answer={status:'plan-verified',phase:'PREFLIGHT',reasonCode:'NONE'};
    else{
      if(typeof env.RUNNER_TEMP!=='string'||!path.isAbsolute(env.RUNNER_TEMP))fail('ENVIRONMENT');
      output=path.join(fs.realpathSync(env.RUNNER_TEMP),'fee-ib-diagnostic');
      if(fs.existsSync(output))fail('ENVIRONMENT');fs.mkdirSync(output,{mode:0o700});
      transport=ibDiagnosticTransport({fetchImpl,anchor:IB_PAST_POINT_PLAN.anchor,target:IB_PAST_POINT_PLAN.target,now,expires:Date.parse(IB_PAST_POINT_PLAN.expires)});
      const payload=decryptCandidate(path.join(ROOT,'data.json'),env.FEE_DATA_KEY);
      const reader=new SharesightIbManagerReader({clientId:env.FEE_CLOUD_SHARESIGHT_CLIENT_ID,clientSecret:env.FEE_CLOUD_SHARESIGHT_CLIENT_SECRET,fetchImpl:transport.fetch});
      answer=await inspectIbPastPoint({payload,outputDir:output,reader,
        environ:{IB_MANAGER_READ_ENABLED:env.IB_MANAGER_READ_ENABLED,IB_MANAGER_BASELINE_SHA256:env.IB_MANAGER_BASELINE_SHA256}});
      checkCheckout();
    }
  }catch(error){answer={status:'incomplete',phase:'PREFLIGHT',reasonCode:failureCode(error)};}
  finally{
    transport?.stop();
    try{if(output&&fs.existsSync(output)){if(fs.readdirSync(output).length)fail('CLEANUP');fs.rmdirSync(output);}}
    catch{answer={status:'incomplete',phase:'CLEANUP',reasonCode:'IB_PAST_POINT_DIAGNOSTIC_CLEANUP'};}
  }
  const summary=ibPastPointSummary({...answer,transportReason:transport?.refusal(),...(transport?.counts()||{})});
  log(JSON.stringify(summary));
  // A classified answer is the diagnostic's result, including a confirmed
  // refusal; only a diagnostic that could not answer is a failed run.
  return {summary,exitCode:summary.status==='plan-verified'||summary.status==='source-and-receipts-verified'
    ||summary.phase==='SOURCE_PREPARE'&&/^IB_SOURCE_/.test(summary.reasonCode)?0:1};
}
