// Protected, single-artifact Saturday acceptance preview. Importing this module
// performs no I/O, reads no environment and grants no upload or reader access.
// The normal weekday candidate verifier is deliberately not used or relaxed.
import crypto from 'node:crypto';
import {uniqueCloudJson} from './cloud_io.mjs';
import {digest} from './eod_sources.mjs';
import {OWNER_BINDING,SOURCE_IDENTITY_SHA256,prepareOwnerStaticDisplay,OWNER_DISPLAY_CSP} from './owner_latest_admission.mjs';
import {OWNER_SCOPE,LATEST_TARGET,ACCEPTED_PREVIEW_SCHEMA,
  validateAcceptedPreviewMetadata,previewMetadataSha256} from './owner_latest.mjs';
import {extractNightActionModel,renderNightActionReport,NIGHT_ACTION_MARKER} from '../../scripts/xuan-ib-night-action-view.mjs';
import {APPROVED_IB_ACCOUNT_ID} from '../../scripts/xuan-ib-run-manifest.mjs';

export {validateAcceptedPreviewMetadata,previewMetadataSha256};
export const ACCEPTED_PREVIEW_REGISTRATION_PATH='security/xuan-owner-accepted-preview.json';
export const ACCEPTED_PREVIEW_REGISTRATION_SCHEMA='xuan.owner-accepted-preview-registration.v1';
// Fixed budget for this separately admitted static preview. Daily publishing,
// live write admission and the full access preflight retain their own limits.
export const ACCEPTED_PREVIEW_DEADLINE_MS=45000;
const MAX_HTML=100000,MAX_MODEL=100000,MAX_MANIFEST=32768;
const HASH=/^[a-f0-9]{64}$/,COMMIT=/^[a-f0-9]{40}$/;
const SOURCE_KEYS=['ib.accountSummary','ib.positions','ib.orders','sharesight.ibGroupedPerformance','sharesight.noahPerformance'];
const object=o=>!!o&&Object.getPrototypeOf(o)===Object.prototype;
const exact=(o,keys)=>object(o)&&Object.keys(o).sort().join('|')===keys.split(' ').sort().join('|');
const fail=code=>{throw Object.assign(Error('OWNER_PREVIEW_'+code),{safeCode:'OWNER_PREVIEW_'+code});};
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):object(value)
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const instant=s=>typeof s==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s)
  &&Number.isFinite(Date.parse(s))&&new Date(s).toISOString()===s;
const date=s=>typeof s==='string'&&/^\d{4}-\d\d-\d\d$/.test(s)&&Number.isFinite(Date.parse(s+'T00:00:00Z'))
  &&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
const hkt=s=>new Date(Date.parse(s)+28800000).toISOString();
const hktTime=s=>hkt(s).slice(11,23);
function copyBytes(bytes,max){if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>max)fail('BYTES');return new Uint8Array(bytes);}
function decode(bytes){try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('UTF8');}}
function parsed(bytes,max){try{return uniqueCloudJson(decode(bytes),max);}catch{fail('JSON');}}

export function validateAcceptedPreviewRegistration(registration){
  const keys='schema registrationId scope ownerBinding sourceIdentitySha256 dataDate sourceDate captureStartedAt captureEndedAt completedAt ordersCaptureStartedAt ordersCaptureEndedAt sourceHead artifactSha256 modelSha256 sourceManifestSha256 sourceManifestContentSha256 displaySha256 financialStatus unknownFields';
  if(!exact(registration,keys)||registration.schema!==ACCEPTED_PREVIEW_REGISTRATION_SCHEMA
    ||!/^[a-z0-9][a-z0-9-]{7,95}$/.test(registration.registrationId)
    ||registration.scope!==OWNER_SCOPE||registration.ownerBinding!==OWNER_BINDING
    ||registration.sourceIdentitySha256!==SOURCE_IDENTITY_SHA256||!COMMIT.test(registration.sourceHead))fail('REGISTRATION_SCOPE');
  for(const key of ['artifactSha256','modelSha256','sourceManifestSha256','sourceManifestContentSha256','displaySha256'])if(!HASH.test(registration[key]))fail('REGISTRATION_HASH');
  if(!date(registration.dataDate)||!date(registration.sourceDate)||registration.sourceDate>=registration.dataDate
    ||new Date(registration.dataDate+'T00:00:00Z').getUTCDay()!==6)fail('REGISTRATION_DATE');
  for(const key of ['captureStartedAt','captureEndedAt','completedAt','ordersCaptureStartedAt','ordersCaptureEndedAt'])if(!instant(registration[key]))fail('REGISTRATION_TIME');
  const r=registration;
  if(r.captureStartedAt>r.captureEndedAt||r.captureEndedAt>r.completedAt||r.ordersCaptureStartedAt<r.captureStartedAt
    ||r.ordersCaptureStartedAt>r.ordersCaptureEndedAt||r.ordersCaptureEndedAt>r.captureEndedAt
    ||Date.parse(r.captureEndedAt)-Date.parse(r.captureStartedAt)>300000
    ||['captureStartedAt','captureEndedAt','completedAt'].some(key=>hkt(r[key]).slice(0,10)!==r.dataDate))fail('REGISTRATION_TIME');
  if(r.financialStatus!=='partial'||!Array.isArray(r.unknownFields)||!r.unknownFields.length
    ||new Set(r.unknownFields).size!==r.unknownFields.length||!r.unknownFields.includes('cash')||!r.unknownFields.includes('prices')
    ||r.unknownFields.some(x=>!['orders','holdings','cash','allocation','prices','sourceIdentity','freshness'].includes(x)))fail('REGISTRATION_FINANCIAL_STATE');
  return registration;
}
export function acceptedPreviewRegistrationText(registration){
  validateAcceptedPreviewRegistration(registration);return JSON.stringify(canonical(registration),null,2)+'\n';
}
export function buildAcceptedPreviewMetadata({registration,registrationSha256,registrationPolicyCommit}={}){
  const r=validateAcceptedPreviewRegistration(registration);
  if(registrationSha256!==sha(acceptedPreviewRegistrationText(r))||!COMMIT.test(registrationPolicyCommit||''))fail('REGISTRATION_BINDING');
  return validateAcceptedPreviewMetadata({schema:ACCEPTED_PREVIEW_SCHEMA,scope:r.scope,ownerBinding:r.ownerBinding,
    sourceIdentitySha256:r.sourceIdentitySha256,registrationId:r.registrationId,registrationSha256,registrationPolicyCommit,
    dataDate:r.dataDate,sourceDate:r.sourceDate,captureStartedAt:r.captureStartedAt,captureEndedAt:r.captureEndedAt,
    completedAt:r.completedAt,financialStatus:'partial',unknownFields:[...r.unknownFields]},{ownerBinding:OWNER_BINDING});
}
function modelBinding(model,r){
  const capture=model.provenance?.capture,orders=model.orders;
  const unknown=['cash','prices',...(orders?.status==='ready'?[]:['orders']),...(model.holdings?.status==='ready'?[]:['holdings']),...(model.allocation?.status==='ready'?[]:['allocation'])].sort();
  const header=`${r.dataDate} ${hkt(r.captureStartedAt).slice(11,16)}–${hkt(r.captureEndedAt).slice(11,16)} HKT · 数据至 ${r.sourceDate}`;
  if(model.schemaVersion!==9||model.mode!=='eod-action'||model.status!=='partial'||!model.fieldState
    ||model.dataDate!==r.dataDate||model.sourceDate!==r.sourceDate||model.asOfHkt!==header
    ||capture?.startedAt!==r.captureStartedAt||capture?.completedAt!==r.captureEndedAt
    ||orders?.capturedStartedAt!==r.ordersCaptureStartedAt||orders?.capturedCompletedAt!==r.ordersCaptureEndedAt
    ||model.cash.orderReserve!==null||model.cash.planning!==null||model.cash.executableBudget!==null
    ||model.replenishment.status!=='unavailable'||model.sourceManifestSha256!==r.sourceManifestContentSha256
    ||JSON.stringify(unknown)!==JSON.stringify([...r.unknownFields].sort()))fail('MODEL_BINDING');
}
function staticDisplayBinding(display,r){
  if(typeof display!=='string'||!display.includes(OWNER_DISPLAY_CSP)||!display.includes('name="referrer" content="no-referrer"')
    ||display.includes(NIGHT_ACTION_MARKER)||display.includes('private-local-display-only')
    ||/<script\b|<iframe\b|<form\b|<object\b|<embed\b|<img\b|<link\b|<base\b|\son[a-z]+\s*=|@import|url\s*\(|(?:href|src)\s*=|\b(?:localStorage|sessionStorage|access_token|refresh_token|account_?id|portfolio_?id|order_?id|contract_?id)\b/i.test(display)
    ||display.includes(APPROVED_IB_ACCOUNT_ID)||/\b[UF]\d{5,12}\b/.test(display)
    ||!display.includes(`<!-- owner-accepted-preview:${r.registrationId} -->`)
    ||!display.includes(`${r.dataDate} 周六验收稿`)
    ||!display.includes(`市场数据日：${r.sourceDate}`)
    ||!display.includes(`真实采集：${hktTime(r.captureStartedAt)}–${hktTime(r.captureEndedAt)} HKT`)
    ||!display.includes(`挂单读取：${hktTime(r.ordersCaptureStartedAt)}–${hktTime(r.ordersCaptureEndedAt)} HKT`)
    ||!display.includes(`原稿生成：${hktTime(r.completedAt)} HKT`))fail('STATIC_DISPLAY');
  for(const id of ['card-plan','card-orders','card-cash','card-allocation'])if(display.split(`id="${id}"`).length!==2)fail('STATIC_CARDS');
}

// Pure deterministic rendering is not admission. It enables freezing the local
// output hash for review; only the wrapper/verifier below accepts that hash.
export function renderAcceptedPreviewDisplay(originalHtmlBytes,{registration}={}){
  const r=validateAcceptedPreviewRegistration(registration),original=decode(copyBytes(originalHtmlBytes,MAX_HTML));
  let model;try{model=extractNightActionModel(original);}catch{fail('CANONICAL_HTML');}
  if(renderNightActionReport(model)!==original)fail('CANONICAL_HTML');modelBinding(model,r);
  let display=decode(prepareOwnerStaticDisplay(new TextEncoder().encode(original)));
  const marker=new RegExp(`<!-- ${NIGHT_ACTION_MARKER}:[A-Za-z0-9_-]+ -->`,'g');
  if([...display.matchAll(marker)].length!==1)fail('MODEL_MARKER');
  display=display.replace(marker,`<!-- owner-accepted-preview:${r.registrationId} -->`);
  // Observation history is retained only in the private local model, never as
  // hidden attributes in the acceptance display.
  display=display.replace(/ data-order-(?:trend-v1|key|first-date|first-price|age-days)="[^"]*"/g,'');
  // Preserve the per-order qualification already visible in the accepted local
  // reference, in addition to the common static-export disclosure.
  const orderCount=model.orders.buys.length+model.orders.sells.length;
  if((display.match(/<\/article>/g)||[]).length!==orderCount)fail('STATIC_ORDER_SHAPE');
  display=display.replaceAll('</article>','<small class="local-order-evidence">币种及价差按同名持仓推定，原生挂单未返回币种或合约标识；未验证同一合约。</small></article>');
  display=display.replace('</head>','<style>.local-order-evidence{display:block;font-size:10px;color:#6b7280;line-height:1.4;margin-top:5px}</style></head>');
  const notice=`<aside class="notes" id="accepted-preview-notice" role="note"><strong>${r.dataDate} 周六验收稿 · 保存的私有参考</strong><p>市场数据日：${r.sourceDate}。真实采集：${hktTime(r.captureStartedAt)}–${hktTime(r.captureEndedAt)} HKT；挂单读取：${hktTime(r.ordersCaptureStartedAt)}–${hktTime(r.ordersCaptureEndedAt)} HKT；原稿生成：${hktTime(r.completedAt)} HKT。</p><p>周末验收，不代表当日开市、当前实时数据、正式工作日报告或同步完成。重新打开不会更新取值；覆盖、原生币种和相关预算仍按原稿保留缺项。</p></aside>`;
  display=display.replace('</header>','</header>'+notice);
  staticDisplayBinding(display,r);return new TextEncoder().encode(display);
}
export function prepareAcceptedPreviewDisplay(originalHtmlBytes,{modelBytes,manifestBytes,registration}={}){
  const html=copyBytes(originalHtmlBytes,MAX_HTML),modelInput=copyBytes(modelBytes,MAX_MODEL),manifestInput=copyBytes(manifestBytes,MAX_MANIFEST);
  const r=JSON.parse(JSON.stringify(validateAcceptedPreviewRegistration(registration)));
  if(sha(html)!==r.artifactSha256||sha(modelInput)!==r.modelSha256||sha(manifestInput)!==r.sourceManifestSha256)fail('LOCAL_ARTIFACT_HASH');
  const model=parsed(modelInput,MAX_MODEL),manifest=parsed(manifestInput,MAX_MANIFEST);
  if(renderNightActionReport(model)!==decode(html))fail('LOCAL_MODEL_BINDING');modelBinding(model,r);
  if(!exact(manifest,'sources sourceHead associationPolicySha256 callLedgerSha256')||manifest.sourceHead!==r.sourceHead
    ||!HASH.test(manifest.associationPolicySha256)||!HASH.test(manifest.callLedgerSha256)
    ||!Array.isArray(manifest.sources)||manifest.sources.length!==SOURCE_KEYS.length
    ||new Set(manifest.sources.map(s=>s.sourceKey)).size!==SOURCE_KEYS.length
    ||digest(manifest.sources)!==r.sourceManifestContentSha256)fail('LOCAL_MANIFEST_BINDING');
  for(const s of manifest.sources){
    if(!SOURCE_KEYS.includes(s.sourceKey)||!HASH.test(s.sha256)||!instant(s.startedAt)||!instant(s.completedAt)
      ||s.startedAt>s.completedAt||s.startedAt<r.captureStartedAt||s.completedAt>r.captureEndedAt)fail('LOCAL_MANIFEST_TIME');
    if(s.sourceKey.startsWith('sharesight.')&&(s.sourceDate!==r.sourceDate||s.status!=='date-verified'||s.syncCompletion!=='not-provided'))fail('LOCAL_MANIFEST_SCOPE');
    if(s.sourceKey==='ib.orders'&&(s.startedAt!==r.ordersCaptureStartedAt||s.completedAt!==r.ordersCaptureEndedAt))fail('LOCAL_MANIFEST_TIME');
  }
  if(manifest.sources.map(s=>s.startedAt).sort()[0]!==r.captureStartedAt
    ||manifest.sources.map(s=>s.completedAt).sort().at(-1)!==r.captureEndedAt)fail('LOCAL_MANIFEST_TIME');
  const display=renderAcceptedPreviewDisplay(html,{registration:r});if(sha(display)!==r.displaySha256)fail('DISPLAY_HASH');return display;
}

function checkedContext(context,m){
  const p=context?.previewRegistration;
  if(!exact(p,'registration sha256 policyCommit')||p.sha256!==m.registrationSha256||p.policyCommit!==m.registrationPolicyCommit)fail('TRUSTED_REGISTRATION_REQUIRED');
  const r=validateAcceptedPreviewRegistration(p.registration);
  if(sha(acceptedPreviewRegistrationText(r))!==p.sha256)fail('TRUSTED_REGISTRATION_BYTES');
  const expected=buildAcceptedPreviewMetadata({registration:r,registrationSha256:p.sha256,registrationPolicyCommit:p.policyCommit});
  if(JSON.stringify(canonical(expected))!==JSON.stringify(canonical(m)))fail('METADATA_BINDING');
  return {registration:JSON.parse(JSON.stringify(r)),sha256:p.sha256,policyCommit:p.policyCommit};
}
export function createProtectedOwnerPreviewVerifier({loadContext,now:clock=Date.now}={}){
  if(typeof loadContext!=='function'||typeof clock!=='function')fail('CAPABILITIES_REQUIRED');
  return async({metadata,displayBytes,now:suppliedNow,phase}={})=>{
    try{
      const time=clock();
      if(!Number.isFinite(time)||suppliedNow!==undefined&&!Number.isFinite(suppliedNow)
        ||!['candidate-admission','historical-authenticity'].includes(phase))fail('PHASE_OR_CLOCK');
      const m=JSON.parse(JSON.stringify(metadata)),bytes=copyBytes(displayBytes,MAX_HTML);
      validateAcceptedPreviewMetadata(m,{now:time,ownerBinding:OWNER_BINDING});
      const options={phase:phase==='candidate-admission'?'accepted-preview-admission':'accepted-preview-historical',policyCommit:m.registrationPolicyCommit,now:()=>clock()};
      const original=checkedContext(await loadContext(options),m),r=original.registration;
      if(sha(bytes)!==r.displaySha256)fail('DISPLAY_HASH');staticDisplayBinding(decode(bytes),r);
      // No live-freshness assertion is made for this fixed saved reference.
      // Both phases still require its original real instants, exact scope and
      // current/original protected registration, freshly re-read by the loader.
      const current=checkedContext(await loadContext(options),m),endTime=clock();
      if(!Number.isFinite(endTime)||endTime<time||r.completedAt>new Date(endTime).toISOString())fail('CLOCK_CHANGED');
      if(JSON.stringify(canonical(current))!==JSON.stringify(canonical(original)))fail('REGISTRATION_CHANGED');
      return {schema:'xuan.owner-accepted-preview-proof.v1',scope:m.scope,ownerBinding:m.ownerBinding,
        sourceIdentitySha256:m.sourceIdentitySha256,registrationId:m.registrationId,registrationSha256:m.registrationSha256,
        registrationPolicyCommit:m.registrationPolicyCommit,displaySha256:r.displaySha256,metadataSha256:await previewMetadataSha256(m)};
    }catch(error){if(error?.safeCode?.startsWith('OWNER_PREVIEW_'))throw error;fail('REJECTED');}
  };
}
async function verifiedCandidate(candidate,verify,now){
  const m=candidate.metadata,proof=await verify({metadata:structuredClone(m),displayBytes:new Uint8Array(candidate.displayBytes),now,phase:'candidate-admission'});
  if(!exact(proof,'schema scope ownerBinding sourceIdentitySha256 registrationId registrationSha256 registrationPolicyCommit displaySha256 metadataSha256')
    ||proof.schema!=='xuan.owner-accepted-preview-proof.v1'||proof.scope!==m.scope||proof.ownerBinding!==m.ownerBinding
    ||proof.sourceIdentitySha256!==m.sourceIdentitySha256||proof.registrationId!==m.registrationId
    ||proof.registrationSha256!==m.registrationSha256||proof.registrationPolicyCommit!==m.registrationPolicyCommit
    ||proof.displaySha256!==sha(candidate.displayBytes)||proof.metadataSha256!==await previewMetadataSha256(m))fail('PROTECTED_VERIFIER_REJECTED');
}

export function createAcceptedPreviewPublisher({io,verifyProtectedPreview,verifyDestinationAccess,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}={}){
  let closed=false;
  return Object.freeze({async publish(candidate){
    if(closed)return {status:'blocked',code:'PREVIEW_ONE_SHOT_CLOSED'};
    if(!io||typeof io.probeLatestExists!=='function'||typeof io.createAcceptedPreview!=='function'||typeof io.readLatestGeneration!=='function'
      ||typeof verifyProtectedPreview!=='function'||typeof verifyDestinationAccess!=='function'||typeof now!=='function'
      ||typeof setTimer!=='function'||typeof clearTimer!=='function')return {status:'blocked',code:'PREVIEW_CAPABILITIES_REQUIRED'};
    let frozen;
    try{if(!exact(candidate,'metadata displayBytes'))fail('CANDIDATE');frozen={metadata:JSON.parse(JSON.stringify(candidate.metadata)),displayBytes:copyBytes(candidate.displayBytes,MAX_HTML)};
      validateAcceptedPreviewMetadata(frozen.metadata,{now:now(),ownerBinding:OWNER_BINDING});}catch{return {status:'blocked',code:'PREVIEW_CANDIDATE_INVALID'};}
    closed=true;const controller=new AbortController();let timer,writing=false;
    const deadline=new Promise((_,reject)=>{timer=setTimer(()=>{controller.abort();reject(Error('deadline'));},ACCEPTED_PREVIEW_DEADLINE_MS);});
    const work=async()=>{
      const started=now();if(!Number.isFinite(started))fail('CLOCK');
      const guard=()=>{if(controller.signal.aborted||!Number.isFinite(now())||now()-started>=ACCEPTED_PREVIEW_DEADLINE_MS)fail('DEADLINE');};
      const access=async()=>{if(await verifyDestinationAccess({target:LATEST_TARGET,operation:'create-accepted-preview',signal:controller.signal})!==undefined)fail('ACCESS_CAPABILITY_RESULT');guard();};
      await access();
      const exists=await io.probeLatestExists({target:LATEST_TARGET,signal:controller.signal});guard();
      if(!exact(exists,'state')||!['absent','present'].includes(exists.state))fail('TARGET_UNKNOWN');
      if(exists.state==='present')return {status:'blocked',code:'PREVIEW_TARGET_EXISTS'};
      await verifiedCandidate(frozen,verifyProtectedPreview,now());guard();await access();
      writing=true;
      const ack=await io.createAcceptedPreview({target:LATEST_TARGET,bytes:new Uint8Array(frozen.displayBytes),metadata:structuredClone(frozen.metadata),signal:controller.signal});
      if(!object(ack)||ack.bucket!==LATEST_TARGET.bucket||ack.object!==LATEST_TARGET.object||!/^([1-9][0-9]{0,29})$/.test(ack.generation||'')||ack.size!==frozen.displayBytes.length)return {status:'unknown',code:'PREVIEW_WRITE_ACK_UNVERIFIED'};
      guard();const displaySha256=sha(frozen.displayBytes);
      const readback=await io.readLatestGeneration({target:LATEST_TARGET,generation:ack.generation,sha256:displaySha256,
        metadata:{...structuredClone(frozen.metadata),displaySha256},signal:controller.signal});
      if(!(readback instanceof Uint8Array)||readback.length!==frozen.displayBytes.length||sha(new Uint8Array(readback))!==displaySha256)return {status:'unknown',code:'PREVIEW_READBACK_UNVERIFIED'};
      guard();return {status:'published-verified',code:'PREVIEW_PINNED_READBACK_VERIFIED',generation:ack.generation,sha256:displaySha256,registrationId:frozen.metadata.registrationId};
    };
    try{return await Promise.race([work(),deadline]);}
    catch(error){if(error?.safeCode==='LATEST_ALREADY_EXISTS')return {status:'blocked',code:'PREVIEW_TARGET_EXISTS'};
      if(writing&&error?.status===412)return {status:'conflict',code:'PREVIEW_CAS_CONFLICT_NO_RETRY'};
      return {status:writing?'unknown':'blocked',code:writing?'PREVIEW_WRITE_OUTCOME_UNKNOWN':'PREVIEW_ACCESS_OR_VALIDATION_FAILED'};}
    finally{clearTimer(timer);controller.abort();}
  }});
}
